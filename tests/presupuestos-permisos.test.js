// Integration test para checkPermiso('presupuestos', 'puede_ver') wireado en
// GET /api/projects/:id/conceptos (prompt-checkpermiso-presupuestos.md).
// Corre contra la base real apuntada por DATABASE_URL (mismo patrón que
// tests/idor.test.js) — crea un único usuario 'residente' temporal, lo
// asigna a un proyecto existente vía usuario_proyectos (para que
// verificarAccesoObra pase y el único gate en juego sea checkPermiso), y lo
// elimina al terminar (afterAll) sin tocar ningún dato existente.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let adminToken;
let testProjectId;
let tempUserId;
let tempToken;
const tempUsuario = `qa_presupuestos_${Date.now()}`;
const tempPassword = 'QaPresupuestosTemp123!';

async function login(usuario, password) {
  const res = await request(app).post('/api/auth/login').send({ usuario, password });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`Login falló para ${usuario}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

async function setPermisoPresupuestos(usuarioId, puedeVer) {
  const res = await request(app)
    .put(`/api/permisos/${usuarioId}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ proyecto_id: null, permisos: [{ seccion: 'presupuestos', puede_ver: puedeVer }] });
  if (res.status !== 200) {
    throw new Error(`No se pudo setear el permiso: ${res.status} ${JSON.stringify(res.body)}`);
  }
}

beforeAll(async () => {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada — no se puede correr la suite de integración.');
  adminToken = await login(ADMIN_USER, ADMIN_PASSWORD);

  const { rows } = await db.pool.query('SELECT id FROM proyectos ORDER BY id LIMIT 1');
  if (!rows[0]) throw new Error('No hay ningún proyecto en la base de datos contra la cual correr la suite.');
  testProjectId = rows[0].id;

  const createRes = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA Presupuestos Permisos', usuario: tempUsuario, password: tempPassword, puesto: 'residente' });
  if (createRes.status !== 201 && createRes.status !== 200) {
    throw new Error(`No se pudo crear el usuario temporal: ${createRes.status} ${JSON.stringify(createRes.body)}`);
  }
  tempUserId = createRes.body.id;

  // Asignar la obra de prueba para que verificarAccesoObra pase y el único
  // gate relevante en el test sea checkPermiso('presupuestos', 'puede_ver').
  const asignaRes = await request(app)
    .put(`/api/usuarios/${tempUserId}/proyectos`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ project_ids: [testProjectId] });
  if (asignaRes.status !== 200) {
    throw new Error(`No se pudo asignar la obra al usuario temporal: ${asignaRes.status} ${JSON.stringify(asignaRes.body)}`);
  }

  tempToken = await login(tempUsuario, tempPassword);
});

afterAll(async () => {
  if (tempUserId) {
    await request(app).delete(`/api/usuarios/${tempUserId}`).set('Authorization', `Bearer ${adminToken}`);
  }
  await db.pool.end();
});

describe('checkPermiso(presupuestos, puede_ver) — GET /api/projects/:id/conceptos', () => {
  it('residente SIN puede_ver en presupuestos recibe 403 real', async () => {
    await setPermisoPresupuestos(tempUserId, false);
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/conceptos`)
      .set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(403);
  });

  it('residente CON puede_ver en presupuestos accede sin 403', async () => {
    await setPermisoPresupuestos(tempUserId, true);
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/conceptos`)
      .set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).not.toBe(403);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('admin mantiene acceso total sin depender de permisos_usuario', async () => {
    await setPermisoPresupuestos(tempUserId, false); // no afecta a admin, solo al residente
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/conceptos`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).not.toBe(403);
  });
});
