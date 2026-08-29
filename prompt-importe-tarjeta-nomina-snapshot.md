Objective:
Reemplazar el reparto de pago por porcentaje (`split_cuenta_nomina_pct`) por un importe fijo en pesos capturado en el expediente del trabajador (`importe_tarjeta_nomina`), con **snapshot permanente** del importe realmente usado en cada corrida de nómina — para que una corrección futura al expediente del trabajador nunca altere la cifra de una nómina ya calculada/timbrada. Basado en el diagnóstico ya realizado y aprobado — no repetir ese diagnóstico, implementar directamente lo ya decidido. Motivo del cliente: el timbrado de nómina ante el IMSS requiere una cifra exacta e inmutable, no un porcentaje recalculado en vivo.

Starting State:
- `trabajadores.split_cuenta_nomina_pct` (0-100, default 100) — porcentaje fijo por trabajador, usado por `calcularSplitCuentas()` (server/calculos.js) para repartir `monto_total` entre cuenta_nomina/cuenta_alterna, calculado EN LECTURA (sin snapshot) desde `adjuntarDesgloseCuentas()` (server/app.js), consumido por el detalle de nómina (`GET .../nominas/:nomId`) y el export de dispersión bancaria (`GET .../nominas/:nomId/export`).
- Exactamente 2 cuentas posibles por trabajador (nómina + alterna), nunca más — confirmado.
- Solo 2 trabajadores en Preview tienen split activo hoy (Javier Pineda Flores #39, Pedro Perez #88, ambos 70%) — no hay forma de derivar automáticamente su importe fijo equivalente, requiere que Paul lo defina manualmente.
- Decisiones confirmadas por Paul: (1) snapshot permanente por corrida, (2) si el importe capturado excede el `monto_total` de una corrida específica, bloquear con error explícito (nunca truncar ni permitir negativo).
- Limitación conocida y aceptada: nóminas YA aprobadas antes de este cambio no tienen snapshot — no hay dato histórico de qué porcentaje/importe estaba vigente cuando se aprobaron, así que no se pueden corregir retroactivamente. Este prompt no intenta resolver eso, solo evita que el problema siga ocurriendo hacia adelante.

Target State:

1. SCHEMA (server/db.js):
   - `trabajadores.importe_tarjeta_nomina` NUMERIC nullable (ALTER TABLE ADD COLUMN IF NOT EXISTS) — coexiste con `split_cuenta_nomina_pct`, no lo reemplaza todavía.
   - `nomina_items.importe_tarjeta_nomina_snapshot` NUMERIC nullable, `nomina_items.importe_cuenta_alterna_snapshot` NUMERIC nullable — capturan el desglose real usado en esa corrida específica.

2. BACKEND — cálculo y snapshot:
   - En el punto donde se calcula `monto_total` por trabajador dentro de una nómina (mismo momento que ya fija otros valores del item), calcular también el desglose:
     - Si `trabajadores.importe_tarjeta_nomina` está capturado (no NULL): usarlo como monto fijo para la cuenta de nómina. Si excede `monto_total` de esa corrida, RECHAZAR el cálculo con un error explícito y claro (ej. "El importe de tarjeta nómina de [trabajador] ($X) excede su monto total de esta corrida ($Y)") — no continuar el cálculo de esa nómina hasta que se resuelva.
     - Si `importe_tarjeta_nomina` es NULL: caer al comportamiento actual (`split_cuenta_nomina_pct`), igual que hoy — sin cambios para los 41 trabajadores que usan el default.
     - Guardar el resultado (tarjeta nómina + alterna) en `nomina_items.importe_tarjeta_nomina_snapshot`/`importe_cuenta_alterna_snapshot`.
   - `adjuntarDesgloseCuentas()`: cambiar de "calcular en lectura desde `trabajadores`" a "leer el snapshot ya guardado en `nomina_items`" para cualquier nómina que ya tenga snapshot poblado. Si el snapshot es NULL (nómina calculada antes de este cambio), caer al comportamiento actual de cálculo en vivo — para no romper la visualización de nóminas históricas ya existentes.
   - Endpoint de edición de trabajador: agregar `importe_tarjeta_nomina` al modal/payload existente, mismo gateo de permisos (`trabajadores_bancarios`) que ya tiene `split_cuenta_nomina_pct`.

3. FRONTEND (public/app.js):
   - En el modal de expediente de trabajador: agregar el campo "Importe tarjeta nómina" junto al de porcentaje existente — mientras coexistan, dejar claro en la UI cuál tiene prioridad si ambos están capturados (el importe fijo gana, según el diseño del backend).
   - Mostrar el error de "excede el monto total" de forma clara si el cálculo de una nómina lo rechaza — no un error genérico.
   - El desglose en el detalle/export de nómina no cambia visualmente, solo la fuente del dato (snapshot vs. cálculo en vivo, transparente para el usuario).

4. MIGRACIÓN de los 2 casos reales (Javier Pineda #39, Pedro Perez #88):
   - NO auto-migrar — quedan en modo porcentaje hasta que Paul defina manualmente su importe fijo en pesos. Documentar esto como acción pendiente de Paul, no del código.

Allowed Actions:
- Modificar server/db.js (schema), server/calculos.js (cálculo + snapshot), server/app.js (endpoint de trabajador, adjuntarDesgloseCuentas).
- Modificar public/app.js para el campo nuevo y el manejo de error.
- Bumpear SW_VERSION (usando max(git log --all) + 1).
- Agregar tests: cálculo con importe fijo (snapshot correcto), cálculo con importe que excede el total (rechazo con error explícito, nómina no se calcula), cálculo con trabajador sin importe fijo (comportamiento actual sin cambios), lectura de nómina con snapshot ya poblado (no debe recalcular en vivo aunque cambie el trabajador después), lectura de nómina histórica sin snapshot (cae a cálculo en vivo, comportamiento actual).

Forbidden Actions:
- NO eliminar `split_cuenta_nomina_pct` ni su comportamiento actual — coexiste.
- NO intentar rellenar snapshot retroactivo para nóminas ya aprobadas antes de este cambio — limitación aceptada, no forzar una solución.
- NO auto-migrar a Javier Pineda ni Pedro Perez con un importe inventado — la decisión es de Paul.
- NO truncar ni permitir diferencia negativa si el importe excede el total — bloquear con error, según lo decidido.

Stop Conditions:
- Si el punto exacto donde se calcula `monto_total` por trabajador resulta estar en más de un lugar (ej. cálculo inicial vs. recálculo al editar), pausar y confirmar en cuál(es) debe aplicar el snapshot antes de escribir código.

Checkpoints:
✅ Migración aplicada en Preview — output literal de las 3 columnas nuevas.
✅ Test de cálculo con importe fijo, verificando snapshot correcto en `nomina_items`.
✅ Test de rechazo cuando el importe excede el total, con mensaje de error verificado.
✅ Test de que una nómina con snapshot ya poblado no cambia su desglose aunque se modifique el trabajador después.
✅ Test de que nóminas históricas sin snapshot siguen mostrando el cálculo en vivo (regresión, sin cambios).
✅ SW_VERSION bumpeado correctamente.
✅ Verificación visual tuya en dispositivo real: capturar un importe fijo en un trabajador de prueba, calcular una nómina, confirmar el desglose correcto, y confirmar que cambiar el importe del trabajador después NO altera esa nómina ya calculada.
✅ Limpieza de datos de prueba verificada.

Estimado de ejecución (Claude Code + Sonnet 5, esfuerzo Medio): 3.5–5 horas.
