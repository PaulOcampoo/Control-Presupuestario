Objective:
Agregar un badge visual con el conteo de sugerencias pendientes junto al ítem "Sugerencias" del menú lateral, para que admin/desarrollador lo note de un vistazo sin tener que abrir la campana de notificaciones. Se agrega dentro del mismo PR #191 (notificaciones de sugerencias), antes de mergear.

Starting State:
- PR #191 (aún sin mergear) ya implementó notificaciones tipo `sugerencia_nueva` para admin/desarrollador, verificadas en producción-Preview con datos reales.
- El menú lateral ya tiene el ítem "Sugerencias" (ícono 💡) — confirmar si algún otro ítem del menú ya usa un patrón de badge numérico (ej. contador de alertas pendientes en algún otro módulo) para reusar el mismo componente/estilo.
- Las sugerencias ya tienen un campo `estado` (`pendiente` es el valor relevante para contar).

Target State:
- Junto al ítem "Sugerencias" del menú lateral, mostrar un badge con el número de sugerencias en `estado='pendiente'` — visible solo para admin/desarrollador (mismos roles que reciben la notificación).
- El badge se actualiza cuando cambia el conteo (nueva sugerencia entra, o una existente cambia de estado al ser atendida) — reusar el mismo mecanismo de refresco/polling que ya usa la campana de notificaciones si aplica, no inventar uno paralelo.
- Si el conteo es 0, el badge no se muestra (mismo criterio visual que otros badges ya existentes en la app, si los hay).

Allowed Actions:
- Agregar el endpoint o extender uno ya existente para exponer el conteo de sugerencias pendientes.
- Modificar public/app.js/public/styles.css para renderizar el badge en el menú lateral.
- Reusar el componente de badge existente si la app ya tiene uno usado en otro ítem de menú.

Forbidden Actions:
- NO mostrar el badge a roles distintos de admin/desarrollador.
- NO construir un sistema de polling/refresco paralelo si ya existe uno reusable para las notificaciones.

Checkpoints:
✅ Confirmación de qué componente/patrón de badge se reusó (o por qué no había ninguno reusable).
✅ Prueba: con al menos 1 sugerencia pendiente, el badge muestra el número correcto.
✅ Prueba: al marcar/atender una sugerencia (o cambiar su estado), el badge se actualiza.
✅ Confirmación de que un usuario no-admin/desarrollador no ve el badge.
✅ SW_VERSION bumpeado (si no se bumpeó ya en este mismo PR).
✅ Verificación visual tuya en dispositivo real.

Estimado de ejecución (Claude Code + Sonnet 5, esfuerzo Medio): 45 min – 1.5 horas.
