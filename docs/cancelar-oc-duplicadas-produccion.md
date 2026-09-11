# Cancelar OC 18 y OC 50 (duplicadas, Producción)

Ejecución de `prompt-cancelar-oc-duplicadas-produccion.md`. Sin tocar
Producción desde aquí — el mecanismo ya existe en la UI, así que la
acción la hace Paul directamente en la app, no un script.

## 1. Mecanismo confirmado — ya existe, no hace falta script SQL

`PUT /api/projects/:id/ordenes/:ocId/estado` (`server/app.js:8420-8447`):

- Acepta `estado: 'cancelada'` viniendo de cualquier estado que no sea de
  recepción (`recibida_parcial`/`recibida_completa` — esos los controla
  solo `computeEstadoRecepcion()`, no este endpoint).
- Única validación real para `cancelada`: **0 pagos registrados**
  (`server/app.js:8429-8433`) → si hay algún pago, responde `400` y no
  cambia nada. OC 18 y OC 50 tienen 0 pagos cada una (confirmado en el
  diagnóstico previo), así que ninguna dispara este rechazo.
- No hay validación de recepciones para cancelar (no aplica aquí — ninguna
  de las dos tiene recepciones).
- No es DELETE físico — es un `UPDATE ordenes_compra SET estado = ...`. El
  registro completo (folio, items, historial) queda intacto, solo cambia
  el estado. Cumple la regla dura del proyecto.

En el frontend (`public/app.js:7341-7345`), `'cancelada'` está disponible
en el `<select>` de estado tanto para `compras` (`estadosCompras`) como
para `admin`/`tesorería` (`estadosAdmin`) — a diferencia de `'confirmada'`/
`'rechazada'`, que si están restringidas a admin/tesorería. Es el mismo
mecanismo que ya dejó a las OCs 27/28 de la requisición #32 en
`'rechazada'`.

**Conclusión: no se preparó script SQL** — el prompt pedía prepararlo solo
si no existiera mecanismo de UI, y sí existe.

## 2. Pasos exactos para Paul (en la app, en Producción)

Por cada una de las 2 OCs, uno a la vez:

1. Entra a la obra correspondiente → pestaña **Órdenes de Compra**.
2. Abre el detalle de la OC (botón "Ver detalle"):
   - **OC 18** — requisición #22, Red Hidráulica, proveedor ANSA PREFABRICADOS.
   - **OC 50** — requisición #55, 684 Barrancas, proveedor MATERIALES VALDEZ.
3. **Antes de tocar nada**, verifica en el propio modal:
   - El badge de **Estado** dice `confirmada`.
   - La sección **Pagos** está vacía (sin ningún renglón).
   - Si alguna de las dos ya no cumple esto (alguien ya la pagó o cambió
     de estado) — **detente y avísame antes de continuar**, no la
     canceles (condición de parada del prompt).
4. Si todo coincide: en el campo **Estado**, cambia el `<select>` de
   `confirmada` a `cancelada`.
5. Confirma el toast "Estado actualizado" y que el badge ahora dice
   `cancelada`.
6. Repite para la segunda OC.

No requiere ningún rol especial más allá de `compras` (o admin/tesorería)
— el mismo usuario que gestiona OCs normalmente puede hacerlo.

## 3. Confirmación explícita de alcance — qué NO se tocó

- **OC 17** (requisición #22, la original, con pago de $5,593.66) — no se
  toca, sigue en `confirmada`.
- **OC 49** (requisición #55, la original, con pago de $118.32,
  `recibida_parcial`) — no se toca.
- **Requisición #32 (amani eje 2)** y sus OCs 27/28 — no se tocan, ya
  están en `rechazada` desde antes, resueltas.
- No se ejecutó ningún `UPDATE`/`DELETE` contra Producción desde esta
  sesión — solo lectura de código y de Preview.

## Nota para Fase 1

Esto cierra el riesgo inmediato de doble pago en estos 2 casos puntuales,
pero no corrige la causa raíz — sigue siendo posible volver a generar una
OC duplicada de la misma forma mañana. Eso es exactamente lo que cubre
`docs/fase0-oc-por-insumo-y-duplicados.md` (visibilidad de remanente +
bloqueo con confirmación explícita), pendiente de Fase 1.
