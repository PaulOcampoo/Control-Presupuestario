# Prompt — Requisición con múltiples proveedores → varias Órdenes de Compra

**Estimado:** Claude Code + Sonnet 5, esfuerzo Alto (~4–5h, incluye Fase 0 diagnóstica)

```
Objective:
Permitir que dentro de una misma requisición autorizada, cada insumo/renglón se asigne a un proveedor distinto, y que "Generar OC" produzca una Orden de Compra separada por cada proveedor distinto presente en la requisición, en una sola acción.

Starting State:
- Actualmente una requisición selecciona un único proveedor aplicado a todos sus insumos, y "Generar OC" produce una sola Orden de Compra con todos ellos.
- Órdenes de Compra ya calculan breakdown Subtotal/IVA/Total y toggle "incluye IVA"/"sin IVA" (default: incluye) — lógica reusable, debe operar sobre un subconjunto de renglones en vez de la requisición completa.
- Botón "Generar OC" es dinámico: solo visible cuando el estatus de la requisición es "autorizada".
- No se conoce aún si `proveedor_id` vive en la tabla de requisición (header) o en cada renglón/insumo — a confirmar en Fase 0.

Target State:

1. FASE 0 — DIAGNÓSTICO (obligatorio antes de codear):
   - Confirmar estructura exacta de la(s) tabla(s) de requisición: ¿existe una tabla de renglones/items separada de la cabecera de requisición, o los insumos viven en una sola tabla plana?
   - Confirmar dónde vive `proveedor_id` actualmente (cabecera vs renglón)
   - Confirmar cómo se relaciona `ordenes_compra` con los insumos que contiene: ¿hay una tabla puente `orden_compra_items`, o la OC apunta directo a `requisicion_id` y asume "todos los renglones"?
   - Confirmar el código exacto detrás del botón "Generar OC" (endpoint, función) para entender qué debe generalizarse a "generar N OCs"
   - Reportar hallazgos antes de implementar

2. MODELO DE DATOS:
   - Si `proveedor_id` está en la cabecera de requisición: moverlo a nivel de renglón (agregar columna `proveedor_id` a la tabla de renglones/insumos de requisición)
   - Si no existe tabla puente `orden_compra_items`: crearla, para que cada OC generada apunte solo a los renglones que le corresponden (no a la requisición completa)
   - Mantener `requisicion_id` en cada OC generada, para trazabilidad de que varias OCs provienen de la misma requisición

3. UI DE REQUISICIÓN:
   - Selector de proveedor por renglón/insumo (no uno global para toda la requisición)
   - Valor por defecto: si el usuario no cambia nada, todos los renglones pueden heredar un mismo proveedor inicial (comportamiento actual como default), pero cada renglón queda editable individualmente

4. GENERACIÓN DE OCs:
   - Al presionar "Generar OC" (o renombrar a "Generar Órdenes de Compra" si aplica): agrupar renglones por `proveedor_id`, crear una Orden de Compra por cada grupo, cada una con su propio breakdown Subtotal/IVA/Total calculado solo sobre sus renglones
   - Generar todas las OCs de la requisición en una sola acción — NO permitir generación parcial/escalonada por proveedor en esta versión
   - Actualizar el estatus de la requisición a estado "OC generada" (o el que use el sistema) solo cuando TODAS las OCs de todos los proveedores fueron creadas exitosamente

Allowed Actions:
- Modificar schema de requisición/renglones vía `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (sin migraciones, mismo patrón del resto del sistema)
- Crear tabla puente `orden_compra_items` si Fase 0 confirma que no existe
- Modificar el endpoint/función de "Generar OC" para iterar por proveedor
- Modificar UI de captura/edición de requisición para selector de proveedor por renglón

Forbidden Actions:
- NO modificar el cálculo de Subtotal/IVA/Total en sí (la lógica ya existe y funciona) — solo cambiar el alcance de renglones sobre los que opera
- NO permitir que una requisición quede en estado ambiguo (algunas OCs generadas, otras no) sin manejo explícito de ese caso
- NO tocar Proveedores (catálogo) ni otros módulos fuera de Requisiciones/Órdenes de Compra

Stop Conditions:
Pausar y reportar si:
- Mover `proveedor_id` de cabecera a renglón rompe alguna consulta o reporte existente que dependa de "un proveedor por requisición" (buscar todos los usos antes de mover)
- Existen requisiciones ya autorizadas en producción con OC generada bajo el modelo viejo — confirmar cómo tratarlas (¿migración de datos, o coexistencia de ambos modelos?) antes de tocar producción
- El manejo de generación parcial (si alguna OC falla a mitad del proceso, ej. error de red) no tiene una estrategia clara de rollback/reintento

Checkpoints:
✅ Fase 0 reportada con estructura real de tablas y ubicación actual de proveedor_id
✅ Requisición de prueba con 2+ proveedores distintos genera correctamente 2+ OCs separadas, cada una con su propio Subtotal/IVA/Total
✅ Requisición con un solo proveedor (caso actual) sigue funcionando sin regresión
✅ Verificado que ninguna OC ya generada en producción antes del cambio se vio afectada
✅ Lista final de archivos modificados con resumen de cada cambio
```
