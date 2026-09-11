// Integration tests para prompt-seguimiento-materiales-oc.md — nuevo reporte
// GET /api/requisiciones/seguimiento-materiales, complementario a
// /api/requisiciones/programa (Reporte #1). Corre contra la DB real apuntada
// por DATABASE_URL, mismo patrón que tests/reasignar-proveedor-oc.test.js —
// crea datos desechables identificables por prefijo QA-SEG y los borra en
// afterAll.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let adminToken;
let ajenoToken; // usuario sin acceso a testProjectId
let ajenoId;
let testProjectId;
let testProjectClienteId;
let proveedorId;
let requisicionIds = [];
let insumoIds = [];
let ocIds = [];
let conceptoId;

async function login(usuario, password) {
  const res = await request(app).post('/api/auth/login').send({ usuario, password });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`Login falló para ${usuario}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

async function crearInsumo(codigo, concepto) {
  const ins = await db.pool.query(
    `INSERT INTO insumos (project_id, codigo, concepto, categoria, unidad, cantidad_presupuesto, precio_presupuesto)
     VALUES ($1, $2, $3, 'Materiales', 'PZA', 1000, 10) RETURNING id`,
    [testProjectId, codigo, concepto]
  );
  insumoIds.push(ins.rows[0].id);
  return ins.rows[0].id;
}

// Crea requisición -> autorizada -> item id, sin generar OC todavía.
async function crearRequisicionAutorizada(insumoId, cantidad = 10) {
  const reqRes = await request(app)
    .post(`/api/projects/${testProjectId}/requisiciones`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ items: [{ insumo_id: insumoId, cantidad_solicitada: cantidad, precio_solicitado: 10 }] });
  if (reqRes.status !== 201) throw new Error(`No se pudo crear la requisición: ${reqRes.status} ${JSON.stringify(reqRes.body)}`);
  const reqId = reqRes.body.id;
  requisicionIds.push(reqId);
  const detalle = await request(app)
    .get(`/api/projects/${testProjectId}/requisiciones/${reqId}`)
    .set('Authorization', `Bearer ${adminToken}`);
  const itemId = detalle.body.items[0].id;
  for (const estado of ['enviada', 'autorizada']) {
    await request(app)
      .put(`/api/projects/${testProjectId}/requisiciones/${reqId}/estado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ estado });
  }
  return { reqId, itemId };
}

async function generarOc(reqId, itemId, cantidad, { confirmarSobreorden = false } = {}) {
  const ocRes = await request(app)
    .post(`/api/projects/${testProjectId}/requisiciones/${reqId}/ordenes`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      proveedor_id: proveedorId,
      items: [{ requisicion_item_id: itemId, cantidad_ordenada: cantidad, precio_unitario: 10 }],
      ...(confirmarSobreorden ? { confirmar_sobreorden: true, motivo: 'QA: prueba multi-OC sobre el mismo renglón' } : {}),
    });
  if (ocRes.status !== 201) throw new Error(`No se pudo generar la OC: ${ocRes.status} ${JSON.stringify(ocRes.body)}`);
  ocIds.push(ocRes.body.id);
  return ocRes.body.id;
}

async function confirmarYRecibir(ocId, cantidadRecibida) {
  await request(app)
    .put(`/api/projects/${testProjectId}/ordenes/${ocId}/estado`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ estado: 'confirmada' });
  if (cantidadRecibida <= 0) return;
  const detalle = await request(app)
    .get(`/api/projects/${testProjectId}/ordenes/${ocId}`)
    .set('Authorization', `Bearer ${adminToken}`);
  const ocItemId = detalle.body.items[0].id;
  await request(app)
    .post(`/api/projects/${testProjectId}/ordenes/${ocId}/recepciones`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ items: [{ orden_compra_item_id: ocItemId, cantidad_recibida: cantidadRecibida }] });
}

let itemSinOc, itemPendiente, itemParcial, itemCompleto, itemMultiOc;
let ocPendienteId, ocParcialId, ocCompletoId, ocMultiA, ocMultiB;
let insumoCompletoId;

beforeAll(async () => {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada — no se puede correr la suite.');
  adminToken = await login(ADMIN_USER, ADMIN_PASSWORD);

  const { rows: projRows } = await db.pool.query('SELECT id, cliente_id FROM proyectos ORDER BY id LIMIT 1');
  testProjectId = projRows[0].id;
  testProjectClienteId = projRows[0].cliente_id;

  const { rows: provRows } = await db.pool.query('SELECT id FROM proveedores WHERE activo = 1 ORDER BY id LIMIT 1');
  if (!provRows.length) throw new Error('Se necesita al menos 1 proveedor activo para correr la suite.');
  proveedorId = provRows[0].id;

  // sin_oc: requisición autorizada, ninguna OC generada todavía.
  const insSinOc = await crearInsumo('QA-SEG-SINOC', 'QA Material Sin OC');
  const rSinOc = await crearRequisicionAutorizada(insSinOc, 10);
  itemSinOc = rSinOc.itemId;

  // pendiente: OC generada, sin recepción.
  const insPendiente = await crearInsumo('QA-SEG-PENDIENTE', 'QA Material Pendiente');
  const rPendiente = await crearRequisicionAutorizada(insPendiente, 20);
  itemPendiente = rPendiente.itemId;
  ocPendienteId = await generarOc(rPendiente.reqId, itemPendiente, 20);

  // parcial: OC confirmada, recepción parcial.
  const insParcial = await crearInsumo('QA-SEG-PARCIAL', 'QA Material Parcial');
  const rParcial = await crearRequisicionAutorizada(insParcial, 30);
  itemParcial = rParcial.itemId;
  ocParcialId = await generarOc(rParcial.reqId, itemParcial, 30);
  await confirmarYRecibir(ocParcialId, 12);

  // completo: OC confirmada, recepción completa. También usado para probar
  // el mapeo a concepto vía concepto_insumos.
  insumoCompletoId = await crearInsumo('QA-SEG-COMPLETO', 'QA Material Completo');
  const rCompleto = await crearRequisicionAutorizada(insumoCompletoId, 8);
  itemCompleto = rCompleto.itemId;
  ocCompletoId = await generarOc(rCompleto.reqId, itemCompleto, 8);
  await confirmarYRecibir(ocCompletoId, 8);

  // multi-OC sobre el mismo requisicion_item: caso real confirmado en
  // diagnóstico previo (compra dividida / OC duplicada) — debe producir 2
  // filas separadas, no una suma.
  const insMultiOc = await crearInsumo('QA-SEG-MULTIOC', 'QA Material Multi OC');
  const rMultiOc = await crearRequisicionAutorizada(insMultiOc, 5);
  itemMultiOc = rMultiOc.itemId;
  ocMultiA = await generarOc(rMultiOc.reqId, itemMultiOc, 5);
  ocMultiB = await generarOc(rMultiOc.reqId, itemMultiOc, 5, { confirmarSobreorden: true });

  // Mapeo de concepto: crea un concepto de presupuesto y lo liga al insumo
  // "completo" vía concepto_insumos (tabla admin-curada, ver diagnóstico).
  const conceptoRes = await db.pool.query(
    `INSERT INTO conceptos (project_id, codigo, concepto, unidad, cantidad, precio_unitario, importe)
     VALUES ($1, 'QA-SEG-CPT', 'QA Concepto de prueba', 'PZA', 8, 10, 80) RETURNING id`,
    [testProjectId]
  );
  conceptoId = conceptoRes.rows[0].id;
  await db.pool.query('INSERT INTO concepto_insumos (concepto_id, insumo_id) VALUES ($1, $2)', [conceptoId, insumoCompletoId]);

  // Usuario sin acceso a testProjectId, para probar scoping/403.
  const ajenoUsuario = `qa_ajeno_seguimiento_${Date.now()}`;
  const createUserRes = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA Ajeno Seguimiento', usuario: ajenoUsuario, password: 'QaAjenoSeg123!', puesto: 'compras' });
  ajenoId = createUserRes.body.id;
  await request(app)
    .put(`/api/usuarios/${ajenoId}/proyectos`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ project_ids: [] });
  ajenoToken = await login(ajenoUsuario, 'QaAjenoSeg123!');
}, 60000);

afterAll(async () => {
  if (ajenoId) await request(app).delete(`/api/usuarios/${ajenoId}`).set('Authorization', `Bearer ${adminToken}`);
  if (conceptoId) {
    await db.pool.query('DELETE FROM concepto_insumos WHERE concepto_id = $1', [conceptoId]);
    await db.pool.query('DELETE FROM conceptos WHERE id = $1', [conceptoId]);
  }
  for (const oc of ocIds) {
    await db.pool.query('DELETE FROM recepcion_items WHERE recepcion_id IN (SELECT id FROM recepciones WHERE orden_compra_id = $1)', [oc]);
    await db.pool.query('DELETE FROM recepciones WHERE orden_compra_id = $1', [oc]);
    await db.pool.query('DELETE FROM orden_compra_items WHERE orden_compra_id = $1', [oc]);
    await db.pool.query('DELETE FROM ordenes_compra WHERE id = $1', [oc]);
  }
  for (const reqId of requisicionIds) {
    await db.pool.query('DELETE FROM requisicion_items WHERE requisicion_id = $1', [reqId]);
    await db.pool.query('DELETE FROM requisiciones WHERE id = $1', [reqId]);
  }
  for (const insId of insumoIds) {
    await db.pool.query('DELETE FROM insumos WHERE id = $1', [insId]);
  }
  await db.pool.end();
});

function porCodigo(items, codigo) {
  return items.filter((it) => it.insumo_codigo === codigo);
}

describe('GET /api/requisiciones/seguimiento-materiales', () => {
  it('calcula sin_oc, pendiente, parcial y completo correctamente', async () => {
    const res = await request(app)
      .get('/api/requisiciones/seguimiento-materiales')
      .query({ project_id: testProjectId })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const items = res.body.items;

    const sinOc = porCodigo(items, 'QA-SEG-SINOC');
    expect(sinOc).toHaveLength(1);
    expect(sinOc[0].estatus).toBe('sin_oc');
    expect(sinOc[0].oc_folio).toBeNull();
    expect(sinOc[0].cantidad_ordenada).toBeNull();

    const pendiente = porCodigo(items, 'QA-SEG-PENDIENTE');
    expect(pendiente).toHaveLength(1);
    expect(pendiente[0].estatus).toBe('pendiente');
    expect(pendiente[0].cantidad_recibida).toBe(0);

    const parcial = porCodigo(items, 'QA-SEG-PARCIAL');
    expect(parcial).toHaveLength(1);
    expect(parcial[0].estatus).toBe('parcial');
    expect(parcial[0].cantidad_ordenada).toBe(30);
    expect(parcial[0].cantidad_recibida).toBe(12);

    const completo = porCodigo(items, 'QA-SEG-COMPLETO');
    expect(completo).toHaveLength(1);
    expect(completo[0].estatus).toBe('completo');
    expect(completo[0].cantidad_recibida).toBe(8);
    expect(completo[0].concepto_vinculado).toContain('QA Concepto de prueba');

    // Insumo sin mapeo en concepto_insumos -> "sin mapeo" explícito (null).
    expect(sinOc[0].concepto_vinculado).toBeNull();
  });

  it('no colapsa/suma un renglón con más de una OC: devuelve una fila por OC', async () => {
    const res = await request(app)
      .get('/api/requisiciones/seguimiento-materiales')
      .query({ project_id: testProjectId })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const multi = porCodigo(res.body.items, 'QA-SEG-MULTIOC');
    expect(multi).toHaveLength(2);
    const folios = multi.map((it) => it.oc_id).sort();
    expect(folios).toEqual([ocMultiA, ocMultiB].sort((a, b) => a - b));
    multi.forEach((it) => expect(it.cantidad_ordenada).toBe(5));
  });

  it('filtra por cliente_id (join a proyectos.cliente_id)', async () => {
    if (testProjectClienteId == null) return; // proyecto de prueba sin cliente asignado, no aplica
    const conCliente = await request(app)
      .get('/api/requisiciones/seguimiento-materiales')
      .query({ project_id: testProjectId, cliente_id: testProjectClienteId })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(porCodigo(conCliente.body.items, 'QA-SEG-SINOC')).toHaveLength(1);

    const otroClienteRes = await db.pool.query('SELECT id FROM clientes WHERE id != $1 LIMIT 1', [testProjectClienteId]);
    if (!otroClienteRes.rows.length) return;
    const conOtroCliente = await request(app)
      .get('/api/requisiciones/seguimiento-materiales')
      .query({ project_id: testProjectId, cliente_id: otroClienteRes.rows[0].id })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(porCodigo(conOtroCliente.body.items, 'QA-SEG-SINOC')).toHaveLength(0);
  });

  it('rechaza (403) a un usuario sin acceso a la obra pedida por project_id', async () => {
    const res = await request(app)
      .get('/api/requisiciones/seguimiento-materiales')
      .query({ project_id: testProjectId })
      .set('Authorization', `Bearer ${ajenoToken}`);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/requisiciones/seguimiento-materiales/export', () => {
  it('genera un .xlsx válido', async () => {
    const res = await request(app)
      .get('/api/requisiciones/seguimiento-materiales/export')
      .query({ project_id: testProjectId })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain('Seguimiento-Materiales-OC');
    expect(Number(res.headers['content-length'])).toBeGreaterThan(0);
  });
});
