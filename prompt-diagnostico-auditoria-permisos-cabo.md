Objective:
Diagnóstico previo (sin código funcional) del acceso real del rol `cabo` en toda la app — qué tabs/secciones puede ver hoy (frontend Y backend), comparado contra el diseño original documentado ("cabo: acceso históricamente limitado a Destajo"), para encontrar todo el sobre-alcance acumulado de una sola vez, en vez de seguir descubriéndolo tab por tab.

Starting State:
- Ya se encontraron y corrigieron 2 casos de sobre-alcance de `cabo` en sesiones recientes: acceso a "Infraestructura vs. Vivienda" (PR #192, ya revocado — 3 endpoints reales con `auth.allow()` que lo permitían) y, antes de eso, el propio Órdenes de Cambio requirió tratamiento especial de navegación por estar en su `ROLE_TABS`.
- Durante la verificación visual del PR #192, Paul encontró que `cabo` también tiene acceso hoy a la sección completa "Administración" (Trabajadores, Nóminas, Almacenes) en el sidebar — contradice el diseño documentado.
- El patrón de bug ya conocido: `ROLE_TABS.cabo` (frontend, controla qué se muestra) puede estar desalineado de los `auth.allow()`/`checkPermiso` reales del backend (controla qué realmente se permite) — la Regla dura del proyecto: "el enforcement de permisos siempre vive en backend, nunca solo en UI", así que ambos lados hay que auditar por separado, no asumir que coinciden.
- Documentado como diseño histórico: cabo excluido de todos los endpoints de Nómina.

Target State (solo investigación, reportar en texto/markdown — tabla comparativa):

1. **Listar TODO lo que `ROLE_TABS.cabo` contiene hoy** (frontend, public/app.js) — cada tab, uno por uno.
2. **Para cada uno de esos tabs, verificar el backend real**: ¿qué endpoint(s) sirve esa pantalla? ¿Ese endpoint usa `auth.allow()` (con o sin `cabo` en la lista) o `checkPermiso()`? Confirmar con evidencia literal (línea de código), no suposición.
3. **Clasificar cada tab en una tabla**: Tab | ¿Frontend lo muestra a cabo? | ¿Backend realmente lo permite a cabo? | ¿Coincide con "acceso limitado a Destajo (+ probablemente Avance)"? | Recomendación (mantener / revocar / confirmar con Paul).
4. **Casos de desalineación frontend/backend** (el tipo de bug ya encontrado dos veces) — señalarlos con prioridad, son los más peligrosos: la UI podría estar mostrando algo que el backend ya bloquea (falso negativo, solo confuso) o —peor— el backend podría estar permitiendo algo que el frontend nunca debió exponer (falso positivo, riesgo real).
5. **Revisar `permisos_usuario`** también — confirmar si `cabo` tiene alguna fila ahí que le dé acceso granular a algo fuera de Destajo/Avance, y si esas filas fueron intencionales o residuales.
6. **No proponer los fixes todavía** — solo el diagnóstico completo en forma de tabla, para que Paul decida sección por sección qué se queda y qué se revoca, en una sola pasada en vez de sorpresas sucesivas.

Allowed Actions:
- Leer public/app.js (`ROLE_TABS`, `SECTION_DEFS`), server/app.js (endpoints y su gateo), server/auth.js (`TAB_A_SECCION`, `checkPermiso`, `SECCIONES_PERMISOS`).
- Consultar `permisos_usuario` en Preview DB (confirmar que es Preview antes de cualquier query) filtrando por usuarios con puesto `cabo`.
- Reportar en texto/markdown, con la tabla comparativa como entregable principal.

Forbidden Actions:
- NO modificar ROLE_TABS, auth.allow(), checkPermiso, ni ningún archivo de código.
- NO revocar ni otorgar ningún acceso — esto es diagnóstico puro.
- NO correr ninguna query de escritura, ni siquiera contra Preview.
- NO tocar producción bajo ninguna circunstancia.
