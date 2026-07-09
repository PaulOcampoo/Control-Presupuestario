# Auditoría de Seguridad — Control Presupuestal de Obra
**Fecha:** 2026-07-09  
**Tipo:** Solo diagnóstico — ningún archivo fue modificado  
**Archivos auditados:** `server/app.js`, `server/auth.js`, `server/db.js`, `public/app.js`, `public/sw.js`

---

## ⚠️ HALLAZGOS DE RIESGO ALTO (acción prioritaria)

### ALTO-1 — IDOR: DELETE pagos no verifica que la OC pertenece al proyecto
**Endpoint:** `DELETE /api/projects/:id/ordenes/:ocId/pagos/:pagoId`  
**Ubicación:** `server/app.js` (sección pagos, leída antes del resumen de contexto)

La cadena de middleware verifica que el usuario tiene acceso al proyecto `:id` (vía `verificarAccesoObra`), pero la query de eliminación solo verifica que `pagoId` pertenece a `ocId`:
```sql
DELETE FROM pagos WHERE id = $1 AND orden_compra_id = $2
```
`ocId` **nunca** se valida contra `req.project.id`. Un admin con acceso al proyecto A puede:
1. Poner el `:id` de su proyecto A (pasa `verificarAccesoObra`).
2. Poner cualquier `:ocId` de otro proyecto B.
3. Borrar pagos de una OC que no le pertenece.

**Impacto:** Eliminación no autorizada de datos financieros de otro proyecto.

---

### ALTO-2 — IDOR: PUT avances conceptos no verifica que los `concepto_id` son del proyecto
**Endpoint:** `PUT /api/projects/:id/avances/:semana/conceptos`  
**Ubicación:** `server/app.js` (sección avances semanales)

El endpoint acepta un array de items con `concepto_id`. Verifica acceso al proyecto vía `verificarAccesoObra`, pero los `concepto_id` del payload **no** se validan contra `project_id`. Un atacante puede registrar avance para conceptos presupuestales de otro proyecto, generando contaminación de datos de avance entre obras.

**Impacto:** Escritura no autorizada en avances de otro proyecto.

---

### ALTO-3 — npm: multer vulnerable a DoS (2 CVEs)
**Paquete:** multer 1.0.0 - 2.1.1  
Detalle completo en la Sección 7.

---

## 1. Tabla IDOR — Endpoints con parámetros de ID

### Autenticación global
`app.use('/api', auth.requireAuth)` en `server/app.js:253`. Todos los endpoints `/api/*` definidos después de esa línea requieren JWT válido no revocado. Las rutas de login y cron (líneas < 253) quedan fuera del middleware global y usan sus propios mecanismos.

### Tabla completa

| Endpoint | Requiere sesión válida | Verifica pertenencia al proyecto | Verifica rol/permiso | Riesgo |
|---|---|---|---|---|
| `POST /api/auth/login` | No (público) | N/A | N/A | Bajo |
| `GET /api/cron/recordatorio-impuestos` | No (CRON_SECRET) | N/A | CRON_SECRET | Bajo |
| `POST /api/cron/alertas-vencimiento` | No (CRON_SECRET) | N/A | CRON_SECRET | Bajo |
| `PUT /api/users/:id` | Sí | N/A (sin proyecto) | Admin+dev | Bajo |
| `DELETE /api/users/:id` | Sí | N/A | Admin+dev | Bajo |
| `POST /api/users/:id/reset-token` | Sí | N/A | Admin+dev | Bajo |
| `PUT /api/clientes/:id` | Sí | N/A | Admin+dev | Bajo |
| `DELETE /api/clientes/:id` | Sí | N/A | Admin+dev | Bajo |
| `PATCH /api/notificaciones/:id` | Sí | N/A (scoped a `usuario_id = req.user.id`) | Propio usuario | Bajo |
| `PATCH /api/sugerencias/:id` | Sí | N/A | Admin+dev | Bajo |
| `POST /api/sugerencias/:id/imagenes` | Sí | Verifica autoría o admin | Autor o admin+dev | Bajo |
| `POST /api/sugerencias/:id/generar-prompt` | Sí | N/A | Admin+dev | Bajo |
| `GET /api/projects/:id` | Sí | Sí — `verificarAccesoObra` | Residente+ | Bajo |
| `PUT /api/projects/:id` | Sí | Sí — `verificarAccesoObra` | Admin+dev | Bajo |
| `DELETE /api/projects/:id` | Sí | Sí — admin only en práctica | Admin+dev | Bajo |
| `POST /api/projects/:id/contrato` | Sí | Sí | Admin+dev | Bajo |
| `GET /api/projects/:id/contrato` | Sí | Sí | Residente+ | Bajo |
| `GET /api/projects/:id/impuestos` | Sí | Sí | Residente+ | Bajo |
| `PUT /api/projects/:id/impuestos` | Sí | Sí | Admin+dev | Bajo |
| `PUT /api/projects/:id/conceptos/:cId` | Sí | Sí — `WHERE id=$1 AND project_id=$2` | Admin+dev | Bajo |
| `DELETE /api/projects/:id/conceptos/:cId` | Sí | Sí | Admin+dev | Bajo |
| **`GET /api/conceptos/:id/insumos`** | Sí | **No** — sin `verificarAccesoObra` | Admin+dev | **Medio** |
| **`POST /api/conceptos/:id/insumos`** | Sí | **No** — sin `verificarAccesoObra` | Admin+dev | **Medio** |
| **`DELETE /api/conceptos/:id/insumos/:insumoId`** | Sí | **No** — sin `verificarAccesoObra` | Admin+dev | **Medio** |
| `PUT /api/projects/:id/insumos/:insumoId` | Sí | Sí | Admin+dev | Bajo |
| `DELETE /api/projects/:id/insumos/:insumoId` | Sí | Sí | Admin+dev | Bajo |
| `GET /api/projects/:id/requisiciones/:reqId` | Sí | Sí | Residente+ | Bajo |
| `DELETE /api/projects/:id/requisiciones/:reqId` | Sí | Sí | Admin+dev | Bajo |
| `GET /api/projects/:id/ordenes/:ocId` | Sí | Sí | Residente+ | Bajo |
| `PUT /api/projects/:id/ordenes/:ocId` | Sí | Sí | Admin+dev | Bajo |
| `DELETE /api/projects/:id/ordenes/:ocId` | Sí | Sí | Admin+dev | Bajo |
| `GET /api/projects/:id/ordenes/:ocId/export` | Sí | Sí | Admin+dev | Bajo |
| `GET /api/projects/:id/ordenes/:ocId/recepciones/:recId` | Sí | Sí | Admin+dev | Bajo |
| **`POST /api/projects/:id/ordenes/:ocId/recepciones`** | Sí | **Dudoso** — `ocId` posiblemente no validado contra `project_id` | Residente+ | **Medio** |
| `GET /api/projects/:id/ordenes/:ocId/pagos` | Sí | Sí | Residente+ | Bajo |
| **`POST /api/projects/:id/ordenes/:ocId/pagos`** | Sí | **Dudoso** — `ocId` posiblemente no validado | Residente+ | **Medio** |
| **`DELETE /api/projects/:id/ordenes/:ocId/pagos/:pagoId`** | Sí | **No** — `ocId` sin verificar contra `project_id` | Admin+dev | **ALTO** |
| `PUT /api/projects/:id/gastos/:gId` | Sí | Sí | Admin+dev | Bajo |
| `DELETE /api/projects/:id/gastos/:gId` | Sí | Sí | Admin+dev | Bajo |
| `PUT /api/projects/:id/finanzas/:fId` | Sí | Sí | Admin+dev | Bajo |
| `DELETE /api/projects/:id/finanzas/:fId` | Sí | Sí | Admin+dev | Bajo |
| `GET /api/projects/:id/avances/:semana` | Sí | Sí | Residente+ | Bajo |
| **`PUT /api/projects/:id/avances/:semana/conceptos`** | Sí | **No** — `concepto_id` del payload no verificados | Residente+ | **ALTO** |
| `GET /api/projects/:id/destajistas/:dId` | Sí | Sí | Residente+ | Bajo |
| `PUT /api/projects/:id/destajistas/:dId` | Sí | Sí | Admin+dev | Bajo |
| `DELETE /api/projects/:id/destajistas/:dId` | Sí | Sí | Admin+dev | Bajo |
| `GET /api/projects/:id/destajistas/:dId/export` | Sí | Sí | Admin+dev | Bajo |
| `POST /api/projects/:id/destajistas/:dId/precios-masivos` | Sí | Sí | Admin+dev | Bajo |
| `GET /api/projects/:id/destajistas/:dId/avances` | Sí | Sí | Residente+ | Bajo |
| `PUT /api/projects/:id/trabajadores/:wId` | Sí | Sí — `WHERE id=$1 AND project_id=$2` | Admin+dev | Bajo |
| `POST /api/projects/:id/trabajadores/:wId/baja` | Sí | Sí — `WHERE id=$3 AND project_id=$4` | Admin+dev | Bajo |
| **`GET /api/projects/:id/trabajadores/:wId/bajas`** | Sí | **No** — `WHERE trabajador_id=$1` sin join a `project_id` | Admin+dev | **Medio** |
| `POST /api/projects/:id/trabajadores/:wId/reactivar` | Sí | Sí — `WHERE id=$1 AND project_id=$2` | Admin+dev | Bajo |
| `DELETE /api/projects/:id/trabajadores/:wId` | Sí | Sí — `WHERE id=$1 AND project_id=$2` | Admin+dev | Bajo |
| `POST /api/projects/:id/trabajadores/:wId/documentos/upload-token` | Sí | Sí — `WHERE id=$1 AND project_id=$2` | Admin+dev | Bajo |
| `POST /api/projects/:id/trabajadores/:wId/documentos` | Sí | Sí — `WHERE id=$1 AND project_id=$2` | Admin+dev | Bajo |
| **`GET /api/projects/:id/trabajadores/:wId/documentos`** | Sí | **No** — `WHERE trabajador_id=$1` sin join a `project_id` | Admin+dev | **Medio** |
| `GET /api/projects/:id/trabajadores/:wId/documentos/:docId/download` | Sí | Sí — JOIN verifica `t.project_id=$3` | Residente+ | Bajo |
| `DELETE /api/projects/:id/trabajadores/:wId/documentos/:docId` | Sí | Sí — JOIN verifica `t.project_id=$3` | Admin+dev | Bajo |
| `POST /api/projects/:id/trabajadores/:wId/contratos/upload-token` | Sí | Sí — `WHERE id=$1 AND project_id=$2` | Admin+dev | Bajo |
| `POST /api/projects/:id/trabajadores/:wId/contratos` | Sí | Sí — `WHERE id=$1 AND project_id=$2` | Admin+dev | Bajo |
| **`GET /api/projects/:id/trabajadores/:wId/contratos`** | Sí | **No** — `WHERE trabajador_id=$1` sin join a `project_id` | Residente+ | **Medio** |
| `GET /api/projects/:id/trabajadores/:wId/contratos/:cId/download` | Sí | Sí — JOIN verifica `t.project_id=$3` | Residente+ | Bajo |
| `GET /api/projects/:id/epp-catalogo` | Sí | Sí — `WHERE project_id=$1` | Residente+ | Bajo |
| `POST /api/projects/:id/epp-catalogo` | Sí | Sí | Admin+dev | Bajo |
| `PUT /api/projects/:id/epp-catalogo/:itemId` | Sí | Sí — `WHERE id=$4 AND project_id=$5` | Admin+dev | Bajo |
| **`GET /api/projects/:id/trabajadores/:wId/epp-entregas`** | Sí | **No** — `WHERE trabajador_id=$1` sin join a `project_id` | Residente+ | **Medio** |
| `POST /api/projects/:id/trabajadores/:wId/epp-entregas` | Sí | Sí — verifica worker Y item contra `project_id` | Residente+ | Bajo |
| `GET /api/projects/:id/asistencia` | Sí | Sí — `WHERE t.project_id=$1 AND a.project_id=$1` | Residente+ | Bajo |
| **`PUT /api/projects/:id/asistencia`** | Sí | **Parcial** — `project_id` del proyecto es correcto, pero los `trabajador_id` del array no se verifican contra el proyecto | Residente+ | **Medio** |
| `GET /api/projects/:id/nominas/:nomId` | Sí | Sí — `WHERE id=$1 AND project_id=$2` | Residente+ | Bajo |
| `POST /api/projects/:id/nominas/:nomId/calcular` | Sí | Sí — `WHERE id=$1 AND project_id=$2` | Residente+ | Bajo |
| `PUT /api/projects/:id/nominas/:nomId/estado` | Sí | Sí — `WHERE id=$1 AND project_id=$2` | Residente+ | Bajo |
| `DELETE /api/projects/:id/nominas/:nomId` | Sí | Sí — SELECT gatekeep con `project_id`, luego DELETE por `id` | Admin+dev | Bajo |
| `GET /api/projects/:id/nominas/:nomId/export` | Sí | Sí — `WHERE id=$1 AND project_id=$2` | Admin+dev | Bajo |
| `GET /api/admin/dev-info` | Sí | N/A | Solo `desarrollador` | Bajo |

---

## 2. Inyección SQL

**Resultado: Sin vulnerabilidades encontradas.**

Todas las queries revisadas usan placeholders paramétricos (`$1`, `$2`, …). Se detectaron dos patrones de SQL dinámico, ambos seguros:

**a) SQL condicional con strings literales** — `server/app.js` (endpoint GET trabajadores):
```javascript
let sql = `SELECT t.* FROM trabajadores t WHERE t.project_id = $1`;
if (activo === '1') { sql += ' AND t.activo = true'; }
else if (activo === '0') { sql += ' AND t.activo = false'; }
```
Los strings concatenados son literales de código, no input del usuario. ✓

**b) Template literal con ternario** — `server/app.js:3639` (PUT nóminas estado):
```javascript
`UPDATE nominas SET estado=$1, nota_rechazo=$2,
  aprobada_por=${estado === 'aprobada' ? '$4' : 'NULL'},
  aprobada_en=${estado === 'aprobada' ? 'NOW()' : 'NULL'}
WHERE id=$3 RETURNING *`
```
`estado` es input del usuario pero se valida contra `ESTADOS_NOMINA` antes de llegar aquí. Los valores interpolados son los literales `'$4'` o `'NULL'`, no el contenido de `estado`. ✓

---

## 3. Sesión y tokens

| Ítem | Estado |
|---|---|
| TTL del JWT | **30 días** (`server/auth.js:12` — `const TOKEN_TTL = '30d'`) |
| Mecanismo de refresh token | **No existe.** Sesión de vida larga sin renovación. El token expira solo a los 30 días o cuando el usuario hace logout. |
| Revocación de tokens | **Sí** — `token_valid_since` en DB. Se verifica en cada request: `iat * 1000 <= validSinceMs → 401` (`server/auth.js:68`). |
| 2FA en endpoints Admin | **No existe.** Ningún endpoint requiere un segundo factor. |
| Endpoint `/api/auth/me` | Requiere JWT + verifica usuario activo en DB en cada call. ✓ |
| Exposición de rol en token | El JWT contiene `{ id, nombre, usuario, puesto }`. El `puesto` viaja en el payload. Se verifica también en DB en `requireAuth`. Aceptable. |

**Notas:** La sesión de 30 días sin refresh es un riesgo de apropiación de cuenta si el token es comprometido. La revocación vía `token_valid_since` mitiga esto para tokens activos (logout, reset-token). No hay 2FA en ninguna pantalla, incluyendo admin.

---

## 4. Rate limiting más allá de login

| Endpoint costoso | Rate limiting |
|---|---|
| `POST /api/auth/login` | **Sí** — 5 fallos/10 min por usuario, 20 fallos/10 min por IP (`server/app.js:90-110`) |
| `POST /api/projects/:id/contrato` (extracción PDF vía Claude) | **Sí** — rate limiting implementado (referenciado en CLAUDE.md como ya auditado) |
| `POST /api/sugerencias/:id/generar-prompt` (Claude API) | **Sí** — vía tabla `api_rate_limits`, 5/hora por usuario (`server/app.js:3700-3708`) |
| **`GET /api/projects/:id/ordenes/:ocId/export`** (Excel) | **No** |
| **`GET /api/projects/:id/destajistas/:dId/export`** (Excel) | **No** |
| **`GET /api/projects/:id/nominas/:nomId/export`** (Excel) | **No** |
| Búsquedas/GETs de listas grandes | **No** — no hay rate limiting en GETs generales |

Los tres endpoints de export a Excel no tienen rate limiting. Generan múltiples queries a DB y construyen archivos en memoria. Un usuario autenticado podría llamarlos repetidamente para estresar el sistema.

---

## 5. Cabeceras HTTP y CORS

### Cabeceras de seguridad
Configuración manual vía `res.setHeader()` en `server/app.js:30-37`. No se usa Helmet.js.

| Cabecera | Estado |
|---|---|
| `X-Content-Type-Options: nosniff` | **Sí** ✓ |
| `X-Frame-Options: DENY` | **Sí** ✓ |
| `X-XSS-Protection: 1; mode=block` | **Sí** ✓ |
| `Referrer-Policy: strict-origin-when-cross-origin` | **Sí** ✓ |
| `Permissions-Policy: camera=(), microphone=(), geolocation=()` | **Sí** ✓ |
| **`Content-Security-Policy` (CSP)** | **No** — ausente |
| **`Strict-Transport-Security` (HSTS)** | **No** — ausente |

**CSP ausente:** Sin CSP, el navegador ejecutará cualquier script inline o de fuentes externas sin restricción. Riesgo de XSS amplificado si se introduce una vulnerabilidad de inyección de contenido en el futuro.

**HSTS ausente:** Sin HSTS, el navegador podría conectarse por HTTP la primera vez. Vercel sirve todo por HTTPS, pero la cabecera refuerza esto vía `preload` / `max-age`.

### CORS
**No hay configuración CORS** (ni `cors` package, ni headers `Access-Control-Allow-Origin`). Esto es seguro por defecto para una SPA servida desde el mismo dominio: el navegador aplica la política de mismo origen automáticamente. No hay apertura accidental con `Origin: *`.

---

## 6. Manejo de archivos

| Punto | Estado |
|---|---|
| Validación de MIME real (inspección de contenido) | **No** — solo se valida la extensión del nombre de archivo |
| Límite de tamaño server-side | **Sí** — aplicado en cada contexto |

### Detalle por uploader

**multer (sugerencias/imagenes) — `server/app.js:40-47`:**
```javascript
fileFilter: (_req, file, cb) => {
  const ok = /\.(jpe?g|png|gif|webp)$/i.test(file.originalname);
  cb(ok ? null : new Error('...'), ok);
}
```
Límite: 5 MB. Validación: solo extensión. El `mimetype` que se pasa a `put()` de Vercel Blob viene del header `Content-Type` enviado por el cliente (controlado por el atacante), no del contenido real.

**multer (PDFs de contrato) — `server/app.js:51-58`:**
```javascript
fileFilter: (_req, file, cb) => {
  const ok = /\.pdf$/i.test(file.originalname);
  cb(ok ? null : new Error('Solo se admiten archivos .pdf'), ok);
}
```
Límite: 15 MB. Validación: solo extensión `.pdf`.

**Vercel Blob (documentos de identidad, contratos laborales) — vía `handleUpload`:**
```javascript
onBeforeGenerateToken: async (pathname) => {
  const ext = (pathname.split('.').pop() || '').toLowerCase();
  const allowed = ['jpg', 'jpeg', 'png', 'pdf', 'heic', 'webp'];
  if (!allowed.includes(ext)) throw new Error('...');
  return { access: 'private', addRandomSuffix: true, maximumSizeInBytes: 15 * 1024 * 1024 };
}
```
Límite: 15-20 MB según caso. Validación: solo extensión del nombre de ruta.

**Riesgo:** Un atacante puede subir contenido arbitrario con extensión válida. Sin embargo, Vercel Blob es almacenamiento de objetos (no un servidor de ejecución), por lo que los archivos no pueden ejecutarse server-side. El riesgo principal es el almacenamiento de contenido no deseado y la posible entrega de archivos maliciosos a otros usuarios si los acceden desde el blob (bajo para blobs privados, más relevante para blobs públicos de sugerencias).

---

## 7. Dependencias — `npm audit`

Resultado literal (ejecutado 2026-07-09, sin `--fix`):

```
# npm audit report

multer  1.0.0 - 2.1.1
Severity: high
Multer vulnerable to Denial of Service via deeply nested field names - https://github.com/advisories/GHSA-72gw-mp4g-v24j
Multer vulnerable to Denial of Service via incomplete cleanup of aborted uploads - https://github.com/advisories/GHSA-3p4h-7m6x-2hcm
fix available via `npm audit fix`
node_modules/multer

1 high severity vulnerability

To address all issues, run:
  npm audit fix
```

**Uso de multer en la app:** Dos instancias — `uploadImg` para imágenes de sugerencias (`/api/sugerencias/:id/imagenes`) y `uploadPdf` para extracción de contratos PDF. Ambas son endpoints autenticados (JWT requerido desde `app.use('/api', auth.requireAuth)` en línea 253). El DoS requeriría un usuario autenticado o un atacante con token válido.

---

## 8. audit_log

**¿Registra intentos denegados (403/401)?** **No.**

La tabla `audit_log` (referenciada en CLAUDE.md como ya implementada) solo registra acciones exitosas. El middleware `auth.requireAuth` y `auth.allow()` retornan 401/403 directamente sin insertar en `audit_log`. No existe ninguna llamada a `audit_log` en los handlers de error de autenticación/autorización revisados.

**Consecuencia:** No hay trazabilidad de intentos de acceso no autorizado. Si alguien intenta explotar un IDOR o fuerza bruta de endpoints, no queda registro de los intentos fallidos (solo los de login están en `login_attempts`, no el resto de endpoints).

---

## Resumen priorizado por severidad

### ALTO (3 hallazgos)
| # | Hallazgo | Archivo:línea aprox. | Acción recomendada |
|---|---|---|---|
| A1 | IDOR: DELETE pagos — `ocId` sin validar contra proyecto | `server/app.js` (sección pagos) | Añadir `AND orden_compra_id IN (SELECT id FROM ordenes_compra WHERE project_id=$X)` o verificar la OC antes del DELETE |
| A2 | IDOR: PUT avances/conceptos — `concepto_id` del payload sin validar | `server/app.js` (sección avances) | Verificar que cada `concepto_id` pertenece a `req.project.id` antes de procesar |
| A3 | npm: multer DoS (GHSA-72gw-mp4g-v24j, GHSA-3p4h-7m6x-2hcm) | `package.json` | `npm audit fix` para actualizar multer |

### MEDIO (10 hallazgos)
| # | Hallazgo | Archivo:línea aprox. |
|---|---|---|
| M1 | IDOR: GET conceptos/:id/insumos — sin `verificarAccesoObra` | `server/app.js` (sección mapeo) |
| M2 | IDOR: POST conceptos/:id/insumos — sin `verificarAccesoObra` | `server/app.js` (sección mapeo) |
| M3 | IDOR: DELETE conceptos/:id/insumos/:insumoId — sin `verificarAccesoObra` | `server/app.js` (sección mapeo) |
| M4 | IDOR: GET trabajadores/:wId/bajas — wId sin validar vs project_id | `server/app.js:3158-3167` |
| M5 | IDOR: GET trabajadores/:wId/documentos — wId sin validar vs project_id | `server/app.js:3250-3257` |
| M6 | IDOR: GET trabajadores/:wId/contratos — wId sin validar vs project_id | `server/app.js:3334-3343` |
| M7 | IDOR: GET trabajadores/:wId/epp-entregas — wId sin validar vs project_id | `server/app.js:3402-3414` |
| M8 | IDOR: PUT asistencia — trabajador_id del array sin validar vs proyecto | `server/app.js:3455-3483` |
| M9 | IDOR: POST/DELETE ordenes/:ocId/recepciones y POST ordenes/:ocId/pagos — `ocId` posiblemente sin validar | `server/app.js` (sección recepciones/pagos) |
| M10 | Sin rate limiting en exports Excel (3 endpoints) | `server/app.js` (sección ordenes, destajistas, nominas) |

### BAJO (5 hallazgos)
| # | Hallazgo |
|---|---|
| B1 | Sin CSP (`Content-Security-Policy`) |
| B2 | Sin HSTS (`Strict-Transport-Security`) |
| B3 | Validación de archivos solo por extensión (sin inspección de MIME real) |
| B4 | JWT de 30 días sin refresh token — sesión larga si token comprometido |
| B5 | audit_log no registra accesos denegados (401/403) |
| B6 | Sin 2FA en ningún endpoint, incluyendo admin |

---

*Ningún archivo fue modificado. Ninguna query fue ejecutada contra la base de datos de producción.*
