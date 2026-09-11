Objective:
Agregar un buscador (filtro de texto) en las vistas de Requisiciones y Órdenes de Compra, para encontrar rápido por folio, proveedor, o concepto/insumo — motivado por la dificultad real de ubicar registros al investigar las OCs duplicadas de esta sesión.

Starting State:
- Vistas actuales de Requisiciones y Órdenes de Compra listan registros sin filtro de búsqueda — confirmar en el código (`public/app.js`) cómo se renderiza cada lista hoy (¿todo cargado de una vez, o paginado?) antes de diseñar el filtro.
- Ambos módulos son independientes, cada uno con su propia función de render — el buscador debe implementarse en cada uno (no es necesariamente el mismo componente, pero sí el mismo patrón de interacción).

Target State:
1. INVENTARIO RÁPIDO:
   - Confirmar la función de render de la lista de Requisiciones y de Órdenes de Compra.
   - Confirmar qué campos ya están disponibles en el frontend para cada registro (folio, proveedor, insumos/conceptos, fecha, estado) sin necesitar un fetch adicional — el filtro debe ser instantáneo (client-side) si los datos ya están en memoria.

2. IMPLEMENTAR BUSCADOR:
   - Input de texto arriba de cada lista (Requisiciones, Órdenes de Compra), con placeholder tipo "Buscar por folio, proveedor o concepto...".
   - Filtrado instantáneo (sin roundtrip al servidor si los datos ya están cargados) conforme el usuario escribe — case-insensitive, sin acentos si el resto de la app ya normaliza así (confirmar convención existente).
   - Buscar coincidencia en: folio, nombre de proveedor, y texto de conceptos/insumos incluidos en cada requisición/OC.
   - Si no hay resultados, mostrar mensaje claro ("Sin resultados para '...'"), no una lista vacía sin explicación.
   - Preservar cualquier filtro existente (ej. por estado, por proyecto) — el buscador se combina con esos, no los reemplaza.

3. VERIFICACIÓN:
   - Con Playwright contra Preview, escribir un término real (ej. un folio o nombre de proveedor existente) y confirmar que la lista se filtra correctamente, y que borrar el texto restaura la lista completa.

Allowed Actions:
- Modificar `public/app.js` (funciones de render de Requisiciones y Órdenes de Compra) y `public/index.html`/`public/styles.css` si hace falta.
- Levantar app local contra Preview, verificar con Playwright/WebKit.
- Bumpear `SW_VERSION`.

Forbidden Actions:
- NO tocar la lógica de negocio de Requisiciones/OC (creación, estados, permisos) — solo agregar el filtro de búsqueda.
- NO tocar Producción, NO commit a main.

Stop Conditions:
- Si las listas actuales son paginadas desde el servidor (no todos los registros en memoria) — pausar y reportar, ya que el filtro instantáneo no funcionaría igual y requeriría búsqueda server-side en vez de client-side.

Checkpoints:
✅ Buscador funcional en Requisiciones, verificado con Playwright (término real, resultados correctos, mensaje de "sin resultados" si aplica).
✅ Buscador funcional en Órdenes de Compra, mismo tipo de verificación.
✅ Filtros existentes (estado/proyecto) siguen funcionando combinados con el buscador.
✅ SW_VERSION bumpeado, confirmado vía curl real.
✅ Branch lista para PR, sin commit a main.

Estimado: ~40-50 min con Claude Code (Sonnet 5, esfuerzo Medio).
