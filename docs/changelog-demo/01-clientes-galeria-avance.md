# Clientes, Galería de Clientes y Avance de Obra

> Cobertura: PRs #151, #152, #167, #168, #172, #201, #203 mergeados a `main`
> entre 2026-08-18 y 2026-09-02. Verificado contra el historial real de git
> (`git diff <merge>^1 <merge>`, no `<merge>^1..<merge>^2` — ver nota
> metodológica en PR #152, donde ambos difieren).
>
> **Nota de alcance**: PR #151 no es en realidad un cambio de "Clientes,
> Galería o Avance de Obra" — es 100% módulo de Maquinaria (registro de
> responsable diario para equipo menor/herramienta/camioneta). Se incluye
> aquí solo porque así llegó asignado en el listado de PRs de este archivo;
> se documenta igual por completitud, pero probablemente pertenece al
> changelog de Maquinaria, no a este. Se incluye también porque PR #152 lo
> referencia directamente (ver Dependencias de PR #152).

---

## PR #151 — feat/responsable-diario-equipo-menor (2026-08-18)

**Título**: `feat(maquinaria): responsable diario para equipo menor/herramienta/camioneta`

### Qué problema resolvía
Para equipo **menor** (herramientas, camionetas — a diferencia de maquinaria
pesada), la app solo permitía asignar un "Operador asignado" fijo mediante
selector formal, sin historial. El negocio quería en su lugar un registro
abierto por fecha de "quién tuvo el equipo hoy", sin asignación formal, más
un nuevo estatus "En taller" distinto de "mantenimiento".

### Diseño
Se creó una tabla y endpoints completamente paralelos, deliberadamente
**sin** el candado de ownership (`operador_asignado_id === req.user.id`) que
sí protege los 4 endpoints de `reportes_horas_maquinaria` (relacionados con
nómina/costos) — para este registro, cualquiera con acceso al módulo puede
anotar el responsable de cualquier equipo "menor", porque no hay asignación
formal que validar. `categoria_uso` (`pesada`/`menor`, default `pesada`) es
el campo que decide qué UI mostrar en la ficha del equipo; es ortogonal a
`tipo` (texto libre de modelo) y a `categoria` (máquina/camioneta, para
checklist de estado_unidad).

### Archivos y funciones tocadas
- `server/db.js`: `ALTER TABLE equipos_maquinaria ADD COLUMN categoria_uso` (CHECK `'pesada'`/`'menor'`); `'en_taller'` agregado al CHECK de `estado` (vía `DROP CONSTRAINT` + `ADD CONSTRAINT equipos_maquinaria_estado_check` explícito, porque `CREATE TABLE IF NOT EXISTS` no vuelve a correr sobre una tabla existente); tabla nueva `equipo_responsable_diario` (`equipo_id`, `fecha`, `nombre_responsable` texto libre — no FK a trabajadores/usuarios — `registrado_por`).
- `server/maquinaria.js`: `createEquipo`/`updateEquipo` extendidos con `categoria_uso`; funciones nuevas `listResponsablesDiarios(equipoId)` y `createResponsableDiario({equipo_id, fecha, nombre_responsable, registrado_por})`.
- `server/app.js`: `POST`/`PUT /api/maquinaria/equipos` validan `categoria_uso`; endpoints nuevos `GET`/`POST /api/maquinaria/equipos/:id/responsables`, ambos con `checkPermiso('maquinaria', ...)` (puede_ver / puede_crear) — sin candado de ownership adicional.
- `public/app.js`: en `paintEquiposMaqList()`, `ESTADO_BADGE`/`ESTADO_LABEL` con `en_taller: 'purple'`; función `operadorOResponsableHtml(e)` que bifurca por `e.categoria_uso` — `'menor'` muestra input de texto + botón "Registrar" + historial colapsable (`toggleResponsablesMaq`, `cargarResponsablesMaq`); `'pesada'` sin cambios. `openEquipoMaqModal()` gana un selector "Categoría de uso".

### Fragmento relevante (server/app.js, endpoint nuevo)
```js
app.post('/api/maquinaria/equipos/:id/responsables', h(auth.checkPermiso('maquinaria', 'puede_crear')), h(async (req, res) => {
  const { fecha, nombre_responsable } = req.body || {};
  if (!nombre_responsable?.trim()) return res.status(400).json({ error: 'El nombre del responsable es requerido' });
  const equipoId = Number(req.params.id);
  const equipo = await maquinaria.getEquipoById(equipoId);
  if (!equipo) return res.status(404).json({ error: 'Equipo no encontrado' });
  const registro = await maquinaria.createResponsableDiario({
    equipo_id: equipoId, fecha: fecha || null, nombre_responsable: nombre_responsable.trim(), registrado_por: req.user.id,
  });
  res.status(201).json(registro);
}));
```

### Clasificación de aplicabilidad a la demo
**(b) Portar adaptado.** No depende de datos reales de clientes — es un
patrón de UI/schema genérico (registro abierto por fecha, texto libre).
Portable directo si la demo tiene módulo de Maquinaria con estructura
similar de `equipos_maquinaria`; si no, no aplica. Recordar que
pertenece conceptualmente al módulo de Maquinaria, no al de Clientes/Galería.

### Dependencias
Ninguna dependencia de otros PRs de este módulo. PR #152 sí depende
parcialmente de este a nivel de commit history (ver abajo), pero no a nivel
de funcionalidad — el feature de PR #152 no usa nada de PR #151.

---

## PR #152 — feat/entrada-directa-galeria-por-rol (2026-08-18)

**Título**: `feat(navegacion): aterrizaje directo en galería de sección para roles de una sola sección`

### Nota metodológica importante (relevante para quien re-investigue esto)
La rama de este PR se creó **antes** de que PR #151 se mergeara a `main`
(branch point: commit `f7eb950`, el merge de PR #150 — confirmado con
`git merge-base`). Por lo tanto, diffear `merge^1` (main, que para este punto
ya incluye PR #151) contra `merge^2` (la punta de la rama de PR #152, que
NUNCA tuvo los cambios de PR #151) genera un diff engañoso: parece que
PR #152 "revierte" todo el frontend de maquinaria de PR #151 y además agrega
la feature de navegación. Eso es un artefacto de comparar contra una rama
desactualizada, **no** lo que realmente se aplicó a `main`. El diff real que
aterrizó (`git diff merge^1 merge`, es decir comparar main antes/después del
merge commit) es limpio: **89 líneas, solo `public/app.js`**, y no toca nada
de maquinaria. Si se re-investiga cualquier PR de este historial, verificar
siempre `git log -1 --format=%P <merge>` y, si hay dudas, comparar
`merge^1..merge^2` contra `merge^1..merge` — deberían coincidir; si no
coinciden (como aquí), usar `merge^1..merge`.

### Qué problema resolvía
Un rol cuyo acceso se concentra en una sola sección de la app (ej. `costos`,
que solo ve tabs dentro de "Presupuestos": `matrices`/`costos`/
`composicion_costos`) debía, tras hacer login, pasar primero por
Inicio/selector de obra antes de llegar a su galería de sección — paso
extra e innecesario. La regla ya existía para roles 100% "sin proyecto"
(`operador`, `jefe_maquinaria`), pero no aplicaba a `costos` porque uno de
sus tabs (`matrices`) es por-obra, no global.

### Diseño
1. `vistaInicialParaTabs()`: el guard se relaja de "todos los tabs son
   sin-proyecto" a "todos los tabs pertenecen a una sola sección de
   `SECTION_DEFS` que tiene galería" — sigue sin ningún `if (rol === ...)`,
   calculado sobre `SECTION_DEFS`/`VIEW_TO_SECTION`.
2. `switchToView()` gana un punto único (cubre galería de sección, sidebar,
   tabs bar y drawer — es el único paso común a todas las formas de navegar)
   que detecta "esta vista es por-obra pero no hay `projectId` todavía":
   guarda la vista pedida en `state.pendingTargetView` y manda a
   `goToClientGallery()` en vez de renderizar un empty-state sin salida.
3. `selectProject(id, targetView)`: si no se pasó `targetView` explícito,
   retoma `state.pendingTargetView` como fallback (se consume una sola vez).
4. `bootApp()`: rama nueva, separada de la de operador/jefe_maquinaria
   (que depende de "cero proyectos accesibles" como señal de seguridad) —
   esta aterriza directo en la galería de sección aunque el usuario SÍ tenga
   obras asignadas, porque el punto 2 ya cubre el caso de un tile por-obra
   sin selección.

### Archivos y funciones específicas tocadas
Todo en `public/app.js`:
- `state`: campo nuevo `pendingTargetView: null`.
- `vistaInicialParaTabs(tabs)` — lógica del guard reordenada/relajada.
- `switchToView(viewId)` — guard nuevo al inicio de la función.
- `bootApp()` — bloque nuevo justo antes de `showClientGallery()`.
- `selectProject(id, targetView)` — línea que retoma `pendingTargetView`.

### Fragmento relevante
```js
// switchToView(viewId), guard nuevo:
function switchToView(viewId) {
  if (!state.projectId && viewId !== 'inicio' && !viewId.endsWith('_gallery') && !VISTAS_SIN_PROYECTO.includes(viewId)) {
    state.pendingTargetView = viewId;
    goToClientGallery();
    return;
  }
  state.view = viewId;
  // ...
}

// vistaInicialParaTabs(tabs), antes vs después:
// ANTES: exigía TODOS los tabs sin-proyecto antes de siquiera mirar SECTIONS_WITH_GALLERY
// DESPUÉS:
function vistaInicialParaTabs(tabs) {
  if (tabs.length === 0) return 'inicio';
  if (tabs.length === 1) return tabs[0];
  const secciones = new Set(tabs.map((t) => VIEW_TO_SECTION[t]).filter(Boolean));
  if (secciones.size === 1) {
    const [sectionId] = secciones;
    if (SECTIONS_WITH_GALLERY.has(sectionId) && tabs.every((t) => VIEW_TO_SECTION[t] === sectionId)) {
      return `${sectionId}_gallery`;
    }
  }
  const todosSinProyecto = tabs.every((t) => VISTAS_SIN_PROYECTO.includes(t));
  return todosSinProyecto ? tabs[0] : 'inicio';
}
```

### Clasificación de aplicabilidad a la demo
**(a) Portar tal cual.** Es lógica de navegación pura basada en
`SECTION_DEFS`/roles/tabs — cero dependencia de datos de clientes reales.
Si la demo tiene un rol de una sola sección con tiles mixtos (global +
por-obra), este fix aplica exactamente igual.

### Dependencias
Ninguna funcional. Nota histórica: la rama se creó antes de PR #151, así
que si se porta a la demo en un repo donde no existe el concepto
`categoria_uso`/maquinaria de PR #151, no hay problema — son independientes.

---

## PR #167 — feat/modal-checkbox-buscador-crear-cliente (2026-08-19)

**Título**: `feat(costos): checkbox+buscador+crear cliente inline y exportar a Excel en modal "Crear presupuesto desde catálogo"`

### Qué problema resolvía
El modal "Crear presupuesto desde catálogo" (del Catálogo de Conceptos)
usaba un flujo opt-out: todos los conceptos (269+) incluidos por default,
con un botón "×" por fila para excluir uno a la vez — pero el caso de uso
real es seleccionar solo unos pocos conceptos de un catálogo grande, no
excluir casi todos manualmente. Además, para crear el presupuesto había que
salir del modal a dar de alta el cliente si no existía todavía, y no había
forma de exportar la selección a Excel para revisar/ajustar offline antes de
crear la obra.

### Diseño
- **Opt-in en vez de opt-out**: checkboxes sin marcar por default + checkbox
  "seleccionar todos los visibles" en el header. La selección se guarda como
  `Set` de **índices** sobre el array completo `items` (nunca se filtra/
  recorta), para que buscar no pierda selecciones ya hechas.
- **Buscador client-side**: todo el catálogo ya vive en memoria (sin
  paginación) — filtro en vivo por código/descripción, normalizado sin
  tildes (`normalize('NFD')`), mismo patrón que el buscador de Destajo.
- **"+ Crear cliente nuevo" inline**: gateado por `isAdmin()` en frontend,
  coincidiendo con el gate real del backend (`POST /api/clientes` es
  `auth.allow()` sin argumentos → solo admin/desarrollador). Reusa el
  endpoint `POST /clientes` existente, sin endpoint nuevo.
- **Exportar a Excel**: nuevo endpoint `POST /api/costos/crear-presupuesto/export`
  que reusa `sendXlsxExport`/`buildExportFilename` ya existentes — genera el
  `.xlsx` con las filas seleccionadas y valores ya editados, sin persistir
  nada; el modal se queda abierto. Reconocible después por el importador real
  (`server/parser.js`, por sinónimo de encabezado: Código/Concepto/Unidad/
  Cantidad + Precio/Importe).

### Archivos y funciones específicas tocadas
- `server/app.js`: nuevo endpoint `POST /api/costos/crear-presupuesto/export` (mismo permiso `checkPermiso('costos', 'puede_crear')` que crear-presupuesto — "no tiene sentido dar el archivo a quien ni siquiera podría crear el presupuesto directo").
- `public/app.js`:
  - `downloadExport(path, body = null)` — extendida para aceptar `body` opcional; si hay `body` usa `POST` con `Content-Type: application/json` en vez de `GET`, para exports que mandan datos editados en el navegador.
  - `openCrearPresupuestoModal(catalogoOriginal)` — reescritura sustancial: `seleccionados` (Set de índices), `filtro`, `normalizar()`, `indicesFiltrados()`, `renderRows(idxVisibles)`, `actualizarContadorYBoton()`, `nuevoClienteHtml()`. Botones nuevos `#btnExportarCrearPresupuesto` y `#cpBuscar`/`#cpSelAllVisibles`.

### Fragmento relevante (server/app.js, endpoint de exportación)
```js
app.post('/api/costos/crear-presupuesto/export', h(auth.checkPermiso('costos', 'puede_crear')), h(async (req, res) => {
  const { nombre, items } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'El presupuesto debe incluir al menos un concepto' });
  for (const it of items) {
    if (!it.codigo?.trim() || !it.concepto?.trim()) return res.status(400).json({ error: 'Cada concepto necesita código y descripción' });
    if (!(Number(it.cantidad) >= 0) || !(Number(it.precio_unitario) >= 0)) {
      return res.status(400).json({ error: `Cantidad/precio inválidos para el concepto "${it.concepto}"` });
    }
  }
  await sendXlsxExport(res, { filename: buildExportFilename('Presupuesto', nombre?.trim() || 'DesdeCatalogo'), sheets: [/* ... */] });
}));
```

### Clasificación de aplicabilidad a la demo
**(a) Portar tal cual, con una corrección obligatoria antes de portar.**
Es UI/UX de un modal + endpoint de exportación genérico — PERO el código
real de App-CP usa literalmente `placeholder="Ej. VINTE"` en los 3 inputs
de "Nombre del nuevo cliente" (`public/app.js`, líneas ~4572, ~4818 y
~17175), y "VINTE" **es un nombre de cliente real** (confirmado: aparece
junto a otros nombres de clientes reales — "Kalia"/"Comvive" — en un string
de ayuda de la sección Ventas, ver `public/app.js` línea ~3430). Esta
entrada lo mencionó por error como si fuera un placeholder inocuo — no lo
es. **Al portar a la demo, reemplazar las 3 ocurrencias de
`placeholder="Ej. VINTE"` por algo genérico** (ej. `placeholder="Ej. Proyecto Demo A"`)
en vez de copiar el atributo tal cual.

### Dependencias
Depende de que exista ya el modal "Crear presupuesto desde catálogo" (según
el propio PR body, introducido en un PR #165 anterior a este rango de 20
días — no cubierto en este archivo; si la demo no tiene ese modal, este PR
no aplica sin portarlo primero). **PR #168 depende directamente de este**
(es su fix inmediato).

---

## PR #168 — fix/boton-crear-presupuesto-deshabilitado (2026-08-20)

**Título**: `fix(costos): botones "Crear presupuesto"/"Exportar a Excel" no reaccionaban al clic tras PR #167`

### Qué problema resolvía
En producción, en el modal "Crear presupuesto desde catálogo", tanto
"+ Crear cliente nuevo" como "Crear presupuesto" no hacían nada al hacer
clic — ningún cliente ni presupuesto se creaba, sin ningún error visible en
consola ni red. Reportado por un usuario real con cuenta `desarrollador`
(descartando problema de permisos).

### Causa raíz
PR #167 rediseñó el modal de opt-out a opt-in (nada seleccionado por
default). Ambos botones (`btnExportarCrearPresupuesto`,
`btnConfirmCrearPresupuesto`) traían el atributo HTML `disabled` en el
template inicial, y `actualizarContadorYBoton()` los volvía a deshabilitar
en cada cambio de selección con `btn.disabled = !seleccionados.size`.
**Los form controls con `disabled` nunca disparan el evento `click`** — es
comportamiento estándar del DOM, no un bug de terceros. Eso volvía código
muerto la validación `if (!seleccionados.size) { toast(...); return; }` que
ya existía dentro de ambos handlers: nunca llegaba a ejecutarse porque el
navegador bloqueaba el clic antes de que corriera cualquier JS. Cualquier
usuario que reprodujera el flujo viejo (clic directo sin marcar ninguna fila
primero, "muscle memory" del flujo opt-out anterior) se encontraba el botón
ya deshabilitado: cero red, cero consola, cero toast.

### Archivos y funciones específicas tocadas
`public/app.js`, dentro de `openCrearPresupuestoModal()`:
- Template: se quita el atributo `disabled` de `#btnExportarCrearPresupuesto` y `#btnConfirmCrearPresupuesto`.
- `actualizarContadorYBoton()`: ya no toca `.disabled` de ningún botón — solo actualiza texto/contador.
- Handler de `#btnExportarCrearPresupuesto` (bloque `finally`): cambia `btn.disabled = !seleccionados.size` por `btn.disabled = false` (se preserva el disable temporal legítimo *mientras la operación está en curso*, que es un patrón correcto distinto).
- `public/sw.js`: `SW_VERSION` v338 → v339.

### Fragmento relevante (antes/después)
```js
// ANTES (public/app.js, template del modal):
<button class="btn" id="btnExportarCrearPresupuesto" disabled>⭳ Exportar a Excel</button>
<button class="btn btn-primary" id="btnConfirmCrearPresupuesto" disabled>Crear presupuesto</button>

// DESPUÉS:
<button class="btn" id="btnExportarCrearPresupuesto">⭳ Exportar a Excel</button>
<button class="btn btn-primary" id="btnConfirmCrearPresupuesto">Crear presupuesto</button>

// ANTES (actualizarContadorYBoton()):
if (btn) {
  btn.disabled = !seleccionados.size;
  btn.textContent = seleccionados.size ? `Crear presupuesto (${seleccionados.size})` : 'Crear presupuesto';
}
const btnExport = $('#btnExportarCrearPresupuesto');
if (btnExport) btnExport.disabled = !seleccionados.size;

// DESPUÉS:
if (btn) btn.textContent = seleccionados.size ? `Crear presupuesto (${seleccionados.size})` : 'Crear presupuesto';
```

### Clasificación de aplicabilidad a la demo
**(a) Portar tal cual** — pero solo tiene sentido si PR #167 ya se portó
primero (es su fix directo; sin PR #167 este parche no aplica sobre nada).
Buen recordatorio general para la demo: **nunca combinar `disabled` en el
template con lógica de validación dentro del handler de `click`** — usar
solo uno de los dos mecanismos.

### Dependencias
**Depende de PR #167** (mismo módulo, fix directo). Sin dependencias fuera
de este archivo.

---

## PR #172 — feat/fase2-infraestructura-avance (2026-08-20)

**Título**: `feat(obra): Fase 2 — Infraestructura vs. Vivienda (KPIs de avance por categoría)`

### Qué problema resolvía
Para clientes tipo "Desarrollador de Vivienda" (obras con mezcla de trabajo
de infraestructura — calles, drenaje, redes — y trabajo de vivienda —
azoteas, torres, niveles), no existía forma de comparar el avance de ambas
categorías por separado dentro de la misma obra. El dato para distinguirlas
ya existe de facto en `conceptos.grupo` (texto libre, ej. "RED HIDRAULICA"
vs. "AZOTEA"), pero es inconsistente entre obras y nunca se había
formalizado.

### Diseño
- **Clasificación 100% manual, nunca automática**: tabla nueva
  `conceptos_grupo_categoria` (scoped por `project_id` — el mismo texto de
  grupo puede significar cosas distintas en obras distintas) donde un
  admin/residente marca cada `grupo` como `infraestructura` o `vivienda`.
  Deliberadamente **nunca** se infiere por keyword-matching (Forbidden
  Action explícita del prompt de diseño). "Sin clasificar" no es un tercer
  valor persistido — es la ausencia de fila para ese `(project_id, grupo)`,
  resuelta en tiempo de consulta vía `LEFT JOIN`.
  Reclasificar un grupo a "sin clasificar" hace un `DELETE` de la fila, no
  guarda un valor nuevo.
- **KPIs por categoría**: `GET /api/projects/:id/avance-por-categoria` reusa
  el mismo motor de cálculo de avance ya existente (mismo criterio de
  `SUM(cantidad_ejecutada) × precio_unitario` que usa
  `PUT /avances/:semana/conceptos`) — nunca toca `avances_semanales` ni
  `avance_conceptos`, solo re-agrega su resultado por categoría en vez de
  por concepto individual.
- Nuevo tab **"Infraestructura vs. Vivienda"** (`infraVivienda`) dentro de
  la galería de sección **Obra** (junto a Programa/Avance/Destajo/
  Estimaciones/Órdenes de Cambio/Lotes) — no es una sección nueva.
- **Bug financiero real, encontrado y corregido durante el desarrollo del
  propio PR** (documentado en el PR body, no en un PR de fix separado): el
  denominador de `avance-por-categoria` inicialmente re-sumaba
  `conceptos.importe` en vez de reusar `presupuestoTotalDe()` (la misma
  función que ya usa el motor de avance real, `server/finanzas.js`).
  `presupuestoTotalDe()` prefiere `proyectos.meta.total_sin_iva` cuando
  existe, que **no siempre coincide** con `SUM(conceptos.importe)` —
  confirmado contra Preview: en 6 de 7 obras reales ambos totales
  divergían, causando hasta 3.3x de diferencia en el % reportado (un caso
  real llegó a 13.42% vs 44.54%). Se corrigió reescalando
  proporcionalmente el desglose por categoría sobre el total real de
  `presupuestoTotalDe()`, preservando la identidad
  `infra + vivienda + sin_clasificar = total`.

### Archivos y funciones específicas tocadas
- `server/db.js`: tabla nueva `conceptos_grupo_categoria` (`project_id`, `grupo`, `categoria` CHECK solo `'infraestructura'`/`'vivienda'`, `UNIQUE(project_id, grupo)`), sin FK ni relación con la tabla `lotes` (Forbidden Action explícita — Fase 1 y Fase 2 no se cruzan).
- `server/app.js`:
  - `GET /api/projects/:id/grupos-categoria` — lista grupos activos del presupuesto con su categoría (o `null`).
  - `POST /api/projects/:id/grupos-categoria` — guarda clasificaciones en lote (valida que cada `grupo` exista de verdad en el presupuesto activo, para evitar basura/typos); `categoria: 'sin_clasificar'` hace `DELETE` de la fila.
  - `GET /api/projects/:id/avance-por-categoria` — el cálculo con el fix del bug de escala descrito arriba.
  - Todos con `checkPermiso('avance', ...)` — reusa la sección de permiso existente, no crea una nueva.
- `public/app.js`: tab `infraVivienda` agregado a `ROLE_TABS` (admin, desarrollador, residente, cabo, logistica), `SECTION_DEFS.obra.tabs`, `TAB_ICONS`, `TAB_LABELS`, `AYUDA_CONTENIDO`; funciones nuevas `renderInfraVivienda(view)`, `renderInfraViviendaKpis(body)`, `renderInfraViviendaClasificar(body)`.
- `tests/infra-vivienda.test.js` — suite nueva (345 líneas) que cubre, entre otras cosas, la invariante de que las 3 categorías siguen sumando exacto al total real tras el fix de escala.

### Fragmento relevante (server/app.js, fix del bug de escala)
```js
// rawTotalPresupuesto: suma cruda de conceptos.importe por categoría (puede divergir del total real)
const rawTotalPresupuesto = total.importe_presupuesto;
const escala = rawTotalPresupuesto > 0 ? presupuestoTotalReal / rawTotalPresupuesto : 0;
for (const categoria of Object.keys(categorias)) {
  const bucket = categorias[categoria];
  bucket.importe_presupuesto = bucket.importe_presupuesto * escala;
  bucket.pct_avance = bucket.importe_presupuesto > 0
    ? Math.max(0, Math.min(100, (bucket.importe_ejecutado_acumulado / bucket.importe_presupuesto) * 100))
    : 0;
}
total.importe_presupuesto = presupuestoTotalReal; // fijado al denominador real, no a la re-suma de buckets ya escalados
```

### Clasificación de aplicabilidad a la demo
**(b) Portar adaptado.** La arquitectura (tabla de clasificación manual +
reagregación por categoría del motor de avance existente) es genérica y
vale la pena portar, especialmente el patrón "sin clasificar = ausencia de
fila, nunca un 3er valor persistido" y el fix del bug de escala (aplica a
cualquier demo cuyo `presupuestoTotalDe()`/equivalente pueda divergir de
`SUM(conceptos.importe)`). Requiere adaptar: los ejemplos de nombres de
grupo reales ("RED HIDRAULICA", nombres de obra reales mencionados en
comentarios de código) deben reemplazarse por placeholders genéricos si se
copian literalmente a comentarios en la demo.

### Dependencias
Ninguna dependencia de otros PRs de este archivo. Depende conceptualmente
del motor de avance (`avance_conceptos`, `presupuestoTotalDe()` en
`server/finanzas.js`) que se asume ya existente en la demo — si la demo no
tiene un motor de avance por concepto equivalente, este PR no es portable
sin antes portar esa base.

---

## PR #201 — feature/avance-fisico-real (2026-09-02)

**Título**: `feat(resumen): avance físico real independiente del financiero (KPI nuevo)`

### Qué problema resolvía
El "Avance ejecutado" mostrado en Inicio es un % **ponderado por dinero**
(financiero): un concepto caro que avanzó poco pesa más que uno barato que
avanzó mucho. No existía un % **simple** de "cuántos conceptos ya se
completaron" independiente de su peso monetario — dato útil para detectar
casos donde el avance financiero se ve bien solo porque los conceptos caros
avanzaron, mientras muchos conceptos pequeños siguen en cero.

### Diseño
Nuevo campo `avance_fisico_ejecutado_actual` calculado **siempre al vuelo**
(nunca lee ni escribe la columna heredada `avance_fisico_real`, que hoy solo
replica el financiero o trae overrides manuales sin fórmula definida) —
100% aditivo, no toca `avance_financiero_real` ni el donut existente. Es el
promedio simple (no ponderado por $) de
`avance_conceptos.cantidad_ejecutada / conceptos.cantidad` por concepto,
acumulado hasta la misma `semana_corte` que ya usa el cálculo financiero
(para que ambos números sean comparables en el tiempo). Conceptos sin
ninguna captura cuentan como 0% (si entran al promedio); conceptos con
`cantidad = 0` (encabezados de grupo mal marcados `es_total = 0`) se
excluyen del promedio porque no se puede calcular % de una cantidad de 0.
Diseño validado previamente contra 3 proyectos reales de Preview (valores
exactos verificados, ver PR body — omitidos aquí por ser datos de cliente
real).

### Archivos y funciones específicas tocadas
- `server/app.js`, dentro de `GET /api/projects/:id/resumen`: bloque nuevo que calcula `pctFisico` con un `AVG(LEAST(100, GREATEST(0, ...)))` sobre `conceptos` LEFT JOIN a un subquery de `avance_conceptos` acumulado; se agrega `avance_fisico_ejecutado_actual` a la respuesta JSON.
- `public/app.js`, dentro de `renderInicio(view)`: nueva tarjeta KPI "Avance físico" junto a "Avance programado"/"Avance ejecutado" — mismo componente CSS `.kpi`, sin CSS nuevo.

### Fragmento relevante (server/app.js)
```sql
SELECT AVG(LEAST(100, GREATEST(0, (COALESCE(ac_sum.acumulado, 0) / c.cantidad) * 100))) AS pct
FROM conceptos c
LEFT JOIN (
  SELECT ac.concepto_id, SUM(ac.cantidad_ejecutada) AS acumulado
  FROM avance_conceptos ac
  JOIN conceptos c2 ON c2.id = ac.concepto_id
  WHERE c2.project_id = $1 AND ac.semana <= $2
  GROUP BY ac.concepto_id
) ac_sum ON ac_sum.concepto_id = c.id
WHERE c.project_id = $1 AND c.es_total = 0 AND c.activo = 1 AND c.cantidad > 0
```
```js
// public/app.js, renderInicio():
const fisico = resumen.avance_fisico_ejecutado_actual || 0;
// ...
<div class="kpi"><div class="label">Avance físico</div><div class="value">${fmtPct(fisico)}</div></div>
```

### Clasificación de aplicabilidad a la demo
**(a) Portar tal cual.** Es una fórmula matemática genérica sobre
`conceptos`/`avance_conceptos` sin ningún dato de cliente real embebido en
el código — el PR body sí menciona 3 proyectos reales de Preview con sus
valores exactos, pero eso es solo evidencia de verificación, no algo que se
porte.

### Dependencias
Ninguna dependencia funcional de otros PRs de este archivo. El PR body
menciona que se revalidó "después de rebasear contra `main` (post-merge de
#199 y #200)" — esos dos PRs no están en el rango de este archivo (probable
que pertenezcan a otro módulo); si se investigan por separado, confirmar que
no tocan `GET /api/projects/:id/resumen` de forma incompatible.

---

## PR #203 — feat/archivar-completar-clientes (2026-09-02)

**Título**: `feat(clientes): archivar/completar cliente reversible`

### Qué problema resolvía
No existía forma de "retirar" un cliente terminado o inactivo de la galería
y de los totales globales sin borrarlo físicamente — la única opción
existente era `DELETE` permanente. Tampoco había ninguna señal automática
de "este cliente ya terminó" (avance financiero al 100%) visible en la
galería.

### Diseño
Dos grupos de columnas **ortogonales a propósito** en `clientes` (no un
enum): `archivado` y `completado` son independientes — un cliente
completado puede archivarse después sin perder la marca de completado.
- **Archivar** (`archivado`, `archivado_en`, `archivado_por`): soft-delete
  reversible que afecta **todas las obras del cliente juntas** (no hay
  archivado por-obra individual) — por eso el endpoint exige
  `confirmado: true` explícito en el payload. Excluye al cliente de
  `GET /api/clientes`, `/api/avance-por-cliente`,
  `/api/avance-por-cliente/completo`, `/api/resumen-global` y
  `getErogadoRealGlobal()` (agregado global de erogado real) — pero
  `getErogadoRealPorCliente()` (ver un cliente archivado directo en su
  propia sección) NO se toca, sigue mostrando sus números reales.
- **Completado** (`completado`, `completado_en`,
  `completado_revertido_manualmente`): detección **automática**, lazy, en el
  mismo query que ya calcula `avance_ponderado_pct` por cliente en
  `GET /api/avance-por-cliente/completo` (sin cron nuevo) — cruza a ≥100% y
  se auto-marca; cae debajo de 100% y se auto-desmarca, reseteando también
  el flag de revertido (para permitir que un ciclo de completado genuino
  futuro sí se vuelva a auto-marcar). La reversión manual
  (`completado_revertido_manualmente = true`) evita que el siguiente
  refresh re-marque `completado = true` de inmediato solo porque el % sigue
  en 100. A diferencia de archivar, "completado" es solo informativo (badge)
  y **sigue contando** en los totales globales.

### Archivos y funciones específicas tocadas
- `server/db.js`: `ALTER TABLE clientes ADD COLUMN` para `archivado`, `archivado_en`, `archivado_por`, `completado`, `completado_en`, `completado_revertido_manualmente`.
- `server/finanzas.js`: `getErogadoRealGlobal()` — cambia `SELECT id FROM proyectos` por un `LEFT JOIN clientes ... WHERE c.archivado IS NOT TRUE` (preserva proyectos huérfanos sin `cliente_id`). `getErogadoRealPorCliente()` sin cambios (deliberado).
- `server/app.js`:
  - `GET /api/clientes` — agrega `WHERE c.archivado = false` a ambas ramas (con/sin `veTodo`), y expone `c.completado` en el SELECT.
  - Endpoints nuevos: `POST /api/clientes/:id/archivar` (exige `confirmado: true`), `POST /api/clientes/:id/desarchivar`, `POST /api/clientes/:id/completado/revertir`, `GET /api/clientes/archivados`, `GET /api/clientes/completados`.
  - `GET /api/resumen-global` y `GET /api/avance-por-cliente` — agregan `LEFT/JOIN clientes` + `WHERE c.archivado IS NOT TRUE` (o `= false`).
  - `GET /api/avance-por-cliente/completo` — agrega la lógica de auto-detección de completado descrita arriba (bloque `porCompletarUpdates`/`calculados`), ejecutando los `UPDATE` en paralelo con `Promise.all` solo si hubo transiciones.
- `public/app.js`:
  - `clienteCardHtml(c)` — badge `✅ Completado` (`.cliente-badge-completado`) y opción nueva `📦 Archivar cliente` en el menú de 3 puntos (antes de "Eliminar cliente"), gateado por `isAdmin()`.
  - `wireClienteCards(grid)` — wiring del botón `data-cliente-archivar`.
  - Funciones nuevas: `archivarCliente(id, nombre)` (con `confirmDialog` explícito sobre "TODAS sus obras"), `desarchivarCliente`, `revertirCompletado`, `renderClientesArchivados(view)`, `renderClientesCompletados(view)`.
  - Botones nuevos en el drawer: `#btnGalleryGoClientesArchivados`, `#btnGalleryGoClientesCompletados` (solo admin).
- `public/index.html`: botones del drawer arriba mencionados.
- `public/styles.css`: clase `.cliente-badge-completado`.

### Fragmento relevante (server/app.js, auto-detección de completado)
```js
const porCompletarUpdates = [];
const calculados = [...porCliente.values()].map((c) => {
  const pct = c.totalPresupuesto > 0 ? (c.importeEjecutado / c.totalPresupuesto) * 100 : 0;
  if (pct >= 100 && !c.completado && !c.completadoRevertidoManualmente) {
    porCompletarUpdates.push(db.pool.query('UPDATE clientes SET completado = true, completado_en = NOW() WHERE id = $1', [c.cliente_id]));
    c.completado = true;
  } else if (pct < 100 && (c.completado || c.completadoRevertidoManualmente)) {
    porCompletarUpdates.push(db.pool.query('UPDATE clientes SET completado = false, completado_revertido_manualmente = false WHERE id = $1', [c.cliente_id]));
    c.completado = false;
  }
  return { ...c, pct };
});
if (porCompletarUpdates.length) await Promise.all(porCompletarUpdates);
```

```js
// public/app.js, archivarCliente() — confirmación explícita:
async function archivarCliente(id, nombre) {
  const ok = await confirmDialog(
    `Se archivará el cliente "${nombre}" junto con TODAS sus obras. Dejará de aparecer en la galería y en los totales globales, pero no se pierde ningún dato — puedes desarchivarlo cuando quieras desde "Clientes archivados".`,
    { titulo: 'Archivar cliente', textoAceptar: 'Archivar', textoCancelar: 'Cancelar' }
  );
  if (!ok) return;
  await api(`/clientes/${id}/archivar`, { method: 'POST', body: { confirmado: true } });
  // ...
}
```

### Clasificación de aplicabilidad a la demo
**(a) Portar tal cual.** Es un feature completo, autocontenido, de gestión
de clientes ficticios ("Cliente Demo A", "Cliente Demo B") sin dependencia
de ningún dato real — buen candidato para portar íntegro a la demo tal
cual, incluidas las 5 rutas nuevas y las 2 vistas admin.

### Dependencias
Ninguna dependencia de otros PRs de este archivo. Depende de que exista ya
`getErogadoRealGlobal()`/`getErogadoRealPorCliente()` en `server/finanzas.js`
y del query de `avance_ponderado_pct` en `GET /api/avance-por-cliente/completo`
(ambos ya deberían existir en la demo si esta ya tiene el módulo de
Clientes/Galería equivalente al de producción).
