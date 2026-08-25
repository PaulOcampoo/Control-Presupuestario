// Integration tests para el Catálogo Maestro de Costos (Task 2/5,
// prompt-catalogo-maestro-costos.md). Corren contra la base de datos real
// apuntada por DATABASE_URL y suben/borran blobs reales de prueba en Vercel
// Blob (mismo patrón que tests/reprocesar-destajo-matrices.test.js): se
// construye el .xlsx con ExcelJS usando los headers EXACTOS que espera
// parseArchivo4Hojas (server/crearPresupuestoImport.js), se sube con put()
// directo (bypassa el endpoint upload-token, que solo emite un token firmado
// para el browser -- no hay nada de negocio que probar ahí más allá del
// gate de permisos) y se llama al endpoint real de negocio con la URL
// resultante.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { put, del } from '@vercel/blob';
import app from '../server/app.js';
import db from '../server/db.js';
import { construirUrbanizacionDemo } from './fixtures/catalogo-maestro/construirAjalSintetico.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const sufijo = Date.now();
const COD_CONCEPTO = `QA_CATMAESTRO_C1_${sufijo}`;
const COD_INSUMO = `QA_CATMAESTRO_INS_${sufijo}`;

let adminToken;
let tempUserId;
let tempToken;
const tempUsuario = `qa_catmaestro_${sufijo}`;
const tempPassword = 'QaCatMaestroTemp123!';

let archivoUrlValido;
let archivoUrlInvalido;
let archivoUrlAjal;
let archivoIdCreado; // para el flujo feliz + DELETE
let archivoIdAjal; // para el flujo preview/confirm de AJAL
const blobsSubidos = [];

// Headers EXACTOS de ENCABEZADOS_PRESUPUESTO/DESTAJO/INSUMOS/MATRICES en
// server/crearPresupuestoImport.js -- el parser lee por nombre de columna
// exacto (fila 1), no heurística, así que cualquier typo aquí hace que la
// hoja entera se lea como vacía en vez de fallar con un error claro.
async function construirXlsxValido() {
  const wb = new ExcelJS.Workbook();

  const presupuesto = wb.addWorksheet('Presupuesto');
  presupuesto.addRow(['Código', 'Concepto', 'Unidad', 'Cantidad', 'Precio Unitario']);
  presupuesto.addRow([COD_CONCEPTO, 'QA concepto catálogo maestro', 'M2', 10, 250]);

  const destajo = wb.addWorksheet('Destajo');
  destajo.addRow(['Código', 'Unidad', 'Precio Destajo Máximo', 'Destajista (obra de origen)']);
  destajo.addRow([COD_CONCEPTO, 'M2', 80, 'QA Destajista Prueba']);

  const insumos = wb.addWorksheet('Insumos');
  insumos.addRow(['Código Insumo', 'Descripción', 'Categoría', 'Unidad', 'Precio Presupuesto', 'IVA Tasa', 'Código Concepto']);
  insumos.addRow([COD_INSUMO, 'QA insumo catálogo maestro', 'MATERIALES', 'PZA', 45, 16, COD_CONCEPTO]);

  const matrices = wb.addWorksheet('Matrices');
  matrices.addRow([
    'Código Concepto', 'Partida', 'Rendimiento', '% Indirecto', '% Utilidad', '% Financiamiento',
    'Análisis No.', 'Cuadrilla', 'Categoría (renglón)', 'Tipo (renglón)',
    'Código Insumo (renglón)', 'Descripción (renglón)', 'Cantidad (renglón)', 'Factor Referencia (renglón)',
  ]);
  // Renglón tipo 'insumo' -- debe terminar en catalogo_insumos.
  matrices.addRow([
    COD_CONCEPTO, 'GRP', 10, 6, 15, 4, 1, null,
    'MATERIALES', 'insumo', COD_INSUMO, 'QA insumo catálogo maestro', 2, null,
  ]);
  // Renglón tipo 'factor_pct' -- NO es un insumo real, no debe terminar en
  // catalogo_insumos, pero sí debe sobrevivir dentro del JSONB de catalogo_matrices.
  matrices.addRow([
    COD_CONCEPTO, 'GRP', 10, 6, 15, 4, 1, null,
    'EQUIPO Y HERRAMIENTA', 'factor_pct', '', '% Herramienta Menor', 5, 'MANO DE OBRA',
  ]);

  return wb.xlsx.writeBuffer();
}

// Archivo inconsistente a propósito (Destajo referencia un código que NO
// existe en Presupuesto) -- parseArchivo4Hojas debe rechazarlo entero
// (Error con status 400), y el endpoint de upload debe dejar estado='error'
// sin ninguna fila parcial en las 4 tablas hijas.
async function construirXlsxInvalido() {
  const wb = new ExcelJS.Workbook();
  const presupuesto = wb.addWorksheet('Presupuesto');
  presupuesto.addRow(['Código', 'Concepto', 'Unidad', 'Cantidad', 'Precio Unitario']);
  presupuesto.addRow([`${COD_CONCEPTO}_X`, 'QA concepto X', 'M2', 1, 1]);

  const destajo = wb.addWorksheet('Destajo');
  destajo.addRow(['Código', 'Unidad', 'Precio Destajo Máximo', 'Destajista (obra de origen)']);
  destajo.addRow([`${COD_CONCEPTO}_NO_EXISTE`, 'M2', 1, 'QA']);

  return wb.xlsx.writeBuffer();
}

beforeAll(async () => {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada — no se puede correr la suite.');

  const loginRes = await request(app).post('/api/auth/login').send({ usuario: ADMIN_USER, password: ADMIN_PASSWORD });
  if (loginRes.status !== 200 || !loginRes.body.token) {
    throw new Error(`Login admin falló: ${loginRes.status} ${JSON.stringify(loginRes.body)}`);
  }
  adminToken = loginRes.body.token;

  const createRes = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA Catalogo Maestro', usuario: tempUsuario, password: tempPassword, puesto: 'residente' });
  if (createRes.status !== 201 && createRes.status !== 200) {
    throw new Error(`No se pudo crear el usuario temporal: ${createRes.status} ${JSON.stringify(createRes.body)}`);
  }
  tempUserId = createRes.body.id;
  tempToken = await (async () => {
    const r = await request(app).post('/api/auth/login').send({ usuario: tempUsuario, password: tempPassword });
    if (r.status !== 200 || !r.body.token) throw new Error(`Login temp falló: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.token;
  })();

  const bufferValido = await construirXlsxValido();
  const blobValido = await put(`catalogo-maestro/vitest-valido-${sufijo}.xlsx`, bufferValido, {
    access: 'private', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  archivoUrlValido = blobValido.url;
  blobsSubidos.push(archivoUrlValido);

  const bufferInvalido = await construirXlsxInvalido();
  const blobInvalido = await put(`catalogo-maestro/vitest-invalido-${sufijo}.xlsx`, bufferInvalido, {
    access: 'private', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  archivoUrlInvalido = blobInvalido.url;
  blobsSubidos.push(archivoUrlInvalido);

  const bufferAjal = await construirUrbanizacionDemo().buffer();
  const blobAjal = await put(`catalogo-maestro/vitest-ajal-${sufijo}.xlsx`, bufferAjal, {
    access: 'private', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  archivoUrlAjal = blobAjal.url;
  blobsSubidos.push(archivoUrlAjal);
});

afterAll(async () => {
  if (tempUserId) {
    await request(app).delete(`/api/usuarios/${tempUserId}`).set('Authorization', `Bearer ${adminToken}`);
  }
  // Limpieza física completa (CLAUDE.md, "Limpieza de datos de prueba") --
  // catalogo_conceptos/destajo/insumos/matrices se van solos por ON DELETE
  // CASCADE al borrar catalogo_archivos, así que basta con eso.
  await db.pool.query(
    `DELETE FROM catalogo_archivos WHERE nombre_archivo LIKE $1`, [`QA_CATMAESTRO%${sufijo}%`]
  );
  for (const url of blobsSubidos) await del(url).catch(() => {});
  await db.pool.end();
});

describe('POST /api/costos/catalogo-maestro/upload-token', () => {
  it('rechaza a un usuario sin puesto admin/desarrollador (403)', async () => {
    const res = await request(app)
      .post('/api/costos/catalogo-maestro/upload-token')
      .set('Authorization', `Bearer ${tempToken}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it('requiere autenticación (401)', async () => {
    const res = await request(app).post('/api/costos/catalogo-maestro/upload-token').send({});
    expect(res.status).toBe(401);
  });
});

describe('POST /api/costos/catalogo-maestro/upload', () => {
  it('rechaza a un usuario sin puesto admin/desarrollador (403)', async () => {
    const res = await request(app)
      .post('/api/costos/catalogo-maestro/upload')
      .set('Authorization', `Bearer ${tempToken}`)
      .send({ archivo_url: archivoUrlValido, nombre_archivo: 'no-deberia-procesarse.xlsx' });
    expect(res.status).toBe(403);
  });

  it('archivo válido: procesa y puebla las 4 tablas hijas correctamente ligadas', async () => {
    const res = await request(app)
      .post('/api/costos/catalogo-maestro/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ archivo_url: archivoUrlValido, nombre_archivo: `QA_CATMAESTRO_valido_${sufijo}.xlsx` });

    expect(res.status).toBe(201);
    expect(res.body.estado).toBe('procesado');
    expect(res.body.numConceptos).toBe(1);
    expect(res.body.numDestajo).toBe(1);
    expect(res.body.numMatrices).toBe(1);
    // Solo el renglón tipo 'insumo' cuenta -- el 'factor_pct' se excluye.
    expect(res.body.numInsumos).toBe(1);
    archivoIdCreado = res.body.id;

    const { rows: archivoRows } = await db.pool.query('SELECT estado FROM catalogo_archivos WHERE id = $1', [archivoIdCreado]);
    expect(archivoRows[0].estado).toBe('procesado');

    const { rows: conceptoRows } = await db.pool.query('SELECT id, codigo, activo FROM catalogo_conceptos WHERE archivo_id = $1', [archivoIdCreado]);
    expect(conceptoRows).toHaveLength(1);
    expect(conceptoRows[0].codigo).toBe(COD_CONCEPTO);
    expect(conceptoRows[0].activo).toBe(true);
    const conceptoId = conceptoRows[0].id;

    const { rows: destajoRows } = await db.pool.query('SELECT concepto_id, precio_destajo, destajista_nombre FROM catalogo_destajo WHERE archivo_id = $1', [archivoIdCreado]);
    expect(destajoRows).toHaveLength(1);
    expect(destajoRows[0].concepto_id).toBe(conceptoId);
    expect(destajoRows[0].precio_destajo).toBe(80);
    expect(destajoRows[0].destajista_nombre).toBe('QA Destajista Prueba');

    const { rows: insumoRows } = await db.pool.query('SELECT concepto_id, insumo, codigo_insumo, cantidad, precio_unitario_insumo FROM catalogo_insumos WHERE archivo_id = $1', [archivoIdCreado]);
    expect(insumoRows).toHaveLength(1);
    expect(insumoRows[0].concepto_id).toBe(conceptoId);
    expect(insumoRows[0].codigo_insumo).toBe(COD_INSUMO);
    expect(insumoRows[0].cantidad).toBe(2);
    // Precio resuelto contra la Hoja 3 "Insumos" por código, no viene de la Hoja 4.
    expect(insumoRows[0].precio_unitario_insumo).toBe(45);

    const { rows: matrizRows } = await db.pool.query('SELECT concepto_id, datos FROM catalogo_matrices WHERE archivo_id = $1', [archivoIdCreado]);
    expect(matrizRows).toHaveLength(1);
    expect(matrizRows[0].concepto_id).toBe(conceptoId);
    // El JSONB preserva AMBOS renglones (insumo + factor_pct), a diferencia
    // de catalogo_insumos que solo indexa el de tipo 'insumo'.
    expect(matrizRows[0].datos.renglones).toHaveLength(2);
  });

  it('archivo inconsistente (código en Destajo que no existe en Presupuesto): estado error, sin filas parciales', async () => {
    const res = await request(app)
      .post('/api/costos/catalogo-maestro/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ archivo_url: archivoUrlInvalido, nombre_archivo: `QA_CATMAESTRO_invalido_${sufijo}.xlsx` });

    expect(res.status).toBe(400);
    expect(res.body.estado).toBe('error');
    const archivoId = res.body.id;

    const { rows: archivoRows } = await db.pool.query('SELECT estado, notas_error FROM catalogo_archivos WHERE id = $1', [archivoId]);
    expect(archivoRows[0].estado).toBe('error');
    expect(archivoRows[0].notas_error).toBeTruthy();

    const { rows: conceptoRows } = await db.pool.query('SELECT id FROM catalogo_conceptos WHERE archivo_id = $1', [archivoId]);
    expect(conceptoRows).toHaveLength(0);
  });
});

// prompt-normalizador-universal-ajal.md (fase adicional): el camino AJAL
// NO persiste nada en el POST /upload -- solo devuelve un preview y dejа el
// archivo en estado='pendiente_confirmacion'. Solo POST /upload/:id/confirmar
// escribe de verdad, y siempre re-descarga/re-parsea desde cero (nunca
// confía en el preview ya mostrado).
describe('POST /api/costos/catalogo-maestro/upload (camino AJAL: preview antes de persistir)', () => {
  it('archivo AJAL: NO persiste nada, devuelve preview y queda pendiente_confirmacion', async () => {
    const res = await request(app)
      .post('/api/costos/catalogo-maestro/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ archivo_url: archivoUrlAjal, nombre_archivo: `QA_CATMAESTRO_ajal_${sufijo}.xlsx` });

    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('pendiente_confirmacion');
    expect(res.body.formato_detectado).toBe('ajal');
    expect(res.body.preview.num_conceptos).toBe(3);
    expect(res.body.preview.conceptos).toHaveLength(3);
    expect(res.body.preview.conceptos[0]).toMatchObject({ codigo: expect.any(String), concepto: expect.any(String) });
    archivoIdAjal = res.body.id;

    const { rows: archivoRows } = await db.pool.query('SELECT estado, formato_detectado FROM catalogo_archivos WHERE id = $1', [archivoIdAjal]);
    expect(archivoRows[0].estado).toBe('pendiente_confirmacion');
    expect(archivoRows[0].formato_detectado).toBe('ajal');

    // Nada persistido todavía -- el preview no escribe en ninguna tabla hija.
    const { rows: conceptoRows } = await db.pool.query('SELECT id FROM catalogo_conceptos WHERE archivo_id = $1', [archivoIdAjal]);
    expect(conceptoRows).toHaveLength(0);
  });

  it('el archivo pendiente aparece en la lista con 0 conceptos activos (nada persistido)', async () => {
    const res = await request(app).get('/api/costos/catalogo-maestro/archivos').set('Authorization', `Bearer ${adminToken}`);
    const fila = res.body.archivos.find((a) => a.id === archivoIdAjal);
    expect(fila).toBeTruthy();
    expect(fila.estado).toBe('pendiente_confirmacion');
    expect(fila.formato_detectado).toBe('ajal');
    expect(Number(fila.conteo_conceptos)).toBe(0);
  });
});

describe('POST /api/costos/catalogo-maestro/upload/:id/confirmar', () => {
  it('rechaza a un usuario sin puesto admin/desarrollador (403)', async () => {
    const res = await request(app)
      .post(`/api/costos/catalogo-maestro/upload/${archivoIdAjal}/confirmar`)
      .set('Authorization', `Bearer ${tempToken}`)
      .send({ confirmado: true });
    expect(res.status).toBe(403);
  });

  it('400 si falta confirmado:true explícito', async () => {
    const res = await request(app)
      .post(`/api/costos/catalogo-maestro/upload/${archivoIdAjal}/confirmar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);

    // Confirma que de verdad no persistió nada por el intento fallido.
    const { rows } = await db.pool.query('SELECT id FROM catalogo_conceptos WHERE archivo_id = $1', [archivoIdAjal]);
    expect(rows).toHaveLength(0);
  });

  it('404 si el archivo no existe', async () => {
    const res = await request(app)
      .post('/api/costos/catalogo-maestro/upload/999999999/confirmar')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirmado: true });
    expect(res.status).toBe(404);
  });

  it('confirma correctamente: re-descarga/re-parsea y persiste las 3 partidas, estado pasa a procesado', async () => {
    const res = await request(app)
      .post(`/api/costos/catalogo-maestro/upload/${archivoIdAjal}/confirmar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirmado: true });

    expect(res.status).toBe(201);
    expect(res.body.estado).toBe('procesado');
    expect(res.body.numConceptos).toBe(3);
    expect(res.body.numDestajo).toBe(0);
    expect(res.body.numInsumos).toBe(0);
    expect(res.body.numMatrices).toBe(0);

    const { rows: archivoRows } = await db.pool.query('SELECT estado, formato_detectado FROM catalogo_archivos WHERE id = $1', [archivoIdAjal]);
    expect(archivoRows[0].estado).toBe('procesado');
    expect(archivoRows[0].formato_detectado).toBe('ajal');

    const { rows: conceptoRows } = await db.pool.query('SELECT codigo, activo FROM catalogo_conceptos WHERE archivo_id = $1 ORDER BY codigo', [archivoIdAjal]);
    expect(conceptoRows).toHaveLength(3);
    expect(conceptoRows.every((c) => c.activo)).toBe(true);
  });

  it('409 si se intenta confirmar de nuevo un archivo ya procesado', async () => {
    const res = await request(app)
      .post(`/api/costos/catalogo-maestro/upload/${archivoIdAjal}/confirmar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirmado: true });
    expect(res.status).toBe(409);
  });
});

describe('GET /api/costos/catalogo-maestro/archivos', () => {
  it('rechaza a un usuario sin puesto admin/desarrollador (403)', async () => {
    const res = await request(app).get('/api/costos/catalogo-maestro/archivos').set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(403);
  });

  it('lista el archivo procesado con metadata y conteo de conceptos activos', async () => {
    const res = await request(app).get('/api/costos/catalogo-maestro/archivos').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const fila = res.body.archivos.find((a) => a.id === archivoIdCreado);
    expect(fila).toBeTruthy();
    expect(fila.estado).toBe('procesado');
    expect(Number(fila.conteo_conceptos)).toBe(1);
    expect(fila.cargado_por_nombre).toBeTruthy();
  });
});

describe('DELETE /api/costos/catalogo-maestro/archivos/:id', () => {
  it('rechaza a un usuario sin puesto admin/desarrollador (403)', async () => {
    const res = await request(app).delete(`/api/costos/catalogo-maestro/archivos/${archivoIdCreado}`).set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(403);
  });

  it('404 si el archivo no existe', async () => {
    const res = await request(app).delete('/api/costos/catalogo-maestro/archivos/999999999').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it('soft-delete: desactiva conceptos, NO borra filas físicas ni el archivo', async () => {
    const res = await request(app).delete(`/api/costos/catalogo-maestro/archivos/${archivoIdCreado}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.conceptos_desactivados).toBe(1);

    const { rows: conceptoRows } = await db.pool.query('SELECT activo FROM catalogo_conceptos WHERE archivo_id = $1', [archivoIdCreado]);
    expect(conceptoRows).toHaveLength(1);
    expect(conceptoRows[0].activo).toBe(false);

    const { rows: archivoRows } = await db.pool.query('SELECT id, blob_url FROM catalogo_archivos WHERE id = $1', [archivoIdCreado]);
    expect(archivoRows).toHaveLength(1);
    expect(archivoRows[0].blob_url).toBe(archivoUrlValido);

    // La segunda vez ya no hay conceptos activos que desactivar.
    const res2 = await request(app).delete(`/api/costos/catalogo-maestro/archivos/${archivoIdCreado}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res2.status).toBe(200);
    expect(res2.body.conceptos_desactivados).toBe(0);
  });
});
