// Integration tests para CN-001 (privilege escalation, CWE-269/863,
// prompt-fix-CN-001-privesc-usuarios.md): un usuario 'administracion' ya no
// puede auto-asignarse ni asignarle a otros el puesto 'admin'/'desarrollador'
// vía POST/PUT /api/usuarios, y ningún usuario puede cambiar su propio puesto
// vía PUT /api/usuarios/:id. Mismo patrón que tests/idor.test.js: corre
// contra la base de datos real apuntada por DATABASE_URL (no hay DB de
// pruebas separada en este proyecto) — crea usuarios temporales desechables
// y los elimina al terminar (afterAll), sin tocar ningún dato existente.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let adminToken;
let administracionUserId;
let administracionToken;
const administracionUsuario = `qa_cn001_admtn_${Date.now()}`;
const administracionPassword = 'QaCn001Temp123!';

const createdUserIdsToCleanup = [];

async function login(usuario, password) {
  const res = await request(app).post('/api/auth/login').send({ usuario, password });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`Login falló para ${usuario}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

beforeAll(async () => {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada — no se puede correr la suite CN-001.');
  adminToken = await login(ADMIN_USER, ADMIN_PASSWORD);

  const createRes = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA CN-001 administracion', usuario: administracionUsuario, password: administracionPassword, puesto: 'administracion' });
  if (createRes.status !== 201 && createRes.status !== 200) {
    throw new Error(`No se pudo crear el usuario temporal 'administracion': ${createRes.status} ${JSON.stringify(createRes.body)}`);
  }
  administracionUserId = createRes.body.id;
  createdUserIdsToCleanup.push(administracionUserId);
  administracionToken = await login(administracionUsuario, administracionPassword);
});

afterAll(async () => {
  for (const id of createdUserIdsToCleanup) {
    await request(app).delete(`/api/usuarios/${id}`).set('Authorization', `Bearer ${adminToken}`);
  }
  await db.pool.end();
});

describe('CN-001 — privilege escalation vía /api/usuarios', () => {
  it('POST /api/usuarios — actor administracion, body puesto=admin → 403', async () => {
    const res = await request(app)
      .post('/api/usuarios')
      .set('Authorization', `Bearer ${administracionToken}`)
      .send({ nombre: 'QA Should Not Exist', usuario: `qa_cn001_shouldfail_${Date.now()}`, password: 'QaCn001Fail123!', puesto: 'admin' });
    console.log('CHECKPOINT 1 — POST /api/usuarios (administracion → admin):', res.status, JSON.stringify(res.body));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('No puedes asignar ese puesto');
  });

  it('PUT /api/usuarios/:id (propio) — actor administracion, body puesto=admin → 403', async () => {
    const res = await request(app)
      .put(`/api/usuarios/${administracionUserId}`)
      .set('Authorization', `Bearer ${administracionToken}`)
      .send({ puesto: 'admin' });
    console.log('CHECKPOINT 2 — PUT /api/usuarios/:id propio (administracion → admin):', res.status, JSON.stringify(res.body));
    expect(res.status).toBe(403);
  });

  it('PUT /api/usuarios/:id (propio) — puesto sin cambio (no-op) → no bloquea', async () => {
    const res = await request(app)
      .put(`/api/usuarios/${administracionUserId}`)
      .set('Authorization', `Bearer ${administracionToken}`)
      .send({ puesto: 'administracion' });
    console.log('CHECKPOINT 3 — PUT /api/usuarios/:id propio, no-op (administracion → administracion):', res.status, JSON.stringify(res.body));
    expect(res.status).not.toBe(403);
  });

  it('POST /api/usuarios — actor admin/desarrollador sigue pudiendo crear usuarios admin (regresión negativa)', async () => {
    const nuevoUsuario = `qa_cn001_adminok_${Date.now()}`;
    const res = await request(app)
      .post('/api/usuarios')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'QA CN-001 admin-creado-por-admin', usuario: nuevoUsuario, password: 'QaCn001AdminOk123!', puesto: 'admin' });
    console.log('CHECKPOINT 4 — POST /api/usuarios (admin → admin):', res.status, JSON.stringify(res.body));
    expect(res.status).toBe(201);
    if (res.body?.id) createdUserIdsToCleanup.push(res.body.id);
  });
});
