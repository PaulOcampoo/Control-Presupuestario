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

  it('código repetido con MISMO conteo en Excel y en la DB (metodología AJAL — misma partida repetida por zona, prompt-fase0/fase1-emparejamiento-duplicados-legitimos): empareja posicionalmente, sin conflicto', () => {
    // Confirmado con Paul y reproducido contra datos reales de Kalia
    // (Fase 0): este NO es un caso de ambigüedad de datos — es el estado
    // normal de la DB después de la primera carga de un presupuesto con
    // partidas repetidas por zona. Antes de este fix, caía al fallback por
    // descripción y siempre generaba conflicto (12 conflictos reales en
    // proyecto 32 de Kalia); ahora empareja por posición igual que el caso
    // asimétrico (Excel duplicado / DB no duplicada).
    const { emparejados, nuevos, historicos, conflictos } = emparejarConceptos(
      [
        item({ codigo: 'DUP3', concepto: 'Concepto A', orden: 1 }),
        item({ codigo: 'DUP3', concepto: 'Concepto A', orden: 2 }),
      ],
      [
        existente({ id: 1, codigo: 'DUP3', concepto: 'Concepto A' }),
        existente({ id: 2, codigo: 'DUP3', concepto: 'Concepto A' }),
      ]
    );
    expect(conflictos).toHaveLength(0);
    expect(emparejados).toHaveLength(2);
    expect(emparejados.every((m) => m.via === 'codigo-duplicado')).toBe(true);
    expect(emparejados[0].existente.id).toBe(1);
    expect(emparejados[1].existente.id).toBe(2);
    expect(nuevos).toHaveLength(0);
    expect(historicos).toHaveLength(0);
  });

  it('código repetido con conteo DISTINTO en Excel y en la DB (2 en Excel vs 3 en DB): sigue siendo ambigüedad real, cae a descripción', () => {
    // El fix solo relaja el caso de conteo IGUAL. Conteo asimétrico con
    // ambos lados duplicados (ni el caso original del Paso 0 ni el nuevo
    // caso N-a-N) sigue sin tener una forma no ambigua de decidir qué fila
    // vieja corresponde a cuál fila nueva — debe seguir reportándose.
    const { emparejados, conflictos } = emparejarConceptos(
      [
        item({ codigo: 'DUP4', concepto: 'Concepto B', orden: 1 }),
        item({ codigo: 'DUP4', concepto: 'Concepto B', orden: 2 }),
      ],
      [
        existente({ id: 1, codigo: 'DUP4', concepto: 'Concepto B' }),
        existente({ id: 2, codigo: 'DUP4', concepto: 'Concepto B' }),
        existente({ id: 3, codigo: 'DUP4', concepto: 'Concepto B' }),
      ]
    );
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

  it('end-to-end: emparejamiento N-a-N con precio distinto en una de las filas sigue exigiendo confirmación (guard no se debilitó con el fix de fase1)', () => {
    const { emparejados } = emparejarConceptos(
      [
        item({ codigo: 'DUP5', concepto: 'Concepto C', orden: 1, precio_unitario: 100 }),
        item({ codigo: 'DUP5', concepto: 'Concepto C', orden: 2, precio_unitario: 150 }),
      ],
      [
        existente({ id: 1, codigo: 'DUP5', concepto: 'Concepto C', precio_unitario: 100 }),
        existente({ id: 2, codigo: 'DUP5', concepto: 'Concepto C', precio_unitario: 100 }),
      ]
    );
    expect(emparejados).toHaveLength(2);
    const cambios = emparejados.map(calcularCambios);
    expect(cambios[0].ambiguo).toBe(false); // fila 1: sin cambio
    expect(cambios[1].ambiguo).toBe(true); // fila 2: precio distinto vía codigo-duplicado
  });
});
