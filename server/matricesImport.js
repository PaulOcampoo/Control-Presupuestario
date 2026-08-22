'use strict';

// Importador de la hoja "Matrices" del Excel de presupuesto (prompt-
// importador-matrices-implementacion.md, ver diagnóstico previo validado
// contra el archivo real EST_Kaila_Red_Hidraulica_06082026.xlsx — 23
// bloques reales, formato Neodata). Módulo hoja: NO depende de db.js — la
// orquestación con DB (queries, transacción) vive en los endpoints de
// app.js y, desde prompt-matrices-auto-import-alta-obra.md, también en
// server/ingest.js (alta de obra). calcularMatrizNeodata/MATRIZ_CATEGORIAS
// viven AQUÍ (no en app.js) precisamente para que ingest.js pueda reusarlos
// sin crear un require circular (app.js ya requiere ./ingest) — app.js las
// re-exporta con los mismos nombres de siempre, ningún call site existente
// cambia.
//
// Tres fases separadas a propósito:
//   1. parseMatricesSheet(sheet): lectura pura fila por fila del Excel —
//      no sabe nada de insumos/conceptos de ninguna obra, solo entiende la
//      estructura del archivo. Nunca falla por datos de negocio, solo por
//      estructura de archivo rota.
//   2. resolverBloqueImportacion(...)/resolverSetRenglones(...): cruzan lo
//      parseado contra el catálogo YA CARGADO de insumos/conceptos de la
//      obra (asume que "Actualizar presupuesto"/alta de obra ya corrió, sea
//      en la misma transacción como en ingest.js o antes como en el
//      importador manual — este módulo nunca reparsea la hoja de Insumos).
//   3. calcularMatrizNeodata(...): cascada CD/CI/CF/CU sobre los renglones
//      ya resueltos, sin tocar DB.
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
// prompt-matrices-basicos-anidados.md: 'BASICOS' es una 4a categoría para
// renglones tipo='basico_ref' (un análisis completo reutilizable, ej. una
// receta de concreto, insertado como un renglón más). A diferencia de
// MATERIALES/MANO DE OBRA/EQUIPO (siempre esperadas — null si están vacías
// = matriz incompleta), BASICOS es opcional: la inmensa mayoría de análisis
// reales no usan ningún básico, así que vacía se trata como 0, no como
// matriz incompleta (ver el `vacio` condicional más abajo).
const MATRIZ_CATEGORIAS = CATEGORIAS_SECCION;
// prompt-matrices-basicos-anidados.md, CP2: Number(n.toFixed(2)) redondea mal
// los casos exactos ".xx5" por representación binaria de punto flotante (ej.
// 175.41 × 0.5 = 87.705 matemáticamente, pero (87.705).toFixed(2) da "87.70"
// en vez de "87.71" — Excel/negocio redondean medio hacia arriba). Detectado
// al reproducir el renglón EQREV del básico 10401-292 contra el Excel real
// (fila 172: importe esperado 87.71). Math.round(n*100)/100 no tiene ese
// sesgo para este caso (verificado: 0 diferencias contra el helper viejo en
// 200k valores aleatorios — el bug viejo solo se manifestaba en fronteras
// ".xx5" exactas, no en general).
const r2 = (n) => Math.round(n * 100) / 100;

// prompt-matrices-auto-import-alta-obra.md: movida desde server/app.js (con
// MATRIZ_CATEGORIAS/r2 de arriba) para que ingest.js pueda reusarla sin
// requerir './app' — app.js la re-exporta con el mismo nombre de siempre.
function calcularMatrizNeodata(renglones, opts) {
  const pctIndirecto = Number(opts.pct_indirecto) || 0;
  const pctUtilidad = Number(opts.pct_utilidad) || 0;
  const pctFinanciamiento = Number(opts.pct_financiamiento) || 0;
  const rendimiento = opts.rendimiento != null ? Number(opts.rendimiento) : null;
  // Un básico (es_basico=true) NO divide su categoría MANO DE OBRA entre un
  // `rendimiento` externo — su renglón de cuadrilla ya trae la división
  // embebida por fila vía `operador` ('/', ej. "5218.31 / 12"), a diferencia
  // de una matriz normal (varias filas '*' sumadas y divididas UNA vez entre
  // matriz.rendimiento). Sin este flag, un básico sin rendimiento capturado
  // caería en la rama "incompleta" que es correcta para matrices normales
  // pero rompería el cálculo del básico (prompt-matrices-basicos-anidados.md,
  // CP2 — verificado contra el Excel real).
  const esBasico = !!opts.es_basico;

  const subtotales = {};
  const categorias = MATRIZ_CATEGORIAS.map((cat) => {
    const delaCat = renglones.filter((r) => r.categoria === cat);
    if (!delaCat.length) {
      const vacio = cat === 'BASICOS' ? 0 : null;
      subtotales[cat] = vacio;
      return { categoria: cat, subtotal: vacio, importe_jornada: null, renglones: [] };
    }
    let sumaInsumos = 0;
    let sumaFactores = 0;
    const renglonesCalc = delaCat.map((r) => {
      if (r.tipo === 'factor_pct') {
        const base = subtotales[r.factor_referencia];
        const importe = base != null ? r2(base * Number(r.cantidad)) : null;
        if (importe != null) sumaFactores += importe;
        return { ...r, precio_referencia: base, importe };
      }
      // tipo='insumo' toma el precio del catálogo (precio_presupuesto);
      // tipo='basico_ref' toma el costo directo YA RESUELTO del básico
      // referenciado (ver resolverBasico/resolverRenglonesBasicoRef en
      // server/app.js — se deja en r.precio_basico antes de llegar aquí).
      // Mismo patrón cantidad×precio en ambos casos, solo cambia la fuente
      // del precio. `operador` es la pieza nueva: '/' es el único caso real
      // hoy (cuadrilla pre-agregada dentro de un básico, ej. "5218.31 / 12"
      // — verificado contra el Excel real, prompt-matrices-basicos-anidados.md,
      // CP0). Default '*' preserva el cálculo de todo lo demás sin cambio.
      const precio = r.tipo === 'basico_ref' ? Number(r.precio_basico) : Number(r.precio_presupuesto);
      const importe = r.operador === '/' ? r2(precio / Number(r.cantidad)) : r2(precio * Number(r.cantidad));
      sumaInsumos += importe;
      return { ...r, importe };
    });
    const importeJornada = r2(sumaInsumos + sumaFactores);
    const esManoObra = cat === 'MANO DE OBRA';
    const subtotal = esManoObra && !esBasico
      ? (rendimiento && rendimiento > 0 ? r2(importeJornada / rendimiento) : null)
      : importeJornada;
    subtotales[cat] = subtotal;
    return { categoria: cat, subtotal, importe_jornada: (esManoObra && !esBasico) ? importeJornada : null, renglones: renglonesCalc };
  });

  const completa = categorias.every((c) => c.subtotal != null);
  const cd = r2(categorias.reduce((s, c) => s + (c.subtotal || 0), 0));
  const ci = r2(cd * pctIndirecto / 100);
  const subtotal1 = r2(cd + ci);
  const cf = r2(subtotal1 * pctFinanciamiento / 100);
  const subtotal2 = r2(subtotal1 + cf);
  const cu = r2(subtotal2 * pctUtilidad / 100);
  const precioUnitario = r2(subtotal2 + cu);

  // % de incidencia (informativo): importe ÷ CD, por renglón y por subtotal de categoría.
  const categoriasConIncidencia = categorias.map((c) => ({
    ...c,
    pct_incidencia: (c.subtotal != null && cd > 0) ? Number((c.subtotal / cd).toFixed(6)) : null,
    renglones: c.renglones.map((r) => ({
      ...r,
      pct_incidencia: (r.importe != null && cd > 0) ? Number((r.importe / cd).toFixed(6)) : null,
    })),
  }));

  return {
    categorias: categoriasConIncidencia, completa,
    costo_directo: cd, ci, subtotal1, cf, subtotal2, cu,
    precio_unitario_calculado: precioUnitario,
  };
}

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

// Resuelve un bloque crudo (de parseMatricesSheet) contra los mapas
// codigo->concepto(s)/insumo YA CARGADOS de la obra (misma obra sea nueva o
// existente -- prompt-matrices-auto-import-alta-obra.md reusa esta función
// tal cual desde ingest.js, en vez de duplicar el matching).
function resolverBloqueImportacion(bloque, { conceptosPorCodigo, insumosPorCodigo, conceptoIdsConMatriz }) {
  const base = {
    codigo_analisis: bloque.codigo_analisis, analisis_no: bloque.analisis_no, unidad: bloque.unidad,
    rendimiento: bloque.rendimiento, cuadrilla_nombre: bloque.cuadrilla_nombre,
    precio_unitario_excel: bloque.precio_unitario_excel,
  };
  if (bloque.parseErrors.length) return { ...base, estado: 'error', motivo: bloque.parseErrors.join(' ') };
  if (!bloque.codigo_analisis) return { ...base, estado: 'error', motivo: 'No se pudo leer el código de análisis (fila "Análisis:").' };

  const conceptosCandidatos = conceptosPorCodigo.get(bloque.codigo_analisis);
  if (conceptosCandidatos && conceptosCandidatos.length > 1) {
    return { ...base, estado: 'error', motivo: `El código "${bloque.codigo_analisis}" corresponde a ${conceptosCandidatos.length} conceptos distintos en esta obra (mismo código en más de un capítulo) — no se puede determinar automáticamente a cuál corresponde este bloque, se omite.` };
  }
  const concepto = conceptosCandidatos ? conceptosCandidatos[0] : null;
  if (!concepto) {
    return { ...base, estado: 'error', motivo: `No existe un concepto con código "${bloque.codigo_analisis}" en esta obra — carga primero el presupuesto (Actualizar presupuesto) con este código.` };
  }
  if (conceptoIdsConMatriz.has(concepto.id)) {
    return { ...base, concepto_id: concepto.id, estado: 'omitido', motivo: 'Este concepto ya tiene una matriz de precio unitario — no se sobreescribe automáticamente.' };
  }

  // Básicos locales primero (únicos por código DENTRO de este bloque —
  // decisión confirmada: nunca se enlazan a un concepto real existente
  // aunque el código coincida, y nunca se dedupean entre bloques distintos,
  // solo dentro del mismo). Necesitamos su costo_directo para resolver los
  // renglones basico_ref del análisis padre.
  const basicosResueltos = [];
  for (const b of bloque.basicosLocales) {
    const { renglones, errores } = resolverSetRenglones(b.renglones, { insumosPorCodigo, esBasico: true });
    if (errores.length) return { ...base, concepto_id: concepto.id, estado: 'error', motivo: errores[0] };
    const calculo = calcularMatrizNeodata(renglones, { pct_indirecto: 0, pct_utilidad: 0, pct_financiamiento: 0, rendimiento: null, es_basico: true });
    basicosResueltos.push({ codigo: b.codigo, descripcion: b.descripcion, unidad: b.unidad, renglones, costo_directo: calculo.costo_directo });
  }
  const basicosPorCodigo = new Map(basicosResueltos.map((b) => [b.codigo, b]));

  const renglonesDirectosCrudos = bloque.renglones.filter((r) => r.tipo !== 'basico_ref');
  const { renglones: renglonesDirectos, errores } = resolverSetRenglones(
    renglonesDirectosCrudos, { insumosPorCodigo, esBasico: false, rendimiento: bloque.rendimiento }
  );
  if (errores.length) return { ...base, concepto_id: concepto.id, estado: 'error', motivo: errores[0] };

  const renglonesBasicoRef = bloque.renglones
    .filter((r) => r.tipo === 'basico_ref')
    .map((r) => ({ categoria: 'BASICOS', tipo: 'basico_ref', codigo_basico: r.codigo, cantidad: r.cantidad, precio_basico: basicosPorCodigo.get(r.codigo).costo_directo }));

  const renglonesCompletos = [...renglonesDirectos, ...renglonesBasicoRef];
  const calculo = calcularMatrizNeodata(renglonesCompletos, {
    pct_indirecto: bloque.pct_indirecto, pct_utilidad: bloque.pct_utilidad, pct_financiamiento: bloque.pct_financiamiento,
    rendimiento: bloque.rendimiento, es_basico: false,
  });
  const diff = bloque.precio_unitario_excel != null
    ? Number((calculo.precio_unitario_calculado - bloque.precio_unitario_excel).toFixed(2))
    : null;

  return {
    ...base, concepto_id: concepto.id, estado: 'ok',
    completa: calculo.completa, precio_unitario_calculado: calculo.precio_unitario_calculado, diff_vs_excel: diff,
    n_basicos: basicosResueltos.length, n_renglones: renglonesCompletos.length,
    _persistencia: {
      concepto_id: concepto.id, renglonesDirectos, basicosResueltos, renglonesBasicoRef,
      cuadrilla_nombre: bloque.cuadrilla_nombre, rendimiento: bloque.rendimiento,
      pct_indirecto: bloque.pct_indirecto, pct_utilidad: bloque.pct_utilidad, pct_financiamiento: bloque.pct_financiamiento,
      partida: bloque.codigo_concepto, analisis_no: bloque.analisis_no != null ? String(bloque.analisis_no) : null,
    },
  };
}

// Inserta los renglones YA resueltos de una matriz/básico (matrizId ya debe
// existir). Movida desde server/app.js (mismo motivo que calcularMatrizNeodata)
// para que ingest.js pueda reusarla dentro de la transacción de alta de obra.
async function insertarRenglones(client, matrizId, renglones) {
  let orden = 0;
  for (const r of renglones) {
    await client.query(
      `INSERT INTO matriz_precio_renglones (matriz_id, categoria, tipo, insumo_id, codigo, descripcion, cantidad, operador, factor_referencia, basico_matriz_id, orden)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        matrizId, r.categoria, r.tipo,
        r.tipo === 'insumo' ? Number(r.insumo_id) : null,
        r.tipo === 'factor_pct' ? r.codigo.trim() : null,
        r.tipo === 'factor_pct' ? r.descripcion.trim() : null,
        Number(r.cantidad),
        r.operador === '/' ? '/' : '*',
        r.tipo === 'factor_pct' ? r.factor_referencia : null,
        r.tipo === 'basico_ref' ? Number(r.basico_matriz_id) : null,
        orden++,
      ]
    );
  }
}

module.exports = {
  parseMatricesSheet,
  resolverSetRenglones,
  resolverBloqueImportacion,
  calcularMatrizNeodata,
  insertarRenglones,
  CATEGORIAS_SECCION,
  MATRIZ_CATEGORIAS,
};
