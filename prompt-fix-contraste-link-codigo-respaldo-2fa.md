Objective:
Corregir el color del link "¿Perdiste el acceso? Usa un código de respaldo" en el modal de "Verificación en dos pasos" — en modo oscuro se ve azul marino sobre fondo oscuro, prácticamente ilegible (captura de Paul adjunta).

Starting State:
- Modal de 2FA (verificación en dos pasos), el link de "código de respaldo" usa un color azul que no tiene suficiente contraste contra el fondo oscuro del modal.
- Confirmar el selector CSS real de ese link y qué variable/color está usando hoy.

Target State:
1. Localizar el CSS real del link en cuestión (`public/styles.css` o inline).
2. Corregir el color para que tenga buen contraste en modo oscuro (usar una variable de color ya existente en el sistema, ej. el dorado de acento o un azul más claro/vibrante — no un azul marino oscuro sobre fondo oscuro).
3. Confirmar que el modo claro sigue viéndose bien (no romper el contraste ahí al cambiar la variable).
4. Bump de `SW_VERSION`.

Allowed Actions:
- Modificar `public/styles.css`/`public/app.js` según corresponda.
- Levantar app local, verificar visualmente (screenshot) en dark y light mode.
- Bumpear `SW_VERSION`.

Forbidden Actions:
- NO tocar la lógica del flujo de 2FA/código de respaldo — solo el color/contraste visual.
- NO tocar Producción, NO commit a main.

Checkpoints:
✅ Screenshot dark mode: link legible con buen contraste.
✅ Screenshot light mode: sigue viéndose bien, sin regresión.
✅ SW_VERSION bumpeado, confirmado vía curl real.
✅ Branch lista para PR, sin commit a main.

Estimado: ~10 min con Claude Code (Sonnet 5, esfuerzo Medio).
