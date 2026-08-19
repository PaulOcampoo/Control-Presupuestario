// Integration tests para prompt-editar-requisicion-con-oc.md — edición
// selectiva (UPDATE, no borrar-y-recrear) de UN item de una requisición que
// ya tiene Orden de Compra generada, sin tocar orden_compra_items ni pagos.
// Corre contra la DB real apuntada por DATABASE_URL (mismo patrón que el
// resto de tests/*.test.js de este repo).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let adminToken;
let residenteToken;
let residenteTempId;
let testProjectId;
let proveedorId;
let insumoWrongId;
let insumoCorrectId;
let requisicionId;
let itemId;
let ocId;
let pagoId;
const residenteTempUsuario = `qa_residente_reqoc_${Date.now()}`;
const tempPassword = 'QaReqOcTemp123!';

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
  testProjectId = projRows[0].id;
  const { rows: provRows } = await db.pool.query('SELECT id FROM proveedores LIMIT 1');
  if (!provRows[0]) throw new Error('No hay ningún proveedor contra el cual correr la suite.');
  proveedorId = provRows[0].id;

  // Sin endpoint POST /insumos (solo se cargan vía Excel de presupuesto) —
  // insert directo, mismo criterio ya usado en otros tests de este repo
  // cuando no existe endpoint para el setup.
  const insWrong = await db.pool.query(
    `INSERT INTO insumos (project_id, codigo, concepto, categoria, unidad, cantidad_presupuesto, precio_presupuesto)
     VALUES ($1, 'QA-WRONG-PZA', 'QA Material Prueba', 'Materiales', 'PZA', 1000, 10) RETURNING id`,
    [testProjectId]
  );
  insumoWrongId = insWrong.rows[0].id;
  const insCorrect = await db.pool.query(
    `INSERT INTO insumos (project_id, codigo, concepto, categoria, unidad, cantidad_presupuesto, precio_presupuesto)
     VALUES ($1, 'QA-CORRECT-M2', 'QA Material Prueba', 'Materiales', 'M2', 1000, 12) RETURNING id`,
    [testProjectId]
  );
  insumoCorrectId = insCorrect.rows[0].id;

  // Requisición borrador -> enviada -> autorizada, con OC generada y un pago
  // real registrado -- exactamente el escenario del caso real (Requisición
  // #37): OC y pago ya confirmados antes de corregir el renglón.
  const reqRes = await request(app)
    .post(`/api/projects/${testProjectId}/requisiciones`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ items: [{ insumo_id: insumoWrongId, cantidad_solicitada: 20, precio_solicitado: 10 }] });
  if (reqRes.status !== 201) throw new Error(`No se pudo crear la requisición de prueba: ${reqRes.status} ${JSON.stringify(reqRes.body)}`);
  requisicionId = reqRes.body.id;
  // POST /requisiciones no regresa el id real de cada requisicion_item (el
  // array 'items' de la respuesta es el calculado pre-INSERT, sin
  // RETURNING) -- se obtiene con un GET de detalle inmediato después.
  const detalleInicial = await request(app)
    .get(`/api/projects/${testProjectId}/requisiciones/${requisicionId}`)
    .set('Authorization', `Bearer ${adminToken}`);
  itemId = detalleInicial.body.items[0].id;

  for (const estado of ['enviada', 'autorizada']) {
    const r = await request(app)
      .put(`/api/projects/${testProjectId}/requisiciones/${requisicionId}/estado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ estado });
    if (r.status !== 200) throw new Error(`No se pudo pasar la requisición a '${estado}': ${r.status} ${JSON.stringify(r.body)}`);
  }

  const ocRes = await request(app)
    .post(`/api/projects/${testProjectId}/requisiciones/${requisicionId}/ordenes`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ proveedor_id: proveedorId, items: [{ requisicion_item_id: itemId, cantidad_ordenada: 20, precio_unitario: 10 }] });
  if (ocRes.status !== 201) throw new Error(`No se pudo generar la OC de prueba: ${ocRes.status} ${JSON.stringify(ocRes.body)}`);
  ocId = ocRes.body.id;

  await request(app)
    .put(`/api/projects/${testProjectId}/ordenes/${ocId}/estado`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ estado: 'enviada' });

  const pagoRes = await request(app)
    .post(`/api/projects/${testProjectId}/ordenes/${ocId}/pagos`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ monto: 232, metodo: 'transferencia', referencia: 'QA-TEST' });
  if (pagoRes.status !== 201) throw new Error(`No se pudo registrar el pago de prueba: ${pagoRes.status} ${JSON.stringify(pagoRes.body)}`);
  pagoId = pagoRes.body.id;

  const createUserRes = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA Residente ReqOC', usuario: residenteTempUsuario, password: tempPassword, puesto: 'residente' });
  residenteTempId = createUserRes.body.id;
  await request(app)
    .put(`/api/usuarios/${residenteTempId}/proyectos`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ project_ids: [testProjectId] });
  residenteToken = await login(residenteTempUsuario, tempPassword);
}, 30000);

afterAll(async () => {
  if (pagoId) await db.pool.query('DELETE FROM pagos WHERE id = $1', [pagoId]);
  if (ocId) await db.pool.query('DELETE FROM orden_compra_items WHERE orden_compra_id = $1', [ocId]);
  if (ocId) await db.pool.query('DELETE FROM ordenes_compra WHERE id = $1', [ocId]);
  if (requisicionId) await db.pool.query('DELETE FROM audit_log WHERE target_id = $1', [requisicionId]);
  if (requisicionId) await db.pool.query('DELETE FROM requisicion_items WHERE requisicion_id = $1', [requisicionId]);
  if (requisicionId) await db.pool.query('DELETE FROM requisiciones WHERE id = $1', [requisicionId]);
  if (insumoWrongId) await db.pool.query('DELETE FROM insumos WHERE id = $1', [insumoWrongId]);
  if (insumoCorrectId) await db.pool.query('DELETE FROM insumos WHERE id = $1', [insumoCorrectId]);
  if (residenteTempId) await request(app).delete(`/api/usuarios/${residenteTempId}`).set('Authorization', `Bearer ${adminToken}`);
  await db.pool.end();
});

describe('PUT /api/projects/:id/requisiciones/:reqId/items/:itemId', () => {
  it('rechaza sin justificación (400)', async () => {
    const res = await request(app)
      .put(`/api/projects/${testProjectId}/requisiciones/${requisicionId}/items/${itemId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ insumo_id: insumoCorrectId, cantidad_solicitada: 20, precio_solicitado: 12 });
    expect(res.status).toBe(400);
  });

  it('rechaza a un rol distinto de admin/desarrollador (403)', async () => {
    const res = await request(app)
      .put(`/api/projects/${testProjectId}/requisiciones/${requisicionId}/items/${itemId}`)
      .set('Authorization', `Bearer ${residenteToken}`)
      .send({ insumo_id: insumoCorrectId, cantidad_solicitada: 20, precio_solicitado: 12, justificacion: 'intento no autorizado' });
    expect(res.status).toBe(403);
  });

  it('corrige el insumo/cantidad y NO toca OC ni pagos ya confirmados', async () => {
    const [ocItemsAntes, pagoAntes] = await Promise.all([
      db.pool.query('SELECT * FROM orden_compra_items WHERE orden_compra_id = $1 ORDER BY id', [ocId]),
      db.pool.query('SELECT * FROM pagos WHERE id = $1', [pagoId]),
    ]);

    const res = await request(app)
      .put(`/api/projects/${testProjectId}/requisiciones/${requisicionId}/items/${itemId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ insumo_id: insumoCorrectId, cantidad_solicitada: 18, precio_solicitado: 12, justificacion: 'QA: se ligó al insumo PZA por error, el material real es M2' });
    expect(res.status).toBe(200);
    expect(res.body.insumo_id).toBe(insumoCorrectId);
    expect(Number(res.body.cantidad_solicitada)).toBe(18);
    expect(Number(res.body.precio_solicitado)).toBe(12);
    expect(Number(res.body.importe)).toBe(216);

    const { rows: itemDespues } = await db.pool.query('SELECT * FROM requisicion_items WHERE id = $1', [itemId]);
    expect(itemDespues[0].insumo_id).toBe(insumoCorrectId);
    expect(Number(itemDespues[0].cantidad_solicitada)).toBe(18);

    const [ocItemsDespues, pagoDespues] = await Promise.all([
      db.pool.query('SELECT * FROM orden_compra_items WHERE orden_compra_id = $1 ORDER BY id', [ocId]),
      db.pool.query('SELECT * FROM pagos WHERE id = $1', [pagoId]),
    ]);
    expect(ocItemsDespues.rows).toEqual(ocItemsAntes.rows);
    expect(pagoDespues.rows).toEqual(pagoAntes.rows);
  });

  it('queda registrado en audit_log con actor, requisicion_item_id y justificación', async () => {
    const { rows } = await db.pool.query(
      "SELECT * FROM audit_log WHERE target_id = $1 AND accion = 'requisicion_item_editar_post_oc' ORDER BY id DESC LIMIT 1",
      [requisicionId]
    );
    expect(rows[0]).toBeTruthy();
    expect(rows[0].actor_usuario).toBe(ADMIN_USER);
    expect(rows[0].target_usuario).toContain(`item #${itemId}`);
    expect(rows[0].target_usuario).toContain('QA-CORRECT-M2');
    expect(rows[0].target_usuario).toContain('justificación: QA: se ligó al insumo PZA por error');
  });

  it('"disponibilidad de materiales" refleja el cambio de inmediato para ambos insumos', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/insumos`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const wrong = res.body.find((i) => i.id === insumoWrongId);
    const correct = res.body.find((i) => i.id === insumoCorrectId);
    expect(wrong.cantidad_acumulada).toBe(0); // ya no tiene nada requisitado
    expect(correct.cantidad_acumulada).toBe(18); // ahora refleja el item corregido
  });

  it('rechaza editar una requisición en estado "borrador" (tiene su propio endpoint)', async () => {
    const borradorRes = await request(app)
      .post(`/api/projects/${testProjectId}/requisiciones`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ items: [{ insumo_id: insumoCorrectId, cantidad_solicitada: 5, precio_solicitado: 12 }] });
    const borradorId = borradorRes.body.id;
    const detalleBorrador = await request(app)
      .get(`/api/projects/${testProjectId}/requisiciones/${borradorId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    const borradorItemId = detalleBorrador.body.items[0].id;
    try {
      const res = await request(app)
        .put(`/api/projects/${testProjectId}/requisiciones/${borradorId}/items/${borradorItemId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ cantidad_solicitada: 6, justificacion: 'no debería pasar' });
      expect(res.status).toBe(400);
    } finally {
      await db.pool.query('DELETE FROM requisicion_items WHERE requisicion_id = $1', [borradorId]);
      await db.pool.query('DELETE FROM requisiciones WHERE id = $1', [borradorId]);
    }
  });
});

describe('Regresión: PUT /api/projects/:id/requisiciones/:reqId (edición completa, borrador-only)', () => {
  it('sigue funcionando exactamente igual para requisiciones en borrador', async () => {
    const borradorRes = await request(app)
      .post(`/api/projects/${testProjectId}/requisiciones`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ items: [{ insumo_id: insumoCorrectId, cantidad_solicitada: 3, precio_solicitado: 12 }] });
    const borradorId = borradorRes.body.id;
    try {
      const res = await request(app)
        .put(`/api/projects/${testProjectId}/requisiciones/${borradorId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ observaciones: 'QA regresion', items: [{ insumo_id: insumoCorrectId, cantidad_solicitada: 7, precio_solicitado: 12 }] });
      expect(res.status).toBe(200);
      expect(res.body.observaciones).toBe('QA regresion');
      expect(Number(res.body.items[0].cantidad_solicitada)).toBe(7);
    } finally {
      await db.pool.query('DELETE FROM requisicion_items WHERE requisicion_id = $1', [borradorId]);
      await db.pool.query('DELETE FROM requisiciones WHERE id = $1', [borradorId]);
    }
  });
});
