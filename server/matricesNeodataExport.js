'use strict';

// Exportación a Excel del Análisis de Precios Unitarios en formato Neodata
// (prompt-20-matrices-formato-neodata.md, CP6) — deliberadamente separada de
// server/exportHelper.js: sendXlsxExport es 1 hoja = 1 tabla plana con 1 fila
// de encabezado y columnas uniformes, sin celdas combinadas ni múltiples
// bloques por hoja. Este formato real necesita ambas cosas (encabezado de
// documento + un bloque de análisis completo por concepto, con subtotales y
// cascada intercalados), así que usa ExcelJS directo.
//
// Layout: una sola hoja "Matrices", con los análisis en bloques consecutivos
// (mismo criterio que el Excel de referencia real, hoja "Matrices" con varios
// análisis uno debajo del otro) — tanto para exportar 1 matriz como todas las
// de la obra, con la única diferencia de cuántos bloques trae `analisis`.
//
// Estilos (fuente, bordes, alineación, anchos, merges) replicados celda por
// celda contra C_715_PCRNAURBA__Ajustado_Vinte_22072026.xlsx, hoja
// "Matrices", análisis PAV.ADO12208 (prompt de comparación de estilos,
// puntos 1-2). Ver constantes FONT_BASE/borde/alineación abajo — cada una
// documenta la celda de referencia de la que salió.
const ExcelJS = require('exceljs');

const NUM_COLS = 8; // Código | Concepto | Unidad | Precio | Op | Cantidad | Importe | % Incidencia
const CAT_LABELS = { MATERIALES: 'MATERIALES', 'MANO DE OBRA': 'MANO DE OBRA', 'EQUIPO Y HERRAMIENTA': 'EQUIPO Y HERRAMIENTA' };

// Formatos numéricos, tomados literal de la plantilla de referencia (ver CP1).
const FMT = {
  precioRenglon: '[$$]#,##0.00',   // D22
  importeRenglon: '[$$]0.00',      // G22 / subtotales de categoría
  cascada: '"$"#,##0.00',          // G19, G39..G45
  cantidadRenglon: '#,##0.000000', // F22, F31 (rendimiento)
  cantidadTop: '#,##0.0000##',     // F19
  pct: '0.00%',                    // H22, H39
  pctCascada: '0.0000%',           // F40/F42/F44
};

const FONT_NAME = 'Arial';
const FONT_FAMILY = 2;
const THIN = { style: 'thin', color: { indexed: 64 } };
const DOUBLE = { style: 'double', color: { indexed: 64 } };

function font(sheet, cell, { bold = false, italic = false, size = 8 } = {}) {
  cell.font = { bold, italic, size, name: FONT_NAME, family: FONT_FAMILY };
}

function align(cell, opts) {
  cell.alignment = { vertical: 'top', ...opts };
}

function mergeFullRow(sheet, rowNumber) {
  sheet.mergeCells(rowNumber, 1, rowNumber, NUM_COLS);
}

// GRUPO ROFORB / Cliente / Obra / título / ART.45 / Fecha — bloque de
// encabezado del documento. Layout de una sola columna (no replica el
// recuadro de 2 columnas de la referencia con Concurso/Duración/Lugar/
// Inicio-Fin de obra porque esos campos no existen hoy en el modelo de
// datos — fuera de alcance de este ajuste de estilos). Sí replica fuente
// Arial, tamaños reales y el marco de bordes double (A1 top, A1..A6 left,
// A6 bottom) visto en la referencia (A1:F2 top/left double, A13 bottom
// double).
function addDocHeader(sheet, { clienteNombre, obraNombre }) {
  const rows = [];

  const rTitle = sheet.addRow(['GRUPO ROFORB']);
  mergeFullRow(sheet, rTitle.number);
  font(sheet, rTitle.getCell(1), { bold: true, size: 11 });
  align(rTitle.getCell(1), { horizontal: 'center' });
  rows.push(rTitle);

  const rCliente = sheet.addRow([`Cliente: ${clienteNombre || '—'}`]);
  mergeFullRow(sheet, rCliente.number);
  font(sheet, rCliente.getCell(1));
  rows.push(rCliente);

  const rObra = sheet.addRow([`Obra: ${obraNombre || '—'}`]);
  mergeFullRow(sheet, rObra.number);
  font(sheet, rObra.getCell(1));
  rows.push(rObra);

  const rDocTitle = sheet.addRow(['ANALISIS DE PRECIOS UNITARIOS']);
  mergeFullRow(sheet, rDocTitle.number);
  font(sheet, rDocTitle.getCell(1), { bold: true, size: 10 });
  align(rDocTitle.getCell(1), { horizontal: 'center', vertical: 'middle' });
  rows.push(rDocTitle);

  const rArt = sheet.addRow(['ART. 45 A.1 RLOPySRM']);
  mergeFullRow(sheet, rArt.number);
  font(sheet, rArt.getCell(1));
  rows.push(rArt);

  const rFecha = sheet.addRow([`Fecha: ${new Date().toISOString().slice(0, 10)}`]);
  mergeFullRow(sheet, rFecha.number);
  font(sheet, rFecha.getCell(1));
  rows.push(rFecha);

  // marco double: top en la primera fila, left en todas, bottom en la última
  rows[0].getCell(1).border = { ...rows[0].getCell(1).border, top: DOUBLE, left: DOUBLE };
  rows[0].getCell(NUM_COLS).border = { ...rows[0].getCell(NUM_COLS).border, top: DOUBLE, right: DOUBLE };
  for (const r of rows) {
    r.getCell(1).border = { ...r.getCell(1).border, left: DOUBLE };
    r.getCell(NUM_COLS).border = { ...r.getCell(NUM_COLS).border, right: DOUBLE };
  }
  const last = rows[rows.length - 1];
  last.getCell(1).border = { ...last.getCell(1).border, bottom: DOUBLE };
  last.getCell(NUM_COLS).border = { ...last.getCell(NUM_COLS).border, bottom: DOUBLE };

  sheet.addRow([]);
}

// Encabezado de columnas (Código|Concepto|Unidad|P.Unitario|Op.|Cantidad|
// Importe|%) — UNA sola vez para toda la hoja (referencia: fila 17, no se
// repite por análisis; el generador anterior lo repetía en cada bloque).
function addColumnHeaderRow(sheet) {
  const row = sheet.addRow(['CÓDIGO', 'CONCEPTO', 'UNIDAD', 'PRECIO', 'OP', 'CANTIDAD', 'IMPORTE', '% INCIDENCIA']);
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    font(sheet, cell, { bold: true });
    align(cell, { horizontal: 'center', vertical: 'middle' });
    cell.border = {
      top: DOUBLE, bottom: DOUBLE,
      left: colNumber === 1 ? DOUBLE : THIN,
      right: colNumber === NUM_COLS ? DOUBLE : THIN,
    };
  });
}

// Fila de renglón (material/mano de obra/factor %). El caso especial es el
// renglón "cuadrilla" (precio=0 y cantidad=0 dentro de MANO DE OBRA): en la
// referencia (fila 26, "1A1P CUADRILLA No 5...") es un sub-encabezado en
// negritas sin operador "*" ni columnas de importe/%, no un renglón de
// costo real — puramente presentacional, no toca calcularMatrizNeodata.
function addRenglonRow(sheet, { codigo, concepto, unidad, precio, cantidad, importe, pctIncidencia, esCategoriaManoDeObra = false, opOverride }) {
  const esCuadrillaLabel = esCategoriaManoDeObra
    && Number(precio) === 0 && Number(cantidad) === 0 && (importe == null || Number(importe) === 0);
  // opOverride: prompt-matrices-basicos-anidados.md — dentro de un básico el
  // renglón de cuadrilla trae su propio operador ('/'), a diferencia del
  // resto de renglones (siempre '*' hasta hoy). Default '*' preserva el
  // export de toda matriz existente sin cambio.
  const op = esCuadrillaLabel ? 0 : (opOverride || '*');
  const row = sheet.addRow([
    codigo || '', concepto || '', unidad || '', precio, op, cantidad,
    esCuadrillaLabel ? undefined : importe,
    esCuadrillaLabel ? undefined : pctIncidencia,
  ]);

  const fontOpts = { bold: esCuadrillaLabel };
  font(sheet, row.getCell(1), fontOpts);
  font(sheet, row.getCell(2), fontOpts);
  align(row.getCell(2), { horizontal: 'justify', wrapText: true });
  font(sheet, row.getCell(3), fontOpts);
  align(row.getCell(3), { horizontal: 'center' });
  font(sheet, row.getCell(4), fontOpts);
  align(row.getCell(4), { horizontal: 'right' });
  row.getCell(4).numFmt = FMT.precioRenglon;
  font(sheet, row.getCell(5), fontOpts);
  align(row.getCell(5), { horizontal: 'center' });
  if (esCuadrillaLabel) row.getCell(5).numFmt = FMT.precioRenglon;
  font(sheet, row.getCell(6), fontOpts);
  align(row.getCell(6), { horizontal: 'right' });
  row.getCell(6).numFmt = FMT.cantidadRenglon;
  if (!esCuadrillaLabel) {
    font(sheet, row.getCell(7), fontOpts);
    align(row.getCell(7), { horizontal: 'right' });
    row.getCell(7).numFmt = FMT.importeRenglon;
    font(sheet, row.getCell(8), fontOpts);
    align(row.getCell(8), { horizontal: 'right' });
    row.getCell(8).numFmt = FMT.pct;
  }
  return row;
}

// "SUBTOTAL:" | categoría | ... | valor | % — dos celdas separadas (A/B),
// no el string concatenado que usaba la versión anterior (referencia: A24
// "SUBTOTAL:" + B24 "MATERIALES" en celdas distintas).
function addSubtotalCategoriaRow(sheet, categoria, { valor, incidencia }) {
  const row = sheet.addRow(['SUBTOTAL:', categoria, '', '', '', '', valor, incidencia ?? '']);
  font(sheet, row.getCell(1), { bold: true });
  font(sheet, row.getCell(2), { bold: true });
  align(row.getCell(2), { horizontal: 'left' });
  font(sheet, row.getCell(7), { bold: true });
  align(row.getCell(7), { horizontal: 'right' });
  row.getCell(7).border = { top: THIN };
  if (typeof valor === 'number') row.getCell(7).numFmt = FMT.importeRenglon;
  font(sheet, row.getCell(8), { bold: true });
  align(row.getCell(8), { horizontal: 'right' });
  row.getCell(8).border = { top: THIN };
  if (typeof incidencia === 'number') row.getCell(8).numFmt = FMT.pct;
  return row;
}

// Filas con etiqueta en columna B (no A): "Importe:", "Rendimiento: .../JOR"
// y el bloque de cascada CD→PU (referencia: B30, B31, B39..B46 — columna A
// vacía). `pctCol` es el valor de la columna F: en CI/CF/CU es un % (por
// eso `pctColFmt` por defecto es 'pctCascada'); en "Rendimiento:" es una
// cantidad (unidad/JOR), no un %, así que ese call site pasa
// `pctColFmt: 'cantidadRenglon'` (referencia F31 numFmt "#,##0.000000",
// no "0.0000%"). `moneyFmt` también varía: "Importe:"/"Rendimiento:" usan
// el mismo formato que los renglones ([$$]0.00 — ref. G30/G31), la cascada
// CD..PU usa el formato con separador de miles ("$"#,##0.00 — ref. G39).
function addBRow(sheet, label, { bold = false, pctCol, pctColFmt = 'pctCascada', valor, moneyFmt = 'cascada', incidencia, borderTop, borderBottom } = {}) {
  const row = sheet.addRow(['', label, '', '', '', pctCol ?? '', valor, incidencia ?? '']);
  font(sheet, row.getCell(2), { bold });
  if (typeof pctCol === 'number') {
    font(sheet, row.getCell(6), { bold });
    row.getCell(6).numFmt = FMT[pctColFmt];
  }
  font(sheet, row.getCell(7), { bold });
  if (typeof valor === 'number') row.getCell(7).numFmt = FMT[moneyFmt];
  const border = {};
  if (borderTop) border.top = THIN;
  if (borderBottom) border.bottom = THIN;
  if (borderTop || borderBottom) row.getCell(7).border = border;
  if (typeof incidencia === 'number') {
    font(sheet, row.getCell(8), { bold });
    align(row.getCell(8), { horizontal: 'right' });
    row.getCell(8).numFmt = FMT.pct;
  }
  return row;
}

// Encabezado del básico dentro del bloque del padre (referencia: fila 165
// "10401-292  CONCRETO DE F'c=150...  M3  0  0  0" — sin cifra propia, en
// negritas). `renglon` es el renglón tipo='basico_ref' del padre (trae
// codigo/descripcion/unidad ya resueltos desde el básico referenciado).
function addBasicoHeaderRow(sheet, { codigo, descripcion, unidad }) {
  const row = sheet.addRow([codigo || '', descripcion || '', unidad || '', 0, 0, 0]);
  font(sheet, row.getCell(1), { bold: true });
  font(sheet, row.getCell(2), { bold: true });
  align(row.getCell(2), { horizontal: 'justify', wrapText: true });
  font(sheet, row.getCell(3), { bold: true });
  align(row.getCell(3), { horizontal: 'center' });
  return row;
}

// Expande un renglón tipo='basico_ref' igual que el Excel real
// (prompt-matrices-basicos-anidados.md, CP5): encabezado del básico + sus
// renglones internos + "Importe:" (costo directo del básico, sin cascada
// CI/CF/CU propia) + "Volumen:" (cantidad de ESTE uso × ese importe = lo que
// cae en la categoría BASICOS del padre). Nunca imprime "SUBTOTAL:" por
// categoría dentro del bloque — el básico no separa Materiales/Mano de
// Obra/Equipo visualmente (spec punto 2), a diferencia del análisis padre.
// `renglon._basico_detalle` es la resolución completa que deja
// resolverBasico() en server/app.js (categorías con sus renglones ya
// calculados, incluyendo básicos anidados recursivamente si los hay).
function addBasicoExpandido(sheet, renglon) {
  const basico = renglon._basico_detalle;
  if (!basico) return;
  addBasicoHeaderRow(sheet, { codigo: renglon.codigo, descripcion: renglon.descripcion, unidad: renglon.unidad });
  for (const cat of basico.categorias) {
    for (const r of cat.renglones) {
      if (r.tipo === 'basico_ref') {
        addBasicoExpandido(sheet, r); // anidamiento multinivel
      } else if (r.tipo === 'factor_pct') {
        addRenglonRow(sheet, { codigo: r.codigo, concepto: r.descripcion, unidad: '%', precio: r.precio_referencia, cantidad: r.cantidad, importe: r.importe, pctIncidencia: r.pct_incidencia });
      } else {
        addRenglonRow(sheet, { codigo: r.codigo, concepto: r.descripcion, unidad: r.unidad, precio: r.precio_presupuesto, cantidad: r.cantidad, importe: r.importe, pctIncidencia: r.pct_incidencia, opOverride: r.operador });
      }
    }
  }
  addBRow(sheet, 'Importe:', { valor: basico.costo_directo, moneyFmt: 'importeRenglon' });
  // Sin blank row aquí — el separador antes del SUBTOTAL de la categoría
  // BASICOS ya lo pone addAnalisisBlock (referencia: fila 176, una sola
  // línea en blanco entre "Volumen:" y "SUBTOTAL: BASICOS", no dos).
  addBRow(sheet, 'Volumen:', { pctCol: renglon.cantidad, pctColFmt: 'cantidadRenglon', valor: renglon.importe, moneyFmt: 'importeRenglon', incidencia: renglon.pct_incidencia });
}

// Un análisis completo: encabezado (Partida/Análisis No./Cantidad/Importe),
// descripción, renglones por categoría con subtotales, cascada CD→PU e
// importe en letra. `a` = { concepto, matriz } tal como los arma
// matrizToAnalisisData() en server/app.js a partir de getMatrizConRenglones().
function addAnalisisBlock(sheet, a) {
  const { concepto, matriz } = a;

  // Partida: / Análisis No.: — celdas independientes, SIN merge
  // (referencia fila 18: A="Partida:" B=valor C="Análisis No.:" E=valor).
  const rowPartida = sheet.addRow(['Partida:', matriz.partida || '—', 'Análisis No.:', '', matriz.analisis_no ?? '—']);
  rowPartida.eachCell({ includeEmpty: true }, (cell) => font(sheet, cell));

  // Análisis: <codigo> <unidad> Cantidad <n> Importe <n> — también sin
  // merge (referencia fila 19), en negritas.
  const rowAnalisis = sheet.addRow([
    'Análisis:', concepto.codigo || '', '', concepto.unidad || '', '', concepto.cantidad ?? '', concepto.importe ?? '',
  ]);
  font(sheet, rowAnalisis.getCell(1), { bold: true });
  align(rowAnalisis.getCell(1), { vertical: 'middle' });
  font(sheet, rowAnalisis.getCell(2), { bold: true });
  font(sheet, rowAnalisis.getCell(4), { bold: true });
  align(rowAnalisis.getCell(4), { horizontal: 'center' });
  font(sheet, rowAnalisis.getCell(6), { bold: true });
  rowAnalisis.getCell(6).numFmt = FMT.cantidadTop;
  font(sheet, rowAnalisis.getCell(7), { bold: true });
  align(rowAnalisis.getCell(7), { horizontal: 'right' });
  rowAnalisis.getCell(7).numFmt = FMT.cascada;

  // Descripción larga — única fila combinada del bloque (referencia A20:H20).
  const rowDesc = sheet.addRow([concepto.concepto || '']);
  mergeFullRow(sheet, rowDesc.number);
  font(sheet, rowDesc.getCell(1));
  align(rowDesc.getCell(1), { horizontal: 'justify', wrapText: true });

  sheet.addRow([]);

  matriz.categorias.forEach((cat) => {
    // BASICOS es opcional (prompt-matrices-basicos-anidados.md): a
    // diferencia de MATERIALES/MANO DE OBRA/EQUIPO (siempre se muestran,
    // aunque sea como "No disponible" cuando están vacías), la plantilla
    // real de Neodata no tiene un bloque "BASICOS" en un análisis que no usa
    // ningún básico — se omite el bloque entero (sin encabezado, sin
    // SUBTOTAL) para no ensuciar el 99% de análisis que no los usan.
    if (cat.categoria === 'BASICOS' && !cat.renglones.length) return;

    const rowCat = sheet.addRow([CAT_LABELS[cat.categoria] || cat.categoria]);
    font(sheet, rowCat.getCell(1), { bold: true });
    align(rowCat.getCell(1), { horizontal: 'left' });

    if (!cat.renglones.length) {
      addSubtotalCategoriaRow(sheet, cat.categoria, { valor: 'No disponible' });
      sheet.addRow([]);
      return;
    }

    const esCategoriaManoDeObra = cat.categoria === 'MANO DE OBRA';
    const esCategoriaBasicos = cat.categoria === 'BASICOS';
    for (const r of cat.renglones) {
      if (esCategoriaBasicos) {
        // basico_ref: expandido igual que el Excel real (encabezado del
        // básico + sus renglones internos + Importe:/Volumen:), no un
        // renglón plano.
        addBasicoExpandido(sheet, r);
      } else if (r.tipo === 'factor_pct') {
        addRenglonRow(sheet, {
          codigo: r.codigo, concepto: r.descripcion, unidad: '%',
          precio: r.precio_referencia, cantidad: r.cantidad, importe: r.importe, pctIncidencia: r.pct_incidencia,
          esCategoriaManoDeObra,
        });
      } else {
        addRenglonRow(sheet, {
          codigo: r.codigo, concepto: r.descripcion, unidad: r.unidad,
          precio: r.precio_presupuesto, cantidad: r.cantidad, importe: r.importe, pctIncidencia: r.pct_incidencia,
          esCategoriaManoDeObra,
        });
      }
    }

    if (cat.categoria === 'MANO DE OBRA' && cat.importe_jornada != null) {
      addBRow(sheet, 'Importe:', { valor: cat.importe_jornada, moneyFmt: 'importeRenglon' });
      addBRow(sheet, `Rendimiento: ${concepto.unidad || ''}/JOR`, {
        pctCol: matriz.rendimiento, pctColFmt: 'cantidadRenglon', valor: cat.subtotal, moneyFmt: 'importeRenglon', incidencia: cat.pct_incidencia,
      });
    }

    // blank separator antes del SUBTOTAL (referencia: filas 23/32/37, y
    // 176→177 para BASICOS).
    sheet.addRow([]);
    addSubtotalCategoriaRow(sheet, cat.categoria, {
      valor: cat.subtotal != null ? cat.subtotal : 'No disponible', incidencia: cat.pct_incidencia,
    });
  });

  // prompt-fix-matrices-formato-visual.md: la plantilla Neodata real no tiene
  // un mecanismo de "matriz incompleta" — cuando falta un dato (ej. sin
  // Rendimiento capturado), Excel simplemente deja la celda de resultado en
  // blanco, nunca inserta un párrafo de advertencia que rompe el layout. El
  // motor de cálculo (calcularMatrizNeodata, fuera de alcance de este
  // prompt) sigue devolviendo cd/ci/subtotal1/etc. tratando cada categoría
  // "No disponible" como 0 en la suma — ese número ya viene mal (subestima
  // el costo real) y NO se debe mostrar como si fuera válido. Se conserva la
  // misma estructura de renglones que la plantilla real, con celdas de valor
  // en blanco cuando matriz.completa es false — nunca se fabrica ni se
  // expone el número calculado con el hueco tratado como cero.
  // NOTA: sin fila en blanco antes de (CD) — referencia fila 38→39 directo.
  const val = (v) => (matriz.completa ? v : '');
  addBRow(sheet, '(CD) Costo directo', { bold: true, valor: val(matriz.costo_directo), incidencia: matriz.completa ? 1 : '', borderTop: true });
  addBRow(sheet, '(CI) INDIRECTOS', { pctCol: Number(matriz.pct_indirecto) / 100, valor: val(matriz.ci), borderBottom: true });
  addBRow(sheet, 'SUBTOTAL1', { valor: val(matriz.subtotal1) });
  addBRow(sheet, '(CF) FINANCIAMIENTO', { pctCol: Number(matriz.pct_financiamiento) / 100, valor: val(matriz.cf), borderBottom: true });
  addBRow(sheet, 'SUBTOTAL2', { valor: val(matriz.subtotal2) });
  addBRow(sheet, '(CU) UTILIDAD', { pctCol: Number(matriz.pct_utilidad) / 100, valor: val(matriz.cu), borderBottom: true });
  addBRow(sheet, 'PRECIO UNITARIO   (CD+CI+CF+CU)', { bold: true, valor: val(matriz.precio_unitario_calculado), borderTop: true });

  if (matriz.importe_en_letra) {
    const rowLetra = sheet.addRow(['', matriz.importe_en_letra]);
    font(sheet, rowLetra.getCell(2), { bold: true });
    align(rowLetra.getCell(2), { horizontal: 'left', vertical: 'top' });
  }
}

// analisis: [{ concepto: {codigo, concepto, unidad, cantidad, importe}, matriz: getMatrizConRenglones() }]
function buildWorkbook({ clienteNombre, obraNombre, analisis }) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Matrices', { views: [{ showGridLines: false }] });
  sheet.columns = [
    { width: 11.66 }, { width: 30.66 }, { width: 6.66 }, { width: 10.66 },
    { width: 6.66 }, { width: 10.66 }, { width: 10.66 }, { width: 6.66 },
  ];
  sheet.properties.defaultRowHeight = 12.75;

  addDocHeader(sheet, { clienteNombre, obraNombre });
  addColumnHeaderRow(sheet); // una sola vez para toda la hoja (ver CP1, punto 11)

  analisis.forEach((a, idx) => {
    addAnalisisBlock(sheet, a);
    if (idx < analisis.length - 1) sheet.addRow([]); // referencia: 1 fila en blanco entre análisis, no 2
  });
  return workbook;
}

async function sendMatricesNeodataExport(res, { filename, clienteNombre, obraNombre, analisis }) {
  const workbook = buildWorkbook({ clienteNombre, obraNombre, analisis });
  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(Buffer.from(buffer));
}

module.exports = { sendMatricesNeodataExport, buildWorkbook };
