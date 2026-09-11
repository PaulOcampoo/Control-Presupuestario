# Prompt A — Bug: Admin sin permiso para registrar consumible

**Estimado:** Claude Code + Sonnet 5, esfuerzo Medio (~1h, incluye Fase 0 diagnóstica)

```
Objective:
Corregir que un usuario con rol admin reciba "No tienes permiso para realizar esta acción" al guardar el modal "Registrar consumible" en Maquinaria, cuando la regla del sistema es que admin y desarrollador tienen bypass total de permisos, siempre hardcodeado.

Starting State:
- Rodolfo (rol Administrador, ver navbar) abre Maquinaria → Consumibles → "Registrar consumible", llena el formulario (Equipo, Tipo de consumible, Fecha, Cantidad) y al dar Guardar recibe el toast "No tienes permiso para realizar esta acción".
- Regla documentada del sistema: admin y desarrollador bypass total de permisos, siempre hardcodeado, no dependen de tablas de permisos.
- Sistema de permisos granulares (`permisos_usuario`) está wireado explícitamente solo a endpoints de Nómina y Destajo — Maquinaria/Consumibles no debería estar usando ese sistema.

Target State:

1. FASE 0 — DIAGNÓSTICO (obligatorio antes de codear):
   - Localizar el endpoint detrás de "Guardar" en el modal Registrar consumible
   - Confirmar qué middleware/chequeo de permiso usa ese endpoint: ¿`checkPermiso()` (sistema granular) o `auth.allow()` (basado en rol)?
   - Si usa `checkPermiso()`: confirmar si Maquinaria fue agregado sin querer al scope granular, o si falta el bypass hardcodeado de admin/desarrollador dentro de esa función
   - Si usa `auth.allow()`: confirmar si el rol "admin" está correctamente incluido en la lista de roles permitidos para ese endpoint específico
   - Reportar causa raíz antes de aplicar el fix

2. FIX (según lo que revele Fase 0):
   - Si falta el bypass de admin/desarrollador en el chequeo de este endpoint: agregarlo siguiendo el mismo patrón hardcodeado usado en el resto del sistema
   - Si el endpoint fue mal incluido en la tabla `permisos_usuario`/scope granular: removerlo de ese scope y volver a `auth.allow()` estándar
   - Aplicar el mismo fix a los demás endpoints de Maquinaria si comparten el mismo bug (Catálogo de equipos, Bitácora de taller, Estado de las unidades — confirmar en Fase 0 si todos usan el mismo middleware)

Allowed Actions:
- Modificar el/los endpoint(s) de Maquinaria identificados en Fase 0
- Leer (no modificar) `permisos_usuario` y la función `checkPermiso()` para entender el bypass existente en Nómina/Destajo y replicarlo

Forbidden Actions:
- NO modificar el comportamiento de permisos para roles no-admin (residente, cabo, etc.)
- NO tocar Nómina ni Destajo — su sistema granular ya funciona correctamente
- NO ampliar el scope granular a Maquinaria como "solución" — el bypass de admin debe funcionar sin depender de ese sistema

Stop Conditions:
Pausar y reportar si:
- El bug está presente en más de 3 endpoints distintos de Maquinaria (evaluar si conviene un fix centralizado en vez de puntual)
- El bypass hardcodeado de admin/desarrollador no existe como función reusable en ningún lado del código (indicaría que hay que crearlo, decisión de mayor alcance)

Checkpoints:
✅ Fase 0 reportada con causa raíz exacta (endpoint + tipo de chequeo de permiso)
✅ Admin puede guardar un consumible de prueba sin error (output HTTP/terminal, no captura de UI)
✅ Confirmado que roles no-admin mantienen su comportamiento de permisos sin cambios
✅ Lista final de archivos modificados con resumen de cada cambio
```

---

# Prompt B — Feature: Editar y eliminar consumibles capturados

**Estimado:** Claude Code + Sonnet 5, esfuerzo Medio (~2h, incluye Fase 0 diagnóstica)

```
Objective:
Agregar la posibilidad de editar y eliminar registros de consumibles capturados, en todos los módulos de Maquinaria donde aplique.

Starting State:
- Pantalla Consumibles muestra tabla agregada (Equipo, Consumible, Total L, Costo estimado, # Capturas) con botón "+ Consumibles" para crear, pero sin ninguna acción de editar o eliminar sobre lo ya capturado.
- No se sabe aún si la tabla agregada representa filas individuales de captura o un rollup de varias capturas por equipo+tipo — esto determina si editar/eliminar debe operar sobre el agregado o requiere una vista de detalle por captura individual.
- Regla dura documentada del sistema: ninguna eliminación física de registros financieros — solo soft-delete.

Target State:

1. FASE 0 — DIAGNÓSTICO (obligatorio antes de codear):
   - Confirmar el modelo de datos real detrás de la tabla Consumibles: ¿existe una tabla de capturas individuales (una fila por registro del modal "Registrar consumible"), y la tabla mostrada es un agregado por Equipo+Tipo?
   - Si es agregado: definir si editar/eliminar debe abrir un listado de capturas individuales (necesita nueva vista) o si el agregado permite acciones directas (necesitaría redefinir qué significa "editar un agregado")
   - Confirmar si existen ya endpoints de creación (`POST`) que se puedan usar como referencia de patrón para `PUT`/`DELETE`
   - Confirmar si "eliminación física" aplica a consumibles (no son un registro financiero puro como pagos, pero Costo estimado sí es dato financiero derivado) — reportar y proponer si aplica soft-delete o hard-delete antes de implementar

2. UI (frontend), en Consumibles y demás sub-módulos de Maquinaria que muestren capturas (confirmar en Fase 0 cuáles aplican: Catálogo de equipos, Bitácora de taller, Estado de las unidades):
   - Ícono/acción de editar y eliminar por registro (o por captura individual, según lo que resuelva Fase 0)
   - Modal de edición reusando el mismo formulario del modal "Registrar consumible", precargado con los valores existentes
   - Confirmación explícita antes de eliminar (modal de confirmación, no eliminación de un clic)

3. BACKEND:
   - Endpoint `PUT` para editar una captura de consumible
   - Endpoint `DELETE` (soft-delete si Fase 0 confirma que aplica) para eliminar una captura
   - Verificación de ownership de proyecto/equipo antes de cualquier operación (mismo patrón anti-IDOR del resto del sistema)
   - Aplicar el fix de bypass de admin del Prompt A antes o junto con este, para no bloquear a admin en las nuevas acciones

Allowed Actions:
- Crear nuevos endpoints backend para editar/eliminar consumibles
- Modificar la tabla/vista de Consumibles en frontend para agregar las acciones
- Agregar columna `deleted_at` o equivalente si Fase 0 confirma que se requiere soft-delete y no existe aún en esa tabla

Forbidden Actions:
- NO eliminar físicamente registros si Fase 0 determina que aplica la regla dura de soft-delete
- NO modificar el modal de creación existente más allá de lo necesario para reusarlo en edición
- NO tocar otros módulos de Maquinaria fuera de los que Fase 0 confirme que muestran capturas de consumibles

Stop Conditions:
Pausar y reportar si:
- El modelo de datos requiere una migración de esquema significativa (ej. separar agregado en capturas individuales) — confirmar alcance con Paul antes de proceder
- No queda claro si aplica soft-delete o hard-delete a consumibles — no asumir, preguntar

Checkpoints:
✅ Fase 0 reportada con modelo de datos confirmado y decisión de soft/hard-delete
✅ Editar consumible funcional, verificado con output HTTP/terminal en datos de prueba
✅ Eliminar consumible funcional, con confirmación de que no fue eliminación física si aplica soft-delete
✅ Ownership check probado: usuario sin acceso al proyecto/equipo recibe 403
✅ Lista final de archivos modificados con resumen de cada cambio
```
