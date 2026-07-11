# CLAUDE.md — Notas para el asistente de IA

## 2FA (TOTP): opcional-con-recordatorio, no obligatorio (desde julio 2026)

El enrollment obligatorio de 2FA (cerrado en la auditoría de seguridad de julio 2026)
se relajó a **opcional** por decisión de negocio: se priorizó simplicidad de acceso
para el equipo mientras se evalúa si vale la pena forzar 2FA para todos los roles.

- Un usuario sin TOTP inscrito ya NO se bloquea en el login — entra directo.
- En la pantalla de Inicio se le muestra un banner no intrusivo (dismissible)
  invitándolo a configurarlo, que solo reaparece si pasaron 3+ días desde la
  última vez que se le mostró (`usuarios.totp_reminder_last_shown_at`).
- Usuarios YA inscritos en TOTP no se ven afectados: login sigue pidiendo el
  segundo factor exactamente igual que antes.
- Toda la infraestructura de TOTP (QR/enrollment, backup codes, reset por
  admin, script de emergencia `scripts/emergency-totp-reset.js`) sigue intacta
  y funcional — solo cambió si es obligatorio o no. El enrollment ahora se
  dispara solo a pedido del usuario (`POST /api/auth/totp/enroll-start`, ya
  autenticado), no automáticamente en cada login.

## Regla: SW_VERSION se bumpea en todo commit con cambios de código

En **todo** commit que incluya cambios de código (frontend o backend, sin excepciones),
incrementar `SW_VERSION` en `public/sw.js` (`ctrl-ppto-vN` → `ctrl-ppto-v(N+1)`).

Se evaluó la propuesta de omitir el bump en commits backend-only y fue **rechazada**.
La regla no tiene excepciones.
