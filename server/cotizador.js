'use strict';

const { chromium } = require('playwright-core');
const db = require('./db');

// Materiales Valdez quedó fuera del comparador: su sitio (materialesvaldez.mx)
// no publica precios en línea en ningún canal (catálogo de categorías/marcas
// sin precios, "Promociones" remite a preguntar en tienda) — no hay nada que
// scrapear. Ver diagnóstico en prompts-cotizador-permisos.md.
//
// Mercado Libre MX y Construrama quedaron fuera del comparador (diagnóstico
// de Fase 0, prompt-cotizador-mas-tiendas.md): ambos bloquean scraping
// automatizado de forma consistente, no con un CAPTCHA resoluble sino con un
// firewall de tráfico automatizado —
//   - Construrama exige elegir tienda física por CP antes de mostrar
//     cualquier producto/precio, y el endpoint que resuelve esa selección
//     (`/Comun/store-finder/googleApiAutocomplete`) está protegido por
//     Incapsula: devuelve un bloqueo explícito ("Request unsuccessful.
//     Incapsula incident ID…") en vez de datos.
//   - Mercado Libre mostró una pantalla real de verificación ("Por
//     seguridad, completa este paso", botón "Continuar" deshabilitado
//     esperando validación automática) en 3 de 4 intentos rápidos y
//     secuenciales — bloqueo consistente, no un caso aislado.
// Amazon MX sí resultó viable: un interstitial de un solo click
// ("Continuar a Compras") que aparece de forma intermitente, sin bloqueo
// de fondo — ver scrapeAmazon.
const CACHE_HORAS = 24;
const TIMEOUT_NAV_MS = 20000;
const MAX_RESULTADOS_POR_TIENDA = 8;

// Diagnóstico real (prompt-diagnostico-cotizador-colgado.md, logs de Vercel):
// Home Depot MX consistentemente tarda 30-40s por sí solo (goto +
// waitForSelector, cada uno con tope de TIMEOUT_NAV_MS, encadenados) —  es
// la carga/hidratación real de su SPA, no un selector roto (los 8
// resultados sí llegan cada vez). Sodimac en cambio tarda 8-10s. Como el
// scraping es secuencial (browser aislado por tienda, ver scrapeTienda),
// el tiempo total = suma de ambas, dejando poco margen frente al
// maxDuration:90 configurado en vercel.json — de ahí el 504 intermitente.
// Este presupuesto evita que la función SIEMPRE llegue al límite duro de
// la plataforma: si ya no queda tiempo razonable para intentar la
// siguiente tienda, se omite y se reporta como error explícito en vez de
// arriesgar un timeout sin respuesta.
const PRESUPUESTO_TOTAL_MS = 90000; // debe coincidir con functions."api/index.js".maxDuration en vercel.json
const MARGEN_RESPUESTA_MS = 15000; // reservado para guardar en DB y armar la respuesta
// Amazon con ubicación configurada mide ~15-20s solo para fijar el CP
// (prompt-cotizador-mas-tiendas.md, diagnóstico real) antes incluso de
// extraer resultados — subido de 15000 a 20000 para no intentar una tienda
// que ya sabemos no le va a alcanzar el tiempo.
const TIEMPO_MINIMO_TIENDA_MS = 20000; // por debajo de esto no vale la pena intentar otra tienda
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

// Amazon MX ya trae el precio formateado con punto decimal explícito en el
// span accesible .a-offscreen (ej. "$504.00", "$218.49") — a diferencia de
// Home Depot no hay que inferir dónde van los centavos.
function parsePrecioAmazon(texto) {
  if (!texto) return null;
  const limpio = texto.replace(/[^0-9.]/g, '');
  const n = parseFloat(limpio);
  return Number.isFinite(n) ? n : null;
}

// Fija la ubicación de envío (CP) guardada en cotizador_config, si existe —
// confirmado en diagnóstico real (prompt-cotizador-mas-tiendas.md) que los
// selectores #nav-global-location-popover-link / #GLUXZipUpdateInput /
// #GLUXZipUpdate son estables y el flujo tarda ~15s. Sin ubicación
// configurada se omite este paso entero (resultados quedan con el CP
// genérico que Amazon infiere por geo-IP) para no gastar ese tiempo si Paul
// no ha configurado nada todavía.
async function fijarUbicacionAmazon(page, codigoPostal) {
  if (!codigoPostal) return;
  try {
    const zipInput = page.locator('#GLUXZipUpdateInput').first();
    // El primer click a veces abre de un tiro el modal con el input de CP y
    // a veces solo un flyout intermedio con la ubicación actual (confirmado
    // en pruebas reales: mismo selector, resultado inconsistente) — un
    // segundo click sobre el mismo enlace resuelve el caso lento sin
    // necesidad de distinguir cuál de los dos pasó.
    await page.locator('#nav-global-location-popover-link, #glow-ingress-block').first().click({ timeout: 8000 });
    await page.waitForTimeout(1500); // dar tiempo a que el modal/flyout renderice antes de decidir si hace falta un 2º click
    if (!(await zipInput.isVisible().catch(() => false))) {
      await page.locator('#nav-global-location-popover-link, #glow-ingress-block').first().click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }
    await zipInput.waitFor({ state: 'visible', timeout: 8000 });
    await zipInput.fill(codigoPostal);
    await page.locator('#GLUXZipUpdate input[type="submit"], #GLUXZipUpdate button').first().click({ timeout: 5000 });
    await page.waitForTimeout(2000);
    const doneBtn = page.locator('button:has-text("Listo"), input[aria-labelledby*="GLUXConfirmClose"]').first();
    if (await doneBtn.count()) await doneBtn.click({ timeout: 5000 }).catch(() => {});
  } catch (err) {
    console.log(`[cotizador] amazon: no se pudo fijar ubicación (${err.message}) — se sigue con el resultado sin ubicación fija`);
  }
}

// El interstitial "Continuar a Compras" es un chequeo de continuidad de
// sesión de Amazon que aparece de forma intermitente (confirmado: 0 de 4
// intentos en una corrida, gate presente en otra) — no es un CAPTCHA, un
// solo click basta.
async function scrapeAmazon(browser, query, config) {
  const page = await browser.newPage({ userAgent: USER_AGENT });
  try {
    const url = `https://www.amazon.com.mx/s?k=${encodeURIComponent(query)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_NAV_MS });
    const gate = page.locator('button:has-text("Continuar a Compras")').first();
    if (await gate.count().catch(() => 0)) {
      await gate.click({ timeout: 5000 }).catch(() => {});
      await page.waitForLoadState('domcontentloaded', { timeout: TIMEOUT_NAV_MS }).catch(() => {});
    }
    await fijarUbicacionAmazon(page, config?.codigo_postal);
    await page.waitForSelector('[data-component-type="s-search-result"]', { timeout: TIMEOUT_NAV_MS }).catch(() => {});
    const crudos = await page.evaluate((max) => {
      // Excluye resultados patrocinados — no reflejan el precio real de
      // compra que un usuario elegiría orgánicamente, solo pauta.
      const tarjetas = Array.from(document.querySelectorAll('[data-component-type="s-search-result"]'))
        .filter((card) => !card.textContent.includes('Patrocinado'));
      return tarjetas.slice(0, max).map((card) => {
        const link = card.querySelector('h2 a, a.a-link-normal.s-line-clamp-2, a.a-link-normal[href*="/dp/"]');
        const nombreEl = card.querySelector('h2 span, h2');
        const precioEl = card.querySelector('.a-price .a-offscreen');
        return {
          nombre_producto: nombreEl ? nombreEl.textContent.trim() : null,
          precioTexto: precioEl ? precioEl.textContent.trim() : null,
          url_producto: link ? link.href : null,
        };
      });
    }, MAX_RESULTADOS_POR_TIENDA);
    return crudos
      .filter((r) => r.nombre_producto && r.precioTexto)
      .map((r) => ({ nombre_producto: r.nombre_producto, precio: parsePrecioAmazon(r.precioTexto), url_producto: r.url_producto }));
  } finally {
    await page.close();
  }
}

const SCRAPERS = { home_depot: scrapeHomeDepot, sodimac: scrapeSodimac, amazon: scrapeAmazon };

// Un navegador NUEVO y AISLADO por tienda, no uno compartido reusado para
// ambas — confirmado en Preview real (function serverless, Vercel) que
// reusar un solo browser para 2 páginas SPA pesadas seguidas (aunque sea en
// secuencia, no en paralelo) deja al binario ligero de @sparticuz/chromium
// inestable: la tienda que corre SEGUNDA falla con "Target page, context or
// browser has been closed" — reproducido con ambos órdenes (Home Depot
// primero y Sodimac primero), o sea que no es cuestión de qué sitio es más
// pesado, sino de que el proceso de Chromium no aguanta una segunda carga
// completa de SPA reusando la misma instancia en este entorno.
async function scrapeTienda(tienda, query, config) {
  const tInicio = Date.now();
  const browser = await launchBrowser();
  try {
    const resultados = await SCRAPERS[tienda](browser, query, config);
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
  const config = await getConfig();
  const porTienda = [];
  for (const tienda of Object.keys(SCRAPERS)) {
    const transcurrido = Date.now() - tInicio;
    const restante = PRESUPUESTO_TOTAL_MS - MARGEN_RESPUESTA_MS - transcurrido;
    if (restante < TIEMPO_MINIMO_TIENDA_MS) {
      console.log(`[cotizador] ${tienda} OMITIDA: quedan ${restante}ms de presupuesto tras ${transcurrido}ms`);
      porTienda.push({ tienda, resultados: [], error: 'Omitida: no quedaba tiempo suficiente en esta consulta (intenta de nuevo)' });
      continue;
    }
    porTienda.push(await scrapeTienda(tienda, query, config));
  }
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

// Ubicación fija para cotizar en Amazon (única tienda del comparador que la
// soporta — ver diagnóstico de Fase 0 arriba). Una sola fila activa para
// toda la app, no por usuario.
async function getConfig() {
  const { rows } = await db.pool.query('SELECT ciudad, codigo_postal, updated_at FROM cotizador_config WHERE id = 1');
  return rows[0] || { ciudad: null, codigo_postal: null, updated_at: null };
}

async function setConfig({ ciudad, codigo_postal, usuario_id }) {
  const { rows } = await db.pool.query(
    `INSERT INTO cotizador_config (id, ciudad, codigo_postal, updated_at, updated_by)
     VALUES (1, $1, $2, NOW(), $3)
     ON CONFLICT (id) DO UPDATE SET ciudad = $1, codigo_postal = $2, updated_at = NOW(), updated_by = $3
     RETURNING ciudad, codigo_postal, updated_at`,
    [ciudad || null, codigo_postal || null, usuario_id]
  );
  return rows[0];
}

module.exports = { buscarPrecios, scrapeEnVivo, queriesRecientes, getConfig, setConfig };
