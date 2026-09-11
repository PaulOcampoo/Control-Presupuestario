Objective:
Corregir el botón "Filtrar" en las vistas "Programa de suministros" y "Seguimiento de materiales" (Requisiciones), y agregar un buscador de texto libre en ambas.

Starting State:
- Ambas vistas ya tienen filtros por dropdown/chip que sí funcionan (Obra, Estatus en Seguimiento; rango de fechas + Obra en Programa).
- Paul reporta que el botón "Filtrar" existe pero no hace nada visible — solo los chips de Estatus (Sin OC/Pendiente/Parcial/Completo) filtran de verdad.
- No hay buscador de texto en ninguna de las dos vistas.

Target State:

1. FASE 0 — Diagnóstico del botón "Filtrar" (hacer primero, reportar antes de decidir el fix):
   - Localizar en `public/app.js` el handler del botón "Filtrar" en ambas vistas. Confirmar si: (a) está muerto/sin `onclick` real, (b) aplica algo que ya se aplicó automáticamente al cambiar obra/fecha (por eso "no se nota"), o (c) tiene un bug real que impide que aplique el rango de fechas/obra.
   - Confirmar si Obra/Fecha ya filtran automáticamente al cambiar (`onchange`) sin necesitar el botón — si es así, el botón es redundante, no roto.

2. FIX según lo que confirme la Fase 0:
   - Si Obra/Fecha ya filtran automáticamente: eliminar el botón "Filtrar" (es ruido visual, no una función real) — dejar solo los campos de filtro y los chips de Estatus, que ya se aplican al cambiar.
   - Si el botón sí tenía una función real rota: corregirla para que aplique correctamente.

3. BUSCADOR (ambas vistas):
   - Agregar un input de texto (placeholder "Buscar insumo, código, folio..."), que filtre en tiempo real (sin botón adicional) sobre: nombre de insumo, código de insumo, folio de requisición, folio de OC, y concepto vinculado (cuando exista).
   - Filtra en combinación con los filtros ya existentes (Obra, Estatus, rango de fechas) — no los reemplaza.

Allowed Actions:
- Modificar `public/app.js` (las dos vistas).
- Bump `SW_VERSION`.

Forbidden Actions:
- NO modificar los endpoints backend — el buscador filtra sobre los datos ya traídos al cliente (ambas vistas ya cargan el dataset completo del periodo/obra seleccionada), no agregar un parámetro de búsqueda al servidor salvo que la Fase 0 revele que el dataset es demasiado grande para filtrar en cliente (en ese caso, pausar y reportar antes de decidir).
- NO quitar los chips de Estatus ni los filtros de Obra/Fecha que ya funcionan.

Stop Conditions:
- Si el dataset de alguna vista es grande (cientos de filas) y filtrar en cliente sería lento o poco práctico — pausar y proponer búsqueda server-side antes de implementar.

Checkpoints:
✅ Fase 0: conclusión clara de qué hacía (o no hacía) el botón "Filtrar" en cada vista, con snippet de código.
✅ Buscador probado en navegador real (Playwright + WebKit) en ambas vistas: filtra correctamente por insumo, código, folio de requisición, folio de OC.
✅ Confirmar que buscador + chips de Estatus + Obra combinados dan el resultado esperado (intersección, no solo el último filtro aplicado).
✅ Lista final de archivos modificados.

Estimado: esfuerzo Bajo — Claude Code + Sonnet 5, ~1-1.5 horas.
