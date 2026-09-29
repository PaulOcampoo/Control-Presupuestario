// Integration: registro de jornada (prompt-registro-jornada-nomina.md).
// Corre contra la BD de Preview vía endpoints reales; crea fixtures propios
// y los borra en afterAll (log de jornada: borrado físico SOLO aquí, vía DB,
// porque la app no expone DELETE — por diseño).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const sfx = Date.now();
const pw = 'QaJornadaTemp123!';
let adminToken, resToken, caboToken, resId, caboId, clienteId, obra1, obra2, w1, w2, wCorrida, wOtraObra;
const fmt = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date(ms));
const hoy = fmt(Date.now());
const ayer = fmt(Date.now() - 86400000);
const manana = fmt(Date.now() + 86400000);
const A = (t) => ({ Authorization: `Bearer ${t}` });
const full = { hora_entrada: '08:00', hora_salida_comida: '13:00', hora_regreso_comida: '14:00', hora_salida: '18:00' };

async function login(usuario, password) {
  const r = await request(app).post('/api/auth/login').send({ usuario, password });
  if (r.status !== 200 || !r.body.token) throw new Error(`login ${usuario}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
}
async function mkUser(puesto, obras) {
  const u = `qa_jor_${puesto}_${sfx}`;
  const r = await request(app).post('/api/usuarios').set(A(adminToken)).send({ nombre: `QA Jornada ${puesto}`, usuario: u, password: pw, puesto });
  if (![200, 201].includes(r.status)) throw new Error(`user ${puesto}: ${r.status} ${JSON.stringify(r.body)}`);
  await request(app).put(`/api/usuarios/${r.body.id}/proyectos`).set(A(adminToken)).send({ project_ids: obras });
  await request(app).put(`/api/permisos/${r.body.id}`).set(A(adminToken))
    .send({ proyecto_id: null, permisos: [{ seccion: 'nominas', puede_ver: true, puede_editar: true, puede_crear: true }] });
  return { id: r.body.id, token: await login(u, pw) };
}
async function mkTrab(obra, nombre) {
  const r = await request(app).post(`/api/projects/${obra}/trabajadores`).set(A(adminToken))
    .send({ nombre, puesto: 'Peón', tipo_pago: 'jornal', tarifa_jornal: 500, periodicidad: 'semanal' });
  if (![200, 201].includes(r.status)) throw new Error(`trab: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}
const put = (t, obra, w, fecha, body) => request(app).put(`/api/projects/${obra}/asistencia-jornada/${w}/${fecha}`).set(A(t)).send(body);
async function marcar(obra, w, fecha, estado) {
  await db.pool.query(
    `INSERT INTO asistencia_diaria (project_id, trabajador_id, fecha, presente, estado) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (project_id, trabajador_id, fecha) DO UPDATE SET estado=EXCLUDED.estado, presente=EXCLUDED.presente`,
    [obra, w, fecha, estado === 'presente', estado]);
}

beforeAll(async () => {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada');
  adminToken = await login(ADMIN_USER, ADMIN_PASSWORD);
  const c = await request(app).post('/api/clientes').set(A(adminToken)).send({ nombre: `QA Jornada ${sfx}` });
  clienteId = c.body.id;
  for (const n of ['QA J Obra 1', 'QA J Obra 2']) {
    const r = await request(app).post('/api/projects/contrato-confirm').set(A(adminToken)).send({ cliente_id: clienteId, nombre: n });
    if (r.status !== 200) throw new Error(`obra: ${r.status} ${JSON.stringify(r.body)}`);
  }
  const { rows } = await db.pool.query('SELECT id FROM proyectos WHERE cliente_id=$1 ORDER BY id', [clienteId]);
  [obra1, obra2] = rows.map((o) => o.id);
  ({ id: resId, token: resToken } = await mkUser('residente', [obra1]));
  ({ id: caboId, token: caboToken } = await mkUser('cabo', [obra1]));
  w1 = await mkTrab(obra1, 'QA Jornada Uno');
  w2 = await mkTrab(obra1, 'QA Jornada Dos');
  wCorrida = await mkTrab(obra1, 'QA Jornada Corrida');
  wOtraObra = await mkTrab(obra2, 'QA Jornada Otra Obra');
  await db.pool.query("UPDATE trabajadores SET tipo_jornada='corrida' WHERE id=$1", [wCorrida]);
}, 60000);

afterAll(async () => {
  await db.pool.query('DELETE FROM asistencia_jornada_log WHERE jornada_id IN (SELECT id FROM asistencia_jornada WHERE project_id = ANY($1))', [[obra1, obra2]]);
  await db.pool.query('DELETE FROM asistencia_jornada WHERE project_id = ANY($1)', [[obra1, obra2]]);
  await db.pool.query('DELETE FROM asistencia_diaria WHERE project_id = ANY($1)', [[obra1, obra2]]);
  await db.pool.query('DELETE FROM trabajador_obras WHERE project_id = ANY($1)', [[obra1, obra2]]);
  await db.pool.query('DELETE FROM trabajadores WHERE project_id = ANY($1)', [[obra1, obra2]]);
  for (const id of [resId, caboId]) if (id) await request(app).delete(`/api/usuarios/${id}`).set(A(adminToken));
  for (const o of [obra1, obra2]) if (o) await request(app).delete(`/api/projects/${o}`).set(A(adminToken));
  if (clienteId) await request(app).delete(`/api/clientes/${clienteId}`).set(A(adminToken));
  await db.pool.end();
}, 60000);

describe('PUT jornada — validaciones y seguridad', () => {
  it('400 horas desordenadas', async () => {
    expect((await put(resToken, obra1, w1, hoy, { ...full, hora_regreso_comida: '12:00' })).status).toBe(400);
  });
  it('400 fecha futura', async () => {
    expect((await put(adminToken, obra1, w1, manana, full)).status).toBe(400);
  });
  it('403 residente en día pasado', async () => {
    expect((await put(resToken, obra1, w1, ayer, full)).status).toBe(403);
  });
  it('403 proyecto no asignado (residente en obra2)', async () => {
    expect((await put(resToken, obra2, wOtraObra, hoy, full)).status).toBe(403);
  });
  it('404 trabajador de otra obra (IDOR)', async () => {
    expect((await put(resToken, obra1, wOtraObra, hoy, full)).status).toBe(404);
  });
  it('409 día en falta', async () => {
    await marcar(obra1, w2, hoy, 'falta_injustificada');
    const r = await put(resToken, obra1, w2, hoy, full);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/presente/);
  });
});

describe('PUT jornada — captura, edición y bitácora', () => {
  it('primera captura (sin registro previo) -> presente, sin motivo', async () => {
    const r = await put(resToken, obra1, w1, hoy, full);
    expect(r.status).toBe(200);
    expect(r.body.jornada).toMatchObject({ completo: true, trabajadas_min: 540, extra_min: 60 });
    const { rows } = await db.pool.query('SELECT estado FROM asistencia_diaria WHERE project_id=$1 AND trabajador_id=$2 AND fecha=$3', [obra1, w1, hoy]);
    expect(rows[0].estado).toBe('presente');
  });
  it('cabo también puede capturar (corrida)', async () => {
    const r = await put(caboToken, obra1, wCorrida, hoy, { hora_entrada: '07:00', hora_salida: '15:00' });
    expect(r.status).toBe(200);
    expect(r.body.jornada).toMatchObject({ trabajadas_min: 480, extra_min: 0 });
  });
  it('400 editar un valor existente sin motivo', async () => {
    expect((await put(resToken, obra1, w1, hoy, { ...full, hora_salida: '19:00' })).status).toBe(400);
  });
  it('edición con motivo -> 200 y fila en el log', async () => {
    const r = await put(resToken, obra1, w1, hoy, { ...full, hora_salida: '19:00', motivo: 'Se quedó a terminar colado' });
    expect(r.status).toBe(200);
    expect(r.body.jornada.editado).toBe(true);
    const { rows } = await db.pool.query(
      `SELECT l.campo, l.valor_anterior, l.valor_nuevo, l.motivo FROM asistencia_jornada_log l
       JOIN asistencia_jornada j ON j.id=l.jornada_id WHERE j.trabajador_id=$1`, [w1]);
    console.log('LOG', JSON.stringify(rows));
    expect(rows).toEqual([{ campo: 'hora_salida', valor_anterior: '18:00', valor_nuevo: '19:00', motivo: 'Se quedó a terminar colado' }]);
  });
  it('admin en día pasado: primera captura sin motivo, edición exige motivo', async () => {
    expect((await put(adminToken, obra1, w2, ayer, full)).status).toBe(200);
    expect((await put(adminToken, obra1, w2, ayer, { ...full, hora_salida: '17:00' })).status).toBe(400);
    expect((await put(adminToken, obra1, w2, ayer, { ...full, hora_salida: '17:00', motivo: 'Corrección de captura' })).status).toBe(200);
  });
});

describe('Lote', () => {
  it('aplica solo a quien no tiene registro y no sobrescribe', async () => {
    await marcar(obra1, w2, hoy, 'presente');
    const q = 'SELECT trabajador_id, hora_salida FROM asistencia_jornada WHERE project_id=$1 AND fecha=$2 ORDER BY trabajador_id';
    const antes = await db.pool.query(q, [obra1, hoy]);
    const r = await request(app).post(`/api/projects/${obra1}/asistencia-jornada/lote`).set(A(resToken))
      .send({ trabajadorIds: [w1, w2], ...full, hora_salida: '17:00' });
    expect(r.status).toBe(200);
    expect(r.body.aplicados).toBe(1);
    expect(r.body.omitidos).toHaveLength(1);
    const despues = await db.pool.query(q, [obra1, hoy]);
    console.log('LOTE antes', JSON.stringify(antes.rows), 'despues', JSON.stringify(despues.rows));
    expect(despues.rows.find((x) => x.trabajador_id === w1).hora_salida).toMatch(/^19:00/);
    expect(despues.rows.find((x) => x.trabajador_id === w2).hora_salida).toMatch(/^17:00/);
  });
  it('400 más de 200 y 400 trabajador de otra obra', async () => {
    const ids = Array.from({ length: 201 }, (_, i) => i + 1);
    expect((await request(app).post(`/api/projects/${obra1}/asistencia-jornada/lote`).set(A(resToken)).send({ trabajadorIds: ids, ...full })).status).toBe(400);
    expect((await request(app).post(`/api/projects/${obra1}/asistencia-jornada/lote`).set(A(resToken)).send({ trabajadorIds: [wOtraObra], ...full })).status).toBe(400);
  });
});

describe('Lectura, PATCH y export', () => {
  it('GET día y resumen', async () => {
    const d = await request(app).get(`/api/projects/${obra1}/asistencia-jornada?fecha=${hoy}`).set(A(resToken));
    expect(d.status).toBe(200);
    expect(d.body.trabajadores.find((t) => t.id === w1).jornada.completo).toBe(true);
    const s = await request(app).get(`/api/projects/${obra1}/asistencia-jornada/resumen?desde=${ayer}&hasta=${hoy}`).set(A(resToken));
    expect(s.status).toBe(200);
    expect(s.body.dias.find((x) => x.fecha === hoy).completos).toBeGreaterThanOrEqual(2);
  });
  it('PATCH tipo_jornada: residente 403, admin 200', async () => {
    const body = { tipo_jornada: 'corrida', horas_jornada: 9 };
    expect((await request(app).patch(`/api/projects/${obra1}/trabajadores/${w2}/jornada`).set(A(resToken)).send(body)).status).toBe(403);
    expect((await request(app).patch(`/api/projects/${obra1}/trabajadores/${w2}/jornada`).set(A(adminToken)).send(body)).status).toBe(200);
  });
  it('export: residente 403, admin xlsx', async () => {
    const q = `desde=${ayer}&hasta=${hoy}`;
    expect((await request(app).get(`/api/projects/${obra1}/asistencia-jornada/export?${q}`).set(A(resToken))).status).toBe(403);
    const r = await request(app).get(`/api/projects/${obra1}/asistencia-jornada/export?${q}`).set(A(adminToken))
      .buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/spreadsheetml/);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.body);
    const ws = wb.getWorksheet('Registro de Jornada');
    const filas = [];
    ws.eachRow((row) => filas.push(row.values.slice(1)));
    console.log('EXPORT', JSON.stringify(filas.slice(0, 4)));
    expect(filas[0][0]).toBe('Trabajador');
    expect(filas.length).toBeGreaterThan(1);
  });
});
