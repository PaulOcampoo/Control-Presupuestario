Objective:
Diagnóstico de solo lectura antes de diseñar el módulo Almacén (entradas/salidas/existencias/conciliación): confirmar qué tan reutilizable es la infraestructura ya existente de OC/Recepciones para "Entradas" (evitar captura doble), y qué tan viable es vincular una "Salida" a un concepto de presupuesto dado el estado real de `concepto_insumos`.

Starting State:
- Propuesta de módulo Almacén (de otra conversación) plantea: catálogo (reusa insumos), Entradas (compras/recepción con proveedor/fecha/cantidad/costo/folio), Salidas (consumo vinculado a concepto, con responsable), Existencias en tiempo real, Conciliación presupuesto vs almacén.
- Ya existe (confirmado en diagnósticos previos de esta sesión): `ordenes_compra` → `orden_compra_items` (cantidad_ordenada, precio_unitario) → `recepciones`/`recepcion_items` (cantidad_recibida por renglón) — cubre proveedor/fecha/cantidad/costo/folio a nivel de renglón de insumo.
- `concepto_insumos` (tabla puente concepto↔insumo) confirmado vacía o casi vacía (0-1 fila) en las 7 obras reales, y sin columna `cantidad` — ya bloqueó el desglose de Presupuesto por categoría en Corte de Obra v1, obligando a usar `insumos.importe_presupuesto` en su lugar.
- No se ha confirmado si ya existe alguna tabla de inventario/almacén en el schema (`server/db.js`) que no se haya visto en diagnósticos anteriores.

Target State (solo investigación, reportar con evidencia):

1. ¿EXISTE YA ALGO DE ALMACÉN/INVENTARIO?
   - Buscar en `server/db.js` cualquier tabla relacionada (`almacen`, `inventario`, `existencias`, `stock`, etc.). Confirmar que no hay nada parcialmente construido que se esté por duplicar.

2. RECEPCIONES COMO FUENTE DE "ENTRADAS":
   - Confirmar de nuevo el detalle exacto de `recepciones`/`recepcion_items` (columnas, si tienen foto/adjunto ya soportado vía Vercel Blob como en Contrato, folio de factura/remisión disponible o solo folio de OC).
   - Confirmar si hay recepciones que NO vienen de una OC (ej. material que entra sin pasar por el flujo de Requisición→OC) — si existen, Entradas de Almacén necesitaría un camino de captura directa además de leer recepciones, y hay que dimensionarlo.

3. VIABILIDAD DE "SALIDA → CONCEPTO":
   - Confirmar el estado actual de `concepto_insumos` en las 7 obras reales (¿sigue igual de vacía que en el diagnóstico anterior, o cambió?).
   - Si sigue vacía: confirmar que la única opción viable es que el usuario elija el concepto manualmente al capturar cada Salida (no depender de un vínculo automático inexistente).

4. UNIDAD DE MEDIDA Y CATÁLOGO:
   - Confirmar que `insumos.unidad` es consistente y suficiente para heredar en Almacén sin conflictos (la propuesta pide "no permitir inconsistencias") — revisar si hay insumos con unidad nula o inconsistente entre obras para el mismo código.

5. OPERACIÓN REAL (para Paul, no investigación de código):
   - Confirmar con Paul/Grupo Roforb si sus obras operan con almacén físico centralizado (entradas/salidas controladas por un almacenista) o si el material se consume directo a pie de obra — esto determina si "responsable de retiro" y "existencias físicas" tienen sentido operativo tal como está planteado.

Allowed Actions:
- Solo lectura: schema, código.

Forbidden Actions:
- NO modificar código ni datos.
- NO diseñar tablas todavía — este prompt es exclusivamente diagnóstico.

Stop Conditions:
- Ninguna — reportar hallazgos y esperar instrucción antes de diseñar el módulo.

Checkpoints:
✅ Confirmación de si ya existe algo de almacén/inventario en el schema.
✅ Detalle completo de `recepciones`/`recepcion_items` y confirmación de si cubren o no el 100% de las "Entradas" que la propuesta pide.
✅ Estado actualizado de `concepto_insumos` en las 7 obras reales.
✅ Confirmación de consistencia de `insumos.unidad`.
✅ Recomendación: qué construir desde cero (Salidas, Existencias, Conciliación) vs qué reutilizar tal cual (Entradas vía Recepciones).

Estimado: esfuerzo Bajo — Claude Code + Sonnet 5, ~30-45 min.
