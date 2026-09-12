Objective:
Mejorar la legibilidad visual del breadcrumb de ruta jerárquica en el modal "Por concepto" de Avance (agregado en PR #242) — hoy el texto es demasiado pequeño y las flechas "›" casi no se distinguen. Debe verse como un breadcrumb tipo explorador de archivos (Windows Explorer / navegador de carpetas).

Starting State:
- Breadcrumb ya funcional (backfill de producción confirmado, PR #242 en main): muestra la ruta completa antes del encabezado grande de grupo, ej. "CONSTRUCCION DE REDES HIDROSANITARIAS DE ETAPA 1 FRACCIONAMIENTO RESIDENCIAL PUNTA CUERNA › AP - RED DE DISTRIBUCION".
- Implementado en `public/app.js`, dentro del modal de Avance, como texto plano de tamaño pequeño (confirmar clase/estilo actual antes de tocar).
- Referencia visual de Paul: estilo tipo Windows Explorer — segmentos claramente separados, flechas ">" visibles, texto de tamaño legible.

Target State:
- Localizar el breadcrumb en `public/app.js` (modal "Por concepto" de Avance) y su estilo asociado (`public/styles.css` o inline).
- Aumentar tamaño de fuente a un nivel cómodo de lectura (consistente con el resto de metadatos del modal, no tan grande como el encabezado de grupo).
- Separadores ">" con más contraste/tamaño que el texto de los segmentos, o un ícono de chevron si es más limpio visualmente (revisar `/mnt/skills/public/frontend-design/SKILL.md` antes de decidir el tratamiento exacto).
- Si la ruta es muy larga (obras de 6-7 niveles), considerar truncar segmentos intermedios largos con "..." (tooltip con el texto completo al hover) en vez de romper el layout — confirmar con Paul si esto aplica o si prefiere que se recorra en varias líneas.
- Mantener el mismo comportamiento: no aparece si `ruta_jerarquica` tiene un solo elemento.

Allowed Actions:
- Modificar `public/app.js` y `public/styles.css`.
- Consultar `/mnt/skills/public/frontend-design/SKILL.md`.
- Bump `SW_VERSION`.

Forbidden Actions:
- NO tocar la lógica de cálculo de `ruta_jerarquica` ni el backfill — esto es puramente visual.
- NO cambiar el encabezado grande de grupo (`<h3>`) que ya funciona bien.

Checkpoints:
✅ Verificado en navegador real (Playwright + WebKit) con una obra de ruta corta (2-3 niveles) y una de ruta larga (6-7 niveles, ej. obra 57/13).
✅ Screenshot antes/después para confirmar la mejora de legibilidad.
✅ Lista final de archivos modificados.

Estimado: esfuerzo Bajo — Claude Code + Sonnet 5, ~30-45 min.
