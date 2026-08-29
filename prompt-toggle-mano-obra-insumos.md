Objective:
Agregar un toggle "Incluir mano de obra" en la pantalla de catálogo de Insumos, reusando el mismo mecanismo que ya usa el buscador de Mapeo (parámetro `incluirManoObra` de `getInsumosData()`), para que `residente`/`cabo` puedan ver los insumos `MO*` cuando lo necesiten, sin que estén ocultos por default. Resuelve la sugerencia real de Raúl Méndez (residente), verificada y cuantificada en diagnóstico previo — hoy no ve entre 25% y 32% de los insumos de sus obras.

Starting State:
- `getInsumosData()` (server/app.js) excluye por diseño los insumos con código `MO*` salvo que el caller pase `incirManoObra=true` — ya usado por el buscador interno de Mapeo/Matrices.
- El catálogo de Insumos (pantalla que ve `residente`/`cabo`/`admin`) nunca manda ese flag — siempre excluye MO*, sin ningún toggle visible.
- Decisión de negocio confirmada por Paul: si debería poder verla, vía toggle (no quitar el filtro de raíz).

Target State:
1. Backend: el endpoint que alimenta el catálogo de Insumos acepta un query param (ej. `?incluirManoObra=true`) y lo pasa a `getInsumosData()` — mismo patrón ya usado por Mapeo, no una implementación nueva.
2. Frontend: agregar un toggle/checkbox "Incluir mano de obra" en la pantalla de catálogo de Insumos, visible para todos los roles que acceden a esa pantalla (no solo admin) — por default desactivado (comportamiento actual sin cambios), y al activarlo recarga la lista incluyendo MO*.
3. El toggle debe distinguir visualmente los insumos de mano de obra del resto cuando están incluidos (ej. badge o agrupación), para que no se lean como insumos de material regulares.
4. Confirmar que ningún otro consumidor de esa misma pantalla (export a Excel, si existe desde ahí) se ve afectado de forma inesperada — si el export también debería respetar el toggle, confirmarlo explícitamente.

Allowed Actions:
- Modificar el endpoint de catálogo de Insumos en server/app.js para aceptar y propagar el query param.
- Modificar public/app.js/public/styles.css para el toggle y el badge visual.
- Bumpear SW_VERSION (usando max(git log --all) + 1).
- Agregar tests: catálogo sin toggle (comportamiento actual, MO* excluido), con toggle activado (MO* incluido), y verificación de que Mapeo no se ve afectado por este cambio.

Forbidden Actions:
- NO cambiar el comportamiento default (MO* sigue excluido si el toggle no se activa).
- NO tocar el mecanismo interno de Mapeo — solo reusarlo desde un nuevo punto de entrada.
- NO usar `<select>` ni `confirm()` nativos si aplica alguno de los dos en este cambio.

Checkpoints:
✅ Test de catálogo sin toggle (comportamiento idéntico al actual) y con toggle activado (MO* visible), con conteos verificados contra los datos reales de las obras #30/#32 usados en el diagnóstico.
✅ Confirmación de que Mapeo sigue funcionando igual (regresión).
✅ SW_VERSION bumpeado correctamente.
✅ Verificación visual tuya en dispositivo real: activar el toggle en el catálogo de Insumos y confirmar que aparecen los insumos MO* con su distinción visual, desactivarlo y confirmar que vuelven a ocultarse.
✅ Limpieza de datos de prueba verificada.

Estimado de ejecución (Claude Code + Sonnet 5, esfuerzo Medio): 1.5–2.5 horas.
