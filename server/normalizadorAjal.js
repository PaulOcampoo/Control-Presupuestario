'use strict';

// prompt-normalizador-universal-ajal.md: normaliza el formato real "AJAL" de
// exportación de presupuestos (letterhead + metadata corporativa en las
// primeras ~15 filas, header de columnas variable alrededor de la fila 16,
// nombres de columna con sinónimos, filas jerárquicas de categoría/total
// mezcladas con partidas reales) al mismo shape que ya produce
// parseArchivo4Hojas (server/crearPresupuestoImport.js) para el formato
// estándar. Deliberadamente separado de ese archivo (Forbidden Action
// explícita del prompt: no modificar el parser estándar) — este módulo es
// SOLO el fallback para cuando parseArchivo4Hojas ya falló.
//
// ALCANCE DE ESTA PRIMERA FASE: solo la hoja de Presupuesto (Directo AJAL /
// Estimacion AJAL). Diagnóstico contra los 4 archivos reales de muestra
// encontró que Destajo/Insumos/Matrices en formato AJAL tienen problemas
// estructurales bastante más profundos que un sinónimo de columna
// (descripciones partidas en múltiples filas físicas, secciones anidadas
// con subtotales, celdas combinadas, y en el caso de Destajo ninguna columna
// de nombre de destajista) — intentar normalizarlas aquí violaría la regla
// dura de este prompt ("no adivinar mapeos... fallar visible es preferible a
// un import silenciosamente incorrecto"). Quedan fuera de este módulo a
// propósito, para una fase futura con su propio diagnóstico.

const ExcelJS = require('exceljs');

function normalizarTexto(v) {
  return String(v == null ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase();
}

function cellValue(cell) {
  const v = cell?.value;
  if (v == null) return null;
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((p) => p.text).join('');
    if (v.result != null) return v.result;
    if (v.text != null) return v.text;
  }
  return v;
}

function cellText(cell) {
  const v = cellValue(cell);
  return v == null ? '' : String(v).trim();
}

// null (no numérico / vacío) se distingue de 0 (numérico real) a propósito —
// el clasificador categoría-vs-partida depende de esa distinción.
function cellNumOrNull(cell) {
  const t = cellText(cell);
  if (t === '') return null;
  const n = parseFloat(t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Candidatos de nombre de hoja para la tabla de Presupuesto — confirmados
// contra los 4 archivos reales de muestra (C715, EST Kaila Amenidades,
// C671, C686): "Directo AJAL" (con o sin doble espacio) o "Estimacion AJAL"
// para archivos de estimación, nunca "Presupuesto" literal en un archivo
// AJAL real (ese caso ya lo resuelve parseArchivo4Hojas antes de llegar aquí).
const PRESUPUESTO_SHEET_CANDIDATES = ['presupuesto', 'directo ajal', 'estimacion ajal', 'estimación ajal'];

function esHojaPresupuestoAjal(nombreHoja) {
  const norm = normalizarTexto(nombreHoja).replace(/\s+/g, ' ');
  return PRESUPUESTO_SHEET_CANDIDATES.some((c) => normalizarTexto(c).replace(/\s+/g, ' ') === norm);
}

// Sinónimos de columna confirmados contra los 4 archivos reales — "P.
// Unitario" es el texto real que usa el template AJAL, "Precio Unitario" es
// el que espera ENCABEZADOS_PRESUPUESTO del formato estándar.
const SINONIMOS_COLUMNA = {
  codigo: ['CODIGO'],
  concepto: ['CONCEPTO'],
  unidad: ['UNIDAD'],
  cantidad: ['CANTIDAD'],
  precio_unitario: ['PRECIO UNITARIO', 'P. UNITARIO', 'P.UNITARIO', 'P.U.', 'PU'],
};
// codigo, concepto, cantidad y precio_unitario son indispensables para
// calcular importe y para identificar una partida real; unidad es
// informativa (ya es opcional en el formato estándar: ENCABEZADOS_PRESUPUESTO
// la pide pero el resto del pipeline tolera unidad=null).
const CLAVES_REQUERIDAS = ['codigo', 'concepto', 'cantidad', 'precio_unitario'];
const CLAVES_TOTAL = Object.keys(SINONIMOS_COLUMNA);

// Escanea las primeras `maxFilas` filas de la hoja buscando la fila de
// encabezados real (Fase 3 del prompt: "no asumir número de fila fijo").
// Devuelve { fila, indicePorClave } o lanza si no encuentra ninguna fila que
// tenga las 4 claves indispensables, o si hay más de una fila candidata con
// el mismo score máximo (ambigüedad real — Fase 4, "fallar visible").
function localizarFilaHeaderPresupuesto(sheet, maxFilas = 40) {
  const candidatas = [];
  const limite = Math.min(maxFilas, sheet.rowCount || maxFilas);
  for (let r = 1; r <= limite; r++) {
    const row = sheet.getRow(r);
    const indicePorClave = {};
    for (let c = 1; c <= row.cellCount; c++) {
      const texto = normalizarTexto(cellText(row.getCell(c)));
      if (!texto) continue;
      for (const [clave, sinonimos] of Object.entries(SINONIMOS_COLUMNA)) {
        if (indicePorClave[clave]) continue; // ya resuelta por una celda anterior de esta misma fila
        if (sinonimos.includes(texto)) indicePorClave[clave] = c;
      }
    }
    const tieneRequeridas = CLAVES_REQUERIDAS.every((k) => indicePorClave[k]);
    if (!tieneRequeridas) continue;
    const score = CLAVES_TOTAL.filter((k) => indicePorClave[k]).length;
    candidatas.push({ fila: r, score, indicePorClave });
  }

  if (!candidatas.length) {
    const err = new Error(
      `No se encontró una fila de encabezados reconocible en la hoja "${sheet.name}" ` +
      `(se buscó Código, Concepto, Cantidad y Precio Unitario/P. Unitario en las primeras ${limite} filas). ` +
      `El archivo puede tener un formato distinto a los ya conocidos — revisar manualmente antes de reintentar.`
    );
    err.status = 400;
    throw err;
  }

  const maxScore = Math.max(...candidatas.map((c) => c.score));
  const mejores = candidatas.filter((c) => c.score === maxScore);
  if (mejores.length > 1) {
    const err = new Error(
      `Se encontraron ${mejores.length} filas candidatas a encabezado en la hoja "${sheet.name}" ` +
      `con la misma coincidencia de columnas (filas ${mejores.map((c) => c.fila).join(', ')}) — ` +
      `ambigüedad real, no se puede elegir automáticamente sin arriesgar un import incorrecto.`
    );
    err.status = 400;
    throw err;
  }
  return mejores[0];
}

// Clasificador categoría-vs-partida (Fase 1 del prompt, validado empíricamente
// contra los 4 archivos reales: 0 casos ambiguos). Una fila es una PARTIDA
// real solo si cantidad Y precio_unitario son ambos valores numéricos no-nulos
// y distintos de 0 — esto excluye limpiamente, sin caso especial: filas de
// categoría/agrupador (código+concepto sin cantidad/precio, ej. "EPA1"), sus
// filas "TOTAL <categoría>" (traen importe pero no cantidad/precio), y las
// filas de pie del presupuesto (TOTAL DEL PRESUPUESTO, IVA, importe en letra
// — todas sin cantidad/precio tampoco).
function esPartidaReal(cantidad, precioUnitario) {
  return cantidad != null && cantidad !== 0 && precioUnitario != null && precioUnitario !== 0;
}

// Lee la hoja de Presupuesto en formato AJAL y devuelve el mismo shape que
// parseArchivo4Hojas produce para `conceptos` a partir de la hoja
// "Presupuesto" estándar: [{ codigo, concepto, unidad, cantidad,
// precio_unitario, importe, orden }]. importe se calcula igual que el parser
// estándar (cantidad × precio_unitario), no se lee de la columna "Importe"
// del archivo — mismo criterio de una sola fuente de verdad para ese cálculo.
function leerPresupuestoAjal(sheet) {
  const { fila: filaHeader, indicePorClave } = localizarFilaHeaderPresupuesto(sheet);
  const conceptos = [];
  let orden = 0;
  sheet.eachRow((row, num) => {
    if (num <= filaHeader) return;
    const codigo = cellText(row.getCell(indicePorClave.codigo));
    const concepto = cellText(row.getCell(indicePorClave.concepto));
    if (!codigo && !concepto) return; // fila completamente vacía
    const cantidad = cellNumOrNull(row.getCell(indicePorClave.cantidad));
    const precioUnitario = cellNumOrNull(row.getCell(indicePorClave.precio_unitario));
    if (!esPartidaReal(cantidad, precioUnitario)) return; // categoría, total, o pie de página
    if (!codigo || !concepto) return; // partida real siempre trae ambos en los archivos de muestra; si no, se descarta en vez de adivinar
    orden += 1;
    conceptos.push({
      codigo,
      concepto,
      unidad: indicePorClave.unidad ? (cellText(row.getCell(indicePorClave.unidad)) || null) : null,
      cantidad,
      precio_unitario: precioUnitario,
      importe: cantidad * precioUnitario,
      orden,
    });
  });

  if (!conceptos.length) {
    const err = new Error(
      `La hoja "${sheet.name}" tiene un encabezado reconocible (fila ${filaHeader}) pero 0 partidas reales ` +
      `después de filtrar filas de categoría/total — no se puede continuar sin arriesgar un catálogo vacío o incorrecto.`
    );
    err.status = 400;
    throw err;
  }
  return conceptos;
}

// Punto de entrada: recibe el mismo tmpPath que parseArchivo4Hojas, busca la
// hoja de Presupuesto en formato AJAL entre las hojas reales del archivo, y
// devuelve el mismo shape { conceptos, destajo, insumos, matrices } que
// procesarArchivoCatalogo ya sabe consumir. destajo/insumos/matrices quedan
// deliberadamente vacíos en esta fase (ver comentario de alcance arriba).
async function normalizarArchivoAjal(tmpPath, nombresHojaOriginales) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(tmpPath);

  const hojaPresupuesto = wb.worksheets.find((s) => esHojaPresupuestoAjal(s.name));
  if (!hojaPresupuesto) {
    const err = new Error(
      `El archivo no tiene una hoja "Presupuesto" (ni "Directo AJAL"/"Estimacion AJAL") con al menos 1 concepto. ` +
      `Hojas encontradas en el archivo: ${nombresHojaOriginales.map((n) => `"${n}"`).join(', ')}.`
    );
    err.status = 400;
    throw err;
  }

  const conceptos = leerPresupuestoAjal(hojaPresupuesto);
  return { conceptos, destajo: [], insumos: [], matrices: [] };
}

module.exports = {
  normalizarArchivoAjal,
  esHojaPresupuestoAjal,
  localizarFilaHeaderPresupuesto,
  leerPresupuestoAjal,
  esPartidaReal,
};
