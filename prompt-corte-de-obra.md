Objective:
Implementar módulo "Corte de Obra" dentro de Finanzas: reporte comparativo Presupuesto vs Real desglosado en Mano de Obra / Materiales / Equipo y Herramienta, con fecha de corte manual, selector de obra específica o todas las obras del usuario, visualizable en pantalla y exportable a Excel y PDF.

Starting State:
- Finanzas ya compara Erogado Real vs presupuestado a nivel total, incluye línea de Destajo (`cantidad_ejecutada × precio_destajo`).
- `insumos.categoria` YA EXISTE y está poblada al 100% (552/552 filas) con exactamente los tres valores necesarios: `MATERIALES` (435), `MANO DE OBRA` (82), `EQUIPO Y HERRAMIENTA` (35). No crear columna nueva — usar esta directamente.
- `conceptos` (presupuesto) no tiene desglose nativo por mano de obra/materiales/equipo. `matrices_precio_unitario` tiene bug de FK conocido (referencia a `usuarios` antes de que se cree en `initSchema()`).
- Diagnóstico confirmado sobre las 7 obras reales (ids 13, 24, 30, 32, 36, 41, 42 — el resto son proyectos QA): solo la obra 30 ("RED HIDRAULICA") tiene matrices pobladas (2 matrices, renglones en las 3 categorías). Las 6 restantes tienen 0 matrices/renglones. El presupuesto desglosado por categoría, por lo tanto, mostrará "No disponible" en 6 de 7 obras hasta que se pueblen sus matrices — decisión aceptada, el lado Real aplica a las 7.
- Mano de Obra real ya se calcula en Finanzas vía Nómina (jornal aprobado) + Destajo ejecutado.
- Requisiciones → Órdenes de Compra → pagos ya están ligados a insumos.
- Regla existente: gaps de composición de presupuesto se muestran como "No disponible", nunca 0% ni inventados.

Target State:

1. BACKEND — endpoint de corte:
   - Nuevo `GET /api/finanzas/corte-obra?proyecto_id=&fecha_corte=`. `proyecto_id` opcional (ausente = todas las obras asignadas al usuario). `fecha_corte` obligatoria (YYYY-MM-DD).
   - Real, con datos hasta `fecha_corte`:
     - Mano de Obra = Nómina aprobada + Destajo ejecutado + pagos de OC cuyos insumos tienen `categoria='MANO DE OBRA'`.
     - Materiales = pagos de OC cuyos insumos tienen `categoria='MATERIALES'`.
     - Equipo y Herramienta = pagos de OC cuyos insumos tienen `categoria='EQUIPO Y HERRAMIENTA'`.
   - Presupuesto: mismo desglose leyendo `matrices_precio_unitario` y sus renglones por `categoria`, únicamente si el proyecto tiene matrices pobladas; si no, devolver `"No disponible"` en ese renglón — nunca 0 ni estimado (hoy aplica a 6 de las 7 obras reales, solo la 30 tiene dato).
   - Respeta scoping de acceso a proyectos (403 si `proyecto_id` no asignado al usuario).
   - Consistencia de IVA: dividir entre 1.16 solo para la comparación, exponiendo cifras ajustadas y crudas por separado.

2. FRONTEND — vista Corte de Obra (dentro de Finanzas):
   - Selector de obra (dropdown de obras asignadas) o "Todas las obras".
   - Selector de fecha de corte manual (sin forzar default a hoy).
   - Tabla: filas Mano de Obra / Materiales / Equipo y Herramienta / Total; columnas Presupuesto, Real, Variación ($ y %).
   - Modo "Todas las obras": vista agregada + desglose por obra debajo.
   - "No disponible" se muestra explícito cuando falta dato de presupuesto.

3. EXPORT — Excel y PDF:
   - Botón "Exportar" (Excel .xlsx y PDF), mismo desglose que pantalla, incluye obra(s), fecha de corte y fecha de generación.
   - Reutilizar patrón de `server/exportHelper.js` y el rate limiting ya existente en endpoints de exportación.

Allowed Actions:
- Crear módulo backend nuevo (ej. `server/corteObra.js`) y registrar ruta en `server/app.js`.
- Leer `insumos.categoria` y `matrices_precio_unitario` (solo lectura, sin migraciones de schema).
- Modificar `public/app.js` y `public/index.html` para la nueva vista dentro de Finanzas.
- Extender `server/exportHelper.js` para los nuevos formatos de export.
- Bump `SW_VERSION`.

Forbidden Actions:
- NO crear columna `tipo` en `insumos` ni ninguna migración de schema — `categoria` ya cubre la necesidad.
- NO modificar cálculos ya existentes de Nómina, Destajo o el total actual de Finanzas — solo agregar.
- NO inventar ni estimar presupuesto desglosado cuando `matrices_precio_unitario` no esté poblada para un proyecto — usar "No disponible".
- NO ejecutar SQL en producción bajo ningún escenario de este prompt (no aplica, no hay cambios de schema).

Stop Conditions:
- Si al implementar aparecen valores de `categoria` distintos a los tres documentados (`MATERIALES`, `MANO DE OBRA`, `EQUIPO Y HERRAMIENTA`) — pausar y confirmar mapeo.
- Si se requieren más de 4 archivos backend afectados, o el nuevo export rompe compatibilidad con exports Excel actuales — pausar.

Checkpoints:
✅ `/api/finanzas/corte-obra` verificado con output literal para: obra 30 (con presupuesto disponible), al menos una obra sin matrices (presupuesto "No disponible"), y "todas las obras".
✅ Vista Corte de Obra verificada en navegador real (Playwright) para ambos escenarios de scope, confirmando que "No disponible" se muestra correctamente y no 0%.
✅ Export Excel y PDF generan archivos correctos con el mismo desglose.
✅ Lista final de todos los archivos modificados con resumen de cada cambio.

Estimado: esfuerzo Medio — Claude Code + Sonnet 5, ~3-4 horas (backend + frontend + export; sin migración de schema).
