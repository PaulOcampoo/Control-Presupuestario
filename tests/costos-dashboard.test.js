// Integration test para GET /api/costos/dashboard (prompt-dashboard-costos-
// basicos-implementacion.md, Tarea 1). A diferencia de otras suites de este
// directorio (ver tests/presupuestos-permisos.test.js), esta NO crea ni
// borra ningún usuario/registro — el endpoint es 100% de solo lectura
// (agregación SELECT sobre datos ya existentes) y el prompt que lo generó
// pidió explícitamente no escribir datos de prueba contra la base de Preview.
// Login como admin es la única escritura incidental (tabla login_attempts /
// último acceso), inevitable con auth por token — mismo patrón que el resto
// de las suites de este directorio.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let adminToken;

beforeAll(async () => {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada — no se puede correr la suite de integración.');
  const res = await request(app).post('/api/auth/login').send({ usuario: ADMIN_USER, password: ADMIN_PASSWORD });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`Login falló para ${ADMIN_USER}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  adminToken = res.body.token;
});

afterAll(async () => {
  await db.pool.end();
});

describe('GET /api/costos/dashboard', () => {
  it('requiere autenticación', async () => {
    const res = await request(app).get('/api/costos/dashboard');
    expect(res.status).toBe(401);
  });

  it('admin recibe 200 con los 3 bloques y datos reales autoconsistentes', async () => {
    const res = await request(app).get('/api/costos/dashboard').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const { cobertura_matrices: cob, insumos_inconsistentes: insumos, actividad_reciente: actividad } = res.body;

    // Cobertura de matrices: los 3 números deben cuadrar entre sí.
    expect(cob.total_conceptos).toBeGreaterThanOrEqual(0);
    expect(cob.con_matriz).toBeGreaterThanOrEqual(0);
    expect(cob.sin_matriz).toBeGreaterThanOrEqual(0);
    expect(cob.con_matriz + cob.sin_matriz).toBe(cob.total_conceptos);
    if (cob.total_conceptos > 0) {
      expect(cob.pct_cobertura).toBeCloseTo((100 * cob.con_matriz) / cob.total_conceptos, 5);
    } else {
      expect(cob.pct_cobertura).toBe(0);
    }

    // Insumos con precio inconsistente: cada fila debe respetar el criterio
    // de la query (>5% de diferencia, al menos 2 obras).
    expect(Array.isArray(insumos)).toBe(true);
    for (const it of insumos) {
      expect(it.n_obras).toBeGreaterThanOrEqual(2);
      expect(it.pct_diff).toBeGreaterThan(5);
      expect(it.max_precio).toBeGreaterThanOrEqual(it.min_precio);
    }
    // Viene ordenado descendente por pct_diff.
    for (let i = 1; i < insumos.length; i++) {
      expect(insumos[i - 1].pct_diff).toBeGreaterThanOrEqual(insumos[i].pct_diff);
    }

    // Actividad reciente: solo las 2 acciones del módulo, ordenada desc.
    expect(Array.isArray(actividad)).toBe(true);
    const accionesPermitidas = new Set(['importar_matrices', 'crear_presupuesto_desde_costos']);
    for (const a of actividad) {
      expect(accionesPermitidas.has(a.accion)).toBe(true);
    }
    for (let i = 1; i < actividad.length; i++) {
      expect(new Date(actividad[i - 1].creado_en).getTime()).toBeGreaterThanOrEqual(new Date(actividad[i].creado_en).getTime());
    }
  });
});
