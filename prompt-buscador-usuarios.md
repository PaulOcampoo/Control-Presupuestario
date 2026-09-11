Objective:
Agregar un buscador (filtro de texto) en el módulo de Usuarios, mismo patrón ya implementado para Requisiciones y Órdenes de Compra (PR #210), para encontrar rápido por nombre cuando la lista crece.

Starting State:
- Módulo Usuarios (Administración → Usuarios) lista usuarios sin filtro de búsqueda hoy.
- Ya existe el patrón de buscador (`search-bar-fancy`, filtrado instantáneo client-side, mensaje "Sin resultados para '...'") implementado en Requisiciones/OC — reusar el mismo componente/lógica, no inventar uno nuevo.

Target State:
1. Confirmar la función de render de la lista de Usuarios (`public/app.js`) y si los datos ya están todos en memoria (necesario para filtrado instantáneo sin roundtrip).
2. Agregar el mismo buscador (`search-bar-fancy`) arriba de la lista de usuarios, con placeholder tipo "Buscar por nombre...".
3. Filtrar por nombre (y correo/usuario si existe ese campo visible) — case-insensitive, sin acentos, mismo criterio ya usado en el buscador de Requisiciones/OC.
4. Mensaje "Sin resultados para '...'" cuando no haya coincidencias.
5. Preservar cualquier filtro/orden existente (ej. por rol, por obra asignada) — el buscador se combina, no reemplaza.
6. Bump de `SW_VERSION`.

Allowed Actions:
- Modificar `public/app.js` (función de render de Usuarios) y `public/index.html`/`public/styles.css` si hace falta.
- Levantar app local contra Preview, verificar con Playwright/WebKit: escribir un nombre real y confirmar filtrado correcto, confirmar "sin resultados", confirmar que limpiar restaura la lista completa.
- Bumpear `SW_VERSION`.

Forbidden Actions:
- NO tocar la lógica de negocio de Usuarios (alta, edición, permisos, asignación de obras) — solo agregar el filtro de búsqueda.
- NO tocar Producción, NO commit a main.

Checkpoints:
✅ Buscador funcional en Usuarios, verificado con Playwright (término real, resultados correctos, "sin resultados" si aplica).
✅ Filtros/orden existentes siguen funcionando combinados con el buscador.
✅ SW_VERSION bumpeado, confirmado vía curl real.
✅ Branch lista para PR, sin commit a main.

Estimado: ~20-25 min con Claude Code (Sonnet 5, esfuerzo Medio) — componente ya existe, es reuso directo.
