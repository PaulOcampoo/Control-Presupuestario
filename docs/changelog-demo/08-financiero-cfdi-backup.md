# Financiero: IVA, Acceso Financiero, CFDI, Cierre Mensual y Backup

> 7 PRs mergeados a `main` entre 2026-08-19 y 2026-09-06. Cubre: un fix de
> saldo/IVA en Órdenes de Compra replicado en 5 lugares, dos ajustes de
> whitelist de acceso a módulos financieros, el mecanismo de backup diario
> de Neon a Vercel Blob (y un fix posterior sobre su propia notificación), y
> la vinculación de CFDI (factura fiscal) a pagos de OC con vista de cierre
> mensual (2 merges de la misma rama).

---

## PR #158 — fix(finanzas): saldo/comprometido negativo o subestimado en OC con `incluye_iva=false`

**Fecha**: 2026-08-19 (merge commit `6ebef08b6aec1f1d3264a071e6e623ddf1056b58`, 1 commit: `ad83378`)

### Qué problema resolvía

Para Órdenes de Compra con `incluye_iva=false` (el precio unitario capturado
es SIN IVA, el IVA se suma aparte), el "saldo pendiente" y el "comprometido"
en 5 endpoints/vistas distintas quedaban negativos (sobre una OC ya pagada
por completo) o subestimados (mostraban $0.00 pendiente antes de que el
pago realmente cubriera el total con IVA).

### Causa raíz

`pagos.monto` siempre es el monto real transferido (con IVA incluido — es
la transferencia bancaria real). Pero `orden_compra_items.importe` **solo
es el total pagable cuando `incluye_iva=true`**; cuando `incluye_iva=false`
ese campo es el SUBTOTAL sin IVA. Cinco lugares del código sumaban
`orden_compra_items.importe` crudo (`SUM(importe)`) asumiendo que ya era el
total con IVA, y lo comparaban directo contra `pagos.monto` — para OC con
`incluye_iva=false` eso comparaba subtotal contra pago-con-IVA, dando
saldos negativos o pendientes subestimados.

### Fix: función compartida `totalConIvaDeItems()`

Nueva función en `server/calculos.js` (exportada junto a las demás), misma
fórmula exacta que `computeIvaBreakdown()` (que vive en `server/app.js` y no
se tocó) pero ubicada en `calculos.js` para que `server/finanzas.js` también
pueda usarla sin crear una dependencia circular con `app.js`:

```js
function totalConIvaDeItems(items, incluyeIva) {
  let subtotal = 0;
  let iva = 0;
  for (const it of items) {
    const importe = Number(it.importe) || 0;
    const tasa = Number(it.iva_tasa) / 100;
    if (incluyeIva) {
      const sub = importe / (1 + tasa);
      subtotal += sub;
      iva += importe - sub;
    } else {
      subtotal += importe;
      iva += importe * tasa;
    }
  }
  return Number((subtotal + iva).toFixed(2));
}
```

`items` es `[{ importe, iva_tasa }, ...]` — se obtiene con un JOIN
`orden_compra_items → requisicion_items → insumos` (para traer `iva_tasa`),
no de un `SUM()` en SQL, porque ahora el cálculo con/sin IVA debe hacerse en
JS ítem por ítem (acumulando subtotal/IVA sin redondear por ítem, redondeo
una sola vez al final, igual que `computeIvaBreakdown()`, para no cambiar el
resultado en el caso `incluye_iva=true`, que es puro régimen de no-regresión).

### Los 5 lugares corregidos (mapeados a los 5 endpoints que el test cubre)

1. **`saldoDeOrden()`** (`server/app.js`) — usado por `GET
   /api/projects/:id/ordenes/:ocId/pagos`. Antes: `SELECT COALESCE(SUM(importe),0)`.
   Después: trae items crudos + `oc.incluye_iva`, pasa por
   `totalConIvaDeItems()`.
2. **`getOrdenesData()`** (`server/app.js`) — usado por `GET
   /api/projects/:id/ordenes` (listado). Mismo patrón: antes `SUM(importe)`
   crudo por OC, después items crudos + `totalConIvaDeItems(items, o.incluye_iva)`.
3. **`getFinanzasResumenData()`**, cálculo de `comprasComprometido`
   (`server/finanzas.js`) — usado por `GET /api/projects/:id/finanzas/resumen`
   (campo `erogado_real.compras_comprometido_con_iva`). Antes agrupaba con
   `GROUP BY oc.id` y `SUM(oci.importe)` en SQL; después trae filas crudas,
   agrupa en JS por OC (`Map`) y aplica `totalConIvaDeItems()` por OC antes
   de sumar el comprometido total.
4. **`fetchOrdenesComprometiblesPorObra()`** (`server/finanzas.js`) — usado
   por `GET /api/projects/:id/finanzas/compromisos-abiertos` (vista
   "Compromisos Abiertos") **y también** por `GET /api/dashboard-ejecutivo`
   (Dashboard Ejecutivo multi-obra), que reusa la misma función — por eso
   son 5 endpoints de prueba con solo 4 ubicaciones de código. Antes
   agrupaba con `GROUP BY` (por OC + categoría) y `SUM()` en SQL; después
   agrupa en JS por `oc_id|categoria` y aplica `totalConIvaDeItems()` por
   grupo.
5. (Ver punto 4 — mismo código, segundo endpoint consumidor: Dashboard
   Ejecutivo.)

Archivos tocados: `server/app.js` (2 funciones), `server/calculos.js`
(función nueva `totalConIvaDeItems` + export), `server/finanzas.js` (2
funciones), `public/sw.js` (bump de versión), y
`tests/fix-saldo-iva-5-lugares.test.js` (suite nueva, integración contra DB
real, cubre los 3 casos: `incluye_iva=false` pagada completa → saldo
exacto $0.00, `incluye_iva=false` pago parcial → saldo refleja el IVA
pendiente, y `incluye_iva=true` como regresión — no debe cambiar).

### Clasificación para la demo

**(b) Portar adaptado.** El bug depende de que la demo tenga: (1) el campo
`ordenes_compra.incluye_iva`, (2) `insumos.iva_tasa` per-ítem, y (3) que
existan OC reales con `incluye_iva=false` para poder reproducirlo. Si la
demo ya tiene ese mismo modelo de datos (probable, dado que es fork de
App-CP), el fix es el mismo: crear `totalConIvaDeItems()` en
`server/calculos.js` y aplicarlo en los mismos 4 sitios de código. Si la
demo no reproduce el bug con datos de ejemplo `incluye_iva=false`, no hay
nada que verificar visualmente pero el fix sigue siendo correcto aplicarlo
por consistencia de cálculo.

### Dependencias

Ninguna con otros PRs de este módulo. Es prerequisito conceptual (no de
código) de los cambios de cierre mensual (#217/#218): la columna "Monto"
en la vista de Pagos de OC y el export usan `pagos.monto` directo (no
`totalConIvaDeItems`), así que no hay dependencia real de código.

---

## PR #202 — feat(auth): agregar un usuario admin nuevo a whitelists de Control de Cuentas/Financiero/Estado de Resultados

**Fecha**: 2026-09-02 (merge commit `1928f187a5dd8a750adf628fb301c5691223ac1d`, 1 commit: `ec9239b`)

> ⚠️ Nota de anonimización: el PR real agrega a un usuario específico de
> producción (nombre real + id numérico real) a las 3 whitelists. Nombre e
> id se reemplazaron abajo por placeholders genéricos ("Usuario Nuevo A",
> `id=Z`) — igual que los ids preexistentes en las listas (`id=X`, `id=Y`).
> Ninguno de estos valores es real ni debe copiarse como tal a la demo.

### Qué problema resolvía

Un usuario nuevo ("Usuario Nuevo A", `id=Z`, rol admin) necesitaba acceso
total a tres módulos financieros gateados por whitelist hardcodeada de IDs
de usuario (sin UI de gestión, por diseño — ver comentario en el propio
código): Control de Cuentas, Control Financiero, y Estado de Resultados.

### Diseño / causa raíz

No es un bug — es una decisión consultada de mantener estos 3 candados
como **constantes independientes hardcodeadas en `server/auth.js`**, cada
una con su propio array de IDs, precisamente para que cambiar una no
implique cambiar las otras (documentado explícitamente en los comentarios
de cada constante: "que cambien juntos hoy no debe implicar que evolucionen
acopladas mañana"). Agregar un usuario nuevo es, por diseño, editar código
+ nuevo commit, no una operación de UI.

### Archivos y funciones tocadas

`server/auth.js` — tres constantes, cada una pasó de `[X, Y]` a `[X, Y, Z]`
(placeholders genéricos por los ids reales de producción):

- `USUARIOS_CONTROL_CUENTAS` (usada por `requireControlCuentasAccess`) —
  con nota nueva de advertencia: este endpoint devuelve TODAS las cuentas
  sin filtrar por dueño, así que estar en esta lista da visibilidad del
  saldo bancario **personal** de los otros dos usuarios de la lista, no de
  una cuenta propia.
- `USUARIOS_CONTROL_FINANCIERO` (usada por `requireControlFinancieroAccess`).
- `USUARIOS_ESTADO_RESULTADOS` (usada por `requireEstadoResultadosAccess`).

### Clasificación para la demo

**(c) No aplica.** Es un alta de un usuario real específico en whitelists
hardcodeadas de una instancia de producción — no hay "comportamiento" o
"feature" que portar, solo IDs de usuario reales que no existen ni tienen
sentido en la demo. Lo único trasladable como *patrón* (no como cambio) es
el propio mecanismo de whitelist-por-constante-independiente, que ya
debería existir de antes en la demo si es fork de App-CP.

### Dependencias

Ninguna.

---

## PR #204 — feat(backup): backup diario de Neon a Vercel Blob con retención de 2 niveles

**Fecha**: 2026-09-02 (merge commit `1a66f366de8069ca50232a9ce92b328703cce6ac`; incluye commits de desarrollo con pruebas temporales sobre Blob real, revertidas en el mismo PR antes de mergear — el diff final ya no las incluye)

### Qué problema resolvía

Antes de este PR ya existía un backup lógico semanal (`pg_dump` → Vercel
Blob) con retención plana de 8 copias. Con los módulos financieros activos
(Control de Cuentas, Control Financiero) en producción, una ventana de
pérdida de datos de hasta una semana completa dejó de ser aceptable.

### Diseño

Documentado en detalle en `CLAUDE.md` del repo (sección "Backup diario de
Neon a Vercel Blob") — resumen de los puntos verificados contra el diff real:

- **Cadencia**: diaria, 09:00 UTC, vía GitHub Actions (`.github/workflows/backup-neon.yml`),
  no Vercel Cron — `pg_dump` no existe en el runtime serverless de Vercel.
  También disponible manualmente vía `workflow_dispatch`.
- **Versión de Postgres**: Neon corre Postgres 18; el runner de
  `ubuntu-latest` trae preinstalado un `pg_dump` 16.x en el PATH que
  rechaza conectarse a un servidor 18 ("server version mismatch"), y
  aunque se instale `postgresql-client-18` vía el repo oficial de PGDG, el
  `pg_dump` viejo sigue resolviendo primero por PATH — hay que invocar el
  binario nuevo por **ruta explícita** (`/usr/lib/postgresql/18/bin/pg_dump`).
- **Conexión DIRECTA, nunca pooled**: secret `NEON_PRODUCTION_DATABASE_URL_DIRECT`
  (sin `-pooler` en el host) — confirmado empíricamente que correr
  `pg_dump` contra el endpoint pooled deja `search_path` roto en otras
  conexiones nuevas que reusan el mismo backend físico del pooler durante
  varios minutos.
- **Salvaguarda de archivo vacío**: si `pg_dump` falla en silencio y el
  pipe a `gzip` igual produce un archivo de 0 bytes, se aborta antes de
  subir nada ("El archivo de backup está vacío (0 bytes)... Abortando sin
  subir").
- **Retención de 2 niveles**, función `clasificarBackups()` en
  `scripts/backup-neon-to-blob.js`: conserva los últimos 30 backups diarios
  MÁS un representante "mensual" (el backup más antiguo disponible de cada
  mes calendario) por cada uno de los últimos 12 meses.
- **Dos salvaguardas duras en `rotarBackupsViejos()`** antes de borrar: (1)
  si algún blob bajo `backups/` no calza con el patrón de nombre esperado
  `backup-YYYY-MM-DD.sql.gz`, se aborta TODO el borrado del ciclo sin tocar
  nada; (2) si la clasificación no marca ningún backup para conservar (no
  debería ser posible — el recién subido siempre cae en la ventana diaria),
  también se aborta sin borrar. Ambas cubiertas por
  `tests/backup-rotacion.test.js` (117 líneas, tests unitarios puros sobre
  `clasificarBackups()`, sin tocar Blob real).
- **Notificación de fallo**: `scripts/notificar-fallo-backup.js`, corre
  `if: failure()` al final del workflow, inserta notificación in-app para
  usuarios `admin`/`desarrollador` (mismo mecanismo genérico de
  notificaciones de la app).

### Archivos tocados

`.github/workflows/backup-neon.yml` (workflow completo), `CLAUDE.md`
(documentación), `scripts/backup-neon-to-blob.js` (lógica de rotación,
+157 líneas netas), `scripts/notificar-fallo-backup.js` (ajuste menor),
`tests/backup-rotacion.test.js` (suite nueva), `public/sw.js` (bump).

### Clasificación para la demo

**(c) No aplica, confirmado (no solo por la nota inicial).** Es
infraestructura real contra Neon de producción y Vercel Blob de producción
de App-CP — secrets (`NEON_PRODUCTION_DATABASE_URL_DIRECT`,
`BLOB_READ_WRITE_TOKEN`) y GitHub Actions del repo real, sin nada
específico de la lógica de negocio del control presupuestario. Si
App-CP-Demo tiene su propia infraestructura Neon/Blob separada y se quisiera
un backup equivalente, el *patrón* (workflow de GitHub Actions +
`clasificarBackups()` con su lógica de retención + salvaguardas) es
reutilizable casi tal cual, pero requeriría secrets y branches de Neon
propios de la demo — no es un "portar el PR", es replicar la infraestructura
desde cero apuntando a los recursos de la demo.

### Dependencias

Ninguna hacia atrás. #222 depende directamente de este PR (fix sobre el
mismo mecanismo).

---

## PR #216 — feat(contabilidad): vincular CFDI (factura) a un pago de OC

**Fecha**: 2026-09-04 (merge commit `ede4dce264ae585179d62c31c6a9308fc421dcd2`, 1 commit: `611f235`)

### Qué problema resolvía

Cero conexión entre el repositorio de CFDI (facturas fiscales, Contabilidad
Fase 2) y los pagos de Órdenes de Compra (Compras/Tesorería) — no había
forma de saber, ni desde Compras ni desde Contabilidad, si un pago ya tenía
su factura correspondiente subida al repositorio.

### Diseño

Existe diagnóstico y diseño previo en
`docs/fase0-vinculacion-factura-pago-oc-contabilidad.md` (Fase 0, solo
diseño, sin código) que este PR implementa. **Verificado contra el diff
real que el PR fue MÁS ALLÁ de lo que Fase 0 llamaba "Fase 1"**: además del
campo y el endpoint de vínculo, ya incluye una vista de listado con filtros
(el diseño la ponía en Fase 2, ver PR #217 abajo) — solo faltó de Fase 2 el
resumen del mes y la 5ª hoja del export, que sí llegaron en #217.

Piezas implementadas (verificado en el diff, coincide con el diseño en lo
estructural):

1. **`pagos.cfdi_id`** — FK simple (no tabla puente), `ON DELETE SET NULL`:

   ```sql
   ALTER TABLE pagos ADD COLUMN IF NOT EXISTS cfdi_id INTEGER REFERENCES cfdi(id) ON DELETE SET NULL;
   CREATE INDEX IF NOT EXISTS idx_pagos_cfdi ON pagos(cfdi_id);
   ```

   Decisión de diseño explícita: 1 pago → 0 o 1 CFDI. Si en el futuro
   aparecen casos reales de una factura repartida en varios pagos
   (anticipo + liquidación), se documentó que agregar una tabla puente
   después es un cambio aislado.

2. **Endpoints nuevos** (`server/app.js`), ambos gateados por
   `auth.requireContabilidadAccess` (**deliberadamente NO se amplía acceso
   a compras/tesorería** — el vínculo se hace desde Contabilidad, no desde
   el momento de pagar):
   - `GET /api/contabilidad/pagos` — lista pagos de OC con JOIN a
     `ordenes_compra → proveedores`, LEFT JOIN a `cfdi`; filtros
     `project_id` y `con_factura=si|no`; límite 200 filas.
   - `PATCH /api/contabilidad/pagos/:pagoId/cfdi` — body `{ cfdi_id }`
     (o `null` para desvincular); valida que el pago y el CFDI existan.

3. **`POST /api/contabilidad/cfdi/confirm` extendido** con `pago_id`
   opcional: permite subir un CFDI nuevo y dejarlo vinculado al pago en el
   mismo paso (envuelto en `db.withTransaction`, valida el `pago_id` antes
   del INSERT para no crear un CFDI huérfano si viene mal).

4. **Frontend** (`public/app.js`): nuevo tab `contabilidadPagos` ("Pagos de
   OC") en `CONTABILIDAD_TABS` (server y cliente, `server/auth.js` y
   `public/app.js`) — visible solo para quien ya tiene acceso a
   Contabilidad. `renderContabilidadPagos()`: tabla con filtros de obra y
   estado de factura, badge verde "✓ {uuid corto}" o amarillo "Sin
   factura", botón "Vincular factura"/"Cambiar" por fila.
   `openVincularFacturaModal()`: busca CFDI candidatos por
   `GET /api/contabilidad/cfdi?rfc_emisor={proveedor.rfc}` (endpoint ya
   existente, sin cambios — el cruce automático por RFC ya era viable sin
   tocar esquema), permite elegir uno con un clic, desvincular, o abrir
   "Subir CFDI nuevo" reusando el modal existente de Fase 2 con `pagoId`
   encadenado.

### Archivos y funciones tocadas

`server/db.js` (ALTER TABLE + índice), `server/auth.js` (`CONTABILIDAD_TABS`
+1 tab), `server/app.js` (`POST /cfdi/confirm` extendido, 2 endpoints
nuevos `/api/contabilidad/pagos` y `/api/contabilidad/pagos/:pagoId/cfdi`),
`public/app.js` (`renderContabilidadPagos`, `openVincularFacturaModal`,
`openNuevoCfdiContModal`/`openCfdiConfirmModal` extendidos con `pagoId`),
`public/sw.js` (bump).

### Clasificación para la demo

**(b) Portar adaptado.** El diseño y el flujo son 100% de lógica de
negocio (nada de infraestructura real de producción) y perfectamente
aplicables a la demo **si** ésta ya tiene el repositorio de CFDI
(Contabilidad Fase 2, tabla `cfdi`) y el módulo de pagos de OC — ambos
prerequisitos que no son parte de esta ventana de 20 días (son
preexistentes). Si la demo no tiene el repositorio CFDI, este PR no se
puede portar de forma aislada.

### Dependencias

Depende de infraestructura preexistente (Contabilidad Fase 2 — repositorio
CFDI, y Fase 5 — export mensual, ambas de antes de esta ventana, no
cubiertas en este changelog). #217 depende de este PR (extiende
`GET /api/contabilidad/pagos` y usa `pagos.cfdi_id`).

---

## PR #217 — feat(contabilidad): vista de cierre mensual de Pagos de OC + 5ª hoja en export

**Fecha**: 2026-09-04 (merge commit `137de2431aac91dca0996431a0240be1d636dbc4`, 1 commit: `e8ff8f4`, mergea la rama `feature/fase2-cierre-mensual-pagos-oc` sobre #216 ya mergeado)

### Qué problema resolvía

La vista de "Pagos de OC" introducida en #216 no filtraba por mes ni daba
un resumen agregado — para cuadrar el cierre mensual, Paul tenía que sumar
manualmente. Tampoco existía la información de pagos/factura en el export
Excel consolidado de Contabilidad (Fase 5), que solo tenía 4 hojas.

### Diseño

Completa lo que el documento de Fase 0 llamaba "Fase 2" (la parte que #216
no alcanzó a cubrir):

1. **Filtro por mes en `GET /api/contabilidad/pagos`**: nuevo query param
   `mes` (formato `YYYY-MM`, validado con `MES_YYYY_MM_RE`), usa
   `contabilidad.limitesMes(mes)` (función ya existente, ahora exportada)
   para acotar `p.fecha >= inicio AND p.fecha < fin`.
2. **5ª hoja "Pagos OC" en el export mensual** (`GET /api/contabilidad/export`,
   `server/contabilidad.js` función `getDatosExportacionMes`): se agrega
   una query de pagos del mes (mismo JOIN que el endpoint de arriba,
   filtrado por `limitesMes`) al objeto que ya retornaba `{ polizas, cfdi,
   movimientos, depreciacion }` → ahora incluye `pagos`. El chequeo de
   "sin datos → 400" se extiende para considerar también `pagos.length`.
   Columnas de la hoja: Fecha, OC, Obra, Proveedor, Monto, Folio Fiscal
   (CFDI), Estado ("Con factura"/"Sin factura").
3. **Frontend — resumen del mes**: input `<input type="month">` en la
   vista `renderContabilidadPagos`; al elegir mes, calcula y muestra 3 KPIs
   (Total pagado, Con factura vinculada, Falta vincular) — **calculados
   siempre sobre TODOS los pagos del mes, no sobre el resultado ya filtrado
   por el select de "Factura"**, para que el total del cierre no varíe
   según qué esté mirando el usuario en ese momento.
4. **Resalte visual**: clase CSS `.row-sin-factura` (fondo amarillo tenue)
   en las filas de la tabla sin CFDI vinculado.

### Archivos y funciones tocadas

`server/app.js` (`GET /api/contabilidad/pagos` +param `mes`, mensaje de
error del export +"pagos"), `server/contabilidad.js` (`getDatosExportacionMes`
+query de pagos del mes, +export de `limitesMes`), `public/app.js`
(`renderContabilidadPagos` +input de mes +bloque de resumen KPI),
`public/styles.css` (`.row-sin-factura`), `public/sw.js` (bump).

### Clasificación para la demo

**(b) Portar adaptado**, mismo prerequisito que #216 (repositorio CFDI +
export Fase 5 preexistentes en la demo). Si #216 ya se portó, este PR es
una extensión natural y de bajo riesgo sobre el mismo endpoint/vista.

### Dependencias

Depende directamente de #216 (mismo endpoint `/api/contabilidad/pagos`,
mismo campo `pagos.cfdi_id`, misma vista frontend que extiende).

---

## PR #218 — feat(contabilidad): re-merge de `feature/fase2-cierre-mensual-pagos-oc` (sin cambios funcionales nuevos de cierre mensual)

**Fecha**: 2026-09-06 (merge commit `c15a21ccc4b80a54b165762dd6620e9c7a585da1`)

### Qué es este merge realmente

Verificado con `git log --oneline <217>^1..<217>^2` vs `git log --oneline
<218>^1..<218>^2`: la rama `feature/fase2-cierre-mensual-pagos-oc` se
mergeó primero como #217, y **después** se le agregó un commit adicional
(`ea52371`) antes de volver a mergearse como #218. El diff incremental
entre el tip de #217 (`e8ff8f4`) y el segundo padre de #218 (`ea52371`) es
exactamente **un solo commit**, y el diff completo entre el primer padre de
#218 (`137de2431`, que ya incluye todo #217) y el merge `c15a21c` toca
únicamente `public/app.js` (+5 líneas), `public/styles.css` (+30 líneas) y
`public/sw.js` (bump) — cero archivos de `server/contabilidad.js` o lógica
de cierre mensual.

**⚠️ Este merge también incluye un commit no relacionado al tema de este
módulo** — `ea52371 feat(apariencia): agregar quinta paleta Tema ZAFIRO
(Azul, #2563EB)` — que se coló en la misma rama antes de mergear, sin
relación con cierre mensual de pagos de OC. Ese commit está documentado en
el módulo **Visual/UX/Infra** (`09-visual-ux-infra-cache.md`), no aquí.

### Para el módulo Financiero, la conclusión es

**#218 no aporta nada nuevo a "Financiero: CFDI/Cierre Mensual" más allá de
lo ya documentado en #217.** No hay elementos 1-7 adicionales que
documentar para este PR en este módulo — su única función a efectos de
`main` fue traer main al día dentro de la rama antes del re-merge, y de
paso arrastrar el commit de Zafiro.

### Clasificación para la demo

No aplica clasificación propia — ver #217 para la parte de cierre mensual,
y el módulo Visual/UX/Infra para la paleta Zafiro.

### Dependencias

Es el mismo trabajo que #217 (misma rama). No introduce dependencias
nuevas para este módulo.

---

## PR #222 — fix(ci): notificación de fallo de backup solo en cron real (schedule+main)

**Fecha**: 2026-09-06 (merge commit `3d64bce65d696073dc5446b996516ec17c5d09ad`; 3 commits: `4a524d5` fix real, `1f75821` job temporal de prueba en Actions real, `07dd500` remoción del job temporal tras confirmar — los dos últimos son de desarrollo/verificación, no cambian el comportamiento final)

### Qué problema resolvía

**Incidente real** (2026-09-02, durante el desarrollo de #204): una prueba
manual (`workflow_dispatch`) del workflow de backup, corrida desde la rama
`feat/backup-diario` (no `main`), falló por otra razón y disparó el paso de
notificación de fallo — que insertó notificaciones de "falló el backup" en
la app real, visibles para los 6 usuarios admin/desarrollador reales, sin
que el backup diario real de producción hubiera fallado.

### Causa raíz

El secret `NEON_PRODUCTION_DATABASE_URL_DIRECT` (y el paso de notificación
que lo usa) es un secret de repo, **no restringido a la rama `main` ni al
trigger `schedule`** — cualquier `workflow_dispatch` manual desde cualquier
rama (útil para probar el workflow durante desarrollo) comparte la misma
tabla de notificaciones in-app que ve el equipo real.

### Fix

Un solo condicional agregado al `if:` del paso de notificación en
`.github/workflows/backup-neon.yml`:

```diff
       - name: Avisar a admin/desarrollador si algo falló
-        if: failure()
+        if: failure() && github.event_name == 'schedule' && github.ref == 'refs/heads/main'
```

El fallo del run **sigue siendo visible** en el log de GitHub Actions para
cualquier trigger/rama (eso no se toca) — el cambio solo restringe a quién
se le avisa dentro de la app, para que solo el cron real (diario, sobre
`main`) pueda generar esas notificaciones.

### Archivos tocados

`.github/workflows/backup-neon.yml` (1 línea de condición).

### Clasificación para la demo

**(c) No aplica, confirmado.** Depende directamente de la infraestructura
de #204 (mismo workflow, mismo secret de Neon de producción) — si #204 no
aplica a la demo, este fix tampoco tiene objeto. Si la demo alguna vez
replica un backup real propio con un workflow equivalente, vale la pena
aplicar la misma restricción `github.event_name == 'schedule' &&
github.ref == 'refs/heads/main'` desde el inicio para evitar el mismo
incidente.

### Dependencias

Depende directamente de #204 (fix sobre el mismo mecanismo/workflow).
