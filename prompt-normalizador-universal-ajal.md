Objective:
Construir un normalizador que detecte automáticamente el formato real de exportación "AJAL" (letterhead + metadata en filas 1-15, header de columnas variable en fila ~16, nombres de columna con sinónimos, filas jerárquicas de categoría mezcladas con partidas reales) y lo convierta al formato interno universal que ya consume el pipeline existente (el mismo shape que produce hoy parseArchivo4Hojas para archivos "estándar"), sin tocar el comportamiento actual para archivos que ya usan el formato estándar (hoja "Presupuesto" con header en fila 1).

Starting State:
- parseArchivo4Hojas (server/crearPresupuestoImport.js) asume: hoja llamada literalmente "Presupuesto"/"Destajo", header de columnas en fila 1, nombres de columna exactos (ENCABEZADOS_PRESUPUESTO), sin distinguir filas de categoría vs partidas reales.
- 4 archivos reales confirmados con el mismo problema estructural (diagnóstico ya hecho, NO repetir):
  - Nombres de hoja: "Directo AJAL"/"Estimacion AJAL" (Presupuesto), variantes de "Destajos", variantes de "Insumos", "Matrices" consistente.
  - Header real en fila 16 en los 4 archivos (no fila 1) — filas 1-15 son letterhead corporativo repetido + metadata (Cliente, Obra, Duración, Fecha, Lugar).
  - "P. Unitario" en vez de "Precio Unitario" (mismatch de texto de columna, independiente de la posición).
  - Filas jerárquicas de categoría/agrupador (ej. EPA, EPA1, EPA11 — código+concepto sin cantidad/precio) mezcladas con partidas reales que sí tienen cantidad/precio.
  - El mismo problema de letterhead se repite en las hojas de Destajos, Matrices e Insumos, no solo en Presupuesto.
- Archivos de muestra disponibles (colocar en tests/fixtures/catalogo-maestro/ si no están ya ahí de la tarea anterior): C_715_PCRNAURBA__Ajustado_Vinte_22072026.xlsx, EST_Kaila_Amenidades_01082026.xlsx, C_671_casa_club_31072026.xlsx, C686_PCRNAINFRACOLECTORE1_Vinte_22072026.xlsx.
- Dato crítico: esto es información financiera real que termina en presupuestos de obra — un falso positivo de parseo (fila mal clasificada, columna mal mapeada) puede corromper un presupuesto silenciosamente. Prioridad: fallar visiblemente ante ambigüedad, nunca adivinar.

Target State:

FASE 1 — Diagnóstico exhaustivo (antes de escribir el normalizador):
- Documentar, para cada uno de los 4 archivos y cada una de las 4 hojas (Presupuesto/Destajo/Insumos/Matrices), la fila exacta donde está el header real y el texto exacto de cada columna encontrada.
- Documentar cómo se distingue una fila de categoría/agrupador de una partida real en los datos observados (¿siempre cantidad vacía/0? ¿código con longitud o formato distinto, ej. "EPA1" vs un código numérico?).
- Si algún archivo tiene una estructura que no encaja con las demás, reportarlo como excepción antes de generalizar la regla.

FASE 2 — Detección de formato:
- Al cargar un archivo, intentar primero el parser estándar existente (comportamiento actual sin cambios). Si tiene éxito, usar ese resultado — archivos ya compatibles no deben pasar por el normalizador nuevo.
- Si el parser estándar no encuentra header/conceptos válidos, intentar detectar el formato AJAL por nombre de hoja (usando los candidatos ya identificados: "Directo AJAL", "Estimacion AJAL", variantes de "Destajos"/"Insumos" con prefijo, "Matrices").
- Si tampoco coincide ningún formato conocido, mantener el error actual pero incluir en el mensaje los nombres de hoja reales encontrados (ya contemplado en la tarea anterior si se retoma).

FASE 3 — Normalizador AJAL (por cada una de las 4 hojas):
- Localizador de fila de header por contenido: escanear las primeras ~25 filas buscando la fila donde aparezca la mayor cantidad de encabezados conocidos (por sinónimo, no exacto) — no asumir número de fila fijo.
- Mapa de sinónimos de columna (ampliable): precio_unitario ↔ "Precio Unitario"/"P. Unitario"/"P.U.", y equivalentes para código, concepto/descripción, unidad, cantidad, importe — basado en lo que confirme el diagnóstico de Fase 1.
- Clasificador de fila categoría vs partida: regla explícita basada en lo observado en Fase 1 (ej. cantidad y precio_unitario ambos vacíos/0 → categoría, se excluye de conceptos importables; puede usarse además para armar jerarquía visual si aporta valor, pero el conteo de "conceptos" real solo debe incluir partidas).
- Salida: mismo shape/estructura de datos que produce hoy parseArchivo4Hojas para un archivo estándar — el resto del pipeline (inserción en catalogo_conceptos/destajo/insumos/matrices) NO debe modificarse.
- Guardar en catalogo_archivos un campo `formato_detectado` ('estandar' | 'ajal') para trazabilidad y debugging futuro.

FASE 4 — Salvaguardas de integridad:
- Si el localizador de header encuentra más de una fila candidata con score similar (ambigüedad real), o si el número de partidas reales detectadas es 0 después de filtrar categorías, el archivo debe marcarse como estado='error' con un mensaje específico — nunca continuar con una interpretación adivinada.
- El flujo de preview-antes-de-confirmar ya existente en el sistema (patrón preview/confirm de "Crear presupuesto desde catálogo") debe aplicar también aquí: el usuario ve el resultado normalizado (conceptos detectados, con código/descripción/precio) antes de que se persista nada, para poder detectar visualmente un mal-parseo antes de que llegue a producción.

Allowed Actions:
- Crear un nuevo módulo (ej. server/normalizadorAjal.js) con la lógica de Fase 3, sin modificar el comportamiento de parseArchivo4Hojas para el formato estándar.
- Modificar catalogoMaestro.js para intentar el parser estándar primero, luego el normalizador AJAL como fallback.
- Agregar `formato_detectado` a catalogo_archivos (ALTER TABLE ADD COLUMN IF NOT EXISTS).
- Agregar los 4 archivos reales como fixtures permanentes de test.

Forbidden Actions:
- No adivinar mapeos de columna o filas de header cuando hay ambigüedad — fallar con mensaje claro es preferible a un import silenciosamente incorrecto (regla dura: esto es data financiera).
- No modificar el parser estándar existente ni el flujo de "Crear presupuesto desde catálogo" más allá del punto de entrada compartido.
- No persistir ningún dato normalizado sin pasar por el preview/confirm existente.
- No mezclar filas de categoría con partidas reales en el conteo/importe de conceptos.

Stop Conditions:
- Si en el diagnóstico de Fase 1 alguno de los 4 archivos tiene una estructura de header o de columnas que contradice el patrón encontrado en los otros 3, pausar antes de generalizar una sola regla — puede necesitarse una regla por sub-variante en vez de una universal.
- Si el clasificador de categoría-vs-partida no logra una regla confiable (>95% de precisión visible en los datos de muestra) basada solo en cantidad/precio vacíos, pausar y reportar qué otra señal se necesitaría (ej. formato del código, indentación, estilo de celda).
- Si el volumen de trabajo excede claramente el estimado, dividir en más de un PR (ej. Presupuesto+Destajo en uno, Insumos+Matrices en otro) y pausar entre cada uno.

Checkpoints:
✅ Diagnóstico de Fase 1 documentado — output literal de fila de header + columnas exactas encontradas por archivo y por hoja.
✅ Los 4 archivos reales importan exitosamente con conteos de conceptos/destajo/insumos/matrices razonables (output literal) — sin incluir ninguna fila de categoría como concepto.
✅ Archivos que ya funcionaban en formato estándar siguen funcionando idéntico (test de regresión).
✅ Al menos 1 caso de ambigüedad forzada (fixture sintético) demuestra que el sistema falla visiblemente en vez de adivinar.
✅ Verificación visual tuya en dispositivo real: subir un archivo AJAL real desde la UI, revisar el preview de conceptos detectados antes de confirmar, y validar que coincide con lo que esperarías del archivo original.

Estimado de ejecución (Claude Code + Sonnet 5, esfuerzo Medio): 6–9 horas, dividido en al menos 2 PRs secuenciales (Fase 1+2+normalizador de Presupuesto primero; Destajo+Insumos+Matrices después, una vez validado el patrón en la hoja más importante).
