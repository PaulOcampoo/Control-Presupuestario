// Integration tests para prompt-fase3-integracion-avance-estimaciones.md,
// Mecanismo B (sugerencia — nunca forzada — de volumen desde un Generador
// de Obra "aprobado" en la captura semanal de Avance, con reparto
// proporcional a días de solape cuando el periodo del Generador cubre
// varias semanas). Corre contra la base real apuntada por DATABASE_URL.
//
// Las semanas de avances_semanales se insertan directo por SQL con números
// de semana nuevos (MAX(semana) + offset grande, nunca reutilizados) para
// no tocar semanas reales ya capturadas de la obra de prueba (regla dura
// del proyecto: nunca modificar avance ya capturado) — se borran físicamente
// en afterAll, junto con cualquier avance_conceptos que el propio test haya
// insertado en esas semanas nuevas.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let adminToken;
let creadorToken;
let testProjectId;
let conceptoId;
let creadorId;
let semanaBase;
const creadorUsuario = `qa_fase3_sugerencia_${Date.now()}`;
const tempPassword = 'QaFase3SugerenciaTemp123!';
const generadorIds = [];
const semanasCreadas = [];

async function login(usuario, password) {
  const res = await request(app).post('/api/auth/login').send({ usuario, password });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`Login falló para ${usuario}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

async function crearSemana(semana, fecha_inicio, fecha_fin) {
  await db.pool.query(
    `INSERT INTO avances_semanales (project_id, semana, fecha_inicio, fecha_fin) VALUES ($1,$2,$3,$4)`,
    [testProjectId, semana, fecha_inicio, fecha_fin]
  );
  semanasCreadas.push(semana);
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

async function aprobarGeneradorConVolumen(genId, largo, ancho) {
  await request(app)
    .post(`/api/projects/${testProjectId}/generadores-obra/${genId}/renglones`)
    .set('Authorization', `Bearer ${creadorToken}`)
    .send({ concepto_id: conceptoId, descripcion: 'Renglón QA sugerencia', tramo: 'T1', largo, ancho });
  await request(app)
    .put(`/api/projects/${testProjectId}/generadores-obra/${genId}/estado`)
    .set('Authorization', `Bearer ${creadorToken}`)
    .send({ estado: 'enviada' });
  await request(app)
    .put(`/api/projects/${testProjectId}/generadores-obra/${genId}/estado`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ estado: 'aprobada' });
}

beforeAll(async () => {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada — no se puede correr la suite.');
  adminToken = await login(ADMIN_USER, ADMIN_PASSWORD);

  const { rows: projRows } = await db.pool.query('SELECT id FROM proyectos ORDER BY id LIMIT 1');
  if (!projRows[0]) throw new Error('No hay ningún proyecto contra el cual correr la suite.');
  testProjectId = projRows[0].id;

  const { rows: conRows } = await db.pool.query(
    `SELECT id FROM conceptos WHERE project_id = $1 AND es_total = 0 AND activo = 1 AND cantidad > 0
     AND TRIM(COALESCE(unidad, '')) <> '' LIMIT 1`,
    [testProjectId]
  );
  if (!conRows[0]) throw new Error('El proyecto de prueba no tiene ningún concepto real elegible.');
  conceptoId = conRows[0].id;

  const { rows: maxRows } = await db.pool.query('SELECT COALESCE(MAX(semana), 0) AS max FROM avances_semanales WHERE project_id = $1', [testProjectId]);
  semanaBase = Number(maxRows[0].max) + 9000;

  const crearRes = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA Fase3 Sugerencia', usuario: creadorUsuario, password: tempPassword, puesto: 'residente' });
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
  if (semanasCreadas.length) {
    await db.pool.query('DELETE FROM avance_conceptos WHERE semana = ANY($1)', [semanasCreadas]);
    await db.pool.query('DELETE FROM avances_semanales WHERE project_id = $1 AND semana = ANY($2)', [testProjectId, semanasCreadas]);
  }
  for (const gid of generadorIds) {
    await db.pool.query('DELETE FROM generador_obra_renglones WHERE generador_id = $1', [gid]);
    await db.pool.query('DELETE FROM generadores_obra WHERE id = $1', [gid]);
  }
  if (creadorId) await request(app).delete(`/api/usuarios/${creadorId}`).set('Authorization', `Bearer ${adminToken}`);
});

describe('GET /api/projects/:id/avances/:semana/conceptos — sugerencia desde Generador de Obra', () => {
  it('reparte el volumen del Generador proporcional a los días de solape entre 2 semanas', async () => {
    const semana1 = semanaBase + 1;
    const semana2 = semanaBase + 2;
    await crearSemana(semana1, '2032-01-01', '2032-01-05'); // 5 días
    await crearSemana(semana2, '2032-01-06', '2032-01-10'); // 5 días

    const gen = await crearGenerador('2032-01-01', '2032-01-10', 'Generador 10 días'); // 10 días totales
    await aprobarGeneradorConVolumen(gen.id, 10, 2); // volumen = 20

    const res1 = await request(app)
      .get(`/api/projects/${testProjectId}/avances/${semana1}/conceptos`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res1.status).toBe(200);
    const item1 = res1.body.items.find((it) => it.concepto_id === conceptoId);
    expect(item1.sugerido_generador).toBeCloseTo(10, 5); // 20 * 5/10
    expect(item1.cantidad_ejecutada_periodo).toBeNull();

    const res2 = await request(app)
      .get(`/api/projects/${testProjectId}/avances/${semana2}/conceptos`)
      .set('Authorization', `Bearer ${adminToken}`);
    const item2 = res2.body.items.find((it) => it.concepto_id === conceptoId);
    expect(item2.sugerido_generador).toBeCloseTo(10, 5); // 20 * 5/10
  });

  it('no sugiere ("no forzar") si el concepto ya tiene cantidad_ejecutada capturada > 0 esa semana', async () => {
    const semana = semanaBase + 3;
    await crearSemana(semana, '2032-02-01', '2032-02-07');

    const gen = await crearGenerador('2032-02-01', '2032-02-07', 'Generador ya capturado');
    await aprobarGeneradorConVolumen(gen.id, 4, 1); // volumen = 4

    // Sin captura todavía: sugerencia visible.
    const antes = await request(app)
      .get(`/api/projects/${testProjectId}/avances/${semana}/conceptos`)
      .set('Authorization', `Bearer ${adminToken}`);
    const itemAntes = antes.body.items.find((it) => it.concepto_id === conceptoId);
    expect(itemAntes.sugerido_generador).toBeCloseTo(4, 5);

    // El residente captura su propio valor (distinto al sugerido).
    const put = await request(app)
      .put(`/api/projects/${testProjectId}/avances/${semana}/conceptos`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ items: [{ concepto_id: conceptoId, cantidad_ejecutada: 1 }] });
    expect(put.status).toBe(200);

    // Tras capturar, la sugerencia desaparece — nunca se sobreescribe lo ya capturado.
    const despues = await request(app)
      .get(`/api/projects/${testProjectId}/avances/${semana}/conceptos`)
      .set('Authorization', `Bearer ${adminToken}`);
    const itemDespues = despues.body.items.find((it) => it.concepto_id === conceptoId);
    expect(itemDespues.cantidad_ejecutada_periodo).toBe(1);
    expect(itemDespues.sugerido_generador).toBeNull();
  });

  it('sin ningún Generador aprobado con periodo solapado, sugerido_generador es null', async () => {
    const semana = semanaBase + 4;
    await crearSemana(semana, '2032-03-01', '2032-03-07');
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/avances/${semana}/conceptos`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const item = res.body.items.find((it) => it.concepto_id === conceptoId);
    expect(item.sugerido_generador).toBeNull();
  });
});
