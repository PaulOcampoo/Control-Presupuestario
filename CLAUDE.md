# CLAUDE.md — Notas para el asistente de IA

## Regla: SW_VERSION se bumpea en todo commit con cambios de código

En **todo** commit que incluya cambios de código (frontend o backend, sin excepciones),
incrementar `SW_VERSION` en `public/sw.js` (`ctrl-ppto-vN` → `ctrl-ppto-v(N+1)`).

Se evaluó la propuesta de omitir el bump en commits backend-only y fue **rechazada**.
La regla no tiene excepciones.
