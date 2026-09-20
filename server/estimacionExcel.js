'use strict';

const path = require('path');
const ExcelJS = require('exceljs');

// Fase 4a (prompt-generadores-de-obra.md) — export de la hoja "EST. 1" a
// partir de la plantilla real adjunta (byte-idéntica, confirmado con Paul en
// Fase 0), cargada con ExcelJS para preservar estilos/merges. A diferencia
// del original (que trae fórmulas vivas cruzadas hacia "CROQUIS EST1" y
// rangos SUM fijos), aquí se escriben VALORES ya calculados en Node —
// decisión explícita de Paul: mucho menos riesgo que reconstruir fórmulas
// cruzadas apuntando a coordenadas que cambian según cuántas partidas/
// conceptos tenga cada obra real. Fase 4b (CROQUIS + REP. FOT., bloques de
// alto variable por subpartida) va en un PR aparte.
const TEMPLATE_PATH = path.join(__dirname, 'templates', 'est-generador-plantilla.xlsx');
const SHEET_NAME = 'EST. 1';

// Capacidad de la tabla de conceptos en la plantilla tal cual viene: filas
// 20 a 52 (33 filas, partidas+conceptos intercalados) antes del bloque fijo
// de totales/firmas (fila 53 en adelante). Los datos reales más grandes
// vistos en la app (12 conceptos) caben sin problema; si una obra futura
// necesita más, esto debe crecer a insertar filas y desplazar el bloque de
// totales — fuera de alcance de esta primera versión (ver checkpoint).
const TABLE_START_ROW = 20;
const TABLE_END_ROW = 52;
const TOTALS_ROW = 53;

const PARTIDA_ROW_STYLE_SOURCE = 20; // fila de encabezado de partida en la plantilla (B20/C20)
const CONCEPTO_ROW_STYLE_SOURCE = 22; // fila de concepto con datos reales en la plantilla

const COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R'];

const num = (n) => Number(n || 0);

// Mismo criterio que partidaSubpartidaDeConcepto() en public/app.js
// (ver server/db.js, comentario de generador_obra_fotos): partida = penúltimo
// nivel de ruta_jerarquica, o 'General' si no hay jerarquía de 2+ niveles.
function partidaDeConcepto(c) {
  const ruta = Array.isArray(c.ruta_jerarquica) && c.ruta_jerarquica.length ? c.ruta_jerarquica : null;
  return ruta && ruta.length >= 2 ? ruta[ruta.length - 2] : (c.grupo || 'General');
}

function copyRowStyle(ws, targetRow, sourceRowNumber) {
  const src = ws.getRow(sourceRowNumber);
  const dst = ws.getRow(targetRow);
  for (const col of COLS) {
    const s = src.getCell(col);
    const d = dst.getCell(col);
    d.style = JSON.parse(JSON.stringify(s.style));
    d.numFmt = s.numFmt;
  }
  dst.height = src.height;
}

function setCell(ws, address, value) {
  ws.getCell(address).value = value;
}

// Divide una fecha ISO (YYYY-MM-DD) en {mes, dia, anio} — mismo formato de 3
// celdas separadas que usa la plantilla para "FECHA DE INICIO"/"FECHA DE
// TERMINACION" (ver E11:G11 / E14:G14 en la plantilla real). mes/dia van
// como texto con cero a la izquierda ("07", no 7) porque esas celdas ya
// traen numFmt="@" (texto) en la plantilla — un número ahí perdería el cero.
function splitFechaISO(iso) {
  if (!iso) return { mes: null, dia: null, anio: null };
  const s = String(iso).slice(0, 10);
  const [anio, mes, dia] = s.split('-');
  if (!anio || !mes || !dia) return { mes: null, dia: null, anio: null };
  return { mes, dia, anio };
}

function toDateOnly(iso) {
  if (!iso) return null;
  const s = String(iso).slice(0, 10);
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Construye el Excel de "EST. 1" para una Estimación real.
 * @param {object} p
 * @param {{id:number,nombre:string}} p.project
 * @param {object} p.meta - meta.clave->valor de la obra (contratista_nombre, contratista_rfc, obra_descripcion, proyecto_desarrollo, inicio_obra, fin_obra, anticipo_monto, tipo_contrato, obra_numero, ...)
 * @param {object} p.estimacion - fila de estimaciones (folio, periodo_inicio, periodo_fin, total_periodo, total_acumulado, amortizacion_anticipo, fondo_garantia_monto, iva_monto, total_a_pagar, fecha_aprobacion, fecha_captura)
 * @param {Array} p.items - estimacion_conceptos JOIN conceptos (codigo, concepto, unidad, cantidad, precio_unitario, importe, ruta_jerarquica, grupo, cantidad_periodo, importe_periodo, cantidad_acumulada, importe_acumulado)
 * @param {number} p.presupuestoTotal - presupuestoTotalDe(project.id), suma de conceptos.importe activos
 * @param {number} p.aditivasDeductivas - suma de ordenes_cambio.monto_delta aprobadas
 * @param {number} p.amortizacionAnteriorAcumulada - suma de amortizacion_anticipo de estimaciones aprobadas ANTES de esta
 * @param {number} p.fondoGarantiaAnteriorAcumulado - suma de fondo_garantia_monto de estimaciones aprobadas ANTES de esta
 * @returns {Promise<Buffer>}
 */
async function buildEstimacionExcel({
  project, meta, estimacion, items, presupuestoTotal,
  aditivasDeductivas, amortizacionAnteriorAcumulada, fondoGarantiaAnteriorAcumulado,
}) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE_PATH);
  const ws = wb.getWorksheet(SHEET_NAME);
  if (!ws) throw new Error(`La plantilla no tiene una hoja "${SHEET_NAME}"`);

  // ---- Encabezado: obra / estimación ----
  setCell(ws, 'F2', project.nombre);
  setCell(ws, 'G4', project.nombre);
  setCell(ws, 'O4', toDateOnly(estimacion.fecha_aprobacion) || toDateOnly(estimacion.fecha_captura) || new Date());
  setCell(ws, 'Q4', estimacion.folio);

  // ---- DATOS DEL CONTRATISTA ----
  setCell(ws, 'C9', meta.contratista_nombre || '');
  setCell(ws, 'D10', meta.contratista_rfc || '');

  // ---- DATOS DEL CONTRATO ----
  const inicio = splitFechaISO(meta.inicio_obra);
  const fin = splitFechaISO(meta.fin_obra);
  setCell(ws, 'E11', inicio.mes);
  setCell(ws, 'F11', inicio.dia);
  setCell(ws, 'G11', inicio.anio);
  setCell(ws, 'E14', fin.mes);
  setCell(ws, 'F14', fin.dia);
  setCell(ws, 'G14', fin.anio);
  setCell(ws, 'H15', toDateOnly(estimacion.periodo_inicio));
  setCell(ws, 'I15', toDateOnly(estimacion.periodo_fin));
  setCell(ws, 'C14', meta.proyecto_desarrollo || '');
  setCell(ws, 'C15', meta.obra_descripcion || '');
  setCell(ws, 'E15', meta.obra_descripcion || '');
  setCell(ws, 'E16', meta.tipo_contrato || '');
  setCell(ws, 'C17', meta.obra_numero || '');

  // ---- INFORMACION GENERAL (importes) ----
  const importeContractualModificado = presupuestoTotal + aditivasDeductivas;
  const importePorEstimar = importeContractualModificado - num(estimacion.total_acumulado);
  setCell(ws, 'L10', presupuestoTotal);
  setCell(ws, 'M10', presupuestoTotal * 1.16);
  setCell(ws, 'L11', estimacion.total_acumulado);
  setCell(ws, 'M11', num(estimacion.total_acumulado) * 1.16);
  setCell(ws, 'L12', aditivasDeductivas);
  setCell(ws, 'M12', aditivasDeductivas * 1.16);
  setCell(ws, 'L13', importeContractualModificado);
  setCell(ws, 'M13', importeContractualModificado * 1.16);
  setCell(ws, 'L14', importePorEstimar);
  setCell(ws, 'M14', importePorEstimar * 1.16);

  // ---- Anticipo / amortización ----
  const anticipoOtorgado = num(meta.anticipo_monto);
  const totalAmortizado = amortizacionAnteriorAcumulada + num(estimacion.amortizacion_anticipo);
  setCell(ws, 'Q9', anticipoOtorgado);
  setCell(ws, 'Q11', amortizacionAnteriorAcumulada);
  setCell(ws, 'Q12', estimacion.amortizacion_anticipo);
  setCell(ws, 'Q14', totalAmortizado);
  setCell(ws, 'Q15', anticipoOtorgado - totalAmortizado);

  // ---- Tabla de conceptos (partidas + conceptos intercalados) ----
  let row = TABLE_START_ROW;
  let currentPartida = null;
  let partidaIdx = 0;
  let sumImportePresupuesto = 0;
  let sumImporteHastaAnterior = 0;
  let sumImporteEstimadoFecha = 0;
  let sumImportePorEjecutar = 0;

  for (const it of items) {
    const partida = partidaDeConcepto(it);
    if (partida !== currentPartida) {
      if (row > TABLE_END_ROW) {
        throw new Error(`La tabla de conceptos excede la capacidad de la plantilla (${TABLE_END_ROW - TABLE_START_ROW + 1} filas) — obra con demasiadas partidas/conceptos para esta primera versión del export.`);
      }
      currentPartida = partida;
      partidaIdx += 1;
      copyRowStyle(ws, row, PARTIDA_ROW_STYLE_SOURCE);
      setCell(ws, `B${row}`, partidaIdx);
      setCell(ws, `C${row}`, partida);
      row += 1;
    }
    if (row > TABLE_END_ROW) {
      throw new Error(`La tabla de conceptos excede la capacidad de la plantilla (${TABLE_END_ROW - TABLE_START_ROW + 1} filas) — obra con demasiadas partidas/conceptos para esta primera versión del export.`);
    }

    const cantidadHastaAnterior = num(it.cantidad_acumulada) - num(it.cantidad_periodo);
    const importeHastaAnterior = num(it.importe_acumulado) - num(it.importe_periodo);
    const importePresupuesto = num(it.importe);

    copyRowStyle(ws, row, CONCEPTO_ROW_STYLE_SOURCE);
    setCell(ws, `B${row}`, it.codigo || '');
    setCell(ws, `C${row}`, it.concepto || '');
    setCell(ws, `G${row}`, num(it.cantidad));
    setCell(ws, `H${row}`, num(it.precio_unitario));
    setCell(ws, `I${row}`, importePresupuesto);
    setCell(ws, `J${row}`, cantidadHastaAnterior);
    setCell(ws, `K${row}`, importeHastaAnterior);
    setCell(ws, `L${row}`, num(it.cantidad_periodo));
    setCell(ws, `M${row}`, num(it.importe_periodo));
    setCell(ws, `N${row}`, num(it.importe_periodo));
    setCell(ws, `O${row}`, num(it.cantidad_acumulada));
    setCell(ws, `P${row}`, num(it.importe_acumulado));
    setCell(ws, `Q${row}`, num(it.cantidad) - num(it.cantidad_acumulada));
    setCell(ws, `R${row}`, importePresupuesto - num(it.importe_acumulado));

    sumImportePresupuesto += importePresupuesto;
    sumImporteHastaAnterior += importeHastaAnterior;
    sumImporteEstimadoFecha += num(it.importe_acumulado);
    sumImportePorEjecutar += importePresupuesto - num(it.importe_acumulado);
    row += 1;
  }

  // Filas sobrantes de la plantilla (hasta TABLE_END_ROW) se dejan en blanco
  // (conservan el formato/bordes ya presentes, solo se limpia el valor).
  for (let r = row; r <= TABLE_END_ROW; r++) {
    for (const col of COLS) ws.getCell(`${col}${r}`).value = null;
  }

  // ---- Totales ----
  setCell(ws, `I${TOTALS_ROW}`, sumImportePresupuesto);
  setCell(ws, `K${TOTALS_ROW}`, sumImporteHastaAnterior);
  setCell(ws, `M${TOTALS_ROW}`, estimacion.total_periodo);
  setCell(ws, `N${TOTALS_ROW}`, estimacion.total_periodo);
  setCell(ws, `P${TOTALS_ROW}`, sumImporteEstimadoFecha);
  setCell(ws, `R${TOTALS_ROW}`, sumImportePorEjecutar);

  // ---- Desglose de pago (filas 55-61) ----
  const subtotal = num(estimacion.total_periodo);
  const subtotalMenosAmortizacion = subtotal - num(estimacion.amortizacion_anticipo);
  setCell(ws, 'M55', subtotal);
  setCell(ws, 'N55', subtotal);
  setCell(ws, 'M56', estimacion.amortizacion_anticipo);
  setCell(ws, 'N56', estimacion.amortizacion_anticipo);
  setCell(ws, 'M57', subtotalMenosAmortizacion);
  setCell(ws, 'N57', subtotalMenosAmortizacion);
  setCell(ws, 'M58', estimacion.iva_monto);
  setCell(ws, 'N58', estimacion.iva_monto);
  setCell(ws, 'M59', subtotalMenosAmortizacion + num(estimacion.iva_monto));
  setCell(ws, 'N59', subtotalMenosAmortizacion + num(estimacion.iva_monto));
  setCell(ws, 'M60', estimacion.fondo_garantia_monto);
  setCell(ws, 'N60', estimacion.fondo_garantia_monto);
  setCell(ws, 'M61', estimacion.total_a_pagar);
  setCell(ws, 'N61', estimacion.total_a_pagar);

  // Fondo de garantía retenido (acumulado histórico, columna O/R filas 56-58)
  const fondoRetenidoTotal = fondoGarantiaAnteriorAcumulado + num(estimacion.fondo_garantia_monto);
  setCell(ws, 'R56', fondoGarantiaAnteriorAcumulado);
  setCell(ws, 'R57', estimacion.fondo_garantia_monto);
  setCell(ws, 'R58', fondoRetenidoTotal);

  // ---- Firma "CONTRATISTA" (única con dato real disponible; el resto de
  // firmas — Jefe de Urbanización/Control de Costos/Gerente Técnico — no
  // tienen fuente de datos en el sistema hoy, se dejan en blanco a propósito
  // en vez de inventar un nombre). ----
  setCell(ws, 'B67', meta.contratista_nombre || '');

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

module.exports = { buildEstimacionExcel };
