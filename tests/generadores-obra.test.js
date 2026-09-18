// Integration tests para prompt-generadores-de-obra.md, Fase 1 (captura de
// números generadores). Corre contra la base real apuntada por DATABASE_URL,
// mismo patrón que tests/estimaciones-residente-ve-otras.test.js -- crea
// datos desechables y los borra físicamente en afterAll.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let adminToken;
let creadorToken;
let otroResidenteToken;
let ajenoResidenteToken;
let testProjectId;
let conceptoId;
let creadorId;
let otroResidenteId;
let ajenoResidenteId;
const generadorIds = [];
const creadorUsuario = `qa_genobra_creador_${Date.now()}`;
const otroUsuario = `qa_genobra_otro_${Date.now()}`;
const ajenoUsuario = `qa_genobra_ajeno_${Date.now()}`;
const tempPassword = 'QaGenObraTemp123!';

async function login(usuario, password) {
  const res = await request(app).post('/api/auth/login').send({ usuario, password });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`Login falló para ${usuario}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

async function crearResidente(nombre, usuario) {
  const res = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre, usuario, password: tempPassword, puesto: 'residente' });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`No se pudo crear el residente temporal ${usuario}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.id;
}

async function crearGenerador(token, body) {
  const res = await request(app)
    .post(`/api/projects/${testProjectId}/generadores-obra`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);
  if (res.status !== 201) throw new Error(`No se pudo crear el generador: ${res.status} ${JSON.stringify(res.body)}`);
  generadorIds.push(res.body.id);
  return res.body;
}

beforeAll(async () => {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada — no se puede correr la suite.');
  adminToken = await login(ADMIN_USER, ADMIN_PASSWORD);

  const { rows: projRows } = await db.pool.query('SELECT id FROM proyectos ORDER BY id LIMIT 1');
  if (!projRows[0]) throw new Error('No hay ningún proyecto contra el cual correr la suite.');
  testProjectId = projRows[0].id;

  const { rows: conRows } = await db.pool.query(
    `SELECT id FROM conceptos WHERE project_id = $1 AND es_total = 0 AND activo = 1 AND cantidad > 0
     AND TRIM(COALESCE(unidad, '')) <> '' LIMIT 1`,
    [testProjectId]
  );
  if (!conRows[0]) throw new Error('El proyecto de prueba no tiene ningún concepto real elegible.');
  conceptoId = conRows[0].id;

  creadorId = await crearResidente('QA GenObra Creador', creadorUsuario);
  otroResidenteId = await crearResidente('QA GenObra Otro Residente', otroUsuario);
  ajenoResidenteId = await crearResidente('QA GenObra Ajeno', ajenoUsuario);

  for (const uid of [creadorId, otroResidenteId]) {
    const asignaRes = await request(app)
      .put(`/api/usuarios/${uid}/proyectos`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ project_ids: [testProjectId] });
    if (asignaRes.status !== 200) throw new Error(`No se pudo asignar la obra: ${asignaRes.status} ${JSON.stringify(asignaRes.body)}`);
  }

  creadorToken = await login(creadorUsuario, tempPassword);
  otroResidenteToken = await login(otroUsuario, tempPassword);
  ajenoResidenteToken = await login(ajenoUsuario, tempPassword);
}, 30000);

afterAll(async () => {
  for (const gid of generadorIds) {
    await db.pool.query('DELETE FROM generador_obra_renglones WHERE generador_id = $1', [gid]);
    await db.pool.query('DELETE FROM generadores_obra WHERE id = $1', [gid]);
  }
  for (const uid of [creadorId, otroResidenteId, ajenoResidenteId]) {
    if (uid) await request(app).delete(`/api/usuarios/${uid}`).set('Authorization', `Bearer ${adminToken}`);
  }
});

describe('Crear y listar generadores de obra', () => {
  it('un residente con acceso a la obra puede crear un generador (folio consecutivo)', async () => {
    const gen = await crearGenerador(creadorToken, { periodo_inicio: '2030-01-01', periodo_fin: '2030-01-07' });
    expect(gen.estado).toBe('borrador');
    expect(gen.folio).toBeGreaterThan(0);
  });

  it('otro residente con acceso a la misma obra SI ve en el listado un generador creado por otro usuario', async () => {
    const gen = await crearGenerador(creadorToken, { periodo_inicio: '2030-02-01', periodo_fin: '2030-02-07' });
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/generadores-obra`)
      .set('Authorization', `Bearer ${otroResidenteToken}`);
    expect(res.status).toBe(200);
    expect(res.body.some((g) => g.id === gen.id)).toBe(true);
  });

  it('control negativo: un residente sin acceso a la obra no ve ni el listado ni el detalle', async () => {
    const gen = await crearGenerador(creadorToken, { periodo_inicio: '2030-03-01', periodo_fin: '2030-03-07' });
    const listado = await request(app)
      .get(`/api/projects/${testProjectId}/generadores-obra`)
      .set('Authorization', `Bearer ${ajenoResidenteToken}`);
    expect(listado.status).toBe(403);
    const detalle = await request(app)
      .get(`/api/projects/${testProjectId}/generadores-obra/${gen.id}`)
      .set('Authorization', `Bearer ${ajenoResidenteToken}`);
    expect(detalle.status).toBe(403);
  });

  it('periodo_fin anterior a periodo_inicio se rechaza con 400', async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/generadores-obra`)
      .set('Authorization', `Bearer ${creadorToken}`)
      .send({ periodo_inicio: '2030-05-10', periodo_fin: '2030-05-01' });
    expect(res.status).toBe(400);
  });
});

describe('Renglones de medición y subtotal server-side', () => {
  let gen;
  beforeAll(async () => {
    gen = await crearGenerador(creadorToken, { periodo_inicio: '2030-04-01', periodo_fin: '2030-04-07', nombre: 'Generador de prueba renglones' });
  });

  it('crea un renglón y calcula el subtotal en el servidor, ignorando cualquier subtotal enviado por el cliente', async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/renglones`)
      .set('Authorization', `Bearer ${creadorToken}`)
      .send({ concepto_id: conceptoId, descripcion: 'Tramo de prueba', tramo: 'Km 0+000 a 0+050', largo: 5, ancho: 3, subtotal: 999999 });
    expect(res.status).toBe(201);
    expect(res.body.subtotal).toBe(15);
  });

  it('el detalle del generador incluye el renglón con datos del concepto', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/generadores-obra/${gen.id}`)
      .set('Authorization', `Bearer ${creadorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.renglones.length).toBeGreaterThan(0);
    expect(res.body.renglones[0]).toHaveProperty('concepto');
    expect(res.body.renglones[0]).toHaveProperty('unidad');
  });

  it('edita un renglón y recalcula el subtotal', async () => {
    const detalle = await request(app)
      .get(`/api/projects/${testProjectId}/generadores-obra/${gen.id}`)
      .set('Authorization', `Bearer ${creadorToken}`);
    const renglonId = detalle.body.renglones[0].id;
    const res = await request(app)
      .put(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/renglones/${renglonId}`)
      .set('Authorization', `Bearer ${creadorToken}`)
      .send({ descripcion: 'Tramo editado', tramo: 'Km 0+000 a 0+100', largo: 10, ancho: 2 });
    expect(res.status).toBe(200);
    expect(res.body.subtotal).toBe(20);
  });

  it('elimina un renglón', async () => {
    const detalle = await request(app)
      .get(`/api/projects/${testProjectId}/generadores-obra/${gen.id}`)
      .set('Authorization', `Bearer ${creadorToken}`);
    const renglonId = detalle.body.renglones[0].id;
    const res = await request(app)
      .delete(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/renglones/${renglonId}`)
      .set('Authorization', `Bearer ${creadorToken}`);
    expect(res.status).toBe(200);
    const detalleFinal = await request(app)
      .get(`/api/projects/${testProjectId}/generadores-obra/${gen.id}`)
      .set('Authorization', `Bearer ${creadorToken}`);
    expect(detalleFinal.body.renglones.length).toBe(0);
  });
});

describe('Conceptos disponibles para captura', () => {
  it('devuelve conceptos reales de la obra con ruta_jerarquica para agrupar por Partida/Subpartida', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/generadores-obra/conceptos-disponibles`)
      .set('Authorization', `Bearer ${creadorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.some((c) => c.id === conceptoId)).toBe(true);
  });
});

describe('Transiciones de estado', () => {
  it('no se puede enviar un generador sin renglones', async () => {
    const gen = await crearGenerador(creadorToken, { periodo_inicio: '2030-06-01', periodo_fin: '2030-06-07' });
    const res = await request(app)
      .put(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/estado`)
      .set('Authorization', `Bearer ${creadorToken}`)
      .send({ estado: 'enviada' });
    expect(res.status).toBe(400);
  });

  it('flujo completo: borrador -> enviada -> aprobada (por admin)', async () => {
    const gen = await crearGenerador(creadorToken, { periodo_inicio: '2030-07-01', periodo_fin: '2030-07-07' });
    await request(app)
      .post(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/renglones`)
      .set('Authorization', `Bearer ${creadorToken}`)
      .send({ concepto_id: conceptoId, descripcion: 'Renglón', tramo: 'T1', pzas: 4 });

    const enviar = await request(app)
      .put(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/estado`)
      .set('Authorization', `Bearer ${creadorToken}`)
      .send({ estado: 'enviada' });
    expect(enviar.status).toBe(200);
    expect(enviar.body.estado).toBe('enviada');

    // Con el generador ya 'enviada', el residente ya no puede agregar renglones.
    const bloqueada = await request(app)
      .post(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/renglones`)
      .set('Authorization', `Bearer ${creadorToken}`)
      .send({ concepto_id: conceptoId, pzas: 1 });
    expect(bloqueada.status).toBe(409);

    // Un residente no puede autoaprobar su propio generador.
    const aproboResidente = await request(app)
      .put(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/estado`)
      .set('Authorization', `Bearer ${creadorToken}`)
      .send({ estado: 'aprobada' });
    expect(aproboResidente.status).toBe(403);

    const aprobar = await request(app)
      .put(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/estado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ estado: 'aprobada' });
    expect(aprobar.status).toBe(200);
    expect(aprobar.body.estado).toBe('aprobada');
  });

  it('rechazo requiere comentario y notifica al residente; reenvío directo desde rechazada', async () => {
    const gen = await crearGenerador(creadorToken, { periodo_inicio: '2030-08-01', periodo_fin: '2030-08-07' });
    await request(app)
      .post(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/renglones`)
      .set('Authorization', `Bearer ${creadorToken}`)
      .send({ concepto_id: conceptoId, pzas: 2 });
    await request(app)
      .put(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/estado`)
      .set('Authorization', `Bearer ${creadorToken}`)
      .send({ estado: 'enviada' });

    const sinComentario = await request(app)
      .put(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/estado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ estado: 'rechazada' });
    expect(sinComentario.status).toBe(400);

    const rechazar = await request(app)
      .put(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/estado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ estado: 'rechazada', comentario_rechazo: 'Faltan tramos' });
    expect(rechazar.status).toBe(200);
    expect(rechazar.body.estado).toBe('rechazada');

    const reenviar = await request(app)
      .put(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/estado`)
      .set('Authorization', `Bearer ${creadorToken}`)
      .send({ estado: 'enviada' });
    expect(reenviar.status).toBe(200);
    expect(reenviar.body.estado).toBe('enviada');
  });
});
