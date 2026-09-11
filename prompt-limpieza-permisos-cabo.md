Objective:
Cerrar los hallazgos de la auditoría de permisos de `cabo`: (1) restaurar de inmediato el acceso del único `cabo` real en producción (Emonico, id 118), que hoy recibe 403 en su trabajo diario básico por filas faltantes en `permisos_usuario`; (2) corregir el default de `nominas.puede_ver` para que requiera activación explícita de un admin, igual que Trabajadores; (3) separar la granularidad de lectura de `maquinaria` para que `cabo` solo pueda leer lo que su propia UI expone; (4) limitar el alcance del backend de `trabajadores` para `cabo` incluso estando hoy en default-deny.

Starting State:
- Diagnóstico ya confirmado (sin código tocado todavía): tabla completa de los 12 tabs de `cabo`, con evidencia de backend real para cada uno.
- `nominas` fue una decisión de negocio deliberada (PR #63/#64, julio 2026) de que `cabo` PUEDE tener Nómina vía matriz de permisos — pero el default quedó otorgado automáticamente en vez de requerir activación explícita, contradiciendo el propio lenguaje del commit original ("mismo patrón que Trabajadores").
- El único usuario real con puesto `cabo` (id 118, Emonico) solo tiene 3 filas en `permisos_usuario` (estado_unidad, maquinaria_captura, maquinaria_consumibles) — le faltan las de `destajo`/`avance`/`requisiciones`/`insumos`/`ordenes_cambio`, secciones con enforcement real (sin fila = 403).
- `maquinaria` (equipos/responsables/combustible/bitácora de taller/etc.) vive hoy bajo una sola sección de permiso granular — de ahí la fuga de lectura cruzada.
- Decisión confirmada por Paul: `maquinaria.puede_crear=true` por default NO se toca en este PR — queda fuera de alcance, no es un hallazgo a resolver ahora.

Target State:

FASE 0 — Restaurar al usuario real (prioridad, hacerlo primero):
- Backfilear en `permisos_usuario` las filas faltantes para el usuario id 118 (Emonico) en las secciones que la auditoría marcó "Mantener": `destajo` (puede_ver+puede_editar, como ya lo tenía funcionando antes), `avance` (puede_ver+puede_crear), `requisiciones` (CRUD completo, como ya se documentó que "ya creaba sus propias requisiciones"), `insumos` (solo puede_ver), `ordenes_cambio` (crear/ver/subir doc, sin aprobar/rechazar).
- NO agregar fila de `nominas` para este usuario — bajo el nuevo default (Fase 1), su ausencia ya es el estado correcto a menos que Paul confirme explícitamente que Emonico sí debe tener Nómina.
- Confirmar con query directa, antes y después, exactamente qué filas tenía y qué filas quedaron.

FASE 1 — Default de `nominas.puede_ver`:
- En `defaultPermisosParaRol()` (o donde viva la generación de defaults), agregar el override `porSeccion.nominas.puede_ver = false` para `cabo` — mismo patrón exacto ya usado para `trabajadores` (commit 6672728).
- Confirmar que `puede_crear`/`puede_editar`/`puede_eliminar` de nominas para cabo ya estaban en `false` por default (según el diagnóstico) — no deberían necesitar cambio, solo verificar.
- Este cambio afecta el default para `cabo` NUEVOS que se den de alta a partir de ahora — no reescribe retroactivamente las filas de usuarios `cabo` ya existentes (si alguno más además de Emonico ya tiene `nominas.puede_ver=true` heredado del bug, reportarlo como hallazgo aparte antes de decidir si se revoca).

FASE 2 — Separar granularidad de lectura en `maquinaria`:
- Identificar las subsecciones reales hoy agrupadas bajo el permiso único `maquinaria`: catálogo/equipos, horas, estado de unidad, consumibles, reportes-cliente, combustible, bitácora/mantenimientos.
- Dividir en las secciones granulares necesarias para que `cabo` (vía su matriz de `permisos_usuario`) solo pueda leer las que su `ROLE_TABS`/`MAQUINARIA_TABS_CABO` realmente expone — combustible y bitácora/mantenimientos quedan fuera del acceso de `cabo`.
- Seguir el checklist de 5 lugares para secciones nuevas de permisos (documentado en CLAUDE.md): `SECCIONES_PERMISOS`, el CHECK constraint en `server/db.js` en AMBOS lugares (CREATE TABLE y ALTER TABLE), y los 3 puntos correspondientes en `public/app.js`.
- Verificar que otros roles que sí deben ver combustible/bitácora (residente, admin, jefe_maquinaria, etc. — confirmar cuáles según el código actual) no pierdan acceso con este cambio.

FASE 3 — Limitar alcance de backend de `trabajadores` para `cabo`:
- Aunque `puede_ver` de `trabajadores` para `cabo` está hoy en `false` por default (seguro), la ruta de backend permite llegar hasta documentos de identidad/contrato si algún día se activa.
- Restringir el backend para que, incluso con `puede_ver=true` activado para un `cabo` específico, los endpoints de documentos de identidad/contrato de trabajador sigan bloqueados para ese rol — solo datos operativos básicos (nombre, puesto, asistencia), nunca documentos sensibles.

Allowed Actions:
- Modificar `permisos_usuario` (solo el usuario id 118, vía backend/script, no SQL directo a mano salvo que sea el patrón ya usado en el proyecto).
- Modificar `defaultPermisosParaRol()`, `server/auth.js`, `server/app.js`, `server/db.js`, `public/app.js` según cada fase.
- Bumpear SW_VERSION.
- Agregar tests: Fase 0 (Emonico ya no recibe 403 en destajo/avance/requisiciones/insumos/ordenes_cambio, sigue sin ver nominas), Fase 1 (cabo nuevo nace con nominas.puede_ver=false), Fase 2 (cabo no puede leer combustible/bitácora vía API directa, otros roles sí conservan acceso), Fase 3 (cabo con puede_ver=true en trabajadores sigue sin poder ver documentos).

Forbidden Actions:
- NO tocar `maquinaria.puede_crear=true` por default — fuera de alcance, decisión ya tomada.
- NO revocar retroactivamente permisos de otros usuarios `cabo` sin reportarlo primero como hallazgo aparte.
- NO dar de alta la fila de `nominas` para Emonico salvo confirmación explícita de Paul.
- NO romper el acceso de otros roles a combustible/bitácora de taller.

Stop Conditions:
- Si dividir la sección `maquinaria` en subsecciones más granulares afecta a más roles/lugares de lo esperado (ej. reportes o dashboards que agregan por la sección única), pausar y reportar el alcance real antes de proceder.
- Si al revisar `permisos_usuario` completo aparece algún otro usuario `cabo` (no solo Emonico) con el mismo patrón de sub-provisión o sobre-alcance, pausar y reportarlo antes de aplicar el mismo fix masivamente sin confirmación.

Checkpoints:
✅ Fase 0: query directa antes/después mostrando las filas de Emonico corregidas, y confirmación de que ya no recibe 403 en sus endpoints básicos.
✅ Fase 1: test de un `cabo` nuevo naciendo con `nominas.puede_ver=false`.
✅ Fase 2: test de que `cabo` recibe 403 en combustible/bitácora, y que otros roles conservan acceso.
✅ Fase 3: test de que documentos de trabajador siguen bloqueados para `cabo` aunque `puede_ver` esté activado.
✅ SW_VERSION bumpeado.
✅ Verificación visual tuya en dispositivo real, idealmente con la cuenta real de Emonico o una réplica exacta (como ya se hizo en PR #64).
✅ Limpieza de datos de prueba verificada.

Estimado de ejecución (Claude Code + Sonnet 5, esfuerzo Medio): 4–5.5 horas (la Fase 2 es la más grande por el checklist de 5 lugares).
