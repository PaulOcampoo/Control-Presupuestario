Objective:
Corregir Nómina: cuando varios trabajadores están vinculados al mismo destajista, el importe total del destajo se está asignando completo a CADA trabajador (bug de duplicación/triplicación, ver captura: 3 trabajadores con $10,850.42 cada uno en vez de repartir ese total entre los 3). Nuevo comportamiento esperado: cada trabajador vinculado recibe un mínimo fijo de $500, y el remanente (total_destajo − (mínimo × número de trabajadores vinculados)) se asigna completo al destajista principal.

Starting State:
- Módulo Nómina: `destajo_items.precio_destajo` es el monto total del destajo de un concepto/destajista.
- Actualmente, al vincular N trabajadores a un destajista, cada uno de los N recibe el `precio_destajo` completo en su columna "Monto destajo" (columna G en la captura), en vez de una fracción — esto multiplica el gasto reportado por N.
- "Destajista principal" ya es un concepto existente en el sistema (resolución de `destajista_id` por name-matching dentro de la obra).

Target State:
- Identificar en el código de Nómina dónde se calcula/muestra "Monto destajo" por trabajador (probablemente en el render de la tabla de nómina o en el endpoint que arma el reporte semanal).
- Nueva lógica de distribución:
  - Si un destajista tiene trabajadores vinculados (ayudantes/cuadrilla) además de él mismo: cada trabajador vinculado (no el destajista principal) recibe `min(500, total_destajo)` — nunca más de lo que hay disponible.
  - El destajista principal recibe: `total_destajo - (500 × número_de_trabajadores_vinculados)`.
  - Si el remanente calculado para el destajista principal fuera negativo (demasiados trabajadores vinculados para el monto total), NO permitir un valor negativo — definir cómo manejar este caso como parte del diagnóstico (probablemente: cap proporcional en vez de $500 fijo, o alerta visual). Reportar este edge case en el checkpoint antes de decidir la solución final.
  - Si el destajista NO tiene trabajadores vinculados, comportamiento actual sin cambios (recibe el 100%).
- El total sumado de "Monto destajo" en la tabla debe seguir cuadrando exactamente con `precio_destajo` original (ni más ni menos) — este es el criterio de aceptación principal.

Allowed Actions:
- Modificar la lógica de cálculo/render de "Monto destajo" en Nómina (backend y/o frontend, según dónde viva hoy).
- Agregar tests que cubran: 1 destajista sin vinculados, destajista con 2 vinculados, destajista con vinculados suficientes para generar remanente negativo (edge case).

Forbidden Actions:
- No modificar `destajo_items.precio_destajo` almacenado (sigue siendo el total real del destajo) — el cambio es solo en cómo se distribuye/presenta por trabajador.
- No tocar el flujo de Nómina para trabajadores con `tipo_pago = jornal` (columna B en la captura) — el bug es específico de `tipo_pago = destajo`.
- No hacer merge sin autorización explícita.

Stop Conditions:
- Si el cálculo actual de "Monto destajo" por trabajador vive en un lugar distinto al esperado (ej. se calcula en el export a Excel y no en la vista), pausar y confirmar alcance antes de tocar código.
- Si aparece el caso de remanente negativo para el destajista principal con datos reales, pausar y presentar opciones antes de implementar una solución arbitraria.

Checkpoints:
✅ Diagnóstico: ubicación exacta del código que hoy asigna el total completo a cada trabajador vinculado (archivo + función).
✅ Test con destajista + 2 trabajadores vinculados: output literal mostrando $500 c/u a los vinculados y el remanente correcto al principal, sumando exactamente el `precio_destajo` original.
✅ Test del edge case de remanente negativo, con la solución elegida documentada.
✅ Verificación visual tuya en dispositivo real antes de cerrar.

Estimado de ejecución (Claude Code + Sonnet 5, esfuerzo Medio): 1.5–2.5 horas.
