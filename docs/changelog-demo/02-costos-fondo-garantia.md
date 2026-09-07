# Sección de Costos, Fondo de Garantía y Finanzas de Maquinaria

Cobertura: PRs #153, #154, #155, #159, #161, #162, #163, #171, #192, #198,
#199 — mergeados a `main` de App-CP entre 2026-08-18 y 2026-09-01, en ese
orden cronológico. Todos verificados leyendo el diff real (`git diff
<merge>^1 <merge>^2`, o el commit individual cuando la rama se quedó atrás
de `main` y el diff de 2 padres traía ruido de PRs intermedios — ver nota en
cada entrada donde aplicó) y, cuando existía, la descripción del PR
(`gh pr view <N>`).

**Nota de anonimización**: dos entradas de este archivo (#171 y #198)
referencian nombres reales de clientes/proveedores que existían en el
código original de App-CP (una lista de 3 obras duplicadas de un cliente
real excluidas del catálogo, y el nombre de archivo de un fixture de test
con datos de un contrato real). Ambos se omitieron a propósito — no copiar
esos identificadores reales a la demo bajo ninguna circunstancia; usar
placeholders genéricos si se necesita un ejemplo equivalente.

Nota de contexto para quien porte esto a App-CP-Demo: **la sección "Costos"
nació y mutó mucho en 20 días** (nueva sección → 2 bugs urgentes de
navegación → nuevos tiles de dashboard → reubicación de un tab). Si la demo
ya tiene una versión más vieja o más nueva de esta sección, comparar contra
el estado final (después de #199), no aplicar cada PR a ciegas en orden —
varias líneas de código de un PR temprano quedan sobrescritas por uno
posterior (ejemplo: `SECTION_DEFS.costos.tabs` cambia de contenido en
#153, #161, #171 y #192).

---

## PR #153 — feat/costos-mapeo-mover-tiles — 2026-08-18

**Qué problema resolvía**: el rol `costos` (dado de alta en un PR anterior,
#149/#152, fuera de este módulo) no tenía forma de llegar a la vista de
Mapeo (vincular insumo↔concepto) ni de usar "Actualizar presupuesto" —
ambos vivían repartidos entre las secciones "Administración" y "Obra", que
`costos` no podía ver.

**Diseño**: en vez de darle a `costos` acceso a "Administración"/"Obra"
completas, se reubicaron 2 tabs puntuales:
- `mapeo` se mueve de `administracion` a `presupuestos` (la sección que en
  ese momento agrupaba Matrices/Costos/Composición de Costos).
- `ordenesCambio` se mueve de `obra` a `presupuestos`.

Esto es pura reubicación de `string` entre arrays de `SECTION_DEFS`
(`public/app.js`) — no toca ningún endpoint ni el mapa global `TAB_A_SECCION`.
Efecto colateral aceptado y documentado: `cabo` (único rol que tenía
`ordenesCambio` sin ningún otro tab de "Presupuestos") pierde su aterrizaje
directo a esa vista.

**Archivos y funciones tocadas**:
- `server/auth.js`: `PERMISSIONS.costos.tabs` gana `'mapeo'`. Dentro de
  `defaultPermisosParaRol()`, para el bloque `costos`: sube `puede_crear` en
  la fila `mapeo` (ya existía con `puede_ver` por el loop base), y agrega
  2 filas nuevas explícitas vía `filas.push()` — `presupuestos` (`puede_ver`,
  `puede_editar`) e `insumos` (`puede_ver`), porque ningún tab de `costos`
  mapea a esas 2 secciones vía `TAB_A_SECCION` (nota: el `filas.push()` de
  `presupuestos` se **elimina** más adelante, en #161 — ver esa entrada).
- `server/app.js`: se agrega `'costos'` al `auth.allow(...)` de 8 endpoints
  — `POST /api/projects/upload-token`, `GET /api/projects/:id/conceptos`,
  `POST .../presupuesto/actualizar/preview`, `POST .../actualizar/confirmar`,
  `GET/POST/DELETE /api/conceptos/:id/insumos*`, `GET
  /api/projects/:id/concepto-insumos/resumen`, `GET
  /api/projects/:id/insumos`. Todos eran endpoints que el frontend ya
  mostraba a `costos` pero que devolvían 403 real.
- `public/app.js`: nueva función `puedeVerMapeo()` (gate dedicado, no
  reusa `puedeGestionarUsuarios()` a propósito — esa función también gatea
  gestión real de cuentas). `SECTION_DEFS.obra.tabs` pierde `ordenesCambio`;
  `SECTION_DEFS.administracion.tabs` pierde `mapeo`; `SECTION_DEFS.presupuestos.tabs`
  gana ambos. `renderMapeo()` cambia su guard de `puedeGestionarUsuarios()`
  a `puedeVerMapeo()`. `ACCIONES_CON_ENFORCEMENT.presupuestos` gana
  `'puede_editar'`.

**Fragmento clave** (server/app.js, patrón repetido en los 8 endpoints):
```js
// antes:
app.get('/api/projects/:id/conceptos', h(auth.allow('residente', 'cabo', 'compras', 'tesoreria', 'administracion', 'logistica')), ...)
// después:
app.get('/api/projects/:id/conceptos', h(auth.allow('residente', 'cabo', 'compras', 'tesoreria', 'administracion', 'logistica', 'costos')), ...)
```

**Aplicabilidad a la demo**: (b) portar adaptado — el patrón (agregar
`'costos'` a `auth.allow()` en cada endpoint que el frontend ya expone al
rol) es reusable tal cual si la demo tiene el mismo rol `costos`; si la demo
no tiene ese rol o tiene una jerarquía de permisos distinta, no aplica.

**Dependencias**: requiere que exista el rol `costos` y la sección
`presupuestos` con Matrices/Catálogo de Costos/Composición de Costos — creados
en PRs anteriores (#149/#152), fuera de este módulo.

---

## PR #154 — feat/fondo-garantia-editable-panel — 2026-08-18

**Qué problema resolvía**: el % de Fondo de Garantía solo era editable desde
"Contrato" (admin/desarrollador-only). Tesorería podía **ver** el panel de
Fondo de Garantía pero no ajustar el % pactado sin pedirle a un admin que lo
cambiara en Contrato.

**Diseño**: decisión de negocio confirmada explícitamente (tesorería edita,
no solo ve). Se extrae la lógica de validación+upsert que antes vivía
inline en `POST /api/projects/contrato-confirm` a una función compartida
`upsertPorcentajeFondoGarantia(client, projectId, pct)`
(`server/finanzas.js`), reusada por 2 endpoints nuevos: edición por-obra y
edición masiva "todas las obras del cliente" (con confirmación explícita en
el frontend — no es un alcance que se alcance sin querer). Ambos aceptan un
`client` de transacción para poder correr dentro de un loop "todo o nada".

**Archivos y funciones tocadas**:
- `server/finanzas.js`: nueva función `upsertPorcentajeFondoGarantia`
  (exportada). No recalcula ni toca `fondo_garantia_monto` de estimaciones
  ya aprobadas — ese monto vive congelado como columna propia.
- `server/app.js`: `POST /api/projects/contrato-confirm` ahora delega el
  campo `porcentaje_fondo_garantia` a la función compartida. 2 endpoints
  nuevos: `PUT /api/projects/:id/fondo-garantia` (una obra) y `PUT
  /api/clientes/:id/fondo-garantia` (todas las obras del cliente, filtradas
  por `usuario_proyectos` si el rol no es admin/desarrollador — transacción
  única, todo o nada).
- `server/auth.js`: `defaultPermisosParaRol('tesoreria')` sube
  `puede_editar=true` en la sección `finanzas` (antes solo `puede_ver`).
- `server/db.js`: `UPDATE permisos_usuario SET puede_editar = true WHERE
  seccion = 'finanzas' AND usuario_id IN (...)` — backfill idempotente para
  usuarios `tesoreria` ya existentes (el default nuevo solo aplica a altas
  futuras).
- `public/app.js`: `ACCIONES_CON_ENFORCEMENT.finanzas` gana `'puede_editar'`.
  `renderFondoGarantia()` ahora también pide `/permisos/me` y muestra un
  botón "Editar %" condicionado a `permisos.finanzas.puede_editar`. Nueva
  función `openEditFondoGarantiaModal(porcentajeActual)` — modal con input
  numérico 0-15 y radio "Solo esta obra" / "Todas las obras de {cliente}
  (N obras)" (calculado 100% client-side desde `state.projects`, sin
  endpoint nuevo de listado).

**Fragmento clave** (server/app.js, el endpoint por-obra):
```js
app.put('/api/projects/:id/fondo-garantia', h(auth.allow('tesoreria')), h(requireProject), h(auth.verificarAccesoObra), h(auth.checkPermiso('finanzas', 'puede_editar')), h(async (req, res) => {
  const pct = await upsertPorcentajeFondoGarantia(db.pool, req.project.id, (req.body || {}).porcentaje);
  res.json({ porcentaje_pactado: pct, obras: [{ id: req.project.id, nombre: req.project.nombre }] });
}));
```

**Aplicabilidad a la demo**: (b) portar adaptado — el concepto (fondo de
garantía editable desde Tesorería, con alcance por-obra o por-cliente) es
genérico y no depende de datos reales; sí depende de que la demo tenga ya
el módulo base de Fondo de Garantía (endpoints `GET .../fondo-garantia`,
tabla `meta` con clave `porcentaje_fondo_garantia`) de un PR anterior fuera
de este módulo.

**Dependencias**: ninguna dentro de este módulo. Requiere el módulo base de
Fondo de Garantía (anterior a este listado).

---

## PR #155 — fix/etiqueta-fondo-garantia-porcentaje-real — 2026-08-18

**Qué problema resolvía**: tanto en la vista "Ver estimación" como en el PDF
exportado, la fila de descuento de Fondo de Garantía mostraba la etiqueta
fija `"2% Fondo de garantía"` sin importar el % real pactado.

**Causa raíz**: bug de sincronización directo introducido por #154 — antes
de ese PR el % era efectivamente siempre 2% (no editable), así que
hardcodearlo en el texto no importaba. Al volverse editable, el texto dejó
de reflejar la realidad.

**Fix**: en vez de volver a consultar `meta.porcentaje_fondo_garantia` de la
obra (que puede haber cambiado desde que se calculó esa estimación
específica), el % mostrado se **deriva** del propio monto ya persistido de
esa estimación: `fondo_garantia_monto / total_periodo * 100`. Así el texto
nunca se desincroniza del monto real ya congelado en esa fila, sin importar
cuántas veces cambie el % pactado de la obra después.

**Archivos y funciones tocadas**:
- `public/app.js`, `pintarVerEstimacion()`: nueva constante
  `fondoGarantiaPct` calculada a partir de `data.total_periodo` y
  `data.fondo_garantia_monto`; la celda de la tabla usa
  `${fmtPct(fondoGarantiaPct)} Fondo de garantía` en vez del string fijo.
- `server/estimacionesPdf.js`: misma lógica, nueva función helper
  `fondoGarantiaPctDe(estimacion)` y helper de formato `pct(n)`, usados en
  `buildEstimacionPdf()`.

**Fragmento clave** (idéntico en ambos archivos, solo cambia el contexto):
```js
const fondoGarantiaPct = data.total_periodo ? (data.fondo_garantia_monto / data.total_periodo) * 100 : 0;
// ...
`${fmtPct(fondoGarantiaPct)} Fondo de garantía`  // antes: '2% Fondo de garantía' fijo
```

**Aplicabilidad a la demo**: (a) portar tal cual — es un fix puntual de 2
archivos, sin dependencias de datos reales ni de arquitectura específica de
App-CP. Aplica siempre que la demo tenga Fondo de Garantía editable (o sea,
después de portar #154).

**Dependencias**: #154 (dentro de este mismo módulo) — el bug no existe sin
que el % sea editable.

---

## PR #159 — fix/costos-editar-fondo-garantia — 2026-08-19

**Qué problema resolvía**: el rol `costos` recibía `403` al intentar ver o
editar el % de Fondo de Garantía, pese a que Paul ya le había dado
`puede_editar=true` en la sección granular `finanzas` desde la matriz de
administración de permisos.

**Nota de investigación**: el diff directo `<merge>^1..<merge>^2` de este
PR sale "sucio" (300+ líneas tocando `calculos.js`, borrando un archivo de
test) porque la rama se creó antes de que 3 PRs intermedios (#156, #157,
#158) se mergearan a `main` — el diff de 2 padres incluye, por comparación
de árboles, la reversión aparente de esos PRs. El diff real y limpio de
este PR es el commit único `7acf70e` (`git show 7acf70e8...`), usado abajo.

**Causa raíz**: mismo patrón recurrente ya visto en #153 — `checkPermiso`
(la matriz granular) evaluaba correctamente `puede_editar=true` para
`costos`, pero el `auth.allow('tesoreria')` hardcodeado en los 3 endpoints
de Fondo de Garantía (introducidos en #154) cortaba con 403 **antes** de
llegar a esa evaluación. El permiso se guardaba y se exigía de verdad, pero
nunca se alcanzaba para este rol.

**Archivos y funciones tocadas**:
- `server/app.js`: se agrega `'costos'` al `auth.allow('tesoreria', ...)`
  de los 3 endpoints: `GET /api/projects/:id/finanzas/fondo-garantia`, `PUT
  /api/projects/:id/fondo-garantia`, `PUT /api/clientes/:id/fondo-garantia`.
- `server/auth.js`: `PERMISSIONS.costos.tabs` gana `'fondoGarantia'`.
- `public/app.js`: `ROLE_TABS.costos` gana `'fondoGarantia'`.

**Fragmento clave**:
```js
// antes:
app.put('/api/projects/:id/fondo-garantia', h(auth.allow('tesoreria')), ...)
// después:
app.put('/api/projects/:id/fondo-garantia', h(auth.allow('tesoreria', 'costos')), ...)
```

**Aplicabilidad a la demo**: (b) portar adaptado — mismo patrón que #153:
solo aplica si la demo tiene el rol `costos` con `puede_editar` en
`finanzas` ya otorgado por la matriz de permisos pero bloqueado por
`auth.allow()`.

**Dependencias**: #154 (Fondo de Garantía editable) y #153 (rol `costos`
con acceso a Mapeo, mismo patrón de bug). Si se porta la demo sin #154, este
PR no aplica.

---

## PR #161 — feat/seccion-costos — 2026-08-19

**El más grande de este módulo por alcance funcional, aunque el diff en
líneas es moderado (3 archivos, ~110 líneas)**. Implementa la reorganización
diagnosticada en un prompt previo (`prompt-diagnostico-seccion-costos-nueva.md`,
no incluido en el repo actual). La descripción del PR (`gh pr view 161`) es
excepcionalmente completa — se resume y verifica contra el diff real abajo.

**Qué problema resolvía / diseño**: tres cosas relacionadas, todas parte del
mismo PR:

1. **Nueva sección de nivel superior "Costos"**, que reemplaza a
   "Presupuestos" (la sección introducida en un PR anterior a este listado
   y ampliada en #153). Antes: `SECTION_DEFS.presupuestos` con tabs
   `['matrices', 'costos', 'composicion_costos', 'mapeo', 'ordenesCambio']`.
   Después: `presupuestos` desaparece; nace `SECTION_DEFS.costos` con
   `['matrices', 'costos', 'composicion_costos', 'mapeo']` (sin
   `ordenesCambio` — regresa a `obra`, de donde había salido en #153). Es
   decir: la reorganización deshace parcialmente el movimiento de #153
   (`ordenesCambio` vuelve a Obra) pero mantiene `mapeo` en la nueva sección
   `costos`.

2. **Dos bugs preexistentes corregidos de paso** (no relacionados con la
   reorganización, encontrados durante la implementación):
   - Los 4 endpoints de Mapeo (`GET/POST/DELETE /api/conceptos/:id/insumos*`,
     `GET /api/projects/:id/concepto-insumos/resumen`) tenían `auth.allow('costos')`
     sin incluir `'administracion'` — ese rol también tiene el tab `mapeo`
     (desde antes de #153) y pasaba el gate del frontend, pero recibía 403
     real en el backend.
   - `PUT /api/projects/:id/programa/:itemId` (editar fechas de Programa)
     usaba `auth.allow()` vacío (solo admin/desarrollador), pese a que el
     frontend muestra el botón "✏️ Editar fechas" a cualquiera que vea
     Programa sin condicionarlo — `residente` lo veía y recibía 403 real al
     guardar.

3. **`costos` gana 2 tabs nuevos**: `resumen` (dashboard completo:
   Presupuesto total, Datos de la obra, Requisiciones — con el bloque de
   avance físico-financiero, 3 KPIs + dona, **ocultado específicamente para
   este rol**, ver `mostrarAvanceFinanciero` abajo) y `programa` (ver +
   editar, mismo nivel que `residente`).

**Decisión de diseño documentada explícitamente en el PR** (importante para
no "corregir" esto como si fuera un bug al portar): `programa` se agrega a
`PERMISSIONS.costos.tabs` (backend) y `costos` gana acceso real al endpoint,
pero **`'programa'` NO se agrega a `SECTION_DEFS.costos.tabs`** (frontend).
Razón: `VIEW_TO_SECTION` es un mapa global tab→sección (no por rol) — meter
`programa` en la sección "Costos" habría cambiado el breadcrumb/resaltado
de Programa a "Costos" para **6 roles distintos** (residente, cabo, compras,
tesorería, administración, logística) que ya veían Programa colgado de
"Obra". Se prefirió dejarlo solo en `SECTION_DEFS.obra` — efecto aceptado:
`costos` no logra un aterrizaje directo a una única galería (tiene tabs en
2 secciones), cae en `'inicio'` como cualquier rol multi-sección. **Este
mismo trade-off es la causa raíz de la regresión que arregla el siguiente
PR, #162** — ver esa entrada.

**Bug de duplicación detectado y corregido a mitad del propio cambio**: al
agregar `'resumen'` a `PERMISSIONS.costos.tabs`, `defaultPermisosParaRol()`
habría creado una fila `'presupuestos'` **duplicada** para cada alta nueva
de `costos` — el loop base ya la genera automáticamente vía `TAB_A_SECCION`
(porque `resumen` mapea a `presupuestos`), más el `filas.push()` explícito
que #153 había agregado (necesario en ese momento porque `resumen` **no**
vivía todavía en `PERMISSIONS.costos.tabs`). El `push` se elimina; ahora solo
sube `puede_editar` sobre la fila que el loop base ya crea.

**Archivos y funciones tocadas**:
- `server/auth.js`: `PERMISSIONS.costos.tabs` → agrega `'fondoGarantia'`
  (de #159, ya estaba) + `'programa'` + `'resumen'`. Dentro de
  `defaultPermisosParaRol()`: se elimina el `filas.push({seccion: 'presupuestos', ...})`
  de #153, reemplazado por `if (porSeccion.presupuestos) { porSeccion.presupuestos.puede_editar = true; }`.
- `server/app.js`: `auth.allow('costos', 'administracion')` en los 4
  endpoints de Mapeo (fix #2 de arriba). `auth.allow('residente', 'costos')`
  en `PUT /api/projects/:id/programa/:itemId` (era `auth.allow()` vacío).
  `auth.allow(..., 'costos')` agregado en `GET /api/projects/:id/programa`
  y `GET /api/projects/:id/resumen`.
- `public/app.js`: `ROLE_TABS.costos` sincronizado (gana `mapeo`, `programa`,
  `resumen` — el gap de `mapeo` nunca se había reflejado ahí desde #153,
  corregido de paso). `SECTION_DEFS`: `obra.tabs` recupera `ordenesCambio`;
  `administracion.tabs` sin cambios (ya no tenía `mapeo` desde #153);
  `presupuestos` se renombra/reemplaza por `costos` con
  `['matrices', 'costos', 'composicion_costos', 'mapeo']`;
  `SECTIONS_WITH_GALLERY` cambia `'presupuestos'` por `'costos'`.
  `renderInicio()`: nueva variable `mostrarAvanceFinanciero = effectivePuesto() !== 'costos'`
  que oculta condicionalmente los 3 KPIs de avance + la dona (pero **no**
  el bloque "Datos de la obra", que sigue visible para `costos` — es
  justo lo que necesita para validar que el presupuesto cargó bien).

**Fragmento clave** (public/app.js, `renderInicio`):
```js
const mostrarAvanceFinanciero = effectivePuesto() !== 'costos';
// ...
<div class="kpi accent">...Presupuesto total...</div>
${mostrarAvanceFinanciero ? `
<div class="kpi">...Avance programado...</div>
<div class="kpi green">...Avance ejecutado...</div>
<div class="kpi ...">...Desviación vs. programa...</div>` : ''}
```

**Aplicabilidad a la demo**: (c) no aplica tal cual / (b) portar adaptado —
la arquitectura general (sección "Costos" con dashboard limitado para el
rol, vs. dashboard completo para otros roles) es un patrón útil de replicar
si la demo tiene un rol equivalente a `costos`, pero el diff exacto está
demasiado atado a la historia específica de nombres de sección
(`presupuestos` → `costos`) de App-CP. Recomendado: leer esta entrada como
especificación de comportamiento final deseado, no como parche a aplicar
línea por línea.

**Dependencias**: #153 (rol `costos`, tab `mapeo`), #159 (tab `fondoGarantia`
ya en `PERMISSIONS.costos.tabs` antes de este PR). Genera dependencia hacia
adelante: #162 y #163 son fixes directos de regresiones que este PR
introdujo.

---

## PR #162 — fix/urgente-regresion-costos-entrada — 2026-08-19

**Urgente, regresión real en producción** (reportada el mismo día que se
mergeó #161). Un usuario real con rol `costos` reportó que al iniciar la
app veía "elige un presupuesto" (galería de clientes vacía) en vez de su
contenido, y que "Costos" solo era alcanzable desde el drawer (☰).

**Causa raíz** (confirmada con login real contra el servidor, no solo
lectura de código — documentado explícitamente en el PR): `PERMISSIONS.costos.tabs`
pasó de 4 tabs (todos mapeando a la sección `'costos'`) a 7 en la secuencia
#159→#161 (se sumaron `fondoGarantia`→sección `tesoreria`, `programa`→sección
`obra`, `resumen`→sin sección en `SECTION_DEFS`, ver la decisión de diseño
documentada en #161). `vistaInicialParaTabs()` exige que **todos** los tabs
de un rol mapeen a la misma sección para activar el aterrizaje directo en
`..._gallery`; con 3+ secciones distintas ya no lo logra, cae a `'inicio'`.
Pero `bootApp()` **nunca renderiza `'inicio'` directo** — solo usa
`state.view` en sus 2 ramas de excepción (tabs 100% sin-proyecto, o vista
`_gallery`) — el resultado real es que cae al flujo por defecto y muestra
la galería de clientes en cada login.

**Por qué no una regla genérica**: se evaluó ("aterriza directo si el
subconjunto de tabs *sin proyecto* del rol mapea a una sola sección con
galería") pero se descartó — `compras` tiene el mismo patrón por
coincidencia (sus 3 tabs sin-proyecto — `proveedores`/`cumplimiento`/`cotizador`
— mapean los 3 a `'compras'`), y esa regla habría cambiado también el
aterrizaje de `compras` sin que nadie lo pidiera. Se optó por una excepción
explícita y acotada solo a `costos`.

**Archivos y funciones tocadas**:
- `public/app.js`, `bootApp()`: nuevo bloque `if (effectivePuesto() === 'costos') { ... switchToView('costos_gallery'); return; }`
  antes del fallback genérico a `showClientGallery()`.

**Fragmento clave**:
```js
if (effectivePuesto() === 'costos') {
  state.clienteId = null;
  state.projectId = null;
  showApp();
  $('#projectName').textContent = '';
  switchToView('costos_gallery');
  return;
}
```

**Aplicabilidad a la demo**: (c) no aplica directamente a menos que la demo
reproduzca exactamente el mismo escenario (un rol cuyos tabs abarcan más de
una sección, con expectativa de aterrizaje directo). Si se porta #161 tal
cual a un rol equivalente en la demo, **hay que verificar si esta misma
regresión aparece** y aplicar el mismo tipo de excepción explícita en
`bootApp()` — no como parche automático, sino como chequeo puntual.

**Dependencias**: #161 (es la causa directa de esta regresión) y, en cadena,
#159/#153 (tabs que terminaron dispersos entre secciones).

---

## PR #163 — fix/urgente-costos-navegacion-cliente-obra — 2026-08-19

**Urgente, efecto colateral de #162**. `costos` toca el tile de un cliente
en la galería y ve "No hay un presupuesto seleccionado" en vez de la lista
de obras de ese cliente. Entrar directo a una obra (ej. desde "Mayor
avance") sí funcionaba.

**Causa raíz** (distinta a la hipótesis original del prompt que originó
este fix — verificada con `grep`, documentado en el PR): `bootApp()` solo
tiene 2 call sites en todo el archivo (`tryRestoreSession()` y
`completeLogin()`), ninguno relacionado con `selectCliente()` (la función
que corre al tocar un tile de cliente) — la rama nueva de #162 no interfiere
aquí. La causa real vive en `renderView()`: su fallback para
`!state.projectId` solo renderiza algo útil vía `renderResumenCliente()` si
`isAdmin() || puesto === 'residente'` — cualquier otro rol cae al
empty-state genérico. Este gate es **preexistente**, no lo tocó #162 —
`costos` simplemente nunca lo había alcanzado tanto antes (tenía menos tabs
por-obra que lo mandaran por esta ruta).

**Por qué no simplemente agregar `costos` al allowlist existente**:
`renderResumenCliente()` llama a `/clientes/:id/resumen-agregado`, que trae
KPIs de avance ejecutado/por ejecutar — exactamente lo que #161 ya había
ocultado a propósito para este rol en Resumen de obra.

**Fix**: picker dedicado `renderObrasClientePicker()`, solo para `costos`,
mostrando **solo nombre + lugar** de cada obra del cliente — nada de dinero
ni fechas (confirmado con login real que `GET /api/projects` restringe
esos campos a admin/desarrollador desde un PR anterior no relacionado). Al
elegir una obra, `selectProject()` recibe `targetView: 'costos_gallery'`
explícito.

**Archivos y funciones tocadas**:
- `public/app.js`, `renderView()`: nueva rama `else if (state.clienteId != null && effectivePuesto() === 'costos')`
  que llama a la función nueva `renderObrasClientePicker(view)` en vez del
  empty-state genérico.
- `public/app.js`: función nueva `renderObrasClientePicker(view)` — lista
  `visibleProjects()` (ya en memoria desde bootApp, sin endpoint nuevo),
  cada card navega vía `selectProject(pid, 'costos_gallery')`.

**Aplicabilidad a la demo**: (c) no aplica a menos que la demo reproduzca el
mismo árbol de decisiones (rol con acceso restringido a Resumen agregado,
navegando cliente→obra). Si aplica, el patrón del picker minimalista (solo
nombre+lugar, sin reusar el endpoint agregado que trae de más) es
reutilizable.

**Dependencias**: #162 (mismo incidente, PR inmediatamente anterior) y #161
(la decisión de ocultar KPIs de avance para `costos` es la razón de no
reusar `renderResumenCliente()`).

---

## PR #171 — feat/dashboard-costos-basicos — 2026-08-20

**5 commits, feature grande**: agrega 2 tiles nuevos a la galería de
"Costos" — Dashboard de Costos (primer tile) y Catálogo de Básicos (sexto
tile) — más un bugfix real encontrado durante verificación empírica con
datos sintéticos.

**Qué problema resolvía / diseño**:
1. **Dashboard de Costos** (`GET /api/costos/dashboard`): pantalla de
   entrada de solo lectura con 3 bloques independientes (cada uno puede
   estar vacío sin afectar a los otros 2):
   - Cobertura de matrices: cuántos conceptos del catálogo global (mismo
     filtro/orden que el catálogo de Conceptos ya existente, factorizado a
     2 constantes SQL compartidas `CONCEPTOS_CATALOGO_WHERE_SQL` /
     `CONCEPTOS_CATALOGO_ORDER_SQL`) ya tienen una matriz de precio unitario
     asociada.
   - Insumos con precio inconsistente entre obras (margen >5%).
   - Actividad reciente desde `audit_log` (acciones `importar_matrices`,
     `crear_presupuesto_desde_costos`).
2. **Catálogo de Básicos** (`GET /api/costos/catalogo-basicos`): un básico
   único por código (deduplicado cross-obra, mismo criterio `DISTINCT ON`
   que el catálogo de Conceptos), costo directo vía `resolverBasico()`
   (reusado tal cual, nunca reimplementado), y cuántas veces se reusa como
   ingrediente de otro análisis — agregado a través de **todas** las obras
   que comparten ese código, no solo la representativa.
3. **Bug real corregido durante verificación empírica**: `veces_reusado`/
   `usado_en` del catálogo de básicos usaba un `INNER JOIN proyectos ON
   m.project_id`, que descartaba en silencio el caso de reuso más común —
   un básico referenciado desde el análisis normal de un concepto, donde
   `project_id` vive en `conceptos`, no en la matriz consumidora (`m.project_id`
   es NULL en ese caso). Corregido a `LEFT JOIN ... COALESCE(m.project_id,
   c.project_id)`. El CHECK constraint `matrices_precio_unitario_concepto_xor_basico_check`
   garantiza que el `COALESCE` nunca toma el valor equivocado.
4. Ambos catálogos nuevos excluyen las mismas 3 obras duplicadas de un
   cliente real (nombre omitido — ver nota de anonimización al inicio del
   documento) ya excluidas en el catálogo de Conceptos — la constante se renombra de
   `EXCLUIR_OBRAS_DUPLICADAS_CATALOGO_CONCEPTOS` a
   `EXCLUIR_OBRAS_DUPLICADAS_CATALOGO` (compartida entre ambos catálogos).

**Archivos y funciones tocadas**:
- `server/app.js`: constante renombrada + 2 nuevas
  (`CONCEPTOS_CATALOGO_WHERE_SQL`, `CONCEPTOS_CATALOGO_ORDER_SQL`). Endpoint
  nuevo `GET /api/costos/dashboard` (gateado `checkPermiso('costos', 'puede_ver')`,
  sin `auth.allow()` restrictivo adicional). Función `basicosCatalogoQuery()`
  y endpoint `GET /api/costos/catalogo-basicos` (mismo gate).
- `server/auth.js`: `PERMISSIONS.costos.tabs` gana `'costosDashboard'` y
  `'catalogoBasicos'` — ambos sin entrada en `TAB_A_SECCION` (vistas
  GLOBALES de solo lectura, mismo criterio que `costos`/`composicion_costos`).
  `PERMISSIONS.admin`/`desarrollador` también los ganan.
- `public/app.js`: `SECTION_DEFS.costos.tabs` pasa de
  `['matrices', 'costos', 'composicion_costos', 'mapeo']` a
  `['costosDashboard', 'matrices', 'costos', 'composicion_costos', 'mapeo', 'catalogoBasicos']`
  (dashboard primero, catálogo de básicos al final). Nuevas funciones
  `renderCostosDashboard(view)` y `renderCatalogoBasicos(view)`, enganchadas
  en el big-if de `renderView()`.
- Tests nuevos: `tests/costos-dashboard.test.js`,
  `tests/costos-catalogo-basicos.test.js` (este último es un flake conocido
  documentado en memoria del proyecto — asume 0 básicos vivos en Preview).

**Fragmento clave** (server/app.js, el fix del INNER→LEFT JOIN):
```sql
-- antes (bug): INNER JOIN proyectos p ON p.id = m.project_id
--   → descarta filas donde m es un análisis normal (m.project_id NULL)
-- después (fix):
LEFT JOIN proyectos p ON p.id = COALESCE(m.project_id, c.project_id)
```

**Aplicabilidad a la demo**: (b) portar adaptado — el concepto (dashboard
de cobertura + catálogo de básicos global) es genérico y útil, pero las
queries dependen de tablas específicas de App-CP
(`matrices_precio_unitario`, `matriz_precio_renglones`, `audit_log` con esas
2 acciones exactas) que hay que verificar existen igual en la demo antes de
portar tal cual. El bug del INNER JOIN es un buen recordatorio a verificar
si la demo tiene una query similar.

**Dependencias**: #161 (sección `costos` ya existe con Matrices/Catálogo de
Costos/Composición de Costos/Mapeo — este PR solo agrega 2 tiles más).

---

## PR #192 — worktree-mover-ordenes-cambio-a-costos — 2026-08-27

**5 commits, dos piezas relacionadas pero independientes en su causa**
(la segunda es un hallazgo de QA durante la verificación de la primera).

### Pieza 1 — mover "Órdenes de Cambio" de Obra a Costos (definitivo)

**Diseño**: `ordenesCambio` había ido y venido entre `obra` y
`presupuestos`/`costos` en PRs anteriores de este mismo módulo (#153 lo
movió a `presupuestos`; #161 lo devolvió a `obra` al disolver esa sección).
Este PR lo mueve **de forma definitiva** a `costos`: temáticamente encaja
mejor junto a Matrices/Composición de Costos, decisión de negocio. Mismo
componente/lógica interna, solo cambia de menú — sin cambios de permisos
(`ordenes_cambio` sigue siendo su propia sección granular, independiente de
`checkPermiso('costos', ...)`).

**Problema colateral y su solución**: `cabo` era el único rol con acceso a
`ordenesCambio` sin ningún otro tab de `costos` — sin ajuste, habría ganado
un tile/grupo "Costos" nuevo completo como efecto secundario de este
movimiento (algo que nunca tuvo). Se introduce un mecanismo genérico y
extensible, `EXCEPCIONES_TILE_SECCION` (mapa `{rol: [{tab, seccionOrigen}]}`,
no un `if` hardcodeado), consumido por:
- `tabCuentaParaTileDeSeccion(tab)` — usado en `seccionesGridHtml()` y
  `renderSidebar()` para decidir si un tab "cuenta" para pintar el tile/grupo
  de su sección.
- `renderSidebar()` — el tab exceptuado se pinta como ítem suelto (mismo
  patrón que "Resumen"), no anidado en el grupo de la sección nueva.
- `renderTabsBar()` — reconstruye el grupo de navegación rápida (hermanos)
  desde la `seccionOrigen` registrada en la excepción, para que `cabo` siga
  viendo Avance/Destajo/Órdenes de Cambio como un solo grupo, "como si"
  `ordenesCambio` nunca se hubiera movido para ese rol específico.

### Pieza 2 — revocar acceso de `cabo` a "Infraestructura vs. Vivienda"

**Hallazgo de QA durante la verificación de la pieza 1**, confirmado por el
negocio como corrección de seguridad, no relacionado con el movimiento de
tabs. `cabo` tenía acceso real a 3 endpoints (`GET/POST /grupos-categoria`,
`GET /avance-por-categoria`) vía `auth.allow()` hardcodeado, pese a que el
tab correspondiente (`infraVivienda`) no debía estar disponible para ese
rol. Se quita `'cabo'` de los 3 `auth.allow()` — **sin tocar** el
`checkPermiso('avance', ...)` compartido, que `cabo` sí conserva para su
Avance real (los 3 endpoints y los endpoints de Avance comparten la misma
sección granular `avance` a propósito, pero el acceso real a esta feature
específica se resuelve en el `auth.allow()`, no en el `checkPermiso`).

**Archivos y funciones tocadas**:
- `server/app.js`: `auth.allow('residente', 'logistica')` (antes incluía
  `'cabo'`) en `GET/POST /api/projects/:id/grupos-categoria` y `GET
  /api/projects/:id/avance-por-categoria`.
- `public/app.js`: `ROLE_TABS.cabo` pierde `'infraVivienda'`.
  `SECTION_DEFS.obra.tabs` pierde `ordenesCambio`; `SECTION_DEFS.costos.tabs`
  lo gana (insertado entre `matrices` y `costos`). Nuevo mapa
  `EXCEPCIONES_TILE_SECCION = { cabo: [{ tab: 'ordenesCambio', seccionOrigen: 'obra' }] }`
  y sus 2 funciones consumidoras `excepcionesDelRol()` /
  `tabCuentaParaTileDeSeccion(tab)`. `renderTabsBar()` y `renderSidebar()`
  modificados para consumir el mapa (ver fragmento).
- Test nuevo: `tests/infra-vivienda-cabo-revocado.test.js` — 403 en los 3
  endpoints para `cabo` real + control de que `/avances` sigue en 200.

**Fragmento clave** (public/app.js, el mecanismo de excepción):
```js
const EXCEPCIONES_TILE_SECCION = {
  cabo: [{ tab: 'ordenesCambio', seccionOrigen: 'obra' }],
};
function excepcionesDelRol() { return EXCEPCIONES_TILE_SECCION[effectivePuesto()] || []; }
function tabCuentaParaTileDeSeccion(tab) { return !excepcionesDelRol().some((ex) => ex.tab === tab); }
```

**Aplicabilidad a la demo**: (c) no aplica el movimiento específico de
`ordenesCambio` (depende del historial exacto de reorganizaciones de la
sección Costos en App-CP) / (a) portar tal cual el **mecanismo**
`EXCEPCIONES_TILE_SECCION` si la demo alguna vez necesita mover un tab entre
secciones sin regalarle una sección completa nueva a un rol que solo tenía
ese único tab ahí — es un patrón genérico y reusable. La pieza 2 (revocar
`cabo` de Infraestructura vs. Vivienda) es específica de un hallazgo de
seguridad de App-CP — no aplica a menos que la demo tenga el mismo feature
y el mismo bug de `auth.allow()` con `'cabo'` de más.

**Dependencias**: #161 (sección `costos` debe existir), #153 (`ordenesCambio`
ya había vivido en una sección de Presupuestos/Costos antes).

---

## PR #198 — fix/total-inflado-presupuesto — 2026-08-30

**Bug de datos financieros reales, el más crítico de este módulo.**
"Actualizar presupuesto" calculaba `total_nuevo` re-sumando conceptos
parseados uno por uno — vulnerable a que el parser clasificara mal una fila
de pie de página/jerarquía como si fuera un concepto real. Confirmado con
un archivo Excel de contrato real: el cálculo daba **~4.09x de inflación**
sobre el total correcto — 3 filas de pie de página (equivalentes a "TOTAL
DEL PRESUPUESTO MOSTRADO SIN IVA:", "IVA 16.00%", "TOTAL DEL PRESUPUESTO
MOSTRADO:") traían la etiqueta en la columna **Código** en vez de
**Concepto**, así que el guard que debía excluirlas nunca disparaba.

**Causa raíz**: el guard de exclusión de pie de página en el parser
(`upper.startsWith('TOTAL DEL PRESUPUESTO') || ...`) solo revisaba la
columna `concepto` normalizada. Cuando un formato de Excel pone esa
etiqueta en `codigo` en vez de `concepto` (dejando `concepto` vacío), la
fila se colaba como si fuera un concepto normal, con su importe real de
total/IVA sumado al presupuesto.

**Las 4 capas del fix** (todas verificadas en el diff, no solo descritas en
el PR):

- **Capa 1** (`server/app.js`, `POST .../presupuesto/actualizar/preview`):
  `total_nuevo` deja de re-sumar `parsed.conceptos` fila por fila — ahora
  usa la nueva función `totalConfiableDesdeParse(parsed)`, mismo criterio de
  confianza que ya usaba `total_actual` (`presupuestoTotalDe`): confía
  primero en el total que el propio Excel ya declara
  (`parsed.meta.total_sin_iva`), y solo si falta cae al último concepto
  `es_total=1` sin grupo.
- **Capa 2** (`server/reintegracionPresupuesto.js`, `aplicarCambiosConceptos`):
  nuevo parámetro **opcional** `totalConfianzaExcel` — cuando el caller
  viene de un Excel (Actualizar presupuesto), se usa directo para
  `meta.total_sin_iva` en vez de re-sumar. Antes, confirmar una
  actualización con el bug corrompía **permanentemente** el total oficial
  del proyecto (Resumen/Finanzas/Dashboard), no solo el preview. El caller
  de Órdenes de Cambio (`server/ordenesCambio.js`) **no pasa este
  parámetro** — sigue re-sumando exactamente igual que antes, porque no
  tiene un Excel de origen del que confiar un total (verificado con 2 tests
  de regresión explícitos).
- **Capa 3** (`server/parser.js`, `parseBudgetConcepts`): el guard de pie de
  página ahora revisa tanto `concepto` como `codigo` (función `esPiePagina`
  aplicada a ambos).
- **Capa 4** (`server/parser.js`): cualquier fila `isGroupHeader` (sin
  unidad/cantidad/precio propios) queda `es_total=1`, ya no `0` —
  protección adicional contra el próximo formato de pie de página/jerarquía
  con otra redacción no anticipada.

**Archivos y funciones tocadas**:
- `server/parser.js`: función `esPiePagina(texto)` nueva, aplicada a
  `upper` (concepto) y `upperCodigo` (código). Línea de `es_total: (isTotalRow || isGroupHeader) ? 1 : 0`
  (antes: `isTotalRow ? 1 : 0`).
- `server/reintegracionPresupuesto.js`: función nueva `totalConfiableDesdeParse(parsed)`
  (exportada). `aplicarCambiosConceptos(client, pid, {...}, totalConfianzaExcel = null)`
  — nuevo 4º parámetro opcional.
- `server/app.js`: `preview` usa `totalConfiableDesdeParse(parsed)` en vez
  de `.reduce(...)`; `confirmar` pasa `totalConfiableDesdeParse(parsed)`
  como 4º argumento a `aplicarCambiosConceptos`.
- Test nuevo de punta a punta: `tests/total-inflado-presupuesto.test.js`
  (6 tests, contra un archivo fixture real de un contrato real — el nombre
  de archivo del fixture en el repo de App-CP incluye el nombre del cliente
  real, omitido aquí a propósito; cuidado de no copiar ese archivo tal cual
  a la demo).

**Fragmento clave** (server/parser.js, capas 3 y 4):
```js
const upperCodigo = norm(codigo);
const esPiePagina = (texto) => texto.startsWith('TOTAL DEL PRESUPUESTO') || texto.startsWith('(*') || texto.startsWith('IVA');
if (esPiePagina(upper) || esPiePagina(upperCodigo)) {
  continue; // pie de pagina / totales generales
}
// ...
es_total: (isTotalRow || isGroupHeader) ? 1 : 0,
```

**Nota fuera del diff de código** (documentada en el PR, no aplica a la
demo): limpieza de datos ya corrida manualmente por el equipo en producción
(174 filas fantasma desactivadas vía soft-delete en 9 proyectos reales) —
es SQL de limpieza de datos reales, irrelevante para un repo de demo con
datos ficticios.

**Aplicabilidad a la demo**: (a) portar tal cual — es un bug de lógica pura
(parser + cálculo de totales), sin dependencia de datos reales de App-CP.
Muy recomendable portarlo si la demo tiene el mismo flujo de "Actualizar
presupuesto" desde Excel — el bug de "etiqueta de pie de página en columna
equivocada" es genérico a cualquier parser de Excel de presupuestos con
formato de obra civil/construcción. **No portar el archivo fixture con
datos/nombre de cliente real** — si se necesita un test de regresión
equivalente en la demo, generar un Excel sintético con el mismo patrón
estructural (etiqueta de pie de página en columna Código).

**Dependencias**: ninguna dentro de este módulo — depende del módulo base
de "Actualizar presupuesto" / parser de Excel (anterior a este listado, no
cubierto aquí).

---

## PR #199 — feature/finanzas-maquinaria-vista-picker — 2026-09-01

**El PR más grande de este módulo en líneas de diff** (~900 líneas, 6
archivos). Tres piezas relacionadas bajo un solo cambio de diseño confirmado
por Paul el mismo día:

### Pieza 1 — Maquinaria entra a "Erogado Real"

**Diseño**: `getFinanzasResumenData` (por-obra) ahora suma combustible +
mantenimiento de Maquinaria al cálculo de Erogado Real. Reglas de inclusión/
exclusión, explícitas y documentadas en el código:
- **Incluye** `combustible_maquinaria.costo` y `mantenimientos_maquinaria.costo`
  (ambos `NOT NULL`, sin campo de estatus pagado/pendiente en el esquema
  actual — se tratan como costo ya incurrido, mismo criterio que
  Destajo/Jornal).
- **Excluye** `consumibles_maquinaria.costo_estimado` — decisión explícita
  de negocio: es un campo nullable y "estimado", no al mismo nivel de
  confiabilidad que combustible/mantenimiento.
- **Excluye** el gasto de personal (nómina de operadores) — ya está 100%
  dentro de `jornalAprobado` (esa query no filtra por
  `trabajadores.categoria_costo`); agregarlo sería doble conteo, confirmado
  en el diagnóstico previo al PR.
- Atribución vía `equipos_maquinaria.obra_id` (asignación **actual** del
  equipo, mutable) — misma limitación ya aceptada en otro reporte de
  Maquinaria (`getReportePorCliente`, `server/maquinaria.js`): si un equipo
  cambió de obra, su gasto histórico completo aparece bajo la obra de HOY,
  no bajo la obra donde se incurrió el gasto.
- Nuevos agregadores por-cliente/global (`getErogadoRealPorCliente`,
  `getErogadoRealGlobal`, ambos vía `getErogadoRealAgregado(pids)` interno)
  — queries **batched** (`WHERE project_id = ANY($1)`), no un loop N+1 sobre
  `getFinanzasResumenData` obra por obra (mismo patrón ya usado por
  `getCompromisosAbiertosAgregado`/`getFondoGarantiaAgregado`).
  `getFinanzasResumenData` en sí **no se toca ni se reusa** — es una query
  independiente que reproduce el mismo resultado agregado.
- 2 endpoints nuevos: `GET /api/clientes/:id/erogado-real`, `GET
  /api/erogado-real-global` — ambos `auth.allow()` sin argumentos (solo
  admin/desarrollador, mismo criterio que `/api/resumen-global`).

### Pieza 2 — Selector de vista dentro del tab "Finanzas"

**Diseño**: "Esta obra" / "Por cliente" / "Todas las obras" dejan de ser
tabs separados y pasan a vivir **dentro** del mismo tab `finanzas`, como un
selector de vista (`state.finanzasVista`: `'obra'` default | `'cliente'` |
`'global'`, más `state.finanzasClienteId`). Un componente visual reusado —
"Avance Valorizado vs. Erogado Real" (2 barras horizontales en HTML/CSS
puro, ya no Chart.js — más liviano, hereda tema/paleta vía CSS vars) más un
"recibo" de desglose de texto — se pinta en los 3 niveles con la misma
firma de datos (`{ avance_valorizado, erogado_real, brecha, presupuesto_total }`,
la misma forma que ya devolvía `getFinanzasResumenData` por obra).

Detalle de navegación (rediseño "Opción A", confirmado por Paul): en el
nivel "Esta obra" las 2 barras solo hacen scroll+flash hacia el desglose que
ya vive en la misma pantalla (`scrollAndHighlight`); desde el donut global
o las barras de "Avance por cliente" (fuera del tab Finanzas), un click
navega directo al tab Finanzas con la vista `'cliente'`/`'global'` ya
preseleccionada (`goToFinanzasCliente(clienteId)` /
`goToFinanzasGlobal()`).

`'finanzas'` se agrega a `VISTAS_SIN_PROYECTO` — el tab sigue siendo
por-obra por defecto, pero ahora también se puede entrar sin obra
seleccionada (para las vistas "Por cliente"/"Todas las obras").
Entrar al tab desde su punto de entrada normal (sidebar/barra de tabs)
resetea siempre a `'obra'` — solo `goToFinanzasCliente`/`goToFinanzasGlobal`
fuerzan la vista agregada.

### Pieza 3 — Picker de obra inline + toast (generalizado, no solo Costos)

**Problema**: cualquier click de sidebar en una vista por-obra sin obra
activa (no solo el caso de `costos` ya resuelto en #163) rebotaba a la
galería **completa** de clientes vía `goToClientGallery()`, perdiendo el
cliente en el que el usuario ya estaba parado si había uno elegido.

**Fix**: en `switchToView()`, si `state.clienteId != null` (cliente ya
elegido, solo falta obra), en vez del rebote completo: dispara un
`toast('Selecciona un presupuesto para realizar esta acción.', 'warning')`
**inmediato** (antes de cualquier fetch/render, para no esperar al
spinner), guarda la vista pedida en `state.pendingTargetView` (mecanismo ya
existente) y deja que `renderView()` pinte el picker de obras — la función
`renderObrasClientePicker()` de #163, ahora **generalizada a cualquier rol**
(antes solo se llamaba para `costos`), con un 2º parámetro `pedirObra` que
decide si `selectProject()` debe consumir `pendingTargetView` (aterriza en
la vista originalmente pedida) o forzar `'costos_gallery'` (comportamiento
original de #163, sin acción pendiente).

**Archivos y funciones tocadas**:
- `server/finanzas.js`: nueva función `getErogadoRealAgregado(pids)` (con
  su propio `IVA_RATE` local, a propósito no compartido con
  `getFinanzasResumenData`), más `getErogadoRealPorCliente(clienteId)` y
  `getErogadoRealGlobal()` (exportadas).
- `server/app.js`: 2 endpoints nuevos `GET /api/clientes/:id/erogado-real`,
  `GET /api/erogado-real-global`.
- `public/app.js`: `VISTAS_SIN_PROYECTO` gana `'finanzas'`. `state` gana
  `finanzasVista`, `finanzasClienteId`. `switchToView()` — nuevo branch de
  toast+picker cuando hay `clienteId`. `renderTabsBar()`/`renderSidebar()`
  resetean `finanzasVista`/`finanzasClienteId` al entrar a `finanzas` desde
  su punto de entrada normal. Componentes reusados nuevos:
  `avanceValorizadoVsErogadoHtml()`, `brechaCardHtml()`,
  `paintAvanceValorizadoVsErogado()`, `scrollAndHighlight()`,
  `erogadoRealDesgloseHtml()`, `paintErogadoRealDesglose()`. `renderFinanzas()`
  reescrito para usar estos componentes en vez de HTML inline repetido.
  Funciones nuevas `renderFinanzasVistaCliente(body)`,
  `renderFinanzasVistaGlobal(body)`, `goToFinanzasCliente(clienteId)`,
  `goToFinanzasGlobal()`. `renderObrasClientePicker(view, pedirObra)` gana
  el 2º parámetro. Nueva función `renderErogadoRealGlobal()` (bloque en el
  dashboard global, `#erogadoRealGlobalSection`, gate `isAdmin()`).
- `public/index.html`, `public/styles.css`: markup/estilos para las barras
  horizontales (`.hbar-*`), el recibo (`.avs-receipt-*`), y el layout del
  bloque global (`.erogado-global-row`, reemplaza una 3ª columna de
  `.dashboards-row` que se encimaba con "Avance por cliente").

**Fragmento clave** (public/app.js, el toast+picker inline en `switchToView`):
```js
if (state.clienteId != null) {
  toast('Selecciona un presupuesto para realizar esta acción.', 'warning');
  state.view = 'inicio';
  state.section = null;
  renderTabsBar(); renderSidebar(); renderMobileNav(); renderView();
  return;
}
goToClientGallery(); // solo si tampoco hay cliente elegido
```

**Aplicabilidad a la demo**: (b) portar adaptado — 3 piezas de valor
desigual para la demo:
- Pieza 1 (Maquinaria en Erogado Real) solo aplica si la demo tiene el
  módulo de Maquinaria con las tablas `combustible_maquinaria`/
  `mantenimientos_maquinaria` — verificar antes de portar.
- Pieza 2 (selector de vista + componente reusado de barras) es un patrón
  de UI genérico y valioso independientemente de Maquinaria — portable si
  la demo tiene un concepto equivalente a "Erogado Real"/"Avance Valorizado".
- Pieza 3 (picker inline + toast, generalizado) es el fix más reusable de
  los tres — el patrón "no perder el cliente elegido al rebotar por falta
  de obra" es útil para cualquier demo con navegación cliente→obra
  jerárquica, independiente de Finanzas/Maquinaria.

**Dependencias**: #163 (`renderObrasClientePicker` — esta pieza lo extiende,
no lo reemplaza) y el módulo de Fondo de Garantía/Finanzas base (anterior a
este listado) para `getFinanzasResumenData`. Depende también del módulo de
Maquinaria (fuera de este listado de módulo, cubierto presumiblemente en
otro archivo del changelog) para la pieza 1.
