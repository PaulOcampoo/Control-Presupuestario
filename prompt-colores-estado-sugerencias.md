Objective:
Agregar color distintivo a cada opción del selector de estado en el panel de Sugerencias (Pendiente/Revisada/Implementada/Descartada) para que sea más fácil escanear visualmente el estado de cada sugerencia, tanto en el botón cerrado como en las opciones del dropdown.

Starting State:
- Selector de estado en el panel admin de Sugerencias (ver captura) — hoy todas las opciones se ven con el mismo estilo neutro (borde/texto blanco), sin distinción visual por estado.
- El componente ya usa el selector custom del proyecto (confirmar el nombre exacto en public/app.js) — no es un `<select>` nativo.

Target State:
- Colores propuestos (ajustables si no encajan con la paleta ya usada en otro lado de la app para semántica similar — revisar si ya existe un patrón de color para "pendiente/aprobado/rechazado" en otro módulo, ej. estatus_venta o estado de requisiciones, y reusarlo si aplica en vez de inventar uno nuevo):
  - Pendiente: dorado/ámbar (mismo tono ya usado para "atención"/acentos dorados de la marca).
  - Revisada: azul.
  - Implementada: verde.
  - Descartada: gris o rojo tenue (no un rojo de error agresivo — es un cierre normal, no una falla).
- El color debe verse tanto en el botón/badge cerrado del selector como resaltando la opción activa dentro del dropdown (ya se ve un resaltado dorado en la opción "Pendiente" en la captura — extender ese mismo mecanismo a las otras 3 opciones con su color correspondiente).
- Mantener contraste legible en dark mode (paleta base del proyecto: fondo `#0B1220`, acento dorado `#C9A24B`).

Allowed Actions:
- Modificar public/styles.css / public/app.js para el estilo del selector de estado de Sugerencias específicamente — no cambiar el componente de selector custom genérico si es compartido con otras partes de la app (evitar que el cambio de color se filtre a otros selectores que no deben tener esta semántica).

Forbidden Actions:
- NO cambiar el comportamiento funcional del selector (sigue siendo los mismos 4 estados, mismo endpoint).
- NO afectar el estilo de otros selectores custom de la app que no sean este.

Checkpoints:
✅ Verificación visual tuya: cada uno de los 4 estados se ve con su color correspondiente, tanto cerrado como en el dropdown abierto, en dark mode.
✅ Confirmación de que otros selectores custom en la app no cambiaron de apariencia.

Estimado de ejecución (Claude Code + Sonnet 5, esfuerzo Medio): 30–45 min.
