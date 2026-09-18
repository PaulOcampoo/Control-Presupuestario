'use strict';

// Asistente conversacional (prompt-asistente-ia-app-cp.md) — responde dudas
// de USO de la app según rol/proyecto activo y la base de conocimiento
// estática de asistenteKnowledge.js. Nunca tiene acceso a la DB ni a montos
// reales: todo su contexto es texto estático + el rol/nombre de proyecto que
// ya le manda el caller (server/app.js), nunca una query en vivo.
const Anthropic = require('@anthropic-ai/sdk');
const { MODULOS, SUGERENCIAS_INFO } = require('./asistenteKnowledge');
const { PERMISSIONS } = require('./auth');

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 500;
const MAX_MENSAJE_LEN = 1000;
const MAX_HISTORIAL_TEXTO_LEN = 1000;
const MAX_TURNOS_HISTORIAL = 6; // 1 turno = 1 mensaje de user + 1 de assistant

// Mismo patrón de validación explícita del env var que extraccionContrato.js
// (getClient()) — un error propio y claro en vez de dejar que el SDK falle
// con su propio mensaje genérico.
function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const err = new Error('ANTHROPIC_API_KEY no está configurada en el entorno — el asistente no está disponible.');
    err.status = 503;
    throw err;
  }
  return new Anthropic({ apiKey });
}

// Etiqueta legible del rol (PERMISSIONS[puesto].label, mismo catálogo que ya
// usa el resto de la app) — fallback al puesto crudo si no está en el mapa
// (roles nuevos que aún no se hayan dado de alta ahí, caso raro).
function labelDeRol(puesto) {
  return PERMISSIONS[puesto]?.label || puesto;
}

// prompt-asistente-ia-prompt-caching.md: el system prompt se parte en 2
// bloques para que Anthropic cachee el primero (idéntico entre requests que
// comparten tabsPermitidos) y cobre tokens de entrada completos solo la
// primera vez de cada turno nuevo.
//
// Nota de diseño (desviación deliberada de la redacción literal del
// prompt): "contenido estático de asistenteKnowledge.js" se interpreta como
// LOS MÓDULOS YA FILTRADOS por tabsPermitidos (lo que el prompt YA le
// mandaba al modelo antes de este cambio) — NO el catálogo completo sin
// filtrar. Meter el catálogo completo sin filtrar habría maximizado el
// cache hit-rate (un solo bloque cacheable para TODOS los roles, no uno por
// rol), pero cambia el comportamiento observable: el asistente podría
// mencionarle a un residente módulos a los que no tiene acceso — eso
// contradice el "sin cambiar el comportamiento observable" del Objective y
// el propósito original del filtrado (ver comentario de tabsPermitidos más
// abajo). Con este criterio, el bloque cacheable es idéntico entre
// requests que comparten tabsPermitidos (misma sesión, o distintos
// usuarios del mismo rol) — sigue dando el ahorro real que pide el
// prompt (turno a turno de una misma conversación, que es el caso de uso
// principal) sin abrir una fuga de información entre roles.
//
// Solo describe al modelo los módulos que ESTE usuario realmente puede ver
// (tabsPermitidos = auth.tabsParaUsuario(req.user) calculado por el
// caller) — evita que el asistente le hable de módulos a los que no tiene
// acceso, y mantiene el system prompt corto.
function buildSystemBlocks({ puesto, proyectoNombre, tabsPermitidos }) {
  const modulos = tabsPermitidos
    .map((tab) => MODULOS[tab])
    .filter(Boolean)
    .map((m) => `- ${m.label}: ${m.descripcion}`)
    .join('\n');

  const bloqueCacheable = `Eres el asistente de ayuda de "Control Presupuestal de Obra", una app de gestión de presupuestos/avance/nómina/compras para obras de construcción en México.

Tu ÚNICO propósito es orientar sobre CÓMO USAR la app y sus módulos, según el rol del usuario. NUNCA inventes cifras, montos, avances, ni ningún dato de negocio real — no tienes acceso a esa información. Si preguntan algo fuera de tu conocimiento (datos reales de una obra, montos, fechas, etc.), responde que no tienes esa información y sugiere en qué módulo podrían consultarla.

Módulos a los que este usuario tiene acceso (nombre — qué hace):
${modulos || '(sin módulos visibles para este rol)'}

También existe "Sugerencias" (${SUGERENCIAS_INFO.descripcion}), disponible para cualquier usuario autenticado.

Responde en español, de forma breve y directa (máximo un par de párrafos cortos, o una lista si ayuda a la claridad).`;

  // Bloque dinámico — cambia por usuario/obra, NUNCA lleva cache_control
  // (cachearlo rompería el propósito: el siguiente usuario/obra leería el
  // contexto cacheado del anterior).
  const bloqueDinamico = `Usuario actual:
- Rol: ${labelDeRol(puesto)}
- Obra activa: ${proyectoNombre || 'ninguna (está en la pantalla de selección de cliente/obra)'}`;

  return [
    { type: 'text', text: bloqueCacheable, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: bloqueDinamico },
  ];
}

// historial: [{rol:'user'|'assistant', texto}] tal como lo manda el cliente
// — se re-valida y trunca aquí server-side (nunca confiar en que el cliente
// ya lo limitó a 6 turnos, mismo criterio que el resto de la app aplica a
// cualquier input: recalcular/validar en el servidor, no en el cliente).
function normalizarHistorial(historial) {
  if (!Array.isArray(historial)) return [];
  const limpio = historial
    .filter((h) => h && (h.rol === 'user' || h.rol === 'assistant') && typeof h.texto === 'string' && h.texto.trim())
    .map((h) => ({ role: h.rol, content: h.texto.trim().slice(0, MAX_HISTORIAL_TEXTO_LEN) }));
  return limpio.slice(-MAX_TURNOS_HISTORIAL * 2);
}

async function responderChat({ mensaje, historial, puesto, proyectoNombre, tabsPermitidos }) {
  const texto = String(mensaje || '').trim();
  if (!texto) {
    const err = new Error('El mensaje no puede estar vacío');
    err.status = 400;
    throw err;
  }
  if (texto.length > MAX_MENSAJE_LEN) {
    const err = new Error(`El mensaje no puede superar ${MAX_MENSAJE_LEN} caracteres`);
    err.status = 400;
    throw err;
  }

  const client = getClient();
  const system = buildSystemBlocks({ puesto, proyectoNombre, tabsPermitidos });
  const messages = [...normalizarHistorial(historial), { role: 'user', content: texto }];

  try {
    const resp = await client.messages.create({ model: MODEL, max_tokens: MAX_TOKENS, system, messages });
    // Logging mínimo server-side (nunca al cliente) para confirmar cache
    // hits reales en producción — cache_creation_input_tokens > 0 en la
    // primera llamada de un rol/obra, cache_read_input_tokens > 0 en las
    // siguientes dentro de la ventana de cache (~5 min, ephemeral).
    console.log('[asistente] usage', JSON.stringify(resp.usage));
    return resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  } catch (err) {
    // Nunca reenviar el mensaje crudo de Anthropic (podría filtrar detalles
    // internos) — mismo criterio que el resto de la app con errores de
    // proveedores externos.
    if (err.status) throw err;
    const wrapped = new Error('El asistente no pudo responder en este momento. Intenta de nuevo en unos segundos.');
    wrapped.status = 502;
    throw wrapped;
  }
}

module.exports = { responderChat, MAX_MENSAJE_LEN, buildSystemBlocks };
