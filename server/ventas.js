'use strict';

// Fase 4 del roadmap "Desarrollador de Vivienda", PR A (prompt-
// implementacion-pr-a-compradores-apartado.md, diagnóstico previo en
// prompt-diagnostico-compradores-venta.md) — entidad Compradores + flujo de
// Apartado. Mismo patrón de separación que server/lotes.js/modelosVivienda.js:
// los endpoints HTTP viven en server/app.js, la lógica de negocio aquí.
//
// lotes.estatus_venta es DERIVADO desde este módulo (nunca editable por el
// usuario, ver server/lotes.js createLote/updateLote) — crearApartado lo
// escribe a 'apartado', cancelarApartado lo regresa a 'disponible' si no
// queda otro apartado activo para ese lote. 'vendido' llega en un PR
// posterior (Contrato de compraventa), fuera de alcance aquí.

const db = require('./db');

const ESTADO_APARTADO = ['activo', 'convertido_a_contrato', 'cancelado', 'vencido'];

async function listCompradores(pid) {
  const { rows } = await db.pool.query(
    'SELECT * FROM compradores WHERE project_id = $1 ORDER BY activo DESC, nombre', [pid]
  );
  return rows;
}

function validarNombreComprador(nombre) {
  if (!nombre || !String(nombre).trim()) {
    const err = new Error('nombre es requerido');
    err.status = 400;
    throw err;
  }
}

async function createComprador(pid, data) {
  const { nombre, contacto, telefono, email, rfc } = data || {};
  validarNombreComprador(nombre);
  const { rows } = await db.pool.query(
    `INSERT INTO compradores (project_id, nombre, contacto, telefono, email, rfc)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [pid, String(nombre).trim(), contacto || null, telefono || null, email || null, rfc || null]
  );
  return rows[0];
}

async function updateComprador(id, pid, data) {
  const { rows: existRows } = await db.pool.query(
    'SELECT * FROM compradores WHERE id = $1 AND project_id = $2', [id, pid]
  );
  if (!existRows[0]) {
    const err = new Error('Comprador no encontrado');
    err.status = 404;
    throw err;
  }
  const actual = existRows[0];
  const campos = {
    nombre: data.nombre !== undefined ? String(data.nombre || '').trim() : actual.nombre,
    contacto: data.contacto !== undefined ? (data.contacto || null) : actual.contacto,
    telefono: data.telefono !== undefined ? (data.telefono || null) : actual.telefono,
    email: data.email !== undefined ? (data.email || null) : actual.email,
    rfc: data.rfc !== undefined ? (data.rfc || null) : actual.rfc,
    activo: data.activo !== undefined ? !!data.activo : actual.activo,
  };
  validarNombreComprador(campos.nombre);

  const { rows } = await db.pool.query(
    `UPDATE compradores SET nombre=$1, contacto=$2, telefono=$3, email=$4, rfc=$5, activo=$6, actualizado_en=NOW()
     WHERE id = $7 AND project_id = $8
     RETURNING *`,
    [campos.nombre, campos.contacto, campos.telefono, campos.email, campos.rfc, campos.activo, id, pid]
  );
  return rows[0];
}

// Soft-delete — nunca DELETE físico (Forbidden Action explícita del prompt).
async function softDeleteComprador(id, pid) {
  const { rows } = await db.pool.query(
    `UPDATE compradores SET activo = false, actualizado_en = NOW()
     WHERE id = $1 AND project_id = $2
     RETURNING *`,
    [id, pid]
  );
  if (!rows[0]) {
    const err = new Error('Comprador no encontrado');
    err.status = 404;
    throw err;
  }
  return rows[0];
}

// JOIN a lotes/compradores para que el frontend no tenga que resolver
// nombres por separado — mismo criterio que listLotes en server/lotes.js.
async function listApartados(pid) {
  const { rows } = await db.pool.query(
    `SELECT a.*, l.manzana, l.numero_lote, c.nombre AS comprador_nombre
     FROM apartados a
     JOIN lotes l ON l.id = a.lote_id
     JOIN compradores c ON c.id = a.comprador_id
     WHERE l.project_id = $1
     ORDER BY a.creado_en DESC`,
    [pid]
  );
  return rows;
}

// Crea el apartado y deriva lotes.estatus_venta='apartado' en la MISMA
// transacción. Valida que lote/comprador pertenezcan a la obra (evita IDOR
// cross-obra, mismo criterio que validarModeloDeLaObra en server/lotes.js) y
// que el lote no tenga ya un apartado activo — el índice único parcial en DB
// es la garantía real, esta pre-validación solo da un 400 con mensaje claro
// en vez de un 500 crudo por violación de constraint en el caso normal (aun
// así se captura el 23505 como red de seguridad ante una condición de carrera).
async function crearApartado(pid, { lote_id, comprador_id, monto, fecha, vigencia_hasta }, creadoPor) {
  if (!lote_id || !comprador_id) {
    const err = new Error('lote_id y comprador_id son requeridos');
    err.status = 400;
    throw err;
  }
  const montoNum = Number(monto);
  if (!Number.isFinite(montoNum) || montoNum <= 0) {
    const err = new Error('monto debe ser un número mayor a 0');
    err.status = 400;
    throw err;
  }

  return db.withTransaction(async (client) => {
    const { rows: loteRows } = await client.query(
      'SELECT id, estatus_venta FROM lotes WHERE id = $1 AND project_id = $2 FOR UPDATE', [lote_id, pid]
    );
    if (!loteRows[0]) {
      const err = new Error('El lote no pertenece a esta obra');
      err.status = 400;
      throw err;
    }
    const { rows: compradorRows } = await client.query(
      'SELECT id FROM compradores WHERE id = $1 AND project_id = $2', [comprador_id, pid]
    );
    if (!compradorRows[0]) {
      const err = new Error('El comprador no pertenece a esta obra');
      err.status = 400;
      throw err;
    }
    const { rows: activoRows } = await client.query(
      "SELECT id FROM apartados WHERE lote_id = $1 AND estado = 'activo'", [lote_id]
    );
    if (activoRows[0]) {
      const err = new Error('Este lote ya tiene un apartado activo');
      err.status = 400;
      throw err;
    }

    let nuevo;
    try {
      const { rows } = await client.query(
        `INSERT INTO apartados (lote_id, comprador_id, monto, fecha, vigencia_hasta, creado_por)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [lote_id, comprador_id, montoNum, fecha || new Date().toISOString().slice(0, 10), vigencia_hasta || null, creadoPor]
      );
      nuevo = rows[0];
    } catch (err) {
      if (err.code === '23505') {
        const e = new Error('Este lote ya tiene un apartado activo');
        e.status = 400;
        throw e;
      }
      throw err;
    }

    await client.query("UPDATE lotes SET estatus_venta = 'apartado', actualizado_en = NOW() WHERE id = $1", [lote_id]);
    return nuevo;
  });
}

// Cancela un apartado activo y, si no queda ningún otro apartado activo para
// ese lote, deriva lotes.estatus_venta de vuelta a 'disponible' — siempre
// 'disponible' al cancelar (no "restaura el valor previo"), decisión
// explícita del prompt para no complicar la lógica con historial de estados.
async function cancelarApartado(id, pid) {
  return db.withTransaction(async (client) => {
    const { rows: apartadoRows } = await client.query(
      `SELECT a.* FROM apartados a
       JOIN lotes l ON l.id = a.lote_id
       WHERE a.id = $1 AND l.project_id = $2
       FOR UPDATE OF a`,
      [id, pid]
    );
    if (!apartadoRows[0]) {
      const err = new Error('Apartado no encontrado');
      err.status = 404;
      throw err;
    }
    const apartado = apartadoRows[0];
    if (apartado.estado !== 'activo') {
      const err = new Error(`Este apartado ya no está activo (estado actual: "${apartado.estado}")`);
      err.status = 400;
      throw err;
    }

    const { rows } = await client.query(
      "UPDATE apartados SET estado = 'cancelado' WHERE id = $1 RETURNING *", [id]
    );

    const { rows: otrosActivos } = await client.query(
      "SELECT id FROM apartados WHERE lote_id = $1 AND estado = 'activo'", [apartado.lote_id]
    );
    if (!otrosActivos.length) {
      await client.query("UPDATE lotes SET estatus_venta = 'disponible', actualizado_en = NOW() WHERE id = $1", [apartado.lote_id]);
    }

    return rows[0];
  });
}

module.exports = {
  ESTADO_APARTADO,
  listCompradores,
  createComprador,
  updateComprador,
  softDeleteComprador,
  listApartados,
  crearApartado,
  cancelarApartado,
};
