// Integration test para la Fase 2 del roadmap "Desarrollador de Vivienda"
// (prompt-fase2-infraestructura-implementacion.md): tabla de mapeo admin-
// curada conceptos_grupo_categoria + 3 endpoints por-obra —
//   GET  /api/projects/:id/grupos-categoria
//   POST /api/projects/:id/grupos-categoria
//   GET  /api/projects/:id/avance-por-categoria
// Mismo patrón autocontenido de tests/presupuestos-permisos.test.js (usuario
// 'residente' temporal, asignado a una obra real vía usuario_proyectos, para
// que verificarAccesoObra pase y el único gate en juego sea checkPermiso).
// Los 3 endpoints reusan la sección de permiso 'avance' tal cual — no hay
// sección nueva que dar de alta.
//
// Datos de prueba: la obra se elige dinámicamente (la que tenga más grupos
// de conceptos activos con datos reales de avance_conceptos ya capturados —
// necesarios para el checkpoint de avance-por-categoria) en vez de un ID fijo,
// para que la suite siga siendo válida si los datos de Preview cambian. Las
// filas que este archivo escribe en conceptos_grupo_categoria (bloque "POST")
// se identifican por creado_por = tempUserId y se borran físicamente en
// afterAll — cero filas remanentes, mismo criterio de "Limpieza de datos de
// prueba" que el resto de la suite (ver CLAUDE.md).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';
import { presupuestoTotalDe } from '../server/finanzas.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let adminToken;
let testProjectId;
let gruposReales = []; // nombres reales de grupo de la obra elegida
let tempUserId;
let tempToken;
const tempUsuario = `qa_infra_vivienda_${Date.now()}`;
const tempPassword = 'QaInfraViviendaTemp123!';

async function login(usuario, password) {
  const res = await request(app).post('/api/auth/login').send({ usuario, password });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`Login falló para ${usuario}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

async function setPermisoAvance(usuarioId, { puedeVer, puedeCrear }) {
  const permiso = { seccion: 'avance' };
  if (puedeVer !== undefined) permiso.puede_ver = puedeVer;
  if (puedeCrear !== undefined) permiso.puede_crear = puedeCrear;
  const res = await request(app)
    .put(`/api/permisos/${usuarioId}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ proyecto_id: null, permisos: [permiso] });
  if (res.status !== 200) {
    throw new Error(`No se pudo setear el permiso: ${res.status} ${JSON.stringify(res.body)}`);
  }
}

beforeAll(async () => {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada — no se puede correr la suite de integración.');
  adminToken = await login(ADMIN_USER, ADMIN_PASSWORD);

  // Obra con más grupos de conceptos activos que YA tengan avance_conceptos
  // capturado — necesario para que el checkpoint numérico de avance-por-
  // categoria (infra + vivienda + sin_clasificar = total) sea significativo
  // (con importe_ejecutado_acumulado > 0 en al menos algún concepto).
  const { rows } = await db.pool.query(`
    SELECT c.project_id, COUNT(DISTINCT c.grupo)::int AS n_grupos
    FROM conceptos c
    JOIN avance_conceptos ac ON ac.concepto_id = c.id
    WHERE c.es_total = 0 AND c.activo = 1 AND c.grupo IS NOT NULL AND TRIM(c.grupo) <> ''
    GROUP BY c.project_id
    HAVING COUNT(DISTINCT c.grupo) >= 3
    ORDER BY n_grupos DESC
    LIMIT 1
  `);
  if (!rows[0]) throw new Error('No hay ninguna obra con >=3 grupos de conceptos y avance_conceptos capturado contra la cual correr la suite.');
  testProjectId = rows[0].project_id;

  const { rows: grupoRows } = await db.pool.query(`
    SELECT DISTINCT grupo FROM conceptos
    WHERE project_id = $1 AND es_total = 0 AND activo = 1 AND grupo IS NOT NULL AND TRIM(grupo) <> ''
    ORDER BY grupo
  `, [testProjectId]);
  gruposReales = grupoRows.map((r) => r.grupo);

  const createRes = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA Infra Vivienda', usuario: tempUsuario, password: tempPassword, puesto: 'residente' });
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

  tempToken = await login(tempUsuario, tempPassword);
});

afterAll(async () => {
  // Borrado físico de cualquier clasificación de prueba que haya quedado
  // (identificada por creado_por = tempUserId, nunca por texto de grupo —
  // así no se toca ninguna clasificación real que ya existiera antes de
  // correr la suite). Se corre ANTES de borrar el usuario para que la FK
  // creado_por siga siendo válida durante el DELETE.
  if (testProjectId && tempUserId) {
    await db.pool.query('DELETE FROM conceptos_grupo_categoria WHERE project_id = $1 AND creado_por = $2', [testProjectId, tempUserId]);
    const { rows: remanentes } = await db.pool.query(
      'SELECT COUNT(*)::int AS n FROM conceptos_grupo_categoria WHERE project_id = $1 AND creado_por = $2',
      [testProjectId, tempUserId]
    );
    if (remanentes[0].n !== 0) throw new Error('Limpieza incompleta: quedaron filas de conceptos_grupo_categoria de prueba.');
  }
  if (tempUserId) {
    const delRes = await request(app).delete(`/api/usuarios/${tempUserId}`).set('Authorization', `Bearer ${adminToken}`);
    const { rows: usuarioRemanente } = await db.pool.query('SELECT id FROM usuarios WHERE id = $1', [tempUserId]);
    if (delRes.status !== 200 || usuarioRemanente.length !== 0) {
      throw new Error(`Limpieza incompleta: usuario temporal ${tempUsuario} (id ${tempUserId}) no se borró (status ${delRes.status}).`);
    }
  }
  await db.pool.end();
});

describe('GET /api/projects/:id/grupos-categoria', () => {
  it('requiere autenticación', async () => {
    const res = await request(app).get(`/api/projects/${testProjectId}/grupos-categoria`);
    expect(res.status).toBe(401);
  });

  it('usuario sin avance.puede_ver recibe 403 real (checkPermiso)', async () => {
    await setPermisoAvance(tempUserId, { puedeVer: false });
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/grupos-categoria`)
      .set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(403);
  });

  it('usuario CON avance.puede_ver accede y ve la misma lista de grupos que la base real', async () => {
    await setPermisoAvance(tempUserId, { puedeVer: true });
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/grupos-categoria`)
      .set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.grupos)).toBe(true);
    const nombres = res.body.grupos.map((g) => g.grupo).sort();
    expect(nombres).toEqual([...gruposReales].sort());
    // Antes de que este archivo escriba nada, ningún grupo de prueba debe
    // aparecer ya clasificado con creado_por = tempUserId (dato limpio).
    for (const g of res.body.grupos) {
      expect(g.categoria === null || g.categoria === 'infraestructura' || g.categoria === 'vivienda').toBe(true);
    }
  });

  it('admin mantiene acceso total sin depender de permisos_usuario', async () => {
    await setPermisoAvance(tempUserId, { puedeVer: false });
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/grupos-categoria`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).not.toBe(403);
  });
});

describe('POST /api/projects/:id/grupos-categoria', () => {
  it('requiere autenticación', async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/grupos-categoria`)
      .send({ clasificaciones: [{ grupo: gruposReales[0], categoria: 'infraestructura' }] });
    expect(res.status).toBe(401);
  });

  it('usuario sin avance.puede_crear recibe 403 real (checkPermiso)', async () => {
    await setPermisoAvance(tempUserId, { puedeVer: true, puedeCrear: false });
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/grupos-categoria`)
      .set('Authorization', `Bearer ${tempToken}`)
      .send({ clasificaciones: [{ grupo: gruposReales[0], categoria: 'infraestructura' }] });
    expect(res.status).toBe(403);
  });

  it('rechaza una categoria inválida con 400', async () => {
    await setPermisoAvance(tempUserId, { puedeVer: true, puedeCrear: true });
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/grupos-categoria`)
      .set('Authorization', `Bearer ${tempToken}`)
      .send({ clasificaciones: [{ grupo: gruposReales[0], categoria: 'comercial' }] });
    expect(res.status).toBe(400);
  });

  it('rechaza un grupo que no existe en el presupuesto activo de esta obra con 400 (sin fabricar basura en la tabla de mapeo)', async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/grupos-categoria`)
      .set('Authorization', `Bearer ${tempToken}`)
      .send({ clasificaciones: [{ grupo: 'GRUPO_QUE_NO_EXISTE_QA_XYZ', categoria: 'infraestructura' }] });
    expect(res.status).toBe(400);
  });

  it('clasifica grupos reales por lote y persiste correctamente (confirmado vía GET)', async () => {
    const clasificaciones = gruposReales.slice(0, Math.min(3, gruposReales.length)).map((grupo, i) => ({
      grupo,
      categoria: i === 0 ? 'infraestructura' : (i === 1 ? 'vivienda' : 'infraestructura'),
    }));
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/grupos-categoria`)
      .set('Authorization', `Bearer ${tempToken}`)
      .send({ clasificaciones });
    expect(res.status).toBe(200);

    const getRes = await request(app)
      .get(`/api/projects/${testProjectId}/grupos-categoria`)
      .set('Authorization', `Bearer ${tempToken}`);
    expect(getRes.status).toBe(200);
    const porGrupo = Object.fromEntries(getRes.body.grupos.map((g) => [g.grupo, g.categoria]));
    for (const c of clasificaciones) {
      expect(porGrupo[c.grupo]).toBe(c.categoria);
    }

    // Verdad independiente contra la base real.
    const { rows } = await db.pool.query(
      'SELECT grupo, categoria FROM conceptos_grupo_categoria WHERE project_id = $1 AND creado_por = $2 ORDER BY grupo',
      [testProjectId, tempUserId]
    );
    expect(rows.length).toBe(clasificaciones.length);
  });

  it('reclasificar a sin_clasificar borra la fila (nunca se persiste sin_clasificar como valor)', async () => {
    const grupo = gruposReales[0];
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/grupos-categoria`)
      .set('Authorization', `Bearer ${tempToken}`)
      .send({ clasificaciones: [{ grupo, categoria: 'sin_clasificar' }] });
    expect(res.status).toBe(200);

    const { rows } = await db.pool.query(
      'SELECT 1 FROM conceptos_grupo_categoria WHERE project_id = $1 AND grupo = $2',
      [testProjectId, grupo]
    );
    expect(rows.length).toBe(0);

    // Re-clasifica de nuevo para que el siguiente bloque (avance-por-
    // categoria) tenga al menos 2 grupos clasificados con datos reales.
    const reclasifica = await request(app)
      .post(`/api/projects/${testProjectId}/grupos-categoria`)
      .set('Authorization', `Bearer ${tempToken}`)
      .send({ clasificaciones: [{ grupo, categoria: 'infraestructura' }] });
    expect(reclasifica.status).toBe(200);
  });
});

describe('GET /api/projects/:id/avance-por-categoria', () => {
  it('requiere autenticación', async () => {
    const res = await request(app).get(`/api/projects/${testProjectId}/avance-por-categoria`);
    expect(res.status).toBe(401);
  });

  it('usuario sin avance.puede_ver recibe 403 real (checkPermiso)', async () => {
    await setPermisoAvance(tempUserId, { puedeVer: false });
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/avance-por-categoria`)
      .set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(403);
  });

  it('infraestructura + vivienda + sin_clasificar suman exactamente el total, y el total coincide con el motor de avance ya existente (avances/:semana/conceptos) sin tocarlo', async () => {
    await setPermisoAvance(tempUserId, { puedeVer: true });
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/avance-por-categoria`)
      .set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(200);

    const { categorias, total, grupos_sin_clasificar } = res.body;
    expect(categorias.infraestructura).toBeDefined();
    expect(categorias.vivienda).toBeDefined();
    expect(categorias.sin_clasificar).toBeDefined();

    // La partición debe sumar EXACTO al total, en las 3 dimensiones clave —
    // esta es la evidencia numérica que exige el checkpoint del prompt.
    const sumaImportePresupuesto = categorias.infraestructura.importe_presupuesto
      + categorias.vivienda.importe_presupuesto + categorias.sin_clasificar.importe_presupuesto;
    const sumaImporteEjecutado = categorias.infraestructura.importe_ejecutado_acumulado
      + categorias.vivienda.importe_ejecutado_acumulado + categorias.sin_clasificar.importe_ejecutado_acumulado;
    const sumaConceptos = categorias.infraestructura.n_conceptos + categorias.vivienda.n_conceptos + categorias.sin_clasificar.n_conceptos;
    const sumaGrupos = categorias.infraestructura.n_grupos + categorias.vivienda.n_grupos + categorias.sin_clasificar.n_grupos;

    expect(sumaImportePresupuesto).toBeCloseTo(total.importe_presupuesto, 2);
    expect(sumaImporteEjecutado).toBeCloseTo(total.importe_ejecutado_acumulado, 2);
    expect(sumaConceptos).toBe(total.n_conceptos);
    expect(sumaGrupos).toBe(total.n_grupos);

    // Al menos un grupo real quedó clasificado en el bloque anterior — nunca
    // debe verse como si todo siguiera sin_clasificar.
    expect(categorias.infraestructura.n_grupos + categorias.vivienda.n_grupos).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(grupos_sin_clasificar)).toBe(true);
    expect(categorias.sin_clasificar.n_grupos).toBe(grupos_sin_clasificar.length);

    // Cross-check contra el motor de avance YA EXISTENTE, sin tocarlo: suma
    // manual de importe_ejecutado_acumulado de avances/:semana/conceptos
    // (última semana con datos) debe coincidir con total.importe_ejecutado_
    // acumulado — misma fórmula, agregada distinto.
    const { rows: semanaRows } = await db.pool.query(
      'SELECT MAX(semana)::int AS semana FROM avance_conceptos ac JOIN conceptos c ON c.id = ac.concepto_id WHERE c.project_id = $1',
      [testProjectId]
    );
    const ultimaSemana = semanaRows[0].semana;
    expect(ultimaSemana).not.toBeNull();

    const conceptosRes = await request(app)
      .get(`/api/projects/${testProjectId}/avances/${ultimaSemana}/conceptos`)
      .set('Authorization', `Bearer ${tempToken}`);
    expect(conceptosRes.status).toBe(200);
    const sumaMotorExistente = conceptosRes.body.items.reduce((acc, it) => acc + Number(it.importe_ejecutado_acumulado || 0), 0);
    expect(total.importe_ejecutado_acumulado).toBeCloseTo(sumaMotorExistente, 2);

    // Regresión del bug real (revisión de código independiente contra
    // Preview): antes, total.pct_avance salía de dividir entre
    // SUM(conceptos.importe) crudo en vez de presupuestoTotalDe(pid) — la
    // MISMA función que ya usa PUT /avances/:semana/conceptos (server/
    // app.js:8270) para persistir avance_financiero_real. presupuestoTotalDe()
    // prefiere proyectos.meta.total_sin_iva cuando existe, que en la mayoría
    // de las obras reales NO coincide con SUM(conceptos.importe) — para la
    // obra 30 ("RED HIDRAULICA") la divergencia era de 3.3x (13.42% vs
    // 44.54%). Se recalcula aquí el % "motor real" con la MISMA función
    // (presupuestoTotalDe, server/finanzas.js:16 — no un valor hardcodeado)
    // para que la suite detecte si vuelve a desalinearse.
    const presupuestoTotalReal = await presupuestoTotalDe(testProjectId);
    expect(presupuestoTotalReal).toBeGreaterThan(0);
    const pctAvanceMotorReal = Math.max(0, Math.min(100, (total.importe_ejecutado_acumulado / presupuestoTotalReal) * 100));
    expect(total.pct_avance).toBeCloseTo(pctAvanceMotorReal, 6);
  });

  it('admin mantiene acceso total sin depender de permisos_usuario', async () => {
    await setPermisoAvance(tempUserId, { puedeVer: false });
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/avance-por-categoria`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
  });
});
