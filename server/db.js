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
