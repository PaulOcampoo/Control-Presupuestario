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

## Patrón conocido: `position: sticky` + `overflow` en iOS Safari

iOS Safari rompe `position: sticky` en cualquier elemento cuyo ancestro —
directo o intermedio, entre el elemento sticky y su scroll container
pretendido — tenga una propiedad `overflow` (`auto`, `hidden` o `clip`) que
no sea el propio scroll container. Cada ancestro con `overflow` distinto de
`visible` crea un nuevo containing block; si ese ancestro no es el
contenedor de scroll que el elemento sticky espera, el sticky deja de
funcionar de forma silenciosa (sin error, sin warning).

Dos incidentes reales en este proyecto, mismo patrón raíz:

1. **Sticky vertical roto** (commit `bf3f437`): `.main-area` combinaba
   `display: flex` + `overflow-y: auto` en el mismo contenedor que envolvía
   elementos sticky. Fix: aislar el scroll vertical envolviendo
   `<main id="view">` en un wrapper dedicado, `<div class="main-scroll">`,
   dejando `.main-area` sin `overflow` propio.
2. **Sticky horizontal roto** (columna `TRABAJADOR` en la tabla de
   asistencia, commit `eafbd6c` y siguientes): el wrapper `.main-scroll`
   introducido en el fix anterior después ganó `overflow-x: clip` (probable
   intento de evitar rebote horizontal de página en iOS, redundante con el
   `overflow-x: clip` que ya tenía `body`). Ese `overflow-x: clip` en
   `.main-scroll` quedaba *entre* la columna sticky (`.asist-th-trab` /
   `.asist-td-trab`, dentro de `table.asist-grid-table`) y su scroll
   container horizontal real (`.asist-grid-scroll`), rompiendo el sticky.
   Fix: eliminar `overflow-x: clip` de `.main-scroll`
   (`public/styles.css`, dentro de `@media (max-width: 860px)`) — `body`
   ya cubre el mismo propósito por sí solo, más arriba en la cadena de
   ancestros.

**Regla práctica para nuevo código:** ningún contenedor entre un elemento
`position: sticky` y su scroll container pretendido debe tener `overflow`
propio (ni `auto`, ni `hidden`, ni `clip`) salvo que ese contenedor *sea*
el scroll container. Si aparece un bug de sticky que "no se ve" o queda
"detrás" de otros elementos en iOS Safari, diagnosticar primero la cadena
de ancestros (`overflow` + `position` de cada uno) antes de asumir que es
un problema de `z-index`.

## Regla: SW_VERSION se bumpea en todo commit con cambios de código

En **todo** commit que incluya cambios de código (frontend o backend, sin excepciones),
incrementar `SW_VERSION` en `public/sw.js` (`ctrl-ppto-vN` → `ctrl-ppto-v(N+1)`).

Se evaluó la propuesta de omitir el bump en commits backend-only y fue **rechazada**.
La regla no tiene excepciones.
