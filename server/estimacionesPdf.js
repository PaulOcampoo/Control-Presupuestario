'use strict';

const PDFDocument = require('pdfkit');

const COLS = [
  { key: 'codigo', label: 'Código', width: 55, align: 'left' },
  { key: 'concepto', label: 'Concepto', width: 215, align: 'left' },
  { key: 'unidad', label: 'Unidad', width: 45, align: 'center' },
  { key: 'cantidad_periodo', label: 'Cant. periodo', width: 70, align: 'right' },
  { key: 'importe_periodo', label: 'Importe periodo', width: 90, align: 'right' },
  { key: 'cantidad_acumulada', label: 'Cant. acumulada', width: 70, align: 'right' },
  { key: 'importe_acumulado', label: 'Importe acumulado', width: 90, align: 'right' },
  { key: 'porcentaje_avance', label: '% avance', width: 55, align: 'right' },
];
const TABLE_LEFT = 40;
const TABLE_TOP = 190;
const ROW_H = 18;
const PAGE_BOTTOM = 560; // pdfkit landscape letter margin 40 -> usable hasta ~572

const money = (n) => `$${Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`;
const num = (n) => Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 });

function drawTableHeader(doc, y) {
  doc.font('Helvetica-Bold').fontSize(8);
  let x = TABLE_LEFT;
  COLS.forEach((c) => {
    doc.text(c.label, x, y, { width: c.width, align: c.align });
    x += c.width;
  });
  doc.moveTo(TABLE_LEFT, y + 14).lineTo(TABLE_LEFT + COLS.reduce((s, c) => s + c.width, 0), y + 14).strokeColor('#999999').stroke();
  return y + 20;
}

function drawRow(doc, y, item) {
  doc.font('Helvetica').fontSize(8).fillColor('#000000');
  let x = TABLE_LEFT;
  const values = {
    codigo: item.codigo || '',
    concepto: item.concepto || '',
    unidad: item.unidad || '',
    cantidad_periodo: num(item.cantidad_periodo),
    importe_periodo: money(item.importe_periodo),
    cantidad_acumulada: num(item.cantidad_acumulada),
    importe_acumulado: money(item.importe_acumulado),
    porcentaje_avance: `${num(item.porcentaje_avance)}%`,
  };
  COLS.forEach((c) => {
    doc.text(values[c.key], x, y, { width: c.width, align: c.align, ellipsis: true });
    x += c.width;
  });
  return y + ROW_H;
}

// Genera el PDF formal de una Estimación (encabezado de obra/cliente/folio/
// periodo, tabla de conceptos con cantidad/importe del periodo y acumulado,
// totales, espacio de firma Residente/Cliente). Retorna un Buffer — el
// llamador se encarga de subirlo a Vercel Blob.
function buildEstimacionPdf({ project, clienteNombre, estimacion, items, residenteNombre, adminNombre }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'letter', layout: 'landscape', margin: 40 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font('Helvetica-Bold').fontSize(16).text('Estimación de obra', { align: 'center' });
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(10);
    doc.text(`Obra: ${project.nombre}`);
    doc.text(`Cliente: ${clienteNombre || '—'}`);
    doc.text(`Folio: ${estimacion.folio}    Periodo: ${estimacion.periodo_inicio} al ${estimacion.periodo_fin}`);
    doc.text(`Residente: ${residenteNombre || '—'}    Aprobó: ${adminNombre || '—'}    Fecha de aprobación: ${new Date().toISOString().slice(0, 10)}`);

    let y = drawTableHeader(doc, TABLE_TOP);
    for (const item of items) {
      if (y > PAGE_BOTTOM) {
        doc.addPage();
        y = drawTableHeader(doc, 40);
      }
      y = drawRow(doc, y, item);
    }

    y += 10;
    doc.moveTo(TABLE_LEFT, y).lineTo(TABLE_LEFT + COLS.reduce((s, c) => s + c.width, 0), y).strokeColor('#999999').stroke();
    y += 10;
    doc.font('Helvetica-Bold').fontSize(10);
    doc.text(`Total del periodo: ${money(estimacion.total_periodo)}`, TABLE_LEFT, y);
    doc.text(`Total acumulado: ${money(estimacion.total_acumulado)}`, TABLE_LEFT + 260, y);

    // Espacio de firma — en página nueva si ya no cabe debajo de los totales
    let firmaY = y + 70;
    if (firmaY > PAGE_BOTTOM) { doc.addPage(); firmaY = 60; }
    doc.font('Helvetica').fontSize(9);
    doc.moveTo(TABLE_LEFT, firmaY).lineTo(TABLE_LEFT + 220, firmaY).stroke();
    doc.text('Firma Residente', TABLE_LEFT, firmaY + 4);
    doc.moveTo(TABLE_LEFT + 400, firmaY).lineTo(TABLE_LEFT + 620, firmaY).stroke();
    doc.text('Firma Cliente', TABLE_LEFT + 400, firmaY + 4);

    doc.end();
  });
}

module.exports = { buildEstimacionPdf };
