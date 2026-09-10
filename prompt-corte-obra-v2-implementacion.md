Objective:
Actualizar el módulo Corte de Obra (Finanzas): (1) el bloque Real muestra dos columnas separadas — Pagado (ya existente) y Avance Valorizado (nueva) — y (2) el bloque Presupuesto por categoría deja de depender de `matrices_precio_unitario` y usa `insumos.categoria` + `insumos.importe_presupuesto`, mostrando explícitamente el % que representa contra el Total oficial de la obra.

Starting State:
- Corte de Obra (PR #236, en main) hoy calcula Presupuesto por categoría vía `matrices_precio_unitario` — completo y reconciliado solo en la obra 30, "No disponible" en las otras 6 obras reales.
- Real hoy es solo "Pagado" (Nómina aprobada + Destajo ejecutado + OC pagadas por categoría de insumo).
- Diagnóstico confirmado (sin bug): `insumos.categoria` + `importe_presupuesto` tiene dato real en las 7 obras, pero subestima el Total oficial (`meta.total_sin_iva`) entre 11% y 64% según la obra — la hoja "Listado de insumos" del Excel no es exhaustiva frente a la hoja de conceptos. Esto es una limitación del archivo fuente, no del código, y no se corrige aquí.
- `concepto_insumos` (única tabla que vincularía un concepto con avance % a insumos con categoría) está vacía en 6 de 7 obras y no tiene columna `cantidad` — confirmado que NO sirve para desglosar Avance Valorizado por categoría.
- Avance Valorizado TOTAL (sin desglose) ya existe y se muestra hoy en Finanzas → "Esta obra" (ej. 84.2% / $293,713.07) — reutilizar esa misma lógica, no reimplementarla.
- Obras sin ningún insumo importado (Excel con formato no reconocido, ej. Obra749_oficinas) deben seguir mostrando "No disponible" en Presupuesto por categoría — comportamiento correcto ya confirmado.

Target State:

1. FASE 0 — Confirmar alcance de Avance Valorizado por categoría antes de tocar código:
   - Confirmar (ya asumido por el diagnóstico previo, pero verificar en código) que no existe ninguna vinculación poblada entre `conceptos` (que tienen % de avance) e `insumos`/categoría. Si se confirma: Avance Valorizado por categoría (Mano de Obra / Materiales / Equipo y Herramienta) es "No disponible" — solo el Total de esa columna es calculable, reutilizando la lógica ya existente de avance valorizado total.
   - Localizar dónde vive hoy el cálculo de avance valorizado total (qué archivo/función) para reutilizarlo, no duplicarlo.

2. BACKEND — `server/corteObra.js`:
   - Bloque Real: agregar "Avance Valorizado" junto a "Pagado". Por categoría: "No disponible" (según Fase 0). Total: reutilizar el cálculo existente de avance valorizado total de la obra (o suma ponderada si es "todas las obras").
   - Bloque Presupuesto: reemplazar `matrices_precio_unitario` por `SUM(insumos.importe_presupuesto) GROUP BY categoria` para esa obra. Cada categoría incluye `porcentaje_cobertura = importe_categoria / meta.total_sin_iva`. Si `Σ importe_presupuesto = 0` para la obra (sin insumos importados), esa obra muestra "No disponible" en las tres categorías, igual que hoy.
   - Total de Presupuesto: sigue siendo `meta.total_sin_iva` (fuente ya validada), nunca la suma de categorías — dejar explícito en el response que son fuentes distintas.
   - Quitar por completo la lógica de umbral "100% de conceptos con matriz completa" — ya no aplica.

3. FRONTEND — `public/app.js`:
   - Tabla: columnas Categoría | Presupuesto (+ "X% del total capturado" debajo del monto) | Real — Pagado | Real — Avance Valorizado | Variación $ (vs. Pagado) | Variación %.
   - Nota fija visible bajo la tabla: "Los montos de Presupuesto por categoría vienen del catálogo de insumos del Excel y pueden no sumar el Total oficial de la obra — no todos los conceptos se detallan a nivel insumo." (mismo estilo que la nota ya existente de "No disponible").
   - Fila Total: Presupuesto = `meta.total_sin_iva`; Real Pagado = suma ya existente; Real Avance Valorizado = cálculo total reutilizado de Fase 0.

4. EXPORT (`server/corteObraPdf.js` y Excel):
   - Reflejar las mismas columnas y la misma nota de advertencia sobre cobertura parcial.

Allowed Actions:
- Modificar `server/corteObra.js`, `server/corteObraPdf.js`, la ruta en `server/app.js`, y `public/app.js`.
- Leer (sin modificar) la función existente de avance valorizado total para reutilizarla o extraerla a un helper compartido.
- Bump `SW_VERSION`.

Forbidden Actions:
- NO modificar `server/parser.js`, `server/ingest.js` ni el importador de Matrices — el diagnóstico ya descartó bug ahí.
- NO reintroducir el umbral "100% de matrices completas" ni ninguna otra forma de presupuesto inventado — todo gap se muestra "No disponible" o con el % de cobertura explícito, nunca 0% ni relleno.
- NO duplicar la lógica de avance valorizado total en un cálculo nuevo — reutilizar la existente.

Stop Conditions:
- Si el cálculo de avance valorizado total no está aislado en una función reutilizable y extraerlo implica tocar más de 2 archivos fuera de los ya listados — pausar y proponer el refactor antes de continuar.
- Si alguna obra muestra `Σ insumos.importe_presupuesto` por categoría MAYOR al `meta.total_sin_iva` (dato inconsistente) — pausar y reportar, no ocultarlo.

Checkpoints:
✅ Fase 0: confirmación literal de que no hay vinculación concepto↔insumo poblada, y ubicación del cálculo de avance valorizado total a reutilizar.
✅ `/api/finanzas/corte-obra` verificado con output literal para: obra 30 (matrices ya no se usan, ahora insumos), obra 42 (insumos con dato real, % de cobertura visible), y una obra sin insumos importados (Presupuesto "No disponible").
✅ Vista verificada en navegador real (Playwright + WebKit): nota de advertencia visible, columnas Pagado/Avance Valorizado correctas.
✅ Export Excel y PDF con las mismas columnas y nota.
✅ vitest completo corrido en serie, confirmando cero regresiones nuevas (comparar contra las 2 fallas ya conocidas y documentadas como preexistentes).
✅ Lista final de archivos modificados con resumen de cada cambio.

Estimado: esfuerzo Medio — Claude Code + Sonnet 5, ~3-4 horas.
