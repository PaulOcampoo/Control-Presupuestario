// Integration test para GET /api/costos/catalogo-basicos (prompt-dashboard-
// costos-basicos-implementacion.md, Tarea 2). El bloque "200 admin" original
// NO creaba ni borraba ningún usuario/registro de básico — el prompt que lo
// generó pidió explícitamente no escribir datos de prueba de básicos contra
// la base de Preview en esa primera pasada ("esa es tarea aparte del
// coordinador"). Esa tarea aparte es justo la que agrega el bloque de
// fixture más abajo (crearFixtureReuso/borrarFixtureReuso): un bug real
// (INNER JOIN proyectos ON m.project_id en la query de "usos" del endpoint)
// hacía que veces_reusado/usado_en dieran 0/vacío para el caso de reuso más
// común (un básico referenciado desde el análisis NORMAL de un concepto
// real) — solo se podía cubrir con datos reales, así que ahora sí se
// escriben (con prefijo QA_FIX_BASICOS_ inconfundible, timestamp para no
// colisionar entre corridas, y borrado físico completo en afterAll — ver
// CLAUDE.md, "Limpieza de datos de prueba"). Login como admin es la única
// escritura incidental de más (tabla login_attempts / último acceso),
// inevitable con auth por token — mismo patrón que el resto de las suites de
// este directorio.
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

// Fixture para el caso de regresión de veces_reusado/usado_en (bug real:
// el JOIN de la query de "usos" era INNER JOIN proyectos ON m.project_id,
// que descarta en silencio cualquier fila donde la matriz consumidora m es
// un análisis NORMAL (es_basico=false, project_id NULL — la obra se
// resuelve vía c.project_id, no vía m.project_id). Ese es el caso de reuso
// más común en la vida real (un básico referenciado desde el análisis de
// un concepto real), así que veces_reusado/usado_en quedaban en 0/vacío
// para casi todo reuso real aunque costo_directo siguiera correcto. Sufijo
// timestamp + prefijo inconfundible QA_FIX_BASICOS_, mismo criterio que
// tempUsuario arriba — se crea en beforeAll y se borra físicamente en
// afterAll, sin excepciones (ver CLAUDE.md, "Limpieza de datos de prueba").
const sufijo = Date.now();
const CODIGO_BASICO = `QA_FIX_BASICOS_COD_${sufijo}`;
let fixture = null; // { clienteId, obraAId, obraBId, conceptoId, basicoAId, basicoBId, matrizNormalId, renglonId }

async function crearFixtureReuso() {
  const { rows: [{ id: clienteId }] } = await db.pool.query(
    `INSERT INTO clientes (nombre) VALUES ($1) RETURNING id`, [`QA_FIX_BASICOS_CLIENTE_${sufijo}`]
  );
  const { rows: [{ id: obraAId }] } = await db.pool.query(
    `INSERT INTO proyectos (nombre, cliente_id) VALUES ($1, $2) RETURNING id`, [`QA_FIX_BASICOS_OBRA_A_${sufijo}`, clienteId]
  );
  const { rows: [{ id: obraBId }] } = await db.pool.query(
    `INSERT INTO proyectos (nombre, cliente_id) VALUES ($1, $2) RETURNING id`, [`QA_FIX_BASICOS_OBRA_B_${sufijo}`, clienteId]
  );
  const { rows: [{ id: conceptoId }] } = await db.pool.query(
    `INSERT INTO conceptos (project_id, codigo, concepto, unidad, es_total, activo)
     VALUES ($1, $2, 'QA concepto de prueba', 'PZA', 0, 1) RETURNING id`, [obraAId, `QA_FIX_BASICOS_CONCEPTO_${sufijo}`]
  );
  // Básico compartido por código entre 2 obras (A y B) — solo el de la
  // obra A tiene un uso real; sirve también para probar que el dedupe por
  // código del catálogo (DISTINCT ON) no rompe la agregación de usado_en.
  const { rows: [{ id: basicoAId }] } = await db.pool.query(
    `INSERT INTO matrices_precio_unitario (es_basico, project_id, codigo, descripcion, unidad)
     VALUES (true, $1, $2, 'QA basico de prueba', 'M3') RETURNING id`, [obraAId, CODIGO_BASICO]
  );
  const { rows: [{ id: basicoBId }] } = await db.pool.query(
    `INSERT INTO matrices_precio_unitario (es_basico, project_id, codigo, descripcion, unidad)
     VALUES (true, $1, $2, 'QA basico de prueba (obra B)', 'M3') RETURNING id`, [obraBId, CODIGO_BASICO]
  );
  // Un insumo por categoría real (calcularMatrizNeodata marca calculo_completo
  // = false si a UNA categoría le falta cualquier renglón), reusado en los
  // renglones de ambos básicos — solo así el DISTINCT ON del catálogo (que
  // puede elegir cualquiera de los dos como representativo según
  // p.creado_en) resuelve costo_directo real en vez de caer en la rama
  // "incompleta" y cruzar con la aserción de autoconsistencia del test de
  // arriba (costo_directo debe ser number si calculo_completo, null si no).
  const insumoIds = {};
  for (const [categoria, sufijoInsumo] of [['MATERIALES', 'MAT'], ['MANO DE OBRA', 'MO'], ['EQUIPO Y HERRAMIENTA', 'EQ']]) {
    const { rows: [{ id }] } = await db.pool.query(
      `INSERT INTO insumos (project_id, codigo, concepto, categoria, unidad, precio_presupuesto)
       VALUES ($1, $2, 'QA insumo de prueba', $3, 'PZA', 10) RETURNING id`,
      [obraAId, `QA_FIX_BASICOS_INS_${sufijoInsumo}_${sufijo}`, categoria]
    );
    insumoIds[categoria] = id;
  }
  const renglonIds = [];
  for (const basicoId of [basicoAId, basicoBId]) {
    let orden = 0;
    for (const categoria of ['MATERIALES', 'MANO DE OBRA', 'EQUIPO Y HERRAMIENTA']) {
      const { rows: [{ id }] } = await db.pool.query(
        `INSERT INTO matriz_precio_renglones (matriz_id, categoria, tipo, insumo_id, cantidad, operador, orden)
         VALUES ($1, $2, 'insumo', $3, 1, '*', $4) RETURNING id`,
        [basicoId, categoria, insumoIds[categoria], orden++]
      );
      renglonIds.push(id);
    }
  }
  // Matriz NORMAL (es_basico=false, project_id NULL) del concepto en obra A
  // — exactamente el caso que el JOIN roto descartaba.
  const { rows: [{ id: matrizNormalId }] } = await db.pool.query(
    `INSERT INTO matrices_precio_unitario (concepto_id, es_basico) VALUES ($1, false) RETURNING id`, [conceptoId]
  );
  const { rows: [{ id: renglonBasicoRefId }] } = await db.pool.query(
    `INSERT INTO matriz_precio_renglones (matriz_id, categoria, tipo, cantidad, operador, basico_matriz_id, orden)
     VALUES ($1, 'BASICOS', 'basico_ref', 1, '*', $2, 0) RETURNING id`, [matrizNormalId, basicoAId]
  );
  renglonIds.push(renglonBasicoRefId);
  return {
    clienteId, obraAId, obraBId, conceptoId, basicoAId, basicoBId, matrizNormalId,
    insumoIds: Object.values(insumoIds), renglonIds,
  };
}

async function borrarFixtureReuso(f) {
  if (!f) return;
  for (const id of f.renglonIds) {
    await db.pool.query('DELETE FROM matriz_precio_renglones WHERE id = $1', [id]);
  }
  await db.pool.query('DELETE FROM matrices_precio_unitario WHERE id = $1', [f.matrizNormalId]);
  await db.pool.query('DELETE FROM matrices_precio_unitario WHERE id = $1', [f.basicoAId]);
  await db.pool.query('DELETE FROM matrices_precio_unitario WHERE id = $1', [f.basicoBId]);
  for (const id of f.insumoIds) {
    await db.pool.query('DELETE FROM insumos WHERE id = $1', [id]);
  }
  await db.pool.query('DELETE FROM conceptos WHERE id = $1', [f.conceptoId]);
  await db.pool.query('DELETE FROM proyectos WHERE id = $1', [f.obraAId]);
  await db.pool.query('DELETE FROM proyectos WHERE id = $1', [f.obraBId]);
  await db.pool.query('DELETE FROM clientes WHERE id = $1', [f.clienteId]);
}

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

  fixture = await crearFixtureReuso();
});

afterAll(async () => {
  if (tempUserId) {
    await request(app).delete(`/api/usuarios/${tempUserId}`).set('Authorization', `Bearer ${adminToken}`);
  }
  await borrarFixtureReuso(fixture);
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

  it('cuenta y lista el reuso de un básico desde un análisis NORMAL de concepto (regresión del bug de INNER JOIN)', async () => {
    const res = await request(app).get('/api/costos/catalogo-basicos').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const entry = res.body.catalogo.find((b) => b.codigo === CODIGO_BASICO);
    expect(entry).toBeDefined();
    expect(entry.veces_reusado).toBe(1);
    expect(entry.usado_en).toHaveLength(1);

    const uso = entry.usado_en[0];
    expect(uso.matriz_id).toBe(fixture.matrizNormalId);
    // El caso que rompía con INNER JOIN proyectos ON m.project_id: la matriz
    // consumidora es un análisis normal (es_basico=false, sin project_id
    // propio) — la obra debe resolverse vía el concepto (c.project_id), no
    // perderse.
    expect(uso.es_basico).toBe(false);
    expect(uso.concepto_id).toBe(fixture.conceptoId);
    expect(uso.obra_id).toBe(fixture.obraAId);
    expect(uso.obra_nombre).toBe(`QA_FIX_BASICOS_OBRA_A_${sufijo}`);
  });
});
