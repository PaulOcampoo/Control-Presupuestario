'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-insecure-secret-change-me';
if (!process.env.SESSION_SECRET) {
  // eslint-disable-next-line no-console
  console.warn('⚠️  SESSION_SECRET no está definido — usando un valor de desarrollo inseguro. Defínelo como variable de entorno en producción.');
}

const TOKEN_TTL = '30d';

// Puestos y qué pestañas puede ver cada uno. 'admin' tiene acceso total
// (se resuelve aparte en allow(), no necesita listarse en cada pestaña).
const PERMISSIONS = {
  admin:          { label: 'Administrador', tabs: ['resumen', 'contrato', 'impuestos', 'insumos', 'requisiciones', 'ordenes', 'avance', 'programa', 'destajo', 'usuarios', 'proveedores', 'finanzas', 'mapeo'] },
  residente:      { label: 'Residente',     tabs: ['programa', 'avance', 'destajo', 'requisiciones', 'insumos', 'ordenes'] },
  cabo:           { label: 'Cabo',          tabs: ['destajo', 'insumos', 'avance', 'requisiciones'] },
  compras:        { label: 'Compras',       tabs: ['programa', 'requisiciones', 'insumos', 'ordenes', 'proveedores'] },
  tesoreria:      { label: 'Tesorería',     tabs: ['resumen', 'finanzas', 'ordenes', 'contrato', 'impuestos', 'proveedores'] },
  administracion: { label: 'Administración',tabs: ['resumen', 'programa', 'destajo', 'ordenes', 'proveedores', 'contrato', 'impuestos', 'usuarios', 'mapeo'] },
  logistica:      { label: 'Logística',     tabs: ['programa', 'avance', 'requisiciones', 'insumos', 'ordenes'] },
};
const PUESTOS = Object.keys(PERMISSIONS);

function isValidPuesto(p) {
  return PUESTOS.includes(p);
}

async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, nombre: user.nombre, usuario: user.usuario, puesto: user.puesto },
    SESSION_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

// Exige un token válido en Authorization: Bearer <token>; deja al usuario en req.user.
// Verifica además que el token no fue revocado (iat > token_valid_since en DB).
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  let decoded;
  try {
    decoded = jwt.verify(token, SESSION_SECRET);
  } catch {
    return res.status(401).json({ error: 'Sesión inválida o expirada, inicia sesión de nuevo' });
  }
  try {
    const { rows } = await db.pool.query(
      'SELECT token_valid_since FROM usuarios WHERE id = $1 AND activo = true',
      [decoded.id]
    );
    if (!rows[0]) return res.status(401).json({ error: 'Sesión inválida' });
    const validSinceMs = new Date(rows[0].token_valid_since).getTime();
    // iat es en segundos; si fue emitido en el mismo instante o antes de la revocación, se rechaza
    if (decoded.iat * 1000 <= validSinceMs) {
      return res.status(401).json({ error: 'Sesión revocada, inicia sesión de nuevo' });
    }
    req.user = decoded;
    next();
  } catch (err) {
    next(err);
  }
}

// Restringe la ruta a los puestos indicados; 'admin' siempre pasa.
function allow(...puestos) {
  return (req, res, next) => {
    if (req.user && (req.user.puesto === 'admin' || puestos.includes(req.user.puesto))) return next();
    return res.status(403).json({ error: 'No tienes permiso para realizar esta acción' });
  };
}

// Restringe el acceso a la obra (proyecto) cargada por requireProject: el
// admin siempre pasa; el resto solo si tiene una fila en usuario_proyectos
// para ese project_id. Debe ir después de requireProject en la cadena.
async function verificarAccesoObra(req, res, next) {
  if (req.user.puesto === 'admin') return next();
  const projectId = req.project ? req.project.id : Number(req.params.id);
  const { rows } = await db.pool.query(
    'SELECT 1 FROM usuario_proyectos WHERE usuario_id = $1 AND project_id = $2',
    [req.user.id, projectId]
  );
  if (!rows.length) return res.status(403).json({ error: 'No tienes acceso a esta obra' });
  next();
}

// Crea el primer usuario administrador si la tabla de usuarios está vacía,
// para poder entrar la primera vez y dar de alta al resto desde la app.
async function ensureBootstrapAdmin() {
  const { rows } = await db.pool.query('SELECT COUNT(*) AS n FROM usuarios');
  if (Number(rows[0].n) > 0) return;
  const usuario = process.env.ADMIN_USER || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  const hash = await hashPassword(password);
  await db.pool.query(
    'INSERT INTO usuarios (nombre, usuario, password_hash, puesto) VALUES ($1,$2,$3,$4)',
    ['Administrador', usuario, hash, 'admin']
  );
  // eslint-disable-next-line no-console
  console.log(`Usuario administrador inicial creado: "${usuario}" — cambia la contraseña después de iniciar sesión.`);
}

module.exports = {
  PERMISSIONS,
  PUESTOS,
  isValidPuesto,
  hashPassword,
  verifyPassword,
  signToken,
  requireAuth,
  allow,
  verificarAccesoObra,
  ensureBootstrapAdmin,
};
