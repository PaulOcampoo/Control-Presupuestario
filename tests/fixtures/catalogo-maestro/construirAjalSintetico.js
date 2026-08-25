// Fixtures SINTÉTICOS del formato real "AJAL" (prompt-normalizador-universal-
// ajal.md). Reemplazan los 4 archivos reales de clientes que se usaron para
// el diagnóstico original (nunca se comitearon al repo — son información
// financiera real de obras reales, quedaron solo en la máquina local para
// pruebas manuales). Estos fixtures replican EXACTAMENTE las mismas
// particularidades estructurales encontradas en el diagnóstico contra los
// archivos reales, con datos 100% inventados (nombres de obra, precios,
// cantidades):
//   - Letterhead corporativo en las filas 1-15 (nombre de empresa repetido +
//     bloque Cliente/Obra/Duración/Fecha/Lugar), header real de columnas en
//     la fila 16 — nunca en la fila 1.
//   - Columna de precio unitario con el texto real "P. Unitario", no
//     "Precio Unitario" (el que espera el parser estándar).
//   - Filas jerárquicas de categoría/agrupador (código tipo "DEM1", "DEM11")
//     mezcladas con partidas reales, cada categoría cerrada con una fila
//     "TOTAL <categoría>" (código repetido, sin cantidad/precio, con importe).
//   - Filas de pie de página sin código real (TOTAL DEL PRESUPUESTO MOSTRADO,
//     IVA, importe en letra).
// Mismo patrón que ya usa el resto del repo para datos de prueba
// (tests/catalogo-maestro.test.js: construirXlsxValido() arma el .xlsx con
// ExcelJS en código en vez de shippear un binario) — nada de esto se
// serializa a un .xlsx dentro del repo; cada test que lo necesite escribe el
// buffer a un archivo temporal y lo borra al terminar.

import ExcelJS from 'exceljs';

function agregarLetterhead(sheet, { empresa, cliente, obra }) {
  sheet.addRow([empresa, empresa, empresa, empresa, empresa, '', '']);
  sheet.addRow([empresa, empresa, empresa, empresa, empresa, '', '']);
  sheet.addRow(['Cliente:', cliente, cliente, cliente, cliente, '', '']);
  sheet.addRow(['', cliente, cliente, cliente, cliente, '', '']);
  sheet.addRow(['', cliente, cliente, cliente, cliente, '', '']);
  sheet.addRow(['', '', '', '', 'Duración:', '0 días naturales', '']);
  sheet.addRow(['Obra:', obra, obra, obra, obra, 'Fecha:', '2026-01-01']);
  sheet.addRow(['', obra, obra, obra, obra, '', '']);
  sheet.addRow(['', obra, obra, obra, obra, 'Inicio Obra:', '2026-01-01']);
  sheet.addRow(['', obra, obra, obra, obra, 'Fin Obra:', '2026-12-31']);
  sheet.addRow(['', obra, obra, obra, obra, '', '']);
  sheet.addRow(['Lugar:', 'Ciudad Demo, Estado Demo', '', '', '', '', '']);
  sheet.addRow(['', '', '', '', '', '', '']);
  sheet.addRow(['PRESUPUESTO DE OBRA', '', '', '', '', '', '']);
  sheet.addRow(['', '', '', '', '', '', '']);
  // 15 filas de letterhead -> el header real queda en la fila 16, igual que
  // en los 4 archivos reales de muestra (diagnóstico original).
}

function agregarHeaderPresupuesto(sheet) {
  sheet.addRow(['Código', 'Concepto', 'Unidad', 'Cantidad', 'P. Unitario', 'Importe', '%']);
}

// categoria: { codigo, nombre, hijos?: [categoria...], partidas?: [{codigo,concepto,unidad,cantidad,precio}] }
// Recorre el árbol en post-orden (partidas y sub-categorías antes que la fila TOTAL de la categoría),
// igual que el patrón real observado (EPA -> EPA1 -> EPA11 -> partidas -> TOTAL BASE -> TOTAL ... -> TOTAL EPA).
function agregarCategoria(sheet, categoria) {
  sheet.addRow([categoria.codigo, categoria.nombre, '', '', '', '', '']);
  let importeAcumulado = 0;
  for (const partida of categoria.partidas || []) {
    const importe = partida.cantidad * partida.precio;
    importeAcumulado += importe;
    sheet.addRow([partida.codigo, partida.concepto, partida.unidad, partida.cantidad, partida.precio, importe, '0.01']);
  }
  for (const hija of categoria.hijos || []) {
    importeAcumulado += agregarCategoria(sheet, hija);
  }
  sheet.addRow([categoria.codigo, `TOTAL ${categoria.nombre}`, '', '', '', importeAcumulado, '0.01']);
  return importeAcumulado;
}

function agregarPiePresupuesto(sheet, totalSinIva) {
  const iva = Number((totalSinIva * 0.16).toFixed(2));
  sheet.addRow(['', '', '', '', '', '', '']);
  sheet.addRow(['TOTAL DEL PRESUPUESTO MOSTRADO SIN IVA:', '', '', '', '', totalSinIva, '']);
  sheet.addRow(['IVA 16.00%', '', '', '', '', iva, '']);
  sheet.addRow(['TOTAL DEL PRESUPUESTO MOSTRADO:', '', '', '', '', Number((totalSinIva + iva).toFixed(2)), '']);
  sheet.addRow(['(* CANTIDAD EN LETRA DEMO PESOS 00/100 M.N. *)', '', '', '', '', '', '']);
}

function construirArbolYObtenerConteo(sheet, arbol) {
  agregarCategoria(sheet, arbol);
}

function contarPartidas(categoria) {
  return (categoria.partidas || []).length + (categoria.hijos || []).reduce((s, h) => s + contarPartidas(h), 0);
}

// Fixture 1 -- mirror estructural de "C 715" (obra chica, jerarquía de 2
// niveles, "Directo AJAL"). 3 partidas reales.
export function construirUrbanizacionDemo() {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Directo AJAL');
  agregarLetterhead(sheet, { empresa: 'CONSTRUCTORA DEMO SA DE CV', cliente: 'Cliente Demo Uno', obra: 'Urbanizacion Demo Fase 1' });
  agregarHeaderPresupuesto(sheet);
  const arbol = {
    codigo: 'DEM', nombre: 'URBANIZACION DEMO FASE 1',
    hijos: [
      { codigo: 'DEM1', nombre: 'ETAPA UNO', hijos: [
        { codigo: 'DEM11', nombre: 'PAVIMENTOS', partidas: [
          { codigo: 'DEM.PAV.001', concepto: 'Concreto hidráulico f\'c=250 kg/cm2', unidad: 'M2', cantidad: 200, precio: 350 },
          { codigo: 'DEM.PAV.002', concepto: 'Guarnición de concreto tipo demo', unidad: 'M', cantidad: 150, precio: 180 },
        ] },
      ] },
      { codigo: 'DEM2', nombre: 'ETAPA DOS', hijos: [
        { codigo: 'DEM21', nombre: 'BANQUETAS', partidas: [
          { codigo: 'DEM.BAN.001', concepto: 'Banqueta de concreto acabado escobillado', unidad: 'M2', cantidad: 80, precio: 220 },
        ] },
      ] },
    ],
  };
  agregarCategoria(sheet, arbol);
  agregarPiePresupuesto(sheet, 97000 + 17600);
  return { buffer: () => wb.xlsx.writeBuffer(), conceptosEsperados: contarPartidas(arbol) };
}

// Fixture 2 -- mirror estructural de "EST Kaila Amenidades": DOS hojas de
// presupuesto en el mismo archivo, "Estimacion AJAL" primero y "Directo
// AJAL" después (mismo orden real observado) -- valida que el normalizador
// toma la PRIMERA hoja candidata que encuentra en el workbook, no cualquiera.
// Conteos deliberadamente distintos (5 vs 2) para que el test pueda probar
// cuál de las dos se usó realmente.
export function construirAmenidadesDemo() {
  const wb = new ExcelJS.Workbook();

  const estimacion = wb.addWorksheet('Estimacion AJAL');
  agregarLetterhead(estimacion, { empresa: 'CONSTRUCTORA DEMO SA DE CV', cliente: 'Cliente Demo Dos', obra: 'Amenidades Demo' });
  agregarHeaderPresupuesto(estimacion);
  const arbolEstimacion = {
    codigo: 'AME', nombre: 'AMENIDADES DEMO',
    hijos: [
      { codigo: 'AME1', nombre: 'ALBERCA', hijos: [
        { codigo: 'AME11', nombre: 'OBRA CIVIL', partidas: [
          { codigo: 'AME.ALB.001', concepto: 'Excavación para alberca', unidad: 'M3', cantidad: 50, precio: 900 },
          { codigo: 'AME.ALB.002', concepto: 'Recubrimiento impermeable demo', unidad: 'M2', cantidad: 30, precio: 1200 },
        ] },
      ] },
      { codigo: 'AME2', nombre: 'PALAPA', hijos: [
        { codigo: 'AME21', nombre: 'ESTRUCTURA', partidas: [
          { codigo: 'AME.PAL.001', concepto: 'Estructura de madera tratada', unidad: 'PZA', cantidad: 10, precio: 5000 },
        ] },
        { codigo: 'AME22', nombre: 'ACABADOS', partidas: [
          { codigo: 'AME.PAL.002', concepto: 'Techo de palma sintética demo', unidad: 'M2', cantidad: 40, precio: 650 },
          { codigo: 'AME.PAL.003', concepto: 'Piso rústico decorativo demo', unidad: 'M2', cantidad: 15, precio: 800 },
        ] },
      ] },
    ],
  };
  agregarCategoria(estimacion, arbolEstimacion);
  agregarPiePresupuesto(estimacion, 81000 + 50000 + 38000);

  const directo = wb.addWorksheet('Directo AJAL');
  agregarLetterhead(directo, { empresa: 'CONSTRUCTORA DEMO SA DE CV', cliente: 'Cliente Demo Dos', obra: 'Amenidades Demo (ajustado)' });
  agregarHeaderPresupuesto(directo);
  const arbolDirecto = {
    codigo: 'AME', nombre: 'AMENIDADES DEMO AJUSTADO',
    hijos: [
      { codigo: 'AME1', nombre: 'ALBERCA', partidas: [
        { codigo: 'AME.ALB.901', concepto: 'Partida ajustada uno', unidad: 'PZA', cantidad: 5, precio: 100 },
        { codigo: 'AME.ALB.902', concepto: 'Partida ajustada dos', unidad: 'PZA', cantidad: 8, precio: 250 },
      ] },
    ],
  };
  agregarCategoria(directo, arbolDirecto);
  agregarPiePresupuesto(directo, 500 + 2000);

  return {
    buffer: () => wb.xlsx.writeBuffer(),
    conceptosEsperadosEstimacion: contarPartidas(arbolEstimacion),
    conceptosEsperadosDirecto: contarPartidas(arbolDirecto),
  };
}

// Fixture 3 -- mirror estructural de "C 671 casa club": obra más grande, 3
// categorías raíz, 6 partidas reales, "Directo AJAL".
export function construirCasaClubDemo() {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Directo AJAL');
  agregarLetterhead(sheet, { empresa: 'CONSTRUCTORA DEMO SA DE CV', cliente: 'Cliente Demo Tres', obra: 'Casa Club Demo' });
  agregarHeaderPresupuesto(sheet);
  const arbol = {
    codigo: 'CLU', nombre: 'CASA CLUB DEMO',
    hijos: [
      { codigo: 'CLU1', nombre: 'ALBERCA', partidas: [
        { codigo: 'CLU.ALB.001', concepto: 'Chapoteadero demo', unidad: 'M2', cantidad: 20, precio: 400 },
        { codigo: 'CLU.ALB.002', concepto: 'Equipo de filtrado demo', unidad: 'PZA', cantidad: 10, precio: 900 },
      ] },
      { codigo: 'CLU2', nombre: 'GIMNASIO', partidas: [
        { codigo: 'CLU.GIM.001', concepto: 'Piso deportivo demo', unidad: 'M2', cantidad: 5, precio: 3000 },
        { codigo: 'CLU.GIM.002', concepto: 'Espejos de pared demo', unidad: 'M2', cantidad: 12, precio: 500 },
      ] },
      { codigo: 'CLU3', nombre: 'SALON DE EVENTOS', partidas: [
        { codigo: 'CLU.SAL.001', concepto: 'Piso de madera demo', unidad: 'M2', cantidad: 1, precio: 45000 },
        { codigo: 'CLU.SAL.002', concepto: 'Iluminación decorativa demo', unidad: 'PZA', cantidad: 30, precio: 300 },
      ] },
    ],
  };
  agregarCategoria(sheet, arbol);
  agregarPiePresupuesto(sheet, 17000 + 21000 + 54000);
  return { buffer: () => wb.xlsx.writeBuffer(), conceptosEsperados: contarPartidas(arbol) };
}

// Fixture 4 -- mirror estructural de "C686": nombre de hoja con DOBLE
// ESPACIO ("Directo  AJAL", quirk real confirmado en el diagnóstico), y una
// hoja "Contrato" ANTES en el workbook que no tiene ninguna de las columnas
// esperadas -- valida que el normalizador la salta sin confundirla con la de
// Presupuesto. 4 partidas reales.
export function construirColectorDemo() {
  const wb = new ExcelJS.Workbook();

  const contrato = wb.addWorksheet('Contrato');
  contrato.addRow(['CONTRATO DE OBRA DEMO']);
  contrato.addRow(['Cláusula primera: objeto del contrato (texto de relleno, sin columnas de presupuesto).']);

  const sheet = wb.addWorksheet('Directo  AJAL'); // doble espacio a propósito
  agregarLetterhead(sheet, { empresa: 'CONSTRUCTORA DEMO SA DE CV', cliente: 'Cliente Demo Cuatro', obra: 'Colector Pluvial Demo' });
  agregarHeaderPresupuesto(sheet);
  const arbol = {
    codigo: 'COL', nombre: 'COLECTOR PLUVIAL DEMO',
    hijos: [
      { codigo: 'COL1', nombre: 'TRAMO 1', partidas: [
        { codigo: 'COL.T1.001', concepto: 'Tubería de concreto reforzado demo', unidad: 'M', cantidad: 100, precio: 850 },
        { codigo: 'COL.T1.002', concepto: 'Excavación en material tipo II demo', unidad: 'M3', cantidad: 60, precio: 1200 },
      ] },
      { codigo: 'COL2', nombre: 'TRAMO 2', partidas: [
        { codigo: 'COL.T2.001', concepto: 'Pozo de visita demo', unidad: 'PZA', cantidad: 40, precio: 2000 },
        { codigo: 'COL.T2.002', concepto: 'Registro pluvial demo', unidad: 'PZA', cantidad: 15, precio: 3500 },
      ] },
    ],
  };
  agregarCategoria(sheet, arbol);
  agregarPiePresupuesto(sheet, 157000 + 132500);
  return { buffer: () => wb.xlsx.writeBuffer(), conceptosEsperados: contarPartidas(arbol) };
}

export { agregarLetterhead, agregarHeaderPresupuesto, agregarCategoria, agregarPiePresupuesto, contarPartidas };
