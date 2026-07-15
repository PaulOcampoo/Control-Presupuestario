'use strict';

const PDFDocument = require('pdfkit');

// Mismo patrón que estimacionesPdf.js: anchos medidos contra el texto real
// para que ninguna columna se parta en el encabezado.
const COLS = [
  { key: 'obra', label: 'Obra', width: 130, align: 'left' },
  { key: 'residentes', label: 'Residente(s)', width: 110, align: 'left' },
  { key: 'trabajador', label: 'Trabajador', width: 130, align: 'left' },
  { key: 'puesto', label: 'Puesto', width: 80, align: 'left' },
  { key: 'dias', label: 'Días', width: 35, align: 'right' },
  { key: 'jornal', label: 'Jornal', width: 65, align: 'right' },
  { key: 'destajo', label: 'Destajo', width: 65, align: 'right' },
  { key: 'total', label: 'Total', width: 65, align: 'right' },
];
const TABLE_LEFT = 40;
const TABLE_TOP = 140;
const ROW_PADDING = 6;
const PAGE_BOTTOM = 560;

const money = (n) => `$${Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`;

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

function rowValues(obra, nom, item) {
  return {
    obra: obra.obra_nombre,
    residentes: obra.residentes_a_cargo || '—',
    trabajador: item.trabajador_nombre,
    puesto: item.trabajador_puesto || '',
    dias: String(item.dias_trabajados ?? 0),
    jornal: money(item.monto_jornal),
    destajo: money(item.monto_destajo),
    total: money(item.monto_total),
  };
}

function rowHeight(doc, values) {
  doc.font('Helvetica').fontSize(8);
  let maxH = 0;
  for (const c of COLS) {
    const h = doc.heightOfString(values[c.key], { width: c.width });
    if (h > maxH) maxH = h;
  }
  return maxH + ROW_PADDING;
}

function drawRow(doc, y, values, height) {
  doc.font('Helvetica').fontSize(8).fillColor('#000000');
  let x = TABLE_LEFT;
  COLS.forEach((c) => {
    doc.text(values[c.key], x, y, { width: c.width, align: c.align });
    x += c.width;
  });
  return y + height;
}

// Genera el PDF del reporte de nómina semanal por cliente (obras activas,
// agrupado visualmente por obra con su periodo de nómina). Retorna un
// Buffer — el llamador lo envía directo como descarga, sin persistir a Blob
// (a diferencia de las Estimaciones, este reporte es transitorio/on-demand,
// no un documento oficial con historial).
function buildNominaReporteSemanalPdf(reporte) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'letter', layout: 'landscape', margin: 40 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font('Helvetica-Bold').fontSize(16).text('Reporte de nómina semanal', { align: 'center' });
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(10);
    doc.text(`Cliente: ${reporte.cliente.nombre}`);
    doc.text(`Semana consultada (contiene): ${reporte.fecha}`);
    doc.text(`Obras activas incluidas: ${reporte.obras.length}`);

    let y = drawTableHeader(doc, TABLE_TOP);
    let huboFilas = false;
    for (const obra of reporte.obras) {
      for (const nom of obra.nominas) {
        for (const item of nom.items) {
          huboFilas = true;
          const values = rowValues(obra, nom, item);
          const height = rowHeight(doc, values);
          if (y + height > PAGE_BOTTOM) {
            doc.addPage();
            y = drawTableHeader(doc, 40);
          }
          y = drawRow(doc, y, values, height);
        }
      }
    }
    if (!huboFilas) {
      doc.font('Helvetica').fontSize(9).text('No hay nóminas registradas para esta semana en las obras activas de este cliente.', TABLE_LEFT, y);
      y += 20;
    }

    y += 10;
    doc.moveTo(TABLE_LEFT, y).lineTo(TABLE_LEFT + COLS.reduce((s, c) => s + c.width, 0), y).strokeColor('#999999').stroke();
    y += 10;
    doc.font('Helvetica-Bold').fontSize(10);
    doc.text(`Total del cliente: ${money(reporte.total_cliente)}`, TABLE_LEFT, y);

    doc.end();
  });
}

module.exports = { buildNominaReporteSemanalPdf };
