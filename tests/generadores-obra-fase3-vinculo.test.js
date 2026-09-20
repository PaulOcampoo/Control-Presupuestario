// Integration tests para prompt-fase3-integracion-avance-estimaciones.md,
// Mecanismo A (vínculo formal Estimación<->Generador de Obra, puramente de
// referencia — nunca escribe estimacion_conceptos). Corre contra la base
// real apuntada por DATABASE_URL, mismo patrón que
// tests/generadores-obra.test.js. Crea datos desechables y los borra
// físicamente en afterAll.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let adminToken;
let creadorToken;
let testProjectId;
let otherProjectId;
let conceptoId;
let creadorId;
const creadorUsuario = `qa_fase3_vinculo_${Date.now()}`;
const tempPassword = 'QaFase3VinculoTemp123!';
const generadorIds = [];
const estimacionIds = [];

async function login(usuario, password) {
  const res = await request(app).post('/api/auth/login').send({ usuario, password });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`Login falló para ${usuario}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

async function crearGenerador(periodo_inicio, periodo_fin, nombre) {
  const res = await request(app)
    .post(`/api/projects/${testProjectId}/generadores-obra`)
    .set('Authorization', `Bearer ${creadorToken}`)
    .send({ periodo_inicio, periodo_fin, nombre });
  if (res.status !== 201) throw new Error(`No se pudo crear el generador: ${res.status} ${JSON.stringify(res.body)}`);
  generadorIds.push(res.body.id);
  return res.body;
}

async function aprobarGenerador(genId) {
  await request(app)
    .post(`/api/projects/${testProjectId}/generadores-obra/${genId}/renglones`)
    .set('Authorization', `Bearer ${creadorToken}`)
    .send({ concepto_id: conceptoId, descripcion: 'Renglón QA', tramo: 'T1', largo: 5, ancho: 2 });
  await request(app)
    .put(`/api/projects/${testProjectId}/generadores-obra/${genId}/estado`)
    .set('Authorization', `Bearer ${creadorToken}`)
    .send({ estado: 'enviada' });
  await request(app)
    .put(`/api/projects/${testProjectId}/generadores-obra/${genId}/estado`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ estado: 'aprobada' });
}

async function crearEstimacion(pid, periodo_inicio, periodo_fin) {
  const res = await request(app)
    .post(`/api/projects/${pid}/estimaciones`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ periodo_inicio, periodo_fin });
  if (res.status !== 201) throw new Error(`No se pudo crear la estimación: ${res.status} ${JSON.stringify(res.body)}`);
  estimacionIds.push({ id: res.body.id, pid });
  return res.body;
}

beforeAll(async () => {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada — no se puede correr la suite.');
  adminToken = await login(ADMIN_USER, ADMIN_PASSWORD);

  const { rows: projRows } = await db.pool.query('SELECT id FROM proyectos ORDER BY id LIMIT 2');
  if (projRows.length < 2) throw new Error('Se necesitan al menos 2 proyectos contra los cuales correr la suite.');
  testProjectId = projRows[0].id;
  otherProjectId = projRows[1].id;

  const { rows: conRows } = await db.pool.query(
    `SELECT id FROM conceptos WHERE project_id = $1 AND es_total = 0 AND activo = 1 AND cantidad > 0
     AND TRIM(COALESCE(unidad, '')) <> '' LIMIT 1`,
    [testProjectId]
  );
  if (!conRows[0]) throw new Error('El proyecto de prueba no tiene ningún concepto real elegible.');
  conceptoId = conRows[0].id;

  const crearRes = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA Fase3 Vinculo', usuario: creadorUsuario, password: tempPassword, puesto: 'residente' });
  if (crearRes.status !== 201 && crearRes.status !== 200) {
    throw new Error(`No se pudo crear el residente temporal: ${crearRes.status} ${JSON.stringify(crearRes.body)}`);
  }
  creadorId = crearRes.body.id;
  const asignaRes = await request(app)
    .put(`/api/usuarios/${creadorId}/proyectos`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ project_ids: [testProjectId] });
  if (asignaRes.status !== 200) throw new Error(`No se pudo asignar la obra: ${asignaRes.status} ${JSON.stringify(asignaRes.body)}`);
  creadorToken = await login(creadorUsuario, tempPassword);
}, 30000);

afterAll(async () => {
  for (const { id } of estimacionIds) {
    await db.pool.query('DELETE FROM estimacion_conceptos WHERE estimacion_id = $1', [id]);
    await db.pool.query('DELETE FROM estimaciones WHERE id = $1', [id]);
  }
  for (const gid of generadorIds) {
    await db.pool.query('DELETE FROM generador_obra_renglones WHERE generador_id = $1', [gid]);
    await db.pool.query('DELETE FROM generadores_obra WHERE id = $1', [gid]);
  }
  if (creadorId) await request(app).delete(`/api/usuarios/${creadorId}`).set('Authorization', `Bearer ${adminToken}`);
});

describe('GET /api/projects/:id/estimaciones/:estId/generadores-candidatos', () => {
  it('solo devuelve generadores aprobados de la misma obra cuyo periodo se solapa', async () => {
    const genAprobadoSolapa = await crearGenerador('2031-01-01', '2031-01-15', 'Aprobado y solapa');
    await aprobarGenerador(genAprobadoSolapa.id);

    const genBorrador = await crearGenerador('2031-01-01', '2031-01-15', 'Sigue en borrador');

    const genAprobadoSinSolape = await crearGenerador('2031-03-01', '2031-03-07', 'Aprobado pero sin solape');
    await aprobarGenerador(genAprobadoSinSolape.id);

    const est = await crearEstimacion(testProjectId, '2031-01-05', '2031-01-20');
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/estimaciones/${est.id}/generadores-candidatos`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.candidatos.map((c) => c.id);
    expect(ids).toContain(genAprobadoSolapa.id);
    expect(ids).not.toContain(genBorrador.id);
    expect(ids).not.toContain(genAprobadoSinSolape.id);
  });
});

describe('PUT /api/projects/:id/estimaciones/:estId/vincular-generador', () => {
  it('vincula un generador aprobado de la misma obra y lo refleja en el detalle, sin tocar cantidad_periodo', async () => {
    const gen = await crearGenerador('2031-04-01', '2031-04-07', 'Para vincular');
    await aprobarGenerador(gen.id);
    const est = await crearEstimacion(testProjectId, '2031-04-01', '2031-04-07');

    const vincular = await request(app)
      .put(`/api/projects/${testProjectId}/estimaciones/${est.id}/vincular-generador`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ generador_obra_id: gen.id });
    expect(vincular.status).toBe(200);

    const detalle = await request(app)
      .get(`/api/projects/${testProjectId}/estimaciones/${est.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(detalle.status).toBe(200);
    expect(detalle.body.generador_vinculado.id).toBe(gen.id);
    expect(detalle.body.generador_obra_id).toBe(gen.id);
    const item = detalle.body.items.find((it) => it.concepto_id === conceptoId);
    if (item) expect(item.volumen_generador).toBe(10); // largo 5 x ancho 2

    // Volumen de referencia no debe tocar cantidad_periodo (exclusivo de /calcular)
    for (const it of detalle.body.items) expect(it).toHaveProperty('cantidad_periodo');
  });

  it('desvincular (generador_obra_id: null) limpia la referencia', async () => {
    const gen = await crearGenerador('2031-05-01', '2031-05-07', 'Para desvincular');
    await aprobarGenerador(gen.id);
    const est = await crearEstimacion(testProjectId, '2031-05-01', '2031-05-07');
    await request(app)
      .put(`/api/projects/${testProjectId}/estimaciones/${est.id}/vincular-generador`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ generador_obra_id: gen.id });

    const desvincular = await request(app)
      .put(`/api/projects/${testProjectId}/estimaciones/${est.id}/vincular-generador`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ generador_obra_id: null });
    expect(desvincular.status).toBe(200);

    const detalle = await request(app)
      .get(`/api/projects/${testProjectId}/estimaciones/${est.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(detalle.body.generador_vinculado).toBe(null);
    expect(detalle.body.generador_obra_id).toBe(null);
  });

  it('rechaza (404) vincular un generador de OTRA obra', async () => {
    const genRes = await request(app)
      .post(`/api/projects/${otherProjectId}/generadores-obra`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ periodo_inicio: '2031-06-01', periodo_fin: '2031-06-07' });
    expect(genRes.status).toBe(201);
    generadorIds.push(genRes.body.id);

    const est = await crearEstimacion(testProjectId, '2031-06-01', '2031-06-07');
    const res = await request(app)
      .put(`/api/projects/${testProjectId}/estimaciones/${est.id}/vincular-generador`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ generador_obra_id: genRes.body.id });
    expect(res.status).toBe(404);
  });

  it('rechaza (404) vincular un generador que no está en estado aprobada', async () => {
    const gen = await crearGenerador('2031-07-01', '2031-07-07', 'Sigue en borrador');
    const est = await crearEstimacion(testProjectId, '2031-07-01', '2031-07-07');
    const res = await request(app)
      .put(`/api/projects/${testProjectId}/estimaciones/${est.id}/vincular-generador`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ generador_obra_id: gen.id });
    expect(res.status).toBe(404);
  });
});
