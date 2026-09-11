Objective:
Preparar (no ejecutar) el script para eliminar las estimaciones de prueba del proyecto "RED HIDRAULICA" (cliente Kalia) cuyo nombre empieza con "ELIMINAR" — confirmadas por Rodolfo Ocampo como datos de prueba a remover. Como son registros financieros, la eliminación debe ser soft-delete (marcar como eliminada/inactiva), nunca DELETE físico — regla dura ya establecida del proyecto, no una validación adicional a discutir.

Starting State:
- Proyecto: "RED HIDRAULICA" (confirmar project_id real en Preview y por separado en Producción — no asumir que coinciden).
- Estimaciones a eliminar, identificadas por nombre: "ELIMINAR-" (#7, Aprobada, $43,735.097), "ELIMINAR-2" (#4, Enviada, $55,448.513), "ELIMINAR-3" (#3, Aprobada, $50,203.369). También "Estimación #5" (Borrador, $0.00) si el botón "Eliminar" ya existente en la UI no la cubre ya.
- Confirmado por Rodolfo (admin): son de prueba, ya revisadas, se necesitan eliminar.

Target State:
1. Confirmar el esquema real de la tabla de estimaciones (nombre de tabla, columna de estado/activo usada para soft-delete, si ya existe un patrón como `activo=0` o un `estado='eliminada'`).
2. Localizar las estimaciones reales en Preview por nombre (`LIKE 'ELIMINAR%'`) en el proyecto "RED HIDRAULICA" — confirmar que son exactamente las 3-4 descritas (folio/monto coinciden).
3. Preparar script SQL de soft-delete: `UPDATE` que marca esas filas como eliminadas/inactivas (usando el mecanismo real ya confirmado en el paso 1), con SELECT de verificación antes y después, dentro de `BEGIN`/`COMMIT` comentado — mismo patrón usado en toda la sesión.
4. Confirmar si hay datos vinculados a estas estimaciones (pagos, avance referenciado) que el soft-delete deba preservar/considerar — reportarlo, no bloquear la acción por esto ya que Rodolfo confirmó que son de prueba, solo informar qué más se ve afectado.
5. Ejecutar el script contra Preview para validarlo ahí.
6. Preparar la versión equivalente para Producción (mismo patrón: buscar la obra por nombre, nunca asumir que el project_id coincide con Preview) — NO ejecutar contra Producción, eso lo hace Paul.

Allowed Actions:
- Leer schema real de estimaciones.
- SELECTs de solo lectura y el UPDATE de soft-delete contra Preview (ejecutar ahí para validar).
- Preparar (no ejecutar) el script equivalente para Producción.

Forbidden Actions:
- NO hacer DELETE físico de ninguna fila — solo soft-delete.
- NO ejecutar nada contra Producción — solo preparar el script.

Checkpoints:
✅ Mecanismo de soft-delete confirmado con evidencia de esquema real.
✅ Las estimaciones correctas identificadas en Preview (folio/monto coinciden con lo descrito).
✅ Script ejecutado y verificado en Preview (antes/después).
✅ Script para Producción preparado (busca la obra por nombre, no por id hardcodeado), NO ejecutado.

Estimado: ~15-20 min con Claude Code (Sonnet 5, esfuerzo Medio).
