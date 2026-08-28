'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const express = require('express');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const QRCode = require('qrcode');
const { del, get, put } = require('@vercel/blob');
const { handleUpload } = require('@vercel/blob/client');

// Sentry (observabilidad de errores backend) — inicializado solo si
// SENTRY_DSN está configurada; sin la key, Sentry.captureException() más
// abajo es un no-op seguro (no lanza, no bloquea nada). Paul debe crear la
// cuenta y agregar SENTRY_DSN a Vercel para activarlo (mismo patrón que el
// bloqueo actual de SMS/email 2FA con Resend/Twilio).
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV || 'development', tracesSampleRate: 0 });
}

// PostHog (analytics de backend) — mismo patrón que Sentry: sin
// POSTHOG_API_KEY, posthogClient queda null y trackServerEvent() es un
// no-op. Solo los 4 eventos del alcance de esta fase (screen_view se manda
// desde el frontend; login_success/login_failed/error_boundary se mandan
// desde aquí porque el backend es la fuente de verdad de esos 3).
const { PostHog } = require('posthog-node');
const posthogClient = process.env.POSTHOG_API_KEY
  ? new PostHog(process.env.POSTHOG_API_KEY, { host: process.env.POSTHOG_HOST || 'https://app.posthog.com' })
  : null;
function trackServerEvent(distinctId, event, properties = {}) {
  if (!posthogClient) return;
  try { posthogClient.capture({ distinctId: String(distinctId), event, properties }); } catch (_) { /* best-effort */ }
}

const db = require('./db');
const { parseWorkbook } = require('./parser');
const { ingest } = require('./ingest');
const { parseArchivo4Hojas, resumenParaPreview } = require('./crearPresupuestoImport');
const { generatePlanning } = require('./planning');
const auth = require('./auth');
const { sendXlsxExport, buildExportFilename } = require('./exportHelper');
const { sendMatricesNeodataExport } = require('./matricesNeodataExport');
const matricesImport = require('./matricesImport');
const reprocesoDestajoMatrices = require('./reprocesoDestajoMatrices');
const { extraerDatosContrato, CAMPOS_CONTRATO } = require('./extraccionContrato');
const { crearNotificacion, notificarAdmins, CATEGORIAS_NOTIFICACION, TODOS_LOS_TIPOS, ROLES_POR_TIPO } = require('./notificaciones');
const { buildEstimacionPdf } = require('./estimacionesPdf');
const { buildNominaReporteSemanalPdf } = require('./nominaReporteSemanalPdf');
const { calcularDiasRestantes, determinarUmbral, construirMensaje } = require('./alertasContrato');
const cumplimiento = require('./cumplimiento');
const maquinaria = require('./maquinaria');
const cotizador = require('./cotizador');
const {
  metaToObject, presupuestoTotalDe, getFinanzasResumenData, getCompromisosAbiertosData,
  getCompromisosAbiertosAgregado,
  porcentajeFondoGarantiaDe, getFondoGarantiaData, getFondoGarantiaAgregado,
  upsertPorcentajeFondoGarantia,
  FONDO_GARANTIA_PCT_MIN, FONDO_GARANTIA_PCT_MAX,
} = require('./finanzas');
const { calcularJornal, calcularDestajo, totalConIvaDeItems, totalConIvaEsValido, numeroALetra, calcularSplitCuentas, distribuirDestajoGrupo } = require('./calculos');
const { validarClabe } = require('./catalogoBancos');
const estadoResultados = require('./estadoResultados');
const contabilidad = require('./contabilidad');
const { extraerDatosCFDI, extraerDatosCFDIDesdePdf } = require('./cfdiParser');
const { parseMovimientosBancarios } = require('./movimientosBancariosParser');
const { emparejarConceptos, calcularCambios, aplicarCambiosConceptos } = require('./reintegracionPresupuesto');
const ordenesCambio = require('./ordenesCambio');
const lotes = require('./lotes');
const modelosVivienda = require('./modelosVivienda');
const ventas = require('./ventas');

// CN-007: nombre_archivo/pdf_filename vienen del cliente (upload); una comilla
// doble en el valor rompe fuera del filename="..." y permite inyectar
// parámetros extra en el header Content-Disposition. Quita comillas/backslash
// antes de interpolar — no rechaza la request, solo neutraliza el caracter.
function safeContentDisposition(type, filename) {
  const clean = String(filename || 'archivo').replace(/["\\]/g, '');
  return `${type}; filename="${clean}"`;
}

const app = express();

app.use(express.json({ limit: '2mb' }));

// Cabeceras de seguridad (sin dependencia nueva) — antes de express.static para que
// también apliquen a archivos servidos directamente (HTML, JS, CSS, sw.js, manifest).
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // CSP: todo local, sin CDNs. Vercel Blob necesita connect-src para uploads del cliente.
  // En producción, vercel.json sirve los archivos estáticos directamente (bypass de
  // este middleware) y define ahí la MISMA política — mantener ambas en sync a mano.
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:", // data: para <img> de firma digital EPP (base64 inline, no un archivo)
      "connect-src 'self' https://*.vercel-storage.com https://vercel.com",
      "worker-src 'self'",
      "manifest-src 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ')
  );
  // HSTS: 1 semana inicial; subir a 1 año después de confirmar en producción sin problemas.
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=604800; includeSubDomains');
  }
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));

// Verifica magic bytes del archivo temporal para detectar extensiones falsas.
// Lee solo los primeros bytes — no carga el archivo completo en memoria.
// BUF_LEN=64 (antes 12): XML no tiene magic bytes binarios fijos como los
// demás tipos — hay que leer texto suficiente para encontrar '<?xml' o
// '<cfdi:Comprobante' después de un BOM UTF-8 opcional (prompt-contabilidad-
// fase2-cfdi.md, punto 5b). 64 bytes cubre eso con margen sin costo real
// (siguen siendo unos cuantos bytes por archivo).
const MAGIC_BUF_LEN = 64;
async function checkFileMagic(filepath, allowedTypes) {
  const buf = Buffer.alloc(MAGIC_BUF_LEN);
  const fd = await fs.promises.open(filepath, 'r');
  let bytesRead = 0;
  try { ({ bytesRead } = await fd.read(buf, 0, MAGIC_BUF_LEN, 0)); } finally { await fd.close(); }
  for (const type of allowedTypes) {
    if (type === 'pdf'  && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return true;
    if (type === 'jpeg' && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;
    if (type === 'png'  && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true;
    if (type === 'gif'  && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return true;
    if (type === 'webp' && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
                           buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
    if (type === 'xml') {
      let texto = buf.slice(0, bytesRead).toString('utf8');
      if (texto.charCodeAt(0) === 0xFEFF) texto = texto.slice(1);
      texto = texto.trimStart();
      if (texto.startsWith('<?xml') || /^<[a-zA-Z0-9_]*:?Comprobante\b/.test(texto)) return true;
    }
  }
  return false;
}

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

// Multer para CFDI (Contabilidad Fase 2) — dos campos opcionales, 'xml' y
// 'pdf' (representación impresa); el endpoint exige al menos uno de los dos.
// Un CFDI XML pesa típicamente unos KB, pero se deja el mismo límite que
// otros PDFs del proyecto por generosidad, no por necesidad real.
const uploadCfdi = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(xml|pdf)$/i.test(file.originalname);
    cb(ok ? null : new Error('Solo se admiten archivos .xml o .pdf'), ok);
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

// Emite la sesión completa (access token + refresh cookie) una vez pasado el
// 2° factor (o durante enroll-confirm). Mismo shape que el login pre-2FA;
// `extra` permite añadir campos puntuales (ej. backupCodes, solo en enroll).
// avisoNovedades se calcula SIEMPRE aquí (no vía `extra`) — mismo punto de
// disparo en los 4 call-sites de issueFullSession, ninguno se puede olvidar
// de pasarlo (prompt-16-novedades-changelog.md, getAvisoNovedades más abajo).
async function issueFullSession(res, user, extra = {}) {
  trackServerEvent(user.id, 'login_success', { puesto: user.puesto });
  const token = auth.signToken(user);
  const refreshToken = auth.signRefreshToken(user);
  res.setHeader('Set-Cookie', auth.buildRefreshCookie(refreshToken));
  res.json({
    token,
    user: { id: user.id, nombre: user.nombre, usuario: user.usuario, puesto: user.puesto, totp_enabled: !!user.totp_enabled, solicitud_eliminacion_datos: !!user.solicitud_eliminacion_datos },
    tabs: auth.tabsParaUsuario(user),
    must_change_password: user.must_change_password || false,
    avisoNovedades: await getAvisoNovedades(user.id),
    ...extra,
  });
}

// 2FA opcional (julio 2026, ver CLAUDE.md): un usuario sin TOTP inscrito ya no
// se bloquea, pero se le recuerda cada 3+ días vía banner no intrusivo en
// Inicio. true si no tiene TOTP Y (nunca se le mostró O pasaron 3+ días).
const TOTP_REMINDER_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;
function shouldShowTotpReminder(user) {
  if (user.totp_enabled) return false;
  if (!user.totp_reminder_last_shown_at) return true;
  return Date.now() - new Date(user.totp_reminder_last_shown_at).getTime() >= TOTP_REMINDER_INTERVAL_MS;
}

// ---------------------------------------------------------------------------
// Autenticación (pública) — a partir de aquí, todo /api/* exige sesión
// ---------------------------------------------------------------------------
app.post('/api/auth/login', h(async (req, res) => {
  const { usuario, password } = req.body || {};
  if (!usuario?.trim() || !password) {
    return res.status(400).json({ error: 'Indica usuario y contraseña' });
  }

  const ip = auth.getIp(req);
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
    // distinctId = identificador escrito (no hay usuario_id confiable en un
    // login fallido — pudo ni existir la cuenta) — sin PII más allá del
    // usuario mismo, que ya es el identificador de negocio de este evento.
    trackServerEvent(ident, 'login_failed', {});
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }

  // 2FA opcional (julio 2026, ver CLAUDE.md): un usuario sin TOTP inscrito ya
  // no se bloquea en el login — entra directo. Si está inscrito, sigue exactamente
  // igual que antes: se le exige el 2° factor.
  if (!user.totp_enabled) {
    return await issueFullSession(res, user, { needsTotpReminder: shouldShowTotpReminder(user) });
  }

  return res.json({ requiresTotp: true, preAuthToken: auth.signPreAuthToken(user, { enroll: false }) });
}));

// Rate limiting de intentos de código TOTP: reutiliza api_rate_limits (mismo
// mecanismo que otros endpoints), solo cuenta FALLOS — un intento correcto no
// cuenta contra el límite. 5 fallos en 15 minutos por usuario.
const TOTP_RATE_LIMIT = 5;
async function checkTotpRateLimit(usuarioId) {
  const { rows } = await db.pool.query(
    `SELECT COUNT(*)::int AS n FROM api_rate_limits
     WHERE usuario_id = $1 AND endpoint = 'totp_verify'
       AND creado_en > NOW() - INTERVAL '15 minutes'`,
    [usuarioId]
  );
  return rows[0].n < TOTP_RATE_LIMIT;
}
async function registerTotpFailure(usuarioId) {
  await db.pool.query(`INSERT INTO api_rate_limits (usuario_id, endpoint) VALUES ($1, 'totp_verify')`, [usuarioId]);
}

// Confirma la inscripción TOTP forzada: valida el código contra el secret
// pendiente, activa totp_enabled, genera los backup codes (se devuelven en
// claro UNA SOLA VEZ aquí) y recién entonces emite la sesión completa.
app.post('/api/auth/totp/enroll-confirm', h(async (req, res) => {
  const { preAuthToken, code } = req.body || {};
  let decoded;
  try {
    decoded = auth.verifyPreAuthToken(preAuthToken);
  } catch {
    return res.status(401).json({ error: 'Token de verificación inválido o expirado, inicia sesión de nuevo' });
  }
  if (!decoded.enroll) return res.status(400).json({ error: 'Esta cuenta ya está inscrita en 2FA' });

  if (!(await checkTotpRateLimit(decoded.id))) {
    return res.status(429).json({ error: 'Demasiados intentos fallidos. Espera 15 minutos e intenta de nuevo.' });
  }

  const { rows } = await db.pool.query('SELECT * FROM usuarios WHERE id = $1 AND activo = true', [decoded.id]);
  const user = rows[0];
  if (!user || !user.totp_secret) return res.status(401).json({ error: 'Sesión inválida, inicia sesión de nuevo' });

  let secretBase32;
  try {
    secretBase32 = auth.decryptTotpSecret(user.totp_secret);
  } catch {
    // Secret indescifrable con la TOTP_ENC_KEY actual (irrecuperable). Limpiarlo
    // para que el próximo /login genere uno nuevo en vez de repetir el mismo error.
    await db.pool.query('UPDATE usuarios SET totp_secret = NULL WHERE id = $1', [user.id]);
    return res.status(401).json({ error: 'No se pudo verificar el código, inicia sesión de nuevo para generar un QR nuevo' });
  }
  if (!auth.verifyTotpCode(secretBase32, code)) {
    await registerTotpFailure(user.id);
    return res.status(401).json({ error: 'Código incorrecto' });
  }

  const { plain: backupCodes, hashed } = await auth.generateBackupCodes(10);
  await db.pool.query(
    // totp_reminder_last_shown_at = NULL: ya está inscrito, el banner de
    // recordatorio no tiene nada más que recordarle.
    'UPDATE usuarios SET totp_enabled = true, totp_backup_codes = $1, totp_reminder_last_shown_at = NULL WHERE id = $2',
    [JSON.stringify(hashed), user.id]
  );

  await issueFullSession(res, { ...user, totp_enabled: true }, { backupCodes });
}));

// Verifica el 2° factor en un login normal (usuario ya inscrito): código TOTP
// de 6 dígitos, o un código de respaldo de un solo uso como alternativa.
app.post('/api/auth/totp/verify', h(async (req, res) => {
  const { preAuthToken, code, backupCode } = req.body || {};
  let decoded;
  try {
    decoded = auth.verifyPreAuthToken(preAuthToken);
  } catch {
    return res.status(401).json({ error: 'Token de verificación inválido o expirado, inicia sesión de nuevo' });
  }
  if (decoded.enroll) return res.status(400).json({ error: 'Esta cuenta todavía no completó su inscripción a 2FA' });

  if (!(await checkTotpRateLimit(decoded.id))) {
    return res.status(429).json({ error: 'Demasiados intentos fallidos. Espera 15 minutos e intenta de nuevo.' });
  }

  const { rows } = await db.pool.query('SELECT * FROM usuarios WHERE id = $1 AND activo = true', [decoded.id]);
  const user = rows[0];
  if (!user || !user.totp_enabled || !user.totp_secret) return res.status(401).json({ error: 'Sesión inválida, inicia sesión de nuevo' });

  if (backupCode) {
    const idx = await auth.findBackupCodeIndex(backupCode, user.totp_backup_codes || []);
    if (idx === -1) {
      await registerTotpFailure(user.id);
      return res.status(401).json({ error: 'Código de respaldo inválido o ya usado' });
    }
    const updated = [...user.totp_backup_codes];
    updated[idx] = { ...updated[idx], used: true };
    await db.pool.query('UPDATE usuarios SET totp_backup_codes = $1 WHERE id = $2', [JSON.stringify(updated), user.id]);
    return await issueFullSession(res, user);
  }

  let secretBase32;
  try {
    secretBase32 = auth.decryptTotpSecret(user.totp_secret);
  } catch (err) {
    // Cuenta ya inscrita con un secret indescifrable (TOTP_ENC_KEY no coincide
    // con la que lo cifró). No hay código que vaya a funcionar nunca — no lo
    // tratamos como "código incorrecto" para no hacer reintentar en vano, y no
    // lo limpiamos solos (eso desactivaría 2FA sin verificar identidad primero,
    // ver Forbidden Actions del prompt de 2FA). Requiere scripts/emergency-totp-reset.js.
    console.error(`totp_secret indescifrable para usuario id=${user.id} (${user.usuario}):`, err.message);
    return res.status(401).json({ error: 'No se pudo verificar tu código. Usa un código de respaldo o contacta a un administrador para reiniciar tu 2FA.' });
  }
  if (!auth.verifyTotpCode(secretBase32, code)) {
    await registerTotpFailure(user.id);
    return res.status(401).json({ error: 'Código incorrecto' });
  }
  await issueFullSession(res, user);
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
    // prompt-b-notificaciones-imss-solo-admin.md: este recordatorio debe
    // llegar SOLO a admin/desarrollador, nunca a residente (bug confirmado
    // con notificaciones reales en producción: 3 de 17 habían llegado a
    // residente vía un loop explícito que consultaba usuario_proyectos —
    // eliminado). No se usa notificarAdmins() aquí porque esa función es
    // compartida con otros crons/flujos (requisición, OC, avance, destajo,
    // estimación, vencimiento de contrato) y solo filtra 'admin' — tocarla
    // habría afectado esos otros flujos y seguiría sin incluir
    // desarrollador. Consulta acotada a este endpoint, reutilizando
    // crearNotificacion (mismo patrón ya usado en Maquinaria, PR #53).
    const { rows: destinatarios } = await db.pool.query(
      "SELECT id FROM usuarios WHERE puesto IN ('admin', 'desarrollador') AND activo = true"
    );
    for (const d of destinatarios) {
      await crearNotificacion(d.id, p.id, 'recordatorio_impuestos', insertados[0].id, mensaje);
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
app.get('/api/cron/alertas-vencimiento', requireCronSecret, h(async (req, res) => {
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

  // Documentos de proveedores (prompt-cumplimiento-subcontratistas.md) —
  // misma corrida diaria, no un 4° cron (extiende el existente a propósito).
  // Aditivo: el loop de proyectos de arriba queda intacto, sin tocar su
  // comportamiento — solo se agrega este bloque después y campos nuevos en
  // la respuesta (nunca se quitan/renombran los que ya había).
  const { rows: docsConFecha } = await db.pool.query(`
    SELECT pd.id, pd.proveedor_id, pd.tipo, pd.fecha_vencimiento, pd.subido_en, p.nombre AS proveedor_nombre
    FROM proveedor_documentos pd
    JOIN proveedores p ON p.id = pd.proveedor_id
    WHERE p.activo = 1 AND pd.fecha_vencimiento IS NOT NULL
  `);
  const porProveedorTipo = new Map();
  for (const doc of docsConFecha) {
    const key = `${doc.proveedor_id}::${doc.tipo}`;
    if (!porProveedorTipo.has(key)) porProveedorTipo.set(key, []);
    porProveedorTipo.get(key).push(doc);
  }

  const alertasDocumentosEnviadas = [];
  for (const filas of porProveedorTipo.values()) {
    const vigente = cumplimiento.elegirVigente(filas);
    if (!vigente || !vigente.fecha_vencimiento) continue;
    const info = cumplimiento.getTipoInfo(vigente.tipo);
    const umbrales = info ? info.umbrales : undefined;

    const diasRestantes = calcularDiasRestantes(vigente.fecha_vencimiento);
    if (diasRestantes === null) continue;

    const { rows: vencidoRows } = await db.pool.query(
      "SELECT 1 FROM alertas_documentos_enviadas WHERE proveedor_documento_id = $1 AND umbral = 'vencido'", [vigente.id]
    );
    const umbral = umbrales ? determinarUmbral(diasRestantes, vencidoRows.length > 0, umbrales) : determinarUmbral(diasRestantes, vencidoRows.length > 0);
    if (!umbral) continue;

    const { rows: insertados } = await db.pool.query(
      `INSERT INTO alertas_documentos_enviadas (proveedor_documento_id, umbral) VALUES ($1, $2)
       ON CONFLICT (proveedor_documento_id, umbral) DO NOTHING RETURNING id`,
      [vigente.id, umbral]
    );
    if (!insertados.length) continue;

    const mensaje = cumplimiento.construirMensajeDocumento(umbral, vigente.proveedor_nombre, info ? info.label : vigente.tipo, vigente.fecha_vencimiento);
    // Proveedores es un catálogo global sin obra asociada — project_id NULL
    // (la columna ya lo permite). navigateFromNotif() en el frontend ya
    // maneja notif.project_id ausente sin crashear (early return), y se le
    // agregó un caso explícito para saltar a Cumplimiento en vez de a una obra.
    await notificarAdmins(null, 'documento_proveedor_por_vencer', insertados[0].id, mensaje);

    alertasDocumentosEnviadas.push({ proveedor_documento_id: vigente.id, proveedor_id: vigente.proveedor_id, tipo: vigente.tipo, umbral });
  }

  res.json({
    revisadas: proyectos.length,
    alertas_enviadas: alertasEnviadas,
    omitidas,
    documentos_revisados: porProveedorTipo.size,
    alertas_documentos_enviadas: alertasDocumentosEnviadas,
  });
}));

// Emite un nuevo access token usando el refresh token (cookie httpOnly).
// No requiere Authorization: Bearer — solo la cookie cp_refresh.
app.post('/api/auth/refresh', h(async (req, res) => {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/(?:^|;\s*)cp_refresh=([^;]+)/);
  const rawToken = match ? decodeURIComponent(match[1]) : null;
  if (!rawToken) return res.status(401).json({ error: 'Sin refresh token' });
  let decoded;
  try {
    decoded = auth.verifyRefreshToken(rawToken);
  } catch {
    return res.status(401).json({ error: 'Refresh token inválido o expirado' });
  }
  const { rows } = await db.pool.query(
    'SELECT id, nombre, usuario, puesto, token_valid_since FROM usuarios WHERE id = $1 AND activo = true',
    [decoded.id]
  );
  if (!rows[0]) return res.status(401).json({ error: 'Sesión inválida' });
  // Mismo fix que requireAuth en server/auth.js: el valor de token_valid_since
  // llega sin zona (type parser de server/db.js) pero siempre es UTC — hay
  // que forzarlo con '+ Z' antes de comparar, o new Date() lo interpreta como
  // hora local del proceso y revoca de más en zonas detrás de UTC.
  if (decoded.iat * 1000 <= new Date(`${rows[0].token_valid_since}Z`).getTime()) {
    return res.status(401).json({ error: 'Sesión revocada' });
  }
  const token = auth.signToken(rows[0]);
  res.json({ token });
}));

// Borra la cookie de refresh en el navegador (logout limpio).
// Público para poder llamarlo aunque el access token ya haya expirado.
app.post('/api/auth/logout', (_req, res) => {
  res.setHeader('Set-Cookie', auth.buildRefreshCookie('', true));
  res.json({ ok: true });
});

// Config pública para el frontend (Sentry DSN / PostHog key). Público a
// propósito, antes de auth.requireAuth: ambas son claves públicas por diseño
// de sus SDKs (se embeben en cualquier bundle de cliente), no secretos como
// TOTP_ENC_KEY/SESSION_SECRET — nunca se exponen aquí. null cuando Paul
// todavía no las configura en el entorno, para que el frontend sepa no
// inicializar el SDK correspondiente.
app.get('/api/public-config', (_req, res) => {
  res.json({
    sentryDsn: process.env.SENTRY_DSN || null,
    posthogKey: process.env.POSTHOG_API_KEY || null,
    posthogHost: process.env.POSTHOG_HOST || null,
  });
});

app.use('/api', auth.requireAuth);

app.get('/api/auth/me', h(async (req, res) => {
  const { rows } = await db.pool.query(
    'SELECT id, nombre, usuario, puesto, must_change_password, totp_enabled, totp_reminder_last_shown_at, solicitud_eliminacion_datos FROM usuarios WHERE id = $1 AND activo = true',
    [req.user.id]
  );
  if (!rows[0]) return res.status(401).json({ error: 'Sesión inválida' });
  res.json({
    user: { id: rows[0].id, nombre: rows[0].nombre, usuario: rows[0].usuario, puesto: rows[0].puesto, totp_enabled: !!rows[0].totp_enabled, solicitud_eliminacion_datos: !!rows[0].solicitud_eliminacion_datos },
    tabs: auth.tabsParaUsuario(rows[0]),
    must_change_password: rows[0].must_change_password || false,
    needsTotpReminder: shouldShowTotpReminder(rows[0]),
    avisoNovedades: await getAvisoNovedades(rows[0].id),
  });
}));

// Inicia inscripción TOTP a pedido del usuario (banner de recordatorio en
// Inicio, o desde Mi cuenta) — desde que 2FA dejó de ser obligatorio (ver
// CLAUDE.md), este es el único punto de entrada al enrollment fuera del login
// forzado original. Misma lógica de generación/reuso de secret que antes vivía
// en /login: si ya había un secret pendiente sin confirmar, se reutiliza.
app.post('/api/auth/totp/enroll-start', h(async (req, res) => {
  const { rows } = await db.pool.query('SELECT * FROM usuarios WHERE id = $1 AND activo = true', [req.user.id]);
  const user = rows[0];
  if (!user) return res.status(401).json({ error: 'Sesión inválida, inicia sesión de nuevo' });
  if (user.totp_enabled) return res.status(400).json({ error: 'Ya tienes la verificación en dos pasos configurada' });

  let secretBase32;
  let hadUndecryptableSecret = false;
  if (user.totp_secret) {
    try {
      secretBase32 = auth.decryptTotpSecret(user.totp_secret);
    } catch {
      hadUndecryptableSecret = true;
    }
  }
  if (!user.totp_secret || hadUndecryptableSecret) {
    const candidate = auth.encryptTotpSecret(auth.generateTotpSecret());
    const { rows: upserted } = hadUndecryptableSecret
      ? await db.pool.query(
          'UPDATE usuarios SET totp_secret = $1 WHERE id = $2 RETURNING totp_secret',
          [candidate, user.id]
        )
      : await db.pool.query(
          'UPDATE usuarios SET totp_secret = COALESCE(totp_secret, $1) WHERE id = $2 RETURNING totp_secret',
          [candidate, user.id]
        );
    secretBase32 = auth.decryptTotpSecret(upserted[0].totp_secret);
  }
  const otpauthUri = auth.buildTotpUri(user.usuario, secretBase32);
  const qrDataUri = await QRCode.toDataURL(otpauthUri);
  res.json({
    preAuthToken: auth.signPreAuthToken(user, { enroll: true }),
    qrDataUri,
    manualEntryKey: secretBase32,
  });
}));

// Marca que ya se le mostró el banner de recordatorio de 2FA — usa siempre el
// ID del JWT autenticado (req.user.id), nunca uno recibido en el body, para no
// abrir un IDOR que permita a cualquier usuario silenciar el recordatorio de otro.
app.post('/api/usuarios/totp-reminder-dismissed', h(async (req, res) => {
  await db.pool.query('UPDATE usuarios SET totp_reminder_last_shown_at = NOW() WHERE id = $1', [req.user.id]);
  res.json({ ok: true });
}));

// Autogestión: el usuario puede cambiar su nombre, usuario y contraseña.
// Si cambia la contraseña, se invalidan todas las sesiones anteriores y se
// emite un token nuevo para la sesión actual.
const MI_CUENTA_RATE_LIMIT_USUARIO = 5; // fallos de passwordActual en 10 min, por usuario
const MI_CUENTA_RATE_LIMIT_IP = 20; // fallos de passwordActual en 10 min, por IP

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

  const ip = auth.getIp(req);
  if (passwordActual) {
    // Rate limiting serverless-safe (mismo mecanismo que login/TOTP): cuenta
    // en Postgres, solo fallos de passwordActual, por usuario y por IP.
    const { rows: userLimitRows } = await db.pool.query(
      `SELECT COUNT(*)::int AS n FROM api_rate_limits
       WHERE usuario_id = $1 AND endpoint = 'mi_cuenta_password'
         AND creado_en > NOW() - INTERVAL '10 minutes'`,
      [req.user.id]
    );
    if (userLimitRows[0].n >= MI_CUENTA_RATE_LIMIT_USUARIO) {
      return res.status(429).json({ error: 'Demasiados intentos fallidos. Espera 10 minutos e intenta de nuevo.' });
    }
    const { rows: ipLimitRows } = await db.pool.query(
      `SELECT COUNT(*)::int AS n FROM api_rate_limits
       WHERE ip = $1 AND endpoint = 'mi_cuenta_password'
         AND creado_en > NOW() - INTERVAL '10 minutes'`,
      [ip]
    );
    if (ipLimitRows[0].n >= MI_CUENTA_RATE_LIMIT_IP) {
      return res.status(429).json({ error: 'Demasiados intentos desde esta red. Espera 10 minutos e intenta de nuevo.' });
    }
  }

  const { rows: userRows } = await db.pool.query(
    'SELECT * FROM usuarios WHERE id = $1 AND activo = true', [req.user.id]
  );
  if (!userRows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
  const userDb = userRows[0];

  if (passwordActual && !(await auth.verifyPassword(passwordActual, userDb.password_hash))) {
    await db.pool.query(
      `INSERT INTO api_rate_limits (usuario_id, endpoint, ip) VALUES ($1, 'mi_cuenta_password', $2)`,
      [req.user.id, ip]
    );
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

// Autoservicio: el usuario solicita la eliminación de sus datos personales.
// NUNCA borra nada físicamente — solo marca la solicitud (ver comentario en
// server/db.js) para que un administrador la revise y procese manualmente.
app.post('/api/auth/solicitar-eliminacion-datos', h(async (req, res) => {
  const { rows } = await db.pool.query(
    `UPDATE usuarios SET solicitud_eliminacion_datos = true, fecha_solicitud_eliminacion = NOW()
     WHERE id = $1 RETURNING id, nombre, usuario, puesto`,
    [req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });

  const ip = auth.getIp(req);
  await db.pool.query(
    'INSERT INTO audit_log (actor_id, actor_usuario, accion, target_id, target_usuario, ip) VALUES ($1,$2,$3,$4,$5,$6)',
    [req.user.id, req.user.usuario, 'solicitud_eliminacion_datos', rows[0].id, rows[0].usuario, ip]
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

// Preferencias de notificaciones (prompt-fase2-notificaciones-sesiones.md) —
// qué tipos quiere recibir el usuario. Sin fila = activado (ver
// tipoHabilitado() en server/notificaciones.js); el GET devuelve el estado
// resuelto (con default aplicado) para los 9 tipos, agrupado por categoría
// para que el frontend solo tenga que pintar lo que recibe.
app.get('/api/notificaciones/preferencias', h(async (req, res) => {
  const { rows } = await db.pool.query(
    'SELECT tipo, activo FROM notificacion_preferencias WHERE usuario_id = $1', [req.user.id]
  );
  const desactivados = new Set(rows.filter((r) => !r.activo).map((r) => r.tipo));
  // prompt-44-critico-operadores-bloqueados.md: antes se devolvía el catálogo
  // completo a cualquier puesto (ej. operador veía "Aprobaciones pendientes"
  // de Requisición/OC/Avance/Destajo/Estimación pese a que ninguna le aplica
  // — esos tipos solo los recibe admin/cabo/residente según el caso, ver
  // ROLES_POR_TIPO). admin/desarrollador siguen viendo el catálogo completo
  // (mismo bypass superusuario que el resto de la app).
  const esSuperusuario = req.user.puesto === 'admin' || req.user.puesto === 'desarrollador';
  const categorias = Object.entries(CATEGORIAS_NOTIFICACION).map(([clave, cat]) => ({
    clave, label: cat.label,
    tipos: Object.entries(cat.tipos)
      .filter(([tipo]) => esSuperusuario || (ROLES_POR_TIPO[tipo] || []).includes(req.user.puesto))
      .map(([tipo, label]) => ({ tipo, label, activo: !desactivados.has(tipo) })),
  })).filter((cat) => cat.tipos.length > 0);
  res.json({ categorias });
}));

app.put('/api/notificaciones/preferencias', h(async (req, res) => {
  const { tipo, activo } = req.body || {};
  if (!TODOS_LOS_TIPOS.includes(tipo)) return res.status(400).json({ error: 'Tipo de notificación inválido' });
  if (typeof activo !== 'boolean') return res.status(400).json({ error: 'activo debe ser true o false' });
  await db.pool.query(
    `INSERT INTO notificacion_preferencias (usuario_id, tipo, activo) VALUES ($1, $2, $3)
     ON CONFLICT (usuario_id, tipo) DO UPDATE SET activo = $3`,
    [req.user.id, tipo, activo]
  );
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Usuarios (solo admin)
// ---------------------------------------------------------------------------
// CN-001: 'administracion' puede gestionar usuarios pero no debe poder
// asignarse (ni asignarle a nadie) los puestos más altos, ni cambiar su
// propio puesto — ambos casos bypasean permisos_usuario/checkPermiso.
const ROLES_ALTOS = ['admin', 'desarrollador'];
function puedeAsignarPuesto(actor, puestoDestino) {
  if (!ROLES_ALTOS.includes(puestoDestino)) return true;
  return actor.puesto === 'admin' || actor.puesto === 'desarrollador';
}

app.get('/api/usuarios', h(auth.allow('administracion')), h(async (_req, res) => {
  const { rows } = await db.pool.query(
    'SELECT id, nombre, usuario, puesto, activo, creado_en, must_change_password, totp_enabled FROM usuarios ORDER BY id'
  );
  res.json(rows);
}));

app.post('/api/usuarios', h(auth.allow('administracion')), h(async (req, res) => {
  const { nombre, usuario, password, puesto } = req.body || {};
  if (!nombre?.trim() || !usuario?.trim() || !password || !auth.isValidPuesto(puesto)) {
    return res.status(400).json({ error: 'Indica nombre, usuario, contraseña y un puesto válido' });
  }
  if (!puedeAsignarPuesto(req.user, puesto)) {
    return res.status(403).json({ error: 'No puedes asignar ese puesto' });
  }
  if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  try {
    const hash = await auth.hashPassword(password);
    const { rows } = await db.pool.query(
      'INSERT INTO usuarios (nombre, usuario, password_hash, puesto) VALUES ($1,$2,$3,$4) RETURNING id, nombre, usuario, puesto, activo, creado_en',
      [nombre.trim(), usuario.trim(), hash, puesto]
    );
    // Permisos default por rol (proyecto_id NULL = aplica a todas las obras
    // que se le asignen) — editable después desde el panel de checkboxes.
    const defaults = auth.defaultPermisosParaRol(puesto);
    for (const p of defaults) {
      await db.pool.query(
        `INSERT INTO permisos_usuario
           (usuario_id, proyecto_id, seccion, puede_ver, puede_crear, puede_editar, puede_editar_precios, puede_eliminar)
         VALUES ($1,NULL,$2,$3,$4,$5,$6,$7)`,
        [rows[0].id, p.seccion, p.puede_ver, p.puede_crear, p.puede_editar, p.puede_editar_precios, p.puede_eliminar]
      );
    }
    const ip = auth.getIp(req);
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
  if (puesto != null && !puedeAsignarPuesto(req.user, puesto)) {
    return res.status(403).json({ error: 'No puedes asignar ese puesto' });
  }
  if (id === req.user.id && puesto != null && puesto !== req.user.puesto) {
    return res.status(403).json({ error: 'No puedes cambiar tu propio puesto' });
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
    const ip = auth.getIp(req);
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

// Resetea el 2FA de otro usuario (pierde su dispositivo/backup codes): limpia
// el secret y los backup codes, y fuerza una nueva inscripción en su próximo
// login. Solo admin/desarrollador (auth.allow() sin roles extra = ellos dos
// únicamente, ni siquiera 'administracion' — a diferencia del resto de /usuarios).
app.post('/api/usuarios/:id/totp-reset', h(auth.allow()), h(async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await db.pool.query(
    'UPDATE usuarios SET totp_secret = NULL, totp_enabled = false, totp_backup_codes = NULL WHERE id = $1 RETURNING id, usuario',
    [id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
  const ip = auth.getIp(req);
  await db.pool.query(
    'INSERT INTO audit_log (actor_id, actor_usuario, accion, target_id, target_usuario, ip) VALUES ($1,$2,$3,$4,$5,$6)',
    [req.user.id, req.user.usuario, 'reset_totp', rows[0].id, rows[0].usuario, ip]
  );
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
// Permisos granulares por usuario/obra/sección (tabla permisos_usuario).
// CRUD accesible solo a admin/desarrollador — mismo patrón restrictivo que
// /usuarios/:id/totp-reset (auth.allow() sin roles extra).
// ---------------------------------------------------------------------------
// Autoconsulta generalizada (cualquier usuario autenticado, sobre sí mismo):
// regresa TODAS las secciones de permisos_usuario en una sola llamada (evita
// que el frontend dispare N requests a /mis-permisos/:seccion cuando necesita
// varios flags a la vez, ej. armar el sidebar o revisar varios campos de una
// vista). obra_id es opcional en query string — si se manda, una fila
// específica de esa obra gana sobre la fila general (proyecto_id NULL) para
// la misma sección, igual que tienePermiso(). admin/desarrollador reciben
// todo en true (mismo bypass que checkPermiso). DEBE ir antes de
// GET /api/permisos/:usuario_id (abajo): Express hace match en orden de
// registro, y ':usuario_id' capturaría el literal "me" si fuera declarada
// primero, exigiendo entonces auth.allow() (admin/desarrollador-only) y
// devolviendo 403 a cualquier otro rol.
app.get('/api/permisos/me', h(async (req, res) => {
  const obraId = req.query.obra_id ? Number(req.query.obra_id) : null;
  if (req.user.puesto === 'admin' || req.user.puesto === 'desarrollador') {
    const resultado = {};
    for (const seccion of auth.SECCIONES_PERMISOS) {
      resultado[seccion] = { puede_ver: true, puede_crear: true, puede_editar: true, puede_editar_precios: true, puede_eliminar: true };
    }
    return res.json(resultado);
  }
  if (obraId) {
    const { rows: accesoRows } = await db.pool.query(
      'SELECT 1 FROM usuario_proyectos WHERE usuario_id = $1 AND project_id = $2',
      [req.user.id, obraId]
    );
    if (!accesoRows.length) return res.status(403).json({ error: 'No tienes acceso a esta obra' });
  }
  const { rows } = await db.pool.query(
    `SELECT seccion, puede_ver, puede_crear, puede_editar, puede_editar_precios, puede_eliminar
     FROM permisos_usuario
     WHERE usuario_id = $1 AND (proyecto_id = $2 OR proyecto_id IS NULL)
     ORDER BY proyecto_id NULLS FIRST`,
    [req.user.id, obraId]
  );
  const resultado = {};
  for (const seccion of auth.SECCIONES_PERMISOS) {
    resultado[seccion] = { puede_ver: false, puede_crear: false, puede_editar: false, puede_editar_precios: false, puede_eliminar: false };
  }
  // NULLS FIRST: la fila general se inserta primero y la específica de la
  // obra (si existe) la sobreescribe al recorrer en este orden.
  for (const row of rows) {
    resultado[row.seccion] = {
      puede_ver: row.puede_ver, puede_crear: row.puede_crear, puede_editar: row.puede_editar,
      puede_editar_precios: row.puede_editar_precios, puede_eliminar: row.puede_eliminar,
    };
  }
  res.json(resultado);
}));

// Tabs que se resuelven aparte, vía PERMISSIONS.<rol>.tabs (ver el loop más
// abajo en GET /api/projects/:id/nav-tabs), en vez de la traducción genérica
// sección->tab de SECCION_A_TAB:
// - 'resumen': 'presupuestos' (a lo que mapea en TAB_A_SECCION) NO es 1:1 con
//   el tab — esa sección también gatea checkPermiso('presupuestos','puede_ver')
//   en GET /api/projects/:id/conceptos, el permiso de ver los CONCEPTOS del
//   presupuesto que residente/cabo/etc. necesitan a diario y no tiene relación
//   con el tab 'Resumen' (dashboard financiero agregado, hoy solo admin/
//   tesorería/administración). Confirmado en diagnóstico real: Rbermeo y
//   Ejimenez hubieran ganado el tab Resumen sin que nadie se los otorgara.
// - 'ordenes': cabo tiene puede_ver=true en 'ordenes_compra' (otorgado en
//   PR #78 para preservar la lectura del listado/detalle de OC que ya tenía
//   por rol plano antes de existir checkPermiso), pero eso nunca fue una
//   decisión consciente de darle el tab completo — no debe ganarlo como
//   efecto colateral de este cambio (decisión explícita, prompt-p8-parte2).
const TABS_RESUELTOS_APARTE = ['resumen', 'ordenes'];
// seccion -> [tabs] (antes 1:1 seccion->tab; prompt-39-maquinaria-galeria-
// subsecciones.md partió el tab único 'maquinaria' en 6 subpestañas que
// siguen compartiendo la MISMA sección de permiso 'maquinaria' — ver
// TAB_A_SECCION en server/auth.js — así que la traducción inversa ahora
// puede resolver varios tabs por sección).
const SECCION_A_TAB = {};
Object.entries(auth.TAB_A_SECCION)
  .filter(([tab]) => !TABS_RESUELTOS_APARTE.includes(tab))
  .forEach(([tab, seccion]) => {
    if (!SECCION_A_TAB[seccion]) SECCION_A_TAB[seccion] = [];
    SECCION_A_TAB[seccion].push(tab);
  });

// Fuente de verdad de navegación por-obra (prompt-p8-parte2-nav-por-obra.md
// — completa el trabajo de PR #78). Reemplaza a PERMISSIONS.<rol>.tabs para
// roles no-admin: un tab es visible si el usuario tiene puede_ver=true en
// permisos_usuario para su sección, resuelto contra la obra activa
// (proyecto_id = :id) O una fila global (proyecto_id NULL) — la fila
// específica de la obra gana sobre la global, mismo criterio que
// tienePermiso()/GET /api/permisos/me. admin/desarrollador bypasean por
// completo (mismo bypass hardcodeado que checkPermiso/allow en todo el
// resto del sistema) — siguen viendo PERMISSIONS.<rol>.tabs, sin cambio de
// comportamiento ni consulta a la tabla.
app.get('/api/projects/:id/nav-tabs', h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  if (req.user.puesto === 'admin' || req.user.puesto === 'desarrollador') {
    return res.json({ tabs: auth.tabsParaUsuario(req.user) });
  }
  const { rows } = await db.pool.query(
    `SELECT seccion, puede_ver FROM permisos_usuario
     WHERE usuario_id = $1 AND (proyecto_id = $2 OR proyecto_id IS NULL)
     ORDER BY proyecto_id NULLS FIRST`,
    [req.user.id, req.project.id]
  );
  // NULLS FIRST: la fila general se procesa primero y la específica de la
  // obra (si existe) la sobreescribe — mismo patrón que GET /api/permisos/me.
  const puedeVer = {};
  for (const row of rows) puedeVer[row.seccion] = row.puede_ver;
  const tabsResueltos = Object.entries(puedeVer)
    .filter(([, ok]) => ok)
    .flatMap(([seccion]) => SECCION_A_TAB[seccion] || []);
  // Intersección con PERMISSIONS.<rol>.tabs (línea base del rol): necesaria
  // desde que 'maquinaria' pasó a resolver en varios tabs (arriba) — sin
  // esto, cualquier rol con puede_ver=true en la sección 'maquinaria' (ej.
  // residente, cabo) ganaría las 6 subpestañas por esta vía aunque su rol
  // solo deba ver un subconjunto (residente nunca ve Bitácora de taller,
  // cabo tampoco, etc. — ver MAQUINARIA_TABS_* en public/app.js). Para el
  // resto de secciones (siempre 1 tab) esta intersección es un no-op: el
  // tab ya estaba en la lista base del rol.
  const tabsBaseRol = new Set(auth.PERMISSIONS[req.user.puesto]?.tabs || []);
  const tabs = [...new Set(tabsResueltos)].filter((t) => tabsBaseRol.has(t));
  // 'resumen'/'ordenes' quedan fuera de SECCION_A_TAB (ver comentario arriba)
  // — se resuelven aparte, tal cual como hoy (PERMISSIONS.<rol>.tabs), para
  // no regalarlos vía una sección de alcance más amplio (presupuestos/
  // ordenes_compra) ni perderlos para los roles que sí los tienen hoy
  // (tesorería/administración para resumen; residente/compras/tesorería/
  // administración/logística para ordenes) por no tener una sección
  // granular propia y exclusiva todavía.
  for (const tab of TABS_RESUELTOS_APARTE) {
    if (tabsBaseRol.has(tab)) tabs.push(tab);
  }
  res.json({ tabs });
}));

app.get('/api/permisos/:usuario_id', h(auth.allow()), h(async (req, res) => {
  const usuarioId = Number(req.params.usuario_id);
  const { rows: userRows } = await db.pool.query('SELECT id FROM usuarios WHERE id = $1', [usuarioId]);
  if (!userRows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
  const { rows } = await db.pool.query(
    `SELECT id, proyecto_id, seccion, puede_ver, puede_crear, puede_editar, puede_editar_precios, puede_eliminar
     FROM permisos_usuario WHERE usuario_id = $1 ORDER BY proyecto_id NULLS FIRST, seccion`,
    [usuarioId]
  );
  res.json(rows);
}));

// Upsert masivo de la matriz sección×acción para un usuario+proyecto (proyecto
// null = aplica a todas las obras asignadas). No usa ON CONFLICT porque
// proyecto_id es nullable y Postgres no trata NULL=NULL en índices únicos —
// se hace delete+insert por sección dentro de una transacción.
app.put('/api/permisos/:usuario_id', h(auth.allow()), h(async (req, res) => {
  const usuarioId = Number(req.params.usuario_id);
  const { rows: userRows } = await db.pool.query('SELECT id FROM usuarios WHERE id = $1', [usuarioId]);
  if (!userRows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });

  const { proyecto_id, permisos } = req.body || {};
  const proyectoId = proyecto_id != null ? Number(proyecto_id) : null;
  if (proyectoId != null && !Number.isFinite(proyectoId)) return res.status(400).json({ error: 'proyecto_id inválido' });
  if (!Array.isArray(permisos) || !permisos.length) return res.status(400).json({ error: 'permisos debe ser un arreglo no vacío' });
  for (const p of permisos) {
    if (!auth.SECCIONES_PERMISOS.includes(p.seccion)) return res.status(400).json({ error: `Sección inválida: ${p.seccion}` });
  }

  await db.withTransaction(async (client) => {
    for (const p of permisos) {
      await client.query(
        'DELETE FROM permisos_usuario WHERE usuario_id = $1 AND seccion = $2 AND proyecto_id IS NOT DISTINCT FROM $3',
        [usuarioId, p.seccion, proyectoId]
      );
      await client.query(
        `INSERT INTO permisos_usuario
           (usuario_id, proyecto_id, seccion, puede_ver, puede_crear, puede_editar, puede_editar_precios, puede_eliminar)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [usuarioId, proyectoId, p.seccion, !!p.puede_ver, !!p.puede_crear, !!p.puede_editar, !!p.puede_editar_precios, !!p.puede_eliminar]
      );
    }
  });

  const { rows } = await db.pool.query(
    `SELECT id, proyecto_id, seccion, puede_ver, puede_crear, puede_editar, puede_editar_precios, puede_eliminar
     FROM permisos_usuario WHERE usuario_id = $1 ORDER BY proyecto_id NULLS FIRST, seccion`,
    [usuarioId]
  );
  res.json(rows);
}));

// Autoconsulta (cualquier usuario autenticado, sobre sí mismo): resuelve sus
// propios flags de permisos_usuario para una sección dentro de una obra —
// usado por el frontend para ocultar/deshabilitar controles de edición sin
// depender del endpoint admin-only de arriba. admin/desarrollador siempre
// regresan todo en true (mismo bypass que checkPermiso).
app.get('/api/projects/:id/mis-permisos/:seccion', h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { seccion } = req.params;
  if (!auth.SECCIONES_PERMISOS.includes(seccion)) return res.status(400).json({ error: 'Sección inválida' });
  if (req.user.puesto === 'admin' || req.user.puesto === 'desarrollador') {
    return res.json({ puede_ver: true, puede_crear: true, puede_editar: true, puede_editar_precios: true, puede_eliminar: true });
  }
  const acciones = ['puede_ver', 'puede_crear', 'puede_editar', 'puede_editar_precios', 'puede_eliminar'];
  const resultado = {};
  for (const accion of acciones) {
    resultado[accion] = await auth.tienePermiso(req, seccion, accion);
  }
  res.json(resultado);
}));

// Misma autoconsulta que arriba, pero para secciones que NO son por obra
// (ej. Maquinaria — catálogo global, igual que Proveedores). Sin req.project,
// tienePermiso resuelve contra la fila de proyecto_id NULL ("regla general").
app.get('/api/mis-permisos/:seccion', h(async (req, res) => {
  const { seccion } = req.params;
  if (!auth.SECCIONES_PERMISOS.includes(seccion)) return res.status(400).json({ error: 'Sección inválida' });
  if (req.user.puesto === 'admin' || req.user.puesto === 'desarrollador') {
    return res.json({ puede_ver: true, puede_crear: true, puede_editar: true, puede_editar_precios: true, puede_eliminar: true });
  }
  const acciones = ['puede_ver', 'puede_crear', 'puede_editar', 'puede_editar_precios', 'puede_eliminar'];
  const resultado = {};
  for (const accion of acciones) {
    resultado[accion] = await auth.tienePermiso(req, seccion, accion);
  }
  res.json(resultado);
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

app.get('/api/proveedores', h(auth.allow('residente', 'cabo', 'compras', 'tesoreria', 'administracion')), h(auth.checkPermiso('proveedores', 'puede_ver')), h(async (req, res) => {
  res.json(await getProveedoresData(req.query.activo));
}));

app.get('/api/proveedores/export', h(auth.allow('residente', 'cabo', 'compras', 'tesoreria', 'administracion')), h(auth.checkPermiso('proveedores', 'puede_ver')), h(async (req, res) => {
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

app.post('/api/proveedores', h(auth.allow('compras')), h(auth.checkPermiso('proveedores', 'puede_crear')), h(async (req, res) => {
  const { nombre, contacto, telefono, email, rfc } = req.body || {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre del proveedor es requerido' });
  const { rows } = await db.pool.query(
    `INSERT INTO proveedores (nombre, contacto, telefono, email, rfc) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [nombre.trim(), contacto?.trim() || null, telefono?.trim() || null, email?.trim() || null, rfc?.trim() || null]
  );
  res.status(201).json(rows[0]);
}));

app.put('/api/proveedores/:id', h(auth.allow('compras')), h(auth.checkPermiso('proveedores', 'puede_editar')), h(async (req, res) => {
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

// Baja/reactivación es soft-delete (toggle de `activo`, nunca DELETE físico)
// — mapeada a 'puede_eliminar' porque semánticamente es la acción de "quitar"
// un proveedor del catálogo activo, aunque técnicamente sea un UPDATE.
app.put('/api/proveedores/:id/estado', h(auth.allow('compras')), h(auth.checkPermiso('proveedores', 'puede_eliminar')), h(async (req, res) => {
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
// Cumplimiento de proveedores/subcontratistas (prompt-cumplimiento-
// subcontratistas.md) — reusa la sección de permisos 'proveedores' (mismo
// criterio que 'compromisos'/'fondoGarantia' reusan 'finanzas'), sin sección
// granular propia. Documento de respaldo: mismo patrón de Blob privado +
// proxy autenticado que Contrato/trabajador_documentos, con blob_url
// NULLABLE a propósito (capturar solo fecha, sin archivo, es válido).
// ---------------------------------------------------------------------------
app.post('/api/proveedores/documentos/upload-token', h(auth.allow('compras')), h(auth.checkPermiso('proveedores', 'puede_crear')), h(async (req, res) => {
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

app.post('/api/proveedores/:id/documentos', h(auth.allow('compras')), h(auth.checkPermiso('proveedores', 'puede_crear')), h(async (req, res) => {
  const proveedorId = Number(req.params.id);
  const { tipo, fecha_vencimiento, blob_url, nombre_archivo } = req.body || {};
  if (!cumplimiento.getTipoInfo(tipo)) return res.status(400).json({ error: 'Tipo de documento inválido' });
  const { rows: provRows } = await db.pool.query('SELECT id FROM proveedores WHERE id = $1', [proveedorId]);
  if (!provRows[0]) return res.status(404).json({ error: 'Proveedor no encontrado' });
  // Nunca se sobrescribe: siempre INSERT nuevo (Forbidden Action explícita
  // del prompt) — así se conserva el historial completo de renovaciones.
  const { rows } = await db.pool.query(
    `INSERT INTO proveedor_documentos (proveedor_id, tipo, fecha_vencimiento, blob_url, nombre_archivo, subido_por)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [proveedorId, tipo, fecha_vencimiento || null, blob_url || null, nombre_archivo?.trim() || null, req.user.id]
  );
  res.status(201).json(rows[0]);
}));

app.get('/api/proveedores/:id/documentos', h(auth.allow('residente', 'cabo', 'compras', 'tesoreria', 'administracion')), h(auth.checkPermiso('proveedores', 'puede_ver')), h(async (req, res) => {
  const proveedorId = Number(req.params.id);
  const { rows } = await db.pool.query(
    `SELECT id, tipo, fecha_vencimiento, blob_url, nombre_archivo, subido_en
     FROM proveedor_documentos WHERE proveedor_id = $1 ORDER BY subido_en DESC`,
    [proveedorId]
  );
  res.json(rows);
}));

// Proxy autenticado — nunca se expone la URL de Blob directa (mismo patrón
// que /contrato/pdf y trabajador_documentos/:docId/download).
app.get('/api/proveedores/documentos/:docId/descarga', h(auth.allow('residente', 'cabo', 'compras', 'tesoreria', 'administracion')), h(auth.checkPermiso('proveedores', 'puede_ver')), h(async (req, res) => {
  const docId = Number(req.params.docId);
  const { rows } = await db.pool.query('SELECT blob_url, nombre_archivo FROM proveedor_documentos WHERE id = $1', [docId]);
  if (!rows[0] || !rows[0].blob_url) return res.status(404).json({ error: 'Documento no encontrado' });
  const blobResult = await get(rows[0].blob_url, { access: 'private' });
  if (!blobResult) return res.status(404).json({ error: 'Archivo no encontrado en almacenamiento' });
  const nombreArchivo = rows[0].nombre_archivo || 'documento';
  const ext = (nombreArchivo.split('.').pop() || 'bin').toLowerCase();
  const mimeMap = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', webp: 'image/webp' };
  res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
  res.setHeader('Content-Disposition', safeContentDisposition('inline', nombreArchivo));
  await pipeline(Readable.fromWeb(blobResult.stream), res);
}));

// Vista consolidada: por cada proveedor activo, el documento vigente de cada
// tipo con estatus derivado. Dataset pequeño (catálogo de proveedores) — se
// resuelve en JS en vez de una query con window functions.
// Extraído a función propia (prompt-dashboard-ejecutivo.md) para que el
// Dashboard Ejecutivo pueda incluir este mismo bloque sin duplicar la query
// — comportamiento de /api/cumplimiento sin cambios.
async function getCumplimientoResumenData() {
  const { rows: proveedores } = await db.pool.query('SELECT id, nombre FROM proveedores WHERE activo = 1 ORDER BY nombre');
  const { rows: docs } = await db.pool.query(
    `SELECT id, proveedor_id, tipo, fecha_vencimiento, nombre_archivo, subido_en
     FROM proveedor_documentos ORDER BY subido_en DESC`
  );
  const porProveedor = new Map();
  for (const d of docs) {
    if (!porProveedor.has(d.proveedor_id)) porProveedor.set(d.proveedor_id, []);
    porProveedor.get(d.proveedor_id).push(d);
  }

  const tipos = Object.entries(cumplimiento.TIPOS_DOCUMENTO).map(([tipo, info]) => ({ tipo, label: info.label, vence: info.vence }));

  const resultado = proveedores.map((p) => {
    const docsProveedor = porProveedor.get(p.id) || [];
    const documentos = {};
    for (const tipo of Object.keys(cumplimiento.TIPOS_DOCUMENTO)) {
      const filas = docsProveedor.filter((d) => d.tipo === tipo);
      const vigente = cumplimiento.elegirVigente(filas);
      documentos[tipo] = {
        estatus: cumplimiento.estatusDeDocumento(vigente, tipo),
        documento_id: vigente ? vigente.id : null,
        fecha_vencimiento: vigente ? vigente.fecha_vencimiento : null,
        nombre_archivo: vigente ? vigente.nombre_archivo : null,
      };
    }
    return { proveedor_id: p.id, proveedor_nombre: p.nombre, documentos };
  });

  return { tipos, proveedores: resultado };
}

app.get('/api/cumplimiento', h(auth.allow('residente', 'cabo', 'compras', 'tesoreria', 'administracion')), h(auth.checkPermiso('proveedores', 'puede_ver')), h(async (req, res) => {
  res.json(await getCumplimientoResumenData());
}));

// ---------------------------------------------------------------------------
// Maquinaria propia (prompt-modulo-maquinaria) — catálogo global (no por
// obra, igual que Proveedores). Código nuevo: usa checkPermiso desde el
// inicio, sin auth.allow() legacy — el rol por sí solo no decide nada aquí,
// solo la fila real en permisos_usuario (ver defaults en server/auth.js
// defaultPermisosParaRol: jefe_maquinaria/admin/desarrollador ya vienen con
// puede_crear+puede_editar, cabo con puede_crear, para no bloquearse el
// mismo día que se activa el enforcement).
// DISEÑO DE PRIMER BORRADOR, pendiente de revisión (ver server/maquinaria.js).
// ---------------------------------------------------------------------------
// prompt-p2-aislamiento-operador.md: filtro en la consulta SQL (ver
// listEquipos en server/maquinaria.js), no en el frontend — un operador solo
// recibe las máquinas que tiene asignadas, lista vacía si no tiene ninguna
// (nunca error/403 por eso). Usa req.user.puesto (JWT real), no
// effectivePuesto() — "Vista como" es solo frontend, no debe aflojar esto.
app.get('/api/maquinaria/equipos', h(auth.checkPermiso('maquinaria', 'puede_ver')), h(async (req, res) => {
  const operadorId = req.user.puesto === 'operador' ? req.user.id : null;
  res.json(await maquinaria.listEquipos(operadorId));
}));

// Lectura individual — operador pidiendo una máquina que no es la suya: 403
// (no 404, para no filtrar si el ID existe o no), sin exponer el objeto.
app.get('/api/maquinaria/equipos/:id', h(auth.checkPermiso('maquinaria', 'puede_ver')), h(async (req, res) => {
  const equipo = await maquinaria.getEquipoById(Number(req.params.id));
  if (!equipo) return res.status(404).json({ error: 'Equipo no encontrado' });
  if (req.user.puesto === 'operador' && equipo.operador_asignado_id !== req.user.id) {
    return res.status(403).json({ error: 'No tienes permiso para realizar esta acción' });
  }
  res.json(equipo);
}));

app.post('/api/maquinaria/equipos', h(auth.checkPermiso('maquinaria', 'puede_crear')), h(async (req, res) => {
  const { nombre, tipo, identificador, estado, obra_id, categoria_uso } = req.body || {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre del equipo es requerido' });
  if (categoria_uso && !['pesada', 'menor'].includes(categoria_uso)) {
    return res.status(400).json({ error: 'categoria_uso inválida' });
  }
  const equipo = await maquinaria.createEquipo({
    nombre: nombre.trim(), tipo: tipo?.trim(), identificador: identificador?.trim(), estado, obra_id, categoria_uso,
  });
  res.status(201).json(equipo);
}));

app.put('/api/maquinaria/equipos/:id', h(auth.checkPermiso('maquinaria', 'puede_editar')), h(async (req, res) => {
  const { nombre, tipo, identificador, estado, obra_id, categoria_uso } = req.body || {};
  if (categoria_uso && !['pesada', 'menor'].includes(categoria_uso)) {
    return res.status(400).json({ error: 'categoria_uso inválida' });
  }
  const equipo = await maquinaria.updateEquipo(Number(req.params.id), {
    nombre: nombre?.trim(), tipo: tipo?.trim(), identificador: identificador?.trim(), estado, obra_id, categoria_uso,
  });
  if (!equipo) return res.status(404).json({ error: 'Equipo no encontrado' });
  res.json(equipo);
}));

// Registro abierto de responsable diario (prompt-responsable-diario-equipo-
// menor.md) — mismo checkPermiso('maquinaria', ...) que el resto del
// catálogo, deliberadamente SIN el candado de ownership que sí tienen los 4
// endpoints de reportes_horas_maquinaria/estado_unidad/consumibles (líneas
// 1510/1787/1806/1901): cualquiera con acceso al módulo puede registrar para
// cualquier equipo tipo "menor", porque no hay asignación formal que validar.
app.get('/api/maquinaria/equipos/:id/responsables', h(auth.checkPermiso('maquinaria', 'puede_ver')), h(async (req, res) => {
  res.json(await maquinaria.listResponsablesDiarios(Number(req.params.id)));
}));

app.post('/api/maquinaria/equipos/:id/responsables', h(auth.checkPermiso('maquinaria', 'puede_crear')), h(async (req, res) => {
  const { fecha, nombre_responsable } = req.body || {};
  if (!nombre_responsable?.trim()) return res.status(400).json({ error: 'El nombre del responsable es requerido' });
  const equipoId = Number(req.params.id);
  const equipo = await maquinaria.getEquipoById(equipoId);
  if (!equipo) return res.status(404).json({ error: 'Equipo no encontrado' });
  const registro = await maquinaria.createResponsableDiario({
    equipo_id: equipoId, fecha: fecha || null, nombre_responsable: nombre_responsable.trim(), registrado_por: req.user.id,
  });
  res.status(201).json(registro);
}));

app.delete('/api/maquinaria/equipos/:id', h(auth.checkPermiso('maquinaria', 'puede_eliminar')), h(async (req, res) => {
  const ok = await maquinaria.softDeleteEquipo(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: 'Equipo no encontrado' });
  res.json({ ok: true });
}));

// prompt-a-maquinaria-por-cliente.md: cliente_id null = "quitar asignación"
// (equipo disponible/sin cliente). Mismo permiso que editar el catálogo de
// equipos (jefe_maquinaria/admin/desarrollador ya tienen puede_editar ahí).
app.put('/api/maquinaria/equipos/:id/asignar-cliente', h(auth.checkPermiso('maquinaria', 'puede_editar')), h(async (req, res) => {
  const { cliente_id } = req.body || {};
  const equipo = await maquinaria.asignarClienteEquipo(Number(req.params.id), cliente_id ?? null);
  if (!equipo) return res.status(404).json({ error: 'Equipo no encontrado' });
  res.json(equipo);
}));

// prompt-p2-aislamiento-operador.md: mismo permiso que asignar-cliente
// arriba (jefe_maquinaria/admin/desarrollador ya tienen puede_editar en
// 'maquinaria'). Valida que el usuario destino sea realmente un operador
// activo antes de asignar — evita asignar por error un usuario de otro rol.
app.put('/api/maquinaria/equipos/:id/asignar-operador', h(auth.checkPermiso('maquinaria', 'puede_editar')), h(async (req, res) => {
  const { operador_id } = req.body || {};
  if (operador_id != null) {
    const { rows } = await db.pool.query(
      "SELECT id FROM usuarios WHERE id = $1 AND puesto = 'operador' AND activo = true",
      [Number(operador_id)]
    );
    if (!rows[0]) return res.status(400).json({ error: 'El usuario indicado no es un operador activo' });
  }
  const equipo = await maquinaria.asignarOperadorEquipo(Number(req.params.id), operador_id ?? null);
  if (!equipo) return res.status(404).json({ error: 'Equipo no encontrado' });
  res.json(equipo);
}));

// Lista liviana (solo id+nombre) para poblar el selector "Operador asignado"
// del catálogo — checkPermiso('maquinaria','puede_editar') en vez de
// auth.allow('administracion') como GET /api/usuarios, porque jefe_maquinaria
// (sin acceso a esa lista completa de usuarios) también debe poder asignar.
app.get('/api/maquinaria/operadores', h(auth.checkPermiso('maquinaria', 'puede_editar')), h(async (req, res) => {
  const { rows } = await db.pool.query(
    "SELECT id, nombre FROM usuarios WHERE puesto = 'operador' AND activo = true ORDER BY nombre"
  );
  res.json(rows);
}));

// prompt-limpieza-permisos-cabo.md (Fase 2): antes gateado con la sección
// compartida 'maquinaria' (misma que catálogo/horas), así que cualquier rol
// con solo puede_ver en 'maquinaria' (ej. cabo, residente — ambos con
// acceso legítimo al catálogo de equipos, sin acceso a la bitácora de
// taller) podía leer combustible vía API directa, y también a través del
// panel "Historial" de cada equipo en Catálogo (ver toggleHistorialMaq en
// public/app.js) aunque su UI nunca expone el tab de Bitácora. Ahora usa la
// misma sección granular 'maquinaria_combustible' que ya gatea el POST de
// este mismo endpoint y GET /bitacora-taller — jefe_maquinaria/admin/
// desarrollador no pierden nada (ya tenían fila propia); residente gana un
// default explícito nuevo para no perder lo que ya veía (ver
// defaultPermisosParaRol en server/auth.js).
app.get('/api/maquinaria/combustible', h(auth.checkPermiso('maquinaria_combustible', 'puede_ver')), h(async (req, res) => {
  res.json(await maquinaria.listCombustible(req.query.equipo_id ? Number(req.query.equipo_id) : null));
}));

app.post('/api/maquinaria/combustible', h(auth.checkPermiso('maquinaria_combustible', 'puede_crear')), h(async (req, res) => {
  const { equipo_id, fecha, litros, costo } = req.body || {};
  if (!equipo_id || !fecha || !(litros > 0) || !(costo >= 0)) {
    return res.status(400).json({ error: 'Indica equipo, fecha, litros y costo válidos' });
  }
  const registro = await maquinaria.createCombustible({
    equipo_id: Number(equipo_id), fecha, litros: Number(litros), costo: Number(costo), registrado_por: req.user.id,
  });
  res.status(201).json(registro);
}));

app.delete('/api/maquinaria/combustible/:id', h(auth.checkPermiso('maquinaria', 'puede_eliminar')), h(async (req, res) => {
  const ok = await maquinaria.softDeleteCombustible(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: 'Registro no encontrado' });
  res.json({ ok: true });
}));

// prompt-limpieza-permisos-cabo.md: gateado con su propia sección
// 'maquinaria_mantenimiento', separada de 'maquinaria_combustible' (antes
// CN-002 las compartía — ver comentario de esa sección en SECCIONES_PERMISOS,
// server/auth.js). Sin esta separación, otorgar solo combustible a alguien
// (ej. cabo) le heredaba también lectura de mantenimientos sin que fuera una
// decisión explícita.
app.get('/api/maquinaria/mantenimientos', h(auth.checkPermiso('maquinaria_mantenimiento', 'puede_ver')), h(async (req, res) => {
  res.json(await maquinaria.listMantenimientos(req.query.equipo_id ? Number(req.query.equipo_id) : null));
}));

// prompt-4-bitacora-taller-jefe-maquinaria.md: 'preventivo'/'correctivo' son
// mantenimiento de UN equipo (equipo_id obligatorio, igual que antes);
// 'consumible'/'herramienta' son entradas generales de taller, sin equipo
// (equipo_id debe venir vacío — si se manda igual, se ignora explícitamente,
// no se guarda por error un consumible "atado" a un equipo al azar).
const TIPOS_MANTENIMIENTO = ['preventivo', 'correctivo', 'consumible', 'herramienta'];
const TIPOS_MANTENIMIENTO_REQUIEREN_EQUIPO = ['preventivo', 'correctivo'];

// prompt-limpieza-permisos-cabo.md: mismo motivo que el GET de arriba —
// separado de 'maquinaria_combustible' para que crear un registro de
// combustible y crear uno de mantenimiento sean permisos independientes.
app.post('/api/maquinaria/mantenimientos', h(auth.checkPermiso('maquinaria_mantenimiento', 'puede_crear')), h(async (req, res) => {
  const { equipo_id, fecha, tipo, descripcion, costo, proveedor, refaccion_descripcion, refaccion_costo } = req.body || {};
  if (!fecha || !TIPOS_MANTENIMIENTO.includes(tipo) || !(costo >= 0)) {
    return res.status(400).json({ error: `Indica fecha, tipo (${TIPOS_MANTENIMIENTO.join('/')}) y costo válidos` });
  }
  const requiereEquipo = TIPOS_MANTENIMIENTO_REQUIEREN_EQUIPO.includes(tipo);
  if (requiereEquipo && !equipo_id) {
    return res.status(400).json({ error: 'Indica el equipo para un mantenimiento preventivo/correctivo' });
  }
  if (refaccion_costo != null && !(Number(refaccion_costo) >= 0)) {
    return res.status(400).json({ error: 'El costo de la refacción debe ser un número válido' });
  }
  const registro = await maquinaria.createMantenimiento({
    equipo_id: requiereEquipo ? Number(equipo_id) : null,
    fecha, tipo, descripcion: descripcion?.trim(), costo: Number(costo),
    proveedor: proveedor?.trim(), registrado_por: req.user.id,
    refaccion_descripcion: requiereEquipo ? refaccion_descripcion?.trim() : null,
    refaccion_costo: requiereEquipo && refaccion_costo != null ? Number(refaccion_costo) : null,
  });
  res.status(201).json(registro);
}));

app.delete('/api/maquinaria/mantenimientos/:id', h(auth.checkPermiso('maquinaria', 'puede_eliminar')), h(async (req, res) => {
  const ok = await maquinaria.softDeleteMantenimiento(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: 'Registro no encontrado' });
  res.json({ ok: true });
}));

// Bitácora de taller (prompt-4-bitacora-taller-jefe-maquinaria.md) — sirve
// tanto el historial por equipo (?equipo_id=X, con desglose de refacciones)
// como la bitácora general (sin equipo_id, todos los tipos incluyendo
// consumibles/herramientas). Deliberadamente un endpoint NUEVO y separado
// de GET /api/maquinaria/mantenimientos de arriba (que sigue abierto a
// cualquier rol con acceso a Maquinaria vía 'maquinaria'/puede_ver, y
// alimenta el historial combinado combustible+mantenimiento+horas que ya
// existía por equipo) — checkPermiso('maquinaria_mantenimiento', 'puede_ver')
// aquí es más estricto a propósito: solo jefe_maquinaria/residente (y admin/
// desarrollador vía bypass) deben poder ver la bitácora dedicada, operador/
// cabo no tienen fila en esa sección → 403. prompt-limpieza-permisos-cabo.md:
// antes usaba 'maquinaria_combustible' — mismo dato exacto que GET
// /mantenimientos arriba (maquinaria.listMantenimientos), tenía que migrar
// junto con ese endpoint para que la separación fuera real y no solo
// cosmética.
app.get('/api/maquinaria/bitacora-taller', h(auth.checkPermiso('maquinaria_mantenimiento', 'puede_ver')), h(async (req, res) => {
  res.json(await maquinaria.listMantenimientos(req.query.equipo_id ? Number(req.query.equipo_id) : null));
}));

// prompt-p3-filtro-horas-operador.md: fuga detectada durante el diagnóstico
// de PR #72, fuera de alcance ahí — un operador veía los reportes de todos
// los operadores, no solo los suyos. Filtro por req.user.puesto (JWT real,
// no effectivePuesto() — igual que el filtro de equipos en PR #72, "Vista
// como" es solo frontend y no debe aflojar esto); cabo/jefe_maquinaria/
// admin/desarrollador siguen viendo todos los reportes (lo necesitan para
// autorizar/rechazar, sin scoping por operador).
app.get('/api/maquinaria/horas', h(auth.checkPermiso('maquinaria', 'puede_ver')), h(async (req, res) => {
  const operadorId = req.user.puesto === 'operador' ? req.user.id : null;
  res.json(await maquinaria.listHoras(req.query.equipo_id ? Number(req.query.equipo_id) : null, operadorId));
}));

// Catálogo fijo de actividad (prompt-2-rol-operador-actividades.md) —
// validado aquí en el backend, nunca solo en el frontend (mismo criterio de
// "auto-llenado" que ya usa el resto de la app: el rol 'operador' elige de
// esta lista, no escribe texto libre).
const ACTIVIDADES_MAQUINARIA = ['Excavaciones', 'Cepas', 'Rellenos', 'Acarreos', 'Carga de material', 'Limpiezas', 'Taller', 'Renta', 'Conformación de terreno'];

// Operador captura sus propias horas (operador_id = quien está autenticado,
// se ignora cualquier operador_id enviado); admin/desarrollador sí pueden
// capturar a nombre de otro operador si lo indican explícitamente. Desde
// prompt-3-flujo-aprobacion-cabo-operador.md, cabo YA NO tiene puede_crear en
// 'maquinaria_captura' (retirado en defaultPermisosParaRol + backfill en
// server/db.js) — solo autoriza/rechaza vía el endpoint de abajo. Todo
// reporte nuevo entra en 'pendiente' (fijado en maquinaria.createHoras).
app.post('/api/maquinaria/horas', h(auth.checkPermiso('maquinaria_captura', 'puede_crear')), h(async (req, res) => {
  const { equipo_id, operador_id, fecha, horas, obra_id, actividad } = req.body || {};
  if (!equipo_id || !fecha || !(horas > 0)) {
    return res.status(400).json({ error: 'Indica equipo, fecha y horas válidas' });
  }
  // prompt-operador-multiactividad.md: multi-selección — el frontend manda
  // un array de actividades (una sesión de captura puede cubrir varias).
  // Se guardan unidas por ", " en la misma columna TEXT `actividad` (Opción
  // A del diagnóstico: nada en Finanzas/reportes agrega por actividad hoy,
  // así que no vale la pena partir en un registro por actividad — eso
  // multiplicaría horas/notificaciones/aprobaciones de cabo por una sola
  // sesión real de trabajo).
  const actividades = Array.isArray(actividad) ? actividad : (actividad ? [actividad] : []);
  if (!actividades.length || actividades.some((a) => !ACTIVIDADES_MAQUINARIA.includes(a))) {
    return res.status(400).json({ error: `Indica una o más actividades válidas: ${ACTIVIDADES_MAQUINARIA.join(', ')}` });
  }
  const actividadFinal = actividades.join(', ');
  const esAdmin = req.user.puesto === 'admin' || req.user.puesto === 'desarrollador';
  const operadorFinal = esAdmin && operador_id ? Number(operador_id) : req.user.id;
  const registro = await maquinaria.createHoras({
    equipo_id: Number(equipo_id), operador_id: operadorFinal, fecha, horas: Number(horas), obra_id, actividad: actividadFinal,
  });
  // Avisa a todos los cabo activos (sin scoping por obra — mismo alcance sin
  // asignación por-obra que el resto del módulo Maquinaria, ver diagnóstico
  // en prompt-3-flujo-aprobacion-cabo-operador.md). Reutiliza crearNotificacion
  // (mismo patrón que notificarAdmins en server/notificaciones.js) en vez de
  // agregar una función nueva ahí — este endpoint ya era el 6to archivo
  // permitido por el prompt, no hacía falta un 7mo.
  const { rows: cabosActivos } = await db.pool.query("SELECT id FROM usuarios WHERE puesto = 'cabo' AND activo = true");
  await Promise.all(cabosActivos.map((c) => crearNotificacion(
    c.id, obra_id || null, 'maquinaria_horas_pendiente', registro.id,
    `${req.user.nombre} capturó un reporte de horas (${actividadFinal}) pendiente de autorización`
  )));
  res.status(201).json(registro);
}));

// cabo (o admin/desarrollador vía bypass de checkPermiso) autoriza o rechaza
// un reporte 'pendiente' — mismo criterio de checkPermiso('...', 'puede_editar')
// que ya usan Nómina/Requisiciones para su transición de estado. La
// transición atómica pendiente->estado vive en maquinaria.updateEstadoHoras
// (WHERE estado='pendiente'); si no hay fila afectada (ya revisado, no
// existe, o inactivo) devolvemos 409, no 404, porque no sabemos cuál de los
// tres casos aplica sin una segunda consulta.
app.put('/api/maquinaria/horas/:id/estado', h(auth.checkPermiso('maquinaria_captura', 'puede_editar')), h(async (req, res) => {
  const { estado } = req.body || {};
  if (!['autorizado', 'rechazado'].includes(estado)) {
    return res.status(400).json({ error: "Estado inválido — usa 'autorizado' o 'rechazado'" });
  }
  const registro = await maquinaria.updateEstadoHoras(Number(req.params.id), estado, req.user.id);
  if (!registro) return res.status(409).json({ error: 'El reporte no existe, ya fue revisado, o ya no está activo' });
  res.json(registro);
}));

app.delete('/api/maquinaria/horas/:id', h(auth.checkPermiso('maquinaria', 'puede_eliminar')), h(async (req, res) => {
  const ok = await maquinaria.softDeleteHoras(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: 'Registro no encontrado' });
  res.json({ ok: true });
}));

// =========================================================================
// Estado de la unidad (prompt-6-estado-unidad-operador.md) — checklist
// rápido de seguridad/preventivos capturado por el operador sobre SU unidad
// asignada. Catálogo fijo por categoría (mismo criterio que
// ACTIVIDADES_MAQUINARIA arriba): el backend es quien valida de verdad, el
// frontend solo pinta un espejo exacto de estas listas.
// =========================================================================
const CHECKLIST_ESTADO_UNIDAD = {
  maquina: [
    { clave: 'fluidos', etiqueta: 'Niveles de fluidos' },
    { clave: 'fugas', etiqueta: 'Fugas visibles' },
    { clave: 'orugas_llantas', etiqueta: 'Estado de orugas/llantas' },
    { clave: 'frenos', etiqueta: 'Frenos' },
    { clave: 'luces_torreta', etiqueta: 'Luces y torreta' },
    { clave: 'alarma_reversa', etiqueta: 'Alarma de reversa' },
    { clave: 'cinturon', etiqueta: 'Cinturón' },
    { clave: 'espejos', etiqueta: 'Espejos' },
    { clave: 'extintor', etiqueta: 'Extintor' },
  ],
  camioneta: [
    { clave: 'fluidos', etiqueta: 'Niveles de fluidos' },
    { clave: 'fugas', etiqueta: 'Fugas visibles' },
    { clave: 'llantas_refaccion', etiqueta: 'Llantas y refacción' },
    { clave: 'frenos', etiqueta: 'Frenos' },
    { clave: 'luces_direccionales', etiqueta: 'Luces y direccionales' },
    { clave: 'cinturones', etiqueta: 'Cinturones' },
    { clave: 'espejos', etiqueta: 'Espejos' },
    { clave: 'extintor', etiqueta: 'Extintor' },
    { clave: 'herramienta_gato', etiqueta: 'Herramienta/gato' },
  ],
};
const ESTADOS_ITEM_VALIDOS = ['ok', 'atencion', 'critico'];

// Listado (cabo/jefe_maquinaria/admin/desarrollador: TODAS las unidades con
// su último estado; operador: solo la(s) suya(s) — mismo criterio de
// aislamiento que listEquipos, prompt-p2-aislamiento-operador.md).
app.get('/api/maquinaria/estado-unidad', h(auth.checkPermiso('estado_unidad', 'puede_ver')), h(async (req, res) => {
  const operadorId = req.user.puesto === 'operador' ? req.user.id : null;
  res.json(await maquinaria.listEstadoUnidadResumen(operadorId));
}));

// Histórico de un equipo específico — mismo patrón 403 (no 404, no exponer
// el equipo) que GET /api/maquinaria/equipos/:id cuando un operador pide
// una unidad que no es la suya.
app.get('/api/maquinaria/estado-unidad/:equipoId', h(auth.checkPermiso('estado_unidad', 'puede_ver')), h(async (req, res) => {
  const equipoId = Number(req.params.equipoId);
  const equipo = await maquinaria.getEquipoById(equipoId);
  if (!equipo) return res.status(404).json({ error: 'Equipo no encontrado' });
  if (req.user.puesto === 'operador' && equipo.operador_asignado_id !== req.user.id) {
    return res.status(403).json({ error: 'No tienes permiso para realizar esta acción' });
  }
  res.json(await maquinaria.listEstadoUnidadHistorico(equipoId));
}));

// Captura — exclusiva de operador sobre SU unidad asignada. Ownership se
// valida en backend ANTES del INSERT (nunca solo en el frontend, mismo
// patrón IDOR que equipos/:id): 403 si equipo_id no es el asignado a este
// operador. items se valida contra el catálogo fijo de la categoría real
// del equipo (no la que mande el cliente) — exactamente las claves
// esperadas, ni de más ni de menos, y solo los 3 estados controlados.
app.post('/api/maquinaria/estado-unidad', h(auth.checkPermiso('estado_unidad', 'puede_crear')), h(async (req, res) => {
  const { equipo_id, fecha, items, lectura, observaciones } = req.body || {};
  if (!equipo_id || !fecha) {
    return res.status(400).json({ error: 'Indica equipo y fecha' });
  }
  const equipo = await maquinaria.getEquipoById(Number(equipo_id));
  if (!equipo) return res.status(404).json({ error: 'Equipo no encontrado' });
  if (equipo.operador_asignado_id !== req.user.id) {
    return res.status(403).json({ error: 'No tienes permiso para realizar esta acción' });
  }
  const catalogo = CHECKLIST_ESTADO_UNIDAD[equipo.categoria];
  if (!catalogo) return res.status(400).json({ error: `Categoría de equipo no soportada: ${equipo.categoria}` });
  if (!(lectura >= 0)) {
    return res.status(400).json({ error: 'Indica una lectura válida (horómetro/kilometraje)' });
  }
  if (!Array.isArray(items) || items.length !== catalogo.length) {
    return res.status(400).json({ error: 'Completa todos los puntos del checklist' });
  }
  const clavesEsperadas = new Set(catalogo.map((c) => c.clave));
  const clavesRecibidas = new Set(items.map((it) => it?.clave));
  const itemsValidos = items.every((it) =>
    clavesEsperadas.has(it?.clave) && ESTADOS_ITEM_VALIDOS.includes(it?.estado)
  );
  if (!itemsValidos || clavesRecibidas.size !== catalogo.length) {
    return res.status(400).json({ error: 'Checklist incompleto o con valores inválidos' });
  }
  const itemsNormalizados = catalogo.map((c) => {
    const capturado = items.find((it) => it.clave === c.clave);
    return {
      clave: c.clave, etiqueta: c.etiqueta, estado: capturado.estado,
      nota: typeof capturado.nota === 'string' && capturado.nota.trim() ? capturado.nota.trim() : undefined,
    };
  });
  const registro = await maquinaria.createEstadoUnidad({
    equipo_id: equipo.id, operador_id: req.user.id, fecha, tipo_unidad: equipo.categoria,
    items: itemsNormalizados, lectura: Number(lectura), observaciones: observaciones?.trim(),
  });
  const tieneCritico = itemsNormalizados.some((it) => it.estado === 'critico');
  if (tieneCritico) {
    // Mismo criterio que maquinaria_horas_pendiente arriba: avisa a todos los
    // cabo y jefe_maquinaria activos (sin scoping por obra, mismo alcance
    // sin asignación por-obra que el resto del módulo).
    const { rows: supervisores } = await db.pool.query(
      "SELECT id FROM usuarios WHERE puesto IN ('cabo', 'jefe_maquinaria') AND activo = true"
    );
    await Promise.all(supervisores.map((s) => crearNotificacion(
      s.id, equipo.obra_id || null, 'estado_unidad_critico', registro.id,
      `${req.user.nombre} reportó un punto CRÍTICO en el estado de "${equipo.nombre}"`
    )));
  }
  res.status(201).json({ ...registro, tiene_critico: tieneCritico });
}));

// =========================================================================
// Programa de consumibles (prompt-10-programa-consumibles.md) — captura de
// operador sobre su unidad: diesel + 3 aceites (motor/hidráulico/
// transmisión). Diesel se guarda en combustible_maquinaria (decisión
// consultada: NO se duplica una tabla nueva para algo que ya existe) con
// ownership validado aquí — a diferencia de POST /api/maquinaria/combustible
// (jefe_maquinaria, sin restricción de unidad), este endpoint es exclusivo
// del operador dueño del equipo. Los 3 aceites sí son consumibles_maquinaria,
// tabla nueva de verdad.
// =========================================================================
const TIPOS_CONSUMIBLE = ['diesel', 'gasolina', 'aceite_motor', 'aceite_hidraulico', 'aceite_transmision'];

app.get('/api/maquinaria/consumibles', h(auth.checkPermiso('maquinaria_consumibles', 'puede_ver')), h(async (req, res) => {
  const operadorId = req.user.puesto === 'operador' ? req.user.id : null;
  const equipoId = req.query.equipo_id ? Number(req.query.equipo_id) : null;
  const registros = await maquinaria.listConsumibles({
    equipoId, operadorId,
    fechaDesde: req.query.desde || null, fechaHasta: req.query.hasta || null,
  });
  // Resumen acumulado por unidad+tipo — mismo criterio de agregación en JS
  // que getResumen/getReportePorCliente (server/maquinaria.js), sin
  // duplicar la query: se calcula sobre el mismo dataset ya filtrado.
  const resumenMap = new Map();
  for (const r of registros) {
    const key = `${r.equipo_id}|${r.tipo}`;
    if (!resumenMap.has(key)) {
      resumenMap.set(key, {
        equipo_id: r.equipo_id, equipo_nombre: r.equipo_nombre, tipo: r.tipo,
        unidad: r.unidad, total_cantidad: 0, total_costo_estimado: 0, n_registros: 0,
      });
    }
    const acc = resumenMap.get(key);
    acc.total_cantidad += Number(r.cantidad);
    acc.total_costo_estimado += Number(r.costo_estimado) || 0;
    acc.n_registros += 1;
  }
  res.json({ registros, resumen: [...resumenMap.values()] });
}));

app.post('/api/maquinaria/consumibles', h(auth.checkPermiso('maquinaria_consumibles', 'puede_crear')), h(async (req, res) => {
  const { equipo_id, tipo, cantidad, lectura, fecha } = req.body || {};
  if (!equipo_id || !fecha) return res.status(400).json({ error: 'Indica equipo y fecha' });
  if (!TIPOS_CONSUMIBLE.includes(tipo)) {
    return res.status(400).json({ error: `Indica un tipo válido: ${TIPOS_CONSUMIBLE.join(', ')}` });
  }
  if (!(Number(cantidad) > 0)) return res.status(400).json({ error: 'Indica una cantidad válida' });

  const equipo = await maquinaria.getEquipoById(Number(equipo_id));
  if (!equipo) return res.status(404).json({ error: 'Equipo no encontrado' });
  if (equipo.operador_asignado_id !== req.user.id) {
    return res.status(403).json({ error: 'No tienes permiso para realizar esta acción' });
  }

  const insumo = await maquinaria.resolverCostoConsumible(tipo);
  const lecturaNum = lectura != null && lectura !== '' ? Number(lectura) : null;

  let registro;
  if (tipo === 'diesel') {
    registro = await maquinaria.createCombustible({
      equipo_id: equipo.id, fecha, litros: Number(cantidad),
      costo: insumo ? Number(insumo.precio_presupuesto) * Number(cantidad) : 0,
      registrado_por: req.user.id, lectura: lecturaNum,
    });
  } else {
    registro = await maquinaria.createConsumible({
      equipo_id: equipo.id, tipo, cantidad: Number(cantidad), unidad: 'litros',
      lectura: lecturaNum, operador_id: req.user.id, fecha,
      costo_estimado: insumo ? Number(insumo.precio_presupuesto) * Number(cantidad) : null,
      insumo_id: insumo ? insumo.id : null,
    });
  }
  res.status(201).json({ ...registro, tipo, costo_resuelto_de_insumo: !!insumo });
}));

// Cifras de presupuesto (monto total, gastado, % consumido) — solo
// admin/desarrollador; el resto de roles con acceso a Maquinaria ve el
// catálogo/combustible/mantenimiento/horas pero no estos montos.
app.get('/api/maquinaria/resumen', h(auth.checkPermiso('maquinaria', 'puede_ver')), h(async (req, res) => {
  if (req.user.puesto !== 'admin' && req.user.puesto !== 'desarrollador') {
    return res.json({
      monto_total: null, gasto_combustible: null, gasto_mantenimiento: null,
      gasto_total: null, pct_gastado: null, alerta: false, umbral_alerta_pct: null,
    });
  }
  res.json(await maquinaria.getResumen());
}));

app.put('/api/maquinaria/presupuesto', h(auth.checkPermiso('maquinaria', 'puede_editar')), h(async (req, res) => {
  const { monto_total } = req.body || {};
  if (!(monto_total >= 0)) return res.status(400).json({ error: 'Indica un monto total válido' });
  const presupuesto = await maquinaria.updatePresupuesto(Number(monto_total));
  res.json(presupuesto);
}));

// Presupuesto sugerido (Fase 2, prompt-maquinaria-presupuesto-automatico) —
// solo lectura, para prellenar el campo de edición manual. No toca
// presupuesto_maquinaria por sí solo.
app.get('/api/maquinaria/presupuesto-sugerido', h(auth.checkPermiso('maquinaria', 'puede_ver')), h(async (req, res) => {
  if (req.user.puesto !== 'admin' && req.user.puesto !== 'desarrollador') return res.json(null);
  res.json(await maquinaria.getPresupuestoSugerido());
}));

// Tabla "Presupuesto sugerido por cliente" — mismo criterio que /resumen,
// solo admin/desarrollador. El cálculo (maquinaria.getReportePorCliente)
// no se toca, solo su visibilidad.
app.get('/api/maquinaria/reporte-clientes', h(auth.checkPermiso('maquinaria', 'puede_ver')), h(async (req, res) => {
  if (req.user.puesto !== 'admin' && req.user.puesto !== 'desarrollador') return res.json(null);
  res.json(await maquinaria.getReportePorCliente());
}));

// ---------------------------------------------------------------------------
// Cotizador de materiales (Home Depot / Sodimac / Amazon) — solo compras/
// admin/desarrollador (auth.allow('compras')). Materiales Valdez quedó fuera
// del comparador: su sitio no publica precios en línea. Mercado Libre y
// Construrama también quedaron fuera: bloqueo consistente de bot-detection
// real confirmado en diagnóstico de Fase 0 (ver server/cotizador.js).
// ---------------------------------------------------------------------------
app.get('/api/cotizador/config', h(auth.allow('compras')), h(async (req, res) => {
  res.json(await cotizador.getConfig());
}));

app.put('/api/cotizador/config', h(auth.allow('compras')), h(async (req, res) => {
  const { ciudad, codigo_postal } = req.body || {};
  const resultado = await cotizador.setConfig({ ciudad, codigo_postal, usuario_id: req.user.id });
  res.json(resultado);
}));

app.get('/api/cotizador/buscar', h(auth.allow('compras')), h(async (req, res) => {
  const { q } = req.query;
  if (!q || !q.trim()) return res.status(400).json({ error: 'Indica un término de búsqueda (?q=)' });
  try {
    const resultado = await cotizador.buscarPrecios(q);
    res.json(resultado);
  } catch (err) {
    res.status(502).json({ error: `No se pudo consultar precios: ${err.message}` });
  }
}));

app.post('/api/cotizador/actualizar', h(auth.allow('compras')), h(async (req, res) => {
  const { q } = req.body || {};
  if (!q || !q.trim()) return res.status(400).json({ error: 'Indica un término de búsqueda' });
  try {
    const resultado = await cotizador.buscarPrecios(q, { forzar: true });
    res.json(resultado);
  } catch (err) {
    res.status(502).json({ error: `No se pudo actualizar precios: ${err.message}` });
  }
}));

app.get('/api/cron/cotizador-refresh', requireCronSecret, h(async (req, res) => {
  const queries = await cotizador.queriesRecientes();
  const resultados = [];
  for (const q of queries) {
    try {
      await cotizador.scrapeEnVivo(q);
      resultados.push({ query: q, ok: true });
    } catch (err) {
      resultados.push({ query: q, ok: false, error: err.message });
    }
  }
  res.json({ queriesRefrescadas: resultados.length, resultados });
}));

// ---------------------------------------------------------------------------
// Clientes (agrupador de proyectos). No hay tabla usuario_clientes: el acceso
// se deriva de si el usuario tiene acceso a >=1 proyecto de ese cliente vía
// usuario_proyectos (admin ve todos, igual que en GET /api/projects).
// ---------------------------------------------------------------------------
// prompt-URGENTE-fix-acceso-todos-presupuestos.md: 'admin' ve TODO siempre,
// sin excepción -- nunca requiere ni respeta fila en usuario_proyectos (así
// fue siempre, y así se queda). 'desarrollador' es distinto: si un admin le
// asignó filas explícitas en usuario_proyectos (vía el panel de "Obras
// asignadas"), esas filas SÍ deben restringirlo -- antes de este fix,
// 'desarrollador' bypaseaba el filtro incondicionalmente igual que 'admin'
// (PR #170), así que esa asignación quedaba sin efecto real: el usuario
// seguía viendo TODOS los clientes/obras (y, al ser 'desarrollador' real,
// también los botones de administración "Cambiar cliente"/"Eliminar" en el
// drawer, gateados client-side solo por isAdmin()) -- confirmado con
// evidencia HTTP real (login como desarrollador de prueba con 2 obras
// asignadas → devolvía las 7 obras de los 3 clientes, no solo esas 2).
// Un 'desarrollador' SIN ninguna fila en usuario_proyectos (el caso que
// PR #170 vino a arreglar: su propio cliente/obra recién creado, antes de
// que nadie le asigne nada) sigue viendo todo -- eso no cambia aquí.
// Orden personalizado: LEFT JOIN a orden_clientes_usuario del usuario actual.
// Clientes sin fila de orden guardada (nunca reordenados, o creados después
// del último guardado) quedan con posicion NULL y se van al final por nombre
// — así un cliente nuevo siempre aparece (al final) sin romper el orden ya
// guardado de los demás.
// 'jefe_maquinaria' (fix/jefe-maquinaria-bootstrap-403, PR #51) y 'operador'
// (prompt-2-rol-operador-actividades.md) agregados aquí, en /api/bienvenida
// y en /api/projects — este endpoint y esos otros dos son parte del
// arranque base de la app (bootApp()), sin los cuales CUALQUIER usuario
// con alguno de estos 2 roles recibía 403 en los 3 y nunca podía cargar la
// app (el gap existía desde ANTES de PR #49 — 'taller' tampoco estaba en
// esta lista desde que /api/bienvenida se creó, no es algo que introdujo
// ningún rename). NO se agrega a los demás endpoints con este mismo
// allow() literal (ordenes, programa, conceptos, etc.) — ambos roles solo
// tienen el tab 'maquinaria' (vista global, no por-obra).
app.get('/api/clientes', h(auth.allow('residente', 'cabo', 'compras', 'tesoreria', 'administracion', 'logistica', 'jefe_maquinaria', 'operador', 'costos')), h(async (req, res) => {
  const veTodo = req.user.puesto === 'admin'
    || (req.user.puesto === 'desarrollador' && !(await db.usuarioTieneAsignacionExplicita(req.user.id)));
  if (veTodo) {
    const { rows } = await db.pool.query(`
      SELECT c.id, c.nombre, COUNT(p.id)::int AS num_proyectos
      FROM clientes c
      LEFT JOIN proyectos p ON p.cliente_id = c.id
      LEFT JOIN orden_clientes_usuario ocu ON ocu.cliente_id = c.id AND ocu.usuario_id = $1
      GROUP BY c.id, c.nombre, ocu.posicion
      ORDER BY ocu.posicion NULLS LAST, c.nombre
    `, [req.user.id]);
    return res.json(rows);
  }
  const { rows } = await db.pool.query(`
    SELECT c.id, c.nombre, COUNT(DISTINCT p.id)::int AS num_proyectos
    FROM clientes c
    JOIN proyectos p ON p.cliente_id = c.id
    JOIN usuario_proyectos up ON up.project_id = p.id AND up.usuario_id = $1
    LEFT JOIN orden_clientes_usuario ocu ON ocu.cliente_id = c.id AND ocu.usuario_id = $1
    GROUP BY c.id, c.nombre, ocu.posicion
    ORDER BY ocu.posicion NULLS LAST, c.nombre
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

// Guarda el orden completo de tarjetas de cliente para el usuario actual —
// se reescribe entera (no upsert incremental) porque el frontend siempre
// manda el arreglo completo tras soltar el drag and drop.
app.put('/api/clientes/orden', h(auth.allow('residente', 'cabo', 'compras', 'tesoreria', 'administracion', 'logistica')), h(async (req, res) => {
  const { orden } = req.body || {};
  if (!Array.isArray(orden) || !orden.length) {
    return res.status(400).json({ error: 'Se requiere un arreglo "orden" con los IDs de cliente' });
  }
  await db.withTransaction(async (client) => {
    await client.query('DELETE FROM orden_clientes_usuario WHERE usuario_id = $1', [req.user.id]);
    for (let i = 0; i < orden.length; i++) {
      await client.query(
        'INSERT INTO orden_clientes_usuario (usuario_id, cliente_id, posicion) VALUES ($1, $2, $3)',
        [req.user.id, Number(orden[i]), i]
      );
    }
  });
  res.json({ ok: true });
}));

// Eliminar cliente: solo admin/desarrollador (auth.allow() sin roles extra).
// Bloquea el borrado si el cliente tiene >=1 obra asociada — regla del
// proyecto de no destruir datos financieros; el usuario debe reasignar o
// eliminar esas obras primero. Sin soft-delete: un cliente sin obras no
// tiene ningún dato real que perder, así que el DELETE físico es seguro.
app.delete('/api/clientes/:id', h(auth.allow()), h(async (req, res) => {
  const id = Number(req.params.id);
  const { rows: obras } = await db.pool.query(
    'SELECT id, nombre FROM proyectos WHERE cliente_id = $1 ORDER BY nombre', [id]
  );
  if (obras.length) {
    return res.status(409).json({
      error: `No se puede eliminar: este cliente tiene ${obras.length} obra${obras.length === 1 ? '' : 's'} asociada${obras.length === 1 ? '' : 's'} (${obras.map((o) => o.nombre).join(', ')}). Reasigna o elimina esas obras primero.`,
      obras,
    });
  }
  const { rowCount } = await db.pool.query('DELETE FROM clientes WHERE id = $1', [id]);
  if (!rowCount) return res.status(404).json({ error: 'Cliente no encontrado' });
  res.json({ ok: true });
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

// Dashboard "Avance por cliente" (prompt-dashboard-favoritos-layout.md) —
// agregado POR CLIENTE (no por obra individual, eso ya es "Mayor avance";
// no el promedio global, eso ya es "Resumen Global" de arriba). Mismo
// query base y MISMA fórmula de ponderación que /resumen-global
// (importe_ejecutado = Σ presupuesto_i × avance_i / total_contratos_i),
// solo que agrupada por cliente_id en vez de sumada globalmente — así el
// criterio de "avance ponderado" es idéntico en toda la app, no un
// cálculo nuevo inventado para este componente.
app.get('/api/avance-por-cliente', h(auth.allow()), h(async (req, res) => {
  const { rows } = await db.pool.query(`
    SELECT
      c.id AS cliente_id,
      c.nombre AS cliente_nombre,
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
    JOIN clientes c ON c.id = p.cliente_id
  `);

  const porCliente = new Map();
  for (const r of rows) {
    if (!porCliente.has(r.cliente_id)) {
      porCliente.set(r.cliente_id, { cliente_id: r.cliente_id, cliente_nombre: r.cliente_nombre, totalContratos: 0, importeEjecutado: 0 });
    }
    const acc = porCliente.get(r.cliente_id);
    acc.totalContratos += Number(r.presupuesto_total);
    acc.importeEjecutado += Number(r.presupuesto_total) * Number(r.avance_ejecutado_pct) / 100;
  }

  const resultado = [...porCliente.values()]
    .map((c) => ({
      cliente_id: c.cliente_id,
      cliente_nombre: c.cliente_nombre,
      avance_ponderado_pct: c.totalContratos > 0 ? Number(((c.importeEjecutado / c.totalContratos) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.avance_ponderado_pct - a.avance_ponderado_pct)
    .slice(0, 4);

  res.json(resultado);
}));

// Avance por cliente COMPLETO (todos los clientes, no solo top-4) + desglose
// por obra — vista dedicada 'avance_clientes' (prompt-avance-acumulado-
// cliente-global.md). Misma query/fórmula de ponderación que el endpoint
// top-4 de arriba (Σ presupuesto_i × avance_i/100 / Σ presupuesto_i), sin
// tocarlo, para no alterar el widget del dashboard que ya lo consume. Mismo
// alcance de acceso (auth.allow() = admin/desarrollador) que ese widget —
// el avance global (cruzando TODOS los clientes) ya existe como
// avance_ponderado_pct en GET /api/resumen-global, así que no se duplica
// aquí ese cálculo.
app.get('/api/avance-por-cliente/completo', h(auth.allow()), h(async (req, res) => {
  const { rows } = await db.pool.query(`
    SELECT
      c.id AS cliente_id,
      c.nombre AS cliente_nombre,
      p.id AS project_id,
      p.nombre AS obra_nombre,
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
    JOIN clientes c ON c.id = p.cliente_id
    ORDER BY c.nombre, p.nombre
  `);

  const porCliente = new Map();
  for (const r of rows) {
    if (!porCliente.has(r.cliente_id)) {
      porCliente.set(r.cliente_id, { cliente_id: r.cliente_id, cliente_nombre: r.cliente_nombre, totalPresupuesto: 0, importeEjecutado: 0, obras: [] });
    }
    const acc = porCliente.get(r.cliente_id);
    const presupuesto = Number(r.presupuesto_total);
    const avancePct = Number(r.avance_ejecutado_pct);
    acc.totalPresupuesto += presupuesto;
    acc.importeEjecutado += presupuesto * avancePct / 100;
    acc.obras.push({ project_id: r.project_id, obra_nombre: r.obra_nombre, presupuesto_total: presupuesto, avance_pct: avancePct });
  }

  const resultado = [...porCliente.values()]
    .map((c) => ({
      cliente_id: c.cliente_id,
      cliente_nombre: c.cliente_nombre,
      presupuesto_total: Number(c.totalPresupuesto.toFixed(2)),
      avance_ponderado_pct: c.totalPresupuesto > 0 ? Number(((c.importeEjecutado / c.totalPresupuesto) * 100).toFixed(1)) : 0,
      obras: c.obras.sort((a, b) => b.presupuesto_total - a.presupuesto_total),
    }))
    .sort((a, b) => b.avance_ponderado_pct - a.avance_ponderado_pct);

  res.json(resultado);
}));

// ---------------------------------------------------------------------------
// Dashboard Ejecutivo (prompt-dashboard-ejecutivo.md): agregador multi-obra
// que consolida, en una sola pantalla, lo que hoy solo existe disperso
// por-obra o solo a nivel global — avance físico/financiero por obra (mismo
// query base que /api/resumen-global, pero SIN colapsar a un solo agregado),
// compromisos abiertos y fondo de garantía por obra (getCompromisosAbiertos-
// Agregado/getFondoGarantiaAgregado en finanzas.js), alertas de contrato
// próximas a vencer (mismo cálculo que ya usa el cron de
// /api/cron/alertas-vencimiento, aquí solo LECTURA en memoria, sin
// persistir/notificar nada) y cumplimiento de proveedores (bloque aparte,
// sin relación a obra — mismo query que /api/cumplimiento).
//
// Acceso: admin/desarrollador (bypass de auth.allow, ven todas las obras) +
// tesorería (único rol no-admin que hoy ya ve Compromisos Abiertos/Fondo de
// Garantía por-obra), filtrado a sus obras vía usuario_proyectos — mismo
// patrón IDOR que getProgramaSuministrosData (admin sin filtro, resto con
// JOIN usuario_proyectos), decisión confirmada explícitamente (no se abrió
// a otros roles que hoy no tienen acceso a datos financieros).
// ---------------------------------------------------------------------------
function alertaContratoDeObra(finObra) {
  if (!finObra) return null;
  const diasRestantes = calcularDiasRestantes(finObra);
  if (diasRestantes === null) return null;
  if (diasRestantes < 0) return { umbral: 'vencido', dias_restantes: diasRestantes, fin_obra: finObra };
  if (diasRestantes > 30) return null;
  const umbral = diasRestantes <= 7 ? '7' : diasRestantes <= 15 ? '15' : '30';
  return { umbral, dias_restantes: diasRestantes, fin_obra: finObra };
}

app.get('/api/dashboard-ejecutivo', h(auth.allow('tesoreria')), h(async (req, res) => {
  // prompt-URGENTE-fix-acceso-todos-presupuestos.md: mismo criterio que
  // GET /api/clientes/GET /api/projects/verificarAccesoObra -- 'desarrollador'
  // con usuario_proyectos asignado se restringe igual que cualquier otro rol.
  const esAdmin = req.user.puesto === 'admin'
    || (req.user.puesto === 'desarrollador' && !(await db.usuarioTieneAsignacionExplicita(req.user.id)));

  const params = [];
  let join = '';
  if (!esAdmin) {
    params.push(req.user.id);
    join = `JOIN usuario_proyectos up ON up.project_id = p.id AND up.usuario_id = $${params.length}`;
  }

  const { rows: obrasRaw } = await db.pool.query(`
    SELECT
      p.id AS project_id, p.nombre AS obra_nombre, c.id AS cliente_id, c.nombre AS cliente_nombre,
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
      ) AS avance_ejecutado_pct,
      (SELECT valor FROM meta WHERE project_id = p.id AND clave = 'fin_obra') AS fin_obra
    FROM proyectos p
    JOIN clientes c ON c.id = p.cliente_id
    ${join}
    ORDER BY c.nombre, p.nombre
  `, params);

  const pids = obrasRaw.map((o) => o.project_id);

  const [compromisos, fondoGarantia, cumplimientoData] = await Promise.all([
    getCompromisosAbiertosAgregado(pids),
    getFondoGarantiaAgregado(pids),
    getCumplimientoResumenData(),
  ]);
  const compromisosPorObra = new Map(compromisos.porObra.map((o) => [o.project_id, o]));
  const fondoGarantiaPorObra = new Map(fondoGarantia.porObra.map((o) => [o.project_id, o]));

  let totalContratos = 0, importeEjecutado = 0;
  const obras = obrasRaw.map((o) => {
    const presupuesto = Number(o.presupuesto_total);
    const avancePct = Number(o.avance_ejecutado_pct);
    totalContratos += presupuesto;
    importeEjecutado += presupuesto * avancePct / 100;
    return {
      project_id: o.project_id,
      obra_nombre: o.obra_nombre,
      cliente_id: o.cliente_id,
      cliente_nombre: o.cliente_nombre,
      presupuesto_total: Number(presupuesto.toFixed(2)),
      avance_ejecutado_pct: avancePct,
      compromisos: compromisosPorObra.get(o.project_id) || { monto_total: 0, monto_pagado: 0, monto_pendiente: 0 },
      fondo_garantia: fondoGarantiaPorObra.get(o.project_id) || { porcentaje_pactado: null, acumulado: 0 },
      alerta_contrato: alertaContratoDeObra(o.fin_obra),
    };
  });

  res.json({
    kpis: {
      num_proyectos: obras.length,
      total_contratos: Number(totalContratos.toFixed(2)),
      importe_ejecutado: Number(importeEjecutado.toFixed(2)),
      importe_por_ejecutar: Number((totalContratos - importeEjecutado).toFixed(2)),
      avance_ponderado_pct: totalContratos > 0 ? Number(((importeEjecutado / totalContratos) * 100).toFixed(1)) : 0,
    },
    obras,
    compromisos_total: compromisos.total,
    fondo_garantia_total: { acumulado: fondoGarantia.acumulado_total },
    cumplimiento: cumplimientoData,
  });
}));

// ---------------------------------------------------------------------------
// Composición de costos por categoría (docs/diseno-desglose-presupuesto-
// categorias, diseño aprobado por Paul commit 795c993) — compara, por cada
// una de las 5 categorías de la cédula (Materiales/Mano de Obra/Carga
// Social/Herramienta y Equipo/Indirecto y Utilidad), el % "base" (subtotales
// del Contrato si la obra los tiene, o si no el % estándar de referencia
// configurable) contra el % real calculado desde insumos.categoria. Es una
// comparación ESTÁTICA del presupuesto total — no involucra avance/ejecución.
// Carga Social e Indirecto NO existen del lado insumos (gap confirmado en el
// diagnóstico, con evidencia real: 0 filas con esas categorías en ~2500
// insumos) — su pct_real siempre es null, nunca 0.
// ---------------------------------------------------------------------------
const COMPOSICION_CATS = [
  { key: 'materiales', label: 'Materiales', insumoCat: 'MATERIALES', metaKey: 'subtotal_materiales' },
  { key: 'mano_obra', label: 'Mano de Obra', insumoCat: 'MANO DE OBRA', metaKey: 'subtotal_mano_obra' },
  { key: 'carga_social', label: 'Carga Social', insumoCat: null, metaKey: 'subtotal_carga_social' },
  // insumos.categoria guarda 'EQUIPO Y HERRAMIENTA' (viene del Excel, mismo
  // string que ya usa server/maquinaria.js#getPresupuestoSugerido) — no se
  // toca ese valor en BD, solo se unifica la etiqueta de display aquí.
  { key: 'herramienta_equipo', label: 'Herramienta y Equipo', insumoCat: 'EQUIPO Y HERRAMIENTA', metaKey: 'subtotal_herramienta_equipo' },
  { key: 'indirecto_utilidad', label: 'Indirecto y Utilidad', insumoCat: null, metaKey: 'indirecto_utilidad' },
];
const COMPOSICION_UMBRAL_PP = 5;

// meta: {clave: valor} de una obra. insumosPorCategoria: {'MATERIALES': suma, ...}.
// referencia: {materiales: pct, mano_obra: pct, ...} de porcentajes_referencia_costo.
function calcularComposicionObra(meta, insumosPorCategoria, referencia) {
  const totalReal = Object.values(insumosPorCategoria).reduce((s, v) => s + v, 0);
  // "Tiene contrato" = tiene los 2 valores que hacen falta para calcular las
  // 5 bases (costo_directo para las primeras 4, importe_contratado para
  // Indirecto) — mismo criterio en toda la función, no por categoría suelta.
  const tieneContrato = meta.subtotal_costo_directo != null && meta.importe_contratado != null;
  const costoDirecto = tieneContrato ? Number(meta.subtotal_costo_directo) : null;
  const importeContratado = tieneContrato ? Number(meta.importe_contratado) : null;

  return COMPOSICION_CATS.map((c) => {
    const sumaReal = c.insumoCat ? insumosPorCategoria[c.insumoCat] : undefined;
    const pctReal = (sumaReal != null && totalReal > 0)
      ? Number(((sumaReal / totalReal) * 100).toFixed(1))
      : null;

    let pctBase = null;
    const baseFuente = tieneContrato ? 'contrato' : 'referencia_estandar';
    if (tieneContrato) {
      const valorMeta = meta[c.metaKey] != null ? Number(meta[c.metaKey]) : null;
      if (valorMeta != null) {
        pctBase = c.key === 'indirecto_utilidad'
          ? (importeContratado > 0 ? Number(((valorMeta / importeContratado) * 100).toFixed(2)) : null)
          : (costoDirecto > 0 ? Number(((valorMeta / costoDirecto) * 100).toFixed(2)) : null);
      }
    } else {
      pctBase = referencia[c.key] != null ? Number(referencia[c.key]) : null;
    }

    const diferencia = (pctReal != null && pctBase != null) ? Number((pctReal - pctBase).toFixed(1)) : null;
    return {
      categoria: c.key, label: c.label,
      pct_real: pctReal, pct_base: pctBase, base_fuente: baseFuente,
      diferencia_pp: diferencia,
      significativa: diferencia != null && Math.abs(diferencia) > COMPOSICION_UMBRAL_PP,
    };
  });
}

// Pondera por presupuesto — mismo criterio matemático que GET /api/avance-por-
// cliente/completo (PR #47): peso_obra = presupuesto_obra / Σ presupuesto.
// Aquí se aplica por separado a cada categoría/serie, usando SOLO las obras
// que tienen dato (campo != null) para esa categoría específica — un "sin
// dato" nunca se trata como 0, ni en el numerador ni en el denominador.
function ponderarSerie(obras, campo) {
  let sumaPresupuestoConDato = 0;
  let sumaPonderada = 0;
  for (const o of obras) {
    const valor = o[campo];
    if (valor == null) continue;
    sumaPresupuestoConDato += o.presupuesto;
    sumaPonderada += valor * o.presupuesto;
  }
  return sumaPresupuestoConDato > 0 ? Number((sumaPonderada / sumaPresupuestoConDato).toFixed(1)) : null;
}

app.get('/api/porcentajes-referencia', h(auth.allow('costos')), h(async (req, res) => {
  const { rows } = await db.pool.query('SELECT categoria, porcentaje FROM porcentajes_referencia_costo ORDER BY id');
  res.json(rows);
}));

app.put('/api/porcentajes-referencia', h(auth.allow('costos')), h(async (req, res) => {
  const body = req.body || {};
  await db.withTransaction(async (client) => {
    for (const c of COMPOSICION_CATS) {
      if (body[c.key] == null) continue;
      await client.query(
        'UPDATE porcentajes_referencia_costo SET porcentaje = $1, actualizado_por = $2, actualizado_en = NOW() WHERE categoria = $3',
        [Number(body[c.key]), req.user.id, c.key]
      );
    }
  });
  const { rows } = await db.pool.query('SELECT categoria, porcentaje FROM porcentajes_referencia_costo ORDER BY id');
  const suma = rows.reduce((s, r) => s + Number(r.porcentaje), 0);
  res.json({
    porcentajes: rows,
    suma: Number(suma.toFixed(4)),
    advertencia: Math.abs(suma - 100) > 0.01 ? `Los 5 porcentajes suman ${suma.toFixed(2)}%, no 100%.` : null,
  });
}));

app.get('/api/projects/:id/composicion-costos', h(auth.allow('costos')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const pid = req.project.id;
  const [{ rows: insumoRows }, { rows: metaRows }, { rows: refRows }] = await Promise.all([
    db.pool.query(
      `SELECT categoria, SUM(importe_presupuesto) AS suma FROM insumos
       WHERE project_id = $1 AND categoria IN ('MATERIALES','MANO DE OBRA','EQUIPO Y HERRAMIENTA')
       GROUP BY categoria`,
      [pid]
    ),
    db.pool.query('SELECT clave, valor FROM meta WHERE project_id = $1', [pid]),
    db.pool.query('SELECT categoria, porcentaje FROM porcentajes_referencia_costo'),
  ]);
  const insumosPorCategoria = {}; for (const r of insumoRows) insumosPorCategoria[r.categoria] = Number(r.suma);
  const meta = {}; for (const r of metaRows) meta[r.clave] = r.valor;
  const referencia = {}; for (const r of refRows) referencia[r.categoria] = Number(r.porcentaje);

  res.json({ categorias: calcularComposicionObra(meta, insumosPorCategoria, referencia) });
}));

app.get('/api/composicion-costos/completo', h(auth.allow('costos')), h(async (req, res) => {
  const [{ rows: proyectoRows }, { rows: insumoRows }, { rows: metaRows }, { rows: totalRows }, { rows: refRows }] = await Promise.all([
    db.pool.query(`SELECT p.id AS project_id, p.cliente_id, c.nombre AS cliente_nombre FROM proyectos p JOIN clientes c ON c.id = p.cliente_id`),
    db.pool.query(
      `SELECT project_id, categoria, SUM(importe_presupuesto) AS suma FROM insumos
       WHERE categoria IN ('MATERIALES','MANO DE OBRA','EQUIPO Y HERRAMIENTA')
       GROUP BY project_id, categoria`
    ),
    db.pool.query('SELECT project_id, clave, valor FROM meta'),
    db.pool.query(`SELECT DISTINCT ON (project_id) project_id, importe FROM conceptos WHERE es_total = 1 AND grupo IS NULL ORDER BY project_id, orden DESC`),
    db.pool.query('SELECT categoria, porcentaje FROM porcentajes_referencia_costo'),
  ]);

  const referencia = {}; for (const r of refRows) referencia[r.categoria] = Number(r.porcentaje);
  const insumosPorObra = {};
  for (const r of insumoRows) {
    insumosPorObra[r.project_id] = insumosPorObra[r.project_id] || {};
    insumosPorObra[r.project_id][r.categoria] = Number(r.suma);
  }
  const metaPorObra = {};
  for (const r of metaRows) {
    metaPorObra[r.project_id] = metaPorObra[r.project_id] || {};
    metaPorObra[r.project_id][r.clave] = r.valor;
  }
  const totalConceptosPorObra = {};
  for (const r of totalRows) totalConceptosPorObra[r.project_id] = Number(r.importe);

  const obras = proyectoRows.map((p) => {
    const meta = metaPorObra[p.project_id] || {};
    const insumosCat = insumosPorObra[p.project_id] || {};
    const presupuesto = meta.total_sin_iva != null ? Number(meta.total_sin_iva) : (totalConceptosPorObra[p.project_id] || 0);
    return {
      project_id: p.project_id, cliente_id: p.cliente_id, cliente_nombre: p.cliente_nombre,
      presupuesto, categorias: calcularComposicionObra(meta, insumosCat, referencia),
    };
  });

  function agregarCategorias(obrasDelGrupo) {
    return COMPOSICION_CATS.map((c) => {
      const items = obrasDelGrupo.map((o) => {
        const fila = o.categorias.find((x) => x.categoria === c.key);
        return { presupuesto: o.presupuesto, real: fila.pct_real, base: fila.pct_base };
      });
      return {
        categoria: c.key, label: c.label,
        pct_real: ponderarSerie(items, 'real'),
        pct_base: ponderarSerie(items, 'base'),
      };
    });
  }

  const porCliente = new Map();
  for (const o of obras) {
    if (!porCliente.has(o.cliente_id)) porCliente.set(o.cliente_id, { cliente_id: o.cliente_id, cliente_nombre: o.cliente_nombre, obras: [] });
    porCliente.get(o.cliente_id).obras.push(o);
  }
  const clientes = [...porCliente.values()]
    .map((g) => ({ cliente_id: g.cliente_id, cliente_nombre: g.cliente_nombre, categorias: agregarCategorias(g.obras) }))
    .sort((a, b) => a.cliente_nombre.localeCompare(b.cliente_nombre));

  res.json({ clientes, global: { categorias: agregarCategorias(obras) } });
}));

// ---------------------------------------------------------------------------
// Costos — catálogo de precios agregado desde insumos ya cargados (prompt-
// modulo-costos.md). Sin auth.allow() a propósito, igual que /api/trabajadores
// y /api/nominas (vistas globales): checkPermiso('costos', accion) es el
// único gate — admin/desarrollador bypasean por diseño (interno a
// checkPermiso), cualquier otro rol necesita una fila explícita en
// permisos_usuario, sin default (ver SECCIONES_PERMISOS en server/auth.js,
// 'costos' no tiene entrada en TAB_A_SECCION).
//
// "Más reciente" se determina con proyectos.creado_en, NO con una columna
// nueva en insumos — el precio de un insumo es inmutable después de ingest()
// (confirmado: el único otro UPDATE a insumos solo toca iva_tasa), así que
// creado_en del proyecto es un proxy 100% confiable de cuándo se capturó ese
// precio. Insumos con codigo NULL quedan fuera del catálogo (sin clave
// estable no hay forma de agruparlos entre obras sin adivinar por
// descripción, que Paul pidió explícitamente no usar como fallback aquí) —
// limitación conocida, no un bug.
async function costosCatalogoQuery(clienteId) {
  const { rows } = await db.pool.query(`
    SELECT DISTINCT ON (i.codigo)
      i.codigo, i.concepto, i.categoria, i.unidad,
      i.precio_presupuesto, i.cantidad_presupuesto, i.iva_tasa,
      p.id AS obra_origen_id, p.nombre AS obra_origen, p.creado_en AS fecha_origen,
      c.id AS cliente_id, c.nombre AS cliente_nombre
    FROM insumos i
    JOIN proyectos p ON p.id = i.project_id
    JOIN clientes c ON c.id = p.cliente_id
    WHERE i.codigo IS NOT NULL ${clienteId ? 'AND p.cliente_id = $1' : ''}
    ORDER BY i.codigo, p.creado_en DESC, i.id DESC
  `, clienteId ? [clienteId] : []);
  return rows;
}

function costosCatalogoExportSheet(rows, sheetName) {
  return {
    sheetName,
    columns: [
      { header: 'Código', key: 'codigo', width: 14 },
      { header: 'Concepto', key: 'concepto', width: 40 },
      { header: 'Categoría', key: 'categoria', width: 18 },
      { header: 'Unidad', key: 'unidad', width: 10 },
      { header: 'Precio (más reciente)', key: 'precio_presupuesto', width: 20, format: 'money' },
      { header: 'IVA (%)', key: 'iva_tasa', width: 10, format: 'int' },
      { header: 'Cliente', key: 'cliente_nombre', width: 24 },
      { header: 'Obra de origen', key: 'obra_origen', width: 30 },
      { header: 'Fecha de origen', key: 'fecha_origen', width: 16 },
    ],
    rows: rows.map((r) => ({
      codigo: r.codigo,
      concepto: r.concepto,
      categoria: r.categoria,
      unidad: r.unidad,
      precio_presupuesto: Number(r.precio_presupuesto),
      iva_tasa: Number(r.iva_tasa),
      cliente_nombre: r.cliente_nombre,
      obra_origen: r.obra_origen,
      fecha_origen: r.fecha_origen,
    })),
  };
}

app.get('/api/costos/catalogo/:clienteId', h(auth.checkPermiso('costos', 'puede_ver')), h(async (req, res) => {
  const clienteId = Number(req.params.clienteId);
  const { rows: clienteRows } = await db.pool.query('SELECT id, nombre FROM clientes WHERE id = $1', [clienteId]);
  if (!clienteRows[0]) return res.status(404).json({ error: 'Cliente no encontrado' });
  const rows = await costosCatalogoQuery(clienteId);
  res.json({ cliente: clienteRows[0], catalogo: rows });
}));

app.get('/api/costos/catalogo/:clienteId/export', h(auth.checkPermiso('costos', 'puede_ver')), h(async (req, res) => {
  const clienteId = Number(req.params.clienteId);
  const { rows: clienteRows } = await db.pool.query('SELECT id, nombre FROM clientes WHERE id = $1', [clienteId]);
  if (!clienteRows[0]) return res.status(404).json({ error: 'Cliente no encontrado' });
  const rows = await costosCatalogoQuery(clienteId);
  await sendXlsxExport(res, {
    filename: buildExportFilename('Catalogo-Costos', clienteRows[0].nombre),
    sheets: [costosCatalogoExportSheet(rows, 'Catálogo')],
  });
}));

app.get('/api/costos/catalogo-global', h(auth.checkPermiso('costos', 'puede_ver')), h(async (req, res) => {
  const rows = await costosCatalogoQuery(null);
  res.json({ catalogo: rows });
}));

app.get('/api/costos/catalogo-global/export', h(auth.checkPermiso('costos', 'puede_ver')), h(async (req, res) => {
  const rows = await costosCatalogoQuery(null);
  await sendXlsxExport(res, {
    filename: buildExportFilename('Catalogo-Costos', 'Global'),
    sheets: [costosCatalogoExportSheet(rows, 'Catálogo global')],
  });
}));

// ---------------------------------------------------------------------------
// Catálogo de Conceptos (partidas de obra) — catálogo nuevo y paralelo al de
// Costos/insumos de arriba (prompt-catalogo-conceptos-implementacion.md, ver
// diagnóstico previo). Mismo patrón exacto (DISTINCT ON codigo, precio más
// reciente por proyectos.creado_en), pero sobre `conceptos` en vez de
// `insumos`, con 2 filtros extra de basura estructural del Excel que insumos
// no necesita — confirmado con datos reales, ninguno de los 2 basta solo:
//   - es_total = 0: excluye filas "TOTAL DEL PRESUPUESTO..." (13.6% de las
//     filas en diagnóstico).
//   - precio_unitario > 0: excluye encabezados de sección/capítulo (precio 0)
//     Y filas de total que el parser dejó con es_total = 0 pero concepto
//     vacío y el monto en letra metido en `codigo` (inconsistencia real del
//     ingest, no cubierta por es_total solo).
// Alias en la SELECT (grupo AS categoria, precio_unitario AS
// precio_presupuesto, cantidad AS cantidad_presupuesto) para que las filas
// tengan EXACTAMENTE la forma que ya esperan openCrearPresupuestoModal() y
// costosFilaHtml() — se reusan tal cual, sin tocarlos (Forbidden Actions).
// 'categoria' aquí es libre por obra (nombre de capítulo, ej. "CIMENTACIÓN"),
// NO la taxonomía cerrada de insumos.categoria — por eso el frontend la
// etiqueta "Grupo/Capítulo", nunca "Categoría" (ver conceptosTablaHtml).
//
// EXCLUIR_OBRAS_DUPLICADAS_CATALOGO: 3 obras de VINTE (ids 13, 41,
// 42 — "715 URBANIZACION AMANI", "Presupuestos Residencial Vinte",
// "Presupuestos Residencial Vinte Contrato 715") son la misma obra cargada 3
// veces (mismos códigos, mismo tamaño — confirmado en diagnóstico). Decisión
// consultada: excluir por lista explícita de project_id — no hay ningún flag
// en el schema que las distinga de una obra real (proyectos NO tiene columna
// activo). Si aparecen más duplicados reales a futuro, hay que sumarlos a
// mano aquí. Las obras NO se tocan ni se borran, solo se excluyen de este
// catálogo agregado.
// id 67 ("prueba1"): no es un duplicado de VINTE, es un proyecto de prueba
// real de Paul sin presupuesto/datos financieros vigentes. Se agrega a esta
// misma lista por el mismo motivo estructural (nada en el schema distingue
// "obra de prueba" de "obra real") — al ser el proyecto más reciente entre
// las obras que comparten código con conceptos reales (ej. 10401-002,
// también en la obra real más vieja "671 CASA CLUB"), el DISTINCT ON lo
// prefería sobre la obra real y el catálogo mostraba "sin destajo/matriz"
// para conceptos que sí tienen todo completo en su obra real.
// Compartida por el catálogo de Conceptos (conceptosCatalogoQuery, dashboard
// de Costos) Y el catálogo de Básicos (basicosCatalogoQuery más abajo) — toda
// obra en esta lista contamina por igual ambos catálogos si algún día tiene
// básicos cargados, no es un problema exclusivo de Conceptos.
const EXCLUIR_OBRAS_DUPLICADAS_CATALOGO = [13, 41, 42, 67];

// Filtro + dedupe compartidos por todo endpoint que necesite "un concepto
// real por código" sobre el catálogo global (activo, no encabezado/total,
// con precio, código no nulo, sin las 3 obras duplicadas de VINTE). Se
// extrajeron a fragmentos de texto SQL (no a una función que devuelva filas)
// para que conceptosCatalogoQuery y GET /api/costos/dashboard compartan
// exactamente el mismo WHERE/ORDER BY sin duplicarlo a mano — cualquier
// cambio futuro al filtro se hace en un solo lugar. Ambos usos asumen que el
// array de exclusión va como parámetro $1 (co/p ya alias FROM conceptos co
// JOIN proyectos p).
const CONCEPTOS_CATALOGO_WHERE_SQL = 'co.activo = 1 AND co.es_total = 0 AND co.precio_unitario > 0 AND co.codigo IS NOT NULL AND p.id <> ALL($1::int[])';
const CONCEPTOS_CATALOGO_ORDER_SQL = 'co.codigo, p.creado_en DESC, co.id DESC';

// prompt-fase1-3-export-import-4-hojas.md: co.id AS concepto_id_origen se
// agrega para que el modal "Crear presupuesto desde catálogo" pueda trazar
// cada concepto seleccionado de vuelta a su obra/concepto real de origen
// (necesario para resolver Destajo/Insumos/Matrices en el export de 4
// hojas) -- obra_origen_id ya existía. Ningún consumidor actual (dashboard,
// export de catálogo de solo lectura) se ve afectado: ambos solo leen las
// claves que ya usaban, un campo extra en la fila no les cambia nada.
//
// prompt-advertencia-catalogo-sin-destajo-matriz.md: tiene_destajo/
// tiene_matriz se agregan como EXISTS correlacionados (no un JOIN + GROUP
// BY) para no alterar la cardinalidad de la fila bajo DISTINCT ON — cada
// EXISTS resuelve por índice (destajo_items ya tiene PK compuesta implícita
// vía FK + WHERE project_id/concepto_id, matrices_precio_unitario tiene
// concepto_id UNIQUE) así que el costo por fila es O(1), no un escaneo.
// matrices_precio_unitario no necesita filtrar por project_id -- concepto_id
// es UNIQUE y ya referencia un concepto de un solo proyecto (igual que hace
// matrizOrigenQuery más abajo, que solo usa el JOIN a conceptos para
// confirmar, nunca para desambiguar).
async function conceptosCatalogoQuery(clienteId) {
  const { rows } = await db.pool.query(`
    SELECT DISTINCT ON (co.codigo)
      co.id AS concepto_id_origen,
      co.codigo, co.concepto, co.grupo AS categoria, co.unidad,
      co.precio_unitario AS precio_presupuesto, co.cantidad AS cantidad_presupuesto,
      p.id AS obra_origen_id, p.nombre AS obra_origen, p.creado_en AS fecha_origen,
      c.id AS cliente_id, c.nombre AS cliente_nombre,
      EXISTS (
        SELECT 1 FROM destajo_items di WHERE di.project_id = p.id AND di.concepto_id = co.id
      ) AS tiene_destajo,
      EXISTS (
        SELECT 1 FROM matrices_precio_unitario m WHERE m.concepto_id = co.id
      ) AS tiene_matriz
    FROM conceptos co
    JOIN proyectos p ON p.id = co.project_id
    JOIN clientes c ON c.id = p.cliente_id
    WHERE ${CONCEPTOS_CATALOGO_WHERE_SQL}
      ${clienteId ? 'AND p.cliente_id = $2' : ''}
    ORDER BY ${CONCEPTOS_CATALOGO_ORDER_SQL}
  `, clienteId
    ? [EXCLUIR_OBRAS_DUPLICADAS_CATALOGO, clienteId]
    : [EXCLUIR_OBRAS_DUPLICADAS_CATALOGO]);
  return rows;
}

function conceptosCatalogoExportSheet(rows, sheetName) {
  return {
    sheetName,
    columns: [
      { header: 'Código', key: 'codigo', width: 14 },
      { header: 'Concepto', key: 'concepto', width: 40 },
      { header: 'Grupo/Capítulo', key: 'categoria', width: 22 },
      { header: 'Unidad', key: 'unidad', width: 10 },
      { header: 'Precio unitario (más reciente)', key: 'precio_presupuesto', width: 24, format: 'money' },
      { header: 'Cliente', key: 'cliente_nombre', width: 24 },
      { header: 'Obra de origen', key: 'obra_origen', width: 30 },
      { header: 'Fecha de origen', key: 'fecha_origen', width: 16 },
    ],
    rows: rows.map((r) => ({
      codigo: r.codigo,
      concepto: r.concepto,
      categoria: r.categoria,
      unidad: r.unidad,
      precio_presupuesto: Number(r.precio_presupuesto),
      cliente_nombre: r.cliente_nombre,
      obra_origen: r.obra_origen,
      fecha_origen: r.fecha_origen,
    })),
  };
}

app.get('/api/costos/catalogo-conceptos/:clienteId', h(auth.checkPermiso('costos', 'puede_ver')), h(async (req, res) => {
  const clienteId = Number(req.params.clienteId);
  const { rows: clienteRows } = await db.pool.query('SELECT id, nombre FROM clientes WHERE id = $1', [clienteId]);
  if (!clienteRows[0]) return res.status(404).json({ error: 'Cliente no encontrado' });
  const rows = await conceptosCatalogoQuery(clienteId);
  res.json({ cliente: clienteRows[0], catalogo: rows });
}));

app.get('/api/costos/catalogo-conceptos/:clienteId/export', h(auth.checkPermiso('costos', 'puede_ver')), h(async (req, res) => {
  const clienteId = Number(req.params.clienteId);
  const { rows: clienteRows } = await db.pool.query('SELECT id, nombre FROM clientes WHERE id = $1', [clienteId]);
  if (!clienteRows[0]) return res.status(404).json({ error: 'Cliente no encontrado' });
  const rows = await conceptosCatalogoQuery(clienteId);
  await sendXlsxExport(res, {
    filename: buildExportFilename('Catalogo-Conceptos', clienteRows[0].nombre),
    sheets: [conceptosCatalogoExportSheet(rows, 'Catálogo')],
  });
}));

app.get('/api/costos/catalogo-conceptos-global', h(auth.checkPermiso('costos', 'puede_ver')), h(async (req, res) => {
  const rows = await conceptosCatalogoQuery(null);
  res.json({ catalogo: rows });
}));

app.get('/api/costos/catalogo-conceptos-global/export', h(auth.checkPermiso('costos', 'puede_ver')), h(async (req, res) => {
  const rows = await conceptosCatalogoQuery(null);
  await sendXlsxExport(res, {
    filename: buildExportFilename('Catalogo-Conceptos', 'Global'),
    sheets: [conceptosCatalogoExportSheet(rows, 'Catálogo global')],
  });
}));

// ---------------------------------------------------------------------------
// Dashboard de Costos (prompt-dashboard-costos-basicos-implementacion.md,
// Tarea 1) — pantalla de entrada a la sección "Costos", antes de picar
// directo a una de las 4 (ahora 5) subsecciones existentes. 100% agregado y
// de solo lectura, sin filtro por cliente ni por obra (mismo alcance
// "global" que catalogo-conceptos-global/catalogo-global arriba). Tres
// bloques independientes — cada uno puede estar vacío sin que los otros dos
// lo estén, el frontend maneja cada caso con su propio "sin datos":
//   1. Cobertura de matrices: cuántos conceptos del catálogo global (mismo
//      WHERE/ORDER BY que conceptosCatalogoQuery arriba, vía las constantes
//      compartidas CONCEPTOS_CATALOGO_WHERE_SQL / CONCEPTOS_CATALOGO_ORDER_SQL
//      — dedupe DISTINCT ON codigo + exclusión de obras duplicadas + filtro
//      es_total=0 AND precio_unitario>0 para no contar encabezados/totales
//      como "conceptos reales") ya tienen una matriz de precio unitario asociada
//      (matrices_precio_unitario.concepto_id, es_basico=false — un básico
//      standalone no es la matriz de NINGÚN concepto real; el LEFT JOIN por
//      concepto_id ya lo excluye por sí solo porque un básico tiene
//      concepto_id NULL, el filtro es_basico=false es solo para dejarlo
//      explícito).
//   2. Insumos con precio inconsistente entre obras: query validada contra
//      datos reales de Preview (margen >5% para filtrar ruido de redondeo),
//      tal cual el diseño del prompt — no se modifica.
//   3. Actividad reciente: últimos registros de audit_log para las 2
//      acciones relevantes de este módulo (importar_matrices,
//      crear_presupuesto_desde_costos) — reusa la tabla tal cual, sin tabla
//      nueva. target_id en ambas acciones es el id de la obra afectada (la
//      obra donde se importaron matrices, o la obra recién creada desde el
//      catálogo), así que un solo LEFT JOIN a proyectos por target_id cubre
//      ambas acciones.
// ---------------------------------------------------------------------------
app.get('/api/costos/dashboard', h(auth.checkPermiso('costos', 'puede_ver')), h(async (req, res) => {
  const [coberturaResult, insumosResult, actividadResult] = await Promise.all([
    db.pool.query(`
      WITH catalogo AS (
        SELECT DISTINCT ON (co.codigo) co.id
        FROM conceptos co
        JOIN proyectos p ON p.id = co.project_id
        WHERE ${CONCEPTOS_CATALOGO_WHERE_SQL}
        ORDER BY ${CONCEPTOS_CATALOGO_ORDER_SQL}
      )
      SELECT COUNT(*)::int AS total, COUNT(m.id)::int AS con_matriz
      FROM catalogo c
      LEFT JOIN matrices_precio_unitario m ON m.concepto_id = c.id AND m.es_basico = false
    `, [EXCLUIR_OBRAS_DUPLICADAS_CATALOGO]),
    db.pool.query(`
      WITH ultimo_precio AS (
        SELECT DISTINCT ON (i.codigo, i.project_id)
          i.codigo, i.project_id, i.precio_presupuesto, p.nombre AS obra
        FROM insumos i JOIN proyectos p ON p.id = i.project_id
        WHERE i.codigo IS NOT NULL AND i.precio_presupuesto > 0
        ORDER BY i.codigo, i.project_id, i.id DESC
      ), agregado AS (
        SELECT codigo, MIN(precio_presupuesto) min_p, MAX(precio_presupuesto) max_p,
               COUNT(*) n_obras, COUNT(DISTINCT precio_presupuesto) n_precios
        FROM ultimo_precio GROUP BY codigo HAVING COUNT(*) >= 2
      )
      SELECT codigo, min_p, max_p, n_obras,
             100.0*(max_p-min_p)/NULLIF(min_p,0) pct_diff
      FROM agregado
      WHERE n_precios > 1 AND (max_p-min_p)/NULLIF(min_p,0) > 0.05
      ORDER BY pct_diff DESC
      LIMIT 50
    `),
    db.pool.query(`
      SELECT al.id, al.actor_usuario, al.accion, al.target_id, al.creado_en, al.detalle,
             p.nombre AS obra_nombre
      FROM audit_log al
      LEFT JOIN proyectos p ON p.id = al.target_id
      WHERE al.accion IN ('importar_matrices', 'crear_presupuesto_desde_costos')
      ORDER BY al.creado_en DESC
      LIMIT 15
    `),
  ]);

  const cobertura = coberturaResult.rows[0] || { total: 0, con_matriz: 0 };
  const total = Number(cobertura.total) || 0;
  const conMatriz = Number(cobertura.con_matriz) || 0;

  const actividad = actividadResult.rows.map((r) => {
    let detalle = null;
    try { detalle = r.detalle ? JSON.parse(r.detalle) : null; } catch { detalle = null; }
    return {
      id: r.id, actor_usuario: r.actor_usuario, accion: r.accion,
      target_id: r.target_id, obra_nombre: r.obra_nombre, creado_en: r.creado_en, detalle,
    };
  });

  res.json({
    cobertura_matrices: {
      total_conceptos: total,
      con_matriz: conMatriz,
      sin_matriz: total - conMatriz,
      pct_cobertura: total > 0 ? (100 * conMatriz) / total : 0,
    },
    insumos_inconsistentes: insumosResult.rows.map((r) => ({
      codigo: r.codigo,
      min_precio: Number(r.min_p),
      max_precio: Number(r.max_p),
      n_obras: Number(r.n_obras),
      pct_diff: Number(r.pct_diff),
    })),
    actividad_reciente: actividad,
  });
}));

// Crea un proyecto nuevo directo desde el catálogo agregado (ya revisado/
// editado por el usuario en el frontend — items llega con lo que el usuario
// confirmó, no se vuelve a consultar el catálogo aquí). Reutiliza ingest()
// real (mismo código que usa toda carga de Excel) en vez de duplicar lógica
// de inserción — sin pasar por Blob/parseWorkbook, ya viene como JSON.
app.post('/api/costos/crear-presupuesto', h(auth.checkPermiso('costos', 'puede_crear')), h(async (req, res) => {
  const { nombre, cliente_id, items } = req.body || {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'Indica el nombre de la obra' });
  const clienteId = Number(cliente_id);
  if (!Number.isFinite(clienteId)) return res.status(400).json({ error: 'Indica a qué cliente pertenece este presupuesto' });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'El presupuesto debe incluir al menos un concepto' });
  for (const it of items) {
    if (!it.codigo?.trim() || !it.concepto?.trim()) return res.status(400).json({ error: 'Cada concepto necesita código y descripción' });
    if (!(Number(it.cantidad) >= 0) || !(Number(it.precio_unitario) >= 0)) {
      return res.status(400).json({ error: `Cantidad/precio inválidos para el concepto "${it.concepto}"` });
    }
  }
  const { rows: clienteRows } = await db.pool.query('SELECT id FROM clientes WHERE id = $1', [clienteId]);
  if (!clienteRows[0]) return res.status(400).json({ error: 'El cliente indicado no existe' });

  const parsed = {
    meta: {},
    conceptos: items.map((it, idx) => {
      const cantidad = Number(it.cantidad);
      const precio = Number(it.precio_unitario);
      return {
        codigo: it.codigo.trim(), concepto: it.concepto.trim(), unidad: it.unidad || null,
        cantidad, precio_unitario: precio, importe: cantidad * precio,
        grupo: it.categoria || null, es_total: 0, orden: idx + 1,
      };
    }),
    insumos: items.map((it, idx) => {
      const cantidad = Number(it.cantidad);
      const precio = Number(it.precio_unitario);
      return {
        codigo: it.codigo.trim(), concepto: it.concepto.trim(), categoria: it.categoria || null, unidad: it.unidad || null,
        cantidad_presupuesto: cantidad, precio_presupuesto: precio, importe_presupuesto: cantidad * precio,
        orden: idx + 1,
      };
    }),
  };
  const totalSinIva = parsed.conceptos.reduce((s, c) => s + c.importe, 0);
  parsed.meta.total_sin_iva = totalSinIva;

  // record se crea fuera de la transacción (mismo patrón que POST /api/projects,
  // server/app.js) — createProjectRecord usa pool.query, no el client de la
  // transacción, así que da igual anidarlo o no: se commitea de inmediato de
  // cualquier forma. Se deja fuera para que quede explícito.
  const record = await db.createProjectRecord(nombre.trim(), null, clienteId);
  await db.withTransaction(async (client) => {
    await ingest(client, record.id, parsed);
    const ip = auth.getIp(req);
    await client.query(
      `INSERT INTO audit_log (actor_id, actor_usuario, accion, target_id, project_id, ip, detalle)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [req.user.id, req.user.usuario, 'crear_presupuesto_desde_costos', record.id, record.id, ip,
        JSON.stringify({ cliente_id: clienteId, num_conceptos: items.length, total_sin_iva: totalSinIva })]
    );
  });

  res.status(201).json({ id: record.id, nombre: record.nombre, num_conceptos: items.length, total_sin_iva: totalSinIva });
}));

// ---------------------------------------------------------------------------
// prompt-fase1-3-export-import-4-hojas.md: queries cross-obra "de origen"
// para las Hojas 2-4 del export de "Crear presupuesto desde catálogo".
// Ninguna reemplaza ni modifica destajo_items/insumos/matrices_precio_unitario
// de la obra de origen -- son 100% de lectura, resuelven "qué había en la
// obra donde vive hoy este concepto" para poder copiarlo a la obra nueva.
// ---------------------------------------------------------------------------

// Destajo: 1 fila por concepto en la práctica (confirmado contra los 28
// destajo_items reales de Preview — ningún concepto_id con más de un
// destajista, y ninguno con más de una fila). Si llegara a haber más de una
// fila para el mismo concepto_id, se usa la más reciente por id (criterio
// acordado con Paul: no hay ambigüedad real hoy, no vale la pena una regla
// más compleja para un caso que no ocurre).
async function destajoOrigenQuery(obraOrigenId, conceptoId) {
  const { rows } = await db.pool.query(`
    SELECT di.precio_destajo, di.unidad, di.codigo, di.concepto, d.nombre AS destajista_nombre
    FROM destajo_items di
    JOIN destajistas d ON d.id = di.destajista_id
    WHERE di.project_id = $1 AND di.concepto_id = $2
    ORDER BY di.id DESC
    LIMIT 1
  `, [obraOrigenId, conceptoId]);
  return rows[0] || null;
}

// Insumos: resuelto vía matriz_precio_renglones (decisión confirmada con
// Paul tras verificar en Preview que concepto_insumos solo tiene 1 fila real
// en toda la base — no es fuente viable). Si el concepto no tiene matriz
// cargada en su obra de origen, esta query no devuelve nada — caso esperado,
// no error (documentado explícitamente en el prompt).
async function insumosOrigenQuery(obraOrigenId, conceptoId) {
  const { rows } = await db.pool.query(`
    SELECT DISTINCT insumos.codigo, insumos.concepto AS descripcion, insumos.categoria,
           insumos.unidad, insumos.precio_presupuesto, insumos.iva_tasa
    FROM matriz_precio_renglones r
    JOIN matrices_precio_unitario m ON r.matriz_id = m.id
    JOIN insumos ON r.insumo_id = insumos.id
    WHERE m.concepto_id = $1 AND r.tipo = 'insumo' AND insumos.project_id = $2
    ORDER BY insumos.codigo
  `, [conceptoId, obraOrigenId]);
  return rows;
}

// Matrices: cabecera (matrices_precio_unitario) + todos sus renglones
// (matriz_precio_renglones), ambos de la obra de origen. concepto_id ya es
// único por matriz (UNIQUE en el schema), así que a lo más 1 matriz por
// concepto.
async function matrizOrigenQuery(obraOrigenId, conceptoId) {
  const { rows: cabRows } = await db.pool.query(`
    SELECT m.id, m.pct_indirecto, m.pct_utilidad, m.pct_financiamiento,
           m.rendimiento, m.partida, m.analisis_no, m.cuadrilla_nombre
    FROM matrices_precio_unitario m
    JOIN conceptos c ON c.id = m.concepto_id
    WHERE m.concepto_id = $1 AND c.project_id = $2
  `, [conceptoId, obraOrigenId]);
  const cabecera = cabRows[0] || null;
  if (!cabecera) return null;
  const { rows: renglones } = await db.pool.query(`
    SELECT r.categoria, r.tipo, r.codigo, r.descripcion, r.cantidad, r.factor_referencia,
           i.codigo AS insumo_codigo
    FROM matriz_precio_renglones r
    LEFT JOIN insumos i ON i.id = r.insumo_id
    WHERE r.matriz_id = $1
    ORDER BY r.orden, r.id
  `, [cabecera.id]);
  return { cabecera, renglones };
}

// Exporta a Excel los ítems armados en el modal "Crear presupuesto desde
// catálogo" (prompt-exportar-excel-modal-catalogo.md) — SIN crear nada,
// generación pura de archivo. Convive con POST /costos/crear-presupuesto de
// arriba (sin tocarlo, Forbidden Action) para que el usuario pueda revisar/
// ajustar y cargar después vía Mapeo/Actualizar presupuesto en vez de crear
// directo. Mismas 2 columnas mínimas que el importador real de esa carga ya
// reconoce por sinónimo de encabezado (server/parser.js: HEADER_SYNONYMS,
// findHeaderRow — CODIGO/CONCEPTO/UNIDAD/CANTIDAD + PRECIO/IMPORTE), sin
// necesidad de replicar hojas de metadata/totales/grupos — parseBudgetConcepts
// los calcula solo desde el texto de cada fila, no los exige como input.
// Mismo permiso que crear-presupuesto (puede_crear, no puede_ver): exportar
// es parte del mismo flujo/modal, no tiene sentido darle el archivo a quien
// ni siquiera podría crear el presupuesto directo.
// prompt-fase1-3-export-import-4-hojas.md: si al menos un ítem trae
// obra_origen_id + concepto_id_origen (viene del catálogo de Conceptos, no
// del de Insumos — ver openCrearPresupuestoModal), se generan también las
// Hojas 2-4 resolviendo cada ítem contra su obra/concepto de origen real.
// Hoja 1 no cambia de formato bajo ninguna circunstancia (Forbidden Action).
async function construirHojasDestajoInsumosMatrices(items) {
  const conOrigen = items.filter((it) => it.obra_origen_id != null && it.concepto_id_origen != null);

  const destajoFilas = [];
  const insumosFilas = [];
  const matricesFilas = [];

  await Promise.all(conOrigen.map(async (it) => {
    const [destajo, insumos, matriz] = await Promise.all([
      destajoOrigenQuery(it.obra_origen_id, it.concepto_id_origen),
      insumosOrigenQuery(it.obra_origen_id, it.concepto_id_origen),
      matrizOrigenQuery(it.obra_origen_id, it.concepto_id_origen),
    ]);

    if (destajo) {
      destajoFilas.push({
        codigo: it.codigo, concepto: it.concepto, unidad: destajo.unidad || it.unidad || '',
        precio_destajo_maximo: Number(destajo.precio_destajo), destajista_nombre: destajo.destajista_nombre,
      });
    }

    for (const ins of insumos) {
      insumosFilas.push({
        codigo_insumo: ins.codigo, descripcion: ins.descripcion, categoria: ins.categoria,
        unidad: ins.unidad, precio_presupuesto: Number(ins.precio_presupuesto),
        iva_tasa: Number(ins.iva_tasa), codigo_concepto: it.codigo,
      });
    }

    if (matriz) {
      const { cabecera, renglones } = matriz;
      const base = {
        codigo_concepto: it.codigo, partida: cabecera.partida, rendimiento: cabecera.rendimiento,
        pct_indirecto: Number(cabecera.pct_indirecto), pct_utilidad: Number(cabecera.pct_utilidad),
        pct_financiamiento: Number(cabecera.pct_financiamiento), analisis_no: cabecera.analisis_no,
        cuadrilla_nombre: cabecera.cuadrilla_nombre,
      };
      // Tabla denormalizada (1 fila por renglón, cabecera repetida) en vez de
      // 2 bloques separados dentro de la misma hoja — sendXlsxExport/addSheet
      // (server/exportHelper.js) solo soporta 1 tabla plana por hoja; una
      // matriz sin renglones (caso raro, no visto en datos reales de
      // Preview) igual emite 1 fila para no perder la cabecera.
      if (!renglones.length) {
        matricesFilas.push({ ...base, categoria_renglon: null, tipo_renglon: null, codigo_insumo_renglon: null, descripcion_renglon: null, cantidad_renglon: null, factor_referencia_renglon: null });
      } else {
        for (const r of renglones) {
          matricesFilas.push({
            ...base, categoria_renglon: r.categoria, tipo_renglon: r.tipo,
            codigo_insumo_renglon: r.insumo_codigo || r.codigo, descripcion_renglon: r.descripcion,
            cantidad_renglon: Number(r.cantidad), factor_referencia_renglon: r.factor_referencia,
          });
        }
      }
    }
  }));

  return { destajoFilas, insumosFilas, matricesFilas };
}

app.post('/api/costos/crear-presupuesto/export', h(auth.checkPermiso('costos', 'puede_crear')), h(async (req, res) => {
  const { nombre, items } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'El presupuesto debe incluir al menos un concepto' });
  for (const it of items) {
    if (!it.codigo?.trim() || !it.concepto?.trim()) return res.status(400).json({ error: 'Cada concepto necesita código y descripción' });
    if (!(Number(it.cantidad) >= 0) || !(Number(it.precio_unitario) >= 0)) {
      return res.status(400).json({ error: `Cantidad/precio inválidos para el concepto "${it.concepto}"` });
    }
  }
  const sheets = [{
    sheetName: 'Presupuesto',
    columns: [
      { header: 'Código', key: 'codigo', width: 16 },
      { header: 'Concepto', key: 'concepto', width: 50 },
      { header: 'Unidad', key: 'unidad', width: 10 },
      { header: 'Cantidad', key: 'cantidad', width: 14 },
      { header: 'Precio Unitario', key: 'precio_unitario', width: 18, format: 'money' },
      { header: 'Importe', key: 'importe', width: 18, format: 'money' },
    ],
    rows: items.map((it) => {
      const cantidad = Number(it.cantidad);
      const precio_unitario = Number(it.precio_unitario);
      return {
        codigo: it.codigo.trim(), concepto: it.concepto.trim(), unidad: it.unidad || '',
        cantidad, precio_unitario, importe: cantidad * precio_unitario,
      };
    }),
  }];

  const tieneOrigen = items.some((it) => it.obra_origen_id != null && it.concepto_id_origen != null);
  if (tieneOrigen) {
    const { destajoFilas, insumosFilas, matricesFilas } = await construirHojasDestajoInsumosMatrices(items);
    sheets.push(
      {
        sheetName: 'Destajo',
        columns: [
          { header: 'Código', key: 'codigo', width: 16 },
          { header: 'Concepto', key: 'concepto', width: 50 },
          { header: 'Unidad', key: 'unidad', width: 10 },
          { header: 'Precio Destajo Máximo', key: 'precio_destajo_maximo', width: 20, format: 'money' },
          { header: 'Destajista (obra de origen)', key: 'destajista_nombre', width: 26 },
        ],
        rows: destajoFilas,
      },
      {
        sheetName: 'Insumos',
        columns: [
          { header: 'Código Insumo', key: 'codigo_insumo', width: 16 },
          { header: 'Descripción', key: 'descripcion', width: 45 },
          { header: 'Categoría', key: 'categoria', width: 18 },
          { header: 'Unidad', key: 'unidad', width: 10 },
          { header: 'Precio Presupuesto', key: 'precio_presupuesto', width: 18, format: 'money' },
          { header: 'IVA Tasa', key: 'iva_tasa', width: 10, format: 'int' },
          { header: 'Código Concepto', key: 'codigo_concepto', width: 16 },
        ],
        rows: insumosFilas,
      },
      {
        sheetName: 'Matrices',
        columns: [
          { header: 'Código Concepto', key: 'codigo_concepto', width: 16 },
          { header: 'Partida', key: 'partida', width: 20 },
          { header: 'Rendimiento', key: 'rendimiento', width: 14 },
          { header: '% Indirecto', key: 'pct_indirecto', width: 14 },
          { header: '% Utilidad', key: 'pct_utilidad', width: 14 },
          { header: '% Financiamiento', key: 'pct_financiamiento', width: 16 },
          { header: 'Análisis No.', key: 'analisis_no', width: 14 },
          { header: 'Cuadrilla', key: 'cuadrilla_nombre', width: 20 },
          { header: 'Categoría (renglón)', key: 'categoria_renglon', width: 20 },
          { header: 'Tipo (renglón)', key: 'tipo_renglon', width: 12 },
          { header: 'Código Insumo (renglón)', key: 'codigo_insumo_renglon', width: 20 },
          { header: 'Descripción (renglón)', key: 'descripcion_renglon', width: 40 },
          { header: 'Cantidad (renglón)', key: 'cantidad_renglon', width: 16 },
          { header: 'Factor Referencia (renglón)', key: 'factor_referencia_renglon', width: 20 },
        ],
        rows: matricesFilas,
      },
    );
  }

  await sendXlsxExport(res, {
    filename: buildExportFilename('Presupuesto', nombre?.trim() || 'DesdeCatalogo'),
    sheets,
  });
}));

// ---------------------------------------------------------------------------
// prompt-fase1-3-export-import-4-hojas.md: import completo del archivo de 4
// hojas — crea una obra NUEVA (presupuesto + destajo + insumos + matrices)
// en una sola transacción. Ruta separada, NO reutiliza el importador de
// Mapeo ni el de Matrices Neodata (Forbidden Action) — ninguno de los dos
// soporta crear conceptos/insumos nuevos desde cero, que es justo lo que
// hace falta aquí. Alcance v1: solo creación de obra nueva (confirmado con
// Paul) — no hay "actualizar obra existente".
// Mismo patrón preview→confirm que "Actualizar presupuesto"/Matrices
// Neodata: confirm nunca confía en lo que mandó el preview, re-descarga y
// re-parsea el archivo desde cero.
async function prepararImportCompleto(archivo_url) {
  const tmpPath = path.join(os.tmpdir(), `crear-presupuesto-import-${Date.now()}-${Math.round(Math.random() * 1e9)}.xlsx`);
  try {
    await descargarBlobXlsxATmp(archivo_url, tmpPath);
    return await parseArchivo4Hojas(tmpPath);
  } finally {
    fs.rm(tmpPath, () => {});
  }
}

app.post('/api/costos/crear-presupuesto/import-completo/preview', h(auth.checkPermiso('costos', 'puede_crear')), h(async (req, res) => {
  const { archivo_url } = req.body || {};
  if (!archivo_url) return res.status(400).json({ error: 'Sube un archivo .xlsx de 4 hojas (Presupuesto/Destajo/Insumos/Matrices)' });
  try {
    const parsed = await prepararImportCompleto(archivo_url);
    res.json(resumenParaPreview(parsed));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}));

app.post('/api/costos/crear-presupuesto/import-completo/confirm', h(auth.checkPermiso('costos', 'puede_crear')), h(async (req, res) => {
  const { archivo_url, nombre, cliente_id, confirmado } = req.body || {};
  if (!archivo_url) return res.status(400).json({ error: 'Sube un archivo .xlsx de 4 hojas (Presupuesto/Destajo/Insumos/Matrices)' });
  if (!nombre?.trim()) return res.status(400).json({ error: 'Indica el nombre de la obra' });
  const clienteId = Number(cliente_id);
  if (!Number.isFinite(clienteId)) return res.status(400).json({ error: 'Indica a qué cliente pertenece este presupuesto' });
  if (confirmado !== true) return res.status(400).json({ error: 'Falta confirmar explícitamente la importación' });
  const { rows: clienteRows } = await db.pool.query('SELECT id FROM clientes WHERE id = $1', [clienteId]);
  if (!clienteRows[0]) return res.status(400).json({ error: 'El cliente indicado no existe' });

  let parsed;
  try {
    parsed = await prepararImportCompleto(archivo_url);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  // Destajistas agrupados por nombre (case-insensitive, decisión confirmada
  // con Paul) — el universo de destajistas es por obra, así que "recrear por
  // nombre" siempre CREA un destajista nuevo en la obra nueva (nunca hay uno
  // preexistente con quien hacer match, la obra no existe hasta este mismo
  // insert). ingest() ya resuelve concepto_id por código contra los
  // conceptos recién insertados — mismo mecanismo que usa para archivos de
  // alta inicial con hoja de Destajistas real.
  const destajistasPorNombreLower = new Map();
  for (const d of parsed.destajo) {
    const nombreDestajista = d.destajista_nombre?.trim() || 'Sin destajista asignado';
    const key = nombreDestajista.toLowerCase();
    if (!destajistasPorNombreLower.has(key)) destajistasPorNombreLower.set(key, { nombre: nombreDestajista, orden: destajistasPorNombreLower.size, items: [] });
    destajistasPorNombreLower.get(key).items.push({
      codigo: d.codigo, concepto: parsed.conceptos.find((c) => c.codigo === d.codigo)?.concepto || d.codigo,
      unidad: d.unidad, cantidad_asignada: 0, precio_destajo: d.precio_destajo_maximo, orden: 0,
    });

  }

  const ingestParsed = {
    meta: { total_sin_iva: parsed.conceptos.reduce((s, c) => s + c.importe, 0) },
    conceptos: parsed.conceptos.map((c) => ({ ...c, grupo: null, es_total: 0 })),
    insumos: [], // Hoja 3 se inserta aparte abajo (real, no el mirror-de-conceptos que usa ingest()).
    destajistas: [...destajistasPorNombreLower.values()],
  };

  let record;
  try {
    await db.withTransaction(async (client) => {
      // Proyecto creado DENTRO de la transacción (a diferencia de
      // POST /costos/crear-presupuesto, que lo crea afuera) -- Forbidden
      // Action explícita de este prompt: "si cualquier paso falla, rollback
      // completo, no dejar la obra a medias". Si createProjectRecord
      // corriera afuera y luego ingest() u otro insert fallara, quedaría un
      // proyecto vacío huérfano.
      const { rows: projRows } = await client.query(
        'INSERT INTO proyectos (nombre, archivo_original, cliente_id) VALUES ($1, $2, $3) RETURNING *',
        [nombre.trim(), null, clienteId]
      );
      record = projRows[0];

      await ingest(client, record.id, ingestParsed);

      const { rows: conceptoRows } = await client.query('SELECT id, codigo FROM conceptos WHERE project_id = $1', [record.id]);
      const conceptoIdPorCodigo = new Map(conceptoRows.map((c) => [c.codigo, c.id]));

      // Hoja 3 real (multi-insumo por concepto, vía matriz de origen) +
      // concepto_insumos, para consistencia con el resto del sistema aunque
      // hoy casi ningún concepto tenga esa relación poblada (ver Fase 0).
      const insumoIdPorCodigo = new Map();
      for (const ins of parsed.insumos) {
        const { rows } = await client.query(
          `INSERT INTO insumos (project_id, codigo, concepto, categoria, unidad, cantidad_presupuesto, precio_presupuesto, importe_presupuesto, iva_tasa, orden)
           VALUES ($1,$2,$3,$4,$5,0,$6,0,$7,0) RETURNING id`,
          [record.id, ins.codigo_insumo, ins.descripcion, ins.categoria, ins.unidad, ins.precio_presupuesto, ins.iva_tasa || 16]
        );
        insumoIdPorCodigo.set(ins.codigo_insumo, rows[0].id);
        const conceptoId = conceptoIdPorCodigo.get(ins.codigo_concepto);
        if (conceptoId) {
          await client.query(
            'INSERT INTO concepto_insumos (concepto_id, insumo_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
            [conceptoId, insumoIdPorCodigo.get(ins.codigo_insumo)]
          );
        }
      }

      // Hoja 4: matrices_precio_unitario + matriz_precio_renglones,
      // resolviendo insumo_id de cada renglón contra los insumos recién
      // insertados arriba (por código) -- si un renglón referencia un
      // código de insumo que no vino en Hoja 3, el renglón se inserta sin
      // insumo_id (tipo factor_pct ya funciona así de por sí; para tipo
      // 'insumo' sin match, se guarda igual con insumo_id NULL en vez de
      // perder el renglón completo, ya que categoria/tipo/cantidad siguen
      // siendo información real).
      for (const m of parsed.matrices) {
        const conceptoId = conceptoIdPorCodigo.get(m.codigo_concepto);
        if (!conceptoId) continue; // ya validado arriba, no debería pasar
        const { rows: matRows } = await client.query(
          `INSERT INTO matrices_precio_unitario
             (concepto_id, pct_indirecto, pct_utilidad, pct_financiamiento, rendimiento, partida, analisis_no, cuadrilla_nombre)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [conceptoId, m.pct_indirecto, m.pct_utilidad, m.pct_financiamiento, m.rendimiento, m.partida, m.analisis_no, m.cuadrilla_nombre]
        );
        const matrizId = matRows[0].id;
        let orden = 0;
        for (const r of m.renglones) {
          const insumoId = r.codigo_insumo ? (insumoIdPorCodigo.get(r.codigo_insumo) || null) : null;
          await client.query(
            `INSERT INTO matriz_precio_renglones (matriz_id, categoria, tipo, insumo_id, codigo, descripcion, cantidad, factor_referencia, orden)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [matrizId, r.categoria, r.tipo, insumoId, r.codigo_insumo || null, r.descripcion, r.cantidad, r.factor_referencia, orden++]
          );
        }
      }

      const ip = auth.getIp(req);
      await client.query(
        `INSERT INTO audit_log (actor_id, actor_usuario, accion, target_id, project_id, ip, detalle)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [req.user.id, req.user.usuario, 'crear_presupuesto_import_completo', record.id, record.id, ip,
          JSON.stringify({ cliente_id: clienteId, ...resumenParaPreview(parsed) })]
      );
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  res.status(201).json({ id: record.id, nombre: record.nombre, ...resumenParaPreview(parsed) });
}));

// ---------------------------------------------------------------------------
// Catálogo Maestro de Costos (prompt-catalogo-maestro-costos.md, Task 2/5) —
// repositorio GLOBAL de conceptos/destajo/insumos/matrices cargado desde
// archivos Excel de 4 hojas (mismo formato/parser que "Crear presupuesto
// desde catálogo" arriba, vía parseArchivo4Hojas). Carga y administración
// (los 4 endpoints de este bloque): solo admin/desarrollador -- auth.allow()
// sin puestos extra (decisión consultada: no se granulariza en
// permisos_usuario para esta primera versión, ver server/catalogoMaestro.js
// para el mapeo de datos). Búsqueda/consumo desde "Crear presupuesto desde
// catálogo" (Task 3) usará el permiso 'costos'.puede_crear existente en su
// lugar, no este gate.
const catalogoMaestro = require('./catalogoMaestro');

// Igual patrón que /api/contabilidad/movimientos/upload-token
// (server/app.js ~5049): token firmado para subir directo del browser a
// Blob, NO multipart -- así es como TODO archivo .xlsx se sube en este
// codebase, el texto "multipart" del prompt original no corresponde a
// ningún patrón real existente aquí.
app.post('/api/costos/catalogo-maestro/upload-token', h(auth.allow()), h(async (req, res) => {
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
          maximumSizeInBytes: 15 * 1024 * 1024,
        };
      },
    });
    res.json(jsonResponse);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// prompt-normalizador-universal-ajal.md (fase adicional): para el camino
// AJAL específicamente se agrega una pausa de preview/confirm antes de
// persistir -- mismo criterio que /crear-presupuesto/import-completo
// (preview/confirm, server/app.js ~3354): el usuario ve los conceptos
// detectados y confirma explícitamente antes de que se escriba nada en
// catalogo_conceptos/destajo/insumos/matrices. El formato ESTÁNDAR sigue
// comprometiendo en un solo paso, sin este freno (decisión explícita: ese
// camino ya es de bajo riesgo y no se toca).
// La fila de catalogo_archivos se sigue creando ANTES de parsear, igual que
// antes, para los dos formatos -- preserva el registro de auditoría aunque
// el parseo reviente, sea cual sea el formato detectado.
app.post('/api/costos/catalogo-maestro/upload', h(auth.allow()), h(async (req, res) => {
  const { archivo_url, nombre_archivo } = req.body || {};
  if (!archivo_url) return res.status(400).json({ error: 'Falta archivo_url (sube el archivo primero vía upload-token)' });
  if (!nombre_archivo?.trim()) return res.status(400).json({ error: 'Falta nombre_archivo' });

  const { rows: archivoRows } = await db.pool.query(
    `INSERT INTO catalogo_archivos (nombre_archivo, blob_url, cargado_por, estado)
     VALUES ($1,$2,$3,'procesando') RETURNING id`,
    [nombre_archivo.trim(), archivo_url, req.user.id]
  );
  const archivoId = archivoRows[0].id;

  const tmpPath = path.join(os.tmpdir(), `catalogo-maestro-${Date.now()}-${Math.round(Math.random() * 1e9)}.xlsx`);
  try {
    await descargarBlobXlsxATmp(archivo_url, tmpPath);
    const { parsed, formatoDetectado } = await catalogoMaestro.parseArchivoConFallbackAjal(tmpPath);

    if (formatoDetectado === 'ajal') {
      await db.pool.query(
        `UPDATE catalogo_archivos SET estado = 'pendiente_confirmacion', formato_detectado = $1 WHERE id = $2`,
        [formatoDetectado, archivoId]
      );
      return res.status(200).json({
        id: archivoId,
        estado: 'pendiente_confirmacion',
        formato_detectado: formatoDetectado,
        preview: {
          num_conceptos: parsed.conceptos.length,
          conceptos: parsed.conceptos.map((c) => ({
            codigo: c.codigo, concepto: c.concepto, unidad: c.unidad, cantidad: c.cantidad, precio_unitario: c.precio_unitario,
          })),
        },
      });
    }

    const resumen = await db.withTransaction((client) => catalogoMaestro.persistirArchivoParseado(client, archivoId, parsed, formatoDetectado));
    await db.pool.query(`UPDATE catalogo_archivos SET estado = 'procesado' WHERE id = $1`, [archivoId]);
    res.status(201).json({ id: archivoId, estado: 'procesado', ...resumen });
  } catch (err) {
    await db.pool.query(`UPDATE catalogo_archivos SET estado = 'error', notas_error = $1 WHERE id = $2`, [err.message, archivoId]);
    res.status(err.status || 400).json({ id: archivoId, estado: 'error', error: err.message });
  } finally {
    fs.promises.unlink(tmpPath).catch(() => {});
  }
}));

// Confirmación explícita del camino AJAL (ver comentario arriba). Nunca
// confía en el preview ya mostrado: vuelve a descargar el blob y a parsear
// desde cero (mismo criterio que import-completo/confirm, server/app.js
// ~3377) -- si el archivo cambió entre el preview y la confirmación, o si el
// parseo ahora falla por cualquier razón, se refleja tal cual, nunca se usa
// el resultado cacheado del preview para persistir.
app.post('/api/costos/catalogo-maestro/upload/:id/confirmar', h(auth.allow()), h(async (req, res) => {
  const archivoId = Number(req.params.id);
  if (!Number.isFinite(archivoId)) return res.status(400).json({ error: 'id inválido' });
  if (req.body?.confirmado !== true) return res.status(400).json({ error: 'Falta confirmar explícitamente la importación' });

  const { rows } = await db.pool.query('SELECT * FROM catalogo_archivos WHERE id = $1', [archivoId]);
  const archivo = rows[0];
  if (!archivo) return res.status(404).json({ error: 'Archivo no encontrado' });
  if (archivo.estado !== 'pendiente_confirmacion') {
    return res.status(409).json({ error: `Este archivo no está pendiente de confirmación (estado actual: ${archivo.estado})` });
  }

  const tmpPath = path.join(os.tmpdir(), `catalogo-maestro-confirmar-${Date.now()}-${Math.round(Math.random() * 1e9)}.xlsx`);
  try {
    await descargarBlobXlsxATmp(archivo.blob_url, tmpPath);
    const { parsed, formatoDetectado } = await catalogoMaestro.parseArchivoConFallbackAjal(tmpPath);
    const resumen = await db.withTransaction((client) => catalogoMaestro.persistirArchivoParseado(client, archivoId, parsed, formatoDetectado));
    await db.pool.query(`UPDATE catalogo_archivos SET estado = 'procesado' WHERE id = $1`, [archivoId]);
    res.status(201).json({ id: archivoId, estado: 'procesado', ...resumen });
  } catch (err) {
    await db.pool.query(`UPDATE catalogo_archivos SET estado = 'error', notas_error = $1 WHERE id = $2`, [err.message, archivoId]);
    res.status(err.status || 400).json({ id: archivoId, estado: 'error', error: err.message });
  } finally {
    fs.promises.unlink(tmpPath).catch(() => {});
  }
}));

app.get('/api/costos/catalogo-maestro/archivos', h(auth.allow()), h(async (req, res) => {
  res.json({ archivos: await catalogoMaestro.listarArchivos(db.pool) });
}));

app.delete('/api/costos/catalogo-maestro/archivos/:id', h(auth.allow()), h(async (req, res) => {
  const archivoId = Number(req.params.id);
  if (!Number.isFinite(archivoId)) return res.status(400).json({ error: 'id inválido' });
  const conceptosDesactivados = await catalogoMaestro.eliminarArchivo(db.pool, archivoId);
  if (conceptosDesactivados === null) return res.status(404).json({ error: 'Archivo no encontrado' });
  res.json({ id: archivoId, conceptos_desactivados: conceptosDesactivados });
}));

// Task 3/5 — búsqueda y consumo. Mismos roles que "Crear presupuesto desde
// catálogo" hoy (checkPermiso('costos','puede_crear'), NO auth.allow() como
// los 4 endpoints de carga/administración arriba — decisión explícita del
// plan, sección Permisos).
app.get('/api/costos/catalogo-maestro/conceptos', h(auth.checkPermiso('costos', 'puede_crear')), h(async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Falta el parámetro de búsqueda q' });
  res.json({ conceptos: await catalogoMaestro.buscarConceptos(db.pool, q) });
}));

app.post('/api/costos/catalogo-maestro/importar-a-obra', h(auth.checkPermiso('costos', 'puede_crear')), h(async (req, res) => {
  const { proyecto_id, concepto_ids } = req.body || {};
  const proyectoId = Number(proyecto_id);
  if (!Number.isFinite(proyectoId)) return res.status(400).json({ error: 'Falta proyecto_id' });
  if (!Array.isArray(concepto_ids) || !concepto_ids.length) return res.status(400).json({ error: 'Falta concepto_ids (lista no vacía)' });
  const ids = concepto_ids.map(Number);
  if (ids.some((n) => !Number.isFinite(n))) return res.status(400).json({ error: 'concepto_ids debe ser una lista de enteros' });

  const { rows: proyectoRows } = await db.pool.query('SELECT id FROM proyectos WHERE id = $1', [proyectoId]);
  if (!proyectoRows[0]) return res.status(404).json({ error: 'La obra destino no existe' });

  const ip = auth.getIp(req);
  let resultado;
  try {
    // audit_log dentro de la MISMA transacción que el import (igual que
    // import-completo/confirm, server/app.js ~3477-3483) -- si el log
    // fallara fuera de la transacción, el cliente vería un 500 pese a que
    // el import ya se hubiera confirmado, un falso negativo confuso.
    resultado = await db.withTransaction(async (client) => {
      const r = await catalogoMaestro.importarAObra(client, proyectoId, ids);
      await client.query(
        `INSERT INTO audit_log (actor_id, actor_usuario, accion, target_id, project_id, ip, detalle)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [req.user.id, req.user.usuario, 'catalogo_maestro_importar_a_obra', proyectoId, proyectoId, ip, JSON.stringify(r)]
      );
      return r;
    });
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  res.status(201).json({ proyecto_id: proyectoId, ...resultado });
}));

// ---------------------------------------------------------------------------
// Matrices de precio unitario — Análisis de Precios Unitarios formato Neodata
// (prompt-20-matrices-formato-neodata.md, rehace prompt-14/PR #98: la spec
// anterior simplificaba la fórmula real — error de especificación, no de
// implementación). Tabla propia (matrices_precio_unitario +
// matriz_precio_renglones), deliberadamente separada de concepto_insumos:
// ver comentario en server/db.js — poblarla desde aquí rompería "avance
// requiere entrega" (insumosPendientesPorConcepto más abajo). Reusa el
// permiso 'costos'.
//
// Cascada de 4 niveles, ADITIVA SECUENCIAL (no multiplicativa como PR #98):
//   CD = MATERIALES + MANO_DE_OBRA + EQUIPO_Y_HERRAMIENTA
//   CI = CD × %indirecto            SUBTOTAL1 = CD + CI
//   CF = SUBTOTAL1 × %financiamiento   SUBTOTAL2 = SUBTOTAL1 + CF
//   CU = SUBTOTAL2 × %utilidad      PRECIO UNITARIO = SUBTOTAL2 + CU
// Mano de Obra es especial: NO es cantidad×precio como las otras 2
// categorías — es una CUADRILLA (suma de renglones, cada uno un oficio con
// su jornal × cantidad de jornada) dividida entre el RENDIMIENTO de la
// actividad (unidad/JOR). Sin rendimiento capturado, el subtotal de Mano de
// Obra (y por tanto CD) queda null ("No disponible") — nunca se asume 1 ni
// se fabrica, mismo criterio que categoría sin renglones.
// Renglones tipo='factor_pct' (ej. "%MO1" HERRAMIENTA MENOR, "%MO5" EQUIPO
// DE SEGURIDAD) NO son insumos — son factores: su "cantidad" es un % y su
// importe = subtotal de OTRA categoría (factor_referencia) × ese %. Viven
// típicamente en EQUIPO_Y_HERRAMIENTA aunque referencian MANO_DE_OBRA.
// Redondeo a 2 decimales EN CADA ETAPA (cada renglón, cada subtotal de
// categoría, CD, CI, SUBTOTAL1, CF, SUBTOTAL2, CU) — verificado contra el
// ejemplo real del Excel de referencia (PAV.ADO12208): redondear solo al
// final da una cifra distinta a la esperada en el último dígito.
// prompt-matrices-auto-import-alta-obra.md: MATRIZ_CATEGORIAS/calcularMatrizNeodata
// se movieron a server/matricesImport.js para que ingest.js pueda reusarlos
// durante el alta de obra sin crear un require circular (app.js ya requiere
// ./ingest — ver comentario de cabecera de matricesImport.js). Se re-exportan
// aquí con los mismos nombres para no tocar ningún call site de abajo.
const { MATRIZ_CATEGORIAS, calcularMatrizNeodata } = matricesImport;

async function fetchRenglonesRaw(matrizId) {
  const { rows } = await db.pool.query(`
    SELECT r.id, r.categoria, r.tipo, r.insumo_id, r.cantidad, r.operador, r.factor_referencia, r.basico_matriz_id, r.orden,
           COALESCE(i.codigo, r.codigo) AS codigo,
           COALESCE(i.concepto, r.descripcion) AS descripcion,
           i.unidad, i.precio_presupuesto
    FROM matriz_precio_renglones r
    LEFT JOIN insumos i ON i.id = r.insumo_id
    WHERE r.matriz_id = $1
    ORDER BY r.categoria, r.orden, r.id
  `, [matrizId]);
  return rows;
}

// Deja en cada renglón tipo='basico_ref' su r.precio_basico (costo directo
// YA resuelto del básico referenciado) más codigo/descripcion/unidad propios
// del básico para mostrarlos sin tener que ir a buscarlos aparte. `cadena`
// es la lista de matriz_id ya visitados en esta rama — protección contra
// recursión infinita EN LECTURA (defensa en profundidad: la validación al
// guardar ya debería impedir que un ciclo llegue a persistirse, pero esto
// evita que la petición se cuelgue si de todos modos aparece uno).
async function resolverRenglonesBasicoRef(renglones, cadena) {
  for (const r of renglones) {
    if (r.tipo === 'basico_ref') {
      const nested = await resolverBasico(r.basico_matriz_id, cadena);
      r.precio_basico = nested.costo_directo;
      r.codigo = nested.codigo;
      r.descripcion = nested.descripcion;
      r.unidad = nested.unidad;
      r._basico_detalle = nested;
    }
  }
}

// Calcula el costo directo interno de un básico (matriz es_basico=true),
// resolviendo recursivamente cualquier basico_ref anidado dentro de él. NO
// aplica CI/CF/CU — la cascada completa vive únicamente en el análisis padre
// que consume el básico (prompt-matrices-basicos-anidados.md, spec punto 4).
async function resolverBasico(matrizId, cadena = []) {
  if (cadena.includes(matrizId)) {
    throw new Error(`Referencia circular de básicos detectada (matriz ${matrizId})`);
  }
  const siguienteCadena = [...cadena, matrizId];
  const { rows: matrizRows } = await db.pool.query(
    'SELECT * FROM matrices_precio_unitario WHERE id = $1 AND es_basico = true', [matrizId]
  );
  if (!matrizRows[0]) throw new Error(`Básico ${matrizId} no encontrado`);
  const basico = matrizRows[0];
  const renglones = await fetchRenglonesRaw(matrizId);
  await resolverRenglonesBasicoRef(renglones, siguienteCadena);
  const calculo = calcularMatrizNeodata(renglones, basico);
  return { ...basico, renglones, ...calculo };
}

async function getMatrizConRenglones(conceptoId) {
  const { rows: matrizRows } = await db.pool.query('SELECT * FROM matrices_precio_unitario WHERE concepto_id = $1', [conceptoId]);
  if (!matrizRows[0]) return null;
  const matriz = matrizRows[0];
  const renglones = await fetchRenglonesRaw(matriz.id);
  await resolverRenglonesBasicoRef(renglones, [matriz.id]);
  const calculo = calcularMatrizNeodata(renglones, matriz);
  return {
    ...matriz, renglones, ...calculo,
    importe_en_letra: calculo.completa ? numeroALetra(calculo.precio_unitario_calculado) : null,
  };
}

// Recorre transitivamente basico_matriz_id de los renglones tipo='basico_ref'
// que se están por guardar (y de cualquier básico que ellos a su vez
// referencien) para asegurar que `matrizIdPropio` (null si la matriz es
// nueva — un id que no existe aún no puede formar parte de ningún ciclo)
// nunca aparezca en esa cadena, directa ni indirectamente.
async function validarSinCicloBasico(renglones, matrizIdPropio) {
  const pendientes = (renglones || []).filter((r) => r.tipo === 'basico_ref').map((r) => Number(r.basico_matriz_id));
  const visitados = new Set();
  while (pendientes.length) {
    const actual = pendientes.pop();
    if (matrizIdPropio != null && actual === matrizIdPropio) {
      return 'Referencia circular: un básico no puede depender, directa o indirectamente, de sí mismo';
    }
    if (visitados.has(actual)) continue;
    visitados.add(actual);
    const { rows } = await db.pool.query(
      `SELECT basico_matriz_id FROM matriz_precio_renglones WHERE matriz_id = $1 AND tipo = 'basico_ref'`, [actual]
    );
    for (const row of rows) pendientes.push(row.basico_matriz_id);
  }
  return null;
}

// prompt-matrices-auto-import-alta-obra.md: insertarRenglones se movió a
// server/matricesImport.js (junto con calcularMatrizNeodata) para que
// ingest.js pueda reusarla en la misma transacción del alta de obra —
// re-exportada aquí con el mismo nombre, ningún call site cambia.
const { insertarRenglones } = matricesImport;

// Valida el arreglo de renglones que manda el cliente al crear/editar una
// matriz — mismo criterio de validación explícita que el resto del proyecto
// (400 con mensaje claro, nunca un 500 por dato mal formado).
function validarRenglones(renglones, insumoIdsValidos, basicoIdsValidos = new Set()) {
  if (!Array.isArray(renglones) || !renglones.length) return 'La matriz debe incluir al menos un renglón';
  for (const r of renglones) {
    if (!MATRIZ_CATEGORIAS.includes(r.categoria)) return `Categoría inválida: ${r.categoria}`;
    if (!['insumo', 'factor_pct', 'basico_ref'].includes(r.tipo)) return `Tipo de renglón inválido: ${r.tipo}`;
    if (!(Number(r.cantidad) > 0)) return 'Cada renglón requiere una cantidad mayor a 0';
    if (r.operador != null && !['*', '/'].includes(r.operador)) return `Operador inválido: ${r.operador}`;
    if (r.tipo === 'insumo') {
      if (!Number(r.insumo_id)) return 'Cada renglón de tipo insumo requiere insumo_id';
      if (!insumoIdsValidos.has(Number(r.insumo_id))) return `El insumo ${r.insumo_id} no pertenece a esta obra`;
    } else if (r.tipo === 'factor_pct') {
      if (!r.codigo?.trim() || !r.descripcion?.trim()) return 'Cada renglón de tipo factor_pct requiere código y descripción';
      if (!MATRIZ_CATEGORIAS.includes(r.factor_referencia)) return `factor_referencia inválida: ${r.factor_referencia}`;
    } else {
      // basico_ref
      if (r.categoria !== 'BASICOS') return 'Los renglones de tipo basico_ref deben ir en la categoría BASICOS';
      if (!Number(r.basico_matriz_id)) return 'Cada renglón de tipo basico_ref requiere basico_matriz_id';
      if (!basicoIdsValidos.has(Number(r.basico_matriz_id))) return `El básico ${r.basico_matriz_id} no está disponible en esta obra`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Básicos (prompt-matrices-basicos-anidados.md) — matrices reutilizables sin
// concepto propio (es_basico=true, concepto_id NULL), referenciadas como un
// renglón más (tipo='basico_ref') desde otro análisis. Reusa el permiso
// 'costos' del resto de Matrices — mismo dato, misma sensibilidad.
// ---------------------------------------------------------------------------
app.get('/api/projects/:id/basicos', h(auth.allow('residente', 'costos')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('costos', 'puede_ver')), h(async (req, res) => {
  const { rows } = await db.pool.query(
    'SELECT id, codigo, descripcion, unidad FROM matrices_precio_unitario WHERE project_id = $1 AND es_basico = true ORDER BY codigo', [req.project.id]
  );
  res.json({ basicos: rows });
}));

app.get('/api/projects/:id/basicos/:basicoId', h(auth.allow('residente', 'costos')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('costos', 'puede_ver')), h(async (req, res) => {
  const pid = req.project.id;
  const basicoId = Number(req.params.basicoId);
  const { rows } = await db.pool.query('SELECT id FROM matrices_precio_unitario WHERE id = $1 AND project_id = $2 AND es_basico = true', [basicoId, pid]);
  if (!rows[0]) return res.status(404).json({ error: 'Básico no encontrado' });
  const basico = await resolverBasico(basicoId);
  // Dónde se usa este básico — para que se edite con cuidado (spec punto 3):
  // tanto en análisis de concepto real (JOIN a conceptos) como dentro de
  // OTRO básico (anidamiento multinivel).
  const { rows: usos } = await db.pool.query(`
    SELECT m.id AS matriz_id, m.es_basico, m.codigo AS basico_codigo, c.id AS concepto_id, c.codigo AS concepto_codigo, c.concepto AS concepto_nombre
    FROM matriz_precio_renglones r
    JOIN matrices_precio_unitario m ON m.id = r.matriz_id
    LEFT JOIN conceptos c ON c.id = m.concepto_id
    WHERE r.tipo = 'basico_ref' AND r.basico_matriz_id = $1
  `, [basicoId]);
  res.json({ basico, usado_en: usos });
}));

app.post('/api/projects/:id/basicos', h(auth.allow('residente', 'costos')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('costos', 'puede_crear')), h(async (req, res) => {
  const pid = req.project.id;
  const { codigo, descripcion, unidad, renglones } = req.body || {};
  if (!codigo?.trim() || !descripcion?.trim()) return res.status(400).json({ error: 'Código y descripción son requeridos' });

  const insumoIdsCandidatos = (renglones || []).filter((r) => r.tipo === 'insumo').map((r) => Number(r.insumo_id));
  const { rows: insumoRows } = await db.pool.query('SELECT id FROM insumos WHERE id = ANY($1) AND project_id = $2', [insumoIdsCandidatos, pid]);
  const insumoIdsValidos = new Set(insumoRows.map((r) => r.id));
  const basicoIdsCandidatos = (renglones || []).filter((r) => r.tipo === 'basico_ref').map((r) => Number(r.basico_matriz_id));
  const { rows: basicoRows } = await db.pool.query('SELECT id FROM matrices_precio_unitario WHERE id = ANY($1) AND project_id = $2 AND es_basico = true', [basicoIdsCandidatos, pid]);
  const basicoIdsValidos = new Set(basicoRows.map((r) => r.id));
  const errorValidacion = validarRenglones(renglones, insumoIdsValidos, basicoIdsValidos);
  if (errorValidacion) return res.status(400).json({ error: errorValidacion });
  // matrizIdPropio=null: una matriz que aún no existe no puede formar parte
  // de ningún ciclo (nada puede referenciar todavía un id que no se ha
  // asignado).
  const errorCiclo = await validarSinCicloBasico(renglones, null);
  if (errorCiclo) return res.status(400).json({ error: errorCiclo });

  let basicoId;
  await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO matrices_precio_unitario (es_basico, project_id, codigo, descripcion, unidad, creado_por, actualizado_por)
       VALUES (true, $1, $2, $3, $4, $5, $5) RETURNING id`,
      [pid, codigo.trim(), descripcion.trim(), unidad?.trim() || null, req.user.id]
    );
    basicoId = rows[0].id;
    await insertarRenglones(client, basicoId, renglones);
  });
  res.status(201).json({ basico: await resolverBasico(basicoId) });
}));

app.put('/api/projects/:id/basicos/:basicoId', h(auth.allow('residente', 'costos')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('costos', 'puede_editar')), h(async (req, res) => {
  const pid = req.project.id;
  const basicoId = Number(req.params.basicoId);
  const { codigo, descripcion, unidad, renglones } = req.body || {};
  if (!codigo?.trim() || !descripcion?.trim()) return res.status(400).json({ error: 'Código y descripción son requeridos' });

  const { rows: existRows } = await db.pool.query('SELECT id FROM matrices_precio_unitario WHERE id = $1 AND project_id = $2 AND es_basico = true', [basicoId, pid]);
  if (!existRows[0]) return res.status(404).json({ error: 'Básico no encontrado' });

  const insumoIdsCandidatos = (renglones || []).filter((r) => r.tipo === 'insumo').map((r) => Number(r.insumo_id));
  const { rows: insumoRows } = await db.pool.query('SELECT id FROM insumos WHERE id = ANY($1) AND project_id = $2', [insumoIdsCandidatos, pid]);
  const insumoIdsValidos = new Set(insumoRows.map((r) => r.id));
  const basicoIdsCandidatos = (renglones || []).filter((r) => r.tipo === 'basico_ref').map((r) => Number(r.basico_matriz_id));
  const { rows: basicoRows } = await db.pool.query('SELECT id FROM matrices_precio_unitario WHERE id = ANY($1) AND project_id = $2 AND es_basico = true', [basicoIdsCandidatos, pid]);
  const basicoIdsValidos = new Set(basicoRows.map((r) => r.id));
  const errorValidacion = validarRenglones(renglones, insumoIdsValidos, basicoIdsValidos);
  if (errorValidacion) return res.status(400).json({ error: errorValidacion });
  const errorCiclo = await validarSinCicloBasico(renglones, basicoId);
  if (errorCiclo) return res.status(400).json({ error: errorCiclo });

  await db.withTransaction(async (client) => {
    await client.query('DELETE FROM matriz_precio_renglones WHERE matriz_id = $1', [basicoId]);
    await insertarRenglones(client, basicoId, renglones);
    await client.query(
      `UPDATE matrices_precio_unitario SET codigo=$1, descripcion=$2, unidad=$3, actualizado_por=$4, actualizado_en=NOW() WHERE id=$5`,
      [codigo.trim(), descripcion.trim(), unidad?.trim() || null, req.user.id, basicoId]
    );
  });
  res.json({ basico: await resolverBasico(basicoId) });
}));

// ---------------------------------------------------------------------------
// Catálogo de Básicos (prompt-dashboard-costos-basicos-implementacion.md,
// Tarea 2) — vista GLOBAL de solo lectura, hermana de catalogo-conceptos-
// global (arriba): un básico único por código (DISTINCT ON, mismo criterio
// de dedupe cross-obra que conceptosCatalogoQuery — el más reciente por
// p.creado_en DESC se queda con descripción/unidad/costo mostrados), con su
// costo directo resuelto vía resolverBasico() (reusado tal cual, NUNCA
// reimplementado ni se llama calcularMatrizNeodata directo) y cuántas veces
// se reusa como ingrediente de otro análisis, agregado a través de TODAS las
// obras que comparten ese código — no solo la obra "representativa" elegida
// arriba. Mismo query "usado_en" que ya existe para un básico individual en
// GET /api/projects/:id/basicos/:basicoId más arriba, extendido aquí a nivel
// código (ANY() sobre todos los matriz_id que comparten codigo) en vez de a
// nivel de un solo matriz_id, más el nombre de obra (aquí sí hace falta: el
// catálogo cruza obras, la vista por-obra no). Mismo permiso que el resto
// del módulo: checkPermiso('costos', 'puede_ver').
//
// Igual que conceptosCatalogoQuery, excluye las 3 obras duplicadas de VINTE
// (EXCLUIR_OBRAS_DUPLICADAS_CATALOGO) — hoy es un no-op porque esas obras no
// tienen básicos, pero si algún día los tuvieran, contar sus matrices aquí
// triplicaría veces_reusado más abajo (ver también el filtro sobre
// todasVersiones en el handler del endpoint, que cubre la agregación de uso).
async function basicosCatalogoQuery() {
  const { rows } = await db.pool.query(`
    SELECT DISTINCT ON (m.codigo)
      m.id AS matriz_id, m.codigo, m.descripcion, m.unidad,
      p.id AS obra_origen_id, p.nombre AS obra_origen, p.creado_en AS fecha_origen,
      c.id AS cliente_id, c.nombre AS cliente_nombre
    FROM matrices_precio_unitario m
    JOIN proyectos p ON p.id = m.project_id
    JOIN clientes c ON c.id = p.cliente_id
    WHERE m.es_basico = true AND m.codigo IS NOT NULL AND p.id <> ALL($1::int[])
    ORDER BY m.codigo, p.creado_en DESC, m.id DESC
  `, [EXCLUIR_OBRAS_DUPLICADAS_CATALOGO]);
  return rows;
}

app.get('/api/costos/catalogo-basicos', h(auth.checkPermiso('costos', 'puede_ver')), h(async (req, res) => {
  const representativos = await basicosCatalogoQuery();
  if (!representativos.length) return res.json({ catalogo: [] });

  // Todas las versiones (una fila por obra) de cada código representado
  // arriba — el conteo de reuso y la lista de usos deben cruzar TODAS las
  // obras donde ese código de básico existe, no solo la más reciente. Mismo
  // filtro EXCLUIR_OBRAS_DUPLICADAS_CATALOGO que basicosCatalogoQuery: sin
  // esto, un básico con datos en las 3 obras duplicadas de VINTE triplicaría
  // veces_reusado (cada matriz duplicada suma sus propios usos por separado).
  const codigos = representativos.map((r) => r.codigo);
  const { rows: todasVersiones } = await db.pool.query(
    `SELECT m.id, m.codigo FROM matrices_precio_unitario m
     JOIN proyectos p ON p.id = m.project_id
     WHERE m.es_basico = true AND m.codigo = ANY($1::text[]) AND p.id <> ALL($2::int[])`,
    [codigos, EXCLUIR_OBRAS_DUPLICADAS_CATALOGO]
  );
  const idsPorCodigo = new Map();
  for (const v of todasVersiones) {
    if (!idsPorCodigo.has(v.codigo)) idsPorCodigo.set(v.codigo, []);
    idsPorCodigo.get(v.codigo).push(v.id);
  }
  const todosLosIds = todasVersiones.map((v) => v.id);

  // LEFT JOIN (no INNER) a proyectos, resolviendo la obra vía COALESCE:
  // la matriz "consumidora" m puede ser ELLA MISMA un básico (project_id
  // propio, concepto_id NULL) o un análisis normal de concepto (project_id
  // NULL, obra heredada vía c.project_id). El CHECK
  // matrices_precio_unitario_concepto_xor_basico_check garantiza que nunca
  // ambos son NULL ni ambos NOT NULL para la misma fila, así que el
  // COALESCE no corre riesgo de tomar el valor equivocado ni de esconder
  // una fila real. Con INNER JOIN (bug original), CUALQUIER fila donde m
  // fuera un análisis normal (el caso de reuso más común: un básico
  // referenciado desde el análisis de un concepto real) se descartaba en
  // silencio porque m.project_id es NULL ahí — veces_reusado/usado_en
  // terminaban en 0/vacío para casi todo el reuso real. LEFT JOIN además
  // evita perder la fila por completo si algún día la obra no se puede
  // resolver por alguna otra razón — mejor un usado_en con obra_nombre
  // null que un conteo incorrecto.
  const { rows: usos } = await db.pool.query(`
    SELECT r.basico_matriz_id, m.id AS matriz_id, m.es_basico AS usado_en_es_basico, m.codigo AS usado_en_basico_codigo,
           c.id AS concepto_id, c.codigo AS concepto_codigo, c.concepto AS concepto_nombre,
           p.id AS obra_id, p.nombre AS obra_nombre
    FROM matriz_precio_renglones r
    JOIN matrices_precio_unitario m ON m.id = r.matriz_id
    LEFT JOIN conceptos c ON c.id = m.concepto_id
    LEFT JOIN proyectos p ON p.id = COALESCE(m.project_id, c.project_id)
    WHERE r.tipo = 'basico_ref' AND r.basico_matriz_id = ANY($1::int[])
  `, [todosLosIds]);
  const usosPorBasicoId = new Map();
  for (const u of usos) {
    if (!usosPorBasicoId.has(u.basico_matriz_id)) usosPorBasicoId.set(u.basico_matriz_id, []);
    usosPorBasicoId.get(u.basico_matriz_id).push(u);
  }

  const catalogo = [];
  for (const r of representativos) {
    let costo_directo = null;
    let calculo_completo = false;
    try {
      const resuelto = await resolverBasico(r.matriz_id);
      costo_directo = resuelto.costo_directo;
      calculo_completo = resuelto.completa;
    } catch {
      // Defensa en profundidad (mismo criterio que resolverRenglonesBasicoRef
      // más arriba): un básico con dato corrupto (ej. referencia circular que
      // se hubiera colado antes de validarSinCicloBasico) no debe tumbar el
      // catálogo completo — se deja costo_directo en null para esa fila.
    }
    const idsDelCodigo = idsPorCodigo.get(r.codigo) || [r.matriz_id];
    const usado_en = idsDelCodigo.flatMap((id) => usosPorBasicoId.get(id) || []);
    catalogo.push({
      codigo: r.codigo,
      descripcion: r.descripcion,
      unidad: r.unidad,
      costo_directo,
      calculo_completo,
      cliente_id: r.cliente_id,
      cliente_nombre: r.cliente_nombre,
      obra_origen_id: r.obra_origen_id,
      obra_origen: r.obra_origen,
      fecha_origen: r.fecha_origen,
      veces_reusado: usado_en.length,
      usado_en: usado_en.map((u) => ({
        matriz_id: u.matriz_id,
        obra_id: u.obra_id,
        obra_nombre: u.obra_nombre,
        concepto_id: u.concepto_id,
        concepto_codigo: u.concepto_codigo,
        concepto_nombre: u.concepto_nombre,
        // Cuando el "consumidor" es OTRO básico (anidamiento multinivel,
        // concepto_id null) — mismo criterio que el usado_en por-obra de
        // GET /basicos/:basicoId más arriba.
        es_basico: u.usado_en_es_basico,
        basico_codigo: u.usado_en_basico_codigo,
      })),
    });
  }

  res.json({ catalogo });
}));

app.get('/api/projects/:id/matrices', h(auth.allow('residente', 'costos')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('costos', 'puede_ver')), h(async (req, res) => {
  const pid = req.project.id;
  const { rows: conceptoRows } = await db.pool.query(
    'SELECT id, codigo, concepto, unidad, precio_unitario FROM conceptos WHERE project_id = $1 AND es_total = 0 AND activo = 1 ORDER BY orden', [pid]
  );
  const { rows: matrizRows } = await db.pool.query(`
    SELECT m.* FROM matrices_precio_unitario m JOIN conceptos c ON c.id = m.concepto_id WHERE c.project_id = $1
  `, [pid]);
  const matrizPorConcepto = new Map(matrizRows.map((m) => [m.concepto_id, m]));
  const matrizIds = matrizRows.map((m) => m.id);
  const renglonesPorMatriz = new Map();
  if (matrizIds.length) {
    const { rows: renglonRows } = await db.pool.query(`
      SELECT r.matriz_id, r.categoria, r.tipo, r.cantidad, r.operador, r.factor_referencia, r.basico_matriz_id, i.precio_presupuesto
      FROM matriz_precio_renglones r LEFT JOIN insumos i ON i.id = r.insumo_id
      WHERE r.matriz_id = ANY($1)
    `, [matrizIds]);
    for (const r of renglonRows) {
      if (!renglonesPorMatriz.has(r.matriz_id)) renglonesPorMatriz.set(r.matriz_id, []);
      renglonesPorMatriz.get(r.matriz_id).push(r);
    }
  }
  // Cache por-request: varios análisis de la misma obra pueden reusar el
  // mismo básico (ese es justo el punto) — resolverlo una sola vez.
  const basicoCache = new Map();
  const resolverBasicoCacheado = async (basicoId) => {
    if (!basicoCache.has(basicoId)) basicoCache.set(basicoId, await resolverBasico(basicoId, []));
    return basicoCache.get(basicoId);
  };
  const matrices = [];
  for (const c of conceptoRows) {
    const m = matrizPorConcepto.get(c.id);
    if (!m) { matrices.push({ concepto_id: c.id, codigo: c.codigo, concepto: c.concepto, unidad: c.unidad, precio_unitario_actual: Number(c.precio_unitario), tiene_matriz: false }); continue; }
    const renglones = renglonesPorMatriz.get(m.id) || [];
    for (const r of renglones) {
      if (r.tipo === 'basico_ref') {
        const basico = await resolverBasicoCacheado(r.basico_matriz_id);
        r.precio_basico = basico.costo_directo;
      }
    }
    matrices.push({
      concepto_id: c.id, codigo: c.codigo, concepto: c.concepto, unidad: c.unidad,
      precio_unitario_actual: Number(c.precio_unitario), tiene_matriz: true,
      pct_indirecto: m.pct_indirecto, pct_utilidad: m.pct_utilidad, pct_financiamiento: m.pct_financiamiento,
      rendimiento: m.rendimiento,
      ...calcularMatrizNeodata(renglones, m),
    });
  }
  res.json({ matrices });
}));

// Rutas literales (/export, /porcentajes-obra) ANTES de /matrices/:conceptoId
// — Express no prioriza segmentos literales sobre params por especificidad,
// solo por orden de registro; con el orden invertido "export"/"porcentajes-
// obra" se habrían capturado como conceptoId.
// prompt-20-matrices-formato-neodata.md, CP6: formato Neodata real (encabezado
// de documento + un bloque de Análisis de Precios Unitarios completo por
// concepto, con subtotales por categoría, cascada de 4 niveles e importe en
// letra) vía server/matricesNeodataExport.js — sendXlsxExport (rígido, sin
// celdas combinadas ni múltiples bloques por hoja) no lo soporta, ver
// comentario de ese módulo. Todos los análisis de la obra caen en bloques
// consecutivos de la misma hoja "Matrices", igual que el Excel de referencia.
async function getClienteNombreDeProyecto(projectId) {
  const { rows } = await db.pool.query(
    'SELECT cl.nombre FROM proyectos p LEFT JOIN clientes cl ON cl.id = p.cliente_id WHERE p.id = $1',
    [projectId]
  );
  return rows[0]?.nombre || null;
}

app.get('/api/projects/:id/matrices/export', h(auth.allow('residente', 'costos')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('costos', 'puede_ver')), h(async (req, res) => {
  const pid = req.project.id;
  const { rows: conceptoRows } = await db.pool.query(
    "SELECT id, codigo, concepto, unidad, cantidad, importe, precio_unitario FROM conceptos WHERE project_id = $1 AND es_total = 0 AND activo = 1 ORDER BY orden", [pid]
  );
  const analisis = [];
  for (const c of conceptoRows) {
    const matriz = await getMatrizConRenglones(c.id);
    if (matriz) analisis.push({ concepto: c, matriz });
  }
  if (!analisis.length) return res.status(404).json({ error: 'Esta obra no tiene matrices creadas todavía' });
  const clienteNombre = await getClienteNombreDeProyecto(pid);
  await sendMatricesNeodataExport(res, {
    filename: buildExportFilename('Matrices-Precio-Unitario', req.project.nombre),
    clienteNombre, obraNombre: req.project.nombre, analisis,
  });
}));

// % de indirecto/utilidad por defecto de la obra — solo para prellenar
// matrices NUEVAS (porcentajes_referencia_costo de PR #48 es un set global
// único, no por obra; se muestra aquí solo como referencia informativa).
app.get('/api/projects/:id/matrices/porcentajes-obra', h(auth.allow('residente', 'costos')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('costos', 'puede_ver')), h(async (req, res) => {
  const pid = req.project.id;
  const [{ rows }, { rows: refRows }] = await Promise.all([
    db.pool.query('SELECT pct_indirecto, pct_utilidad, pct_financiamiento FROM porcentajes_matriz_obra WHERE project_id = $1', [pid]),
    db.pool.query("SELECT porcentaje FROM porcentajes_referencia_costo WHERE categoria = 'indirecto_utilidad'"),
  ]);
  res.json({
    pct_indirecto: rows[0]?.pct_indirecto ?? 0,
    pct_utilidad: rows[0]?.pct_utilidad ?? 0,
    pct_financiamiento: rows[0]?.pct_financiamiento ?? 0,
    referencia_pr48_combinado: refRows[0] ? Number(refRows[0].porcentaje) : null,
  });
}));

app.put('/api/projects/:id/matrices/porcentajes-obra', h(auth.allow('residente', 'costos')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('costos', 'puede_editar_precios')), h(async (req, res) => {
  const pid = req.project.id;
  const { pct_indirecto, pct_utilidad, pct_financiamiento } = req.body || {};
  if (!(Number(pct_indirecto) >= 0) || !(Number(pct_utilidad) >= 0) || !(Number(pct_financiamiento) >= 0)) {
    return res.status(400).json({ error: 'pct_indirecto, pct_utilidad y pct_financiamiento deben ser números >= 0' });
  }
  await db.pool.query(`
    INSERT INTO porcentajes_matriz_obra (project_id, pct_indirecto, pct_utilidad, pct_financiamiento, actualizado_por)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (project_id) DO UPDATE SET pct_indirecto=$2, pct_utilidad=$3, pct_financiamiento=$4, actualizado_por=$5, actualizado_en=NOW()
  `, [pid, Number(pct_indirecto), Number(pct_utilidad), Number(pct_financiamiento), req.user.id]);
  res.json({ pct_indirecto: Number(pct_indirecto), pct_utilidad: Number(pct_utilidad), pct_financiamiento: Number(pct_financiamiento) });
}));

app.put('/api/projects/:id/matrices/porcentajes/lote', h(auth.allow('residente', 'costos')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('costos', 'puede_editar_precios')), h(async (req, res) => {
  const pid = req.project.id;
  const { concepto_ids, pct_indirecto, pct_utilidad, pct_financiamiento } = req.body || {};
  if (!Array.isArray(concepto_ids) || !concepto_ids.length) return res.status(400).json({ error: 'concepto_ids es requerido' });
  if (!(Number(pct_indirecto) >= 0) || !(Number(pct_utilidad) >= 0) || !(Number(pct_financiamiento) >= 0)) {
    return res.status(400).json({ error: 'pct_indirecto, pct_utilidad y pct_financiamiento deben ser números >= 0' });
  }
  const ids = concepto_ids.map(Number);
  const { rows } = await db.pool.query(`
    UPDATE matrices_precio_unitario m SET pct_indirecto=$1, pct_utilidad=$2, pct_financiamiento=$3, actualizado_por=$4, actualizado_en=NOW()
    FROM conceptos c WHERE c.id = m.concepto_id AND m.concepto_id = ANY($5) AND c.project_id = $6
    RETURNING m.concepto_id
  `, [Number(pct_indirecto), Number(pct_utilidad), Number(pct_financiamiento), req.user.id, ids, pid]);
  res.json({ actualizadas: rows.map((r) => r.concepto_id) });
}));

app.get('/api/projects/:id/matrices/:conceptoId', h(auth.allow('residente', 'costos')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('costos', 'puede_ver')), h(async (req, res) => {
  const pid = req.project.id;
  const conceptoId = Number(req.params.conceptoId);
  const { rows: conceptoRows } = await db.pool.query(
    'SELECT id, codigo, concepto, unidad, precio_unitario FROM conceptos WHERE id = $1 AND project_id = $2', [conceptoId, pid]
  );
  if (!conceptoRows[0]) return res.status(404).json({ error: 'Concepto no encontrado' });
  const matriz = await getMatrizConRenglones(conceptoId);
  res.json({ concepto: conceptoRows[0], matriz });
}));

// Exporta un solo análisis (prompt-20-matrices-formato-neodata.md, CP6) —
// mismo generador que la exportación de toda la obra, con un único bloque.
app.get('/api/projects/:id/matrices/:conceptoId/export', h(auth.allow('residente', 'costos')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('costos', 'puede_ver')), h(async (req, res) => {
  const pid = req.project.id;
  const conceptoId = Number(req.params.conceptoId);
  const { rows: conceptoRows } = await db.pool.query(
    'SELECT id, codigo, concepto, unidad, cantidad, importe, precio_unitario FROM conceptos WHERE id = $1 AND project_id = $2', [conceptoId, pid]
  );
  if (!conceptoRows[0]) return res.status(404).json({ error: 'Concepto no encontrado' });
  const matriz = await getMatrizConRenglones(conceptoId);
  if (!matriz) return res.status(404).json({ error: 'Este concepto no tiene una matriz creada' });
  const clienteNombre = await getClienteNombreDeProyecto(pid);
  await sendMatricesNeodataExport(res, {
    filename: buildExportFilename(`Matriz-${conceptoRows[0].codigo || conceptoId}`, req.project.nombre),
    clienteNombre, obraNombre: req.project.nombre, analisis: [{ concepto: conceptoRows[0], matriz }],
  });
}));

app.post('/api/projects/:id/matrices', h(auth.allow('residente', 'costos')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('costos', 'puede_crear')), h(async (req, res) => {
  const pid = req.project.id;
  const { concepto_id, renglones, partida, analisis_no, cuadrilla_nombre, rendimiento } = req.body || {};
  const conceptoId = Number(concepto_id);
  if (!conceptoId) return res.status(400).json({ error: 'concepto_id es requerido' });
  const { rows: conceptoRows } = await db.pool.query('SELECT id FROM conceptos WHERE id = $1 AND project_id = $2', [conceptoId, pid]);
  if (!conceptoRows[0]) return res.status(404).json({ error: 'Concepto no encontrado' });

  const insumoIdsCandidatos = (renglones || []).filter((r) => r.tipo === 'insumo').map((r) => Number(r.insumo_id));
  const { rows: insumoRows } = await db.pool.query('SELECT id FROM insumos WHERE id = ANY($1) AND project_id = $2', [insumoIdsCandidatos, pid]);
  const insumoIdsValidos = new Set(insumoRows.map((r) => r.id));
  const basicoIdsCandidatos = (renglones || []).filter((r) => r.tipo === 'basico_ref').map((r) => Number(r.basico_matriz_id));
  const { rows: basicoRows } = await db.pool.query('SELECT id FROM matrices_precio_unitario WHERE id = ANY($1) AND project_id = $2 AND es_basico = true', [basicoIdsCandidatos, pid]);
  const basicoIdsValidos = new Set(basicoRows.map((r) => r.id));
  const errorValidacion = validarRenglones(renglones, insumoIdsValidos, basicoIdsValidos);
  if (errorValidacion) return res.status(400).json({ error: errorValidacion });
  const errorCiclo = await validarSinCicloBasico(renglones, null);
  if (errorCiclo) return res.status(400).json({ error: errorCiclo });

  // % iniciales de la matriz nueva: default por obra (nunca el 10% combinado
  // global de PR #48 — ese set no distingue indirecto de utilidad). Se
  // guardan como snapshot en la fila de la matriz: cambiar el default de la
  // obra después no altera esta matriz retroactivamente.
  const { rows: defRows } = await db.pool.query('SELECT pct_indirecto, pct_utilidad, pct_financiamiento FROM porcentajes_matriz_obra WHERE project_id = $1', [pid]);
  const pctIndirecto = defRows[0]?.pct_indirecto ?? 0;
  const pctUtilidad = defRows[0]?.pct_utilidad ?? 0;
  const pctFinanciamiento = defRows[0]?.pct_financiamiento ?? 0;

  let matrizId;
  try {
    await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO matrices_precio_unitario
           (concepto_id, pct_indirecto, pct_utilidad, pct_financiamiento, rendimiento, partida, analisis_no, cuadrilla_nombre, creado_por, actualizado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
        [conceptoId, pctIndirecto, pctUtilidad, pctFinanciamiento, rendimiento || null, partida || null, analisis_no || null, cuadrilla_nombre || null, req.user.id]
      );
      matrizId = rows[0].id;
      await insertarRenglones(client, matrizId, renglones);
    });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Este concepto ya tiene una matriz de precio unitario' });
    throw err;
  }
  res.status(201).json({ matriz: await getMatrizConRenglones(conceptoId) });
}));

app.put('/api/projects/:id/matrices/:conceptoId/renglones', h(auth.allow('residente', 'costos')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('costos', 'puede_editar')), h(async (req, res) => {
  const pid = req.project.id;
  const conceptoId = Number(req.params.conceptoId);
  const { renglones, partida, analisis_no, cuadrilla_nombre, rendimiento } = req.body || {};

  const insumoIdsCandidatos = (renglones || []).filter((r) => r.tipo === 'insumo').map((r) => Number(r.insumo_id));
  const { rows: insumoRows } = await db.pool.query('SELECT id FROM insumos WHERE id = ANY($1) AND project_id = $2', [insumoIdsCandidatos, pid]);
  const insumoIdsValidos = new Set(insumoRows.map((r) => r.id));
  const basicoIdsCandidatos = (renglones || []).filter((r) => r.tipo === 'basico_ref').map((r) => Number(r.basico_matriz_id));
  const { rows: basicoRows } = await db.pool.query('SELECT id FROM matrices_precio_unitario WHERE id = ANY($1) AND project_id = $2 AND es_basico = true', [basicoIdsCandidatos, pid]);
  const basicoIdsValidos = new Set(basicoRows.map((r) => r.id));
  const errorValidacion = validarRenglones(renglones, insumoIdsValidos, basicoIdsValidos);
  if (errorValidacion) return res.status(400).json({ error: errorValidacion });

  const { rows: matrizRows } = await db.pool.query(`
    SELECT m.id FROM matrices_precio_unitario m JOIN conceptos c ON c.id = m.concepto_id
    WHERE m.concepto_id = $1 AND c.project_id = $2
  `, [conceptoId, pid]);
  if (!matrizRows[0]) return res.status(404).json({ error: 'Este concepto no tiene matriz. Créala primero.' });
  const matrizId = matrizRows[0].id;

  const errorCiclo = await validarSinCicloBasico(renglones, matrizId);
  if (errorCiclo) return res.status(400).json({ error: errorCiclo });

  await db.withTransaction(async (client) => {
    await client.query('DELETE FROM matriz_precio_renglones WHERE matriz_id = $1', [matrizId]);
    await insertarRenglones(client, matrizId, renglones);
    await client.query(
      `UPDATE matrices_precio_unitario
       SET partida=$1, analisis_no=$2, cuadrilla_nombre=$3, rendimiento=$4, actualizado_por=$5, actualizado_en=NOW()
       WHERE id=$6`,
      [partida || null, analisis_no || null, cuadrilla_nombre || null, rendimiento || null, req.user.id, matrizId]
    );
  });
  res.json({ matriz: await getMatrizConRenglones(conceptoId) });
}));

app.put('/api/projects/:id/matrices/:conceptoId/porcentajes', h(auth.allow('residente', 'costos')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('costos', 'puede_editar_precios')), h(async (req, res) => {
  const pid = req.project.id;
  const conceptoId = Number(req.params.conceptoId);
  const { pct_indirecto, pct_utilidad, pct_financiamiento } = req.body || {};
  if (!(Number(pct_indirecto) >= 0) || !(Number(pct_utilidad) >= 0) || !(Number(pct_financiamiento) >= 0)) {
    return res.status(400).json({ error: 'pct_indirecto, pct_utilidad y pct_financiamiento deben ser números >= 0' });
  }
  const { rows } = await db.pool.query(`
    UPDATE matrices_precio_unitario m SET pct_indirecto=$1, pct_utilidad=$2, pct_financiamiento=$3, actualizado_por=$4, actualizado_en=NOW()
    FROM conceptos c WHERE c.id = m.concepto_id AND m.concepto_id = $5 AND c.project_id = $6
    RETURNING m.id
  `, [Number(pct_indirecto), Number(pct_utilidad), Number(pct_financiamiento), req.user.id, conceptoId, pid]);
  if (!rows[0]) return res.status(404).json({ error: 'Este concepto no tiene matriz' });
  res.json({ matriz: await getMatrizConRenglones(conceptoId) });
}));

// Aplicar el precio calculado de la matriz a conceptos.precio_unitario —
// SIEMPRE explícito (Forbidden Action: nunca sobrescribir en silencio).
// Recalcula server-side (no confía en un precio_unitario_calculado que venga
// del cliente) y bloquea si la matriz está incompleta (categoría "No
// disponible") — aplicar un precio construido con datos faltantes sería
// fabricar el faltante como si fuera $0.
app.post('/api/projects/:id/matrices/:conceptoId/aplicar', h(auth.allow('residente', 'costos')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('costos', 'puede_editar_precios')), h(async (req, res) => {
  const pid = req.project.id;
  const conceptoId = Number(req.params.conceptoId);
  const matriz = await getMatrizConRenglones(conceptoId);
  if (!matriz) return res.status(404).json({ error: 'Este concepto no tiene matriz' });
  if (!matriz.completa) return res.status(400).json({ error: 'La matriz está incompleta (hay categorías "No disponible") — no se puede aplicar todavía.' });

  const { rows: conceptoRows } = await db.pool.query('SELECT id, cantidad, precio_unitario FROM conceptos WHERE id = $1 AND project_id = $2', [conceptoId, pid]);
  if (!conceptoRows[0]) return res.status(404).json({ error: 'Concepto no encontrado' });
  const concepto = conceptoRows[0];
  const precioAnterior = Number(concepto.precio_unitario);
  const precioNuevo = matriz.precio_unitario_calculado;
  const importe = Number(concepto.cantidad) * precioNuevo;

  await db.withTransaction(async (client) => {
    await client.query('UPDATE conceptos SET precio_unitario=$1, importe=$2 WHERE id=$3', [precioNuevo, importe, conceptoId]);
    const ip = auth.getIp(req);
    await client.query(
      `INSERT INTO audit_log (actor_id, actor_usuario, accion, target_id, project_id, ip, detalle)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [req.user.id, req.user.usuario, 'aplicar_matriz_precio_unitario', conceptoId, pid, ip,
        JSON.stringify({ precio_anterior: precioAnterior, precio_nuevo: precioNuevo })]
    );
  });
  res.json({ concepto_id: conceptoId, precio_anterior: precioAnterior, precio_nuevo: precioNuevo });
}));

app.delete('/api/projects/:id/matrices/:conceptoId', h(auth.allow('residente', 'costos')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('costos', 'puede_eliminar')), h(async (req, res) => {
  const pid = req.project.id;
  const conceptoId = Number(req.params.conceptoId);
  const { rowCount } = await db.pool.query(`
    DELETE FROM matrices_precio_unitario m USING conceptos c
    WHERE c.id = m.concepto_id AND m.concepto_id = $1 AND c.project_id = $2
  `, [conceptoId, pid]);
  if (!rowCount) return res.status(404).json({ error: 'Este concepto no tiene matriz' });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Importador de la hoja "Matrices" (prompt-importador-matrices-
// implementacion.md, ver diagnóstico previo validado contra el archivo
// real de Kaila — 23 bloques, formato Neodata). Paso SEPARADO y OPCIONAL de
// "Actualizar presupuesto"/alta de obra (Forbidden Action: no tocar
// ingest.js) — asume que la obra ya tiene sus conceptos/insumos cargados
// por el flujo normal, y solo resuelve la hoja "Matrices" contra ese
// catálogo ya existente (nunca reparsea la hoja de Insumos). Mismo patrón
// preview→confirmar que "Actualizar presupuesto" (descargarBlobXlsxATmp +
// exceljs; confirm nunca confía en lo que mandó el preview, re-parsea y
// re-resuelve desde cero).
//
// Un bloque queda en 3 estados posibles:
//   'ok'      — se resolvió completo, se inserta al confirmar.
//   'omitido' — el concepto ya tiene una matriz (nunca se sobreescribe en
//               silencio, mismo criterio que /aplicar arriba).
//   'error'   — código de insumo/cuadrilla no resoluble, factor_pct sin
//               base identificable, concepto no encontrado, o estructura
//               de archivo rota — se salta, NUNCA se inserta parcial.
// La confirmación inserta únicamente los bloques 'ok' (decisión confirmada
// con Paul) y reporta 'omitido'/'error' en la respuesta — nunca aborta todo
// por un bloque malo, ni inserta un bloque a medias.
// ---------------------------------------------------------------------------
async function prepararImportacionMatrices(pid, archivo_url) {
  const tmpPath = path.join(os.tmpdir(), `matrices-import-${Date.now()}-${Math.round(Math.random() * 1e9)}.xlsx`);
  try {
    await descargarBlobXlsxATmp(archivo_url, tmpPath);
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(tmpPath);
    const sheet = wb.getWorksheet('Matrices');
    if (!sheet) throw new Error('El archivo no tiene una hoja llamada "Matrices".');
    const bloquesCrudos = matricesImport.parseMatricesSheet(sheet);
    if (!bloquesCrudos.length) throw new Error('No se detectó ningún bloque de análisis ("Partida:") en la hoja "Matrices".');

    const [{ rows: conceptoRows }, { rows: insumoRows }, { rows: matrizRows }] = await Promise.all([
      db.pool.query('SELECT id, codigo FROM conceptos WHERE project_id = $1 AND activo = 1 AND codigo IS NOT NULL', [pid]),
      db.pool.query('SELECT id, codigo, categoria, precio_presupuesto FROM insumos WHERE project_id = $1 AND codigo IS NOT NULL', [pid]),
      db.pool.query('SELECT m.concepto_id FROM matrices_precio_unitario m JOIN conceptos c ON c.id = m.concepto_id WHERE c.project_id = $1', [pid]),
    ]);
    // codigo -> array de filas (no un Map codigo->fila: el MISMO código
    // puede repetir dentro de una obra apuntando a 2 conceptos reales
    // distintos — confirmado con datos reales, AJAL.KAI.EXC01 en 2
    // capítulos de la obra de Kaila. Un Map perdería una de las 2 filas en
    // silencio y podría emparejar el bloque equivocado con el concepto
    // equivocado — decisión confirmada: bloquear TODAS las ocurrencias de
    // un código ambiguo en vez de adivinar cuál es cuál).
    const conceptosPorCodigo = new Map();
    for (const c of conceptoRows) {
      if (!conceptosPorCodigo.has(c.codigo)) conceptosPorCodigo.set(c.codigo, []);
      conceptosPorCodigo.get(c.codigo).push(c);
    }
    const insumosPorCodigo = new Map(insumoRows.map((i) => [i.codigo, i]));
    const conceptoIdsConMatriz = new Set(matrizRows.map((m) => m.concepto_id));

    const resultados = bloquesCrudos.map((bloque) => matricesImport.resolverBloqueImportacion(bloque, { conceptosPorCodigo, insumosPorCodigo, conceptoIdsConMatriz }));
    // Salvaguarda extra: 2 bloques del MISMO archivo resolviendo al mismo
    // concepto_id violaría el UNIQUE(concepto_id) al confirmar — se detecta
    // aquí, antes de tocar la base, en vez de dejar que la transacción
    // reviente a medias.
    const vistos = new Set();
    for (const r of resultados) {
      if (r.estado !== 'ok') continue;
      if (vistos.has(r.concepto_id)) { r.estado = 'error'; r.motivo = `Código de análisis "${r.codigo_analisis}" duplicado dentro de este mismo archivo.`; continue; }
      vistos.add(r.concepto_id);
    }
    return resultados;
  } finally {
    fs.rm(tmpPath, () => {});
  }
}

// prompt-matrices-auto-import-alta-obra.md: resolverBloqueImportacion se
// extrajo a server/matricesImport.js (con calcularMatrizNeodata inyectada,
// mismo patrón que el resto del módulo) para que ingest.js pueda reusarla
// tal cual durante el alta de obra, sin duplicar el matching bloque->concepto.

function resumenImportacionMatrices(resultados) {
  const limpiar = (r) => { const { _persistencia, ...resto } = r; return resto; };
  return {
    bloques: resultados.map(limpiar),
    resumen: {
      total: resultados.length,
      ok: resultados.filter((r) => r.estado === 'ok').length,
      omitidos: resultados.filter((r) => r.estado === 'omitido').length,
      con_error: resultados.filter((r) => r.estado === 'error').length,
    },
  };
}

app.post('/api/projects/:id/matrices/import/preview', h(auth.allow('residente', 'costos')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('costos', 'puede_crear')), h(async (req, res) => {
  const { archivo_url } = req.body || {};
  if (!archivo_url) return res.status(400).json({ error: 'Sube un archivo .xlsx con la hoja "Matrices"' });
  try {
    const resultados = await prepararImportacionMatrices(req.project.id, archivo_url);
    res.json(resumenImportacionMatrices(resultados));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.post('/api/projects/:id/matrices/import/confirm', h(auth.allow('residente', 'costos')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('costos', 'puede_crear')), h(async (req, res) => {
  const { archivo_url, confirmado } = req.body || {};
  if (!archivo_url) return res.status(400).json({ error: 'Sube un archivo .xlsx con la hoja "Matrices"' });
  if (confirmado !== true) return res.status(400).json({ error: 'Falta confirmar explícitamente la importación' });
  const pid = req.project.id;
  try {
    // Nunca confía en lo que el frontend mandó del preview — re-parsea y
    // re-resuelve desde cero (mismo criterio que "Actualizar presupuesto").
    const resultados = await prepararImportacionMatrices(pid, archivo_url);
    const okBloques = resultados.filter((r) => r.estado === 'ok');

    let creadas = 0;
    if (okBloques.length) {
      await db.withTransaction(async (client) => {
        for (const r of okBloques) {
          const p = r._persistencia;
          const basicoIdPorCodigo = new Map();
          for (const b of p.basicosResueltos) {
            const { rows } = await client.query(
              `INSERT INTO matrices_precio_unitario (es_basico, project_id, codigo, descripcion, unidad, creado_por, actualizado_por)
               VALUES (true, $1, $2, $3, $4, $5, $5) RETURNING id`,
              [pid, b.codigo, b.descripcion, b.unidad || null, req.user.id]
            );
            basicoIdPorCodigo.set(b.codigo, rows[0].id);
            await insertarRenglones(client, rows[0].id, b.renglones);
          }
          const { rows: matrizRows } = await client.query(
            `INSERT INTO matrices_precio_unitario
               (concepto_id, pct_indirecto, pct_utilidad, pct_financiamiento, rendimiento, partida, analisis_no, cuadrilla_nombre, creado_por, actualizado_por)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
            [p.concepto_id, p.pct_indirecto, p.pct_utilidad, p.pct_financiamiento, p.rendimiento, p.partida, p.analisis_no, p.cuadrilla_nombre, req.user.id]
          );
          const renglonesFinales = [
            ...p.renglonesDirectos,
            ...p.renglonesBasicoRef.map((rb) => ({
              categoria: 'BASICOS', tipo: 'basico_ref',
              basico_matriz_id: basicoIdPorCodigo.get(rb.codigo_basico), cantidad: rb.cantidad,
            })),
          ];
          await insertarRenglones(client, matrizRows[0].id, renglonesFinales);
          creadas++;
        }
        const ip = auth.getIp(req);
        await client.query(
          `INSERT INTO audit_log (actor_id, actor_usuario, accion, target_id, project_id, ip, detalle)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [req.user.id, req.user.usuario, 'importar_matrices', pid, pid, ip,
            JSON.stringify({ archivo_url, creadas, omitidos: resultados.filter((r) => r.estado === 'omitido').length, con_error: resultados.filter((r) => r.estado === 'error').length })]
        );
      });
    }
    res.json({ ...resumenImportacionMatrices(resultados), creadas });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// ---------------------------------------------------------------------------
// Reprocesar Destajo/Matrices en obras existentes
// (prompt-reprocesar-destajo-matrices-obras-viejas.md) — completa
// destajo_items/matrices_precio_unitario en obras cargadas ANTES del fix de
// PR #178/#179 (v355), volviendo a subir el mismo Excel original. NUNCA crea
// conceptos, NUNCA toca Presupuesto/Insumos ya cargados -- solo resuelve las
// hojas Destajos/Matrices contra los conceptos YA EXISTENTES de la obra por
// código. Reusa parseWorkbook (ya sabe leer ambas hojas del formato estándar
// de 5 hojas) y matricesImport.resolverBloqueImportacion tal cual (diseñada
// justo para este caso: matching contra conceptos ya existentes).
// ---------------------------------------------------------------------------
async function prepararReprocesoDestajoMatrices(pid, parsed) {
  if (!parsed.destajistas.length && !parsed.matricesBloques.length) {
    throw new Error('No se detectó una hoja "Destajos" ni "Matrices" en este archivo.');
  }
  const [{ rows: conceptoRows }, { rows: insumoRows }, { rows: destajoConceptoRows }, { rows: matrizConceptoRows }] = await Promise.all([
    db.pool.query('SELECT id, codigo FROM conceptos WHERE project_id = $1 AND codigo IS NOT NULL', [pid]),
    db.pool.query('SELECT id, codigo, categoria, precio_presupuesto FROM insumos WHERE project_id = $1 AND codigo IS NOT NULL', [pid]),
    db.pool.query('SELECT DISTINCT concepto_id FROM destajo_items WHERE project_id = $1 AND concepto_id IS NOT NULL', [pid]),
    db.pool.query('SELECT m.concepto_id FROM matrices_precio_unitario m JOIN conceptos c ON c.id = m.concepto_id WHERE c.project_id = $1', [pid]),
  ]);
  // conceptosPorCodigo: array de candidatos por código (no un Map 1:1) para
  // detectar códigos ambiguos dentro de la obra -- mismo criterio que
  // prepararImportacionMatrices, compartido aquí entre Destajo y Matrices.
  const conceptosPorCodigo = new Map();
  for (const c of conceptoRows) {
    if (!conceptosPorCodigo.has(c.codigo)) conceptosPorCodigo.set(c.codigo, []);
    conceptosPorCodigo.get(c.codigo).push(c);
  }
  const insumosPorCodigo = new Map(insumoRows.map((i) => [i.codigo, i]));
  const conceptoIdsConDestajo = new Set(destajoConceptoRows.map((r) => r.concepto_id));
  const conceptoIdsConMatriz = new Set(matrizConceptoRows.map((r) => r.concepto_id));

  const destajo = reprocesoDestajoMatrices.resolverDestajoContraConceptos(
    parsed.destajistas, { conceptosPorCodigo, conceptoIdsConDestajo, destajoPrecios: parsed.destajoPrecios }
  );

  const matrices = parsed.matricesBloques.map((bloque) => matricesImport.resolverBloqueImportacion(
    bloque, { conceptosPorCodigo, insumosPorCodigo, conceptoIdsConMatriz }
  ));
  // Misma salvaguarda que prepararImportacionMatrices: 2 bloques del mismo
  // archivo resolviendo al mismo concepto_id violaría el UNIQUE(concepto_id).
  const vistos = new Set();
  for (const r of matrices) {
    if (r.estado !== 'ok') continue;
    if (vistos.has(r.concepto_id)) { r.estado = 'error'; r.motivo = `Código de análisis "${r.codigo_analisis}" duplicado dentro de este mismo archivo.`; continue; }
    vistos.add(r.concepto_id);
  }

  return {
    destajo,
    matrices,
    resumen: {
      destajo_nuevos: destajo.nuevos.length,
      destajo_omitidos: destajo.omitidos.length,
      destajo_sin_match: destajo.sinMatch.length,
      destajo_ambiguos: destajo.ambiguos.length,
      matrices_nuevas: matrices.filter((r) => r.estado === 'ok').length,
      matrices_omitidas: matrices.filter((r) => r.estado === 'omitido').length,
      matrices_con_error: matrices.filter((r) => r.estado === 'error').length,
    },
  };
}

app.post('/api/projects/:id/reprocesar-destajo-matrices/preview', h(auth.allow('residente', 'costos')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('costos', 'puede_crear')), h(async (req, res) => {
  const { archivo_url } = req.body || {};
  if (!archivo_url) return res.status(400).json({ error: 'Sube el archivo .xlsx original de esta obra' });
  const pid = req.project.id;
  const tmpPath = path.join(os.tmpdir(), `reprocesar-dm-${Date.now()}-${Math.round(Math.random() * 1e9)}.xlsx`);
  try {
    await descargarBlobXlsxATmp(archivo_url, tmpPath);
    const parsed = await parseWorkbook(tmpPath);
    const resultado = await prepararReprocesoDestajoMatrices(pid, parsed);
    const { matrices, ...resto } = resultado;
    res.json({ ...resto, matrices: matrices.map(({ _persistencia, ...m }) => m) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  } finally {
    fs.rm(tmpPath, () => {});
  }
}));

app.post('/api/projects/:id/reprocesar-destajo-matrices/confirm', h(auth.allow('residente', 'costos')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('costos', 'puede_crear')), h(async (req, res) => {
  const { archivo_url, confirmado } = req.body || {};
  if (!archivo_url) return res.status(400).json({ error: 'Sube el archivo .xlsx original de esta obra' });
  if (confirmado !== true) return res.status(400).json({ error: 'Falta confirmar explícitamente el reproceso' });
  const pid = req.project.id;
  const tmpPath = path.join(os.tmpdir(), `reprocesar-dm-${Date.now()}-${Math.round(Math.random() * 1e9)}.xlsx`);
  try {
    // Nunca confía en lo que el frontend mandó del preview — re-parsea y
    // re-resuelve desde cero (mismo criterio que "Actualizar presupuesto" y
    // que el importador manual de Matrices).
    await descargarBlobXlsxATmp(archivo_url, tmpPath);
    const parsed = await parseWorkbook(tmpPath);
    const resultado = await prepararReprocesoDestajoMatrices(pid, parsed);

    let destajoCreados = 0;
    let matricesCreadas = 0;
    await db.withTransaction(async (client) => {
      if (resultado.destajo.nuevos.length) {
        const { rows: destExistentes } = await client.query('SELECT id, nombre FROM destajistas WHERE project_id = $1', [pid]);
        const destajistaIdPorNombreLower = new Map(destExistentes.map((d) => [d.nombre.toLowerCase(), d.id]));
        let siguienteOrden = destExistentes.length;
        const porDestajista = new Map();
        for (const item of resultado.destajo.nuevos) {
          const key = item.destajista_nombre.toLowerCase();
          if (!porDestajista.has(key)) porDestajista.set(key, []);
          porDestajista.get(key).push(item);
        }
        for (const [key, items] of porDestajista) {
          let destajistaId = destajistaIdPorNombreLower.get(key);
          if (!destajistaId) {
            const { rows } = await client.query(
              'INSERT INTO destajistas (project_id, nombre, orden) VALUES ($1,$2,$3) RETURNING id',
              [pid, items[0].destajista_nombre, siguienteOrden++]
            );
            destajistaId = rows[0].id;
            destajistaIdPorNombreLower.set(key, destajistaId);
          }
          for (const item of items) {
            await client.query(
              `INSERT INTO destajo_items (project_id, destajista_id, concepto_id, codigo, concepto, unidad, cantidad_asignada, precio_destajo, orden)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [pid, destajistaId, item.concepto_id, item.codigo, item.concepto, item.unidad, item.cantidad_asignada, item.precio_destajo, item.orden]
            );
            destajoCreados++;
          }
        }
      }

      const okBloques = resultado.matrices.filter((r) => r.estado === 'ok');
      for (const r of okBloques) {
        const p = r._persistencia;
        const basicoIdPorCodigo = new Map();
        for (const b of p.basicosResueltos) {
          const { rows } = await client.query(
            `INSERT INTO matrices_precio_unitario (es_basico, project_id, codigo, descripcion, unidad, creado_por, actualizado_por)
             VALUES (true, $1, $2, $3, $4, $5, $5) RETURNING id`,
            [pid, b.codigo, b.descripcion, b.unidad || null, req.user.id]
          );
          basicoIdPorCodigo.set(b.codigo, rows[0].id);
          await insertarRenglones(client, rows[0].id, b.renglones);
        }
        const { rows: matrizRows } = await client.query(
          `INSERT INTO matrices_precio_unitario
             (concepto_id, pct_indirecto, pct_utilidad, pct_financiamiento, rendimiento, partida, analisis_no, cuadrilla_nombre, creado_por, actualizado_por)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
          [p.concepto_id, p.pct_indirecto, p.pct_utilidad, p.pct_financiamiento, p.rendimiento, p.partida, p.analisis_no, p.cuadrilla_nombre, req.user.id]
        );
        const renglonesFinales = [
          ...p.renglonesDirectos,
          ...p.renglonesBasicoRef.map((rb) => ({
            categoria: 'BASICOS', tipo: 'basico_ref',
            basico_matriz_id: basicoIdPorCodigo.get(rb.codigo_basico), cantidad: rb.cantidad,
          })),
        ];
        await insertarRenglones(client, matrizRows[0].id, renglonesFinales);
        matricesCreadas++;
      }

      const ip = auth.getIp(req);
      await client.query(
        `INSERT INTO audit_log (actor_id, actor_usuario, accion, target_id, project_id, ip, detalle)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [req.user.id, req.user.usuario, 'reprocesar_destajo_matrices', pid, pid, ip,
          JSON.stringify({ archivo_url, destajo_creados: destajoCreados, matrices_creadas: matricesCreadas, resumen: resultado.resumen })]
      );
    });

    res.json({ destajo_creados: destajoCreados, matrices_creadas: matricesCreadas, resumen: resultado.resumen });
  } catch (err) {
    res.status(400).json({ error: err.message });
  } finally {
    fs.rm(tmpPath, () => {});
  }
}));

// ---------------------------------------------------------------------------
// Control de Cuentas (prompt-control-cuentas.md) — control personal de
// saldo bancario de Paul/Fer, SIN relación con Costos/Finanzas/Nómina.
// Gateado por auth.requireControlCuentasAccess (whitelist de usuario_id,
// server/auth.js) en TODAS las rutas — nunca por rol ni por checkPermiso.
// ---------------------------------------------------------------------------
async function getSaldoActual(cuentaId) {
  const { rows } = await db.pool.query(`
    SELECT c.saldo_inicial, COALESCE(SUM(m.monto), 0) AS total_gastado
    FROM cuentas_control c
    LEFT JOIN movimientos_control m ON m.cuenta_id = c.id
    WHERE c.id = $1
    GROUP BY c.saldo_inicial
  `, [cuentaId]);
  if (!rows[0]) return null;
  return Number(rows[0].saldo_inicial) - Number(rows[0].total_gastado);
}

app.get('/api/control-cuentas/cuentas', h(auth.requireControlCuentasAccess), h(async (req, res) => {
  const { rows: cuentas } = await db.pool.query(`
    SELECT c.*, COALESCE(SUM(m.monto), 0) AS total_gastado
    FROM cuentas_control c
    LEFT JOIN movimientos_control m ON m.cuenta_id = c.id
    WHERE c.activo = true
    GROUP BY c.id
    ORDER BY c.nombre
  `);
  res.json(cuentas.map((c) => ({
    ...c,
    saldo_actual: Number(c.saldo_inicial) - Number(c.total_gastado),
  })));
}));

app.post('/api/control-cuentas/cuentas', h(auth.requireControlCuentasAccess), h(async (req, res) => {
  const { nombre, banco, saldo_inicial, fecha_saldo_inicial } = req.body || {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre de la cuenta es requerido' });
  if (!fecha_saldo_inicial) return res.status(400).json({ error: 'Indica la fecha del saldo inicial' });
  if (!(Number(saldo_inicial) >= 0)) return res.status(400).json({ error: 'Indica un saldo inicial válido' });
  const { rows } = await db.pool.query(
    `INSERT INTO cuentas_control (nombre, banco, saldo_inicial, fecha_saldo_inicial)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [nombre.trim(), banco?.trim() || null, Number(saldo_inicial), fecha_saldo_inicial]
  );
  res.status(201).json({ ...rows[0], saldo_actual: Number(rows[0].saldo_inicial) });
}));

// Desglose semanal (lunes-domingo, mismo criterio que el calendario de
// Asistencia y avances_semanales — confirmado en diagnóstico, no inventado
// aquí). date_trunc('week', fecha) en Postgres ya trunca a lunes (ISO 8601),
// coincide exactamente con el cálculo manual que usa el resto de la app.
app.get('/api/control-cuentas/cuentas/:id/movimientos', h(auth.requireControlCuentasAccess), h(async (req, res) => {
  const cuentaId = Number(req.params.id);
  const { rows: cuentaRows } = await db.pool.query('SELECT * FROM cuentas_control WHERE id = $1', [cuentaId]);
  if (!cuentaRows[0]) return res.status(404).json({ error: 'Cuenta no encontrada' });
  const cuenta = cuentaRows[0];

  const { rows: movimientos } = await db.pool.query(`
    SELECT m.*, u.nombre AS registrado_por_nombre
    FROM movimientos_control m
    LEFT JOIN usuarios u ON u.id = m.registrado_por
    WHERE m.cuenta_id = $1
    ORDER BY m.fecha DESC, m.id DESC
  `, [cuentaId]);

  const { rows: semanas } = await db.pool.query(`
    SELECT date_trunc('week', fecha)::date AS semana_inicio,
      (date_trunc('week', fecha)::date + 6) AS semana_fin,
      SUM(monto) AS gasto_semana
    FROM movimientos_control
    WHERE cuenta_id = $1
    GROUP BY date_trunc('week', fecha)
    ORDER BY semana_inicio
  `, [cuentaId]);

  // Saldo acumulado al cierre de cada semana — corre desde saldo_inicial,
  // restando el gasto de cada semana en orden cronológico (no una resta
  // independiente por semana, para que el saldo de cada corte refleje TODO
  // lo gastado hasta ese punto, no solo esa semana).
  let acumulado = Number(cuenta.saldo_inicial);
  const semanasConSaldo = semanas.map((s) => {
    acumulado -= Number(s.gasto_semana);
    return {
      semana_inicio: s.semana_inicio, semana_fin: s.semana_fin,
      gasto_semana: Number(s.gasto_semana), saldo_al_cierre: acumulado,
    };
  });

  res.json({
    cuenta: { ...cuenta, saldo_actual: acumulado },
    movimientos,
    semanas: semanasConSaldo,
  });
}));

app.post('/api/control-cuentas/movimientos', h(auth.requireControlCuentasAccess), h(async (req, res) => {
  const { cuenta_id, fecha, concepto, monto } = req.body || {};
  if (!cuenta_id || !fecha) return res.status(400).json({ error: 'Indica cuenta y fecha' });
  if (!concepto?.trim()) return res.status(400).json({ error: 'Indica un concepto' });
  if (!(Number(monto) > 0)) return res.status(400).json({ error: 'Indica un monto válido' });
  const { rows: cuentaRows } = await db.pool.query('SELECT id FROM cuentas_control WHERE id = $1 AND activo = true', [Number(cuenta_id)]);
  if (!cuentaRows[0]) return res.status(404).json({ error: 'Cuenta no encontrada' });
  const { rows } = await db.pool.query(
    `INSERT INTO movimientos_control (cuenta_id, fecha, concepto, monto, registrado_por)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [Number(cuenta_id), fecha, concepto.trim(), Number(monto), req.user.id]
  );
  const saldo_actual = await getSaldoActual(Number(cuenta_id));
  res.status(201).json({ ...rows[0], saldo_actual });
}));

// Vista consolidada — suma de todas las cuentas activas.
app.get('/api/control-cuentas/consolidado', h(auth.requireControlCuentasAccess), h(async (req, res) => {
  const { rows: cuentas } = await db.pool.query(`
    SELECT c.id, c.nombre, c.banco, c.saldo_inicial, COALESCE(SUM(m.monto), 0) AS total_gastado
    FROM cuentas_control c
    LEFT JOIN movimientos_control m ON m.cuenta_id = c.id
    WHERE c.activo = true
    GROUP BY c.id
    ORDER BY c.nombre
  `);
  const porCuenta = cuentas.map((c) => ({
    ...c, saldo_actual: Number(c.saldo_inicial) - Number(c.total_gastado),
  }));
  const totalSaldoInicial = porCuenta.reduce((s, c) => s + Number(c.saldo_inicial), 0);
  const totalGastado = porCuenta.reduce((s, c) => s + Number(c.total_gastado), 0);
  res.json({
    cuentas: porCuenta,
    total_saldo_inicial: totalSaldoInicial,
    total_gastado: totalGastado,
    total_saldo_actual: totalSaldoInicial - totalGastado,
  });
}));

// ---------------------------------------------------------------------------
// Control Financiero Fase 1 (prompt-27-control-financiero-fase1.md) —
// Ingresos (facturación/cobro por contrato) y Gastos Indirectos
// Corporativos. Gateado por auth.requireControlFinancieroAccess (whitelist
// de usuario_id, server/auth.js) en TODAS las rutas — nunca por rol ni por
// checkPermiso, mismo criterio que Control de Cuentas arriba.
//
// Ingresos reutiliza las funciones de estadoResultados.js (facturas/cobros,
// mismas tablas que ya usa Tesorería vía /api/projects/:id/facturas) — el
// dato es el mismo, solo cambia quién puede capturarlo desde aquí (whitelist
// en vez de rol tesorería). "Eliminar" = cancelar (soft, ya existente),
// nunca DELETE físico.
//
// Gastos Indirectos Corporativos es tabla nueva (gastos_indirectos_
// corporativos, CP0 punto 2 — deliberadamente separada de gastos_generales,
// ver comentario en server/db.js): project_id nullable, NULL = gasto sin
// obra específica (nómina de oficina, contador, renta). Sin endpoint DELETE
// — regla dura del módulo, solo alta/edición.
// ---------------------------------------------------------------------------
app.get('/api/control-financiero/ingresos', h(auth.requireControlFinancieroAccess), h(async (req, res) => {
  const projectId = Number(req.query.project_id);
  if (!projectId) return res.status(400).json({ error: 'Indica project_id' });
  res.json(await estadoResultados.listFacturas(projectId));
}));

app.post('/api/control-financiero/ingresos', h(auth.requireControlFinancieroAccess), h(async (req, res) => {
  const { project_id, folio, concepto, fecha_emision, monto_subtotal, iva, monto_total, observaciones } = req.body || {};
  if (!project_id) return res.status(400).json({ error: 'Indica la obra' });
  if (!concepto?.trim()) return res.status(400).json({ error: 'El concepto es requerido' });
  const subtotal = Number(monto_subtotal);
  const ivaNum = iva != null && iva !== '' ? Number(iva) : 0;
  const total = monto_total != null && monto_total !== '' ? Number(monto_total) : subtotal + ivaNum;
  if (!Number.isFinite(subtotal) || subtotal <= 0) return res.status(400).json({ error: 'Indica un monto válido' });
  const factura = await estadoResultados.createFactura({
    project_id: Number(project_id), folio, concepto: concepto.trim(), fecha_emision,
    monto_subtotal: subtotal, iva: ivaNum, monto_total: total, observaciones, creado_por: req.user.id,
  });
  res.status(201).json(factura);
}));

app.put('/api/control-financiero/ingresos/:id', h(auth.requireControlFinancieroAccess), h(async (req, res) => {
  const { folio, concepto, fecha_emision, monto_subtotal, iva, monto_total, observaciones } = req.body || {};
  const factura = await estadoResultados.updateFactura(Number(req.params.id), {
    folio, concepto, fecha_emision,
    monto_subtotal: monto_subtotal != null && monto_subtotal !== '' ? Number(monto_subtotal) : null,
    iva: iva != null && iva !== '' ? Number(iva) : null,
    monto_total: monto_total != null && monto_total !== '' ? Number(monto_total) : null,
    observaciones,
  });
  if (!factura) return res.status(404).json({ error: 'Factura no encontrada, cancelada, o ya tiene cobros' });
  res.json(factura);
}));

app.put('/api/control-financiero/ingresos/:id/cancelar', h(auth.requireControlFinancieroAccess), h(async (req, res) => {
  const factura = await estadoResultados.cancelarFactura(Number(req.params.id));
  if (!factura) return res.status(404).json({ error: 'Factura no encontrada, ya cancelada, o ya tiene cobros' });
  res.json(factura);
}));

app.get('/api/control-financiero/ingresos/:id/cobros', h(auth.requireControlFinancieroAccess), h(async (req, res) => {
  res.json(await estadoResultados.listCobros(Number(req.params.id)));
}));

app.post('/api/control-financiero/ingresos/:id/cobros', h(auth.requireControlFinancieroAccess), h(async (req, res) => {
  const { fecha_cobro, monto_cobrado, forma_pago } = req.body || {};
  if (!(Number(monto_cobrado) > 0)) return res.status(400).json({ error: 'Indica un monto de cobro válido' });
  const resultado = await estadoResultados.registrarCobro({
    factura_id: Number(req.params.id), fecha_cobro, monto_cobrado: Number(monto_cobrado), forma_pago, creado_por: req.user.id,
  });
  res.status(201).json(resultado);
}));

// ?project_id= omitido = todos; 'sin-obra' = solo los corporativos (project_id NULL).
app.get('/api/control-financiero/gastos-indirectos', h(auth.requireControlFinancieroAccess), h(async (req, res) => {
  const { project_id } = req.query;
  let sql = `
    SELECT g.*, p.nombre AS project_nombre, u.nombre AS registrado_por_nombre
    FROM gastos_indirectos_corporativos g
    LEFT JOIN proyectos p ON p.id = g.project_id
    LEFT JOIN usuarios u ON u.id = g.registrado_por
  `;
  const params = [];
  if (project_id === 'sin-obra') {
    sql += ' WHERE g.project_id IS NULL';
  } else if (project_id) {
    params.push(Number(project_id));
    sql += ` WHERE g.project_id = $${params.length}`;
  }
  sql += ' ORDER BY g.fecha DESC, g.id DESC';
  const { rows } = await db.pool.query(sql, params);
  res.json(rows);
}));

app.post('/api/control-financiero/gastos-indirectos', h(auth.requireControlFinancieroAccess), h(async (req, res) => {
  const { project_id, tipo, concepto, monto, fecha, observaciones } = req.body || {};
  if (!tipo?.trim()) return res.status(400).json({ error: 'El tipo es requerido' });
  if (!concepto?.trim()) return res.status(400).json({ error: 'El concepto es requerido' });
  const montoNum = Number(monto);
  if (!Number.isFinite(montoNum) || montoNum <= 0) return res.status(400).json({ error: 'El monto debe ser mayor a 0' });
  const { rows } = await db.pool.query(
    `INSERT INTO gastos_indirectos_corporativos (project_id, tipo, concepto, monto, fecha, observaciones, registrado_por)
     VALUES ($1,$2,$3,$4,COALESCE($5::date, CURRENT_DATE),$6,$7) RETURNING *`,
    [project_id ? Number(project_id) : null, tipo.trim(), concepto.trim(), montoNum, fecha || null, observaciones?.trim() || null, req.user.id]
  );
  res.status(201).json(rows[0]);
}));

app.put('/api/control-financiero/gastos-indirectos/:id', h(auth.requireControlFinancieroAccess), h(async (req, res) => {
  const { tipo, concepto, monto, fecha, observaciones } = req.body || {};
  const montoNum = monto != null && monto !== '' ? Number(monto) : null;
  if (montoNum != null && (!Number.isFinite(montoNum) || montoNum <= 0)) {
    return res.status(400).json({ error: 'El monto debe ser mayor a 0' });
  }
  const { rows } = await db.pool.query(
    `UPDATE gastos_indirectos_corporativos SET
       tipo = COALESCE($1, tipo), concepto = COALESCE($2, concepto),
       monto = COALESCE($3, monto), fecha = COALESCE($4::date, fecha),
       observaciones = COALESCE($5, observaciones)
     WHERE id = $6 RETURNING *`,
    [tipo?.trim() || null, concepto?.trim() || null, montoNum, fecha || null, observaciones?.trim() || null, Number(req.params.id)]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Gasto no encontrado' });
  res.json(rows[0]);
}));

// ---------------------------------------------------------------------------
// Contabilidad Fase 1 (prompt-contabilidad-fase1-cuentas-polizas.md) —
// catálogo de cuentas contables + pólizas. Gateado por
// auth.requireContabilidadAccess (whitelist de usuario_id, server/auth.js)
// en TODAS las rutas — nunca por rol ni por checkPermiso, mismo criterio que
// Control Financiero/Control de Cuentas arriba. Silo separado de Finanzas/
// Erogado Real (diagnóstico Fase 0, punto 4) — sin cruce automático.
// "Eliminar" = inactivar (cuentas) o cancelar (pólizas), nunca DELETE físico.
// ---------------------------------------------------------------------------
app.get('/api/contabilidad/cuentas', h(auth.requireContabilidadAccess), h(async (req, res) => {
  const { tipo, estatus } = req.query;
  res.json(await contabilidad.listCuentas({ tipo, estatus }));
}));

app.post('/api/contabilidad/cuentas', h(auth.requireContabilidadAccess), h(async (req, res) => {
  const { codigo, nombre, tipo } = req.body || {};
  if (!codigo?.trim()) return res.status(400).json({ error: 'El código es requerido' });
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  if (!['activo', 'pasivo', 'capital', 'ingreso', 'gasto'].includes(tipo)) {
    return res.status(400).json({ error: 'Tipo inválido' });
  }
  const cuenta = await contabilidad.createCuenta({
    codigo: codigo.trim(), nombre: nombre.trim(), tipo, creado_por: req.user.id,
  });
  res.status(201).json(cuenta);
}));

app.put('/api/contabilidad/cuentas/:id', h(auth.requireContabilidadAccess), h(async (req, res) => {
  const { nombre, tipo } = req.body || {};
  if (tipo && !['activo', 'pasivo', 'capital', 'ingreso', 'gasto'].includes(tipo)) {
    return res.status(400).json({ error: 'Tipo inválido' });
  }
  const cuenta = await contabilidad.updateCuenta(Number(req.params.id), { nombre, tipo });
  if (!cuenta) return res.status(404).json({ error: 'Cuenta no encontrada' });
  res.json(cuenta);
}));

app.put('/api/contabilidad/cuentas/:id/estatus', h(auth.requireContabilidadAccess), h(async (req, res) => {
  const { estatus } = req.body || {};
  if (!['activa', 'inactiva'].includes(estatus)) return res.status(400).json({ error: 'Estatus inválido' });
  const cuenta = await contabilidad.setCuentaEstatus(Number(req.params.id), estatus);
  if (!cuenta) return res.status(404).json({ error: 'Cuenta no encontrada' });
  res.json(cuenta);
}));

app.get('/api/contabilidad/polizas', h(auth.requireContabilidadAccess), h(async (req, res) => {
  const { tipo, cuenta_id, project_id, desde, hasta, estatus } = req.query;
  res.json(await contabilidad.listPolizas({
    tipo, cuenta_id: cuenta_id ? Number(cuenta_id) : undefined, project_id, desde, hasta, estatus,
  }));
}));

app.post('/api/contabilidad/polizas', h(auth.requireContabilidadAccess), h(async (req, res) => {
  const { tipo, fecha, cuenta_id, monto, concepto, referencia_factura, project_id } = req.body || {};
  if (!['ingreso', 'egreso', 'diario'].includes(tipo)) return res.status(400).json({ error: 'Tipo de póliza inválido' });
  if (!cuenta_id) return res.status(400).json({ error: 'Indica la cuenta contable' });
  if (!concepto?.trim()) return res.status(400).json({ error: 'El concepto es requerido' });
  const montoNum = Number(monto);
  if (!Number.isFinite(montoNum) || montoNum <= 0) return res.status(400).json({ error: 'Indica un monto válido' });
  const poliza = await contabilidad.createPoliza({
    tipo, fecha, cuenta_id: Number(cuenta_id), monto: montoNum, concepto: concepto.trim(),
    referencia_factura: referencia_factura?.trim() || null,
    project_id: project_id ? Number(project_id) : null, usuario_id: req.user.id,
  });
  res.status(201).json(poliza);
}));

app.put('/api/contabilidad/polizas/:id/cancelar', h(auth.requireContabilidadAccess), h(async (req, res) => {
  const poliza = await contabilidad.cancelarPoliza(Number(req.params.id), req.user.id);
  if (!poliza) return res.status(404).json({ error: 'Póliza no encontrada o ya cancelada' });
  res.json(poliza);
}));

// ---------------------------------------------------------------------------
// Contabilidad Fase 2 (prompt-contabilidad-fase2-cfdi.md) — repositorio de
// CFDI. Mismo whitelist que Fase 1 (auth.requireContabilidadAccess) en TODAS
// las rutas. Mismo patrón preview→confirm→proxy de descarga que Contrato
// (server/app.js ~3924-4048): preview sube a Blob y extrae campos SIN
// persistir; confirm persiste tras revisión del usuario; el archivo nunca se
// expone por URL directa de Blob, solo vía proxy autenticado.
// SIN FK obligatorio desde `polizas` (diagnóstico Fase 2, punto 3) —
// `polizas.referencia_factura` se queda como texto libre, sin tocar.
// CFDI_PREVIEW_IA_LIMIT solo protege el camino de fallback por IA (PDF de
// representación sin XML) — el camino XML es parseo local determinista, no
// cuesta llamadas a la API, así que no se limita.
// ---------------------------------------------------------------------------
const CFDI_PREVIEW_IA_LIMIT = 10; // máx fallbacks PDF->IA por usuario por hora, mismo límite que Contrato

app.post('/api/contabilidad/cfdi/preview',
  h(auth.requireContabilidadAccess),
  uploadCfdi.fields([{ name: 'xml', maxCount: 1 }, { name: 'pdf', maxCount: 1 }]),
  h(async (req, res) => {
    const xmlFile = req.files?.xml?.[0] || null;
    const pdfFile = req.files?.pdf?.[0] || null;
    const cleanup = () => {
      if (xmlFile) fs.rm(xmlFile.path, () => {});
      if (pdfFile) fs.rm(pdfFile.path, () => {});
    };
    if (!xmlFile && !pdfFile) {
      cleanup();
      return res.status(400).json({ error: 'Sube el XML del CFDI, o al menos el PDF de representación impresa' });
    }
    try {
      if (xmlFile && !await checkFileMagic(xmlFile.path, ['xml'])) {
        return res.status(400).json({ error: 'El archivo XML no parece válido (no empieza con <?xml ni <cfdi:Comprobante)' });
      }
      if (pdfFile && !await checkFileMagic(pdfFile.path, ['pdf'])) {
        return res.status(400).json({ error: 'El archivo PDF no es un PDF válido (firma de contenido incorrecta)' });
      }

      const bufferXml = xmlFile ? await fs.promises.readFile(xmlFile.path) : null;
      const bufferPdf = pdfFile ? await fs.promises.readFile(pdfFile.path) : null;

      let campos;
      let origen;
      if (bufferXml) {
        campos = extraerDatosCFDI(bufferXml);
        origen = 'xml';
      } else {
        // Fallback por IA: solo cuando no hay XML — rate limit propio.
        const { rows: rlRows } = await db.pool.query(
          `SELECT COUNT(*)::int AS n FROM api_rate_limits
           WHERE usuario_id = $1 AND endpoint = 'cfdi_preview_ia'
             AND creado_en > NOW() - INTERVAL '1 hour'`,
          [req.user.id]
        );
        if (rlRows[0].n >= CFDI_PREVIEW_IA_LIMIT) {
          return res.status(429).json({ error: `Límite de ${CFDI_PREVIEW_IA_LIMIT} extracciones por PDF por hora alcanzado. Intenta más tarde, o sube el XML directamente.` });
        }
        await db.pool.query('INSERT INTO api_rate_limits (usuario_id, endpoint) VALUES ($1, $2)', [req.user.id, 'cfdi_preview_ia']);
        campos = await extraerDatosCFDIDesdePdf(bufferPdf);
        origen = 'pdf_representacion';
      }

      // Falla rápido si el UUID ya existe — el UNIQUE de la tabla es la
      // garantía real (contra condiciones de carrera), esto es solo UX.
      const { rows: dupRows } = await db.pool.query('SELECT id FROM cfdi WHERE uuid = $1', [campos.uuid]);
      if (dupRows[0]) {
        return res.status(409).json({ error: `Ya existe un CFDI registrado con el UUID ${campos.uuid}` });
      }

      let xmlBlobUrl = null;
      let pdfBlobUrl = null;
      if (bufferXml) {
        const blobKey = `cfdi/${Date.now()}-${Math.random().toString(36).slice(2)}.xml`;
        const blobResult = await put(blobKey, bufferXml, { access: 'private', contentType: 'application/xml' });
        xmlBlobUrl = blobResult.url;
      }
      if (bufferPdf) {
        const blobKey = `cfdi/${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`;
        const blobResult = await put(blobKey, bufferPdf, { access: 'private', contentType: 'application/pdf' });
        pdfBlobUrl = blobResult.url;
      }

      res.json({
        campos, origen,
        xml_blob_url: xmlBlobUrl, pdf_blob_url: pdfBlobUrl,
        nombre_archivo_xml: xmlFile?.originalname || null,
        nombre_archivo_pdf: pdfFile?.originalname || null,
      });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    } finally {
      cleanup();
    }
  })
);

app.post('/api/contabilidad/cfdi/confirm', h(auth.requireContabilidadAccess), h(async (req, res) => {
  const b = req.body || {};
  const campos = b.campos || {};
  if (!campos.uuid || !campos.rfc_emisor || !campos.rfc_receptor || !campos.fecha_emision ||
      !(Number(campos.subtotal) >= 0) || !(Number(campos.total) >= 0)) {
    return res.status(400).json({ error: 'Faltan campos obligatorios del CFDI' });
  }
  if (!b.xml_blob_url && !b.pdf_blob_url) {
    return res.status(400).json({ error: 'No se recibió ningún archivo — vuelve a intentar la subida' });
  }
  try {
    const { rows } = await db.pool.query(
      `INSERT INTO cfdi (
         uuid, rfc_emisor, rfc_receptor, fecha_emision, subtotal, iva, total, tipo_comprobante,
         origen, xml_blob_url, pdf_blob_url, nombre_archivo_xml, nombre_archivo_pdf, project_id, subido_por
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        campos.uuid, campos.rfc_emisor, campos.rfc_receptor, campos.fecha_emision || null,
        campos.subtotal != null ? Number(campos.subtotal) : null, Number(campos.iva) || 0, Number(campos.total),
        campos.tipo_comprobante || null, b.origen === 'pdf_representacion' ? 'pdf_representacion' : 'xml',
        b.xml_blob_url || null, b.pdf_blob_url || null,
        b.nombre_archivo_xml || null, b.nombre_archivo_pdf || null,
        b.project_id ? Number(b.project_id) : null, req.user.id,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') { // unique_violation (uuid)
      return res.status(409).json({ error: `Ya existe un CFDI registrado con el UUID ${campos.uuid}` });
    }
    throw err;
  }
}));

app.get('/api/contabilidad/cfdi', h(auth.requireContabilidadAccess), h(async (req, res) => {
  const { project_id, rfc_emisor, rfc_receptor, desde, hasta, estatus_sat } = req.query;
  const where = [];
  const params = [];
  if (project_id === 'sin-obra') {
    where.push('c.project_id IS NULL');
  } else if (project_id) {
    params.push(Number(project_id)); where.push(`c.project_id = $${params.length}`);
  }
  if (rfc_emisor) { params.push(`%${rfc_emisor}%`); where.push(`c.rfc_emisor ILIKE $${params.length}`); }
  if (rfc_receptor) { params.push(`%${rfc_receptor}%`); where.push(`c.rfc_receptor ILIKE $${params.length}`); }
  if (desde) { params.push(desde); where.push(`c.fecha_emision >= $${params.length}`); }
  if (hasta) { params.push(hasta); where.push(`c.fecha_emision <= $${params.length}`); }
  if (estatus_sat) { params.push(estatus_sat); where.push(`c.estatus_sat = $${params.length}`); }
  const { rows } = await db.pool.query(`
    SELECT c.*, p.nombre AS project_nombre, u.nombre AS subido_por_nombre
    FROM cfdi c
    LEFT JOIN proyectos p ON p.id = c.project_id
    LEFT JOIN usuarios u ON u.id = c.subido_por
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY c.fecha_emision DESC, c.id DESC
  `, params);
  res.json(rows);
}));

app.put('/api/contabilidad/cfdi/:id/estatus', h(auth.requireContabilidadAccess), h(async (req, res) => {
  const { estatus_sat } = req.body || {};
  if (!['vigente', 'cancelado'].includes(estatus_sat)) return res.status(400).json({ error: 'Estatus inválido' });
  const { rows } = await db.pool.query('UPDATE cfdi SET estatus_sat = $1 WHERE id = $2 RETURNING *', [estatus_sat, Number(req.params.id)]);
  if (!rows[0]) return res.status(404).json({ error: 'CFDI no encontrado' });
  res.json(rows[0]);
}));

// Proxy autenticado — nunca se expone la URL de Blob directa (mismo patrón
// que GET /contrato/pdf, server/app.js ~4040).
app.get('/api/contabilidad/cfdi/:id/archivo', h(auth.requireContabilidadAccess), h(async (req, res) => {
  const tipo = req.query.tipo === 'pdf' ? 'pdf' : 'xml';
  const { rows } = await db.pool.query('SELECT xml_blob_url, pdf_blob_url, nombre_archivo_xml, nombre_archivo_pdf FROM cfdi WHERE id = $1', [Number(req.params.id)]);
  if (!rows[0]) return res.status(404).json({ error: 'CFDI no encontrado' });
  const blobUrl = tipo === 'pdf' ? rows[0].pdf_blob_url : rows[0].xml_blob_url;
  const nombreArchivo = (tipo === 'pdf' ? rows[0].nombre_archivo_pdf : rows[0].nombre_archivo_xml) || `cfdi.${tipo}`;
  if (!blobUrl) return res.status(404).json({ error: `Este CFDI no tiene archivo ${tipo.toUpperCase()} adjunto` });
  const blobResult = await get(blobUrl, { access: 'private' });
  if (!blobResult) return res.status(404).json({ error: 'Archivo no encontrado en almacenamiento' });
  res.setHeader('Content-Type', tipo === 'pdf' ? 'application/pdf' : 'application/xml');
  res.setHeader('Content-Disposition', safeContentDisposition('inline', nombreArchivo));
  await pipeline(Readable.fromWeb(blobResult.stream), res);
}));

// ---------------------------------------------------------------------------
// Contabilidad Fase 3 (prompt-contabilidad-fase3-conciliacion.md) — cuentas
// bancarias corporativas + importación/conciliación de movimientos
// bancarios. Mismo whitelist que Fase 1/2 (auth.requireContabilidadAccess)
// en TODAS las rutas. Mismo patrón preview→confirm que Actualización de
// Presupuesto (server/app.js ~4337-4413): sube a Blob → preview parsea y
// muestra diff SIN persistir → confirm exige confirmado:true y aplica en
// transacción con ON CONFLICT DO NOTHING (dedup real, ver
// server/contabilidad.js). COMPLETAMENTE separado de cuentas_control/
// movimientos_control (control personal de Paul/Fer) — nunca tocar esas
// tablas desde aquí.
// ---------------------------------------------------------------------------
app.post('/api/contabilidad/movimientos/upload-token', h(auth.requireContabilidadAccess), h(async (req, res) => {
  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        if (!/\.(xlsx|csv)$/i.test(pathname)) {
          throw new Error('Solo se admiten archivos .xlsx o .csv');
        }
        return {
          allowedContentTypes: [
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'text/csv', 'application/csv', 'application/vnd.ms-excel',
          ],
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

app.get('/api/contabilidad/cuentas-bancarias', h(auth.requireContabilidadAccess), h(async (req, res) => {
  res.json(await contabilidad.listCuentasBancarias({ activo: req.query.activo }));
}));

app.post('/api/contabilidad/cuentas-bancarias', h(auth.requireContabilidadAccess), h(async (req, res) => {
  const { nombre, banco, numero_cuenta } = req.body || {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  const cuenta = await contabilidad.createCuentaBancaria({ nombre: nombre.trim(), banco, numero_cuenta });
  res.status(201).json(cuenta);
}));

app.put('/api/contabilidad/cuentas-bancarias/:id', h(auth.requireContabilidadAccess), h(async (req, res) => {
  const { nombre, banco, numero_cuenta, activo } = req.body || {};
  const cuenta = await contabilidad.updateCuentaBancaria(Number(req.params.id), { nombre, banco, numero_cuenta, activo });
  if (!cuenta) return res.status(404).json({ error: 'Cuenta bancaria no encontrada' });
  res.json(cuenta);
}));

app.post('/api/contabilidad/movimientos/preview', h(auth.requireContabilidadAccess), h(async (req, res) => {
  const { archivo_url, archivo_nombre, cuenta_bancaria_id } = req.body || {};
  if (!archivo_url) return res.status(400).json({ error: 'Sube un archivo .xlsx o .csv de movimientos bancarios' });
  if (!cuenta_bancaria_id) return res.status(400).json({ error: 'Indica la cuenta bancaria' });
  const tmpPath = path.join(os.tmpdir(), `movimientos-bancarios-${Date.now()}-${Math.round(Math.random() * 1e9)}${/\.csv$/i.test(archivo_nombre || '') ? '.csv' : '.xlsx'}`);
  try {
    await descargarBlobXlsxATmp(archivo_url, tmpPath);
    const { movimientos, filasInvalidas } = await parseMovimientosBancarios(tmpPath, archivo_nombre);
    if (!movimientos.length) {
      return res.status(400).json({ error: 'No se reconoció ningún movimiento válido en el archivo.' });
    }
    const { nuevos, yaExistentes } = await contabilidad.diffMovimientosImportacion(Number(cuenta_bancaria_id), movimientos);
    res.json({ nuevos, ya_existentes: yaExistentes, filas_invalidas: filasInvalidas });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  } finally {
    fs.rm(tmpPath, () => {});
  }
}));

app.post('/api/contabilidad/movimientos/confirmar', h(auth.requireContabilidadAccess), h(async (req, res) => {
  const { archivo_url, archivo_nombre, cuenta_bancaria_id, confirmado } = req.body || {};
  if (!archivo_url) return res.status(400).json({ error: 'Sube un archivo .xlsx o .csv de movimientos bancarios' });
  if (!cuenta_bancaria_id) return res.status(400).json({ error: 'Indica la cuenta bancaria' });
  if (confirmado !== true) return res.status(400).json({ error: 'Falta confirmar explícitamente la importación' });
  const tmpPath = path.join(os.tmpdir(), `movimientos-bancarios-${Date.now()}-${Math.round(Math.random() * 1e9)}${/\.csv$/i.test(archivo_nombre || '') ? '.csv' : '.xlsx'}`);
  try {
    await descargarBlobXlsxATmp(archivo_url, tmpPath);
    const { movimientos } = await parseMovimientosBancarios(tmpPath, archivo_nombre);
    if (!movimientos.length) {
      return res.status(400).json({ error: 'No se reconoció ningún movimiento válido en el archivo.' });
    }
    const resultado = await contabilidad.confirmarImportacionMovimientos(Number(cuenta_bancaria_id), movimientos, req.user.id);
    res.json(resultado);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  } finally {
    fs.rm(tmpPath, () => {});
  }
}));

app.get('/api/contabilidad/movimientos', h(auth.requireContabilidadAccess), h(async (req, res) => {
  const { cuenta_bancaria_id, estatus, desde, hasta } = req.query;
  res.json(await contabilidad.listMovimientos({
    cuenta_bancaria_id: cuenta_bancaria_id ? Number(cuenta_bancaria_id) : undefined, estatus, desde, hasta,
  }));
}));

app.put('/api/contabilidad/movimientos/:id/conciliar', h(auth.requireContabilidadAccess), h(async (req, res) => {
  const { poliza_id } = req.body || {};
  if (!poliza_id) return res.status(400).json({ error: 'Indica la póliza con la que conciliar' });
  const movimiento = await contabilidad.conciliarMovimiento(Number(req.params.id), Number(poliza_id), req.user.id);
  if (!movimiento) return res.status(404).json({ error: 'Movimiento no encontrado o ya conciliado' });
  res.json(movimiento);
}));

app.put('/api/contabilidad/movimientos/:id/desconciliar', h(auth.requireContabilidadAccess), h(async (req, res) => {
  const movimiento = await contabilidad.desconciliarMovimiento(Number(req.params.id));
  if (!movimiento) return res.status(404).json({ error: 'Movimiento no encontrado o no está conciliado' });
  res.json(movimiento);
}));

// ---------------------------------------------------------------------------
// Contabilidad Fase 4 (prompt-contabilidad-fase4-depreciacion.md) —
// depreciación de maquinaria (línea recta, on-the-fly). Mismo whitelist que
// Fase 1-3. equipos_maquinaria SOLO se lee aquí, nunca se modifica —
// catálogo operativo de jefe_maquinaria (checkPermiso('maquinaria', ...),
// sistema de permisos distinto). Póliza de depreciación SIEMPRE requiere
// confirmado:true explícito — nunca se genera sola (cron, on-load, etc.).
// ---------------------------------------------------------------------------
const MES_YYYY_MM_RE = /^\d{4}-\d{2}$/;

app.get('/api/contabilidad/depreciacion', h(auth.requireContabilidadAccess), h(async (req, res) => {
  const { mes } = req.query;
  if (mes && !MES_YYYY_MM_RE.test(mes)) return res.status(400).json({ error: 'Formato de mes inválido, usa YYYY-MM' });
  res.json(await contabilidad.listDepreciacion({ mes }));
}));

app.get('/api/contabilidad/depreciacion/equipos-disponibles', h(auth.requireContabilidadAccess), h(async (req, res) => {
  res.json(await contabilidad.listEquiposDisponiblesDepreciacion());
}));

app.post('/api/contabilidad/depreciacion', h(auth.requireContabilidadAccess), h(async (req, res) => {
  const { equipo_id, valor_adquisicion, fecha_adquisicion, vida_util_meses, valor_rescate } = req.body || {};
  if (!equipo_id) return res.status(400).json({ error: 'Indica el equipo' });
  if (!(Number(valor_adquisicion) > 0)) return res.status(400).json({ error: 'Indica un valor de adquisición válido' });
  if (!fecha_adquisicion) return res.status(400).json({ error: 'Indica la fecha de adquisición' });
  if (!(Number(vida_util_meses) > 0)) return res.status(400).json({ error: 'Indica una vida útil en meses válida' });
  try {
    const dep = await contabilidad.createDepreciacion({
      equipo_id: Number(equipo_id), valor_adquisicion: Number(valor_adquisicion), fecha_adquisicion,
      vida_util_meses: Number(vida_util_meses), valor_rescate: valor_rescate != null && valor_rescate !== '' ? Number(valor_rescate) : 0,
      creado_por: req.user.id,
    });
    res.status(201).json(dep);
  } catch (err) {
    if (err.code === '23505') { // unique_violation (equipo_id)
      return res.status(409).json({ error: 'Este equipo ya tiene parámetros de depreciación configurados' });
    }
    throw err;
  }
}));

app.put('/api/contabilidad/depreciacion/:id', h(auth.requireContabilidadAccess), h(async (req, res) => {
  const { valor_adquisicion, fecha_adquisicion, vida_util_meses, valor_rescate, fecha_baja } = req.body || {};
  const dep = await contabilidad.updateDepreciacion(Number(req.params.id), {
    valor_adquisicion: valor_adquisicion != null && valor_adquisicion !== '' ? Number(valor_adquisicion) : null,
    fecha_adquisicion: fecha_adquisicion || null,
    vida_util_meses: vida_util_meses != null && vida_util_meses !== '' ? Number(vida_util_meses) : null,
    valor_rescate: valor_rescate != null && valor_rescate !== '' ? Number(valor_rescate) : null,
    fecha_baja: fecha_baja || null,
  });
  if (!dep) return res.status(404).json({ error: 'Registro de depreciación no encontrado' });
  res.json(dep);
}));

app.post('/api/contabilidad/depreciacion/:id/generar-poliza', h(auth.requireContabilidadAccess), h(async (req, res) => {
  const { mes, confirmado } = req.body || {};
  if (!mes || !MES_YYYY_MM_RE.test(mes)) return res.status(400).json({ error: 'Indica el mes en formato YYYY-MM' });
  if (confirmado !== true) return res.status(400).json({ error: 'Falta confirmar explícitamente la generación de la póliza' });
  const poliza = await contabilidad.generarPolizaDepreciacion(Number(req.params.id), mes, req.user.id);
  res.status(201).json(poliza);
}));

// ---------------------------------------------------------------------------
// Contabilidad Fase 5 (prompt-contabilidad-fase5-exportacion.md) — export
// mensual consolidado a Excel (4 hojas: Pólizas, CFDI, Movimientos Bancarios
// Conciliados, Depreciación). Mismo whitelist que Fase 1-4, mismo patrón de
// rate limiting que el resto de exports del proyecto (EXPORT_RATE_LIMIT,
// server ~3837). Nunca persiste/cachea — se genera al vuelo en cada request.
// Si las 4 fuentes están vacías para el mes/obra pedidos, 400 con mensaje
// claro en vez de generar un .xlsx con 4 hojas sin una sola fila (diagnóstico
// Fase 5, checkpoint "mensaje claro antes de generar").
// ---------------------------------------------------------------------------
app.get('/api/contabilidad/export', h(auth.requireContabilidadAccess), h(async (req, res) => {
  const { mes, project_id } = req.query;
  if (!mes || !MES_YYYY_MM_RE.test(mes)) return res.status(400).json({ error: 'Indica el mes en formato YYYY-MM' });
  const projectId = project_id ? Number(project_id) : null;

  const { rows: rlRows } = await db.pool.query(
    `SELECT COUNT(*)::int AS n FROM api_rate_limits
     WHERE usuario_id = $1 AND endpoint = 'export_contabilidad'
       AND creado_en > NOW() - INTERVAL '1 hour'`,
    [req.user.id]
  );
  if (rlRows[0].n >= EXPORT_RATE_LIMIT) {
    return res.status(429).json({ error: `Límite de exports alcanzado (${EXPORT_RATE_LIMIT} por hora). Intenta más tarde.` });
  }

  const { polizas, cfdi, movimientos, depreciacion } = await contabilidad.getDatosExportacionMes({ mes, projectId });
  if (!polizas.length && !cfdi.length && !movimientos.length && !depreciacion.length) {
    return res.status(400).json({ error: `No hay datos de Contabilidad (pólizas, CFDI, movimientos conciliados ni depreciación) para ${mes}${projectId ? ' en esta obra' : ''}.` });
  }

  await db.pool.query('INSERT INTO api_rate_limits (usuario_id, endpoint) VALUES ($1, $2)', [req.user.id, 'export_contabilidad']);

  let projectNombre = null;
  if (projectId) {
    const { rows } = await db.pool.query('SELECT nombre FROM proyectos WHERE id = $1', [projectId]);
    projectNombre = rows[0]?.nombre || null;
  }

  await sendXlsxExport(res, {
    filename: buildExportFilename(`Contabilidad_${mes}`, projectNombre),
    sheets: [
      {
        sheetName: 'Pólizas',
        columns: [
          { header: 'Fecha', key: 'fecha', width: 14 },
          { header: 'Tipo', key: 'tipo', width: 12 },
          { header: 'Código Cuenta', key: 'cuenta_codigo', width: 14 },
          { header: 'Cuenta', key: 'cuenta_nombre', width: 26 },
          { header: 'Concepto', key: 'concepto', width: 34 },
          { header: 'Obra', key: 'project_nombre', width: 24 },
          { header: 'Monto', key: 'monto', width: 16, format: 'money' },
          { header: 'Referencia', key: 'referencia_factura', width: 20 },
          { header: 'Estatus', key: 'estatus', width: 12 },
        ],
        rows: polizas.map((p) => ({ ...p, project_nombre: p.project_nombre || 'Corporativo', referencia_factura: p.referencia_factura || '' })),
      },
      {
        sheetName: 'CFDI',
        columns: [
          { header: 'UUID', key: 'uuid', width: 38 },
          { header: 'RFC Emisor', key: 'rfc_emisor', width: 16 },
          { header: 'RFC Receptor', key: 'rfc_receptor', width: 16 },
          { header: 'Fecha', key: 'fecha_emision', width: 14 },
          { header: 'Subtotal', key: 'subtotal', width: 16, format: 'money' },
          { header: 'IVA', key: 'iva', width: 14, format: 'money' },
          { header: 'Total', key: 'total', width: 16, format: 'money' },
          { header: 'Tipo Comprobante', key: 'tipo_comprobante', width: 16 },
          { header: 'Obra', key: 'project_nombre', width: 24 },
          { header: 'Estatus SAT', key: 'estatus_sat', width: 14 },
        ],
        rows: cfdi.map((c) => ({ ...c, project_nombre: c.project_nombre || 'Corporativo', tipo_comprobante: c.tipo_comprobante || '' })),
      },
      {
        sheetName: 'Mov. Bancarios Conciliados',
        columns: [
          { header: 'Cuenta Bancaria', key: 'cuenta_nombre', width: 22 },
          { header: 'Fecha', key: 'fecha', width: 14 },
          { header: 'Descripción', key: 'descripcion', width: 34 },
          { header: 'Tipo', key: 'tipo', width: 10 },
          { header: 'Monto', key: 'monto', width: 16, format: 'money' },
          { header: 'Póliza conciliada', key: 'poliza_concepto', width: 30 },
          { header: 'Fecha conciliación', key: 'conciliado_en', width: 16 },
        ],
        rows: movimientos,
      },
      {
        sheetName: 'Depreciación',
        columns: [
          { header: 'Equipo', key: 'equipo_nombre', width: 26 },
          { header: 'Identificador', key: 'equipo_identificador', width: 16 },
          { header: 'Valor Adquisición', key: 'valor_adquisicion', width: 18, format: 'money' },
          { header: 'Depreciación Mensual', key: 'depreciacion_mensual', width: 18, format: 'money' },
          { header: 'Depreciación Acumulada', key: 'depreciacion_acumulada', width: 20, format: 'money' },
          { header: 'Valor en Libros', key: 'valor_en_libros', width: 16, format: 'money' },
          { header: 'Fecha de Baja', key: 'fecha_baja', width: 14 },
        ],
        rows: depreciacion.map((d) => ({ ...d, fecha_baja: d.fecha_baja || '' })),
      },
    ],
  });
}));

// ---------------------------------------------------------------------------
// Bienvenida — resumen ligero por proyecto para la pantalla de bienvenida
// ---------------------------------------------------------------------------
app.get('/api/bienvenida', h(auth.allow('residente', 'cabo', 'compras', 'tesoreria', 'administracion', 'logistica', 'jefe_maquinaria', 'operador', 'costos')), h(async (req, res) => {
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
      // Widget "Mayor Avance" de Inicio: el monto se oculta para todos los
      // roles salvo admin/desarrollador (reemplaza la lista puntual
      // ['residente', 'cabo'] de PR #40 — Paul confirmó con captura que
      // otros roles como compras/tesorería seguían viendo el monto).
      presupuesto_total: !['admin', 'desarrollador'].includes(req.user.puesto)
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
// Panel "Actividad reciente" de la galería (Prompt B, prompts-animaciones-y-
// galeria-clientes.md) — reutiliza ultima_visita (ya se escribe en cada
// selectProject, sin tracking nuevo), solo agrega esta lectura agregada
// cruzando todos los clientes del usuario. Registrada ANTES de
// /ultima-visita/:clienteId para que Express no confunda "recientes" con un
// clienteId (mismo patrón ya usado para /estimaciones/defaults-periodo).
app.get('/api/ultima-visita/recientes', h(async (req, res) => {
  // avance_ejecutado_pct (prompt-dashboard-favoritos-layout.md, barra de
  // progreso por presupuesto) — mismo subquery ya usado en /bienvenida y
  // /resumen-global (última avance_financiero_real registrada), no un
  // cálculo nuevo.
  const { rows } = await db.pool.query(`
    SELECT uv.proyecto_id, uv.cliente_id, uv.actualizado_en,
           p.nombre AS proyecto_nombre, c.nombre AS cliente_nombre,
           COALESCE(
             (SELECT avance_financiero_real FROM avances_semanales
              WHERE project_id = p.id AND avance_financiero_real IS NOT NULL
              ORDER BY semana DESC LIMIT 1),
             0
           ) AS avance_ejecutado_pct
    FROM ultima_visita uv
    JOIN proyectos p ON p.id = uv.proyecto_id
    JOIN clientes c ON c.id = uv.cliente_id
    WHERE uv.usuario_id = $1
    ORDER BY uv.actualizado_en DESC
    LIMIT 5
  `, [req.user.id]);
  res.json(rows);
}));

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
// Favoritos de la galería de clientes (Prompt B, prompts-animaciones-y-
// galeria-clientes.md) — por usuario, no localStorage (viaja entre equipos
// del mismo usuario, mismo criterio que ultima_visita arriba).
// ---------------------------------------------------------------------------
// Orden por drag (prompt-dashboard-favoritos-layout.md) — devuelto ya
// ordenado por "orden" ASC; el front pinta la franja en este mismo orden
// (no en el orden de state.clientes, que es el propio de la cuadrícula).
app.get('/api/favoritos', h(async (req, res) => {
  const { rows } = await db.pool.query(
    'SELECT cliente_id FROM usuario_favoritos WHERE usuario_id = $1 ORDER BY orden ASC',
    [req.user.id]
  );
  res.json(rows.map((r) => r.cliente_id));
}));

app.post('/api/favoritos/:clienteId', h(async (req, res) => {
  const clienteId = parseInt(req.params.clienteId, 10);
  if (!clienteId) return res.status(400).json({ error: 'Cliente inválido' });
  // Nuevo favorito entra al final (MAX(orden)+1 de este usuario) — mismo
  // criterio "se agrega al final" que ya usa el arrastre en clientes.
  await db.pool.query(`
    INSERT INTO usuario_favoritos (usuario_id, cliente_id, orden)
    VALUES ($1, $2, (SELECT COALESCE(MAX(orden), -1) + 1 FROM usuario_favoritos WHERE usuario_id = $1))
    ON CONFLICT (usuario_id, cliente_id) DO NOTHING
  `, [req.user.id, clienteId]);
  res.json({ ok: true });
}));

app.delete('/api/favoritos/:clienteId', h(async (req, res) => {
  const clienteId = parseInt(req.params.clienteId, 10);
  if (!clienteId) return res.status(400).json({ error: 'Cliente inválido' });
  await db.pool.query(
    'DELETE FROM usuario_favoritos WHERE usuario_id = $1 AND cliente_id = $2',
    [req.user.id, clienteId]
  );
  res.json({ ok: true });
}));

// Reorder por drag (SortableJS) — mismo patrón que PUT /clientes/orden
// (delete+reinsert con posición), pero en UPDATE porque las filas de
// favoritos ya existen (solo cambia su orden, no su membresía).
app.put('/api/favoritos/orden', h(async (req, res) => {
  const { orden } = req.body || {};
  if (!Array.isArray(orden) || !orden.length) {
    return res.status(400).json({ error: 'Se requiere un arreglo "orden" con los IDs de cliente' });
  }
  await db.withTransaction(async (client) => {
    for (let i = 0; i < orden.length; i++) {
      await client.query(
        'UPDATE usuario_favoritos SET orden = $1 WHERE usuario_id = $2 AND cliente_id = $3',
        [i, req.user.id, Number(orden[i])]
      );
    }
  });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Proyectos
// ---------------------------------------------------------------------------
app.get('/api/projects', h(auth.allow('residente', 'cabo', 'compras', 'tesoreria', 'administracion', 'logistica', 'jefe_maquinaria', 'operador', 'costos')), h(async (req, res) => {
  // prompt-URGENTE-fix-acceso-todos-presupuestos.md: mismo criterio que
  // GET /api/clientes (ver comentario ahí) -- 'admin' ve todo siempre;
  // 'desarrollador' ve todo SOLO si no tiene ninguna fila en
  // usuario_proyectos (preserva el fix de PR #170 para su propio
  // cliente/obra recién creado), pero se restringe igual que cualquier
  // otro rol en cuanto un admin le asigna obras explícitas -- antes de
  // este fix esa asignación no tenía ningún efecto para 'desarrollador'.
  const veTodo = req.user.puesto === 'admin'
    || (req.user.puesto === 'desarrollador' && !(await db.usuarioTieneAsignacionExplicita(req.user.id)));
  const projects = veTodo
    ? await db.listProjects()
    : (await db.pool.query(`
        SELECT p.* FROM proyectos p
        JOIN usuario_proyectos up ON up.project_id = p.id
        WHERE up.usuario_id = $1
        ORDER BY p.id DESC
      `, [req.user.id])).rows;
  // prompt-p2-aislamiento-operador.md (operador) + prompt-p9-restringir-
  // importes-projects.md (todos los demás roles no-admin): solo admin y
  // desarrollador reciben importes y fechas de obra en este payload (el
  // drawer "Presupuestos cargados" ya es null-safe para estas 4 claves —
  // mismo código que corre hoy para operador, sin cambios de frontend).
  // Recorte en la construcción de la respuesta, no en el render: para
  // roles no-admin ni siquiera se corre la query de totalRows.
  const puedeVerImportes = req.user.puesto === 'admin' || req.user.puesto === 'desarrollador';
  const rows = await Promise.all(projects.map(async (p) => {
    const { rows: metaRows } = await db.pool.query(
      'SELECT clave, valor FROM meta WHERE project_id = $1', [p.id]
    );
    const meta = metaToObject(metaRows);
    const totalRows = puedeVerImportes ? (await db.pool.query(
      "SELECT importe FROM conceptos WHERE project_id = $1 AND es_total = 1 AND grupo IS NULL ORDER BY orden DESC LIMIT 1",
      [p.id]
    )).rows : [];
    return {
      id: p.id,
      nombre: p.nombre,
      cliente_id: p.cliente_id,
      archivo_original: p.archivo_original,
      creado_en: p.creado_en,
      obra: meta.obra || null,
      lugar: meta.lugar || null,
      ...(puedeVerImportes ? {
        inicio_obra: meta.inicio_obra || null,
        fin_obra: meta.fin_obra || null,
        total_sin_iva: meta.total_sin_iva ? Number(meta.total_sin_iva) : (totalRows[0] ? totalRows[0].importe : null),
        total_con_iva: meta.total_con_iva ? Number(meta.total_con_iva) : null,
      } : {}),
    };
  }));
  res.json(rows);
}));

// Emite el token de subida directa a Vercel Blob: el navegador sube el
// .xlsx sin pasar por esta función serverless (que tiene un límite de body
// no configurable en Vercel), y solo nos manda la URL resultante a
// POST /api/projects. Ver Prompts_mod1.md Tarea 1 (Error 413).
// prompt-costos-mapeo-y-mover-tiles.md: 'costos' agregado — el flujo de
// "Actualizar presupuesto" (Mapeo) reusa este mismo endpoint genérico de
// token de subida a Blob. Seguro: solo emite el token de subida, no crea
// nada por sí solo — POST /api/projects (creación de proyecto nuevo, más
// abajo) sigue siendo admin/desarrollador-only sin cambios, y confirmar la
// actualización sigue gateado aparte por checkPermiso('presupuestos', ...).
app.post('/api/projects/upload-token', h(auth.allow('costos')), h(async (req, res) => {
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

// prompt-diagnostico-y-fix-jszip-actualizar-presupuesto.md: descarga
// compartida por las 3 rutas que bajan un .xlsx de Vercel Blob para
// parsearlo con exceljs (carga inicial + preview/confirmar de "Actualizar
// presupuesto"). Diagnóstico: get()+pipeline() reprodujeron íntegros
// (hash idéntico) en pruebas directas contra Vercel Blob real, y también
// end-to-end vía el upload real del navegador — no se logró reproducir el
// "Can't find end of central directory" reportado. Como no se pudo aislar
// una causa determinística, esta validación convierte cualquier descarga
// truncada (red intermitente, propagación de Vercel Blob) en un error
// claro y accionable ANTES de llegar a exceljs/jszip, en vez del mensaje
// críptico de jszip — comparando el tamaño descargado contra el
// Content-Length real que reportó el blob, con un reintento automático por
// si fue un corte transitorio.
async function descargarBlobXlsxATmp(archivo_url, tmpPath) {
  for (let intento = 1; intento <= 2; intento++) {
    const blobResult = await get(archivo_url, { access: 'private' });
    if (!blobResult) throw new Error('No se pudo descargar el archivo subido');
    await pipeline(Readable.fromWeb(blobResult.stream), fs.createWriteStream(tmpPath));
    const tamanoEsperado = blobResult.blob?.size;
    const tamanoReal = (await fs.promises.stat(tmpPath)).size;
    if (tamanoEsperado && tamanoReal !== tamanoEsperado) {
      if (intento < 2) continue;
      throw new Error(`El archivo se descargó incompleto (esperados ${tamanoEsperado} bytes, se recibieron ${tamanoReal}). Vuelve a subirlo — puede ser un problema de conexión momentáneo.`);
    }
    return;
  }
}

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
    await descargarBlobXlsxATmp(archivo_url, tmpPath);
    const parsed = await parseWorkbook(tmpPath);
    if (!parsed.conceptos.length && !parsed.insumos.length) {
      throw new Error('No se reconoció una hoja de presupuesto ni de listado de insumos en el archivo. Verifica que tenga el formato esperado (columnas Código, Concepto, Unidad, Cantidad, Precio, Importe).');
    }
    const nombre = parsed.meta.obra || (archivo_nombre || '').replace(/\.xlsx$/i, '') || 'Presupuesto';
    // prompt-matrices-auto-import-alta-obra.md: el proyecto se crea DENTRO de
    // la misma transacción que ingest() (antes se creaba afuera con
    // db.createProjectRecord, vía el pool) -- mismo patrón ya usado en
    // POST /costos/crear-presupuesto/import-completo/confirm (PR #176).
    // Necesario porque ingest() ahora puede lanzar por un bloque de Matrices
    // irresoluble (ej. cuadrilla pre-agregada sin desglosar); sin este
    // cambio, esa falla dejaba conceptos/insumos/destajo bien revertidos por
    // el rollback interno pero una fila en `proyectos` huérfana y vacía
    // sobreviviendo igual, visible en la galería del cliente sin nada dentro
    // (confirmado con EST Kaila Red Hidraulica 06082026.xlsx antes de este fix).
    let record;
    await db.withTransaction(async (client) => {
      const { rows: projRows } = await client.query(
        'INSERT INTO proyectos (nombre, archivo_original, cliente_id) VALUES ($1, $2, $3) RETURNING *',
        [nombre, archivo_nombre || null, clienteId]
      );
      record = projRows[0];
      await ingest(client, record.id, parsed, req.user.id);
    });
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

// Extensión rápida de fin_obra (ej. "cambio de SIROC" que amplía el contrato)
// — a propósito NO reutiliza /fechas-obra: ese endpoint regenera todo el
// Programa/Avance y se rechaza si ya hay avance real capturado, justo el
// caso típico de una obra que necesita extender su fecha a medio proyecto.
// Este endpoint solo actualiza el valor de fin_obra + auditoría de quién/
// cuándo, sin tocar programa_ejecucion ni avances_semanales.
app.put('/api/projects/:id/fin-obra', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { fin_obra } = req.body || {};
  if (!fin_obra) return res.status(400).json({ error: 'Debes indicar la nueva fecha de fin de obra' });

  const pid = req.project.id;
  const { rows: metaRows } = await db.pool.query(
    `SELECT valor FROM meta WHERE project_id = $1 AND clave = 'inicio_obra'`, [pid]
  );
  const inicioObra = metaRows[0]?.valor;
  if (inicioObra && fin_obra <= inicioObra) {
    return res.status(400).json({ error: 'La fecha de fin de obra debe ser posterior a la de inicio' });
  }

  const upsertMeta = `
    INSERT INTO meta (project_id, clave, valor) VALUES ($1, $2, $3)
    ON CONFLICT (project_id, clave) DO UPDATE SET valor = EXCLUDED.valor
  `;
  const ahora = new Date().toISOString();
  await db.withTransaction(async (client) => {
    await client.query(upsertMeta, [pid, 'fin_obra', fin_obra]);
    await client.query(upsertMeta, [pid, 'fin_obra_actualizado_por', req.user.nombre]);
    await client.query(upsertMeta, [pid, 'fin_obra_actualizado_en', ahora]);
  });

  res.json({ ok: true, fin_obra, actualizado_por: req.user.nombre, actualizado_en: ahora });
}));

// ---------------------------------------------------------------------------
// Contrato PDF — extracción vía Claude API (admin-only). Flujo separado de la
// carga por Excel: no toca parseWorkbook/ingest ni el catálogo de conceptos/
// insumos, solo crea/actualiza la obra y sus datos de contrato en `meta`.
// contrato-preview no guarda nada; contrato-confirm es quien escribe.
// ---------------------------------------------------------------------------
const CONTRATO_PREVIEW_LIMIT = 10; // máx extracciones por usuario por hora
const EXPORT_RATE_LIMIT = 20; // máx exports Excel por usuario por hora

// checkPermiso('contrato', accion) — nombre de sección singular 'contrato',
// no 'contratos' (así está registrado en SECCIONES_PERMISOS). Va justo
// después de auth.allow() y ANTES del rate limiting, para que una petición
// sin permiso no consuma cupo de CONTRATO_PREVIEW_LIMIT. El rate limiting
// en sí no se toca, sigue aplicando igual para quien sí pasa el gate.
// Nota: auth.allow() aquí ya es vacío (solo admin/desarrollador) en las 3
// rutas de Contrato, igual que pasó con Mapeo — este checkPermiso queda
// como infraestructura preparada, sin efecto práctico hoy para otros roles,
// aunque el tab 'contrato' sí es visible en frontend para tesorería/
// administración (gap preexistente entre nav y auth.allow(), no introducido
// aquí, fuera de scope de este cambio).
app.post('/api/projects/contrato-preview',
  h(auth.allow()),
  h(auth.checkPermiso('contrato', 'puede_crear')),
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
    const tmpPath = req.file.path;
    if (!await checkFileMagic(tmpPath, ['pdf'])) {
      await fs.promises.unlink(tmpPath).catch(() => {});
      return res.status(400).json({ error: 'El archivo no es un PDF válido (firma de contenido incorrecta)' });
    }
    // Registrar la llamada antes de invocar Anthropic (cuenta aunque la extracción falle).
    await db.pool.query(
      'INSERT INTO api_rate_limits (usuario_id, endpoint) VALUES ($1, $2)',
      [req.user.id, 'contrato_preview']
    );
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

// Nota: este endpoint puede CREAR una obra nueva (cuando body.project_id
// está ausente, solo viene cliente_id) además de persistir el contrato de
// una obra existente — dos alcances distintos en un mismo handler. Se trata
// como 'puede_crear' de 'contrato' en ambos casos: ya es admin/desarrollador
// -only vía auth.allow() vacío (sin cambio de comportamiento real hoy), y
// checkPermiso cae de vuelta a la fila global (proyecto_id IS NULL) cuando
// no hay req.project todavía — mismo mecanismo ya usado en Mapeo.
app.post('/api/projects/contrato-confirm', h(auth.allow()), h(auth.checkPermiso('contrato', 'puede_crear')), h(async (req, res) => {
  const body = req.body || {};
  // prompt-fondo-garantia-editable.md: validación explícita de rango (no
  // silenciosa) para el % editable — a diferencia del fallback silencioso a
  // 2% que hace porcentajeFondoGarantiaDe() cuando el dato guardado está
  // corrupto/ausente, aquí SÍ se rechaza una captura evidentemente errónea
  // en el momento de guardar.
  if (body.porcentaje_fondo_garantia !== undefined && body.porcentaje_fondo_garantia !== null && body.porcentaje_fondo_garantia !== '') {
    const pct = Number(body.porcentaje_fondo_garantia);
    if (!Number.isFinite(pct) || pct < FONDO_GARANTIA_PCT_MIN || pct > FONDO_GARANTIA_PCT_MAX) {
      return res.status(400).json({ error: `El % de fondo de garantía debe ser un número entre ${FONDO_GARANTIA_PCT_MIN} y ${FONDO_GARANTIA_PCT_MAX}` });
    }
  }
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
      // porcentaje_fondo_garantia: excluido del upsert genérico de abajo —
      // usa upsertPorcentajeFondoGarantia (prompt-fondo-garantia-editable-
      // panel.md), la misma función reusada por PUT .../fondo-garantia, para
      // no duplicar la lógica de validación+upsert en dos lugares. La
      // validación de rango ya corrió arriba antes de crear/tocar el
      // proyecto; esta segunda pasada por la misma validación dentro de la
      // función es redundante pero inofensiva (mismo resultado).
      if (campo === 'porcentaje_fondo_garantia') {
        await upsertPorcentajeFondoGarantia(client, projectId, valor);
        continue;
      }
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
// checkPermiso('contrato', 'puede_ver') va DESPUÉS de verificarAccesoObra
// (fix de IDOR preexistente: ownership de la obra antes de servir el
// archivo) — capa adicional, no lo reemplaza ni lo reordena.
app.get('/api/projects/:id/contrato/pdf', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('contrato', 'puede_ver')), h(async (req, res) => {
  const { rows } = await db.pool.query('SELECT blob_url, nombre_archivo FROM contratos WHERE project_id = $1', [req.project.id]);
  if (!rows[0]) return res.status(404).json({ error: 'No hay PDF de contrato para esta obra' });
  const blobResult = await get(rows[0].blob_url, { access: 'private' });
  if (!blobResult) return res.status(404).json({ error: 'Archivo no encontrado en almacenamiento' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', safeContentDisposition('inline', rows[0].nombre_archivo));
  await pipeline(Readable.fromWeb(blobResult.stream), res);
}));

// ---------------------------------------------------------------------------
// Impuestos (IMSS/SAT/INFONAVIT) por obra y periodo — aplica a TODAS las
// obras por igual (no depende de que tengan Contrato PDF cargado). Los
// periodos 'pendiente' los crea el cron mensual (ver
// POST /api/cron/recordatorio-impuestos, registrado antes del middleware de
// sesión); aquí solo se consultan y se marcan como 'cargado'.
// ---------------------------------------------------------------------------
app.get('/api/projects/:id/impuestos', h(auth.allow('tesoreria', 'administracion')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('impuestos', 'puede_ver')), h(async (req, res) => {
  const { rows } = await db.pool.query(
    'SELECT * FROM pagos_impuestos_obra WHERE project_id = $1 ORDER BY periodo_anio DESC, periodo_mes DESC',
    [req.project.id]
  );
  res.json(rows);
}));

app.get('/api/projects/:id/impuestos/resumen', h(auth.allow('tesoreria', 'administracion')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('impuestos', 'puede_ver')), h(async (req, res) => {
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

app.post('/api/projects/:id/impuestos/:periodoId/cargar', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('impuestos', 'puede_editar')), h(async (req, res) => {
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
// prompt-costos-mapeo-y-mover-tiles.md: 'costos' agregado — GET /conceptos es
// la primera llamada que hace renderMapeo() (public/app.js) para poblar el
// selector de conceptos a mapear; sin este rol en la lista, la vista de
// Mapeo fallaría con 403 antes de llegar siquiera a los endpoints de
// insumos, pese a tener ya el permiso granular 'presupuestos' correcto.
app.get('/api/projects/:id/conceptos', h(auth.allow('residente', 'cabo', 'compras', 'tesoreria', 'administracion', 'logistica', 'costos')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('presupuestos', 'puede_ver')), h(async (req, res) => {
  const { rows } = await db.pool.query('SELECT * FROM conceptos WHERE project_id = $1 AND activo = 1 ORDER BY orden', [req.project.id]);
  res.json(rows);
}));

// ---------------------------------------------------------------------------
// Actualización de presupuesto preservando avance (DISEÑO-ACTUALIZACION-
// PRESUPUESTO.md, aprobado por Paul 2026-07-21). Dos pasos: preview (nunca
// escribe) y confirmar (aplica dentro de una transacción). auth.allow() sin
// argumentos = solo admin/desarrollador, mismo criterio que POST
// /api/projects (creación inicial) — reintegrar un presupuesto existente es
// al menos igual de sensible. checkPermiso('presupuestos', accion) se
// agrega encima como capa adicional, mismo patrón que el resto del rollout:
// 'puede_ver' para el preview (es de solo lectura), 'puede_editar' para
// confirmar (es una reconciliación de datos existentes, no un alta nueva
// tipo 'puede_crear').
// ---------------------------------------------------------------------------
app.post('/api/projects/:id/presupuesto/actualizar/preview', h(auth.allow('costos')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('presupuestos', 'puede_ver')), h(async (req, res) => {
  const { archivo_url } = req.body || {};
  if (!archivo_url) return res.status(400).json({ error: 'Sube un archivo .xlsx de presupuesto' });
  const pid = req.project.id;
  const tmpPath = path.join(os.tmpdir(), `presupuesto-actualizar-${Date.now()}-${Math.round(Math.random() * 1e9)}.xlsx`);
  try {
    await descargarBlobXlsxATmp(archivo_url, tmpPath);
    const parsed = await parseWorkbook(tmpPath);
    if (!parsed.conceptos.length) {
      throw new Error('No se reconoció una hoja de presupuesto en el archivo. Verifica que tenga el formato esperado (columnas Código, Concepto, Unidad, Cantidad, Precio, Importe).');
    }

    const { rows: existentes } = await db.pool.query(
      'SELECT id, codigo, concepto, unidad, cantidad, precio_unitario, importe, grupo, es_total, orden, activo FROM conceptos WHERE project_id = $1 AND es_total = 0',
      [pid]
    );

    const { emparejados, nuevos, historicos, conflictos } = emparejarConceptos(parsed.conceptos, existentes);
    const totalNuevo = parsed.conceptos.filter((c) => !c.es_total).reduce((s, c) => s + (Number(c.importe) || 0), 0);
    const totalActual = await presupuestoTotalDe(pid);

    res.json({
      nuevos: nuevos.map((c) => ({ codigo: c.codigo || null, concepto: c.concepto, unidad: c.unidad, cantidad: c.cantidad, precio_unitario: c.precio_unitario })),
      emparejados: emparejados.map((m) => {
        const { cambiaPrecio, cambiaCantidad, ambiguo } = calcularCambios(m);
        return {
          concepto_id: m.existente.id,
          codigo: m.nuevo.codigo || m.existente.codigo,
          concepto: m.nuevo.concepto,
          via: m.via,
          precio_anterior: m.existente.precio_unitario,
          precio_nuevo: m.nuevo.precio_unitario,
          cambia_precio: cambiaPrecio,
          cantidad_anterior: m.existente.cantidad,
          cantidad_nueva: m.nuevo.cantidad,
          cambia_cantidad: cambiaCantidad,
          ambiguo_precio_cantidad: ambiguo,
          regresa: Number(m.existente.activo) === 0,
        };
      }),
      historicos: historicos.map((e) => ({ concepto_id: e.id, codigo: e.codigo, concepto: e.concepto })),
      conflictos,
      total_nuevo: Number(totalNuevo.toFixed(2)),
      total_actual: Number(totalActual),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  } finally {
    fs.rm(tmpPath, () => {});
  }
}));

app.post('/api/projects/:id/presupuesto/actualizar/confirmar', h(auth.allow('costos')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('presupuestos', 'puede_editar')), h(async (req, res) => {
  const { archivo_url, confirmado, resoluciones_precio_cantidad } = req.body || {};
  if (!archivo_url) return res.status(400).json({ error: 'Sube un archivo .xlsx de presupuesto' });
  if (confirmado !== true) return res.status(400).json({ error: 'Falta confirmar explícitamente la actualización' });
  const pid = req.project.id;
  const tmpPath = path.join(os.tmpdir(), `presupuesto-actualizar-${Date.now()}-${Math.round(Math.random() * 1e9)}.xlsx`);
  try {
    await descargarBlobXlsxATmp(archivo_url, tmpPath);
    const parsed = await parseWorkbook(tmpPath);
    if (!parsed.conceptos.length) {
      throw new Error('No se reconoció una hoja de presupuesto en el archivo.');
    }

    const { rows: existentes } = await db.pool.query(
      'SELECT id, codigo, concepto, unidad, cantidad, precio_unitario, importe, grupo, es_total, orden, activo FROM conceptos WHERE project_id = $1 AND es_total = 0',
      [pid]
    );

    // Repite exactamente el mismo emparejamiento del preview (función
    // compartida) — nunca se reenvía el resultado del preview desde el
    // frontend, para evitar divergencia si algo cambió entre los dos pasos.
    const { emparejados, nuevos, historicos, conflictos } = emparejarConceptos(parsed.conceptos, existentes);

    if (conflictos.length > 0) {
      return res.status(409).json({
        error: 'Hay conceptos ambiguos que no se pueden emparejar automáticamente — corrige el Excel (ej. agregando código) y vuelve a intentar.',
        conflictos,
      });
    }

    // Cambios de precio/cantidad ambiguos (ambos cambian a la vez, o el
    // match viene de un código duplicado legítimo) requieren que Paul elija
    // explícitamente cómo aplicarlos antes de tocar la DB — nunca se adivina.
    const resoluciones = resoluciones_precio_cantidad || {};
    const pendientes = [];
    for (const m of emparejados) {
      const { ambiguo } = calcularCambios(m);
      if (ambiguo && !['precio', 'cantidad', 'ambos'].includes(resoluciones[m.existente.id])) {
        pendientes.push({ concepto_id: m.existente.id, codigo: m.existente.codigo, concepto: m.existente.concepto });
      }
    }
    if (pendientes.length > 0) {
      return res.status(400).json({
        error: 'Hay conceptos con cambio de precio y cantidad ambiguo — elige cómo aplicar cada uno antes de confirmar.',
        requiere_resolucion_precio_cantidad: pendientes,
      });
    }

    const totalAntes = await presupuestoTotalDe(pid);

    let totalFinal = 0;
    let aplicados = [];

    // Motor de aplicación compartido con Órdenes de Cambio (prompt-ordenes-
    // cambio.md) — ver reintegracionPresupuesto.aplicarCambiosConceptos.
    // Comportamiento sin cambios: mismo SQL, mismo orden de operaciones que
    // antes vivía inline aquí.
    await db.withTransaction(async (client) => {
      ({ totalFinal, aplicados } = await aplicarCambiosConceptos(client, pid, { emparejados, nuevos, historicos, resoluciones }));

      const detalle = JSON.stringify({
        nuevos: nuevos.length,
        emparejados: emparejados.length,
        historicos: historicos.length,
        cambios_precio: aplicados
          .filter((a) => Number(a.precio_anterior) !== Number(a.precio_nuevo))
          .map((a) => ({ concepto_id: a.concepto_id, codigo: a.codigo, precio_anterior: a.precio_anterior, precio_nuevo: a.precio_nuevo })),
        cambios_cantidad: aplicados
          .filter((a) => Number(a.cantidad_anterior) !== Number(a.cantidad_nueva))
          .map((a) => ({ concepto_id: a.concepto_id, codigo: a.codigo, cantidad_anterior: a.cantidad_anterior, cantidad_nueva: a.cantidad_nueva })),
        total_antes: totalAntes,
        total_despues: totalFinal,
      });

      await client.query(
        `INSERT INTO audit_log (actor_id, actor_usuario, accion, target_id, project_id, ip, detalle)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [req.user.id, req.user.usuario, 'actualizacion_presupuesto', pid, pid, auth.getIp(req), detalle]
      );
    });

    res.json({ ok: true, nuevos: nuevos.length, emparejados: emparejados.length, historicos: historicos.length, total_anterior: totalAntes, total_nuevo: totalFinal });
  } catch (err) {
    res.status(400).json({ error: err.message });
  } finally {
    fs.rm(tmpPath, () => {});
    del(archivo_url).catch(() => {});
  }
}));

// ---------------------------------------------------------------------------
// Órdenes de Cambio (prompt-ordenes-cambio.md, diagnóstico previo en
// prompt-diagnostico-ordenes-cambio.md) — solicitud formal de cambio de
// alcance con folio/justificación/aprobación. Captura: residente/cabo.
// Aprobación/rechazo: admin/desarrollador exclusivamente (auth.allow() sin
// argumentos), mismo criterio que la actualización de presupuesto por Excel
// arriba — aplicar un cambio real al presupuesto es igual de sensible sin
// importar el origen. Al aprobarse reusa el motor de reintegracionPresupuesto
// (server/ordenesCambio.js) — nunca reimplementa el emparejamiento/aplicación.
// ---------------------------------------------------------------------------
app.post('/api/projects/:id/ordenes-cambio', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('ordenes_cambio', 'puede_crear')), h(async (req, res) => {
  const pid = req.project.id;
  const { descripcion, lineas, documento_respaldo_url, documento_respaldo_nombre } = req.body || {};
  if (!descripcion || !descripcion.toString().trim()) {
    return res.status(400).json({ error: 'La descripción/justificación del cambio es requerida' });
  }
  if (!Array.isArray(lineas) || lineas.length === 0) {
    return res.status(400).json({ error: 'Agrega al menos una línea de concepto (ajuste a uno existente o concepto nuevo)' });
  }
  for (const l of lineas) {
    if (l.es_concepto_nuevo) {
      if (!l.descripcion || !l.descripcion.toString().trim() || !l.unidad || !Number.isFinite(Number(l.cantidad)) || Number(l.cantidad) <= 0 || !Number.isFinite(Number(l.precio_unitario)) || Number(l.precio_unitario) < 0) {
        return res.status(400).json({ error: 'Cada concepto nuevo requiere descripción, unidad, cantidad > 0 y precio unitario válido' });
      }
    } else {
      if (!Number.isFinite(Number(l.concepto_id)) || !Number.isFinite(Number(l.cantidad)) || Number(l.cantidad) < 0 || !Number.isFinite(Number(l.precio_unitario)) || Number(l.precio_unitario) < 0) {
        return res.status(400).json({ error: 'Cada ajuste a concepto existente requiere concepto_id, cantidad y precio unitario válidos' });
      }
    }
  }

  const { rows: existentesActivos } = await db.pool.query(
    `SELECT id, codigo, concepto, unidad, cantidad, precio_unitario, importe, grupo, es_total, orden, activo
     FROM conceptos WHERE project_id = $1 AND es_total = 0 AND activo = 1`,
    [pid]
  );

  let montoDelta;
  try {
    montoDelta = ordenesCambio.calcularMontoDelta(existentesActivos, lineas);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  const orden = await db.withTransaction(async (client) => {
    const { rows: folioRows } = await client.query(
      `INSERT INTO folio_counters (project_id, tipo, ultimo_folio) VALUES ($1, 'orden_cambio', 1)
       ON CONFLICT (project_id, tipo) DO UPDATE SET ultimo_folio = folio_counters.ultimo_folio + 1
       RETURNING ultimo_folio`,
      [pid]
    );
    const folio = String(folioRows[0].ultimo_folio);
    const { rows: ocRows } = await client.query(
      `INSERT INTO ordenes_cambio (project_id, folio, descripcion, solicitado_por, monto_delta, documento_respaldo_url, documento_respaldo_nombre)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [pid, folio, descripcion.toString().trim(), req.user.id, montoDelta, documento_respaldo_url || null, documento_respaldo_nombre || null]
    );
    const oc = ocRows[0];
    for (const l of lineas) {
      await client.query(
        `INSERT INTO orden_cambio_conceptos (orden_cambio_id, concepto_id, es_concepto_nuevo, codigo, descripcion, unidad, cantidad, precio_unitario)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          oc.id,
          l.es_concepto_nuevo ? null : Number(l.concepto_id),
          !!l.es_concepto_nuevo,
          l.codigo || null,
          l.es_concepto_nuevo ? l.descripcion.toString().trim() : null,
          l.unidad || null,
          Number(l.cantidad),
          Number(l.precio_unitario),
        ]
      );
    }
    return oc;
  });

  res.status(201).json(orden);
}));

app.get('/api/projects/:id/ordenes-cambio', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('ordenes_cambio', 'puede_ver')), h(async (req, res) => {
  const { estado } = req.query;
  const params = [req.project.id];
  let where = 'oc.project_id = $1';
  if (estado) { params.push(estado); where += ` AND oc.estado = $${params.length}`; }
  const { rows } = await db.pool.query(`
    SELECT oc.*, u.nombre AS solicitado_por_nombre, a.nombre AS aprobado_por_nombre
    FROM ordenes_cambio oc
    LEFT JOIN usuarios u ON u.id = oc.solicitado_por
    LEFT JOIN usuarios a ON a.id = oc.aprobado_por
    WHERE ${where}
    ORDER BY oc.id DESC
  `, params);
  res.json(rows);
}));

app.get('/api/projects/:id/ordenes-cambio/:ocId', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('ordenes_cambio', 'puede_ver')), h(async (req, res) => {
  const ocId = Number(req.params.ocId);
  const { rows: ocRows } = await db.pool.query(`
    SELECT oc.*, u.nombre AS solicitado_por_nombre, a.nombre AS aprobado_por_nombre
    FROM ordenes_cambio oc
    LEFT JOIN usuarios u ON u.id = oc.solicitado_por
    LEFT JOIN usuarios a ON a.id = oc.aprobado_por
    WHERE oc.id = $1 AND oc.project_id = $2
  `, [ocId, req.project.id]);
  if (!ocRows[0]) return res.status(404).json({ error: 'Orden de cambio no encontrada' });
  const { rows: lineas } = await db.pool.query(`
    SELECT occ.*, c.codigo AS concepto_codigo_actual, c.concepto AS concepto_nombre_actual
    FROM orden_cambio_conceptos occ
    LEFT JOIN conceptos c ON c.id = occ.concepto_id
    WHERE occ.orden_cambio_id = $1 ORDER BY occ.id
  `, [ocId]);
  res.json({ orden: ocRows[0], lineas });
}));

// Sin :id de obra en la ruta (la orden de cambio ya trae su project_id) —
// mismo patrón que GET /api/conceptos/:id/insumos más abajo. auth.allow()
// sin argumentos ya restringe a admin/desarrollador (ambos con acceso
// global, sin necesidad de IDOR check manual vía usuario_proyectos).
// checkPermiso('ordenes_cambio','puede_editar') queda como infraestructura
// preparada para el día que se abra esta acción a otro rol — admin/
// desarrollador la bypasean siempre.
app.put('/api/ordenes-cambio/:ocId/aprobar', h(auth.allow()), h(auth.checkPermiso('ordenes_cambio', 'puede_editar')), h(async (req, res) => {
  const ocId = Number(req.params.ocId);
  const { rows: ocRows } = await db.pool.query('SELECT project_id FROM ordenes_cambio WHERE id = $1', [ocId]);
  if (!ocRows[0]) return res.status(404).json({ error: 'Orden de cambio no encontrada' });
  const pid = ocRows[0].project_id;
  try {
    const resultado = await db.withTransaction(async (client) => {
      const r = await ordenesCambio.aprobarOrdenCambio(client, pid, ocId, req.user.id);
      const detalle = JSON.stringify({
        orden_cambio_id: ocId, folio: r.orden.folio, monto_delta: r.orden.monto_delta,
        nuevos: r.nuevos, emparejados: r.emparejados, total_despues: r.totalFinal,
      });
      await client.query(
        `INSERT INTO audit_log (actor_id, actor_usuario, accion, target_id, project_id, ip, detalle)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [req.user.id, req.user.usuario, 'orden_cambio_aprobada', ocId, pid, auth.getIp(req), detalle]
      );
      return r;
    });
    const { rows: updOc } = await db.pool.query('SELECT * FROM ordenes_cambio WHERE id = $1', [ocId]);
    res.json({ ok: true, orden: updOc[0], total_presupuesto_nuevo: resultado.totalFinal });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, conflictos: err.conflictos });
  }
}));

app.put('/api/ordenes-cambio/:ocId/rechazar', h(auth.allow()), h(auth.checkPermiso('ordenes_cambio', 'puede_editar')), h(async (req, res) => {
  const ocId = Number(req.params.ocId);
  const { comentario_rechazo } = req.body || {};
  if (!comentario_rechazo || !comentario_rechazo.toString().trim()) {
    return res.status(400).json({ error: 'El comentario de rechazo es requerido' });
  }
  const { rows: existRows } = await db.pool.query('SELECT estado FROM ordenes_cambio WHERE id = $1', [ocId]);
  if (!existRows[0]) return res.status(404).json({ error: 'Orden de cambio no encontrada' });
  if (existRows[0].estado !== 'pendiente') {
    return res.status(409).json({ error: `No se puede rechazar: la orden de cambio ya está en estado '${existRows[0].estado}'` });
  }
  const { rows } = await db.pool.query(
    `UPDATE ordenes_cambio SET estado = 'rechazada', comentario_rechazo = $1 WHERE id = $2 RETURNING *`,
    [comentario_rechazo.toString().trim(), ocId]
  );
  res.json(rows[0]);
}));

app.post('/api/projects/:id/ordenes-cambio/upload-token', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('ordenes_cambio', 'puede_crear')), h(async (req, res) => {
  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        const ext = (pathname.split('.').pop() || '').toLowerCase();
        if (!['pdf', 'jpg', 'jpeg', 'png'].includes(ext)) throw new Error('Solo se admiten archivos PDF, JPG o PNG');
        return { access: 'private', addRandomSuffix: true, maximumSizeInBytes: 20 * 1024 * 1024 };
      },
    });
    res.json(jsonResponse);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.get('/api/projects/:id/ordenes-cambio/:ocId/documento', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('ordenes_cambio', 'puede_ver')), h(async (req, res) => {
  const ocId = Number(req.params.ocId);
  const { rows } = await db.pool.query(
    'SELECT documento_respaldo_url, documento_respaldo_nombre FROM ordenes_cambio WHERE id = $1 AND project_id = $2',
    [ocId, req.project.id]
  );
  if (!rows[0] || !rows[0].documento_respaldo_url) return res.status(404).json({ error: 'Esta orden de cambio no tiene documento de respaldo' });
  const blobResult = await get(rows[0].documento_respaldo_url, { access: 'private' });
  if (!blobResult) return res.status(404).json({ error: 'Archivo no encontrado en almacenamiento' });
  const ext = (rows[0].documento_respaldo_nombre || '').split('.').pop()?.toLowerCase() || 'bin';
  const mimeMap = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
  res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
  res.setHeader('Content-Disposition', safeContentDisposition('inline', rows[0].documento_respaldo_nombre || 'documento'));
  await pipeline(Readable.fromWeb(blobResult.stream), res);
}));

// ---------------------------------------------------------------------------
// Lotes/Unidades (prompt-lotes-fase1.md, diagnóstico previo en
// prompt-diagnostico-lotes-fase1.md) — estatus de construcción por lote/casa
// individual dentro de una obra. Fase 1 (cimiento) del roadmap "Desarrollador
// de Vivienda": sin relación con avances_semanales/avance_financiero_real
// (Forbidden Action explícita), sin catálogo formal de modelos todavía.
// Import Excel: mismo patrón preview→confirmar que /api/contabilidad/
// movimientos (descargarBlobXlsxATmp + exceljs + diff antes de persistir),
// pero con criterio de reimportación DISTINTO — confirmado explícitamente
// (no era obvio, Stop Condition del prompt): reimportar un lote ya existente
// SÍ actualiza modelo_vivienda/superficie_m2 (corrige datos mal capturados),
// pero NUNCA toca estatus/fecha_entrega_* (solo se editan manualmente vía
// PUT) — ver server/lotes.js confirmarImportacionLotes.
// Acceso: residente (captura/edición) + admin/desarrollador — a propósito
// NO incluye 'cabo' esta fase (Starting State explícito del prompt).
// ---------------------------------------------------------------------------
app.get('/api/projects/:id/lotes', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('lotes', 'puede_ver')), h(async (req, res) => {
  const { estatus, manzana } = req.query;
  res.json(await lotes.listLotes(req.project.id, { estatus, manzana }));
}));

app.post('/api/projects/:id/lotes', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('lotes', 'puede_crear')), h(async (req, res) => {
  try {
    const nuevo = await lotes.createLote(req.project.id, req.body || {});
    res.status(201).json(nuevo);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un lote con esa manzana y número de lote en esta obra' });
    res.status(err.status || 400).json({ error: err.message });
  }
}));

app.put('/api/projects/:id/lotes/:loteId', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('lotes', 'puede_editar')), h(async (req, res) => {
  try {
    const actualizado = await lotes.updateLote(Number(req.params.loteId), req.project.id, req.body || {});
    res.json(actualizado);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un lote con esa manzana y número de lote en esta obra' });
    res.status(err.status || 400).json({ error: err.message });
  }
}));

app.post('/api/projects/:id/lotes/importar/upload-token', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('lotes', 'puede_crear')), h(async (req, res) => {
  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        if (!/\.xlsx$/i.test(pathname)) throw new Error('Solo se admiten archivos .xlsx');
        return {
          access: 'private',
          allowedContentTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
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

app.post('/api/projects/:id/lotes/importar/preview', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('lotes', 'puede_crear')), h(async (req, res) => {
  const { archivo_url } = req.body || {};
  if (!archivo_url) return res.status(400).json({ error: 'Sube un archivo .xlsx de lotes' });
  const tmpPath = path.join(os.tmpdir(), `lotes-${Date.now()}-${Math.round(Math.random() * 1e9)}.xlsx`);
  try {
    await descargarBlobXlsxATmp(archivo_url, tmpPath);
    const { lotes: lotesParsed, filasInvalidas } = await lotes.parseLotesExcel(tmpPath);
    if (!lotesParsed.length) {
      return res.status(400).json({ error: 'No se reconoció ningún lote válido en el archivo.' });
    }
    const { nuevos, existentes } = await lotes.diffLotesImportacion(req.project.id, lotesParsed);
    res.json({ nuevos, existentes, filas_invalidas: filasInvalidas });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  } finally {
    fs.rm(tmpPath, () => {});
  }
}));

app.post('/api/projects/:id/lotes/importar/confirmar', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('lotes', 'puede_crear')), h(async (req, res) => {
  const { archivo_url, confirmado } = req.body || {};
  if (!archivo_url) return res.status(400).json({ error: 'Sube un archivo .xlsx de lotes' });
  if (confirmado !== true) return res.status(400).json({ error: 'Falta confirmar explícitamente la importación' });
  const tmpPath = path.join(os.tmpdir(), `lotes-${Date.now()}-${Math.round(Math.random() * 1e9)}.xlsx`);
  try {
    await descargarBlobXlsxATmp(archivo_url, tmpPath);
    const { lotes: lotesParsed } = await lotes.parseLotesExcel(tmpPath);
    if (!lotesParsed.length) {
      return res.status(400).json({ error: 'No se reconoció ningún lote válido en el archivo.' });
    }
    const resultado = await lotes.confirmarImportacionLotes(req.project.id, lotesParsed, req.user.id);
    res.json(resultado);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  } finally {
    fs.rm(tmpPath, () => {});
  }
}));

// ---------------------------------------------------------------------------
// Catálogo comercial de modelos de vivienda (prompt-implementacion-catalogo-
// comercial.md, diagnóstico previo en prompt-diagnostico-catalogo-comercial.md)
// — Fase 3 del roadmap "Desarrollador de Vivienda". Consulta (GET) para
// admin/desarrollador/residente, mismo criterio de acceso que Lotes.
// Crear/editar/eliminar (soft-delete) SOLO admin/desarrollador — gateado a
// nivel de ruta con auth.allow() SIN argumentos (información comercial
// sensible, precio de lista, no delegable a otro rol hoy). checkPermiso
// SÍ se encadena de todas formas en las 3 rutas, aunque admin/desarrollador
// lo bypaseen siempre — mismo patrón EXACTO que aprobar/rechazar en
// ordenes_cambio (server/app.js, PUT /api/ordenes-cambio/:ocId/aprobar):
// queda como infraestructura preparada para el día que se delegue esta
// acción a otro rol, sin requerir otra migración de permisos.
// ---------------------------------------------------------------------------
app.get('/api/projects/:id/modelos-vivienda', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('modelos_vivienda', 'puede_ver')), h(async (req, res) => {
  res.json(await modelosVivienda.listModelos(req.project.id));
}));

app.post('/api/projects/:id/modelos-vivienda', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('modelos_vivienda', 'puede_crear')), h(async (req, res) => {
  try {
    const nuevo = await modelosVivienda.createModelo(req.project.id, req.body || {});
    res.status(201).json(nuevo);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un modelo con ese nombre en esta obra' });
    res.status(err.status || 400).json({ error: err.message });
  }
}));

app.put('/api/projects/:id/modelos-vivienda/:modeloId', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('modelos_vivienda', 'puede_editar')), h(async (req, res) => {
  try {
    const actualizado = await modelosVivienda.updateModelo(Number(req.params.modeloId), req.project.id, req.body || {});
    res.json(actualizado);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un modelo con ese nombre en esta obra' });
    res.status(err.status || 400).json({ error: err.message });
  }
}));

app.delete('/api/projects/:id/modelos-vivienda/:modeloId', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('modelos_vivienda', 'puede_eliminar')), h(async (req, res) => {
  try {
    const eliminado = await modelosVivienda.softDeleteModelo(Number(req.params.modeloId), req.project.id);
    res.json(eliminado);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}));

// ---------------------------------------------------------------------------
// Ventas — Compradores + Apartado (prompt-implementacion-pr-a-compradores-
// apartado.md, diagnóstico previo en prompt-diagnostico-compradores-venta.md)
// — PR A de 4 de la Fase 4 del roadmap "Desarrollador de Vivienda". Todo
// admin/desarrollador EXCLUSIVO vía auth.allow() SIN argumentos — a
// propósito SIN checkPermiso ni entrada en permisos_usuario/
// SECCIONES_PERMISOS (Forbidden Action explícita del prompt), mismo criterio
// que Contrato de construcción: dato de comprador es información personal
// de un tercero, no solo comercialmente sensible.
// ---------------------------------------------------------------------------
app.get('/api/projects/:id/compradores', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  res.json(await ventas.listCompradores(req.project.id));
}));

app.post('/api/projects/:id/compradores', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  try {
    const nuevo = await ventas.createComprador(req.project.id, req.body || {});
    res.status(201).json(nuevo);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}));

app.put('/api/projects/:id/compradores/:compradorId', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  try {
    const actualizado = await ventas.updateComprador(Number(req.params.compradorId), req.project.id, req.body || {});
    res.json(actualizado);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}));

app.delete('/api/projects/:id/compradores/:compradorId', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  try {
    const eliminado = await ventas.softDeleteComprador(Number(req.params.compradorId), req.project.id);
    res.json(eliminado);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}));

app.get('/api/projects/:id/apartados', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  res.json(await ventas.listApartados(req.project.id));
}));

app.post('/api/projects/:id/apartados', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  try {
    const nuevo = await ventas.crearApartado(req.project.id, req.body || {}, req.user.id);
    res.status(201).json(nuevo);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}));

app.put('/api/projects/:id/apartados/:apartadoId/cancelar', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  try {
    const cancelado = await ventas.cancelarApartado(Number(req.params.apartadoId), req.project.id);
    res.json(cancelado);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}));

// Cierra el hueco detectado en PR B: único camino para sacar un lote de
// 'no_disponible' sin pasar por un apartado creado-y-cancelado. Mismo
// gateo que el resto de Ventas — auth.allow() sin argumentos.
app.put('/api/projects/:id/lotes/:loteId/marcar-disponible', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  try {
    const actualizado = await ventas.marcarLoteDisponible(Number(req.params.loteId), req.project.id);
    res.json(actualizado);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}));

// Override de emergencia (prompt-override-emergencia-estatus-venta.md) —
// escape auditado, exclusivo admin/desarrollador, para casos que los flujos
// normales (apartar/cancelar/contratar/marcar-disponible) no cubren. NO
// cancela apartados/contratos relacionados, solo los reporta en la respuesta.
app.put('/api/projects/:id/lotes/:loteId/forzar-estatus-venta', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  try {
    const resultado = await ventas.forzarEstatusVenta(
      Number(req.params.loteId), req.project.id, req.body || {}, req.user, auth.getIp(req)
    );
    res.json(resultado);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}));

// Historial de overrides de emergencia sobre estatus_venta — mismo patrón
// que /api/projects/:id/requisiciones-historial (audit_log filtrado por
// accion + project_id), consultable para que el escape quede visible, no
// oculto en la bitácora general.
app.get('/api/projects/:id/lotes/estatus-venta-historial', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  res.json(await ventas.listEstatusVentaHistorial(req.project.id));
}));

// ---------------------------------------------------------------------------
// Contrato de compraventa (prompt-implementacion-pr-b-contrato-venta.md) —
// Fase 4, PR B. Adjunto simple (Vercel Blob), mismo patrón exacto que
// contratos_trabajador (POST .../upload-token → POST .../contratos-venta con
// el pdf_url ya subido → GET .../download hace proxy del blob) — SIN
// extracción vía IA (Forbidden Action explícita). Mismo criterio de permisos
// que Compradores/Apartados: admin/desarrollador exclusivo, sin checkPermiso.
// ---------------------------------------------------------------------------
app.get('/api/projects/:id/contratos-venta', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  res.json(await ventas.listContratosVenta(req.project.id));
}));

app.post('/api/projects/:id/contratos-venta/upload-token', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
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

app.post('/api/projects/:id/contratos-venta', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  try {
    const nuevo = await ventas.crearContratoVenta(req.project.id, req.body || {}, req.user.id);
    res.status(201).json(nuevo);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}));

app.put('/api/projects/:id/contratos-venta/:contratoId', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  try {
    const actualizado = await ventas.updateContratoVenta(Number(req.params.contratoId), req.project.id, req.body || {});
    res.json(actualizado);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}));

app.put('/api/projects/:id/contratos-venta/:contratoId/cancelar', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  try {
    const cancelado = await ventas.cancelarContratoVenta(Number(req.params.contratoId), req.project.id);
    res.json(cancelado);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}));

app.get('/api/projects/:id/contratos-venta/:contratoId/download', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { rows } = await db.pool.query(
    `SELECT cv.pdf_url, cv.pdf_filename FROM contratos_venta cv
     JOIN lotes l ON l.id = cv.lote_id
     WHERE cv.id = $1 AND l.project_id = $2`,
    [Number(req.params.contratoId), req.project.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Contrato no encontrado' });
  if (!rows[0].pdf_url) return res.status(404).json({ error: 'Este contrato no tiene PDF adjunto' });
  const blobResult = await get(rows[0].pdf_url, { access: 'private' });
  if (!blobResult) return res.status(404).json({ error: 'Archivo no encontrado en almacenamiento' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', safeContentDisposition('inline', rows[0].pdf_filename || 'contrato-venta.pdf'));
  await pipeline(Readable.fromWeb(blobResult.stream), res);
}));

// ---------------------------------------------------------------------------
// Cobranza (prompt-implementacion-pr-c-cobranza.md) — Fase 4, PR C. Plan de
// pagos opcional + registro de pagos sobre un contrato de venta ya firmado.
// Mismo criterio de permisos que el resto de Ventas: admin/desarrollador
// exclusivo, auth.allow() sin argumentos, sin checkPermiso.
// ---------------------------------------------------------------------------
app.get('/api/projects/:id/contratos-venta/:contratoId/cobranza', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  try {
    const cobranza = await ventas.getCobranzaContrato(Number(req.params.contratoId), req.project.id);
    res.json(cobranza);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}));

app.put('/api/projects/:id/contratos-venta/:contratoId/plan-pago', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  try {
    const resultado = await ventas.guardarPlanPago(
      Number(req.params.contratoId), req.project.id, (req.body || {}).items, req.user.id
    );
    res.json(resultado);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}));

app.post('/api/projects/:id/contratos-venta/:contratoId/pagos', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  try {
    const resultado = await ventas.registrarPagoVenta(
      Number(req.params.contratoId), req.project.id, req.body || {}, req.user.id
    );
    res.status(201).json(resultado);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}));

// ---------------------------------------------------------------------------
// Entrega de lote (prompt-implementacion-pr-d-entregas.md) — Fase 4, PR D,
// último del roadmap Desarrollador de Vivienda. Registro formal de entrega
// con firma digital, exige contrato de venta vigente. Mismo criterio de
// permisos que el resto de Ventas: admin/desarrollador exclusivo,
// auth.allow() sin argumentos, sin checkPermiso.
// ---------------------------------------------------------------------------
app.get('/api/projects/:id/lotes-entregas', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  res.json(await ventas.listEntregasVenta(req.project.id));
}));

app.post('/api/projects/:id/lotes/:loteId/entrega', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  try {
    const nueva = await ventas.crearEntrega(Number(req.params.loteId), req.project.id, req.body || {}, req.user.id);
    res.status(201).json(nueva);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}));

// ---------------------------------------------------------------------------
// Mapeo concepto ↔ insumos (solo admin) — infraestructura de captura para un
// futuro bloqueo de avance; todavía no se usa para bloquear nada.
// ---------------------------------------------------------------------------
// checkPermiso('mapeo', accion) va antes del handler (no hay requireProject
// en estas rutas concepto-scoped, así que req.project no existe todavía al
// momento de correr checkPermiso — solo reconoce permisos_usuario con
// proyecto_id IS NULL, no overrides por-obra específicos). El chequeo IDOR
// manual (usuario_proyectos contra el project_id real del concepto/insumo)
// sigue intacto, sin tocar, y sigue ejecutándose siempre dentro del handler
// — checkPermiso es un gate de rol adicional, independiente, nunca lo
// reemplaza ni lo puede saltar (prompt-checkpermiso-mapeo.md).
// 'administracion' agregado (prompt-seccion-costos-implementacion.md, fix de
// bug preexistente confirmado en prompt-diagnostico-seccion-costos-nueva.md):
// administracion tiene el tab 'mapeo' y pasa el gate del frontend
// (puedeVerMapeo(), public/app.js) desde que se le dio el tab en
// prompt-costos-mapeo-y-mover-tiles.md, pero nunca se agregó aquí — 403 real
// en los 4 endpoints pese a ver la pantalla, sin relación con la
// reorganización de secciones de este prompt.
app.get('/api/conceptos/:id/insumos', h(auth.allow('costos', 'administracion')), h(auth.checkPermiso('mapeo', 'puede_ver')), h(async (req, res) => {
  const conceptoId = Number(req.params.id);
  const { rows: conceptoRows } = await db.pool.query('SELECT id, project_id FROM conceptos WHERE id = $1', [conceptoId]);
  if (!conceptoRows[0]) return res.status(404).json({ error: 'Concepto no encontrado' });
  const p = req.user.puesto;
  if (p !== 'admin' && p !== 'desarrollador') {
    const { rows: acc } = await db.pool.query('SELECT 1 FROM usuario_proyectos WHERE usuario_id=$1 AND project_id=$2', [req.user.id, conceptoRows[0].project_id]);
    if (!acc[0]) return res.status(403).json({ error: 'No tienes permiso para realizar esta acción' });
  }
  const { rows } = await db.pool.query(`
    SELECT i.* FROM concepto_insumos ci
    JOIN insumos i ON i.id = ci.insumo_id
    WHERE ci.concepto_id = $1
    ORDER BY i.orden
  `, [conceptoId]);
  res.json(rows);
}));

app.post('/api/conceptos/:id/insumos', h(auth.allow('costos', 'administracion')), h(auth.checkPermiso('mapeo', 'puede_crear')), h(async (req, res) => {
  const conceptoId = Number(req.params.id);
  const insumoId = Number((req.body || {}).insumo_id);
  if (!insumoId) return res.status(400).json({ error: 'insumo_id es requerido' });

  const { rows: conceptoRows } = await db.pool.query('SELECT id, project_id FROM conceptos WHERE id = $1', [conceptoId]);
  if (!conceptoRows[0]) return res.status(404).json({ error: 'Concepto no encontrado' });
  const p = req.user.puesto;
  if (p !== 'admin' && p !== 'desarrollador') {
    const { rows: acc } = await db.pool.query('SELECT 1 FROM usuario_proyectos WHERE usuario_id=$1 AND project_id=$2', [req.user.id, conceptoRows[0].project_id]);
    if (!acc[0]) return res.status(403).json({ error: 'No tienes permiso para realizar esta acción' });
  }

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

app.delete('/api/conceptos/:id/insumos/:insumo_id', h(auth.allow('costos', 'administracion')), h(auth.checkPermiso('mapeo', 'puede_eliminar')), h(async (req, res) => {
  const conceptoId = Number(req.params.id);
  const insumoId = Number(req.params.insumo_id);
  const { rows: conceptoRows } = await db.pool.query('SELECT id, project_id FROM conceptos WHERE id = $1', [conceptoId]);
  if (!conceptoRows[0]) return res.status(404).json({ error: 'Concepto no encontrado' });
  const p = req.user.puesto;
  if (p !== 'admin' && p !== 'desarrollador') {
    const { rows: acc } = await db.pool.query('SELECT 1 FROM usuario_proyectos WHERE usuario_id=$1 AND project_id=$2', [req.user.id, conceptoRows[0].project_id]);
    if (!acc[0]) return res.status(403).json({ error: 'No tienes permiso para realizar esta acción' });
  }
  const { rowCount } = await db.pool.query(
    'DELETE FROM concepto_insumos WHERE concepto_id = $1 AND insumo_id = $2',
    [conceptoId, insumoId]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Ese insumo no está vinculado a este concepto' });
  res.json({ ok: true });
}));

// Resumen de progreso de mapeo por proyecto (no pedido explícitamente, pero
// necesario para el contador "X/95 conceptos mapeados" de la pantalla admin).
app.get('/api/projects/:id/concepto-insumos/resumen', h(auth.allow('costos', 'administracion')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('mapeo', 'puede_ver')), h(async (req, res) => {
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
// incluirManoObra: opt-in explícito (prompt-20-matrices-formato-neodata.md,
// CP5) — el buscador de insumos del editor de Matrices reusa este mismo
// endpoint pero SÍ necesita encontrar códigos MO* (cuadrilla de Mano de
// Obra); el resto de llamadas (catálogo de Insumos/Compras, export,
// programa de materiales) no lo mandan y siguen excluyendo MO* como antes
// (commit 5667f42: mano de obra no pasa por requisición→OC).
async function getInsumosData(pid, { categoria, q, incluirManoObra } = {}) {
  let sql = incluirManoObra
    ? 'SELECT * FROM insumos WHERE project_id = $1'
    : "SELECT * FROM insumos WHERE project_id = $1 AND (codigo IS NULL OR codigo NOT ILIKE 'MO%')";
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

// prompt-costos-mapeo-y-mover-tiles.md: 'costos' agregado — el buscador de
// insumos dentro de Mapeo ("Vincular un insumo") llama este mismo endpoint.
app.get('/api/projects/:id/insumos', h(auth.allow('residente', 'cabo', 'compras', 'logistica', 'costos')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('insumos', 'puede_ver')), h(async (req, res) => {
  let data = await getInsumosData(req.project.id, req.query);
  if (req.user.puesto === 'cabo') {
    data = data.map(({ precio_presupuesto, ...rest }) => ({ ...rest, precio_presupuesto: null }));
  }
  res.json(data);
}));

app.get('/api/projects/:id/insumos/export', h(auth.allow('residente', 'cabo', 'compras', 'logistica')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('insumos', 'puede_ver')), h(async (req, res) => {
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

// ---------------------------------------------------------------------------
// Programa de materiales disponibles (prompt-11-programa-materiales-
// disponibles.md) — residente. Decisión consultada tras diagnóstico: sin
// tabla nueva (se genera en vivo, coherente con que Insumos/OC/recepciones
// cambian con frecuencia); reutiliza la sección de permiso 'insumos' que
// residente YA tiene (sin ampliar acceso).
//
// "Disponible" ya tenía un significado establecido en getInsumosData (arriba):
// presupuestado − ya solicitado en requisiciones. Este módulo agrega una
// SEGUNDA cifra, 'cantidad_recibida' (vía recepcion_items — lo más cercano a
// "llegó físicamente a obra" que tiene el sistema hoy), SIN pisar ni
// renombrar la original — decisión consultada: mostrar ambas cifras lado a
// lado, nunca fusionarlas en un solo número.
async function getRecibidoPorInsumo(pid) {
  const { rows } = await db.pool.query(`
    SELECT reqi.insumo_id, SUM(ri.cantidad_recibida) AS cantidad_recibida
    FROM recepcion_items ri
    JOIN orden_compra_items oci ON oci.id = ri.orden_compra_item_id
    JOIN requisicion_items reqi ON reqi.id = oci.requisicion_item_id
    JOIN requisiciones r ON r.id = reqi.requisicion_id
    WHERE r.project_id = $1
    GROUP BY reqi.insumo_id
  `, [pid]);
  return new Map(rows.map((r) => [r.insumo_id, Number(r.cantidad_recibida)]));
}

async function getMaterialesDisponiblesData(pid, query) {
  const [insumos, recibidoMap] = await Promise.all([
    getInsumosData(pid, query),
    getRecibidoPorInsumo(pid),
  ]);
  return insumos.map((i) => ({ ...i, cantidad_recibida: recibidoMap.get(i.id) || 0 }));
}

function materialesDisponiblesExportSheet(materiales, sheetName) {
  return {
    sheetName,
    columns: [
      { header: 'Código', key: 'codigo', width: 14 },
      { header: 'Concepto', key: 'concepto', width: 40 },
      { header: 'Unidad', key: 'unidad', width: 10 },
      { header: 'Categoría', key: 'categoria', width: 18 },
      { header: 'Cantidad presupuestada', key: 'cantidad_presupuesto', width: 20, format: 'int' },
      { header: 'Disponible (sin solicitar)', key: 'cantidad_disponible', width: 22, format: 'int' },
      { header: 'Recibido en obra', key: 'cantidad_recibida', width: 18, format: 'int' },
      { header: 'Precio unitario presupuestado', key: 'precio_presupuesto', width: 22, format: 'money' },
    ],
    rows: materiales.map((i) => ({
      codigo: i.codigo, concepto: i.concepto, unidad: i.unidad, categoria: i.categoria,
      cantidad_presupuesto: Number(i.cantidad_presupuesto),
      cantidad_disponible: Number(i.cantidad_disponible),
      cantidad_recibida: Number(i.cantidad_recibida),
      precio_presupuesto: Number(i.precio_presupuesto),
    })),
  };
}

// Solo residente (+ admin/desarrollador vía bypass automático de
// auth.allow()) — a diferencia de /insumos (arriba), que también incluye
// cabo/compras/logistica; este programa es explícitamente para residente
// (título del prompt). Ownership real: requireProject + verificarAccesoObra
// ya dan 403 si el residente pide una obra que no tiene asignada — mismo
// patrón que /insumos, sin código adicional.
app.get('/api/projects/:id/materiales-disponibles', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('insumos', 'puede_ver')), h(async (req, res) => {
  res.json(await getMaterialesDisponiblesData(req.project.id, req.query));
}));

app.get('/api/projects/:id/materiales-disponibles/export', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('insumos', 'puede_ver')), h(async (req, res) => {
  const materiales = await getMaterialesDisponiblesData(req.project.id, req.query);
  await sendXlsxExport(res, {
    filename: buildExportFilename('Materiales-Disponibles', req.project.nombre),
    sheets: [materialesDisponiblesExportSheet(materiales, 'Materiales')],
  });
}));

// Agrupación por cliente (Target State #1: "cuando el residente tiene
// acceso a más de una obra del mismo cliente") — cada fila queda anclada a
// su obra de origen (obra_id/obra_nombre), nunca fusionada entre obras: un
// mismo código puede tener precio/disponibilidad distinta por obra, fusionar
// habría sido engañoso. Ownership manual (no hay un solo :id de req para
// requireProject): admin/desarrollador ven todas las obras del cliente;
// residente solo las suyas (usuario_proyectos), silenciosamente — mismo
// criterio que getReportePorCliente (server/maquinaria.js), sin 403 para una
// vista agregada (a diferencia del endpoint de una sola obra, arriba).
async function getObrasDelClienteParaUsuario(clienteId, req) {
  // prompt-URGENTE-fix-acceso-todos-presupuestos.md: 'desarrollador' con
  // usuario_proyectos asignado se restringe igual que 'residente' aquí.
  const esAdmin = req.user.puesto === 'admin'
    || (req.user.puesto === 'desarrollador' && !(await db.usuarioTieneAsignacionExplicita(req.user.id)));
  const { rows } = await db.pool.query(`
    SELECT p.id, p.nombre
    FROM proyectos p
    ${esAdmin ? '' : 'JOIN usuario_proyectos up ON up.project_id = p.id AND up.usuario_id = $2'}
    WHERE p.cliente_id = $1
    ORDER BY p.nombre
  `, esAdmin ? [clienteId] : [clienteId, req.user.id]);
  return rows;
}

app.get('/api/materiales-disponibles/por-cliente', h(auth.allow('residente')), h(async (req, res) => {
  const clienteId = Number(req.query.cliente_id);
  if (!clienteId) return res.status(400).json({ error: 'Indica cliente_id' });
  const obras = await getObrasDelClienteParaUsuario(clienteId, req);
  const porObra = await Promise.all(obras.map(async (o) => ({
    obra_id: o.id, obra_nombre: o.nombre,
    materiales: await getMaterialesDisponiblesData(o.id, req.query),
  })));
  res.json({ obras: porObra });
}));

app.get('/api/materiales-disponibles/por-cliente/export', h(auth.allow('residente')), h(async (req, res) => {
  const clienteId = Number(req.query.cliente_id);
  if (!clienteId) return res.status(400).json({ error: 'Indica cliente_id' });
  const { rows: clienteRows } = await db.pool.query('SELECT nombre FROM clientes WHERE id = $1', [clienteId]);
  const obras = await getObrasDelClienteParaUsuario(clienteId, req);
  const sheets = await Promise.all(obras.map(async (o) => materialesDisponiblesExportSheet(
    await getMaterialesDisponiblesData(o.id, req.query), o.nombre
  )));
  await sendXlsxExport(res, {
    filename: buildExportFilename('Materiales-Disponibles', clienteRows[0]?.nombre || 'Cliente'),
    sheets: sheets.length ? sheets : [{ sheetName: 'Materiales', columns: [{ header: 'Sin obras', key: 'x', width: 20 }], rows: [] }],
  });
}));

app.get('/api/projects/:id/insumos/categorias', h(auth.allow('residente', 'cabo', 'compras', 'logistica')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('insumos', 'puede_ver')), h(async (req, res) => {
  const { rows } = await db.pool.query(
    "SELECT DISTINCT categoria FROM insumos WHERE project_id = $1 AND categoria IS NOT NULL AND (codigo IS NULL OR codigo NOT ILIKE 'MO%') ORDER BY categoria",
    [req.project.id]
  );
  res.json(rows.map((r) => r.categoria));
}));

// Solo permite editar la tasa de IVA del insumo (captura hacia adelante para
// Compras) — no toca codigo/concepto/cantidad/precio del catálogo del .xlsx.
// checkPermiso('insumos', 'puede_editar') cableado como infraestructura
// preparada: la ruta sigue detrás de auth.allow() sin argumentos (solo
// admin/desarrollador la alcanzan, y ambos bypasean checkPermiso por
// diseño), así que hoy es inerte en la práctica — mismo patrón que
// Mapeo/Impuestos/Contrato (prompt-checkpermiso-insumos.md).
app.put('/api/projects/:id/insumos/:insumoId', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('insumos', 'puede_editar')), h(async (req, res) => {
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

// true si el usuario (residente/cabo) NO es dueño de esta requisición y por
// lo tanto no debe verla ni operarla. Las requisiciones sin dueño (usuario_id
// NULL — creadas antes del control por creador) se respetan: siguen
// visibles/editables para cualquier residente/cabo con acceso a la obra, no
// solo para admin/compras/logistica.
function requisicionAjena(row, user) {
  return ['residente', 'cabo'].includes(user.puesto) && row.usuario_id != null && row.usuario_id !== user.id;
}

// Bitácora de qué hacen residente/cabo sobre requisiciones (control
// administrativo pedido explícitamente — ver historial en
// GET /api/projects/:id/requisiciones-historial). compras/logistica/admin no
// están restringidos por dueño y no se registran aquí.
async function logRequisicionAudit(req, accion, requisicion, detalleExtra) {
  // prompt-editar-requisicion-con-oc.md: 'requisicion_item_editar_post_oc'
  // es la EXCEPCIÓN deliberada a la regla de arriba — ese endpoint nuevo es
  // admin/desarrollador-only (nunca residente/cabo), y es exactamente el
  // tipo de acción que este log SÍ debe capturar (corrección de un registro
  // ya cerrado del flujo normal, con justificación obligatoria) — omitirla
  // dejaría sin forma de cumplir el checkpoint de auditoría del prompt.
  if (accion !== 'requisicion_item_editar_post_oc' && !['residente', 'cabo'].includes(req.user.puesto)) return;
  const ip = auth.getIp(req);
  const label = requisicion.folio || `Requisición #${requisicion.id}`;
  await db.pool.query(
    'INSERT INTO audit_log (actor_id, actor_usuario, accion, target_id, target_usuario, project_id, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [req.user.id, req.user.usuario, accion, requisicion.id, detalleExtra ? `${label} ${detalleExtra}` : label, req.project.id, ip]
  ).catch(() => {});
}

// usuarioId: si se pasa, restringe a las requisiciones creadas por ese
// usuario MÁS las que no tienen dueño (usuario_id NULL — ver
// requisicionAjena arriba). null = sin restricción (compras/logistica/admin
// siguen viendo todas las de la obra).
async function getRequisicionesData(pid, usuarioId = null) {
  const { rows: reqs } = usuarioId != null
    ? await db.pool.query(
        'SELECT * FROM requisiciones WHERE project_id = $1 AND (usuario_id = $2 OR usuario_id IS NULL) ORDER BY id DESC',
        [pid, usuarioId]
      )
    : await db.pool.query(
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

app.get('/api/projects/:id/requisiciones', h(auth.allow('residente', 'cabo', 'compras', 'logistica')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('requisiciones', 'puede_ver')), h(async (req, res) => {
  const soloPropias = ['residente', 'cabo'].includes(req.user.puesto);
  let data = await getRequisicionesData(req.project.id, soloPropias ? req.user.id : null);
  if (soloPropias) {
    data = data.map(({ importe_total, alertas_precio, ...rest }) => rest);
  }
  res.json(data);
}));

app.get('/api/projects/:id/requisiciones/export', h(auth.allow('residente', 'cabo', 'compras', 'logistica')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('requisiciones', 'puede_ver')), h(async (req, res) => {
  const soloPropias = ['residente', 'cabo'].includes(req.user.puesto);
  const reqs = await getRequisicionesData(req.project.id, soloPropias ? req.user.id : null);
  const reqMap = new Map(reqs.map((r) => [r.id, r]));

  const { rows: allItemRows } = await db.pool.query(`
    SELECT ri.requisicion_id, ri.cantidad_solicitada, ri.precio_solicitado, ri.importe,
           ri.alerta_cantidad, ri.alerta_precio,
           i.codigo AS insumo_codigo, i.concepto AS insumo_concepto, i.unidad
    FROM requisicion_items ri
    JOIN insumos i ON i.id = ri.insumo_id
    JOIN requisiciones r ON r.id = ri.requisicion_id
    WHERE r.project_id = $1
    ORDER BY ri.requisicion_id, ri.id
  `, [req.project.id]);
  // reqMap ya viene acotado a lo propio si aplica — se filtran los items igual.
  const itemRows = allItemRows.filter((it) => reqMap.has(it.requisicion_id));

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

app.get('/api/projects/:id/requisiciones/:reqId', h(auth.allow('residente', 'cabo', 'compras', 'logistica')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('requisiciones', 'puede_ver')), h(async (req, res) => {
  const { rows: reqRows } = await db.pool.query(
    'SELECT * FROM requisiciones WHERE id = $1 AND project_id = $2',
    [Number(req.params.reqId), req.project.id]
  );
  if (!reqRows[0]) return res.status(404).json({ error: 'Requisición no encontrada' });
  if (requisicionAjena(reqRows[0], req.user)) {
    return res.status(404).json({ error: 'Requisición no encontrada' });
  }
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

app.post('/api/projects/:id/requisiciones', h(auth.allow('residente', 'cabo', 'compras')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('requisiciones', 'puede_crear')), h(async (req, res) => {
  const pid = req.project.id;
  const { folio, fecha, fecha_suministro, observaciones, items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'La requisición debe incluir al menos un insumo' });
  }
  // Opcional a propósito (no retroactivo, no bloquea captura) — ver
  // prompt-15-fecha-suministro-y-programa.md. Cuando sí se manda, no puede
  // ser anterior a la fecha de la requisición (la misma que se está
  // guardando en este INSERT, incluyendo el default CURRENT_DATE).
  if (fecha_suministro) {
    const fechaBase = fecha || new Date().toISOString().slice(0, 10);
    if (fecha_suministro < fechaBase) {
      return res.status(400).json({ error: 'La fecha de suministro no puede ser anterior a la fecha de la requisición' });
    }
  }
  // Residente/cabo solo anexan cantidades — el precio siempre lo determina
  // el presupuesto (computeAlertsAndTotals cae a insumo.precio_presupuesto
  // cuando precio_solicitado es null), sin importar qué manden en el body.
  if (['residente', 'cabo'].includes(req.user.puesto)) {
    items.forEach((it) => { it.precio_solicitado = null; });
  }
  try {
    const computed = await computeAlertsAndTotals(pid, items);
    const created = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO requisiciones (project_id, folio, fecha, fecha_suministro, estado, observaciones, usuario_id)
         VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), $4::date, 'borrador', $5, $6) RETURNING *`,
        [pid, folio || null, fecha || null, fecha_suministro || null, observaciones || null, req.user.id]
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
    await logRequisicionAudit(req, 'requisicion_crear', created);
    res.status(201).json({ ...created, items: computed, tiene_alertas: computed.some((c) => c.alerta_cantidad || c.alerta_precio) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.put('/api/projects/:id/requisiciones/:reqId', h(auth.allow('residente', 'cabo', 'compras')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('requisiciones', 'puede_editar')), h(async (req, res) => {
  const pid = req.project.id;
  const reqId = Number(req.params.reqId);
  const { rows: existRows } = await db.pool.query(
    'SELECT * FROM requisiciones WHERE id = $1 AND project_id = $2',
    [reqId, pid]
  );
  if (!existRows[0]) return res.status(404).json({ error: 'Requisición no encontrada' });
  if (requisicionAjena(existRows[0], req.user)) {
    return res.status(404).json({ error: 'Requisición no encontrada' });
  }
  if (existRows[0].estado !== 'borrador') {
    return res.status(400).json({ error: 'Solo se pueden editar requisiciones en estado "borrador"' });
  }
  const { folio, fecha, fecha_suministro, observaciones, items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'La requisición debe incluir al menos un insumo' });
  }
  // Mismo candado que en POST — cuando se manda, no puede ser anterior a la
  // fecha efectiva de la requisición (la nueva si se cambió, si no la ya
  // guardada). fecha_suministro NO usa COALESCE al guardar (más abajo): a
  // diferencia de 'fecha', debe poderse limpiar mandando null explícito —
  // decisión consultada: el campo es opcional pero visible, y un residente
  // debe poder corregir/quitar una fecha capturada por error.
  if (fecha_suministro) {
    const fechaBase = fecha || existRows[0].fecha;
    if (fecha_suministro < fechaBase) {
      return res.status(400).json({ error: 'La fecha de suministro no puede ser anterior a la fecha de la requisición' });
    }
  }
  // Ver mismo candado en POST /requisiciones — residente/cabo no manipulan precios.
  if (['residente', 'cabo'].includes(req.user.puesto)) {
    items.forEach((it) => { it.precio_solicitado = null; });
  }
  try {
    const computed = await computeAlertsAndTotals(pid, items, reqId);
    const updated = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE requisiciones SET folio = $1, fecha = COALESCE($2::date, fecha), fecha_suministro = $3::date, observaciones = $4
         WHERE id = $5 RETURNING *`,
        [folio || null, fecha || null, fecha_suministro || null, observaciones || null, reqId]
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
    await logRequisicionAudit(req, 'requisicion_editar', updated);
    res.json({ ...updated, items: computed, tiene_alertas: computed.some((c) => c.alerta_cantidad || c.alerta_precio) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// Edición selectiva de UN item de una requisición fuera de "borrador"
// (prompt-editar-requisicion-con-oc.md) — caso real: una requisición quedó
// ligada al insumo equivocado del catálogo (unidad incorrecta) después de
// ya tener OC generada, y el PUT de edición completa de arriba es
// borrador-only. orden_compra_items es un snapshot 100% independiente
// desde el momento en que se crea la OC (confirmado en diagnóstico previo:
// ningún cálculo derivado -- OC, pagos, Compromisos Abiertos, Erogado
// Real -- lee de requisicion_items), así que corregir aquí nunca puede
// tocarlos. Deliberadamente NO reusa el mecanismo de borrar-y-recrear del
// PUT de arriba -- ese SÍ rompería contra la FK de orden_compra_items
// (sin ON DELETE CASCADE) si hubiera OC generada; este hace UPDATE
// selectivo de una sola fila, nunca DELETE.
// admin/desarrollador-only (allow() sin roles extra): es corrección de un
// registro ya cerrado en el flujo normal, no una operación de captura.
// Bloqueado solo en 'borrador' (ese estado ya tiene su propio endpoint de
// edición completa arriba) -- el resto de estados (enviada/autorizada/
// rechazada/cancelada) no tienen ninguna razón adicional para bloquear esta
// corrección: solo 'autorizada' puede tener OC generada, y ya confirmamos
// que este endpoint nunca la toca.
app.put('/api/projects/:id/requisiciones/:reqId/items/:itemId', h(auth.allow()), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('requisiciones', 'puede_editar')), h(async (req, res) => {
  const pid = req.project.id;
  const reqId = Number(req.params.reqId);
  const itemId = Number(req.params.itemId);
  const { insumo_id, cantidad_solicitada, precio_solicitado, justificacion } = req.body || {};

  if (!justificacion || !justificacion.toString().trim()) {
    return res.status(400).json({ error: 'La justificación del cambio es obligatoria' });
  }

  const { rows: reqRows } = await db.pool.query(
    'SELECT * FROM requisiciones WHERE id = $1 AND project_id = $2',
    [reqId, pid]
  );
  if (!reqRows[0]) return res.status(404).json({ error: 'Requisición no encontrada' });
  if (reqRows[0].estado === 'borrador') {
    return res.status(400).json({ error: 'Esta requisición está en borrador — usa la edición normal, no esta corrección' });
  }

  const { rows: itemRows } = await db.pool.query(
    `SELECT ri.*, i.codigo, i.concepto, i.unidad
     FROM requisicion_items ri JOIN insumos i ON i.id = ri.insumo_id
     WHERE ri.id = $1 AND ri.requisicion_id = $2`,
    [itemId, reqId]
  );
  if (!itemRows[0]) return res.status(404).json({ error: 'El item no pertenece a esta requisición' });
  const antes = itemRows[0];

  const nuevoInsumoId = insumo_id != null ? Number(insumo_id) : antes.insumo_id;
  const nuevaCantidad = cantidad_solicitada != null ? Number(cantidad_solicitada) : Number(antes.cantidad_solicitada);
  const nuevoPrecio = precio_solicitado != null ? Number(precio_solicitado) : Number(antes.precio_solicitado);
  if (!Number.isFinite(nuevaCantidad) || nuevaCantidad < 0) {
    return res.status(400).json({ error: 'Cantidad inválida' });
  }
  if (!Number.isFinite(nuevoPrecio) || nuevoPrecio < 0) {
    return res.status(400).json({ error: 'Precio inválido' });
  }
  const { rows: insumoRows } = await db.pool.query(
    'SELECT id, codigo, concepto, unidad FROM insumos WHERE id = $1 AND project_id = $2',
    [nuevoInsumoId, pid]
  );
  if (!insumoRows[0]) return res.status(400).json({ error: 'El insumo indicado no existe en esta obra' });

  const nuevoImporte = Number((nuevaCantidad * nuevoPrecio).toFixed(2));

  const { rows: updatedRows } = await db.pool.query(
    `UPDATE requisicion_items SET insumo_id = $1, cantidad_solicitada = $2, precio_solicitado = $3, importe = $4
     WHERE id = $5 RETURNING *`,
    [nuevoInsumoId, nuevaCantidad, nuevoPrecio, nuevoImporte, itemId]
  );

  const detalle = `item #${itemId}: ${antes.codigo} "${antes.concepto}" (${antes.unidad}) cant=${antes.cantidad_solicitada} precio=${antes.precio_solicitado} importe=${antes.importe} -> ${insumoRows[0].codigo} "${insumoRows[0].concepto}" (${insumoRows[0].unidad}) cant=${nuevaCantidad} precio=${nuevoPrecio} importe=${nuevoImporte} | justificación: ${justificacion.toString().trim()}`;
  await logRequisicionAudit(req, 'requisicion_item_editar_post_oc', reqRows[0], detalle);

  res.json({
    ...updatedRows[0],
    insumo_codigo: insumoRows[0].codigo,
    insumo_concepto: insumoRows[0].concepto,
    unidad: insumoRows[0].unidad,
  });
}));

// 'autorizada'/'rechazada' quedan reservadas a admin — residente/cabo pueden
// llegar hasta 'enviada' (que dispara la notificación de autorización) o
// 'cancelada'/'borrador' igual que antes. No se degrada nada del flujo
// existente, solo se restringe quién puede poner el estado final.
app.put('/api/projects/:id/requisiciones/:reqId/estado', h(auth.allow('residente', 'cabo', 'compras', 'logistica')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('requisiciones', 'puede_editar')), h(async (req, res) => {
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
    'SELECT folio, usuario_id FROM requisiciones WHERE id = $1 AND project_id = $2', [reqId, req.project.id]
  );
  if (!reqRows[0]) return res.status(404).json({ error: 'Requisición no encontrada' });
  if (requisicionAjena(reqRows[0], req.user)) {
    return res.status(404).json({ error: 'Requisición no encontrada' });
  }

  await db.pool.query('UPDATE requisiciones SET estado = $1 WHERE id = $2', [estado, reqId]);
  await logRequisicionAudit(req, 'requisicion_estado', { id: reqId, folio: reqRows[0].folio }, `→ ${estado}`);

  if (estado === 'enviada' && req.user.puesto !== 'admin') {
    const folio = reqRows[0].folio || `Requisición #${reqId}`;
    await notificarAdmins(req.project.id, 'requisicion_pendiente', reqId, `${req.user.nombre} envió ${folio} para autorización`);
  }
  res.json({ ok: true });
}));

app.delete('/api/projects/:id/requisiciones/:reqId', h(auth.allow('residente', 'cabo', 'compras')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('requisiciones', 'puede_eliminar')), h(async (req, res) => {
  const reqId = Number(req.params.reqId);
  const { rows } = await db.pool.query(
    'SELECT estado, folio, usuario_id FROM requisiciones WHERE id = $1 AND project_id = $2', [reqId, req.project.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Requisición no encontrada' });
  if (requisicionAjena(rows[0], req.user)) {
    return res.status(404).json({ error: 'Requisición no encontrada' });
  }
  if (rows[0].estado !== 'borrador') {
    return res.status(400).json({ error: 'Solo se pueden eliminar requisiciones en estado "borrador"' });
  }
  await logRequisicionAudit(req, 'requisicion_eliminar', { id: reqId, folio: rows[0].folio });
  await db.pool.query('DELETE FROM requisiciones WHERE id = $1', [reqId]);
  res.json({ ok: true });
}));

app.post('/api/projects/:id/requisiciones/preview', h(auth.allow('residente', 'cabo', 'compras')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { items, ignore_requisicion_id } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items debe ser un arreglo' });
  // Mismo candado de precio que crear/editar — la preview debe reflejar
  // exactamente lo que se va a guardar.
  if (['residente', 'cabo'].includes(req.user.puesto)) {
    items.forEach((it) => { it.precio_solicitado = null; });
  }
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
// Programa de suministros (prompt-15-fecha-suministro-y-programa.md):
// consolida, cross-obra, todas las requisiciones cuya fecha_suministro cae
// en un rango — base del futuro módulo de Logística pendiente en backlog,
// SIN construir su calendario visual (solo tabla consolidada con filtros).
// IDOR: mismo criterio ya usado en getObrasDelClienteParaUsuario (PR91,
// materiales disponibles) — admin/desarrollador ven todas las obras, el
// resto solo las de usuario_proyectos, en silencio para el agregado sin
// filtro; si se pide un obra_id puntual sin acceso, 403 explícito (igual que
// cualquier endpoint de una sola obra).
// ---------------------------------------------------------------------------
const UMBRAL_RIESGO_SUMINISTRO_DIAS = 3;
const OC_ESTADOS_CONFIRMADA = ['confirmada', 'recibida_parcial', 'recibida_completa'];

async function getProgramaSuministrosData(req) {
  // prompt-URGENTE-fix-acceso-todos-presupuestos.md: mismo criterio que
  // getObrasDelClienteParaUsuario -- 'desarrollador' con usuario_proyectos
  // asignado se restringe igual que cualquier otro rol.
  const esAdmin = req.user.puesto === 'admin'
    || (req.user.puesto === 'desarrollador' && !(await db.usuarioTieneAsignacionExplicita(req.user.id)));
  const { desde: desdeQuery, hasta: hastaQuery, obra_id, cliente_id } = req.query;

  let desde = desdeQuery, hasta = hastaQuery;
  if (!desde || !hasta) {
    // Default: semana siguiente lunes-domingo, mismo criterio ya usado en
    // Asistencia/avances_semanales — calculado en SQL (date_trunc) para no
    // depender de la zona horaria del proceso Node.
    const { rows } = await db.pool.query(
      `SELECT (date_trunc('week', CURRENT_DATE) + INTERVAL '7 days')::date AS desde,
              (date_trunc('week', CURRENT_DATE) + INTERVAL '13 days')::date AS hasta`
    );
    desde = desde || rows[0].desde;
    hasta = hasta || rows[0].hasta;
  }
  if (desde > hasta) {
    const err = new Error('"desde" no puede ser posterior a "hasta"');
    err.status = 400;
    throw err;
  }

  if (obra_id && !esAdmin) {
    const { rows } = await db.pool.query(
      'SELECT 1 FROM usuario_proyectos WHERE usuario_id = $1 AND project_id = $2',
      [req.user.id, Number(obra_id)]
    );
    if (!rows.length) {
      const err = new Error('No tienes acceso a esta obra');
      err.status = 403;
      throw err;
    }
  }

  const params = [desde, hasta];
  let join = '';
  if (!esAdmin) {
    params.push(req.user.id);
    join = `JOIN usuario_proyectos up ON up.project_id = p.id AND up.usuario_id = $${params.length}`;
  }
  let where = '';
  if (obra_id) { params.push(Number(obra_id)); where += ` AND p.id = $${params.length}`; }
  if (cliente_id) { params.push(Number(cliente_id)); where += ` AND p.cliente_id = $${params.length}`; }

  const { rows } = await db.pool.query(`
    SELECT p.id AS obra_id, p.nombre AS obra_nombre, p.cliente_id,
           r.id AS requisicion_id, r.folio, r.fecha_suministro, r.estado AS requisicion_estado,
           ri.cantidad_solicitada, i.codigo AS insumo_codigo, i.concepto AS insumo_concepto, i.unidad,
           oc_agg.oc_estados
    FROM requisiciones r
    JOIN proyectos p ON p.id = r.project_id
    JOIN requisicion_items ri ON ri.requisicion_id = r.id
    JOIN insumos i ON i.id = ri.insumo_id
    LEFT JOIN LATERAL (
      SELECT array_agg(oc.estado) AS oc_estados FROM ordenes_compra oc WHERE oc.requisicion_id = r.id
    ) oc_agg ON true
    ${join}
    WHERE r.fecha_suministro BETWEEN $1 AND $2 ${where}
    ORDER BY p.nombre, r.fecha_suministro, r.id, ri.id
  `, params);

  const { rows: hoyRows } = await db.pool.query('SELECT CURRENT_DATE::text AS hoy');
  const hoy = hoyRows[0].hoy;

  const obrasMap = new Map();
  for (const row of rows) {
    if (!obrasMap.has(row.obra_id)) {
      obrasMap.set(row.obra_id, { obra_id: row.obra_id, obra_nombre: row.obra_nombre, cliente_id: row.cliente_id, fechasMap: new Map() });
    }
    const obra = obrasMap.get(row.obra_id);
    if (!obra.fechasMap.has(row.fecha_suministro)) obra.fechasMap.set(row.fecha_suministro, []);
    const ocConfirmada = (row.oc_estados || []).some((e) => OC_ESTADOS_CONFIRMADA.includes(e));
    const diasParaSuministro = Math.round((new Date(row.fecha_suministro) - new Date(hoy)) / 86400000);
    const enRiesgo = diasParaSuministro <= UMBRAL_RIESGO_SUMINISTRO_DIAS && (row.requisicion_estado !== 'autorizada' || !ocConfirmada);
    obra.fechasMap.get(row.fecha_suministro).push({
      requisicion_id: row.requisicion_id,
      folio: row.folio || `Requisición #${row.requisicion_id}`,
      requisicion_estado: row.requisicion_estado,
      insumo_codigo: row.insumo_codigo,
      insumo_concepto: row.insumo_concepto,
      unidad: row.unidad,
      cantidad_solicitada: row.cantidad_solicitada,
      oc_confirmada: ocConfirmada,
      en_riesgo: enRiesgo,
    });
  }
  const obras = [...obrasMap.values()].map((o) => ({
    obra_id: o.obra_id,
    obra_nombre: o.obra_nombre,
    cliente_id: o.cliente_id,
    fechas: [...o.fechasMap.entries()].map(([fecha_suministro, items]) => ({ fecha_suministro, items })),
  }));

  return { desde, hasta, umbral_riesgo_dias: UMBRAL_RIESGO_SUMINISTRO_DIAS, obras };
}

app.get('/api/requisiciones/programa', h(auth.allow('residente', 'cabo', 'compras', 'logistica')), h(auth.checkPermiso('requisiciones', 'puede_ver')), h(async (req, res) => {
  try {
    res.json(await getProgramaSuministrosData(req));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}));

app.get('/api/requisiciones/programa/export', h(auth.allow('residente', 'cabo', 'compras', 'logistica')), h(auth.checkPermiso('requisiciones', 'puede_ver')), h(async (req, res) => {
  let data;
  try {
    data = await getProgramaSuministrosData(req);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  const rows = [];
  for (const obra of data.obras) {
    for (const f of obra.fechas) {
      for (const it of f.items) {
        rows.push({
          obra: obra.obra_nombre,
          fecha_suministro: f.fecha_suministro,
          folio: it.folio,
          insumo_codigo: it.insumo_codigo,
          insumo_concepto: it.insumo_concepto,
          unidad: it.unidad || '',
          cantidad_solicitada: Number(it.cantidad_solicitada),
          requisicion_estado: it.requisicion_estado,
          oc_confirmada: it.oc_confirmada ? 'Sí' : 'No',
          en_riesgo: it.en_riesgo ? 'Sí' : 'No',
        });
      }
    }
  }
  await sendXlsxExport(res, {
    filename: `Programa-Suministros_${data.desde}_a_${data.hasta}.xlsx`,
    sheets: [{
      sheetName: 'Programa',
      columns: [
        { header: 'Obra', key: 'obra', width: 26 },
        { header: 'Fecha de suministro', key: 'fecha_suministro', width: 18 },
        { header: 'Folio', key: 'folio', width: 18 },
        { header: 'Código', key: 'insumo_codigo', width: 14 },
        { header: 'Insumo', key: 'insumo_concepto', width: 34 },
        { header: 'Unidad', key: 'unidad', width: 10 },
        { header: 'Cantidad solicitada', key: 'cantidad_solicitada', width: 18 },
        { header: 'Estado requisición', key: 'requisicion_estado', width: 18 },
        { header: 'OC confirmada', key: 'oc_confirmada', width: 14 },
        { header: 'En riesgo', key: 'en_riesgo', width: 12 },
      ],
      rows,
    }],
  });
}));

// Historial de qué hicieron residente/cabo sobre las requisiciones de esta
// obra (crear/editar/cambiar estado/eliminar) — pedido explícito de control
// administrativo. Solo administracion/admin/desarrollador, no residente/cabo
// (no tiene sentido que vean el registro de vigilancia sobre ellos mismos) ni
// compras/logistica (ellos ya ven todas las requisiciones sin restricción).
app.get('/api/projects/:id/requisiciones-historial', h(auth.allow('administracion')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { rows } = await db.pool.query(`
    SELECT al.id, al.accion, al.target_id, al.target_usuario, al.creado_en,
           al.actor_id, COALESCE(u.nombre, al.actor_usuario) AS actor_nombre
    FROM audit_log al
    LEFT JOIN usuarios u ON u.id = al.actor_id
    WHERE al.project_id = $1 AND al.accion LIKE 'requisicion_%'
    ORDER BY al.creado_en DESC
    LIMIT 300
  `, [req.project.id]);
  res.json(rows);
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
    // prompt-fix-saldo-iva-5-lugares.md: mismo fix que saldoDeOrden — items
    // con iva_tasa en vez de SUM crudo, para que "Saldo pendiente" en esta
    // lista/export use totalConIvaDeItems() (respeta o.incluye_iva) en vez
    // de asumir que orden_compra_items.importe ya es el total pagable.
    const { rows: itemRows } = await db.pool.query(`
      SELECT oci.importe, i.iva_tasa
      FROM orden_compra_items oci
      JOIN requisicion_items ri ON ri.id = oci.requisicion_item_id
      JOIN insumos i ON i.id = ri.insumo_id
      WHERE oci.orden_compra_id = $1
    `, [o.id]);
    const { rows: pagoRows } = await db.pool.query(
      'SELECT COALESCE(SUM(monto), 0) AS total_pagado FROM pagos WHERE orden_compra_id = $1', [o.id]
    );
    const importeTotal = totalConIvaDeItems(itemRows, o.incluye_iva);
    const totalPagado = Number(pagoRows[0].total_pagado);
    return {
      ...o,
      num_items: itemRows.length,
      importe_total: importeTotal,
      total_pagado: Number(totalPagado.toFixed(2)),
      saldo_pendiente: Number((importeTotal - totalPagado).toFixed(2)),
    };
  }));
}

app.get('/api/projects/:id/ordenes', h(auth.allow('residente', 'cabo', 'compras', 'tesoreria', 'administracion', 'logistica')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('ordenes_compra', 'puede_ver')), h(async (req, res) => {
  res.json(await getOrdenesData(req.project.id));
}));

app.get('/api/projects/:id/ordenes/export', h(auth.allow('residente', 'cabo', 'compras', 'tesoreria', 'administracion', 'logistica')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('ordenes_compra', 'puede_ver')), h(async (req, res) => {
  const { rows: rlOrdenes } = await db.pool.query(
    `SELECT COUNT(*)::int AS n FROM api_rate_limits
     WHERE usuario_id = $1 AND endpoint = 'export_ordenes'
       AND creado_en > NOW() - INTERVAL '1 hour'`,
    [req.user.id]
  );
  if (rlOrdenes[0].n >= EXPORT_RATE_LIMIT) {
    return res.status(429).json({ error: `Límite de exports alcanzado (${EXPORT_RATE_LIMIT} por hora). Intenta más tarde.` });
  }
  await db.pool.query('INSERT INTO api_rate_limits (usuario_id, endpoint) VALUES ($1, $2)', [req.user.id, 'export_ordenes']);
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

app.get('/api/projects/:id/ordenes/:ocId', h(auth.allow('residente', 'cabo', 'compras', 'tesoreria', 'administracion', 'logistica')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('ordenes_compra', 'puede_ver')), h(async (req, res) => {
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

app.post('/api/projects/:id/requisiciones/:reqId/ordenes', h(auth.allow('compras')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('ordenes_compra', 'puede_crear')), h(async (req, res) => {
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
app.put('/api/projects/:id/ordenes/:ocId/estado', h(auth.allow('compras', 'tesoreria')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('ordenes_compra', 'puede_editar')), h(async (req, res) => {
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

app.delete('/api/projects/:id/ordenes/:ocId', h(auth.allow('compras')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('ordenes_compra', 'puede_eliminar')), h(async (req, res) => {
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
// prompt-fix-saldo-iva-5-lugares.md: importeTotal ahora usa
// totalConIvaDeItems() (server/calculos.js) en vez de sumar
// orden_compra_items.importe crudo — ese importe solo es el total real
// cuando incluye_iva=true; para incluye_iva=false es subtotal, y
// compararlo tal cual contra pagos.monto (que siempre incluye IVA, es lo
// realmente transferido) producía saldo_pendiente negativo pese a estar
// correctamente pagado.
async function saldoDeOrden(ocId) {
  const { rows: ocRows } = await db.pool.query(
    'SELECT incluye_iva FROM ordenes_compra WHERE id = $1', [ocId]
  );
  const incluyeIva = ocRows[0] ? ocRows[0].incluye_iva : true;
  const { rows: itemRows } = await db.pool.query(`
    SELECT oci.importe, i.iva_tasa
    FROM orden_compra_items oci
    JOIN requisicion_items ri ON ri.id = oci.requisicion_item_id
    JOIN insumos i ON i.id = ri.insumo_id
    WHERE oci.orden_compra_id = $1
  `, [ocId]);
  const { rows: pagoRows } = await db.pool.query(
    'SELECT COALESCE(SUM(monto), 0) AS total_pagado FROM pagos WHERE orden_compra_id = $1', [ocId]
  );
  const importeTotal = totalConIvaDeItems(itemRows, incluyeIva);
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

app.get('/api/projects/:id/finanzas/resumen', h(auth.allow('tesoreria')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('finanzas', 'puede_ver')), h(async (req, res) => {
  res.json(await getFinanzasResumenData(req.project.id));
}));

// Compromisos Abiertos (prompt-compromisos-abiertos.md): desglose por
// categoría/proveedor del "comprometido no pagado" — mismo permiso que el
// resto de Finanzas ('finanzas'/'puede_ver'), sin sección nueva en el
// catálogo de permisos granulares.
app.get('/api/projects/:id/finanzas/compromisos-abiertos', h(auth.allow('tesoreria')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('finanzas', 'puede_ver')), h(async (req, res) => {
  res.json(await getCompromisosAbiertosData(req.project.id));
}));

// Fondo de Garantía acumulado (prompt-fondo-garantia-editable.md): % pactado
// + SUM de fondo_garantia_monto de estimaciones aprobadas + histórico por
// estimación — mismo permiso que el resto de Tesorería/Finanzas
// ('finanzas'/'puede_ver'), mismo patrón que Compromisos Abiertos arriba
// (sin sección nueva en el catálogo de permisos granulares).
// 'costos' agregado (prompt-costos-editar-fondo-garantia.md) — sin este rol
// aquí, checkPermiso('finanzas','puede_ver') nunca se evaluaba porque
// auth.allow() ya cortaba con 403 antes de llegar ahí, mismo patrón que el
// PUT de abajo.
app.get('/api/projects/:id/finanzas/fondo-garantia', h(auth.allow('tesoreria', 'costos')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('finanzas', 'puede_ver')), h(async (req, res) => {
  res.json(await getFondoGarantiaData(req.project.id));
}));

// Edición del % de Fondo de Garantía directamente desde el panel de
// Tesorería (prompt-fondo-garantia-editable-panel.md) — antes solo
// editable desde Contrato (admin/desarrollador-only). auth.allow('tesoreria')
// ya deja pasar admin/desarrollador/tesoreria (ver auth.allow), y
// checkPermiso('finanzas', 'puede_editar') es el enforcement real nuevo
// (agregado a ACCIONES_CON_ENFORCEMENT en public/app.js) — antes 'finanzas'
// solo enforced 'puede_ver'. verificarAccesoObra seguirá restringiendo
// tesorería a solo las obras que tenga asignadas en usuario_proyectos, igual
// que cualquier otro endpoint por-obra.
// 'costos' agregado (prompt-costos-editar-fondo-garantia.md) — Paul ya le
// había dado puede_editar=true en 'finanzas' desde la matriz, pero este
// auth.allow() hardcodeado a 'tesoreria' lo ignoraba y devolvía 403 sin
// importar la fila de permisos_usuario.
app.put('/api/projects/:id/fondo-garantia', h(auth.allow('tesoreria', 'costos')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('finanzas', 'puede_editar')), h(async (req, res) => {
  const pct = await upsertPorcentajeFondoGarantia(db.pool, req.project.id, (req.body || {}).porcentaje);
  res.json({ porcentaje_pactado: pct, obras: [{ id: req.project.id, nombre: req.project.nombre }] });
}));

// Mismo cambio de % pero aplicado a TODAS las obras del cliente de una vez
// (prompt-fondo-garantia-editable-panel.md) — alcance ampliado a pedido
// explícito, no algo que el usuario pueda alcanzar "sin querer": el frontend
// exige elegir este alcance a propósito en el modal de confirmación. Para
// admin/desarrollador son todas las obras del cliente; para tesorería, solo
// las obras del cliente a las que además tiene acceso vía usuario_proyectos
// (mismo criterio que /api/clientes/:id/resumen-agregado) — "todas las
// obras del cliente" nunca debe tocar una obra que el usuario ni siquiera
// puede ver. Transacción única: si una obra falla la validación de rango,
// ninguna se actualiza (mismo criterio "todo o nada" que contrato-confirm).
// 'costos' agregado (prompt-costos-editar-fondo-garantia.md) — mismo fix que
// el PUT por-obra de arriba; isAdminUser más abajo sigue evaluando solo
// admin/desarrollador, así que costos cae en la rama de query filtrada por
// usuario_proyectos, igual que tesorería.
app.put('/api/clientes/:id/fondo-garantia', h(auth.allow('tesoreria', 'costos')), h(async (req, res) => {
  const clienteId = Number(req.params.id);
  if (!Number.isFinite(clienteId)) return res.status(400).json({ error: 'ID de cliente inválido' });
  const { rows: clienteRows } = await db.pool.query('SELECT id, nombre FROM clientes WHERE id = $1', [clienteId]);
  if (!clienteRows[0]) return res.status(404).json({ error: 'Cliente no encontrado' });

  // prompt-URGENTE-fix-acceso-todos-presupuestos.md: 'desarrollador' con
  // usuario_proyectos asignado se restringe igual que tesorería/costos --
  // antes de este fix podía escribir fondo_garantia en obras de cualquier
  // cliente aunque tuviera asignación explícita limitada.
  const isAdminUser = req.user.puesto === 'admin'
    || (req.user.puesto === 'desarrollador' && !(await db.usuarioTieneAsignacionExplicita(req.user.id)));
  const proyQuery = isAdminUser
    ? `SELECT id, nombre FROM proyectos WHERE cliente_id = $1 ORDER BY id`
    : `SELECT p.id, p.nombre FROM proyectos p
       JOIN usuario_proyectos up ON up.project_id = p.id AND up.usuario_id = $2
       WHERE p.cliente_id = $1 ORDER BY p.id`;
  const { rows: obras } = await db.pool.query(proyQuery, isAdminUser ? [clienteId] : [clienteId, req.user.id]);
  if (!obras.length) return res.status(400).json({ error: 'No hay obras de este cliente a las que tengas acceso' });

  const pctInput = (req.body || {}).porcentaje;
  let pct;
  await db.withTransaction(async (client) => {
    for (const obra of obras) {
      pct = await upsertPorcentajeFondoGarantia(client, obra.id, pctInput);
    }
  });
  res.json({ porcentaje_pactado: pct, obras });
}));

// /export reutiliza el mismo permiso 'puede_ver' que /resumen — es la misma
// data agregada en formato Excel, no una acción distinta (mismo criterio que
// export en Presupuestos/Proveedores).
app.get('/api/projects/:id/finanzas/export', h(auth.allow('tesoreria')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('finanzas', 'puede_ver')), h(async (req, res) => {
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
    { concepto: 'Destajo — huérfano, sin trabajador vinculado (ya incluido arriba)', valor: er.destajo_huerfano },
    { concepto: 'Jornal — nómina aprobada', valor: er.jornal_aprobado },
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
// Estado de Resultados — prompt-estado-resultados-tesoreria.md, migrado a
// whitelist en prompt-36-control-financiero-fase3-4.md (punto 3): antes
// auth.allow('tesoreria') (con bypass automático de admin/desarrollador,
// exponiendo margen/facturación real a cualquier cuenta con esos puestos —
// 0 usuarios reales con puesto 'tesoreria' en Producción, confirmado antes
// del cambio). Mismo patrón whitelist que Control de Cuentas/Control
// Financiero (auth.requireEstadoResultadosAccess).
// Facturación/Cobranza ligada a la obra (project_id) + Egresos reutilizando
// Erogado Real de Finanzas (server/finanzas.js) = Margen Bruto.
// ---------------------------------------------------------------------------
app.get('/api/projects/:id/facturas', h(auth.requireEstadoResultadosAccess), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  res.json(await estadoResultados.listFacturas(req.project.id));
}));

app.post('/api/projects/:id/facturas', h(auth.requireEstadoResultadosAccess), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { folio, concepto, fecha_emision, monto_subtotal, iva, monto_total } = req.body || {};
  const subtotalNum = Number(monto_subtotal);
  const ivaNum = Number(iva ?? 0);
  const totalNum = Number(monto_total);
  if (!concepto?.trim()) return res.status(400).json({ error: 'El concepto es requerido' });
  if (!Number.isFinite(subtotalNum) || subtotalNum <= 0) return res.status(400).json({ error: 'El subtotal debe ser mayor a 0' });
  if (!Number.isFinite(totalNum) || totalNum <= 0) return res.status(400).json({ error: 'El monto total debe ser mayor a 0' });
  if (Math.abs((subtotalNum + ivaNum) - totalNum) > 0.01) {
    return res.status(400).json({ error: 'monto_subtotal + iva debe ser igual a monto_total' });
  }
  const factura = await estadoResultados.createFactura({
    project_id: req.project.id, folio: folio?.trim(), concepto: concepto.trim(), fecha_emision,
    monto_subtotal: subtotalNum, iva: ivaNum, monto_total: totalNum, creado_por: req.user.id,
  });
  res.status(201).json(factura);
}));

app.put('/api/projects/:id/facturas/:facturaId', h(auth.requireEstadoResultadosAccess), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { folio, concepto, fecha_emision, monto_subtotal, iva, monto_total } = req.body || {};
  const subtotalNum = monto_subtotal != null ? Number(monto_subtotal) : null;
  const ivaNum = iva != null ? Number(iva) : null;
  const totalNum = monto_total != null ? Number(monto_total) : null;
  const factura = await estadoResultados.updateFactura(Number(req.params.facturaId), {
    folio, concepto, fecha_emision, monto_subtotal: subtotalNum, iva: ivaNum, monto_total: totalNum,
  });
  if (!factura) return res.status(404).json({ error: 'Factura no encontrada' });
  res.json(factura);
}));

app.delete('/api/projects/:id/facturas/:facturaId', h(auth.requireEstadoResultadosAccess), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const factura = await estadoResultados.cancelarFactura(Number(req.params.facturaId));
  if (!factura) return res.status(404).json({ error: 'Factura no encontrada' });
  res.json(factura);
}));

app.get('/api/projects/:id/facturas/:facturaId/cobros', h(auth.requireEstadoResultadosAccess), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  res.json(await estadoResultados.listCobros(Number(req.params.facturaId)));
}));

app.post('/api/projects/:id/facturas/:facturaId/cobros', h(auth.requireEstadoResultadosAccess), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { fecha_cobro, monto_cobrado, forma_pago } = req.body || {};
  const montoNum = Number(monto_cobrado);
  if (!Number.isFinite(montoNum) || montoNum <= 0) return res.status(400).json({ error: 'El monto cobrado debe ser mayor a 0' });
  const resultado = await estadoResultados.registrarCobro({
    factura_id: Number(req.params.facturaId), fecha_cobro, monto_cobrado: montoNum,
    forma_pago: forma_pago?.trim(), creado_por: req.user.id,
  });
  res.status(201).json(resultado);
}));

app.get('/api/projects/:id/estado-resultados', h(auth.requireEstadoResultadosAccess), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { desde, hasta } = req.query;
  res.json(await estadoResultados.getEstadoResultadosPorObra(req.project.id, { desde, hasta }));
}));

app.get('/api/estado-resultados/consolidado', h(auth.requireEstadoResultadosAccess), h(async (req, res) => {
  const { desde, hasta } = req.query;
  res.json(await estadoResultados.getEstadoResultadosConsolidado(req.user, { desde, hasta }));
}));

// ---------------------------------------------------------------------------
// Programa de ejecución
// ---------------------------------------------------------------------------
// 'costos' agregado al GET (prompt-seccion-costos-implementacion.md): no
// estaba en la lista — costos ganó acceso a Programa como parte de la nueva
// sección "Costos" (Target State punto 4), así que necesita también poder
// VER, no solo editar (paso 2 más abajo, PUT).
app.get('/api/projects/:id/programa', h(auth.allow('residente', 'cabo', 'compras', 'tesoreria', 'administracion', 'logistica', 'costos')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
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

// 'residente'/'costos' agregados (prompt-seccion-costos-implementacion.md,
// fix de bug preexistente confirmado en prompt-diagnostico-seccion-costos-
// nueva.md): auth.allow() sin argumentos dejaba pasar solo admin/desarrollador,
// pero el frontend (renderPrograma, public/app.js) pinta el botón "✏️ Editar
// fechas" para cualquiera que vea Programa sin condicionarlo — residente veía
// el botón y recibía 403 real al guardar, sin relación con este cambio. El
// GET de arriba ya incluía a los roles operativos correctos, este PUT se
// quedó atrás. Solo se agregan los 2 roles confirmados con Paul — el resto
// (cabo/compras/tesoreria/administracion/logistica, que sí ven Programa vía
// el GET) se queda sin editar, a propósito.
app.put('/api/projects/:id/programa/:itemId', h(auth.allow('residente', 'costos')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
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

app.get('/api/projects/:id/avances', h(auth.allow('residente', 'cabo', 'logistica')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('avance', 'puede_ver')), h(async (req, res) => {
  res.json(await getAvancesData(req.project.id));
}));

app.get('/api/projects/:id/avances/export', h(auth.allow('residente', 'cabo', 'logistica')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('avance', 'puede_ver')), h(async (req, res) => {
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

// Avance-requiere-entrega: un concepto solo bloquea el reporte de avance si
// tiene insumos mapeados en concepto_insumos (mapeo admin-curado, opt-in —
// conceptos sin mapeo no se ven afectados) Y falta que llegue AL MENOS uno
// de ellos a obra (decisión confirmada con Paul: "todos entregados", no
// "basta con uno"). "Entregado" = alguna cantidad_recibida > 0 registrada en
// recepcion_items para ese insumo, sin importar si la OC quedó completa o
// parcial — se reusa el flujo de recepciones ya existente (rol "compras"),
// no se agrega ningún campo/estado nuevo.
// Devuelve Map<concepto_id, [{insumo_id, insumo_nombre}]> — solo incluye
// conceptos que SÍ están bloqueados (con al menos un insumo pendiente).
async function insumosPendientesPorConcepto(pid, conceptoIds) {
  if (!conceptoIds.length) return new Map();
  const { rows } = await db.pool.query(`
    SELECT ci.concepto_id, i.id AS insumo_id, i.concepto AS insumo_nombre,
           COALESCE(SUM(ri.cantidad_recibida), 0) AS total_recibido
    FROM concepto_insumos ci
    JOIN insumos i ON i.id = ci.insumo_id AND i.project_id = $1
    LEFT JOIN requisicion_items reqi ON reqi.insumo_id = i.id
    LEFT JOIN requisiciones req ON req.id = reqi.requisicion_id AND req.project_id = $1
    LEFT JOIN orden_compra_items oci ON oci.requisicion_item_id = reqi.id
    LEFT JOIN ordenes_compra oc ON oc.id = oci.orden_compra_id AND oc.project_id = $1
    LEFT JOIN recepcion_items ri ON ri.orden_compra_item_id = oci.id
    WHERE ci.concepto_id = ANY($2)
    GROUP BY ci.concepto_id, i.id, i.concepto
  `, [pid, conceptoIds]);
  const pendientes = new Map();
  for (const r of rows) {
    if (Number(r.total_recibido) > 0) continue; // este insumo ya llegó, no bloquea
    if (!pendientes.has(r.concepto_id)) pendientes.set(r.concepto_id, []);
    pendientes.get(r.concepto_id).push({ insumo_id: r.insumo_id, insumo_nombre: r.insumo_nombre });
  }
  return pendientes;
}

app.put('/api/projects/:id/avances/:semana', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('avance', 'puede_crear')), h(async (req, res) => {
  const pid = req.project.id;
  const semana = Number(req.params.semana);
  const { rows: existRows } = await db.pool.query(
    'SELECT id, estado_autorizacion, avance_fisico_real, avance_financiero_real FROM avances_semanales WHERE project_id = $1 AND semana = $2',
    [pid, semana]
  );
  if (!existRows[0]) return res.status(404).json({ error: 'Semana no encontrada' });

  const clamp = (v) => (v == null || v === '' ? null : Math.max(0, Math.min(100, Number(v))));
  const body = req.body || {};
  // NULL está sobrecargado: distinguir "llave no enviada" (no tocar la
  // columna) de "llave enviada en null/''" (limpiar la columna) — antes el
  // COALESCE de abajo trataba ambos casos igual y silenciosamente ignoraba
  // el intento de limpiar un campo.
  const fisicoPresente = Object.prototype.hasOwnProperty.call(body, 'avance_fisico_real');
  const financieroPresente = Object.prototype.hasOwnProperty.call(body, 'avance_financiero_real');
  const nuevoFisico = fisicoPresente ? clamp(body.avance_fisico_real) : undefined;
  const nuevoFinanciero = financieroPresente ? clamp(body.avance_financiero_real) : undefined;

  // Cierra el mismo gate de avance-requiere-entrega para este editor directo
  // por % — sin granularidad de concepto, así que no puede validarse
  // actividad por actividad. En vez de eso: si CUALQUIER concepto de la obra
  // tiene insumos mapeados pendientes de entrega, se rechaza cualquier
  // INTENTO DE AUMENTAR el % (bajar o dejar igual sigue permitido). Sin esto,
  // el flujo detallado por concepto se podía saltar completo escribiendo el
  // % agregado aquí directamente.
  const { rows: conceptoRows } = await db.pool.query(
    'SELECT id FROM conceptos WHERE project_id = $1 AND es_total = 0 AND activo = 1', [pid]
  );
  const pendientesProyecto = await insumosPendientesPorConcepto(pid, conceptoRows.map((c) => c.id));
  if (pendientesProyecto.size > 0) {
    const previoFisico = Number(existRows[0].avance_fisico_real) || 0;
    const previoFinanciero = Number(existRows[0].avance_financiero_real) || 0;
    const intentaAumentar = (nuevoFisico != null && nuevoFisico > previoFisico)
      || (nuevoFinanciero != null && nuevoFinanciero > previoFinanciero);
    if (intentaAumentar) {
      auth.logDenied(req, `intento de aumentar % de avance directo con insumos pendientes de entrega (semana ${semana})`);
      return res.status(409).json({
        error: 'No se puede aumentar el avance: hay actividades con insumos pendientes de entrega en obra. Usa el detalle por concepto para ver cuáles y repórtalas ahí una vez que lleguen.',
      });
    }
  }

  const { nuevoEstado, notificar } = calcularEstadoAutorizacion(existRows[0].estado_autorizacion, req.user.puesto === 'admin');
  const setClauses = ['estado_autorizacion = $1'];
  const params = [nuevoEstado];
  if (fisicoPresente) {
    params.push(nuevoFisico);
    setClauses.push(`avance_fisico_real = $${params.length}`);
  }
  if (financieroPresente) {
    params.push(nuevoFinanciero);
    setClauses.push(`avance_financiero_real = $${params.length}`);
  }
  params.push(pid, semana);
  const { rows } = await db.pool.query(`
    UPDATE avances_semanales
    SET ${setClauses.join(', ')}
    WHERE project_id = $${params.length - 1} AND semana = $${params.length}
    RETURNING *
  `, params);

  if (notificar) {
    await notificarAdmins(pid, 'avance_pendiente', semana, `${req.user.nombre} reportó avance real de la semana ${semana} para autorización`);
  }
  res.json(rows[0]);
}));

// Resetea el avance real de una semana (porcentajes + cantidades por
// concepto) para permitir recapturarla desde cero. Endpoint dedicado en vez
// de reutilizar el PUT: limpiar es una acción destructiva-pero-recuperable
// distinta de "actualizar un valor", y necesita tocar avance_conceptos
// además de avances_semanales en una sola transacción.
app.post('/api/projects/:id/avances/:semana/limpiar', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('avance', 'puede_crear')), h(async (req, res) => {
  const pid = req.project.id;
  const semana = Number(req.params.semana);
  const { rows: existRows } = await db.pool.query(
    'SELECT id, estado_autorizacion FROM avances_semanales WHERE project_id = $1 AND semana = $2',
    [pid, semana]
  );
  if (!existRows[0]) return res.status(404).json({ error: 'Semana no encontrada' });

  const { nuevoEstado, notificar } = calcularEstadoAutorizacion(existRows[0].estado_autorizacion, req.user.puesto === 'admin');

  await db.withTransaction(async (client) => {
    await client.query(
      'UPDATE avances_semanales SET avance_fisico_real = NULL, avance_financiero_real = NULL, estado_autorizacion = $1 WHERE project_id = $2 AND semana = $3',
      [nuevoEstado, pid, semana]
    );
    // Cantidades a 0, NUNCA DELETE — regla dura del proyecto: sin borrado
    // físico de registros financieros. avance_conceptos no tiene project_id
    // propio y `semana` no es única entre obras, así que se filtra por el
    // project_id del concepto relacionado.
    await client.query(`
      UPDATE avance_conceptos ac
      SET cantidad_ejecutada = 0, actualizado_en = NOW()
      FROM conceptos c
      WHERE ac.concepto_id = c.id AND c.project_id = $1 AND ac.semana = $2
    `, [pid, semana]);
  });

  if (notificar) {
    await notificarAdmins(pid, 'avance_pendiente', semana, `${req.user.nombre} limpió el avance real de la semana ${semana} para recapturarlo`);
  }

  const { rows } = await db.pool.query('SELECT * FROM avances_semanales WHERE project_id = $1 AND semana = $2', [pid, semana]);
  res.json(rows[0]);
}));

// prompt-25-auditoria-permisos-completa.md: SIN checkPermiso a propósito, no
// es un gap — decisión explícita de Paul. Autorizar es la última palabra
// sobre si el avance capturado por el equipo se acepta; eso no se delega vía
// permisos_usuario, se queda admin/desarrollador-only por auth.allow() vacío.
// No confundir con las demás acciones de 'avance' (ver/crear), que sí tienen
// checkPermiso real — ver ACCIONES_CON_ENFORCEMENT en public/app.js.
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

app.get('/api/projects/:id/avances/:semana/conceptos', h(auth.allow('residente', 'cabo', 'logistica')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('avance', 'puede_ver')), h(async (req, res) => {
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
    WHERE project_id = $1 AND es_total = 0 AND activo = 1 AND cantidad > 0 AND TRIM(COALESCE(unidad, '')) <> ''
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
  const pendientesPorConcepto = await insumosPendientesPorConcepto(pid, conceptos.map((c) => c.concepto_id));

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
      insumos_pendientes: pendientesPorConcepto.get(c.concepto_id) || [],
    };
  });
  res.json({ semana, items });
}));

app.put('/api/projects/:id/avances/:semana/conceptos', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('avance', 'puede_crear')), h(async (req, res) => {
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

  // Avance-requiere-entrega: solo bloquea conceptos con insumos mapeados
  // (concepto_insumos) y algún insumo aún sin llegar a obra — decisión
  // confirmada: "todos entregados", no basta con uno. Reducir cantidad a 0
  // (quitar un avance mal capturado) nunca se bloquea, solo reportar > 0.
  const pendientesPorConcepto = await insumosPendientesPorConcepto(pid, conceptoIds);
  const omitidos = [];

  await db.withTransaction(async (client) => {
    for (const it of items) {
      const conceptoId = Number(it.concepto_id);
      if (!conceptoId) continue;
      const cantidad = it.cantidad_ejecutada == null || it.cantidad_ejecutada === ''
        ? 0 : Math.max(0, Number(it.cantidad_ejecutada));
      if (cantidad > 0 && pendientesPorConcepto.has(conceptoId)) {
        omitidos.push({ concepto_id: conceptoId, insumos_pendientes: pendientesPorConcepto.get(conceptoId) });
        auth.logDenied(req, `avance omitido en concepto ${conceptoId}: insumos pendientes de entrega`);
        continue;
      }
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
  res.json({ ok: true, semana, avance_calculado_pct: pctReal, avance: avRows[0], items: detalle, omitidos });
}));

// ---------------------------------------------------------------------------
// Infraestructura vs. Vivienda (prompt-fase2-infraestructura-implementacion.md,
// diagnóstico previo en prompt-diagnostico-fase2-infraestructura.md) — Fase 2
// del roadmap "Desarrollador de Vivienda": tabla de mapeo admin-curada
// grupo→categoría (conceptos_grupo_categoria, server/db.js) + KPIs de avance
// físico/financiero de infraestructura vs. vivienda lado a lado, reusando el
// motor de avance ya existente (avance_conceptos, misma fórmula que ya usa
// PUT /avances/:semana/conceptos más arriba: SUM(cantidad_ejecutada ×
// precio_unitario) — ver esa misma fórmula unas líneas arriba, donde
// avance_fisico_real y avance_financiero_real se setean AL MISMO valor
// pctReal, confirmando que "físico" y "financiero" son el mismo % ponderado
// por presupuesto en este modelo de datos; no hay un "avance físico" propio
// por concepto/grupo distinto de ese ponderado financiero — nada que inventar
// aquí). NO se toca avances_semanales/avance_conceptos ni la fórmula en sí
// (Forbidden Action explícita) — solo se agrega/filtra su resultado ya
// calculado, por categoría en vez de por concepto individual. Mismo
// checkPermiso('avance', ...) que los endpoints hermanos de arriba — sin
// sección de permiso nueva, reusa 'avance' tal cual.
// Grupos sin clasificar NUNCA se omiten del total ni se asumen en una
// categoría por default (Forbidden Action explícita) — quedan agregados
// aparte como 'sin_clasificar', con la lista de grupos pendientes expuesta
// para que la UI pueda avisar que el % no está completo hasta clasificarlos
// todos.
// ---------------------------------------------------------------------------
// 'cabo' EXCLUIDO A PROPÓSITO de los 3 auth.allow() de abajo (GET/POST
// grupos-categoria, GET avance-por-categoria) — confirmado por el negocio
// (QA, commit 2b29100): cabo no debe tener acceso a Infraestructura vs.
// Vivienda por ninguna vía. Sí conserva 'cabo' en checkPermiso('avance', ...)
// y en los endpoints hermanos de Avance (/avances, /avances/:semana/
// conceptos, etc.) — esa sección de permiso es compartida a propósito (ver
// TAB_A_SECCION.infraVivienda en public/app.js), pero el acceso real a ESTA
// feature específica se resuelve aquí, no ahí. Si se agrega un endpoint
// nuevo para esta feature, replicar la misma exclusión.
app.get('/api/projects/:id/grupos-categoria', h(auth.allow('residente', 'logistica')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('avance', 'puede_ver')), h(async (req, res) => {
  const pid = req.project.id;
  const { rows } = await db.pool.query(`
    SELECT g.grupo, cgc.categoria
    FROM (
      SELECT DISTINCT grupo FROM conceptos
      WHERE project_id = $1 AND es_total = 0 AND activo = 1 AND grupo IS NOT NULL AND TRIM(grupo) <> ''
    ) g
    LEFT JOIN conceptos_grupo_categoria cgc ON cgc.project_id = $1 AND cgc.grupo = g.grupo
    ORDER BY g.grupo
  `, [pid]);
  res.json({ grupos: rows.map((r) => ({ grupo: r.grupo, categoria: r.categoria || null })) });
}));

const CATEGORIAS_GRUPO_VALIDAS = ['infraestructura', 'vivienda', 'sin_clasificar'];

// 'cabo' excluido a propósito — ver comentario arriba de GET /grupos-categoria.
app.post('/api/projects/:id/grupos-categoria', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('avance', 'puede_crear')), h(async (req, res) => {
  const pid = req.project.id;
  const { clasificaciones } = req.body || {};
  if (!Array.isArray(clasificaciones) || clasificaciones.length === 0) {
    return res.status(400).json({ error: 'clasificaciones debe ser un arreglo no vacío' });
  }
  for (const c of clasificaciones) {
    if (!c || typeof c.grupo !== 'string' || !c.grupo.trim()) {
      return res.status(400).json({ error: 'Cada clasificación requiere un grupo válido' });
    }
    if (!CATEGORIAS_GRUPO_VALIDAS.includes(c.categoria)) {
      return res.status(400).json({ error: `categoria inválida para '${c.grupo}': debe ser infraestructura, vivienda o sin_clasificar` });
    }
  }

  // Solo se permite clasificar grupos que de verdad existen hoy en el
  // presupuesto activo de esta obra — evita basura arbitraria en la tabla de
  // mapeo (ej. typos, grupos de una obra distinta pegados por error).
  const { rows: gruposReales } = await db.pool.query(`
    SELECT DISTINCT grupo FROM conceptos
    WHERE project_id = $1 AND es_total = 0 AND activo = 1 AND grupo IS NOT NULL AND TRIM(grupo) <> ''
  `, [pid]);
  const gruposSet = new Set(gruposReales.map((g) => g.grupo));
  for (const c of clasificaciones) {
    if (!gruposSet.has(c.grupo)) {
      return res.status(400).json({ error: `'${c.grupo}' no es un grupo de conceptos activo de esta obra` });
    }
  }

  await db.withTransaction(async (client) => {
    for (const c of clasificaciones) {
      if (c.categoria === 'sin_clasificar') {
        // "Sin clasificar" nunca se persiste como valor — es la ausencia de
        // fila (ver CHECK constraint en server/db.js), así que reclasificar a
        // sin_clasificar borra la fila si existía.
        await client.query('DELETE FROM conceptos_grupo_categoria WHERE project_id = $1 AND grupo = $2', [pid, c.grupo]);
      } else {
        await client.query(`
          INSERT INTO conceptos_grupo_categoria (project_id, grupo, categoria, creado_por)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (project_id, grupo) DO UPDATE SET categoria = EXCLUDED.categoria, creado_por = EXCLUDED.creado_por, creado_en = NOW()
        `, [pid, c.grupo, c.categoria, req.user.id]);
      }
    }
  });

  const { rows } = await db.pool.query(`
    SELECT g.grupo, cgc.categoria
    FROM (
      SELECT DISTINCT grupo FROM conceptos
      WHERE project_id = $1 AND es_total = 0 AND activo = 1 AND grupo IS NOT NULL AND TRIM(grupo) <> ''
    ) g
    LEFT JOIN conceptos_grupo_categoria cgc ON cgc.project_id = $1 AND cgc.grupo = g.grupo
    ORDER BY g.grupo
  `, [pid]);
  res.json({ grupos: rows.map((r) => ({ grupo: r.grupo, categoria: r.categoria || null })) });
}));

// 'cabo' excluido a propósito — ver comentario arriba de GET /grupos-categoria.
app.get('/api/projects/:id/avance-por-categoria', h(auth.allow('residente', 'logistica')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('avance', 'puede_ver')), h(async (req, res) => {
  const pid = req.project.id;

  // Denominador: MISMA fuente de verdad que el motor de avance ya existente
  // (presupuestoTotalDe(), server/finanzas.js:16 — usada tanto por
  // PUT /avances/:semana/conceptos más arriba como por getFinanzasResumenData()
  // del Resumen/Dashboard). presupuestoTotalDe() prefiere proyectos.meta.
  // total_sin_iva cuando existe, que NO siempre coincide con
  // SUM(conceptos.importe) — confirmado contra Preview real: en 6 de 7 obras
  // reales ambos totales divergen (ej. obra 41: 1.71M vs 5.69M), lo que antes
  // hacía que este endpoint reportara un % de avance total distinto (hasta
  // 3.3x) al que ya muestra el Resumen/Dashboard para la misma obra. Bug real
  // detectado por revisión de código independiente contra datos de Preview.
  const presupuestoTotalReal = await presupuestoTotalDe(pid);

  // Mismo cálculo por-concepto que ya usa avances/:semana/conceptos y el
  // auto-cálculo de PUT /avances/:semana/conceptos (SUM(cantidad_ejecutada) ×
  // precio_unitario, acumulado a la fecha — sin filtrar por semana porque
  // esto es el acumulado actual, no un corte semanal puntual). El motor de
  // cálculo en sí NO se toca: es la misma fórmula, solo agregada por
  // categoría en vez de por concepto/semana individual.
  const { rows } = await db.pool.query(`
    SELECT
      c.id AS concepto_id,
      c.grupo,
      c.importe AS importe_presupuesto,
      COALESCE(ej.cantidad_acumulada, 0) * c.precio_unitario AS importe_ejecutado_acumulado,
      cgc.categoria
    FROM conceptos c
    LEFT JOIN (
      SELECT ac.concepto_id, SUM(ac.cantidad_ejecutada) AS cantidad_acumulada
      FROM avance_conceptos ac
      JOIN conceptos cc ON cc.id = ac.concepto_id
      WHERE cc.project_id = $1
      GROUP BY ac.concepto_id
    ) ej ON ej.concepto_id = c.id
    LEFT JOIN conceptos_grupo_categoria cgc ON cgc.project_id = $1 AND cgc.grupo = c.grupo
    WHERE c.project_id = $1 AND c.es_total = 0 AND c.activo = 1
  `, [pid]);

  const vacio = () => ({ n_grupos: 0, n_conceptos: 0, importe_presupuesto: 0, importe_ejecutado_acumulado: 0, pct_avance: 0 });
  const categorias = { infraestructura: vacio(), vivienda: vacio(), sin_clasificar: vacio() };
  const gruposPorCategoria = { infraestructura: new Set(), vivienda: new Set(), sin_clasificar: new Set() };
  const total = vacio();

  for (const r of rows) {
    const categoria = r.categoria || 'sin_clasificar';
    const bucket = categorias[categoria];
    bucket.n_conceptos += 1;
    bucket.importe_presupuesto += Number(r.importe_presupuesto) || 0;
    bucket.importe_ejecutado_acumulado += Number(r.importe_ejecutado_acumulado) || 0;
    total.n_conceptos += 1;
    total.importe_presupuesto += Number(r.importe_presupuesto) || 0;
    total.importe_ejecutado_acumulado += Number(r.importe_ejecutado_acumulado) || 0;
    if (r.grupo && r.grupo.trim()) gruposPorCategoria[categoria].add(r.grupo);
  }
  // importe_ejecutado_acumulado se deja SIN redondear (mismo criterio que
  // avances/:semana/conceptos arriba, que tampoco redondea
  // importe_ejecutado_acumulado) — redondear aquí con toFixed(2) rompía en
  // la práctica la identidad infra+vivienda+sin_clasificar=total en casos
  // borde tipo "x.xx5" (1.005.toFixed(2) === '1.00', artefacto clásico de
  // punto flotante). El redondeo a 2 decimales es puramente cosa de
  // presentación — fmtMoney ya lo hace en el frontend.
  //
  // importe_presupuesto, en cambio, SÍ se reescala: hasta aquí cada bucket
  // trae la suma cruda de conceptos.importe (rawTotalPresupuesto), que NO es
  // necesariamente igual a presupuestoTotalReal (ver comentario arriba de
  // presupuestoTotalDe()). Se calcula la proporción de cada categoría sobre
  // el crudo y se aplica esa MISMA proporción sobre el total real — así los
  // 3 denominadores por categoría siguen sumando exacto al denominador real
  // (invariante que ya cubre el test de abajo), y total.pct_avance queda
  // matemáticamente idéntico al que ya calcula y persiste el motor real
  // (avance_financiero_real vía PUT /avances/:semana/conceptos, misma
  // fórmula: importe_ejecutado_acumulado / presupuestoTotalDe(pid) × 100,
  // con el mismo clamp [0, 100]).
  const rawTotalPresupuesto = total.importe_presupuesto;
  const escala = rawTotalPresupuesto > 0 ? presupuestoTotalReal / rawTotalPresupuesto : 0;
  for (const categoria of Object.keys(categorias)) {
    const bucket = categorias[categoria];
    bucket.n_grupos = gruposPorCategoria[categoria].size;
    bucket.importe_presupuesto = bucket.importe_presupuesto * escala;
    bucket.pct_avance = bucket.importe_presupuesto > 0
      ? Math.max(0, Math.min(100, (bucket.importe_ejecutado_acumulado / bucket.importe_presupuesto) * 100))
      : 0;
  }
  total.n_grupos = gruposPorCategoria.infraestructura.size + gruposPorCategoria.vivienda.size + gruposPorCategoria.sin_clasificar.size;
  // total.importe_presupuesto se fija al denominador real (no a la re-suma de
  // los buckets ya escalados) — son matemáticamente iguales salvo epsilon de
  // punto flotante (rawTotalPresupuesto × escala = presupuestoTotalReal por
  // construcción), pero fijarlo directo evita arrastrar ese epsilon al valor
  // que de verdad importa para pct_avance.
  total.importe_presupuesto = presupuestoTotalReal;
  total.pct_avance = presupuestoTotalReal > 0
    ? Math.max(0, Math.min(100, (total.importe_ejecutado_acumulado / presupuestoTotalReal) * 100))
    : 0;

  res.json({
    categorias,
    total,
    grupos_sin_clasificar: [...gruposPorCategoria.sin_clasificar].sort(),
  });
}));

// ---------------------------------------------------------------------------
// Resumen / dashboard
// ---------------------------------------------------------------------------
// 'costos' agregado (prompt-seccion-costos-implementacion.md): ganó el tab
// 'resumen' completo (Target State punto 4) — sin este rol aquí, el
// endpoint que alimenta renderInicio()/dashboardHtml daría 403 y el tab
// quedaría inútil pese a estar en PERMISSIONS.costos.tabs.
app.get('/api/projects/:id/resumen', h(auth.allow('tesoreria', 'administracion', 'costos')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const pid = req.project.id;
  const [{ rows: metaRows }, { rows: contratoRows }] = await Promise.all([
    db.pool.query('SELECT clave, valor FROM meta WHERE project_id = $1', [pid]),
    db.pool.query('SELECT id FROM contratos WHERE project_id = $1', [pid]),
  ]);
  const meta = metaToObject(metaRows);
  // Subtotal M.O.+C.S. de la cédula de contrato: derivado al vuelo desde los
  // 2 campos ya extraídos, nunca persistido en `meta` (evita desincronizar
  // un valor calculado con sus 2 fuentes).
  if (meta.subtotal_mano_obra != null && meta.subtotal_carga_social != null) {
    meta.subtotal_mo_cs = Number((Number(meta.subtotal_mano_obra) + Number(meta.subtotal_carga_social)).toFixed(2));
  }
  const { rows: totalRows } = await db.pool.query(
    "SELECT importe FROM conceptos WHERE project_id = $1 AND es_total = 1 AND grupo IS NULL ORDER BY orden DESC LIMIT 1",
    [pid]
  );
  const total = meta.total_sin_iva ? Number(meta.total_sin_iva) : (totalRows[0] ? totalRows[0].importe : 0);
  // prompt-12-fix-totales-iva-invertidos.md: "Total sin IVA" y "Total con
  // IVA" vienen de 2 filas distintas del Excel origen (nunca se derivan uno
  // del otro) — si el Excel de una obra puntual capturó mal la celda del
  // total con IVA, no lo mostramos como si fuera confiable.
  const totalConIvaValido = totalConIvaEsValido(total, meta.total_con_iva);

  // prompt-22-fase0-auditoria-financiero.md: total_contratado idéntico al
  // centavo entre 2 proyectos reales (30/32) mientras total_sin_iva/
  // total_con_iva son genuinamente distintos entre ambos — estadísticamente
  // muy poco probable por azar, pero SIN el PDF original no hay forma de
  // confirmar cuál es el bug de extracción (no hay fila en `contratos` para
  // ninguno de los 2 en el entorno donde se auditó). Mismo criterio que
  // total_con_iva_valido arriba: se avisa, nunca se corrige/fabrica el
  // valor guardado. Duplicado genérico (no hardcodeado a 30/32) para que
  // cualquier par futuro de proyectos con el mismo total_contratado se
  // detecte igual.
  let totalContratadoSospechoso = false;
  if (meta.total_contratado != null) {
    const { rows: dupRows } = await db.pool.query(
      `SELECT project_id FROM meta
       WHERE clave = 'total_contratado' AND project_id != $1
         AND valor IS NOT NULL AND valor::numeric = $2::numeric
       LIMIT 1`,
      [pid, meta.total_contratado]
    );
    totalContratadoSospechoso = dupRows.length > 0;
  }

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
    total_con_iva_valido: totalConIvaValido,
    total_contratado_sospechoso: totalContratadoSospechoso,
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
    const totalAsignado = items.reduce((s, i) => s + calcularDestajo(i.cantidad_asignada, i.precio_destajo), 0);
    const totalGanado = items.reduce((s, i) => s + calcularDestajo(i.cantidad_ejecutada, i.precio_destajo), 0);
    const pctAvance = totalAsignado > 0 ? Math.min(100, (totalGanado / totalAsignado) * 100) : 0;
    return { ...d, items, total_asignado: totalAsignado, total_ganado: totalGanado, pct_avance: pctAvance };
  }));
}

app.get('/api/projects/:id/destajistas', h(auth.allow('residente', 'cabo', 'administracion')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('destajo', 'puede_ver')), h(async (req, res) => {
  res.json(await getDestajistasData(req.project.id));
}));

app.get('/api/projects/:id/destajistas/export', h(auth.allow('residente', 'cabo', 'administracion')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('destajo', 'puede_ver')), h(async (req, res) => {
  const { rows: rlDest } = await db.pool.query(
    `SELECT COUNT(*)::int AS n FROM api_rate_limits
     WHERE usuario_id = $1 AND endpoint = 'export_destajistas'
       AND creado_en > NOW() - INTERVAL '1 hour'`,
    [req.user.id]
  );
  if (rlDest[0].n >= EXPORT_RATE_LIMIT) {
    return res.status(429).json({ error: `Límite de exports alcanzado (${EXPORT_RATE_LIMIT} por hora). Intenta más tarde.` });
  }
  await db.pool.query('INSERT INTO api_rate_limits (usuario_id, endpoint) VALUES ($1, $2)', [req.user.id, 'export_destajistas']);
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

app.post('/api/projects/:id/destajistas', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('destajo', 'puede_crear')), h(async (req, res) => {
  const { nombre, telefono } = req.body || {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre del destajista es requerido' });
  const { rows } = await db.pool.query(
    'INSERT INTO destajistas (project_id, nombre, telefono) VALUES ($1, $2, $3) RETURNING *',
    [req.project.id, nombre.trim(), telefono?.trim() || null]
  );
  res.status(201).json(rows[0]);
}));

app.put('/api/projects/:id/destajistas/:destId', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('destajo', 'puede_editar')), h(async (req, res) => {
  const { nombre, telefono } = req.body || {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre del destajista es requerido' });
  const { rows } = await db.pool.query(
    'UPDATE destajistas SET nombre = $1, telefono = $2 WHERE id = $3 AND project_id = $4 RETURNING *',
    [nombre.trim(), telefono?.trim() || null, Number(req.params.destId), req.project.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Destajista no encontrado' });
  res.json(rows[0]);
}));

app.delete('/api/projects/:id/destajistas/:destId', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('destajo', 'puede_eliminar')), h(async (req, res) => {
  const { rowCount } = await db.pool.query(
    'DELETE FROM destajistas WHERE id = $1 AND project_id = $2',
    [Number(req.params.destId), req.project.id]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Destajista no encontrado' });
  res.json({ ok: true });
}));

app.post('/api/projects/:id/destajistas/:destId/items', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('destajo', 'puede_crear')), h(async (req, res) => {
  const pid = req.project.id;
  const destId = Number(req.params.destId);
  const { rows: destRows } = await db.pool.query(
    'SELECT id FROM destajistas WHERE id = $1 AND project_id = $2',
    [destId, pid]
  );
  if (!destRows[0]) return res.status(404).json({ error: 'Destajista no encontrado' });

  let { concepto_id, codigo, concepto, unidad, cantidad_asignada, precio_destajo } = req.body || {};
  if (!concepto?.trim()) return res.status(400).json({ error: 'El concepto es requerido' });

  // Igual que requisiciones (precio_solicitado): sin puede_editar_precios el
  // campo se fuerza server-side sin importar qué mande el body, en vez de
  // rechazar la request entera con 400.
  if (precio_destajo != null && !(await auth.tienePermiso(req, 'destajo', 'puede_editar_precios'))) {
    auth.logDenied(req, `intento de fijar precio_destajo sin puede_editar_precios (destajista ${destId})`);
    precio_destajo = null;
  }

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

app.put('/api/projects/:id/destajistas/:destId/items/:itemId', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('destajo', 'puede_editar')), h(async (req, res) => {
  const pid = req.project.id;
  const itemId = Number(req.params.itemId);
  let { cantidad_asignada, precio_destajo } = req.body || {};
  if (precio_destajo != null && !(await auth.tienePermiso(req, 'destajo', 'puede_editar_precios'))) {
    auth.logDenied(req, `intento de editar precio_destajo sin puede_editar_precios (item ${itemId})`);
    precio_destajo = null;
  }
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

app.delete('/api/projects/:id/destajistas/:destId/items/:itemId', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('destajo', 'puede_eliminar')), h(async (req, res) => {
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
app.get('/api/projects/:id/destajistas/:destId/avance', h(auth.allow('residente', 'cabo', 'administracion')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('destajo', 'puede_ver')), h(async (req, res) => {
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

app.get('/api/projects/:id/destajistas/:destId/avance/:semana', h(auth.allow('residente', 'cabo', 'administracion')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('destajo', 'puede_ver')), h(async (req, res) => {
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

// prompt-25-auditoria-permisos-completa.md: mismo criterio explícito que la
// autorización de avance — admin/desarrollador-only a propósito, sin
// checkPermiso, no delegable vía permisos_usuario (decisión de Paul).
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

app.put('/api/projects/:id/destajistas/:destId/avance/:semana', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('destajo', 'puede_editar')), h(async (req, res) => {
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
const CATEGORIAS_COSTO = ['obra', 'maquinaria'];
const TIPOS_DOC = ['ine_frente', 'ine_reverso', 'curp_doc', 'comprobante_domicilio', 'otro'];

// Vista global: todos los trabajadores de todas las obras, con la obra y
// el/los residente(s) a cargo de cada una (mismo patrón que GET /api/nominas).
// Un residente por obra es lo normal, pero usuario_proyectos no impide
// asignar más de uno a la misma obra — cuando pasa, se listan todos
// separados por coma en vez de elegir uno arbitrario (decisión confirmada
// con Paul). checkPermiso('trabajadores_global', 'puede_ver') reemplaza el
// auth.allow() anterior (admin/desarrollador-only) — prompts-cotizador-
// permisos.md Prompt 2: ahora es posible otorgar este permiso global a otros
// roles vía la matriz de permisos, sin perder el bypass de admin/desarrollador
// (checkPermiso ya lo incluye internamente).
// prompt-p5-cuentas-bancarias.md: columnas explícitas para CUALQUIER listado
// de trabajadores (nunca t.*) — excluye cuenta_nomina_hsbc/cuenta_alterna a
// nivel de SELECT, no como filtro de payload después. Reusada en los 2
// endpoints de listado de abajo.
// prompt-31-trabajador-multiobra-nn.md: project_id se retiró de esta lista a
// propósito — bajo N:N, trabajadores.project_id es solo la obra "primaria"
// (vestigial, ver comentario en el ALTER de server/db.js) y puede quedar
// desincronizada de la asignación real en cuanto se desasigna esa obra
// (bug real encontrado en Preview: el panel general mostraba "Trabajador no
// encontrado" al gestionar obras después de desasignar la primaria, porque
// el front operaba con ese project_id viejo). Cada endpoint de listado
// agrega su propio `project_id` explícito, tomado de trabajador_obras — la
// obra REAL de esa fila, nunca la columna estática.
const TRABAJADOR_COLUMNAS_LISTADO = `t.id, t.destajista_id, t.nombre, t.puesto, t.tipo_pago,
  t.tarifa_jornal, t.periodicidad, t.curp, t.rfc, t.nss, t.telefono, t.direccion,
  t.contacto_emergencia, t.contacto_emergencia_nombre, t.contacto_emergencia_telefono,
  t.fecha_ingreso, t.activo, t.fecha_baja, t.motivo_baja, t.orden, t.creado_en, t.categoria_costo`;

// prompt-32-fix-listado-trabajadores-duplicado.md: UNA fila por trabajador,
// nunca una por asignación — el intento anterior (prompt-31, comentario
// reemplazado aquí) de "una fila por obra" resultó, en la práctica, en un
// trabajador con 2 obras apareciendo 2 veces con TODA su info duplicada
// (Puesto/Cliente/Residente/Tipo de pago/Cuenta/Acciones), ambigüedad real
// de "¿cuál de las 2 filas edito?" — confirmado con datos reales en Preview
// (Javier Pineda Flores, id 39). Cada trabajador trae su obra "primaria"
// (la asignación activa más antigua, vía LATERAL con ORDER BY
// fecha_asignacion ASC LIMIT 1 — mismo criterio que "primera obra
// asignada" del modelo 1:1 anterior) para las columnas Obra/Cliente/
// Residente(s) que se pintan una sola vez, más el array `obras` completo
// (todas sus asignaciones activas, mismo orden) para que el frontend
// pinte el desplegable con el resto cuando tiene 2+. Dos LATERAL en vez de
// un solo agregado porque necesitamos tanto "la primera" como "todas" sin
// forzar al frontend a derivar la primaria del array (ambigüedad de orden
// si json_agg no garantizara el mismo ORDER BY).
app.get('/api/trabajadores', h(auth.checkPermiso('trabajadores_global', 'puede_ver')), h(async (req, res) => {
  const { activo } = req.query;
  let sql = `
    SELECT ${TRABAJADOR_COLUMNAS_LISTADO}, d.nombre AS destajista_nombre,
           primaria.project_id, primaria.obra_nombre, primaria.cliente_nombre,
           primaria.residentes_a_cargo, obras.lista AS obras
    FROM trabajadores t
    LEFT JOIN destajistas d ON d.id = t.destajista_id
    JOIN LATERAL (
      SELECT o.project_id, p.nombre AS obra_nombre, c.nombre AS cliente_nombre,
             (SELECT string_agg(u.nombre, ', ' ORDER BY u.nombre)
              FROM usuario_proyectos up JOIN usuarios u ON u.id = up.usuario_id
              WHERE up.project_id = o.project_id AND u.puesto = 'residente') AS residentes_a_cargo
      FROM trabajador_obras o
      JOIN proyectos p ON p.id = o.project_id
      LEFT JOIN clientes c ON c.id = p.cliente_id
      WHERE o.trabajador_id = t.id AND o.activo = true
      ORDER BY o.fecha_asignacion ASC
      LIMIT 1
    ) primaria ON true
    JOIN LATERAL (
      SELECT json_agg(json_build_object(
               'project_id', o.project_id, 'obra_nombre', p.nombre, 'cliente_nombre', c.nombre,
               'residentes_a_cargo', (SELECT string_agg(u.nombre, ', ' ORDER BY u.nombre)
                                       FROM usuario_proyectos up JOIN usuarios u ON u.id = up.usuario_id
                                       WHERE up.project_id = o.project_id AND u.puesto = 'residente')
             ) ORDER BY o.fecha_asignacion ASC) AS lista
      FROM trabajador_obras o
      JOIN proyectos p ON p.id = o.project_id
      LEFT JOIN clientes c ON c.id = p.cliente_id
      WHERE o.trabajador_id = t.id AND o.activo = true
    ) obras ON true
    WHERE 1=1`;
  if (activo === '1') sql += ' AND t.activo = true';
  else if (activo === '0') sql += ' AND t.activo = false';
  sql += ' ORDER BY COALESCE(primaria.cliente_nombre, \'\'), primaria.obra_nombre, t.orden, t.nombre';
  const { rows } = await db.pool.query(sql);
  res.json(rows);
}));

// prompt-c-checkpermiso-trabajadores.md: checkPermiso('trabajadores', ...)
// ahora cubre TODAS las acciones reales del módulo (ver/crear/editar/
// eliminar), no solo ver/crear como antes. auth.allow('residente', 'cabo')
// es el gate GRUESO (quién puede llegar a evaluar el permiso granular) —
// admin/desarrollador bypasean ambos gates automáticamente. Sin este
// ensanche, otorgarle 'trabajadores' a cabo desde la matriz de permisos no
// tenía ningún efecto real: auth.allow('residente') rechazaba con 403
// ANTES de que checkPermiso llegara a evaluarse.
// 'administracion' se agregó a este gate grueso en prompt-p5-cuentas-
// bancarias.md — sin esto, otorgarle 'trabajadores'/'trabajadores_bancarios'
// a un usuario administración no tenía ningún efecto real (mismo bug gemelo
// documentado arriba para cabo): el 403 de auth.allow() se disparaba antes
// de que cualquier checkPermiso granular se evaluara. administración sigue
// sin acceso por default (su rol no trae 'trabajadores' en TAB_A_SECCION);
// debe otorgarse manualmente vía el panel de permisos, igual que cualquier
// otra sección granular.
// prompt-31-trabajador-multiobra-nn.md: migrado a trabajador_obras — lista a
// quien tenga una asignación ACTIVA en esta obra, sin importar en cuántas
// otras obras del mismo cliente esté asignado también. trabajadores.activo
// (global) y trabajador_obras.activo (por-obra) son conceptos independientes
// a propósito: dar de baja a alguien no lo desasigna de sus obras (mismo
// comportamiento que ya tenía el modelo 1:1 — project_id nunca se tocaba al
// dar de baja), simplemente deja de contar para nómina/asistencia nuevas.
app.get('/api/projects/:id/trabajadores', h(auth.allow('residente', 'cabo', 'administracion')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('trabajadores', 'puede_ver')), h(async (req, res) => {
  const { activo } = req.query;
  let sql = `SELECT ${TRABAJADOR_COLUMNAS_LISTADO}, d.nombre AS destajista_nombre
             FROM trabajadores t
             JOIN trabajador_obras o ON o.trabajador_id = t.id AND o.project_id = $1 AND o.activo = true
             LEFT JOIN destajistas d ON d.id = t.destajista_id
             WHERE 1=1`;
  const params = [req.project.id];
  if (activo === '1') { sql += ' AND t.activo = true'; }
  else if (activo === '0') { sql += ' AND t.activo = false'; }
  sql += ' ORDER BY t.orden, t.nombre';
  const { rows } = await db.pool.query(sql, params);
  res.json(rows);
}));

// prompt-31-trabajador-multiobra-nn.md: reemplaza el check "WHERE id=$1 AND
// project_id=$2" en los endpoints migrados a trabajador_obras — un
// trabajador pertenece a una obra si tiene ahí una asignación ACTIVA, sin
// importar en cuántas otras obras (del mismo cliente) esté asignado también.
async function trabajadorAsignadoAObra(wId, projectId) {
  const { rows } = await db.pool.query(
    'SELECT 1 FROM trabajador_obras WHERE trabajador_id=$1 AND project_id=$2 AND activo=true',
    [wId, projectId]
  );
  return rows.length > 0;
}

// prompt-p5-cuentas-bancarias.md: recorta cuenta_nomina_hsbc/cuenta_alterna
// de un objeto trabajador antes de responder, salvo que el usuario tenga
// checkPermiso('trabajadores_bancarios','puede_ver') — las claves no deben
// EXISTIR en el JSON (no basta con null), mismo criterio que /api/projects
// para operador en PR #72. Usado en detalle, alta y edición — RETURNING *
// de esos INSERT/UPDATE trae las 2 columnas siempre, así que sin esto un
// residente que edite un campo cualquiera de un trabajador vería el dato
// bancario real de otro usuario (ej. administración) en la respuesta.
async function stripDatosBancarios(req, trabajador) {
  if (!trabajador) return trabajador;
  if (await auth.tienePermiso(req, 'trabajadores_bancarios', 'puede_ver')) return trabajador;
  const { cuenta_nomina_hsbc, cuenta_alterna, banco_nomina, banco_alterna, split_cuenta_nomina_pct, tarjeta_nomina, tarjeta_alterna, ...resto } = trabajador;
  return resto;
}

// prompt-29-split-pago-cuentas.md: split_cuenta_nomina_pct es información
// financiera sensible (define cómo se divide el pago entre 2 cuentas), mismo
// gate que el resto de la sección bancaria (trabajadores_bancarios). Sin
// valor capturado -> default 100 (todo a cuenta_nomina_hsbc, ver
// calcularSplitCuentas en server/calculos.js). Devuelve null si el valor
// recibido es inválido, para que el caller responda 400.
const SPLIT_PCT_DEFAULT = 100;
function validarSplitPct(raw) {
  if (raw === undefined || raw === null || raw === '') return SPLIT_PCT_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n;
}

// prompt-2-deteccion-banco-clabe.md: valida una cuenta bancaria y resuelve
// qué banco guardar. Solo aplica la detección/validación de CLABE cuando la
// cuenta tiene exactamente 18 dígitos — un número de cuenta simple (10-11
// dígitos) no codifica el banco, así que se deja pasar tal cual (sin error,
// sin detección) para no bloquear captura manual. Si el usuario ya mandó un
// banco (autollenado o escrito a mano) se respeta siempre el suyo; solo se
// completa con el detectado cuando no mandó ninguno. Nunca llama a
// validarClabe si length !== 18 (ninguna razón para exigir dígito
// verificador de un número que no es CLABE).
function resolverCuentaBanco(cuentaRaw, bancoRaw) {
  const cuenta = cuentaRaw?.trim() || null;
  const bancoEnviado = bancoRaw?.trim() || null;
  if (!cuenta || cuenta.length !== 18) {
    return { cuenta, banco: bancoEnviado, discrepancia: null };
  }
  const r = validarClabe(cuenta);
  if (!r.valida) {
    const MOTIVOS = { longitud: 'formato inválido', clave_desconocida: 'clave de institución desconocida', digito_verificador: 'dígito verificador incorrecto' };
    return { error: `CLABE inválida — verifica el número (${MOTIVOS[r.motivo] || r.motivo})` };
  }
  const banco = bancoEnviado || r.banco;
  const discrepancia = (bancoEnviado && bancoEnviado !== r.banco) ? { detectado: r.banco, capturado: bancoEnviado } : null;
  return { cuenta, banco, discrepancia };
}

// prompt-35-numero-cuenta-export-nomina.md: a diferencia de resolverCuentaBanco,
// una tarjeta NO tiene dígito verificador público en este proyecto (Forbidden
// Actions del prompt: no aplicar el algoritmo de CLABE aquí) — se guarda tal
// cual, sin bloquear por longitud, igual que una cuenta simple no-CLABE.
function resolverTarjeta(tarjetaRaw) {
  return tarjetaRaw?.trim() || null;
}

// Nunca sobrescribe el banco que mandó el usuario, pero deja rastro en
// audit_log cuando difiere del detectado por CLABE — para que alguien con
// acceso a bancarios pueda revisar el caso después, sin bloquear el guardado.
async function registrarDiscrepanciasBanco(req, trabajadorId, { nomina, alterna }) {
  const ip = auth.getIp(req);
  const casos = [
    nomina.discrepancia && { campo: 'cuenta_nomina_hsbc', ...nomina.discrepancia },
    alterna.discrepancia && { campo: 'cuenta_alterna', ...alterna.discrepancia },
  ].filter(Boolean);
  for (const caso of casos) {
    await db.pool.query(
      `INSERT INTO audit_log (actor_id, actor_usuario, accion, target_id, ip, detalle)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.user.id, req.user.usuario, 'banco_discrepancia_clabe', trabajadorId, ip, JSON.stringify(caso)]
    );
  }
}

// Detalle de un trabajador — no existía antes de este prompt (la UI leía el
// objeto directo del arreglo de GET .../trabajadores, que ya no trae los
// campos bancarios). El frontend solo llama a este endpoint cuando el
// usuario tiene 'trabajadores_bancarios' puede_ver, para enriquecer el
// objeto antes de abrir el modal de edición.
app.get('/api/projects/:id/trabajadores/:wId', h(auth.allow('residente', 'cabo', 'administracion')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('trabajadores', 'puede_ver')), h(async (req, res) => {
  const wId = Number(req.params.wId);
  if (!(await trabajadorAsignadoAObra(wId, req.project.id))) return res.status(404).json({ error: 'Trabajador no encontrado' });
  const { rows } = await db.pool.query('SELECT * FROM trabajadores WHERE id=$1', [wId]);
  if (!rows[0]) return res.status(404).json({ error: 'Trabajador no encontrado' });
  res.json(await stripDatosBancarios(req, rows[0]));
}));

app.post('/api/projects/:id/trabajadores', h(auth.allow('residente', 'cabo', 'administracion')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('trabajadores', 'puede_crear')), h(async (req, res) => {
  const { nombre, puesto, tipo_pago, tarifa_jornal, periodicidad, curp, rfc, nss,
          telefono, direccion, contacto_emergencia, contacto_emergencia_nombre,
          contacto_emergencia_telefono, fecha_ingreso, destajista_id,
          cuenta_nomina_hsbc, cuenta_alterna, banco_nomina, banco_alterna,
          tarjeta_nomina, tarjeta_alterna,
          split_cuenta_nomina_pct, categoria_costo } = req.body || {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  if (!TIPOS_PAGO.includes(tipo_pago)) return res.status(400).json({ error: 'tipo_pago inválido' });
  if (!PERIODICIDADES.includes(periodicidad)) return res.status(400).json({ error: 'periodicidad inválida' });
  const categoriaCosto = categoria_costo || 'obra';
  if (!CATEGORIAS_COSTO.includes(categoriaCosto)) return res.status(400).json({ error: 'categoria_costo inválida' });
  const destId = destajista_id ? Number(destajista_id) : null;
  if (destId) {
    const { rows: dRows } = await db.pool.query('SELECT id FROM destajistas WHERE id=$1 AND project_id=$2', [destId, req.project.id]);
    if (!dRows[0]) return res.status(400).json({ error: 'Destajista vinculado no pertenece a esta obra' });
  }
  // Ignora en silencio los campos bancarios si el usuario no tiene el
  // permiso — mismo criterio que precio_destajo en /destajistas/.../items,
  // no bloquea el alta completa por un campo al que no debería tener acceso.
  const puedeEditarBancarios = await auth.tienePermiso(req, 'trabajadores_bancarios', 'puede_editar');
  let nomina = { cuenta: null, banco: null, discrepancia: null };
  let alterna = { cuenta: null, banco: null, discrepancia: null };
  let splitPct = SPLIT_PCT_DEFAULT;
  let tarjetaNomina = null;
  let tarjetaAlterna = null;
  if (puedeEditarBancarios) {
    nomina = resolverCuentaBanco(cuenta_nomina_hsbc, banco_nomina);
    if (nomina.error) return res.status(400).json({ error: nomina.error });
    alterna = resolverCuentaBanco(cuenta_alterna, banco_alterna);
    if (alterna.error) return res.status(400).json({ error: alterna.error });
    splitPct = validarSplitPct(split_cuenta_nomina_pct);
    if (splitPct === null) return res.status(400).json({ error: 'split_cuenta_nomina_pct debe ser un número entre 0 y 100' });
    tarjetaNomina = resolverTarjeta(tarjeta_nomina);
    tarjetaAlterna = resolverTarjeta(tarjeta_alterna);
  }
  const curpTrim = curp?.trim() || null;
  let rows;
  try {
    // prompt-31-trabajador-multiobra-nn.md: el alta crea el trabajador (con
    // project_id = obra de alta, columna "primaria" conservada por
    // compatibilidad con endpoints aún no migrados a trabajador_obras) Y su
    // primera fila de asignación en trabajador_obras, en la misma
    // transacción — ambos constraints de CURP único por obra (el viejo sobre
    // trabajadores, el nuevo sobre trabajador_obras) se validan juntos.
    rows = await db.withTransaction(async (client) => {
      const { rows: trabRows } = await client.query(`
        INSERT INTO trabajadores
          (project_id, destajista_id, nombre, puesto, tipo_pago, tarifa_jornal, periodicidad,
           curp, rfc, nss, telefono, direccion, contacto_emergencia,
           contacto_emergencia_nombre, contacto_emergencia_telefono, fecha_ingreso,
           cuenta_nomina_hsbc, cuenta_alterna, banco_nomina, banco_alterna, split_cuenta_nomina_pct,
           tarjeta_nomina, tarjeta_alterna, categoria_costo)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING *`,
        [req.project.id, destId, nombre.trim(), puesto?.trim()||null, tipo_pago,
         Math.max(0, Number(tarifa_jornal)||0), periodicidad,
         curpTrim, rfc?.trim()||null, nss?.trim()||null,
         telefono?.trim()||null, direccion?.trim()||null, contacto_emergencia?.trim()||null,
         contacto_emergencia_nombre?.trim()||null, contacto_emergencia_telefono?.trim()||null,
         fecha_ingreso||null,
         nomina.cuenta, alterna.cuenta, nomina.banco, alterna.banco, splitPct,
         tarjetaNomina, tarjetaAlterna, categoriaCosto]
      );
      await client.query(
        `INSERT INTO trabajador_obras (trabajador_id, project_id, curp, activo, asignado_por)
         VALUES ($1,$2,$3,true,$4)`,
        [trabRows[0].id, req.project.id, curpTrim, req.user.id]
      );
      return trabRows;
    });
  } catch (err) {
    // prompt-21-trabajadores-multiobra-diagnostico.md, Fase 0: idx_trabajadores_curp_unico_por_obra
    // prompt-31-trabajador-multiobra-nn.md: idx_trabajador_obras_curp_unico_activo (mismo caso, constraint nuevo)
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un trabajador con ese CURP en esta obra' });
    throw err;
  }
  await registrarDiscrepanciasBanco(req, rows[0].id, { nomina, alterna });
  res.status(201).json(await stripDatosBancarios(req, rows[0]));
}));

app.put('/api/projects/:id/trabajadores/:wId', h(auth.allow('residente', 'cabo', 'administracion')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('trabajadores', 'puede_editar')), h(async (req, res) => {
  const wId = Number(req.params.wId);
  if (!(await trabajadorAsignadoAObra(wId, req.project.id))) return res.status(404).json({ error: 'Trabajador no encontrado' });
  const { nombre, puesto, tipo_pago, tarifa_jornal, periodicidad, curp, rfc, nss,
          telefono, direccion, contacto_emergencia, contacto_emergencia_nombre,
          contacto_emergencia_telefono, fecha_ingreso, destajista_id,
          cuenta_nomina_hsbc, cuenta_alterna, banco_nomina, banco_alterna,
          tarjeta_nomina, tarjeta_alterna,
          split_cuenta_nomina_pct, categoria_costo } = req.body || {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  if (!TIPOS_PAGO.includes(tipo_pago)) return res.status(400).json({ error: 'tipo_pago inválido' });
  if (!PERIODICIDADES.includes(periodicidad)) return res.status(400).json({ error: 'periodicidad inválida' });
  const categoriaCosto = categoria_costo || 'obra';
  if (!CATEGORIAS_COSTO.includes(categoriaCosto)) return res.status(400).json({ error: 'categoria_costo inválida' });
  const destId = destajista_id ? Number(destajista_id) : null;
  if (destId) {
    const { rows: dRows } = await db.pool.query('SELECT id FROM destajistas WHERE id=$1 AND project_id=$2', [destId, req.project.id]);
    if (!dRows[0]) return res.status(400).json({ error: 'Destajista vinculado no pertenece a esta obra' });
  }
  // Si el usuario NO tiene permiso sobre datos bancarios, esas columnas se
  // OMITEN por completo del UPDATE (no se ponen en null) — de lo contrario
  // un residente editando solo el puesto borraría el dato bancario real que
  // administración ya había capturado. Solo se tocan si el usuario sí puede.
  // split_cuenta_nomina_pct/tarjeta_nomina/tarjeta_alterna entran en el mismo
  // gate (prompt-29-split-pago-cuentas.md, prompt-35-numero-cuenta-export-
  // nomina.md) — misma sección de información financiera sensible.
  const puedeEditarBancarios = await auth.tienePermiso(req, 'trabajadores_bancarios', 'puede_editar');
  const setClauses = [
    'destajista_id=$1', 'nombre=$2', 'puesto=$3', 'tipo_pago=$4', 'tarifa_jornal=$5',
    'periodicidad=$6', 'curp=$7', 'rfc=$8', 'nss=$9', 'telefono=$10', 'direccion=$11',
    'contacto_emergencia=$12', 'contacto_emergencia_nombre=$13', 'contacto_emergencia_telefono=$14',
    'fecha_ingreso=$15', 'categoria_costo=$16',
  ];
  const params = [destId, nombre.trim(), puesto?.trim()||null, tipo_pago,
    Math.max(0, Number(tarifa_jornal)||0), periodicidad,
    curp?.trim()||null, rfc?.trim()||null, nss?.trim()||null,
    telefono?.trim()||null, direccion?.trim()||null, contacto_emergencia?.trim()||null,
    contacto_emergencia_nombre?.trim()||null, contacto_emergencia_telefono?.trim()||null,
    fecha_ingreso||null, categoriaCosto];
  let nomina = { discrepancia: null };
  let alterna = { discrepancia: null };
  if (puedeEditarBancarios) {
    nomina = resolverCuentaBanco(cuenta_nomina_hsbc, banco_nomina);
    if (nomina.error) return res.status(400).json({ error: nomina.error });
    alterna = resolverCuentaBanco(cuenta_alterna, banco_alterna);
    if (alterna.error) return res.status(400).json({ error: alterna.error });
    const splitPct = validarSplitPct(split_cuenta_nomina_pct);
    if (splitPct === null) return res.status(400).json({ error: 'split_cuenta_nomina_pct debe ser un número entre 0 y 100' });
    const tarjetaNomina = resolverTarjeta(tarjeta_nomina);
    const tarjetaAlterna = resolverTarjeta(tarjeta_alterna);
    params.push(nomina.cuenta, alterna.cuenta, nomina.banco, alterna.banco, splitPct, tarjetaNomina, tarjetaAlterna);
    setClauses.push(
      `cuenta_nomina_hsbc=$${params.length - 6}`, `cuenta_alterna=$${params.length - 5}`,
      `banco_nomina=$${params.length - 4}`, `banco_alterna=$${params.length - 3}`,
      `split_cuenta_nomina_pct=$${params.length - 2}`,
      `tarjeta_nomina=$${params.length - 1}`, `tarjeta_alterna=$${params.length}`
    );
  }
  params.push(wId);
  let rows;
  try {
    ({ rows } = await db.pool.query(
      `UPDATE trabajadores SET ${setClauses.join(', ')}
       WHERE id=$${params.length} RETURNING *`,
      params
    ));
  } catch (err) {
    // prompt-21-trabajadores-multiobra-diagnostico.md, Fase 0: idx_trabajadores_curp_unico_por_obra
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un trabajador con ese CURP en esta obra' });
    throw err;
  }
  if (!rows[0]) return res.status(404).json({ error: 'Trabajador no encontrado' });
  await registrarDiscrepanciasBanco(req, wId, { nomina, alterna });
  res.json(await stripDatosBancarios(req, rows[0]));
}));

// prompt-31-trabajador-multiobra-nn.md: migrado a trabajador_obras (antes
// dependía de project_id=$4 — bug real encontrado en Preview: fallaba con
// "Trabajador no encontrado" al operar vía una obra donde el trabajador SÍ
// está activo, si esa obra no coincidía con project_id, que puede quedar
// desincronizado en cuanto se desasigna la primaria). motivo_baja es GLOBAL
// (no por-obra) — dar de baja sigue sin tocar trabajador_obras a propósito
// (mismo comportamiento que el modelo 1:1: project_id nunca se tocaba al
// dar de baja).
// prompt-limpieza-permisos-cabo.md: 'cabo' quitado de este allow() a
// propósito — dar de baja a un trabajador queda bloqueada para cabo sin
// importar qué le otorgue la matriz de permisos_usuario (puede_editar en
// 'trabajadores' o cualquier otro). allow() corre ANTES que checkPermiso,
// así que esto es un bloqueo duro a nivel de ruta, no delegable por
// permisos_usuario — mismo patrón que 'aprobar'/'rechazar' en
// ordenes_cambio (auth.allow() sin cabo, admin/desarrollador-only ahí;
// aquí residente sigue pudiendo). reactivar (abajo) NO se tocó — sigue
// permitido para cabo, esta restricción es específica de "dar de baja".
app.post('/api/projects/:id/trabajadores/:wId/baja', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('trabajadores', 'puede_editar')), h(async (req, res) => {
  const wId = Number(req.params.wId);
  if (!(await trabajadorAsignadoAObra(wId, req.project.id))) return res.status(404).json({ error: 'Trabajador no encontrado' });
  const { motivo_baja, notas, fecha_baja } = req.body || {};
  const MOTIVOS = ['renuncia','despido_justificado','despido_injustificado','fin_obra','abandono','otro'];
  if (!MOTIVOS.includes(motivo_baja)) return res.status(400).json({ error: 'motivo_baja inválido' });
  if (motivo_baja === 'otro' && !notas?.trim()) return res.status(400).json({ error: 'Cuando el motivo es "otro", las notas son requeridas' });
  const fechaBaja = fecha_baja || null;
  const { rows } = await db.pool.query(
    `UPDATE trabajadores SET activo=false, fecha_baja=COALESCE($1::date, CURRENT_DATE), motivo_baja=$2
     WHERE id=$3 AND activo=true RETURNING *`,
    [fechaBaja, motivo_baja, wId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Trabajador no encontrado o ya dado de baja' });
  await db.pool.query(
    `INSERT INTO trabajador_bajas (trabajador_id, fecha_baja, motivo_baja, notas, registrado_por)
     VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5)`,
    [wId, fechaBaja, motivo_baja, notas?.trim()||null, req.user.id]
  );
  res.json(rows[0]);
}));

app.get('/api/projects/:id/trabajadores/:wId/bajas', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('trabajadores', 'puede_ver')), h(async (req, res) => {
  const wId = Number(req.params.wId);
  if (!(await trabajadorAsignadoAObra(wId, req.project.id))) return res.status(404).json({ error: 'Trabajador no encontrado' });
  const { rows } = await db.pool.query(
    `SELECT b.*, u.nombre AS registrado_por_nombre
     FROM trabajador_bajas b LEFT JOIN usuarios u ON u.id = b.registrado_por
     WHERE b.trabajador_id = $1 ORDER BY b.created_at DESC`,
    [wId]
  );
  res.json(rows);
}));

app.post('/api/projects/:id/trabajadores/:wId/reactivar', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('trabajadores', 'puede_editar')), h(async (req, res) => {
  const wId = Number(req.params.wId);
  if (!(await trabajadorAsignadoAObra(wId, req.project.id))) return res.status(404).json({ error: 'Trabajador no encontrado' });
  const { rows } = await db.pool.query(
    `UPDATE trabajadores SET activo=true, fecha_baja=NULL, motivo_baja=NULL
     WHERE id=$1 AND activo=false RETURNING *`,
    [wId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Trabajador no encontrado o ya activo' });
  res.json(rows[0]);
}));

// prompt-31-trabajador-multiobra-nn.md: obras donde este trabajador tiene o
// tuvo una asignación (activa o histórica) — consultable desde el detalle
// del trabajador. Requiere que el trabajador esté ASIGNADO ACTUALMENTE a la
// obra de la URL (mismo criterio IDOR que el resto de endpoints de
// trabajadores) — no expone su historial completo a cualquiera con acceso a
// CUALQUIERA de sus obras, solo a quien tenga acceso a una donde sigue activo.
app.get('/api/projects/:id/trabajadores/:wId/obras', h(auth.allow('residente', 'cabo', 'administracion')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('trabajadores', 'puede_ver')), h(async (req, res) => {
  const wId = Number(req.params.wId);
  if (!(await trabajadorAsignadoAObra(wId, req.project.id))) return res.status(404).json({ error: 'Trabajador no encontrado' });
  const { rows } = await db.pool.query(`
    SELECT o.id, o.project_id, p.nombre AS obra_nombre, o.activo,
           o.fecha_asignacion, o.fecha_desasignacion, u.nombre AS asignado_por_nombre
    FROM trabajador_obras o
    JOIN proyectos p ON p.id = o.project_id
    LEFT JOIN usuarios u ON u.id = o.asignado_por
    WHERE o.trabajador_id = $1
    ORDER BY o.activo DESC, o.fecha_asignacion DESC`,
    [wId]
  );
  res.json(rows);
}));

// prompt-31-trabajador-multiobra-nn.md: asigna a un trabajador YA activo en
// la obra de la URL a una obra ADICIONAL del mismo cliente — a diferencia de
// "mover" (PR #110, cerrado), no cierra la asignación de origen, ambas
// quedan activas simultáneamente. Requiere acceso (usuario_proyectos) a
// AMBAS obras — verificarAccesoObra de la middleware chain solo cubre la de
// la URL. El UNIQUE de CURP por obra (idx_trabajador_obras_curp_unico_activo)
// se dispara solo contra el destino al hacer el INSERT.
app.post('/api/projects/:id/trabajadores/:wId/asignar-obra', h(auth.allow('residente', 'cabo', 'administracion')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('trabajadores', 'puede_editar')), h(async (req, res) => {
  const wId = Number(req.params.wId);
  const { project_id_destino } = req.body || {};
  const destinoId = Number(project_id_destino);
  if (!Number.isFinite(destinoId) || destinoId <= 0) return res.status(400).json({ error: 'Indica la obra destino' });
  if (destinoId === req.project.id) return res.status(400).json({ error: 'La obra destino debe ser distinta a la actual' });

  if (!(await trabajadorAsignadoAObra(wId, req.project.id))) return res.status(404).json({ error: 'Trabajador no encontrado en esta obra' });

  const { rows: obrasRows } = await db.pool.query(
    'SELECT id, cliente_id FROM proyectos WHERE id = ANY($1)',
    [[req.project.id, destinoId]]
  );
  const origenObra = obrasRows.find((o) => o.id === req.project.id);
  const destinoObra = obrasRows.find((o) => o.id === destinoId);
  if (!destinoObra) return res.status(400).json({ error: 'Obra destino no encontrada' });
  if (!origenObra.cliente_id || origenObra.cliente_id !== destinoObra.cliente_id) {
    return res.status(400).json({ error: 'Solo puedes asignar a un trabajador a otra obra del mismo cliente' });
  }

  if (req.user.puesto !== 'admin' && req.user.puesto !== 'desarrollador') {
    const { rows: accesoDestino } = await db.pool.query(
      'SELECT 1 FROM usuario_proyectos WHERE usuario_id=$1 AND project_id=$2',
      [req.user.id, destinoId]
    );
    if (!accesoDestino.length) return res.status(403).json({ error: 'No tienes acceso a la obra destino' });
  }

  const { rows: yaActivo } = await db.pool.query(
    'SELECT 1 FROM trabajador_obras WHERE trabajador_id=$1 AND project_id=$2 AND activo=true',
    [wId, destinoId]
  );
  if (yaActivo.length) return res.status(409).json({ error: 'Ya está asignado activamente a esa obra' });

  const { rows: curpRows } = await db.pool.query('SELECT curp FROM trabajadores WHERE id=$1', [wId]);
  let rows;
  try {
    ({ rows } = await db.pool.query(
      `INSERT INTO trabajador_obras (trabajador_id, project_id, curp, activo, asignado_por)
       VALUES ($1,$2,$3,true,$4) RETURNING *`,
      [wId, destinoId, curpRows[0]?.curp || null, req.user.id]
    ));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un trabajador con ese CURP en la obra destino' });
    throw err;
  }
  res.status(201).json(rows[0]);
}));

// prompt-31-trabajador-multiobra-nn.md: desasigna a un trabajador de la obra
// de la URL — NO borra su historial ahí (nómina/asistencia ya generados
// siguen consultables), solo marca esa asignación específica como inactiva
// desde ahora. El trabajador puede seguir activo en sus demás obras sin
// verse afectado.
//
// Bloqueo verificado con datos reales (no solo teórico): el cálculo de
// nómina arma su lista de trabajadores desde trabajador_obras.activo=true
// EN EL MOMENTO del cálculo — si se desasigna primero y se calcula/recalcula
// una nómina de esa obra DESPUÉS, cualquier asistencia real ya capturada en
// el periodo desaparece en silencio del renglón de nómina (0 pesos, sin
// error). No basta con checar si ya existe una nómina 'borrador' con un
// renglón de este trabajador (esa nómina puede no existir todavía en el
// momento de desasignar, como en el caso reproducido) — el bloqueo real
// tiene que ser: ¿hay asistencia 'presente' de este trabajador en esta obra
// que AÚN no esté cubierta por una nómina 'aprobada'? Si la hay, se bloquea
// hasta que se apruebe (o se corrija) esa asistencia.
app.post('/api/projects/:id/trabajadores/:wId/desasignar-obra', h(auth.allow('residente', 'cabo', 'administracion')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('trabajadores', 'puede_editar')), h(async (req, res) => {
  const wId = Number(req.params.wId);

  const { rows: pendienteRows } = await db.pool.query(`
    SELECT 1 FROM asistencia_diaria ad
    WHERE ad.trabajador_id=$1 AND ad.project_id=$2 AND ad.estado='presente'
      AND NOT EXISTS (
        SELECT 1 FROM nominas n
        WHERE n.project_id=$2 AND n.estado='aprobada'
          AND n.fecha_inicio <= ad.fecha AND n.fecha_fin >= ad.fecha
      )
    LIMIT 1`,
    [wId, req.project.id]
  );
  if (pendienteRows.length) {
    return res.status(409).json({ error: 'Este trabajador tiene asistencia registrada en esta obra que aún no está cubierta por una nómina aprobada — resuélvela antes de desasignarlo' });
  }

  const { rows } = await db.pool.query(
    `UPDATE trabajador_obras SET activo=false, fecha_desasignacion=NOW()
     WHERE trabajador_id=$1 AND project_id=$2 AND activo=true RETURNING *`,
    [wId, req.project.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Trabajador no encontrado o ya desasignado de esta obra' });
  res.json(rows[0]);
}));

app.delete('/api/projects/:id/trabajadores/:wId', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('trabajadores', 'puede_eliminar')), h(async (req, res) => {
  const wId = Number(req.params.wId);
  if (!(await trabajadorAsignadoAObra(wId, req.project.id))) return res.status(404).json({ error: 'Trabajador no encontrado' });
  const { rows: trabRows } = await db.pool.query('SELECT activo FROM trabajadores WHERE id=$1', [wId]);
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
  const { rowCount } = await db.pool.query('DELETE FROM trabajadores WHERE id=$1', [wId]);
  if (rowCount === 0) return res.status(404).json({ error: 'Trabajador no encontrado' });
  res.json({ ok: true });
}));

// --- Documentos de identidad (Vercel Blob privado) ---
app.post('/api/projects/:id/trabajadores/:wId/documentos/upload-token', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('trabajadores_docs', 'puede_crear')), h(async (req, res) => {
  const wId = Number(req.params.wId);
  if (!(await trabajadorAsignadoAObra(wId, req.project.id))) return res.status(404).json({ error: 'Trabajador no encontrado' });
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

app.post('/api/projects/:id/trabajadores/:wId/documentos', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('trabajadores_docs', 'puede_crear')), h(async (req, res) => {
  const wId = Number(req.params.wId);
  const { tipo, nombre_archivo, blob_url } = req.body || {};
  if (!blob_url) return res.status(400).json({ error: 'blob_url es requerido' });
  if (!TIPOS_DOC.includes(tipo)) return res.status(400).json({ error: 'tipo de documento inválido' });
  if (!(await trabajadorAsignadoAObra(wId, req.project.id))) return res.status(404).json({ error: 'Trabajador no encontrado' });
  const { rows } = await db.pool.query(
    'INSERT INTO trabajador_documentos (trabajador_id, tipo, nombre_archivo, blob_url, subido_por) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [wId, tipo, nombre_archivo?.trim()||'documento', blob_url, req.user.id]
  );
  res.status(201).json(rows[0]);
}));

app.get('/api/projects/:id/trabajadores/:wId/documentos', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('trabajadores_docs', 'puede_ver')), h(async (req, res) => {
  const wId = Number(req.params.wId);
  if (!(await trabajadorAsignadoAObra(wId, req.project.id))) return res.status(404).json({ error: 'Trabajador no encontrado' });
  const { rows } = await db.pool.query(
    'SELECT id, tipo, nombre_archivo, subido_en FROM trabajador_documentos WHERE trabajador_id=$1 ORDER BY subido_en DESC',
    [wId]
  );
  res.json(rows);
}));

app.get('/api/projects/:id/trabajadores/:wId/documentos/:docId/download', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('trabajadores_docs', 'puede_ver')), h(async (req, res) => {
  const wId = Number(req.params.wId);
  const docId = Number(req.params.docId);
  const { rows } = await db.pool.query(
    `SELECT d.* FROM trabajador_documentos d
     WHERE d.id=$1 AND d.trabajador_id=$2
       AND EXISTS (SELECT 1 FROM trabajador_obras o WHERE o.trabajador_id=$2 AND o.project_id=$3 AND o.activo=true)`,
    [docId, wId, req.project.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Documento no encontrado' });
  const blobResult = await get(rows[0].blob_url, { access: 'private' });
  if (!blobResult) return res.status(404).json({ error: 'Archivo no encontrado en almacenamiento' });
  const ext = (rows[0].nombre_archivo.split('.').pop() || 'bin').toLowerCase();
  const mimeMap = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', webp: 'image/webp' };
  res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
  res.setHeader('Content-Disposition', safeContentDisposition('inline', rows[0].nombre_archivo));
  const { pipeline: pipe } = require('stream/promises');
  await pipe(Readable.fromWeb(blobResult.stream), res);
}));

app.delete('/api/projects/:id/trabajadores/:wId/documentos/:docId', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('trabajadores_docs', 'puede_eliminar')), h(async (req, res) => {
  const wId = Number(req.params.wId);
  const docId = Number(req.params.docId);
  const { rows } = await db.pool.query(
    `SELECT d.blob_url FROM trabajador_documentos d
     WHERE d.id=$1 AND d.trabajador_id=$2
       AND EXISTS (SELECT 1 FROM trabajador_obras o WHERE o.trabajador_id=$2 AND o.project_id=$3 AND o.activo=true)`,
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
app.post('/api/projects/:id/trabajadores/:wId/contratos/upload-token', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('trabajadores_contrato', 'puede_crear')), h(async (req, res) => {
  const wId = Number(req.params.wId);
  if (!(await trabajadorAsignadoAObra(wId, req.project.id))) return res.status(404).json({ error: 'Trabajador no encontrado' });
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

app.post('/api/projects/:id/trabajadores/:wId/contratos', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('trabajadores_contrato', 'puede_crear')), h(async (req, res) => {
  const wId = Number(req.params.wId);
  const { tipo_contrato, fecha_inicio, fecha_fin, salario_diario, pdf_url, pdf_filename } = req.body || {};
  const TIPOS = ['obra_determinada','tiempo_determinado','tiempo_indeterminado'];
  if (!TIPOS.includes(tipo_contrato)) return res.status(400).json({ error: 'tipo_contrato inválido' });
  if (!fecha_inicio) return res.status(400).json({ error: 'fecha_inicio es requerida' });
  if (!(await trabajadorAsignadoAObra(wId, req.project.id))) return res.status(404).json({ error: 'Trabajador no encontrado' });
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

app.get('/api/projects/:id/trabajadores/:wId/contratos', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('trabajadores_contrato', 'puede_ver')), h(async (req, res) => {
  const wId = Number(req.params.wId);
  if (!(await trabajadorAsignadoAObra(wId, req.project.id))) return res.status(404).json({ error: 'Trabajador no encontrado' });
  const { rows } = await db.pool.query(
    `SELECT c.*, u.nombre AS creado_por_nombre
     FROM contratos_trabajador c LEFT JOIN usuarios u ON u.id = c.created_by
     WHERE c.trabajador_id = $1 ORDER BY c.created_at DESC`,
    [wId]
  );
  res.json(rows);
}));

app.get('/api/projects/:id/trabajadores/:wId/contratos/:cId/download', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('trabajadores_contrato', 'puede_ver')), h(async (req, res) => {
  const wId = Number(req.params.wId);
  const cId = Number(req.params.cId);
  const { rows } = await db.pool.query(
    `SELECT c.pdf_url, c.pdf_filename FROM contratos_trabajador c
     WHERE c.id=$1 AND c.trabajador_id=$2
       AND EXISTS (SELECT 1 FROM trabajador_obras o WHERE o.trabajador_id=$2 AND o.project_id=$3 AND o.activo=true)`,
    [cId, wId, req.project.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Contrato no encontrado' });
  if (!rows[0].pdf_url) return res.status(404).json({ error: 'Este contrato no tiene PDF adjunto' });
  const blobResult = await get(rows[0].pdf_url, { access: 'private' });
  if (!blobResult) return res.status(404).json({ error: 'Archivo no encontrado en almacenamiento' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', safeContentDisposition('inline', rows[0].pdf_filename || 'contrato.pdf'));
  const { pipeline: pipe } = require('stream/promises');
  await pipe(Readable.fromWeb(blobResult.stream), res);
}));

// ===========================================================================
// EPP — CATÁLOGO POR OBRA
// ===========================================================================
app.get('/api/projects/:id/epp-catalogo', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('trabajadores', 'puede_ver')), h(async (req, res) => {
  const { soloActivos } = req.query;
  let sql = 'SELECT * FROM epp_catalogo WHERE project_id=$1';
  if (soloActivos === '1') sql += ' AND activo=true';
  sql += ' ORDER BY nombre_item';
  const { rows } = await db.pool.query(sql, [req.project.id]);
  res.json(rows);
}));

app.post('/api/projects/:id/epp-catalogo', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('trabajadores', 'puede_crear')), h(async (req, res) => {
  const { nombre_item, descripcion } = req.body || {};
  if (!nombre_item?.trim()) return res.status(400).json({ error: 'nombre_item es requerido' });
  const { rows } = await db.pool.query(
    'INSERT INTO epp_catalogo (project_id, nombre_item, descripcion) VALUES ($1,$2,$3) RETURNING *',
    [req.project.id, nombre_item.trim(), descripcion?.trim()||null]
  );
  res.status(201).json(rows[0]);
}));

app.put('/api/projects/:id/epp-catalogo/:itemId', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('trabajadores', 'puede_editar')), h(async (req, res) => {
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
app.get('/api/projects/:id/trabajadores/:wId/epp-entregas', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('trabajadores', 'puede_ver')), h(async (req, res) => {
  const wId = Number(req.params.wId);
  if (!(await trabajadorAsignadoAObra(wId, req.project.id))) return res.status(404).json({ error: 'Trabajador no encontrado' });
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

app.post('/api/projects/:id/trabajadores/:wId/epp-entregas', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('trabajadores', 'puede_crear')), h(async (req, res) => {
  const wId = Number(req.params.wId);
  const { item_id, cantidad, fecha_entrega, firma_digital } = req.body || {};
  if (!item_id) return res.status(400).json({ error: 'item_id es requerido' });
  if (!(await trabajadorAsignadoAObra(wId, req.project.id))) return res.status(404).json({ error: 'Trabajador no encontrado' });
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

// Borrado físico, solo Admin/Desarrollador — una entrega con firma no se edita,
// solo se elimina y se vuelve a capturar si hubo un error.
app.delete('/api/projects/:id/trabajadores/:wId/epp-entregas/:entregaId', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('trabajadores', 'puede_eliminar')), h(async (req, res) => {
  const wId = Number(req.params.wId);
  const entregaId = Number(req.params.entregaId);
  if (!(await trabajadorAsignadoAObra(wId, req.project.id))) return res.status(404).json({ error: 'Trabajador no encontrado' });
  const { rows } = await db.pool.query(
    'DELETE FROM epp_entregas WHERE id=$1 AND trabajador_id=$2 RETURNING id',
    [entregaId, wId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Registro de entrega no encontrado' });
  res.json({ ok: true });
}));

// ===========================================================================
// ASISTENCIA DIARIA
// ===========================================================================

// Rango de fechas (para el calendario: vista general del mes + detalle por
// trabajador) — a diferencia de GET /asistencia (un solo día), esta trae
// todos los registros de un periodo en una sola llamada. Tope de 366 días
// (~12 meses, prompt-calendario-asistencia-rangos-y-bloqueo.md — antes 92)
// para soportar el selector de rango de vista sin permitir pedir el
// historial completo de golpe por error.
// fecha_hoy (America/Mexico_City) viaja en la respuesta como fuente de
// verdad única para que el frontend nunca dependa del reloj del dispositivo
// al decidir qué celda es editable (sección 3 del prompt).
// granularidad=mes agrega en SQL (date_trunc) para el modo resumen — evita
// mandar el detalle día por día de hasta 12 meses solo para pintar
// porcentajes por mes.
app.get('/api/projects/:id/asistencia-rango', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('nominas', 'puede_ver')), h(async (req, res) => {
  const { desde, hasta, granularidad } = req.query;
  if (!desde || !/^\d{4}-\d{2}-\d{2}$/.test(desde)) return res.status(400).json({ error: 'desde requerido (YYYY-MM-DD)' });
  if (!hasta || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) return res.status(400).json({ error: 'hasta requerido (YYYY-MM-DD)' });
  if (desde > hasta) return res.status(400).json({ error: 'desde debe ser anterior o igual a hasta' });
  const dias = (new Date(hasta) - new Date(desde)) / 86400000;
  if (dias > 366) return res.status(400).json({ error: 'El rango no puede superar 366 días' });
  if (granularidad != null && granularidad !== 'dia' && granularidad !== 'mes') {
    return res.status(400).json({ error: "granularidad debe ser 'dia' o 'mes'" });
  }

  const fechaHoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());

  const { rows: trabajadores } = await db.pool.query(
    `SELECT t.id, t.nombre, t.puesto, t.tipo_pago FROM trabajadores t
     JOIN trabajador_obras o ON o.trabajador_id = t.id AND o.project_id = $1 AND o.activo = true
     WHERE t.activo = true ORDER BY t.orden, t.nombre`,
    [req.project.id]
  );

  if (granularidad === 'mes') {
    // dias_asistidos/dias_registrados/porcentaje con el mismo criterio que
    // renderDetalle() en public/app.js: 'sin_registro' no cuenta como
    // registro real (mismo criterio que el cálculo de nómina).
    const { rows: resumenMensual } = await db.pool.query(
      `SELECT trabajador_id,
              to_char(date_trunc('month', fecha), 'YYYY-MM') AS mes,
              COUNT(*) FILTER (WHERE estado = 'presente') AS dias_asistidos,
              COUNT(*) FILTER (WHERE estado <> 'sin_registro') AS dias_registrados,
              COALESCE(ROUND(
                100.0 * COUNT(*) FILTER (WHERE estado = 'presente')
                / NULLIF(COUNT(*) FILTER (WHERE estado <> 'sin_registro'), 0)
              ), 0) AS porcentaje
       FROM asistencia_diaria
       WHERE project_id = $1 AND fecha BETWEEN $2 AND $3
       GROUP BY trabajador_id, date_trunc('month', fecha)
       ORDER BY trabajador_id, date_trunc('month', fecha)`,
      [req.project.id, desde, hasta]
    );
    return res.json({ desde, hasta, fecha_hoy: fechaHoy, granularidad: 'mes', trabajadores, resumen_mensual: resumenMensual });
  }

  // fecha viaja tal cual "YYYY-MM-DD": este proyecto registra un type parser
  // para OID 1082 (DATE) que devuelve el valor crudo del driver, sin
  // convertirlo a Date (ver server/db.js) — no hace falta reformatear aquí.
  const { rows: asistencias } = await db.pool.query(
    `SELECT trabajador_id, fecha, estado FROM asistencia_diaria
     WHERE project_id = $1 AND fecha BETWEEN $2 AND $3`,
    [req.project.id, desde, hasta]
  );
  res.json({ desde, hasta, fecha_hoy: fechaHoy, granularidad: 'dia', trabajadores, asistencias });
}));

app.get('/api/projects/:id/asistencia', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('nominas', 'puede_ver')), h(async (req, res) => {
  const { fecha } = req.query;
  if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({ error: 'fecha requerida (YYYY-MM-DD)' });
  // Todos los trabajadores activos + su registro de asistencia para esa fecha
  const { rows } = await db.pool.query(`
    SELECT t.id, t.nombre, t.puesto, t.tipo_pago,
           COALESCE(a.estado, 'presente') AS estado,
           a.id AS asistencia_id
    FROM trabajadores t
    JOIN trabajador_obras o ON o.trabajador_id = t.id AND o.project_id = $1 AND o.activo = true
    LEFT JOIN asistencia_diaria a ON a.trabajador_id = t.id AND a.project_id = $1 AND a.fecha = $2
    WHERE t.activo = true
    ORDER BY t.orden, t.nombre`,
    [req.project.id, fecha]
  );
  res.json({ fecha, trabajadores: rows });
}));

// prompt-21-trabajadores-multiobra-diagnostico.md, Fase 0: salvaguarda contra
// pago duplicado. Originalmente (modelo 1:1) la única señal de "es la misma
// persona" entre obras era el CURP, cruzando entre filas DISTINTAS de
// trabajadores. Trabajadores sin CURP capturado no quedaban protegidos por
// ese cruce — limitación documentada, no un descuido.
//
// prompt-31-trabajador-multiobra-nn.md, bug real reproducido (Preview,
// datos reales) tras habilitar N:N: un mismo trabajador_id ahora puede estar
// asignado a 2+ obras a la vez, así que "la misma persona en dos obras el
// mismo día" ya no requiere CURP para detectarse — es literalmente la misma
// fila. El cruce por CURP nunca cubrió ese caso (solo comparaba entre filas
// de trabajadores distintas), así que un trabajador sin CURP capturado podía
// quedar "presente" en 2 obras el mismo día sin ningún rechazo. Fix: chequeo
// directo por trabajador_id PRIMERO (no depende de CURP, cubre el caso nuevo
// de N:N), y el cruce por CURP se conserva como fallback para el caso
// original de 2 trabajador_id distintos que resultan ser la misma persona.
// prompt-33/34, bug crítico reproducido con concurrencia real (Promise.all,
// no secuencial): dos transacciones marcando "presente" al mismo
// trabajador_id en 2 obras casi al mismo tiempo pueden AMBAS pasar el SELECT
// de abajo antes de que cualquiera haga COMMIT (READ COMMITTED, default de
// withTransaction, no lo evita) — 15/15 intentos concurrentes dejaban pasar
// el doble-presente sin ningún 409. pg_advisory_xact_lock serializa
// cualquier intento concurrente sobre el mismo (trabajador_id, fecha) sin
// importar la obra: la segunda transacción espera a que la primera haga
// COMMIT/ROLLBACK (el lock se libera solo, nunca a mano) y entonces sí ve la
// fila recién insertada por la primera. Mismo patrón que
// 'ctrl-ppto:initSchema' en server/db.js.
async function buscarConflictoAsistenciaSimultanea(client, { trabajadorId, projectId, fecha }) {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext('asistencia:' || $1::text || ':' || $2::text))`,
    [trabajadorId, fecha]
  );
  const { rows: mismoTrabajador } = await client.query(`
    SELECT p.nombre AS obra_nombre, t.nombre AS trabajador_nombre
    FROM asistencia_diaria ad
    JOIN trabajadores t ON t.id = ad.trabajador_id
    JOIN proyectos p ON p.id = ad.project_id
    WHERE ad.trabajador_id = $1 AND ad.fecha = $2 AND ad.estado = 'presente' AND ad.project_id <> $3
    LIMIT 1
  `, [trabajadorId, fecha, projectId]);
  if (mismoTrabajador[0]) return mismoTrabajador[0];

  const { rows: selfRows } = await client.query('SELECT curp FROM trabajadores WHERE id = $1', [trabajadorId]);
  const curp = selfRows[0]?.curp?.trim();
  if (!curp) return null;
  const { rows } = await client.query(`
    SELECT p.nombre AS obra_nombre, t2.nombre AS trabajador_nombre
    FROM asistencia_diaria ad
    JOIN trabajadores t2 ON t2.id = ad.trabajador_id
    JOIN proyectos p ON p.id = ad.project_id
    WHERE ad.fecha = $1 AND ad.estado = 'presente' AND ad.project_id <> $2 AND t2.curp = $3 AND ad.trabajador_id <> $4
    LIMIT 1
  `, [fecha, projectId, curp, trabajadorId]);
  return rows[0] || null;
}

app.put('/api/projects/:id/asistencia', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('nominas', 'puede_editar')), h(async (req, res) => {
  const { fecha, asistencia } = req.body || {};
  if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({ error: 'fecha inválida' });
  // prompt-calendario-asistencia-rangos-y-bloqueo.md, sección 3/4, con ajuste
  // explícito de Paul tras el diagnóstico (Stop Condition activado): residente/
  // cabo solo pueden capturar/corregir el día de hoy — admin/desarrollador
  // conservan la corrección retroactiva libre que ya existía (auth.allow()
  // arriba ya solo deja pasar residente/cabo/admin/desarrollador, así que
  // cualquier otro puesto no llega ni aquí). Se calcula en
  // America/Mexico_City, nunca new Date() crudo — mismo criterio que
  // marcadoMasivoAsistencia más abajo.
  if (req.user.puesto === 'residente' || req.user.puesto === 'cabo') {
    const hoyMx = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
    if (fecha !== hoyMx) {
      return res.status(403).json({ error: 'Solo se puede registrar asistencia del día en curso' });
    }
  }
  if (!Array.isArray(asistencia)) return res.status(400).json({ error: 'asistencia debe ser un arreglo' });
  // Validar que todos los trabajador_id del payload pertenecen a este proyecto
  const payloadIds = asistencia.map((item) => Number(item.trabajador_id));
  if (payloadIds.some((id) => !Number.isFinite(id) || id <= 0)) return res.status(400).json({ error: 'ID de trabajador inválido' });
  const uniqueIds = [...new Set(payloadIds)];
  const { rows: wCheck } = await db.pool.query(
    'SELECT trabajador_id FROM trabajador_obras WHERE trabajador_id = ANY($1) AND project_id=$2 AND activo=true',
    [uniqueIds, req.project.id]
  );
  if (wCheck.length !== uniqueIds.length) return res.status(400).json({ error: 'Uno o más trabajadores no pertenecen a esta obra' });
  // Verificar que la fecha no caiga dentro de una nómina aprobada
  const { rows: bloqRows } = await db.pool.query(
    `SELECT id FROM nominas WHERE project_id=$1 AND estado='aprobada' AND fecha_inicio<=$2 AND fecha_fin>=$2`,
    [req.project.id, fecha]
  );
  if (bloqRows.length) return res.status(409).json({ error: 'Esta fecha está cubierta por una nómina aprobada y no puede modificarse' });

  // 'sin_registro' cierra el ciclo de toggleCelda() (vacío -> presente ->
  // falta_just -> falta_injust -> sin_registro -> ...) sin necesidad de un
  // DELETE: se guarda como fila real (conserva capturado_por/actualizado_en
  // para auditoría de quién "desmarcó" una celda), pero para todo cálculo de
  // nómina/reporte se comporta exactamente como si la fila no existiera —
  // ver ESTADO_PAGA en /nominas/:nomId/calcular, que solo cuenta
  // estado='presente' (cualquier otro valor, incluido este, ya quedaba
  // fuera del conteo por diseño).
  const ESTADOS_ASIST = ['presente', 'falta_justificada', 'falta_injustificada', 'sin_registro'];
  await db.withTransaction(async (client) => {
    for (const item of asistencia) {
      const wId = Number(item.trabajador_id);
      const estado = ESTADOS_ASIST.includes(item.estado) ? item.estado : 'presente';
      const presente = estado === 'presente'; // columna legada, mantener sincronizada
      if (presente) {
        const conflicto = await buscarConflictoAsistenciaSimultanea(client, { trabajadorId: wId, projectId: req.project.id, fecha });
        if (conflicto) {
          const err = new Error(`${conflicto.trabajador_nombre} ya está marcado presente hoy en "${conflicto.obra_nombre}" — no puede quedar presente en dos obras el mismo día`);
          err.status = 409;
          throw err;
        }
      }
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

// Marcado masivo de asistencia (prompt-marcado-masivo-asistencia.md) —
// "Marcar todos" / "Desmarcar todos" del calendario de asistencia diaria.
// Deliberadamente SIN parámetro de fecha en el body: la fecha SIEMPRE es la
// de hoy calculada en el servidor, para que sea imposible que el cliente
// aplique el marcado masivo a otro día (aunque lo intente). Se calcula en
// zona horaria America/Mexico_City (no new Date().toISOString(), que es UTC
// crudo) para que coincida con el "hoy" del navegador del usuario (frontend
// usa hora local vía toLocaleDateString) — encontrado durante verificación:
// cerca de medianoche, UTC ya es un día distinto al de México (UTC-6),
// desincronizando el label del botón del día real que aplicaría el backend.
// Reutiliza el mismo criterio de "trabajadores activos" que /asistencia-rango
// (activo = true) y el mismo bloqueo por nómina aprobada que el PUT de
// arriba, por consistencia — no se duplica la lógica de ESTADOS_ASIST/UPSERT
// del PUT existente porque ese endpoint no se toca (Forbidden Actions).
async function marcadoMasivoAsistencia(req, res, estado) {
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
  const { rows: bloqRows } = await db.pool.query(
    `SELECT id FROM nominas WHERE project_id=$1 AND estado='aprobada' AND fecha_inicio<=$2 AND fecha_fin>=$2`,
    [req.project.id, hoy]
  );
  if (bloqRows.length) return res.status(409).json({ error: 'Esta fecha está cubierta por una nómina aprobada y no puede modificarse' });

  const { rows: trabajadores } = await db.pool.query(
    `SELECT t.id FROM trabajadores t
     JOIN trabajador_obras o ON o.trabajador_id = t.id AND o.project_id = $1 AND o.activo = true
     WHERE t.activo = true`,
    [req.project.id]
  );
  const presente = estado === 'presente';
  // prompt-21-trabajadores-multiobra-diagnostico.md, Fase 0: a diferencia del
  // PUT de arriba (bloqueo duro, edición deliberada de un renglón), aquí
  // "marcar todos" afecta a toda la cuadrilla de un jalón — abortar el lote
  // completo por un solo conflicto sería demasiado disruptivo para captura
  // diaria. En vez de eso, se omite solo al trabajador en conflicto y se
  // reporta explícitamente en la respuesta (nunca en silencio).
  const omitidos = [];
  await db.withTransaction(async (client) => {
    for (const t of trabajadores) {
      if (presente) {
        const conflicto = await buscarConflictoAsistenciaSimultanea(client, { trabajadorId: t.id, projectId: req.project.id, fecha: hoy });
        if (conflicto) {
          omitidos.push({ trabajador_id: t.id, motivo: `ya presente hoy en "${conflicto.obra_nombre}"` });
          continue;
        }
      }
      await client.query(`
        INSERT INTO asistencia_diaria (project_id, trabajador_id, fecha, presente, estado, capturado_por, actualizado_en)
        VALUES ($1,$2,$3,$4,$5,$6,NOW())
        ON CONFLICT (project_id, trabajador_id, fecha)
        DO UPDATE SET presente=EXCLUDED.presente, estado=EXCLUDED.estado,
                      capturado_por=EXCLUDED.capturado_por, actualizado_en=NOW()`,
        [req.project.id, t.id, hoy, presente, estado, req.user.id]
      );
    }
  });
  res.json({ ok: true, fecha: hoy, estado, afectados: trabajadores.length - omitidos.length, omitidos });
}

app.post('/api/projects/:id/asistencia/marcar-todos', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('nominas', 'puede_editar')), h(async (req, res) => {
  await marcadoMasivoAsistencia(req, res, 'presente');
}));

app.post('/api/projects/:id/asistencia/desmarcar-todos', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('nominas', 'puede_editar')), h(async (req, res) => {
  await marcadoMasivoAsistencia(req, res, 'sin_registro');
}));

// ===========================================================================
// NÓMINAS
// ===========================================================================
// prompt-cancelar-nomina-implementacion.md: 'cancelada' es soft-delete
// (mismo patrón ya usado en Requisiciones) para una nómina capturada por
// error en 'borrador'/'revision' -- NUNCA se agrega la transición
// aprobada→cancelada (una aprobada ya es "dinero real" en Erogado Real y en
// el Reporte de Maquinaria por cliente; revertir eso es una decisión de
// negocio aparte, no este cambio).
const ESTADOS_NOMINA = ['borrador', 'revision', 'aprobada', 'rechazada', 'cancelada'];

// Vista global: todas las nóminas de todas las obras y todos los residentes
// (a diferencia de GET /projects/:id/nominas, que un residente solo ve las
// propias de su obra). Incluye cliente y residente(s) a cargo de la obra
// (no necesariamente el mismo usuario que creó esta nómina en particular —
// ver nota en GET /api/trabajadores sobre más de un residente por obra) para
// poder agrupar Cliente → Obra → Residente(s) → Trabajadores en el frontend.
// checkPermiso('nominas_global', 'puede_ver') reemplaza el auth.allow()
// anterior (admin/desarrollador-only) — prompts-cotizador-permisos.md
// Prompt 2. Sección DISTINTA de 'nominas' (que gatea el acceso por-obra):
// ver comentario en server/auth.js SECCIONES_PERMISOS.
app.get('/api/nominas', h(auth.checkPermiso('nominas_global', 'puede_ver')), h(async (_req, res) => {
  const { rows } = await db.pool.query(`
    SELECT n.*,
           p.nombre AS obra_nombre,
           cl.nombre AS cliente_nombre,
           c.nombre AS creado_por_nombre,
           u.nombre AS aprobada_por_nombre,
           (SELECT string_agg(ru.nombre, ', ' ORDER BY ru.nombre)
            FROM usuario_proyectos up JOIN usuarios ru ON ru.id = up.usuario_id
            WHERE up.project_id = n.project_id AND ru.puesto = 'residente') AS residentes_a_cargo,
           COUNT(ni.id)::int AS num_trabajadores,
           COALESCE(SUM(ni.monto_total), 0) AS total_nomina
    FROM nominas n
    JOIN proyectos p ON p.id = n.project_id
    LEFT JOIN clientes cl ON cl.id = p.cliente_id
    LEFT JOIN usuarios c ON c.id = n.creado_por
    LEFT JOIN usuarios u ON u.id = n.aprobada_por
    LEFT JOIN nomina_items ni ON ni.nomina_id = n.id
    GROUP BY n.id, p.nombre, cl.nombre, c.nombre, u.nombre
    ORDER BY COALESCE(cl.nombre, ''), p.nombre, n.fecha_inicio DESC`
  );
  res.json(rows);
}));

// Helper compartido por la vista en-app y ambos formatos de descarga (Excel/
// PDF) — un solo lugar que arma el reporte, para no duplicar la consulta.
// "Obra activa" = fin_obra nulo o >= HOY (mismo criterio ya usado para la
// alerta de contrato vencido, evaluado contra la fecha actual sin importar
// qué semana histórica se esté consultando — una sola definición de
// "activa" en toda la app, decisión confirmada con Paul).
async function construirReporteNominaSemanal(clienteId, fecha) {
  const { rows: clienteRows } = await db.pool.query('SELECT * FROM clientes WHERE id = $1', [clienteId]);
  if (!clienteRows[0]) return null;

  const { rows: obras } = await db.pool.query(`
    SELECT p.id, p.nombre,
           (SELECT valor FROM meta WHERE project_id = p.id AND clave = 'fin_obra') AS fin_obra
    FROM proyectos p
    WHERE p.cliente_id = $1
    ORDER BY p.nombre`,
    [clienteId]
  );
  const hoy = new Date().toISOString().slice(0, 10);
  const obrasActivas = obras.filter((o) => !o.fin_obra || o.fin_obra >= hoy);

  const reporteObras = [];
  for (const obra of obrasActivas) {
    const { rows: residRows } = await db.pool.query(
      `SELECT u.nombre FROM usuario_proyectos up JOIN usuarios u ON u.id = up.usuario_id
       WHERE up.project_id = $1 AND u.puesto = 'residente' ORDER BY u.nombre`,
      [obra.id]
    );
    const { rows: nominaRows } = await db.pool.query(
      `SELECT * FROM nominas WHERE project_id = $1 AND fecha_inicio <= $2 AND fecha_fin >= $2 ORDER BY fecha_inicio DESC`,
      [obra.id, fecha]
    );
    const nominasConDetalle = [];
    for (const nom of nominaRows) {
      const { rows: items } = await db.pool.query(
        `SELECT ni.*, t.nombre AS trabajador_nombre, t.puesto AS trabajador_puesto
         FROM nomina_items ni JOIN trabajadores t ON t.id = ni.trabajador_id
         WHERE ni.nomina_id = $1 ORDER BY t.nombre`,
        [nom.id]
      );
      nominasConDetalle.push({ ...nom, items });
    }
    const totalObra = nominasConDetalle.reduce(
      (s, n) => s + n.items.reduce((s2, i) => s2 + Number(i.monto_total), 0), 0
    );
    reporteObras.push({
      obra_id: obra.id,
      obra_nombre: obra.nombre,
      residentes_a_cargo: residRows.map((r) => r.nombre).join(', '),
      nominas: nominasConDetalle,
      total_obra: totalObra,
    });
  }
  const totalCliente = reporteObras.reduce((s, o) => s + o.total_obra, 0);
  return { cliente: clienteRows[0], fecha, obras: reporteObras, total_cliente: totalCliente };
}

// Reporte de nómina semanal por cliente — filtrable por fecha (cualquier día
// dentro de la semana deseada; se buscan las nóminas de cada obra activa
// cuyo periodo [fecha_inicio, fecha_fin] contiene esa fecha, ya que cada obra
// puede tener su propio calendario de periodos). Solo lectura — no toca la
// lógica de captura/cálculo de nómina existente.
app.get('/api/clientes/:id/nominas-reporte-semanal', h(auth.allow()), h(async (req, res) => {
  const clienteId = Number(req.params.id);
  const { fecha } = req.query;
  if (!fecha) return res.status(400).json({ error: 'Indica la fecha de la semana a consultar' });
  const reporte = await construirReporteNominaSemanal(clienteId, fecha);
  if (!reporte) return res.status(404).json({ error: 'Cliente no encontrado' });
  res.json(reporte);
}));

app.get('/api/clientes/:id/nominas-reporte-semanal/export', h(auth.allow()), h(async (req, res) => {
  const clienteId = Number(req.params.id);
  const { fecha } = req.query;
  if (!fecha) return res.status(400).json({ error: 'Indica la fecha de la semana a consultar' });
  const reporte = await construirReporteNominaSemanal(clienteId, fecha);
  if (!reporte) return res.status(404).json({ error: 'Cliente no encontrado' });

  const rows = [];
  for (const obra of reporte.obras) {
    for (const nom of obra.nominas) {
      for (const it of nom.items) {
        rows.push({
          obra: obra.obra_nombre,
          residentes: obra.residentes_a_cargo,
          periodo: `${nom.fecha_inicio} al ${nom.fecha_fin}`,
          trabajador: it.trabajador_nombre,
          puesto: it.trabajador_puesto || '',
          dias_trabajados: it.dias_trabajados,
          monto_jornal: it.monto_jornal,
          monto_destajo: it.monto_destajo,
          monto_total: it.monto_total,
        });
      }
    }
  }
  await sendXlsxExport(res, {
    filename: buildExportFilename(`NominaSemanal_${reporte.cliente.nombre}_${fecha}`),
    sheets: [{
      sheetName: 'Reporte semanal',
      columns: [
        { header: 'Obra', key: 'obra', width: 26 },
        { header: 'Residente(s) a cargo', key: 'residentes', width: 24 },
        { header: 'Periodo', key: 'periodo', width: 22 },
        { header: 'Trabajador', key: 'trabajador', width: 26 },
        { header: 'Puesto', key: 'puesto', width: 18 },
        { header: 'Días trabajados', key: 'dias_trabajados', width: 14, format: 'int' },
        { header: 'Monto jornal', key: 'monto_jornal', width: 16, format: 'money' },
        { header: 'Monto destajo', key: 'monto_destajo', width: 16, format: 'money' },
        { header: 'Total', key: 'monto_total', width: 16, format: 'money' },
      ],
      rows,
    }],
  });
}));

app.get('/api/clientes/:id/nominas-reporte-semanal/export-pdf', h(auth.allow()), h(async (req, res) => {
  const clienteId = Number(req.params.id);
  const { fecha } = req.query;
  if (!fecha) return res.status(400).json({ error: 'Indica la fecha de la semana a consultar' });
  const reporte = await construirReporteNominaSemanal(clienteId, fecha);
  if (!reporte) return res.status(404).json({ error: 'Cliente no encontrado' });

  const pdfBuffer = await buildNominaReporteSemanalPdf(reporte);
  const filename = buildExportFilename(`NominaSemanal_${reporte.cliente.nombre}_${fecha}`).replace(/\.xlsx$/, '.pdf');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(pdfBuffer);
}));

// Reporte de días trabajados por obra/cliente para SIROC mensual (prompt-45
// -reporte-dias-trabajados-siroc.md, ampliado en prompt-46-siroc-consolidado-
// mensual.md a un rango de meses con vista consolidada cross-cliente/obra,
// mismo patrón sin preselección que maquinaria.getReportePorCliente() —
// itera TODOS los clientes/obras, cliente_id/project_id quedan como filtros
// opcionales). "Día trabajado" = estado='presente' en asistencia_diaria
// (mismo criterio que ya usa nómina para pagar — confirmado con Paul,
// falta_justificada/falta_injustificada/sin_registro NO cuentan, SIN CAMBIOS
// en este prompt). admin/desarrollador-only (mismo nivel que el reporte de
// Nómina semanal por cliente de arriba, SIN CAMBIOS). Con el modelo N:N
// trabajador-obra (PR #111) cada fila de asistencia_diaria ya trae su propio
// project_id, así que el desglose por obra sale directo del GROUP BY.
function mesesEnRango(desde, hasta) {
  const [anioIni, mesIni] = desde.split('-').map(Number);
  const [anioFin, mesFin] = hasta.split('-').map(Number);
  const meses = [];
  let anio = anioIni, mes = mesIni;
  while (anio < anioFin || (anio === anioFin && mes <= mesFin)) {
    meses.push({ anio, mes, clave: `${anio}-${String(mes).padStart(2, '0')}` });
    mes++;
    if (mes > 12) { mes = 1; anio++; }
  }
  return meses;
}

async function construirReporteDiasTrabajados(desde, hasta, { clienteId, projectId } = {}) {
  const meses = mesesEnRango(desde, hasta);
  const clavesMeses = meses.map((m) => m.clave);
  const fechaInicio = `${desde}-01`;
  const [anioFin, mesFin] = hasta.split('-').map(Number);
  const fechaFin = new Date(Date.UTC(anioFin, mesFin, 0)).toISOString().slice(0, 10); // último día del mes "hasta"

  const params = [fechaInicio, fechaFin];
  let filtro = '';
  if (clienteId) { params.push(clienteId); filtro += ` AND c.id = $${params.length}`; }
  if (projectId) { params.push(projectId); filtro += ` AND p.id = $${params.length}`; }

  const { rows } = await db.pool.query(`
    SELECT
      c.id AS cliente_id, c.nombre AS cliente_nombre,
      p.id AS project_id, p.nombre AS obra_nombre,
      t.id AS trabajador_id, t.nombre AS trabajador_nombre,
      t.curp, t.nss, t.puesto,
      to_char(a.fecha, 'YYYY-MM') AS mes_clave,
      COUNT(*) FILTER (WHERE a.estado = 'presente') AS dias_trabajados
    FROM asistencia_diaria a
    JOIN trabajadores t ON t.id = a.trabajador_id
    JOIN proyectos p ON p.id = a.project_id
    JOIN clientes c ON c.id = p.cliente_id
    WHERE a.fecha BETWEEN $1 AND $2 ${filtro}
    GROUP BY c.id, c.nombre, p.id, p.nombre, t.id, t.nombre, t.curp, t.nss, t.puesto, mes_clave
    HAVING COUNT(*) FILTER (WHERE a.estado = 'presente') > 0
    ORDER BY c.nombre, p.nombre, t.nombre, mes_clave
  `, params);

  const porMesVacio = () => Object.fromEntries(clavesMeses.map((c) => [c, 0]));
  const clientesMap = new Map();
  const trabajadoresMap = new Map();
  for (const r of rows) {
    const dias = Number(r.dias_trabajados);
    if (!clientesMap.has(r.cliente_id)) {
      clientesMap.set(r.cliente_id, { cliente_id: r.cliente_id, cliente_nombre: r.cliente_nombre, total_dias: 0, obras: new Map() });
    }
    const cli = clientesMap.get(r.cliente_id);
    if (!cli.obras.has(r.project_id)) {
      cli.obras.set(r.project_id, { project_id: r.project_id, obra_nombre: r.obra_nombre, total_dias: 0, trabajadores: new Map() });
    }
    const obra = cli.obras.get(r.project_id);
    if (!obra.trabajadores.has(r.trabajador_id)) {
      obra.trabajadores.set(r.trabajador_id, {
        trabajador_id: r.trabajador_id, nombre: r.trabajador_nombre,
        curp: r.curp, nss: r.nss, puesto: r.puesto, total_dias: 0, por_mes: porMesVacio(),
      });
    }
    const tw = obra.trabajadores.get(r.trabajador_id);
    tw.por_mes[r.mes_clave] = dias;
    tw.total_dias += dias;
    obra.total_dias += dias;
    cli.total_dias += dias;

    // Consolidado por trabajador (relevante cuando trabajó en 2+ obras del
    // mismo cliente en el mismo rango, modelo N:N — desglose sin mezclar
    // días; por_mes suma entre obras si coincide el mes).
    if (!trabajadoresMap.has(r.trabajador_id)) {
      trabajadoresMap.set(r.trabajador_id, {
        trabajador_id: r.trabajador_id, nombre: r.trabajador_nombre,
        curp: r.curp, nss: r.nss, puesto: r.puesto, total_dias: 0, por_mes: porMesVacio(), obras: [],
      });
    }
    const twg = trabajadoresMap.get(r.trabajador_id);
    twg.total_dias += dias;
    twg.por_mes[r.mes_clave] = (twg.por_mes[r.mes_clave] || 0) + dias;
    twg.obras.push({ project_id: r.project_id, obra_nombre: r.obra_nombre, cliente_nombre: r.cliente_nombre, mes_clave: r.mes_clave, dias_trabajados: dias });
  }

  const clientes = [...clientesMap.values()].map((c) => ({
    ...c, obras: [...c.obras.values()].map((o) => ({ ...o, trabajadores: [...o.trabajadores.values()] })),
  }));
  return { desde, hasta, meses, clientes, trabajadores_consolidado: [...trabajadoresMap.values()] };
}

// YYYY-MM, desde <= hasta — validación compartida por ambos endpoints.
function parseRangoMeses(query) {
  const { desde, hasta } = query;
  if (!/^\d{4}-\d{2}$/.test(desde || '') || !/^\d{4}-\d{2}$/.test(hasta || '')) {
    return { error: 'Indica desde y hasta en formato YYYY-MM' };
  }
  if (hasta < desde) return { error: 'El mes "hasta" debe ser igual o posterior a "desde"' };
  return {
    desde, hasta,
    clienteId: query.cliente_id ? Number(query.cliente_id) : null,
    projectId: query.project_id ? Number(query.project_id) : null,
  };
}

app.get('/api/reporte-dias-trabajados', h(auth.allow()), h(async (req, res) => {
  const parsed = parseRangoMeses(req.query);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { desde, hasta, clienteId, projectId } = parsed;
  const reporte = await construirReporteDiasTrabajados(desde, hasta, { clienteId, projectId });
  res.json(reporte);
}));

app.get('/api/reporte-dias-trabajados/export', h(auth.allow()), h(async (req, res) => {
  const parsed = parseRangoMeses(req.query);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { desde, hasta, clienteId, projectId } = parsed;
  // Vista activa en pantalla — el export debe reflejarla tal cual (prompt-46,
  // CP3): 'comparativo' agrega una columna por mes, 'acumulado' (default)
  // solo el total del rango.
  const vista = req.query.vista === 'comparativo' ? 'comparativo' : 'acumulado';
  const reporte = await construirReporteDiasTrabajados(desde, hasta, { clienteId, projectId });

  const columnasBase = [
    { header: 'Cliente', key: 'cliente', width: 26 },
    { header: 'Obra', key: 'obra', width: 26 },
    { header: 'Trabajador', key: 'trabajador', width: 26 },
    { header: 'CURP', key: 'curp', width: 20 },
    { header: 'NSS', key: 'nss', width: 16 },
    { header: 'Puesto', key: 'puesto', width: 18 },
  ];
  const columnasMeses = vista === 'comparativo'
    ? reporte.meses.map((m) => ({ header: m.clave, key: `mes_${m.clave}`, width: 12, format: 'int' }))
    : [];
  const columnaTotal = { header: vista === 'comparativo' ? 'Total' : 'Días trabajados', key: 'total', width: 14, format: 'int' };

  const rows = [];
  for (const cliente of reporte.clientes) {
    for (const obra of cliente.obras) {
      for (const t of obra.trabajadores) {
        const row = {
          cliente: cliente.cliente_nombre, obra: obra.obra_nombre, trabajador: t.nombre,
          curp: t.curp || '', nss: t.nss || '', puesto: t.puesto || '', total: t.total_dias,
        };
        if (vista === 'comparativo') {
          for (const m of reporte.meses) row[`mes_${m.clave}`] = t.por_mes[m.clave] || 0;
        }
        rows.push(row);
      }
    }
  }
  await sendXlsxExport(res, {
    filename: buildExportFilename(`DiasTrabajadosSIROC_${desde}_a_${hasta}`),
    sheets: [{
      sheetName: 'Días trabajados',
      columns: [...columnasBase, ...columnasMeses, columnaTotal],
      rows,
    }],
  });
}));

app.get('/api/projects/:id/nominas', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('nominas', 'puede_ver')), h(async (req, res) => {
  // Un residente solo ve las nóminas que él mismo creó — verificarAccesoObra ya
  // garantiza que está asignado a esta obra, pero varios residentes pueden
  // compartir la misma obra y no deben ver las nóminas del otro (admin/dev
  // pasan checkPermiso por bypass y sí ven todas las de la obra).
  const soloPropias = req.user.puesto === 'residente';
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
    WHERE n.project_id = $1 AND ($2::boolean = false OR n.creado_por = $3)
    GROUP BY n.id, u.nombre, c.nombre
    ORDER BY n.fecha_inicio DESC`,
    [req.project.id, soloPropias, req.user.id]
  );
  res.json(rows);
}));

app.post('/api/projects/:id/nominas', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('nominas', 'puede_crear')), h(async (req, res) => {
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

// prompt-29-split-pago-cuentas.md: adjunta el desglose de pago por cuenta
// (monto_cuenta_nomina/monto_cuenta_alterna + banco de cada una) a items de
// nomina_items ya calculados, SIN tocar monto_total ni el cálculo base.
// Mismo gate que el resto de datos bancarios (trabajadores_bancarios,
// prompt-p5-cuentas-bancarias.md) — sin ese permiso, ni el desglose ni los
// campos crudos de cuenta_alterna/split se exponen (CP4 del prompt).
async function adjuntarDesgloseCuentas(req, items) {
  const puedeVerBancarios = await auth.tienePermiso(req, 'trabajadores_bancarios', 'puede_ver');
  return items.map((it) => {
    const { cuenta_nomina_hsbc, cuenta_alterna, banco_nomina, banco_alterna,
            tarjeta_nomina, tarjeta_alterna, split_cuenta_nomina_pct, ...resto } = it;
    if (!puedeVerBancarios) return resto;
    const tieneAlterna = !!(cuenta_alterna && cuenta_alterna.trim());
    const { montoCuentaNomina, montoCuentaAlterna } = calcularSplitCuentas(
      Number(it.monto_total), split_cuenta_nomina_pct, tieneAlterna
    );
    return {
      ...resto,
      monto_cuenta_nomina: montoCuentaNomina,
      monto_cuenta_alterna: montoCuentaAlterna,
      banco_nomina: banco_nomina || null,
      banco_alterna: tieneAlterna ? (banco_alterna || null) : null,
      // prompt-35-numero-cuenta-export-nomina.md: número de cuenta/CLABE Y
      // tarjeta junto a cada banco — el export ya traía banco+monto pero
      // nunca el número real. Mismo criterio tieneAlterna que banco_alterna:
      // sin cuenta_alterna capturada, la columna alterna queda vacía aunque
      // hubiera una tarjeta_alterna suelta (sin cuenta rectora no hay a qué
      // "alterna" referirse).
      cuenta_nomina_hsbc: cuenta_nomina_hsbc || null,
      tarjeta_nomina: tarjeta_nomina || null,
      cuenta_alterna: tieneAlterna ? cuenta_alterna : null,
      tarjeta_alterna: tieneAlterna ? (tarjeta_alterna || null) : null,
    };
  });
}

app.get('/api/projects/:id/nominas/:nomId', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('nominas', 'puede_ver')), h(async (req, res) => {
  const nomId = Number(req.params.nomId);
  // Mismo criterio que la lista: un residente no puede abrir por ID el detalle
  // de una nómina creada por otro residente de la misma obra.
  const soloPropias = req.user.puesto === 'residente';
  const { rows: nomRows } = await db.pool.query(
    'SELECT n.*, u.nombre AS aprobada_por_nombre FROM nominas n LEFT JOIN usuarios u ON u.id=n.aprobada_por WHERE n.id=$1 AND n.project_id=$2 AND ($3::boolean = false OR n.creado_por = $4)',
    [nomId, req.project.id, soloPropias, req.user.id]
  );
  if (!nomRows[0]) return res.status(404).json({ error: 'Nómina no encontrada' });
  const { rows: items } = await db.pool.query(`
    SELECT ni.*, t.nombre AS trabajador_nombre, t.tipo_pago, t.tarifa_jornal, t.periodicidad,
           t.cuenta_nomina_hsbc, t.cuenta_alterna, t.banco_nomina, t.banco_alterna,
           t.tarjeta_nomina, t.tarjeta_alterna, t.split_cuenta_nomina_pct
    FROM nomina_items ni
    JOIN trabajadores t ON t.id = ni.trabajador_id
    WHERE ni.nomina_id = $1
    ORDER BY t.nombre`,
    [nomId]
  );
  res.json({ ...nomRows[0], items: await adjuntarDesgloseCuentas(req, items) });
}));

app.post('/api/projects/:id/nominas/:nomId/calcular', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('nominas', 'puede_editar')), h(async (req, res) => {
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
    `SELECT t.* FROM trabajadores t
     JOIN trabajador_obras o ON o.trabajador_id = t.id AND o.project_id=$1 AND o.activo=true
     WHERE t.activo=true ORDER BY t.nombre, t.id`,
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

  // Destajo acumulado por DESTAJISTA (no por trabajador) desde avance_destajo
  // para semanas que solapan el periodo. prompt-fix-distribucion-destajo-
  // nomina.md: antes se agrupaba por t.id, así que cada trabajador vinculado
  // al mismo destajista_id disparaba su propio JOIN contra destajo_items/
  // avance_destajo y recibía el total completo — bug de duplicación/
  // triplicación cuando varios trabajadores comparten un destajista. Agrupar
  // por destajista_id da un solo total por destajista, que luego se reparte
  // en JS con distribuirDestajoGrupo().
  const destajistaIdsRelevantes = [...new Set(
    trabajadores
      .filter((t) => (t.tipo_pago === 'destajo' || t.tipo_pago === 'mixto') && t.destajista_id)
      .map((t) => t.destajista_id)
  )];
  const { rows: destajoRows } = await db.pool.query(`
    SELECT dest.id AS destajista_id, dest.nombre AS destajista_nombre,
           COALESCE(SUM(ad.cantidad_ejecutada * di.precio_destajo), 0) AS monto_destajo
    FROM destajistas dest
    JOIN destajo_items di ON di.destajista_id = dest.id
    JOIN avance_destajo ad ON ad.destajo_item_id = di.id
    JOIN avances_semanales av ON av.semana = ad.semana AND av.project_id = $1
    WHERE dest.project_id = $1 AND dest.id = ANY($4::int[])
      AND av.fecha_inicio <= $3 AND av.fecha_fin >= $2
    GROUP BY dest.id, dest.nombre`,
    [req.project.id, nom.fecha_inicio, nom.fecha_fin, destajistaIdsRelevantes]
  );

  // Reparte cada total por destajista entre sus trabajadores vinculados
  // (ver distribuirDestajoGrupo en server/calculos.js para la regla completa
  // de $500 mínimo por vinculado + remanente al principal, y los edge cases
  // de remanente negativo / principal no identificable por nombre).
  const montoDestPorTrabajador = new Map();
  const alertaDestPorTrabajador = new Map();
  for (const row of destajoRows) {
    const grupo = trabajadores.filter((t) => t.destajista_id === row.destajista_id && (t.tipo_pago === 'destajo' || t.tipo_pago === 'mixto'));
    const reparto = distribuirDestajoGrupo(Number(row.monto_destajo), grupo, row.destajista_nombre);
    reparto.forEach((r) => {
      montoDestPorTrabajador.set(r.id, r.monto);
      if (r.alerta) alertaDestPorTrabajador.set(r.id, r.alerta);
    });
  }

  await db.withTransaction(async (client) => {
    // Eliminar items previos para recalcular limpio
    await client.query('DELETE FROM nomina_items WHERE nomina_id=$1', [nomId]);
    for (const t of trabajadores) {
      const dias = asistMap.get(t.id) || 0;
      const montoDest = (t.tipo_pago === 'destajo' || t.tipo_pago === 'mixto') ? (montoDestPorTrabajador.get(t.id) || 0) : 0;
      const montoJornal = (t.tipo_pago === 'jornal' || t.tipo_pago === 'mixto') ? calcularJornal(dias, t.tarifa_jornal) : 0;
      const total = montoJornal + montoDest;
      const alertaDestajo = alertaDestPorTrabajador.get(t.id) || null;
      await client.query(`
        INSERT INTO nomina_items (nomina_id, trabajador_id, dias_trabajados, monto_jornal, monto_destajo, monto_total, alerta_destajo)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [nomId, t.id, dias, montoJornal, montoDest, total, alertaDestajo]
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

app.put('/api/projects/:id/nominas/:nomId/estado', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('nominas', 'puede_editar')), h(async (req, res) => {
  const nomId = Number(req.params.nomId);
  const { estado, nota_rechazo } = req.body || {};
  if (!ESTADOS_NOMINA.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
  const { rows: nomRows } = await db.pool.query('SELECT * FROM nominas WHERE id=$1 AND project_id=$2', [nomId, req.project.id]);
  if (!nomRows[0]) return res.status(404).json({ error: 'Nómina no encontrada' });
  const nom = nomRows[0];
  const esAdmin = req.user.puesto === 'admin';
  const esResidente = req.user.puesto === 'residente';
  const esCabo = req.user.puesto === 'cabo';

  // Máquina de estados y validación de rol
  // prompt-cancelar-nomina-implementacion.md: cancelar es admin-only, solo
  // desde borrador/revision -- nunca desde aprobada (fuera de alcance).
  const transicionesPermitidas = {
    borrador:  { revision: true, cancelada: esAdmin },
    revision:  { aprobada: esAdmin, rechazada: esAdmin, borrador: esAdmin, cancelada: esAdmin },
    rechazada: { borrador: true },                    // residente, cabo o admin
    aprobada:  { borrador: esAdmin },                 // solo admin puede reabrir
  };
  if (!transicionesPermitidas[nom.estado]?.[estado]) {
    return res.status(403).json({ error: `No puedes cambiar de '${nom.estado}' a '${estado}'` });
  }
  // Residente/cabo solo pueden enviar a revisión (mismo límite para ambos —
  // ninguno de los dos puede aprobar/rechazar/reabrir/cancelar, eso sigue
  // siendo exclusivo de admin vía esAdmin arriba).
  if ((esResidente || esCabo) && !['revision'].includes(estado)) {
    return res.status(403).json({ error: 'Este rol solo puede enviar la nómina a revisión' });
  }
  // Motivo obligatorio para cancelar (nota_rechazo reusado en este contexto
  // como "motivo de cancelación") -- a diferencia de rechazar, que lo deja
  // opcional, cancelar es más definitivo y Paul pidió que siempre se explique.
  if (estado === 'cancelada' && !nota_rechazo?.trim()) {
    return res.status(400).json({ error: 'La cancelación requiere un motivo' });
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

// prompt-25-auditoria-permisos-completa.md: era la única acción de Nóminas
// sin checkPermiso — auth.allow() sin argumentos la dejaba admin/desarrollador-
// only de facto, así que 'nominas.puede_eliminar' otorgado a un residente/cabo
// no tenía ningún efecto real (el 403 llegaba antes, por el gate de rol, ni
// siquiera evaluaba el permiso granular). Mismo patrón que el resto de Nóminas.
app.delete('/api/projects/:id/nominas/:nomId', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('nominas', 'puede_eliminar')), h(async (req, res) => {
  const nomId = Number(req.params.nomId);
  const { rows: nomRows } = await db.pool.query('SELECT estado FROM nominas WHERE id=$1 AND project_id=$2', [nomId, req.project.id]);
  if (!nomRows[0]) return res.status(404).json({ error: 'Nómina no encontrada' });
  // prompt-cancelar-nomina-implementacion.md: acotado a 'borrador' únicamente
  // (antes permitía también 'revision'/'rechazada') -- mismo patrón que el
  // DELETE de Requisiciones. Cualquier nómina que ya salió de 'borrador' se
  // cancela (soft-delete vía PUT /estado), nunca se borra físicamente.
  if (nomRows[0].estado !== 'borrador') {
    return res.status(400).json({ error: 'Solo se pueden eliminar nóminas en estado "borrador"' });
  }
  await db.pool.query('DELETE FROM nominas WHERE id=$1', [nomId]);
  res.json({ ok: true });
}));

// prompt-25-auditoria-permisos-completa.md: mismo gap que el DELETE de
// arriba — exportar es una acción de lectura (mismo criterio que el resto
// de módulos, ej. insumos/export), así que usa puede_ver, no puede_eliminar.
app.get('/api/projects/:id/nominas/:nomId/export', h(auth.allow('residente', 'cabo')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('nominas', 'puede_ver')), h(async (req, res) => {
  const { rows: rlNom } = await db.pool.query(
    `SELECT COUNT(*)::int AS n FROM api_rate_limits
     WHERE usuario_id = $1 AND endpoint = 'export_nominas'
       AND creado_en > NOW() - INTERVAL '1 hour'`,
    [req.user.id]
  );
  if (rlNom[0].n >= EXPORT_RATE_LIMIT) {
    return res.status(429).json({ error: `Límite de exports alcanzado (${EXPORT_RATE_LIMIT} por hora). Intenta más tarde.` });
  }
  await db.pool.query('INSERT INTO api_rate_limits (usuario_id, endpoint) VALUES ($1, $2)', [req.user.id, 'export_nominas']);
  const nomId = Number(req.params.nomId);
  const { rows: nomRows } = await db.pool.query('SELECT * FROM nominas WHERE id=$1 AND project_id=$2', [nomId, req.project.id]);
  if (!nomRows[0]) return res.status(404).json({ error: 'Nómina no encontrada' });
  if (nomRows[0].estado !== 'aprobada') return res.status(409).json({ error: 'Solo se puede exportar una nómina aprobada' });
  const { rows: itemsRaw } = await db.pool.query(`
    SELECT t.nombre AS trabajador, t.puesto, t.tipo_pago, t.periodicidad,
           ni.dias_trabajados, ni.monto_jornal, ni.monto_destajo, ni.monto_total,
           t.cuenta_nomina_hsbc, t.cuenta_alterna, t.banco_nomina, t.banco_alterna,
           t.tarjeta_nomina, t.tarjeta_alterna, t.split_cuenta_nomina_pct
    FROM nomina_items ni JOIN trabajadores t ON t.id=ni.trabajador_id
    WHERE ni.nomina_id=$1 ORDER BY t.nombre`, [nomId]
  );
  const items = await adjuntarDesgloseCuentas(req, itemsRaw);
  const nom = nomRows[0];
  const filename = buildExportFilename(`Nomina_${nom.fecha_inicio}_${nom.fecha_fin}`, req.project.nombre);
  const columns = [
    { header: 'Trabajador', key: 'trabajador', width: 30 },
    { header: 'Puesto', key: 'puesto', width: 20 },
    { header: 'Tipo pago', key: 'tipo_pago', width: 14 },
    { header: 'Periodicidad', key: 'periodicidad', width: 14 },
    { header: 'Días trabajados', key: 'dias_trabajados', width: 16, format: 'int' },
    { header: 'Monto jornal', key: 'monto_jornal', width: 16, format: 'money' },
    { header: 'Monto destajo', key: 'monto_destajo', width: 16, format: 'money' },
    { header: 'Total', key: 'monto_total', width: 16, format: 'money' },
  ];
  // prompt-29-split-pago-cuentas.md: 2 columnas de desglose + su banco, para
  // que quien haga la dispersión bancaria tenga todo en una sola vista. Solo
  // se agregan si adjuntarDesgloseCuentas ya adjuntó el desglose (mismo gate
  // trabajadores_bancarios) — de lo contrario las columnas quedarían vacías.
  // prompt-35-numero-cuenta-export-nomina.md: agrega el número de cuenta/
  // CLABE y de tarjeta junto a cada banco — antes solo se veía el banco y el
  // monto, sin el dato real para hacer la dispersión. Celda vacía (nunca
  // fabricada) si el trabajador no tiene ese dato capturado.
  if (items[0] && 'monto_cuenta_nomina' in items[0]) {
    columns.push(
      { header: 'Banco cuenta nómina', key: 'banco_nomina', width: 20 },
      { header: 'Cuenta/CLABE nómina', key: 'cuenta_nomina_hsbc', width: 22 },
      { header: 'Tarjeta nómina', key: 'tarjeta_nomina', width: 20 },
      { header: 'Monto cuenta nómina', key: 'monto_cuenta_nomina', width: 18, format: 'money' },
      { header: 'Banco cuenta alterna', key: 'banco_alterna', width: 20 },
      { header: 'Cuenta/CLABE alterna', key: 'cuenta_alterna', width: 22 },
      { header: 'Tarjeta alterna', key: 'tarjeta_alterna', width: 20 },
      { header: 'Monto cuenta alterna', key: 'monto_cuenta_alterna', width: 18, format: 'money' },
    );
  }
  await sendXlsxExport(res, {
    filename,
    sheets: [{
      sheetName: 'Nómina',
      columns,
      rows: items,
    }],
  });
}));

// ===========================================================================
// ESTIMACIONES DE OBRA
// ===========================================================================
// Corte de avance periódico: los montos se jalan SIEMPRE de avance_conceptos
// (nunca captura manual aquí, ver POST .../calcular) — evita dos fuentes de
// verdad con el módulo Avance. total_acumulado/cantidad_acumulada reflejan
// solo estimaciones previas ya APROBADAS + el periodo actual (no el avance
// físico crudo), para que el PDF firmado siempre reconcilie con lo ya
// entregado al cliente en documentos previos (decisión explícita).
const ESTADOS_ESTIMACION = ['borrador', 'enviada', 'aprobada', 'rechazada'];
// Desglose de pago (Prompt 4, prompts-cotizador-sidebar-permisos-
// estimaciones.md) — fondo de garantía e IVA 16%, ambos sobre el
// monto BRUTO del periodo (confirmado con Paul: mismo criterio que ya usan
// Contrato e Facturas en esta app — IVA sobre el subtotal, no sobre un neto
// ya descontado). Ver cálculo en POST .../calcular.
// prompt-fondo-garantia-editable.md: el % de fondo de garantía YA NO es fijo
// — se lee por obra vía porcentajeFondoGarantiaDe() (meta.porcentaje_fondo_
// garantia, capturado en Contrato), con 2% como fallback si la obra no lo
// tiene capturado. IVA_ESTIMACION_PCT sigue fijo, fuera de alcance de ese prompt.
const IVA_ESTIMACION_PCT = 0.16;

// Vista global — solo admin/desarrollador: todas las estimaciones "enviada"
// de todas las obras, para revisar y aprobar/rechazar. Mismo patrón que
// GET /api/nominas.
app.get('/api/estimaciones', h(auth.allow()), h(async (_req, res) => {
  const { rows } = await db.pool.query(`
    SELECT e.*, p.nombre AS obra_nombre, u.nombre AS residente_nombre
    FROM estimaciones e
    JOIN proyectos p ON p.id = e.project_id
    LEFT JOIN usuarios u ON u.id = e.residente_id
    WHERE e.activo = true AND e.estado = 'enviada'
    ORDER BY p.nombre, e.folio`
  );
  res.json(rows);
}));

app.get('/api/projects/:id/estimaciones', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  // Varios residentes pueden compartir la misma obra — cada uno solo ve las
  // que él mismo capturó (admin/dev sí ven todas, igual que en Nóminas).
  const soloPropias = req.user.puesto === 'residente';
  const { rows } = await db.pool.query(`
    SELECT e.*, u.nombre AS residente_nombre, a.nombre AS admin_aprobador_nombre
    FROM estimaciones e
    LEFT JOIN usuarios u ON u.id = e.residente_id
    LEFT JOIN usuarios a ON a.id = e.admin_aprobador_id
    WHERE e.project_id = $1 AND e.activo = true AND ($2::boolean = false OR e.residente_id = $3)
    ORDER BY e.folio DESC`,
    [req.project.id, soloPropias, req.user.id]
  );
  res.json(rows);
}));

app.post('/api/projects/:id/estimaciones', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const { periodo_inicio, periodo_fin, nombre } = req.body || {};
  if (!periodo_inicio || !periodo_fin) return res.status(400).json({ error: 'periodo_inicio y periodo_fin son requeridos' });
  if (periodo_fin < periodo_inicio) return res.status(400).json({ error: 'periodo_fin debe ser igual o posterior a periodo_inicio' });

  // Folio consecutivo por obra: INSERT...ON CONFLICT DO UPDATE...RETURNING es
  // atómico en Postgres — protege contra dos residentes creando al mismo
  // tiempo en la misma obra, sin necesitar un lock explícito aparte. Va en la
  // misma transacción que el INSERT de la estimación.
  const estimacion = await db.withTransaction(async (client) => {
    const { rows: folioRows } = await client.query(
      `INSERT INTO folio_counters (project_id, tipo, ultimo_folio) VALUES ($1, 'estimacion', 1)
       ON CONFLICT (project_id, tipo) DO UPDATE SET ultimo_folio = folio_counters.ultimo_folio + 1
       RETURNING ultimo_folio`,
      [req.project.id]
    );
    const folio = folioRows[0].ultimo_folio;
    const { rows } = await client.query(
      `INSERT INTO estimaciones (project_id, folio, periodo_inicio, periodo_fin, residente_id, nombre)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.project.id, folio, periodo_inicio, periodo_fin, req.user.id, nombre?.trim() || null]
    );
    return rows[0];
  });
  res.status(201).json(estimacion);
}));

// Defaults sugeridos para el modal "Nueva estimación" — registrado ANTES de
// /estimaciones/:estId para que Express no lo confunda con un id numérico.
// El periodo es continuo a nivel OBRA (el folio también lo es), no por
// residente — por eso no se filtra por residente_id como en el listado.
app.get('/api/projects/:id/estimaciones/defaults-periodo', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const pid = req.project.id;
  const hoy = new Date().toISOString().slice(0, 10);

  const { rows: ultimaRows } = await db.pool.query(
    `SELECT periodo_fin FROM estimaciones WHERE project_id = $1 AND activo = true AND estado <> 'rechazada' ORDER BY periodo_fin DESC LIMIT 1`,
    [pid]
  );
  if (ultimaRows[0]) {
    const siguiente = new Date(ultimaRows[0].periodo_fin);
    siguiente.setDate(siguiente.getDate() + 1);
    const periodoInicioSugerido = siguiente.toISOString().slice(0, 10);
    // Si la última estimación cerró en/después de "hoy" (fecha del sistema
    // desfasada, obra recién arrancada, o solo pruebas), periodo_inicio + 1
    // día puede caer en el futuro respecto a "hoy" — periodo_fin nunca debe
    // quedar antes de periodo_inicio, así que en ese caso se empareja con él.
    const periodoFinSugerido = periodoInicioSugerido > hoy ? periodoInicioSugerido : hoy;
    return res.json({ periodo_inicio: periodoInicioSugerido, periodo_fin: periodoFinSugerido });
  }

  // Primera estimación de la obra: fecha de inicio de contrato si está
  // capturada, si no la del primer avance registrado.
  const { rows: metaRows } = await db.pool.query(
    `SELECT valor FROM meta WHERE project_id = $1 AND clave = 'inicio_obra'`, [pid]
  );
  let periodoInicio = metaRows[0]?.valor || null;
  if (!periodoInicio) {
    const { rows: avanceRows } = await db.pool.query(
      `SELECT MIN(fecha_inicio) AS fecha FROM avances_semanales WHERE project_id = $1`, [pid]
    );
    periodoInicio = avanceRows[0]?.fecha || null;
  }
  res.json({ periodo_inicio: periodoInicio, periodo_fin: hoy });
}));

app.get('/api/projects/:id/estimaciones/:estId', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const estId = Number(req.params.estId);
  const soloPropias = req.user.puesto === 'residente';
  const { rows: estRows } = await db.pool.query(`
    SELECT e.*, u.nombre AS residente_nombre, a.nombre AS admin_aprobador_nombre
    FROM estimaciones e
    LEFT JOIN usuarios u ON u.id = e.residente_id
    LEFT JOIN usuarios a ON a.id = e.admin_aprobador_id
    WHERE e.id = $1 AND e.project_id = $2 AND e.activo = true AND ($3::boolean = false OR e.residente_id = $4)`,
    [estId, req.project.id, soloPropias, req.user.id]
  );
  if (!estRows[0]) return res.status(404).json({ error: 'Estimación no encontrada' });
  const { rows: items } = await db.pool.query(`
    SELECT ec.*, c.codigo, c.concepto, c.unidad
    FROM estimacion_conceptos ec JOIN conceptos c ON c.id = ec.concepto_id
    WHERE ec.estimacion_id = $1 ORDER BY c.orden`,
    [estId]
  );
  res.json({ ...estRows[0], items });
}));

// Jala el avance ya registrado (avance_conceptos, vía las semanas de
// avances_semanales que caen dentro del periodo) y recalcula
// estimacion_conceptos. Solo lectura de Avance — nunca escribe ahí. Puede
// llamarse varias veces mientras la estimación siga en 'borrador'/'rechazada'
// (ej. tras corregir el avance) para refrescar el corte antes de enviar.
app.post('/api/projects/:id/estimaciones/:estId/calcular', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const pid = req.project.id;
  const estId = Number(req.params.estId);
  const { rows: estRows } = await db.pool.query('SELECT * FROM estimaciones WHERE id = $1 AND project_id = $2 AND activo = true', [estId, pid]);
  if (!estRows[0]) return res.status(404).json({ error: 'Estimación no encontrada' });
  const est = estRows[0];
  if (req.user.puesto === 'residente' && est.residente_id !== req.user.id) {
    return res.status(404).json({ error: 'Estimación no encontrada' });
  }
  if (!['borrador', 'rechazada'].includes(est.estado)) {
    return res.status(409).json({ error: 'Solo se puede calcular una estimación en borrador o rechazada' });
  }

  // Semanas de avances_semanales que se solapan con el periodo elegido
  const { rows: semanasPeriodo } = await db.pool.query(
    `SELECT semana FROM avances_semanales WHERE project_id = $1 AND fecha_inicio <= $3 AND fecha_fin >= $2`,
    [pid, est.periodo_inicio, est.periodo_fin]
  );
  const semanas = semanasPeriodo.map((s) => s.semana);

  // Mismo filtro de "concepto real" (no subtotal/total, no histórico) que
  // /avances/:semana/conceptos
  const { rows: conceptos } = await db.pool.query(
    `SELECT id AS concepto_id, precio_unitario FROM conceptos
     WHERE project_id = $1 AND es_total = 0 AND activo = 1 AND cantidad > 0 AND TRIM(COALESCE(unidad, '')) <> ''`,
    [pid]
  );

  let periodoMap = {};
  if (semanas.length) {
    const { rows } = await db.pool.query(
      `SELECT concepto_id, COALESCE(SUM(cantidad_ejecutada), 0) AS total FROM avance_conceptos WHERE semana = ANY($1) GROUP BY concepto_id`,
      [semanas]
    );
    periodoMap = Object.fromEntries(rows.map((r) => [r.concepto_id, Number(r.total)]));
  }

  // Acumulado previo: SOLO estimaciones ya aprobadas de esta obra (no avance físico crudo)
  const { rows: acumRows } = await db.pool.query(
    `SELECT ec.concepto_id, COALESCE(SUM(ec.cantidad_periodo), 0) AS cantidad, COALESCE(SUM(ec.importe_periodo), 0) AS importe
     FROM estimacion_conceptos ec
     JOIN estimaciones e ON e.id = ec.estimacion_id
     WHERE e.project_id = $1 AND e.estado = 'aprobada' AND e.id <> $2
     GROUP BY ec.concepto_id`,
    [pid, estId]
  );
  const acumMap = Object.fromEntries(acumRows.map((r) => [r.concepto_id, { cantidad: Number(r.cantidad), importe: Number(r.importe) }]));

  const presupuestoTotal = await presupuestoTotalDe(pid);
  const items = conceptos.map((c) => {
    const cantidadPeriodo = periodoMap[c.concepto_id] || 0;
    const importePeriodo = cantidadPeriodo * Number(c.precio_unitario);
    const prev = acumMap[c.concepto_id] || { cantidad: 0, importe: 0 };
    const cantidadAcumulada = prev.cantidad + cantidadPeriodo;
    const importeAcumulado = prev.importe + importePeriodo;
    const pct = presupuestoTotal > 0 ? Math.min(100, (importeAcumulado / presupuestoTotal) * 100) : 0;
    return { concepto_id: c.concepto_id, cantidadPeriodo, importePeriodo, cantidadAcumulada, importeAcumulado, pct };
  }).filter((it) => it.cantidadPeriodo > 0 || it.cantidadAcumulada > 0);

  const fondoGarantiaPct = await porcentajeFondoGarantiaDe(pid);

  await db.withTransaction(async (client) => {
    await client.query('DELETE FROM estimacion_conceptos WHERE estimacion_id = $1', [estId]);
    for (const it of items) {
      await client.query(
        `INSERT INTO estimacion_conceptos (estimacion_id, concepto_id, cantidad_periodo, importe_periodo, cantidad_acumulada, importe_acumulado, porcentaje_avance)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [estId, it.concepto_id, it.cantidadPeriodo, it.importePeriodo, it.cantidadAcumulada, it.importeAcumulado, it.pct]
      );
    }
    const totalPeriodo = items.reduce((s, it) => s + it.importePeriodo, 0);
    const totalAcumulado = items.reduce((s, it) => s + it.importeAcumulado, 0);
    // Desglose de pago (Prompt 4, prompts-cotizador-sidebar-permisos-
    // estimaciones.md): Fondo de Garantía (% pactado por obra, fondoGarantiaPct
    // arriba — prompt-fondo-garantia-editable.md) e IVA 16% se calculan sobre el
    // total del PERIODO (no el acumulado — el acumulado ya se cobró,
    // parcialmente, en estimaciones anteriores) y sobre el monto BRUTO de la
    // estimación (mismo patrón que Contrato: importe_contratado + iva_monto
    // = total_contratado, y Facturas: monto_subtotal + iva = monto_total).
    // amortizacion_anticipo se preserva del valor ya capturado (si lo hay) —
    // recalcular el avance no debe borrar una amortización ya guardada.
    const fondoGarantiaMonto = totalPeriodo * (fondoGarantiaPct / 100);
    const ivaMonto = totalPeriodo * IVA_ESTIMACION_PCT;
    const totalAPagar = totalPeriodo - Number(est.amortizacion_anticipo || 0) - fondoGarantiaMonto + ivaMonto;
    await client.query(
      `UPDATE estimaciones SET total_periodo = $1, total_acumulado = $2, fondo_garantia_monto = $3, iva_monto = $4, total_a_pagar = $5 WHERE id = $6`,
      [totalPeriodo, totalAcumulado, fondoGarantiaMonto, ivaMonto, totalAPagar, estId]
    );
  });

  const { rows: itemsOut } = await db.pool.query(`
    SELECT ec.*, c.codigo, c.concepto, c.unidad
    FROM estimacion_conceptos ec JOIN conceptos c ON c.id = ec.concepto_id
    WHERE ec.estimacion_id = $1 ORDER BY c.orden`,
    [estId]
  );
  const { rows: updEst } = await db.pool.query('SELECT * FROM estimaciones WHERE id = $1', [estId]);
  res.json({ estimacion: updEst[0], items: itemsOut });
}));

app.put('/api/projects/:id/estimaciones/:estId/estado', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const estId = Number(req.params.estId);
  const { estado, comentario_rechazo } = req.body || {};
  if (!ESTADOS_ESTIMACION.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });

  const { rows: estRows } = await db.pool.query('SELECT * FROM estimaciones WHERE id = $1 AND project_id = $2 AND activo = true', [estId, req.project.id]);
  if (!estRows[0]) return res.status(404).json({ error: 'Estimación no encontrada' });
  const est = estRows[0];
  const esAdmin = req.user.puesto === 'admin' || req.user.puesto === 'desarrollador';
  if (!esAdmin && est.residente_id !== req.user.id) return res.status(404).json({ error: 'Estimación no encontrada' });

  // Desde 'rechazada' se reenvía directo (recalcular + enviar) — la UI no
  // ofrece un paso intermedio a 'borrador', el residente corrige en Avance
  // y vuelve a calcular/enviar esta misma estimación.
  const transicionesPermitidas = {
    borrador:  { enviada: true },
    enviada:   { aprobada: esAdmin, rechazada: esAdmin },
    rechazada: { enviada: true },
    aprobada:  {},
  };
  if (!transicionesPermitidas[est.estado]?.[estado]) {
    return res.status(403).json({ error: `No puedes cambiar de '${est.estado}' a '${estado}'` });
  }
  if (estado === 'rechazada' && !comentario_rechazo?.trim()) {
    return res.status(400).json({ error: 'El comentario de rechazo es obligatorio' });
  }
  if (estado === 'enviada') {
    const { rows: itemCount } = await db.pool.query('SELECT COUNT(*)::int AS n FROM estimacion_conceptos WHERE estimacion_id = $1', [estId]);
    if (!itemCount[0].n) return res.status(400).json({ error: 'Calcula la estimación (jala el avance del periodo) antes de enviarla' });
  }

  if (estado === 'aprobada') {
    const { rows: items } = await db.pool.query(`
      SELECT ec.*, c.codigo, c.concepto, c.unidad
      FROM estimacion_conceptos ec JOIN conceptos c ON c.id = ec.concepto_id
      WHERE ec.estimacion_id = $1 ORDER BY c.orden`,
      [estId]
    );
    const { rows: clienteRows } = await db.pool.query(
      'SELECT cl.nombre FROM proyectos p LEFT JOIN clientes cl ON cl.id = p.cliente_id WHERE p.id = $1',
      [req.project.id]
    );
    const { rows: residenteRows } = await db.pool.query('SELECT nombre FROM usuarios WHERE id = $1', [est.residente_id]);
    const pdfBuffer = await buildEstimacionPdf({
      project: req.project,
      clienteNombre: clienteRows[0]?.nombre,
      estimacion: est,
      items,
      residenteNombre: residenteRows[0]?.nombre,
      adminNombre: req.user.nombre,
    });
    const blobKey = `estimaciones/${req.project.id}/${est.folio}-${Date.now()}.pdf`;
    const blobResult = await put(blobKey, pdfBuffer, { access: 'private', contentType: 'application/pdf' });
    const { rows } = await db.pool.query(
      `UPDATE estimaciones SET estado = $1, admin_aprobador_id = $2, fecha_aprobacion = NOW(), pdf_url = $3, comentario_rechazo = NULL WHERE id = $4 RETURNING *`,
      [estado, req.user.id, blobResult.url, estId]
    );
    return res.json(rows[0]);
  }

  const { rows } = await db.pool.query(
    `UPDATE estimaciones SET estado = $1, comentario_rechazo = $2 WHERE id = $3 RETURNING *`,
    [estado, estado === 'rechazada' ? comentario_rechazo.trim() : null, estId]
  );

  if (estado === 'enviada') {
    await notificarAdmins(req.project.id, 'estimacion_pendiente', estId, `${req.user.nombre} envió la Estimación #${est.folio} para aprobación`);
  }
  if (estado === 'rechazada' && est.residente_id) {
    await crearNotificacion(est.residente_id, req.project.id, 'estimacion_rechazada', estId, `Tu Estimación #${est.folio} fue rechazada: ${comentario_rechazo.trim()}`);
  }
  res.json(rows[0]);
}));

// Renombrar (Prompt 4) — no toca datos financieros, editable en cualquier
// estado (incluida 'aprobada': es solo una etiqueta). nombre vacío/null
// vuelve a la UI a mostrar "Estimación #folio" como antes.
app.put('/api/projects/:id/estimaciones/:estId/nombre', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const estId = Number(req.params.estId);
  const { nombre } = req.body || {};
  const { rows: estRows } = await db.pool.query('SELECT residente_id FROM estimaciones WHERE id = $1 AND project_id = $2 AND activo = true', [estId, req.project.id]);
  if (!estRows[0]) return res.status(404).json({ error: 'Estimación no encontrada' });
  const esAdmin = req.user.puesto === 'admin' || req.user.puesto === 'desarrollador';
  if (!esAdmin && estRows[0].residente_id !== req.user.id) return res.status(404).json({ error: 'Estimación no encontrada' });
  const { rows } = await db.pool.query(
    'UPDATE estimaciones SET nombre = $1 WHERE id = $2 RETURNING *',
    [nombre?.trim() || null, estId]
  );
  res.json(rows[0]);
}));

// Amortización de anticipo (Prompt 4) — captura manual, opcional. Mismo
// candado de estado que "Calcular" (borrador/rechazada): una vez enviada,
// el desglose de pago queda fijo. Recalcula total_a_pagar de inmediato con
// el fondo_garantia_monto/iva_monto ya guardados por el último "Calcular"
// (no dispara un recálculo del avance — para eso está el botón Calcular).
app.put('/api/projects/:id/estimaciones/:estId/amortizacion', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const estId = Number(req.params.estId);
  const { amortizacion_anticipo } = req.body || {};
  const monto = Number(amortizacion_anticipo);
  if (!Number.isFinite(monto) || monto < 0) return res.status(400).json({ error: 'Monto de amortización inválido' });
  const { rows: estRows } = await db.pool.query('SELECT * FROM estimaciones WHERE id = $1 AND project_id = $2 AND activo = true', [estId, req.project.id]);
  if (!estRows[0]) return res.status(404).json({ error: 'Estimación no encontrada' });
  const est = estRows[0];
  if (req.user.puesto === 'residente' && est.residente_id !== req.user.id) {
    return res.status(404).json({ error: 'Estimación no encontrada' });
  }
  if (!['borrador', 'rechazada'].includes(est.estado)) {
    return res.status(409).json({ error: 'Solo se puede editar la amortización en una estimación en borrador o rechazada' });
  }
  const totalAPagar = Number(est.total_periodo) - monto - Number(est.fondo_garantia_monto) + Number(est.iva_monto);
  const { rows } = await db.pool.query(
    'UPDATE estimaciones SET amortizacion_anticipo = $1, total_a_pagar = $2 WHERE id = $3 RETURNING *',
    [monto, totalAPagar, estId]
  );
  res.json(rows[0]);
}));

// Soft-delete únicamente — nunca DELETE físico de una estimación. Solo
// mientras siga en 'borrador' (igual que Requisiciones).
app.delete('/api/projects/:id/estimaciones/:estId', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const estId = Number(req.params.estId);
  const { rows } = await db.pool.query('SELECT estado, residente_id FROM estimaciones WHERE id = $1 AND project_id = $2 AND activo = true', [estId, req.project.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Estimación no encontrada' });
  const esAdmin = req.user.puesto === 'admin' || req.user.puesto === 'desarrollador';
  if (!esAdmin && rows[0].residente_id !== req.user.id) return res.status(404).json({ error: 'Estimación no encontrada' });
  if (rows[0].estado !== 'borrador') return res.status(400).json({ error: 'Solo se pueden eliminar estimaciones en estado "borrador"' });
  await db.pool.query('UPDATE estimaciones SET activo = false WHERE id = $1', [estId]);
  res.json({ ok: true });
}));

// Proxy del PDF (blob privado) — mismo patrón que /contrato/pdf.
app.get('/api/projects/:id/estimaciones/:estId/pdf', h(auth.allow('residente')), h(requireProject), h(auth.verificarAccesoObra), h(async (req, res) => {
  const estId = Number(req.params.estId);
  const soloPropias = req.user.puesto === 'residente';
  const { rows } = await db.pool.query(
    `SELECT pdf_url, folio FROM estimaciones WHERE id = $1 AND project_id = $2 AND activo = true AND ($3::boolean = false OR residente_id = $4)`,
    [estId, req.project.id, soloPropias, req.user.id]
  );
  if (!rows[0] || !rows[0].pdf_url) return res.status(404).json({ error: 'PDF no disponible para esta estimación' });
  const blobResult = await get(rows[0].pdf_url, { access: 'private' });
  if (!blobResult) return res.status(404).json({ error: 'Archivo no encontrado en almacenamiento' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Estimacion_${rows[0].folio}.pdf"`);
  await pipeline(Readable.fromWeb(blobResult.stream), res);
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

const requireDesarrollador = (req, res, next) => {
  if (req.user?.puesto === 'desarrollador') return next();
  return res.status(403).json({ error: 'No tienes permiso para realizar esta acción' });
};

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

app.delete('/api/sugerencias/:id', requireDesarrollador, h(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });
  const { rowCount } = await db.pool.query('DELETE FROM sugerencias WHERE id = $1', [id]);
  if (!rowCount) return res.status(404).json({ error: 'Sugerencia no encontrada' });
  res.status(204).send();
}));

app.post('/api/sugerencias/:id/imagenes', uploadImg.single('imagen'), h(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió ninguna imagen' });
  if (!await checkFileMagic(req.file.path, ['jpeg', 'png', 'gif', 'webp'])) {
    await fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: 'El archivo no es una imagen válida (firma de contenido incorrecta)' });
  }
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
// Novedades (changelog in-app, prompt-16-novedades-changelog.md) — mismo
// criterio de acceso que Sugerencias: informativo, visible para cualquier
// usuario autenticado, sin sección de permiso propia (no toca SECCIONES_
// PERMISOS/TAB_A_SECCION/CHECK constraints — diagnóstico confirmado con
// Paul). Administración (crear/editar/publicar/despublicar) sí gatea con
// auth.allow('desarrollador') = admin o desarrollador, 403 real para
// cualquier otro rol.
// ---------------------------------------------------------------------------
async function novedadesConItems(where, params) {
  const { rows: novedades } = await db.pool.query(
    `SELECT id, version, fecha_publicacion, titulo, resumen, publicada, creado_en
     FROM novedades ${where} ORDER BY fecha_publicacion DESC, id DESC`,
    params
  );
  if (!novedades.length) return [];
  const ids = novedades.map((n) => n.id);
  const { rows: items } = await db.pool.query(
    `SELECT id, novedad_id, tipo, texto, orden FROM novedades_items WHERE novedad_id = ANY($1) ORDER BY novedad_id, orden, id`,
    [ids]
  );
  const itemsPorNovedad = new Map();
  for (const it of items) {
    if (!itemsPorNovedad.has(it.novedad_id)) itemsPorNovedad.set(it.novedad_id, []);
    itemsPorNovedad.get(it.novedad_id).push(it);
  }
  return novedades.map((n) => ({ ...n, items: itemsPorNovedad.get(n.id) || [] }));
}

// Usado en issueFullSession()/GET /auth/me (ver más arriba) — mismo punto de
// disparo que shouldShowTotpReminder(), calculado en applySession() en el
// frontend, sin ramificar por rol (diagnóstico confirmado: bootApp() tiene
// 2 rutas post-login según si el usuario tiene proyectos, pero applySession()
// corre ANTES de ambas, así que un solo cálculo aquí cubre las dos).
async function getAvisoNovedades(usuarioId) {
  const { rows } = await db.pool.query(
    `SELECT n.id, n.version, n.fecha_publicacion, n.titulo, n.resumen
     FROM novedades n
     WHERE n.publicada = true
       AND NOT EXISTS (SELECT 1 FROM novedades_vistas v WHERE v.usuario_id = $1 AND v.novedad_id = n.id)
     ORDER BY n.fecha_publicacion DESC, n.id DESC`,
    [usuarioId]
  );
  if (!rows.length) return null;
  return { total_sin_ver: rows.length, mas_reciente: rows[0] };
}

app.get('/api/novedades', h(async (req, res) => {
  res.json({ novedades: await novedadesConItems('WHERE publicada = true', []) });
}));

// Marca TODAS las novedades publicadas actuales como vistas por el usuario —
// se llama al cerrar el aviso Y al abrir la sección completa (Target State
// #3): un solo aviso consolidado, "vista" es por publicación existente al
// momento del clic, no por ítem individual mostrado.
app.post('/api/novedades/marcar-vistas', h(async (req, res) => {
  await db.pool.query(
    `INSERT INTO novedades_vistas (usuario_id, novedad_id)
     SELECT $1, n.id FROM novedades n WHERE n.publicada = true
     ON CONFLICT (usuario_id, novedad_id) DO NOTHING`,
    [req.user.id]
  );
  res.json({ ok: true });
}));

app.get('/api/novedades/admin', h(auth.allow('desarrollador')), h(async (req, res) => {
  res.json({ novedades: await novedadesConItems('', []) });
}));

function validarNovedadPayload(body) {
  if (!body.titulo?.trim()) return 'El título es requerido';
  if (!Array.isArray(body.items)) return 'items debe ser un arreglo';
  for (const it of body.items) {
    if (!['nueva', 'mejora', 'correccion'].includes(it.tipo)) return `Tipo de ítem inválido: ${it.tipo}`;
    if (!it.texto?.trim()) return 'Cada ítem requiere texto';
  }
  return null;
}

app.post('/api/novedades', h(auth.allow('desarrollador')), h(async (req, res) => {
  const body = req.body || {};
  const error = validarNovedadPayload(body);
  if (error) return res.status(400).json({ error });

  let novedadId;
  await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO novedades (version, fecha_publicacion, titulo, resumen, creado_por)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [body.version?.trim() || null, body.fecha_publicacion || new Date().toISOString().slice(0, 10),
        body.titulo.trim(), body.resumen?.trim() || null, req.user.id]
    );
    novedadId = rows[0].id;
    for (const [idx, it] of body.items.entries()) {
      await client.query(
        'INSERT INTO novedades_items (novedad_id, tipo, texto, orden) VALUES ($1,$2,$3,$4)',
        [novedadId, it.tipo, it.texto.trim(), idx]
      );
    }
  });
  const [novedad] = await novedadesConItems('WHERE id = $1', [novedadId]);
  res.status(201).json(novedad);
}));

app.put('/api/novedades/:id', h(auth.allow('desarrollador')), h(async (req, res) => {
  const id = Number(req.params.id);
  const body = req.body || {};
  const error = validarNovedadPayload(body);
  if (error) return res.status(400).json({ error });

  const { rows: existRows } = await db.pool.query('SELECT id FROM novedades WHERE id = $1', [id]);
  if (!existRows[0]) return res.status(404).json({ error: 'Novedad no encontrada' });

  await db.withTransaction(async (client) => {
    await client.query(
      `UPDATE novedades SET version=$1, fecha_publicacion=$2, titulo=$3, resumen=$4 WHERE id=$5`,
      [body.version?.trim() || null, body.fecha_publicacion || new Date().toISOString().slice(0, 10),
        body.titulo.trim(), body.resumen?.trim() || null, id]
    );
    await client.query('DELETE FROM novedades_items WHERE novedad_id = $1', [id]);
    for (const [idx, it] of body.items.entries()) {
      await client.query(
        'INSERT INTO novedades_items (novedad_id, tipo, texto, orden) VALUES ($1,$2,$3,$4)',
        [id, it.tipo, it.texto.trim(), idx]
      );
    }
  });
  const [novedad] = await novedadesConItems('WHERE id = $1', [id]);
  res.json(novedad);
}));

app.post('/api/novedades/:id/publicar', h(auth.allow('desarrollador')), h(async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await db.pool.query('UPDATE novedades SET publicada = true WHERE id = $1 RETURNING id', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'Novedad no encontrada' });
  res.json({ ok: true });
}));

app.post('/api/novedades/:id/despublicar', h(auth.allow('desarrollador')), h(async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await db.pool.query('UPDATE novedades SET publicada = false WHERE id = $1 RETURNING id', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'Novedad no encontrada' });
  res.json({ ok: true });
}));

app.delete('/api/novedades/:id', h(auth.allow('desarrollador')), h(async (req, res) => {
  const id = Number(req.params.id);
  const { rowCount } = await db.pool.query('DELETE FROM novedades WHERE id = $1', [id]);
  if (!rowCount) return res.status(404).json({ error: 'Novedad no encontrada' });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Panel de desarrollador — stats del sistema (solo rol 'desarrollador', no admin)
// ---------------------------------------------------------------------------
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
app.use((err, req, res, _next) => {
  console.error(err);
  // Sin SENTRY_DSN, Sentry.captureException es un no-op (Sentry.init nunca
  // corrió) — seguro llamarlo siempre en vez de envolverlo en el mismo if.
  // proyecto_id/usuario_id como tags (no PII adicional) para poder filtrar
  // eventos por obra en el dashboard de Sentry.
  Sentry.captureException(err, {
    tags: {
      proyecto_id: req.project?.id ?? req.params?.id ?? null,
      usuario_id: req.user?.id ?? null,
    },
  });
  trackServerEvent(req.user?.id || 'anonimo', 'error_boundary', {
    proyecto_id: req.project?.id ?? req.params?.id ?? null,
    ruta: req.originalUrl,
  });
  // Los errores de PostgreSQL tienen la propiedad `severity` ('ERROR', 'FATAL', etc.).
  // Nunca exponemos el mensaje crudo de DB al cliente — puede filtrar nombres de
  // tablas, columnas o constraints. Los errores de validación (multer, negocio)
  // no tienen `severity` y sí muestran su mensaje.
  const message = err.severity ? 'Error interno del servidor' : (err.message || 'Error interno del servidor');
  res.status(err.status || 500).json({ error: message });
});

module.exports = app;
// Expuesta para tests unitarios directos del motor de cálculo (prompt-20-
// matrices-formato-neodata.md, CP2/CP3) — no cambia la forma del export
// principal, `app` sigue siendo la instancia de Express que todo el resto
// del código (incluidos los tests existentes) espera al hacer require().
module.exports.calcularMatrizNeodata = calcularMatrizNeodata;
// prompt-matrices-basicos-anidados.md: mismo criterio — expuestas para tests
// directos de la resolución recursiva de básicos y la protección de ciclos.
module.exports.resolverBasico = resolverBasico;
module.exports.validarSinCicloBasico = validarSinCicloBasico;
module.exports.getMatrizConRenglones = getMatrizConRenglones;
