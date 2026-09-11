# Prompt 1 — Exportar a Excel: catálogo cargado + saldo por estimar por contrato

**Estimado:** Claude Code + Sonnet 5, esfuerzo Medio (~1.5–2h, incluye Fase 0 diagnóstica)

```
Objective:
Agregar en el módulo Presupuestos/Finanzas un botón de exportación a Excel que genere el catálogo de conceptos con el que se cargó el presupuesto de una obra, incluyendo una columna de "saldo por estimar" calculado por contrato (presupuesto contratado menos lo ya ejecutado/avanzado).

Starting State:
- Módulo Presupuestos permite cargar catálogo de conceptos vía Excel (server/app.js, public/app.js).
- Tabla `conceptos` contiene las líneas de presupuesto por proyecto; tabla `contratos` contiene subtotales por proyecto (1:1 o 1:N).
- Módulo Finanzas ya calcula Erogado Real vs presupuestado (existe lógica de comparación reutilizable).
- No existe actualmente ningún endpoint ni botón de exportación a Excel del catálogo cargado.
- Sugerencia originada por Rodolfo (Grupo Roforb) vía módulo Sugerencias.

Target State:

1. FASE 0 — DIAGNÓSTICO (obligatorio antes de codear):
   - Confirmar estructura exacta de `conceptos` (columnas disponibles: descripcion, precio_unitario, cantidad, etc.)
   - Confirmar cómo se relaciona `contratos` con `proyecto_id` (1:1 o 1:N real en los datos de producción, obras id=1,4,13)
   - Confirmar de dónde sale "avance ejecutado" para poder calcular saldo por estimar (tabla avance semanal / requisiciones / destajo — la que aplique)
   - Reportar hallazgos antes de continuar a implementación si algo no coincide con lo asumido arriba

2. ENDPOINT DE EXPORTACIÓN (backend):
   - Nuevo endpoint `GET /api/proyectos/:id/export-catalogo-excel`
   - Requiere autenticación + verificación de ownership de proyecto (mismo patrón usado en el resto del sistema para evitar IDOR)
   - Genera Excel (misma librería ya usada en exportaciones existentes, ver `server/exportHelper.js`) con: catálogo completo de conceptos cargados + columna "Saldo por estimar" = presupuestado − ejecutado, agrupado/desglosado por contrato cuando el proyecto tenga más de un contrato asociado

3. UI (frontend):
   - Botón "Exportar catálogo a Excel" en pantalla de Presupuestos (o Finanzas, según lo que confirme Fase 0 como ubicación más natural)
   - Respeta permisos de rol existentes (mismo criterio que otras exportaciones ya protegidas con rate limiting)

Allowed Actions:
- Modificar `server/app.js` para agregar el nuevo endpoint
- Modificar `server/exportHelper.js` si se requiere una función nueva de generación de Excel
- Modificar `public/app.js` y el HTML/CSS correspondiente para el botón nuevo
- Leer (no modificar) esquema de `server/db.js` para confirmar columnas

Forbidden Actions:
- NO modificar el flujo de carga de catálogo existente (import de Excel)
- NO tocar lógica de Finanzas ya funcionando (Erogado Real vs presupuestado) — solo reutilizar/leer
- NO exponer el endpoint sin verificación de ownership de proyecto (regla dura anti-IDOR del sistema)
- NO hacer eliminación ni modificación de datos — este endpoint es solo lectura/exportación

Stop Conditions:
Pausar y reportar si:
- La relación contrato↔proyecto en los datos reales no es la esperada (1:1 o 1:N ambiguo)
- No hay fuente de datos clara para "ejecutado" (avance/requisiciones/destajo no dan un número consistente)
- El cálculo de saldo por estimar requiere tocar más de 2 archivos backend fuera de los ya listados

Checkpoints:
✅ Fase 0 reportada con hallazgos de schema/datos reales antes de codear
✅ Endpoint responde con Excel válido y correcto en al menos una obra real (probar con id=1 o id=4)
✅ Ownership check probado: usuario sin acceso a esa obra recibe 403
✅ Botón visible y funcional en UI, respetando permisos de rol
✅ Lista final de archivos modificados con resumen de cada cambio
```

---

# Prompt 2 — Mostrar descripciones del catálogo de conceptos (agua potable, sanitario, pluvial, descargas)

**Estimado:** Claude Code + Sonnet 5, esfuerzo Medio (~1–1.5h, incluye Fase 0 diagnóstica)

```
Objective:
Corregir el catálogo de conceptos para que muestre la descripción/categoría de cada línea (ej. agua potable, sanitario, pluvial, descargas) tal como viene en el Excel de carga, en lugar de no aparecer.

Starting State:
- Tabla `conceptos` almacena líneas de presupuesto por proyecto; se desconoce si el campo de descripción/categoría existe en el schema pero no se muestra en UI, o si no se está capturando en el import de Excel.
- Reportado por Rodolfo (Grupo Roforb) vía módulo Sugerencias: en el catálogo no aparecen las descripciones de tipo de línea (agua potable, sanitario, pluvial, descargas, etc.).
- Afecta a obras reales en producción (proyectos id=1, 4, 13).

Target State:

1. FASE 0 — DIAGNÓSTICO (obligatorio antes de codear):
   - Revisar schema de `conceptos` en `server/db.js`: ¿existe columna de descripción/categoría?
   - Revisar el parser de import de Excel (server/app.js o módulo dedicado): ¿el Excel de origen trae esa columna y se está descartando en el mapeo?
   - Revisar consultas SQL que alimentan la vista de catálogo en `public/app.js`: ¿el campo se consulta pero no se renderiza, o ni siquiera se selecciona?
   - Con base en el diagnóstico, identificar si es bug de import, de query, o de render — y reportar antes de implementar el fix

2. FIX (según lo que revele Fase 0):
   - Si falta en el import: mapear la columna correspondiente del Excel al campo de descripción al insertar en `conceptos`
   - Si falta en la query: incluir el campo en el SELECT correspondiente
   - Si falta en el render: agregar la columna/celda en la tabla de catálogo del frontend
   - Aplicar el fix consistentemente en las 3 obras reales (id=1, 4, 13) sin requerir re-carga manual de catálogo si es posible (evaluar si se puede popular retroactivamente con un backfill controlado, o si requiere re-importar)

Allowed Actions:
- Modificar el módulo de import de Excel (identificado en Fase 0)
- Modificar queries SQL relacionadas al catálogo de conceptos
- Modificar `public/app.js` para renderizar el campo si es un problema de UI
- Script puntual de backfill de datos existentes SOLO si Paul lo autoriza explícitamente tras ver el diagnóstico (no ejecutar SQL en producción sin autorización — regla del protocolo)

Forbidden Actions:
- NO ejecutar ningún ALTER/UPDATE directo en producción sin autorización explícita de Paul
- NO tocar el resto de columnas ya funcionando del catálogo (precio_unitario, cantidad, etc.)
- NO modificar `concepto_insumos` ni el módulo de Mapeo — fuera de scope

Stop Conditions:
Pausar y reportar si:
- El campo de descripción no existe en ningún nivel (ni Excel origen, ni schema, ni UI) — requeriría decisión de negocio sobre de dónde debe salir el dato
- El fix requiere backfill de datos en producción (pausar y esperar autorización antes de tocar Neon producción)
- Los 3 proyectos reales tienen estructuras de catálogo inconsistentes entre sí

Checkpoints:
✅ Fase 0 reportada con causa raíz identificada (import / query / render)
✅ Fix aplicado y verificado visualmente en al menos un proyecto real por Paul
✅ Confirmado que las 3 obras reales muestran la descripción correctamente (o reportado si alguna requiere backfill separado)
✅ Lista final de archivos modificados con resumen de cada cambio
```
