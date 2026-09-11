// Integration tests para GET /api/clientes/:id/erogado-real y
// GET /api/erogado-real-global (prompt-avance-valorizado-vs-erogado-real.md).
// Corren contra la base real apuntada por DATABASE_URL (Preview en local) —
// solo lectura, sin escribir ningún dato de prueba: ambos endpoints son
// agregaciones SELECT sobre datos ya existentes, mismo criterio que
// tests/costos-dashboard.test.js para el bloque "solo lectura".
//
// Los 2 checkpoints pedidos explícitamente por el prompt se verifican
// comparando el endpoint agregado contra getFinanzasResumenData() (server/
// finanzas.js, ya validada en producción) llamada una vez por obra — ese
// patrón N+1 es aceptable AQUÍ porque es un test, no el código de
// producción (que sí usa queries batched, ver getErogadoRealAgregado).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';
import { getFinanzasResumenData } from '../server/finanzas.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let adminToken;
let tempUserId;
let tempToken;
let clienteIdConObras;
const tempUsuario = `qa_erogado_real_${Date.now()}`;
const tempPassword = 'QaErogadoRealTemp123!';

async function login(usuario, password) {
  const res = await request(app).post('/api/auth/login').send({ usuario, password });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`Login falló para ${usuario}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

function sumar(campo, resultados) {
  return Number(resultados.reduce((s, r) => s + Number(r.erogado_real[campo]), 0).toFixed(2));
}

// Tolerancia de 1 centavo por obra sumada: getErogadoRealAgregado (producción)
// suma los montos crudos de TODAS las obras y redondea una sola vez al final;
// esta suite de referencia solo puede sumar los valores YA redondeados que
// devuelve getFinanzasResumenData por obra (no expone el crudo sin redondear
// sin modificar esa función, Forbidden Action del prompt) — sumar N números
// ya redondeados a centavo puede divergir hasta N×0.005 del resultado de
// redondear una sola vez al final. No es un bug de ninguno de los 2 lados,
// es el orden de redondeo — confirmado con el caso real (26366.56 vs
// 26366.57 sumando todas las obras de Preview).
function tolerancia(numObras) {
  return Math.max(0.01, numObras * 0.005);
}

beforeAll(async () => {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada — no se puede correr la suite.');
  adminToken = await login(ADMIN_USER, ADMIN_PASSWORD);

  const createRes = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA Erogado Real', usuario: tempUsuario, password: tempPassword, puesto: 'residente' });
  if (createRes.status !== 201 && createRes.status !== 200) {
    throw new Error(`No se pudo crear el usuario temporal: ${createRes.status} ${JSON.stringify(createRes.body)}`);
  }
  tempUserId = createRes.body.id;
  tempToken = await login(tempUsuario, tempPassword);

  // Cliente real con al menos 2 obras, para que la reconciliación de sumas
  // sea una verificación real (no un caso trivial de 0 o 1 obra).
  const { rows } = await db.pool.query(`
    SELECT cliente_id FROM proyectos WHERE cliente_id IS NOT NULL
    GROUP BY cliente_id HAVING COUNT(*) >= 2 ORDER BY cliente_id LIMIT 1
  `);
  if (!rows[0]) throw new Error('No hay ningún cliente con >=2 obras contra el cual correr la suite.');
  clienteIdConObras = rows[0].cliente_id;
});

afterAll(async () => {
  if (tempUserId) {
    await request(app).delete(`/api/usuarios/${tempUserId}`).set('Authorization', `Bearer ${adminToken}`);
  }
  await db.pool.end();
});

describe('GET /api/clientes/:id/erogado-real', () => {
  it('requiere autenticación', async () => {
    const res = await request(app).get(`/api/clientes/${clienteIdConObras}/erogado-real`);
    expect(res.status).toBe(401);
  });

  it('usuario no-admin/desarrollador recibe 403 (mismo criterio que Avance por cliente)', async () => {
    const res = await request(app)
      .get(`/api/clientes/${clienteIdConObras}/erogado-real`)
      .set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(403);
  });

  it('ID de cliente inválido (no numérico) recibe 400', async () => {
    const res = await request(app)
      .get('/api/clientes/abc/erogado-real')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it('cliente inexistente recibe 404', async () => {
    const res = await request(app)
      .get('/api/clientes/999999999/erogado-real')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it('admin recibe 200 con la forma esperada (misma forma que Finanzas por obra)', async () => {
    const res = await request(app)
      .get(`/api/clientes/${clienteIdConObras}/erogado-real`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('avance_valorizado.pct');
    expect(res.body).toHaveProperty('avance_valorizado.monto');
    expect(res.body).toHaveProperty('erogado_real.total_pagado');
    expect(res.body).toHaveProperty('erogado_real.total_comprometido_no_pagado');
    expect(res.body).toHaveProperty('erogado_real.maquinaria_combustible');
    expect(res.body).toHaveProperty('erogado_real.maquinaria_mantenimiento');
    expect(res.body).toHaveProperty('brecha.monto');
    expect(res.body).toHaveProperty('brecha.descripcion');
    expect(res.body).toHaveProperty('presupuesto_total');
  });

  it('checkpoint: la suma de Erogado Real de todas las obras del cliente coincide con la agregación', async () => {
    const { rows: obras } = await db.pool.query('SELECT id FROM proyectos WHERE cliente_id = $1', [clienteIdConObras]);
    const porObra = await Promise.all(obras.map((o) => getFinanzasResumenData(o.id)));

    const res = await request(app)
      .get(`/api/clientes/${clienteIdConObras}/erogado-real`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const esperadoPagado = sumar('total_pagado', porObra);
    const esperadoComprometido = sumar('total_comprometido_no_pagado', porObra);
    const esperadoCombustible = sumar('maquinaria_combustible', porObra);
    const esperadoMantenimiento = sumar('maquinaria_mantenimiento', porObra);
    const esperadoPresupuesto = Number(porObra.reduce((s, r) => s + Number(r.presupuesto_total), 0).toFixed(2));
    const tol = tolerancia(porObra.length);

    expect(Math.abs(res.body.erogado_real.total_pagado - esperadoPagado)).toBeLessThanOrEqual(tol);
    expect(Math.abs(res.body.erogado_real.total_comprometido_no_pagado - esperadoComprometido)).toBeLessThanOrEqual(tol);
    expect(Math.abs(res.body.erogado_real.maquinaria_combustible - esperadoCombustible)).toBeLessThanOrEqual(tol);
    expect(Math.abs(res.body.erogado_real.maquinaria_mantenimiento - esperadoMantenimiento)).toBeLessThanOrEqual(tol);
    expect(Math.abs(res.body.presupuesto_total - esperadoPresupuesto)).toBeLessThanOrEqual(tol);
  });
});


describe('GET /api/erogado-real-global', () => {
  it('requiere autenticación', async () => {
    const res = await request(app).get('/api/erogado-real-global');
    expect(res.status).toBe(401);
  });

  it('usuario no-admin/desarrollador recibe 403', async () => {
    const res = await request(app)
      .get('/api/erogado-real-global')
      .set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(403);
  });

  it('admin recibe 200 con la forma esperada', async () => {
    const res = await request(app)
      .get('/api/erogado-real-global')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('erogado_real.total_pagado');
    expect(res.body).toHaveProperty('erogado_real.maquinaria_combustible');
    expect(res.body).toHaveProperty('erogado_real.maquinaria_mantenimiento');
    expect(res.body).toHaveProperty('presupuesto_total');
  });

  it('checkpoint: el global coincide con la suma de todas las obras (todas, no solo un cliente)', async () => {
    const { rows: obras } = await db.pool.query('SELECT id FROM proyectos');
    const porObra = await Promise.all(obras.map((o) => getFinanzasResumenData(o.id)));

    const res = await request(app)
      .get('/api/erogado-real-global')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const esperadoPagado = sumar('total_pagado', porObra);
    const esperadoComprometido = sumar('total_comprometido_no_pagado', porObra);
    const esperadoCombustible = sumar('maquinaria_combustible', porObra);
    const esperadoMantenimiento = sumar('maquinaria_mantenimiento', porObra);
    const tol = tolerancia(porObra.length);

    expect(Math.abs(res.body.erogado_real.total_pagado - esperadoPagado)).toBeLessThanOrEqual(tol);
    expect(Math.abs(res.body.erogado_real.total_comprometido_no_pagado - esperadoComprometido)).toBeLessThanOrEqual(tol);
    expect(Math.abs(res.body.erogado_real.maquinaria_combustible - esperadoCombustible)).toBeLessThanOrEqual(tol);
    expect(Math.abs(res.body.erogado_real.maquinaria_mantenimiento - esperadoMantenimiento)).toBeLessThanOrEqual(tol);
  });
});
