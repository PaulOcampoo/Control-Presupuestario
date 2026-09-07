# Ventas (Catálogo Comercial, Contrato, Cobranza, Entregas)

Cinco PRs consecutivos (25-26 ago 2026), todos del mismo autor y mismo hilo de
trabajo: el roadmap "Desarrollador de Vivienda". Juntos agregan un módulo de
negocio completo — venta de vivienda a compradores finales — que vive
**encima** de la obra de construcción ya existente (Lotes, Fase 1 de un
roadmap anterior) pero es conceptualmente un dominio distinto: mientras el
resto de App-CP controla el gasto/avance de construir, este módulo controla
el ingreso de vender lo construido.

**Cadena de dependencia estricta**: #187 depende de #186, #188 depende de
#187, #189 depende de #188, #190 depende de #189. Ninguno es aplicable de
forma aislada — son fases de un mismo pipeline (catálogo → apartado →
contrato → cobranza → entrega) y cada uno asume que las tablas/endpoints del
anterior ya existen.

**Clasificación de aplicabilidad general (aplica a los 5 PRs)**: esto es lo
más específico del negocio de Grupo Roforb que existe en todo el changelog.
"Control presupuestario de obra" (el propósito de App-CP-Demo) es agnóstico
de si al final se vende una casa, se renta, o es infraestructura pública —
pero "vender vivienda a un comprador final con apartado/contrato/cobranza/
entrega" es 100% específico del giro de **vivienda residencial**. Una demo
genérica de control de obra (puente, planta industrial, remodelación
comercial, infraestructura pública) no tiene "compradores" ni "modelos de
casa". Recomendación: **no portar como negocio**, pero sí vale la pena leer
el PR #186 (catálogo) y el PR #190 (deadlock) por los patrones de ingeniería
reutilizables que se explican abajo en cada entrada — separado del dominio
de negocio en sí.

---

## PR #186 — feat/catalogo-comercial-modelos-vivienda (2026-08-25)

### Qué agrega

Catálogo comercial de "modelos de vivienda" (nombre, superficie construida/
terreno, recámaras, baños, niveles, precio de lista) — Fase 3 de un roadmap
anterior a la Fase 4 de Ventas. Es la base sobre la que se construyen los
4 PRs siguientes: sin un modelo de vivienda no hay nada que vender.

Además, sobre `lotes` (ya existente de una fase previa) agrega 3 columnas:
`modelo_vivienda_id` (FK opcional, convive con el `modelo_vivienda` TEXT
libre ya existente, que se deja intacto a propósito), `precio_lista_override`
(precio propio por lote — esquina, vista, ubicación — que sustituye al del
modelo cuando está capturado) y `estatus_venta` (`no_disponible` /
`disponible` / `apartado` / `vendido` — **independiente** del `estatus` de
construcción ya existente: preventa antes de terminar la obra, o terminado
pero aún no listo para vender, son casos reales de negocio).

### Diseño (no hay bug — es feature nuevo)

- **Scoping por `project_id`**, no catálogo global: el mismo nombre de
  modelo en dos obras distintas no es necesariamente la misma casa (mismo
  criterio ya usado en el proyecto para `conceptos_grupo_categoria`).
- `banos` es `DOUBLE PRECISION`, no `INTEGER` — "2.5 baños" (medio baño de
  visitas) es nomenclatura estándar del sector; forzar entero rompería esa
  semántica.
- Soft-delete vía `activo`, nunca DELETE físico.
- Precio efectivo por lote se calcula **en el backend** (`server/lotes.js`,
  `listLotes`), nunca replicado en el frontend: `COALESCE(precio_lista_override,
  modelos_vivienda.precio_lista)`.
- Permisos: sección nueva `modelos_vivienda` con `puede_ver` real para
  admin/desarrollador/residente vía `checkPermiso`; crear/editar/eliminar
  gateado a nivel de ruta con `auth.allow()` sin argumentos (solo admin/
  desarrollador) — mismo patrón que aprobar/rechazar en `ordenes_cambio`:
  el `checkPermiso` se encadena de todas formas como infraestructura para
  el día que se delegue a otro rol, aunque hoy admin/desarrollador lo
  bypaseen siempre.

### Archivos y funciones

- `server/db.js`: `CREATE TABLE modelos_vivienda` (scoped `project_id`,
  `UNIQUE(project_id, nombre)`); 3 `ALTER TABLE lotes ADD COLUMN` nuevas;
  sección nueva `'modelos_vivienda'` en ambos CHECK constraints de
  `permisos_usuario.seccion` (`CREATE TABLE` y el `ALTER ... ADD CONSTRAINT`
  para bases ya existentes — el checklist de 5 lugares de este repo).
- `server/modelosVivienda.js` (nuevo, 110 líneas): `listModelos`,
  `createModelo`, `updateModelo`, `softDeleteModelo` — CRUD puro.
- `server/lotes.js`: `listLotes` ahora hace `LEFT JOIN modelos_vivienda` y
  calcula `precio_efectivo`; `createLote`/`updateLote` aceptan los 3 campos
  nuevos; función nueva `validarModeloDeLaObra` (el modelo asignado a un
  lote debe pertenecer a la misma obra que el lote — anti-IDOR cross-obra).
- `server/auth.js`: tabs de admin/desarrollador/residente +
  `'modelosVivienda'`; sección nueva en `SECCIONES_PERMISOS` y
  `TAB_A_SECCION`.
- `server/app.js`: 3 endpoints nuevos, `GET/POST/PUT/DELETE
  /api/projects/:id/modelos-vivienda[/:modeloId]`.
- `public/app.js`: pestaña nueva `modelosVivienda` dentro de la sección
  `obra`; `renderModelosVivienda`, tabla + modal CRUD; el modal de edición
  de Lote (`openLoteFormModal`) cambia de un `<input>` de texto libre a un
  `<select>` poblado con el catálogo de la obra, más campos nuevos de
  precio-override y estatus de venta.

### Fragmento relevante (precio efectivo, `server/lotes.js`)

```js
SELECT l.*,
   mv.nombre AS modelo_nombre, mv.precio_lista AS modelo_precio_lista,
   COALESCE(l.precio_lista_override, mv.precio_lista) AS precio_efectivo
 FROM lotes l
 LEFT JOIN modelos_vivienda mv ON mv.id = l.modelo_vivienda_id
 WHERE ...
```

### Clasificación de aplicabilidad

**(c) No aplica al dominio de negocio** — "modelos de vivienda" con precio
de lista comercial es específico de venta de casas. **Pero el patrón de
implementación sí es reusable si la demo alguna vez necesita un catálogo
scoped-por-obra con soft-delete y override de un campo a nivel de fila**
(ej. catálogo de básicos/insumos con precio override por obra) — el
`COALESCE(override, catálogo)` calculado en el backend, nunca en frontend,
es el fragmento de valor genérico aquí.

### Dependencias

Ninguna hacia atrás (es la base). #187, #188, #189, #190 dependen de este.

---

## PR #187 — feat/ventas-compradores-apartado (2026-08-25)

Fase 4 "PR A" del roadmap de Ventas — depende de #186 (usa `lotes.estatus_venta`
agregado ahí). Agrega dos entidades nuevas: **Compradores** (catálogo de
personas/entidades que compran vivienda — mismo shape que `proveedores`:
nombre/contacto/teléfono/email/rfc/activo, soft-delete) y **Apartados**
(primer paso del proceso de venta: un comprador aparta un lote con un monto
y vigencia opcional).

Se crea una sección de nivel superior nueva en el nav, `Ventas` (icono
🏠, `SECTION_DEFS.ventas`), con tabs `compradores`/`apartados` en este PR y
`proximamente: ['Contrato de venta', 'Cobranza', 'Entregas']` — la "galería"
que los 3 PRs siguientes van llenando uno por uno.

### Diseño clave

- **Deliberadamente SIN entrada en `permisos_usuario`/`SECCIONES_PERMISOS`**
  (decisión explícita, no omisión): todo admin/desarrollador exclusivo vía
  `auth.allow()` sin argumentos, mismo criterio que la pestaña `Contrato`
  (de construcción) — dato de comprador es información personal de un
  tercero, no solo comercialmente sensible.
- **Apartado activo único por lote garantizado por la propia DB**: índice
  único parcial `CREATE UNIQUE INDEX ... ON apartados(lote_id) WHERE estado
  = 'activo'` — no solo la lógica de aplicación.
- `lotes.estatus_venta` pasa a ser **derivado**: `crearApartado` lo escribe
  a `'apartado'` dentro de la misma transacción (con `FOR UPDATE` sobre el
  lote); `cancelarApartado` lo regresa a `'disponible'` solo si no queda
  otro apartado activo para ese lote. Como consecuencia, `createLote`/
  `updateLote` en `server/lotes.js` dejan de aceptar `estatus_venta` del
  caller — si el body lo trae, se ignora en silencio (no se rechaza con 400,
  mismo criterio de tolerancia que otros campos no reconocidos en este
  archivo).

### Archivos y funciones

- `server/db.js`: `CREATE TABLE compradores`, `CREATE TABLE apartados`
  (`monto`, `vigencia_hasta` nullable, `estado` con `'vencido'` ya en el
  CHECK pero sin lógica automática que lo active todavía), índice único
  parcial de apartado activo.
- `server/ventas.js` (nuevo, 224 líneas): `listCompradores`,
  `createComprador`, `updateComprador`, `softDeleteComprador`,
  `listApartados`, `crearApartado` (transaccional, valida lote/comprador
  de la misma obra + apartado activo previo, `FOR UPDATE`), `cancelarApartado`.
- `server/lotes.js`: `estatus_venta` removido de los parámetros aceptados
  de `createLote`/`updateLote`.
- `server/app.js`: 7 endpoints nuevos bajo `/api/projects/:id/compradores`
  y `/api/projects/:id/apartados`, todos `auth.allow()` sin argumentos.
- `public/app.js`: `SECTION_DEFS.ventas` nueva; `renderCompradores`,
  `renderApartados` + modales.

### Clasificación de aplicabilidad

**(c) No aplica** — Compradores/Apartado es lógica de venta de vivienda
pura. El único elemento genérico reutilizable es el patrón de "estado
derivado con transición garantizada por índice único parcial + `FOR UPDATE`",
útil en cualquier demo que necesite un flujo de reserva exclusiva
(ej. "un recurso no puede tener más de una reserva activa a la vez").

### Dependencias

Depende de #186 (`lotes.estatus_venta`). #188 depende de este.

---

## PR #188 — feat/ventas-pr-b-contrato-venta (2026-08-25)

Fase 4 "PR B" — depende de #187. Además del **Contrato de Venta**
(entidad principal de este PR), el commit agrupa dos features más que no
estaban en el título del PR pero sí en el commit: **marcar-disponible** (fix
de un hueco funcional) y **override de emergencia** de estatus de venta.

### 1. Contrato de Venta

Entidad `contratos_venta`: `lote_id`, `comprador_id`, `apartado_id` nullable
(un contrato puede originarse de un apartado previo o venderse directo),
`monto_total` (precio final negociado — **nunca** derivado de
`precio_efectivo` del lote ni del monto del apartado, siempre capturado a
mano), adjunto simple de PDF (`pdf_url`/`pdf_filename`, **sin** extracción
vía IA — a diferencia de `contratos_trabajador`/`extraccionContrato.js`,
explícitamente prohibido para este caso). Analog elegido tras diagnóstico:
`contratos_trabajador`, no `contratos` (contrato de obra, que es 1-por-obra
vía `UNIQUE(project_id)` y por tanto estructuralmente incompatible).

`crearContratoVenta` tiene dos caminos mutuamente excluyentes: con
`apartado_id` (el apartado debe estar `'activo'` y ser del mismo lote/
comprador — pasa a `'convertido_a_contrato'`) o sin él — venta directa,
requiere que el lote esté `'disponible'`. Deriva `lotes.estatus_venta =
'vendido'` en la misma transacción. Índice único parcial garantiza un solo
contrato vigente por lote (misma técnica que apartados). Al cancelar un
contrato, el apartado original **nunca se reactiva automáticamente**
(simplificación explícita) y el lote regresa a `'disponible'`.

### 2. `marcarLoteDisponible` — fix de un hueco real

Antes de este PR, un lote recién creado nace `'no_disponible'` (default de
columna) y el **único** camino de código que producía `'disponible'` era
`cancelarApartado` — es decir, un lote sin ningún interés de compra real
quedaba atrapado en `'no_disponible'` para siempre, salvo crear-y-cancelar
un apartado ficticio como workaround. Endpoint nuevo,
`PUT /lotes/:loteId/marcar-disponible`, permite la transición exclusiva
`'no_disponible' -> 'disponible'` — explícitamente no toca `'apartado'`/
`'vendido'` (esos se revierten por su propio flujo).

### 3. Override de emergencia de estatus de venta

`forzarEstatusVenta`: escape auditado para casos no previstos por ningún
flujo normal. Requiere `motivo` obligatorio; registra en `audit_log`
(tabla ya existente, reusada) **en la misma transacción** que el cambio de
estatus — si el log falla, el estatus tampoco cambia. No cancela apartados/
contratos relacionados automáticamente, solo informa sus ids en la
respuesta para que el admin decida esa parte aparte.

### Archivos y funciones

- `server/db.js`: `CREATE TABLE contratos_venta` + índice único parcial de
  vigente.
- `server/ventas.js`: +307 líneas — `marcarLoteDisponible`,
  `listContratosVenta`, `crearContratoVenta`, `updateContratoVenta` (edición
  limitada a `pdf_url`/`pdf_filename`/`fecha_firma` — corregir un monto
  firmado exige cancelar y crear uno nuevo), `cancelarContratoVenta`,
  `forzarEstatusVenta`, `listEstatusVentaHistorial`.
- `server/app.js`: 9 endpoints nuevos, incluyendo
  `POST /contratos-venta/upload-token` y
  `GET /contratos-venta/:contratoId/download` (mismo patrón de subida a
  blob storage que otros adjuntos PDF del proyecto).
- `public/app.js`: tab `contratosVenta` sale de `proximamente` a real.

### Clasificación de aplicabilidad

**(c) No aplica** el dominio (contrato de compraventa de vivienda). Lo
único potencialmente reutilizable: el patrón "override de emergencia
auditado" (`forzarEstatusVenta` + `audit_log` en la misma transacción que
el cambio) es una técnica genérica de gobernanza sobre cualquier estado
derivado — aplicable si la demo alguna vez necesita un escape hatch
auditado para un estado calculado que se salió de los flujos normales.

### Dependencias

Depende de #187 (`compradores`, `apartados`). #189 depende de este.

---

## PR #189 — feat/ventas-pr-c-cobranza (2026-08-25)

Fase 4 "PR C" — depende de #188. Agrega **plan de pagos** (opcional,
encabezado+líneas — mismo patrón DELETE+re-INSERT que
`estimaciones`/`estimacion_conceptos` ya usado en el proyecto) y **registro
de pagos** recibidos de compradores sobre un contrato de venta ya firmado.

Diagnóstico confirmó que la tabla `pagos` (de compras/proveedores) **no**
es reusable: tiene `orden_compra_id NOT NULL`, incompatibilidad estructural
real — ese dinero *sale* de la empresa, el de Cobranza *entra*.

### Diseño

- `estado_pago` (`pendiente`/`parcial`/`liquidado`) **nunca se persiste** —
  se calcula al vuelo (`estadoPagoDe`, con `EPSILON_MONTO = 0.01` para
  absorber solo ruido de punto flotante, no discrepancias reales) a partir
  de `SUM(pagos_venta.monto)` vs `contratos_venta.monto_total`. Contraste
  explícito documentado en el propio código con `lotes.estatus_venta`, que
  sí se persiste porque muchas vistas filtran por él — aquí el cálculo es
  barato y no se filtra por él.
- **Criterio "avisar sin bloquear"** (mismo que `alerta_destajo` en
  Nómina, ya existente en el proyecto): descuadre del plan vs.
  `monto_total`, sobrepago, y cancelar un contrato con pagos ya registrados
  — ninguno de los tres bloquea la operación; los tres devuelven un campo
  `advertencia` explícito en la respuesta para que el admin decida.
  `cancelarContratoVenta` (de #188) se extiende para incluir esa
  advertencia sin tocar los pagos ya registrados.
- `pagos_venta.plan_pago_item_id` es nullable — un pago puede no
  corresponder a ningún ítem programado (pago anticipado o fuera de
  calendario) — y `contrato_venta_id` queda denormalizado en la misma tabla
  para poder calcular saldo con un solo `WHERE`, sin depender de ese JOIN
  opcional.

### Archivos y funciones

- `server/db.js`: `CREATE TABLE planes_pago` (`UNIQUE(contrato_venta_id)`
  — a lo más un plan por contrato, no historial), `plan_pago_items`,
  `pagos_venta`.
- `server/ventas.js`: +258 líneas — `estadoPagoDe`, `calcularSaldo`,
  `getPlanPago`, `guardarPlanPago` (DELETE+re-INSERT transaccional),
  `registrarPagoVenta`, `getCobranzaContrato`; `listContratosVenta` (de
  #188) se extiende con `total_pagado`/`saldo_pendiente`/`estado_pago` vía
  LEFT JOIN agregado, para que la tabla de Contrato de Venta muestre el
  badge de cobranza sin N+1 llamadas.
- `server/app.js`: 3 endpoints — `GET .../cobranza`,
  `PUT .../plan-pago`, `POST .../pagos`.
- `public/app.js`: tab `cobranza` sale de `proximamente` a real.

### Clasificación de aplicabilidad

**(c) No aplica** el dominio. El patrón "estado calculado al vuelo con
umbral de epsilon + advertencia sin bloqueo" es genérico y ya existe
precedente en el propio proyecto (`alerta_destajo`) — no es una idea nueva
que valga la pena portar aisladamente, solo replicar el criterio si la demo
ya tiene un caso análogo real.

### Dependencias

Depende de #188 (`contratos_venta`). #190 depende de este.

---

## PR #190 — feat/ventas-pr-d-entregas (2026-08-25/26)

Fase 4 "PR D" — depende de #189, **último** del roadmap Desarrollador de
Vivienda (cierra `proximamente` a `[]` en `SECTION_DEFS.ventas`). Agrega
**Entregas**: entrega formal del lote al comprador, requiere un
`contrato_venta` vigente, reusa `lotes.estatus` (construcción, Fase 1
antigua: `sin_iniciar/en_proceso/terminado/entregado`) en vez de crear un
estatus paralelo — ojo, esto es *distinto* de `lotes.estatus_venta`
(ya `'vendido'` desde #188). `firma_digital` reusa el mismo patrón que
`epp_entregas.firma_digital` (TEXT, base64 PNG, sin límite, nullable) ya
probado en producción con Nómina/EPP. `recibido_por` es TEXT libre, no FK a
`compradores`, porque quien recibe físicamente puede no ser el comprador
registrado (cónyuge, apoderado). Saldo pendiente en cobranza **no bloquea**
la entrega — mismo criterio "avisar sin bloquear" de #189, solo
`advertencia`.

### El hallazgo interesante de este PR: deadlock por orden de locks opuesto

5 commits en este PR, dos de ellos fixes sobre el propio PR (no bugs de
producción, detectados/corregidos dentro del mismo ciclo):
`a8d8347` (lock del contrato vigente, race con `cancelarContratoVenta`) y
`6099e3a` (manejo del deadlock resultante).

**Causa raíz**: `cancelarContratoVenta` (#188) toma sus locks en orden
contrato→lote (`FOR UPDATE OF cv` sobre `contratos_venta`, luego el
`UPDATE` final sobre `lotes`). `crearEntrega` (este PR) los toma en el
orden contrario, lote→contrato (`FOR UPDATE` sobre `lotes` primero, luego
`FOR UPDATE` sobre `contratos_venta WHERE estado = 'vigente'`). El lock
extra sobre el contrato en `crearEntrega` no es cosmético: sin él,
`cancelarContratoVenta` podría colarse entre el `SELECT` y el `INSERT` de
`crearEntrega` (bloqueada en su propio `UPDATE` a `lotes`, pero eso no
evita que el `SELECT` del contrato ya haya leído `'vigente'` un instante
antes de que el otro lo cancele) — resultado: una entrega insertada contra
un contrato que quedó cancelado, sin ninguna advertencia que lo refleje.

Con los dos órdenes de lock opuestos coexistiendo, Postgres puede detectar
deadlock real (`SQLSTATE 40P01`) entre las dos transacciones si corren
concurrentemente sobre el mismo lote/contrato — no corrompe datos (la
transacción perdedora hace rollback limpio), pero sin manejo explícito el
error crudo de Postgres se propagaría tal cual al cliente HTTP. **Fix
elegido**: no invertir el orden de locks en `cancelarContratoVenta` (fuera
de alcance, código de PR B ya en producción) sino atrapar `40P01` en
`crearEntrega` y responder `409` con mensaje claro pidiendo reintentar —
mismo tratamiento que ya recibía `23505` (carrera de doble entrega).

```js
try {
  return await db.withTransaction(async (client) => {
    // FOR UPDATE sobre lotes, luego FOR UPDATE sobre contratos_venta...
  });
} catch (err) {
  if (err.code === '40P01') {
    const e = new Error('Otra operación está en curso sobre este lote — intenta de nuevo.');
    e.status = 409;
    throw e;
  }
  throw err;
}
```

### Archivos y funciones

- `server/db.js`: `CREATE TABLE entregas_lote` (`lote_id UNIQUE` — sin
  índice parcial porque no hay estado cancelable, una vez entregado vive
  para siempre).
- `server/ventas.js`: +157 líneas — `crearEntrega` (transaccional, con el
  manejo de deadlock arriba), `listEntregasVenta` (reusa el mismo SELECT
  de `listContratosVenta` + `LEFT JOIN entregas_lote`, filtra solo
  contratos `'vigente'`).
- `server/app.js`: `GET /lotes-entregas`, `POST /lotes/:loteId/entrega`.
- `public/app.js`: tab `entregas`, último hueco de `proximamente` se
  cierra.

### Clasificación de aplicabilidad

**(c) No aplica** el dominio de negocio (entrega de vivienda). **(b) Portar
adaptado — vale la pena como lección de ingeniería**, no como feature: el
patrón "dos funciones que tocan las mismas dos tablas con `FOR UPDATE` en
orden opuesto pueden deadlockear; atrapa `40P01` en el punto de entrada más
nuevo y responde 409 en vez de dejar pasar el error crudo de Postgres" es
un caso real y bien documentado de una clase de bug (deadlock por orden de
lock inconsistente en transacciones concurrentes) que puede aparecer en
cualquier código con `FOR UPDATE` sobre múltiples tablas relacionadas —
útil como referencia si la demo desarrolla su propia lógica transaccional
con locks explícitos, independientemente de si involucra ventas.

### Dependencias

Depende de #189 (`contratos_venta`, `pagos_venta` para el cálculo de
saldo). Ninguno de los PRs posteriores del módulo depende de este — es el
último de la cadena.
