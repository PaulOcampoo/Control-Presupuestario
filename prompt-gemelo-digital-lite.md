Objective:
Crear una nueva pantalla "Estado del Activo" (`#estado-activo`) por obra dentro de App-CP que consolide en tiempo real datos ya existentes de Avance, Destajo, Finanzas y Maquinaria en una sola vista tipo panel, como primer nivel de "gemelo digital" operativo de la obra (sin BIM ni IoT, solo agregación de datos ya persistidos).

Starting State:
- App-CP es una PWA vanilla JS/CSS (`public/app.js`, `public/index.html`), backend Node/Express (`server/app.js`, `server/db.js`), Postgres vía Neon.
- Ya existen datos reales por proyecto en: `avance` (avance semanal por concepto), `destajo_items` (precio_destajo, cantidad_ejecutada), tabla de `conceptos`/presupuesto (contrato vs real), y módulo Maquinaria (`jefe_maquinaria`, `operador`, bitácora de mantenimientos, asignación de equipo a proyecto vía `cliente_asignado_id`).
- Navegación actual usa `mostrarPantalla()` / `ocultarPantalla()` para crossfade entre pantallas top-level, con galería seccionada: Obra, Compras, Administración, Tesorería, Maquinaria.
- No existe ninguna pantalla que combine estos módulos en una sola vista resumen "estado actual del activo".
- Roles: admin/desarrollador ven todo; residente no debe ver montos financieros en Inicio pero sí Avance y Destajo — este mismo criterio de visibilidad de montos debe respetarse aquí.

Target State:

1. BACKEND — nuevo endpoint agregador:
   - Crear `GET /api/proyectos/:id/estado-activo` en `server/app.js`.
   - Debe hacer 1 sola función que agregue en paralelo (Promise.all): avance % acumulado del proyecto, presupuesto real vs contrato (usando la misma lógica ya existente en Finanzas, incluyendo el ajuste de IVA /1.16 ya implementado), destajo total ejecutado del periodo actual, y equipo de maquinaria actualmente asignado al proyecto con su estatus (activo/mantenimiento).
   - Aplicar el mismo `checkPermiso`/verificación de ownership de proyecto que ya usan otros endpoints (verificar `project_id` asignado al usuario antes de responder, 403 si no).
   - Si el usuario es `residente`, omitir del JSON los campos de montos financieros (igual que en Inicio).

2. FRONTEND — nueva pantalla:
   - Agregar tile "Estado del Activo" en la galería seccionada de Obra (mismo patrón visual "cliente-card" que las demás secciones).
   - Nueva pantalla `#estado-activo` en `public/index.html` con 4 tarjetas: Avance (%), Presupuesto (real vs contrato, barra comparativa), Destajo (ejecutado del periodo), Maquinaria (lista de equipo activo + estatus).
   - Usar los mismos tokens de easing (`--ease-out`, `--ease-in-out`) y el mismo mecanismo de crossfade `mostrarPantalla()`/`ocultarPantalla()` que el resto de la app.
   - Refresco de datos: fetch al entrar a la pantalla, sin polling automático (evitar carga extra en Vercel serverless).
   - Respetar `prefers-reduced-motion` y el gateo de hover existente (`@media (hover: hover) and (pointer: fine)`).

3. SW_VERSION:
   - Bumpear `SW_VERSION` en el service worker aunque el cambio incluya backend — regla sin excepciones del proyecto.

Allowed Actions:
- Crear el nuevo endpoint en `server/app.js`.
- Modificar `public/app.js` y `public/index.html` para agregar la pantalla y su tile de navegación.
- Bumpear `SW_VERSION` en el archivo del service worker correspondiente.
- Reutilizar funciones/queries ya existentes de Avance, Finanzas, Destajo y Maquinaria en vez de duplicar lógica SQL.

Forbidden Actions:
- NO modificar el esquema de base de datos (`SCHEMA` en `server/db.js`) — este feature es de solo lectura/agregación.
- NO tocar la lógica financiera existente de Finanzas (el ajuste de IVA /1.16) — solo reutilizarla vía función/import.
- NO exponer montos financieros a roles sin permiso (residente, cabo).
- NO agregar polling automático ni websockets — solo fetch on-demand al entrar a la pantalla.
- NO tocar módulos de Nómina, Requisiciones, Órdenes de Compra ni Contrato.

Stop Conditions:
Pausar y pedir revisión cuando:
- La agregación de datos de Maquinaria y Destajo requiera más de 2 queries adicionales no triviales (indicaría que faltan índices o que el modelo de datos no soporta bien la agregación).
- Se detecte que el ajuste de IVA de Finanzas no es fácilmente reutilizable como función aislada (evitar duplicar la lógica a mano).
- El endpoint tarde más de ~2s en responder en pruebas locales (indicaría necesidad de optimizar antes de exponerlo).

Checkpoints:
✅ `GET /api/proyectos/:id/estado-activo` responde 200 con los 4 bloques de datos para un usuario admin, y 403 para un usuario sin proyecto asignado — output literal de terminal/HTTP.
✅ Un usuario `residente` recibe el JSON sin campos financieros — verificado con output literal, no resumen.
✅ La pantalla "Estado del Activo" se ve correctamente en dispositivo real (mobile), con crossfade consistente con el resto de la app — confirmación explícita de Paul en dispositivo real.
✅ SW_VERSION bumpeado.
✅ Al terminar: lista de todos los archivos modificados con resumen de cada cambio.

Estimado de ejecución (Claude Code + Sonnet 5, esfuerzo: Medio): 2–3 horas.
