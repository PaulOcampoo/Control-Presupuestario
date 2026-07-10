'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const OTPAuth = require('otpauth');
const db = require('./db');

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  throw new Error('SESSION_SECRET no está configurada en las variables de entorno — la app no puede arrancar sin ella.');
}

const TOTP_ENC_KEY = process.env.TOTP_ENC_KEY;
if (!TOTP_ENC_KEY || !/^[0-9a-f]{64}$/i.test(TOTP_ENC_KEY)) {
  throw new Error('TOTP_ENC_KEY no está configurada (o no es un hex de 64 caracteres / 32 bytes) — la app no puede arrancar sin ella.');
}
const TOTP_ENC_KEY_BUF = Buffer.from(TOTP_ENC_KEY, 'hex');

const TOKEN_TTL = '2h';
const REFRESH_TTL = '7d';
const REFRESH_COOKIE = 'cp_refresh';
const PRE_AUTH_TTL = '5m';
const TOTP_ISSUER = 'Grupo Roforb — Control Presupuestal';

// Puestos y qué pestañas puede ver cada uno. 'admin' tiene acceso total
// (se resuelve aparte en allow(), no necesita listarse en cada pestaña).
const PERMISSIONS = {
  admin:          { label: 'Administrador', tabs: ['resumen', 'contrato', 'impuestos', 'insumos', 'requisiciones', 'ordenes', 'avance', 'programa', 'destajo', 'usuarios', 'proveedores', 'finanzas', 'mapeo', 'trabajadores', 'nominas'] },
  desarrollador:  { label: 'Desarrollador', tabs: ['resumen', 'contrato', 'impuestos', 'insumos', 'requisiciones', 'ordenes', 'avance', 'programa', 'destajo', 'usuarios', 'proveedores', 'finanzas', 'mapeo', 'trabajadores', 'nominas'] },
  residente:      { label: 'Residente',     tabs: ['programa', 'avance', 'destajo', 'requisiciones', 'insumos', 'ordenes', 'nominas'] },
  cabo:           { label: 'Cabo',          tabs: ['destajo', 'insumos', 'avance', 'requisiciones'] },
  compras:        { label: 'Compras',       tabs: ['programa', 'requisiciones', 'insumos', 'ordenes', 'proveedores'] },
  tesoreria:      { label: 'Tesorería',     tabs: ['resumen', 'finanzas', 'ordenes', 'contrato', 'impuestos', 'proveedores'] },
  administracion: { label: 'Administración',tabs: ['resumen', 'programa', 'destajo', 'ordenes', 'proveedores', 'contrato', 'impuestos', 'mapeo'] },
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

function signRefreshToken(user) {
  return jwt.sign({ id: user.id, usuario: user.usuario }, SESSION_SECRET, { expiresIn: REFRESH_TTL });
}

function verifyRefreshToken(token) {
  return jwt.verify(token, SESSION_SECRET);
}

// Construye el valor de la cookie Set-Cookie para el refresh token.
function buildRefreshCookie(token, clear = false) {
  const isProd = process.env.NODE_ENV === 'production';
  const maxAge = clear ? 0 : 7 * 24 * 60 * 60; // 7 días en segundos
  const value = clear ? '' : encodeURIComponent(token);
  return `${REFRESH_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/api/auth/refresh; Max-Age=${maxAge}${isProd ? '; Secure' : ''}`;
}

// Token intermedio (5 min) entre password OK y el 2° factor TOTP. stage:'pre_totp'
// impide que requireAuth lo acepte como sesión completa aunque alguien lo mande
// como Bearer a un endpoint protegido. enroll=true cuando es inscripción forzada
// (primer login sin TOTP configurado) vs. login normal ya inscrito.
function signPreAuthToken(user, { enroll = false } = {}) {
  return jwt.sign({ id: user.id, usuario: user.usuario, stage: 'pre_totp', enroll }, SESSION_SECRET, { expiresIn: PRE_AUTH_TTL });
}

function verifyPreAuthToken(token) {
  const decoded = jwt.verify(token, SESSION_SECRET);
  if (decoded.stage !== 'pre_totp') throw new Error('Token no es de pre-autenticación');
  return decoded;
}

// ---------------------------------------------------------------------------
// TOTP (2FA) — el secret se cifra en reposo (AES-256-GCM) porque, a diferencia
// de una contraseña, necesita ser recuperable para poder verificar el código.
// ---------------------------------------------------------------------------
function encryptTotpSecret(plainBase32) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', TOTP_ENC_KEY_BUF, iv);
  const enc = Buffer.concat([cipher.update(plainBase32, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${enc.toString('hex')}`;
}

function decryptTotpSecret(stored) {
  const [ivHex, tagHex, dataHex] = stored.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', TOTP_ENC_KEY_BUF, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return dec.toString('utf8');
}

// Genera un secret TOTP nuevo (base32, sin cifrar — se cifra al guardarlo en DB).
function generateTotpSecret() {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

// URI otpauth:// para el QR (Google Authenticator, Authy, etc.)
function buildTotpUri(usuario, secretBase32) {
  const totp = new OTPAuth.TOTP({
    issuer: TOTP_ISSUER,
    label: usuario,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
  return totp.toString();
}

// Verifica un código de 6 dígitos contra el secret (base32, ya descifrado).
// window:1 tolera desfase de reloj de ±30s en el dispositivo del usuario.
function verifyTotpCode(secretBase32, code) {
  if (!/^\d{6}$/.test(String(code || ''))) return false;
  const totp = new OTPAuth.TOTP({
    algorithm: 'SHA1', digits: 6, period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
  return totp.validate({ token: String(code), window: 1 }) !== null;
}

// Genera N códigos de respaldo (formato XXXX-XXXX legible) — se devuelven en
// claro UNA sola vez al llamador; solo el hash de cada uno se persiste.
async function generateBackupCodes(count = 10) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I para evitar confusión
  const rawCodes = [];
  for (let i = 0; i < count; i++) {
    let code = '';
    const bytes = crypto.randomBytes(8);
    for (let b = 0; b < 8; b++) code += alphabet[bytes[b] % alphabet.length];
    rawCodes.push(code);
  }
  // Se hashea el código "en crudo" (sin guion); el guion es solo cosmético al mostrarlo.
  const hashed = await Promise.all(rawCodes.map(async (code) => ({ hash: await bcrypt.hash(code, 10), used: false })));
  const plain = rawCodes.map((c) => `${c.slice(0, 4)}-${c.slice(4)}`);
  return { plain, hashed };
}

// Busca un código de respaldo válido y no usado dentro del array almacenado
// (JSONB [{hash, used}]). Devuelve el índice del que coincide, o -1 si ninguno.
async function findBackupCodeIndex(inputCode, storedCodes) {
  const norm = String(inputCode || '').trim().toUpperCase().replace(/[\s-]+/g, '');
  if (!norm || !Array.isArray(storedCodes)) return -1;
  for (let i = 0; i < storedCodes.length; i++) {
    if (storedCodes[i].used) continue;
    // eslint-disable-next-line no-await-in-loop
    if (await bcrypt.compare(norm, storedCodes[i].hash)) return i;
  }
  return -1;
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
  // El token intermedio de pre-TOTP (5 min) nunca debe servir como sesión completa,
  // aunque alguien lo mande como Bearer antes de completar el 2° factor.
  if (decoded.stage === 'pre_totp') {
    return res.status(401).json({ error: 'Falta completar la verificación en dos pasos' });
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

// Extrae IP del request (mismo patrón que login).
function getIp(req) {
  return ((req.headers['x-forwarded-for'] || '') + '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
}

// Inserta en audit_log de forma fire-and-forget: no bloquea la respuesta.
function logDenied(req, razon) {
  const ip = getIp(req);
  db.pool.query(
    'INSERT INTO audit_log (actor_id, actor_usuario, accion, target_usuario, ip) VALUES ($1,$2,$3,$4,$5)',
    [req.user.id, req.user.usuario, 'acceso_denegado', `${req.method} ${req.originalUrl} — ${razon}`, ip]
  ).catch(() => {});
}

// Restringe la ruta a los puestos indicados; 'admin' y 'desarrollador' siempre pasan.
function allow(...puestos) {
  return (req, res, next) => {
    const p = req.user?.puesto;
    if (p === 'admin' || p === 'desarrollador' || puestos.includes(p)) return next();
    logDenied(req, `puesto '${p}' no permitido`);
    return res.status(403).json({ error: 'No tienes permiso para realizar esta acción' });
  };
}

// Restringe el acceso a la obra (proyecto) cargada por requireProject: el
// admin siempre pasa; el resto solo si tiene una fila en usuario_proyectos
// para ese project_id. Debe ir después de requireProject en la cadena.
async function verificarAccesoObra(req, res, next) {
  if (req.user.puesto === 'admin' || req.user.puesto === 'desarrollador') return next();
  const projectId = req.project ? req.project.id : Number(req.params.id);
  const { rows } = await db.pool.query(
    'SELECT 1 FROM usuario_proyectos WHERE usuario_id = $1 AND project_id = $2',
    [req.user.id, projectId]
  );
  if (!rows.length) {
    logDenied(req, `sin acceso a obra ${projectId}`);
    return res.status(403).json({ error: 'No tienes acceso a esta obra' });
  }
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
  REFRESH_COOKIE,
  isValidPuesto,
  hashPassword,
  verifyPassword,
  signToken,
  signRefreshToken,
  verifyRefreshToken,
  buildRefreshCookie,
  signPreAuthToken,
  verifyPreAuthToken,
  encryptTotpSecret,
  decryptTotpSecret,
  generateTotpSecret,
  buildTotpUri,
  verifyTotpCode,
  generateBackupCodes,
  findBackupCodeIndex,
  requireAuth,
  allow,
  verificarAccesoObra,
  ensureBootstrapAdmin,
};
