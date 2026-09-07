# Órdenes de Compra y Requisiciones

Cambios mergeados a `main` de App-CP entre 2026-08-18 y 2026-09-04, en el
módulo de Requisiciones y Órdenes de Compra (OC). 6 PRs, orden cronológico.

**Nota de metodología para quien lea esto después:** para obtener el diff
real que cada PR introdujo a `main` hay que comparar `<merge>^1` (el tip de
`main` justo antes del merge) contra `<merge>` (el propio commit de merge)
— **no** `<merge>^1` contra `<merge>^2` (el tip de la rama feature). Para
PR #157 estos dos métodos dan resultados distintos: la rama del PR se
creó antes de que otro PR (extensión de `residente` en Maquinaria) se
mergeara a `main`, así que diffear contra el tip de la rama (`^2`)
muestra, incorrectamente, un revert completo de esa extensión (borra
`ROLES_AUTORIZAN_HORAS_MAQ`, permisos de `residente`, y un archivo de test
completo). Ese revert **nunca llegó a `main`** — el merge real (3-way) lo
preservó intacto. Verificado con `git diff <merge>^1 <merge>`, que muestra
únicamente los 3 archivos realmente tocados por este PR. Si se audita
algún otro PR de este changelog (o de otro módulo) y aparece una
"regresión" sospechosa de una feature no relacionada, reproducir este
mismo chequeo antes de asumir que es real.

---

## PR #157 — feat/editar-requisicion-con-oc

**Fecha:** 2026-08-18 (merge commit `15f31c3e`).

**Problema que resolvía:** una requisición que ya tenía Orden de Compra
generada — y en el caso real que lo motivó, ya con un pago confirmado —
quedó ligada al insumo equivocado del catálogo (unidad incorrecta). No
existía forma de corregir ese renglón: el endpoint de edición completa
(`PUT /api/projects/:id/requisiciones/:reqId`) es **borrador-only** por
una razón técnica real, no arbitraria — internamente hace `DELETE` +
`INSERT` de todos los items de la requisición, lo que rompería contra la
FK de `orden_compra_items.requisicion_item_id` (sin `ON DELETE CASCADE`)
si se ejecutara sobre una requisición con OC ya generada.

**Diseño:** endpoint nuevo y **separado**, admin/desarrollador-only, que
corrige **un solo item a la vez** con `UPDATE` selectivo — nunca `DELETE`.
Deliberadamente no reusa el mecanismo de borrar-y-recrear del endpoint de
edición completa. Confirmado en diagnóstico previo (documentado en el PR)
que `orden_compra_items` es un snapshot 100% independiente desde el
momento en que se crea la OC — ningún cálculo derivado (OC, pagos,
Compromisos Abiertos, Erogado Real) lee de `requisicion_items` después de
ese punto, así que corregir el renglón de la requisición nunca puede
tocar la OC ni el pago ya confirmados. Bloqueado solo para
`estado === 'borrador'` (ese estado ya tiene su propio endpoint de edición
completa); el resto de estados (enviada/autorizada/rechazada/cancelada) no
tienen razón adicional para bloquearse. Justificación de texto libre
**obligatoria** en cada corrección. Auditoría vía `audit_log` reusando
`logRequisicionAudit`, que normalmente solo loguea acciones de
`residente`/`cabo` — se le agregó una excepción puntual para esta acción
nueva (`requisicion_item_editar_post_oc`), que es admin-only pero sí debe
quedar auditada.

**Archivos y funciones tocadas** (diff real, `15f31c3e^1..15f31c3e`):
- `server/app.js` — `logRequisicionAudit()` (excepción para
  `requisicion_item_editar_post_oc`, ~línea 5809-5814); endpoint nuevo
  `PUT /api/projects/:id/requisiciones/:reqId/items/:itemId` (~línea
  6071-6154).
- `public/app.js` — `openRequisicionDetail()` (botón "Corregir" por
  renglón, solo visible si `isAdmin() && r.estado !== 'borrador'`; muestra
  "Corregido por X el fecha" leyendo el historial existente
  `/requisiciones-historial`, sin endpoint nuevo); función nueva
  `openEditItemPostOcModal()` (~línea 6070-6156): modal con buscador de
  insumo del catálogo, cantidad, precio y justificación obligatoria,
  confirmación explícita antes de guardar.
- `tests/editar-requisicion-con-oc.test.js` — nuevo, 242 líneas,
  integración contra DB real (patrón `supertest` + `vitest` ya usado en el
  repo). Cubre: 400 sin justificación, 403 para rol no-admin, corrección
  exitosa con verificación byte-a-byte de que `orden_compra_items` y
  `pagos` no cambian, entrada en `audit_log`, reflejo inmediato en
  "disponibilidad de materiales", bloqueo en `borrador`, y regresión del
  endpoint de edición completa.

**Fragmento clave** (`server/app.js`, validación de estado):
```js
if (reqRows[0].estado === 'borrador') {
  return res.status(400).json({ error: 'Esta requisición está en borrador — usa la edición normal, no esta corrección' });
}
```
El resto de la lógica es un `UPDATE ... SET insumo_id=$1, cantidad_solicitada=$2,
precio_solicitado=$3, importe=$4 WHERE id=$5` — nunca toca
`orden_compra_items` ni `pagos`.

**Aplicabilidad a la demo:** **(b) portar adaptado**. El mecanismo (UPDATE
selectivo, no borrar-y-recrear; admin-only; bloqueado en borrador;
justificación obligatoria) es genérico y útil para cualquier app con el
mismo problema de "requisición con OC ya generada". Adaptar: nombres de
tabla/columna si difieren, y verificar que la demo tenga el mismo patrón
de `logRequisicionAudit` con la misma restricción de roles antes de
replicar la excepción puntual.

**Dependencias:** ninguna con otros PRs de este módulo. Nota: el diff
crudo de la rama (no el real) sugiere una dependencia falsa con un PR de
Maquinaria — ver nota de metodología arriba, no es real.

---

## PR #207 — fix/emparejamiento-duplicados-nan

**Fecha:** 2026-09-02 (merge commit `827c0349`).

**Nota de alcance:** este PR vive técnicamente en el módulo de
actualización de presupuesto (`server/reintegracionPresupuesto.js`), no en
Requisiciones/OC en sentido estricto — se incluye en este changelog por
asignación explícita. Es adyacente al dominio de este módulo porque
comparte la lógica de emparejamiento de conceptos/insumos por código que
también usa el flujo de OC-por-insumo (ver `docs/fase0-oc-por-insumo-y-
duplicados.md` para contexto de fondo, aunque ese doc no documenta este
PR específico).

**Qué problema resolvía:** al actualizar el presupuesto de una obra desde
un Excel nuevo, cuando un código de concepto/insumo aparecía **duplicado
tanto en el Excel nuevo como en la base de datos, con el mismo conteo de
repeticiones** (patrón típico de la metodología de captura "AJAL": la
misma partida repetida por zona), el emparejamiento cae al fallback por
descripción y **siempre** reporta conflicto — confirmado contra datos
reales de un proyecto en producción: 12 conflictos falsos, reducidos a 1
(el único caso de conteo realmente asimétrico) tras el fix.

**Causa raíz:** la condición que permite emparejamiento posicional por
código duplicado solo estaba habilitada para el caso **asimétrico**
(duplicado en el Excel, NO duplicado en la DB). Pero el propio flujo de
alta de presupuesto deja la DB en estado **N-a-N** (mismo conteo
duplicado en ambos lados) después de la primera carga de un presupuesto
con partidas repetidas por zona — un estado normal y esperado, no una
ambigüedad de datos — y ese caso nunca estaba cubierto por la condición
original.

**Sobre el nombre "nan" en la rama:** el diff y el body del PR (verificado
vía `gh pr view 207`) **no mencionan NaN en ningún punto** — la causa raíz
real, documentada arriba, es puramente de lógica de emparejamiento
(conflicto reportado de más), no un cálculo numérico corrupto. No queda
claro desde el diff si "nan" en el nombre de rama se refiere a un síntoma
observado río abajo (ej. un porcentaje de cambio calculado como `NaN` en
la UI cuando el conflicto no resuelto dejaba algún valor `undefined`) —
esto **no se pudo verificar** con el diff disponible; queda como hipótesis
sin confirmar.

**Archivos y funciones tocadas:**
- `server/reintegracionPresupuesto.js` — `emparejarConceptos()` (~línea
  81-96).
- `tests/reintegracion-presupuesto.test.js` — 1 test existente
  reescrito (el caso simétrico pasó de "cae a fallback, sin regresión" a
  "empareja posicionalmente, 0 conflictos"), 2 tests nuevos (conteo
  asimétrico sigue en conflicto; guard de `calcularCambios()` para precio
  distinto en un match código-duplicado sigue exigiendo confirmación).

**Fragmento antes/después** (`server/reintegracionPresupuesto.js`,
`emparejarConceptos()`):
```js
// ANTES
if ((countByCode.get(item.codigo) || 0) > 1) continue;

// DESPUÉS
const enDB = countByCode.get(item.codigo) || 0;
if (enDB > 1 && enDB !== excelCountByCode.get(item.codigo)) continue;
```
Es decir: antes, *cualquier* duplicado también en la DB desactivaba el
emparejamiento posicional. Después, solo lo desactiva un **conteo
distinto** entre Excel y DB — conteo igual (aunque ambos >1) sí empareja
posicionalmente.

**Aplicabilidad a la demo:** **(b) portar adaptado**, condicionado a que
la demo tenga el mismo archivo `server/reintegracionPresupuesto.js` con la
misma función `emparejarConceptos()` (alta probabilidad si el demo es un
fork/clon de la base de App-CP). Si la demo no maneja presupuestos con
partidas repetidas por zona (metodología AJAL) o no tiene este módulo de
actualización de presupuesto, **(c) no aplica**.

**Dependencias:** ninguna con otros PRs de este módulo.

---

## PR #209 — feat/zona-carga-archivos-lote1

**Fecha:** 2026-09-02 (merge commit `e859903f`).

**Nota de alcance:** este PR **no es específico de Requisiciones/OC** —
es un componente de UI transversal (`crearZonaCargaArchivo()`, drag & drop
reusable) aplicado en su "Lote 1" a **3 flujos que no son de OC**: alta de
presupuesto (cliente nuevo), actualizar presupuesto, y contrato de obra
(PDF). Se incluye aquí por asignación explícita de este changelog; no
toca ningún archivo/endpoint de requisiciones ni órdenes de compra.
Diseño de referencia: `docs/fase0-zona-carga-archivos.md` (inventario
completo de 18 inputs de archivo en 17 flujos, con plan de rollout en 4
lotes — este PR es solo el Lote 1).

**Qué problema resolvía:** los `<input type="file">` nativos de esos 3
flujos eran el control HTML simple sin ningún tratamiento visual
("Seleccionar archivo" / "Ningún archivo seleccionado"), sin soporte de
arrastrar-y-soltar.

**Diseño:** función `crearZonaCargaArchivo({ id, accept, multiple, texto,
textoMobile, hint, validar, onFiles })` que genera HTML (string, para
insertar en un modal) + un `wire()` separado para atar listeners después
de que ese HTML ya está en el DOM real — mismo patrón de 2 pasos
(render → wire) que ya usa cada modal de la app, sin introducir un
componente con ciclo de vida propio. Puntos de diseño relevantes:
- `onFiles(files)` **siempre** recibe un array, incluso con
  `multiple: false` — pensado para que el mismo componente sirva también
  al caso de selección acumulativa (Lote 4, fuera de este PR).
- `matchesAccept(file, accept)` es necesaria porque el atributo `accept`
  del `<input>` nativo solo filtra el picker del sistema operativo — un
  `drop` puede traer cualquier tipo de archivo sin importar `accept`, así
  que hay que revisarlo a mano en el handler de `drop`.
- `validar` es un validador async pluggable, `(file) => string|null` —
  permite seguir usando `validarArchivoXlsxCliente()` (que lee los primeros
  bytes del archivo para confirmar firma ZIP real y detectar el patrón
  `~$` de un Excel temporal/abierto) sin duplicar esa lógica.
- Móvil (mismo breakpoint `≤860px` que ya usa el resto de la app): no hace
  falta desactivar `dragover`/`drop` a mano — esos eventos simplemente no
  existen en touch. Solo cambia el texto (`textoMobile`) de "arrastra" a
  "toca para elegir".
- Los inputs globales ocultos `#fileInput`/`#pdfFileInput` y el estado
  `state.pendingUploadClienteId`/`state.pendingContrato` se **retiraron**
  — el contexto ahora viaja por closure directo dentro del mismo modal
  (ya no hace falta el salto `closeModal()` + `.click()` a un input fuera
  del modal).
- Ninguna lógica de procesamiento real (`validarArchivoXlsxCliente`,
  upload a Vercel Blob, POST al backend, extracción de contrato con IA)
  se tocó — se extrajo tal cual a funciones nombradas
  (`procesarArchivoPresupuestoNuevo`, `procesarArchivoContrato`,
  `procesarArchivoActualizarPresupuesto`) invocadas desde `onFiles()`.

**Archivos y funciones tocadas:**
- `public/app.js` — `matchesAccept()` y `crearZonaCargaArchivo()` nuevas
  (~línea 4683-4787 sobre la base); `mostrarZonaCargaPresupuestoNuevo()`,
  `mostrarZonaCargaContrato()` nuevas; `promptUpload()`,
  `promptUploadContrato()`, `promptAttachContrato()`,
  `abrirModalActualizarPresupuesto()` modificadas para usar el componente
  nuevo en vez del input nativo + listener global.
- `public/index.html` — se eliminan los 2 `<input type="file" hidden>`
  globales (`#fileInput`, `#pdfFileInput`).
- `public/styles.css` — clases nuevas `.file-dropzone`,
  `.file-dropzone[data-state="dragover"|"error"]`,
  `.file-dropzone-icon/-text/-hint`, animación `file-dropzone-shake`
  (respeta `prefers-reduced-motion`, reusa el apagador global ya
  existente en el archivo).
- Ícono SVG nuevo `upload-cloud` en `ICON_SVG`.

**Aplicabilidad a la demo:** **(b) portar adaptado, con criterio**. El
componente `crearZonaCargaArchivo()` en sí es genérico y reusable — vale
la pena portarlo si la demo también tiene flujos de carga de archivo con
el input nativo simple. Pero no es una prioridad de este módulo
(Requisiciones/OC): ningún flujo de OC/requisiciones lo usa en este PR.
Si se porta, aplicar primero donde la demo tenga el mismo dolor visual
(alta/actualización de presupuesto, contrato), no forzarlo en OC si no
hay un caso real ahí.

**Dependencias:** ninguna con otros PRs de este módulo.

---

## PR #210 — feature/buscador-requisiciones-oc

**Fecha:** 2026-09-04 (merge commit `15a09729`).

**Qué problema resolvía:** dificultad real para ubicar registros
específicos en las listas de Requisiciones y Órdenes de Compra —
motivado explícitamente (según el PR) por la dificultad encontrada al
investigar un caso de OCs duplicadas en una sesión de trabajo anterior
(`docs/fase0-oc-por-insumo-y-duplicados.md`,
`docs/cancelar-oc-duplicadas-produccion.md`). Sin buscador, ubicar una
requisición u OC específica entre muchas dependía de scroll manual.

**Diseño:** filtro de texto **instantáneo y 100% client-side** (sin
roundtrip al servidor) arriba de cada lista. Búsqueda normalizada
(minúsculas + sin acentos, vía `normalizarTexto()`, mismo criterio ya
usado en otros buscadores de la app) contra:
- Requisiciones: folio + `conceptos_texto` (concatenación de los
  conceptos de sus insumos).
- Órdenes de Compra: folio + nombre de proveedor + folio de la
  requisición origen + `conceptos_texto`.

`conceptos_texto` se agrega en el backend (`getRequisicionesData()` /
`getOrdenesData()`) reusando los queries que ya existían para calcular
totales/alertas — sin hacer un fetch adicional, solo un `JOIN`/`STRING_AGG`
extra sobre datos que ya se estaban leyendo.

**Archivos y funciones tocadas:**
- `public/app.js` — `normalizarTexto()` nueva (helper global, ~línea 153);
  `renderRequisiciones()` (función interna `pintarReqList()` extraída del
  `.map().join()` inline anterior + `aplicarReqFiltro()` nueva, ~línea
  6622-6693); `renderOrdenes()` (mismo patrón: `pintarOcList()` +
  `aplicarOcFiltro()`, ~línea 7489-7556).
- `server/app.js` — `getRequisicionesData()` agrega `STRING_AGG(i.concepto,
  ' | ')` al query existente de `requisicion_items JOIN insumos`
  (~línea 7623-7630); `getOrdenesData()` agrega `i.concepto AS
  insumo_concepto` al `SELECT` existente y arma `conceptos_texto` en JS
  con `.map().join(' | ')` (~línea 8243-8263).

**Fragmento clave** (`public/app.js`, normalización — reusa un patrón ya
existente en otro buscador, no lo inventa):
```js
const normalizarTexto = (s) => (s || '').toString().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
```
Filtro (mismo patrón para requisiciones y OC):
```js
function aplicarReqFiltro(raw) {
  const q = raw.trim();
  $('#reqSearchWrap').classList.toggle('has-value', !!q);
  if (!q) { pintarReqList(reqs); return; }
  const norm = normalizarTexto(q);
  const filtrados = reqs.filter((r) => normalizarTexto(`${r.folio || ''} ${r.conceptos_texto || ''}`).includes(norm));
  if (!filtrados.length) { list.innerHTML = `<div class="empty-state">Sin resultados para "${esc(q)}".</div>`; return; }
  pintarReqList(filtrados);
}
```

**Aplicabilidad a la demo:** **(a) portar tal cual** si la demo tiene
listas de Requisiciones/OC con la misma estructura de datos
(`getRequisicionesData`/`getOrdenesData` o equivalente) — es un patrón
autocontenido, sin dependencias de otros módulos, de bajo riesgo (no
cambia ningún cálculo, solo agrega un campo de texto y un filtro
client-side).

**Dependencias:** ninguna con otros PRs de este módulo. Referencia de
contexto (no dependencia dura): `docs/fase0-oc-por-insumo-y-duplicados.md`.

---

## PR #211 — feature/reasignar-proveedor-oc

**Fecha:** 2026-09-04 (merge commit `10e2f5f5`).

**Qué problema resolvía:** no existía **ninguna** forma de corregir el
proveedor de una Orden de Compra ya creada, en ningún estado — caso real
que lo motivó: una OC con el proveedor equivocado capturado por error.
Diagnóstico previo (`docs/fase0-reasignar-proveedor-oc.md`) confirmó que
esto no era un bloqueo específico de algún estado (ej. `recibida_completa`):
la función de editar proveedor simplemente **nunca se construyó** —
`proveedor_id` solo se escribía una vez, en el `INSERT` al crear la OC. La
única vía indirecta existente (`DELETE` + recrear) solo aplica a
`estado === 'borrador'`.

**Diseño (implementado ~tal cual el documento de Fase 0, verificado
contra el diff real):** endpoint nuevo `PATCH
/api/projects/:id/ordenes/:ocId/proveedor`, admin/desarrollador-only
(`auth.allow()` sin argumentos — bypass hardcodeado para esos 2 roles),
disponible en **cualquier estado** de la OC. Justificado en Fase 0 con una
revisión explícita de dependencias: `proveedor_id` **no está
denormalizado en ningún lado** (`pagos`/`recepciones` referencian
`orden_compra_id`, nunca `proveedor_id`) — así que reasignarlo es, en
términos de esquema, el `UPDATE` de una sola columna en una sola tabla,
sin efectos secundarios sobre pagos o recepciones ya registrados.
Validaciones: proveedor nuevo debe existir y estar activo; rechaza si el
proveedor nuevo es igual al actual (evita ruido de auditoría vacío).
Auditoría vía `audit_log` (acción `reasignar_proveedor_oc`), dentro de
`db.withTransaction`, con proveedor anterior/nuevo (id + nombre) y motivo
opcional.

**Archivos y funciones tocadas:**
- `server/app.js` — endpoint nuevo `PATCH
  /api/projects/:id/ordenes/:ocId/proveedor` (~línea 8453-8493).
- `public/app.js` — `openOrdenDetalle()` agrega botón "✏️ Reasignar" junto
  al nombre del proveedor, visible solo si `isAdmin()`; función nueva
  `openReasignarProveedorModal(oc, onSaved)` (~línea 7645-7699): carga
  catálogo de proveedores, `<select>` con el proveedor actual
  preseleccionado, campo de motivo opcional, confirmación explícita antes
  de llamar al endpoint.
- `tests/reasignar-proveedor-oc.test.js` — nuevo, 234 líneas.

**Detalle de implementación no trivial, documentado en el propio
comentario del código** (`public/app.js`) — un bug real encontrado y
corregido durante el desarrollo: el motivo debe leerse **antes** de
`confirmDialog()`, porque `confirmDialog` hace su propio `openModal()`
que reemplaza el `innerHTML` de `#modal` completo y se lleva entre las
patas el `<textarea>` del motivo — leerlo después de confirmar regresa
`null` y el submit fallaría en silencio:
```js
// Leer el motivo ANTES de confirmDialog: confirmDialog hace su propio
// openModal(), que reemplaza el innerHTML de #modal y se lleva entre
// las patas el textarea — leerlo después regresa null y truena en
// silencio (nunca llega a llamar la API).
const motivo = $('#reasignarProveedorMotivo').value.trim() || undefined;
const ok = await confirmDialog(/* ... */);
```
Este es un patrón de bug genérico (orden de lectura del DOM vs. un modal
anidado que reemplaza el DOM) que vuelve a aparecer, de forma casi
idéntica, en PR #214 más abajo.

**Aplicabilidad a la demo:** **(a) portar tal cual** si la demo tiene el
mismo modelo de datos (`ordenes_compra.proveedor_id`, sin
denormalización en `pagos`/`recepciones`) — verificar esa condición antes
de portar, ya que es la premisa central del diseño (si en la demo
`proveedor_id` sí estuviera denormalizado en algún lado, el diseño
cambiaría). El bug de orden de lectura del DOM (motivo antes de
`confirmDialog`) es una lección aplicable en general a cualquier modal
con un motivo/comentario que se confirma con un diálogo anidado.

**Dependencias:** ninguna con otros PRs de este módulo.

---

## PR #214 — feature/fase2-bloqueo-confirmacion-sobreorden

**Fecha:** 2026-09-04 (merge commit `3e86c1c9`).

**Dependencia externa (fuera de este changelog):** este PR es
explícitamente la "Fase 2" de un flujo cuya "Fase 1A" (visibilidad de
sobre-orden — el campo `alerta_sobre_orden` y el cálculo de
`acumuladoPrevio` en `POST /requisiciones/:reqId/ordenes`) **ya estaba en
`main` antes de este PR** y **no forma parte de la lista de PRs asignada
a este archivo** — no se investigó a fondo, solo se confirma su
existencia previa leyendo el código base (`server/app.js`, función que
compone `computed`, ya calculaba `alerta_sobre_orden` antes de este PR).
Si se porta este PR a la demo, la demo necesita ya tener ese cálculo base
de "cuánto se ha ordenado ya vs. lo solicitado" — si no lo tiene, hay que
portar (o reconstruir) esa base primero.

**Qué problema resolvía:** antes de este PR, generar una Orden de Compra
que pedía más cantidad de un insumo que la disponible (solicitado menos
ya ordenado en OCs previas no canceladas de la misma requisición) se
permitía **en silencio** — solo quedaba una alerta informativa
(`alerta_sobre_orden`) en la respuesta, sin ningún gate. El negocio
necesita poder sobre-ordenar en casos legítimos (ej. desperdicio real
mayor al estimado), así que la solución **no** es un bloqueo duro, sino
exigir confirmación explícita con motivo.

**Diseño:** en `POST /api/projects/:id/requisiciones/:reqId/ordenes`, si
algún insumo de la OC a crear excede lo disponible, el endpoint responde
`409` con el detalle exacto de qué insumos exceden y por cuánto (código,
concepto, unidad, disponible, cantidad pedida, exceso) **en vez de** crear
la OC. El cliente puede reintentar mandando `confirmar_sobreorden: true` +
`motivo` (string no vacío) — con eso, sí crea la OC y además escribe una
entrada en `audit_log` (`confirmar_sobreorden_oc`: actor, requisición,
excedentes, motivo). El endpoint ya estaba restringido al rol `compras`
(+ bypass admin/desarrollador de `auth.allow()`), así que ningún otro rol
llega siquiera a ver este `409` — recibe `403` antes.

En el frontend, dos piezas de diseño reusables:
1. `api()` (el wrapper genérico de fetch de toda la app) ahora preserva
   `err.status` y `err.data` en el objeto `Error` que lanza, sin cambiar
   el comportamiento de ningún otro caller existente (todos siguen
   pudiendo leer solo `err.message` como antes) — es un cambio
   estrictamente aditivo al wrapper central.
2. El body del formulario "Generar OC" se captura **una sola vez**, antes
   de cualquier posible reemplazo de modal — mismo bug/lección que en PR
   #211: si hay sobre-orden, el modal de confirmación reemplaza el DOM
   del formulario original vía `openModal()`, así que el reintento
   **nunca** vuelve a leer `#ocItems`/`#ocProveedor`/etc. (ya no
   existirían) — reusa el body ya capturado, solo agregándole
   `confirmar_sobreorden`/`motivo` encima.

**Archivos y funciones tocadas:**
- `server/app.js` — `POST /api/projects/:id/requisiciones/:reqId/ordenes`
  (~línea 8358-8455): agrega `insumo_codigo`/`insumo_concepto`/`unidad`/
  `disponible` al cómputo por item; bloque nuevo que arma `excedentes` y
  responde `409`/`400` según corresponda; `INSERT` a `audit_log` dentro
  de la misma transacción que crea la OC, solo si hubo excedentes.
- `public/app.js` — `api()` (~línea 927-937, agrega `err.status`/
  `err.data`); `openGenerarOrdenModal()` refactorizado: lógica de armar y
  enviar el body extraída a `crearOrdenCompra(body)` (async, reintentable);
  función nueva `mostrarConfirmacionSobreOrdenModal(excedentes,
  onConfirmar)` — lista los insumos que exceden, motivo obligatorio
  (botón deshabilitado hasta que haya texto), llama `onConfirmar(motivo)`
  que reintenta `crearOrdenCompra({ ...body, confirmar_sobreorden: true, motivo })`.

**Fragmento clave** (`server/app.js`, el gate):
```js
const { confirmar_sobreorden, motivo } = req.body || {};
if (excedentes.length > 0) {
  if (confirmar_sobreorden !== true) {
    return res.status(409).json({ error: '...', excedentes });
  }
  if (!motivo || !motivo.trim()) {
    return res.status(400).json({ error: 'Indica un motivo para confirmar la sobre-orden.' });
  }
}
```

**Aplicabilidad a la demo:** **(b) portar adaptado** — requiere que la
demo ya tenga (o se le porte primero) el cálculo base de "acumulado ya
ordenado vs. solicitado" descrito en la dependencia externa arriba. Si esa
base ya existe, el gate de confirmación en sí (409 + reintento con
motivo) es un patrón limpio y portable tal cual. El patrón de
`api()` preservando `err.status`/`err.data` de forma aditiva es
reutilizable en general para cualquier otro endpoint de la demo que
necesite un flujo de "error estructurado → modal de confirmación →
reintento".

**Dependencias:** depende conceptualmente de una "Fase 1A" (visibilidad de
sobre-orden) que ya estaba en `main` antes de este PR y que **no forma
parte de la lista de PRs de este módulo** — dependencia externa, no
investigada a fondo, solo confirmada su existencia previa en el código
base. Comparte con PR #211 el mismo patrón de bug (leer un campo de texto
del DOM antes de que un modal anidado lo reemplace).
