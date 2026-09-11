# Prompt — Bug: residente no ve estimaciones generadas por otro usuario

**Estimado:** Claude Code + Sonnet 5, esfuerzo Bajo-Medio (~1h, incluye Fase 0 diagnóstica)

```
Objective:
Corregir que el usuario Raúl (rol residente) no pueda ver las estimaciones generadas en el sistema para la obra 749 (cliente VINTE, "749 ...") cuando esas estimaciones fueron creadas por otro usuario (Paul). Las estimaciones de una obra deben ser visibles a cualquier usuario con acceso a esa obra, sin importar quién las generó.

Starting State:
- Reportado: Raúl (puesto = residente) tiene acceso asignado a la obra 749 (o al menos se espera que sí — confirmar en Fase 0), pero no ve estimaciones que Paul generó en esa misma obra.
- No se conoce aún si el filtro incorrecto está en:
  (a) el endpoint de consulta de estimaciones filtrando por usuario creador en vez de por proyecto,
  (b) el sistema de permisos granulares (`permisos_usuario`) sin fila para Raúl en la sección Estimaciones,
  (c) la asignación de obra de Raúl no incluye realmente la obra 749 (problema de datos, no de código),
  (d) algo específico del rol `residente` en `PERMISSIONS`/`auth.allow()` para la sección Estimaciones

Target State:

1. FASE 0 — DIAGNÓSTICO (obligatorio antes de codear):
   - Confirmar en la base real: ¿Raúl tiene asignación explícita a la obra 749 en la tabla de asignación de proyectos por usuario? (descartar primero causa (c), la más simple)
   - Confirmar el endpoint que sirve el listado de estimaciones (`GET /api/projects/:id/estimaciones` o equivalente) y revisar su query: ¿filtra por `usuario_creador_id` / `creado_por` además de por `project_id`, o solo por `project_id`?
   - Confirmar si `checkPermiso('estimaciones', 'puede_ver')` (sistema granular) está wireado a este endpoint, y si Raúl tiene fila en `permisos_usuario` para esa sección — comparar contra cómo se le dio acceso a otras secciones que sí funcionan para él
   - Reproducir el bug con las credenciales/rol de Raúl (o un usuario de prueba con puesto=residente y la misma asignación de obra) contra Preview, y capturar el request/response real
   - Reportar causa raíz exacta antes de aplicar el fix

2. FIX (según lo que revele Fase 0):
   - Si es (a): quitar el filtro por creador — las estimaciones de una obra pertenecen a la obra, no a quien las generó; el control de acceso debe ser únicamente por ownership de proyecto (mismo patrón usado en el resto del sistema)
   - Si es (b): agregar la fila de permiso correspondiente para el rol `residente` en `permisos_usuario` para la sección Estimaciones (puede_ver), o corregir el default si `residente` debería tener `puede_ver=true` en Estimaciones por defecto
   - Si es (c): no es un bug de código — es un problema de datos, reportar y corregir la asignación de obra de Raúl vía el flujo normal de administración de usuarios (no vía SQL directo en producción sin autorización)
   - Si es (d): corregir el gate de rol en `auth.allow()`/`PERMISSIONS` para que `residente` tenga acceso de lectura a Estimaciones de sus obras asignadas

Allowed Actions:
- Modificar el endpoint de consulta de estimaciones si la causa es de filtro incorrecto
- Modificar `permisos_usuario` (vía script/endpoint administrativo, no SQL directo en Producción) si falta una fila de permiso
- Leer (no modificar sin confirmar) la asignación de obra de Raúl

Forbidden Actions:
- NO dar a `residente` acceso a estimaciones de obras que NO tiene asignadas — el fix es solo sobre "ver estimaciones de su(s) obra(s) asignada(s) sin importar el creador", no acceso global
- NO ejecutar UPDATE/INSERT directo en Producción sin autorización explícita de Paul
- NO modificar permisos de otros roles (cabo, compras, etc.) como efecto colateral

Stop Conditions:
Pausar y reportar si:
- Raúl no tiene, de hecho, asignación a la obra 749 (sería un problema de datos a resolver por Paul directamente, no un bug de código)
- El mismo problema de filtro por creador aparece en otros módulos además de Estimaciones (evaluar si es un patrón más amplio que vale la pena corregir de una vez)

Checkpoints:
✅ Fase 0 reportada con causa raíz exacta y evidencia (query real, fila de permisos, o confirmación de asignación de obra)
✅ Usuario de prueba con puesto=residente y misma asignación que Raúl puede ver estimaciones creadas por otro usuario en la misma obra, verificado con HTTP real
✅ Confirmado que un usuario sin asignación a esa obra sigue sin poder verlas (no se abrió acceso de más)
✅ Lista final de archivos modificados con resumen de cada cambio
```
