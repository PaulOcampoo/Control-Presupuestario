Objective:
Agregar la posibilidad de responder a una sugerencia con un mensaje (exclusivo para rol `desarrollador` + la cuenta específica de Rodolfo Ocampo Hernandez, excepción hardcodeada por usuario), que le llegue como notificación al autor original — para casos donde la sugerencia es confusa, errónea, o no se puede implementar. Además, notificación automática de agradecimiento al autor cuando su sugerencia pasa a "Implementada" o "Descartada".

Starting State:
- Sistema de notificaciones ya existe (`server/notificaciones.js`, tabla `notificaciones`, tipo `sugerencia_nueva` ya implementado para avisar a admin/desarrollador de sugerencias nuevas) — reusar el mismo mecanismo, no construir uno paralelo.
- Tabla `sugerencias` (id, usuario_id, texto, estado, prompt_generado, creado_en, actualizado_en) — sin campo de respuesta/mensaje.
- Endpoint `PATCH /api/sugerencias/:id` ya cambia `estado` (pendiente/revisada/implementada/descartada).
- Decisiones confirmadas por Paul: (1) la excepción de "quién puede responder" es específicamente `desarrollador` + la cuenta de Rodolfo por usuario exacto (no todo `admin`) — identificar el `usuario` exacto de su cuenta en el schema antes de hardcodear el check. (2) la notificación automática de agradecimiento se manda tanto en `implementada` como en `descartada`.

Target State:

1. SCHEMA (server/db.js):
   - Nueva tabla `sugerencias_respuestas`: id, sugerencia_id (FK sugerencias, NOT NULL), autor_usuario_id (FK usuarios, NOT NULL), mensaje (TEXT NOT NULL), creado_en.

2. BACKEND:
   - Nuevo endpoint `POST /api/sugerencias/:id/responder`: acepta `{ mensaje }`. Gateado a `puesto === 'desarrollador' OR usuario === '<usuario exacto de Rodolfo>'` (confirmar el valor exacto en `usuarios` antes de hardcodearlo — documentarlo en un comentario explícito, mismo criterio que otras excepciones hardcodeadas ya documentadas en el proyecto). Inserta la fila en `sugerencias_respuestas` y crea una notificación tipo `sugerencia_respuesta` para el `usuario_id` autor de la sugerencia, con el mensaje (o un extracto) — mismo patrón de `crearNotificacion()` ya usado.
   - `PATCH /api/sugerencias/:id` (ya existente): cuando el nuevo `estado` sea `implementada` o `descartada`, además de la actualización actual, crear automáticamente una notificación tipo `sugerencia_resuelta` para el autor con texto fijo agradeciendo — distinto según el caso ("¡Gracias por tu sugerencia! Ya fue implementada." vs. "Gracias por tu sugerencia. Esta vez no fue posible implementarla."). Esto es independiente de si también se mandó un mensaje manual vía `/responder` — pueden coexistir ambas notificaciones.
   - Endpoint de lectura de respuestas de una sugerencia (para mostrar el hilo en el panel admin y, si aplica, en la vista del propio autor).

3. FRONTEND (public/app.js):
   - Botón "Responder" en cada tarjeta de sugerencia del panel admin — visible solo para `desarrollador` o la cuenta de Rodolfo (mismo criterio que el backend, doble candado). Abre un modal simple con textarea + enviar.
   - Mostrar el hilo de respuestas (si existen) debajo del texto de la sugerencia en el panel admin.
   - Vista del autor: al hacer clic en una notificación `sugerencia_respuesta` o `sugerencia_resuelta`, llevarlo a un lugar donde pueda leer el mensaje completo — confirmar si la vista de Sugerencias del usuario normal ya muestra sus propias sugerencias con algún detalle, o si hay que agregar esa vista mínima.
   - Confirmaciones vía `confirmDialog()` si aplica alguna acción destructiva — no `confirm()` nativo.

Allowed Actions:
- Modificar server/db.js (schema), server/app.js (endpoints), server/notificaciones.js (nuevos tipos si aplica).
- Modificar public/app.js/public/styles.css.
- Bumpear SW_VERSION (usando max(git log --all) + 1).
- Agregar tests: responder gateado correctamente (403 para roles/usuarios no autorizados, 200 para desarrollador y para la cuenta de Rodolfo específicamente), notificación de respuesta creada correctamente, notificación automática de agradecimiento al cambiar a implementada/descartada (con el texto correcto según el caso), que NO se dispare para transiciones a pendiente/revisada.

Forbidden Actions:
- NO abrir la capacidad de responder a ningún otro admin que no sea la cuenta específica de Rodolfo — ni siquiera otros usuarios con puesto `admin`.
- NO duplicar el mecanismo de notificaciones — reusar `crearNotificacion()`/la tabla existente.
- NO usar `<select>` ni `confirm()` nativos.

Checkpoints:
✅ Migración aplicada en Preview — output literal de la tabla nueva.
✅ Test de 403 para un admin cualquiera (no Rodolfo) intentando responder, y 200 para desarrollador y para Rodolfo específicamente.
✅ Test de notificación de agradecimiento disparada en implementada y en descartada, con el texto correcto en cada caso, y confirmación de que NO se dispara en pendiente/revisada.
✅ SW_VERSION bumpeado correctamente.
✅ Verificación visual tuya en dispositivo real: responder una sugerencia de prueba con la cuenta de Rodolfo, confirmar que el autor recibe la notificación, marcar otra sugerencia como implementada y confirmar la notificación automática de agradecimiento.
✅ Limpieza de datos de prueba verificada.

Estimado de ejecución (Claude Code + Sonnet 5, esfuerzo Medio): 3–4 horas.
