// Integration tests para POST /api/projects/:id/reprocesar-destajo-matrices/
// preview y /confirm (prompt-reprocesar-destajo-matrices-obras-viejas.md).
// Corren contra la base de datos real apuntada por DATABASE_URL y suben/
// borran un blob real de prueba en Vercel Blob (mismo patrón que
// tests/conciliacion-bancaria.test.js). Simula una "obra vieja" (cargada
// antes del fix de PR #178/#179): conceptos + insumos insertados a mano,
// SIN destajo_items ni matrices_precio_unitario -- exactamente el estado que
// dejaba el alta de obra antes de ese fix.
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

const sufijo = Date.now();
const COD_C1 = `QA_REPROC_C1_${sufijo}`;
const COD_C2 = `QA_REPROC_C2_${sufijo}`;
const COD_INSUMO = `QA_REPROC_INS_${sufijo}`;

let adminToken;
let clienteId;
let proyectoId;
let conceptoC1Id;
let conceptoC2Id;
let archivoUrl;

// Formato real de 5 hojas: Presupuesto ("Directo"), Destajos (sin columna de
// destajista -- mismo formato real de Kaila que motivó PR #178), Matrices
// (1 bloque resolvible para C1), Insumos. El endpoint bajo prueba solo debe
// leer Destajos/Matrices -- Presupuesto/Insumos del archivo se ignoran por
// completo (los conceptos/insumos "reales" de la obra ya se insertaron a
// mano en beforeAll, simulando la obra vieja).
async function construirXlsxPrueba() {
  const wb = new ExcelJS.Workbook();

  const presupuesto = wb.addWorksheet('Directo');
  presupuesto.addRow(['Código', 'Concepto', 'Unidad', 'Cantidad', 'P. Unitario', 'Importe']);
  presupuesto.addRow([COD_C1, 'QA concepto 1', 'M', 10, 100, 1000]);
  presupuesto.addRow([COD_C2, 'QA concepto 2', 'M', 5, 50, 250]);

  const destajos = wb.addWorksheet(' Destajos');
  destajos.addRow(['Código', 'Concepto', 'Unidad', 'Cantidad', 'Pu Mano de Obra', 'Importe Mano de Obra']);
  destajos.addRow([COD_C1, 'QA concepto 1', 'M', 10, 9.09, 90.9]);
  destajos.addRow([COD_C2, 'QA concepto 2', 'M', 5, 5.5, 27.5]);

  const matrices = wb.addWorksheet('Matrices');
  matrices.addRow(['Código', 'Concepto', 'Unidad', 'P. Unitario', 'Op.', 'Cantidad', 'Importe', '%']);
  matrices.addRow(['Partida:', 'GRP', 'Análisis No.:', null, 1, null, null, null]);
  matrices.addRow(['Análisis:', COD_C1, null, 'M', null, 10, 1000, null]);
  matrices.addRow(['MATERIALES', null, null, null, null, null, null, null]);
  matrices.addRow([COD_INSUMO, 'QA insumo de prueba', 'PZA', 50, '*', 2, 100, 0.1]);
  matrices.addRow(['SUBTOTAL:', 'MATERIALES', null, null, null, null, 100, 0.1]);
  matrices.addRow(['', 'Rendimiento: M/JOR', '', '', '', 10, '', '']);
  matrices.addRow(['', '(CI) INDIRECTOS', '', '', '', 0, '', '']);
  matrices.addRow(['', '(CF) FINANCIAMIENTO', '', '', '', 0, '', '']);
  matrices.addRow(['', '(CU) UTILIDAD', '', '', '', 0, '', '']);
  matrices.addRow(['', 'PRECIO UNITARIO', '', '', '', '', 100, '']);

  const insumos = wb.addWorksheet('e)Listado Insumos');
  insumos.addRow(['Código', 'Concepto', 'Unidad', 'Fecha', 'Cantidad', 'Precio', 'Importe', '% Incidencia']);
  insumos.addRow([COD_INSUMO, 'QA insumo de prueba', 'PZA', null, 2, 50, 100, 0.1]);

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

  const { rows: [{ id: clId }] } = await db.pool.query(
    'INSERT INTO clientes (nombre) VALUES ($1) RETURNING id', [`QA_REPROC_CLIENTE_${sufijo}`]
  );
  clienteId = clId;
  const { rows: [{ id: pId }] } = await db.pool.query(
    'INSERT INTO proyectos (nombre, cliente_id) VALUES ($1, $2) RETURNING id', [`QA_REPROC_OBRA_${sufijo}`, clienteId]
  );
  proyectoId = pId;

  // Conceptos "ya cargados" (obra vieja) -- exactamente lo que el alta de
  // obra insertaba ANTES del fix de destajo/matrices.
  const { rows: [{ id: c1Id }] } = await db.pool.query(
    `INSERT INTO conceptos (project_id, codigo, concepto, unidad, cantidad, precio_unitario, importe, es_total, activo, orden)
     VALUES ($1, $2, 'QA concepto 1', 'M', 10, 100, 1000, 0, 1, 1) RETURNING id`, [proyectoId, COD_C1]
  );
  conceptoC1Id = c1Id;
  const { rows: [{ id: c2Id }] } = await db.pool.query(
    `INSERT INTO conceptos (project_id, codigo, concepto, unidad, cantidad, precio_unitario, importe, es_total, activo, orden)
     VALUES ($1, $2, 'QA concepto 2', 'M', 5, 50, 250, 0, 1, 2) RETURNING id`, [proyectoId, COD_C2]
  );
  conceptoC2Id = c2Id;
  await db.pool.query(
    `INSERT INTO insumos (project_id, codigo, concepto, categoria, unidad, cantidad_presupuesto, precio_presupuesto, importe_presupuesto, orden)
     VALUES ($1, $2, 'QA insumo de prueba', 'MATERIALES', 'PZA', 2, 50, 100, 1)`, [proyectoId, COD_INSUMO]
  );

  const buffer = await construirXlsxPrueba();
  const blobResult = await put(`reprocesar-destajo-matrices/vitest-${sufijo}.xlsx`, buffer, {
    access: 'private', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  archivoUrl = blobResult.url;
});

afterAll(async () => {
  if (proyectoId) {
    await db.pool.query('DELETE FROM matriz_precio_renglones WHERE matriz_id IN (SELECT id FROM matrices_precio_unitario WHERE project_id = $1 OR concepto_id IN (SELECT id FROM conceptos WHERE project_id = $1))', [proyectoId]);
    await db.pool.query('DELETE FROM matrices_precio_unitario WHERE project_id = $1 OR concepto_id IN (SELECT id FROM conceptos WHERE project_id = $1)', [proyectoId]);
    await db.pool.query('DELETE FROM destajo_items WHERE project_id = $1', [proyectoId]);
    await db.pool.query('DELETE FROM destajistas WHERE project_id = $1', [proyectoId]);
    await db.pool.query('DELETE FROM insumos WHERE project_id = $1', [proyectoId]);
    await db.pool.query('DELETE FROM conceptos WHERE project_id = $1', [proyectoId]);
    await db.pool.query('DELETE FROM proyectos WHERE id = $1', [proyectoId]);
  }
  if (clienteId) await db.pool.query('DELETE FROM clientes WHERE id = $1', [clienteId]);
  if (archivoUrl) await del(archivoUrl).catch(() => {});
  await db.pool.end();
});

describe('POST /api/projects/:id/reprocesar-destajo-matrices/preview', () => {
  it('detecta 2 destajo nuevos y 1 matriz nueva, sin escribir nada', async () => {
    const res = await request(app)
      .post(`/api/projects/${proyectoId}/reprocesar-destajo-matrices/preview`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ archivo_url: archivoUrl });
    expect(res.status).toBe(200);
    expect(res.body.resumen.destajo_nuevos).toBe(2);
    expect(res.body.resumen.destajo_omitidos).toBe(0);
    expect(res.body.resumen.destajo_sin_match).toBe(0);
    expect(res.body.resumen.matrices_nuevas).toBe(1);
    expect(res.body.resumen.matrices_omitidas).toBe(0);

    const { rows } = await db.pool.query('SELECT count(*) FROM destajo_items WHERE project_id = $1', [proyectoId]);
    expect(Number(rows[0].count)).toBe(0); // preview no escribe nada
  });
});

describe('POST /api/projects/:id/reprocesar-destajo-matrices/confirm', () => {
  it('crea destajo_items y matrices_precio_unitario sin tocar conceptos/insumos existentes', async () => {
    const res = await request(app)
      .post(`/api/projects/${proyectoId}/reprocesar-destajo-matrices/confirm`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ archivo_url: archivoUrl, confirmado: true });
    expect(res.status).toBe(200);
    expect(res.body.destajo_creados).toBe(2);
    expect(res.body.matrices_creadas).toBe(1);

    const { rows: destajoRows } = await db.pool.query(
      'SELECT codigo, concepto_id, precio_destajo FROM destajo_items WHERE project_id = $1 ORDER BY codigo', [proyectoId]
    );
    expect(destajoRows).toHaveLength(2);
    expect(destajoRows.find((r) => r.codigo === COD_C1).concepto_id).toBe(conceptoC1Id);
    expect(Number(destajoRows.find((r) => r.codigo === COD_C1).precio_destajo)).toBeCloseTo(9.09);

    const { rows: destajistaRows } = await db.pool.query('SELECT nombre FROM destajistas WHERE project_id = $1', [proyectoId]);
    expect(destajistaRows).toHaveLength(1);
    expect(destajistaRows[0].nombre).toBe('Mano de Obra General');

    const { rows: matrizRows } = await db.pool.query(
      'SELECT concepto_id FROM matrices_precio_unitario WHERE concepto_id = $1', [conceptoC1Id]
    );
    expect(matrizRows).toHaveLength(1);

    // Presupuesto/Insumos de la obra intactos -- Forbidden Action del prompt.
    const { rows: conceptosRows } = await db.pool.query('SELECT count(*) FROM conceptos WHERE project_id = $1', [proyectoId]);
    const { rows: insumosRows } = await db.pool.query('SELECT count(*) FROM insumos WHERE project_id = $1', [proyectoId]);
    expect(Number(conceptosRows[0].count)).toBe(2);
    expect(Number(insumosRows[0].count)).toBe(1);
  });

  it('reintentar el mismo reproceso una segunda vez no duplica nada — todo se omite', async () => {
    const previewRes = await request(app)
      .post(`/api/projects/${proyectoId}/reprocesar-destajo-matrices/preview`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ archivo_url: archivoUrl });
    expect(previewRes.body.resumen.destajo_nuevos).toBe(0);
    expect(previewRes.body.resumen.destajo_omitidos).toBe(2);
    expect(previewRes.body.resumen.matrices_nuevas).toBe(0);
    expect(previewRes.body.resumen.matrices_omitidas).toBe(1);

    const confirmRes = await request(app)
      .post(`/api/projects/${proyectoId}/reprocesar-destajo-matrices/confirm`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ archivo_url: archivoUrl, confirmado: true });
    expect(confirmRes.body.destajo_creados).toBe(0);
    expect(confirmRes.body.matrices_creadas).toBe(0);

    const { rows: destajoRows } = await db.pool.query('SELECT count(*) FROM destajo_items WHERE project_id = $1', [proyectoId]);
    const { rows: matrizRows } = await db.pool.query('SELECT count(*) FROM matrices_precio_unitario WHERE concepto_id = $1', [conceptoC1Id]);
    const { rows: destajistaRows } = await db.pool.query('SELECT count(*) FROM destajistas WHERE project_id = $1', [proyectoId]);
    expect(Number(destajoRows[0].count)).toBe(2); // sigue en 2, no 4
    expect(Number(matrizRows[0].count)).toBe(1); // sigue en 1, no 2
    expect(Number(destajistaRows[0].count)).toBe(1); // no se creó un segundo "Mano de Obra General"
  });
});

// El endpoint valida y resuelve TODO contra la DB antes de intentar
// cualquier INSERT (nunca inserta un concepto_id/destajista_id que no haya
// confirmado que existe primero) -- por diseño, no hay una forma legítima de
// llegar a una violación de constraint a mitad de su propia transacción a
// través del flujo HTTP normal. Se prueba el mecanismo de rollback
// directamente sobre el mismo patrón (misma tabla, mismo db.withTransaction)
// que usa el endpoint: un insert válido seguido de uno que viola la FK
// concepto_id -> conceptos(id) debe revertir también el insert válido previo.
describe('rollback de la transacción (mismo patrón que usa el confirm)', () => {
  it('si un insert posterior falla dentro de la misma transacción, los inserts previos tambien se revierten', async () => {
    const { rows: [{ id: destajistaId }] } = await db.pool.query(
      `INSERT INTO destajistas (project_id, nombre, orden) VALUES ($1, $2, 0) RETURNING id`,
      [proyectoId, `QA_REPROC_ROLLBACK_${sufijo}`]
    );
    await expect(db.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO destajo_items (project_id, destajista_id, concepto_id, codigo, concepto, unidad, cantidad_asignada, precio_destajo, orden)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [proyectoId, destajistaId, conceptoC2Id, 'QA_ROLLBACK_OK', 'valido', 'M', 1, 1, 99]
      );
      await client.query(
        `INSERT INTO destajo_items (project_id, destajista_id, concepto_id, codigo, concepto, unidad, cantidad_asignada, precio_destajo, orden)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [proyectoId, destajistaId, 999999999, 'QA_ROLLBACK_BAD', 'concepto_id inexistente', 'M', 1, 1, 100]
      );
    })).rejects.toThrow();

    const { rows } = await db.pool.query(
      "SELECT count(*) FROM destajo_items WHERE destajista_id = $1 AND codigo = 'QA_ROLLBACK_OK'", [destajistaId]
    );
    expect(Number(rows[0].count)).toBe(0); // el insert valido tambien se revirtio
    await db.pool.query('DELETE FROM destajistas WHERE id = $1', [destajistaId]);
  });
});
