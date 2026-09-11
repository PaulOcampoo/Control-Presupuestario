Objective:
Implementar el cuarto y último PR de la Fase 4: registro formal de entrega de un lote al comprador, con firma digital, reusando el mecanismo ya probado de EPP (Nómina) en vez de construir uno nuevo. Cierra el ciclo completo del roadmap Desarrollador de Vivienda (Lotes → Infraestructura → Catálogo comercial → Compradores/Apartado → Contrato → Cobranza → Entrega).

Starting State:
- `lotes.estatus` (Fase 1, construcción: sin_iniciar/en_proceso/terminado/entregado) y `lotes.fecha_entrega_real`/`fecha_entrega_estimada` ya existen, pero hoy son campos sueltos sin ningún proceso formal detrás — cualquiera con acceso a Lotes puede marcar `estatus='entregado'` sin que exista ningún acta ni firma.
- `contratos_venta` (PR B) y el cálculo de `saldo_pendiente`/`estado_pago` (PR C) ya existen.
- Mecanismo de firma digital ya en producción: `epp_entregas.firma_digital` (TEXT, base64 PNG) + captura en frontend con `canvas.setPointerCapture(e.pointerId)` (public/app.js — ubicar la implementación exacta y reusarla, no reescribirla).
- Decisión confirmada por Paul: la entrega NO requiere `estado_pago='liquidado'` — se puede entregar con saldo pendiente, mismo criterio de "advertir sin bloquear" que el resto de la Fase 4.
- Sección "Ventas" ya existe con tabs `compradores`, `apartados`, `contratosVenta`, `cobranza` — este PR agrega el tab `entregas`.

Target State:

1. SCHEMA (server/db.js):
   - Nueva tabla `entregas_lote`: id, lote_id (FK lotes, NOT NULL, UNIQUE — un lote se entrega una sola vez en esta fase, sin reentregas), contrato_venta_id (FK contratos_venta, NOT NULL — debe existir un contrato para poder entregar), fecha (DATE NOT NULL DEFAULT CURRENT_DATE), firma_digital (TEXT, base64 PNG), recibido_por (TEXT NOT NULL — nombre de quien recibe físicamente, puede no ser el comprador registrado), entregado_por (FK usuarios, NOT NULL — quién de Roforb hizo la entrega), observaciones (TEXT, nullable), creado_en.

2. BACKEND (server/ventas.js, extender):
   - Crear entrega (`POST /lotes/:loteId/entrega`):
     - Validar que exista un `contrato_venta` con `estado='vigente'` para ese lote (rechazar 400 si no — no se puede entregar sin venta vigente).
     - Validar que el lote no tenga ya una entrega registrada (además del UNIQUE en DB, dar 400 con mensaje claro).
     - Si `saldo_pendiente > 0` para ese contrato, NO bloquear — incluir el saldo en la respuesta como advertencia explícita (mismo criterio ya usado en Cobranza).
     - En la misma transacción: insertar la entrega, actualizar `lotes.estatus = 'entregado'` y `lotes.fecha_entrega_real = fecha` (reusa los campos de Fase 1, no crea un estatus paralelo desconectado).
   - Endpoint de consulta de entrega por lote (incluida en el detalle de lote o endpoint propio).
   - Mismo gateo de permisos que el resto de Ventas: admin/desarrollador exclusivo.

3. FRONTEND (public/app.js, public/styles.css):
   - Nuevo tab `entregas` dentro de la galería Ventas: lista de lotes vendidos pendientes de entregar vs ya entregados, con acceso directo a registrar la entrega.
   - Modal/formulario de entrega: fecha, campo de texto "recibido por", canvas de firma digital (reusando el componente/patrón exacto de EPP — no reimplementar `setPointerCapture` desde cero), observaciones opcionales. Si hay saldo pendiente, mostrar advertencia visible antes de confirmar (sin bloquear el botón de guardar).
   - Vista de Lotes: reflejar el nuevo `estatus='entregado'` con el badge ya existente de estatus de construcción (sin crear un badge paralelo).
   - Confirmaciones vía `confirmDialog()` — no `confirm()` nativo.
   - Selector custom — nunca `<select>` nativo.

Allowed Actions:
- Modificar server/db.js (schema), server/ventas.js (extender), server/app.js (montar rutas).
- Modificar public/app.js y public/styles.css, reusando el componente de firma de EPP.
- Bumpear SW_VERSION.
- Agregar tests cubriendo: entrega exitosa con contrato vigente, rechazo sin contrato vigente, rechazo de doble entrega sobre el mismo lote, advertencia de saldo pendiente sin bloqueo, actualización correcta de `lotes.estatus`/`fecha_entrega_real`, permisos.

Forbidden Actions:
- NO bloquear la entrega por saldo pendiente — solo advertir (decisión ya confirmada por Paul).
- NO crear un campo de estatus de entrega paralelo a `lotes.estatus` — reusar el existente.
- NO reimplementar la captura de firma digital desde cero — reusar el patrón de EPP.
- NO permitir reentrega sobre un lote ya entregado en esta fase (si se necesita corregir un error, es un caso de override manual a definir después, no parte de este PR).
- NO agregar `entregas_lote` al sistema granular de `permisos_usuario`.
- NO usar `<select>` ni `confirm()` nativos.

Stop Conditions:
- Si el componente de firma digital de EPP no es fácilmente reusable tal cual (ej. está fuertemente acoplado a la estructura específica de EPP), pausar y reportar antes de decidir si se extrae a un componente compartido o se reimplementa mínimamente.
- Si aparece ambigüedad sobre si `lotes.estatus='entregado'` ya se está usando hoy para otro significado (puramente de avance de construcción, sin relación a venta) de forma que pisar ese valor rompería algo existente, pausar y confirmar antes de escribirlo.

Checkpoints:
✅ Migración aplicada en Preview — output literal de la tabla nueva.
✅ Entrega exitosa: verificación literal de que `lotes.estatus` y `fecha_entrega_real` se actualizan en la misma transacción.
✅ Rechazo sin contrato vigente y rechazo de doble entrega, ambos probados.
✅ Advertencia de saldo pendiente verificada sin bloqueo.
✅ Confirmación de que el componente de firma reusado captura y persiste correctamente (base64 PNG legible).
✅ 403 para no-admin/desarrollador.
✅ SW_VERSION bumpeado.
✅ Verificación visual tuya en dispositivo real: registrar una entrega completa con firma, confirmar el badge de "Entregado" en Lotes, y ver la advertencia si el contrato de prueba tiene saldo pendiente.
✅ Limpieza de datos de prueba verificada (0 residuos).

Estimado de ejecución (Claude Code + Sonnet 5, esfuerzo Medio): 2.5–3.5 horas.
