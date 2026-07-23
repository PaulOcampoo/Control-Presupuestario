import { describe, it, expect } from 'vitest';
import { emparejarConceptos, calcularCambios } from '../server/reintegracionPresupuesto.js';

function existente(overrides) {
  return { id: 1, codigo: 'C1', concepto: 'Concepto', unidad: 'M2', cantidad: 10, precio_unitario: 100, importe: 1000, grupo: null, es_total: 0, orden: 1, activo: 1, ...overrides };
}
function item(overrides) {
  return { codigo: 'C1', concepto: 'Concepto', unidad: 'M2', cantidad: 10, precio_unitario: 100, importe: 1000, grupo: null, es_total: 0, orden: 1, ...overrides };
}

describe('emparejarConceptos — caso normal 1:1 (no debe tocarse, ya verificado VINTE/AMANI)', () => {
  it('empareja por código único en ambos lados', () => {
    const { emparejados, nuevos, historicos, conflictos } = emparejarConceptos(
      [item({ codigo: 'A1' })],
      [existente({ id: 1, codigo: 'A1' })]
    );
    expect(emparejados).toHaveLength(1);
    expect(emparejados[0].via).toBe('codigo');
    expect(emparejados[0].existente.id).toBe(1);
    expect(nuevos).toHaveLength(0);
    expect(historicos).toHaveLength(0);
    expect(conflictos).toHaveLength(0);
  });

  it('sin match por código, único candidato por descripción exacta', () => {
    const { emparejados } = emparejarConceptos(
      [item({ codigo: null, concepto: 'Losa de cimentación' })],
      [existente({ id: 5, codigo: null, concepto: 'Losa de cimentación' })]
    );
    expect(emparejados).toHaveLength(1);
    expect(emparejados[0].via).toBe('descripcion');
  });
});

describe('emparejarConceptos — duplicados legítimos en el Excel nuevo (prompt-conflictos-emparejamiento-presupuesto)', () => {
  it('código repetido 2 veces en Excel vs 1 existente: primera fila empareja, la segunda es nueva, sin conflicto', () => {
    const { emparejados, nuevos, historicos, conflictos } = emparejarConceptos(
      [
        item({ codigo: 'DUP1', concepto: 'Adocreto color grafito', orden: 1 }),
        item({ codigo: 'DUP1', concepto: 'Adocreto color grafito', orden: 2 }),
      ],
      [existente({ id: 9, codigo: 'DUP1', concepto: 'Adocreto color grafito' })]
    );
    expect(conflictos).toHaveLength(0);
    expect(emparejados).toHaveLength(1);
    expect(emparejados[0].existente.id).toBe(9);
    expect(emparejados[0].via).toBe('codigo-duplicado');
    expect(nuevos).toHaveLength(1);
    expect(historicos).toHaveLength(0);
  });

  it('código repetido 3 veces en Excel vs 0 existentes: las 3 filas son nuevas, sin conflicto', () => {
    const { emparejados, nuevos, conflictos } = emparejarConceptos(
      [
        item({ codigo: 'DUP2', orden: 1 }),
        item({ codigo: 'DUP2', orden: 2 }),
        item({ codigo: 'DUP2', orden: 3 }),
      ],
      []
    );
    expect(conflictos).toHaveLength(0);
    expect(emparejados).toHaveLength(0);
    expect(nuevos).toHaveLength(3);
  });

  it('código repetido en Excel Y en la DB (ambigüedad real de datos preexistente): sigue cayendo a descripción, sin regresión', () => {
    const { emparejados, conflictos } = emparejarConceptos(
      [
        item({ codigo: 'DUP3', concepto: 'Concepto A', orden: 1 }),
        item({ codigo: 'DUP3', concepto: 'Concepto A', orden: 2 }),
      ],
      [
        existente({ id: 1, codigo: 'DUP3', concepto: 'Concepto A' }),
        existente({ id: 2, codigo: 'DUP3', concepto: 'Concepto A' }),
      ]
    );
    // Ambos lados duplicados: no es el escenario de "duplicado legítimo del
    // Excel", cae al fallback por descripción de siempre — 2 nuevos vs 2
    // existentes con la misma descripción sigue siendo ambigüedad real.
    expect(conflictos.length).toBeGreaterThan(0);
    expect(emparejados).toHaveLength(0);
  });
});

describe('calcularCambios — detección de cambio ambiguo de precio/cantidad', () => {
  it('cambia solo precio en match 1:1 normal: no es ambiguo', () => {
    const m = { existente: existente({ precio_unitario: 100, cantidad: 10 }), nuevo: item({ precio_unitario: 150, cantidad: 10 }), via: 'codigo' };
    const r = calcularCambios(m);
    expect(r.cambiaPrecio).toBe(true);
    expect(r.cambiaCantidad).toBe(false);
    expect(r.ambiguo).toBe(false);
  });

  it('cambia solo cantidad en match 1:1 normal: no es ambiguo', () => {
    const m = { existente: existente({ precio_unitario: 100, cantidad: 10 }), nuevo: item({ precio_unitario: 100, cantidad: 25 }), via: 'codigo' };
    const r = calcularCambios(m);
    expect(r.cambiaCantidad).toBe(true);
    expect(r.ambiguo).toBe(false);
  });

  it('cambian precio Y cantidad a la vez en match 1:1 normal: ambiguo, requiere selector', () => {
    const m = { existente: existente({ precio_unitario: 100, cantidad: 10 }), nuevo: item({ precio_unitario: 150, cantidad: 25 }), via: 'codigo' };
    const r = calcularCambios(m);
    expect(r.ambiguo).toBe(true);
  });

  it('match via código-duplicado con cambio de precio: ambiguo aunque solo cambie un campo', () => {
    const m = { existente: existente({ precio_unitario: 100, cantidad: 10 }), nuevo: item({ precio_unitario: 150, cantidad: 10 }), via: 'codigo-duplicado' };
    const r = calcularCambios(m);
    expect(r.ambiguo).toBe(true);
  });

  it('match via código-duplicado sin ningún cambio: no es ambiguo', () => {
    const m = { existente: existente({ precio_unitario: 100, cantidad: 10 }), nuevo: item({ precio_unitario: 100, cantidad: 10 }), via: 'codigo-duplicado' };
    const r = calcularCambios(m);
    expect(r.ambiguo).toBe(false);
  });
});
