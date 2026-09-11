# Fase 0 — OC por insumo y bloqueo de duplicados

Diagnóstico + diseño para `prompt-fase0-oc-por-insumo-y-duplicados.md`. Sin
implementación — este documento es el checkpoint de decisión antes de
Fase 1.

**Hallazgo principal, antes de entrar en detalle**: el punto 2 del prompt
("OC por insumo") **ya está implementado**, backend y frontend, desde antes
de este diagnóstico. Lo que sí falta — y es la causa real del bug que
reportó Paul — es que el flujo no le muestra al usuario lo que el propio
backend ya sabe: cuánto de cada insumo ya se ordenó. El problema no es de
diseño de esquema, es de visibilidad en la UI.

## 1. Flujo actual mapeado (con evidencia)

### Esquema — ya es granular por insumo, no por requisición completa

- `requisicion_items` (`server/db.js:232`): un renglón por insumo dentro de
  una requisición. Sin columna de estado propia (no hay
  `requisicion_items.estado`).
- `ordenes_compra` (`server/db.js:383`): `requisicion_id` (FK a la
  requisición completa) + `proveedor_id`. **No** tiene UNIQUE en
  `requisicion_id` — nada impide que existan N filas con el mismo
  `requisicion_id`.
- `orden_compra_items` (`server/db.js:398`): `requisicion_item_id` — FK
  directa a un **renglón individual** de la requisición, no a la
  requisición completa. Esto es lo clave: **el esquema ya soporta que dos
  OCs distintas, de dos proveedores distintos, cubran insumos distintos de
  la misma requisición** — no hace falta ninguna tabla puente nueva ni
  migración.

### Backend — `POST /api/projects/:id/requisiciones/:reqId/ordenes` (`server/app.js:8334-8415`)

- Recibe `items: [{requisicion_item_id, cantidad_ordenada, precio_unitario}]`
  — el llamador ya elige **qué insumos y cuánta cantidad de cada uno**
  entran en esta OC. No es "todos los insumos de la requisición".
- `server/app.js:8367-8374` — antes de insertar, calcula el acumulado ya
  ordenado por insumo, sumando `orden_compra_items.cantidad_ordenada` de
  **todas las OCs no canceladas** de esa requisición
  (`oc.estado != 'cancelada'`), agrupado por `requisicion_item_id`.
- `server/app.js:8387` — con ese acumulado calcula
  `alerta_sobre_orden: (acumuladoPrevio + cantidad) > reqItem.cantidad_solicitada`.
  **Esta es la única protección que existe hoy contra duplicados, y es
  puramente informativa**: no bloquea nada, solo viaja en la respuesta
  como bandera.
- Ningún UPDATE de `requisiciones.estado` ocurre al crear una OC — la
  requisición se queda en `'autorizada'` para siempre, sin importar cuántas
  OCs (o cuánto del total) ya se generaron.

### Frontend — `openGenerarOrdenModal` (`public/app.js:7166-7292`)

- `public/app.js:7194` — el propio texto del modal ya dice *"puedes ordenar
  solo algunos items; deja en 0 los que no vayas a incluir"* — la función
  "OC por insumo" ya es un hecho conocido y usado por el equipo.
- `public/app.js:7297-7302` (vista Órdenes de Compra) — el texto de la
  vista ya dice explícitamente *"Una requisición puede tener varias
  órdenes (compra dividida entre proveedores o en distintos momentos)"*.
- **El bug real está en `public/app.js:7220-7230`**: cada renglón del modal
  se prellena con `value="${it.cantidad_solicitada}"` — la cantidad
  **originalmente solicitada completa**, sin importar si ya existe una OC
  previa para ese insumo. El modal nunca consulta ni muestra el acumulado
  ya ordenado (`acumMap`) que el backend sí calcula en el POST — esa
  información se calcula y se descarta, no llega al usuario antes de
  decidir.
- `openRequisicionDetail` (`public/app.js:6806-6885`) — el detalle de la
  requisición **no lista las OCs que ya se generaron de ella**. El botón
  "Generar Orden de Compra" (línea 6831) aparece siempre que
  `estado === 'autorizada'`, sin ninguna pista visual de que ya existe una
  OC (o dos) para esa misma requisición.

**Conclusión de causa raíz**: no es un bug de bloqueo faltante en el
sentido de "falta un IF" — es que el usuario nunca tiene, en ningún punto
de la UI, la información de "esto ya se ordenó". Un usuario que vuelve a
entrar a "Generar Orden de Compra" en una requisición que ya tiene OC ve
exactamente el mismo formulario que si fuera la primera vez, prellenado al
100% de lo solicitado, sin ningún indicio de que eso mismo ya se compró.

## 2. Conteo real en Preview — el bug ya ocurrió, dos veces

Confirmado con SELECTs de solo lectura contra la base conectada en
`.env` (`neondb`), sin corregir nada:

**Requisición #13** (`project_id` 13):
| OC | Folio | Proveedor | Estado | Pagos | Creada |
|---|---|---|---|---|---|
| #14 | ROF01ANSA | ANSA PREFABRICADOS | `recibida_completa` | 1 pago, $55,886.51 | 2026-07-03 16:44 |
| #15 | O.C.ANSA | ANSA PREFABRICADOS | `borrador` | 0 | 2026-07-04 01:51 (~9h después) |

Item `req_item_id=37`: solicitado 532, ordenado acumulado **1064** (exacto
doble). Item `req_item_id=36`: solicitado 65.6, ordenado **131.2** (exacto
doble). Mismo proveedor en ambas OCs — patrón consistente con "se volvió a
generar por error", no con una compra dividida intencional entre
proveedores distintos.

**Requisición #22** (`project_id` 30):
| OC | Folio | Proveedor | Estado | Pagos | Creada |
|---|---|---|---|---|---|
| #17 | OC-2026-01 | ANSA PREFABRICADOS | `confirmada` | 1 pago, $5,593.66 | 2026-07-09 03:40 |
| #18 | (sin folio) | ANSA PREFABRICADOS | `confirmada` | 0 | 2026-07-09 03:42 (~2 min después) |

Item `req_item_id=54`: solicitado 6, ordenado **12**. Item
`req_item_id=53`: solicitado 5, ordenado **10**. Mismo patrón exacto —
doble, mismo proveedor, casi inmediato.

**Esto confirma exactamente el reporte de Paul**: en la requisición #13 la
primera OC ya estaba `recibida_completa` y pagada cuando se generó la
segunda. No se corrigió nada de esto — solo se reporta, según lo pedido.
No se encontraron más casos con este patrón en las requisiciones/OCs
existentes en esta base (`Requisiciones con >1 OC no cancelada: 2`, ambas
ya cubiertas arriba).

## 3. Diseño del bloqueo de duplicados

**Decisión de nivel: por insumo/renglón, no por requisición completa** —
ya es forzoso dado que el esquema (sección 1) y el negocio (insumos de
proveedores distintos) ya operan a ese nivel. Bloquear a nivel de
requisición completa rompería la función de compra dividida que el equipo
ya usa a propósito (ver texto de la UI citado arriba).

**No conviene un bloqueo duro absoluto** (rechazar siempre que
`acumulado + nueva > solicitada`) porque el propio diseño actual permite
casos legítimos de pasarse de lo solicitado (precio corregido, ajuste de
cantidad real vs. presupuestada) — es la razón de que `alerta_sobre_orden`
exista como advertencia y no como bloqueo. Un bloqueo ciego convertiría
casos legítimos en callejones sin salida.

**Propuesta: confirmación explícita en dos pasos**, mismo patrón que ya
usa el proyecto para ediciones sensibles post-OC (`puedeCorregirPostOc` +
justificación, `public/app.js:6839-6875`, `requisicion_item_editar_post_oc`
en `audit_log`):

1. `POST .../ordenes` sigue calculando `acumMap` igual que hoy
   (`server/app.js:8367-8374`), pero si algún item de la solicitud
   resultaría en `acumuladoPrevio + cantidad > cantidad_solicitada` **y el
   body no trae `confirmar_sobreorden: true`**, responde `409` (no `201`)
   con el detalle de qué items y por cuánto se excede, sin crear nada.
2. El frontend, al recibir ese `409`, muestra un modal de confirmación
   explícito por item ("Insumo X: ya se ordenaron 12 de 6 solicitados —
   ¿confirmas ordenar 6 más?") con campo de motivo opcional, y si el
   usuario confirma reenvía la misma request con
   `confirmar_sobreorden: true` + el motivo.
3. El motivo (si lo hay) y el hecho de que fue una sobre-orden confirmada
   se guardan en `audit_log` (tabla ya existente, mismo patrón que
   `reasignar_proveedor_oc` del diagnóstico previo de OCs) — preserva
   trazabilidad completa sin bloquear casos legítimos.

Esto bloquea el patrón real encontrado en Preview (usuario re-generando
sin darse cuenta, mismo proveedor, mismos números) porque nunca llega a
pasar por el paso de confirmación explícita — el flujo normal simplemente
no vuelve a ofrecer cantidad completa por default (ver sección 4).

**Mensaje de error/feedback para el 409**: *"[Insumo] ya tiene N de M
solicitados ordenados en otra(s) OC(s) de esta requisición. ¿Confirmas
ordenar [cantidad] adicionales de todos modos?"* — por insumo, no un
mensaje genérico de toda la OC, para que el usuario sepa exactamente cuál
renglón está duplicando.

## 4. Diseño de visibilidad ("OC por insumo" — cerrar el gap real)

Como la selección por insumo ya existe, el trabajo de Fase 1 aquí es casi
enteramente **mostrar información que el backend ya calcula**, no construir
flujo nuevo:

1. **`GET /api/projects/:id/requisiciones/:reqId`** (`server/app.js:7724`):
   extender cada item devuelto con `acumulado_ordenado` (mismo query que
   ya existe en el POST, sección 1) y agregar un array `ordenes` con las
   OCs no canceladas de esa requisición (`id`, `folio`, `proveedor_nombre`,
   `estado`, `importe_total`) — un solo query adicional con `JOIN`, sin
   endpoint nuevo.
2. **`openRequisicionDetail`** (`public/app.js:6806`): agregar una sección
   "Órdenes de compra ya generadas de esta requisición" (lista con folio,
   proveedor, estado, importe) **antes** del botón "Generar Orden de
   Compra", visible siempre que `ordenes.length > 0`. Esto solo, sin tocar
   nada más, ya le habría mostrado a Paul que la requisición #13 tenía una
   OC `recibida_completa` antes de generar la segunda.
3. **`openGenerarOrdenModal`** (`public/app.js:7166`): por cada renglón,
   mostrar "Ya ordenado: N de M solicitado" y **prellenar la cantidad con
   el remanente** (`max(0, cantidad_solicitada - acumulado_ordenado)`), no
   con `cantidad_solicitada` completo. Items con remanente 0 quedan en 0 —
   como el submit ya filtra `cantidad_ordenada > 0` (línea 7264), un
   usuario que no toca esos renglones intencionalmente **nunca los vuelve
   a enviar por accidente**. Esto es el fix de mayor impacto con menor
   riesgo: cambia un valor de default y agrega texto informativo, no
   cambia ninguna regla de negocio.

### Impacto en UI existente
Solo 3 puntos, todos ya mapeados arriba: `GET .../requisiciones/:reqId`
(backend), `openRequisicionDetail` y `openGenerarOrdenModal` (frontend).
No hay pantallas nuevas.

### Impacto en reportes/vistas existentes
Revisé todos los queries que tocan `ordenes_compra`/`requisicion_id` en
`server/app.js` y `server/finanzas.js`. **Ninguno asume 1 OC = 1
requisición completa**:
- El reporte de riesgo de suministro (`server/app.js:8070-8100`) ya usa
  `array_agg(oc.estado)` por requisición y `.some(...)` sobre el arreglo —
  ya tolera N OCs por requisición.
- `finanzas.js` (pagos, control financiero) siempre opera a nivel
  `orden_compra_id` individual, nunca agrega por requisición.
- El export de Órdenes de Compra y la vista `renderOrdenes` ya listan por
  OC individual, no por requisición.

No se encontró ningún lugar que necesite cambio por este rediseño — porque,
otra vez, no es un rediseño: la granularidad ya existe en todos lados
excepto en el formulario de captura.

## 5. Condición de parada del prompt — no se activó

El prompt pedía reportar explícitamente si "OC por insumo" requeriría un
cambio de esquema mayor. **No lo requiere** — el esquema ya tiene
`orden_compra_items.requisicion_item_id` apuntando a renglones
individuales desde su diseño original. No hay tabla puente que crear, no
hay migración, no hay columna nueva obligatoria (el único campo nuevo
opcional es `ordenes_compra.observaciones` o similar para el motivo de
sobre-orden confirmada, que ya existe como columna).

## 6. Estimado de esfuerzo para Fase 1

Separado en 2 partes, según pidió el prompt — son independientes entre sí
aunque comparten el mismo endpoint (`GET .../requisiciones/:reqId`):

**Parte A — Visibilidad (remanente por insumo + lista de OCs previas)**:
~30-40 min. Un `JOIN` adicional en un endpoint existente, dos secciones
nuevas de UI reusando componentes ya existentes (cards, badges), sin
cambios de reglas de negocio ni de permisos. Bajo riesgo.

**Parte B — Bloqueo con confirmación explícita (409 + reenvío
confirmado + audit_log)**: ~35-45 min. Requiere el flujo de dos pasos en
frontend (manejar 409, modal de confirmación, reenvío) y el registro en
`audit_log` con el patrón ya usado en `reasignar_proveedor_oc`. Conviene
probarlo en Preview generando una sobre-orden real (con y sin confirmar)
antes de dar por cerrado, dado que toca el flujo de compras/pagos.

**Total estimado Fase 1: ~65-85 min**, mejor como dos PRs separados (A
primero, ya que reduce la probabilidad de que alguien dispare el caso de
B mientras B no esté listo).

## Abierto para Paul antes de Fase 1

1. ¿La confirmación explícita de sobre-orden (Parte B) debe quedar
   disponible para el rol `compras`, o solo admin/desarrollador — dado que
   es la puerta que hoy se está usando (sin querer) para duplicar compras?
2. Las 2 OCs duplicadas reales encontradas (#13→OCs 14/15, #22→OCs 17/18):
   ¿quieres que se corrijan (cancelar la duplicada, si su estado lo
   permite) como tarea aparte una vez que el bloqueo esté en Fase 1, o se
   dejan como están por ahora?
