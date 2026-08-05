'use strict';

// Exportación a Excel del Análisis de Precios Unitarios en formato Neodata
// (prompt-20-matrices-formato-neodata.md, CP6) — deliberadamente separada de
// server/exportHelper.js: sendXlsxExport es 1 hoja = 1 tabla plana con 1 fila
// de encabezado y columnas uniformes, sin celdas combinadas ni múltiples
// bloques por hoja. Este formato real necesita ambas cosas (encabezado de
// documento + un bloque de análisis completo por concepto, con subtotales y
// cascada intercalados), así que usa ExcelJS directo.
//
// Layout: una sola hoja "Matrices", con los análisis en bloques consecutivos
// (mismo criterio que el Excel de referencia real, hoja "Matrices" con varios
// análisis uno debajo del otro) — tanto para exportar 1 matriz como todas las
// de la obra, con la única diferencia de cuántos bloques trae `analisis`.
const ExcelJS = require('exceljs');

const NUM_COLS = 8; // Código | Concepto | Unidad | Precio | Op | Cantidad | Importe | % Incidencia
const MONEY_FMT = '"$"#,##0.00';
const CAT_LABELS = { MATERIALES: 'MATERIALES', 'MANO DE OBRA': 'MANO DE OBRA', 'EQUIPO Y HERRAMIENTA': 'EQUIPO Y HERRAMIENTA' };

function mergeFullRow(sheet, rowNumber) {
  sheet.mergeCells(rowNumber, 1, rowNumber, NUM_COLS);
}

function addTextRow(sheet, text, { bold = false, italic = false, size } = {}) {
  const row = sheet.addRow([text]);
  mergeFullRow(sheet, row.number);
  const cell = row.getCell(1);
  cell.font = { bold, italic, size: size || 11 };
  return row;
}

function addDocHeader(sheet, { clienteNombre, obraNombre }) {
  addTextRow(sheet, 'GRUPO ROFORB', { bold: true, size: 14 });
  addTextRow(sheet, `Cliente: ${clienteNombre || '—'}`);
  addTextRow(sheet, `Obra: ${obraNombre || '—'}`);
  addTextRow(sheet, 'ANÁLISIS DE PRECIOS UNITARIOS', { bold: true, size: 12 });
  addTextRow(sheet, 'ART. 45 A.1 RLOPySRM', { italic: true, size: 9 });
  addTextRow(sheet, `Fecha: ${new Date().toISOString().slice(0, 10)}`, { size: 9 });
  sheet.addRow([]);
}

function addColumnHeaderRow(sheet) {
  const row = sheet.addRow(['CÓDIGO', 'CONCEPTO', 'UNIDAD', 'PRECIO', 'OP', 'CANTIDAD', 'IMPORTE', '% INCIDENCIA']);
  row.font = { bold: true, size: 9 };
  row.eachCell((cell) => { cell.alignment = { vertical: 'middle' }; });
}

function addRenglonRow(sheet, { codigo, concepto, unidad, precio, cantidad, importe, pctIncidencia }) {
  const row = sheet.addRow([codigo || '', concepto || '', unidad || '', precio, '*', cantidad, importe, pctIncidencia]);
  row.getCell(4).numFmt = MONEY_FMT;
  row.getCell(7).numFmt = MONEY_FMT;
  return row;
}

function addLabelValueRow(sheet, label, { indirectoPct, valor, incidencia } = {}) {
  const row = sheet.addRow([label, '', '', '', '', indirectoPct ?? '', valor, incidencia ?? '']);
  row.getCell(1).font = { bold: true };
  if (typeof valor === 'number') row.getCell(7).numFmt = MONEY_FMT;
  return row;
}

// Un análisis completo: encabezado (Partida/Análisis No./Cantidad/Importe),
// descripción, renglones por categoría con subtotales, cascada CD→PU e
// importe en letra. `a` = { concepto, matriz } tal como los arma
// matrizToAnalisisData() en server/app.js a partir de getMatrizConRenglones().
function addAnalisisBlock(sheet, a) {
  const { concepto, matriz } = a;

  const rowPartida = sheet.addRow([
    `Partida: ${matriz.partida || '—'}`, '', '', '',
    `Análisis No.: ${matriz.analisis_no || '—'}`, '', '', '',
  ]);
  sheet.mergeCells(rowPartida.number, 1, rowPartida.number, 4);
  sheet.mergeCells(rowPartida.number, 5, rowPartida.number, 8);
  rowPartida.font = { bold: true };

  const rowAnalisis = sheet.addRow([
    `Análisis: ${concepto.codigo || ''}`, concepto.unidad || '',
    `Cantidad ${fmtNum(concepto.cantidad)}`, '', `Importe ${fmtNum(concepto.importe)}`, '', '', '',
  ]);
  sheet.mergeCells(rowAnalisis.number, 3, rowAnalisis.number, 4);
  sheet.mergeCells(rowAnalisis.number, 5, rowAnalisis.number, 8);

  addTextRow(sheet, concepto.concepto || '');
  sheet.addRow([]);
  addColumnHeaderRow(sheet);

  for (const cat of matriz.categorias) {
    addTextRow(sheet, CAT_LABELS[cat.categoria] || cat.categoria, { bold: true });

    if (!cat.renglones.length) {
      addLabelValueRow(sheet, `SUBTOTAL: ${cat.categoria}`, { valor: 'No disponible' });
      continue;
    }

    for (const r of cat.renglones) {
      if (r.tipo === 'factor_pct') {
        addRenglonRow(sheet, {
          codigo: r.codigo, concepto: r.descripcion, unidad: '%',
          precio: r.precio_referencia, cantidad: r.cantidad, importe: r.importe, pctIncidencia: r.pct_incidencia,
        });
      } else {
        addRenglonRow(sheet, {
          codigo: r.codigo, concepto: r.descripcion, unidad: r.unidad,
          precio: r.precio_presupuesto, cantidad: r.cantidad, importe: r.importe, pctIncidencia: r.pct_incidencia,
        });
      }
    }

    if (cat.categoria === 'MANO DE OBRA' && cat.importe_jornada != null) {
      addLabelValueRow(sheet, 'Importe:', { valor: cat.importe_jornada });
      addLabelValueRow(sheet, `Rendimiento: ${concepto.unidad || ''}/JOR`, {
        indirectoPct: matriz.rendimiento, valor: cat.subtotal, incidencia: cat.pct_incidencia,
      });
    }

    addLabelValueRow(sheet, `SUBTOTAL: ${cat.categoria}`, {
      valor: cat.subtotal != null ? cat.subtotal : 'No disponible', incidencia: cat.pct_incidencia,
    });
  }

  sheet.addRow([]);
  if (!matriz.completa) {
    addTextRow(sheet, 'Matriz incompleta — falta Rendimiento u otra categoría sin renglones. No se muestra la cascada.', { italic: true });
    return;
  }

  addLabelValueRow(sheet, '(CD) Costo directo', { valor: matriz.costo_directo, incidencia: 1 });
  addLabelValueRow(sheet, '(CI) INDIRECTOS', { indirectoPct: Number(matriz.pct_indirecto) / 100, valor: matriz.ci });
  addLabelValueRow(sheet, 'SUBTOTAL1', { valor: matriz.subtotal1 });
  addLabelValueRow(sheet, '(CF) FINANCIAMIENTO', { indirectoPct: Number(matriz.pct_financiamiento) / 100, valor: matriz.cf });
  addLabelValueRow(sheet, 'SUBTOTAL2', { valor: matriz.subtotal2 });
  addLabelValueRow(sheet, '(CU) UTILIDAD', { indirectoPct: Number(matriz.pct_utilidad) / 100, valor: matriz.cu });
  const rowPU = addLabelValueRow(sheet, 'PRECIO UNITARIO (CD+CI+CF+CU)', { valor: matriz.precio_unitario_calculado });
  rowPU.font = { bold: true };
  rowPU.getCell(7).font = { bold: true };
  if (matriz.importe_en_letra) addTextRow(sheet, matriz.importe_en_letra, { italic: true });
}

function fmtNum(n) {
  return n == null ? '' : Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// analisis: [{ concepto: {codigo, concepto, unidad, cantidad, importe}, matriz: getMatrizConRenglones() }]
function buildWorkbook({ clienteNombre, obraNombre, analisis }) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Matrices');
  sheet.columns = [
    { width: 16 }, { width: 34 }, { width: 9 }, { width: 12 },
    { width: 4 }, { width: 11 }, { width: 13 }, { width: 13 },
  ];
  addDocHeader(sheet, { clienteNombre, obraNombre });
  analisis.forEach((a, idx) => {
    addAnalisisBlock(sheet, a);
    if (idx < analisis.length - 1) { sheet.addRow([]); sheet.addRow([]); }
  });
  return workbook;
}

async function sendMatricesNeodataExport(res, { filename, clienteNombre, obraNombre, analisis }) {
  const workbook = buildWorkbook({ clienteNombre, obraNombre, analisis });
  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(Buffer.from(buffer));
}

module.exports = { sendMatricesNeodataExport };
