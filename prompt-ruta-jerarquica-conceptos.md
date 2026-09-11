Objective:
Capturar la jerarquía completa de secciones del Excel de Presupuesto (hoy solo se guarda el nivel más interno en `conceptos.grupo`) en un nuevo campo `ruta_jerarquica`, poblarlo retroactivamente para las 7 obras reales sin reprocesar Excel, y mostrarlo en el modal "Por concepto" de Avance como breadcrumb compacto sobre el encabezado grande ya existente.

Starting State:
- `conceptos.grupo` guarda hoy solo el nivel más interno de sección (ej. "CALLE BARRANCAS"), perdiendo los niveles superiores (ej. "DS - RED SANITARIA").
- Diagnóstico confirmado: las filas de encabezado/total (`es_total=1`) ya están guardadas en `conceptos` con `codigo`, `concepto` y `orden` originales, nunca se descartan, solo se marcan — la jerarquía completa es 100% reconstruible con un algoritmo de pila (apilar al ver encabezado, desapilar al ver `TOTAL <mismo texto>`) corriendo sobre `conceptos ORDER BY orden`, sin tocar Excel ni Blob.
- Validado sin excepciones contra las 7 obras reales, con profundidad real de 4 a 7 niveles (no 2) — incluye casos de texto de sección repetido bajo padres distintos (ej. "CALLE BARRANCAS" bajo dos ramas distintas en la misma obra).
- Decisión de UI confirmada por Paul: mostrar la ruta completa como breadcrumb compacto (ej. "P CRNA F1 › CONDOMINIO AMANI › ESTACIONAMIENTO"), manteniendo el nivel más interno (`grupo`) como el único encabezado grande, igual que hoy — no apilar un `<h3>` por cada nivel.

Target State:

1. SCHEMA (`server/db.js`):
   - `ALTER TABLE conceptos ADD COLUMN IF NOT EXISTS ruta_jerarquica JSONB` — array ordenado nivel 1→N (ej. `["P CRNA F1_URBA...", "CONDOMINIO AMANI", "ESTACIONAMIENTO", "BASE"]`). El último elemento siempre coincide con `conceptos.grupo` (no se toca `grupo`, sigue siendo la fuente de verdad para todo lo que ya lo usa).
   - Agregar la misma columna en `CREATE TABLE` (además del `ALTER`), como exige la convención del proyecto.

2. BACKFILL (script de una sola corrida, no parte del flujo normal):
   - Implementar el algoritmo de pila descrito en el diagnóstico, correrlo sobre las 7 obras reales, poblar `ruta_jerarquica` en cada concepto real (no en filas `es_total=1`, esas no son conceptos consultables).
   - Verificar después: `ruta_jerarquica[-1]` debe coincidir con `grupo` para el 100% de los conceptos en las 7 obras — si no coincide en alguno, pausar y reportar el caso antes de continuar (ver Stop Conditions).
   - Este script se prepara para que **Paul lo corra manualmente contra producción** (patrón ya establecido: `BEGIN` → SELECT verify-before → UPDATE → SELECT verify-after → `COMMIT` manual en Neon SQL Editor) — Claude Code no ejecuta SQL en producción.

3. PARSER (`server/parser.js`, `parseBudgetConcepts()`):
   - Ajustar para que futuras importaciones generen `ruta_jerarquica` desde el inicio, usando el mismo algoritmo de pila en tiempo de parseo (ya se tiene la pila de encabezados abiertos al momento de leer cada concepto — no hace que hace falta re-derivarla después).

4. FRONTEND — modal "Por concepto" de Avance (`public/app.js:8679-8684`):
   - Mantener el agrupamiento visual actual por `grupo` (un `<h3>` grande por grupo, sin cambios en esa lógica).
   - Debajo de cada `<h3>` de grupo (o arriba, ubicación a criterio de menor esfuerzo de layout), agregar una línea pequeña de breadcrumb con los niveles superiores de `ruta_jerarquica` (todo menos el último elemento), separados por "›". Si `ruta_jerarquica` tiene solo 1 elemento (sin niveles superiores), no mostrar breadcrumb.

Allowed Actions:
- Modificar `server/db.js` (schema), `server/parser.js` (parser), `public/app.js` (modal de Avance).
- Preparar (no ejecutar) el script de backfill SQL para producción.
- Bump `SW_VERSION`.

Forbidden Actions:
- NO ejecutar el backfill en producción — solo prepararlo para que Paul lo corra manualmente.
- NO modificar `conceptos.grupo` ni ninguna lógica que ya lo consuma (export-catalogo-excel, Presupuesto vs Estimaciones, Catálogo de Conceptos en Costos, Mapeo, Destajo, Programa/Gantt) — esos siguen funcionando igual, sin tocarlos.
- NO asumir profundidad fija — el código debe soportar cualquier profundidad (1 a 7+ niveles observados) sin límite hardcodeado.

Stop Conditions:
- Si al validar el backfill contra las 7 obras reales, `ruta_jerarquica[-1]` no coincide con `grupo` en algún concepto — pausar, no forzar ni sobrescribir `grupo`, reportar el caso exacto.
- Si se encuentra algún encabezado sin su fila `TOTAL <mismo texto>` de cierre en alguna obra (el diagnóstico reportó 0 casos así, pero verificar de nuevo con el dataset completo antes de dar el algoritmo por universal) — pausar y reportar.

Checkpoints:
✅ Backfill (en Preview, no producción) corrido y verificado: `ruta_jerarquica[-1] = grupo` para el 100% de conceptos en las 7 obras reales, con output literal de la verificación.
✅ Script de backfill para producción entregado a Paul, sin ejecutarlo.
✅ Parser actualizado: importar un Excel de prueba (ej. re-parsear el de obra 42 en memoria, sin persistir) y confirmar que genera `ruta_jerarquica` idéntica a la reconstruida por el backfill.
✅ Modal de Avance verificado en navegador real (Playwright + WebKit) mostrando el breadcrumb correctamente en al menos una obra de profundidad 4 y una de profundidad 6-7 (13 o 36).
✅ Confirmar que ninguna pantalla existente que use `grupo` (export-catalogo-excel, Presupuesto vs Estimaciones, Costos, Mapeo, Destajo, Programa) cambió de comportamiento.
✅ vitest completo en serie, sin regresiones nuevas.
✅ Lista final de archivos modificados.

Estimado: esfuerzo Medio — Claude Code + Sonnet 5, ~3-4 horas.
