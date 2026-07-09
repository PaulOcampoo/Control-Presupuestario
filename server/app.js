'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const express = require('express');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const { del, get, put } = require('@vercel/blob');
const { handleUpload } = require('@vercel/blob/client');

const db = require('./db');
const { parseWorkbook } = require('./parser');
const { ingest } = require('./ingest');
const { generatePlanning } = require('./planning');
const auth = require('./auth');
const { sendXlsxExport, buildExportFilename } = require('./exportHelper');
const { extraerDatosContrato, CAMPOS_CONTRATO } = require('./extraccionContrato');
const { crearNotificacion, notificarAdmins } = require('./notificaciones');
const { calcularDiasRestantes, determinarUmbral, construirMensaje } = require('./alertasContrato');

const app = express();

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Cabeceras de seguridad básicas (sin dependencia nueva)
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Multer para imágenes adjuntas a sugerencias (capturas de pantalla)
const uploadImg = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(jpe?g|png|gif|webp)$/i.test(file.originalname);
    cb(ok ? null : new Error('Solo se admiten imágenes (jpg, png, gif, webp)'), ok);
  },
});

// Multer aparte para PDFs de contrato (fase de extracción vía Claude API) —
// mismo patrón que `upload`, pero con su propio fileFilter.
const uploadPdf = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.pdf$/i.test(file.originalname);
    cb(ok ? null : new Error('Solo se admiten archivos .pdf'), ok);
  },
});

// Wraps async route handlers so Express catches rejected promises
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function requireProject(req, res, next) {
  const id = Number(req.params.id);
  const proj = await db.getProject(id);
  if (!proj) return res.status(404).json({ error: 'Proyecto no encontrado' });
  req.project = proj;
  next();
}

function metaToObject(rows) {
  const o = {};
  for (const r of rows) o[r.clave] = r.valor;
  return o;
}

// ---------------------------------------------------------------------------
// Autenticación (pública) — a partir de aquí, todo /api/* exige sesión
// ---------------------------------------------------------------------------
app.post('/api/auth/login', h(async (req, res) => {
  const { usuario, password } = req.body || {};
  if (!usuario?.trim() || !password) {
    return res.status(400).json({ error: 'Indica usuario y contraseña' });
  }

  const ip = ((req.headers['x-forwarded-for'] || '') + '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  const ident = usuario.trim().toLowerCase();

  // Rate limiting por usuario: 5 fallos en 10 minutos (serverless-safe, cuenta en Postgres)
  const { rows: failRows } = await db.pool.query(
    `SELECT COUNT(*)::int AS n FROM login_attempts
     WHERE identificador = $1 AND exitoso = false
       AND creado_en > NOW() - INTERVAL '10 minutes'`,
    [ident]
  );
  if (failRows[0].n >= 5) {
    return res.status(429).json({ error: 'Demasiados intentos fallidos. Espera 10 minutos e intenta de nuevo.' });
  }
  // Rate limiting por IP: 20 fallos en 10 minutos — umbral más alto para
  // no bloquear a toda una oficina con IP compartida, pero detiene enumerar
  // varios usuarios distintos desde la misma IP.
  const { rows: ipRows } = await db.pool.query(
    `SELECT COUNT(*)::int AS n FROM login_attempts
     WHERE ip = $1 AND exitoso = false
       AND creado_en > NOW() - INTERVAL '10 minutes'`,
    [ip]
  );
  if (ipRows[0].n >= 20) {
    return res.status(429).json({ error: 'Demasiados intentos desde esta red. Espera 10 minutos e intenta de nuevo.' });
  }

  const { rows } = await db.pool.query(
    'SELECT * FROM usuarios WHERE usuario = $1 AND activo = true',
    [usuario.trim()]
  );
  const user = rows[0];
  const ok = !!(user && await auth.verifyPassword(password, user.password_hash));

  await db.pool.query(
    'INSERT INTO login_attempts (identificador, ip, exitoso) VALUES ($1, $2, $3)',
    [ident, ip, ok]
  );

  if (!ok) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }

  const token = auth.signToken(user);
  res.json({
    token,
    user: { id: user.id, nombre: user.nombre, usuario: user.usuario, puesto: user.puesto },
    tabs: auth.PERMISSIONS[user.puesto] ? auth.PERMISSIONS[user.puesto].tabs : [],
    must_change_password: user.must_change_password || false,
  });
}));

// Vercel Cron (ver vercel.json → "crons") — se autentican con CRON_SECRET en
// vez de un JWT de usuario, así que se registran antes del middleware global
// de sesión para que no les exija Authorization: Bearer <token de usuario>.
// Un solo CRON_SECRET compartido para todos los endpoints de cron.
function requireCronSecret(req, res, next) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return res.status(500).json({ error: 'CRON_SECRET no está configurada en el entorno' });
  }
  if (req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

app.get('/api/cron/recordatorio-impuestos', requireCronSecret, h(async (req, res) => {
  const ahora = new Date();
  const anio = ahora.getUTCFullYear();
  const mes = ahora.getUTCMonth() + 1;

  const { rows: proyectos } = await db.pool.query('SELECT id, nombre FROM proyectos');
  let periodosCreados = 0;
  let notificacionesEnviadas = 0;

  for (const p of proyectos) {
    const { rows: insertados } = await db.pool.query(
      `INSERT INTO pagos_impuestos_obra (project_id, periodo_anio, periodo_mes, estado)
       VALUES ($1, $2, $3, 'pendiente')
       ON CONFLICT (project_id, periodo_anio, periodo_mes) DO NOTHING
       RETURNING id`,
      [p.id, anio, mes]
    );
    if (!insertados.length) continue; // ya existía este periodo para esta obra
    periodosCreados++;

    const mensaje = `Pendiente cargar pagos de IMSS/SAT/INFONAVIT de ${mes}/${anio} para ${p.nombre}`;
    const admins = await notificarAdmins(p.id, 'recordatorio_impuestos', insertados[0].id, mensaje);
    notificacionesEnviadas += admins.length;

    // Obra huérfana (sin residentes en usuario_proyectos): se queda solo con
    // la notificación a admins de arriba, no es un error.
    const { rows: residentes } = await db.pool.query(`
      SELECT u.id FROM usuarios u
      JOIN usuario_proyectos up ON up.usuario_id = u.id
      WHERE up.project_id = $1 AND u.puesto = 'residente' AND u.activo = true
    `, [p.id]);
    for (const r of residentes) {
      await crearNotificacion(r.id, p.id, 'recordatorio_impuestos', insertados[0].id, mensaje);
      notificacionesEnviadas++;
    }
  }

  res.json({
    ok: true,
    periodo: `${anio}-${String(mes).padStart(2, '0')}`,
    periodos_creados: periodosCreados,
    notificaciones_enviadas: notificacionesEnviadas,
  });
}));

// Alertas de vencimiento de contrato — lee meta.fin_obra de cada proyecto
// (sin modificarla) y notifica a los 30/15/7 días de vencer o al vencer,
// sin repetir la misma alerta (alertas_contrato_enviadas, UNIQUE por
// project_id+umbral). Ver server/alertasContrato.js para el cálculo.
app.post('/api/cron/alertas-vencimiento', requireCronSecret, h(async (req, res) => {
  const { rows: proyectos } = await db.pool.query('SELECT id, nombre FROM proyectos');
  const alertasEnviadas = [];
  const omitidas = [];

  for (const p of proyectos) {
    const { rows: metaRows } = await db.pool.query(
      "SELECT valor FROM meta WHERE project_id = $1 AND clave = 'fin_obra'", [p.id]
    );
    const finObra = metaRows[0] ? metaRows[0].valor : null;
    if (!finObra) {
      omitidas.push({ project_id: p.id, razon: 'sin fin_obra en meta' });
      continue;
    }

    const diasRestantes = calcularDiasRestantes(finObra);
    if (diasRestantes === null) {
      omitidas.push({ project_id: p.id, razon: `fin_obra con formato inválido: "${finObra}"` });
      continue;
    }

    const { rows: vencidoRows } = await db.pool.query(
      "SELECT 1 FROM alertas_contrato_enviadas WHERE project_id = $1 AND umbral = 'vencido'", [p.id]
    );
    const umbral = determinarUmbral(diasRestantes, vencidoRows.length > 0);
    if (!umbral) continue;

    const { rows: insertados } = await db.pool.query(
      `INSERT INTO alertas_contrato_enviadas (project_id, umbral) VALUES ($1, $2)
       ON CONFLICT (project_id, umbral) DO NOTHING RETURNING id`,
      [p.id, umbral]
    );
    if (!insertados.length) continue;

    const mensaje = construirMensaje(umbral, p.nombre, finObra);
    await notificarAdmins(p.id, 'contrato_por_vencer', insertados[0].id, mensaje);

    const { rows: residentes } = await db.pool.query(`
      SELECT u.id FROM usuarios u
      JOIN usuario_proyectos up ON up.usuario_id = u.id
      WHERE up.project_id = $1 AND u.puesto = 'residente' AND u.activo = true
    `, [p.id]);
    for (const r of residentes) {
      await crearNotificacion(r.id, p.id, 'contrato_por_vencer', insertados[0].id, mensaje);
    }

    alertasEnviadas.push({ project_id: p.id, umbral });
  }

  res.json({ revisadas: proyectos.length, alertas_enviadas: alertasEnviadas, omitidas });
}));

app.use('/api', auth.requireAuth);

app.get('/api/auth/me', h(async (req, res) => {
  const { rows } = await db.pool.query(
    'SELECT id, nombre, usuario, puesto, must_change_password FROM usuarios WHERE id = $1 AND activo = true',
    [req.user.id]
  );
  if (!rows[0]) return res.status(401).json({ error: 'Sesión inválida' });
  res.json({
    user: { id: rows[0].id, nombre: rows[0].nombre, usuario: rows[0].usuario, puesto: rows[0].puesto },
    tabs: auth.PERMISSIONS[rows[0].puesto] ? auth.PERMISSIONS[rows[0].puesto].tabs : [],
    must_change_password: rows[0].must_change_password || false,
  });
}));

// Autogestión: el usuario puede cambiar su nombre, usuario y contraseña.
// Si cambia la contraseña, se invalidan todas las sesiones anteriores y se
// emite un token nuevo para la sesión actual.
app.put('/api/auth/mi-cuenta', h(async (req, res) => {
  const { nombre, usuario, passwordActual, passwordNueva } = req.body || {};

  if (nombre !== undefined && !String(nombre || '').trim()) {
    return res.status(400).json({ error: 'El nombre no puede estar vacío' });
  }
  if (usuario !== undefined && !String(usuario || '').trim()) {
    return res.status(400).json({ error: 'El usuario no puede estar vacío' });
  }
  if (passwordNueva) {
    if (!passwordActual) {
      return res.status(400).json({ error: 'Indica tu contraseña actual para poder cambiarla' });
    }
    if (passwordNueva.length < 6) {
      return res.status(400).json({ error: 'La contraseña nueva debe tener al menos 6 caracteres' });
    }
    if (passwordNueva.length > 72) {
      return res.status(400).json({ error: 'La contraseña no puede superar 72 caracteres' });
    }
  }

  const { rows: userRows } = await db.pool.query(
    'SELECT * FROM usuarios WHERE id = $1 AND activo = true', [req.user.id]
  );
  if (!userRows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
  const userDb = userRows[0];

  if (passwordActual && !(await auth.verifyPassword(passwordActual, userDb.password_hash))) {
    return res.status(400).json({ error: 'La contraseña actual es incorrecta' });
  }
  if (passwordNueva && passwordNueva === passwordActual) {
    return res.status(400).json({ error: 'La contraseña nueva debe ser diferente a la actual' });
  }

  const nuevoUsuario = usuario?.trim() || null;
  if (nuevoUsuario && nuevoUsuario !== userDb.usuario) {
    const { rows: dup } = await db.pool.query(
      'SELECT id FROM usuarios WHERE usuario = $1 AND id != $2', [nuevoUsuario, req.user.id]
    );
    if (dup.length) return res.status(409).json({ error: 'Ese nombre de usuario ya está en uso' });
  }

  const passwordHash = passwordNueva ? await auth.hashPassword(passwordNueva) : null;
  const { rows } = await db.pool.query(
    `UPDATE usuarios SET
       nombre = COALESCE($1, nombre),
       usuario = COALESCE($2, usuario),
       password_hash = COALESCE($3, password_hash),
       must_change_password = CASE WHEN $3 IS NOT NULL THEN false ELSE must_change_password END,
       token_valid_since = CASE WHEN $3 IS NOT NULL THEN NOW() - INTERVAL '1 second' ELSE token_valid_since END
     WHERE id = $4
     RETURNING id, nombre, usuario, puesto`,
    [nombre?.trim() || null, nuevoUsuario, passwordHash, req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });

  // Emitir token nuevo si cambió contraseña o nombre de usuario (su iat > token_valid_since)
  const newToken = passwordNueva ? auth.signToken(rows[0]) : null;
  res.json({ ok: true, user: rows[0], token: newToken });
}));

// Cierra sesión en todos los dispositivos invalidando tokens anteriores.
app.post('/api/auth/cerrar-todas-sesiones', h(async (req, res) => {
  await db.pool.query(
    'UPDATE usuarios SET token_valid_since = NOW() WHERE id = $1',
    [req.user.id]
  );
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Notificaciones in-app — disponibles para cualquier puesto (son personales,
// ancladas a usuario_id). Esta fase solo expone lectura/marcado; los
// disparadores concretos (impuestos, vencimiento de contrato, requisición/OC
// publicada) los agregan fases futuras vía notificaciones.crearNotificacion()
// / notificarAdmins() — ver server/notificaciones.js.
// ---------------------------------------------------------------------------
app.get('/api/notificaciones', h(async (req, res) => {
  const { rows } = await db.pool.query(
    'SELECT * FROM notificaciones WHERE usuario_id = $1 ORDER BY creado_en DESC LIMIT 50',
    [req.user.id]
  );
  const { rows: countRows } = await db.pool.query(
    'SELECT COUNT(*)::int AS n FROM notificaciones WHERE usuario_id = $1 AND leida = false',
    [req.user.id]
  );
  res.json({ notificaciones: rows, no_leidas: countRows[0].n });
}));

app.put('/api/notificaciones/:id/leida', h(async (req, res) => {
  const id = Number(req.params.id);
  const { rows: existRows } = await db.pool.query('SELECT usuario_id FROM notificaciones WHERE id = $1', [id]);
  if (!existRows[0]) return res.status(404).json({ error: 'Notificación no encontrada' });
  if (existRows[0].usuario_id !== req.user.id) {
    return res.status(403).json({ error: 'No tienes permiso sobre esta notificación' });
  }
  const { rows } = await db.pool.query(
    'UPDATE notificaciones SET leida = true WHERE id = $1 RETURNING *', [id]
  );
  res.json(rows[0]);
}));

app.put('/api/notificaciones/leer-todas', h(async (req, res) => {
  await db.pool.query(
    'UPDATE notificaciones SET leida = true WHERE usuario_id = $1 AND leida = false', [req.user.id]
  );
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Usuarios (solo admin)
// ---------------------------------------------------------------------------
app.get('/api/usuarios', h(auth.allow('administracion')), h(async (_req, res) => {
  const { rows } = await db.pool.query(
    'SELECT id, nombre, usuario, puesto, activo, creado_en FROM usuarios ORDER BY id'
  );
  res.json(rows);
}));

app.post('/api/usuarios', h(auth.allow('administracion')), h(async (req, res) => {
  const { nombre, usuario, password, puesto } = req.body || {};
  if (!nombre?.trim() || !usuario?.trim() || !password || !auth.isValidPuesto(puesto)) {
    return res.status(400).json({ error: 'Indica nombre, usuario, contraseña y un puesto válido' });
  }
  if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  try {
    const hash = await auth.hashPassword(password);
    const { rows } = await db.pool.query(
      'INSERT INTO usuarios (nombre, usuario, password_hash, puesto) VALUES ($1,$2,$3,$4) RETURNING id, nombre, usuario, puesto, activo, creado_en',
      [nombre.trim(), usuario.trim(), hash, puesto]
    );
    const ip = ((req.headers['x-forwarded-for'] || '') + '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
    await db.pool.query(
      'INSERT INTO audit_log (actor_id, actor_usuario, accion, target_id, target_usuario, ip) VALUES ($1,$2,$3,$4,$5,$6)',
      [req.user.id, req.user.usuario, 'crear_usuario', rows[0].id, rows[0].usuario, ip]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ese nombre de usuario ya existe' });
    throw err;
  }
}));

app.put('/api/usuarios/:id', h(auth.allow('administracion')), h(async (req, res) => {
  const id = Number(req.params.id);
  const { nombre, puesto, activo, password } = req.body || {};
  if (puesto != null && !auth.isValidPuesto(puesto)) {
    return res.status(400).json({ error: 'Puesto inválido' });
  }
  if (password != null && password.length < 6) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  }
  if (password != null && password.length > 72) {
    return res.status(400).json({ error: 'La contraseña no puede superar 72 caracteres' });
  }
  const passwordHash = password ? await auth.hashPassword(password) : null;
  const { rows } = await db.pool.query(
    `UPDATE usuarios SET
       nombre = COALESCE($1, nombre),
       puesto = COALESCE($2, puesto),
       activo = COALESCE($3, activo),
       password_hash = COALESCE($4, password_hash),
       must_change_password = CASE WHEN $4 IS NOT NULL THEN true ELSE must_change_password END,
       token_valid_since = CASE WHEN $4 IS NOT NULL THEN NOW() ELSE token_valid_since END
     WHERE id = $5
     RETURNING id, nombre, usuario, puesto, activo, creado_en, must_change_password`,
    [nombre?.trim() || null, puesto || null, activo != null ? Boolean(activo) : null, passwordHash, id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (password) {
    const ip = ((req.headers['x-forwarded-for'] || '') + '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
    await db.pool.query(
      'INSERT INTO audit_log (actor_id, actor_usuario, accion, target_id, target_usuario, ip) VALUES ($1,$2,$3,$4,$5,$6)',
      [req.user.id, req.user.usuario, 'reset_password', rows[0].id, rows[0].usuario, ip]
    );
  }
  res.json(rows[0]);
}));

app.delete('/api/usuarios/:id', h(auth.allow('administracion')), h(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta' });
  const { rowCount } = await db.pool.query('DELETE FROM usuarios WHERE id = $1', [id]);
  if (rowCount === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Asignación de obras por usuario (solo admin) — restringe qué proyectos
// puede ver/operar un Residente o Cabo. El admin nunca necesita asignación.
// ---------------------------------------------------------------------------
app.get('/api/usuarios/:id/proyectos', h(auth.allow('administracion')), h(async (req, res) => {
  const id = Number(req.params.id);
  const { rows: userRows } = await db.pool.query('SELECT id FROM usuarios WHERE id = $1', [id]);
  if (!userRows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
  const { rows } = await db.pool.query(`
    SELECT p.id, p.nombre
    FROM usuario_proyectos up
    JOIN proyectos p ON p.id = up.project_id
    WHERE up.usuario_id = $1
    ORDER BY p.nombre
  `, [id]);
  res.json(rows);
}));

app.put('/api/usuarios/:id/proyectos', h(auth.allow('administracion')), h(async (req, res) => {
  const id = Number(req.params.id);
  const { rows: userRows } = await db.pool.query('SELECT id FROM usuarios WHERE id = $1', [id]);
  if (!userRows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });

  const { project_ids } = req.body || {};
  if (!Array.isArray(project_ids)) return res.status(400).json({ error: 'project_ids debe ser un arreglo' });
  const ids = [...new Set(project_ids.map(Number).filter((n) => Number.isFinite(n)))];

  await db.withTransaction(async (client) => {
    await client.query('DELETE FROM usuario_proyectos WHERE usuario_id = $1', [id]);
    for (const projectId of ids) {
      await client.query(
        'INSERT INTO usuario_proyectos (usuario_id, project_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [id, projectId]
      );
    }
  });

  const { rows } = await db.pool.query(`
    SELECT p.id, p.nombre
    FROM usuario_proyectos up
    JOIN proyectos p ON p.id = up.project_id
    WHERE up.usuario_id = $1
    ORDER BY p.nombre
  `, [id]);
  res.json(rows);
}));

// ---------------------------------------------------------------------------
// Proveedores (catálogo global — no depende de project_id ni de obra)
// ---------------------------------------------------------------------------
async function getProveedoresData(activoQuery) {
  const activo = activoQuery === 'false' ? 0 : 1;
  const { rows } = await db.pool.query(
    'SELECT * FROM proveedores WHERE activo = $1 ORDER BY nombre', [activo]
  );
  return rows;
}

app.get('/api/proveedores', h(auth.allow('residente', 'cabo', 'compras', 'tesoreria', 'administracion')), h(async (req, res) => {
  res.json(await getProveedoresData(req.query.activo));
}));

app.get('/api/proveedores/export', h(auth.allow('residente', 'cabo', 'compras', 'tesoreria', 'administracion')), h(async (req, res) => {
  const proveedores = await getProveedoresData(req.query.activo);
  await sendXlsxExport(res, {
    filename: buildExportFilename('Proveedores'),
    sheets: [{
      sheetName: 'Proveedores',
      columns: [
        { header: 'Nombre', key: 'nombre', width: 30 },
        { header: 'Contacto', key: 'contacto', width: 24 },
        { header: 'Teléfono', key: 'telefono', width: 16 },
        { header: 'Email', key: 'email', width: 26 },
        { header: 'RFC', key: 'rfc', width: 16 },
        { header: 'Activo', key: 'activo', width: 10 },
      ],
      rows: proveedores.map((p) => ({
        nombre: p.nombre,
        contacto: p.contacto || '',
        telefono: p.telefono || '',
        email: p.email || '',
        rfc: p.rfc || '',
        activo: p.activo ? 'Sí' : 'No',
      })),
    }],
  });
}));

app.post('/api/proveedores', h(auth.allow('compras')), h(async (req, res) => {
  const { nombre, contacto, telefono, email, rfc } = req.body || {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre del proveedor es requerido' });
  const { rows } = await db.pool.query(
    `INSERT INTO proveedores (nombre, contacto, telefono, email, rfc) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [nombre.trim(), contacto?.trim() || null, telefono?.trim() || null, email?.trim() || null, rfc?.trim() || null]
  );
  res.status(201).json(rows[0]);
}));

app.put('/api/proveedores/:id', h(auth.allow('compras')), h(async (req, res) => {
  const id = Number(req.params.id);
  const { nombre, contacto, telefono, email, rfc } = req.body || {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre del proveedor es requerido' });
  const { rows } = await db.pool.query(
    `UPDATE proveedores SET nombre = $1, contacto = $2, telefono = $3, email = $4, rfc = $5 WHERE id = $6 RETURNING *`,
    [nombre.trim(), contacto?.trim() || null, telefono?.trim() || null, email?.trim() || null, rfc?.trim() || null, id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Proveedor no encontrado' });
  res.json(rows[0]);
}));

app.put('/api/proveedores/:id/estado', h(auth.allow('compras')), h(async (req, res) => {
  const id = Number(req.params.id);
  const { activo } = req.body || {};
  const { rows } = await db.pool.query(
    'UPDATE proveedores SET activo = $1 WHERE id = $2 RETURNING *',
    [activo ? 1 : 0, id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Proveedor no encontrado' });
  res.json(rows[0]);
}));

// ---------------------------------------------------------------------------
// Clientes (agrupador de proyectos). No hay tabla usuario_clientes: el acceso
// se deriva de si el usuario tiene acceso a >=1 proyecto de ese cliente vía
// usuario_proyectos (admin ve todos, igual que en GET /api/projects).
// ---------------------------------------------------------------------------
app.get('/api/clientes', h(auth.allow('residente', 'cabo', 'compras', 'tesoreria', 'administracion', 'logistica')), h(async (req, res) => {
  if (req.user.puesto === 'admin') {
    const { rows } = await db.pool.query(`
      SELECT c.id, c.nombre, COUNT(p.id)::int AS num_proyectos
      FROM clientes c
      LEFT JOIN proyectos p ON p.cliente_id = c.id
      GROUP BY c.id, c.nombre
      ORDER BY c.nombre
    `);
    return res.json(rows);
  }
  const { rows } = await db.pool.query(`
    SELECT c.id, c.nombre, COUNT(DISTINCT p.id)::int AS num_proyectos
    FROM clientes c
    JOIN proyectos p ON p.cliente_id = c.id
    JOIN usuario_proyectos up ON up.project_id = p.id AND up.usuario_id = $1
    GROUP BY c.id, c.nombre
    ORDER BY c.nombre
  `, [req.user.id]);
  res.json(rows);
}));

app.post('/api/clientes', h(auth.allow()), h(async (req, res) => {
  const { nombre } = req.body || {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre del cliente es requerido' });
  const { rows } = await db.pool.query(
    'INSERT INTO clientes (nombre) VALUES ($1) RETURNING *', [nombre.trim()]
  );
  res.status(201).json({ ...rows[0], num_proyectos: 0 });
}));

// ---------------------------------------------------------------------------
// Resumen financiero agregado por cliente (solo admin/residente).
// Reutiliza la misma lógica de cálculo que GET /api/projects/:id/resumen
// pero en una sola query lateral en vez de N roundtrips individuales.
// ---------------------------------------------------------------------------
app.get('/api/clientes/:id/resumen-agregado', h(auth.allow('residente')), h(async (req, res) => {
  const clienteId = Number(req.params.id);
  if (!Number.isFinite(clienteId)) return res.status(400).json({ error: 'ID de cliente inválido' });

  // Verificar que el cliente existe
  const { rows: clienteRows } = await db.pool.query('SELECT id, nombre FROM clientes WHERE id=$1', [clienteId]);
  if (!clienteRows[0]) return res.status(404).json({ error: 'Cliente no encontrado' });

  // Para no-admin: solo proyectos a los que tiene acceso
  const isAdminUser = req.user.puesto === 'admin';
  const proyQuery = isAdminUser
    ? `SELECT p.id, p.nombre FROM proyectos p WHERE p.cliente_id = $1 ORDER BY p.id`
    : `SELECT p.id, p.nombre FROM proyectos p
       JOIN usuario_proyectos up ON up.project_id = p.id AND up.usuario_id = $2
       WHERE p.cliente_id = $1 ORDER BY p.id`;
  const { rows: proyectos } = await db.pool.query(proyQuery, isAdminUser ? [clienteId] : [clienteId, req.user.id]);

  if (!proyectos.length) return res.json({ cliente: clienteRows[0], proyectos: [], total_contratos: 0, importe_ejecutado: 0, importe_por_ejecutar: 0, avance_ponderado_pct: 0 });

  // Por cada proyecto: obtener presupuesto_total y último avance real en una sola query lateral
  const ids = proyectos.map((p) => p.id);
  const { rows: metricRows } = await db.pool.query(`
    SELECT
      p.id,
      COALESCE(
        (SELECT valor::DOUBLE PRECISION FROM meta WHERE project_id = p.id AND clave = 'total_sin_iva' LIMIT 1),
        (SELECT importe FROM conceptos WHERE project_id = p.id AND es_total = 1 AND grupo IS NULL ORDER BY orden DESC LIMIT 1),
        0
      ) AS presupuesto_total,
      COALESCE(
        (SELECT avance_financiero_real FROM avances_semanales
         WHERE project_id = p.id AND avance_financiero_real IS NOT NULL ORDER BY semana DESC LIMIT 1),
        0
      ) AS avance_ejecutado_pct
    FROM proyectos p
    WHERE p.id = ANY($1)
    ORDER BY p.id
  `, [ids]);

  const proyConMetrics = proyectos.map((p) => {
    const m = metricRows.find((r) => r.id === p.id) || {};
    const total = Number(m.presupuesto_total) || 0;
    const pct = Number(m.avance_ejecutado_pct) || 0;
    return {
      id: p.id,
      nombre: p.nombre,
      presupuesto_total: total,
      avance_ejecutado_pct: pct,
      importe_ejecutado: Number((total * pct / 100).toFixed(2)),
      importe_por_ejecutar: Number((total * (1 - pct / 100)).toFixed(2)),
    };
  });

  const totalContratos = proyConMetrics.reduce((s, p) => s + p.presupuesto_total, 0);
  const importeEjecutado = proyConMetrics.reduce((s, p) => s + p.importe_ejecutado, 0);
  const importePorEjecutar = proyConMetrics.reduce((s, p) => s + p.importe_por_ejecutar, 0);
  const avancePonderado = totalContratos > 0 ? (importeEjecutado / totalContratos) * 100 : 0;

  res.json({
    cliente: clienteRows[0],
    proyectos: proyConMetrics,
    total_contratos: Number(totalContratos.toFixed(2)),
    importe_ejecutado: Number(importeEjecutado.toFixed(2)),
    importe_por_ejecutar: Number(importePorEjecutar.toFixed(2)),
    avance_ponderado_pct: Number(avancePonderado.toFixed(1)),
  });
}));

// ---------------------------------------------------------------------------
// Resumen global (admin + desarrollador) — suma todas las obras del sistema.
// Reutiliza la misma query lateral de resumen-agregado sin filtro por cliente.
// ---------------------------------------------------------------------------
app.get('/api/resumen-global', h(auth.allow()), h(async (req, res) => {
  const { rows } = await db.pool.query(`
    SELECT
      COALESCE(
        (SELECT valor::DOUBLE PRECISION FROM meta
         WHERE project_id = p.id AND clave = 'total_sin_iva' LIMIT 1),
        (SELECT importe FROM conceptos
         WHERE project_id = p.id AND es_total = 1 AND grupo IS NULL ORDER BY orden DESC LIMIT 1),
        0
      ) AS presupuesto_total,
      COALESCE(
        (SELECT avance_financiero_real FROM avances_semanales
         WHERE project_id = p.id AND avance_financiero_real IS NOT NULL
         ORDER BY semana DESC LIMIT 1),
        0
      ) AS avance_ejecutado_pct
    FROM proyectos p
    ORDER BY p.id
  `);

  const numProyectos = rows.length;
  const totalContratos = rows.reduce((s, r) => s + Number(r.presupuesto_total), 0);
  const importeEjecutado = rows.reduce(
    (s, r) => s + Number(r.presupuesto_total) * Number(r.avance_ejecutado_pct) / 100, 0
  );
  const importePorEjecutar = totalContratos - importeEjecutado;
  const avancePonderado = totalContratos > 0 ? (importeEjecutado / totalContratos) * 100 : 0;

  res.json({
    num_proyectos: numProyectos,
    total_contratos: Number(totalContratos.toFixed(2)),
    importe_ejecutado: Number(importeEjecutado.toFixed(2)),
    importe_por_ejecutar: Number(importePorEjecutar.toFixed(2)),
    avance_ponderado_pct: Number(avancePonderado.toFixed(1)),
  });
}));

// ---------------------------------------------------------------------------
// Bienvenida — resumen ligero por proyecto para la pantalla de bienvenida
// ---------------------------------------------------------------------------
app.get('/api/bienvenida', h(auth.allow('residente', 'cabo', 'compras', 'tesoreria', 'administracion', 'logistica')), h(async (req, res) => {
  const isAdminUser = req.user.puesto === 'admin';
  const { rows: projects } = isAdminUser
    ? await db.pool.query(`
        SELECT p.id, p.nombre, p.cliente_id, c.nombre AS cliente_nombre
        FROM proyectos p LEFT JOIN clientes c ON c.id = p.cliente_id
        ORDER BY c.nombre NULLS LAST, p.nombre
      `)
    : await db.pool.query(`
        SELECT p.id, p.nombre, p.cliente_id, c.nombre AS cliente_nombre
        FROM proyectos p
        LEFT JOIN clientes c ON c.id = p.cliente_id
        JOIN usuario_proyectos up ON up.project_id = p.id AND up.usuario_id = $1
        ORDER BY c.nombre NULLS LAST, p.nombre
      `, [req.user.id]);

  const enriched = await Promise.all(projects.map(async (p) => {
    const [{ rows: metaRows }, { rows: avRows }] = await Promise.all([
      db.pool.query("SELECT valor FROM meta WHERE project_id = $1 AND clave = 'total_sin_iva'", [p.id]),
      db.pool.query(
        'SELECT avance_financiero_real FROM avances_semanales WHERE project_id = $1 AND avance_financiero_real IS NOT NULL ORDER BY semana DESC LIMIT 1',
        [p.id]
      ),
    ]);
    return {
      ...p,
      presupuesto_total: req.user.puesto === 'residente'
        ? null
        : (metaRows[0] ? Number(metaRows[0].valor) : 0),
      avance_financiero_ejecutado: avRows[0] ? Number(avRows[0].avance_financiero_real) : 0,
    };
  }));

  res.json(enriched);
}));

// ---------------------------------------------------------------------------
// Última visita — último proyecto visitado por usuario+cliente
// ---------------------------------------------------------------------------
app.get('/api/ultima-visita/:clienteId', h(async (req, res) => {
  const clienteId = parseInt(req.params.clienteId, 10);
  if (!clienteId) return res.status(400).json({ error: 'Cliente inválido' });
  const { rows } = await db.pool.query(
    'SELECT proyecto_id FROM ultima_visita WHERE usuario_id = $1 AND cliente_id = $2',
    [req.user.id, clienteId]
  );
  res.json(rows[0] || {});
}));

app.put('/api/ultima-visita/:clienteId', h(async (req, res) => {
  const clienteId = parseInt(req.params.clienteId, 10);
  const { proyecto_id } = req.body || {};
  if (!clienteId || !proyecto_id) return res.status(400).json({ error: 'Datos inválidos' });
  await db.pool.query(`
    INSERT INTO ultima_visita (usuario_id, cliente_id, proyecto_id, actualizado_en)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (usuario_id, cliente_id) DO UPDATE
      SET proyecto_id = EXCLUDED.proyecto_id, actualizado_en = NOW()
  `, [req.user.id, clienteId, proyecto_id]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Proyectos
// ---------------------------------------------------------------------------
app.get('/api/projects', h(auth.allow('residente', 'cabo', 'compras', 'tesoreria', 'administracion', 'logistica')), h(async (req, res) => {
  const projects = req.user.puesto === 'admin'
    ? await db.listProjects()
    : (await db.pool.query(`
        SELECT p.* FROM proyectos p
        JOIN usuario_proyectos up ON up.project_id = p.id
        WHERE up.usuario_id = $1
        ORDER BY p.id DESC
      `, [req.user.id])).rows;
  const rows = await Promise.all(projects.map(async (p) => {
    const { rows: metaRows } = await db.pool.query(
      'SELECT clave, valor FROM meta WHERE project_id = $1', [p.id]
    );
    const meta = metaToObject(metaRows);
    const { rows: totalRows } = await db.pool.query(
      "SELECT importe FROM conceptos WHERE project_id = $1 AND es_total = 1 AND grupo IS NULL ORDER BY orden DESC LIMIT 1",
      [p.id]
    );
    return {
      id: p.id,
      nombre: p.nombre,
      cliente_id: p.cliente_id,
      archivo_original: p.archivo_original,
      creado_en: p.creado_en,
      obra: meta.obra || null,
      lugar: meta.lugar || null,
      inicio_obra: meta.inicio_obra || null,
      fin_obra: meta.fin_obra || null,
      total_sin_iva: meta.total_sin_iva ? Number(meta.total_sin_iva) : (totalRows[0] ? totalRows[0].importe : null),
      total_con_iva: meta.total_con_iva ? Number(meta.total_con_iva) : null,
    };
  }));
  res.json(rows);
}));

// Emite el token de subida directa a Vercel Blob: el navegador sube el
// .xlsx sin pasar por esta función serverless (que tiene un límite de body
// no configurable en Vercel), y solo nos manda la URL resultante a
// POST /api/projects. Ver Prompts_mod1.md Tarea 1 (Error 413).
app.post('/api/projects/upload-token', h(auth.allow()), h(async (req, res) => {
  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        if (!/\.xlsx$/i.test(pathname)) {
          throw new Error('Solo se admiten archivos .xlsx');
        }
        return {
          allowedContentTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
          addRandomSuffix: true,
          maximumSizeInBytes: 50 * 1024 * 1024,
        };
      },
    });
    res.json(jsonResponse);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.post('/api/projects', h(auth.allow()), h(async (req, res) => {
  const { cliente_id, archivo_url, archivo_nombre } = req.body || {};
  if (!archivo_url) return res.status(400).json({ error: 'Sube un archivo .xlsx de presupuesto' });
  const clienteId = Number(cliente_id);
  if (!Number.isFinite(clienteId)) {
    del(archivo_url).catch(() => {});
    return res.status(400).json({ error: 'Indica a qué cliente pertenece este presupuesto' });
  }
  const { rows: clienteRows } = await db.pool.query('SELECT id FROM clientes WHERE id = $1', [clienteId]);
  if (!clienteRows[0]) {
    del(archivo_url).catch(() => {});
    return res.status(400).json({ error: 'El cliente indicado no existe' });
  }
  const tmpPath = path.join(os.tmpdir(), `presupuesto-${Date.now()}-${Math.round(Math.random() * 1e9)}.xlsx`);
  try {
    const blobResult = await get(archivo_url, { access: 'private' });
    if (!blobResult) throw new Error('No se pudo descargar el archivo subido');
    await pipeline(Readable.fromWeb(blobResult.stream), fs.createWriteStream(tmpPath));
    const parsed = await parseWorkbook(tmpPath);
    if (!parsed.conceptos.length && !parsed.insumos.length) {
      throw new Error('No se reconoció una hoja de presupuesto ni de listado de insumos en el archivo. Verifica que tenga el formato esperado (columnas Código, Concepto, Unidad, Cantidad, Precio, Importe).');
    }
    const nombre = parsed.meta.obra || (archivo_nombre || '').replace(/\.xlsx$/i, '') || 'Presupuesto';
    const record = await db.createProjectRecord(nombre, archivo_nombre || null, clienteId);
    await db.withTransaction((client) => ingest(client, record.id, parsed));
    res.status(201).json({
      id: record.id,
      nombre: record.nombre,
      sheets: parsed.sheets,
      conceptos: parsed.conceptos.length,
      insumos: parsed.insumos.length,
      destajistas: parsed.destajistas ? parsed.destajistas.length : 0,
      inicio_obra: parsed.meta.inicio_obra || null,
      fin_obra: parsed.meta.fin_obra || null,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  } finally {
    fs.rm(tmpPath, () => {});
    del(archivo_url).catch(() => {});
  }
}));

app.get('/api/projects/:id', h(auth.allow('residente', 'cabo', 'compras', 'tesoreria', 'administracion', 'logistica')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { rows } = await db.pool.query('SELECT clave, valor FROM meta WHERE project_id = $1', [req.project.id]);
  const meta = metaToObject(rows);
  res.json({ id: req.project.id, nombre: req.project.nombre, archivo_original: req.project.archivo_original, meta });
}));

app.delete('/api/projects/:id', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  await db.deleteProject(req.project.id);
  res.json({ ok: true });
}));

// Reasigna el cliente de un proyecto ya existente — cubre tanto correcciones
// (cliente equivocado) como proyectos huérfanos (cliente_id NULL) que hayan
// quedado de cargas hechas antes de que cliente_id fuera obligatorio.
app.put('/api/projects/:id/cliente', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const clienteId = Number((req.body || {}).cliente_id);
  if (!Number.isFinite(clienteId)) return res.status(400).json({ error: 'Indica un cliente válido' });
  const { rows: clienteRows } = await db.pool.query('SELECT id FROM clientes WHERE id = $1', [clienteId]);
  if (!clienteRows[0]) return res.status(400).json({ error: 'El cliente indicado no existe' });
  const { rows } = await db.pool.query(
    'UPDATE proyectos SET cliente_id = $1 WHERE id = $2 RETURNING *', [clienteId, req.project.id]
  );
  res.json(rows[0]);
}));

app.patch('/api/projects/:id/nombre', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const nombre = (req.body?.nombre || '').toString().trim();
  if (!nombre) return res.status(400).json({ error: 'El nombre no puede estar vacío' });
  const { rows } = await db.pool.query(
    'UPDATE proyectos SET nombre = $1 WHERE id = $2 RETURNING id, nombre',
    [nombre, req.project.id]
  );
  res.json(rows[0]);
}));

app.put('/api/projects/:id/fechas-obra', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { inicio_obra, fin_obra } = req.body || {};
  if (!inicio_obra || !fin_obra) {
    return res.status(400).json({ error: 'Debes indicar fecha de inicio y fecha de fin de obra' });
  }
  if (fin_obra <= inicio_obra) {
    return res.status(400).json({ error: 'La fecha de fin de obra debe ser posterior a la de inicio' });
  }

  const pid = req.project.id;
  const { rows: avRow } = await db.pool.query(
    'SELECT COUNT(*) AS n FROM avances_semanales WHERE project_id = $1 AND (avance_fisico_real IS NOT NULL OR avance_financiero_real IS NOT NULL)',
    [pid]
  );
  if (Number(avRow[0].n) > 0) {
    return res.status(409).json({
      error: 'Ya hay avance real capturado en este proyecto; cambiar las fechas de obra regeneraría el programa y borraría ese avance.',
    });
  }

  const { rows: conceptoRows } = await db.pool.query('SELECT * FROM conceptos WHERE project_id = $1 ORDER BY orden', [pid]);
  const { rows: metaRows } = await db.pool.query('SELECT clave, valor FROM meta WHERE project_id = $1', [pid]);
  const meta = metaToObject(metaRows);
  meta.inicio_obra = inicio_obra;
  meta.fin_obra = fin_obra;
  const plan = generatePlanning(conceptoRows, meta);

  const upsertMeta = `
    INSERT INTO meta (project_id, clave, valor) VALUES ($1, $2, $3)
    ON CONFLICT (project_id, clave) DO UPDATE SET valor = EXCLUDED.valor
  `;

  await db.withTransaction(async (client) => {
    await client.query(upsertMeta, [pid, 'inicio_obra', inicio_obra]);
    await client.query(upsertMeta, [pid, 'fin_obra', fin_obra]);

    await client.query('DELETE FROM programa_ejecucion WHERE project_id = $1', [pid]);
    for (const p of plan.programa) {
      await client.query(
        `INSERT INTO programa_ejecucion
           (project_id, codigo, concepto, grupo, fecha_inicio, fecha_fin, duracion_dias, importe, peso_pct, orden)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [pid, p.codigo, p.concepto, p.grupo, p.fecha_inicio, p.fecha_fin, p.duracion_dias, p.importe, p.peso_pct, p.orden]
      );
    }

    // Delete avance_conceptos that reference avances of this project before deleting avances_semanales
    await client.query(`
      DELETE FROM avance_conceptos
      WHERE concepto_id IN (SELECT id FROM conceptos WHERE project_id = $1)
    `, [pid]);
    await client.query('DELETE FROM avances_semanales WHERE project_id = $1', [pid]);
    for (const a of plan.avances) {
      await client.query(
        `INSERT INTO avances_semanales
           (project_id, semana, fecha_inicio, fecha_fin, avance_fisico_programado, avance_fisico_real, avance_financiero_programado, avance_financiero_real)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [pid, a.semana, a.fecha_inicio, a.fecha_fin, a.avance_fisico_programado, a.avance_fisico_real, a.avance_financiero_programado, a.avance_financiero_real]
      );
    }
  });

  res.json({ ok: true, inicio_obra, fin_obra, actividades: plan.programa.length, semanas: plan.avances.length });
}));

// ---------------------------------------------------------------------------
// Contrato PDF — extracción vía Claude API (admin-only). Flujo separado de la
// carga por Excel: no toca parseWorkbook/ingest ni el catálogo de conceptos/
// insumos, solo crea/actualiza la obra y sus datos de contrato en `meta`.
// contrato-preview no guarda nada; contrato-confirm es quien escribe.
// ---------------------------------------------------------------------------
const CONTRATO_PREVIEW_LIMIT = 10; // máx extracciones por usuario por hora

app.post('/api/projects/contrato-preview',
  h(auth.allow()),
  h(async (req, res, next) => {
    // Rate limiting serverless-safe: cuenta en Postgres, no en memoria de proceso.
    const { rows: rlRows } = await db.pool.query(
      `SELECT COUNT(*)::int AS n FROM api_rate_limits
       WHERE usuario_id = $1 AND endpoint = 'contrato_preview'
         AND creado_en > NOW() - INTERVAL '1 hour'`,
      [req.user.id]
    );
    if (rlRows[0].n >= CONTRATO_PREVIEW_LIMIT) {
      return res.status(429).json({
        error: `Límite de ${CONTRATO_PREVIEW_LIMIT} extracciones por hora alcanzado. Intenta más tarde.`,
      });
    }
    next();
  }),
  uploadPdf.single('pdf'),
  h(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Sube un archivo .pdf de contrato' });
    // Registrar la llamada antes de invocar Anthropic (cuenta aunque la extracción falle).
    await db.pool.query(
      'INSERT INTO api_rate_limits (usuario_id, endpoint) VALUES ($1, $2)',
      [req.user.id, 'contrato_preview']
    );
    const tmpPath = req.file.path;
    const blobNombre = req.file.originalname || 'contrato.pdf';
    try {
      const buffer = await fs.promises.readFile(tmpPath);
      // Extraer primero: si falla, no se consume crédito de Blob.
      const resultado = await extraerDatosContrato(buffer);
      // Subir PDF a Vercel Blob (privado) para persistirlo.
      const blobKey = `contratos/${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`;
      const blobResult = await put(blobKey, buffer, { access: 'private', contentType: 'application/pdf' });
      res.json({ ...resultado, blob_url: blobResult.url, blob_nombre: blobNombre });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    } finally {
      fs.rm(tmpPath, () => {});
    }
  })
);

app.post('/api/projects/contrato-confirm', h(auth.allow()), h(async (req, res) => {
  const body = req.body || {};
  const upsertMeta = `
    INSERT INTO meta (project_id, clave, valor) VALUES ($1, $2, $3)
    ON CONFLICT (project_id, clave) DO UPDATE SET valor = EXCLUDED.valor
  `;

  let projectId;
  let nombre;
  if (body.project_id) {
    projectId = Number(body.project_id);
    const proj = await db.getProject(projectId);
    if (!proj) return res.status(404).json({ error: 'Proyecto no encontrado' });
    nombre = proj.nombre;
  } else {
    const clienteId = Number(body.cliente_id);
    if (!Number.isFinite(clienteId)) {
      return res.status(400).json({ error: 'Indica a qué cliente pertenece esta obra' });
    }
    const { rows: clienteRows } = await db.pool.query('SELECT id FROM clientes WHERE id = $1', [clienteId]);
    if (!clienteRows[0]) return res.status(400).json({ error: 'El cliente indicado no existe' });
    nombre = (body.nombre || body.obra_descripcion || body.proyecto_desarrollo || '').toString().trim() || 'Contrato sin nombre';
    const record = await db.createProjectRecord(nombre, body.archivo_original || null, clienteId);
    projectId = record.id;
  }

  await db.withTransaction(async (client) => {
    for (const campo of CAMPOS_CONTRATO) {
      const valor = body[campo];
      if (valor === undefined || valor === null || valor === '') continue;
      const clave = campo === 'fecha_inicio' ? 'inicio_obra' : campo === 'fecha_termino' ? 'fin_obra' : campo;
      await client.query(upsertMeta, [projectId, clave, String(valor)]);
    }

    // Persistir PDF en tabla contratos (si viene blob_url del preview).
    if (body.blob_url) {
      const { rows: prev } = await client.query('SELECT blob_url FROM contratos WHERE project_id = $1', [projectId]);
      // Si ya había un blob distinto, borrar el anterior para no acumular huérfanos.
      if (prev[0] && prev[0].blob_url !== body.blob_url) {
        del(prev[0].blob_url).catch(() => {});
      }
      const blobNombre = (body.blob_nombre || 'contrato.pdf').toString().slice(0, 255);
      await client.query(`
        INSERT INTO contratos (project_id, blob_url, nombre_archivo, subido_por)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (project_id) DO UPDATE
          SET blob_url = EXCLUDED.blob_url,
              nombre_archivo = EXCLUDED.nombre_archivo,
              subido_por = EXCLUDED.subido_por,
              subido_en = NOW()
      `, [projectId, body.blob_url, blobNombre, req.user.id]);
    }
  });

  res.json({ project_id: projectId, nombre });
}));

// Proxy del PDF de contrato (blob privado) — solo usuarios con acceso a la obra.
app.get('/api/projects/:id/contrato/pdf', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { rows } = await db.pool.query('SELECT blob_url, nombre_archivo FROM contratos WHERE project_id = $1', [req.project.id]);
  if (!rows[0]) return res.status(404).json({ error: 'No hay PDF de contrato para esta obra' });
  const blobResult = await get(rows[0].blob_url, { access: 'private' });
  if (!blobResult) return res.status(404).json({ error: 'Archivo no encontrado en almacenamiento' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${rows[0].nombre_archivo}"`);
  await pipeline(Readable.fromWeb(blobResult.stream), res);
}));

// ---------------------------------------------------------------------------
// Impuestos (IMSS/SAT/INFONAVIT) por obra y periodo — aplica a TODAS las
// obras por igual (no depende de que tengan Contrato PDF cargado). Los
// periodos 'pendiente' los crea el cron mensual (ver
// POST /api/cron/recordatorio-impuestos, registrado antes del middleware de
// sesión); aquí solo se consultan y se marcan como 'cargado'.
// ---------------------------------------------------------------------------
app.get('/api/projects/:id/impuestos', h(auth.allow('tesoreria', 'administracion')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { rows } = await db.pool.query(
    'SELECT * FROM pagos_impuestos_obra WHERE project_id = $1 ORDER BY periodo_anio DESC, periodo_mes DESC',
    [req.project.id]
  );
  res.json(rows);
}));

app.get('/api/projects/:id/impuestos/resumen', h(auth.allow('tesoreria', 'administracion')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { rows } = await db.pool.query(
    'SELECT * FROM pagos_impuestos_obra WHERE project_id = $1', [req.project.id]
  );
  const sum = (periodos) => periodos.reduce((acc, p) => {
    acc.imss += Number(p.imss_monto) || 0;
    acc.sat += Number(p.sat_monto) || 0;
    acc.infonavit += Number(p.infonavit_monto) || 0;
    return acc;
  }, { imss: 0, sat: 0, infonavit: 0 });

  const pagados = rows.filter((p) => p.estado === 'cargado');
  const pendientes = rows.filter((p) => p.estado === 'pendiente');
  const acumuladoPagado = sum(pagados);
  const pendienteActual = sum(pendientes);

  res.json({
    acumulado_pagado: { ...acumuladoPagado, total: acumuladoPagado.imss + acumuladoPagado.sat + acumuladoPagado.infonavit },
    pendiente_actual: { ...pendienteActual, total: pendienteActual.imss + pendienteActual.sat + pendienteActual.infonavit },
  });
}));

app.post('/api/projects/:id/impuestos/:periodoId/cargar', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const periodoId = Number(req.params.periodoId);
  const { imss_monto, imss_referencia, sat_monto, sat_referencia, infonavit_monto, infonavit_referencia } = req.body || {};

  const { rows: existRows } = await db.pool.query(
    'SELECT id FROM pagos_impuestos_obra WHERE id = $1 AND project_id = $2', [periodoId, req.project.id]
  );
  if (!existRows[0]) return res.status(404).json({ error: 'Periodo no encontrado' });

  const { rows } = await db.pool.query(
    `UPDATE pagos_impuestos_obra
     SET imss_monto = $1, imss_referencia = $2, sat_monto = $3, sat_referencia = $4,
         infonavit_monto = $5, infonavit_referencia = $6, estado = 'cargado',
         cargado_por = $7, cargado_en = NOW()
     WHERE id = $8
     RETURNING *`,
    [
      imss_monto ?? null, imss_referencia || null, sat_monto ?? null, sat_referencia || null,
      infonavit_monto ?? null, infonavit_referencia || null, req.user.id, periodoId,
    ]
  );
  res.json(rows[0]);
}));

// ---------------------------------------------------------------------------
// Conceptos
// ---------------------------------------------------------------------------
app.get('/api/projects/:id/conceptos', h(auth.allow('residente', 'cabo', 'compras', 'tesoreria', 'administracion', 'logistica')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { rows } = await db.pool.query('SELECT * FROM conceptos WHERE project_id = $1 ORDER BY orden', [req.project.id]);
  res.json(rows);
}));

// ---------------------------------------------------------------------------
// Mapeo concepto ↔ insumos (solo admin) — infraestructura de captura para un
// futuro bloqueo de avance; todavía no se usa para bloquear nada.
// ---------------------------------------------------------------------------
app.get('/api/conceptos/:id/insumos', h(auth.allow()), h(async (req, res) => {
  const conceptoId = Number(req.params.id);
  const { rows: conceptoRows } = await db.pool.query('SELECT id FROM conceptos WHERE id = $1', [conceptoId]);
  if (!conceptoRows[0]) return res.status(404).json({ error: 'Concepto no encontrado' });

  const { rows } = await db.pool.query(`
    SELECT i.* FROM concepto_insumos ci
    JOIN insumos i ON i.id = ci.insumo_id
    WHERE ci.concepto_id = $1
    ORDER BY i.orden
  `, [conceptoId]);
  res.json(rows);
}));

app.post('/api/conceptos/:id/insumos', h(auth.allow()), h(async (req, res) => {
  const conceptoId = Number(req.params.id);
  const insumoId = Number((req.body || {}).insumo_id);
  if (!insumoId) return res.status(400).json({ error: 'insumo_id es requerido' });

  const { rows: conceptoRows } = await db.pool.query('SELECT id, project_id FROM conceptos WHERE id = $1', [conceptoId]);
  if (!conceptoRows[0]) return res.status(404).json({ error: 'Concepto no encontrado' });

  const { rows: insumoRows } = await db.pool.query('SELECT id, project_id FROM insumos WHERE id = $1', [insumoId]);
  if (!insumoRows[0]) return res.status(404).json({ error: 'Insumo no encontrado' });

  if (insumoRows[0].project_id !== conceptoRows[0].project_id) {
    return res.status(400).json({ error: 'El insumo debe pertenecer al mismo presupuesto que el concepto' });
  }

  try {
    await db.pool.query(
      'INSERT INTO concepto_insumos (concepto_id, insumo_id) VALUES ($1, $2)',
      [conceptoId, insumoId]
    );
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Este insumo ya está vinculado a este concepto' });
    }
    throw err;
  }
  res.status(201).json({ ok: true });
}));

app.delete('/api/conceptos/:id/insumos/:insumo_id', h(auth.allow()), h(async (req, res) => {
  const conceptoId = Number(req.params.id);
  const insumoId = Number(req.params.insumo_id);
  const { rowCount } = await db.pool.query(
    'DELETE FROM concepto_insumos WHERE concepto_id = $1 AND insumo_id = $2',
    [conceptoId, insumoId]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Ese insumo no está vinculado a este concepto' });
  res.json({ ok: true });
}));

// Resumen de progreso de mapeo por proyecto (no pedido explícitamente, pero
// necesario para el contador "X/95 conceptos mapeados" de la pantalla admin).
app.get('/api/projects/:id/concepto-insumos/resumen', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const pid = req.project.id;
  const { rows: totalRows } = await db.pool.query(
    "SELECT COUNT(*) AS n FROM conceptos WHERE project_id = $1 AND es_total = 0", [pid]
  );
  const { rows: mapeadosRows } = await db.pool.query(`
    SELECT DISTINCT ci.concepto_id
    FROM concepto_insumos ci
    JOIN conceptos c ON c.id = ci.concepto_id
    WHERE c.project_id = $1
  `, [pid]);
  res.json({
    total_conceptos: Number(totalRows[0].n),
    conceptos_mapeados: mapeadosRows.length,
    concepto_ids_mapeados: mapeadosRows.map((r) => r.concepto_id),
  });
}));

// ---------------------------------------------------------------------------
// Insumos
// ---------------------------------------------------------------------------
async function getInsumosData(pid, { categoria, q } = {}) {
  let sql = "SELECT * FROM insumos WHERE project_id = $1 AND (codigo IS NULL OR codigo NOT ILIKE 'MO%')";
  const params = [pid];
  let idx = 2;
  if (categoria) { sql += ` AND categoria = $${idx++}`; params.push(categoria); }
  if (q) {
    sql += ` AND (codigo ILIKE $${idx} OR concepto ILIKE $${idx + 1})`;
    params.push(`%${q}%`, `%${q}%`);
    idx += 2;
  }
  sql += ' ORDER BY orden';
  const { rows: insumos } = await db.pool.query(sql, params);

  const { rows: acumuladosRows } = await db.pool.query(`
    SELECT ri.insumo_id,
           SUM(ri.cantidad_solicitada) AS cantidad_acumulada,
           MAX(ri.precio_solicitado) AS precio_max_solicitado
    FROM requisicion_items ri
    JOIN requisiciones r ON r.id = ri.requisicion_id
    WHERE r.project_id = $1 AND r.estado != 'cancelada'
    GROUP BY ri.insumo_id
  `, [pid]);
  const acumulados = new Map(acumuladosRows.map((r) => [r.insumo_id, r]));

  return insumos.map((i) => {
    const acc = acumulados.get(i.id);
    const cantidad_acumulada = acc ? Number(acc.cantidad_acumulada) : 0;
    return {
      ...i,
      cantidad_acumulada,
      cantidad_disponible: i.cantidad_presupuesto - cantidad_acumulada,
      sobrepasado_cantidad: cantidad_acumulada > i.cantidad_presupuesto,
    };
  });
}

app.get('/api/projects/:id/insumos', h(auth.allow('residente', 'cabo', 'compras', 'logistica')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  let data = await getInsumosData(req.project.id, req.query);
  if (req.user.puesto === 'cabo') {
    data = data.map(({ precio_presupuesto, ...rest }) => ({ ...rest, precio_presupuesto: null }));
  }
  res.json(data);
}));

app.get('/api/projects/:id/insumos/export', h(auth.allow('residente', 'cabo', 'compras', 'logistica')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const insumos = await getInsumosData(req.project.id, req.query);
  await sendXlsxExport(res, {
    filename: buildExportFilename('Insumos', req.project.nombre),
    sheets: [{
      sheetName: 'Insumos',
      columns: [
        { header: 'Código', key: 'codigo', width: 14 },
        { header: 'Concepto', key: 'concepto', width: 40 },
        { header: 'Unidad', key: 'unidad', width: 10 },
        { header: 'Categoría', key: 'categoria', width: 18 },
        { header: 'Cantidad presupuestada', key: 'cantidad_presupuesto', width: 20, format: 'int' },
        { header: 'Precio unitario presupuestado', key: 'precio_presupuesto', width: 22, format: 'money' },
        { header: 'IVA (%)', key: 'iva_tasa', width: 10, format: 'int' },
        { header: 'Cantidad acumulada (requisitada)', key: 'cantidad_acumulada', width: 24, format: 'int' },
        { header: 'Cantidad disponible', key: 'cantidad_disponible', width: 18, format: 'int' },
        { header: 'Excede presupuesto', key: 'excede', width: 16 },
      ],
      rows: insumos.map((i) => ({
        codigo: i.codigo,
        concepto: i.concepto,
        unidad: i.unidad,
        categoria: i.categoria,
        cantidad_presupuesto: Number(i.cantidad_presupuesto),
        precio_presupuesto: Number(i.precio_presupuesto),
        iva_tasa: Number(i.iva_tasa),
        cantidad_acumulada: Number(i.cantidad_acumulada),
        cantidad_disponible: Number(i.cantidad_disponible),
        excede: i.sobrepasado_cantidad ? 'Sí' : 'No',
      })),
    }],
  });
}));

app.get('/api/projects/:id/insumos/categorias', h(auth.allow('residente', 'cabo', 'compras', 'logistica')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { rows } = await db.pool.query(
    "SELECT DISTINCT categoria FROM insumos WHERE project_id = $1 AND categoria IS NOT NULL AND (codigo IS NULL OR codigo NOT ILIKE 'MO%') ORDER BY categoria",
    [req.project.id]
  );
  res.json(rows.map((r) => r.categoria));
}));

// Solo permite editar la tasa de IVA del insumo (captura hacia adelante para
// Compras) — no toca codigo/concepto/cantidad/precio del catálogo del .xlsx.
app.put('/api/projects/:id/insumos/:insumoId', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const ivaTasa = Number((req.body || {}).iva_tasa);
  if (!Number.isFinite(ivaTasa) || ivaTasa < 0 || ivaTasa > 100) {
    return res.status(400).json({ error: 'iva_tasa debe ser un número entre 0 y 100' });
  }
  const { rows } = await db.pool.query(
    'UPDATE insumos SET iva_tasa = $1 WHERE id = $2 AND project_id = $3 RETURNING *',
    [ivaTasa, Number(req.params.insumoId), req.project.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Insumo no encontrado' });
  res.json(rows[0]);
}));

// ---------------------------------------------------------------------------
// Requisiciones
// ---------------------------------------------------------------------------
async function computeAlertsAndTotals(projectId, items, ignoreRequisicionId = null) {
  const out = [];
  for (const it of items) {
    const { rows: insumoRows } = await db.pool.query(
      'SELECT * FROM insumos WHERE id = $1 AND project_id = $2',
      [it.insumo_id, projectId]
    );
    const insumo = insumoRows[0];
    if (!insumo) throw new Error(`Insumo ${it.insumo_id} no existe en el catálogo`);

    let acumSql = `
      SELECT COALESCE(SUM(ri.cantidad_solicitada), 0) AS acumulado
      FROM requisicion_items ri
      JOIN requisiciones r ON r.id = ri.requisicion_id
      WHERE ri.insumo_id = $1 AND r.project_id = $2 AND r.estado != 'cancelada'
    `;
    const acumParams = [it.insumo_id, projectId];
    if (ignoreRequisicionId != null) {
      acumSql += ' AND ri.requisicion_id != $3';
      acumParams.push(ignoreRequisicionId);
    }
    const { rows: acumRows } = await db.pool.query(acumSql, acumParams);
    const acumulado = Number(acumRows[0].acumulado);

    const cantidad = Number(it.cantidad_solicitada) || 0;
    const precio = it.precio_solicitado != null && it.precio_solicitado !== ''
      ? Number(it.precio_solicitado)
      : insumo.precio_presupuesto;

    out.push({
      insumo_id: it.insumo_id,
      insumo,
      cantidad_solicitada: cantidad,
      precio_solicitado: precio,
      importe: Number((cantidad * precio).toFixed(2)),
      alerta_cantidad: (acumulado + cantidad) > insumo.cantidad_presupuesto ? 1 : 0,
      alerta_precio: precio > insumo.precio_presupuesto ? 1 : 0,
      cantidad_acumulada_previa: acumulado,
      observaciones: it.observaciones || null,
    });
  }
  return out;
}

async function getRequisicionesData(pid) {
  const { rows: reqs } = await db.pool.query(
    'SELECT * FROM requisiciones WHERE project_id = $1 ORDER BY id DESC',
    [pid]
  );
  return Promise.all(reqs.map(async (r) => {
    const { rows } = await db.pool.query(`
      SELECT COUNT(*) AS num_items,
             COALESCE(SUM(importe), 0) AS importe_total,
             COALESCE(SUM(alerta_cantidad), 0) AS alertas_cantidad,
             COALESCE(SUM(alerta_precio), 0) AS alertas_precio
      FROM requisicion_items WHERE requisicion_id = $1
    `, [r.id]);
    return { ...r, ...rows[0] };
  }));
}

app.get('/api/projects/:id/requisiciones', h(auth.allow('residente', 'cabo', 'compras', 'logistica')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  let data = await getRequisicionesData(req.project.id);
  if (['residente', 'cabo'].includes(req.user.puesto)) {
    data = data.map(({ importe_total, alertas_precio, ...rest }) => rest);
  }
  res.json(data);
}));

app.get('/api/projects/:id/requisiciones/export', h(auth.allow('residente', 'cabo', 'compras', 'logistica')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const reqs = await getRequisicionesData(req.project.id);
  const reqMap = new Map(reqs.map((r) => [r.id, r]));

  const { rows: itemRows } = await db.pool.query(`
    SELECT ri.requisicion_id, ri.cantidad_solicitada, ri.precio_solicitado, ri.importe,
           ri.alerta_cantidad, ri.alerta_precio,
           i.codigo AS insumo_codigo, i.concepto AS insumo_concepto, i.unidad
    FROM requisicion_items ri
    JOIN insumos i ON i.id = ri.insumo_id
    JOIN requisiciones r ON r.id = ri.requisicion_id
    WHERE r.project_id = $1
    ORDER BY ri.requisicion_id, ri.id
  `, [req.project.id]);

  await sendXlsxExport(res, {
    filename: buildExportFilename('Requisiciones', req.project.nombre),
    sheets: [
      {
        sheetName: 'Resumen',
        columns: [
          { header: 'Folio', key: 'folio', width: 16 },
          { header: 'Fecha', key: 'fecha', width: 14 },
          { header: 'Estado', key: 'estado', width: 14 },
          { header: 'No. de partidas', key: 'num_items', width: 14, format: 'int' },
          { header: 'Importe total', key: 'importe_total', width: 18, format: 'money' },
          { header: 'Alertas de cantidad', key: 'alertas_cantidad', width: 18, format: 'int' },
          { header: 'Alertas de precio', key: 'alertas_precio', width: 16, format: 'int' },
          { header: 'Observaciones', key: 'observaciones', width: 30 },
        ],
        rows: reqs.map((r) => ({
          folio: r.folio || `Requisición #${r.id}`,
          fecha: r.fecha,
          estado: r.estado,
          num_items: Number(r.num_items),
          importe_total: Number(r.importe_total),
          alertas_cantidad: Number(r.alertas_cantidad),
          alertas_precio: Number(r.alertas_precio),
          observaciones: r.observaciones || '',
        })),
      },
      {
        sheetName: 'Detalle por insumo',
        columns: [
          { header: 'Folio', key: 'folio', width: 16 },
          { header: 'Fecha', key: 'fecha', width: 14 },
          { header: 'Estado', key: 'estado', width: 14 },
          { header: 'Código', key: 'insumo_codigo', width: 14 },
          { header: 'Material / Insumo', key: 'insumo_concepto', width: 36 },
          { header: 'Unidad', key: 'unidad', width: 10 },
          { header: 'Cantidad solicitada', key: 'cantidad_solicitada', width: 20 },
          { header: 'Precio solicitado', key: 'precio_solicitado', width: 18, format: 'money' },
          { header: 'Importe', key: 'importe', width: 18, format: 'money' },
          { header: 'Alerta cantidad', key: 'alerta_cantidad', width: 16 },
          { header: 'Alerta precio', key: 'alerta_precio', width: 14 },
        ],
        rows: itemRows.map((it) => {
          const r = reqMap.get(it.requisicion_id) || {};
          return {
            folio: r.folio || `Requisición #${it.requisicion_id}`,
            fecha: r.fecha || '',
            estado: r.estado || '',
            insumo_codigo: it.insumo_codigo,
            insumo_concepto: it.insumo_concepto,
            unidad: it.unidad || '',
            cantidad_solicitada: Number(it.cantidad_solicitada),
            precio_solicitado: Number(it.precio_solicitado),
            importe: Number(it.importe),
            alerta_cantidad: it.alerta_cantidad ? 'Sí' : '',
            alerta_precio: it.alerta_precio ? 'Sí' : '',
          };
        }),
      },
    ],
  });
}));

app.get('/api/projects/:id/requisiciones/:reqId', h(auth.allow('residente', 'cabo', 'compras', 'logistica')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { rows: reqRows } = await db.pool.query(
    'SELECT * FROM requisiciones WHERE id = $1 AND project_id = $2',
    [Number(req.params.reqId), req.project.id]
  );
  if (!reqRows[0]) return res.status(404).json({ error: 'Requisición no encontrada' });
  const { rows: rawItems } = await db.pool.query(`
    SELECT ri.*, i.codigo AS insumo_codigo, i.concepto AS insumo_concepto, i.categoria, i.unidad,
           i.cantidad_presupuesto, i.precio_presupuesto
    FROM requisicion_items ri
    JOIN insumos i ON i.id = ri.insumo_id
    WHERE ri.requisicion_id = $1
    ORDER BY ri.id
  `, [reqRows[0].id]);
  const sinPrecios = ['residente', 'cabo'].includes(req.user.puesto);
  const items = sinPrecios
    ? rawItems.map(({ precio_solicitado, precio_presupuesto, importe, ...rest }) => rest)
    : rawItems;
  res.json({ ...reqRows[0], items });
}));

app.post('/api/projects/:id/requisiciones', h(auth.allow('residente', 'cabo', 'compras')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const pid = req.project.id;
  const { folio, fecha, observaciones, items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'La requisición debe incluir al menos un insumo' });
  }
  try {
    const computed = await computeAlertsAndTotals(pid, items);
    const created = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO requisiciones (project_id, folio, fecha, estado, observaciones)
         VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), 'borrador', $4) RETURNING *`,
        [pid, folio || null, fecha || null, observaciones || null]
      );
      const reqId = rows[0].id;
      for (const c of computed) {
        await client.query(
          `INSERT INTO requisicion_items
             (requisicion_id, insumo_id, cantidad_solicitada, precio_solicitado, importe, alerta_cantidad, alerta_precio, observaciones)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [reqId, c.insumo_id, c.cantidad_solicitada, c.precio_solicitado, c.importe, c.alerta_cantidad, c.alerta_precio, c.observaciones]
        );
      }
      return rows[0];
    });
    res.status(201).json({ ...created, items: computed, tiene_alertas: computed.some((c) => c.alerta_cantidad || c.alerta_precio) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.put('/api/projects/:id/requisiciones/:reqId', h(auth.allow('residente', 'cabo', 'compras')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const pid = req.project.id;
  const reqId = Number(req.params.reqId);
  const { rows: existRows } = await db.pool.query(
    'SELECT * FROM requisiciones WHERE id = $1 AND project_id = $2',
    [reqId, pid]
  );
  if (!existRows[0]) return res.status(404).json({ error: 'Requisición no encontrada' });
  if (existRows[0].estado !== 'borrador') {
    return res.status(400).json({ error: 'Solo se pueden editar requisiciones en estado "borrador"' });
  }
  const { folio, fecha, observaciones, items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'La requisición debe incluir al menos un insumo' });
  }
  try {
    const computed = await computeAlertsAndTotals(pid, items, reqId);
    const updated = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE requisiciones SET folio = $1, fecha = COALESCE($2::date, fecha), observaciones = $3
         WHERE id = $4 RETURNING *`,
        [folio || null, fecha || null, observaciones || null, reqId]
      );
      await client.query('DELETE FROM requisicion_items WHERE requisicion_id = $1', [reqId]);
      for (const c of computed) {
        await client.query(
          `INSERT INTO requisicion_items
             (requisicion_id, insumo_id, cantidad_solicitada, precio_solicitado, importe, alerta_cantidad, alerta_precio, observaciones)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [reqId, c.insumo_id, c.cantidad_solicitada, c.precio_solicitado, c.importe, c.alerta_cantidad, c.alerta_precio, c.observaciones]
        );
      }
      return rows[0];
    });
    res.json({ ...updated, items: computed, tiene_alertas: computed.some((c) => c.alerta_cantidad || c.alerta_precio) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// 'autorizada'/'rechazada' quedan reservadas a admin — residente/cabo pueden
// llegar hasta 'enviada' (que dispara la notificación de autorización) o
// 'cancelada'/'borrador' igual que antes. No se degrada nada del flujo
// existente, solo se restringe quién puede poner el estado final.
app.put('/api/projects/:id/requisiciones/:reqId/estado', h(auth.allow('residente', 'cabo', 'compras', 'logistica')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { estado } = req.body || {};
  if (!['borrador', 'enviada', 'autorizada', 'rechazada', 'cancelada'].includes(estado)) {
    return res.status(400).json({ error: 'Estado inválido' });
  }
  if (estado === 'rechazada' && req.user.puesto !== 'admin') {
    return res.status(403).json({ error: 'Solo un administrador puede rechazar una requisición' });
  }
  if (estado === 'autorizada' && !['admin', 'logistica'].includes(req.user.puesto)) {
    return res.status(403).json({ error: 'Solo un administrador o Logística puede autorizar una requisición' });
  }
  const reqId = Number(req.params.reqId);
  const { rows: reqRows } = await db.pool.query(
    'SELECT folio FROM requisiciones WHERE id = $1 AND project_id = $2', [reqId, req.project.id]
  );
  if (!reqRows[0]) return res.status(404).json({ error: 'Requisición no encontrada' });

  await db.pool.query('UPDATE requisiciones SET estado = $1 WHERE id = $2', [estado, reqId]);

  if (estado === 'enviada' && req.user.puesto !== 'admin') {
    const folio = reqRows[0].folio || `Requisición #${reqId}`;
    await notificarAdmins(req.project.id, 'requisicion_pendiente', reqId, `${req.user.nombre} envió ${folio} para autorización`);
  }
  res.json({ ok: true });
}));

app.delete('/api/projects/:id/requisiciones/:reqId', h(auth.allow('residente', 'cabo', 'compras')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const reqId = Number(req.params.reqId);
  const { rows } = await db.pool.query(
    'SELECT estado FROM requisiciones WHERE id = $1 AND project_id = $2', [reqId, req.project.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Requisición no encontrada' });
  if (rows[0].estado !== 'borrador') {
    return res.status(400).json({ error: 'Solo se pueden eliminar requisiciones en estado "borrador"' });
  }
  await db.pool.query('DELETE FROM requisiciones WHERE id = $1', [reqId]);
  res.json({ ok: true });
}));

app.post('/api/projects/:id/requisiciones/preview', h(auth.allow('residente', 'cabo', 'compras')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { items, ignore_requisicion_id } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items debe ser un arreglo' });
  try {
    const computed = await computeAlertsAndTotals(
      req.project.id,
      items,
      ignore_requisicion_id != null ? Number(ignore_requisicion_id) : null
    );
    res.json({ items: computed, tiene_alertas: computed.some((c) => c.alerta_cantidad || c.alerta_precio) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// ---------------------------------------------------------------------------
// Órdenes de compra — generadas a partir de una requisición 'autorizada'.
// Una requisición puede tener varias OCs (compra dividida entre proveedores
// o para ordenar en distintos momentos); el sobre-orden de un item solo
// genera una alerta, no bloquea, igual que alerta_cantidad/alerta_precio.
// ---------------------------------------------------------------------------

// Calcula Subtotal/IVA/Total de una OC a partir de sus items (cada uno con
// `importe` e `iva_tasa` propia del insumo) y el toggle `incluye_iva` de la
// orden: si incluye_iva, el importe capturado ES el total con IVA (se
// desglosa hacia atrás); si no, el importe es el subtotal (se le suma IVA).
function computeIvaBreakdown(items, incluyeIva) {
  let subtotal = 0;
  let iva = 0;
  for (const it of items) {
    const importe = Number(it.importe) || 0;
    const tasa = Number(it.iva_tasa) / 100;
    if (incluyeIva) {
      const sub = importe / (1 + tasa);
      subtotal += sub;
      iva += importe - sub;
    } else {
      subtotal += importe;
      iva += importe * tasa;
    }
  }
  const total = subtotal + iva;
  return {
    subtotal: Number(subtotal.toFixed(2)),
    iva: Number(iva.toFixed(2)),
    total: Number(total.toFixed(2)),
  };
}
async function getOrdenesData(pid) {
  const { rows: ordenes } = await db.pool.query(`
    SELECT oc.*, pv.nombre AS proveedor_nombre, r.folio AS requisicion_folio
    FROM ordenes_compra oc
    JOIN proveedores pv ON pv.id = oc.proveedor_id
    JOIN requisiciones r ON r.id = oc.requisicion_id
    WHERE oc.project_id = $1
    ORDER BY oc.id DESC
  `, [pid]);
  return Promise.all(ordenes.map(async (o) => {
    const { rows: itemRows } = await db.pool.query(`
      SELECT COUNT(*) AS num_items, COALESCE(SUM(importe), 0) AS importe_total
      FROM orden_compra_items WHERE orden_compra_id = $1
    `, [o.id]);
    const { rows: pagoRows } = await db.pool.query(
      'SELECT COALESCE(SUM(monto), 0) AS total_pagado FROM pagos WHERE orden_compra_id = $1', [o.id]
    );
    const importeTotal = Number(itemRows[0].importe_total);
    const totalPagado = Number(pagoRows[0].total_pagado);
    return {
      ...o, ...itemRows[0],
      total_pagado: Number(totalPagado.toFixed(2)),
      saldo_pendiente: Number((importeTotal - totalPagado).toFixed(2)),
    };
  }));
}

app.get('/api/projects/:id/ordenes', h(auth.allow('residente', 'cabo', 'compras', 'tesoreria', 'administracion', 'logistica')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  res.json(await getOrdenesData(req.project.id));
}));

app.get('/api/projects/:id/ordenes/export', h(auth.allow('residente', 'cabo', 'compras', 'tesoreria', 'administracion', 'logistica')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const ordenes = await getOrdenesData(req.project.id);
  await sendXlsxExport(res, {
    filename: buildExportFilename('OrdenesDeCompra', req.project.nombre),
    sheets: [{
      sheetName: 'Ordenes de Compra',
      columns: [
        { header: 'Folio', key: 'folio', width: 16 },
        { header: 'Fecha', key: 'fecha', width: 14 },
        { header: 'Proveedor', key: 'proveedor', width: 26 },
        { header: 'Requisición', key: 'requisicion', width: 16 },
        { header: 'Estado', key: 'estado', width: 16 },
        { header: 'Incluye IVA', key: 'incluye_iva', width: 12 },
        { header: 'No. de partidas', key: 'num_items', width: 14, format: 'int' },
        { header: 'Importe total', key: 'importe_total', width: 18, format: 'money' },
        { header: 'Total pagado', key: 'total_pagado', width: 18, format: 'money' },
        { header: 'Saldo pendiente', key: 'saldo_pendiente', width: 18, format: 'money' },
      ],
      rows: ordenes.map((o) => ({
        folio: o.folio || `OC #${o.id}`,
        fecha: o.fecha,
        proveedor: o.proveedor_nombre,
        requisicion: o.requisicion_folio || '',
        estado: o.estado,
        incluye_iva: o.incluye_iva ? 'Sí' : 'No',
        num_items: Number(o.num_items),
        importe_total: Number(o.importe_total),
        total_pagado: Number(o.total_pagado),
        saldo_pendiente: Number(o.saldo_pendiente),
      })),
    }],
  });
}));

app.get('/api/projects/:id/ordenes/:ocId', h(auth.allow('residente', 'cabo', 'compras', 'tesoreria', 'administracion', 'logistica')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { rows: ocRows } = await db.pool.query(`
    SELECT oc.*, pv.nombre AS proveedor_nombre, pv.contacto AS proveedor_contacto, pv.telefono AS proveedor_telefono,
           r.folio AS requisicion_folio
    FROM ordenes_compra oc
    JOIN proveedores pv ON pv.id = oc.proveedor_id
    JOIN requisiciones r ON r.id = oc.requisicion_id
    WHERE oc.id = $1 AND oc.project_id = $2
  `, [Number(req.params.ocId), req.project.id]);
  if (!ocRows[0]) return res.status(404).json({ error: 'Orden de compra no encontrada' });
  const { rows: items } = await db.pool.query(`
    SELECT oci.*, i.codigo AS insumo_codigo, i.concepto AS insumo_concepto, i.unidad, i.iva_tasa,
           ri.cantidad_solicitada
    FROM orden_compra_items oci
    JOIN requisicion_items ri ON ri.id = oci.requisicion_item_id
    JOIN insumos i ON i.id = ri.insumo_id
    WHERE oci.orden_compra_id = $1
    ORDER BY oci.id
  `, [ocRows[0].id]);
  res.json({ ...ocRows[0], items, desglose_iva: computeIvaBreakdown(items, ocRows[0].incluye_iva) });
}));

app.post('/api/projects/:id/requisiciones/:reqId/ordenes', h(auth.allow('compras')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const pid = req.project.id;
  const reqId = Number(req.params.reqId);
  const { proveedor_id, folio, fecha, observaciones, items } = req.body || {};
  const incluyeIva = (req.body || {}).incluye_iva === true; // default false: la mayoría de precios se capturan sin IVA

  const { rows: reqRows } = await db.pool.query(
    'SELECT * FROM requisiciones WHERE id = $1 AND project_id = $2', [reqId, pid]
  );
  if (!reqRows[0]) return res.status(404).json({ error: 'Requisición no encontrada' });
  if (reqRows[0].estado !== 'autorizada') {
    return res.status(400).json({ error: 'Solo se pueden generar órdenes de compra de requisiciones en estado "autorizada"' });
  }
  if (!proveedor_id) return res.status(400).json({ error: 'Selecciona un proveedor' });
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'La orden de compra debe incluir al menos un insumo' });
  }

  const { rows: reqItems } = await db.pool.query(`
    SELECT ri.*, i.iva_tasa
    FROM requisicion_items ri
    JOIN insumos i ON i.id = ri.insumo_id
    WHERE ri.requisicion_id = $1
  `, [reqId]);
  const reqItemsMap = new Map(reqItems.map((it) => [it.id, it]));
  for (const it of items) {
    if (!reqItemsMap.has(Number(it.requisicion_item_id))) {
      return res.status(400).json({ error: `El item ${it.requisicion_item_id} no pertenece a esta requisición` });
    }
  }

  // Acumulado ya ordenado por item en OCs previas no canceladas de esta misma
  // requisición — permite compra dividida y solo advierte si se pasa de lo solicitado.
  const { rows: acumRows } = await db.pool.query(`
    SELECT oci.requisicion_item_id, COALESCE(SUM(oci.cantidad_ordenada), 0) AS acumulado
    FROM orden_compra_items oci
    JOIN ordenes_compra oc ON oc.id = oci.orden_compra_id
    WHERE oc.requisicion_id = $1 AND oc.estado != 'cancelada'
    GROUP BY oci.requisicion_item_id
  `, [reqId]);
  const acumMap = new Map(acumRows.map((r) => [r.requisicion_item_id, Number(r.acumulado)]));

  const computed = items.map((it) => {
    const reqItem = reqItemsMap.get(Number(it.requisicion_item_id));
    const cantidad = Math.max(0, Number(it.cantidad_ordenada) || 0);
    const precio = Math.max(0, Number(it.precio_unitario) || 0);
    const acumuladoPrevio = acumMap.get(reqItem.id) || 0;
    return {
      requisicion_item_id: reqItem.id,
      cantidad_ordenada: cantidad,
      precio_unitario: precio,
      importe: Number((cantidad * precio).toFixed(2)),
      iva_tasa: reqItem.iva_tasa,
      alerta_sobre_orden: (acumuladoPrevio + cantidad) > reqItem.cantidad_solicitada,
    };
  });

  const created = await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO ordenes_compra (project_id, requisicion_id, proveedor_id, folio, fecha, observaciones, incluye_iva)
       VALUES ($1,$2,$3,$4,COALESCE($5::date, CURRENT_DATE),$6,$7) RETURNING *`,
      [pid, reqId, Number(proveedor_id), folio || null, fecha || null, observaciones || null, incluyeIva]
    );
    const ocId = rows[0].id;
    for (const c of computed) {
      await client.query(
        `INSERT INTO orden_compra_items (orden_compra_id, requisicion_item_id, cantidad_ordenada, precio_unitario, importe)
         VALUES ($1,$2,$3,$4,$5)`,
        [ocId, c.requisicion_item_id, c.cantidad_ordenada, c.precio_unitario, c.importe]
      );
    }
    return rows[0];
  });

  res.status(201).json({
    ...created,
    items: computed,
    importe_total: Number(computed.reduce((s, c) => s + c.importe, 0).toFixed(2)),
    tiene_alertas: computed.some((c) => c.alerta_sobre_orden),
    desglose_iva: computeIvaBreakdown(computed, incluyeIva),
  });
}));

// 'confirmada'/'rechazada' quedan reservadas a admin, mismo criterio que en
// requisiciones — residente puede llegar hasta 'enviada' (dispara la
// notificación) o 'cancelada', igual que antes.
app.put('/api/projects/:id/ordenes/:ocId/estado', h(auth.allow('compras', 'tesoreria')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { estado } = req.body || {};
  if (!['borrador', 'enviada', 'confirmada', 'rechazada', 'cancelada'].includes(estado)) {
    return res.status(400).json({ error: 'Estado inválido. Los estados de recepción se controlan automáticamente.' });
  }
  if (['confirmada', 'rechazada'].includes(estado) && !['admin', 'tesoreria'].includes(req.user.puesto)) {
    return res.status(403).json({ error: 'Solo un administrador o Tesorería puede confirmar o rechazar una orden de compra' });
  }
  const ocId = Number(req.params.ocId);
  if (estado === 'cancelada') {
    const { rows: pagoRows } = await db.pool.query('SELECT COUNT(*) AS n FROM pagos WHERE orden_compra_id = $1', [ocId]);
    if (Number(pagoRows[0].n) > 0) {
      return res.status(400).json({ error: 'No se puede cancelar una orden de compra que ya tiene pagos registrados' });
    }
  }
  const { rows: ocRows } = await db.pool.query(
    'SELECT folio FROM ordenes_compra WHERE id = $1 AND project_id = $2', [ocId, req.project.id]
  );
  if (!ocRows[0]) return res.status(404).json({ error: 'Orden de compra no encontrada' });

  await db.pool.query('UPDATE ordenes_compra SET estado = $1 WHERE id = $2', [estado, ocId]);

  if (estado === 'enviada' && req.user.puesto !== 'admin') {
    const folio = ocRows[0].folio || `OC #${ocId}`;
    await notificarAdmins(req.project.id, 'oc_pendiente', ocId, `${req.user.nombre} envió ${folio} para autorización`);
  }
  res.json({ ok: true });
}));

app.delete('/api/projects/:id/ordenes/:ocId', h(auth.allow('compras')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const ocId = Number(req.params.ocId);
  const { rows: ocRows } = await db.pool.query(
    'SELECT estado FROM ordenes_compra WHERE id = $1 AND project_id = $2', [ocId, req.project.id]
  );
  if (!ocRows[0]) return res.status(404).json({ error: 'Orden de compra no encontrada' });
  if (ocRows[0].estado !== 'borrador') {
    return res.status(400).json({ error: 'Solo se pueden eliminar órdenes de compra en estado "borrador"' });
  }
  await db.pool.query('DELETE FROM ordenes_compra WHERE id = $1', [ocId]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Recepción de material — actualiza ordenes_compra.estado directamente
// (recibida_parcial/recibida_completa), sin pasar por el endpoint .../estado
// que sigue bloqueando esos dos valores.
// ---------------------------------------------------------------------------
async function computeEstadoRecepcion(ocId) {
  const { rows } = await db.pool.query(`
    SELECT oci.cantidad_ordenada, COALESCE(SUM(ri.cantidad_recibida), 0) AS recibido
    FROM orden_compra_items oci
    LEFT JOIN recepcion_items ri ON ri.orden_compra_item_id = oci.id
    WHERE oci.orden_compra_id = $1
    GROUP BY oci.id, oci.cantidad_ordenada
  `, [ocId]);

  const algoRecibido = rows.some((r) => Number(r.recibido) > 0);
  if (!algoRecibido) return null; // nada recibido todavía: no se toca el estado actual

  const todoCompleto = rows.every((r) => Number(r.recibido) >= Number(r.cantidad_ordenada));
  const nuevoEstado = todoCompleto ? 'recibida_completa' : 'recibida_parcial';
  await db.pool.query('UPDATE ordenes_compra SET estado = $1 WHERE id = $2', [nuevoEstado, ocId]);
  return nuevoEstado;
}

app.get('/api/projects/:id/ordenes/:ocId/recepciones', h(auth.allow('residente', 'cabo', 'compras', 'tesoreria', 'administracion', 'logistica')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const ocId = Number(req.params.ocId);
  const { rows: ocRows } = await db.pool.query(
    'SELECT id FROM ordenes_compra WHERE id = $1 AND project_id = $2', [ocId, req.project.id]
  );
  if (!ocRows[0]) return res.status(404).json({ error: 'Orden de compra no encontrada' });

  const { rows: recepciones } = await db.pool.query(
    'SELECT * FROM recepciones WHERE orden_compra_id = $1 ORDER BY id DESC', [ocId]
  );
  const withItems = await Promise.all(recepciones.map(async (r) => {
    const { rows: items } = await db.pool.query(`
      SELECT ri.*, i.codigo AS insumo_codigo, i.concepto AS insumo_concepto, i.unidad
      FROM recepcion_items ri
      JOIN orden_compra_items oci ON oci.id = ri.orden_compra_item_id
      JOIN requisicion_items reqi ON reqi.id = oci.requisicion_item_id
      JOIN insumos i ON i.id = reqi.insumo_id
      WHERE ri.recepcion_id = $1
      ORDER BY ri.id
    `, [r.id]);
    return { ...r, items };
  }));
  res.json(withItems);
}));

app.post('/api/projects/:id/ordenes/:ocId/recepciones', h(auth.allow('compras')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const ocId = Number(req.params.ocId);
  const { rows: ocRows } = await db.pool.query(
    'SELECT * FROM ordenes_compra WHERE id = $1 AND project_id = $2', [ocId, req.project.id]
  );
  if (!ocRows[0]) return res.status(404).json({ error: 'Orden de compra no encontrada' });
  if (!['confirmada', 'recibida_parcial'].includes(ocRows[0].estado)) {
    return res.status(400).json({ error: 'Solo se pueden registrar recepciones de órdenes en estado "confirmada" o "recibida_parcial"' });
  }

  const { fecha, recibido_por, observaciones, items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'La recepción debe incluir al menos un item' });
  }

  const { rows: ocItems } = await db.pool.query('SELECT * FROM orden_compra_items WHERE orden_compra_id = $1', [ocId]);
  const ocItemsMap = new Map(ocItems.map((it) => [it.id, it]));
  for (const it of items) {
    if (!ocItemsMap.has(Number(it.orden_compra_item_id))) {
      return res.status(400).json({ error: `El item ${it.orden_compra_item_id} no pertenece a esta orden de compra` });
    }
  }

  const { rows: acumRows } = await db.pool.query(`
    SELECT oci.id AS orden_compra_item_id, COALESCE(SUM(ri.cantidad_recibida), 0) AS acumulado
    FROM orden_compra_items oci
    LEFT JOIN recepcion_items ri ON ri.orden_compra_item_id = oci.id
    WHERE oci.orden_compra_id = $1
    GROUP BY oci.id
  `, [ocId]);
  const acumMap = new Map(acumRows.map((r) => [r.orden_compra_item_id, Number(r.acumulado)]));

  const computed = items.map((it) => {
    const ocItem = ocItemsMap.get(Number(it.orden_compra_item_id));
    const cantidad = Math.max(0, Number(it.cantidad_recibida) || 0);
    const acumuladoPrevio = acumMap.get(ocItem.id) || 0;
    const acumuladoNuevo = acumuladoPrevio + cantidad;
    const faltante = Math.max(0, Number((ocItem.cantidad_ordenada - acumuladoNuevo).toFixed(4)));
    return {
      orden_compra_item_id: ocItem.id,
      cantidad_recibida: cantidad,
      observaciones: it.observaciones || null,
      cantidad_ordenada: ocItem.cantidad_ordenada,
      acumulado_recibido: acumuladoNuevo,
      faltante,
      alerta_faltante: faltante > 0,
    };
  });

  const recepcion = await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO recepciones (orden_compra_id, fecha, recibido_por, observaciones)
       VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4) RETURNING *`,
      [ocId, fecha || null, recibido_por?.trim() || null, observaciones || null]
    );
    const recepcionId = rows[0].id;
    for (const c of computed) {
      await client.query(
        `INSERT INTO recepcion_items (recepcion_id, orden_compra_item_id, cantidad_recibida, observaciones)
         VALUES ($1,$2,$3,$4)`,
        [recepcionId, c.orden_compra_item_id, c.cantidad_recibida, c.observaciones]
      );
    }
    return rows[0];
  });

  const nuevoEstado = await computeEstadoRecepcion(ocId);

  res.status(201).json({
    ...recepcion,
    items: computed,
    estado_orden: nuevoEstado || ocRows[0].estado,
    tiene_alertas: computed.some((c) => c.alerta_faltante),
  });
}));

// ---------------------------------------------------------------------------
// Pagos a proveedor — lectura para residente/admin, alta/baja solo admin
// (mismo patrón que proveedores). No bloquea sobre-pago, solo advierte.
// ---------------------------------------------------------------------------
async function saldoDeOrden(ocId) {
  const { rows: itemRows } = await db.pool.query(
    'SELECT COALESCE(SUM(importe), 0) AS importe_total FROM orden_compra_items WHERE orden_compra_id = $1', [ocId]
  );
  const { rows: pagoRows } = await db.pool.query(
    'SELECT COALESCE(SUM(monto), 0) AS total_pagado FROM pagos WHERE orden_compra_id = $1', [ocId]
  );
  const importeTotal = Number(itemRows[0].importe_total);
  const totalPagado = Number(pagoRows[0].total_pagado);
  return {
    importe_total: importeTotal,
    total_pagado: Number(totalPagado.toFixed(2)),
    saldo_pendiente: Number((importeTotal - totalPagado).toFixed(2)),
  };
}

app.get('/api/projects/:id/ordenes/:ocId/pagos', h(auth.allow('compras', 'tesoreria')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const ocId = Number(req.params.ocId);
  const { rows: ocRows } = await db.pool.query(
    'SELECT id FROM ordenes_compra WHERE id = $1 AND project_id = $2', [ocId, req.project.id]
  );
  if (!ocRows[0]) return res.status(404).json({ error: 'Orden de compra no encontrada' });

  const { rows: pagos } = await db.pool.query(
    'SELECT * FROM pagos WHERE orden_compra_id = $1 ORDER BY id DESC', [ocId]
  );
  res.json({ pagos, ...(await saldoDeOrden(ocId)) });
}));

app.post('/api/projects/:id/ordenes/:ocId/pagos', h(auth.allow('tesoreria')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const ocId = Number(req.params.ocId);
  const { rows: ocRows } = await db.pool.query(
    'SELECT * FROM ordenes_compra WHERE id = $1 AND project_id = $2', [ocId, req.project.id]
  );
  if (!ocRows[0]) return res.status(404).json({ error: 'Orden de compra no encontrada' });
  const ESTADOS_PAGABLES = ['enviada', 'confirmada', 'recibida_parcial', 'recibida_completa'];
  if (!ESTADOS_PAGABLES.includes(ocRows[0].estado)) {
    return res.status(400).json({ error: `No se pueden registrar pagos de una orden en estado "${ocRows[0].estado}"` });
  }

  const { fecha, monto, metodo, referencia, observaciones } = req.body || {};
  const incluyeIva = (req.body || {}).incluye_iva !== false; // default true (patrón real observado)
  const montoNum = Number(monto);
  if (!Number.isFinite(montoNum) || montoNum <= 0) {
    return res.status(400).json({ error: 'El monto del pago debe ser mayor a 0' });
  }

  const { rows } = await db.pool.query(
    `INSERT INTO pagos (orden_compra_id, fecha, monto, metodo, referencia, observaciones, incluye_iva)
     VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5, $6, $7) RETURNING *`,
    [ocId, fecha || null, montoNum, metodo?.trim() || null, referencia?.trim() || null, observaciones?.trim() || null, incluyeIva]
  );

  const saldo = await saldoDeOrden(ocId);
  res.status(201).json({ ...rows[0], ...saldo, alerta_sobrepago: saldo.saldo_pendiente < 0 });
}));

app.delete('/api/projects/:id/ordenes/:ocId/pagos/:pagoId', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const ocId = Number(req.params.ocId);
  const pagoId = Number(req.params.pagoId);
  // Verify the order belongs to this project before touching payments (IDOR fix A1).
  const { rows: ocRows } = await db.pool.query(
    'SELECT id FROM ordenes_compra WHERE id = $1 AND project_id = $2',
    [ocId, req.project.id]
  );
  if (!ocRows[0]) return res.status(404).json({ error: 'No encontrado' });
  const { rowCount } = await db.pool.query(
    'DELETE FROM pagos WHERE id = $1 AND orden_compra_id = $2',
    [pagoId, ocId]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Pago no encontrado' });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Gastos generales — costos que no nacen de una requisición (nómina,
// permisos, renta de equipo, combustible, etc.). Lectura para residente/
// admin, alta/edición/baja solo admin, mismo patrón que proveedores/pagos.
// ---------------------------------------------------------------------------
// Debe reflejar exactamente GASTO_CATEGORIA_LABELS en public/app.js.
const GASTO_CATEGORIA_LABELS = {
  nomina: 'Nómina',
  permisos: 'Permisos',
  renta_equipo: 'Renta de equipo',
  combustible: 'Combustible',
  servicios: 'Servicios',
  otro: 'Otro',
};

async function getGastosData(pid, { categoria, estado } = {}) {
  let sql = 'SELECT * FROM gastos_generales WHERE project_id = $1';
  const params = [pid];
  let idx = 2;
  if (categoria) { sql += ` AND categoria = $${idx++}`; params.push(categoria); }
  if (estado) { sql += ` AND estado = $${idx++}`; params.push(estado); }
  sql += ' ORDER BY fecha DESC, id DESC';
  const { rows } = await db.pool.query(sql, params);
  return rows;
}

app.get('/api/projects/:id/gastos', h(auth.allow('tesoreria')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  res.json(await getGastosData(req.project.id, req.query));
}));

app.post('/api/projects/:id/gastos', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const pid = req.project.id;
  const { categoria, concepto, fecha, monto, observaciones } = req.body || {};
  if (!categoria?.trim()) return res.status(400).json({ error: 'La categoría es requerida' });
  if (!concepto?.trim()) return res.status(400).json({ error: 'El concepto es requerido' });
  const montoNum = Number(monto);
  if (!Number.isFinite(montoNum) || montoNum <= 0) {
    return res.status(400).json({ error: 'El monto debe ser mayor a 0' });
  }
  const { rows } = await db.pool.query(
    `INSERT INTO gastos_generales (project_id, categoria, concepto, fecha, monto, observaciones, creado_por)
     VALUES ($1,$2,$3,COALESCE($4::date, CURRENT_DATE),$5,$6,$7) RETURNING *`,
    [pid, categoria.trim(), concepto.trim(), fecha || null, montoNum, observaciones?.trim() || null, req.user.id]
  );
  res.status(201).json(rows[0]);
}));

app.put('/api/projects/:id/gastos/:gastoId', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const pid = req.project.id;
  const gastoId = Number(req.params.gastoId);
  const { categoria, concepto, fecha, monto, observaciones } = req.body || {};
  const montoNum = monto != null && monto !== '' ? Number(monto) : null;
  if (montoNum != null && (!Number.isFinite(montoNum) || montoNum <= 0)) {
    return res.status(400).json({ error: 'El monto debe ser mayor a 0' });
  }
  const { rows } = await db.pool.query(
    `UPDATE gastos_generales SET
       categoria = COALESCE($1, categoria),
       concepto = COALESCE($2, concepto),
       fecha = COALESCE($3::date, fecha),
       monto = COALESCE($4, monto),
       observaciones = COALESCE($5, observaciones)
     WHERE id = $6 AND project_id = $7
     RETURNING *`,
    [categoria?.trim() || null, concepto?.trim() || null, fecha || null, montoNum, observaciones?.trim() || null, gastoId, pid]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Gasto no encontrado' });
  res.json(rows[0]);
}));

app.put('/api/projects/:id/gastos/:gastoId/estado', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { estado } = req.body || {};
  if (!['pendiente', 'pagado'].includes(estado)) {
    return res.status(400).json({ error: 'Estado inválido' });
  }
  const { rows } = await db.pool.query(
    'UPDATE gastos_generales SET estado = $1 WHERE id = $2 AND project_id = $3 RETURNING *',
    [estado, Number(req.params.gastoId), req.project.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Gasto no encontrado' });
  res.json(rows[0]);
}));

app.delete('/api/projects/:id/gastos/:gastoId', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const gastoId = Number(req.params.gastoId);
  const { rows: existRows } = await db.pool.query(
    'SELECT estado FROM gastos_generales WHERE id = $1 AND project_id = $2', [gastoId, req.project.id]
  );
  if (!existRows[0]) return res.status(404).json({ error: 'Gasto no encontrado' });
  if (existRows[0].estado === 'pagado') {
    return res.status(400).json({ error: 'No se puede eliminar un gasto ya marcado como pagado' });
  }
  await db.pool.query('DELETE FROM gastos_generales WHERE id = $1', [gastoId]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Resumen financiero: Avance Valorizado (% ejecutado × presupuesto, idéntico
// al que ya usa el Resumen) vs Erogado Real (Compras + Gastos Generales) —
// dos fuentes de verdad separadas, nunca fusionadas ni promediadas.
// ---------------------------------------------------------------------------
async function getFinanzasResumenData(pid) {
  const presupuestoTotal = await presupuestoTotalDe(pid);

  const { rows: ultimoRows } = await db.pool.query(`
    SELECT avance_financiero_real FROM avances_semanales
    WHERE project_id = $1 AND avance_financiero_real IS NOT NULL
    ORDER BY semana DESC LIMIT 1
  `, [pid]);
  const pctValorizado = ultimoRows[0] ? Number(ultimoRows[0].avance_financiero_real) : 0;
  const montoValorizado = Number((presupuestoTotal * (pctValorizado / 100)).toFixed(2));

  const { rows: comprasPagadoRows } = await db.pool.query(`
    SELECT COALESCE(SUM(p.monto), 0) AS total
    FROM pagos p
    JOIN ordenes_compra oc ON oc.id = p.orden_compra_id
    WHERE oc.project_id = $1 AND oc.estado != 'cancelada'
  `, [pid]);
  const comprasPagado = Number(comprasPagadoRows[0].total);

  // Comprometido: solo órdenes ya aceptadas por el proveedor (confirmada en
  // adelante) — 'enviada' aún no cuenta como compromiso real de dinero.
  const { rows: comprasComprometidoRows } = await db.pool.query(`
    SELECT oc.id,
           COALESCE(SUM(oci.importe), 0) AS importe_total,
           COALESCE((SELECT SUM(p.monto) FROM pagos p WHERE p.orden_compra_id = oc.id), 0) AS pagado
    FROM ordenes_compra oc
    LEFT JOIN orden_compra_items oci ON oci.orden_compra_id = oc.id
    WHERE oc.project_id = $1 AND oc.estado IN ('confirmada', 'recibida_parcial', 'recibida_completa')
    GROUP BY oc.id
  `, [pid]);
  const comprasComprometido = comprasComprometidoRows.reduce(
    (s, oc) => s + Math.max(0, Number(oc.importe_total) - Number(oc.pagado)), 0
  );

  const { rows: gastosPagadoRows } = await db.pool.query(
    "SELECT COALESCE(SUM(monto), 0) AS total FROM gastos_generales WHERE project_id = $1 AND estado = 'pagado'", [pid]
  );
  const gastosPagado = Number(gastosPagadoRows[0].total);

  const { rows: gastosPendienteRows } = await db.pool.query(
    "SELECT COALESCE(SUM(monto), 0) AS total FROM gastos_generales WHERE project_id = $1 AND estado = 'pendiente'", [pid]
  );
  const gastosPendiente = Number(gastosPendienteRows[0].total);

  // Destajo: costo de mano de obra realmente ejecutado (cantidad_ejecutada,
  // acumulada semana a semana en avance_destajo, × precio_destajo — el mismo
  // cálculo que ya usa la pestaña Destajo como "total_ganado"). No hay
  // distinción pagado/pendiente para destajo en el esquema actual, así que
  // se trata como pagado (mano de obra ya ejecutada = costo real incurrido).
  const { rows: destajoRows } = await db.pool.query(`
    SELECT COALESCE(SUM(ad.cantidad_ejecutada * di.precio_destajo), 0) AS total
    FROM destajo_items di
    JOIN avance_destajo ad ON ad.destajo_item_id = di.id
    WHERE di.project_id = $1
  `, [pid]);
  const destajoGanado = Number(destajoRows[0].total);

  // pagos.monto y orden_compra_items.precio_unitario se capturan con IVA
  // incluido (monto real pagado/cotizado), mientras que montoValorizado sale
  // de presupuestoTotal, que es sin IVA. Para que "Erogado Real" sea
  // comparable con "Avance Valorizado" se ajustan aquí SOLO estos dos montos
  // de compras a una base sin IVA (÷1.16) — nunca se toca lo guardado en
  // pagos ni orden_compra_items, que siguen representando el monto real con
  // IVA. gastos_generales queda fuera de este ajuste (fuera de alcance).
  const IVA_RATE = 0.16;
  const comprasPagadoSinIva = Number((comprasPagado / (1 + IVA_RATE)).toFixed(2));
  const comprasComprometidoSinIva = Number((comprasComprometido / (1 + IVA_RATE)).toFixed(2));

  const totalPagado = Number((comprasPagadoSinIva + gastosPagado + destajoGanado).toFixed(2));
  const totalComprometidoNoPagado = Number((comprasComprometidoSinIva + gastosPendiente).toFixed(2));
  const brechaMonto = Number((montoValorizado - totalPagado).toFixed(2));

  return {
    avance_valorizado: {
      pct: pctValorizado,
      monto: montoValorizado,
    },
    erogado_real: {
      compras_pagado: comprasPagadoSinIva,
      compras_pagado_con_iva: Number(comprasPagado.toFixed(2)),
      compras_comprometido: comprasComprometidoSinIva,
      compras_comprometido_con_iva: Number(comprasComprometido.toFixed(2)),
      gastos_generales_pagado: Number(gastosPagado.toFixed(2)),
      gastos_generales_pendiente: Number(gastosPendiente.toFixed(2)),
      destajo_ejecutado: Number(destajoGanado.toFixed(2)),
      total_pagado: totalPagado,
      total_comprometido_no_pagado: totalComprometidoNoPagado,
      iva_ajuste_pct: IVA_RATE * 100,
    },
    brecha: {
      monto: brechaMonto,
      descripcion: 'positivo = se ha avanzado más obra de la que se ha pagado; negativo = se ha pagado más de lo que refleja el avance reportado',
    },
    presupuesto_total: presupuestoTotal,
  };
}

app.get('/api/projects/:id/finanzas/resumen', h(auth.allow('tesoreria')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  res.json(await getFinanzasResumenData(req.project.id));
}));

app.get('/api/projects/:id/finanzas/export', h(auth.allow('tesoreria')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const [resumen, gastos] = await Promise.all([
    getFinanzasResumenData(req.project.id),
    getGastosData(req.project.id, req.query),
  ]);
  const av = resumen.avance_valorizado;
  const er = resumen.erogado_real;
  const resumenRows = [
    { concepto: 'Presupuesto total (sin IVA)', valor: resumen.presupuesto_total },
    { concepto: 'Avance Valorizado (%)', valor: av.pct },
    { concepto: 'Avance Valorizado (monto)', valor: av.monto },
    { concepto: 'Erogado Real — total pagado', valor: er.total_pagado },
    { concepto: 'Erogado Real — total comprometido (no pagado)', valor: er.total_comprometido_no_pagado },
    { concepto: 'Compras — pagado (sin IVA, ajustado)', valor: er.compras_pagado },
    { concepto: 'Compras — pagado (con IVA, real)', valor: er.compras_pagado_con_iva },
    { concepto: 'Compras — comprometido (sin IVA, ajustado)', valor: er.compras_comprometido },
    { concepto: 'Compras — comprometido (con IVA, real)', valor: er.compras_comprometido_con_iva },
    { concepto: 'Gastos generales — pagado', valor: er.gastos_generales_pagado },
    { concepto: 'Gastos generales — pendiente', valor: er.gastos_generales_pendiente },
    { concepto: 'Destajo — ejecutado (mano de obra)', valor: er.destajo_ejecutado },
    { concepto: 'Brecha (Avance Valorizado - Total pagado)', valor: resumen.brecha.monto },
  ];
  await sendXlsxExport(res, {
    filename: buildExportFilename('Finanzas', req.project.nombre),
    sheets: [
      {
        sheetName: 'Resumen',
        columns: [
          { header: 'Concepto', key: 'concepto', width: 44 },
          { header: 'Valor', key: 'valor', width: 20, format: 'money' },
        ],
        rows: resumenRows,
      },
      {
        sheetName: 'Gastos Generales',
        columns: [
          { header: 'Categoría', key: 'categoria', width: 18 },
          { header: 'Concepto', key: 'concepto', width: 30 },
          { header: 'Fecha', key: 'fecha', width: 14 },
          { header: 'Monto', key: 'monto', width: 16, format: 'money' },
          { header: 'Estado', key: 'estado', width: 14 },
          { header: 'Observaciones', key: 'observaciones', width: 30 },
        ],
        rows: gastos.map((g) => ({
          categoria: GASTO_CATEGORIA_LABELS[g.categoria] || g.categoria,
          concepto: g.concepto,
          fecha: g.fecha,
          monto: Number(g.monto),
          estado: g.estado,
          observaciones: g.observaciones || '',
        })),
      },
    ],
  });
}));

// ---------------------------------------------------------------------------
// Programa de ejecución
// ---------------------------------------------------------------------------
app.get('/api/projects/:id/programa', h(auth.allow('residente', 'cabo', 'compras', 'tesoreria', 'administracion', 'logistica')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { rows } = await db.pool.query(`
    SELECT pe.id, pe.codigo, pe.concepto, pe.grupo, pe.fecha_inicio, pe.fecha_fin,
           pe.duracion_dias, pe.importe, pe.peso_pct, pe.orden,
           CASE
             WHEN c.cantidad > 0 THEN
               LEAST(100.0, ROUND(CAST(COALESCE(SUM(ac.cantidad_ejecutada), 0) / c.cantidad * 100.0 AS NUMERIC), 1))
             ELSE 0
           END AS avance_pct
    FROM programa_ejecucion pe
    LEFT JOIN conceptos c
      ON c.codigo = pe.codigo
     AND (c.grupo = pe.grupo OR (c.grupo IS NULL AND pe.grupo IS NULL))
     AND c.project_id = pe.project_id
     AND c.es_total = 0 AND c.cantidad > 0
    LEFT JOIN avance_conceptos ac ON ac.concepto_id = c.id
    WHERE pe.project_id = $1
    GROUP BY pe.id, pe.codigo, pe.concepto, pe.grupo, pe.fecha_inicio, pe.fecha_fin,
             pe.duracion_dias, pe.importe, pe.peso_pct, pe.orden, c.cantidad
    ORDER BY pe.orden
  `, [req.project.id]);
  res.json(rows);
}));

app.put('/api/projects/:id/programa/:itemId', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const pid = req.project.id;
  const itemId = Number(req.params.itemId);
  const { rows: existRows } = await db.pool.query(
    'SELECT * FROM programa_ejecucion WHERE id = $1 AND project_id = $2',
    [itemId, pid]
  );
  if (!existRows[0]) return res.status(404).json({ error: 'Actividad del programa no encontrada' });

  const { fecha_inicio, fecha_fin } = req.body || {};
  if (!fecha_inicio || !fecha_fin) {
    return res.status(400).json({ error: 'Debes indicar fecha de inicio y fecha de fin' });
  }
  if (fecha_fin < fecha_inicio) {
    return res.status(400).json({ error: 'La fecha de fin no puede ser anterior a la fecha de inicio' });
  }
  const { rows: metaRows } = await db.pool.query('SELECT clave, valor FROM meta WHERE project_id = $1', [pid]);
  const meta = metaToObject(metaRows);
  if (meta.inicio_obra && fecha_inicio < meta.inicio_obra) {
    return res.status(400).json({ error: `La fecha de inicio no puede ser anterior al inicio de obra (${meta.inicio_obra})` });
  }
  if (meta.fin_obra && fecha_fin > meta.fin_obra) {
    return res.status(400).json({ error: `La fecha de fin no puede ser posterior al fin de obra (${meta.fin_obra})` });
  }
  const duracion_dias = Math.round((new Date(`${fecha_fin}T00:00:00`) - new Date(`${fecha_inicio}T00:00:00`)) / 86400000) + 1;
  const { rows } = await db.pool.query(
    'UPDATE programa_ejecucion SET fecha_inicio = $1, fecha_fin = $2, duracion_dias = $3 WHERE id = $4 RETURNING *',
    [fecha_inicio, fecha_fin, duracion_dias, itemId]
  );
  res.json(rows[0]);
}));

// ---------------------------------------------------------------------------
// Avances semanales
// ---------------------------------------------------------------------------
async function getAvancesData(pid) {
  const { rows } = await db.pool.query(
    'SELECT * FROM avances_semanales WHERE project_id = $1 ORDER BY semana',
    [pid]
  );
  return rows;
}

app.get('/api/projects/:id/avances', h(auth.allow('residente', 'cabo', 'logistica')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  res.json(await getAvancesData(req.project.id));
}));

app.get('/api/projects/:id/avances/export', h(auth.allow('residente', 'cabo', 'logistica')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const avances = await getAvancesData(req.project.id);
  const presupuestoTotal = await presupuestoTotalDe(req.project.id);
  // Misma fórmula que paintAvanceTable() en el frontend: importe del periodo =
  // presupuestoTotal * (delta de % programado acumulado vs la semana anterior).
  const rows = avances.map((a, idx) => {
    const prevPct = idx > 0 ? (avances[idx - 1].avance_financiero_programado || 0) : 0;
    const pctPeriodo = Math.max(0, (a.avance_financiero_programado || 0) - prevPct);
    return {
      semana: a.semana,
      fecha_inicio: a.fecha_inicio,
      fecha_fin: a.fecha_fin,
      presupuesto_periodo: Number((presupuestoTotal * (pctPeriodo / 100)).toFixed(2)),
      programado_acumulado: a.avance_financiero_programado != null ? Number(a.avance_financiero_programado) : null,
      fisico_real: a.avance_fisico_real != null ? Number(a.avance_fisico_real) : null,
      financiero_real: a.avance_financiero_real != null ? Number(a.avance_financiero_real) : null,
    };
  });
  await sendXlsxExport(res, {
    filename: buildExportFilename('Avance', req.project.nombre),
    sheets: [{
      sheetName: 'Avance semanal',
      columns: [
        { header: 'Semana', key: 'semana', width: 10, format: 'int' },
        { header: 'Fecha inicio', key: 'fecha_inicio', width: 14 },
        { header: 'Fecha fin', key: 'fecha_fin', width: 14 },
        { header: 'Presupuesto del periodo', key: 'presupuesto_periodo', width: 22, format: 'money' },
        { header: '% Programado acumulado', key: 'programado_acumulado', width: 20, format: 'pct' },
        { header: '% Físico real', key: 'fisico_real', width: 16, format: 'pct' },
        { header: '% Financiero real', key: 'financiero_real', width: 18, format: 'pct' },
      ],
      rows,
    }],
  });
}));

// Marca una captura (avance semanal o destajo) como pendiente de
// autorización cuando la toca alguien que no es admin; solo pide notificar
// la primera vez que entra a pendiente, no en cada guardado subsecuente
// mientras sigue pendiente (evita spam de notificaciones).
function calcularEstadoAutorizacion(estadoPrevio, actorEsAdmin) {
  if (actorEsAdmin) return { nuevoEstado: 'autorizado', notificar: false };
  return { nuevoEstado: 'pendiente_autorizacion', notificar: estadoPrevio !== 'pendiente_autorizacion' };
}

app.put('/api/projects/:id/avances/:semana', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const pid = req.project.id;
  const semana = Number(req.params.semana);
  const { rows: existRows } = await db.pool.query(
    'SELECT id, estado_autorizacion FROM avances_semanales WHERE project_id = $1 AND semana = $2',
    [pid, semana]
  );
  if (!existRows[0]) return res.status(404).json({ error: 'Semana no encontrada' });

  const clamp = (v) => (v == null || v === '' ? null : Math.max(0, Math.min(100, Number(v))));
  const { avance_fisico_real, avance_financiero_real } = req.body || {};
  const { nuevoEstado, notificar } = calcularEstadoAutorizacion(existRows[0].estado_autorizacion, req.user.puesto === 'admin');
  const { rows } = await db.pool.query(`
    UPDATE avances_semanales
    SET avance_fisico_real = COALESCE($1, avance_fisico_real),
        avance_financiero_real = COALESCE($2, avance_financiero_real),
        estado_autorizacion = $3
    WHERE project_id = $4 AND semana = $5
    RETURNING *
  `, [clamp(avance_fisico_real), clamp(avance_financiero_real), nuevoEstado, pid, semana]);

  if (notificar) {
    await notificarAdmins(pid, 'avance_pendiente', semana, `${req.user.nombre} reportó avance real de la semana ${semana} para autorización`);
  }
  res.json(rows[0]);
}));

app.put('/api/projects/:id/avances/:semana/autorizacion', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { estado } = req.body || {};
  if (!['autorizado', 'rechazado'].includes(estado)) {
    return res.status(400).json({ error: 'Estado inválido' });
  }
  const { rows } = await db.pool.query(
    'UPDATE avances_semanales SET estado_autorizacion = $1 WHERE project_id = $2 AND semana = $3 RETURNING *',
    [estado, req.project.id, Number(req.params.semana)]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Semana no encontrada' });
  res.json(rows[0]);
}));

async function presupuestoTotalDe(projectId) {
  const { rows: metaRows } = await db.pool.query('SELECT clave, valor FROM meta WHERE project_id = $1', [projectId]);
  const meta = metaToObject(metaRows);
  if (meta.total_sin_iva) return Number(meta.total_sin_iva);
  const { rows } = await db.pool.query(
    "SELECT importe FROM conceptos WHERE project_id = $1 AND es_total = 1 AND grupo IS NULL ORDER BY orden DESC LIMIT 1",
    [projectId]
  );
  return rows[0] ? rows[0].importe : 0;
}

app.get('/api/projects/:id/avances/:semana/conceptos', h(auth.allow('residente', 'cabo', 'logistica')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const pid = req.project.id;
  const semana = Number(req.params.semana);
  const { rows: existRows } = await db.pool.query(
    'SELECT id FROM avances_semanales WHERE project_id = $1 AND semana = $2',
    [pid, semana]
  );
  if (!existRows[0]) return res.status(404).json({ error: 'Semana no encontrada' });

  const { rows: conceptos } = await db.pool.query(`
    SELECT id AS concepto_id, codigo, concepto, unidad, grupo,
           cantidad AS cantidad_presupuesto, precio_unitario, importe AS importe_presupuesto
    FROM conceptos
    WHERE project_id = $1 AND es_total = 0 AND cantidad > 0 AND TRIM(COALESCE(unidad, '')) <> ''
    ORDER BY orden
  `, [pid]);

  const { rows: previos } = await db.pool.query(`
    SELECT ac.concepto_id, COALESCE(SUM(ac.cantidad_ejecutada), 0) AS total
    FROM avance_conceptos ac
    JOIN conceptos c ON c.id = ac.concepto_id
    WHERE c.project_id = $1 AND ac.semana < $2
    GROUP BY ac.concepto_id
  `, [pid, semana]);
  const acumPrevioMap = Object.fromEntries(previos.map((p) => [p.concepto_id, Number(p.total)]));

  const { rows: actuales } = await db.pool.query(`
    SELECT ac.concepto_id, ac.cantidad_ejecutada
    FROM avance_conceptos ac
    JOIN conceptos c ON c.id = ac.concepto_id
    WHERE c.project_id = $1 AND ac.semana = $2
  `, [pid, semana]);
  const actualMap = Object.fromEntries(actuales.map((a) => [a.concepto_id, a.cantidad_ejecutada]));

  const items = conceptos.map((c) => {
    const acumulada_previa = acumPrevioMap[c.concepto_id] || 0;
    const ejecutada_periodo = Object.prototype.hasOwnProperty.call(actualMap, c.concepto_id) ? actualMap[c.concepto_id] : null;
    const acumulada_actual = acumulada_previa + (ejecutada_periodo || 0);
    return {
      ...c,
      cantidad_acumulada_previa: acumulada_previa,
      cantidad_ejecutada_periodo: ejecutada_periodo,
      cantidad_acumulada_actual: acumulada_actual,
      importe_ejecutado_acumulado: acumulada_actual * c.precio_unitario,
    };
  });
  res.json({ semana, items });
}));

app.put('/api/projects/:id/avances/:semana/conceptos', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const pid = req.project.id;
  const semana = Number(req.params.semana);
  const { rows: existRows } = await db.pool.query(
    'SELECT id, estado_autorizacion FROM avances_semanales WHERE project_id = $1 AND semana = $2',
    [pid, semana]
  );
  if (!existRows[0]) return res.status(404).json({ error: 'Semana no encontrada' });

  const { items } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items debe ser un arreglo' });

  // Reject the entire batch if any concepto_id does not belong to this project (IDOR fix A2).
  const conceptoIds = [...new Set(items.map((it) => Number(it.concepto_id)).filter((id) => id > 0))];
  if (conceptoIds.length > 0) {
    const { rows: validConceptos } = await db.pool.query(
      'SELECT id FROM conceptos WHERE id = ANY($1) AND project_id = $2',
      [conceptoIds, pid]
    );
    if (validConceptos.length !== conceptoIds.length) {
      return res.status(400).json({ error: 'Uno o más conceptos no pertenecen a esta obra' });
    }
  }

  await db.withTransaction(async (client) => {
    for (const it of items) {
      const conceptoId = Number(it.concepto_id);
      if (!conceptoId) continue;
      const cantidad = it.cantidad_ejecutada == null || it.cantidad_ejecutada === ''
        ? 0 : Math.max(0, Number(it.cantidad_ejecutada));
      await client.query(`
        INSERT INTO avance_conceptos (semana, concepto_id, cantidad_ejecutada)
        VALUES ($1, $2, $3)
        ON CONFLICT (semana, concepto_id) DO UPDATE SET cantidad_ejecutada = EXCLUDED.cantidad_ejecutada, actualizado_en = NOW()
      `, [semana, conceptoId, cantidad]);
    }
  });

  const { nuevoEstado, notificar } = calcularEstadoAutorizacion(existRows[0].estado_autorizacion, req.user.puesto === 'admin');
  await db.pool.query('UPDATE avances_semanales SET estado_autorizacion = $1 WHERE project_id = $2 AND semana = $3', [nuevoEstado, pid, semana]);
  if (notificar) {
    await notificarAdmins(pid, 'avance_pendiente', semana, `${req.user.nombre} reportó avance real de la semana ${semana} para autorización`);
  }

  const totalPresupuesto = await presupuestoTotalDe(pid);
  let pctReal = null;
  if (totalPresupuesto > 0) {
    const { rows: acumRows } = await db.pool.query(`
      SELECT COALESCE(SUM(ac.cantidad_ejecutada * c.precio_unitario), 0) AS importe
      FROM avance_conceptos ac
      JOIN conceptos c ON c.id = ac.concepto_id
      WHERE c.project_id = $1 AND ac.semana <= $2
    `, [pid, semana]);
    pctReal = Math.max(0, Math.min(100, (Number(acumRows[0].importe) / totalPresupuesto) * 100));
    await db.pool.query(
      'UPDATE avances_semanales SET avance_fisico_real = $1, avance_financiero_real = $2 WHERE project_id = $3 AND semana = $4',
      [pctReal, pctReal, pid, semana]
    );
  }

  const { rows: detalle } = await db.pool.query(`
    SELECT ac.concepto_id, ac.cantidad_ejecutada
    FROM avance_conceptos ac
    JOIN conceptos c ON c.id = ac.concepto_id
    WHERE c.project_id = $1 AND ac.semana = $2
  `, [pid, semana]);
  const { rows: avRows } = await db.pool.query(
    'SELECT * FROM avances_semanales WHERE project_id = $1 AND semana = $2',
    [pid, semana]
  );
  res.json({ ok: true, semana, avance_calculado_pct: pctReal, avance: avRows[0], items: detalle });
}));

// ---------------------------------------------------------------------------
// Resumen / dashboard
// ---------------------------------------------------------------------------
app.get('/api/projects/:id/resumen', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const pid = req.project.id;
  const [{ rows: metaRows }, { rows: contratoRows }] = await Promise.all([
    db.pool.query('SELECT clave, valor FROM meta WHERE project_id = $1', [pid]),
    db.pool.query('SELECT id FROM contratos WHERE project_id = $1', [pid]),
  ]);
  const meta = metaToObject(metaRows);
  const { rows: totalRows } = await db.pool.query(
    "SELECT importe FROM conceptos WHERE project_id = $1 AND es_total = 1 AND grupo IS NULL ORDER BY orden DESC LIMIT 1",
    [pid]
  );
  const total = meta.total_sin_iva ? Number(meta.total_sin_iva) : (totalRows[0] ? totalRows[0].importe : 0);

  const { rows: ultimoRows } = await db.pool.query(`
    SELECT * FROM avances_semanales
    WHERE project_id = $1 AND avance_financiero_real IS NOT NULL
    ORDER BY semana DESC LIMIT 1
  `, [pid]);
  const ultimoAvance = ultimoRows[0];

  const hoy = new Date().toISOString().slice(0, 10);
  const { rows: semActualRows } = await db.pool.query(`
    SELECT * FROM avances_semanales WHERE project_id = $1 AND fecha_inicio <= $2 AND fecha_fin >= $2 ORDER BY semana LIMIT 1
  `, [pid, hoy]);
  const { rows: primerRows } = await db.pool.query(
    'SELECT * FROM avances_semanales WHERE project_id = $1 ORDER BY semana LIMIT 1', [pid]
  );
  const { rows: ultimaRows } = await db.pool.query(
    'SELECT * FROM avances_semanales WHERE project_id = $1 ORDER BY semana DESC LIMIT 1', [pid]
  );

  let programadoActual = semActualRows[0] || null;
  if (!programadoActual && primerRows[0] && hoy < primerRows[0].fecha_inicio) {
    programadoActual = { avance_financiero_programado: 0 };
  }
  if (!programadoActual && ultimaRows[0] && hoy > ultimaRows[0].fecha_fin) {
    programadoActual = ultimaRows[0];
  }

  const { rows: reqRows } = await db.pool.query(`
    SELECT COUNT(DISTINCT r.id) AS num_requisiciones,
           COALESCE(SUM(ri.importe), 0) AS importe_requisitado,
           COALESCE(SUM(ri.alerta_cantidad), 0) AS alertas_cantidad,
           COALESCE(SUM(ri.alerta_precio), 0) AS alertas_precio
    FROM requisiciones r
    LEFT JOIN requisicion_items ri ON ri.requisicion_id = r.id
    WHERE r.project_id = $1 AND r.estado != 'cancelada'
  `, [pid]);

  const pctEjecutado = ultimoAvance ? ultimoAvance.avance_financiero_real : 0;
  const pctProgramado = programadoActual ? programadoActual.avance_financiero_programado : 0;
  res.json({
    meta,
    tiene_contrato_pdf: contratoRows.length > 0,
    presupuesto_total: total,
    avance_financiero_programado_actual: pctProgramado,
    avance_financiero_ejecutado_actual: pctEjecutado,
    importe_ejecutado: Number((total * (pctEjecutado / 100)).toFixed(2)),
    importe_programado: Number((total * (pctProgramado / 100)).toFixed(2)),
    importe_por_ejecutar: Number((total * (1 - pctEjecutado / 100)).toFixed(2)),
    requisiciones: reqRows[0],
  });
}));

// ---------------------------------------------------------------------------
// Destajistas (piecework workers)
// ---------------------------------------------------------------------------
async function getDestajistasData(pid) {
  const { rows: dests } = await db.pool.query(
    'SELECT * FROM destajistas WHERE project_id = $1 ORDER BY orden, id',
    [pid]
  );
  return Promise.all(dests.map(async (d) => {
    const { rows: items } = await db.pool.query(`
      SELECT di.id, di.project_id, di.destajista_id, di.concepto_id, di.codigo, di.concepto, di.unidad,
             di.cantidad_asignada, di.precio_destajo, di.orden,
             c.grupo AS partida_grupo,
             c.codigo AS partida_codigo,
             c.concepto AS partida_concepto,
             c.cantidad AS partida_cantidad_presupuesto,
             c.precio_unitario AS partida_precio_unitario,
             COALESCE(ad.total, 0) AS cantidad_ejecutada
      FROM destajo_items di
      LEFT JOIN conceptos c ON c.id = di.concepto_id
      LEFT JOIN (SELECT destajo_item_id, SUM(cantidad_ejecutada) AS total FROM avance_destajo GROUP BY destajo_item_id) ad
        ON ad.destajo_item_id = di.id
      WHERE di.destajista_id = $1
      ORDER BY di.orden, di.id
    `, [d.id]);
    const totalAsignado = items.reduce((s, i) => s + (Number(i.cantidad_asignada) * Number(i.precio_destajo)), 0);
    const totalGanado = items.reduce((s, i) => s + (Number(i.cantidad_ejecutada) * Number(i.precio_destajo)), 0);
    const pctAvance = totalAsignado > 0 ? Math.min(100, (totalGanado / totalAsignado) * 100) : 0;
    return { ...d, items, total_asignado: totalAsignado, total_ganado: totalGanado, pct_avance: pctAvance };
  }));
}

app.get('/api/projects/:id/destajistas', h(auth.allow('residente', 'cabo', 'administracion')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  res.json(await getDestajistasData(req.project.id));
}));

app.get('/api/projects/:id/destajistas/export', h(auth.allow('residente', 'cabo', 'administracion')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const destajistas = await getDestajistasData(req.project.id);
  const rows = [];
  destajistas.forEach((d) => {
    d.items.forEach((it) => {
      rows.push({
        destajista: d.nombre,
        telefono: d.telefono || '',
        codigo: it.codigo || '',
        concepto: it.concepto,
        unidad: it.unidad || '',
        cantidad_asignada: Number(it.cantidad_asignada),
        precio_destajo: Number(it.precio_destajo),
        cantidad_ejecutada: Number(it.cantidad_ejecutada),
        importe_asignado: Number((Number(it.cantidad_asignada) * Number(it.precio_destajo)).toFixed(2)),
        importe_ganado: Number((Number(it.cantidad_ejecutada) * Number(it.precio_destajo)).toFixed(2)),
      });
    });
  });
  await sendXlsxExport(res, {
    filename: buildExportFilename('Destajo', req.project.nombre),
    sheets: [{
      sheetName: 'Destajo',
      columns: [
        { header: 'Destajista', key: 'destajista', width: 24 },
        { header: 'Teléfono', key: 'telefono', width: 16 },
        { header: 'Código', key: 'codigo', width: 14 },
        { header: 'Concepto', key: 'concepto', width: 40 },
        { header: 'Unidad', key: 'unidad', width: 10 },
        { header: 'Cantidad asignada', key: 'cantidad_asignada', width: 18, format: 'int' },
        { header: 'Precio destajo', key: 'precio_destajo', width: 16, format: 'money' },
        { header: 'Cantidad ejecutada', key: 'cantidad_ejecutada', width: 18, format: 'int' },
        { header: 'Importe asignado', key: 'importe_asignado', width: 18, format: 'money' },
        { header: 'Importe ganado', key: 'importe_ganado', width: 18, format: 'money' },
      ],
      rows,
    }],
  });
}));

app.post('/api/projects/:id/destajistas', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { nombre, telefono } = req.body || {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre del destajista es requerido' });
  const { rows } = await db.pool.query(
    'INSERT INTO destajistas (project_id, nombre, telefono) VALUES ($1, $2, $3) RETURNING *',
    [req.project.id, nombre.trim(), telefono?.trim() || null]
  );
  res.status(201).json(rows[0]);
}));

app.put('/api/projects/:id/destajistas/:destId', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { nombre, telefono } = req.body || {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre del destajista es requerido' });
  const { rows } = await db.pool.query(
    'UPDATE destajistas SET nombre = $1, telefono = $2 WHERE id = $3 AND project_id = $4 RETURNING *',
    [nombre.trim(), telefono?.trim() || null, Number(req.params.destId), req.project.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Destajista no encontrado' });
  res.json(rows[0]);
}));

app.delete('/api/projects/:id/destajistas/:destId', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { rowCount } = await db.pool.query(
    'DELETE FROM destajistas WHERE id = $1 AND project_id = $2',
    [Number(req.params.destId), req.project.id]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Destajista no encontrado' });
  res.json({ ok: true });
}));

app.post('/api/projects/:id/destajistas/:destId/items', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const pid = req.project.id;
  const destId = Number(req.params.destId);
  const { rows: destRows } = await db.pool.query(
    'SELECT id FROM destajistas WHERE id = $1 AND project_id = $2',
    [destId, pid]
  );
  if (!destRows[0]) return res.status(404).json({ error: 'Destajista no encontrado' });

  let { concepto_id, codigo, concepto, unidad, cantidad_asignada, precio_destajo } = req.body || {};
  if (!concepto?.trim()) return res.status(400).json({ error: 'El concepto es requerido' });

  if (concepto_id) {
    const { rows: cRows } = await db.pool.query(
      'SELECT codigo, concepto, unidad FROM conceptos WHERE id = $1 AND project_id = $2',
      [Number(concepto_id), pid]
    );
    if (cRows[0]) { codigo = cRows[0].codigo; concepto = cRows[0].concepto; unidad = cRows[0].unidad; }
  }

  const { rows } = await db.pool.query(
    `INSERT INTO destajo_items
       (project_id, destajista_id, concepto_id, codigo, concepto, unidad, cantidad_asignada, precio_destajo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [pid, destId, concepto_id ? Number(concepto_id) : null, codigo?.trim() || null, concepto.trim(),
     unidad?.trim() || null, Math.max(0, Number(cantidad_asignada) || 0), Math.max(0, Number(precio_destajo) || 0)]
  );
  res.status(201).json(rows[0]);
}));

app.put('/api/projects/:id/destajistas/:destId/items/:itemId', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const pid = req.project.id;
  const itemId = Number(req.params.itemId);
  const { cantidad_asignada, precio_destajo } = req.body || {};
  const { rows } = await db.pool.query(
    `UPDATE destajo_items
     SET cantidad_asignada = COALESCE($1, cantidad_asignada),
         precio_destajo    = COALESCE($2, precio_destajo)
     WHERE id = $3 AND project_id = $4
     RETURNING *`,
    [
      cantidad_asignada != null ? Math.max(0, Number(cantidad_asignada)) : null,
      precio_destajo    != null ? Math.max(0, Number(precio_destajo))    : null,
      itemId, pid,
    ]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Actividad no encontrada' });
  res.json(rows[0]);
}));

app.delete('/api/projects/:id/destajistas/:destId/items/:itemId', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { rowCount } = await db.pool.query(
    'DELETE FROM destajo_items WHERE id = $1 AND project_id = $2',
    [Number(req.params.itemId), req.project.id]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Actividad no encontrada' });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Avance de destajo por periodo — usa las mismas semanas del programa de obra
// (avances_semanales) para que el avance de cada destajista se capture en
// los mismos periodos que el resto del proyecto.
// ---------------------------------------------------------------------------
app.get('/api/projects/:id/destajistas/:destId/avance', h(auth.allow('residente', 'cabo', 'administracion')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const pid = req.project.id;
  const destId = Number(req.params.destId);
  const { rows: destRows } = await db.pool.query(
    'SELECT id, nombre FROM destajistas WHERE id = $1 AND project_id = $2',
    [destId, pid]
  );
  if (!destRows[0]) return res.status(404).json({ error: 'Destajista no encontrado' });

  const { rows: totalRows } = await db.pool.query(
    'SELECT COALESCE(SUM(cantidad_asignada * precio_destajo), 0) AS total FROM destajo_items WHERE destajista_id = $1',
    [destId]
  );
  const totalAsignado = Number(totalRows[0].total);

  const { rows: semanas } = await db.pool.query(`
    SELECT av.semana, av.fecha_inicio, av.fecha_fin,
           COALESCE(SUM(ad.cantidad_ejecutada * di.precio_destajo), 0) AS ganado_periodo,
           daa.estado_autorizacion
    FROM avances_semanales av
    LEFT JOIN destajo_items di ON di.destajista_id = $2
    LEFT JOIN avance_destajo ad ON ad.destajo_item_id = di.id AND ad.semana = av.semana
    LEFT JOIN destajo_avance_autorizacion daa ON daa.project_id = $1 AND daa.destajista_id = $2 AND daa.semana = av.semana
    WHERE av.project_id = $1
    GROUP BY av.semana, av.fecha_inicio, av.fecha_fin, daa.estado_autorizacion
    ORDER BY av.semana
  `, [pid, destId]);

  let acumulado = 0;
  const result = semanas.map((s) => {
    acumulado += Number(s.ganado_periodo);
    return {
      semana: s.semana,
      fecha_inicio: s.fecha_inicio,
      fecha_fin: s.fecha_fin,
      ganado_periodo: Number(s.ganado_periodo),
      ganado_acumulado: acumulado,
      pct_acumulado: totalAsignado > 0 ? Math.min(100, (acumulado / totalAsignado) * 100) : 0,
      estado_autorizacion: s.estado_autorizacion || null,
    };
  });

  res.json({ destajista_id: destId, total_asignado: totalAsignado, semanas: result });
}));

app.get('/api/projects/:id/destajistas/:destId/avance/:semana', h(auth.allow('residente', 'cabo', 'administracion')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const pid = req.project.id;
  const destId = Number(req.params.destId);
  const semana = Number(req.params.semana);
  const { rows: destRows } = await db.pool.query(
    'SELECT id, nombre FROM destajistas WHERE id = $1 AND project_id = $2',
    [destId, pid]
  );
  if (!destRows[0]) return res.status(404).json({ error: 'Destajista no encontrado' });
  const { rows: semRows } = await db.pool.query(
    'SELECT id, fecha_inicio, fecha_fin FROM avances_semanales WHERE project_id = $1 AND semana = $2',
    [pid, semana]
  );
  if (!semRows[0]) return res.status(404).json({ error: 'Semana no encontrada' });

  const { rows: items } = await db.pool.query(`
    SELECT di.id AS destajo_item_id, di.codigo, di.concepto, di.unidad, di.cantidad_asignada, di.precio_destajo,
           COALESCE(prev.total, 0) AS cantidad_acumulada_previa,
           cur.cantidad_ejecutada AS cantidad_ejecutada_periodo
    FROM destajo_items di
    LEFT JOIN (
      SELECT destajo_item_id, SUM(cantidad_ejecutada) AS total
      FROM avance_destajo WHERE semana < $2 GROUP BY destajo_item_id
    ) prev ON prev.destajo_item_id = di.id
    LEFT JOIN avance_destajo cur ON cur.destajo_item_id = di.id AND cur.semana = $2
    WHERE di.destajista_id = $1
    ORDER BY di.orden, di.id
  `, [destId, semana]);

  const { rows: autRows } = await db.pool.query(
    'SELECT estado_autorizacion FROM destajo_avance_autorizacion WHERE project_id = $1 AND destajista_id = $2 AND semana = $3',
    [pid, destId, semana]
  );

  res.json({ semana, destajista: destRows[0], periodo: semRows[0], items, estado_autorizacion: autRows[0] ? autRows[0].estado_autorizacion : null });
}));

app.put('/api/projects/:id/destajistas/:destId/avance/:semana/autorizacion', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { estado } = req.body || {};
  if (!['autorizado', 'rechazado'].includes(estado)) {
    return res.status(400).json({ error: 'Estado inválido' });
  }
  const destId = Number(req.params.destId);
  const semana = Number(req.params.semana);
  const { rows: destRows } = await db.pool.query('SELECT id FROM destajistas WHERE id = $1 AND project_id = $2', [destId, req.project.id]);
  if (!destRows[0]) return res.status(404).json({ error: 'Destajista no encontrado' });

  const { rows } = await db.pool.query(`
    INSERT INTO destajo_avance_autorizacion (project_id, destajista_id, semana, estado_autorizacion, autorizado_por, autorizado_en)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (project_id, destajista_id, semana)
    DO UPDATE SET estado_autorizacion = EXCLUDED.estado_autorizacion, autorizado_por = EXCLUDED.autorizado_por, autorizado_en = NOW(), actualizado_en = NOW()
    RETURNING *
  `, [req.project.id, destId, semana, estado, req.user.id]);
  res.json(rows[0]);
}));

app.put('/api/projects/:id/destajistas/:destId/avance/:semana', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const pid = req.project.id;
  const destId = Number(req.params.destId);
  const semana = Number(req.params.semana);
  const { rows: destRows } = await db.pool.query(
    'SELECT id FROM destajistas WHERE id = $1 AND project_id = $2',
    [destId, pid]
  );
  if (!destRows[0]) return res.status(404).json({ error: 'Destajista no encontrado' });
  const { rows: semRows } = await db.pool.query(
    'SELECT id FROM avances_semanales WHERE project_id = $1 AND semana = $2',
    [pid, semana]
  );
  if (!semRows[0]) return res.status(404).json({ error: 'Semana no encontrada' });

  const { items } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items debe ser un arreglo' });

  const { rows: validRows } = await db.pool.query('SELECT id FROM destajo_items WHERE destajista_id = $1', [destId]);
  const validIds = new Set(validRows.map((r) => r.id));

  // Editar un valor ya capturado en una semana requiere residente/admin — el
  // mismo patrón de permisos que usa Avance regular (auth.allow('residente'),
  // sin 'cabo') para su edición. La captura inicial (sin valor previo) sigue
  // abierta a 'cabo', que es el único puesto con acceso a esta pestaña.
  const { rows: existingRows } = await db.pool.query(
    'SELECT destajo_item_id, cantidad_ejecutada FROM avance_destajo WHERE semana = $1', [semana]
  );
  const existingMap = new Map(existingRows.map((r) => [r.destajo_item_id, Number(r.cantidad_ejecutada)]));
  const esCabo = req.user.puesto === 'cabo';

  let omitidos = 0;
  await db.withTransaction(async (client) => {
    for (const it of items) {
      const itemId = Number(it.destajo_item_id);
      if (!validIds.has(itemId)) continue;
      const cantidad = it.cantidad_ejecutada == null || it.cantidad_ejecutada === ''
        ? 0 : Math.max(0, Number(it.cantidad_ejecutada));
      if (esCabo && existingMap.has(itemId) && existingMap.get(itemId) !== cantidad) {
        omitidos++;
        continue;
      }
      await client.query(`
        INSERT INTO avance_destajo (semana, destajo_item_id, cantidad_ejecutada)
        VALUES ($1, $2, $3)
        ON CONFLICT (semana, destajo_item_id) DO UPDATE SET cantidad_ejecutada = EXCLUDED.cantidad_ejecutada, actualizado_en = NOW()
      `, [semana, itemId, cantidad]);
    }
  });

  const { rows: authRows } = await db.pool.query(
    'SELECT estado_autorizacion FROM destajo_avance_autorizacion WHERE project_id = $1 AND destajista_id = $2 AND semana = $3',
    [pid, destId, semana]
  );
  const { nuevoEstado, notificar } = calcularEstadoAutorizacion(authRows[0] ? authRows[0].estado_autorizacion : null, req.user.puesto === 'admin');
  await db.pool.query(`
    INSERT INTO destajo_avance_autorizacion (project_id, destajista_id, semana, estado_autorizacion)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (project_id, destajista_id, semana) DO UPDATE SET estado_autorizacion = EXCLUDED.estado_autorizacion, actualizado_en = NOW()
  `, [pid, destId, semana, nuevoEstado]);
  if (notificar) {
    const { rows: destInfo } = await db.pool.query('SELECT nombre FROM destajistas WHERE id = $1', [destId]);
    await notificarAdmins(pid, 'destajo_pendiente', destId, `${req.user.nombre} capturó avance de destajo (${destInfo[0].nombre}, semana ${semana}) para autorización`);
  }

  res.json({ ok: true, semana, omitidos });
}));

// ===========================================================================
// TRABAJADORES — catálogo formal por obra (solo Admin)
// ===========================================================================
const TIPOS_PAGO = ['jornal', 'destajo', 'mixto'];
const PERIODICIDADES = ['semanal', 'quincenal', 'mensual'];
const TIPOS_DOC = ['ine_frente', 'ine_reverso', 'curp_doc', 'comprobante_domicilio', 'otro'];

app.get('/api/projects/:id/trabajadores', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { activo } = req.query;
  let sql = `SELECT t.*, d.nombre AS destajista_nombre
             FROM trabajadores t
             LEFT JOIN destajistas d ON d.id = t.destajista_id
             WHERE t.project_id = $1`;
  const params = [req.project.id];
  if (activo === '1') { sql += ' AND t.activo = true'; }
  else if (activo === '0') { sql += ' AND t.activo = false'; }
  sql += ' ORDER BY t.orden, t.nombre';
  const { rows } = await db.pool.query(sql, params);
  res.json(rows);
}));

app.post('/api/projects/:id/trabajadores', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { nombre, puesto, tipo_pago, tarifa_jornal, periodicidad, curp, rfc, nss,
          telefono, direccion, contacto_emergencia, contacto_emergencia_nombre,
          contacto_emergencia_telefono, fecha_ingreso, destajista_id } = req.body || {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  if (!TIPOS_PAGO.includes(tipo_pago)) return res.status(400).json({ error: 'tipo_pago inválido' });
  if (!PERIODICIDADES.includes(periodicidad)) return res.status(400).json({ error: 'periodicidad inválida' });
  const destId = destajista_id ? Number(destajista_id) : null;
  if (destId) {
    const { rows: dRows } = await db.pool.query('SELECT id FROM destajistas WHERE id=$1 AND project_id=$2', [destId, req.project.id]);
    if (!dRows[0]) return res.status(400).json({ error: 'Destajista vinculado no pertenece a esta obra' });
  }
  const { rows } = await db.pool.query(`
    INSERT INTO trabajadores
      (project_id, destajista_id, nombre, puesto, tipo_pago, tarifa_jornal, periodicidad,
       curp, rfc, nss, telefono, direccion, contacto_emergencia,
       contacto_emergencia_nombre, contacto_emergencia_telefono, fecha_ingreso)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [req.project.id, destId, nombre.trim(), puesto?.trim()||null, tipo_pago,
     Math.max(0, Number(tarifa_jornal)||0), periodicidad,
     curp?.trim()||null, rfc?.trim()||null, nss?.trim()||null,
     telefono?.trim()||null, direccion?.trim()||null, contacto_emergencia?.trim()||null,
     contacto_emergencia_nombre?.trim()||null, contacto_emergencia_telefono?.trim()||null,
     fecha_ingreso||null]
  );
  res.status(201).json(rows[0]);
}));

app.put('/api/projects/:id/trabajadores/:wId', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const wId = Number(req.params.wId);
  const { nombre, puesto, tipo_pago, tarifa_jornal, periodicidad, curp, rfc, nss,
          telefono, direccion, contacto_emergencia, contacto_emergencia_nombre,
          contacto_emergencia_telefono, fecha_ingreso, destajista_id } = req.body || {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  if (!TIPOS_PAGO.includes(tipo_pago)) return res.status(400).json({ error: 'tipo_pago inválido' });
  if (!PERIODICIDADES.includes(periodicidad)) return res.status(400).json({ error: 'periodicidad inválida' });
  const destId = destajista_id ? Number(destajista_id) : null;
  if (destId) {
    const { rows: dRows } = await db.pool.query('SELECT id FROM destajistas WHERE id=$1 AND project_id=$2', [destId, req.project.id]);
    if (!dRows[0]) return res.status(400).json({ error: 'Destajista vinculado no pertenece a esta obra' });
  }
  const { rows } = await db.pool.query(`
    UPDATE trabajadores SET
      destajista_id=$1, nombre=$2, puesto=$3, tipo_pago=$4, tarifa_jornal=$5,
      periodicidad=$6, curp=$7, rfc=$8, nss=$9, telefono=$10, direccion=$11,
      contacto_emergencia=$12, contacto_emergencia_nombre=$13, contacto_emergencia_telefono=$14,
      fecha_ingreso=$15
    WHERE id=$16 AND project_id=$17 RETURNING *`,
    [destId, nombre.trim(), puesto?.trim()||null, tipo_pago,
     Math.max(0, Number(tarifa_jornal)||0), periodicidad,
     curp?.trim()||null, rfc?.trim()||null, nss?.trim()||null,
     telefono?.trim()||null, direccion?.trim()||null, contacto_emergencia?.trim()||null,
     contacto_emergencia_nombre?.trim()||null, contacto_emergencia_telefono?.trim()||null,
     fecha_ingreso||null, wId, req.project.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Trabajador no encontrado' });
  res.json(rows[0]);
}));

app.post('/api/projects/:id/trabajadores/:wId/baja', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const wId = Number(req.params.wId);
  const { motivo_baja, notas, fecha_baja } = req.body || {};
  const MOTIVOS = ['renuncia','despido_justificado','despido_injustificado','fin_obra','abandono','otro'];
  if (!MOTIVOS.includes(motivo_baja)) return res.status(400).json({ error: 'motivo_baja inválido' });
  if (motivo_baja === 'otro' && !notas?.trim()) return res.status(400).json({ error: 'Cuando el motivo es "otro", las notas son requeridas' });
  const fechaBaja = fecha_baja || null;
  const { rows } = await db.pool.query(
    `UPDATE trabajadores SET activo=false, fecha_baja=COALESCE($1::date, CURRENT_DATE), motivo_baja=$2
     WHERE id=$3 AND project_id=$4 AND activo=true RETURNING *`,
    [fechaBaja, motivo_baja, wId, req.project.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Trabajador no encontrado o ya dado de baja' });
  await db.pool.query(
    `INSERT INTO trabajador_bajas (trabajador_id, fecha_baja, motivo_baja, notas, registrado_por)
     VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5)`,
    [wId, fechaBaja, motivo_baja, notas?.trim()||null, req.user.id]
  );
  res.json(rows[0]);
}));

app.get('/api/projects/:id/trabajadores/:wId/bajas', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const wId = Number(req.params.wId);
  const { rows } = await db.pool.query(
    `SELECT b.*, u.nombre AS registrado_por_nombre
     FROM trabajador_bajas b LEFT JOIN usuarios u ON u.id = b.registrado_por
     WHERE b.trabajador_id = $1 ORDER BY b.created_at DESC`,
    [wId]
  );
  res.json(rows);
}));

app.post('/api/projects/:id/trabajadores/:wId/reactivar', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const wId = Number(req.params.wId);
  const { rows } = await db.pool.query(
    `UPDATE trabajadores SET activo=true, fecha_baja=NULL, motivo_baja=NULL
     WHERE id=$1 AND project_id=$2 AND activo=false RETURNING *`,
    [wId, req.project.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Trabajador no encontrado o ya activo' });
  res.json(rows[0]);
}));

app.delete('/api/projects/:id/trabajadores/:wId', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const wId = Number(req.params.wId);
  const { rows: trabRows } = await db.pool.query(
    'SELECT activo FROM trabajadores WHERE id=$1 AND project_id=$2',
    [wId, req.project.id]
  );
  if (!trabRows[0]) return res.status(404).json({ error: 'Trabajador no encontrado' });
  // Paso 1: debe estar previamente dado de baja
  if (trabRows[0].activo) return res.status(409).json({ error: 'Da de baja al trabajador antes de eliminarlo permanentemente' });
  // Paso 2: no debe tener ningún historial (asistencia ni nómina)
  // — asistencia_diaria tiene ON DELETE CASCADE, lo que borraría historia silenciosamente
  // — nomina_items no tiene ON DELETE, lo que lanzaría una FK violation (500) sin este guard
  const { rows: historial } = await db.pool.query(`
    SELECT 1 FROM asistencia_diaria WHERE trabajador_id=$1
    UNION ALL
    SELECT 1 FROM nomina_items     WHERE trabajador_id=$1
    LIMIT 1`,
    [wId]
  );
  if (historial.length) {
    return res.status(409).json({ error: 'No se puede eliminar: el trabajador tiene historial de asistencia o nómina registrado' });
  }
  // Sin historial: eliminar documentos del blob y luego el registro
  const { rows: docs } = await db.pool.query('SELECT blob_url FROM trabajador_documentos WHERE trabajador_id=$1', [wId]);
  await Promise.all(docs.map((d) => del(d.blob_url).catch(() => {})));
  const { rowCount } = await db.pool.query('DELETE FROM trabajadores WHERE id=$1 AND project_id=$2', [wId, req.project.id]);
  if (rowCount === 0) return res.status(404).json({ error: 'Trabajador no encontrado' });
  res.json({ ok: true });
}));

// --- Documentos de identidad (Vercel Blob privado) ---
app.post('/api/projects/:id/trabajadores/:wId/documentos/upload-token', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const wId = Number(req.params.wId);
  const { rows } = await db.pool.query('SELECT id FROM trabajadores WHERE id=$1 AND project_id=$2', [wId, req.project.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Trabajador no encontrado' });
  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        const ext = (pathname.split('.').pop() || '').toLowerCase();
        const allowed = ['jpg', 'jpeg', 'png', 'pdf', 'heic', 'webp'];
        if (!allowed.includes(ext)) throw new Error('Solo se admiten imágenes (JPG/PNG/HEIC/WEBP) o PDF');
        return {
          access: 'private',
          addRandomSuffix: true,
          maximumSizeInBytes: 15 * 1024 * 1024,
        };
      },
    });
    res.json(jsonResponse);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.post('/api/projects/:id/trabajadores/:wId/documentos', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const wId = Number(req.params.wId);
  const { tipo, nombre_archivo, blob_url } = req.body || {};
  if (!blob_url) return res.status(400).json({ error: 'blob_url es requerido' });
  if (!TIPOS_DOC.includes(tipo)) return res.status(400).json({ error: 'tipo de documento inválido' });
  const { rows: wRows } = await db.pool.query('SELECT id FROM trabajadores WHERE id=$1 AND project_id=$2', [wId, req.project.id]);
  if (!wRows[0]) return res.status(404).json({ error: 'Trabajador no encontrado' });
  const { rows } = await db.pool.query(
    'INSERT INTO trabajador_documentos (trabajador_id, tipo, nombre_archivo, blob_url, subido_por) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [wId, tipo, nombre_archivo?.trim()||'documento', blob_url, req.user.id]
  );
  res.status(201).json(rows[0]);
}));

app.get('/api/projects/:id/trabajadores/:wId/documentos', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const wId = Number(req.params.wId);
  const { rows } = await db.pool.query(
    'SELECT id, tipo, nombre_archivo, subido_en FROM trabajador_documentos WHERE trabajador_id=$1 ORDER BY subido_en DESC',
    [wId]
  );
  res.json(rows);
}));

app.get('/api/projects/:id/trabajadores/:wId/documentos/:docId/download', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const wId = Number(req.params.wId);
  const docId = Number(req.params.docId);
  const { rows } = await db.pool.query(
    'SELECT d.* FROM trabajador_documentos d JOIN trabajadores t ON t.id=d.trabajador_id WHERE d.id=$1 AND t.id=$2 AND t.project_id=$3',
    [docId, wId, req.project.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Documento no encontrado' });
  const blobResult = await get(rows[0].blob_url, { access: 'private' });
  if (!blobResult) return res.status(404).json({ error: 'Archivo no encontrado en almacenamiento' });
  const ext = (rows[0].nombre_archivo.split('.').pop() || 'bin').toLowerCase();
  const mimeMap = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', webp: 'image/webp' };
  res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${rows[0].nombre_archivo}"`);
  const { pipeline: pipe } = require('stream/promises');
  await pipe(Readable.fromWeb(blobResult.stream), res);
}));

app.delete('/api/projects/:id/trabajadores/:wId/documentos/:docId', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const wId = Number(req.params.wId);
  const docId = Number(req.params.docId);
  const { rows } = await db.pool.query(
    'SELECT d.blob_url FROM trabajador_documentos d JOIN trabajadores t ON t.id=d.trabajador_id WHERE d.id=$1 AND t.id=$2 AND t.project_id=$3',
    [docId, wId, req.project.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Documento no encontrado' });
  await del(rows[0].blob_url).catch(() => {});
  await db.pool.query('DELETE FROM trabajador_documentos WHERE id=$1', [docId]);
  res.json({ ok: true });
}));

// ===========================================================================
// CONTRATOS LABORALES POR TRABAJADOR
// ===========================================================================
app.post('/api/projects/:id/trabajadores/:wId/contratos/upload-token', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const wId = Number(req.params.wId);
  const { rows } = await db.pool.query('SELECT id FROM trabajadores WHERE id=$1 AND project_id=$2', [wId, req.project.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Trabajador no encontrado' });
  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        const ext = (pathname.split('.').pop() || '').toLowerCase();
        if (ext !== 'pdf') throw new Error('Solo se admiten archivos PDF');
        return { access: 'private', addRandomSuffix: true, maximumSizeInBytes: 20 * 1024 * 1024 };
      },
    });
    res.json(jsonResponse);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.post('/api/projects/:id/trabajadores/:wId/contratos', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const wId = Number(req.params.wId);
  const { tipo_contrato, fecha_inicio, fecha_fin, salario_diario, pdf_url, pdf_filename } = req.body || {};
  const TIPOS = ['obra_determinada','tiempo_determinado','tiempo_indeterminado'];
  if (!TIPOS.includes(tipo_contrato)) return res.status(400).json({ error: 'tipo_contrato inválido' });
  if (!fecha_inicio) return res.status(400).json({ error: 'fecha_inicio es requerida' });
  const { rows: wRows } = await db.pool.query('SELECT id FROM trabajadores WHERE id=$1 AND project_id=$2', [wId, req.project.id]);
  if (!wRows[0]) return res.status(404).json({ error: 'Trabajador no encontrado' });
  // Desactivar contrato anterior si existe
  await db.pool.query('UPDATE contratos_trabajador SET activo=false WHERE trabajador_id=$1 AND activo=true', [wId]);
  const { rows } = await db.pool.query(`
    INSERT INTO contratos_trabajador
      (trabajador_id, tipo_contrato, fecha_inicio, fecha_fin, salario_diario, pdf_url, pdf_filename, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [wId, tipo_contrato, fecha_inicio, fecha_fin||null,
     salario_diario ? Number(salario_diario) : null,
     pdf_url||null, pdf_filename?.trim()||null, req.user.id]
  );
  res.status(201).json(rows[0]);
}));

app.get('/api/projects/:id/trabajadores/:wId/contratos', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const wId = Number(req.params.wId);
  const { rows } = await db.pool.query(
    `SELECT c.*, u.nombre AS creado_por_nombre
     FROM contratos_trabajador c LEFT JOIN usuarios u ON u.id = c.created_by
     WHERE c.trabajador_id = $1 ORDER BY c.created_at DESC`,
    [wId]
  );
  res.json(rows);
}));

app.get('/api/projects/:id/trabajadores/:wId/contratos/:cId/download', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const wId = Number(req.params.wId);
  const cId = Number(req.params.cId);
  const { rows } = await db.pool.query(
    `SELECT c.pdf_url, c.pdf_filename FROM contratos_trabajador c
     JOIN trabajadores t ON t.id = c.trabajador_id
     WHERE c.id=$1 AND t.id=$2 AND t.project_id=$3`,
    [cId, wId, req.project.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Contrato no encontrado' });
  if (!rows[0].pdf_url) return res.status(404).json({ error: 'Este contrato no tiene PDF adjunto' });
  const blobResult = await get(rows[0].pdf_url, { access: 'private' });
  if (!blobResult) return res.status(404).json({ error: 'Archivo no encontrado en almacenamiento' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${rows[0].pdf_filename || 'contrato.pdf'}"`);
  const { pipeline: pipe } = require('stream/promises');
  await pipe(Readable.fromWeb(blobResult.stream), res);
}));

// ===========================================================================
// EPP — CATÁLOGO POR OBRA
// ===========================================================================
app.get('/api/projects/:id/epp-catalogo', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { soloActivos } = req.query;
  let sql = 'SELECT * FROM epp_catalogo WHERE project_id=$1';
  if (soloActivos === '1') sql += ' AND activo=true';
  sql += ' ORDER BY nombre_item';
  const { rows } = await db.pool.query(sql, [req.project.id]);
  res.json(rows);
}));

app.post('/api/projects/:id/epp-catalogo', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { nombre_item, descripcion } = req.body || {};
  if (!nombre_item?.trim()) return res.status(400).json({ error: 'nombre_item es requerido' });
  const { rows } = await db.pool.query(
    'INSERT INTO epp_catalogo (project_id, nombre_item, descripcion) VALUES ($1,$2,$3) RETURNING *',
    [req.project.id, nombre_item.trim(), descripcion?.trim()||null]
  );
  res.status(201).json(rows[0]);
}));

app.put('/api/projects/:id/epp-catalogo/:itemId', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const itemId = Number(req.params.itemId);
  const { nombre_item, descripcion, activo } = req.body || {};
  if (!nombre_item?.trim()) return res.status(400).json({ error: 'nombre_item es requerido' });
  const { rows } = await db.pool.query(
    `UPDATE epp_catalogo SET nombre_item=$1, descripcion=$2, activo=$3
     WHERE id=$4 AND project_id=$5 RETURNING *`,
    [nombre_item.trim(), descripcion?.trim()||null, activo !== false, itemId, req.project.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Ítem no encontrado' });
  res.json(rows[0]);
}));

// ===========================================================================
// EPP — ENTREGAS POR TRABAJADOR
// ===========================================================================
app.get('/api/projects/:id/trabajadores/:wId/epp-entregas', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const wId = Number(req.params.wId);
  const { rows } = await db.pool.query(
    `SELECT e.*, c.nombre_item, u.nombre AS entregado_por_nombre
     FROM epp_entregas e
     JOIN epp_catalogo c ON c.id = e.item_id
     LEFT JOIN usuarios u ON u.id = e.entregado_por
     WHERE e.trabajador_id = $1
     ORDER BY e.fecha_entrega DESC, e.created_at DESC`,
    [wId]
  );
  res.json(rows);
}));

app.post('/api/projects/:id/trabajadores/:wId/epp-entregas', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const wId = Number(req.params.wId);
  const { item_id, cantidad, fecha_entrega, firma_digital } = req.body || {};
  if (!item_id) return res.status(400).json({ error: 'item_id es requerido' });
  const { rows: wRows } = await db.pool.query('SELECT id FROM trabajadores WHERE id=$1 AND project_id=$2', [wId, req.project.id]);
  if (!wRows[0]) return res.status(404).json({ error: 'Trabajador no encontrado' });
  const { rows: cRows } = await db.pool.query(
    'SELECT id FROM epp_catalogo WHERE id=$1 AND project_id=$2 AND activo=true',
    [Number(item_id), req.project.id]
  );
  if (!cRows[0]) return res.status(400).json({ error: 'Ítem de EPP no encontrado o inactivo en esta obra' });
  const { rows } = await db.pool.query(
    `INSERT INTO epp_entregas (trabajador_id, item_id, cantidad, fecha_entrega, firma_digital, entregado_por)
     VALUES ($1,$2,$3,COALESCE($4::date, CURRENT_DATE),$5,$6) RETURNING *`,
    [wId, Number(item_id), Math.max(1, Number(cantidad)||1), fecha_entrega||null, firma_digital||null, req.user.id]
  );
  res.status(201).json(rows[0]);
}));

// ===========================================================================
// ASISTENCIA DIARIA
// ===========================================================================
app.get('/api/projects/:id/asistencia', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { fecha } = req.query;
  if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({ error: 'fecha requerida (YYYY-MM-DD)' });
  // Todos los trabajadores activos + su registro de asistencia para esa fecha
  const { rows } = await db.pool.query(`
    SELECT t.id, t.nombre, t.puesto, t.tipo_pago,
           COALESCE(a.estado, 'presente') AS estado,
           a.id AS asistencia_id
    FROM trabajadores t
    LEFT JOIN asistencia_diaria a ON a.trabajador_id = t.id AND a.project_id = $1 AND a.fecha = $2
    WHERE t.project_id = $1 AND t.activo = true
    ORDER BY t.orden, t.nombre`,
    [req.project.id, fecha]
  );
  res.json({ fecha, trabajadores: rows });
}));

app.put('/api/projects/:id/asistencia', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { fecha, asistencia } = req.body || {};
  if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({ error: 'fecha inválida' });
  if (!Array.isArray(asistencia)) return res.status(400).json({ error: 'asistencia debe ser un arreglo' });
  // Verificar que la fecha no caiga dentro de una nómina aprobada
  const { rows: bloqRows } = await db.pool.query(
    `SELECT id FROM nominas WHERE project_id=$1 AND estado='aprobada' AND fecha_inicio<=$2 AND fecha_fin>=$2`,
    [req.project.id, fecha]
  );
  if (bloqRows.length) return res.status(409).json({ error: 'Esta fecha está cubierta por una nómina aprobada y no puede modificarse' });

  const ESTADOS_ASIST = ['presente', 'falta_justificada', 'falta_injustificada'];
  await db.withTransaction(async (client) => {
    for (const item of asistencia) {
      const wId = Number(item.trabajador_id);
      const estado = ESTADOS_ASIST.includes(item.estado) ? item.estado : 'presente';
      const presente = estado === 'presente'; // columna legada, mantener sincronizada
      await client.query(`
        INSERT INTO asistencia_diaria (project_id, trabajador_id, fecha, presente, estado, capturado_por, actualizado_en)
        VALUES ($1,$2,$3,$4,$5,$6,NOW())
        ON CONFLICT (project_id, trabajador_id, fecha)
        DO UPDATE SET presente=EXCLUDED.presente, estado=EXCLUDED.estado,
                      capturado_por=EXCLUDED.capturado_por, actualizado_en=NOW()`,
        [req.project.id, wId, fecha, presente, estado, req.user.id]
      );
    }
  });
  res.json({ ok: true, fecha, guardados: asistencia.length });
}));

// ===========================================================================
// NÓMINAS
// ===========================================================================
const ESTADOS_NOMINA = ['borrador', 'revision', 'aprobada', 'rechazada'];

app.get('/api/projects/:id/nominas', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { rows } = await db.pool.query(`
    SELECT n.*,
           u.nombre AS aprobada_por_nombre,
           c.nombre AS creado_por_nombre,
           COUNT(ni.id)::int AS num_trabajadores,
           COALESCE(SUM(ni.monto_total), 0) AS total_nomina
    FROM nominas n
    LEFT JOIN usuarios u ON u.id = n.aprobada_por
    LEFT JOIN usuarios c ON c.id = n.creado_por
    LEFT JOIN nomina_items ni ON ni.nomina_id = n.id
    WHERE n.project_id = $1
    GROUP BY n.id, u.nombre, c.nombre
    ORDER BY n.fecha_inicio DESC`,
    [req.project.id]
  );
  res.json(rows);
}));

app.post('/api/projects/:id/nominas', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { fecha_inicio, fecha_fin } = req.body || {};
  if (!fecha_inicio || !fecha_fin) return res.status(400).json({ error: 'fecha_inicio y fecha_fin son requeridas' });
  if (fecha_inicio > fecha_fin) return res.status(400).json({ error: 'fecha_inicio debe ser anterior a fecha_fin' });
  // Evitar solapamiento con nóminas aprobadas existentes
  const { rows: solap } = await db.pool.query(
    `SELECT id FROM nominas WHERE project_id=$1 AND estado='aprobada' AND fecha_inicio<=$2 AND fecha_fin>=$3`,
    [req.project.id, fecha_fin, fecha_inicio]
  );
  if (solap.length) return res.status(409).json({ error: 'El periodo se solapa con una nómina ya aprobada' });
  const { rows } = await db.pool.query(
    'INSERT INTO nominas (project_id, fecha_inicio, fecha_fin, creado_por) VALUES ($1,$2,$3,$4) RETURNING *',
    [req.project.id, fecha_inicio, fecha_fin, req.user.id]
  );
  res.status(201).json(rows[0]);
}));

app.get('/api/projects/:id/nominas/:nomId', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const nomId = Number(req.params.nomId);
  const { rows: nomRows } = await db.pool.query(
    'SELECT n.*, u.nombre AS aprobada_por_nombre FROM nominas n LEFT JOIN usuarios u ON u.id=n.aprobada_por WHERE n.id=$1 AND n.project_id=$2',
    [nomId, req.project.id]
  );
  if (!nomRows[0]) return res.status(404).json({ error: 'Nómina no encontrada' });
  const { rows: items } = await db.pool.query(`
    SELECT ni.*, t.nombre AS trabajador_nombre, t.tipo_pago, t.tarifa_jornal, t.periodicidad
    FROM nomina_items ni
    JOIN trabajadores t ON t.id = ni.trabajador_id
    WHERE ni.nomina_id = $1
    ORDER BY t.nombre`,
    [nomId]
  );
  res.json({ ...nomRows[0], items });
}));

app.post('/api/projects/:id/nominas/:nomId/calcular', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const nomId = Number(req.params.nomId);
  const { rows: nomRows } = await db.pool.query(
    'SELECT * FROM nominas WHERE id=$1 AND project_id=$2',
    [nomId, req.project.id]
  );
  if (!nomRows[0]) return res.status(404).json({ error: 'Nómina no encontrada' });
  if (nomRows[0].estado === 'aprobada') return res.status(409).json({ error: 'No se puede recalcular una nómina aprobada' });
  const nom = nomRows[0];

  // Obtener todos los trabajadores activos (y los que ya tenían item aunque se hayan dado de baja)
  const { rows: trabajadores } = await db.pool.query(
    'SELECT * FROM trabajadores WHERE project_id=$1 AND activo=true ORDER BY nombre',
    [req.project.id]
  );

  // Solo 'presente' genera días pagados. Cambiar este literal para ajustar la regla.
  const ESTADO_PAGA = 'presente';
  // Días de asistencia por trabajador en el periodo
  const { rows: asistRows } = await db.pool.query(`
    SELECT trabajador_id, COUNT(*) FILTER (WHERE estado=$4)::int AS dias_presentes
    FROM asistencia_diaria
    WHERE project_id=$1 AND fecha>=$2 AND fecha<=$3
    GROUP BY trabajador_id`,
    [req.project.id, nom.fecha_inicio, nom.fecha_fin, ESTADO_PAGA]
  );
  const asistMap = new Map(asistRows.map((r) => [r.trabajador_id, r.dias_presentes]));

  // Destajo acumulado por trabajador (desde avance_destajo para semanas que solapan el periodo)
  const { rows: destajoRows } = await db.pool.query(`
    SELECT t.id AS trabajador_id, COALESCE(SUM(ad.cantidad_ejecutada * di.precio_destajo), 0) AS monto_destajo
    FROM trabajadores t
    JOIN destajistas dest ON dest.id = t.destajista_id
    JOIN destajo_items di ON di.destajista_id = dest.id
    JOIN avance_destajo ad ON ad.destajo_item_id = di.id
    JOIN avances_semanales av ON av.semana = ad.semana AND av.project_id = $1
    WHERE t.project_id = $1 AND t.id = ANY($4::int[])
      AND av.fecha_inicio <= $3 AND av.fecha_fin >= $2
    GROUP BY t.id`,
    [req.project.id, nom.fecha_inicio, nom.fecha_fin, trabajadores.map((t) => t.id)]
  );
  const destajoMap = new Map(destajoRows.map((r) => [r.trabajador_id, Number(r.monto_destajo)]));

  await db.withTransaction(async (client) => {
    // Eliminar items previos para recalcular limpio
    await client.query('DELETE FROM nomina_items WHERE nomina_id=$1', [nomId]);
    for (const t of trabajadores) {
      const dias = asistMap.get(t.id) || 0;
      const montoDest = (t.tipo_pago === 'destajo' || t.tipo_pago === 'mixto') ? (destajoMap.get(t.id) || 0) : 0;
      const montoJornal = (t.tipo_pago === 'jornal' || t.tipo_pago === 'mixto') ? dias * Number(t.tarifa_jornal) : 0;
      const total = montoJornal + montoDest;
      await client.query(`
        INSERT INTO nomina_items (nomina_id, trabajador_id, dias_trabajados, monto_jornal, monto_destajo, monto_total)
        VALUES ($1,$2,$3,$4,$5,$6)`,
        [nomId, t.id, dias, montoJornal, montoDest, total]
      );
    }
  });

  // Devolver nómina actualizada con items
  const { rows: updItems } = await db.pool.query(`
    SELECT ni.*, t.nombre AS trabajador_nombre, t.tipo_pago, t.tarifa_jornal
    FROM nomina_items ni JOIN trabajadores t ON t.id=ni.trabajador_id
    WHERE ni.nomina_id=$1 ORDER BY t.nombre`, [nomId]
  );
  res.json({ nomina: nomRows[0], items: updItems, total: updItems.reduce((s, i) => s + Number(i.monto_total), 0) });
}));

app.put('/api/projects/:id/nominas/:nomId/estado', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const nomId = Number(req.params.nomId);
  const { estado, nota_rechazo } = req.body || {};
  if (!ESTADOS_NOMINA.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
  const { rows: nomRows } = await db.pool.query('SELECT * FROM nominas WHERE id=$1 AND project_id=$2', [nomId, req.project.id]);
  if (!nomRows[0]) return res.status(404).json({ error: 'Nómina no encontrada' });
  const nom = nomRows[0];
  const esAdmin = req.user.puesto === 'admin';
  const esResidente = req.user.puesto === 'residente';

  // Máquina de estados y validación de rol
  const transicionesPermitidas = {
    borrador:  { revision: true },                    // residente o admin
    revision:  { aprobada: esAdmin, rechazada: esAdmin, borrador: esAdmin },
    rechazada: { borrador: true },                    // residente o admin
    aprobada:  { borrador: esAdmin },                 // solo admin puede reabrir
  };
  if (!transicionesPermitidas[nom.estado]?.[estado]) {
    return res.status(403).json({ error: `No puedes cambiar de '${nom.estado}' a '${estado}'` });
  }
  // Residente solo puede enviar a revisión o regresar de rechazada
  if (esResidente && !['revision'].includes(estado)) {
    return res.status(403).json({ error: 'Residente solo puede enviar la nómina a revisión' });
  }

  const aprobadaPor = estado === 'aprobada' ? req.user.id : null;
  const aprobadaEn = estado === 'aprobada' ? 'NOW()' : 'NULL';
  const { rows } = await db.pool.query(`
    UPDATE nominas SET estado=$1, nota_rechazo=$2,
      aprobada_por=${estado === 'aprobada' ? '$4' : 'NULL'},
      aprobada_en=${estado === 'aprobada' ? 'NOW()' : 'NULL'}
    WHERE id=$3 RETURNING *`,
    estado === 'aprobada'
      ? [estado, nota_rechazo?.trim()||null, nomId, aprobadaPor]
      : [estado, nota_rechazo?.trim()||null, nomId]
  );
  res.json(rows[0]);
}));

app.delete('/api/projects/:id/nominas/:nomId', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const nomId = Number(req.params.nomId);
  const { rows: nomRows } = await db.pool.query('SELECT estado FROM nominas WHERE id=$1 AND project_id=$2', [nomId, req.project.id]);
  if (!nomRows[0]) return res.status(404).json({ error: 'Nómina no encontrada' });
  if (nomRows[0].estado === 'aprobada') return res.status(409).json({ error: 'No se puede eliminar una nómina aprobada' });
  await db.pool.query('DELETE FROM nominas WHERE id=$1', [nomId]);
  res.json({ ok: true });
}));

app.get('/api/projects/:id/nominas/:nomId/export', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const nomId = Number(req.params.nomId);
  const { rows: nomRows } = await db.pool.query('SELECT * FROM nominas WHERE id=$1 AND project_id=$2', [nomId, req.project.id]);
  if (!nomRows[0]) return res.status(404).json({ error: 'Nómina no encontrada' });
  if (nomRows[0].estado !== 'aprobada') return res.status(409).json({ error: 'Solo se puede exportar una nómina aprobada' });
  const { rows: items } = await db.pool.query(`
    SELECT t.nombre AS trabajador, t.puesto, t.tipo_pago, t.periodicidad,
           ni.dias_trabajados, ni.monto_jornal, ni.monto_destajo, ni.monto_total
    FROM nomina_items ni JOIN trabajadores t ON t.id=ni.trabajador_id
    WHERE ni.nomina_id=$1 ORDER BY t.nombre`, [nomId]
  );
  const nom = nomRows[0];
  const filename = buildExportFilename(`Nomina_${nom.fecha_inicio}_${nom.fecha_fin}`, req.project.nombre);
  await sendXlsxExport(res, {
    filename,
    sheets: [{
      sheetName: 'Nómina',
      columns: [
        { header: 'Trabajador', key: 'trabajador', width: 30 },
        { header: 'Puesto', key: 'puesto', width: 20 },
        { header: 'Tipo pago', key: 'tipo_pago', width: 14 },
        { header: 'Periodicidad', key: 'periodicidad', width: 14 },
        { header: 'Días trabajados', key: 'dias_trabajados', width: 16, format: 'int' },
        { header: 'Monto jornal', key: 'monto_jornal', width: 16, format: 'money' },
        { header: 'Monto destajo', key: 'monto_destajo', width: 16, format: 'money' },
        { header: 'Total', key: 'monto_total', width: 16, format: 'money' },
      ],
      rows: items,
    }],
  });
}));

// ---------------------------------------------------------------------------
// Portal de sugerencias — envío (cualquier usuario autenticado) y gestión (admin)
// ---------------------------------------------------------------------------
app.post('/api/sugerencias', h(async (req, res) => {
  const { texto } = req.body || {};
  if (!texto?.trim()) return res.status(400).json({ error: 'El texto de la sugerencia es requerido' });
  if (texto.trim().length > 2000) return res.status(400).json({ error: 'La sugerencia no puede superar los 2 000 caracteres' });

  // Rate limiting: 5 sugerencias por hora por usuario
  const { rows: rlRows } = await db.pool.query(
    `SELECT COUNT(*)::int AS n FROM api_rate_limits
     WHERE usuario_id = $1 AND endpoint = 'sugerencias' AND creado_en > NOW() - INTERVAL '1 hour'`,
    [req.user.id]
  );
  if (rlRows[0].n >= 5) {
    return res.status(429).json({ error: 'Límite de sugerencias alcanzado (5 por hora). Inténtalo más tarde.' });
  }

  const { rows } = await db.pool.query(
    `INSERT INTO sugerencias (usuario_id, texto) VALUES ($1, $2) RETURNING *`,
    [req.user.id, texto.trim()]
  );
  await db.pool.query(
    `INSERT INTO api_rate_limits (usuario_id, endpoint) VALUES ($1, 'sugerencias')`,
    [req.user.id]
  );
  res.status(201).json(rows[0]);
}));

app.get('/api/sugerencias/mias', h(async (req, res) => {
  const { rows } = await db.pool.query(`
    SELECT s.*,
      COALESCE(
        (SELECT json_agg(json_build_object('id', i.id, 'blob_url', i.blob_url, 'nombre_archivo', i.nombre_archivo) ORDER BY i.creado_en)
         FROM sugerencia_imagenes i WHERE i.sugerencia_id = s.id),
        '[]'::json
      ) AS imagenes
    FROM sugerencias s WHERE s.usuario_id = $1 ORDER BY s.creado_en DESC`,
    [req.user.id]
  );
  res.json(rows);
}));

app.get('/api/sugerencias', h(auth.allow('desarrollador')), h(async (req, res) => {
  const { rows } = await db.pool.query(`
    SELECT s.*, u.nombre AS autor_nombre, u.puesto AS autor_puesto,
      COALESCE(
        (SELECT json_agg(json_build_object('id', i.id, 'blob_url', i.blob_url, 'nombre_archivo', i.nombre_archivo) ORDER BY i.creado_en)
         FROM sugerencia_imagenes i WHERE i.sugerencia_id = s.id),
        '[]'::json
      ) AS imagenes
    FROM sugerencias s
    JOIN usuarios u ON u.id = s.usuario_id
    ORDER BY s.creado_en DESC
  `);
  res.json(rows);
}));

app.patch('/api/sugerencias/:id', h(auth.allow('desarrollador')), h(async (req, res) => {
  const id = Number(req.params.id);
  const { estado } = req.body || {};
  const ESTADOS_VALIDOS = ['pendiente', 'revisada', 'implementada', 'descartada'];
  if (!ESTADOS_VALIDOS.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
  const { rows } = await db.pool.query(
    `UPDATE sugerencias SET estado = $1, actualizado_en = NOW() WHERE id = $2 RETURNING *`,
    [estado, id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Sugerencia no encontrada' });
  res.json(rows[0]);
}));

app.post('/api/sugerencias/:id/imagenes', uploadImg.single('imagen'), h(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió ninguna imagen' });
  const id = Number(req.params.id);
  const { rows: sugRows } = await db.pool.query(
    'SELECT usuario_id FROM sugerencias WHERE id = $1', [id]
  );
  if (!sugRows[0]) return res.status(404).json({ error: 'Sugerencia no encontrada' });
  const esAutor = sugRows[0].usuario_id === req.user.id;
  const esSuperUsuario = ['admin', 'desarrollador'].includes(req.user.puesto);
  if (!esAutor && !esSuperUsuario) return res.status(403).json({ error: 'No tienes permiso' });

  const { rows: countRows } = await db.pool.query(
    'SELECT COUNT(*)::int AS n FROM sugerencia_imagenes WHERE sugerencia_id = $1', [id]
  );
  if (countRows[0].n >= 5) {
    await fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: 'Máximo 5 imágenes por sugerencia' });
  }

  const fileBuffer = await fs.promises.readFile(req.file.path);
  await fs.promises.unlink(req.file.path).catch(() => {});
  const ext = path.extname(req.file.originalname).toLowerCase() || '.jpg';
  const blob = await put(`sugerencias/${id}/${Date.now()}${ext}`, fileBuffer, {
    access: 'public',
    contentType: req.file.mimetype || 'image/jpeg',
  });

  const { rows } = await db.pool.query(
    `INSERT INTO sugerencia_imagenes (sugerencia_id, blob_url, nombre_archivo)
     VALUES ($1, $2, $3) RETURNING *`,
    [id, blob.url, req.file.originalname]
  );
  res.status(201).json(rows[0]);
}));

app.post('/api/sugerencias/:id/generar-prompt', h(auth.allow('desarrollador')), h(async (req, res) => {
  const id = Number(req.params.id);
  const { rows: sugRows } = await db.pool.query(
    `SELECT s.*, u.nombre AS autor_nombre FROM sugerencias s
     JOIN usuarios u ON u.id = s.usuario_id WHERE s.id = $1`,
    [id]
  );
  if (!sugRows[0]) return res.status(404).json({ error: 'Sugerencia no encontrada' });
  const sug = sugRows[0];

  const anthropic = new Anthropic();
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: `Eres un asistente que convierte sugerencias de usuarios en prompts técnicos accionables para desarrolladores.

La app es "Control Presupuestal de Obra": sistema para gestionar presupuestos, avances semanales, requisiciones de insumos, órdenes de compra, nóminas y contratos de obras de construcción en México. Usa Express.js + PostgreSQL en el backend y vanilla JS (PWA) en el frontend.

Sugerencia del usuario "${sug.autor_nombre}":
"${sug.texto}"

Convierte esta sugerencia en un prompt técnico que un desarrollador pueda usar directamente. El prompt debe:
1. Describir QUÉ construir (funcionalidad específica)
2. Indicar en qué parte del sistema implementarlo (tabla DB, endpoint, función frontend)
3. Mencionar validaciones y casos borde importantes
4. Ser conciso y accionable (máx. 300 palabras)

Devuelve ÚNICAMENTE el prompt técnico, sin introducción ni cierre.`,
    }],
  });

  const promptGenerado = message.content[0].text;
  const { rows } = await db.pool.query(
    `UPDATE sugerencias SET prompt_generado = $1, actualizado_en = NOW() WHERE id = $2 RETURNING *`,
    [promptGenerado, id]
  );
  res.json(rows[0]);
}));

// ---------------------------------------------------------------------------
// Panel de desarrollador — stats del sistema (solo rol 'desarrollador', no admin)
// ---------------------------------------------------------------------------
const requireDesarrollador = (req, res, next) => {
  if (req.user?.puesto === 'desarrollador') return next();
  return res.status(403).json({ error: 'No tienes permiso para realizar esta acción' });
};

app.get('/api/admin/dev-info', requireDesarrollador, h(async (_req, res) => {
  const [usuarios, proyectos, clientes, sugerencias, contrato_pdfs] = await Promise.all([
    db.pool.query('SELECT COUNT(*)::int AS n FROM usuarios WHERE activo = true'),
    db.pool.query('SELECT COUNT(*)::int AS n FROM proyectos'),
    db.pool.query('SELECT COUNT(*)::int AS n FROM clientes'),
    db.pool.query(`SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE estado = 'pendiente')::int AS pendientes,
      COUNT(*) FILTER (WHERE prompt_generado IS NOT NULL)::int AS con_prompt
    FROM sugerencias`),
    db.pool.query('SELECT COUNT(*)::int AS n FROM contratos'),
  ]);
  res.json({
    usuarios_activos:    usuarios.rows[0].n,
    proyectos_total:     proyectos.rows[0].n,
    clientes_total:      clientes.rows[0].n,
    sugerencias_total:   sugerencias.rows[0].total,
    sugerencias_pend:    sugerencias.rows[0].pendientes,
    sugerencias_prompt:  sugerencias.rows[0].con_prompt,
    contratos_pdf:       contrato_pdfs.rows[0].n,
    node_version:        process.version,
    env:                 process.env.NODE_ENV || 'development',
  });
}));

// ---------------------------------------------------------------------------
app.get('/health', (_req, res) => res.json({ ok: true }));

// Global error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  // Los errores de PostgreSQL tienen la propiedad `severity` ('ERROR', 'FATAL', etc.).
  // Nunca exponemos el mensaje crudo de DB al cliente — puede filtrar nombres de
  // tablas, columnas o constraints. Los errores de validación (multer, negocio)
  // no tienen `severity` y sí muestran su mensaje.
  const message = err.severity ? 'Error interno del servidor' : (err.message || 'Error interno del servidor');
  res.status(err.status || 500).json({ error: message });
});

module.exports = app;
