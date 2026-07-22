# Diseño: Desglose del Presupuesto por categorías (Materiales / M.O. / Carga Social / Herramienta y Equipo / Indirecto)

Diagnóstico + propuesta de diseño — **sin código implementado**. Para revisión de Paul antes de escribir una sola línea.

---

## 1. Diagnóstico (evidencia real, Neon producción, solo lectura)

### 1.1 Valores reales de `insumos.categoria` hoy en producción

Consulta directa a las 5 obras que tienen filas en `insumos` (`GROUP BY categoria`):

| categoria (valor exacto en BD) | Filas | Obras | Suma importe_presupuesto |
|---|---|---|---|
| `MATERIALES` | 395 | 5 de 5 | $10,887,004.87 |
| `MANO DE OBRA` | 68 | 4 de 5 | $6,364,321.76 |
| `EQUIPO Y HERRAMIENTA` | 31 | 4 de 5 | $631,317.54 |

Ninguna fila contiene `carga social` o `indirecto` en `categoria` ni en `concepto`, en ninguna obra — búsqueda `ILIKE '%carga%'` / `ILIKE '%indirect%'` sobre las ~2,500 filas de `insumos` da **0 resultados**.

**Origen de estos 3 valores**: no es una convención inventada por mí — `server/parser.js` (línea 229) ya reconoce explícitamente estas etiquetas al leer el Excel de "Listado de insumos": `['MATERIALES', 'MANO DE OBRA', 'EQUIPO Y HERRAMIENTA', 'HERRAMIENTA', 'MAQUINARIA']`. Solo las primeras 3 aparecen realmente en los datos cargados hasta hoy.

### 1.2 Desglose real por obra (evidencia de que no todas las obras tienen las 3 categorías)

| project_id | Obra | Cliente | Categorías presentes |
|---|---|---|---|
| 13 | 715 URBANIZACION AMANI | VINTE | Solo `MATERIALES` ($851,813.94) |
| 24 | 684 INFRA REDES HIDR... | VINTE | Materiales + Mano de Obra + Equipo y Herramienta |
| 30 | RED HIDRAULICA | Kalia residencial | Materiales + Mano de Obra + Equipo y Herramienta |
| 32 | MEDIA, BAJA TENSION... | Kalia residencial | Materiales + Mano de Obra + Equipo y Herramienta |
| 36 | Residencial Porfirio Diaz | COMVIVE | Materiales + Mano de Obra + Equipo y Herramienta |

**Hallazgo relevante**: la obra 13 (VINTE), que es la única con el desglose de Contrato 100% completo (PR #46), es precisamente la que **menos** categorías tiene del lado Presupuesto real (solo Materiales). Las obras 24/30/32/36 tienen las 3 categorías reales completas, pero **ninguna de ellas tiene datos de Contrato** (24 y 36 no tienen ninguna fila en `meta` de contrato; 30 y 32 solo tienen `total_contratado`, sin el desglose).

**Consecuencia para el diseño**: hoy, en producción, **no existe ninguna obra con ambos lados completos simultáneamente**. La vista comparativa Contrato-vs-Real es válida y debe construirse, pero mostrará casillas vacías en la mayoría de los casos existentes hasta que se cargue más contrato / más presupuesto con estas categorías. No es un bloqueador — es el estado esperado de un feature nuevo con datos históricos parciales.

### 1.3 Fuente de dato por cada una de las 5 categorías (Presupuesto real)

| Categoría (cédula) | ¿Existe en Presupuesto real? | Fuente exacta |
|---|---|---|
| Materiales | ✅ Sí | `SUM(insumos.importe_presupuesto) WHERE categoria = 'MATERIALES'` |
| Mano de Obra | ✅ Sí | `SUM(insumos.importe_presupuesto) WHERE categoria = 'MANO DE OBRA'` |
| Herramienta y Equipo | ✅ Sí | `SUM(insumos.importe_presupuesto) WHERE categoria = 'EQUIPO Y HERRAMIENTA'` |
| Carga Social | ❌ **Gap real** | No existe en `insumos` ni en ninguna otra tabla como concepto presupuestado. Ver 1.4. |
| C. Indirecto y Utilidad | ❌ **Gap real** | No existe en `insumos`. Es conceptualmente un % de margen aplicado sobre Costo Directo a nivel Contrato, no una partida física del Excel de insumos — es esperable que no esté ahí. |

No invento una fuente para Carga Social ni Indirecto — se reportan como gap, tal como pedía la instrucción explícita de no inventar.

### 1.4 ¿Destajo o Nómina podrían servir para Mano de Obra / Carga Social?

Investigado y **descartado** — no por falta de datos, sino porque miden algo distinto y en una escala incompatible:

- **`destajo_items`** (asignación real a destajistas): existen datos (ej. project 13: $451,280 asignados), pero es "trabajo asignado/ejecutado a destajistas", no "presupuesto de mano de obra". En project 30, el monto asignado en destajo es **$0** mientras que `insumos` con categoría Mano de Obra suma **$129,713** — no hay correlación, confirman que son conceptos distintos.
- **`nomina_items`** (nómina real pagada): los montos son órdenes de magnitud menores ($2,400, $10,500) comparado con los presupuestos de Mano de Obra en insumos (cientos de miles) — es gasto real parcial capturado hasta ahora, no un presupuesto.

**Conclusión**: ya no hace falta usar Destajo/Nómina — `insumos.categoria = 'MANO DE OBRA'` ya es la fuente correcta y confiable para esta categoría (contradice la suposición inicial del prompt de que "probablemente no vive en insumos" — sí vive ahí, con evidencia real).

### 1.5 Conflicto de nomenclatura: "Herramienta y Equipo" vs. "Equipo y herramienta" (Maquinaria)

**No es un conflicto nuevo — ya está resuelto en código, solo con presentación distinta.** `server/maquinaria.js` (línea 178-221, `getPresupuestoSugerido()`) ya combina exactamente estas 2 fuentes para el presupuesto sugerido de Maquinaria:

1. Fuente primaria: `SUM(insumos.importe_presupuesto) WHERE categoria = 'EQUIPO Y HERRAMIENTA'`.
2. Respaldo: `meta.subtotal_herramienta_equipo` (del Contrato) si la suma anterior es 0.

Es decir, el propio código ya trata ambos strings como el mismo concepto semántico — la única diferencia es el orden de las palabras en el texto guardado (`EQUIPO Y HERRAMIENTA` en `insumos.categoria`, viene del Excel; `Herramienta y Equipo` en la etiqueta de la cédula/Contrato). **Recomendación**: no renombrar nada en BD (rompería el match exacto que ya usa Maquinaria) — unificar solo la **etiqueta de display** en el frontend nuevo (usar "Herramienta y Equipo", que es el texto de la cédula, para ambas columnas de la vista comparativa) y documentar en un comentario, igual que ya se hizo para otros casos de nomenclatura en este proyecto.

### Confirmación del Stop Condition

El stop condition decía: pausar si **ninguna** de las 5 categorías tuviera dato confiable del lado real. No aplica — **3 de 5 sí lo tienen** (Materiales, Mano de Obra, Herramienta y Equipo), con datos reales sustanciales. Prosigo con la propuesta de diseño.

---

## 2. Propuesta de diseño

### 2.1 Cálculo de % por categoría (por obra)

Para cada obra, dos series de %, cada una sobre su propia base:

**Lado Contrato** (ya tiene los 6 valores en `meta`, PR #46):
```
% categoría = subtotal_categoria / subtotal_costo_directo × 100
```
(Costo Directo = Materiales + M.O. + Carga Social + Herramienta, antes de Indirecto/Utilidad — así los 4 primeros suman 100% y muestran su peso relativo; Indirecto y Utilidad se muestra aparte como % sobre Importe Contratado, ya que conceptualmente es un margen, no un componente del costo directo.)

**Lado Presupuesto real** (nuevo cálculo, `insumos`):
```
% categoría = SUM(insumos.importe_presupuesto WHERE categoria = X) / SUM(insumos.importe_presupuesto de las 3 categorías con dato) × 100
```
Para Carga Social e Indirecto: sin dato → se muestra `"No disponible"`, no un 0% (0% implicaría "sabemos que es cero", que es distinto de "no lo medimos").

### 2.2 Vista comparativa Contrato vs. Presupuesto real

Tabla de 5 filas (una por categoría) × 2 columnas (Contrato % | Presupuesto real %), con la diferencia absoluta resaltada cuando sea significativa (propongo >5 puntos porcentuales como umbral, ajustable):

| Categoría | Contrato | Presupuesto real | Diferencia |
|---|---|---|---|
| Materiales | 64.5% | 61.7% | −2.8pp |
| Mano de Obra | 14.8% | 30.1% | **+15.3pp** ⚠️ |
| Carga Social | 5.2% | No disponible | — |
| Herramienta y Equipo | 15.6% | 8.2% | **−7.4pp** ⚠️ |
| Indirecto y Utilidad | 11.1%* | No aplica | — |

*(\*) sobre Importe Contratado, no sobre Costo Directo — nota aparte en la vista.*

Cuando una obra no tiene datos de un lado (Contrato o Real), esa columna completa se muestra como `"Sin datos"` con el mismo tratamiento visual que ya usa Impuestos/Contrato para campos vacíos (`—`), no como error.

### 2.3 Acumulado ponderado a 3 niveles (obra → cliente → global)

**Mismo criterio matemático exacto que Avance (Prompt 3, ya implementado en `feat/avance-acumulado-cliente-global`, mergeado PR #47)** — reutilizo esa función de ponderación en vez de escribir una nueva:

```
peso_obra = presupuesto_obra / Σ presupuesto de las obras relevantes
% categoría (agregado) = Σ (% categoría_obra × peso_obra)
```

- **Obra**: ya es el dato base (2.1).
- **Cliente**: agrega las obras de ese cliente, ponderando por `presupuesto_total` de cada obra (mismo `COALESCE(meta.total_sin_iva, ...)` ya usado 3 veces en el código, incluyendo el endpoint de Avance que acabo de construir).
- **Global**: agrega todas las obras de todos los clientes, mismo criterio.

Diferencia clave con Avance: aquí se calculan **2 series paralelas** (Contrato-ponderado y Real-ponderado) en vez de 1 sola métrica — el resto de la mecánica de ponderación es idéntica, así que técnicamente es sumar una dimensión más a la misma función, no reinventar el patrón.

**Nota importante de diseño**: dado que hoy ninguna obra tiene ambos lados completos (1.2), el acumulado por cliente/global mostrará, en la práctica actual, mezclas de "algunas obras solo aportan al lado Contrato, otras solo al lado Real" — cada serie ponderada debe calcularse **solo sobre las obras que tienen dato para esa categoría específica** (no tratar "sin dato" como 0, se sesgaría el promedio hacia abajo incorrectamente). Esto es análogo a cómo ya se maneja `presupuesto_sugerido` en Maquinaria (marca la `fuente` por obra para que quede trazable).

### 2.4 ¿Dónde vive esta vista?

**Recomendación: extender la pestaña Contrato existente (no una pantalla nueva) para el nivel obra, + una vista nueva dedicada para cliente/global.**

Justificación:
- La pestaña **Contrato** (`renderContrato`, `public/app.js`) ya muestra exactamente estos 6 subtotales como tarjetas de solo lectura (trabajo de PR #46). Agregar la comparación ahí (una sección nueva "Composición vs. Presupuesto real" debajo de las tarjetas existentes) reutiliza la pantalla donde el usuario ya está viendo estos datos — cero navegación nueva para el caso de obra individual.
- Para el acumulado por **cliente/global**, no tiene sentido meterlo dentro de Contrato (que es una pantalla por-obra) ni duplicar la pantalla "Avance por cliente" (que es una métrica distinta, avance físico/financiero, no composición de costo — el propio prompt aclara que son cosas separadas). Propongo una vista nueva, hermana de "Avance por cliente" en la sección Administración del sidebar (mismo patrón: admin/desarrollador únicamente, mismo lenguaje visual `.apc-*`), con nombre de vista `composicion_costos` o similar.
- Alternativa descartada: pantalla 100% nueva para todo (obra + cliente + global). La descarto porque duplicaría navegación con Contrato sin necesidad para el caso obra-individual.

---

## 3. Estimado de esfuerzo para implementación (una vez aprobado)

| Pieza | Esfuerzo |
|---|---|
| Endpoint `GET /api/projects/:id/composicion-costos` (obra: % Contrato + % Real + diff) | Bajo — mismo patrón de queries ya usado 3 veces |
| Extender `renderContrato` con la sección comparativa | Bajo — reutiliza card/tabla ya existente |
| Endpoint `GET /api/composicion-costos/completo` (cliente + global, ponderado) | Medio — adapta la función de ponderación de Avance, pero con 5 series en vez de 1 |
| Vista frontend nueva "Composición de costos" (cliente/global) | Medio — similar a `renderAvanceClientes` recién construida, mismo esqueleto |
| Verificación con Postgres efímero + HTTP real + Playwright | Bajo-Medio — mismo patrón ya usado en los últimos 2 prompts |

**Total estimado: 60-90 min**, similar al esfuerzo de "Avance acumulado por cliente + global" (Prompt 3), por ser el mismo patrón aplicado a una dimensión extra.

---

## Resumen ejecutivo para Paul

- ✅ 3 de 5 categorías (Materiales, Mano de Obra, Herramienta y Equipo) **sí tienen dato real confiable** en `insumos.categoria` — con evidencia de producción, no es una suposición.
- ❌ Carga Social e Indirecto y Utilidad **no existen** del lado Presupuesto real hoy — gap genuino, no inventé nada. Indirecto es conceptualmente esperable que no esté ahí (es margen, no partida física); Carga Social sí sería razonable pedirle al equipo que la capture en el Excel a futuro si se quiere cerrar ese gap.
- El naming "Herramienta y Equipo" vs "Equipo y Herramienta" ya está resuelto en código (Maquinaria) — solo hace falta unificar la etiqueta de display, no tocar BD.
- Hoy ninguna obra tiene ambos lados completos simultáneamente — la vista comparativa es válida pero mostrará huecos hasta que se cargue más data.
- Propongo extender Contrato (nivel obra) + nueva vista admin-only hermana de "Avance por cliente" (nivel cliente/global), reutilizando la función de ponderación ya construida en el Prompt 3.

**Pendiente de tu aprobación antes de escribir código.**
