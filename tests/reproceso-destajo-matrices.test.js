import { describe, it, expect } from 'vitest';
import { resolverDestajoContraConceptos } from '../server/reprocesoDestajoMatrices.js';

function destajistasParsed(itemsOverride) {
  return [{
    nombre: 'Mano de Obra General',
    items: itemsOverride,
  }];
}

describe('resolverDestajoContraConceptos', () => {
  it('resuelve a "nuevo" cuando el código matchea un único concepto sin destajo previo', () => {
    const conceptosPorCodigo = new Map([['AJAL.KAI.TRAL', [{ id: 501, codigo: 'AJAL.KAI.TRAL' }]]]);
    const r = resolverDestajoContraConceptos(
      destajistasParsed([{ codigo: 'AJAL.KAI.TRAL', concepto: 'Trazo', unidad: 'M', cantidad_asignada: 150, precio_destajo: 9.09, orden: 0 }]),
      { conceptosPorCodigo, conceptoIdsConDestajo: new Set(), destajoPrecios: {} }
    );
    expect(r.nuevos).toHaveLength(1);
    expect(r.nuevos[0].concepto_id).toBe(501);
    expect(r.nuevos[0].precio_destajo).toBe(9.09);
    expect(r.omitidos).toHaveLength(0);
  });

  it('omite cuando el concepto ya tiene destajo cargado', () => {
    const conceptosPorCodigo = new Map([['AJAL.KAI.TRAL', [{ id: 501, codigo: 'AJAL.KAI.TRAL' }]]]);
    const r = resolverDestajoContraConceptos(
      destajistasParsed([{ codigo: 'AJAL.KAI.TRAL', concepto: 'Trazo', unidad: 'M', cantidad_asignada: 150, precio_destajo: 9.09, orden: 0 }]),
      { conceptosPorCodigo, conceptoIdsConDestajo: new Set([501]), destajoPrecios: {} }
    );
    expect(r.omitidos).toHaveLength(1);
    expect(r.nuevos).toHaveLength(0);
  });

  it('reporta sin match cuando el código no existe entre los conceptos de la obra', () => {
    const r = resolverDestajoContraConceptos(
      destajistasParsed([{ codigo: 'NO-EXISTE', concepto: 'X', unidad: 'M', cantidad_asignada: 1, precio_destajo: 1, orden: 0 }]),
      { conceptosPorCodigo: new Map(), conceptoIdsConDestajo: new Set(), destajoPrecios: {} }
    );
    expect(r.sinMatch).toHaveLength(1);
    expect(r.nuevos).toHaveLength(0);
  });

  it('reporta ambiguo cuando el código corresponde a mas de un concepto en la obra', () => {
    const conceptosPorCodigo = new Map([['AJAL.KAI.EXC01', [{ id: 1, codigo: 'AJAL.KAI.EXC01' }, { id: 2, codigo: 'AJAL.KAI.EXC01' }]]]);
    const r = resolverDestajoContraConceptos(
      destajistasParsed([{ codigo: 'AJAL.KAI.EXC01', concepto: 'Excavacion', unidad: 'M3', cantidad_asignada: 8, precio_destajo: 741.07, orden: 0 }]),
      { conceptosPorCodigo, conceptoIdsConDestajo: new Set(), destajoPrecios: {} }
    );
    expect(r.ambiguos).toHaveLength(1);
    expect(r.nuevos).toHaveLength(0);
  });

  it('usa destajoPrecios como fallback cuando el item no trae precio_destajo propio', () => {
    const conceptosPorCodigo = new Map([['AJAL.KAI.TRAL', [{ id: 501, codigo: 'AJAL.KAI.TRAL' }]]]);
    const r = resolverDestajoContraConceptos(
      destajistasParsed([{ codigo: 'AJAL.KAI.TRAL', concepto: 'Trazo', unidad: 'M', cantidad_asignada: 150, precio_destajo: 0, orden: 0 }]),
      { conceptosPorCodigo, conceptoIdsConDestajo: new Set(), destajoPrecios: { 'AJAL.KAI.TRAL': 9.09 } }
    );
    expect(r.nuevos[0].precio_destajo).toBe(9.09);
  });
});
