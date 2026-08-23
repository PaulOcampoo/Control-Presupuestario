'use strict';

// prompt-reprocesar-destajo-matrices-obras-viejas.md: completa destajo_items/
// matrices_precio_unitario en obras que ya existían antes del fix de PR
// #178/#179 (parser.js no reconocía "Pu Mano de Obra" y nunca leía la hoja
// "Matrices" del alta), volviendo a subir el MISMO Excel original de esa
// obra. NUNCA crea conceptos ni toca Presupuesto/Insumos -- solo resuelve
// las hojas Destajos/Matrices contra los conceptos YA EXISTENTES por código.
// El lado de Matrices reusa matricesImport.resolverBloqueImportacion tal
// cual (server/app.js/ingest.js), ese ya fue diseñado para este caso de uso.
// Este módulo cubre el lado de Destajo, que no tenía un resolver equivalente.

// destajistasParsed: array de {nombre, items:[{codigo, concepto, unidad,
// cantidad_asignada, precio_destajo, orden}]} tal cual devuelve
// parser.js:parseDestajistas. conceptosPorCodigo: Map<codigo, [{id, codigo}]>
// -- array (no un valor único) para poder detectar códigos ambiguos dentro
// de la obra, mismo criterio que matricesImport.resolverBloqueImportacion.
// conceptoIdsConDestajo: Set<concepto_id> ya presentes en destajo_items.
// destajoPrecios: {[codigo]: precio} fallback plano (mismo criterio que
// ingest.js cuando el item no trae precio_destajo propio).
function resolverDestajoContraConceptos(destajistasParsed, { conceptosPorCodigo, conceptoIdsConDestajo, destajoPrecios }) {
  const nuevos = [];
  const omitidos = [];
  const sinMatch = [];
  const ambiguos = [];

  for (const destajista of destajistasParsed) {
    for (const item of destajista.items) {
      const base = { ...item, destajista_nombre: destajista.nombre };
      if (!item.codigo) {
        sinMatch.push({ ...base, motivo: 'Fila sin código de concepto.' });
        continue;
      }
      const candidatos = conceptosPorCodigo.get(item.codigo);
      if (!candidatos || !candidatos.length) {
        sinMatch.push({ ...base, motivo: `No existe un concepto con código "${item.codigo}" en esta obra.` });
        continue;
      }
      if (candidatos.length > 1) {
        ambiguos.push({ ...base, motivo: `El código "${item.codigo}" corresponde a ${candidatos.length} conceptos distintos en esta obra — no se puede determinar automáticamente a cuál corresponde.` });
        continue;
      }
      const concepto = candidatos[0];
      if (conceptoIdsConDestajo.has(concepto.id)) {
        omitidos.push({ ...base, concepto_id: concepto.id, motivo: 'Este concepto ya tiene destajo cargado — no se sobreescribe.' });
        continue;
      }
      const precio = item.precio_destajo > 0 ? item.precio_destajo : (destajoPrecios?.[item.codigo] || 0);
      nuevos.push({ ...base, concepto_id: concepto.id, precio_destajo: precio });
    }
  }
  return { nuevos, omitidos, sinMatch, ambiguos };
}

module.exports = { resolverDestajoContraConceptos };
