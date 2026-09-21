// Unit tests puros para server/exportGeneradorObra.js (prompt-generador-obra-
// export-preview.md). A diferencia de tests/generadores-obra-export.test.js
// (que corre contra HTTP+DB+Blob reales), este archivo no toca red ni base
// de datos — el propio módulo está diseñado para eso (ver su header
// comment). Cubre las 3 funciones puras exportadas con fixtures armados a
// mano: partidaSubpartidaDeConcepto, agruparGeneradorObra y
// extensionDeImagen.
import { describe, it, expect } from 'vitest';
import { partidaSubpartidaDeConcepto, agruparGeneradorObra, extensionDeImagen } from '../server/exportGeneradorObra.js';

describe('partidaSubpartidaDeConcepto', () => {
  it('con ruta_jerarquica de 2+ elementos, toma el penúltimo como partida y el último como subpartida', () => {
    const c = { ruta_jerarquica: ['Obra', 'Cimentación', 'Zapatas'], grupo: 'IgnoradoPorTenerRuta' };
    expect(partidaSubpartidaDeConcepto(c)).toEqual({ partida: 'Cimentación', subpartida: 'Zapatas' });
  });

  it('con ruta_jerarquica de 3+ elementos, sigue tomando solo los últimos dos niveles', () => {
    const c = { ruta_jerarquica: ['Obra', 'Estructura', 'Losas', 'Losa de azotea'] };
    expect(partidaSubpartidaDeConcepto(c)).toEqual({ partida: 'Losas', subpartida: 'Losa de azotea' });
  });

  it('sin ruta_jerarquica, cae a partida="General" y subpartida=c.grupo', () => {
    const c = { grupo: 'Albañilería' };
    expect(partidaSubpartidaDeConcepto(c)).toEqual({ partida: 'General', subpartida: 'Albañilería' });
  });

  it('sin ruta_jerarquica ni grupo, cae a "General"/"General"', () => {
    const c = {};
    expect(partidaSubpartidaDeConcepto(c)).toEqual({ partida: 'General', subpartida: 'General' });
  });

  it('con ruta_jerarquica = [] (array vacío), se trata igual que ausente', () => {
    const c = { ruta_jerarquica: [], grupo: 'Acabados' };
    expect(partidaSubpartidaDeConcepto(c)).toEqual({ partida: 'General', subpartida: 'Acabados' });
  });

  it('con ruta_jerarquica de un solo elemento, no hay penúltimo — partida="General", subpartida=ese único nivel', () => {
    const c = { ruta_jerarquica: ['SoloUnNivel'], grupo: 'IgnoradoPorTenerRuta' };
    expect(partidaSubpartidaDeConcepto(c)).toEqual({ partida: 'General', subpartida: 'SoloUnNivel' });
  });
});

describe('agruparGeneradorObra', () => {
  it('renglones+fotos vacíos producen cero grupos (catálogo sin capturar no debe aparecer)', () => {
    expect(agruparGeneradorObra([], [])).toEqual([]);
    expect(agruparGeneradorObra(undefined, undefined)).toEqual([]);
  });

  it('un renglón cuyo concepto no tiene ruta_jerarquica agrupa bajo "General"', () => {
    const renglones = [{ concepto: 'Trabe', grupo: null, subtotal: 100 }];
    const grupos = agruparGeneradorObra(renglones, []);
    expect(grupos).toHaveLength(1);
    expect(grupos[0]).toMatchObject({ partida: 'General', subpartida: 'General', subtotal: 100 });
    expect(grupos[0].renglones).toHaveLength(1);
    expect(grupos[0].fotos).toHaveLength(0);
  });

  it('varios renglones con la misma partida/subpartida se acumulan en un solo grupo y suman el subtotal', () => {
    const renglones = [
      { ruta_jerarquica: ['Obra', 'Cimentación', 'Zapatas'], subtotal: 50 },
      { ruta_jerarquica: ['Obra', 'Cimentación', 'Zapatas'], subtotal: 30 },
    ];
    const grupos = agruparGeneradorObra(renglones, []);
    expect(grupos).toHaveLength(1);
    expect(grupos[0].subtotal).toBe(80);
    expect(grupos[0].renglones).toHaveLength(2);
  });

  it('una foto sin renglón que la acompañe crea/usa su propio grupo partida/subpartida', () => {
    const renglones = [{ ruta_jerarquica: ['Obra', 'Cimentación', 'Zapatas'], subtotal: 10 }];
    const fotos = [{ partida: 'Acabados', subpartida: 'Pintura', nombre_archivo: 'foto.jpg' }];
    const grupos = agruparGeneradorObra(renglones, fotos);
    expect(grupos).toHaveLength(2);
    const grupoFoto = grupos.find((g) => g.partida === 'Acabados' && g.subpartida === 'Pintura');
    expect(grupoFoto).toBeTruthy();
    expect(grupoFoto.fotos).toHaveLength(1);
    expect(grupoFoto.renglones).toHaveLength(0);
    expect(grupoFoto.subtotal).toBe(0);
  });

  it('una foto sin partida/subpartida propia cae también a "General"/"General"', () => {
    const fotos = [{ nombre_archivo: 'foto.jpg' }];
    const grupos = agruparGeneradorObra([], fotos);
    expect(grupos).toHaveLength(1);
    expect(grupos[0]).toMatchObject({ partida: 'General', subpartida: 'General' });
    expect(grupos[0].fotos).toHaveLength(1);
  });

  it('un renglón y una foto que comparten partida/subpartida terminan en el mismo grupo', () => {
    const renglones = [{ ruta_jerarquica: ['Obra', 'Acabados', 'Pintura'], subtotal: 15 }];
    const fotos = [{ partida: 'Acabados', subpartida: 'Pintura', nombre_archivo: 'evidencia.png' }];
    const grupos = agruparGeneradorObra(renglones, fotos);
    expect(grupos).toHaveLength(1);
    expect(grupos[0].renglones).toHaveLength(1);
    expect(grupos[0].fotos).toHaveLength(1);
  });

  it('conserva el orden de primera aparición de cada grupo', () => {
    const renglones = [
      { ruta_jerarquica: ['Obra', 'B', 'Y'], subtotal: 1 },
      { ruta_jerarquica: ['Obra', 'A', 'X'], subtotal: 2 },
    ];
    const grupos = agruparGeneradorObra(renglones, []);
    expect(grupos.map((g) => `${g.partida}/${g.subpartida}`)).toEqual(['B/Y', 'A/X']);
  });
});

describe('extensionDeImagen', () => {
  it('resuelve jpeg desde el nombre de archivo (.jpg y .jpeg)', () => {
    expect(extensionDeImagen('foto.jpg', undefined)).toBe('jpeg');
    expect(extensionDeImagen('foto.jpeg', undefined)).toBe('jpeg');
    expect(extensionDeImagen('FOTO.JPG', undefined)).toBe('jpeg');
  });

  it('resuelve png desde el nombre de archivo', () => {
    expect(extensionDeImagen('foto.png', undefined)).toBe('png');
  });

  it('resuelve gif desde el nombre de archivo', () => {
    expect(extensionDeImagen('foto.gif', undefined)).toBe('gif');
  });

  it('resuelve webp desde el nombre de archivo', () => {
    expect(extensionDeImagen('foto.webp', undefined)).toBe('webp');
  });

  it('sin extensión reconocible en el nombre, cae al content-type', () => {
    expect(extensionDeImagen('foto-sin-extension', 'image/png')).toBe('png');
    expect(extensionDeImagen(null, 'image/jpeg')).toBe('jpeg');
    expect(extensionDeImagen(undefined, 'image/gif')).toBe('gif');
    expect(extensionDeImagen(undefined, 'image/webp')).toBe('webp');
  });

  it('nombre de archivo tiene prioridad sobre un content-type contradictorio', () => {
    expect(extensionDeImagen('foto.png', 'image/jpeg')).toBe('png');
  });

  it('formato no soportado (ej. bmp) devuelve un valor falsy', () => {
    expect(extensionDeImagen('foto.bmp', 'image/bmp')).toBeFalsy();
    expect(extensionDeImagen(undefined, undefined)).toBeFalsy();
    expect(extensionDeImagen('', '')).toBeFalsy();
  });
});
