Objective:
Rediseñar la vista "Corte de Obra" (Finanzas): fecha de corte con default a hoy (selector se mantiene), agregar columna "Por Pagar" junto a Presupuesto/Pagado/Avance Valorizado, permitir desglosar cada categoría para ver tanto el catálogo de insumos que la componen como los movimientos reales (Nómina/Destajo/OC pagadas) que explican el "Pagado", y mejorar visualmente la interfaz completa (libertad de diseño).

Starting State:
- Corte de Obra hoy (PR #237 en main) muestra, por categoría (Mano de Obra/Materiales/Equipo y Herramienta): Presupuesto (con % de cobertura, vía `insumos.importe_presupuesto`), Real — Pagado, Real — Avance Valorizado (solo Total, ver nota abajo), Variación $/%.
- Fecha de corte hoy es un selector manual sin default — Paul pide que por default sea la fecha de hoy, sin quitar la posibilidad de cambiarla.
- Existe una pestaña "Compromisos Abiertos" en el mismo selector de Finanzas — es la fuente más probable para calcular "Por Pagar" (compromisos vía OC confirmada/recibida menos lo ya pagado) sin duplicar lógica. Confirmar en Fase 0 antes de reimplementar el cálculo desde cero.
- Interfaz actual de Corte de Obra es una tabla plana simple, sin gráficas ni tarjetas — Paul la describe como "muy plana" y pide mejorarla visualmente, con libertad de diseño (revisar `/mnt/skills/public/frontend-design/SKILL.md` antes de tocar UI).
- Diseño de drill-down por categoría acordado con Paul: al desglosar una categoría se debe poder ver AMBOS — (a) el catálogo de insumos de esa categoría con su `importe_presupuesto`, y (b) los movimientos reales (renglones de Nómina aprobada, Destajo ejecutado, pagos de OC) que suman el "Pagado" de esa categoría.

Target State:

1. FASE 0 — Confirmar fuentes reutilizables antes de construir:
   - Localizar la lógica de "Compromisos Abiertos" (qué endpoint/función la calcula) y confirmar si es reutilizable, por categoría de insumo, para la nueva columna "Por Pagar" (OC confirmada/recibida, no pagada aún).
   - Confirmar que el desglose de "Pagado" por categoría ya identifica, a nivel de movimiento individual, qué renglones de Nómina/Destajo/OC componen cada suma (no solo el total) — si el cálculo actual solo trae agregados, identificar qué query adicional se necesita para listar los movimientos individuales.

2. BACKEND — extender `/api/finanzas/corte-obra`:
   - Agregar "Por Pagar" por categoría (reutilizando o adaptando la lógica de Compromisos Abiertos localizada en Fase 0).
   - Nuevo sub-endpoint o parámetro de detalle: `GET /api/finanzas/corte-obra/detalle-categoria?proyecto_id=&categoria=&fecha_corte=` que devuelva:
     - Insumos de esa categoría con `importe_presupuesto` (catálogo).
     - Movimientos reales que componen el "Pagado" de esa categoría hasta la fecha de corte (renglones de Nómina aprobada / Destajo ejecutado / pagos de OC, cada uno con fecha, concepto/insumo, monto).
   - Default de `fecha_corte` = hoy si no se especifica.

3. FRONTEND — rediseño visual (libertad de diseño, usar `frontend-design` skill):
   - Selector de fecha con valor inicial = hoy.
   - Tarjetas o bloques por categoría (Mano de Obra / Materiales / Equipo y Herramienta) mostrando Presupuesto, Pagado, Por Pagar, Avance Valorizado y Variación de forma más visual que la tabla plana actual (considerar barras de progreso, colores por variación, iconografía) — total consistente y accesible.
   - Cada tarjeta/bloque de categoría es expandible ("Ver desglose" o similar): al abrir, muestra dos secciones — Catálogo de insumos de esa categoría (con importe presupuestado) y Movimientos reales que componen el Pagado (tabla simple: fecha, origen [Nómina/Destajo/OC], concepto, monto).
   - Mantener la nota de advertencia existente sobre cobertura parcial del Presupuesto por categoría.
   - Mantener export a Excel/PDF, agregando la nueva columna "Por Pagar" y, si es razonable, una hoja adicional por categoría con el detalle.

Allowed Actions:
- Modificar `server/corteObra.js`, `server/corteObraPdf.js`, ruta en `server/app.js`, `public/app.js`.
- Leer (sin modificar) la lógica de Compromisos Abiertos para reutilizarla.
- Consultar `/mnt/skills/public/frontend-design/SKILL.md` antes de tocar UI.
- Bump `SW_VERSION`.

Forbidden Actions:
- NO duplicar el cálculo de Compromisos Abiertos si es reutilizable — extraerlo a función compartida si hace falta, como ya se hizo con Avance Valorizado en la v2.
- NO perder ninguna de las notas/advertencias ya existentes (cobertura parcial de Presupuesto, "No disponible" cuando aplica).
- NO cambiar el significado de "Pagado" ni "Avance Valorizado" ya establecidos — el drill-down solo expone el detalle detrás de esos totales, no los recalcula distinto.

Stop Conditions:
- Si la lógica de Compromisos Abiertos no está desglosada por categoría de insumo y adaptarla requiere un cambio mayor (más de 2 archivos fuera de los ya listados) — pausar y reportar antes de decidir si vale la pena o si "Por Pagar" se calcula de otra forma más simple.
- Si el volumen de movimientos individuales por categoría es muy alto (cientos de renglones) para alguna obra — pausar y proponer paginación antes de construir la tabla de detalle.

Checkpoints:
✅ Fase 0: confirmación de si Compromisos Abiertos es reutilizable para "Por Pagar", con evidencia de código.
✅ Endpoint de detalle verificado con output literal: obra 30, categoría Mano de Obra — insumos del catálogo + movimientos reales listados correctamente.
✅ Fecha de corte con default hoy, confirmado en navegador real.
✅ Vista rediseñada verificada en Playwright + WebKit — tarjetas, expansión de detalle, ambos escenarios de scope.
✅ Export Excel/PDF actualizado y verificado.
✅ vitest completo en serie, sin regresiones nuevas.
✅ Lista final de archivos modificados.

Estimado: esfuerzo Alto — Claude Code + Sonnet 5, ~5-7 horas (backend de detalle + Compromisos Abiertos reutilizado + rediseño visual completo).
