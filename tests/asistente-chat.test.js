// Integration tests para prompt-asistente-ia-app-cp.md. Corre contra la base
// real apuntada por DATABASE_URL, mismo patrón que el resto de tests/*.test.js.
// NO hay ANTHROPIC_API_KEY configurada en este entorno de pruebas -- eso es
// intencional y se usa a favor: server/asistente.js valida el env var
// explícitamente y lanza un 503 controlado (ver getClient() en
// server/asistente.js), así que estos tests cubren el camino determinista
// completo (auth, validación, rate limiting, manejo de errores) sin depender
// de una respuesta real del modelo ni gastar cuota.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let adminToken;
let residenteToken;
let residenteId;
const residenteUsuario = `qa_asistente_res_${Date.now()}`;
const tempPassword = 'QaAsistenteTemp123!';

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

  const res = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA Asistente Residente', usuario: residenteUsuario, password: tempPassword, puesto: 'residente' });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`No se pudo crear el residente temporal: ${res.status} ${JSON.stringify(res.body)}`);
  }
  residenteId = res.body.id;
  residenteToken = await login(residenteUsuario, tempPassword);
}, 30000);

afterAll(async () => {
  await db.pool.query(`DELETE FROM api_rate_limits WHERE usuario_id = $1 AND endpoint = 'asistente_chat'`, [residenteId]);
  if (residenteId) await request(app).delete(`/api/usuarios/${residenteId}`).set('Authorization', `Bearer ${adminToken}`);
});

describe('POST /api/asistente/chat', () => {
  it('rechaza sin sesión (401) — mismo middleware global que el resto de la API', async () => {
    const res = await request(app).post('/api/asistente/chat').send({ mensaje: 'hola' });
    expect(res.status).toBe(401);
  });

  it('un rol NO admin (residente) puede llamarlo — el asistente es para cualquier rol, no solo admin/desarrollador', async () => {
    const res = await request(app)
      .post('/api/asistente/chat')
      .set('Authorization', `Bearer ${residenteToken}`)
      .send({ mensaje: '¿Cómo capturo el avance de la semana?' });
    // Sin ANTHROPIC_API_KEY en este entorno, la llamada real a Anthropic
    // falla con 503 controlado -- lo importante aquí es que NO es 403 (que
    // sería el bug de auth.allow() restringiendo a admin/desarrollador).
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(503);
    // Mensaje propio y controlado (ver getClient() en server/asistente.js) —
    // lo que no debe pasar es un stack trace o error crudo del SDK.
    expect(res.body.error).not.toMatch(/at Object\.|node_modules/i);
  });

  it('rechaza mensaje vacío con 400, sin tocar el rate limit', async () => {
    const res = await request(app)
      .post('/api/asistente/chat')
      .set('Authorization', `Bearer ${residenteToken}`)
      .send({ mensaje: '   ' });
    expect(res.status).toBe(400);
  });

  it('rechaza mensaje demasiado largo con 400', async () => {
    const res = await request(app)
      .post('/api/asistente/chat')
      .set('Authorization', `Bearer ${residenteToken}`)
      .send({ mensaje: 'a'.repeat(1001) });
    expect(res.status).toBe(400);
  });

  it('aplica rate limiting por usuario (30/hora) — cuenta el intento aunque la llamada real falle', async () => {
    await db.pool.query(`DELETE FROM api_rate_limits WHERE usuario_id = $1 AND endpoint = 'asistente_chat'`, [residenteId]);
    for (let i = 0; i < 30; i++) {
      const res = await request(app)
        .post('/api/asistente/chat')
        .set('Authorization', `Bearer ${residenteToken}`)
        .send({ mensaje: `pregunta ${i}` });
      expect(res.status).toBe(503); // consumida por falta de API key, no por rate limit
    }
    const bloqueado = await request(app)
      .post('/api/asistente/chat')
      .set('Authorization', `Bearer ${residenteToken}`)
      .send({ mensaje: 'una más' });
    expect(bloqueado.status).toBe(429);
  }, 30000);
});
