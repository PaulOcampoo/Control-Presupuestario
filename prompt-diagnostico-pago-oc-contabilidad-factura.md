Objective:
Explicar con evidencia de código real qué pasa hoy cuando se registra el pago de una Orden de Compra: ¿ese pago se refleja automáticamente en el módulo de Contabilidad y/o Finanzas? ¿Existe algún mecanismo para vincular la factura real del proveedor (PDF/XML CFDI) contra ese pago, de forma que Paul pueda cuadrar su cierre de mes? Si no existe, confirmarlo explícitamente y proponer (sin implementar) qué haría falta.

Starting State:
- Módulo "Contabilidad" existe en el sistema con "5 fases" (mencionado en documentación del proyecto) — confirmar qué cubre cada fase realmente, con evidencia de código, no de memoria.
- Módulo "Finanzas" ya tiene lógica de Erogado Real (trabajada extensamente en sesiones anteriores) que sí incluye Órdenes de Compra pagadas en algunos cálculos — confirmar si el pago de una OC específica alimenta esas cifras agregadas, y si hay trazabilidad a nivel de OC individual o solo montos totales.
- Pregunta específica de Paul: con la factura real que le manda el proveedor (probablemente PDF o CFDI/XML), ¿hay algún lugar del sistema para adjuntarla/vincularla al pago de esa OC, de forma que sirva para su cierre contable mensual?

Target State:
1. RASTREAR EL FLUJO DE PAGO DE OC:
   - Confirmar qué tabla(s) se escriben cuando se "Registra un pago" de una OC (`pagos_oc` o equivalente) — campos disponibles (monto, fecha, método, referencia, ¿algún campo para adjuntar archivo de factura?).
   - Confirmar si existe upload de archivo (factura del proveedor) en el flujo de registrar pago, o en cualquier otro punto vinculado a la OC.

2. CONFIRMAR CONEXIÓN CON CONTABILIDAD:
   - Leer el código real del módulo Contabilidad (sus 5 fases) y confirmar explícitamente: ¿lee datos de `pagos_oc`/OC en algún punto? ¿Es automático, o requiere captura manual duplicada?
   - Si hay conexión, mostrar exactamente qué vista/reporte de Contabilidad refleja el pago de una OC específica.
   - Si NO hay conexión automática, decirlo sin rodeos — no inferir una integración que no existe en el código.

3. CONFIRMAR CONEXIÓN CON FINANZAS:
   - Confirmar si el pago de una OC específica es rastreable individualmente en algún reporte de Finanzas, o si solo se refleja como parte de un total agregado (Erogado Real) sin desglose por OC.

4. CONFIRMAR SI EXISTE CONCILIACIÓN DE FACTURA:
   - Buscar cualquier campo/tabla relacionado a "factura", "CFDI", "XML", o adjuntos de documento fiscal vinculados a pagos de OC.
   - Si no existe, confirmarlo explícitamente y describir qué tan grande sería agregar esa capacidad (campo de adjunto de factura por pago, como mínimo) — sin implementar, solo dimensionar.

5. RESPUESTA FINAL PARA PAUL:
   - Responder directamente su pregunta con lo confirmado: sí/no se refleja en Contabilidad, sí/no en Finanzas a nivel de OC individual, sí/no hay forma de adjuntar la factura del proveedor hoy.

Allowed Actions:
- Leer código relevante (`server/app.js`, cualquier archivo de Contabilidad/Finanzas/pagos_oc).
- SELECTs de solo lectura contra Preview si ayuda a confirmar con datos reales.

Forbidden Actions:
- NO modificar nada — esto es diagnóstico puro.
- NO tocar Producción.
- NO inferir ni asumir una integración que no esté confirmada literalmente en el código.

Checkpoints:
✅ Confirmación explícita (sí/no, con evidencia) de si el pago de OC se refleja en Contabilidad.
✅ Confirmación explícita de si es rastreable individualmente en Finanzas.
✅ Confirmación explícita de si existe mecanismo de adjuntar/vincular factura del proveedor.
✅ Si falta algo, dimensionar el esfuerzo de agregarlo (sin implementar).

Estimado: ~15-20 min con Claude Code (Sonnet 5, esfuerzo Medio).
