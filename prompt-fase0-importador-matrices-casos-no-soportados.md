Objective:
Fase 0 (diagnóstico + diseño, sin implementar): el generador de matrices (alta de obra nueva desde Excel) hoy aborta la creación completa de la obra cuando encuentra 2 patrones que no sabe resolver: (1) un código de concepto repetido en más de un capítulo de la obra (ej. `AJAL.TRA.LIN` en 2 secciones distintas, mismo nombre), y (2) una cuadrilla pre-agregada en una sola fila sin desglose por oficio (ej. código `1A5P`). Esto ya estaba documentado como limitación conocida (Notion, "fuera de alcance de PR #184") pero ahora bloquea activamente la carga de presupuestos reales de Rodolfo. Diseñar cómo soportar ambos casos (o degradar con gracia — crear la obra igual, marcando esos conceptos específicos para resolución manual, en vez de abortar todo) sin comprometer la garantía actual de "nunca dejar una obra huérfana a medias".

Starting State:
- Comportamiento actual confirmado en código (`server/matricesImport.js:141-142`, `server/app.js:6022-6031`): cuando el generador encuentra estos patrones, lanza error explícito y hace ROLLBACK de la transacción completa (proyecto + conceptos + insumos + destajo) — diseño deliberado documentado, motivado por el caso real `EST_Kaila_Red_Hidraulica_06082026.xlsx`.
- 2 casos reales nuevos que disparan esto: `Ppto_732_VInte_Infra_RD_E1_03092026.xlsx` (código `AJAL.TRA.LIN` duplicado en 2 capítulos) y otro Excel de "684 BARRANCAS" / "CALLI_DEZ" (código `1A5P`, cuadrilla pre-agregada sin desglose de oficios).
- Petición de Paul: "habíamos dicho que permitiera todos los formatos de excel... con tal de que se puedan subir sin ningún problema" — el objetivo de negocio es máxima tolerancia de formato, no rechazo.
- Restricción dura que NO debe romperse: nunca dejar una obra a medias/huérfana si algo falla a mitad de la importación.

Target State (solo diseño, no implementación):
1. CASO 1 — CÓDIGO DUPLICADO EN 2+ CAPÍTULOS:
   - Este es el MISMO patrón ya resuelto para actualización de presupuesto existente (PR #207, sesión anterior — sufijo único por capítulo/sección cuando el conteo es simétrico). Confirmar si esa misma lógica (o una versión adaptada) puede aplicarse aquí, en el momento de ALTA inicial, en vez de abortar.
   - Proponer: en vez de fallar, generar automáticamente un código único por capítulo (ej. sufijo `-C1`, `-C2` basado en el capítulo/sección de cada aparición) y crear la matriz para cada uno correctamente, en vez de omitir el bloque.

2. CASO 2 — CUADRILLA PRE-AGREGADA SIN DESGLOSE:
   - Confirmar exactamente qué información falta para desglosar por oficio (¿el costo total de la cuadrilla está pero no el desglose interno? ¿Hay algún dato en el Excel que permita inferir una distribución razonable, o es información que genuinamente no está en el archivo?).
   - Si NO se puede inferir con seguridad: proponer degradar con gracia en vez de abortar — crear el concepto/matriz con el costo total de la cuadrilla como un solo renglón "mano de obra sin desglosar", marcado visualmente para que alguien lo complete después manualmente, en vez de omitir la obra completa.

3. GARANTÍA DE INTEGRIDAD:
   - Confirmar cómo se preserva "nunca huérfano a medias" bajo el nuevo diseño — probablemente: la transacción sigue siendo atómica (todo o nada a nivel de la obra completa), pero ahora "todo" incluye los casos antes no soportados en vez de fallar por ellos. Explicar esto con precisión, no asumir que es trivial.

4. IMPACTO EN OTROS PATRONES:
   - Confirmar si existen otros patrones no soportados además de estos 2 (buscar en el código otros puntos donde el importador aborta con error explícito) — inventariarlos aunque no se diseñe la solución para todos en este prompt, para tener el panorama completo.

Allowed Actions:
- Leer código relevante (`server/matricesImport.js`, `server/app.js`).
- Analizar los 2 Excel reales adjuntos (`Ppto_732_VInte_Infra_RD_E1_03092026.xlsx` y el de 684 Barrancas/CALLI_DEZ si Paul lo adjunta) para confirmar los patrones exactos.
- Producir documento de propuesta — NO implementar código todavía.

Forbidden Actions:
- NO implementar ningún cambio todavía.
- NO tocar Producción.
- NO comprometer la garantía de integridad transaccional sin proponerlo explícitamente y justificarlo.

Stop Conditions:
- Si alguno de los 2 casos no tiene una solución segura sin arriesgar datos incorrectos silenciosos (ej. inferir una distribución de cuadrilla que podría estar mal y nadie lo note) — reportarlo como tal, proponer que ese caso específico siga requiriendo intervención manual, en vez de forzar una automatización insegura.

Checkpoints:
✅ Diseño para Caso 1 (código duplicado por capítulo), reusando el patrón ya validado de PR #207 si aplica.
✅ Diseño para Caso 2 (cuadrilla pre-agregada), con opción de degradar con gracia si no se puede inferir con seguridad.
✅ Confirmación de cómo se preserva la garantía de integridad transaccional.
✅ Inventario de otros patrones no soportados, si existen.
✅ Estimado de esfuerzo para Fase 1 (puede ser 2 partes independientes, un caso más simple que el otro).

Estimado: ~35-45 min con Claude Code (Sonnet 5, esfuerzo Medio).
