// Integration tests para Task 3/5 del Catálogo Maestro (prompt-catalogo-
// maestro-costos.md): búsqueda (GET .../conceptos?q=) e importación a una
// obra EXISTENTE (POST .../importar-a-obra). Mismo patrón que tests/
// catalogo-maestro.test.js (Task 2): DB real + Blob real, fixture .xlsx vía
// ExcelJS con los headers exactos de parseArchivo4Hojas.
//
// Fixture propia (no reusa la de catalogo-maestro.test.js -- archivos de
// test corren en procesos/orden no garantizado, cero estado compartido
// entre archivos): 2 conceptos, mismo destajista en ambos (para probar
// reuso de destajista por nombre al importar los 2 juntos), 1 concepto con
// matriz (1 renglón insumo + 1 factor_pct).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { put, del } from '@vercel/blob';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const sufijo = Date.now();
const COD_C1 = `QA_CMIMP_C1_${sufijo}`;
const COD_C2 = `QA_CMIMP_C2_${sufijo}`;
const COD_INSUMO = `QA_CMIMP_INS_${sufijo}`;
const NOMBRE_DESTAJISTA = `QA Destajista Compartido ${sufijo}`;

let adminToken;
let tempUserId;
let tempToken;
const tempUsuario = `qa_cmimp_${sufijo}`;
const tempPassword = 'QaCmImportarTemp123!';

let archivoUrl;
let archivoId;
let catalogoConceptoIdC1;
let catalogoConceptoIdC2;

let clienteId;
let proyectoDestinoId;

const blobsSubidos = [];

async function construirXlsx() {
  const wb = new ExcelJS.Workbook();

  const presupuesto = wb.addWorksheet('Presupuesto');
  presupuesto.addRow(['Código', 'Concepto', 'Unidad', 'Cantidad', 'Precio Unitario']);
  presupuesto.addRow([COD_C1, 'QA concepto importar 1', 'M2', 10, 250]);
  presupuesto.addRow([COD_C2, 'QA concepto importar 2', 'PZA', 3, 900]);

  const destajo = wb.addWorksheet('Destajo');
  destajo.addRow(['Código', 'Unidad', 'Precio Destajo Máximo', 'Destajista (obra de origen)']);
  destajo.addRow([COD_C1, 'M2', 80, NOMBRE_DESTAJISTA]);
  destajo.addRow([COD_C2, 'PZA', 300, NOMBRE_DESTAJISTA]);

  const insumos = wb.addWorksheet('Insumos');
  insumos.addRow(['Código Insumo', 'Descripción', 'Categoría', 'Unidad', 'Precio Presupuesto', 'IVA Tasa', 'Código Concepto']);
  insumos.addRow([COD_INSUMO, 'QA insumo importar', 'MATERIALES', 'PZA', 45, 16, COD_C1]);

  const matrices = wb.addWorksheet('Matrices');
  matrices.addRow([
    'Código Concepto', 'Partida', 'Rendimiento', '% Indirecto', '% Utilidad', '% Financiamiento',
    'Análisis No.', 'Cuadrilla', 'Categoría (renglón)', 'Tipo (renglón)',
    'Código Insumo (renglón)', 'Descripción (renglón)', 'Cantidad (renglón)', 'Factor Referencia (renglón)',
  ]);
  matrices.addRow([
    COD_C1, 'GRP', 10, 6, 15, 4, 1, null,
    'MATERIALES', 'insumo', COD_INSUMO, 'QA insumo importar', 2, null,
  ]);
  matrices.addRow([
    COD_C1, 'GRP', 10, 6, 15, 4, 1, null,
    'EQUIPO Y HERRAMIENTA', 'factor_pct', '', '% Herramienta Menor', 5, 'MANO DE OBRA',
  ]);

  return wb.xlsx.writeBuffer();
}

async function login(usuario, password) {
  const res = await request(app).post('/api/auth/login').send({ usuario, password });
  if (res.status !== 200 || !res.body.token) throw new Error(`Login falló para ${usuario}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token;
}

async function setPermisoCostosCrear(usuarioId, puedeCrear) {
  const res = await request(app)
    .put(`/api/permisos/${usuarioId}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ proyecto_id: null, permisos: [{ seccion: 'costos', puede_ver: true, puede_crear: puedeCrear }] });
  if (res.status !== 200) throw new Error(`No se pudo setear el permiso: ${res.status} ${JSON.stringify(res.body)}`);
}

beforeAll(async () => {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada — no se puede correr la suite.');
  adminToken = await login(ADMIN_USER, ADMIN_PASSWORD);

  const createRes = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA Catalogo Maestro Importar', usuario: tempUsuario, password: tempPassword, puesto: 'residente' });
  if (createRes.status !== 201 && createRes.status !== 200) throw new Error(`No se pudo crear el usuario temporal: ${createRes.status} ${JSON.stringify(createRes.body)}`);
  tempUserId = createRes.body.id;
  tempToken = await login(tempUsuario, tempPassword);

  // Obra destino EXISTENTE (el escenario real de Task 3: importar a una obra
  // que ya existe, no crear una nueva).
  const { rows: [{ id: clId }] } = await db.pool.query('INSERT INTO clientes (nombre) VALUES ($1) RETURNING id', [`QA_CMIMP_CLIENTE_${sufijo}`]);
  clienteId = clId;
  const { rows: [{ id: pId }] } = await db.pool.query('INSERT INTO proyectos (nombre, cliente_id) VALUES ($1, $2) RETURNING id', [`QA_CMIMP_OBRA_${sufijo}`, clienteId]);
  proyectoDestinoId = pId;

  const buffer = await construirXlsx();
  const blobResult = await put(`catalogo-maestro/vitest-importar-${sufijo}.xlsx`, buffer, {
    access: 'private', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  archivoUrl = blobResult.url;
  blobsSubidos.push(archivoUrl);

  const uploadRes = await request(app)
    .post('/api/costos/catalogo-maestro/upload')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ archivo_url: archivoUrl, nombre_archivo: `QA_CMIMP_${sufijo}.xlsx` });
  if (uploadRes.status !== 201) throw new Error(`Upload de fixture falló: ${uploadRes.status} ${JSON.stringify(uploadRes.body)}`);
  archivoId = uploadRes.body.id;

  const { rows: conceptoRows } = await db.pool.query('SELECT id, codigo FROM catalogo_conceptos WHERE archivo_id = $1', [archivoId]);
  catalogoConceptoIdC1 = conceptoRows.find((c) => c.codigo === COD_C1).id;
  catalogoConceptoIdC2 = conceptoRows.find((c) => c.codigo === COD_C2).id;
});

afterAll(async () => {
  if (tempUserId) await request(app).delete(`/api/usuarios/${tempUserId}`).set('Authorization', `Bearer ${adminToken}`);
  if (proyectoDestinoId) {
    await db.pool.query('DELETE FROM matriz_precio_renglones WHERE matriz_id IN (SELECT id FROM matrices_precio_unitario WHERE concepto_id IN (SELECT id FROM conceptos WHERE project_id = $1))', [proyectoDestinoId]);
    await db.pool.query('DELETE FROM matrices_precio_unitario WHERE concepto_id IN (SELECT id FROM conceptos WHERE project_id = $1)', [proyectoDestinoId]);
    await db.pool.query('DELETE FROM concepto_insumos WHERE concepto_id IN (SELECT id FROM conceptos WHERE project_id = $1)', [proyectoDestinoId]);
    await db.pool.query('DELETE FROM destajo_items WHERE project_id = $1', [proyectoDestinoId]);
    await db.pool.query('DELETE FROM destajistas WHERE project_id = $1', [proyectoDestinoId]);
    await db.pool.query('DELETE FROM insumos WHERE project_id = $1', [proyectoDestinoId]);
    await db.pool.query('DELETE FROM conceptos WHERE project_id = $1', [proyectoDestinoId]);
    await db.pool.query('DELETE FROM proyectos WHERE id = $1', [proyectoDestinoId]);
  }
  if (clienteId) await db.pool.query('DELETE FROM clientes WHERE id = $1', [clienteId]);
  await db.pool.query('DELETE FROM catalogo_archivos WHERE nombre_archivo LIKE $1', [`QA_CMIMP%${sufijo}%`]);
  for (const url of blobsSubidos) await del(url).catch(() => {});
  await db.pool.end();
});

describe('GET /api/costos/catalogo-maestro/conceptos', () => {
  it('requiere autenticación (401)', async () => {
    const res = await request(app).get('/api/costos/catalogo-maestro/conceptos').query({ q: COD_C1 });
    expect(res.status).toBe(401);
  });

  it('rechaza sin costos.puede_crear (403)', async () => {
    await setPermisoCostosCrear(tempUserId, false);
    const res = await request(app).get('/api/costos/catalogo-maestro/conceptos').query({ q: COD_C1 }).set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(403);
  });

  it('400 si falta q', async () => {
    const res = await request(app).get('/api/costos/catalogo-maestro/conceptos').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it('encuentra el concepto por código, con archivo origen y flags de destajo/insumos/matriz', async () => {
    const res = await request(app).get('/api/costos/catalogo-maestro/conceptos').query({ q: COD_C1 }).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const fila = res.body.conceptos.find((c) => c.codigo === COD_C1);
    expect(fila).toBeTruthy();
    expect(fila.archivo_id).toBe(archivoId);
    expect(fila.nombre_archivo).toBe(`QA_CMIMP_${sufijo}.xlsx`);
    expect(fila.tiene_destajo).toBe(true);
    expect(fila.tiene_insumos).toBe(true);
    expect(fila.tiene_matriz).toBe(true);
  });

  it('encuentra por texto del concepto, no solo por código', async () => {
    const res = await request(app).get('/api/costos/catalogo-maestro/conceptos').query({ q: 'QA concepto importar' }).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.conceptos.length).toBeGreaterThanOrEqual(2);
  });
});

describe('POST /api/costos/catalogo-maestro/importar-a-obra', () => {
  it('requiere autenticación (401)', async () => {
    const res = await request(app).post('/api/costos/catalogo-maestro/importar-a-obra').send({ proyecto_id: proyectoDestinoId, concepto_ids: [catalogoConceptoIdC1] });
    expect(res.status).toBe(401);
  });

  it('rechaza sin costos.puede_crear (403)', async () => {
    const res = await request(app)
      .post('/api/costos/catalogo-maestro/importar-a-obra')
      .set('Authorization', `Bearer ${tempToken}`)
      .send({ proyecto_id: proyectoDestinoId, concepto_ids: [catalogoConceptoIdC1] });
    expect(res.status).toBe(403);
  });

  it('404 si la obra destino no existe', async () => {
    const res = await request(app)
      .post('/api/costos/catalogo-maestro/importar-a-obra')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ proyecto_id: 999999999, concepto_ids: [catalogoConceptoIdC1] });
    expect(res.status).toBe(404);
  });

  it('400 si concepto_ids está vacío', async () => {
    const res = await request(app)
      .post('/api/costos/catalogo-maestro/importar-a-obra')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ proyecto_id: proyectoDestinoId, concepto_ids: [] });
    expect(res.status).toBe(400);
  });

  it('400 si algún concepto_id no existe en el catálogo maestro', async () => {
    const res = await request(app)
      .post('/api/costos/catalogo-maestro/importar-a-obra')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ proyecto_id: proyectoDestinoId, concepto_ids: [999999999] });
    expect(res.status).toBe(400);
  });

  it('importa 2 conceptos a la obra existente: concepto, destajo (destajista compartido reusado), insumo y matriz correctos', async () => {
    const res = await request(app)
      .post('/api/costos/catalogo-maestro/importar-a-obra')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ proyecto_id: proyectoDestinoId, concepto_ids: [catalogoConceptoIdC1, catalogoConceptoIdC2] });

    expect(res.status).toBe(201);
    expect(res.body.importados).toHaveLength(2);
    expect(res.body.omitidos_duplicados).toHaveLength(0);

    const { rows: conceptosObra } = await db.pool.query('SELECT id, codigo, precio_unitario, cantidad, activo FROM conceptos WHERE project_id = $1 ORDER BY codigo', [proyectoDestinoId]);
    expect(conceptosObra).toHaveLength(2);
    const c1 = conceptosObra.find((c) => c.codigo === COD_C1);
    const c2 = conceptosObra.find((c) => c.codigo === COD_C2);
    expect(Number(c1.precio_unitario)).toBe(250);
    expect(Number(c2.precio_unitario)).toBe(900);
    expect(c1.activo).toBe(1);

    // Destajista compartido: 2 conceptos con el MISMO nombre de destajista ->
    // debe reusarse el mismo destajista_id, NO crear 2 destajistas.
    const { rows: destajistasObra } = await db.pool.query('SELECT id, nombre FROM destajistas WHERE project_id = $1', [proyectoDestinoId]);
    expect(destajistasObra).toHaveLength(1);
    expect(destajistasObra[0].nombre).toBe(NOMBRE_DESTAJISTA);

    const { rows: destajoItemsObra } = await db.pool.query('SELECT concepto_id, destajista_id, precio_destajo FROM destajo_items WHERE project_id = $1', [proyectoDestinoId]);
    expect(destajoItemsObra).toHaveLength(2);
    expect(destajoItemsObra.every((d) => d.destajista_id === destajistasObra[0].id)).toBe(true);

    // Insumo + matriz, solo para C1.
    const { rows: insumosObra } = await db.pool.query('SELECT id, codigo, precio_presupuesto FROM insumos WHERE project_id = $1', [proyectoDestinoId]);
    expect(insumosObra).toHaveLength(1);
    expect(insumosObra[0].codigo).toBe(COD_INSUMO);
    expect(Number(insumosObra[0].precio_presupuesto)).toBe(45);

    const { rows: matricesObra } = await db.pool.query('SELECT id, concepto_id, pct_indirecto, pct_utilidad, pct_financiamiento, rendimiento FROM matrices_precio_unitario WHERE concepto_id = $1', [c1.id]);
    expect(matricesObra).toHaveLength(1);
    expect(Number(matricesObra[0].pct_indirecto)).toBe(6);
    expect(Number(matricesObra[0].pct_utilidad)).toBe(15);
    expect(Number(matricesObra[0].pct_financiamiento)).toBe(4);

    const { rows: renglonesObra } = await db.pool.query('SELECT categoria, tipo, insumo_id, cantidad FROM matriz_precio_renglones WHERE matriz_id = $1 ORDER BY orden', [matricesObra[0].id]);
    expect(renglonesObra).toHaveLength(2);
    expect(renglonesObra[0].tipo).toBe('insumo');
    expect(renglonesObra[0].insumo_id).toBe(insumosObra[0].id);
    expect(Number(renglonesObra[0].cantidad)).toBe(2);
    expect(renglonesObra[1].tipo).toBe('factor_pct');
    expect(renglonesObra[1].insumo_id).toBeNull();

    const { rows: conceptoInsumosObra } = await db.pool.query('SELECT concepto_id, insumo_id FROM concepto_insumos WHERE concepto_id = $1', [c1.id]);
    expect(conceptoInsumosObra).toHaveLength(1);
    expect(conceptoInsumosObra[0].insumo_id).toBe(insumosObra[0].id);
  });

  it('reintentar los mismos 2 conceptos a la MISMA obra: se omiten por duplicado, sin crear filas nuevas', async () => {
    const res = await request(app)
      .post('/api/costos/catalogo-maestro/importar-a-obra')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ proyecto_id: proyectoDestinoId, concepto_ids: [catalogoConceptoIdC1, catalogoConceptoIdC2] });

    expect(res.status).toBe(201);
    expect(res.body.importados).toHaveLength(0);
    expect(res.body.omitidos_duplicados).toHaveLength(2);
    expect(res.body.omitidos_duplicados.map((o) => o.codigo).sort()).toEqual([COD_C1, COD_C2].sort());

    const { rows: conceptosObra } = await db.pool.query('SELECT id FROM conceptos WHERE project_id = $1', [proyectoDestinoId]);
    expect(conceptosObra).toHaveLength(2); // sigue siendo 2, no 4
    const { rows: destajistasObra } = await db.pool.query('SELECT id FROM destajistas WHERE project_id = $1', [proyectoDestinoId]);
    expect(destajistasObra).toHaveLength(1); // sigue siendo 1, no se duplicó
  });
});
