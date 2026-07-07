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
  connectionTimeoutMillis: 10000,
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
  const { rowCount } = await pool.query('DELETE FROM proyectos WHERE id = $1', [id]);
  return rowCount > 0;
}

module.exports = { pool, initSchema, withTransaction, listProjects, getProject, createProjectRecord, deleteProject };
