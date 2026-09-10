Objective:
Diagnóstico de solo lectura: identificar qué botón/endpoint genera el Excel de la captura (columnas Código/Concepto/Grupo/Unidad/Cantidad/Precio unitario/Importe + Avance Estimado [Cantidad/Importe] + Por Estimar [Cantidad/Importe]), confirmar si existe una vista en pantalla equivalente (no solo export), y por qué las columnas "Avance Estimado" y "Por Estimar" salen vacías para la obra de la captura.

Starting State:
- Paul confirma que la captura es un export ya existente de la app, con las columnas de Avance Estimado y Por Estimar vacías.
- Existe una suite de tests `estimaciones-*` (ej. `tests/estimaciones-residente-ve-otras.test.js`) que sugiere un módulo "Estimaciones" ya construido, no documentado en `APP-CP-REFERENCIA.md`.
- Módulo "Presupuestos" (Excel) y módulo "Avance" (captura semanal por concepto) ya existen — posible relación con Estimaciones.

Target State (solo investigación, reportar hallazgos):

1. LOCALIZAR EL EXPORT:
   - Buscar en el código (`server/exportHelper.js` u otro) la función que genera exactamente estas columnas. Confirmar el endpoint y desde qué botón/pantalla del frontend se dispara.

2. MÓDULO ESTIMACIONES:
   - Buscar en el código y schema (`server/db.js`) cualquier tabla/endpoint relacionado con "estimaciones" (ej. `estimaciones`, `estimacion_conceptos`). Documentar su propósito, campos, y con qué rol interactúa (el nombre del test sugiere que "residente" captura y hay lógica de qué obras/estimaciones puede ver).
   - Confirmar si existe una vista en pantalla (no solo el export) donde se pueda consultar Presupuesto / Avance Estimado / Por Estimar por concepto, y en qué menú/tab vive.

3. POR QUÉ SALEN VACÍAS LAS COLUMNAS:
   - Para la obra de la captura: confirmar si hay datos de estimaciones capturados y el cálculo simplemente da 0 (avance real en 0%), o si no hay ninguna fila de estimaciones para esa obra (dato no capturado), o si el cálculo tiene un bug que no está leyendo datos que sí existen.

4. RELACIÓN CON CORTE DE OBRA:
   - Confirmar si el módulo Estimaciones tiene alguna relación o solapamiento con Corte de Obra (v2, recién mergeado) — mismo dato distinto ángulo, o completamente independiente.

Allowed Actions:
- Solo lectura: código, base de datos.

Forbidden Actions:
- NO modificar código ni datos.

Stop Conditions:
- Ninguna — reportar hallazgos y esperar instrucción.

Checkpoints:
✅ Endpoint/función exacta que genera el export de la captura, y desde qué botón se dispara.
✅ Documentación de qué es el módulo Estimaciones: tablas, campos, flujo, roles.
✅ Confirmación de si existe vista en pantalla equivalente, y dónde.
✅ Causa exacta de por qué Avance Estimado/Por Estimar salen vacías en la obra de la captura, con query real.
✅ Relación (si la hay) entre Estimaciones y Corte de Obra.

Estimado: esfuerzo Bajo — Claude Code + Sonnet 5, ~30 min.
