# Fase 0 — Diagnóstico y diseño: casos no soportados del importador de Matrices

Solo diseño, nada implementado (prompt-fase0-importador-matrices-casos-no-soportados.md).

## Contexto verificado

El comportamiento actual (`server/ingest.js:110-114`, comentario explícito) es
**todo-o-nada a nivel de bloque de Matrices**: si `resolverBloqueImportacion`
devuelve `estado: 'error'` para **cualquiera** de los bloques de la hoja
"Matrices", `ingest()` lanza (`ingest.js:142-145`) y la transacción completa
(`proyectos` + `conceptos` + `insumos` + `destajo`, todo en el mismo
`db.withTransaction`, `server/app.js:6033-6040`) hace ROLLBACK. La fila de
`proyectos` se crea **dentro** de esa misma transacción precisamente para
que esto nunca deje una obra huérfana — eso ya funciona bien y no hay que
tocarlo.

El problema no es la garantía de integridad (esa ya es correcta). El
problema es la **granularidad**: hoy "todo" significa "proyecto + TODOS los
conceptos/insumos + TODAS las matrices sin excepción". Con 1 de ~30+ bloques
irresoluble, se pierde la obra completa.

## Caso 1 — código duplicado en 2+ capítulos

### Verificado contra el archivo real `Ppto 732 VInte Infra RD E1 03092026.xlsx`

Hoja "Directo AJAL" (presupuesto), código `AJAL.TRA.LIN` aparece 2 veces:

| Fila | Capítulo | Cantidad | Precio | Importe |
|---|---|---|---|---|
| 19 | CALLE LLANURAS | 208.9 | 7.29 | 1522.88 |
| 28 | PASEO PUNTA CUERNA 2 | 303.77 | 7.29 | 2214.48 |

Hoja "Matrices", buscando `AJAL.TRA.LIN`:

| Fila | `Análisis:` cantidad_concepto | importe_concepto |
|---|---|---|
| 19 | **208.9** | 1873.83 |
| 208 | **303.77** | 2724.82 |

**Hallazgo clave:** no es un solo bloque de Matrices ambiguo con 2 destinos
posibles — son **2 bloques de Análisis separados**, uno por cada aparición
en el presupuesto, y cada uno **ya trae su propia `cantidad_concepto`**
(`bloqueActual.cantidad_concepto = num(F)`, `server/matricesImport.js:238`,
ya se parsea hoy, no hace falta tocar el parser). Esa cantidad coincide
**exactamente** con la cantidad de uno solo de los 2 conceptos candidatos.

### Diseño propuesto

En `resolverBloqueImportacion` (`server/matricesImport.js:428-431`), cuando
`conceptosCandidatos.length > 1`, en vez de fallar de inmediato:

1. Filtrar candidatos cuyo `concepto.cantidad` coincida con
   `bloque.cantidad_concepto` dentro de una tolerancia chica (ej. `< 0.01`,
   mismo criterio que ya usa `resolverRenglon` para factores `%`,
   `matricesImport.js:340`).
2. Si queda **exactamente 1** candidato → resolver contra ese, normal.
3. Si quedan 0 o 2+ → no se puede determinar con seguridad → cae al Caso
   general de "bloque no resuelto" (ver sección de integridad abajo), **no**
   se inventa una asignación.

Esto no es literalmente el patrón de "sufijo -C1/-C2" que sugería el
prompt original — investigué el precedente citado (PR #207,
`fix/emparejamiento-duplicados-nan`, commit `fe2f07b`) y ese fix es sobre
**Actualizar presupuesto** (reconciliación de conceptos), un problema
distinto: ahí no existe la hoja de Matrices ni el problema de qué bloque de
Análisis corresponde a qué concepto. No genera sufijos de código; deja que
existan conceptos duplicados y empareja el primero, agrega los demás como
nuevos. Ese precedente no es reusable tal cual aquí. La cantidad-como-
desambiguador es una solución nueva, más simple, y ya verificada contra el
archivo real de Rodolfo — cero inferencia, usa un dato que el propio Excel
ya provee.

**Riesgo residual:** si algún día 2 capítulos tienen el mismo código Y la
misma cantidad exacta, este desambiguador no alcanza — cae correctamente a
"no resuelto" (no asigna al azar).

## Caso 2 — cuadrilla pre-agregada sin desglose (`1A5P`)

### Lo que el código ya confirma

`server/matricesImport.js:353-361` — un renglón `tipo: 'insumo'` cuyo código
no está en el catálogo de insumos, empieza con dígito, y su categoría es
`MANO DE OBRA` o `null`, dispara `ERROR_CUADRILLA_PRECOLAPSADA`. El parser
(`matricesImport.js:316-320`) **solo captura `codigo`, `cantidad` y
`operador`** de ese renglón — nunca lee las columnas D (precio) ni G
(importe) de esa fila para renglones tipo insumo, porque el precio de un
renglón normal siempre sale del catálogo (`insumo.precio_presupuesto`), no
de la hoja.

### Confirmado contra el archivo real `Ppto_Catalogo_Terracerias_Temixco_03092026.xlsx`

Fila real de la hoja "Matrices" (fila 48):

```
["1A5P", "CUADRILLA No 22  (1 ALBAÑIL + 5 PEONES)", "JOR", "5218.31", "/", "12", "434.86", "0"]
   A            B (descripción)                        C       D      E    F      G       H
```

Columnas: A=código, B=descripción, C=unidad, **D=precio (5218.31), E=operador
('/'), F=cantidad (12), G=importe (434.86)**. Es decir: **la columna D SÍ
trae el costo total real de la cuadrilla** ($5,218.31 — el jornal conjunto
de 1 albañil + 5 peones), y G ya trae el resultado de la división
(5218.31 ÷ 12 = 434.858… → 434.86, redondeo estándar). El parser hoy
descarta D y G para renglones `tipo: 'insumo'` porque asume que el precio
siempre viene del catálogo — en este caso concreto viene de la hoja misma,
sin que el parser lo sepa todavía.

Esto es **matemáticamente idéntico** a la fórmula que `calcularMatrizNeodata`
ya aplica hoy para `operador === '/'` (`matricesImport.js:102`:
`r2(precio / Number(r.cantidad))`) — con `precio=5218.31, cantidad=12` da
exactamente 434.86. No hace falta tocar `calcularMatrizNeodata` en
absoluto; el único cambio real es de dónde sale `precio`.

### Diseño confirmado (ya no condicionado)

1. **Parser** (`matricesImport.js:316-320`): para un renglón `tipo: 'insumo'`
   dentro de MANO DE OBRA, capturar también `precio_hoja: num(D)` (columna
   D), además de `codigo`/`cantidad`/`operador` como ya hace.
2. **`resolverRenglon`** (`matricesImport.js:353-361`): cuando el código no
   está en `insumosPorCodigo` y matchea el heurístico de cuadrilla-
   precolapsada (empieza con dígito, categoría MANO DE OBRA/null) — en vez
   de devolver `ERROR_CUADRILLA_PRECOLAPSADA` directo, primero revisar si
   `r.precio_hoja` es un número válido (`> 0`, no null/NaN):
   - Si sí: resolver el renglón como `tipo: 'cuadrilla_colapsada'` con
     `precio_hoja` como fuente de precio (rama nueva en
     `calcularMatrizNeodata`, línea 101, junto a `'basico_ref'`/`'insumo'` —
     mismo `cantidad`/`operador` que ya se calculan igual para cualquier
     tipo). Se marca en el renglón persistido (`descripcion` o un flag
     `sin_desglosar: true`) para que la UI de la matriz lo señale
     visualmente — "mano de obra sin desglosar por oficio, capturado como
     bloque único desde el Excel".
   - Si no (D vacío/0/no numérico): se mantiene el error actual tal cual
     — degrada con gracia a nivel de bloque (ver garantía de integridad
     abajo), no se inventa ningún precio.
3. Cero riesgo de dato incorrecto silencioso: el precio no se infiere, es
   literalmente el que el estimador ya capturó en su propio Excel — el
   único cambio es que el importador deja de tirarlo a la basura.

**No se pierde nada del desglose real** (qué gana el albañil vs. cada
peón) porque ese desglose **nunca existió en el Excel de origen** — el
propio Paul lo confirmó ("sin desglose individual entre el albañil y los
5 peones"). Guardar el total como viene es estrictamente más fiel a la
fuente que rechazar la obra completa.

## Garantía de integridad — el cambio real de fondo

Esta es la pieza que más impacto tiene y es independiente de si Caso 1/Caso
2 se resuelven automáticamente o no: **cambiar la unidad de "todo o nada"
de "bloque" a "obra"**.

Diseño:
- La transacción `proyectos` + `conceptos` + `insumos` + `destajo` sigue
  siendo 100% atómica, sin cambios — sigue siendo imposible que quede una
  obra a medias.
- `ingest.js:142-145` deja de hacer `throw` cuando hay bloques con
  `estado: 'error'`. En su lugar, esos bloques se **omiten** (no se
  inserta su fila en `matrices_precio_unitario`) y se acumulan en un
  arreglo de resultado (ej. `matrices_no_resueltas: [{ codigo_analisis,
  motivo }]`) que `POST /api/projects` devuelve junto con el resto del
  resumen (`server/app.js:6041-6050`, ya devuelve conteos de
  conceptos/insumos/destajistas — se agrega este campo más).
- El concepto correspondiente a un bloque no resuelto **sí se crea** (ya
  se insertó antes, en el bloque de Presupuesto/Insumos de la misma
  transacción) con su `precio_unitario`/`importe` tal cual venían de la
  hoja de presupuesto — solo le falta la matriz de Análisis de Precio
  Unitario. Esto es un estado que el schema ya soporta hoy sin ningún
  cambio: `matrices_precio_unitario.concepto_id` es `UNIQUE` pero **no**
  hay ningún `NOT NULL`/trigger que obligue a que todo concepto tenga una
  matriz — de hecho cualquier obra capturada manualmente sin usar el
  importador de Matrices ya vive así permanentemente.
- Frontend: mostrar `matrices_no_resueltas` en el resultado de la carga
  (mismo lugar donde hoy se muestra "N conceptos, M insumos") como aviso,
  no como error — "3 análisis de precio unitario no se pudieron generar
  automáticamente, revísalos en Matrices". Fuera de alcance de este
  diseño detallar la UI exacta, pero el dato ya estaría disponible.

Con esto, Caso 1 sin desambiguar y Caso 2 sin resolver dejan de bloquear
la obra completa — se convierten en "3 de 30 análisis quedaron pendientes
de captura manual" en vez de "0 obras creadas". Esto solo, sin ninguna
lógica adicional de auto-resolución, ya cumple el objetivo de negocio que
citó Paul ("que se puedan subir sin ningún problema").

## Inventario completo de otros patrones que abortan hoy

Todos viven en `server/matricesImport.js`, todos pasan por el mismo punto
de bloqueo (`bloque.estado = 'error'` → hoy aborta la obra, con el diseño
de arriba pasarían a "bloque omitido, obra sigue"):

| Línea | Motivo | Categoría |
|---|---|---|
| `matricesImport.js:197` | Falta la fila `"PRECIO UNITARIO"` — bloque incompleto | Estructural (Excel mal formado) |
| `matricesImport.js:269` | Fila `"Volumen:"` sin básico anidado ni sección MANO DE OBRA activa | Estructural |
| `matricesImport.js:301` | Fila header de cuadrilla/básico fuera de MANO DE OBRA/BASICOS | Estructural |
| `matricesImport.js:308` | Renglón fuera de cualquier sección conocida | Estructural |
| `matricesImport.js:343` (vía 398/409) | Un factor `%` no coincide con ningún subtotal ya calculado (tolerancia 0.02) | Cálculo/formato |
| `matricesImport.js:360` | Código de insumo/cuadrilla no existe en el catálogo — incluye Caso 2 (`ERROR_CUADRILLA_PRECOLAPSADA`) y el caso genérico "código no existe" | Catálogo/negocio |
| `matricesImport.js:426` | No se pudo leer el código de análisis (fila `"Análisis:"` vacía o rota) | Estructural |
| `matricesImport.js:430` | Código coincide con 2+ conceptos — Caso 1 | Negocio (este diagnóstico) |
| `matricesImport.js:434` | Código no coincide con ningún concepto de la obra | Negocio — la hoja de Matrices referencia algo que no está en el presupuesto |
| `ingest.js:138` | 2 bloques del mismo archivo resolviendo al mismo `concepto_id` (dirección opuesta al Caso 1) | Negocio |

Con el cambio de integridad de arriba, **todos** estos dejan de abortar la
obra — se degradan igual, a "bloque omitido + motivo reportado". No hace
falta diseñar una solución de auto-resolución para cada uno en este
prompt (fuera de alcance, según lo pedido) — el inventario es para tener
el panorama completo, no para implementarlos todos ahora.

## Estimado de esfuerzo — Fase 1, 2 partes independientes

**Parte A — Cambio de integridad (bloque→obra) + Caso 1 (desambiguación
por cantidad):** ~45-60 min con Claude Code (Sonnet 5, esfuerzo Medio).
Es la parte de mayor impacto/menor riesgo — no requiere el archivo 684
Barrancas, ya está verificada contra datos reales, y por sí sola desbloquea
ambos casos reales de Rodolfo (aunque Caso 2 quede pendiente de captura
manual en vez de resuelto automáticamente).

**Parte B — Caso 2 (cuadrilla pre-colapsada):** confirmado contra
`Ppto_Catalogo_Terracerias_Temixco_03092026.xlsx` — columna D sí trae el
costo total utilizable (código 1A5P, $5,218.31 ÷ 12 = $434.86, fila 48 de
"Matrices"). ~30-40 min con Claude Code (Sonnet 5, esfuerzo Medio): capturar
`precio_hoja` en el parser, nueva rama `tipo: 'cuadrilla_colapsada'` en
`resolverRenglon`/`calcularMatrizNeodata`, flag visual en la UI de matriz.
Independiente de la Parte A — puede ir antes, después, o en paralelo.
