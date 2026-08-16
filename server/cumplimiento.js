'use strict';

// Cumplimiento de proveedores/subcontratistas (prompt-cumplimiento-
// subcontratistas.md) — funciones puras, reusa calcularDiasRestantes/
// formatFechaCorta de alertasContrato.js en vez de reimplementarlas.

const { calcularDiasRestantes, formatFechaCorta } = require('./alertasContrato');

// umbrales: primer valor = frontera "por vencer" tanto para el badge de la
// vista de Cumplimiento como para el primer aviso del cron — deben usar el
// mismo criterio para que la UI y las notificaciones nunca se contradigan.
// opinion_cumplimiento_sat tiene umbrales propios más cortos (15/7/3 en vez
// de 30/15/7): su vigencia total es de ~30 días, así que "aviso a 30 días"
// no tiene margen de reacción real — decisión confirmada con Paul.
const TIPOS_DOCUMENTO = {
  constancia_situacion_fiscal: { label: 'Constancia de situación fiscal', vence: true, umbrales: [30, 15, 7] },
  opinion_cumplimiento_sat: { label: 'Opinión de cumplimiento SAT (32-D)', vence: true, umbrales: [15, 7, 3] },
  poliza_rc: { label: 'Póliza de responsabilidad civil', vence: true, umbrales: [30, 15, 7] },
  registro_imss: { label: 'Registro patronal IMSS', vence: true, umbrales: [30, 15, 7] },
  licencia_gremio: { label: 'Licencia/registro de gremio', vence: true, umbrales: [30, 15, 7] },
  identificacion_representante: { label: 'Identificación del representante', vence: false, umbrales: null },
};

function getTipoInfo(tipo) {
  return TIPOS_DOCUMENTO[tipo] || null;
}

// "Vigente" para un proveedor×tipo = la fila con fecha_vencimiento más
// reciente entre las que existen; si el tipo no vence (identificacion_
// representante, fecha_vencimiento siempre null), la más reciente por
// subido_en. `filas` debe venir ya filtrada a un solo proveedor×tipo.
function elegirVigente(filas) {
  if (!filas || !filas.length) return null;
  const conFecha = filas.filter((f) => f.fecha_vencimiento);
  if (conFecha.length) {
    return conFecha.reduce((a, b) => (a.fecha_vencimiento > b.fecha_vencimiento ? a : b));
  }
  return filas.reduce((a, b) => (a.subido_en > b.subido_en ? a : b));
}

// Estatus derivado para la vista consolidada — 'no_capturado' lo decide el
// caller (cuando no hay ninguna fila para ese proveedor×tipo), esta función
// solo evalúa una fila ya elegida como vigente (o null).
function estatusDeDocumento(vigente, tipo) {
  if (!vigente) return 'no_capturado';
  const info = getTipoInfo(tipo);
  if (!info || !info.vence || !vigente.fecha_vencimiento) return 'vigente';
  const dias = calcularDiasRestantes(vigente.fecha_vencimiento);
  if (dias === null) return 'no_capturado';
  if (dias < 0) return 'vencido';
  const primerUmbral = info.umbrales[0];
  if (dias <= primerUmbral) return 'por_vencer';
  return 'vigente';
}

function construirMensajeDocumento(umbral, proveedorNombre, tipoLabel, fechaVencimientoIso) {
  const fecha = formatFechaCorta(fechaVencimientoIso);
  if (umbral === 'vencido') return `${tipoLabel} de ${proveedorNombre} ya venció (${fecha})`;
  const dias = umbral.split('_')[0];
  return `${tipoLabel} de ${proveedorNombre} vence en ${dias} días (${fecha})`;
}

module.exports = { TIPOS_DOCUMENTO, getTipoInfo, elegirVigente, estatusDeDocumento, construirMensajeDocumento };
