// Integration tests para la edición del % de Fondo de Garantía desde el
// panel de Tesorería (prompt-fondo-garantia-editable-panel.md) — antes solo
// editable vía Contrato (admin/desarrollador-only). Corre contra la base de
// datos real apuntada por DATABASE_URL (mismo patrón que
// tests/presupuestos-permisos.test.js): crea un cliente + 2 obras + un
// usuario 'tesoreria' temporales vía los endpoints reales de la app, y los
// borra físicamente en afterAll.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let adminToken;
let tempUserId;
let tempToken;
let clienteId;
let obra1Id;
let obra2Id;
let estimacionId;
const tempUsuario = `qa_fondogarantia_${Date.now()}`;
const tempPassword = 'QaFondoGarantiaTemp123!';
const clienteNombre = `QA Fondo Garantía ${Date.now()}`;

async function login(usuario, password) {
  const res = await request(app).post('/api/auth/login').send({ usuario, password });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`Login falló para ${usuario}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

async function setPermisoFinanzas(usuarioId, { puedeVer = true, puedeEditar }) {
  const res = await request(app)
    .put(`/api/permisos/${usuarioId}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ proyecto_id: null, permisos: [{ seccion: 'finanzas', puede_ver: puedeVer, puede_editar: puedeEditar }] });
  if (res.status !== 200) {
    throw new Error(`No se pudo setear el permiso: ${res.status} ${JSON.stringify(res.body)}`);
  }
}

async function pctDeObra(projectId) {
  const { rows } = await db.pool.query(
    "SELECT valor FROM meta WHERE project_id = $1 AND clave = 'porcentaje_fondo_garantia'",
    [projectId]
  );
  return rows[0] ? Number(rows[0].valor) : null;
}

beforeAll(async () => {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada — no se puede correr la suite de integración.');
  adminToken = await login(ADMIN_USER, ADMIN_PASSWORD);

  const clienteRes = await request(app)
    .post('/api/clientes')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: clienteNombre });
  if (clienteRes.status !== 201) throw new Error(`No se pudo crear el cliente de prueba: ${clienteRes.status} ${JSON.stringify(clienteRes.body)}`);
  clienteId = clienteRes.body.id;

  const obra1Res = await request(app)
    .post('/api/projects/contrato-confirm')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ cliente_id: clienteId, nombre: 'QA Obra 1' });
  if (obra1Res.status !== 200) throw new Error(`No se pudo crear la obra de prueba 1: ${obra1Res.status} ${JSON.stringify(obra1Res.body)}`);

  const obra2Res = await request(app)
    .post('/api/projects/contrato-confirm')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ cliente_id: clienteId, nombre: 'QA Obra 2' });
  if (obra2Res.status !== 200) throw new Error(`No se pudo crear la obra de prueba 2: ${obra2Res.status} ${JSON.stringify(obra2Res.body)}`);
  const { rows: obrasCliente } = await db.pool.query('SELECT id FROM proyectos WHERE cliente_id = $1 ORDER BY id', [clienteId]);
  if (obrasCliente.length !== 2) throw new Error(`Se esperaban 2 obras de prueba, hay ${obrasCliente.length}`);
  [obra1Id, obra2Id] = obrasCliente.map((o) => o.id);

  const createUserRes = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA Fondo Garantia Tesoreria', usuario: tempUsuario, password: tempPassword, puesto: 'tesoreria' });
  if (createUserRes.status !== 201 && createUserRes.status !== 200) {
    throw new Error(`No se pudo crear el usuario temporal: ${createUserRes.status} ${JSON.stringify(createUserRes.body)}`);
  }
  tempUserId = createUserRes.body.id;

  const asignaRes = await request(app)
    .put(`/api/usuarios/${tempUserId}/proyectos`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ project_ids: [obra1Id, obra2Id] });
  if (asignaRes.status !== 200) throw new Error(`No se pudo asignar las obras al usuario temporal: ${asignaRes.status} ${JSON.stringify(asignaRes.body)}`);

  tempToken = await login(tempUsuario, tempPassword);
});

afterAll(async () => {
  if (estimacionId) await db.pool.query('DELETE FROM estimaciones WHERE id = $1', [estimacionId]);
  if (tempUserId) await request(app).delete(`/api/usuarios/${tempUserId}`).set('Authorization', `Bearer ${adminToken}`);
  if (obra1Id) await request(app).delete(`/api/projects/${obra1Id}`).set('Authorization', `Bearer ${adminToken}`);
  if (obra2Id) await request(app).delete(`/api/projects/${obra2Id}`).set('Authorization', `Bearer ${adminToken}`);
  if (clienteId) await request(app).delete(`/api/clientes/${clienteId}`).set('Authorization', `Bearer ${adminToken}`);
  await db.pool.end();
});

describe('PUT /api/projects/:id/fondo-garantia — obra única', () => {
  it('tesorería SIN puede_editar en finanzas recibe 403 real', async () => {
    await setPermisoFinanzas(tempUserId, { puedeEditar: false });
    const res = await request(app)
      .put(`/api/projects/${obra1Id}/fondo-garantia`)
      .set('Authorization', `Bearer ${tempToken}`)
      .send({ porcentaje: 6 });
    expect(res.status).toBe(403);
  });

  it('tesorería CON puede_editar en finanzas edita el % y persiste en meta', async () => {
    await setPermisoFinanzas(tempUserId, { puedeEditar: true });
    const res = await request(app)
      .put(`/api/projects/${obra1Id}/fondo-garantia`)
      .set('Authorization', `Bearer ${tempToken}`)
      .send({ porcentaje: 6 });
    expect(res.status).toBe(200);
    expect(res.body.porcentaje_pactado).toBe(6);
    expect(await pctDeObra(obra1Id)).toBe(6);

    const getRes = await request(app)
      .get(`/api/projects/${obra1Id}/finanzas/fondo-garantia`)
      .set('Authorization', `Bearer ${tempToken}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.porcentaje_pactado).toBe(6);
  });

  it('rechaza un % fuera de rango (0-15) con 400, sin persistir', async () => {
    const res = await request(app)
      .put(`/api/projects/${obra1Id}/fondo-garantia`)
      .set('Authorization', `Bearer ${tempToken}`)
      .send({ porcentaje: 27 });
    expect(res.status).toBe(400);
    expect(await pctDeObra(obra1Id)).toBe(6); // sin cambio respecto al test anterior
  });

  it('tesorería sin acceso a la obra (usuario_proyectos) recibe 403 vía verificarAccesoObra', async () => {
    // obra2 nunca se desasigna, así que reusar un project_id ajeno (una obra
    // real cualquiera, no la de prueba) confirma que verificarAccesoObra
    // sigue siendo el primer gate — si no hay otra obra en la DB, se omite.
    const { rows } = await db.pool.query('SELECT id FROM proyectos WHERE id != $1 AND id != $2 LIMIT 1', [obra1Id, obra2Id]);
    if (!rows[0]) return;
    const res = await request(app)
      .put(`/api/projects/${rows[0].id}/fondo-garantia`)
      .set('Authorization', `Bearer ${tempToken}`)
      .send({ porcentaje: 6 });
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/clientes/:id/fondo-garantia — todas las obras del cliente', () => {
  it('admin aplica el % a TODAS las obras del cliente de prueba', async () => {
    const res = await request(app)
      .put(`/api/clientes/${clienteId}/fondo-garantia`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ porcentaje: 9 });
    expect(res.status).toBe(200);
    expect(res.body.obras.map((o) => o.id).sort()).toEqual([obra1Id, obra2Id].sort());
    expect(await pctDeObra(obra1Id)).toBe(9);
    expect(await pctDeObra(obra2Id)).toBe(9);
  });

  it('tesorería con acceso a ambas obras también puede aplicar a todo el cliente', async () => {
    await setPermisoFinanzas(tempUserId, { puedeEditar: true });
    const res = await request(app)
      .put(`/api/clientes/${clienteId}/fondo-garantia`)
      .set('Authorization', `Bearer ${tempToken}`)
      .send({ porcentaje: 11 });
    expect(res.status).toBe(200);
    expect(await pctDeObra(obra1Id)).toBe(11);
    expect(await pctDeObra(obra2Id)).toBe(11);
  });

  it('todo-o-nada: un % inválido no toca ninguna obra del cliente', async () => {
    const antes1 = await pctDeObra(obra1Id);
    const antes2 = await pctDeObra(obra2Id);
    const res = await request(app)
      .put(`/api/clientes/${clienteId}/fondo-garantia`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ porcentaje: -1 });
    expect(res.status).toBe(400);
    expect(await pctDeObra(obra1Id)).toBe(antes1);
    expect(await pctDeObra(obra2Id)).toBe(antes2);
  });
});

describe('Estimaciones ya aprobadas nunca se recalculan al editar el %', () => {
  it('fondo_garantia_monto de una estimación aprobada no cambia tras editar el % de la obra', async () => {
    const { rows } = await db.pool.query(
      `INSERT INTO estimaciones (project_id, folio, periodo_inicio, periodo_fin, estado, activo, fecha_aprobacion, total_periodo, fondo_garantia_monto)
       VALUES ($1, 1, '2026-01-01', '2026-01-15', 'aprobada', true, NOW(), 100000, 1234.56)
       RETURNING id, fondo_garantia_monto`,
      [obra1Id]
    );
    estimacionId = rows[0].id;
    expect(Number(rows[0].fondo_garantia_monto)).toBe(1234.56);

    const res = await request(app)
      .put(`/api/projects/${obra1Id}/fondo-garantia`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ porcentaje: 3 });
    expect(res.status).toBe(200);
    expect(await pctDeObra(obra1Id)).toBe(3);

    const { rows: after } = await db.pool.query('SELECT fondo_garantia_monto FROM estimaciones WHERE id = $1', [estimacionId]);
    expect(Number(after[0].fondo_garantia_monto)).toBe(1234.56);

    const getRes = await request(app)
      .get(`/api/projects/${obra1Id}/finanzas/fondo-garantia`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getRes.body.porcentaje_pactado).toBe(3);
    const historicoRow = getRes.body.historico.find((h) => h.estimacion_id === estimacionId);
    expect(historicoRow.fondo_garantia_monto).toBe(1234.56);
  });
});

describe('Regresión: POST /api/projects/contrato-confirm sigue funcionando tras el refactor', () => {
  it('sigue actualizando porcentaje_fondo_garantia junto con el resto de campos del contrato', async () => {
    const res = await request(app)
      .post('/api/projects/contrato-confirm')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ project_id: obra1Id, porcentaje_fondo_garantia: 4, obra_descripcion: 'QA Obra 1 actualizada' });
    expect(res.status).toBe(200);
    expect(await pctDeObra(obra1Id)).toBe(4);

    const { rows } = await db.pool.query("SELECT valor FROM meta WHERE project_id = $1 AND clave = 'obra_descripcion'", [obra1Id]);
    expect(rows[0]?.valor).toBe('QA Obra 1 actualizada');
  });

  it('rechaza un % fuera de rango ANTES de tocar cualquier dato (incluyendo alta de obra nueva)', async () => {
    const { rows: antes } = await db.pool.query('SELECT COUNT(*) AS n FROM proyectos WHERE cliente_id = $1', [clienteId]);
    const res = await request(app)
      .post('/api/projects/contrato-confirm')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ cliente_id: clienteId, nombre: 'QA Obra que no debe crearse', porcentaje_fondo_garantia: 99 });
    expect(res.status).toBe(400);
    const { rows: despues } = await db.pool.query('SELECT COUNT(*) AS n FROM proyectos WHERE cliente_id = $1', [clienteId]);
    expect(despues[0].n).toBe(antes[0].n); // ninguna obra nueva se creó
  });
});
