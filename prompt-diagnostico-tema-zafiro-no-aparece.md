Objective:
Diagnosticar por qué "Tema ZAFIRO" no aparece en el selector de paletas de Ajustes (captura de Paul: solo se ven Grupo Roforb, Nyra, Jade, Terra) a pesar de que PR #218 ya está mergeado a main. Sospecha principal: el conflicto de merge entre PR #218 y #219 (resuelto en SW_VERSION → v420) pudo haber perdido código de la paleta durante la resolución manual del conflicto.

Starting State:
- PR #218 (Tema Zafiro) y PR #219 (contraste link 2FA) ambos mergeados a main, con conflicto de SW_VERSION resuelto a v420 durante el merge de #219.
- Captura de Paul: modal de Ajustes en Producción (o Preview, confirmar cuál) muestra solo 4 paletas, sin Zafiro.

Target State:
1. Confirmar en `main` actual (`git log`, `git show`) que el código de la paleta Zafiro (CSS custom properties `[data-palette="zafiro"]` o el nombre real usado, y la entrada correspondiente en el selector de `public/app.js`) sigue presente después de ambos merges — comparar contra el commit original de PR #218 antes del merge de #219, para confirmar si algo se perdió en la resolución del conflicto.
2. Si el código SÍ está presente en `main`: confirmar si el problema es de caché — verificar `SW_VERSION`/`CACHE` real servido en el ambiente donde Paul lo vio (Preview o Producción) vía `curl`, y si coincide con v420. Si no coincide, el deploy pudo no haber completado o el Service Worker del navegador de Paul sigue sirviendo una versión vieja cacheada.
3. Si el código NO está presente (se perdió en el merge): identificar exactamente qué se perdió y prepararlo para re-agregar (sin implementar el re-fix todavía si requiere más que restaurar lo ya construido — solo diagnosticar).
4. Confirmar en qué ambiente vio Paul la captura (¿Preview o Producción?) — si es Producción, confirmar que el deploy de Vercel asociado al merge de main realmente completó exitosamente.

Allowed Actions:
- `git log`, `git show`, `git diff` contra los commits relevantes.
- `curl` contra Preview y Producción para confirmar `SW_VERSION` real servido.
- Leer `public/app.js`/`public/styles.css` actual en `main`.

Forbidden Actions:
- NO modificar código todavía — esto es diagnóstico.
- NO tocar Producción.

Checkpoints:
✅ Confirmación de si el código de Zafiro sigue en `main` intacto o se perdió en el merge, con evidencia de diff.
✅ Confirmación de `SW_VERSION` real servido en el ambiente donde Paul lo vio, vía curl.
✅ Causa raíz identificada: pérdida de código en merge, caché no actualizado, o deploy no completado.

Estimado: ~10-15 min con Claude Code (Sonnet 5, esfuerzo Medio).
