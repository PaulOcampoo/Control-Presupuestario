// Integration tests para prompt-fix-saldo-iva-5-lugares.md — "Saldo
// pendiente"/"comprometido" negativo o subestimado para OCs con
// incluye_iva=false, en 5 lugares que sumaban orden_compra_items.importe
// crudo sin pasar por computeIvaBreakdown()/totalConIvaDeItems(). Corre
// contra la DB real apuntada por DATABASE_URL.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let adminToken;
let testProjectId;
let proveedorId;
let insumoId;
let requisicionId;
let itemId;
let ocFullId; // incluye_iva=false, pagada completa -> saldo debe ser $0.00
let ocParcialId; // incluye_iva=false, pago parcial -> saldo debe reflejar IVA
let ocRegresionId; // incluye_iva=true -> comportamiento no debe cambiar
let compromisosAntes;
let erogadoAntes;
let dashboardAntes;
let pagoFullResultado;

async function login(usuario, password) {
  const res = await request(app).post('/api/auth/login').send({ usuario, password });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`Login falló para ${usuario}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

async function crearOC(cantidad, precioUnitario, incluyeIva) {
  const res = await request(app)
    .post(`/api/projects/${testProjectId}/requisiciones/${requisicionId}/ordenes`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ proveedor_id: proveedorId, incluye_iva: incluyeIva, items: [{ requisicion_item_id: itemId, cantidad_ordenada: cantidad, precio_unitario: precioUnitario }] });
  if (res.status !== 201) throw new Error(`No se pudo crear la OC de prueba: ${res.status} ${JSON.stringify(res.body)}`);
  const ocId = res.body.id;
  const confirmarRes = await request(app)
    .put(`/api/projects/${testProjectId}/ordenes/${ocId}/estado`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ estado: 'confirmada' });
  if (confirmarRes.status !== 200) throw new Error(`No se pudo confirmar la OC de prueba: ${confirmarRes.status} ${JSON.stringify(confirmarRes.body)}`);
  return ocId;
}

async function pagar(ocId, monto) {
  const res = await request(app)
    .post(`/api/projects/${testProjectId}/ordenes/${ocId}/pagos`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ monto, metodo: 'transferencia', referencia: 'QA-TEST' });
  if (res.status !== 201) throw new Error(`No se pudo registrar el pago de prueba: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

beforeAll(async () => {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada — no se puede correr la suite.');
  adminToken = await login(ADMIN_USER, ADMIN_PASSWORD);

  const { rows: projRows } = await db.pool.query('SELECT id FROM proyectos ORDER BY id LIMIT 1');
  testProjectId = projRows[0].id;
  const { rows: provRows } = await db.pool.query('SELECT id FROM proveedores LIMIT 1');
  proveedorId = provRows[0].id;

  const insRes = await db.pool.query(
    `INSERT INTO insumos (project_id, codigo, concepto, categoria, unidad, cantidad_presupuesto, precio_presupuesto, iva_tasa)
     VALUES ($1, 'QA-IVA-TEST', 'QA Material Prueba IVA', 'Materiales', 'PZA', 100, 55900, 16) RETURNING id`,
    [testProjectId]
  );
  insumoId = insRes.rows[0].id;

  const reqRes = await request(app)
    .post(`/api/projects/${testProjectId}/requisiciones`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ items: [{ insumo_id: insumoId, cantidad_solicitada: 10, precio_solicitado: 55900 }] });
  if (reqRes.status !== 201) throw new Error(`No se pudo crear la requisición de prueba: ${reqRes.status} ${JSON.stringify(reqRes.body)}`);
  requisicionId = reqRes.body.id;
  const detalle = await request(app)
    .get(`/api/projects/${testProjectId}/requisiciones/${requisicionId}`)
    .set('Authorization', `Bearer ${adminToken}`);
  itemId = detalle.body.items[0].id;

  for (const estado of ['enviada', 'autorizada']) {
    const r = await request(app)
      .put(`/api/projects/${testProjectId}/requisiciones/${requisicionId}/estado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ estado });
    if (r.status !== 200) throw new Error(`No se pudo pasar la requisición a '${estado}': ${r.status} ${JSON.stringify(r.body)}`);
  }

  // Snapshots ANTES de crear las OCs de prueba, para medir el delta que
  // introducen (project_id 13 ya tiene OCs reales de otras sesiones).
  const compRes0 = await request(app)
    .get(`/api/projects/${testProjectId}/finanzas/compromisos-abiertos`)
    .set('Authorization', `Bearer ${adminToken}`);
  compromisosAntes = compRes0.body.total.monto_pendiente;
  const erogRes0 = await request(app)
    .get(`/api/projects/${testProjectId}/finanzas/resumen`)
    .set('Authorization', `Bearer ${adminToken}`);
  erogadoAntes = erogRes0.body.erogado_real.compras_comprometido_con_iva;
  const dashRes0 = await request(app).get('/api/dashboard-ejecutivo').set('Authorization', `Bearer ${adminToken}`);
  dashboardAntes = dashRes0.body.obras.find((o) => o.project_id === testProjectId)?.compromisos.monto_pendiente || 0;

  // Subtotal $55,900 + IVA 16% ($8,944) = Total $64,844 -- mismo caso real reportado.
  ocFullId = await crearOC(1, 55900, false);
  pagoFullResultado = await pagar(ocFullId, 64844);

  // Subtotal $10,000 + IVA 16% ($1,600) = Total $11,600. Pago parcial $5,000.
  ocParcialId = await crearOC(1, 10000, false);
  await pagar(ocParcialId, 5000);

  // Regresión: incluye_iva=true, el importe capturado YA es el total.
  ocRegresionId = await crearOC(1, 64844, true);
  await pagar(ocRegresionId, 64844);
}, 60000);

afterAll(async () => {
  const ocIds = [ocFullId, ocParcialId, ocRegresionId].filter(Boolean);
  if (ocIds.length) {
    await db.pool.query('DELETE FROM pagos WHERE orden_compra_id = ANY($1)', [ocIds]);
    await db.pool.query('DELETE FROM orden_compra_items WHERE orden_compra_id = ANY($1)', [ocIds]);
    await db.pool.query('DELETE FROM ordenes_compra WHERE id = ANY($1)', [ocIds]);
  }
  if (requisicionId) {
    await db.pool.query('DELETE FROM requisicion_items WHERE requisicion_id = $1', [requisicionId]);
    await db.pool.query('DELETE FROM requisiciones WHERE id = $1', [requisicionId]);
  }
  if (insumoId) await db.pool.query('DELETE FROM insumos WHERE id = $1', [insumoId]);
  await db.pool.end();
});

describe('saldoDeOrden — GET /ordenes/:ocId/pagos', () => {
  it('incluye_iva=false, pago completo ($64,844) -> saldo_pendiente = $0.00 exacto', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/ordenes/${ocFullId}/pagos`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.importe_total).toBe(64844);
    expect(res.body.saldo_pendiente).toBe(0);
  });

  it('incluye_iva=false, pago parcial ($5,000 de $11,600) -> saldo_pendiente = $6,600.00 (no $5,000)', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/ordenes/${ocParcialId}/pagos`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.importe_total).toBe(11600);
    expect(res.body.saldo_pendiente).toBe(6600);
  });

  it('regresión incluye_iva=true, pago completo -> saldo_pendiente = $0.00 (sin cambio)', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/ordenes/${ocRegresionId}/pagos`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.importe_total).toBe(64844);
    expect(res.body.saldo_pendiente).toBe(0);
  });

  it('alerta_sobrepago NO se dispara falsamente para incluye_iva=false pagada exacto', () => {
    expect(pagoFullResultado.saldo_pendiente).toBe(0);
    expect(pagoFullResultado.alerta_sobrepago).toBe(false);
  });
});

describe('getOrdenesData — GET /ordenes (lista) y saldo_pendiente', () => {
  it('la lista de Órdenes de Compra refleja el mismo saldo corregido', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/ordenes`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const ocFull = res.body.find((o) => o.id === ocFullId);
    const ocParcial = res.body.find((o) => o.id === ocParcialId);
    expect(ocFull.saldo_pendiente).toBe(0);
    expect(ocFull.importe_total).toBe(64844);
    expect(ocParcial.saldo_pendiente).toBe(6600);
    expect(ocParcial.importe_total).toBe(11600);
  });
});

describe('Compromisos Abiertos — GET /finanzas/compromisos-abiertos', () => {
  it('el pendiente total sube exactamente $6,600 (solo la OC con pago parcial)', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/finanzas/compromisos-abiertos`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Number((res.body.total.monto_pendiente - compromisosAntes).toFixed(2))).toBe(6600);
  });
});

describe('Dashboard Ejecutivo — GET /api/dashboard-ejecutivo (agregado multi-obra)', () => {
  it('compromisos.monto_pendiente de la obra sube exactamente $6,600', async () => {
    const res = await request(app).get('/api/dashboard-ejecutivo').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const obra = res.body.obras.find((o) => o.project_id === testProjectId);
    expect(Number((obra.compromisos.monto_pendiente - dashboardAntes).toFixed(2))).toBe(6600);
  });
});

describe('Erogado Real — GET /finanzas/resumen (compras_comprometido_con_iva)', () => {
  it('compras_comprometido_con_iva sube exactamente $6,600', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/finanzas/resumen`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Number((res.body.erogado_real.compras_comprometido_con_iva - erogadoAntes).toFixed(2))).toBe(6600);
  });
});
