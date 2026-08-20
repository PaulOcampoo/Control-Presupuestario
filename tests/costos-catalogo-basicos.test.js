// Integration test para GET /api/costos/catalogo-basicos (prompt-dashboard-
// costos-basicos-implementacion.md, Tarea 2). El bloque "200 admin" NO crea
// ni borra ningún usuario/registro — el endpoint es 100% de solo lectura
// (agregación SELECT sobre datos ya existentes) y el prompt que lo generó
// pidió explícitamente no escribir datos de prueba de básicos contra la base
// de Preview en esta suite (esa es tarea aparte del coordinador). Login como
// admin es la única escritura incidental (tabla login_attempts / último
// acceso), inevitable con auth por token — mismo patrón que el resto de las
// suites de este directorio.
//
// El bloque "403 sin permiso" sí necesita un usuario temporal (checkPermiso
// no se puede ejercer de otra forma sin uno) — mismo patrón autocontenido
// (crear + togglear permiso + borrar en afterAll) que
// tests/costos-dashboard.test.js / tests/presupuestos-permisos.test.js.
// 'costos' es una sección GLOBAL (el endpoint no cuelga de /api/projects/:id,
// no hay requireProject/verificarAccesoObra de por medio), así que a
// diferencia de presupuestos-permisos.test.js no hace falta asignar ninguna
// obra al usuario temporal para que checkPermiso sea el único gate en juego
// — ver checkPermiso/tienePermiso en server/auth.js (con req.project
// undefined, projectId queda null y solo importa la fila proyecto_id IS NULL
// de permisos_usuario).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let adminToken;
let tempUserId;
let tempToken;
const tempUsuario = `qa_catalogo_basicos_${Date.now()}`;
const tempPassword = 'QaCatalogoBasicosTemp123!';

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
    .send({ nombre: 'QA Catalogo Basicos', usuario: tempUsuario, password: tempPassword, puesto: 'residente' });
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

describe('GET /api/costos/catalogo-basicos', () => {
  it('requiere autenticación', async () => {
    const res = await request(app).get('/api/costos/catalogo-basicos');
    expect(res.status).toBe(401);
  });

  it('usuario sin costos.puede_ver recibe 403 real (checkPermiso)', async () => {
    await setPermisoCostos(tempUserId, false);
    const res = await request(app)
      .get('/api/costos/catalogo-basicos')
      .set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(403);
  });

  it('usuario CON costos.puede_ver accede sin 403', async () => {
    await setPermisoCostos(tempUserId, true);
    const res = await request(app)
      .get('/api/costos/catalogo-basicos')
      .set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
  });

  it('admin recibe 200 con catalogo consistente contra la base real (hoy 0 básicos vivos en Preview)', async () => {
    const res = await request(app).get('/api/costos/catalogo-basicos').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.catalogo)).toBe(true);

    // Verdad independiente contra la base real: cuántos códigos únicos de
    // básico vivo existen hoy (mismo criterio DISTINCT ON del endpoint).
    const { rows } = await db.pool.query(
      `SELECT COUNT(DISTINCT codigo)::int AS n FROM matrices_precio_unitario WHERE es_basico = true AND codigo IS NOT NULL`
    );
    expect(res.body.catalogo.length).toBe(rows[0].n);

    // Autoconsistencia de cada fila, cualquiera que sea el estado real de
    // Preview (hoy 0, pero la suite debe seguir siendo válida si más
    // adelante se cargan básicos).
    for (const b of res.body.catalogo) {
      expect(typeof b.codigo).toBe('string');
      expect(b.veces_reusado).toBe(b.usado_en.length);
      expect(b.veces_reusado).toBeGreaterThanOrEqual(0);
      if (b.calculo_completo) {
        expect(typeof b.costo_directo).toBe('number');
      } else {
        expect(b.costo_directo).toBeNull();
      }
      for (const u of b.usado_en) {
        expect(typeof u.obra_nombre).toBe('string');
        if (u.es_basico) {
          expect(u.concepto_id).toBeNull();
        } else {
          expect(u.basico_codigo).toBeNull();
        }
      }
    }

    // Códigos únicos — el DISTINCT ON del backend no debe dejar duplicados.
    const codigos = res.body.catalogo.map((b) => b.codigo);
    expect(new Set(codigos).size).toBe(codigos.length);
  });
});
