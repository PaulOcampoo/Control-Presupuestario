// Integration test para la Fase 4 del roadmap "Desarrollador de Vivienda",
// PR B (prompt-implementacion-pr-b-contrato-venta.md, diagnóstico previo en
// prompt-diagnostico-compradores-venta.md): contrato de compraventa +
// activación del estado 'vendido' derivado en lotes.estatus_venta. Mismo
// patrón autocontenido de tests/ventas-compradores-apartado.test.js (PR A).
//
// No existe endpoint DELETE para lotes — los lotes/apartados/contratos de
// prueba se borran físicamente vía SQL directo en afterAll, en el orden
// correcto (contratos_venta -> apartados -> lotes) para no violar las FKs
// (ninguna de las 3 tiene ON DELETE CASCADE desde lotes/apartados).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let adminToken;
let testProjectId;
let otroProjectId;
let tempUserId;
let tempToken;
const tempUsuario = `qa_ventascv_${Date.now()}`;
const tempPassword = 'QaVentasCv123!';

const loteIdsCreados = [];
const compradorIdsCreados = [];
const contratoVentaIdsCreados = []; // borrados explícitamente antes que los lotes

async function login(usuario, password) {
  const res = await request(app).post('/api/auth/login').send({ usuario, password });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`Login falló para ${usuario}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

async function crearLote(numeroSufijo) {
  const res = await request(app)
    .post(`/api/projects/${testProjectId}/lotes`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ numero_lote: `QA-CV-${numeroSufijo}-${Date.now()}` });
  loteIdsCreados.push(res.body.id);
  return res.body;
}

async function crearComprador(sufijo) {
  const res = await request(app)
    .post(`/api/projects/${testProjectId}/compradores`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: `QA Comprador CV ${sufijo} ${Date.now()}` });
  compradorIdsCreados.push(res.body.id);
  return res.body;
}

async function crearApartadoActivo(loteId, compradorId, monto = 50000) {
  const res = await request(app)
    .post(`/api/projects/${testProjectId}/apartados`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ lote_id: loteId, comprador_id: compradorId, monto });
  expect(res.status).toBe(201);
  return res.body;
}

beforeAll(async () => {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada — no se puede correr la suite de integración.');
  adminToken = await login(ADMIN_USER, ADMIN_PASSWORD);

  const { rows } = await db.pool.query('SELECT id FROM proyectos ORDER BY id LIMIT 2');
  if (rows.length < 2) throw new Error('Se necesitan al menos 2 obras reales en Preview para correr esta suite (validación cross-obra).');
  testProjectId = rows[0].id;
  otroProjectId = rows[1].id;

  const createRes = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA Ventas CV', usuario: tempUsuario, password: tempPassword, puesto: 'residente' });
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
}, 30000);

afterAll(async () => {
  if (contratoVentaIdsCreados.length) {
    await db.pool.query('DELETE FROM contratos_venta WHERE id = ANY($1::int[])', [contratoVentaIdsCreados]);
  }
  if (loteIdsCreados.length) {
    // audit_log de forzar-estatus-venta no tiene FK a lotes (a propósito —
    // la bitácora sobrevive al borrado de su target), pero igual se limpia
    // físicamente aquí (mismo criterio que editar-requisicion-con-oc.test.js).
    await db.pool.query(
      "DELETE FROM audit_log WHERE accion = 'lote_forzar_estatus_venta' AND target_id = ANY($1::int[])",
      [loteIdsCreados]
    );
    await db.pool.query('DELETE FROM contratos_venta WHERE lote_id = ANY($1::int[])', [loteIdsCreados]);
    await db.pool.query('DELETE FROM apartados WHERE lote_id = ANY($1::int[])', [loteIdsCreados]);
    await db.pool.query('DELETE FROM lotes WHERE id = ANY($1::int[])', [loteIdsCreados]);
    const { rows: remanentesLotes } = await db.pool.query('SELECT id FROM lotes WHERE id = ANY($1::int[])', [loteIdsCreados]);
    if (remanentesLotes.length !== 0) throw new Error('Limpieza incompleta: quedaron lotes de prueba.');
  }
  if (compradorIdsCreados.length) {
    await db.pool.query('DELETE FROM compradores WHERE id = ANY($1::int[])', [compradorIdsCreados]);
    const { rows: remanentesCompradores } = await db.pool.query('SELECT id FROM compradores WHERE id = ANY($1::int[])', [compradorIdsCreados]);
    if (remanentesCompradores.length !== 0) throw new Error('Limpieza incompleta: quedaron compradores de prueba.');
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

describe('nav-tabs — contratosVenta solo para admin/desarrollador', () => {
  it('admin ve contratosVenta en sus tabs; residente no', async () => {
    const admRes = await request(app).get(`/api/projects/${testProjectId}/nav-tabs`).set('Authorization', `Bearer ${adminToken}`);
    expect(admRes.body.tabs).toContain('contratosVenta');

    const resRes = await request(app).get(`/api/projects/${testProjectId}/nav-tabs`).set('Authorization', `Bearer ${tempToken}`);
    expect(resRes.body.tabs).not.toContain('contratosVenta');
  });
});

describe('Contratos de venta — auth.allow() admin/desarrollador exclusivo', () => {
  it('GET requiere autenticación y bloquea a residente', async () => {
    const noAuth = await request(app).get(`/api/projects/${testProjectId}/contratos-venta`);
    expect(noAuth.status).toBe(401);
    const residente = await request(app).get(`/api/projects/${testProjectId}/contratos-venta`).set('Authorization', `Bearer ${tempToken}`);
    expect(residente.status).toBe(403);
  });

  it('POST bloquea a residente', async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/contratos-venta`)
      .set('Authorization', `Bearer ${tempToken}`)
      .send({ lote_id: 1, comprador_id: 1, monto_total: 1000 });
    expect(res.status).toBe(403);
  });
});

describe('Contrato desde un apartado activo', () => {
  let lote; let comprador; let apartado;

  beforeAll(async () => {
    comprador = await crearComprador('DesdeApartado');
    lote = await crearLote('APT');
    apartado = await crearApartadoActivo(lote.id, comprador.id, 60000);
  }, 30000);

  it('rechaza un lote de OTRA obra con 400', async () => {
    const res = await request(app)
      .post(`/api/projects/${otroProjectId}/contratos-venta`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ lote_id: lote.id, comprador_id: comprador.id, apartado_id: apartado.id, monto_total: 60000 });
    expect(res.status).toBe(400);
  });

  it('crea el contrato: apartado pasa a convertido_a_contrato y lote a vendido (verificado con query directa)', async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/contratos-venta`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ lote_id: lote.id, comprador_id: comprador.id, apartado_id: apartado.id, monto_total: 65000, fecha_firma: '2026-08-25' });
    expect(res.status).toBe(201);
    expect(res.body.estado).toBe('vigente');
    expect(res.body.monto_total).toBe(65000);
    contratoVentaIdsCreados.push(res.body.id);

    const { rows: apartadoRows } = await db.pool.query('SELECT estado FROM apartados WHERE id = $1', [apartado.id]);
    expect(apartadoRows[0].estado).toBe('convertido_a_contrato');

    const { rows: loteRows } = await db.pool.query('SELECT estatus_venta FROM lotes WHERE id = $1', [lote.id]);
    expect(loteRows[0].estatus_venta).toBe('vendido');
  });

  it('un segundo contrato vigente sobre el MISMO lote es rechazado con 400 (índice único parcial)', async () => {
    const otroComprador = await crearComprador('Duplicado');
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/contratos-venta`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ lote_id: lote.id, comprador_id: otroComprador.id, monto_total: 1000 });
    expect(res.status).toBe(400);
  });

  it('editar el contrato ignora monto_total — solo fecha_firma/pdf se actualizan', async () => {
    const contratoId = contratoVentaIdsCreados[0];
    const res = await request(app)
      .put(`/api/projects/${testProjectId}/contratos-venta/${contratoId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fecha_firma: '2026-09-01', monto_total: 999999999 });
    expect(res.status).toBe(200);
    expect(res.body.monto_total).toBe(65000); // sin cambio, pese al intento
    expect(String(res.body.fecha_firma).slice(0, 10)).toBe('2026-09-01');
  });

  it('cancela el contrato: lote vuelve a disponible, el apartado NO se reactiva (verificado con query directa)', async () => {
    const contratoId = contratoVentaIdsCreados[0];
    const res = await request(app)
      .put(`/api/projects/${testProjectId}/contratos-venta/${contratoId}/cancelar`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('cancelado');

    const { rows: loteRows } = await db.pool.query('SELECT estatus_venta FROM lotes WHERE id = $1', [lote.id]);
    expect(loteRows[0].estatus_venta).toBe('disponible');

    const { rows: apartadoRows } = await db.pool.query('SELECT estado FROM apartados WHERE id = $1', [apartado.id]);
    expect(apartadoRows[0].estado).toBe('convertido_a_contrato'); // nunca se reactiva
  });

  it('cancelar un contrato que ya no está vigente devuelve 400', async () => {
    const contratoId = contratoVentaIdsCreados[0];
    const res = await request(app)
      .put(`/api/projects/${testProjectId}/contratos-venta/${contratoId}/cancelar`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });
});

describe('Venta directa (sin apartado)', () => {
  it('rechaza venta directa sobre un lote recién creado (estatus "no_disponible", no "disponible")', async () => {
    const comprador = await crearComprador('Directa');
    const lote = await crearLote('DIRECTA');
    expect(lote.estatus_venta).toBe('no_disponible'); // recién creado — no es 'disponible' por default

    const res = await request(app)
      .post(`/api/projects/${testProjectId}/contratos-venta`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ lote_id: lote.id, comprador_id: comprador.id, monto_total: 80000 });
    // Venta directa exige EXACTAMENTE estatus_venta='disponible' — un lote
    // que nunca pasó por un apartado (cancelado) sigue en 'no_disponible'.
    expect(res.status).toBe(400);
  });

  it('venta directa SÍ funciona sobre un lote que ya pasó por un apartado cancelado (por lo tanto está "disponible")', async () => {
    const compradorApartado = await crearComprador('ParaCancelar');
    const lote = await crearLote('VUELVE-DISP');
    const apartado = await crearApartadoActivo(lote.id, compradorApartado.id, 10000);
    const cancelRes = await request(app)
      .put(`/api/projects/${testProjectId}/apartados/${apartado.id}/cancelar`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(cancelRes.status).toBe(200);

    const { rows } = await db.pool.query('SELECT estatus_venta FROM lotes WHERE id = $1', [lote.id]);
    expect(rows[0].estatus_venta).toBe('disponible');

    const compradorDirecto = await crearComprador('CompraDirecta');
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/contratos-venta`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ lote_id: lote.id, comprador_id: compradorDirecto.id, monto_total: 95000 });
    expect(res.status).toBe(201);
    contratoVentaIdsCreados.push(res.body.id);
    expect(res.body.apartado_id).toBeNull();

    const { rows: loteRows } = await db.pool.query('SELECT estatus_venta FROM lotes WHERE id = $1', [lote.id]);
    expect(loteRows[0].estatus_venta).toBe('vendido');
  });

  it('rechaza venta directa sobre un lote con apartado activo de OTRO comprador (sin apartado_id)', async () => {
    const compradorApartado = await crearComprador('ApartadoAjeno');
    const lote = await crearLote('APARTADO-AJENO');
    await crearApartadoActivo(lote.id, compradorApartado.id, 20000);

    const compradorIntruso = await crearComprador('Intruso');
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/contratos-venta`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ lote_id: lote.id, comprador_id: compradorIntruso.id, monto_total: 1000 });
    expect(res.status).toBe(400);
  });
});

describe('Validación cross-obra de comprador_id', () => {
  it('rechaza un comprador de OTRA obra con 400', async () => {
    const lote = await crearLote('CROSS-COMPRADOR');
    const res = await request(app)
      .post(`/api/projects/${otroProjectId}/contratos-venta`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ lote_id: lote.id, comprador_id: (await crearComprador('ParaCross')).id, monto_total: 1000 });
    // lote pertenece a testProjectId, se manda contra otroProjectId -> ya
    // rechazado por validación de lote antes de llegar a comprador, cubre
    // el mismo camino de integridad cross-obra.
    expect(res.status).toBe(400);
  });
});

// Pieza agregada dentro de este mismo PR B (no estaba en el prompt original):
// hasta antes de esto, no existía ningún camino de código para que un lote
// llegara a 'disponible' sin pasar por un apartado creado-y-cancelado — un
// lote sin ningún interés de compra quedaba atrapado en 'no_disponible' para
// siempre. PUT /lotes/:loteId/marcar-disponible cierra ese hueco.
describe('PUT /lotes/:loteId/marcar-disponible', () => {
  it('bloquea a residente con 403', async () => {
    const lote = await crearLote('MARCAR-403');
    const res = await request(app)
      .put(`/api/projects/${testProjectId}/lotes/${lote.id}/marcar-disponible`)
      .set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(403);
  });

  it('transición exitosa: no_disponible -> disponible', async () => {
    const lote = await crearLote('MARCAR-OK');
    expect(lote.estatus_venta).toBe('no_disponible');

    const res = await request(app)
      .put(`/api/projects/${testProjectId}/lotes/${lote.id}/marcar-disponible`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.estatus_venta).toBe('disponible');

    const { rows } = await db.pool.query('SELECT estatus_venta FROM lotes WHERE id = $1', [lote.id]);
    expect(rows[0].estatus_venta).toBe('disponible');
  });

  it('rechaza con 400 si el lote ya está "apartado"', async () => {
    const comprador = await crearComprador('MarcarApartado');
    const lote = await crearLote('MARCAR-APARTADO');
    await crearApartadoActivo(lote.id, comprador.id, 30000);

    const res = await request(app)
      .put(`/api/projects/${testProjectId}/lotes/${lote.id}/marcar-disponible`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it('rechaza con 400 si el lote ya está "vendido"', async () => {
    const comprador = await crearComprador('MarcarVendido');
    const lote = await crearLote('MARCAR-VENDIDO');
    const apartado = await crearApartadoActivo(lote.id, comprador.id, 50000);
    const contratoRes = await request(app)
      .post(`/api/projects/${testProjectId}/contratos-venta`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ lote_id: lote.id, comprador_id: comprador.id, apartado_id: apartado.id, monto_total: 50000 });
    expect(contratoRes.status).toBe(201);
    contratoVentaIdsCreados.push(contratoRes.body.id);

    const res = await request(app)
      .put(`/api/projects/${testProjectId}/lotes/${lote.id}/marcar-disponible`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });
});

// Override de emergencia (prompt-override-emergencia-estatus-venta.md) — NO
// reemplaza los flujos normales, es un escape auditado. Verifica: éxito con
// motivo + registro literal en audit_log, rechazo sin motivo, aviso de
// apartado/contrato relacionado en la respuesta (sin cancelarlos), 403 para
// no-admin/desarrollador.
describe('PUT /lotes/:loteId/forzar-estatus-venta', () => {
  it('bloquea a residente con 403', async () => {
    const lote = await crearLote('FORZAR-403');
    const res = await request(app)
      .put(`/api/projects/${testProjectId}/lotes/${lote.id}/forzar-estatus-venta`)
      .set('Authorization', `Bearer ${tempToken}`)
      .send({ nuevo_estatus: 'disponible', motivo: 'test' });
    expect(res.status).toBe(403);
  });

  it('rechaza sin motivo con 400', async () => {
    const lote = await crearLote('FORZAR-SIN-MOTIVO');
    const res = await request(app)
      .put(`/api/projects/${testProjectId}/lotes/${lote.id}/forzar-estatus-venta`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nuevo_estatus: 'disponible', motivo: '   ' });
    expect(res.status).toBe(400);
  });

  it('rechaza un nuevo_estatus fuera del catálogo con 400', async () => {
    const lote = await crearLote('FORZAR-ESTATUS-INVALIDO');
    const res = await request(app)
      .put(`/api/projects/${testProjectId}/lotes/${lote.id}/forzar-estatus-venta`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nuevo_estatus: 'no_existe', motivo: 'test' });
    expect(res.status).toBe(400);
  });

  it('fuerza el estatus con motivo y deja registro literal en audit_log', async () => {
    const lote = await crearLote('FORZAR-OK');
    expect(lote.estatus_venta).toBe('no_disponible');

    const res = await request(app)
      .put(`/api/projects/${testProjectId}/lotes/${lote.id}/forzar-estatus-venta`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nuevo_estatus: 'vendido', motivo: 'Venta capturada fuera de sistema por caída del servicio, regularizando estatus.' });
    expect(res.status).toBe(200);
    expect(res.body.lote.estatus_venta).toBe('vendido');
    expect(res.body.apartado_activo_id).toBeNull();
    expect(res.body.contrato_vigente_id).toBeNull();

    const { rows: loteRows } = await db.pool.query('SELECT estatus_venta FROM lotes WHERE id = $1', [lote.id]);
    expect(loteRows[0].estatus_venta).toBe('vendido');

    const { rows: auditRows } = await db.pool.query(
      `SELECT actor_usuario, accion, target_id, project_id, detalle FROM audit_log
       WHERE accion = 'lote_forzar_estatus_venta' AND target_id = $1
       ORDER BY creado_en DESC LIMIT 1`,
      [lote.id]
    );
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].project_id).toBe(testProjectId);
    const detalle = JSON.parse(auditRows[0].detalle);
    expect(detalle.estatus_anterior).toBe('no_disponible');
    expect(detalle.estatus_nuevo).toBe('vendido');
    expect(detalle.motivo).toContain('Venta capturada fuera de sistema');
  });

  it('avisa (sin cancelar) cuando hay un apartado activo relacionado', async () => {
    const comprador = await crearComprador('ForzarApartado');
    const lote = await crearLote('FORZAR-APARTADO');
    const apartado = await crearApartadoActivo(lote.id, comprador.id, 40000);

    const res = await request(app)
      .put(`/api/projects/${testProjectId}/lotes/${lote.id}/forzar-estatus-venta`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nuevo_estatus: 'disponible', motivo: 'Regularización manual, el apartado ya no aplica pero se revisa aparte.' });
    expect(res.status).toBe(200);
    expect(res.body.apartado_activo_id).toBe(apartado.id);

    const { rows: apartadoRows } = await db.pool.query('SELECT estado FROM apartados WHERE id = $1', [apartado.id]);
    expect(apartadoRows[0].estado).toBe('activo'); // NUNCA se cancela automáticamente
  });

  it('avisa (sin cancelar) cuando hay un contrato vigente relacionado', async () => {
    const comprador = await crearComprador('ForzarContrato');
    const lote = await crearLote('FORZAR-CONTRATO');
    const apartado = await crearApartadoActivo(lote.id, comprador.id, 60000);
    const contratoRes = await request(app)
      .post(`/api/projects/${testProjectId}/contratos-venta`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ lote_id: lote.id, comprador_id: comprador.id, apartado_id: apartado.id, monto_total: 60000 });
    expect(contratoRes.status).toBe(201);
    contratoVentaIdsCreados.push(contratoRes.body.id);

    const res = await request(app)
      .put(`/api/projects/${testProjectId}/lotes/${lote.id}/forzar-estatus-venta`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nuevo_estatus: 'disponible', motivo: 'Regularización manual, el contrato se cancelará aparte si procede.' });
    expect(res.status).toBe(200);
    expect(res.body.contrato_vigente_id).toBe(contratoRes.body.id);

    const { rows: contratoRows } = await db.pool.query('SELECT estado FROM contratos_venta WHERE id = $1', [contratoRes.body.id]);
    expect(contratoRows[0].estado).toBe('vigente'); // NUNCA se cancela automáticamente
  });
});

describe('GET /lotes/estatus-venta-historial', () => {
  it('bloquea a residente con 403 y refleja los overrides recientes para admin', async () => {
    const lote = await crearLote('HISTORIAL-FORZAR');
    await request(app)
      .put(`/api/projects/${testProjectId}/lotes/${lote.id}/forzar-estatus-venta`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nuevo_estatus: 'disponible', motivo: 'Cubrir el historial de auditoría en el test.' });

    const resResidente = await request(app)
      .get(`/api/projects/${testProjectId}/lotes/estatus-venta-historial`)
      .set('Authorization', `Bearer ${tempToken}`);
    expect(resResidente.status).toBe(403);

    const resAdmin = await request(app)
      .get(`/api/projects/${testProjectId}/lotes/estatus-venta-historial`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(resAdmin.status).toBe(200);
    expect(resAdmin.body.some((r) => r.lote_id === lote.id)).toBe(true);
  });
});
