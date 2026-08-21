// Integration test para GET /api/costos/dashboard (prompt-dashboard-costos-
// basicos-implementacion.md, Tarea 1). El bloque "200 admin" NO crea ni borra
// ningún usuario/registro — el endpoint es 100% de solo lectura (agregación
// SELECT sobre datos ya existentes) y el prompt que lo generó pidió
// explícitamente no escribir datos de prueba contra la base de Preview.
// Login como admin es la única escritura incidental (tabla login_attempts /
// último acceso), inevitable con auth por token — mismo patrón que el resto
// de las suites de este directorio.
//
// El bloque "403 sin permiso" sí necesita un usuario temporal (checkPermiso
// no se puede ejercer de otra forma sin uno) — mismo patrón autocontenido
// (crear + togglear permiso + borrar en afterAll) que
// tests/presupuestos-permisos.test.js. 'costos' es una sección GLOBAL (el
// endpoint no cuelga de /api/projects/:id, no hay requireProject/
// verificarAccesoObra de por medio), así que a diferencia de esa suite no
// hace falta asignar ninguna obra al usuario temporal para que checkPermiso
// sea el único gate en juego — ver checkPermiso/tienePermiso en
// server/auth.js (con req.project undefined, projectId queda null y solo
// importa la fila proyecto_id IS NULL de permisos_usuario).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let adminToken;
let tempUserId;
let tempToken;
const tempUsuario = `qa_costos_dashboard_${Date.now()}`;
const tempPassword = 'QaCostosDashTemp123!';

async function login(usuario, password) {
  const res = await request(app).post('/api/auth/login').send({ usuario, password });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`Login falló para ${usuario}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

async function setPermisoCostos(usuarioId, puedeVer) {
  const res = await request(app)
    .put(`/api/permisos/${usuarioId}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ proyecto_id: null, permisos: [{ seccion: 'costos', puede_ver: puedeVer }] });
  if (res.status !== 200) {
    throw new Error(`No se pudo setear el permiso: ${res.status} ${JSON.stringify(res.body)}`);
  }
}

beforeAll(async () => {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada — no se puede correr la suite de integración.');
  adminToken = await login(ADMIN_USER, ADMIN_PASSWORD);

  // Usuario temporal 'residente': defaultPermisosParaRol('residente') le da
  // costos.puede_ver=true por default (el tab 'matrices' de residente mapea
  // a la sección 'costos' vía TAB_A_SECCION) — se revoca explícitamente con
  // setPermisoCostos(false) antes de la aserción 403.
  const createRes = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA Costos Dashboard', usuario: tempUsuario, password: tempPassword, puesto: 'residente' });
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

describe('GET /api/costos/dashboard', () => {
  it('requiere autenticación', async () => {
    const res = await request(app).get('/api/costos/dashboard');
    expect(res.status).toBe(401);
  });

  it('usuario sin costos.puede_ver recibe 403 real (checkPermiso)', async () => {
    await setPermisoCostos(tempUserId, false);
    const res = await request(app)
      .get('/api/costos/dashboard')
      .set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(403);
  });

  it('usuario CON costos.puede_ver accede sin 403', async () => {
    await setPermisoCostos(tempUserId, true);
    const res = await request(app)
      .get('/api/costos/dashboard')
      .set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
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
