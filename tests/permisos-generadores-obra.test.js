// Integration test para prompt-permisos-generadores-obra.md.
//
// 'generadores_obra' pasa de sección "informativa" (auth.allow('residente')
// sin checkPermiso, acceso total sin restricción) a enforcement real, mismo
// patrón que otras secciones granulares (checkPermiso en server/app.js,
// TAB_A_SECCION en server/auth.js). Cubre:
// - Defaults de un residente nuevo (puede_ver/crear/editar/eliminar=true,
//   preserva la capacidad completa que ya tenía).
// - Enforcement real: revocar puede_ver produce 403 en el endpoint real de
//   datos, no solo en la UI.
// - El bug encontrado en Fase 0 (diagnóstico): sin 'generadoresObra' en
//   TAB_A_SECCION, GET /nav-tabs nunca incluía el tab para residente aunque
//   tuviera puede_ver=true — el tab se veía al login (ROLE_TABS estático) y
//   desaparecía al seleccionar una obra.
// - admin conserva bypass total, sin depender de permisos_usuario.
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
const residenteUsuario = `qa_permgenobra_res_${stamp}`;
const residentePassword = 'QaPermGenObraTemp123!';

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
  if (!projRows[0]) throw new Error('No hay ningún proyecto contra el cual correr la suite.');
  testProjectId = projRows[0].id;

  const createRes = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA Perm GenObra Residente', usuario: residenteUsuario, password: residentePassword, puesto: 'residente' });
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

describe('Defaults de un residente nuevo en generadores_obra', () => {
  it('nace con puede_ver/crear/editar/eliminar=true (preserva la capacidad completa previa)', async () => {
    const res = await request(app)
      .get('/api/mis-permisos/generadores_obra')
      .set('Authorization', `Bearer ${residenteToken}`);
    expect(res.status).toBe(200);
    expect(res.body.puede_ver).toBe(true);
    expect(res.body.puede_crear).toBe(true);
    expect(res.body.puede_editar).toBe(true);
    expect(res.body.puede_eliminar).toBe(true);
  });
});

describe('Enforcement real de checkPermiso en los endpoints de datos', () => {
  it('con los defaults, el residente puede listar y crear (200/201, no informativo)', async () => {
    const listado = await request(app)
      .get(`/api/projects/${testProjectId}/generadores-obra`)
      .set('Authorization', `Bearer ${residenteToken}`);
    expect(listado.status).toBe(200);

    const crea = await request(app)
      .post(`/api/projects/${testProjectId}/generadores-obra`)
      .set('Authorization', `Bearer ${residenteToken}`)
      .send({ periodo_inicio: '2030-06-01', periodo_fin: '2030-06-07' });
    expect(crea.status).toBe(201);
    generadorIds.push(crea.body.id);
  });

  it('revocar puede_ver produce 403 real en GET /generadores-obra (ya no es informativo)', async () => {
    const putRes = await request(app)
      .put(`/api/permisos/${residenteId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ proyecto_id: null, permisos: [{ seccion: 'generadores_obra', puede_ver: false, puede_crear: false, puede_editar: false, puede_eliminar: false }] });
    expect(putRes.status).toBe(200);

    const res = await request(app)
      .get(`/api/projects/${testProjectId}/generadores-obra`)
      .set('Authorization', `Bearer ${residenteToken}`);
    expect(res.status).toBe(403);
  });

  it('restaurar puede_ver=true vuelve a dar 200 (el gate reacciona al vuelo, no solo al alta)', async () => {
    const putRes = await request(app)
      .put(`/api/permisos/${residenteId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ proyecto_id: null, permisos: [{ seccion: 'generadores_obra', puede_ver: true, puede_crear: true, puede_editar: true, puede_eliminar: true }] });
    expect(putRes.status).toBe(200);

    const res = await request(app)
      .get(`/api/projects/${testProjectId}/generadores-obra`)
      .set('Authorization', `Bearer ${residenteToken}`);
    expect(res.status).toBe(200);
  });
});

describe('GET /nav-tabs — bug de Fase 0 (tab desaparecía al seleccionar obra)', () => {
  it('con puede_ver=true, el tab generadoresObra SÍ aparece en /nav-tabs', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/nav-tabs`)
      .set('Authorization', `Bearer ${residenteToken}`);
    expect(res.status).toBe(200);
    expect(res.body.tabs).toContain('generadoresObra');
  });

  it('con puede_ver=false, el tab generadoresObra NO aparece en /nav-tabs', async () => {
    const putRes = await request(app)
      .put(`/api/permisos/${residenteId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ proyecto_id: null, permisos: [{ seccion: 'generadores_obra', puede_ver: false }] });
    expect(putRes.status).toBe(200);

    const res = await request(app)
      .get(`/api/projects/${testProjectId}/nav-tabs`)
      .set('Authorization', `Bearer ${residenteToken}`);
    expect(res.status).toBe(200);
    expect(res.body.tabs).not.toContain('generadoresObra');

    // Deja al residente en el estado esperado por defecto para no afectar
    // otros asserts si se reordena la suite.
    await request(app)
      .put(`/api/permisos/${residenteId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ proyecto_id: null, permisos: [{ seccion: 'generadores_obra', puede_ver: true, puede_crear: true, puede_editar: true, puede_eliminar: true }] });
  });
});

describe('admin conserva bypass total', () => {
  it('admin accede sin depender de ninguna fila en permisos_usuario', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/generadores-obra`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).not.toBe(403);
  });
});
