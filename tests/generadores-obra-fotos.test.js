// Integration tests para prompt-generadores-de-obra.md, Fase 2 (evidencia
// fotográfica). Corre contra la base real apuntada por DATABASE_URL, mismo
// patrón que tests/generadores-obra.test.js -- crea datos desechables y los
// borra físicamente en afterAll (incluyendo el blob subido a Vercel Blob).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import db from '../server/db.js';
import { del } from '@vercel/blob';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// PNG 1x1 real (magic bytes válidos) -- necesario porque el endpoint valida
// checkFileMagic(), no solo la extensión del nombre de archivo.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

let adminToken;
let creadorToken;
let testProjectId;
let conceptoId;
let creadorId;
const generadorIds = [];
const blobUrlsSubidos = [];
const creadorUsuario = `qa_genobra_fotos_${Date.now()}`;
const tempPassword = 'QaGenObraFotosTemp123!';

async function login(usuario, password) {
  const res = await request(app).post('/api/auth/login').send({ usuario, password });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`Login falló para ${usuario}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

async function crearGenerador(token, body) {
  const res = await request(app)
    .post(`/api/projects/${testProjectId}/generadores-obra`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);
  if (res.status !== 201) throw new Error(`No se pudo crear el generador: ${res.status} ${JSON.stringify(res.body)}`);
  generadorIds.push(res.body.id);
  return res.body;
}

beforeAll(async () => {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD no configurada — no se puede correr la suite.');
  adminToken = await login(ADMIN_USER, ADMIN_PASSWORD);

  const { rows: projRows } = await db.pool.query('SELECT id FROM proyectos ORDER BY id LIMIT 1');
  testProjectId = projRows[0].id;

  const { rows: conRows } = await db.pool.query(
    `SELECT id FROM conceptos WHERE project_id = $1 AND es_total = 0 AND activo = 1 AND cantidad > 0
     AND TRIM(COALESCE(unidad, '')) <> '' LIMIT 1`,
    [testProjectId]
  );
  conceptoId = conRows[0].id;

  const res = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA GenObra Fotos', usuario: creadorUsuario, password: tempPassword, puesto: 'residente' });
  if (res.status !== 201 && res.status !== 200) throw new Error(`No se pudo crear el residente: ${res.status} ${JSON.stringify(res.body)}`);
  creadorId = res.body.id;
  await request(app).put(`/api/usuarios/${creadorId}/proyectos`).set('Authorization', `Bearer ${adminToken}`).send({ project_ids: [testProjectId] });
  creadorToken = await login(creadorUsuario, tempPassword);
}, 30000);

afterAll(async () => {
  for (const url of blobUrlsSubidos) await del(url).catch(() => {});
  for (const gid of generadorIds) {
    await db.pool.query('DELETE FROM generador_obra_fotos WHERE generador_id = $1', [gid]);
    await db.pool.query('DELETE FROM generador_obra_renglones WHERE generador_id = $1', [gid]);
    await db.pool.query('DELETE FROM generadores_obra WHERE id = $1', [gid]);
  }
  if (creadorId) await request(app).delete(`/api/usuarios/${creadorId}`).set('Authorization', `Bearer ${adminToken}`);
});

describe('Subir/ver/eliminar fotos de un generador de obra', () => {
  let gen;
  beforeAll(async () => {
    gen = await crearGenerador(creadorToken, { periodo_inicio: '2030-09-01', periodo_fin: '2030-09-07' });
  });

  it('sube una foto válida con partida/subpartida', async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/fotos`)
      .set('Authorization', `Bearer ${creadorToken}`)
      .field('partida', 'AP - RED DE DISTRIBUCION')
      .field('subpartida', 'CALLE BARRANCAS')
      .attach('foto', PNG_1X1, 'evidencia.png');
    expect(res.status).toBe(201);
    expect(res.body.partida).toBe('AP - RED DE DISTRIBUCION');
    expect(res.body.subpartida).toBe('CALLE BARRANCAS');
    expect(res.body.id).toBeTypeOf('number');
    const { rows } = await db.pool.query('SELECT blob_url FROM generador_obra_fotos WHERE id = $1', [res.body.id]);
    blobUrlsSubidos.push(rows[0].blob_url);
  });

  it('rechaza subir sin partida/subpartida', async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/fotos`)
      .set('Authorization', `Bearer ${creadorToken}`)
      .attach('foto', PNG_1X1, 'evidencia.png');
    expect(res.status).toBe(400);
  });

  it('rechaza un archivo que no es imagen real aunque tenga extensión .png', async () => {
    const res = await request(app)
      .post(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/fotos`)
      .set('Authorization', `Bearer ${creadorToken}`)
      .field('partida', 'AP - RED DE DISTRIBUCION')
      .field('subpartida', 'CALLE BARRANCAS')
      .attach('foto', Buffer.from('esto no es una imagen'), 'evidencia.png');
    expect(res.status).toBe(400);
  });

  it('el detalle del generador incluye la foto agrupada por partida/subpartida', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/generadores-obra/${gen.id}`)
      .set('Authorization', `Bearer ${creadorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.fotos.length).toBe(1);
    expect(res.body.fotos[0].partida).toBe('AP - RED DE DISTRIBUCION');
  });

  it('descarga la foto vía proxy autenticado con el Content-Type correcto (por extensión, no por el mimetype que reporte el navegador)', async () => {
    const detalle = await request(app)
      .get(`/api/projects/${testProjectId}/generadores-obra/${gen.id}`)
      .set('Authorization', `Bearer ${creadorToken}`);
    const fotoId = detalle.body.fotos[0].id;
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/fotos/${fotoId}`)
      .set('Authorization', `Bearer ${creadorToken}`);
    expect(res.status).toBe(200);
    // Bug real encontrado en verificación manual: un navegador real subió
    // este mismo PNG sin mimetype útil, y con fallback fijo a 'image/jpeg'
    // se servía después como image/jpeg pese a ser un .png real.
    expect(res.headers['content-type']).toBe('image/png');
  });

  it('elimina la foto físicamente', async () => {
    const detalle = await request(app)
      .get(`/api/projects/${testProjectId}/generadores-obra/${gen.id}`)
      .set('Authorization', `Bearer ${creadorToken}`);
    const fotoId = detalle.body.fotos[0].id;
    const res = await request(app)
      .delete(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/fotos/${fotoId}`)
      .set('Authorization', `Bearer ${creadorToken}`);
    expect(res.status).toBe(200);
    const detalleFinal = await request(app)
      .get(`/api/projects/${testProjectId}/generadores-obra/${gen.id}`)
      .set('Authorization', `Bearer ${creadorToken}`);
    expect(detalleFinal.body.fotos.length).toBe(0);
    blobUrlsSubidos.length = 0; // ya se borró, no reintentar del() en afterAll
  });
});

describe('Fotos bloqueadas fuera de borrador/rechazada', () => {
  it('no se puede subir una foto a un generador ya enviado', async () => {
    const gen = await crearGenerador(creadorToken, { periodo_inicio: '2030-10-01', periodo_fin: '2030-10-07' });
    await request(app)
      .post(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/renglones`)
      .set('Authorization', `Bearer ${creadorToken}`)
      .send({ concepto_id: conceptoId, pzas: 1 });
    await request(app)
      .put(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/estado`)
      .set('Authorization', `Bearer ${creadorToken}`)
      .send({ estado: 'enviada' });

    const res = await request(app)
      .post(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/fotos`)
      .set('Authorization', `Bearer ${creadorToken}`)
      .field('partida', 'X')
      .field('subpartida', 'Y')
      .attach('foto', PNG_1X1, 'evidencia.png');
    expect(res.status).toBe(409);
  });
});
