Objective:
Cancelar de forma segura las 2 OC duplicadas que quedaron activas y sin pagar en Producción — OC 18 (requisición #22, Red Hidráulica, proveedor ANSA PREFABRICADOS) y OC 50 (requisición #55, 684 Barrancas, proveedor MATERIALES VALDEZ) — para cerrar el riesgo de doble pago antes de que exista el fix de bloqueo de duplicados. La requisición #32 (amani eje 2) no requiere acción, sus 2 OCs ya están "rechazada".

Starting State (confirmado con evidencia real de Producción, solo lectura):
- OC 18: requisicion_id=22, proveedor ANSA PREFABRICADOS, estado "confirmada", 0 pagos, creada 2 minutos después de OC 17 (que sí tiene 1 pago de $5,593.66).
- OC 50: requisicion_id=55, proveedor MATERIALES VALDEZ, estado "confirmada", 0 pagos, creada ~9 minutos después de OC 49 (que sí tiene 1 pago de $118.32, estado recibida_parcial).
- Ninguna de las 2 OCs a cancelar tiene pagos ni recepciones registradas — confirmado en el diagnóstico previo.
- Regla dura del proyecto: nunca eliminar físicamente registros financieros — la acción correcta es cambiar el estado a algo tipo "cancelada"/"rechazada", nunca DELETE.

Target State:
1. CONFIRMAR MECANISMO EXISTENTE:
   - Buscar si ya existe una acción de "Cancelar"/"Rechazar" OC en la UI/API para una OC en estado "confirmada" sin pagos ni recepciones (ej. el mismo mecanismo que ya dejó a las OC 27/28 de la requisición #32 en estado "rechazada").
   - Confirmar qué endpoint/función se usa, y si tiene alguna restricción de estado previo que folio 18/50 cumplan.

2. SI EL MECANISMO YA EXISTE EN LA UI:
   - NO ejecutar nada por script — documentar los pasos exactos para que Paul lo haga él mismo desde la app en Producción (más simple y ya validado por el propio sistema, que puede tener validaciones que un script no replicaría).

3. SI NO EXISTE UN MECANISMO DE UI ACCESIBLE PARA ESTE CASO:
   - Preparar script SQL de solo cambio de estado (`UPDATE ordenes_compra SET estado = 'cancelada' WHERE id IN (18, 50)`, ajustando al valor de estado real que use el sistema — confirmar el enum/valores válidos primero) con verificación antes/después, para que Paul lo corra él mismo en el Neon SQL Editor de Producción — NUNCA ejecutarlo directamente contra Producción.
   - El script debe identificar cada OC por `id` (ya confirmado con evidencia real: 18 y 50), verificar antes de aplicar que siguen en estado "confirmada" con 0 pagos (para no cancelar algo que cambió de estado entre el diagnóstico y la ejecución), y mostrar verificación después.

Allowed Actions:
- Leer código relevante (`server/app.js`, `public/app.js` — lógica de estados/cancelación de OC).
- Preparar script SQL si aplica (no ejecutar contra Producción).
- SELECTs de solo lectura contra Preview si ayuda a confirmar el mecanismo antes de tocar Producción.

Forbidden Actions:
- NO ejecutar ningún cambio contra Producción — ni por script ni por ningún otro medio.
- NO hacer DELETE físico de ninguna OC.
- NO tocar la requisición #32 (amani eje 2) ni sus OCs — ya están resueltas.
- NO cancelar OC 17 o OC 49 (las originales, ya pagadas) — solo las duplicadas sin pagar (18, 50).

Stop Conditions:
- Si al confirmar el estado actual de OC 18 o OC 50 (justo antes de dar la instrucción final) alguna ya no está en "confirmada" sin pagos (alguien ya la pagó o cambió mientras tanto) — detener y reportar antes de proponer cancelarla.

Checkpoints:
✅ Confirmación de si existe mecanismo de UI para cancelar, con pasos exactos si aplica.
✅ Si no existe, script SQL preparado (no ejecutado), con verificación antes/después y estado real de OC 18/50 confirmado inmediatamente antes.
✅ Confirmación explícita de que OC 17, OC 49, y ambas OCs de la requisición #32 no fueron tocadas.

Estimado: ~15-20 min con Claude Code (Sonnet 5, esfuerzo Medio).
