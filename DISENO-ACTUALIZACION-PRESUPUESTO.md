# Diseño: actualización de presupuesto preservando avance (Fase 1)

Estado: aprobado por Paul el 2026-07-21. Las 2 decisiones abiertas del §8
quedaron confirmadas — ver nota al final del documento.

## 1. Endpoint real de importación hoy

`POST /api/projects` (`server/app.js:1793`). Flujo actual:
1. Recibe `{ cliente_id, archivo_url, archivo_nombre }` — el Excel ya fue
   subido a Vercel Blob por el frontend antes de esta llamada.
2. Descarga el blob a un archivo temporal, lo parsea con `parseWorkbook()`.
3. Crea un registro de proyecto nuevo (`db.createProjectRecord`).
4. Llama a `ingest(client, record.id, parsed)` (`server/ingest.js`) dentro
   de una transacción, que hace `INSERT` masivo (batch) en: `meta`,
   `conceptos`, `insumos`, `programa_ejecucion`, `avances_semanales`, y
   (si aplica) `destajistas`/`destajo_items`.

Hoy **siempre** trata la carga como proyecto nuevo — no hay ningún camino
de "actualizar sobre un proyecto existente". No hay reconciliación ni
emparejamiento de ningún tipo.

## 2. Estructura real de `conceptos`

Confirmado en `server/db.js:35-47` (schema) y verificado contra Postgres
real — sin ningún `ALTER TABLE conceptos` posterior en todo el archivo, es
decir estas son literalmente todas las columnas que existen hoy:

```sql
CREATE TABLE conceptos (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
  codigo TEXT,
  concepto TEXT NOT NULL,
  unidad TEXT,
  cantidad DOUBLE PRECISION DEFAULT 0,
  precio_unitario DOUBLE PRECISION DEFAULT 0,
  importe DOUBLE PRECISION DEFAULT 0,
  grupo TEXT,
  es_total INTEGER DEFAULT 0,
  orden INTEGER DEFAULT 0
);
```

- **Sí existe `codigo`** (TEXT, nullable) — se puede usar para
  emparejamiento por código tal cual pide la regla 1.
- **Sin `UNIQUE` en `(project_id, codigo)`** — nada a nivel de DB impide
  códigos duplicados dentro del mismo proyecto hoy. Riesgo real a
  contemplar en el diseño (ver §6).
- **No existe ninguna columna de estado/activo reutilizable.** Se
  necesitaría una columna nueva para marcar "histórico".
- `es_total = 1` marca filas especiales de "TOTAL" (usadas por
  `presupuestoTotalDe()`, ver §5) — no son conceptos de trabajo real, hay
  que excluirlas del emparejamiento.

## 3. La pregunta crítica: ¿snapshot o on-the-fly?

**Confirmado con evidencia de código Y verificación empírica: es
on-the-fly, NO hay snapshot de precio.**

`avance_conceptos` (`server/db.js:111-118`) solo guarda:
```sql
CREATE TABLE avance_conceptos (
  id SERIAL PRIMARY KEY,
  semana INTEGER NOT NULL,
  concepto_id INTEGER NOT NULL REFERENCES conceptos(id) ON DELETE CASCADE,
  cantidad_ejecutada DOUBLE PRECISION DEFAULT 0,
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (semana, concepto_id)
);
```

Ni precio ni monto — solo cantidad. Todo lugar que necesita el monto
valorizado hace `JOIN conceptos c ON c.id = ac.concepto_id` y multiplica
por `c.precio_unitario` **actual** en el momento de la consulta (ejemplo
real, `server/app.js:3796`):

```sql
SELECT COALESCE(SUM(ac.cantidad_ejecutada * c.precio_unitario), 0) AS importe
FROM avance_conceptos ac JOIN conceptos c ON c.id = ac.concepto_id
WHERE c.project_id = $1 AND ac.semana <= $2
```

Verificado empíricamente en Postgres efímero (no solo por lectura de
código): sembré un concepto con `precio_unitario=50`, capturé avance de 40
unidades (importe esperado 2000), cambié `precio_unitario` a 80 **sin
tocar `avance_conceptos`**, y el mismo query volvió a leer **3200**
(40×80) — confirma que el monto se recalcula solo. Mismo experimento con
`cantidad` (volumen): al duplicarla de 100 a 200 sin tocar
`avance_conceptos`, el `%` cayó de 40% a 20% automáticamente.

**Consecuencia directa para el diseño:** las reglas 3 (revaluar al precio
nuevo) y 5 (recalcular % contra volumen nuevo) **ya pasan solas, sin
ningún código adicional**, en el momento en que el UPDATE a
`conceptos.precio_unitario`/`conceptos.cantidad` se aplique. No hace falta
ninguna migración ni recálculo de filas de `avance_conceptos` — es
inherente al modelo de datos actual.

## 4. `destajo_items` y `concepto_insumos`

- **`destajo_items.precio_destajo` confirmado independiente** de
  `conceptos.precio_unitario` — en `server/ingest.js:78-89`, el precio de
  destajo viene del Excel de destajistas o de un fallback separado
  (`parsed.destajoPrecios`), nunca de `conceptos.precio_unitario`. No hay
  nada que tocar ahí.
- **`concepto_insumos`** (`server/db.js:65-70`) tiene
  `concepto_id REFERENCES conceptos(id) ON DELETE CASCADE`. Un concepto
  marcado como histórico (nunca borrado, solo marcado) puede quedarse con
  su mapeo de insumos intacto sin ningún problema — no hace falta
  desvincular nada. (De paso: esta misma cláusula `ON DELETE CASCADE`, y
  la de `avance_conceptos`, es la razón técnica por la que un `DELETE`
  físico de un concepto viejo sería catastrófico — se llevaría su avance
  histórico y su mapeo de insumos con él. Confirma por qué la regla 2 de
  Paul es correcta y no negociable a nivel de implementación.)

## 5. Hallazgo adicional no contemplado en el prompt original: `presupuestoTotalDe()`

`server/finanzas.js:16-23` — el total de presupuesto usado para calcular
`avance_financiero_real` (%) prioriza un valor **cacheado** en la tabla
`meta` (`meta.total_sin_iva`), y solo si no existe cae a sumar la fila
`conceptos` con `es_total=1`. Este valor de `meta` se escribe una sola vez
al importar (dentro de `ingest()`, vía la fila `meta` que trae el Excel
parseado) y **no se recalcula automáticamente** si el conjunto de
conceptos cambia después.

**Esto significa que si el diseño de Fase 2 no actualiza también
`meta.total_sin_iva` (o la fila `es_total=1`) al aplicar una
reintegración de presupuesto, el `%` financiero global quedaría calculado
contra un total viejo** — aunque el importe ejecutado por concepto sí se
recalcule solo (§3). Es una inconsistencia real que el diseño debe cerrar
explícitamente.

Relacionado: la caché `avances_semanales.avance_fisico_real` /
`avance_financiero_real` (columnas de la tabla semanal, no de
`avance_conceptos`) solo se refresca cuando alguien vuelve a guardar
avance de esa semana (`PUT /api/projects/:id/avances/:semana/conceptos`,
línea 3792-3806). Tras aplicar una reintegración de presupuesto con
cambios de precio/volumen, esas columnas cacheadas de semanas **ya
cerradas** quedarían desactualizadas hasta que alguien vuelva a tocar esa
semana — el detalle por concepto (fuente de verdad real) sí estaría
correcto en todo momento porque se calcula on-the-fly, pero el resumen
semanal cacheado no. El diseño debe decidir si esto se recalcula
explícitamente para todas las semanas con avance capturado como parte de
aplicar la actualización, o si se documenta como limitación aceptada.

## 6. Diseño propuesto

### 6.1 Columna nueva

Agregar `activo INTEGER DEFAULT 1` a `conceptos` (patrón
`ALTER TABLE conceptos ADD COLUMN IF NOT EXISTS activo INTEGER DEFAULT 1`,
consistente con el resto del schema). Un concepto histórico se marca
`activo = 0`; nunca se borra. Todas las consultas de presupuesto activo
(listado de conceptos para captura de avance, cálculo de
`presupuestoTotalDe`, etc.) deben filtrar `activo = 1`. Las consultas de
avance histórico (`avance_conceptos` vía `concepto_id`) **no** deben
filtrar por `activo` — el historial de un concepto desactivado sigue
siendo válido y consultable.

Elegí `activo` (booleano invertido de "histórico") en vez de
`historico`/`estado` porque es el mismo patrón léxico que ya usa
`estimaciones.activo` en este mismo schema (soft-delete vía `activo`,
visto en `server/db.js:752`) — consistencia con una convención ya
establecida en el proyecto, no una nueva.

### 6.2 Endpoint nuevo vs. extender el existente

**Propongo un endpoint nuevo dedicado**:
`POST /api/projects/:id/presupuesto/actualizar`, en dos pasos
(preview + confirmar), en vez de extender `POST /api/projects`.

Justificación: `POST /api/projects` crea un proyecto desde cero (incluye
`db.createProjectRecord`, genera `programa_ejecucion`/`avances_semanales`
completos vía `generatePlanning()`, etc.) — mezclar ahí un modo
"actualización sobre proyecto existente" obligaría a bifurcar casi toda la
función con condicionales, y el flujo de reconciliación (emparejar, calcular
preview, requerir una segunda confirmación explícita) es conceptualmente
distinto de una carga inicial. Un endpoint separado, en el archivo de
proyecto existente (`:id` ya presente en la URL, como el resto de rutas de
proyecto), es más limpio y más fácil de proteger con
`checkPermiso('presupuestos', ...)` de forma independiente si en el futuro
se decide dar ese permiso a un rol que no debería poder crear proyectos
nuevos desde cero.

### 6.3 Flujo propuesto (dos llamadas: preview + confirmar)

**Paso A — `POST /api/projects/:id/presupuesto/actualizar/preview`**
Recibe `{ archivo_url }` (mismo patrón: Excel ya subido a Blob por el
frontend). Descarga, parsea con el mismo `parseWorkbook()` ya existente
(reutilizado, sin duplicar lógica de parseo). Con los conceptos parseados:

1. Trae los conceptos activos actuales del proyecto (`activo=1 AND
   es_total=0`).
2. Empareja: primero por `codigo` (si el Excel nuevo trae código Y el
   concepto viejo tiene código — match exacto). Para lo que no empareje
   por código, intenta por coincidencia exacta de `concepto` (descripción,
   trim + normalizado). Lo que siga sin empatar en ninguno de los dos
   pasos, a las dos listas correspondientes (nuevo / histórico).
3. Construye y devuelve (sin tocar la DB todavía) un resumen:
   ```json
   {
     "nuevos": [ { "codigo", "concepto", "cantidad", "precio_unitario" }, ... ],
     "emparejados": [
       { "concepto_id", "codigo", "concepto",
         "precio_anterior", "precio_nuevo", "cambia_precio": bool,
         "cantidad_anterior", "cantidad_nueva", "cambia_cantidad": bool }
       , ...
     ],
     "historicos": [ { "concepto_id", "codigo", "concepto" }, ... ],
     "total_nuevo": <suma de importes del Excel nuevo>,
     "total_actual": <presupuestoTotalDe() actual>
   }
   ```
   Este es el preview que el frontend muestra a Paul/al usuario ANTES de
   aplicar nada — nada se escribe en la DB en este paso.

**Paso B — `POST /api/projects/:id/presupuesto/actualizar/confirmar`**
Recibe el mismo `archivo_url` (se vuelve a parsear igual que en el
preview — más simple y robusto que pedirle al frontend que reenvíe el
resultado del preview, evita divergencia si algo cambió entre pasos) más
un flag `confirmado: true` explícito. Dentro de una transacción
(`db.withTransaction`):

1. Repite el emparejamiento del preview (misma función compartida, no
   duplicada).
2. Para cada concepto **emparejado**: `UPDATE conceptos SET codigo=?,
   concepto=?, unidad=?, cantidad=?, precio_unitario=?, importe=? WHERE
   id=?` — actualiza los valores del concepto EXISTENTE (mismo `id`, por
   eso `avance_conceptos.concepto_id` sigue apuntando al mismo registro y
   el avance se preserva automáticamente, sin tocar `avance_conceptos`
   para nada).
3. Para cada concepto **nuevo**: `INSERT INTO conceptos (...)` igual que
   hace `ingest()` hoy, con `activo=1`.
4. Para cada concepto **histórico** (viejo, activo, sin match en el Excel
   nuevo): `UPDATE conceptos SET activo = 0 WHERE id = ?`. Nunca DELETE.
5. Recalcula y actualiza `meta.total_sin_iva` (o inserta/actualiza la fila
   `es_total=1`) con el nuevo total — cierra el gap del §5.
6. Recalcula `avance_fisico_real`/`avance_financiero_real` para todas las
   semanas de `avances_semanales` que ya tengan algún registro en
   `avance_conceptos` — cierra el otro gap del §5 (evita dejar cachés de
   semanas cerradas desactualizadas).
7. Registra en `audit_log`: actor, acción
   `'actualizacion_presupuesto'`, `target_id = project_id`, y un `detalle`
   (columna JSON si existe, o un campo de texto) con los conteos
   (nuevos/emparejados/históricos) y qué conceptos cambiaron de precio o
   cantidad — dado el impacto financiero, este es el caso de uso más
   claro para justificar guardar el detalle, no solo la acción.
8. Responde con el mismo resumen del preview más `{ ok: true }`.

**No toca**: `programa_ejecucion` ni `avances_semanales` (filas/fechas) —
regenerar el programa completo está fuera de alcance de este mecanismo (ya
existe el endpoint separado `/fechas-obra` para eso, y se bloquea
explícitamente si ya hay avance real, mismo espíritu que aquí). `destajo_items`
tampoco se toca — su precio es independiente (§4) y su
`concepto_id` seguiría apuntando al concepto correcto si el emparejamiento
preservó el mismo `id`.

### 6.4 Casos borde identificados durante la investigación

1. **Códigos duplicados dentro del Excel nuevo o del presupuesto viejo**:
   no hay `UNIQUE` a nivel de DB (§2). Si el emparejamiento por código
   encuentra más de un candidato, debe tratarse como "sin match confiable"
   y caer a comparación por descripción (o, si tampoco resuelve, reportar
   como ambigüedad explícita en el preview en vez de adivinar cuál es
   cuál). **Confirmado por Paul: un código duplicado en cualquiera de los
   dos lados invalida el match por código para esos conceptos específicos
   únicamente (no para todo el proyecto) y cae a descripción.**
2. **Excel nuevo sin código en ningún concepto**: el emparejamiento cae
   100% a descripción — riesgo real de falsos negativos si Paul edita la
   redacción de un concepto entre una carga y otra (ej. "Losa de
   cimentación" → "Losa cimentación"), lo que lo trataría como "nuevo" +
   "histórico" en vez de como el mismo concepto emparejado. No hay forma
   de eliminar este riesgo sin un código estable — debe documentarse como
   limitación conocida y comunicarse a Paul (ej. en el preview, si Paul ve
   que un concepto que sabe que existía aparece como "nuevo", puede
   cancelar y corregir el Excel antes de confirmar — por eso el preview
   antes de aplicar es más importante todavía en este escenario).
3. **Dos conceptos del Excel nuevo emparejan por descripción con el mismo
   concepto viejo** (ambigüedad inversa): debe reportarse como conflicto
   explícito en el preview, no resolverse arbitrariamente tomando el
   primero — mismo criterio de "no adivinar" que el resto de este
   rollout.
4. **Concepto marcado histórico que después "regresa"** (aparece de nuevo
   en una carga posterior): con este diseño, simplemente se re-empareja
   con normalidad en la siguiente actualización (match por código o
   descripción encuentra la fila con `activo=0`, la reactiva a `activo=1`
   junto con sus valores nuevos) — el emparejamiento debe buscar tanto en
   conceptos activos como históricos del proyecto, no solo en los activos,
   para soportar este caso correctamente.
5. **Fila `es_total=1`** debe excluirse explícitamente del emparejamiento
   en ambos lados (Excel nuevo y conceptos existentes) — no es un concepto
   de trabajo, es un total calculado.

## 7. Alcance de Fase 2 estimado

Archivos a tocar (dentro del límite de 5 del prompt original):
1. `server/app.js` — 2 endpoints nuevos (preview + confirmar).
2. `server/ingest.js` o un archivo nuevo `server/reintegracionPresupuesto.js`
   — función de emparejamiento compartida entre preview y confirmar (para
   no duplicar la lógica).
3. `server/db.js` — `ALTER TABLE conceptos ADD COLUMN IF NOT EXISTS activo
   INTEGER DEFAULT 1`, y filtrar `activo=1` en las queries de presupuesto
   activo que ya existen (requiere auditar cuáles).
4. `public/app.js` — UI del preview (tabla de nuevos/emparejados/
   históricos) + botón de confirmar.
5. `public/index.html` — modal/sección nueva para este flujo.

5 archivos, dentro del límite. No se activó ningún stop condition de "más
de 5 archivos".

## 8. Decisiones confirmadas por Paul (2026-07-21)

1. **`meta.total_sin_iva` + refresco de cachés de `avances_semanales`**:
   CONFIRMADO — se recalculan explícitamente al aplicar la actualización
   (paso 5 y 6 de §6.3). Razón de Paul: dejarlo como limitación
   documentada significaría que cada actualización de presupuesto deja el
   dashboard financiero desfasado hasta que alguien lo note, inaceptable
   tratándose de datos financieros reales de Grupo Roforb.
2. **Códigos duplicados → fallback a descripción**: CONFIRMADO, solo para
   los conceptos con código duplicado específicamente (caso 1 de §6.4).
   Razón de Paul: no bloquea toda la carga por un problema de datos
   preexistente, y solo relaja el emparejamiento donde realmente hace
   falta.
