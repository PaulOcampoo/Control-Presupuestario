'use strict';

const { chromium } = require('playwright-core');
const db = require('./db');

// Materiales Valdez quedó fuera del comparador: su sitio (materialesvaldez.mx)
// no publica precios en línea en ningún canal (catálogo de categorías/marcas
// sin precios, "Promociones" remite a preguntar en tienda) — no hay nada que
// scrapear. Ver diagnóstico en prompts-cotizador-permisos.md.
const CACHE_HORAS = 24;
const TIMEOUT_NAV_MS = 20000;
const MAX_RESULTADOS_POR_TIENDA = 8;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// En Vercel (serverless) el Chromium normal de Playwright no cabe en el
// límite de tamaño de la función — se usa el binario ligero de
// @sparticuz/chromium. En local (dev/npm run dev) se usa el Chromium normal
// que Playwright ya trae instalado.
// @sparticuz/chromium se publica como ES Module puro — no se puede usar
// require() sobre él desde este módulo CommonJS (ERR_REQUIRE_ESM,
// confirmado en logs reales de Vercel), por eso el import() dinámico.
async function launchBrowser() {
  const t0 = Date.now();
  let browser;
  if (process.env.VERCEL) {
    const { default: chromiumBinary } = await import('@sparticuz/chromium');
    browser = await chromium.launch({
      args: chromiumBinary.args,
      executablePath: await chromiumBinary.executablePath(),
      headless: true,
    });
  } else {
    browser = await chromium.launch({ headless: true });
  }
  console.log(`[cotizador] launchBrowser: ${Date.now() - t0}ms`);
  return browser;
}

// Home Depot MX no muestra el punto decimal en el precio principal de la
// tarjeta (ej. "$62900" = $629.00, "$5,28500" = $5,285.00) — confirmado
// comparando contra "Antes $49.00" / "Ahorras $39.00" de la misma tarjeta
// (49.00 - 39.00 = 10.00, que coincide con "$1000"). Los últimos 2 dígitos
// son siempre los centavos.
function parsePrecioHomeDepot(texto) {
  const limpio = (texto || '').replace(/[^0-9]/g, '');
  if (!limpio) return null;
  return Number(limpio) / 100;
}

// Sodimac MX: el texto de price-value viene en dos formatos según el
// producto — entero plano ("979" = $979.00) o con punto decimal explícito
// ("264.10" = $264.10, visto en productos con badge "Precio mayoreo").
// A diferencia de Home Depot, aquí SÍ hay que conservar el punto decimal —
// bug real encontrado probando con "cemento" (ej. "264.10" se leía como
// $26,410.00 al quitar el punto junto con el resto de no-dígitos).
function parsePrecioSodimac(texto) {
  if (!texto) return null;
  const limpio = texto.replace(/,/g, '').trim();
  const n = parseFloat(limpio);
  return Number.isFinite(n) ? n : null;
}

async function scrapeHomeDepot(browser, query) {
  const page = await browser.newPage({ userAgent: USER_AGENT });
  try {
    const url = `https://www.homedepot.com.mx/s/${encodeURIComponent(query)}?Ntt=${encodeURIComponent(query)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_NAV_MS });
    await page.waitForSelector('.product-container', { timeout: TIMEOUT_NAV_MS }).catch(() => {});
    const crudos = await page.evaluate((max) => {
      return Array.from(document.querySelectorAll('.product-container')).slice(0, max).map((card) => {
        const link = card.querySelector('a[href*="/p/"]');
        const priceEl = card.querySelector('.product-price');
        const nameEl = Array.from(card.querySelectorAll('a[href*="/p/"]')).find((a) => a.textContent.trim().length > 10);
        return {
          nombre_producto: nameEl ? nameEl.textContent.trim() : null,
          precioTexto: priceEl ? priceEl.textContent.trim() : null,
          url_producto: link ? link.href : null,
        };
      });
    }, MAX_RESULTADOS_POR_TIENDA);
    return crudos
      .filter((r) => r.nombre_producto && r.precioTexto)
      .map((r) => ({ nombre_producto: r.nombre_producto, precio: parsePrecioHomeDepot(r.precioTexto), url_producto: r.url_producto }));
  } finally {
    await page.close();
  }
}

async function scrapeSodimac(browser, query) {
  const page = await browser.newPage({ userAgent: USER_AGENT });
  try {
    const url = `https://www.sodimac.com.mx/sodimac-mx/search?Ntt=${encodeURIComponent(query)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_NAV_MS });
    await page.waitForSelector('[data-pod]', { timeout: TIMEOUT_NAV_MS }).catch(() => {});
    const crudos = await page.evaluate((max) => {
      return Array.from(document.querySelectorAll('[data-pod]')).slice(0, max).map((card) => {
        const href = card.tagName === 'A' ? card.href : (card.querySelector('a') ? card.querySelector('a').href : null);
        const priceValue = card.querySelector('.price-value');
        const nameEl = card.querySelector('.pod-subTitle');
        return {
          nombre_producto: nameEl ? nameEl.textContent.trim() : null,
          precioTexto: priceValue ? priceValue.textContent.trim() : null,
          url_producto: href,
        };
      });
    }, MAX_RESULTADOS_POR_TIENDA);
    return crudos
      .filter((r) => r.nombre_producto && r.precioTexto)
      .map((r) => ({ nombre_producto: r.nombre_producto, precio: parsePrecioSodimac(r.precioTexto), url_producto: r.url_producto }));
  } finally {
    await page.close();
  }
}

const SCRAPERS = { home_depot: scrapeHomeDepot, sodimac: scrapeSodimac };

// Un navegador NUEVO y AISLADO por tienda, no uno compartido reusado para
// ambas — confirmado en Preview real (function serverless, Vercel) que
// reusar un solo browser para 2 páginas SPA pesadas seguidas (aunque sea en
// secuencia, no en paralelo) deja al binario ligero de @sparticuz/chromium
// inestable: la tienda que corre SEGUNDA falla con "Target page, context or
// browser has been closed" — reproducido con ambos órdenes (Home Depot
// primero y Sodimac primero), o sea que no es cuestión de qué sitio es más
// pesado, sino de que el proceso de Chromium no aguanta una segunda carga
// completa de SPA reusando la misma instancia en este entorno.
async function scrapeTienda(tienda, query) {
  const tInicio = Date.now();
  const browser = await launchBrowser();
  try {
    const resultados = await SCRAPERS[tienda](browser, query);
    console.log(`[cotizador] ${tienda} OK: ${Date.now() - tInicio}ms total, ${resultados.length} resultados`);
    return { tienda, resultados, error: null };
  } catch (err) {
    console.log(`[cotizador] ${tienda} ERROR tras ${Date.now() - tInicio}ms: ${err.message}`);
    return { tienda, resultados: [], error: err.message };
  } finally {
    await browser.close();
  }
}

async function scrapeEnVivo(query) {
  const tInicio = Date.now();
  const porTienda = [
    await scrapeTienda('home_depot', query),
    await scrapeTienda('sodimac', query),
  ];
  console.log(`[cotizador] scrapeEnVivo total: ${Date.now() - tInicio}ms para query="${query}"`);
  const ahora = new Date();
  const filas = [];
  for (const { tienda, resultados } of porTienda) {
    for (const r of resultados) {
      filas.push({ query_busqueda: query, tienda, nombre_producto: r.nombre_producto, precio: r.precio, url_producto: r.url_producto, fecha_consulta: ahora });
    }
  }
  await db.withTransaction(async (client) => {
    await client.query('DELETE FROM cotizador_precios WHERE query_busqueda = $1', [query]);
    for (const f of filas) {
      await client.query(
        `INSERT INTO cotizador_precios (query_busqueda, tienda, nombre_producto, precio, url_producto, fecha_consulta)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [f.query_busqueda, f.tienda, f.nombre_producto, f.precio, f.url_producto, f.fecha_consulta]
      );
    }
  });
  return {
    query,
    fecha_consulta: ahora,
    errores: porTienda.filter((r) => r.error).map((r) => ({ tienda: r.tienda, error: r.error })),
    resultados: filas,
  };
}

async function buscarPrecios(query, { forzar = false } = {}) {
  const normalizada = (query || '').trim().toLowerCase();
  if (!normalizada) throw new Error('Indica un término de búsqueda');

  if (!forzar) {
    const { rows } = await db.pool.query(
      `SELECT * FROM cotizador_precios
       WHERE query_busqueda = $1 AND fecha_consulta > NOW() - ($2 || ' hours')::interval
       ORDER BY tienda, precio ASC NULLS LAST`,
      [normalizada, CACHE_HORAS]
    );
    if (rows.length) {
      return { query: normalizada, fecha_consulta: rows[0].fecha_consulta, resultados: rows, errores: [], desdeCache: true };
    }
  }

  const resultado = await scrapeEnVivo(normalizada);
  return { ...resultado, query: normalizada, desdeCache: false };
}

// Queries distintas consultadas en las últimas 24h (aproximación simple de
// "más buscadas" — sin tabla de log de búsquedas dedicada, se usa el propio
// cache como proxy de qué se ha estado consultando).
async function queriesRecientes(limite = 15) {
  const { rows } = await db.pool.query(
    `SELECT DISTINCT query_busqueda, MAX(fecha_consulta) AS ultima
     FROM cotizador_precios
     WHERE fecha_consulta > NOW() - INTERVAL '24 hours'
     GROUP BY query_busqueda ORDER BY ultima DESC LIMIT $1`,
    [limite]
  );
  return rows.map((r) => r.query_busqueda);
}

module.exports = { buscarPrecios, scrapeEnVivo, queriesRecientes };
