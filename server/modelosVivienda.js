'use strict';

// Catálogo comercial de modelos de vivienda (prompt-implementacion-catalogo-
// comercial.md, diagnóstico previo en prompt-diagnostico-catalogo-comercial.md)
// — Fase 3 del roadmap "Desarrollador de Vivienda". Scoped por project_id,
// mismo patrón de separación que server/lotes.js: los endpoints HTTP viven en
// server/app.js, la lógica de negocio (CRUD + validación) aquí.

const db = require('./db');

async function listModelos(pid) {
  const { rows } = await db.pool.query(
    'SELECT * FROM modelos_vivienda WHERE project_id = $1 ORDER BY activo DESC, nombre',
    [pid]
  );
  return rows;
}

function validarCampos({ nombre, recamaras, niveles }) {
  if (!nombre || !String(nombre).trim()) {
    const err = new Error('nombre es requerido');
    err.status = 400;
    throw err;
  }
  if (recamaras != null && !Number.isInteger(recamaras)) {
    const err = new Error('recamaras debe ser un número entero');
    err.status = 400;
    throw err;
  }
  if (niveles != null && !Number.isInteger(niveles)) {
    const err = new Error('niveles debe ser un número entero');
    err.status = 400;
    throw err;
  }
}

async function createModelo(pid, data) {
  const {
    nombre, descripcion, superficie_construida_m2, superficie_terreno_m2,
    recamaras, banos, niveles, precio_lista,
  } = data || {};
  validarCampos({ nombre, recamaras, niveles });
  const { rows } = await db.pool.query(
    `INSERT INTO modelos_vivienda
       (project_id, nombre, descripcion, superficie_construida_m2, superficie_terreno_m2, recamaras, banos, niveles, precio_lista)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [pid, String(nombre).trim(), descripcion || null, superficie_construida_m2 ?? null,
      superficie_terreno_m2 ?? null, recamaras ?? null, banos ?? null, niveles ?? null, precio_lista ?? null]
  );
  return rows[0];
}

async function updateModelo(id, pid, data) {
  const { rows: existRows } = await db.pool.query(
    'SELECT * FROM modelos_vivienda WHERE id = $1 AND project_id = $2', [id, pid]
  );
  if (!existRows[0]) {
    const err = new Error('Modelo de vivienda no encontrado');
    err.status = 404;
    throw err;
  }
  const actual = existRows[0];
  const campos = {
    nombre: data.nombre !== undefined ? String(data.nombre || '').trim() : actual.nombre,
    descripcion: data.descripcion !== undefined ? (data.descripcion || null) : actual.descripcion,
    superficie_construida_m2: data.superficie_construida_m2 !== undefined ? data.superficie_construida_m2 : actual.superficie_construida_m2,
    superficie_terreno_m2: data.superficie_terreno_m2 !== undefined ? data.superficie_terreno_m2 : actual.superficie_terreno_m2,
    recamaras: data.recamaras !== undefined ? data.recamaras : actual.recamaras,
    banos: data.banos !== undefined ? data.banos : actual.banos,
    niveles: data.niveles !== undefined ? data.niveles : actual.niveles,
    precio_lista: data.precio_lista !== undefined ? data.precio_lista : actual.precio_lista,
    activo: data.activo !== undefined ? !!data.activo : actual.activo,
  };
  validarCampos(campos);

  const { rows } = await db.pool.query(
    `UPDATE modelos_vivienda SET nombre=$1, descripcion=$2, superficie_construida_m2=$3,
       superficie_terreno_m2=$4, recamaras=$5, banos=$6, niveles=$7, precio_lista=$8,
       activo=$9, actualizado_en=NOW()
     WHERE id = $10 AND project_id = $11
     RETURNING *`,
    [campos.nombre, campos.descripcion, campos.superficie_construida_m2, campos.superficie_terreno_m2,
      campos.recamaras, campos.banos, campos.niveles, campos.precio_lista, campos.activo, id, pid]
  );
  return rows[0];
}

// Soft-delete — nunca DELETE físico (Forbidden Action explícita del prompt).
async function softDeleteModelo(id, pid) {
  const { rows } = await db.pool.query(
    `UPDATE modelos_vivienda SET activo = false, actualizado_en = NOW()
     WHERE id = $1 AND project_id = $2
     RETURNING *`,
    [id, pid]
  );
  if (!rows[0]) {
    const err = new Error('Modelo de vivienda no encontrado');
    err.status = 404;
    throw err;
  }
  return rows[0];
}

module.exports = {
  listModelos,
  createModelo,
  updateModelo,
  softDeleteModelo,
};
