// Conversión 12 h <-> 24 h del selector de hora propio (Registro de jornada).
// Las funciones viven en public/app.js (script clásico, sin exports): se
// extrae el tramo exacto de código y se evalúa aislado.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const ini = src.indexOf('function horaA12h(');
const fin = src.indexOf('const HORASEL_CLOCK_SVG');
if (ini < 0 || fin < 0) throw new Error('No se encontró el bloque de conversión de hora en public/app.js');
const { horaA12h, horaA24h, formatoHora12 } = new Function(`${src.slice(ini, fin)}; return { horaA12h, horaA24h, formatoHora12 };`)();

const CASOS = [
  ['00:00', '12:00 a. m.'], ['00:05', '12:05 a. m.'], ['08:30', '8:30 a. m.'],
  ['12:00', '12:00 p. m.'], ['13:45', '1:45 p. m.'], ['23:59', '11:59 p. m.'],
];

describe('24 h -> 12 h', () => {
  it.each(CASOS)('%s -> %s', (h24, esperado) => {
    expect(formatoHora12(h24)).toBe(esperado);
  });
  it('vacío o inválido -> --:--', () => {
    expect(formatoHora12('')).toBe('--:--');
    expect(formatoHora12('25:00')).toBe('--:--');
  });
});

describe('12 h -> 24 h (inversa)', () => {
  it.each(CASOS)('%s <- %s', (h24) => {
    const p = horaA12h(h24);
    expect(horaA24h(p.h, p.m, p.pm)).toBe(h24);
  });
  it('12 a. m. = 00 y 12 p. m. = 12', () => {
    expect(horaA24h(12, 0, false)).toBe('00:00');
    expect(horaA24h(12, 0, true)).toBe('12:00');
  });
});
