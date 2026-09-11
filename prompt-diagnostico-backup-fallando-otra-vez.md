Objective:
Diagnosticar por qué el workflow "Backup diario de Neon a Vercel Blob" ha fallado 4 días seguidos (notificaciones in-app confirman 3+ fallos recientes) — mismo mecanismo que ya falló una vez antes en la sesión por el secret `NEON_PRODUCTION_DATABASE_URL_DIRECT` desactualizado (PR #204/incidente de 17 días sin backup). Confirmar si es la misma causa u otra distinta.

Starting State:
- Sistema de backup diario + alerta ya implementado (PR #204) y validado en su momento con un ciclo limpio tras corregir el secret.
- Notificaciones in-app confirman fallos recurrentes en los últimos 4 días — la alerta SÍ está funcionando esta vez (a diferencia del incidente anterior donde la alerta también fallaba en silencio).
- Posible causa recurrente: connection string de Neon Producción rotada/expirada de nuevo, o algo distinto (límite de Vercel Blob, cambio en el workflow, etc.) — no asumir, confirmar con evidencia real.

Target State:
1. Revisar los logs reales de GitHub Actions de los últimos 4-5 runs del workflow "Backup diario de Neon a Vercel Blob" — identificar el mensaje de error exacto de cada uno (¿es el mismo error cada vez, o distintos?).
2. Si es el mismo tipo de error que la vez pasada (autenticación a Neon): confirmar si el secret `NEON_PRODUCTION_DATABASE_URL_DIRECT` necesita actualizarse de nuevo — Neon puede rotar la contraseña automáticamente en ciertos casos, o alguien pudo resetearla manualmente sin actualizar el secret.
3. Si es un error distinto: identificarlo con evidencia (cuota de Vercel Blob alcanzada, cambio en runner de GitHub Actions, versión de `postgresql-client` que dejó de estar disponible, etc.).
4. Confirmar cuántos días reales lleva sin backup válido — cuál fue el último backup exitoso antes de la racha de fallos.
5. Proponer el fix (actualizar secret, ajustar workflow, etc.) — si es actualizar el secret, seguir el mismo protocolo de la vez pasada (Paul lo actualiza él mismo en GitHub, Claude Code nunca ve el valor real).

Allowed Actions:
- Leer logs de GitHub Actions vía `gh run list`/`gh run view` para el workflow de backup.
- Leer el código del workflow y del script de backup, sin modificarlo todavía.

Forbidden Actions:
- NO modificar el workflow ni el script todavía — esto es diagnóstico.
- NO intentar leer o exponer el valor del secret `NEON_PRODUCTION_DATABASE_URL_DIRECT`.
- NO tocar Producción.

Checkpoints:
✅ Mensaje de error exacto de los últimos 4-5 runs fallidos, con evidencia literal de los logs.
✅ Causa raíz confirmada — misma que la vez pasada (secret) u otra distinta.
✅ Confirmación de cuántos días reales sin backup válido.
✅ Pasos claros para que Paul resuelva (actualizar secret u otra acción), sin que Claude Code ejecute nada contra Producción.

Estimado: ~10-15 min con Claude Code (Sonnet 5, esfuerzo Medio).
