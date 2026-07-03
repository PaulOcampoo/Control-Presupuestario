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

// columns: [{ header, key, width?, format?: 'money'|'pct'|'int' }]
function addSheet(workbook, { sheetName, columns, rows }) {
  const sheet = workbook.addWorksheet(String(sheetName).slice(0, 31));
  sheet.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width || 20 }));
  sheet.getRow(1).font = { bold: true };
  rows.forEach((r) => sheet.addRow(r));
  columns.forEach((c, idx) => {
    if (c.format && NUM_FORMATS[c.format]) sheet.getColumn(idx + 1).numFmt = NUM_FORMATS[c.format];
  });
  return sheet;
}

// sheets: [{ sheetName, columns, rows }] — helper único reusado por todos los
// endpoints de exportación, para no duplicar la generación de .xlsx en cada uno.
async function sendXlsxExport(res, { filename, sheets }) {
  const workbook = new ExcelJS.Workbook();
  sheets.forEach((s) => addSheet(workbook, s));
  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(Buffer.from(buffer));
}

module.exports = { sendXlsxExport, buildExportFilename };
