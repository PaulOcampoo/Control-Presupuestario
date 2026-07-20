import { describe, it, expect } from 'vitest';
import { calcularJornal, calcularDestajo, montoSinIva } from '../server/calculos.js';

describe('calcularJornal (tarifa_diaria × días presentes)', () => {
  it('caso normal: 6 días presentes a $350/día', () => {
    expect(calcularJornal(6, 350)).toBe(2100);
  });

  it('caso edge: 0 días presentes (faltó toda la semana) da 0 sin importar la tarifa', () => {
    expect(calcularJornal(0, 350)).toBe(0);
  });

  it('caso edge: tarifa 0 da 0 sin importar los días', () => {
    expect(calcularJornal(5, 0)).toBe(0);
  });

  it('datos faltantes: tarifaDiaria undefined produce NaN (comportamiento actual, sin guardas) — no hay fallback a 0 en el código real', () => {
    expect(Number.isNaN(calcularJornal(5, undefined))).toBe(true);
  });
});

describe('calcularDestajo (cantidad × precio_destajo)', () => {
  it('caso normal: 10 unidades a $25.50', () => {
    expect(calcularDestajo(10, 25.5)).toBe(255);
  });

  it('caso edge: cantidad 0 da 0', () => {
    expect(calcularDestajo(0, 100)).toBe(0);
  });

  it('caso edge: precio 0 da 0', () => {
    expect(calcularDestajo(50, 0)).toBe(0);
  });

  it('datos faltantes: cantidad null se trata como 0 (Number(null) === 0), a diferencia de undefined', () => {
    expect(calcularDestajo(null, 25.5)).toBe(0);
  });

  it('datos faltantes: precio undefined produce NaN (comportamiento actual, sin guardas)', () => {
    expect(Number.isNaN(calcularDestajo(10, undefined))).toBe(true);
  });
});

describe('montoSinIva (ajuste IVA /1.16 para Erogado Real)', () => {
  it('caso normal: $1,160 con IVA (16%) equivale a $1,000 sin IVA', () => {
    expect(montoSinIva(1160, 0.16)).toBe(1000);
  });

  it('caso edge: monto 0 da 0', () => {
    expect(montoSinIva(0, 0.16)).toBe(0);
  });

  it('caso edge: tasa de IVA 0 no ajusta el monto', () => {
    expect(montoSinIva(500, 0)).toBe(500);
  });

  it('redondea a 2 decimales igual que el resto de montos monetarios de la app', () => {
    expect(montoSinIva(100, 0.16)).toBe(86.21);
  });

  it('datos faltantes: montoConIva undefined produce NaN (comportamiento actual, sin guardas)', () => {
    expect(Number.isNaN(montoSinIva(undefined, 0.16))).toBe(true);
  });
});
