# Fase 0 — Línea base (2026-09-29)

Sin cambios de código, sin deploy.

## Git
- Rama: `feat/selector-hora-jornada`, HEAD `e7ab878`. `origin/main..HEAD` está vacío tras `git fetch`: no hay commits ajenos que publicar (el commit del selector de hora ya está en `origin/main`).
- Árbol de trabajo con archivos tracked borrados (`prompt-*.md`, auditorías…) y untracked (`prompts/`, `README.md`, `NYRA LOGO ONLY.png`): ajenos a este trabajo, no se tocan. Stash `fix/checkpermiso-trabajadores` intacto.
- Usar `git add <rutas explícitas>` siempre.

## Service worker
- `CACHE` actual y máximo en `git log --all`: `ctrl-ppto-v533`. Próximo commit con código: `v534` o mayor.

## Entorno
- `.env` → `DATABASE_URL` apunta a `ep-noisy-shadow` (Preview), no a Producción. `npm test` escribe en Preview.

## Tests (`npm test`, dos corridas)
| Corrida | Archivos fallidos | Tests |
|---|---|---|
| 1 | 4 | 3 fallan, 656 pasan, 4 skipped |
| 2 | 5 | 8 fallan, 651 pasan, 4 skipped |

Los fallos cambian entre corridas (suites en paralelo contra la misma BD Preview). Fallos vistos: `generadores-obra-fotos`, `costos-catalogo-basicos`, `erogado-real-agregado`, `estimaciones-residente-ve-otras`, `fix-saldo-iva-5-lugares`, `generadores-obra-fase3-sugerencia-avance`. Varios son flakes ya conocidos. Criterio de regresión: comparar contra este conjunto y re-correr en aislado antes de culpar a una fase.

## CSP y fuentes
- `style-src 'self'` en `server/app.js:111` y en cada bloque de `vercel.json`.
- `public/index.html:20-22` sigue cargando Google Fonts (`fonts.googleapis.com`), que la CSP bloquea. Falta confirmarlo en DevTools de Producción (pendiente, requiere sesión real).
- `grep -c 'style="'`: `app.js` 24, `index.html` 0. No ampliar.

## Prototipo
- Copiado a `docs/rediseno/prototipo.html` (777 líneas) desde el artefacto publicado, porque `output/app-cp-rediseno-prototipo.html` no existe en este equipo.

## Pendiente de Fase 0
- Capturas "antes" en `docs/rediseno/baseline/` (carpeta creada, vacía): requieren login en la app y un navegador; no se hicieron.
- Verificar en Producción el bloqueo de Google Fonts.
