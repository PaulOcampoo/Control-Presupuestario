Objective:
Implementar la vista de cierre mensual "Pagos de OC del mes" en Contabilidad, y agregar una 5ª hoja al Excel de exportación mensual ya existente (Fase 5 de Contabilidad) con el mismo contenido — basado en el diseño aprobado en Fase 0. Permite a Paul ver de un vistazo qué pagos del mes tienen o no factura vinculada antes de cerrar el mes.

Starting State (ya en main tras Fase 1, PR #216):
- Tab "Pagos de OC" en Contabilidad ya existe, con vinculación de CFDI por pago, badge visual "con/sin factura".
- `pagos.cfdi_id` ya existe en el schema, poblado donde se ha vinculado.
- Fase 5 de Contabilidad (Exportación) ya consolida 4 fuentes en un Excel mensual de varias hojas — patrón ya probado, confirmar el código real de esa exportación antes de extenderlo.

Target State:
1. VISTA DE CIERRE MENSUAL (en pantalla, dentro del tab "Pagos de OC" ya existente o una sección nueva del mismo):
   - Filtro por mes/año.
   - Lista de todos los pagos de OC del mes seleccionado: fecha, OC origen, proveedor, monto, estado de factura (con/sin CFDI vinculado) — reusa el badge ya construido en Fase 1.
   - Resumen en la parte superior: total pagado en el mes, cuánto tiene factura vinculada, cuánto falta.
   - Idealmente, poder filtrar/resaltar solo los pagos SIN factura, para que Paul los identifique rápido antes de cerrar.

2. 5ª HOJA EN EL EXCEL DE EXPORTACIÓN MENSUAL:
   - Localizar el código real de la Fase 5 (exportación) de Contabilidad.
   - Agregar una hoja nueva "Pagos OC" con las mismas columnas de la vista en pantalla (fecha, OC, proveedor, monto, folio fiscal del CFDI si está vinculado, estado).
   - Confirmar que se genera para el mismo rango de mes/año que las otras 4 hojas ya existentes, sin requerir un filtro aparte.

3. Bump de `SW_VERSION`.

Allowed Actions:
- Modificar `public/app.js` (vista de cierre mensual), `server/app.js` (endpoint de datos del mes si hace falta uno nuevo, o reusar el de Fase 1 con filtro de fecha), y el módulo de exportación de Contabilidad (Fase 5).
- Levantar app local contra Preview, verificar con Playwright/WebKit: generar la vista para un mes con datos reales (mezcla de pagos con y sin factura), confirmar el resumen y el filtro; descargar el Excel de exportación mensual y confirmar que la 5ª hoja aparece con los datos correctos.
- Bumpear `SW_VERSION`.

Forbidden Actions:
- NO modificar las otras 4 hojas ya existentes del Excel de exportación — solo agregar la 5ª.
- NO ampliar el acceso a roles que no tengan hoy acceso a Contabilidad/exportación.
- NO tocar Producción, NO commit a main.

Stop Conditions:
- Si el módulo de exportación (Fase 5) tiene una arquitectura que dificulta agregar una hoja nueva sin tocar las 4 existentes (ej. generación monolítica sin separación clara por hoja) — reportarlo antes de forzar un cambio riesgoso.

Checkpoints:
✅ Vista de cierre mensual funcional en pantalla, con filtro de mes/año, resumen, y distinción visual de pagos sin factura — verificado con datos reales de Preview.
✅ 5ª hoja "Pagos OC" en el Excel exportado, con datos correctos para el mes seleccionado.
✅ Las 4 hojas existentes del Excel quedan sin cambios, confirmado.
✅ SW_VERSION bumpeado, confirmado vía curl real.
✅ Branch lista para PR, sin commit a main.

Estimado: ~30-40 min con Claude Code (Sonnet 5, esfuerzo Medio).
