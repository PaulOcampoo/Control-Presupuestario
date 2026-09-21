'use strict';

// Export a Excel/PDF del Generador de Obra (prompt-generadores-de-obra.md,
// fase de export/preview). Construye ambos formatos a partir de los mismos
// datos ya agrupados (agruparGeneradorObra) — la ruta en server/app.js se
// encarga de las queries y de traer el binario de cada foto desde Vercel
// Blob (get(blob_url, {access:'private'})); este módulo es puro: no toca la
// DB ni Blob directamente, para poder probarlo sin red.

const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

const ESTADO_LABELS = { borrador: 'Borrador', enviada: 'Enviada', aprobada: 'Aprobada', rechazada: 'Rechazada' };

// Mismo criterio que partidaSubpartidaDeConcepto() en public/app.js:24019 —
// debe reproducirse exacto para que la agrupación del export coincida con la
// que ya ve el residente en la UI de captura (Partida = penúltimo nivel de
// ruta_jerarquica, Subpartida = último nivel, con 'General' como fallback).
function partidaSubpartidaDeConcepto(c) {
  const ruta = Array.isArray(c.ruta_jerarquica) && c.ruta_jerarquica.length ? c.ruta_jerarquica : null;
  const partida = ruta && ruta.length >= 2 ? ruta[ruta.length - 2] : 'General';
  const subpartida = ruta && ruta.length >= 1 ? ruta[ruta.length - 1] : (c.grupo || 'General');
  return { partida, subpartida };
}

// A diferencia de la UI de captura (que muestra TODOS los conceptos
// disponibles de la obra, incluso sin renglones, para poder capturarlos), el
// export/preview es un documento de evidencia: solo incluye partidas/
// subpartidas que tengan al menos un renglón capturado o al menos una foto.
// Las fotos ya vienen con su propio partida/subpartida de texto libre (lo
// captura el residente desde el mismo valor que calculó
// partidaSubpartidaDeConcepto() para ese concepto en la UI — ver
// public/app.js:24144, data-partida/data-subpartida), así que agrupan bajo
// la misma clave que los renglones de esa subpartida sin transformación
// adicional.
function agruparGeneradorObra(renglones, fotos) {
  const grupos = new Map();
  const orden = [];
  function getGrupo(partida, subpartida) {
    const key = `${partida}␟${subpartida}`;
    if (!grupos.has(key)) {
      grupos.set(key, { partida, subpartida, renglones: [], fotos: [], subtotal: 0 });
      orden.push(key);
    }
    return grupos.get(key);
  }
  for (const r of renglones || []) {
    const { partida, subpartida } = partidaSubpartidaDeConcepto(r);
    const g = getGrupo(partida, subpartida);
    g.renglones.push(r);
    g.subtotal += Number(r.subtotal || 0);
  }
  for (const f of fotos || []) {
    const g = getGrupo(f.partida || 'General', f.subpartida || 'General');
    g.fotos.push(f);
  }
  return orden.map((k) => grupos.get(k));
}

// ExcelJS.addImage() solo soporta 'jpeg' | 'png' | 'gif' (ver
// node_modules/exceljs/index.d.ts) y pdfkit's doc.image() solo soporta JPEG
// y PNG. webp SÍ es un formato válido de subida (checkFileMagic en
// server/app.js acepta jpeg/png/gif/webp) y se sirve bien por el proxy
// autenticado, pero no se puede incrustar en ninguno de los dos exports —
// se omite esa imagen puntual sin tronar el resto del documento, mismo
// criterio que un error de lectura del blob.
function extensionDeImagen(nombreArchivo, contentType) {
  const porNombre = String(nombreArchivo || '').toLowerCase().match(/\.(jpe?g|png|gif|webp)$/)?.[1];
  const norm = porNombre === 'jpg' ? 'jpeg' : porNombre;
  if (norm) return norm;
  const mapa = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
  return mapa[contentType] || null;
}

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F5' } };
const TOTAL_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };

const XLSX_COLS = [
  { key: 'descripcion', header: 'Descripción', width: 34 },
  { key: 'tramo', header: 'Tramo', width: 20 },
  { key: 'largo', header: 'Largo', width: 10 },
  { key: 'ancho', header: 'Ancho', width: 10 },
  { key: 'alto', header: 'Alto', width: 10 },
  { key: 'pzas', header: 'Pzas', width: 10 },
  { key: 'subtotal', header: 'Subtotal', width: 16 },
];
const XLSX_LAST_COL = 'G';

// data: { project: {nombre}, generador: {folio, nombre, periodo_inicio,
// periodo_fin, estado}, grupos: [{partida, subpartida, renglones, fotos,
// subtotal}] } — grupos ya trae en cada foto `.buffer` (Buffer o null si no
// se pudo leer) y `.contentType`, poblados por el caller.
async function buildGeneradorObraXlsxBuffer({ project, generador, grupos }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Generador de Obra');
  ws.columns = XLSX_COLS.map((c) => ({ width: c.width }));
  ws.getColumn(7).numFmt = '"$"#,##0.00';

  let row = 1;
  ws.mergeCells(`A${row}:${XLSX_LAST_COL}${row}`);
  ws.getCell(`A${row}`).value = `Generador de Obra — Folio ${generador.folio}`;
  ws.getCell(`A${row}`).font = { bold: true, size: 14 };
  row += 1;

  if (generador.nombre) {
    ws.mergeCells(`A${row}:${XLSX_LAST_COL}${row}`);
    ws.getCell(`A${row}`).value = generador.nombre;
    ws.getCell(`A${row}`).font = { italic: true };
    row += 1;
  }

  ws.mergeCells(`A${row}:${XLSX_LAST_COL}${row}`);
  ws.getCell(`A${row}`).value =
    `Obra: ${project?.nombre || ''}    Periodo: ${generador.periodo_inicio} al ${generador.periodo_fin}    Estado: ${ESTADO_LABELS[generador.estado] || generador.estado}`;
  row += 2;

  let totalGeneral = 0;

  for (const grupo of grupos) {
    ws.mergeCells(`A${row}:${XLSX_LAST_COL}${row}`);
    const headerCell = ws.getCell(`A${row}`);
    headerCell.value = `${grupo.partida} — ${grupo.subpartida}`;
    headerCell.font = { bold: true };
    headerCell.fill = HEADER_FILL;
    row += 1;

    if (grupo.renglones.length) {
      const headRow = ws.getRow(row);
      XLSX_COLS.forEach((c, idx) => { headRow.getCell(idx + 1).value = c.header; });
      headRow.font = { bold: true };
      row += 1;

      for (const r of grupo.renglones) {
        const excelRow = ws.getRow(row);
        excelRow.getCell(1).value = r.descripcion || '';
        excelRow.getCell(2).value = r.tramo || '';
        excelRow.getCell(3).value = r.largo != null ? Number(r.largo) : null;
        excelRow.getCell(4).value = r.ancho != null ? Number(r.ancho) : null;
        excelRow.getCell(5).value = r.alto != null ? Number(r.alto) : null;
        excelRow.getCell(6).value = r.pzas != null ? Number(r.pzas) : null;
        excelRow.getCell(7).value = Number(r.subtotal || 0);
        row += 1;
      }

      ws.mergeCells(`A${row}:F${row}`);
      const totalLabelCell = ws.getCell(`A${row}`);
      totalLabelCell.value = 'Total subpartida';
      totalLabelCell.font = { bold: true };
      totalLabelCell.fill = TOTAL_FILL;
      const totalValueCell = ws.getCell(`G${row}`);
      totalValueCell.value = grupo.subtotal;
      totalValueCell.font = { bold: true };
      totalValueCell.fill = TOTAL_FILL;
      row += 2;
      totalGeneral += grupo.subtotal;
    } else {
      row += 1;
    }

    // Evidencia fotográfica — una imagen incrustada por fila-bloque (posición
    // absoluta ancla en la esquina superior izquierda del bloque, ver
    // ExcelJS addImage con tl/ext). Cada imagen fallida (buffer null o
    // extensión no soportada) se omite sin afectar a las demás.
    const fotosEmbebibles = (grupo.fotos || []).filter((f) => f.buffer && ['jpeg', 'png', 'gif'].includes(extensionDeImagen(f.nombre_archivo, f.contentType)));
    if (fotosEmbebibles.length) {
      ws.getCell(`A${row}`).value = 'Evidencia fotográfica:';
      ws.getCell(`A${row}`).font = { italic: true };
      row += 1;
      for (const foto of fotosEmbebibles) {
        try {
          const extension = extensionDeImagen(foto.nombre_archivo, foto.contentType);
          const imageId = wb.addImage({ buffer: foto.buffer, extension });
          ws.addImage(imageId, { tl: { col: 0, row: row - 1 }, ext: { width: 220, height: 160 } });
          row += 9; // reserva de filas aprox. equivalente a la altura de la imagen
        } catch (err) {
          // No debe tronar el export completo por una imagen puntual corrupta.
        }
      }
      row += 1;
    } else if ((grupo.fotos || []).length) {
      ws.getCell(`A${row}`).value = 'Evidencia fotográfica no disponible para incrustar (formato no soportado o error de lectura).';
      ws.getCell(`A${row}`).font = { italic: true, color: { argb: 'FF997A00' } };
      row += 2;
    }

    row += 1;
  }

  ws.mergeCells(`A${row}:F${row}`);
  const totalGeneralLabel = ws.getCell(`A${row}`);
  totalGeneralLabel.value = 'TOTAL GENERAL';
  totalGeneralLabel.font = { bold: true, size: 12 };
  totalGeneralLabel.fill = HEADER_FILL;
  const totalGeneralValue = ws.getCell(`G${row}`);
  totalGeneralValue.value = totalGeneral;
  totalGeneralValue.font = { bold: true, size: 12 };
  totalGeneralValue.fill = HEADER_FILL;

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// ---------------------------------------------------------------------------
// PDF — mismo estilo de casa que server/corteObraPdf.js / server/
// estimacionesPdf.js: Helvetica, tabla con columnas de ancho fijo,
// doc.moveTo/lineTo/stroke para separadores, paginación manual verificando
// y + height > PAGE_BOTTOM antes de dibujar cada fila.
const PDF_COLS = [
  { key: 'descripcion', label: 'Descripción', width: 200, align: 'left' },
  { key: 'tramo', label: 'Tramo', width: 110, align: 'left' },
  { key: 'largo', label: 'Largo', width: 60, align: 'right' },
  { key: 'ancho', label: 'Ancho', width: 60, align: 'right' },
  { key: 'alto', label: 'Alto', width: 60, align: 'right' },
  { key: 'pzas', label: 'Pzas', width: 60, align: 'right' },
  { key: 'subtotal', label: 'Subtotal', width: 90, align: 'right' },
];
const TABLE_LEFT = 40;
const PAGE_BOTTOM = 540;
const ROW_PADDING = 6;
const TABLE_WIDTH = PDF_COLS.reduce((s, c) => s + c.width, 0);

const money = (n) => `$${Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`;
const num = (n) => (n == null ? '—' : Number(n).toLocaleString('es-MX', { maximumFractionDigits: 2 }));

function drawTableHeader(doc, y) {
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#000000');
  let x = TABLE_LEFT;
  PDF_COLS.forEach((c) => { doc.text(c.label, x, y, { width: c.width, align: c.align }); x += c.width; });
  doc.moveTo(TABLE_LEFT, y + 14).lineTo(TABLE_LEFT + TABLE_WIDTH, y + 14).strokeColor('#999999').stroke();
  return y + 20;
}

function rowValues(r) {
  return {
    descripcion: r.descripcion || '',
    tramo: r.tramo || '',
    largo: num(r.largo),
    ancho: num(r.ancho),
    alto: num(r.alto),
    pzas: num(r.pzas),
    subtotal: money(r.subtotal),
  };
}

function rowHeight(doc, values) {
  doc.font('Helvetica').fontSize(9);
  let maxH = 0;
  for (const c of PDF_COLS) {
    const h = doc.heightOfString(values[c.key], { width: c.width });
    if (h > maxH) maxH = h;
  }
  return maxH + ROW_PADDING;
}

function drawRow(doc, y, values, height) {
  doc.font('Helvetica').fontSize(9).fillColor('#000000');
  let x = TABLE_LEFT;
  PDF_COLS.forEach((c) => { doc.text(values[c.key], x, y, { width: c.width, align: c.align }); x += c.width; });
  return y + height;
}

// data: { project: {nombre}, generador: {folio, nombre, periodo_inicio,
// periodo_fin, estado}, grupos: [...] } — mismo shape que el builder de xlsx.
function buildGeneradorObraPdfBuffer({ project, generador, grupos }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'letter', layout: 'landscape', margin: 40 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font('Helvetica-Bold').fontSize(16).text('Generador de Obra', { align: 'center' });
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(10);
    doc.text(`Obra: ${project?.nombre || ''}`);
    doc.text(`Folio: ${generador.folio}${generador.nombre ? `    Croquis: ${generador.nombre}` : ''}`);
    doc.text(`Periodo: ${generador.periodo_inicio} al ${generador.periodo_fin}    Estado: ${ESTADO_LABELS[generador.estado] || generador.estado}`);
    doc.text(`Generado: ${new Date().toLocaleString('es-MX')}`);
    doc.fillColor('#000000');

    let y = doc.y + 14;
    let totalGeneral = 0;

    for (const grupo of grupos) {
      if (y > PAGE_BOTTOM - 100) { doc.addPage(); y = 40; }
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#000000').text(`${grupo.partida} — ${grupo.subpartida}`, TABLE_LEFT, y, { width: TABLE_WIDTH });
      y = doc.y + 6;

      const fotosEmbebibles = (grupo.fotos || []).filter((f) => f.buffer && ['jpeg', 'png'].includes(extensionDeImagen(f.nombre_archivo, f.contentType)));
      if (fotosEmbebibles.length) {
        const imgW = 150;
        const imgH = 110;
        const gap = 10;
        let x = TABLE_LEFT;
        let filaMaxY = y;
        for (const foto of fotosEmbebibles) {
          if (x + imgW > TABLE_LEFT + TABLE_WIDTH) { x = TABLE_LEFT; y = filaMaxY + gap; }
          if (y + imgH > PAGE_BOTTOM) { doc.addPage(); y = 40; x = TABLE_LEFT; filaMaxY = y; }
          try {
            doc.image(foto.buffer, x, y, { fit: [imgW, imgH] });
          } catch (err) {
            // Foto puntual corrupta/no legible — se omite, el resto del PDF continúa.
          }
          x += imgW + gap;
          filaMaxY = Math.max(filaMaxY, y + imgH);
        }
        y = filaMaxY + gap + 4;
      } else if ((grupo.fotos || []).length) {
        doc.font('Helvetica-Oblique').fontSize(8).fillColor('#997a00')
          .text('Evidencia fotográfica no disponible para incrustar (formato no soportado o error de lectura).', TABLE_LEFT, y, { width: TABLE_WIDTH });
        y = doc.y + 6;
        doc.fillColor('#000000');
      }

      if (grupo.renglones.length) {
        y = drawTableHeader(doc, y);
        for (const r of grupo.renglones) {
          const values = rowValues(r);
          const height = rowHeight(doc, values);
          if (y + height > PAGE_BOTTOM) {
            doc.addPage();
            y = drawTableHeader(doc, 40);
          }
          y = drawRow(doc, y, values, height);
        }
        doc.moveTo(TABLE_LEFT, y).lineTo(TABLE_LEFT + TABLE_WIDTH, y).strokeColor('#999999').stroke();
        y += 6;
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000')
          .text(`Total subpartida: ${money(grupo.subtotal)}`, TABLE_LEFT, y, { width: TABLE_WIDTH, align: 'right' });
        y = doc.y + 20;
        totalGeneral += grupo.subtotal;
      } else {
        y += 10;
      }
    }

    if (y > PAGE_BOTTOM - 40) { doc.addPage(); y = 40; }
    doc.moveTo(TABLE_LEFT, y).lineTo(TABLE_LEFT + TABLE_WIDTH, y).strokeColor('#000000').stroke();
    y += 10;
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#000000')
      .text(`TOTAL GENERAL: ${money(totalGeneral)}`, TABLE_LEFT, y, { width: TABLE_WIDTH, align: 'right' });

    doc.end();
  });
}

module.exports = {
  partidaSubpartidaDeConcepto,
  agruparGeneradorObra,
  extensionDeImagen,
  buildGeneradorObraXlsxBuffer,
  buildGeneradorObraPdfBuffer,
};
