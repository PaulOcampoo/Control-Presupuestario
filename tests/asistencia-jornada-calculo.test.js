// Cálculo y validación puros del registro de jornada (sin BD).
import { describe, it, expect } from 'vitest';
import { calcularJornada, validarHoras, diffCampos } from '../server/asistenciaJornada.js';

const cc = { tipo_jornada: 'con_comida', horas_jornada: 8 };
describe('calcularJornada', () => {
  it('con comida 08:00/13:00/14:00/18:00 -> 540 trabajadas, 60 extra', () => {
    const r = calcularJornada({ hora_entrada: '08:00', hora_salida_comida: '13:00', hora_regreso_comida: '14:00', hora_salida: '18:00' }, cc);
    expect(r).toEqual({ completo: true, trabajadas_min: 540, extra_min: 60 });
  });
  it('acepta HH:MM:SS de Postgres', () => {
    const r = calcularJornada({ hora_entrada: '08:00:00', hora_salida_comida: '13:00:00', hora_regreso_comida: '14:00:00', hora_salida: '18:00:00' }, cc);
    expect(r.trabajadas_min).toBe(540);
  });
  it('corrida 07:00-15:00 -> 480, extra 0', () => {
    expect(calcularJornada({ hora_entrada: '07:00', hora_salida: '15:00' }, { tipo_jornada: 'corrida', horas_jornada: 8 }))
      .toEqual({ completo: true, trabajadas_min: 480, extra_min: 0 });
  });
  it('sin_comida=true solo requiere entrada+salida', () => {
    expect(calcularJornada({ hora_entrada: '08:00', hora_salida: '17:00', sin_comida: true }, cc))
      .toEqual({ completo: true, trabajadas_min: 540, extra_min: 60 });
  });
  it('incompleto -> null', () => {
    expect(calcularJornada({ hora_entrada: '08:00', hora_salida: '17:00' }, cc)).toEqual({ completo: false, trabajadas_min: null, extra_min: null });
  });
});

describe('validarHoras', () => {
  it('rechaza formato inválido', () => expect(validarHoras({ hora_entrada: '8:00' }).error).toBeTruthy());
  it('rechaza entrada >= salida', () => expect(validarHoras({ hora_entrada: '18:00', hora_salida: '08:00' }).error).toBeTruthy());
  it('rechaza horas desordenadas', () => expect(validarHoras({ hora_entrada: '08:00', hora_salida_comida: '14:00', hora_regreso_comida: '13:00', hora_salida: '18:00' }).error).toBeTruthy());
  it('warnings: comida > 90 min, > 12 h, > 3 h extra', () => {
    const v = validarHoras({ hora_entrada: '06:00', hora_salida_comida: '10:00', hora_regreso_comida: '12:00', hora_salida: '21:00', horas_jornada: 8 });
    expect(v.error).toBeUndefined();
    expect(v.warnings.length).toBe(3);
  });
  it('corrida descarta campos de comida', () => {
    const v = validarHoras({ hora_entrada: '07:00', hora_salida_comida: '12:00', hora_regreso_comida: '13:00', hora_salida: '15:00' }, { tipo_jornada: 'corrida' });
    expect(v.valores.hora_salida_comida).toBeNull();
  });
});

describe('diffCampos', () => {
  it('detecta solo lo que cambió', () => {
    const d = diffCampos({ hora_entrada: '08:00:00', hora_salida: null, sin_comida: false }, { hora_entrada: '08:00', hora_salida: '17:00', sin_comida: false });
    expect(d).toEqual([{ campo: 'hora_salida', valor_anterior: null, valor_nuevo: '17:00' }]);
  });
});
