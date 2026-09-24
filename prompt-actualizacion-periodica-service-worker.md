Objective:
Agregar revisión periódica automática de actualizaciones del Service Worker (`registration.update()`), para que sesiones de PWA de larga duración no queden atascadas en versiones viejas de la app sin que el usuario tenga que cerrar/reabrir manualmente — causa raíz confirmada del caso de hoy (residente con app.js cacheado de ~40 días, sin ver Generadores de Obra ni otras features recientes).

Starting State (confirmado en diagnóstico):
- `public/app.js:15523-15537` ya registra el Service Worker con `skipWaiting()`/`clients.claim()` y fuerza un `reload()` automático cuando detecta `controllerchange`.
- El problema: nada dispara `registration.update()` mientras la app está abierta — el navegador solo revisa actualizaciones en eventos de navegación, así que una PWA dejada abierta/en segundo plano por semanas nunca detecta que hay una versión nueva.
- Función de debug ya existente `_dbgSwInfo()` (`public/app.js:27280`) lee `caches.keys()` — útil para verificar la versión activa antes/después del fix.

Target State:
- Agregar un `setInterval` (cada 30-60 min mientras la pestaña/app esté abierta y visible) que llame a `registration.update()` sobre el Service Worker ya registrado.
- Considerar también disparar `registration.update()` en el evento `visibilitychange` (cuando la app vuelve a primer plano tras estar en background) — cubre el caso común de PWA minimizada y reabierta, no solo dejada abierta en foreground.
- El flujo existente (`controllerchange` → `reload()` automático) no cambia — este fix solo hace que la revisión de "hay una versión nueva" ocurra con más frecuencia, no cambia qué pasa una vez que se detecta.
- Cuidado con no generar reloads inesperados/molestos para el usuario en medio de que esté llenando un formulario — confirmar si el `reload()` automático actual ya tiene alguna protección para eso (ej. esperar a que no haya inputs con cambios sin guardar) o si este fix debería agregar alguna advertencia mínima antes de recargar.

Allowed Actions:
- Modificar `public/app.js` (la lógica de registro del Service Worker).
- Bumpear `SW_VERSION`.

Forbidden Actions:
- NO cambiar el comportamiento de `skipWaiting()`/`clients.claim()` ni el flujo de `reload()` en `controllerchange` — solo agregar la revisión periódica que dispara ese flujo con más frecuencia.
- NO hacer el intervalo tan agresivo (ej. cada minuto) que genere tráfico innecesario — 30-60 min es razonable.

Stop Conditions:
- Si el `reload()` automático actual no tiene ninguna protección contra interrumpir a un usuario a medio capturar algo, pausar y preguntar si vale la pena agregar esa protección como parte de este mismo prompt o dejarlo para después (es un problema preexistente, no introducido por este fix, pero este fix lo hará ocurrir con más frecuencia).

Checkpoints:
✅ Verificación real: con el servidor sirviendo una versión nueva de `sw.js`, una pestaña abierta detecta y aplica la actualización dentro de la ventana del intervalo configurado, sin que el usuario recargue manualmente.
✅ Confirmar que no se generan actualizaciones/reloads duplicados o en loop.
✅ SW_VERSION bumpeado.

Estimado: Claude Code + Sonnet 5, esfuerzo Bajo — 30 a 45 min.
