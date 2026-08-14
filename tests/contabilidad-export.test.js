// Integration tests para Contabilidad Fase 5 — export mensual consolidado
// (prompt-contabilidad-fase5-exportacion.md). Mismo gate que Fase 1-4
// (auth.requireContabilidadAccess: whitelist [46,8] OR admin/desarrollador).
// Corren contra la base de datos real apuntada por DATABASE_URL, generan un
// .xlsx real (exceljs) y lo leen de vuelta para verificar las 4 hojas.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import ExcelJS from 'exceljs';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;

let adminToken;
let paulToken;
let residenteToken;
let testProjectId;

let cuentaContableId;
let polizaId; // aparece en la hoja Pólizas Y como contraparte del movimiento conciliado
let cfdiId;
let cuentaBancariaId;
let movimientoId;
let equipoId;
let depreciacionId;

const MES_PRUEBA = '2025-03';
const MARCA = 'vitest-export-fase5';

function tokenPara(id, nombre, usuario, puesto) {
  return jwt.sign({ id, nombre, usuario, puesto }, SESSION_SECRET, { expiresIn: '15m', algorithm: 'HS256' });
}

async function leerXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const hojas = {};
  wb.worksheets.forEach((sheet) => {
    const filas = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // encabezado
      filas.push(row.values.slice(1));
    });
    hojas[sheet.name] = filas;
  });
  return hojas;
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

  const { rows: projRows } = await db.pool.query('SELECT id FROM proyectos ORDER BY id LIMIT 1');
  if (!projRows[0]) throw new Error('No hay ningún proyecto contra el cual correr la suite.');
  testProjectId = projRows[0].id;

  // Cuenta contable + póliza del mes de prueba, ligada a la obra de prueba.
  const cta = await db.pool.query(
    `INSERT INTO cuentas_contables (codigo, nombre, tipo) VALUES ('1170', '${MARCA}', 'activo') RETURNING id`
  );
  cuentaContableId = cta.rows[0].id;
  const pol = await db.pool.query(
    `INSERT INTO polizas (tipo, fecha, cuenta_id, monto, concepto, project_id, usuario_id)
     VALUES ('egreso', $1, $2, 500, $3, $4, 46) RETURNING id`,
    [`${MES_PRUEBA}-10`, cuentaContableId, `Poliza ${MARCA}`, testProjectId]
  );
  polizaId = pol.rows[0].id;

  // CFDI del mes de prueba, ligado a la misma obra.
  const cf = await db.pool.query(
    `INSERT INTO cfdi (uuid, rfc_emisor, rfc_receptor, fecha_emision, subtotal, iva, total, project_id, subido_por, xml_blob_url, nombre_archivo_xml)
     VALUES ($1, 'VITE850101AA1', 'ROF120202BB2', $2, 1000, 160, 1160, $3, 46, 'https://blob-falso/vitest-export5.xml', 'vitest-export5.xml') RETURNING id`,
    [`EXPORT5-${Date.now()}`, `${MES_PRUEBA}-12T10:00:00`, testProjectId]
  );
  cfdiId = cf.rows[0].id;

  // Cuenta bancaria + movimiento conciliado (con la misma póliza) del mes de prueba.
  const cb = await db.pool.query(
    `INSERT INTO cuentas_bancarias (nombre) VALUES ('${MARCA}') RETURNING id`
  );
  cuentaBancariaId = cb.rows[0].id;
  const mov = await db.pool.query(
    `INSERT INTO movimientos_bancarios (cuenta_bancaria_id, fecha, descripcion, monto, tipo, poliza_id, estatus, conciliado_por, conciliado_en, importado_por)
     VALUES ($1, $2, $3, 500, 'cargo', $4, 'conciliado', 46, NOW(), 46) RETURNING id`,
    [cuentaBancariaId, `${MES_PRUEBA}-11`, `Movimiento ${MARCA}`, polizaId]
  );
  movimientoId = mov.rows[0].id;

  // Un segundo movimiento PENDIENTE (mismo mes) — no debe aparecer en el export.
  await db.pool.query(
    `INSERT INTO movimientos_bancarios (cuenta_bancaria_id, fecha, descripcion, monto, tipo, estatus, importado_por)
     VALUES ($1, $2, $3, 999, 'abono', 'pendiente', 46)`,
    [cuentaBancariaId, `${MES_PRUEBA}-15`, `Pendiente ${MARCA} — no debe exportarse`]
  );

  // Equipo de maquinaria (ligado a la obra) + depreciación adquirida en el mes de prueba.
  const eq = await db.pool.query(
    `INSERT INTO equipos_maquinaria (nombre, tipo, identificador, obra_id) VALUES ($1, 'retroexcavadora', 'EXP5-1', $2) RETURNING id`,
    [MARCA, testProjectId]
  );
  equipoId = eq.rows[0].id;
  const dep = await db.pool.query(
    `INSERT INTO depreciacion_maquinaria (equipo_id, valor_adquisicion, fecha_adquisicion, vida_util_meses, valor_rescate)
     VALUES ($1, 24000, $2, 24, 0) RETURNING id`,
    [equipoId, `${MES_PRUEBA}-01`]
  );
  depreciacionId = dep.rows[0].id;
});

afterAll(async () => {
  if (movimientoId) await db.pool.query('DELETE FROM movimientos_bancarios WHERE cuenta_bancaria_id = $1', [cuentaBancariaId]);
  if (cuentaBancariaId) await db.pool.query('DELETE FROM cuentas_bancarias WHERE id = $1', [cuentaBancariaId]);
  if (depreciacionId) await db.pool.query('DELETE FROM depreciacion_maquinaria WHERE id = $1', [depreciacionId]);
  if (equipoId) await db.pool.query('DELETE FROM equipos_maquinaria WHERE id = $1', [equipoId]);
  if (cfdiId) await db.pool.query('DELETE FROM cfdi WHERE id = $1', [cfdiId]);
  if (polizaId) await db.pool.query('DELETE FROM polizas WHERE id = $1', [polizaId]);
  if (cuentaContableId) await db.pool.query('DELETE FROM cuentas_contables WHERE id = $1', [cuentaContableId]);
  await db.pool.query("DELETE FROM api_rate_limits WHERE endpoint = 'export_contabilidad' AND usuario_id = 46");
  await db.pool.end();
});

describe('Export — whitelist OR admin/desarrollador', () => {
  it('sin mes, 400', async () => {
    const res = await request(app).get('/api/contabilidad/export').set('Authorization', `Bearer ${paulToken}`);
    expect(res.status).toBe(400);
  });

  it('usuario fuera de whitelist/admin/desarrollador recibe 403', async () => {
    const res = await request(app).get(`/api/contabilidad/export?mes=${MES_PRUEBA}`).set('Authorization', `Bearer ${residenteToken}`);
    expect(res.status).toBe(403);
  });
});

describe('Export — mes sin datos', () => {
  it('mes sin datos en ninguna fuente devuelve 400 con mensaje claro (no genera archivo)', async () => {
    const res = await request(app).get('/api/contabilidad/export?mes=1999-01').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('1999-01');
  });
});

describe('Export — mes con datos en las 4 fuentes', () => {
  it('genera el .xlsx con 4 hojas y las filas de prueba en cada una', async () => {
    const res = await request(app)
      .get(`/api/contabilidad/export?mes=${MES_PRUEBA}`)
      .set('Authorization', `Bearer ${paulToken}`)
      .responseType('blob');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheet');

    const hojas = await leerXlsx(res.body);
    expect(Object.keys(hojas)).toEqual(['Pólizas', 'CFDI', 'Mov. Bancarios Conciliados', 'Depreciación']);

    // Hoja Pólizas: [fecha, tipo, cuenta_codigo, cuenta_nombre, concepto, obra, monto, referencia, estatus]
    const filaPoliza = hojas['Pólizas'].find((f) => f[4] === `Poliza ${MARCA}`);
    expect(filaPoliza).toBeTruthy();
    expect(filaPoliza[6]).toBe(500); // monto

    // Hoja CFDI
    const filaCfdi = hojas['CFDI'].find((f) => String(f[0]).startsWith('EXPORT5-'));
    expect(filaCfdi).toBeTruthy();
    expect(filaCfdi[6]).toBe(1160); // total

    // Hoja Mov. Bancarios Conciliados — el pendiente NO debe aparecer
    const descripciones = hojas['Mov. Bancarios Conciliados'].map((f) => f[2]);
    expect(descripciones).toContain(`Movimiento ${MARCA}`);
    expect(descripciones.some((d) => String(d).includes('no debe exportarse'))).toBe(false);

    // Hoja Depreciación: [equipo, identificador, valor_adq, mensual, acumulada, valor_libros, fecha_baja]
    const filaDep = hojas['Depreciación'].find((f) => f[0] === MARCA);
    expect(filaDep).toBeTruthy();
    expect(filaDep[2]).toBe(24000); // valor adquisición
    expect(filaDep[3]).toBe(1000);  // mensual = 24000/24
    expect(filaDep[4]).toBe(1000);  // acumulada (1 mes transcurrido)
    expect(filaDep[5]).toBe(23000); // valor en libros
  });
});

describe('Export — filtro por obra', () => {
  it('con project_id de una obra SIN datos de prueba, no incluye las filas de prueba', async () => {
    const { rows } = await db.pool.query('SELECT id FROM proyectos WHERE id != $1 ORDER BY id LIMIT 1', [testProjectId]);
    if (!rows[0]) return; // solo hay una obra en esta DB — nada que probar aquí
    const otraObraId = rows[0].id;
    const res = await request(app)
      .get(`/api/contabilidad/export?mes=${MES_PRUEBA}&project_id=${otraObraId}`)
      .set('Authorization', `Bearer ${paulToken}`);
    // Puede ser 400 (esa obra tampoco tiene datos ese mes) o 200 con datos de
    // OTRA cosa — en ningún caso debe traer las filas marcadas de esta prueba.
    if (res.status === 200) {
      const hojas = await leerXlsx(res.body);
      const todasLasFilas = Object.values(hojas).flat();
      expect(todasLasFilas.some((f) => f.some((v) => String(v).includes(MARCA)))).toBe(false);
    } else {
      expect(res.status).toBe(400);
    }
  });

  it('con project_id de la obra de prueba, sí incluye las filas de prueba', async () => {
    const res = await request(app)
      .get(`/api/contabilidad/export?mes=${MES_PRUEBA}&project_id=${testProjectId}`)
      .set('Authorization', `Bearer ${paulToken}`)
      .responseType('blob');
    expect(res.status).toBe(200);
    const hojas = await leerXlsx(res.body);
    expect(hojas['Depreciación'].some((f) => f[0] === MARCA)).toBe(true);
  });
});

describe('Export — rate limiting', () => {
  it('21ª exportación en la misma hora devuelve 429', async () => {
    // Simula 20 exports ya hechos en la última hora (evita 20 requests HTTP
    // reales — mismo efecto sobre el SELECT COUNT que hace el endpoint).
    for (let i = 0; i < 20; i++) {
      await db.pool.query("INSERT INTO api_rate_limits (usuario_id, endpoint) VALUES (46, 'export_contabilidad')");
    }
    const res = await request(app)
      .get(`/api/contabilidad/export?mes=${MES_PRUEBA}`)
      .set('Authorization', `Bearer ${paulToken}`);
    expect(res.status).toBe(429);
  });
});
