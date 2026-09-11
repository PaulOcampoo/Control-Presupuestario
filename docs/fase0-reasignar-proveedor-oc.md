# Fase 0 — Reasignar proveedor de una Orden de Compra

Diagnóstico + diseño para `prompt-fase0-reasignar-proveedor-oc.md`. Sin
implementación — este documento es el checkpoint de decisión antes de
Fase 1. Caso real que lo motivó: OC ROF-14, obra "684 BARRANCAS INFRA
REDES", proveedor capturado "ANSA PREFABRICADOS" por error — Paul debe
confirmar cuál es el proveedor correcto antes de Fase 1 (no se tocó la OC
ROF-14 en esta fase, por instrucción explícita del prompt).

## 1. Causa y alcance del bloqueo actual

**No es un bloqueo específico del estado `recibida_completa`. Es que la
función de editar proveedor no existe en ningún estado.**

Evidencia:

- `public/app.js:7350` — en el modal de detalle de OC, el proveedor
  siempre se pinta como texto plano (`o.proveedor_nombre`), nunca como
  campo editable. Esto es así para las 7 estados posibles, no solo para
  `recibida_completa`.
- `public/app.js:7356-7361` — lo único editable en ese modal es el campo
  **Estado** (un `<select>`), y solo aparece si `esEstadoRecepcion` es
  `false` — es decir, si el estado actual NO es `recibida_parcial` ni
  `recibida_completa`. El mensaje "este estado lo controla la recepción
  de mercancía, no se puede cambiar aquí" (línea 7358) es sobre el campo
  **Estado**, no sobre el proveedor. Paul lo interpretó (razonablemente)
  como "la OC está bloqueada", pero el candado real es solo sobre el
  estado.
- `server/app.js:8420-8447` — `PUT /api/projects/:id/ordenes/:ocId/estado`
  rechaza explícitamente (`400`) cualquier intento de poner el estado en
  `recibida_parcial`/`recibida_completa` vía este endpoint ("Los estados
  de recepción se controlan automáticamente") — coherente con el comentario
  en `server/app.js:8462-8466` que aclara que esos dos valores solo los
  escribe `computeEstadoRecepcion()`, nunca este endpoint.
- `server/app.js:8393-8395` — `proveedor_id` se escribe **una sola vez**,
  en el `INSERT` al crear la OC (`POST /api/projects/:id/ordenes`). No
  hay ningún `UPDATE ordenes_compra SET proveedor_id = ...` en todo el
  backend — ni gateado por estado, ni de ningún tipo. La capacidad de
  corregirlo nunca se construyó, independientemente del estado.

La única salida indirecta que existe hoy es para `estado = 'borrador'`:
`DELETE /api/projects/:id/ordenes/:ocId` (`server/app.js:8449`) permite
borrar y recrear la OC completa, pero **solo si `estado === 'borrador'`**
(línea 8455-8456). Para cualquier otro estado — incluida `recibida_completa`,
el caso real — no hay ningún camino, ni siquiera ese.

## 2. Dependencias de `proveedor_id`

Revisé qué otras tablas referencian al proveedor de una OC, y si el
nombre del proveedor está copiado como texto plano en algún lado
(`server/db.js`, `server/app.js`, `server/finanzas.js`):

| Tabla | Relación con la OC | ¿Depende de `proveedor_id`? |
|---|---|---|
| `pagos` | FK directa a `orden_compra_id` | No — nunca referencia `proveedor_id` |
| `recepciones` / `recepcion_items` | FK directa a `orden_compra_id` | No — nunca referencia `proveedor_id` |
| `orden_compra_items` | FK directa a `orden_compra_id` | No |
| `proveedor_documentos` (cumplimiento legal — constancia fiscal, IMSS, etc.) | FK directa a `proveedor_id`, **independiente de cualquier OC** | Sí, pero no cambia con la OC — sigue el proveedor, no la orden |
| Cualquier `proveedor_nombre` mostrado (`finanzas.js:252,278,319`, `app.js` varios) | Siempre `JOIN proveedores pv ON pv.id = oc.proveedor_id` en tiempo de consulta | Se resuelve solo, automáticamente, al reasignar |

**Conclusión: `proveedor_id` NO está denormalizado en ningún lado.** No
encontré ninguna tabla que guarde el nombre del proveedor como texto
plano copiado desde la OC — todo se resuelve por `JOIN` en el momento de
la consulta. La condición de parada del prompt ("si `proveedor_id`
resulta estar denormalizado... pausar y reportar antes de proponer el
diseño final") **no se activa**: reasignar `proveedor_id` es, en términos
de esquema, el `UPDATE` de una sola columna en una sola tabla.

También revisé si el portal externo de proveedores (`prompt-diagnostico-
portal-proveedores-fase1.md`) introduce alguna dependencia nueva —
sigue siendo solo diagnóstico/propuesta, no implementado, así que no hay
ningún acceso externo hoy ligado a `proveedor_id` de una OC que se vea
afectado.

## 3. Diseño del endpoint

```
PATCH /api/projects/:id/ordenes/:ocId/proveedor
Body: { proveedor_id_nuevo: number, motivo?: string }
```

**Permisos**: `h(auth.allow())` — sin argumentos. Confirmé en
`server/auth.js:952-959` que `allow(...puestos)` deja pasar a
`admin`/`desarrollador` de forma incondicional (bypass hardcodeado, no
depende de la lista de `puestos` recibida); llamarlo sin argumentos es
el patrón ya usado en el proyecto para "solo admin/desarrollador, sin
excepción" (comentario en `server/auth.js:305-306`, mismo criterio que
crear/editar/eliminar Matrices). No hace falta una whitelist nueva tipo
`USUARIOS_CONTROL_FINANCIERO` — ese patrón es para *usuarios específicos*
dentro de un rol más amplio (Control de Cuentas de Paul/Fer), no aplica
aquí porque el criterio ya es "todo admin/desarrollador", que es
exactamente lo que pide el prompt.

Middleware completo: `h(auth.allow())`, `h(requireProject)`,
`h(auth.verificarAccesoObra)`. Agregar también
`h(auth.checkPermiso('ordenes_compra', 'puede_editar'))` por consistencia
con el resto de endpoints de OC (no añade restricción real — admin/
desarrollador siempre pasan `checkPermiso`, confirmado en
`server/auth.js:733` — pero mantiene el mismo patrón de capas que ya usa
`PUT .../estado`).

**Validaciones**:
1. OC existe en el `project_id` de la ruta → `404` si no.
2. `proveedor_id_nuevo` existe y `activo = 1` en `proveedores` → `400` si no.
3. `proveedor_id_nuevo !== proveedor_id` actual → `400` "El proveedor ya es ese" (evita ruido de auditoría vacío).

**Campos que SÍ cambian**: únicamente `ordenes_compra.proveedor_id`.
**Campos que NO se tocan**: `folio`, `fecha`, `estado`, `observaciones`,
`incluye_iva`, todos los `orden_compra_items`, `recepciones`, `pagos` —
ninguno de ellos referencia `proveedor_id`, así que un `UPDATE` de una
sola columna no puede tocarlos ni por accidente (ver sección 2).

**Auditoría**: reusa `audit_log` (ya existe, sin tabla nueva), dentro de
una transacción (`db.withTransaction`), mismo patrón que
`POST /matrices/:conceptoId/aplicar` (`server/app.js:4577-4586`):

```js
await db.withTransaction(async (client) => {
  await client.query('UPDATE ordenes_compra SET proveedor_id=$1 WHERE id=$2', [proveedorIdNuevo, ocId]);
  await client.query(
    `INSERT INTO audit_log (actor_id, actor_usuario, accion, target_id, project_id, ip, detalle)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [req.user.id, req.user.usuario, 'reasignar_proveedor_oc', ocId, pid, ip,
      JSON.stringify({
        oc_folio: oc.folio,
        proveedor_anterior_id: oc.proveedor_id,
        proveedor_anterior_nombre: oc.proveedor_nombre_actual,
        proveedor_nuevo_id: proveedorIdNuevo,
        proveedor_nuevo_nombre: proveedorNuevo.nombre,
        motivo: motivo || null,
      })]
  );
});
```

**Alcance por estado — pregunta abierta para Paul**: propongo permitirlo
en **cualquier estado excepto `borrador`**. Razón: una OC en `borrador`
ya tiene un camino limpio y existente para corregir el proveedor —
`DELETE` + recrearla (el `DELETE` de línea 8449 ya solo permite
`borrador`) — así que no hace falta exponer esta vía nueva ahí también.
Para todos los demás estados (`enviada`, `confirmada`, `rechazada`,
`cancelada`, `recibida_parcial`, `recibida_completa`) no existe ningún
otro camino, así que el endpoint nuevo es la única forma de corregir un
error de captura. Si Paul prefiere incluir `borrador` también (por
conveniencia, para no obligar a borrar/recrear), no hay ninguna razón
técnica que lo impida — es una decisión de producto, no de riesgo.

## 4. UI propuesta

- Vive en el mismo modal de detalle de OC (`public/app.js`, alrededor de
  la línea 7350, junto al renglón `<div class="card-row"><span
  class="k">Proveedor</span>...`).
- Visible solo si `isAdmin()` (mismo helper ya usado en este modal para
  `puedeConfirmarOC`, línea 7344 — consistente con el resto del modal, no
  introduce un helper nuevo).
- Botón pequeño junto al valor del proveedor, ej. `✏️ Reasignar`. Al
  hacer clic abre un modal secundario con:
  - `<select>` de proveedores activos (reusa el mismo listado que ya se
    carga para crear una OC — no hace falta un endpoint nuevo de catálogo).
  - Texto mostrando "Proveedor actual: X" arriba del select.
  - Campo de texto opcional "Motivo del cambio" (va al `detalle` de
    auditoría — relevante porque el caso real es "error de captura").
  - Confirmación explícita: *"¿Seguro que quieres reasignar el proveedor
    de [folio] de **[actual]** a **[nuevo]**? Esta OC ya está en estado
    [estado] — el cambio queda registrado en auditoría."* antes de
    llamar al endpoint.
- Tras éxito: re-render del modal de detalle con el `proveedor_nombre`
  nuevo + toast de confirmación (patrón ya usado en el resto de la app).

## 5. Estimado de esfuerzo para Fase 1

El cambio es acotado: un endpoint nuevo (un `UPDATE` de una columna +
`INSERT` a `audit_log` ya existente, sin tabla nueva ni migración), un
botón + modal reusando componentes ya existentes (`isAdmin()`, listado de
proveedores, patrón de confirmación). No hay que tocar `pagos`,
`recepciones` ni ningún otro módulo.

**Estimado: ~30-40 min con Claude Code (Sonnet 5, esfuerzo Medio)** —
más que el mínimo de un solo endpoint porque conviene probar el flujo
completo en Preview (reasignar en una OC de prueba en cada estado
relevante, confirmar que `audit_log` queda bien y que pagos/recepciones
no se mueven) antes de tocar Producción, dado que es un dato financiero.

## Abierto para Paul antes de Fase 1

1. ¿Alcance por estado: cualquier estado excepto `borrador` (propuesta de
   arriba), o prefieres algo más restringido (ej. solo para las OCs ya
   recibidas, que es el caso real)?
2. ¿Cuál es el proveedor correcto para OC ROF-14? (no se tocó en esta
   fase, según lo pedido).
