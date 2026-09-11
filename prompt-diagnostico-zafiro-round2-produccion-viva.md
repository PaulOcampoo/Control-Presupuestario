Objective:
El diagnóstico anterior confirmó que Producción sirve `app.js`/`styles.css` con el código de Zafiro presente (vía curl), pero Paul confirma que tampoco aparece en una ventana de incógnito nueva contra la URL real de producción — descarta 100% caché de navegador/Service Worker. Investigar la causa real viendo la app en vivo, no solo el archivo estático.

Starting State:
- `curl` directo a producción confirmó `sw.js` en v420 y presencia literal de `data-palette-set="azul"` / texto "Tema ZAFIRO" en `app.js`.
- Paul probó en incógnito (sin caché posible) contra `controlpresupuestario-altium.vercel.app` y el selector de Ajustes solo muestra 4 paletas (Roforb, Nyra, Jade, Terra) — captura adjunta confirma esto.
- Esto descarta caché — el problema debe estar en algo que impide que ese botón se renderice en tiempo real, a pesar de que el código existe en el archivo servido.

Target State:
1. Usar Playwright contra la URL REAL de producción (no local, no Preview) en modo incógnito real (contexto nuevo sin storage previo), login real, abrir el modal de Ajustes, y capturar:
   - El HTML real del DOM en la sección de "Apariencia" — ¿el botón de Zafiro existe en el DOM pero oculto (CSS `display:none`/condición), o simplemente no se renderiza en absoluto?
   - Errores de consola al cargar la página o al abrir Ajustes.
   - El contenido REAL de `app.js` tal como lo recibió el navegador en esa sesión (no un curl aparte, sino lo que Playwright realmente cargó) — comparar con lo que el curl anterior reportó, por si hay alguna diferencia (ej. CDN edge cache de Vercel sirviendo una versión distinta a la que responde curl directo, dependiendo de la región/edge).
2. Buscar en el código si el renderizado de las opciones de paleta depende de alguna condición (rol de usuario, flag de configuración, versión de `localStorage` con lista vieja de paletas cacheada en el propio storage de la app, no del Service Worker) que impida mostrar una paleta nueva a pesar de que el código exista.
3. Confirmar si existe algo en `localStorage`/`indexedDB` de la app (no el Service Worker) que guarde una lista de paletas disponibles de una carga anterior, y que no se actualice dinámicamente.

Allowed Actions:
- Playwright contra la URL real de producción, con login real, contexto de navegador limpio (sin storage previo).
- `curl` adicional si hace falta, considerando el CDN edge de Vercel (probar múltiples requests, revisar headers de cache como `x-vercel-cache`/`age`).
- Leer código relevante de dónde se renderiza el selector de paletas.

Forbidden Actions:
- NO modificar código todavía — esto sigue siendo diagnóstico.
- NO tocar Producción de forma destructiva (solo lectura/navegación).

Checkpoints:
✅ Confirmación literal (HTML real capturado) de si el botón de Zafiro existe en el DOM renderizado en producción o no.
✅ Errores de consola, si los hay.
✅ Confirmación de si hay una fuente de caché adicional (CDN edge, localStorage de la app) distinta al Service Worker ya descartado.
✅ Causa raíz identificada con evidencia, no supuesta.

Estimado: ~15-20 min con Claude Code (Sonnet 5, esfuerzo Medio).
