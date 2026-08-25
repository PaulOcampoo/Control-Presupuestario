// Integration test para la Fase 3 del roadmap "Desarrollador de Vivienda"
// (prompt-implementacion-catalogo-comercial.md, diagnóstico previo en
// prompt-diagnostico-catalogo-comercial.md): catálogo comercial de modelos de
// vivienda + precio_lista_override/estatus_venta en lotes. Mismo patrón
// autocontenido de tests/infra-vivienda.test.js (usuario 'residente' temporal,
// asignado a una obra real vía usuario_proyectos).
//
// No existe endpoint DELETE para lotes (solo GET/POST/PUT) — los lotes de
// prueba que este archivo crea se borran físicamente vía SQL directo en
// afterAll, mismo criterio que "Limpieza de datos de prueba" (ver CLAUDE.md):
// siempre borrado físico, nunca marcar/dejar residuos, incluso si no hay
// endpoint DELETE dedicado.
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
const tempUsuario = `qa_modvivienda_${Date.now()}`;
const tempPassword = 'QaModVivienda123!';

const loteIdsCreados = []; // limpieza física garantizada en afterAll
const modeloIdsCreados = []; // solo informativo (soft-delete, no se borran físicamente)

async function login(usuario, password) {
  const res = await request(app).post('/api/auth/login').send({ usuario, password });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`Login falló para ${usuario}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

async function setPermisoModelosVivienda(usuarioId, { puedeVer } = {}) {
  const permiso = { seccion: 'modelos_vivienda' };
  if (puedeVer !== undefined) permiso.puede_ver = puedeVer;
  const res = await request(app)
    .put(`/api/permisos/${usuarioId}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ proyecto_id: null, permisos: [permiso] });
  if (res.status !== 200) {
    throw new Error(`No se pudo setear el permiso: ${res.status} ${JSON.stringify(res.body)}`);
  }
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
    .send({ nombre: 'QA Modelos Vivienda', usuario: tempUsuario, password: tempPassword, puesto: 'residente' });
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
    await db.pool.query('DELETE FROM lotes WHERE id = ANY($1::int[])', [loteIdsCreados]);
    const { rows: remanentesLotes } = await db.pool.query('SELECT id FROM lotes WHERE id = ANY($1::int[])', [loteIdsCreados]);
    if (remanentesLotes.length !== 0) throw new Error('Limpieza incompleta: quedaron lotes de prueba.');
  }
  // modelos_vivienda es soft-delete por diseño (Forbidden Action explícita del
  // prompt: nunca DELETE físico desde la app) — pero los de ESTA suite sí se
  // borran físicamente en la limpieza de prueba, igual que cualquier otro dato
  // de prueba (la regla de soft-delete es para el comportamiento de la app en
  // uso normal, no una excepción a "limpieza física obligatoria" de datos QA).
  if (modeloIdsCreados.length) {
    await db.pool.query('DELETE FROM modelos_vivienda WHERE id = ANY($1::int[])', [modeloIdsCreados]);
    const { rows: remanentesModelos } = await db.pool.query('SELECT id FROM modelos_vivienda WHERE id = ANY($1::int[])', [modeloIdsCreados]);
    if (remanentesModelos.length !== 0) throw new Error('Limpieza incompleta: quedaron modelos de vivienda de prueba.');
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

describe('GET /api/projects/:id/modelos-vivienda', () => {
  it('requiere autenticación', async () => {
    const res = await request(app).get(`/api/projects/${testProjectId}/modelos-vivienda`);
    expect(res.status).toBe(401);
  });

  it('residente sin modelos_vivienda.puede_ver recibe 403 real (checkPermiso)', async () => {
    await setPermisoModelosVivienda(tempUserId, { puedeVer: false });
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/modelos-vivienda`)
      .set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(403);
  });

  it('residente CON modelos_vivienda.puede_ver accede (200)', async () => {
    await setPermisoModelosVivienda(tempUserId, { puedeVer: true });
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/modelos-vivienda`)
      .set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('admin mantiene acceso total sin depender de permisos_usuario', async () => {
    await setPermisoModelosVivienda(tempUserId, { puedeVer: false });
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/modelos-vivienda`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });
});

describe('POST /api/projects/:id/modelos-vivienda (admin/desarrollador exclusivo)', () => {
  it('requiere autenticación', async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/modelos-vivienda`)
      .send({ nombre: 'QA Modelo X' });
    expect(res.status).toBe(401);
  });

  it('residente recibe 403 aunque tenga modelos_vivienda.puede_ver=true (gate de ruta, no de permisos_usuario)', async () => {
    await setPermisoModelosVivienda(tempUserId, { puedeVer: true });
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/modelos-vivienda`)
      .set('Authorization', `Bearer ${tempToken}`)
      .send({ nombre: 'QA Modelo Residente' });
    expect(res.status).toBe(403);
  });

  it('rechaza sin nombre con 400', async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/modelos-vivienda`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ descripcion: 'sin nombre' });
    expect(res.status).toBe(400);
  });

  it('admin crea un modelo con todos los campos y lo persiste correctamente', async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/modelos-vivienda`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        nombre: `QA Modelo A ${Date.now()}`,
        descripcion: 'Modelo de prueba',
        superficie_construida_m2: 85.5,
        superficie_terreno_m2: 120,
        recamaras: 3,
        banos: 2.5,
        niveles: 2,
        precio_lista: 1500000,
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.precio_lista).toBe(1500000);
    expect(res.body.banos).toBe(2.5);
    expect(res.body.activo).toBe(true);
    modeloIdsCreados.push(res.body.id);

    const { rows } = await db.pool.query('SELECT * FROM modelos_vivienda WHERE id = $1', [res.body.id]);
    expect(rows[0].project_id).toBe(testProjectId);
    expect(rows[0].nombre).toBe(res.body.nombre);
  });

  it('rechaza un nombre duplicado en la misma obra con 409', async () => {
    const nombre = `QA Modelo Dup ${Date.now()}`;
    const r1 = await request(app)
      .post(`/api/projects/${testProjectId}/modelos-vivienda`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre });
    expect(r1.status).toBe(201);
    modeloIdsCreados.push(r1.body.id);

    const r2 = await request(app)
      .post(`/api/projects/${testProjectId}/modelos-vivienda`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre });
    expect(r2.status).toBe(409);
  });
});

describe('PUT /api/projects/:id/modelos-vivienda/:modeloId', () => {
  let modeloId;

  beforeAll(async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/modelos-vivienda`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: `QA Modelo Editable ${Date.now()}`, precio_lista: 1000000 });
    modeloId = res.body.id;
    modeloIdsCreados.push(modeloId);
  });

  it('residente recibe 403', async () => {
    const res = await request(app)
      .put(`/api/projects/${testProjectId}/modelos-vivienda/${modeloId}`)
      .set('Authorization', `Bearer ${tempToken}`)
      .send({ precio_lista: 999999 });
    expect(res.status).toBe(403);
  });

  it('admin edita el precio de lista y se refleja en GET', async () => {
    const res = await request(app)
      .put(`/api/projects/${testProjectId}/modelos-vivienda/${modeloId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ precio_lista: 1750000 });
    expect(res.status).toBe(200);
    expect(res.body.precio_lista).toBe(1750000);

    const getRes = await request(app)
      .get(`/api/projects/${testProjectId}/modelos-vivienda`)
      .set('Authorization', `Bearer ${adminToken}`);
    const modelo = getRes.body.find((m) => m.id === modeloId);
    expect(modelo.precio_lista).toBe(1750000);
  });
});

describe('DELETE /api/projects/:id/modelos-vivienda/:modeloId (soft-delete)', () => {
  let modeloId;

  beforeAll(async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/modelos-vivienda`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: `QA Modelo Borrable ${Date.now()}` });
    modeloId = res.body.id;
    modeloIdsCreados.push(modeloId);
  });

  it('residente recibe 403', async () => {
    const res = await request(app)
      .delete(`/api/projects/${testProjectId}/modelos-vivienda/${modeloId}`)
      .set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(403);
  });

  it('admin lo desactiva (activo=false) SIN borrarlo físicamente', async () => {
    const res = await request(app)
      .delete(`/api/projects/${testProjectId}/modelos-vivienda/${modeloId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.activo).toBe(false);

    // Verdad independiente contra la base real — la fila sigue existiendo.
    const { rows } = await db.pool.query('SELECT activo FROM modelos_vivienda WHERE id = $1', [modeloId]);
    expect(rows.length).toBe(1);
    expect(rows[0].activo).toBe(false);
  });
});

describe('Lotes: modelo_vivienda_id, precio_lista_override, estatus_venta, precio_efectivo', () => {
  let modeloId;
  const precioModelo = 2000000;

  beforeAll(async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/modelos-vivienda`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: `QA Modelo Lote ${Date.now()}`, precio_lista: precioModelo });
    modeloId = res.body.id;
    modeloIdsCreados.push(modeloId);
  });

  it('crea un lote con modelo_vivienda_id y sin override — precio_efectivo = precio del modelo', async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/lotes`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ numero_lote: `QA-${Date.now()}`, modelo_vivienda_id: modeloId });
    expect(res.status).toBe(201);
    loteIdsCreados.push(res.body.id);
    expect(res.body.estatus_venta).toBe('no_disponible');

    const listRes = await request(app)
      .get(`/api/projects/${testProjectId}/lotes`)
      .set('Authorization', `Bearer ${adminToken}`);
    const lote = listRes.body.find((l) => l.id === res.body.id);
    expect(lote.precio_efectivo).toBe(precioModelo);
    expect(lote.modelo_nombre).toBeDefined();
  });

  it('con precio_lista_override, precio_efectivo usa el override (nunca el del modelo)', async () => {
    const precioOverride = 2350000;
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/lotes`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ numero_lote: `QA-OV-${Date.now()}`, modelo_vivienda_id: modeloId, precio_lista_override: precioOverride });
    expect(res.status).toBe(201);
    loteIdsCreados.push(res.body.id);

    const listRes = await request(app)
      .get(`/api/projects/${testProjectId}/lotes`)
      .set('Authorization', `Bearer ${adminToken}`);
    const lote = listRes.body.find((l) => l.id === res.body.id);
    expect(lote.precio_efectivo).toBe(precioOverride);
  });

  it('actualizar el lote quitando el override regresa el precio_efectivo al del modelo', async () => {
    const createRes = await request(app)
      .post(`/api/projects/${testProjectId}/lotes`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ numero_lote: `QA-UPD-${Date.now()}`, modelo_vivienda_id: modeloId, precio_lista_override: 9999999 });
    loteIdsCreados.push(createRes.body.id);

    const putRes = await request(app)
      .put(`/api/projects/${testProjectId}/lotes/${createRes.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ precio_lista_override: null });
    expect(putRes.status).toBe(200);

    const listRes = await request(app)
      .get(`/api/projects/${testProjectId}/lotes`)
      .set('Authorization', `Bearer ${adminToken}`);
    const lote = listRes.body.find((l) => l.id === createRes.body.id);
    expect(lote.precio_efectivo).toBe(precioModelo);
  });

  // Fase 4 (prompt-implementacion-pr-a-compradores-apartado.md):
  // estatus_venta pasó de campo editable a campo 100% derivado — el POST/PUT
  // de lotes ya ni siquiera lo lee del body, así que un valor inválido (o
  // cualquier valor) se ignora en silencio en vez de validarse/rechazarse
  // aquí. La escritura real ahora vive solo en server/ventas.js
  // (crearApartado/cancelarApartado), cubierta en
  // tests/ventas-compradores-apartado.test.js.
  it('ignora estatus_venta si el cliente lo manda en el POST — nunca lo escribe, el lote nace no_disponible', async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/lotes`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ numero_lote: `QA-BAD-${Date.now()}`, estatus_venta: 'reservado_ilegal' });
    expect(res.status).toBe(201);
    loteIdsCreados.push(res.body.id);
    expect(res.body.estatus_venta).toBe('no_disponible');
  });

  it('rechaza un modelo_vivienda_id que pertenece a OTRA obra con 400 (sin mezclar modelos entre proyectos)', async () => {
    const res = await request(app)
      .post(`/api/projects/${otroProjectId}/lotes`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ numero_lote: `QA-CROSS-${Date.now()}`, modelo_vivienda_id: modeloId });
    expect(res.status).toBe(400);
    if (res.body && res.body.id) loteIdsCreados.push(res.body.id); // red de seguridad, no debería haberse creado
  });
});
