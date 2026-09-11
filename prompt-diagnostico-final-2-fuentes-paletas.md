Objective:
Encontrar por qué el `<div class="palette-selector">` real renderizado en el DOM solo tiene 4 botones (dorada/morada/verde/naranja), cuando el string "ZAFIRO"/`data-palette-set="azul"` sí existe en el archivo `app.d4318d5f62.js` servido (confirmado por grep). Sospecha, basada en 2 bugs idénticos ya encontrados en esta misma sesión (funciones `openRegistrarPagoModal` duplicadas, `CONTABILIDAD_TABS` duplicado en auth.js): existen 2 lugares en el código que generan/definen la lista de paletas, y solo uno de los 2 se actualizó al agregar Zafiro.

Starting State (confirmado con evidencia real):
- HTML real del DOM (capturado en incógnito, producción, login real): `.palette-selector` contiene exactamente 4 `<button class="palette-opt">`.
- El archivo `app.d4318d5f62.js` servido contiene literalmente "ZAFIRO" y `data-palette-set="azul"` en algún punto (confirmado por grep sobre el contenido descargado).
- Consola sin errores relevantes al renderizar Ajustes (los errores de CSP presentes son ruido preexistente, no relacionado).

Target State:
1. Búsqueda exhaustiva en `public/app.js` (fuente, no el archivo con hash) de TODAS las ocurrencias de:
   - La clase `palette-selector` o `palette-opt` (¿cuántas funciones generan este HTML?).
   - El string "ZAFIRO"/"azul" en contexto de paletas (¿en qué función específica vive, y esa función es la que realmente se invoca para pintar el modal de Ajustes?).
2. Confirmar si hay 2 (o más) funciones que generan una lista de paletas — una que sí incluye Zafiro y otra que no — y cuál de ellas es la que efectivamente se llama al abrir el modal de "Apariencia" que Paul ve.
3. Si se confirma la duplicación: identificar todos los call sites de ambas funciones, y determinar cuál es la real/viva y cuál quedó obsoleta (o si ambas deberían fusionarse en una sola fuente de verdad, como ya se hizo en los 2 casos anteriores de este mismo bug en la sesión).
4. Proponer el fix (no implementar todavía en este prompt si prefieres que sea diagnóstico puro — pero dado que ya hay 2 precedentes idénticos resueltos esta sesión con un patrón claro, puedes proceder directo a implementar el fix si la causa se confirma con la misma claridad que los casos anteriores).

Allowed Actions:
- Leer y buscar exhaustivamente en `public/app.js`.
- Si la causa se confirma con la misma claridad que los 2 casos previos (duplicación de fuente de verdad), implementar el fix: unificar a una sola función/fuente de paletas que incluya las 5, actualizar el o los call sites obsoletos.
- Levantar app local o verificar contra Preview con Playwright para confirmar que el modal real ahora muestra las 5 paletas.
- Bump de `SW_VERSION` si se implementa un fix.

Forbidden Actions:
- NO tocar Producción directamente — cualquier fix se prueba en Preview primero, se abre PR, y se mergea solo con autorización.
- NO adivinar la causa sin confirmarla con evidencia de código — si no es una duplicación de fuente, reportar la causa real encontrada, cualquiera que sea.

Checkpoints:
✅ Confirmación exhaustiva de cuántas funciones generan `.palette-selector`/`.palette-opt` en el código fuente.
✅ Causa raíz identificada con evidencia (duplicación confirmada, o causa distinta si no lo es).
✅ Si se implementa fix: las 5 paletas visibles en el modal real, verificado con Playwright contra Preview.
✅ SW_VERSION bumpeado si aplica, confirmado vía curl real.

Estimado: ~15-20 min con Claude Code (Sonnet 5, esfuerzo Medio) — dado el patrón ya conocido, debería ser rápido de confirmar.
