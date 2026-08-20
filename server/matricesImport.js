'use strict';

// Importador de la hoja "Matrices" del Excel de presupuesto (prompt-
// importador-matrices-implementacion.md, ver diagnóstico previo validado
// contra el archivo real EST_Kaila_Red_Hidraulica_06082026.xlsx — 23
// bloques reales, formato Neodata). Módulo hoja: NO depende de db.js ni de
// server/app.js — recibe todo lo que necesita como parámetros (mismo
// patrón que el resto de módulos de server/, ej. maquinaria.js/lotes.js —
// la orquestación con DB vive en los endpoints de app.js). En particular
// `calcularMatrizNeodata` se recibe inyectada desde app.js (que ya la tiene
// definida y exportada) en vez de requerir './app' — evita una dependencia
// circular (app.js requeriría este módulo para montar sus 2 endpoints
// nuevos) y cumple la Forbidden Action de no tocar esa función.
//
// Dos fases separadas a propósito:
//   1. parseMatricesSheet(sheet): lectura pura fila por fila del Excel —
//      no sabe nada de insumos/conceptos de ninguna obra, solo entiende la
//      estructura del archivo. Nunca falla por datos de negocio, solo por
//      estructura de archivo rota.
//   2. resolverBloques(...): cruza lo parseado contra el catálogo YA
//      CARGADO de insumos/conceptos de la obra (asume que "Actualizar
//      presupuesto"/alta de obra ya corrió — este módulo nunca reparsea la
//      hoja de Insumos, ver Forbidden Actions) y arma exactamente lo que
//      insertarRenglones()/calcularMatrizNeodata() ya esperan.
//
// Limitación conocida y documentada, NO un bug: la hoja real usa 2 formas
// distintas para una cuadrilla de mano de obra — desglosada por oficio
// (resoluble, MO092/MO031 contra insumos) o pre-colapsada en una sola fila
// con el código de la cuadrilla misma (ej. "1A5P"), que NUNCA existe como
// insumo. Decisión confirmada: v1 bloquea con error específico los bloques
// que usan el patrón pre-colapsado (4 de 23 en el archivo real) en vez de
// tocar calcularMatrizNeodata o el schema (Forbidden Actions) — ver mensaje
// ERROR_CUADRILLA_PRECOLAPSADA abajo.

const CATEGORIAS_SECCION = ['MATERIALES', 'MANO DE OBRA', 'EQUIPO Y HERRAMIENTA', 'BASICOS'];
const ERROR_CUADRILLA_PRECOLAPSADA = (codigo, categoria) =>
  `Renglón de "${categoria}" con código "${codigo}" parece ser una cuadrilla pre-agregada en una sola fila ` +
  `(sin desglose por oficio) — este patrón del Excel no está soportado todavía en el importador. ` +
  `Desglosa esa cuadrilla por oficio en el Excel (como en los demás bloques) o pide soporte para este caso.`;

function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function esFilaMerge(vals) {
  // Fila de descripción libre: exceljs reporta el mismo valor en las 8
  // celdas de una fila cuando pertenecen a un merge horizontal completo —
  // un renglón real nunca tiene código === descripción.
  return vals[0] !== '' && vals[0] === vals[1];
}

function esFilaVacia(vals) {
  return vals.every((v) => v === '');
}

function esFilaHeaderCero(vals) {
  // Header de cuadrilla o de básico anidado: precio/operador/cantidad en 0
  // literal (no '*'/'/'), nunca un renglón real.
  return vals[0] !== '' && num(vals[3]) === 0 && vals[4] !== '*' && vals[4] !== '/' && num(vals[5]) === 0;
}

function nuevoBloque() {
  return {
    analisis_no: null, codigo_concepto: null, codigo_analisis: null, unidad: null,
    cantidad_concepto: null, importe_concepto: null,
    rendimiento: null, cuadrilla_nombre: null,
    pct_indirecto: 0, pct_financiamiento: 0, pct_utilidad: 0,
    precio_unitario_excel: null,
    renglones: [], // renglones directos del análisis (categoria + tipo + codigo/cantidad/operador/...)
    basicosLocales: [], // [{ codigo, descripcion, unidad, renglones: [...] }] únicos dentro de ESTE bloque
    parseErrors: [],
  };
}

// Recorre la hoja "Matrices" completa y arma los bloques (uno por
// "Partida:"/"Análisis:"). Máquina de estados validada contra los 23
// bloques reales del archivo de Kaila — ver diagnóstico previo para el
// detalle fila por fila de cada caso (cascada, básicos anidados, cuadrilla,
// factor_pct).
function parseMatricesSheet(sheet) {
  const bloques = [];
  let bloqueActual = null;
  let seccionActiva = null;
  let basicoActivo = null; // { codigo, descripcion, unidad, renglones: [] } mientras se arma un básico anidado
  let empezado = false; // true una vez que vimos la primera "Partida:" — todo lo anterior es encabezado del documento

  function cerrarBloque() {
    if (!bloqueActual) return;
    if (bloqueActual.precio_unitario_excel == null) {
      bloqueActual.parseErrors.push('No se encontró la fila "PRECIO UNITARIO" — el bloque parece incompleto o mal formado.');
    }
    bloques.push(bloqueActual);
  }

  function destinoRenglon() {
    if (seccionActiva === 'BASICOS' && basicoActivo) return basicoActivo.renglones;
    if (bloqueActual) return bloqueActual.renglones;
    return null;
  }

  sheet.eachRow({ includeEmpty: true }, (row) => {
    const vals = [];
    for (let c = 1; c <= 8; c++) {
      const cell = row.getCell(c);
      let v = cell.value;
      if (v && typeof v === 'object' && v.result !== undefined) v = v.result;
      if (v && typeof v === 'object' && v.richText) v = v.richText.map((t) => t.text).join('');
      vals.push(v == null ? '' : String(v).trim());
    }
    const [A, B, C, D, E, F, G] = vals;

    if (!empezado) {
      if (A === 'Partida:') empezado = true;
      else return; // encabezado del documento, ignorar
    }

    if (A === 'Partida:') {
      cerrarBloque();
      bloqueActual = nuevoBloque();
      bloqueActual.codigo_concepto = B || null;
      bloqueActual.analisis_no = num(E);
      seccionActiva = null;
      basicoActivo = null;
      return;
    }
    if (!bloqueActual) return; // fila huérfana antes de la primera Partida (no debería pasar, ya cubierto arriba)

    if (A === 'Análisis:') {
      bloqueActual.codigo_analisis = B || null;
      bloqueActual.unidad = D || null;
      bloqueActual.cantidad_concepto = num(F);
      bloqueActual.importe_concepto = num(G);
      return;
    }
    if (esFilaVacia(vals)) return;
    if (esFilaMerge(vals)) return; // descripción libre del concepto, ya la tenemos vía conceptos.concepto

    if (CATEGORIAS_SECCION.includes(A) && vals.slice(1).every((v) => v === '')) {
      seccionActiva = A;
      if (A === 'BASICOS') basicoActivo = null;
      return;
    }
    if (A === 'SUBTOTAL:') {
      seccionActiva = null;
      return;
    }
    if (A === '' && B === 'Importe:') return; // informativo, calcularMatrizNeodata recalcula
    if (A === '' && B === 'Volumen:') {
      if (!basicoActivo) {
        // Segunda forma real de cerrar MANO DE OBRA vista en el archivo:
        // en vez de "Rendimiento: <unidad>" (divisor), algunas cuadrillas
        // cierran con "Volumen: <valor>" (multiplicador) — matemáticamente
        // el recíproco (verificado en 2 bloques reales: Importe × Volumen =
        // subtotal real del Excel). Se convierte a un rendimiento
        // equivalente (1/volumen) para reusar calcularMatrizNeodata tal
        // cual, sin tocarla — misma fórmula, mismo resultado.
        if (seccionActiva === 'MANO DE OBRA') {
          const volumen = num(F);
          bloqueActual.rendimiento = volumen ? 1 / volumen : null;
          return;
        }
        bloqueActual.parseErrors.push('Fila "Volumen:" sin un básico anidado abierto ni una sección MANO DE OBRA activa — estructura inesperada.');
        return;
      }
      const existente = bloqueActual.basicosLocales.find((b) => b.codigo === basicoActivo.codigo);
      const local = existente || basicoActivo;
      if (!existente) bloqueActual.basicosLocales.push(local);
      bloqueActual.renglones.push({
        categoria: 'BASICOS', tipo: 'basico_ref', codigo: local.codigo, cantidad: num(F),
      });
      basicoActivo = null;
      return;
    }
    if (A === '' && B?.startsWith('Rendimiento:')) {
      bloqueActual.rendimiento = num(F);
      return;
    }
    if (A === '' && B?.startsWith('(CD)')) return; // informativo
    if (A === '' && B === '(CI) INDIRECTOS') { bloqueActual.pct_indirecto = (num(F) || 0) * 100; return; }
    if (A === '' && B === 'SUBTOTAL1') return;
    if (A === '' && B === '(CF) FINANCIAMIENTO') { bloqueActual.pct_financiamiento = (num(F) || 0) * 100; return; }
    if (A === '' && B === 'SUBTOTAL2') return;
    if (A === '' && B === '(CU) UTILIDAD') { bloqueActual.pct_utilidad = (num(F) || 0) * 100; return; }
    if (A === '' && B?.startsWith('PRECIO UNITARIO')) { bloqueActual.precio_unitario_excel = num(G); return; }
    if (A === '' && B?.startsWith('(*')) return; // importe en letra

    // A partir de aquí, cualquier fila con contenido en col A es un renglón real.
    if (esFilaHeaderCero(vals)) {
      if (seccionActiva === 'BASICOS') {
        basicoActivo = { codigo: A, descripcion: B, unidad: C, renglones: [] };
      } else if (seccionActiva === 'MANO DE OBRA') {
        bloqueActual.cuadrilla_nombre = B || null;
      } else {
        bloqueActual.parseErrors.push(`Fila header inesperada fuera de MANO DE OBRA/BASICOS: "${A} | ${B}".`);
      }
      return;
    }

    const destino = destinoRenglon();
    if (!destino) {
      bloqueActual.parseErrors.push(`Renglón "${A}" fuera de cualquier sección conocida — estructura inesperada.`);
      return;
    }
    if (A.startsWith('%')) {
      destino.push({
        categoria: seccionActiva === 'BASICOS' ? null : seccionActiva, tipo: 'factor_pct',
        codigo: A, descripcion: B, cantidad: num(F), operador: E === '/' ? '/' : '*', valorBaseExcel: num(D),
      });
    } else {
      destino.push({
        categoria: seccionActiva === 'BASICOS' ? null : seccionActiva, tipo: 'insumo',
        codigo: A, cantidad: num(F), operador: E === '/' ? '/' : '*',
      });
    }
  });
  cerrarBloque();
  return bloques;
}

// Resuelve un array de renglones "crudos" (del parser) contra los mapas de
// insumos/conceptos YA CARGADOS de la obra. categoriaFija: la sección en la
// que vive el renglón para un análisis normal (MATERIALES/MANO DE
// OBRA/EQUIPO Y HERRAMIENTA); null cuando el renglón viene de dentro de un
// básico (sin sección propia en el Excel — la categoria se infiere de
// insumos.categoria, ver diagnóstico). subtotalesConocidos: {MATERIALES,
// 'MANO DE OBRA'} ya calculados en este mismo análisis/básico, usados solo
// para inferir factor_referencia de un renglón factor_pct (comparación con
// tolerancia contra el valor que el Excel ya trae en col D).
function resolverRenglon(r, { insumosPorCodigo, subtotalesConocidos }) {
  if (r.tipo === 'factor_pct') {
    let factorReferencia = null;
    for (const [cat, valor] of Object.entries(subtotalesConocidos)) {
      if (valor != null && Math.abs(valor - r.valorBaseExcel) < 0.02) { factorReferencia = cat; break; }
    }
    if (!factorReferencia) {
      return { error: `No se pudo determinar a qué categoría aplica el factor "${r.codigo}" (${r.descripcion}) — su base (${r.valorBaseExcel}) no coincide con ningún subtotal ya calculado.` };
    }
    return {
      renglon: {
        categoria: r.categoria || 'EQUIPO Y HERRAMIENTA', tipo: 'factor_pct',
        codigo: r.codigo, descripcion: r.descripcion, cantidad: r.cantidad, operador: r.operador,
        factor_referencia: factorReferencia,
      },
    };
  }
  // tipo === 'insumo'
  const insumo = insumosPorCodigo.get(r.codigo);
  if (!insumo) {
    const pareceCuadrilla = /^\d/.test(r.codigo) && (r.categoria === 'MANO DE OBRA' || r.categoria === null);
    return {
      error: pareceCuadrilla
        ? ERROR_CUADRILLA_PRECOLAPSADA(r.codigo, r.categoria || 'BASICOS')
        : `El código de insumo "${r.codigo}" no existe en el catálogo de insumos de esta obra.`,
    };
  }
  return {
    renglon: {
      categoria: r.categoria || insumo.categoria, tipo: 'insumo',
      insumo_id: insumo.id, cantidad: r.cantidad, operador: r.operador,
      precio_presupuesto: insumo.precio_presupuesto, // solo para el cálculo de preview, no se persiste
    },
  };
}

// Suma auxiliar de MATERIALES/MANO DE OBRA — únicamente para tener con qué
// comparar el valor base de un factor_pct ANTES de correr el cálculo real
// completo (que necesita los renglones ya resueltos). MANO DE OBRA replica
// el mismo criterio que calcularMatrizNeodata: un básico (esBasico=true)
// NUNCA divide entre rendimiento (la división ya viene embebida por fila
// vía operador '/'); un análisis normal SÍ divide una vez el total de la
// categoría entre `rendimiento` — sin rendimiento capturado, no hay con qué
// comparar (null, nunca se asume 1).
function sumaCategoria(renglones, categoria, { esBasico, rendimiento }) {
  const delaCat = renglones.filter((r) => r.categoria === categoria && r.tipo === 'insumo');
  if (!delaCat.length) return null;
  const cruda = delaCat.reduce((s, r) => s + (r.operador === '/' ? r.precio_presupuesto / r.cantidad : r.precio_presupuesto * r.cantidad), 0);
  if (categoria !== 'MANO DE OBRA' || esBasico) return cruda;
  return rendimiento ? cruda / rendimiento : null;
}

// Resuelve un set de renglones "crudos" (de un análisis o de un básico) en
// 2 pasadas: primero los tipo='insumo' (para poder calcular subtotales
// parciales), luego los factor_pct (que los necesitan). Devuelve
// { renglones, errores }.
function resolverSetRenglones(renglonesCrudos, { insumosPorCodigo, esBasico, rendimiento = null }) {
  const renglones = [];
  const errores = [];
  for (const r of renglonesCrudos) {
    if (r.tipo === 'insumo') {
      const res = resolverRenglon(r, { insumosPorCodigo, subtotalesConocidos: {} });
      if (res.error) errores.push(res.error); else renglones.push(res.renglon);
    }
  }
  if (errores.length) return { renglones: [], errores };
  const subtotalesConocidos = {
    MATERIALES: sumaCategoria(renglones, 'MATERIALES', { esBasico, rendimiento }),
    'MANO DE OBRA': sumaCategoria(renglones, 'MANO DE OBRA', { esBasico, rendimiento }),
  };
  for (const r of renglonesCrudos) {
    if (r.tipo === 'factor_pct') {
      const res = resolverRenglon(r, { insumosPorCodigo, subtotalesConocidos });
      if (res.error) errores.push(res.error); else renglones.push(res.renglon);
    }
  }
  return { renglones: errores.length ? [] : renglones, errores };
}

module.exports = {
  parseMatricesSheet,
  resolverSetRenglones,
  CATEGORIAS_SECCION,
};
