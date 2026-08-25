// prompt-normalizador-universal-ajal.md: normalizador AJAL para la hoja de
// Presupuesto (Directo AJAL / Estimacion AJAL). Pruebas puras sobre ExcelJS
// en memoria para los casos sintéticos, más los fixtures sintéticos de
// tests/fixtures/catalogo-maestro/construirAjalSintetico.js (que replican
// las particularidades estructurales encontradas en el diagnóstico original
// contra 4 archivos reales de clientes -- esos archivos NUNCA se comitearon
// al repo, solo se usaron en la máquina local para el diagnóstico; estos
// fixtures son 100% datos inventados).
import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import ExcelJS from 'exceljs';
import {
  esHojaPresupuestoAjal,
  localizarFilaHeaderPresupuesto,
  leerPresupuestoAjal,
  esPartidaReal,
  normalizarArchivoAjal,
} from '../server/normalizadorAjal.js';
import { parseArchivoConFallbackAjal } from '../server/catalogoMaestro.js';
import {
  construirUrbanizacionDemo,
  construirAmenidadesDemo,
  construirCasaClubDemo,
  construirColectorDemo,
} from './fixtures/catalogo-maestro/construirAjalSintetico.js';

// Escribe un buffer de workbook a un archivo temporal fuera del repo (mismo
// os.tmpdir() que ya usa server/app.js para archivos subidos) y lo borra al
// terminar -- ningún fixture sintético queda serializado como binario en el repo.
async function conArchivoTemporal(buffer, fn) {
  const tmpPath = path.join(os.tmpdir(), `normalizador-ajal-test-${Date.now()}-${Math.round(Math.random() * 1e9)}.xlsx`);
  fs.writeFileSync(tmpPath, buffer);
  try {
    return await fn(tmpPath);
  } finally {
    fs.unlinkSync(tmpPath);
  }
}

describe('esHojaPresupuestoAjal (candidatos de nombre de hoja)', () => {
  it('reconoce "Directo AJAL" exacto', () => {
    expect(esHojaPresupuestoAjal('Directo AJAL')).toBe(true);
  });

  it('reconoce "Directo  AJAL" con doble espacio (caso real confirmado en diagnóstico)', () => {
    expect(esHojaPresupuestoAjal('Directo  AJAL')).toBe(true);
  });

  it('reconoce "Estimacion AJAL" y "Estimación AJAL" (con/sin acento)', () => {
    expect(esHojaPresupuestoAjal('Estimacion AJAL')).toBe(true);
    expect(esHojaPresupuestoAjal('Estimación AJAL')).toBe(true);
  });

  it('es insensible a mayúsculas/espacios', () => {
    expect(esHojaPresupuestoAjal('  directo ajal  ')).toBe(true);
  });

  it('sigue reconociendo el nombre literal "Presupuesto" (no rompe backward compat conceptual)', () => {
    expect(esHojaPresupuestoAjal('Presupuesto')).toBe(true);
  });

  it('NO reconoce hojas no relacionadas (sin matching difuso)', () => {
    expect(esHojaPresupuestoAjal('Destajos')).toBe(false);
    expect(esHojaPresupuestoAjal('Matrices')).toBe(false);
    expect(esHojaPresupuestoAjal('Contrato')).toBe(false);
    expect(esHojaPresupuestoAjal('Insumos')).toBe(false);
  });
});

describe('esPartidaReal (clasificador categoría-vs-partida)', () => {
  it('cantidad y precio_unitario ambos presentes y != 0 -> partida real', () => {
    expect(esPartidaReal(10, 100)).toBe(true);
  });

  it('cantidad 0 -> no es partida (categoría/total)', () => {
    expect(esPartidaReal(0, 100)).toBe(false);
  });

  it('precio_unitario 0 -> no es partida', () => {
    expect(esPartidaReal(10, 0)).toBe(false);
  });

  it('cantidad null (celda vacía) -> no es partida', () => {
    expect(esPartidaReal(null, 100)).toBe(false);
  });

  it('precio_unitario null -> no es partida', () => {
    expect(esPartidaReal(10, null)).toBe(false);
  });

  it('ambos null (fila de categoría típica, ej. "EPA1") -> no es partida', () => {
    expect(esPartidaReal(null, null)).toBe(false);
  });
});

function construirSheetConLetterhead(filasExtra = []) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Directo AJAL');
  for (let i = 0; i < 15; i++) sheet.addRow(['GRUPO DEMO', 'GRUPO DEMO', 'GRUPO DEMO']);
  sheet.addRow(['Código', 'Concepto', 'Unidad', 'Cantidad', 'P. Unitario', 'Importe', '%']);
  for (const f of filasExtra) sheet.addRow(f);
  return sheet;
}

describe('localizarFilaHeaderPresupuesto (localizador de header por contenido)', () => {
  it('encuentra el header en la fila 16 cuando las 1-15 son letterhead corporativo', () => {
    const sheet = construirSheetConLetterhead();
    const { fila } = localizarFilaHeaderPresupuesto(sheet);
    expect(fila).toBe(16);
  });

  it('reconoce el sinónimo "P. Unitario" (no exige "Precio Unitario" literal)', () => {
    const sheet = construirSheetConLetterhead();
    const { indicePorClave } = localizarFilaHeaderPresupuesto(sheet);
    expect(indicePorClave.precio_unitario).toBe(5);
  });

  it('lanza si ninguna fila tiene las 4 columnas requeridas (formato desconocido)', () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Directo AJAL');
    sheet.addRow(['GRUPO DEMO', 'GRUPO DEMO']);
    sheet.addRow(['Cliente:', 'Algo']);
    expect(() => localizarFilaHeaderPresupuesto(sheet)).toThrow(/No se encontró una fila de encabezados/);
  });

  it('lanza ante ambigüedad real: dos filas con el mismo score máximo (edge case de Fase 4)', () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Directo AJAL');
    sheet.addRow(['Código', 'Concepto', 'Unidad', 'Cantidad', 'P. Unitario']);
    sheet.addRow(['A1', 'concepto de prueba', 'M2', 1, 100]);
    sheet.addRow(['Código', 'Concepto', 'Unidad', 'Cantidad', 'P. Unitario']); // segunda fila idéntica de headers -> ambigua
    expect(() => localizarFilaHeaderPresupuesto(sheet)).toThrow(/[Aa]mbigüedad/);
  });
});

describe('leerPresupuestoAjal (extracción de conceptos, edge cases sintéticos)', () => {
  it('excluye filas de categoría (cantidad/precio vacíos) y de pie de página', () => {
    const sheet = construirSheetConLetterhead([
      ['EPA', 'GRUPO RAIZ', '', '', '', '', ''],
      ['EPA1', 'SUBGRUPO', '', '', '', '', ''],
      ['COD001', 'Partida real uno', 'M2', 10, 100, 1000, '0.5'],
      ['EPA1', 'TOTAL SUBGRUPO', '', '', '', 1000, '0.5'],
      ['TOTAL DEL PRESUPUESTO MOSTRADO SIN IVA:', '', '', '', '', 1000, ''],
    ]);
    const conceptos = leerPresupuestoAjal(sheet);
    expect(conceptos).toEqual([
      { codigo: 'COD001', concepto: 'Partida real uno', unidad: 'M2', cantidad: 10, precio_unitario: 100, importe: 1000, orden: 1 },
    ]);
  });

  it('calcula importe como cantidad × precio_unitario, no lee la columna Importe del archivo', () => {
    const sheet = construirSheetConLetterhead([
      ['COD001', 'Partida con importe distinto en el archivo', 'M2', 10, 100, 999999, ''], // Importe "mentiroso" en el archivo
    ]);
    const conceptos = leerPresupuestoAjal(sheet);
    expect(conceptos[0].importe).toBe(1000); // 10 * 100, no 999999
  });

  it('lanza si el header se encuentra pero 0 filas califican como partida real (Fase 4)', () => {
    const sheet = construirSheetConLetterhead([
      ['EPA', 'SOLO CATEGORIAS', '', '', '', '', ''],
    ]);
    expect(() => leerPresupuestoAjal(sheet)).toThrow(/0 partidas reales/);
  });
});

describe('normalizarArchivoAjal contra fixtures sintéticos (mismas particularidades estructurales del diagnóstico real)', () => {
  it('urbanización demo ("Directo AJAL", jerarquía de 2 niveles): detecta 3 partidas reales', async () => {
    const fixture = construirUrbanizacionDemo();
    await conArchivoTemporal(await fixture.buffer(), async (tmpPath) => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(tmpPath);
      const nombresHoja = wb.worksheets.map((s) => s.name);
      const parsed = await normalizarArchivoAjal(tmpPath, nombresHoja);
      expect(parsed.conceptos.length).toBe(fixture.conceptosEsperados);
      expect(parsed.conceptos.length).toBe(3);
      expect(parsed.destajo).toEqual([]);
      expect(parsed.insumos).toEqual([]);
      expect(parsed.matrices).toEqual([]);
      for (const c of parsed.conceptos) {
        expect(c.cantidad).toBeGreaterThan(0);
        expect(c.precio_unitario).toBeGreaterThan(0);
      }
    });
  });

  it('amenidades demo (DOS hojas de presupuesto en el mismo archivo): usa la PRIMERA hoja candidata ("Estimacion AJAL"), no "Directo AJAL"', async () => {
    const fixture = construirAmenidadesDemo();
    await conArchivoTemporal(await fixture.buffer(), async (tmpPath) => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(tmpPath);
      const nombresHoja = wb.worksheets.map((s) => s.name);
      expect(nombresHoja).toEqual(['Estimacion AJAL', 'Directo AJAL']);
      const parsed = await normalizarArchivoAjal(tmpPath, nombresHoja);
      // Si esto diera 2 (conceptosEsperadosDirecto) en vez de 5, el
      // normalizador estaría tomando la hoja equivocada.
      expect(parsed.conceptos.length).toBe(fixture.conceptosEsperadosEstimacion);
      expect(parsed.conceptos.length).toBe(5);
      expect(parsed.conceptos.length).not.toBe(fixture.conceptosEsperadosDirecto);
    });
  });

  it('casa club demo ("Directo AJAL", 3 categorías raíz): detecta 6 partidas reales', async () => {
    const fixture = construirCasaClubDemo();
    await conArchivoTemporal(await fixture.buffer(), async (tmpPath) => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(tmpPath);
      const parsed = await normalizarArchivoAjal(tmpPath, wb.worksheets.map((s) => s.name));
      expect(parsed.conceptos.length).toBe(fixture.conceptosEsperados);
      expect(parsed.conceptos.length).toBe(6);
    });
  });

  it('colector demo (hoja "Directo  AJAL" con doble espacio, precedida de hoja "Contrato" sin columnas de presupuesto): detecta 4 partidas reales', async () => {
    const fixture = construirColectorDemo();
    await conArchivoTemporal(await fixture.buffer(), async (tmpPath) => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(tmpPath);
      const nombresHoja = wb.worksheets.map((s) => s.name);
      expect(nombresHoja).toEqual(['Contrato', 'Directo  AJAL']);
      const parsed = await normalizarArchivoAjal(tmpPath, nombresHoja);
      expect(parsed.conceptos.length).toBe(fixture.conceptosEsperados);
      expect(parsed.conceptos.length).toBe(4);
    });
  });

  it('lanza un error con los nombres de hoja reales cuando no hay ninguna hoja de Presupuesto reconocible', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Hoja Rara Sin Relacion');
    await conArchivoTemporal(await wb.xlsx.writeBuffer(), async (tmpPath) => {
      await expect(normalizarArchivoAjal(tmpPath, ['Hoja Rara Sin Relacion'])).rejects.toThrow(/Hoja Rara Sin Relacion/);
    });
  });
});

describe('parseArchivoConFallbackAjal (regresión: formato estándar no debe pasar por el normalizador AJAL)', () => {
  it('un archivo con hoja "Presupuesto" estándar en fila 1 se parsea igual que siempre, formatoDetectado="estandar"', async () => {
    const wb = new ExcelJS.Workbook();
    const presupuesto = wb.addWorksheet('Presupuesto');
    presupuesto.addRow(['Código', 'Concepto', 'Unidad', 'Cantidad', 'Precio Unitario']);
    presupuesto.addRow(['QA001', 'Concepto estándar de regresión', 'M2', 5, 200]);
    await conArchivoTemporal(await wb.xlsx.writeBuffer(), async (tmpPath) => {
      const { parsed, formatoDetectado } = await parseArchivoConFallbackAjal(tmpPath);
      expect(formatoDetectado).toBe('estandar');
      expect(parsed.conceptos).toEqual([
        { codigo: 'QA001', concepto: 'Concepto estándar de regresión', unidad: 'M2', cantidad: 5, precio_unitario: 200, importe: 1000, orden: 1 },
      ]);
    });
  });

  it('un archivo AJAL (fixture sintético) usa el fallback y devuelve formatoDetectado="ajal"', async () => {
    const fixture = construirUrbanizacionDemo();
    await conArchivoTemporal(await fixture.buffer(), async (tmpPath) => {
      const { parsed, formatoDetectado } = await parseArchivoConFallbackAjal(tmpPath);
      expect(formatoDetectado).toBe('ajal');
      expect(parsed.conceptos.length).toBe(3);
    });
  });

  it('un error de parser estándar NO relacionado con el nombre de hoja (ej. archivo vacío/corrupto) se propaga tal cual, sin intentar el fallback AJAL', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Presupuesto'); // hoja "Presupuesto" existe pero sin ninguna fila de datos
    await conArchivoTemporal(await wb.xlsx.writeBuffer(), async (tmpPath) => {
      // parseArchivo4Hojas lanza el MISMO mensaje ("no tiene una hoja Presupuesto
      // con al menos 1 concepto") tanto si la hoja no existe como si existe
      // pero no tiene filas -- en ambos casos es correcto intentar el fallback
      // AJAL (no hay forma de distinguir "hoja ausente" de "hoja vacía" desde
      // ese mensaje, y en este caso tampoco hay hoja AJAL reconocible).
      await expect(parseArchivoConFallbackAjal(tmpPath)).rejects.toThrow(/Presupuesto/);
    });
  });
});
