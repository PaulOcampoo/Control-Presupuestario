# Catálogo Maestro y Matrices de Destajo

Módulo con 13 PRs mergeados a `main` entre 2026-08-19 y 2026-09-04. Cubre:
un catálogo de conceptos/partidas cruzado entre obras, un catálogo maestro
GLOBAL (independiente de cualquier obra) con carga desde Excel, el
importador de la hoja "Matrices" (Análisis de Precio Unitario formato
Neodata) y varias correcciones/extensiones sobre el parser de
Destajo/Matrices. Varios PRs son pequeños/puntuales (marcados como tal);
#166, #182 y #184 son los de mayor tamaño y se documentan con más detalle.

Convención usada abajo: "obra" = fila de `proyectos`; "concepto" = partida
de presupuesto (`conceptos`); "matriz" = Análisis de Precio Unitario
(`matrices_precio_unitario` + `matriz_precio_renglones`); "destajo" =
`destajistas` + `destajo_items`.

---

## PR #165 — feat(costos): catálogo de Conceptos (partidas) como 3a pestaña en Costos

**Fecha:** 2026-08-19 (commit merge `7ee8fee`).

**Problema que resolvía:** Costos ya tenía un catálogo agregado de
*insumos* (materiales) cruzado entre obras, pero no existía el equivalente
para *conceptos* (partidas reales de obra, ej. "Excavación de cepa") — no
había forma de armar un presupuesto nuevo reusando precios de partidas ya
capturadas en otras obras.

**Diseño:** Nueva tercera pestaña "Catálogo de conceptos" en la sub-nav de
Costos, en paralelo al catálogo de insumos existente. Mismo patrón exacto
(`DISTINCT ON (codigo)` + precio más reciente por `proyectos.creado_en`)
pero sobre la tabla `conceptos`. Dos filtros extra que insumos no necesita
(confirmados con datos reales del proyecto): `es_total = 0` (excluye filas
"TOTAL DEL PRESUPUESTO...") y `precio_unitario > 0` (excluye encabezados de
capítulo y filas de total con datos inconsistentes). Alias en la
`SELECT` (`grupo AS categoria`, `precio_unitario AS precio_presupuesto`,
`cantidad AS cantidad_presupuesto`) para que las filas tengan exactamente
el shape que ya esperan `openCrearPresupuestoModal()` y `costosFilaHtml()`
— se reusan sin tocarlos. El frontend etiqueta esa columna "Grupo/Capítulo"
(no "Categoría"): en conceptos es vocabulario libre por obra, no la
taxonomía cerrada de `insumos.categoria`.

Exclusión explícita por lista de `project_id` (`EXCLUIR_OBRAS_DUPLICADAS_CATALOGO_CONCEPTOS`,
ids `[13, 41, 42]` en este PR): 3 obras del mismo cliente cargadas 3 veces
(mismos códigos, mismo tamaño) que contaminaban el catálogo agregado. No
hay ninguna columna en el schema que distinga "obra duplicada de prueba/
importación repetida" de una obra real — es una lista mantenida a mano.

**Archivos y funciones:**
- `server/app.js`: `conceptosCatalogoQuery(clienteId)`, `conceptosCatalogoExportSheet()`,
  endpoints `GET /api/costos/catalogo-conceptos/:clienteId`, `GET /api/costos/catalogo-conceptos/:clienteId/export`,
  `GET /api/costos/catalogo-conceptos-global`, `GET /api/costos/catalogo-conceptos-global/export`.
- `public/app.js`: `conceptosTablaHtml()`, `showConceptos()` dentro de `renderCostos()`.

**Nota — cambio incidental no relacionado:** el mismo commit también quita
`'gasolina'` de `TIPOS_CONSUMIBLE` (server/app.js), del CHECK constraint de
`consumibles_maquinaria` (server/db.js) y de `CONCEPTO_INSUMO_POR_TIPO_CONSUMIBLE`
(server/maquinaria.js) — revierte un tipo de consumible de maquinaria que
no tiene relación con Catálogo de Conceptos ni aparece mencionado en el
PR body. Parece un artefacto de historia de rama (posible rebase), no una
decisión de diseño de este PR. Se documenta por transparencia pero **no
es parte de la feature** — no portar ese fragmento a la demo sin
investigar aparte si la demo tiene ese mismo tipo de consumible.

**Aplicabilidad a demo:** (b) portar adaptado. La feature en sí (catálogo
de conceptos, mismo patrón que insumos) es portable tal cual si la demo ya
tiene el catálogo de insumos equivalente. La lista `EXCLUIR_OBRAS_DUPLICADAS_CATALOGO_CONCEPTOS`
es específica de datos reales del cliente — en la demo debe ir vacía o
con los ids de prueba que existan ahí. Ignorar el cambio de "gasolina".

**Dependencias:** Ninguna dentro de este módulo (es el primer PR de la
serie cronológicamente). Es el precedente de `openCrearPresupuestoModal()`
que #176/#177 extienden.

---

## PR #166 — feat(matrices): importador de la hoja Matrices desde Excel (formato Neodata)

**Fecha:** 2026-08-19 (commit merge `7a84ce5`).

**Problema que resolvía:** Las matrices de Análisis de Precio Unitario
(APU) solo se podían capturar a mano, renglón por renglón, desde la UI.
Los Excel de presupuesto de referencia (formato "Neodata") ya traen una
hoja "Matrices" con esa información completa (23 bloques reales
verificados en el archivo de referencia usado para el diseño) — hacía
falta un importador que la leyera.

**Diseño — arquitectura base para toda la familia de PRs de matrices
(#179, #180, #213, #215 dependen de este):**

Módulo nuevo `server/matricesImport.js`, deliberadamente **sin dependencia
de `db.js` ni de `server/app.js`** (mismo patrón que otros módulos de
`server/`, ej. `maquinaria.js`) — recibe todo lo que necesita como
parámetros; la orquestación con la base vive en los endpoints de `app.js`.

Tres fases separadas a propósito:
1. **`parseMatricesSheet(sheet)`** — lectura pura fila por fila del Excel,
   máquina de estados que reconoce: filas `"Partida:"`/`"Análisis:"`
   (abren un bloque), secciones `MATERIALES`/`MANO DE OBRA`/`EQUIPO Y
   HERRAMIENTA`/`BASICOS`, renglones normales (`tipo: 'insumo'`), renglones
   de factor porcentual (`tipo: 'factor_pct'`, código empieza con `%`,
   ej. indirectos/utilidad aplicados sobre un subtotal ya calculado),
   básicos anidados (un "básico" es un análisis reutilizable completo,
   ej. una receta de concreto, insertado como un renglón vía `basico_ref`),
   y el cierre `"PRECIO UNITARIO"`. No sabe nada de insumos/conceptos de
   ninguna obra — solo falla por estructura de archivo rota, nunca por
   datos de negocio.
2. **`resolverBloqueImportacion(bloque, ...)` / `resolverSetRenglones(...)`**
   — cruzan lo parseado contra el catálogo YA CARGADO de insumos/conceptos
   de la obra (asume que "Actualizar presupuesto"/alta de obra ya corrió;
   este módulo **nunca** reparsea la hoja de Insumos). Cada bloque queda en
   uno de 3 estados: `'ok'` (se inserta al confirmar), `'omitido'` (el
   concepto ya tiene una matriz — nunca se sobreescribe en silencio), o
   `'error'` (código de insumo no resoluble, factor sin base identificable,
   concepto no encontrado o ambiguo, estructura rota — se salta, nunca se
   inserta parcial).
3. **`calcularMatrizNeodata(renglones, opts)`** (definida en este PR dentro
   de `server/app.js`, movida a `matricesImport.js` en #179) — cascada
   CD (costo directo) → CI (indirectos) → subtotal1 → CF (financiamiento)
   → subtotal2 → CU (utilidad) → precio unitario, redondeando con
   `r2 = (n) => Math.round(n*100)/100` en cada paso (no solo al final) para
   coincidir exacto con el Excel de referencia en casos ".xx5".

Flujo end-to-end: modal "Importar Matrices desde Excel" en la vista de
Matrices de una obra → sube el .xlsx a Vercel Blob → `POST /api/projects/:id/matrices/import/preview`
(nunca escribe, solo devuelve el estado de cada bloque) → usuario revisa →
`POST /api/projects/:id/matrices/import/confirm` (**nunca confía en lo que
mandó el preview** — re-descarga y re-parsea el archivo desde cero, mismo
criterio que "Actualizar presupuesto") → inserta únicamente los bloques
`'ok'` en una transacción, incluyendo los básicos anidados y su
`audit_log` (`accion: 'importar_matrices'`).

Detalle de matching código→concepto: `conceptosPorCodigo` es un
`Map<codigo, array-de-conceptos>` (no 1:1) porque el mismo código puede
repetirse en 2+ capítulos de una obra apuntando a conceptos reales
distintos — en v1 (este PR) eso simplemente bloquea el bloque con error
("no se puede determinar automáticamente"); #213 le agrega desambiguación
por cantidad.

Limitación conocida y documentada explícitamente como NO-bug en este PR:
una cuadrilla de mano de obra pre-agregada en una sola fila (código que
nunca existe como insumo, ej. `"1A5P"`) dispara `ERROR_CUADRILLA_PRECOLAPSADA`
y bloquea el bloque — resuelto en #215.

**Archivos y funciones:** `server/matricesImport.js` (nuevo, 314 líneas:
`parseMatricesSheet`, `resolverSetRenglones`, `CATEGORIAS_SECCION`);
`server/app.js` (`prepararImportacionMatrices`, `resolverBloqueImportacion`,
`resumenImportacionMatrices`, endpoints `POST /api/projects/:id/matrices/import/preview`
y `/confirm`); `public/app.js` (`openImportarMatricesModal`,
`pintarPreviewImportacionMatrices`).

**Aplicabilidad a demo:** (a) portar tal cual si la demo ya tiene el
sistema de Matrices/APU manual (`matrices_precio_unitario` +
`matriz_precio_renglones`) con la misma estructura de categorías. Es
funcionalidad aislada y opcional (no toca el alta de obra en este PR —
eso llega en #179). Requiere un Excel de prueba en formato Neodata con
hoja "Matrices" para verificar.

**Dependencias:** Ninguna hacia atrás en este módulo. Es la base de la que
dependen explícitamente #179, #180, #213 y #215 (todos reusan
`resolverBloqueImportacion`/`calcularMatrizNeodata`/`parseMatricesSheet`).

---

## PR #176 — feat(costos): export/import de 4 hojas (Presupuesto/Destajo/Insumos/Matrices) desde catálogo

**Fecha:** 2026-08-22 (commit merge `b22fa8c`).

**Problema que resolvía:** El modal "Crear presupuesto desde catálogo"
(de #165) solo creaba conceptos (Hoja 1) — un presupuesto armado así nunca
traía destajo, insumos ni matrices, aunque esos datos existieran en la
obra de origen de cada concepto seleccionado.

**Diseño:** El export de ese modal pasa de 1 hoja a 4 hojas
(Presupuesto/Destajo/Insumos/Matrices) cuando el catálogo de origen es el
de Conceptos (trae `concepto_id_origen` — el catálogo de Insumos no lo
tiene y sigue exportando solo Hoja 1). Tres queries nuevas, 100% de
lectura, resuelven "qué había en la obra de origen de este concepto":
`destajoOrigenQuery`, `insumosOrigenQuery` (vía `matriz_precio_renglones`,
no `concepto_insumos` — esa tabla casi no tiene datos reales) y
`matrizOrigenQuery` (cabecera + renglones). Nuevo botón "Importar completo
(4 hojas)" en el mismo modal: sube de vuelta el .xlsx (editado o no) y
crea la obra completa (presupuesto + destajo + insumos + matrices) en una
sola transacción, con preview/confirm y validación cruzada explícita
("todo código en Hojas 2-4 debe existir en Hoja 1", si no se rechaza el
archivo entero). Parser dedicado nuevo (`server/crearPresupuestoImport.js`,
`parseArchivo4Hojas`) que lee por nombre exacto de encabezado — no reusa
`parseWorkbook` (pensado para archivos de obra reales y desordenados) ni
el importador de Matrices de #166 (ninguno soporta crear conceptos/insumos
nuevos desde cero).

**Archivos y funciones:** `server/crearPresupuestoImport.js` (nuevo,
`parseArchivo4Hojas`, `resumenParaPreview`); `server/app.js`
(`destajoOrigenQuery`, `insumosOrigenQuery`, `matrizOrigenQuery`,
`construirHojasDestajoInsumosMatrices`, endpoints
`POST /api/costos/crear-presupuesto/import-completo/preview` y `/confirm`);
`public/app.js` (`abrirImportCompletoModal`, `pintarPreviewImportCompleto`).

**Aplicabilidad a demo:** (b) portar adaptado — depende de #165 (catálogo
de conceptos) ya estar portado. Es una feature grande y autocontenida; el
patrón preview→confirm→transacción-única es reusable tal cual.

**Dependencias:** #165 (extiende `openCrearPresupuestoModal`). Es la base
del importador que #182/#184 (Catálogo Maestro) reusan (`parseArchivo4Hojas`).

---

## PR #177 — feat(costos): advertencia de destajo/matriz faltantes en catálogo

**Fecha:** 2026-08-22 (commit merge `af9f5b4`). PR pequeño/puntual.

**Problema que resolvía:** Con #176, un concepto podía seleccionarse para
un presupuesto nuevo sin que el usuario supiera si su obra de origen tenía
destajo/matriz cargados — si no los tenía, las Hojas 2-4 del export
quedaban silenciosamente incompletas para ese concepto.

**Diseño:** Puramente informativo, nunca bloquea selección ni export.
`conceptosCatalogoQuery` agrega dos columnas `EXISTS` correlacionadas
(`tiene_destajo`, `tiene_matriz`, O(1) por fila, no un JOIN+GROUP BY que
alteraría la cardinalidad del `DISTINCT ON`). El modal muestra un badge
⚠️ por fila y un resumen agregado de la selección actual
("N de M seleccionados... traerán Hojas 2-4 incompletas").

**Archivos:** `server/app.js` (columnas EXISTS en `conceptosCatalogoQuery`);
`public/app.js` (`warnBadgeHtml`, `resumenAdvertenciasSeleccion` dentro de
`openCrearPresupuestoModal`); `public/styles.css` (`.cp-warn-badge`, `.cp-warn-resumen`).

**Aplicabilidad a demo:** (c) no aplica de forma aislada / (b) portar
adaptado solo si ya se portaron #165 y #176 — depende 100% de esa base.

**Dependencias:** #165, #176.

---

## PR #178 — fix(parser): reconoce hoja Destajos sin columna de destajista

**Fecha:** 2026-08-22 (commit merge `dc2f467`).

**Problema que resolvía:** Un Excel real de alta de obra (hoja `" Destajos"`,
con espacio inicial) traía el desglose de mano de obra por concepto sin
ninguna columna de destajista/cuadrilla (headers: Código, Concepto, Unidad,
Cantidad, "Pu Mano de Obra", "Importe Mano de Obra") — el parser
descartaba esas filas en silencio porque no reconocía "PU MANO DE OBRA"
como sinónimo de precio de destajo, y porque `parseDestajistas` esperaba
poder ubicar una columna de destajista.

**Causa raíz:** `DESTAJO_SYNONYMS` (server/parser.js) no incluía "PU MANO
DE OBRA"/variantes; y `parseDestajistas` no tenía ningún camino para una
hoja sin columna de destajista — `currentDest` arrancaba en `null` y las
filas sin un destajista ya vigente (forward-fill) simplemente no producían
resultado.

**Fix:** Se agregan los sinónimos ("PU MANO DE OBRA", "P.U. MANO DE OBRA",
"P.U MANO DE OBRA", "PRECIO MANO DE OBRA", "PRECIO UNITARIO MANO DE
OBRA"). Cuando `colMap.destajista == null` (no se detectó esa columna en
el header), `currentDest` arranca en un nombre genérico constante
(`DESTAJISTA_GENERICO_NOMBRE = 'Mano de Obra General'`) en vez de `null` —
toda la hoja se agrupa bajo ese único destajista sintético (necesario
porque `destajo_items.destajista_id` es `NOT NULL`, hace falta una fila en
`destajistas`). Si la columna de destajista SÍ existe, el forward-fill de
siempre sigue funcionando igual.

```js
// antes
let currentDest = null;
// después
let currentDest = colMap.destajista == null ? DESTAJISTA_GENERICO_NOMBRE : null;
```

**Archivos:** `server/parser.js` (`DESTAJO_SYNONYMS`, `DESTAJISTA_GENERICO_NOMBRE`,
`parseDestajistas`); exporta también `parseDestajistas`/`parseDestajoPrecios`
(antes solo `parseWorkbook`) para poder testearlas directo.
`tests/parser-destajo.test.js` (nuevo).

**Aplicabilidad a demo:** (a) portar tal cual si la demo usa el mismo
`server/parser.js` — es un fix acotado y bien encapsulado, sin riesgo de
romper el camino "con columna de destajista" (rama explícitamente
condicionada).

**Dependencias:** Ninguna dentro de este módulo. Corrige un caso del
parser estándar de alta de obra, no relacionado con #166. Es la causa por
la que #180 tuvo que existir (reprocesar obras cargadas antes de este fix).

---

## PR #179 — feat(costos): auto-importa Matrices de precio unitario en el alta de obra

**Fecha:** 2026-08-22 (commit merge `025de35`). Depende de #166.

**Problema que resolvía:** El importador de Matrices de #166 era un paso
manual y separado, posterior al alta de obra. La hoja "Matrices" del mismo
Excel de alta nunca se leía automáticamente — el usuario tenía que subir
el mismo archivo dos veces (una para el presupuesto, otra para matrices).

**Diseño:** Se integra el importador de #166 directamente en `ingest.js`
(la función que corre dentro de la transacción de alta de obra,
`POST /api/projects`). Para evitar una dependencia circular (`app.js`
requiere `./ingest`, así que `ingest.js` no puede requerir `./app`),
`calcularMatrizNeodata`, `MATRIZ_CATEGORIAS`, `insertarRenglones` y
`resolverBloqueImportacion` se **mueven** de `server/app.js` a
`server/matricesImport.js` (que ya no depende de nada de `app.js`);
`server/app.js` los re-exporta con los mismos nombres (`const { MATRIZ_CATEGORIAS, calcularMatrizNeodata } = matricesImport;`)
para no tocar ningún call site existente. `server/parser.js` gana una hoja
más expuesta cruda (`matricesBloques`, vía `matricesImport.parseMatricesSheet`)
sin resolverla — `ingest.js` decide cuándo y contra qué conceptos
resolverla, dentro de la misma transacción que crea conceptos/insumos.

También cambia dónde se crea la fila de `proyectos`: antes se creaba
**afuera** de la transacción vía `db.createProjectRecord` (pool directo);
ahora se crea **dentro**, porque en este PR un bloque de Matrices
irresoluble hace que `ingest()` lance y hace falta que el `INSERT INTO
proyectos` también haga rollback (si no, quedaba una obra huérfana vacía
visible en la galería del cliente — confirmado con el archivo real usado
para el diseño). Nota: este comportamiento "todo-o-nada a nivel de obra"
se **revierte parcialmente en #213** (bloques irresolubles pasan a
omitirse en vez de abortar la obra completa).

**Archivos y funciones:** `server/matricesImport.js` (recibe
`calcularMatrizNeodata`, `MATRIZ_CATEGORIAS`, `insertarRenglones`,
`resolverBloqueImportacion`, `r2`); `server/ingest.js` (`ingest(client,
projectId, parsed, userId = null)` gana el parámetro `userId` y el bloque
que resuelve `parsed.matricesBloques`); `server/parser.js`
(`parseWorkbook` expone `matricesBloques`); `server/app.js`
(`POST /api/projects` crea el proyecto dentro de la transacción).

**Aplicabilidad a demo:** (b) portar adaptado — depende de #166 ya estado
portado, y de que la demo use el mismo `ingest.js`/`parser.js`. Es un
cambio de integración, no una feature aislada.

**Dependencias:** #166 (requisito directo). #213 modifica el
comportamiento "todo-o-nada" introducido aquí.

---

## PR #180 — feat(costos): reprocesar Destajo/Matrices en obras existentes

**Fecha:** 2026-08-22 (commit merge `ddf5778`). PR de tamaño medio,
dependiente de #178/#179.

**Problema que resolvía:** Las obras cargadas **antes** del fix de
#178/#179 (versión de software anterior a v355/v356) se quedaron sin
destajo y sin matrices, porque en ese momento el parser no reconocía el
formato real de la hoja Destajos y el alta de obra todavía no leía
Matrices. Volver a subir el Excel original desde cero no era una opción
(crearía conceptos duplicados) — hacía falta un camino que solo completara
lo que faltaba, sin tocar lo que ya existía.

**Diseño:** Dos endpoints nuevos (`preview`/`confirm`, mismo patrón que
siempre) que reciben el **mismo Excel original** de la obra y: (1) nunca
crean conceptos ni tocan Presupuesto/Insumos ya cargados, (2) resuelven
Destajos/Matrices contra los conceptos **ya existentes** por código. El
lado de Matrices reusa `matricesImport.resolverBloqueImportacion` tal
cual (ya diseñado para "matching contra conceptos ya existentes"). El
lado de Destajo no tenía un resolver equivalente — se agrega
`server/reprocesoDestajoMatrices.js` (`resolverDestajoContraConceptos`),
mismo criterio de: código ambiguo (2+ conceptos con el mismo código en la
obra) → no resuelto; concepto ya con destajo cargado → omitido, nunca
sobreescrito; código sin match → sin match.

**Archivos y funciones:** `server/reprocesoDestajoMatrices.js` (nuevo,
`resolverDestajoContraConceptos`); `server/app.js`
(`prepararReprocesoDestajoMatrices`, endpoints
`POST /api/projects/:id/reprocesar-destajo-matrices/preview` y `/confirm`).

**Aplicabilidad a demo:** (c) no aplica directamente — es un fix de
migración de datos históricos específico de obras reales cargadas antes
de una fecha concreta en producción. Si la demo nunca tuvo ese bug (puede
sembrarse limpia desde cero), este PR no tiene nada que portar. Solo
relevante si la demo necesita simular ese escenario de "obras viejas
incompletas" a propósito.

**Dependencias:** #178 (el bug de origen), #179 (usa la misma
`resolverBloqueImportacion` de la integración de matrices en alta de obra), #166.

---

## PR #181 — fix(costos): excluir proyecto de prueba 67 del catálogo agregado

**Fecha:** 2026-08-23 (commit merge `8bd9307`). PR trivial, 1 línea de dato + comentario.

**Problema que resolvía:** Un proyecto de prueba real (id 67, "prueba1")
compartía códigos de concepto con una obra real más antigua. Al ser el
proyecto más reciente, el `DISTINCT ON (codigo) ... ORDER BY creado_en
DESC` de `conceptosCatalogoQuery`/`basicosCatalogoQuery` lo prefería sobre
la obra real — el catálogo mostraba "sin destajo/matriz" para conceptos
que en su obra real sí tenían todo completo.

**Causa raíz:** Mismo problema estructural que las 3 obras de #165/#181:
nada en el schema distingue "obra de prueba" de una obra real
(`proyectos` no tiene columna `activo`).

**Fix:** Se agrega el id `67` a la misma lista
`EXCLUIR_OBRAS_DUPLICADAS_CATALOGO` (renombrada de
`EXCLUIR_OBRAS_DUPLICADAS_CATALOGO_CONCEPTOS`, compartida ahora
explícitamente entre el catálogo de Conceptos y el de Básicos).

**Archivos:** `server/app.js` (constante `EXCLUIR_OBRAS_DUPLICADAS_CATALOGO`, `[13, 41, 42] → [13, 41, 42, 67]`).

**Aplicabilidad a demo:** (c) no aplica — es un dato específico (id de
proyecto real de producción) sin ningún equivalente conceptual portable.
Si la demo tiene datos de prueba propios que contaminan su catálogo
agregado, la solución es la misma técnica (lista explícita de exclusión),
no este valor.

**Dependencias:** #165 (la lista que extiende).

---

## PR #182 — feat(costos): Catálogo Maestro de Costos

**Fecha:** 2026-08-24 (commit merge `1351164`). El PR más grande del
módulo junto con #184.

**Problema que resolvía:** El catálogo de Conceptos (#165) solo cruza
obras que **ya existen como proyectos activos** en la app. No había forma
de tener una biblioteca de referencia de precios histórica/externa
(obras cerradas, tabuladores de otros clientes, etc.) que se pudiera
consultar e importar a una obra sin que esos datos vivieran como una obra
"fantasma" en el sistema.

**Diseño — arquitectura:**

Cinco tablas nuevas, **deliberadamente sin `project_id`** (a diferencia de
absolutamente todo el resto del schema): `catalogo_archivos` (metadata +
estado de cada Excel subido: `procesando`/`procesado`/`error`),
`catalogo_conceptos`, `catalogo_destajo`, `catalogo_insumos` (guarda el
insumo como texto libre + `codigo_insumo`, no hay tabla `insumos` global
que referenciar), `catalogo_matrices` (una fila JSONB por concepto con la
matriz **completa** — cabecera + renglones tal cual la devuelve el
parser; se eligió JSONB en vez de una tabla relacional tipo
`matriz_precio_renglones` porque no existe un `insumos` global del que
colgar un FK, y es un catálogo de solo lectura/consulta, no un modelo
operativo). Reusa `parseArchivo4Hojas` de #176 tal cual — mismo parser
exacto de 4 hojas por nombre de encabezado.

Cinco endpoints, con dos niveles de permiso distintos:
- Administración (subir/listar/eliminar archivos): `auth.allow()` sin
  puestos extra — solo admin/desarrollador, decisión consultada para
  esta primera versión (no se granuralizó en `permisos_usuario`).
- Búsqueda + importar a obra: `auth.checkPermiso('costos', 'puede_crear')`
  — mismo permiso que "Crear presupuesto desde catálogo".

`eliminarArchivo` es soft-delete (`catalogo_conceptos.activo = false`),
nunca borra filas físicas ni el blob. `buscarConceptos` es
**deliberadamente sin dedupe por código** (a diferencia del catálogo de
#165, que sí hace `DISTINCT ON`) — aquí se navega un catálogo de
referencia con posible traslape real entre archivos subidos por separado,
y quedarse solo con "el más reciente" escondería en silencio un
destajo/precio distinto de otro archivo igual de válido. Requiere `q` no
vacío, límite duro de 100 resultados.

`importarAObra(client, proyectoId, catalogoConceptoIds)` es la pieza más
delicada: **no reusa `ingest.js`** aunque el plan original lo sugería —
`ingest()` está diseñado para alta de obra desde cero (genera
`programa_ejecucion`/`avances_semanales` para TODOS los conceptos de la
obra vía `generatePlanning`, y asume `conceptoIdsConMatriz` siempre
vacío). Llamarlo contra una obra existente recalcularía/duplicaría avance
de la obra completa — exactamente lo que las notas del proyecto prohíben
("preservar siempre datos existentes de avance"). En su lugar replica a
mano el patrón de `import-completo/confirm` (#176): resuelve por código,
transacción única. Colisión de código con un concepto ya activo en la
obra destino → se omite (nunca sobreescribe ni duplica), reportado en
`omitidos_duplicados`. Destajista: name-matching case-insensitive contra
los ya existentes en la obra destino, crea uno nuevo si no hay match
(fallback `'Sin destajista asignado'`, no un nombre genérico inventado).
Insumo de un renglón de matriz: resuelto por código contra los insumos ya
existentes de la obra destino, o creado nuevo con el precio que trae
`catalogo_insumos`.

Frontend: subvista "Catálogo Maestro" en Costos, con sección de
administración de archivos visible solo si `isAdmin()` (gate puramente de
UX — el 403 real lo pone el backend) y buscador con debounce +
checkboxes + selector de obra destino + botón "Importar a esta obra".

**Archivos y funciones:** `server/catalogoMaestro.js` (nuevo, 299 líneas:
`procesarArchivoCatalogo`, `listarArchivos`, `eliminarArchivo`,
`buscarConceptos`, `importarAObra`); `server/db.js` (5 tablas nuevas,
`catalogo_archivos/conceptos/destajo/insumos/matrices`); `server/app.js`
(6 endpoints bajo `/api/costos/catalogo-maestro/*`); `public/app.js`
(`showCatalogoMaestro` dentro de `renderCostos`).

**Aplicabilidad a demo:** (b) portar adaptado. Es una feature grande y
autocontenida (no depende de datos reales del cliente, a diferencia de
las listas de exclusión de #165/#181) — buen candidato a portar completo
si la demo quiere mostrar esta capacidad, pero requiere haber portado
#176 primero (`parseArchivo4Hojas`) y decidir el equivalente de
`isAdmin()`/roles en la demo.

**Dependencias:** #176 (`parseArchivo4Hojas`). Es la base de #184
(normalizador AJAL, que se engancha sobre este mismo módulo).

---

## PR #183 — fix(nomina): repartir destajo entre trabajadores vinculados en vez de duplicarlo

**Fecha:** 2026-08-24 (commit merge `67cace9`).

**Problema que resolvía:** Cuando varios trabajadores de nómina
compartían el mismo `destajista_id` (un destajista con varios ayudantes
vinculados a él para efectos de nómina), cada uno de ellos recibía el
**monto completo** del destajista en su línea de nómina — duplicación o
triplicación del pago, no un reparto.

**Causa raíz:** `POST /api/projects/:id/nominas/:nomId/calcular` calculaba
el destajo acumulado agrupando por `t.id` (trabajador), con un `JOIN
destajistas dest ON dest.id = t.destajista_id`. Con N trabajadores
vinculados al mismo destajista, el JOIN completo contra
`destajo_items`/`avance_destajo` se repetía N veces y cada trabajador se
quedaba con el total agregado completo del destajista, no con una
fracción.

**Fix:** La query se reagrupa por `destajista_id` (no por trabajador) —
un solo total por destajista. Ese total se reparte en JS vía la función
nueva `distribuirDestajoGrupo(total, grupo, nombreDestajista, minimoVinculado = 500)`:
- Si el grupo tiene 1 solo trabajador: recibe el total completo (caso
  normal, sin cambio de comportamiento).
- Si tiene 2+: se identifica al "principal" por name-matching
  (case-insensitive, sin distinguir espacios) del nombre del trabajador
  contra el nombre del destajista. Cada vinculado (no el principal) recibe
  un mínimo fijo de $500; el principal se queda con el remanente.
- Si `$500 × vinculados` excede el total disponible, o no se pudo
  identificar al principal por nombre: no hay forma segura de decidir
  quién absorbe el faltante — se reparte a prorrata entre todo el grupo
  (el último miembro absorbe el residuo de redondeo) y se marca una
  `alerta` de texto en cada entrada para que la UI avise y un humano lo
  revise. Nunca se asigna un monto negativo.

```js
// Antes: agrupaba por trabajador → cada vinculado veía el total completo
GROUP BY t.id
// Después: agrupa por destajista, reparte en JS
GROUP BY dest.id, dest.nombre
```

Columna nueva `nomina_items.alerta_destajo` (TEXT, NULL en el caso
normal) para persistir el motivo del reparto especial y que la UI lo
muestre.

**Archivos y funciones:** `server/calculos.js` (`distribuirDestajoGrupo`,
nueva); `server/app.js` (query de destajo acumulado reagrupada, bloque de
reparto en `POST /nominas/:nomId/calcular`); `server/db.js`
(`nomina_items.alerta_destajo`).

**Aplicabilidad a demo:** (a) portar tal cual si la demo tiene el mismo
esquema de nómina por destajo con trabajadores vinculados a un
destajista — es un fix de lógica de negocio puro, sin dependencia de
datos reales.

**Dependencias:** Ninguna dentro de este módulo — toca nómina/destajo,
tangencial a Matrices/Catálogo Maestro pero incluido en este módulo por
tocar `destajo_items`/`destajistas`.

---

## PR #184 — feat(costos): normalizador AJAL para Catálogo Maestro con preview/confirm

**Fecha:** 2026-08-24 (commit merge `8c56b84`). Depende de #182.

**Problema que resolvía:** `parseArchivo4Hojas` (el parser estándar del
Catálogo Maestro, heredado de #176) espera una hoja llamada exactamente
"Presupuesto" con encabezados fijos en la fila 1. Existe un formato real
distinto ("AJAL"), usado en varios archivos de referencia del cliente,
con: letterhead + metadata corporativa en las primeras ~15 filas, la hoja
llamada "Directo AJAL" o "Estimacion AJAL" (nunca "Presupuesto"), fila de
encabezados en posición variable (~fila 16, no fija), sinónimos de columna
("P. Unitario" en vez de "Precio Unitario"), y filas jerárquicas de
categoría/total mezcladas con partidas reales dentro de la misma hoja.
Subir uno de estos archivos al Catálogo Maestro fallaba siempre con "no
se encontró hoja Presupuesto".

**Diseño:** Módulo nuevo y completamente separado (`server/normalizadorAjal.js`)
que actúa como **fallback**, nunca reemplaza al parser estándar — se
intenta primero `parseArchivo4Hojas` tal cual; solo si falla
específicamente con el mensaje "no tiene una hoja Presupuesto" se intenta
el formato AJAL (`parseArchivoConFallbackAjal` en `catalogoMaestro.js`).
Cualquier otro error del parser estándar (ej. inconsistencia Hoja 2 vs
Hoja 1) se propaga tal cual, sin pasar por AJAL.

Dentro del normalizador: `localizarFilaHeaderPresupuesto` escanea las
primeras 40 filas buscando la que tenga las 4 columnas indispensables
(código/concepto/cantidad/precio, con sinónimos) — si no encuentra
ninguna, o encuentra 2+ candidatas con el mismo score de coincidencia
(ambigüedad real), **falla explícitamente** en vez de adivinar. El
clasificador partida-real-vs-categoría (`esPartidaReal`) usa una regla
simple validada contra los 4 archivos reales usados para el diseño: una
fila es partida real solo si cantidad Y precio son ambos numéricos y
distintos de 0 — eso excluye limpiamente filas de categoría/agrupador,
"TOTAL ..." y pie de página, sin casos especiales.

**Alcance explícito de esta fase: solo la hoja de Presupuesto.**
Destajo/Insumos/Matrices en formato AJAL quedan fuera a propósito — el
diagnóstico encontró problemas estructurales más profundos que un
sinónimo de columna (descripciones partidas en múltiples filas, secciones
anidadas, sin columna de destajista) que ameritan diagnóstico propio.

Por el riesgo más alto de un parser heurístico (vs. el estándar, que es
determinista por nombre exacto), se agrega una pausa de **preview/confirm
específica del camino AJAL** — el formato estándar sigue subiendo en un
solo paso, sin este freno. Nuevo estado `'pendiente_confirmacion'` en
`catalogo_archivos.estado` y columna `formato_detectado` ('estandar'/
'ajal'). El usuario ve la tabla de conceptos detectados antes de que se
escriba nada; al confirmar, el backend **vuelve a descargar y re-parsear
el blob desde cero** (nunca confía en el preview cacheado).

**Archivos y funciones:** `server/normalizadorAjal.js` (nuevo, 216 líneas:
`normalizarArchivoAjal`, `esHojaPresupuestoAjal`,
`localizarFilaHeaderPresupuesto`, `leerPresupuestoAjal`, `esPartidaReal`);
`server/catalogoMaestro.js` (`parseArchivoConFallbackAjal`,
`persistirArchivoParseado` separada de `procesarArchivoCatalogo`);
`server/db.js` (`catalogo_archivos.formato_detectado`, estado
`'pendiente_confirmacion'`); `server/app.js` (endpoint nuevo
`POST /api/costos/catalogo-maestro/upload/:id/confirmar`); `public/app.js`
(`mostrarPreviewAjal`).

**Aplicabilidad a demo:** (c) no aplica / (b) portar adaptado según el
caso. El *mecanismo* (fallback de parser + preview/confirm de mayor
riesgo) es un patrón reusable si la demo necesita tolerar un formato de
Excel no estándar propio. Los sinónimos de columna concretos ("P.
Unitario", nombres de hoja "Directo AJAL") son específicos del formato
real del cliente — no tienen sentido en la demo salvo que se le
inventen archivos de prueba equivalentes.

**Dependencias:** #182 (Catálogo Maestro — este PR se engancha
directamente sobre `catalogoMaestro.js`/`catalogo_archivos`). #176
indirectamente (vía `parseArchivo4Hojas`, el camino que intenta primero).

---

## PR #213 — feat(matrices): Fase 1 Parte A — integridad bloque→obra + desambiguación por cantidad (Caso 1)

**Fecha:** 2026-09-04 (commit merge `c514b95`). Depende de #166/#179.
Implementa el diseño de `docs/fase0-importador-matrices-casos-no-soportados.md`
(diagnóstico previo, verificado contra el diff real — coincide punto por
punto).

**Problema que resolvía:** Dos problemas reales confirmados con archivos
de obra reales:

1. **Granularidad todo-o-nada:** desde #179, si **un solo** bloque de la
   hoja Matrices resultaba irresoluble (de ~30+ bloques típicos), `ingest()`
   lanzaba y la transacción completa de alta de obra hacía rollback — se
   perdía la obra entera por un solo análisis de precio unitario mal
   formado o ambiguo.
2. **Caso 1 — código duplicado en 2+ capítulos:** un mismo código de
   concepto (ej. `AJAL.TRA.LIN`) puede aparecer en 2 capítulos distintos
   del presupuesto con cantidades distintas (208.9 y 303.77 en el archivo
   real usado para el diagnóstico) — la hoja Matrices trae 2 bloques
   "Análisis:" separados, cada uno con su propia `cantidad_concepto`, pero
   el importador (desde #166) no tenía forma de saber a cuál de los 2
   conceptos candidatos correspondía cada bloque y los bloqueaba con error.

**Diseño (dos cambios independientes, mismo PR):**

*Integridad bloque→obra (el de mayor impacto):* La transacción
`proyectos + conceptos + insumos + destajo` sigue siendo 100% atómica —
eso no cambia. Lo que cambia es que `ingest.js` **ya no lanza** cuando
`resolverBloqueImportacion` devuelve `estado: 'error'` para un bloque:
ese bloque se omite (no se inserta su matriz) y se acumula en un arreglo
`matricesNoResueltas` que `ingest()` devuelve como `{ matrices_no_resueltas }`,
que a su vez `POST /api/projects` incluye en la respuesta. El concepto
correspondiente sí se crea normalmente (ya se había insertado antes en la
misma transacción, con su precio/importe de la hoja de presupuesto) — solo
le falta la matriz de Análisis de Precio Unitario, algo que el schema ya
toleraba de por sí (`matrices_precio_unitario.concepto_id` es `UNIQUE`
pero no `NOT NULL`-forzado por ningún trigger).

*Caso 1 — desambiguación por cantidad:* en `resolverBloqueImportacion`
(`server/matricesImport.js`), cuando `conceptosCandidatos.length > 1`, en
vez de fallar de inmediato se filtran los candidatos cuya
`concepto.cantidad` coincida con `bloque.cantidad_concepto` dentro de una
tolerancia de `0.01`. Si queda exactamente 1 candidato, se resuelve contra
ese. Si quedan 0 o 2+, sigue cayendo al caso general de "no resuelto" —
nunca se adivina.

```js
const TOLERANCIA_CANTIDAD = 0.01;
const porCantidad = bloque.cantidad_concepto != null
  ? conceptosCandidatos.filter((c) => Math.abs(Number(c.cantidad) - bloque.cantidad_concepto) < TOLERANCIA_CANTIDAD)
  : [];
if (porCantidad.length === 1) { concepto = porCantidad[0]; }
else { /* estado: 'error', igual que antes */ }
```

**Archivos y funciones:** `server/matricesImport.js`
(`resolverBloqueImportacion`, bloque de desambiguación); `server/ingest.js`
(`ingest()` ya no lanza por matrices, devuelve `{ matrices_no_resueltas }`,
query de conceptos ahora trae también `cantidad`); `server/app.js`
(`POST /api/projects` propaga `matrices_no_resueltas` en la respuesta).

**Aplicabilidad a demo:** (a) portar tal cual, condicionado a tener
portados #166/#179 primero (edita las mismas funciones). Es un fix de
robustez puro, sin dependencia de datos reales del cliente — el patrón
"desambiguar por cantidad, nunca adivinar" es genérico.

**Dependencias:** #166, #179 (edita `resolverBloqueImportacion` e
`ingest()` introducidos/modificados ahí). Precede a #215 (misma función
`resolverBloqueImportacion`, mismo archivo).

---

## PR #215 — feat(matrices): Fase 1 Parte B — Caso 2, cuadrilla pre-agregada sin desglose

**Fecha:** 2026-09-04 (commit merge `f879172`). Depende de #166/#213.
Implementa el diseño de `docs/fase0-importador-matrices-casos-no-soportados.md`
(Caso 2, verificado contra el diff real).

**Problema que resolvía:** Documentado como limitación conocida desde
#166: un renglón de MANO DE OBRA cuyo código es una cuadrilla ya agregada
(ej. `"1A5P"` = "CUADRILLA No 22 (1 ALBAÑIL + 5 PEONES)") nunca existe
como insumo individual en el catálogo — el importador lo bloqueaba siempre
con `ERROR_CUADRILLA_PRECOLAPSADA`, aunque el Excel real sí trae el costo
total utilizable de esa fila.

**Causa raíz / diseño:** Confirmado contra el archivo real de referencia,
fila de la hoja Matrices: `["1A5P", "CUADRILLA No 22...", "JOR", "5218.31",
"/", "12", "434.86", "0"]` — columna D (`5218.31`) es el costo total real
de la cuadrilla conjunta, y G (`434.86`) ya es el resultado de
`5218.31 / 12`, matemáticamente idéntico a la fórmula que
`calcularMatrizNeodata` ya aplica para `operador === '/'`. El parser
(`parseMatricesSheet`) descartaba esa columna D porque asumía que el
precio de cualquier renglón `tipo: 'insumo'` siempre sale del catálogo —
nunca la leía para guardarla.

**Fix:** El parser ahora captura también `precio_hoja: num(D)` y
`descripcion: B` en cada renglón `tipo: 'insumo'` (antes solo
código/cantidad/operador). En `resolverRenglon`, cuando el código no está
en `insumosPorCodigo` y matchea el heurístico de cuadrilla pre-colapsada
(empieza con dígito, categoría MANO DE OBRA/null) — **si `precio_hoja` es
un número válido `> 0`** — se resuelve como un renglón `tipo: 'insumo'`
con `insumo_id: null`, `precio_presupuesto: precio_hoja` y el flag
`sin_desglosar: true`; si `precio_hoja` viene vacío/0/no numérico, se
mantiene el error de siempre (nunca se inventa un precio). Columna nueva
`matriz_precio_renglones.precio_fijo` (`DOUBLE PRECISION`, nullable) para
persistir ese precio capturado de la hoja — un renglón `tipo='insumo'`
con `insumo_id IS NULL` es, por construcción, el marcador implícito de
este caso (nunca ocurría antes de este PR). La UI de detalle de matriz
(`paintMatrizDetalle`, `openBasicoEditorModal`) muestra un aviso
"⚠️ Mano de obra sin desglosar por oficio" en esos renglones. La edición
manual de una matriz (`validarRenglones`) también acepta este tipo de
renglón (requiere `codigo` y `precio_presupuesto > 0` en vez de
`insumo_id`).

**Archivos y funciones:** `server/matricesImport.js`
(`parseMatricesSheet` captura `precio_hoja`/`descripcion`; `resolverRenglon`
rama nueva; `insertarRenglones` persiste `precio_fijo`); `server/db.js`
(`matriz_precio_renglones.precio_fijo`); `server/app.js`
(`fetchRenglonesRaw` y la query de `GET /api/projects/:id/matrices` hacen
`COALESCE(i.precio_presupuesto, r.precio_fijo)`; `validarRenglones` rama
`sin_desglosar`); `public/app.js` (aviso visual en `paintMatrizDetalle`,
`openBasicoEditorModal`).

**Aplicabilidad a demo:** (a) portar tal cual, condicionado a #166/#213
ya portados. Fix de robustez puro sobre un caso real de formato de Excel,
sin dependencia de datos del cliente — solo requiere un Excel de prueba
con una fila de cuadrilla pre-agregada para verificar.

**Dependencias:** #166 (`parseMatricesSheet`/`resolverRenglon`/
`insertarRenglones`), #213 (misma función `resolverBloqueImportacion`
tocada en el PR anterior, aunque este PR toca `resolverRenglon`, una
función distinta dentro del mismo archivo).
