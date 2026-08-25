Objective:
Eliminar el scroll lateral en tablas de detalle dentro de modales (empezando por "Ver detalle" de Nómina) SOLO en breakpoints de desktop, ensanchando el contenedor/modal en vez de recortar columnas — el contenido debe verse completo sin necesidad de deslizar. Auditar el resto de la app para encontrar otras tablas con el mismo problema y aplicar el mismo criterio donde aplique.

Starting State:
- Modal "Ver detalle" de Nómina: la tabla tiene más columnas de las que caben en el ancho actual del modal, forzando scroll horizontal (ver captura: columnas de montos cortadas, contenido visible parcial).
- App mobile-first — es esperable y correcto que en mobile algunas tablas anchas sigan necesitando scroll lateral (no hay espacio físico para evitarlo); este fix es explícitamente solo para desktop.
- Tokens de diseño y breakpoints ya definidos en el proyecto (revisar los existentes antes de definir uno nuevo para "desktop").

Target State:
1. DIAGNÓSTICO: listar todas las tablas dentro de modales/ventanas que actualmente dependen de scroll horizontal en desktop — no solo "Ver detalle" de Nómina. Buscar patrones CSS como `overflow-x: auto/scroll` combinados con anchos de modal fijos o `max-width` angostos, en `public/styles.css` y en los modales relevantes de `public/app.js`. Confirma que "Ver detalle" de Nómina es representativa (probable candidatos adicionales: Finanzas, Requisiciones, Órdenes de Compra, cualquier tabla comparativa/reporte).
2. Para cada tabla identificada, en breakpoint de desktop (definir el mínimo de ancho de pantalla que se considera "desktop" según los breakpoints ya existentes del proyecto):
   - Ensanchar el modal/contenedor (no reducir tamaño de fuente ni truncar contenido de columnas) hasta que la tabla quepa completa sin `overflow-x`.
   - Si el modal ya tiene un `max-width` fijo pensado para mobile/tablet, agregar una regla específica de desktop que lo amplíe (usar `min-width` de la tabla real como referencia, con margen razonable).
   - Mantener centrado y con margen lateral razonable respecto al viewport (no pegar el modal a los bordes de la pantalla).
3. En mobile/tablet: sin cambios — el scroll lateral existente se mantiene donde ya era necesario.
4. Si alguna tabla tiene tantas columnas que ensanchar el modal lo haría más ancho que el viewport típico de desktop (~1280-1440px), reportarlo como caso especial antes de forzarlo — puede necesitar una solución distinta (ej. columnas agrupables/colapsables) en vez de solo ensanchar.

Allowed Actions:
- Modificar `public/styles.css`: reglas de `@media` para breakpoints de desktop en los modales/contenedores identificados.
- Ajustar `max-width`/`width` de modales específicos, sin tocar el sistema de modales genérico si otros modales no tienen este problema.
- Usar los breakpoints y tokens de espaciado ya existentes del proyecto en vez de inventar valores nuevos.

Forbidden Actions:
- No reducir tamaño de fuente ni truncar/abreviar contenido de columnas como solución — el objetivo es que quepa completo, no que se vea más chico.
- No modificar el comportamiento en mobile/tablet — el scroll lateral ahí es esperado y correcto.
- No tocar la estructura de datos ni la lógica de cálculo de las tablas — esto es puramente visual/CSS.

Stop Conditions:
- Si una tabla tiene tantas columnas que ensancharla razonablemente en desktop la haría más ancha que el viewport típico, pausar y proponer alternativa antes de forzar un modal gigante.
- Si el diagnóstico encuentra más de 5-6 tablas afectadas, considerar dividir en más de un PR (ej. Nómina primero, resto después) y confirmar antes de proceder con todo en un solo cambio.

Checkpoints:
✅ Lista de tablas/modales afectados encontrados en el diagnóstico.
✅ Captura o confirmación de "Ver detalle" de Nómina sin scroll lateral en desktop, con todas las columnas visibles.
✅ Confirmación de que mobile/tablet no cambió (captura o descripción del breakpoint que se dejó intacto).
✅ Verificación visual tuya en dispositivo real (desktop) antes de cerrar.

Estimado de ejecución (Claude Code + Sonnet 5, esfuerzo Medio): 1.5–3 horas, dependiendo de cuántas tablas aparezcan en el diagnóstico.
