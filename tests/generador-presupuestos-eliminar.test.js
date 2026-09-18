// Integration tests para prompt-simplificar-texto-y-borrar-presupuestos.md —
// DELETE de un "presupuesto generado" (Generador de Presupuestos). Corre
// contra la base real apuntada por DATABASE_URL, mismo patrón que el resto
// de tests/*.test.js. La creación real (POST) requiere subir y parsear un
// .xlsx real (fuera de alcance de este prompt: "NO tocar la lógica de
// carga") — el fixture de este test inserta las filas directo por SQL,
// que es lo único que le importa al endpoint que se está probando.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let adminToken;
let testProjectId;
let otherProjectId;
let insumoId;
const generadorIds = [];

async function login(usuario, password) {
  const res = await request(app).post('/api/auth/login').send({ usuario, password });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`Login falló para ${usuario}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

async function crearGeneradorFixture(pid) {
  const { rows: genRows } = await db.pool.query(
    `INSERT INTO generador_presupuestos (project_id, nombre, archivo_url) VALUES ($1, 'QA delete fixture', NULL) RETURNING id`,
    [pid]
  );
  const generadorId = genRows[0].id;
  generadorIds.push(generadorId);
  const { rows: conRows } = await db.pool.query(
    `INSERT INTO generador_presupuesto_conceptos (generador_id, orden, concepto, unidad, cantidad) VALUES ($1, 0, 'QA concepto', 'PZA', 1) RETURNING id`,
    [generadorId]
  );
  const conceptoId = conRows[0].id;
  await db.pool.query(
    `INSERT INTO generador_presupuesto_renglones (concepto_id, insumo_id, categoria, rendimiento) VALUES ($1, $2, 'MATERIALES', 1)`,
    [conceptoId, insumoId]
  );
  return { generadorId, conceptoId };
}

beforeAll(async () => {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada — no se puede correr la suite.');
  adminToken = await login(ADMIN_USER, ADMIN_PASSWORD);

  const { rows: projRows } = await db.pool.query('SELECT id FROM proyectos ORDER BY id LIMIT 2');
  if (projRows.length < 2) throw new Error('Se necesitan al menos 2 proyectos contra los cuales correr la suite.');
  testProjectId = projRows[0].id;
  otherProjectId = projRows[1].id;

  const { rows: insRows } = await db.pool.query('SELECT id FROM insumos WHERE project_id = $1 LIMIT 1', [testProjectId]);
  if (!insRows[0]) throw new Error('El proyecto de prueba no tiene ningún insumo.');
  insumoId = insRows[0].id;
}, 30000);

afterAll(async () => {
  for (const gid of generadorIds) {
    await db.pool.query('DELETE FROM generador_presupuesto_renglones WHERE concepto_id IN (SELECT id FROM generador_presupuesto_conceptos WHERE generador_id = $1)', [gid]);
    await db.pool.query('DELETE FROM generador_presupuesto_conceptos WHERE generador_id = $1', [gid]);
    await db.pool.query('DELETE FROM generador_presupuestos WHERE id = $1', [gid]);
  }
});

describe('DELETE /api/projects/:id/generador-presupuestos/:generadorId', () => {
  it('marca el generador como inactivo (soft-delete) sin borrar filas físicas de él ni de sus hijas', async () => {
    const { generadorId, conceptoId } = await crearGeneradorFixture(testProjectId);

    const res = await request(app)
      .delete(`/api/projects/${testProjectId}/generador-presupuestos/${generadorId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    // Regla dura del proyecto: nunca DELETE físico de registros financieros.
    // El header pasa a activo=false; las tablas hijas quedan intactas,
    // huérfanas a propósito bajo el padre inactivo.
    const { rows: gRows } = await db.pool.query('SELECT id, activo FROM generador_presupuestos WHERE id = $1', [generadorId]);
    const { rows: cRows } = await db.pool.query('SELECT id FROM generador_presupuesto_conceptos WHERE id = $1', [conceptoId]);
    const { rows: rRows } = await db.pool.query('SELECT id FROM generador_presupuesto_renglones WHERE concepto_id = $1', [conceptoId]);
    expect(gRows.length).toBe(1);
    expect(gRows[0].activo).toBe(false);
    expect(cRows.length).toBe(1);
    expect(rRows.length).toBe(1);

    // Desaparece del listado...
    const listRes = await request(app)
      .get(`/api/projects/${testProjectId}/generador-presupuestos`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.generadores.some((g) => g.id === generadorId)).toBe(false);

    // ...y del detalle/export directos (404, mismo criterio que "no existe").
    const detalleRes = await request(app)
      .get(`/api/projects/${testProjectId}/generador-presupuestos/${generadorId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(detalleRes.status).toBe(404);
  });

  it('eliminar dos veces el mismo generador da 404 la segunda vez (ya está inactivo)', async () => {
    const { generadorId } = await crearGeneradorFixture(testProjectId);

    const res1 = await request(app)
      .delete(`/api/projects/${testProjectId}/generador-presupuestos/${generadorId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res1.status).toBe(200);

    const res2 = await request(app)
      .delete(`/api/projects/${testProjectId}/generador-presupuestos/${generadorId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res2.status).toBe(404);
  });

  it('rechaza (404) eliminar un generador de OTRA obra vía API directa', async () => {
    const { generadorId } = await crearGeneradorFixture(otherProjectId);

    const res = await request(app)
      .delete(`/api/projects/${testProjectId}/generador-presupuestos/${generadorId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);

    const { rows } = await db.pool.query('SELECT id, activo FROM generador_presupuestos WHERE id = $1', [generadorId]);
    expect(rows.length).toBe(1); // sigue existiendo
    expect(rows[0].activo).toBe(true); // y sigue activo, no se tocó
  });

  it('404 para un id inexistente', async () => {
    const res = await request(app)
      .delete(`/api/projects/${testProjectId}/generador-presupuestos/999999999`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});
