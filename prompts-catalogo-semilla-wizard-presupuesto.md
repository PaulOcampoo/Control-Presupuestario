# Prompt 1 — Catálogo semilla de precios (histórico propio + CONAGUA)

**Estimado:** Claude Code + Sonnet 5, esfuerzo Medio-Alto (~3–4h, incluye Fase 0 diagnóstica)

```
Objective:
Construir una tabla de catálogo semilla de precios unitarios por concepto, poblada automáticamente desde (1) agregación de datos históricos propios en `conceptos` de proyectos reales, y (2) import programático del Catálogo General de Precios Unitarios de CONAGUA, con prioridad de fuente 1 sobre fuente 2.

Starting State:
- Tabla `conceptos` ya contiene, por proyecto real, columnas de grupo, descripción, unidad, precio_unitario (confirmar nombres exactos en Fase 0).
- No existe ninguna tabla de catálogo semilla ni proceso de agregación actualmente.
- El Catálogo General de Precios Unitarios de CONAGUA se publica en Excel/PDF descargable públicamente — no se ha descargado ni parseado antes en este sistema.
- El parser de import de Excel existente (usado para carga de presupuestos) puede servir de referencia de patrón, no reusarse directamente porque la estructura de columnas de CONAGUA es distinta.

Target State:

1. FASE 0 — DIAGNÓSTICO (obligatorio antes de codear):
   - Confirmar columnas exactas de `conceptos` disponibles para agregación (grupo, descripción, unidad, precio_unitario, proyecto_id, fecha)
   - Descargar y revisar la estructura real del archivo más reciente del Catálogo General de Precios Unitarios de CONAGUA (columnas, formato, si viene en Excel o requiere extracción de PDF)
   - Confirmar cuántos proyectos reales y cuántas filas de `conceptos` existen actualmente como base histórica (para saber si el agregado inicial va a tener cobertura razonable o va a depender casi todo de CONAGUA al inicio)
   - Reportar hallazgos antes de implementar

2. NUEVA TABLA: `catalogo_semilla`
   - Columnas: id, grupo, descripcion, unidad, precio_unitario, fuente ('historico' | 'conagua'), fecha_actualizacion
   - Un registro por combinación única de grupo+descripción+unidad

3. JOB DE AGREGACIÓN HISTÓRICA (fuente 1, prioridad alta):
   - Script/endpoint que recorre `conceptos` de todos los proyectos reales, agrupa por grupo+descripción+unidad, calcula precio unitario mediana (no promedio, para evitar distorsión por outliers)
   - Se puede ejecutar manualmente por ahora (no requiere ser automático/cron en esta primera versión) — confirmar con Paul si se agrega a Vercel Cron Jobs después
   - Inserta/actualiza en `catalogo_semilla` con `fuente = 'historico'`

4. IMPORT DE CONAGUA (fuente 2, fallback):
   - Parser que lee el archivo descargado de CONAGUA (formato confirmado en Fase 0) y lo normaliza a la estructura de `catalogo_semilla`
   - Solo inserta registros para combinaciones grupo+descripción+unidad que NO existan ya con `fuente = 'historico'` — nunca sobreescribe un precio histórico propio con uno de CONAGUA
   - Mapeo de categorías de CONAGUA a los `grupo` usados internamente (agua potable, sanitario, pluvial, descargas) — documentar el mapeo exacto usado

Allowed Actions:
- Crear la tabla `catalogo_semilla` vía `CREATE TABLE IF NOT EXISTS` en `server/db.js` (mismo patrón sin migraciones que usa el resto del schema)
- Crear nuevo módulo `server/catalogoSemilla.js` (o nombre equivalente) con las funciones de agregación e import
- Descargar el archivo público de CONAGUA y almacenarlo como referencia versionada en el repo (o Vercel Blob, confirmar en Fase 0 cuál es más apropiado)

Forbidden Actions:
- NO modificar la tabla `conceptos` existente ni su flujo de carga
- NO sobreescribir precios de fuente 'historico' con datos de CONAGUA bajo ninguna circunstancia
- NO exponer el job de agregación como endpoint público sin autenticación de admin

Stop Conditions:
Pausar y reportar si:
- El archivo de CONAGUA requiere OCR o extracción de PDF no trivial (evaluar costo/beneficio antes de invertir tiempo en parsing complejo)
- La cobertura de datos históricos es tan baja (pocos proyectos reales) que el agregado inicial no aporta valor real todavía

Checkpoints:
✅ Fase 0 reportada con estructura real de CONAGUA y volumen de datos históricos disponibles
✅ `catalogo_semilla` poblada y verificada con conteo de registros por fuente (historico vs conagua)
✅ Confirmado manualmente que ningún registro con fuente 'historico' fue sobreescrito por CONAGUA
✅ Lista final de archivos modificados con resumen de cada cambio
```

---

# Prompt 2 — Wizard "Crear presupuesto desde cero"

**Estimado:** Claude Code + Sonnet 5, esfuerzo Alto (~4–5h)
**Depende de:** Prompt 1 (requiere `catalogo_semilla` ya poblada)

```
Objective:
Agregar en Presupuestos la opción de crear un proyecto sin subir Excel, capturando el presupuesto renglón por renglón con ayuda del catálogo semilla, escribiendo directamente a la misma tabla `conceptos` que usa el import de Excel.

Starting State:
- Actualmente el único flujo para poblar `conceptos` de un proyecto es cargar un Excel.
- `catalogo_semilla` (Prompt 1) ya existe con precios de referencia por grupo+descripción+unidad.
- Todo el resto del sistema (Finanzas, Destajo, Avance, Mapeo) consume `conceptos` sin importar cómo se pobló.

Target State:

1. ENTRADA AL WIZARD:
   - En la pantalla de creación de proyecto, opción "Crear presupuesto desde cero" junto a la opción existente de "Cargar Excel"

2. UI DE CAPTURA:
   - Vista tipo hoja de cálculo: agregar renglón con selector de grupo, campo de descripción con autocompletado desde `catalogo_semilla` (al escribir, sugiere descripciones existentes y su precio unitario de referencia)
   - Al seleccionar una sugerencia, precarga unidad y precio unitario (editable — el usuario puede ajustar el precio si es distinto en su caso)
   - Si el usuario captura una descripción que no existe en `catalogo_semilla`, la deja en blanco/manual sin bloquear la captura
   - Cantidad y precio unitario calculan importe automáticamente; suma total visible en todo momento

3. GUARDADO:
   - Al guardar cada renglón, escribe a `conceptos` con la misma estructura exacta que produce el parser de Excel (mismos nombres de columna, mismo formato)
   - Al finalizar el wizard, el proyecto queda funcionalmente idéntico a uno cargado por Excel

4. RETROALIMENTACIÓN AL CATÁLOGO (opcional, evaluar en Fase 0 si se implementa en esta fase o después):
   - Cuando un usuario captura manualmente un precio que no existía en `catalogo_semilla`, considerar si ese dato debe alimentar el agregado histórico en la próxima corrida del job del Prompt 1

Allowed Actions:
- Crear nueva vista/wizard en frontend (`public/app.js` + HTML/CSS)
- Nuevo endpoint backend para guardar renglones capturados manualmente a `conceptos`
- Endpoint de autocompletado que consulta `catalogo_semilla` por texto parcial de descripción

Forbidden Actions:
- NO crear una tabla ni modelo de datos paralelo a `conceptos` — el destino debe ser exactamente el mismo
- NO modificar el parser de Excel existente
- NO tocar Finanzas, Destajo, Avance ni Mapeo — deben seguir funcionando sin cambios sobre proyectos creados por wizard

Stop Conditions:
Pausar y reportar si:
- El formato exacto de columnas que espera `conceptos` desde el parser de Excel no es directamente reproducible desde captura manual (ej. requiere metadata adicional que solo genera el parser)
- Se identifican más de 2 pantallas adicionales del sistema que necesiten ajuste para reconocer proyectos creados por wizard vs Excel

Checkpoints:
✅ Proyecto creado desde wizard queda con `conceptos` estructuralmente idéntico a uno cargado por Excel (verificado por comparación directa de filas)
✅ Autocompletado funcional contra `catalogo_semilla`, verificado con al menos 3 búsquedas de prueba (agua potable, sanitario, pluvial)
✅ Finanzas/Destajo/Avance probados sobre un proyecto de prueba creado por wizard, sin errores
✅ Lista final de archivos modificados con resumen de cada cambio
```
