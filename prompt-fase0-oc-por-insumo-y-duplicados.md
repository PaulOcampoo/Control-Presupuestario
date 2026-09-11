Objective:
Fase 0 (diagnóstico + diseño, sin implementar): investigar 2 problemas relacionados en el flujo de Requisición → Orden de Compra: (1) una requisición que ya generó una OC, incluso ya pagada/recibida, permite volver a generar otra OC duplicada — debe bloquearse; (2) hoy una requisición con varios insumos genera UNA sola OC para todos juntos, pero el negocio necesita poder generar una OC POR INSUMO (cada insumo puede ser de un proveedor distinto), manteniendo el control de que cada insumo de la requisición no se vuelva a ordenar dos veces.

Starting State:
- Confirmado por Paul: flujo actual es Requisición (con N insumos seleccionados) → botón "Generar OC" → 1 sola OC con todos los insumos.
- Bug confirmado por Paul: se puede volver a generar otra OC de la misma requisición aunque la primera OC ya esté pagada/recibida — no hay bloqueo real.
- Necesidad de negocio: distintos insumos de una misma requisición suelen ser de proveedores distintos — necesitan poder generar una OC independiente por insumo (o por subconjunto de insumos), no forzosamente una sola para toda la requisición.
- Cualquier diseño debe seguir la regla dura del proyecto: nunca perder trazabilidad, ningún dato financiero se borra físicamente.

Target State (solo diagnóstico y diseño, no implementación):
1. MAPEAR EL FLUJO ACTUAL:
   - Localizar el código real de "Generar OC" desde Requisición (frontend y backend) — confirmar cómo se relacionan hoy `requisiciones`, `ordenes_compra`, y sus insumos/renglones (¿hay tabla puente? ¿la OC referencia la requisición completa o insumo por insumo ya desde antes?).
   - Confirmar si existe algún campo de estado en la requisición que debería usarse para bloquear generación duplicada (ej. `estado = 'oc_generada'`) y por qué no se está validando, si existe.
   - Confirmar si ya existe alguna noción de "insumo ya ordenado" a nivel de renglón de requisición, o si el estado vive solo a nivel de la requisición completa.

2. DISEÑO DEL BLOQUEO DE DUPLICADOS:
   - Proponer dónde y cómo bloquear: ¿a nivel de insumo/renglón de requisición (permite generar OC de los insumos restantes, bloquea solo los ya ordenados), o a nivel de requisición completa (todo o nada)? — esto debe decidirse en conjunto con el diseño del punto 3, ya que están relacionados.
   - Confirmar el mensaje de error/feedback que debe ver el usuario si intenta generar una OC de un insumo ya ordenado.

3. DISEÑO DE "OC POR INSUMO":
   - Proponer cómo cambia el flujo de "Generar OC": selección de insumos específicos dentro de la requisición (checkboxes o similar) antes de generar, en vez de generar automáticamente para todos.
   - Confirmar impacto en la UI de Requisiciones/Órdenes de Compra existente — cuántas pantallas/componentes hay que tocar.
   - Confirmar impacto en reportes/vistas que hoy asumen 1 OC = 1 requisición completa (ej. algún resumen que cuenta OCs por requisición, si existe).
   - Proponer el control de "insumo ya ordenado": marcar a nivel de renglón de requisición qué insumos ya tienen una OC generada, para que no se puedan volver a seleccionar en una futura generación de OC de la misma requisición.

4. IMPACTO EN DATOS EXISTENTES:
   - Confirmar si hay requisiciones/OCs ya reales en Preview o Producción con el patrón de duplicado descrito por Paul — si existen, cuantificar el problema (cuántas OCs duplicadas reales existen hoy) sin corregir nada todavía.

Allowed Actions:
- Leer código relevante (`public/app.js`, `server/app.js` — flujo de Requisiciones y Órdenes de Compra).
- SELECTs de solo lectura contra Preview para confirmar si ya existen casos reales de OC duplicada.
- Producir documento de propuesta — NO implementar código todavía.

Forbidden Actions:
- NO implementar ningún cambio todavía.
- NO tocar Producción.
- NO corregir ninguna OC duplicada real que se encuentre — solo reportar su existencia.

Stop Conditions:
- Si el diseño actual de la relación requisición↔OC hace que "OC por insumo" requiera un cambio de esquema mayor (ej. la tabla actual no tiene forma de referenciar insumos individuales de una requisición) — reportarlo explícitamente como hallazgo, no minimizar la complejidad real solo para dar un estimado optimista.

Checkpoints:
✅ Flujo actual mapeado con evidencia de código (relación requisición↔OC↔insumos).
✅ Causa confirmada de por qué no hay bloqueo de duplicados hoy.
✅ Diseño propuesto para bloqueo de duplicados (a nivel insumo o requisición completa, con justificación).
✅ Diseño propuesto para "OC por insumo", incluyendo impacto en UI y reportes existentes.
✅ Conteo real de OCs duplicadas ya existentes en Preview (si las hay), sin corregir.
✅ Estimado de esfuerzo para Fase 1 — separado en 2 partes si el bloqueo de duplicados es independiente/más simple que el rediseño de "OC por insumo".

Estimado: ~35-45 min con Claude Code (Sonnet 5, esfuerzo Medio) — flujo central del sistema, amerita mapeo cuidadoso.
