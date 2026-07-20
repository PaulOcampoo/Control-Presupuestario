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

module.exports = { calcularJornal, calcularDestajo, montoSinIva };
