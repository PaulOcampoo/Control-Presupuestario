# Matriz de permisos — Fase 8 (2026-09-29)

Prueba automatizada en navegador (Playwright, API simulada), shell v2 activo por defecto, con `state.allowedTabs = ROLE_TABS[rol]`.

Para cada rol (admin, desarrollador, residente, cabo, compras, tesoreria, administracion, logistica, jefe_maquinaria, operador, costos):
- El sidebar con v2 muestra exactamente las mismas secciones/ítems que con el opt-out `ui_v2=0` (v1).
- Ctrl K no lista ningún destino fuera de `allowedTabs` (secciones, módulos, accesos globales, obras, acciones).
- "Nuevo" (`accionesRapidasParaRol`) coincide con el menú "+" (`openQuickActionMenu`).
- La hoja "Más" tiene una celda por sección visible + Novedades, Sugerencias y Ajustes.
- Desarrollador real simulando cada rol (sin recargar): sidebar, Ctrl K, acciones y hoja "Más" iguales a los del rol real; el shell v2 sigue activo.
- `operador` y `jefe_maquinaria` solo ven la sección Maquinaria (sin secciones vacías).
- `cabo`: Órdenes de Cambio como ítem suelto, hermanos Avance/Destajo/Órdenes de Cambio, sin tile de Costos.

Límites: el `allowedTabs` se tomó de `ROLE_TABS` (no de los permisos granulares de BD por usuario) y no hubo login real ni iPhone.
