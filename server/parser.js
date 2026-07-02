'use strict';

/*
 * Parser generico para libros de Excel de presupuestos de obra civil
 * (formato tipo "GRUPO ROFORB" / Opus / Neodata / TCM): hojas de
 * "Presupuesto de obra" (catalogo de conceptos) y "Listado de insumos".
 *
 * No depende de nombres de hoja fijos: detecta las hojas relevantes
 * buscando filas de encabezado con columnas conocidas (Codigo, Concepto,
 * Unidad, Cantidad, Precio/Importe, % Incidencia) para que cualquier
 * presupuesto con esa estructura general pueda cargarse.
 */

const ExcelJS = require('exceljs');

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
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && v.result != null) return num(v.result);
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function toDateString(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object' && v.result instanceof Date) return v.result.toISOString().slice(0, 10);
  return null;
}

function rowValues(row, cols) {
  const out = [];
  for (let c = 1; c <= cols; c += 1) out.push(row.getCell(c).value);
  return out;
}

// Column-header synonyms we recognise (normalised, accent-stripped).
const HEADER_SYNONYMS = {
  codigo: ['CODIGO'],
  concepto: ['CONCEPTO', 'DESCRIPCION'],
  unidad: ['UNIDAD', 'UNI', 'UND'],
  cantidad: ['CANTIDAD'],
  precio: ['PRECIO', 'P. UNITARIO', 'P UNITARIO', 'PRECIO UNITARIO', 'PU'],
  importe: ['IMPORTE'],
  incidencia: ['% INCIDENCIA', 'INCIDENCIA', '%'],
};

function matchHeader(text) {
  const t = norm(text);
  for (const [key, options] of Object.entries(HEADER_SYNONYMS)) {
    if (options.includes(t)) return key;
  }
  return null;
}

// Scans the first `maxRows` rows of a sheet for a header row containing at
// least codigo+concepto+unidad+cantidad. Returns { rowNumber, colMap } or null.
function findHeaderRow(sheet, maxRows = 30) {
  const lastRow = Math.min(sheet.rowCount, maxRows);
  for (let r = 1; r <= lastRow; r += 1) {
    const row = sheet.getRow(r);
    const colMap = {};
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const key = matchHeader(cellText(cell.value));
      if (key && colMap[key] == null) colMap[key] = colNumber;
    });
    const hits = ['codigo', 'concepto', 'unidad', 'cantidad'].filter((k) => colMap[k] != null);
    if (hits.length >= 3) {
      return { rowNumber: r, colMap };
    }
  }
  return null;
}

function sheetHasTitle(sheet, needle, maxRows = 30) {
  const target = norm(needle);
  const lastRow = Math.min(sheet.rowCount, maxRows);
  for (let r = 1; r <= lastRow; r += 1) {
    const row = sheet.getRow(r);
    for (let c = 1; c <= Math.min(row.cellCount, 8); c += 1) {
      if (norm(cellText(row.getCell(c).value)).includes(target)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Metadata: Obra, Cliente, Lugar, fechas, totales — scanned label/value pairs
// across every sheet so it works regardless of which sheet holds them.
// ---------------------------------------------------------------------------
const META_LABELS = {
  'OBRA': 'obra',
  'CLIENTE': 'cliente',
  'LUGAR': 'lugar',
  'FECHA': 'fecha',
  'DURACION': 'duracion',
  'INICIO OBRA': 'inicio_obra',
  'INICIO DE OBRA': 'inicio_obra',
  'FIN OBRA': 'fin_obra',
  'FIN DE OBRA': 'fin_obra',
};

function extractMeta(workbook) {
  const meta = {};
  for (const sheet of workbook.worksheets) {
    const lastRow = Math.min(sheet.rowCount, 40);
    for (let r = 1; r <= lastRow; r += 1) {
      const row = sheet.getRow(r);
      const lastCol = Math.min(row.cellCount, 10);
      for (let c = 1; c <= lastCol; c += 1) {
        const label = norm(cellText(row.getCell(c).value)).replace(/:$/, '');
        const key = META_LABELS[label];
        if (!key || meta[key]) continue;
        // value is usually the next non-empty cell on the same row
        for (let c2 = c + 1; c2 <= lastCol + 2; c2 += 1) {
          const raw = row.getCell(c2).value;
          const dateStr = toDateString(raw);
          const txt = cellText(raw).trim();
          if (dateStr) { meta[key] = dateStr; break; }
          if (txt) { meta[key] = txt; break; }
        }
      }
    }
  }

  // Totales del presupuesto (cualquier hoja de presupuesto)
  for (const sheet of workbook.worksheets) {
    const lastRow = sheet.rowCount;
    for (let r = 1; r <= lastRow; r += 1) {
      const row = sheet.getRow(r);
      const label = norm(cellText(row.getCell(1).value));
      if (label.startsWith('TOTAL DEL PRESUPUESTO MOSTRADO SIN IVA')) {
        meta.total_sin_iva = meta.total_sin_iva || findFirstNumberInRow(row);
      } else if (label.startsWith('IVA')) {
        meta.iva_pct = meta.iva_pct || (label.match(/[\d.]+/) || [])[0];
        meta.iva_importe = meta.iva_importe || findFirstNumberInRow(row);
      } else if (label.startsWith('TOTAL DEL PRESUPUESTO MOSTRADO') && !label.includes('SIN IVA')) {
        meta.total_con_iva = meta.total_con_iva || findFirstNumberInRow(row);
      }
    }
    if (meta.total_con_iva) break;
  }
  return meta;
}

function findFirstNumberInRow(row) {
  const lastCol = Math.min(row.cellCount, 10);
  for (let c = 2; c <= lastCol; c += 1) {
    const v = row.getCell(c).value;
    const n = num(v);
    if (n) return n;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Budget concepts ("Presupuesto de obra"): hierarchical list of partidas /
// conceptos with codigo, concepto, unidad, cantidad, precio_unitario, importe.
// ---------------------------------------------------------------------------
function parseBudgetConcepts(sheet) {
  const header = findHeaderRow(sheet);
  if (!header) return [];
  const { rowNumber, colMap } = header;
  const items = [];
  let order = 0;
  let currentGroup = null;

  for (let r = rowNumber + 1; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const codigo = cellText(row.getCell(colMap.codigo || 1).value).trim();
    const concepto = cellText(row.getCell(colMap.concepto || 2).value).trim();
    if (!codigo && !concepto) continue;

    const upper = norm(concepto);
    if (upper.startsWith('TOTAL DEL PRESUPUESTO') || upper.startsWith('(*') || upper.startsWith('IVA')) {
      continue; // pie de pagina / totales generales
    }

    const unidad = colMap.unidad ? cellText(row.getCell(colMap.unidad).value).trim() : '';
    const cantidad = colMap.cantidad ? num(row.getCell(colMap.cantidad).value) : 0;
    const precio = colMap.precio ? num(row.getCell(colMap.precio).value) : 0;
    const importe = colMap.importe ? num(row.getCell(colMap.importe).value) : 0;

    const isTotalRow = upper.startsWith('TOTAL ');
    const isGroupHeader = !unidad && !cantidad && !precio && !isTotalRow;

    if (isGroupHeader) currentGroup = concepto;

    order += 1;
    items.push({
      codigo,
      concepto,
      unidad,
      cantidad,
      precio_unitario: precio,
      importe,
      grupo: currentGroup,
      es_total: isTotalRow ? 1 : 0,
      orden: order,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Insumos catalog ("Listado de insumos"): code, name, category (MATERIALES /
// MANO DE OBRA / EQUIPO Y HERRAMIENTA), unit, budgeted quantity/price/amount.
// Wrapped descriptions appear as follow-up rows with an empty codigo and
// zeroed numeric columns — they are appended to the previous item's name.
// ---------------------------------------------------------------------------
const CATEGORY_LABELS = ['MATERIALES', 'MANO DE OBRA', 'EQUIPO Y HERRAMIENTA', 'HERRAMIENTA', 'MAQUINARIA'];

function parseInsumos(sheet) {
  const header = findHeaderRow(sheet);
  if (!header) return [];
  const { rowNumber, colMap } = header;
  const items = [];
  let order = 0;
  let currentCategory = null;
  let last = null;

  for (let r = rowNumber + 1; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const codigo = cellText(row.getCell(colMap.codigo || 1).value).trim();
    const concepto = cellText(row.getCell(colMap.concepto || 2).value).trim();
    if (!codigo && !concepto) { last = null; continue; }

    const unidad = colMap.unidad ? cellText(row.getCell(colMap.unidad).value).trim() : '';
    const cantidad = colMap.cantidad ? num(row.getCell(colMap.cantidad).value) : 0;
    const precio = colMap.precio ? num(row.getCell(colMap.precio).value) : 0;
    const importe = colMap.importe ? num(row.getCell(colMap.importe).value) : 0;
    const upper = norm(concepto);

    if (!codigo && CATEGORY_LABELS.some((c) => upper === c || upper.startsWith(c))) {
      currentCategory = concepto.trim();
      last = null;
      continue;
    }
    if (upper.startsWith('TOTAL ')) { last = null; continue; }

    if (!codigo && !unidad && !cantidad && !precio && !importe && last) {
      // continuation line of a wrapped description
      last.concepto = `${last.concepto} ${concepto}`.replace(/\s+/g, ' ').trim();
      continue;
    }

    if (!codigo) { last = null; continue; }

    order += 1;
    const item = {
      codigo,
      concepto,
      categoria: currentCategory,
      unidad,
      cantidad_presupuesto: cantidad,
      precio_presupuesto: precio,
      importe_presupuesto: importe,
      orden: order,
    };
    items.push(item);
    last = item;
  }
  return items;
}

// ---------------------------------------------------------------------------
// Destajistas ("Control de Destajo"): optional sheet listing piecework workers
// and their assigned concepts. Detected by sheet name containing "DESTAJ".
// Flat-table format: DESTAJISTA | CODIGO | CONCEPTO | UNIDAD | CANTIDAD | P.U. DESTAJO
// ---------------------------------------------------------------------------
const DESTAJO_SYNONYMS = {
  destajista: ['DESTAJISTA', 'NOMBRE', 'CONTRATISTA', 'CUADRILLA', 'TRABAJADOR'],
  codigo: ['CODIGO', 'CLAVE'],
  concepto: ['CONCEPTO', 'DESCRIPCION', 'ACTIVIDAD', 'TRABAJO'],
  unidad: ['UNIDAD', 'UNI', 'UND'],
  cantidad: ['CANTIDAD', 'CANT'],
  precio_destajo: ['P.U. DESTAJO', 'PRECIO DESTAJO', 'PU DESTAJO', 'DESTAJO', 'PRECIO UNITARIO', 'P.U.'],
};

function findHeaderRowDestajo(sheet, maxRows = 25) {
  for (let r = 1; r <= Math.min(sheet.rowCount, maxRows); r++) {
    const row = sheet.getRow(r);
    const colMap = {};
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const t = norm(cellText(cell.value)).replace(/:$/, '');
      for (const [key, opts] of Object.entries(DESTAJO_SYNONYMS)) {
        if (opts.includes(t) && colMap[key] == null) colMap[key] = col;
      }
    });
    if (colMap.concepto != null && (colMap.cantidad != null || colMap.precio_destajo != null)) {
      return { rowNumber: r, colMap };
    }
  }
  return null;
}

function parseDestajistas(workbook) {
  let destSheet = null;
  for (const sheet of workbook.worksheets) {
    if (norm(sheet.name).includes('DESTAJ')) { destSheet = sheet; break; }
  }
  if (!destSheet) return [];

  const header = findHeaderRowDestajo(destSheet);
  if (!header) return [];

  const { rowNumber, colMap } = header;
  const results = new Map();
  let currentDest = null;

  for (let r = rowNumber + 1; r <= destSheet.rowCount; r++) {
    const row = destSheet.getRow(r);
    const destNom = colMap.destajista != null ? cellText(row.getCell(colMap.destajista).value).trim() : '';
    const concepto = colMap.concepto != null ? cellText(row.getCell(colMap.concepto).value).trim() : '';
    if (!destNom && !concepto) continue;

    if (destNom) currentDest = destNom;
    if (!currentDest) continue;

    if (!results.has(currentDest)) {
      results.set(currentDest, { nombre: currentDest, items: [], orden: results.size });
    }

    if (concepto) {
      const codigo = colMap.codigo != null ? cellText(row.getCell(colMap.codigo).value).trim() : '';
      const unidad = colMap.unidad != null ? cellText(row.getCell(colMap.unidad).value).trim() : '';
      const cantidad_asignada = colMap.cantidad != null ? num(row.getCell(colMap.cantidad).value) : 0;
      const precio_destajo = colMap.precio_destajo != null ? num(row.getCell(colMap.precio_destajo).value) : 0;
      results.get(currentDest).items.push({
        codigo: codigo || null,
        concepto,
        unidad: unidad || null,
        cantidad_asignada,
        precio_destajo,
        orden: results.get(currentDest).items.length,
      });
    }
  }

  return Array.from(results.values());
}

// ---------------------------------------------------------------------------
async function parseWorkbook(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  let insumosSheet = null;
  let budgetSheet = null;

  for (const sheet of workbook.worksheets) {
    const titleNorm = norm(sheet.name);
    const header = findHeaderRow(sheet);
    if (!header) continue;
    const hasIncidencia = header.colMap.incidencia != null;
    const hasPrecio = header.colMap.precio != null;
    const looksLikeInsumos = titleNorm.includes('INSUMO') ||
      sheetHasTitle(sheet, 'LISTADO DE INSUMOS') ||
      (hasIncidencia && hasPrecio && sheetHasTitle(sheet, 'INSUMOS'));
    const looksLikeBudget = sheetHasTitle(sheet, 'PRESUPUESTO DE OBRA') ||
      (header.colMap.precio != null && header.colMap.importe != null && !looksLikeInsumos);

    if (looksLikeInsumos && !insumosSheet) insumosSheet = sheet;
    else if (looksLikeBudget && !budgetSheet) budgetSheet = sheet;
  }

  const meta = extractMeta(workbook);
  const conceptos = budgetSheet ? parseBudgetConcepts(budgetSheet) : [];
  const insumos = insumosSheet ? parseInsumos(insumosSheet) : [];
  const destajistas = parseDestajistas(workbook);

  return {
    meta,
    conceptos,
    insumos,
    destajistas,
    sheets: {
      presupuesto: budgetSheet ? budgetSheet.name : null,
      insumos: insumosSheet ? insumosSheet.name : null,
    },
  };
}

module.exports = { parseWorkbook };
