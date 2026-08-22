import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ExcelJS from 'exceljs';
import { parseWorkbook } from '../server/parser.js';

// Réplica minimal de la hoja "Matrices" real (formato Neodata APU) — un solo
// bloque MATERIALES, suficiente para confirmar que parseWorkbook expone
// matricesBloques usando matricesImport.parseMatricesSheet, sin reimplementar
// el parseo (ver prompt-matrices-auto-import-alta-obra.md).
function filaMatricesReales() {
  return [
    ['Partida:', 'EPD1', 'Análisis No.:', null, 10, null, null, null],
    ['Análisis:', 'AJAL.KAI.TRAL', null, 'M', null, 150, 1533, null],
    ['Código', 'Concepto', 'Unidad', 'P. Unitario', 'Op.', 'Cantidad', 'Importe', '%'],
    ['MATERIALES', null, null, null, null, null, null, null],
    ['302-CAL-0102', 'CALHIDRA, TONELADA', 'TON', 4051.29, '*', 0.000252, 1.02, 0.11],
    ['SUBTOTAL:', 'MATERIALES', null, null, null, null, 1.02, 0.11],
    ['', 'Rendimiento: M/JOR', '', '', '', 571.7, '', ''],
    ['', '(CI) INDIRECTOS', '', '', '', 0.10, '', ''],
    ['', '(CF) FINANCIAMIENTO', '', '', '', 0.02, '', ''],
    ['', '(CU) UTILIDAD', '', '', '', 0.08, '', ''],
    ['', 'PRECIO UNITARIO', '', '', '', '', 9.09, ''],
  ];
}

let tmpPath;
afterEach(() => { if (tmpPath) fs.rmSync(tmpPath, { force: true }); });

async function crearWorkbookConHojas({ conMatrices }) {
  const wb = new ExcelJS.Workbook();
  const presupuesto = wb.addWorksheet('Directo');
  presupuesto.addRow(['Código', 'Concepto', 'Unidad', 'Cantidad', 'P. Unitario', 'Importe']);
  presupuesto.addRow(['AJAL.KAI.TRAL', 'Trazo y nivelacion', 'M', 150, 9.09, 1363.5]);
  if (conMatrices) {
    const matrices = wb.addWorksheet('Matrices');
    for (const row of filaMatricesReales()) matrices.addRow(row);
  }
  tmpPath = path.join(os.tmpdir(), `parser-matrices-test-${Date.now()}.xlsx`);
  await wb.xlsx.writeFile(tmpPath);
  return tmpPath;
}

describe('parseWorkbook — hoja "Matrices"', () => {
  it('expone matricesBloques con un bloque por "Partida:" cuando la hoja existe', async () => {
    const file = await crearWorkbookConHojas({ conMatrices: true });
    const parsed = await parseWorkbook(file);
    expect(parsed.matricesBloques).toHaveLength(1);
    expect(parsed.matricesBloques[0].codigo_analisis).toBe('AJAL.KAI.TRAL');
    expect(parsed.matricesBloques[0].precio_unitario_excel).toBe(9.09);
  });

  it('devuelve matricesBloques vacío cuando no hay hoja "Matrices"', async () => {
    const file = await crearWorkbookConHojas({ conMatrices: false });
    const parsed = await parseWorkbook(file);
    expect(parsed.matricesBloques).toEqual([]);
  });
});
