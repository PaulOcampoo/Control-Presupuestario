'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const multer = require('multer');

const db = require('./db');
const { parseWorkbook } = require('./parser');
const { ingest } = require('./ingest');
const { generatePlanning } = require('./planning');

const app = express();

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Use os.tmpdir() so file uploads work both locally and on Vercel
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.xlsx$/i.test(file.originalname);
    cb(ok ? null : new Error('Solo se admiten archivos .xlsx'), ok);
  },
});

// Wraps async route handlers so Express catches rejected promises
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function requireProject(req, res, next) {
  const id = Number(req.params.id);
  const proj = await db.getProject(id);
  if (!proj) return res.status(404).json({ error: 'Proyecto no encontrado' });
  req.project = proj;
  next();
}

function metaToObject(rows) {
  const o = {};
  for (const r of rows) o[r.clave] = r.valor;
  return o;
}

// ---------------------------------------------------------------------------
// Proyectos
// ---------------------------------------------------------------------------
app.get('/api/projects', h(async (_req, res) => {
  const projects = await db.listProjects();
  const rows = await Promise.all(projects.map(async (p) => {
    const { rows: metaRows } = await db.pool.query(
      'SELECT clave, valor FROM meta WHERE project_id = $1', [p.id]
    );
    const meta = metaToObject(metaRows);
    const { rows: totalRows } = await db.pool.query(
      "SELECT importe FROM conceptos WHERE project_id = $1 AND es_total = 1 AND grupo IS NULL ORDER BY orden DESC LIMIT 1",
      [p.id]
    );
    return {
      id: p.id,
      nombre: p.nombre,
      archivo_original: p.archivo_original,
      creado_en: p.creado_en,
      obra: meta.obra || null,
      lugar: meta.lugar || null,
      inicio_obra: meta.inicio_obra || null,
      fin_obra: meta.fin_obra || null,
      total_sin_iva: meta.total_sin_iva ? Number(meta.total_sin_iva) : (totalRows[0] ? totalRows[0].importe : null),
      total_con_iva: meta.total_con_iva ? Number(meta.total_con_iva) : null,
    };
  }));
  res.json(rows);
}));

app.post('/api/projects', upload.single('archivo'), h(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Sube un archivo .xlsx de presupuesto' });
  const tmpPath = req.file.path;
  try {
    const parsed = await parseWorkbook(tmpPath);
    if (!parsed.conceptos.length && !parsed.insumos.length) {
      throw new Error('No se reconoció una hoja de presupuesto ni de listado de insumos en el archivo. Verifica que tenga el formato esperado (columnas Código, Concepto, Unidad, Cantidad, Precio, Importe).');
    }
    const nombre = parsed.meta.obra || req.file.originalname.replace(/\.xlsx$/i, '');
    const record = await db.createProjectRecord(nombre, req.file.originalname);
    await db.withTransaction((client) => ingest(client, record.id, parsed));
    res.status(201).json({
      id: record.id,
      nombre: record.nombre,
      sheets: parsed.sheets,
      conceptos: parsed.conceptos.length,
      insumos: parsed.insumos.length,
      destajistas: parsed.destajistas ? parsed.destajistas.length : 0,
      inicio_obra: parsed.meta.inicio_obra || null,
      fin_obra: parsed.meta.fin_obra || null,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  } finally {
    fs.rm(tmpPath, () => {});
  }
}));

app.get('/api/projects/:id', h(requireProject), h(async (req, res) => {
  const { rows } = await db.pool.query('SELECT clave, valor FROM meta WHERE project_id = $1', [req.project.id]);
  const meta = metaToObject(rows);
  res.json({ id: req.project.id, nombre: req.project.nombre, archivo_original: req.project.archivo_original, meta });
}));

app.delete('/api/projects/:id', h(requireProject), h(async (req, res) => {
  await db.deleteProject(req.project.id);
  res.json({ ok: true });
}));

app.put('/api/projects/:id/fechas-obra', h(requireProject), h(async (req, res) => {
  const { inicio_obra, fin_obra } = req.body || {};
  if (!inicio_obra || !fin_obra) {
    return res.status(400).json({ error: 'Debes indicar fecha de inicio y fecha de fin de obra' });
  }
  if (fin_obra <= inicio_obra) {
    return res.status(400).json({ error: 'La fecha de fin de obra debe ser posterior a la de inicio' });
  }

  const pid = req.project.id;
  const { rows: avRow } = await db.pool.query(
    'SELECT COUNT(*) AS n FROM avances_semanales WHERE project_id = $1 AND (avance_fisico_real IS NOT NULL OR avance_financiero_real IS NOT NULL)',
    [pid]
  );
  if (Number(avRow[0].n) > 0) {
    return res.status(409).json({
      error: 'Ya hay avance real capturado en este proyecto; cambiar las fechas de obra regeneraría el programa y borraría ese avance.',
    });
  }

  const { rows: conceptoRows } = await db.pool.query('SELECT * FROM conceptos WHERE project_id = $1 ORDER BY orden', [pid]);
  const { rows: metaRows } = await db.pool.query('SELECT clave, valor FROM meta WHERE project_id = $1', [pid]);
  const meta = metaToObject(metaRows);
  meta.inicio_obra = inicio_obra;
  meta.fin_obra = fin_obra;
  const plan = generatePlanning(conceptoRows, meta);

  const upsertMeta = `
    INSERT INTO meta (project_id, clave, valor) VALUES ($1, $2, $3)
    ON CONFLICT (project_id, clave) DO UPDATE SET valor = EXCLUDED.valor
  `;

  await db.withTransaction(async (client) => {
    await client.query(upsertMeta, [pid, 'inicio_obra', inicio_obra]);
    await client.query(upsertMeta, [pid, 'fin_obra', fin_obra]);

    await client.query('DELETE FROM programa_ejecucion WHERE project_id = $1', [pid]);
    for (const p of plan.programa) {
      await client.query(
        `INSERT INTO programa_ejecucion
           (project_id, codigo, concepto, grupo, fecha_inicio, fecha_fin, duracion_dias, importe, peso_pct, orden)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [pid, p.codigo, p.concepto, p.grupo, p.fecha_inicio, p.fecha_fin, p.duracion_dias, p.importe, p.peso_pct, p.orden]
      );
    }

    // Delete avance_conceptos that reference avances of this project before deleting avances_semanales
    await client.query(`
      DELETE FROM avance_conceptos
      WHERE concepto_id IN (SELECT id FROM conceptos WHERE project_id = $1)
    `, [pid]);
    await client.query('DELETE FROM avances_semanales WHERE project_id = $1', [pid]);
    for (const a of plan.avances) {
      await client.query(
        `INSERT INTO avances_semanales
           (project_id, semana, fecha_inicio, fecha_fin, avance_fisico_programado, avance_fisico_real, avance_financiero_programado, avance_financiero_real)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [pid, a.semana, a.fecha_inicio, a.fecha_fin, a.avance_fisico_programado, a.avance_fisico_real, a.avance_financiero_programado, a.avance_financiero_real]
      );
    }
  });

  res.json({ ok: true, inicio_obra, fin_obra, actividades: plan.programa.length, semanas: plan.avances.length });
}));

// ---------------------------------------------------------------------------
// Conceptos
// ---------------------------------------------------------------------------
app.get('/api/projects/:id/conceptos', h(requireProject), h(async (req, res) => {
  const { rows } = await db.pool.query('SELECT * FROM conceptos WHERE project_id = $1 ORDER BY orden', [req.project.id]);
  res.json(rows);
}));

// ---------------------------------------------------------------------------
// Insumos
// ---------------------------------------------------------------------------
app.get('/api/projects/:id/insumos', h(requireProject), h(async (req, res) => {
  const pid = req.project.id;
  const { categoria, q } = req.query;

  let sql = 'SELECT * FROM insumos WHERE project_id = $1';
  const params = [pid];
  let idx = 2;
  if (categoria) { sql += ` AND categoria = $${idx++}`; params.push(categoria); }
  if (q) {
    sql += ` AND (codigo ILIKE $${idx} OR concepto ILIKE $${idx + 1})`;
    params.push(`%${q}%`, `%${q}%`);
    idx += 2;
  }
  sql += ' ORDER BY orden';
  const { rows: insumos } = await db.pool.query(sql, params);

  const { rows: acumuladosRows } = await db.pool.query(`
    SELECT ri.insumo_id,
           SUM(ri.cantidad_solicitada) AS cantidad_acumulada,
           MAX(ri.precio_solicitado) AS precio_max_solicitado
    FROM requisicion_items ri
    JOIN requisiciones r ON r.id = ri.requisicion_id
    WHERE r.project_id = $1 AND r.estado != 'cancelada'
    GROUP BY ri.insumo_id
  `, [pid]);
  const acumulados = new Map(acumuladosRows.map((r) => [r.insumo_id, r]));

  res.json(insumos.map((i) => {
    const acc = acumulados.get(i.id);
    const cantidad_acumulada = acc ? Number(acc.cantidad_acumulada) : 0;
    return {
      ...i,
      cantidad_acumulada,
      cantidad_disponible: i.cantidad_presupuesto - cantidad_acumulada,
      sobrepasado_cantidad: cantidad_acumulada > i.cantidad_presupuesto,
    };
  }));
}));

app.get('/api/projects/:id/insumos/categorias', h(requireProject), h(async (req, res) => {
  const { rows } = await db.pool.query(
    'SELECT DISTINCT categoria FROM insumos WHERE project_id = $1 AND categoria IS NOT NULL ORDER BY categoria',
    [req.project.id]
  );
  res.json(rows.map((r) => r.categoria));
}));

// ---------------------------------------------------------------------------
// Requisiciones
// ---------------------------------------------------------------------------
async function computeAlertsAndTotals(projectId, items, ignoreRequisicionId = null) {
  const out = [];
  for (const it of items) {
    const { rows: insumoRows } = await db.pool.query(
      'SELECT * FROM insumos WHERE id = $1 AND project_id = $2',
      [it.insumo_id, projectId]
    );
    const insumo = insumoRows[0];
    if (!insumo) throw new Error(`Insumo ${it.insumo_id} no existe en el catálogo`);

    let acumSql = `
      SELECT COALESCE(SUM(ri.cantidad_solicitada), 0) AS acumulado
      FROM requisicion_items ri
      JOIN requisiciones r ON r.id = ri.requisicion_id
      WHERE ri.insumo_id = $1 AND r.project_id = $2 AND r.estado != 'cancelada'
    `;
    const acumParams = [it.insumo_id, projectId];
    if (ignoreRequisicionId != null) {
      acumSql += ' AND ri.requisicion_id != $3';
      acumParams.push(ignoreRequisicionId);
    }
    const { rows: acumRows } = await db.pool.query(acumSql, acumParams);
    const acumulado = Number(acumRows[0].acumulado);

    const cantidad = Number(it.cantidad_solicitada) || 0;
    const precio = it.precio_solicitado != null && it.precio_solicitado !== ''
      ? Number(it.precio_solicitado)
      : insumo.precio_presupuesto;

    out.push({
      insumo_id: it.insumo_id,
      insumo,
      cantidad_solicitada: cantidad,
      precio_solicitado: precio,
      importe: Number((cantidad * precio).toFixed(2)),
      alerta_cantidad: (acumulado + cantidad) > insumo.cantidad_presupuesto ? 1 : 0,
      alerta_precio: precio > insumo.precio_presupuesto ? 1 : 0,
      cantidad_acumulada_previa: acumulado,
      observaciones: it.observaciones || null,
    });
  }
  return out;
}

app.get('/api/projects/:id/requisiciones', h(requireProject), h(async (req, res) => {
  const { rows: reqs } = await db.pool.query(
    'SELECT * FROM requisiciones WHERE project_id = $1 ORDER BY id DESC',
    [req.project.id]
  );
  const withTotals = await Promise.all(reqs.map(async (r) => {
    const { rows } = await db.pool.query(`
      SELECT COUNT(*) AS num_items,
             COALESCE(SUM(importe), 0) AS importe_total,
             COALESCE(SUM(alerta_cantidad), 0) AS alertas_cantidad,
             COALESCE(SUM(alerta_precio), 0) AS alertas_precio
      FROM requisicion_items WHERE requisicion_id = $1
    `, [r.id]);
    return { ...r, ...rows[0] };
  }));
  res.json(withTotals);
}));

app.get('/api/projects/:id/requisiciones/:reqId', h(requireProject), h(async (req, res) => {
  const { rows: reqRows } = await db.pool.query(
    'SELECT * FROM requisiciones WHERE id = $1 AND project_id = $2',
    [Number(req.params.reqId), req.project.id]
  );
  if (!reqRows[0]) return res.status(404).json({ error: 'Requisición no encontrada' });
  const { rows: items } = await db.pool.query(`
    SELECT ri.*, i.codigo AS insumo_codigo, i.concepto AS insumo_concepto, i.categoria, i.unidad,
           i.cantidad_presupuesto, i.precio_presupuesto
    FROM requisicion_items ri
    JOIN insumos i ON i.id = ri.insumo_id
    WHERE ri.requisicion_id = $1
    ORDER BY ri.id
  `, [reqRows[0].id]);
  res.json({ ...reqRows[0], items });
}));

app.post('/api/projects/:id/requisiciones', h(requireProject), h(async (req, res) => {
  const pid = req.project.id;
  const { folio, fecha, observaciones, items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'La requisición debe incluir al menos un insumo' });
  }
  try {
    const computed = await computeAlertsAndTotals(pid, items);
    const created = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO requisiciones (project_id, folio, fecha, estado, observaciones)
         VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), 'borrador', $4) RETURNING *`,
        [pid, folio || null, fecha || null, observaciones || null]
      );
      const reqId = rows[0].id;
      for (const c of computed) {
        await client.query(
          `INSERT INTO requisicion_items
             (requisicion_id, insumo_id, cantidad_solicitada, precio_solicitado, importe, alerta_cantidad, alerta_precio, observaciones)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [reqId, c.insumo_id, c.cantidad_solicitada, c.precio_solicitado, c.importe, c.alerta_cantidad, c.alerta_precio, c.observaciones]
        );
      }
      return rows[0];
    });
    res.status(201).json({ ...created, items: computed, tiene_alertas: computed.some((c) => c.alerta_cantidad || c.alerta_precio) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.put('/api/projects/:id/requisiciones/:reqId', h(requireProject), h(async (req, res) => {
  const pid = req.project.id;
  const reqId = Number(req.params.reqId);
  const { rows: existRows } = await db.pool.query(
    'SELECT * FROM requisiciones WHERE id = $1 AND project_id = $2',
    [reqId, pid]
  );
  if (!existRows[0]) return res.status(404).json({ error: 'Requisición no encontrada' });
  if (existRows[0].estado !== 'borrador') {
    return res.status(400).json({ error: 'Solo se pueden editar requisiciones en estado "borrador"' });
  }
  const { folio, fecha, observaciones, items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'La requisición debe incluir al menos un insumo' });
  }
  try {
    const computed = await computeAlertsAndTotals(pid, items, reqId);
    const updated = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE requisiciones SET folio = $1, fecha = COALESCE($2::date, fecha), observaciones = $3
         WHERE id = $4 RETURNING *`,
        [folio || null, fecha || null, observaciones || null, reqId]
      );
      await client.query('DELETE FROM requisicion_items WHERE requisicion_id = $1', [reqId]);
      for (const c of computed) {
        await client.query(
          `INSERT INTO requisicion_items
             (requisicion_id, insumo_id, cantidad_solicitada, precio_solicitado, importe, alerta_cantidad, alerta_precio, observaciones)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [reqId, c.insumo_id, c.cantidad_solicitada, c.precio_solicitado, c.importe, c.alerta_cantidad, c.alerta_precio, c.observaciones]
        );
      }
      return rows[0];
    });
    res.json({ ...updated, items: computed, tiene_alertas: computed.some((c) => c.alerta_cantidad || c.alerta_precio) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.put('/api/projects/:id/requisiciones/:reqId/estado', h(requireProject), h(async (req, res) => {
  const { estado } = req.body || {};
  if (!['borrador', 'enviada', 'autorizada', 'cancelada'].includes(estado)) {
    return res.status(400).json({ error: 'Estado inválido' });
  }
  const reqId = Number(req.params.reqId);
  const { rowCount } = await db.pool.query(
    'UPDATE requisiciones SET estado = $1 WHERE id = $2 AND project_id = $3',
    [estado, reqId, req.project.id]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Requisición no encontrada' });
  res.json({ ok: true });
}));

app.delete('/api/projects/:id/requisiciones/:reqId', h(requireProject), h(async (req, res) => {
  const { rowCount } = await db.pool.query(
    'DELETE FROM requisiciones WHERE id = $1 AND project_id = $2',
    [Number(req.params.reqId), req.project.id]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Requisición no encontrada' });
  res.json({ ok: true });
}));

app.post('/api/projects/:id/requisiciones/preview', h(requireProject), h(async (req, res) => {
  const { items, ignore_requisicion_id } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items debe ser un arreglo' });
  try {
    const computed = await computeAlertsAndTotals(
      req.project.id,
      items,
      ignore_requisicion_id != null ? Number(ignore_requisicion_id) : null
    );
    res.json({ items: computed, tiene_alertas: computed.some((c) => c.alerta_cantidad || c.alerta_precio) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// ---------------------------------------------------------------------------
// Programa de ejecución
// ---------------------------------------------------------------------------
app.get('/api/projects/:id/programa', h(requireProject), h(async (req, res) => {
  const { rows } = await db.pool.query(`
    SELECT pe.id, pe.codigo, pe.concepto, pe.grupo, pe.fecha_inicio, pe.fecha_fin,
           pe.duracion_dias, pe.importe, pe.peso_pct, pe.orden,
           CASE
             WHEN c.cantidad > 0 THEN
               LEAST(100.0, ROUND(CAST(COALESCE(SUM(ac.cantidad_ejecutada), 0) / c.cantidad * 100.0 AS NUMERIC), 1))
             ELSE 0
           END AS avance_pct
    FROM programa_ejecucion pe
    LEFT JOIN conceptos c
      ON c.codigo = pe.codigo
     AND (c.grupo = pe.grupo OR (c.grupo IS NULL AND pe.grupo IS NULL))
     AND c.project_id = pe.project_id
     AND c.es_total = 0 AND c.cantidad > 0
    LEFT JOIN avance_conceptos ac ON ac.concepto_id = c.id
    WHERE pe.project_id = $1
    GROUP BY pe.id, pe.codigo, pe.concepto, pe.grupo, pe.fecha_inicio, pe.fecha_fin,
             pe.duracion_dias, pe.importe, pe.peso_pct, pe.orden, c.cantidad
    ORDER BY pe.orden
  `, [req.project.id]);
  res.json(rows);
}));

app.put('/api/projects/:id/programa/:itemId', h(requireProject), h(async (req, res) => {
  const pid = req.project.id;
  const itemId = Number(req.params.itemId);
  const { rows: existRows } = await db.pool.query(
    'SELECT * FROM programa_ejecucion WHERE id = $1 AND project_id = $2',
    [itemId, pid]
  );
  if (!existRows[0]) return res.status(404).json({ error: 'Actividad del programa no encontrada' });

  const { fecha_inicio, fecha_fin } = req.body || {};
  if (!fecha_inicio || !fecha_fin) {
    return res.status(400).json({ error: 'Debes indicar fecha de inicio y fecha de fin' });
  }
  if (fecha_fin < fecha_inicio) {
    return res.status(400).json({ error: 'La fecha de fin no puede ser anterior a la fecha de inicio' });
  }
  const { rows: metaRows } = await db.pool.query('SELECT clave, valor FROM meta WHERE project_id = $1', [pid]);
  const meta = metaToObject(metaRows);
  if (meta.inicio_obra && fecha_inicio < meta.inicio_obra) {
    return res.status(400).json({ error: `La fecha de inicio no puede ser anterior al inicio de obra (${meta.inicio_obra})` });
  }
  if (meta.fin_obra && fecha_fin > meta.fin_obra) {
    return res.status(400).json({ error: `La fecha de fin no puede ser posterior al fin de obra (${meta.fin_obra})` });
  }
  const duracion_dias = Math.round((new Date(`${fecha_fin}T00:00:00`) - new Date(`${fecha_inicio}T00:00:00`)) / 86400000) + 1;
  const { rows } = await db.pool.query(
    'UPDATE programa_ejecucion SET fecha_inicio = $1, fecha_fin = $2, duracion_dias = $3 WHERE id = $4 RETURNING *',
    [fecha_inicio, fecha_fin, duracion_dias, itemId]
  );
  res.json(rows[0]);
}));

// ---------------------------------------------------------------------------
// Avances semanales
// ---------------------------------------------------------------------------
app.get('/api/projects/:id/avances', h(requireProject), h(async (req, res) => {
  const { rows } = await db.pool.query(
    'SELECT * FROM avances_semanales WHERE project_id = $1 ORDER BY semana',
    [req.project.id]
  );
  res.json(rows);
}));

app.put('/api/projects/:id/avances/:semana', h(requireProject), h(async (req, res) => {
  const pid = req.project.id;
  const semana = Number(req.params.semana);
  const { rows: existRows } = await db.pool.query(
    'SELECT id FROM avances_semanales WHERE project_id = $1 AND semana = $2',
    [pid, semana]
  );
  if (!existRows[0]) return res.status(404).json({ error: 'Semana no encontrada' });

  const clamp = (v) => (v == null || v === '' ? null : Math.max(0, Math.min(100, Number(v))));
  const { avance_fisico_real, avance_financiero_real } = req.body || {};
  const { rows } = await db.pool.query(`
    UPDATE avances_semanales
    SET avance_fisico_real = COALESCE($1, avance_fisico_real),
        avance_financiero_real = COALESCE($2, avance_financiero_real)
    WHERE project_id = $3 AND semana = $4
    RETURNING *
  `, [clamp(avance_fisico_real), clamp(avance_financiero_real), pid, semana]);
  res.json(rows[0]);
}));

async function presupuestoTotalDe(projectId) {
  const { rows: metaRows } = await db.pool.query('SELECT clave, valor FROM meta WHERE project_id = $1', [projectId]);
  const meta = metaToObject(metaRows);
  if (meta.total_sin_iva) return Number(meta.total_sin_iva);
  const { rows } = await db.pool.query(
    "SELECT importe FROM conceptos WHERE project_id = $1 AND es_total = 1 AND grupo IS NULL ORDER BY orden DESC LIMIT 1",
    [projectId]
  );
  return rows[0] ? rows[0].importe : 0;
}

app.get('/api/projects/:id/avances/:semana/conceptos', h(requireProject), h(async (req, res) => {
  const pid = req.project.id;
  const semana = Number(req.params.semana);
  const { rows: existRows } = await db.pool.query(
    'SELECT id FROM avances_semanales WHERE project_id = $1 AND semana = $2',
    [pid, semana]
  );
  if (!existRows[0]) return res.status(404).json({ error: 'Semana no encontrada' });

  const { rows: conceptos } = await db.pool.query(`
    SELECT id AS concepto_id, codigo, concepto, unidad, grupo,
           cantidad AS cantidad_presupuesto, precio_unitario, importe AS importe_presupuesto
    FROM conceptos
    WHERE project_id = $1 AND es_total = 0 AND cantidad > 0 AND TRIM(COALESCE(unidad, '')) <> ''
    ORDER BY orden
  `, [pid]);

  const { rows: previos } = await db.pool.query(`
    SELECT ac.concepto_id, COALESCE(SUM(ac.cantidad_ejecutada), 0) AS total
    FROM avance_conceptos ac
    JOIN conceptos c ON c.id = ac.concepto_id
    WHERE c.project_id = $1 AND ac.semana < $2
    GROUP BY ac.concepto_id
  `, [pid, semana]);
  const acumPrevioMap = Object.fromEntries(previos.map((p) => [p.concepto_id, Number(p.total)]));

  const { rows: actuales } = await db.pool.query(`
    SELECT ac.concepto_id, ac.cantidad_ejecutada
    FROM avance_conceptos ac
    JOIN conceptos c ON c.id = ac.concepto_id
    WHERE c.project_id = $1 AND ac.semana = $2
  `, [pid, semana]);
  const actualMap = Object.fromEntries(actuales.map((a) => [a.concepto_id, a.cantidad_ejecutada]));

  const items = conceptos.map((c) => {
    const acumulada_previa = acumPrevioMap[c.concepto_id] || 0;
    const ejecutada_periodo = Object.prototype.hasOwnProperty.call(actualMap, c.concepto_id) ? actualMap[c.concepto_id] : null;
    const acumulada_actual = acumulada_previa + (ejecutada_periodo || 0);
    return {
      ...c,
      cantidad_acumulada_previa: acumulada_previa,
      cantidad_ejecutada_periodo: ejecutada_periodo,
      cantidad_acumulada_actual: acumulada_actual,
      importe_ejecutado_acumulado: acumulada_actual * c.precio_unitario,
    };
  });
  res.json({ semana, items });
}));

app.put('/api/projects/:id/avances/:semana/conceptos', h(requireProject), h(async (req, res) => {
  const pid = req.project.id;
  const semana = Number(req.params.semana);
  const { rows: existRows } = await db.pool.query(
    'SELECT id FROM avances_semanales WHERE project_id = $1 AND semana = $2',
    [pid, semana]
  );
  if (!existRows[0]) return res.status(404).json({ error: 'Semana no encontrada' });

  const { items } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items debe ser un arreglo' });

  await db.withTransaction(async (client) => {
    for (const it of items) {
      const conceptoId = Number(it.concepto_id);
      if (!conceptoId) continue;
      const cantidad = it.cantidad_ejecutada == null || it.cantidad_ejecutada === ''
        ? 0 : Math.max(0, Number(it.cantidad_ejecutada));
      await client.query(`
        INSERT INTO avance_conceptos (semana, concepto_id, cantidad_ejecutada)
        VALUES ($1, $2, $3)
        ON CONFLICT (semana, concepto_id) DO UPDATE SET cantidad_ejecutada = EXCLUDED.cantidad_ejecutada, actualizado_en = NOW()
      `, [semana, conceptoId, cantidad]);
    }
  });

  const totalPresupuesto = await presupuestoTotalDe(pid);
  let pctReal = null;
  if (totalPresupuesto > 0) {
    const { rows: acumRows } = await db.pool.query(`
      SELECT COALESCE(SUM(ac.cantidad_ejecutada * c.precio_unitario), 0) AS importe
      FROM avance_conceptos ac
      JOIN conceptos c ON c.id = ac.concepto_id
      WHERE c.project_id = $1 AND ac.semana <= $2
    `, [pid, semana]);
    pctReal = Math.max(0, Math.min(100, (Number(acumRows[0].importe) / totalPresupuesto) * 100));
    await db.pool.query(
      'UPDATE avances_semanales SET avance_fisico_real = $1, avance_financiero_real = $2 WHERE project_id = $3 AND semana = $4',
      [pctReal, pctReal, pid, semana]
    );
  }

  const { rows: detalle } = await db.pool.query(`
    SELECT ac.concepto_id, ac.cantidad_ejecutada
    FROM avance_conceptos ac
    JOIN conceptos c ON c.id = ac.concepto_id
    WHERE c.project_id = $1 AND ac.semana = $2
  `, [pid, semana]);
  const { rows: avRows } = await db.pool.query(
    'SELECT * FROM avances_semanales WHERE project_id = $1 AND semana = $2',
    [pid, semana]
  );
  res.json({ ok: true, semana, avance_calculado_pct: pctReal, avance: avRows[0], items: detalle });
}));

// ---------------------------------------------------------------------------
// Resumen / dashboard
// ---------------------------------------------------------------------------
app.get('/api/projects/:id/resumen', h(requireProject), h(async (req, res) => {
  const pid = req.project.id;
  const { rows: metaRows } = await db.pool.query('SELECT clave, valor FROM meta WHERE project_id = $1', [pid]);
  const meta = metaToObject(metaRows);
  const { rows: totalRows } = await db.pool.query(
    "SELECT importe FROM conceptos WHERE project_id = $1 AND es_total = 1 AND grupo IS NULL ORDER BY orden DESC LIMIT 1",
    [pid]
  );
  const total = meta.total_sin_iva ? Number(meta.total_sin_iva) : (totalRows[0] ? totalRows[0].importe : 0);

  const { rows: ultimoRows } = await db.pool.query(`
    SELECT * FROM avances_semanales
    WHERE project_id = $1 AND avance_financiero_real IS NOT NULL
    ORDER BY semana DESC LIMIT 1
  `, [pid]);
  const ultimoAvance = ultimoRows[0];

  const hoy = new Date().toISOString().slice(0, 10);
  const { rows: semActualRows } = await db.pool.query(`
    SELECT * FROM avances_semanales WHERE project_id = $1 AND fecha_inicio <= $2 AND fecha_fin >= $2 ORDER BY semana LIMIT 1
  `, [pid, hoy]);
  const { rows: primerRows } = await db.pool.query(
    'SELECT * FROM avances_semanales WHERE project_id = $1 ORDER BY semana LIMIT 1', [pid]
  );
  const { rows: ultimaRows } = await db.pool.query(
    'SELECT * FROM avances_semanales WHERE project_id = $1 ORDER BY semana DESC LIMIT 1', [pid]
  );

  let programadoActual = semActualRows[0] || null;
  if (!programadoActual && primerRows[0] && hoy < primerRows[0].fecha_inicio) {
    programadoActual = { avance_financiero_programado: 0 };
  }
  if (!programadoActual && ultimaRows[0] && hoy > ultimaRows[0].fecha_fin) {
    programadoActual = ultimaRows[0];
  }

  const { rows: reqRows } = await db.pool.query(`
    SELECT COUNT(DISTINCT r.id) AS num_requisiciones,
           COALESCE(SUM(ri.importe), 0) AS importe_requisitado,
           COALESCE(SUM(ri.alerta_cantidad), 0) AS alertas_cantidad,
           COALESCE(SUM(ri.alerta_precio), 0) AS alertas_precio
    FROM requisiciones r
    LEFT JOIN requisicion_items ri ON ri.requisicion_id = r.id
    WHERE r.project_id = $1 AND r.estado != 'cancelada'
  `, [pid]);

  const pctEjecutado = ultimoAvance ? ultimoAvance.avance_financiero_real : 0;
  const pctProgramado = programadoActual ? programadoActual.avance_financiero_programado : 0;
  res.json({
    meta,
    presupuesto_total: total,
    avance_financiero_programado_actual: pctProgramado,
    avance_financiero_ejecutado_actual: pctEjecutado,
    importe_ejecutado: Number((total * (pctEjecutado / 100)).toFixed(2)),
    importe_programado: Number((total * (pctProgramado / 100)).toFixed(2)),
    importe_por_ejecutar: Number((total * (1 - pctEjecutado / 100)).toFixed(2)),
    requisiciones: reqRows[0],
  });
}));

// ---------------------------------------------------------------------------
// Destajistas (piecework workers)
// ---------------------------------------------------------------------------
app.get('/api/projects/:id/destajistas', h(requireProject), h(async (req, res) => {
  const pid = req.project.id;
  const { rows: dests } = await db.pool.query(
    'SELECT * FROM destajistas WHERE project_id = $1 ORDER BY orden, id',
    [pid]
  );
  const result = await Promise.all(dests.map(async (d) => {
    const { rows: items } = await db.pool.query(`
      SELECT di.id, di.project_id, di.destajista_id, di.concepto_id, di.codigo, di.concepto, di.unidad,
             di.cantidad_asignada, di.precio_destajo, di.orden,
             c.grupo AS partida_grupo,
             c.codigo AS partida_codigo,
             c.concepto AS partida_concepto,
             c.cantidad AS partida_cantidad_presupuesto,
             c.precio_unitario AS partida_precio_unitario,
             COALESCE(ad.total, 0) AS cantidad_ejecutada
      FROM destajo_items di
      LEFT JOIN conceptos c ON c.id = di.concepto_id
      LEFT JOIN (SELECT destajo_item_id, SUM(cantidad_ejecutada) AS total FROM avance_destajo GROUP BY destajo_item_id) ad
        ON ad.destajo_item_id = di.id
      WHERE di.destajista_id = $1
      ORDER BY di.orden, di.id
    `, [d.id]);
    const totalAsignado = items.reduce((s, i) => s + (Number(i.cantidad_asignada) * Number(i.precio_destajo)), 0);
    const totalGanado = items.reduce((s, i) => s + (Number(i.cantidad_ejecutada) * Number(i.precio_destajo)), 0);
    const pctAvance = totalAsignado > 0 ? Math.min(100, (totalGanado / totalAsignado) * 100) : 0;
    return { ...d, items, total_asignado: totalAsignado, total_ganado: totalGanado, pct_avance: pctAvance };
  }));
  res.json(result);
}));

app.post('/api/projects/:id/destajistas', h(requireProject), h(async (req, res) => {
  const { nombre, telefono } = req.body || {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre del destajista es requerido' });
  const { rows } = await db.pool.query(
    'INSERT INTO destajistas (project_id, nombre, telefono) VALUES ($1, $2, $3) RETURNING *',
    [req.project.id, nombre.trim(), telefono?.trim() || null]
  );
  res.status(201).json(rows[0]);
}));

app.put('/api/projects/:id/destajistas/:destId', h(requireProject), h(async (req, res) => {
  const { nombre, telefono } = req.body || {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre del destajista es requerido' });
  const { rows } = await db.pool.query(
    'UPDATE destajistas SET nombre = $1, telefono = $2 WHERE id = $3 AND project_id = $4 RETURNING *',
    [nombre.trim(), telefono?.trim() || null, Number(req.params.destId), req.project.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Destajista no encontrado' });
  res.json(rows[0]);
}));

app.delete('/api/projects/:id/destajistas/:destId', h(requireProject), h(async (req, res) => {
  const { rowCount } = await db.pool.query(
    'DELETE FROM destajistas WHERE id = $1 AND project_id = $2',
    [Number(req.params.destId), req.project.id]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Destajista no encontrado' });
  res.json({ ok: true });
}));

app.post('/api/projects/:id/destajistas/:destId/items', h(requireProject), h(async (req, res) => {
  const pid = req.project.id;
  const destId = Number(req.params.destId);
  const { rows: destRows } = await db.pool.query(
    'SELECT id FROM destajistas WHERE id = $1 AND project_id = $2',
    [destId, pid]
  );
  if (!destRows[0]) return res.status(404).json({ error: 'Destajista no encontrado' });

  let { concepto_id, codigo, concepto, unidad, cantidad_asignada, precio_destajo } = req.body || {};
  if (!concepto?.trim()) return res.status(400).json({ error: 'El concepto es requerido' });

  if (concepto_id) {
    const { rows: cRows } = await db.pool.query(
      'SELECT codigo, concepto, unidad FROM conceptos WHERE id = $1 AND project_id = $2',
      [Number(concepto_id), pid]
    );
    if (cRows[0]) { codigo = cRows[0].codigo; concepto = cRows[0].concepto; unidad = cRows[0].unidad; }
  }

  const { rows } = await db.pool.query(
    `INSERT INTO destajo_items
       (project_id, destajista_id, concepto_id, codigo, concepto, unidad, cantidad_asignada, precio_destajo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [pid, destId, concepto_id ? Number(concepto_id) : null, codigo?.trim() || null, concepto.trim(),
     unidad?.trim() || null, Math.max(0, Number(cantidad_asignada) || 0), Math.max(0, Number(precio_destajo) || 0)]
  );
  res.status(201).json(rows[0]);
}));

app.put('/api/projects/:id/destajistas/:destId/items/:itemId', h(requireProject), h(async (req, res) => {
  const pid = req.project.id;
  const itemId = Number(req.params.itemId);
  const { cantidad_asignada, precio_destajo } = req.body || {};
  const { rows } = await db.pool.query(
    `UPDATE destajo_items
     SET cantidad_asignada = COALESCE($1, cantidad_asignada),
         precio_destajo    = COALESCE($2, precio_destajo)
     WHERE id = $3 AND project_id = $4
     RETURNING *`,
    [
      cantidad_asignada != null ? Math.max(0, Number(cantidad_asignada)) : null,
      precio_destajo    != null ? Math.max(0, Number(precio_destajo))    : null,
      itemId, pid,
    ]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Actividad no encontrada' });
  res.json(rows[0]);
}));

app.delete('/api/projects/:id/destajistas/:destId/items/:itemId', h(requireProject), h(async (req, res) => {
  const { rowCount } = await db.pool.query(
    'DELETE FROM destajo_items WHERE id = $1 AND project_id = $2',
    [Number(req.params.itemId), req.project.id]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Actividad no encontrada' });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Avance de destajo por periodo — usa las mismas semanas del programa de obra
// (avances_semanales) para que el avance de cada destajista se capture en
// los mismos periodos que el resto del proyecto.
// ---------------------------------------------------------------------------
app.get('/api/projects/:id/destajistas/:destId/avance', h(requireProject), h(async (req, res) => {
  const pid = req.project.id;
  const destId = Number(req.params.destId);
  const { rows: destRows } = await db.pool.query(
    'SELECT id, nombre FROM destajistas WHERE id = $1 AND project_id = $2',
    [destId, pid]
  );
  if (!destRows[0]) return res.status(404).json({ error: 'Destajista no encontrado' });

  const { rows: totalRows } = await db.pool.query(
    'SELECT COALESCE(SUM(cantidad_asignada * precio_destajo), 0) AS total FROM destajo_items WHERE destajista_id = $1',
    [destId]
  );
  const totalAsignado = Number(totalRows[0].total);

  const { rows: semanas } = await db.pool.query(`
    SELECT av.semana, av.fecha_inicio, av.fecha_fin,
           COALESCE(SUM(ad.cantidad_ejecutada * di.precio_destajo), 0) AS ganado_periodo
    FROM avances_semanales av
    LEFT JOIN destajo_items di ON di.destajista_id = $2
    LEFT JOIN avance_destajo ad ON ad.destajo_item_id = di.id AND ad.semana = av.semana
    WHERE av.project_id = $1
    GROUP BY av.semana, av.fecha_inicio, av.fecha_fin
    ORDER BY av.semana
  `, [pid, destId]);

  let acumulado = 0;
  const result = semanas.map((s) => {
    acumulado += Number(s.ganado_periodo);
    return {
      semana: s.semana,
      fecha_inicio: s.fecha_inicio,
      fecha_fin: s.fecha_fin,
      ganado_periodo: Number(s.ganado_periodo),
      ganado_acumulado: acumulado,
      pct_acumulado: totalAsignado > 0 ? Math.min(100, (acumulado / totalAsignado) * 100) : 0,
    };
  });

  res.json({ destajista_id: destId, total_asignado: totalAsignado, semanas: result });
}));

app.get('/api/projects/:id/destajistas/:destId/avance/:semana', h(requireProject), h(async (req, res) => {
  const pid = req.project.id;
  const destId = Number(req.params.destId);
  const semana = Number(req.params.semana);
  const { rows: destRows } = await db.pool.query(
    'SELECT id, nombre FROM destajistas WHERE id = $1 AND project_id = $2',
    [destId, pid]
  );
  if (!destRows[0]) return res.status(404).json({ error: 'Destajista no encontrado' });
  const { rows: semRows } = await db.pool.query(
    'SELECT id, fecha_inicio, fecha_fin FROM avances_semanales WHERE project_id = $1 AND semana = $2',
    [pid, semana]
  );
  if (!semRows[0]) return res.status(404).json({ error: 'Semana no encontrada' });

  const { rows: items } = await db.pool.query(`
    SELECT di.id AS destajo_item_id, di.codigo, di.concepto, di.unidad, di.cantidad_asignada, di.precio_destajo,
           COALESCE(prev.total, 0) AS cantidad_acumulada_previa,
           cur.cantidad_ejecutada AS cantidad_ejecutada_periodo
    FROM destajo_items di
    LEFT JOIN (
      SELECT destajo_item_id, SUM(cantidad_ejecutada) AS total
      FROM avance_destajo WHERE semana < $2 GROUP BY destajo_item_id
    ) prev ON prev.destajo_item_id = di.id
    LEFT JOIN avance_destajo cur ON cur.destajo_item_id = di.id AND cur.semana = $2
    WHERE di.destajista_id = $1
    ORDER BY di.orden, di.id
  `, [destId, semana]);

  res.json({ semana, destajista: destRows[0], periodo: semRows[0], items });
}));

app.put('/api/projects/:id/destajistas/:destId/avance/:semana', h(requireProject), h(async (req, res) => {
  const pid = req.project.id;
  const destId = Number(req.params.destId);
  const semana = Number(req.params.semana);
  const { rows: destRows } = await db.pool.query(
    'SELECT id FROM destajistas WHERE id = $1 AND project_id = $2',
    [destId, pid]
  );
  if (!destRows[0]) return res.status(404).json({ error: 'Destajista no encontrado' });
  const { rows: semRows } = await db.pool.query(
    'SELECT id FROM avances_semanales WHERE project_id = $1 AND semana = $2',
    [pid, semana]
  );
  if (!semRows[0]) return res.status(404).json({ error: 'Semana no encontrada' });

  const { items } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items debe ser un arreglo' });

  const { rows: validRows } = await db.pool.query('SELECT id FROM destajo_items WHERE destajista_id = $1', [destId]);
  const validIds = new Set(validRows.map((r) => r.id));

  await db.withTransaction(async (client) => {
    for (const it of items) {
      const itemId = Number(it.destajo_item_id);
      if (!validIds.has(itemId)) continue;
      const cantidad = it.cantidad_ejecutada == null || it.cantidad_ejecutada === ''
        ? 0 : Math.max(0, Number(it.cantidad_ejecutada));
      await client.query(`
        INSERT INTO avance_destajo (semana, destajo_item_id, cantidad_ejecutada)
        VALUES ($1, $2, $3)
        ON CONFLICT (semana, destajo_item_id) DO UPDATE SET cantidad_ejecutada = EXCLUDED.cantidad_ejecutada, actualizado_en = NOW()
      `, [semana, itemId, cantidad]);
    }
  });

  res.json({ ok: true, semana });
}));

// ---------------------------------------------------------------------------
app.get('/health', (_req, res) => res.json({ ok: true }));

// Global error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Error interno del servidor' });
});

module.exports = app;
