# Nómina y Maquinaria

Cambios mergeados a `main` de App-CP entre 2026-08-18 y 2026-09-04, relevantes
para los módulos de Nómina/Trabajadores y Maquinaria. Escrito para que una
sesión de Claude Code en el repo separado **App-CP-Demo** pueda decidir, PR
por PR, si portar el cambio y cómo adaptarlo — sin tener que re-investigar
el diff original.

**Nota de orden cronológico:** el enunciado original de esta tarea listaba
PR #205 antes de PR #206, pero los timestamps reales de merge son
PR #206 = 2026-09-02 14:10:01 y PR #205 = 2026-09-02 18:11:42 — **PR #206 se
mergeó primero**. Este documento sigue el orden real (verificado con
`git log -1 --format=%ci <hash>`), no el orden del enunciado.

**Nota metodológica:** para todos los PRs excepto #160 y #205, el commit
merge tiene exactamente 1 commit propio y su primer padre coincide con el
merge-base real, así que `git diff <merge>^1 <merge>^2` ya es el diff neto
del PR. Para **PR #160** y **PR #205**, la rama estaba desactualizada
respecto a `main` en el momento del merge (el primer padre NO es el
merge-base) — para esos dos se recalculó el diff neto real como
`git diff $(git merge-base <p1> <p2>) <p2>` para no arrastrar cambios de
otras ramas que ya estaban en `main` para entonces. Los diffs mostrados
abajo para esos dos PRs ya son ese diff neto correcto, no el ingenuo
`^1..^2`.

**Nota sobre nombres reales:** varios comentarios de código citan nombres
reales de empleados/usuarios de prueba (cabos, operadores, trabajadores de
nómina) como evidencia de diagnóstico. Se omiten aquí por regla dura de esta
tarea — se referencian solo como "un cabo real", "un trabajador con split
activo", etc.

---

## PR #156 — fix/aprobacion-maquinaria-cabo-residente

**Fecha de merge:** 2026-08-18.

**Problema resuelto:** un cabo real y activo, único cabo de la cuenta en ese
momento, no podía aprobar/rechazar reportes de horas de operador — recibía
403 real del backend a pesar de que su puesto sí debería tener esa
capacidad. Además, se decidió extender esa misma capacidad de
autorizar/rechazar horas al rol `residente` (antes exclusiva de `cabo`).

**Causa raíz / diseño:**
- El backfill de la sección de permisos `maquinaria_captura` para `cabo`,
  hecho en un cambio anterior, era un `UPDATE` que solo corregía filas
  **ya existentes** en `permisos_usuario` — no creaba la fila para un cabo
  que nunca la había tenido. El único cabo activo real caía exactamente en
  ese hueco.
- Paralelamente, decisión de negocio: `residente` gana el mismo criterio
  que `cabo` para autorizar/rechazar horas (mismo permiso, misma fila).

**Archivos y funciones tocadas:**
- `server/db.js` — dos `INSERT INTO permisos_usuario ... SELECT ... WHERE
  NOT EXISTS` nuevos (patrón correcto, reemplaza el `UPDATE`-only): uno para
  cabo sin fila de `maquinaria_captura`, otro para dar de alta esa misma
  fila a todo `residente` existente.
- `server/auth.js` — `MAQUINARIA_TABS_RESIDENTE` gana `'maquinaria_horas'`;
  `defaultPermisosParaRol()` agrega un push explícito de la fila
  `maquinaria_captura` (`puede_ver=true, puede_editar=true, puede_crear=false`)
  para `residente` nuevo.
- `public/app.js` — `ROLES_AUTORIZAN_HORAS_MAQ` pasa de
  `['cabo', 'admin', 'desarrollador']` a
  `['cabo', 'residente', 'admin', 'desarrollador']`.
- `tests/maquinaria-aprobacion-cabo-residente.test.js` (nuevo, 186 líneas) —
  integración contra base real, firma un JWT propio con el mismo
  `SESSION_SECRET` del proceso para probar el cabo real sin su contraseña.

**Fragmento relevante (server/auth.js, antes/después):**
```js
// antes
const MAQUINARIA_TABS_RESIDENTE = ['maquinaria_catalogo', 'maquinaria_reportes_cliente'];
// después
const MAQUINARIA_TABS_RESIDENTE = ['maquinaria_catalogo', 'maquinaria_horas', 'maquinaria_reportes_cliente'];
```
```sql
-- backfill nuevo (patrón INSERT...WHERE NOT EXISTS, no UPDATE)
INSERT INTO permisos_usuario (usuario_id, proyecto_id, seccion, puede_ver, puede_crear, puede_editar, puede_editar_precios, puede_eliminar)
SELECT u.id, NULL, 'maquinaria_captura', true, false, true, false, false
FROM usuarios u
WHERE u.puesto = 'cabo'
  AND NOT EXISTS (SELECT 1 FROM permisos_usuario pu WHERE pu.usuario_id = u.id AND pu.proyecto_id IS NULL AND pu.seccion = 'maquinaria_captura');
-- mismo INSERT repetido con WHERE u.puesto = 'residente'
```

**Clasificación de aplicabilidad a la demo:** (b) portar adaptado. La lógica
de permisos (`ROLES_AUTORIZAN_HORAS_MAQ`, tabs de residente, fila de
`defaultPermisosParaRol`) aplica igual si la demo tiene el mismo modelo de
roles/permisos granulares en Maquinaria. Los dos `INSERT...WHERE NOT EXISTS`
de backfill NO aplican tal cual — son correcciones retroactivas de datos de
producción real; en la demo basta con que `defaultPermisosParaRol` ya esté
correcto desde el principio (no hace falta backfill si no hay usuarios
legacy con el hueco).

**Dependencias:** ninguna con otros PRs de este módulo. Es la base sobre la
que PR #160 y #193 siguen ajustando el mismo sistema de permisos de
Maquinaria.

---

## PR #160 — fix/permisos-maquinaria-completo

**Fecha de merge:** 2026-08-19.

**Problema resuelto:** dos partes.
1. Auditoría de permisos encontró 3 operadores reales sin fila de
   `maquinaria_captura` (bloqueados para capturar horas) y 1 jefe_maquinaria
   real sin fila de `maquinaria_combustible` (bloqueado para registrar
   combustible/mantenimiento) — mismo patrón de bug que PR #156, pero para
   otros roles/secciones.
2. Bug encontrado en revisión de dispositivo real: la herramienta interna
   "Vista como" (simulación de rol, solo desarrollador) usaba 5 listas
   `ROLES_*_MAQ` hardcodeadas en el frontend para decidir qué botones
   mostrar — necesarias porque el permiso crudo del backend para
   admin/desarrollador siempre es bypass=true y no distingue el rol
   simulado. Auditoría confirmó que 3 de esas 5 listas (`ROLES_AUTORIZAN_
   HORAS_MAQ`, `ROLES_BITACORA_TALLER_MAQ`, `ROLES_SUPERVISAN_ESTADO_
   UNIDAD_MAQ`) ya no otorgaban ningún permiso que el permiso granular real
   (`misPermisos.puede_X`) no diera ya por sí solo para ningún usuario real
   — eran redundantes y se eliminaron. Las 2 restantes
   (`ROLES_CAPTURAN_HORAS_MAQ`/`ROLES_CAPTURAN_ESTADO_UNIDAD_MAQ`) se
   conservaron, pero acotadas a un único uso legítimo (menú de acceso rápido
   "+", que no tiene permiso granular compañero).

**Causa raíz:** mismo patrón de PR #156 — backfills previos que solo
cubrían algunos roles/secciones, no todos los que ya recibían el permiso
por default en altas nuevas. Efecto secundario aceptado del punto 2: la
"Vista como" ahora puede mostrar a admin/desarrollador botones que no le
corresponderían al rol simulado (cosmético, solo afecta esa herramienta de
preview de 2 cuentas — el backend real sigue exigiendo el permiso real).

**Archivos y funciones tocadas:**
- `server/db.js` — 2 `INSERT...WHERE NOT EXISTS` nuevos: `maquinaria_captura`
  para `operador`, `maquinaria_combustible` para `jefe_maquinaria`.
- `public/app.js` — elimina `ROLES_AUTORIZAN_HORAS_MAQ`,
  `ROLES_BITACORA_TALLER_MAQ`, `ROLES_SUPERVISAN_ESTADO_UNIDAD_MAQ`,
  `ROLES_CAPTURAN_ESTADO_UNIDAD_MAQ` (esta última se recrea, ver abajo) de
  todos los `render*` de Maquinaria (`renderMaquinariaCatalogo`,
  `renderMaquinariaHoras`, `renderMaquinariaBitacora`,
  `renderMaquinariaEstadoUnidad`, `renderMaquinariaConsumibles`,
  `renderMaquinariaReportesCliente`) — cada botón pasa a depender solo de
  `misPermisos.puede_X`.

**Fragmento relevante (public/app.js, antes/después en `renderMaquinariaHoras`):**
```js
// antes
const puedeCrearHoras = !!misPermisosCaptura.puede_crear && ROLES_CAPTURAN_HORAS_MAQ.includes(effectivePuesto());
const puedeAutorizarHoras = !!misPermisosCaptura.puede_editar && ROLES_AUTORIZAN_HORAS_MAQ.includes(effectivePuesto());
// después
const puedeCrearHoras = !!misPermisosCaptura.puede_crear;
const puedeAutorizarHoras = !!misPermisosCaptura.puede_editar;
```

**Clasificación de aplicabilidad a la demo:** (c) no aplica el backfill de
`server/db.js` (correcciones de datos reales de producción, ver PR #156).
(b) portar adaptado el refactor de frontend — si la demo copió alguna vez
las listas `ROLES_*_MAQ` como gate adicional de UI, vale la pena adoptar el
mismo criterio de "el permiso granular real basta, no dupliques la lógica
en el frontend salvo casos sin permiso granular compañero (el atajo +)".

**Dependencias:** depende conceptualmente de PR #156 (mismo sistema de
permisos de Maquinaria, mismo patrón de bug de backfill). PR #193 sigue
tocando exactamente las mismas 2 secciones (`maquinaria_combustible` se
termina de separar en `maquinaria_combustible`/`maquinaria_mantenimiento`).

---

## PR #164 — feat/agregar-gasolina-consumibles

**Fecha de merge:** 2026-08-19.

**Qué resolvía / diseño:** el catálogo de "tipo de consumible" en Maquinaria
tenía `diesel`, `aceite_motor`, `aceite_hidraulico`, `aceite_transmision`,
pero no `gasolina` — feature de catálogo, agregar el tipo faltante.
Insumos ya tenía un concepto propio `'GASOLINA'` (distinto de `'DIESEL'`),
confirmado en diagnóstico previo — no cae en el bucket genérico `'ACEITE'`
que comparten los 3 aceites.

**Archivos y funciones tocadas:**
- `server/db.js` — `CREATE TABLE consumibles_maquinaria` (CHECK del `tipo`)
  amplía el CHECK a incluir `'gasolina'`; además `ALTER TABLE ... DROP
  CONSTRAINT` + `ADD CONSTRAINT` para bases ya existentes (el `CREATE TABLE
  IF NOT EXISTS` no vuelve a correr sobre ellas).
- `server/app.js` — `TIPOS_CONSUMIBLE` array gana `'gasolina'`.
- `server/maquinaria.js` — `resolverCostoConsumible(tipo)`: antes
  `tipo === 'diesel' ? 'DIESEL' : 'ACEITE'` (ternario plano), después un mapa
  `CONCEPTO_INSUMO_POR_TIPO_CONSUMIBLE = { diesel: 'DIESEL', gasolina:
  'GASOLINA' }` con fallback a `'ACEITE'`.
- `public/app.js` — `TIPOS_CONSUMIBLE_LABELS` gana `gasolina: 'Gasolina'`.

**Fragmento relevante (server/maquinaria.js, antes/después):**
```js
// antes
async function resolverCostoConsumible(tipo) {
  const concepto = tipo === 'diesel' ? 'DIESEL' : 'ACEITE';
  ...
}
// después
const CONCEPTO_INSUMO_POR_TIPO_CONSUMIBLE = { diesel: 'DIESEL', gasolina: 'GASOLINA' };
async function resolverCostoConsumible(tipo) {
  const concepto = CONCEPTO_INSUMO_POR_TIPO_CONSUMIBLE[tipo] || 'ACEITE';
  ...
}
```

**Clasificación de aplicabilidad a la demo:** (a) portar tal cual — es un
alta de catálogo simple y autocontenida, sin dependencia de datos reales.
Único prerequisito: que la demo tenga el mismo modelo de "concepto de
insumo por tipo de consumible" en Insumos, o el fallback a `'ACEITE'`
resolverá mal el costo de gasolina.

**Dependencias:** ninguna.

---

## PR #173 — feat/nomina-personal-maquinaria

**Fecha de merge:** 2026-08-21.

**Diseño:** permitir dar de alta personal de Maquinaria (operadores,
mecánicos de mantenimiento) como trabajadores normales del módulo de
Nómina, reusando el motor de nómina existente sin cambios — pero marcados
con una categoría de costo (`obra` vs `maquinaria`) para que su nómina ya
aprobada se impute al Reporte de Maquinaria por cliente en vez de
mezclarse con el costo general de obra.

**Archivos y funciones tocadas:**
- `server/db.js` — `ALTER TABLE trabajadores ADD COLUMN IF NOT EXISTS
  categoria_costo TEXT NOT NULL DEFAULT 'obra'` (sin CHECK a nivel BD, mismo
  patrón ya usado para `puesto`/`actividad` — validado en código).
- `server/app.js` — `CATEGORIAS_COSTO = ['obra', 'maquinaria']`; POST/PUT de
  trabajador aceptan y validan `categoria_costo` (default `'obra'` si no
  viene); `TRABAJADOR_COLUMNAS_LISTADO` incluye la columna nueva.
- `server/maquinaria.js` — `getReportePorCliente()`: nueva subquery
  `gasto_personal` = `SUM(nomina_items.monto_total)` de trabajadores con
  `categoria_costo = 'maquinaria'`, **solo de nóminas en estado `'aprobada'`**
  (mismo criterio de "dinero real" que el resto del sistema de Nómina — una
  nómina en borrador/revisión puede cambiar o rechazarse). Atribución vía
  `nominas.project_id` (fijo por periodo), a diferencia de
  combustible/mantenimiento que se atribuyen vía `equipos_maquinaria.obra_id`
  (mutable — limitación conocida y documentada en el propio código, sin
  cambios en este PR). `gasto_total` pasa a ser
  `gasto_combustible + gasto_mantenimiento + gasto_personal`.
- `public/app.js` — modal de trabajador gana el selector "Categoría de
  costo"; tabla del Reporte de Maquinaria por cliente gana 2 columnas
  (Combustible+mantenimiento, Personal) desglosando lo que antes era un
  solo "Gasto real".

**Fragmento relevante (server/maquinaria.js):**
```sql
COALESCE((
  SELECT SUM(ni.monto_total) FROM nomina_items ni
  JOIN trabajadores t ON t.id = ni.trabajador_id AND t.categoria_costo = 'maquinaria'
  JOIN nominas n ON n.id = ni.nomina_id AND n.estado = 'aprobada'
  JOIN proyectos p ON p.id = n.project_id
  WHERE p.cliente_id = $1
), 0) AS gasto_personal
```

**Clasificación de aplicabilidad a la demo:** (b) portar adaptado — la
feature completa (columna, validación, subquery de reporte, UI) aplica tal
cual si la demo ya tiene el Reporte de Maquinaria por cliente (PR previo,
fuera de este módulo/documento — confirmar con el módulo de Maquinaria/
Reportes si existe). Si la demo no tiene ese reporte, esta feature no tiene
a dónde enganchar el `gasto_personal` y no aplica.

**Dependencias:** requiere que exista `getReportePorCliente()`/Reporte de
Maquinaria por cliente (feature anterior a los 20 días cubiertos aquí, no
documentada en este archivo). Ninguna dependencia con otros PRs de esta
lista.

---

## PR #175 — feat/cancelar-nomina

**Fecha de merge:** 2026-08-21.

**Diseño:** agregar un estado `cancelada` a la máquina de estados de Nómina
(antes: `borrador`, `revision`, `aprobada`, `rechazada`) para soft-delete de
una nómina capturada por error, mismo patrón ya usado en Requisiciones —
distinto de simplemente borrarla, porque una nómina que llegó a
`revision`/`rechazada` puede tener contexto/histórico que vale la pena
conservar. Acotado a propósito: **nunca** se agrega la transición
`aprobada → cancelada` (una nómina aprobada ya es "dinero real" en Erogado
Real y en el Reporte de Maquinaria por cliente — revertir eso es decisión
de negocio aparte).

**Archivos y funciones tocadas:**
- `server/app.js`:
  - `ESTADOS_NOMINA` gana `'cancelada'`.
  - `transicionesPermitidas` (dentro de `PUT /nominas/:nomId/estado`): agrega
    `cancelada: esAdmin` desde `borrador` y desde `revision` — admin-only,
    nunca desde `aprobada`.
  - Motivo obligatorio para cancelar: `if (estado === 'cancelada' &&
    !nota_rechazo?.trim()) return res.status(400)...` — reusa el campo
    `nota_rechazo` (ya existente para rechazar, ahí opcional) como "motivo
    de cancelación", ahí obligatorio.
  - `DELETE /nominas/:nomId`: acotado de "cualquier estado excepto
    `aprobada`" a **solo `'borrador'`** — cualquier nómina que salió de
    `borrador` se cancela (soft-delete), nunca se borra físicamente. Mismo
    patrón que el DELETE de Requisiciones.
- `public/app.js` — botón "Cancelar" (solo si `estado` en
  `['borrador','revision']` y `puedeAprobarNomina()`, que es `isAdmin()`);
  `NOMINA_ESTADO_LABELS`/`NOMINA_ESTADO_BADGE` ganan `cancelada`/`'purple'`
  (deliberadamente distinto de `'muted'`/`'red'`: es un estado terminal sin
  acción pendiente). El modal de cambio de estado (`openCambioEstadoModal`)
  se reusa para cancelar, con label/validación distintos.
  **Detalle no documentado en el prompt pero presente en el diff:** el
  `body` enviado al PUT cambia de `{ estado, nota }` a `{ estado,
  nota_rechazo: nota }` — antes el frontend mandaba el campo con el nombre
  equivocado (`nota`) mientras el backend siempre leyó `nota_rechazo`; este
  PR corrige esa discrepancia de paso, no solo agrega cancelar.

**Fragmento relevante (server/app.js, antes/después del DELETE):**
```js
// antes
if (nomRows[0].estado === 'aprobada') return res.status(409).json({ error: 'No se puede eliminar una nómina aprobada' });
// después
if (nomRows[0].estado !== 'borrador') {
  return res.status(400).json({ error: 'Solo se pueden eliminar nóminas en estado "borrador"' });
}
```

**Clasificación de aplicabilidad a la demo:** (a) portar tal cual — feature
autocontenida de máquina de estados, sin dependencia de datos reales. Vale
la pena verificar en la demo si el bug de `nota` vs `nota_rechazo` también
existe ahí (mismo copy-paste posible) antes de portar solo la parte de
"cancelar" y dejar ese bug de paso sin corregir.

**Dependencias:** ninguna con otros PRs de este módulo. Nota: el estado
`cancelada` interactúa con el criterio "solo nóminas `aprobada`" que usa
`gasto_personal` de PR #173 — una nómina cancelada nunca debió contarse ahí
de todos modos (no es `aprobada`), así que no hay conflicto real, pero es
la misma máquina de estados que ambos PRs tocan.

---

## PR #193 — fix/permisos-cabo-limpieza

**Fecha de merge:** 2026-08-27.

**Problema resuelto:** limpieza de 3 problemas de permisos encontrados en
auditoría/verificación en vivo, todos en el mismo PR:
1. `cabo` no podía ver la lista de Trabajadores/Nóminas por default —
   requería que un admin se lo activara caso por caso (`default-deny`
   introducido en un cambio anterior). Cambio de dirección de negocio:
   `cabo` debe poder **ver** ambas listas por default (el scope real de qué
   trabajadores ve lo sigue dando `verificarAccesoObra`/`usuario_proyectos`,
   no este flag).
2. "Dar de baja" a un trabajador debía quedar **bloqueada para cabo**, sin
   importar qué le otorgue la matriz de `permisos_usuario` — bloqueo duro a
   nivel de ruta (`auth.allow()`), no delegable por permisos granulares.
   "Reactivar" NO se tocó — sigue permitido para cabo.
3. La sección `maquinaria_combustible` fusionaba combustible **y**
   bitácora de mantenimiento bajo un solo permiso desde una decisión de
   diseño anterior (`CN-002`) — eso hacía que otorgar solo combustible a
   alguien (ej. cabo) le heredara también lectura/creación de
   mantenimientos sin que fuera decisión explícita. Se separó en
   `maquinaria_mantenimiento`, sección propia.
   Bug adicional encontrado en la misma auditoría: `GET
   /api/maquinaria/combustible` gateaba con la sección genérica
   `'maquinaria'` (compartida con catálogo/horas) en vez de la granular
   `'maquinaria_combustible'` — cualquier rol con solo `puede_ver` en
   `'maquinaria'` (cabo, residente) podía leer combustible vía API directa
   o vía el panel "Historial" de Catálogo aunque su UI nunca expusiera el
   tab de Bitácora.
4. Bug de scope encontrado en vivo con un cabo de prueba: 6 secciones de
   Maquinaria (`maquinaria`, `maquinaria_captura`, `maquinaria_combustible`,
   `maquinaria_consumibles`, `estado_unidad`, `maquinaria_mantenimiento`)
   nunca estuvieron en `SECCIONES_SIEMPRE_GLOBAL` — si el admin tenía una
   obra específica seleccionada al otorgar cualquiera de estas, la fila se
   guardaba con `proyecto_id` de esa obra en vez de `NULL`, y
   `tienePermiso()` nunca la encontraba (esos 6 endpoints son
   catálogo/registro cross-obra, no cuelgan de `/api/projects/:id`) — el
   toggle se veía marcado en la UI pero el permiso real nunca aplicaba
   (403 real).

**Causa raíz:** puntos 1 y 3a son el mismo patrón de "gap de default" ya
visto en PR #156/#160. Punto 2 es un bloqueo de negocio nuevo, no un bug.
Punto 4 es un bug real de UI-vs-backend con síntoma engañoso ("se ve
marcado pero no aplica") — mismo tipo de bug ya descrito en el CLAUDE.md
del repo para altas de sección de permisos.

**Archivos y funciones tocadas:**
- `server/auth.js` — `SECCIONES_PERMISOS` gana `'maquinaria_mantenimiento'`;
  `defaultPermisosParaRol()`: `residente` gana filas explícitas de
  `maquinaria_combustible`/`maquinaria_mantenimiento` (solo lectura,
  preservando lo que ya veía); override previo de `cabo` para
  `trabajadores.puede_ver = false` se **elimina** (vuelve al default `true`
  del loop base); `jefe_maquinaria` gana fila explícita de
  `maquinaria_mantenimiento` (ver+crear, igual que combustible).
- `server/app.js` — `GET /maquinaria/combustible` pasa de checkPermiso
  `('maquinaria', 'puede_ver')` a `('maquinaria_combustible', 'puede_ver')`;
  `GET /maquinaria/mantenimientos` y `GET /maquinaria/bitacora-taller` pasan
  de `'maquinaria_combustible'` a `'maquinaria_mantenimiento'`; `POST
  /maquinaria/mantenimientos` idem. `POST /trabajadores/:wId/baja`:
  `auth.allow('residente', 'cabo')` → `auth.allow('residente')` (cabo
  retirado del allow-list, bloqueo duro).
- `server/db.js` — `permisos_usuario_seccion_check` (CHECK constraint, en
  las 2 ubicaciones — `CREATE TABLE` y `ALTER TABLE`) gana
  `'maquinaria_mantenimiento'`; 2 `INSERT...WHERE NOT EXISTS` de backfill
  (`maquinaria_combustible` para `residente`; `maquinaria_mantenimiento`
  para `jefe_maquinaria` y `residente`, deliberadamente **sin** backfillear
  a ningún `cabo` existente — el punto de la separación es que ese permiso
  ya no implique mantenimiento automáticamente).
- `public/app.js` — `PERMISOS_SECCION_LABELS` separa el label
  "Maquinaria (combustible/mantenimiento)" en dos; `SECCIONES_SIEMPRE_
  GLOBAL` gana las 6 secciones del punto 4; `ACCIONES_CON_ENFORCEMENT` y
  `PERMISOS_GRUPOS` ganan `maquinaria_mantenimiento`;
  `defaultPermisosParaRolFrontend()` (mirror de auth.js) actualizado igual;
  `renderMaquinariaBitacora()` pasa a pedir `/mis-permisos/maquinaria_
  mantenimiento` por separado de `/mis-permisos/maquinaria_combustible`;
  `toggleHistorialMaq()` envuelve las llamadas a combustible/mantenimientos
  en `.catch(() => [])` para que un 403 esperado (cabo sin acceso a
  Bitácora) no rompa el panel completo.
- `tests/permisos-cabo-limpieza.test.js` (nuevo, 260 líneas).

**Fragmento relevante (server/app.js, el bug de scope crudo, ejemplo con combustible):**
```js
// antes
app.get('/api/maquinaria/combustible', h(auth.checkPermiso('maquinaria', 'puede_ver')), ...
// después
app.get('/api/maquinaria/combustible', h(auth.checkPermiso('maquinaria_combustible', 'puede_ver')), ...
```
```js
// public/app.js — antes
const SECCIONES_SIEMPRE_GLOBAL = ['trabajadores_global', 'nominas_global', 'costos', 'estado_resultados_global'];
// después
const SECCIONES_SIEMPRE_GLOBAL = ['trabajadores_global', 'nominas_global', 'costos', 'estado_resultados_global', 'maquinaria', 'maquinaria_captura', 'maquinaria_combustible', 'maquinaria_consumibles', 'estado_unidad', 'maquinaria_mantenimiento'];
```

**Clasificación de aplicabilidad a la demo:** (b) portar adaptado. El
checklist de 5 puntos del CLAUDE.md de este repo (SECCIONES_PERMISOS +
2 CHECK constraints + allow-lists de bootstrap + labels/grupos/enforcement
en `public/app.js`) aplica igual a la demo si tiene un catálogo de permisos
granular equivalente. **El punto de `SECCIONES_SIEMPRE_GLOBAL` es el más
importante de portar/revisar**, aunque la demo no tenga exactamente este
bug: cualquier sección que gatee un endpoint cross-obra (sin `:id` de
proyecto en la ruta) necesita estar en esa lista o el permiso otorgado con
una obra específica seleccionada en el selector del admin nunca aplicará.
El backfill de `server/db.js` (c) no aplica — son correcciones de datos
reales.

**Dependencias:** depende directamente de PR #156/#160 (mismo sistema de
permisos de Maquinaria, extiende la separación de `maquinaria_combustible`
que #160 dejó a medias). El bloqueo de "dar de baja" para cabo (punto 2) es
independiente y no depende de ningún otro PR de este módulo.

---

## PR #194 — feat/editar-borrar-reporte-horas-propio

**Fecha de merge:** 2026-08-29.

**Problema resuelto:** un operador real reportó que "no me deja borrar al
corregir" un reporte de horas capturado por error — diagnóstico confirmó
que no era un bug de UI/dispositivo, sino que la capacidad de
editar/borrar el **propio** reporte de horas nunca había existido (el único
DELETE existente era administrativo, sin candado de dueño).

**Diseño:** dos endpoints nuevos, candado distinto del DELETE
administrativo (que sigue intacto, sin cambios): ownership
(`operador_id = req.user.id`) + `estado = 'pendiente'` se exigen **dentro
del propio `UPDATE`/`UPDATE...SET activo=false`**, atómico (evita carrera
entre "cabo autoriza" y "operador edita" el mismo registro). Si 0 filas
afectadas, una segunda consulta de solo lectura
(`getHorasOwnershipInfo`) distingue 404 (no existe) / 403 (ajeno) / 409
(ya revisado) para dar un mensaje útil sin sacrificar la atomicidad.

**Gate de permiso deliberado:** ambos endpoints usan
`checkPermiso('maquinaria_captura', 'puede_crear')` — el mismo permiso que
ya usa el POST de captura, no `puede_editar` (ese es el de cabo/residente
para autorizar/rechazar). Por diseño de `defaultPermisosParaRol`, SOLO
`operador` tiene `puede_crear=true` en esa sección — cabo/residente quedan
bloqueados por este mismo gate sin necesitar un flag nuevo (evita que
cabo/admin usen estos endpoints como atajo para editar reportes ajenos).

**Archivos y funciones tocadas:**
- `server/app.js` — `PUT /api/maquinaria/horas/:id` y `DELETE
  /api/maquinaria/horas/:id/propio` (nuevos); helper
  `resolverErrorHorasPropio(req, res)` para el 404/403/409.
- `server/maquinaria.js` — `updateHorasPropio(id, operadorId, {...})`,
  `softDeleteHorasPropio(id, operadorId)`, `getHorasOwnershipInfo(id)`
  (nuevas, exportadas).
- `public/app.js` — `paintReportesHorasMaq()` gana columna de acciones
  (botones Editar/Borrar, solo visibles si `estado === 'pendiente'`);
  `openHorasMaqModal(equipos, proyectos, reporteExistente = null)` gana
  modo edición (prefill + PUT en vez de POST cuando `reporteExistente` no
  es null).
- `tests/editar-borrar-reporte-horas-propio.test.js` (nuevo, 239 líneas).

**Fragmento relevante (server/maquinaria.js):**
```js
async function updateHorasPropio(id, operadorId, { equipo_id, fecha, horas, obra_id, actividad }) {
  const { rows } = await db.pool.query(
    `UPDATE reportes_horas_maquinaria
     SET equipo_id = $1, fecha = $2, horas = $3, obra_id = $4, actividad = $5
     WHERE id = $6 AND operador_id = $7 AND activo = true AND estado = 'pendiente'
     RETURNING *`,
    [equipo_id, fecha, horas, obra_id || null, actividad, id, operadorId]
  );
  return rows[0];
}
```

**Clasificación de aplicabilidad a la demo:** (a) portar tal cual — feature
autocontenida, sin dependencia de datos reales, aplicable siempre que la
demo tenga el mismo modelo de reportes de horas de Maquinaria con estado
`pendiente/autorizado/rechazado` y dueño (`operador_id`).

**Dependencias:** depende del sistema de permisos de Maquinaria
(`maquinaria_captura`) ya establecido en PR #156/#160/#193 — ninguna
dependencia de código directa, pero el gate de permiso asume ese mismo
modelo.

---

## PR #195 — feat/insumos-mano-obra-y-nomina-importe-fijo

**Fecha de merge:** 2026-08-29.

Dos features independientes en un mismo PR (verificado: no comparten
archivos de lógica de negocio, solo coexisten en el mismo commit).

### Parte A — Toggle "Incluir mano de obra" en catálogo de Insumos

**Qué resolvía:** el catálogo de Insumos (pantalla de `residente`/`cabo`/
`admin`) excluía por diseño los insumos con código `MO*` (mano de obra) sin
ningún toggle visible — un residente real reportó no ver entre 25% y 32%
de los insumos de sus obras. El mecanismo de "incluir mano de obra" ya
existía (`incluirManoObra` en `getInsumosData()`, usado por el buscador de
Mapeo) pero el catálogo de Insumos nunca lo exponía.

**Archivos y funciones tocadas:**
- `server/app.js` — `GET /projects/:id/insumos/categorias` gana el mismo
  query param opt-in `incluirManoObra` (antes el filtro `AND (codigo IS
  NULL OR codigo NOT ILIKE 'MO%')` era incondicional).
- `public/app.js` — `insumosFilter` gana `incluirManoObra: false`
  (default = comportamiento actual sin cambios); toggle visual nuevo en
  `renderInsumos()`; `paintInsumos()` agrega un badge "Mano de obra"
  (`/^MO/i.test(i.codigo)`) para distinguir visualmente esos insumos del
  resto cuando el toggle los trae.

**Clasificación de aplicabilidad a la demo:** (a) portar tal cual, si la
demo tiene el mismo mecanismo `incluirManoObra`/`getInsumosData()` ya usado
por Mapeo. Feature de UI pura + 1 query param, sin dependencia de datos
reales.

### Parte B — Importe fijo con snapshot en Nómina (reemplaza split por %)

**Qué resolvía:** el reparto de pago entre cuenta de nómina/cuenta alterna
usaba `split_cuenta_nomina_pct` (0-100, default 100), **calculado en
lectura** cada vez que se consultaba una nómina. El cliente necesitaba una
cifra exacta e inmutable por corrida para el timbrado ante el IMSS — un
porcentaje recalculado en vivo no sirve para eso, y menos si el trabajador
cambia su expediente después.

**Diseño:** `trabajadores.importe_tarjeta_nomina` (NUMERIC nullable),
coexiste con `split_cuenta_nomina_pct` sin reemplazarlo. Al calcular una
nómina, si el trabajador tiene `importe_tarjeta_nomina` capturado (no
NULL), se usa como monto fijo a cuenta de nómina (el resto por diferencia
a la alterna); si excede el `monto_total` de esa corrida, se **rechaza el
cálculo completo de la nómina** con error explícito (nunca se trunca ni se
permite diferencia negativa — decisión explícita del cliente). El
resultado se graba como **snapshot permanente** en
`nomina_items.importe_tarjeta_nomina_snapshot`/`importe_cuenta_alterna_
snapshot`. La lectura (`adjuntarDesgloseCuentas()`) pasa de "calcular
siempre en vivo desde `trabajadores`" a "usar el snapshot si existe, caer a
cálculo en vivo solo si es NULL (nóminas históricas previas a este
cambio)". Deliberadamente **no se migran** los 2 trabajadores reales que
hoy usan split por % — su importe fijo equivalente no es auto-derivable de
un % que aplicaba sobre un `monto_total` distinto cada corrida; queda como
acción manual pendiente del cliente, no del código.

**Archivos y funciones tocadas:**
- `server/db.js` — `ALTER TABLE nomina_items ADD COLUMN IF NOT EXISTS
  importe_tarjeta_nomina_snapshot DOUBLE PRECISION`, ídem
  `importe_cuenta_alterna_snapshot`; `ALTER TABLE trabajadores ADD COLUMN
  IF NOT EXISTS importe_tarjeta_nomina NUMERIC CHECK (importe_tarjeta_
  nomina >= 0)`.
- `server/calculos.js` — `calcularSplitCuentas(montoTotal, splitPct,
  tieneCuentaAlterna, importeFijo)` gana un 4° parámetro **opcional** (si se
  omite, comportamiento idéntico al de antes — usado así por el fallback de
  lectura para nóminas históricas). Devuelve también
  `excedeImporteFijo: true/false`.
- `server/app.js` — `validarImporteTarjetaNomina(raw)` (nueva, mismo
  patrón que `validarSplitPct`); POST/PUT de trabajador la usan, mismo
  gate de permiso (`trabajadores_bancarios`) que ya tenía el split;
  `adjuntarDesgloseCuentas()` prioriza el snapshot sobre el cálculo en
  vivo; `POST /nominas/:nomId/calcular` calcula
  `calcularSplitCuentas(total, t.split_cuenta_nomina_pct, tieneAlterna,
  t.importe_tarjeta_nomina)` por trabajador y aborta la transacción
  completa (`throw` con `err.status = 400`) si `excedeImporteFijo`.
- `public/app.js` — modal de expediente de trabajador gana el campo
  "Importe fijo a tarjeta de nómina", con nota de que gana sobre el % si
  ambos están capturados.
- `tests/calculos.test.js` (+32 líneas),
  `tests/importe-tarjeta-nomina-snapshot.test.js` (nuevo, 207 líneas).

**Fragmento relevante (server/calculos.js, antes/después):**
```js
// antes
function calcularSplitCuentas(montoTotal, splitPct, tieneCuentaAlterna) {
  const total = Number(montoTotal);
  if (!tieneCuentaAlterna) return { montoCuentaNomina: total, montoCuentaAlterna: 0 };
  const montoCuentaNomina = Number((total * Number(splitPct) / 100).toFixed(2));
  const montoCuentaAlterna = Number((total - montoCuentaNomina).toFixed(2));
  return { montoCuentaNomina, montoCuentaAlterna };
}
// después (firma con 4° parámetro opcional)
function calcularSplitCuentas(montoTotal, splitPct, tieneCuentaAlterna, importeFijo) {
  const total = Number(montoTotal);
  if (!tieneCuentaAlterna) return { montoCuentaNomina: total, montoCuentaAlterna: 0, excedeImporteFijo: false };
  if (importeFijo !== undefined && importeFijo !== null) {
    const fijo = Number(importeFijo);
    if (fijo > total) return { montoCuentaNomina: null, montoCuentaAlterna: null, excedeImporteFijo: true };
    return { montoCuentaNomina: fijo, montoCuentaAlterna: Number((total - fijo).toFixed(2)), excedeImporteFijo: false };
  }
  const montoCuentaNomina = Number((total * Number(splitPct) / 100).toFixed(2));
  const montoCuentaAlterna = Number((total - montoCuentaNomina).toFixed(2));
  return { montoCuentaNomina, montoCuentaAlterna, excedeImporteFijo: false };
}
```

**Clasificación de aplicabilidad a la demo:** (b) portar adaptado —
depende de que la demo tenga el mismo modelo de `split_cuenta_nomina_pct`/
cuenta alterna en Trabajadores y el mismo flujo de cálculo de nómina
(`POST .../nominas/:nomId/calcular`). El motivo de negocio (timbrado IMSS
exacto) es específico del cliente real — para la demo, vale la pena portar
la mecánica (snapshot permanente, importe fijo opcional) aunque se
simplifique o se omita la justificación de negocio en el copy de UI. **No
migrar** ningún trabajador de la demo automáticamente si existe un
equivalente al split — la decisión de negocio del PR original fue
explícitamente no auto-migrar.

**Dependencias:** ninguna con otros PRs de este módulo (Parte A y B son
independientes entre sí y del resto de la lista).

---

## PR #206 — fix/rename-registrar-pago-modal

**Fecha de merge:** 2026-09-02 14:10:01 (mergeado **antes** que PR #205,
ver nota de orden cronológico al inicio del documento).

**Problema resuelto:** el botón "Registrar pago" del detalle de una Orden
de Compra invocaba, por error silencioso, la lógica de "Registrar pago" de
**Cobranza** (`TypeError: planItems.map is not a function`, sin ningún
feedback visible al usuario) — bug diagnosticado previamente en
`prompt-diagnostico-boton-registrar-pago-oc.md` (no incluido en este PR,
solo referenciado en comentarios).

**Causa raíz:** colisión de nombres — dos `function openRegistrarPagoModal
(...)` de nivel superior en `public/app.js`, una para Órdenes de Compra
(cerca de la línea 7511) y otra, más abajo en el mismo archivo, para
Cobranza (línea ~22202). En JavaScript, dos declaraciones `function` de
nivel superior con el mismo nombre no dan error — la segunda
**sobreescribe silenciosamente** a la primera. Como la de Cobranza se
declaraba después en el archivo, ganaba siempre, sin importar cuál flujo
(OC o Cobranza) el usuario disparara primero — el mismo tipo de bug de
colisión de nombres que, según el CLAUDE.md de este repo, se ha repetido
varias veces en la aplicación.

**Archivos y funciones tocadas (public/app.js):**
- La función de Órdenes de Compra se renombra
  `openRegistrarPagoModal` → **`openRegistrarPagoOcModal`**.
- La función de Cobranza se renombra
  `openRegistrarPagoModal` → **`openRegistrarPagoCobranzaModal`**.
- Los 2 call-sites (`openOrdenDetalle` para OC,
  `pintarCobranzaDetalleModal` para Cobranza) se actualizan cada uno a su
  nombre nuevo correspondiente.

**Fragmento relevante (antes/después):**
```js
// antes — 2 funciones con el mismo nombre en el mismo archivo
function openRegistrarPagoModal(orden) { ... }        // Órdenes de Compra, línea ~7511
function openRegistrarPagoModal(contratoResumen, planItems) { ... }  // Cobranza, línea ~22202 — GANA (declarada después)

// después
function openRegistrarPagoOcModal(orden) { ... }
function openRegistrarPagoCobranzaModal(contratoResumen, planItems) { ... }
```

**Clasificación de aplicabilidad a la demo:** (b) portar adaptado — no es
un cambio de comportamiento, es un rename de 2 funciones + sus call-sites.
Solo aplica si la demo tiene la misma colisión de nombres (copió el mismo
código de Órdenes de Compra y Cobranza con el nombre genérico
`openRegistrarPagoModal` en ambos). Vale la pena, de cualquier forma,
`grep -n "^function open"` en el `app.js` de la demo para descartar
colisiones equivalentes de otros módulos — es un patrón de bug que ya se
repitió más de una vez en el repo real.

**Dependencias:** ninguna con otros PRs de este módulo (aunque temáticamente
es Órdenes de Compra/Cobranza, no Nómina/Maquinaria — se documenta aquí
porque así fue asignado en el listado de PRs de este módulo).

---

## PR #205 — feat/fusionar-trabajadores-nominas

**Fecha de merge:** 2026-09-02 18:11:42 (mergeado **después** de PR #206,
ver nota de orden cronológico al inicio del documento).

**Diseño:** fusionar 4 tabs de menú (`trabajadores`, `trabajadores_global`,
`nominas`, `nominas_global`) en 2 (`trabajadores`, `nominas`), cada uno con
un selector interno "Esta obra" / "Todas las obras" — mismo patrón ya
usado por el tab `finanzas` (selector "Esta obra"/"Por cliente"/"Todas las
obras", introducido en un cambio de diseño anterior, 2026-09-01).

Existe un documento de diseño previo,
`docs/fase0-fusionar-trabajadores-nominas.md`, que diagnosticó las 4 vistas
actuales y activó explícitamente una "Stop Condition" del prompt original:
las 2 vistas de cada módulo tienen columnas/sub-navegación
**sustancialmente distintas**, no solo alcance (Trabajadores: la vista
global agrega columnas Cliente/Obra(s)/Residente(s) y pierde
Docs/Contrato/EPP/Reactivar/Eliminar; Nóminas: por-obra tiene un módulo
completo de captura de asistencia diaria que el lado global no tiene, y el
lado global tiene 2 generadores de reporte — semanal por cliente, SIROC —
que no existen por-obra). La recomendación del documento de diseño (no
unificar columnas, extraer el selector como helper reusable, ocultar en
vez de deshabilitar "Todas las obras" para roles sin acceso) **se verificó
contra el diff real y se implementó tal cual** — no hubo desviación
relevante entre diseño e implementación.

**Archivos y funciones tocadas:**
- `server/auth.js` — `'trabajadores_global'`/`'nominas_global'` retirados
  de `PERMISSIONS.admin.tabs`/`PERMISSIONS.desarrollador.tabs` (dejan de
  ser tabs navegables propios). Siguen existiendo como secciones de
  permiso independientes (`SECCIONES_PERMISOS`, `checkPermiso` en `GET
  /api/trabajadores`/`GET /api/nominas`) — sin cambios ahí.
- `public/app.js`:
  - `ROLE_TABS.admin`/`.desarrollador` pierden `'trabajadores_global'`/
    `'nominas_global'`; `SECTION_DEFS.administracion.tabs` idem.
  - `VISTAS_SIN_PROYECTO` gana `'trabajadores'`, `'nominas'` (mismo
    criterio que `'finanzas'` — el tab fusionado necesita poder entrar sin
    obra seleccionada, para mostrar la rama "Todas las obras").
  - `state` gana `trabajadoresVista: 'obra'`, `nominasVista: 'obra'`
    (mismo patrón que `finanzasVista`).
  - Helper nuevo reusable (extraído al llegar al 3er uso —
    Finanzas/Trabajadores/Nóminas): `vistaSelectorAttr()`,
    `renderVistaSelectorHtml(datasetKey, opciones, vistaActual, subnavId)`,
    `bindVistaSelector(view, datasetKey, getVistaActual, onCambiar)`.
    `renderFinanzas()` se refactoriza para usar este helper (antes tenía su
    propio bloque de botones inline).
  - `renderTrabajadoresFusion(view)`/`renderNominasFusion(view)` (nuevas,
    puntos de entrada reales de los tabs `trabajadores`/`nominas`): la rama
    "Todas las obras" solo es alcanzable con `isAdmin()` — si no,
    `state.<x>Vista` se fuerza a `'obra'` como salvaguarda (por ejemplo, si
    "Vista como" cambia el rol simulado a mitad de sesión). Cada rama
    invoca **sin cambios** a la función de render que ya existía
    (`renderTrabajadores`/`renderTrabajadoresGlobal`,
    `renderNominas`/`renderNominasGlobal`) — cero unificación de columnas,
    tal como recomendaba el documento de diseño. Si no hay
    `state.projectId` (entrando desde "Administración" sin obra elegida),
    se muestra un picker de obra inline (mismo patrón que
    `renderFinanzasVistaObra` para el mismo caso).
  - `renderView()`: las ramas `case 'trabajadores'`/`case 'nominas'` del
    switch viejo se eliminan (ahora interceptadas antes, en el bloque
    `if` que ya manejaba `'finanzas'`, porque necesitan funcionar sin
    `state.projectId`).
  - Botones de acceso directo del drawer de galería
    (`btnGalleryGoTrabajadoresGlobal`/`btnGalleryGoNominasGlobal`) ya no
    navegan a un tab propio — preseleccionan
    `state.trabajadoresVista = 'global'`/`state.nominasVista = 'global'` y
    navegan al tab fusionado.

**Fragmento relevante (public/app.js, punto de entrada nuevo):**
```js
async function renderTrabajadoresFusion(view) {
  const puedeGlobal = isAdmin();
  if (!puedeGlobal) state.trabajadoresVista = 'obra'; // salvaguarda: "Vista como" a mitad de sesión, etc.
  const opciones = [{ valor: 'obra', label: 'Esta obra' }];
  if (puedeGlobal) opciones.push({ valor: 'global', label: 'Todas las obras' });
  view.innerHTML = opciones.length > 1
    ? `${renderVistaSelectorHtml('trabajadoresVista', opciones, state.trabajadoresVista, 'trabajadoresVistaSubnav')}<div id="trabajadoresVistaBody" class="mt-12"></div>`
    : `<div id="trabajadoresVistaBody"></div>`;
  // ... bindVistaSelector(...) + picker de obra si !state.projectId ...
  const body = $('#trabajadoresVistaBody');
  if (state.trabajadoresVista === 'global' && puedeGlobal) { await renderTrabajadoresGlobal(body); return; }
  if (!state.projectId) { /* picker inline */ return; }
  await renderTrabajadores(body);
}
```

**Clasificación de aplicabilidad a la demo:** (b) portar adaptado — depende
de que la demo tenga las 4 vistas equivalentes
(`renderTrabajadores`/`renderTrabajadoresGlobal`/`renderNominas`/
`renderNominasGlobal`) y, idealmente, ya tenga el patrón `finanzasVista`
para reusar el mismo helper. Si la demo NO tiene el patrón de Finanzas
todavía, hay que decidir si vale la pena extraer el helper con solo 2 usos
(Trabajadores + Nóminas) en vez de 3 — el PR original justificó la
extracción precisamente por llegar al 3er uso.

**Dependencias:** ninguna con otros PRs de Nómina/Maquinaria de esta lista.
Si el módulo de Finanzas de este mismo changelog (otro archivo, "cambio de
diseño confirmado 2026-09-01") está documentado en otra sección del
changelog general, este PR depende conceptualmente de ese patrón — mismo
helper, mismo criterio de selector.

---

## PR #212 — fix/bypass-admin-ownership-maquinaria

**Fecha de merge:** 2026-09-04.

**Problema resuelto:** dos endpoints de Maquinaria (`POST
/api/maquinaria/estado-unidad` y `POST /api/maquinaria/consumibles`)
bloqueaban a **admin/desarrollador** con 403 al intentar capturar
estado-unidad o consumibles para un equipo que no tenía asignado como
"su" operador — a pesar de que admin/desarrollador normalmente bypasean
cualquier `checkPermiso` granular. Fix de permisos/seguridad puntual, no
una feature.

**Causa raíz:** ambos endpoints, después de pasar el gate de
`checkPermiso` (que sí bypasea para admin/desarrollador), tenían una
segunda comprobación de **ownership de equipo** codificada como
comparación directa: `if (equipo.operador_asignado_id !== req.user.id)
return 403`. Esa comparación no distinguía el rol — corría para
**cualquier** usuario, incluido admin/desarrollador, cuyo `id` real nunca
va a coincidir con el `operador_asignado_id` de un equipo ajeno. El bypass
de `checkPermiso` no alcanzaba a cubrir esta segunda capa de ownership,
porque vivía fuera de ese mecanismo.

**Archivos y funciones tocadas:**
- `server/app.js` — 2 líneas, una por endpoint (`POST
  /api/maquinaria/estado-unidad` y `POST /api/maquinaria/consumibles`).

**Fragmento relevante (antes/después, ambos endpoints, mismo cambio):**
```js
// antes
if (equipo.operador_asignado_id !== req.user.id) {
  return res.status(403).json({ error: 'No tienes permiso para realizar esta acción' });
}
// después
if (req.user.puesto === 'operador' && equipo.operador_asignado_id !== req.user.id) {
  return res.status(403).json({ error: 'No tienes permiso para realizar esta acción' });
}
```

**Clasificación de aplicabilidad a la demo:** (a) portar tal cual — es un
patrón de bug genérico y reconocible ("ownership check que no distingue
rol, bypasea al gate de permiso normal") que vale la pena auditar en la
demo aunque el código no sea copia exacta: buscar cualquier comparación
directa de `algo.operador_asignado_id !== req.user.id` (o equivalente de
ownership) que corra **después** de un `checkPermiso` que sí debería
bypasear para admin/desarrollador, y confirmar que esa segunda
comprobación también excluye esos roles (o, como aquí, se acota
explícitamente a `puesto === 'operador'`).

**Dependencias:** ninguna. Nota: este PR **no** agregó tests nuevos (el
`git diff --stat` solo muestra `server/app.js` + `public/sw.js` tocados) —
si se porta a la demo, vale la pena agregar un test de regresión que no
existía en el original.
