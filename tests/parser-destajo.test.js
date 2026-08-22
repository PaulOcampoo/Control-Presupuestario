import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { parseDestajistas, parseDestajoPrecios } from '../server/parser.js';

// Reproduce la hoja " Destajos" real de EST Kaila Red Hidraulica 06082026.xlsx:
// headers "Código | Concepto | Unidad | Cantidad | Pu Mano de Obra | Importe Mano
// de Obra", sin columna de destajista (desglose de Mano de Obra por concepto,
// no asignación por subcontratista) -- ver prompt-diagnostico-fuga-datos-
// importadores.md y prompt-fix-destajo-parser.md.
function workbookConHojaDestajosReal() {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(' Destajos');
  sheet.addRow(['Código', 'Concepto', 'Unidad', 'Cantidad', 'Pu Mano de Obra', 'Importe Mano de Obra']);
  sheet.addRow(['AJAL.KAI.TRAL', 'Trazo y nivelacion', 'M', 150, 9.09, 1363.5]);
  sheet.addRow(['AJAL.KAI.EXC01', 'Excavacion con maquinaria', 'M3', 8, 741.07, 5928.56]);
  return wb;
}

describe('parseDestajistas — hoja Destajos sin columna de destajista (formato real Kaila)', () => {
  it('agrupa todas las filas bajo un destajista generico "Mano de Obra General" en vez de descartarlas', () => {
    const destajistas = parseDestajistas(workbookConHojaDestajosReal());
    expect(destajistas).toHaveLength(1);
    expect(destajistas[0].nombre).toBe('Mano de Obra General');
    expect(destajistas[0].items).toHaveLength(2);
  });

  it('reconoce "Pu Mano de Obra" como columna de precio_destajo (no queda en 0)', () => {
    const destajistas = parseDestajistas(workbookConHojaDestajosReal());
    const [item1, item2] = destajistas[0].items;
    expect(item1.codigo).toBe('AJAL.KAI.TRAL');
    expect(item1.precio_destajo).toBe(9.09);
    expect(item2.codigo).toBe('AJAL.KAI.EXC01');
    expect(item2.precio_destajo).toBe(741.07);
  });
});

describe('parseDestajoPrecios — mismo formato, lookup plano por codigo', () => {
  it('devuelve el precio por codigo usando la columna "Pu Mano de Obra"', () => {
    const precios = parseDestajoPrecios(workbookConHojaDestajosReal());
    expect(precios['AJAL.KAI.TRAL']).toBe(9.09);
    expect(precios['AJAL.KAI.EXC01']).toBe(741.07);
  });
});
