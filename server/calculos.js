'use strict';

// Extraído de server/app.js y server/finanzas.js (prompt-cerrar-gaps-mayores)
// para poder testearlas de forma aislada — mismas expresiones exactas que ya
// corrían inline en cada call site, sin cambiar el resultado.

// Nómina: monto de jornal = días con asistencia 'presente' en el periodo ×
// tarifa diaria. El descuento por faltas ya está aplicado antes de llegar
// aquí (diasPresentes solo cuenta días con estado='presente', ver
// COUNT(*) FILTER (WHERE estado=$4) en POST /projects/:id/nominas/:nomId/calcular).
function calcularJornal(diasPresentes, tarifaDiaria) {
  return diasPresentes * Number(tarifaDiaria);
}

// Destajo: importe de una línea = cantidad × precio unitario. Usada tanto
// para cantidad_asignada (total comprometido) como cantidad_ejecutada (total
// ganado) — la misma fórmula, distinta cantidad de entrada.
function calcularDestajo(cantidad, precioUnitario) {
  return Number(cantidad) * Number(precioUnitario);
}

// Erogado Real (Finanzas/Tesorería): pagos.monto y orden_compra_items.precio_unitario
// se capturan con IVA incluido; para comparar contra el presupuesto (que es
// sin IVA) se ajustan a base sin IVA dividiendo entre (1 + tasaIva). Redondeo
// a 2 decimales igual que el resto de montos monetarios de la app.
function montoSinIva(montoConIva, tasaIva) {
  return Number((montoConIva / (1 + tasaIva)).toFixed(2));
}

// prompt-fix-saldo-iva-5-lugares.md: Total REAL con IVA de un conjunto de
// items de Orden de Compra (o cualquier agregado equivalente: por
// categoría, por obra, etc.), respetando incluye_iva de la OC. Misma
// fórmula exacta que computeIvaBreakdown() (server/app.js, sin tocar) —
// vive aquí, no ahí, para que server/finanzas.js también pueda usarla sin
// crear una dependencia circular con app.js (finanzas.js ya es requerido
// por app.js). Un solo lugar de verdad: antes de este fix, 5 sitios
// distintos sumaban `orden_compra_items.importe` crudo asumiendo que ya
// era el total pagable, lo cual solo es cierto cuando incluye_iva=true —
// para incluye_iva=false ese importe es SUBTOTAL, y compararlo contra
// pagos.monto (que siempre incluye IVA, es la transferencia real) producía
// saldos negativos o pendientes subestimados a $0.00 antes de tiempo.
// items: [{ importe, iva_tasa }, ...] — mismo shape que ya usa
// computeIvaBreakdown. Acumula subtotal/iva sin redondear por item y
// redondea una sola vez al final, igual que computeIvaBreakdown, para dar
// exactamente el mismo resultado que esa función en el caso incluye_iva=true
// (que no debe cambiar).
function totalConIvaDeItems(items, incluyeIva) {
  let subtotal = 0;
  let iva = 0;
  for (const it of items) {
    const importe = Number(it.importe) || 0;
    const tasa = Number(it.iva_tasa) / 100;
    if (incluyeIva) {
      const sub = importe / (1 + tasa);
      subtotal += sub;
      iva += importe - sub;
    } else {
      subtotal += importe;
      iva += importe * tasa;
    }
  }
  return Number((subtotal + iva).toFixed(2));
}

// Validación defensiva de "Total sin IVA" vs "Total con IVA" en Datos de la
// Obra (prompt-12-fix-totales-iva-invertidos.md). Ambos valores nacen de
// filas DISTINTAS del Excel origen (server/parser.js extractMeta —
// "TOTAL DEL PRESUPUESTO MOSTRADO SIN IVA" vs "TOTAL DEL PRESUPUESTO
// MOSTRADO"), nunca se derivan uno del otro en código. Diagnóstico con
// datos reales: 5 de 6 obras con ambos valores dan razón exactamente 1.16
// (el Excel los captura bien); solo 1 obra (id=13, "Presupuestos Vinte")
// tiene total_con_iva mal extraído de la celda equivocada al subir ese
// archivo específico — no es un bug de cálculo que "arreglar" con una
// fórmula, es un dato mal capturado en esa obra puntual. Por eso esta
// función NO recalcula ni corrige nada, solo detecta el caso imposible
// (con IVA < sin IVA) para que el caller pueda avisar en vez de mostrarlo
// en silencio — decisión consultada con Paul: no tocar el valor guardado.
function totalConIvaEsValido(totalSinIva, totalConIva) {
  if (totalConIva == null) return true; // sin dato capturado, nada que validar
  return Number(totalConIva) >= Number(totalSinIva);
}

// prompt-20-matrices-formato-neodata.md, CP4/CP5: importe del Precio Unitario
// en letra, formato Neodata — "(* DOSCIENTOS PESOS 65/100 M.N. *)". Español
// mexicano estándar: "CIEN" exacto (no "CIENTO"), "MIL" sin "UN" delante
// (no "UN MIL"), apocope "UN"/"VEINTIUN"/"TREINTA Y UN..." siempre (el
// resultado siempre va seguido de "PESO(S)", nunca standalone, así que la
// forma apocopada aplica en todos los casos, no hace falta distinguir
// "UNO" vs "UN" por contexto).
const NUM_UNIDADES = ['', 'UN', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE'];
const NUM_DIEC = ['DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISEIS', 'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE'];
const NUM_VEINTIS = ['VEINTE', 'VEINTIUN', 'VEINTIDOS', 'VEINTITRES', 'VEINTICUATRO', 'VEINTICINCO', 'VEINTISEIS', 'VEINTISIETE', 'VEINTIOCHO', 'VEINTINUEVE'];
const NUM_DECENAS = ['', '', '', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
const NUM_CENTENAS = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS', 'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS'];

// Convierte un grupo de 0 a 999 a letra. Llamado 1 vez por cada "escalón"
// (unidades, miles, millones) del número completo.
function convertirGrupoNumerico(n) {
  if (n === 0) return '';
  if (n === 100) return 'CIEN';
  const centena = Math.floor(n / 100);
  const resto = n % 100;
  let out = centena > 0 ? NUM_CENTENAS[centena] : '';
  if (resto > 0) {
    if (out) out += ' ';
    if (resto < 10) out += NUM_UNIDADES[resto];
    else if (resto < 20) out += NUM_DIEC[resto - 10];
    else if (resto < 30) out += NUM_VEINTIS[resto - 20];
    else {
      const decena = Math.floor(resto / 10);
      const unidad = resto % 10;
      out += NUM_DECENAS[decena] + (unidad > 0 ? ' Y ' + NUM_UNIDADES[unidad] : '');
    }
  }
  return out;
}

function numeroALetra(monto) {
  const centavosTotales = Math.round(Math.abs(Number(monto) || 0) * 100);
  const enteros = Math.floor(centavosTotales / 100);
  const centavos = centavosTotales % 100;

  let palabras;
  if (enteros === 0) {
    palabras = 'CERO';
  } else if (enteros === 1) {
    palabras = 'UN';
  } else {
    const millones = Math.floor(enteros / 1000000);
    const restoMillones = enteros % 1000000;
    const miles = Math.floor(restoMillones / 1000);
    const unidadesGrupo = restoMillones % 1000;
    const partes = [];
    if (millones > 0) partes.push(millones === 1 ? 'UN MILLON' : `${convertirGrupoNumerico(millones)} MILLONES`);
    if (miles > 0) partes.push(miles === 1 ? 'MIL' : `${convertirGrupoNumerico(miles)} MIL`);
    if (unidadesGrupo > 0) partes.push(convertirGrupoNumerico(unidadesGrupo));
    palabras = partes.join(' ');
  }

  const pesoLabel = enteros === 1 ? 'PESO' : 'PESOS';
  const centavosStr = String(centavos).padStart(2, '0');
  return `(* ${palabras} ${pesoLabel} ${centavosStr}/100 M.N. *)`;
}

// Split de pago de nómina entre cuenta_nomina_hsbc y cuenta_alterna
// (prompt-29-split-pago-cuentas.md): desglose de PRESENTACIÓN sobre un
// monto_total ya calculado (jornal + destajo), nunca modifica el cálculo
// base. montoCuentaAlterna se obtiene por resta del total ya redondeado
// (no un segundo cálculo independiente) para que la suma de ambas partes
// cuadre exacto con montoTotal sin diferencia de redondeo. Si el
// trabajador no tiene cuenta_alterna capturada, el split se ignora
// siempre — 100% va a cuenta_nomina_hsbc sin importar splitPct.
function calcularSplitCuentas(montoTotal, splitPct, tieneCuentaAlterna) {
  const total = Number(montoTotal);
  if (!tieneCuentaAlterna) return { montoCuentaNomina: total, montoCuentaAlterna: 0 };
  const montoCuentaNomina = Number((total * Number(splitPct) / 100).toFixed(2));
  const montoCuentaAlterna = Number((total - montoCuentaNomina).toFixed(2));
  return { montoCuentaNomina, montoCuentaAlterna };
}

module.exports = { calcularJornal, calcularDestajo, montoSinIva, totalConIvaDeItems, totalConIvaEsValido, numeroALetra, calcularSplitCuentas };
