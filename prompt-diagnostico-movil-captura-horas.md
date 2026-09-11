Objective:
Investigación más profunda (sin código funcional todavía) del bug reportado por un operador: "no deja borrar en fecha/hora al corregir" y "no deja seleccionar más de un área de trabajo". El diagnóstico previo no reprodujo el bug en escritorio y encontró que el selector múltiple ya se corrigió en PR #126 (13 ago) — pero no se pudo confirmar con el usuario real si sigue pasando, ni qué dispositivo usa. Esta vez, investigar con emulación de dispositivos móviles reales antes de descartar el reporte.

Starting State:
- Formulario de captura de horas de operador en Maquinaria (openHorasMaqModal(), public/app.js).
- Campos de fecha/hora: inputs nativos `type="date"`/`type="number"`, sin máscara custom identificada en el diagnóstico previo.
- Selector de "Actividad(es)": ya es un grupo de checkboxes multi-selección desde PR #126.
- Hipótesis nueva a explorar: el reporte original podría ser de ANTES de PR #126, y el usuario podría seguir en una versión vieja cacheada del Service Worker — mismo patrón de bug de caché ya confirmado y corregido dos veces en esta sesión (colisión de SW_VERSION en el badge de Sugerencias, y el bug de CSP anterior). Investigar si hay alguna señal de que esto pueda estarle pasando a un usuario que no ha vuelto a abrir la app completamente en varios días.

Target State (solo investigación, reportar en texto/markdown):

1. **Emulación móvil con Playwright**: probar el formulario de captura de horas con al menos 2 perfiles de dispositivo realistas (ej. Android Chrome — Pixel/Samsung común, iOS Safari — iPhone). Para cada uno:
   - Reproducir el flujo: escribir una fecha/hora, luego intentar borrar con Backspace/Delete (o el mecanismo táctil equivalente — en iOS/Android los inputs `type="date"` suelen abrir un picker nativo del sistema operativo, no un teclado de texto libre; confirmar si eso es lo que está generando la confusión de "no deja borrar", ya que el picker nativo se comporta muy distinto a escribir texto).
   - Confirmar visualmente (capturas) cómo se ve y comporta cada campo en cada perfil.
2. **Investigar el patrón de UX conocido**: `<input type="date">` en navegadores móviles reales (no en el emulador de Chrome DevTools, que no siempre refleja el picker nativo real del SO) tiene comportamientos documentados de "no se puede editar parcialmente, solo seleccionar de nuevo" — confirmar si esto aplica aquí y si es la explicación más probable del reporte de Alfredo.
3. **Verificar la hipótesis de caché vieja**: ¿hay alguna forma de saber (logs, analytics, o inferencia) si el reporte de Alfredo es anterior o posterior al 13 de agosto (PR #126)? Si no hay manera de saberlo con certeza, decirlo explícitamente — no inventar una conclusión.
4. **Conclusión y recomendación**: con la evidencia de emulación móvil real, dar una recomendación concreta — por ejemplo, si el picker nativo de fecha es genuinamente confuso para "corregir" un valor ya capturado, proponer reemplazarlo por un componente de fecha custom (con edición de texto libre + picker opcional), en vez de asumir que el usuario simplemente no sabe usarlo.

Allowed Actions:
- Usar Playwright con emulación de dispositivos (`playwright.devices`) para Android/iOS.
- Tomar capturas de pantalla del comportamiento en cada perfil.
- Leer el código relevante (ya identificado en el diagnóstico previo).
- Reportar hallazgos y recomendación en texto/markdown.

Forbidden Actions:
- NO modificar código todavía — esto es investigación.
- NO asumir la causa sin evidencia de la emulación — si la emulación tampoco reproduce nada raro, decirlo honestamente en vez de forzar una conclusión.

Estimado de ejecución (Claude Code + Sonnet 5, esfuerzo Medio): 1–1.5 horas.
