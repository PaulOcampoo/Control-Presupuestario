Objective:
Mover el tab "Órdenes de Cambio" de la galería "Obra" a la galería "Costos" — deja de vivir en Obra, pasa a ser un tab más dentro de Costos (junto a Dashboard de Costos, Matrices de precio unitario, Composición de costos, Mapeo, Catálogo de Básicos, Catálogo Maestro).

Starting State (diagnóstico primero, antes de mover nada):
- Ubicar la definición exacta del tab `ordenesCambio` en `SECTION_DEFS` (o equivalente) dentro de la galería Obra, en public/app.js.
- Revisar todos los lugares que referencian esa ubicación: navegación (breadcrumbs, links directos), permisos (`SECCIONES_PERMISOS`/`ACCIONES_CON_ENFORCEMENT`/`PERMISOS_SECCION_LABELS`/`PERMISOS_GRUPOS` si agrupan por galería), notificaciones/alertas que enlacen a esa pantalla (confirmar si `navigateFromNotif()` u otro mecanismo similar depende de la ruta actual), y cualquier test que asuma la ubicación bajo Obra.
- Confirmar si el backend (endpoints de Órdenes de Cambio) tiene alguna dependencia de la jerarquía de navegación (no debería, pero confirmar antes de asumir que es 100% cambio de frontend).

Target State:
1. El tab `ordenesCambio` se remueve de la galería Obra y se agrega a la galería Costos, con el mismo componente/lógica interna sin cambios funcionales — es un movimiento de ubicación en el menú, no un rediseño del módulo.
2. Actualizar cualquier enlace directo/breadcrumb/notificación que hoy asuma la ruta bajo Obra, para que apunte a la nueva ubicación bajo Costos.
3. Confirmar que los permisos existentes de Órdenes de Cambio (los roles/acciones que ya podían verlo/editarlo) se mantienen exactamente igual — este cambio es de navegación, no de quién tiene acceso.
4. Actualizar cualquier test que verifique la ubicación del tab.

Allowed Actions:
- Modificar public/app.js (definición de `SECTION_DEFS` y cualquier referencia de navegación/breadcrumb).
- Actualizar tests existentes que dependan de la ubicación anterior.
- Bumpear SW_VERSION.

Forbidden Actions:
- NO modificar la lógica interna, endpoints, ni permisos de quién puede ver/editar Órdenes de Cambio — solo su ubicación en el menú.
- NO dejarlo accesible desde ambos lugares — debe desaparecer de Obra por completo.
- NO romper ningún enlace/notificación existente que apunte a la ubicación vieja sin actualizarlo.

Stop Conditions:
- Si el diagnóstico encuentra que Órdenes de Cambio tiene alguna dependencia real de estar "dentro del contexto de una obra específica" que no aplique igual dentro de Costos (ej. algún dato que solo se resuelve bien desde la navegación de Obra), pausar y reportar antes de mover — aunque Costos también vive scoped por obra, confirmar que el patrón de acceso (selección de obra activa) es equivalente.

Checkpoints:
✅ Diagnóstico de todos los lugares que referencian la ubicación actual, documentado.
✅ Tab movido y confirmado ausente de Obra, presente en Costos.
✅ Enlaces/notificaciones que apuntaban a la ubicación vieja, verificados funcionando hacia la nueva.
✅ Permisos verificados idénticos a antes (mismos roles, mismas acciones).
✅ Tests actualizados y pasando.
✅ SW_VERSION bumpeado.
✅ Verificación visual tuya en dispositivo real: confirmar que ya no aparece en Obra y sí aparece en Costos, con el mismo contenido/funcionalidad de siempre.

Estimado de ejecución (Claude Code + Sonnet 5, esfuerzo Medio): 1–2 horas.
