'use strict';

/*
 * Contabilidad Fase 2 (prompt-contabilidad-fase2-cfdi.md) — parseo de CFDI.
 *
 * Camino normal: extraerDatosCFDI() parsea el XML de forma determinista con
 * fast-xml-parser — un CFDI es XML con esquema fijo publicado por el SAT
 * (atributos, no texto libre), así que a diferencia del Contrato (PDF con
 * redacción distinta por cliente) no hace falta IA para leerlo (diagnóstico
 * Fase 2, punto 2).
 *
 * Camino fallback: extraerDatosCFDIDesdePdf() solo se usa cuando el usuario
 * NO tiene el XML y sube nada más el PDF de representación impresa — ahí sí
 * se reusa el mismo patrón de server/extraccionContrato.js (pdf-parse +
 * Claude API), porque un PDF de representación no tiene estructura fija
 * entre PACs.
 */

const { XMLParser } = require('fast-xml-parser');
const pdfParse = require('pdf-parse');
const Anthropic = require('@anthropic-ai/sdk');

const CAMPOS_CFDI = ['uuid', 'rfc_emisor', 'rfc_receptor', 'fecha_emision', 'subtotal', 'iva', 'total', 'tipo_comprobante'];

function crearParser() {
  return new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true });
}

// Valida los campos obligatorios de un CFDI (independiente de si vinieron
// del XML o del fallback de IA) — mismo criterio en ambos caminos, para que
// el registro final en `cfdi` nunca quede con datos fiscales incompletos.
function validarCamposObligatorios(campos) {
  const faltantes = [];
  if (!campos.uuid) faltantes.push('UUID (folio fiscal)');
  if (!campos.rfc_emisor) faltantes.push('RFC emisor');
  if (!campos.rfc_receptor) faltantes.push('RFC receptor');
  if (campos.total == null || !Number.isFinite(campos.total)) faltantes.push('Total');
  if (faltantes.length) {
    const err = new Error(`Faltan campos obligatorios de un CFDI: ${faltantes.join(', ')}`);
    err.status = 400;
    throw err;
  }
}

// bufferXml -> { uuid, rfc_emisor, rfc_receptor, fecha_emision, subtotal, iva, total, tipo_comprobante }
function extraerDatosCFDI(bufferXml) {
  let texto = bufferXml.toString('utf8');
  if (texto.charCodeAt(0) === 0xFEFF) texto = texto.slice(1); // BOM opcional al inicio
  let doc;
  try {
    doc = crearParser().parse(texto);
  } catch (err) {
    const e = new Error(`El archivo no es un XML válido: ${err.message}`);
    e.status = 400;
    throw e;
  }
  const comprobante = doc?.Comprobante;
  if (!comprobante) {
    const err = new Error('El XML no tiene la estructura esperada de un CFDI (falta el nodo Comprobante)');
    err.status = 400;
    throw err;
  }
  const emisor = comprobante.Emisor;
  const receptor = comprobante.Receptor;
  const timbre = comprobante.Complemento?.TimbreFiscalDigital;
  const impuestos = comprobante.Impuestos;

  const campos = {
    uuid: timbre?.['@_UUID'] || null,
    rfc_emisor: emisor?.['@_Rfc'] || null,
    rfc_receptor: receptor?.['@_Rfc'] || null,
    fecha_emision: comprobante['@_Fecha'] || null,
    subtotal: comprobante['@_SubTotal'] != null ? Number(comprobante['@_SubTotal']) : null,
    total: comprobante['@_Total'] != null ? Number(comprobante['@_Total']) : null,
    tipo_comprobante: comprobante['@_TipoDeComprobante'] || null,
    iva: impuestos?.['@_TotalImpuestosTrasladados'] != null ? Number(impuestos['@_TotalImpuestosTrasladados']) : 0,
  };
  validarCamposObligatorios(campos);
  return campos;
}

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 1000;
const MIN_TEXT_LENGTH = 50;

const SYSTEM_PROMPT_PDF = `Eres un asistente que extrae datos fiscales de la representación impresa de un CFDI (factura electrónica mexicana) en PDF.
Devuelve ÚNICAMENTE un objeto JSON (sin markdown, sin bloques de código, sin texto antes o después) con exactamente estas claves:
${CAMPOS_CFDI.join(', ')}.
uuid es el Folio Fiscal (UUID con formato XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX), normalmente etiquetado como "Folio Fiscal" o "UUID" cerca del código QR o del sello digital.
rfc_emisor y rfc_receptor son los RFC de quien emite y quien recibe la factura.
fecha_emision en formato ISO (YYYY-MM-DD o YYYY-MM-DDTHH:MM:SS si el documento trae hora).
subtotal, iva y total como número, sin "$" ni comas.
tipo_comprobante es el tipo de comprobante tal como aparece (ej. "I" para ingreso, "E" para egreso) o null si no aparece explícito.
Usa null en cualquier clave cuyo dato no aparezca en el documento.`;

function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const err = new Error('ANTHROPIC_API_KEY no está configurada en el entorno — no se puede extraer el CFDI del PDF');
    err.status = 500;
    throw err;
  }
  return new Anthropic({ apiKey });
}

function parseJsonResponse(raw) {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  return JSON.parse(cleaned);
}

function normalizarCampos(campos) {
  const out = {};
  for (const k of CAMPOS_CFDI) {
    out[k] = campos && Object.prototype.hasOwnProperty.call(campos, k) ? campos[k] : null;
  }
  if (out.subtotal != null) out.subtotal = Number(out.subtotal);
  if (out.iva != null) out.iva = Number(out.iva);
  if (out.total != null) out.total = Number(out.total);
  return out;
}

async function llamarClaude(client, messages) {
  const resp = await client.messages.create({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT_PDF, messages });
  return resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

// Fallback: solo se llama cuando el usuario NO subió el XML, nada más el PDF
// de representación impresa (server/app.js decide cuándo invocar esto).
async function extraerDatosCFDIDesdePdf(bufferPdf) {
  const { text } = await pdfParse(bufferPdf);
  const texto = (text || '').trim();
  if (texto.length < MIN_TEXT_LENGTH) {
    const err = new Error('El PDF parece ser una imagen escaneada sin texto extraíble — sube el XML del CFDI en su lugar');
    err.status = 400;
    throw err;
  }

  const client = getClient();
  const messages = [{ role: 'user', content: texto }];
  let raw = await llamarClaude(client, messages);
  let campos;
  try {
    campos = normalizarCampos(parseJsonResponse(raw));
  } catch {
    messages.push({ role: 'assistant', content: raw });
    messages.push({ role: 'user', content: 'Tu respuesta anterior no era JSON válido, responde solo con el objeto JSON.' });
    raw = await llamarClaude(client, messages);
    try {
      campos = normalizarCampos(parseJsonResponse(raw));
    } catch {
      const err = new Error(`La API de Claude no devolvió JSON válido tras un reintento. Respuesta cruda: ${raw}`);
      err.status = 502;
      throw err;
    }
  }
  validarCamposObligatorios(campos);
  return campos;
}

module.exports = { extraerDatosCFDI, extraerDatosCFDIDesdePdf, CAMPOS_CFDI };
