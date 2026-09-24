Objective:
Diagnosticar por qué el mosaico "Generadores de Obra" no aparece en la pantalla de secciones "Obra" (junto a Programa/Avance/Destajo/Estimaciones) para el rol `residente`, a pesar de que sesiones anteriores confirmaron que `PERMISSIONS.residente.tabs` en `server/auth.js` ya incluye `generadoresObra`.

Starting State:
- Captura real: usuario residente, sección "Obra", solo ve 4 mosaicos (Programa, Avance, Destajo, Estimaciones) — sin Generadores de Obra.
- Confirmado en sesión anterior (caso Rodolfo): `PERMISSIONS.residente.tabs` sí incluye `generadoresObra`, y los endpoints ya usan `auth.allow('residente')` correctamente — ese caso se resolvió con asignación de obra (`usuario_proyectos`), no con cambio de código.
- Hipótesis: existe un array/lista separado en frontend (similar al patrón ya visto con `MAQUINARIA_TABS_*` / `ROLE_TABS`) que controla qué mosaicos se renderizan dentro de la pantalla de secciones "Obra" específicamente, y ese array nunca se actualizó para incluir Generadores de Obra — sería el mismo tipo de gap ya visto dos veces esta sesión (Bitácora para residente/cabo).

Diagnóstico a correr:
1. Ubicar la función que renderiza la pantalla de secciones "Obra" (la que pinta los mosaicos Programa/Avance/Destajo/Estimaciones) en `public/app.js`.
2. Buscar si esa función itera sobre un array hardcodeado de mosaicos (que no incluye Generadores de Obra) o si consulta dinámicamente `tabsParaUsuario()`/`PERMISSIONS.residente.tabs` — si es lo primero, ese es el gap.
3. Confirmar si Generadores de Obra se renderiza en OTRA parte de la navegación (otra sección, otro menú) para residente, o si simplemente no tiene ningún punto de entrada visual pese a que el backend lo permitiría.
4. Si existe el mismo patrón de array desincronizado, revisar también si otros roles (cabo, operador, etc.) tienen el mismo problema con este mosaico específico, para no tener que repetir este diagnóstico una tercera vez.

Forbidden Actions:
- NO modificar nada todavía — reportar la causa raíz exacta antes de tocar código.

Checkpoint:
✅ Causa raíz exacta: ¿array de mosaicos desincronizado (gap de código, como Bitácora), o algo distinto (ej. falta de asignación de obra, como el caso de Rodolfo)?
✅ Si es gap de código: confirmar qué otros roles comparten el mismo problema, para corregirlo de una vez.
✅ Propuesta de fix mínimo, sin implementar todavía.

Estimado: Claude Code + Sonnet 5, esfuerzo Bajo — 15 a 20 min (mismo patrón ya visto, diagnóstico debería ser rápido).
