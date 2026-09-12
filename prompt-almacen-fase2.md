Objective:
Fase 2 del módulo Almacén: vista de existencias por obra (Entradas − Salidas, calculado al vuelo por insumo), sin conciliación contra presupuesto todavía — eso es Fase 3, deliberadamente fuera de este prompt.

Starting State:
- Almacén Fase 1 (PR #244, en main) ya tiene `almacen_entradas` y `almacen_salidas` operando, con captura por compras (Entradas) y residente/cabo (Salidas), permisos separados en dos secciones (`almacen_entradas`/`almacen_salidas`).
- No existe ningún cálculo de existencias hoy — solo las dos bitácoras (Entradas y Salidas) por separado.
- Patrón ya establecido en todo el proyecto: los totales/agregados se calculan al vuelo en cada consulta (Avance Físico, Corte de Obra, estatus de OC), nunca se persisten en una columna — Existencias debe seguir el mismo patrón, no mantener un contador acumulado en `insumos` ni en ninguna tabla nueva.
- Bug ya corregido en Fase 1 (relevante aquí): residente/cabo no deben ver precios/costos que no les correspondan — antes de mostrar costo unitario o valor de existencias en esta vista, confirmar en Fase 0 si aplica la misma restricción.

Target State:

1. FASE 0 — confirmar antes de construir:
   - ¿Quién debe ver el valor monetario de las existencias (cantidad × costo), y quién solo la cantidad física? Aplicar el mismo criterio ya usado para Destajo/Nómina (residente ve cantidades, no necesariamente montos) salvo que Paul confirme lo contrario.
   - Confirmar si puede haber existencia negativa en los datos actuales de Preview (salidas > entradas por captura fuera de orden) — si existe, decidir cómo se muestra (alerta visual, no bloqueo, ya que el módulo no impide capturar una Salida sin validar contra Entradas — confirmar que efectivamente no hay esa validación hoy antes de asumir que puede pasar).

2. BACKEND — nuevo endpoint:
   - `GET /api/projects/:id/almacen/existencias` — por cada insumo con al menos un movimiento (Entrada o Salida) en esa obra: `total_entradas` (SUM cantidad), `total_salidas` (SUM cantidad), `existencia_actual` (entradas − salidas), unidad, categoría. Si el rol no debe ver costo (según Fase 0), omitir `valor_estimado` de la respuesta para ese rol, no solo ocultarlo en frontend.
   - Marcar `existencia_actual < 0` explícitamente en la respuesta (`inconsistente: true`) sin ocultar el dato ni bloquear nada — es una señal de captura a revisar, no un error del sistema.
   - Scoping de proyecto igual que el resto de Almacén.

3. FRONTEND — nueva sub-vista dentro del tab "Almacén":
   - Tabla: Insumo | Categoría | Unidad | Total Entradas | Total Salidas | Existencia Actual | (Valor estimado, solo si el rol puede verlo).
   - Resaltar visualmente (badge/color) las filas con `existencia_actual < 0`.
   - Buscador de texto libre (mismo patrón `.search-bar-fancy` ya usado en Requisiciones) por insumo/código.
   - Reutilizar componentes visuales ya construidos en Corte de Obra (tarjetas/KPIs) si aplica, para mantener consistencia visual entre módulos de Finanzas/Almacén.

Allowed Actions:
- Crear el endpoint en `server/almacen.js` (o donde vivan ya los endpoints de Fase 1), registrar ruta en `server/app.js`.
- Modificar `public/app.js` para la nueva sub-vista.
- Bump `SW_VERSION`.

Forbidden Actions:
- NO persistir existencias en ninguna columna/tabla — cálculo al vuelo únicamente, consistente con el resto del sistema.
- NO construir todavía la comparación contra presupuesto ni alertas de "% consumido vs presupuestado" — eso es Fase 3.
- NO bloquear la captura de Salidas aunque generen existencia negativa — solo señalizar, no impedir (esa validación, si se decide, sería una decisión de producto aparte, no parte de este prompt).

Stop Conditions:
- Si la Fase 0 revela que ya existe alguna validación que impide existencia negativa (contradice lo asumido) — pausar y reportar antes de construir el manejo de inconsistencias.

Checkpoints:
✅ Fase 0 resuelta: quién ve costos, confirmación de si puede haber existencia negativa hoy en Preview.
✅ Endpoint verificado con output literal: una obra con movimientos reales, incluyendo al menos un caso de existencia baja o negativa si existe en los datos de Preview.
✅ Vista verificada en navegador real (Playwright + WebKit) con ambos roles (compras/residente) confirmando visibilidad de costo diferenciada según Fase 0.
✅ vitest completo en serie, sin regresiones nuevas.
✅ Lista final de archivos modificados.

Estimado: esfuerzo Bajo-Medio — Claude Code + Sonnet 5, ~2 horas.
