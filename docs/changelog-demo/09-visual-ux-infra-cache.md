# Visual/UX, Permisos Varios, Infraestructura y Cache

Changelog de los últimos ~20 días de PRs mergeados a `main` en App-CP,
módulo "Visual/UX, Permisos Varios, Infraestructura y Cache". Escrito para
que una sesión de Claude Code trabajando en el repo hermano App-CP-Demo
pueda decidir, por cada entrada, si portar el cambio y cómo adaptarlo, sin
tener que re-investigar el historial de App-CP.

Convenciones: los hashes de PR normales son commits de **merge** (2 padres);
el diff completo de cada uno se obtuvo con `git diff <hash>^1 <hash>^2`. No
se incluyen nombres reales de personas/clientes/proveedores ni montos
reales — se usan placeholders genéricos donde el original los tenía.

---

## PR #169 — feat/checkbox-circular-diseno

**Fecha**: 2026-08-20 (commit merge `51547d799d8f8f9f2cce5e9e080b982837147cc2`)

**1-2. Qué resolvía**: puramente estético. El checkbox nativo (cuadrado,
render dependiente del navegador/SO) del modal "Crear presupuesto desde
catálogo" (selección de conceptos por fila + "seleccionar todos los
visibles") desentonaba con el resto del look & feel de la app.

**3. Diseño**: reemplazar el `<input type="checkbox">` visible por un patrón
"input real oculto + `<span>` hermano pintado por CSS" — el input sigue
existiendo (posicionado con `opacity:0` superpuesto, **nunca**
`display:none`, para conservar foco de teclado/lector de pantalla), y un
`<span class="checkbox-circle-visual">` decorativo se pinta vía el selector
`input:checked + span`. Cero cambio de lógica JS de selección — es
puramente CSS + wrapping de markup.

**4. Archivos/funciones**:
- `public/app.js` — dentro de `openCrearPresupuestoModal(catalogoOriginal)`: la fila `renderRows()` (checkbox por concepto) y el `<th>` de "seleccionar todos los visibles" (`#cpSelAllVisibles`).
- `public/styles.css` — nuevas reglas `.checkbox-circle`, `.checkbox-circle-visual`, y sus estados `:checked` / `:focus-visible` (~35 líneas nuevas, ninguna regla existente tocada).

**5. Fragmento clave** (antes → después, en `app.js`):
```js
// antes
<td><input type="checkbox" class="cp-check" data-idx="${idx}" ... /></td>
// después
<td><label class="checkbox-circle"><input type="checkbox" class="cp-check" data-idx="${idx}" ... /><span class="checkbox-circle-visual"></span></label></td>
```
CSS nuevo (resumen): círculo visual de 18px dentro de una área clicable de
28px (mínimo táctil), `border-radius: var(--radius-circle)`, reusa
`var(--accent-gold)` / `var(--border-color)` / `var(--shadow-glow-accent)` /
`var(--shadow-ring-accent-focus)` — **cero hex nuevo**, por lo que funciona
en las 4 paletas (Dorada/Morada/Verde/Naranja) y dark/light sin código
adicional por paleta.

**6. Aplicabilidad a demo**: **(a) portar tal cual**. Es CSS + wrapping de
markup puro, sin lógica de negocio ni dependencia de datos reales. Si la
demo tiene un modal equivalente de selección múltiple por checkbox, el
mismo patrón aplica directo. Único prerrequisito: que existan las variables
CSS reusadas (`--accent-gold`, `--border-color`, `--shadow-glow-accent`,
`--shadow-ring-accent-focus`, `--radius-circle`, `--ease-out`) — si la demo
tiene nombres de variables distintos, adaptar solo esos tokens.

**7. Dependencias**: ninguna con otras entradas de este documento.

---

## PR #170 — fix/visibilidad-desarrollador-clientes-proyectos

**Fecha**: 2026-08-20 (commit merge `d73065dd999f26cc7ba9f4c6a108d150a63dbfff`)

**2. Qué resolvía**: un usuario con rol `desarrollador` creaba un cliente y
una obra nuevos desde el modal "Crear presupuesto desde catálogo" — el
toast confirmaba éxito, pero al navegar a la galería de clientes no
aparecía nada. Confirmado con datos reales de producción que los registros
sí existían y estaban correctamente vinculados (backend nunca falló) — bug
100% de visibilidad.

**3. Causa raíz (2 bugs compuestos)**:
- `GET /api/clientes` y `GET /api/projects` en `server/app.js` tenían un
  bypass "ver todo" que solo comprobaba `puesto === 'admin'`, dejando fuera
  a `'desarrollador'` — inconsistente con ~20 checks idénticos en el resto
  del codebase que tratan ambos puestos como equivalentes. Para cualquier
  puesto que no sea literalmente `admin`, la query usa un `INNER JOIN`
  contra `usuario_proyectos`, y **ningún** flujo de creación de proyecto
  (ni subida de `.xlsx`, ni "Crear presupuesto desde catálogo") inserta esa
  fila para el creador.
- El modal de éxito tampoco refrescaba el estado en memoria del frontend
  (`state.clientes`/`state.projects`, poblados solo en `bootApp()`).

**4. Archivos/funciones**: `server/app.js` (`GET /api/clientes`,
`GET /api/projects`); `public/app.js` (handler de éxito dentro de
`openCrearPresupuestoModal`).

**5. Fragmento clave**:
```js
// server/app.js — antes
if (req.user.puesto === 'admin') { /* ...sin filtro... */ }
// después
if (req.user.puesto === 'admin' || req.user.puesto === 'desarrollador') { /* ...sin filtro... */ }
```
```js
// public/app.js — agregado tras el POST exitoso
await Promise.all([refreshClientList(), refreshProjectList()]);
```

**6. Aplicabilidad a demo**: **(c) no aplica directamente / (b) portar
adaptado con precaución**. El fix de este PR fue **superado por PR #174**
(ver abajo), que reemplaza este mismo `if` por un criterio más fino. Si la
demo tiene el rol `desarrollador` y el mismo patrón de bypass admin-only,
**no portar #170 de forma aislada** — portar directamente el estado final
de #174, que ya incluye y corrige este caso.

**7. Dependencias**: **superado por PR #174** — ver esa entrada para el
estado final correcto. No portar #170 sin #174.

---

## PR #174 — fix/usuario-proyectos-bypass-desarrollador

**Fecha**: 2026-08-21 (commit merge `000fc2ff331c1091c5d6889b5e6a90c9293fc34c`)

**2. Qué resolvía**: un usuario con `usuario_proyectos` limitado a un
subconjunto de obras de un cliente veía **todas** las obras de ese cliente
en "Presupuestos cargados", incluyendo controles administrativos
("Cambiar cliente"/"Eliminar") — exposición de datos financieros y de
control a un usuario sin permiso real.

**3. Causa raíz — más antigua y más amplia que la hipótesis inicial**: el
prompt original sospechaba que PR #170 era la causa (agregó
`desarrollador` al bypass de `GET /api/clientes`/`GET /api/projects`).
Confirmado con evidencia HTTP real que la sospecha era **parcialmente
correcta pero incompleta**: `server/auth.js:verificarAccesoObra` — la
función que gatea el acceso a una obra en la mayoría de endpoints
por-obra de **toda la app** (nóminas, requisiciones, finanzas, contratos,
avances...) — ya tenía este mismo bypass incondicional desde un commit
**seis semanas anterior a PR #170** (`d01825f0`, 2026-07-08). No era solo
un bug de listado/UI: era un IDOR de lectura/escritura sobre cualquier obra
para cualquier usuario `puesto = 'desarrollador'`, sin importar su
asignación real en `usuario_proyectos`. Prueba directa documentada en el PR:
un `desarrollador` de prueba restringido a 2 obras obtenía `200` al pedir
una tercera obra no asignada, donde un `residente` con la misma asignación
obtenía `403`.

**4. Archivos/funciones tocados** (7 puntos con el mismo patrón corregido):
1. `server/auth.js` → `verificarAccesoObra` (el más grave — IDOR real).
2. `server/app.js` → `GET /api/clientes`, `GET /api/projects` (los 2 de PR #170).
3. `server/app.js` → `GET /api/dashboard-ejecutivo`.
4. `server/app.js` → `getObrasDelClienteParaUsuario()`.
5. `server/app.js` → `getProgramaSuministrosData()`.
6. `server/app.js` → `PUT /api/clientes/:id/fondo-garantia` (mutación — un `desarrollador` restringido podía escribir en obras de cualquier cliente).
7. `server/db.js` → nuevo helper compartido `usuarioTieneAsignacionExplicita(usuarioId)`.

**5. Fragmento clave**:
```js
// server/db.js — helper nuevo, compartido entre los 3 puntos que lo necesitan
async function usuarioTieneAsignacionExplicita(usuarioId) {
  const { rows } = await pool.query(
    'SELECT EXISTS(SELECT 1 FROM usuario_proyectos WHERE usuario_id = $1) AS existe',
    [usuarioId]
  );
  return rows[0].existe;
}
```
```js
// server/auth.js — verificarAccesoObra, antes vs después
// antes
if (req.user.puesto === 'admin' || req.user.puesto === 'desarrollador') return next();
// después
const veTodo = req.user.puesto === 'admin'
  || (req.user.puesto === 'desarrollador' && !(await db.usuarioTieneAsignacionExplicita(req.user.id)));
if (veTodo) return next();
```
Criterio final: `admin` ve todo siempre, sin excepción. `desarrollador` ve
todo **solo si no tiene ninguna fila** en `usuario_proyectos` (preserva el
caso de #170: su propio cliente/obra recién creado, antes de que nadie le
asigne nada explícitamente) — en cuanto un admin le asigna obras, se
restringe igual que cualquier otro rol. El resto de roles no cambia.

**6. Aplicabilidad a demo**: **(b) portar adaptado, si la demo tiene el rol
`desarrollador` y el mismo mecanismo `usuario_proyectos`**. Si la demo no
distingue `desarrollador` de otros roles con este bypass, no aplica. Si sí
lo tiene, este es un fix de seguridad real (IDOR), no solo cosmético —
recomendable portarlo aunque la demo use datos ficticios, para no
reproducir el mismo patrón de bug si el código se deriva de aquí.

**7. Dependencias**: reemplaza/completa PR #170 — portar siempre juntos
(o directamente el estado final de #174, que ya incorpora el fix de #170).
Verificar primero si la demo tiene los mismos 7 puntos de bypass
`admin`/`desarrollador` antes de decidir el alcance de la adaptación.

---

## PR #185 — fix/scroll-lateral-tablas-modales-desktop

**Fecha**: 2026-08-24 (commit merge `2abc4d6d7f8b5a484efec61c16e307178da9e767`)

**2. Qué resolvía**: tablas de detalle dentro de ciertos modales (5-8
columnas, o con texto libre largo) quedaban con scroll horizontal forzado
en desktop porque el modal base tiene ancho fijo (`width: min(94vw, 520px)`).

**3. Diseño**: no fue necesario CSS nuevo — la clase `.modal-wide`
(`width: min(90vw, 920px)` dentro de `@media (min-width: 861px)`, el
breakpoint desktop ya establecido del proyecto) ya existía de un fix
anterior. El trabajo fue una auditoría de las ~85 funciones `open...Modal`
de `public/app.js` buscando tablas anchas sin `.modal-wide`, y agregar
`$('#modal').classList.add('modal-wide')` antes de `openModal(...)` en los
4 casos encontrados. `closeModal()` ya limpiaba la clase automáticamente al
cerrar, así que no había riesgo de que se "pegara" a otro modal.

**4. Archivos/funciones** (los 4 en `public/app.js`):
- `openVerNominaModal` (hasta 8 columnas: Trabajador/Días/Tarifa/Jornal/Destajo/2 cuentas bancarias/Total — caso original que motivó el prompt).
- `openHistoricoEstadoUnidadMaqModal` ("Checklist" con badges + "Observaciones" de texto libre).
- `pintarPreviewImportacionMovimientos` (columna "Descripción" con texto crudo de estado de cuenta bancario).
- `pintarPreviewImportacionMatrices` (2 columnas de precio + diff + estado/motivo).

Nota explícita del PR: `openVerEstimacionModal` y `openCrearPresupuestoModal`
ya tenían `.modal-wide` de un fix previo — no se tocaron, solo se
confirmó que ya estaban cubiertos.

**5. Fragmento clave** (mismo patrón repetido 4 veces):
```js
async function openVerNominaModal(nominaId) {
  $('#modal').classList.add('modal-wide');
  openModal(`<h3>Detalle de nómina</h3>...`);
  ...
}
```

**6. Aplicabilidad a demo**: **(a) portar tal cual, si `.modal-wide` ya
existe en la demo** — es un one-liner por función, sin dependencia de
datos reales. Si la demo no tiene aún la clase `.modal-wide`/el breakpoint
`861px`, es **(b) portar adaptado**: primero verificar/portar esa clase
base (de un fix anterior no documentado en este módulo), luego aplicar el
one-liner a los modales equivalentes que tengan tablas anchas.

**7. Dependencias**: depende de que exista la clase `.modal-wide` (de un
fix previo, anterior al rango de 20 días cubierto aquí — no documentado en
este changelog). Ninguna otra dependencia cruzada.

---

## PR #200 — feature/donut-color-gris

**Fecha**: 2026-09-02 (commit merge `02c1ecabd3d5da1f84fbdb93b7fd1a8ce057e101`)

**2. Qué resolvía**: dos cosas distintas bajo un solo PR (el nombre de la
rama refleja la intención original, no el resultado final — ver más abajo):
1. El tooltip nativo de Chart.js del donut "Avance Físico-Financiero"
   (Resumen por obra) se dibujaba **dentro** del propio `<canvas>` (140px,
   recortado) y se empalmaba visualmente con el número central ("36.3%
   EJECUTADO").
2. El PR había experimentado con un color slate/taupe apagado para el
   segmento "Programado por ejecutar" (de ahí el nombre de la rama,
   `donut-color-gris`), pero **se revirtió a dorado** (`#eab308`, el
   mismo valor de siempre) tras decisión explícita de Paul al verlo en
   pantalla — el PR mergeado deja el color exactamente como estaba antes,
   solo cambia el *mecanismo* (variable semántica en vez de hex hardcodeado).

**3. Causa raíz (tooltip)**: el tooltip default de Chart.js sin `external`
se dibuja vía 2D context dentro del canvas, recortado a sus 140×140px
reales (cutout 62% → banda visible de solo ~27px de ancho) — no es un
`<div>` posicionable con CSS, así que ningún ajuste de `positioner`/`align`
lo saca de encima del texto central (que sí es un overlay HTML/CSS aparte,
`.donut-center`). Único fix real: la opción `external` de Chart.js
(recipe documentada, no un rewrite del plugin) — reemplaza el dibujo en
canvas por un `<div>` normal posicionado con CSS, anclado siempre debajo
del donut completo.

**Diseño (color)**: se introduce la variable semántica `--donut-atraso`
(en vez de seguir hardcodeando `'#eab308'` en el dataset de Chart.js) para
no perder el punto de extensión si el color se revisita después — el valor
en sí queda igual a como estaba.

**4. Archivos/funciones**:
- `public/styles.css` — nueva variable `--donut-atraso: #eab308;`; se retira el glow dorado viejo (`filter: drop-shadow` scoped a `html[data-palette="dorada"]:not([data-theme="light"]) #chartResumenDona`, ya reemplazado por el "anillo interior fino" del rediseño de donuts); nueva clase `.donut-tooltip` + `.donut-tooltip-swatch` (tooltip externo).
- `public/app.js` — `chartColors()` (agrega `atraso: v('--donut-atraso')`), nueva función `externalDonutTooltip(context)`, `applyChartTheme()` (re-deriva el color del segmento en hot-swap de tema/paleta vía `chart._cpAtrasoBgIndex`), y el bloque de creación del chart `chartResumenDona` dentro de `renderInicio()` (rediseño completo: `responsive:false` + `cutout:'62%'`, deja de usar `.chart-wrap` genérico y pasa a `.donut-canvas-wrap` + `.donut-center` + `.global-chart-kpis`, mismo patrón "Opción 2" que ya usaba el donut global `#globalPieChart`).

**5. Fragmento clave**:
```js
// Antes: tooltip nativo, dentro del canvas
tooltip: { callbacks: { label: (c) => `${c.label}: ${fmtMoney(c.raw)}` } },
// Después: tooltip externo, <div> con CSS
tooltip: { enabled: false, external: externalDonutTooltip },
```
```js
// dataset backgroundColor — antes vs después
backgroundColor: ['#22c55e', '#eab308', cc.grid],          // antes
backgroundColor: ['#22c55e', cc.atraso, cc.grid],           // después (cc.atraso = var(--donut-atraso), mismo valor)
```

**6. Aplicabilidad a demo**: **(b) portar adaptado**. El fix de tooltip
(`external` + `.donut-tooltip`) es genérico y reutilizable si la demo tiene
el mismo problema de tooltip empalmado en cualquier donut Chart.js chico —
portar el patrón `externalDonutTooltip()` completo. El cambio de color es
**(c) no aplica** tal cual (es una decisión de producto de Paul específica
de App-CP) — si la demo ya tiene su propio color para este segmento,
dejarlo como está; si se porta, portar solo el *mecanismo* de variable
semántica, no forzar el valor `#eab308` si la demo usa otra paleta base.

**7. Dependencias**: depende del rediseño previo de donuts ("Opción 2",
`.donut-canvas-wrap`/`.donut-inner-ring`/`.donut-center`) — anterior al
rango de 20 días, no documentado en este módulo. Si la demo no tiene ese
rediseño base, portar el tooltip externo por separado, adaptado a la
estructura de donut que sí exista ahí.

---

## PR #208 — fix/selector-wrapper-boton-confirmar

**Fecha**: 2026-09-02 (commit merge `0662d788e887d263cae3a26971da9d1222702167`)

**2. Qué resolvía**: dos bugs con la misma causa raíz:
- El botón "Confirmar actualización" del preview de actualización de
  presupuesto nunca se habilitaba, sin importar qué eligiera el usuario en
  los selects de resolución de precio/cantidad ambiguos.
- Cada cambio de estado de una sugerencia (panel admin) disparaba un
  **segundo** PATCH espurio con `id: NaN` y `estado: undefined`, mostrando
  un toast de error confuso justo después del de éxito.

**3. Causa raíz**: `enhanceSelect()` (rollout global de selects
personalizados) envuelve cada `<select>` en un `<div class="custom-select
${select.className}">` que **hereda la misma clase CSS** que el select
original (por diseño, para preservar layout). Dos consumidores hacían
`document.querySelectorAll('.clase-del-select')` genérico (sin calificar
por tag) para leer `.value` — ese query también capturaba el `<div>`
wrapper (sin `.value` nativo → siempre `undefined`), contaminando tanto el
chequeo de "faltan selecciones" como el listener de `change` (que
burbujea desde el select real hasta el wrapper). El PR incluye además una
búsqueda exhaustiva del mismo patrón en todo `app.js`: 3 ocurrencias más
usan el mismo selector genérico pero leen el valor vía `e.target` dentro
del handler (no una variable de closure) — esas resuelven siempre al
`<select>` real sin importar en qué elemento se disparó el evento, así que
eran falsos positivos y no se tocaron.

**4. Archivos/funciones**: `public/app.js` —
`pintarPreviewActualizacionPresupuesto()` (línea ~6370, variable
`selectsResolucion`) y `renderSugerencias()` (línea ~9260, listener sobre
`.sug-estado-select`).

**5. Fragmento clave**:
```js
// antes (captura también el <div class="custom-select select-resolucion-precio-cantidad">)
const selectsResolucion = () => Array.from(document.querySelectorAll('.select-resolucion-precio-cantidad'));
// después (califica por tag, solo el <select> real)
const selectsResolucion = () => Array.from(document.querySelectorAll('select.select-resolucion-precio-cantidad'));
```
```js
// mismo patrón en renderSugerencias()
$$('.sug-estado-select', view).forEach((sel) => { ... });        // antes
$$('select.sug-estado-select', view).forEach((sel) => { ... });   // después
```

**6. Aplicabilidad a demo**: **(a) portar tal cual, si la demo usa el mismo
`enhanceSelect()`**. Es un bug de precisión de selector, no de lógica de
negocio — si la demo comparte el mismo enhancer de selects personalizados
(`custom-select` heredando la clase del select original), vale la pena
**grep proactivo** en el `app.js` de la demo por el mismo patrón
(`querySelectorAll`/`$$` con una clase que también podría estar en un
select envuelto, seguido de lectura de `.value` fuera de un handler con
`e.target`) — el propio PR advierte que este bug es fácil de reintroducir
en código nuevo que reutilice el mismo query genérico.

**7. Dependencias**: depende de que exista `enhanceSelect()` con el mismo
mecanismo de wrapping (`customSelectObserver`, `node.matches?.('select')`)
— si la demo no tiene selects personalizados, no aplica.

---

## Feature (sin PR propio, bundleado accidentalmente en PR #218): agregar 5ª paleta Tema ZAFIRO

**Fecha**: 2026-09-06 14:23 (commit `ea523713f054845754449ef64100277619ab25d0`)

**Nota de origen**: este commit se coló en la rama
`feature/fase2-cierre-mensual-pagos-oc` antes de su segundo merge (PR #218,
documentado en el módulo financiero de este changelog, **no en este**). Se
documenta aquí porque es puramente visual/de paleta y forma parte de la
saga Zafiro completa (ver las 3 entradas siguientes).

**2. Qué resolvía**: agregar una 5ª paleta de color ("Tema ZAFIRO", azul,
`#2563EB`) a las 4 ya existentes (Dorada/Morada/Verde/Naranja), para
consistencia de marca con la demo hermana (App-CP-Demo), que ya usa este
azul como color base.

**3. Diseño**: mismo patrón exacto de custom properties CSS que las 4
paletas existentes — bloque `[data-palette="azul"] { ... }` +
`[data-palette="azul"][data-theme="light"] { ... }`, sin tocar ninguna
paleta previa. Se agrega también la entrada correspondiente en
`PALETTE_META_COLORS` (color de la barra de estado del navegador/PWA en
móvil) y el botón selector dentro de `openMobileAjustes()`.

**4. Archivos/funciones tocados**:
- `public/styles.css` — nuevo bloque `[data-palette="azul"]` (dark, ~9 variables) y `[data-palette="azul"][data-theme="light"]` (~7 variables); nuevas reglas `.palette-swatch-azul span:nth-child(1/2/3)`.
- `public/app.js` — `PALETTE_META_COLORS.azul = { light: '#EAF1FB', dark: '#030916' }`; nuevo botón `<button class="palette-opt" data-palette-set="azul">Tema ZAFIRO</button>` dentro de `openMobileAjustes()`.

**5. Fragmento clave**:
```css
[data-palette="azul"] {
  --bg-primary: #030916; --bg-surface: #0A1830; --bg-surface-2: #142744;
  --border-color: #1F3A5C; --text-primary: #E8EEFC; --text-secondary: #93A8CC;
  --accent-gold: #2563EB; --accent-gold-hover: #3B82F6; --accent-silver: #6C86B8;
}
```
```js
<button class="palette-opt ${pal==='azul'?'active':''}" data-palette-set="azul">
  <span class="palette-swatch palette-swatch-azul"><span></span><span></span><span></span></span>
  Tema ZAFIRO
</button>
```

**6. Aplicabilidad a demo**: **(c) no aplica / ya existe** — según el
propio mensaje de commit, el azul `#2563EB` ya es la paleta base de la
demo hermana. Si la demo ya tiene su tema azul equivalente, esta entrada
es solo contexto histórico. Si por alguna razón la demo no lo tuviera
formalizado como una "paleta seleccionable" más, el diff sirve como
plantilla exacta de qué variables se necesitan.

**7. Dependencias — CADENA OBLIGATORIA con #223, #224 y #225 (ver nota
completa en la entrada de PR #225 más abajo)**: esta es la **pieza 1 de 4**.
Sin esta paleta, no hay nada que cachear ni que exponer en los selectores
estáticos — es el prerrequisito de toda la saga. Las 4 piezas deben
portarse juntas como una unidad atómica si se quiere Zafiro funcional en la
demo.

---

## PR #219 — fix/contraste-link-codigo-respaldo-2fa

**Fecha**: 2026-09-06 (commit merge `61bc386f020bda3eb0ceded37412c298af109f0e`)

**2. Qué resolvía**: el link "¿Perdiste el acceso? Usa un código de
respaldo" del modal de Verificación en dos pasos (TOTP) no tenía ninguna
regla CSS propia y heredaba el azul default del navegador (`#0000EE`) —
ilegible sobre el fondo oscuro del modal.

**3. Causa raíz**: simple ausencia de clase — el link nunca recibió la
clase `.link-btn` ya existente y usada en otros links de la app
(`color: var(--accent-gold)`), que se adapta sola a las 5 paletas sin
hardcodear un color nuevo.

**4. Archivos/funciones**: `public/app.js` — `openTotpLoginModal()`.

**5. Fragmento clave**:
```html
<!-- antes -->
<a href="#" id="linkUseBackupCode">¿Perdiste el acceso? Usa un código de respaldo</a>
<!-- después -->
<a href="#" id="linkUseBackupCode" class="link-btn">¿Perdiste el acceso? Usa un código de respaldo</a>
```
Verificado con Playwright: dark `#C9A24B` sobre `#121110` (buen contraste),
light `#A97F2E` sobre crema.

**6. Aplicabilidad a demo**: **(a) portar tal cual, si la demo tiene 2FA
TOTP con un modal equivalente y la clase `.link-btn` ya existe**. Cambio de
una sola clase, sin lógica. Nota de contexto (no relevante para portar,
pero explica el número de versión visto en otros diffs): el `SW_VERSION`
de este PR saltó de v416 a v418 porque v417 ya estaba tomado por PR #218
(rama distinta, aún sin mergear en ese momento) — mismo tipo de colisión
que documenta la memoria del proyecto sobre conflictos de `SW_VERSION`.

**7. Dependencias**: ninguna con el resto de este documento. Nota: la app
de origen tiene 2FA/TOTP como **opcional-con-recordatorio** desde julio
2026 (no obligatorio) — este fix aplica igual sin importar esa política,
ya que el modal de verificación en dos pasos sigue existiendo tal cual para
usuarios que sí lo tienen inscrito.

---

## PR #221 — feat/buscador-usuarios

**Fecha**: 2026-09-06 (commit merge `4f635a1a4558191f86be17d8818b97efe7f19978`)

**2. Qué resolvía**: la lista de Usuarios (Administración → Usuarios →
Cuentas) no tenía forma de filtrar por texto — con muchos usuarios reales,
encontrar uno específico requería scroll manual.

**3. Diseño**: reutiliza el componente `.search-bar-fancy` +
`normalizarTexto()` (case-insensitive, sin acentos) ya usado en
Requisiciones/OC (PR #210, anterior a este módulo) y en Conceptos — cero
CSS/JS nuevo de componente, solo wiring de filtrado sobre la lista ya
cargada en memoria. Filtra por `nombre` y `usuario` (username) combinados.
Se agrega arriba del subnav Cuentas/Permisos existente, sin reemplazarlo
ni tocar su lógica.

**4. Archivos/funciones**: `public/app.js` — `renderUsuarios(view,
initialSubView)`, función interna nueva `aplicarUsuariosFiltro(raw)`.

**5. Fragmento clave**:
```js
function aplicarUsuariosFiltro(raw) {
  const q = raw.trim();
  $('#usuariosSearchWrap').classList.toggle('has-value', !!q);
  if (!q) { paintUsuariosList(usuarios); return; }
  const norm = normalizarTexto(q);
  const filtrados = usuarios.filter((u) => normalizarTexto(`${u.nombre || ''} ${u.usuario || ''}`).includes(norm));
  if (!filtrados.length) {
    $('#usuariosList').innerHTML = `<div class="empty-state">Sin resultados para "${esc(q)}".</div>`;
    return;
  }
  paintUsuariosList(filtrados);
}
```
Markup nuevo: `<div class="search-bar-fancy" id="usuariosSearchWrap">` con
input `#usuariosSearchInput` y botón de limpiar `#btnClearUsuariosSearch`;
se oculta (`hidden-initial`) si no hay usuarios que listar.

**6. Aplicabilidad a demo**: **(a) portar tal cual, si la demo ya tiene el
componente `.search-bar-fancy` + `normalizarTexto()`** (de PR #210,
Requisiciones/OC — anterior al rango de este módulo, verificar si ya se
portó). Si no existe ese componente base en la demo, es **(b) portar
adaptado**: primero portar (o construir) el componente genérico, luego
este wiring específico de Usuarios.

**7. Dependencias**: depende de `.search-bar-fancy` y `normalizarTexto()`
(de PR #210, no documentado en este módulo — pertenece a otro rango/PR
anterior). Ninguna dependencia con la saga Zafiro ni con otras entradas de
este archivo.

---

## PR #223 — fix/vercel-cdn-cache-control-no-store (INTENTO DESCARTADO — no funcionó)

**Fecha**: 2026-09-06 (commit merge `e01bc119fea77146cc2ffd8acc8fcaad00f8cfbd`)

**2. Qué intentaba resolver**: Zafiro (paleta agregada en `ea52371`, ver
arriba) no se veía en producción tras el deploy — se sospechó cache viejo
del CDN de Vercel sirviendo una versión anterior de `app.js`/`styles.css`.

**3. Diseño del intento**: agregar el header `Vercel-CDN-Cache-Control:
no-store` (mecanismo específico de Vercel para instruir a su propio edge,
separado del navegador) a los bloques de `/app.js`, `/styles.css`, `/sw.js`,
`/index.html` y `/` en `vercel.json` — motivado por diagnóstico en vivo que
confirmó `X-Vercel-Cache: HIT` con `Age` creciendo en tiempo real en
`/app.js` de producción, **pese a** que `Cache-Control: public, max-age=0,
must-revalidate` ya estaba declarado (ese header solo gobierna al
navegador, no al edge). Se evaluaron y descartaron 2 alternativas más
invasivas en el mismo PR: redeploy vacío (funciona pero es solo un parche
puntual, no permanente) y hash-busting de nombre de archivo (la solución
"de libro", pero vista como demasiada arquitectura nueva para el momento,
con riesgo de conflictos de merge en más archivos, similar a los ya
vividos con `SW_VERSION`).

**RESULTADO REAL — ESTE INTENTO NO FUNCIONÓ.** Evidencia documentada en el
commit del PR siguiente (#224): tras el merge de #223,
`X-Vercel-Cache` siguió en `HIT` con `Age` creciendo exactamente igual
(`Age: 0→1→2→3→4→4`, `MISS→HIT→HIT→HIT→HIT→HIT`) — el header
`Vercel-CDN-Cache-Control: no-store` **no tuvo el efecto esperado** sobre
el edge de Vercel en este caso.

**4. Archivos tocados**: `vercel.json` — bloques `/app.js`, `/styles.css`,
`/sw.js`, `/`, `/index.html`, cada uno con `{ "key":
"Vercel-CDN-Cache-Control", "value": "no-store" }` agregado.

**5. Fragmento** (agregado, luego demostrado insuficiente):
```json
{
  "source": "/app.js",
  "headers": [
    { "key": "Cache-Control", "value": "public, max-age=0, must-revalidate" },
    { "key": "Vercel-CDN-Cache-Control", "value": "no-store" },
    ...
  ]
}
```

**6. Aplicabilidad a demo**: **(c) NO APLICA / NO PORTAR esperando que
resuelva un problema de cache similar**. Este es el hallazgo más importante
de la saga para quien porte a la demo: si la demo tiene un problema
parecido de CDN sirviendo assets viejos, **este header específico
(`Vercel-CDN-Cache-Control: no-store`) ya se probó en producción real y no
funcionó** — no repetir este enfoque esperando otro resultado. El fix que
sí funcionó es el de PR #224 (hash-busting de contenido), documentado a
continuación.

**7. Dependencias — pieza 2 de 4 de la cadena Zafiro (ver detalle completo
en la entrada de PR #225)**: sin cache-busting *correcto* (que llegó recién
en #224, no aquí), el navegador nunca llega a ver el código nuevo de
Zafiro sin importar cuántas paletas se agreguen al CSS/JS. Aun siendo un
intento fallido, es parte de la cadena histórica y debe documentarse junto
con las otras 3 piezas para que quien porte a la demo entienda por qué
existe el PR #224 inmediatamente después.

---

## PR #224 — fix/cache-hash-buildcommand (EL FIX REAL DE CACHE)

**Fecha**: 2026-09-07 (commit merge `076273df9459f084ab25a778d8b9cee50a49d353`,
commit interno rico en contexto: `4bdb9ffa67717f2ecf953aa2473d3069540da4c6`)

**2. Qué resolvía**: lo mismo que #223 intentó resolver (Zafiro no visible
en producción por assets viejos servidos por el edge de Vercel) — esta vez
con éxito confirmado.

**3. Causa raíz / diseño — fuente principal: el mensaje de commit de
`4bdb9ff`, inusualmente detallado**:
- La Opción A (`Vercel-CDN-Cache-Control: no-store`, PR #223) se descartó
  con evidencia real: no funcionó.
- Solución elegida: **hash-busting de contenido en build time**. Nuevo
  script `scripts/hash-static-assets.js` que corre **solo** dentro del
  `buildCommand` declarado en `vercel.json` — nunca en `npm run dev`, nunca
  se commitea a git. Genera `app.<hash>.js` y `styles.<hash>.css` (hash =
  primeros 10 caracteres de un sha256 del contenido del archivo) y
  reescribe las referencias correspondientes en `index.html` y `sw.js`,
  todo dentro del checkout efímero del build de Vercel. Con URL inmutable
  por contenido, cachear agresivamente deja de ser un bug: cada hash nuevo
  es una URL nueva, ningún edge puede servir contenido viejo bajo un nombre
  que cambió — por eso los archivos hasheados usan
  `Cache-Control: public, max-age=31536000, immutable`.
- Por qué **no** commitear los archivos con hash a git (alternativa
  descartada): `app.js` cambia en casi cada commit de este proyecto —
  acumularía cientos de copias de ~1.2MB en el repo. Al vivir solo dentro
  del build de Vercel, nunca toca el working tree ni git, y `index.html`/
  `sw.js` trackeados en git siguen referenciando `/app.js` sin hash — `npm
  run dev` nunca corre este script, así que el dev local no se
  desincroniza.
- Viabilidad confirmada empíricamente **antes** de escribir el script real:
  un `buildCommand` de prueba con un archivo marcador demostró que Vercel
  sí ejecuta `buildCommand` y el resultado llega a lo desplegado.
- El script falla ruidosamente (`throw`) si una referencia esperada
  (`src="/app.js"`, `href="/styles.css"`, etc.) no se encuentra en
  `index.html`/`sw.js` — evita un build "silenciosamente roto" si alguien
  cambia esas referencias sin actualizar el script.

**4. Archivos/funciones**:
- `scripts/hash-static-assets.js` (nuevo, 68 líneas) — funciones `hashFile()`, `hashAndCopy()`, `rewriteReferences()`.
- `vercel.json` — nuevo campo `"buildCommand": "node scripts/hash-static-assets.js"`; 2 bloques de headers nuevos para `/app.(.*).js` y `/styles.(.*).css` con `Cache-Control: public, max-age=31536000, immutable`. Los bloques viejos (`/app.js`, `/styles.css` sin hash, con `Vercel-CDN-Cache-Control: no-store` de #223) se dejaron intactos — inofensivos, ya nada referencia esos nombres sin hash tras el build.

**5. Fragmento clave**:
```js
// scripts/hash-static-assets.js
function hashAndCopy(originalName) {
  const ext = path.extname(originalName);
  const base = originalName.slice(0, -ext.length);
  const originalPath = path.join(PUBLIC_DIR, originalName);
  const hash = hashFile(originalPath); // sha256, primeros 10 chars
  const hashedName = `${base}.${hash}${ext}`;
  fs.copyFileSync(originalPath, path.join(PUBLIC_DIR, hashedName));
  return hashedName;
}
const appHashedName = hashAndCopy('app.js');
const stylesHashedName = hashAndCopy('styles.css');
rewriteReferences('index.html', [
  ['src="/app.js"', `src="/${appHashedName}"`],
  ['href="/styles.css"', `href="/${stylesHashedName}"`],
]);
rewriteReferences('sw.js', [
  [`'/app.js'`, `'/${appHashedName}'`],
  [`'/styles.css'`, `'/${stylesHashedName}'`],
]);
```
```json
{ "buildCommand": "node scripts/hash-static-assets.js" }
```

**6. Aplicabilidad a demo**: **(a) portar tal cual, si la demo despliega en
Vercel y sirve `app.js`/`styles.css` como estáticos** (bypass de servidor
en producción, mismo modelo que App-CP). Es infraestructura de build,
independiente de cualquier dato o lógica de negocio real — buen candidato
para portar íntegro. Verificar antes de portar: que la demo tenga un solo
`app.js` y un solo `styles.css` referenciados de forma literal
(`src="/app.js"` / `href="/styles.css"`) en su `index.html`/`sw.js` — si la
demo ya usa un bundler con su propio hash-busting, este script es
redundante y no aplica.

**7. Dependencias — pieza 3 de 4 de la cadena Zafiro obligatoria (detalle
completo en la entrada de PR #225 inmediatamente siguiente)**: depende de
que la paleta ya exista en el código (pieza 1, `ea52371`) y es la pieza que
**sí** resuelve lo que #223 (pieza 2) intentó sin éxito — sin este fix, el
navegador seguía sirviendo una versión cacheada de `app.js`/`styles.css`
sin el código de Zafiro. Aun con este fix funcionando correctamente,
Zafiro **seguía sin verse en 2 de las 3 superficies de UI** — ver PR #225.

---

## PR #225 (EN PROGRESO, NO MERGEADO) — fix/paleta-zafiro-selectores-estaticos

**Estado**: **abierto, pendiente de revisión** al momento de escribir este
documento (2026-09-07) — rama `fix/paleta-zafiro-selectores-estaticos`,
commit `154ca90007ff582d51aa2312e5b9a8cae017c44d`. **No tratar como
mergeado.** No se modificó nada de este PR al documentarlo (solo lectura,
`git show`).

**Fecha del commit**: 2026-09-07.

**2. Qué resuelve (si se mergea)**: aun con el cache-busting de PR #224
funcionando correctamente (hash servido == hash referenciado, contenido de
`app.js` confirmado con el código de Zafiro presente — verificado con
Playwright + curl contra producción, descartando cache como causa), Zafiro
seguía sin aparecer como opción en 2 de los 3 lugares donde el usuario
puede cambiar de paleta.

**3. Causa raíz**: el selector de paletas (`.palette-selector`) vive
duplicado en **3 lugares** del frontend:
1. `openMobileAjustes()` en `public/app.js` — modal dinámico generado en
   JS para la nav móvil. **Ya tenía** el botón de Zafiro (agregado en
   `ea52371`, junto con la paleta misma).
2. `#galleryDrawer` en `public/index.html` — drawer de Ajustes en la
   galería de clientes. HTML **estático**, nunca actualizado.
3. `#userPopover` en `public/index.html` — popover de perfil del sidebar
   de **desktop**, el que efectivamente ve un usuario logueado en
   escritorio al hacer clic en su avatar. HTML **estático**, nunca
   actualizado.

El bug real no era de cache/build — era duplicación de fuente de verdad:
la paleta se agregó en un solo lugar (el generador dinámico) y se olvidó
replicar en los 2 bloques de HTML estático equivalentes. El propio PR nota
que es "mismo patrón ya visto esta sesión en `openRegistrarPagoModal` y
`CONTABILIDAD_TABS`" (referencias a otros módulos de este changelog, no
detalladas aquí).

**4. Archivos/funciones**: `public/index.html` — 2 bloques (`#galleryDrawer`
y `#userPopover`), cada uno recibe el mismo botón que ya existía en
`openMobileAjustes()` (8 líneas nuevas por bloque, 16 en total). El CSS
(`.palette-swatch-azul`) y el wiring de clics (listener genérico sobre
`[data-palette-set]`) ya existían — no se tocó JS.

**5. Fragmento clave** (idéntico en ambos bloques de `index.html`):
```html
<button class="palette-opt" data-palette-set="azul">
  <span class="palette-swatch palette-swatch-azul"><span></span><span></span><span></span></span>
  Tema ZAFIRO
</button>
```

**6. Aplicabilidad a demo**: **(a) portar tal cual — pero solo cuando se
decida portar Zafiro completo**, y **con la salvedad de que este PR sigue
sin mergear en App-CP** — revisar su estado antes de portar (podría
cambiar en revisión) y no asumir que ya es definitivo. Si la demo tiene su
propio selector de paletas duplicado en múltiples lugares (dinámico +
estático), aplicar el mismo diagnóstico: verificar que **todos** los
lugares donde se listan las paletas seleccionables tengan las mismas
opciones.

**7. Dependencias — CADENA OBLIGATORIA COMPLETA (las 4 piezas de la saga
Zafiro)**: esta es la **pieza 4 de 4**. Para que Zafiro funcione de punta a
punta en la demo, las 4 piezas deben portarse **juntas, en este orden, como
una sola unidad atómica**:
1. **`ea52371`** (paleta en sí — CSS + botón en `openMobileAjustes()`): sin
   esto no hay nada que mostrar ni cachear.
2. **PR #223** (`Vercel-CDN-Cache-Control: no-store`): intento de
   cache-busting que **no funcionó** — no portar esperando que resuelva
   nada; se documenta solo como contexto de por qué existe la pieza 3.
3. **PR #224** (hash-busting de contenido vía `buildCommand`): el fix de
   cache que **sí funciona** — sin esto, el navegador nunca llega a ver el
   código nuevo de la paleta sin importar cuántos lugares del frontend la
   referencien.
4. **PR #225** (este, EN PROGRESO): sin este último fix, Zafiro existe en
   el código y el navegador sí lo recibe (gracias a la pieza 3), pero
   **sigue sin aparecer** en 2 de las 3 superficies de UI reales
   (`#galleryDrawer` y `#userPopover` en desktop) — solo visible en la nav
   móvil.

**Recomendación explícita para quien porte a la demo**: portar las 4 piezas
juntas en una sola sesión/PR, no una por una en momentos distintos — el
valor de cada pieza intermedia (2 y 3 especialmente) solo se entiende en el
contexto de las otras 3, y portar solo un subconjunto reproduciría
exactamente el mismo período de "Zafiro no se ve" que se vivió aquí en
producción real durante el 2026-09-06/07.
