'use strict';

// PDF de Corte de Obra (prompt-corte-de-obra.md, columnas actualizadas en
// prompt-corte-obra-v2-implementacion.md) — mismo patrón que
// nominaReporteSemanalPdf.js: Buffer transitorio, sin persistir a Blob.
// Landscape (antes portrait) — 6 columnas ya no caben cómodas en carta
// vertical desde que se agregaron Cobertura % y Avance Valorizado.

const PDFDocument = require('pdfkit');

const COLS = [
  { key: 'label', label: 'Categoría', width: 140, align: 'left' },
  { key: 'presupuesto', label: 'Presupuesto', width: 105, align: 'right' },
  { key: 'cobertura', label: 'Cobertura', width: 75, align: 'right' },
  { key: 'real_pagado', label: 'Real — Pagado', width: 105, align: 'right' },
  { key: 'real_avance', label: 'Real — Avance Valorizado', width: 105, align: 'right' },
  { key: 'variacion_monto', label: 'Variación $', width: 90, align: 'right' },
  { key: 'variacion_pct', label: 'Variación %', width: 75, align: 'right' },
];
const TABLE_LEFT = 40;
const PAGE_BOTTOM = 540;
const TABLE_WIDTH = COLS.reduce((s, c) => s + c.width, 0);

const FILAS = [
  { key: 'mano_de_obra', label: 'Mano de Obra' },
  { key: 'materiales', label: 'Materiales' },
  { key: 'equipo_herramienta', label: 'Equipo y Herramienta' },
  { key: 'total', label: 'Total' },
];

const money = (n) => (n == null ? 'No disponible' : `$${Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`);
const pct = (n) => (n == null ? '—' : `${Number(n).toLocaleString('es-MX', { maximumFractionDigits: 1 })}%`);

function drawTableHeader(doc, y) {
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#000000');
  let x = TABLE_LEFT;
  COLS.forEach((c) => { doc.text(c.label, x, y, { width: c.width, align: c.align }); x += c.width; });
  doc.moveTo(TABLE_LEFT, y + 14).lineTo(TABLE_LEFT + TABLE_WIDTH, y + 14).strokeColor('#999999').stroke();
  return y + 20;
}

function drawFilasTable(doc, yInicial, filas) {
  let y = drawTableHeader(doc, yInicial);
  doc.font('Helvetica').fontSize(9).fillColor('#000000');
  for (const f of FILAS) {
    const row = filas[f.key];
    const values = {
      label: f.label,
      presupuesto: money(row.presupuesto),
      cobertura: row.presupuesto_pct_cobertura == null ? '—' : pct(row.presupuesto_pct_cobertura),
      real_pagado: money(row.real_pagado),
      real_avance: row.real_avance_valorizado == null ? 'No disponible' : money(row.real_avance_valorizado),
      variacion_monto: row.presupuesto == null ? 'No disponible' : money(row.variacion_monto),
      variacion_pct: row.presupuesto == null ? '—' : pct(row.variacion_pct),
    };
    let x = TABLE_LEFT;
    COLS.forEach((c) => { doc.text(values[c.key], x, y, { width: c.width, align: c.align }); x += c.width; });
    y += 16;
  }
  return y;
}

// data: { fecha_corte, scope: 'obra'|'todas', agregado, obras: [{obra:{id,nombre}, presupuesto_desglose_disponible, filas, advertencias}] }
function buildCorteObraPdf(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'letter', layout: 'landscape', margin: 40 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font('Helvetica-Bold').fontSize(16).text('Corte de Obra', { align: 'center' });
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(10);
    doc.text(`Fecha de corte: ${data.fecha_corte}`);
    doc.text(`Alcance: ${data.scope === 'obra' ? (data.obras[0] ? data.obras[0].obra.nombre : '') : `Todas las obras (${data.obras.length})`}`);
    doc.text(`Generado: ${new Date().toLocaleString('es-MX')}`);
    doc.font('Helvetica-Oblique').fontSize(8).fillColor('#666666').text(
      'Los montos de Presupuesto por categoría vienen del catálogo de insumos del Excel y pueden no sumar el Total oficial de la obra — no todos los conceptos se detallan a nivel insumo.',
      { width: TABLE_WIDTH }
    );
    doc.fillColor('#000000');

    let y = doc.y + 14;
    if (data.scope === 'todas') {
      doc.font('Helvetica-Bold').fontSize(11).text('Agregado', TABLE_LEFT, y);
      y += 16;
      y = drawFilasTable(doc, y, data.agregado) + 20;
    }

    for (const o of data.obras) {
      if (y > PAGE_BOTTOM - 120) { doc.addPage(); y = 40; }
      doc.font('Helvetica-Bold').fontSize(11).text(o.obra.nombre, TABLE_LEFT, y);
      y = doc.y + 4;
      if (!o.presupuesto_desglose_disponible) {
        doc.font('Helvetica').fontSize(8).fillColor('#666666').text(
          'Presupuesto por categoría no disponible para esta obra (sin insumos importados con importe presupuestado) — el Total de Presupuesto sí se muestra.',
          TABLE_LEFT, y, { width: TABLE_WIDTH }
        );
        y = doc.y + 6;
        doc.fillColor('#000000');
      }
      for (const adv of o.advertencias || []) {
        doc.font('Helvetica').fontSize(8).fillColor('#997a00').text(adv, TABLE_LEFT, y, { width: TABLE_WIDTH });
        y = doc.y + 4;
        doc.fillColor('#000000');
      }
      y = drawFilasTable(doc, y, o.filas) + 20;
    }

    doc.end();
  });
}

module.exports = { buildCorteObraPdf };
