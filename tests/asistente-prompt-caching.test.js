// Unit test para prompt-asistente-ia-prompt-caching.md. No hay
// ANTHROPIC_API_KEY en este entorno (ver tests/asistente-chat.test.js), así
// que no se puede probar un cache hit real contra la API — lo que SÍ se
// puede y se debe verificar sin red es que la FORMA de la request es la
// correcta: system como array de 2 bloques, cache_control SOLO en el
// bloque estático, y ese bloque idéntico byte a byte entre dos llamadas que
// comparten tabsPermitidos aunque cambien rol/obra — si esto se rompe, el
// cache hit real en producción tampoco ocurriría, sin importar la API key.
// Se prueba buildSystemBlocks() en aislado (función pura, sin red) en vez
// de responderChat() completo, para no necesitar mockear el SDK de Anthropic.
import { describe, it, expect } from 'vitest';
import { buildSystemBlocks } from '../server/asistente.js';

describe('buildSystemBlocks (prompt caching)', () => {
  it('devuelve exactamente 2 bloques', () => {
    const blocks = buildSystemBlocks({ puesto: 'residente', proyectoNombre: 'Obra A', tabsPermitidos: ['avance', 'destajo'] });
    expect(blocks.length).toBe(2);
  });

  it('SOLO el primer bloque (estático) lleva cache_control; el segundo (dinámico) no', () => {
    const [bloqueEstatico, bloqueDinamico] = buildSystemBlocks({ puesto: 'residente', proyectoNombre: 'Obra A', tabsPermitidos: ['avance'] });
    expect(bloqueEstatico.cache_control).toEqual({ type: 'ephemeral' });
    expect(bloqueDinamico.cache_control).toBeUndefined();
    expect(bloqueEstatico.type).toBe('text');
    expect(bloqueDinamico.type).toBe('text');
  });

  it('el bloque dinámico (y SOLO el dinámico) contiene el rol y la obra activa', () => {
    const [bloqueEstatico, bloqueDinamico] = buildSystemBlocks({ puesto: 'residente', proyectoNombre: 'Obra Única XYZ', tabsPermitidos: ['avance'] });
    expect(bloqueDinamico.text).toContain('Obra Única XYZ');
    expect(bloqueEstatico.text).not.toContain('Obra Única XYZ');
  });

  it('el bloque cacheable es BYTE-IDÉNTICO entre 2 llamadas que comparten tabsPermitidos, aunque cambien rol y obra', () => {
    const [bloque1] = buildSystemBlocks({ puesto: 'residente', proyectoNombre: 'Obra A', tabsPermitidos: ['avance', 'destajo'] });
    const [bloque2] = buildSystemBlocks({ puesto: 'admin', proyectoNombre: 'Obra Completamente Distinta', tabsPermitidos: ['avance', 'destajo'] });
    expect(bloque1.text).toBe(bloque2.text); // idéntico byte a byte -> mismo cache key en Anthropic
  });

  it('el bloque cacheable SÍ cambia si cambian los módulos permitidos (tabsPermitidos distinto)', () => {
    const [bloqueSoloAvance] = buildSystemBlocks({ puesto: 'residente', proyectoNombre: 'Obra A', tabsPermitidos: ['avance'] });
    const [bloqueTresModulos] = buildSystemBlocks({ puesto: 'residente', proyectoNombre: 'Obra A', tabsPermitidos: ['avance', 'destajo', 'nominas'] });
    expect(bloqueSoloAvance.text).not.toBe(bloqueTresModulos.text);
  });

  it('el bloque cacheable es determinístico entre llamadas con exactamente los mismos tabsPermitidos', () => {
    const [a] = buildSystemBlocks({ puesto: 'residente', proyectoNombre: 'X', tabsPermitidos: ['avance', 'destajo'] });
    const [b] = buildSystemBlocks({ puesto: 'residente', proyectoNombre: 'X', tabsPermitidos: ['avance', 'destajo'] });
    expect(a.text).toBe(b.text);
  });
});
