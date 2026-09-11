Objective:
Implementar el Caso 2 del diseño ya aprobado (docs/fase0-importador-matrices-casos-no-soportados.md): cuando un renglón de "BASICOS" en la hoja de Matrices tiene un código de cuadrilla pre-agregada sin desglose por oficio (ej. `1A5P` = "CUADRILLA No 22 (1 ALBAÑIL + 5 PEONES)"), leer el precio total directo de la hoja (columna de precio, ej. $5,218.31 para 1A5P) en vez de abortar el bloque — guardarlo como "mano de obra sin desglosar", marcado visualmente para que alguien lo desglose por oficio después si lo necesita.

Starting State (diseño aprobado en Fase 0, ya confirmado con evidencia real):
- Confirmado contra `Ppto_Catalogo_Terracerias_Temixco_03092026.xlsx`: fila real `1A5P | CUADRILLA No 22 (1 ALBAÑIL + 5 PEONES) | JOR | 5218.31 | / | 12 | 434.86` — el precio total real de la cuadrilla SÍ está en la hoja, el importador hoy lo ignora porque asume que el precio siempre sale del catálogo de insumos.
- Confirmado con el fix de Parte A (ya en main): un bloque no resuelto ya NO aborta la obra completa — este mismo Excel real ya demostró 5 bloques Caso 2 (`1H1A`, `1A1P-U`, `1T1A-U`, etc.) que hoy caen a `matrices_no_resueltas` sin bloquear nada más. Este prompt busca que esos bloques específicos, cuando cumplan el patrón de cuadrilla pre-agregada con precio disponible, SÍ se resuelvan automáticamente en vez de quedar pendientes.
- Patrón a detectar: código no existe en el catálogo de insumos, aparece en una fila de "BASICOS" (o sección equivalente) con un precio/costo total directo en la misma fila, nombre que sugiere cuadrilla (contiene "CUADRILLA" o un patrón similar — confirmar el criterio exacto usado ya en la detección actual del error, `matricesImport.js`).

Target State:
1. En `server/matricesImport.js`: cuando `resolverBloqueImportacion` encuentre un código de este patrón (cuadrilla pre-agregada, no existe en catálogo, tiene precio directo en la fila), en vez de marcarlo como no resuelto, crear/usar ese precio como el costo del renglón de mano de obra en la matriz — marcado con un flag o nota (ej. `sin_desglosar: true`) para diferenciarlo de un renglón con oficio real desglosado.
2. Confirmar cómo se refleja visualmente esto para el usuario (ej. en la vista de Matrices/Composición de Costos, el renglón "mano de obra sin desglosar" debe verse distinto a un desglose normal por oficio — ej. badge o texto explicativo).
3. Los 5 bloques ya identificados en el Excel real (`1H1A`, `1A1P-U`, `1T1A-U`, y los otros 2) deben pasar de "no resuelto" a resueltos automáticamente con este fix — verificar cada uno específicamente, no solo el caso `1A5P` ya conocido.
4. Bump de `SW_VERSION`.

Allowed Actions:
- Modificar `server/matricesImport.js` y cualquier vista de frontend (`public/app.js`) que muestre el resultado de matrices/composición de costos, si hace falta reflejar el flag "sin desglosar".
- Levantar app local contra Preview, verificar con Playwright/WebKit subiendo el Excel real completo (`Ppto_Catalogo_Terracerias_Temixco_03092026.xlsx`) por la UI real (no mocks) — confirmar que los 5 bloques Caso 2 ya no caen en `matrices_no_resueltas`, y que sus matrices se generan con el precio correcto.
- Limpiar cualquier dato de prueba (proyecto/cliente temporal) al finalizar.
- Bumpear `SW_VERSION`.

Forbidden Actions:
- NO inventar ni inferir un desglose por oficio que no existe en el Excel — el renglón se guarda como costo agregado, explícitamente marcado como tal, nunca presentado como si fuera un desglose real.
- NO tocar el Caso 1 (ya resuelto en Parte A) ni la garantía de integridad transaccional.
- NO tocar Producción, NO commit a main.

Stop Conditions:
- Si el patrón de detección de "cuadrilla pre-agregada" resulta ambiguo contra otros códigos reales del catálogo (falsos positivos: un insumo real que por casualidad no está en el catálogo pero no es una cuadrilla) — pausar y reportar antes de aplicar el fix de forma demasiado amplia.

Checkpoints:
✅ Los 5 bloques Caso 2 del Excel real (`1A5P`, `1H1A`, `1A1P-U`, `1T1A-U`, y el 5to) resueltos automáticamente, verificado uno por uno, no solo en agregado.
✅ Precio de cada matriz generada coincide con el valor real de la hoja (evidencia literal, no aproximado).
✅ Marca visual "sin desglosar" confirmada en la vista correspondiente.
✅ `matrices_no_resueltas` en la respuesta de alta de obra baja a 0 (o solo patrones genuinamente distintos, si los hay) para este Excel real.
✅ SW_VERSION bumpeado, confirmado vía curl real.
✅ Branch lista para PR, sin commit a main.

Estimado: ~30-40 min con Claude Code (Sonnet 5, esfuerzo Medio) — según el estimado ya validado en Fase 0.
