Objective:
Nuevo reporte dentro de la sección Obra: por cada concepto del presupuesto de la obra, mostrar Presupuesto (Cantidad/Precio unitario/Importe) junto a Avance Estimado (Cantidad/Importe acumulado de la última estimación aprobada) y Por Estimar (Cantidad/Importe restante contra el total presupuestado).

Starting State:
- `conceptos`: Código, Concepto, Grupo, Unidad, Cantidad, Precio unitario, Importe — ya existe por obra.
- `estimaciones`: folio, periodo, estado (borrador/enviada/aprobada/rechazada), total_acumulado, etc. `estimacion_conceptos`: por estimación y concepto, `cantidad_acumulada`, `importe_acumulado`, `porcentaje_avance` — el acumulado de una estimación aprobada ya incluye la suma de todas las aprobadas anteriores (no hay que sumar folios manualmente).
- De las 7 obras reales, solo RED HIDRAULICA (id 30) tiene estimaciones aprobadas con dato (`total_acumulado` $64,193.28); las otras 6 no tienen ninguna aprobada — Avance Estimado = $0.00 y Por Estimar = presupuesto completo es el resultado correcto ahí, no un dato faltante.
- Ya existe un export similar (`GET /api/projects/:id/export-catalogo-excel`, `server/app.js:6678`) pero solo trae el desglose Presupuesto por concepto + un resumen de 4 filas aparte (Presupuesto total / Total acumulado / Saldo por estimar / Avance no facturado) — NO trae Avance Estimado/Por Estimar por renglón de concepto, que es lo que este reporte nuevo debe agregar.
- Vista existente de detalle de estimación (`openVerEstimacionModal`, `public/app.js:21769`) muestra cantidad/importe acumulado por concepto pero solo para UNA estimación a la vez, no cruzado contra el presupuesto total de todos los conceptos de la obra.

Target State:

1. BACKEND — nuevo endpoint:
   - `GET /api/projects/:id/presupuesto-vs-estimaciones` (ajustar nombre a la convención real del repo).
   - Para el proyecto: obtener la estimación **aprobada** más reciente (por `periodo_fin` o fecha de aprobación descendente). Si no hay ninguna aprobada, Avance Estimado = 0 en cantidad e importe para todos los conceptos.
   - Por cada concepto de `conceptos` (join con `estimacion_conceptos` de esa estimación por `concepto_id`, LEFT JOIN para que los conceptos sin fila en la estimación salgan en 0, no se caigan del reporte):
     - Presupuesto: Cantidad, Precio unitario, Importe (de `conceptos`).
     - Avance Estimado: `cantidad_acumulada`, `importe_acumulado` (0 si no hay fila).
     - Por Estimar: `cantidad_presupuesto - cantidad_acumulada`, `importe_presupuesto - importe_acumulado`.
   - Respeta scoping de acceso a proyectos (403 si no asignado).

2. FRONTEND — nueva vista dentro de la sección Obra:
   - Ubicar junto a Presupuesto/Estimaciones en la navegación de esa sección (confirmar en el código de navegación de "Obra" dónde encaja mejor — no crear una sección nueva de nivel superior).
   - Tabla: Código | Concepto | Grupo | Unidad | Cantidad (Presup.) | Precio unitario | Importe (Presup.) | Avance Estimado — Cant. | Avance Estimado — Importe | Por Estimar — Cant. | Por Estimar — Importe.
   - Fila de totales al final (suma de Importe Presupuesto, Avance Estimado, Por Estimar).
   - Si la obra no tiene ninguna estimación aprobada: nota visible "Sin estimaciones aprobadas — Avance Estimado en $0, Por Estimar = presupuesto completo" (no ocultar la tabla).

3. EXPORT:
   - Botón "Exportar a Excel" reutilizando el patrón de `server/exportHelper.js`, mismas columnas que la vista.

Allowed Actions:
- Crear el endpoint nuevo en `server/app.js` (o módulo dedicado).
- Modificar `public/app.js` para la nueva vista dentro de la navegación de Obra.
- Extender `server/exportHelper.js` para el nuevo export.
- Bump `SW_VERSION`.

Forbidden Actions:
- NO modificar `export-catalogo-excel` ni el modal `openVerEstimacionModal` existentes — este es un reporte nuevo, no un reemplazo.
- NO sumar acumulados de múltiples estimaciones aprobadas manualmente — el acumulado de la más reciente ya incluye el histórico.
- NO mostrar "No disponible" cuando el resultado real es $0 por falta de estimaciones aprobadas — ese es un dato correcto, no un gap estructural (distinto al caso de Corte de Obra).

Stop Conditions:
- Si una obra tiene más de una estimación con estado 'aprobada' para el mismo periodo (ambigüedad de cuál es "la más reciente") — pausar y reportar el caso.
- Si se requieren más de 3 archivos backend afectados — pausar.

Checkpoints:
✅ Endpoint verificado con output literal para: obra 30 (con estimación aprobada, Avance Estimado > 0), y una obra sin estimaciones aprobadas (Avance Estimado = 0, Por Estimar = presupuesto completo).
✅ Vista verificada en navegador real (Playwright + WebKit) en ambos escenarios, incluyendo la nota cuando no hay estimaciones aprobadas.
✅ Export Excel generado correctamente con las mismas columnas.
✅ vitest completo en serie, sin regresiones nuevas frente a las 2 fallas ya documentadas como preexistentes.
✅ Lista final de archivos modificados con resumen de cada cambio.

Estimado: esfuerzo Medio — Claude Code + Sonnet 5, ~2-3 horas.
