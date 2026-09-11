# Prompt 1 (corregido) — Exportar a Excel: catálogo cargado + saldo por estimar

**Estimado:** Claude Code + Sonnet 5, esfuerzo Medio (~1–1.5h)

```
Objective:
Agregar en el módulo Presupuestos/Finanzas un botón de exportación a Excel que genere el catálogo de conceptos con el que se cargó el presupuesto de un proyecto, incluyendo columna "Saldo por estimar" = presupuestoTotalDe(projectId) − estimaciones.total_acumulado (última estimación aprobada).

Starting State:
- `contratos` es 1:1 con proyecto (UNIQUE project_id), solo almacena PDF + campos extraídos, SIN monto ni desglose. No hay "múltiples contratos por proyecto" — el export es por proyecto, no agrupado por contrato.
- `presupuestoTotalDe(projectId)` ya existe y calcula el lado "presupuestado" — reusar tal cual.
- `estimaciones.total_acumulado` de la última estimación con estado aprobado es la fuente de "ejecutado" para este cálculo (NO usar Avance Valorizado de getFinanzasResumenData() — esa es una métrica distinta, de avance físico, que puede ir adelantada respecto a lo ya facturado).
- Prefijo real de rutas del sistema es `/api/projects/:id/...` (no `/api/proyectos/...`).
- No existe actualmente ningún endpoint ni botón de exportación a Excel del catálogo cargado.
- Sugerencia originada por Rodolfo (Grupo Roforb) vía módulo Sugerencias.

Target State:

1. ENDPOINT DE EXPORTACIÓN (backend):
   - Nuevo endpoint `GET /api/projects/:id/export-catalogo-excel`
   - Requiere autenticación + verificación de ownership de proyecto (mismo patrón usado en el resto del sistema para evitar IDOR)
   - Genera Excel (misma librería ya usada en exportaciones existentes, ver `server/exportHelper.js`) con:
     a. Catálogo completo de conceptos cargados para ese proyecto
     b. Fila o encabezado con: Presupuesto total (`presupuestoTotalDe(projectId)`), Total acumulado última estimación aprobada, y "Saldo por estimar" = la resta de ambos
     c. Opcional pero recomendado: columna adicional "Avance no facturado" = Avance Valorizado − total_acumulado última estimación aprobada, claramente etiquetada como métrica distinta al saldo por estimar

2. UI (frontend):
   - Botón "Exportar catálogo a Excel" en pantalla de Presupuestos
   - Respeta permisos de rol existentes (mismo criterio que otras exportaciones ya protegidas con rate limiting)

Allowed Actions:
- Modificar `server/app.js` para agregar el nuevo endpoint
- Modificar `server/exportHelper.js` si se requiere una función nueva de generación de Excel
- Modificar `public/app.js` y el HTML/CSS correspondiente para el botón nuevo
- Leer (no modificar) `presupuestoTotalDe()`, tabla `estimaciones`, y `getFinanzasResumenData()` como referencia

Forbidden Actions:
- NO modificar el flujo de carga de catálogo existente (import de Excel)
- NO tocar lógica de Finanzas ya funcionando — solo reutilizar/leer
- NO exponer el endpoint sin verificación de ownership de proyecto
- NO hacer eliminación ni modificación de datos — este endpoint es solo lectura/exportación
- NO usar Avance Valorizado como el cálculo principal de "saldo por estimar" — solo como columna secundaria opcional, claramente etiquetada

Stop Conditions:
Pausar y reportar si:
- Un proyecto no tiene ninguna estimación aprobada aún (definir fallback: ¿saldo por estimar = presupuesto total completo? confirmar con Paul antes de asumir)
- El cálculo requiere tocar más de 2 archivos backend fuera de los ya listados

Checkpoints:
✅ Endpoint responde con Excel válido y correcto en al menos una obra real (id=1 o id=4)
✅ Ownership check probado: usuario sin acceso a esa obra recibe 403
✅ Saldo por estimar verificado manualmente contra un cálculo hecho a mano en al menos un proyecto
✅ Botón visible y funcional en UI, respetando permisos de rol
✅ Lista final de archivos modificados con resumen de cada cambio
```
