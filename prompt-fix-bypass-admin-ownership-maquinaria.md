Objective:
Corregir los 2 endpoints de Maquinaria (`POST /api/maquinaria/consumibles` en server/app.js:2027, y `POST /api/maquinaria/estado-unidad` en server/app.js:1932) donde el check de "ownership" (`equipo.operador_asignado_id !== req.user.id`) es incondicional y bloquea a admin/desarrollador — inconsistente con el resto del sistema, donde ese mismo patrón ya está bien hecho en otros 2 lugares del archivo (líneas 1529 y 1913: `if (req.user.puesto === 'operador' && equipo.operador_asignado_id !== req.user.id)`).

Starting State (diagnóstico ya confirmado, reproducido con login real):
- `server/app.js:2027` (Consumibles) y `server/app.js:1932` (Estado de Unidad): ambos comparan `operador_asignado_id !== req.user.id` sin condicionar a que el usuario sea `puesto === 'operador'` — cualquier admin/desarrollador que no sea el operador asignado literal del equipo recibe 403.
- `server/app.js:1529` y `:1913`: mismo tipo de check, ya hecho correctamente con la guarda `req.user.puesto === 'operador' &&` antes de comparar — este es el patrón a replicar.
- El middleware `auth.checkPermiso()` de nivel superior ya tiene el bypass admin/desarrollador correcto — el bug es solo en estos 2 checks de ownership adicionales dentro del handler.

Target State:
1. En `server/app.js:2027` (Consumibles): agregar `req.user.puesto === 'operador' &&` antes de la comparación de `operador_asignado_id`, igual que en las líneas 1529/1913.
2. En `server/app.js:1932` (Estado de Unidad): mismo fix.
3. Confirmar que ningún otro punto del archivo tiene el mismo patrón incondicional (búsqueda exhaustiva de `operador_asignado_id !== req.user.id` en todo `server/app.js`) — corregir cualquier otra ocurrencia real encontrada.
4. Bump de `SW_VERSION`.

Allowed Actions:
- Modificar `server/app.js` (los 2 puntos confirmados + cualquier otro encontrado en la búsqueda exhaustiva).
- Levantar app local contra Preview, verificar con Playwright/WebKit: login real como admin, registrar un consumible y cambiar estado de unidad en un equipo SIN operador asignado a ese admin — confirmar que ya no da 403. Login real como operador de un equipo distinto al suyo — confirmar que SÍ sigue bloqueado (el check debe seguir protegiendo a operadores, solo dejar de bloquear a admin/desarrollador).
- Bumpear `SW_VERSION`.

Forbidden Actions:
- NO quitar el check de ownership para operadores — debe seguir aplicando de lleno a ese rol.
- NO tocar Producción, NO commit a main.

Stop Conditions:
- Si la búsqueda exhaustiva encuentra más de 3 ocurrencias adicionales del mismo patrón — pausar y presentar la lista completa antes de corregirlas todas de un jalón.

Checkpoints:
✅ Admin puede registrar consumible y cambiar estado de unidad en equipo sin ser el operador asignado, verificado con Playwright.
✅ Operador SIGUE bloqueado si el equipo no es el suyo, verificado con Playwright (no se rompió la protección real).
✅ Búsqueda exhaustiva confirma que no quedan ocurrencias del mismo bug sin corregir.
✅ SW_VERSION bumpeado, confirmado vía curl real.
✅ Branch lista para PR, sin commit a main.

Estimado: ~15-20 min con Claude Code (Sonnet 5, esfuerzo Medio).
