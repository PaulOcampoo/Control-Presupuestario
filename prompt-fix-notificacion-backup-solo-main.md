Objective:
Corregir el workflow "Backup diario de Neon a Vercel Blob" para que el step de notificación in-app de fallo (`notificar-fallo-backup.js`) solo escriba notificaciones cuando el run es del cron real en `main` — no cuando alguien dispara `workflow_dispatch` manualmente desde una branch de desarrollo para pruebas. Motivado por un incidente real: una prueba manual en `feat/backup-diario` (2026-09-02) insertó notificaciones de "fallo de backup" visibles para los 6 usuarios admin/desarrollador reales, aunque nunca fue un fallo del backup de producción.

Starting State (confirmado con evidencia real):
- El secret `NEON_PRODUCTION_DATABASE_URL_DIRECT` es a nivel de repo, no restringido a `main` — cualquier branch que dispare el workflow (incluyendo `workflow_dispatch` manual) tiene el mismo acceso y escribe en la misma base de datos de notificaciones de Producción.
- No existe mecanismo de "marcar como resuelta" para estas notificaciones — quedan visibles indefinidamente hasta que alguien las descarte manualmente.
- El step de notificación corre `if: failure()` sin distinguir el origen del run (cron programado vs. disparo manual de prueba).

Target State:
1. Modificar el workflow para que el step de notificación solo se ejecute cuando `github.event_name == 'schedule'` (el trigger real del cron) Y `github.ref == 'refs/heads/main'` — un `workflow_dispatch` manual, sin importar la branch, nunca debe escribir notificaciones de producción.
2. Para runs manuales (`workflow_dispatch`), el fallo debe seguir siendo visible en el log de GitHub Actions (ya lo es) — solo se suprime la notificación in-app dirigida a usuarios reales.
3. Confirmar que esto no rompe la capacidad de probar el workflow completo manualmente durante desarrollo — el resto del workflow (backup, rotación) debe seguir corriendo igual en `workflow_dispatch`, solo el paso de notificación se condiciona.

Allowed Actions:
- Modificar `.github/workflows/backup-neon.yml`.
- Probar el cambio con un `workflow_dispatch` de prueba (debe confirmar que la notificación NO se dispara esta vez, a diferencia del incidente anterior).

Forbidden Actions:
- NO modificar la lógica de backup/rotación en sí — solo la condición del step de notificación.
- NO tocar Producción salvo por la prueba de verificación del propio workflow (que ya es de solo backup, no escritura destructiva).

Checkpoints:
✅ Condición agregada al step de notificación (`schedule` + `main` únicamente).
✅ Prueba real vía `workflow_dispatch` confirma que NO se genera notificación esta vez.
✅ Cron real (verificar en el próximo run programado, o confirmar con evidencia de código que la condición es correcta) sigue notificando normalmente si de verdad falla.

Estimado: ~10-15 min con Claude Code (Sonnet 5, esfuerzo Bajo).
