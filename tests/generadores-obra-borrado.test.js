// Integration test para prompt-generadores-obra-ui-borrado.md — borrado
// (soft-delete) de un generador de obra completo.
//
// Reglas de negocio bajo prueba:
// - Borrador: cualquier usuario con puede_eliminar=true en la sección
//   'generadores_obra' (permisos_usuario) puede borrarlo, para las obras a
//   las que tiene acceso.
// - Enviada/Aprobada/Rechazada: SOLO admin/desarrollador pueden borrarlo,
//   aunque el usuario tenga puede_eliminar=true (regla de estatus, no de
//   permiso granular — vive en el handler, no en checkPermiso).
// - Nunca DELETE físico: la fila sigue en la tabla con activo=false.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let adminToken;
let residenteId, residenteToken;
let testProjectId;
const generadorIds = [];
const stamp = Date.now();
const residenteUsuario = `qa_genobra_del_${stamp}`;
const residentePassword = 'QaGenObraDelTemp123!';

async function login(usuario, password) {
  const res = await request(app).post('/api/auth/login').send({ usuario, password });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`Login falló para ${usuario}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

async function crearGenerador(token, periodo) {
  const res = await request(app)
    .post(`/api/projects/${testProjectId}/generadores-obra`)
    .set('Authorization', `Bearer ${token}`)
    .send(periodo);
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

  const createRes = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA GenObra Borrado', usuario: residenteUsuario, password: residentePassword, puesto: 'residente' });
  if (createRes.status !== 201 && createRes.status !== 200) {
    throw new Error(`No se pudo crear el residente temporal: ${createRes.status} ${JSON.stringify(createRes.body)}`);
  }
  residenteId = createRes.body.id;

  const asignaRes = await request(app)
    .put(`/api/usuarios/${residenteId}/proyectos`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ project_ids: [testProjectId] });
  if (asignaRes.status !== 200) throw new Error(`No se pudo asignar la obra: ${asignaRes.status} ${JSON.stringify(asignaRes.body)}`);

  residenteToken = await login(residenteUsuario, residentePassword);
}, 30000);

afterAll(async () => {
  for (const gid of generadorIds) {
    await db.pool.query('DELETE FROM generador_obra_renglones WHERE generador_id = $1', [gid]);
    await db.pool.query('DELETE FROM generadores_obra WHERE id = $1', [gid]);
  }
  if (residenteId) await request(app).delete(`/api/usuarios/${residenteId}`).set('Authorization', `Bearer ${adminToken}`);
  await db.pool.end();
});

describe('Borrar en estatus Borrador — permiso granular decide', () => {
  it('residente con puede_eliminar=true (default) borra su propio generador en Borrador', async () => {
    const gen = await crearGenerador(residenteToken, { periodo_inicio: '2030-07-01', periodo_fin: '2030-07-07' });
    const res = await request(app)
      .delete(`/api/projects/${testProjectId}/generadores-obra/${gen.id}`)
      .set('Authorization', `Bearer ${residenteToken}`);
    expect(res.status).toBe(200);

    const { rows } = await db.pool.query('SELECT activo FROM generadores_obra WHERE id = $1', [gen.id]);
    expect(rows[0].activo).toBe(false);

    const listado = await request(app)
      .get(`/api/projects/${testProjectId}/generadores-obra`)
      .set('Authorization', `Bearer ${residenteToken}`);
    expect(listado.body.some((g) => g.id === gen.id)).toBe(false);
  });

  it('revocar puede_eliminar produce 403 real al intentar borrar, aun en Borrador', async () => {
    const gen = await crearGenerador(residenteToken, { periodo_inicio: '2030-07-08', periodo_fin: '2030-07-14' });
    const putRes = await request(app)
      .put(`/api/permisos/${residenteId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ proyecto_id: null, permisos: [{ seccion: 'generadores_obra', puede_ver: true, puede_crear: true, puede_editar: true, puede_eliminar: false }] });
    expect(putRes.status).toBe(200);

    const res = await request(app)
      .delete(`/api/projects/${testProjectId}/generadores-obra/${gen.id}`)
      .set('Authorization', `Bearer ${residenteToken}`);
    expect(res.status).toBe(403);

    // Restaura el default para el resto de la suite.
    await request(app)
      .put(`/api/permisos/${residenteId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ proyecto_id: null, permisos: [{ seccion: 'generadores_obra', puede_ver: true, puede_crear: true, puede_editar: true, puede_eliminar: true }] });
  });
});

describe('Borrar fuera de Borrador — solo admin/desarrollador, sin importar el permiso granular', () => {
  it('residente con puede_eliminar=true recibe 403 al intentar borrar en Enviada', async () => {
    const gen = await crearGenerador(residenteToken, { periodo_inicio: '2030-07-15', periodo_fin: '2030-07-21' });
    const conRenglon = await request(app)
      .post(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/renglones`)
      .set('Authorization', `Bearer ${residenteToken}`)
      .send({ concepto_id: (await db.pool.query(
        `SELECT id FROM conceptos WHERE project_id = $1 AND es_total = 0 AND activo = 1 AND cantidad > 0 AND TRIM(COALESCE(unidad, '')) <> '' LIMIT 1`,
        [testProjectId]
      )).rows[0].id, largo: 1 });
    expect(conRenglon.status).toBe(201);

    const enviar = await request(app)
      .put(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/estado`)
      .set('Authorization', `Bearer ${residenteToken}`)
      .send({ estado: 'enviada' });
    expect(enviar.status).toBe(200);

    const del = await request(app)
      .delete(`/api/projects/${testProjectId}/generadores-obra/${gen.id}`)
      .set('Authorization', `Bearer ${residenteToken}`);
    expect(del.status).toBe(403);

    const { rows } = await db.pool.query('SELECT activo FROM generadores_obra WHERE id = $1', [gen.id]);
    expect(rows[0].activo).toBe(true);
  });

  it('admin SÍ puede borrar un generador en Enviada (soft-delete, no físico)', async () => {
    const gen = await crearGenerador(residenteToken, { periodo_inicio: '2030-07-22', periodo_fin: '2030-07-28' });
    const conceptoId = (await db.pool.query(
      `SELECT id FROM conceptos WHERE project_id = $1 AND es_total = 0 AND activo = 1 AND cantidad > 0 AND TRIM(COALESCE(unidad, '')) <> '' LIMIT 1`,
      [testProjectId]
    )).rows[0].id;
    await request(app)
      .post(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/renglones`)
      .set('Authorization', `Bearer ${residenteToken}`)
      .send({ concepto_id: conceptoId, largo: 1 });
    await request(app)
      .put(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/estado`)
      .set('Authorization', `Bearer ${residenteToken}`)
      .send({ estado: 'enviada' });

    const del = await request(app)
      .delete(`/api/projects/${testProjectId}/generadores-obra/${gen.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(del.status).toBe(200);

    const { rows } = await db.pool.query('SELECT activo, estado FROM generadores_obra WHERE id = $1', [gen.id]);
    expect(rows[0].activo).toBe(false);
    expect(rows[0].estado).toBe('enviada');
  });

  it('borrar un id inexistente/ajeno devuelve 404, no 403 ni 500', async () => {
    const res = await request(app)
      .delete(`/api/projects/${testProjectId}/generadores-obra/999999999`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});
