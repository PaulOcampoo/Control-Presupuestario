// Integration tests para prompt-fix-total-inflado-presupuesto.md (las 4
// capas del fix, diagnosticado en prompt-diagnostico-URGENTE-total-inflado-
// presupuesto.md) — bug real de datos financieros: "Actualizar presupuesto"
// inflaba el total al re-sumar filas de pie de página mal clasificadas por
// el parser ($6,200,493.68 calculado vs. $1,867,618.58 correcto contra el
// archivo real de un contrato real). Corren de punta a punta (HTTP real +
// DB real + Blob real), no solo contra el parser aislado — el riesgo real
// vivía en total_nuevo (preview) y en la corrupción PERMANENTE de
// meta.total_sin_iva al confirmar (server/reintegracionPresupuesto.js).
// Mismo patrón de fixture/blob real que tests/reprocesar-destajo-
// matrices.test.js.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { put, del } from '@vercel/blob';
import app from '../server/app.js';
import db from '../server/db.js';
import { parseWorkbook } from '../server/parser.js';
import { presupuestoTotalDe } from '../server/finanzas.js';
import { aplicarCambiosConceptos, emparejarConceptos, totalConfiableDesdeParse } from '../server/reintegracionPresupuesto.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const FIXTURE_PATH = path.join(process.cwd(), 'tests/fixtures/Ppto_C_715_Infra_Vinte_29082026.xlsx');
const TOTAL_CORRECTO = 1867618.58;
const TOTAL_INFLADO_BUG_ORIGINAL = 6200493.68; // cifra exacta reportada/reproducida antes del fix — nunca debe volver a salir

const sufijo = Date.now();
let adminToken;
let clienteId;
let proyectoId;
let archivoUrl;

describe('parseWorkbook contra el archivo real — Capas 3 y 4 (parser)', () => {
  it('detecta exactamente 9 partidas reales y excluye las filas de pie de página mal ubicadas', async () => {
    const parsed = await parseWorkbook(FIXTURE_PATH);
    const reales = parsed.conceptos.filter((c) => !c.es_total);
    expect(reales).toHaveLength(9);
    // Las 3 filas de pie de página (etiqueta en Código, Concepto vacío) ya
    // no aparecen como conceptos sueltos con es_total=0 -- Capa 3 (guard
    // revisa también código) las excluye de raíz (continue), nunca llegan a
    // items.
    const pieDePagina = parsed.conceptos.filter((c) => /TOTAL DEL PRESUPUESTO|^IVA/.test(c.codigo || ''));
    expect(pieDePagina).toHaveLength(0);
    // Suma de las 9 partidas reales = el total correcto, sin re-sumar nada
    // de más.
    const sumaReales = reales.reduce((s, c) => s + Number(c.importe), 0);
    expect(Number(sumaReales.toFixed(2))).toBe(TOTAL_CORRECTO);
  });

  it('totalConfiableDesdeParse() da el total correcto, tomado de meta.total_sin_iva', async () => {
    const parsed = await parseWorkbook(FIXTURE_PATH);
    expect(parsed.meta.total_sin_iva).toBe(TOTAL_CORRECTO);
    expect(totalConfiableDesdeParse(parsed)).toBe(TOTAL_CORRECTO);
  });
});

describe('POST /actualizar/preview y /confirmar contra el archivo real — Capas 1 y 2, de punta a punta', () => {
  beforeAll(async () => {
    if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada — no se puede correr la suite.');
    const loginRes = await request(app).post('/api/auth/login').send({ usuario: ADMIN_USER, password: ADMIN_PASSWORD });
    if (loginRes.status !== 200 || !loginRes.body.token) {
      throw new Error(`Login admin falló: ${loginRes.status} ${JSON.stringify(loginRes.body)}`);
    }
    adminToken = loginRes.body.token;

    const { rows: [{ id: clId }] } = await db.pool.query(
      'INSERT INTO clientes (nombre) VALUES ($1) RETURNING id', [`QA_TOTALINFLADO_CLIENTE_${sufijo}`]
    );
    clienteId = clId;
    const { rows: [{ id: pId }] } = await db.pool.query(
      'INSERT INTO proyectos (nombre, cliente_id) VALUES ($1, $2) RETURNING id', [`QA_TOTALINFLADO_OBRA_${sufijo}`, clienteId]
    );
    proyectoId = pId;

    const buffer = fs.readFileSync(FIXTURE_PATH);
    const blobResult = await put(`total-inflado-presupuesto/vitest-${sufijo}.xlsx`, buffer, {
      access: 'private', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    archivoUrl = blobResult.url;
  }, 30000);

  afterAll(async () => {
    if (proyectoId) {
      await db.pool.query('DELETE FROM avance_conceptos WHERE concepto_id IN (SELECT id FROM conceptos WHERE project_id = $1)', [proyectoId]);
      await db.pool.query('DELETE FROM avances_semanales WHERE project_id = $1', [proyectoId]);
      await db.pool.query('DELETE FROM programa_ejecucion WHERE project_id = $1', [proyectoId]);
      await db.pool.query('DELETE FROM conceptos WHERE project_id = $1', [proyectoId]);
      await db.pool.query('DELETE FROM meta WHERE project_id = $1', [proyectoId]);
      await db.pool.query('DELETE FROM proyectos WHERE id = $1', [proyectoId]);
    }
    if (clienteId) await db.pool.query('DELETE FROM clientes WHERE id = $1', [clienteId]);
    if (archivoUrl) await del(archivoUrl).catch(() => {});
  });

  it('preview: total_nuevo es el correcto, nunca la cifra inflada del bug original', async () => {
    const res = await request(app)
      .post(`/api/projects/${proyectoId}/presupuesto/actualizar/preview`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ archivo_url: archivoUrl });
    expect(res.status).toBe(200);
    expect(res.body.total_nuevo).toBe(TOTAL_CORRECTO);
    expect(res.body.total_nuevo).not.toBe(TOTAL_INFLADO_BUG_ORIGINAL);
    // Sobre un proyecto recién creado (sin conceptos), las 9 partidas reales
    // son "nuevas" -- ninguna fila de pie de página/encabezado debe colarse
    // como concepto nuevo.
    expect(res.body.nuevos).toHaveLength(9);
  });

  it('confirmar: meta.total_sin_iva en DB queda en el valor correcto — no se corrompe permanentemente (Capa 2)', async () => {
    const res = await request(app)
      .post(`/api/projects/${proyectoId}/presupuesto/actualizar/confirmar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ archivo_url: archivoUrl, confirmado: true });
    expect(res.status).toBe(200);
    expect(res.body.total_nuevo).toBe(TOTAL_CORRECTO);

    // No solo la respuesta HTTP -- el valor persistido en la tabla `meta`
    // directamente, que es lo que corrompía permanentemente antes del fix.
    const { rows } = await db.pool.query(
      "SELECT valor FROM meta WHERE project_id = $1 AND clave = 'total_sin_iva'", [proyectoId]
    );
    expect(Number(rows[0].valor)).toBe(TOTAL_CORRECTO);

    // presupuestoTotalDe() -- la misma función que alimenta Resumen/
    // Finanzas/Dashboard en toda la app -- debe coincidir tras el confirm.
    const totalOficial = await presupuestoTotalDe(proyectoId);
    expect(Number(totalOficial)).toBe(TOTAL_CORRECTO);

    const { rows: conceptosActivos } = await db.pool.query(
      'SELECT count(*) FROM conceptos WHERE project_id = $1 AND es_total = 0 AND activo = 1', [proyectoId]
    );
    expect(Number(conceptosActivos[0].count)).toBe(9);
  });
});

describe('aplicarCambiosConceptos — regresión de Órdenes de Cambio (sin totalConfianzaExcel)', () => {
  let clienteId2;
  let proyectoId2;
  let conceptoId;

  beforeAll(async () => {
    const { rows: [{ id: clId }] } = await db.pool.query(
      'INSERT INTO clientes (nombre) VALUES ($1) RETURNING id', [`QA_TOTALINFLADO_OC_CLIENTE_${sufijo}`]
    );
    clienteId2 = clId;
    const { rows: [{ id: pId }] } = await db.pool.query(
      'INSERT INTO proyectos (nombre, cliente_id) VALUES ($1, $2) RETURNING id', [`QA_TOTALINFLADO_OC_OBRA_${sufijo}`, clienteId2]
    );
    proyectoId2 = pId;
    const { rows: [{ id: cId }] } = await db.pool.query(
      `INSERT INTO conceptos (project_id, codigo, concepto, unidad, cantidad, precio_unitario, importe, es_total, activo, orden)
       VALUES ($1, 'QA_OC_1', 'QA concepto OC', 'M', 10, 100, 1000, 0, 1, 1) RETURNING id`, [proyectoId2]
    );
    conceptoId = cId;
  });

  afterAll(async () => {
    if (proyectoId2) {
      await db.pool.query('DELETE FROM avance_conceptos WHERE concepto_id IN (SELECT id FROM conceptos WHERE project_id = $1)', [proyectoId2]);
      await db.pool.query('DELETE FROM conceptos WHERE project_id = $1', [proyectoId2]);
      await db.pool.query('DELETE FROM meta WHERE project_id = $1', [proyectoId2]);
      await db.pool.query('DELETE FROM proyectos WHERE id = $1', [proyectoId2]);
    }
    if (clienteId2) await db.pool.query('DELETE FROM clientes WHERE id = $1', [clienteId2]);
    await db.pool.end();
  });

  it('sin totalConfianzaExcel (caller de Órdenes de Cambio): sigue re-sumando conceptos como antes', async () => {
    const { rows: existentes } = await db.pool.query(
      'SELECT id, codigo, concepto, unidad, cantidad, precio_unitario, importe, grupo, es_total, orden, activo FROM conceptos WHERE project_id = $1', [proyectoId2]
    );
    // Simula lo que hace una Orden de Cambio: un concepto nuevo capturado a
    // mano, sin ningún Excel de por medio.
    const itemsNuevo = [
      ...existentes.map((e) => ({ codigo: e.codigo, concepto: e.concepto, unidad: e.unidad, cantidad: Number(e.cantidad), precio_unitario: Number(e.precio_unitario), importe: Number(e.importe), grupo: e.grupo, es_total: 0, orden: e.orden })),
      { codigo: 'QA_OC_2', concepto: 'QA concepto agregado por OC', unidad: 'PZA', cantidad: 5, precio_unitario: 200, importe: 1000, grupo: null, es_total: 0, orden: 2 },
    ];
    const { emparejados, nuevos, historicos } = emparejarConceptos(itemsNuevo, existentes);

    let totalFinal;
    await db.withTransaction(async (client) => {
      ({ totalFinal } = await aplicarCambiosConceptos(client, proyectoId2, { emparejados, nuevos, historicos }));
      // sin 4to argumento -- exactamente como lo llama server/ordenesCambio.js
    });

    // 1000 (concepto original) + 1000 (concepto nuevo de la OC) = 2000,
    // calculado por re-sumado -- comportamiento sin cambios.
    expect(totalFinal).toBe(2000);
    const { rows: metaRows } = await db.pool.query(
      "SELECT valor FROM meta WHERE project_id = $1 AND clave = 'total_sin_iva'", [proyectoId2]
    );
    expect(Number(metaRows[0].valor)).toBe(2000);
  });

  it('con totalConfianzaExcel: usa ese valor tal cual, ignora el re-sumado real de conceptos', async () => {
    const { rows: existentes } = await db.pool.query(
      'SELECT id, codigo, concepto, unidad, cantidad, precio_unitario, importe, grupo, es_total, orden, activo FROM conceptos WHERE project_id = $1', [proyectoId2]
    );
    const { emparejados, nuevos, historicos } = emparejarConceptos(existentes.map((e) => ({ codigo: e.codigo, concepto: e.concepto, unidad: e.unidad, cantidad: Number(e.cantidad), precio_unitario: Number(e.precio_unitario), importe: Number(e.importe), grupo: e.grupo, es_total: 0, orden: e.orden })), existentes);

    let totalFinal;
    await db.withTransaction(async (client) => {
      ({ totalFinal } = await aplicarCambiosConceptos(client, proyectoId2, { emparejados, nuevos, historicos }, 999999.99));
    });

    // El re-sumado real de conceptos daría 2000 (del test anterior) -- pero
    // con totalConfianzaExcel se usa el valor pasado tal cual, sin tocar la
    // suma real de la DB.
    expect(totalFinal).toBe(999999.99);
    const { rows: metaRows } = await db.pool.query(
      "SELECT valor FROM meta WHERE project_id = $1 AND clave = 'total_sin_iva'", [proyectoId2]
    );
    expect(Number(metaRows[0].valor)).toBe(999999.99);
  });
});
