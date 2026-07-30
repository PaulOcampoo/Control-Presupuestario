import { describe, it, expect } from 'vitest';
import { validarClabe, digitoVerificadorClabe, CATALOGO_BANCOS } from '../server/catalogoBancos.js';

// CLABE construida con el algoritmo real (verificado contra el ejemplo
// numérico oficial de Wikipedia: base 03218000011835971 -> dígito 9) para
// no depender de un número real de nadie. Institución 002 = BANAMEX.
const CLABE_VALIDA = '002180000012345671';

describe('digitoVerificadorClabe', () => {
  it('reproduce el ejemplo numérico de referencia (base 03218000011835971 -> 9)', () => {
    expect(digitoVerificadorClabe('03218000011835971')).toBe(9);
  });
});

describe('validarClabe', () => {
  it('CLABE válida: 18 dígitos, clave conocida (002 BANAMEX), verificador correcto', () => {
    const r = validarClabe(CLABE_VALIDA);
    expect(r.valida).toBe(true);
    expect(r.banco).toBe('BANAMEX');
    expect(r.claveInstitucion).toBe('002');
  });

  it('dígito verificador incorrecto: se marca inválida, no autollena banco', () => {
    const clabeMala = CLABE_VALIDA.slice(0, 17) + ((Number(CLABE_VALIDA[17]) + 1) % 10);
    const r = validarClabe(clabeMala);
    expect(r.valida).toBe(false);
    expect(r.motivo).toBe('digito_verificador');
  });

  it('17 dígitos (longitud corta): inválida por formato, no por verificador', () => {
    const r = validarClabe(CLABE_VALIDA.slice(0, 17));
    expect(r.valida).toBe(false);
    expect(r.motivo).toBe('longitud');
  });

  it('19 dígitos (longitud larga): inválida por formato', () => {
    const r = validarClabe(CLABE_VALIDA + '0');
    expect(r.valida).toBe(false);
    expect(r.motivo).toBe('longitud');
  });

  it('clave de banco inexistente (999, no está en el catálogo real de Banxico): inválida', () => {
    const base17 = '999' + CLABE_VALIDA.slice(3, 17);
    const check = digitoVerificadorClabe(base17);
    const r = validarClabe(base17 + check);
    expect(r.valida).toBe(false);
    expect(r.motivo).toBe('clave_desconocida');
  });

  it('formato no numérico: inválida por formato', () => {
    const r = validarClabe('00218000001234567X');
    expect(r.valida).toBe(false);
    expect(r.motivo).toBe('longitud');
  });

  it('catálogo tiene un número de instituciones consistente con la fuente citada (94, Banxico CEP-SCL 2026-07-30)', () => {
    expect(Object.keys(CATALOGO_BANCOS).length).toBe(94);
  });
});
