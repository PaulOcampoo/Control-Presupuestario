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

module.exports = { calcularJornal, calcularDestajo, montoSinIva, totalConIvaEsValido };
