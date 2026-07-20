# Auditoría de encriptación en reposo — App-CP

Fecha: 2026-07-17
Alcance: inventario de campos sensibles en el esquema (`server/db.js`, string `SCHEMA`) y su estado actual (texto plano / hasheado / cifrado). Documento de **diagnóstico únicamente** — no se implementó encriptación nueva en este prompt.

Método: lectura directa de `server/db.js` (definición de tablas) + `server/auth.js` (funciones de hash/cifrado) + `server/app.js` (uso real de Vercel Blob, modo `access`).

## Corrección sobre el alcance original del prompt

El prompt que originó esta auditoría asumía una tabla `contratos` con un campo de **domicilio de contratista**. Ese campo no existe: `contratos` (línea 567 de `server/db.js`) solo almacena metadata del PDF del contrato de obra (`blob_url`, `nombre_archivo`) — no hay concepto de "contratista" (persona/empresa) con domicilio en ese registro. Lo más cercano a "domicilio" en el esquema es `trabajadores.direccion` (domicilio del trabajador), incluido más abajo.

## Resumen ejecutivo

- **No se encontraron** campos de tarjetas de pago, CLABE/cuenta bancaria, ni contraseñas en texto plano en ningún lugar del esquema.
- Los 3 campos que sí necesitan reversibilidad o verificación (`password_hash`, `totp_secret`, `totp_backup_codes`) ya están correctamente hasheados o cifrados.
- El resto de PII (RFC, CURP, NSS, teléfono, dirección, firma digital) está en **texto plano** en columnas TEXT, protegido únicamente por el cifrado en tránsito de la conexión (`sslmode=require` a Neon) y por el cifrado en reposo que Neon aplica a nivel de infraestructura (no a nivel de aplicación/columna).
- Los documentos binarios (identificaciones, PDFs de contrato, PDFs de contrato laboral, estimaciones firmadas) están en Vercel Blob en modo `private` (requieren proxy autenticado del propio backend, nunca URL pública directa) — esto es control de acceso, no cifrado a nivel de aplicación; la encriptación en reposo del blob depende de la infraestructura de Vercel.

## Inventario detallado

### Tabla `usuarios`

| Campo | Contenido | Estado |
|---|---|---|
| `password_hash` | contraseña de acceso | ✅ hash bcrypt (`auth.hashPassword`, costo 10) — irreversible por diseño, correcto para contraseñas |
| `totp_secret` | secret del 2° factor (TOTP) | ✅ cifrado AES-256-GCM (`auth.encryptTotpSecret`/`decryptTotpSecret`, `TOTP_ENC_KEY` de 32 bytes) — reversible porque necesita verificarse en cada login, correcto |
| `totp_backup_codes` | códigos de respaldo 2FA | ✅ JSONB `[{hash, used}]`, cada código con su propio hash bcrypt individual — correcto |

### Tabla `trabajadores` (expediente personal por obra)

| Campo | Contenido | Estado |
|---|---|---|
| `curp` | CURP | ⚠️ texto plano |
| `rfc` | RFC | ⚠️ texto plano |
| `nss` | Número de Seguro Social (IMSS) | ⚠️ texto plano |
| `telefono` | teléfono personal | ⚠️ texto plano |
| `direccion` | domicilio | ⚠️ texto plano |
| `contacto_emergencia` | texto libre (nombre/relación/teléfono en un solo campo, columna legacy) | ⚠️ texto plano |
| `contacto_emergencia_nombre` | nombre de contacto de emergencia | ⚠️ texto plano |
| `contacto_emergencia_telefono` | teléfono de contacto de emergencia | ⚠️ texto plano |

### Tabla `trabajador_documentos` (identificaciones oficiales)

| Campo | Contenido | Estado |
|---|---|---|
| `blob_url` | referencia a Vercel Blob | ✅ modo `access: 'private'` en todos los `put`/`get` (`server/app.js:4170,4190,4215`) — nunca se expone URL pública directa, siempre proxy autenticado. Cifrado en reposo del archivo en sí depende de Vercel Blob (infraestructura), no hay cifrado adicional a nivel de aplicación. |

### Tabla `proveedores`

| Campo | Contenido | Estado |
|---|---|---|
| `rfc` | RFC del proveedor | ⚠️ texto plano |
| `telefono` | teléfono de contacto | ⚠️ texto plano |
| `email` | correo de contacto | ⚠️ texto plano |

### Tabla `destajistas`

| Campo | Contenido | Estado |
|---|---|---|
| `telefono` | teléfono del destajista | ⚠️ texto plano |

### Tabla `epp_entregas` (entrega de equipo de protección personal)

| Campo | Contenido | Estado |
|---|---|---|
| `firma_digital` | firma capturada en pantalla, PNG codificado en base64 | ⚠️ texto plano (base64 no es cifrado, es solo una codificación reversible sin llave) |

### Tabla `contratos` (PDF del contrato de obra)

| Campo | Contenido | Estado |
|---|---|---|
| `blob_url` | referencia a Vercel Blob | ✅ `access: 'private'` (`server/app.js:1840`) |

### Tabla `contratos_trabajador` (contratos laborales por trabajador)

| Campo | Contenido | Estado |
|---|---|---|
| `salario_diario` | salario contractual | ⚠️ texto plano (NUMERIC) — dato sensible por confidencialidad salarial, no por ser PII de identidad |
| `pdf_url` | referencia a Vercel Blob | ✅ `access: 'private'` (`server/app.js:4306`) |

### Tabla `estimaciones` (PDF firmado de estimación de obra)

| Campo | Contenido | Estado |
|---|---|---|
| `pdf_url` | referencia a Vercel Blob | ✅ `access: 'private'` (`server/app.js:5196`) |

### Variables de entorno / infraestructura (contexto, no son columnas)

| Elemento | Estado |
|---|---|
| `DATABASE_URL` (Neon Postgres) | Conexión con `sslmode=require` — cifrado en tránsito. Cifrado en reposo de la base completa depende de Neon (gestionado por el proveedor, no por la app). |
| `TOTP_ENC_KEY`, `SESSION_SECRET` | Viven en variables de entorno (Vercel), no en la base de datos — correcto, no se auditan como "campo" pero se listan por ser las llaves detrás del único cifrado de aplicación existente hoy. |
| `sugerencia_imagenes.blob_url` | `access: 'public'` — correcto y deliberado, son capturas de pantalla adjuntas a sugerencias, no PII (ver comentario en `server/db.js:594`). |

## Hallazgos NO críticos (no disparan la Stop Condition de "dato crítico")

No se encontró ningún campo de tarjeta de pago, CVV, cuenta bancaria/CLABE, ni contraseña almacenada en texto plano. Por eso este documento no se detuvo a mitad de la auditoría — se completó el inventario entero como pidió el prompt.

## Campos en texto plano que un futuro prompt de encriptación debería priorizar

Ordenados por sensibilidad práctica (facilidad de mal uso si hay una fuga de la base de datos):

1. `trabajadores.curp`, `trabajadores.rfc`, `trabajadores.nss` — identificadores oficiales únicos, alto valor para suplantación de identidad.
2. `contratos_trabajador.salario_diario` — dato de confidencialidad salarial (impacto laboral/legal si se filtra entre trabajadores).
3. `trabajadores.telefono`, `trabajadores.direccion`, `trabajadores.contacto_emergencia*` — PII de contacto.
4. `epp_entregas.firma_digital` — dato biométrico-adyacente (firma), aunque de menor explotabilidad que CURP/RFC/NSS.
5. `proveedores.rfc/telefono/email`, `destajistas.telefono` — PII de terceros, menor sensibilidad relativa (no son datos de empleados de nómina).

Esta lista es solo diagnóstica — la decisión de qué encriptar y con qué mecanismo (columna por columna con AES igual que `totp_secret`, o pgcrypto a nivel de Postgres, o dejarlo así confiando en el cifrado en reposo de Neon) queda pendiente para que Paul la revise en un prompt posterior, tal como pidió el alcance de este prompt.
