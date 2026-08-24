import { describe, it, expect } from 'vitest';
import { calcularJornal, calcularDestajo, montoSinIva, totalConIvaEsValido, numeroALetra, calcularSplitCuentas, distribuirDestajoGrupo } from '../server/calculos.js';

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

describe('totalConIvaEsValido (prompt-12-fix-totales-iva-invertidos.md)', () => {
  it('caso normal: con IVA mayor que sin IVA (razón 1.16 típica) es válido', () => {
    expect(totalConIvaEsValido(1000, 1160)).toBe(true);
  });

  it('caso del bug real (obra "Presupuestos Vinte"): con IVA menor que sin IVA es inválido', () => {
    expect(totalConIvaEsValido(2372159.39, 1876426.39)).toBe(false);
  });

  it('caso edge: con IVA igual a sin IVA (IVA 0%) es válido (límite inclusive)', () => {
    expect(totalConIvaEsValido(1000, 1000)).toBe(true);
  });

  it('caso edge: total_con_iva null (obra sin ese dato capturado) no se marca inválido', () => {
    expect(totalConIvaEsValido(1000, null)).toBe(true);
  });

  it('caso edge: total_con_iva undefined (mismo tratamiento que null) no se marca inválido', () => {
    expect(totalConIvaEsValido(1000, undefined)).toBe(true);
  });
});

describe('numeroALetra (importe del Precio Unitario en letra, prompt-20-matrices-formato-neodata.md)', () => {
  it('caso del ejemplo real del Excel de referencia: 200.65 -> DOSCIENTOS PESOS 65/100', () => {
    expect(numeroALetra(200.65)).toBe('(* DOSCIENTOS PESOS 65/100 M.N. *)');
  });

  it('caso cero: 0 -> CERO PESOS (plural, no "cero peso")', () => {
    expect(numeroALetra(0)).toBe('(* CERO PESOS 00/100 M.N. *)');
  });

  it('singular: 1.00 -> UN PESO (singular, sin "uno")', () => {
    expect(numeroALetra(1)).toBe('(* UN PESO 00/100 M.N. *)');
  });

  it('plural: 2.00 -> DOS PESOS', () => {
    expect(numeroALetra(2)).toBe('(* DOS PESOS 00/100 M.N. *)');
  });

  it('decimales: centavos con cero a la izquierda (1.05 -> 05/100)', () => {
    expect(numeroALetra(1.05)).toBe('(* UN PESO 05/100 M.N. *)');
  });

  it('apocope de "uno" en veintiuno: 21.00 -> VEINTIUN PESOS (no "veintiuno")', () => {
    expect(numeroALetra(21)).toBe('(* VEINTIUN PESOS 00/100 M.N. *)');
  });

  it('apocope de "uno" compuesto: 31.00 -> TREINTA Y UN PESOS (no "treinta y uno")', () => {
    expect(numeroALetra(31)).toBe('(* TREINTA Y UN PESOS 00/100 M.N. *)');
  });

  it('cien exacto: 100.00 -> CIEN PESOS (no "ciento")', () => {
    expect(numeroALetra(100)).toBe('(* CIEN PESOS 00/100 M.N. *)');
  });

  it('ciento + resto: 101.00 -> CIENTO UN PESOS', () => {
    expect(numeroALetra(101)).toBe('(* CIENTO UN PESOS 00/100 M.N. *)');
  });

  it('centenas irregulares: 500.00 -> QUINIENTOS PESOS (no "cincocientos")', () => {
    expect(numeroALetra(500)).toBe('(* QUINIENTOS PESOS 00/100 M.N. *)');
  });

  it('miles: 1000.00 -> MIL PESOS (no "un mil")', () => {
    expect(numeroALetra(1000)).toBe('(* MIL PESOS 00/100 M.N. *)');
  });

  it('miles compuestos: 2500.00 -> DOS MIL QUINIENTOS PESOS', () => {
    expect(numeroALetra(2500)).toBe('(* DOS MIL QUINIENTOS PESOS 00/100 M.N. *)');
  });

  it('cien mil: 100000.00 -> CIEN MIL PESOS', () => {
    expect(numeroALetra(100000)).toBe('(* CIEN MIL PESOS 00/100 M.N. *)');
  });

  it('millones: 1000000.00 -> UN MILLON PESOS (singular, no "un millones")', () => {
    expect(numeroALetra(1000000)).toBe('(* UN MILLON PESOS 00/100 M.N. *)');
  });

  it('millones plural: 2000000.00 -> DOS MILLONES PESOS', () => {
    expect(numeroALetra(2000000)).toBe('(* DOS MILLONES PESOS 00/100 M.N. *)');
  });

  it('caso combinado real de presupuesto: 1234567.89', () => {
    expect(numeroALetra(1234567.89)).toBe('(* UN MILLON DOSCIENTOS TREINTA Y CUATRO MIL QUINIENTOS SESENTA Y SIETE PESOS 89/100 M.N. *)');
  });
});

describe('calcularSplitCuentas (prompt-29-split-pago-cuentas.md)', () => {
  it('caso normal: split 70/30 sobre $2,100 con cuenta_alterna capturada', () => {
    expect(calcularSplitCuentas(2100, 70, true)).toEqual({ montoCuentaNomina: 1470, montoCuentaAlterna: 630 });
  });

  it('sin cuenta_alterna: 100% a cuenta_nomina sin importar el split capturado', () => {
    expect(calcularSplitCuentas(2100, 30, false)).toEqual({ montoCuentaNomina: 2100, montoCuentaAlterna: 0 });
  });

  it('split 100 (default): todo a cuenta_nomina aunque sí haya cuenta_alterna', () => {
    expect(calcularSplitCuentas(2100, 100, true)).toEqual({ montoCuentaNomina: 2100, montoCuentaAlterna: 0 });
  });

  it('split 0: todo a cuenta_alterna', () => {
    expect(calcularSplitCuentas(2100, 0, true)).toEqual({ montoCuentaNomina: 0, montoCuentaAlterna: 2100 });
  });

  it('no hay diferencia de redondeo: la suma de ambas partes siempre cuadra exacto con el total, incluso con montos que no redondean limpio', () => {
    const { montoCuentaNomina, montoCuentaAlterna } = calcularSplitCuentas(1000.33, 33, true);
    expect(montoCuentaNomina + montoCuentaAlterna).toBe(1000.33);
  });

  it('monto_total 0: ambas partes en 0', () => {
    expect(calcularSplitCuentas(0, 70, true)).toEqual({ montoCuentaNomina: 0, montoCuentaAlterna: 0 });
  });
});

describe('distribuirDestajoGrupo (prompt-fix-distribucion-destajo-nomina.md)', () => {
  it('destajista sin vinculados (grupo de 1): recibe el 100% del total, sin cambio de comportamiento', () => {
    const grupo = [{ id: 1, nombre: 'Juan Pérez' }];
    expect(distribuirDestajoGrupo(10850.42, grupo, 'Juan Pérez')).toEqual([
      { id: 1, monto: 10850.42, alerta: null },
    ]);
  });

  it('destajista + 2 vinculados: cada vinculado recibe $500 fijo y el principal el remanente, cuadrando exacto con el total original', () => {
    const grupo = [
      { id: 1, nombre: 'Juan Pérez' },
      { id: 2, nombre: 'Pedro Ramírez' },
      { id: 3, nombre: 'Luis Torres' },
    ];
    const reparto = distribuirDestajoGrupo(10850.42, grupo, 'Juan Pérez');
    expect(reparto).toEqual([
      { id: 2, monto: 500, alerta: null },
      { id: 3, monto: 500, alerta: null },
      { id: 1, monto: 9850.42, alerta: null },
    ]);
    expect(reparto.reduce((s, r) => s + r.monto, 0)).toBe(10850.42);
  });

  it('name-matching es insensible a mayúsculas y espacios al resolver al principal', () => {
    const grupo = [
      { id: 1, nombre: '  juan PÉREZ  ' },
      { id: 2, nombre: 'Pedro Ramírez' },
    ];
    const reparto = distribuirDestajoGrupo(1500, grupo, 'Juan Pérez');
    expect(reparto).toEqual([
      { id: 2, monto: 500, alerta: null },
      { id: 1, monto: 1000, alerta: null },
    ]);
  });

  it('edge case: remanente negativo (5 vinculados a $500 = $2,500 excede un total de $2,000) — prorratea entre vinculados, principal en $0 y ambos marcados con alerta', () => {
    const grupo = [
      { id: 1, nombre: 'Juan Pérez' },
      { id: 2, nombre: 'A' }, { id: 3, nombre: 'B' }, { id: 4, nombre: 'C' }, { id: 5, nombre: 'D' }, { id: 6, nombre: 'E' },
    ];
    const reparto = distribuirDestajoGrupo(2000, grupo, 'Juan Pérez');
    const principal = reparto.find((r) => r.id === 1);
    const vinculados = reparto.filter((r) => r.id !== 1);
    expect(principal.monto).toBe(0);
    expect(principal.alerta).toMatch(/Remanente insuficiente/);
    vinculados.forEach((v) => {
      expect(v.monto).toBe(400); // 2000 / 5 vinculados
      expect(v.alerta).toMatch(/Remanente insuficiente/);
    });
    expect(reparto.reduce((s, r) => s + r.monto, 0)).toBe(2000);
  });

  it('edge case: ningún trabajador del grupo coincide de nombre con el destajista — reparte en partes iguales entre todo el grupo y marca alerta en todos', () => {
    const grupo = [
      { id: 1, nombre: 'Ayudante Uno' },
      { id: 2, nombre: 'Ayudante Dos' },
    ];
    const reparto = distribuirDestajoGrupo(1000, grupo, 'Destajista Sin Coincidencia');
    expect(reparto).toEqual([
      { id: 1, monto: 500, alerta: expect.stringMatching(/No se identificó al destajista principal/) },
      { id: 2, monto: 500, alerta: expect.stringMatching(/No se identificó al destajista principal/) },
    ]);
    expect(reparto.reduce((s, r) => s + r.monto, 0)).toBe(1000);
  });

  it('el último miembro de un reparto prorrateado absorbe el residuo para que la suma cuadre exacto incluso con montos que no dividen limpio', () => {
    const grupo = [
      { id: 1, nombre: 'Juan Pérez' },
      { id: 2, nombre: 'A' }, { id: 3, nombre: 'B' }, { id: 4, nombre: 'C' },
    ];
    const reparto = distribuirDestajoGrupo(1000, grupo, 'Juan Pérez'); // 500*3=1500 > 1000 -> prorratea entre 3 vinculados
    expect(reparto.reduce((s, r) => s + r.monto, 0)).toBe(1000);
  });
});
