import { describe, it, expect } from 'vitest';
import { calcularSubtotalRenglon } from '../server/calculos.js';

describe('calcularSubtotalRenglon (Largo×Ancho×Alto×Pzas, campo no aplicable = factor 1)', () => {
  it('caso M2: solo largo y ancho', () => {
    expect(calcularSubtotalRenglon({ largo: 5, ancho: 3 })).toBe(15);
  });

  it('caso ML: solo largo', () => {
    expect(calcularSubtotalRenglon({ largo: 10 })).toBe(10);
  });

  it('caso M3: largo, ancho y alto', () => {
    expect(calcularSubtotalRenglon({ largo: 2, ancho: 3, alto: 4 })).toBe(24);
  });

  it('caso PZA: solo pzas', () => {
    expect(calcularSubtotalRenglon({ pzas: 7 })).toBe(7);
  });

  it('combinación largo+ancho+pzas (ej. losas repetidas)', () => {
    expect(calcularSubtotalRenglon({ largo: 2, ancho: 1.5, pzas: 3 })).toBe(9);
  });

  it('renglón completamente vacío da 0 (nada medido todavía)', () => {
    expect(calcularSubtotalRenglon({})).toBe(0);
    expect(calcularSubtotalRenglon({ largo: null, ancho: undefined, alto: '', pzas: NaN })).toBe(0);
  });

  it('0 explícito se trata igual que vacío (no aplica, factor 1) — no colapsa el subtotal a 0', () => {
    expect(calcularSubtotalRenglon({ largo: 5, pzas: 0 })).toBe(5);
  });

  it('valores negativos se tratan como no aplicables (factor 1)', () => {
    expect(calcularSubtotalRenglon({ largo: 5, ancho: -2 })).toBe(5);
  });

  it('acepta strings numéricos (valores que llegan de un input de formulario)', () => {
    expect(calcularSubtotalRenglon({ largo: '5.5', ancho: '2' })).toBe(11);
  });

  it('los 4 campos combinados (M3 con piezas repetidas)', () => {
    expect(calcularSubtotalRenglon({ largo: 2, ancho: 2, alto: 1, pzas: 5 })).toBe(20);
  });
});
