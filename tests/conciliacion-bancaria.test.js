// Integration tests para Contabilidad Fase 3 — cuentas bancarias +
// importación/conciliación de movimientos bancarios
// (prompt-contabilidad-fase3-conciliacion.md). Mismo gate que Fase 1/2
// (auth.requireContabilidadAccess: whitelist [46,8] OR admin/desarrollador).
// Corren contra la base de datos real apuntada por DATABASE_URL y suben/
// borran un blob real de prueba en Vercel Blob (mismo patrón que
// tests/cfdi.test.js). NO toca cuentas_control/movimientos_control (control
// personal de Paul/Fer) — feature completamente distinto.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import ExcelJS from 'exceljs';
import { put, del } from '@vercel/blob';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;

let adminToken;
let paulToken;
let residenteToken;
let cuentaBancariaId;
let cuentaContableId;
let polizaSugeridaId; // póliza que debe aparecer como sugerencia (mismo monto, fecha cercana)
let movimientoId;
let archivoUrl;

function tokenPara(id, nombre, usuario, puesto) {
  return jwt.sign({ id, nombre, usuario, puesto }, SESSION_SECRET, { expiresIn: '15m', algorithm: 'HS256' });
}

const FECHA_PRUEBA = '2026-08-10';
const MONTO_PRUEBA = 1234.56;
const DESCRIPCION_PRUEBA = 'Pago a proveedor vitest-conciliacion';

async function construirXlsxPrueba() {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Movimientos');
  sheet.addRow(['Fecha', 'Descripcion', 'Monto', 'Tipo']);
  sheet.addRow(['10/08/2026', DESCRIPCION_PRUEBA, MONTO_PRUEBA, 'Cargo']);
  sheet.addRow(['11/08/2026', 'Deposito cliente vitest-conciliacion', 5000, 'Abono']);
  return wb.xlsx.writeBuffer();
}

beforeAll(async () => {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada — no se puede correr la suite.');
  if (!SESSION_SECRET) throw new Error('SESSION_SECRET no configurada — no se puede correr la suite.');

  const loginRes = await request(app).post('/api/auth/login').send({ usuario: ADMIN_USER, password: ADMIN_PASSWORD });
  if (loginRes.status !== 200 || !loginRes.body.token) {
    throw new Error(`Login admin falló: ${loginRes.status} ${JSON.stringify(loginRes.body)}`);
  }
  adminToken = loginRes.body.token;
  paulToken = tokenPara(46, 'PAUL OCAMPO', 'paul.ocmp', 'desarrollador');

  const { rows: residenteRows } = await db.pool.query(
    "SELECT id FROM usuarios WHERE activo = true AND puesto NOT IN ('admin','desarrollador') AND id NOT IN (46,8) ORDER BY id LIMIT 1"
  );
  if (!residenteRows[0]) throw new Error('No hay ningún usuario activo fuera de whitelist/admin/desarrollador contra el cual probar el 403.');
  residenteToken = tokenPara(residenteRows[0].id, 'RESIDENTE PRUEBA', 'residente.prueba', 'residente');

  // Cuenta contable + póliza de prueba, misma fecha/monto que el movimiento
  // del archivo — debe aparecer como sugerencia automática.
  const { rows: ctaRows } = await db.pool.query(
    `INSERT INTO cuentas_contables (codigo, nombre, tipo) VALUES ('1150', 'Cuenta prueba vitest-conciliacion', 'activo') RETURNING id`
  );
  cuentaContableId = ctaRows[0].id;
  const { rows: polRows } = await db.pool.query(
    `INSERT INTO polizas (tipo, fecha, cuenta_id, monto, concepto, usuario_id)
     VALUES ('egreso', $1, $2, $3, 'Póliza sugerida vitest-conciliacion', 46) RETURNING id`,
    [FECHA_PRUEBA, cuentaContableId, MONTO_PRUEBA]
  );
  polizaSugeridaId = polRows[0].id;

  // Sube un blob real de prueba (mismo mecanismo que produciría el upload
  // directo del cliente vía /contabilidad/movimientos/upload-token).
  const buffer = await construirXlsxPrueba();
  const blobResult = await put(`movimientos-bancarios/vitest-${Date.now()}.xlsx`, buffer, {
    access: 'private', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  archivoUrl = blobResult.url;
});

afterAll(async () => {
  if (movimientoId) await db.pool.query('DELETE FROM movimientos_bancarios WHERE cuenta_bancaria_id = $1', [cuentaBancariaId]);
  if (polizaSugeridaId) await db.pool.query('DELETE FROM polizas WHERE id = $1', [polizaSugeridaId]);
  if (cuentaContableId) await db.pool.query('DELETE FROM cuentas_contables WHERE id = $1', [cuentaContableId]);
  if (cuentaBancariaId) await db.pool.query('DELETE FROM cuentas_bancarias WHERE id = $1', [cuentaBancariaId]);
  if (archivoUrl) await del(archivoUrl).catch(() => {});
  await db.pool.end();
});

describe('Conciliación Bancaria — whitelist OR admin/desarrollador', () => {
  it('GET /contabilidad/cuentas-bancarias — usuario fuera de whitelist/admin/desarrollador recibe 403', async () => {
    const res = await request(app).get('/api/contabilidad/cuentas-bancarias').set('Authorization', `Bearer ${residenteToken}`);
    expect(res.status).toBe(403);
  });

  it('GET /contabilidad/cuentas-bancarias — puesto admin recibe 200', async () => {
    const res = await request(app).get('/api/contabilidad/cuentas-bancarias').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it('GET /contabilidad/movimientos — usuario fuera de whitelist/admin/desarrollador recibe 403', async () => {
    const res = await request(app).get('/api/contabilidad/movimientos').set('Authorization', `Bearer ${residenteToken}`);
    expect(res.status).toBe(403);
  });
});

describe('Cuentas bancarias', () => {
  it('el seed de "Cuenta principal" existe', async () => {
    const res = await request(app).get('/api/contabilidad/cuentas-bancarias').set('Authorization', `Bearer ${paulToken}`);
    expect(res.status).toBe(200);
    expect(res.body.some((c) => c.nombre === 'Cuenta principal')).toBe(true);
  });

  it('POST /contabilidad/cuentas-bancarias — crea una cuenta bancaria de prueba', async () => {
    const res = await request(app)
      .post('/api/contabilidad/cuentas-bancarias')
      .set('Authorization', `Bearer ${paulToken}`)
      .send({ nombre: 'Cuenta prueba vitest-conciliacion', banco: 'BancoTest', numero_cuenta: '1234' });
    expect(res.status).toBe(201);
    expect(res.body.activo).toBe(true);
    cuentaBancariaId = res.body.id;
  });

  it('PUT /contabilidad/cuentas-bancarias/:id — edita sin DELETE físico', async () => {
    const res = await request(app)
      .put(`/api/contabilidad/cuentas-bancarias/${cuentaBancariaId}`)
      .set('Authorization', `Bearer ${paulToken}`)
      .send({ banco: 'BancoTest Editado' });
    expect(res.status).toBe(200);
    expect(res.body.banco).toBe('BancoTest Editado');
  });
});

describe('Importación — preview y confirm', () => {
  it('POST /contabilidad/movimientos/preview — sin cuenta_bancaria_id, 400', async () => {
    const res = await request(app)
      .post('/api/contabilidad/movimientos/preview')
      .set('Authorization', `Bearer ${paulToken}`)
      .send({ archivo_url: archivoUrl });
    expect(res.status).toBe(400);
  });

  it('POST /contabilidad/movimientos/preview — muestra 2 movimientos nuevos, ninguno existente todavía', async () => {
    const res = await request(app)
      .post('/api/contabilidad/movimientos/preview')
      .set('Authorization', `Bearer ${paulToken}`)
      .send({ archivo_url: archivoUrl, archivo_nombre: 'prueba.xlsx', cuenta_bancaria_id: cuentaBancariaId });
    expect(res.status).toBe(200);
    expect(res.body.nuevos.length).toBe(2);
    expect(res.body.ya_existentes.length).toBe(0);
    expect(res.body.nuevos.some((m) => m.descripcion === DESCRIPCION_PRUEBA && m.monto === MONTO_PRUEBA && m.tipo === 'cargo')).toBe(true);
  });

  it('POST /contabilidad/movimientos/confirmar — sin confirmado:true, 400', async () => {
    const res = await request(app)
      .post('/api/contabilidad/movimientos/confirmar')
      .set('Authorization', `Bearer ${paulToken}`)
      .send({ archivo_url: archivoUrl, archivo_nombre: 'prueba.xlsx', cuenta_bancaria_id: cuentaBancariaId });
    expect(res.status).toBe(400);
  });

  it('POST /contabilidad/movimientos/confirmar — persiste los 2 movimientos', async () => {
    const res = await request(app)
      .post('/api/contabilidad/movimientos/confirmar')
      .set('Authorization', `Bearer ${paulToken}`)
      .send({ archivo_url: archivoUrl, archivo_nombre: 'prueba.xlsx', cuenta_bancaria_id: cuentaBancariaId, confirmado: true });
    expect(res.status).toBe(200);
    expect(res.body.insertados).toBe(2);
    expect(res.body.omitidos).toBe(0);

    const { rows } = await db.pool.query('SELECT * FROM movimientos_bancarios WHERE cuenta_bancaria_id = $1', [cuentaBancariaId]);
    expect(rows.length).toBe(2);
    const mov = rows.find((r) => r.descripcion === DESCRIPCION_PRUEBA);
    expect(mov).toBeTruthy();
    expect(Number(mov.monto)).toBe(MONTO_PRUEBA);
    expect(mov.tipo).toBe('cargo');
    expect(mov.estatus).toBe('pendiente');
    movimientoId = mov.id;
  });

  it('reimportar el mismo archivo — preview ahora muestra 0 nuevos, 2 ya existentes', async () => {
    const res = await request(app)
      .post('/api/contabilidad/movimientos/preview')
      .set('Authorization', `Bearer ${paulToken}`)
      .send({ archivo_url: archivoUrl, archivo_nombre: 'prueba.xlsx', cuenta_bancaria_id: cuentaBancariaId });
    expect(res.status).toBe(200);
    expect(res.body.nuevos.length).toBe(0);
    expect(res.body.ya_existentes.length).toBe(2);
  });

  it('reimportar y confirmar el mismo archivo — 0 insertados, 2 omitidos, sin duplicar filas (evidencia SQL)', async () => {
    const res = await request(app)
      .post('/api/contabilidad/movimientos/confirmar')
      .set('Authorization', `Bearer ${paulToken}`)
      .send({ archivo_url: archivoUrl, archivo_nombre: 'prueba.xlsx', cuenta_bancaria_id: cuentaBancariaId, confirmado: true });
    expect(res.status).toBe(200);
    expect(res.body.insertados).toBe(0);
    expect(res.body.omitidos).toBe(2);

    const { rows } = await db.pool.query('SELECT COUNT(*)::int AS n FROM movimientos_bancarios WHERE cuenta_bancaria_id = $1', [cuentaBancariaId]);
    expect(rows[0].n).toBe(2); // sigue siendo 2, no 4
  });
});

describe('Conciliación', () => {
  it('GET /contabilidad/movimientos — el movimiento de prueba trae la sugerencia de póliza correcta', async () => {
    const res = await request(app)
      .get(`/api/contabilidad/movimientos?cuenta_bancaria_id=${cuentaBancariaId}&estatus=pendiente`)
      .set('Authorization', `Bearer ${paulToken}`);
    expect(res.status).toBe(200);
    const mov = res.body.find((m) => m.id === movimientoId);
    expect(mov).toBeTruthy();
    expect(mov.sugerencia_poliza_id).toBe(polizaSugeridaId);
  });

  it('PUT /contabilidad/movimientos/:id/conciliar — con póliza inexistente, 400', async () => {
    const res = await request(app)
      .put(`/api/contabilidad/movimientos/${movimientoId}/conciliar`)
      .set('Authorization', `Bearer ${paulToken}`)
      .send({ poliza_id: 999999 });
    expect(res.status).toBe(400);
  });

  it('PUT /contabilidad/movimientos/:id/conciliar — concilia con la póliza sugerida', async () => {
    const res = await request(app)
      .put(`/api/contabilidad/movimientos/${movimientoId}/conciliar`)
      .set('Authorization', `Bearer ${paulToken}`)
      .send({ poliza_id: polizaSugeridaId });
    expect(res.status).toBe(200);
    expect(res.body.estatus).toBe('conciliado');
    expect(res.body.poliza_id).toBe(polizaSugeridaId);
    expect(res.body.conciliado_por).toBe(46);
    expect(res.body.conciliado_en).not.toBeNull();
  });

  it('la póliza ya conciliada deja de sugerirse para otros movimientos pendientes', async () => {
    const res = await request(app)
      .get(`/api/contabilidad/movimientos?cuenta_bancaria_id=${cuentaBancariaId}&estatus=pendiente`)
      .set('Authorization', `Bearer ${paulToken}`);
    expect(res.status).toBe(200);
    expect(res.body.every((m) => m.sugerencia_poliza_id !== polizaSugeridaId)).toBe(true);
  });

  it('PUT /contabilidad/movimientos/:id/desconciliar — revierte a pendiente sin poliza_id', async () => {
    const res = await request(app)
      .put(`/api/contabilidad/movimientos/${movimientoId}/desconciliar`)
      .set('Authorization', `Bearer ${paulToken}`);
    expect(res.status).toBe(200);
    expect(res.body.estatus).toBe('pendiente');
    expect(res.body.poliza_id).toBeNull();

    const { rows } = await db.pool.query('SELECT * FROM movimientos_bancarios WHERE id = $1', [movimientoId]);
    expect(rows.length).toBe(1); // la fila sigue existiendo, no fue DELETE
    expect(rows[0].estatus).toBe('pendiente');
  });
});
