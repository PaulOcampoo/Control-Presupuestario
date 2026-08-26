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

// Cierra un hueco detectado durante PR B: hasta antes de esto, un lote
// recién creado nace 'no_disponible' (default de la columna, ver
// server/lotes.js createLote) y el ÚNICO camino de código que produce
// 'disponible' era cancelarApartado — es decir, un lote sin ningún interés
// de compra real quedaba atrapado en 'no_disponible' para siempre, salvo
// crear-y-cancelar un apartado ficticio como workaround. Transición
// exclusivamente 'no_disponible' -> 'disponible' — 'apartado' y 'vendido'
// tienen su propio flujo de reversión (cancelarApartado / cancelarContratoVenta)
// y no deben tocarse desde aquí (evita pisar un apartado/contrato vigente).
async function marcarLoteDisponible(loteId, pid) {
  return db.withTransaction(async (client) => {
    const { rows: loteRows } = await client.query(
      'SELECT id, estatus_venta FROM lotes WHERE id = $1 AND project_id = $2 FOR UPDATE', [loteId, pid]
    );
    if (!loteRows[0]) {
      const err = new Error('El lote no pertenece a esta obra');
      err.status = 400;
      throw err;
    }
    if (loteRows[0].estatus_venta !== 'no_disponible') {
      const err = new Error(`Solo se puede marcar disponible un lote "no_disponible" (estatus actual: "${loteRows[0].estatus_venta}") — un lote apartado o vendido se revierte cancelando ese apartado/contrato, no desde aquí`);
      err.status = 400;
      throw err;
    }
    const { rows } = await client.query(
      "UPDATE lotes SET estatus_venta = 'disponible', actualizado_en = NOW() WHERE id = $1 RETURNING *", [loteId]
    );
    return rows[0];
  });
}

// ---------------------------------------------------------------------------
// Contrato de compraventa — Fase 4, PR B (prompt-implementacion-pr-b-
// contrato-venta.md). Adjunto simple (pdf_url/pdf_filename), SIN extracción
// vía IA — Forbidden Action explícita, mismo criterio que contratos_trabajador
// (server/db.js). Activa 'vendido' en lotes.estatus_venta, que quedó
// preparado pero inalcanzable en PR A.
// ---------------------------------------------------------------------------
const ESTADO_CONTRATO_VENTA = ['vigente', 'cancelado'];

// total_pagado/saldo_pendiente/estado_pago (PR C, cobranza) van aquí
// también — no solo en getCobranzaContrato — para que la tabla de "Contrato
// de Venta" Y la de "Cobranza" puedan mostrar el badge de estado a simple
// vista sin una llamada extra por contrato (N+1). Se calculan en JS, no en
// SQL, para reusar exactamente el mismo criterio (estadoPagoDe) que el
// resto de este módulo — LEFT JOIN solo trae la suma ya agregada.
async function listContratosVenta(pid) {
  const { rows } = await db.pool.query(
    `SELECT cv.*, l.manzana, l.numero_lote, c.nombre AS comprador_nombre,
            COALESCE(pv.total_pagado, 0) AS total_pagado
     FROM contratos_venta cv
     JOIN lotes l ON l.id = cv.lote_id
     JOIN compradores c ON c.id = cv.comprador_id
     LEFT JOIN (
       SELECT contrato_venta_id, SUM(monto) AS total_pagado
       FROM pagos_venta GROUP BY contrato_venta_id
     ) pv ON pv.contrato_venta_id = cv.id
     WHERE l.project_id = $1
     ORDER BY cv.creado_en DESC`,
    [pid]
  );
  return rows.map((r) => {
    const totalPagado = Number(r.total_pagado);
    const montoTotal = Number(r.monto_total);
    return {
      ...r,
      total_pagado: totalPagado,
      saldo_pendiente: montoTotal - totalPagado,
      estado_pago: estadoPagoDe(totalPagado, montoTotal),
    };
  });
}

// Crea el contrato y deriva lotes.estatus_venta='vendido' en la MISMA
// transacción. Dos caminos, mutuamente excluyentes según si se manda
// apartado_id:
//   - Con apartado_id: el apartado debe estar 'activo' y pertenecer al MISMO
//     lote/comprador que el contrato (evita que alguien firme un contrato
//     "desde" el apartado de otra persona) — pasa a 'convertido_a_contrato'.
//   - Sin apartado_id (venta directa): el lote debe estar 'disponible' — no
//     se puede vender por esta vía algo ya apartado por otro comprador sin
//     pasar por ese apartado.
// monto_total NUNCA se deriva de precio_efectivo ni del monto del apartado
// — siempre es lo que capture el caller (precio final negociado).
async function crearContratoVenta(pid, {
  lote_id, comprador_id, apartado_id, monto_total, fecha_firma, pdf_url, pdf_filename,
}, creadoPor) {
  if (!lote_id || !comprador_id) {
    const err = new Error('lote_id y comprador_id son requeridos');
    err.status = 400;
    throw err;
  }
  const montoNum = Number(monto_total);
  if (!Number.isFinite(montoNum) || montoNum <= 0) {
    const err = new Error('monto_total debe ser un número mayor a 0');
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

    if (apartado_id != null) {
      const { rows: apartadoRows } = await client.query(
        `SELECT a.* FROM apartados a
         JOIN lotes l ON l.id = a.lote_id
         WHERE a.id = $1 AND l.project_id = $2
         FOR UPDATE OF a`,
        [apartado_id, pid]
      );
      const apartado = apartadoRows[0];
      if (!apartado) {
        const err = new Error('El apartado no pertenece a esta obra');
        err.status = 400;
        throw err;
      }
      if (apartado.estado !== 'activo') {
        const err = new Error(`El apartado no está activo (estado actual: "${apartado.estado}")`);
        err.status = 400;
        throw err;
      }
      if (apartado.lote_id !== lote_id || apartado.comprador_id !== comprador_id) {
        const err = new Error('El apartado no corresponde a este lote/comprador');
        err.status = 400;
        throw err;
      }
      await client.query("UPDATE apartados SET estado = 'convertido_a_contrato' WHERE id = $1", [apartado_id]);
    } else if (loteRows[0].estatus_venta !== 'disponible') {
      const err = new Error(`Venta directa solo permitida sobre un lote "disponible" (estatus actual: "${loteRows[0].estatus_venta}") — si el lote tiene un apartado activo, crea el contrato desde ese apartado`);
      err.status = 400;
      throw err;
    }

    let nuevo;
    try {
      const { rows } = await client.query(
        `INSERT INTO contratos_venta (lote_id, comprador_id, apartado_id, monto_total, fecha_firma, pdf_url, pdf_filename, creado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [lote_id, comprador_id, apartado_id ?? null, montoNum, fecha_firma || null, pdf_url || null, pdf_filename || null, creadoPor]
      );
      nuevo = rows[0];
    } catch (err) {
      if (err.code === '23505') {
        const e = new Error('Este lote ya tiene un contrato vigente');
        e.status = 400;
        throw e;
      }
      throw err;
    }

    await client.query("UPDATE lotes SET estatus_venta = 'vendido', actualizado_en = NOW() WHERE id = $1", [lote_id]);
    return nuevo;
  });
}

// Edición limitada — SOLO pdf_url/pdf_filename/fecha_firma. monto_total (y
// lote_id/comprador_id/apartado_id/estado) nunca se leen de `data`: si se
// necesita corregir un monto ya firmado, se cancela y se crea uno nuevo
// (decisión explícita del prompt, no una omisión).
async function updateContratoVenta(id, pid, data) {
  const { rows: existRows } = await db.pool.query(
    `SELECT cv.* FROM contratos_venta cv JOIN lotes l ON l.id = cv.lote_id
     WHERE cv.id = $1 AND l.project_id = $2`,
    [id, pid]
  );
  if (!existRows[0]) {
    const err = new Error('Contrato no encontrado');
    err.status = 404;
    throw err;
  }
  const actual = existRows[0];
  const campos = {
    fecha_firma: data.fecha_firma !== undefined ? (data.fecha_firma || null) : actual.fecha_firma,
    pdf_url: data.pdf_url !== undefined ? (data.pdf_url || null) : actual.pdf_url,
    pdf_filename: data.pdf_filename !== undefined ? (data.pdf_filename || null) : actual.pdf_filename,
  };
  const { rows } = await db.pool.query(
    `UPDATE contratos_venta SET fecha_firma=$1, pdf_url=$2, pdf_filename=$3
     WHERE id = $4
     RETURNING *`,
    [campos.fecha_firma, campos.pdf_url, campos.pdf_filename, id]
  );
  return rows[0];
}

// Cancela un contrato vigente y deriva lotes.estatus_venta de vuelta a
// 'disponible' — el apartado original (si existió) NUNCA se reactiva
// automáticamente (simplificación explícita del prompt, ver comentario del
// CHECK en server/db.js): queda 'convertido_a_contrato' para siempre, salvo
// una acción manual aparte fuera de este PR.
//
// PR C (cobranza): si el contrato ya tiene pagos_venta registrados, la
// cancelación NO se bloquea ni los pagos se tocan (decisión confirmada
// explícitamente — mismo criterio "avisar sin bloquear" del resto de este
// PR) — la respuesta incluye total_pagado/saldo_pendiente y una
// `advertencia` explícita para que el admin lo vea en el momento y decida
// aparte si hace falta reconciliar/reembolsar.
async function cancelarContratoVenta(id, pid) {
  return db.withTransaction(async (client) => {
    const { rows: contratoRows } = await client.query(
      `SELECT cv.* FROM contratos_venta cv
       JOIN lotes l ON l.id = cv.lote_id
       WHERE cv.id = $1 AND l.project_id = $2
       FOR UPDATE OF cv`,
      [id, pid]
    );
    if (!contratoRows[0]) {
      const err = new Error('Contrato no encontrado');
      err.status = 404;
      throw err;
    }
    const contrato = contratoRows[0];
    if (contrato.estado !== 'vigente') {
      const err = new Error(`Este contrato ya no está vigente (estado actual: "${contrato.estado}")`);
      err.status = 400;
      throw err;
    }

    const { rows } = await client.query(
      "UPDATE contratos_venta SET estado = 'cancelado' WHERE id = $1 RETURNING *", [id]
    );
    await client.query("UPDATE lotes SET estatus_venta = 'disponible', actualizado_en = NOW() WHERE id = $1", [contrato.lote_id]);

    const saldo = await calcularSaldo(client, id, Number(contrato.monto_total));
    const advertencia = saldo.total_pagado > EPSILON_MONTO
      ? `Este contrato ya tenía ${saldo.total_pagado.toFixed(2)} pagado(s) (saldo previo: ${saldo.saldo_pendiente.toFixed(2)}) — los pagos NO se cancelan ni se reembolsan automáticamente, revisa "Cobranza" si hace falta reconciliar.`
      : null;

    return { ...rows[0], ...saldo, advertencia };
  });
}

// ---------------------------------------------------------------------------
// Override de emergencia (prompt-override-emergencia-estatus-venta.md) — NO
// reemplaza los flujos normales (apartar/cancelar/contratar/marcar-disponible)
// ni los bypassea por comodidad: es un escape auditado para casos no
// previstos donde ninguno de esos flujos permite llegar al estatus correcto.
// A propósito NO cancela apartados/contratos relacionados — solo informa de
// su existencia (ids) en la respuesta, para que el admin decida esa parte
// por separado. El registro en audit_log va en la MISMA transacción que el
// cambio de estatus: si el log falla, el estatus tampoco cambia (Forbidden
// Action explícita del prompt — nunca un cambio de estatus sin rastro).
const ESTATUS_VENTA_LOTE = ['no_disponible', 'disponible', 'apartado', 'vendido'];

async function forzarEstatusVenta(loteId, pid, { nuevo_estatus, motivo }, actor, ip) {
  if (!ESTATUS_VENTA_LOTE.includes(nuevo_estatus)) {
    const err = new Error(`nuevo_estatus debe ser uno de: ${ESTATUS_VENTA_LOTE.join(', ')}`);
    err.status = 400;
    throw err;
  }
  if (!motivo || !String(motivo).trim()) {
    const err = new Error('motivo es requerido');
    err.status = 400;
    throw err;
  }
  const motivoTrim = String(motivo).trim();

  return db.withTransaction(async (client) => {
    const { rows: loteRows } = await client.query(
      'SELECT id, estatus_venta FROM lotes WHERE id = $1 AND project_id = $2 FOR UPDATE', [loteId, pid]
    );
    if (!loteRows[0]) {
      const err = new Error('El lote no pertenece a esta obra');
      err.status = 400;
      throw err;
    }
    const estatusAnterior = loteRows[0].estatus_venta;

    const { rows: apartadoActivoRows } = await client.query(
      "SELECT id FROM apartados WHERE lote_id = $1 AND estado = 'activo'", [loteId]
    );
    const { rows: contratoVigenteRows } = await client.query(
      "SELECT id FROM contratos_venta WHERE lote_id = $1 AND estado = 'vigente'", [loteId]
    );
    const apartadoActivoId = apartadoActivoRows[0]?.id ?? null;
    const contratoVigenteId = contratoVigenteRows[0]?.id ?? null;

    const { rows } = await client.query(
      'UPDATE lotes SET estatus_venta = $1, actualizado_en = NOW() WHERE id = $2 RETURNING *',
      [nuevo_estatus, loteId]
    );

    await client.query(
      `INSERT INTO audit_log (actor_id, actor_usuario, accion, target_id, project_id, ip, detalle)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [actor.id, actor.usuario, 'lote_forzar_estatus_venta', loteId, pid, ip,
        JSON.stringify({
          estatus_anterior: estatusAnterior,
          estatus_nuevo: nuevo_estatus,
          motivo: motivoTrim,
          apartado_activo_id: apartadoActivoId,
          contrato_vigente_id: contratoVigenteId,
        })]
    );

    return { lote: rows[0], apartado_activo_id: apartadoActivoId, contrato_vigente_id: contratoVigenteId };
  });
}

async function listEstatusVentaHistorial(pid) {
  const { rows } = await db.pool.query(
    `SELECT al.id, al.target_id AS lote_id, al.creado_en, al.detalle,
            COALESCE(u.nombre, al.actor_usuario) AS actor_nombre,
            l.manzana, l.numero_lote
     FROM audit_log al
     LEFT JOIN usuarios u ON u.id = al.actor_id
     LEFT JOIN lotes l ON l.id = al.target_id
     WHERE al.project_id = $1 AND al.accion = 'lote_forzar_estatus_venta'
     ORDER BY al.creado_en DESC
     LIMIT 300`,
    [pid]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Cobranza — Fase 4, PR C (prompt-implementacion-pr-c-cobranza.md). Plan de
// pagos (opcional, encabezado+líneas, mismo patrón DELETE+re-INSERT que
// estimacion_conceptos en server/app.js) y registro de pagos recibidos de
// compradores. Diagnóstico confirmó que `pagos` (compras) NO es reusable —
// `orden_compra_id NOT NULL` lo hace incompatible: ese dinero SALE de
// Roforb, este ENTRA. estado_pago NUNCA se persiste — se calcula al vuelo
// (total_pagado/saldo_pendiente) para no sincronizar un campo derivado más.
//
// Criterio "avisar sin bloquear" (mismo que alerta_destajo en Nómina):
// descuadre del plan vs monto_total y sobrepago NUNCA rechazan la
// operación — devuelven `advertencia` explícita en la respuesta para que
// el admin decida. EPSILON_MONTO absorbe solo el ruido de punto flotante,
// no discrepancias reales.
// ---------------------------------------------------------------------------
const EPSILON_MONTO = 0.01;

function estadoPagoDe(totalPagado, montoTotal) {
  if (totalPagado <= EPSILON_MONTO) return 'pendiente';
  if (totalPagado + EPSILON_MONTO < montoTotal) return 'parcial';
  return 'liquidado';
}

// Valida que el contrato pertenezca a la obra y devuelve su monto_total —
// mismo criterio de integridad cross-obra que el resto de Ventas (JOIN a
// lotes para filtrar por project_id, ver crearContratoVenta).
async function getContratoVentaDeLaObra(client, contratoVentaId, pid) {
  const { rows } = await client.query(
    `SELECT cv.* FROM contratos_venta cv
     JOIN lotes l ON l.id = cv.lote_id
     WHERE cv.id = $1 AND l.project_id = $2`,
    [contratoVentaId, pid]
  );
  if (!rows[0]) {
    const err = new Error('El contrato de venta no pertenece a esta obra');
    err.status = 400;
    throw err;
  }
  return rows[0];
}

async function calcularSaldo(client, contratoVentaId, montoTotal) {
  const { rows } = await client.query(
    'SELECT COALESCE(SUM(monto), 0) AS total FROM pagos_venta WHERE contrato_venta_id = $1', [contratoVentaId]
  );
  const totalPagado = Number(rows[0].total);
  const saldoPendiente = montoTotal - totalPagado;
  return { total_pagado: totalPagado, saldo_pendiente: saldoPendiente, estado_pago: estadoPagoDe(totalPagado, montoTotal) };
}

async function getPlanPago(contratoVentaId, pid) {
  const { rows: contratoRows } = await db.pool.query(
    `SELECT cv.id FROM contratos_venta cv JOIN lotes l ON l.id = cv.lote_id
     WHERE cv.id = $1 AND l.project_id = $2`,
    [contratoVentaId, pid]
  );
  if (!contratoRows[0]) {
    const err = new Error('El contrato de venta no pertenece a esta obra');
    err.status = 400;
    throw err;
  }
  const { rows: planRows } = await db.pool.query(
    'SELECT * FROM planes_pago WHERE contrato_venta_id = $1', [contratoVentaId]
  );
  if (!planRows[0]) return { plan: null, items: [] };
  const { rows: items } = await db.pool.query(
    'SELECT * FROM plan_pago_items WHERE plan_pago_id = $1 ORDER BY orden, id', [planRows[0].id]
  );
  return { plan: planRows[0], items };
}

// Crea o reemplaza el plan de pagos completo de un contrato en una sola
// operación (encabezado+líneas) — mismo patrón DELETE+re-INSERT que
// estimacion_conceptos, no hay historial de versiones del plan, solo el
// vigente. NO bloquea si SUM(items) no cuadra con monto_total — Forbidden
// Action explícita del prompt — solo devuelve `advertencia`.
async function guardarPlanPago(contratoVentaId, pid, items, creadoPor) {
  if (!Array.isArray(items) || !items.length) {
    const err = new Error('El plan debe tener al menos un concepto');
    err.status = 400;
    throw err;
  }
  const itemsLimpios = items.map((it, idx) => {
    const concepto = String(it?.concepto || '').trim();
    const monto = Number(it?.monto_programado);
    if (!concepto) {
      const err = new Error(`El concepto del renglón ${idx + 1} es requerido`);
      err.status = 400;
      throw err;
    }
    if (!Number.isFinite(monto) || monto <= 0) {
      const err = new Error(`monto_programado del renglón ${idx + 1} debe ser un número mayor a 0`);
      err.status = 400;
      throw err;
    }
    return {
      concepto,
      monto,
      fecha_programada: it?.fecha_programada || null,
      orden: it?.orden != null ? Number(it.orden) : idx,
    };
  });

  return db.withTransaction(async (client) => {
    const contrato = await getContratoVentaDeLaObra(client, contratoVentaId, pid);

    let planId;
    const { rows: existente } = await client.query(
      'SELECT id FROM planes_pago WHERE contrato_venta_id = $1', [contratoVentaId]
    );
    if (existente[0]) {
      planId = existente[0].id;
    } else {
      const { rows: nuevo } = await client.query(
        'INSERT INTO planes_pago (contrato_venta_id, creado_por) VALUES ($1,$2) RETURNING id',
        [contratoVentaId, creadoPor]
      );
      planId = nuevo[0].id;
    }

    await client.query('DELETE FROM plan_pago_items WHERE plan_pago_id = $1', [planId]);
    for (const it of itemsLimpios) {
      await client.query(
        `INSERT INTO plan_pago_items (plan_pago_id, concepto, fecha_programada, monto_programado, orden)
         VALUES ($1,$2,$3,$4,$5)`,
        [planId, it.concepto, it.fecha_programada, it.monto, it.orden]
      );
    }

    const { rows: planRows } = await client.query('SELECT * FROM planes_pago WHERE id = $1', [planId]);
    const { rows: itemRows } = await client.query(
      'SELECT * FROM plan_pago_items WHERE plan_pago_id = $1 ORDER BY orden, id', [planId]
    );

    const sumaPlan = itemsLimpios.reduce((s, it) => s + it.monto, 0);
    const advertencia = Math.abs(sumaPlan - contrato.monto_total) > EPSILON_MONTO
      ? `La suma del plan (${sumaPlan.toFixed(2)}) no coincide con el monto del contrato (${Number(contrato.monto_total).toFixed(2)})`
      : null;

    return { plan: planRows[0], items: itemRows, advertencia };
  });
}

// Registra un pago recibido. Si trae plan_pago_item_id, valida que ese ítem
// pertenezca al plan de ESTE contrato (evita registrar un pago "contra" el
// ítem del plan de otro contrato). NO bloquea sobrepago — solo advierte.
async function registrarPagoVenta(contratoVentaId, pid, {
  monto, fecha_pago, metodo_pago, referencia, plan_pago_item_id,
}, registradoPor) {
  const montoNum = Number(monto);
  if (!Number.isFinite(montoNum) || montoNum <= 0) {
    const err = new Error('monto debe ser un número mayor a 0');
    err.status = 400;
    throw err;
  }

  return db.withTransaction(async (client) => {
    const contrato = await getContratoVentaDeLaObra(client, contratoVentaId, pid);

    if (plan_pago_item_id != null) {
      const { rows: itemRows } = await client.query(
        `SELECT ppi.id FROM plan_pago_items ppi
         JOIN planes_pago pp ON pp.id = ppi.plan_pago_id
         WHERE ppi.id = $1 AND pp.contrato_venta_id = $2`,
        [plan_pago_item_id, contratoVentaId]
      );
      if (!itemRows[0]) {
        const err = new Error('El ítem del plan no corresponde a este contrato');
        err.status = 400;
        throw err;
      }
    }

    const { rows } = await client.query(
      `INSERT INTO pagos_venta (contrato_venta_id, plan_pago_item_id, monto, fecha_pago, metodo_pago, referencia, registrado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [contratoVentaId, plan_pago_item_id ?? null, montoNum, fecha_pago || new Date().toISOString().slice(0, 10),
        metodo_pago || null, referencia || null, registradoPor]
    );

    const saldo = await calcularSaldo(client, contratoVentaId, Number(contrato.monto_total));
    const advertencia = saldo.saldo_pendiente < -EPSILON_MONTO
      ? `Sobrepago: el total pagado (${saldo.total_pagado.toFixed(2)}) supera el monto del contrato (${Number(contrato.monto_total).toFixed(2)})`
      : null;

    return { pago: rows[0], ...saldo, advertencia };
  });
}

// Detalle de cobranza de un contrato: saldo/estado calculados al vuelo +
// historial de pagos — pensado para pintar la vista completa del tab
// Cobranza de un contrato en una sola llamada.
async function getCobranzaContrato(contratoVentaId, pid) {
  const contrato = await getContratoVentaDeLaObra(db.pool, contratoVentaId, pid);
  const saldo = await calcularSaldo(db.pool, contratoVentaId, Number(contrato.monto_total));
  const { rows: pagos } = await db.pool.query(
    `SELECT pv.*, COALESCE(u.nombre, '—') AS registrado_por_nombre
     FROM pagos_venta pv
     LEFT JOIN usuarios u ON u.id = pv.registrado_por
     WHERE pv.contrato_venta_id = $1
     ORDER BY pv.fecha_pago DESC, pv.creado_en DESC`,
    [contratoVentaId]
  );
  const planPago = await getPlanPago(contratoVentaId, pid);
  return {
    contrato_venta_id: contratoVentaId,
    monto_total: Number(contrato.monto_total),
    ...saldo,
    pagos,
    plan: planPago.plan,
    plan_items: planPago.items,
  };
}

// ---------------------------------------------------------------------------
// Entrega de lote — Fase 4, PR D (prompt-implementacion-pr-d-entregas.md),
// último del roadmap Desarrollador de Vivienda. Cierra el ciclo formal:
// requiere un contrato_venta vigente (no se entrega sin venta) y reusa
// lotes.estatus (Fase 1, construcción: sin_iniciar/en_proceso/terminado/
// entregado) — NO crea un estatus de entrega paralelo (Forbidden Action
// explícita). Ojo: esto es DISTINTO de lotes.estatus_venta (ya 'vendido'
// desde crearContratoVenta) — esta función nunca toca estatus_venta.
//
// Mismo criterio "avisar sin bloquear" que el resto de la Fase 4: saldo
// pendiente en el contrato NUNCA bloquea la entrega (decisión confirmada
// por Paul) — solo se refleja como `advertencia` en la respuesta.
// ---------------------------------------------------------------------------
async function crearEntrega(loteId, pid, { fecha, firma_digital, recibido_por, observaciones }, entregadoPor) {
  const recibidoPorTrim = String(recibido_por || '').trim();
  if (!recibidoPorTrim) {
    const err = new Error('recibido_por es requerido');
    err.status = 400;
    throw err;
  }

  return db.withTransaction(async (client) => {
    const { rows: loteRows } = await client.query(
      'SELECT id FROM lotes WHERE id = $1 AND project_id = $2 FOR UPDATE', [loteId, pid]
    );
    if (!loteRows[0]) {
      const err = new Error('El lote no pertenece a esta obra');
      err.status = 400;
      throw err;
    }

    const { rows: contratoRows } = await client.query(
      "SELECT * FROM contratos_venta WHERE lote_id = $1 AND estado = 'vigente'", [loteId]
    );
    const contrato = contratoRows[0];
    if (!contrato) {
      const err = new Error('No se puede entregar un lote sin un contrato de venta vigente');
      err.status = 400;
      throw err;
    }

    const { rows: entregaExistente } = await client.query(
      'SELECT id FROM entregas_lote WHERE lote_id = $1', [loteId]
    );
    if (entregaExistente[0]) {
      const err = new Error('Este lote ya tiene una entrega registrada');
      err.status = 400;
      throw err;
    }

    const fechaEntrega = fecha || new Date().toISOString().slice(0, 10);

    let nueva;
    try {
      const { rows } = await client.query(
        `INSERT INTO entregas_lote (lote_id, contrato_venta_id, fecha, firma_digital, recibido_por, entregado_por, observaciones)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [loteId, contrato.id, fechaEntrega, firma_digital || null, recibidoPorTrim, entregadoPor, observaciones || null]
      );
      nueva = rows[0];
    } catch (err) {
      if (err.code === '23505') {
        const e = new Error('Este lote ya tiene una entrega registrada');
        e.status = 400;
        throw e;
      }
      throw err;
    }

    await client.query(
      "UPDATE lotes SET estatus = 'entregado', fecha_entrega_real = $1, actualizado_en = NOW() WHERE id = $2",
      [fechaEntrega, loteId]
    );

    const saldo = await calcularSaldo(client, contrato.id, Number(contrato.monto_total));
    const advertencia = saldo.saldo_pendiente > EPSILON_MONTO
      ? `Este lote se entrega con saldo pendiente de ${saldo.saldo_pendiente.toFixed(2)} en su contrato de venta — no se bloquea la entrega, revisa "Cobranza" si hace falta dar seguimiento.`
      : null;

    return { ...nueva, ...saldo, advertencia };
  });
}

// Lista todos los contratos vigentes (pendientes de entregar y ya
// entregados) en una sola llamada — mismo shape que listContratosVenta
// (reusa exactamente ese SELECT/JOIN) más el LEFT JOIN a entregas_lote: los
// campos el.* llegan NULL cuando aún no hay entrega, que es justo cómo el
// frontend distingue "pendiente de entregar" de "ya entregado" sin tener
// que interpretar lotes.estatus por separado.
async function listEntregasVenta(pid) {
  const { rows } = await db.pool.query(
    `SELECT cv.*, l.manzana, l.numero_lote, c.nombre AS comprador_nombre,
            COALESCE(pv.total_pagado, 0) AS total_pagado,
            el.id AS entrega_id, el.fecha AS entrega_fecha, el.recibido_por,
            el.firma_digital, el.observaciones
     FROM contratos_venta cv
     JOIN lotes l ON l.id = cv.lote_id
     JOIN compradores c ON c.id = cv.comprador_id
     LEFT JOIN (
       SELECT contrato_venta_id, SUM(monto) AS total_pagado
       FROM pagos_venta GROUP BY contrato_venta_id
     ) pv ON pv.contrato_venta_id = cv.id
     LEFT JOIN entregas_lote el ON el.contrato_venta_id = cv.id
     WHERE l.project_id = $1 AND cv.estado = 'vigente'
     ORDER BY cv.creado_en DESC`,
    [pid]
  );
  return rows.map((r) => {
    const totalPagado = Number(r.total_pagado);
    const montoTotal = Number(r.monto_total);
    return {
      ...r,
      total_pagado: totalPagado,
      saldo_pendiente: montoTotal - totalPagado,
      estado_pago: estadoPagoDe(totalPagado, montoTotal),
    };
  });
}

module.exports = {
  ESTADO_APARTADO,
  ESTADO_CONTRATO_VENTA,
  listCompradores,
  createComprador,
  updateComprador,
  softDeleteComprador,
  listApartados,
  crearApartado,
  cancelarApartado,
  marcarLoteDisponible,
  listContratosVenta,
  crearContratoVenta,
  updateContratoVenta,
  cancelarContratoVenta,
  ESTATUS_VENTA_LOTE,
  forzarEstatusVenta,
  listEstatusVentaHistorial,
  getPlanPago,
  guardarPlanPago,
  registrarPagoVenta,
  getCobranzaContrato,
  crearEntrega,
  listEntregasVenta,
};
