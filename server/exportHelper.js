'use strict';

const ExcelJS = require('exceljs');

const NUM_FORMATS = {
  money: '"$"#,##0.00',
  pct: '0.0"%"',
  int: '0',
};

function sanitizeFilenamePart(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '');
}

// Ej: buildExportFilename('Insumos', 'Presupuestos Residencial Vinte') -> "Insumos_PresupuestosResidencialVinte_2026-07-02.xlsx"
// projectNombre es opcional (catálogos globales como Proveedores no dependen de un proyecto).
function buildExportFilename(prefix, projectNombre) {
  const fecha = new Date().toISOString().slice(0, 10);
  const parts = [sanitizeFilenamePart(prefix) || 'Export', sanitizeFilenamePart(projectNombre), fecha].filter(Boolean);
  return `${parts.join('_')}.xlsx`;
}

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F5' } };
const BOLD_ROW_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };

// columns: [{ header, key, width?, format?: 'money'|'pct'|'int' }]
// headerFill: true para pintar el encabezado con fondo distinguible además
// de negritas (opt-in, ningún export existente lo pasaba antes de
// prompt-fix-export-generador-y-formato.md — todos siguen viéndose igual).
// Las filas pueden incluir la propiedad reservada `__bold` (ExcelJS solo
// mapea columnas por `key`, así que una propiedad extra sin `key` asociado
// se ignora al pintar celdas) para pintarse en negritas + fondo tenue —
// usada hoy por las filas "TOTAL — <concepto>" del Generador de
// Presupuestos.
function addSheet(workbook, { sheetName, columns, rows, headerFill }) {
  const sheet = workbook.addWorksheet(String(sheetName).slice(0, 31));
  sheet.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width || 20 }));
  sheet.getRow(1).font = { bold: true };
  if (headerFill) sheet.getRow(1).fill = HEADER_FILL;
  rows.forEach((r) => {
    const row = sheet.addRow(r);
    if (r.__bold) { row.font = { bold: true }; row.fill = BOLD_ROW_FILL; }
  });
  columns.forEach((c, idx) => {
    if (c.format && NUM_FORMATS[c.format]) sheet.getColumn(idx + 1).numFmt = NUM_FORMATS[c.format];
  });
  return sheet;
}

// sheets: [{ sheetName, columns, rows, headerFill? }] — helper único reusado
// por todos los endpoints de exportación, para no duplicar la generación de
// .xlsx en cada uno.
async function sendXlsxExport(res, { filename, sheets }) {
  const workbook = new ExcelJS.Workbook();
  sheets.forEach((s) => addSheet(workbook, s));
  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(Buffer.from(buffer));
}

module.exports = { sendXlsxExport, buildExportFilename };
