Objective:
Diagnóstico de solo lectura para dos reportes solicitados por Fernando: (1) Requisiciones filtrable por fecha programada, obra y cliente, con una "fecha de suministro" referenciada al programa de conceptos/actividades; (2) reporte desde Órdenes de Compra que cruce materiales requisitados por obra con su OC correspondiente, para seguimiento de estatus de insumo y concepto por presupuesto. Antes de diseñar ninguno de los dos, confirmar qué datos ya existen.

Starting State:
- Documentado como pendiente: módulo "Programa / Logística" (calendario de suministro semanal/diario) — "aún no construido, en el horizonte". No confirmado si sigue así o si algo se avanzó desde entonces.
- Requisiciones: existen, con acceso scoped a residente y audit log — no se conoce el detalle de campos de fecha que ya capturan.
- Órdenes de Compra: se generan desde una Requisición autorizada, con breakdown Subtotal/IVA/Total — no se conoce si guardan referencia detallada por insumo/cantidad, o solo el total.
- `insumos.categoria` ya confirmado como fuente confiable (Corte de Obra v2).

Target State (solo investigación, reportar hallazgos con evidencia):

1. PROGRAMA / FECHA PROGRAMADA POR CONCEPTO:
   - Buscar en schema (`server/db.js`) y código cualquier tabla o campo que guarde una fecha planeada/programada por concepto o actividad (ej. `programa`, `fecha_programada`, `calendario_suministro`, o algo dentro de `avance`/`conceptos`).
   - Confirmar explícitamente si existe o no. Si no existe ningún dato de fechas planeadas por concepto, decirlo sin rodeos — esto determina si el reporte de Requisiciones puede tener "fecha de suministro" real o si esa parte queda bloqueada hasta que exista Programa/Logística.

2. REQUISICIONES — campos existentes:
   - Listar todas las columnas de la tabla `requisiciones` (y su tabla de detalle/renglones si existe una separada por insumo). Confirmar qué fechas ya se capturan (fecha de solicitud, fecha requerida por el residente, etc.) y si hay vínculo a `cliente_id`/`proyecto_id` directo o vía `conceptos`/`proyectos`.

3. ÓRDENES DE COMPRA — vínculo a insumos y requisiciones:
   - Confirmar si `ordenes_compra` (o como se llame la tabla) tiene detalle por insumo (tabla puente tipo `oc_insumos` o similar) con cantidad/precio, o si solo guarda el total de la requisición.
   - Confirmar la relación exacta requisición → OC → pago, y si hay algún campo de "estatus del insumo" (pendiente/surtido/entregado) ya capturado en algún lado, o si eso no existe todavía.

4. CLIENTES:
   - Confirmar que `proyectos.cliente_id` permite filtrar requisiciones/OC por cliente sin necesidad de un nuevo campo (join proyecto→cliente).

Allowed Actions:
- Solo lectura: schema, código.

Forbidden Actions:
- NO modificar código ni datos.
- NO asumir que un dato existe sin confirmarlo en el schema real.

Stop Conditions:
- Ninguna — reportar hallazgos y esperar instrucción antes de diseñar los reportes.

Checkpoints:
✅ Confirmación explícita: ¿existe o no una fecha programada por concepto/actividad, y dónde vive si existe?
✅ Columnas reales de `requisiciones` (y su detalle por insumo si existe tabla separada).
✅ Columnas reales de `ordenes_compra` y su vínculo a insumos/requisiciones — confirmar si hay o no desglose por insumo y estatus.
✅ Confirmación de que se puede filtrar por cliente vía `proyectos.cliente_id`.
✅ Recomendación: con lo que existe hoy, qué es viable construir ya y qué depende de datos que aún no se capturan.

Estimado: esfuerzo Bajo-Medio — Claude Code + Sonnet 5, ~45 min.
