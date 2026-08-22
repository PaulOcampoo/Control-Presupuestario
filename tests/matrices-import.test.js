import { describe, it, expect } from 'vitest';
import { resolverBloqueImportacion } from '../server/matricesImport.js';

function bloqueBase(overrides) {
  return {
    codigo_concepto: 'EPD1', codigo_analisis: 'AJAL.KAI.TRAL', analisis_no: 10,
    unidad: 'M', cantidad_concepto: 150, importe_concepto: 1533,
    rendimiento: 571.7, cuadrilla_nombre: 'CUADRILLA 1',
    pct_indirecto: 10, pct_financiamiento: 2, pct_utilidad: 8,
    precio_unitario_excel: 9.09,
    renglones: [{ categoria: 'MATERIALES', tipo: 'insumo', codigo: 'INS-1', cantidad: 2, operador: '*' }],
    basicosLocales: [],
    parseErrors: [],
    ...overrides,
  };
}

describe('resolverBloqueImportacion', () => {
  it('resuelve un bloque ok cuando el código de análisis matchea un único concepto y sus insumos existen', () => {
    const conceptosPorCodigo = new Map([['AJAL.KAI.TRAL', [{ id: 501, codigo: 'AJAL.KAI.TRAL' }]]]);
    const insumosPorCodigo = new Map([['INS-1', { id: 900, codigo: 'INS-1', categoria: 'MATERIALES', precio_presupuesto: 5 }]]);

    const r = resolverBloqueImportacion(bloqueBase(), {
      conceptosPorCodigo, insumosPorCodigo, conceptoIdsConMatriz: new Set(),
    });

    expect(r.estado).toBe('ok');
    expect(r.concepto_id).toBe(501);
    expect(typeof r.precio_unitario_calculado).toBe('number');
    expect(r._persistencia.concepto_id).toBe(501);
    expect(r._persistencia.renglonesDirectos).toHaveLength(1);
  });

  it('marca error cuando el código de análisis no existe entre los conceptos de la obra', () => {
    const r = resolverBloqueImportacion(bloqueBase({ codigo_analisis: 'NO-EXISTE' }), {
      conceptosPorCodigo: new Map(), insumosPorCodigo: new Map(), conceptoIdsConMatriz: new Set(),
    });
    expect(r.estado).toBe('error');
    expect(r.motivo).toMatch(/No existe un concepto/);
  });

  it('omite (no sobreescribe) cuando el concepto ya tiene una matriz', () => {
    const conceptosPorCodigo = new Map([['AJAL.KAI.TRAL', [{ id: 501, codigo: 'AJAL.KAI.TRAL' }]]]);
    const r = resolverBloqueImportacion(bloqueBase(), {
      conceptosPorCodigo, insumosPorCodigo: new Map(), conceptoIdsConMatriz: new Set([501]),
    });
    expect(r.estado).toBe('omitido');
  });
});
