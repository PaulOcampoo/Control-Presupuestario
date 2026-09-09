// Integration tests para prompt-bug-residente-no-ve-estimaciones.md — Raul
// Mendez (residente) no veía estimaciones generadas por otro usuario (Paul
// Ocampo) en una obra a la que SI tiene acceso asignado. Fase 0 confirmó
// causa raiz (a): GET /api/projects/:id/estimaciones (y el detalle/PDF)
// filtraban por "residente_id = req.user.id" cuando el rol era 'residente',
// tratando la fila como "ownership por creador" en vez de "ownership por
// obra" -- reproducido con datos reales: obra 30 (RED HIDRAULICA) tiene
// estimaciones creadas por 'Administrador' y por 'PAUL OCAMPO' que Raul
// Mendez (residente asignado a esa obra) no podia ver.
// Corre contra la base real apuntada por DATABASE_URL, mismo patron que el
// resto de tests/*.test.js -- crea datos desechables y los borra en afterAll
// (borrado fisico, no soft-delete, ver memoria del proyecto).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let adminToken;
let creadorToken;
let otroResidenteToken;
let ajenoResidenteToken;
let testProjectId;
let creadorId;
let otroResidenteId;
let ajenoResidenteId;
let estimacionId;
const creadorUsuario = `qa_est_creador_${Date.now()}`;
const otroUsuario = `qa_est_otro_${Date.now()}`;
const ajenoUsuario = `qa_est_ajeno_${Date.now()}`;
const tempPassword = 'QaEstimacionesTemp123!';

async function login(usuario, password) {
  const res = await request(app).post('/api/auth/login').send({ usuario, password });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`Login falló para ${usuario}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

async function crearResidente(nombre, usuario) {
  const res = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre, usuario, password: tempPassword, puesto: 'residente' });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`No se pudo crear el residente temporal ${usuario}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.id;
}

beforeAll(async () => {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada — no se puede correr la suite.');
  adminToken = await login(ADMIN_USER, ADMIN_PASSWORD);

  const { rows: projRows } = await db.pool.query('SELECT id FROM proyectos ORDER BY id LIMIT 1');
  if (!projRows[0]) throw new Error('No hay ningún proyecto contra el cual correr la suite.');
  testProjectId = projRows[0].id;

  creadorId = await crearResidente('QA Estimacion Creador', creadorUsuario);
  otroResidenteId = await crearResidente('QA Estimacion Otro Residente', otroUsuario);
  ajenoResidenteId = await crearResidente('QA Estimacion Ajeno', ajenoUsuario);

  // creador y otroResidente SI comparten la obra de prueba; ajeno NO -- sirve
  // de control negativo para confirmar que el fix no abre acceso global.
  for (const uid of [creadorId, otroResidenteId]) {
    const asignaRes = await request(app)
      .put(`/api/usuarios/${uid}/proyectos`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ project_ids: [testProjectId] });
    if (asignaRes.status !== 200) throw new Error(`No se pudo asignar la obra: ${asignaRes.status} ${JSON.stringify(asignaRes.body)}`);
  }

  creadorToken = await login(creadorUsuario, tempPassword);
  otroResidenteToken = await login(otroUsuario, tempPassword);
  ajenoResidenteToken = await login(ajenoUsuario, tempPassword);

  const estRes = await request(app)
    .post(`/api/projects/${testProjectId}/estimaciones`)
    .set('Authorization', `Bearer ${creadorToken}`)
    .send({ periodo_inicio: '2030-01-01', periodo_fin: '2030-01-07' });
  if (estRes.status !== 201) throw new Error(`No se pudo crear la estimación de prueba: ${estRes.status} ${JSON.stringify(estRes.body)}`);
  estimacionId = estRes.body.id;
});

afterAll(async () => {
  if (estimacionId) await db.pool.query('DELETE FROM estimaciones WHERE id = $1', [estimacionId]);
  for (const uid of [creadorId, otroResidenteId, ajenoResidenteId]) {
    if (uid) await request(app).delete(`/api/usuarios/${uid}`).set('Authorization', `Bearer ${adminToken}`);
  }
});

describe('Bug: residente no ve estimaciones generadas por otro usuario en su misma obra', () => {
  it('un residente con acceso a la obra SI ve en el listado una estimación creada por otro usuario', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/estimaciones`)
      .set('Authorization', `Bearer ${otroResidenteToken}`);
    expect(res.status).toBe(200);
    expect(res.body.some((e) => e.id === estimacionId)).toBe(true);
  });

  it('un residente con acceso a la obra SI puede abrir el detalle de una estimación creada por otro usuario', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/estimaciones/${estimacionId}`)
      .set('Authorization', `Bearer ${otroResidenteToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(estimacionId);
  });

  it('control negativo: un residente SIN acceso a la obra sigue sin ver la estimación (no se abrió acceso global)', async () => {
    const listado = await request(app)
      .get(`/api/projects/${testProjectId}/estimaciones`)
      .set('Authorization', `Bearer ${ajenoResidenteToken}`);
    expect(listado.status).toBe(403);

    const detalle = await request(app)
      .get(`/api/projects/${testProjectId}/estimaciones/${estimacionId}`)
      .set('Authorization', `Bearer ${ajenoResidenteToken}`);
    expect(detalle.status).toBe(403);
  });

  it('el propio creador sigue viendo su estimación (regresión trivial)', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/estimaciones/${estimacionId}`)
      .set('Authorization', `Bearer ${creadorToken}`);
    expect(res.status).toBe(200);
  });
});
