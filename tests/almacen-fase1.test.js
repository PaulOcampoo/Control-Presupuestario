// Integration test para Almacén Fase 1 (prompt-almacen-fase1.md,
// diagnóstico previo en prompt-diagnostico-almacen.md): Entradas (compras,
// captura directa sin depender de OC) y Salidas (residente/cabo, vínculo a
// concepto manual y opcional). Mismo patrón autocontenido de
// tests/modelos-vivienda.test.js (usuarios temporales reales, asignados vía
// usuario_proyectos, limpieza física garantizada en afterAll).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let adminToken;
let testProjectId;
let otroProjectId;
let insumoId;
let insumoOtraObraId;
let proveedorId;
let conceptoId;
let comprasUserId, comprasToken;
let residenteUserId, residenteToken;
const comprasUsuario = `qa_almacen_compras_${Date.now()}`;
const residenteUsuario = `qa_almacen_residente_${Date.now()}`;
const tempPassword = 'QaAlmacen123!';

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

  const { rows: proj } = await db.pool.query('SELECT id FROM proyectos ORDER BY id LIMIT 2');
  if (proj.length < 2) throw new Error('Se necesitan al menos 2 obras reales en Preview para correr esta suite (validación cross-obra).');
  testProjectId = proj[0].id;
  otroProjectId = proj[1].id;

  const { rows: ins } = await db.pool.query('SELECT id FROM insumos WHERE project_id = $1 LIMIT 1', [testProjectId]);
  if (!ins.length) throw new Error(`La obra ${testProjectId} no tiene ningún insumo real — no se puede correr esta suite.`);
  insumoId = ins[0].id;

  const { rows: insOtra } = await db.pool.query('SELECT id FROM insumos WHERE project_id = $1 LIMIT 1', [otroProjectId]);
  insumoOtraObraId = insOtra[0]?.id || null;

  const { rows: prov } = await db.pool.query('SELECT id FROM proveedores LIMIT 1');
  proveedorId = prov[0]?.id || null;

  const { rows: con } = await db.pool.query('SELECT id FROM conceptos WHERE project_id = $1 AND es_total = 0 LIMIT 1', [testProjectId]);
  conceptoId = con[0]?.id || null;

  const crearUsuario = async (usuario, puesto) => {
    const res = await request(app)
      .post('/api/usuarios')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: `QA Almacén ${puesto}`, usuario, password: tempPassword, puesto });
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

describe('POST /api/projects/:id/almacen/entradas', () => {
  it('requiere autenticación', async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/almacen/entradas`)
      .send({ insumo_id: insumoId, cantidad: 10 });
    expect(res.status).toBe(401);
  });

  it('residente recibe 403 (solo compras puede crear entradas)', async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/almacen/entradas`)
      .set('Authorization', `Bearer ${residenteToken}`)
      .send({ insumo_id: insumoId, cantidad: 10 });
    expect(res.status).toBe(403);
  });

  it('rechaza sin cantidad > 0 con 400', async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/almacen/entradas`)
      .set('Authorization', `Bearer ${comprasToken}`)
      .send({ insumo_id: insumoId, cantidad: 0 });
    expect(res.status).toBe(400);
  });

  it('rechaza un insumo de otra obra con 400', async () => {
    if (!insumoOtraObraId) return; // no bloquea la suite si esa obra no tiene catálogo
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/almacen/entradas`)
      .set('Authorization', `Bearer ${comprasToken}`)
      .send({ insumo_id: insumoOtraObraId, cantidad: 5 });
    expect(res.status).toBe(400);
  });

  it('compras crea una entrada CON foto y proveedor, se persiste completa', async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/almacen/entradas`)
      .set('Authorization', `Bearer ${comprasToken}`)
      .send({
        insumo_id: insumoId,
        cantidad: 25.5,
        costo_unitario: 120,
        proveedor_id: proveedorId,
        folio_factura_remision: 'F-QA-001',
        foto_url: 'https://example-blob.vercel-storage.com/qa-test-remision.jpg',
        observaciones: 'Entrada de prueba QA',
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.foto_url).toBe('https://example-blob.vercel-storage.com/qa-test-remision.jpg');
    expect(res.body.folio_factura_remision).toBe('F-QA-001');
    entradaIdsCreadas.push(res.body.id);

    const { rows } = await db.pool.query('SELECT * FROM almacen_entradas WHERE id = $1', [res.body.id]);
    expect(rows[0].project_id).toBe(testProjectId);
    expect(rows[0].insumo_id).toBe(insumoId);
    expect(Number(rows[0].cantidad)).toBe(25.5);
    expect(Number(rows[0].costo_unitario)).toBe(120);
    expect(rows[0].usuario_id).toBe(comprasUserId);
    expect(rows[0].activo).toBe(1);
  });

  it('admin también puede crear entradas (bypass de rol)', async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/almacen/entradas`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ insumo_id: insumoId, cantidad: 1 });
    expect(res.status).toBe(201);
    entradaIdsCreadas.push(res.body.id);
  });
});

describe('GET /api/projects/:id/almacen/entradas', () => {
  it('residente SÍ puede ver (puede_ver=true por default aunque no pueda crear)', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/almacen/entradas`)
      .set('Authorization', `Bearer ${residenteToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((e) => entradaIdsCreadas.includes(e.id))).toBe(true);
  });
});

describe('GET /api/projects/:id/almacen/conceptos-disponibles', () => {
  // Verificado con Playwright durante la implementación: residente/cabo NO
  // tienen 'presupuestos' por default, así que el selector de concepto de
  // Salida no puede reutilizar GET /conceptos (403 real) — este endpoint
  // dedicado gatea con 'almacen_salidas' en vez de 'presupuestos', y no
  // expone precio_unitario/importe (dato que se oculta a estos roles en el
  // resto de la app).
  it('residente SÍ puede listar conceptos aquí aunque no tenga acceso a /conceptos', async () => {
    const sinAcceso = await request(app)
      .get(`/api/projects/${testProjectId}/conceptos`)
      .set('Authorization', `Bearer ${residenteToken}`);
    expect(sinAcceso.status).toBe(403);

    const res = await request(app)
      .get(`/api/projects/${testProjectId}/almacen/conceptos-disponibles`)
      .set('Authorization', `Bearer ${residenteToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    if (res.body.length) {
      expect(res.body[0].precio_unitario).toBeUndefined();
      expect(res.body[0].importe).toBeUndefined();
    }
  });

  it('requiere autenticación', async () => {
    const res = await request(app).get(`/api/projects/${testProjectId}/almacen/conceptos-disponibles`);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/projects/:id/almacen/salidas', () => {
  it('compras recibe 403 (solo residente/cabo puede crear salidas)', async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/almacen/salidas`)
      .set('Authorization', `Bearer ${comprasToken}`)
      .send({ insumo_id: insumoId, cantidad: 5 });
    expect(res.status).toBe(403);
  });

  it('residente crea una salida CON concepto', async () => {
    if (!conceptoId) return; // no bloquea la suite si la obra no tiene conceptos capturables
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/almacen/salidas`)
      .set('Authorization', `Bearer ${residenteToken}`)
      .send({ insumo_id: insumoId, cantidad: 3.2, concepto_id: conceptoId, responsable_retiro: 'Juan Pérez (QA)' });
    expect(res.status).toBe(201);
    expect(res.body.concepto_id).toBe(conceptoId);
    salidaIdsCreadas.push(res.body.id);
  });

  it('residente crea una salida SIN concepto (concepto_id null es válido)', async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/almacen/salidas`)
      .set('Authorization', `Bearer ${residenteToken}`)
      .send({ insumo_id: insumoId, cantidad: 1, responsable_retiro: 'Sin concepto claro (QA)' });
    expect(res.status).toBe(201);
    expect(res.body.concepto_id).toBeNull();
    salidaIdsCreadas.push(res.body.id);

    const { rows } = await db.pool.query('SELECT * FROM almacen_salidas WHERE id = $1', [res.body.id]);
    expect(rows[0].project_id).toBe(testProjectId);
    expect(rows[0].usuario_id).toBe(residenteUserId);
    expect(rows[0].activo).toBe(1);
  });

  it('rechaza sin cantidad > 0 con 400', async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/almacen/salidas`)
      .set('Authorization', `Bearer ${residenteToken}`)
      .send({ insumo_id: insumoId, cantidad: 0 });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/projects/:id/almacen/salidas', () => {
  it('compras SÍ puede ver (puede_ver=true por default aunque no pueda crear)', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/almacen/salidas`)
      .set('Authorization', `Bearer ${comprasToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((s) => salidaIdsCreadas.includes(s.id))).toBe(true);
  });

  it('requiere autenticación', async () => {
    const res = await request(app).get(`/api/projects/${testProjectId}/almacen/salidas`);
    expect(res.status).toBe(401);
  });
});
