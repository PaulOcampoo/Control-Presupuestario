'use strict';

// Alertas de vencimiento de contrato — toda la fecha se maneja como
// 'YYYY-MM-DD' sin componente de hora (mismo formato en que se guarda
// meta.fin_obra), normalizando a medianoche UTC para no desfasar por la
// hora del día en que corre el cron.

function calcularDiasRestantes(finObraIso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(finObraIso || '');
  if (!match) return null;
  const fin = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const ahora = new Date();
  const hoy = Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate());
  return Math.round((fin - hoy) / 86400000);
}

// 'vencido' solo se dispara si aún no se había registrado antes para esa
// obra/documento (yaNotificoVencido) — así se envía una sola vez, no cada día
// que corre el cron después de la fecha de término.
//
// `umbrales` es configurable (prompt-cumplimiento-subcontratistas.md): el
// default [30,15,7] es el mismo de siempre para contrato de obra (llamado
// sin tercer argumento, cero cambio de comportamiento), pero un tipo de
// documento con vigencia total corta (ej. Opinión de Cumplimiento SAT, ~30
// días) puede necesitar umbrales propios más cortos — decisión confirmada
// con Paul, no un valor inventado a ciegas.
function determinarUmbral(diasRestantes, yaNotificoVencido, umbrales = [30, 15, 7]) {
  if (umbrales.includes(diasRestantes)) return `${diasRestantes}_dias`;
  if (diasRestantes <= 0) return yaNotificoVencido ? null : 'vencido';
  return null;
}

function formatFechaCorta(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function construirMensaje(umbral, nombreObra, finObraIso) {
  const fecha = formatFechaCorta(finObraIso);
  switch (umbral) {
    case '30_dias': return `El contrato de ${nombreObra} vence en 30 días (${fecha})`;
    case '15_dias': return `El contrato de ${nombreObra} vence en 15 días (${fecha})`;
    case '7_dias': return `El contrato de ${nombreObra} vence en 7 días (${fecha})`;
    case 'vencido': return `El contrato de ${nombreObra} ya venció (${fecha})`;
    default: return '';
  }
}

module.exports = { calcularDiasRestantes, determinarUmbral, construirMensaje, formatFechaCorta };
