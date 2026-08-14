// Integration tests para Contabilidad Fase 4 — depreciación de maquinaria
// (prompt-contabilidad-fase4-depreciacion.md). Mismo gate que Fase 1-3
// (auth.requireContabilidadAccess: whitelist [46,8] OR admin/desarrollador).
// Corren contra la base de datos real apuntada por DATABASE_URL. Crea un
// equipo de maquinaria de prueba (equipos_maquinaria) SOLO para leerlo vía
// FK — nunca se modifica esa tabla desde el código de esta fase.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;

let adminToken;
let paulToken;
let residenteToken;
let equipoId;
let depreciacionId;
let polizaId;

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
  paulToken = tokenPara(46, 'PAUL OCAMPO', 'paul.ocmp', 'desarrollador');

  const { rows: residenteRows } = await db.pool.query(
    "SELECT id FROM usuarios WHERE activo = true AND puesto NOT IN ('admin','desarrollador') AND id NOT IN (46,8) ORDER BY id LIMIT 1"
  );
  if (!residenteRows[0]) throw new Error('No hay ningún usuario activo fuera de whitelist/admin/desarrollador contra el cual probar el 403.');
  residenteToken = tokenPara(residenteRows[0].id, 'RESIDENTE PRUEBA', 'residente.prueba', 'residente');

  const { rows: equipoRows } = await db.pool.query(
    `INSERT INTO equipos_maquinaria (nombre, tipo, identificador) VALUES ('Equipo prueba vitest-depreciacion', 'retroexcavadora', 'VITEST-DEP-1') RETURNING id`
  );
  equipoId = equipoRows[0].id;
});

afterAll(async () => {
  if (polizaId) await db.pool.query('DELETE FROM polizas WHERE id = $1', [polizaId]);
  if (depreciacionId) await db.pool.query('DELETE FROM depreciacion_maquinaria WHERE id = $1', [depreciacionId]);
  if (equipoId) await db.pool.query('DELETE FROM equipos_maquinaria WHERE id = $1', [equipoId]);
  await db.pool.end();
});

describe('Depreciación — whitelist OR admin/desarrollador', () => {
  it('GET /contabilidad/depreciacion — usuario fuera de whitelist/admin/desarrollador recibe 403', async () => {
    const res = await request(app).get('/api/contabilidad/depreciacion').set('Authorization', `Bearer ${residenteToken}`);
    expect(res.status).toBe(403);
  });

  it('GET /contabilidad/depreciacion — puesto admin recibe 200', async () => {
    const res = await request(app).get('/api/contabilidad/depreciacion').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });
});

describe('Alta de parámetros', () => {
  it('GET /contabilidad/depreciacion/equipos-disponibles — incluye el equipo de prueba antes de configurarlo', async () => {
    const res = await request(app).get('/api/contabilidad/depreciacion/equipos-disponibles').set('Authorization', `Bearer ${paulToken}`);
    expect(res.status).toBe(200);
    expect(res.body.some((e) => e.id === equipoId)).toBe(true);
  });

  it('POST /contabilidad/depreciacion — equipo inexistente, 400', async () => {
    const res = await request(app)
      .post('/api/contabilidad/depreciacion')
      .set('Authorization', `Bearer ${paulToken}`)
      .send({ equipo_id: 999999, valor_adquisicion: 120000, fecha_adquisicion: '2024-01-15', vida_util_meses: 24 });
    expect(res.status).toBe(400);
  });

  it('POST /contabilidad/depreciacion — crea parámetros (valor 120000, vida útil 24 meses, rescate 0)', async () => {
    const res = await request(app)
      .post('/api/contabilidad/depreciacion')
      .set('Authorization', `Bearer ${paulToken}`)
      .send({ equipo_id: equipoId, valor_adquisicion: 120000, fecha_adquisicion: '2024-01-15', vida_util_meses: 24, valor_rescate: 0 });
    expect(res.status).toBe(201);
    expect(Number(res.body.valor_adquisicion)).toBe(120000);
    depreciacionId = res.body.id;
  });

  it('POST /contabilidad/depreciacion — mismo equipo otra vez, 409 (UNIQUE equipo_id)', async () => {
    const res = await request(app)
      .post('/api/contabilidad/depreciacion')
      .set('Authorization', `Bearer ${paulToken}`)
      .send({ equipo_id: equipoId, valor_adquisicion: 50000, fecha_adquisicion: '2025-01-01', vida_util_meses: 12 });
    expect(res.status).toBe(409);
  });

  it('GET /contabilidad/depreciacion/equipos-disponibles — ya NO incluye el equipo configurado', async () => {
    const res = await request(app).get('/api/contabilidad/depreciacion/equipos-disponibles').set('Authorization', `Bearer ${paulToken}`);
    expect(res.status).toBe(200);
    expect(res.body.some((e) => e.id === equipoId)).toBe(false);
  });
});

describe('Cálculo de depreciación — verificado a mano contra el caso del checkpoint', () => {
  it('GET /contabilidad/depreciacion?mes=2024-01 — depreciación mensual 5000, mes de adquisición ya cuenta', async () => {
    const res = await request(app)
      .get('/api/contabilidad/depreciacion?mes=2024-01')
      .set('Authorization', `Bearer ${paulToken}`);
    expect(res.status).toBe(200);
    const fila = res.body.find((d) => d.id === depreciacionId);
    expect(fila).toBeTruthy();
    // Cálculo manual: (120000 - 0) / 24 = 5000 exacto.
    expect(fila.depreciacion_mensual).toBe(5000);
    expect(fila.meses_transcurridos).toBe(1);
    expect(fila.depreciacion_acumulada).toBe(5000);
    expect(fila.valor_en_libros).toBe(115000);
  });

  it('GET /contabilidad/depreciacion?mes=2026-01 — acumulada tope en 120000, valor en libros 0 (vida útil agotada)', async () => {
    const res = await request(app)
      .get('/api/contabilidad/depreciacion?mes=2026-01')
      .set('Authorization', `Bearer ${paulToken}`);
    const fila = res.body.find((d) => d.id === depreciacionId);
    expect(fila.depreciacion_acumulada).toBe(120000);
    expect(fila.valor_en_libros).toBe(0);
  });

  it('GET /contabilidad/depreciacion?mes=formato-invalido — 400', async () => {
    const res = await request(app)
      .get('/api/contabilidad/depreciacion?mes=formato-invalido')
      .set('Authorization', `Bearer ${paulToken}`);
    expect(res.status).toBe(400);
  });
});

describe('Baja de equipo — truncamiento de la depreciación', () => {
  it('PUT /contabilidad/depreciacion/:id — captura fecha_baja', async () => {
    const res = await request(app)
      .put(`/api/contabilidad/depreciacion/${depreciacionId}`)
      .set('Authorization', `Bearer ${paulToken}`)
      .send({ fecha_baja: '2024-06-01' });
    expect(res.status).toBe(200);
    expect(res.body.fecha_baja).toBeTruthy();
  });

  it('GET /contabilidad/depreciacion?mes=2026-01 tras la baja — la acumulada NO sigue creciendo después de junio 2024', async () => {
    const res = await request(app)
      .get('/api/contabilidad/depreciacion?mes=2026-01')
      .set('Authorization', `Bearer ${paulToken}`);
    const fila = res.body.find((d) => d.id === depreciacionId);
    // Enero 2024 a junio 2024 = 6 meses -> 6 * 5000 = 30000, truncado ahí
    // aunque el mes consultado sea 2026-01 (muy posterior a la baja).
    expect(fila.meses_transcurridos).toBe(6);
    expect(fila.depreciacion_acumulada).toBe(30000);
    expect(fila.valor_en_libros).toBe(90000);
  });
});

describe('Generación de póliza — siempre confirmada, nunca automática', () => {
  it('POST /contabilidad/depreciacion/:id/generar-poliza — sin confirmado:true, 400 (no se genera la póliza)', async () => {
    const res = await request(app)
      .post(`/api/contabilidad/depreciacion/${depreciacionId}/generar-poliza`)
      .set('Authorization', `Bearer ${paulToken}`)
      .send({ mes: '2024-01' });
    expect(res.status).toBe(400);

    const { rows } = await db.pool.query("SELECT id FROM polizas WHERE concepto LIKE '%vitest-depreciacion%'");
    expect(rows.length).toBe(0); // confirmado que NO se generó nada
  });

  it('POST /contabilidad/depreciacion/:id/generar-poliza — con confirmado:true, crea la póliza con cuenta 5107', async () => {
    const res = await request(app)
      .post(`/api/contabilidad/depreciacion/${depreciacionId}/generar-poliza`)
      .set('Authorization', `Bearer ${paulToken}`)
      .send({ mes: '2024-01', confirmado: true });
    expect(res.status).toBe(201);
    expect(res.body.tipo).toBe('diario');
    expect(Number(res.body.monto)).toBe(5000);
    expect(res.body.concepto).toContain('Equipo prueba vitest-depreciacion');
    polizaId = res.body.id;

    const { rows } = await db.pool.query(
      `SELECT p.*, c.codigo AS cuenta_codigo FROM polizas p JOIN cuentas_contables c ON c.id = p.cuenta_id WHERE p.id = $1`,
      [polizaId]
    );
    expect(rows[0].cuenta_codigo).toBe('5107');
    expect(rows[0].estatus).toBe('activa');
  });
});
