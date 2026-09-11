Objective:
Diagnosticar por qué Rodolfo Ocampo (rol admin, id=28) recibe "No tienes permiso para realizar esta acción" al intentar registrar un Consumible (combustible) en el módulo Maquinaria, cuando admin/desarrollador deben tener bypass total de permisos en todo el sistema — regla ya documentada y confirmada en sesiones anteriores.

Starting State:
- Captura de Paul: modal "Registrar consumible" (equipo TROMPO No 1, tipo Gasolina, obra "671 CASA CLUB"), usuario Rodolfo Ocampo (admin) — al dar "Guardar", toast rojo "No tienes permiso para realizar esta acción".
- Regla ya establecida en el proyecto: admin y desarrollador tienen bypass total de permisos, siempre hardcodeado, no dependen de tablas de permisos.
- Módulo Maquinaria tiene su propio flujo de aprobación (roles jefe_maquinaria, operador, cabo) — posible que el endpoint de Consumibles tenga una validación de rol específica de Maquinaria que no contempla el bypass de admin/desarrollador.

Target State:
1. Localizar el endpoint real de "Registrar consumible" (`server/app.js` o módulo de Maquinaria) y la validación de permisos que dispara el 403/error.
2. Confirmar si esa validación usa `auth.allow()` (patrón estándar con bypass admin/desarrollador ya incluido) o una validación custom que no lo contempla.
3. Reproducir en Preview con un usuario admin real, confirmar el error exacto y la causa en código.
4. Si es una validación custom sin bypass: proponer el fix (agregar el bypass admin/desarrollador, consistente con el resto del sistema) — no implementar todavía, solo diagnosticar y confirmar la causa exacta.

Allowed Actions:
- Leer código relevante del módulo Maquinaria/Consumibles.
- Levantar app local contra Preview, reproducir con usuario admin real (login real, no simulación de rol).

Forbidden Actions:
- NO implementar el fix todavía.
- NO tocar Producción.

Checkpoints:
✅ Causa raíz confirmada con evidencia de código + reproducción real.
✅ Confirmación de si el bug se limita a Consumibles o si el mismo patrón (validación sin bypass admin) aparece en otras acciones de Maquinaria.

Estimado: ~15 min con Claude Code (Sonnet 5, esfuerzo Medio).
