import { describe, it, expect } from 'vitest';
import { determinarUmbral } from '../server/alertasContrato.js';
import { elegirVigente, estatusDeDocumento, construirMensajeDocumento, TIPOS_DOCUMENTO } from '../server/cumplimiento.js';

function hoyMasDias(dias) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

describe('determinarUmbral — umbrales configurables (prompt-cumplimiento-subcontratistas.md)', () => {
  it('default [30,15,7] produce exactamente el mismo resultado que antes (sin regresión de contrato)', () => {
    expect(determinarUmbral(30, false)).toBe('30_dias');
    expect(determinarUmbral(15, false)).toBe('15_dias');
    expect(determinarUmbral(7, false)).toBe('7_dias');
    expect(determinarUmbral(0, false)).toBe('vencido');
    expect(determinarUmbral(0, true)).toBe(null);
    expect(determinarUmbral(-5, false)).toBe('vencido');
    expect(determinarUmbral(20, false)).toBe(null);
  });

  it('umbrales propios (ej. Opinión SAT [15,7,3]) usan esos valores en vez de 30/15/7', () => {
    const umbrales = [15, 7, 3];
    expect(determinarUmbral(15, false, umbrales)).toBe('15_dias');
    expect(determinarUmbral(7, false, umbrales)).toBe('7_dias');
    expect(determinarUmbral(3, false, umbrales)).toBe('3_dias');
    expect(determinarUmbral(30, false, umbrales)).toBe(null); // 30 ya no es umbral para este tipo
    expect(determinarUmbral(-1, false, umbrales)).toBe('vencido');
  });
});

describe('elegirVigente — vigente = fecha_vencimiento más reciente, o subido_en si no vence', () => {
  it('entre 2 documentos del mismo tipo (simulando renovación), gana el de fecha_vencimiento más reciente', () => {
    const viejo = { id: 1, fecha_vencimiento: '2026-01-01', subido_en: '2025-06-01T00:00:00Z' };
    const nuevo = { id: 2, fecha_vencimiento: '2026-12-31', subido_en: '2025-12-01T00:00:00Z' };
    expect(elegirVigente([viejo, nuevo]).id).toBe(2);
    expect(elegirVigente([nuevo, viejo]).id).toBe(2); // orden de entrada no importa
  });

  it('sin fecha_vencimiento en ninguno (ej. identificacion_representante): gana el subido_en más reciente', () => {
    const a = { id: 1, fecha_vencimiento: null, subido_en: '2025-01-01T00:00:00Z' };
    const b = { id: 2, fecha_vencimiento: null, subido_en: '2025-06-01T00:00:00Z' };
    expect(elegirVigente([a, b]).id).toBe(2);
  });

  it('lista vacía devuelve null', () => {
    expect(elegirVigente([])).toBe(null);
  });
});

describe('estatusDeDocumento', () => {
  it('sin documento vigente: no_capturado', () => {
    expect(estatusDeDocumento(null, 'poliza_rc')).toBe('no_capturado');
  });

  it('tipo que no vence (identificacion_representante) sin fecha: vigente', () => {
    expect(estatusDeDocumento({ fecha_vencimiento: null }, 'identificacion_representante')).toBe('vigente');
  });

  it('vencido: fecha en el pasado', () => {
    expect(estatusDeDocumento({ fecha_vencimiento: hoyMasDias(-5) }, 'poliza_rc')).toBe('vencido');
  });

  it('por_vencer: dentro del primer umbral del tipo (30 para poliza_rc)', () => {
    expect(estatusDeDocumento({ fecha_vencimiento: hoyMasDias(10) }, 'poliza_rc')).toBe('por_vencer');
  });

  it('vigente: fuera del primer umbral', () => {
    expect(estatusDeDocumento({ fecha_vencimiento: hoyMasDias(90) }, 'poliza_rc')).toBe('vigente');
  });

  it('opinion_cumplimiento_sat usa su umbral corto propio (15), no el genérico 30', () => {
    // A 20 días: por debajo del umbral genérico (30) pero FUERA del umbral
    // corto de este tipo (15) — debe leerse "vigente", no "por_vencer".
    expect(estatusDeDocumento({ fecha_vencimiento: hoyMasDias(20) }, 'opinion_cumplimiento_sat')).toBe('vigente');
    expect(estatusDeDocumento({ fecha_vencimiento: hoyMasDias(10) }, 'opinion_cumplimiento_sat')).toBe('por_vencer');
  });
});

describe('construirMensajeDocumento', () => {
  it('umbral de días', () => {
    const msg = construirMensajeDocumento('15_dias', 'Acero del Centro SA', TIPOS_DOCUMENTO.poliza_rc.label, '2026-09-01');
    expect(msg).toContain('Acero del Centro SA');
    expect(msg).toContain('15 días');
  });

  it('vencido', () => {
    const msg = construirMensajeDocumento('vencido', 'Acero del Centro SA', TIPOS_DOCUMENTO.poliza_rc.label, '2026-09-01');
    expect(msg).toContain('ya venció');
  });
});
