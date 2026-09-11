# Auditoría de animaciones — App-CP

Auditoría de solo lectura del frontend de App-CP (PWA mobile-first, vanilla JS/CSS)
usando la skill `improve-animations`, con apoyo de `animation-vocabulary` (nomenclatura)
y `apple-design` (criterios de motion físico/gestual). No se modificó ningún archivo
de código fuente.

## 0. Archivos escaneados

**Frontend activo** (servido por Vercel desde `public/` — confirmado por la
ausencia de `express.static` en `server/index.js` y la convención de Vercel):

| Archivo | Líneas | Cobertura |
| --- | --- | --- |
| `public/index.html` | 256 | Completa |
| `public/styles.css` | 1636 | Completa (archivo entero leído línea por línea) |
| `public/app.js` | 7272 | Dirigida: mapa completo de las 60+ secciones (`// ===`), lectura completa de toda la lógica de UI compartida (toast, modal, drawer, sidebar, popovers, quick-action menu, notificaciones, banners de TOTP/instalación, tooltip "próximamente", calendario de asistencia, firma digital EPP, inicialización de gráficas Chart.js) vía grep dirigido (`transition`, `classList.*show`, `setTimeout`, `requestAnimationFrame`, `matchMedia`, `new Chart`, `touchstart`/`pointerdown`, `@keyframes`) + lectura de los rangos de línea relevantes |
| `public/theme-init.js` | 5 | Completa — sin animación, solo aplica el tema antes del primer paint |

**Fuera de alcance** (no relevantes a motion de UI, o terceros):
- `public/vendor/chart.umd.min.js` — librería de terceros minificada; solo se auditó **cómo se invoca** desde `app.js`, no su código interno.
- `public/vendor/vercel-blob-client.js` — cliente de subida de archivos, sin superficie de animación.
- `public/sw.js` — service worker, sin superficie de animación de UI.

**Nota de estructura (condición de parada activada, se reporta sin resolver):**
existe un directorio `control-presupuestal-app/` en la raíz del repo con una copia
de `app.js` (809 líneas) y `styles.css` (239 líneas) — sensiblemente más pequeña y
antigua que la app activa en `public/`. Parece un artefacto de una extracción de zip
anterior (`control-presupuestal-app.zip` está en la raíz). No se auditó porque no es
la app servida en producción, pero se señala por transparencia.

---

## 1. Resumen ejecutivo

**10 hallazgos** en total (0 en Propósito y frecuencia — ver nota).

| Prioridad | Cantidad |
| --- | --- |
| Alta | 3 |
| Media | 3 |
| Baja | 4 |

| Categoría (AUDIT.md) | Cantidad | Hallazgos |
| --- | --- | --- |
| 1. Propósito y frecuencia | 0 | — (ver nota abajo) |
| 2. Easing y duración | 1 | G1 |
| 3. Fisicalidad y origen | 2 | G9, G10 |
| 4. Interrumpibilidad | 1 | G4 |
| 5. Performance | 2 | G6, G8 |
| 6. Accesibilidad | 2 | G2, G3 |
| 7. Cohesión y tokens | (incluido en G1) | — |
| 8. Oportunidades perdidas | 2 | G5, G7 |

**Nota sobre Categoría 1 (Propósito y frecuencia):** no se encontró ninguna
animación en acciones de alta frecuencia (100+/día) ni atajos de teclado — la app
no tiene command palette ni shortcuts, y las listas de consulta (requisiciones,
insumos, órdenes de compra) se pintan sin motion decorativo, que es lo correcto
para elementos vistos decenas de veces al día. Este es un resultado válido de la
auditoría, no una omisión.

---

## 2. Hallazgos por módulo

### Global / Transversal (componentes compartidos en `styles.css`)

#### G1 — [ALTA] Cohesión — Tres sistemas de easing paralelos, sin tokens compartidos
- **Archivo:** `public/styles.css`
- **Selectores/líneas:** `:root` (12–37, sin ningún token `--ease-*`); ejemplos de cada sistema:
  - *Easing implícito (bare `ease`)*: `.toast` (394), `.modal` (365), `.notif-dropdown` (108), `.overlay` (325), `.user-popover` (944), `.tab` (153), `.section-card` (180), `.cliente-card` (592), `.project-item` (341), `.quick-action-item` (1022), `.theme-opt` (955), `.mobile-nav-item` (979), `.search-bar-fancy input` (461)
  - *`cubic-bezier(.4,0,.2,1)` (equivalente a Tailwind `ease-in-out`)*: `#sidebar` (760), `.sbar-chevron` (846), `.sbar-group-body` (854), `.quick-action-sheet` (1009)
  - *`linear`*: `.spinner`/`@keyframes spin` (408, 410), `.spin`/`@keyframes spin-once` (443–444) — correcto para spinners, no es el problema
- **Problema actual:** no existe ningún token de easing en `:root`. Cada componente
  declara su propia curva (o ninguna, cayendo al `ease` por defecto del navegador,
  que AUDIT.md señala como "demasiado débil para motion deliberado"). El resultado
  es que drawer, modal, popovers y sidebar — todos "paneles que entran y salen de
  pantalla" conceptualmente — se sienten con timing distinto sin ninguna razón de
  producto.
- **Cambio propuesto:** agregar a `:root` (junto a los demás tokens, después de
  línea 36):
  ```css
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
  ```
  Migrar las transiciones de entrada/salida (toast, modal, notif-dropdown, overlay,
  user-popover, drawer, quick-action-sheet) a `var(--ease-out)`; dejar
  `cubic-bezier(.4,0,.2,1)` del sidebar como está (es una curva "ease-in-out"
  razonable para un panel que se mueve en pantalla, no que entra/sale) o migrarla a
  `var(--ease-in-out)` para unificar el token.
- **Apple-design:** §7 Spatial consistency — "mirror the easing on reversible
  transitions" requiere primero tener una curva consistente que espejar.

#### G2 — [ALTA] Accesibilidad — `:hover` sin gating táctil (sticky hover en móvil)
- **Archivo:** `public/styles.css`
- **Selectores/líneas (representativos, no exhaustivo):** `.tab:hover` (155),
  `.section-card:hover` (182), `.cliente-card:hover` (594),
  `.welcome-project-card:hover` (630), `.bienvenida-proj-card:hover` (659),
  `.proyecto-resumen-card:hover` (1292), `.project-item:hover` (343),
  `.sidebar-project-btn:hover` (795), `.sbar-item:hover` (817),
  `.sbar-group-header:hover` (842), `.sidebar-profile-btn:hover` (917),
  `.theme-opt:hover` (957), `.mobile-nav-item:hover` (982),
  `.quick-action-item:hover` (1024), `.search-result-item:hover` (491),
  `.notif-item:hover` (128), `.asist-td-trab:hover` (1218)
- **Problema actual:** ninguna regla `:hover` de la hoja está protegida por
  `@media (hover: hover) and (pointer: fine)`. En una PWA **mobile-first**, esto
  provoca "sticky hover": al tocar una tarjeta/tab/ítem en un dispositivo táctil,
  el navegador aplica el estilo `:hover` y lo deja pegado hasta el siguiente toque
  en otro elemento — se ve como un highlight fantasma que no corresponde a ninguna
  interacción real del usuario.
- **Cambio propuesto:** envolver el bloque completo de reglas `:hover` (o al menos
  las de mayor superficie táctil: tarjetas, tabs, items de sidebar/lista) en:
  ```css
  @media (hover: hover) and (pointer: fine) {
    .tab:hover { ... }
    .section-card:hover { ... }
    /* etc. */
  }
  ```
  Dado el número de selectores afectados, este hallazgo es de alto impacto pero
  conviene implementarlo en su propio commit dedicado (no como parte de un
  "quick win" de una sola línea).
- **Apple-design:** §14 Reduced motion & accessibility — gating de hover es la
  misma familia de correctitud táctil que `prefers-reduced-motion`.

#### G3 — [ALTA] Accesibilidad — `prefers-reduced-motion` con cobertura muy parcial
- **Archivo:** `public/styles.css`
- **Selector/línea:** el único bloque existe en 1144–1148 y cubre solo
  `#sidebar, .sbar-group-body, .quick-action-sheet, .quick-action-menu, .user-popover`.
- **Problema actual:** quedan sin cubrir: `.modal` (362–367), `.toast` (389–397),
  `.notif-dropdown` (104–119), `.drawer` (328–334), `.overlay` (323–327),
  las tarjetas con `hover { transform: translateY(-2px) }` (`.welcome-project-card`
  633, `.bienvenida-proj-card` 662, `.proyecto-resumen-card` 1295),
  `@keyframes notifTargetFlash` (479–483, pulso de 1.8s con `box-shadow`),
  `@keyframes fadeSlideIn` (485–486), `#proximamenteTooltip` (1150–1173, incluye
  `translateY(20px)`), `.gantt-bar-inner` (423–427, transición de `width`) y
  `.collapse-body` (696–697, transición de `max-height`). Un usuario con
  `prefers-reduced-motion: reduce` sigue recibiendo casi todo el movimiento de la
  app.
- **Cambio propuesto:** ampliar el bloque de 1144 para incluir el resto de
  transiciones de movimiento (mantener opacidad/color, quitar `transform`):
  ```css
  @media (prefers-reduced-motion: reduce) {
    #sidebar, .sbar-group-body, .quick-action-sheet, .quick-action-menu,
    .user-popover, .modal, .toast, .notif-dropdown, .drawer, .overlay,
    #proximamenteTooltip, .gantt-bar-inner, .collapse-body {
      transition: none;
    }
    .welcome-project-card:hover, .bienvenida-proj-card:hover,
    .proyecto-resumen-card:hover { transform: none; }
    .notif-target-flash, .search-results-fancy { animation: none; }
  }
  ```
  (mantener el fundido de opacidad de `.modal`/`.toast` si se prefiere una
  transición mínima en vez de `none` total — AUDIT.md permite "gentler, not zero").
- **Apple-design:** §14 — reduced motion significa reemplazar slides/springs por
  cross-fades cortos, no eliminar todo el feedback.

### Sidebar / Navegación móvil

#### G4 — [MEDIA] Interrumpibilidad/Timing — el quick-action-sheet se corta antes de terminar su salida
- **Archivos:** `public/app.js:1046-1050` + `public/styles.css:1004-1011`
- **Selector/función:** `closeQuickActionMenu()` / `.quick-action-sheet`
- **Problema actual:**
  ```js
  // app.js:1046-1050
  function closeQuickActionMenu() {
    const menu = $('#quickActionMenu'); if (!menu) return;
    menu.classList.remove('show');
    setTimeout(() => { if (!menu.classList.contains('show')) menu.style.display = 'none'; }, 220);
  }
  ```
  ```css
  /* styles.css:1004-1011 */
  .quick-action-sheet {
    transform: translateY(20px); transition: transform 0.25s cubic-bezier(.4,0,.2,1);
  }
  .quick-action-menu.show .quick-action-sheet { transform: translateY(0); }
  ```
  El `setTimeout` pone `display: none` a los **220ms**, pero la hoja
  (`.quick-action-sheet`) transiciona su `transform` durante **250ms**. Los
  últimos 30ms del deslizamiento hacia abajo se cortan de golpe (el elemento sale
  del flujo de render antes de terminar), lo que se percibe como un salto/parpadeo
  justo al cerrar el menú de acciones rápidas — visible en cada uso del FAB móvil,
  una acción de frecuencia media-alta.
- **Cambio propuesto:** igualar el timeout a 250ms, o mejor, eliminar el número
  mágico duplicado escuchando el fin real de la transición:
  ```js
  function closeQuickActionMenu() {
    const menu = $('#quickActionMenu'); if (!menu) return;
    menu.classList.remove('show');
    setTimeout(() => { if (!menu.classList.contains('show')) menu.style.display = 'none'; }, 250);
  }
  ```
- **Apple-design:** §3 Interruptibility — el input no debe verse cortado antes de
  que la animación termine su curva.

#### G6 — [BAJA] Performance — `will-change` permanente en el sidebar
- **Archivo:** `public/styles.css:761`
- **Selector:** `#sidebar { ... will-change: transform, width; }`
- **Problema actual:** el hint `will-change` está declarado de forma estática y
  permanente en la regla base del sidebar, no solo mientras se anima. Esto
  mantiene la capa promovida a su propio layer de composición en todo momento,
  incluso cuando el sidebar está completamente quieto (la mayor parte del tiempo),
  gastando memoria de GPU sin necesidad.
- **Cambio propuesto:** quitar `will-change` de la regla base y añadirlo solo
  mientras ocurre la transición (vía JS, `sidebar.style.willChange = 'transform, width'`
  al iniciar el toggle y `sidebar.style.willChange = 'auto'` en `transitionend`), o
  dejarlo como está si un perfil de rendimiento real (no solo lectura de código)
  confirma que el costo es despreciable en los dispositivos objetivo — este
  hallazgo es de prioridad baja precisamente por eso.
- **Apple-design:** §11 Frame-level smoothness — `will-change` es una herramienta
  de "justo antes de animar", no un estado permanente.

### Notificaciones / Banners

#### G5 — [MEDIA] Oportunidad perdida — banners de TOTP e instalación PWA sin transición de entrada/salida
- **Archivos:** `public/index.html:160-174` + `public/app.js:226`
- **Selector/función:** `#totpReminderBanner`, `#installBanner`
- **Problema actual:** el banner de recordatorio de 2FA se muestra/oculta así:
  ```js
  // app.js:226
  $('#totpReminderBanner').style.display = state.needsTotpReminder ? 'flex' : 'none';
  ```
  y `#installBanner` sigue el mismo patrón (toggle de `hidden-initial` + `display`
  directo, sin ninguna regla de `transition` asociada en `styles.css`). Ambos
  banners aparecen/desaparecen con un corte duro de layout — el contenido de abajo
  salta de posición sin aviso. Esto es justo el punto que el prompt de esta
  auditoría pidió revisar explícitamente (recordatorio de TOTP persistente de 3
  días).
- **Cambio propuesto:** tratar la aparición como una revelación de altura +
  fundido, evitando `display` abrupto:
  ```css
  #totpReminderBanner, #installBanner {
    overflow: hidden;
    max-height: 0; opacity: 0;
    transition: max-height 200ms var(--ease-out), opacity 200ms var(--ease-out);
  }
  #totpReminderBanner.show, #installBanner.show {
    max-height: 80px; opacity: 1;
  }
  ```
  y cambiar `app.js:226` de togglear `style.display` a togglear la clase `show`
  (requiere quitar `display:none` inicial del HTML y usar `hidden-initial` solo
  para el primer render, igual que ya se hace con `.notif-dropdown`/`.modal`).
- **Apple-design:** §3 Interruptibility + Categoría 8 (AUDIT.md) — "spatially-connected
  UI... with no motion explaining where it came from".

### Nóminas (calendario de asistencia)

#### G7 — [MEDIA] Oportunidad perdida — cambio de color instantáneo en celdas de asistencia
- **Archivos:** `public/app.js:6810-6833` + `public/styles.css:1219-1224, 1258-1264`
- **Selector/función:** `toggleCelda()` / `.asist-cell`, `.asist-heat-cell`
- **Problema actual:** `toggleCelda()` hace un *optimistic update* correcto —
  cambia el `classList` (color) de la celda al instante, antes de confirmar con el
  backend:
  ```js
  cell.classList.remove('presente', 'falta-just', 'falta-injust', 'vacio');
  cell.classList.add(ASIST_META[nuevo].cls);
  ```
  Pero `.asist-cell`/`.asist-heat-cell` solo declaran
  `transition: filter 0.1s, transform 0.1s;` — **no** transicionan `background`.
  El resultado es que el color (verde/amarillo/rojo/vacío) salta de golpe en vez
  de fundirse, en una grilla trabajador × día que es, según el starting state de
  esta auditoría, "candidato fuerte a revisión de feedback/microinteracción" y se
  toca con alta frecuencia durante la captura de asistencia.
- **Cambio propuesto:**
  ```css
  .asist-cell, .asist-heat-cell {
    transition: filter 0.1s, transform 0.1s, background-color 150ms ease;
  }
  ```
  (`background-color` no es una propiedad GPU-only como `transform`/`opacity`,
  pero en celdas pequeñas y acotadas —no listas largas— el costo de repintado es
  marginal; si se prioriza performance estricta, alternativa: cross-fade con una
  capa `::after` en `opacity`).
- **Apple-design:** Categoría 8 (AUDIT.md) — "state changes that teleport... where
  a brief transition would prevent a jarring change".

### Avance / Destajo / Finanzas (gráficas)

#### G8 — [BAJA] Performance/Frecuencia — Chart.js se recrea en cada render, repitiendo la animación de entrada
- **Archivo:** `public/app.js` líneas 1872 (`globalPie`), 2294 (`resumenDona`),
  3907 (`semanal`), 3938 (`fisfin`), 4438 (`destajo_${destId}`)
- **Problema actual:** cada una de estas vistas llama `new Chart(ctx, {...})`
  directamente en la función de render, sin usar `chart.update()` cuando la
  instancia ya existe (solo `destajo_${destId}` hace `state.charts[key].destroy()`
  antes de recrear, las demás ni siquiera destruyen la anterior explícitamente
  antes de reasignar). Sin configuración explícita de `animation`, Chart.js v4 usa
  su default de ~1000ms `easeOutQuart`. Como estas vistas se repintan en cada
  refresco (sync manual, polling de notificaciones, cambio de filtro), la
  animación de "crecer desde cero" se repite en cada refresco de datos, no solo la
  primera vez — ruido visual acumulativo en vistas de consulta frecuente
  (Finanzas, Avance).
- **Cambio propuesto:** cuando `state.charts[key]` ya exista, actualizar sus
  `data.datasets` y llamar `.update()` en vez de recrear la instancia; reservar la
  animación de entrada completa solo para el primer render de cada gráfica.
- **Apple-design:** Categoría 1 (AUDIT.md) — frecuencia de uso debe acortar el
  motion, no repetirlo.

### Nóminas (EPP — firma digital) / Autenticación

#### G9 — [BAJA] Fisicalidad — firma digital EPP no usa Pointer Events
- **Archivo:** `public/app.js:6540-6546`
- **Función:** trazo del canvas en `openEppModal` (o equivalente)
- **Problema actual:** el trazo se implementa con `mousedown`/`mousemove`/`mouseup`
  y `touchstart`/`touchmove`/`touchend` por separado, en vez de Pointer Events con
  `setPointerCapture`. Funcionalmente correcto para un trazo simple de firma, pero
  no sigue el patrón de "direct manipulation" (apple-design §2) que garantiza
  seguimiento 1:1 incluso si el puntero sale brevemente del canvas.
- **Cambio propuesto (opcional, bajo impacto):** migrar a
  `pointerdown`/`pointermove`/`pointerup` + `canvas.setPointerCapture(e.pointerId)`,
  eliminando la duplicación mouse/touch. No es una animación en sí, se documenta
  como nota de interacción relacionada porque afecta directamente la fisicalidad
  del trazo.
- **Apple-design:** §2 Direct manipulation.

#### G10 — [BAJA] Fisicalidad — transiciones entre pantallas de login/bienvenida/app con corte abrupto
- **Archivo:** `public/app.js:436-459`
- **Funciones:** `showLoginScreen()`, `showApp()`, `showClientGallery()`, `showWelcomeScreen()`
- **Problema actual:** las cuatro pantallas de nivel superior (`.login-screen`,
  `.gallery-screen`, `.welcome-screen`, `#app`) se alternan puramente con
  `style.display = 'none' / 'flex'`, sin ningún fundido. Dado que este flujo
  ocurre pocas veces al día (login, cambio de cliente), es de prioridad baja y
  opcional — se documenta como posible pulido, no como corrección urgente.
- **Cambio propuesto (opcional):** fundido cruzado corto (150-200ms, `opacity`
  únicamente, sin `transform`) entre estas pantallas de nivel superior.
- **Apple-design:** Categoría 1 (AUDIT.md) — "rare/first-time → can add delight",
  aplica aquí como oportunidad, no como corrección.

---

## 3. Top 5 quick wins

Priorizados por impacto ÷ riesgo, pensando en commits separados (una mejora por
commit, según el protocolo del proyecto):

1. **G4 — Fix de timing del quick-action-sheet.** Cambio de un solo número
   (`220` → `250` en `app.js:1049`). Riesgo mínimo, elimina un salto visible que
   ocurre en cada uso del FAB móvil.
2. **G1 — Tokens de easing (`--ease-out`, `--ease-in-out`).** Dos líneas nuevas en
   `:root` + migración de las transiciones de entrada/salida existentes a los
   tokens. Alto impacto de cohesión, bajo riesgo (son las mismas curvas o más
   fuertes que las actuales, no cambia comportamiento funcional).
3. **G3 — Ampliar `prefers-reduced-motion`.** Un solo bloque de CSS a extender.
   Corrección de accesibilidad real, riesgo bajo (solo afecta a usuarios que ya
   activaron la preferencia del sistema).
4. **G5 — Transición de entrada/salida para los banners de TOTP e instalación.**
   Responde directamente al recordatorio activo señalado en el starting state de
   este prompt. Requiere el cambio de patrón `style.display` → `classList` descrito
   arriba; riesgo bajo-medio porque toca la lógica de visibilidad, no solo CSS.
5. **G7 — Transición de `background-color` en celdas de asistencia.** Una línea de
   CSS (`background-color 150ms ease` añadido a la propiedad `transition`
   existente). Impacto directo en el módulo señalado como "candidato fuerte" en el
   starting state, riesgo mínimo.

*(G2 — hover gating táctil — es el hallazgo de mayor impacto real dado que la app
es mobile-first, pero se excluye deliberadamente del Top 5 "quick win" por su
superficie: toca 15+ selectores en `styles.css` y merece su propio commit
dedicado en vez de empaquetarse como cambio rápido.)*

---

## 4. Confirmación de alcance

- Ningún archivo de código (`.css`, `.js`, `.html`) fue modificado durante esta
  auditoría.
- Único archivo creado: `docs/auditoria-animaciones.md` (este reporte).
- No se instalaron dependencias ni librerías de animación.
- No se tocó backend, base de datos, ni archivos de configuración.
