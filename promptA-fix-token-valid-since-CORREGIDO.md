# Prompt A (corregido) — Sesiones viejas no reflejan cambio de puesto/activo

**Estimado:** Claude Code + Sonnet 5, esfuerzo Bajo-Medio (~1h)

```
Objective:
Corregir que cambiar el `puesto` o `activo` de un usuario en PUT /api/usuarios/:id no invalide su sesión JWT vieja, causando que usuarios con rol actualizado (ej. ascendidos a admin) sigan operando bajo permisos de su rol anterior hasta que cambien su contraseña.

Starting State:
- Causa raíz confirmada en Fase 0 (no es bug de permisos, el bypass de admin/desarrollador en `tienePermiso()` (server/auth.js:733) funciona correctamente):
  - `server/auth.js` línea 922: `req.user = decoded` — el puesto de cada request sale del JWT, nunca se re-consulta fresco de la DB.
  - `token_valid_since` es lo único que invalida sesiones viejas, y `PUT /api/usuarios/:id` (línea ~1000) solo lo actualiza cuando cambia la contraseña — nunca cuando cambia `puesto` o `activo`.
  - Caso real confirmado: Rodolfo (`usuarios.puesto = 'admin'` en DB) recibía 403 en Maquinaria/Consumibles porque su sesión de navegador seguía cargando un JWT emitido bajo su rol anterior.
- Este bug afecta potencialmente a cualquier usuario al que se le cambie `puesto` o se le desactive (`activo = false`) sin que también cambie su contraseña — no es exclusivo de Maquinaria.

Target State:

1. FIX EN `PUT /api/usuarios/:id`:
   - Cuando la actualización incluye cambio de `puesto` y/o `activo` (comparar valor nuevo vs valor actual antes de escribir), bumpear `token_valid_since` igual que ya se hace para cambio de contraseña
   - Si la actualización no cambia `puesto` ni `activo` ni contraseña, no tocar `token_valid_since` (evitar invalidaciones innecesarias)

2. REMEDIO INMEDIATO PARA RODOLFO:
   - No requiere cambio de código — indicarle que cierre sesión y vuelva a iniciar sesión para obtener un JWT fresco con su rol actual

Allowed Actions:
- Modificar `server/auth.js` / el handler de `PUT /api/usuarios/:id` para agregar la condición de bump de `token_valid_since` en cambio de puesto/activo
- Leer (no modificar) `tienePermiso()` y el flujo de emisión de JWT como referencia — ya funcionan correctamente, no se tocan

Forbidden Actions:
- NO modificar `tienePermiso()` ni el bypass de admin/desarrollador — ya funciona correctamente, confirmado en Fase 0
- NO agregar re-consulta de rol fresco desde DB en cada request como alternativa — cambia el modelo de auth del sistema completo, fuera de alcance de este fix puntual
- NO forzar cierre de sesión de otros usuarios activos como efecto colateral del fix (el fix solo debe afectar ediciones futuras de puesto/activo, no sesiones ya abiertas de otros usuarios sin cambios pendientes)

Stop Conditions:
Pausar y reportar si:
- El endpoint `PUT /api/usuarios/:id` maneja `puesto` y `activo` en llamadas separadas en vez de un solo payload (afectaría cómo se detecta "cambió vs no cambió")
- Se identifican otros endpoints que también modifiquen `puesto` o `activo` fuera de este endpoint (ej. algún endpoint de alta rápida de usuario) que también necesiten el mismo bump

Checkpoints:
✅ Verificado con output HTTP/terminal: cambiar el `puesto` de un usuario de prueba bumpea `token_valid_since`, y su sesión vieja deja de ser válida (recibe 401 y debe re-loguearse)
✅ Verificado que una edición de usuario que NO cambia puesto/activo/password no bumpea `token_valid_since` innecesariamente
✅ Confirmado que Rodolfo, tras re-loguearse, ya no recibe 403 en Maquinaria/Consumibles
✅ Lista final de archivos modificados con resumen de cada cambio
```
