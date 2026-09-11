Objective:
Nuevo reporte "Materiales requisitados por obra — seguimiento de surtido": por cada renglón de insumo requisitado, mostrar su referencia a la Orden de Compra correspondiente y su estatus de surtido (calculado, no pre-guardado), para dar seguimiento al insumo y al concepto de presupuesto por obra.

Starting State:
- Cadena de datos confirmada (diagnóstico previo): `requisiciones` → `requisicion_items` (insumo, cantidad_solicitada, importe) → `ordenes_compra` (via `requisicion_id`) → `orden_compra_items` (via `requisicion_item_id`, cantidad_ordenada, precio_unitario, importe) → `recepciones`/`recepcion_items` (cantidad_recibida por `orden_compra_item_id`).
- No existe un campo de "estatus del insumo" a nivel renglón — se deriva comparando `cantidad_ordenada` vs `SUM(cantidad_recibida)`, mismo patrón que "Avance Físico" ya calculado al vuelo en otros reportes.
- `ordenes_compra.estado` ya se recalcula automáticamente a `recibida_parcial`/`recibida_completa` a nivel OC completa — este reporte nuevo es a nivel renglón/insumo, más granular.
- Filtro por obra vía `project_id`; filtro por cliente vía `proyectos.cliente_id` (patrón ya usado en `/api/requisiciones/programa`).
- Ya existe `/api/requisiciones/programa` (Reporte #1) para fecha/obra/cliente a nivel requisición — este reporte nuevo es complementario, a nivel de insumo/OC, no lo reemplaza.

Target State:

1. BACKEND — nuevo endpoint:
   - `GET /api/requisiciones/seguimiento-materiales` (ajustar nombre a la convención real del repo), con filtros `project_id` (opcional = todas las obras asignadas) y `cliente_id` (opcional).
   - Por cada `requisicion_item`: folio de requisición, insumo (nombre + categoría), cantidad solicitada, folio de OC (si existe — puede no haber OC todavía si la requisición sigue sin autorizar), cantidad ordenada, cantidad recibida (`SUM(recepcion_items.cantidad_recibida)` para ese `orden_compra_item_id`), y estatus calculado:
     - `sin_oc` — no hay OC generada todavía para esa requisición.
     - `pendiente` — OC existe, recibido = 0.
     - `parcial` — 0 < recibido < ordenado.
     - `completo` — recibido >= ordenado.
   - Vincular cada insumo a su concepto cuando exista mapeo en `concepto_insumos` (para dar seguimiento por concepto de presupuesto), dejando explícito "sin mapeo" cuando no exista (no inventar el concepto).
   - Respeta scoping de proyectos (403 si no asignado).

2. FRONTEND — nueva vista:
   - Ubicar junto al reporte de Programa de Suministros existente (misma sección/menú), como pestaña o vista hermana — no duplicar navegación.
   - Tabla: Obra | Folio Requisición | Insumo | Categoría | Cant. Solicitada | Folio OC | Cant. Ordenada | Cant. Recibida | Estatus (badge de color: sin_oc/pendiente/parcial/completo) | Concepto vinculado (o "sin mapeo").
   - Filtros: obra (dropdown), cliente (dropdown), estatus (opcional, multi-select).

3. EXPORT:
   - Botón "Exportar a Excel", mismas columnas, reutilizando `server/exportHelper.js`.

Allowed Actions:
- Crear el endpoint nuevo en `server/app.js` (o módulo dedicado).
- Modificar `public/app.js` para la nueva vista, junto al reporte de Programa de Suministros.
- Extender `server/exportHelper.js` para el nuevo export.
- Bump `SW_VERSION`.

Forbidden Actions:
- NO modificar `/api/requisiciones/programa` ni su lógica existente — este es un reporte nuevo y complementario.
- NO agregar ninguna columna de "estatus" persistida en `orden_compra_items` — el estatus se calcula al vuelo en cada consulta, igual que Avance Físico.
- NO inventar el concepto vinculado cuando `concepto_insumos` no tenga el mapeo — mostrar "sin mapeo" explícito.

Stop Conditions:
- Si al probar con datos reales el join `requisicion_item → orden_compra_item` resulta ambiguo (más de una OC para el mismo `requisicion_item_id`) — pausar y reportar el caso antes de asumir cuál usar.

Checkpoints:
✅ Endpoint verificado con output literal para: una obra con requisiciones en varios estatus (sin_oc, pendiente, parcial, completo idealmente representados), y filtro por cliente.
✅ Vista verificada en navegador real (Playwright + WebKit).
✅ Export Excel generado correctamente.
✅ vitest completo en serie, sin regresiones nuevas frente a las fallas ya documentadas como preexistentes.
✅ Lista final de archivos modificados con resumen de cada cambio.

Estimado: esfuerzo Medio — Claude Code + Sonnet 5, ~2-3 horas.
