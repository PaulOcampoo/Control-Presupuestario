# Prompt — Mejorar ventana de captura de Avance físico por concepto

**Estimado:** Claude Code + Sonnet 5, esfuerzo Medio (~2h, incluye Fase 0 ligera)

```
Objective:
Mejorar la usabilidad del modal "Avance físico por concepto — Semana N": agrandar la ventana, y agregar buscador + filtro de conceptos para que capturar avance en catálogos con muchos conceptos (ver referencia: 67 y 28 conceptos en obras reales) no sea tedioso.

Starting State:
- Modal actual lista todos los conceptos del catálogo de la semana en bloques verticales (título/descripción larga, código, presupuesto total y precio unitario, campo "Acumulado previo" de solo lectura, campo "Ejecutado este periodo" editable, y "acum: X de Y (Z%)").
- El modal parece tener ancho limitado respecto al contenido (descripciones largas ocupan varias líneas) y no tiene forma de buscar o filtrar conceptos — el usuario debe hacer scroll manual por todos.
- Existe cross-referencia con captura "Por concepto" de la misma semana (mencionada en el modal) — confirmar en Fase 0 cómo interactúan ambos flujos para no romperlo.
- Sistema es PWA mobile-first: hover gateado por `@media (hover: hover) and (pointer: fine)`, `prefers-reduced-motion` respetado, tokens de easing compartidos (`--ease-out`, `--ease-in-out`) — cualquier cambio visual debe respetar estos patrones existentes.

Target State:

1. FASE 0 — DIAGNÓSTICO LIGERO (antes de codear):
   - Localizar el componente/función exacta que renderiza este modal en `public/app.js`
   - Confirmar cómo se relaciona con la captura "Por concepto" de la misma semana (mencionada en el propio modal) para no duplicar ni romper ese flujo
   - Confirmar si el modal ya tiene manejo responsive distinto para mobile vs desktop

2. TAMAÑO DEL MODAL:
   - Aumentar el ancho/alto máximo del modal en desktop (ej. de un ancho fijo pequeño a algo cercano a 90% del viewport, con tope razonable en pantallas muy grandes)
   - En mobile, mantener el comportamiento full-screen o el patrón responsive ya existente en el sistema — no forzar un modal "grande" que no quepa en pantallas pequeñas
   - Mejorar jerarquía visual de cada bloque de concepto (más espaciado, descripción truncable con "ver más" si es muy larga, en vez de ocupar 4+ líneas siempre)

3. BUSCADOR:
   - Campo de búsqueda fijo en la parte superior del modal (sticky, visible siempre aunque se haga scroll)
   - Filtra en tiempo real por texto en descripción o código del concepto (case-insensitive, idealmente insensible a acentos)
   - Sin resultados: mensaje claro ("No se encontraron conceptos que coincidan")

4. FILTRO:
   - Filtro rápido por grupo/categoría del catálogo (agua potable, sanitario, pluvial, descargas, etc. — usar el campo `grupo` existente)
   - Filtro rápido adicional recomendado: toggle "Solo pendientes por capturar" (conceptos donde "Ejecutado este periodo" sigue vacío) — ayuda a enfocar la captura en lo que falta
   - Buscador y filtros combinables (aplican juntos, no exclusivos entre sí)

Allowed Actions:
- Modificar el componente del modal en `public/app.js` y su CSS asociado
- Agregar estado local de búsqueda/filtro (no requiere persistir en backend — es solo estado de UI de la sesión de captura)

Forbidden Actions:
- NO modificar la lógica de guardado de avance (`Guardar`, `Limpiar semana`) ni los cálculos de acumulado/porcentaje
- NO romper la cross-referencia con captura "Por concepto" de la misma semana
- NO introducir animaciones o transiciones que ignoren `prefers-reduced-motion` o los tokens de easing ya establecidos

Stop Conditions:
Pausar y reportar si:
- El modal comparte código/estado con otras vistas de captura (Destajo, Nómina) de forma que el cambio de tamaño/búsqueda las afectaría también sin querer
- La agrupación por `grupo` no está disponible de forma consistente en los datos de todos los proyectos reales

Checkpoints:
✅ Modal visiblemente más grande en desktop, sin romper el layout en mobile (probado en ambos)
✅ Buscador filtra correctamente por texto de descripción y de código, verificado con al menos 3 búsquedas de prueba
✅ Filtro por grupo y por "pendientes" funcionan y son combinables
✅ Guardado de avance sigue funcionando sin regresión después del cambio
✅ Lista final de archivos modificados con resumen de cada cambio
```
