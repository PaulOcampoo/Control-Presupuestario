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

## Toda sección nueva de `permisos_usuario` se registra en 5 lugares, no 4

Confirmado con un bug real (prompt-13-fix-permisos-operador.md, PRs #90 y
#92): agregar una sección nueva al catálogo de permisos granulares
(`permisos_usuario.seccion`) requiere tocar **cinco** puntos, no cuatro.
`estado_unidad` y `maquinaria_consumibles` se dieron de alta correctamente
en los primeros cuatro, pero el quinto (la matriz de administración en
`public/app.js`) se quedó fuera — resultado: el permiso se guardaba y se
exigía de verdad en el backend (`checkPermiso` devolvía `403` correctamente
si se revocaba por API), pero **Paul no podía verlo ni tocarlo desde la
UI** para ningún rol (operador, cabo, jefe_maquinaria) — la fila
simplemente nunca se pintaba en la matriz.

Checklist completo para dar de alta una sección nueva:

1. `SECCIONES_PERMISOS` en `server/auth.js` (catálogo backend).
2. CHECK constraint del `CREATE TABLE permisos_usuario` en `server/db.js`.
3. CHECK constraint del `ALTER TABLE ... ADD CONSTRAINT` en `server/db.js`
   (bases ya existentes en Preview/producción — el `CREATE TABLE` no vuelve
   a correr sobre una tabla que ya existe).
4. Allow-lists hardcodeadas de bootstrap (`/api/bienvenida`, `/api/clientes`,
   `/api/projects`) si la sección necesita que el rol cargue la app.
5. **`public/app.js`: `PERMISOS_SECCION_LABELS`, el grupo correspondiente en
   `PERMISOS_GRUPOS`, y `SECCIONES_CON_ENFORCEMENT`** (si la sección tiene
   `checkPermiso` real aplicado en algún endpoint) — sin esto la fila no
   aparece en la matriz de administración, aunque el resto de la cadena
   (guardado + enforcement) funcione perfecto. Fácil de pasar por alto
   porque no truena nada — el síntoma es "otorgo el permiso y no se
   refleja", indistinguible a simple vista de un bug real de guardado.

## Backup diario de Neon a Vercel Blob

Además del point-in-time recovery de corto plazo que Neon ya da por defecto,
existe un backup lógico diario (`pg_dump`) hacia Vercel Blob, para tener una
copia fuera del proveedor ante pérdida de datos, branch borrada, o problema
en la cuenta de Neon. Cadencia diaria (antes semanal, ver
`prompt-ajuste-backup-diario.md`) porque con los módulos financieros activos
(Control de Cuentas, Control Financiero) una ventana de pérdida de una
semana completa ya no es aceptable.

- **Mecanismo**: `.github/workflows/backup-neon.yml`, corre en GitHub
  Actions (no en Vercel Cron — `pg_dump` no está disponible en el runtime
  serverless de Vercel; ver comentario en el propio workflow). Todos los
  días 09:00 UTC, o manualmente desde la pestaña **Actions** del repo
  (`workflow_dispatch`).
- **Dónde viven los backups**: Vercel Blob, prefijo `backups/`, nombre
  `backups/backup-YYYY-MM-DD.sql.gz` (`access: private` — no son públicos).
  Mismo store que ya usa la app para PDFs de contrato — administrable desde
  el mismo dashboard de Vercel (Storage → Blob).
- **Retención de 2 niveles**: los últimos 30 backups diarios + un
  representante "mensual" (el backup más antiguo disponible de cada mes
  calendario) por cada uno de los últimos 12 meses. Al subir uno nuevo, el
  workflow borra automáticamente los que caen fuera de ambas ventanas
  (`scripts/backup-neon-to-blob.js`, función `clasificarBackups`, cubierta
  por `tests/backup-rotacion.test.js`) — con salvaguarda explícita: si
  algún blob no calza con el patrón de nombre esperado, o la clasificación
  no marca ningún backup para conservar, aborta el borrado sin tocar nada
  en vez de arriesgarse a borrar de más.
- **🔴 CRÍTICO — conexión DIRECTA, nunca pooled**: el secret
  `NEON_PRODUCTION_DATABASE_URL_DIRECT` (GitHub → repo → Settings → Secrets
  and variables → Actions) debe ser la connection string **directa** de la
  rama `production` en Neon (sin `-pooler` en el host — dashboard de Neon →
  Connection Details → desmarcar "Pooled connection"), **nunca** la misma
  `DATABASE_URL` pooled que usa la app en Vercel. Confirmado empíricamente
  durante el desarrollo de este mecanismo: correr `pg_dump` contra el
  endpoint *pooled* dejó `search_path` roto (vacío) en otras conexiones
  nuevas contra ese mismo pooler durante varios minutos (pg_dump fija
  `search_path=''` a nivel de sesión y el pooler de Neon no siempre
  resetea limpio el backend físico reutilizado) — cualquier query de la
  app sin calificar esquema habría fallado con "relation does not exist"
  para cualquier request real que compartiera ese backend mientras duró.
  Con la conexión directa, el pooled queda intacto siempre.
- **Si falla**: el run queda marcado en rojo en la pestaña Actions (log
  completo ahí) y además se inserta una notificación in-app para
  admin/desarrollador (`scripts/notificar-fallo-backup.js`, mismo mecanismo
  de notificaciones que el resto de la app).

### Restaurar un backup en caso de emergencia

1. Descargar el `.sql.gz` deseado desde Vercel Blob (dashboard → Storage →
   Blob → `backups/`, o vía `@vercel/blob` con el `BLOB_READ_WRITE_TOKEN`).
2. Descomprimir: `gunzip backup-YYYY-MM-DD.sql.gz`.
3. **Nunca restaurar directo sobre producción ni sobre el Preview activo.**
   Restaurar primero contra un Postgres efímero/local para confirmar que el
   dump sirve (ej. `docker run -d -e POSTGRES_PASSWORD=x -e POSTGRES_DB=y
   -p 15432:5432 postgres:18`, luego `psql -h localhost -p 15432 -U postgres
   -d y < backup-YYYY-MM-DD.sql`) y revisar que las tablas principales
   (`usuarios`, `proyectos`, `conceptos`, etc.) tengan conteos razonables.
4. Solo si la restauración de prueba fue limpia, coordinar con el equipo la
   restauración real (crear una rama nueva de Neon desde el backup, o
   restaurar en una branch de Neon dedicada — nunca sobreescribir
   `production` directamente sin ese paso intermedio).
