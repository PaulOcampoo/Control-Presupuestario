// Integration tests para prompt-responder-sugerencias-notificacion.md —
// responder una sugerencia con un mensaje (gate: desarrollador + la cuenta
// específica de Rodolfo Ocampo Hernandez, id=28, ver auth.js) y la
// notificación automática de agradecimiento al pasar a implementada/
// descartada. Mismo patrón de tokens sintéticos que tests/contabilidad.test.js
// (jwt.sign directo contra SESSION_SECRET para ids reales conocidos —
// Paul=46 desarrollador, Fer=8 admin — sin necesitar sus contraseñas reales).
// Corre contra la base de datos real apuntada por DATABASE_URL.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const RODOLFO_ID = 28; // ver USUARIO_RESPONDER_SUGERENCIAS_ADMIN en server/auth.js
const TEST_USUARIO = `qa_resp_sug_${Date.now()}`;

let adminToken; // bootstrap admin real — puesto admin, pero NO id 28: debe recibir 403
let desarrolladorToken; // Paul (id 46), real y activo
let rodolfoToken; // Rodolfo (id 28), real y activo — único admin con acceso
let otroAdminToken; // Fer (id 8), real y activo, admin pero no id 28 — debe recibir 403
let qaUserId;
let qaToken;
let sugerenciaId;
let sugerenciaId2;
let sugerenciaId3;

function tokenPara(id, nombre, usuario, puesto) {
  return jwt.sign({ id, nombre, usuario, puesto }, SESSION_SECRET, { expiresIn: '15m', algorithm: 'HS256' });
}

async function login(usuario, password) {
  const res = await request(app).post('/api/auth/login').send({ usuario, password });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`Login falló para ${usuario}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

beforeAll(async () => {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada — no se puede correr la suite.');
  if (!SESSION_SECRET) throw new Error('SESSION_SECRET no configurada — no se puede correr la suite.');

  adminToken = await login(ADMIN_USER, ADMIN_PASSWORD);
  const meRes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${adminToken}`);
  if (meRes.body.user.id === RODOLFO_ID) {
    throw new Error('La cuenta admin de pruebas coincide con Rodolfo (id 28) — ajustar el test.');
  }
  if (meRes.body.user.puesto !== 'admin') {
    throw new Error(`La cuenta admin de pruebas no tiene puesto='admin' (tiene '${meRes.body.user.puesto}') — ajustar el test.`);
  }

  // Confirma que los 3 ids reales que vamos a usar en tokens sintéticos
  // siguen existiendo y activos ANTES de firmarles un token — si alguno ya
  // no aplica (cuenta dada de baja, id reciclado) el test debe fallar fuerte
  // acá, no dar un falso 403/200 más abajo por firmar un token para un id
  // que requireAuth rechaza con 401 por otra razón.
  const { rows: chequeo } = await db.pool.query(
    "SELECT id, usuario, puesto, activo FROM usuarios WHERE id IN (46, 8, $1)", [RODOLFO_ID]
  );
  const porId = Object.fromEntries(chequeo.map((r) => [r.id, r]));
  if (!porId[46]?.activo || porId[46].puesto !== 'desarrollador') throw new Error('id=46 (Paul) ya no es un desarrollador activo — ajustar el test.');
  if (!porId[8]?.activo || porId[8].puesto !== 'admin') throw new Error('id=8 (Fer) ya no es un admin activo — ajustar el test.');
  if (!porId[RODOLFO_ID]?.activo || porId[RODOLFO_ID].puesto !== 'admin') throw new Error(`id=${RODOLFO_ID} (Rodolfo) ya no es un admin activo — ajustar el test.`);

  desarrolladorToken = tokenPara(46, 'PAUL OCAMPO', porId[46].usuario, 'desarrollador');
  rodolfoToken = tokenPara(RODOLFO_ID, 'RODOLFO OCAMPO HERNANDEZ', porId[RODOLFO_ID].usuario, 'admin');
  otroAdminToken = tokenPara(8, 'Fernando Olvera Monroy', porId[8].usuario, 'admin');

  const crearRes = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA Responder Sugerencias', usuario: TEST_USUARIO, password: 'qa012345', puesto: 'residente' });
  if (crearRes.status !== 201) throw new Error(`No se pudo crear el usuario de prueba: ${crearRes.status} ${JSON.stringify(crearRes.body)}`);
  qaUserId = crearRes.body.id;
  qaToken = await login(TEST_USUARIO, 'qa012345');

  const sugRes = await request(app).post('/api/sugerencias').set('Authorization', `Bearer ${qaToken}`).send({ texto: 'QA: sugerencia de prueba para el flujo de responder' });
  if (sugRes.status !== 201) throw new Error(`No se pudo crear la sugerencia de prueba: ${sugRes.status} ${JSON.stringify(sugRes.body)}`);
  sugerenciaId = sugRes.body.id;
}, 30000);

afterAll(async () => {
  for (const id of [sugerenciaId, sugerenciaId2, sugerenciaId3].filter(Boolean)) {
    await db.pool.query('DELETE FROM notificaciones WHERE referencia_id = $1 AND tipo IN ($2, $3, $4)', [id, 'sugerencia_nueva', 'sugerencia_respuesta', 'sugerencia_resuelta']);
    await db.pool.query('DELETE FROM sugerencias_respuestas WHERE sugerencia_id = $1', [id]);
    await db.pool.query('DELETE FROM sugerencias WHERE id = $1', [id]);
  }
  if (qaUserId) {
    await db.pool.query('DELETE FROM api_rate_limits WHERE usuario_id = $1', [qaUserId]);
    await db.pool.query('DELETE FROM usuarios WHERE id = $1', [qaUserId]);
  }
  await db.pool.end();
});

describe('sugerencias_respuestas — schema', () => {
  it('existe con las columnas esperadas', async () => {
    const { rows } = await db.pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'sugerencias_respuestas'"
    );
    const cols = rows.map((r) => r.column_name);
    expect(cols).toEqual(expect.arrayContaining(['id', 'sugerencia_id', 'autor_usuario_id', 'mensaje', 'creado_en']));
  });
});

describe('POST /api/sugerencias/:id/responder — gating', () => {
  it('403 para un admin cualquiera que no sea Rodolfo (Fer, id 8)', async () => {
    const res = await request(app)
      .post(`/api/sugerencias/${sugerenciaId}/responder`)
      .set('Authorization', `Bearer ${otroAdminToken}`)
      .send({ mensaje: 'no debería pasar' });
    expect(res.status).toBe(403);
  });

  it('403 para el propio autor de la sugerencia (residente, sin excepción)', async () => {
    const res = await request(app)
      .post(`/api/sugerencias/${sugerenciaId}/responder`)
      .set('Authorization', `Bearer ${qaToken}`)
      .send({ mensaje: 'no debería pasar' });
    expect(res.status).toBe(403);
  });

  it('200 para desarrollador (Paul) y crea notificación sugerencia_respuesta para el autor', async () => {
    const res = await request(app)
      .post(`/api/sugerencias/${sugerenciaId}/responder`)
      .set('Authorization', `Bearer ${desarrolladorToken}`)
      .send({ mensaje: 'QA: respuesta de desarrollador' });
    expect(res.status).toBe(201);
    expect(res.body.mensaje).toBe('QA: respuesta de desarrollador');
    expect(res.body.autor_usuario_id).toBe(46);

    const notifRes = await request(app).get('/api/notificaciones').set('Authorization', `Bearer ${qaToken}`);
    const notif = notifRes.body.notificaciones.find((n) => n.tipo === 'sugerencia_respuesta' && n.referencia_id === sugerenciaId);
    expect(notif).toBeTruthy();
    expect(notif.mensaje).toContain('PAUL OCAMPO');
    expect(notif.mensaje).toContain('QA: respuesta de desarrollador');
  });

  it('200 para la cuenta específica de Rodolfo (id 28) y el hilo queda con ambas respuestas en orden', async () => {
    const res = await request(app)
      .post(`/api/sugerencias/${sugerenciaId}/responder`)
      .set('Authorization', `Bearer ${rodolfoToken}`)
      .send({ mensaje: 'QA: respuesta de Rodolfo' });
    expect(res.status).toBe(201);
    expect(res.body.autor_usuario_id).toBe(RODOLFO_ID);

    const hiloRes = await request(app).get(`/api/sugerencias/${sugerenciaId}/respuestas`).set('Authorization', `Bearer ${qaToken}`);
    expect(hiloRes.status).toBe(200);
    expect(hiloRes.body.map((r) => r.mensaje)).toEqual(['QA: respuesta de desarrollador', 'QA: respuesta de Rodolfo']);
  });

  it('GET del hilo también es 403 para un tercero que no es admin/desarrollador ni el autor', async () => {
    const otroRes = await request(app)
      .post('/api/usuarios')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'QA Tercero', usuario: `qa_tercero_${Date.now()}`, password: 'qa012345', puesto: 'residente' });
    expect(otroRes.status).toBe(201);
    const otroToken = await login(otroRes.body.usuario, 'qa012345');
    const hiloRes = await request(app).get(`/api/sugerencias/${sugerenciaId}/respuestas`).set('Authorization', `Bearer ${otroToken}`);
    expect(hiloRes.status).toBe(403);
    await db.pool.query('DELETE FROM api_rate_limits WHERE usuario_id = $1', [otroRes.body.id]);
    await db.pool.query('DELETE FROM usuarios WHERE id = $1', [otroRes.body.id]);
  });
});

describe('PATCH /api/sugerencias/:id — notificación automática de agradecimiento', () => {
  it('NO dispara notificación al pasar a revisada', async () => {
    const patch = await request(app).patch(`/api/sugerencias/${sugerenciaId}`).set('Authorization', `Bearer ${adminToken}`).send({ estado: 'revisada' });
    expect(patch.status).toBe(200);
    const notifRes = await request(app).get('/api/notificaciones').set('Authorization', `Bearer ${qaToken}`);
    expect(notifRes.body.notificaciones.find((n) => n.tipo === 'sugerencia_resuelta' && n.referencia_id === sugerenciaId)).toBeUndefined();
  });

  it('NO dispara notificación al volver a pendiente', async () => {
    const patch = await request(app).patch(`/api/sugerencias/${sugerenciaId}`).set('Authorization', `Bearer ${adminToken}`).send({ estado: 'pendiente' });
    expect(patch.status).toBe(200);
    const notifRes = await request(app).get('/api/notificaciones').set('Authorization', `Bearer ${qaToken}`);
    expect(notifRes.body.notificaciones.find((n) => n.tipo === 'sugerencia_resuelta' && n.referencia_id === sugerenciaId)).toBeUndefined();
  });

  it('dispara notificación de agradecimiento (texto de implementada) al pasar a implementada', async () => {
    const patch = await request(app).patch(`/api/sugerencias/${sugerenciaId}`).set('Authorization', `Bearer ${adminToken}`).send({ estado: 'implementada' });
    expect(patch.status).toBe(200);
    const notifRes = await request(app).get('/api/notificaciones').set('Authorization', `Bearer ${qaToken}`);
    const notif = notifRes.body.notificaciones.find((n) => n.tipo === 'sugerencia_resuelta' && n.referencia_id === sugerenciaId);
    expect(notif).toBeTruthy();
    expect(notif.mensaje).toBe('¡Gracias por tu sugerencia! Ya fue implementada.');
  });

  it('dispara notificación de agradecimiento (texto de descartada) al pasar a descartada, en una sugerencia distinta', async () => {
    const sugRes = await request(app).post('/api/sugerencias').set('Authorization', `Bearer ${qaToken}`).send({ texto: 'QA: segunda sugerencia, para probar descartada' });
    expect(sugRes.status).toBe(201);
    sugerenciaId2 = sugRes.body.id;

    const patch = await request(app).patch(`/api/sugerencias/${sugerenciaId2}`).set('Authorization', `Bearer ${adminToken}`).send({ estado: 'descartada' });
    expect(patch.status).toBe(200);
    const notifRes = await request(app).get('/api/notificaciones').set('Authorization', `Bearer ${qaToken}`);
    const notif = notifRes.body.notificaciones.find((n) => n.tipo === 'sugerencia_resuelta' && n.referencia_id === sugerenciaId2);
    expect(notif).toBeTruthy();
    expect(notif.mensaje).toBe('Gracias por tu sugerencia. Esta vez no fue posible implementarla.');
  });

  it('la notificación automática coexiste con una respuesta manual previa (ambas quedan, ninguna reemplaza a la otra)', async () => {
    const sugRes = await request(app).post('/api/sugerencias').set('Authorization', `Bearer ${qaToken}`).send({ texto: 'QA: tercera sugerencia, respuesta manual + resolución automática' });
    expect(sugRes.status).toBe(201);
    sugerenciaId3 = sugRes.body.id;

    const responder = await request(app).post(`/api/sugerencias/${sugerenciaId3}/responder`).set('Authorization', `Bearer ${rodolfoToken}`).send({ mensaje: 'QA: mensaje manual antes de resolver' });
    expect(responder.status).toBe(201);

    const patch = await request(app).patch(`/api/sugerencias/${sugerenciaId3}`).set('Authorization', `Bearer ${adminToken}`).send({ estado: 'implementada' });
    expect(patch.status).toBe(200);

    const notifRes = await request(app).get('/api/notificaciones').set('Authorization', `Bearer ${qaToken}`);
    const respuestaNotif = notifRes.body.notificaciones.find((n) => n.tipo === 'sugerencia_respuesta' && n.referencia_id === sugerenciaId3);
    const resueltaNotif = notifRes.body.notificaciones.find((n) => n.tipo === 'sugerencia_resuelta' && n.referencia_id === sugerenciaId3);
    expect(respuestaNotif).toBeTruthy();
    expect(resueltaNotif).toBeTruthy();
  });
});
