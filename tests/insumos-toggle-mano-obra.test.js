// Integration test para el toggle "Incluir mano de obra" del catálogo de
// Insumos (prompt-toggle-mano-obra-insumos.md) — resuelve la sugerencia real
// de Raúl Méndez, verificada y cuantificada en
// prompt-diagnostico-nominas-insumos.md (25%-32% de insumos ocultos sin
// forma de verlos desde esa pantalla).
//
// Corre contra la base real apuntada por DATABASE_URL (mismo patrón que
// tests/presupuestos-permisos.test.js): crea una obra + insumos de prueba
// dedicados (no depende de datos reales de obras #30/#32, que pueden
// cambiar), un único usuario 'residente' temporal, y limpia todo en
// afterAll — insumos y usuario_proyectos caen en cascada al borrar la obra.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let adminToken;
let testProjectId;
let tempUserId;
let tempToken;
const tempUsuario = `qa_insumos_mo_${Date.now()}`;
const tempPassword = 'QaInsumosMoTemp123!';

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

  const { rows: projRows } = await db.pool.query(
    `INSERT INTO proyectos (nombre) VALUES ('QA TEMP - toggle mano de obra') RETURNING id`
  );
  testProjectId = projRows[0].id;

  // 3 insumos "material" (categoría Acero) + 2 insumos "mano de obra" (MO*,
  // categoría Cuadrillas) — mismo criterio de exclusión que getInsumosData()
  // (codigo ILIKE 'MO%').
  await db.pool.query(
    `INSERT INTO insumos (project_id, codigo, concepto, categoria, unidad, cantidad_presupuesto, precio_presupuesto, orden) VALUES
      ($1, 'MAT-01', 'Cemento gris', 'Acero', 'ton', 10, 3000, 1),
      ($1, 'MAT-02', 'Varilla 3/8', 'Acero', 'pza', 100, 120, 2),
      ($1, 'MAT-03', 'Grava', 'Acero', 'm3', 20, 450, 3),
      ($1, 'MO-01', 'Cuadrilla albañilería', 'Cuadrillas', 'jornal', 30, 500, 4),
      ($1, 'MO-02', 'Cuadrilla armado', 'Cuadrillas', 'jornal', 15, 550, 5)`,
    [testProjectId]
  );

  const createRes = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA Insumos Mano Obra', usuario: tempUsuario, password: tempPassword, puesto: 'residente' });
  if (createRes.status !== 201 && createRes.status !== 200) {
    throw new Error(`No se pudo crear el usuario temporal: ${createRes.status} ${JSON.stringify(createRes.body)}`);
  }
  tempUserId = createRes.body.id;

  const asignaRes = await request(app)
    .put(`/api/usuarios/${tempUserId}/proyectos`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ project_ids: [testProjectId] });
  if (asignaRes.status !== 200) {
    throw new Error(`No se pudo asignar la obra al usuario temporal: ${asignaRes.status} ${JSON.stringify(asignaRes.body)}`);
  }

  const permisoRes = await request(app)
    .put(`/api/permisos/${tempUserId}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ proyecto_id: null, permisos: [{ seccion: 'insumos', puede_ver: true }] });
  if (permisoRes.status !== 200) {
    throw new Error(`No se pudo otorgar el permiso: ${permisoRes.status} ${JSON.stringify(permisoRes.body)}`);
  }

  tempToken = await login(tempUsuario, tempPassword);
});

afterAll(async () => {
  if (tempUserId) {
    await request(app).delete(`/api/usuarios/${tempUserId}`).set('Authorization', `Bearer ${adminToken}`);
  }
  if (testProjectId) {
    // ON DELETE CASCADE se lleva insumos y usuario_proyectos de esta obra.
    await db.pool.query('DELETE FROM proyectos WHERE id = $1', [testProjectId]);
  }
  await db.pool.end();
});

describe('Catálogo de Insumos — toggle incluirManoObra', () => {
  it('sin el toggle (comportamiento actual, default): excluye los MO*', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/insumos`)
      .set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body.every((i) => !i.codigo.startsWith('MO'))).toBe(true);
  });

  it('con el toggle activado: incluye los MO* también', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/insumos?incluirManoObra=true`)
      .set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(5);
    expect(res.body.filter((i) => i.codigo.startsWith('MO'))).toHaveLength(2);
  });

  it('categorías sin el toggle: no incluye "Cuadrillas" (categoría exclusiva de MO*)', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/insumos/categorias`)
      .set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(['Acero']);
  });

  it('categorías con el toggle activado: incluye "Cuadrillas"', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/insumos/categorias?incluirManoObra=true`)
      .set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(200);
    expect(res.body.sort()).toEqual(['Acero', 'Cuadrillas']);
  });

  it('regresión: el buscador de Mapeo (incluirManoObra=1) sigue viendo los 5 insumos sin cambios', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/insumos?incluirManoObra=1`)
      .set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(5);
  });
});
