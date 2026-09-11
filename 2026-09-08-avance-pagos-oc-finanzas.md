# Prompt D — Avance: candado duro + advertencia

Objective:
Impedir que el módulo de Avance físico por concepto permita guardar una cantidad ejecutada que haga que el acumulado supere la cantidad presupuestada del concepto. Al intentarlo, debe bloquear el guardado y mostrar una advertencia clara indicando el exceso.

Starting State:
- Modal "Avance físico por concepto — Semana X" (`public/app.js`) permite capturar "Ejecutado este periodo" sin ninguna validación contra `cantidad_presupuestada`
- Ejemplo reproducido: concepto con 55 ML presupuestados, acumulado previo 43 ML, se capturan 43 ML más → acumulado 86 ML = 156.4%, guardado sin bloqueo ni aviso
- No se conoce aún el endpoint exacto que persiste el avance semanal — localizarlo en `server/app.js` como parte de este prompt (probablemente relacionado a tabla de avance por concepto/semana)
- Decisión de negocio ya tomada por Paul: bloqueo duro, con advertencia visible

Target State:

1. VALIDACIÓN BACKEND (fuente de verdad):
   - En el endpoint que persiste el avance semanal por concepto, antes de guardar: calcular `acumulado_previo + ejecutado_este_periodo` y compararlo contra `cantidad_presupuestada` del concepto
   - Si excede: responder con error (400 o similar) y un mensaje claro, ej: `"El acumulado (X) superaría lo presupuestado (Y). Máximo permitido este periodo: Z"`
   - Calcular y devolver en el mensaje el máximo permitido (`cantidad_presupuestada - acumulado_previo`) para que el usuario sepa cuánto sí puede capturar

2. VALIDACIÓN FRONTEND (advertencia inmediata, no solo al guardar):
   - Al escribir en el campo "Ejecutado este periodo", si el acumulado resultante excede lo presupuestado, mostrar una advertencia visible en el modal (texto en rojo/naranja junto al campo) antes de que el usuario intente guardar
   - Al hacer clic en "Guardar" con un valor que excede, bloquear el submit y mostrar el mismo mensaje de error que regresa el backend (no inventar un mensaje distinto en frontend)

3. CASOS EDGE:
   - Si `cantidad_presupuestada` es 0 o no existe para el concepto, documentar qué debe pasar (probablemente: no aplicar candado, permitir captura libre) — si no es obvio en el código existente, marcarlo como Stop Condition

Allowed Actions:
- Modificar el endpoint de guardado de avance semanal en `server/app.js`
- Modificar el modal de captura de avance en `public/app.js`
- Agregar función de validación compartida si backend y frontend necesitan la misma lógica de cálculo

Forbidden Actions:
- NO modificar el cálculo de `acumulado_previo` existente — solo agregar la validación de tope
- NO aplicar este candado a otros módulos (ej. Destajo, Estimaciones) que no fueron mencionados
- NO ejecutar SQL contra Producción

Stop Conditions:
- Si `cantidad_presupuestada` puede ser 0/nula en casos legítimos y no está claro qué comportamiento debe tener el candado en ese caso
- Si el mismo endpoint es usado por más de un módulo y el candado no debe aplicar igual en todos

Checkpoints:
✅ Backend rechaza con error claro un intento de exceder presupuesto (verificar con request HTTP real, status code y body literal)
✅ Frontend muestra advertencia antes de guardar, no solo después del rechazo del backend
✅ Un avance dentro del límite se guarda normalmente sin falsos positivos
✅ Lista de archivos modificados con resumen de cada cambio

Estimación: 30–45 min con Claude Code + Sonnet 5 a esfuerzo medio.

---

# Prompt E — Pagos: editar/cancelar + tope al importe de la O.C

Objective:
Permitir editar o cancelar (soft-delete) un pago ya registrado, y evitar que el total de pagos registrados contra una Orden de Compra pueda superar el importe autorizado de esa O.C.

Starting State:
- Diagnóstico Fase 0 ya ejecutado (Prompt C, sesión previa) con estos hallazgos confirmados:
  - Tabla `pagos` (`server/db.js:438-449`) no tiene columna `activo` ni ningún mecanismo de soft-delete
  - `POST /api/projects/:id/ordenes/:ocId/pagos` (`server/app.js:9198`) no valida unicidad ni tope contra el importe autorizado de la O.C — solo valida `monto > 0` y estado pagable
  - Ya existe `DELETE /api/projects/:id/ordenes/:ocId/pagos/:pagoId` (`server/app.js:9226`), pero hace `DELETE FROM pagos` **físico** — viola la regla del proyecto de nunca borrar físicamente registros financieros — y no está conectado a ningún botón del frontend (`pagosHtml` en `public/app.js:7813-7818` es de solo lectura). Es código muerto hoy, no un endpoint en uso
- Regla ya establecida en el proyecto: no hay borrado físico de registros financieros, solo soft-delete (`activo=0`, `baja`, etc.)
- Decisión de negocio ya tomada por Paul:
  - Un pago se puede editar o cancelar (soft-delete/borrar lógicamente), no solo crear una vez y quedar fijo
  - La suma de pagos activos contra una O.C no puede superar el importe autorizado de esa O.C

Target State:

1. EDITAR PAGO:
   - Nuevo endpoint `PUT /api/pagos/:id` (o el nombre que corresponda al recurso real una vez localizado) que permita actualizar monto/fecha/referencia de un pago existente
   - Al editar, re-validar que la suma de pagos activos (excluyendo el pago que se está editando, con su nuevo valor) no exceda el importe autorizado de la O.C

2. CANCELAR PAGO (soft-delete) — CORREGIR endpoint existente, no crear uno nuevo:
   - `DELETE /api/projects/:id/ordenes/:ocId/pagos/:pagoId` (`server/app.js:9226`) ya existe pero hace `DELETE FROM pagos` físico — cambiarlo a soft-delete: agregar columna `activo` a la tabla `pagos` (no existe hoy) y reemplazar el DELETE físico por `UPDATE pagos SET activo = false WHERE id = :pagoId`
   - Conectar este endpoint a un botón real en el frontend (`pagosHtml`, `public/app.js:7813-7818` es de solo lectura hoy — agregar la acción de cancelar ahí)
   - Al cancelar, el importe de ese pago deja de contar en la suma acumulada contra la O.C (todas las queries de suma de pagos deben filtrar `WHERE activo = true`)

3. TOPE AL IMPORTE AUTORIZADO DE LA O.C:
   - En el endpoint de creación de pago (ya existente), antes de guardar: sumar los pagos activos ya registrados contra esa O.C + el nuevo monto, y comparar contra el importe autorizado de la O.C
   - Si excede: rechazar con mensaje claro indicando el importe ya pagado, el autorizado, y el máximo disponible para pagar

4. OWNERSHIP / PERMISOS:
   - Aplicar `checkPermiso()` a los nuevos endpoints PUT/DELETE igual que a los existentes de creación de pago — no dejar estos nuevos endpoints sin protección
   - Verificar si aplica el mismo tipo de check de ownership de obra usado en `usuarioPuedeOperarObra` (PR #231) o si los pagos no tienen ese mismo alcance por obra — confirmar antes de asumir

Allowed Actions:
- Crear los endpoints PUT/DELETE de pagos en `server/app.js`
- Modificar el endpoint de creación de pago existente para agregar la validación de tope
- Modificar la UI de pagos en `public/app.js` para exponer editar/cancelar

Forbidden Actions:
- NO implementar borrado físico de pagos bajo ninguna circunstancia
- NO tocar la lógica de autorización/rechazo de la O.C — eso es el Prompt F (Fase 0), separado
- NO ejecutar SQL contra Producción

Stop Conditions:
- Si el modelo de datos de pagos no tiene relación directa a una O.C con importe autorizado identificable — pausar y reportar antes de inventar una relación
- Si editar un pago ya pagado/conciliado tiene implicaciones contables que no están claras (ej. reportes ya generados) — pausar y preguntar

Checkpoints:
✅ Editar un pago recalcula correctamente el acumulado contra la O.C (verificado con HTTP real)
✅ Cancelar un pago es soft-delete real (verificar que el registro sigue en la DB con `activo=false`, no eliminación física)
✅ Intento de pago que excede el importe autorizado de la O.C es rechazado con mensaje claro (status code y body literal)
✅ Endpoints nuevos protegidos con `checkPermiso()` (verificar 403 para un rol sin acceso)
✅ Lista de archivos modificados con resumen de cada cambio

Estimación: 1–1.5 h con Claude Code + Sonnet 5 a esfuerzo medio.

---

# Prompt F (Fase 0 — SOLO DIAGNÓSTICO) — Autorización y rechazo de O.C restringido a Finanzas

Objective:
Diagnosticar qué existe hoy en el flujo de autorización/pago de Órdenes de Compra, y qué haría falta para restringir la autorización y el pago del importe autorizado exclusivamente al área de Finanzas, incluyendo la capacidad de rechazar una O.C. NO implementar todavía — este prompt es solo diagnóstico.

Starting State:
- Roles de campo conocidos hoy: `residente`, `cabo`, `compras`, `operador`, `jefe_maquinaria` — no existe un rol `finanzas` confirmado; verificar en `server/auth.js` (`isValidPuesto()`, `PERMISSIONS`) si ya existe con otro nombre
- La navegación y permisos en este proyecto viven en `PERMISSIONS.<rol>.tabs` en `server/auth.js` — cualquier rol/módulo nuevo requiere actualizarlo ahí, además de las listas de allowlist en `/api/bienvenida`, `/api/clientes`, `/api/projects`, y el CHECK constraint en `server/db.js` (CREATE TABLE y ALTER TABLE) — históricamente omitir alguno de estos puntos ha causado bugs (Costos, jefe_maquinaria bootstrap 403)
- Decisión de negocio ya tomada por Paul: solo Finanzas autoriza y paga el importe autorizado de una O.C, y esa misma pantalla debe permitir rechazar la O.C

Target State (solo diagnóstico, no implementación):

1. Localizar el flujo actual de autorización de O.C: ¿quién puede autorizarla hoy? ¿existe ya un estado "rechazada" en el modelo de datos de O.C, o solo "autorizada"/"pendiente"?
2. Confirmar si existe ya un rol equivalente a "finanzas" (aunque se llame distinto) o si es 100% nuevo
3. Si es un rol nuevo: listar exhaustivamente todos los puntos que requeriría tocar (siguiendo el patrón ya documentado del proyecto: `PERMISSIONS` en auth.js, CHECK constraints en db.js, allowlists de bienvenida/clientes/projects, tabs de navegación en frontend)
4. Confirmar si el importe autorizado de la O.C ya es un campo existente o necesita agregarse
5. Reportar como hallazgo (no implementar): alcance real estimado del cambio, y si hay algo que se pueda reutilizar del patrón de otros roles (ej. `jefe_maquinaria`) para minimizar el riesgo

Allowed Actions:
- Lectura de código vía `git show`/`git archive`
- Consultas SELECT de solo lectura en Preview

Forbidden Actions:
- NO implementar el rol ni ningún endpoint todavía
- NO tocar Producción

Stop Conditions:
- Ninguna especial — este prompt es puramente de lectura/diagnóstico, reportar hallazgos y esperar decisión sobre cómo proceder

Checkpoints:
✅ Confirmación de si el rol Finanzas existe o es nuevo, con evidencia literal (grep/output real)
✅ Lista exhaustiva de puntos a modificar si es nuevo
✅ Estado actual del flujo de autorización/rechazo de O.C documentado
✅ Reporte final en el mismo formato de hallazgos usado en diagnósticos previos, sin cambios de código

Estimación: 20–30 min con Claude Code + Sonnet 5 a esfuerzo medio.
