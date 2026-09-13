Objective:
En el modal "Por concepto" de Avance (con el breadcrumb ya funcionando desde PR #242/#246): corregir el espaciado apretado entre el bloque de breadcrumb+grupo y la tarjeta anterior, y agregar navegación rápida entre subtítulos/partidas — un selector para saltar directo a la sección que se busca, y la posibilidad de colapsar/expandir cada sección para ocultar las que no interesan en ese momento.

Starting State:
- Modal ya muestra, por cada concepto, un breadcrumb de ruta jerárquica (ej. "CONSTRUCCION DE REDES HID... › AP - RED DE DISTRIBUCION") seguido del `<h3>` de grupo (ej. "CALLE PRADERAS") cuando cambia de sección, luego las tarjetas de conceptos de esa sección.
- Problema reportado por Paul: el bloque de breadcrumb+grupo queda visualmente pegado a la última tarjeta de la sección anterior — falta separación clara.
- Con obras de varias secciones (a veces 10+ subtítulos), no hay forma de saltar directo a una sección ni de ocultar las que no interesan — hay que scrollear todo el modal.
- El modal permite editar un input "Ejecutado este periodo" por concepto — cualquier solución de colapsar secciones debe preservar lo ya escrito en esos inputs aunque la sección se oculte (ocultar visualmente, nunca desmontar el DOM de una sección con datos capturados sin guardar).

Target State:

1. FIX DE ESPACIADO:
   - Agregar separación vertical clara (margin/padding) entre el bloque breadcrumb+`<h3>` de grupo y la tarjeta de concepto anterior, consistente con el resto del espaciado del modal.

2. NAVEGACIÓN RÁPIDA ENTRE SECCIONES:
   - Agregar un selector (dropdown o barra de pills, según lo que se vea más limpio con `frontend-design` skill) en la parte superior del modal, listando cada subtítulo/grupo presente en esa obra/semana.
   - Al seleccionar uno, hacer scroll suave (`scrollIntoView`) directo al inicio de esa sección dentro del modal. Si la sección está colapsada (ver punto 3), expandirla automáticamente al saltar ahí.

3. SECCIONES COLAPSABLES:
   - Cada `<h3>` de grupo se vuelve clicable (con un ícono de chevron indicando expandido/colapsado) para mostrar/ocultar las tarjetas de conceptos de esa sección.
   - Colapsar es solo visual (`display:none` o similar) — nunca desmontar los inputs de "Ejecutado este periodo" ya escritos, para no perder captura sin guardar.
   - Estado expandido/colapsado por sección vive en memoria de la sesión del modal (no persiste al cerrar y reabrir, salvo que sea trivial agregarlo — no es requisito).
   - Default: todas las secciones expandidas al abrir el modal (comportamiento actual, sin sorpresas).

Allowed Actions:
- Modificar `public/app.js` (modal de Avance) y `public/styles.css`.
- Consultar `/mnt/skills/public/frontend-design/SKILL.md`.
- Bump `SW_VERSION`.

Forbidden Actions:
- NO desmontar del DOM ninguna tarjeta de concepto al colapsar su sección — solo ocultar visualmente, para no perder valores ya tecleados en "Ejecutado este periodo".
- NO tocar la lógica de cálculo de `ruta_jerarquica`, el guardado de avance, ni el breadcrumb ya corregido en PR #246.

Stop Conditions:
- Ninguna prevista — si aparece algún caso de obra con un volumen de secciones que haga la navegación rápida poco práctica (ej. 20+ subtítulos), reportarlo y proponer ajuste (buscador de texto en el selector en vez de lista larga).

Checkpoints:
✅ Verificado en navegador real (Playwright + WebKit): espaciado corregido, salto de sección funcionando, colapsar/expandir preservando texto ya escrito en "Ejecutado este periodo" (escribir un valor, colapsar la sección, expandirla de nuevo, confirmar que el valor sigue ahí).
✅ Probado con una obra de pocas secciones y una de muchas (6-7 niveles/varias secciones, ej. obra 57 o 13).
✅ Lista final de archivos modificados.

Estimado: esfuerzo Medio — Claude Code + Sonnet 5, ~2 horas.
