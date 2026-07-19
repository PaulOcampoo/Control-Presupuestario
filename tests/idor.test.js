// Integration tests para los 3 endpoints con historial de IDOR corregido
// (prompt-cerrar-gaps-mayores.md): eliminación de pagos, registro de avance
// de concepto, descarga de PDF de contrato. Corren contra la base de datos
// real apuntada por DATABASE_URL (no hay DB de pruebas separada en este
// proyecto) — crean un único usuario temporal desechable y lo eliminan al
// terminar (afterAll), sin tocar ningún dato existente.
//
// NOTA sobre alcance real de la verificación: de los 3 endpoints, solo
// "avance de concepto" usa auth.allow('residente','cabo') como gate de rol,
// así que un usuario 'residente' sin la obra asignada sí ejercita
// auth.verificarAccesoObra (el fix de IDOR real). Los otros dos
// (eliminación de pagos y PDF de contrato) usan auth.allow() SIN roles
// extra — que solo admin/desarrollador pasan, y ambos puestos hacen bypass
// incondicional de verificarAccesoObra (ver server/auth.js). Un usuario
// 'residente' contra esos dos recibe 403 por el gate de ROL, no porque
// verificarAccesoObra lo haya evaluado y rechazado — lo cual es correcto
// (403 es el resultado esperado) pero significa que, bajo la configuración
// de roles actual, verificarAccesoObra en esas dos rutas nunca llega a
// ejecutarse para ningún actor no-admin. Se deja documentado como hallazgo,
// no se modifica (fuera de alcance de este prompt).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let adminToken;
let testProjectId;
let tempUserId;
let tempToken;
const tempUsuario = `qa_idor_${Date.now()}`;
// CN-005: generada en runtime en vez de hardcodeada (CWE-798) — no es un
// secreto de producción (solo afecta al test suite), pero evita el hábito
// de literales copy-pasteables en el código.
const tempPassword = crypto.randomBytes(12).toString('hex') + '!Aa1';

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

  const { rows } = await db.pool.query('SELECT id FROM proyectos ORDER BY id LIMIT 1');
  if (!rows[0]) throw new Error('No hay ningún proyecto en la base de datos contra la cual correr la suite IDOR.');
  testProjectId = rows[0].id;

  // Usuario temporal 'residente' SIN asignar a ninguna obra (a propósito) —
  // usuario_proyectos queda vacío para él, así que verificarAccesoObra debe
  // rechazarlo para cualquier obra, incluida testProjectId.
  const createRes = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA Integration IDOR', usuario: tempUsuario, password: tempPassword, puesto: 'residente' });
  if (createRes.status !== 201 && createRes.status !== 200) {
    throw new Error(`No se pudo crear el usuario temporal: ${createRes.status} ${JSON.stringify(createRes.body)}`);
  }
  tempUserId = createRes.body.id;
  tempToken = await login(tempUsuario, tempPassword);
});

afterAll(async () => {
  if (tempUserId) {
    await request(app).delete(`/api/usuarios/${tempUserId}`).set('Authorization', `Bearer ${adminToken}`);
  }
  await db.pool.end();
});

describe('IDOR — acceso a obra ajena (verificarAccesoObra)', () => {
  it('PUT /projects/:id/avances/:semana/conceptos — residente sin la obra asignada recibe 403', async () => {
    const res = await request(app)
      .put(`/api/projects/${testProjectId}/avances/1/conceptos`)
      .set('Authorization', `Bearer ${tempToken}`)
      .send({ items: [] });
    expect(res.status).toBe(403);
  });

  it('PUT /projects/:id/avances/:semana/conceptos — admin (con acceso implícito) no recibe 403', async () => {
    const res = await request(app)
      .put(`/api/projects/${testProjectId}/avances/1/conceptos`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ items: [] });
    expect(res.status).not.toBe(403);
  });

  it('DELETE /projects/:id/ordenes/:ocId/pagos/:pagoId — residente recibe 403 (gate de rol, ver nota de alcance arriba)', async () => {
    const res = await request(app)
      .delete(`/api/projects/${testProjectId}/ordenes/999999/pagos/999999`)
      .set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(403);
  });

  it('GET /projects/:id/contrato/pdf — residente recibe 403 (gate de rol, ver nota de alcance arriba)', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/contrato/pdf`)
      .set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(403);
  });
});
