// Integration tests para prompt-editar-borrar-reporte-horas-propio.md — un
// operador puede editar/borrar su propio reporte de horas de maquinaria,
// únicamente mientras esté en estado 'pendiente'. Corre contra la base real
// apuntada por DATABASE_URL (mismo patrón que
// tests/maquinaria-aprobacion-cabo-residente.test.js).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const CABO_REAL_ID = 118; // Efren Monico — mismo cabo real usado en maquinaria-aprobacion-cabo-residente.test.js

let adminToken;
let caboToken;
let operadorAId; // dueño de los reportes bajo prueba
let operadorBId; // "otro operador" — ajeno
let operadorAToken;
let operadorBToken;
let equipoId;
const operadorAUsuario = `qa_operador_a_${Date.now()}`;
const operadorBUsuario = `qa_operador_b_${Date.now()}`;
const tempPassword = 'QaHorasPropioTemp123!';

// IDs de reportes creados en beforeAll/por test — recolectados para limpieza física en afterAll.
const reportesCreados = [];

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

async function crearReportePendiente(operadorId, horas = 4) {
  const res = await request(app)
    .post('/api/maquinaria/horas')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ equipo_id: equipoId, operador_id: operadorId, fecha: '2026-08-01', horas, actividad: ['Excavaciones'] });
  if (res.status !== 201) throw new Error(`No se pudo crear el reporte de prueba: ${res.status} ${JSON.stringify(res.body)}`);
  reportesCreados.push(res.body.id);
  return res.body.id;
}

beforeAll(async () => {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada — no se puede correr la suite.');
  if (!SESSION_SECRET) throw new Error('SESSION_SECRET no configurada — no se puede correr la suite.');
  adminToken = await login(ADMIN_USER, ADMIN_PASSWORD);

  const { rows: caboRows } = await db.pool.query("SELECT id, nombre, usuario, puesto FROM usuarios WHERE id = $1 AND puesto = 'cabo' AND activo = true", [CABO_REAL_ID]);
  if (!caboRows[0]) throw new Error(`El usuario cabo real esperado (id ${CABO_REAL_ID}) no existe o cambió de rol — ajustar el test.`);
  caboToken = tokenPara(caboRows[0].id, caboRows[0].nombre, caboRows[0].usuario, 'cabo');

  const equipoRes = await request(app)
    .post('/api/maquinaria/equipos')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA Equipo Editar Borrar Horas Propio', categoria_uso: 'pesada' });
  if (equipoRes.status !== 201) throw new Error(`No se pudo crear el equipo de prueba: ${equipoRes.status} ${JSON.stringify(equipoRes.body)}`);
  equipoId = equipoRes.body.id;

  const crearOperador = async (usuario, nombre) => {
    const res = await request(app)
      .post('/api/usuarios')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre, usuario, password: tempPassword, puesto: 'operador' });
    if (res.status !== 201 && res.status !== 200) throw new Error(`No se pudo crear operador ${usuario}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.id;
  };
  operadorAId = await crearOperador(operadorAUsuario, 'QA Operador A (dueño)');
  operadorBId = await crearOperador(operadorBUsuario, 'QA Operador B (ajeno)');
  operadorAToken = await login(operadorAUsuario, tempPassword);
  operadorBToken = await login(operadorBUsuario, tempPassword);
});

afterAll(async () => {
  // Limpieza física — regla del proyecto: nunca dejar datos de prueba, ni
  // siquiera soft-deleted.
  for (const id of reportesCreados) {
    await db.pool.query('DELETE FROM reportes_horas_maquinaria WHERE id = $1', [id]);
  }
  if (equipoId) await db.pool.query('DELETE FROM equipos_maquinaria WHERE id = $1', [equipoId]);
  if (operadorAId) await request(app).delete(`/api/usuarios/${operadorAId}`).set('Authorization', `Bearer ${adminToken}`);
  if (operadorBId) await request(app).delete(`/api/usuarios/${operadorBId}`).set('Authorization', `Bearer ${adminToken}`);
  await db.pool.end();
});

describe('PUT /api/maquinaria/horas/:id — editar reporte propio', () => {
  it('el operador dueño edita su reporte pendiente (200, valores actualizados)', async () => {
    const id = await crearReportePendiente(operadorAId, 4);
    const res = await request(app)
      .put(`/api/maquinaria/horas/${id}`)
      .set('Authorization', `Bearer ${operadorAToken}`)
      .send({ equipo_id: equipoId, fecha: '2026-08-02', horas: 6, actividad: ['Cepas', 'Rellenos'] });
    expect(res.status).toBe(200);
    expect(res.body.horas).toBe(6);
    expect(res.body.fecha).toMatch(/^2026-08-02/);
    expect(res.body.actividad).toBe('Cepas, Rellenos');
    expect(res.body.estado).toBe('pendiente');
  });

  it('rechaza editar un reporte que ya no está pendiente (409)', async () => {
    const id = await crearReportePendiente(operadorAId, 4);
    const auth = await request(app)
      .put(`/api/maquinaria/horas/${id}/estado`)
      .set('Authorization', `Bearer ${caboToken}`)
      .send({ estado: 'autorizado' });
    expect(auth.status).toBe(200);

    const res = await request(app)
      .put(`/api/maquinaria/horas/${id}`)
      .set('Authorization', `Bearer ${operadorAToken}`)
      .send({ equipo_id: equipoId, fecha: '2026-08-02', horas: 6, actividad: ['Cepas'] });
    expect(res.status).toBe(409);

    const { rows } = await db.pool.query('SELECT horas FROM reportes_horas_maquinaria WHERE id = $1', [id]);
    expect(rows[0].horas).toBe(4); // no se modificó
  });

  it('rechaza editar el reporte de OTRO operador (403)', async () => {
    const id = await crearReportePendiente(operadorAId, 4);
    const res = await request(app)
      .put(`/api/maquinaria/horas/${id}`)
      .set('Authorization', `Bearer ${operadorBToken}`)
      .send({ equipo_id: equipoId, fecha: '2026-08-02', horas: 6, actividad: ['Cepas'] });
    expect(res.status).toBe(403);

    const { rows } = await db.pool.query('SELECT horas FROM reportes_horas_maquinaria WHERE id = $1', [id]);
    expect(rows[0].horas).toBe(4); // no se modificó
  });

  it('responde 404 si el reporte no existe', async () => {
    const res = await request(app)
      .put('/api/maquinaria/horas/999999999')
      .set('Authorization', `Bearer ${operadorAToken}`)
      .send({ equipo_id: equipoId, fecha: '2026-08-02', horas: 6, actividad: ['Cepas'] });
    expect(res.status).toBe(404);
  });

  it('cabo (tiene puede_editar, NO puede_crear, en maquinaria_captura) recibe 403 — no puede usar este endpoint como atajo', async () => {
    const id = await crearReportePendiente(operadorAId, 4);
    const res = await request(app)
      .put(`/api/maquinaria/horas/${id}`)
      .set('Authorization', `Bearer ${caboToken}`)
      .send({ equipo_id: equipoId, fecha: '2026-08-02', horas: 6, actividad: ['Cepas'] });
    expect(res.status).toBe(403);
  });

  it('admin bypassa el gate de permiso pero el candado de dueño lo sigue bloqueando (403, no atajo real)', async () => {
    const id = await crearReportePendiente(operadorAId, 4);
    const res = await request(app)
      .put(`/api/maquinaria/horas/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ equipo_id: equipoId, fecha: '2026-08-02', horas: 6, actividad: ['Cepas'] });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/maquinaria/horas/:id/propio — borrar reporte propio', () => {
  it('el operador dueño borra su reporte pendiente (200, soft-delete real verificado)', async () => {
    const id = await crearReportePendiente(operadorAId, 4);
    const res = await request(app)
      .delete(`/api/maquinaria/horas/${id}/propio`)
      .set('Authorization', `Bearer ${operadorAToken}`);
    expect(res.status).toBe(200);

    const { rows } = await db.pool.query('SELECT activo FROM reportes_horas_maquinaria WHERE id = $1', [id]);
    expect(rows[0].activo).toBe(false);
  });

  it('rechaza borrar un reporte que ya no está pendiente (409)', async () => {
    const id = await crearReportePendiente(operadorAId, 4);
    const auth = await request(app)
      .put(`/api/maquinaria/horas/${id}/estado`)
      .set('Authorization', `Bearer ${caboToken}`)
      .send({ estado: 'rechazado' });
    expect(auth.status).toBe(200);

    const res = await request(app)
      .delete(`/api/maquinaria/horas/${id}/propio`)
      .set('Authorization', `Bearer ${operadorAToken}`);
    expect(res.status).toBe(409);

    const { rows } = await db.pool.query('SELECT activo FROM reportes_horas_maquinaria WHERE id = $1', [id]);
    expect(rows[0].activo).toBe(true); // no se tocó
  });

  it('rechaza borrar el reporte de OTRO operador (403)', async () => {
    const id = await crearReportePendiente(operadorAId, 4);
    const res = await request(app)
      .delete(`/api/maquinaria/horas/${id}/propio`)
      .set('Authorization', `Bearer ${operadorBToken}`);
    expect(res.status).toBe(403);

    const { rows } = await db.pool.query('SELECT activo FROM reportes_horas_maquinaria WHERE id = $1', [id]);
    expect(rows[0].activo).toBe(true); // no se tocó
  });

  it('responde 404 si el reporte no existe', async () => {
    const res = await request(app)
      .delete('/api/maquinaria/horas/999999999/propio')
      .set('Authorization', `Bearer ${operadorAToken}`);
    expect(res.status).toBe(404);
  });
});

describe('Regresión — DELETE administrativo existente sin cambios de comportamiento', () => {
  it('admin sigue pudiendo borrar cualquier reporte vía DELETE /api/maquinaria/horas/:id (sin importar estado ni dueño)', async () => {
    const id = await crearReportePendiente(operadorAId, 4);
    const auth = await request(app)
      .put(`/api/maquinaria/horas/${id}/estado`)
      .set('Authorization', `Bearer ${caboToken}`)
      .send({ estado: 'autorizado' });
    expect(auth.status).toBe(200);

    const res = await request(app)
      .delete(`/api/maquinaria/horas/${id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const { rows } = await db.pool.query('SELECT activo FROM reportes_horas_maquinaria WHERE id = $1', [id]);
    expect(rows[0].activo).toBe(false);
  });

  it('operador SIN permiso de eliminar (sección maquinaria) sigue recibiendo 403 en el DELETE administrativo', async () => {
    const id = await crearReportePendiente(operadorAId, 4);
    const res = await request(app)
      .delete(`/api/maquinaria/horas/${id}`)
      .set('Authorization', `Bearer ${operadorAToken}`);
    expect(res.status).toBe(403);
  });
});
