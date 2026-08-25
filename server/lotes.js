'use strict';

// Lotes/Unidades (prompt-lotes-fase1.md, diagnóstico previo en
// prompt-diagnostico-lotes-fase1.md) — Fase 1 (cimiento) del roadmap
// "Desarrollador de Vivienda": estatus de construcción de cada lote/casa
// individual de un fraccionamiento. Mismo patrón de separación que
// server/ordenesCambio.js: los endpoints HTTP viven en server/app.js, la
// lógica de negocio (parseo de Excel, diff de importación, queries) aquí.

const ExcelJS = require('exceljs');
const db = require('./db');

const ESTATUS_LOTE = ['sin_iniciar', 'en_proceso', 'terminado', 'entregado'];
// Fase 3 (prompt-implementacion-catalogo-comercial.md): estatus de venta,
// deliberadamente independiente de ESTATUS_LOTE (construcción) — ver
// comentario del CHECK constraint en server/db.js.
const ESTATUS_VENTA = ['no_disponible', 'disponible', 'apartado', 'vendido'];

function norm(text) {
  return String(text == null ? '' : text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toUpperCase();
}

function cellText(cell) {
  if (cell == null) return '';
  if (typeof cell === 'object') {
    if (cell.richText) return cell.richText.map((p) => p.text).join('');
    if (cell.text != null) return String(cell.text);
    if (cell.result != null) return String(cell.result);
  }
  return String(cell);
}

function num(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && v.result != null) return num(v.result);
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Mismo estilo de detección de encabezado por sinónimos que
// server/movimientosBancariosParser.js — columnas fijas confirmadas en el
// diagnóstico: manzana/numero_lote/modelo_vivienda/superficie_m2, solo
// numero_lote es obligatorio.
const HEADER_SYNONYMS = {
  manzana: ['MANZANA', 'MZA', 'MZ'],
  numero_lote: ['NUMERO_LOTE', 'NUMERO LOTE', 'LOTE', 'NO. LOTE', 'NO LOTE', 'N° LOTE'],
  modelo_vivienda: ['MODELO_VIVIENDA', 'MODELO VIVIENDA', 'MODELO'],
  superficie_m2: ['SUPERFICIE_M2', 'SUPERFICIE M2', 'SUPERFICIE', 'M2'],
};

function matchHeader(text) {
  const t = norm(text);
  for (const [key, options] of Object.entries(HEADER_SYNONYMS)) {
    if (options.includes(t)) return key;
  }
  return null;
}

function findHeaderRow(sheet, maxRows = 30) {
  const lastRow = Math.min(sheet.rowCount, maxRows);
  for (let r = 1; r <= lastRow; r += 1) {
    const row = sheet.getRow(r);
    const colMap = {};
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const key = matchHeader(cellText(cell.value));
      if (key && colMap[key] == null) colMap[key] = colNumber;
    });
    if (colMap.numero_lote != null) return { rowNumber: r, colMap };
  }
  return null;
}

// filePath -> { lotes: [{manzana, numero_lote, modelo_vivienda, superficie_m2}], filasInvalidas: [{fila, motivo}] }
async function parseLotesExcel(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    const err = new Error('El archivo no tiene ninguna hoja/contenido reconocible.');
    err.status = 400;
    throw err;
  }

  const header = findHeaderRow(sheet);
  if (!header) {
    const err = new Error('No se reconoció la columna "numero_lote" (o "Lote"). Verifica el encabezado del archivo.');
    err.status = 400;
    throw err;
  }

  const lotes = [];
  const filasInvalidas = [];
  const { rowNumber: headerRow, colMap } = header;
  const lastRow = sheet.rowCount;
  const vistos = new Set(); // dedup dentro del propio archivo (manzana|numero_lote)

  for (let r = headerRow + 1; r <= lastRow; r += 1) {
    const row = sheet.getRow(r);
    const manzanaRaw = colMap.manzana != null ? row.getCell(colMap.manzana).value : null;
    const numeroLoteRaw = colMap.numero_lote != null ? row.getCell(colMap.numero_lote).value : null;
    const modeloRaw = colMap.modelo_vivienda != null ? row.getCell(colMap.modelo_vivienda).value : null;
    const superficieRaw = colMap.superficie_m2 != null ? row.getCell(colMap.superficie_m2).value : null;

    const manzana = cellText(manzanaRaw).trim();
    const numero_lote = cellText(numeroLoteRaw).trim();
    const modelo_vivienda = cellText(modeloRaw).trim() || null;
    const superficie_m2 = num(superficieRaw);

    // Fila totalmente vacía (frecuente al final del archivo) — se ignora en silencio.
    if (!manzana && !numero_lote && !modelo_vivienda && superficie_m2 == null) continue;

    if (!numero_lote) {
      filasInvalidas.push({ fila: r, motivo: 'numero_lote vacío' });
      continue;
    }

    const clave = `${manzana}|${numero_lote}`;
    if (vistos.has(clave)) {
      filasInvalidas.push({ fila: r, motivo: `Lote duplicado dentro del mismo archivo (manzana "${manzana}", lote "${numero_lote}")` });
      continue;
    }
    vistos.add(clave);

    lotes.push({ manzana, numero_lote, modelo_vivienda, superficie_m2 });
  }

  return { lotes, filasInvalidas };
}

// Diff contra lotes ya existentes de la obra — mismo patrón que
// contabilidad.diffMovimientosImportacion, clave (manzana, numero_lote).
async function diffLotesImportacion(pid, lotesParsed) {
  if (!lotesParsed.length) return { nuevos: [], existentes: [] };
  const { rows: existentesRows } = await db.pool.query(
    'SELECT manzana, numero_lote FROM lotes WHERE project_id = $1', [pid]
  );
  const existentesSet = new Set(existentesRows.map((r) => `${r.manzana}|${r.numero_lote}`));
  const nuevos = [];
  const existentes = [];
  for (const l of lotesParsed) {
    (existentesSet.has(`${l.manzana}|${l.numero_lote}`) ? existentes : nuevos).push(l);
  }
  return { nuevos, existentes };
}

// Confirma la importación dentro de una transacción — ON CONFLICT DO UPDATE
// de los campos descriptivos (modelo_vivienda/superficie_m2), decisión
// confirmada explícitamente: reimportar corrige datos capturados mal la
// primera vez, PERO estatus/fecha_entrega_estimada/fecha_entrega_real NUNCA
// se tocan aquí (solo se editan manualmente vía updateLote) — perder estatus
// ya capturado por una reimportación sería un bug grave (Stop Condition
// explícita del prompt). (xmax = 0) distingue INSERT real de UPDATE por
// conflicto para reportar nuevos vs. actualizados sin una segunda query.
async function confirmarImportacionLotes(pid, lotesParsed, importadoPor) {
  return db.withTransaction(async (client) => {
    let nuevos = 0;
    let actualizados = 0;
    for (const l of lotesParsed) {
      const { rows } = await client.query(
        `INSERT INTO lotes (project_id, manzana, numero_lote, modelo_vivienda, superficie_m2)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (project_id, manzana, numero_lote) DO UPDATE SET
           modelo_vivienda = EXCLUDED.modelo_vivienda,
           superficie_m2 = EXCLUDED.superficie_m2,
           actualizado_en = NOW()
         RETURNING (xmax = 0) AS es_nuevo`,
        [pid, l.manzana, l.numero_lote, l.modelo_vivienda, l.superficie_m2]
      );
      if (rows[0].es_nuevo) nuevos += 1; else actualizados += 1;
    }
    return { nuevos, actualizados, importado_por: importadoPor };
  });
}

// JOIN con modelos_vivienda (LEFT — un lote puede no tener modelo asignado) +
// precio_efectivo calculado aquí (Fase 3, prompt-implementacion-catalogo-
// comercial.md) para que el frontend nunca tenga que replicar la fórmula
// COALESCE(override, precio del modelo).
async function listLotes(pid, { estatus, manzana } = {}) {
  const params = [pid];
  let where = 'l.project_id = $1';
  if (estatus) { params.push(estatus); where += ` AND l.estatus = $${params.length}`; }
  if (manzana) { params.push(manzana); where += ` AND l.manzana = $${params.length}`; }
  const { rows } = await db.pool.query(
    `SELECT l.*,
       mv.nombre AS modelo_nombre, mv.precio_lista AS modelo_precio_lista,
       mv.superficie_construida_m2 AS modelo_superficie_construida_m2,
       COALESCE(l.precio_lista_override, mv.precio_lista) AS precio_efectivo
     FROM lotes l
     LEFT JOIN modelos_vivienda mv ON mv.id = l.modelo_vivienda_id
     WHERE ${where} ORDER BY l.manzana, l.numero_lote`, params
  );
  return rows;
}

// Fase 3: modelo_vivienda_id, si se envía, debe pertenecer a la misma obra
// que el lote — evita mezclar modelos entre proyectos.
async function validarModeloDeLaObra(pid, modeloId) {
  if (modeloId == null) return;
  const { rows } = await db.pool.query(
    'SELECT 1 FROM modelos_vivienda WHERE id = $1 AND project_id = $2', [modeloId, pid]
  );
  if (!rows[0]) {
    const err = new Error('El modelo de vivienda no pertenece a esta obra');
    err.status = 400;
    throw err;
  }
}

async function createLote(pid, {
  manzana, numero_lote, modelo_vivienda, superficie_m2, fecha_entrega_estimada,
  modelo_vivienda_id, precio_lista_override, estatus_venta,
}) {
  if (!numero_lote || !String(numero_lote).trim()) {
    const err = new Error('numero_lote es requerido');
    err.status = 400;
    throw err;
  }
  const estatusVentaFinal = estatus_venta || 'no_disponible';
  if (!ESTATUS_VENTA.includes(estatusVentaFinal)) {
    const err = new Error(`estatus_venta inválido: "${estatusVentaFinal}"`);
    err.status = 400;
    throw err;
  }
  await validarModeloDeLaObra(pid, modelo_vivienda_id ?? null);
  const { rows } = await db.pool.query(
    `INSERT INTO lotes (project_id, manzana, numero_lote, modelo_vivienda, superficie_m2, fecha_entrega_estimada,
       modelo_vivienda_id, precio_lista_override, estatus_venta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [pid, (manzana || '').trim(), String(numero_lote).trim(), modelo_vivienda || null, superficie_m2 ?? null,
      fecha_entrega_estimada || null, modelo_vivienda_id ?? null, precio_lista_override ?? null, estatusVentaFinal]
  );
  return rows[0];
}

// Cambio de estatus a 'entregado' auto-captura fecha_entrega_real = hoy si
// el caller no mandó una explícita — mismo criterio de "captura automática
// salvo que el usuario diga lo contrario" que fecha_aprobacion en
// estimaciones. Nunca limpia fecha_entrega_real al salir de 'entregado' (se
// preserva el histórico de cuándo se entregó, salvo que el caller mande
// fecha_entrega_real explícitamente, incluido null).
async function updateLote(id, pid, data) {
  const { rows: existRows } = await db.pool.query('SELECT * FROM lotes WHERE id = $1 AND project_id = $2', [id, pid]);
  if (!existRows[0]) {
    const err = new Error('Lote no encontrado');
    err.status = 404;
    throw err;
  }
  const actual = existRows[0];

  const campos = {
    manzana: data.manzana !== undefined ? String(data.manzana || '').trim() : actual.manzana,
    numero_lote: data.numero_lote !== undefined ? String(data.numero_lote || '').trim() : actual.numero_lote,
    modelo_vivienda: data.modelo_vivienda !== undefined ? (data.modelo_vivienda || null) : actual.modelo_vivienda,
    superficie_m2: data.superficie_m2 !== undefined ? data.superficie_m2 : actual.superficie_m2,
    estatus: data.estatus !== undefined ? data.estatus : actual.estatus,
    fecha_entrega_estimada: data.fecha_entrega_estimada !== undefined ? data.fecha_entrega_estimada : actual.fecha_entrega_estimada,
    fecha_entrega_real: data.fecha_entrega_real !== undefined ? data.fecha_entrega_real : actual.fecha_entrega_real,
    modelo_vivienda_id: data.modelo_vivienda_id !== undefined ? data.modelo_vivienda_id : actual.modelo_vivienda_id,
    precio_lista_override: data.precio_lista_override !== undefined ? data.precio_lista_override : actual.precio_lista_override,
    estatus_venta: data.estatus_venta !== undefined ? data.estatus_venta : actual.estatus_venta,
  };

  if (!campos.numero_lote) {
    const err = new Error('numero_lote es requerido');
    err.status = 400;
    throw err;
  }
  if (!ESTATUS_LOTE.includes(campos.estatus)) {
    const err = new Error(`estatus inválido: "${campos.estatus}"`);
    err.status = 400;
    throw err;
  }
  if (!ESTATUS_VENTA.includes(campos.estatus_venta)) {
    const err = new Error(`estatus_venta inválido: "${campos.estatus_venta}"`);
    err.status = 400;
    throw err;
  }
  await validarModeloDeLaObra(pid, campos.modelo_vivienda_id);
  if (campos.estatus === 'entregado' && data.fecha_entrega_real === undefined && !actual.fecha_entrega_real) {
    campos.fecha_entrega_real = new Date().toISOString().slice(0, 10);
  }

  const { rows } = await db.pool.query(
    `UPDATE lotes SET manzana=$1, numero_lote=$2, modelo_vivienda=$3, superficie_m2=$4,
       estatus=$5, fecha_entrega_estimada=$6, fecha_entrega_real=$7,
       modelo_vivienda_id=$8, precio_lista_override=$9, estatus_venta=$10, actualizado_en=NOW()
     WHERE id = $11 AND project_id = $12
     RETURNING *`,
    [campos.manzana, campos.numero_lote, campos.modelo_vivienda, campos.superficie_m2,
      campos.estatus, campos.fecha_entrega_estimada, campos.fecha_entrega_real,
      campos.modelo_vivienda_id, campos.precio_lista_override, campos.estatus_venta, id, pid]
  );
  return rows[0];
}

module.exports = {
  ESTATUS_LOTE,
  ESTATUS_VENTA,
  parseLotesExcel,
  diffLotesImportacion,
  confirmarImportacionLotes,
  listLotes,
  createLote,
  updateLote,
};
