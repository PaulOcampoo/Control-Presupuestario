// Integration tests para el snapshot permanente del reparto de pago por
// cuenta (prompt-importe-tarjeta-nomina-snapshot.md) — reemplaza
// split_cuenta_nomina_pct (leído en vivo) por importe_tarjeta_nomina fijo
// en pesos, con snapshot en nomina_items para que una corrección posterior
// al expediente del trabajador nunca altere una nómina ya calculada
// (motivo del cliente: timbrado de nómina ante el IMSS exige cifra exacta).
//
// Corre contra la base real apuntada por DATABASE_URL (mismo patrón que
// tests/presupuestos-permisos.test.js e
// tests/insumos-toggle-mano-obra.test.js): 2 obras + trabajadores +
// asistencia de prueba dedicados, logueado como admin (bypasea
// checkPermiso/trabajadores_bancarios por diseño, así que puede capturar
// datos bancarios sin necesidad de otorgar permisos_usuario). Limpieza por
// cascada al borrar las obras — verificado sin residuos.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let adminToken;
let projOk;   // obra para los casos "éxito" (importe fijo OK + split sin cambios)
let projExcede; // obra aislada para el caso "excede" (así su rollback no afecta a projOk)
let trabA;    // importe fijo 700, monto_total 1000 -> alterna 300
let trabB;    // importe fijo 5000 (excede monto_total 1000)
let trabC;    // split 70%, sin importe fijo -> comportamiento actual sin cambios
let nomOkId;
let nomExcedeId;

const FECHA_INI = '2026-01-05';
const FECHA_FIN = '2026-01-11';

async function login(usuario, password) {
  const res = await request(app).post('/api/auth/login').send({ usuario, password });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`Login falló para ${usuario}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

async function crearProyecto(nombre) {
  const { rows } = await db.pool.query('INSERT INTO proyectos (nombre) VALUES ($1) RETURNING id', [nombre]);
  return rows[0].id;
}

async function crearTrabajador(projectId, overrides) {
  const res = await request(app)
    .post(`/api/projects/${projectId}/trabajadores`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      nombre: overrides.nombre,
      tipo_pago: 'jornal',
      periodicidad: 'semanal',
      tarifa_jornal: overrides.tarifa_jornal,
      cuenta_alterna: '1234567890',
      split_cuenta_nomina_pct: overrides.split_cuenta_nomina_pct ?? 100,
      importe_tarjeta_nomina: overrides.importe_tarjeta_nomina ?? null,
    });
  if (res.status !== 201) throw new Error(`No se pudo crear trabajador: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id;
}

async function marcarAsistencia(projectId, trabajadorId, fechas) {
  for (const fecha of fechas) {
    await db.pool.query(
      `INSERT INTO asistencia_diaria (project_id, trabajador_id, fecha, presente, estado)
       VALUES ($1,$2,$3,true,'presente')`,
      [projectId, trabajadorId, fecha]
    );
  }
}

async function crearNomina(projectId) {
  const res = await request(app)
    .post(`/api/projects/${projectId}/nominas`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ fecha_inicio: FECHA_INI, fecha_fin: FECHA_FIN });
  if (res.status !== 201) throw new Error(`No se pudo crear la nómina: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id;
}

beforeAll(async () => {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada — no se puede correr la suite de integración.');
  adminToken = await login(ADMIN_USER, ADMIN_PASSWORD);

  projOk = await crearProyecto('QA TEMP - importe tarjeta nomina (ok)');
  projExcede = await crearProyecto('QA TEMP - importe tarjeta nomina (excede)');

  // 2 días * 500 = 1000 de monto_total
  trabA = await crearTrabajador(projOk, { nombre: 'QA Trabajador Fijo OK', tarifa_jornal: 500, importe_tarjeta_nomina: 700 });
  // 2 días * 1000 = 2000 de monto_total, split 70% -> 1400/600
  trabC = await crearTrabajador(projOk, { nombre: 'QA Trabajador Split Sin Cambios', tarifa_jornal: 1000, split_cuenta_nomina_pct: 70 });
  await marcarAsistencia(projOk, trabA, ['2026-01-05', '2026-01-06']);
  await marcarAsistencia(projOk, trabC, ['2026-01-05', '2026-01-06']);
  nomOkId = await crearNomina(projOk);

  // 2 días * 500 = 1000 de monto_total, importe fijo 5000 (excede)
  trabB = await crearTrabajador(projExcede, { nombre: 'QA Trabajador Fijo Excede', tarifa_jornal: 500, importe_tarjeta_nomina: 5000 });
  await marcarAsistencia(projExcede, trabB, ['2026-01-05', '2026-01-06']);
  nomExcedeId = await crearNomina(projExcede);
});

afterAll(async () => {
  // trabajadores.project_id es RESTRICT a propósito (confirmado con Paul,
  // ver server/db.js) — borrar el proyecto directo con trabajadores vivos
  // falla. Orden: nominas (cascada nomina_items) -> trabajadores (cascada
  // trabajador_obras/asistencia_diaria) -> proyectos.
  for (const projectId of [projOk, projExcede].filter(Boolean)) {
    await db.pool.query('DELETE FROM nominas WHERE project_id = $1', [projectId]);
    await db.pool.query('DELETE FROM trabajadores WHERE project_id = $1', [projectId]);
    await db.pool.query('DELETE FROM proyectos WHERE id = $1', [projectId]);
  }
  await db.pool.end();
});

describe('Snapshot de reparto de pago por cuenta (importe_tarjeta_nomina)', () => {
  it('trabajador con importe fijo: calcula y guarda el snapshot correcto en nomina_items', async () => {
    const res = await request(app)
      .post(`/api/projects/${projOk}/nominas/${nomOkId}/calcular`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const { rows } = await db.pool.query(
      'SELECT importe_tarjeta_nomina_snapshot, importe_cuenta_alterna_snapshot, monto_total FROM nomina_items WHERE nomina_id=$1 AND trabajador_id=$2',
      [nomOkId, trabA]
    );
    expect(Number(rows[0].monto_total)).toBe(1000);
    expect(Number(rows[0].importe_tarjeta_nomina_snapshot)).toBe(700);
    expect(Number(rows[0].importe_cuenta_alterna_snapshot)).toBe(300);
  });

  it('trabajador sin importe fijo (split %): snapshot refleja el mismo resultado que el cálculo por % de siempre', async () => {
    const { rows } = await db.pool.query(
      'SELECT importe_tarjeta_nomina_snapshot, importe_cuenta_alterna_snapshot, monto_total FROM nomina_items WHERE nomina_id=$1 AND trabajador_id=$2',
      [nomOkId, trabC]
    );
    expect(Number(rows[0].monto_total)).toBe(2000);
    expect(Number(rows[0].importe_tarjeta_nomina_snapshot)).toBe(1400); // 70% de 2000
    expect(Number(rows[0].importe_cuenta_alterna_snapshot)).toBe(600);
  });

  it('el detalle de nómina (GET) expone el desglose desde el snapshot, no recalculado', async () => {
    const res = await request(app)
      .get(`/api/projects/${projOk}/nominas/${nomOkId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const itemA = res.body.items.find((i) => i.trabajador_id === trabA);
    expect(itemA.monto_cuenta_nomina).toBe(700);
    expect(itemA.monto_cuenta_alterna).toBe(300);
  });

  it('cambiar el importe fijo del trabajador DESPUÉS no altera la nómina ya calculada (inmutabilidad del snapshot)', async () => {
    const editRes = await request(app)
      .put(`/api/projects/${projOk}/trabajadores/${trabA}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'QA Trabajador Fijo OK', tipo_pago: 'jornal', periodicidad: 'semanal', tarifa_jornal: 500, importe_tarjeta_nomina: 999 });
    expect(editRes.status).toBe(200);
    expect(Number(editRes.body.importe_tarjeta_nomina)).toBe(999);

    const res = await request(app)
      .get(`/api/projects/${projOk}/nominas/${nomOkId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    const itemA = res.body.items.find((i) => i.trabajador_id === trabA);
    // Sigue siendo 700/300 — el snapshot ya escrito no se recalcula con el
    // nuevo importe_tarjeta_nomina=999 del expediente.
    expect(itemA.monto_cuenta_nomina).toBe(700);
    expect(itemA.monto_cuenta_alterna).toBe(300);
  });

  it('nómina histórica sin snapshot (calculada antes de este cambio): sigue mostrando el cálculo en vivo por %', async () => {
    // Simula una nomina_items pre-existente (snapshot NULL, como las
    // calculadas antes de este prompt) insertando directo, sin pasar por
    // /calcular — mismo criterio que un dato real ya en producción.
    const nomHistId = await crearNomina(projOk);
    await db.pool.query(
      `INSERT INTO nomina_items (nomina_id, trabajador_id, dias_trabajados, monto_jornal, monto_destajo, monto_total)
       VALUES ($1,$2,2,10000,0,10000)`,
      [nomHistId, trabC]
    );
    const res = await request(app)
      .get(`/api/projects/${projOk}/nominas/${nomHistId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const item = res.body.items[0];
    expect(item.importe_tarjeta_nomina_snapshot ?? null).toBeFalsy();
    // trabC tiene split_cuenta_nomina_pct=70 -> 70% de 10000 = 7000/3000,
    // calculado en vivo porque el snapshot de este item es NULL.
    expect(item.monto_cuenta_nomina).toBe(7000);
    expect(item.monto_cuenta_alterna).toBe(3000);
  });

  it('rechaza el cálculo completo si el importe fijo excede el monto_total de la corrida, con mensaje explícito', async () => {
    const res = await request(app)
      .post(`/api/projects/${projExcede}/nominas/${nomExcedeId}/calcular`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('QA Trabajador Fijo Excede');
    expect(res.body.error).toContain('excede su monto total');

    // La transacción se revierte completa — no debe quedar NINGÚN item de
    // esta nómina (ni siquiera el rechazado) a medio insertar.
    const { rows } = await db.pool.query('SELECT COUNT(*)::int AS n FROM nomina_items WHERE nomina_id=$1', [nomExcedeId]);
    expect(rows[0].n).toBe(0);
  });
});
