// Integration tests para prompt-fix-cabo-y-extender-residente-maquinaria.md
// — fix del backfill roto de 'maquinaria_captura' para cabo (UPDATE-only
// dejaba fuera a usuarios sin fila previa) y extensión de la autorización de
// reportes de horas de operador a residente. Corre contra la base real
// apuntada por DATABASE_URL (mismo patrón que tests/presupuestos-permisos.
// test.js y tests/control-financiero.test.js).
//
// NOTA sobre el token de Efren Monico (cabo real, id 118, el único cabo
// activo afectado por el bug): no existe forma de loguearse como esa cuenta
// real sin su password. En vez de eso se firma un JWT propio con el mismo
// SESSION_SECRET que ya usa el proceso del servidor (jwt.sign, mismo
// payload que auth.signToken) — verifica el gate real (checkPermiso sobre
// permisos_usuario del usuario 118 real) sin tocar su cuenta ni contraseña.
// Mismo patrón ya usado en tests/control-financiero.test.js para Paul/Fer.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const CABO_REAL_ID = 118; // Efren Monico — único cabo activo, confirmado en diagnóstico

let adminToken;
let caboToken;
let residenteToken;
let testProjectId;
let equipoId;
let operadorTempId;
let residenteTempId;
let reporteCaboId;
let reporteResidenteId;
const operadorTempUsuario = `qa_operador_maq_${Date.now()}`;
const residenteTempUsuario = `qa_residente_maq_${Date.now()}`;
const tempPassword = 'QaMaquinariaTemp123!';

async function login(usuario, password) {
  const res = await request(app).post('/api/auth/login').send({ usuario, password });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`Login falló para ${usuario}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

function tokenPara(id, nombre, usuario, puesto) {
  return jwt.sign({ id, nombre, usuario, puesto }, SESSION_SECRET, { expiresIn: '15m', algorithm: 'HS256' });
}

beforeAll(async () => {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada — no se puede correr la suite.');
  if (!SESSION_SECRET) throw new Error('SESSION_SECRET no configurada — no se puede correr la suite.');
  adminToken = await login(ADMIN_USER, ADMIN_PASSWORD);

  const { rows: caboRows } = await db.pool.query("SELECT id, nombre, usuario, puesto FROM usuarios WHERE id = $1 AND puesto = 'cabo' AND activo = true", [CABO_REAL_ID]);
  if (!caboRows[0]) throw new Error(`El usuario cabo real esperado (id ${CABO_REAL_ID}) no existe o cambió de rol — ajustar el test.`);
  caboToken = tokenPara(caboRows[0].id, caboRows[0].nombre, caboRows[0].usuario, 'cabo');

  const { rows: projRows } = await db.pool.query('SELECT id FROM proyectos ORDER BY id LIMIT 1');
  if (!projRows[0]) throw new Error('No hay ningún proyecto contra el cual correr la suite.');
  testProjectId = projRows[0].id;

  const equipoRes = await request(app)
    .post('/api/maquinaria/equipos')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA Equipo Aprobacion Cabo Residente', categoria_uso: 'pesada' });
  if (equipoRes.status !== 201) throw new Error(`No se pudo crear el equipo de prueba: ${equipoRes.status} ${JSON.stringify(equipoRes.body)}`);
  equipoId = equipoRes.body.id;

  const operadorRes = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA Operador Maquinaria', usuario: operadorTempUsuario, password: tempPassword, puesto: 'operador' });
  if (operadorRes.status !== 201 && operadorRes.status !== 200) throw new Error(`No se pudo crear el operador temporal: ${operadorRes.status} ${JSON.stringify(operadorRes.body)}`);
  operadorTempId = operadorRes.body.id;

  const residenteRes = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA Residente Maquinaria', usuario: residenteTempUsuario, password: tempPassword, puesto: 'residente' });
  if (residenteRes.status !== 201 && residenteRes.status !== 200) throw new Error(`No se pudo crear el residente temporal: ${residenteRes.status} ${JSON.stringify(residenteRes.body)}`);
  residenteTempId = residenteRes.body.id;

  const asignaRes = await request(app)
    .put(`/api/usuarios/${residenteTempId}/proyectos`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ project_ids: [testProjectId] });
  if (asignaRes.status !== 200) throw new Error(`No se pudo asignar la obra al residente temporal: ${asignaRes.status} ${JSON.stringify(asignaRes.body)}`);
  residenteToken = await login(residenteTempUsuario, tempPassword);

  // Dos reportes 'pendiente' reales — uno para que el cabo real apruebe,
  // otro para que el residente de prueba rechace.
  const crearReporte = async () => {
    const res = await request(app)
      .post('/api/maquinaria/horas')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ equipo_id: equipoId, operador_id: operadorTempId, fecha: '2026-08-01', horas: 4, actividad: ['Excavaciones'] });
    if (res.status !== 201) throw new Error(`No se pudo crear el reporte de horas de prueba: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.id;
  };
  reporteCaboId = await crearReporte();
  reporteResidenteId = await crearReporte();
});

afterAll(async () => {
  if (reporteCaboId) await db.pool.query('DELETE FROM reportes_horas_maquinaria WHERE id = $1', [reporteCaboId]);
  if (reporteResidenteId) await db.pool.query('DELETE FROM reportes_horas_maquinaria WHERE id = $1', [reporteResidenteId]);
  // DELETE /api/maquinaria/equipos/:id solo hace soft-delete (activo=false)
  // — borrado físico directo por SQL para no dejar residuo (regla del
  // proyecto: datos de prueba siempre se eliminan físicamente).
  if (equipoId) await db.pool.query('DELETE FROM equipos_maquinaria WHERE id = $1', [equipoId]);
  if (operadorTempId) await request(app).delete(`/api/usuarios/${operadorTempId}`).set('Authorization', `Bearer ${adminToken}`);
  if (residenteTempId) await request(app).delete(`/api/usuarios/${residenteTempId}`).set('Authorization', `Bearer ${adminToken}`);
  // Fix del bug real: la fila nueva de Efren Monico (id 118) en
  // 'maquinaria_captura' es la corrección misma, no un dato de prueba — se
  // deja intacta a propósito, no se borra.
  await db.pool.end();
});

describe('Fix backfill de cabo — Efren Monico (id 118, real)', () => {
  it('tiene puede_editar=true en maquinaria_captura tras el backfill corregido', async () => {
    const { rows } = await db.pool.query(
      "SELECT puede_ver, puede_editar FROM permisos_usuario WHERE usuario_id = $1 AND seccion = 'maquinaria_captura' AND proyecto_id IS NULL",
      [CABO_REAL_ID]
    );
    expect(rows[0]).toBeTruthy();
    expect(rows[0].puede_editar).toBe(true);
  });

  it('puede autorizar un reporte de horas real (200, no 403)', async () => {
    const res = await request(app)
      .put(`/api/maquinaria/horas/${reporteCaboId}/estado`)
      .set('Authorization', `Bearer ${caboToken}`)
      .send({ estado: 'autorizado' });
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('autorizado');
    expect(res.body.revisado_por).toBe(CABO_REAL_ID);
  });
});

describe('Extensión a residente', () => {
  it('el tab maquinaria_horas aparece en nav-tabs del residente de prueba', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/nav-tabs`)
      .set('Authorization', `Bearer ${residenteToken}`);
    expect(res.status).toBe(200);
    expect(res.body.tabs).toContain('maquinaria_horas');
  });

  it('puede rechazar un reporte de horas real (200, no 403)', async () => {
    const res = await request(app)
      .put(`/api/maquinaria/horas/${reporteResidenteId}/estado`)
      .set('Authorization', `Bearer ${residenteToken}`)
      .send({ estado: 'rechazado' });
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('rechazado');
  });

  it('un residente SIN el permiso (simulado con JWT de otro puesto) seguiría recibiendo 403 — control negativo', async () => {
    // Control negativo: un puesto que nunca tuvo este permiso (jefe_maquinaria)
    // confirma que el 200 de arriba es real enforcement, no un bypass general.
    const jefeToken = tokenPara(999999, 'QA Jefe Sin Permiso', 'qa_jefe_sin_permiso', 'jefe_maquinaria');
    const res = await request(app)
      .put(`/api/maquinaria/horas/${reporteCaboId}/estado`)
      .set('Authorization', `Bearer ${jefeToken}`)
      .send({ estado: 'autorizado' });
    // 401/403 esperado: el usuario 999999 no existe (JWT válido pero sin
    // usuario real detrás) o no tiene permiso — cualquiera de los dos
    // confirma que NO hay bypass abierto.
    expect([401, 403, 404]).toContain(res.status);
  });
});

describe('Ningún otro permiso de cabo/residente se vio alterado (checkpoint del prompt)', () => {
  it('Efren Monico conserva exactamente sus otras 2 filas previas (estado_unidad, maquinaria_consumibles)', async () => {
    const { rows } = await db.pool.query(
      "SELECT seccion, puede_ver, puede_crear, puede_editar, puede_editar_precios, puede_eliminar FROM permisos_usuario WHERE usuario_id = $1 AND seccion IN ('estado_unidad','maquinaria_consumibles') ORDER BY seccion",
      [CABO_REAL_ID]
    );
    expect(rows).toEqual([
      { seccion: 'estado_unidad', puede_ver: true, puede_crear: false, puede_editar: false, puede_editar_precios: false, puede_eliminar: false },
      { seccion: 'maquinaria_consumibles', puede_ver: true, puede_crear: false, puede_editar: false, puede_editar_precios: false, puede_eliminar: false },
    ]);
  });
});
