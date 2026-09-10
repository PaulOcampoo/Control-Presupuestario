Objective:
Diagnóstico de solo lectura (sin tocar código ni datos) para determinar de dónde sale, o debería salir, el desglose de Presupuesto por categoría (Mano de Obra / Materiales / Equipo y Herramienta) a partir de los datos que YA se cargan al importar el Excel de Presupuesto por obra — sin depender de `matrices_precio_unitario`.

Starting State:
- Módulo Corte de Obra (mergeado en PR #236) hoy calcula Presupuesto por categoría vía `matrices_precio_unitario`, poblada solo en 1 de 7 obras reales — insuficiente según Paul.
- Paul pide: "que tome los datos cargados en el archivo de Excel y que haga la comparativa por insumos" — es decir, usar el Presupuesto tal como se importa (módulo Presupuestos, carga por Excel), cruzado contra `insumos.categoria`, no contra matrices.
- `concepto_insumos` (tabla puente conceptos↔insumos) está documentada como 0 filas pobladas en las obras reales estudiadas previamente — hay que confirmar si sigue así o si varía por obra.
- No se sabe todavía si el Excel de Presupuesto importa, por concepto, algún desglose de costo por categoría (ej. columnas de análisis de precio unitario: materiales/mano de obra/equipo) que hoy no se esté usando.

Target State (solo investigación, reportar hallazgos):

1. IMPORTACIÓN DE PRESUPUESTO:
   - Revisar el código de importación del Excel de Presupuesto (módulo Presupuestos): ¿qué columnas lee del Excel? ¿Guarda algún desglose de costo por categoría a nivel concepto (materiales/mano de obra/equipo), o solo `precio_unitario` total?
   - Si existe ese desglose: ¿en qué tabla/columna vive?

2. CONCEPTO_INSUMOS:
   - Query real: ¿cuántas filas tiene `concepto_insumos` hoy, por obra, en las 7 obras reales (ids 13, 24, 30, 32, 36, 41, 42)? ¿Cambió desde el diagnóstico anterior?
   - Si hay filas: ¿se puede cruzar concepto → insumos → `insumos.categoria` para sumar presupuesto por categoría por concepto?

3. OBRA749_OFICINAS (o el proyecto QA que Paul probó en el screenshot):
   - Confirmar si es una obra real o de prueba, y qué datos tiene poblados en `conceptos`, `concepto_insumos`, `matrices_precio_unitario`.
   - Reportar por qué mostró Presupuesto Total con cifra ($975,081.29) pero categorías "No disponible" — confirmar que es consistente con la lógica actual, no un bug.

4. CONCLUSIÓN:
   - Recomendar la fuente correcta para el desglose de Presupuesto por categoría dado lo encontrado: `concepto_insumos` + `insumos.categoria`, algún campo nuevo en la importación del Excel, u otra fuente. Si ninguna fuente tiene el dato poblado de forma confiable, decirlo explícitamente.

Allowed Actions:
- Solo lectura: queries SQL de solo SELECT, lectura de código de importación de Presupuesto.

Forbidden Actions:
- NO modificar código, schema ni datos.
- NO asumir que una fuente tiene el dato sin confirmarlo con query real.

Stop Conditions:
- Ninguna — este es un prompt de diagnóstico, reportar hallazgos y esperar instrucción antes de implementar cambios al módulo Corte de Obra.

Checkpoints:
✅ Output literal de: estructura de importación de Presupuesto (qué columnas del Excel se guardan y dónde).
✅ Output literal de: conteo de filas de `concepto_insumos` por cada una de las 7 obras reales.
✅ Output literal de: estado de OBRA749_OFICINAS (real vs QA, datos poblados en las 3 tablas relevantes).
✅ Recomendación clara de fuente de datos para el desglose de Presupuesto por categoría.

Estimado: esfuerzo Bajo — Claude Code + Sonnet 5, ~30-45 min (solo diagnóstico, sin implementación).
