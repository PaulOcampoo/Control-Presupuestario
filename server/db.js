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
    orden INTEGER DEFAULT 0
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

async function createProjectRecord(nombre, archivoOriginal) {
  const { rows } = await pool.query(
    'INSERT INTO proyectos (nombre, archivo_original) VALUES ($1, $2) RETURNING *',
    [nombre, archivoOriginal]
  );
  return rows[0];
}

async function deleteProject(id) {
  const { rowCount } = await pool.query('DELETE FROM proyectos WHERE id = $1', [id]);
  return rowCount > 0;
}

module.exports = { pool, initSchema, withTransaction, listProjects, getProject, createProjectRecord, deleteProject };
