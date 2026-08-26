// Integration test para la Fase 4 del roadmap "Desarrollador de Vivienda",
// PR D (prompt-implementacion-pr-d-entregas.md): registro formal de entrega
// de un lote a su comprador, con firma digital. Cierra el ciclo Lotes →
// Infraestructura → Catálogo comercial → Compradores/Apartado → Contrato →
// Cobranza → Entrega. Mismo patrón autocontenido de tests/ventas-cobranza.test.js.
//
// No existe endpoint DELETE para lotes/entregas_lote/contratos_venta — todo
// se borra físicamente vía SQL directo en afterAll, en el orden correcto
// (entregas_lote -> pagos_venta -> plan_pago_items -> planes_pago ->
// contratos_venta -> apartados -> lotes -> compradores) para no violar las FKs.
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
const tempUsuario = `qa_entregas_${Date.now()}`;
const tempPassword = 'QaEntregas123!';

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
    .send({ numero_lote: `QA-EN-${numeroSufijo}-${Date.now()}` });
  loteIdsCreados.push(res.body.id);
  return res.body;
}

async function crearComprador(sufijo) {
  const res = await request(app)
    .post(`/api/projects/${testProjectId}/compradores`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: `QA Comprador EN ${sufijo} ${Date.now()}` });
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
  return { contrato: res.body, lote, comprador };
}

beforeAll(async () => {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada — no se puede correr la suite de integración.');
  adminToken = await login(ADMIN_USER, ADMIN_PASSWORD);

  const { rows } = await db.pool.query('SELECT id FROM proyectos ORDER BY id LIMIT 1');
  if (rows.length < 1) throw new Error('Se necesita al menos 1 obra real en Preview para correr esta suite.');
  testProjectId = rows[0].id;

  const createRes = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA Entregas', usuario: tempUsuario, password: tempPassword, puesto: 'residente' });
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
  if (loteIdsCreados.length) {
    await db.pool.query('DELETE FROM entregas_lote WHERE lote_id = ANY($1::int[])', [loteIdsCreados]);
  }
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
  const { rows: remanentesEntregas } = contratoVentaIdsCreados.length
    ? await db.pool.query('SELECT id FROM entregas_lote WHERE contrato_venta_id = ANY($1::int[])', [contratoVentaIdsCreados])
    : { rows: [] };
  if (remanentesEntregas.length !== 0) throw new Error('Limpieza incompleta: quedaron entregas de prueba.');
  if (tempUserId) {
    const delRes = await request(app).delete(`/api/usuarios/${tempUserId}`).set('Authorization', `Bearer ${adminToken}`);
    const { rows: usuarioRemanente } = await db.pool.query('SELECT id FROM usuarios WHERE id = $1', [tempUserId]);
    if (delRes.status !== 200 || usuarioRemanente.length !== 0) {
      throw new Error(`Limpieza incompleta: usuario temporal ${tempUsuario} (id ${tempUserId}) no se borró (status ${delRes.status}).`);
    }
  }
  await db.pool.end();
});

describe('nav-tabs — entregas solo para admin/desarrollador', () => {
  it('admin ve entregas en sus tabs; residente no', async () => {
    const admRes = await request(app).get(`/api/projects/${testProjectId}/nav-tabs`).set('Authorization', `Bearer ${adminToken}`);
    expect(admRes.body.tabs).toContain('entregas');
    const resRes = await request(app).get(`/api/projects/${testProjectId}/nav-tabs`).set('Authorization', `Bearer ${tempToken}`);
    expect(resRes.body.tabs).not.toContain('entregas');
  });
});

describe('Permisos — auth.allow() admin/desarrollador exclusivo', () => {
  it('GET lotes-entregas requiere autenticación y bloquea a residente', async () => {
    const noAuth = await request(app).get(`/api/projects/${testProjectId}/lotes-entregas`);
    expect(noAuth.status).toBe(401);
    const residente = await request(app)
      .get(`/api/projects/${testProjectId}/lotes-entregas`)
      .set('Authorization', `Bearer ${tempToken}`);
    expect(residente.status).toBe(403);
  });

  it('POST entrega requiere autenticación y bloquea a residente', async () => {
    const { lote } = await crearContratoVentaDirecto('Permisos');
    const noAuth = await request(app).post(`/api/projects/${testProjectId}/lotes/${lote.id}/entrega`).send({ recibido_por: 'Juan' });
    expect(noAuth.status).toBe(401);
    const residente = await request(app)
      .post(`/api/projects/${testProjectId}/lotes/${lote.id}/entrega`)
      .set('Authorization', `Bearer ${tempToken}`)
      .send({ recibido_por: 'Juan' });
    expect(residente.status).toBe(403);
  });
});

describe('Entrega exitosa', () => {
  it('crea la entrega con contrato vigente y actualiza lotes.estatus/fecha_entrega_real', async () => {
    const { contrato, lote } = await crearContratoVentaDirecto('Exitosa', 100000);
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/lotes/${lote.id}/entrega`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recibido_por: 'Juan Pérez', firma_digital: 'data:image/png;base64,iVBORw0KGgo=', observaciones: 'Sin observaciones' });
    expect(res.status).toBe(201);
    expect(res.body.lote_id).toBe(lote.id);
    expect(res.body.contrato_venta_id).toBe(contrato.id);
    expect(res.body.recibido_por).toBe('Juan Pérez');

    // Verificación literal en DB, no solo en el body de la respuesta.
    const { rows } = await db.pool.query('SELECT estatus, fecha_entrega_real FROM lotes WHERE id = $1', [lote.id]);
    expect(rows[0].estatus).toBe('entregado');
    expect(rows[0].fecha_entrega_real).not.toBeNull();
  });

  it('rechaza con 400 si recibido_por falta o está vacío', async () => {
    const { lote } = await crearContratoVentaDirecto('SinRecibidoPor');
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/lotes/${lote.id}/entrega`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recibido_por: '   ' });
    expect(res.status).toBe(400);
  });
});

describe('Rechazo sin contrato vigente', () => {
  it('rechaza con 400 la entrega de un lote sin contrato de venta', async () => {
    const lote = await crearLote('SinContrato');
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/lotes/${lote.id}/entrega`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recibido_por: 'Alguien' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contrato de venta vigente/i);
  });
});

describe('Rechazo de doble entrega', () => {
  it('la segunda entrega sobre el mismo lote es 400', async () => {
    const { lote } = await crearContratoVentaDirecto('DobleEntrega');
    const primera = await request(app)
      .post(`/api/projects/${testProjectId}/lotes/${lote.id}/entrega`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recibido_por: 'Primero' });
    expect(primera.status).toBe(201);

    const segunda = await request(app)
      .post(`/api/projects/${testProjectId}/lotes/${lote.id}/entrega`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recibido_por: 'Segundo' });
    expect(segunda.status).toBe(400);
  });
});

describe('Advertencia de saldo pendiente sin bloqueo', () => {
  it('entrega exitosa (201) con advertencia cuando el saldo NO está liquidado', async () => {
    const { contrato, lote } = await crearContratoVentaDirecto('SaldoPendiente', 100000);
    await request(app)
      .post(`/api/projects/${testProjectId}/contratos-venta/${contrato.id}/pagos`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 30000 });

    const res = await request(app)
      .post(`/api/projects/${testProjectId}/lotes/${lote.id}/entrega`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recibido_por: 'Comprador Parcial' });
    expect(res.status).toBe(201);
    expect(res.body.saldo_pendiente).toBe(70000);
    expect(res.body.advertencia).toMatch(/saldo pendiente/i);
    expect(res.body.advertencia).toMatch(/70000\.00/);
  });

  it('sin advertencia (null) cuando el saldo está liquidado', async () => {
    const { contrato, lote } = await crearContratoVentaDirecto('SaldoLiquidado', 50000);
    await request(app)
      .post(`/api/projects/${testProjectId}/contratos-venta/${contrato.id}/pagos`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 50000 });

    const res = await request(app)
      .post(`/api/projects/${testProjectId}/lotes/${lote.id}/entrega`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recibido_por: 'Comprador Liquidado' });
    expect(res.status).toBe(201);
    expect(res.body.saldo_pendiente).toBe(0);
    expect(res.body.advertencia).toBeNull();
  });
});

describe('GET lotes-entregas', () => {
  it('lista contratos vigentes con entrega_id NULL si aún no se entrega, y con datos si ya se entregó', async () => {
    const pendiente = await crearContratoVentaDirecto('ListaPendiente');
    const entregado = await crearContratoVentaDirecto('ListaEntregada');
    await request(app)
      .post(`/api/projects/${testProjectId}/lotes/${entregado.lote.id}/entrega`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recibido_por: 'Comprador Lista' });

    const res = await request(app)
      .get(`/api/projects/${testProjectId}/lotes-entregas`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const filaPendiente = res.body.find((r) => r.id === pendiente.contrato.id);
    expect(filaPendiente).toBeTruthy();
    expect(filaPendiente.entrega_id).toBeNull();

    const filaEntregada = res.body.find((r) => r.id === entregado.contrato.id);
    expect(filaEntregada).toBeTruthy();
    expect(filaEntregada.entrega_id).not.toBeNull();
    expect(filaEntregada.recibido_por).toBe('Comprador Lista');
  });
});
