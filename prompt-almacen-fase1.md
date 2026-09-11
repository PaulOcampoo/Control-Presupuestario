Objective:
Fase 1 del módulo Almacén: estructura de datos y captura de Entradas (recepción de material, captura directa) y Salidas (consumo en obra, vinculado manualmente a concepto), reutilizando el catálogo de `insumos` existente. Sin dashboard de existencias ni conciliación todavía — eso es Fase 2 y 3, deliberadamente fuera de este prompt.

Starting State:
- No existe ninguna tabla de almacén/inventario en el schema — confirmado por diagnóstico previo.
- `insumos` (código, nombre, categoría, unidad) es 100% reutilizable como catálogo base — `unidad` confirmada consistente en toda la base (0 nulos, 0 inconsistencias por código).
- `recepciones`/`recepcion_items` existen pero requieren `orden_compra_id` obligatorio y casi no se usan en operación real (2 recepciones en las 7 obras reales) — decisión ya tomada: Almacén NO depende de este flujo, captura Entradas de forma directa e independiente. Puede opcionalmente referenciar una OC si existe, pero nunca la requiere.
- `concepto_insumos` confirmada vacía — vínculo Salida→Concepto es 100% selección manual del usuario al capturar, no hay automatización posible.
- Patrón de fotos/adjuntos ya usado en el sistema: Vercel Blob (igual que Contrato) — reutilizar el mismo patrón para folio de factura/remisión con foto en Entradas.
- Pendiente de confirmar con Paul (no bloqueante para este prompt): si Grupo Roforb opera con almacenista/almacén físico centralizado — este prompt asume captura de movimientos independientemente de esa respuesta; el diseño de "quién puede capturar" puede ajustarse después sin tocar el schema base.

Target State:

1. SCHEMA (`server/db.js`):
   - `almacen_entradas`: id, project_id (FK), insumo_id (FK a insumos), fecha, proveedor (texto libre o `proveedor_id` si aplica reutilizar catálogo de Proveedores existente — confirmar en Fase 0 de este mismo prompt si Proveedores está scoped por proyecto o es global, para decidir el tipo de vínculo), cantidad, costo_unitario, folio_factura_remision, foto_url (nullable, Vercel Blob), orden_compra_id (nullable, FK opcional a `ordenes_compra`), observaciones, usuario_id, creado_en.
   - `almacen_salidas`: id, project_id (FK), insumo_id (FK), fecha, cantidad, concepto_id (nullable, FK a `conceptos` — selección manual, nullable porque no siempre habrá concepto claro), responsable_retiro (texto libre — cubre residente o subcontratista sin depender de que todos tengan usuario en el sistema), observaciones, usuario_id (quien captura, distinto de responsable_retiro), creado_en.
   - Agregar ambas tablas en `CREATE TABLE` (no solo `ALTER TABLE`), por convención del proyecto.
   - Ambas con soft-delete (`activo` INTEGER 0/1, nunca borrado físico) — consistente con la regla dura del proyecto.

2. FASE 0 interna (hacer primero, dentro de este mismo prompt, antes de crear tablas):
   - Confirmar si `proveedores` está scoped por `project_id` o es catálogo global, para decidir si `almacen_entradas.proveedor` es texto libre o FK.
   - Confirmar qué rol(es) deben poder capturar Entradas/Salidas — proponer reutilizar roles existentes (ej. `compras` para Entradas, `residente`/`cabo` para Salidas) en vez de crear un rol `almacenista` nuevo, salvo que Paul confirme que sí necesita uno dedicado (si es así, pausar y confirmar antes de tocar `server/auth.js`).

3. BACKEND:
   - `POST /api/projects/:id/almacen/entradas` y `GET` (lista, filtrable por insumo/fecha).
   - `POST /api/projects/:id/almacen/salidas` y `GET` (lista, filtrable por insumo/concepto/fecha).
   - Upload de foto de remisión reutilizando el patrón de Vercel Blob ya usado en Contrato.
   - Scoping de proyecto (403 si no asignado) y `checkPermiso` consistente con el resto del sistema.

4. FRONTEND:
   - Nueva sección "Almacén" en la navegación (ubicar junto a Compras — Requisiciones/Proveedores/OC — salvo que la Fase 0 interna sugiera otra ubicación).
   - Formulario de captura de Entrada: insumo (buscador sobre catálogo existente), proveedor, fecha, cantidad, costo unitario, folio, foto opcional.
   - Formulario de captura de Salida: insumo, fecha, cantidad, concepto (selector opcional sobre `conceptos` de la obra), responsable de retiro (texto libre).
   - Lista simple de movimientos (Entradas y Salidas por separado o combinadas con filtro tipo) — sin dashboard de existencias todavía, solo la bitácora.

Allowed Actions:
- Modificar `server/db.js` (schema nuevo), crear módulo backend (`server/almacen.js` o similar), registrar rutas en `server/app.js`.
- Modificar `server/auth.js` solo si la Fase 0 interna confirma que hace falta un permiso nuevo (no un rol nuevo, salvo confirmación explícita).
- Modificar `public/app.js` para la nueva sección.
- Bump `SW_VERSION`.

Forbidden Actions:
- NO construir dashboard de existencias en tiempo real ni conciliación presupuesto vs almacén — eso es Fase 2/3, fuera de este prompt.
- NO hacer `orden_compra_id` obligatorio en `almacen_entradas` — debe poder capturarse sin OC, ese es el punto de este diseño.
- NO crear un rol `almacenista` nuevo sin confirmación explícita de Paul.
- NO intentar automatizar el vínculo Salida→Concepto vía `concepto_insumos` — está confirmada inviable, selección manual únicamente.

Stop Conditions:
- Si la Fase 0 interna revela que `proveedores` tiene una estructura que complica el vínculo (ej. scoping inconsistente entre obras) — pausar y reportar antes de decidir texto libre vs FK.
- Si asignar permisos a roles existentes para Entradas/Salidas requiere tocar más de 2 lugares en `server/auth.js` (recordar el aprendizaje ya documentado: agregar un módulo a un rol requiere tocarlo en varios puntos, ha causado bugs antes) — pausar y confirmar el alcance con Paul antes de continuar.

Checkpoints:
✅ Fase 0 interna resuelta: tipo de vínculo a Proveedores decidido, roles con permiso confirmados.
✅ Migración de schema aplicada y verificada en Preview.
✅ Endpoints verificados con output literal: captura de Entrada con foto, captura de Salida con y sin concepto seleccionado.
✅ Vista verificada en navegador real (Playwright + WebKit).
✅ vitest completo en serie, sin regresiones nuevas.
✅ Lista final de archivos modificados.

Estimado: esfuerzo Medio — Claude Code + Sonnet 5, ~3-4 horas (Fase 1 únicamente, sin dashboard).
