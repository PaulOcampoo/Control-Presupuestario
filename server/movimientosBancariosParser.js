'use strict';

/*
 * Contabilidad Fase 3 (prompt-contabilidad-fase3-conciliacion.md) — parser
 * de movimientos bancarios (.xlsx o .csv). Mismo estilo de detección de
 * encabezado por sinónimos que server/parser.js (presupuesto), pero
 * independiente — columnas fijas confirmadas con Paul: Fecha, Descripción,
 * Monto, Tipo (no configurable en esta fase; si aparece un banco con
 * formato muy distinto, es un prompt aparte).
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
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && v.result != null) return num(v.result);
  const n = parseFloat(String(v).replace(/[,$]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function toDateString(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object' && v.result instanceof Date) return v.result.toISOString().slice(0, 10);
  const t = String(v).trim();
  // Formatos comunes de export bancario: DD/MM/YYYY, YYYY-MM-DD.
  const m1 = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m1) return `${m1[3]}-${m1[2].padStart(2, '0')}-${m1[1].padStart(2, '0')}`;
  const m2 = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m2) return `${m2[1]}-${m2[2].padStart(2, '0')}-${m2[3].padStart(2, '0')}`;
  return null;
}

const HEADER_SYNONYMS = {
  fecha: ['FECHA'],
  descripcion: ['DESCRIPCION', 'CONCEPTO', 'DETALLE', 'REFERENCIA'],
  monto: ['MONTO', 'IMPORTE', 'CANTIDAD'],
  tipo: ['TIPO', 'CARGO/ABONO', 'CARGO ABONO'],
};

function matchHeader(text) {
  const t = norm(text);
  for (const [key, options] of Object.entries(HEADER_SYNONYMS)) {
    if (options.includes(t)) return key;
  }
  return null;
}

// 'tipo' explícito acepta cargo/abono y debe/haber como sinónimos.
function normalizarTipo(text) {
  const t = norm(text);
  if (['CARGO', 'DEBE', 'D'].includes(t)) return 'cargo';
  if (['ABONO', 'HABER', 'A'].includes(t)) return 'abono';
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
    // fecha+monto son obligatorios para reconocer la fila de encabezado;
    // descripcion/tipo pueden faltar y se reportan como fila inválida más abajo.
    if (colMap.fecha != null && colMap.monto != null) {
      return { rowNumber: r, colMap };
    }
  }
  return null;
}

// filePath -> { movimientos: [{fecha, descripcion, monto, tipo}], filasInvalidas: [{fila, motivo}] }
async function parseMovimientosBancarios(filePath, nombreArchivoOriginal) {
  const workbook = new ExcelJS.Workbook();
  const esCsv = /\.csv$/i.test(nombreArchivoOriginal || filePath);
  if (esCsv) {
    await workbook.csv.readFile(filePath);
  } else {
    await workbook.xlsx.readFile(filePath);
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    const err = new Error('El archivo no tiene ninguna hoja/contenido reconocible.');
    err.status = 400;
    throw err;
  }

  const header = findHeaderRow(sheet);
  if (!header) {
    const err = new Error('No se reconocieron las columnas esperadas (Fecha, Descripción, Monto, Tipo). Verifica el encabezado del archivo.');
    err.status = 400;
    throw err;
  }

  const movimientos = [];
  const filasInvalidas = [];
  const { rowNumber: headerRow, colMap } = header;
  const lastRow = sheet.rowCount;

  for (let r = headerRow + 1; r <= lastRow; r += 1) {
    const row = sheet.getRow(r);
    const fechaRaw = colMap.fecha != null ? row.getCell(colMap.fecha).value : null;
    const descripcionRaw = colMap.descripcion != null ? row.getCell(colMap.descripcion).value : null;
    const montoRaw = colMap.monto != null ? row.getCell(colMap.monto).value : null;
    const tipoRaw = colMap.tipo != null ? row.getCell(colMap.tipo).value : null;

    const fecha = toDateString(fechaRaw);
    const descripcion = cellText(descripcionRaw).trim();
    const montoNum = num(montoRaw);

    // Fila totalmente vacía (frecuente al final del archivo) — se ignora en silencio.
    if (!fecha && !descripcion && montoNum == null) continue;

    if (!fecha || montoNum == null || montoNum === 0) {
      filasInvalidas.push({ fila: r, motivo: !fecha ? 'Fecha inválida o vacía' : 'Monto inválido, vacío o cero' });
      continue;
    }

    let tipo = normalizarTipo(cellText(tipoRaw));
    let monto = montoNum;
    if (!tipo) {
      // Fallback: signo del monto, si no hay columna Tipo reconocible o viene vacía.
      tipo = montoNum < 0 ? 'cargo' : 'abono';
    }
    monto = Math.abs(montoNum);

    if (!descripcion) {
      filasInvalidas.push({ fila: r, motivo: 'Descripción vacía' });
      continue;
    }

    movimientos.push({ fecha, descripcion, monto, tipo });
  }

  return { movimientos, filasInvalidas };
}

module.exports = { parseMovimientosBancarios };
