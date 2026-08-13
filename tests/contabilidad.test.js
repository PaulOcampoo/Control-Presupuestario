// Integration tests para Contabilidad Fase 1
// (prompt-contabilidad-fase1-cuentas-polizas.md) — catálogo de cuentas
// contables y pólizas, gateados por auth.requireContabilidadAccess
// (whitelist de usuario_id [46, 8] = Paul/Fer, server/auth.js), nunca por
// rol. Corren contra la base de datos real apuntada por DATABASE_URL. Mismo
// patrón que tests/control-financiero.test.js.
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
let cuentaId;
let polizaId;
let polizaCorporativaId;

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
  if (polizaId) await db.pool.query('DELETE FROM polizas WHERE id = $1', [polizaId]);
  if (polizaCorporativaId) await db.pool.query('DELETE FROM polizas WHERE id = $1', [polizaCorporativaId]);
  if (cuentaId) await db.pool.query('DELETE FROM cuentas_contables WHERE id = $1', [cuentaId]);
  await db.pool.end();
});

describe('Contabilidad — schema', () => {
  it('cuentas_contables y polizas existen con las columnas esperadas', async () => {
    const { rows: cols } = await db.pool.query(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_name IN ('cuentas_contables', 'polizas')
    `);
    const cuentasCols = cols.filter((c) => c.table_name === 'cuentas_contables').map((c) => c.column_name);
    const polizasCols = cols.filter((c) => c.table_name === 'polizas').map((c) => c.column_name);
    expect(cuentasCols).toEqual(expect.arrayContaining(['codigo', 'nombre', 'tipo', 'estatus']));
    expect(polizasCols).toEqual(expect.arrayContaining([
      'tipo', 'fecha', 'cuenta_id', 'monto', 'concepto', 'project_id', 'usuario_id',
      'estatus', 'cancelado_por', 'cancelado_en',
    ]));
  });

  it('catálogo sembrado tiene al menos las cuentas base esperadas', async () => {
    const { rows } = await db.pool.query("SELECT codigo FROM cuentas_contables WHERE codigo IN ('1101','2101','4101','5101')");
    expect(rows.length).toBe(4);
  });
});

describe('Contabilidad — whitelist (nunca por rol)', () => {
  it('GET /contabilidad/cuentas — usuario admin fuera de whitelist recibe 403', async () => {
    const res = await request(app).get('/api/contabilidad/cuentas').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(403);
  });

  it('GET /contabilidad/polizas — usuario admin fuera de whitelist recibe 403', async () => {
    const res = await request(app).get('/api/contabilidad/polizas').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(403);
  });

  it('GET /contabilidad/cuentas — Paul (id 46, whitelist) recibe 200', async () => {
    const res = await request(app).get('/api/contabilidad/cuentas').set('Authorization', `Bearer ${paulToken}`);
    expect(res.status).toBe(200);
  });

  it('GET /contabilidad/polizas — Fer (id 8, whitelist) recibe 200', async () => {
    const res = await request(app).get('/api/contabilidad/polizas').set('Authorization', `Bearer ${ferToken}`);
    expect(res.status).toBe(200);
  });
});

describe('Contabilidad — Catálogo de cuentas', () => {
  it('POST /contabilidad/cuentas — rechaza código incompatible con el tipo', async () => {
    const res = await request(app)
      .post('/api/contabilidad/cuentas')
      .set('Authorization', `Bearer ${paulToken}`)
      .send({ codigo: '1999', nombre: 'Cuenta mal tipada (vitest)', tipo: 'pasivo' });
    expect(res.status).toBe(400);
  });

  it('POST /contabilidad/cuentas — crea cuenta con código compatible', async () => {
    const res = await request(app)
      .post('/api/contabilidad/cuentas')
      .set('Authorization', `Bearer ${paulToken}`)
      .send({ codigo: '1199', nombre: 'Cuenta de prueba vitest', tipo: 'activo' });
    expect(res.status).toBe(201);
    expect(res.body.codigo).toBe('1199');
    expect(res.body.estatus).toBe('activa');
    cuentaId = res.body.id;
  });

  it('PUT /contabilidad/cuentas/:id — edita nombre, código permanece inmutable', async () => {
    const res = await request(app)
      .put(`/api/contabilidad/cuentas/${cuentaId}`)
      .set('Authorization', `Bearer ${ferToken}`)
      .send({ nombre: 'Cuenta de prueba vitest (editada)', codigo: '9999' });
    expect(res.status).toBe(200);
    expect(res.body.codigo).toBe('1199'); // el body.codigo enviado se ignora — no hay forma de editarlo
    expect(res.body.nombre).toBe('Cuenta de prueba vitest (editada)');
  });

  it('PUT /contabilidad/cuentas/:id/estatus — inactiva la cuenta (nunca DELETE físico)', async () => {
    const res = await request(app)
      .put(`/api/contabilidad/cuentas/${cuentaId}/estatus`)
      .set('Authorization', `Bearer ${paulToken}`)
      .send({ estatus: 'inactiva' });
    expect(res.status).toBe(200);
    expect(res.body.estatus).toBe('inactiva');

    const { rows } = await db.pool.query('SELECT * FROM cuentas_contables WHERE id = $1', [cuentaId]);
    expect(rows.length).toBe(1); // la fila sigue existiendo
  });

  it('reactiva la cuenta para poder usarla en las pólizas de prueba siguientes', async () => {
    const res = await request(app)
      .put(`/api/contabilidad/cuentas/${cuentaId}/estatus`)
      .set('Authorization', `Bearer ${paulToken}`)
      .send({ estatus: 'activa' });
    expect(res.status).toBe(200);
  });
});

describe('Contabilidad — Pólizas', () => {
  it('POST /contabilidad/polizas — rechaza cuenta inexistente', async () => {
    const res = await request(app)
      .post('/api/contabilidad/polizas')
      .set('Authorization', `Bearer ${paulToken}`)
      .send({ tipo: 'egreso', cuenta_id: 999999, monto: 100, concepto: 'Cuenta inexistente (vitest)' });
    expect(res.status).toBe(400);
  });

  it('POST /contabilidad/polizas — crea póliza con obra (project_id NOT NULL)', async () => {
    const res = await request(app)
      .post('/api/contabilidad/polizas')
      .set('Authorization', `Bearer ${paulToken}`)
      .send({
        tipo: 'egreso', fecha: '2026-08-13', cuenta_id: cuentaId, monto: 500,
        concepto: 'Póliza de prueba con obra (vitest)', referencia_factura: 'REF-VITEST-1', project_id: testProjectId,
      });
    expect(res.status).toBe(201);
    expect(res.body.project_id).toBe(testProjectId);
    expect(res.body.estatus).toBe('activa');
    expect(res.body.usuario_id).toBe(46);
    polizaId = res.body.id;
  });

  it('POST /contabilidad/polizas — crea póliza corporativa (project_id NULL)', async () => {
    const res = await request(app)
      .post('/api/contabilidad/polizas')
      .set('Authorization', `Bearer ${ferToken}`)
      .send({ tipo: 'ingreso', fecha: '2026-08-13', cuenta_id: cuentaId, monto: 250, concepto: 'Póliza corporativa de prueba (vitest)' });
    expect(res.status).toBe(201);
    expect(res.body.project_id).toBeNull();
    polizaCorporativaId = res.body.id;
  });

  it('GET /contabilidad/polizas?project_id=sin-obra — solo devuelve las corporativas', async () => {
    const res = await request(app)
      .get('/api/contabilidad/polizas?project_id=sin-obra')
      .set('Authorization', `Bearer ${paulToken}`);
    expect(res.status).toBe(200);
    expect(res.body.every((p) => p.project_id === null)).toBe(true);
    expect(res.body.some((p) => p.id === polizaCorporativaId)).toBe(true);
  });

  it('PUT /contabilidad/polizas/:id/cancelar — cancela sin DELETE físico', async () => {
    const res = await request(app)
      .put(`/api/contabilidad/polizas/${polizaId}/cancelar`)
      .set('Authorization', `Bearer ${paulToken}`);
    expect(res.status).toBe(200);
    expect(res.body.estatus).toBe('cancelada');
    expect(res.body.cancelado_por).toBe(46);
    expect(res.body.cancelado_en).not.toBeNull();

    const { rows } = await db.pool.query('SELECT * FROM polizas WHERE id = $1', [polizaId]);
    expect(rows.length).toBe(1); // la fila sigue existiendo, no fue DELETE
    expect(rows[0].estatus).toBe('cancelada');
  });

  it('PUT /contabilidad/polizas/:id/cancelar — cancelar dos veces devuelve 404 (idempotencia)', async () => {
    const res = await request(app)
      .put(`/api/contabilidad/polizas/${polizaId}/cancelar`)
      .set('Authorization', `Bearer ${paulToken}`);
    expect(res.status).toBe(404);
  });
});
