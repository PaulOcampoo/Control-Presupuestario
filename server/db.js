'use strict';

const { Pool, types } = require('pg');

// Return DATE columns as 'YYYY-MM-DD' strings (not JS Date objects)
types.setTypeParser(1082, (val) => val);
// Return TIMESTAMP / TIMESTAMPTZ as 'YYYY-MM-DD HH:MM:SS' strings
types.setTypeParser(1114, (val) => (val ? val.slice(0, 19).replace('T', ' ') : val));
types.setTypeParser(1184, (val) => (val ? val.slice(0, 19).replace('T', ' ') : val));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 30000,
});

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS proyectos (
    id SERIAL PRIMARY KEY,
    nombre TEXT NOT NULL,
    archivo_original TEXT,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS meta (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    clave TEXT NOT NULL,
    valor TEXT,
    UNIQUE (project_id, clave)
  );

  CREATE TABLE IF NOT EXISTS conceptos (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    codigo TEXT,
    concepto TEXT NOT NULL,
    unidad TEXT,
    cantidad DOUBLE PRECISION DEFAULT 0,
    precio_unitario DOUBLE PRECISION DEFAULT 0,
    importe DOUBLE PRECISION DEFAULT 0,
    grupo TEXT,
    es_total INTEGER DEFAULT 0,
    orden INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_conceptos_project ON conceptos(project_id);

  CREATE TABLE IF NOT EXISTS insumos (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    codigo TEXT,
    concepto TEXT NOT NULL,
    categoria TEXT,
    unidad TEXT,
    cantidad_presupuesto DOUBLE PRECISION DEFAULT 0,
    precio_presupuesto DOUBLE PRECISION DEFAULT 0,
    importe_presupuesto DOUBLE PRECISION DEFAULT 0,
    orden INTEGER DEFAULT 0,
    iva_tasa DOUBLE PRECISION NOT NULL DEFAULT 16
  );
  CREATE INDEX IF NOT EXISTS idx_insumos_project ON insumos(project_id);

  CREATE TABLE IF NOT EXISTS concepto_insumos (
    id SERIAL PRIMARY KEY,
    concepto_id INTEGER NOT NULL REFERENCES conceptos(id) ON DELETE CASCADE,
    insumo_id INTEGER NOT NULL REFERENCES insumos(id) ON DELETE CASCADE,
    UNIQUE (concepto_id, insumo_id)
  );
  CREATE INDEX IF NOT EXISTS idx_conceptoinsumos_concepto ON concepto_insumos(concepto_id);
  CREATE INDEX IF NOT EXISTS idx_conceptoinsumos_insumo ON concepto_insumos(insumo_id);

  CREATE TABLE IF NOT EXISTS requisiciones (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    folio TEXT,
    fecha DATE NOT NULL DEFAULT CURRENT_DATE,
    estado TEXT NOT NULL DEFAULT 'borrador',
    observaciones TEXT,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS requisicion_items (
    id SERIAL PRIMARY KEY,
    requisicion_id INTEGER NOT NULL REFERENCES requisiciones(id) ON DELETE CASCADE,
    insumo_id INTEGER NOT NULL REFERENCES insumos(id),
    cantidad_solicitada DOUBLE PRECISION DEFAULT 0,
    precio_solicitado DOUBLE PRECISION DEFAULT 0,
    importe DOUBLE PRECISION DEFAULT 0,
    alerta_cantidad INTEGER DEFAULT 0,
    alerta_precio INTEGER DEFAULT 0,
    observaciones TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_reqitems_req ON requisicion_items(requisicion_id);
  CREATE INDEX IF NOT EXISTS idx_reqitems_insumo ON requisicion_items(insumo_id);

  CREATE TABLE IF NOT EXISTS avances_semanales (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    semana INTEGER NOT NULL,
    fecha_inicio DATE,
    fecha_fin DATE,
    avance_fisico_programado DOUBLE PRECISION DEFAULT 0,
    avance_fisico_real DOUBLE PRECISION,
    avance_financiero_programado DOUBLE PRECISION DEFAULT 0,
    avance_financiero_real DOUBLE PRECISION,
    UNIQUE (project_id, semana)
  );

  CREATE TABLE IF NOT EXISTS avance_conceptos (
    id SERIAL PRIMARY KEY,
    semana INTEGER NOT NULL,
    concepto_id INTEGER NOT NULL REFERENCES conceptos(id) ON DELETE CASCADE,
    cantidad_ejecutada DOUBLE PRECISION DEFAULT 0,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (semana, concepto_id)
  );

  CREATE TABLE IF NOT EXISTS programa_ejecucion (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    codigo TEXT,
    concepto TEXT NOT NULL,
    grupo TEXT,
    fecha_inicio DATE,
    fecha_fin DATE,
    duracion_dias INTEGER,
    importe DOUBLE PRECISION DEFAULT 0,
    peso_pct DOUBLE PRECISION DEFAULT 0,
    orden INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS destajistas (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    nombre TEXT NOT NULL,
    telefono TEXT,
    orden INTEGER DEFAULT 0,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_destajistas_project ON destajistas(project_id);

  CREATE TABLE IF NOT EXISTS destajo_items (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    destajista_id INTEGER NOT NULL REFERENCES destajistas(id) ON DELETE CASCADE,
    concepto_id INTEGER REFERENCES conceptos(id) ON DELETE SET NULL,
    codigo TEXT,
    concepto TEXT NOT NULL,
    unidad TEXT,
    cantidad_asignada DOUBLE PRECISION DEFAULT 0,
    precio_destajo DOUBLE PRECISION DEFAULT 0,
    cantidad_ejecutada DOUBLE PRECISION DEFAULT 0,
    orden INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_destajo_items_destajista ON destajo_items(destajista_id);

  CREATE TABLE IF NOT EXISTS avance_destajo (
    id SERIAL PRIMARY KEY,
    semana INTEGER NOT NULL,
    destajo_item_id INTEGER NOT NULL REFERENCES destajo_items(id) ON DELETE CASCADE,
    cantidad_ejecutada DOUBLE PRECISION DEFAULT 0,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (semana, destajo_item_id)
  );
  CREATE INDEX IF NOT EXISTS idx_avance_destajo_item ON avance_destajo(destajo_item_id);

  CREATE TABLE IF NOT EXISTS usuarios (
    id SERIAL PRIMARY KEY,
    nombre TEXT NOT NULL,
    usuario TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    puesto TEXT NOT NULL,
    activo BOOLEAN NOT NULL DEFAULT true,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS usuario_proyectos (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    asignado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (usuario_id, project_id)
  );
  CREATE INDEX IF NOT EXISTS idx_usuario_proyectos_usuario ON usuario_proyectos(usuario_id);
  CREATE INDEX IF NOT EXISTS idx_usuario_proyectos_project ON usuario_proyectos(project_id);

  CREATE TABLE IF NOT EXISTS proveedores (
    id SERIAL PRIMARY KEY,
    nombre TEXT NOT NULL,
    contacto TEXT,
    telefono TEXT,
    email TEXT,
    rfc TEXT,
    activo INTEGER DEFAULT 1,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS ordenes_compra (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    requisicion_id INTEGER NOT NULL REFERENCES requisiciones(id),
    proveedor_id INTEGER NOT NULL REFERENCES proveedores(id),
    folio TEXT,
    fecha DATE NOT NULL DEFAULT CURRENT_DATE,
    estado TEXT NOT NULL DEFAULT 'borrador',
    observaciones TEXT,
    incluye_iva BOOLEAN NOT NULL DEFAULT true,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_oc_project ON ordenes_compra(project_id);
  CREATE INDEX IF NOT EXISTS idx_oc_requisicion ON ordenes_compra(requisicion_id);

  CREATE TABLE IF NOT EXISTS orden_compra_items (
    id SERIAL PRIMARY KEY,
    orden_compra_id INTEGER NOT NULL REFERENCES ordenes_compra(id) ON DELETE CASCADE,
    requisicion_item_id INTEGER NOT NULL REFERENCES requisicion_items(id),
    cantidad_ordenada DOUBLE PRECISION DEFAULT 0,
    precio_unitario DOUBLE PRECISION DEFAULT 0,
    importe DOUBLE PRECISION DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_ocitems_oc ON orden_compra_items(orden_compra_id);

  CREATE TABLE IF NOT EXISTS recepciones (
    id SERIAL PRIMARY KEY,
    orden_compra_id INTEGER NOT NULL REFERENCES ordenes_compra(id) ON DELETE CASCADE,
    fecha DATE NOT NULL DEFAULT CURRENT_DATE,
    recibido_por TEXT,
    observaciones TEXT,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_recepciones_oc ON recepciones(orden_compra_id);

  CREATE TABLE IF NOT EXISTS recepcion_items (
    id SERIAL PRIMARY KEY,
    recepcion_id INTEGER NOT NULL REFERENCES recepciones(id) ON DELETE CASCADE,
    orden_compra_item_id INTEGER NOT NULL REFERENCES orden_compra_items(id),
    cantidad_recibida DOUBLE PRECISION DEFAULT 0,
    observaciones TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_recepitems_recepcion ON recepcion_items(recepcion_id);

  CREATE TABLE IF NOT EXISTS pagos (
    id SERIAL PRIMARY KEY,
    orden_compra_id INTEGER NOT NULL REFERENCES ordenes_compra(id) ON DELETE CASCADE,
    fecha DATE NOT NULL DEFAULT CURRENT_DATE,
    monto DOUBLE PRECISION NOT NULL,
    metodo TEXT,
    referencia TEXT,
    observaciones TEXT,
    incluye_iva BOOLEAN NOT NULL DEFAULT true,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_pagos_oc ON pagos(orden_compra_id);

  CREATE TABLE IF NOT EXISTS gastos_generales (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    categoria TEXT NOT NULL,
    concepto TEXT NOT NULL,
    fecha DATE NOT NULL DEFAULT CURRENT_DATE,
    monto DOUBLE PRECISION NOT NULL,
    estado TEXT NOT NULL DEFAULT 'pendiente',
    observaciones TEXT,
    creado_por INTEGER REFERENCES usuarios(id),
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_gastos_project ON gastos_generales(project_id);

  -- Columnas de IVA agregadas después de que estas tablas ya existían en
  -- producción — CREATE TABLE IF NOT EXISTS no las hubiera sumado a tablas
  -- previamente creadas, así que se agregan explícitamente aquí (idempotente,
  -- no destructivo: filas existentes quedan con el default).
  ALTER TABLE insumos ADD COLUMN IF NOT EXISTS iva_tasa DOUBLE PRECISION NOT NULL DEFAULT 16;
  ALTER TABLE ordenes_compra ADD COLUMN IF NOT EXISTS incluye_iva BOOLEAN NOT NULL DEFAULT true;
  ALTER TABLE pagos ADD COLUMN IF NOT EXISTS incluye_iva BOOLEAN NOT NULL DEFAULT true;

  -- Creador de la requisición — permite que residente/cabo solo vean sus
  -- propias requisiciones (compras/logistica/admin siguen viendo todas, las
  -- necesitan completas para generar órdenes de compra). Nullable: las
  -- requisiciones creadas antes de esta columna quedan sin dueño. Para no
  -- romper el historial ya capturado, esas quedan visibles/editables para
  -- CUALQUIER residente/cabo con acceso a la obra (no se le puede atribuir a
  -- nadie con certeza, pero tampoco se le oculta a todos) — ver
  -- requisicionAjena() en server/app.js. Solo las requisiciones creadas desde
  -- ahora en adelante quedan estrictamente acotadas a su creador.
  ALTER TABLE requisiciones ADD COLUMN IF NOT EXISTS usuario_id INTEGER REFERENCES usuarios(id);
  CREATE INDEX IF NOT EXISTS idx_requisiciones_usuario ON requisiciones(usuario_id);

  -- Cliente (agrupador de proyectos) — agregado después de que 'proyectos' ya
  -- existía en producción. cliente_id es nullable para no romper proyectos
  -- existentes sin cliente asignado (los 2 originales se migraron a "VINTE"
  -- en un script one-off, ver historial de git).
  CREATE TABLE IF NOT EXISTS clientes (
    id SERIAL PRIMARY KEY,
    nombre TEXT NOT NULL,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE proyectos ADD COLUMN IF NOT EXISTS cliente_id INTEGER REFERENCES clientes(id);

  -- Orden personalizado de tarjetas de cliente en "Selecciona un cliente",
  -- por usuario (no afecta lo que ven otros usuarios). Se reescribe entera
  -- en cada guardado (DELETE + INSERT dentro de una transacción) en vez de
  -- hacer upserts fila por fila — más simple dado que el orden siempre se
  -- guarda completo desde el frontend tras un drag and drop.
  CREATE TABLE IF NOT EXISTS orden_clientes_usuario (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    posicion INTEGER NOT NULL,
    UNIQUE (usuario_id, cliente_id)
  );

  -- Notificaciones in-app — infraestructura base para las alertas de fases
  -- futuras (impuestos, vencimiento de contrato, requisición/OC publicada).
  -- 'tipo' es texto libre (no ENUM) para que esas fases agreguen tipos nuevos
  -- sin migrar el esquema. 'referencia_id' apunta al id del recurso asociado
  -- (requisicion_id, orden_compra_id, etc.) según 'tipo' — sin FK porque puede
  -- referenciar distintas tablas según el tipo.
  CREATE TABLE IF NOT EXISTS notificaciones (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES proyectos(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL,
    referencia_id INTEGER,
    mensaje TEXT NOT NULL,
    leida BOOLEAN NOT NULL DEFAULT false,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_notificaciones_usuario ON notificaciones(usuario_id);
  CREATE INDEX IF NOT EXISTS idx_notificaciones_usuario_leida ON notificaciones(usuario_id, leida);

  -- Pagos de impuestos (IMSS/SAT/INFONAVIT) por obra y periodo — aplica a
  -- TODAS las obras por igual, sin relación con la pestaña Contrato. Un
  -- periodo por (project_id, año, mes); el cron mensual (ver
  -- POST /api/cron/recordatorio-impuestos) los crea en 'pendiente' y el
  -- residente/admin los actualiza a 'cargado' desde la pestaña Impuestos.
  -- Las referencias son texto libre (folio escrito a mano) — no hay subida
  -- de archivo binario en este alcance.
  CREATE TABLE IF NOT EXISTS pagos_impuestos_obra (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    periodo_anio INTEGER NOT NULL,
    periodo_mes INTEGER NOT NULL,
    imss_monto DOUBLE PRECISION,
    imss_referencia TEXT,
    sat_monto DOUBLE PRECISION,
    sat_referencia TEXT,
    infonavit_monto DOUBLE PRECISION,
    infonavit_referencia TEXT,
    estado TEXT NOT NULL DEFAULT 'pendiente',
    cargado_por INTEGER REFERENCES usuarios(id),
    cargado_en TIMESTAMPTZ,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, periodo_anio, periodo_mes)
  );

  -- Deduplicación de alertas de vencimiento de contrato (ver
  -- POST /api/cron/alertas-vencimiento y server/alertasContrato.js). Una
  -- fila por (project_id, umbral) — 'vencido' se inserta una sola vez para
  -- no repetir la alerta cada día después de la fecha de término.
  CREATE TABLE IF NOT EXISTS alertas_contrato_enviadas (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    umbral TEXT NOT NULL,
    enviada_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, umbral)
  );

  -- Autorización de avance semanal (físico/financiero) — capa agregada
  -- encima del flujo existente, no lo reemplaza. Default 'autorizado' para
  -- que las semanas ya existentes (capturadas antes de esta fase) no
  -- queden bloqueadas retroactivamente; a partir de ahora, cuando alguien
  -- no-admin captura avance real, el endpoint la pasa a
  -- 'pendiente_autorizacion' y notifica a los admins (ver
  -- PUT /api/projects/:id/avances/:semana[/conceptos] en server/app.js).
  ALTER TABLE avances_semanales ADD COLUMN IF NOT EXISTS estado_autorizacion TEXT NOT NULL DEFAULT 'autorizado';

  -- Autorización de avance de destajo por destajista+semana. No existe una
  -- fila por defecto: se crea la primera vez que alguien captura avance de
  -- destajo para ese destajista en esa semana (ver PUT
  -- /api/projects/:id/destajistas/:destId/avance/:semana).
  CREATE TABLE IF NOT EXISTS destajo_avance_autorizacion (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    destajista_id INTEGER NOT NULL REFERENCES destajistas(id) ON DELETE CASCADE,
    semana INTEGER NOT NULL,
    estado_autorizacion TEXT NOT NULL DEFAULT 'pendiente_autorizacion',
    autorizado_por INTEGER REFERENCES usuarios(id),
    autorizado_en TIMESTAMPTZ,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, destajista_id, semana)
  );

  -- Seguridad: columnas para gestión de contraseñas y revocación de sesión.
  -- DEFAULT '2020-01-01' en token_valid_since para no invalidar sesiones
  -- existentes al desplegar esta migración.
  ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS token_valid_since TIMESTAMPTZ NOT NULL DEFAULT '2020-01-01 00:00:00+00';

  -- 2FA TOTP: secret cifrado (AES-256-GCM con TOTP_ENC_KEY, no en texto plano),
  -- totp_enabled=false fuerza el flujo de inscripción en el próximo login,
  -- backup codes como JSONB [{hash, used}] (bcrypt individual, un solo uso c/u).
  ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS totp_secret TEXT;
  ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS totp_backup_codes JSONB;

  -- 2FA opcional (julio 2026): totp_enabled=false ya NO fuerza inscripción.
  -- totp_reminder_last_shown_at trackea cuándo se le mostró el banner de
  -- recordatorio por última vez, para no repetirlo antes de 3 días.
  ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS totp_reminder_last_shown_at TIMESTAMP;

  -- Intentos de login para rate limiting por usuario (serverless-safe:
  -- persiste entre instancias). Índice compuesto para la consulta de ventana
  -- temporal (identificador + creado_en).
  CREATE TABLE IF NOT EXISTS login_attempts (
    id SERIAL PRIMARY KEY,
    identificador TEXT NOT NULL,
    ip TEXT,
    exitoso BOOLEAN NOT NULL DEFAULT false,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_login_attempts_ident ON login_attempts(identificador, creado_en);
  CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip, creado_en);

  -- Auditoría de acciones administrativas sensibles (creación de usuario,
  -- reset de contraseña). No reemplaza login_attempts; registra quién hizo
  -- qué sobre qué usuario y desde qué IP. actor_id puede ser NULL si el
  -- actor ya no existe al consultar historial.
  CREATE TABLE IF NOT EXISTS audit_log (
    id SERIAL PRIMARY KEY,
    actor_id INTEGER,
    actor_usuario TEXT NOT NULL,
    accion TEXT NOT NULL,
    target_id INTEGER,
    target_usuario TEXT,
    ip TEXT,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_audit_log_creado ON audit_log(creado_en DESC);

  -- project_id agregado para poder filtrar el historial de acciones sobre
  -- requisiciones por obra (residente/cabo — control de qué hacen en cada
  -- obra). ON DELETE SET NULL: si algún día se borra un proyecto, el
  -- historial de auditoría no desaparece con él.
  ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES proyectos(id) ON DELETE SET NULL;
  CREATE INDEX IF NOT EXISTS idx_audit_log_project ON audit_log(project_id, creado_en DESC);

  -- Última visita por usuario+cliente para navegación inteligente: cuando el
  -- usuario selecciona un cliente, la app navega automáticamente al último
  -- proyecto visitado. UNIQUE(usuario_id, cliente_id) permite upsert eficiente.
  CREATE TABLE IF NOT EXISTS ultima_visita (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    proyecto_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(usuario_id, cliente_id)
  );
  CREATE INDEX IF NOT EXISTS idx_ultima_visita_usuario_cliente ON ultima_visita(usuario_id, cliente_id);

  -- Catálogo formal de trabajadores por obra (expediente personal). Coexiste
  -- con 'destajistas' (rol en obra); el vínculo es opcional vía destajista_id.
  CREATE TABLE IF NOT EXISTS trabajadores (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    destajista_id INTEGER REFERENCES destajistas(id) ON DELETE SET NULL,
    nombre TEXT NOT NULL,
    puesto TEXT,
    tipo_pago TEXT NOT NULL DEFAULT 'jornal',
    tarifa_jornal DOUBLE PRECISION DEFAULT 0,
    periodicidad TEXT NOT NULL DEFAULT 'semanal',
    curp TEXT,
    rfc TEXT,
    nss TEXT,
    telefono TEXT,
    direccion TEXT,
    contacto_emergencia TEXT,
    fecha_ingreso DATE,
    activo BOOLEAN NOT NULL DEFAULT true,
    fecha_baja DATE,
    motivo_baja TEXT,
    orden INTEGER DEFAULT 0,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_trabajadores_project ON trabajadores(project_id);

  -- Documentos de identidad (Vercel Blob privado — nunca URL pública directa)
  CREATE TABLE IF NOT EXISTS trabajador_documentos (
    id SERIAL PRIMARY KEY,
    trabajador_id INTEGER NOT NULL REFERENCES trabajadores(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL,
    nombre_archivo TEXT NOT NULL,
    blob_url TEXT NOT NULL,
    subido_por INTEGER REFERENCES usuarios(id),
    subido_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_trabajador_docs ON trabajador_documentos(trabajador_id);

  -- Asistencia diaria (checklist por trabajador × fecha)
  CREATE TABLE IF NOT EXISTS asistencia_diaria (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    trabajador_id INTEGER NOT NULL REFERENCES trabajadores(id) ON DELETE CASCADE,
    fecha DATE NOT NULL,
    presente BOOLEAN NOT NULL DEFAULT false,
    capturado_por INTEGER REFERENCES usuarios(id),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, trabajador_id, fecha)
  );
  CREATE INDEX IF NOT EXISTS idx_asistencia_fecha ON asistencia_diaria(project_id, fecha);

  -- Migración: columna estado 3-valores en lugar del booleano presente original.
  -- 'presente' es el DEFAULT para no afectar filas existentes.
  -- PAID_IF_PRESENT: solo 'presente' genera pago (falta_justificada y falta_injustificada no pagan).
  -- Si se quiere que falta_justificada pague, cambiar la constante en el cálculo de nómina.
  ALTER TABLE asistencia_diaria ADD COLUMN IF NOT EXISTS estado TEXT NOT NULL DEFAULT 'presente';

  -- Nóminas — cabecera de periodo de pago con flujo de autorización
  CREATE TABLE IF NOT EXISTS nominas (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    fecha_inicio DATE NOT NULL,
    fecha_fin DATE NOT NULL,
    estado TEXT NOT NULL DEFAULT 'borrador',
    nota_rechazo TEXT,
    aprobada_por INTEGER REFERENCES usuarios(id),
    aprobada_en TIMESTAMPTZ,
    creado_por INTEGER REFERENCES usuarios(id),
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_nominas_project ON nominas(project_id);

  -- Items de nómina — uno por trabajador por periodo
  CREATE TABLE IF NOT EXISTS nomina_items (
    id SERIAL PRIMARY KEY,
    nomina_id INTEGER NOT NULL REFERENCES nominas(id) ON DELETE CASCADE,
    trabajador_id INTEGER NOT NULL REFERENCES trabajadores(id),
    dias_trabajados INTEGER DEFAULT 0,
    monto_jornal DOUBLE PRECISION DEFAULT 0,
    monto_destajo DOUBLE PRECISION DEFAULT 0,
    monto_total DOUBLE PRECISION DEFAULT 0,
    UNIQUE(nomina_id, trabajador_id)
  );
  CREATE INDEX IF NOT EXISTS idx_nomina_items_nomina ON nomina_items(nomina_id);

  -- Rate limiting de endpoints costosos (ej. extracción PDF via Claude API).
  -- Serverless-safe: persiste entre instancias igual que login_attempts.
  -- Índice compuesto para la consulta de ventana temporal (usuario + endpoint + creado_en).
  CREATE TABLE IF NOT EXISTS api_rate_limits (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_api_rate_limits_usuario ON api_rate_limits(usuario_id, endpoint, creado_en);
  -- Columna ip: permite además un límite por IP (ej. PUT /api/auth/mi-cuenta),
  -- igual que login_attempts, sin duplicar la tabla.
  ALTER TABLE api_rate_limits ADD COLUMN IF NOT EXISTS ip TEXT;
  CREATE INDEX IF NOT EXISTS idx_api_rate_limits_ip ON api_rate_limits(ip, endpoint, creado_en);

  -- PDF original del contrato — almacenado en Vercel Blob (privado). Relación
  -- 1:1 con proyectos (UNIQUE project_id). El blob_url lo genera contrato-preview
  -- y lo persiste contrato-confirm; el endpoint GET /api/projects/:id/contrato/pdf
  -- hace proxy del blob sin exponer la URL directa al cliente.
  CREATE TABLE IF NOT EXISTS contratos (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    blob_url TEXT NOT NULL,
    nombre_archivo TEXT NOT NULL DEFAULT 'contrato.pdf',
    subido_por INTEGER REFERENCES usuarios(id),
    subido_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id)
  );
  CREATE INDEX IF NOT EXISTS idx_contratos_project ON contratos(project_id);

  -- Portal de sugerencias — cualquier usuario autenticado puede enviar; solo
  -- admin puede revisar y gestionar. prompt_generado almacena el prompt
  -- técnico formateado por IA (claude-sonnet-4-6) bajo demanda desde el
  -- panel de admin. El rate limiting usa api_rate_limits (endpoint='sugerencias').
  CREATE TABLE IF NOT EXISTS sugerencias (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    texto TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'pendiente',
    prompt_generado TEXT,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_sugerencias_estado ON sugerencias(estado, creado_en DESC);
  CREATE INDEX IF NOT EXISTS idx_sugerencias_usuario ON sugerencias(usuario_id);

  -- Imágenes adjuntas a sugerencias (capturas de pantalla). Almacenadas en
  -- Vercel Blob con acceso público (no son datos sensibles). Máx. 5 por sugerencia.
  CREATE TABLE IF NOT EXISTS sugerencia_imagenes (
    id SERIAL PRIMARY KEY,
    sugerencia_id INTEGER NOT NULL REFERENCES sugerencias(id) ON DELETE CASCADE,
    blob_url TEXT NOT NULL,
    nombre_archivo TEXT NOT NULL,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_sug_imgs ON sugerencia_imagenes(sugerencia_id);

  -- Alta: campos adicionales en trabajadores (contacto de emergencia dividido).
  ALTER TABLE trabajadores ADD COLUMN IF NOT EXISTS contacto_emergencia_nombre TEXT;
  ALTER TABLE trabajadores ADD COLUMN IF NOT EXISTS contacto_emergencia_telefono TEXT;

  -- Historial formal de bajas por trabajador (soft-delete auditado).
  -- motivo_baja restringido por CHECK; cuando es 'otro', se espera notas != null (enforced en app).
  CREATE TABLE IF NOT EXISTS trabajador_bajas (
    id SERIAL PRIMARY KEY,
    trabajador_id INTEGER NOT NULL REFERENCES trabajadores(id) ON DELETE CASCADE,
    fecha_baja DATE NOT NULL DEFAULT CURRENT_DATE,
    motivo_baja TEXT NOT NULL CHECK (motivo_baja IN ('renuncia','despido_justificado','despido_injustificado','fin_obra','abandono','otro')),
    notas TEXT,
    registrado_por INTEGER REFERENCES usuarios(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_trabajador_bajas_trabajador ON trabajador_bajas(trabajador_id);

  -- Contratos laborales por trabajador (múltiples en el tiempo — historial).
  -- activo=true indica el contrato vigente; al crear uno nuevo se desactiva el anterior.
  -- salario_diario es el salario contractual/legal; NO reemplaza tarifa_jornal de nómina.
  CREATE TABLE IF NOT EXISTS contratos_trabajador (
    id SERIAL PRIMARY KEY,
    trabajador_id INTEGER NOT NULL REFERENCES trabajadores(id) ON DELETE CASCADE,
    tipo_contrato TEXT NOT NULL CHECK (tipo_contrato IN ('obra_determinada','tiempo_determinado','tiempo_indeterminado')),
    fecha_inicio DATE NOT NULL,
    fecha_fin DATE,
    salario_diario NUMERIC(12,2),
    pdf_url TEXT,
    pdf_filename TEXT,
    activo BOOLEAN NOT NULL DEFAULT true,
    created_by INTEGER REFERENCES usuarios(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_contratos_trabajador ON contratos_trabajador(trabajador_id);

  -- Catálogo de EPP configurable por obra.
  CREATE TABLE IF NOT EXISTS epp_catalogo (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    nombre_item TEXT NOT NULL,
    descripcion TEXT,
    activo BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_epp_catalogo_project ON epp_catalogo(project_id);

  -- Registros de entrega de EPP con firma digital (base64 PNG).
  CREATE TABLE IF NOT EXISTS epp_entregas (
    id SERIAL PRIMARY KEY,
    trabajador_id INTEGER NOT NULL REFERENCES trabajadores(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES epp_catalogo(id) ON DELETE RESTRICT,
    cantidad INTEGER NOT NULL DEFAULT 1,
    fecha_entrega DATE NOT NULL DEFAULT CURRENT_DATE,
    firma_digital TEXT,
    entregado_por INTEGER REFERENCES usuarios(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_epp_entregas_trabajador ON epp_entregas(trabajador_id);
  CREATE INDEX IF NOT EXISTS idx_epp_entregas_item ON epp_entregas(item_id);

  -- Permisos granulares por usuario/obra/sección — conviven con auth.allow()
  -- (rol) sin reemplazarlo. proyecto_id nullable = aplica a todas las obras
  -- asignadas al usuario. Alcance inicial de enforcement real: Nómina y
  -- Destajo (ver server/app.js); el resto de secciones sigue gobernado por
  -- auth.allow() por ahora — esta tabla ya persiste su matriz completa para
  -- cuando se amplíe.
  CREATE TABLE IF NOT EXISTS permisos_usuario (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    proyecto_id INTEGER REFERENCES proyectos(id) ON DELETE CASCADE,
    -- Mantener en sync con SECCIONES_PERMISOS en server/auth.js. En Preview
    -- este CHECK ya se amplió vía ALTER TABLE directo (no vuelve a correr
    -- sobre una tabla existente); esta definición solo aplica a bases nuevas.
    seccion TEXT NOT NULL CHECK (seccion IN (
      'presupuestos','requisiciones','proveedores','ordenes_compra','avance',
      'destajo','finanzas','insumos','mapeo','usuarios','contrato','impuestos',
      'nominas','sugerencias','programa','estimaciones','maquinaria',
      'trabajadores_global','nominas_global'
    )),
    puede_ver BOOLEAN NOT NULL DEFAULT false,
    puede_crear BOOLEAN NOT NULL DEFAULT false,
    puede_editar BOOLEAN NOT NULL DEFAULT false,
    puede_editar_precios BOOLEAN NOT NULL DEFAULT false,
    puede_eliminar BOOLEAN NOT NULL DEFAULT false,
    UNIQUE (usuario_id, proyecto_id, seccion)
  );
  CREATE INDEX IF NOT EXISTS idx_permisos_usuario_usuario ON permisos_usuario(usuario_id);
  -- Amplía el CHECK de 'seccion' en bases ya existentes (Preview/producción)
  -- para las 2 secciones nuevas de prompts-cotizador-permisos.md Prompt 2 —
  -- el CREATE TABLE de arriba no vuelve a correr sobre una tabla existente,
  -- así que el CHECK original se queda corto sin este ALTER explícito.
  ALTER TABLE permisos_usuario DROP CONSTRAINT IF EXISTS permisos_usuario_seccion_check;
  ALTER TABLE permisos_usuario ADD CONSTRAINT permisos_usuario_seccion_check CHECK (seccion IN (
    'presupuestos','requisiciones','proveedores','ordenes_compra','avance',
    'destajo','finanzas','insumos','mapeo','usuarios','contrato','impuestos',
    'nominas','sugerencias','programa','estimaciones','maquinaria',
    'trabajadores_global','nominas_global'
  ));

  -- Contador de folios por obra + tipo de documento. INSERT...ON CONFLICT DO
  -- UPDATE...RETURNING es atómico a nivel de fila en Postgres (no necesita
  -- SELECT FOR UPDATE aparte) — evita folios duplicados si dos residentes
  -- crean una estimación de la misma obra al mismo tiempo. 'tipo' deja abierto
  -- reusar esta tabla para otros documentos foliados en el futuro.
  CREATE TABLE IF NOT EXISTS folio_counters (
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL,
    ultimo_folio INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, tipo)
  );

  -- Estimaciones de obra: corte de avance periódico que jala montos de
  -- avance_conceptos (NO captura manual). total_acumulado/cantidad_acumulada
  -- (aquí y en estimacion_conceptos) reflejan solo estimaciones previas ya
  -- APROBADAS + el periodo actual — no el avance físico crudo — para que el
  -- PDF firmado siempre reconcilie con los documentos previos ya entregados
  -- al cliente (decisión explícita, ver prompt_modulo_estimaciones_obra.md).
  -- Soft-delete vía 'activo': nunca DELETE físico de una estimación.
  CREATE TABLE IF NOT EXISTS estimaciones (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    folio INTEGER NOT NULL,
    periodo_inicio DATE NOT NULL,
    periodo_fin DATE NOT NULL,
    estado TEXT NOT NULL DEFAULT 'borrador',
    residente_id INTEGER REFERENCES usuarios(id),
    admin_aprobador_id INTEGER REFERENCES usuarios(id),
    fecha_captura TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    fecha_aprobacion TIMESTAMPTZ,
    total_periodo DOUBLE PRECISION DEFAULT 0,
    total_acumulado DOUBLE PRECISION DEFAULT 0,
    pdf_url TEXT,
    comentario_rechazo TEXT,
    activo BOOLEAN NOT NULL DEFAULT true,
    UNIQUE (project_id, folio)
  );
  CREATE INDEX IF NOT EXISTS idx_estimaciones_project ON estimaciones(project_id);
  -- Prompt 4 (prompts-cotizador-sidebar-permisos-estimaciones.md): nombre
  -- editable opcional (si es NULL, la UI sigue mostrando "Estimación #folio"
  -- como hasta ahora) + desglose de pago persistido (no se recalcula solo,
  -- para que una estimación ya aprobada/con PDF mantenga el monto exacto que
  -- se cobró aunque la fórmula cambie después). amortizacion_anticipo es
  -- captura manual (opcional, $0 si no aplica); fondo_garantia_monto/
  -- iva_monto/total_a_pagar se recalculan junto con total_periodo cada vez
  -- que se usa "Calcular" (ver POST .../calcular), y total_a_pagar también
  -- se recalcula al guardar una nueva amortizacion_anticipo.
  ALTER TABLE estimaciones ADD COLUMN IF NOT EXISTS nombre TEXT;
  ALTER TABLE estimaciones ADD COLUMN IF NOT EXISTS amortizacion_anticipo DOUBLE PRECISION NOT NULL DEFAULT 0;
  ALTER TABLE estimaciones ADD COLUMN IF NOT EXISTS fondo_garantia_monto DOUBLE PRECISION NOT NULL DEFAULT 0;
  ALTER TABLE estimaciones ADD COLUMN IF NOT EXISTS iva_monto DOUBLE PRECISION NOT NULL DEFAULT 0;
  ALTER TABLE estimaciones ADD COLUMN IF NOT EXISTS total_a_pagar DOUBLE PRECISION NOT NULL DEFAULT 0;

  CREATE TABLE IF NOT EXISTS estimacion_conceptos (
    id SERIAL PRIMARY KEY,
    estimacion_id INTEGER NOT NULL REFERENCES estimaciones(id) ON DELETE CASCADE,
    concepto_id INTEGER NOT NULL REFERENCES conceptos(id),
    cantidad_periodo DOUBLE PRECISION DEFAULT 0,
    importe_periodo DOUBLE PRECISION DEFAULT 0,
    cantidad_acumulada DOUBLE PRECISION DEFAULT 0,
    importe_acumulado DOUBLE PRECISION DEFAULT 0,
    porcentaje_avance DOUBLE PRECISION DEFAULT 0,
    UNIQUE (estimacion_id, concepto_id)
  );
  CREATE INDEX IF NOT EXISTS idx_estimacion_conceptos_estimacion ON estimacion_conceptos(estimacion_id);

  -- Módulo de Maquinaria (prompt-modulo-maquinaria) — DISEÑO DE PRIMER BORRADOR,
  -- pendiente de revisión: la asignación cabo=captura de horas /
  -- taller=combustible+mantenimiento es una propuesta inicial, no definitiva.
  -- 'tipo' en equipos_maquinaria empieza solo con 'retroexcavadora' pero es
  -- texto libre para poder agregar tipos de equipo después sin migración.
  CREATE TABLE IF NOT EXISTS equipos_maquinaria (
    id SERIAL PRIMARY KEY,
    nombre TEXT NOT NULL,
    tipo TEXT NOT NULL DEFAULT 'retroexcavadora',
    identificador TEXT,
    estado TEXT NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo', 'mantenimiento', 'baja')),
    obra_id INTEGER REFERENCES proyectos(id) ON DELETE SET NULL,
    activo BOOLEAN NOT NULL DEFAULT true,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_equipos_maquinaria_obra ON equipos_maquinaria(obra_id);

  CREATE TABLE IF NOT EXISTS combustible_maquinaria (
    id SERIAL PRIMARY KEY,
    equipo_id INTEGER NOT NULL REFERENCES equipos_maquinaria(id) ON DELETE CASCADE,
    fecha DATE NOT NULL,
    litros DOUBLE PRECISION NOT NULL,
    costo DOUBLE PRECISION NOT NULL,
    registrado_por INTEGER NOT NULL REFERENCES usuarios(id),
    activo BOOLEAN NOT NULL DEFAULT true,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_combustible_maquinaria_equipo ON combustible_maquinaria(equipo_id);

  CREATE TABLE IF NOT EXISTS mantenimientos_maquinaria (
    id SERIAL PRIMARY KEY,
    equipo_id INTEGER NOT NULL REFERENCES equipos_maquinaria(id) ON DELETE CASCADE,
    fecha DATE NOT NULL,
    tipo TEXT NOT NULL CHECK (tipo IN ('preventivo', 'correctivo')),
    descripcion TEXT,
    costo DOUBLE PRECISION NOT NULL,
    proveedor TEXT,
    registrado_por INTEGER NOT NULL REFERENCES usuarios(id),
    activo BOOLEAN NOT NULL DEFAULT true,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_mantenimientos_maquinaria_equipo ON mantenimientos_maquinaria(equipo_id);

  CREATE TABLE IF NOT EXISTS reportes_horas_maquinaria (
    id SERIAL PRIMARY KEY,
    equipo_id INTEGER NOT NULL REFERENCES equipos_maquinaria(id) ON DELETE CASCADE,
    operador_id INTEGER NOT NULL REFERENCES usuarios(id),
    fecha DATE NOT NULL,
    horas DOUBLE PRECISION NOT NULL,
    obra_id INTEGER REFERENCES proyectos(id) ON DELETE SET NULL,
    activo BOOLEAN NOT NULL DEFAULT true,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_reportes_horas_maquinaria_equipo ON reportes_horas_maquinaria(equipo_id);

  -- ASUNCIÓN sin confirmar con Paul (ver prompt-modulo-maquinaria.md): un solo
  -- monto total sin periodo (no mensual/anual) — fila única forzada por el
  -- CHECK (id = 1), patrón "singleton row".
  CREATE TABLE IF NOT EXISTS presupuesto_maquinaria (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    monto_total DOUBLE PRECISION NOT NULL DEFAULT 0,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  INSERT INTO presupuesto_maquinaria (id, monto_total) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

  -- Cache de precios del Cotizador de materiales (Home Depot / Sodimac —
  -- Materiales Valdez quedó fuera: su sitio no publica precios en línea,
  -- ver prompts-cotizador-permisos.md). Cada fila es un resultado de
  -- scraping para una query+tienda; el cache se considera válido 24h
  -- (ver server/cotizador.js) antes de re-scrapear.
  CREATE TABLE IF NOT EXISTS cotizador_precios (
    id SERIAL PRIMARY KEY,
    query_busqueda TEXT NOT NULL,
    tienda TEXT NOT NULL CHECK (tienda IN ('home_depot', 'sodimac', 'amazon')),
    nombre_producto TEXT NOT NULL,
    precio DOUBLE PRECISION,
    url_producto TEXT,
    fecha_consulta TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_cotizador_precios_query_tienda ON cotizador_precios(query_busqueda, tienda);
  -- Amplía el CHECK de 'tienda' en bases ya existentes (Preview/producción)
  -- para 'amazon' (prompt-cotizador-mas-tiendas.md) — el CREATE TABLE de
  -- arriba no vuelve a correr sobre una tabla existente, así que el CHECK
  -- original se queda corto sin este ALTER explícito. Mercado Libre y
  -- Construrama quedaron fuera del comparador: bloqueo consistente de
  -- bot-detection real (Incapsula en Construrama, verificación de seguridad
  -- en ML) confirmado en diagnóstico de Fase 0 — no hay CAPTCHA resoluble
  -- que automatizar, es un firewall de tráfico automatizado.
  ALTER TABLE cotizador_precios DROP CONSTRAINT IF EXISTS cotizador_precios_tienda_check;
  ALTER TABLE cotizador_precios ADD CONSTRAINT cotizador_precios_tienda_check CHECK (tienda IN ('home_depot', 'sodimac', 'amazon'));

  -- Ubicación fija para cotizar en Amazon (única tienda del comparador que
  -- soporta fijar zona de envío vía UI) — una sola fila activa para toda la
  -- app, no por usuario (prompt-cotizador-mas-tiendas.md, Fase 1).
  CREATE TABLE IF NOT EXISTS cotizador_config (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    ciudad TEXT,
    codigo_postal TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by INTEGER REFERENCES usuarios(id)
  );

  -- Estado de Resultados (Tesorería) — Ingresos (facturas/cobros) para
  -- comparar contra Egresos ya calculados en Finanzas (getFinanzasResumenData).
  -- Vínculo con el contrato: solo project_id — la tabla contratos es 1:1 con
  -- project_id (UNIQUE) y no guarda montos (esos viven en meta como filas
  -- sueltas por clave), así que un contrato_id FK sería redundante.
  -- estatus 'cancelada' es el soft-delete (mismo patrón que ordenes_compra/
  -- requisiciones: filtrar con estatus != 'cancelada', nunca DELETE físico).
  CREATE TABLE IF NOT EXISTS facturas (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    folio TEXT,
    concepto TEXT NOT NULL,
    fecha_emision DATE NOT NULL DEFAULT CURRENT_DATE,
    monto_subtotal DOUBLE PRECISION NOT NULL,
    iva DOUBLE PRECISION NOT NULL DEFAULT 0,
    monto_total DOUBLE PRECISION NOT NULL,
    estatus TEXT NOT NULL DEFAULT 'pendiente'
      CHECK (estatus IN ('pendiente', 'cobrada_parcial', 'cobrada_total', 'cancelada')),
    creado_por INTEGER REFERENCES usuarios(id),
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_facturas_project ON facturas(project_id);

  -- Abonos sobre una factura — historial completo, nunca se sobreescribe ni
  -- se borra una fila para "corregir" un cobro (si se captura mal, se
  -- registra un cobro compensatorio; el estatus de la factura se recalcula
  -- siempre a partir de la suma de esta tabla).
  CREATE TABLE IF NOT EXISTS cobros (
    id SERIAL PRIMARY KEY,
    factura_id INTEGER NOT NULL REFERENCES facturas(id) ON DELETE CASCADE,
    fecha_cobro DATE NOT NULL DEFAULT CURRENT_DATE,
    monto_cobrado DOUBLE PRECISION NOT NULL,
    forma_pago TEXT,
    creado_por INTEGER REFERENCES usuarios(id),
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_cobros_factura ON cobros(factura_id);
`;

async function initSchema() {
  await pool.query(SCHEMA);
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function listProjects() {
  const { rows } = await pool.query('SELECT * FROM proyectos ORDER BY id DESC');
  return rows;
}

async function getProject(id) {
  const { rows } = await pool.query('SELECT * FROM proyectos WHERE id = $1', [id]);
  return rows[0] || null;
}

async function createProjectRecord(nombre, archivoOriginal, clienteId) {
  const { rows } = await pool.query(
    'INSERT INTO proyectos (nombre, archivo_original, cliente_id) VALUES ($1, $2, $3) RETURNING *',
    [nombre, archivoOriginal, clienteId]
  );
  return rows[0];
}

async function deleteProject(id) {
  return withTransaction(async (client) => {
    // Varias FK no tienen ON DELETE CASCADE, lo que hace que el DELETE en
    // cascada falle con FK-violation. Las eliminamos manualmente en el orden
    // correcto antes de borrar el proyecto para que el CASCADE maneje el resto.
    await client.query(`
      DELETE FROM recepcion_items
      WHERE recepcion_id IN (
        SELECT r.id FROM recepciones r
        JOIN ordenes_compra oc ON r.orden_compra_id = oc.id
        WHERE oc.project_id = $1
      )`, [id]);
    await client.query(`
      DELETE FROM orden_compra_items
      WHERE orden_compra_id IN (SELECT id FROM ordenes_compra WHERE project_id = $1)
    `, [id]);
    // requisicion_items.insumo_id → insumos(id) no tiene CASCADE; si existen
    // filas cuando el CASCADE intenta borrar insumos, lanza FK-violation.
    await client.query(`
      DELETE FROM requisicion_items
      WHERE requisicion_id IN (SELECT id FROM requisiciones WHERE project_id = $1)
    `, [id]);
    await client.query(`
      DELETE FROM nomina_items
      WHERE nomina_id IN (SELECT id FROM nominas WHERE project_id = $1)
    `, [id]);
    const { rowCount } = await client.query('DELETE FROM proyectos WHERE id = $1', [id]);
    return rowCount > 0;
  });
}

module.exports = { pool, initSchema, withTransaction, listProjects, getProject, createProjectRecord, deleteProject };
