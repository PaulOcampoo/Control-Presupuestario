# Sugerencias y Notificaciones

> Módulo chico: 3 PRs, todos incrementales sobre el mismo feature base de
> "Sugerencias" (un buzón de sugerencias de usuarios con panel admin).

## Contexto: el feature base de Sugerencias es preexistente, NO parte de esta ventana

Antes de entrar a los 3 PRs: el módulo Sugerencias en sí (tabla `sugerencias`,
`GET/POST /api/sugerencias`, panel admin con `PATCH /api/sugerencias/:id` para
cambiar estado, generación de "prompt IA", `sugerencia_imagenes`, etc.) **ya
existía desde antes** de la ventana de 20 días que cubre este changelog.
Confirmado con `git log`: el commit `d01825f` ("feat: galería global +
mejoras UI + fix eliminar presupuesto", SW v61) del **2026-07-08** ya
introduce el módulo completo — casi 2 meses antes del primer PR de esta
sección (2026-08-28).

**Implicación para la demo**: si App-CP-Demo no tiene ya un módulo de
Sugerencias equivalente, los 3 PRs de abajo NO son suficientes por sí solos
— son parches sobre una base (tabla `sugerencias`, endpoints CRUD, vista
`renderSugerencias()`, badges `.badge-estado-*`, selector custom
`enhanceSelect()`) que este changelog no cubre. Verificar primero si ese
feature base ya existe en la demo antes de intentar portar estos 3 PRs.

---

## PR #191 — feat(sugerencias): notificación a admin/desarrollador al enviar una sugerencia

**Fecha**: 2026-08-28 (merge commit `47601f856df016ae079d7aa24d6b93ece136e429`)

### Qué problema resolvía

Cuando un usuario enviaba una sugerencia (`POST /api/sugerencias`), nadie del
equipo (admin/desarrollador) se enteraba salvo que entrara manualmente a
revisar la lista. No había ninguna señal proactiva.

### Diseño

Reusa el mecanismo genérico de notificaciones ya existente en la app (tabla
`notificaciones` + `crearNotificacion()` en `server/notificaciones.js`) en
vez de construir un sistema paralelo — mismo patrón que el resto de tipos de
notificación de la app (`estimacion_rechazada`, `contrato_por_vencer`, etc.).
Se agregan 3 piezas:

1. **Notificación al crear sugerencia**: nuevo tipo `sugerencia_nueva`,
   notifica a todos los usuarios con `puesto IN ('admin','desarrollador')`
   (consulta directa a `usuarios`, no un rol simulado), con el nombre del
   autor + extracto de 80 caracteres del texto. Click navega a Sugerencias y
   resalta (`scrollAndFlash`) la tarjeta específica vía `data-sug-id`
   (best-effort, reintenta hasta 15 veces cada 150ms mientras el panel admin
   termina de pintarse — `renderSugerencias()` es async y `switchToView()`
   no espera su promesa).
2. **Badge de pendientes en el sidebar** (solo admin/desarrollador): extiende
   la respuesta de `GET /api/notificaciones` (mismo polling de 60s de la
   campana del topbar, sin round-trip HTTP paralelo) con un campo
   `sugerencias_pendientes` — con **early-exit en el backend** para
   cualquier otro puesto (la query ni se ejecuta). Se oculta en 0, muestra
   "9+" arriba de 9. Reusa colores/forma de `.notif-badge` pero en flujo
   normal (no `absolute`) porque `.sbar-item` es una fila flex horizontal.
3. **Fix de bug preexistente, no relacionado al feature**:
   `VISTAS_SIN_PROYECTO` (lista de vistas globales que no exigen selección de
   obra) no incluía `'sugerencias'` — confirmado con `git blame` como bug
   preexistente desde antes de este branch (Sugerencias es un catálogo
   global sin obra asociada desde su creación en `d01825f`, pero la lista no
   se había actualizado). `switchToView()` forzaba selección de obra para
   entrar a Sugerencias, lo cual chocaba con el propio `navigateFromNotif()`
   de este PR (que ya trataba a Sugerencias como sin-obra). Se agregó
   `'sugerencias'` a la whitelist.
4. **Fix de colisión de `SW_VERSION` tras rebase**: al rebasear esta rama
   sobre `origin/main`, el conflicto en `sw.js` se había resuelto quedándose
   con `v381` — que coincidía byte-a-byte con el `sw.js` que otro PR sin
   relación ya había introducido. Un navegador que hubiera visitado la app
   con esa otra rama no detectaba actualización (diff de bytes idéntico) y
   seguía sirviendo el `app.js` viejo cache-first. Bumpeado a `v383` (mayor a
   *todo* `git log --all` de `public/sw.js`, no solo a los dos valores en
   conflicto — ver nota de memoria del proyecto sobre este mismo patrón de
   riesgo).

### Archivos y funciones tocadas

- `server/app.js`:
  - `GET /api/notificaciones` (~línea 840): agrega `sugerencias_pendientes`
    al payload, con early-exit por puesto.
  - `POST /api/sugerencias` (~línea 12130): dispara `crearNotificacion()`
    hacia cada admin/desarrollador activo tras insertar la sugerencia.
- `server/notificaciones.js`: registra `sugerencia_nueva` en
  `CATEGORIAS_NOTIFICACION` (categoría "Otras") y en `ROLES_POR_TIPO` →
  `['admin', 'desarrollador']`.
- `public/app.js`:
  - `state.sugerenciasPendientes` (nuevo campo de estado).
  - `refreshNotificaciones()`: lee `data.sugerencias_pendientes` y llama
    `renderSugerenciasBadge()`.
  - `renderSugerenciasBadge()` (nueva función): pinta/oculta el badge
    `#sbarSugerenciasBadge`, gateado por `isAdminRealSinSimular()`.
  - `renderSidebar()`: agrega el `<span id="sbarSugerenciasBadge">` junto al
    ítem "Sugerencias" y llama `renderSugerenciasBadge()` al final (el
    sidebar se reconstruye completo en cada render, a diferencia de la
    campana que vive en DOM fijo).
  - `navigateFromNotif()`: nuevo branch para `notif.tipo === 'sugerencia_nueva'`
    (gateado por `isAdmin()`) que navega a `'sugerencias'` y llama
    `resaltarTarjetaSugerencia()`.
  - `resaltarTarjetaSugerencia(sugId, intentos = 15)` (nueva función):
    reintento con `setTimeout` de 150ms buscando `[data-sug-id="${sugId}"]`.
  - `VISTAS_SIN_PROYECTO`: se agrega `'sugerencias'`.
- `public/styles.css`: nueva clase `.sbar-badge-count` (mismo look que
  `.notif-badge` pero `display:flex` no-`absolute`) + regla de ocultamiento
  en `#sidebar.collapsed`.
- `public/sw.js`: `SW_VERSION` `v381` → `v383`.
- `tests/notificacion-sugerencias.test.js`: 5 casos nuevos (notificación
  creada con datos correctos, no-admin no la recibe, marcar como leída,
  `sugerencias_pendientes` presente solo para admin/desarrollador y refleja
  el conteo real al cambiar `estado`).

### Fragmento de código relevante

Backend, notificación al crear sugerencia (`server/app.js`):

```js
// antes: solo insertaba la sugerencia y respondía 201
// después:
const extracto = texto.trim().length > 80 ? `${texto.trim().slice(0, 80)}…` : texto.trim();
const { rows: destinatarios } = await db.pool.query(
  "SELECT id FROM usuarios WHERE puesto IN ('admin', 'desarrollador') AND activo = true"
);
await Promise.all(destinatarios.map((d) => crearNotificacion(
  d.id, null, 'sugerencia_nueva', rows[0].id, `${req.user.nombre} envió una sugerencia: "${extracto}"`
)));
```

Badge con early-exit backend (`server/app.js`):

```js
const payload = { notificaciones: rows, no_leidas: countRows[0].n };
if (req.user.puesto === 'admin' || req.user.puesto === 'desarrollador') {
  const { rows: sugRows } = await db.pool.query(
    "SELECT COUNT(*)::int AS n FROM sugerencias WHERE estado = 'pendiente'"
  );
  payload.sugerencias_pendientes = sugRows[0].n;
}
res.json(payload);
```

### Clasificación de aplicabilidad a la demo

**(b) Portar adaptado** — condicionado a que exista el feature base de
Sugerencias en la demo (ver sección de contexto arriba). Si existe:
- La notificación + badge son portables tal cual, siempre que la demo tenga
  el mismo mecanismo genérico `notificaciones` / `crearNotificacion()`.
- Los 2 fixes incluidos (VISTAS_SIN_PROYECTO, colisión SW_VERSION) son
  específicos de este repo/historial — no aplican a la demo salvo que la
  demo tenga el mismo bug de `VISTAS_SIN_PROYECTO` sin `'sugerencias'` (fácil
  de verificar: revisar esa constante en el `app.js` de la demo).
- Nombres reales anonimizados en este documento donde aplicaba (el PR real no
  contenía nombres de cliente/proveedor, solo roles internos).

### Dependencias

Ninguna con otros PRs de este changelog. Depende del feature base
preexistente de Sugerencias (no cubierto en esta ventana de 20 días, ver
sección de contexto) y del mecanismo genérico de notificaciones
(`server/notificaciones.js`, también preexistente).

---

## PR #196 — feat(sugerencias): colores por estado en selector admin

**Fecha**: 2026-08-29 (merge commit `5ae99d75ea1eb105a21e288962fc170765e3c88d`)

### Qué problema resolvía

El selector de estado (pendiente/revisada/implementada/descartada) en el
panel admin de Sugerencias era un `<select>` custom (`enhanceSelect()`) sin
color — para saber el estado de una sugerencia había que leer el texto,
no bastaba un vistazo rápido.

### Diseño

Colorea el selector custom tanto cerrado (trigger) como en el dropdown
abierto, reusando el mapeo semántico ya establecido en la app por
`.badge-estado-*`: revisada=azul, implementada=verde. Ajuste de producto
confirmado durante el PR (feedback humano sobre la propuesta original):
**pendiente=rojo** (urge atención, no dorado/warning genérico) y
**descartada=neutro del tema** (`--text-secondary`, sin color de acento
propio) — deliberadamente distinto del resto.

Mecanismo técnico: el listbox del `<select>` custom vive "portado" a
`document.body` (fuera del árbol DOM normal, para z-index/posicionamiento),
por lo que no hay un ancestro CSS real del que colgar reglas de scoping.
Solución: dos hooks genéricos e inertes agregados a `enhanceSelect()` (código
compartido por TODOS los selects custom de la app, no solo Sugerencias):
- `item.dataset.value` en cada opción del listbox.
- `list.dataset.selectClass = select.className` — espeja las clases del
  `<select>` real como atributo `data-select-class` en el listbox portado.
- `wrap.dataset.value = select.value` en `syncLabel()` — refleja el value
  actual en el wrapper visible (no portado).

Esto permite que CSS scoped a `.sug-estado-select` (una clase puesta
directamente en el `<select class="input sug-estado-select">` original en
`renderSugerencias()`, ver `public/app.js` línea ~9497) coloree solo ESE
selector, sin tocar ningún otro `<select>` custom de la app — sin necesidad
de JS específico de Sugerencias en `enhanceSelect()`.

También se elimina `SUGERENCIA_ESTADO_COLORS`, una constante muerta de un
intento anterior abandonado de esta misma función (nunca se usaba).

### Bugs encontrados y corregidos durante la verificación

Verificados con `getComputedStyle` real contra el CSS servido en vivo
(headless Edge vía `playwright-core`), no a ojo:

1. **Chevron de "descartada"** se quedaba con el color dorado genérico del
   componente aunque borde/texto del trigger ya estaban correctamente
   neutros — inconsistente con el diseño "sin color propio". Fix: override
   explícito de `.custom-select-chevron` a `--text-secondary` para ese
   estado.
2. **Opción resaltada de "descartada" en el dropdown**: el fondo del hover/
   highlight caía al genérico `.custom-select-option.highlighted` (dorado)
   mientras el texto en reposo (`--text-secondary`, con mayor especificidad
   CSS) ganaba esa propiedad por separado — contraste medido ~1.1:1,
   prácticamente ilegible. Fix: reglas de highlight/hover propias para las 4
   opciones (no solo 3), con fondo tintado vía `color-mix()` coordinado con
   el color de texto de cada estado. Contraste post-fix ~4.53:1 (cumple AA).

### Archivos y funciones tocadas

- `public/app.js`:
  - `enhanceSelect()`: agrega `list.dataset.selectClass`, `item.dataset.value`,
    `wrap.dataset.value` (en `syncLabel()`).
  - Elimina la constante muerta `SUGERENCIA_ESTADO_COLORS`.
- `public/styles.css`: ~55 líneas nuevas de reglas `[data-value="..."]` /
  `[data-select-class~="sug-estado-select"]` para trigger, chevron, opciones
  en reposo, `.highlighted` y `:hover` (dentro de `@media (hover: hover) and
  (pointer: fine)`) — 4 estados × varios selectores.
- `public/sw.js`: `SW_VERSION` `v386` → `v387`.

### Fragmento de código relevante

Hook genérico en `enhanceSelect()` (`public/app.js`):

```js
// antes: list.className = 'custom-select-list'; (sin más)
// después:
list.dataset.selectClass = select.className;
// ...
item.dataset.value = opt.value;
// ...
function syncLabel() {
  const sel = options()[select.selectedIndex];
  label.textContent = sel ? sel.textContent : '';
  wrap.dataset.value = select.value;
}
```

CSS scoped resultante (`public/styles.css`):

```css
.custom-select.sug-estado-select[data-value="pendiente"] .custom-select-trigger {
  border-color: var(--red); color: var(--red);
  background: color-mix(in srgb, var(--red) 12%, var(--bg-surface));
}
.custom-select.sug-estado-select[data-value="descartada"] .custom-select-trigger {
  color: var(--text-secondary); /* SIN color-mix ni border propio: neutro deliberado */
}
```

### Clasificación de aplicabilidad a la demo

**(b) Portar adaptado** — el mecanismo (`dataset.selectClass`/`dataset.value`
en `enhanceSelect()`) es genérico y reutilizable tal cual si la demo tiene el
mismo componente de `<select>` custom. Las reglas CSS específicas de color
son portables tal cual siempre que la demo use las mismas variables de tema
(`--red`, `--accent-blue`, `--accent-green`, `--text-secondary`,
`--bg-surface`) — si la demo tiene una paleta de colores distinta, adaptar
los nombres de variable. Requiere que el feature base de Sugerencias (con su
selector de estado) ya exista en la demo.

### Dependencias

Depende del feature base preexistente de Sugerencias (el `<select
class="sug-estado-select">` que se colorea) y de `enhanceSelect()` (utilidad
genérica de la app, preexistente, no específica de Sugerencias). No depende
de PR #191. PR #197 no toca este mecanismo de colores.

---

## PR #197 — feat(sugerencias): responder con mensaje + notificación de agradecimiento

**Fecha**: 2026-08-29 → merge 2026-08-30 (según `mergedAt` de GitHub;
commit de merge `444dbb7252deea2613b690d61bbd4d6a78c2b70c`)

### Qué problema resolvía

Cuando el equipo marcaba una sugerencia como "descartada" o hacía cualquier
cambio de estado, el autor original no se enteraba del motivo ni recibía
ningún cierre — especialmente problemático para sugerencias confusas,
erróneas, o no implementables, donde un simple cambio de estado sin
explicación deja al usuario sin saber qué pasó.

### Diseño

Dos piezas independientes pero relacionadas:

1. **Responder con mensaje libre**: nueva tabla `sugerencias_respuestas`
   (`sugerencia_id`, `autor_usuario_id`, `mensaje`, `creado_en`) +
   `POST /api/sugerencias/:id/responder` + `GET /api/sugerencias/:id/respuestas`.
   El mensaje llega como notificación (`sugerencia_respuesta`) al autor
   original de la sugerencia.
2. **Agradecimiento automático**: al cambiar el estado a `implementada` o
   `descartada` (dentro del `PATCH /api/sugerencias/:id` ya existente), se
   dispara automáticamente una notificación `sugerencia_resuelta` con texto
   distinto según el caso — **coexiste** con cualquier respuesta manual, no
   la reemplaza.

**Gate de permisos — el detalle más importante de este PR**: responder no es
para "todo admin". Es exclusivo de `puesto === 'desarrollador'` **+ una
cuenta específica identificada por id** (en el código real, un id de usuario
concreto con rol `admin` — anonimizado aquí, ver nota abajo). Esto es una
decisión de negocio explícita: la persona quiere revisar personalmente cómo
se responde a los usuarios, sin delegarlo a cualquier admin.

Implementación en `server/auth.js`:
```js
const USUARIO_RESPONDER_SUGERENCIAS_ADMIN = <ID_HARDCODEADO>; // cuenta específica
function puedeResponderSugerencias(user) {
  return user.puesto === 'desarrollador' || user.id === USUARIO_RESPONDER_SUGERENCIAS_ADMIN;
}
function requireResponderSugerencias(req, res, next) {
  if (!puedeResponderSugerencias(req.user)) {
    logDenied(req, 'sin acceso a responder Sugerencias (whitelist)');
    return res.status(403).json({ error: 'No tienes permiso para realizar esta acción' });
  }
  next();
}
```
Mismo patrón ya usado en el repo para otras whitelists puntuales
(`USUARIOS_CONTROL_CUENTAS`, `USUARIOS_CONTROL_FINANCIERO`,
`USUARIOS_ESTADO_RESULTADOS` en `server/auth.js`) — id confirmado con un
`SELECT` real contra la base de producción antes de hardcodearlo, nunca por
nombre/username a ciegas.

**Hallazgo documentado durante el PR real** (relevante como patrón, no como
dato a portar): existía una segunda cuenta con username casi idéntico a la
cuenta correcta (un solo carácter de diferencia) perteneciente a una persona
totalmente distinta con otro rol — el PR dejó un comentario explícito en
`server/auth.js` para que nadie confunda las dos cuentas en el futuro. Nota
para la demo: si se porta este patrón de whitelist-por-id, usar IDs/usuarios
ficticios propios de la demo, nunca reutilizar el id real de producción.

**Frontend**: el booleano `puede_responder_sugerencias` se calcula 100% en
backend (`auth.puedeResponderSugerencias(user)`) y se expone en el objeto de
sesión (`issueFullSession()` y `GET /api/auth/me`) — el frontend NO duplica
el id hardcodeado, es puro gate de cortesía de UI (mismo patrón ya usado por
Control de Cuentas/Contabilidad en este repo). Botón "Responder" abre un
modal con `<textarea>` (sin `prompt()`/`confirm()` nativos, siguiendo el
mismo molde que otros modales de cambio de estado de la app). El hilo de
respuestas se muestra debajo del texto tanto en la tarjeta del autor ("mía")
como en la tarjeta del panel admin.

### Archivos y funciones específicas tocadas

- `server/db.js`: nueva tabla `sugerencias_respuestas` (CREATE TABLE +
  índice `idx_sug_respuestas`) dentro del bloque `SCHEMA`.
- `server/auth.js`: `USUARIO_RESPONDER_SUGERENCIAS_ADMIN`,
  `puedeResponderSugerencias(user)`, `requireResponderSugerencias(req,res,next)`
  — exportadas en `module.exports`.
- `server/notificaciones.js`: registra `sugerencia_respuesta` y
  `sugerencia_resuelta` en `CATEGORIAS_NOTIFICACION` y en `ROLES_POR_TIPO`
  → lista explícita de TODOS los puestos no-superusuario (`residente`,
  `cabo`, `compras`, `tesoreria`, `administracion`, `logistica`,
  `jefe_maquinaria`, `operador`, `costos`) porque el destinatario es "quien
  sea que mandó la sugerencia", no un rol fijo.
- `server/app.js`:
  - `issueFullSession()` y `GET /api/auth/me`: agregan
    `puede_responder_sugerencias: auth.puedeResponderSugerencias(user)` al
    objeto `user` de la respuesta.
  - `PATCH /api/sugerencias/:id` (ya existente): agrega el disparo de
    `sugerencia_resuelta` cuando `estado` es `implementada`/`descartada`.
  - `POST /api/sugerencias/:id/responder` (nuevo, gateado por
    `auth.requireResponderSugerencias`): valida mensaje no vacío y ≤2000
    caracteres, inserta en `sugerencias_respuestas`, notifica al autor.
  - `GET /api/sugerencias/:id/respuestas` (nuevo): visible para
    admin/desarrollador o para el autor original únicamente (403 para
    cualquier otro).
- `public/app.js`:
  - `puedeResponderSugerencias()` (frontend, nombre igual a la función
    backend pero sin argumentos): lee `state.user.puede_responder_sugerencias`.
  - `navigateFromNotif()`: nuevo branch para `sugerencia_respuesta` /
    `sugerencia_resuelta` — a diferencia de `sugerencia_nueva` (gateado por
    `isAdmin()`), este NO tiene gate de rol (cualquier puesto puede ser
    autor).
  - `renderSugerencias()`: agrega `idsConHilo`, fetch en paralelo de
    `/sugerencias/:id/respuestas` por cada sugerencia visible, función
    `hiloHtml(sugId)`, botón `.sug-responder-btn` (visible solo si
    `puedeResponderSugerencias()`), `data-sug-id` agregado también a la
    tarjeta "mía" (antes solo la admin lo tenía, necesario para que
    `resaltarTarjetaSugerencia()` de PR #191 funcione también en notifs de
    respuesta).
  - `openResponderSugerenciaModal(sugId, onDone)` (nueva función): modal con
    textarea, POST, re-pinta la vista al terminar.
- `public/styles.css`: `.sug-responder-btn`, `.sug-hilo`, `.sug-respuesta`,
  `.sug-respuesta-meta`, `.sug-respuesta-autor`, `.sug-respuesta-texto`.
- `public/sw.js`: `SW_VERSION` `v387` → `v388`.
- `tests/responder-sugerencias-notificacion.test.js`: 11 casos nuevos — 403
  para admin real que no es la cuenta whitelisted y para el propio autor de
  la sugerencia; 200 para desarrollador y para la cuenta específica
  (tokens firmados directamente para ids conocidos, sin passwords, mismo
  patrón que `tests/contabilidad.test.js`); orden del hilo; texto correcto
  de la notificación automática en `implementada` vs `descartada`; ausencia
  de notificación en `pendiente`/`revisada`; coexistencia de notificación
  manual + automática.

### Fragmento de código relevante

Agradecimiento automático dentro del PATCH existente (`server/app.js`):

```js
if (estado === 'implementada' || estado === 'descartada') {
  const mensajeResuelta = estado === 'implementada'
    ? '¡Gracias por tu sugerencia! Ya fue implementada.'
    : 'Gracias por tu sugerencia. Esta vez no fue posible implementarla.';
  await crearNotificacion(rows[0].usuario_id, null, 'sugerencia_resuelta', id, mensajeResuelta);
}
```

Endpoint de responder (`server/app.js`):

```js
app.post('/api/sugerencias/:id/responder', auth.requireResponderSugerencias, h(async (req, res) => {
  const id = Number(req.params.id);
  const { mensaje } = req.body || {};
  if (!mensaje?.trim()) return res.status(400).json({ error: 'El mensaje es requerido' });
  if (mensaje.trim().length > 2000) return res.status(400).json({ error: 'El mensaje no puede superar los 2 000 caracteres' });
  const { rows: sugRows } = await db.pool.query('SELECT usuario_id FROM sugerencias WHERE id = $1', [id]);
  if (!sugRows[0]) return res.status(404).json({ error: 'Sugerencia no encontrada' });
  const { rows } = await db.pool.query(
    `INSERT INTO sugerencias_respuestas (sugerencia_id, autor_usuario_id, mensaje) VALUES ($1, $2, $3) RETURNING *`,
    [id, req.user.id, mensaje.trim()]
  );
  // ... notifica al autor con crearNotificacion(...)
  res.status(201).json(rows[0]);
}));
```

### Clasificación de aplicabilidad a la demo

**(b) Portar adaptado, con una decisión explícita a tomar**:
- El mecanismo general (tabla de respuestas, endpoints, notificación
  automática de resolución, modal de UI) es portable casi tal cual si la
  demo tiene el feature base de Sugerencias.
- **El gate de whitelist-por-id NO debe portarse con datos reales.** Para la
  demo, decidir explícitamente uno de dos caminos: (a) simplificar el gate a
  `puesto === 'desarrollador'` sin caso especial de admin (más simple, sin
  necesidad de inventar un id ficticio), o (b) si se quiere preservar el
  patrón "un admin específico también puede", usar un id de usuario ficticio
  propio del seed de datos de la demo, nunca el id real de producción (el
  mismo que se anonimizó arriba como `<ID_HARDCODEADO>`).
- Los datos ficticios de negocio (nombres de usuario en comentarios/tests)
  deben regenerarse con placeholders genéricos si se copian tests.

### Dependencias

- Depende del feature base preexistente de Sugerencias.
- Depende de PR #191 en un punto concreto: agrega `data-sug-id` a la
  tarjeta "mía" (`tarjetaMia()`), que antes solo lo tenía la tarjeta admin —
  sin esto, `resaltarTarjetaSugerencia()` (introducida en #191) no
  funcionaría para notificaciones de respuesta/resolución dirigidas al
  autor. Si se porta #197 sin #191, hay que agregar ese `data-sug-id` a la
  tarjeta del autor de todos modos, o el deep-link de resaltado quedará
  incompleto.
- No depende de PR #196 (colores de estado) — son cambios ortogonales sobre
  la misma vista, sin overlap de código.
