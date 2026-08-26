// Integration test para la Fase 4 del roadmap "Desarrollador de Vivienda",
// PR C (prompt-implementacion-pr-c-cobranza.md): plan de pagos + registro
// de cobranza sobre un contrato de venta ya firmado (PR B, #188, en
// producción). Mismo patrón autocontenido de tests/ventas-contrato.test.js.
//
// No existe endpoint DELETE para lotes/planes_pago/pagos_venta — todo se
// borra físicamente vía SQL directo en afterAll, en el orden correcto
// (pagos_venta -> plan_pago_items -> planes_pago -> contratos_venta ->
// apartados -> lotes) para no violar las FKs.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let adminToken;
let testProjectId;
let otroProjectId;
let tempUserId;
let tempToken;
const tempUsuario = `qa_cobranza_${Date.now()}`;
const tempPassword = 'QaCobranza123!';

const loteIdsCreados = [];
const compradorIdsCreados = [];
const contratoVentaIdsCreados = [];

async function login(usuario, password) {
  const res = await request(app).post('/api/auth/login').send({ usuario, password });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`Login falló para ${usuario}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

async function crearLote(numeroSufijo) {
  const res = await request(app)
    .post(`/api/projects/${testProjectId}/lotes`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ numero_lote: `QA-CB-${numeroSufijo}-${Date.now()}` });
  loteIdsCreados.push(res.body.id);
  return res.body;
}

async function crearComprador(sufijo) {
  const res = await request(app)
    .post(`/api/projects/${testProjectId}/compradores`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: `QA Comprador CB ${sufijo} ${Date.now()}` });
  compradorIdsCreados.push(res.body.id);
  return res.body;
}

// Venta directa sobre un lote marcado 'disponible' vía el endpoint de PR B
// (más simple que crear-y-cancelar un apartado para llegar a 'disponible').
async function crearContratoVentaDirecto(sufijo, montoTotal = 100000) {
  const comprador = await crearComprador(sufijo);
  const lote = await crearLote(sufijo);
  const marcar = await request(app)
    .put(`/api/projects/${testProjectId}/lotes/${lote.id}/marcar-disponible`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(marcar.status).toBe(200);
  const res = await request(app)
    .post(`/api/projects/${testProjectId}/contratos-venta`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ lote_id: lote.id, comprador_id: comprador.id, monto_total: montoTotal });
  expect(res.status).toBe(201);
  contratoVentaIdsCreados.push(res.body.id);
  return res.body;
}

beforeAll(async () => {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada — no se puede correr la suite de integración.');
  adminToken = await login(ADMIN_USER, ADMIN_PASSWORD);

  const { rows } = await db.pool.query('SELECT id FROM proyectos ORDER BY id LIMIT 2');
  if (rows.length < 2) throw new Error('Se necesitan al menos 2 obras reales en Preview para correr esta suite (validación cross-obra).');
  testProjectId = rows[0].id;
  otroProjectId = rows[1].id;

  const createRes = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA Cobranza', usuario: tempUsuario, password: tempPassword, puesto: 'residente' });
  if (createRes.status !== 201 && createRes.status !== 200) {
    throw new Error(`No se pudo crear el usuario temporal: ${createRes.status} ${JSON.stringify(createRes.body)}`);
  }
  tempUserId = createRes.body.id;

  const asignaRes = await request(app)
    .put(`/api/usuarios/${tempUserId}/proyectos`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ project_ids: [testProjectId] });
  if (asignaRes.status !== 200) {
    throw new Error(`No se pudo asignar la obra al usuario temporal: ${asignaRes.status} ${JSON.stringify(asignaRes.body)}`);
  }

  tempToken = await login(tempUsuario, tempPassword);
}, 30000);

afterAll(async () => {
  if (contratoVentaIdsCreados.length) {
    await db.pool.query('DELETE FROM pagos_venta WHERE contrato_venta_id = ANY($1::int[])', [contratoVentaIdsCreados]);
    await db.pool.query(
      'DELETE FROM plan_pago_items WHERE plan_pago_id IN (SELECT id FROM planes_pago WHERE contrato_venta_id = ANY($1::int[]))',
      [contratoVentaIdsCreados]
    );
    await db.pool.query('DELETE FROM planes_pago WHERE contrato_venta_id = ANY($1::int[])', [contratoVentaIdsCreados]);
    await db.pool.query('DELETE FROM contratos_venta WHERE id = ANY($1::int[])', [contratoVentaIdsCreados]);
  }
  if (loteIdsCreados.length) {
    await db.pool.query('DELETE FROM contratos_venta WHERE lote_id = ANY($1::int[])', [loteIdsCreados]);
    await db.pool.query('DELETE FROM apartados WHERE lote_id = ANY($1::int[])', [loteIdsCreados]);
    await db.pool.query('DELETE FROM lotes WHERE id = ANY($1::int[])', [loteIdsCreados]);
    const { rows: remanentesLotes } = await db.pool.query('SELECT id FROM lotes WHERE id = ANY($1::int[])', [loteIdsCreados]);
    if (remanentesLotes.length !== 0) throw new Error('Limpieza incompleta: quedaron lotes de prueba.');
  }
  if (compradorIdsCreados.length) {
    await db.pool.query('DELETE FROM compradores WHERE id = ANY($1::int[])', [compradorIdsCreados]);
    const { rows: remanentesCompradores } = await db.pool.query('SELECT id FROM compradores WHERE id = ANY($1::int[])', [compradorIdsCreados]);
    if (remanentesCompradores.length !== 0) throw new Error('Limpieza incompleta: quedaron compradores de prueba.');
  }
  if (tempUserId) {
    const delRes = await request(app).delete(`/api/usuarios/${tempUserId}`).set('Authorization', `Bearer ${adminToken}`);
    const { rows: usuarioRemanente } = await db.pool.query('SELECT id FROM usuarios WHERE id = $1', [tempUserId]);
    if (delRes.status !== 200 || usuarioRemanente.length !== 0) {
      throw new Error(`Limpieza incompleta: usuario temporal ${tempUsuario} (id ${tempUserId}) no se borró (status ${delRes.status}).`);
    }
  }
  await db.pool.end();
});

describe('nav-tabs — cobranza solo para admin/desarrollador', () => {
  it('admin ve cobranza en sus tabs; residente no', async () => {
    const admRes = await request(app).get(`/api/projects/${testProjectId}/nav-tabs`).set('Authorization', `Bearer ${adminToken}`);
    expect(admRes.body.tabs).toContain('cobranza');
    const resRes = await request(app).get(`/api/projects/${testProjectId}/nav-tabs`).set('Authorization', `Bearer ${tempToken}`);
    expect(resRes.body.tabs).not.toContain('cobranza');
  });
});

describe('Permisos — auth.allow() admin/desarrollador exclusivo', () => {
  it('GET cobranza requiere autenticación y bloquea a residente', async () => {
    const contrato = await crearContratoVentaDirecto('Permisos');
    const noAuth = await request(app).get(`/api/projects/${testProjectId}/contratos-venta/${contrato.id}/cobranza`);
    expect(noAuth.status).toBe(401);
    const residente = await request(app)
      .get(`/api/projects/${testProjectId}/contratos-venta/${contrato.id}/cobranza`)
      .set('Authorization', `Bearer ${tempToken}`);
    expect(residente.status).toBe(403);
  });

  it('PUT plan-pago y POST pagos bloquean a residente', async () => {
    const contrato = await crearContratoVentaDirecto('PermisosEscritura');
    const putRes = await request(app)
      .put(`/api/projects/${testProjectId}/contratos-venta/${contrato.id}/plan-pago`)
      .set('Authorization', `Bearer ${tempToken}`)
      .send({ items: [{ concepto: 'Enganche', monto_programado: 1000 }] });
    expect(putRes.status).toBe(403);

    const postRes = await request(app)
      .post(`/api/projects/${testProjectId}/contratos-venta/${contrato.id}/pagos`)
      .set('Authorization', `Bearer ${tempToken}`)
      .send({ monto: 1000 });
    expect(postRes.status).toBe(403);
  });
});

describe('Plan de pagos', () => {
  it('crea un plan con líneas, sin advertencia cuando la suma cuadra con monto_total', async () => {
    const contrato = await crearContratoVentaDirecto('PlanCuadra', 100000);
    const res = await request(app)
      .put(`/api/projects/${testProjectId}/contratos-venta/${contrato.id}/plan-pago`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ items: [
        { concepto: 'Enganche', monto_programado: 40000, orden: 0 },
        { concepto: 'Contra entrega', monto_programado: 60000, orden: 1 },
      ] });
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(2);
    expect(res.body.advertencia).toBeNull();
  });

  it('advierte (sin bloquear) cuando la suma del plan NO cuadra con monto_total', async () => {
    const contrato = await crearContratoVentaDirecto('PlanDescuadrado', 100000);
    const res = await request(app)
      .put(`/api/projects/${testProjectId}/contratos-venta/${contrato.id}/plan-pago`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ items: [{ concepto: 'Enganche', monto_programado: 30000 }] });
    expect(res.status).toBe(200);
    expect(res.body.advertencia).toMatch(/no coincide/i);
  });

  it('editar el plan reemplaza TODAS las líneas anteriores (DELETE+re-INSERT)', async () => {
    const contrato = await crearContratoVentaDirecto('PlanReemplazo', 50000);
    const primero = await request(app)
      .put(`/api/projects/${testProjectId}/contratos-venta/${contrato.id}/plan-pago`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ items: [
        { concepto: 'A', monto_programado: 10000 },
        { concepto: 'B', monto_programado: 40000 },
      ] });
    expect(primero.body.items.length).toBe(2);
    const planId = primero.body.plan.id;

    const segundo = await request(app)
      .put(`/api/projects/${testProjectId}/contratos-venta/${contrato.id}/plan-pago`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ items: [{ concepto: 'Único renglón', monto_programado: 50000 }] });
    expect(segundo.status).toBe(200);
    expect(segundo.body.plan.id).toBe(planId); // mismo plan (UNIQUE contrato_venta_id), no uno nuevo
    expect(segundo.body.items.length).toBe(1);
    expect(segundo.body.advertencia).toBeNull();

    const { rows } = await db.pool.query('SELECT COUNT(*)::int AS n FROM plan_pago_items WHERE plan_pago_id = $1', [planId]);
    expect(rows[0].n).toBe(1); // las 2 líneas viejas ya no están
  });

  it('rechaza con 400 un plan sin ningún renglón', async () => {
    const contrato = await crearContratoVentaDirecto('PlanVacio');
    const res = await request(app)
      .put(`/api/projects/${testProjectId}/contratos-venta/${contrato.id}/plan-pago`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ items: [] });
    expect(res.status).toBe(400);
  });

  it('rechaza con 400 un plan sobre un contrato de OTRA obra', async () => {
    const contrato = await crearContratoVentaDirecto('PlanCrossObra');
    const res = await request(app)
      .put(`/api/projects/${otroProjectId}/contratos-venta/${contrato.id}/plan-pago`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ items: [{ concepto: 'Enganche', monto_programado: 1000 }] });
    expect(res.status).toBe(400);
  });
});

describe('Registro de pagos y saldo/estado_pago', () => {
  it('estado "pendiente" cuando no hay pagos', async () => {
    const contrato = await crearContratoVentaDirecto('EstadoPendiente', 80000);
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/contratos-venta/${contrato.id}/cobranza`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total_pagado).toBe(0);
    expect(res.body.saldo_pendiente).toBe(80000);
    expect(res.body.estado_pago).toBe('pendiente');
  });

  it('registra un pago SIN plan_pago_item_id — estado pasa a "parcial"', async () => {
    const contrato = await crearContratoVentaDirecto('PagoSinItem', 80000);
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/contratos-venta/${contrato.id}/pagos`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 30000, metodo_pago: 'Transferencia', referencia: 'REF-1' });
    expect(res.status).toBe(201);
    expect(res.body.pago.plan_pago_item_id).toBeNull();
    expect(res.body.total_pagado).toBe(30000);
    expect(res.body.saldo_pendiente).toBe(50000);
    expect(res.body.estado_pago).toBe('parcial');
    expect(res.body.advertencia).toBeNull();
  });

  it('registra un pago CON plan_pago_item_id válido del mismo contrato', async () => {
    const contrato = await crearContratoVentaDirecto('PagoConItem', 50000);
    const plan = await request(app)
      .put(`/api/projects/${testProjectId}/contratos-venta/${contrato.id}/plan-pago`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ items: [{ concepto: 'Enganche', monto_programado: 20000 }] });
    const itemId = plan.body.items[0].id;

    const res = await request(app)
      .post(`/api/projects/${testProjectId}/contratos-venta/${contrato.id}/pagos`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 20000, plan_pago_item_id: itemId });
    expect(res.status).toBe(201);
    expect(res.body.pago.plan_pago_item_id).toBe(itemId);
  });

  it('rechaza con 400 un plan_pago_item_id que pertenece a OTRO contrato', async () => {
    const contratoA = await crearContratoVentaDirecto('CrossContratoA', 50000);
    const contratoB = await crearContratoVentaDirecto('CrossContratoB', 50000);
    const planA = await request(app)
      .put(`/api/projects/${testProjectId}/contratos-venta/${contratoA.id}/plan-pago`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ items: [{ concepto: 'Enganche', monto_programado: 50000 }] });
    const itemIdDeA = planA.body.items[0].id;

    const res = await request(app)
      .post(`/api/projects/${testProjectId}/contratos-venta/${contratoB.id}/pagos`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 1000, plan_pago_item_id: itemIdDeA });
    expect(res.status).toBe(400);
  });

  it('rechaza con 400 un monto inválido (<=0)', async () => {
    const contrato = await crearContratoVentaDirecto('MontoInvalido');
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/contratos-venta/${contrato.id}/pagos`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 0 });
    expect(res.status).toBe(400);
  });

  it('estado "liquidado" cuando el total pagado alcanza el monto_total', async () => {
    const contrato = await crearContratoVentaDirecto('EstadoLiquidado', 60000);
    await request(app)
      .post(`/api/projects/${testProjectId}/contratos-venta/${contrato.id}/pagos`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 40000 });
    const res2 = await request(app)
      .post(`/api/projects/${testProjectId}/contratos-venta/${contrato.id}/pagos`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 20000 });
    expect(res2.status).toBe(201);
    expect(res2.body.total_pagado).toBe(60000);
    expect(res2.body.saldo_pendiente).toBe(0);
    expect(res2.body.estado_pago).toBe('liquidado');
    expect(res2.body.advertencia).toBeNull();
  });

  it('advierte (sin bloquear) un sobrepago', async () => {
    const contrato = await crearContratoVentaDirecto('Sobrepago', 40000);
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/contratos-venta/${contrato.id}/pagos`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 55000 });
    expect(res.status).toBe(201);
    expect(res.body.total_pagado).toBe(55000);
    expect(res.body.saldo_pendiente).toBe(-15000);
    expect(res.body.estado_pago).toBe('liquidado');
    expect(res.body.advertencia).toMatch(/sobrepago/i);
  });
});

describe('Cancelar contrato con pagos existentes', () => {
  it('NO bloquea la cancelación, pero advierte del total pagado (decisión confirmada explícitamente)', async () => {
    const contrato = await crearContratoVentaDirecto('CancelarConPagos', 50000);
    await request(app)
      .post(`/api/projects/${testProjectId}/contratos-venta/${contrato.id}/pagos`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 20000 });

    const res = await request(app)
      .put(`/api/projects/${testProjectId}/contratos-venta/${contrato.id}/cancelar`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('cancelado');
    expect(res.body.total_pagado).toBe(20000);
    expect(res.body.advertencia).toMatch(/20000\.00/);

    // Los pagos NO se borran ni se tocan al cancelar
    const { rows } = await db.pool.query('SELECT COUNT(*)::int AS n FROM pagos_venta WHERE contrato_venta_id = $1', [contrato.id]);
    expect(rows[0].n).toBe(1);
  });

  it('cancelar un contrato SIN pagos no genera advertencia', async () => {
    const contrato = await crearContratoVentaDirecto('CancelarSinPagos', 30000);
    const res = await request(app)
      .put(`/api/projects/${testProjectId}/contratos-venta/${contrato.id}/cancelar`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.advertencia).toBeNull();
  });
});
