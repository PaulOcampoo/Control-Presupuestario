Objective:
Diagnóstico de solo lectura para determinar si la brecha entre `Σ insumos.importe_presupuesto` y el Total oficial del presupuesto (11%–64% según obra, hallazgo del diagnóstico anterior) es un problema de captura en el Excel, o una pérdida de datos durante la importación/parseo — Paul afirma que los archivos Excel se entregan completos con toda la información requerida.

Starting State:
- Diagnóstico previo confirmó: `insumos.importe_presupuesto` (hoja "Listado de insumos" del Excel) subestima el Total oficial (`meta.total_sin_iva`) entre 11% y 64% en las 7 obras reales. Peor caso: obra 13 (715 URBANIZACION AMANI), cubre solo ~36% del total.
- `server/parser.js` — `parseBudgetConcepts()` (línea 179) lee la hoja "Presupuesto de obra"; `parseInsumos()` (línea 252) lee "Listado de insumos".
- No se ha verificado todavía si el archivo Excel original sigue disponible (Vercel Blob u otro storage) para comparar fila por fila contra lo que quedó en `insumos`.
- Hipótesis a descartar: filas descartadas silenciosamente durante el parseo (validación fallida sin log, categoría no reconocida, código de insumo duplicado sobrescribiendo en vez de sumar, celdas combinadas/fórmulas de Excel mal leídas, filas con importe pero sin categoría asignada).

Target State (solo investigación, reportar hallazgos con evidencia):

1. DISPONIBILIDAD DEL EXCEL ORIGINAL:
   - Confirmar si el Excel de Presupuesto se guarda en Vercel Blob (u otro storage) al importarse, o si solo se persiste el resultado parseado. Si se guarda, localizar el archivo de la obra 13 (peor caso) para comparación directa.

2. RECONCILIACIÓN FILA POR FILA (obra 13, o la que tenga el Excel disponible):
   - Contar filas totales en la hoja "Listado de insumos" del Excel original vs filas en `insumos` para esa obra.
   - Sumar `importe` de TODAS las filas del Excel (incluyendo cualquiera que el parser pudiera haber descartado) vs `SUM(importe_presupuesto)` en base de datos.
   - Si hay diferencia en conteo de filas: identificar exactamente qué filas se perdieron y por qué (columna vacía, formato numérico no reconocido, categoría con texto distinto a los 3 valores esperados, fila de subtotal/encabezado mal interpretada como dato, etc.)

3. REVISIÓN DE `parseInsumos()`:
   - Leer el código completo de la función: ¿hay algún `try/catch` que silencie errores de fila sin loguearlos? ¿Hay `continue`/`skip` condicionado? ¿Se usa `INSERT ... ON CONFLICT` que pueda sobrescribir en vez de acumular si hay códigos de insumo repetidos dentro del mismo Excel?
   - Revisar si existe algún log de importación (consola, tabla de auditoría, Vercel logs) de la importación real de la obra 13 que muestre filas rechazadas o warnings.

4. HIPÓTESIS ALTERNATIVA — conceptos sin desglose a insumos:
   - Verificar si la brecha se explica porque ciertos conceptos de "Presupuesto de obra" simplemente no tienen ninguna fila correspondiente en "Listado de insumos" en el Excel mismo (es decir, el Excel si está incompleto en esa hoja específica, aunque la hoja de conceptos sí sume el Total completo) — esto sería confirmación de que el archivo no es 100% exhaustivo en insumos, no un bug de importación.

Allowed Actions:
- Solo lectura: código, base de datos, Vercel Blob (si aplica), logs.

Forbidden Actions:
- NO modificar código, schema ni datos.
- NO concluir "problema de captura" sin haber revisado el código de `parseInsumos()` a fondo, ni concluir "bug de importación" sin haber comparado contra el Excel original fila por fila.

Stop Conditions:
- Si el Excel original no está disponible en ningún storage para ninguna de las 7 obras — pausar y pedir a Paul una copia del Excel de al menos una obra (idealmente la 13) para comparar directamente.

Checkpoints:
✅ Confirmación de si el Excel original está disponible, y de qué obra(s).
✅ Conteo de filas y suma de importes: Excel original vs base de datos, con output literal.
✅ Si hay filas perdidas: causa exacta identificada en el código, con línea y snippet.
✅ Conclusión: ¿es pérdida en importación (bug a corregir) o el Excel mismo no captura el 100% en la hoja de insumos (limitación de captura, no de código)?

Estimado: esfuerzo Bajo-Medio — Claude Code + Sonnet 5, ~45-60 min.
