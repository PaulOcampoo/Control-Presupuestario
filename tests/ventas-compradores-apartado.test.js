// Integration test para la Fase 4 del roadmap "Desarrollador de Vivienda",
// PR A (prompt-implementacion-pr-a-compradores-apartado.md, diagnóstico
// previo en prompt-diagnostico-compradores-venta.md): entidad Compradores +
// flujo de Apartado, con lotes.estatus_venta derivado 100% en el backend.
// Mismo patrón autocontenido de tests/modelos-vivienda.test.js — usuario
// 'residente' temporal para confirmar el 403 real en TODOS los endpoints de
// Ventas (a diferencia de Modelos de Vivienda, aquí ni siquiera GET es
// accesible para no-admin, ver Forbidden Action del prompt: sin entrada en
// permisos_usuario/SECCIONES_PERMISOS).
//
// No existe endpoint DELETE para lotes — el lote de prueba que este archivo
// crea se borra físicamente vía SQL directo en afterAll, mismo criterio que
// modelos-vivienda.test.js.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let adminToken;
let testProjectId;
let otroProjectId; // obra distinta, para probar la validación cross-obra
let tempUserId;
let tempToken;
const tempUsuario = `qa_ventas_${Date.now()}`;
const tempPassword = 'QaVentasTemp123!';

const loteIdsCreados = [];
const compradorIdsCreados = []; // soft-delete por diseño de la app, pero se borran físicamente aquí (limpieza de datos de prueba)
const apartadoIdsCreados = []; // borrados en cascada al borrar el lote, pero se listan para verificación explícita

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

  const { rows } = await db.pool.query('SELECT id FROM proyectos ORDER BY id LIMIT 2');
  if (rows.length < 2) throw new Error('Se necesitan al menos 2 obras reales en Preview para correr esta suite (validación cross-obra).');
  testProjectId = rows[0].id;
  otroProjectId = rows[1].id;

  const createRes = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA Ventas', usuario: tempUsuario, password: tempPassword, puesto: 'residente' });
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
    // Borra primero los apartados (FK a lotes) para que el DELETE de lotes
    // no choque con la restricción de integridad referencial.
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

describe('GET /api/projects/:id/nav-tabs — compradores/apartados solo para admin/desarrollador', () => {
  it('admin ve compradores y apartados en sus tabs', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/nav-tabs`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.tabs).toContain('compradores');
    expect(res.body.tabs).toContain('apartados');
  });

  it('residente NO ve compradores ni apartados en sus tabs (sin entrada en permisos_usuario, imposible de otorgar)', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/nav-tabs`)
      .set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(200);
    expect(res.body.tabs).not.toContain('compradores');
    expect(res.body.tabs).not.toContain('apartados');
  });
});

describe('Compradores — auth.allow() admin/desarrollador exclusivo, sin excepción por permisos_usuario', () => {
  it('GET requiere autenticación', async () => {
    const res = await request(app).get(`/api/projects/${testProjectId}/compradores`);
    expect(res.status).toBe(401);
  });

  it('residente recibe 403 incluso en GET (a diferencia de Modelos de Vivienda)', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/compradores`)
      .set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(403);
  });

  it('residente recibe 403 en POST', async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/compradores`)
      .set('Authorization', `Bearer ${tempToken}`)
      .send({ nombre: 'QA Comprador Residente' });
    expect(res.status).toBe(403);
  });

  it('admin crea, edita y desactiva (soft-delete) un comprador correctamente', async () => {
    const createRes = await request(app)
      .post(`/api/projects/${testProjectId}/compradores`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: `QA Comprador ${Date.now()}`, contacto: 'esposo de prueba', telefono: '5555555555', email: 'qa@example.com', rfc: 'XAXX010101000' });
    expect(createRes.status).toBe(201);
    expect(createRes.body.activo).toBe(true);
    compradorIdsCreados.push(createRes.body.id);

    const editRes = await request(app)
      .put(`/api/projects/${testProjectId}/compradores/${createRes.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ telefono: '5551234567' });
    expect(editRes.status).toBe(200);
    expect(editRes.body.telefono).toBe('5551234567');

    const delRes = await request(app)
      .delete(`/api/projects/${testProjectId}/compradores/${createRes.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(delRes.status).toBe(200);
    expect(delRes.body.activo).toBe(false);

    const { rows } = await db.pool.query('SELECT activo FROM compradores WHERE id = $1', [createRes.body.id]);
    expect(rows.length).toBe(1); // nunca DELETE físico desde la app
    expect(rows[0].activo).toBe(false);
  });

  it('rechaza sin nombre con 400', async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/compradores`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ telefono: '123' });
    expect(res.status).toBe(400);
  });
});

describe('Apartados — deriva lotes.estatus_venta, índice único parcial, validación cross-obra', () => {
  let compradorId;
  let loteId;

  beforeAll(async () => {
    const compradorRes = await request(app)
      .post(`/api/projects/${testProjectId}/compradores`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: `QA Comprador Apartado ${Date.now()}` });
    compradorId = compradorRes.body.id;
    compradorIdsCreados.push(compradorId);

    const loteRes = await request(app)
      .post(`/api/projects/${testProjectId}/lotes`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ numero_lote: `QA-VENTAS-${Date.now()}` });
    loteId = loteRes.body.id;
    loteIdsCreados.push(loteId);
    expect(loteRes.body.estatus_venta).toBe('no_disponible');
  }, 30000);

  it('GET/POST de apartados requieren autenticación y bloquean a residente', async () => {
    const getNoAuth = await request(app).get(`/api/projects/${testProjectId}/apartados`);
    expect(getNoAuth.status).toBe(401);

    const getResidente = await request(app)
      .get(`/api/projects/${testProjectId}/apartados`)
      .set('Authorization', `Bearer ${tempToken}`);
    expect(getResidente.status).toBe(403);

    const postResidente = await request(app)
      .post(`/api/projects/${testProjectId}/apartados`)
      .set('Authorization', `Bearer ${tempToken}`)
      .send({ lote_id: loteId, comprador_id: compradorId, monto: 50000 });
    expect(postResidente.status).toBe(403);
  });

  it('rechaza un lote de OTRA obra con 400 (sin mezclar lotes entre proyectos)', async () => {
    const res = await request(app)
      .post(`/api/projects/${otroProjectId}/apartados`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ lote_id: loteId, comprador_id: compradorId, monto: 50000 });
    expect(res.status).toBe(400);
  });

  it('crea el apartado y deriva lotes.estatus_venta a "apartado" (verificado con query directa)', async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/apartados`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ lote_id: loteId, comprador_id: compradorId, monto: 75000, vigencia_hasta: '2026-12-31' });
    expect(res.status).toBe(201);
    expect(res.body.estado).toBe('activo');
    apartadoIdsCreados.push(res.body.id);

    const { rows } = await db.pool.query('SELECT estatus_venta FROM lotes WHERE id = $1', [loteId]);
    expect(rows[0].estatus_venta).toBe('apartado');
  });

  it('un segundo apartado activo sobre el MISMO lote es rechazado con 400 (pre-check de aplicación, respaldado por el índice único parcial en DB)', async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/apartados`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ lote_id: loteId, comprador_id: compradorId, monto: 10000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/apartado activo/i);

    // Verdad independiente: solo debe existir 1 fila activa para este lote.
    const { rows } = await db.pool.query(
      "SELECT COUNT(*)::int AS n FROM apartados WHERE lote_id = $1 AND estado = 'activo'", [loteId]
    );
    expect(rows[0].n).toBe(1);
  });

  it('cancela el apartado y deriva lotes.estatus_venta de vuelta a "disponible" (verificado con query directa)', async () => {
    const apartadoId = apartadoIdsCreados[0];
    const res = await request(app)
      .put(`/api/projects/${testProjectId}/apartados/${apartadoId}/cancelar`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('cancelado');

    const { rows: apartadoRows } = await db.pool.query('SELECT estado FROM apartados WHERE id = $1', [apartadoId]);
    expect(apartadoRows[0].estado).toBe('cancelado');

    const { rows: loteRows } = await db.pool.query('SELECT estatus_venta FROM lotes WHERE id = $1', [loteId]);
    expect(loteRows[0].estatus_venta).toBe('disponible');
  });

  it('cancelar un apartado que ya no está activo devuelve 400', async () => {
    const apartadoId = apartadoIdsCreados[0];
    const res = await request(app)
      .put(`/api/projects/${testProjectId}/apartados/${apartadoId}/cancelar`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it('tras cancelar, el lote vuelve a admitir un apartado nuevo (índice único parcial libera el slot)', async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/apartados`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ lote_id: loteId, comprador_id: compradorId, monto: 90000 });
    expect(res.status).toBe(201);
    apartadoIdsCreados.push(res.body.id);

    const { rows } = await db.pool.query('SELECT estatus_venta FROM lotes WHERE id = $1', [loteId]);
    expect(rows[0].estatus_venta).toBe('apartado');
  });
});

describe('PUT /api/projects/:id/lotes/:loteId — estatus_venta ya no es editable directamente', () => {
  let loteId;

  beforeAll(async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/lotes`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ numero_lote: `QA-NOEDIT-${Date.now()}` });
    loteId = res.body.id;
    loteIdsCreados.push(loteId);
  });

  it('el PUT ignora estatus_venta si el cliente lo manda — nunca lo escribe', async () => {
    const res = await request(app)
      .put(`/api/projects/${testProjectId}/lotes/${loteId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ estatus_venta: 'vendido' });
    expect(res.status).toBe(200);
    expect(res.body.estatus_venta).toBe('no_disponible'); // sin cambio, pese al intento

    const { rows } = await db.pool.query('SELECT estatus_venta FROM lotes WHERE id = $1', [loteId]);
    expect(rows[0].estatus_venta).toBe('no_disponible');
  });
});
