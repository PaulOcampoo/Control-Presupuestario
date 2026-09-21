// Integration tests para el export a Excel/PDF del Generador de Obra
// (prompt-generador-obra-export-preview.md, Tarea 1). Mismo patrón que
// tests/generadores-obra-fotos.test.js: corre contra la base real apuntada
// por DATABASE_URL, crea datos desechables (generador + renglón + foto) y
// los borra físicamente en afterAll (incluyendo el blob subido a Vercel Blob).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import ExcelJS from 'exceljs';
import pdfParse from 'pdf-parse';
import app from '../server/app.js';
import db from '../server/db.js';
import { del } from '@vercel/blob';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// PNG 1x1 real (magic bytes válidos) -- el endpoint de subida de fotos valida
// checkFileMagic(), no solo la extensión del nombre de archivo.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

let adminToken;
let creadorToken;
let testProjectId;
let testProjectNombre;
let conceptoId;
let creadorId;
const generadorIds = [];
const blobUrlsSubidos = [];
const creadorUsuario = `qa_genobra_export_${Date.now()}`;
const tempPassword = 'QaGenObraExportTemp123!';

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

  const { rows: projRows } = await db.pool.query('SELECT id, nombre FROM proyectos ORDER BY id LIMIT 1');
  testProjectId = projRows[0].id;
  testProjectNombre = projRows[0].nombre;

  const { rows: conRows } = await db.pool.query(
    `SELECT id FROM conceptos WHERE project_id = $1 AND es_total = 0 AND activo = 1 AND cantidad > 0
     AND TRIM(COALESCE(unidad, '')) <> '' LIMIT 1`,
    [testProjectId]
  );
  conceptoId = conRows[0].id;

  const res = await request(app)
    .post('/api/usuarios')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'QA GenObra Export', usuario: creadorUsuario, password: tempPassword, puesto: 'residente' });
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

describe('Export de Generador de Obra — con renglón y foto', () => {
  let gen;

  beforeAll(async () => {
    gen = await crearGenerador(creadorToken, { periodo_inicio: '2030-11-01', periodo_fin: '2030-11-07', nombre: 'Croquis de prueba QA' });
    const renglonRes = await request(app)
      .post(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/renglones`)
      .set('Authorization', `Bearer ${creadorToken}`)
      .send({ concepto_id: conceptoId, descripcion: 'Tramo QA', largo: 10, ancho: 2, pzas: 1 });
    if (renglonRes.status !== 201) throw new Error(`No se pudo crear el renglón: ${renglonRes.status} ${JSON.stringify(renglonRes.body)}`);

    const fotoRes = await request(app)
      .post(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/fotos`)
      .set('Authorization', `Bearer ${creadorToken}`)
      .field('partida', 'General')
      .field('subpartida', 'General')
      .attach('foto', PNG_1X1, 'evidencia.png');
    if (fotoRes.status !== 201) throw new Error(`No se pudo subir la foto: ${fotoRes.status} ${JSON.stringify(fotoRes.body)}`);
    const { rows } = await db.pool.query('SELECT blob_url FROM generador_obra_fotos WHERE id = $1', [fotoRes.body.id]);
    blobUrlsSubidos.push(rows[0].blob_url);
  });

  it('genera el xlsx con status 200, Content-Type correcto y contenido parseable', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/exportar?formato=xlsx`)
      .set('Authorization', `Bearer ${creadorToken}`)
      .buffer(true)
      .parse((response, cb) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.body.length).toBeGreaterThan(0);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const ws = wb.getWorksheet('Generador de Obra');
    expect(ws).toBeTruthy();

    // Busca la celda con el folio en el título y el subtotal capturado (10*2=20)
    let encontroFolio = false;
    let encontroSubtotal = false;
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (typeof cell.value === 'string' && cell.value.includes(`Folio ${gen.folio}`)) encontroFolio = true;
        if (typeof cell.value === 'number' && cell.value === 20) encontroSubtotal = true;
      });
    });
    expect(encontroFolio).toBe(true);
    expect(encontroSubtotal).toBe(true);
    // Debe traer al menos una imagen incrustada (la foto subida en beforeAll).
    expect(wb.model.media.length).toBeGreaterThan(0);
  });

  it('genera el pdf con status 200, Content-Type correcto y contenido parseable (folio, subtotal y partida/subpartida)', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/exportar?formato=pdf`)
      .set('Authorization', `Bearer ${creadorToken}`)
      .buffer(true)
      .parse((response, cb) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.slice(0, 4).toString('latin1')).toBe('%PDF');

    // Mismo nivel de rigor que la prueba del xlsx: parsea el texto real del
    // PDF (pdf-parse, ya usado en server/extraccionContrato.js y
    // server/cfdiParser.js) y confirma que el folio, el subtotal capturado
    // (10*2=20) y el grupo partida/subpartida ('General — General', ver
    // datos del renglón/foto de beforeAll) realmente quedaron en el documento.
    // res.body llega de Buffer.concat() sobre chunks pequeños — para un PDF
    // de pocos KB como este, Node devuelve un Buffer "pooled" (vista sobre
    // un ArrayBuffer compartido, con .byteOffset != 0). La versión de pdf.js
    // que trae pdf-parse (v1.10.100, de 2017) no respeta ese byteOffset
    // internamente y corrompe el parseo de forma intermitente — confirmado
    // empíricamente aquí. `new Uint8Array(buf)` sí copia a un ArrayBuffer
    // propio con byteOffset 0 (por spec), PERO volver a envolver ese copy en
    // `Buffer.from(...)` reintroduce el pool (Buffer.from tampoco es inmune
    // para tamaños chicos) — hay que pasarle a pdfParse el Uint8Array plano,
    // sin volver a envolverlo en Buffer.
    const { text } = await pdfParse(new Uint8Array(res.body));
    expect(text).toContain(`Folio: ${gen.folio}`);
    expect(text).toContain('$20.00');
    expect(text).toContain('General — General');
  });

  it('formato inválido/ausente cae al default xlsx', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/exportar`)
      .set('Authorization', `Bearer ${creadorToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });
});

describe('Export de Generador de Obra — sin fotos', () => {
  it('no truena y genera xlsx/pdf igual con solo un renglón, sin fotos', async () => {
    const gen = await crearGenerador(creadorToken, { periodo_inicio: '2030-12-01', periodo_fin: '2030-12-07' });
    const renglonRes = await request(app)
      .post(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/renglones`)
      .set('Authorization', `Bearer ${creadorToken}`)
      .send({ concepto_id: conceptoId, pzas: 3 });
    expect(renglonRes.status).toBe(201);

    const resXlsx = await request(app)
      .get(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/exportar?formato=xlsx`)
      .set('Authorization', `Bearer ${creadorToken}`)
      .buffer(true)
      .parse((response, cb) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(resXlsx.status).toBe(200);
    expect(resXlsx.body.length).toBeGreaterThan(0);

    const resPdf = await request(app)
      .get(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/exportar?formato=pdf`)
      .set('Authorization', `Bearer ${creadorToken}`)
      .buffer(true)
      .parse((response, cb) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(resPdf.status).toBe(200);
    expect(resPdf.body.length).toBeGreaterThan(0);
  });

  it('genera un xlsx válido para un generador sin renglones ni fotos (sin partidas/subpartidas)', async () => {
    const gen = await crearGenerador(creadorToken, { periodo_inicio: '2031-01-01', periodo_fin: '2031-01-07' });
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/generadores-obra/${gen.id}/exportar?formato=xlsx`)
      .set('Authorization', `Bearer ${creadorToken}`)
      .buffer(true)
      .parse((response, cb) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    expect(wb.getWorksheet('Generador de Obra')).toBeTruthy();
  });
});

describe('Export de Generador de Obra — control de acceso', () => {
  it('rechaza sin token', async () => {
    const gen = generadorIds[0];
    const res = await request(app).get(`/api/projects/${testProjectId}/generadores-obra/${gen}/exportar?formato=xlsx`);
    expect(res.status).toBe(401);
  });

  it('responde 404 para un generador inexistente', async () => {
    const res = await request(app)
      .get(`/api/projects/${testProjectId}/generadores-obra/999999999/exportar?formato=xlsx`)
      .set('Authorization', `Bearer ${creadorToken}`);
    expect(res.status).toBe(404);
  });
});
