// Integration tests para prompt-maquinaria-filtro-cliente.md — GET
// /api/maquinaria/horas ahora acepta ?cliente_id= opcional para acotar la
// lista de "Horas/Pendientes de autorizar" a las obras de un cliente activo
// (antes traía obras de todos los clientes mezcladas). El filtro por
// equipo_id (usado por el modal de "Histórico de equipo", que NO manda
// cliente_id) debe seguir viendo el historial completo sin importar cliente
// — catálogo global, diseño ya documentado, no se toca aquí.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let adminToken;
let clienteAId, clienteBId;
let obraAId, obraBId;
let equipoId;
let reporteObraAId, reporteObraBId, reporteSinObraId;
const clienteANombre = `QA Cliente Maq A ${Date.now()}`;
const clienteBNombre = `QA Cliente Maq B ${Date.now()}`;
const obraANombre = `QA Obra Maq A ${Date.now()}`;
const obraBNombre = `QA Obra Maq B ${Date.now()}`;

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

  const clienteA = await request(app).post('/api/clientes').set('Authorization', `Bearer ${adminToken}`).send({ nombre: clienteANombre });
  if (clienteA.status !== 201) throw new Error(`No se pudo crear cliente A: ${clienteA.status} ${JSON.stringify(clienteA.body)}`);
  clienteAId = clienteA.body.id;

  const clienteB = await request(app).post('/api/clientes').set('Authorization', `Bearer ${adminToken}`).send({ nombre: clienteBNombre });
  if (clienteB.status !== 201) throw new Error(`No se pudo crear cliente B: ${clienteB.status} ${JSON.stringify(clienteB.body)}`);
  clienteBId = clienteB.body.id;

  // No hay endpoint REST simple para crear un proyecto vacío — insert directo,
  // mismo patrón usado por otras suites de este repo para fixtures desechables.
  const { rows: obraARows } = await db.pool.query(
    'INSERT INTO proyectos (nombre, cliente_id) VALUES ($1, $2) RETURNING id', [obraANombre, clienteAId]
  );
  obraAId = obraARows[0].id;
  const { rows: obraBRows } = await db.pool.query(
    'INSERT INTO proyectos (nombre, cliente_id) VALUES ($1, $2) RETURNING id', [obraBNombre, clienteBId]
  );
  obraBId = obraBRows[0].id;

  const equipoRes = await request(app)
    .post('/api/maquinaria/equipos')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA Equipo Filtro Cliente', categoria_uso: 'pesada' });
  if (equipoRes.status !== 201) throw new Error(`No se pudo crear el equipo de prueba: ${equipoRes.status} ${JSON.stringify(equipoRes.body)}`);
  equipoId = equipoRes.body.id;

  const crearReporte = async (obra_id) => {
    const res = await request(app)
      .post('/api/maquinaria/horas')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ equipo_id: equipoId, fecha: '2026-08-01', horas: 3, obra_id, actividad: 'Excavaciones' });
    if (res.status !== 201) throw new Error(`No se pudo crear el reporte de horas de prueba: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.id;
  };
  reporteObraAId = await crearReporte(obraAId);
  reporteObraBId = await crearReporte(obraBId);
  reporteSinObraId = await crearReporte(undefined);
});

afterAll(async () => {
  const ids = [reporteObraAId, reporteObraBId, reporteSinObraId].filter(Boolean);
  if (ids.length) await db.pool.query('DELETE FROM reportes_horas_maquinaria WHERE id = ANY($1)', [ids]);
  if (equipoId) await db.pool.query('DELETE FROM equipos_maquinaria WHERE id = $1', [equipoId]);
  if (obraAId) await db.pool.query('DELETE FROM proyectos WHERE id = $1', [obraAId]);
  if (obraBId) await db.pool.query('DELETE FROM proyectos WHERE id = $1', [obraBId]);
  if (clienteAId) await db.pool.query('DELETE FROM clientes WHERE id = $1', [clienteAId]);
  if (clienteBId) await db.pool.query('DELETE FROM clientes WHERE id = $1', [clienteBId]);
  await db.pool.end();
});

describe('GET /api/maquinaria/horas — filtro opcional por cliente_id', () => {
  it('sin cliente_id, trae reportes de ambas obras (comportamiento previo intacto)', async () => {
    const res = await request(app).get('/api/maquinaria/horas').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.map((h) => h.id);
    expect(ids).toContain(reporteObraAId);
    expect(ids).toContain(reporteObraBId);
  });

  it('con cliente_id del cliente A, solo trae el reporte de la obra del cliente A', async () => {
    const res = await request(app).get(`/api/maquinaria/horas?cliente_id=${clienteAId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.map((h) => h.id);
    expect(ids).toContain(reporteObraAId);
    expect(ids).not.toContain(reporteObraBId);
    expect(ids).not.toContain(reporteSinObraId);
  });

  it('con cliente_id del cliente B, solo trae el reporte de la obra del cliente B', async () => {
    const res = await request(app).get(`/api/maquinaria/horas?cliente_id=${clienteBId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.map((h) => h.id);
    expect(ids).toContain(reporteObraBId);
    expect(ids).not.toContain(reporteObraAId);
  });

  it('un reporte sin obra_id nunca aparece cuando se filtra por cliente_id', async () => {
    const res = await request(app).get(`/api/maquinaria/horas?cliente_id=${clienteAId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.map((h) => h.id)).not.toContain(reporteSinObraId);
  });

  it('filtro por equipo_id (Histórico de equipo) sin cliente_id sigue trayendo TODO el historial, cruzando clientes', async () => {
    const res = await request(app).get(`/api/maquinaria/horas?equipo_id=${equipoId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.map((h) => h.id);
    expect(ids).toContain(reporteObraAId);
    expect(ids).toContain(reporteObraBId);
    expect(ids).toContain(reporteSinObraId);
  });

  it('equipo_id + cliente_id combinados acotan por ambos', async () => {
    const res = await request(app)
      .get(`/api/maquinaria/horas?equipo_id=${equipoId}&cliente_id=${clienteAId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.map((h) => h.id);
    expect(ids).toContain(reporteObraAId);
    expect(ids).not.toContain(reporteObraBId);
  });
});
