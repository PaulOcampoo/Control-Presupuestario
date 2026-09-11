Objective:
Agregar notificación visible para admin/desarrollador cuando un usuario envía una nueva Sugerencia — hoy no hay ninguna señal, Paul solo se entera si entra manualmente al módulo.

Starting State (diagnóstico primero, antes de codificar):
- Ubicar el mecanismo de notificaciones/alertas ya existente en la app (hay un ícono de campana con contador visible en la navegación — confirmar en qué tabla/endpoint vive, cómo se marcan como leídas, y qué otros módulos ya lo usan, ej. alertas de vencimiento de contrato, banners de TOTP/novedades).
- Confirmar si ese mecanismo ya es genérico (una tabla de alertas con tipo/referencia) o está hardcodeado por módulo — esto decide si Sugerencias puede sumarse como un tipo más o si hace falta adaptar algo.
- Revisar el endpoint de creación de Sugerencias (dónde se inserta una sugerencia nueva hoy).

Target State:
1. Al crear una sugerencia nueva, generar una alerta/notificación visible para todos los usuarios con rol admin/desarrollador — reusando la tabla/mecanismo ya existente si es genérico, sin construir un sistema paralelo.
2. La notificación debe incluir lo mínimo para reconocerla sin abrir nada: quién la mandó y un extracto corto del texto.
3. Al hacer clic/tap en la notificación, llevar directo al módulo Sugerencias (o a esa sugerencia específica si el detalle lo permite).
4. Marcar como leída con el mismo mecanismo que ya usan las demás alertas del sistema (no inventar un estado de lectura nuevo).

Allowed Actions:
- Modificar el endpoint de creación de Sugerencias para que además inserte la alerta.
- Reusar/extender la tabla de alertas existente si es genérica.
- Modificar public/app.js para que la campana/lista de alertas reconozca este tipo nuevo y enlace correctamente.
- Bumpear SW_VERSION.

Forbidden Actions:
- NO construir un sistema de notificaciones nuevo si ya existe uno genérico reusable — usar evidencia del diagnóstico, no adivinar.
- NO notificar a roles distintos de admin/desarrollador.

Stop Conditions:
- Si el mecanismo de alertas existente resulta estar fuertemente acoplado a un solo módulo (no genérico) y adaptarlo implica un refactor mayor, pausar y reportar el alcance real antes de proceder.

Checkpoints:
✅ Diagnóstico del mecanismo de alertas existente, documentado.
✅ Prueba: crear una sugerencia de prueba y confirmar que aparece la notificación para un usuario admin, con conteo actualizado en la campana.
✅ Prueba: clic en la notificación lleva a Sugerencias correctamente.
✅ SW_VERSION bumpeado.
✅ Verificación visual tuya en dispositivo real.
✅ Limpieza de datos de prueba verificada.

Estimado de ejecución (Claude Code + Sonnet 5, esfuerzo Medio): 1.5–2.5 horas.
