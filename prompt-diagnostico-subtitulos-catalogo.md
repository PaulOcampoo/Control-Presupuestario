Objective:
Diagnóstico de solo lectura: determinar si el subtítulo/partida jerárquica de cada concepto (ej. "CALLE BARRANCAS" bajo "RS - DS RED SANITARIA", ver captura del Excel) se captura hoy en algún lado al importar el Presupuesto, y ubicar todas las pantallas/exports que muestran el catálogo de conceptos sin ese dato.

Starting State:
- El Excel de Presupuesto tiene una jerarquía de encabezados de sección (ej. fila "RS | DS - RED SANITARIA", luego "2 | CALLE BARRANCAS", luego los conceptos individuales de esa calle, luego una fila "TOTAL CALLE BARRANCAS", luego la siguiente sección) — ver captura adjunta de Paul.
- El parser de conceptos (`parseBudgetConcepts()`, `server/parser.js:179`) ya filtra filas sin `cantidad > 0` / `unidad` vacía para evitar leer pies de página como conceptos (aprendizaje del bug corregido en "Presupuesto vs Estimaciones") — hay que confirmar si ESTE MISMO filtro está también descartando, sin guardarlas en ningún lado, las filas de encabezado de sección tipo "2 | CALLE BARRANCAS" y "RS | DS - RED SANITARIA".
- Ya existe un campo "Grupo" en `conceptos` (visto en catálogo: valores BASE/ADITIVA) — confirmar si es lo mismo que este subtítulo jerárquico o es un campo distinto y no relacionado.
- Vista de Avance (captura de Paul) SÍ agrupa visualmente por "CALLE BARRANCAS" — confirmar de dónde saca ese agrupamiento (¿del mismo campo `Grupo`, de otro campo, o de un cálculo/parseo distinto al de conceptos?).

Target State (solo investigación, reportar con evidencia):

1. PARSER — ¿se captura la jerarquía de secciones?
   - Revisar `parseBudgetConcepts()` completo: ¿lee y guarda en algún campo (`grupo`, `partida`, `subtitulo`, u otro) el texto de las filas de encabezado de sección (ej. "CALLE BARRANCAS", "DS - RED SANITARIA")? ¿O las descarta junto con las filas de totales?
   - Si se guardan: ¿en qué columna de `conceptos` viven, y qué relación tienen con el campo `Grupo` (BASE/ADITIVA) ya visto en el catálogo?

2. VISTA DE AVANCE — fuente del agrupamiento visible:
   - Confirmar en `public/app.js` de dónde saca la vista de Avance el título de sección "CALLE BARRANCAS" que sí muestra correctamente. Si usa un campo que el catálogo/export NO está leyendo, es el fix más simple (reutilizar el mismo dato).

3. UBICAR TODAS LAS PANTALLAS/EXPORTS DEL "CATÁLOGO DE CONCEPTOS":
   - Listar cada lugar del sistema donde se muestra una lista plana de conceptos sin el subtítulo de sección: pantalla de Presupuesto, `export-catalogo-excel` (hoja "Catálogo"), y cualquier otro que exista.

4. SI NO SE CAPTURA HOY:
   - Confirmar si es recuperable sin re-importar (¿el texto de sección quedó en algún lado aunque no estructurado?), o si requiere ajustar el parser y volver a importar los presupuestos existentes para poblar el dato retroactivamente.

Allowed Actions:
- Solo lectura: código, schema, datos.

Forbidden Actions:
- NO modificar código ni datos.

Stop Conditions:
- Ninguna — reportar hallazgos y esperar instrucción antes de diseñar el fix.

Checkpoints:
✅ Confirmación explícita: ¿el subtítulo de sección se captura hoy en `conceptos`, y en qué campo?
✅ Fuente exacta que usa la vista de Avance para mostrar "CALLE BARRANCAS" correctamente.
✅ Lista de todas las pantallas/exports de catálogo de conceptos que hoy no muestran el subtítulo.
✅ Si falta el dato: ¿recuperable de datos ya importados, o requiere cambio de parser + re-importación?

Estimado: esfuerzo Bajo — Claude Code + Sonnet 5, ~30-45 min.
