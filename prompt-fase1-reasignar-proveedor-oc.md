Objective:
Implementar la acción "Reasignar proveedor" en el modal de detalle de OC, restringida a admin/desarrollador, disponible en cualquier estado de la OC (no solo `recibida_completa`) — basado en el diseño aprobado en Fase 0 (`docs/fase0-reasignar-proveedor-oc.md`). Corrige el caso real que la motivó: OC ROF-14 tiene el proveedor mal capturado y el equipo la corregirá ellos mismos una vez implementado.

Starting State (diseño aprobado en Fase 0):
- Confirmado: editar proveedor nunca existió en ningún estado — el modal solo pinta `proveedor_nombre` como texto plano; `proveedor_id` solo se escribe una vez, al crear la OC.
- Sin denormalización: pagos y recepciones referencian `orden_compra_id`, nunca `proveedor_id` — reasignar es un `UPDATE` de una sola columna, sin efectos colaterales confirmados en Fase 0.
- Diseño aprobado: `PATCH /api/projects/:id/ordenes/:ocId/proveedor`, protegido con el mismo patrón `auth.allow()` que solo permite admin/desarrollador.
- Alcance decidido: disponible en CUALQUIER estado de la OC, no restringido a `recibida_completa`.
- Auditoría: reusar la tabla `audit_log` ya existente, mismo patrón que `/matrices/:conceptoId/aplicar` — registrar quién, cuándo, proveedor anterior → nuevo.

Target State:
1. Backend: `PATCH /api/projects/:id/ordenes/:ocId/proveedor` — recibe `proveedor_id` nuevo, valida que el usuario sea admin/desarrollador (403 si no), valida que el proveedor nuevo exista y esté activo, actualiza `proveedor_id` en la OC, escribe entrada en `audit_log` con proveedor anterior y nuevo.
2. Frontend: en el modal de detalle de OC, mostrar una acción "Reasignar proveedor" (ej. ícono de editar junto al nombre del proveedor) visible SOLO si `isAdmin()` — abre un selector de proveedor (reusar el componente ya usado en otras partes de la app para elegir proveedor, si existe) con confirmación explícita antes de aplicar ("¿Seguro que quieres cambiar el proveedor de esta OC de X a Y?").
3. Tras reasignar, el modal debe reflejar el cambio inmediatamente sin necesitar recargar.
4. Bump de `SW_VERSION`.

Allowed Actions:
- Modificar `server/app.js` (endpoint nuevo), `public/app.js` (UI del modal).
- Levantar app local contra Preview, verificar con Playwright/WebKit: como admin, reasignar proveedor de una OC de prueba en cualquier estado (incluyendo `recibida_completa`), confirmar que el cambio persiste y aparece en `audit_log`; como un rol no-admin (ej. compras), confirmar que la acción NO es visible ni accesible por API directa (403).
- Bumpear `SW_VERSION`.

Forbidden Actions:
- NO modificar montos, fechas, recepciones, ni pagos de la OC — solo `proveedor_id`.
- NO exponer esta acción a roles distintos de admin/desarrollador, ni en UI ni en backend.
- NO tocar Producción, NO commit a main.

Stop Conditions:
- Si algún rol no-admin logra ver o ejecutar la acción (aunque sea por API directa) — pausar, es un problema de seguridad que debe corregirse antes de continuar.

Checkpoints:
✅ Endpoint funcional, verificado con Playwright: admin reasigna proveedor en una OC `recibida_completa`, cambio persiste.
✅ Entrada correcta en `audit_log` (usuario, fecha, proveedor anterior → nuevo).
✅ Rol no-admin (ej. compras) NO ve la acción en UI, y recibe 403 si intenta la API directamente.
✅ Modal refleja el cambio sin recargar.
✅ SW_VERSION bumpeado, confirmado vía curl real.
✅ Branch lista para PR, sin commit a main.

Estimado: ~35-45 min con Claude Code (Sonnet 5, esfuerzo Medio).
