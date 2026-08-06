// Integration tests para Control Financiero Fase 1
// (prompt-27-control-financiero-fase1.md) — Ingresos y Gastos Indirectos
// Corporativos, ambos gateados por auth.requireControlFinancieroAccess
// (whitelist de usuario_id [46, 8] = Paul/Fer, server/auth.js), nunca por
// rol. Corren contra la base de datos real apuntada por DATABASE_URL.
//
// NOTA sobre el token de Paul/Fer: no existe forma de loguearse como esas
// cuentas reales sin su password (no disponible ni apropiado de usar aquí).
// En vez de eso se firma un JWT propio con el mismo SESSION_SECRET que ya
// usa el proceso del servidor (jwt.sign, mismo payload que auth.signToken)
// — verifica el gate real (requireControlFinancieroAccess evaluando
// req.user.id) sin tocar la cuenta ni la contraseña de nadie. Los datos que
// este archivo inserta se limpian en afterAll con DELETE directo (no existe
// endpoint DELETE para estas tablas — regla dura del módulo).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;

let adminToken; // usuario real autenticado pero FUERA de la whitelist
let paulToken;
let ferToken;
let testProjectId;
let facturaId;
let gastoConObraId;
let gastoSinObraId;

function tokenPara(id, nombre, usuario, puesto) {
  return jwt.sign({ id, nombre, usuario, puesto }, SESSION_SECRET, { expiresIn: '15m', algorithm: 'HS256' });
}

beforeAll(async () => {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada — no se puede correr la suite.');
  if (!SESSION_SECRET) throw new Error('SESSION_SECRET no configurada — no se puede correr la suite.');

  const loginRes = await request(app).post('/api/auth/login').send({ usuario: ADMIN_USER, password: ADMIN_PASSWORD });
  if (loginRes.status !== 200 || !loginRes.body.token) {
    throw new Error(`Login admin falló: ${loginRes.status} ${JSON.stringify(loginRes.body)}`);
  }
  adminToken = loginRes.body.token;
  if (loginRes.body.user.id === 46 || loginRes.body.user.id === 8) {
    throw new Error('La cuenta admin de pruebas coincide con la whitelist — ajustar el test.');
  }

  paulToken = tokenPara(46, 'PAUL OCAMPO', 'paul.ocmp', 'desarrollador');
  ferToken = tokenPara(8, 'Fernando Olvera Monroy', 'folvera', 'admin');

  const { rows } = await db.pool.query('SELECT id FROM proyectos ORDER BY id LIMIT 1');
  if (!rows[0]) throw new Error('No hay ningún proyecto contra el cual correr la suite.');
  testProjectId = rows[0].id;
});

afterAll(async () => {
  if (facturaId) await db.pool.query('DELETE FROM facturas WHERE id = $1', [facturaId]);
  if (gastoConObraId) await db.pool.query('DELETE FROM gastos_indirectos_corporativos WHERE id = $1', [gastoConObraId]);
  if (gastoSinObraId) await db.pool.query('DELETE FROM gastos_indirectos_corporativos WHERE id = $1', [gastoSinObraId]);
  await db.pool.end();
});

describe('Control Financiero — whitelist (nunca por rol)', () => {
  it('GET /control-financiero/ingresos — usuario admin fuera de whitelist recibe 403', async () => {
    const res = await request(app)
      .get(`/api/control-financiero/ingresos?project_id=${testProjectId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(403);
  });

  it('GET /control-financiero/gastos-indirectos — usuario admin fuera de whitelist recibe 403', async () => {
    const res = await request(app)
      .get('/api/control-financiero/gastos-indirectos')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(403);
  });

  it('GET /control-financiero/ingresos — Paul (id 46, whitelist) recibe 200', async () => {
    const res = await request(app)
      .get(`/api/control-financiero/ingresos?project_id=${testProjectId}`)
      .set('Authorization', `Bearer ${paulToken}`);
    expect(res.status).toBe(200);
  });

  it('GET /control-financiero/gastos-indirectos — Fer (id 8, whitelist) recibe 200', async () => {
    const res = await request(app)
      .get('/api/control-financiero/gastos-indirectos')
      .set('Authorization', `Bearer ${ferToken}`);
    expect(res.status).toBe(200);
  });
});

describe('Control Financiero — Ingresos', () => {
  it('POST /control-financiero/ingresos — crea factura con observaciones', async () => {
    const res = await request(app)
      .post('/api/control-financiero/ingresos')
      .set('Authorization', `Bearer ${paulToken}`)
      .send({
        project_id: testProjectId, folio: 'QA-VITEST-001', concepto: 'Factura de prueba vitest',
        fecha_emision: '2026-08-06', monto_subtotal: 1000, iva: 160, monto_total: 1160,
        observaciones: 'fila de prueba, eliminada en afterAll',
      });
    expect(res.status).toBe(201);
    expect(res.body.observaciones).toBe('fila de prueba, eliminada en afterAll');
    facturaId = res.body.id;

    const { rows } = await db.pool.query('SELECT * FROM facturas WHERE id = $1', [facturaId]);
    expect(rows[0].monto_total).toBe(1160);
    expect(rows[0].creado_por).toBe(46);
  });
});

describe('Control Financiero — Gastos Indirectos Corporativos', () => {
  it('POST /control-financiero/gastos-indirectos — con obra (project_id NOT NULL)', async () => {
    const res = await request(app)
      .post('/api/control-financiero/gastos-indirectos')
      .set('Authorization', `Bearer ${paulToken}`)
      .send({ project_id: testProjectId, tipo: 'prueba_qa', concepto: 'Gasto con obra (vitest)', monto: 500, fecha: '2026-08-06' });
    expect(res.status).toBe(201);
    expect(res.body.project_id).toBe(testProjectId);
    gastoConObraId = res.body.id;
  });

  it('POST /control-financiero/gastos-indirectos — sin obra (project_id NULL, corporativo)', async () => {
    const res = await request(app)
      .post('/api/control-financiero/gastos-indirectos')
      .set('Authorization', `Bearer ${ferToken}`)
      .send({ tipo: 'prueba_qa', concepto: 'Gasto corporativo sin obra (vitest)', monto: 750, fecha: '2026-08-06' });
    expect(res.status).toBe(201);
    expect(res.body.project_id).toBeNull();
    gastoSinObraId = res.body.id;
  });

  it('GET /control-financiero/gastos-indirectos?project_id=sin-obra — solo devuelve los corporativos', async () => {
    const res = await request(app)
      .get('/api/control-financiero/gastos-indirectos?project_id=sin-obra')
      .set('Authorization', `Bearer ${paulToken}`);
    expect(res.status).toBe(200);
    expect(res.body.every((g) => g.project_id === null)).toBe(true);
    expect(res.body.some((g) => g.id === gastoSinObraId)).toBe(true);
  });

  it('gastos_generales.project_id sigue NOT NULL — sin regresión de la tabla existente', async () => {
    const { rows } = await db.pool.query(
      "SELECT is_nullable FROM information_schema.columns WHERE table_name='gastos_generales' AND column_name='project_id'"
    );
    expect(rows[0].is_nullable).toBe('NO');
  });
});
