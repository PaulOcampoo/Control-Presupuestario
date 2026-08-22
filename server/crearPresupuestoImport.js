'use strict';

// prompt-fase1-3-export-import-4-hojas.md: parser dedicado para el archivo
// de 4 hojas que genera POST /api/costos/crear-presupuesto/export (Hoja 1
// "Presupuesto", Hoja 2 "Destajo", Hoja 3 "Insumos", Hoja 4 "Matrices").
// Deliberadamente NO reusa parseWorkbook (server/parser.js) -- ese parser
// resuelve heurísticas de archivos de obra reales y desordenados (sinónimos
// de encabezado, secciones, totales); acá el formato es fijo y lo genera
// nuestro propio export, así que un lector por nombre exacto de columna es
// más simple y más seguro que forzar un parser pensado para otro problema.
// Tampoco reusa el importador de Matrices Neodata (public/app.js:15306) ni
// el de Mapeo -- ninguno de los dos soporta crear conceptos/insumos nuevos,
// que es exactamente lo que este flujo necesita (Forbidden Action, y
// confirmado en Fase 0 que el de Matrices rechaza ese caso explícitamente).

const ExcelJS = require('exceljs');

function normHeader(v) {
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

function cellNum(cell) {
  const v = cellValue(cell);
  if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// Lee una hoja como arreglo de objetos, mapeando por nombre exacto de
// encabezado (fila 1) contra el mapa {clave: 'TEXTO ENCABEZADO'} recibido.
// Devuelve [] (no lanza) si la hoja no existe -- cada hoja 2-4 es opcional
// (una obra puede legítimamente no tener destajo/insumos/matrices).
function leerHojaPorEncabezados(workbook, nombreHoja, mapaEncabezados) {
  const sheet = workbook.getWorksheet(nombreHoja);
  if (!sheet) return null;
  const headerRow = sheet.getRow(1);
  const indicePorClave = {};
  Object.entries(mapaEncabezados).forEach(([clave, encabezado]) => {
    const objetivo = normHeader(encabezado);
    for (let c = 1; c <= headerRow.cellCount; c++) {
      if (normHeader(cellText(headerRow.getCell(c))) === objetivo) { indicePorClave[clave] = c; break; }
    }
  });
  const filas = [];
  sheet.eachRow((row, num) => {
    if (num === 1) return;
    const obj = {};
    for (const clave of Object.keys(mapaEncabezados)) {
      const idx = indicePorClave[clave];
      obj[clave] = idx ? row.getCell(idx) : null;
    }
    // Fila completamente vacía (Excel a veces deja filas fantasma al final) — se ignora.
    if (Object.values(obj).every((c) => !c || cellText(c) === '')) return;
    filas.push(obj);
  });
  return filas;
}

const ENCABEZADOS_PRESUPUESTO = {
  codigo: 'Código', concepto: 'Concepto', unidad: 'Unidad', cantidad: 'Cantidad', precio_unitario: 'Precio Unitario',
};
const ENCABEZADOS_DESTAJO = {
  codigo: 'Código', unidad: 'Unidad', precio_destajo_maximo: 'Precio Destajo Máximo', destajista_nombre: 'Destajista (obra de origen)',
};
const ENCABEZADOS_INSUMOS = {
  codigo_insumo: 'Código Insumo', descripcion: 'Descripción', categoria: 'Categoría', unidad: 'Unidad',
  precio_presupuesto: 'Precio Presupuesto', iva_tasa: 'IVA Tasa', codigo_concepto: 'Código Concepto',
};
const ENCABEZADOS_MATRICES = {
  codigo_concepto: 'Código Concepto', partida: 'Partida', rendimiento: 'Rendimiento',
  pct_indirecto: '% Indirecto', pct_utilidad: '% Utilidad', pct_financiamiento: '% Financiamiento',
  analisis_no: 'Análisis No.', cuadrilla_nombre: 'Cuadrilla',
  categoria_renglon: 'Categoría (renglón)', tipo_renglon: 'Tipo (renglón)',
  codigo_insumo_renglon: 'Código Insumo (renglón)', descripcion_renglon: 'Descripción (renglón)',
  cantidad_renglon: 'Cantidad (renglón)', factor_referencia_renglon: 'Factor Referencia (renglón)',
};

// Parsea el archivo completo y devuelve estructuras listas para validar/
// insertar. NUNCA escribe en base de datos -- lectura pura. Se llama fresco
// tanto en preview como en confirm (confirm nunca confía en lo que mandó el
// preview, mismo criterio que "Actualizar presupuesto"/Matrices Neodata).
async function parseArchivo4Hojas(tmpPath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(tmpPath);

  const filasPresupuesto = leerHojaPorEncabezados(wb, 'Presupuesto', ENCABEZADOS_PRESUPUESTO);
  if (!filasPresupuesto || !filasPresupuesto.length) {
    throw new Error('El archivo no tiene una hoja "Presupuesto" con al menos 1 concepto.');
  }

  const conceptos = filasPresupuesto.map((f, idx) => {
    const codigo = cellText(f.codigo);
    const concepto = cellText(f.concepto);
    if (!codigo || !concepto) throw new Error(`Fila ${idx + 2} de "Presupuesto": falta código o concepto.`);
    const cantidad = cellNum(f.cantidad);
    const precio_unitario = cellNum(f.precio_unitario);
    return { codigo, concepto, unidad: cellText(f.unidad) || null, cantidad, precio_unitario, importe: cantidad * precio_unitario, orden: idx + 1 };
  });
  const codigosPresupuesto = new Set(conceptos.map((c) => c.codigo));

  const filasDestajo = leerHojaPorEncabezados(wb, 'Destajo', ENCABEZADOS_DESTAJO) || [];
  const destajo = filasDestajo.map((f) => ({
    codigo: cellText(f.codigo), unidad: cellText(f.unidad) || null,
    precio_destajo_maximo: cellNum(f.precio_destajo_maximo), destajista_nombre: cellText(f.destajista_nombre) || null,
  })).filter((d) => d.codigo);

  const filasInsumos = leerHojaPorEncabezados(wb, 'Insumos', ENCABEZADOS_INSUMOS) || [];
  const insumos = filasInsumos.map((f) => ({
    codigo_insumo: cellText(f.codigo_insumo), descripcion: cellText(f.descripcion), categoria: cellText(f.categoria) || null,
    unidad: cellText(f.unidad) || null, precio_presupuesto: cellNum(f.precio_presupuesto),
    iva_tasa: cellNum(f.iva_tasa) || 16, codigo_concepto: cellText(f.codigo_concepto),
  })).filter((i) => i.codigo_insumo && i.codigo_concepto);

  const filasMatrices = leerHojaPorEncabezados(wb, 'Matrices', ENCABEZADOS_MATRICES) || [];
  // Agrupa renglones por código de concepto (1 matriz por concepto, cabecera
  // repetida en cada fila del export -- ver construirHojasDestajoInsumosMatrices).
  const matricesPorConcepto = new Map();
  for (const f of filasMatrices) {
    const codigoConcepto = cellText(f.codigo_concepto);
    if (!codigoConcepto) continue;
    if (!matricesPorConcepto.has(codigoConcepto)) {
      matricesPorConcepto.set(codigoConcepto, {
        codigo_concepto: codigoConcepto, partida: cellText(f.partida) || null,
        rendimiento: f.rendimiento && cellText(f.rendimiento) !== '' ? cellNum(f.rendimiento) : null,
        pct_indirecto: cellNum(f.pct_indirecto), pct_utilidad: cellNum(f.pct_utilidad), pct_financiamiento: cellNum(f.pct_financiamiento),
        analisis_no: cellText(f.analisis_no) || null, cuadrilla_nombre: cellText(f.cuadrilla_nombre) || null,
        renglones: [],
      });
    }
    const codigoInsumoRenglon = cellText(f.codigo_insumo_renglon);
    const tipoRenglon = cellText(f.tipo_renglon);
    if (tipoRenglon) {
      matricesPorConcepto.get(codigoConcepto).renglones.push({
        categoria: cellText(f.categoria_renglon) || null, tipo: tipoRenglon,
        codigo_insumo: codigoInsumoRenglon || null, descripcion: cellText(f.descripcion_renglon) || null,
        cantidad: cellNum(f.cantidad_renglon), factor_referencia: cellText(f.factor_referencia_renglon) || null,
      });
    }
  }

  // Validación cruzada (Forbidden/Stop Condition explícita del prompt): todo
  // código referenciado en Hojas 2-4 debe existir en Hoja 1 -- si no, el
  // archivo fue editado a mano de forma inconsistente, se rechaza entero,
  // nunca se crea parcialmente.
  const codigosInvalidos = [];
  for (const d of destajo) if (!codigosPresupuesto.has(d.codigo)) codigosInvalidos.push(`Destajo: código "${d.codigo}" no existe en la hoja Presupuesto.`);
  for (const i of insumos) if (!codigosPresupuesto.has(i.codigo_concepto)) codigosInvalidos.push(`Insumos: código de concepto "${i.codigo_concepto}" no existe en la hoja Presupuesto.`);
  for (const codigoConcepto of matricesPorConcepto.keys()) if (!codigosPresupuesto.has(codigoConcepto)) codigosInvalidos.push(`Matrices: código de concepto "${codigoConcepto}" no existe en la hoja Presupuesto.`);
  if (codigosInvalidos.length) {
    const err = new Error(`Archivo inconsistente — hay códigos en Hojas 2-4 que no existen en la Hoja "Presupuesto" (¿se editó a mano?): ${codigosInvalidos.slice(0, 5).join(' ')}${codigosInvalidos.length > 5 ? ` (+${codigosInvalidos.length - 5} más)` : ''}`);
    err.status = 400;
    throw err;
  }

  return { conceptos, destajo, insumos, matrices: [...matricesPorConcepto.values()] };
}

function resumenParaPreview(parsed) {
  const totalRenglones = parsed.matrices.reduce((s, m) => s + m.renglones.length, 0);
  return {
    num_conceptos: parsed.conceptos.length,
    num_destajos: parsed.destajo.length,
    num_insumos: parsed.insumos.length,
    num_matrices: parsed.matrices.length,
    num_renglones_matrices: totalRenglones,
    destajistas_distintos: [...new Set(parsed.destajo.map((d) => d.destajista_nombre).filter(Boolean))],
    total_sin_iva: Number(parsed.conceptos.reduce((s, c) => s + c.importe, 0).toFixed(2)),
  };
}

module.exports = { parseArchivo4Hojas, resumenParaPreview };
