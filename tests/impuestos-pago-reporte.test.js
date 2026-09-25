// Integration test para prompt-impuestos-pago-reporte.md.
//
// Cubre:
// - % de impuestos configurable por obra (meta.porcentaje_impuestos, mismo
//   patrón que porcentaje_fondo_garantia): validación de rango 0-100, y
//   "No configurado" (presupuestado=null) cuando falta el % o el valor del
//   Contrato (meta.total_contratado).
// - GET /impuestos/resumen: presupuestado = total_contratado × pct/100;
//   pendiente_por_pagar = max(presupuestado - pagado, 0); excedente = max
//   contrario, nunca oculto.
// - POST /impuestos/:id/revertir (equivalente a soft-delete en este modelo:
//   la fila del periodo siempre existe, creada por el cron — revertir la
//   regresa a 'pendiente' sin montos, nunca DELETE físico de la fila):
//   permiso granular 'impuestos'.puede_eliminar real (403 sin permiso, 200
//   con permiso), y verificación de que el periodo queda intacto (no se
//   borra la fila) con sus valores en NULL.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let adminToken;
let tesoreriaId, tesoreriaToken;
let testProjectId;
let periodoId;
const stamp = Date.now();
const tesoreriaUsuario = `qa_impuestos_${stamp}`;
const tesoreriaPassword = 'QaImpuestosTemp123!';
let metaOriginal = {};

async function login(usuario, password) {
  const res = await request(app).post('/api/auth/login').send({ usuario, password });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`Login falló para ${usuario}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

async function setMeta(clave, valor) {
  await db.pool.query(
    `INSERT INTO meta (project_id, clave, valor) VALUES ($1, $2, $3)
     ON CONFLICT (project_id, clave) DO UPDATE SET valor = EXCLUDED.valor`,
    [testProjectId, clave, valor === null ? null : String(valor)]
  );
}

beforeAll(async () => {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada — no se puede correr la suite.');
  adminToken = await login(ADMIN_USER, ADMIN_PASSWORD);

  const { rows: projRows } = await db.pool.query('SELECT id FROM proyectos ORDER BY id LIMIT 1');
  if (!projRows[0]) throw new Error('No hay ningún proyecto contra el cual correr la suite.');
  testProjectId = projRows[0].id;

  // Respaldar meta original de este proyecto para las 2 claves que se tocan,
  // y restaurarla en afterAll — no dejar el proyecto de prueba modificado.
  const { rows: metaRows } = await db.pool.query(
    "SELECT clave, valor FROM meta WHERE project_id = $1 AND clave IN ('total_contratado', 'porcentaje_impuestos')",
    [testProjectId]
  );
  metaOriginal = Object.fromEntries(metaRows.map((r) => [r.clave, r.valor]));

  const createRes = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA Impuestos', usuario: tesoreriaUsuario, password: tesoreriaPassword, puesto: 'tesoreria' });
  if (createRes.status !== 201 && createRes.status !== 200) {
    throw new Error(`No se pudo crear el usuario temporal: ${createRes.status} ${JSON.stringify(createRes.body)}`);
  }
  tesoreriaId = createRes.body.id;

  const asignaRes = await request(app)
    .put(`/api/usuarios/${tesoreriaId}/proyectos`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ project_ids: [testProjectId] });
  if (asignaRes.status !== 200) throw new Error(`No se pudo asignar la obra: ${asignaRes.status} ${JSON.stringify(asignaRes.body)}`);

  tesoreriaToken = await login(tesoreriaUsuario, tesoreriaPassword);

  // Periodo de prueba propio (año/mes que no colisiona con datos reales).
  const { rows: insertados } = await db.pool.query(
    `INSERT INTO pagos_impuestos_obra (project_id, periodo_anio, periodo_mes, estado)
     VALUES ($1, 2099, 1, 'pendiente')
     ON CONFLICT (project_id, periodo_anio, periodo_mes) DO UPDATE SET estado = 'pendiente'
     RETURNING id`,
    [testProjectId]
  );
  periodoId = insertados[0].id;
}, 30000);

afterAll(async () => {
  await db.pool.query('DELETE FROM pagos_impuestos_obra WHERE id = $1', [periodoId]);
  await setMeta('total_contratado', metaOriginal.total_contratado ?? null);
  await setMeta('porcentaje_impuestos', metaOriginal.porcentaje_impuestos ?? null);
  if (metaOriginal.total_contratado == null) await db.pool.query("DELETE FROM meta WHERE project_id = $1 AND clave = 'total_contratado'", [testProjectId]);
  if (metaOriginal.porcentaje_impuestos == null) await db.pool.query("DELETE FROM meta WHERE project_id = $1 AND clave = 'porcentaje_impuestos'", [testProjectId]);
  if (tesoreriaId) await request(app).delete(`/api/usuarios/${tesoreriaId}`).set('Authorization', `Bearer ${adminToken}`);
  await db.pool.end();
});

describe('% de impuestos — validación de rango (contrato-confirm)', () => {
  it('rechaza un % fuera de rango con 400, mensaje explícito', async () => {
    const res = await request(app)
      .post('/api/projects/contrato-confirm')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ project_id: testProjectId, porcentaje_impuestos: 150 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/impuestos/i);
  });

  it('acepta un % válido y lo persiste en meta', async () => {
    const res = await request(app)
      .post('/api/projects/contrato-confirm')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ project_id: testProjectId, porcentaje_impuestos: 6.5 });
    expect(res.status).toBe(200);
    const { rows } = await db.pool.query(
      "SELECT valor FROM meta WHERE project_id = $1 AND clave = 'porcentaje_impuestos'",
      [testProjectId]
    );
    expect(Number(rows[0].valor)).toBe(6.5);
  });
});

describe('GET /impuestos/resumen — Presupuestado/Pagado/Pendiente', () => {
  it('presupuestado = null ("No configurado") si falta total_contratado o el %', async () => {
    await setMeta('total_contratado', null);
    await db.pool.query("DELETE FROM meta WHERE project_id = $1 AND clave = 'total_contratado'", [testProjectId]);
    await setMeta('porcentaje_impuestos', 6.5);

    const res = await request(app)
      .get(`/api/projects/${testProjectId}/impuestos/resumen`)
      .set('Authorization', `Bearer ${tesoreriaToken}`);
    expect(res.status).toBe(200);
    expect(res.body.presupuestado).toBeNull();
    expect(res.body.pendiente_por_pagar).toBeNull();
  });

  it('calcula presupuestado = total_contratado × pct/100 cuando ambos están configurados', async () => {
    await setMeta('total_contratado', 1000000);
    await setMeta('porcentaje_impuestos', 6.5);

    const res = await request(app)
      .get(`/api/projects/${testProjectId}/impuestos/resumen`)
      .set('Authorization', `Bearer ${tesoreriaToken}`);
    expect(res.status).toBe(200);
    expect(res.body.presupuestado).toBe(65000);
  });

  it('pendiente_por_pagar nunca negativo; si lo pagado supera lo presupuestado, se reporta como excedente explícito', async () => {
    await setMeta('total_contratado', 100);
    await setMeta('porcentaje_impuestos', 1); // presupuestado = 1
    await db.pool.query(
      `UPDATE pagos_impuestos_obra SET imss_monto = 500, estado = 'cargado' WHERE id = $1`,
      [periodoId]
    );

    const res = await request(app)
      .get(`/api/projects/${testProjectId}/impuestos/resumen`)
      .set('Authorization', `Bearer ${tesoreriaToken}`);
    expect(res.status).toBe(200);
    expect(res.body.presupuestado).toBe(1);
    expect(res.body.pendiente_por_pagar).toBe(0);
    expect(res.body.excedente).toBeGreaterThan(0);
  });
});

describe('POST /impuestos/:id/cargar — regresión: tesorería debe poder capturar', () => {
  // Bug real encontrado al probar el endpoint nuevo (/revertir, que copiaba
  // este mismo patrón de auth.allow()): auth.allow() SIN roles significa
  // "solo admin/desarrollador" (ver auth.js allow(), puestos=[] nunca hace
  // match para otro puesto) — no "cualquier autenticado", pese al nombre.
  // Antes del fix, tesorería/administración (los únicos roles con la
  // pestaña Impuestos, y para quienes checkPermiso('impuestos',
  // 'puede_editar') ya estaba wireado) recibían 403 de auth.allow() antes
  // de siquiera llegar a checkPermiso — la captura de pago estaba
  // efectivamente rota para esos roles en producción.
  it('tesorería con puede_editar=true SÍ puede capturar un pago (antes: 403 de auth.allow(), sin importar el permiso granular)', async () => {
    // El default real de puede_editar para una tesorería recién creada es
    // false (igual que el resto de secciones editables de la app — opt-in,
    // admin lo otorga desde la matriz) — se otorga aquí explícito para que
    // este test aísle el bug de auth.allow() sin depender del default.
    await request(app)
      .put(`/api/permisos/${tesoreriaId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ proyecto_id: null, permisos: [{ seccion: 'impuestos', puede_ver: true, puede_crear: false, puede_editar: true, puede_eliminar: false }] });

    const res = await request(app)
      .post(`/api/projects/${testProjectId}/impuestos/${periodoId}/cargar`)
      .set('Authorization', `Bearer ${tesoreriaToken}`)
      .send({ imss_monto: 123.45, imss_referencia: 'REF-QA' });
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('cargado');
    expect(Number(res.body.imss_monto)).toBe(123.45);
  });
});

describe('POST /impuestos/:id/revertir — permiso granular + soft-delete real', () => {
  it('403 real si se revoca puede_eliminar de la sección impuestos', async () => {
    await request(app)
      .put(`/api/permisos/${tesoreriaId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ proyecto_id: null, permisos: [{ seccion: 'impuestos', puede_ver: true, puede_crear: false, puede_editar: true, puede_eliminar: false }] });

    const res = await request(app)
      .post(`/api/projects/${testProjectId}/impuestos/${periodoId}/revertir`)
      .set('Authorization', `Bearer ${tesoreriaToken}`);
    expect(res.status).toBe(403);

    // La fila sigue existiendo, sin tocar (nunca se borra físicamente).
    const { rows } = await db.pool.query('SELECT * FROM pagos_impuestos_obra WHERE id = $1', [periodoId]);
    expect(rows.length).toBe(1);
  });

  it('200 con puede_eliminar=true: revierte a pendiente, montos en NULL, fila sigue existiendo', async () => {
    await request(app)
      .put(`/api/permisos/${tesoreriaId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ proyecto_id: null, permisos: [{ seccion: 'impuestos', puede_ver: true, puede_crear: false, puede_editar: true, puede_eliminar: true }] });

    // Precondición: el periodo está 'cargado' con datos (del test anterior).
    const pre = await db.pool.query('SELECT estado, imss_monto FROM pagos_impuestos_obra WHERE id = $1', [periodoId]);
    expect(pre.rows[0].estado).toBe('cargado');

    const res = await request(app)
      .post(`/api/projects/${testProjectId}/impuestos/${periodoId}/revertir`)
      .set('Authorization', `Bearer ${tesoreriaToken}`);
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('pendiente');
    expect(res.body.imss_monto).toBeNull();

    const { rows } = await db.pool.query('SELECT * FROM pagos_impuestos_obra WHERE id = $1', [periodoId]);
    expect(rows.length).toBe(1); // nunca DELETE físico
    expect(rows[0].estado).toBe('pendiente');
    expect(rows[0].imss_monto).toBeNull();
    expect(rows[0].imss_referencia).toBeNull();
    expect(rows[0].cargado_por).toBeNull();
    expect(rows[0].cargado_en).toBeNull();
  });

  it('404 en periodo inexistente', async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/impuestos/999999999/revertir`)
      .set('Authorization', `Bearer ${tesoreriaToken}`);
    expect(res.status).toBe(404);
  });
});
