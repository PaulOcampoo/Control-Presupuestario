# Fase 0 — Fusionar Trabajadores/Nóminas con vista "todas las obras"

Diagnóstico y diseño para `prompt-fase0-fusionar-trabajadores-nominas.md`. Sin
implementación — este documento es el checkpoint de decisión antes de Fase 1.

## 1. Inventario de código actual

### Trabajadores

| | Por obra | Todas las obras |
|---|---|---|
| Función frontend | `renderTrabajadores()` (`public/app.js:17730`) | `renderTrabajadoresGlobal()` (`public/app.js:13514`) |
| Render de lista | `paintTrabajadoresList()` (`:17813`) — reusada solo aquí | Inline dentro de `pintarTabla()` (`:13608`) — no reusa `paintTrabajadoresList` |
| Endpoint principal | `GET /api/projects/:id/trabajadores` | `GET /api/trabajadores` |
| Layout | Cards | Tabla |
| Filtro | — (ya está scoped a `state.projectId`) | `<select>` por obra específica (`trabGlobalFiltroObra`) — filtra por obra, no por cliente |
| Columnas/datos visibles | Nombre, puesto, badges (tipo de pago, periodicidad, "Maquinaria" si aplica, Inactivo), tarifa jornal | Nombre, puesto, **Cliente**, **Obra(s)**, **Residente(s) a cargo**, tipo de pago, botón "Ver cuenta" (bancaria inline) |
| Acciones disponibles | Docs, Contrato, EPP, Editar, Dar de baja/Reactivar, Eliminar (si inactivo) | Editar, **Gestionar obras** (🏗️ multi-obra), Dar de baja |
| Acciones ausentes en el otro lado | — | Docs, Contrato, EPP, Reactivar, Eliminar físico |
| Endpoints de soporte exclusivos | `/trabajadores/:wId/documentos`, `/contratos`, `/epp-entregas`, `/bajas` (histórico), `/reactivar` | `/trabajadores/:wId/asignar-obra`, `/desasignar-obra`, `/obras` (multi-obra) |

### Nóminas

| | Por obra | Todas las obras |
|---|---|---|
| Función frontend | `renderNominas()` (`public/app.js:19070`) | `renderNominasGlobal()` (`:18772`) |
| Endpoint principal | `GET /api/projects/:id/nominas` | `GET /api/nominas` |
| Sub-navegación propia | **"Asistencia diaria" / "Nóminas"** — "Asistencia diaria" es un calendario/heatmap completo (captura y edición día a día, rangos semana/mes/3-6-12 meses, autollenado) | **"Todas las nóminas" / "Reporte semanal por cliente" / "Días trabajados (SIROC)"** |
| Naturaleza de cada sub-vista | Captura operativa (editable) + listado de nóminas calculadas de esa obra | Reportes de consulta/exportación (Excel/PDF) agregados por cliente, sin capa de captura |
| Endpoints de soporte exclusivos | `/nominas/:id/calcular`, `/nominas/:id/export`, asistencia diaria (rango) | `/clientes/:id/nominas-reporte-semanal(+/export, /export-pdf)`, `/reporte-dias-trabajados(+/export)` |

## 2. Permisos por rol (server/auth.js)

| Tab | admin/desarrollador | residente | cabo |
|---|---|---|---|
| `trabajadores` (por obra) | ✅ | ✅ | ✅ |
| `trabajadores_global` | ✅ | ❌ (no está en `PERMISSIONS.residente.tabs`) | ❌ |
| `nominas` (por obra) | ✅ | ✅ | ✅ |
| `nominas_global` | ✅ | ❌ | ❌ |

**Confirmado: no son visibles a los mismos roles.** Residente y cabo ven
"Trabajadores"/"Nóminas" (por obra) pero **nunca** ven las versiones "todas
las obras" — son exclusivas de admin/desarrollador (`checkPermiso('trabajadores_global'|'nominas_global', 'puede_ver')` en el backend, `server/app.js:10197` y `:11310`). Cualquier fusión debe seguir ocultando la opción
"Todas las obras" del selector para esos 2 roles, no solo dejarla
deshabilitada.

Adicionalmente, la vista por-obra de Trabajadores tiene 3 sub-permisos
independientes que no aplican del lado global (`trabajadores_docs`,
`trabajadores_contrato`, `trabajadores_bancarios`) — el admin puede otorgarlos
por separado por obra; el lado global no tiene ese nivel de granularidad hoy
(usa `trabajadores_bancarios` solo para el botón "Ver cuenta").

## 3. ⚠️ Condición de pausa activada (ver Stop Conditions del prompt)

El prompt pedía pausar si las 2 vistas de un módulo tienen **columnas/campos
sustancialmente distintos, no solo alcance**. Ocurre en ambos módulos:

- **Trabajadores**: el lado global agrega columnas que no existen por-obra
  (Cliente, Obra(s), Residente a cargo, cuenta bancaria inline) y una acción
  que solo tiene sentido en un contexto multi-obra (Gestionar obras). El lado
  por-obra tiene 4 acciones (Docs/Contrato/EPP/Reactivar/Eliminar) ausentes
  del lado global.
- **Nóminas**: no es una tabla con más/menos columnas — son **dos
  sub-navegaciones completamente distintas**. Por-obra incluye un módulo de
  captura de asistencia diaria (calendario/heatmap editable) que no tiene
  ningún equivalente en el lado global; el lado global tiene 2 generadores de
  reporte (semanal por cliente, SIROC) que no existen por-obra.

**Esto no es un "simple selector sobre la misma tabla".**

## 4. Recomendación (para decidir antes de Fase 1)

Fusionar sin unificar columnas es viable **si se seden fielmente al patrón
real de Finanzas** en vez de al patrón simplificado que describía el prompt.
Vale la pena notar: `renderFinanzasVistaObra` / `VistaCliente` / `VistaGlobal`
**tampoco** muestran las mismas columnas entre sí — el selector de Finanzas
nunca fue "misma tabla, filtro distinto", siempre fue "misma pestaña de menú,
la rama activa decide qué función de render corre". Bajo esa lectura correcta
del precedente, la fusión de Trabajadores/Nóminas SÍ es aplicable:

- **Extraer el selector, NO las columnas.** Cada rama del selector ("Esta
  obra" / "Todas las obras") sigue llamando casi sin cambios a la función que
  ya existe hoy (`renderTrabajadores`/`renderTrabajadoresGlobal`,
  `renderNominas`/`renderNominasGlobal`), montada dentro de un contenedor
  común (`#trabajadoresVistaBody` / `#nominasVistaBody`), igual que
  `#finanzasVistaBody`. Cero necesidad de unificar tablas ni de tocar las
  sub-navegaciones internas de cada lado (asistencia/nóminas,
  todas/reporte/siroc siguen intactas).
- **Extraer como función reusable esta vez sí conviene**, a diferencia de lo
  que sugería el prompt original ("replicar si no vale la pena para 2 casos
  adicionales") — con Finanzas + Trabajadores + Nóminas ya son **3 usos** del
  mismo patrón (subnav de 2-3 botones + `state.<modulo>Vista` + contenedor
  `id="...VistaBody"`), suficiente para justificar un helper genérico
  (`renderVistaSelector(container, opciones, vistaActual, onCambiar)`) en vez
  de la 3ª copia manual del bloque de botones + listener.
- **Ocultar, no deshabilitar**, la opción "Todas las obras" para
  residente/cabo (mismo criterio que ya usa el picker de Finanzas para roles
  sin acceso a `avance_clientes`/`estadoResultadosGlobal` — confirmar el
  criterio exacto usado ahí antes de Fase 1, no asumido en este documento).

## 5. Propuesta de navegación

Reduce de 4 entradas de menú a 2 (`PERMISSIONS.<rol>.tabs` en
`server/auth.js` — sección "Administración" en `public/app.js:1390`
también debe actualizarse, mismo checklist de 5 puntos ya documentado en
`CLAUDE.md` para altas de sección, aplicado aquí en reversa: no se da de
alta una sección nueva, pero si `trabajadores`/`nominas` absorben el
`puede_ver` que hoy resuelve el acceso a `trabajadores_global`/
`nominas_global` como tab visible, hay que revisar los mismos 5 puntos por
cada uno):

- "Trabajadores" (antes "Trabajadores" + "Trabajadores (todas las obras)")
- "Nóminas" (antes "Nóminas" + "Nómina (todas las obras)")

Los tabs `trabajadores_global`/`nominas_global` **no desaparecen como
permiso** — siguen gateando el backend (`GET /api/trabajadores`,
`GET /api/nominas`, ambos con `checkPermiso('*_global', 'puede_ver')`) y
deciden si la opción "Todas las obras" aparece dentro del selector nuevo.
Cambia solo la navegación (2 tabs en vez de 4), no el modelo de permisos.

## 6. Estimado de esfuerzo para Fase 1

Dado que NO hay que unificar columnas (sección 4), el trabajo real es:

1. Helper `renderVistaSelector()` reusable + adoptarlo en Finanzas (opcional,
   refactor de lo ya existente) + Trabajadores + Nóminas. — ~30 min
2. Envolver `renderTrabajadores`/`renderTrabajadoresGlobal` bajo el selector,
   con gate de rol para ocultar "Todas las obras". — ~20 min
3. Envolver `renderNominas`/`renderNominasGlobal` bajo el selector, mismo
   gate. — ~20 min
4. Actualizar `PERMISSIONS.*.tabs` (server/auth.js) y las 2 entradas de menú
   en `public/app.js` (grupo "Administración", labels, emojis,
   `VISTAS_SIN_PROYECTO`, etc.) — ~20 min
5. Pruebas manuales por rol (admin, desarrollador, residente, cabo) en
   Preview + regresión de que ninguna sub-navegación interna (asistencia,
   reporte semanal, SIROC, docs/contrato/EPP, gestionar obras) se rompió. —
   ~30-40 min

**Total estimado Fase 1: ~2 a 2.5 h** (más que el diseño simple porque hay
2 módulos, cada uno con sub-navegación propia que hay que preservar intacta,
no 1 como Finanzas).

## Checkpoints

- ✅ Inventario completo de las 4 vistas actuales, con nombres reales de
  funciones/endpoints — sección 1.
- ✅ Confirmación de permisos por rol y si se preservan al fusionar —
  sección 2 (sí se preservan: el fusión es solo de navegación, no de
  permisos).
- ✅ Decisión justificada: extraer selector reusable (sección 4) — con 3
  usos ya (Finanzas + Trabajadores + Nóminas) se justifica el helper.
- ✅ Propuesta final de navegación — sección 5.
- ✅ Estimado de esfuerzo para Fase 1 — sección 6.
- ⚠️ Stop Condition del prompt SÍ se activó (sección 3) — se documenta la
  razón por la que se recomienda proceder de todos modos (sección 4), pero
  queda pendiente de tu confirmación explícita antes de arrancar Fase 1.
