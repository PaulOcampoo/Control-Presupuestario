# Fase 0 — Zona de carga de archivos reusable (drag & drop)

Inventario + diseño para `prompt-fase0-zona-carga-archivos.md`. Sin
implementación — este documento es el checkpoint de decisión antes de
Fase 1.

## 1. Inventario completo

**18 elementos `<input type="file">` en 17 flujos distintos.** Se agrupan en
3 familias según su comportamiento — el diseño del componente debe cubrir
las 3, no solo la más simple.

### Familia A — Excel/PDF, sube y procesa automáticamente al elegir archivo

El patrón dominante (9 de 17 flujos): el usuario elige un archivo y la app
reacciona sola (sube a Blob, valida, muestra preview) — no hay un botón
"Subir" intermedio que el usuario deba presionar.

| Input | Línea | Acepta | Módulo | Trigger | Post-selección |
|---|---|---|---|---|---|
| `#fileInput` | `index.html:444` (hidden) | `.xlsx` | Alta de presupuesto (obra nueva) | Botón "+ Cargar presupuesto" → `.click()` | `validarArchivoXlsxCliente()` (firma ZIP + detecta `~$` de Excel abierto) → upload a Blob con modal de progreso + aviso "tardando más de lo normal" a los 90s + cancelar (`AbortController`) |
| `#actualizarPresupuestoFile` | `app.js:6280` (visible) | `.xlsx` | Actualizar presupuesto existente | auto en `change` | Mismo validador + upload + preview→confirmar (emparejamiento, ver `prompt-fase0/1-emparejamiento-duplicados-legitimos.md`) |
| `#importCompletoFile` | `app.js:16813` (visible) | `.xlsx` | Importar completo (4 hojas) al crear obra | auto en `change` | Upload + preview→confirmar |
| `#cmArchivoInput` | `app.js:16211` (hidden) | `.xlsx` | Catálogo global de Costos (4 hojas) | Botón "⭱ Subir archivo" → `.click()` | Upload directo |
| `#matricesImportFile` | `app.js:17042` (visible) | `.xlsx` | Importar Matrices (Neodata) a obra existente | auto en `change` | Upload + preview→confirmar |
| `#reprocesoDMFile` | `app.js:17145` (visible) | `.xlsx` | Reprocesar Destajo/Matrices | auto en `change` | Upload + preview→confirmar |
| `#movImportFile` | `app.js:15311` (visible) | `.xlsx,.csv` | Importar movimientos bancarios | auto en `change` | Upload + preview→confirmar |
| `#loteImportFile` | `app.js:21351` (visible) | `.xlsx` | Importar lotes | auto en `change` | Upload + preview→confirmar |
| `#pdfFileInput` | `index.html:445` (hidden) | `.pdf` | Contrato de obra (crear o adjuntar) | 2 entry points: `promptUploadContrato()` / `promptAttachContrato()` → `.click()` | Extracción con IA (`/projects/contrato-preview`) → modal de preview→confirmar |

### Familia B — Multi-archivo con preview de miniaturas (selección acumulativa)

| Input | Línea | Acepta | Módulo | Particularidad |
|---|---|---|---|---|
| `#sugFileInput` | `app.js:9196` (hidden, `multiple`) | `image/*` | Adjuntar imágenes a una sugerencia | Botón 📎 dispara `.click()`. Acumula en array `sugFiles` (no reemplaza selección anterior), máx. 5 — el límite se recalcula contra lo ya elegido (`5 - sugFiles.length`). Miniaturas via `URL.createObjectURL` + botón ✕ para quitar una individual sin perder las demás. |

**Único caso realmente distinto** al resto — no es "un archivo entra, una
acción sale", es una lista viva que el usuario va construyendo.

### Familia C — Campo dentro de un formulario más grande (sin auto-trigger)

7 flujos (8 inputs, el par CFDI comparte un solo modal): el archivo es un
campo opcional más de un formulario con otros campos (fechas, selects,
montos); no pasa nada hasta que el usuario presiona el botón "Guardar" /
"Extraer" del formulario completo.

| Input | Línea | Acepta | Módulo |
|---|---|---|---|
| `#cumplFile` | `app.js:10809` | `image/*,.pdf` | Documento de cumplimiento (permiso/EPP) |
| `#docFile` | `app.js:18468` | `image/*,.pdf` | Documento de trabajador (INE/CURP/comprobante) |
| `#cPdfFile` | `app.js:18568` | `.pdf` | Contrato laboral de trabajador |
| `#ocDocumento` | `app.js:20976` | `.pdf,.jpg,.jpeg,.png` | Respaldo de Orden de Cambio |
| `#cvPdfFile` | `app.js:22028` | `.pdf` | Contrato de venta (comprador) |
| `#cveNuevoPdf` | `app.js:22107` | `.pdf` | Reemplazar PDF de contrato de venta |
| `#cfdiFileXml` + `#cfdiFilePdf` | `app.js:15059-15060` | `.xml` / `.pdf` | CFDI contabilidad — **2 inputs en el mismo modal**, un solo botón "Extraer datos" procesa ambos juntos |

Todos estos son el "botón nativo simple" que Paul señaló como ejemplo — sin
ningún tratamiento visual, ni siquiera los que ya usan preview/IA en otras
partes (CFDI extrae con IA pero el input en sí sigue siendo el nativo).

### Validación existente a preservar

`validarArchivoXlsxCliente()` (`app.js:4675`) hace más que revisar la
extensión: lee los primeros 4 bytes del archivo y confirma la firma ZIP
(`PK\x03\x04` etc.) para detectar un `.xlsx` corrupto o mal nombrado, y
detecta el patrón `~$` de un archivo temporal de Excel (el original sigue
abierto). El componente reusable debe aceptar un validador async
pluggable — no puede limitarse a comparar `accept`/extensión, o se pierde
esta validación real.

## 2. Diseño del componente reusable

### Firma propuesta

```js
function crearZonaCargaArchivo({
  accept,              // ej. '.xlsx' o 'image/*' o '.pdf,.jpg,.jpeg,.png'
  multiple = false,     // Familia B
  texto,                // ej. "Arrastra tu Excel aquí o haz clic para elegirlo"
  icono = 'upload-cloud', // nuevo ícono en ICON_SVG, mismo set stroke-based que el resto (ver app.js:160)
  validar,              // async (file) => string | null  — mensaje de error o null si OK
  onFiles,              // (File[]) => void — SIEMPRE recibe un array, incluso con multiple:false ([file])
}) {
  // devuelve { el: HTMLElement, reset() }
}
```

`onFiles` recibiendo siempre un array (no un `File` suelto) es lo que
permite que el mismo componente sirva tanto para Familia A/C
(`onFiles([file]) => { ... file único ... }`) como para Familia B
(`onFiles(files) => sugFiles.push(...files)`).

### Estructura HTML

```html
<div class="file-dropzone" data-state="idle">
  <input type="file" class="file-dropzone-input" hidden accept="…" />
  <div class="file-dropzone-icon">…svg…</div>
  <p class="file-dropzone-text">Arrastra tu archivo aquí o haz clic para elegirlo</p>
  <p class="file-dropzone-hint">.xlsx · máx. 20 MB</p>
</div>
```

Un solo `<div>` clickeable que envuelve el `<input hidden>` — clic en
cualquier parte de la zona dispara `input.click()` (mismo patrón que ya usan
`#fileInput`/`#pdfFileInput`/`#cmArchivoInput` hoy, solo que ahora toda la
zona es "el botón", no un `<button>` de texto).

### Comportamiento desktop

- `dragover` → `preventDefault()` + `data-state="dragover"` (feedback visual, borde/fondo resaltado vía CSS, igual que Claude.ai).
- `dragleave` → vuelve a `data-state="idle"`.
- `drop` → `preventDefault()`, toma `e.dataTransfer.files`, mismo camino que `change`.
- Clic en la zona → `input.click()` (fallback siempre presente, no soltar nunca es obligatorio).

### Comportamiento móvil

El diagnóstico de Paul asume que hay que "apagar" drag & drop en móvil,
pero **no hace falta**: los eventos `dragover`/`drop` simplemente nunca se
disparan por touch (no existen en el modelo de eventos táctil), así que no
hay nada que desactivar — el único cambio real es el **texto** y que la
zona entera sigue siendo tap-to-open.

- Mismo breakpoint que ya usa el resto de la app (`window.innerWidth <= 860`, ver `app.js:3685` y `@media (max-width: 860px)` en `styles.css`) — reusar, no inventar una detección nueva.
- `≤860px`: texto cambia a "Toca para elegir un archivo" (sin mencionar "arrastrar"). El input nativo (`<input type="file" accept="image/*,.pdf">`) ya dispara el picker del OS con accesos a Cámara/Galería/Archivos cuando `accept` incluye imágenes — comportamiento gratis, no hay que construirlo.
- `>860px`: texto con la mención de arrastrar, igual que Claude.ai.

### Validación visual de tipo incorrecto

Si `drop`/`change` trae un archivo que no matchea `accept` (o falla el
`validar` async pluggable): `data-state="error"` un instante (borde rojo +
shake sutil, ~400ms) + `toast(mensaje, 'danger')` con el mensaje específico
del validador (ej. el de `validarArchivoXlsxCliente`) — nunca fallar en
silencio ni limpiar la zona sin explicar qué pasó.

## 3. Casos que NO encajan igual — reportados aparte (Stop Condition)

- **`#sugFileInput` (Familia B)**: el componente base cubre "elegir/soltar
  archivos", pero el manejo de la LISTA acumulada + miniaturas + botón
  quitar-uno vive fuera del componente, en el módulo de Sugerencias — el
  dropzone solo debe invocar `onFiles(files)` y dejar que el caller decida
  qué hacer (acumular vs. reemplazar). No forzar la lógica de miniaturas
  dentro del componente genérico.
- **`#fileInput`/`#actualizarPresupuestoFile` (modal de progreso + aviso de
  lentitud + cancelar)**: ese modal es post-selección, ajeno al dropzone en
  sí — el dropzone solo reemplaza el `<input>` + trigger, el flujo de
  upload-con-progreso sigue exactamente igual, sin tocarlo.
- **`#cfdiFileXml` + `#cfdiFilePdf`**: 2 dropzones independientes en el
  mismo modal (uno por archivo), sin auto-trigger — el botón "Extraer
  datos" del modal sigue leyendo `input.files[0]` de cada uno al hacer
  clic, no hay nada que cambiar en esa lógica.

Ninguno de estos requiere un diseño distinto del componente — solo aclarar
que el componente NO absorbe la lógica de negocio posterior (upload,
progreso, acumulación), solo la interacción de elegir/soltar + validar tipo.

## 4. Plan de rollout — recomendación: por lotes, no todo de una vez

**Lote 1 (Fase 1, mayor impacto):** los 2 flujos que Paul mencionó
explícitamente como ejemplo — `#fileInput` (alta de presupuesto) y
`#actualizarPresupuestoFile` (actualizar presupuesto) — más
`#pdfFileInput` (contrato de obra). Son los de mayor uso recurrente y ya
tienen la lógica de progreso/validación más compleja: si el componente
sobrevive a estos 3 sin fricción, sobrevive al resto.

**Lote 2:** el resto de la Familia A (`#cmArchivoInput`,
`#importCompletoFile`, `#matricesImportFile`, `#reprocesoDMFile`,
`#movImportFile`, `#loteImportFile`) — mismo patrón exacto que Lote 1, solo
repetir la integración.

**Lote 3:** Familia C (7 flujos, campos dentro de formularios) — menor
impacto individual (son opcionales, uso esporádico), y conviene validar
primero cómo se ve un dropzone pequeño *dentro* de un grid de formulario
(`.field`) antes de replicarlo 7 veces — el layout ahí es más apretado que
un modal dedicado.

**Lote 4:** `#sugFileInput` (Familia B) al final — es el único que necesita
la integración con la lógica de miniaturas/acumulación, conviene que el
componente base ya esté probado en producción antes de forzar ese caso más
particular.

**Por qué no todo de una vez:** 17 puntos de integración tocando módulos
tan distintos (presupuesto, contabilidad, RH, ventas, maquinaria) en un solo
PR es un blast radius grande para un cambio puramente de UX/interacción —
si algo del componente base necesita un ajuste tras ver el primer uso real
(ej. el `dragover` interfiere con el scroll de un modal largo en iOS, ver
`CLAUDE.md` sobre `position: sticky` + `overflow` — no es este caso
exactamente, pero el mismo tipo de sorpresa de Safari es plausible con
`dragover`/`drop` en touch), es mucho más barato descubrirlo en 3 flujos que
en 17.

## 5. Estimado Fase 1

- **Componente base + CSS + ícono nuevo + Lote 1 (3 flujos):** ~1.5-2h con
  Claude Code (Sonnet 5, esfuerzo Medio) — incluye verificación visual
  desktop + simulación móvil (viewport ≤860px) de los 3 flujos.
- **Lote 2 (6 flujos, mismo patrón repetido):** ~45-60 min.
- **Lote 3 (7 flujos dentro de formularios):** ~45-60 min — algo más lento
  por el ajuste de layout dentro de `.field`/grid.
- **Lote 4 (`#sugFileInput`, integración con miniaturas):** ~30 min.

**Total Fase 1 completa (los 4 lotes): ~3.5-4.5h**, recomendado repartir en
sesiones separadas (una por lote) con verificación visual real entre cada
una, no un solo PR gigante.
