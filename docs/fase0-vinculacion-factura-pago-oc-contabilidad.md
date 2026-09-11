# Fase 0 — Diagnóstico y diseño: vincular factura (CFDI) al pago de OC + Contabilidad

Solo diseño, nada implementado (prompt-fase0-vinculacion-factura-pago-oc-contabilidad.md).
Continúa el diagnóstico previo (`prompt-diagnostico-pago-oc-contabilidad-factura.md`), que ya
confirmó: cero conexión automática pago de OC↔Contabilidad, y sin forma de adjuntar factura al
pago — pero sí existe un repositorio de CFDI separado. Este documento inventaría ese repositorio
y las 5 fases de Contabilidad con evidencia real, y diseña cómo conectarlos.

## 1. Inventario del repositorio CFDI existente (Contabilidad Fase 2)

**Tabla `cfdi`** (`server/db.js:1982-2004`):

| Campo | Tipo | Notas |
|---|---|---|
| `uuid` | TEXT UNIQUE | Folio fiscal — es el identificador real de una factura, no se puede duplicar |
| `rfc_emisor` / `rfc_receptor` | TEXT | **Clave para el cruce automático** (ver diseño abajo) |
| `fecha_emision`, `subtotal`, `iva`, `total`, `tipo_comprobante` | — | Datos fiscales completos |
| `estatus_sat` | `vigente`\|`cancelado` | |
| `origen` | `xml`\|`pdf_representacion` | Cómo se capturó |
| `xml_blob_url`, `pdf_blob_url` | TEXT | Al menos uno obligatorio (`CHECK cfdi_al_menos_un_archivo`) |
| `project_id` | INTEGER, **nullable** | Puede subirse suelto, sin obra — confirmado con `GET /api/contabilidad/cfdi?project_id=sin-obra` (`server/app.js:5413`) |

**No tiene `proveedor_id` ni ningún campo que lo ate a una OC o pago** — hoy es un catálogo
fiscal 100% independiente.

**Cómo se sube hoy** (`server/app.js:5294-5407`, patrón preview→confirm, mismo que Contrato):
1. `POST /api/contabilidad/cfdi/preview` — sube XML y/o PDF a Blob, extrae campos.
   - Si hay XML: parseo determinista con `fast-xml-parser` (`server/cfdiParser.js:46-80`) — el
     CFDI es XML con esquema fijo del SAT, no hace falta IA.
   - Si NO hay XML (solo PDF de representación impresa): fallback con Claude API
     (`extraerDatosCFDIDesdePdf`, `server/cfdiParser.js:129-158`), con rate limit propio
     (10/hora/usuario).
2. `POST /api/contabilidad/cfdi/confirm` — persiste tras revisión del usuario.

**Confirma el checkpoint del Stop Condition: el repositorio SÍ está bien estructurado para este
propósito** — trae RFC, UUID, monto y fecha, no es solo el archivo. La única limitación real es
de alcance (no de estructura): no está atado a nada de Compras.

**Acceso**: TODAS las rutas de CFDI están gateadas por `auth.requireContabilidadAccess`
(`server/auth.js:1038-1040`) — `admin`, `desarrollador`, o el whitelist `USUARIOS_CONTABILIDAD =
[46, 8]`. **Ni `compras` ni `tesorería` (quien registra los pagos de OC) tienen acceso hoy** —
esto es relevante para el diseño del flujo (sección 3).

## 2. Inventario de las 5 fases de Contabilidad (con evidencia real)

| Fase | Qué cubre | Evidencia |
|---|---|---|
| **1** — Cuentas y pólizas | Catálogo de cuentas contables (1xxx activo … 5xxx gasto) + registro manual de pólizas. Silo deliberado, sin cruce con Finanzas/Erogado Real. | `server/contabilidad.js:4-12` |
| **2** — CFDI | Repositorio de facturas fiscales (ver arriba). | `server/contabilidad.js` (comentario cabecera) |
| **3** — Conciliación bancaria | Cuentas bancarias corporativas + importación/conciliación de movimientos contra pólizas. Completamente separado del control personal de saldo de Paul/Fer (`cuentas_control`). | `server/contabilidad.js:141-146` |
| **4** — Depreciación | Parámetros de depreciación de maquinaria (línea recta), cálculo on-the-fly, sin snapshot mensual. | `server/contabilidad.js:285-289` |
| **5** — Exportación mensual | **Consolida las 4 fases anteriores en un Excel de 4 hojas** (Pólizas, CFDI, Movimientos Conciliados, Depreciación) para un mes/obra dado. Documentado explícitamente como "silo separado de Finanzas/Erogado Real — nunca cruza con esos datos" (`server/contabilidad.js:426-431`). | `server/contabilidad.js:453-514` (`getDatosExportacionMes`), `server/app.js:5647-5675` (endpoint + shape del Excel) |

**Fase 5 es el lugar natural para esta conexión.** Ya tiene exactamente la forma que necesita el
"cierre mensual" de Paul: scope por mes + obra opcional, consolidación de varias fuentes, salida
en Excel de varias hojas. Agregar pagos de OC ahí es extender un patrón ya existente, no inventar
uno nuevo.

## 3. Diseño de la vinculación pago↔factura

### Campo propuesto: `pagos.cfdi_id` (FK simple, no tabla puente)

```sql
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS cfdi_id INTEGER REFERENCES cfdi(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_pagos_cfdi ON pagos(cfdi_id);
```

**Por qué 1 pago → 0 o 1 CFDI, y no una tabla puente N:M**: el caso real que Paul necesita
resolver es binario — "¿este pago tiene su factura o no?" — para poder cuadrar el cierre. Una
tabla puente (que soportaría anticipos con una sola factura repartida en varios pagos, o un pago
cubriendo varias facturas) es más robusta pero también más trabajo de UI/validación sin evidencia
todavía de que ese caso se dé seguido. Recomendación: empezar con el FK simple; si en la práctica
aparecen casos reales de una factura para varios pagos (anticipo + liquidación), agregar la tabla
puente después es un cambio aislado (no rompe nada de lo ya construido, `cfdi_id` se puede dejar
como "vínculo primario" aunque exista la tabla puente).

### Flujo: ¿subir un CFDI nuevo desde el pago, o vincular uno ya existente?

**Ambos, con el mismo mecanismo de búsqueda por RFC ya disponible sin cambios**:
`GET /api/contabilidad/cfdi?rfc_emisor=<rfc>` (`server/app.js:5409-5432`) ya soporta filtrar por
RFC emisor — y `proveedores.rfc` **ya existe** (`server/db.js:354`, confirmado con evidencia,
resuelve el otro punto del Stop Condition). Esto significa que el cruce automático es
completamente viable hoy sin ningún cambio de esquema adicional:

1. Al abrir "vincular factura" sobre un pago, el cliente llama
   `GET /api/contabilidad/cfdi?rfc_emisor={proveedor.rfc de esa OC}` y muestra los CFDI
   candidatos (folio, fecha, total) para que el usuario elija uno con un clic — no es
   "sugerencia automática que se aplica sola", es una lista pre-filtrada para elegir, el monto no
   siempre va a coincidir exacto (anticipos, retenciones) así que la confirmación sigue siendo
   manual.
2. Si no hay ningún CFDI candidato (proveedor no ha subido su factura al repositorio todavía),
   opción de subir uno nuevo ahí mismo — reusa el mismo `preview`→`confirm` de Fase 2 tal cual,
   solo que al confirmar también se manda `pago_id` para dejarlo vinculado en el mismo paso.
3. Nuevo endpoint, `PUT /api/projects/:id/ordenes/:ocId/pagos/:pagoId/cfdi` — body
   `{ cfdi_id }` (o `null` para desvincular) — valida que el CFDI exista y setea `pagos.cfdi_id`.

### El problema de permisos que hay que resolver explícitamente

Como el repositorio CFDI es Contabilidad-only y los pagos los registra `tesorería`
(`auth.allow('tesoreria')`, `server/app.js:8686`), **hoy quien registra el pago del día a día no
puede ver/subir CFDI**. Dos caminos, y la recomendación es el primero:

- **(Recomendado) El vínculo se hace desde Contabilidad, no desde Compras/Tesorería.** Paul (o
  quien tenga acceso a Contabilidad) es quien hace el cierre de mes y quien tiene las facturas de
  los proveedores — tiene sentido que el vínculo pago↔CFDI se haga desde la vista de cierre
  mensual (sección 4) en el momento de cuadrar, no en el momento de pagar. Cero cambios de
  permisos necesarios — `requireContabilidadAccess` ya cubre exactamente a quien haría esto.
- **(Alternativa, más esfuerzo)** Dar a `tesorería` un permiso nuevo, acotado, de solo
  buscar/vincular CFDI (no todo Contabilidad) para que puedan adjuntar la factura en el momento
  de capturar el pago. Viable pero es una superficie de permisos nueva — solo si Paul confirma
  que quiere que tesorería lo haga en el momento, no después.

## 4. Diseño de la vista de cierre mensual

Nueva función en `server/contabilidad.js`, mismo patrón que `getDatosExportacionMes` (mismo
`limitesMes`, mismo filtro opcional por `project_id`):

```js
async function getPagosOcDelMes({ mes, projectId }) {
  const { inicio, fin } = limitesMes(mes);
  // JOIN pagos -> ordenes_compra -> proveedores, LEFT JOIN cfdi
  // WHERE p.fecha >= inicio AND p.fecha < fin [AND oc.project_id = projectId]
  // SELECT pago (fecha, monto, metodo, referencia), oc (folio, estado),
  //        proveedor (nombre, rfc), cfdi (uuid, total) si existe
}
```

**Nueva vista en el frontend de Contabilidad** ("Pagos de OC del mes"): tabla con folio de OC,
proveedor, monto pagado, y una columna de estado ("✅ Con factura" / "⚠️ Sin factura") — filtrable
por mes/obra, igual que el resto de Contabilidad. Un vistazo le dice a Paul exactamente qué pagos
le faltan factura antes de cerrar, sin tener que cruzar manualmente contra su propio Excel.

**Quinta hoja en el export de Fase 5** (`server/app.js:5675` en adelante, mismo array `sheets`):
"Pagos OC", con las mismas columnas de la vista — así el Excel de cierre mensual que Paul ya
descarga cada mes incluye esto de una vez, consistente con las otras 4 hojas.

## 5. Alcance y esfuerzo — recomendación de fases

Conecta 3 módulos (Compras, Contabilidad, repositorio CFDI) — **sí conviene dividir**, cada parte
es útil por sí sola y no depende estrictamente de que la otra esté terminada:

**Fase 1 — Vincular CFDI a un pago (backend + UI mínima):**
- `ALTER TABLE pagos ADD COLUMN cfdi_id`.
- Endpoint `PUT .../pagos/:pagoId/cfdi`.
- UI: en la vista de detalle de una OC (donde ya se listan sus pagos), botón "Vincular factura"
  por pago → modal que reusa `GET /api/contabilidad/cfdi?rfc_emisor=...` para sugerir + opción de
  subir nueva (reusa el flujo preview/confirm de Fase 2).
- Estimado: ~35-45 min (Sonnet 5, esfuerzo Medio) — mayormente reuso de endpoints/flujos ya
  existentes, la parte nueva es el campo, el endpoint de vínculo, y la UI del modal.

**Fase 2 — Vista de cierre mensual + 5ª hoja de export:**
- `getPagosOcDelMes` en `server/contabilidad.js`.
- Vista nueva en Contabilidad (tabla con estado con/sin factura).
- Hoja "Pagos OC" en el export de Fase 5.
- Depende de que Fase 1 ya exista (`pagos.cfdi_id`) para tener algo que mostrar como "vinculado".
- Estimado: ~30-40 min (Sonnet 5, esfuerzo Medio) — reusa el patrón exacto de
  `getDatosExportacionMes`/`sendXlsxExport` ya varias veces usado en este módulo.

**Total ~65-85 min en 2 partes** — mismo orden de magnitud que las fases ya ejecutadas del
importador de matrices y del flujo de OC por insumo en esta sesión.

No se recomienda intentarlo en una sola pasada: Fase 1 por sí sola ya resuelve la mitad del
problema de Paul (poder adjuntar la factura real) sin esperar a la vista de cierre, y permite
validar con datos reales de un mes completo antes de construir el reporte encima.
