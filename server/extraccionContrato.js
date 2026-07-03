'use strict';

const pdfParse = require('pdf-parse');
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 2000;
const MIN_TEXT_LENGTH = 50; // por debajo de esto, se asume PDF escaneado sin texto seleccionable

// Campos que se piden a la API y que después escribe contrato-confirm en la
// tabla meta. fecha_inicio/fecha_termino se guardan bajo las claves ya
// existentes inicio_obra/fin_obra (ver server/app.js); el resto usa su propio
// nombre tal cual. No hay parsing por regex: todo el mapeo semántico lo hace
// el modelo, porque cada cliente/obra redacta estos datos distinto.
const CAMPOS_CONTRATO = [
  'proyecto_desarrollo', 'obra_numero', 'obra_descripcion', 'empresa_contratante',
  'contratista_nombre', 'contratista_rfc', 'contratista_domicilio', 'contratista_telefono',
  'fecha_documento', 'fecha_inicio', 'fecha_termino', 'tipo_contrato',
  'subtotal_materiales', 'subtotal_mano_obra', 'subtotal_carga_social', 'subtotal_herramienta_equipo',
  'subtotal_costo_directo', 'indirecto_utilidad', 'importe_contratado', 'iva_monto', 'total_contratado',
  'anticipo_monto', 'fondo_garantia_monto', 'volumen_contratado', 'volumen_unidad',
];

const SYSTEM_PROMPT = `Eres un asistente que extrae datos estructurados de contratos de construcción/obra en México.
Devuelve ÚNICAMENTE un objeto JSON (sin markdown, sin bloques de código, sin texto antes o después) con exactamente estas claves:
${CAMPOS_CONTRATO.join(', ')}.
Usa null en cualquier clave cuyo dato no aparezca en el documento.
Si el documento usa términos distintos para conceptos equivalentes, mapea al campo semánticamente más cercano; todos los montos como número, sin "$" ni comas.
Las fechas deben devolverse en formato ISO (YYYY-MM-DD).`;

function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const err = new Error('ANTHROPIC_API_KEY no está configurada en el entorno — no se puede extraer el contrato');
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
  for (const k of CAMPOS_CONTRATO) {
    out[k] = campos && Object.prototype.hasOwnProperty.call(campos, k) ? campos[k] : null;
  }
  return out;
}

async function llamarClaude(client, messages) {
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages,
  });
  return resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

async function extraerDatosContrato(bufferPdf) {
  const { text } = await pdfParse(bufferPdf);
  const texto = (text || '').trim();
  if (texto.length < MIN_TEXT_LENGTH) {
    return { escaneado: true, campos: null };
  }

  const client = getClient();
  const messages = [{ role: 'user', content: texto }];
  let raw = await llamarClaude(client, messages);

  try {
    return { escaneado: false, campos: normalizarCampos(parseJsonResponse(raw)) };
  } catch {
    messages.push({ role: 'assistant', content: raw });
    messages.push({ role: 'user', content: 'Tu respuesta anterior no era JSON válido, responde solo con el objeto JSON.' });
    raw = await llamarClaude(client, messages);
    try {
      return { escaneado: false, campos: normalizarCampos(parseJsonResponse(raw)) };
    } catch {
      const err = new Error(`La API de Claude no devolvió JSON válido tras un reintento. Respuesta cruda: ${raw}`);
      err.status = 502;
      throw err;
    }
  }
}

module.exports = { extraerDatosContrato, CAMPOS_CONTRATO };
