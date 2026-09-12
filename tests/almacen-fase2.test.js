// Integration test para Almacén Fase 2 (prompt-almacen-fase2.md): existencias
// calculadas al vuelo (Entradas − Salidas) por insumo, sin persistir columna
// alguna. Mismo patrón autocontenido de tests/almacen-fase1.test.js (usuarios
// temporales reales, asignados vía usuario_proyectos, limpieza física
// garantizada en afterAll).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let adminToken;
let testProjectId;
let insumoNormalId;   // existencia positiva
let insumoNegativoId; // salidas > entradas
let comprasUserId, comprasToken;
let residenteUserId, residenteToken;
const comprasUsuario = `qa_almacen2_compras_${Date.now()}`;
const residenteUsuario = `qa_almacen2_residente_${Date.now()}`;
const tempPassword = 'QaAlmacen2123!';

const entradaIdsCreadas = [];
const salidaIdsCreadas = [];

async function login(usuario, password) {
  const res = await request(app).post('/api/auth/login').send({ usuario, password });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`Login falló para ${usuario}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

beforeAll(async () => {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada — no se puede correr la suite de integración.');
  adminToken = await login(ADMIN_USER, ADMIN_PASSWORD);

  const { rows: proj } = await db.pool.query('SELECT id FROM proyectos ORDER BY id LIMIT 1');
  if (!proj.length) throw new Error('Se necesita al menos 1 obra real en Preview para correr esta suite.');
  testProjectId = proj[0].id;

  const { rows: ins } = await db.pool.query('SELECT id FROM insumos WHERE project_id = $1 ORDER BY id LIMIT 2', [testProjectId]);
  if (ins.length < 2) throw new Error(`La obra ${testProjectId} necesita al menos 2 insumos reales — no se puede correr esta suite.`);
  insumoNormalId = ins[0].id;
  insumoNegativoId = ins[1].id;

  const crearUsuario = async (usuario, puesto) => {
    const res = await request(app)
      .post('/api/usuarios')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: `QA Almacén2 ${puesto}`, usuario, password: tempPassword, puesto });
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`No se pudo crear el usuario temporal ${usuario}: ${res.status} ${JSON.stringify(res.body)}`);
    }
    const userId = res.body.id;
    const asignaRes = await request(app)
      .put(`/api/usuarios/${userId}/proyectos`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ project_ids: [testProjectId] });
    if (asignaRes.status !== 200) {
      throw new Error(`No se pudo asignar la obra al usuario temporal ${usuario}: ${asignaRes.status} ${JSON.stringify(asignaRes.body)}`);
    }
    return userId;
  };

  comprasUserId = await crearUsuario(comprasUsuario, 'compras');
  comprasToken = await login(comprasUsuario, tempPassword);
  residenteUserId = await crearUsuario(residenteUsuario, 'residente');
  residenteToken = await login(residenteUsuario, tempPassword);

  // Insumo normal: 10 entradas a $100 (valor 1000), 4 salidas -> existencia 6, valor_estimado 600.
  const e1 = await request(app).post(`/api/projects/${testProjectId}/almacen/entradas`)
    .set('Authorization', `Bearer ${comprasToken}`)
    .send({ insumo_id: insumoNormalId, cantidad: 10, costo_unitario: 100 });
  entradaIdsCreadas.push(e1.body.id);
  const s1 = await request(app).post(`/api/projects/${testProjectId}/almacen/salidas`)
    .set('Authorization', `Bearer ${residenteToken}`)
    .send({ insumo_id: insumoNormalId, cantidad: 4 });
  salidaIdsCreadas.push(s1.body.id);

  // Insumo negativo: 2 entradas, 5 salidas -> existencia -3 (inconsistente).
  const e2 = await request(app).post(`/api/projects/${testProjectId}/almacen/entradas`)
    .set('Authorization', `Bearer ${comprasToken}`)
    .send({ insumo_id: insumoNegativoId, cantidad: 2, costo_unitario: 50 });
  entradaIdsCreadas.push(e2.body.id);
  const s2 = await request(app).post(`/api/projects/${testProjectId}/almacen/salidas`)
    .set('Authorization', `Bearer ${residenteToken}`)
    .send({ insumo_id: insumoNegativoId, cantidad: 5 });
  salidaIdsCreadas.push(s2.body.id);
}, 30000);

afterAll(async () => {
  if (entradaIdsCreadas.length) {
    await db.pool.query('DELETE FROM almacen_entradas WHERE id = ANY($1::int[])', [entradaIdsCreadas]);
    const { rows } = await db.pool.query('SELECT id FROM almacen_entradas WHERE id = ANY($1::int[])', [entradaIdsCreadas]);
    if (rows.length !== 0) throw new Error('Limpieza incompleta: quedaron entradas de almacén de prueba.');
  }
  if (salidaIdsCreadas.length) {
    await db.pool.query('DELETE FROM almacen_salidas WHERE id = ANY($1::int[])', [salidaIdsCreadas]);
    const { rows } = await db.pool.query('SELECT id FROM almacen_salidas WHERE id = ANY($1::int[])', [salidaIdsCreadas]);
    if (rows.length !== 0) throw new Error('Limpieza incompleta: quedaron salidas de almacén de prueba.');
  }
  for (const userId of [comprasUserId, residenteUserId]) {
    if (!userId) continue;
    const delRes = await request(app).delete(`/api/usuarios/${userId}`).set('Authorization', `Bearer ${adminToken}`);
    const { rows } = await db.pool.query('SELECT id FROM usuarios WHERE id = $1', [userId]);
    if (delRes.status !== 200 || rows.length !== 0) {
      throw new Error(`Limpieza incompleta: usuario temporal ${userId} no se borró (status ${delRes.status}).`);
    }
  }
  await db.pool.end();
});

describe('GET /api/projects/:id/almacen/existencias', () => {
  it('requiere autenticación', async () => {
    const res = await request(app).get(`/api/projects/${testProjectId}/almacen/existencias`);
    expect(res.status).toBe(401);
  });

  it('calcula existencia_actual = entradas - salidas para un insumo normal', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/almacen/existencias`)
      .set('Authorization', `Bearer ${comprasToken}`);
    expect(res.status).toBe(200);
    const row = res.body.find((r) => r.insumo_id === insumoNormalId);
    expect(row).toBeDefined();
    expect(row.total_entradas).toBe(10);
    expect(row.total_salidas).toBe(4);
    expect(row.existencia_actual).toBe(6);
    expect(row.inconsistente).toBe(false);
  });

  it('marca inconsistente: true cuando salidas > entradas, sin ocultar el dato', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/almacen/existencias`)
      .set('Authorization', `Bearer ${comprasToken}`);
    expect(res.status).toBe(200);
    const row = res.body.find((r) => r.insumo_id === insumoNegativoId);
    expect(row).toBeDefined();
    expect(row.total_entradas).toBe(2);
    expect(row.total_salidas).toBe(5);
    expect(row.existencia_actual).toBe(-3);
    expect(row.inconsistente).toBe(true);
  });

  it('compras SÍ ve valor_estimado', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/almacen/existencias`)
      .set('Authorization', `Bearer ${comprasToken}`);
    expect(res.status).toBe(200);
    const row = res.body.find((r) => r.insumo_id === insumoNormalId);
    expect(row.valor_estimado).toBe(600); // 6 existencia * $100 costo promedio
  });

  it('residente NO ve valor_estimado (campo omitido, no solo null)', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/almacen/existencias`)
      .set('Authorization', `Bearer ${residenteToken}`);
    expect(res.status).toBe(200);
    const row = res.body.find((r) => r.insumo_id === insumoNormalId);
    expect(row).toBeDefined();
    expect(row.valor_estimado).toBeUndefined();
    expect('valor_estimado' in row).toBe(false);
    // pero sí ve cantidades
    expect(row.existencia_actual).toBe(6);
  });

  it('admin también ve valor_estimado (bypass de rol)', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/almacen/existencias`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const row = res.body.find((r) => r.insumo_id === insumoNormalId);
    expect(row.valor_estimado).toBe(600);
  });
});
