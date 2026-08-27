// Integration tests para prompt-revocar-infravivienda-cabo.md — el rol
// 'cabo' NO debe tener acceso a la pantalla "Infraestructura vs. Vivienda"
// (infraVivienda) bajo ninguna vía: ni sidebar/tabs (ROLE_TABS.cabo en
// public/app.js), ni API directa. Este archivo cubre la vía de API directa
// — los tres endpoints que antes hardcodeaban 'cabo' en auth.allow(...) y
// que en realidad son la data de Infraestructura vs. Vivienda
// (grupos-categoria, avance-por-categoria), NO el Avance genérico que cabo
// sí conserva legítimamente.
//
// Mismo patrón de boilerplate que tests/maquinaria-aprobacion-cabo-
// residente.test.js: corre contra la base real apuntada por DATABASE_URL,
// crea un usuario cabo temporal vía la API (admin), lo asigna a una obra
// real, hace login real, y borra todo físicamente en afterAll (regla del
// proyecto: datos de prueba se eliminan físicamente, no soft-delete).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let adminToken;
let caboToken;
let testProjectId;
let caboTempId;
const caboTempUsuario = `qa_cabo_infravivienda_${Date.now()}`;
const tempPassword = 'QaInfraViviendaTemp123!';

async function login(usuario, password) {
  const res = await request(app).post('/api/auth/login').send({ usuario, password });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`Login falló para ${usuario}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

beforeAll(async () => {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada — no se puede correr la suite.');
  adminToken = await login(ADMIN_USER, ADMIN_PASSWORD);

  const { rows: projRows } = await db.pool.query('SELECT id FROM proyectos ORDER BY id LIMIT 1');
  if (!projRows[0]) throw new Error('No hay ningún proyecto contra el cual correr la suite.');
  testProjectId = projRows[0].id;

  const caboRes = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA Cabo InfraVivienda', usuario: caboTempUsuario, password: tempPassword, puesto: 'cabo' });
  if (caboRes.status !== 201 && caboRes.status !== 200) throw new Error(`No se pudo crear el cabo temporal: ${caboRes.status} ${JSON.stringify(caboRes.body)}`);
  caboTempId = caboRes.body.id;

  const asignaRes = await request(app)
    .put(`/api/usuarios/${caboTempId}/proyectos`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ project_ids: [testProjectId] });
  if (asignaRes.status !== 200) throw new Error(`No se pudo asignar la obra al cabo temporal: ${asignaRes.status} ${JSON.stringify(asignaRes.body)}`);

  caboToken = await login(caboTempUsuario, tempPassword);
});

afterAll(async () => {
  if (caboTempId) await request(app).delete(`/api/usuarios/${caboTempId}`).set('Authorization', `Bearer ${adminToken}`);
  await db.pool.end();
});

describe('cabo sin acceso a Infraestructura vs. Vivienda (revocado)', () => {
  it('GET /grupos-categoria devuelve 403 para cabo', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/grupos-categoria`)
      .set('Authorization', `Bearer ${caboToken}`);
    expect(res.status).toBe(403);
  });

  it('POST /grupos-categoria devuelve 403 para cabo', async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/grupos-categoria`)
      .set('Authorization', `Bearer ${caboToken}`)
      .send({ clasificaciones: [{ grupo: 'X', categoria: 'infraestructura' }] });
    expect(res.status).toBe(403);
  });

  it('GET /avance-por-categoria devuelve 403 para cabo', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/avance-por-categoria`)
      .set('Authorization', `Bearer ${caboToken}`);
    expect(res.status).toBe(403);
  });
});

describe('acceso legítimo de cabo a Avance NO se ve afectado (checkpoint del prompt)', () => {
  it('GET /avances sigue devolviendo 200 (no 403) para cabo', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/avances`)
      .set('Authorization', `Bearer ${caboToken}`);
    expect(res.status).toBe(200);
  });
});
