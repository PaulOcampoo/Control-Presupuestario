Objective:
Extender el parser de 4 hojas (parseArchivo4Hojas, usado tanto por "Crear presupuesto desde catálogo" como por Catálogo Maestro) para reconocer los nombres de hoja reales que usan los archivos de obra, en vez de exigir los nombres literales ("Presupuesto", "Destajo") que ningún archivo real usa. Con 4 archivos reales de distintas obras ya confirmado un patrón: la hoja de presupuesto siempre se llama "Directo AJAL" (o "Estimacion AJAL" en archivos de estimación), nunca "Presupuesto".

Starting State:
- parseArchivo4Hojas exige un nombre de hoja literal para Presupuesto ("Presupuesto") — falla con "El archivo no tiene una hoja 'Presupuesto' con al menos 1 concepto." en cualquier archivo real.
- DESTAJO_SYNONYMS ya existe y maneja variantes para la detección de destajo en otro contexto (Nómina) — revisar si es reusable aquí o es un sistema distinto.
- 4 archivos reales de muestra disponibles (adjuntos a esta tarea, colócalos en una carpeta de fixtures de test, ej. tests/fixtures/catalogo-maestro/):
  - C_715_PCRNAURBA__Ajustado_Vinte_22072026.xlsx → ['Contrato', 'Directo AJAL', ' Destajos', 'Matrices', 'Insumos']
  - EST_Kaila_Amenidades_01082026.xlsx → ['Estimacion AJAL', 'Directo AJAL', 'Destajos', 'Matrices', 'Insumos ']
  - C_671_casa_club_31072026.xlsx → ['Contrato', 'Directo AJAL', 'Destajos', 'Matrices', 'e)Listado Insumos (E)']
  - C686_PCRNAINFRACOLECTORE1_Vinte_22072026.xlsx → ['Contrato', 'Directo  AJAL' (doble espacio), 'i)Catálogo Destajos', 'Matrices', 'e)Listado Insumos (E)']
- Patrón observado: "Matrices" es consistente literal en los 4. "Presupuesto" nunca aparece — siempre es "Directo AJAL" o "Estimacion AJAL". "Destajos"/"Insumos" varían en espacios y prefijos tipo "i)"/"e)".
- Archivos existentes que ya se importaron exitosamente usaban el nombre literal "Presupuesto" — backward compatibility obligatoria.

Target State:
1. DIAGNÓSTICO PRIMERO: antes de tocar el parser, revisar las columnas reales de "Directo AJAL" en los 4 archivos de muestra y confirmar que la estructura de columnas (código, descripción, unidad, cantidad, precio unitario, etc.) es consistente con lo que el parser ya sabe leer de una hoja "Presupuesto" — si las columnas también difieren, este prompt no alcanza y hay que reportarlo como stop condition antes de escribir código.
2. Reconocimiento de nombre de hoja por candidatos + trim, no por substring difuso (para evitar falsos positivos):
   - Presupuesto: coincide (trim + case-insensitive) con cualquiera de: "Presupuesto", "Directo AJAL", "Estimacion AJAL", "Estimación AJAL".
   - Destajo: coincide (trim + case-insensitive) con cualquiera de: "Destajo", "Destajos", o termina en "Destajos" ignorando un prefijo tipo "i)" (ej. "i)Catálogo Destajos") — usar una regla explícita, no un contains() genérico que pueda matchear hojas no relacionadas.
   - Insumos: coincide (trim + case-insensitive) con cualquiera de: "Insumos", o termina en "Insumos (E)" ignorando prefijo tipo "e)Listado ".
   - Matrices: se mantiene exacto "Matrices" (ya consistente en las 4 muestras).
3. Si el archivo tiene una hoja "Estimacion AJAL" en vez de "Directo AJAL", marcar el registro importado con un flag/nota (ej. tipo_origen = 'estimacion') visible en la UI de Catálogo Maestro — un archivo de estimación puede no representar el presupuesto definitivo, y el usuario debería poder distinguirlo al buscar/seleccionar conceptos.
4. Si ninguna hoja del archivo coincide con los candidatos de Presupuesto, mantener el mensaje de error actual pero listar los nombres de hoja reales encontrados en el archivo, para que el usuario pueda reportarlo mejor la próxima vez.
5. Probar contra los 4 archivos de muestra reales — deben pasar todos.

Allowed Actions:
- Modificar parseArchivo4Hojas (o extraer la lógica de matching de nombre de hoja a un helper nuevo, ej. resolverNombreHoja()).
- Agregar los 4 archivos reales como fixtures de test.
- Agregar campo tipo_origen a catalogo_archivos si no existe (ALTER TABLE ADD COLUMN IF NOT EXISTS).

Forbidden Actions:
- No romper la detección de archivos que ya usan el nombre literal "Presupuesto"/"Destajo" — deben seguir funcionando igual.
- No usar matching difuso tipo `.includes('destajo')` sin acotar — podría matchear hojas no relacionadas en archivos futuros con nombres distintos.
- No modificar el flujo de "Crear presupuesto desde catálogo" más allá de lo necesario para compartir el parser corregido.

Stop Conditions:
- Si las columnas internas de "Directo AJAL"/"Estimacion AJAL" no son estructuralmente equivalentes a lo que el parser espera de "Presupuesto" (headers distintos, orden distinto), pausar — este prompt asume que el problema es SOLO el nombre de la hoja, no su contenido.
- Si aparece un 5to nombre de variante no contemplado aquí al revisar los archivos de muestra con más detalle, pausar y confirmar la regla antes de codificarla.

Checkpoints:
✅ Diagnóstico de columnas de "Directo AJAL" vs "Presupuesto" esperado — output literal confirmando estructura compatible (o reportando incompatibilidad).
✅ Los 4 archivos de muestra reales importan exitosamente al Catálogo Maestro — output literal de estado='procesado' y conteo de conceptos para cada uno.
✅ Archivos que ya funcionaban con nombre literal "Presupuesto" siguen funcionando (test de regresión).
✅ Verificación visual tuya en dispositivo real: subir al menos 1 de los 4 archivos reales desde la UI y confirmar que aparece correctamente.

Estimado de ejecución (Claude Code + Sonnet 5, esfuerzo Medio): 2–3 horas.
