Objective:
Diagnóstico de solo lectura para diseñar cómo capturar AMBOS niveles de encabezado jerárquico del Excel de Presupuesto (ej. "RS — DS RED SANITARIA" como nivel 1, "2 — CALLE BARRANCAS" como nivel 2), no solo el más anidado como hoy, para mostrarlos en el modal "Por concepto" de Avance.

Starting State:
- `parseBudgetConcepts()` (`server/parser.js:179-242`) detecta cualquier fila sin unidad/cantidad/precio (que no sea TOTAL) como `isGroupHeader`, guarda su texto en `currentGroup` (línea 214-216), y lo asigna a cada concepto siguiente (línea 226) hasta el próximo encabezado — sin distinguir nivel/profundidad, por lo que un encabezado nuevo siempre sobrescribe al anterior sin importar si es del mismo nivel o de uno más anidado.
- Confirmado con datos reales: en obra 24, "DS - RED SANITARIA" solo sobrevive en 1 concepto de 52 — el resto quedó con "CALLE BARRANCAS" (el nivel más interno).
- No se sabe todavía cómo distingue el Excel, estructuralmente, un encabezado de nivel 1 (ej. "RS") de uno de nivel 2 (ej. "2") — en la captura ambos están en la misma columna (A = código corto, B = descripción), sin indentación visible. Hay que confirmar si hay alguna señal real (formato de celda, longitud/patrón del código en columna A, negritas, combinación de celdas, número de columnas con datos) que permita diferenciarlos de forma programática.

Target State (solo investigación, reportar con evidencia — sin implementar todavía):

1. INSPECCIONAR EL EXCEL CRUDO (obra 24, y al menos 2 obras más si tienen estructura similar):
   - Abrir el archivo original (si sigue en Blob, o pedir que Paul confirme cuál usar) con una librería que exponga formato de celda (negritas, tamaño, combinación), no solo valores — determinar si hay una señal de nivel jerárquico distinguible.
   - Si no hay señal de formato: revisar si el patrón del código en columna A distingue niveles (ej. ¿los de nivel 1 son siempre letras tipo "RS"/"RP" y los de nivel 2 siempre números tipo "2"/"3"? ¿Es consistente en las 7 obras reales o varía?).

2. PROPUESTA DE SCHEMA:
   - Si se puede distinguir nivel de forma confiable: proponer cómo guardarlo en `conceptos` — ej. `grupo` (nivel más interno, ya existe) + `grupo_padre` (nuevo campo, nivel 1), o una estructura más genérica si se detectan más de 2 niveles en algún Excel real.
   - Confirmar cuántos niveles máximos existen realmente en las 7 obras (no asumir que siempre son 2).

3. RETROACTIVIDAD:
   - Confirmar si esto requiere reprocesar (re-parsear) los Excel ya importados de las 7 obras reales para poblar el nuevo campo, y si los archivos originales siguen disponibles en Blob para poder hacerlo sin pedirle a Paul que resuba nada (ya se confirmó antes que al menos la obra 42 y Obra749 sí sobrevivieron en Blob — verificar cuáles de las 7 obras reales tienen su Excel disponible).

4. IMPACTO EN LA VISTA:
   - Confirmar en `public/app.js` (modal "Por concepto" de Avance, línea ~8665-8684) cómo se renderiza hoy el agrupamiento por `grupo`, para dimensionar el cambio de mostrar también `grupo_padre` como un encabezado superior (ej. "DS - RED SANITARIA" arriba, "CALLE BARRANCAS" como subtítulo debajo, luego los conceptos).

Allowed Actions:
- Solo lectura: descargar y parsear (sin guardar) los Excel disponibles en Blob, leer código y schema.

Forbidden Actions:
- NO modificar código, schema, ni datos.
- NO asumir el patrón de niveles sin haberlo verificado contra al menos 2-3 obras reales.

Stop Conditions:
- Si no hay ninguna señal confiable (ni de formato ni de patrón de código) para distinguir niveles en algunas obras — reportarlo explícitamente; puede que la solución completa no sea 100% automatizable para todas las obras.

Checkpoints:
✅ Evidencia de cómo se distingue (o no) nivel 1 vs nivel 2 en el Excel crudo, con al menos 2-3 obras revisadas.
✅ Número máximo real de niveles de anidamiento encontrado.
✅ Propuesta concreta de campo(s) nuevo(s) en `conceptos`.
✅ Confirmación de qué obras reales tienen su Excel disponible en Blob para reprocesar sin pedirle nada a Paul.
✅ Punto exacto del modal de Avance donde se necesitaría el cambio de UI.

Estimado: esfuerzo Bajo-Medio — Claude Code + Sonnet 5, ~45-60 min.
