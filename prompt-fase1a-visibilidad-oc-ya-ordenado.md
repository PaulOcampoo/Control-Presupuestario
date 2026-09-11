Objective:
Corregir el bug de visibilidad confirmado en Fase 0: el modal "Generar Orden de Compra" siempre prellena la cantidad ORIGINAL solicitada de cada insumo, sin mostrar cuánto ya se ordenó en OCs previas de la misma requisición — causa real de los duplicados encontrados (requisiciones #22, #32, #55 en Producción). Esta es la Parte 1 (visibilidad) de 2; el bloqueo/confirmación explícita de sobre-orden es un prompt separado posterior.

Starting State (confirmado en Fase 0, con evidencia real):
- Esquema ya soporta OC por insumo (`orden_compra_items.requisicion_item_id`) — no es un problema de diseño, es que el modal no muestra el acumulado ya ordenado.
- Casos reales en Producción confirman el patrón: se reabre "Generar OC" de la misma requisición, el modal muestra la cantidad completa original otra vez (ej. 13 unidades de tubo, aunque ya se hayan ordenado 13 antes), sin ninguna señal de que ya se ordenó.
- El detalle de requisición tampoco lista las OCs ya generadas desde ella — otro punto ciego relacionado.

Target State:
1. En el modal "Generar Orden de Compra": para cada insumo, mostrar junto a "Cantidad a ordenar" el acumulado ya ordenado en OCs previas de esa misma requisición (ej. "Solicitado: 13 M · Ya ordenado: 13 M · Disponible: 0 M"), y prellenar el campo con el DISPONIBLE (solicitado − ya ordenado), no con el solicitado original — así el usuario ve de entrada qué falta, no tiene que restar a mano.
2. Si el disponible de un insumo es 0, el campo debe reflejarlo (prellenado en 0) pero seguir siendo editable por si el usuario de verdad quiere sobre-ordenar (esa decisión explícita es la Parte 2, este prompt no la bloquea, solo la hace visible).
3. En el detalle de la requisición: agregar una lista/sección "Órdenes de Compra generadas desde esta requisición" — folio, proveedor, fecha, estado, para que sea obvio de un vistazo si ya existen OCs previas antes de generar una nueva.
4. Bump de `SW_VERSION`.

Allowed Actions:
- Modificar `public/app.js` (modal de generar OC, detalle de requisición), `server/app.js` (si hace falta un endpoint/campo adicional para traer el acumulado ya ordenado por insumo).
- Levantar app local contra Preview, verificar con Playwright/WebKit: abrir "Generar OC" de una requisición con una OC previa ya generada (usar datos reales si existen en Preview, o crear un caso de prueba y limpiarlo al final), confirmar que se muestra el acumulado y el campo prellena con el disponible correcto.
- Bumpear `SW_VERSION`.

Forbidden Actions:
- NO bloquear ni impedir la generación de una OC que sobre-ordene — solo hacerlo visible. El bloqueo/confirmación es la Parte 2, prompt separado.
- NO tocar la lógica de cálculo de montos/IVA del modal — solo la visibilidad de cantidades.
- NO tocar Producción, NO commit a main.

Stop Conditions:
- Si mostrar el acumulado requiere una query costosa que ralentice notablemente la apertura del modal — reportar el impacto de performance antes de continuar, no ignorarlo.

Checkpoints:
✅ Modal muestra "Solicitado / Ya ordenado / Disponible" por insumo, verificado con Playwright contra un caso real o de prueba con OC previa.
✅ Campo "Cantidad a ordenar" prellena con el disponible, no el solicitado original.
✅ Detalle de requisición lista las OCs ya generadas desde ella.
✅ SW_VERSION bumpeado, confirmado vía curl real.
✅ Branch lista para PR, sin commit a main.

Estimado: ~30-40 min con Claude Code (Sonnet 5, esfuerzo Medio) — primera mitad del estimado total ya dado en Fase 0 (65-85 min en 2 partes).
