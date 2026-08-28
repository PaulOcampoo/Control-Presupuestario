// Integration test para prompt-limpieza-permisos-cabo.md.
//
// Fase 0 (backfill de permisos_usuario para el usuario real Emonico) corre
// aparte, directo en producción — no aplica aquí, esta suite corre contra
// Preview (DATABASE_URL de .env), mismo patrón que el resto de tests/*.
//
// Cambio de dirección confirmado por Paul (revierte una iteración anterior
// de este mismo prompt):
// - cabo nace con nominas.puede_ver=true y trabajadores.puede_ver=true por
//   default (ya NO default-deny caso por caso) — el scope real de qué
//   trabajadores/obras ve lo sigue dando verificarAccesoObra/
//   usuario_proyectos, verificado aparte abajo.
// - "Dar de baja" a un trabajador queda bloqueada para cabo a nivel de ruta
//   (auth.allow() sin 'cabo'), independiente de puede_editar.
//
// Fase 2 (separada de lo anterior, sigue tal cual): GET/POST
// /maquinaria/mantenimientos y GET /maquinaria/bitacora-taller (mismo dato)
// pasaron de checkPermiso('maquinaria', ...) a su propia sección
// 'maquinaria_mantenimiento' — YA NO comparten permiso con
// 'maquinaria_combustible' (antes CN-002 las fusionaba, lo que hacía que
// otorgar solo combustible heredara también mantenimiento). cabo pierde
// ambos por default; residente/jefe_maquinaria conservan ambos (defaults
// nuevos explícitos).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let adminToken;
let tempUserId, tempToken;
let residenteId, residenteToken;
let jefeMaqId, jefeMaqToken;
let testProjectId, otherProjectId;
let testWorkerId;
const stamp = Date.now();
const tempUsuario = `qa_permisos_cabo_${stamp}`;
const tempPassword = 'QaPermisosCaboTemp123!';
const residenteUsuario = `qa_permisos_res_${stamp}`;
const residentePassword = 'QaPermisosResTemp123!';
const jefeMaqUsuario = `qa_permisos_jefemaq_${stamp}`;
const jefeMaqPassword = 'QaPermisosJefeMaqTemp123!';

async function login(usuario, password) {
  const res = await request(app).post('/api/auth/login').send({ usuario, password });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`Login falló para ${usuario}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

async function crearUsuarioTemporal(nombre, usuario, password, puesto) {
  const createRes = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre, usuario, password, puesto });
  if (createRes.status !== 201 && createRes.status !== 200) {
    throw new Error(`No se pudo crear ${usuario}: ${createRes.status} ${JSON.stringify(createRes.body)}`);
  }
  return createRes.body.id;
}

beforeAll(async () => {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada — no se puede correr la suite de integración.');
  adminToken = await login(ADMIN_USER, ADMIN_PASSWORD);

  const { rows: proyectos } = await db.pool.query('SELECT id FROM proyectos ORDER BY id LIMIT 2');
  if (proyectos.length < 2) throw new Error('Se necesitan al menos 2 proyectos en la base para probar el scoping por obra.');
  testProjectId = proyectos[0].id;
  otherProjectId = proyectos[1].id;

  tempUserId = await crearUsuarioTemporal('QA Permisos Cabo', tempUsuario, tempPassword, 'cabo');
  tempToken = await login(tempUsuario, tempPassword);

  residenteId = await crearUsuarioTemporal('QA Permisos Residente', residenteUsuario, residentePassword, 'residente');
  residenteToken = await login(residenteUsuario, residentePassword);

  jefeMaqId = await crearUsuarioTemporal('QA Permisos Jefe Maquinaria', jefeMaqUsuario, jefeMaqPassword, 'jefe_maquinaria');
  jefeMaqToken = await login(jefeMaqUsuario, jefeMaqPassword);

  // cabo asignado SOLO a testProjectId (usuario_proyectos), para el bloque
  // de scoping por obra y para el de dar-de-baja (necesita un trabajador
  // real de esa obra).
  const asignaRes = await request(app)
    .put(`/api/usuarios/${tempUserId}/proyectos`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ project_ids: [testProjectId] });
  if (asignaRes.status !== 200) {
    throw new Error(`No se pudo asignar la obra al cabo temporal: ${asignaRes.status} ${JSON.stringify(asignaRes.body)}`);
  }

  // Trabajador temporal en testProjectId, para el bloque de "dar de baja".
  const crearTrabajadorRes = await request(app)
    .post(`/api/projects/${testProjectId}/trabajadores`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA Trabajador Baja Cabo', puesto: 'Peón', tipo_pago: 'jornal', periodicidad: 'semanal' });
  if (crearTrabajadorRes.status !== 201 && crearTrabajadorRes.status !== 200) {
    throw new Error(`No se pudo crear el trabajador temporal: ${crearTrabajadorRes.status} ${JSON.stringify(crearTrabajadorRes.body)}`);
  }
  testWorkerId = crearTrabajadorRes.body.id;
});

afterAll(async () => {
  if (testWorkerId) {
    await request(app).delete(`/api/projects/${testProjectId}/trabajadores/${testWorkerId}`).set('Authorization', `Bearer ${adminToken}`);
  }
  for (const id of [tempUserId, residenteId, jefeMaqId]) {
    if (id) await request(app).delete(`/api/usuarios/${id}`).set('Authorization', `Bearer ${adminToken}`);
  }
  await db.pool.end();
});

describe('Defaults de cabo nuevo — nominas y trabajadores puede_ver=true', () => {
  it('cabo nuevo nace con nominas.puede_ver=true (revertido, ya no es default-deny)', async () => {
    const res = await request(app)
      .get('/api/mis-permisos/nominas')
      .set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(200);
    expect(res.body.puede_ver).toBe(true);
  });

  it('cabo nuevo nace con trabajadores.puede_ver=true (revertido, ya no es default-deny)', async () => {
    const res = await request(app)
      .get('/api/mis-permisos/trabajadores')
      .set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(200);
    expect(res.body.puede_ver).toBe(true);
  });

  it('cabo nuevo sigue naciendo con puede_crear/editar/eliminar de nominas en false (solo puede_ver cambió)', async () => {
    const res = await request(app)
      .get('/api/mis-permisos/nominas')
      .set('Authorization', `Bearer ${tempToken}`);
    expect(res.body.puede_crear).toBe(false);
    expect(res.body.puede_editar).toBe(false);
    expect(res.body.puede_eliminar).toBe(false);
  });
});

describe('Scoping por obra de GET /trabajadores (verificarAccesoObra + usuario_proyectos)', () => {
  it('cabo asignado a testProjectId accede sin 403', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/trabajadores`)
      .set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).not.toBe(403);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('el mismo cabo recibe 403 en otherProjectId, a la que NO está asignado', async () => {
    const res = await request(app)
      .get(`/api/projects/${otherProjectId}/trabajadores`)
      .set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(403);
  });
});

describe('"Dar de baja" a un trabajador — bloqueada para cabo a nivel de ruta', () => {
  it('cabo recibe 403 en POST /trabajadores/:wId/baja aunque tenga trabajadores.puede_editar=true', async () => {
    const putPermisoRes = await request(app)
      .put(`/api/permisos/${tempUserId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ proyecto_id: null, permisos: [{ seccion: 'trabajadores', puede_ver: true, puede_editar: true }] });
    expect(putPermisoRes.status).toBe(200);

    const res = await request(app)
      .post(`/api/projects/${testProjectId}/trabajadores/${testWorkerId}/baja`)
      .set('Authorization', `Bearer ${tempToken}`)
      .send({ motivo_baja: 'otro', notas: 'intento de baja por cabo (debe fallar)' });
    expect(res.status).toBe(403);
  });

  it('residente SÍ puede dar de baja (no se le quitó nada — restricción es específica de cabo)', async () => {
    const asignaRes = await request(app)
      .put(`/api/usuarios/${residenteId}/proyectos`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ project_ids: [testProjectId] });
    expect(asignaRes.status).toBe(200);

    const res = await request(app)
      .post(`/api/projects/${testProjectId}/trabajadores/${testWorkerId}/baja`)
      .set('Authorization', `Bearer ${residenteToken}`)
      .send({ motivo_baja: 'otro', notas: 'baja real de limpieza del test' });
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
  });
});

describe('Fase 2 — maquinaria_mantenimiento separada de maquinaria_combustible', () => {
  it('cabo recibe 403 en GET /maquinaria/combustible', async () => {
    const res = await request(app).get('/api/maquinaria/combustible').set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(403);
  });

  it('cabo recibe 403 en GET /maquinaria/mantenimientos', async () => {
    const res = await request(app).get('/api/maquinaria/mantenimientos').set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(403);
  });

  it('cabo recibe 403 en GET /maquinaria/bitacora-taller (mismo dato que mantenimientos)', async () => {
    const res = await request(app).get('/api/maquinaria/bitacora-taller').set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(403);
  });

  it('cabo conserva acceso a /maquinaria/equipos y /maquinaria/horas (catálogo/horas no se tocaron)', async () => {
    const equipos = await request(app).get('/api/maquinaria/equipos').set('Authorization', `Bearer ${tempToken}`);
    expect(equipos.status).not.toBe(403);
    const horas = await request(app).get('/api/maquinaria/horas').set('Authorization', `Bearer ${tempToken}`);
    expect(horas.status).not.toBe(403);
  });

  it('otorgar SOLO maquinaria_combustible a cabo no le da acceso a maquinaria_mantenimiento (ya no heredan entre sí)', async () => {
    const putRes = await request(app)
      .put(`/api/permisos/${tempUserId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ proyecto_id: null, permisos: [{ seccion: 'maquinaria_combustible', puede_ver: true }] });
    expect(putRes.status).toBe(200);

    const combustible = await request(app).get('/api/maquinaria/combustible').set('Authorization', `Bearer ${tempToken}`);
    expect(combustible.status).not.toBe(403);

    const mantenimientos = await request(app).get('/api/maquinaria/mantenimientos').set('Authorization', `Bearer ${tempToken}`);
    expect(mantenimientos.status).toBe(403);
    const bitacora = await request(app).get('/api/maquinaria/bitacora-taller').set('Authorization', `Bearer ${tempToken}`);
    expect(bitacora.status).toBe(403);
  });

  it('residente conserva acceso a combustible Y mantenimiento (defaults nuevos explícitos, no se le revocó nada)', async () => {
    const combustible = await request(app).get('/api/maquinaria/combustible').set('Authorization', `Bearer ${residenteToken}`);
    expect(combustible.status).not.toBe(403);
    const mantenimientos = await request(app).get('/api/maquinaria/mantenimientos').set('Authorization', `Bearer ${residenteToken}`);
    expect(mantenimientos.status).not.toBe(403);
    const bitacora = await request(app).get('/api/maquinaria/bitacora-taller').set('Authorization', `Bearer ${residenteToken}`);
    expect(bitacora.status).not.toBe(403);
  });

  it('jefe_maquinaria conserva acceso a combustible Y mantenimiento, incluyendo creación', async () => {
    const combustible = await request(app).get('/api/maquinaria/combustible').set('Authorization', `Bearer ${jefeMaqToken}`);
    expect(combustible.status).not.toBe(403);
    const mantenimientos = await request(app).get('/api/maquinaria/mantenimientos').set('Authorization', `Bearer ${jefeMaqToken}`);
    expect(mantenimientos.status).not.toBe(403);

    const postRes = await request(app)
      .post('/api/maquinaria/mantenimientos')
      .set('Authorization', `Bearer ${jefeMaqToken}`)
      .send({ fecha: '2026-01-01', tipo: 'consumible', descripcion: 'QA test', costo: 0 });
    expect(postRes.status).not.toBe(403);
    if (postRes.status === 201) {
      await db.pool.query('DELETE FROM mantenimientos_maquinaria WHERE id = $1', [postRes.body.id]);
    }
  });

  it('admin mantiene acceso total sin depender de permisos_usuario', async () => {
    const combustible = await request(app).get('/api/maquinaria/combustible').set('Authorization', `Bearer ${adminToken}`);
    expect(combustible.status).not.toBe(403);
    const mantenimientos = await request(app).get('/api/maquinaria/mantenimientos').set('Authorization', `Bearer ${adminToken}`);
    expect(mantenimientos.status).not.toBe(403);
  });
});
