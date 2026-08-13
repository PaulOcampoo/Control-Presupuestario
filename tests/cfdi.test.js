// Integration tests para Contabilidad Fase 2 — repositorio de CFDI
// (prompt-contabilidad-fase2-cfdi.md). Mismo gate que Fase 1
// (auth.requireContabilidadAccess) — desde prompt-contabilidad-acceso-
// admin.md ya no es whitelist pura: whitelist [46,8] OR puesto admin/
// desarrollador. Mismo patrón preview->confirm->proxy de descarga que
// Contrato. Corren contra la base de datos real apuntada por DATABASE_URL
// y suben/borran blobs reales en Vercel Blob.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { del } from '@vercel/blob';
import app from '../server/app.js';
import db from '../server/db.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;

let adminToken; // puesto='admin' real — acceso automático desde prompt-contabilidad-acceso-admin.md
let paulToken;
let residenteToken; // usuario real, fuera de whitelist y sin rol admin/desarrollador — debe seguir en 403
let cfdiId;
let xmlBlobUrl;
let pdfBlobUrl;

function tokenPara(id, nombre, usuario, puesto) {
  return jwt.sign({ id, nombre, usuario, puesto }, SESSION_SECRET, { expiresIn: '15m', algorithm: 'HS256' });
}

// CFDI 4.0 de prueba (datos ficticios, sandbox) — mismo XML usado para
// validar server/cfdiParser.js manualmente antes de escribir estos tests.
function xmlPrueba(uuid) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital"
  Version="4.0" Fecha="2026-08-10T12:34:56" SubTotal="1000.00" Total="1160.00" TipoDeComprobante="I" MetodoPago="PUE" LugarExpedicion="76000">
  <cfdi:Emisor Rfc="VITE850101AA1" Nombre="VINTE PRUEBA" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="ROF120202BB2" Nombre="GRUPO ROFORB PRUEBA" DomicilioFiscalReceptor="76000" RegimenFiscalReceptor="601" UsoCFDI="G03"/>
  <cfdi:Impuestos TotalImpuestosTrasladados="160.00"/>
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital Version="1.1" UUID="${uuid}" FechaTimbrado="2026-08-10T12:35:10"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;
}
const UUID_PRUEBA = 'AAAAAAAA-BBBB-CCCC-DDDD-VITEST000001';
const PDF_MINIMO = Buffer.from('%PDF-1.4\n%¥±ë\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>');

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
  if (loginRes.body.user.puesto !== 'admin') {
    throw new Error(`La cuenta admin de pruebas no tiene puesto='admin' (tiene '${loginRes.body.user.puesto}') — ajustar el test.`);
  }
  paulToken = tokenPara(46, 'PAUL OCAMPO', 'paul.ocmp', 'desarrollador');

  const { rows: residenteRows } = await db.pool.query(
    "SELECT id FROM usuarios WHERE activo = true AND puesto NOT IN ('admin','desarrollador') AND id NOT IN (46,8) ORDER BY id LIMIT 1"
  );
  if (!residenteRows[0]) throw new Error('No hay ningún usuario activo fuera de whitelist/admin/desarrollador contra el cual probar el 403.');
  residenteToken = tokenPara(residenteRows[0].id, 'RESIDENTE PRUEBA', 'residente.prueba', 'residente');
});

afterAll(async () => {
  if (cfdiId) await db.pool.query('DELETE FROM cfdi WHERE id = $1', [cfdiId]);
  if (xmlBlobUrl) await del(xmlBlobUrl).catch(() => {});
  if (pdfBlobUrl) await del(pdfBlobUrl).catch(() => {});
  await db.pool.end();
});

describe('CFDI — whitelist OR admin/desarrollador (prompt-contabilidad-acceso-admin.md)', () => {
  it('GET /contabilidad/cfdi — puesto admin (fuera de la whitelist original) recibe 200', async () => {
    const res = await request(app).get('/api/contabilidad/cfdi').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it('GET /contabilidad/cfdi — Paul (id 46, whitelist) recibe 200', async () => {
    const res = await request(app).get('/api/contabilidad/cfdi').set('Authorization', `Bearer ${paulToken}`);
    expect(res.status).toBe(200);
  });

  it('GET /contabilidad/cfdi — usuario fuera de whitelist y sin rol admin/desarrollador sigue recibiendo 403', async () => {
    const res = await request(app).get('/api/contabilidad/cfdi').set('Authorization', `Bearer ${residenteToken}`);
    expect(res.status).toBe(403);
  });
});

describe('CFDI — preview', () => {
  it('POST /contabilidad/cfdi/preview — sin archivos, 400', async () => {
    const res = await request(app).post('/api/contabilidad/cfdi/preview').set('Authorization', `Bearer ${paulToken}`);
    expect(res.status).toBe(400);
  });

  it('POST /contabilidad/cfdi/preview — XML inválido (sin nodo Comprobante), 400', async () => {
    const res = await request(app)
      .post('/api/contabilidad/cfdi/preview')
      .set('Authorization', `Bearer ${paulToken}`)
      .attach('xml', Buffer.from('<?xml version="1.0"?><algo/>'), 'invalido.xml');
    expect(res.status).toBe(400);
  });

  it('POST /contabilidad/cfdi/preview — XML válido: extrae campos y sube a Blob sin persistir en DB', async () => {
    const res = await request(app)
      .post('/api/contabilidad/cfdi/preview')
      .set('Authorization', `Bearer ${paulToken}`)
      .attach('xml', Buffer.from(xmlPrueba(UUID_PRUEBA)), 'cfdi-prueba.xml')
      .attach('pdf', PDF_MINIMO, 'cfdi-prueba.pdf');
    expect(res.status).toBe(200);
    expect(res.body.campos.uuid).toBe(UUID_PRUEBA);
    expect(res.body.campos.rfc_emisor).toBe('VITE850101AA1');
    expect(res.body.campos.rfc_receptor).toBe('ROF120202BB2');
    expect(res.body.campos.total).toBe(1160);
    expect(res.body.origen).toBe('xml');
    expect(res.body.xml_blob_url).toBeTruthy();
    expect(res.body.pdf_blob_url).toBeTruthy();
    xmlBlobUrl = res.body.xml_blob_url;
    pdfBlobUrl = res.body.pdf_blob_url;

    const { rows } = await db.pool.query('SELECT id FROM cfdi WHERE uuid = $1', [UUID_PRUEBA]);
    expect(rows.length).toBe(0); // preview NO persiste, igual que contrato-preview
  });
});

describe('CFDI — confirm', () => {
  it('POST /contabilidad/cfdi/confirm — sin fecha_emision, 400 (no un 500 crudo de Postgres)', async () => {
    const res = await request(app)
      .post('/api/contabilidad/cfdi/confirm')
      .set('Authorization', `Bearer ${paulToken}`)
      .send({
        campos: { uuid: 'BBBBBBBB-0000-0000-0000-VITEST000002', rfc_emisor: 'VITE850101AA1', rfc_receptor: 'ROF120202BB2', total: 1160 },
        origen: 'xml', xml_blob_url: 'https://blob-falso/no-existe.xml',
      });
    expect(res.status).toBe(400);
  });

  it('POST /contabilidad/cfdi/confirm — persiste el registro', async () => {
    const res = await request(app)
      .post('/api/contabilidad/cfdi/confirm')
      .set('Authorization', `Bearer ${paulToken}`)
      .send({
        campos: { uuid: UUID_PRUEBA, rfc_emisor: 'VITE850101AA1', rfc_receptor: 'ROF120202BB2', fecha_emision: '2026-08-10T12:34:56', subtotal: 1000, iva: 160, total: 1160, tipo_comprobante: 'I' },
        origen: 'xml', xml_blob_url: xmlBlobUrl, pdf_blob_url: pdfBlobUrl,
        nombre_archivo_xml: 'cfdi-prueba.xml', nombre_archivo_pdf: 'cfdi-prueba.pdf',
      });
    expect(res.status).toBe(201);
    expect(res.body.uuid).toBe(UUID_PRUEBA);
    expect(res.body.estatus_sat).toBe('vigente');
    expect(res.body.subido_por).toBe(46);
    cfdiId = res.body.id;
  });

  it('POST /contabilidad/cfdi/confirm — UUID duplicado devuelve 409 (constraint UNIQUE real)', async () => {
    const res = await request(app)
      .post('/api/contabilidad/cfdi/confirm')
      .set('Authorization', `Bearer ${paulToken}`)
      .send({
        campos: { uuid: UUID_PRUEBA, rfc_emisor: 'VITE850101AA1', rfc_receptor: 'ROF120202BB2', fecha_emision: '2026-08-10T12:34:56', subtotal: 1000, total: 1160 },
        origen: 'xml', xml_blob_url: 'https://blob-falso/no-existe.xml',
      });
    expect(res.status).toBe(409);
  });

  it('POST /contabilidad/cfdi/preview — mismo UUID ya persistido devuelve 409 (chequeo temprano)', async () => {
    const res = await request(app)
      .post('/api/contabilidad/cfdi/preview')
      .set('Authorization', `Bearer ${paulToken}`)
      .attach('xml', Buffer.from(xmlPrueba(UUID_PRUEBA)), 'cfdi-dup.xml');
    expect(res.status).toBe(409);
  });
});

describe('CFDI — consulta y estatus', () => {
  it('GET /contabilidad/cfdi?rfc_emisor= — encuentra el registro de prueba', async () => {
    const res = await request(app)
      .get('/api/contabilidad/cfdi?rfc_emisor=VITE850101')
      .set('Authorization', `Bearer ${paulToken}`);
    expect(res.status).toBe(200);
    expect(res.body.some((c) => c.id === cfdiId)).toBe(true);
  });

  it('PUT /contabilidad/cfdi/:id/estatus — marca cancelado (nunca DELETE físico)', async () => {
    const res = await request(app)
      .put(`/api/contabilidad/cfdi/${cfdiId}/estatus`)
      .set('Authorization', `Bearer ${paulToken}`)
      .send({ estatus_sat: 'cancelado' });
    expect(res.status).toBe(200);
    expect(res.body.estatus_sat).toBe('cancelado');

    const { rows } = await db.pool.query('SELECT * FROM cfdi WHERE id = $1', [cfdiId]);
    expect(rows.length).toBe(1);
    expect(rows[0].estatus_sat).toBe('cancelado');
  });
});

describe('CFDI — descarga vía proxy autenticado', () => {
  it('GET /contabilidad/cfdi/:id/archivo?tipo=xml — devuelve el XML real sin exponer la URL de Blob', async () => {
    const res = await request(app)
      .get(`/api/contabilidad/cfdi/${cfdiId}/archivo?tipo=xml`)
      .set('Authorization', `Bearer ${paulToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('xml');
    expect(res.text).toContain(UUID_PRUEBA);
    expect(res.text).not.toContain('blob.vercel-storage.com'); // el contenido es el XML, no metadata con la URL
  });

  it('GET /contabilidad/cfdi/:id/archivo?tipo=pdf — devuelve el PDF real', async () => {
    const res = await request(app)
      .get(`/api/contabilidad/cfdi/${cfdiId}/archivo?tipo=pdf`)
      .set('Authorization', `Bearer ${paulToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('pdf');
  });

  it('GET /contabilidad/cfdi/:id/archivo — usuario fuera de whitelist y sin rol admin/desarrollador recibe 403, nunca el archivo', async () => {
    const res = await request(app)
      .get(`/api/contabilidad/cfdi/${cfdiId}/archivo?tipo=xml`)
      .set('Authorization', `Bearer ${residenteToken}`);
    expect(res.status).toBe(403);
  });
});
