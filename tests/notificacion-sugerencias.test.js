// Integration test para prompt-notificacion-sugerencias.md — al crear una
// sugerencia, se debe generar una notificación (mecanismo genérico existente,
// ver server/notificaciones.js) visible solo para admin/desarrollador. Corre
// contra la DB real apuntada por DATABASE_URL, mismo patrón que el resto de
// la suite (ver tests/fix-saldo-iva-5-lugares.test.js).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const TEST_USUARIO = `qa_sug_residente_${Date.now()}`;

let adminToken;
let adminId;
let residenteToken;
let residenteId;
let sugerenciaId;

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

  const meRes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${adminToken}`);
  adminId = meRes.body.user.id;

  // Usuario de prueba con un puesto que NO debe recibir esta notificación
  // (residente), para cubrir la Forbidden Action del prompt.
  const crearRes = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA Residente Sugerencias', usuario: TEST_USUARIO, password: 'qa012345', puesto: 'residente' });
  if (crearRes.status !== 201) throw new Error(`No se pudo crear el usuario de prueba: ${crearRes.status} ${JSON.stringify(crearRes.body)}`);
  residenteId = crearRes.body.id;
  residenteToken = await login(TEST_USUARIO, 'qa012345');
}, 30000);

afterAll(async () => {
  if (sugerenciaId) {
    await db.pool.query('DELETE FROM notificaciones WHERE tipo = $1 AND referencia_id = $2', ['sugerencia_nueva', sugerenciaId]);
    await db.pool.query('DELETE FROM sugerencia_imagenes WHERE sugerencia_id = $1', [sugerenciaId]);
    await db.pool.query('DELETE FROM sugerencias WHERE id = $1', [sugerenciaId]);
  }
  if (residenteId) {
    await db.pool.query('DELETE FROM api_rate_limits WHERE usuario_id = $1', [residenteId]);
    await db.pool.query('DELETE FROM usuarios WHERE id = $1', [residenteId]);
  }
  await db.pool.end();
});

describe('POST /api/sugerencias — notificación a admin/desarrollador', () => {
  it('crea la sugerencia y una notificación tipo sugerencia_nueva para admin', async () => {
    const texto = 'QA: probar que la notificación de sugerencias funciona correctamente de punta a punta con un texto largo para el extracto';
    const res = await request(app)
      .post('/api/sugerencias')
      .set('Authorization', `Bearer ${residenteToken}`)
      .send({ texto });
    expect(res.status).toBe(201);
    sugerenciaId = res.body.id;

    const notifRes = await request(app).get('/api/notificaciones').set('Authorization', `Bearer ${adminToken}`);
    expect(notifRes.status).toBe(200);
    const notif = notifRes.body.notificaciones.find((n) => n.tipo === 'sugerencia_nueva' && n.referencia_id === sugerenciaId);
    expect(notif).toBeTruthy();
    expect(notif.usuario_id).toBe(adminId);
    expect(notif.leida).toBe(false);
    expect(notif.mensaje).toContain('QA Residente Sugerencias');
    expect(notif.mensaje).toContain(texto.slice(0, 80));
  });

  it('NO notifica al usuario que la envió (residente, fuera de admin/desarrollador)', async () => {
    const notifRes = await request(app).get('/api/notificaciones').set('Authorization', `Bearer ${residenteToken}`);
    expect(notifRes.status).toBe(200);
    const notif = notifRes.body.notificaciones.find((n) => n.tipo === 'sugerencia_nueva' && n.referencia_id === sugerenciaId);
    expect(notif).toBeUndefined();
  });

  it('marcar como leída usa el mismo endpoint genérico de notificaciones', async () => {
    const notifRes = await request(app).get('/api/notificaciones').set('Authorization', `Bearer ${adminToken}`);
    const notif = notifRes.body.notificaciones.find((n) => n.tipo === 'sugerencia_nueva' && n.referencia_id === sugerenciaId);
    const leidaRes = await request(app)
      .put(`/api/notificaciones/${notif.id}/leida`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(leidaRes.status).toBe(200);

    const notifRes2 = await request(app).get('/api/notificaciones').set('Authorization', `Bearer ${adminToken}`);
    const notif2 = notifRes2.body.notificaciones.find((n) => n.id === notif.id);
    expect(notif2.leida).toBe(true);
  });
});

// prompt-badge-sugerencias-menu.md: /api/notificaciones también expone
// sugerencias_pendientes (badge del sidebar), piggybackeado en el mismo
// polling — solo para admin/desarrollador, y se actualiza al cambiar el
// estado de una sugerencia.
describe('GET /api/notificaciones — sugerencias_pendientes (badge sidebar)', () => {
  it('incluye sugerencias_pendientes para admin y NO para un puesto sin ese permiso', async () => {
    const adminRes = await request(app).get('/api/notificaciones').set('Authorization', `Bearer ${adminToken}`);
    expect(adminRes.status).toBe(200);
    // La sugerencia creada en el describe anterior sigue en estado 'pendiente'
    // (el test previo solo marcó su NOTIFICACIÓN como leída, no tocó `estado`).
    expect(adminRes.body.sugerencias_pendientes).toBeGreaterThanOrEqual(1);

    const residenteRes = await request(app).get('/api/notificaciones').set('Authorization', `Bearer ${residenteToken}`);
    expect(residenteRes.status).toBe(200);
    expect(residenteRes.body.sugerencias_pendientes).toBeUndefined();
  });

  it('el conteo baja al marcar la sugerencia como revisada y sube de nuevo al volverla a pendiente', async () => {
    const before = await request(app).get('/api/notificaciones').set('Authorization', `Bearer ${adminToken}`);
    const countBefore = before.body.sugerencias_pendientes;

    const patchRevisada = await request(app)
      .patch(`/api/sugerencias/${sugerenciaId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ estado: 'revisada' });
    expect(patchRevisada.status).toBe(200);

    const afterRevisada = await request(app).get('/api/notificaciones').set('Authorization', `Bearer ${adminToken}`);
    expect(afterRevisada.body.sugerencias_pendientes).toBe(countBefore - 1);

    // Se deja tal cual estaba (pendiente) para no interferir con el afterAll
    // (que de todos modos borra esta sugerencia de prueba).
    const patchPendiente = await request(app)
      .patch(`/api/sugerencias/${sugerenciaId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ estado: 'pendiente' });
    expect(patchPendiente.status).toBe(200);

    const afterPendiente = await request(app).get('/api/notificaciones').set('Authorization', `Bearer ${adminToken}`);
    expect(afterPendiente.body.sugerencias_pendientes).toBe(countBefore);
  });
});
