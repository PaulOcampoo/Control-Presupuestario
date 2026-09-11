Objective:
Permitir que un operador edite o borre su propio reporte de horas de maquinaria, únicamente mientras esté en estado `pendiente` — resuelve el bug real detrás del reporte original de Alfredo ("no me deja borrar al corregir"), que resultó no ser un problema de dispositivo/UI sino la ausencia total de esta funcionalidad.

Starting State:
- `createHoras` inserta reportes con `estado='pendiente'` fijo.
- `updateEstadoHoras` (`PUT /api/maquinaria/horas/:id/estado`) transiciona `pendiente → autorizado/rechazado`, atómico vía `WHERE estado='pendiente'` — una vez revisado, el registro queda fijo. Gateado a `checkPermiso('maquinaria_captura','puede_editar')`, pensado para `cabo`.
- `DELETE /api/maquinaria/horas/:id` ya existe pero es una herramienta administrativa (`checkPermiso('maquinaria','puede_eliminar')`, soft-delete), sin verificación de dueño — NO debe reusarse para este caso, es un candado distinto.
- Ningún otro módulo (nómina, costos, exports) consume esta tabla hoy — confirmado, bajo riesgo de romper algo aguas abajo.

Target State:
1. Nuevo endpoint `PUT /api/maquinaria/horas/:id` (editar reporte propio): acepta cambios a fecha/horas/actividad(es)/obra. Condición atómica en el UPDATE: `WHERE id=:id AND operador_id=:req.user.id AND estado='pendiente'` — si no afecta ninguna fila, responder 404 o 403 según corresponda (distinguir "no es tuyo" de "ya no está pendiente" en el mensaje, para que el frontend pueda mostrar algo útil).
2. Nuevo endpoint `DELETE /api/maquinaria/horas/:id/propio` (o el nombre que no colisione con el DELETE administrativo existente): mismo candado — `operador_id=:req.user.id AND estado='pendiente'`, soft-delete (`activo=false`), nunca físico.
3. Ambos endpoints exclusivos para el rol `operador` sobre sus propios registros — no para `cabo`/`admin` (ellos ya tienen su propio flujo de revisión/administración).
4. Frontend: en "Mis reportes" (vista de operador), mostrar botones Editar/Borrar solo en filas con `estado='pendiente'` que pertenezcan al usuario actual — ocultos para `autorizado`/`rechazado`.
5. Confirmaciones vía `confirmDialog()` (componente ya usado en el resto de la app) para el borrado — no `confirm()` nativo.

Allowed Actions:
- Modificar server/maquinaria.js, server/app.js (nuevos endpoints).
- Modificar public/app.js (botones Editar/Borrar condicionados a estado+dueño).
- Bumpear SW_VERSION (usando max(git log --all) + 1, no "el siguiente número", por el problema de colisión ya visto en esta sesión).
- Agregar tests: edición exitosa en pendiente, rechazo si ya no está pendiente (403/404), rechazo si el reporte es de otro operador, borrado exitoso en pendiente (soft-delete real), rechazo del DELETE administrativo existente sin cambios de comportamiento (regresión).

Forbidden Actions:
- NO reusar el DELETE administrativo existente para este flujo — son candados distintos.
- NO permitir edición/borrado fuera de estado `pendiente`.
- NO permitir que `cabo`/`admin` usen estos nuevos endpoints como atajo — siguen usando su propio flujo de autorizar/rechazar.
- NO hacer borrado físico — solo soft-delete.
- NO usar `confirm()` nativo.

Checkpoints:
✅ Test de edición exitosa en pendiente, y rechazo en autorizado/rechazado/ajeno, con evidencia literal.
✅ Test de borrado exitoso (soft-delete verificado con query directa) y los mismos rechazos.
✅ Test de regresión confirmando que el DELETE administrativo existente sigue funcionando igual para admin/cabo.
✅ SW_VERSION bumpeado con el criterio correcto.
✅ Verificación visual tuya en dispositivo real: como operador, editar un reporte pendiente propio, confirmar que no puede tocar uno ya autorizado, y borrar uno pendiente.
✅ Limpieza de datos de prueba verificada.

Estimado de ejecución (Claude Code + Sonnet 5, esfuerzo Medio): 2–2.5 horas.
