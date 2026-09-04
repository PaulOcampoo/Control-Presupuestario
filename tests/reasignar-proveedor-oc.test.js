// Integration tests para prompt-fase1-reasignar-proveedor-oc.md — reasignar
// proveedor_id de una OC ya creada, en cualquier estado (incluida
// recibida_completa), restringido a admin/desarrollador. Diseño aprobado en
// docs/fase0-reasignar-proveedor-oc.md. Corre contra la DB real apuntada
// por DATABASE_URL, mismo patrón que el resto de tests/*.test.js de este
// repo — crea datos desechables y los borra en afterAll.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let adminToken;
let comprasToken;
let comprasTempId;
let testProjectId;
let proveedorOriginalId;
let proveedorNuevoId;
let proveedorInactivoId;
let insumoId;
let requisicionId;
let requisicionRecibidaId;
let itemId;
let ocId; // OC de prueba general (estado 'borrador')
let ocRecibidaId; // OC de prueba llevada hasta 'recibida_completa'
const comprasTempUsuario = `qa_compras_reasignoc_${Date.now()}`;
const tempPassword = 'QaReasignOcTemp123!';

async function login(usuario, password) {
  const res = await request(app).post('/api/auth/login').send({ usuario, password });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`Login falló para ${usuario}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

async function crearOcDePrueba(cantidad = 20) {
  const reqRes = await request(app)
    .post(`/api/projects/${testProjectId}/requisiciones`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ items: [{ insumo_id: insumoId, cantidad_solicitada: cantidad, precio_solicitado: 10 }] });
  if (reqRes.status !== 201) throw new Error(`No se pudo crear la requisición: ${reqRes.status} ${JSON.stringify(reqRes.body)}`);
  const reqId = reqRes.body.id;
  const detalle = await request(app)
    .get(`/api/projects/${testProjectId}/requisiciones/${reqId}`)
    .set('Authorization', `Bearer ${adminToken}`);
  const itId = detalle.body.items[0].id;
  for (const estado of ['enviada', 'autorizada']) {
    await request(app)
      .put(`/api/projects/${testProjectId}/requisiciones/${reqId}/estado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ estado });
  }
  const ocRes = await request(app)
    .post(`/api/projects/${testProjectId}/requisiciones/${reqId}/ordenes`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ proveedor_id: proveedorOriginalId, items: [{ requisicion_item_id: itId, cantidad_ordenada: cantidad, precio_unitario: 10 }] });
  if (ocRes.status !== 201) throw new Error(`No se pudo generar la OC: ${ocRes.status} ${JSON.stringify(ocRes.body)}`);
  return { reqId, itId, ocId: ocRes.body.id };
}

beforeAll(async () => {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada — no se puede correr la suite.');
  adminToken = await login(ADMIN_USER, ADMIN_PASSWORD);

  const { rows: projRows } = await db.pool.query('SELECT id FROM proyectos ORDER BY id LIMIT 1');
  testProjectId = projRows[0].id;

  const { rows: provRows } = await db.pool.query('SELECT id FROM proveedores WHERE activo = 1 ORDER BY id LIMIT 2');
  if (provRows.length < 2) throw new Error('Se necesitan al menos 2 proveedores activos para correr la suite.');
  proveedorOriginalId = provRows[0].id;
  proveedorNuevoId = provRows[1].id;

  const provInactivo = await db.pool.query(
    `INSERT INTO proveedores (nombre, activo) VALUES ('QA Proveedor Inactivo Reasignacion', 0) RETURNING id`
  );
  proveedorInactivoId = provInactivo.rows[0].id;

  const ins = await db.pool.query(
    `INSERT INTO insumos (project_id, codigo, concepto, categoria, unidad, cantidad_presupuesto, precio_presupuesto)
     VALUES ($1, 'QA-REASIGN-PZA', 'QA Material Reasignación Proveedor', 'Materiales', 'PZA', 1000, 10) RETURNING id`,
    [testProjectId]
  );
  insumoId = ins.rows[0].id;

  // OC #1: se queda en 'borrador' — cubre el caso general.
  const oc1 = await crearOcDePrueba(20);
  requisicionId = oc1.reqId;
  itemId = oc1.itId;
  ocId = oc1.ocId;

  // OC #2: llevada hasta 'recibida_completa' vía flujo real (confirmar +
  // recepción completa) — cubre el caso real que motivó Fase 0 (OC ROF-14,
  // proveedor mal capturado en una OC ya recibida).
  const oc2 = await crearOcDePrueba(15);
  requisicionRecibidaId = oc2.reqId;
  ocRecibidaId = oc2.ocId;
  await request(app)
    .put(`/api/projects/${testProjectId}/ordenes/${ocRecibidaId}/estado`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ estado: 'confirmada' });
  const ocItemsRes = await request(app)
    .get(`/api/projects/${testProjectId}/ordenes/${ocRecibidaId}`)
    .set('Authorization', `Bearer ${adminToken}`);
  const ocItemId = ocItemsRes.body.items[0].id;
  const recepcionRes = await request(app)
    .post(`/api/projects/${testProjectId}/ordenes/${ocRecibidaId}/recepciones`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ items: [{ orden_compra_item_id: ocItemId, cantidad_recibida: 15 }] });
  if (recepcionRes.status !== 201 || recepcionRes.body.estado_orden !== 'recibida_completa') {
    throw new Error(`Setup de OC recibida_completa falló: ${recepcionRes.status} ${JSON.stringify(recepcionRes.body)}`);
  }

  const createUserRes = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA Compras ReasignOC', usuario: comprasTempUsuario, password: tempPassword, puesto: 'compras' });
  comprasTempId = createUserRes.body.id;
  await request(app)
    .put(`/api/usuarios/${comprasTempId}/proyectos`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ project_ids: [testProjectId] });
  comprasToken = await login(comprasTempUsuario, tempPassword);
}, 30000);

afterAll(async () => {
  if (comprasTempId) await request(app).delete(`/api/usuarios/${comprasTempId}`).set('Authorization', `Bearer ${adminToken}`);
  for (const oc of [ocId, ocRecibidaId]) {
    if (!oc) continue;
    await db.pool.query('DELETE FROM recepcion_items WHERE recepcion_id IN (SELECT id FROM recepciones WHERE orden_compra_id = $1)', [oc]);
    await db.pool.query('DELETE FROM recepciones WHERE orden_compra_id = $1', [oc]);
    await db.pool.query('DELETE FROM audit_log WHERE target_id = $1 AND accion = $2', [oc, 'reasignar_proveedor_oc']);
    await db.pool.query('DELETE FROM orden_compra_items WHERE orden_compra_id = $1', [oc]);
    await db.pool.query('DELETE FROM ordenes_compra WHERE id = $1', [oc]);
  }
  for (const reqId of [requisicionId, requisicionRecibidaId]) {
    if (!reqId) continue;
    await db.pool.query('DELETE FROM requisicion_items WHERE requisicion_id = $1', [reqId]);
    await db.pool.query('DELETE FROM requisiciones WHERE id = $1', [reqId]);
  }
  if (insumoId) await db.pool.query('DELETE FROM insumos WHERE id = $1', [insumoId]);
  if (proveedorInactivoId) await db.pool.query('DELETE FROM proveedores WHERE id = $1', [proveedorInactivoId]);
  await db.pool.end();
});

describe('PATCH /api/projects/:id/ordenes/:ocId/proveedor', () => {
  it('rechaza a un rol distinto de admin/desarrollador (403), aunque el rol sí administre OC', async () => {
    const res = await request(app)
      .patch(`/api/projects/${testProjectId}/ordenes/${ocId}/proveedor`)
      .set('Authorization', `Bearer ${comprasToken}`)
      .send({ proveedor_id: proveedorNuevoId });
    expect(res.status).toBe(403);
  });

  it('rechaza sin proveedor_id (400)', async () => {
    const res = await request(app)
      .patch(`/api/projects/${testProjectId}/ordenes/${ocId}/proveedor`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('rechaza si el proveedor nuevo es el mismo que ya tiene (400)', async () => {
    const res = await request(app)
      .patch(`/api/projects/${testProjectId}/ordenes/${ocId}/proveedor`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ proveedor_id: proveedorOriginalId });
    expect(res.status).toBe(400);
  });

  it('rechaza un proveedor_id inexistente (400)', async () => {
    const res = await request(app)
      .patch(`/api/projects/${testProjectId}/ordenes/${ocId}/proveedor`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ proveedor_id: 999999999 });
    expect(res.status).toBe(400);
  });

  it('rechaza un proveedor inactivo (400)', async () => {
    const res = await request(app)
      .patch(`/api/projects/${testProjectId}/ordenes/${ocId}/proveedor`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ proveedor_id: proveedorInactivoId });
    expect(res.status).toBe(400);
  });

  it('admin reasigna proveedor en una OC "borrador" (200), el cambio persiste', async () => {
    const res = await request(app)
      .patch(`/api/projects/${testProjectId}/ordenes/${ocId}/proveedor`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ proveedor_id: proveedorNuevoId, motivo: 'QA: prueba de reasignación' });
    expect(res.status).toBe(200);

    const detalle = await request(app)
      .get(`/api/projects/${testProjectId}/ordenes/${ocId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(detalle.body.proveedor_id).toBe(proveedorNuevoId);
  });

  it('queda registrada en audit_log con actor, proveedor anterior y nuevo', async () => {
    const { rows } = await db.pool.query(
      `SELECT * FROM audit_log WHERE target_id = $1 AND accion = 'reasignar_proveedor_oc' ORDER BY creado_en DESC LIMIT 1`,
      [ocId]
    );
    expect(rows.length).toBe(1);
    const detalle = JSON.parse(rows[0].detalle);
    expect(detalle.proveedor_anterior_id).toBe(proveedorOriginalId);
    expect(detalle.proveedor_nuevo_id).toBe(proveedorNuevoId);
    expect(detalle.motivo).toBe('QA: prueba de reasignación');
    expect(rows[0].actor_usuario).toBe(ADMIN_USER);
  });

  it('admin reasigna proveedor en una OC "recibida_completa" (200) — caso real que motivó Fase 0', async () => {
    const antes = await request(app)
      .get(`/api/projects/${testProjectId}/ordenes/${ocRecibidaId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(antes.body.estado).toBe('recibida_completa');

    const res = await request(app)
      .patch(`/api/projects/${testProjectId}/ordenes/${ocRecibidaId}/proveedor`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ proveedor_id: proveedorNuevoId });
    expect(res.status).toBe(200);

    const despues = await request(app)
      .get(`/api/projects/${testProjectId}/ordenes/${ocRecibidaId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(despues.body.proveedor_id).toBe(proveedorNuevoId);
    // El estado de recepción no se toca al reasignar proveedor.
    expect(despues.body.estado).toBe('recibida_completa');
  });
});
