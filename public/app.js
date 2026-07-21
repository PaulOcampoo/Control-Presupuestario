'use strict';

/* =========================================================================
 * Control Presupuestal de Obra — SPA (vanilla JS, mobile-first PWA)
 * ========================================================================= */

const TOKEN_KEY = 'cp_token';
const PUESTO_LABELS = {
  admin: 'Administrador', desarrollador: 'Desarrollador', residente: 'Residente', cabo: 'Cabo',
  compras: 'Compras', tesoreria: 'Tesorería', administracion: 'Administración', logistica: 'Logística',
  taller: 'Taller',
};

// Mirror de PERMISSIONS en server/auth.js — para calcular allowedTabs en vista simulada.
// Actualizar aquí si se agregan roles o pestañas en auth.js.
const ROLE_TABS = {
  admin:          ['resumen', 'contrato', 'impuestos', 'insumos', 'requisiciones', 'ordenes', 'avance', 'programa', 'destajo', 'usuarios', 'proveedores', 'finanzas', 'mapeo', 'trabajadores', 'trabajadores_global', 'nominas', 'nominas_global', 'estimaciones', 'maquinaria', 'cotizador'],
  desarrollador:  ['resumen', 'contrato', 'impuestos', 'insumos', 'requisiciones', 'ordenes', 'avance', 'programa', 'destajo', 'usuarios', 'proveedores', 'finanzas', 'mapeo', 'trabajadores', 'trabajadores_global', 'nominas', 'nominas_global', 'estimaciones', 'maquinaria', 'cotizador'],
  residente:      ['programa', 'avance', 'destajo', 'requisiciones', 'insumos', 'ordenes', 'nominas', 'trabajadores', 'estimaciones'],
  cabo:           ['destajo', 'insumos', 'avance', 'requisiciones', 'maquinaria'],
  compras:        ['programa', 'requisiciones', 'insumos', 'ordenes', 'proveedores', 'cotizador'],
  tesoreria:      ['resumen', 'finanzas', 'ordenes', 'contrato', 'impuestos', 'proveedores'],
  administracion: ['resumen', 'programa', 'destajo', 'ordenes', 'proveedores', 'contrato', 'impuestos', 'mapeo'],
  logistica:      ['programa', 'avance', 'requisiciones', 'insumos', 'ordenes'],
  taller:         ['maquinaria'],
};

const state = {
  projects: [],
  projectId: null,
  clientes: [],
  favoritos: new Set(), // cliente_id de favoritos del usuario (Prompt B) — Set para O(1) lookup al pintar tarjetas
  favoritosOrden: [], // mismos IDs que favoritos, pero en el orden elegido por drag (prompt-dashboard-favoritos-layout.md) — GET /favoritos ya los devuelve ordenados
  clienteId: null,
  pendingUploadClienteId: null,
  pendingContrato: null,
  view: 'inicio',
  section: null,     // sección activa (obra/compras/administracion/tesoreria/maquinaria) o null
  cache: {},     // per-project cached API responses
  charts: {},    // active Chart.js instances (destroyed on re-render)
  chartsSeen: new Set(), // keys de gráficas ya animadas una vez en esta sesión — ver animationForChart()
  token: null,
  user: null,        // { id, nombre, usuario, puesto }
  allowedTabs: [],
  simulatedPuesto: null,  // rol simulado (solo desarrollador); null = vista real
  _realAllowedTabs: null, // backup de allowedTabs reales durante simulación
  notificaciones: [],
  notifNoLeidas: 0,
  notifTimer: null,
  needsTotpReminder: false, // 2FA opcional: banner en Inicio pendiente de mostrarse esta sesión
  usuariosSubView: null, // 'permisos' cuando se entra desde el acceso directo del drawer de galería; se consume una vez en renderView()
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---------------------------------------------------------------------------
// Íconos SVG minimalistas (Lucide-style, stroke, viewBox 0 0 24 24).
// icon(name, size) devuelve el HTML listo para insertar en templates.
// ---------------------------------------------------------------------------
const ICON_SVG = {
  moon:          '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  sun:           '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>',
  obra:          '<path d="M3 21h18M5 21V7l7-4 7 4v14"/><path d="M9 21v-6h6v6"/>',
  compras:       '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>',
  administracion:'<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  tesoreria:     '<rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/>',
  maquinaria:    '<rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
  resumen:       '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  contrato:      '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  impuestos:     '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z"/><line x1="14" y1="8" x2="8" y2="8"/><line x1="16" y1="12" x2="8" y2="12"/><line x1="13" y1="16" x2="8" y2="16"/>',
  insumos:       '<line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  requisiciones: '<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="11" y2="16"/>',
  proveedores:   '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  ordenes:       '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>',
  programa:      '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  avance:        '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
  destajo:       '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  finanzas:      '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  estadoResultados: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><path d="M2 20h20"/>',
  mapeo:         '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  usuarios:      '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  lock:          '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  'chevron-down':  '<polyline points="6 9 12 15 18 9"/>',
  'chevron-left':  '<polyline points="15 18 9 12 15 6"/>',
  'chevron-right': '<polyline points="9 18 15 12 9 6"/>',
  monitor:         '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
  warning:       '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  check:         '<polyline points="20 6 9 17 4 12"/>',
  x:             '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  pencil:        '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
  phone:         '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.88 10.3 19.79 19.79 0 0 1 2 1.63 2 2 0 0 1 4.11 0h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 7.91A16 16 0 0 0 15.1 15l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 23 16.92z"/>',
  list:          '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  'layout-grid': '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
  search:        '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  folder:        '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  building:      '<rect x="4" y="2" width="16" height="20"/><path d="M9 22V12h6v10"/><path d="M2 22h20"/><line x1="9" y1="7" x2="9.01" y2="7"/><line x1="15" y1="7" x2="15.01" y2="7"/>',
  bell:          '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  'log-out':     '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  home:          '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  settings:      '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
};

function icon(name, size = 18) {
  const inner = ICON_SVG[name] || ICON_SVG.warning;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="icon-svg">${inner}</svg>`;
}

// ---------------------------------------------------------------------------
// Tema — 3 modos: 'light' | 'dark' | 'system'. El modo 'system' sigue la
// preferencia del SO via matchMedia. El atributo data-theme en <html> ya se
// aplica de forma síncrona en el <script> inline de index.html (antes de
// pintar, para evitar parpadeo). Aquí se gestiona el runtime completo.
// ---------------------------------------------------------------------------
const THEME_KEY = 'cp_theme';
const _mqDark = window.matchMedia('(prefers-color-scheme: dark)');

function getTheme() {
  return localStorage.getItem(THEME_KEY) || 'light';
}

function getEffectiveTheme() {
  const t = getTheme();
  if (t === 'system') return _mqDark.matches ? 'dark' : 'light';
  return t;
}

// FIX (prompt-fix-chart-y-2-paletas-nuevas.md): antes devolvía hex fijos
// (en realidad los valores resueltos de --text-secondary/--border-color de
// la paleta Dorada, copiados a mano) — se veían bien en Dorada por
// coincidencia, pero no seguían ni el tema ni la paleta activos. Ahora lee
// las custom properties reales en vivo, así que cualquier paleta nueva
// (incluida Morada) queda cubierta automáticamente sin tocar esta función
// de nuevo. cc.surface/cc.primary son para el borderColor de los donuts —
// deben coincidir con el fondo REAL detrás del canvas (tarjeta .card vs.
// fondo de página), ver applyChartTheme().
function chartColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  return {
    text: v('--text-primary'),
    tick: v('--text-secondary'),
    grid: v('--border-color'),
    surface: v('--bg-surface'),
    primary: v('--bg-primary'),
  };
}

// Re-pinta colores de TODOS los charts activos al cambiar tema/paleta en
// caliente (sin recargar) — chartColors() solo se leía una vez al crear
// cada Chart.js, así que sin esto los charts ya montados se quedaban con
// los colores del render inicial. update('none') evita repetir la
// animación de entrada solo por el cambio de color.
function applyChartTheme(chart, cc) {
  if (!chart || !chart.options) return;
  const scales = chart.options.scales;
  if (scales) {
    ['x', 'y'].forEach((axis) => {
      const scale = scales[axis];
      if (!scale) return;
      if (scale.ticks) scale.ticks.color = cc.tick;
      if (scale.grid && scale.grid.display !== false) scale.grid.color = cc.grid;
    });
  }
  const legendLabels = chart.options.plugins?.legend?.labels;
  if (legendLabels) legendLabels.color = cc.text;
  const ds = chart.data.datasets[0];
  // Donut: el borderColor de cada segmento debe fundirse con el fondo real
  // detrás del canvas (tag puesto al crear el chart, ver _cpBorderSurface).
  if (chart._cpBorderSurface && ds) {
    ds.borderColor = cc[chart._cpBorderSurface];
  }
  // Donut: el/los segmento(s) "vacíos" (ej. "Resto por ejecutar") se pintan
  // con cc.grid al crear el chart — sin esto quedaban pegados al cc.grid de
  // la paleta que estaba activa en ese momento (bug real encontrado al
  // probar el hot-swap: cambiar de paleta recoloreaba todo MENOS este
  // segmento). _cpGridBgIndexes son los índices de backgroundColor a
  // re-derivar de cc.grid en cada refresh.
  if (chart._cpGridBgIndexes && ds && Array.isArray(ds.backgroundColor)) {
    chart._cpGridBgIndexes.forEach((i) => { ds.backgroundColor[i] = cc.grid; });
  }
  chart.update('none');
}

function refreshAllChartsTheme() {
  const cc = chartColors();
  Object.values(state.charts).forEach((chart) => applyChartTheme(chart, cc));
}

// Chart.js recrea la instancia en cada repintado de vista (el <canvas> se
// reconstruye junto con el resto del HTML — no hay forma barata de reusar la
// instancia vía .update() sin reestructurar el render de cada vista). Lo que
// sí podemos evitar es que la animación de "crecer desde cero" (~1000ms
// default de Chart.js) se repita en cada refresco: una gráfica ya vista una
// vez en esta sesión (por proyecto+key) no necesita volver a animarse igual
// que la primera vez — solo la primera vez amerita el efecto de entrada.
function animationForChart(key) {
  if (state.chartsSeen.has(key)) return false;
  state.chartsSeen.add(key);
  return undefined; // undefined = Chart.js usa su animación default
}

// meta[name=theme-color] (color de la barra de estado del navegador/PWA) —
// depende de AMBOS: paleta y modo efectivo, así que vive fuera de
// applyTheme/applyPalette y ambas la llaman al final.
const PALETTE_META_COLORS = {
  dorada: { light: '#EAEEF5', dark: '#0B1220' },
  morada: { light: '#F3EFFA', dark: '#030014' },
};
function updateThemeColorMeta() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const colors = PALETTE_META_COLORS[getPalette()] || PALETTE_META_COLORS.dorada;
  meta.setAttribute('content', colors[getEffectiveTheme()]);
}

function applyTheme(pref) {
  const effective = pref === 'system' ? (_mqDark.matches ? 'dark' : 'light') : pref;
  document.documentElement.setAttribute('data-theme', effective);
  const btn = $('#btnThemeToggle');
  if (btn) btn.innerHTML = effective === 'light' ? icon('moon', 16) : icon('sun', 16);
  updateThemeColorMeta();
  // Actualizar botones activos en el popover
  $$('.theme-opt').forEach((el) => el.classList.toggle('active', el.dataset.themeSet === pref));
  // Actualizar íconos en el popover
  const li = $('#themeIconLight'); if (li) li.innerHTML = icon('sun', 14);
  const di = $('#themeIconDark');  if (di) di.innerHTML = icon('moon', 14);
  const si = $('#themeIconSystem');if (si) si.innerHTML = icon('monitor', 14);
  // Mismos íconos en el drawer de ajustes de la galería de clientes (prompt 2,
  // prompts-cotizador-sidebar-permisos-estimaciones.md) — reusa esta misma
  // función en vez de duplicar la lógica de tema.
  const gli = $('#galleryThemeIconLight'); if (gli) gli.innerHTML = icon('sun', 14);
  const gdi = $('#galleryThemeIconDark');  if (gdi) gdi.innerHTML = icon('moon', 14);
  const gsi = $('#galleryThemeIconSystem');if (gsi) gsi.innerHTML = icon('monitor', 14);
  refreshAllChartsTheme();
}

function setTheme(pref) {
  localStorage.setItem(THEME_KEY, pref);
  applyTheme(pref);
}

function toggleTheme() {
  // Toggle de 2 pasos para el botón del topbar (acceso rápido móvil)
  const next = getEffectiveTheme() === 'light' ? 'dark' : 'light';
  setTheme(next);
}

// ---------------------------------------------------------------------------
// Paleta de colores (prompt-selector-paleta-colores.md) — 4 opciones: Dorada
// ("Tema GRUPO ROFORB", valores sin tocar desde que se agregó el selector),
// Morada ("Tema NYRA", default actual — ver getPalette()), Verde ("Tema
// JADE") y Naranja ("Tema TERRA"). Mismo mecanismo que el tema: atributo en
// <html> (data-palette, aplicado antes del primer paint en theme-init.js) +
// localStorage, aplicando DENTRO del modo claro/oscuro ya elegido arriba —
// ver los bloques [data-palette="..."] en styles.css.
// ---------------------------------------------------------------------------
const PALETTE_KEY = 'cp_palette';

// Default para usuarios sin preferencia guardada (prompt-fix-chart-y-2-
// paletas-nuevas.md): pasa de 'dorada' a 'morada' ("Tema NYRA"). Usuarios
// que YA tienen algo guardado en localStorage (dorada o morada) no se ven
// afectados — este fallback solo aplica cuando la key ni existe.
function getPalette() {
  return localStorage.getItem(PALETTE_KEY) || 'morada';
}

function applyPalette(pref) {
  document.documentElement.setAttribute('data-palette', pref);
  $$('.palette-opt').forEach((el) => el.classList.toggle('active', el.dataset.paletteSet === pref));
  updateThemeColorMeta();
  refreshAllChartsTheme();
}

function setPalette(pref) {
  localStorage.setItem(PALETTE_KEY, pref);
  applyPalette(pref);
}

// Actualizar en vivo cuando el SO cambia y el usuario eligió 'system'
_mqDark.addEventListener('change', () => { if (getTheme() === 'system') applyTheme('system'); });

applyTheme(getTheme());
applyPalette(getPalette());

// ---------------------------------------------------------------------------
// Observabilidad (Sentry) y analytics (PostHog) — ambos detrás de su propia
// key pública, servida por GET /api/public-config (sin auth, ver server/app.js:
// son claves públicas por diseño de sus SDKs, no secretos). Sin key, cada SDK
// simplemente no se inicializa — Paul debe crear las cuentas y agregar
// SENTRY_DSN/POSTHOG_API_KEY en Vercel para activarlos (mismo patrón que el
// bloqueo actual de SMS/email 2FA con Resend/Twilio).
// ---------------------------------------------------------------------------
let sentryActive = false;
let posthogActive = false;
async function initObservability() {
  try {
    const cfg = await fetch('/api/public-config').then((r) => r.json());
    if (cfg.sentryDsn && window.SentryBrowser) {
      window.SentryBrowser.init({ dsn: cfg.sentryDsn, environment: location.hostname === 'localhost' ? 'development' : 'production' });
      sentryActive = true;
    }
    if (cfg.posthogKey && window.posthog) {
      window.posthog.init(cfg.posthogKey, { api_host: cfg.posthogHost || 'https://app.posthog.com', capture_pageview: false, autocapture: false });
      posthogActive = true;
    }
  } catch (_) { /* best-effort — nunca bloquea el arranque de la app */ }
}
initObservability();

// Etiqueta los eventos de Sentry con proyecto_id/usuario_id (sin PII
// adicional) para poder filtrar por obra — llamar tras login y al cambiar de
// proyecto (ver applySession() y selectProject()).
function syncErrorTags() {
  if (!sentryActive || !window.SentryBrowser) return;
  if (state.user?.id) window.SentryBrowser.setTag('usuario_id', state.user.id);
  if (state.projectId) window.SentryBrowser.setTag('proyecto_id', state.projectId);
}

// Los 4 eventos de analytics que pide el alcance de esta fase — nada más
// (ver prompt-cerrar-gaps-mayores.md, Punto 3). Sin key, es un no-op.
function trackEvent(nombre, props = {}) {
  if (!posthogActive || !window.posthog) return;
  try { window.posthog.capture(nombre, props); } catch (_) { /* best-effort */ }
}

// error_boundary del lado frontend — independiente de Sentry (Sentry ya
// captura estos mismos eventos vía sus propias integraciones de
// window.onerror/unhandledrejection, pero PostHog necesita su propio
// listener; ambos SDKs pueden estar activos o inactivos de forma
// independiente entre sí, según qué keys tenga configuradas Paul).
window.addEventListener('error', (e) => {
  trackEvent('error_boundary', { mensaje: e.message, origen: 'window.onerror' });
});
window.addEventListener('unhandledrejection', (e) => {
  trackEvent('error_boundary', { mensaje: String(e.reason?.message || e.reason || ''), origen: 'unhandledrejection' });
});

// ---------------------------------------------------------------------------
// Performance: Time to Interactive (medición básica, PerformanceObserver
// nativo — sin librería externa). Aproximación simple, no el algoritmo
// completo de Lighthouse: espera 500ms sin 'longtask' después de que
// tryRestoreSession() termina (login mostrado o app arrancada, ver Boot al
// final del archivo) para considerar que la app ya está "quieta". Si el
// navegador no soporta la entrada 'longtask' (ej. Safari), se usa
// directamente el momento en que tryRestoreSession() terminó.
// ---------------------------------------------------------------------------
function medirTTI() {
  let quietTimer = null;
  const finalize = () => {
    const ttiMs = Math.round(performance.now());
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      console.log(`[perf] Time to Interactive (aprox.): ${ttiMs}ms`);
    } else {
      trackEvent('performance_tti', { tti_ms: ttiMs });
    }
  };
  try {
    const obs = new PerformanceObserver(() => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finalize, 500);
    });
    obs.observe({ type: 'longtask', buffered: true });
    quietTimer = setTimeout(finalize, 500); // por si no hubo ningún long task
  } catch (_) {
    finalize(); // 'longtask' no soportado — se usa el momento actual directamente
  }
}

$('#btnThemeToggle').addEventListener('click', toggleTheme);
// Wiring global de los selectores de paleta ya presentes en el DOM al cargar
// (drawer de galería + popover de escritorio) — mismo patrón que
// [data-theme-set] más abajo. El de openMobileAjustes() se wirea aparte,
// donde se inyecta su HTML (no existe en el DOM hasta que se abre).
$$('[data-palette-set]').forEach((btn) => {
  btn.addEventListener('click', () => setPalette(btn.dataset.paletteSet));
});

// ---------------------------------------------------------------------------
// Accesibilidad (Ajustes > Accesibilidad) — 3 controles independientes entre
// sí y del tema, cada uno persistido en su propia key de localStorage (mismo
// patrón que THEME_KEY). Reducir movimiento y Alto contraste son clases en
// <body>; tamaño de fuente es un atributo en <html> (para escalar las
// unidades rem de toda la app, igual que hace data-theme con los colores).
// ---------------------------------------------------------------------------
const A11Y_MOTION_KEY = 'cp_a11y_reduce_motion';
const A11Y_CONTRAST_KEY = 'cp_a11y_high_contrast';
const A11Y_FONT_KEY = 'cp_a11y_font_size'; // 'normal' | 'large' | 'xlarge'

function getReduceMotion() { return localStorage.getItem(A11Y_MOTION_KEY) === 'true'; }
function getHighContrast() { return localStorage.getItem(A11Y_CONTRAST_KEY) === 'true'; }
function getFontSize() { return localStorage.getItem(A11Y_FONT_KEY) || 'normal'; }

function applyA11ySettings() {
  document.body.classList.toggle('a11y-reduce-motion', getReduceMotion());
  document.body.classList.toggle('a11y-high-contrast', getHighContrast());
  document.documentElement.setAttribute('data-font-size', getFontSize());
}

function setReduceMotion(on) { localStorage.setItem(A11Y_MOTION_KEY, on ? 'true' : 'false'); applyA11ySettings(); }
function setHighContrast(on) { localStorage.setItem(A11Y_CONTRAST_KEY, on ? 'true' : 'false'); applyA11ySettings(); }
function setFontSize(size) { localStorage.setItem(A11Y_FONT_KEY, size); applyA11ySettings(); }

applyA11ySettings();

// ---------------------------------------------------------------------------
// Tamaño de tarjetas de cliente (Prompt B.3, prompts-animaciones-y-galeria-
// clientes.md) — botones +/- en vez de slider, 4 pasos. Persistido en
// localStorage (preferencia de dispositivo/pantalla, no del usuario en sí —
// a diferencia de favoritos, que si viaja en BD). Aplicado vía CSS variable
// en :root para que .cliente-grid (galería y franja de Favoritos, ambas) lo
// hereden sin JS adicional — ver el fallback var(--cliente-card-min, 130px)
// en styles.css.
// ---------------------------------------------------------------------------
const CLIENTE_CARD_SIZE_KEY = 'cp_cliente_card_size';
const CLIENTE_CARD_SIZES = [110, 130, 150, 180]; // px — índice 1 (130px) es el tamaño original, sin cambio

function getClienteCardSizeIndex() {
  const saved = Number(localStorage.getItem(CLIENTE_CARD_SIZE_KEY));
  const idx = CLIENTE_CARD_SIZES.indexOf(saved);
  return idx >= 0 ? idx : 1;
}

function applyClienteCardSize() {
  const px = CLIENTE_CARD_SIZES[getClienteCardSizeIndex()];
  document.documentElement.style.setProperty('--cliente-card-min', `${px}px`);
}

function setClienteCardSizeIndex(idx) {
  const clamped = Math.max(0, Math.min(CLIENTE_CARD_SIZES.length - 1, idx));
  localStorage.setItem(CLIENTE_CARD_SIZE_KEY, CLIENTE_CARD_SIZES[clamped]);
  applyClienteCardSize();
}

applyClienteCardSize();
$('#btnIconSizeDown')?.addEventListener('click', () => setClienteCardSizeIndex(getClienteCardSizeIndex() - 1));
$('#btnIconSizeUp')?.addEventListener('click', () => setClienteCardSizeIndex(getClienteCardSizeIndex() + 1));

// ---------------------------------------------------------------------------
// Vista grid/lista de "Presupuestos" en renderResumenCliente (prompt-rediseno-
// navegacion-subsecciones.md, Fix A) — mismo patrón de persistencia que el
// tema (localStorage, sin backend). Solo cambia el layout del contenedor;
// las tarjetas .proyecto-resumen-card no cambian de markup entre modos.
// ---------------------------------------------------------------------------
const PRESUPUESTO_VIEW_KEY = 'cp_presupuesto_view';
function getPresupuestoViewMode() {
  return localStorage.getItem(PRESUPUESTO_VIEW_KEY) === 'grid' ? 'grid' : 'list';
}
function setPresupuestoViewMode(mode) {
  localStorage.setItem(PRESUPUESTO_VIEW_KEY, mode);
  const cont = $('#resumenClienteProyectos');
  if (cont) cont.classList.toggle('view-grid', mode === 'grid');
  $$('.presupuesto-view-opt').forEach((btn) => btn.classList.toggle('active', btn.dataset.presupuestoView === mode));
}

$('#btnNotif').innerHTML = icon('bell', 18);
$('#btnLogout').innerHTML = icon('log-out', 18);

// ---------------------------------------------------------------------------
// Instalación PWA — Android/Chrome dispara 'beforeinstallprompt' (evento
// nativo, lo guardamos y lo disparamos al tocar el botón); iOS Safari no
// tiene ese evento, así que ahí solo mostramos instrucciones manuales.
// El aviso se oculta si la app ya corre instalada (standalone) o si el
// usuario ya lo cerró antes (localStorage).
// ---------------------------------------------------------------------------
const INSTALL_DISMISSED_KEY = 'cp_install_dismissed';
let deferredInstallPrompt = null;

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
}
// Opera GX es Chromium por debajo (mismo motor que Chrome/Edge, instalación
// de PWA soportada), pero el navigator.userAgent de Opera GX en la práctica
// NO trae un token "GX" distinguible del de Opera de escritorio normal —
// ambos comparten el mismo token "OPR/<version>". Por eso se detecta
// "cualquier Opera" (OPR) en vez de intentar aislar específicamente GX: el
// menú de instalación es el mismo en ambos, así que las instrucciones
// alternas de abajo aplican igual sin importar cuál de los dos sea.
function isOperaGX() {
  return /\bOPR\//i.test(navigator.userAgent);
}

function showInstallBanner(mode) {
  if (isStandalone() || localStorage.getItem(INSTALL_DISMISSED_KEY)) return;
  const banner = $('#installBanner');
  if (!banner) return;
  $('#installBannerText').textContent = mode === 'ios'
    ? 'Instala esta app: toca Compartir ⬆️ en Safari y elige "Agregar a pantalla de inicio".'
    : 'Instala Control Presupuestal en tu dispositivo para acceso rápido, sin navegador.';
  $('#btnInstallApp').style.display = mode === 'ios' ? 'none' : '';
  banner.classList.remove('hidden-initial');
  requestAnimationFrame(() => banner.classList.add('show'));
}

window.addEventListener('beforeinstallprompt', (ev) => {
  ev.preventDefault();
  deferredInstallPrompt = ev;
  showInstallBanner('android');
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  $('#installBanner').classList.remove('show');
});

$('#btnInstallApp').addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  $('#installBanner').classList.remove('show');
});

$('#btnDismissInstall').addEventListener('click', () => {
  localStorage.setItem(INSTALL_DISMISSED_KEY, '1');
  $('#installBanner').classList.remove('show');
});

if (isIOS() && !isStandalone()) showInstallBanner('ios');

// ---------------------------------------------------------------------------
// 2FA opcional (julio 2026, ver CLAUDE.md) — banner de recordatorio a nivel de
// shell (vive fuera de #view, igual que #installBanner), visible en TODAS las
// pantallas principales mientras dure la sesión. Solo se marca como "visto"
// en el backend cuando el usuario cierra explícitamente con la X — no al
// mostrarse, no al navegar, no al reingresar (la condición de los 3 días es
// la única que decide si vuelve a aparecer en una sesión futura).
// ---------------------------------------------------------------------------
function updateTotpReminderBanner() {
  const banner = $('#totpReminderBanner');
  banner.classList.remove('hidden-initial');
  requestAnimationFrame(() => banner.classList.toggle('show', state.needsTotpReminder));
}
$('#btnTotpReminderConfigurar').addEventListener('click', startTotpEnrollment);
$('#btnTotpReminderClose').addEventListener('click', () => {
  state.needsTotpReminder = false;
  updateTotpReminderBanner();
  api('/usuarios/totp-reminder-dismissed', { method: 'POST' }).catch(() => {});
});

function installApp() {
  if (isStandalone()) { toast('La app ya está instalada en este dispositivo', 'success'); return; }
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.then(() => { deferredInstallPrompt = null; });
    return;
  }
  const isAndroid = /android/i.test(navigator.userAgent);
  let steps;
  if (isIOS()) {
    steps = [
      'Abre esta página en <strong>Safari</strong> (no Chrome ni otro navegador)',
      'Toca el botón <strong>Compartir ⬆️</strong> en la barra inferior',
      'Desplázate y toca <strong>"Agregar a pantalla de inicio"</strong>',
      'Toca <strong>"Agregar"</strong> en la esquina superior derecha',
    ];
  } else if (isAndroid) {
    steps = [
      'Abre esta página en <strong>Chrome</strong>',
      'Toca el menú <strong>⋮</strong> (tres puntos) arriba a la derecha',
      'Toca <strong>"Instalar app"</strong> o <strong>"Agregar a pantalla de inicio"</strong>',
      'Confirma tocando <strong>"Instalar"</strong>',
    ];
  } else if (isOperaGX()) {
    steps = [
      'Abre esta página en <strong>Chrome</strong>, <strong>Edge</strong> u <strong>Opera GX</strong>',
      'Busca el ícono <strong>⊕</strong> en la barra de direcciones, o abre el menú <strong>Opera</strong> (esquina superior izquierda) → busca <strong>"Instalar Control Presupuestal"</strong>',
      'Haz clic en <strong>"Instalar Control Presupuestal"</strong> o <strong>"Guardar e instalar"</strong>',
      'Confirma haciendo clic en <strong>"Instalar"</strong>',
    ];
  } else {
    steps = [
      'Abre esta página en <strong>Chrome</strong> o <strong>Edge</strong>',
      'Busca el ícono <strong>⊕</strong> al final de la barra de direcciones — o abre el menú <strong>⋮</strong>',
      'Haz clic en <strong>"Instalar Control Presupuestal"</strong> o <strong>"Guardar e instalar"</strong>',
      'Confirma haciendo clic en <strong>"Instalar"</strong>',
    ];
  }
  const stepsHtml = steps.map((s, i) => `<li class="install-step"><span class="install-step-num">${i + 1}</span>${s}</li>`).join('');
  openModal(`
    <div class="install-header-row">
      <h3 class="modal-title">📲 Instalar app</h3>
      <button class="icon-btn modal-close-btn" id="btnCloseInstallGuide">✕</button>
    </div>
    <p class="install-intro">Sigue estos pasos para instalar la app en tu dispositivo:</p>
    <ol class="install-steps-list">${stepsHtml}</ol>
  `);
  $('#btnCloseInstallGuide').addEventListener('click', closeModal);
}

const fmtMoney = (n) => (n == null ? '—' : Number(n).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 }));
const fmtNum = (n, d = 2) => (n == null ? '—' : Number(n).toLocaleString('es-MX', { maximumFractionDigits: d }));
const fmtPct = (n) => (n == null ? '—' : `${Number(n).toLocaleString('es-MX', { maximumFractionDigits: 1 })}%`);
const fmtDate = (s) => {
  if (!s) return '—';
  const d = new Date(`${s}T00:00:00`);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
};
const fmtDateShort = (s) => {
  if (!s) return '—';
  const d = new Date(`${String(s).slice(0,10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return String(s).slice(0,10);
  return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Umbral simple para el aviso de "contrato por vencer" — ajustable después.
const FIN_OBRA_AVISO_DIAS = 30;
// Devuelve null si fin_obra no aplica todavía (falta más de FIN_OBRA_AVISO_DIAS),
// o { vencido, dias } si ya venció (dias negativo) o está por vencer (dias >= 0).
function finObraEstado(fin_obra) {
  if (!fin_obra) return null;
  const fin = new Date(`${String(fin_obra).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(fin.getTime())) return null;
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const dias = Math.round((fin - hoy) / 86400000);
  if (dias > FIN_OBRA_AVISO_DIAS) return null;
  return { vencido: dias < 0, dias };
}

// ---------------------------------------------------------------------------
// API helper + JWT refresh automático
// ---------------------------------------------------------------------------

// Intenta renovar el access token usando el refresh token (cookie httpOnly).
// Deduplica llamadas simultáneas: si ya hay un refresh en curso, espera el mismo.
let _refreshPromise = null;
async function tryRefreshToken() {
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = (async () => {
    try {
      const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) return false;
      const data = await res.json();
      if (!data.token) return false;
      state.token = data.token;
      localStorage.setItem(TOKEN_KEY, data.token);
      return true;
    } catch {
      return false;
    } finally {
      _refreshPromise = null;
    }
  })();
  return _refreshPromise;
}

async function api(path, opts = {}) {
  const doFetch = (tkn) => {
    const headers = opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {};
    if (tkn) headers.Authorization = `Bearer ${tkn}`;
    return fetch(`/api${path}`, {
      ...opts,
      headers,
      body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
    });
  };
  let res = await doFetch(state.token);
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (res.status === 401 && path !== '/auth/login' && path !== '/auth/refresh') {
    const refreshed = await tryRefreshToken();
    if (refreshed) {
      res = await doFetch(state.token);
      data = null;
      try { data = await res.json(); } catch { /* no body */ }
    }
    if (res.status === 401) {
      handleSessionExpired();
      throw new Error((data && data.error) || 'Sesión expirada');
    }
  }
  if (!res.ok) throw new Error((data && data.error) || `Error ${res.status}`);
  return data;
}

// Descarga un .xlsx generado por el servidor (reusado por todos los botones
// "Exportar a Excel" — el archivo y su nombre los arma el backend, aquí solo
// se dispara la descarga con el token de sesión en el header).
async function downloadExport(path) {
  const doFetch = (tkn) => fetch(`/api${path}`, { headers: tkn ? { Authorization: `Bearer ${tkn}` } : {} });
  let res = await doFetch(state.token);
  if (res.status === 401) {
    const refreshed = await tryRefreshToken();
    if (!refreshed) { handleSessionExpired(); throw new Error('Sesión expirada'); }
    res = await doFetch(state.token);
    if (res.status === 401) { handleSessionExpired(); throw new Error('Sesión expirada'); }
  }
  if (!res.ok) {
    let msg = `Error ${res.status}`;
    try { const data = await res.json(); msg = (data && data.error) || msg; } catch { /* no body */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="?([^";]+)"?/);
  const filename = match ? match[1] : 'export.xlsx';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Conecta un botón "Exportar a Excel": deshabilita mientras descarga y
// restaura su texto al terminar (o si falla). Un solo lugar para las 7
// pantallas con exportación, en vez de repetir el mismo try/finally.
function wireExportButton(selector, path) {
  const btn = $(selector);
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Exportando…';
    try {
      await downloadExport(path);
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });
}

function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast'; }, 2500);
}

let _proxTid = null;
function showProximamenteTooltip(label) {
  clearTimeout(_proxTid);
  document.getElementById('proximamenteTooltip')?.remove();

  const el = document.createElement('div');
  el.id = 'proximamenteTooltip';
  el.textContent = `${label} estará disponible próximamente`;
  document.body.appendChild(el);

  _proxTid = setTimeout(() => {
    el.classList.add('tooltip-exit');
    const onEnd = () => {
      el.removeEventListener('transitionend', onEnd);
      el.remove();
    };
    el.addEventListener('transitionend', onEnd);
    setTimeout(() => { if (el.parentNode) el.remove(); }, 300);
  }, 2500);
}

// ---------------------------------------------------------------------------
// Autenticación: pantalla de login que filtra el acceso por puesto. El token
// se guarda en localStorage; cada puesto ve solo sus pestañas permitidas.
// ---------------------------------------------------------------------------
// G10: crossfade corto (solo opacity, ver styles.css) entre las 4 pantallas
// de nivel superior — mismo patrón que openUserPopover()/closeUserPopover():
// ocultar quita 'show' (dispara la transición a opacity:0) y recién después
// de que termine pone display:none; mostrar quita hidden-initial, fija el
// display, y en el siguiente frame agrega 'show' (dispara la transición a
// opacity:1). 180 debe calzar con la duración de styles.css.
//
// z-index temporal durante la transición: .login-screen/.gallery-screen
// tienen z-index:100 y .welcome-screen z-index:150 en su CSS (para tapar
// el resto de la app cuando están activas), pero #app no tiene ninguno
// (no se le puede subir uno alto de forma permanente — #modal/#modalOverlay
// viven FUERA de #app en el HTML con z-index:60/40, y quedarían tapados
// por #app en cualquier momento normal, rompiendo todos los modales). En
// vez de eso, la pantalla que se está YENDO se manda momentáneamente al
// fondo (z-index:1) apenas empieza su fade-out, y la que ENTRA recupera su
// z-index normal de la clase — así la entrante siempre queda visible
// encima de la saliente durante el cruce, sin tocar el z-index real de
// #app ni su relación con los modales.
const TOP_SCREEN_FADE_MS = 180;
function ocultarPantalla(id) {
  const el = $('#' + id);
  if (!el) return;
  el.classList.remove('show');
  el.style.zIndex = '1';
  setTimeout(() => { if (!el.classList.contains('show')) el.style.display = 'none'; }, TOP_SCREEN_FADE_MS);
}
function mostrarPantalla(id, display) {
  const el = $('#' + id);
  if (!el) return;
  el.classList.remove('hidden-initial'); // ver .hidden-initial en styles.css
  el.style.zIndex = ''; // restaura el z-index de su clase (ver comentario arriba)
  el.style.display = display;
  requestAnimationFrame(() => el.classList.add('show'));
  trackEvent('screen_view', { screen: id });
}

function showLoginScreen() {
  ocultarPantalla('app');
  ocultarPantalla('clientGalleryScreen');
  ocultarPantalla('welcomeScreen');
  mostrarPantalla('loginScreen', 'flex');
  $('#loginUsuario').focus();
}
function showApp() {
  ocultarPantalla('loginScreen');
  ocultarPantalla('clientGalleryScreen');
  ocultarPantalla('welcomeScreen');
  mostrarPantalla('app', '');
  requestAnimationFrame(initTopbarObserver);
  requestAnimationFrame(initDebugBadge);
}
function showClientGallery() {
  ocultarPantalla('loginScreen');
  ocultarPantalla('app');
  ocultarPantalla('welcomeScreen');
  mostrarPantalla('clientGalleryScreen', 'flex');
}
function showWelcomeScreen() {
  ocultarPantalla('loginScreen');
  ocultarPantalla('clientGalleryScreen');
  ocultarPantalla('app');
  mostrarPantalla('welcomeScreen', 'flex');
}

// Devuelve el puesto efectivo: el simulado (si está activo) o el real del usuario.
// Solo desarrollador puede activar la simulación; el backend sigue usando el puesto real del JWT.
function effectivePuesto() { return state.simulatedPuesto ?? state.user?.puesto; }

function isAdmin() { return !!state.user && ['admin', 'desarrollador'].includes(effectivePuesto()); }
function isDesarrollador() { return !!state.user && state.user.puesto === 'desarrollador'; } // siempre puesto real
// Puesto REAL (no effectivePuesto): para acciones que ni siquiera la vista
// simulada debe ocultar/mostrar de forma distinta al rol verdadero del usuario.
function isAdminRealSinSimular() { return !!state.user && ['admin', 'desarrollador'].includes(state.user.puesto); }
function canManageDestajo() { return !!state.user && (isAdmin() || ['residente'].includes(effectivePuesto())); }
function puedeGenerarOC() { return !!state.user && (isAdmin() || ['compras'].includes(effectivePuesto())); }
function puedeAutorizarRequisicion() { return !!state.user && (isAdmin() || ['logistica'].includes(effectivePuesto())); }
function puedeVerPrecios() { return !!state.user && effectivePuesto() !== 'cabo'; }
function puedeCrearRequisicion() { return !!state.user && (isAdmin() || ['residente', 'cabo', 'compras'].includes(effectivePuesto())); }
function puedeVerImportesRequisicion() { return !!state.user && !['residente', 'cabo'].includes(effectivePuesto()); }
function puedeRegistrarPago() { return !!state.user && (isAdmin() || ['tesoreria'].includes(effectivePuesto())); }
function puedeVerImportesAvance() { return !!state.user && effectivePuesto() !== 'cabo'; }
function puedeEditarAvance() { return !!state.user && (isAdmin() || ['residente', 'cabo'].includes(effectivePuesto())); }
function puedeGestionarUsuarios() { return !!state.user && ['admin', 'desarrollador', 'administracion'].includes(effectivePuesto()); }
function puedeGestionarTrabajadores() { return isAdmin(); }
function puedeVerNominas() { return !!state.user && (isAdmin() || ['residente'].includes(effectivePuesto())); }
function puedeCapturarAsistencia() { return !!state.user && (isAdmin() || ['residente'].includes(effectivePuesto())); }
function puedeAprobarNomina() { return isAdmin(); }
function puedeVerEstimaciones() { return !!state.user && (isAdmin() || ['residente'].includes(effectivePuesto())); }
function puedeCapturarEstimacion() { return !!state.user && (isAdmin() || ['residente'].includes(effectivePuesto())); }
function puedeAprobarEstimacion() { return isAdmin(); }

function applySession(user, tabs, needsTotpReminder = false) {
  state.user = user;
  state.allowedTabs = tabs;
  state._realAllowedTabs = tabs;
  state.needsTotpReminder = needsTotpReminder;
  syncErrorTags();
  updateTotpReminderBanner();
  state.simulatedPuesto = null; // resetea simulación al re-autenticar
  const isAdminUser = user.puesto === 'admin' || user.puesto === 'desarrollador';
  $('#btnUpload').style.display = isAdminUser ? '' : 'none';
  const adminAct = $('#drawerAdminActions');
  if (adminAct) {
    if (isAdminUser) adminAct.classList.remove('hidden-initial'); // ver .hidden-initial en styles.css
    adminAct.style.display = isAdminUser ? '' : 'none';
  }
  state.view = tabs.length <= 1 ? (tabs[0] || 'inicio') : 'inicio';
  state.section = VIEW_TO_SECTION[state.view] || null;
  startNotifPolling();
  renderSidebar();
  renderMobileNav();
}

// ---------------------------------------------------------------------------
// Simulación de vista por rol (solo desarrollador) — puramente visual en
// el frontend. El backend sigue usando el JWT real; no es una barrera de
// seguridad, es una herramienta de revisión de UX para desarrolladores.
// ---------------------------------------------------------------------------
function updateSimBanner() {
  const banner = $('#simBanner');
  const text = $('#simBannerText');
  if (!banner) return;
  if (state.simulatedPuesto) {
    text.textContent = `Vista simulada: ${PUESTO_LABELS[state.simulatedPuesto] || state.simulatedPuesto}`;
    banner.classList.remove('hidden-initial'); // ver .hidden-initial en styles.css
    banner.style.display = '';
  } else {
    banner.style.display = 'none';
  }
}

function startSimulation(puesto) {
  if (!isDesarrollador()) return; // solo el rol real puede iniciar
  state.simulatedPuesto = puesto;
  state.allowedTabs = ROLE_TABS[puesto] || [];
  sessionStorage.setItem('sim_puesto', puesto);
  const isAdminSim = ['admin', 'desarrollador'].includes(puesto);
  $('#btnUpload').style.display = isAdminSim ? '' : 'none';
  if (!state.allowedTabs.includes(state.view)) {
    state.view = state.allowedTabs[0] || 'inicio';
    state.section = VIEW_TO_SECTION[state.view] || null;
  }
  updateSimBanner();
  renderSidebar();
  renderMobileNav();
  renderView();
}

function stopSimulation() {
  state.simulatedPuesto = null;
  state.allowedTabs = state._realAllowedTabs || ROLE_TABS[state.user?.puesto] || [];
  sessionStorage.removeItem('sim_puesto');
  const isAdminReal = ['admin', 'desarrollador'].includes(state.user?.puesto);
  $('#btnUpload').style.display = isAdminReal ? '' : 'none';
  if (!state.allowedTabs.includes(state.view)) {
    state.view = state.allowedTabs[0] || 'inicio';
    state.section = VIEW_TO_SECTION[state.view] || null;
  }
  updateSimBanner();
  renderSidebar();
  renderMobileNav();
  renderView();
}

// ---------------------------------------------------------------------------
// Notificaciones in-app — campana en el topbar. Se refresca por polling
// (no hay WebSockets/SSE porque el backend corre en Vercel serverless, sin
// proceso persistente). Infraestructura base: fases futuras (impuestos,
// vencimiento de contrato, requisición/OC publicada) solo necesitan llamar a
// crearNotificacion()/notificarAdmins() en el backend — esto ya las muestra.
// ---------------------------------------------------------------------------
const NOTIF_POLL_MS = 60000;

function startNotifPolling() {
  stopNotifPolling();
  refreshNotificaciones();
  state.notifTimer = setInterval(refreshNotificaciones, NOTIF_POLL_MS);
}

function stopNotifPolling() {
  if (state.notifTimer) { clearInterval(state.notifTimer); state.notifTimer = null; }
  state.notificaciones = [];
  state.notifNoLeidas = 0;
}

async function refreshNotificaciones() {
  try {
    const data = await api('/notificaciones');
    state.notificaciones = data.notificaciones;
    state.notifNoLeidas = data.no_leidas;
    renderNotifBadge();
    if ($('#notifDropdown').classList.contains('show')) renderNotifList();
  } catch (err) {
    // Silencioso: un fallo de polling cada 60s no debe interrumpir con un toast.
  }
}

function renderNotifBadge() {
  const count = state.notifNoLeidas;
  const text = count > 9 ? '9+' : String(count);
  for (const id of ['#notifBadge', '#notifBadgeMobile']) {
    const el = $(id);
    if (!el) continue;
    if (count > 0) el.classList.remove('hidden-initial'); // ver .hidden-initial en styles.css
    el.style.display = count > 0 ? '' : 'none';
    if (count > 0) el.textContent = text;
  }
}

function timeAgo(creadoEn) {
  // creado_en llega como 'YYYY-MM-DD HH:MM:SS' en UTC (ver setTypeParser en
  // server/db.js) — se marca explícitamente como 'Z' para no interpretarla
  // en la zona horaria local del navegador.
  const then = new Date(`${creadoEn.replace(' ', 'T')}Z`).getTime();
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 60) return 'hace un momento';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `hace ${diffMin} minuto${diffMin === 1 ? '' : 's'}`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `hace ${diffHr} hora${diffHr === 1 ? '' : 's'}`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `hace ${diffDay} día${diffDay === 1 ? '' : 's'}`;
  const diffMonth = Math.floor(diffDay / 30);
  return `hace ${diffMonth} mes${diffMonth === 1 ? '' : 'es'}`;
}

// Switch por tipo de notificación → navega al recurso correspondiente.
// Fase 3 (impuestos) agrega el primer caso; fases futuras (requisición/OC
// publicada, etc.) suman más ramas aquí — ver TODO original en Fase 1.
const TAB_POR_TIPO_NOTIF = {
  recordatorio_impuestos: 'impuestos',
  contrato_por_vencer: 'contrato',
  requisicion_pendiente: 'requisiciones',
  oc_pendiente: 'ordenes',
  avance_pendiente: 'avance',
  destajo_pendiente: 'destajo',
};

// ---------------------------------------------------------------------------
// Secciones de navegación (pantalla de inicio tipo galería) — agrupan las
// pestañas existentes por área de negocio. def.tabs con módulos reales;
// def.proximamente son nombres de módulos pedidos por el cliente que aún no
// existen (solo placeholder visual, sin backend). Una sección con
// def.tabs.length === 0 es 100% futura (hoy solo Maquinaria).
// ---------------------------------------------------------------------------
const SECTION_DEFS = {
  obra:          { label: 'Obra',           icon: 'obra',           emoji: '🏗️',  tabs: ['programa', 'avance', 'destajo', 'estimaciones'],     proximamente: [] },
  compras:       { label: 'Compras',        icon: 'compras',        emoji: '🛒',   tabs: ['requisiciones', 'insumos', 'proveedores', 'ordenes', 'cotizador'], proximamente: ['Subcontratos'] },
  tesoreria:     { label: 'Tesorería',      icon: 'tesoreria',      emoji: '💰',   tabs: ['finanzas', 'estadoResultados', 'estadoResultadosGlobal', 'impuestos'], proximamente: [] },
  administracion:{ label: 'Administración', icon: 'administracion', emoji: '📂',  tabs: ['mapeo', 'contrato', 'trabajadores', 'trabajadores_global', 'nominas', 'nominas_global', 'usuarios'], proximamente: ['Almacenes'] },
  maquinaria:    { label: 'Maquinaria',     icon: 'maquinaria',     emoji: '🚜',   tabs: ['maquinaria'],                                        proximamente: [] },
};

const TAB_ICONS = {
  resumen: '📊', contrato: '📄', impuestos: '🧾', insumos: '📦', requisiciones: '🧾',
  proveedores: '🏭', ordenes: '🛒', programa: '🗓️', avance: '📈', destajo: '👷',
  finanzas: '💰', mapeo: '🔗', usuarios: '👤', trabajadores: '👷', nominas: '💵', estimaciones: '🧮',
  maquinaria: '🚜', nominas_global: '💵', trabajadores_global: '👷', cotizador: '🔍',
  estadoResultados: '📈', estadoResultadosGlobal: '📈',
};
const TAB_LABELS = {
  resumen: 'Resumen', contrato: 'Contrato', impuestos: 'Impuestos', insumos: 'Insumos', requisiciones: 'Requisiciones',
  proveedores: 'Proveedores', ordenes: 'Órdenes de Compra', programa: 'Programa', avance: 'Avance', destajo: 'Destajo',
  finanzas: 'Finanzas', mapeo: 'Mapeo', usuarios: 'Usuarios', trabajadores: 'Trabajadores', nominas: 'Nóminas', estimaciones: 'Estimaciones',
  maquinaria: 'Maquinaria', nominas_global: 'Nómina (todas las obras)', trabajadores_global: 'Trabajadores (todas las obras)',
  cotizador: 'Cotizador', estadoResultados: 'Estado de Resultados', estadoResultadosGlobal: 'Estado de Resultados (todas las obras)',
};

const VIEW_TO_SECTION = {};
Object.entries(SECTION_DEFS).forEach(([sectionId, def]) => {
  def.tabs.forEach((t) => { VIEW_TO_SECTION[t] = sectionId; });
});

// Secciones que muestran primero una galería de subsecciones (mismo patrón
// visual que .section-grid) en vez de saltar directo a la primera pestaña
// permitida — prompt-rediseno-navegacion-subsecciones.md, Fix B. Piloto
// original solo en 'obra'; replicado a las otras 4 (prompt-replicar-galeria-
// 4-secciones.md) — goToSection(), renderView(), renderTabsBar() y syncFab()
// ya generalizaban sobre este set, así que extenderlo es el único cambio de
// lógica que hace falta. 'maquinaria' tiene una sola subsección hoy
// (tabs: ['maquinaria']) — el guard de goToSection() (tabsPermitidos.length
// > 1) ya evita mostrarle una galería de 1 tile, se incluye igual por
// consistencia/si gana más subsecciones después (decisión explícita).
const SECTIONS_WITH_GALLERY = new Set(['obra', 'compras', 'tesoreria', 'administracion', 'maquinaria']);
SECTIONS_WITH_GALLERY.forEach((sectionId) => { VIEW_TO_SECTION[`${sectionId}_gallery`] = sectionId; });

// Historial de navegación (botón atrás del navegador / gesto equivalente en
// móvil) — registra cada cambio de pestaña dentro del presupuesto abierto
// para que "atrás" regrese a la pestaña anterior en vez de salir de la app
// o recargar sin estado. Nunca se toca la URL (siempre location.href): solo
// viaja el estado de history, así no hay riesgo de romper enlaces/bookmarks.
// Alcance a propósito: solo pestañas dentro del MISMO presupuesto — cambiar
// de presupuesto reinicia el historial (selectProject usa replaceState),
// y el estado de modales/formularios a medio llenar se descarta al volver.
function pushTabHistory() {
  history.pushState({ cpNav: true, projectId: state.projectId, clienteId: state.clienteId, view: state.view, section: state.section }, '', location.href);
}

function replaceTabHistory() {
  history.replaceState({ cpNav: true, projectId: state.projectId, clienteId: state.clienteId, view: state.view, section: state.section }, '', location.href);
}

window.addEventListener('popstate', (ev) => {
  const s = ev.state;
  // Entrada ajena a nuestro historial: si el usuario está dentro de la app,
  // back regresa a la galería de clientes; si no, solo corrige el state.
  if (!s || !s.cpNav) {
    if ($('#app').style.display === '') {
      goToClientGallery();
    } else {
      replaceTabHistory();
    }
    return;
  }
  // Retroceso al panel de resumen de cliente (clienteId guardado, sin proyecto)
  if (!s.projectId && typeof s.clienteId === 'number') {
    state.projectId = null;
    state.clienteId = s.clienteId;
    state.view = 'inicio';
    state.section = null;
    const cliente = state.clientes?.find((c) => c.id === s.clienteId);
    $('#projectName').textContent = cliente ? `${cliente.nombre.toUpperCase()} — elige un presupuesto` : '';
    renderTabsBar();
    renderSidebar();
    renderMobileNav();
    renderView();
    return;
  }
  if (s.projectId !== state.projectId) {
    goToClientGallery();
    return;
  }
  state.view = s.view;
  state.section = s.section;
  renderTabsBar();
  renderSidebar();
  renderMobileNav();
  renderView();
});

// Navegación central: toda la app debe pasar por aquí para cambiar de vista
// (en vez de simular clicks sobre una barra de tabs estática) — así la
// sección activa y la barra de sub-navegación quedan siempre consistentes.
function switchToView(viewId) {
  state.view = viewId;
  state.section = VIEW_TO_SECTION[viewId] || null;
  const ms = document.querySelector('.main-scroll') || document.querySelector('.main-area');
  if (ms) ms.scrollTop = 0;
  renderTabsBar();
  renderSidebar();
  renderMobileNav();
  renderView();
  pushTabHistory();
}

function goToSection(sectionId) {
  const def = SECTION_DEFS[sectionId];
  if (!def) return;
  if (def.tabs.length === 0) { showProximamenteTooltip(def.label); return; }
  const tabsPermitidos = def.tabs.filter((t) => state.allowedTabs.includes(t));
  if (!tabsPermitidos.length) { toast('No tienes módulos disponibles en esta sección', ''); return; }
  // Con más de una subsección permitida, mostrar primero la galería para
  // elegir — con solo una, saltar directo a ella (una galería de 1 tile no
  // aporta nada, y así el filtro por permisos ya rige si aparece o no).
  if (SECTIONS_WITH_GALLERY.has(sectionId) && tabsPermitidos.length > 1) {
    switchToView(`${sectionId}_gallery`);
    return;
  }
  switchToView(tabsPermitidos[0]);
}

// Reconstruye la barra bajo el topbar: oculta en 'inicio' (la navegación ahí
// es por las tarjetas de sección dentro de la vista), botón "← Secciones"
// + tabs reales de la sección cuando hay una activa, o solo "← Inicio"
// para los accesos rápidos sin sección (Contrato/Impuestos). También oculta
// en las galerías de subsecciones (*_gallery) — ahí todavía no hay una
// subsección activa que resaltar, la elección misma es la vista de galería.
function renderTabsBar() {
  const nav = $('#tabs');
  if (!nav) return;
  if (!state.projectId || state.view === 'inicio' || state.view.endsWith('_gallery')) { nav.innerHTML = ''; nav.style.display = 'none'; return; }
  nav.classList.remove('hidden-initial'); // ver .hidden-initial en styles.css
  nav.style.display = '';
  let html = '';
  if (state.section) {
    const def = SECTION_DEFS[state.section];
    html += `<button class="tab tab-back" data-goto="inicio">←</button>`;
    def.tabs.filter((t) => state.allowedTabs.includes(t)).forEach((t) => {
      html += `<button class="tab ${state.view === t ? 'active' : ''}" data-goto="${t}"><span class="tab-icon">${TAB_ICONS[t]}</span><span class="tab-label">${TAB_LABELS[t]}</span></button>`;
    });
    def.proximamente.forEach((nombre) => {
      html += `<button class="tab tab-soon" data-soon="${esc(nombre)}"><span class="tab-icon">🔒</span><span class="tab-label">${esc(nombre)}</span></button>`;
    });
  } else {
    html += `<button class="tab tab-back" data-goto="inicio">←</button>`;
  }
  nav.innerHTML = html;
  $$('.tab[data-goto]', nav).forEach((btn) => btn.addEventListener('click', () => switchToView(btn.dataset.goto)));
  $$('.tab[data-soon]', nav).forEach((btn) => btn.addEventListener('click', () => showProximamenteTooltip(btn.dataset.soon)));
  requestAnimationFrame(() => {
    const h = nav.getBoundingClientRect().height;
    if (h > 0) document.documentElement.style.setProperty('--tabs-h', `${h}px`);
  });
}

// ---------------------------------------------------------------------------
// Sidebar colapsable — funciones de renderizado y control
// ---------------------------------------------------------------------------
const SIDEBAR_COLLAPSED_KEY = 'cp_sidebar_collapsed';

function isSidebarCollapsed() { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'; }

function applySidebarCollapse() {
  const collapsed = isSidebarCollapsed();
  const sb = $('#sidebar'); if (!sb) return;
  sb.classList.toggle('collapsed', collapsed);
}

function toggleSidebarCollapse() {
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, isSidebarCollapsed() ? '0' : '1');
  applySidebarCollapse();
}

function openSidebar() {
  $('#sidebar').classList.add('mobile-open');
  $('#sidebarOverlay').classList.add('show');
}

function closeSidebar() {
  $('#sidebar').classList.remove('mobile-open');
  $('#sidebarOverlay').classList.remove('show');
}

// Drawer de ajustes de la galería de clientes (prompt 2,
// prompts-cotizador-sidebar-permisos-estimaciones.md) — el #sidebar real
// vive dentro de #app, que queda display:none en la galería, así que no es
// alcanzable desde ahí. Este drawer es un componente propio y más simple
// (solo tema/accesibilidad/cuenta/sesión, nada que dependa de una obra
// seleccionada), pero reutiliza las funciones existentes de tema y
// accesibilidad en vez de reimplementarlas.
function openGalleryDrawer() {
  $('#galleryDrawer').classList.add('show');
  $('#galleryDrawerOverlay').classList.add('show');
  applyTheme(getTheme());
  const rm = $('#chkReduceMotionGallery'); if (rm) rm.checked = getReduceMotion();
  const hc = $('#chkHighContrastGallery'); if (hc) hc.checked = getHighContrast();
}

function closeGalleryDrawer() {
  $('#galleryDrawer').classList.remove('show');
  $('#galleryDrawerOverlay').classList.remove('show');
}

// Accesos globales de administración del drawer de galería (Usuarios,
// Trabajadores/Nóminas todas las obras, Permisos) — visibilidad calculada
// con el mismo criterio (state.allowedTabs / isAdmin()) que ya protege esas
// vistas dentro de #app, para que un link nunca aparezca si el usuario no
// tendría acceso real al hacer click. Llamado desde renderSidebar(), el
// único choke point de re-render cada vez que allowedTabs puede cambiar
// (login, simulación de rol, logout).
function updateGalleryDrawerGlobalLinks() {
  const puedeVer = (tab) => !!state.user && state.allowedTabs.includes(tab);
  const links = [
    ['btnGalleryGoUsuarios', puedeVer('usuarios')],
    ['btnGalleryGoTrabajadoresGlobal', puedeVer('trabajadores_global')],
    ['btnGalleryGoNominasGlobal', puedeVer('nominas_global')],
    // "Permisos" es la subvista "Permisos de Acceso" dentro de Usuarios
    // (ver renderUsuarios/renderSubNav) — mismo gate ahí: isAdmin().
    ['btnGalleryGoPermisos', puedeVer('usuarios') && isAdmin()],
  ];
  let anyVisible = false;
  links.forEach(([id, visible]) => {
    const btn = $('#' + id);
    if (btn) btn.classList.toggle('hidden-initial', !visible);
    if (visible) anyVisible = true;
  });
  const divider = $('#galleryDrawerAdminDivider');
  const label = $('#galleryDrawerAdminLabel');
  if (divider) divider.classList.toggle('hidden-initial', !anyVisible);
  if (label) label.classList.toggle('hidden-initial', !anyVisible);
}

// Navega a una vista global de administración (sin obra seleccionada) desde
// el drawer de la galería — mismo patrón que selectCliente() para entrar a
// #app sin projectId, seguido de switchToView() para llegar directo a la
// vista pedida en vez de quedarse en 'inicio'.
function goToGlobalAdminView(viewId) {
  closeGalleryDrawer();
  state.clienteId = null;
  state.projectId = null;
  showApp();
  $('#projectName').textContent = '';
  switchToView(viewId);
}

function renderSidebar() {
  updateGalleryDrawerGlobalLinks();
  const nav = $('#sidebarNav');
  if (!nav) return;

  // Actualizar info de perfil (siempre, incluso si aún no hay proyecto)
  if (state.user) {
    const initials = state.user.nombre.split(' ').map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
    const av = $('#sidebarAvatar');      if (av) av.textContent = initials;
    const nm = $('#sidebarProfileName'); if (nm) nm.textContent = state.user.nombre;
    const ep = effectivePuesto();
    const rl = $('#sidebarProfileRole'); if (rl) rl.textContent = PUESTO_LABELS[ep] || ep;
    const pn = $('#popoverName');        if (pn) pn.textContent = state.user.nombre;
    const pr = $('#popoverRole');        if (pr) pr.textContent = PUESTO_LABELS[ep] || ep;
  }
  // Ícono del proyecto en sidebar
  const pi = $('#sidebarProjectIcon'); if (pi) pi.textContent = '🏗️';
  const pc = $('#sidebarProjectChevron'); if (pc) pc.innerHTML = icon('chevron-down', 13);
  const pch = $('#sidebarProfileChevron'); if (pch) pch.innerHTML = icon('chevron-down', 13);

  if (!state.user) { nav.innerHTML = ''; return; }

  // Actualizar ícono del botón "Volver a clientes" (estático en index.html)
  const vcIcon = $('#sbarVolverClientes .sbar-icon');
  if (vcIcon) vcIcon.innerHTML = icon('chevron-left', 16);
  // Mismo botón, en el panel de "Presupuestos cargados" (drawer)
  const dvcIcon = $('#drawerVolverClientes .sbar-icon');
  if (dvcIcon) dvcIcon.innerHTML = icon('chevron-left', 16);

  let html = '';

  // Mostrar exactamente los tabs del rol activo (real o simulado).
  // En simulación, state.allowedTabs ya contiene solo los del rol simulado.
  const renderableTabs = state.allowedTabs;

  // Resumen — ítem suelto
  if (renderableTabs.includes('resumen')) {
    const active = state.view === 'resumen' ? 'active' : '';
    html += `<button class="sbar-item ${active}" data-sbar-goto="resumen" title="Resumen">
      <span class="sbar-icon">${TAB_ICONS.resumen}</span>
      <span class="sbar-label">Resumen</span>
    </button>`;
  }

  // Grupos de sección
  Object.entries(SECTION_DEFS).forEach(([sectionId, def]) => {
    if (def.tabs.length === 0) {
      // Sección futura (Maquinaria)
      html += `<button class="sbar-item sbar-disabled" disabled title="${esc(def.label)} — Próximamente">
        <span class="sbar-icon">${def.emoji}</span>
        <span class="sbar-label">${esc(def.label)}</span>
        <span class="sbar-badge-soon">Pronto</span>
      </button>`;
      return;
    }
    const sectionRenderableTabs = def.tabs.filter((t) => renderableTabs.includes(t));
    if (!sectionRenderableTabs.length) return;

    const isActive = state.section === sectionId;
    html += `<div class="sbar-group ${isActive ? 'open' : ''}">
      <button class="sbar-group-header ${isActive ? 'active' : ''}" data-sbar-group="${sectionId}" title="${esc(def.label)}">
        <span class="sbar-icon">${def.emoji}</span>
        <span class="sbar-label">${esc(def.label)}</span>
        <span class="sbar-chevron">${icon('chevron-down', 13)}</span>
      </button>
      <div class="sbar-group-body"><div>`;
    sectionRenderableTabs.forEach((t) => {
      const a = state.view === t ? 'active' : '';
      html += `<button class="sbar-item sbar-subitem ${a}" data-sbar-goto="${t}" title="${esc(TAB_LABELS[t])}">
        <span class="sbar-icon">${TAB_ICONS[t] || ''}</span>
        <span class="sbar-label">${esc(TAB_LABELS[t])}</span>
      </button>`;
    });
    def.proximamente.forEach((nombre) => {
      html += `<span class="sbar-item sbar-subitem sbar-soon" title="${esc(nombre)} — Próximamente">
        <span class="sbar-icon">🔒</span>
        <span class="sbar-label">${esc(nombre)}</span>
      </span>`;
    });
    html += '</div></div></div>';
  });

  // Sugerencias y Desarrollador — al final de la lista
  html += `<div class="sbar-divider"></div>`;
  const activeSug = state.view === 'sugerencias' ? 'active' : '';
  html += `<button class="sbar-item ${activeSug}" id="sbarSugerencias" title="Sugerencias">
    <span class="sbar-icon">💡</span>
    <span class="sbar-label">Sugerencias</span>
  </button>`;
  if (isDesarrollador()) {
    // Panel dev: visible solo en vista normal (un Cabo real no lo vería)
    if (!state.simulatedPuesto) {
      const activeDev = state.view === 'developer' ? 'active' : '';
      html += `<button class="sbar-item ${activeDev}" id="sbarDevPanel" title="Panel de desarrollador">
        <span class="sbar-icon">🛠️</span>
        <span class="sbar-label">Desarrollador</span>
      </button>`;
    }
    // Selector de vista simulada — siempre visible para el desarrollador real
    const simOpts = Object.keys(ROLE_TABS)
      .filter((p) => p !== 'desarrollador')
      .map((p) => `<option value="${p}" ${state.simulatedPuesto === p ? 'selected' : ''}>${PUESTO_LABELS[p] || p}</option>`)
      .join('');
    html += `<div class="sbar-sim-selector">
      <label class="sbar-sim-label">Vista como:</label>
      <select id="simRoleSelect" class="sbar-sim-select">
        <option value="" ${!state.simulatedPuesto ? 'selected' : ''}>Desarrollador (normal)</option>
        ${simOpts}
      </select>
    </div>`;
  }

  nav.innerHTML = html;

  // Toggle de grupo
  $$('.sbar-group-header', nav).forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const group = btn.closest('.sbar-group');
      const sectionId = btn.dataset.sbarGroup;
      const isCollapsed = $('#sidebar').classList.contains('collapsed');
      const isMobile = window.innerWidth <= 860;

      // En sidebar colapsada (desktop icon-only): navegar directamente sin expandir
      if (isCollapsed) {
        const def = SECTION_DEFS[sectionId];
        const firstTab = def.tabs.find((t) => state.allowedTabs.includes(t));
        if (firstTab) switchToView(firstTab);
        return;
      }

      const wasClosed = !group.classList.contains('open');
      // Cerrar todos los grupos
      $$('.sbar-group', nav).forEach((g) => g.classList.remove('open'));
      $$('.sbar-group-header', nav).forEach((h) => h.classList.remove('active'));
      if (wasClosed) {
        group.classList.add('open');
        btn.classList.add('active');
        // En desktop: navegar al primer tab si el usuario no está ya en este grupo.
        // En móvil: solo expandir — el usuario elige el tab desde los sub-ítems.
        if (!isMobile && state.section !== sectionId) {
          const def = SECTION_DEFS[sectionId];
          const firstTab = def.tabs.find((t) => state.allowedTabs.includes(t));
          if (firstTab) switchToView(firstTab);
        }
      }
      // Si estaba abierto y se cerró: solo colapsar visualmente, sin navegar.
    });
  });

  // (el listener de "Volver a clientes" se registra una sola vez en la sección de init del sidebar)

  // Sugerencias
  const sugBtn = $('#sbarSugerencias', nav);
  if (sugBtn) sugBtn.addEventListener('click', () => { switchToView('sugerencias'); closeSidebar(); });

  // Panel de desarrollador (solo rol 'desarrollador')
  const devBtn = $('#sbarDevPanel', nav);
  if (devBtn) devBtn.addEventListener('click', () => { switchToView('developer'); closeSidebar(); });

  // Navegación directa a tabs
  $$('[data-sbar-goto]', nav).forEach((btn) => {
    btn.addEventListener('click', () => {
      switchToView(btn.dataset.sbarGoto);
      closeSidebar(); // cierra en móvil; no hace nada en desktop
    });
  });
}

// ---------------------------------------------------------------------------
// Mobile nav — actualiza estados activos
// ---------------------------------------------------------------------------
function renderMobileNav() {
  const iniBtn = $('#mobileNavInicio');
  if (iniBtn) iniBtn.classList.toggle('active', !state.projectId && !$('#app').style.display);
  const resBtn = $('#mobileNavResumen');
  if (resBtn) resBtn.classList.toggle('active', state.view === 'resumen');
}

// ---------------------------------------------------------------------------
// Popover de perfil (desktop)
// ---------------------------------------------------------------------------
function openUserPopover() {
  const pop = $('#userPopover'); if (!pop) return;
  pop.classList.remove('hidden-initial'); // ver .hidden-initial en styles.css
  pop.style.display = '';
  // Posicionar el popover encima del botón de perfil
  const btn = $('#btnUserProfile');
  if (btn) {
    const r = btn.getBoundingClientRect();
    pop.style.bottom = (window.innerHeight - r.top + 10) + 'px';
    pop.style.left = r.left + 'px';
    // Asegurarse que no quede fuera del viewport
    const popW = pop.offsetWidth || (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')) || 248);
    if (r.left + popW > window.innerWidth - 8) {
      pop.style.left = Math.max(8, window.innerWidth - popW - 8) + 'px';
    }
  }
  requestAnimationFrame(() => pop.classList.add('show'));
  // Marcar tema activo y sincronizar los toggles de Accesibilidad con su
  // estado guardado (los checkboxes son estáticos en el HTML, a diferencia
  // del modal móvil que los recrea cada vez que se abre).
  applyTheme(getTheme());
  const rmChk = $('#chkReduceMotionPopover'); if (rmChk) rmChk.checked = getReduceMotion();
  const hcChk = $('#chkHighContrastPopover'); if (hcChk) hcChk.checked = getHighContrast();
}

function closeUserPopover() {
  const pop = $('#userPopover'); if (!pop) return;
  pop.classList.remove('show');
  setTimeout(() => { if (!pop.classList.contains('show')) pop.style.display = 'none'; }, 160);
}

// ---------------------------------------------------------------------------
// Quick action menu (móvil)
// ---------------------------------------------------------------------------
function openQuickActionMenu() {
  const menu = $('#quickActionMenu'); if (!menu) return;
  const list = $('#quickActionList'); if (!list) return;

  const actions = [];
  // Requieren un presupuesto/obra ya seleccionado.
  if (state.projectId) {
    if (puedeCrearRequisicion() && state.allowedTabs.includes('requisiciones'))
      actions.push({ label: 'Nueva Requisición',    icon: 'requisiciones', goto: 'requisiciones' });
    if (puedeEditarAvance() && state.allowedTabs.includes('avance'))
      actions.push({ label: 'Registrar Avance',     icon: 'avance',        goto: 'avance' });
    if (puedeGenerarOC() && state.allowedTabs.includes('ordenes'))
      actions.push({ label: 'Nueva Orden de Compra', icon: 'ordenes',      goto: 'ordenes' });
  }
  // Mismos accesos que en el panel "Presupuestos cargados" (drawer) — mismo
  // handler, mismo permiso (isAdmin()), solo un atajo adicional. No requieren
  // presupuesto seleccionado (igual que en su ubicación original).
  if (isAdmin()) {
    actions.push({ label: 'Cargar presupuesto (.xlsx)', icon: '➕', fn: promptUpload });
    actions.push({ label: 'Cargar Contrato PDF',        icon: '📄', fn: promptUploadContrato });
  }

  // Sin presupuesto seleccionado y sin ninguna acción disponible (rol no admin):
  // no hay nada que ofrecer en el modal — mismo aviso que antes.
  if (!state.projectId && !actions.length) { toast('Selecciona un presupuesto primero', ''); return; }

  list.innerHTML = actions.length
    ? actions.map((a, i) => `
      <button class="quick-action-item" data-idx="${i}">
        <span class="quick-action-icon">${TAB_ICONS[a.icon] || a.icon || ''}</span><span>${esc(a.label)}</span>
      </button>`).join('')
    : '<p class="muted py-8">No tienes permiso para esta función.</p>';

  $$('.quick-action-item', list).forEach((btn, i) => {
    const a = actions[i];
    btn.addEventListener('click', () => {
      closeQuickActionMenu();
      if (a.fn) a.fn(); else switchToView(a.goto);
    });
  });

  menu.classList.remove('hidden-initial'); // ver .hidden-initial en styles.css
  menu.style.display = '';
  requestAnimationFrame(() => menu.classList.add('show'));
}

function closeQuickActionMenu() {
  const menu = $('#quickActionMenu'); if (!menu) return;
  menu.classList.remove('show');
  setTimeout(() => { if (!menu.classList.contains('show')) menu.style.display = 'none'; }, 250);
}

// ---------------------------------------------------------------------------
// Ajustes móvil (perfil, tema, mi cuenta, cerrar sesión)
// ---------------------------------------------------------------------------
function openMobileAjustes() {
  const pref = getTheme();
  const pal = getPalette();
  const fontSize = getFontSize();
  openModal(`
    <div class="modal-header-row">
      <h3 class="modal-title">Ajustes</h3>
      <button class="icon-btn modal-close-btn" id="btnCloseProfile" aria-label="Cerrar">✕</button>
    </div>
    <div class="ajustes-user-info">
      <strong>${esc(state.user?.nombre || '')}</strong>
      <div class="muted">${esc(PUESTO_LABELS[state.user?.puesto] || '')}</div>
    </div>
    <input type="text" id="ajustesSearchInput" class="ajustes-search-input" placeholder="Buscar en Ajustes…" autocomplete="off" />

    <div class="ajustes-item">
      <label class="ajustes-tema-label">Tema</label>
      <div class="theme-selector ajustes-theme-selector">
        <button class="theme-opt ${pref==='light'?'active':''}" data-theme-set="light">${icon('sun',14)} Claro</button>
        <button class="theme-opt ${pref==='dark'?'active':''}" data-theme-set="dark">${icon('moon',14)} Oscuro</button>
        <button class="theme-opt ${pref==='system'?'active':''}" data-theme-set="system">${icon('monitor',14)} Sistema</button>
      </div>
      <label class="ajustes-tema-label">Apariencia</label>
      <div class="palette-selector">
        <button class="palette-opt ${pal==='dorada'?'active':''}" data-palette-set="dorada">
          <span class="palette-swatch palette-swatch-dorada"><span></span><span></span><span></span></span>
          Tema GRUPO ROFORB
        </button>
        <button class="palette-opt ${pal==='morada'?'active':''}" data-palette-set="morada">
          <span class="palette-swatch palette-swatch-morada"><span></span><span></span><span></span></span>
          Tema NYRA
        </button>
        <button class="palette-opt ${pal==='verde'?'active':''}" data-palette-set="verde">
          <span class="palette-swatch palette-swatch-verde"><span></span><span></span><span></span></span>
          Tema JADE
        </button>
        <button class="palette-opt ${pal==='naranja'?'active':''}" data-palette-set="naranja">
          <span class="palette-swatch palette-swatch-naranja"><span></span><span></span><span></span></span>
          Tema TERRA
        </button>
      </div>
    </div>

    <hr class="ajustes-divider">
    <div class="ajustes-item">
      <label class="ajustes-tema-label">Accesibilidad</label>
      <div class="a11y-switch">
        <span class="a11y-switch-label">Reducir movimiento</span>
        <label>
          <input type="checkbox" id="chkReduceMotion" ${getReduceMotion() ? 'checked' : ''} />
          <span class="a11y-switch-track"><span class="a11y-switch-thumb"></span></span>
        </label>
      </div>
      <div class="a11y-switch">
        <span class="a11y-switch-label">Alto contraste</span>
        <label>
          <input type="checkbox" id="chkHighContrast" ${getHighContrast() ? 'checked' : ''} />
          <span class="a11y-switch-track"><span class="a11y-switch-thumb"></span></span>
        </label>
      </div>
      <label class="ajustes-tema-label">Tamaño de fuente</label>
      <div class="theme-selector ajustes-theme-selector" id="fontSizeSelector">
        <button class="theme-opt ${fontSize==='normal'?'active':''}" data-fontsize-set="normal">Normal</button>
        <button class="theme-opt ${fontSize==='large'?'active':''}" data-fontsize-set="large">Grande</button>
        <button class="theme-opt ${fontSize==='xlarge'?'active':''}" data-fontsize-set="xlarge">Muy grande</button>
      </div>
    </div>
    <hr class="ajustes-divider">

    ${!isStandalone() ? `<div class="ajustes-item"><button class="btn full ajustes-btn-mb" id="btnInstallModal">📲 Instalar app</button></div>` : ''}
    <div class="ajustes-item"><button class="btn full ajustes-btn-mb" id="btnMiCuentaModal">Mi cuenta</button></div>
    <div class="ajustes-item"><button class="btn btn-danger full" id="btnLogoutModal">Cerrar sesión</button></div>
    ${isAdmin() ? `
    <hr class="ajustes-divider">
    <div class="ajustes-item">
    <button id="__dbgToggle" class="dbg-toggle-btn">
      <span id="__dbgChevron" class="dbg-chevron">▶</span> Información técnica
    </button>
    <div id="__dbgPanel" class="hidden-initial dbg-panel">
      <div id="__dbgInline" class="dbg-inline-box">
        <span class="muted fs-08">Cargando…</span>
      </div>
    </div>
    </div>` : ''}
  `);
  $$('.theme-opt[data-theme-set]', $('#modal')).forEach((btn) => {
    btn.addEventListener('click', () => {
      setTheme(btn.dataset.themeSet);
      $$('.theme-opt[data-theme-set]', $('#modal')).forEach((b) => b.classList.toggle('active', b.dataset.themeSet === btn.dataset.themeSet));
    });
  });
  $$('.palette-opt', $('#modal')).forEach((btn) => {
    btn.addEventListener('click', () => setPalette(btn.dataset.paletteSet));
  });
  $$('.theme-opt[data-fontsize-set]', $('#modal')).forEach((btn) => {
    btn.addEventListener('click', () => {
      setFontSize(btn.dataset.fontsizeSet);
      $$('.theme-opt[data-fontsize-set]', $('#modal')).forEach((b) => b.classList.toggle('active', b.dataset.fontsizeSet === btn.dataset.fontsizeSet));
    });
  });
  $('#chkReduceMotion').addEventListener('change', (e) => setReduceMotion(e.target.checked));
  $('#chkHighContrast').addEventListener('change', (e) => setHighContrast(e.target.checked));
  $('#ajustesSearchInput').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    $$('.ajustes-item', $('#modal')).forEach((item) => {
      item.classList.toggle('ajustes-item-hidden', !!q && !item.textContent.toLowerCase().includes(q));
    });
  });
  $('#btnInstallModal')?.addEventListener('click', () => { closeModal(); installApp(); });
  $('#btnMiCuentaModal').addEventListener('click', () => { closeModal(); openMiCuentaModal(false); });
  $('#btnLogoutModal').addEventListener('click', () => { closeModal(); logout(); });
  $('#btnCloseProfile').addEventListener('click', closeModal);
  if (isAdmin()) {
    const toggleBtn = $('#__dbgToggle');
    const panel     = $('#__dbgPanel');
    const chevron   = $('#__dbgChevron');
    let open = false;
    toggleBtn.addEventListener('click', () => {
      open = !open;
      if (open) panel.classList.remove('hidden-initial'); // ver .hidden-initial en styles.css
      panel.style.display  = open ? '' : 'none';
      chevron.style.transform = open ? 'rotate(90deg)' : '';
      if (open) initDebugSection($('#__dbgInline'));
    });
  }
}

async function navigateFromNotif(notif) {
  const tab = TAB_POR_TIPO_NOTIF[notif.tipo];
  if (!tab || !notif.project_id || !state.allowedTabs.includes(tab)) return;
  const proj = state.projects.find((p) => p.id === notif.project_id);
  if (!proj) return;
  closeNotifDropdown();
  closeDrawer();
  closeModal();
  showApp();
  await selectProject(notif.project_id, tab);
  await abrirRegistroDesdeNotif(notif);
}

// Además de aterrizar en el módulo correcto, salta directo al registro
// mencionado por la notificación (abre su modal de autorizar/rechazar, o
// resalta su fila) — en vez de dejar al usuario viendo solo el listado
// general. Si el usuario no es admin, los propios modales/filas ya
// restringen las acciones de autorización (ver isAdmin() en cada uno), así
// que aquí no hace falta lógica extra de "solo lectura".
async function abrirRegistroDesdeNotif(notif) {
  const refId = notif.referencia_id;
  if (refId == null) return;
  try {
    switch (notif.tipo) {
      case 'requisicion_pendiente': await openRequisicionDetail(refId); break;
      case 'oc_pendiente': await openOrdenDetalle(refId); break;
      case 'avance_pendiente': resaltarFilaAvance(refId); break;
      case 'destajo_pendiente': await resaltarFilaDestajo(refId); break;
    }
  } catch (err) { /* la navegación al módulo ya ocurrió; el deep-link es best-effort */ }
}

function scrollAndFlash(el) {
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('notif-target-flash');
  setTimeout(() => el.classList.remove('notif-target-flash'), 1800);
}

function resaltarFilaAvance(semana) {
  scrollAndFlash(document.querySelector(`#avanceTbody tr[data-semana="${semana}"]`));
}

// avance_pendiente trae la semana como referencia_id (preciso). destajo_pendiente
// solo trae el destajista_id (ver server/notificaciones.js): la semana no se
// guarda como columna propia, así que aquí se ubica la fila pendiente
// buscando el botón de autorizar dentro de la tarjeta ya expandida — que es
// justo la semana que disparó la notificación (solo hay una fila pendiente
// a la vez por destajista, ver calcularEstadoAutorizacion en server/app.js).
async function resaltarFilaDestajo(destId) {
  const card = document.querySelector(`[data-dest-card="${destId}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const toggleBtn = card.querySelector('[data-toggle-semanal]');
  if (toggleBtn && !toggleBtn.classList.contains('open')) {
    const destajistas = await api(`/projects/${state.projectId}/destajistas`);
    await toggleDestajoSemanal(toggleBtn, destajistas);
  }
  const pendingBtn = card.querySelector('[data-autorizar-dest]');
  const row = pendingBtn ? pendingBtn.closest('tr') : card.querySelector('.collapse-body tbody tr');
  scrollAndFlash(row || card);
}

// limit opcional (Prompt B: panel "Actividad reciente" de la galería solo
// quiere las 5 más nuevas, no las hasta-50 del dropdown de la campana) — sin
// límite se comporta exactamente igual que antes.
function renderNotifList(targetEl, limit) {
  const list = targetEl || $('#notifList');
  if (!state.notificaciones.length) {
    list.innerHTML = '<div class="empty-state empty-state-compact">Sin notificaciones.</div>';
    return;
  }
  const items = limit ? state.notificaciones.slice(0, limit) : state.notificaciones;
  list.innerHTML = items.map((n) => `
    <div class="notif-item ${n.leida ? '' : 'unread'}" data-notif="${n.id}">
      <div class="notif-msg">${esc(n.mensaje)}</div>
      <div class="notif-time">${timeAgo(n.creado_en)}</div>
    </div>
  `).join('');

  $$('.notif-item', list).forEach((el) => {
    el.addEventListener('click', async () => {
      const id = Number(el.dataset.notif);
      const notif = state.notificaciones.find((n) => n.id === id);
      if (!notif) return;
      await navigateFromNotif(notif);
      if (notif.leida) return;
      try {
        await api(`/notificaciones/${id}/leida`, { method: 'PUT' });
        notif.leida = true;
        state.notifNoLeidas = Math.max(0, state.notifNoLeidas - 1);
        renderNotifBadge();
        renderNotifList(targetEl);
      } catch (err) { toast(err.message, 'danger'); }
    });
  });
}

function toggleNotifDropdown() {
  const dd = $('#notifDropdown');
  const opening = !dd.classList.contains('show');
  dd.classList.toggle('show');
  if (opening) { renderNotifList(); refreshNotificaciones(); }
}

function closeNotifDropdown() {
  $('#notifDropdown').classList.remove('show');
}

$('#btnNotif').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleNotifDropdown();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#notifDropdown') && !e.target.closest('#btnNotif')) closeNotifDropdown();
  if (!e.target.closest('#toast')) { clearTimeout(toast._t); $('#toast').className = 'toast'; }
});
$('#btnMarcarTodasLeidas').addEventListener('click', async (e) => {
  e.stopPropagation();
  try {
    await api('/notificaciones/leer-todas', { method: 'PUT' });
    state.notificaciones.forEach((n) => { n.leida = true; });
    state.notifNoLeidas = 0;
    renderNotifBadge();
    renderNotifList();
  } catch (err) { toast(err.message, 'danger'); }
});

function handleSessionExpired() {
  if (!state.token) return; // already logged out, avoid duplicate toasts
  state.token = null;
  localStorage.removeItem(TOKEN_KEY);
  state.user = null;
  state.projects = [];
  state.projectId = null;
  state.clientes = [];
  state.clienteId = null;
  state.cache = {};
  stopNotifPolling();
  closeDrawer();
  closeModal();
  showLoginScreen();
  toast('Tu sesión expiró, inicia sesión de nuevo', 'danger');
}

// Panel de Actividad reciente de la galería (Prompt B) — hay DOS puntos de
// entrada a la galería (bootApp(), en login y en restaurar sesión tras
// reload; goToClientGallery(), al volver desde #app con "Volver a
// clientes") y ambos necesitan pintarlo, así que vive en un solo helper.
// SÍ puede quedar fuera del Promise.all principal y sin await del caller
// (no bloquea el primer paint) porque nada más toca #galeriaRecientesList/
// #galeriaAlertasList mientras tanto — a diferencia de favoritos (ver abajo),
// aquí no hay riesgo de que una respuesta tardía pise un cambio del usuario.
function loadGaleriaActividad() {
  renderGaleriaActividad().catch(() => {});
}

async function bootApp() {
  destroyCharts();
  async function attempt() {
    // favoritos SÍ va dentro de este Promise.all (bloqueante, no fire-and-
    // forget) — bug real encontrado al probar: si se pedía aparte sin
    // esperar, una respuesta tardía podía llegar DESPUÉS de que el usuario
    // ya hubiera marcado/desmarcado un favorito (toggleFavorito ya actualizó
    // state.favoritos y repintó), y esa respuesta vieja pisaba el cambio de
    // vuelta al estado anterior. La consulta es rápida (un solo SELECT por
    // usuario_id), el costo de esperarla es mínimo.
    const [, , bienvenida, favoritos] = await Promise.all([
      refreshClientList(),
      refreshProjectList(),
      api('/bienvenida').catch(() => []),
      api('/favoritos').catch(() => []),
    ]);
    state.favoritos = new Set(favoritos);
    state.favoritosOrden = favoritos;
    showClientGallery();
    renderGalleryGreeting();
    renderFavoritosSection();
    renderClientGallery();
    renderBienvenidaSummary(bienvenida);
    renderGlobalChart().catch(() => {});
    renderAvancePorCliente().catch(() => {});
    loadGaleriaActividad();
  }
  try {
    await attempt();
  } catch {
    try {
      await new Promise((r) => setTimeout(r, 3000));
      await attempt();
    } catch (err2) {
      showApp();
      $('#view').innerHTML = `<div class="alert-box danger">⚠️ El servidor está iniciando. Espera unos segundos y recarga la página. (${esc(err2.message)})</div>`;
    }
  }
}

async function tryRestoreSession() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) { showLoginScreen(); return; }
  state.token = token;
  try {
    const data = await api('/auth/me');
    applySession(data.user, data.tabs, data.needsTotpReminder);
    // Restaurar simulación activa antes del reload (solo si el usuario es desarrollador)
    const savedSim = sessionStorage.getItem('sim_puesto');
    if (savedSim && data.user.puesto === 'desarrollador' && ROLE_TABS[savedSim]) {
      startSimulation(savedSim);
    } else {
      updateSimBanner();
    }
    await bootApp();
    if (data.must_change_password) {
      setTimeout(() => openMiCuentaModal(true), 400);
    }
  } catch (err) {
    // handleSessionExpired ya se disparó desde api() en un 401
    if (state.token) { state.token = null; localStorage.removeItem(TOKEN_KEY); showLoginScreen(); }
  }
}

async function logout() {
  // Limpia la cookie httpOnly del refresh token en el servidor.
  fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  state.token = null;
  localStorage.removeItem(TOKEN_KEY);
  state.user = null;
  state.projects = [];
  state.projectId = null;
  state.clientes = [];
  state.clienteId = null;
  state.cache = {};
  state.chartsSeen.clear();
  state.simulatedPuesto = null;
  state.needsTotpReminder = false;
  updateTotpReminderBanner();
  sessionStorage.removeItem('sim_puesto');
  stopNotifPolling();
  closeDrawer();
  showLoginScreen();
}

$('#btnLogout').addEventListener('click', logout);

// Completa el login (ya pasado el 2° factor, o directo si algún día deja de
// ser obligatorio): guarda el token, aplica la sesión y arranca la app.
async function completeLogin(data) {
  if (!data || !data.token || !data.user) {
    // No debería pasar con el backend actual — resguardo por si esta pestaña
    // quedó ejecutando una versión vieja de app.js contra un backend nuevo
    // (ver el reload-on-controllerchange más abajo, que evita justamente esto).
    throw new Error('Respuesta de sesión incompleta. Recarga la página (Ctrl+R / desliza para refrescar) e intenta de nuevo.');
  }
  state.token = data.token;
  localStorage.setItem(TOKEN_KEY, data.token);
  applySession(data.user, data.tabs, data.needsTotpReminder);
  await bootApp();
  if (data.must_change_password) {
    setTimeout(() => openMiCuentaModal(true), 400);
  }
}

$('#loginForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const usuario = $('#loginUsuario').value.trim();
  const password = $('#loginPassword').value;
  const errBox = $('#loginError');
  errBox.style.display = 'none';
  const btn = $('#btnLogin');
  btn.disabled = true; btn.textContent = 'Entrando…';
  try {
    const data = await api('/auth/login', { method: 'POST', body: { usuario, password } });
    $('#loginPassword').value = '';
    if (data.requiresTotp) {
      openTotpLoginModal(data.preAuthToken);
    } else {
      await completeLogin(data);
    }
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove('hidden-initial'); // ver .hidden-initial en styles.css
    errBox.style.display = '';
  } finally {
    btn.disabled = false; btn.textContent = 'Entrar';
  }
});

// ---------------------------------------------------------------------------
// 2FA (TOTP) — inscripción voluntaria (desde el banner de Inicio) y
// verificación del 2° factor en login normal para cuentas ya inscritas.
// ---------------------------------------------------------------------------
// Dispara el enrollment a pedido del usuario (botón "Configurar ahora" del
// banner de recordatorio). El usuario ya tiene sesión completa en este punto.
async function startTotpEnrollment() {
  try {
    const data = await api('/auth/totp/enroll-start', { method: 'POST' });
    openTotpEnrollModal(data.preAuthToken, data.qrDataUri, data.manualEntryKey);
  } catch (err) {
    toast(err.message, 'danger');
  }
}

// Muestra el QR (o clave manual) y pide confirmar un código antes de activar
// totp_enabled. A diferencia del enrollment forzado que existía antes (ver
// CLAUDE.md — 2FA es opcional desde julio 2026), el usuario ya tiene sesión
// completa aquí: cancelar solo cierra el modal, no hay pantalla de login que restaurar.
function openTotpEnrollModal(preAuthToken, qrDataUri, manualEntryKey) {
  openModal(`
    <h3>Configura la verificación en dos pasos</h3>
    <p class="muted">Escanea este código con Google Authenticator, Authy o cualquier app compatible con TOTP.</p>
    <div class="totp-qr-wrap"><img src="${qrDataUri}" alt="Código QR para configurar 2FA" class="totp-qr-img" /></div>
    <p class="muted fs-078">¿No puedes escanear el QR? Ingresa esta clave manualmente en tu app: <code class="totp-manual-key">${esc(manualEntryKey)}</code></p>
    <div class="field"><label>Código de 6 dígitos generado por la app</label><input id="totpEnrollCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" /></div>
    <div id="totpEnrollError" class="alert-box danger hidden-initial"></div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelTotpEnroll">Cancelar</button>
      <button class="btn btn-primary" id="btnConfirmTotpEnroll">Confirmar</button>
    </div>
  `);
  $('#totpEnrollCode').focus();
  $('#btnCancelTotpEnroll').addEventListener('click', closeModal);
  const submit = async () => {
    const code = $('#totpEnrollCode').value.trim();
    const errBox = $('#totpEnrollError');
    errBox.style.display = 'none';
    const btn = $('#btnConfirmTotpEnroll');
    btn.disabled = true; btn.textContent = 'Verificando…';
    try {
      const data = await api('/auth/totp/enroll-confirm', { method: 'POST', body: { preAuthToken, code } });
      openBackupCodesModal(data.backupCodes, data);
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove('hidden-initial'); // ver .hidden-initial en styles.css
      errBox.style.display = '';
      btn.disabled = false; btn.textContent = 'Confirmar';
    }
  };
  $('#btnConfirmTotpEnroll').addEventListener('click', submit);
  $('#totpEnrollCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

// Muestra los backup codes UNA sola vez tras completar la inscripción — no
// se pueden volver a consultar después (si el usuario los pierde, hay que
// generarlos de nuevo vía reset de 2FA). Bloquea el cierre por click-fuera
// para que no se pierdan por accidente antes de confirmarlos guardados.
function openBackupCodesModal(codes, sessionData) {
  blockOverlayDismiss = true;
  openModal(`
    <h3>Guarda tus códigos de respaldo</h3>
    <div class="alert-box warning mb-12">⚠️ Estos códigos NO se van a volver a mostrar. Guárdalos en un lugar seguro — cada uno sirve una sola vez para entrar si pierdes tu teléfono o tu app autenticadora.</div>
    <div class="totp-backup-grid">
      ${codes.map((c) => `<code class="totp-backup-code">${esc(c)}</code>`).join('')}
    </div>
    <label class="checkbox-label-inline mt-12">
      <input type="checkbox" id="chkBackupSaved" class="w-auto" /> Ya guardé mis códigos de respaldo
    </label>
    <div class="modal-actions">
      <button class="btn btn-primary full" id="btnBackupContinue" disabled>Continuar</button>
    </div>
  `);
  $('#chkBackupSaved').addEventListener('change', (e) => {
    $('#btnBackupContinue').disabled = !e.target.checked;
  });
  $('#btnBackupContinue').addEventListener('click', () => {
    blockOverlayDismiss = false;
    closeModal();
    // El enrollment ya emitió una sesión completa nueva (issueFullSession) —
    // se adopta ese token sin re-arrancar la app, para no sacar al usuario
    // de donde estaba (a diferencia del login inicial, aquí ya está navegando la app).
    if (sessionData && sessionData.token) {
      state.token = sessionData.token;
      localStorage.setItem(TOKEN_KEY, sessionData.token);
    }
    if (state.user) state.user.totp_enabled = true;
    state.needsTotpReminder = false;
    updateTotpReminderBanner();
    toast('Verificación en dos pasos activada', 'success');
  });
}

// Login normal ya inscrito: pide el código TOTP o, alternativamente, un
// código de respaldo de un solo uso.
function openTotpLoginModal(preAuthToken) {
  // .login-screen tiene z-index:100, por encima de .modal (60) y .overlay
  // (40) — sin ocultarla, el modal se crea y se muestra bien en el DOM pero
  // queda tapado visualmente por la pantalla de login. Se oculta al toque
  // (sin pasar por ocultarPantalla(), que retrasaría 180ms la aparición del
  // modal) pero SÍ se quita 'show' aquí mismo — si no, showLoginScreen()
  // la traería de vuelta ya con la clase puesta y se saltaría el fade-in.
  $('#loginScreen').classList.remove('show');
  $('#loginScreen').style.display = 'none';
  openModal(`
    <h3>Verificación en dos pasos</h3>
    <p class="muted">Ingresa el código de 6 dígitos de tu app autenticadora.</p>
    <div class="field"><label>Código</label><input id="totpLoginCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" /></div>
    <p class="muted fs-078"><a href="#" id="linkUseBackupCode">¿Perdiste el acceso? Usa un código de respaldo</a></p>
    <div class="field hidden-initial" id="totpBackupField">
      <label>Código de respaldo</label>
      <input id="totpBackupCode" autocomplete="off" placeholder="XXXX-XXXX" />
    </div>
    <div id="totpLoginError" class="alert-box danger hidden-initial"></div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelTotpLogin">Cancelar</button>
      <button class="btn btn-primary" id="btnConfirmTotpLogin">Entrar</button>
    </div>
  `);
  $('#totpLoginCode').focus();
  $('#btnCancelTotpLogin').addEventListener('click', () => { closeModal(); showLoginScreen(); });
  $('#linkUseBackupCode').addEventListener('click', (e) => {
    e.preventDefault();
    $('#totpBackupField').classList.remove('hidden-initial'); // ver .hidden-initial en styles.css
    $('#totpBackupCode').focus();
  });
  const submit = async () => {
    const code = $('#totpLoginCode').value.trim();
    const backupCode = $('#totpBackupCode').value.trim();
    const errBox = $('#totpLoginError');
    errBox.style.display = 'none';
    const btn = $('#btnConfirmTotpLogin');
    btn.disabled = true; btn.textContent = 'Verificando…';
    try {
      const body = backupCode ? { preAuthToken, backupCode } : { preAuthToken, code };
      const data = await api('/auth/totp/verify', { method: 'POST', body });
      closeModal();
      await completeLogin(data);
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove('hidden-initial'); // ver .hidden-initial en styles.css
      errBox.style.display = '';
      btn.disabled = false; btn.textContent = 'Entrar';
    }
  };
  $('#btnConfirmTotpLogin').addEventListener('click', submit);
  $('#totpLoginCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  $('#totpBackupCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

// ---------------------------------------------------------------------------
// Modal helpers
// ---------------------------------------------------------------------------
// Bloquea el scroll del fondo mientras cualquier modal está abierto — se
// aplica una sola vez aquí (todos los modales de la app pasan por
// openModal/closeModal) para que los modales nuevos lo hereden solos.
function openModal(html) {
  const modal = $('#modal');
  modal.innerHTML = html;
  modal.classList.add('show');
  $('#modalOverlay').classList.add('show');
  document.body.classList.add('modal-open');
}
function closeModal() {
  $('#modal').classList.remove('show');
  $('#modal').classList.remove('modal-wide'); // ver openVerEstimacionModal — no debe pegarse a otros modales
  $('#modalOverlay').classList.remove('show');
  $('#modal').innerHTML = '';
  document.body.classList.remove('modal-open');
  blockOverlayDismiss = false;
}
// Los códigos de respaldo de 2FA solo se muestran una vez — mientras ese modal
// está abierto, un click fuera no debe poder cerrarlo (perdería la única vista).
let blockOverlayDismiss = false;
$('#modalOverlay').addEventListener('click', () => { if (!blockOverlayDismiss) closeModal(); });
// Tecla Escape cierra el modal abierto (mismo criterio que el click en el
// overlay: respeta blockOverlayDismiss) — aplica a todos los modales de la
// app por igual, no solo a los nuevos, al vivir aquí junto a openModal/closeModal.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !blockOverlayDismiss && $('#modal').classList.contains('show')) closeModal();
});

// ---------------------------------------------------------------------------
// Ayuda contextual (botón "?" + modal de pasos)
// ---------------------------------------------------------------------------
// Diccionario clave_pantalla -> { titulo, pasos: [...] }. Para agregar ayuda
// a una pantalla nueva: (1) agrega una entrada aquí, (2) coloca
// renderHelpBtn('tu_clave') junto al título/botón de esa pantalla en su
// función renderX() — nada más, el modal y el listener ya son genéricos.
const AYUDA_CONTENIDO = {
  actualizarPresupuesto: {
    titulo: 'Actualizar presupuesto',
    pasos: [
      'Sube el Excel de presupuesto actualizado. Esto solo genera una vista previa — todavía no se guarda nada.',
      'Revisa las 4 categorías de la vista previa: Sin cambio (conceptos iguales), Modificados (cambió precio y/o cantidad), Nuevos (no existían antes) y Desaparecen (ya no están en el Excel nuevo).',
      'Si un concepto que esperabas ver "sin cambio" aparece como "nuevo", probablemente cambió su código o descripción en el Excel — cancela y corrígelo antes de confirmar, para no perder la continuidad de su avance.',
      'Al confirmar: los conceptos modificados actualizan su precio/cantidad sin perder el avance ya capturado (se revalúa solo, al precio nuevo). Los que desaparecen no se borran — quedan marcados como históricos y su avance sigue disponible. Los nuevos se agregan al catálogo.',
      'El presupuesto total y los porcentajes de avance financiero se recalculan automáticamente — no hace falta hacer nada más después de confirmar.',
    ],
  },
  nominaCaptura: {
    titulo: 'Captura de nómina',
    pasos: [
      'El residente crea la nómina del periodo — el sistema junta automáticamente los días de asistencia y el avance de destajo capturados en ese rango de fechas.',
      'Si un trabajador tiene tipo de pago "destajo" o "mixto", su monto de destajo se calcula solo (avance de destajo capturado × precio de destajo del concepto) — no se captura a mano.',
      'El residente envía la nómina a revisión. Desde ahí, solo un administrador puede aprobarla o rechazarla.',
      'Si se rechaza, regresa a borrador para corregirse y reenviarse. Una vez aprobada, ya no se puede modificar ni recalcular.',
    ],
  },
  requisiciones: {
    titulo: 'Requisiciones',
    pasos: [
      'Agrega los insumos que necesitas desde el catálogo de la obra — se van juntando en un borrador.',
      'Cuando el borrador esté completo, créalo como requisición.',
      'Estatus del flujo: Borrador (aún editable) → Enviada (esperando autorización) → Autorizada o Rechazada.',
      'Solo una requisición en estatus "Autorizada" puede usarse para generar una Orden de Compra.',
    ],
  },
  ordenesCompra: {
    titulo: 'Órdenes de compra',
    pasos: [
      'Una Orden de Compra se genera a partir de una requisición ya Autorizada — no se crean sueltas.',
      'Elige el proveedor y revisa que las cantidades e importes por insumo sean correctos antes de confirmar.',
      'Indica si el precio capturado ya incluye IVA o no (por default se asume que no lo incluye) — esto cambia cómo se calcula el total de la orden.',
      'Da seguimiento a su estatus hasta que se confirme la recepción de la mercancía.',
    ],
  },
  destajo: {
    titulo: 'Destajo',
    pasos: [
      'precio_unitario es el precio del presupuesto general de ese concepto. precio_destajo es lo que se le paga al destajista por unidad — son independientes, cambiar uno no afecta al otro.',
      'Solo el residente puede capturar destajo. Editar el precio de destajo requiere además el permiso específico de "editar precios" — si no lo ves editable, pídeselo a un administrador.',
      'El avance de destajo se captura por semana, igual que el avance general de obra.',
      'El pago de destajo se calcula con la cantidad ejecutada × el precio de destajo — nunca con el precio del presupuesto general.',
    ],
  },
};

// Botón "?" reutilizable — colócalo junto al título/acción de cualquier
// pantalla, pasándole la clave correspondiente de AYUDA_CONTENIDO.
function renderHelpBtn(clave) {
  return `<button class="help-btn" data-ayuda="${esc(clave)}" title="Ayuda" aria-label="Ayuda">?</button>`;
}

function openAyudaModal(clave) {
  const contenido = AYUDA_CONTENIDO[clave];
  if (!contenido) return;
  openModal(`
    <div class="modal-header-row">
      <h3 class="modal-title">${esc(contenido.titulo)}</h3>
      <button class="icon-btn modal-close-btn" id="btnCloseAyuda" aria-label="Cerrar">✕</button>
    </div>
    <ol class="ayuda-pasos">
      ${contenido.pasos.map((p) => `<li>${esc(p)}</li>`).join('')}
    </ol>
  `);
  $('#btnCloseAyuda').addEventListener('click', closeModal);
}

// Delegación única para cualquier botón [data-ayuda] presente en la app —
// una pantalla nueva no necesita registrar su propio listener, solo usar
// renderHelpBtn() en su HTML.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-ayuda]');
  if (btn) openAyudaModal(btn.dataset.ayuda);
});

// Diálogo de confirmación con el mismo estilo visual del resto de la app
// (reutiliza openModal/closeModal, mismas clases .modal-actions/.btn que
// cualquier otro modal) — para casos donde el confirm() nativo del navegador
// no da el look&feel deseado. El resto de la app sigue usando confirm()
// nativo (ver "Eliminar sugerencia"/"Eliminar equipo", etc.) — no se tocó
// nada de eso, este helper es de uso opcional para casos puntuales nuevos.
function confirmDialog(mensaje, { titulo = 'Confirmar', textoAceptar = 'Aceptar', textoCancelar = 'Cancelar', claseAceptar = 'btn-primary' } = {}) {
  return new Promise((resolve) => {
    blockOverlayDismiss = true; // debe elegir un botón, no cerrar tocando fuera
    openModal(`
      <h3>${esc(titulo)}</h3>
      <p>${esc(mensaje)}</p>
      <div class="modal-actions">
        <button class="btn" id="btnConfirmDialogCancelar">${esc(textoCancelar)}</button>
        <button class="btn ${esc(claseAceptar)}" id="btnConfirmDialogAceptar">${esc(textoAceptar)}</button>
      </div>
    `);
    $('#btnConfirmDialogCancelar').addEventListener('click', () => { closeModal(); resolve(false); });
    $('#btnConfirmDialogAceptar').addEventListener('click', () => { closeModal(); resolve(true); });
  });
}

// ---------------------------------------------------------------------------
// Drawer (project switcher)
// ---------------------------------------------------------------------------
function openDrawer() { $('#drawer').classList.add('open'); $('#drawerOverlay').classList.add('show'); }
function closeDrawer() { $('#drawer').classList.remove('open'); $('#drawerOverlay').classList.remove('show'); }
$('#btnMenu').addEventListener('click', () => {
  if (window.innerWidth <= 860) {
    openSidebar();
  } else {
    toggleSidebarCollapse();
  }
});
// En móvil el topbar muestra solo el nombre del proyecto/cliente — tappable para abrir el drawer
document.querySelector('.topbar-title').addEventListener('click', () => {
  if (window.innerWidth <= 860) openDrawer();
});
$('#btnCloseDrawer').addEventListener('click', closeDrawer);
$('#drawerOverlay').addEventListener('click', closeDrawer);
$('#drawerVolverClientes').addEventListener('click', () => goToClientGallery());

async function goToClientGallery() {
  closeDrawer();
  closeSidebar();
  state.clienteId = null;
  state.projectId = null;
  try {
    const [, bienvenida, favoritos] = await Promise.all([
      refreshClientList(),
      api('/bienvenida').catch(() => []),
      api('/favoritos').catch(() => []),
    ]);
    state.favoritos = new Set(favoritos);
    state.favoritosOrden = favoritos;
    showClientGallery();
    renderGalleryGreeting();
    renderFavoritosSection();
    renderClientGallery();
    renderBienvenidaSummary(bienvenida);
    renderGlobalChart().catch(() => {});
    renderAvancePorCliente().catch(() => {});
    loadGaleriaActividad();
  } catch (err) {
    toast(err.message, 'danger');
    showClientGallery();
    renderGalleryGreeting();
    renderClientGallery();
  }
}

async function refreshProjectList() {
  state.projects = await api('/projects');
  renderProjectList();
}

function visibleProjects() {
  if (state.clienteId === 'sin-cliente') return state.projects.filter((p) => p.cliente_id == null);
  return state.clienteId != null ? state.projects.filter((p) => p.cliente_id === state.clienteId) : state.projects;
}

function renderProjectList() {
  const list = $('#projectList');
  const projects = visibleProjects();
  if (!projects.length) {
    list.innerHTML = `<div class="empty-state"><div class="big">📂</div>Aún no hay presupuestos cargados.<br>Toca el botón de abajo para subir tu primer archivo Excel.</div>`;
    return;
  }
  list.innerHTML = projects.map((p) => {
    const finEstado = finObraEstado(p.fin_obra);
    return `
    <div class="project-item ${p.id === state.projectId ? 'active' : ''}" data-id="${p.id}">
      <span class="pname" data-pnombre="${p.id}">${esc(p.nombre)}</span>
      ${p.lugar ? `<span class="pmeta">${esc(p.lugar)}</span>` : ''}
      <span class="pmeta">${fmtMoney(p.total_sin_iva)} · ${fmtDate(p.inicio_obra)} – ${fmtDate(p.fin_obra)}
        ${finEstado ? `<span class="badge ${finEstado.vencido ? 'red' : 'yellow'}" title="${finEstado.vencido ? `Contrato vencido hace ${Math.abs(finEstado.dias)} día(s)` : `Contrato vence en ${finEstado.dias} día(s)`}">${finEstado.vencido ? '⚠️ Vencido' : '⏳ Por vencer'}</span>` : ''}
      </span>
      ${isAdmin() ? `
      <div class="pactions">
        <button class="btn small" data-renombrar="${p.id}" title="Renombrar presupuesto">✏️</button>
        <button class="btn small" data-cambiar-cliente="${p.id}">Cambiar cliente</button>
        <button class="btn small btn-danger" data-del="${p.id}">Eliminar</button>
      </div>` : ''}
    </div>
  `;
  }).join('');

  $$('.project-item', list).forEach((el) => {
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-del]') || ev.target.closest('[data-cambiar-cliente]')) return;
      selectProject(Number(el.dataset.id));
      closeDrawer();
    });
  });
  $$('[data-cambiar-cliente]', list).forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = Number(btn.dataset.cambiarCliente);
      const proj = state.projects.find((p) => p.id === id);
      if (proj) openCambiarClienteModal(proj);
    });
  });
  $$('[data-del]', list).forEach((btn) => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const id = Number(btn.dataset.del);
      const proj = state.projects.find((p) => p.id === id) || visibleProjects().find((p) => p.id === id);
      if (!proj) { toast('No se encontró el presupuesto', 'danger'); return; }
      if (!confirm(`¿Eliminar el presupuesto "${proj.nombre}" y su base de datos? Esta acción no se puede deshacer.`)) return;
      try {
        await api(`/projects/${id}`, { method: 'DELETE' });
        delete state.cache[id];
        if (state.projectId === id) state.projectId = null;
        await refreshProjectList();
        const remaining = visibleProjects();
        if (!state.projectId && remaining[0]) selectProject(remaining[0].id);
        else if (!remaining.length) renderView();
        toast('Presupuesto eliminado', 'success');
      } catch (err) {
        toast(err.message || 'Error al eliminar el presupuesto', 'danger');
      }
    });
  });
  $$('[data-renombrar]', list).forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = Number(btn.dataset.renombrar);
      const proj = state.projects.find((p) => p.id === id);
      if (!proj) return;
      const nameSpan = list.querySelector(`[data-pnombre="${id}"]`);
      if (!nameSpan || nameSpan.tagName === 'INPUT') return;
      const input = document.createElement('input');
      input.className = 'pinput';
      input.value = proj.nombre;
      nameSpan.replaceWith(input);
      input.focus();
      input.select();
      const guardar = async () => {
        const nuevo = input.value.trim();
        if (!nuevo || nuevo === proj.nombre) { renderProjectList(); return; }
        try {
          await api(`/projects/${id}/nombre`, { method: 'PATCH', body: { nombre: nuevo } });
          proj.nombre = nuevo;
          const sn = $('#sidebarProjectName');
          if (state.projectId === id && sn) sn.textContent = nuevo;
          renderProjectList();
          toast('Nombre actualizado', 'success');
        } catch (err) {
          toast(err.message, 'danger');
          renderProjectList();
        }
      };
      input.addEventListener('blur', guardar);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = proj.nombre; input.blur(); }
      });
    });
  });
}

function openCambiarClienteModal(project) {
  const options = state.clientes.map((c) => `<option value="${c.id}" ${c.id === project.cliente_id ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('');
  openModal(`
    <h3>Cambiar cliente</h3>
    <p class="muted">Reasigna "${esc(project.nombre)}" a otro cliente.</p>
    <div class="field"><label>Cliente</label><select id="cambiarClienteSelect"><option value="">Selecciona un cliente…</option>${options}</select></div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelCambiarCliente">Cancelar</button>
      <button class="btn btn-primary" id="btnSaveCambiarCliente">Guardar</button>
    </div>
  `);
  $('#btnCancelCambiarCliente').addEventListener('click', closeModal);
  $('#btnSaveCambiarCliente').addEventListener('click', async () => {
    const clienteId = Number($('#cambiarClienteSelect').value) || null;
    if (!clienteId) { toast('Selecciona un cliente', 'danger'); return; }
    const btn = $('#btnSaveCambiarCliente');
    btn.disabled = true; btn.textContent = 'Guardando…';
    try {
      await api(`/projects/${project.id}/cliente`, { method: 'PUT', body: { cliente_id: clienteId } });
      closeModal();
      await Promise.all([refreshClientList(), refreshProjectList()]);
      renderProjectList();
      toast('Cliente actualizado', 'success');
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false; btn.textContent = 'Guardar';
    }
  });
}

function selectProject(id, targetView) {
  const vieneDeSinProyecto = !state.projectId; // true cuando se entra desde el resumen de cliente
  state.projectId = id;
  syncErrorTags();
  state.cache[id] = state.cache[id] || {};
  const p = state.projects.find((x) => x.id === id);
  $('#projectName').textContent = p ? `Trabajando en: ${p.nombre}` : '';
  const sn = $('#sidebarProjectName'); if (sn) sn.textContent = p ? p.nombre : 'Sin presupuesto';
  state.view = targetView || (state.allowedTabs.length <= 1 ? (state.allowedTabs[0] || 'inicio') : 'inicio');
  state.section = VIEW_TO_SECTION[state.view] || null;
  renderProjectList();
  renderTabsBar();
  renderSidebar();
  renderMobileNav();
  // pushState al entrar desde el resumen → iOS swipe-back regresa al resumen.
  // replaceState al cambiar entre proyectos → no acumula entradas en historial.
  if (vieneDeSinProyecto) { pushTabHistory(); } else { replaceTabHistory(); }
  if (typeof state.clienteId === 'number') {
    api(`/ultima-visita/${state.clienteId}`, { method: 'PUT', body: { proyecto_id: id } }).catch(() => {});
  }
  return renderView();
}

// ---------------------------------------------------------------------------
// Galería de clientes (pantalla previa a elegir un proyecto)
// ---------------------------------------------------------------------------
async function refreshClientList() {
  state.clientes = await api('/clientes');
}

// Markup de una tarjeta de cliente real — extraído de renderClientGallery()
// (Prompt B) para reutilizarlo también en la franja de Favoritos, sin
// duplicar la plantilla a mano en dos sitios.
function clienteCardHtml(c) {
  const isFav = state.favoritos.has(c.id);
  return `
    <div class="cliente-card" data-cliente="${c.id}">
      <button class="cliente-fav-btn ${isFav ? 'active' : ''}" data-cliente-fav="${c.id}"
        title="${isFav ? 'Quitar de favoritos' : 'Marcar como favorito'}"
        aria-label="${isFav ? 'Quitar de favoritos' : 'Marcar como favorito'}">${isFav ? '⭐' : '☆'}</button>
      <span class="cliente-icon">🏢</span>
      <span class="cliente-nombre">${esc(c.nombre)}</span>
      <span class="cliente-count">${c.num_proyectos} presupuesto${c.num_proyectos !== 1 ? 's' : ''}</span>
      ${isAdmin() ? `
        <button class="cliente-menu-btn" data-cliente-menu-btn="${c.id}" title="Opciones">⋮</button>
        <div class="cliente-menu-dropdown hidden-initial" data-cliente-menu-dropdown="${c.id}">
          <button class="cliente-menu-item cliente-menu-item-danger" data-cliente-eliminar="${c.id}" data-cliente-eliminar-nombre="${esc(c.nombre)}">🗑️ Eliminar cliente</button>
        </div>` : ''}
    </div>
  `;
}

// Wiring de clicks (seleccionar/menú/eliminar/favorito) — común a #clienteGrid
// y #favoritosGrid, extraído de renderClientGallery() (Prompt B).
function wireClienteCards(grid) {
  $$('.cliente-card', grid).forEach((el) => {
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-cliente-menu-btn]') || ev.target.closest('[data-cliente-menu-dropdown]') || ev.target.closest('[data-cliente-fav]')) return;
      if (el.dataset.cliente === '__nuevo__') { openNuevoClienteModal(); return; }
      selectCliente(el.dataset.cliente === 'sin-cliente' ? 'sin-cliente' : Number(el.dataset.cliente));
    });
  });
  $$('[data-cliente-menu-btn]', grid).forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const dropdown = grid.querySelector(`[data-cliente-menu-dropdown="${btn.dataset.clienteMenuBtn}"]`);
      const wasOpen = !dropdown.classList.contains('hidden-initial');
      closeAllClienteMenus();
      if (!wasOpen) dropdown.classList.remove('hidden-initial');
    });
  });
  $$('[data-cliente-eliminar]', grid).forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeAllClienteMenus();
      eliminarCliente(Number(btn.dataset.clienteEliminar), btn.dataset.clienteEliminarNombre);
    });
  });
  $$('[data-cliente-fav]', grid).forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggleFavorito(Number(btn.dataset.clienteFav));
    });
  });
}

function renderClientGallery() {
  const grid = $('#clienteGrid');
  // Proyectos sin cliente_id: solo pueden existir de cargas hechas antes de que
  // cliente_id fuera obligatorio (ver PUT /projects/:id/cliente). Solo admin
  // los ve, como una tarjeta especial, para poder reasignarlos.
  const huerfanos = state.projects.filter((p) => p.cliente_id == null);
  let html = state.clientes.map((c) => clienteCardHtml(c)).join('');
  if (isAdmin() && huerfanos.length) {
    html += `
      <div class="cliente-card cliente-card-orphan" data-cliente="sin-cliente">
        <span class="cliente-icon">⚠️</span>
        <span class="cliente-nombre">Sin cliente asignado</span>
        <span class="cliente-count">${huerfanos.length} presupuesto${huerfanos.length !== 1 ? 's' : ''}</span>
      </div>`;
  }
  // Mismo permiso que "+ Nuevo cliente" en el drawer "Presupuestos cargados"
  // (isAdmin(), ver applySession()) — mismo handler, solo un atajo adicional.
  if (isAdmin()) {
    html += `
      <div class="cliente-card cliente-card-new" data-cliente="__nuevo__">
        <span class="cliente-icon">➕</span>
        <span class="cliente-nombre">Nuevo cliente</span>
      </div>`;
  }
  grid.innerHTML = html || `<div class="empty-state"><div class="big">🏢</div>Aún no hay clientes registrados.</div>`;
  wireClienteCards(grid);
  initClienteSortable(grid);
}

// Franja "⭐ Favoritos" (Prompt B) — se oculta por completo (no deja hueco
// vacío) si el usuario no tiene ningún cliente marcado.
function renderFavoritosSection() {
  const section = $('#favoritosSection');
  const grid = $('#favoritosGrid');
  if (!section || !grid) return;
  // En el orden elegido por drag (state.favoritosOrden), NO en el orden de
  // state.clientes (prompt-dashboard-favoritos-layout.md) — un cliente
  // puede estar en cualquier posición de la cuadrícula general y aun así
  // tener un lugar distinto dentro de Favoritos.
  const favClientes = state.favoritosOrden
    .map((id) => state.clientes.find((c) => c.id === id))
    .filter(Boolean);
  if (!favClientes.length) { section.classList.add('hidden-initial'); grid.innerHTML = ''; return; }
  section.classList.remove('hidden-initial');
  grid.innerHTML = favClientes.map((c) => clienteCardHtml(c)).join('');
  wireClienteCards(grid);
  initFavoritosSortable(grid);
}

// Drag-to-reorder de Favoritos (prompt-dashboard-favoritos-layout.md) —
// mismo mecanismo que initClienteSortable() (SortableJS, long-press en
// touch), simplificado: a diferencia de #clienteGrid, aquí todas las
// tarjetas son clientes reales (sin "+ Nuevo cliente"/"Sin cliente
// asignado" que excluir del arrastre).
function initFavoritosSortable(grid) {
  // Igual que initClienteSortable(): #favoritosGrid es un nodo persistente
  // (solo su innerHTML cambia en cada render) — Sortable ya sigue operando
  // sobre los hijos actuales sin reinicializarse, así que basta con
  // engancharlo una sola vez.
  if (grid._favoritosSortable) return;
  grid._favoritosSortable = new Sortable(grid, {
    animation: 150,
    delay: 300,
    delayOnTouchOnly: true,
    touchStartThreshold: 5,
    filter: '[data-cliente-menu-btn], .cliente-menu-dropdown',
    preventOnFilter: false,
    onEnd: async () => {
      const orden = $$('.cliente-card', grid).map((el) => Number(el.dataset.cliente));
      state.favoritosOrden = orden;
      try {
        await api('/favoritos/orden', { method: 'PUT', body: { orden } });
      } catch (err) {
        toast(err.message, 'danger');
      }
    },
  });
}

async function toggleFavorito(clienteId) {
  const isFav = state.favoritos.has(clienteId);
  try {
    if (isFav) {
      await api(`/favoritos/${clienteId}`, { method: 'DELETE' });
      state.favoritos.delete(clienteId);
      state.favoritosOrden = state.favoritosOrden.filter((id) => id !== clienteId);
    } else {
      await api(`/favoritos/${clienteId}`, { method: 'POST' });
      state.favoritos.add(clienteId);
      state.favoritosOrden = [...state.favoritosOrden, clienteId]; // se agrega al final, igual que el backend
    }
    renderFavoritosSection();
    renderClientGallery();
  } catch (err) {
    toast(err.message, 'danger');
  }
}

// Panel "Actividad reciente" de la galería (Prompt B) — 2 fuentes ya
// existentes, sin tracking nuevo: ultima_visita (histórico real de
// proyectos abiertos) y state.notificaciones (mismo feed que la campana del
// topbar, ya fresco por startNotifPolling() desde el login). Solo visible
// en desktop (CSS), pero se pinta siempre — más barato que detectar el
// breakpoint en JS y no falla si la ventana se agranda después.
async function renderGaleriaActividad() {
  const recientesEl = $('#galeriaRecientesList');
  const alertasEl = $('#galeriaAlertasList');
  if (!recientesEl || !alertasEl) return;

  try {
    const recientes = await api('/ultima-visita/recientes');
    if (!recientes.length) {
      recientesEl.innerHTML = '<div class="galeria-actividad-empty">Aún no has abierto ningún presupuesto.</div>';
    } else {
      // Cliente arriba (eyebrow) + obra en negrita abajo — mismo tratamiento
      // que "Mayor avance" (prompt-dashboard-favoritos-layout.md), y barra
      // de progreso compacta con el mismo dato ya usado en /bienvenida y
      // /resumen-global (avance_ejecutado_pct), no un cálculo nuevo.
      recientesEl.innerHTML = recientes.map((r) => {
        const pct = Math.min(100, Math.max(0, Number(r.avance_ejecutado_pct) || 0));
        return `
        <div class="galeria-reciente-item" data-pid="${r.proyecto_id}" data-cid="${r.cliente_id}">
          <div class="gr-cliente">${esc(r.cliente_nombre)}</div>
          <div class="gr-proyecto">${esc(r.proyecto_nombre)}</div>
          <div class="gr-progress-bar"><div class="gr-progress-fill" data-pct="${pct}"></div></div>
          <div class="gr-meta-row">
            <span class="gr-time">${timeAgo(r.actualizado_en)}</span>
            <span class="gr-pct">${pct.toFixed(1)}%</span>
          </div>
        </div>`;
      }).join('');
      // Width por JS (CSP bloquea estilos inline con %) — mismo patrón que
      // .wpc-progress-fill en renderBienvenidaSummary.
      $$('.gr-progress-fill', recientesEl).forEach((fill) => { fill.style.width = fill.dataset.pct + '%'; });
      $$('.galeria-reciente-item', recientesEl).forEach((el) => {
        el.addEventListener('click', () => {
          state.clienteId = Number(el.dataset.cid);
          showApp();
          selectProject(Number(el.dataset.pid));
        });
      });
    }
  } catch (err) {
    recientesEl.innerHTML = '<div class="galeria-actividad-empty">No se pudo cargar.</div>';
  }

  if (!state.notificaciones.length) {
    alertasEl.innerHTML = '<div class="galeria-actividad-empty">Sin alertas.</div>';
  } else {
    renderNotifList(alertasEl, 5);
  }
}

function closeAllClienteMenus() {
  $$('.cliente-menu-dropdown', document).forEach((d) => d.classList.add('hidden-initial'));
}
document.addEventListener('click', closeAllClienteMenus);

// SortableJS se inicializa una sola vez sobre #clienteGrid (el contenedor
// persiste entre renders; solo su innerHTML se reemplaza) — evita apilar
// listeners duplicados en cada llamada a renderClientGallery().
function initClienteSortable(grid) {
  if (grid._clienteSortable) return;
  grid._clienteSortable = new Sortable(grid, {
    animation: 150,
    delay: 300, // long-press en touch antes de iniciar el arrastre
    delayOnTouchOnly: true,
    touchStartThreshold: 5,
    filter: '.cliente-card-new, .cliente-card-orphan, [data-cliente-menu-btn], .cliente-menu-dropdown',
    preventOnFilter: false,
    // "+ Nuevo cliente" y "Sin cliente asignado" nunca cambian de posición:
    // se rechaza cualquier intercambio contra esas dos tarjetas especiales,
    // el resto se puede reordenar libremente alrededor de ellas.
    onMove: (evt) => !evt.related.classList.contains('cliente-card-new') && !evt.related.classList.contains('cliente-card-orphan'),
    onEnd: async () => {
      const orden = $$('.cliente-card:not(.cliente-card-new):not(.cliente-card-orphan)', grid)
        .map((el) => Number(el.dataset.cliente));
      try {
        await api('/clientes/orden', { method: 'PUT', body: { orden } });
      } catch (err) {
        toast(err.message, 'danger');
      }
    },
  });
}

async function eliminarCliente(id, nombre) {
  const ok = await confirmDialog(
    `Esta acción no se puede deshacer. Se eliminará permanentemente el cliente "${nombre}". ` +
    `Si tiene obras o presupuestos asociados, no se podrá eliminar hasta que los reasignes o elimines primero.`,
    { titulo: 'Eliminar cliente', textoAceptar: 'Eliminar', textoCancelar: 'Cancelar' }
  );
  if (!ok) return;
  try {
    await api(`/clientes/${id}`, { method: 'DELETE' });
    state.clientes = state.clientes.filter((c) => c.id !== id);
    renderClientGallery();
    toast('Cliente eliminado', 'success');
  } catch (err) {
    toast(err.message, 'danger');
  }
}

function renderGalleryGreeting() {
  const el = $('#galleryGreeting');
  if (!el || !state.user) return;
  const nombre = state.user.nombre || state.user.usuario || '';
  const now = new Date();
  const fecha = `${DIAS_ES[now.getDay()]}, ${now.getDate()} de ${MESES_ES[now.getMonth()]} de ${now.getFullYear()}`;
  el.innerHTML = `<h2>Bienvenido/a, ${esc(nombre)}</h2><p class="muted">${fecha}</p>`;
}

function renderBienvenidaSummary(proyectos) {
  const el = $('#bienvenidaSummary');
  if (!el) return;
  if (!proyectos || !proyectos.length) { el.innerHTML = ''; return; }

  // Top-2 por mayor % de avance; desempate por presupuesto mayor
  const top2 = [...proyectos]
    .sort((a, b) => {
      const pa = Number(a.avance_financiero_ejecutado) || 0;
      const pb = Number(b.avance_financiero_ejecutado) || 0;
      if (pb !== pa) return pb - pa;
      return (Number(b.presupuesto_total) || 0) - (Number(a.presupuesto_total) || 0);
    })
    .slice(0, 2);

  let cardsHtml = top2.map((p) => {
    const pct = Math.min(100, Math.max(0, Number(p.avance_financiero_ejecutado) || 0));
    const totalFmt = p.presupuesto_total != null ? (p.presupuesto_total ? fmtMoney(p.presupuesto_total) : '—') : null;
    return `
      <div class="welcome-project-card bienvenida-proj-card" data-pid="${p.id}" data-cid="${p.cliente_id != null ? p.cliente_id : ''}">
        ${p.cliente_nombre ? `<div class="wpc-client">${esc(p.cliente_nombre)}</div>` : ''}
        <div class="wpc-nombre">${esc(p.nombre)}</div>
        <div class="wpc-progress-bar"><div class="wpc-progress-fill" data-pct="${pct}"></div></div>
        <div class="wpc-stats">
          <span class="wpc-pct">${pct.toFixed(1)}% ejecutado</span>
          ${totalFmt != null ? `<span class="wpc-total">${totalFmt}</span>` : ''}
        </div>
      </div>`;
  }).join('');

  el.innerHTML = `<div class="bienvenida-summary">
    <div class="bienvenida-summary-title">Mayor avance</div>
    <div class="bienvenida-client-grid">${cardsHtml}</div>
  </div>`;

  // Width por propiedad JS, no como parte del string de innerHTML (bloqueado por CSP).
  $$('.wpc-progress-fill', el).forEach((fill) => { fill.style.width = fill.dataset.pct + '%'; });

  $$('.bienvenida-proj-card', el).forEach((card) => {
    card.addEventListener('click', () => {
      const pid = Number(card.dataset.pid);
      const cid = card.dataset.cid ? Number(card.dataset.cid) : null;
      state.clienteId = cid;
      showApp();
      selectProject(pid);
    });
  });
}

async function renderGlobalChart() {
  const el = $('#globalChartSection');
  if (!el) return;
  if (!isAdmin()) { el.innerHTML = ''; return; }

  const data = await api('/resumen-global');
  if (!data.num_proyectos) { el.innerHTML = ''; return; }

  if (state.charts.globalPie) { try { state.charts.globalPie.destroy(); } catch {} delete state.charts.globalPie; }

  el.innerHTML = `
    <div class="global-chart-section">
      <div class="bienvenida-summary-title">Resumen global — ${data.num_proyectos} obra${data.num_proyectos === 1 ? '' : 's'}</div>
      <div class="global-chart-wrap">
        <div class="global-chart-canvas-wrap">
          <canvas id="globalPieChart" width="140" height="140"></canvas>
          <div class="global-chart-pct">${data.avance_ponderado_pct.toFixed(1)}%</div>
        </div>
        <div class="global-chart-kpis">
          <div class="global-kpi">
            <span class="global-kpi-label">Total contratos</span>
            <span class="global-kpi-value">${fmtMoney(data.total_contratos)}</span>
          </div>
          <div class="global-kpi">
            <span class="global-kpi-label">Ejecutado</span>
            <span class="global-kpi-value text-verde">${fmtMoney(data.importe_ejecutado)}</span>
          </div>
          <div class="global-kpi">
            <span class="global-kpi-label">Por ejecutar</span>
            <span class="global-kpi-value text-secondary-color">${fmtMoney(data.importe_por_ejecutar)}</span>
          </div>
          <div class="global-kpi">
            <span class="global-kpi-label">Avance ponderado</span>
            <span class="global-kpi-value accent">${data.avance_ponderado_pct.toFixed(1)}%</span>
          </div>
        </div>
      </div>
    </div>`;

  const ctx = $('#globalPieChart').getContext('2d');
  const cc = chartColors();
  state.charts.globalPie = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Ejecutado', 'Por ejecutar'],
      datasets: [{
        data: [data.importe_ejecutado, data.importe_por_ejecutar],
        backgroundColor: ['#22c55e', cc.grid],
        // Este donut vive directo sobre el fondo de página (.global-chart-section
        // no tiene su propio background), no dentro de una .card — el borde de
        // cada segmento debe fundirse con --bg-primary, no con --bg-surface.
        borderColor: cc.primary,
        borderWidth: 3,
      }],
    },
    options: {
      responsive: false,
      cutout: '62%',
      animation: animationForChart('globalPie'),
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => `${c.label}: ${fmtMoney(c.raw)}` } },
      },
    },
  });
  state.charts.globalPie._cpBorderSurface = 'primary';
  state.charts.globalPie._cpGridBgIndexes = [1]; // 'Por ejecutar' (índice 1 en backgroundColor)
}

// Dashboard "Avance por cliente" (prompt-dashboard-favoritos-layout.md,
// Fase 4) — agregado POR CLIENTE (no confundir con "Mayor avance", que es
// por obra individual, ni con "Resumen Global", que es el promedio de
// TODAS las obras junto). GET /avance-por-cliente ya devuelve los top 4
// con la misma fórmula de ponderación que Resumen Global — aquí solo se
// pinta, sin recalcular nada. Mismo gate que Resumen Global (isAdmin()):
// vive al lado de él en .dashboards-row, tiene sentido que comparta
// visibilidad.
async function renderAvancePorCliente() {
  const el = $('#avancePorClienteSection');
  if (!el) return;
  if (!isAdmin()) { el.innerHTML = ''; return; }

  const data = await api('/avance-por-cliente').catch(() => []);
  if (!data.length) { el.innerHTML = ''; return; }

  el.innerHTML = `
    <div class="apc-section">
      <div class="bienvenida-summary-title">Avance por cliente</div>
      <div class="apc-list">
        ${data.map((c) => {
          const pct = Math.min(100, Math.max(0, Number(c.avance_ponderado_pct) || 0));
          return `
          <div class="apc-item">
            <div class="apc-row-top">
              <span class="apc-nombre">${esc(c.cliente_nombre)}</span>
              <span class="apc-pct">${pct.toFixed(1)}%</span>
            </div>
            <div class="apc-bar"><div class="apc-fill" data-pct="${pct}"></div></div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  $$('.apc-fill', el).forEach((fill) => { fill.style.width = fill.dataset.pct + '%'; });
}

async function selectCliente(id) {
  state.clienteId = id;
  state.projectId = null;
  state.view = 'inicio';
  state.section = null;
  showApp();
  if (id === 'sin-cliente') {
    $('#projectName').textContent = 'Sin cliente asignado — elige un presupuesto';
  } else {
    const cliente = state.clientes.find((c) => c.id === id);
    $('#projectName').textContent = cliente ? `${cliente.nombre.toUpperCase()} — elige un presupuesto` : '';
  }
  renderProjectList();
  renderTabsBar();
  renderSidebar();
  renderMobileNav();
  pushTabHistory(); // entrada en historial: swipe-back en iOS regresa aquí desde el proyecto
  renderView();    // muestra resumen financiero (admin/residente) o estado vacío
}

$('#btnGalleryLogout').addEventListener('click', logout);
$('#btnNuevoClienteDrawer').addEventListener('click', () => { closeDrawer(); openNuevoClienteModal(); });
$('#btnCargarContratoDrawer').addEventListener('click', () => { closeDrawer(); promptUploadContrato(); });

$('#btnGalleryMenu').addEventListener('click', openGalleryDrawer);
$('#btnGalleryDrawerClose').addEventListener('click', closeGalleryDrawer);
$('#galleryDrawerOverlay').addEventListener('click', closeGalleryDrawer);
$('#chkReduceMotionGallery').addEventListener('change', (e) => setReduceMotion(e.target.checked));
$('#chkHighContrastGallery').addEventListener('change', (e) => setHighContrast(e.target.checked));
$('#btnMiCuentaGalleryDrawer').addEventListener('click', () => { closeGalleryDrawer(); openMiCuentaModal(false); });
$('#btnLogoutGalleryDrawer').addEventListener('click', () => { closeGalleryDrawer(); logout(); });
$('#btnGalleryGoUsuarios').addEventListener('click', () => goToGlobalAdminView('usuarios'));
$('#btnGalleryGoTrabajadoresGlobal').addEventListener('click', () => goToGlobalAdminView('trabajadores_global'));
$('#btnGalleryGoNominasGlobal').addEventListener('click', () => goToGlobalAdminView('nominas_global'));
$('#btnGalleryGoPermisos').addEventListener('click', () => { state.usuariosSubView = 'permisos'; goToGlobalAdminView('usuarios'); });

function openNuevoClienteModal() {
  openModal(`
    <h3>Nuevo cliente</h3>
    <div class="field"><label>Nombre del cliente *</label><input id="nuevoClienteNombre" placeholder="Ej. VINTE" /></div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelNuevoCliente">Cancelar</button>
      <button class="btn btn-primary" id="btnSaveNuevoCliente">Crear cliente</button>
    </div>
  `);
  $('#btnCancelNuevoCliente').addEventListener('click', closeModal);
  $('#btnSaveNuevoCliente').addEventListener('click', async () => {
    const nombre = $('#nuevoClienteNombre').value.trim();
    if (!nombre) { toast('Escribe el nombre del cliente', 'danger'); return; }
    const btn = $('#btnSaveNuevoCliente');
    btn.disabled = true; btn.textContent = 'Creando…';
    try {
      await api('/clientes', { method: 'POST', body: { nombre } });
      closeModal();
      await refreshClientList();
      renderClientGallery();
      toast('Cliente creado', 'success');
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false; btn.textContent = 'Crear cliente';
    }
  });
}

// ---------------------------------------------------------------------------
// Pantalla de bienvenida
// ---------------------------------------------------------------------------
const DIAS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function renderWelcomeScreen(proyectos) {
  const u = state.user;
  const nombre = u.nombre || u.usuario || '';
  $('#welcomeTitle').textContent = `Bienvenido/a, ${nombre}`;

  const now = new Date();
  $('#welcomeDate').textContent = `${DIAS_ES[now.getDay()]}, ${now.getDate()} de ${MESES_ES[now.getMonth()]} de ${now.getFullYear()}`;

  const multi = proyectos.length > 1;
  const container = $('#welcomeProyectos');
  container.className = `welcome-proyectos${multi ? ' multi' : ''}`;

  if (!proyectos.length) {
    container.innerHTML = `<div class="empty-state">No hay obras asignadas.</div>`;
  } else {
    container.innerHTML = proyectos.map((p) => {
      const pct = Math.min(100, Math.max(0, Number(p.avance_financiero_ejecutado) || 0));
      const totalFmt = p.presupuesto_total ? fmtMoney(p.presupuesto_total) : '—';
      return `
        <div class="welcome-project-card" data-pid="${p.id}" data-cid="${p.cliente_id || ''}">
          ${p.cliente_nombre ? `<div class="wpc-client">${esc(p.cliente_nombre)}</div>` : ''}
          <div class="wpc-nombre">${esc(p.nombre)}</div>
          <div class="wpc-progress-bar"><div class="wpc-progress-fill" data-pct="${pct}"></div></div>
          <div class="wpc-stats">
            <span class="wpc-pct">${pct.toFixed(1)}% ejecutado</span>
            <span class="wpc-total">${totalFmt}</span>
          </div>
        </div>`;
    }).join('');

    // Width por propiedad JS, no como parte del string de innerHTML (bloqueado por CSP).
    $$('.wpc-progress-fill', container).forEach((fill) => { fill.style.width = fill.dataset.pct + '%'; });

    if (multi) {
      $$('.welcome-project-card', container).forEach((el) => {
        el.addEventListener('click', () => {
          const pid = Number(el.dataset.pid);
          const cid = el.dataset.cid ? Number(el.dataset.cid) : null;
          state.clienteId = cid;
          showApp();
          selectProject(pid);
        });
      });
    }
  }

  // Hint text and button label
  let hint = $('#welcomeHint');
  if (!hint) {
    hint = document.createElement('p');
    hint.id = 'welcomeHint';
    hint.className = 'welcome-hint';
    container.insertAdjacentElement('afterend', hint);
  }
  if (multi) {
    hint.textContent = 'Haz clic en una obra para entrar directamente, o usa el botón para ver la galería completa.';
    hint.style.display = '';
    $('#btnWelcomeContinuar').textContent = 'Ver galería de obras →';
  } else {
    hint.style.display = 'none';
    $('#btnWelcomeContinuar').textContent = 'Entrar a la obra →';
  }
}

$('#btnWelcomeContinuar').addEventListener('click', () => {
  if (state.projects.length === 1) {
    showApp();
    selectProject(state.projects[0].id);
  } else {
    showClientGallery();
    renderClientGallery();
  }
});

// ---------------------------------------------------------------------------
// Upload flow
// ---------------------------------------------------------------------------
function promptUpload() {
  const options = state.clientes.map((c) => `<option value="${c.id}" ${c.id === state.clienteId ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('');
  openModal(`
    <h3>Cargar presupuesto</h3>
    <p class="muted">Indica a qué cliente pertenece este presupuesto antes de elegir el archivo Excel.</p>
    <div class="field">
      <label>Cliente</label>
      <select id="uploadClienteSelect">
        <option value="">Selecciona un cliente…</option>
        ${options}
      </select>
    </div>
    <div class="field hidden-initial" id="uploadNuevoClienteField">
      <label>Nombre del nuevo cliente</label>
      <input id="uploadNuevoClienteNombre" placeholder="Ej. VINTE" />
    </div>
    <div class="row end">
      <button class="btn small" type="button" id="btnToggleNuevoCliente">+ Crear cliente nuevo</button>
    </div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelUpload">Cancelar</button>
      <button class="btn btn-primary" id="btnContinuarUpload">Continuar y elegir archivo</button>
    </div>
  `);
  $('#btnCancelUpload').addEventListener('click', closeModal);
  $('#btnToggleNuevoCliente').addEventListener('click', () => {
    const field = $('#uploadNuevoClienteField');
    const nowShowing = field.classList.contains('hidden-initial');
    field.classList.toggle('hidden-initial', !nowShowing);
    $('#uploadClienteSelect').disabled = nowShowing;
    $('#btnToggleNuevoCliente').textContent = nowShowing ? 'Usar cliente existente' : '+ Crear cliente nuevo';
  });
  $('#btnContinuarUpload').addEventListener('click', async () => {
    const btn = $('#btnContinuarUpload');
    const creatingNew = !$('#uploadNuevoClienteField').classList.contains('hidden-initial');
    let clienteId = Number($('#uploadClienteSelect').value) || null;
    btn.disabled = true;
    try {
      if (creatingNew) {
        const nombre = $('#uploadNuevoClienteNombre').value.trim();
        if (!nombre) { toast('Escribe el nombre del cliente nuevo', 'danger'); btn.disabled = false; return; }
        btn.textContent = 'Creando cliente…';
        const nuevo = await api('/clientes', { method: 'POST', body: { nombre } });
        clienteId = nuevo.id;
        await refreshClientList();
      }
      if (!clienteId) { toast('Selecciona o crea un cliente', 'danger'); btn.disabled = false; return; }
      state.pendingUploadClienteId = clienteId;
      closeModal();
      $('#fileInput').click();
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false;
      btn.textContent = 'Continuar y elegir archivo';
    }
  });
}
$('#btnUpload').addEventListener('click', promptUpload);
$('#btnUploadDrawer').addEventListener('click', promptUpload);

// Aviso de "tardando más de lo normal" si la carga no ha terminado después de
// este tiempo — no cancela nada, solo le da al usuario la opción de seguir
// esperando o cancelar en vez de un spinner infinito sin información.
const UPLOAD_SLOW_WARNING_MS = 90 * 1000;

$('#fileInput').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  if (!/\.xlsx$/i.test(file.name)) { toast('Solo se admiten archivos .xlsx', 'danger'); return; }
  const clienteId = state.pendingUploadClienteId;
  state.pendingUploadClienteId = null;
  if (!clienteId) { toast('Selecciona un cliente antes de subir el archivo', 'danger'); return; }

  const controller = new AbortController();
  let cancelled = false;

  const renderUploadModal = ({ slow = false } = {}) => {
    openModal(`
      <h3>Cargando presupuesto…</h3>
      <p class="muted">Subiendo "${esc(file.name)}" y generando una base de datos independiente para este presupuesto.</p>
      <div class="spinner"></div>
      ${slow ? `<div class="alert-box danger upload-slow-warning">⚠️ Esto está tardando más de lo normal (posiblemente tu conexión es lenta). Puedes seguir esperando o cancelar e intentar de nuevo.</div>` : ''}
      <div class="modal-actions">
        ${slow ? '<button class="btn" id="btnSeguirEsperando">Seguir esperando</button>' : ''}
        <button class="btn btn-danger" id="btnCancelarCarga">Cancelar</button>
      </div>
    `);
    // Mientras la carga está en curso, un click fuera del modal no debe poder
    // cerrarlo dejando la subida corriendo "invisible" en segundo plano — igual
    // que el modal de códigos de respaldo TOTP, solo el botón explícito cancela.
    blockOverlayDismiss = true;
    $('#btnCancelarCarga').addEventListener('click', () => { cancelled = true; controller.abort(); closeModal(); });
    $('#btnSeguirEsperando')?.addEventListener('click', () => { renderUploadModal({ slow: false }); armSlowWarning(); });
  };

  let slowTimer = null;
  const armSlowWarning = () => {
    clearTimeout(slowTimer);
    slowTimer = setTimeout(() => renderUploadModal({ slow: true }), UPLOAD_SLOW_WARNING_MS);
  };

  renderUploadModal();
  armSlowWarning();

  try {
    // Sube directo a Vercel Blob desde el navegador (bypassa el límite de
    // tamaño de body de la función serverless — ver Prompts_mod1.md Tarea 1).
    // OJO: no pasar onUploadProgress aquí — activa una rama interna distinta
    // en @vercel/blob (convierte el body a ReadableStream + fetch con
    // duplex:'half') en vez de la ruta simple de fetch() ya probada en
    // producción; en pruebas reales esa rama se quedó colgada en 0% sin
    // completar nunca la subida. abortSignal sí es seguro — solo agrega
    // `signal` al mismo fetch()/XHR que ya se usaba, no cambia el mecanismo.
    const blob = await VercelBlobClient.upload(file.name, file, {
      access: 'private',
      handleUploadUrl: '/api/projects/upload-token',
      headers: state.token ? { Authorization: `Bearer ${state.token}` } : {},
      abortSignal: controller.signal,
    });
    const result = await api('/projects', {
      method: 'POST',
      body: { cliente_id: clienteId, archivo_url: blob.url, archivo_nombre: file.name },
      signal: controller.signal,
    });
    clearTimeout(slowTimer);
    blockOverlayDismiss = false; // libera el bloqueo del modal de carga antes de abrir el siguiente
    state.clienteId = clienteId;
    await Promise.all([refreshClientList(), refreshProjectList()]);
    showApp();
    selectProject(result.id);
    closeDrawer();
    openPostUploadModal(result);
  } catch (err) {
    clearTimeout(slowTimer);
    closeModal();
    if (cancelled || err.name === 'AbortError') {
      toast('Carga cancelada', '');
    } else {
      toast(err.message, 'danger');
    }
  }
});

function destroyCharts() {
  Object.values(state.charts).forEach((c) => c && c.destroy());
  state.charts = {};
}

async function renderView() {
  destroyCharts();
  const view = $('#view');
  if (state.view === 'usuarios' || state.view === 'proveedores' || state.view === 'maquinaria' || state.view === 'nominas_global' || state.view === 'trabajadores_global' || state.view === 'cotizador' || state.view === 'estadoResultadosGlobal') {
    try {
      if (state.view === 'usuarios') { await renderUsuarios(view, state.usuariosSubView); state.usuariosSubView = null; }
      else if (state.view === 'proveedores') await renderProveedores(view);
      else if (state.view === 'nominas_global') await renderNominasGlobal(view);
      else if (state.view === 'trabajadores_global') await renderTrabajadoresGlobal(view);
      else if (state.view === 'cotizador') await renderCotizador(view);
      else if (state.view === 'estadoResultadosGlobal') await renderEstadoResultadosGlobal(view);
      else await renderMaquinaria(view);
    } catch (err) { view.innerHTML = `<div class="alert-box danger">⚠️ ${esc(err.message)}</div>`; }
    syncFab();
    return;
  }
  if (state.view === 'sugerencias') {
    try { await renderSugerencias(view); } catch (err) { view.innerHTML = `<div class="alert-box danger">⚠️ ${esc(err.message)}</div>`; }
    syncFab();
    return;
  }
  if (state.view === 'developer') {
    if (!isDesarrollador()) { view.innerHTML = `<div class="alert-box danger">⚠️ Acceso restringido al rol Desarrollador.</div>`; syncFab(); return; }
    try { await renderDevPanel(view); } catch (err) { view.innerHTML = `<div class="alert-box danger">⚠️ ${esc(err.message)}</div>`; }
    syncFab();
    return;
  }
  if (state.view.endsWith('_gallery')) {
    try { renderSeccionGaleria(view, state.view.replace('_gallery', '')); } catch (err) { view.innerHTML = `<div class="alert-box danger">⚠️ ${esc(err.message)}</div>`; }
    syncFab();
    return;
  }
  if (!state.projectId) {
    const puedeVerAgregado = isAdmin() || state.user?.puesto === 'residente';
    if (typeof state.clienteId === 'number' && puedeVerAgregado) {
      await renderResumenCliente(view);
    } else {
      view.innerHTML = `
        <div class="empty-state">
          <div class="big">🏗️</div>
          <p>No hay un presupuesto seleccionado.</p>
          <p>Carga un archivo Excel de presupuesto (.xlsx) y la app generará automáticamente su catálogo de insumos, alertas de requisición, avances y programa de ejecución — con su propia base de datos independiente.</p>
          ${isAdmin() ? '<button class="btn btn-primary" id="emptyUploadBtn">+ Cargar presupuesto</button>' : ''}
        </div>`;
      $('#emptyUploadBtn')?.addEventListener('click', promptUpload);
    }
    return;
  }
  view.innerHTML = '<div class="spinner"></div>';
  try {
    switch (state.view) {
      case 'resumen':
      case 'inicio': await renderInicio(view); break;
      case 'contrato': await renderContrato(view); break;
      case 'impuestos': await renderImpuestos(view); break;
      case 'insumos': await renderInsumos(view); break;
      case 'requisiciones': await renderRequisiciones(view); break;
      case 'ordenes': await renderOrdenes(view); break;
      case 'avance': await renderAvance(view); break;
      case 'programa': await renderPrograma(view); break;
      case 'destajo': await renderDestajo(view); break;
      case 'finanzas': await renderFinanzas(view); break;
      case 'estadoResultados': await renderEstadoResultados(view); break;
      case 'mapeo': await renderMapeo(view); break;
      case 'trabajadores': await renderTrabajadores(view); break;
      case 'nominas': await renderNominas(view); break;
      case 'estimaciones': await renderEstimaciones(view); break;
      default: view.innerHTML = '';
    }
  } catch (err) {
    view.innerHTML = `<div class="alert-box danger">⚠️ ${esc(err.message)}</div>`;
  }
  syncFab();
}

async function cached(key, loader) {
  const bucket = state.cache[state.projectId];
  if (bucket[key]) return bucket[key];
  const data = await loader();
  bucket[key] = data;
  return data;
}
function invalidate(...keys) {
  const bucket = state.cache[state.projectId];
  if (!bucket) return;
  keys.forEach((k) => delete bucket[k]);
}

// =========================================================================
// VISTA: Galería de subsecciones (prompt-rediseno-navegacion-subsecciones.md,
// Fix B) — piloto solo en las secciones listadas en SECTIONS_WITH_GALLERY.
// Mismo patrón visual .section-card/.section-grid que la galería de
// secciones de nivel superior (seccionesGridHtml, más abajo) — reutilizado
// tal cual, no un sistema nuevo. Respeta state.allowedTabs igual que
// renderTabsBar()/goToSection(): ningún tile aparece si el rol no tiene
// acceso a esa subsección.
// =========================================================================
function renderSeccionGaleria(view, sectionId) {
  const def = SECTION_DEFS[sectionId];
  const tabsPermitidos = def.tabs.filter((t) => state.allowedTabs.includes(t));
  view.innerHTML = `
    <button class="btn seccion-galeria-back" data-goto="inicio">← Secciones</button>
    <h2 class="section-title">${def.emoji} ${esc(def.label)}</h2>
    <p class="muted">Selecciona una subsección para continuar.</p>
    <div class="subseccion-galeria">
    <div class="section-grid">
      ${tabsPermitidos.map((t) => `
        <div class="section-card" data-goto="${t}">
          <span class="section-icon section-icon-lg">${TAB_ICONS[t] || ''}</span>
          <span class="section-nombre">${esc(TAB_LABELS[t])}</span>
        </div>`).join('')}
    </div>
    </div>
  `;
  $$('[data-goto]', view).forEach((btn) => btn.addEventListener('click', () => switchToView(btn.dataset.goto)));
}

// =========================================================================
// VISTA: Resumen
// =========================================================================
// Tarjetas de sección (mismo tratamiento visual que la galería "Selecciona
// un cliente" — ver .section-card/.section-grid en styles.css). Siempre se
// muestran las 5 para cualquier rol que llegue a 'inicio'; goToSection()
// decide si navega, avisa "sin módulos para tu rol" o "próximamente".
function seccionesGridHtml() {
  return `
    <div class="section-grid">
      ${Object.entries(SECTION_DEFS).map(([id, def]) => {
        const esFutura = def.tabs.length === 0;
        // Solo mostrar si el usuario tiene acceso a al menos un tab, o si es sección futura
        const tieneAcceso = esFutura || def.tabs.some((t) => state.allowedTabs.includes(t));
        if (!tieneAcceso) return '';
        return `
        <div class="section-card ${esFutura ? 'disabled' : ''}" data-section="${id}">
          <span class="section-icon section-icon-lg">${def.emoji}</span>
          <span class="section-nombre">${esc(def.label)}</span>
          ${esFutura ? '<span class="section-soon-badge">Próximamente</span>' : ''}
        </div>`;
      }).join('')}
    </div>
  `;
}

// Pantalla de entrada al proyecto: dashboard de Resumen (solo si el rol
// tiene permiso 'resumen' — hoy admin-only, ver server/auth.js) + accesos
// rápidos + las 5 tarjetas de sección. Reemplaza a la barra de tabs plana.
async function renderInicio(view) {
  const puedeVerResumen = state.allowedTabs.includes('resumen');
  let dashboardHtml = '<h2 class="section-title">Inicio</h2>';
  let resumen = null;
  let m = {};

  if (puedeVerResumen) {
    resumen = await cached('resumen', () => api(`/projects/${state.projectId}/resumen`));
    m = resumen.meta || {};
    const ejec = resumen.avance_financiero_ejecutado_actual || 0;
    const prog = resumen.avance_financiero_programado_actual || 0;
    const desviacion = ejec - prog;
    const desvKind = desviacion >= 0 ? 'green' : (desviacion < -10 ? 'red' : 'yellow');
    dashboardHtml = `
      <h2 class="section-title">Resumen del presupuesto</h2>
      <div class="kpi-grid">
        <div class="kpi accent"><div class="label">Presupuesto total (sin IVA)</div><div class="value">${fmtMoney(resumen.presupuesto_total)}</div></div>
        <div class="kpi"><div class="label">Avance programado</div><div class="value">${fmtPct(prog)}</div></div>
        <div class="kpi green"><div class="label">Avance ejecutado</div><div class="value">${fmtPct(ejec)}</div></div>
        <div class="kpi ${desvKind}"><div class="label">Desviación vs. programa</div><div class="value">${desviacion >= 0 ? '+' : ''}${fmtNum(desviacion, 1)} pp</div></div>
      </div>

      <h3 class="section-title">Avance físico-financiero: presupuestado vs ejecutado vs por ejecutar</h3>
      <div class="card"><div class="chart-wrap"><canvas id="chartResumenDona"></canvas></div></div>

      <h3 class="section-title">Datos de la obra</h3>
      ${(() => {
        const finEstado = finObraEstado(m.fin_obra);
        if (!finEstado) return '';
        const msg = finEstado.vencido
          ? `⚠️ El contrato de esta obra venció hace ${Math.abs(finEstado.dias)} día(s) (fin de obra: ${fmtDate(m.fin_obra)}).`
          : `⏳ El contrato de esta obra vence en ${finEstado.dias} día(s) (fin de obra: ${fmtDate(m.fin_obra)}).`;
        return `
        <div class="alert-box ${finEstado.vencido ? 'danger' : 'warn'} mb-12">
          <div class="row between">
            <span>${msg}</span>
            ${isAdmin() ? '<button class="btn small" id="btnActualizarFinObra">Actualizar fecha</button>' : ''}
          </div>
        </div>`;
      })()}
      <div class="card">
        <div class="card-row"><span class="k">Obra</span><span class="v">${esc(m.obra || '—')}</span></div>
        <div class="card-row"><span class="k">Lugar</span><span class="v">${esc(m.lugar || '—')}</span></div>
        <div class="card-row"><span class="k">Inicio de obra</span><span class="v">${fmtDate(m.inicio_obra)}</span></div>
        <div class="card-row"><span class="k">Fin de obra</span><span class="v">${fmtDate(m.fin_obra)}</span></div>
        ${m.fin_obra_actualizado_por ? `<div class="card-row"><span class="k muted fs-078">Última actualización</span><span class="v muted fs-078">${esc(m.fin_obra_actualizado_por)} · ${fmtDateShort(m.fin_obra_actualizado_en)}</span></div>` : ''}
        <div class="card-row"><span class="k">Total sin IVA</span><span class="v">${fmtMoney(resumen.presupuesto_total)}</span></div>
        ${m.total_con_iva ? `<div class="card-row"><span class="k">Total con IVA</span><span class="v">${fmtMoney(m.total_con_iva)}</span></div>` : ''}
        <div class="row end mt-10"><button class="btn small" id="btnEditFechasObra">Corregir inicio/fin de obra</button></div>
        <p class="muted inicio-fechas-note">Úsalo si el archivo traía esas fechas vacías o incorrectas — al guardar se regenera todo el Programa y la curva de Avance con las fechas correctas.</p>
      </div>

      <h3 class="section-title">Requisiciones de compra</h3>
      <div class="kpi-grid">
        <div class="kpi"><div class="label">Requisiciones activas</div><div class="value">${resumen.requisiciones.num_requisiciones}</div></div>
        <div class="kpi"><div class="label">Importe requisitado</div><div class="value">${fmtMoney(resumen.requisiciones.importe_requisitado)}</div></div>
        <div class="kpi ${resumen.requisiciones.alertas_cantidad ? 'red' : 'green'}"><div class="label">Alertas de cantidad</div><div class="value">${resumen.requisiciones.alertas_cantidad}</div></div>
        <div class="kpi ${resumen.requisiciones.alertas_precio ? 'red' : 'green'}"><div class="label">Alertas de precio</div><div class="value">${resumen.requisiciones.alertas_precio}</div></div>
      </div>
    `;
  }

  view.innerHTML = `
    ${puedeVerResumen ? '' : '<h2 class="section-title">Inicio</h2>'}
    <h3 class="section-title">Secciones</h3>
    ${seccionesGridHtml()}
    ${puedeVerResumen ? dashboardHtml : ''}
  `;

  if (puedeVerResumen) {
    const ctx = $('#chartResumenDona').getContext('2d');
    const cc = chartColors();
    state.charts.resumenDona = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Ejecutado', 'Programado por ejecutar (a la fecha)', 'Resto por ejecutar'],
        datasets: [{
          data: [
            resumen.importe_ejecutado,
            Math.max(0, resumen.importe_programado - resumen.importe_ejecutado),
            Math.max(0, resumen.presupuesto_total - Math.max(resumen.importe_programado, resumen.importe_ejecutado)),
          ],
          // 3er segmento ("Resto por ejecutar"): antes '#334155' fijo — ahora
          // cc.grid (--border-color), se funde como "vacío" en cualquier paleta.
          backgroundColor: ['#22c55e', '#eab308', cc.grid],
          // Este donut sí vive dentro de una .card — el borde de cada segmento
          // debe fundirse con --bg-surface (fondo real de la tarjeta), no un
          // hex fijo que solo coincidía con Dorada dark por casualidad.
          borderColor: cc.surface,
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: animationForChart(`resumenDona:${state.projectId}`),
        plugins: {
          legend: { position: 'bottom', labels: { color: cc.text, boxWidth: 14, font: { size: 11 } } },
          tooltip: { callbacks: { label: (c) => `${c.label}: ${fmtMoney(c.raw)}` } },
        },
      },
    });
    state.charts.resumenDona._cpBorderSurface = 'surface';
    state.charts.resumenDona._cpGridBgIndexes = [2]; // 'Resto por ejecutar' (índice 2 en backgroundColor)
    $('#btnEditFechasObra').addEventListener('click', () => openEditFechasObraModal(m));
    $('#btnActualizarFinObra')?.addEventListener('click', () => openQuickFinObraModal(m));
  }

  $$('.section-card', view).forEach((el) => el.addEventListener('click', () => goToSection(el.dataset.section)));
  $$('[data-goto]', view).forEach((btn) => btn.addEventListener('click', () => switchToView(btn.dataset.goto)));
}

function openEditFechasObraModal(meta) {
  openModal(`
    <h3>Corregir inicio/fin de obra</h3>
    <p class="muted">Si el archivo Excel traía estas fechas vacías o copiadas de otro presupuesto, corrígelas aquí. Al guardar se regenera todo el Programa de ejecución y la curva de Avance con las fechas correctas.</p>
    <div class="field"><label>Fecha de inicio de obra</label><input id="editObraInicio" type="date" value="${esc(meta.inicio_obra || '')}" /></div>
    <div class="field"><label>Fecha de fin de obra</label><input id="editObraFin" type="date" value="${esc(meta.fin_obra || '')}" /></div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelObraFechas">Cerrar</button>
      <button class="btn btn-primary" id="btnSaveObraFechas">Guardar y regenerar</button>
    </div>
  `);
  $('#btnCancelObraFechas').addEventListener('click', closeModal);
  $('#btnSaveObraFechas').addEventListener('click', async () => {
    const btn = $('#btnSaveObraFechas');
    const inicio_obra = $('#editObraInicio').value;
    const fin_obra = $('#editObraFin').value;
    if (!inicio_obra || !fin_obra) { toast('Indica ambas fechas', 'danger'); return; }
    btn.disabled = true; btn.textContent = 'Guardando…';
    try {
      await api(`/projects/${state.projectId}/fechas-obra`, { method: 'PUT', body: { inicio_obra, fin_obra } });
      closeModal();
      invalidate('resumen');
      toast('Fechas de obra corregidas: Programa y Avance regenerados', 'success');
      renderView();
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false; btn.textContent = 'Guardar y regenerar';
    }
  });
}

// Edición rápida de solo fin_obra (ej. "cambio de SIROC" que amplía el
// contrato) — a propósito NO usa /fechas-obra: ese endpoint regenera todo
// el Programa/Avance y se bloquea si ya hay avance real capturado, que es
// justo el caso normal de una obra que necesita extender su fecha a medio
// proyecto. Este modal solo actualiza la fecha de fin, sin tocar el programa.
function openQuickFinObraModal(meta) {
  openModal(`
    <h3>Actualizar fecha de fin de obra</h3>
    <p class="muted">Para cuando el cliente amplía el contrato (ej. cambio de SIROC). Esto solo actualiza la fecha registrada — no regenera el Programa de ejecución ni la curva de Avance.</p>
    <div class="field"><label>Nueva fecha de fin de obra</label><input id="quickFinObraFecha" type="date" value="${esc(meta.fin_obra || '')}" /></div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelQuickFinObra">Cerrar</button>
      <button class="btn btn-primary" id="btnSaveQuickFinObra">Guardar</button>
    </div>
  `);
  $('#btnCancelQuickFinObra').addEventListener('click', closeModal);
  $('#btnSaveQuickFinObra').addEventListener('click', async () => {
    const btn = $('#btnSaveQuickFinObra');
    const fin_obra = $('#quickFinObraFecha').value;
    if (!fin_obra) { toast('Indica la nueva fecha', 'danger'); return; }
    btn.disabled = true; btn.textContent = 'Guardando…';
    try {
      await api(`/projects/${state.projectId}/fin-obra`, { method: 'PUT', body: { fin_obra } });
      closeModal();
      invalidate('resumen');
      await refreshProjectList();
      toast('Fecha de fin de obra actualizada', 'success');
      renderView();
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false; btn.textContent = 'Guardar';
    }
  });
}

// =========================================================================
// VISTA: Resumen financiero agregado del cliente (admin/residente)
// =========================================================================
async function renderResumenCliente(view) {
  view.innerHTML = '<div class="spinner"></div>';
  let data;
  try {
    data = await api(`/clientes/${state.clienteId}/resumen-agregado`);
  } catch (err) {
    view.innerHTML = `<div class="alert-box danger">⚠️ ${esc(err.message)}</div>`;
    return;
  }
  const { proyectos, total_contratos, importe_ejecutado, importe_por_ejecutar, avance_ponderado_pct } = data;

  view.innerHTML = `
    <h2 class="section-title"><span class="cliente-nombre">${esc(data.cliente.nombre)}</span> — Resumen financiero</h2>
    <div class="kpi-grid">
      <div class="kpi accent"><div class="label">Total contratos</div><div class="value">${fmtMoney(total_contratos)}</div></div>
      <div class="kpi green"><div class="label">Avance general</div><div class="value">${fmtPct(avance_ponderado_pct)}</div></div>
      <div class="kpi"><div class="label">Importe ejecutado</div><div class="value">${fmtMoney(importe_ejecutado)}</div></div>
      <div class="kpi yellow"><div class="label">Por ejecutar</div><div class="value">${fmtMoney(importe_por_ejecutar)}</div></div>
    </div>

    <div class="row between presupuestos-header">
      <div>
        <h3 class="section-title presupuestos-title">Presupuestos</h3>
        ${proyectos.length ? '<p class="muted presupuestos-guia">Selecciona un presupuesto para ver el detalle.</p>' : ''}
      </div>
      ${proyectos.length ? `
      <div class="presupuesto-view-toggle" role="group" aria-label="Vista de presupuestos">
        <button class="icon-btn presupuesto-view-opt" data-presupuesto-view="list" aria-label="Vista de lista" title="Vista de lista">${icon('list', 16)}</button>
        <button class="icon-btn presupuesto-view-opt" data-presupuesto-view="grid" aria-label="Vista de cuadrícula" title="Vista de cuadrícula">${icon('layout-grid', 16)}</button>
      </div>` : ''}
    </div>
    <div id="resumenClienteProyectos">
      ${proyectos.map((p) => `
        <div class="card proyecto-resumen-card" data-pid="${p.id}">
          <div class="card-row">
            <span class="k">${esc(p.nombre)}</span>
            <span class="v"><span class="badge ${p.avance_ejecutado_pct >= 80 ? 'green' : p.avance_ejecutado_pct >= 40 ? 'yellow' : 'muted'}">${fmtPct(p.avance_ejecutado_pct)}</span></span>
          </div>
          <div class="progress-bar"><span data-pct="${Math.min(100, p.avance_ejecutado_pct)}"></span></div>
          <div class="card-row"><span class="k">Contrato</span><span class="v">${fmtMoney(p.presupuesto_total)}</span></div>
          <div class="card-row"><span class="k">Ejecutado</span><span class="v">${fmtMoney(p.importe_ejecutado)}</span></div>
          <div class="card-row"><span class="k">Por ejecutar</span><span class="v">${fmtMoney(p.importe_por_ejecutar)}</span></div>
        </div>
      `).join('')}
      ${proyectos.length === 0 ? '<div class="empty-state"><div class="big">📊</div>Sin presupuestos en este cliente.</div>' : ''}
    </div>
  `;

  // El width del progress-bar se asigna por propiedad JS (inmune a CSP), no como
  // parte del string de innerHTML (bloqueado por style-src). Ver .hidden-initial
  // en styles.css para el mismo patrón aplicado a los toggles de visibilidad.
  $$('.proyecto-resumen-card .progress-bar > span', view).forEach((span) => {
    span.style.width = span.dataset.pct + '%';
  });

  $$('.proyecto-resumen-card', view).forEach((card) => {
    card.addEventListener('click', () => selectProject(Number(card.dataset.pid)));
  });

  $$('.presupuesto-view-opt', view).forEach((btn) => {
    btn.addEventListener('click', () => setPresupuestoViewMode(btn.dataset.presupuestoView));
  });
  setPresupuestoViewMode(getPresupuestoViewMode());
}

// =========================================================================
// VISTA: Contrato — carga de PDF con extracción vía Claude API (server/
// extraccionContrato.js) hacia un formulario editable. Dos puntos de entrada:
// promptUploadContrato() desde la galería de clientes (crea obra nueva) y
// promptAttachContrato() desde dentro de una obra existente (solo adjunta/
// actualiza sus datos de contrato, nunca crea un proyecto duplicado).
// =========================================================================
const CONTRATO_FIELDS = [
  { key: 'proyecto_desarrollo', label: 'Proyecto / Desarrollo', inputType: 'text', format: 'text' },
  { key: 'obra_numero', label: 'Número de obra', inputType: 'text', format: 'text' },
  { key: 'obra_descripcion', label: 'Descripción de la obra', inputType: 'text', format: 'text' },
  { key: 'empresa_contratante', label: 'Empresa contratante', inputType: 'text', format: 'text' },
  { key: 'contratista_nombre', label: 'Nombre del contratista', inputType: 'text', format: 'text' },
  { key: 'contratista_rfc', label: 'RFC del contratista', inputType: 'text', format: 'text' },
  { key: 'contratista_domicilio', label: 'Domicilio del contratista', inputType: 'text', format: 'text' },
  { key: 'contratista_telefono', label: 'Teléfono del contratista', inputType: 'text', format: 'text' },
  { key: 'fecha_documento', label: 'Fecha del documento', inputType: 'date', format: 'date' },
  { key: 'fecha_inicio', label: 'Fecha de inicio', inputType: 'date', format: 'date' },
  { key: 'fecha_termino', label: 'Fecha de término', inputType: 'date', format: 'date' },
  { key: 'tipo_contrato', label: 'Tipo de contrato', inputType: 'text', format: 'text' },
  { key: 'subtotal_materiales', label: 'Subtotal materiales', inputType: 'number', format: 'money' },
  { key: 'subtotal_mano_obra', label: 'Subtotal mano de obra', inputType: 'number', format: 'money' },
  { key: 'subtotal_carga_social', label: 'Subtotal carga social', inputType: 'number', format: 'money' },
  { key: 'subtotal_herramienta_equipo', label: 'Subtotal herramienta y equipo', inputType: 'number', format: 'money' },
  { key: 'subtotal_costo_directo', label: 'Subtotal costo directo', inputType: 'number', format: 'money' },
  { key: 'indirecto_utilidad', label: 'Indirecto y utilidad', inputType: 'number', format: 'money' },
  { key: 'importe_contratado', label: 'Importe contratado', inputType: 'number', format: 'money' },
  { key: 'iva_monto', label: 'IVA', inputType: 'number', format: 'money' },
  { key: 'total_contratado', label: 'Total contratado', inputType: 'number', format: 'money' },
  { key: 'anticipo_monto', label: 'Anticipo', inputType: 'number', format: 'money' },
  { key: 'fondo_garantia_monto', label: 'Fondo de garantía', inputType: 'number', format: 'money' },
  { key: 'volumen_contratado', label: 'Volumen contratado', inputType: 'number', format: 'number' },
  { key: 'volumen_unidad', label: 'Unidad de volumen', inputType: 'text', format: 'text' },
];

// fecha_inicio/fecha_termino viven en las claves ya existentes inicio_obra/
// fin_obra (las lee también la pestaña Resumen); el resto de campos usa su
// propio nombre de clave en `meta`.
function metaToCamposContrato(meta) {
  const campos = {};
  for (const f of CONTRATO_FIELDS) {
    if (f.key === 'fecha_inicio') campos[f.key] = meta.inicio_obra || null;
    else if (f.key === 'fecha_termino') campos[f.key] = meta.fin_obra || null;
    else campos[f.key] = meta[f.key] != null ? meta[f.key] : null;
  }
  return campos;
}

// Se excluyen fecha_inicio/fecha_termino porque esas claves ya existen en
// obras cargadas por Excel sin que eso signifique que tengan un contrato.
function tieneContrato(meta) {
  return CONTRATO_FIELDS.some((f) => {
    if (f.key === 'fecha_inicio' || f.key === 'fecha_termino') return false;
    return meta[f.key] != null && meta[f.key] !== '';
  });
}

function formatContratoValor(field, value) {
  if (value == null || value === '') return '—';
  if (field.format === 'date') return fmtDate(value);
  if (field.format === 'money') return fmtMoney(value);
  if (field.format === 'number') return fmtNum(value);
  return esc(value);
}

// Mismo cálculo que server/alertasContrato.js#calcularDiasRestantes (fecha
// 'YYYY-MM-DD' normalizada a medianoche UTC) — puramente de despliegue, no
// depende de si ya se envió alguna alerta.
function calcularDiasRestantesFrontend(finObraIso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(finObraIso || '');
  if (!match) return null;
  const fin = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const ahora = new Date();
  const hoy = Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate());
  return Math.round((fin - hoy) / 86400000);
}

function vencimientoBadgeHtml(finObraIso) {
  const dias = calcularDiasRestantesFrontend(finObraIso);
  if (dias == null || dias > 30) return '';
  const texto = dias < 0
    ? `Venció hace ${Math.abs(dias)} día${Math.abs(dias) === 1 ? '' : 's'}`
    : dias === 0 ? 'Vence hoy' : `Vence en ${dias} día${dias === 1 ? '' : 's'}`;
  const kind = dias <= 7 ? 'red' : 'yellow';
  return ` <span class="badge ${kind}">${esc(texto)}</span>`;
}

// Punto de entrada (a): galería de clientes → crea una obra nueva a partir del PDF
function promptUploadContrato() {
  const options = state.clientes.map((c) => `<option value="${c.id}" ${c.id === state.clienteId ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('');
  openModal(`
    <h3>Cargar Contrato PDF</h3>
    <p class="muted">Se creará una obra nueva a partir de los datos del contrato. Indica a qué cliente pertenece antes de elegir el PDF.</p>
    <div class="field"><label>Cliente</label>
      <select id="contratoClienteSelect"><option value="">Selecciona un cliente…</option>${options}</select>
    </div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelContratoUpload">Cancelar</button>
      <button class="btn btn-primary" id="btnContinuarContratoUpload">Continuar y elegir PDF</button>
    </div>
  `);
  $('#btnCancelContratoUpload').addEventListener('click', closeModal);
  $('#btnContinuarContratoUpload').addEventListener('click', () => {
    const clienteId = Number($('#contratoClienteSelect').value) || null;
    if (!clienteId) { toast('Selecciona un cliente', 'danger'); return; }
    state.pendingContrato = { mode: 'create', clienteId };
    closeModal();
    $('#pdfFileInput').click();
  });
}
// Punto de entrada (b): dentro de una obra ya existente → adjunta/actualiza sin crear duplicado
function promptAttachContrato() {
  state.pendingContrato = { mode: 'attach', projectId: state.projectId };
  $('#pdfFileInput').click();
}

$('#pdfFileInput').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  if (!/\.pdf$/i.test(file.name)) { toast('Solo se admiten archivos .pdf', 'danger'); return; }
  const ctx = state.pendingContrato;
  state.pendingContrato = null;
  if (!ctx) return;
  ctx.fileName = file.name;

  openModal(`
    <h3>Analizando contrato…</h3>
    <p class="muted">Extrayendo los datos de "${esc(file.name)}" con IA. Esto puede tardar unos segundos.</p>
    <div class="spinner"></div>
  `);
  try {
    const fd = new FormData();
    fd.append('pdf', file);
    const preview = await api('/projects/contrato-preview', { method: 'POST', body: fd });
    openContratoFormModal(preview, ctx);
  } catch (err) {
    closeModal();
    toast(err.message, 'danger');
  }
});

function openContratoFormModal(preview, ctx) {
  const campos = preview.campos || {};
  const escaneado = !!preview.escaneado;
  const blobUrl = preview.blob_url || null;
  const blobNombre = preview.blob_nombre || null;

  const fieldsHtml = CONTRATO_FIELDS.map((f) => {
    const value = campos[f.key];
    const isNull = value == null || value === '';
    return `
      <div class="field ${isNull ? 'field-null' : ''}">
        <label>${esc(f.label)}</label>
        <input type="${f.inputType}" id="contrato_${f.key}" ${f.inputType === 'number' ? 'step="any"' : ''} value="${esc(value ?? '')}" />
      </div>
    `;
  }).join('');

  const nombreSugerido = (campos.obra_descripcion || campos.proyecto_desarrollo || '').toString().trim();
  const clienteHtml = ctx.mode === 'create'
    ? `<div class="field">
        <label>Nombre de la obra</label>
        <input id="contratoNombreInput" value="${esc(nombreSugerido)}" placeholder="Ej. Torre A — Redes Altares" />
      </div>
      <div class="field"><label>Cliente</label>
        <select id="contratoFormCliente">${state.clientes.map((c) => `<option value="${c.id}" ${c.id === ctx.clienteId ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('')}</select>
      </div>`
    : `<p class="muted">Se guardará en la obra: <strong>${esc((state.projects.find((p) => p.id === ctx.projectId) || {}).nombre || '')}</strong></p>`;

  openModal(`
    <h3>Datos del contrato</h3>
    ${escaneado
      ? `<div class="alert-box danger">⚠️ Este PDF parece ser una imagen escaneada sin texto extraíble. Captura los datos manualmente.</div>`
      : '<p class="muted">Revisa y corrige los datos extraídos antes de guardar. Los campos con borde amarillo no se detectaron en el documento.</p>'}
    ${clienteHtml}
    ${fieldsHtml}
    <div class="modal-actions">
      <button class="btn" id="btnCancelContratoForm">Cancelar</button>
      <button class="btn btn-primary" id="btnSaveContratoForm">Confirmar</button>
    </div>
  `);

  $('#btnCancelContratoForm').addEventListener('click', closeModal);
  $('#btnSaveContratoForm').addEventListener('click', async () => {
    const btn = $('#btnSaveContratoForm');
    const body = {};
    CONTRATO_FIELDS.forEach((f) => {
      const el = $(`#contrato_${f.key}`);
      body[f.key] = el.value.trim() === '' ? null : el.value;
    });
    let clienteIdElegido = null;
    if (ctx.mode === 'create') {
      clienteIdElegido = Number($('#contratoFormCliente').value);
      if (!clienteIdElegido) { toast('Selecciona un cliente', 'danger'); return; }
      body.cliente_id = clienteIdElegido;
      body.archivo_original = ctx.fileName || null;
      const nombreInput = $('#contratoNombreInput');
      if (nombreInput?.value.trim()) body.nombre = nombreInput.value.trim();
    } else {
      body.project_id = ctx.projectId;
    }
    if (blobUrl) { body.blob_url = blobUrl; body.blob_nombre = blobNombre; }
    btn.disabled = true; btn.textContent = 'Guardando…';
    try {
      const result = await api('/projects/contrato-confirm', { method: 'POST', body });
      closeModal();
      if (clienteIdElegido) state.clienteId = clienteIdElegido;
      await Promise.all([refreshClientList(), refreshProjectList()]);
      showApp();
      invalidate('resumen');
      selectProject(result.project_id);
      switchToView('contrato');
      closeDrawer();
      toast('Contrato guardado', 'success');
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false; btn.textContent = 'Confirmar';
    }
  });
}

async function renderContrato(view) {
  const resumen = await cached('resumen', () => api(`/projects/${state.projectId}/resumen`));
  const meta = resumen.meta || {};
  const tienePdf = !!resumen.tiene_contrato_pdf;

  if (!tieneContrato(meta)) {
    view.innerHTML = `
      <h2 class="section-title">Contrato</h2>
      <div class="empty-state">
        <div class="big">📄</div>
        <p>Esta obra aún no tiene un contrato cargado.</p>
        ${isAdmin() ? '<button class="btn btn-primary" id="btnCargarContratoTab">Cargar PDF de contrato</button>' : ''}
      </div>
    `;
    $('#btnCargarContratoTab')?.addEventListener('click', promptAttachContrato);
    return;
  }

  const campos = metaToCamposContrato(meta);
  view.innerHTML = `
    <h2 class="section-title">Contrato</h2>
    ${tienePdf ? `
    <div class="row mb-12-gap8">
      <a id="btnVerPdfContrato" href="/api/projects/${state.projectId}/contrato/pdf" target="_blank" rel="noopener" class="btn btn-primary btn-icon-inline">${icon('contrato', 15)} Ver PDF original</a>
      ${isAdmin() ? `<button class="btn" id="btnReemplazarContratoTab">Reemplazar PDF</button>` : ''}
    </div>` : (isAdmin() ? `<div class="mb-12"><button class="btn" id="btnCargarContratoTab2">Adjuntar PDF del contrato</button></div>` : '')}
    <div class="card">
      ${CONTRATO_FIELDS.map((f) => {
        const badge = f.key === 'fecha_termino' ? vencimientoBadgeHtml(campos.fecha_termino) : '';
        return `<div class="card-row"><span class="k">${esc(f.label)}</span><span class="v">${formatContratoValor(f, campos[f.key])}${badge}</span></div>`;
      }).join('')}
    </div>
    ${isAdmin() ? '<div class="row end mt-10"><button class="btn" id="btnEditarContrato">Editar datos</button></div>' : ''}
  `;
  $('#btnEditarContrato')?.addEventListener('click', () => {
    openContratoFormModal({ escaneado: false, campos }, { mode: 'attach', projectId: state.projectId });
  });
  $('#btnReemplazarContratoTab')?.addEventListener('click', promptAttachContrato);
  $('#btnCargarContratoTab2')?.addEventListener('click', promptAttachContrato);
}

// =========================================================================
// VISTA: Impuestos (IMSS/SAT/INFONAVIT) — aplica a TODAS las obras por
// igual, sin relación con Contrato. Los periodos 'pendiente' los crea el
// cron mensual (server/app.js → POST /api/cron/recordatorio-impuestos);
// aquí solo se consultan y se capturan/corrigen.
// =========================================================================
const MES_NOMBRES = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

async function renderImpuestos(view) {
  const [periodos, resumen] = await Promise.all([
    cached('impuestos', () => api(`/projects/${state.projectId}/impuestos`)),
    cached('impuestosResumen', () => api(`/projects/${state.projectId}/impuestos/resumen`)),
  ]);

  view.innerHTML = `
    <h2 class="section-title">Impuestos (IMSS / SAT / INFONAVIT)</h2>
    <div class="kpi-grid">
      <div class="kpi green"><div class="label">Acumulado pagado</div><div class="value">${fmtMoney(resumen.acumulado_pagado.total)}</div></div>
      <div class="kpi ${resumen.pendiente_actual.total > 0 ? 'red' : 'green'}"><div class="label">Pendiente actual</div><div class="value">${fmtMoney(resumen.pendiente_actual.total)}</div></div>
    </div>
    <div class="card">
      <div class="card-row"><span class="k">IMSS pagado</span><span class="v">${fmtMoney(resumen.acumulado_pagado.imss)}</span></div>
      <div class="card-row"><span class="k">SAT pagado</span><span class="v">${fmtMoney(resumen.acumulado_pagado.sat)}</span></div>
      <div class="card-row"><span class="k">INFONAVIT pagado</span><span class="v">${fmtMoney(resumen.acumulado_pagado.infonavit)}</span></div>
    </div>

    <h3 class="section-title">Periodos</h3>
    ${!periodos.length ? `<div class="empty-state"><div class="big">🧾</div>Aún no hay periodos de impuestos para esta obra.<br>Se crean automáticamente el día 17 de cada mes.</div>` : `
    <div class="card">
      <div class="table-scroll">
        <table>
          <thead><tr><th>Periodo</th><th class="num">IMSS</th><th class="num">SAT</th><th class="num">INFONAVIT</th><th>Estado</th></tr></thead>
          <tbody id="impuestosTbody"></tbody>
        </table>
      </div>
    </div>`}
  `;

  if (!periodos.length) return;

  $('#impuestosTbody').innerHTML = periodos.map((p) => `
    <tr class="row-click ${p.estado === 'pendiente' ? 'row-pendiente' : ''}" data-periodo="${p.id}">
      <td>${esc(MES_NOMBRES[p.periodo_mes])} ${p.periodo_anio}</td>
      <td class="num">${fmtMoney(p.imss_monto)}</td>
      <td class="num">${fmtMoney(p.sat_monto)}</td>
      <td class="num">${fmtMoney(p.infonavit_monto)}</td>
      <td><span class="badge ${p.estado === 'cargado' ? 'green' : 'yellow'}">${esc(p.estado)}</span></td>
    </tr>
  `).join('');

  $$('#impuestosTbody tr').forEach((tr) => {
    tr.addEventListener('click', () => {
      const periodo = periodos.find((p) => p.id === Number(tr.dataset.periodo));
      if (periodo) openImpuestoPeriodoModal(periodo);
    });
  });
}

function openImpuestoPeriodoModal(periodo) {
  openModal(`
    <h3>${esc(MES_NOMBRES[periodo.periodo_mes])} ${periodo.periodo_anio}</h3>
    <p class="muted">Captura o corrige el monto y la referencia (folio o nombre del comprobante escrito a mano) de cada concepto.</p>
    <div class="field"><label>IMSS — monto</label><input type="number" step="any" id="imp_imss_monto" value="${periodo.imss_monto ?? ''}" /></div>
    <div class="field"><label>IMSS — referencia</label><input id="imp_imss_referencia" value="${esc(periodo.imss_referencia || '')}" /></div>
    <div class="field"><label>SAT — monto</label><input type="number" step="any" id="imp_sat_monto" value="${periodo.sat_monto ?? ''}" /></div>
    <div class="field"><label>SAT — referencia</label><input id="imp_sat_referencia" value="${esc(periodo.sat_referencia || '')}" /></div>
    <div class="field"><label>INFONAVIT — monto</label><input type="number" step="any" id="imp_infonavit_monto" value="${periodo.infonavit_monto ?? ''}" /></div>
    <div class="field"><label>INFONAVIT — referencia</label><input id="imp_infonavit_referencia" value="${esc(periodo.infonavit_referencia || '')}" /></div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelImpuesto">Cancelar</button>
      <button class="btn btn-primary" id="btnSaveImpuesto">Guardar</button>
    </div>
  `);
  $('#btnCancelImpuesto').addEventListener('click', closeModal);
  $('#btnSaveImpuesto').addEventListener('click', async () => {
    const btn = $('#btnSaveImpuesto');
    const body = {
      imss_monto: $('#imp_imss_monto').value === '' ? null : Number($('#imp_imss_monto').value),
      imss_referencia: $('#imp_imss_referencia').value.trim() || null,
      sat_monto: $('#imp_sat_monto').value === '' ? null : Number($('#imp_sat_monto').value),
      sat_referencia: $('#imp_sat_referencia').value.trim() || null,
      infonavit_monto: $('#imp_infonavit_monto').value === '' ? null : Number($('#imp_infonavit_monto').value),
      infonavit_referencia: $('#imp_infonavit_referencia').value.trim() || null,
    };
    btn.disabled = true; btn.textContent = 'Guardando…';
    try {
      await api(`/projects/${state.projectId}/impuestos/${periodo.id}/cargar`, { method: 'POST', body });
      closeModal();
      invalidate('impuestos', 'impuestosResumen');
      renderView();
      toast('Periodo actualizado', 'success');
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false; btn.textContent = 'Guardar';
    }
  });
}

// =========================================================================
// VISTA: Catálogo de insumos
// =========================================================================
let insumosFilter = { categoria: '', q: '' };

async function renderInsumos(view) {
  const [insumos, categorias] = await Promise.all([
    api(`/projects/${state.projectId}/insumos${queryString(insumosFilter)}`),
    cached('categorias', () => api(`/projects/${state.projectId}/insumos/categorias`)),
  ]);

  view.innerHTML = `
    <h2 class="section-title">Catálogo de insumos</h2>
    <p class="muted">Cantidades y precios presupuestados por insumo. Las barras y etiquetas muestran lo ya requisitado contra lo presupuestado.</p>
    <div class="section-actions">
      <button class="btn" id="btnExportInsumos">⭳ Exportar a Excel</button>
    </div>
    <div class="sticky-filters">
      <div class="search-bar">
        <input type="search" id="insumoSearch" placeholder="Buscar por código o nombre…" value="${esc(insumosFilter.q)}" />
      </div>
      <div class="chip-row" id="catChips">
        <button class="chip ${!insumosFilter.categoria ? 'active' : ''}" data-cat="">Todos</button>
        ${categorias.map((c) => `<button class="chip ${insumosFilter.categoria === c ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
      </div>
    </div>
    <div id="insumoList"></div>
  `;

  wireExportButton('#btnExportInsumos', `/projects/${state.projectId}/insumos/export${queryString(insumosFilter)}`);

  $('#insumoSearch').addEventListener('input', debounce((e) => {
    insumosFilter.q = e.target.value.trim();
    renderInsumosList();
  }, 280));
  $$('#catChips .chip').forEach((chip) => chip.addEventListener('click', () => {
    insumosFilter.categoria = chip.dataset.cat;
    renderInsumos(view);
  }));

  function renderInsumosList() {
    api(`/projects/${state.projectId}/insumos${queryString(insumosFilter)}`).then(paintInsumos).catch((e) => toast(e.message, 'danger'));
  }
  paintInsumos(insumos);
}

function paintInsumos(insumos) {
  const list = $('#insumoList');
  if (!list) return;
  if (!insumos.length) {
    list.innerHTML = '<div class="empty-state">No se encontraron insumos con ese filtro.</div>';
    return;
  }
  list.innerHTML = insumos.map((i) => {
    const pct = i.cantidad_presupuesto > 0 ? Math.min(150, (i.cantidad_acumulada / i.cantidad_presupuesto) * 100) : 0;
    const over = i.sobrepasado_cantidad;
    return `
    <div class="card insumo-card">
      <div class="row between">
        <div>
          <div class="title">${esc(i.concepto)}</div>
          <div class="code">${esc(i.codigo)} · ${esc(i.unidad || '')} ${i.categoria ? `· ${esc(i.categoria)}` : ''}</div>
        </div>
        ${over ? `<span class="badge red">⚠ excede</span>` : ''}
      </div>
      <div class="row between">
        <span class="muted">Presupuestado</span>
        <span>${fmtNum(i.cantidad_presupuesto, 3)} ${esc(i.unidad || '')}${puedeVerPrecios() && i.precio_presupuesto != null ? ` &nbsp;·&nbsp; ${fmtMoney(i.precio_presupuesto)}/u` : ''}</span>
      </div>
      <div class="row between">
        <span class="muted">Requisitado a la fecha</span>
        <span class="${over ? 'badge red' : ''}">${fmtNum(i.cantidad_acumulada, 3)} ${esc(i.unidad || '')} (${fmtPct(pct)})</span>
      </div>
      <div class="progress-bar ${over ? 'over' : ''}"><span data-pct="${Math.min(100, pct)}"></span></div>
      ${isAdmin() ? `
      <div class="row between mt-6">
        <span class="muted fs-078">IVA aplicable</span>
        <span class="inline-gap4">
          <input type="number" min="0" max="100" step="0.01" value="${i.iva_tasa}" data-iva-input="${i.id}" class="w-64-right" />
          <span class="muted fs-078">%</span>
        </span>
      </div>` : ''}
      ${puedeCrearRequisicion() ? `<div class="row end"><button class="btn small btn-primary" data-add="${i.id}">+ Agregar a requisición</button></div>` : ''}
    </div>`;
  }).join('');

  $$('.progress-bar > span[data-pct]', list).forEach((span) => { span.style.width = span.dataset.pct + '%'; });

  $$('[data-add]', list).forEach((btn) => btn.addEventListener('click', () => addToDraft(Number(btn.dataset.add), insumos)));

  $$('[data-iva-input]', list).forEach((inp) => {
    inp.addEventListener('blur', async () => {
      const insumoId = Number(inp.dataset.ivaInput);
      const ivaTasa = Number(inp.value);
      if (!Number.isFinite(ivaTasa) || ivaTasa < 0 || ivaTasa > 100) { toast('IVA debe ser un número entre 0 y 100', 'danger'); return; }
      try {
        await api(`/projects/${state.projectId}/insumos/${insumoId}`, { method: 'PUT', body: { iva_tasa: ivaTasa } });
        toast('IVA del insumo actualizado', 'success');
      } catch (err) { toast(err.message, 'danger'); }
    });
  });
}

function queryString(obj) {
  const parts = Object.entries(obj).filter(([, v]) => v).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Espejo en el cliente de computeIvaBreakdown (server/app.js) para la vista
// previa en vivo al capturar una Orden de Compra — items: [{importe, iva_tasa}]
function ivaBreakdown(items, incluyeIva) {
  let subtotal = 0;
  let iva = 0;
  for (const it of items) {
    const importe = Number(it.importe) || 0;
    const tasa = Number(it.iva_tasa || 16) / 100;
    if (incluyeIva) {
      const sub = importe / (1 + tasa);
      subtotal += sub;
      iva += importe - sub;
    } else {
      subtotal += importe;
      iva += importe * tasa;
    }
  }
  return { subtotal, iva, total: subtotal + iva };
}

// =========================================================================
// VISTA: Mapeo de conceptos → insumos (solo admin)
// Infraestructura de captura para un futuro bloqueo de avance — todavía no
// bloquea nada, solo permite ir poblando la relación concepto ↔ insumo.
// =========================================================================
let mapeoSelectedConceptoId = null;

async function renderMapeo(view) {
  if (!puedeGestionarUsuarios()) {
    view.innerHTML = `<div class="alert-box danger">⚠️ No tienes permiso para ver esta sección.</div>`;
    return;
  }
  const [conceptos, resumen] = await Promise.all([
    api(`/projects/${state.projectId}/conceptos`),
    api(`/projects/${state.projectId}/concepto-insumos/resumen`),
  ]);
  const conceptosReales = conceptos.filter((c) => !c.es_total);
  const mapeadosSet = new Set(resumen.concepto_ids_mapeados);

  if (mapeoSelectedConceptoId && !conceptosReales.find((c) => c.id === mapeoSelectedConceptoId)) {
    mapeoSelectedConceptoId = null;
  }
  if (!mapeoSelectedConceptoId && conceptosReales.length) mapeoSelectedConceptoId = conceptosReales[0].id;

  const pct = resumen.total_conceptos ? (resumen.conceptos_mapeados / resumen.total_conceptos) * 100 : 0;

  view.innerHTML = `
    <h2 class="section-title">Mapeo de conceptos → insumos</h2>
    <p class="muted">Vincula cada concepto del presupuesto con los insumos (materiales/equipo) que lo componen. Esto es solo la captura del mapeo — todavía no afecta la captura de Avance.</p>
    <div class="card">
      <div class="row between">
        <strong>Presupuesto ${renderHelpBtn('actualizarPresupuesto')}</strong>
        <button class="btn" id="btnActualizarPresupuesto">Actualizar presupuesto (preservando avance)</button>
      </div>
      <p class="muted fs-08 mt-4">Recarga un Excel de presupuesto nuevo sobre esta obra sin perder el avance ya capturado — empareja conceptos por código/descripción, revalúa el avance de los que emparejan, agrega los nuevos, y marca como históricos los que ya no aparezcan.</p>
    </div>
    <div class="card">
      <div class="row between">
        <strong>Progreso de mapeo</strong>
        <span class="badge ${resumen.conceptos_mapeados === resumen.total_conceptos ? 'green' : 'yellow'}">${resumen.conceptos_mapeados}/${resumen.total_conceptos} conceptos mapeados</span>
      </div>
      <div class="progress-bar"><span data-pct="${Math.min(100, pct)}"></span></div>
    </div>
    <div class="card">
      <label>Concepto</label>
      <select id="mapeoConceptoSelect">
        ${conceptosReales.map((c) => `<option value="${c.id}" ${c.id === mapeoSelectedConceptoId ? 'selected' : ''}>${mapeadosSet.has(c.id) ? '✅' : '⬜'} ${esc(c.codigo || '')} — ${esc(c.concepto)}</option>`).join('')}
      </select>
    </div>
    <div class="card">
      <strong>Insumos vinculados</strong>
      <div id="mapeoLinkedList" class="mt-8">
        <div class="spinner"></div>
      </div>
    </div>
    <div class="card">
      <strong>Vincular un insumo</strong>
      <div class="search-bar mt-8">
        <input type="search" id="mapeoInsumoSearch" placeholder="Buscar insumo por código o nombre…" />
      </div>
      <div id="mapeoSearchResults"></div>
    </div>
  `;

  { const fill = $('.progress-bar > span[data-pct]', view); if (fill) fill.style.width = fill.dataset.pct + '%'; }

  $('#btnActualizarPresupuesto').addEventListener('click', () => abrirModalActualizarPresupuesto());

  if (!conceptosReales.length) {
    $('#mapeoLinkedList').innerHTML = '<div class="empty-state">Este presupuesto no tiene conceptos.</div>';
    return;
  }

  $('#mapeoConceptoSelect').addEventListener('change', (e) => {
    mapeoSelectedConceptoId = Number(e.target.value);
    renderMapeo(view);
  });

  $('#mapeoInsumoSearch').addEventListener('input', debounce(async (e) => {
    const q = e.target.value.trim();
    const results = $('#mapeoSearchResults');
    if (!q) { results.innerHTML = ''; return; }
    try {
      const found = await api(`/projects/${state.projectId}/insumos${queryString({ q })}`);
      results.innerHTML = found.slice(0, 8).map((i) => `
        <div class="project-item" data-link="${i.id}">
          <span class="pname">${esc(i.concepto)}</span>
          <span class="pmeta">${esc(i.codigo)} · ${esc(i.unidad || '')}</span>
        </div>`).join('') || '<p class="muted">Sin resultados.</p>';
      $$('[data-link]', results).forEach((row) => row.addEventListener('click', async () => {
        try {
          await api(`/conceptos/${mapeoSelectedConceptoId}/insumos`, { method: 'POST', body: { insumo_id: Number(row.dataset.link) } });
          toast('Insumo vinculado', 'success');
          renderMapeo(view);
        } catch (err) { toast(err.message, 'danger'); }
      }));
    } catch (err) { toast(err.message, 'danger'); }
  }, 280));

  await paintMapeoLinked();

  async function paintMapeoLinked() {
    const box = $('#mapeoLinkedList');
    if (!box) return;
    const linked = await api(`/conceptos/${mapeoSelectedConceptoId}/insumos`);
    if (!linked.length) { box.innerHTML = '<div class="empty-state">Sin insumos vinculados todavía.</div>'; return; }
    box.innerHTML = linked.map((i) => `
      <div class="row between row-list-item">
        <div>
          <div>${esc(i.concepto)}</div>
          <div class="muted fs-078">${esc(i.codigo)} · ${esc(i.unidad || '')}</div>
        </div>
        <button class="btn small btn-danger" data-unlink="${i.id}">Quitar</button>
      </div>
    `).join('');
    $$('[data-unlink]', box).forEach((btn) => btn.addEventListener('click', async () => {
      try {
        await api(`/conceptos/${mapeoSelectedConceptoId}/insumos/${btn.dataset.unlink}`, { method: 'DELETE' });
        toast('Insumo desvinculado', 'success');
        renderMapeo(view);
      } catch (err) { toast(err.message, 'danger'); }
    }));
  }
}

// =========================================================================
// Actualización de presupuesto preservando avance (DISEÑO-ACTUALIZACION-
// PRESUPUESTO.md, aprobado por Paul 2026-07-21). Flujo de dos pasos: sube el
// Excel nuevo → preview (nada se guarda) → confirmar explícito. Reutiliza el
// mismo endpoint de subida a Blob que la carga inicial de presupuesto
// (/api/projects/upload-token).
// =========================================================================
async function abrirModalActualizarPresupuesto() {
  openModal(`
    <h3>Actualizar presupuesto</h3>
    <p class="muted">Sube el Excel de presupuesto nuevo para esta obra. No se borra ni se aplica nada todavía — primero verás un preview de los cambios.</p>
    <input type="file" id="actualizarPresupuestoFile" accept=".xlsx" />
    <div class="modal-actions">
      <button class="btn btn-outline" id="btnCancelarActualizarPresupuesto">Cancelar</button>
    </div>
  `);
  $('#btnCancelarActualizarPresupuesto').addEventListener('click', closeModal);
  $('#actualizarPresupuestoFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    openModal(`<h3>Subiendo y analizando…</h3><div class="spinner"></div>`);
    try {
      const blob = await VercelBlobClient.upload(file.name, file, {
        access: 'private',
        handleUploadUrl: '/api/projects/upload-token',
        headers: state.token ? { Authorization: `Bearer ${state.token}` } : {},
      });
      const preview = await api(`/projects/${state.projectId}/presupuesto/actualizar/preview`, {
        method: 'POST',
        body: { archivo_url: blob.url },
      });
      pintarPreviewActualizacionPresupuesto(preview, blob.url);
    } catch (err) {
      closeModal();
      toast(err.message, 'danger');
    }
  });
}

function pintarPreviewActualizacionPresupuesto(preview, archivoUrl) {
  const cambiosPrecio = preview.emparejados.filter((m) => m.cambia_precio).length;
  const cambiosCantidad = preview.emparejados.filter((m) => m.cambia_cantidad).length;
  const hayConflictos = preview.conflictos && preview.conflictos.length > 0;

  openModal(`
    <h3>Preview de actualización</h3>
    <p class="muted">Nada se ha guardado todavía. Revisa el resumen antes de confirmar.</p>
    <div class="card">
      <div class="row between"><span>Conceptos nuevos</span><strong>${preview.nuevos.length}</strong></div>
      <div class="row between"><span>Conceptos emparejados</span><strong>${preview.emparejados.length}</strong></div>
      <div class="row between fs-08"><span>&nbsp;&nbsp;con cambio de precio</span><span>${cambiosPrecio}</span></div>
      <div class="row between fs-08"><span>&nbsp;&nbsp;con cambio de cantidad</span><span>${cambiosCantidad}</span></div>
      <div class="row between"><span>Conceptos que pasan a históricos</span><strong>${preview.historicos.length}</strong></div>
      <div class="row between"><span>Total presupuesto actual</span><span>${fmtMoney(preview.total_actual)}</span></div>
      <div class="row between"><span>Total presupuesto nuevo</span><span>${fmtMoney(preview.total_nuevo)}</span></div>
    </div>
    ${hayConflictos ? `
      <div class="alert-box danger">
        <strong>⚠️ ${preview.conflictos.length} conflicto(s) de emparejamiento sin resolver.</strong>
        <p class="fs-08 mt-4">Hay conceptos ambiguos (mismo nombre repetido en varios lados). Corrige el Excel — por ejemplo agregando un código único a cada concepto — y vuelve a intentar. No se puede confirmar mientras existan conflictos.</p>
        <ul class="fs-08">
          ${preview.conflictos.map((c) => `<li>"${esc(c.descripcion)}" — ${c.nuevos.length} en el Excel nuevo vs. ${c.existentes.length} ya existente(s)</li>`).join('')}
        </ul>
      </div>
    ` : ''}
    ${preview.historicos.length ? `
      <details class="mt-8">
        <summary>Ver conceptos que pasarán a históricos (${preview.historicos.length})</summary>
        <ul class="fs-08">${preview.historicos.map((h) => `<li>${esc(h.codigo || '')} — ${esc(h.concepto)}</li>`).join('')}</ul>
      </details>
    ` : ''}
    <div class="modal-actions">
      <button class="btn btn-outline" id="btnCancelarConfirmarActualizacion">Cancelar</button>
      <button class="btn btn-primary" id="btnConfirmarActualizacion" ${hayConflictos ? 'disabled' : ''}>Confirmar actualización</button>
    </div>
  `);

  $('#btnCancelarConfirmarActualizacion').addEventListener('click', closeModal);
  $('#btnConfirmarActualizacion')?.addEventListener('click', async () => {
    openModal(`<h3>Aplicando actualización…</h3><div class="spinner"></div>`);
    try {
      const result = await api(`/projects/${state.projectId}/presupuesto/actualizar/confirmar`, {
        method: 'POST',
        body: { archivo_url: archivoUrl, confirmado: true },
      });
      closeModal();
      toast(`Presupuesto actualizado: ${result.nuevos} nuevos, ${result.emparejados} emparejados, ${result.historicos} históricos`, 'success');
      invalidate('conceptos');
      const view = $('#view');
      if (view) renderMapeo(view);
    } catch (err) {
      closeModal();
      toast(err.message, 'danger');
    }
  });
}

// =========================================================================
// Borrador de requisición (carrito) — persistido en memoria por proyecto
// =========================================================================
function getDraft() {
  const bucket = state.cache[state.projectId];
  bucket.draft = bucket.draft || [];
  return bucket.draft;
}
function addToDraft(insumoId, insumosList) {
  const draft = getDraft();
  const insumo = insumosList.find((i) => i.id === insumoId);
  if (!insumo) return;
  let entry = draft.find((d) => d.insumo_id === insumoId);
  if (!entry) {
    entry = { insumo_id: insumoId, insumo, cantidad_solicitada: 1, precio_solicitado: insumo.precio_presupuesto };
    draft.push(entry);
  }
  toast(`${insumo.concepto} agregado al borrador de requisición (${draft.length} insumo${draft.length === 1 ? '' : 's'})`, 'success');
}

// =========================================================================
// VISTA: Requisiciones
// =========================================================================
async function renderRequisiciones(view) {
  const reqs = await api(`/projects/${state.projectId}/requisiciones`);
  const draft = getDraft();

  view.innerHTML = `
    <h2 class="section-title">Requisiciones de compra ${renderHelpBtn('requisiciones')}</h2>
    ${draft.length ? `
      <div class="card">
        <div class="row between"><strong>Borrador en curso</strong><span class="badge muted">${draft.length} insumo${draft.length === 1 ? '' : 's'}</span></div>
        <p class="muted">Insumos agregados desde el catálogo, listos para convertirse en una requisición.</p>
        <div class="row end"><button class="btn btn-primary" id="btnOpenDraft">Revisar y crear requisición</button></div>
      </div>` : ''}
    <div class="section-actions">
      <button class="btn" id="btnGoCatalogo">+ Agregar insumos desde el catálogo</button>
      <button class="btn" id="btnExportRequisiciones">⭳ Exportar a Excel</button>
      ${puedeGestionarUsuarios() ? `<button class="btn" id="btnReqHistorial">🕘 Historial</button>` : ''}
    </div>
    <div id="reqList"></div>
  `;
  $('#btnGoCatalogo').addEventListener('click', () => switchToView('insumos'));
  wireExportButton('#btnExportRequisiciones', `/projects/${state.projectId}/requisiciones/export`);
  if (puedeGestionarUsuarios()) $('#btnReqHistorial').addEventListener('click', openRequisicionesHistorialModal);
  if (draft.length) $('#btnOpenDraft').addEventListener('click', openDraftModal);

  const list = $('#reqList');
  if (!reqs.length) {
    list.innerHTML = `<div class="empty-state"><div class="big">🧾</div>Aún no hay requisiciones.<br>Agrega insumos desde el catálogo y crea tu primera requisición.</div>`;
    return;
  }
  list.innerHTML = reqs.map((r) => {
    const alertCount = r.alertas_cantidad + r.alertas_precio;
    const estadoBadge = { borrador: 'muted', enviada: 'yellow', autorizada: 'green', rechazada: 'red', cancelada: 'red' }[r.estado] || 'muted';
    return `
    <div class="card" data-req="${r.id}">
      <div class="row between">
        <div>
          <strong>${esc(r.folio || `Requisición #${r.id}`)}</strong>
          <div class="muted">${fmtDate(r.fecha)} · ${r.num_items} insumo${r.num_items === 1 ? '' : 's'} · ${fmtMoney(r.importe_total)}</div>
        </div>
        <span class="badge ${estadoBadge}">${esc(r.estado)}</span>
      </div>
      ${alertCount ? `<div class="alert-box warn">⚠️${alertCount} alerta${alertCount === 1 ? '' : 's'}: ${r.alertas_cantidad ? `${r.alertas_cantidad} de cantidad ` : ''}${r.alertas_precio ? `${r.alertas_precio} de precio` : ''}</div>` : ''}
      <div class="row end"><button class="btn small" data-view-req="${r.id}">Ver detalle</button></div>
    </div>`;
  }).join('');

  $$('[data-view-req]', list).forEach((btn) => btn.addEventListener('click', () => openRequisicionDetail(Number(btn.dataset.viewReq))));
}

const REQ_ACCION_LABEL = {
  requisicion_crear: 'creó',
  requisicion_editar: 'editó',
  requisicion_estado: 'cambió el estado de',
  requisicion_eliminar: 'eliminó',
};

// Historial de acciones de residente/cabo sobre requisiciones de esta obra —
// control administrativo (solo admin/desarrollador/administracion, ver
// GET /requisiciones-historial en el backend).
async function openRequisicionesHistorialModal() {
  openModal('<div class="spinner"></div>');
  try {
    const historial = await api(`/projects/${state.projectId}/requisiciones-historial`);
    openModal(`
      <h3>Historial de requisiciones</h3>
      <p class="muted fs076-m006">Acciones de residentes y cabos sobre las requisiciones de esta obra.</p>
      ${historial.length ? `
      <div class="project-list gap-6">
        ${historial.map((h) => `
          <div class="project-item" style="cursor:default;">
            <div>
              <strong>${esc(h.actor_nombre)}</strong> ${esc(REQ_ACCION_LABEL[h.accion] || h.accion)}
              <strong>${esc(h.target_usuario || `#${h.target_id}`)}</strong>
            </div>
            <div class="muted fs-078">${new Date(h.creado_en).toLocaleString('es-MX', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
          </div>`).join('')}
      </div>` : '<p class="muted">Sin actividad de residentes/cabos registrada todavía.</p>'}
      <div class="modal-actions"><button class="btn" id="btnCloseReqHistorial">Cerrar</button></div>
    `);
    $('#btnCloseReqHistorial').addEventListener('click', closeModal);
  } catch (err) {
    closeModal();
    toast(err.message, 'danger');
  }
}

function openDraftModal() {
  const draft = getDraft();
  if (!draft.length) { toast('El borrador está vacío', 'danger'); return; }

  const render = () => `
    <h3>Nueva requisición</h3>
    <div class="field"><label>Folio (opcional)</label><input id="reqFolio" placeholder="Ej. REQ-2026-001" /></div>
    <div class="field"><label>Fecha</label><input id="reqFecha" type="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
    <div id="draftItems"></div>
    <div class="field"><label>Observaciones</label><textarea id="reqObs" rows="2" placeholder="Notas para esta requisición…"></textarea></div>
    <div id="previewAlerts"></div>
    <div class="modal-actions">
      <button class="btn btn-danger" id="btnDeleteDraft">Eliminar borrador</button>
      <button class="btn" id="btnCancelDraft">Cerrar</button>
      <button class="btn btn-primary" id="btnSubmitDraft">Crear requisición</button>
    </div>
  `;
  openModal(render());

  function paintItems() {
    $('#draftItems').innerHTML = draft.map((d, idx) => {
      const i = d.insumo;
      return `
      <div class="req-item-row" data-idx="${idx}">
        <div class="row between">
          <div>
            <div class="item-title">${esc(i.concepto)}</div>
            <div class="code muted">${esc(i.codigo)} · presup: ${fmtNum(i.cantidad_presupuesto, 3)} ${esc(i.unidad || '')} a ${fmtMoney(i.precio_presupuesto)}</div>
          </div>
          <button class="btn small btn-ghost" data-remove="${idx}">✕</button>
        </div>
        <div class="qty-row">
          <div><label>Cantidad</label><input type="number" min="0" step="any" data-field="cantidad_solicitada" data-idx="${idx}" value="${d.cantidad_solicitada}" /></div>
          ${puedeVerImportesRequisicion() ? `
          <div><label>Precio unitario</label><input type="number" min="0" step="any" data-field="precio_solicitado" data-idx="${idx}" value="${d.precio_solicitado}" /></div>
          <div class="muted fs-078-right">= ${fmtMoney(d.cantidad_solicitada * d.precio_solicitado)}</div>` : ''}
        </div>
      </div>`;
    }).join('');

    $$('[data-field]', $('#draftItems')).forEach((inp) => {
      inp.addEventListener('input', () => {
        const idx = Number(inp.dataset.idx);
        draft[idx][inp.dataset.field] = Number(inp.value) || 0;
        schedulePreview();
        // live total update without full repaint (no existe si no puede ver importes)
        const totalEl = inp.closest('.req-item-row').querySelector('.qty-row .muted');
        if (totalEl) totalEl.textContent = `= ${fmtMoney(draft[idx].cantidad_solicitada * draft[idx].precio_solicitado)}`;
      });
    });
    $$('[data-remove]', $('#draftItems')).forEach((btn) => {
      btn.addEventListener('click', () => {
        draft.splice(Number(btn.dataset.remove), 1);
        if (!draft.length) { closeModal(); renderView(); return; }
        paintItems();
        schedulePreview();
      });
    });
  }

  let previewTimer;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(runPreview, 320);
  }
  async function runPreview() {
    try {
      const items = draft.map((d) => ({ insumo_id: d.insumo_id, cantidad_solicitada: d.cantidad_solicitada, precio_solicitado: d.precio_solicitado }));
      const result = await api(`/projects/${state.projectId}/requisiciones/preview`, { method: 'POST', body: { items } });
      const box = $('#previewAlerts');
      if (!box) return;
      const alerts = [];
      result.items.forEach((it) => {
        if (it.alerta_cantidad) {
          alerts.push(`<div class="alert-box danger">⚠️<strong>${esc(it.insumo.codigo)}</strong>: la cantidad acumulada (${fmtNum(it.cantidad_acumulada_previa + it.cantidad_solicitada, 3)} ${esc(it.insumo.unidad || '')}) sobrepasa la cantidad presupuestada (${fmtNum(it.insumo.cantidad_presupuesto, 3)} ${esc(it.insumo.unidad || '')}).</div>`);
        }
        if (it.alerta_precio) {
          alerts.push(`<div class="alert-box warn">⚠️<strong>${esc(it.insumo.codigo)}</strong>: el precio solicitado (${fmtMoney(it.precio_solicitado)}) sobrepasa el precio presupuestado (${fmtMoney(it.insumo.precio_presupuesto)}).</div>`);
        }
      });
      box.innerHTML = alerts.join('') || `<div class="alert-box info">✓ Sin alertas: las cantidades y precios están dentro del presupuesto.</div>`;
    } catch (err) { /* silent preview errors */ }
  }

  paintItems();
  runPreview();
  $('#btnDeleteDraft').addEventListener('click', () => {
    if (!confirm('¿Eliminar el borrador completo? Se perderán todos los insumos agregados.')) return;
    getDraft().length = 0;
    closeModal();
    toast('Borrador eliminado', 'success');
    renderView();
  });
  $('#btnCancelDraft').addEventListener('click', closeModal);
  $('#btnSubmitDraft').addEventListener('click', async () => {
    const btn = $('#btnSubmitDraft');
    btn.disabled = true; btn.textContent = 'Creando…';
    try {
      const items = draft.map((d) => ({ insumo_id: d.insumo_id, cantidad_solicitada: d.cantidad_solicitada, precio_solicitado: d.precio_solicitado }));
      const result = await api(`/projects/${state.projectId}/requisiciones`, {
        method: 'POST',
        body: { folio: $('#reqFolio').value.trim() || null, fecha: $('#reqFecha').value || null, observaciones: $('#reqObs').value.trim() || null, items },
      });
      getDraft().length = 0; // clear draft
      closeModal();
      invalidate('resumen');
      toast(result.tiene_alertas ? 'Requisición creada — contiene alertas de cantidad/precio' : 'Requisición creada sin alertas', result.tiene_alertas ? 'danger' : 'success');
      renderView();
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false; btn.textContent = 'Crear requisición';
    }
  });
}

async function openRequisicionDetail(reqId) {
  openModal('<div class="spinner"></div>');
  try {
    const r = await api(`/projects/${state.projectId}/requisiciones/${reqId}`);
    const estadosAdmin = ['borrador', 'enviada', 'autorizada', 'rechazada', 'cancelada'];
    const estadosLogistica = ['borrador', 'enviada', 'autorizada', 'cancelada'];
    const estadosNoAdmin = ['borrador', 'enviada', 'cancelada'];
    const estados = isAdmin() ? estadosAdmin : (puedeAutorizarRequisicion() ? estadosLogistica : estadosNoAdmin);
    const estadoBadgeMap = { borrador: 'muted', enviada: 'yellow', autorizada: 'green', rechazada: 'red', cancelada: 'red' };
    openModal(`
      <h3>${esc(r.folio || `Requisición #${r.id}`)}</h3>
      <span class="muted">${fmtDate(r.fecha)}</span>
      ${r.observaciones ? `<p class="muted">${esc(r.observaciones)}</p>` : ''}
      <div id="reqItemsDetail"></div>
      <div class="card mt-14">
        <h4 class="req-estado-title">Estado de la requisición</h4>
        <p class="muted req-estado-desc">${puedeAutorizarRequisicion() ? 'Cambia el estado para avanzar el flujo de compra: envíala, autorízala (necesario para generar una Orden de Compra) o cancélala.' : 'Envía la requisición para que sea autorizada. Solo Logística o el Administrador pueden autorizar.'}</p>
        ${r.estado === 'enviada' && !puedeAutorizarRequisicion() ? `<span class="badge yellow">Pendiente de autorización</span>` : ''}
        ${r.estado === 'rechazada' ? `<span class="badge red">Rechazada por el Administrador</span>` : ''}
        <select id="estadoSelect">${estados.map((e) => `<option value="${e}" ${e === r.estado ? 'selected' : ''}>${e}</option>`).join('')}</select>
      </div>
      <div class="modal-actions">
        ${r.estado === 'borrador' ? '<button class="btn btn-danger" id="btnDeleteReq">Eliminar</button>' : ''}
        ${r.estado === 'borrador' ? '<button class="btn" id="btnEditReq">Editar</button>' : ''}
        ${r.estado === 'autorizada' && puedeGenerarOC() ? '<button class="btn btn-primary" id="btnGenerarOC">Generar Orden de Compra</button>' : ''}
        <button class="btn" id="btnCloseDetail">Cerrar</button>
      </div>
    `);
    $('#reqItemsDetail').innerHTML = r.items.map((it) => `
      <div class="req-item-row">
        <div class="row between">
          <div class="item-title">${esc(it.insumo_concepto)}</div>
          ${puedeVerImportesRequisicion() && it.importe != null ? `<span>${fmtMoney(it.importe)}</span>` : ''}
        </div>
        <div class="muted code">${esc(it.insumo_codigo)} · ${esc(it.unidad || '')}</div>
        <div class="row between"><span class="muted">Solicitado</span><span>${fmtNum(it.cantidad_solicitada, 3)} ${esc(it.unidad || '')}${puedeVerImportesRequisicion() && it.precio_solicitado != null ? ` a ${fmtMoney(it.precio_solicitado)}` : ''}</span></div>
        <div class="row between"><span class="muted">Presupuestado</span><span>${fmtNum(it.cantidad_presupuesto, 3)} ${esc(it.unidad || '')}${puedeVerImportesRequisicion() && it.precio_presupuesto != null ? ` a ${fmtMoney(it.precio_presupuesto)}` : ''}</span></div>
        ${it.alerta_cantidad ? `<div class="alert-box danger">⚠️ Cantidad acumulada sobrepasa lo presupuestado</div>` : ''}
        ${it.alerta_precio ? `<div class="alert-box warn">⚠️ Precio solicitado sobrepasa el precio presupuestado</div>` : ''}
        ${it.observaciones ? `<div class="muted">${esc(it.observaciones)}</div>` : ''}
      </div>`).join('');

    $('#btnCloseDetail').addEventListener('click', closeModal);
    $('#btnEditReq')?.addEventListener('click', () => openEditRequisicionModal(r));
    $('#btnGenerarOC')?.addEventListener('click', () => openGenerarOrdenModal(r));
    $('#estadoSelect').addEventListener('change', async (e) => {
      try {
        await api(`/projects/${state.projectId}/requisiciones/${reqId}/estado`, { method: 'PUT', body: { estado: e.target.value } });
        toast('Estado actualizado', 'success');
        invalidate('resumen');
        renderView();
        // Refresca el modal en el lugar (no solo la lista de fondo) para que
        // "Generar Orden de Compra" aparezca de inmediato al autorizar, sin
        // tener que cerrar y reabrir esta misma ventana.
        await openRequisicionDetail(reqId);
      } catch (err) { toast(err.message, 'danger'); }
    });
    $('#btnDeleteReq')?.addEventListener('click', async () => {
      if (!confirm('¿Eliminar esta requisición?')) return;
      await api(`/projects/${state.projectId}/requisiciones/${reqId}`, { method: 'DELETE' });
      closeModal();
      invalidate('resumen');
      toast('Requisición eliminada', 'success');
      renderView();
    });
  } catch (err) {
    closeModal();
    toast(err.message, 'danger');
  }
}

// Edición de una requisición en estado "borrador": permite corregir cantidades/precios,
// quitar insumos o agregar otros que hayan faltado, antes de enviarla.
function openEditRequisicionModal(requisicion) {
  const items = requisicion.items.map((it) => ({
    insumo_id: it.insumo_id,
    insumo: {
      id: it.insumo_id, codigo: it.insumo_codigo, concepto: it.insumo_concepto,
      unidad: it.unidad, cantidad_presupuesto: it.cantidad_presupuesto, precio_presupuesto: it.precio_presupuesto,
    },
    cantidad_solicitada: it.cantidad_solicitada,
    precio_solicitado: it.precio_solicitado,
  }));

  openModal(`
    <h3>Editar requisición</h3>
    <div class="field"><label>Folio (opcional)</label><input id="reqFolio" placeholder="Ej. REQ-2026-001" value="${esc(requisicion.folio || '')}" /></div>
    <div class="field"><label>Fecha</label><input id="reqFecha" type="date" value="${esc(String(requisicion.fecha || '').slice(0, 10))}" /></div>
    <div id="editItems"></div>
    <div class="field">
      <label>Agregar insumo del catálogo (faltante)</label>
      <input id="addInsumoSearch" placeholder="Buscar por código o nombre…" autocomplete="off" />
      <div id="addInsumoResults" class="project-list gap-6"></div>
    </div>
    <div class="field"><label>Observaciones</label><textarea id="reqObs" rows="2" placeholder="Notas para esta requisición…">${esc(requisicion.observaciones || '')}</textarea></div>
    <div id="previewAlerts"></div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelEdit">Cerrar</button>
      <button class="btn btn-primary" id="btnSaveEdit">Guardar cambios</button>
    </div>
  `);

  function paintItems() {
    const box = $('#editItems');
    if (!items.length) {
      box.innerHTML = '<p class="muted">No hay insumos en esta requisición. Agrega al menos uno desde el buscador de abajo.</p>';
      return;
    }
    box.innerHTML = items.map((d, idx) => {
      const i = d.insumo;
      return `
      <div class="req-item-row" data-idx="${idx}">
        <div class="row between">
          <div>
            <div class="item-title">${esc(i.concepto)}</div>
            <div class="code muted">${esc(i.codigo)} · presup: ${fmtNum(i.cantidad_presupuesto, 3)} ${esc(i.unidad || '')} a ${fmtMoney(i.precio_presupuesto)}</div>
          </div>
          <button class="btn small btn-ghost" data-remove="${idx}">✕</button>
        </div>
        <div class="qty-row">
          <div><label>Cantidad</label><input type="number" min="0" step="any" data-field="cantidad_solicitada" data-idx="${idx}" value="${d.cantidad_solicitada}" /></div>
          ${puedeVerImportesRequisicion() ? `
          <div><label>Precio unitario</label><input type="number" min="0" step="any" data-field="precio_solicitado" data-idx="${idx}" value="${d.precio_solicitado}" /></div>
          <div class="muted fs-078-right">= ${fmtMoney(d.cantidad_solicitada * d.precio_solicitado)}</div>` : ''}
        </div>
      </div>`;
    }).join('');

    $$('[data-field]', box).forEach((inp) => {
      inp.addEventListener('input', () => {
        const idx = Number(inp.dataset.idx);
        items[idx][inp.dataset.field] = Number(inp.value) || 0;
        schedulePreview();
        const totalEl = inp.closest('.req-item-row').querySelector('.qty-row .muted');
        if (totalEl) totalEl.textContent = `= ${fmtMoney(items[idx].cantidad_solicitada * items[idx].precio_solicitado)}`;
      });
    });
    $$('[data-remove]', box).forEach((btn) => {
      btn.addEventListener('click', () => {
        items.splice(Number(btn.dataset.remove), 1);
        paintItems();
        schedulePreview();
      });
    });
  }

  let searchTimer;
  $('#addInsumoSearch').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    const results = $('#addInsumoResults');
    if (!q) { results.innerHTML = ''; return; }
    searchTimer = setTimeout(async () => {
      try {
        const found = await api(`/projects/${state.projectId}/insumos${queryString({ q })}`);
        results.innerHTML = found.slice(0, 8).map((i) => `
          <div class="project-item" data-pick="${i.id}">
            <span class="pname">${esc(i.concepto)}</span>
            <span class="pmeta">${esc(i.codigo)} · ${esc(i.unidad || '')} · ${fmtMoney(i.precio_presupuesto)}/u</span>
          </div>`).join('') || '<p class="muted">Sin resultados.</p>';
        $$('[data-pick]', results).forEach((row) => row.addEventListener('click', () => {
          const insumoId = Number(row.dataset.pick);
          const insumo = found.find((i) => i.id === insumoId);
          if (!insumo) return;
          if (items.find((d) => d.insumo_id === insumoId)) { toast('Ese insumo ya está en la requisición', 'danger'); return; }
          items.push({ insumo_id: insumoId, insumo, cantidad_solicitada: 1, precio_solicitado: insumo.precio_presupuesto });
          $('#addInsumoSearch').value = '';
          results.innerHTML = '';
          paintItems();
          schedulePreview();
        }));
      } catch (err) { /* silent search errors */ }
    }, 280);
  });

  let previewTimer;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(runPreview, 320);
  }
  async function runPreview() {
    const box = $('#previewAlerts');
    if (!box) return;
    if (!items.length) { box.innerHTML = ''; return; }
    try {
      const payload = items.map((d) => ({ insumo_id: d.insumo_id, cantidad_solicitada: d.cantidad_solicitada, precio_solicitado: d.precio_solicitado }));
      const result = await api(`/projects/${state.projectId}/requisiciones/preview`, { method: 'POST', body: { items: payload, ignore_requisicion_id: requisicion.id } });
      const alerts = [];
      result.items.forEach((it) => {
        if (it.alerta_cantidad) {
          alerts.push(`<div class="alert-box danger">⚠️<strong>${esc(it.insumo.codigo)}</strong>: la cantidad acumulada (${fmtNum(it.cantidad_acumulada_previa + it.cantidad_solicitada, 3)} ${esc(it.insumo.unidad || '')}) sobrepasa la cantidad presupuestada (${fmtNum(it.insumo.cantidad_presupuesto, 3)} ${esc(it.insumo.unidad || '')}).</div>`);
        }
        if (it.alerta_precio) {
          alerts.push(`<div class="alert-box warn">⚠️<strong>${esc(it.insumo.codigo)}</strong>: el precio solicitado (${fmtMoney(it.precio_solicitado)}) sobrepasa el precio presupuestado (${fmtMoney(it.insumo.precio_presupuesto)}).</div>`);
        }
      });
      box.innerHTML = alerts.join('') || `<div class="alert-box info">✓ Sin alertas: las cantidades y precios están dentro del presupuesto.</div>`;
    } catch (err) { /* silent preview errors */ }
  }

  paintItems();
  runPreview();
  $('#btnCancelEdit').addEventListener('click', closeModal);
  $('#btnSaveEdit').addEventListener('click', async () => {
    if (!items.length) { toast('Agrega al menos un insumo', 'danger'); return; }
    const btn = $('#btnSaveEdit');
    btn.disabled = true; btn.textContent = 'Guardando…';
    try {
      const payload = items.map((d) => ({ insumo_id: d.insumo_id, cantidad_solicitada: d.cantidad_solicitada, precio_solicitado: d.precio_solicitado }));
      const result = await api(`/projects/${state.projectId}/requisiciones/${requisicion.id}`, {
        method: 'PUT',
        body: { folio: $('#reqFolio').value.trim() || null, fecha: $('#reqFecha').value || null, observaciones: $('#reqObs').value.trim() || null, items: payload },
      });
      closeModal();
      invalidate('resumen');
      toast(result.tiene_alertas ? 'Requisición actualizada — contiene alertas de cantidad/precio' : 'Requisición actualizada sin alertas', result.tiene_alertas ? 'danger' : 'success');
      renderView();
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false; btn.textContent = 'Guardar cambios';
    }
  });
}

// Genera una Orden de Compra a partir de una requisición 'autorizada'. Se
// puede ordenar solo algunos items (no obliga a cubrir el 100%) y se puede
// repetir varias veces sobre la misma requisición (compra dividida).
async function openGenerarOrdenModal(requisicion) {
  openModal('<div class="spinner"></div>');
  let proveedores = [];
  let ivaTasaMap = new Map();
  try {
    const [provs, insumos] = await Promise.all([
      api('/proveedores'),
      api(`/projects/${state.projectId}/insumos`),
    ]);
    proveedores = provs;
    ivaTasaMap = new Map(insumos.map((i) => [i.id, i.iva_tasa]));
  } catch (err) {
    closeModal();
    toast(err.message, 'danger');
    return;
  }
  if (!proveedores.length) {
    openModal(`
      <h3>Generar Orden de Compra</h3>
      <p class="muted">Aún no hay proveedores activos en el catálogo. Ve a la pestaña "Proveedores" y da de alta al menos uno antes de generar una orden de compra.</p>
      <div class="modal-actions"><button class="btn" id="btnCancelOC">Cerrar</button></div>
    `);
    $('#btnCancelOC').addEventListener('click', closeModal);
    return;
  }

  openModal(`
    <h3>Generar Orden de Compra</h3>
    <p class="muted">${esc(requisicion.folio || `Requisición #${requisicion.id}`)} — puedes ordenar solo algunos items; deja en 0 los que no vayas a incluir en esta orden.</p>
    <div class="field"><label>Proveedor *</label>
      <select id="ocProveedor">${proveedores.map((p) => `<option value="${p.id}">${esc(p.nombre)}</option>`).join('')}</select>
    </div>
    <div class="field"><label>Folio (opcional)</label><input id="ocFolio" placeholder="Ej. OC-2026-001" /></div>
    <div class="field"><label>Fecha</label><input id="ocFecha" type="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
    <div id="ocItems"></div>
    <div class="field">
      <label class="muted iva-question-label">¿Los precios que capturaste arriba incluyen IVA?</label>
      <div class="iva-radio-col">
        <label class="fw-400"><input type="radio" name="ocIvaModo" id="ocSinIva" checked class="radio-inline" /> Los precios que capturé son <strong>SIN IVA</strong> (se sumará el 16% al total)</label>
        <label class="fw-400"><input type="radio" name="ocIvaModo" id="ocIncluyeIva" class="radio-inline" /> Los precios que capturé <strong>YA INCLUYEN IVA</strong> (se desglosará del total)</label>
      </div>
    </div>
    <div class="card bg-panel2" id="ocIvaResumen">
      <div class="card-row"><span class="k">Subtotal</span><span class="v" id="ocSubtotalOut">—</span></div>
      <div class="card-row"><span class="k">IVA</span><span class="v" id="ocIvaOut">—</span></div>
      <div class="card-row"><span class="k">Total</span><span class="v fw-700" id="ocTotalOut">—</span></div>
    </div>
    <div class="field"><label>Observaciones</label><textarea id="ocObs" rows="2" placeholder="Notas para esta orden…"></textarea></div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelOC">Cerrar</button>
      <button class="btn btn-primary" id="btnSaveOC">Crear orden de compra</button>
    </div>
  `);

  $('#ocItems').innerHTML = requisicion.items.map((it) => `
    <div class="req-item-row" data-req-item="${it.id}" data-iva-tasa="${ivaTasaMap.get(it.insumo_id) ?? 16}">
      <div class="item-title">${esc(it.insumo_concepto)}</div>
      <div class="code muted">${esc(it.insumo_codigo)} · solicitado: ${fmtNum(it.cantidad_solicitada, 3)} ${esc(it.unidad || '')} a ${fmtMoney(it.precio_solicitado)}</div>
      <div class="qty-row">
        <div><label>Cantidad a ordenar</label><input type="number" min="0" step="any" data-oc-cantidad value="${it.cantidad_solicitada}" /></div>
        <div><label>Precio unitario</label><input type="number" min="0" step="any" data-oc-precio value="${it.precio_solicitado}" /></div>
        <div class="muted fs-078-right" data-oc-importe>= ${fmtMoney(it.cantidad_solicitada * it.precio_solicitado)}</div>
      </div>
    </div>
  `).join('');

  function updateIvaResumen() {
    const incluyeIva = $('#ocIncluyeIva').checked;
    const items = $$('#ocItems .req-item-row').map((row) => ({
      importe: (Number(row.querySelector('[data-oc-cantidad]').value) || 0) * (Number(row.querySelector('[data-oc-precio]').value) || 0),
      iva_tasa: Number(row.dataset.ivaTasa),
    }));
    const b = ivaBreakdown(items, incluyeIva);
    $('#ocSubtotalOut').textContent = fmtMoney(b.subtotal);
    $('#ocIvaOut').textContent = fmtMoney(b.iva);
    $('#ocTotalOut').textContent = fmtMoney(b.total);
  }

  $$('#ocItems .req-item-row').forEach((row) => {
    const cantInp = row.querySelector('[data-oc-cantidad]');
    const precInp = row.querySelector('[data-oc-precio]');
    const out = row.querySelector('[data-oc-importe]');
    const update = () => {
      out.textContent = `= ${fmtMoney((Number(cantInp.value) || 0) * (Number(precInp.value) || 0))}`;
      updateIvaResumen();
    };
    cantInp.addEventListener('input', update);
    precInp.addEventListener('input', update);
  });
  $$('input[name="ocIvaModo"]').forEach((r) => r.addEventListener('change', updateIvaResumen));
  updateIvaResumen();

  $('#btnCancelOC').addEventListener('click', closeModal);
  $('#btnSaveOC').addEventListener('click', async () => {
    const items = $$('#ocItems .req-item-row').map((row) => ({
      requisicion_item_id: Number(row.dataset.reqItem),
      cantidad_ordenada: Number(row.querySelector('[data-oc-cantidad]').value) || 0,
      precio_unitario: Number(row.querySelector('[data-oc-precio]').value) || 0,
    })).filter((it) => it.cantidad_ordenada > 0);

    if (!items.length) { toast('Indica una cantidad mayor a 0 en al menos un item', 'danger'); return; }

    const btn = $('#btnSaveOC');
    btn.disabled = true; btn.textContent = 'Creando…';
    try {
      const result = await api(`/projects/${state.projectId}/requisiciones/${requisicion.id}/ordenes`, {
        method: 'POST',
        body: {
          proveedor_id: Number($('#ocProveedor').value),
          folio: $('#ocFolio').value.trim() || null,
          fecha: $('#ocFecha').value || null,
          observaciones: $('#ocObs').value.trim() || null,
          incluye_iva: $('#ocIncluyeIva').checked,
          items,
        },
      });
      closeModal();
      toast(result.tiene_alertas
        ? 'Orden de compra creada — algún item supera lo solicitado en la requisición'
        : 'Orden de compra creada', result.tiene_alertas ? 'danger' : 'success');
      switchToView('ordenes');
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false; btn.textContent = 'Crear orden de compra';
    }
  });
}

// =========================================================================
// VISTA: Órdenes de Compra
// =========================================================================
async function renderOrdenes(view) {
  const ordenes = await api(`/projects/${state.projectId}/ordenes`);

  view.innerHTML = `
    <h2 class="section-title">Órdenes de Compra ${renderHelpBtn('ordenesCompra')}</h2>
    <p class="muted">Generadas a partir de requisiciones ya autorizadas. Una requisición puede tener varias órdenes (compra dividida entre proveedores o en distintos momentos).</p>
    <div class="section-actions">
      <button class="btn" id="btnExportOrdenes">⭳ Exportar a Excel</button>
    </div>
    <div id="ordenesList"></div>
  `;
  wireExportButton('#btnExportOrdenes', `/projects/${state.projectId}/ordenes/export`);

  const list = $('#ordenesList');
  if (!ordenes.length) {
    list.innerHTML = `<div class="empty-state"><div class="big">🧾</div>Aún no hay órdenes de compra.<br>Genera una desde el detalle de una requisición autorizada.</div>`;
    return;
  }
  const estadoBadge = { borrador: 'muted', enviada: 'yellow', confirmada: 'green', rechazada: 'red', recibida_parcial: 'yellow', recibida_completa: 'green', cancelada: 'red' };
  list.innerHTML = ordenes.map((o) => `
    <div class="card" data-oc="${o.id}">
      <div class="row between">
        <div>
          <strong>${esc(o.folio || `OC #${o.id}`)}</strong>
          <div class="muted">${fmtDate(o.fecha)} · ${esc(o.proveedor_nombre)} · req. ${esc(o.requisicion_folio || '')}</div>
          <div class="muted">${o.num_items} insumo${o.num_items === 1 ? '' : 's'} · ${fmtMoney(o.importe_total)}</div>
        </div>
        <span class="badge ${estadoBadge[o.estado] || 'muted'}">${esc(o.estado)}</span>
      </div>
      <div class="row between mt-6-fs-084">
        <span class="muted">Pagado: ${fmtMoney(o.total_pagado)}</span>
        <span class="saldo-pendiente ${o.saldo_pendiente > 0 ? 'text-rojo' : 'text-verde'}">Saldo: ${fmtMoney(o.saldo_pendiente)}</span>
      </div>
      <div class="row end"><button class="btn small" data-view-oc="${o.id}">Ver detalle</button></div>
    </div>
  `).join('');

  $$('[data-view-oc]', list).forEach((btn) => btn.addEventListener('click', () => openOrdenDetalle(Number(btn.dataset.viewOc))));
}

async function openOrdenDetalle(ocId) {
  openModal('<div class="spinner"></div>');
  try {
    const o = await api(`/projects/${state.projectId}/ordenes/${ocId}`);
    const estadosAdmin = ['borrador', 'enviada', 'confirmada', 'rechazada', 'cancelada'];
    const estadosCompras = ['borrador', 'enviada', 'cancelada'];
    const todosEstados = ['borrador', 'enviada', 'confirmada', 'rechazada', 'cancelada'];
    const puedeConfirmarOC = isAdmin() || state.user?.puesto === 'tesoreria';
    const estados = puedeConfirmarOC ? estadosAdmin : estadosCompras;
    const esEstadoRecepcion = !todosEstados.includes(o.estado);
    const puedeRecibir = ['confirmada', 'recibida_parcial'].includes(o.estado);
    openModal(`
      <h3>${esc(o.folio || `Orden de Compra #${o.id}`)}</h3>
      <div class="card-row"><span class="k">Proveedor</span><span class="v">${esc(o.proveedor_nombre)}</span></div>
      ${o.proveedor_contacto ? `<div class="card-row"><span class="k">Contacto</span><span class="v">${esc(o.proveedor_contacto)}</span></div>` : ''}
      ${o.proveedor_telefono ? `<div class="card-row"><span class="k">Teléfono</span><span class="v">${esc(o.proveedor_telefono)}</span></div>` : ''}
      <div class="card-row"><span class="k">Requisición origen</span><span class="v">${esc(o.requisicion_folio || '')}</span></div>
      <div class="card-row"><span class="k">Fecha</span><span class="v">${fmtDate(o.fecha)}</span></div>
      ${o.observaciones ? `<p class="muted">${esc(o.observaciones)}</p>` : ''}
      <div class="field"><label>Estado</label>
        ${esEstadoRecepcion
          ? `<p class="muted">${esc(o.estado)} — este estado lo controla la recepción de mercancía, no se puede cambiar aquí.</p>`
          : `${o.estado === 'enviada' && !isAdmin() ? '<span class="badge yellow">Pendiente de autorización</span>' : ''}
             ${!puedeConfirmarOC ? '<p class="muted fs-078">Solo un Administrador o Tesorería puede confirmar o rechazar la orden.</p>' : ''}
             <select id="ocEstadoSelect">${estados.map((e) => `<option value="${e}" ${e === o.estado ? 'selected' : ''}>${e}</option>`).join('')}</select>`}
      </div>
      <div id="ocItemsDetail"></div>
      <div class="card bg-panel2">
        <div class="card-row"><span class="k">Los montos capturados</span><span class="v">${o.incluye_iva ? 'incluyen IVA' : 'no incluyen IVA (son sin IVA)'}</span></div>
        <div class="card-row"><span class="k">Subtotal</span><span class="v">${fmtMoney(o.desglose_iva.subtotal)}</span></div>
        <div class="card-row"><span class="k">IVA</span><span class="v">${fmtMoney(o.desglose_iva.iva)}</span></div>
        <div class="card-row"><span class="k">Total</span><span class="v fw-700">${fmtMoney(o.desglose_iva.total)}</span></div>
      </div>

      <h3 class="section-title">Recepciones</h3>
      <div id="ocRecepcionesList"><div class="spinner"></div></div>
      ${puedeRecibir ? '<div class="row end mt-8"><button class="btn small btn-primary" id="btnRegistrarRecepcion">Registrar recepción</button></div>' : ''}

      <h3 class="section-title">Pagos</h3>
      <div id="ocPagosList"><div class="spinner"></div></div>
      ${puedeRegistrarPago() && ['enviada', 'confirmada', 'recibida_parcial', 'recibida_completa'].includes(o.estado) ? '<div class="row end mt-8"><button class="btn small btn-primary" id="btnRegistrarPago">Registrar pago</button></div>' : ''}

      <div class="modal-actions">
        ${o.estado === 'borrador' ? '<button class="btn btn-danger" id="btnDeleteOC">Eliminar</button>' : ''}
        <button class="btn" id="btnCloseOC">Cerrar</button>
      </div>
    `);
    $('#ocItemsDetail').innerHTML = o.items.map((it) => `
      <div class="req-item-row">
        <div class="row between">
          <div class="item-title">${esc(it.insumo_concepto)}</div>
          <span>${fmtMoney(it.importe)}</span>
        </div>
        <div class="muted code">${esc(it.insumo_codigo)} · ${esc(it.unidad || '')}</div>
        <div class="row between"><span class="muted">Ordenado</span><span>${fmtNum(it.cantidad_ordenada, 3)} ${esc(it.unidad || '')} a ${fmtMoney(it.precio_unitario)}</span></div>
        <div class="row between"><span class="muted">Solicitado en la requisición</span><span>${fmtNum(it.cantidad_solicitada, 3)} ${esc(it.unidad || '')}</span></div>
      </div>`).join('');

    $('#btnCloseOC').addEventListener('click', closeModal);
    $('#ocEstadoSelect')?.addEventListener('change', async (e) => {
      try {
        await api(`/projects/${state.projectId}/ordenes/${ocId}/estado`, { method: 'PUT', body: { estado: e.target.value } });
        toast('Estado actualizado', 'success');
        renderView();
      } catch (err) { toast(err.message, 'danger'); e.target.value = o.estado; }
    });
    $('#btnDeleteOC')?.addEventListener('click', async () => {
      if (!confirm('¿Eliminar esta orden de compra?')) return;
      try {
        await api(`/projects/${state.projectId}/ordenes/${ocId}`, { method: 'DELETE' });
        closeModal();
        toast('Orden de compra eliminada', 'success');
        renderView();
      } catch (err) { toast(err.message, 'danger'); }
    });
    $('#btnRegistrarRecepcion')?.addEventListener('click', () => openRegistrarRecepcionModal(o));
    $('#btnRegistrarPago')?.addEventListener('click', () => openRegistrarPagoModal(o));

    await Promise.all([paintOcRecepciones(ocId), paintOcPagos(ocId)]);
  } catch (err) {
    closeModal();
    toast(err.message, 'danger');
  }
}

async function paintOcRecepciones(ocId) {
  const box = $('#ocRecepcionesList');
  if (!box) return;
  try {
    const recepciones = await api(`/projects/${state.projectId}/ordenes/${ocId}/recepciones`);
    if (!recepciones.length) {
      box.innerHTML = '<p class="muted fs-084">Aún no se ha recibido material de esta orden.</p>';
      return;
    }
    box.innerHTML = recepciones.map((r) => `
      <div class="req-item-row">
        <div class="row between">
          <strong class="fs-086">${fmtDate(r.fecha)}</strong>
          ${r.recibido_por ? `<span class="muted">${esc(r.recibido_por)}</span>` : ''}
        </div>
        ${r.items.map((it) => `
          <div class="row between fs-082">
            <span>${esc(it.insumo_concepto)}</span>
            <span>${fmtNum(it.cantidad_recibida, 3)} ${esc(it.unidad || '')}</span>
          </div>`).join('')}
        ${r.observaciones ? `<div class="muted fs-078">${esc(r.observaciones)}</div>` : ''}
      </div>`).join('');
  } catch (err) {
    box.innerHTML = `<div class="alert-box danger">⚠️${esc(err.message)}</div>`;
  }
}

async function paintOcPagos(ocId) {
  const box = $('#ocPagosList');
  if (!box) return;
  try {
    const data = await api(`/projects/${state.projectId}/ordenes/${ocId}/pagos`);
    const pagosHtml = data.pagos.length ? data.pagos.map((p) => `
      <div class="row between fs-084">
        <span>${fmtDate(p.fecha)} ${p.metodo ? `· ${esc(p.metodo)}` : ''} ${p.referencia ? `· ${esc(p.referencia)}` : ''}
          <span class="muted fs-074"> · ${p.incluye_iva ? 'con IVA' : 'sin IVA'}</span></span>
        <span>${fmtMoney(p.monto)}</span>
      </div>`).join('') : '<p class="muted fs-084">Sin pagos registrados.</p>';
    box.innerHTML = `
      ${pagosHtml}
      <div class="card-row"><span class="k">Total pagado</span><span class="v">${fmtMoney(data.total_pagado)}</span></div>
      <div class="card-row"><span class="k">Saldo pendiente</span><span class="v ${data.saldo_pendiente > 0 ? 'text-rojo' : 'text-verde'}">${fmtMoney(data.saldo_pendiente)}</span></div>
    `;
  } catch (err) {
    box.innerHTML = `<div class="alert-box danger">⚠️${esc(err.message)}</div>`;
  }
}

async function openRegistrarRecepcionModal(orden) {
  openModal('<div class="spinner"></div>');
  let acumMap = new Map();
  try {
    const recepciones = await api(`/projects/${state.projectId}/ordenes/${orden.id}/recepciones`);
    recepciones.forEach((r) => {
      r.items.forEach((it) => {
        acumMap.set(it.orden_compra_item_id, (acumMap.get(it.orden_compra_item_id) || 0) + Number(it.cantidad_recibida));
      });
    });
  } catch (err) {
    closeModal();
    toast(err.message, 'danger');
    return;
  }

  openModal(`
    <h3>Registrar recepción</h3>
    <p class="muted">${esc(orden.folio || `OC #${orden.id}`)} — anota lo que llegó en esta entrega (no acumulado).</p>
    <div class="field"><label>Fecha</label><input id="recFecha" type="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
    <div class="field"><label>Recibido por</label><input id="recPor" placeholder="Nombre de quien recibió" /></div>
    <div id="recItems"></div>
    <div class="field"><label>Observaciones</label><textarea id="recObs" rows="2" placeholder="Notas de la recepción…"></textarea></div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelRec">Cerrar</button>
      <button class="btn btn-primary" id="btnSaveRec">Guardar recepción</button>
    </div>
  `);

  $('#recItems').innerHTML = orden.items.map((it) => {
    const acumulado = acumMap.get(it.id) || 0;
    const pendiente = Math.max(0, it.cantidad_ordenada - acumulado);
    return `
    <div class="req-item-row" data-oc-item="${it.id}">
      <div class="item-title">${esc(it.insumo_concepto)}</div>
      <div class="code muted">${esc(it.insumo_codigo)} · ordenado: ${fmtNum(it.cantidad_ordenada, 3)} ${esc(it.unidad || '')} · recibido a la fecha: ${fmtNum(acumulado, 3)} ${esc(it.unidad || '')}</div>
      <div class="qty-row">
        <div><label>Cantidad recibida ahora</label><input type="number" min="0" step="any" data-rec-cantidad data-pendiente="${pendiente}" data-ordenado="${it.cantidad_ordenada}" data-acumulado="${acumulado}" value="0" /></div>
        <div class="muted fs-076-end" data-rec-faltante>faltarían: ${fmtNum(pendiente, 3)} ${esc(it.unidad || '')}</div>
      </div>
    </div>`;
  }).join('');

  $$('#recItems [data-rec-cantidad]').forEach((inp) => {
    inp.addEventListener('input', () => {
      const ordenado = Number(inp.dataset.ordenado);
      const acumulado = Number(inp.dataset.acumulado);
      const cantidad = Math.max(0, Number(inp.value) || 0);
      const faltante = Math.max(0, ordenado - (acumulado + cantidad));
      const out = inp.closest('.qty-row').querySelector('[data-rec-faltante]');
      out.textContent = faltante > 0 ? `faltarían: ${fmtNum(faltante, 3)}` : '✓ completo';
      out.style.color = faltante > 0 ? 'var(--red)' : 'var(--green)';
    });
  });

  $('#btnCancelRec').addEventListener('click', closeModal);
  $('#btnSaveRec').addEventListener('click', async () => {
    const items = $$('#recItems [data-rec-cantidad]')
      .map((inp) => ({
        orden_compra_item_id: Number(inp.closest('[data-oc-item]').dataset.ocItem),
        cantidad_recibida: Number(inp.value) || 0,
      }))
      .filter((it) => it.cantidad_recibida > 0);
    if (!items.length) { toast('Indica una cantidad mayor a 0 en al menos un item', 'danger'); return; }

    const btn = $('#btnSaveRec');
    btn.disabled = true; btn.textContent = 'Guardando…';
    try {
      const result = await api(`/projects/${state.projectId}/ordenes/${orden.id}/recepciones`, {
        method: 'POST',
        body: { fecha: $('#recFecha').value || null, recibido_por: $('#recPor').value.trim() || null, observaciones: $('#recObs').value.trim() || null, items },
      });
      toast(result.tiene_alertas
        ? `Recepción guardada — hay faltantes. Estado de la orden: ${result.estado_orden}`
        : `Recepción guardada. Estado de la orden: ${result.estado_orden}`, result.tiene_alertas ? 'danger' : 'success');
      await openOrdenDetalle(orden.id);
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false; btn.textContent = 'Guardar recepción';
    }
  });
}

function openRegistrarPagoModal(orden) {
  openModal(`
    <h3>Registrar pago</h3>
    <p class="muted">${esc(orden.folio || `OC #${orden.id}`)} — ${esc(orden.proveedor_nombre)}</p>
    <div class="field"><label>Fecha</label><input id="pagoFecha" type="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
    <div class="field"><label>Monto *</label><input id="pagoMonto" type="number" min="0" step="any" /></div>
    <div class="field">
      <label><input type="checkbox" id="pagoIncluyeIva" checked class="radio-inline" /> Este monto incluye IVA</label>
    </div>
    <div class="field"><label>Método</label><input id="pagoMetodo" placeholder="Transferencia, efectivo, cheque…" /></div>
    <div class="field"><label>Referencia</label><input id="pagoReferencia" placeholder="Folio, número de cheque…" /></div>
    <div class="field"><label>Observaciones</label><textarea id="pagoObs" rows="2"></textarea></div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelPago">Cerrar</button>
      <button class="btn btn-primary" id="btnSavePago">Guardar pago</button>
    </div>
  `);
  $('#pagoMonto').focus();
  $('#btnCancelPago').addEventListener('click', closeModal);
  $('#btnSavePago').addEventListener('click', async () => {
    const monto = Number($('#pagoMonto').value);
    if (!monto || monto <= 0) { toast('Indica un monto mayor a 0', 'danger'); return; }
    const btn = $('#btnSavePago');
    btn.disabled = true; btn.textContent = 'Guardando…';
    try {
      const result = await api(`/projects/${state.projectId}/ordenes/${orden.id}/pagos`, {
        method: 'POST',
        body: {
          fecha: $('#pagoFecha').value || null,
          monto,
          incluye_iva: $('#pagoIncluyeIva').checked,
          metodo: $('#pagoMetodo').value.trim() || null,
          referencia: $('#pagoReferencia').value.trim() || null,
          observaciones: $('#pagoObs').value.trim() || null,
        },
      });
      toast(result.alerta_sobrepago
        ? `Pago registrado — el saldo quedó negativo (sobrepago de ${fmtMoney(Math.abs(result.saldo_pendiente))})`
        : 'Pago registrado', result.alerta_sobrepago ? 'danger' : 'success');
      await openOrdenDetalle(orden.id);
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false; btn.textContent = 'Guardar pago';
    }
  });
}

// =========================================================================
// VISTA: Avance (semanal + físico-financiero)
// =========================================================================
async function renderAvance(view) {
  // Mismo guard que renderInicio/renderPrograma — /resumen es admin/desarrollador
  // solamente, y residente/cabo/logística sí tienen acceso a Avance.
  const puedeVerResumen = state.allowedTabs.includes('resumen');
  const [avances, resumen, misPermisosAvance] = await Promise.all([
    api(`/projects/${state.projectId}/avances`),
    puedeVerResumen ? cached('resumen', () => api(`/projects/${state.projectId}/resumen`)) : Promise.resolve(null),
    api(`/projects/${state.projectId}/mis-permisos/avance`),
  ]);
  const puedeEditar = !!misPermisosAvance.puede_crear;
  if (!avances.length) {
    view.innerHTML = `<div class="empty-state"><div class="big">📅</div>No fue posible generar la curva de avance: el presupuesto no contiene fechas de inicio y fin de obra.</div>`;
    return;
  }
  const presupuestoTotal = resumen?.presupuesto_total || 0;
  view.innerHTML = `
    <h2 class="section-title">Avance semanal</h2>
    <p class="muted">Curva programada (calculada a partir del presupuesto y las fechas de obra) contra el avance real que captures cada semana.</p>
    <div class="section-actions">
      <button class="btn" id="btnExportAvance">⭳ Exportar a Excel</button>
    </div>
    <div class="card"><div class="chart-wrap tall"><canvas id="chartSemanal"></canvas></div></div>

    <h3 class="section-title">Captura de avance real por semana</h3>
    <p class="muted">La columna "Presupuesto del periodo" muestra la cantidad presupuestada (en pesos) para esa semana, según la curva programada — úsala como referencia para anotar tu avance real de esa misma semana. Toca <strong>"Por concepto"</strong> para anotar las cantidades realmente ejecutadas de cada concepto del catálogo (con su descripción, unidad y cantidad presupuestada) — el % de avance real se calculará automáticamente a partir de esas cantidades.</p>
    <div class="card">
      <div class="table-scroll">
        <table>
          <thead><tr><th>Semana</th><th>Periodo</th><th class="num">Presupuesto del periodo</th><th class="num">Programado acum.</th><th class="num">Físico real %</th><th class="num">Financiero real %</th><th>Autorización</th><th></th></tr></thead>
          <tbody id="avanceTbody"></tbody>
        </table>
      </div>
    </div>

    <h3 class="section-title">Avance físico-financiero acumulado</h3>
    <div class="card"><div class="chart-wrap tall"><canvas id="chartFisFin"></canvas></div></div>
  `;

  wireExportButton('#btnExportAvance', `/projects/${state.projectId}/avances/export`);
  paintAvanceChart(avances);
  paintFisFinChart(avances);
  paintAvanceTable(avances, presupuestoTotal, puedeEditar);
}

function paintAvanceChart(avances) {
  const ctx = $('#chartSemanal').getContext('2d');
  const labels = avances.map((a) => `S${a.semana}`);
  const cc = chartColors();
  state.charts.semanal = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Programado (financiero) %', data: avances.map((a) => a.avance_financiero_programado), borderColor: '#38bdf8', backgroundColor: 'rgba(56,189,248,0.12)', tension: 0.25, fill: true },
        { label: 'Real financiero %', data: avances.map((a) => a.avance_financiero_real), borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,0.12)', tension: 0.25, spanGaps: true },
        { label: 'Real físico %', data: avances.map((a) => a.avance_fisico_real), borderColor: '#eab308', backgroundColor: 'rgba(234,179,8,0.1)', borderDash: [6, 4], tension: 0.25, spanGaps: true },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: animationForChart(`semanal:${state.projectId}`),
      scales: {
        x: { ticks: { color: cc.tick, maxRotation: 0, autoSkip: true, font: { size: 10 } }, grid: { color: cc.grid } },
        y: { min: 0, max: 100, ticks: { color: cc.tick, callback: (v) => `${v}%` }, grid: { color: cc.grid } },
      },
      plugins: { legend: { position: 'bottom', labels: { color: cc.text, boxWidth: 14, font: { size: 11 } } } },
    },
  });
}

function paintFisFinChart(avances) {
  const ctx = $('#chartFisFin').getContext('2d');
  const labels = avances.map((a) => `S${a.semana}`);
  const programado = avances.map((a) => a.avance_financiero_programado);
  const ejecutado = avances.map((a) => a.avance_financiero_real);
  const porEjecutar = avances.map((a) => {
    if (a.avance_financiero_programado == null) return null;
    return Math.max(0, a.avance_financiero_programado - (a.avance_financiero_real ?? 0));
  });
  const cc = chartColors();
  state.charts.fisfin = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Presupuestado (programado) %', data: programado, backgroundColor: 'rgba(56,189,248,0.55)', borderRadius: 4 },
        { label: 'Ejecutado %', data: ejecutado, backgroundColor: 'rgba(34,197,94,0.75)', borderRadius: 4 },
        { label: 'Por ejecutar %', data: porEjecutar, backgroundColor: 'rgba(148,163,184,0.35)', borderRadius: 4 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: animationForChart(`fisfin:${state.projectId}`),
      scales: {
        x: { stacked: false, ticks: { color: cc.tick, maxRotation: 0, autoSkip: true, font: { size: 10 } }, grid: { display: false } },
        y: { min: 0, max: 100, ticks: { color: cc.tick, callback: (v) => `${v}%` }, grid: { color: cc.grid } },
      },
      plugins: { legend: { position: 'bottom', labels: { color: cc.text, boxWidth: 14, font: { size: 11 } } } },
    },
  });
}

function paintAvanceTable(avances, presupuestoTotal, puedeEditar) {
  const tbody = $('#avanceTbody');
  tbody.innerHTML = avances.map((a, idx) => {
    const prevPct = idx > 0 ? (avances[idx - 1].avance_financiero_programado || 0) : 0;
    const pctPeriodo = Math.max(0, (a.avance_financiero_programado || 0) - prevPct);
    const importePeriodo = presupuestoTotal * (pctPeriodo / 100);
    const estadoAut = a.estado_autorizacion || 'autorizado';
    const autBadge = { autorizado: 'green', pendiente_autorizacion: 'yellow', rechazado: 'red' }[estadoAut] || 'muted';
    const autLabel = { autorizado: 'Autorizado', pendiente_autorizacion: 'Pendiente', rechazado: 'Rechazado' }[estadoAut] || estadoAut;
    return `
    <tr data-semana="${a.semana}">
      <td>${a.semana}</td>
      <td>${fmtDate(a.fecha_inicio)} – ${fmtDate(a.fecha_fin)}</td>
      ${puedeVerImportesAvance() ? `<td class="num">${fmtMoney(importePeriodo)}<br><span class="muted fs-07">(${fmtPct(pctPeriodo)} del total)</span></td>` : '<td class="num">—</td>'}
      <td class="num">${fmtPct(a.avance_financiero_programado)}</td>
      <td class="num"><input type="number" min="0" max="100" step="0.1" data-field="avance_fisico_real" value="${a.avance_fisico_real ?? ''}" class="w-84-right" ${!puedeEditar ? 'disabled' : ''} /></td>
      <td class="num">${puedeVerImportesAvance() ? `<input type="number" min="0" max="100" step="0.1" data-field="avance_financiero_real" value="${a.avance_financiero_real ?? ''}" class="w-84-right" ${!puedeEditar ? 'disabled' : ''} />` : '—'}</td>
      <td>
        <span class="badge ${autBadge}">${autLabel}</span>
        ${isAdmin() && estadoAut === 'pendiente_autorizacion' ? `
        <div class="row row-nowrap-gap4-mt4">
          <button class="btn small btn-auth" data-autorizar="${a.semana}" data-accion="autorizado">Autorizar</button>
          <button class="btn small btn-danger btn-auth" data-autorizar="${a.semana}" data-accion="rechazado">Rechazar</button>
        </div>` : ''}
      </td>
      <td>
        ${puedeEditar ? `<div class="row row-nowrap-gap6">
          <button class="btn small" data-detalle="${a.semana}" title="Capturar avance por concepto">Por concepto</button>
          <button class="btn small btn-primary" data-save="${a.semana}">Guardar</button>
        </div>` : `<button class="btn small" data-detalle="${a.semana}" title="Ver avance por concepto">Ver detalle</button>`}
      </td>
    </tr>
  `;
  }).join('');

  $$('[data-detalle]', tbody).forEach((btn) => {
    btn.addEventListener('click', () => {
      const semana = Number(btn.dataset.detalle);
      const avance = avances.find((a) => a.semana === semana);
      if (avance) openAvanceConceptosModal(avance, presupuestoTotal, puedeEditar);
    });
  });

  $$('[data-autorizar]', tbody).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const semana = Number(btn.dataset.autorizar);
      const accion = btn.dataset.accion;
      btn.disabled = true;
      try {
        await api(`/projects/${state.projectId}/avances/${semana}/autorizacion`, { method: 'PUT', body: { estado: accion } });
        toast(accion === 'autorizado' ? `Avance de la semana ${semana} autorizado` : `Avance de la semana ${semana} rechazado`, 'success');
        renderView();
      } catch (err) {
        toast(err.message, 'danger');
        btn.disabled = false;
      }
    });
  });

  $$('[data-save]', tbody).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tr = btn.closest('tr');
      const semana = Number(tr.dataset.semana);
      const fisico = tr.querySelector('[data-field="avance_fisico_real"]').value;
      const financiero = tr.querySelector('[data-field="avance_financiero_real"]').value;
      btn.disabled = true; btn.textContent = '…';
      try {
        await api(`/projects/${state.projectId}/avances/${semana}`, {
          method: 'PUT',
          body: { avance_fisico_real: fisico === '' ? null : Number(fisico), avance_financiero_real: financiero === '' ? null : Number(financiero) },
        });
        invalidate('resumen');
        toast(`Avance de la semana ${semana} guardado`, 'success');
        renderView();
      } catch (err) {
        toast(err.message, 'danger');
        btn.disabled = false; btn.textContent = 'Guardar';
      }
    });
  });
}

// Modal: captura de avance físico real por concepto del catálogo (descripción,
// unidad y cantidad presupuestada como referencia, cantidad ejecutada en el
// periodo como captura). El % de avance real de la semana se recalcula solo.
async function openAvanceConceptosModal(avance, presupuestoTotal, puedeEditar = true) {
  const semana = avance.semana;
  openModal(`
    <h3>Avance físico por concepto — Semana ${semana}</h3>
    <p class="muted">${fmtDate(avance.fecha_inicio)} – ${fmtDate(avance.fecha_fin)}<br>
      ${puedeEditar
        ? 'Anota la cantidad realmente ejecutada de cada concepto del catálogo durante este periodo (no acumulada — solo lo avanzado en esta semana). El % de avance real se calculará automáticamente a partir de estas cantidades y se guardará en la tabla semanal.'
        : 'Solo consulta — no tienes permiso para modificar el avance de esta obra.'}</p>
    <div id="avcList"><div class="spinner"></div></div>
    <div class="card hidden-initial" id="avcSummary">
      <div class="card-row"><span class="k">Importe ejecutado acumulado a la fecha</span><span class="v" id="avcImporte">—</span></div>
      <div class="card-row"><span class="k">% de avance real (se guardará así)</span><span class="v" id="avcPct">—</span></div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelAvc">Cerrar</button>
      ${puedeEditar ? '<button class="btn btn-primary" id="btnSaveAvc">Guardar avance</button>' : ''}
    </div>
  `);
  $('#btnCancelAvc').addEventListener('click', closeModal);

  let items = [];
  try {
    const data = await api(`/projects/${state.projectId}/avances/${semana}/conceptos`);
    items = data.items;
  } catch (err) {
    $('#avcList').innerHTML = `<div class="alert-box danger">⚠️${esc(err.message)}</div>`;
    return;
  }

  if (!items.length) {
    $('#avcList').innerHTML = '<p class="muted">El catálogo no tiene conceptos con cantidad y unidad presupuestadas para capturar avance.</p>';
    return;
  }

  const groups = new Map();
  items.forEach((c) => {
    const key = c.grupo || 'General';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  });

  $('#avcList').innerHTML = [...groups.entries()].map(([grupo, groupItems]) => `
    <h3 class="section-title mt14-mb8">${esc(grupo)}</h3>
    ${groupItems.map((c) => {
      const pendientes = c.insumos_pendientes || [];
      const bloqueado = pendientes.length > 0;
      return `
    <div class="req-item-row">
      <div class="fw600-fs086">${esc(c.concepto)}</div>
      <div class="code muted">${esc(c.codigo)} · presup: ${fmtNum(c.cantidad_presupuesto, 3)} ${esc(c.unidad || '')} a ${fmtMoney(c.precio_unitario)}/u</div>
      <div class="qty-row mt-6">
        <div>
          <label>Acumulado previo</label>
          <div class="muted acumulado-previo">${fmtNum(c.cantidad_acumulada_previa, 3)} ${esc(c.unidad || '')}</div>
        </div>
        <div>
          <label>Ejecutado este periodo</label>
          <input type="number" min="0" step="0.01" data-cantidad="${c.concepto_id}"
                 data-precio="${c.precio_unitario}" data-presup="${c.cantidad_presupuesto}" data-prev="${c.cantidad_acumulada_previa}"
                 value="${c.cantidad_ejecutada_periodo ?? ''}" ${(puedeEditar && !bloqueado) ? '' : 'disabled'}
                 ${bloqueado ? `title="Faltan insumos por entregar en obra: ${esc(pendientes.map((p) => p.insumo_nombre).join(', '))}"` : ''} />
        </div>
        <div class="muted acum-out" data-acum-out></div>
      </div>
      ${bloqueado ? `<div class="muted solo-lectura-note">🔒 Falta entrega de: ${esc(pendientes.map((p) => p.insumo_nombre).join(', '))}</div>` : ''}
    </div>
    `;
    }).join('')}
  `).join('');

  const updateRowOutput = (inp) => {
    const prev = Number(inp.dataset.prev) || 0;
    const cantidad = inp.value === '' ? 0 : Math.max(0, Number(inp.value));
    const acumActual = prev + cantidad;
    const presup = Number(inp.dataset.presup) || 0;
    const out = inp.closest('.qty-row').querySelector('[data-acum-out]');
    if (out) out.innerHTML = `acum: ${fmtNum(acumActual, 3)}<br>de ${fmtNum(presup, 3)} (${fmtPct(presup ? (acumActual / presup) * 100 : 0)})`;
    return acumActual;
  };

  const recalc = () => {
    let importe = 0;
    $$('[data-cantidad]').forEach((inp) => {
      const acumActual = updateRowOutput(inp);
      importe += acumActual * (Number(inp.dataset.precio) || 0);
    });
    $('#avcImporte').textContent = fmtMoney(importe);
    $('#avcPct').textContent = presupuestoTotal ? fmtPct(Math.min(100, (importe / presupuestoTotal) * 100)) : '—';
  };

  $('#avcSummary').classList.remove('hidden-initial'); // ver .hidden-initial en styles.css
  $('#avcSummary').style.display = '';
  recalc();
  $$('[data-cantidad]').forEach((inp) => inp.addEventListener('input', recalc));

  if (puedeEditar) {
    $('#btnSaveAvc').addEventListener('click', async () => {
      const btn = $('#btnSaveAvc');
      const payloadItems = $$('[data-cantidad]').map((inp) => ({
        concepto_id: Number(inp.dataset.cantidad),
        cantidad_ejecutada: inp.value === '' ? 0 : Math.max(0, Number(inp.value)),
      }));
      btn.disabled = true; btn.textContent = 'Guardando…';
      try {
        const result = await api(`/projects/${state.projectId}/avances/${semana}/conceptos`, { method: 'PUT', body: { items: payloadItems } });
        closeModal();
        invalidate('resumen');
        const pct = result.avance_calculado_pct;
        const base = pct != null ? `Avance de la semana ${semana} guardado: ${fmtPct(pct)} calculado` : `Avance por concepto de la semana ${semana} guardado`;
        const numOmitidos = result.omitidos?.length || 0;
        toast(numOmitidos > 0
          ? `${base} — ${numOmitidos} actividad(es) no se guardaron: falta entrega de insumos en obra`
          : base, numOmitidos > 0 ? 'danger' : 'success');
        renderView();
      } catch (err) {
        toast(err.message, 'danger');
        btn.disabled = false; btn.textContent = 'Guardar avance';
      }
    });
  }
}

// =========================================================================
// VISTA: Programa de ejecución (Gantt simple)
// =========================================================================
async function renderPrograma(view) {
  // /resumen expone datos financieros agregados de la obra — admin/desarrollador
  // solamente (auth.allow() sin roles operativos, a propósito). Residente/cabo/
  // compras/logística sí pueden ver Programa, así que no debe depender de esa
  // llamada: mismo guard que ya usa renderInicio (ver más abajo).
  const puedeVerResumen = state.allowedTabs.includes('resumen');
  const [programa, resumen] = await Promise.all([
    api(`/projects/${state.projectId}/programa`),
    puedeVerResumen ? cached('resumen', () => api(`/projects/${state.projectId}/resumen`)) : Promise.resolve(null),
  ]);
  if (!programa.length) {
    view.innerHTML = `<div class="empty-state"><div class="big">🗓️</div>No fue posible generar el programa de ejecución: el presupuesto no contiene fechas de inicio y fin de obra, o no tiene conceptos con cantidades.</div>`;
    return;
  }
  const obraInicio = resumen?.meta?.inicio_obra || null;
  const obraFin = resumen?.meta?.fin_obra || null;
  const start = new Date(`${programa.reduce((min, p) => (p.fecha_inicio < min ? p.fecha_inicio : min), programa[0].fecha_inicio)}T00:00:00`);
  const end = new Date(`${programa.reduce((max, p) => (p.fecha_fin > max ? p.fecha_fin : max), programa[0].fecha_fin)}T00:00:00`);
  const totalDays = Math.max(1, Math.round((end - start) / 86400000) + 1);

  const groups = new Map();
  programa.forEach((p) => {
    const key = p.grupo || 'General';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  });

  view.innerHTML = `
    <h2 class="section-title">Programa de ejecución de los trabajos</h2>
    <p class="muted">Generado automáticamente a partir de las fechas de obra y el peso económico de cada concepto dentro de su frente de trabajo. Del ${fmtDate(programa[0] && start.toISOString().slice(0,10))} al ${fmtDate(end.toISOString().slice(0,10))} (${totalDays} días). Toca las fechas de una actividad para ajustarlas.</p>
    ${[...groups.entries()].map(([grupo, items]) => `
      <h3 class="section-title">${esc(grupo)}</h3>
      <div class="card">
        ${items.map((p) => {
          const offset = Math.max(0, Math.round((new Date(`${p.fecha_inicio}T00:00:00`) - start) / 86400000));
          const left = (offset / totalDays) * 100;
          const width = Math.max(1.5, (p.duracion_dias / totalDays) * 100);
          const pct = p.avance_pct || 0;
          const pctLabel = pct > 0 ? `<span class="gantt-prog-label ${pct >= 100 ? 'done' : ''}">${fmtNum(pct, 1)}%</span>` : '';
          return `
          <div class="gantt-row">
            <div class="gantt-label">
              ${esc(p.concepto)}
              <span class="g">${esc(p.codigo)} · ${fmtMoney(p.importe)} (${fmtPct(p.peso_pct * 100)})</span>
            </div>
            <div class="gantt-track">
              <div class="gantt-bar" data-left="${left}" data-width="${width}">
                ${pct > 0 ? `<div class="gantt-bar-inner" data-pct="${Math.min(100, pct)}"></div>` : ''}
              </div>
            </div>
            <div class="gantt-dates-wrap">
              ${pctLabel}
              <button class="gantt-dates" data-edit-fechas="${p.id}" title="Editar fechas">${fmtDate(p.fecha_inicio)}<br>${fmtDate(p.fecha_fin)} <span class="muted">✏️</span></button>
            </div>
          </div>`;
        }).join('')}
      </div>
    `).join('')}
  `;

  $$('.gantt-bar[data-left]', view).forEach((bar) => {
    bar.style.left = bar.dataset.left + '%';
    bar.style.width = bar.dataset.width + '%';
  });
  $$('.gantt-bar-inner[data-pct]', view).forEach((inner) => { inner.style.width = inner.dataset.pct + '%'; });

  $$('[data-edit-fechas]', view).forEach((btn) => {
    btn.addEventListener('click', () => openEditFechasModal(Number(btn.dataset.editFechas), programa, obraInicio, obraFin));
  });
}

function openEditFechasModal(itemId, programa, obraInicio, obraFin) {
  const item = programa.find((p) => p.id === itemId);
  if (!item) return;
  openModal(`
    <h3>Ajustar fechas de la actividad</h3>
    <p class="muted">${esc(item.concepto)}<br><span class="code">${esc(item.codigo)}</span></p>
    <div class="field"><label>Fecha de inicio</label><input id="editFechaInicio" type="date" value="${esc(item.fecha_inicio)}" ${obraInicio ? `min="${esc(obraInicio)}"` : ''} ${obraFin ? `max="${esc(obraFin)}"` : ''} /></div>
    <div class="field"><label>Fecha de fin</label><input id="editFechaFin" type="date" value="${esc(item.fecha_fin)}" ${obraInicio ? `min="${esc(obraInicio)}"` : ''} ${obraFin ? `max="${esc(obraFin)}"` : ''} /></div>
    ${obraInicio && obraFin ? `<p class="muted fs-076">El periodo de obra cargado del presupuesto va del ${fmtDate(obraInicio)} al ${fmtDate(obraFin)} — las fechas de la actividad deben quedar dentro de ese rango.</p>` : ''}
    <div class="modal-actions">
      <button class="btn" id="btnCancelFechas">Cerrar</button>
      <button class="btn btn-primary" id="btnSaveFechas">Guardar</button>
    </div>
  `);
  $('#btnCancelFechas').addEventListener('click', closeModal);
  $('#btnSaveFechas').addEventListener('click', async () => {
    const btn = $('#btnSaveFechas');
    const fecha_inicio = $('#editFechaInicio').value;
    const fecha_fin = $('#editFechaFin').value;
    if (!fecha_inicio || !fecha_fin) { toast('Indica ambas fechas', 'danger'); return; }
    btn.disabled = true; btn.textContent = 'Guardando…';
    try {
      await api(`/projects/${state.projectId}/programa/${itemId}`, { method: 'PUT', body: { fecha_inicio, fecha_fin } });
      closeModal();
      invalidate('programa');
      toast('Fechas de la actividad actualizadas', 'success');
      renderView();
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false; btn.textContent = 'Guardar';
    }
  });
}

// =========================================================================
// VISTA: Control de Destajo
// =========================================================================
async function renderDestajo(view) {
  const destajistas = await api(`/projects/${state.projectId}/destajistas`);
  const totalAsig = destajistas.reduce((s, d) => s + d.total_asignado, 0);
  const totalGanado = destajistas.reduce((s, d) => s + d.total_ganado, 0);
  // Ocultamiento visual adicional al bloqueo server-side ya existente (ver
  // precio_destajo en POST/PUT .../items en server/app.js, que ya ignora el
  // campo en silencio sin este permiso) — un residente sin puede_editar_precios
  // ya no ve el precio como editable, para no sugerir que su cambio se guarda.
  const permisos = await cached('permisosMe', () => api(`/permisos/me?obra_id=${state.projectId}`));
  const puedeEditarPrecios = !!permisos?.destajo?.puede_editar_precios;

  view.innerHTML = `
    <h2 class="section-title">Control de Destajo ${renderHelpBtn('destajo')}</h2>
    <p class="muted">El avance de cada destajista se captura por semana, usando los mismos periodos del programa de obra — igual que en la pestaña Avance.</p>
    ${destajistas.length ? `
    <div class="kpi-grid mb-4">
      <div class="kpi"><div class="label">Destajistas</div><div class="value">${destajistas.length}</div></div>
      <div class="kpi accent"><div class="label">Total asignado</div><div class="value">${fmtMoney(totalAsig)}</div></div>
      <div class="kpi green"><div class="label">Total ganado</div><div class="value">${fmtMoney(totalGanado)}</div></div>
    </div>` : ''}
    ${(canManageDestajo() || destajistas.length) ? `
    <div class="section-actions">
      ${canManageDestajo() ? '<button class="btn btn-primary" id="btnNuevoDest">+ Nuevo destajista</button>' : ''}
      ${destajistas.length ? '<button class="btn" id="btnExportDestajo">⭳ Exportar a Excel</button>' : ''}
    </div>` : ''}
    ${destajistas.length === 0 ? `
      <div class="empty-state">
        <div class="big">👷</div>
        <p>No hay destajistas registrados.</p>
        <p>${canManageDestajo()
          ? 'Agrega trabajadores y asígnales los conceptos que ejecutarán a destajo.<br>Si tu Excel tenía una hoja llamada "Destajo" o "Destajistas", se importó automáticamente al cargar el presupuesto.'
          : 'Aún no hay destajistas registrados en este presupuesto.'}</p>
      </div>
    ` : destajistas.map((d) => renderDestajistaCard(d, puedeEditarPrecios)).join('')}
  `;

  $$('.dest-progress > span[data-pct]', view).forEach((span) => { span.style.width = span.dataset.pct + '%'; });

  $('#btnNuevoDest')?.addEventListener('click', () => openNuevoDestajistaModal());
  wireExportButton('#btnExportDestajo', `/projects/${state.projectId}/destajistas/export`);

  $$('[data-edit-dest]', view).forEach((btn) => {
    btn.addEventListener('click', () => {
      const d = destajistas.find((x) => x.id === Number(btn.dataset.editDest));
      if (d) openEditDestajistaModal(d);
    });
  });

  $$('[data-del-dest]', view).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const destId = Number(btn.dataset.delDest);
      const d = destajistas.find((x) => x.id === destId);
      if (!d) return;
      if (!confirm(`¿Eliminar a "${d.nombre}" y todas sus actividades? Esta acción no se puede deshacer.`)) return;
      try {
        await api(`/projects/${state.projectId}/destajistas/${destId}`, { method: 'DELETE' });
        toast('Destajista eliminado', 'success');
        renderView();
      } catch (err) { toast(err.message, 'danger'); }
    });
  });

  $$('[data-add-item]', view).forEach((btn) => {
    btn.addEventListener('click', () => openAgregarItemModal(Number(btn.dataset.addItem), destajistas, puedeEditarPrecios));
  });

  $$('[data-save-item]', view).forEach((inp) => {
    inp.addEventListener('blur', async function () {
      const itemId = Number(this.dataset.itemId);
      const destId = Number(this.dataset.destId);
      const field = this.dataset.field;
      const value = Math.max(0, Number(this.value) || 0);
      this.value = value;
      try {
        await api(`/projects/${state.projectId}/destajistas/${destId}/items/${itemId}`, {
          method: 'PUT',
          body: { [field]: value },
        });
        toast('Actividad actualizada', 'success');
        renderView();
      } catch (err) { toast(err.message, 'danger'); }
    });
  });

  $$('[data-del-item]', view).forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('¿Eliminar esta actividad?')) return;
      const itemId = Number(btn.dataset.itemId);
      const destId = Number(btn.dataset.destId);
      try {
        await api(`/projects/${state.projectId}/destajistas/${destId}/items/${itemId}`, { method: 'DELETE' });
        toast('Actividad eliminada', 'success');
        renderView();
      } catch (err) { toast(err.message, 'danger'); }
    });
  });

  $$('[data-toggle-semanal]', view).forEach((btn) => {
    btn.addEventListener('click', () => toggleDestajoSemanal(btn, destajistas));
  });
}

function renderDestajistaCard(d, puedeEditarPrecios) {
  const pct = Math.round(d.pct_avance || 0);
  return `
  <div class="card mb-12" data-dest-card="${d.id}">
    <div class="row between">
      <div>
        <strong class="fs-1rem">${esc(d.nombre)}</strong>
        ${d.telefono ? `<div class="muted fs-08">📞 ${esc(d.telefono)}</div>` : ''}
      </div>
      ${canManageDestajo() ? `
      <div class="row row-nowrap-gap6">
        <button class="btn small" data-edit-dest="${d.id}" title="Editar destajista">✏️ Editar</button>
        <button class="btn small btn-danger" data-del-dest="${d.id}">Eliminar</button>
      </div>` : ''}
    </div>
    <div class="row dest-card-stats">
      <span class="muted">${d.items.length} actividad${d.items.length !== 1 ? 'es' : ''}</span>
      <span>Asig: ${fmtMoney(d.total_asignado)}</span>
      <span class="text-verde">Ganado: ${fmtMoney(d.total_ganado)}</span>
      <span class="badge ${pct >= 100 ? 'green' : 'yellow'}">${pct}%</span>
    </div>
    <div class="progress-bar dest-progress"><span data-pct="${Math.min(100, pct)}"></span></div>
    ${renderDestajistaItems(d, puedeEditarPrecios)}
    ${canManageDestajo() ? `
    <div class="row mt-8">
      <button class="btn small" data-add-item="${d.id}">+ Agregar actividad</button>
    </div>` : ''}
    <button class="collapse-toggle mt-12" data-toggle-semanal="${d.id}">
      <span>📅 Avance semanal (periodos del programa de obra)</span>
      <span class="chev">▾</span>
    </button>
    <div class="collapse-body" id="semanalBody-${d.id}"></div>
  </div>`;
}

async function toggleDestajoSemanal(btn, destajistas) {
  const destId = Number(btn.dataset.toggleSemanal);
  const body = document.getElementById(`semanalBody-${destId}`);
  const isOpen = btn.classList.toggle('open');
  body.classList.toggle('open', isOpen);
  if (!isOpen || body.dataset.loaded) return;
  body.dataset.loaded = '1';
  body.innerHTML = '<div class="spinner"></div>';
  try {
    const data = await api(`/projects/${state.projectId}/destajistas/${destId}/avance`);
    if (!data.semanas.length) {
      // "Corregir inicio/fin de obra" necesita /resumen (admin/desarrollador
      // solamente) — mismo guard que renderInicio/renderPrograma/renderAvance:
      // se oculta en vez de tronar al usuario sin acceso.
      const puedeVerResumen = state.allowedTabs.includes('resumen');
      body.innerHTML = `
        <div class="py10-px4">
          <p class="muted m0-0-8">El proyecto no tiene periodos de programa de obra generados (faltan las fechas de inicio/fin de obra).</p>
          ${puedeVerResumen
            ? `<button class="btn small btn-primary" id="btnFixFechasObra${destId}">Corregir inicio/fin de obra</button>`
            : `<p class="muted fs-08">Pide a un administrador que corrija las fechas de inicio/fin de la obra.</p>`}
        </div>`;
      if (puedeVerResumen) {
        $(`#btnFixFechasObra${destId}`, body).addEventListener('click', async () => {
          const resumen = await cached('resumen', () => api(`/projects/${state.projectId}/resumen`));
          openEditFechasObraModal(resumen.meta);
        });
      }
      return;
    }
    const dest = destajistas.find((d) => d.id === destId);
    body.innerHTML = `
      <div class="card mt10-panel2">
        <div class="chart-wrap chart-h220"><canvas id="chartDestajo${destId}"></canvas></div>
      </div>
      <div class="table-scroll mt-8">
        <table>
          <thead><tr><th>Semana</th><th>Periodo</th><th class="num">Ganado del periodo</th><th class="num">Acumulado</th><th class="num">% Avance</th><th></th></tr></thead>
          <tbody id="semanalTbody${destId}"></tbody>
        </table>
      </div>
    `;
    paintDestajoSemanaChart(destId, data.semanas);
    paintDestajoSemanaTable(destId, data.semanas, dest ? dest.nombre : '');
  } catch (err) {
    body.innerHTML = `<div class="alert-box danger">⚠️${esc(err.message)}</div>`;
  }
}

function paintDestajoSemanaChart(destId, semanas) {
  const canvas = document.getElementById(`chartDestajo${destId}`);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const key = `destajo_${destId}`;
  if (state.charts[key]) state.charts[key].destroy();
  // FIX (prompt-fix-chart-y-2-paletas-nuevas.md): tick/grid antes hardcodeados
  // a los valores de Dorada dark ('#94a3b8'/'#334155') sin pasar por
  // chartColors() — este era el único de los 5 charts que ni siquiera lo
  // llamaba. borderColor del line ('#22c55e') es semántico (verde = avance),
  // no cambia entre paletas, igual que en el resto de la app.
  const cc = chartColors();
  state.charts[key] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: semanas.map((s) => `S${s.semana}`),
      datasets: [{
        label: '% avance acumulado',
        data: semanas.map((s) => s.pct_acumulado),
        borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,0.14)', tension: 0.25, fill: true,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: animationForChart(key),
      scales: {
        x: { ticks: { color: cc.tick, maxRotation: 0, autoSkip: true, font: { size: 10 } }, grid: { color: cc.grid } },
        y: { min: 0, max: 100, ticks: { color: cc.tick, callback: (v) => `${v}%` }, grid: { color: cc.grid } },
      },
      plugins: { legend: { display: false } },
    },
  });
}

function paintDestajoSemanaTable(destId, semanas, nombre) {
  const tbody = document.getElementById(`semanalTbody${destId}`);
  if (!tbody) return;
  tbody.innerHTML = semanas.map((s) => {
    const estadoAut = s.estado_autorizacion || 'autorizado';
    const autBadge = { autorizado: 'green', pendiente_autorizacion: 'yellow', rechazado: 'red' }[estadoAut] || 'muted';
    const autLabel = { autorizado: 'Autorizado', pendiente_autorizacion: 'Pendiente', rechazado: 'Rechazado' }[estadoAut] || estadoAut;
    return `
    <tr>
      <td>${s.semana}</td>
      <td>${fmtDate(s.fecha_inicio)} – ${fmtDate(s.fecha_fin)}</td>
      <td class="num">${fmtMoney(s.ganado_periodo)}</td>
      <td class="num">${fmtMoney(s.ganado_acumulado)}</td>
      <td class="num">${fmtPct(s.pct_acumulado)}</td>
      <td>
        <span class="badge ${autBadge}">${autLabel}</span>
        ${isAdmin() && estadoAut === 'pendiente_autorizacion' ? `
        <div class="row row-nowrap-gap4-mt4">
          <button class="btn small btn-auth" data-autorizar-dest="${s.semana}" data-dest-id="${destId}" data-accion="autorizado">Autorizar</button>
          <button class="btn small btn-danger btn-auth" data-autorizar-dest="${s.semana}" data-dest-id="${destId}" data-accion="rechazado">Rechazar</button>
        </div>` : ''}
        <div class="mt-4"><button class="btn small btn-primary" data-capturar-semana="${s.semana}" data-dest-id="${destId}">Capturar</button></div>
      </td>
    </tr>
  `;
  }).join('');
  $$('[data-capturar-semana]', tbody).forEach((btn) => {
    btn.addEventListener('click', () => openDestajoSemanaModal(Number(btn.dataset.destId), Number(btn.dataset.capturarSemana), nombre));
  });
  $$('[data-autorizar-dest]', tbody).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const semana = Number(btn.dataset.autorizarDest);
      const dId = Number(btn.dataset.destId);
      const accion = btn.dataset.accion;
      btn.disabled = true;
      try {
        await api(`/projects/${state.projectId}/destajistas/${dId}/avance/${semana}/autorizacion`, { method: 'PUT', body: { estado: accion } });
        toast(accion === 'autorizado' ? `Avance de destajo semana ${semana} autorizado` : `Avance de destajo semana ${semana} rechazado`, 'success');
        renderView();
      } catch (err) {
        toast(err.message, 'danger');
        btn.disabled = false;
      }
    });
  });
}

async function openDestajoSemanaModal(destId, semana, nombre) {
  openModal(`
    <h3>Avance de destajo — Semana ${semana}</h3>
    <p class="muted">${esc(nombre)}<br>Anota la cantidad realmente ejecutada de cada actividad durante este periodo
      (no acumulada — solo lo avanzado en esta semana). El % de avance se calcula automáticamente.</p>
    <div id="destAvcList"><div class="spinner"></div></div>
    <div class="card hidden-initial" id="destAvcSummary">
      <div class="card-row"><span class="k">Ganado acumulado a la fecha</span><span class="v" id="destAvcImporte">—</span></div>
      <div class="card-row"><span class="k">% de avance (se guardará así)</span><span class="v" id="destAvcPct">—</span></div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelDestAvc">Cerrar</button>
      <button class="btn btn-primary" id="btnSaveDestAvc">Guardar avance</button>
    </div>
  `);
  $('#btnCancelDestAvc').addEventListener('click', closeModal);

  let items = [];
  let totalAsignado = 0;
  try {
    const [data, todos] = await Promise.all([
      api(`/projects/${state.projectId}/destajistas/${destId}/avance/${semana}`),
      api(`/projects/${state.projectId}/destajistas`),
    ]);
    items = data.items;
    const dest = todos.find((d) => d.id === destId);
    totalAsignado = dest ? dest.total_asignado : 0;
  } catch (err) {
    $('#destAvcList').innerHTML = `<div class="alert-box danger">⚠️${esc(err.message)}</div>`;
    return;
  }

  if (!items.length) {
    $('#destAvcList').innerHTML = '<p class="muted">Este destajista no tiene actividades asignadas.</p>';
    return;
  }

  // Editar un valor ya capturado requiere residente/admin (mismo patrón de
  // permisos que Avance regular) — un 'cabo' solo puede capturar valores
  // nuevos; el backend es la autoridad real, esto es solo UX preventiva.
  const yaCapturado = (it) => it.cantidad_ejecutada_periodo != null && it.cantidad_ejecutada_periodo !== '';
  const soloLecturaParaMi = (it) => ['cabo', 'administracion'].includes(effectivePuesto()) && yaCapturado(it);

  $('#destAvcList').innerHTML = items.map((it) => `
    <div class="req-item-row">
      <div class="fw600-fs086">${esc(it.concepto)}</div>
      <div class="code muted">${esc(it.codigo || '')} · asig: ${fmtNum(it.cantidad_asignada, 3)} ${esc(it.unidad || '')} a ${fmtMoney(it.precio_destajo)}/u</div>
      <div class="qty-row mt-6">
        <div>
          <label>Acumulado previo</label>
          <div class="muted acumulado-previo">${fmtNum(it.cantidad_acumulada_previa, 3)} ${esc(it.unidad || '')}</div>
        </div>
        <div>
          <label>Ejecutado este periodo</label>
          <input type="number" min="0" step="0.01" data-destajo-cantidad="${it.destajo_item_id}"
                 data-precio="${it.precio_destajo}" data-prev="${it.cantidad_acumulada_previa}"
                 value="${it.cantidad_ejecutada_periodo ?? ''}" ${soloLecturaParaMi(it) ? 'disabled title="Solo un residente o administrador puede editar un avance ya capturado"' : ''} />
        </div>
        <div class="muted acum-out" data-acum-out></div>
      </div>
      ${soloLecturaParaMi(it) ? `<div class="muted solo-lectura-note">🔒 Ya capturado — solo residente/admin puede editarlo</div>` : ''}
    </div>
  `).join('');

  const updateRowOutput = (inp) => {
    const prev = Number(inp.dataset.prev) || 0;
    const cantidad = inp.value === '' ? 0 : Math.max(0, Number(inp.value));
    const acumActual = prev + cantidad;
    const out = inp.closest('.qty-row').querySelector('[data-acum-out]');
    if (out) out.innerHTML = `acum: ${fmtNum(acumActual, 3)}`;
    return acumActual;
  };

  const recalc = () => {
    let ganado = 0;
    $$('[data-destajo-cantidad]').forEach((inp) => {
      const acumActual = updateRowOutput(inp);
      ganado += acumActual * (Number(inp.dataset.precio) || 0);
    });
    $('#destAvcImporte').textContent = fmtMoney(ganado);
    $('#destAvcPct').textContent = totalAsignado ? fmtPct(Math.min(100, (ganado / totalAsignado) * 100)) : '—';
  };

  $('#destAvcSummary').classList.remove('hidden-initial'); // ver .hidden-initial en styles.css
  $('#destAvcSummary').style.display = '';
  recalc();
  $$('[data-destajo-cantidad]').forEach((inp) => inp.addEventListener('input', recalc));

  $('#btnSaveDestAvc').addEventListener('click', async () => {
    const btn = $('#btnSaveDestAvc');
    const payloadItems = $$('[data-destajo-cantidad]').map((inp) => ({
      destajo_item_id: Number(inp.dataset.destajoCantidad),
      cantidad_ejecutada: inp.value === '' ? 0 : Math.max(0, Number(inp.value)),
    }));
    btn.disabled = true; btn.textContent = 'Guardando…';
    try {
      const result = await api(`/projects/${state.projectId}/destajistas/${destId}/avance/${semana}`, { method: 'PUT', body: { items: payloadItems } });
      closeModal();
      toast(result.omitidos > 0
        ? `Avance guardado — ${result.omitidos} valor(es) ya capturados no se modificaron (requieren residente/admin)`
        : `Avance de destajo de la semana ${semana} guardado`, result.omitidos > 0 ? 'danger' : 'success');
      renderView();
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false; btn.textContent = 'Guardar avance';
    }
  });
}

function renderDestajistaItems(d, puedeEditarPrecios) {
  if (!d.items.length) {
    return `<p class="muted dest-item-empty">Sin actividades asignadas aún.</p>`;
  }
  const canManage = canManageDestajo();
  // El precio se oculta como editable si no se tiene puede_editar_precios,
  // aunque canManage sea true (residente sin ese permiso granular) — el
  // backend ya ignora en silencio este campo sin el permiso (ver
  // precio_destajo en PUT .../items en server/app.js); esto es solo para que
  // la UI no sugiera que el cambio sí se guarda.
  const canEditPrecio = canManage && puedeEditarPrecios;
  return `
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Actividad</th>
            <th class="num">Asig.</th>
            <th class="num">P.U. destajo</th>
            <th class="num">Ejecutado acum.</th>
            <th class="num">Ganado</th>
            ${canManage ? '<th></th>' : ''}
          </tr>
        </thead>
        <tbody>
          ${d.items.map((it) => `
          <tr data-item-row>
            <td>
              <div class="dest-item-concepto">${esc(it.concepto)}</div>
              ${it.codigo ? `<div class="code muted">${esc(it.codigo)}</div>` : ''}
              ${it.unidad ? `<div class="muted dest-item-unidad">${esc(it.unidad)}</div>` : ''}
              ${it.concepto_id ? `
                <div class="badge muted dest-item-partida">📋 Partida: ${esc(it.partida_grupo || 'Sin grupo')}</div>
              ` : `
                <div class="muted dest-item-manual">Actividad manual — sin partida del presupuesto</div>
              `}
            </td>
            <td class="num">
              ${canManage ? `
              <input type="number" min="0" step="0.01" class="dest-item-input"
                value="${it.cantidad_asignada}"
                data-save-item data-item-id="${it.id}" data-dest-id="${d.id}" data-field="cantidad_asignada" />
              ` : fmtNum(it.cantidad_asignada, 2)}
            </td>
            <td class="num">
              ${canEditPrecio ? `
              <input type="number" min="0" step="0.01" class="dest-item-input-precio"
                value="${it.precio_destajo}"
                data-save-item data-item-id="${it.id}" data-dest-id="${d.id}" data-field="precio_destajo" />
              ` : fmtMoney(it.precio_destajo)}
            </td>
            <td class="num">${fmtNum(it.cantidad_ejecutada, 2)} ${esc(it.unidad || '')}</td>
            <td class="num text-verde">${fmtMoney(it.cantidad_ejecutada * it.precio_destajo)}</td>
            ${canManage ? `
            <td>
              <button class="btn small btn-ghost" data-del-item data-item-id="${it.id}" data-dest-id="${d.id}" title="Eliminar">✕</button>
            </td>` : ''}
          </tr>`).join('')}
          <tr class="dest-item-total-row">
            <td colspan="4" class="dest-item-total-label">Total ganado:</td>
            <td class="num text-verde">${fmtMoney(d.total_ganado)}</td>
            ${canManage ? '<td></td>' : ''}
          </tr>
        </tbody>
      </table>
    </div>
    <p class="muted dest-item-footnote">El acumulado ejecutado se registra con "Capturar" en el avance semanal de abajo — igual que en la pestaña Avance.</p>`;
}

function openNuevoDestajistaModal() {
  openModal(`
    <h3>Nuevo destajista</h3>
    <div class="field"><label>Nombre *</label><input id="destNombre" placeholder="Ej. Juan López" /></div>
    <div class="field"><label>Teléfono (opcional)</label><input id="destTel" type="tel" placeholder="55 1234 5678" /></div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelDest">Cerrar</button>
      <button class="btn btn-primary" id="btnSaveDest">Crear destajista</button>
    </div>
  `);
  $('#destNombre').focus();
  $('#btnCancelDest').addEventListener('click', closeModal);
  $('#btnSaveDest').addEventListener('click', async () => {
    const nombre = $('#destNombre').value.trim();
    if (!nombre) { toast('Escribe el nombre del destajista', 'danger'); return; }
    const btn = $('#btnSaveDest');
    btn.disabled = true;
    try {
      await api(`/projects/${state.projectId}/destajistas`, {
        method: 'POST',
        body: { nombre, telefono: $('#destTel').value.trim() || null },
      });
      closeModal();
      toast(`${nombre} agregado`, 'success');
      renderView();
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false;
    }
  });
}

function openEditDestajistaModal(dest) {
  openModal(`
    <h3>Editar destajista</h3>
    <div class="field"><label>Nombre *</label><input id="destNombre" value="${esc(dest.nombre)}" /></div>
    <div class="field"><label>Teléfono (opcional)</label><input id="destTel" type="tel" placeholder="55 1234 5678" value="${esc(dest.telefono || '')}" /></div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelDest">Cerrar</button>
      <button class="btn btn-primary" id="btnSaveDest">Guardar cambios</button>
    </div>
  `);
  $('#destNombre').focus();
  $('#btnCancelDest').addEventListener('click', closeModal);
  $('#btnSaveDest').addEventListener('click', async () => {
    const nombre = $('#destNombre').value.trim();
    if (!nombre) { toast('Escribe el nombre del destajista', 'danger'); return; }
    const btn = $('#btnSaveDest');
    btn.disabled = true;
    try {
      await api(`/projects/${state.projectId}/destajistas/${dest.id}`, {
        method: 'PUT',
        body: { nombre, telefono: $('#destTel').value.trim() || null },
      });
      closeModal();
      toast('Destajista actualizado', 'success');
      renderView();
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false;
    }
  });
}

async function openAgregarItemModal(destId, destajistas, puedeEditarPrecios) {
  const dest = destajistas.find((d) => d.id === destId);
  if (!dest) return;

  let allConceptos = [];
  try {
    allConceptos = await cached('conceptos', () => api(`/projects/${state.projectId}/conceptos`));
    allConceptos = allConceptos.filter((c) => !c.es_total && c.unidad && c.cantidad > 0);
  } catch (e) { /* catalog might be empty */ }

  openModal(`
    <h3>Agregar actividad — ${esc(dest.nombre)}</h3>
    <div class="field">
      <label>Buscar en catálogo de conceptos</label>
      <div class="search-bar-fancy" id="conceptoSearchWrap">
        <span class="search-icon">🔍</span>
        <input id="buscarConcepto" placeholder="Escribe código o descripción…" autocomplete="off" />
        <button type="button" class="search-clear" id="btnClearConceptoSearch" title="Limpiar búsqueda">✕</button>
      </div>
      <div id="resultadosConcepto" class="project-list search-results-fancy search-results-box"></div>
    </div>
    <div class="field"><label>Concepto *</label><input id="itemConcepto" placeholder="Ej. Excavación en tierra" /></div>
    <div class="row gap-8">
      <div class="field flex-1"><label>Código</label><input id="itemCodigo" /></div>
      <div class="field flex-1"><label>Unidad</label><input id="itemUnidad" placeholder="M2, ML…" /></div>
    </div>
    <div class="row gap-8">
      <div class="field flex-1"><label>Cantidad asignada</label><input id="itemCant" type="number" min="0" step="any" /></div>
      ${puedeEditarPrecios ? `<div class="field flex-1"><label>P.U. destajo ($)</label><input id="itemPU" type="number" min="0" step="any" /></div>` : ''}
    </div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelItem">Cerrar</button>
      <button class="btn btn-primary" id="btnSaveItem">Agregar actividad</button>
    </div>
  `);

  let selConceptoId = null;
  const searchWrap = $('#conceptoSearchWrap');
  const searchInput = $('#buscarConcepto');
  const searchResults = $('#resultadosConcepto');

  function runConceptoSearch(raw) {
    const q = raw.trim();
    searchWrap.classList.toggle('has-value', !!q);
    if (!q) { searchResults.innerHTML = ''; return; }
    const norm = q.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const matches = allConceptos.filter((c) => {
      const hay = (c.concepto + ' ' + (c.codigo || '')).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      return hay.includes(norm);
    }).slice(0, 6);
    searchResults.innerHTML = matches.map((c) => `
      <div class="project-item search-result-item cursor-pointer" data-pick="${c.id}">
        <span class="pname">${esc(c.concepto)}</span>
        <span class="pmeta">${esc(c.codigo || '')} · ${esc(c.unidad || '')} · ${fmtNum(c.cantidad, 2)} · ${fmtMoney(c.precio_unitario)}/u</span>
        <span class="pmeta">📋 Partida: ${esc(c.grupo || 'Sin grupo')}</span>
      </div>`).join('') || `<p class="muted p-6">Sin resultados para "${esc(q)}"</p>`;

    $$('[data-pick]', searchResults).forEach((row) => {
      row.addEventListener('click', () => {
        const c = allConceptos.find((x) => x.id === Number(row.dataset.pick));
        if (!c) return;
        selConceptoId = c.id;
        searchInput.value = `${c.codigo ? c.codigo + ' · ' : ''}${c.concepto}`;
        searchWrap.classList.add('has-value');
        searchResults.innerHTML = '';
        $('#itemConcepto').value = c.concepto;
        $('#itemCodigo').value = c.codigo || '';
        $('#itemUnidad').value = c.unidad || '';
        if (!$('#itemCant').value) $('#itemCant').value = c.cantidad;
        // No autorrellenar P.U. destajo con c.precio_unitario: ese es el precio
        // unitario presupuestado TOTAL del concepto (materiales + mano de obra +
        // equipo), no la tarifa de mano de obra que corresponde aquí. Se deja en
        // blanco para captura manual del precio de destajo real.
      });
    });
  }

  searchInput.addEventListener('input', (e) => runConceptoSearch(e.target.value));
  $('#btnClearConceptoSearch').addEventListener('click', () => {
    searchInput.value = '';
    searchWrap.classList.remove('has-value');
    searchResults.innerHTML = '';
    searchInput.focus();
  });

  $('#btnCancelItem').addEventListener('click', closeModal);
  $('#btnSaveItem').addEventListener('click', async () => {
    const concepto = $('#itemConcepto').value.trim();
    if (!concepto) { toast('El concepto es requerido', 'danger'); return; }
    const btn = $('#btnSaveItem');
    btn.disabled = true;
    try {
      await api(`/projects/${state.projectId}/destajistas/${destId}/items`, {
        method: 'POST',
        body: {
          concepto_id: selConceptoId || null,
          codigo: $('#itemCodigo').value.trim() || null,
          concepto,
          unidad: $('#itemUnidad').value.trim() || null,
          cantidad_asignada: Number($('#itemCant').value) || 0,
          precio_destajo: Number($('#itemPU')?.value) || 0,
        },
      });
      closeModal();
      toast('Actividad agregada', 'success');
      renderView();
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false;
    }
  });
}

function openPostUploadModal(result) {
  const inicio = result.inicio_obra || '';
  const fin = result.fin_obra || '';
  const destMsg = result.destajistas > 0 ? `, ${result.destajistas} destajista${result.destajistas !== 1 ? 's' : ''}` : '';
  openModal(`
    <h3>✓ Presupuesto cargado</h3>
    <p class="muted">${result.conceptos} conceptos, ${result.insumos} insumos${destMsg}</p>
    <div class="field">
      <label>Nombre de la obra</label>
      <input id="postUploadNombre" value="${esc(result.nombre)}" placeholder="Ej. Torre A — Redes Altares" />
    </div>
    <div class="section-divider-14">
      <h4 class="m0-0-6">Fechas de obra detectadas</h4>
      <p class="muted fs078-mb10">Verifica las fechas del archivo. Si no aparecen o son incorrectas, corrígelas aquí — el Programa de ejecución se regenerará automáticamente.</p>
      <div class="field"><label>Inicio de obra</label><input id="postUploadInicio" type="date" value="${esc(inicio)}" /></div>
      <div class="field"><label>Fin de obra</label><input id="postUploadFin" type="date" value="${esc(fin)}" /></div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="btnSkipFechasPost">Omitir</button>
      <button class="btn btn-primary" id="btnGuardarFechasPost">Guardar</button>
    </div>
  `);

  async function renombrarSiCambio() {
    const nuevo = $('#postUploadNombre')?.value.trim();
    if (nuevo && nuevo !== result.nombre) {
      try {
        await api(`/projects/${result.id}/nombre`, { method: 'PATCH', body: { nombre: nuevo } });
        const p = state.projects.find((x) => x.id === result.id);
        if (p) p.nombre = nuevo;
        result.nombre = nuevo;
      } catch (_) { /* no bloquea el flujo */ }
    }
  }

  $('#btnSkipFechasPost').addEventListener('click', async () => {
    await renombrarSiCambio();
    closeModal();
    toast(`"${result.nombre}" cargado: ${result.conceptos} conceptos, ${result.insumos} insumos${destMsg}`, 'success');
  });

  $('#btnGuardarFechasPost').addEventListener('click', async () => {
    const inicio_obra = $('#postUploadInicio').value;
    const fin_obra = $('#postUploadFin').value;
    if (!inicio_obra || !fin_obra) { toast('Indica ambas fechas', 'danger'); return; }
    const btn = $('#btnGuardarFechasPost');
    btn.disabled = true; btn.textContent = 'Guardando…';
    try {
      await renombrarSiCambio();
      await api(`/projects/${result.id}/fechas-obra`, { method: 'PUT', body: { inicio_obra, fin_obra } });
      closeModal();
      invalidate('resumen');
      toast(`"${result.nombre}" cargado con fechas configuradas`, 'success');
      renderView();
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false; btn.textContent = 'Guardar';
    }
  });
}

// =========================================================================
// MI CUENTA — autogestión: cambio de nombre, usuario y contraseña
// =========================================================================
async function openMiCuentaModal(mustChange) {
  openModal(`
    <h3>Mi cuenta</h3>
    ${mustChange ? `<div class="alert-box warning mb-12">⚠️ Debes cambiar tu contraseña antes de continuar.</div>` : ''}
    <div class="field"><label>Nombre completo</label><input id="mcNombre" value="${esc(state.user?.nombre || '')}" /></div>
    <div class="field"><label>Usuario (login)</label><input id="mcUsuario" value="${esc(state.user?.usuario || '')}" autocomplete="username" /></div>
    <hr class="hr-14">
    <div class="row between">
      <span>Verificación en dos pasos (2FA)</span>
      ${state.user?.totp_enabled
        ? '<span class="badge green" title="2FA activo">✓ Activado</span>'
        : '<button class="btn small btn-primary" id="btnMiCuenta2FA">Configurar</button>'}
    </div>
    <hr class="hr-14">
    <p class="muted fs08-m0010">Deja los campos de contraseña vacíos si no quieres cambiarla.</p>
    <div class="field"><label>Contraseña actual</label><input id="mcPwActual" type="password" autocomplete="current-password" /></div>
    <div class="field"><label>Contraseña nueva</label><input id="mcPwNueva" type="password" autocomplete="new-password" placeholder="Mínimo 6 caracteres" /></div>
    <div class="field"><label>Confirmar contraseña nueva</label><input id="mcPwConfirm" type="password" autocomplete="new-password" /></div>
    ${!mustChange ? `
    <hr class="hr-14">
    <div class="row between">
      <span>${state.user?.solicitud_eliminacion_datos ? 'Solicitud de eliminación de datos enviada' : 'Eliminar mis datos personales'}</span>
      ${state.user?.solicitud_eliminacion_datos
        ? '<span class="badge muted" title="En revisión">En revisión</span>'
        : '<button class="btn small btn-danger" id="btnEliminarMisDatos">Solicitar eliminación</button>'}
    </div>
    ` : ''}
    <div class="modal-actions col-gap8">
      <div class="row-end-gap8">
        ${mustChange ? '' : '<button class="btn btn-cerrar-sesiones" id="btnCerrarTodasSesiones">Cerrar sesión en todos los dispositivos</button>'}
        <button class="btn" id="btnCancelMiCuenta">Cancelar</button>
        <button class="btn btn-primary" id="btnSaveMiCuenta">Guardar</button>
      </div>
    </div>
  `);

  $('#btnMiCuenta2FA')?.addEventListener('click', () => {
    closeModal();
    startTotpEnrollment();
  });

  $('#btnEliminarMisDatos')?.addEventListener('click', () => {
    openEliminarDatosModal();
  });

  if (!mustChange) {
    $('#btnCerrarTodasSesiones')?.addEventListener('click', async () => {
      if (!confirm('¿Cerrar sesión en todos los dispositivos? Tendrás que volver a iniciar sesión.')) return;
      try {
        await api('/auth/cerrar-todas-sesiones', { method: 'POST' });
        closeModal();
        logout();
      } catch (err) { toast(err.message, 'danger'); }
    });
  }

  if (!mustChange) $('#btnCancelMiCuenta').addEventListener('click', closeModal);
  else $('#btnCancelMiCuenta').addEventListener('click', closeModal); // en mustChange igual cierra (puede saltar por ahora)

  $('#btnSaveMiCuenta').addEventListener('click', async () => {
    const nombre = $('#mcNombre').value.trim();
    const usuario = $('#mcUsuario').value.trim();
    const pwActual = $('#mcPwActual').value;
    const pwNueva = $('#mcPwNueva').value;
    const pwConfirm = $('#mcPwConfirm').value;

    if (!nombre) { toast('El nombre no puede estar vacío', 'danger'); return; }
    if (!usuario) { toast('El usuario no puede estar vacío', 'danger'); return; }
    if (pwNueva && pwNueva !== pwConfirm) { toast('Las contraseñas nuevas no coinciden', 'danger'); return; }

    const body = {};
    if (nombre !== state.user?.nombre) body.nombre = nombre;
    if (usuario !== state.user?.usuario) body.usuario = usuario;
    if (pwNueva) { body.passwordActual = pwActual; body.passwordNueva = pwNueva; }

    if (!Object.keys(body).length) { closeModal(); return; }

    const btn = $('#btnSaveMiCuenta');
    btn.disabled = true;
    try {
      const data = await api('/auth/mi-cuenta', { method: 'PUT', body });
      if (data.token) {
        state.token = data.token;
        localStorage.setItem(TOKEN_KEY, data.token);
      }
      state.user = { ...state.user, nombre: data.user.nombre, usuario: data.user.usuario };
      updateProfileUI();
      toast('Cuenta actualizada', 'success');
      closeModal();
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false;
    }
  });
}

// Confirmación explícita (escribir "ELIMINAR") antes de disparar la solicitud
// — no existía un patrón de "escribir para confirmar" en la app (confirmDialog
// solo tiene botones Aceptar/Cancelar), así que este es el primero de ese tipo.
function openEliminarDatosModal() {
  blockOverlayDismiss = true;
  openModal(`
    <h3>Solicitar eliminación de mis datos</h3>
    <p>Esto marca tu cuenta para que un administrador revise y procese manualmente la eliminación de tus datos personales (nombre, teléfono, firma EPP, historial de asistencia). No borra nada de inmediato ni de forma automática.</p>
    <p class="muted fs-08">Para confirmar, escribe <strong>ELIMINAR</strong> abajo.</p>
    <div class="field"><input id="eliminarDatosConfirmInput" autocomplete="off" placeholder="ELIMINAR" /></div>
    <div class="modal-actions">
      <button class="btn" id="btnEliminarDatosCancelar">Cancelar</button>
      <button class="btn btn-danger" id="btnEliminarDatosConfirmar" disabled>Confirmar eliminación</button>
    </div>
  `);
  const input = $('#eliminarDatosConfirmInput');
  const btnConfirmar = $('#btnEliminarDatosConfirmar');
  input.addEventListener('input', () => {
    btnConfirmar.disabled = input.value.trim() !== 'ELIMINAR';
  });
  input.focus();
  $('#btnEliminarDatosCancelar').addEventListener('click', () => { blockOverlayDismiss = false; closeModal(); });
  btnConfirmar.addEventListener('click', async () => {
    btnConfirmar.disabled = true;
    btnConfirmar.textContent = 'Enviando…';
    try {
      await api('/auth/solicitar-eliminacion-datos', { method: 'POST' });
      state.user = { ...state.user, solicitud_eliminacion_datos: true };
      blockOverlayDismiss = false;
      closeModal();
      toast('Solicitud registrada. Un administrador la revisará.', 'success');
    } catch (err) {
      toast(err.message, 'danger');
      btnConfirmar.disabled = false;
      btnConfirmar.textContent = 'Confirmar eliminación';
    }
  });
}

function updateProfileUI() {
  if (!state.user) return;
  const initials = state.user.nombre.split(' ').map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
  const av = $('#sidebarAvatar'); if (av) av.textContent = initials;
  const nm = $('#sidebarProfileName'); if (nm) nm.textContent = state.user.nombre;
  const pn = $('#popoverName'); if (pn) pn.textContent = state.user.nombre;
}

// =========================================================================
// VISTA: Panel de desarrollador — exclusivo para rol 'desarrollador'
// =========================================================================
async function renderDevPanel(view) {
  view.innerHTML = '<div class="spinner"></div>';
  const info = await api('/admin/dev-info');

  const stat = (label, value, color = '') =>
    `<div class="kpi ${color} devpanel-stat">
       <div class="kpi-label">${label}</div>
       <div class="kpi-value">${value}</div>
     </div>`;

  view.innerHTML = `
    <h2 class="section-title">🛠️ Panel de desarrollador</h2>

    <h3 class="section-title devpanel-subtitle">Estadísticas del sistema</h3>
    <div class="kpi-grid devpanel-kpi-grid">
      ${stat('Usuarios activos',   info.usuarios_activos,  'accent')}
      ${stat('Proyectos',          info.proyectos_total)}
      ${stat('Clientes',           info.clientes_total)}
      ${stat('PDFs de contrato',   info.contratos_pdf)}
    </div>

    <h3 class="section-title devpanel-subtitle">Sugerencias</h3>
    <div class="kpi-grid devpanel-kpi-grid">
      ${stat('Total',              info.sugerencias_total)}
      ${stat('Pendientes',         info.sugerencias_pend,   info.sugerencias_pend > 0 ? 'yellow' : '')}
      ${stat('Con prompt IA',      info.sugerencias_prompt, 'green')}
    </div>

    <h3 class="section-title devpanel-subtitle">Entorno</h3>
    <div class="card devpanel-entorno-card">
      <div><span class="devpanel-label">Node.js</span>  &nbsp;${esc(info.node_version)}</div>
      <div><span class="devpanel-label">Entorno</span>  &nbsp;${esc(info.env)}</div>
      <div><span class="devpanel-label">SW Cache</span> &nbsp;<span id="__devSwVersion">cargando…</span></div>
    </div>

    <h3 class="section-title devpanel-subtitle">Métricas de layout</h3>
    <div id="__devDbgInline" class="card devpanel-metrics-card">
      <span class="muted fs-08">Cargando…</span>
    </div>
  `;

  // SW version
  _dbgSwInfo().then(({ line, version }) => {
    const el = $('#__devSwVersion');
    if (el) el.textContent = `${version} (${line})`;
  });

  // Layout metrics (reutiliza la función existente)
  initDebugSection($('#__devDbgInline'));
}

// =========================================================================
// VISTA: Sugerencias — envío (todos los usuarios) + panel admin
// =========================================================================
const SUGERENCIA_ESTADO_LABELS = {
  pendiente: 'Pendiente', revisada: 'Revisada', implementada: 'Implementada', descartada: 'Descartada',
};
const SUGERENCIA_ESTADO_COLORS = {
  pendiente: 'var(--accent-gold)', revisada: 'var(--accent-blue)', implementada: 'var(--accent-green)', descartada: 'var(--text-secondary)',
};

async function renderSugerencias(view) {
  view.innerHTML = '<div class="spinner"></div>';

  const [mias, todas] = await Promise.all([
    api('/sugerencias/mias'),
    isAdmin() ? api('/sugerencias') : Promise.resolve(null),
  ]);

  // Archivos seleccionados pendientes de subir (solo para el formulario activo)
  let sugFiles = [];

  const estadoBadge = (estado) =>
    `<span class="badge-estado badge-estado-${estado}">${SUGERENCIA_ESTADO_LABELS[estado] || estado}</span>`;

  const imgsHtml = (imgs) => {
    if (!imgs || !imgs.length) return '';
    return `<div class="sug-imgs-wrap">
      ${imgs.map((img) => `
        <a href="${esc(img.blob_url)}" target="_blank" rel="noopener" title="${esc(img.nombre_archivo)}" class="sug-img-link">
          <img src="${esc(img.blob_url)}" class="sug-img-cover" loading="lazy">
        </a>`).join('')}
    </div>`;
  };

  const tarjetaMia = (s) => `
    <div class="card sug-card-mia">
      <div class="sug-header-row">
        <p class="sug-texto-mia">${esc(s.texto)}</p>
        ${estadoBadge(s.estado)}
      </div>
      ${imgsHtml(s.imagenes)}
      <p class="sug-fecha-mia">${esc(s.creado_en?.slice(0, 16).replace('T', ' ') || '')}</p>
    </div>`;

  const tarjetaAdmin = (s) => `
    <div class="card sug-card-admin" data-sug-id="${s.id}">
      <div class="sug-header-row-admin">
        <div>
          <span class="sug-autor-nombre">${esc(s.autor_nombre)}</span>
          <span class="sug-meta-inline">${esc(s.autor_puesto || '')}</span>
          <span class="sug-meta-inline">${esc(s.creado_en?.slice(0, 16).replace('T', ' ') || '')}</span>
        </div>
        <select class="input sug-estado-select" data-sug-id="${s.id}">
          ${['pendiente','revisada','implementada','descartada'].map((e) =>
            `<option value="${e}" ${s.estado === e ? 'selected' : ''}>${SUGERENCIA_ESTADO_LABELS[e]}</option>`
          ).join('')}
        </select>
      </div>
      <p class="sug-texto-admin">${esc(s.texto)}</p>
      ${imgsHtml(s.imagenes)}
      ${s.prompt_generado ? `
        <div class="sug-prompt-box">
          <div class="sug-prompt-label">Prompt IA generado</div>
          <pre class="sug-prompt-pre">${esc(s.prompt_generado)}</pre>
          <button class="btn sug-copy-btn" data-sug-id="${s.id}">Copiar</button>
        </div>` : ''}
      <button class="btn sug-gen-btn" data-sug-id="${s.id}">
        ${s.prompt_generado ? 'Regenerar prompt IA' : '✨ Generar prompt IA'}
      </button>
      ${isDesarrollador() ? `<button class="btn sug-del-btn" data-sug-id="${s.id}">Eliminar</button>` : ''}
    </div>`;

  view.innerHTML = `
    <h2 class="section-title">💡 Sugerencias</h2>

    <div class="card sug-form-card">
      <h3 class="sug-form-title">Enviar una sugerencia</h3>
      <textarea id="sugTexto" class="input" rows="4" maxlength="2000"
        placeholder="Describe tu idea o mejora para la app…"></textarea>

      <div id="sugThumbArea"></div>

      <div class="sug-form-actions">
        <button id="sugAttachBtn" title="Adjuntar imagen">
          📎
        </button>
        <span class="sug-hint">Máx. 2 000 caracteres · 5 imágenes · límite: 5/hora</span>
        <button class="btn btn-primary" id="sugEnviarBtn">Enviar</button>
      </div>
      <input type="file" id="sugFileInput" accept="image/*" multiple class="hidden-initial">
    </div>

    ${mias.length ? `
      <h3 class="section-title sug-mias-title">Mis sugerencias</h3>
      ${mias.map(tarjetaMia).join('')}` : ''}

    ${isAdmin() && todas ? `
      <hr class="sug-divider">
      <h3 class="section-title sug-panel-admin-title">Panel admin — todas las sugerencias (${todas.length})</h3>
      ${todas.length ? todas.map(tarjetaAdmin).join('') : '<p class="sug-empty-msg">No hay sugerencias aún.</p>'}
    ` : ''}
  `;

  // ── Adjuntar imágenes ──────────────────────────────────────────────────
  function renderThumbs() {
    const area = $('#sugThumbArea');
    if (!sugFiles.length) { area.innerHTML = ''; return; }
    area.innerHTML = sugFiles.map((f, i) => `
      <div class="sug-thumb-wrap" data-thumb="${i}">
        <img src="${URL.createObjectURL(f)}" class="sug-thumb-img">
        <button data-rm="${i}" class="sug-thumb-remove">✕</button>
      </div>`).join('');
    $$('[data-rm]', area).forEach((btn) => {
      btn.addEventListener('click', () => {
        sugFiles.splice(Number(btn.dataset.rm), 1);
        renderThumbs();
      });
    });
  }

  $('#sugAttachBtn').addEventListener('click', () => $('#sugFileInput').click());
  $('#sugFileInput').addEventListener('change', (e) => {
    const nuevos = Array.from(e.target.files).slice(0, 5 - sugFiles.length);
    sugFiles.push(...nuevos);
    e.target.value = '';
    renderThumbs();
  });

  // ── Enviar ─────────────────────────────────────────────────────────────
  $('#sugEnviarBtn').addEventListener('click', async () => {
    const texto = $('#sugTexto').value.trim();
    if (!texto) { toast('Escribe tu sugerencia antes de enviar', ''); return; }
    const btn = $('#sugEnviarBtn');
    btn.disabled = true; btn.textContent = 'Enviando…';
    try {
      const sug = await api('/sugerencias', { method: 'POST', body: { texto } });
      if (sugFiles.length) {
        btn.textContent = 'Subiendo imágenes…';
        await Promise.all(sugFiles.map((file) => {
          const fd = new FormData(); fd.append('imagen', file);
          return api(`/sugerencias/${sug.id}/imagenes`, { method: 'POST', body: fd });
        }));
      }
      sugFiles = [];
      toast('Sugerencia enviada. ¡Gracias!', 'success');
      await renderSugerencias(view);
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false; btn.textContent = 'Enviar';
    }
  });

  // ── Admin: cambiar estado ───────────────────────────────────────────────
  $$('.sug-estado-select', view).forEach((sel) => {
    sel.addEventListener('change', async () => {
      const id = Number(sel.dataset.sugId);
      try {
        await api(`/sugerencias/${id}`, { method: 'PATCH', body: { estado: sel.value } });
        toast('Estado actualizado', 'success');
      } catch (err) {
        toast(err.message, 'danger');
        await renderSugerencias(view);
      }
    });
  });

  // ── Admin: generar prompt IA ────────────────────────────────────────────
  $$('.sug-gen-btn', view).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.sugId);
      btn.disabled = true; btn.textContent = 'Generando…';
      try {
        await api(`/sugerencias/${id}/generar-prompt`, { method: 'POST', body: {} });
        toast('Prompt generado', 'success');
        await renderSugerencias(view);
      } catch (err) {
        toast(err.message, 'danger');
        btn.disabled = false;
        btn.textContent = '✨ Generar prompt IA';
      }
    });
  });

  // ── Admin: copiar prompt ───────────────────────────────────────────────
  $$('.sug-copy-btn', view).forEach((btn) => {
    btn.addEventListener('click', () => {
      const pre = btn.closest('[data-sug-id]').querySelector('pre');
      if (pre) navigator.clipboard.writeText(pre.textContent).then(() => toast('Copiado al portapapeles', 'success'));
    });
  });

  // ── Desarrollador: eliminar sugerencia (hard delete) ───────────────────
  $$('.sug-del-btn', view).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.sugId);
      if (!confirm('¿Eliminar esta sugerencia permanentemente? No se puede deshacer.')) return;
      try {
        await api(`/sugerencias/${id}`, { method: 'DELETE' });
        btn.closest('[data-sug-id]').remove();
      } catch (err) {
        toast(err.message || 'Error al eliminar', 'danger');
      }
    });
  });
}

// =========================================================================
// VISTA: Usuarios (solo Administrador) — alta, edición y baja de cuentas
// =========================================================================
const PERMISOS_SECCION_LABELS = {
  presupuestos: 'Presupuestos', requisiciones: 'Requisiciones', proveedores: 'Proveedores',
  ordenes_compra: 'Órdenes de Compra', avance: 'Avance', destajo: 'Destajo', finanzas: 'Finanzas',
  estado_resultados: 'Estado de Resultados',
  insumos: 'Insumos', mapeo: 'Mapeo', usuarios: 'Usuarios', contrato: 'Contrato', impuestos: 'Impuestos',
  nominas: 'Nóminas', sugerencias: 'Sugerencias', programa: 'Programa', estimaciones: 'Estimaciones',
  maquinaria: 'Maquinaria (equipos)', maquinaria_captura: 'Maquinaria (captura de horas)',
  maquinaria_combustible: 'Maquinaria (combustible/mantenimiento)', trabajadores: 'Trabajadores',
  trabajadores_global: 'Trabajadores (Todas las Obras)', nominas_global: 'Nóminas (Todas las Obras)',
};
// Secciones que NUNCA son por-obra — no existe (ni tiene sentido) una versión
// "para la obra X" de una vista que ya de por sí es cross-obra/cross-cliente.
// Se guardan y se leen SIEMPRE con proyecto_id NULL, sin importar qué obra
// esté seleccionada en el dropdown de la matriz (ver permisosParaProyecto y
// el handler de #btnGuardarPermisos más abajo). Mismo criterio que
// server/auth.js SECCIONES_PERMISOS.
const SECCIONES_SIEMPRE_GLOBAL = ['trabajadores_global', 'nominas_global'];
const PERMISOS_SECCIONES = Object.keys(PERMISOS_SECCION_LABELS);
const PERMISOS_ACCIONES = [
  { key: 'puede_ver', label: 'Ver' },
  { key: 'puede_crear', label: 'Crear' },
  { key: 'puede_editar', label: 'Editar' },
  { key: 'puede_editar_precios', label: 'Editar precios' },
  { key: 'puede_eliminar', label: 'Eliminar' },
];
// Secciones donde el backend realmente exige el permiso (auth.checkPermiso
// aplicado en server/app.js) — hoy solo Nómina y Avance. Para el resto, la
// casilla es informativa: el acceso real lo sigue decidiendo el rol
// (auth.allow()), marcarla o no aquí todavía no cambia nada en el backend.
// Actualizar esta lista cada vez que se le agregue checkPermiso a una
// sección nueva (ver mismo patrón en server/auth.js SECCIONES_PERMISOS).
const SECCIONES_CON_ENFORCEMENT = ['nominas', 'avance', 'maquinaria', 'maquinaria_captura', 'maquinaria_combustible', 'trabajadores_global', 'nominas_global', 'trabajadores', 'destajo', 'requisiciones', 'proveedores', 'ordenes_compra'];
// 'ordenes_compra' SÍ se agrega completa (prompt-checkpermiso-ordenes-compra.md):
// a diferencia de presupuestos/finanzas/mapeo, las 4 acciones (ver/crear/
// editar/eliminar) tienen checkPermiso real — listar/detalle/export, generar
// OC desde requisición autorizada, cambiar estado (incluye confirmar/
// rechazar, con su propia restricción fina admin/tesorería dentro del
// handler), y eliminar (solo en borrador). Recepciones y pagos quedan fuera
// de scope, sin checkPermiso todavía — son sub-flujos con concern propio,
// no CRUD directo de la Orden de Compra.
// 'presupuestos' NO se agrega aquí todavía (prompt-checkpermiso-presupuestos.md):
// solo GET /api/projects/:id/conceptos (puede_ver) tiene checkPermiso real —
// no existe endpoint de editar/eliminar concepto individual, así que agregar
// la sección completa mostraría puede_crear/editar/eliminar/editar_precios
// como "reales" en la matriz cuando en realidad son inertes todavía. Agregar
// 'presupuestos' aquí solo cuando esas acciones también tengan enforcement.
// 'finanzas' NO se agrega aquí tampoco (prompt-checkpermiso-finanzas.md), mismo
// motivo exacto: Finanzas es 100% lectura agregada (resumen + export, ambos
// puede_ver) — no existe ninguna acción de crear/editar/eliminar en este
// módulo, así que agregar la sección completa mostraría esas 3 casillas como
// "reales" en la matriz cuando el módulo ni siquiera tiene esas operaciones.
// 'mapeo' NO se agrega aquí tampoco (prompt-checkpermiso-mapeo.md): a
// diferencia de presupuestos/finanzas, aquí SÍ hay checkPermiso real en
// ver/crear/eliminar (listar, vincular y desvincular concepto↔insumo) — pero
// no existe ningún endpoint de "editar" (la relación es un puente m2m, se
// desvincula y vuelve a vincular en vez de editarse), así que 'puede_editar'
// seguiría siendo inerte. Agregar la sección completa mostraría esa casilla
// como "real" cuando no lo es — mismo motivo, acción puntual distinta.
// 'impuestos' NO se agrega aquí tampoco (prompt-checkpermiso-impuestos.md):
// 'puede_ver' SÍ tiene enforcement real y activo (tesorería/administración
// llegan al checkPermiso vía auth.allow('tesoreria','administracion')).
// 'puede_editar' (cargar comprobantes de un periodo) tiene checkPermiso
// cableado también, pero el endpoint sigue detrás de auth.allow() sin
// argumentos — solo admin/desarrollador lo alcanzan, y ambos bypasean
// checkPermiso por diseño, así que hoy es inerte en la práctica (mismo
// patrón que Mapeo). 'puede_crear'/'puede_eliminar'/'puede_editar_precios'
// no corresponden a ningún endpoint: los periodos los crea únicamente el
// cron mensual (POST /api/cron/recordatorio-impuestos, fuera del alcance de
// checkPermiso por diseño — no tiene sesión de usuario) y no existe borrado.
// Agregar la sección completa mostraría 4 de las 5 casillas como "reales"
// sin serlo.
// 'contrato' NO se agrega aquí tampoco (prompt-checkpermiso-contratos.md):
// checkPermiso está cableado en las 3 rutas (contrato-preview, contrato-
// confirm → puede_crear; GET .../contrato/pdf → puede_ver), pero las 3
// siguen detrás de auth.allow() sin argumentos — solo admin/desarrollador
// las alcanzan, y ambos bypasean checkPermiso por diseño, así que hoy es
// 100% inerte en la práctica (mismo patrón que Mapeo/Impuestos). Nota: el
// tab 'contrato' sí es visible en frontend para tesorería/administración
// (PERMISSIONS.tabs en server/auth.js), un gap preexistente entre nav y
// auth.allow() que no se introdujo ni se corrigió en este cambio — fuera de
// scope. No existe 'puede_editar'/'puede_eliminar' para este módulo: no hay
// endpoint de editar campos ya guardados (se resube el PDF completo) ni de
// eliminar contrato.
// 'insumos' NO se agrega aquí tampoco (prompt-checkpermiso-insumos.md):
// 'puede_ver' SÍ tiene enforcement real y activo (checkPermiso cableado en
// listar/export/categorías, alcanzables por residente/cabo/compras/
// logística vía auth.allow()). 'puede_editar' (tasa de IVA por insumo)
// tiene checkPermiso cableado también, pero el endpoint sigue detrás de
// auth.allow() sin argumentos — solo admin/desarrollador lo alcanzan, y
// ambos bypasean checkPermiso por diseño, así que hoy es inerte en la
// práctica (mismo patrón que Mapeo/Impuestos/Contrato). 'puede_crear' y
// 'puede_eliminar' no corresponden a ningún endpoint: el catálogo de
// insumos se crea únicamente vía la carga inicial del contrato/.xlsx
// (fuera del alcance de checkPermiso) y no existe borrado individual.
// Agregar la sección completa mostraría 3 de las 4 casillas como "reales"
// sin serlo.
// Agrupa las secciones de permisos igual que SECTION_DEFS agrupa las pestañas
// en la pantalla de inicio (Obra / Compras / Tesorería / Administración) —
// mismo criterio de negocio, para que la matriz se lea en el mismo orden que
// el resto de la app en vez de un orden alfabético/insertado sin relación.
const PERMISOS_GRUPOS = [
  { label: 'Obra',           secciones: ['presupuestos', 'programa', 'avance', 'destajo', 'estimaciones'] },
  { label: 'Compras',        secciones: ['requisiciones', 'insumos', 'proveedores', 'ordenes_compra'] },
  { label: 'Tesorería',      secciones: ['finanzas', 'estado_resultados', 'impuestos'] },
  { label: 'Administración', secciones: ['mapeo', 'contrato', 'nominas', 'usuarios', 'trabajadores', 'trabajadores_global', 'nominas_global'] },
  { label: 'Maquinaria',     secciones: ['maquinaria', 'maquinaria_captura', 'maquinaria_combustible'] },
  { label: 'General',        secciones: ['sugerencias'] },
];
// Mirror de TAB_A_SECCION/defaultPermisosParaRol en server/auth.js — solo se
// usa para PRE-MARCAR la matriz con lo que el rol ya puede hacer hoy (vía
// ROLE_TABS/allow()) cuando el usuario todavía no tiene filas guardadas en
// permisos_usuario para esa sección. Es puramente visual/de arranque: la
// fuente de verdad real sigue siendo el middleware backend.
const TAB_A_SECCION = {
  resumen: 'presupuestos', programa: 'programa', contrato: 'contrato',
  impuestos: 'impuestos', insumos: 'insumos', requisiciones: 'requisiciones',
  ordenes: 'ordenes_compra', avance: 'avance', destajo: 'destajo',
  usuarios: 'usuarios', proveedores: 'proveedores', finanzas: 'finanzas',
  estadoResultados: 'estado_resultados',
  mapeo: 'mapeo', nominas: 'nominas', estimaciones: 'estimaciones',
  maquinaria: 'maquinaria', trabajadores: 'trabajadores',
};
function defaultPermisosParaRolFrontend(puesto) {
  const tabs = ROLE_TABS[puesto] || [];
  const secciones = new Set(tabs.map((t) => TAB_A_SECCION[t]).filter(Boolean));
  secciones.add('sugerencias');
  const porSeccion = {};
  secciones.forEach((seccion) => {
    porSeccion[seccion] = {
      seccion, puede_ver: true, puede_crear: false, puede_editar: false,
      puede_editar_precios: false, puede_eliminar: false,
    };
  });
  if (puesto === 'residente') {
    if (porSeccion.nominas) porSeccion.nominas.puede_crear = true;
    if (porSeccion.destajo) { porSeccion.destajo.puede_crear = true; porSeccion.destajo.puede_editar = true; }
    if (porSeccion.avance)  porSeccion.avance.puede_crear = true;
    if (porSeccion.requisiciones) porSeccion.requisiciones.puede_crear = true;
  }
  if (puesto === 'cabo') {
    if (porSeccion.destajo) porSeccion.destajo.puede_editar = true;
    if (porSeccion.avance)  porSeccion.avance.puede_crear = true;
    if (porSeccion.maquinaria) porSeccion.maquinaria.puede_crear = true;
    porSeccion.maquinaria_captura = {
      seccion: 'maquinaria_captura', puede_ver: true, puede_crear: true,
      puede_editar: false, puede_editar_precios: false, puede_eliminar: false,
    };
  }
  if (puesto === 'taller' || puesto === 'admin' || puesto === 'desarrollador') {
    if (porSeccion.maquinaria) { porSeccion.maquinaria.puede_crear = true; porSeccion.maquinaria.puede_editar = true; }
  }
  if (puesto === 'taller') {
    porSeccion.maquinaria_combustible = {
      seccion: 'maquinaria_combustible', puede_ver: true, puede_crear: true,
      puede_editar: false, puede_editar_precios: false, puede_eliminar: false,
    };
  }
  return porSeccion;
}

async function renderUsuarios(view, initialSubView) {
  if (!puedeGestionarUsuarios()) {
    view.innerHTML = `<div class="alert-box danger">⚠️ No tienes permiso para ver esta sección.</div>`;
    return;
  }
  let subView = 'cuentas'; // 'cuentas' | 'permisos'

  function renderSubNav() {
    if (!isAdmin()) return ''; // Permisos de Acceso: solo admin/desarrollador (igual que el backend)
    return `
      <div class="nominas-subnav">
        <button class="btn ${subView === 'cuentas' ? 'btn-primary' : ''}" id="btnSubCuentas">Cuentas</button>
        <button class="btn ${subView === 'permisos' ? 'btn-primary' : ''}" id="btnSubPermisos">Permisos de Acceso</button>
      </div>
    `;
  }
  function bindSubNav() {
    $('#btnSubCuentas')?.addEventListener('click', showCuentas);
    $('#btnSubPermisos')?.addEventListener('click', showPermisos);
  }

  async function showCuentas() {
    subView = 'cuentas';
    const usuarios = await api('/usuarios');
    view.innerHTML = `
      <h2 class="section-title">Usuarios</h2>
      <p class="muted">Cuentas del equipo y su puesto. El puesto determina qué pestañas y acciones puede usar cada quien.</p>
      ${renderSubNav()}
      <div class="section-actions mt-12">
        <button class="btn btn-primary" id="btnNuevoUsuario">+ Nuevo usuario</button>
      </div>
      <div id="usuariosList"></div>
    `;
    bindSubNav();
    $('#btnNuevoUsuario').addEventListener('click', () => openUsuarioModal(null));
    paintUsuariosList(usuarios);
  }

  async function showPermisos() {
    subView = 'permisos';
    const usuarios = await api('/usuarios');
    view.innerHTML = `
      <h2 class="section-title">Usuarios</h2>
      ${renderSubNav()}
      <div class="mt-12">
        <div class="field">
          <label>Usuario</label>
          <select id="permUsuarioSelect">
            <option value="">Selecciona un usuario…</option>
            ${usuarios.filter((u) => !['admin', 'desarrollador'].includes(u.puesto)).map((u) =>
              `<option value="${u.id}" data-puesto="${esc(u.puesto)}">${esc(u.nombre)} (${esc(PUESTO_LABELS[u.puesto] || u.puesto)})</option>`
            ).join('')}
          </select>
        </div>
        <div id="permMatrizWrap"><p class="muted">Selecciona un usuario para ver y editar su matriz de permisos.</p></div>
      </div>
    `;
    bindSubNav();
    $('#permUsuarioSelect').addEventListener('change', async (e) => {
      const usuarioId = Number(e.target.value);
      const puesto = e.target.selectedOptions[0]?.dataset.puesto;
      const wrap = $('#permMatrizWrap');
      if (!usuarioId) { wrap.innerHTML = '<p class="muted">Selecciona un usuario para ver y editar su matriz de permisos.</p>'; return; }
      wrap.innerHTML = '<div class="empty-state">Cargando…</div>';
      try {
        await renderMatrizPermisos(wrap, usuarioId, puesto);
      } catch (err) {
        wrap.innerHTML = `<div class="alert-box danger">⚠️ ${esc(err.message)}</div>`;
      }
    });
  }

  async function renderMatrizPermisos(wrap, usuarioId, puesto) {
    const [obras, permisosActuales] = await Promise.all([
      api(`/usuarios/${usuarioId}/proyectos`),
      api(`/permisos/${usuarioId}`),
    ]);
    const defaultsDelRol = defaultPermisosParaRolFrontend(puesto);

    // Sin obras asignadas: solo tiene sentido editar la fila "todas las obras" (proyecto NULL).
    const tieneVariasObras = obras.length > 1;
    let proyectoIdActivo = obras.length === 1 ? obras[0].id : null;

    // Si ya hay una fila guardada para esta sección (en este proyecto o en la
    // regla general de proyecto_id NULL), esa manda — es una personalización
    // ya hecha antes. Si NO existe ninguna fila todavía, el comportamiento
    // depende de si la sección tiene enforcement real en el backend:
    //   - Sin enforcement (checkPermiso no aplicado ahí): pre-marcar con lo
    //     que el rol ya puede hacer hoy por auth.allow() (defaultsDelRol) es
    //     seguro — es solo informativo, el acceso real lo sigue dando el rol.
    //   - CON enforcement (nominas, avance): NO pre-marcar con el default.
    //     Sin fila real, checkPermiso en el backend deniega con 403 sin
    //     importar el rol — mostrar la casilla marcada ahí mentiría sobre lo
    //     que el usuario puede hacer hoy (bug reportado: casillas marcadas
    //     para algo que en la práctica el usuario no puede hacer).
    function permisosParaProyecto(proyectoId) {
      const filasEspecificas = Object.fromEntries(
        permisosActuales.filter((p) => p.proyecto_id === proyectoId).map((f) => [f.seccion, f])
      );
      const filasGenerales = Object.fromEntries(
        permisosActuales.filter((p) => p.proyecto_id === null).map((f) => [f.seccion, f])
      );
      return PERMISOS_SECCIONES.map((seccion) => {
        // Secciones siempre-globales: ignoran proyectoId por completo, solo
        // existe la fila general (proyecto_id NULL) — ver SECCIONES_SIEMPRE_GLOBAL.
        const real = SECCIONES_SIEMPRE_GLOBAL.includes(seccion)
          ? filasGenerales[seccion]
          : (filasEspecificas[seccion] || filasGenerales[seccion]);
        if (real) return { ...real, _sinFila: false };
        if (SECCIONES_CON_ENFORCEMENT.includes(seccion)) {
          return {
            seccion, puede_ver: false, puede_crear: false, puede_editar: false,
            puede_editar_precios: false, puede_eliminar: false, _sinFila: true,
          };
        }
        return { ...(defaultsDelRol[seccion] || {
          seccion, puede_ver: false, puede_crear: false, puede_editar: false,
          puede_editar_precios: false, puede_eliminar: false,
        }), _sinFila: true };
      });
    }

    function pintarMatriz() {
      const filas = permisosParaProyecto(proyectoIdActivo);
      const filasPorSeccion = Object.fromEntries(filas.map((f) => [f.seccion, f]));
      wrap.innerHTML = `
        <div class="alert-box info">🔵 Los toggles en azul son permisos informativos: el backend todavía no los exige, así que marcarlos o desmarcarlos aquí no tiene efecto real todavía.</div>
        ${tieneVariasObras ? `
        <div class="field">
          <label>Obra</label>
          <select id="permObraSelect">
            <option value="" ${proyectoIdActivo === null ? 'selected' : ''}>Todas sus obras (regla general)</option>
            ${obras.map((o) => `<option value="${o.id}" ${proyectoIdActivo === o.id ? 'selected' : ''}>${esc(o.nombre)}</option>`).join('')}
          </select>
        </div>` : obras.length === 1 ? `<p class="muted fs-08">Obra: <strong>${esc(obras[0].nombre)}</strong></p>`
          : `<p class="muted fs-08">Este usuario no tiene obras asignadas todavía — los permisos aquí aplican como regla general en cuanto se le asigne una.</p>`}
        <div class="card mt-12 perm-matriz">
          <div class="table-scroll">
            <table class="perm-matriz-table">
              <thead><tr>
                <th>Sección</th>
                ${PERMISOS_ACCIONES.map((a) => `<th>${esc(a.label)}</th>`).join('')}
              </tr></thead>
              <tbody>
                ${PERMISOS_GRUPOS.map((grupo) => `
                  <tr class="perm-grupo-row"><td colspan="${PERMISOS_ACCIONES.length + 1}">${esc(grupo.label)}</td></tr>
                  ${grupo.secciones.map((seccion) => {
                    const f = filasPorSeccion[seccion];
                    if (!f) return '';
                    const sinEnforcement = !SECCIONES_CON_ENFORCEMENT.includes(seccion);
                    return `
                    <tr data-seccion="${f.seccion}">
                      <td>${esc(PERMISOS_SECCION_LABELS[f.seccion])}${sinEnforcement ? '<span class="muted fs-07 perm-badge-info" title="El backend todavía no exige este permiso para esta sección — hoy el acceso real lo decide el rol del usuario, marcar/desmarcar aquí no tiene efecto todavía."> · informativo</span>' : ''}</td>
                      ${PERMISOS_ACCIONES.map((a) => `
                        <td><label class="perm-check${sinEnforcement ? ' perm-check-informativo' : ''}"><input type="checkbox" data-accion="${a.key}" data-sin-enforcement="${sinEnforcement}" ${f[a.key] ? 'checked' : ''} /><span class="perm-check-track"><span class="perm-check-thumb"></span></span></label></td>
                      `).join('')}
                    </tr>
                  `;
                  }).join('')}
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-primary" id="btnGuardarPermisos">Guardar permisos</button>
        </div>
      `;
      $('#permObraSelect')?.addEventListener('change', (e) => {
        proyectoIdActivo = e.target.value ? Number(e.target.value) : null;
        pintarMatriz();
      });
      // Secciones sin enforcement real: siguen siendo editables (no disabled),
      // pero antes de aplicar el marcado/desmarcado se confirma con el admin
      // — evita que se piense que el cambio ya tiene efecto en el backend.
      //
      // Intento anterior (click + preventDefault + setTimeout) dependía del
      // orden exacto entre "el navegador revierte .checked tras preventDefault"
      // y "mi setTimeout corre" — Playwright lo pasaba 3/3, pero en Chrome real
      // (probado en incógnito, sin caché de SW de por medio) el toggle nunca
      // se aplicaba al aceptar. En vez de seguir peleando con ese timing
      // (que es justo el tipo de cosa que puede variar entre un dialog
      // automatizado por CDP y uno bloqueante real del navegador), se cambia
      // de estrategia: NO se previene nada — se deja que el toggle nativo
      // ocurra normal (dispara 'change' como cualquier checkbox), y solo si
      // el usuario CANCELA se revierte manualmente en el mismo handler de
      // 'change'. Cero dependencia de orden de tareas/microtareas: no hay
      // ninguna reversión nativa con la que competir.
      $$('#permMatrizWrap input[data-sin-enforcement="true"]').forEach((input) => {
        input.addEventListener('change', async () => {
          const valorAplicado = input.checked; // el toggle nativo ya ocurrió normalmente
          const accionLabel = PERMISOS_ACCIONES.find((a) => a.key === input.dataset.accion)?.label || input.dataset.accion;
          const seccionLabel = PERMISOS_SECCION_LABELS[input.closest('tr').dataset.seccion] || '';
          const confirmado = await confirmDialog(
            `"${accionLabel}" en ${seccionLabel} es un permiso informativo — el backend todavía no lo aplica automáticamente. ¿Deseas continuar?`,
            { titulo: 'Permiso informativo' }
          );
          if (!confirmado) input.checked = !valorAplicado; // revertir al valor previo al click
        });
      });
      $('#btnGuardarPermisos').addEventListener('click', async () => {
        const btn = $('#btnGuardarPermisos');
        btn.disabled = true;
        const todasLasFilas = $$('#permMatrizWrap tbody tr[data-seccion]').map((tr) => {
          const seccion = tr.dataset.seccion;
          const fila = { seccion };
          PERMISOS_ACCIONES.forEach((a) => {
            fila[a.key] = tr.querySelector(`input[data-accion="${a.key}"]`).checked;
          });
          return fila;
        });
        // Las secciones siempre-globales (Trabajadores/Nóminas todas las
        // obras) se guardan SIEMPRE con proyecto_id null, sin importar qué
        // obra esté seleccionada en el dropdown — no existe versión "por
        // obra" de una vista cross-obra. El resto sigue el comportamiento
        // de siempre (proyectoIdActivo). Dos PUT separados porque el
        // endpoint aplica un solo proyecto_id a todo el arreglo que recibe.
        const permisosPorObra = todasLasFilas.filter((f) => !SECCIONES_SIEMPRE_GLOBAL.includes(f.seccion));
        const permisosGlobales = todasLasFilas.filter((f) => SECCIONES_SIEMPRE_GLOBAL.includes(f.seccion));
        try {
          let actualizados;
          if (permisosPorObra.length) {
            actualizados = await api(`/permisos/${usuarioId}`, {
              method: 'PUT',
              body: { proyecto_id: proyectoIdActivo, permisos: permisosPorObra },
            });
          }
          if (permisosGlobales.length) {
            actualizados = await api(`/permisos/${usuarioId}`, {
              method: 'PUT',
              body: { proyecto_id: null, permisos: permisosGlobales },
            });
          }
          permisosActuales.length = 0;
          permisosActuales.push(...actualizados);
          toast('Permisos guardados', 'success');
        } catch (err) {
          toast(err.message, 'danger');
        } finally {
          btn.disabled = false;
        }
      });
    }
    pintarMatriz();
  }

  if (initialSubView === 'permisos' && isAdmin()) await showPermisos();
  else await showCuentas();
}

function paintUsuariosList(usuarios) {
  const list = $('#usuariosList');
  if (!usuarios.length) {
    list.innerHTML = '<div class="empty-state">No hay usuarios registrados.</div>';
    return;
  }
  list.innerHTML = usuarios.map((u) => `
    <div class="card">
      <div class="row between">
        <div>
          <strong>${esc(u.nombre)}</strong>
          <div class="muted fs-08">@${esc(u.usuario)}</div>
        </div>
        <div class="row row-nowrap-gap6">
          <span class="badge ${u.puesto === 'admin' ? 'green' : u.puesto === 'desarrollador' ? 'purple' : u.puesto === 'logistica' ? 'yellow' : 'muted'}">${esc(PUESTO_LABELS[u.puesto] || u.puesto)}</span>
          ${!u.activo ? '<span class="badge red">Inactivo</span>' : ''}
          ${u.must_change_password ? '<span class="badge yellow" title="Debe cambiar contraseña en el próximo login">🔑 Cambio pendiente</span>' : ''}
          ${u.totp_enabled ? '<span class="badge green" title="2FA configurado">🔒 2FA</span>' : '<span class="badge yellow" title="2FA es opcional: verá un recordatorio no intrusivo hasta que lo configure">🔓 Sin 2FA</span>'}
        </div>
      </div>
      <div class="row end mt8-gap8">
        <button class="btn small" data-edit-user="${u.id}">Editar</button>
        <button class="btn small" data-reset-user="${u.id}" title="Generar nueva contraseña temporal">Restablecer contraseña</button>
        ${u.totp_enabled ? `<button class="btn small" data-reset-totp="${u.id}" title="Forzar nueva inscripción de 2FA (si perdió su dispositivo/códigos)">Resetear 2FA</button>` : ''}
        ${u.id !== state.user.id ? `<button class="btn small btn-danger" data-del-user="${u.id}">Eliminar</button>` : ''}
      </div>
    </div>
  `).join('');

  $$('[data-edit-user]', list).forEach((btn) => {
    btn.addEventListener('click', () => {
      const u = usuarios.find((x) => x.id === Number(btn.dataset.editUser));
      if (u) openUsuarioModal(u);
    });
  });
  $$('[data-reset-user]', list).forEach((btn) => {
    btn.addEventListener('click', () => {
      const u = usuarios.find((x) => x.id === Number(btn.dataset.resetUser));
      if (u) openResetPasswordModal(u);
    });
  });
  $$('[data-reset-totp]', list).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const u = usuarios.find((x) => x.id === Number(btn.dataset.resetTotp));
      if (!u) return;
      if (!confirm(`¿Resetear el 2FA de "${u.nombre}"? Deberá inscribirse de nuevo (escanear un QR nuevo) en su próximo login.`)) return;
      try {
        await api(`/usuarios/${u.id}/totp-reset`, { method: 'POST' });
        toast('2FA reseteado — se le pedirá inscribirse de nuevo', 'success');
        renderView();
      } catch (err) { toast(err.message, 'danger'); }
    });
  });
  $$('[data-del-user]', list).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const u = usuarios.find((x) => x.id === Number(btn.dataset.delUser));
      if (!u) return;
      const ok = await confirmDialog(`¿Eliminar la cuenta de "${u.nombre}"? Esta acción no se puede deshacer.`, {
        titulo: 'Eliminar usuario', textoAceptar: 'Eliminar', claseAceptar: 'btn-danger',
      });
      if (!ok) return;
      try {
        await api(`/usuarios/${u.id}`, { method: 'DELETE' });
        toast('Usuario eliminado', 'success');
        renderView();
      } catch (err) { toast(err.message, 'danger'); }
    });
  });
}

async function openUsuarioModal(usuario) {
  const isEdit = !!usuario;
  const [allProjects, clientes, assigned] = await Promise.all([
    api('/projects'),
    api('/clientes'),
    isEdit ? api(`/usuarios/${usuario.id}/proyectos`) : Promise.resolve([]),
  ]);
  // selectedProjectIds sobrevive al cambiar de cliente en el selector (abajo
  // solo se muestran las obras del cliente activo, pero la selección de
  // otros clientes ya elegidos antes no se pierde).
  const selectedProjectIds = new Set(assigned.map((p) => p.id));

  // Agrupa las obras por cliente: el admin debe elegir cliente primero, y
  // solo entonces se habilita/muestra el checklist de sus obras — evita
  // asignar una obra "a ciegas" sin saber a qué cliente pertenece.
  const SIN_CLIENTE = 'Sin cliente asignado';
  const clienteNombrePorId = new Map(clientes.map((c) => [c.id, c.nombre]));
  const proyectosPorCliente = new Map();
  allProjects.forEach((p) => {
    const nombreCliente = clienteNombrePorId.get(p.cliente_id) || SIN_CLIENTE;
    if (!proyectosPorCliente.has(nombreCliente)) proyectosPorCliente.set(nombreCliente, []);
    proyectosPorCliente.get(nombreCliente).push(p);
  });
  const gruposObras = [...proyectosPorCliente.entries()]
    .sort(([a], [b]) => (a === SIN_CLIENTE ? 1 : b === SIN_CLIENTE ? -1 : a.localeCompare(b)));
  gruposObras.forEach(([, proyectos]) => proyectos.sort((a, b) => a.nombre.localeCompare(b.nombre)));
  const clienteOptionsHtml = gruposObras
    .map(([nombreCliente]) => `<option value="${esc(nombreCliente)}">${esc(nombreCliente)}</option>`)
    .join('');

  const puestoOptions = Object.keys(PUESTO_LABELS)
    .map((p) => `<option value="${p}" ${usuario && usuario.puesto === p ? 'selected' : ''}>${esc(PUESTO_LABELS[p])}</option>`)
    .join('');
  const puestoInicial = usuario ? usuario.puesto : 'residente';

  openModal(`
    <h3>${isEdit ? 'Editar usuario' : 'Nuevo usuario'}</h3>
    <div class="field"><label>Nombre completo *</label><input id="uNombre" value="${isEdit ? esc(usuario.nombre) : ''}" /></div>
    <div class="field">
      <label>Usuario (para iniciar sesión) *</label>
      <input id="uUsuario" autocomplete="off" value="${isEdit ? esc(usuario.usuario) : ''}" ${isEdit ? 'disabled' : ''} />
    </div>
    <div class="field"><label>Puesto *</label><select id="uPuesto">${puestoOptions}</select></div>
    <div class="field">
      <label>${isEdit ? 'Nueva contraseña (déjalo vacío para no cambiarla)' : 'Contraseña *'}</label>
      <input id="uPassword" type="password" autocomplete="new-password" placeholder="Mínimo 6 caracteres" />
      <div id="uPasswordError" class="alert-box danger hidden-initial"></div>
    </div>
    ${isEdit ? `
    <div class="field">
      <label class="checkbox-row-mt14">
        <input id="uActivo" type="checkbox" class="w-auto" ${usuario.activo ? 'checked' : ''} /> Cuenta activa
      </label>
    </div>` : ''}
    <div class="field ${puestoInicial === 'admin' ? 'hidden-initial' : ''}" id="uProyectosField" data-admin-hide="true">
      <label>Obras asignadas</label>
      <p class="muted fs076-m006">Solo verá y podrá operar en las obras marcadas aquí.</p>
      ${allProjects.length ? `
      <div class="field">
        <label>Cliente *</label>
        <select id="uClienteSelect">
          <option value="">Selecciona un cliente…</option>
          ${clienteOptionsHtml}
        </select>
      </div>
      <div id="uProyectosList" class="checkbox-list-col">
        <p class="muted">Selecciona un cliente para ver y marcar sus obras.</p>
      </div>
      <p class="muted fs-08" id="uProyectosResumen"></p>
      ` : '<p class="muted">No hay obras cargadas todavía.</p>'}
    </div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelUsuario">Cerrar</button>
      <button class="btn btn-primary" id="btnSaveUsuario">${isEdit ? 'Guardar cambios' : 'Crear usuario'}</button>
    </div>
  `);
  $('#uPuesto').addEventListener('change', (e) => {
    const field = $('#uProyectosField');
    const isAdminSel = e.target.value === 'admin';
    if (!isAdminSel) field.classList.remove('hidden-initial'); // ver .hidden-initial en styles.css
    field.style.display = isAdminSel ? 'none' : '';
  });

  // Checklist de obras acotado al cliente elegido en uClienteSelect — no se
  // puede marcar una obra sin haber seleccionado antes su cliente. Cambiar
  // de cliente no pierde lo ya marcado en otros clientes (selectedProjectIds
  // vive fuera del DOM re-renderizado).
  function renderProyectosResumen() {
    const el = $('#uProyectosResumen');
    if (!el) return;
    el.textContent = selectedProjectIds.size
      ? `${selectedProjectIds.size} obra(s) asignada(s) en total (puede abarcar más de un cliente).`
      : '';
  }
  function renderProyectosDeCliente(nombreCliente) {
    const list = $('#uProyectosList');
    if (!nombreCliente) {
      list.innerHTML = '<p class="muted">Selecciona un cliente para ver y marcar sus obras.</p>';
      return;
    }
    const grupo = gruposObras.find(([nc]) => nc === nombreCliente);
    const proyectos = grupo ? grupo[1] : [];
    list.innerHTML = proyectos.map((p) => `
      <label class="checkbox-row-fw400 checkbox-row-indent">
        <input type="checkbox" value="${p.id}" class="w-auto" ${selectedProjectIds.has(p.id) ? 'checked' : ''} /> ${esc(p.nombre)}
      </label>`).join('');
    $$('#uProyectosList input[type="checkbox"]', list).forEach((cb) => {
      cb.addEventListener('change', () => {
        const id = Number(cb.value);
        if (cb.checked) selectedProjectIds.add(id); else selectedProjectIds.delete(id);
        renderProyectosResumen();
      });
    });
  }
  $('#uClienteSelect')?.addEventListener('change', (e) => renderProyectosDeCliente(e.target.value));
  renderProyectosResumen();

  $('#btnCancelUsuario').addEventListener('click', closeModal);
  // uPasswordError: la validación de contraseña ya mostraba un toast, pero
  // el toast aparece fijo en la esquina inferior de la pantalla, lejos del
  // modal — con el modal cubriendo la mayor parte de la vista (hasta 88dvh)
  // y el toast desapareciendo a los 2.5s, era fácil no verlo nunca y percibir
  // el submit como si "no hiciera nada" (bug reportado en vivo). Este mensaje
  // inline, pegado al campo, no depende de que el usuario mire hacia abajo
  // ni de un timer — se queda visible hasta el siguiente intento de guardar.
  function showUPasswordError(msg) {
    const el = $('#uPasswordError');
    el.textContent = msg;
    el.classList.remove('hidden-initial');
  }
  function clearUPasswordError() {
    $('#uPasswordError').classList.add('hidden-initial');
  }
  $('#btnSaveUsuario').addEventListener('click', async () => {
    clearUPasswordError();
    const nombre = $('#uNombre').value.trim();
    const puesto = $('#uPuesto').value;
    const password = $('#uPassword').value;
    if (!nombre) { toast('Escribe el nombre completo', 'danger'); return; }
    if (!isEdit && !$('#uUsuario').value.trim()) { toast('Escribe el usuario de acceso', 'danger'); return; }
    if (!isEdit && !password) {
      toast('Escribe una contraseña', 'danger');
      showUPasswordError('Escribe una contraseña.');
      return;
    }
    if (password && password.length < 6) {
      toast('La contraseña debe tener al menos 6 caracteres', 'danger');
      showUPasswordError('La contraseña debe tener al menos 6 caracteres.');
      return;
    }
    const btn = $('#btnSaveUsuario');
    btn.disabled = true;
    try {
      let targetId = usuario ? usuario.id : null;
      if (isEdit) {
        const body = { nombre, puesto, activo: $('#uActivo').checked };
        if (password) body.password = password;
        await api(`/usuarios/${usuario.id}`, { method: 'PUT', body });
        toast('Usuario actualizado', 'success');
      } else {
        const created = await api('/usuarios', { method: 'POST', body: { nombre, usuario: $('#uUsuario').value.trim(), password, puesto } });
        targetId = created.id;
        toast('Usuario creado', 'success');
      }
      if (puesto !== 'admin') {
        await api(`/usuarios/${targetId}/proyectos`, { method: 'PUT', body: { project_ids: [...selectedProjectIds] } });
      }
      closeModal();
      renderView();
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false;
    }
  });
}

// Restablece la contraseña de un usuario (solo admin). La nueva contraseña
// la decide el admin y se entrega manualmente al trabajador. El backend marca
// must_change_password = true e invalida sesiones anteriores del usuario.
function openResetPasswordModal(usuario) {
  openModal(`
    <h3>Restablecer contraseña</h3>
    <p class="muted">Asigna una contraseña temporal a <strong>${esc(usuario.nombre)}</strong>. El usuario deberá cambiarla en su próximo acceso.</p>
    <div class="alert-box warning m10-0-14">El admin nunca puede ver la contraseña actual del usuario — solo generar una nueva.</div>
    <div class="field">
      <label>Nueva contraseña temporal *</label>
      <input id="rpPassword" type="password" autocomplete="new-password" placeholder="Mínimo 6 caracteres" />
    </div>
    <div class="field">
      <label>Confirmar contraseña *</label>
      <input id="rpConfirm" type="password" autocomplete="new-password" />
      <div id="rpPasswordError" class="alert-box danger hidden-initial"></div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelReset">Cancelar</button>
      <button class="btn btn-primary" id="btnConfirmReset">Restablecer</button>
    </div>
  `);
  $('#btnCancelReset').addEventListener('click', closeModal);
  // Mismo motivo que showUPasswordError en openUsuarioModal: el toast solo
  // no era suficiente feedback con el modal cubriendo la mayor parte de la
  // pantalla — mensaje inline pegado al campo en vez de (o además de) toast.
  function showRPPasswordError(msg) {
    const el = $('#rpPasswordError');
    el.textContent = msg;
    el.classList.remove('hidden-initial');
  }
  function clearRPPasswordError() {
    $('#rpPasswordError').classList.add('hidden-initial');
  }
  $('#btnConfirmReset').addEventListener('click', async () => {
    clearRPPasswordError();
    const password = $('#rpPassword').value;
    const confirm = $('#rpConfirm').value;
    if (!password) {
      toast('Escribe una contraseña', 'danger');
      showRPPasswordError('Escribe una contraseña.');
      return;
    }
    if (password.length < 6) {
      toast('Mínimo 6 caracteres', 'danger');
      showRPPasswordError('La contraseña debe tener al menos 6 caracteres.');
      return;
    }
    if (password !== confirm) {
      toast('Las contraseñas no coinciden', 'danger');
      showRPPasswordError('Las contraseñas no coinciden.');
      return;
    }
    const btn = $('#btnConfirmReset');
    btn.disabled = true;
    try {
      await api(`/usuarios/${usuario.id}`, { method: 'PUT', body: { password } });
      toast(`Contraseña restablecida para ${usuario.nombre}`, 'success');
      closeModal();
      renderView();
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false;
    }
  });
}

// =========================================================================
// VISTA: Proveedores (catálogo global — solo Administrador gestiona)
// =========================================================================
async function renderProveedores(view) {
  const proveedores = await api('/proveedores');

  view.innerHTML = `
    <h2 class="section-title">Proveedores</h2>
    <p class="muted">Catálogo compartido entre todas las obras, usado al generar órdenes de compra.</p>
    <div class="section-actions">
      ${(isAdmin() || state.user?.puesto === 'compras') ? '<button class="btn btn-primary" id="btnNuevoProveedor">+ Nuevo proveedor</button>' : ''}
      <button class="btn" id="btnExportProveedores">⭳ Exportar a Excel</button>
    </div>
    <div id="proveedoresList"></div>
  `;
  $('#btnNuevoProveedor')?.addEventListener('click', () => openProveedorModal(null));
  wireExportButton('#btnExportProveedores', '/proveedores/export');
  paintProveedoresList(proveedores);
}

function paintProveedoresList(proveedores) {
  const list = $('#proveedoresList');
  if (!proveedores.length) {
    list.innerHTML = '<div class="empty-state">No hay proveedores registrados.</div>';
    return;
  }
  list.innerHTML = proveedores.map((p) => `
    <div class="card">
      <div class="row between">
        <div>
          <strong>${esc(p.nombre)}</strong>
          ${p.contacto ? `<div class="muted fs-08">${esc(p.contacto)}</div>` : ''}
          ${p.telefono ? `<div class="muted fs-08">📞 ${esc(p.telefono)}</div>` : ''}
          ${p.rfc ? `<div class="muted code fs-074">${esc(p.rfc)}</div>` : ''}
        </div>
        ${!p.activo ? '<span class="badge red">Inactivo</span>' : ''}
      </div>
      ${isAdmin() ? `
      <div class="row end mt8-gap8">
        <button class="btn small" data-edit-prov="${p.id}">Editar</button>
        <button class="btn small ${p.activo ? 'btn-danger' : ''}" data-toggle-prov="${p.id}">${p.activo ? 'Desactivar' : 'Activar'}</button>
      </div>` : ''}
    </div>
  `).join('');

  $$('[data-edit-prov]', list).forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = proveedores.find((x) => x.id === Number(btn.dataset.editProv));
      if (p) openProveedorModal(p);
    });
  });
  $$('[data-toggle-prov]', list).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const p = proveedores.find((x) => x.id === Number(btn.dataset.toggleProv));
      if (!p) return;
      try {
        await api(`/proveedores/${p.id}/estado`, { method: 'PUT', body: { activo: !p.activo } });
        toast(p.activo ? 'Proveedor desactivado' : 'Proveedor activado', 'success');
        renderView();
      } catch (err) { toast(err.message, 'danger'); }
    });
  });
}

function openProveedorModal(proveedor) {
  const isEdit = !!proveedor;
  openModal(`
    <h3>${isEdit ? 'Editar proveedor' : 'Nuevo proveedor'}</h3>
    <div class="field"><label>Nombre *</label><input id="pvNombre" value="${isEdit ? esc(proveedor.nombre) : ''}" /></div>
    <div class="field"><label>Contacto</label><input id="pvContacto" value="${isEdit ? esc(proveedor.contacto || '') : ''}" /></div>
    <div class="field"><label>Teléfono</label><input id="pvTelefono" type="tel" value="${isEdit ? esc(proveedor.telefono || '') : ''}" /></div>
    <div class="field"><label>Email</label><input id="pvEmail" type="email" value="${isEdit ? esc(proveedor.email || '') : ''}" /></div>
    <div class="field"><label>RFC</label><input id="pvRfc" value="${isEdit ? esc(proveedor.rfc || '') : ''}" /></div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelProv">Cerrar</button>
      <button class="btn btn-primary" id="btnSaveProv">${isEdit ? 'Guardar cambios' : 'Crear proveedor'}</button>
    </div>
  `);
  $('#pvNombre').focus();
  $('#btnCancelProv').addEventListener('click', closeModal);
  $('#btnSaveProv').addEventListener('click', async () => {
    const nombre = $('#pvNombre').value.trim();
    if (!nombre) { toast('Escribe el nombre del proveedor', 'danger'); return; }
    const btn = $('#btnSaveProv');
    btn.disabled = true;
    const body = {
      nombre,
      contacto: $('#pvContacto').value.trim() || null,
      telefono: $('#pvTelefono').value.trim() || null,
      email: $('#pvEmail').value.trim() || null,
      rfc: $('#pvRfc').value.trim() || null,
    };
    try {
      if (isEdit) {
        await api(`/proveedores/${proveedor.id}`, { method: 'PUT', body });
        toast('Proveedor actualizado', 'success');
      } else {
        await api('/proveedores', { method: 'POST', body });
        toast('Proveedor creado', 'success');
      }
      closeModal();
      renderView();
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false;
    }
  });
}

// =========================================================================
// VISTA: Cotizador de materiales (prompts-cotizador-permisos, Prompt 1) —
// compara precios de Home Depot y Sodimac para un material. Vista global
// (no por obra), solo compras/admin/desarrollador. Materiales Valdez quedó
// fuera del comparador: su sitio no publica precios en línea (ver
// server/cotizador.js).
// =========================================================================
async function renderCotizador(view) {
  let ultimaBusqueda = null;
  // Una búsqueda real (scrape en vivo) puede tardar 50-90s (ver
  // PRESUPUESTO_TOTAL_MS en server/cotizador.js) — si el usuario reintenta o
  // hace doble click en "Buscar" mientras la primera sigue pendiente, se
  // disparan dos requests en paralelo. Sin este guard, cualquiera de las dos
  // respuestas (incluida una obsoleta, p. ej. un 504 real de gateway de una
  // búsqueda ya superada) puede llegar después y pisar el estado correcto en
  // pantalla (bug real: prompt-fix-error-504-falso-cotizador.md). searchToken
  // asegura que solo la respuesta de la búsqueda MÁS RECIENTE actualice el DOM.
  let searchToken = 0;

  view.innerHTML = `
    <h2 class="section-title">Cotizador de materiales</h2>
    <p class="muted">Compara precios entre Home Depot, Sodimac y Amazon para un material. Los resultados se guardan en caché por 24 horas.</p>
    <div class="row gap-8 items-center mt-4">
      <span class="muted fs-08" id="cotizadorUbicacionLabel">Ubicación para Amazon: —</span>
      <button class="btn small" id="btnCotizadorUbicacion">📍 Configurar ubicación</button>
    </div>
    <div class="row gap-8 mt-8">
      <div class="field flex-1">
        <label>Buscar material</label>
        <input id="cotizadorInput" type="text" placeholder="Ej. tornillo, cemento, taladro…" />
      </div>
    </div>
    <div class="row mt-8">
      <button class="btn btn-primary" id="btnCotizadorBuscar">Buscar</button>
    </div>
    <div id="cotizadorResultados" class="mt-12"></div>
  `;

  const TIENDA_LABELS = { home_depot: 'Home Depot', sodimac: 'Sodimac', amazon: 'Amazon' };
  const fmtFechaHora = (s) => {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('es-MX', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  // Ubicación fija (Fase 1, prompt-cotizador-mas-tiendas.md) — solo Amazon
  // de las tiendas del comparador soporta fijar zona de envío vía UI (ver
  // diagnóstico en server/cotizador.js); Home Depot/Sodimac la ignoran.
  async function refrescarUbicacionLabel() {
    const label = $('#cotizadorUbicacionLabel');
    try {
      const cfg = await api('/cotizador/config');
      label.textContent = cfg.codigo_postal
        ? `Ubicación para Amazon: ${cfg.ciudad ? cfg.ciudad + ' · ' : ''}CP ${cfg.codigo_postal}`
        : 'Ubicación para Amazon: no configurada (usa geo-IP por defecto)';
    } catch (err) {
      label.textContent = 'Ubicación para Amazon: —';
    }
  }
  refrescarUbicacionLabel();

  $('#btnCotizadorUbicacion').addEventListener('click', async () => {
    let actual = { ciudad: '', codigo_postal: '' };
    try { actual = await api('/cotizador/config'); } catch (err) { /* formulario abre vacío si falla */ }
    openModal(`
      <h3>Configurar ubicación</h3>
      <p class="muted fs-08">Se usa al cotizar en Amazon para que el precio y la disponibilidad reflejen esta zona. Home Depot y Sodimac no la usan.</p>
      <div class="field"><label>Ciudad</label><input id="cotizadorCiudad" value="${esc(actual.ciudad || '')}" placeholder="Ej. Cuernavaca" /></div>
      <div class="field"><label>Código postal</label><input id="cotizadorCP" value="${esc(actual.codigo_postal || '')}" placeholder="Ej. 62050" maxlength="5" /></div>
      <div class="modal-actions">
        <button class="btn" id="btnCotizadorUbicacionCancelar">Cancelar</button>
        <button class="btn btn-primary" id="btnCotizadorUbicacionGuardar">Guardar</button>
      </div>
    `);
    $('#btnCotizadorUbicacionCancelar').addEventListener('click', closeModal);
    $('#btnCotizadorUbicacionGuardar').addEventListener('click', async () => {
      const ciudad = $('#cotizadorCiudad').value.trim();
      const codigo_postal = $('#cotizadorCP').value.trim();
      if (codigo_postal && !/^\d{4,5}$/.test(codigo_postal)) { toast('Código postal inválido', 'danger'); return; }
      try {
        await api('/cotizador/config', { method: 'PUT', body: { ciudad, codigo_postal } });
        closeModal();
        toast('Ubicación guardada', 'success');
        refrescarUbicacionLabel();
      } catch (err) {
        toast(err.message, 'danger');
      }
    });
  });

  function pintarResultados() {
    const cont = $('#cotizadorResultados');
    if (!ultimaBusqueda) { cont.innerHTML = ''; return; }
    const { query, resultados, errores, fecha_consulta, desdeCache } = ultimaBusqueda;
    const erroresHtml = errores.length
      ? `<div class="alert-box warn mt-8">⚠️ No se pudo consultar: ${errores.map((e) => `${esc(TIENDA_LABELS[e.tienda] || e.tienda)} (${esc(e.error)})`).join(', ')}</div>`
      : '';
    if (!resultados.length) {
      cont.innerHTML = `${erroresHtml}<div class="empty-state">Sin resultados para "${esc(query)}".</div>`;
      return;
    }
    const precios = resultados.map((r) => Number(r.precio)).filter((p) => Number.isFinite(p));
    const minPrecio = precios.length ? Math.min(...precios) : null;
    cont.innerHTML = `
      <div class="row gap-8 items-center mt-8">
        <span class="muted">Última consulta: ${fmtFechaHora(fecha_consulta)} ${desdeCache ? '(desde caché)' : '(en vivo)'}</span>
        <button class="btn small" id="btnCotizadorActualizar">🔄 Actualizar precio</button>
      </div>
      ${erroresHtml}
      <div class="table-scroll mt-8">
        <table>
          <thead><tr><th>Tienda</th><th>Producto</th><th>Precio</th><th></th></tr></thead>
          <tbody>
            ${resultados.map((r) => `
              <tr class="${minPrecio != null && Number(r.precio) === minPrecio ? 'cotizador-mejor-precio' : ''}">
                <td>${esc(TIENDA_LABELS[r.tienda] || r.tienda)}</td>
                <td>${esc(r.nombre_producto)}</td>
                <td>${r.precio != null ? fmtMoney(r.precio) : '—'}</td>
                <td>${r.url_producto ? `<a href="${esc(r.url_producto)}" target="_blank" rel="noopener noreferrer" class="btn small">Ver</a>` : ''}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
    $('#btnCotizadorActualizar').addEventListener('click', () => buscar(query, true));
  }

  async function buscar(query, forzar = false) {
    if (!query || !query.trim()) { toast('Escribe un término de búsqueda', 'danger'); return; }
    const miToken = ++searchToken;
    const cont = $('#cotizadorResultados');
    const btnBuscar = $('#btnCotizadorBuscar');
    // Animación de carga (prompt-animacion-carga-cotizador.md): el backend
    // responde todo junto al final (sin streaming por tienda), así que no
    // hay señal real de "esta tienda ya terminó" — en vez de simular
    // checkmarks falsos (engañoso si el timing no coincide), se usa un
    // "escaneo" ambiguo que recorre las 3 tiendas en loop + mensaje
    // rotativo + shimmer sobre la forma de la tabla que está por aparecer.
    // 100% CSS (@keyframes cotizadorScan/cotizadorMsgFade/cotizadorShimmer
    // en styles.css), sin JS timers que limpiar.
    cont.innerHTML = `
      <div class="cotizador-loading">
        <div class="cotizador-loading-tiendas">
          <span class="cotizador-loading-tienda" style="--i:0">Home Depot</span>
          <span class="cotizador-loading-tienda" style="--i:1">Sodimac</span>
          <span class="cotizador-loading-tienda" style="--i:2">Amazon</span>
        </div>
        <div class="cotizador-loading-msg">
          <span>Comparando precios en 3 tiendas…</span>
          <span>Puede tardar unos segundos…</span>
          <span>Casi listo…</span>
        </div>
        <div class="cotizador-skeleton">
          <div class="cotizador-skeleton-row"></div>
          <div class="cotizador-skeleton-row"></div>
          <div class="cotizador-skeleton-row"></div>
        </div>
      </div>
    `;
    btnBuscar.disabled = true;
    // La función serverless tiene maxDuration:90s (vercel.json) — si por
    // algún motivo la plataforma la mata sin responder, el fetch se quedaría
    // esperando indefinidamente sin este timeout explícito (bug real
    // diagnosticado en prompt-diagnostico-cotizador-colgado.md).
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 95000);
    try {
      const resultado = forzar
        ? await api('/cotizador/actualizar', { method: 'POST', body: { q: query }, signal: controller.signal })
        : await api(`/cotizador/buscar?q=${encodeURIComponent(query)}`, { signal: controller.signal });
      if (miToken !== searchToken) return; // respuesta obsoleta: ya hay una búsqueda más reciente en curso
      ultimaBusqueda = resultado;
      pintarResultados();
    } catch (err) {
      if (miToken !== searchToken) return; // idem: no pisar el estado de una búsqueda más reciente con un error viejo
      const msg = err.name === 'AbortError'
        ? 'La búsqueda tardó demasiado y se canceló. Intenta de nuevo.'
        : err.message;
      cont.innerHTML = `<div class="alert-box danger">⚠️ ${esc(msg)}</div>`;
    } finally {
      clearTimeout(timeoutId);
      if (miToken === searchToken) btnBuscar.disabled = false;
    }
  }

  $('#btnCotizadorBuscar').addEventListener('click', () => buscar($('#cotizadorInput').value));
  $('#cotizadorInput').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') buscar($('#cotizadorInput').value); });
}

// =========================================================================
// VISTA: Maquinaria propia (prompt-modulo-maquinaria) — catálogo global de
// equipos (no por obra, igual que Proveedores), combustible/mantenimiento
// (taller/admin/desarrollador) y horas de uso (cabo, hoy solo
// retroexcavadoras). DISEÑO DE PRIMER BORRADOR, pendiente de revisión.
// =========================================================================
const MAQUINARIA_TIPOS = ['retroexcavadora'];
let maquinariaEquiposCache = [];

async function renderMaquinaria(view) {
  const [equipos, resumen, misPermisos, misPermisosCaptura, misPermisosCombustible, proyectos, reporteClientes] = await Promise.all([
    api('/maquinaria/equipos'),
    api('/maquinaria/resumen'),
    api('/mis-permisos/maquinaria'),
    api('/mis-permisos/maquinaria_captura'),
    api('/mis-permisos/maquinaria_combustible'),
    api('/projects').catch(() => []),
    api('/maquinaria/reporte-clientes').catch(() => null),
  ]);
  maquinariaEquiposCache = equipos;
  const puedeCrear = !!misPermisos.puede_crear; // equipos — sección 'maquinaria', sin cambio (CN-002)
  const puedeEditar = !!misPermisos.puede_editar;
  const puedeEliminar = !!misPermisos.puede_eliminar;
  // CN-002: combustible/mantenimiento y horas ya no comparten el permiso de
  // 'maquinaria' (que antes obligaba a excluir a cabo a mano con !esCabo,
  // y nunca excluía a taller de horas) — cada botón usa su propia sección.
  const puedeCrearCombustible = !!misPermisosCombustible.puede_crear;
  const puedeCrearHoras = !!misPermisosCaptura.puede_crear;

  // Cifras de presupuesto (total/gastado/%/sugerido por cliente) — solo
  // admin/desarrollador; backend ya las envía null para el resto de roles,
  // esto solo evita renderizar un bloque vacío.
  const puedeVerPresupuesto = isAdmin();
  const pct = Math.min(100, resumen.pct_gastado || 0);
  view.innerHTML = `
    <h2 class="section-title">Maquinaria</h2>
    <p class="muted">Catálogo de equipos propios, combustible, mantenimiento y horas de uso — presupuesto único para toda la flota.</p>
    ${puedeVerPresupuesto ? `
    <div class="card">
      <div class="card-row"><span class="k">Presupuesto total</span><span class="v">${fmtMoney(resumen.monto_total)}</span></div>
      <div class="card-row"><span class="k">Gastado (combustible + mantenimiento)</span><span class="v">${fmtMoney(resumen.gasto_total)}</span></div>
      <div class="progress-bar mt-8 ${resumen.alerta ? 'over' : ''}"><span data-pct="${pct}"></span></div>
      <div class="muted fs-08 mt-4">${fmtPct(resumen.pct_gastado)} del presupuesto${resumen.alerta ? ` — ⚠️ superó el ${resumen.umbral_alerta_pct}% de alerta` : ''}</div>
      ${puedeEditar ? `<button class="btn small mt-8" id="btnEditarPresupuestoMaq">Editar presupuesto total</button>` : ''}
    </div>
    ` : ''}

    ${puedeVerPresupuesto && reporteClientes ? renderReporteClientesMaqHtml(reporteClientes) : ''}

    <div class="section-actions mt-12">
      ${puedeCrear ? '<button class="btn btn-primary" id="btnNuevoEquipoMaq">+ Nuevo equipo</button>' : ''}
      ${puedeCrearCombustible ? '<button class="btn" id="btnCombustibleMaq">+ Combustible</button>' : ''}
      ${puedeCrearCombustible ? '<button class="btn" id="btnMantenimientoMaq">+ Mantenimiento</button>' : ''}
      ${puedeCrearHoras ? '<button class="btn" id="btnHorasMaq">+ Capturar horas</button>' : ''}
    </div>
    <div id="equiposMaqList"></div>
  `;

  $('#btnEditarPresupuestoMaq')?.addEventListener('click', () => openPresupuestoMaqModal(resumen.monto_total, reporteClientes));
  $('#btnNuevoEquipoMaq')?.addEventListener('click', () => openEquipoMaqModal(null, proyectos));
  $('#btnCombustibleMaq')?.addEventListener('click', () => openCombustibleMaqModal(equipos));
  $('#btnMantenimientoMaq')?.addEventListener('click', () => openMantenimientoMaqModal(equipos));
  $('#btnHorasMaq')?.addEventListener('click', () => openHorasMaqModal(equipos, proyectos));
  { const fill = $('.progress-bar > span[data-pct]', view); if (fill) fill.style.width = fill.dataset.pct + '%'; }

  paintEquiposMaqList(equipos, proyectos, { puedeEditar, puedeEliminar });
}

// Reporte por cliente (Fase 2, prompt-maquinaria-presupuesto-automatico):
// presupuesto sugerido (SUM de insumos EQUIPO Y HERRAMIENTA, con respaldo en
// meta.subtotal_herramienta_equipo cuando insumos da 0) vs. gasto real. El
// asterisco + tooltip marca cuándo el monto de un cliente incluye al menos
// una obra resuelta por el respaldo — es dinero real que ve el cliente, debe
// quedar trazable de dónde salió cada número.
function renderReporteClientesMaqHtml(reporte) {
  const filas = reporte.por_cliente.map((c) => `
    <tr>
      <td>${esc(c.cliente)}${c.fuente_mixta ? '<span class="muted fs-07" title="Al menos una obra de este cliente no tiene insumos de categoría \'Equipo y herramienta\' capturados — se usó el subtotal confirmado del contrato en su lugar."> *</span>' : ''}</td>
      <td class="num">${fmtMoney(c.presupuesto_sugerido)}</td>
      <td class="num">${fmtMoney(c.gasto_total)}</td>
    </tr>
  `).join('');
  const sinObra = reporte.sin_obra_asignada;
  const sinObraRow = sinObra.gasto_total > 0 ? `
    <tr>
      <td class="muted">Equipos sin obra asignada</td>
      <td class="num muted">—</td>
      <td class="num">${fmtMoney(sinObra.gasto_total)}</td>
    </tr>
  ` : '';
  return `
    <h3 class="section-title mt-12">Presupuesto sugerido por cliente</h3>
    <p class="muted fs-08">Calculado automáticamente desde los insumos de "Equipo y herramienta" de cada obra${reporte.fuente_mixta ? ' (los marcados con * usan el subtotal del contrato confirmado como respaldo)' : ''} — no reemplaza el presupuesto manual, solo lo sugiere.</p>
    <div class="card">
      <div class="table-scroll">
        <table>
          <thead><tr><th>Cliente</th><th class="num">Presupuesto sugerido</th><th class="num">Gasto real</th></tr></thead>
          <tbody>
            ${filas}
            ${sinObraRow}
          </tbody>
          <tfoot>
            <tr><td><strong>Total global</strong></td><td class="num"><strong>${fmtMoney(reporte.total_sugerido)}</strong></td><td class="num"><strong>${fmtMoney(reporte.por_cliente.reduce((s, c) => s + c.gasto_total, 0) + sinObra.gasto_total)}</strong></td></tr>
          </tfoot>
        </table>
      </div>
    </div>
  `;
}

function paintEquiposMaqList(equipos, proyectos, { puedeEditar, puedeEliminar }) {
  const list = $('#equiposMaqList');
  if (!equipos.length) {
    list.innerHTML = '<div class="empty-state">No hay equipos registrados todavía.</div>';
    return;
  }
  const ESTADO_BADGE = { activo: 'green', mantenimiento: 'yellow', baja: 'red' };
  list.innerHTML = equipos.map((e) => `
    <div class="card" data-equipo-card="${e.id}">
      <div class="row between">
        <div>
          <strong>${esc(e.nombre)}</strong>
          <div class="muted fs-08">${esc(e.tipo)}${e.identificador ? ` · ${esc(e.identificador)}` : ''}</div>
          ${e.obra_nombre ? `<div class="muted fs-08">🏗️ ${esc(e.obra_nombre)}</div>` : '<div class="muted fs-08">Sin obra asignada</div>'}
        </div>
        <span class="badge ${ESTADO_BADGE[e.estado] || 'muted'}">${esc(e.estado)}</span>
      </div>
      ${(puedeEditar || puedeEliminar) ? `
      <div class="row end mt8-gap8">
        ${puedeEditar ? `<button class="btn small" data-edit-equipo-maq="${e.id}">Editar</button>` : ''}
        ${puedeEliminar ? `<button class="btn small btn-danger" data-del-equipo-maq="${e.id}">Eliminar</button>` : ''}
      </div>` : ''}
      <button class="collapse-toggle mt-12" data-toggle-historial-maq="${e.id}">
        <span>📋 Historial (combustible, mantenimiento, horas)</span>
        <span class="chev">▾</span>
      </button>
      <div class="collapse-body" id="historialMaq-${e.id}"></div>
    </div>
  `).join('');

  $$('[data-edit-equipo-maq]', list).forEach((btn) => {
    btn.addEventListener('click', () => {
      const e = equipos.find((x) => x.id === Number(btn.dataset.editEquipoMaq));
      if (e) openEquipoMaqModal(e, proyectos);
    });
  });
  $$('[data-del-equipo-maq]', list).forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('¿Eliminar este equipo? No se puede deshacer.')) return;
      try {
        await api(`/maquinaria/equipos/${btn.dataset.delEquipoMaq}`, { method: 'DELETE' });
        toast('Equipo eliminado', 'success');
        renderView();
      } catch (err) { toast(err.message, 'danger'); }
    });
  });
  $$('[data-toggle-historial-maq]', list).forEach((btn) => {
    btn.addEventListener('click', () => toggleHistorialMaq(btn));
  });
}

async function toggleHistorialMaq(btn) {
  const equipoId = Number(btn.dataset.toggleHistorialMaq);
  const body = document.getElementById(`historialMaq-${equipoId}`);
  const isOpen = btn.classList.toggle('open');
  body.classList.toggle('open', isOpen);
  if (!isOpen || body.dataset.loaded) return;
  body.dataset.loaded = '1';
  body.innerHTML = '<div class="spinner"></div>';
  try {
    const [combustible, mantenimientos, horas] = await Promise.all([
      api(`/maquinaria/combustible?equipo_id=${equipoId}`),
      api(`/maquinaria/mantenimientos?equipo_id=${equipoId}`),
      api(`/maquinaria/horas?equipo_id=${equipoId}`),
    ]);
    const filas = [
      ...combustible.map((c) => ({ fecha: c.fecha, tipo: 'Combustible', detalle: `${fmtNum(c.litros, 1)} L`, monto: c.costo, quien: c.registrado_por_nombre })),
      ...mantenimientos.map((m) => ({ fecha: m.fecha, tipo: `Mantenimiento (${m.tipo})`, detalle: m.descripcion || '—', monto: m.costo, quien: m.registrado_por_nombre })),
      ...horas.map((h) => ({ fecha: h.fecha, tipo: 'Horas de uso', detalle: `${fmtNum(h.horas, 1)} h${h.obra_nombre ? ` · ${h.obra_nombre}` : ''}`, monto: null, quien: h.operador_nombre })),
    ].sort((a, b) => (a.fecha < b.fecha ? 1 : -1));
    if (!filas.length) {
      body.innerHTML = '<p class="muted fs-08 py10-px4">Sin registros todavía.</p>';
      return;
    }
    body.innerHTML = `
      <div class="table-scroll">
        <table>
          <thead><tr><th>Fecha</th><th>Tipo</th><th>Detalle</th><th class="num">Monto</th><th>Registró</th></tr></thead>
          <tbody>
            ${filas.map((f) => `
              <tr>
                <td>${fmtDate(f.fecha)}</td>
                <td>${esc(f.tipo)}</td>
                <td>${esc(f.detalle)}</td>
                <td class="num">${f.monto != null ? fmtMoney(f.monto) : '—'}</td>
                <td class="muted fs-08">${esc(f.quien || '—')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    body.innerHTML = `<div class="alert-box danger">⚠️ ${esc(err.message)}</div>`;
  }
}

function openEquipoMaqModal(equipo, proyectos) {
  const isEdit = !!equipo;
  openModal(`
    <h3>${isEdit ? 'Editar equipo' : 'Nuevo equipo'}</h3>
    <div class="field"><label>Nombre *</label><input id="eqNombre" value="${isEdit ? esc(equipo.nombre) : ''}" /></div>
    <div class="field"><label>Tipo</label>
      <select id="eqTipo">${MAQUINARIA_TIPOS.map((t) => `<option value="${t}" ${isEdit && equipo.tipo === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
    </div>
    <div class="field"><label>Identificador / serie</label><input id="eqIdentificador" value="${isEdit ? esc(equipo.identificador || '') : ''}" /></div>
    <div class="field"><label>Estado</label>
      <select id="eqEstado">
        ${['activo', 'mantenimiento', 'baja'].map((s) => `<option value="${s}" ${isEdit && equipo.estado === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
      </select>
    </div>
    <div class="field"><label>Obra asignada</label>
      <select id="eqObra">
        <option value="">Sin asignar</option>
        ${proyectos.map((p) => `<option value="${p.id}" ${isEdit && equipo.obra_id === p.id ? 'selected' : ''}>${esc(p.nombre)}</option>`).join('')}
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelEquipoMaq">Cerrar</button>
      <button class="btn btn-primary" id="btnSaveEquipoMaq">${isEdit ? 'Guardar cambios' : 'Crear equipo'}</button>
    </div>
  `);
  $('#eqNombre').focus();
  $('#btnCancelEquipoMaq').addEventListener('click', closeModal);
  $('#btnSaveEquipoMaq').addEventListener('click', async () => {
    const nombre = $('#eqNombre').value.trim();
    if (!nombre) { toast('Escribe el nombre del equipo', 'danger'); return; }
    const btn = $('#btnSaveEquipoMaq');
    btn.disabled = true;
    const body = {
      nombre, tipo: $('#eqTipo').value, identificador: $('#eqIdentificador').value.trim() || null,
      estado: $('#eqEstado').value, obra_id: $('#eqObra').value ? Number($('#eqObra').value) : null,
    };
    try {
      if (isEdit) await api(`/maquinaria/equipos/${equipo.id}`, { method: 'PUT', body });
      else await api('/maquinaria/equipos', { method: 'POST', body });
      toast(isEdit ? 'Equipo actualizado' : 'Equipo creado', 'success');
      closeModal();
      renderView();
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false;
    }
  });
}

function openPresupuestoMaqModal(montoActual, sugerido) {
  const tieneSugerido = sugerido && sugerido.total_sugerido > 0;
  openModal(`
    <h3>Editar presupuesto total de maquinaria</h3>
    <p class="muted fs-08">Monto único para toda la flota — no está dividido por periodo (asunción pendiente de confirmar).</p>
    ${tieneSugerido ? `
      <div class="muted fs-08 mb-8">
        Sugerido automáticamente: <strong>${fmtMoney(sugerido.total_sugerido)}</strong>${sugerido.fuente_mixta ? `<span title="Al menos una obra no tiene insumos de categoría &quot;Equipo y herramienta&quot; capturados — se usó el subtotal confirmado del contrato como respaldo."> *</span>` : ''}
        — basado en insumos de "Equipo y herramienta" de todas las obras.
        <button type="button" class="btn small" id="btnUsarSugeridoMaq">Usar sugerido</button>
      </div>
    ` : ''}
    <div class="field"><label>Monto total *</label><input id="presMaqMonto" type="number" min="0" step="0.01" value="${montoActual}" /></div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelPresMaq">Cerrar</button>
      <button class="btn btn-primary" id="btnSavePresMaq">Guardar</button>
    </div>
  `);
  $('#presMaqMonto').focus();
  $('#btnUsarSugeridoMaq')?.addEventListener('click', () => { $('#presMaqMonto').value = sugerido.total_sugerido; });
  $('#btnCancelPresMaq').addEventListener('click', closeModal);
  $('#btnSavePresMaq').addEventListener('click', async () => {
    const monto = Number($('#presMaqMonto').value);
    if (!(monto >= 0)) { toast('Indica un monto válido', 'danger'); return; }
    const btn = $('#btnSavePresMaq');
    btn.disabled = true;
    try {
      await api('/maquinaria/presupuesto', { method: 'PUT', body: { monto_total: monto } });
      toast('Presupuesto actualizado', 'success');
      closeModal();
      renderView();
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false;
    }
  });
}

function equipoSelectOptions(equipos, soloRetroexcavadoras) {
  const filtrados = soloRetroexcavadoras ? equipos.filter((e) => e.tipo === 'retroexcavadora') : equipos;
  return filtrados.map((e) => `<option value="${e.id}">${esc(e.nombre)}${e.identificador ? ` (${esc(e.identificador)})` : ''}</option>`).join('');
}

function openCombustibleMaqModal(equipos) {
  openModal(`
    <h3>Registrar combustible</h3>
    <div class="field"><label>Equipo *</label><select id="cbEquipo">${equipoSelectOptions(equipos, false)}</select></div>
    <div class="field"><label>Fecha *</label><input id="cbFecha" type="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
    <div class="field"><label>Litros *</label><input id="cbLitros" type="number" min="0" step="0.01" /></div>
    <div class="field"><label>Costo *</label><input id="cbCosto" type="number" min="0" step="0.01" /></div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelCb">Cerrar</button>
      <button class="btn btn-primary" id="btnSaveCb">Guardar</button>
    </div>
  `);
  $('#btnCancelCb').addEventListener('click', closeModal);
  $('#btnSaveCb').addEventListener('click', async () => {
    const body = {
      equipo_id: Number($('#cbEquipo').value), fecha: $('#cbFecha').value,
      litros: Number($('#cbLitros').value), costo: Number($('#cbCosto').value),
    };
    if (!body.equipo_id || !body.fecha || !(body.litros > 0) || !(body.costo >= 0)) {
      toast('Completa equipo, fecha, litros y costo', 'danger'); return;
    }
    const btn = $('#btnSaveCb');
    btn.disabled = true;
    try {
      await api('/maquinaria/combustible', { method: 'POST', body });
      toast('Combustible registrado', 'success');
      closeModal();
      renderView();
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false;
    }
  });
}

function openMantenimientoMaqModal(equipos) {
  openModal(`
    <h3>Registrar mantenimiento</h3>
    <div class="field"><label>Equipo *</label><select id="mtEquipo">${equipoSelectOptions(equipos, false)}</select></div>
    <div class="field"><label>Fecha *</label><input id="mtFecha" type="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
    <div class="field"><label>Tipo *</label>
      <select id="mtTipo"><option value="preventivo">Preventivo</option><option value="correctivo">Correctivo</option></select>
    </div>
    <div class="field"><label>Descripción</label><input id="mtDescripcion" /></div>
    <div class="field"><label>Costo *</label><input id="mtCosto" type="number" min="0" step="0.01" /></div>
    <div class="field"><label>Proveedor</label><input id="mtProveedor" /></div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelMt">Cerrar</button>
      <button class="btn btn-primary" id="btnSaveMt">Guardar</button>
    </div>
  `);
  $('#btnCancelMt').addEventListener('click', closeModal);
  $('#btnSaveMt').addEventListener('click', async () => {
    const body = {
      equipo_id: Number($('#mtEquipo').value), fecha: $('#mtFecha').value, tipo: $('#mtTipo').value,
      descripcion: $('#mtDescripcion').value.trim() || null, costo: Number($('#mtCosto').value),
      proveedor: $('#mtProveedor').value.trim() || null,
    };
    if (!body.equipo_id || !body.fecha || !(body.costo >= 0)) {
      toast('Completa equipo, fecha y costo', 'danger'); return;
    }
    const btn = $('#btnSaveMt');
    btn.disabled = true;
    try {
      await api('/maquinaria/mantenimientos', { method: 'POST', body });
      toast('Mantenimiento registrado', 'success');
      closeModal();
      renderView();
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false;
    }
  });
}

function openHorasMaqModal(equipos, proyectos) {
  openModal(`
    <h3>Capturar horas de uso</h3>
    <p class="muted fs-08">Por ahora solo retroexcavadoras — ver nota de diseño pendiente de revisión.</p>
    <div class="field"><label>Equipo *</label><select id="hrEquipo">${equipoSelectOptions(equipos, true)}</select></div>
    <div class="field"><label>Fecha *</label><input id="hrFecha" type="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
    <div class="field"><label>Horas *</label><input id="hrHoras" type="number" min="0" step="0.1" /></div>
    <div class="field"><label>Obra / actividad</label>
      <select id="hrObra"><option value="">Sin especificar</option>${proyectos.map((p) => `<option value="${p.id}">${esc(p.nombre)}</option>`).join('')}</select>
    </div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelHr">Cerrar</button>
      <button class="btn btn-primary" id="btnSaveHr">Guardar</button>
    </div>
  `);
  $('#btnCancelHr').addEventListener('click', closeModal);
  $('#btnSaveHr').addEventListener('click', async () => {
    const body = {
      equipo_id: Number($('#hrEquipo').value), fecha: $('#hrFecha').value,
      horas: Number($('#hrHoras').value), obra_id: $('#hrObra').value ? Number($('#hrObra').value) : null,
    };
    if (!body.equipo_id || !body.fecha || !(body.horas > 0)) {
      toast('Completa equipo, fecha y horas', 'danger'); return;
    }
    const btn = $('#btnSaveHr');
    btn.disabled = true;
    try {
      await api('/maquinaria/horas', { method: 'POST', body });
      toast('Horas registradas', 'success');
      closeModal();
      renderView();
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false;
    }
  });
}

// =========================================================================
// VISTA: Finanzas — Resumen Financiero (Avance Valorizado vs Erogado Real,
// dos fuentes de verdad separadas) + Gastos Generales (costos que no nacen
// de una requisición: nómina, permisos, renta de equipo, combustible…)
// =========================================================================
const GASTO_CATEGORIA_LABELS = {
  nomina: 'Nómina',
  permisos: 'Permisos',
  renta_equipo: 'Renta de equipo',
  combustible: 'Combustible',
  servicios: 'Servicios',
  otro: 'Otro',
};
let gastosFilter = { categoria: '', estado: '' };

async function renderFinanzas(view) {
  const [resumen, gastos] = await Promise.all([
    api(`/projects/${state.projectId}/finanzas/resumen`),
    api(`/projects/${state.projectId}/gastos${queryString(gastosFilter)}`),
  ]);

  const av = resumen.avance_valorizado;
  const er = resumen.erogado_real;
  const brecha = resumen.brecha;
  const brechaPositiva = brecha.monto >= 0;

  view.innerHTML = `
    <h2 class="section-title">Finanzas</h2>
    <p class="muted">Compara el avance valorizado (% ejecutado del presupuesto) contra el dinero realmente erogado — son dos números distintos a propósito, no se fusionan.</p>
    <div class="section-actions">
      <button class="btn" id="btnExportFinanzas">⭳ Exportar a Excel</button>
    </div>

    <div class="kpi-grid finanzas-kpi-grid">
      <div class="kpi accent field-full">
        <div class="label">Avance Valorizado</div>
        <div class="value">${fmtPct(av.pct)}</div>
        <div class="muted finanzas-av-monto">${fmtMoney(av.monto)}</div>
      </div>
    </div>

    <div class="card border-verde">
      <h3 class="section-title finanzas-section-h3">Erogado Real</h3>
      <p class="muted finanzas-iva-note">Los montos de Compras se muestran ajustados a base sin IVA (÷${(1 + er.iva_ajuste_pct / 100).toFixed(2)}) para que sean comparables contra Avance Valorizado, que también es sin IVA. Esto no cambia lo realmente pagado al proveedor — solo la base usada aquí para comparar.</p>
      <div class="card-row"><span class="k">Total pagado</span><span class="v text-verde">${fmtMoney(er.total_pagado)}</span></div>
      <div class="card-row"><span class="k">Total comprometido (no pagado)</span><span class="v text-amarillo">${fmtMoney(er.total_comprometido_no_pagado)}</span></div>
      <h4 class="finanzas-desglose-h4">Desglose</h4>
      <div class="card-row"><span class="k">Compras — pagado (sin IVA, ajustado)</span><span class="v">${fmtMoney(er.compras_pagado)}</span></div>
      <div class="card-row"><span class="k">Compras — pagado (con IVA, real)</span><span class="v muted">${fmtMoney(er.compras_pagado_con_iva)}</span></div>
      <div class="card-row"><span class="k">Compras — comprometido (sin IVA, ajustado)</span><span class="v">${fmtMoney(er.compras_comprometido)}</span></div>
      <div class="card-row"><span class="k">Compras — comprometido (con IVA, real)</span><span class="v muted">${fmtMoney(er.compras_comprometido_con_iva)}</span></div>
      <div class="card-row"><span class="k">Gastos generales — pagado</span><span class="v">${fmtMoney(er.gastos_generales_pagado)}</span></div>
      <div class="card-row"><span class="k">Gastos generales — pendiente</span><span class="v">${fmtMoney(er.gastos_generales_pendiente)}</span></div>
      <div class="card-row"><span class="k">Destajo — ejecutado (mano de obra)</span><span class="v">${fmtMoney(er.destajo_ejecutado)}</span></div>
    </div>

    <div class="card ${brechaPositiva ? 'border-verde' : 'border-rojo'}">
      <h3 class="section-title finanzas-section-h3">Brecha</h3>
      <div class="value brecha-value ${brechaPositiva ? 'text-verde' : 'text-rojo'}">${fmtMoney(brecha.monto)}</div>
      <p class="muted mt-8">${esc(brecha.descripcion)}</p>
    </div>

    <h3 class="section-title">Gastos Generales</h3>
    <div class="row finanzas-filtros-row">
      <select id="gastoFiltroCategoria" class="finanzas-filtro-select">
        <option value="">Todas las categorías</option>
        ${Object.entries(GASTO_CATEGORIA_LABELS).map(([k, l]) => `<option value="${k}" ${gastosFilter.categoria === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}
      </select>
      <select id="gastoFiltroEstado" class="finanzas-filtro-select">
        <option value="">Todos los estados</option>
        <option value="pendiente" ${gastosFilter.estado === 'pendiente' ? 'selected' : ''}>Pendiente</option>
        <option value="pagado" ${gastosFilter.estado === 'pagado' ? 'selected' : ''}>Pagado</option>
      </select>
    </div>
    ${isAdmin() ? `
    <div class="section-actions">
      <button class="btn btn-primary" id="btnNuevoGasto">+ Registrar gasto</button>
    </div>` : ''}
    <div id="gastosList"></div>
  `;

  wireExportButton('#btnExportFinanzas', `/projects/${state.projectId}/finanzas/export${queryString(gastosFilter)}`);
  $('#gastoFiltroCategoria').addEventListener('change', (e) => { gastosFilter.categoria = e.target.value; renderView(); });
  $('#gastoFiltroEstado').addEventListener('change', (e) => { gastosFilter.estado = e.target.value; renderView(); });
  $('#btnNuevoGasto')?.addEventListener('click', () => openGastoModal(null));

  paintGastosList(gastos);
}

function paintGastosList(gastos) {
  const list = $('#gastosList');
  if (!gastos.length) {
    list.innerHTML = '<div class="empty-state">No hay gastos generales registrados con ese filtro.</div>';
    return;
  }
  list.innerHTML = gastos.map((g) => `
    <div class="card">
      <div class="row between">
        <div>
          <strong>${esc(g.concepto)}</strong>
          <div class="muted fs-08">${esc(GASTO_CATEGORIA_LABELS[g.categoria] || g.categoria)} · ${fmtDate(g.fecha)}</div>
          ${g.observaciones ? `<div class="muted fs-078">${esc(g.observaciones)}</div>` : ''}
        </div>
        <div class="text-right">
          <div class="fw-700">${fmtMoney(g.monto)}</div>
          <span class="badge ${g.estado === 'pagado' ? 'green' : 'yellow'}">${esc(g.estado)}</span>
        </div>
      </div>
      ${isAdmin() ? `
      <div class="row end mt8-gap8">
        <button class="btn small" data-edit-gasto="${g.id}">Editar</button>
        <button class="btn small" data-toggle-gasto="${g.id}">${g.estado === 'pagado' ? 'Marcar pendiente' : 'Marcar pagado'}</button>
        ${g.estado === 'pendiente' ? `<button class="btn small btn-danger" data-del-gasto="${g.id}">Eliminar</button>` : ''}
      </div>` : ''}
    </div>
  `).join('');

  $$('[data-edit-gasto]', list).forEach((btn) => {
    btn.addEventListener('click', () => {
      const g = gastos.find((x) => x.id === Number(btn.dataset.editGasto));
      if (g) openGastoModal(g);
    });
  });
  $$('[data-toggle-gasto]', list).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const g = gastos.find((x) => x.id === Number(btn.dataset.toggleGasto));
      if (!g) return;
      try {
        await api(`/projects/${state.projectId}/gastos/${g.id}/estado`, {
          method: 'PUT', body: { estado: g.estado === 'pagado' ? 'pendiente' : 'pagado' },
        });
        toast('Estado actualizado', 'success');
        renderView();
      } catch (err) { toast(err.message, 'danger'); }
    });
  });
  $$('[data-del-gasto]', list).forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('¿Eliminar este gasto?')) return;
      try {
        await api(`/projects/${state.projectId}/gastos/${Number(btn.dataset.delGasto)}`, { method: 'DELETE' });
        toast('Gasto eliminado', 'success');
        renderView();
      } catch (err) { toast(err.message, 'danger'); }
    });
  });
}

function openGastoModal(gasto) {
  const isEdit = !!gasto;
  const catOptions = Object.entries(GASTO_CATEGORIA_LABELS)
    .map(([k, l]) => `<option value="${k}" ${gasto && gasto.categoria === k ? 'selected' : ''}>${esc(l)}</option>`)
    .join('');
  openModal(`
    <h3>${isEdit ? 'Editar gasto' : 'Registrar gasto'}</h3>
    <div class="field"><label>Categoría *</label><select id="gCategoria">${catOptions}</select></div>
    <div class="field"><label>Concepto *</label><input id="gConcepto" placeholder="Ej. Nómina semana 12" value="${isEdit ? esc(gasto.concepto) : ''}" /></div>
    <div class="field"><label>Fecha</label><input id="gFecha" type="date" value="${isEdit ? esc(String(gasto.fecha).slice(0, 10)) : new Date().toISOString().slice(0, 10)}" /></div>
    <div class="field"><label>Monto *</label><input id="gMonto" type="number" min="0" step="any" value="${isEdit ? gasto.monto : ''}" /></div>
    <div class="field"><label>Observaciones</label><textarea id="gObs" rows="2">${isEdit ? esc(gasto.observaciones || '') : ''}</textarea></div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelGasto">Cerrar</button>
      <button class="btn btn-primary" id="btnSaveGasto">${isEdit ? 'Guardar cambios' : 'Registrar gasto'}</button>
    </div>
  `);
  $('#btnCancelGasto').addEventListener('click', closeModal);
  $('#btnSaveGasto').addEventListener('click', async () => {
    const concepto = $('#gConcepto').value.trim();
    const monto = Number($('#gMonto').value);
    if (!concepto) { toast('Escribe el concepto del gasto', 'danger'); return; }
    if (!monto || monto <= 0) { toast('Indica un monto mayor a 0', 'danger'); return; }
    const btn = $('#btnSaveGasto');
    btn.disabled = true;
    const body = {
      categoria: $('#gCategoria').value,
      concepto,
      fecha: $('#gFecha').value || null,
      monto,
      observaciones: $('#gObs').value.trim() || null,
    };
    try {
      if (isEdit) {
        await api(`/projects/${state.projectId}/gastos/${gasto.id}`, { method: 'PUT', body });
        toast('Gasto actualizado', 'success');
      } else {
        await api(`/projects/${state.projectId}/gastos`, { method: 'POST', body });
        toast('Gasto registrado', 'success');
      }
      closeModal();
      renderView();
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false;
    }
  });
}

// =========================================================================
// VISTA: Estado de Resultados (Tesorería) — prompt-estado-resultados-tesoreria.
// Ingresos facturados (devengado, NO cobrado) vs Egresos (Erogado Real
// completo de Finanzas, reutilizado vía GET .../estado-resultados) = Margen
// Bruto. La cobranza real (cobros) se muestra aparte como métrica de flujo
// de caja, sin afectar el margen — misma decisión que ya se tomó con Paul.
// Dos vistas separadas, mismo patrón que Nóminas/Nóminas (todas las obras):
// 'estadoResultados' (por obra, requiere obra seleccionada) y
// 'estadoResultadosGlobal' (consolidado, siempre disponible).
// =========================================================================
const FACTURA_ESTATUS_LABELS = {
  pendiente: 'Pendiente', cobrada_parcial: 'Cobrada parcial', cobrada_total: 'Cobrada total', cancelada: 'Cancelada',
};
const FACTURA_ESTATUS_BADGE = {
  pendiente: 'yellow', cobrada_parcial: 'yellow', cobrada_total: 'green', cancelada: 'muted',
};

function erDesgloseEgresosHtml(egresos) {
  const d = egresos.desglose;
  return `
    <h4 class="finanzas-desglose-h4">Desglose de Egresos</h4>
    <div class="card-row"><span class="k">Compras — pagado</span><span class="v">${fmtMoney(d.compras_pagado)}</span></div>
    <div class="card-row"><span class="k">Compras — comprometido</span><span class="v">${fmtMoney(d.compras_comprometido)}</span></div>
    <div class="card-row"><span class="k">Gastos generales — pagado</span><span class="v">${fmtMoney(d.gastos_generales_pagado)}</span></div>
    <div class="card-row"><span class="k">Gastos generales — pendiente</span><span class="v">${fmtMoney(d.gastos_generales_pendiente)}</span></div>
    <div class="card-row"><span class="k">Destajo — ejecutado</span><span class="v">${fmtMoney(d.destajo_ejecutado)}</span></div>
    <div class="card-row"><span class="k">Total pagado</span><span class="v text-verde">${fmtMoney(egresos.pagado)}</span></div>
    <div class="card-row"><span class="k">Total comprometido (no pagado)</span><span class="v text-amarillo">${fmtMoney(egresos.comprometido_no_pagado)}</span></div>
  `;
}

async function renderEstadoResultados(view) {
  const puedeGestionar = isAdmin() || state.user?.puesto === 'tesoreria';
  const [resumen, facturas] = await Promise.all([
    api(`/projects/${state.projectId}/estado-resultados`),
    api(`/projects/${state.projectId}/facturas`),
  ]);
  const margenPositivo = resumen.margen_bruto >= 0;

  view.innerHTML = `
    <h2 class="section-title">Estado de Resultados</h2>
    <p class="muted">Ingresos facturados (devengado) contra Egresos (Erogado Real de Finanzas) = Margen Bruto. La cobranza real se muestra aparte, sin afectar el margen.</p>
    <div class="section-actions">
      <button class="btn" id="btnVerConsolidadoER">Ver consolidado (todas las obras)</button>
    </div>

    <div class="kpi-grid finanzas-kpi-grid">
      <div class="kpi accent"><div class="label">Ingresos facturados (sin IVA)</div><div class="value">${fmtMoney(resumen.ingresos.facturado_sin_iva)}</div></div>
      <div class="kpi"><div class="label">Egresos</div><div class="value">${fmtMoney(resumen.egresos.total)}</div></div>
      <div class="kpi ${margenPositivo ? 'green' : 'yellow'}"><div class="label">Margen Bruto</div><div class="value">${fmtMoney(resumen.margen_bruto)}</div><div class="muted">${fmtPct(resumen.margen_pct)}</div></div>
    </div>

    <div class="card">
      <div class="card-row"><span class="k">Ingresos facturados (con IVA)</span><span class="v">${fmtMoney(resumen.ingresos.facturado_con_iva)}</span></div>
      <div class="card-row"><span class="k">IVA facturado</span><span class="v">${fmtMoney(resumen.ingresos.facturado_iva)}</span></div>
      <div class="card-row"><span class="k">Cobrado a la fecha</span><span class="v">${fmtMoney(resumen.ingresos.cobrado_total)}</span></div>
      <div class="card-row"><span class="k">Número de facturas</span><span class="v">${resumen.ingresos.num_facturas}</span></div>
    </div>

    <div class="card border-verde">${erDesgloseEgresosHtml(resumen.egresos)}</div>

    <h3 class="section-title">Facturas</h3>
    ${puedeGestionar ? `
    <div class="section-actions">
      <button class="btn btn-primary" id="btnNuevaFactura">+ Nueva factura</button>
    </div>` : ''}
    <div id="facturasList"></div>
  `;

  $('#btnVerConsolidadoER').addEventListener('click', () => switchToView('estadoResultadosGlobal'));
  $('#btnNuevaFactura')?.addEventListener('click', () => openFacturaModal(null));

  paintFacturasList(facturas, puedeGestionar);
}

function paintFacturasList(facturas, puedeGestionar) {
  const list = $('#facturasList');
  if (!facturas.length) {
    list.innerHTML = '<div class="empty-state">No hay facturas registradas para esta obra.</div>';
    return;
  }
  list.innerHTML = facturas.map((f) => `
    <div class="card">
      <div class="row between">
        <div>
          <strong>${esc(f.folio || 'Sin folio')}</strong> — ${esc(f.concepto)}
          <div class="muted fs-08">${fmtDate(f.fecha_emision)}</div>
        </div>
        <div class="text-right">
          <div class="fw-700">${fmtMoney(f.monto_total)}</div>
          <span class="badge ${FACTURA_ESTATUS_BADGE[f.estatus] || 'muted'}">${esc(FACTURA_ESTATUS_LABELS[f.estatus] || f.estatus)}</span>
        </div>
      </div>
      <div class="card-row"><span class="k">Subtotal / IVA</span><span class="v muted">${fmtMoney(f.monto_subtotal)} + ${fmtMoney(f.iva)}</span></div>
      <div class="card-row"><span class="k">Cobrado</span><span class="v">${fmtMoney(f.monto_cobrado)} / ${fmtMoney(f.monto_total)}</span></div>
      ${puedeGestionar && f.estatus !== 'cancelada' ? `
      <div class="row end mt8-gap8">
        <button class="btn small" data-registrar-cobro="${f.id}">Registrar cobro</button>
        ${Number(f.monto_cobrado) <= 0 ? `<button class="btn small" data-edit-factura="${f.id}">Editar</button><button class="btn small btn-danger" data-cancel-factura="${f.id}">Cancelar</button>` : ''}
      </div>` : ''}
    </div>
  `).join('');

  $$('[data-registrar-cobro]', list).forEach((btn) => {
    btn.addEventListener('click', () => {
      const f = facturas.find((x) => x.id === Number(btn.dataset.registrarCobro));
      if (f) openCobroModal(f);
    });
  });
  $$('[data-edit-factura]', list).forEach((btn) => {
    btn.addEventListener('click', () => {
      const f = facturas.find((x) => x.id === Number(btn.dataset.editFactura));
      if (f) openFacturaModal(f);
    });
  });
  $$('[data-cancel-factura]', list).forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('¿Cancelar esta factura? Quedará marcada como cancelada — no se elimina, se conserva para auditoría.')) return;
      try {
        await api(`/projects/${state.projectId}/facturas/${Number(btn.dataset.cancelFactura)}`, { method: 'DELETE' });
        toast('Factura cancelada', 'success');
        renderView();
      } catch (err) { toast(err.message, 'danger'); }
    });
  });
}

function openFacturaModal(factura) {
  const isEdit = !!factura;
  openModal(`
    <h3>${isEdit ? 'Editar factura' : 'Nueva factura'}</h3>
    <div class="field"><label>Folio</label><input id="fFolio" placeholder="Ej. F-1024" value="${isEdit ? esc(factura.folio || '') : ''}" /></div>
    <div class="field"><label>Concepto *</label><input id="fConcepto" placeholder="Ej. Estimación 3 - Obra civil" value="${isEdit ? esc(factura.concepto) : ''}" /></div>
    <div class="field"><label>Fecha de emisión</label><input id="fFecha" type="date" value="${isEdit ? esc(String(factura.fecha_emision).slice(0, 10)) : new Date().toISOString().slice(0, 10)}" /></div>
    <div class="field"><label>Subtotal (sin IVA) *</label><input id="fSubtotal" type="number" min="0" step="any" value="${isEdit ? factura.monto_subtotal : ''}" /></div>
    <div class="field"><label>IVA</label><input id="fIva" type="number" min="0" step="any" value="${isEdit ? factura.iva : ''}" /></div>
    <div class="field"><label>Total (con IVA) *</label><input id="fTotal" type="number" min="0" step="any" value="${isEdit ? factura.monto_total : ''}" /></div>
    <p class="muted fs-08">Subtotal + IVA debe ser igual al Total (se calcula automático al llenar Subtotal/IVA).</p>
    <div class="modal-actions">
      <button class="btn" id="btnCancelFactura">Cerrar</button>
      <button class="btn btn-primary" id="btnSaveFactura">${isEdit ? 'Guardar cambios' : 'Registrar factura'}</button>
    </div>
  `);
  $('#btnCancelFactura').addEventListener('click', closeModal);

  const recalcTotal = () => {
    const sub = Number($('#fSubtotal').value) || 0;
    const iva = Number($('#fIva').value) || 0;
    if (sub || iva) $('#fTotal').value = (sub + iva).toFixed(2);
  };
  $('#fSubtotal').addEventListener('input', recalcTotal);
  $('#fIva').addEventListener('input', recalcTotal);

  $('#btnSaveFactura').addEventListener('click', async () => {
    const concepto = $('#fConcepto').value.trim();
    const subtotal = Number($('#fSubtotal').value);
    const iva = Number($('#fIva').value) || 0;
    const total = Number($('#fTotal').value);
    if (!concepto) { toast('Escribe el concepto de la factura', 'danger'); return; }
    if (!subtotal || subtotal <= 0) { toast('Indica un subtotal mayor a 0', 'danger'); return; }
    if (!total || total <= 0) { toast('Indica un total mayor a 0', 'danger'); return; }
    if (Math.abs((subtotal + iva) - total) > 0.01) { toast('Subtotal + IVA debe ser igual al Total', 'danger'); return; }
    const btn = $('#btnSaveFactura');
    btn.disabled = true;
    const body = {
      folio: $('#fFolio').value.trim() || null, concepto, fecha_emision: $('#fFecha').value || null,
      monto_subtotal: subtotal, iva, monto_total: total,
    };
    try {
      if (isEdit) {
        await api(`/projects/${state.projectId}/facturas/${factura.id}`, { method: 'PUT', body });
        toast('Factura actualizada', 'success');
      } else {
        await api(`/projects/${state.projectId}/facturas`, { method: 'POST', body });
        toast('Factura registrada', 'success');
      }
      closeModal();
      renderView();
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false;
    }
  });
}

function openCobroModal(factura) {
  const pendiente = Math.max(0, Number(factura.monto_total) - Number(factura.monto_cobrado));
  openModal(`
    <h3>Registrar cobro — ${esc(factura.folio || factura.concepto)}</h3>
    <p class="muted">Cobrado a la fecha: ${fmtMoney(factura.monto_cobrado)} de ${fmtMoney(factura.monto_total)} (pendiente: ${fmtMoney(pendiente)})</p>
    <div class="field"><label>Fecha de cobro</label><input id="cFecha" type="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
    <div class="field"><label>Monto cobrado *</label><input id="cMonto" type="number" min="0" step="any" value="${pendiente > 0 ? pendiente.toFixed(2) : ''}" /></div>
    <div class="field"><label>Forma de pago</label><input id="cFormaPago" placeholder="Ej. Transferencia" /></div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelCobro">Cerrar</button>
      <button class="btn btn-primary" id="btnSaveCobro">Registrar cobro</button>
    </div>
  `);
  $('#btnCancelCobro').addEventListener('click', closeModal);
  $('#btnSaveCobro').addEventListener('click', async () => {
    const monto = Number($('#cMonto').value);
    if (!monto || monto <= 0) { toast('Indica un monto mayor a 0', 'danger'); return; }
    const btn = $('#btnSaveCobro');
    btn.disabled = true;
    try {
      await api(`/projects/${state.projectId}/facturas/${factura.id}/cobros`, {
        method: 'POST',
        body: { fecha_cobro: $('#cFecha').value || null, monto_cobrado: monto, forma_pago: $('#cFormaPago').value.trim() || null },
      });
      toast('Cobro registrado', 'success');
      closeModal();
      renderView();
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false;
    }
  });
}

async function renderEstadoResultadosGlobal(view) {
  const data = await api('/estado-resultados/consolidado');
  const t = data.totales;
  const margenPositivo = t.margen_bruto >= 0;

  view.innerHTML = `
    <h2 class="section-title">Estado de Resultados — Consolidado</h2>
    <p class="muted">Ingresos facturados vs Egresos de todas las obras a las que tienes acceso.</p>

    <div class="kpi-grid finanzas-kpi-grid">
      <div class="kpi accent"><div class="label">Ingresos facturados (sin IVA)</div><div class="value">${fmtMoney(t.ingresos_sin_iva)}</div></div>
      <div class="kpi"><div class="label">Egresos</div><div class="value">${fmtMoney(t.egresos_total)}</div></div>
      <div class="kpi ${margenPositivo ? 'green' : 'yellow'}"><div class="label">Margen Bruto</div><div class="value">${fmtMoney(t.margen_bruto)}</div><div class="muted">${fmtPct(t.margen_pct)}</div></div>
    </div>
    <div class="card">
      <div class="card-row"><span class="k">Ingresos facturados (con IVA)</span><span class="v">${fmtMoney(t.ingresos_con_iva)}</span></div>
      <div class="card-row"><span class="k">Cobrado a la fecha</span><span class="v">${fmtMoney(t.cobrado_total)}</span></div>
    </div>

    <h3 class="section-title">Por obra</h3>
    <div class="card">
      <div class="table-scroll">
        <table>
          <thead><tr><th>Obra</th><th class="num">Ingresos</th><th class="num">Egresos</th><th class="num">Margen</th><th class="num">%</th></tr></thead>
          <tbody>
            ${data.obras.map((o) => `
              <tr class="row-click" data-pid="${o.project_id}">
                <td>${esc(o.nombre)}</td>
                <td class="num">${fmtMoney(o.ingresos.facturado_sin_iva)}</td>
                <td class="num">${fmtMoney(o.egresos.total)}</td>
                <td class="num ${o.margen_bruto >= 0 ? 'text-verde' : 'text-rojo'}">${fmtMoney(o.margen_bruto)}</td>
                <td class="num">${fmtPct(o.margen_pct)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      ${data.obras.length === 0 ? '<div class="empty-state">Sin obras con acceso.</div>' : ''}
    </div>
  `;

  $$('.row-click', view).forEach((row) => {
    row.addEventListener('click', () => selectProject(Number(row.dataset.pid), 'estadoResultados'));
  });
}

// ---------------------------------------------------------------------------
// FAB: contextual quick-action depending on the active view
// ---------------------------------------------------------------------------
const fab = document.createElement('button');
fab.className = 'fab';
fab.textContent = '+';
fab.style.display = 'none';
document.body.appendChild(fab);
fab.addEventListener('click', () => {
  if (state.view === 'requisiciones') {
    if (getDraft().length) openDraftModal();
    else { switchToView('insumos'); toast('Agrega insumos desde el catálogo primero', ''); }
  } else if (state.view === 'insumos') {
    if (getDraft().length) { switchToView('requisiciones'); }
  } else if (state.view === 'destajo') {
    if (isAdmin() || (state.user && effectivePuesto() === 'residente')) openNuevoDestajistaModal();
  } else if (isAdmin()) {
    promptUpload();
  }
});
function syncFab() {
  const noFabViews = ['usuarios', 'proveedores', 'ordenes', 'finanzas', 'estadoResultados', 'estadoResultadosGlobal', 'mapeo', 'avance'];
  const hasAction = ['requisiciones', 'insumos', 'destajo'].includes(state.view);
  const esGaleria = state.view.endsWith('_gallery');
  fab.style.display = !esGaleria && !noFabViews.includes(state.view) && state.projectId && (hasAction || isAdmin()) ? 'flex' : 'none';
  if (state.view === 'requisiciones' || state.view === 'insumos') fab.textContent = '🧾';
  else if (state.view === 'destajo') fab.textContent = '👷';
  else fab.textContent = '+';
}

// ---------------------------------------------------------------------------
// Sincronización: vacía el caché en memoria y recarga todos los datos del
// servidor, útil desde el teléfono cuando la app quedó con datos viejos.
// ---------------------------------------------------------------------------
const btnSync = $('#btnSync');
btnSync.addEventListener('click', async () => {
  btnSync.classList.add('spin');
  btnSync.disabled = true;
  // Limpiar TODO el caché en memoria para todos los proyectos
  for (const bucket of Object.values(state.cache)) {
    for (const key of Object.keys(bucket)) delete bucket[key];
  }
  try {
    await refreshProjectList();
    renderView();
    toast('Datos sincronizados', 'success');
  } catch (err) {
    toast('Sin conexión con el servidor', 'danger');
  } finally {
    setTimeout(() => { btnSync.classList.remove('spin'); btnSync.disabled = false; }, 600);
  }
});

// ---------------------------------------------------------------------------
// UX: select-all al enfocar un campo numérico (avance, montos, cantidades,
// tasas de IVA, etc.) — un solo listener delegado en document, así lo heredan
// automáticamente todos los inputs numéricos actuales y futuros de la app,
// sin tener que repetirlo pantalla por pantalla. 'focus' no burbujea, por
// eso se usa fase de captura (tercer argumento true).
// ---------------------------------------------------------------------------
document.addEventListener('focus', (e) => {
  if (e.target.matches && e.target.matches('input[type="number"]')) {
    e.target.select();
  }
}, true);

// ---------------------------------------------------------------------------
// PWA: service worker registration
// ---------------------------------------------------------------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  // sw.js usa skipWaiting()+clients.claim(), así que un SW nuevo toma control
  // de esta misma pestaña sin recargarla — pero el JS ya cargado en memoria
  // sigue siendo el viejo hasta el próximo reload. Sin esto, una pestaña
  // abierta durante un deploy queda ejecutando app.js viejo contra el backend
  // ya nuevo (causa real del login roto tras el deploy de 2FA: el JS viejo
  // asumía la forma de respuesta anterior a 2FA). Recarga una sola vez
  // cuando el nuevo SW toma control.
  let swReloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (swReloading) return;
    swReloading = true;
    window.location.reload();
  });
}

// ---------------------------------------------------------------------------
// Sidebar — inicialización y event listeners
// ---------------------------------------------------------------------------
applySidebarCollapse();

$('#btnSidebarProject').addEventListener('click', openDrawer);
$('#sbarVolverClientes').addEventListener('click', () => goToClientGallery());
$('#btnSidebarBrand').addEventListener('click', () => goToClientGallery());
$('#sidebarOverlay').addEventListener('click', closeSidebar);
// Selector de vista simulada (el select se renderiza dinámicamente en sidebarNav)
$('#sidebarNav').addEventListener('change', (e) => {
  if (e.target.id === 'simRoleSelect') {
    const val = e.target.value;
    if (val === '') stopSimulation(); else startSimulation(val);
  }
});
$('#simBannerExit').addEventListener('click', stopSimulation);

// Popover de perfil (desktop y móvil)
$('#btnUserProfile').addEventListener('click', (e) => {
  e.stopPropagation();
  const pop = $('#userPopover');
  if (pop && pop.classList.contains('show')) { closeUserPopover(); } else { openUserPopover(); }
});
document.addEventListener('click', (e) => {
  const pop = $('#userPopover');
  if (pop && pop.classList.contains('show') && !pop.contains(e.target) && e.target !== $('#btnUserProfile')) {
    closeUserPopover();
  }
});
$$('[data-theme-set]').forEach((btn) => {
  btn.addEventListener('click', () => setTheme(btn.dataset.themeSet));
});
$('#chkReduceMotionPopover')?.addEventListener('change', (e) => setReduceMotion(e.target.checked));
$('#chkHighContrastPopover')?.addEventListener('change', (e) => setHighContrast(e.target.checked));
$('#btnLogoutPopover').addEventListener('click', () => { closeUserPopover(); logout(); });
$('#btnMiCuentaPopover').addEventListener('click', () => { closeUserPopover(); openMiCuentaModal(false); });
$('#btnInstallAppPopover').addEventListener('click', () => { closeUserPopover(); installApp(); });
if (isStandalone()) $('#btnInstallAppPopover').style.display = 'none';

// Barra inferior móvil
(function () {
  const ii = $('#mobileNavInicioIcon');   if (ii) ii.innerHTML = icon('home', 20);
  const ri = $('#mobileNavResumenIcon');  if (ri) ri.innerHTML = icon('resumen', 20);
  const ni = $('#mobileNavNotifIcon');    if (ni) ni.innerHTML = icon('bell', 20);
  const ai = $('#mobileNavAjustesIcon');  if (ai) ai.innerHTML = icon('settings', 20);
})();

$('#mobileNavInicio').addEventListener('click', () => goToClientGallery());
$('#mobileNavResumen').addEventListener('click', () => {
  if (!state.projectId) { toast('Selecciona un presupuesto primero', ''); return; }
  switchToView(state.allowedTabs.includes('resumen') ? 'resumen' : 'inicio');
});
$('#btnMobileQuick').addEventListener('click', openQuickActionMenu);
$('#btnMobileNotif').addEventListener('click', async () => {
  await refreshNotificaciones().catch(() => {});
  openModal(`
    <div class="notif-header-row">
      <h3 class="modal-title">Notificaciones</h3>
      <button class="btn small" id="btnMarcarMobileLeidas">Todas leídas</button>
    </div>
    <div id="mobileNotifListEl" class="notif-list notif-list-scroll"></div>
    <div class="modal-actions"><button class="btn" id="btnCerrarNotifMobile">Cerrar</button></div>
  `);
  renderNotifList($('#mobileNotifListEl'));
  $('#btnMarcarMobileLeidas')?.addEventListener('click', async () => {
    try {
      await api('/notificaciones/leer-todas', { method: 'PUT' });
      state.notificaciones.forEach((n) => { n.leida = true; });
      state.notifNoLeidas = 0;
      renderNotifBadge();
      renderNotifList($('#mobileNotifListEl'));
    } catch (err) { toast(err.message, 'danger'); }
  });
  $('#btnCerrarNotifMobile')?.addEventListener('click', closeModal);
});
$('#mobileNavAjustes').addEventListener('click', openMobileAjustes);
$('#quickActionBackdrop').addEventListener('click', closeQuickActionMenu);
$('#toast').addEventListener('click', () => { clearTimeout(toast._t); $('#toast').className = 'toast'; });

// ---------------------------------------------------------------------------
// Trabajadores
// ---------------------------------------------------------------------------

const TIPO_PAGO_LABELS = { jornal: 'Jornal fijo', destajo: 'Destajo', mixto: 'Mixto' };
const PERIODICIDAD_LABELS = { semanal: 'Semanal', quincenal: 'Quincenal', mensual: 'Mensual' };
const TIPO_DOC_LABELS = { ine_frente: 'INE frente', ine_reverso: 'INE reverso', curp_doc: 'CURP', domicilio: 'Comprobante domicilio', otro: 'Otro' };

// Vista global — solo admin/desarrollador (ver GET /api/trabajadores en
// server/app.js): todos los trabajadores de todas las obras, con la obra y
// el/los residente(s) a cargo. Solo lectura — dar de alta/editar sigue
// siendo por obra, en la pestaña Trabajadores normal.
async function renderTrabajadoresGlobal(view) {
  view.innerHTML = '<div class="spinner"></div>';
  let mostrarInactivos = false;
  async function repaint() {
    const trabajadores = await api(`/trabajadores${mostrarInactivos ? '' : '?activo=1'}`);
    pintarTabla(trabajadores);
  }
  function pintarTabla(trabajadores) {
    const tbody = $('#trabGlobalTbody', view);
    if (!tbody) return;
    if (!trabajadores.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No hay trabajadores registrados.</td></tr>`;
      return;
    }
    tbody.innerHTML = trabajadores.map((t) => `
      <tr>
        <td>${esc(t.nombre)}${!t.activo ? ' <span class="badge red">Inactivo</span>' : ''}</td>
        <td>${esc(t.puesto || '—')}</td>
        <td>${esc(t.cliente_nombre || '—')}</td>
        <td>${esc(t.obra_nombre)}</td>
        <td>${esc(t.residentes_a_cargo || '—')}</td>
        <td>${esc(TIPO_PAGO_LABELS[t.tipo_pago] || t.tipo_pago)}</td>
      </tr>
    `).join('');
  }
  view.innerHTML = `
    <h2 class="section-title">Trabajadores — todas las obras</h2>
    <p class="muted">Vista de solo lectura. Para dar de alta o editar un trabajador, entra a la pestaña Trabajadores de su obra.</p>
    <div class="section-actions">
      <label class="checkbox-label-inline">
        <input type="checkbox" id="chkTrabGlobalInactivos" class="w-auto"> Ver inactivos
      </label>
    </div>
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Trabajador</th>
            <th>Puesto</th>
            <th>Cliente</th>
            <th>Obra</th>
            <th>Residente(s) a cargo</th>
            <th>Tipo de pago</th>
          </tr>
        </thead>
        <tbody id="trabGlobalTbody"><tr><td colspan="6" class="empty-state">Cargando…</td></tr></tbody>
      </table>
    </div>
  `;
  $('#chkTrabGlobalInactivos').addEventListener('change', async (e) => {
    mostrarInactivos = e.target.checked;
    await repaint();
  });
  await repaint();
}

async function renderTrabajadores(view) {
  // Antes hardcodeado a isAdmin() — ahora usa el permiso granular por-obra
  // (prompts-cotizador-sidebar-permisos-estimaciones.md, Prompt 3), mismo
  // patrón que renderAvance()/misPermisosAvance. admin/desarrollador siguen
  // viendo todo (el endpoint de mis-permisos les devuelve todo en true).
  const misPermisos = await api(`/projects/${state.projectId}/mis-permisos/trabajadores`);
  if (!misPermisos.puede_ver) {
    view.innerHTML = `<div class="alert-box danger">⚠️ No tienes permiso para ver esta sección.</div>`;
    return;
  }
  // "Nuevo trabajador" es la única acción que un no-admin puede ganar vía el
  // permiso granular (puede_crear) — editar/documentos/contratos/EPP/baja/
  // eliminar se quedan admin-only (puedeGestionarTrabajadores()) porque sus
  // endpoints siguen sin checkPermiso real, mismo alcance parcial que 'nominas'.
  const puedeCrear = isAdmin() || !!misPermisos.puede_crear;
  let mostrarInactivos = false;
  async function repaint() {
    const trabajadores = await api(`/projects/${state.projectId}/trabajadores${mostrarInactivos ? '' : '?activo=1'}`);
    const listEl = $('#trabajadoresList');
    if (!listEl) return;
    paintTrabajadoresList(trabajadores, listEl, repaint);
  }

  view.innerHTML = `
    <h2 class="section-title">Trabajadores</h2>
    <p class="muted">Expediente de personal asignado a esta obra.</p>
    <div class="section-actions section-actions-wrap">
      ${puedeCrear ? `<button class="btn btn-primary" id="btnNuevoTrabajador">+ Nuevo trabajador</button>` : ''}
      ${puedeGestionarTrabajadores() ? `<button class="btn" id="btnCatalogoEpp">Catálogo EPP</button>` : ''}
      <label class="checkbox-label-inline">
        <input type="checkbox" id="chkVerInactivos" class="w-auto"> Ver inactivos
      </label>
    </div>
    <div id="trabajadoresList"><div class="empty-state">Cargando…</div></div>
  `;

  $('#btnNuevoTrabajador')?.addEventListener('click', () => openTrabajadorModal(null, repaint));
  $('#btnCatalogoEpp')?.addEventListener('click', () => openCatalogoEppModal());
  $('#chkVerInactivos')?.addEventListener('change', async (e) => {
    mostrarInactivos = e.target.checked;
    await repaint();
  });
  await repaint();
}

function paintTrabajadoresList(trabajadores, listEl, repaint) {
  if (!trabajadores.length) {
    listEl.innerHTML = '<div class="empty-state">No hay trabajadores registrados.</div>';
    return;
  }
  listEl.innerHTML = trabajadores.map((t) => `
    <div class="card ${!t.activo ? 'card-inactive' : ''}">
      <div class="row between align-start">
        <div>
          <strong>${esc(t.nombre)}</strong>
          ${t.puesto ? `<div class="muted fs-08">${esc(t.puesto)}</div>` : ''}
          <div class="mt4-fs08">
            <span class="badge muted">${esc(TIPO_PAGO_LABELS[t.tipo_pago] || t.tipo_pago)}</span>
            <span class="badge muted">${esc(PERIODICIDAD_LABELS[t.periodicidad] || t.periodicidad)}</span>
            ${!t.activo ? `<span class="badge red">Inactivo</span>` : ''}
          </div>
        </div>
        <div class="row row-nowrap-gap6-start">
          ${puedeGestionarTrabajadores() ? `
            <button class="btn small" data-edit-trab="${t.id}">Editar</button>
            <button class="btn small" data-docs-trab="${t.id}" data-docs-nombre="${esc(t.nombre)}">Docs</button>
            <button class="btn small" data-contratos-trab="${t.id}" data-contratos-nombre="${esc(t.nombre)}">Contrato</button>
            <button class="btn small" data-epp-trab="${t.id}" data-epp-nombre="${esc(t.nombre)}">EPP</button>
            ${t.activo
              ? `<button class="btn small btn-danger" data-baja-trab="${t.id}" data-baja-nombre="${esc(t.nombre)}">Dar baja</button>`
              : `<button class="btn small" data-reactiva-trab="${t.id}">Reactivar</button>
                 <button class="btn small btn-danger" data-del-trab="${t.id}" data-del-nombre="${esc(t.nombre)}">Eliminar</button>`
            }` : ''}
        </div>
      </div>
      ${t.tipo_pago !== 'destajo' ? `
        <div class="muted fs078-mt4">
          Tarifa jornal: $${Number(t.tarifa_jornal || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 })} / día
        </div>` : ''}
    </div>
  `).join('');

  $$('[data-edit-trab]', listEl).forEach((btn) => {
    const t = trabajadores.find((x) => x.id === Number(btn.dataset.editTrab));
    if (t) btn.addEventListener('click', () => openTrabajadorModal(t, repaint));
  });
  $$('[data-docs-trab]', listEl).forEach((btn) => {
    btn.addEventListener('click', () => openDocumentosModal(Number(btn.dataset.docsTrab), btn.dataset.docsNombre));
  });
  $$('[data-contratos-trab]', listEl).forEach((btn) => {
    btn.addEventListener('click', () => openContratosModal(Number(btn.dataset.contratosTrab), btn.dataset.contratosNombre));
  });
  $$('[data-epp-trab]', listEl).forEach((btn) => {
    btn.addEventListener('click', () => openEppModal(Number(btn.dataset.eppTrab), btn.dataset.eppNombre));
  });
  $$('[data-baja-trab]', listEl).forEach((btn) => {
    btn.addEventListener('click', () => openBajaModal(Number(btn.dataset.bajaTrab), btn.dataset.bajaNombre, repaint));
  });
  $$('[data-reactiva-trab]', listEl).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.reactivaTrab);
      try {
        await api(`/projects/${state.projectId}/trabajadores/${id}/reactivar`, { method: 'POST' });
        toast('Trabajador reactivado', 'success');
        await repaint();
      } catch (err) { toast(err.message, 'danger'); }
    });
  });
  $$('[data-del-trab]', listEl).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.delTrab);
      const nombre = btn.dataset.delNombre;
      if (!confirm(`¿Eliminar permanentemente a "${nombre}"? Se borrarán su expediente y todos sus registros. Esta acción no se puede deshacer.`)) return;
      try {
        await api(`/projects/${state.projectId}/trabajadores/${id}`, { method: 'DELETE' });
        toast('Trabajador eliminado', 'success');
        await repaint();
      } catch (err) { toast(err.message, 'danger'); }
    });
  });
}

// Inputs de montos (tarifa jornal, salario contractual): type="number" no puede
// mostrar "$" ni comas de miles sin dejar de aceptar solo dígitos. Se usa
// type="text" en su lugar — formateado en reposo, número crudo mientras se
// edita — y se parsea a número puro antes de enviar al backend (que sigue
// recibiendo el mismo dato numérico de siempre).
function formatMoneyInputDisplay(raw) {
  const num = Number(raw);
  if (raw === '' || raw == null || !Number.isFinite(num)) return '';
  return `$${num.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function parseMoneyInputRaw(str) {
  return String(str || '').replace(/[^0-9.]/g, '');
}
function wireMoneyInput(input) {
  if (!input) return;
  input.addEventListener('focus', () => {
    const cleaned = parseMoneyInputRaw(input.value);
    const num = parseFloat(cleaned);
    input.value = cleaned && Number.isFinite(num) ? String(num) : cleaned;
  });
  input.addEventListener('blur', () => {
    const raw = parseMoneyInputRaw(input.value);
    input.value = raw ? formatMoneyInputDisplay(raw) : '';
  });
}

async function openTrabajadorModal(trab, repaint) {
  const isEdit = !!trab;
  // Load destajistas for optional linking
  let destajistas = [];
  try { destajistas = await api(`/projects/${state.projectId}/destajistas`); } catch (_) {}

  const tipoPagoOpts = Object.entries(TIPO_PAGO_LABELS)
    .map(([v, l]) => `<option value="${v}" ${trab && trab.tipo_pago === v ? 'selected' : ''}>${l}</option>`).join('');
  const periodicidadOpts = Object.entries(PERIODICIDAD_LABELS)
    .map(([v, l]) => `<option value="${v}" ${trab && trab.periodicidad === v ? 'selected' : v === 'semanal' ? 'selected' : ''}>${l}</option>`).join('');
  const destajistaOpts = `<option value="">— Sin vínculo —</option>` +
    destajistas.map((d) => `<option value="${d.id}" ${trab && trab.destajista_id === d.id ? 'selected' : ''}>${esc(d.nombre)}</option>`).join('');

  openModal(`
    <h3>${isEdit ? 'Editar trabajador' : 'Nuevo trabajador'}</h3>
    <div class="trab-form-grid">
      <div class="field field-full"><label>Nombre completo *</label><input id="tNombre" value="${esc(trab?.nombre || '')}" /></div>
      <div class="field"><label>Puesto</label><input id="tPuesto" value="${esc(trab?.puesto || '')}" /></div>
      <div class="field"><label>Fecha de ingreso</label><input id="tFechaIngreso" type="date" value="${trab?.fecha_ingreso ? trab.fecha_ingreso.slice(0,10) : ''}" /></div>
      <div class="field"><label>Tipo de pago *</label><select id="tTipoPago">${tipoPagoOpts}</select></div>
      <div class="field"><label>Periodicidad *</label><select id="tPeriodicidad">${periodicidadOpts}</select></div>
      <div class="field field-full" id="tTarifaField"><label>Tarifa jornal ($/día)</label><input id="tTarifa" type="text" inputmode="decimal" value="${formatMoneyInputDisplay(trab?.tarifa_jornal ?? '')}" /></div>
      <div class="field field-full">
        <label>Vínculo con destajista (opcional)</label>
        <select id="tDestajista">${destajistaOpts}</select>
        <p class="muted fs076-m200">Permite importar producción de destajo al calcular nómina.</p>
      </div>
      <div class="field"><label>CURP</label><input id="tCurp" value="${esc(trab?.curp || '')}" /></div>
      <div class="field"><label>RFC</label><input id="tRfc" value="${esc(trab?.rfc || '')}" /></div>
      <div class="field"><label>NSS</label><input id="tNss" value="${esc(trab?.nss || '')}" /></div>
      <div class="field"><label>Teléfono</label><input id="tTelefono" value="${esc(trab?.telefono || '')}" /></div>
      <div class="field field-full"><label>Dirección</label><input id="tDireccion" value="${esc(trab?.direccion || '')}" /></div>
      <div class="field"><label>Contacto de emergencia — nombre</label><input id="tContactoNombre" value="${esc(trab?.contacto_emergencia_nombre || '')}" /></div>
      <div class="field"><label>Contacto de emergencia — teléfono</label><input id="tContactoTel" value="${esc(trab?.contacto_emergencia_telefono || '')}" /></div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelTrab">Cancelar</button>
      <button class="btn btn-primary" id="btnSaveTrab">${isEdit ? 'Guardar cambios' : 'Crear trabajador'}</button>
    </div>
  `);

  function syncTarifaField() {
    const tipo = $('#tTipoPago').value;
    $('#tTarifaField').style.display = tipo === 'destajo' ? 'none' : '';
  }
  syncTarifaField();
  $('#tTipoPago').addEventListener('change', syncTarifaField);
  wireMoneyInput($('#tTarifa'));
  $('#btnCancelTrab').addEventListener('click', closeModal);
  $('#btnSaveTrab').addEventListener('click', async () => {
    const nombre = $('#tNombre').value.trim();
    if (!nombre) { toast('El nombre es obligatorio', 'danger'); return; }
    const body = {
      nombre,
      puesto: $('#tPuesto').value.trim() || null,
      fecha_ingreso: $('#tFechaIngreso').value || null,
      tipo_pago: $('#tTipoPago').value,
      periodicidad: $('#tPeriodicidad').value,
      tarifa_jornal: parseFloat(parseMoneyInputRaw($('#tTarifa').value)) || 0,
      destajista_id: Number($('#tDestajista').value) || null,
      curp: $('#tCurp').value.trim() || null,
      rfc: $('#tRfc').value.trim() || null,
      nss: $('#tNss').value.trim() || null,
      telefono: $('#tTelefono').value.trim() || null,
      direccion: $('#tDireccion').value.trim() || null,
      contacto_emergencia_nombre: $('#tContactoNombre').value.trim() || null,
      contacto_emergencia_telefono: $('#tContactoTel').value.trim() || null,
    };
    const btn = $('#btnSaveTrab');
    btn.disabled = true;
    try {
      if (isEdit) {
        await api(`/projects/${state.projectId}/trabajadores/${trab.id}`, { method: 'PUT', body });
      } else {
        await api(`/projects/${state.projectId}/trabajadores`, { method: 'POST', body });
      }
      toast(isEdit ? 'Trabajador actualizado' : 'Trabajador creado', 'success');
      closeModal();
      await repaint();
    } catch (err) { toast(err.message, 'danger'); btn.disabled = false; }
  });
}

const MOTIVO_BAJA_LABELS = {
  renuncia: 'Renuncia voluntaria',
  despido_justificado: 'Despido justificado',
  despido_injustificado: 'Despido injustificado',
  fin_obra: 'Fin de obra',
  abandono: 'Abandono de trabajo',
  otro: 'Otro (especificar en notas)',
};

async function openBajaModal(id, nombre, repaint) {
  openModal(`
    <h3>Dar de baja a ${esc(nombre)}</h3>
    <p class="muted">El trabajador quedará inactivo. Su expediente e historial se conservan. Puedes reactivarlo en cualquier momento.</p>
    <div class="grid-gap8">
      <div class="field">
        <label>Motivo de baja *</label>
        <select id="tMotivoBaja">
          ${Object.entries(MOTIVO_BAJA_LABELS).map(([v,l]) => `<option value="${v}">${l}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Fecha de baja</label>
        <input id="tFechaBaja" type="date" value="${new Date().toISOString().slice(0,10)}" />
      </div>
      <div class="field" id="bajaNatasField">
        <label>Notas <span id="bajaNotasReq" class="hidden-initial baja-notas-req">*</span></label>
        <textarea id="tNotasBaja" rows="3" placeholder="Detalles adicionales…"></textarea>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelBaja">Cancelar</button>
      <button class="btn btn-danger" id="btnConfirmBaja">Dar de baja</button>
    </div>
  `);
  $('#tMotivoBaja').addEventListener('change', () => {
    const esOtro = $('#tMotivoBaja').value === 'otro';
    if (esOtro) $('#bajaNotasReq').classList.remove('hidden-initial'); // ver .hidden-initial en styles.css
    $('#bajaNotasReq').style.display = esOtro ? '' : 'none';
  });
  $('#btnCancelBaja').addEventListener('click', closeModal);
  $('#btnConfirmBaja').addEventListener('click', async () => {
    const motivo_baja = $('#tMotivoBaja').value;
    const notas = $('#tNotasBaja').value.trim() || null;
    if (motivo_baja === 'otro' && !notas) { toast('Las notas son requeridas cuando el motivo es "Otro"', 'danger'); return; }
    const btn = $('#btnConfirmBaja');
    btn.disabled = true;
    try {
      await api(`/projects/${state.projectId}/trabajadores/${id}/baja`, {
        method: 'POST',
        body: { motivo_baja, notas, fecha_baja: $('#tFechaBaja').value || null },
      });
      toast('Trabajador dado de baja', 'success');
      closeModal();
      await repaint();
    } catch (err) { toast(err.message, 'danger'); btn.disabled = false; }
  });
}

async function openDocumentosModal(trabajadorId, nombreTrab) {
  openModal(`
    <h3>Documentos — ${esc(nombreTrab)}</h3>
    <div id="docsListEl"><div class="empty-state">Cargando…</div></div>
    ${puedeGestionarTrabajadores() ? `
    <div class="section-divider-12">
      <p class="muted fs085-m008">Subir nuevo documento (INE, CURP, comprobante de domicilio)</p>
      <div class="form-grid-mb8">
        <div class="field"><label>Tipo</label>
          <select id="docTipo">
            ${Object.entries(TIPO_DOC_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Archivo</label><input id="docFile" type="file" accept="image/*,.pdf" /></div>
      </div>
      <button class="btn btn-primary" id="btnSubirDoc">Subir documento</button>
    </div>` : ''}
    <div class="modal-actions"><button class="btn" id="btnCerrarDocs">Cerrar</button></div>
  `);
  $('#btnCerrarDocs').addEventListener('click', closeModal);

  async function loadDocs() {
    const docs = await api(`/projects/${state.projectId}/trabajadores/${trabajadorId}/documentos`);
    const el = $('#docsListEl');
    if (!el) return;
    if (!docs.length) { el.innerHTML = '<div class="empty-state">Sin documentos cargados.</div>'; return; }
    el.innerHTML = docs.map((d) => `
      <div class="row between row-list-item-bc">
        <span class="fs-085">${esc(TIPO_DOC_LABELS[d.tipo_doc] || d.tipo_doc)} — ${esc(d.nombre_original)}</span>
        <div class="row gap-6">
          <button class="btn small" data-dl-doc="${d.id}" data-dl-nombre="${esc(d.nombre_original)}">Descargar</button>
          ${puedeGestionarTrabajadores() ? `<button class="btn small btn-danger" data-del-doc="${d.id}">Eliminar</button>` : ''}
        </div>
      </div>
    `).join('');

    $$('[data-dl-doc]', el).forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await apiDownload(`/projects/${state.projectId}/trabajadores/${trabajadorId}/documentos/${btn.dataset.dlDoc}/download`, btn.dataset.dlNombre);
        } catch (err) { toast(err.message, 'danger'); }
      });
    });
    $$('[data-del-doc]', el).forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('¿Eliminar este documento?')) return;
        try {
          await api(`/projects/${state.projectId}/trabajadores/${trabajadorId}/documentos/${btn.dataset.delDoc}`, { method: 'DELETE' });
          toast('Documento eliminado', 'success');
          await loadDocs();
        } catch (err) { toast(err.message, 'danger'); }
      });
    });
  }
  await loadDocs();

  $('#btnSubirDoc')?.addEventListener('click', async () => {
    const fileInput = $('#docFile');
    const file = fileInput?.files?.[0];
    if (!file) { toast('Selecciona un archivo', 'danger'); return; }
    const tipo = $('#docTipo').value;
    const btn = $('#btnSubirDoc');
    btn.disabled = true;
    btn.textContent = 'Subiendo…';
    try {
      const blob = await VercelBlobClient.upload(file.name, file, {
        access: 'private',
        handleUploadUrl: `/api/projects/${state.projectId}/trabajadores/${trabajadorId}/documentos/upload-token`,
        headers: state.token ? { Authorization: `Bearer ${state.token}` } : {},
        clientPayload: JSON.stringify({ tipo_doc: tipo }),
      });
      await api(`/projects/${state.projectId}/trabajadores/${trabajadorId}/documentos`, {
        method: 'POST',
        body: { blob_url: blob.url, nombre_original: file.name, tipo_doc: tipo },
      });
      toast('Documento subido', 'success');
      fileInput.value = '';
      await loadDocs();
    } catch (err) { toast(err.message, 'danger'); }
    btn.disabled = false;
    btn.textContent = 'Subir documento';
  });
}

// ---------------------------------------------------------------------------
// Contratos laborales por trabajador
// ---------------------------------------------------------------------------
const TIPO_CONTRATO_LABELS = {
  obra_determinada: 'Obra determinada',
  tiempo_determinado: 'Tiempo determinado',
  tiempo_indeterminado: 'Tiempo indeterminado',
};

async function openContratosModal(trabajadorId, nombreTrab) {
  openModal(`
    <div class="modal-header-row">
      <h3 class="modal-title">Contratos — ${esc(nombreTrab)}</h3>
      <button class="icon-btn modal-close-btn" id="btnCerrarContratos">✕</button>
    </div>
    <div id="contratosListEl"><div class="empty-state">Cargando…</div></div>
    <div class="modal-section-divider">
      <p class="muted modal-section-label">Registrar nuevo contrato</p>
      <div class="trab-form-grid">
        <div class="field field-full">
          <label>Tipo de contrato *</label>
          <select id="cTipo">
            ${Object.entries(TIPO_CONTRATO_LABELS).map(([v,l]) => `<option value="${v}">${l}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Fecha de inicio *</label><input id="cFechaInicio" type="date" /></div>
        <div class="field"><label>Fecha de fin</label><input id="cFechaFin" type="date" /></div>
        <div class="field field-full"><label>Salario diario contractual (MXN)</label><input id="cSalario" type="text" inputmode="decimal" placeholder="Solo informativo, no afecta nómina" /></div>
        <div class="field field-full"><label>PDF del contrato (opcional)</label><input id="cPdfFile" type="file" accept=".pdf" /></div>
      </div>
      <button class="btn btn-primary mt-8" id="btnGuardarContrato">Guardar contrato</button>
    </div>
  `);
  $('#btnCerrarContratos').addEventListener('click', closeModal);
  wireMoneyInput($('#cSalario'));

  async function loadContratos() {
    const contratos = await api(`/projects/${state.projectId}/trabajadores/${trabajadorId}/contratos`);
    const el = $('#contratosListEl');
    if (!el) return;
    if (!contratos.length) { el.innerHTML = '<div class="empty-state">Sin contratos registrados.</div>'; return; }
    el.innerHTML = contratos.map((c) => `
      <div class="card contrato-card">
        <div class="row-between-start">
          <div>
            <span class="badge ${c.activo ? 'green' : 'muted'}">${c.activo ? 'Vigente' : 'Histórico'}</span>
            <strong class="contrato-tipo-label">${esc(TIPO_CONTRATO_LABELS[c.tipo_contrato] || c.tipo_contrato)}</strong>
            <div class="muted contrato-meta">
              ${c.fecha_inicio ? fmtDateShort(c.fecha_inicio) : '—'}${c.fecha_fin ? ' → ' + fmtDateShort(c.fecha_fin) : ''}
              ${c.salario_diario ? ` · ${fmtMoney(c.salario_diario)}/día` : ''}
            </div>
            <div class="muted fs-075">Registrado por ${esc(c.creado_por_nombre || 'desconocido')}</div>
          </div>
          ${c.pdf_url ? `<button class="btn small" data-dl-contrato="${c.id}" data-dl-nombre="${esc(c.pdf_filename||'contrato.pdf')}">Ver PDF</button>` : ''}
        </div>
      </div>
    `).join('');
    $$('[data-dl-contrato]', el).forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await apiDownload(`/projects/${state.projectId}/trabajadores/${trabajadorId}/contratos/${btn.dataset.dlContrato}/download`, btn.dataset.dlNombre);
        } catch (err) { toast(err.message, 'danger'); }
      });
    });
  }
  await loadContratos();

  $('#btnGuardarContrato').addEventListener('click', async () => {
    const tipo_contrato = $('#cTipo').value;
    const fecha_inicio = $('#cFechaInicio').value;
    if (!fecha_inicio) { toast('La fecha de inicio es requerida', 'danger'); return; }
    const btn = $('#btnGuardarContrato');
    btn.disabled = true; btn.textContent = 'Guardando…';
    try {
      let pdf_url = null; let pdf_filename = null;
      const pdfFile = $('#cPdfFile')?.files?.[0];
      if (pdfFile) {
        btn.textContent = 'Subiendo PDF…';
        const blob = await VercelBlobClient.upload(pdfFile.name, pdfFile, {
          access: 'private',
          handleUploadUrl: `/api/projects/${state.projectId}/trabajadores/${trabajadorId}/contratos/upload-token`,
          headers: state.token ? { Authorization: `Bearer ${state.token}` } : {},
        });
        pdf_url = blob.url; pdf_filename = pdfFile.name;
      }
      await api(`/projects/${state.projectId}/trabajadores/${trabajadorId}/contratos`, {
        method: 'POST',
        body: {
          tipo_contrato,
          fecha_inicio,
          fecha_fin: $('#cFechaFin').value || null,
          salario_diario: parseFloat(parseMoneyInputRaw($('#cSalario').value)) || null,
          pdf_url, pdf_filename,
        },
      });
      toast('Contrato guardado', 'success');
      $('#cFechaInicio').value = ''; $('#cFechaFin').value = ''; $('#cSalario').value = ''; if ($('#cPdfFile')) $('#cPdfFile').value = '';
      await loadContratos();
    } catch (err) { toast(err.message, 'danger'); }
    btn.disabled = false; btn.textContent = 'Guardar contrato';
  });
}

// ---------------------------------------------------------------------------
// EPP — historial de entregas por trabajador + registro con firma
// ---------------------------------------------------------------------------
async function openEppModal(trabajadorId, nombreTrab) {
  let catalogo = [];
  try { catalogo = await api(`/projects/${state.projectId}/epp-catalogo?soloActivos=1`); }
  catch (err) { toast(`No se pudo cargar el catálogo EPP: ${err.message}`, 'danger'); }

  openModal(`
    <div class="modal-header-row">
      <h3 class="modal-title">EPP — ${esc(nombreTrab)}</h3>
      <button class="icon-btn modal-close-btn" id="btnCerrarEpp">✕</button>
    </div>
    <div id="eppListEl"><div class="empty-state">Cargando…</div></div>
    <div class="modal-section-divider">
      <p class="muted modal-section-label">Registrar entrega</p>
      ${!catalogo.length ? `<p class="muted fs-085">No hay ítems en el catálogo EPP de esta obra. <br>El administrador debe configurarlo primero.</p>` : `
      <div class="trab-form-grid">
        <div class="field field-full">
          <label>Artículo *</label>
          <select id="eppItemId">
            <option value="">— Seleccionar —</option>
            ${catalogo.map((c) => `<option value="${c.id}">${esc(c.nombre_item)}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Cantidad</label><input id="eppCantidad" type="number" min="1" value="1" /></div>
        <div class="field"><label>Fecha de entrega</label><input id="eppFecha" type="date" value="${new Date().toISOString().slice(0,10)}" /></div>
        <div class="field field-full">
          <label>Firma digital del trabajador (acuse de recibo)</label>
          <div class="firma-canvas-wrap">
            <canvas id="firmaCanvas" width="500" height="160" class="firma-canvas"></canvas>
          </div>
          <button class="btn small mt-4" id="btnLimpiarFirma">Limpiar firma</button>
        </div>
      </div>
      <button class="btn btn-primary mt-8" id="btnGuardarEpp">Guardar entrega</button>
      `}
    </div>
  `);
  $('#btnCerrarEpp').addEventListener('click', closeModal);

  async function loadEpp() {
    const entregas = await api(`/projects/${state.projectId}/trabajadores/${trabajadorId}/epp-entregas`);
    const el = $('#eppListEl');
    if (!el) return;
    if (!entregas.length) { el.innerHTML = '<div class="empty-state">Sin registros de entrega de EPP.</div>'; return; }
    const puedeEliminar = isAdminRealSinSimular();
    el.innerHTML = entregas.map((e) => `
      <div class="list-row-between" data-entrega-row="${e.id}">
        <div>
          <span class="epp-item-nombre">${esc(e.nombre_item)}</span>
          <span class="muted fs-08"> × ${e.cantidad}</span>
          <div class="muted fs-075">${fmtDateShort(e.fecha_entrega)} · ${esc(e.entregado_por_nombre || '—')}</div>
        </div>
        <div class="epp-entrega-actions">
          ${e.firma_digital ? `<img src="${e.firma_digital}" alt="firma" class="epp-firma-thumb" data-ver-firma="${e.id}" />` : '<span class="muted fs-075">Sin firma</span>'}
          ${puedeEliminar ? `<button class="btn small btn-danger" data-del-entrega="${e.id}" title="Eliminar registro">✕</button>` : ''}
        </div>
      </div>
    `).join('');

    $$('[data-ver-firma]', el).forEach((img) => {
      img.addEventListener('click', () => {
        openModal(`
          <div class="modal-header-row">
            <h3 class="modal-title">Firma digital</h3>
            <button class="icon-btn modal-close-btn" id="btnCerrarFirmaGrande">✕</button>
          </div>
          <img src="${img.src}" alt="firma" class="firma-full-img" />
        `);
        $('#btnCerrarFirmaGrande').addEventListener('click', closeModal);
      });
    });

    $$('[data-del-entrega]', el).forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('¿Eliminar este registro de entrega permanentemente? No se puede deshacer.')) return;
        btn.disabled = true;
        try {
          await api(`/projects/${state.projectId}/trabajadores/${trabajadorId}/epp-entregas/${btn.dataset.delEntrega}`, { method: 'DELETE' });
          toast('Registro de entrega eliminado', 'success');
          $(`[data-entrega-row="${btn.dataset.delEntrega}"]`)?.remove();
        } catch (err) { toast(err.message, 'danger'); btn.disabled = false; }
      });
    });
  }
  await loadEpp();

  if (catalogo.length) {
    const canvas = $('#firmaCanvas');
    const ctx = canvas?.getContext('2d');
    let drawing = false;
    const getPos = (ev) => {
      const r = canvas.getBoundingClientRect();
      const src = ev.touches ? ev.touches[0] : ev;
      return [(src.clientX - r.left) * (canvas.width / r.width), (src.clientY - r.top) * (canvas.height / r.height)];
    };
    // Pointer Events unificados (mouse + touch + pen en 3 listeners, en vez
    // de 6 separados) + setPointerCapture: el trazo sigue llegando aunque el
    // dedo salga brevemente del canvas y vuelva a entrar durante el gesto —
    // relevante porque esto es una firma legal de cumplimiento (entrega de
    // EPP), no solo un detalle de UX. pointercancel cubre el caso de que el
    // SO interrumpa el gesto (ej. una notificación) a medio trazo.
    canvas?.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      drawing = true;
      canvas.setPointerCapture(e.pointerId);
      ctx.beginPath();
      ctx.moveTo(...getPos(e));
    });
    canvas?.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      ctx.lineTo(...getPos(e));
      ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 2; ctx.lineCap = 'round';
      ctx.stroke();
    });
    canvas?.addEventListener('pointerup', () => { drawing = false; });
    canvas?.addEventListener('pointercancel', () => { drawing = false; });
    $('#btnLimpiarFirma')?.addEventListener('click', () => { ctx?.clearRect(0, 0, canvas.width, canvas.height); });

    $('#btnGuardarEpp')?.addEventListener('click', async () => {
      const item_id = $('#eppItemId').value;
      if (!item_id) { toast('Selecciona un artículo', 'danger'); return; }
      const firma_digital = canvas ? canvas.toDataURL('image/png') : null;
      const isBlank = !firma_digital || firma_digital === canvas?.toDataURL('image/png', 0);
      const btn = $('#btnGuardarEpp');
      btn.disabled = true; btn.textContent = 'Guardando…';
      try {
        await api(`/projects/${state.projectId}/trabajadores/${trabajadorId}/epp-entregas`, {
          method: 'POST',
          body: {
            item_id: Number(item_id),
            cantidad: Number($('#eppCantidad').value) || 1,
            fecha_entrega: $('#eppFecha').value || null,
            firma_digital: firma_digital || null,
          },
        });
        toast('Entrega de EPP registrada', 'success');
        ctx?.clearRect(0, 0, canvas.width, canvas.height);
        $('#eppItemId').value = ''; $('#eppCantidad').value = '1';
        await loadEpp();
      } catch (err) { toast(err.message, 'danger'); }
      btn.disabled = false; btn.textContent = 'Guardar entrega';
    });
  }
}

// ---------------------------------------------------------------------------
// EPP — catálogo configurable por obra (Admin)
// ---------------------------------------------------------------------------
async function openCatalogoEppModal() {
  openModal(`
    <div class="modal-header-row">
      <h3 class="modal-title">Catálogo EPP — esta obra</h3>
      <button class="icon-btn modal-close-btn" id="btnCerrarCatEpp">✕</button>
    </div>
    <div id="catEppListEl"><div class="empty-state">Cargando…</div></div>
    <div class="modal-section-divider">
      <p class="muted catalogo-epp-label">Agregar ítem al catálogo</p>
      <div class="trab-form-grid">
        <div class="field field-full"><label>Nombre del artículo *</label><input id="catEppNombre" placeholder="Ej. Casco de seguridad" /></div>
        <div class="field field-full"><label>Descripción (opcional)</label><input id="catEppDesc" placeholder="Norma, color, talla…" /></div>
      </div>
      <button class="btn btn-primary mt-8" id="btnAgregarCatEpp">Agregar</button>
    </div>
  `);
  $('#btnCerrarCatEpp').addEventListener('click', closeModal);

  async function loadCatalogo() {
    const items = await api(`/projects/${state.projectId}/epp-catalogo`);
    const el = $('#catEppListEl');
    if (!el) return;
    if (!items.length) { el.innerHTML = '<div class="empty-state">Sin ítems en el catálogo.</div>'; return; }
    el.innerHTML = items.map((it) => `
      <div class="list-row-between">
        <div>
          <span class="epp-item-nombre ${!it.activo ? 'epp-item-inactivo' : ''}">${esc(it.nombre_item)}</span>
          ${it.descripcion ? `<span class="muted fs-08"> — ${esc(it.descripcion)}</span>` : ''}
        </div>
        <button class="btn small ${it.activo ? 'btn-danger' : ''}" data-toggle-epp="${it.id}" data-epp-activo="${it.activo}" data-epp-nombre="${esc(it.nombre_item)}" data-epp-desc="${esc(it.descripcion||'')}">
          ${it.activo ? 'Desactivar' : 'Activar'}
        </button>
      </div>
    `).join('');
    $$('[data-toggle-epp]', el).forEach((btn) => {
      btn.addEventListener('click', async () => {
        const itId = Number(btn.dataset.toggleEpp);
        const nuevoActivo = btn.dataset.eppActivo !== 'true';
        try {
          await api(`/projects/${state.projectId}/epp-catalogo/${itId}`, {
            method: 'PUT',
            body: { nombre_item: btn.dataset.eppNombre, descripcion: btn.dataset.eppDesc || null, activo: nuevoActivo },
          });
          await loadCatalogo();
        } catch (err) { toast(err.message, 'danger'); }
      });
    });
  }
  await loadCatalogo();

  $('#btnAgregarCatEpp').addEventListener('click', async () => {
    const nombre_item = $('#catEppNombre').value.trim();
    if (!nombre_item) { toast('El nombre del artículo es requerido', 'danger'); return; }
    const btn = $('#btnAgregarCatEpp');
    btn.disabled = true;
    try {
      await api(`/projects/${state.projectId}/epp-catalogo`, {
        method: 'POST',
        body: { nombre_item, descripcion: $('#catEppDesc').value.trim() || null },
      });
      toast('Ítem agregado al catálogo', 'success');
      $('#catEppNombre').value = ''; $('#catEppDesc').value = '';
      await loadCatalogo();
    } catch (err) { toast(err.message, 'danger'); }
    btn.disabled = false;
  });
}

// Downloads a file through an authenticated endpoint and triggers browser save.
async function apiDownload(path, fallbackName) {
  const res = await fetch(`/api${path}`, {
    headers: state.token ? { Authorization: `Bearer ${state.token}` } : {},
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Error ${res.status}`);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="?([^";]+)"?/);
  const filename = match ? match[1] : fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------------------------------------------------------------------------
// Nóminas
// ---------------------------------------------------------------------------

const NOMINA_ESTADO_LABELS = {
  borrador: 'Borrador', revision: 'En revisión', aprobada: 'Aprobada', rechazada: 'Rechazada',
};
const NOMINA_ESTADO_BADGE = {
  borrador: 'muted', revision: 'yellow', aprobada: 'green', rechazada: 'red',
};

// Vista global — solo admin/desarrollador (ver GET /api/nominas en server/app.js):
// todas las nóminas de todas las obras y todos los residentes, de solo
// lectura. El detalle/edición de cada nómina se hace desde la pestaña
// Nóminas de la obra correspondiente (tab 'nominas', per-obra).
// Vista global de Nóminas — dos sub-vistas:
// 'todas'   -> jerarquía Cliente → Obra → Residente(s) → periodos de nómina
//              (solo lectura; capturar/calcular/aprobar sigue siendo por obra,
//              en la pestaña Nóminas normal — no se toca esa lógica).
// 'reporte' -> reporte de nómina semanal por cliente, filtrable por fecha,
//              con descarga Excel/PDF.
async function renderNominasGlobal(view) {
  let subView = 'todas';

  function renderSubNav() {
    return `
      <div class="nominas-subnav">
        <button class="btn ${subView === 'todas' ? 'btn-primary' : ''}" id="btnSubTodasNominas">Todas las nóminas</button>
        <button class="btn ${subView === 'reporte' ? 'btn-primary' : ''}" id="btnSubReporteSemanal">Reporte semanal por cliente</button>
      </div>
    `;
  }
  function bindSubNav() {
    $('#btnSubTodasNominas').addEventListener('click', showTodas);
    $('#btnSubReporteSemanal').addEventListener('click', showReporte);
  }

  async function showTodas() {
    subView = 'todas';
    view.innerHTML = `<h2 class="section-title">Nómina — todas las obras</h2>${renderSubNav()}<div id="nomGlobalBody" class="mt-12"><div class="spinner"></div></div>`;
    bindSubNav();
    const body = $('#nomGlobalBody');
    try {
      const nominas = await api('/nominas');
      if (!nominas.length) { body.innerHTML = '<div class="empty-state">No hay nóminas registradas en ninguna obra.</div>'; return; }

      // Agrupar Cliente -> Obra, preservando el orden ya dado por el backend
      // (cliente, obra, fecha_inicio DESC).
      const porCliente = new Map();
      nominas.forEach((n) => {
        const clienteKey = n.cliente_nombre || 'Sin cliente';
        if (!porCliente.has(clienteKey)) porCliente.set(clienteKey, new Map());
        const porObra = porCliente.get(clienteKey);
        if (!porObra.has(n.project_id)) porObra.set(n.project_id, { obra_nombre: n.obra_nombre, residentes_a_cargo: n.residentes_a_cargo, nominas: [] });
        porObra.get(n.project_id).nominas.push(n);
      });

      body.innerHTML = [...porCliente.entries()].map(([clienteNombre, porObra]) => `
        <h3 class="section-title mt14-mb8">${esc(clienteNombre)}</h3>
        ${[...porObra.entries()].map(([projectId, obra]) => `
          <div class="card mb-12">
            <div class="row between">
              <div>
                <strong>${esc(obra.obra_nombre)}</strong>
                <div class="muted fs-08">Residente(s) a cargo: ${esc(obra.residentes_a_cargo || '—')}</div>
              </div>
              <button class="btn small" data-ir-obra="${projectId}">Ver en la obra →</button>
            </div>
            <div class="table-scroll mt-8">
              <table>
                <thead><tr><th>Periodo</th><th>Estado</th><th class="num">Trabajadores</th><th class="num">Total</th></tr></thead>
                <tbody>
                  ${obra.nominas.map((n) => `
                  <tr>
                    <td>${esc(n.fecha_inicio)} al ${esc(n.fecha_fin)}</td>
                    <td><span class="badge ${NOMINA_ESTADO_BADGE[n.estado] || 'muted'}">${esc(NOMINA_ESTADO_LABELS[n.estado] || n.estado)}</span></td>
                    <td class="num">${n.num_trabajadores}</td>
                    <td class="num">${fmtMoney(n.total_nomina)}</td>
                  </tr>`).join('')}
                </tbody>
              </table>
            </div>
          </div>
        `).join('')}
      `).join('');

      $$('[data-ir-obra]', body).forEach((btn) => {
        btn.addEventListener('click', () => selectProject(Number(btn.dataset.irObra), 'nominas'));
      });
    } catch (err) {
      body.innerHTML = `<div class="alert-box danger">⚠️ ${esc(err.message)}</div>`;
    }
  }

  async function showReporte() {
    subView = 'reporte';
    // No usa cached(): esa caché vive en state.cache[state.projectId], que es
    // null en esta vista global (no depende de una obra seleccionada).
    const clientes = await api('/clientes');
    const hoy = new Date().toISOString().slice(0, 10);
    view.innerHTML = `
      <h2 class="section-title">Nómina — todas las obras</h2>
      ${renderSubNav()}
      <p class="muted mt-12">Total de nómina de las obras activas (fin de obra sin vencer) de un cliente, en la semana que contiene la fecha elegida.</p>
      <div class="row gap-8 mt-8">
        <div class="field flex-1">
          <label>Cliente</label>
          <select id="repNomCliente">
            <option value="">Selecciona un cliente…</option>
            ${clientes.map((c) => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('')}
          </select>
        </div>
        <div class="field flex-1"><label>Fecha (cualquier día de la semana)</label><input id="repNomFecha" type="date" value="${hoy}" /></div>
      </div>
      <div class="row mt-8">
        <button class="btn btn-primary" id="btnVerReporteNomina">Ver reporte</button>
      </div>
      <div id="reporteNomBody" class="mt-12"></div>
    `;
    bindSubNav();

    $('#btnVerReporteNomina').addEventListener('click', async () => {
      const clienteId = $('#repNomCliente').value;
      const fecha = $('#repNomFecha').value;
      if (!clienteId) { toast('Selecciona un cliente', 'danger'); return; }
      if (!fecha) { toast('Selecciona una fecha', 'danger'); return; }
      const body = $('#reporteNomBody');
      body.innerHTML = '<div class="spinner"></div>';
      try {
        const reporte = await api(`/clientes/${clienteId}/nominas-reporte-semanal?fecha=${fecha}`);
        pintarReporte(body, reporte, clienteId, fecha);
      } catch (err) {
        body.innerHTML = `<div class="alert-box danger">⚠️ ${esc(err.message)}</div>`;
      }
    });
  }

  function pintarReporte(body, reporte, clienteId, fecha) {
    if (!reporte.obras.length) {
      body.innerHTML = '<div class="empty-state">Este cliente no tiene obras activas (fin de obra vigente o sin definir).</div>';
      return;
    }
    const hayNominas = reporte.obras.some((o) => o.nominas.length > 0);
    body.innerHTML = `
      <div class="section-actions mb-12">
        <button class="btn" id="btnExportReporteXlsx">⭳ Exportar a Excel</button>
        <button class="btn" id="btnExportReportePdf">⭳ Exportar a PDF</button>
      </div>
      ${!hayNominas ? '<div class="empty-state">No hay nóminas registradas para esta semana en las obras activas de este cliente.</div>' : ''}
      ${reporte.obras.map((obra) => `
        <div class="card mb-12">
          <div class="row between">
            <div>
              <strong>${esc(obra.obra_nombre)}</strong>
              <div class="muted fs-08">Residente(s) a cargo: ${esc(obra.residentes_a_cargo || '—')}</div>
            </div>
            <span class="text-verde fw600">${fmtMoney(obra.total_obra)}</span>
          </div>
          ${!obra.nominas.length ? '<p class="muted mt-8">Sin nómina registrada para esta semana.</p>' : obra.nominas.map((nom) => `
            <div class="table-scroll mt-8">
              <p class="muted fs-08">Periodo: ${esc(nom.fecha_inicio)} al ${esc(nom.fecha_fin)} · <span class="badge ${NOMINA_ESTADO_BADGE[nom.estado] || 'muted'}">${esc(NOMINA_ESTADO_LABELS[nom.estado] || nom.estado)}</span></p>
              <table>
                <thead><tr><th>Trabajador</th><th>Puesto</th><th class="num">Días</th><th class="num">Jornal</th><th class="num">Destajo</th><th class="num">Total</th></tr></thead>
                <tbody>
                  ${nom.items.map((it) => `
                  <tr>
                    <td>${esc(it.trabajador_nombre)}</td>
                    <td>${esc(it.trabajador_puesto || '—')}</td>
                    <td class="num">${it.dias_trabajados ?? '—'}</td>
                    <td class="num">${fmtMoney(it.monto_jornal)}</td>
                    <td class="num">${fmtMoney(it.monto_destajo)}</td>
                    <td class="num">${fmtMoney(it.monto_total)}</td>
                  </tr>`).join('')}
                </tbody>
              </table>
            </div>
          `).join('')}
        </div>
      `).join('')}
      <div class="card">
        <div class="card-row"><span class="k">Total del cliente</span><span class="v text-verde fw600">${fmtMoney(reporte.total_cliente)}</span></div>
      </div>
    `;
    wireExportButton('#btnExportReporteXlsx', `/clientes/${clienteId}/nominas-reporte-semanal/export?fecha=${fecha}`);
    wireExportButton('#btnExportReportePdf', `/clientes/${clienteId}/nominas-reporte-semanal/export-pdf?fecha=${fecha}`);
  }

  await showTodas();
}

async function renderNominas(view) {
  if (!puedeVerNominas()) {
    view.innerHTML = `<div class="alert-box danger">⚠️ No tienes permiso para ver esta sección.</div>`;
    return;
  }

  // Sub-view: 'asistencia' | 'nominas'
  let subView = 'asistencia';

  function renderSubNav() {
    return `
      <div class="nominas-subnav">
        <button class="btn ${subView === 'asistencia' ? 'btn-primary' : ''}" id="btnSubAsistencia">Asistencia diaria</button>
        <button class="btn ${subView === 'nominas' ? 'btn-primary' : ''}" id="btnSubNominas">Nóminas</button>
      </div>
    `;
  }

  // Calendario visual de asistencia: vista general (todos los trabajadores ×
  // días del mes) y vista de detalle por trabajador (heatmap tipo habit
  // tracker + resumen). Un solo fetch por mes (asistencia-rango), clic en una
  // celda cicla el estado con actualización optimista + guardado real.
  // 'sin_registro' cierra el ciclo (ver toggleCelda) — se ve idéntico a una
  // celda nunca marcada (mismo cls 'vacio'), pero es un valor guardado en
  // vez de una fila ausente. Al último del array a propósito: con
  // ASIST_ESTADOS.indexOf(actual) + 1 % length, después de
  // falta_injustificada el ciclo cae aquí, y desde aquí vuelve a 'presente'.
  const ASIST_ESTADOS = ['presente', 'falta_justificada', 'falta_injustificada', 'sin_registro'];
  const ASIST_META = {
    presente:            { label: 'Presente',        cls: 'presente' },
    falta_justificada:   { label: 'Falta justificada', cls: 'falta-just' },
    falta_injustificada: { label: 'Falta injustificada', cls: 'falta-injust' },
    sin_registro:        { label: 'Sin registro',     cls: 'vacio' },
  };
  const ASIST_DIAS_CORTO = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];
  const asistDiasEnMes = (y, m) => new Date(y, m + 1, 0).getDate();
  const asistFechaStr = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const asistLeyendaHtml = () => `
    <div class="asist-leyenda">
      <span class="asist-leyenda-item"><span class="asist-dot presente"></span>Presente</span>
      <span class="asist-leyenda-item"><span class="asist-dot falta-just"></span>Falta justif.</span>
      <span class="asist-leyenda-item"><span class="asist-dot falta-injust"></span>Falta injust.</span>
      <span class="asist-leyenda-item"><span class="asist-dot vacio"></span>Sin registro</span>
    </div>`;

  async function showAsistencia() {
    subView = 'asistencia';
    const hoy = new Date();
    const asist = { year: hoy.getFullYear(), month: hoy.getMonth(), trabajadorId: null, trabajadores: [], mapa: {} };

    function mesLabel() {
      const m = MESES_ES[asist.month];
      return `${m.charAt(0).toUpperCase()}${m.slice(1)} ${asist.year}`;
    }

    async function cargarMes() {
      const desde = asistFechaStr(asist.year, asist.month, 1);
      const hasta = asistFechaStr(asist.year, asist.month, asistDiasEnMes(asist.year, asist.month));
      const data = await api(`/projects/${state.projectId}/asistencia-rango?desde=${desde}&hasta=${hasta}`);
      asist.trabajadores = data.trabajadores || [];
      asist.mapa = {};
      (data.asistencias || []).forEach((a) => { asist.mapa[`${a.trabajador_id}_${a.fecha}`] = a.estado; });
    }

    async function cambiarMes(delta) {
      asist.month += delta;
      if (asist.month < 0) { asist.month = 11; asist.year--; }
      if (asist.month > 11) { asist.month = 0; asist.year++; }
      await refrescar();
    }

    async function refrescar() {
      const panel = $('#asistenciaPanel');
      if (!panel) return;
      panel.innerHTML = '<div class="empty-state">Cargando…</div>';
      try {
        await cargarMes();
        renderPanel();
      } catch (err) {
        panel.innerHTML = `<div class="alert-box danger">⚠️ ${esc(err.message)}</div>`;
      }
    }

    function renderPanel() {
      const panel = $('#asistenciaPanel');
      if (!panel) return;
      if (!asist.trabajadores.length) {
        panel.innerHTML = '<div class="empty-state">No hay trabajadores activos en esta obra.</div>';
        return;
      }
      if (asist.trabajadorId) renderDetalle(panel); else renderGeneral(panel);
    }

    function renderGeneral(panel) {
      const totalDias = asistDiasEnMes(asist.year, asist.month);
      const dias = Array.from({ length: totalDias }, (_, i) => i + 1);
      const canEdit = puedeCapturarAsistencia();
      const hoy = new Date();
      const esMesActual = asist.year === hoy.getFullYear() && asist.month === hoy.getMonth();
      const diaHoy = esMesActual ? hoy.getDate() : null;
      panel.innerHTML = `
        <div class="asist-mes-nav">
          <button class="icon-btn" id="btnAsistMesPrev" aria-label="Mes anterior">‹</button>
          <strong>${mesLabel()}</strong>
          <button class="icon-btn" id="btnAsistMesNext" aria-label="Mes siguiente">›</button>
        </div>
        <div class="asist-grid-wrap">
          <div class="asist-fixed-col">
            <div class="asist-fixed-th">Trabajador</div>
            ${asist.trabajadores.map((t) => `
              <div class="asist-fixed-row" data-tid="${t.id}">
                <span class="asist-fixed-row-name">${esc(t.nombre)}</span>
                <span class="asist-fixed-row-chevron">${icon('chevron-right', 15)}</span>
              </div>
            `).join('')}
          </div>
          <div class="asist-grid-scroll">
            <table class="asist-grid-table">
              <thead>
                <tr>
                  ${dias.map((d) => `<th class="asist-th-dia${d === diaHoy ? ' hoy' : ''}">${d}</th>`).join('')}
                </tr>
              </thead>
              <tbody>
                ${asist.trabajadores.map((t) => `
                  <tr>
                    ${dias.map((d) => {
                      const fecha = asistFechaStr(asist.year, asist.month, d);
                      const estado = asist.mapa[`${t.id}_${fecha}`] || null;
                      const cls = estado ? ASIST_META[estado].cls : 'vacio';
                      return `<td class="asist-cell ${cls}" data-tid="${t.id}" data-fecha="${fecha}" title="${esc(t.nombre)} — ${fecha}${estado ? ': ' + ASIST_META[estado].label : ''}"></td>`;
                    }).join('')}
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
        ${asistLeyendaHtml()}
        ${canEdit ? '<p class="muted fs-08 mt-6">Toca una celda para marcar/cambiar el estado. Toca un nombre para ver el detalle.</p>' : ''}
      `;
      $('#btnAsistMesPrev').addEventListener('click', () => cambiarMes(-1));
      $('#btnAsistMesNext').addEventListener('click', () => cambiarMes(1));
      $$('.asist-fixed-row', panel).forEach((row) => {
        row.addEventListener('click', () => { asist.trabajadorId = Number(row.dataset.tid); renderPanel(); });
      });
      if (canEdit) {
        $$('.asist-cell', panel).forEach((cell) => cell.addEventListener('click', () => toggleCelda(cell, Number(cell.dataset.tid), cell.dataset.fecha, null)));
      }
    }

    async function toggleCelda(cell, tid, fecha, onDone) {
      const key = `${tid}_${fecha}`;
      const actual = asist.mapa[key] || null;
      const idx = actual ? ASIST_ESTADOS.indexOf(actual) : -1;
      const nuevo = ASIST_ESTADOS[(idx + 1) % ASIST_ESTADOS.length];
      const prevCls = actual ? ASIST_META[actual].cls : 'vacio';
      // Optimistic update — cambia el color de inmediato, sin esperar al backend
      cell.classList.remove('presente', 'falta-just', 'falta-injust', 'vacio');
      cell.classList.add(ASIST_META[nuevo].cls);
      asist.mapa[key] = nuevo;
      try {
        await api(`/projects/${state.projectId}/asistencia`, {
          method: 'PUT',
          body: { fecha, asistencia: [{ trabajador_id: tid, estado: nuevo }] },
        });
        if (onDone) onDone();
      } catch (err) {
        // Revertir si el guardado real falla
        cell.classList.remove(ASIST_META[nuevo].cls);
        cell.classList.add(prevCls);
        if (actual) asist.mapa[key] = actual; else delete asist.mapa[key];
        toast(err.message, 'danger');
      }
    }

    function renderDetalle(panel) {
      const t = asist.trabajadores.find((x) => x.id === asist.trabajadorId);
      if (!t) { asist.trabajadorId = null; renderGeneral(panel); return; }
      const totalDias = asistDiasEnMes(asist.year, asist.month);
      const primerDiaSemana = new Date(asist.year, asist.month, 1).getDay();
      const hoyCorte = new Date(); hoyCorte.setHours(0, 0, 0, 0);

      let presentes = 0, conRegistro = 0;
      const celdas = [];
      for (let i = 0; i < primerDiaSemana; i++) celdas.push(null);
      for (let d = 1; d <= totalDias; d++) {
        const fecha = asistFechaStr(asist.year, asist.month, d);
        const estado = asist.mapa[`${t.id}_${fecha}`] || null;
        // 'sin_registro' es una fila real (para el ciclo de toggleCelda) pero
        // debe contar como si no hubiera fila — mismo criterio que el cálculo
        // de nómina en el backend.
        if (estado && estado !== 'sin_registro') { conRegistro++; if (estado === 'presente') presentes++; }
        celdas.push({ d, fecha, estado });
      }
      const pct = conRegistro ? Math.round((presentes / conRegistro) * 100) : 0;

      // Racha actual: días 'presente' consecutivos hacia atrás desde hoy
      // (o el último día del mes mostrado, si es un mes pasado). Se corta en
      // el primer día sin registro o con falta — acotada al mes visible.
      let racha = 0;
      for (let d = totalDias; d >= 1; d--) {
        if (new Date(asist.year, asist.month, d) > hoyCorte) continue;
        const estado = asist.mapa[`${t.id}_${asistFechaStr(asist.year, asist.month, d)}`] || null;
        if (estado === 'presente') racha++; else break;
      }

      const canEdit = puedeCapturarAsistencia();
      panel.innerHTML = `
        <button class="btn small" id="btnAsistVolver">‹ Volver a la obra</button>
        <div class="asist-detalle-card mt-8">
          <h3 class="asist-detalle-nombre">${esc(t.nombre)}</h3>
          <p class="muted fs-08">${esc(t.puesto || '—')}</p>
          <div class="asist-resumen-grid">
            <div class="asist-resumen-item"><div class="asist-resumen-value">${presentes}/${conRegistro}</div><div class="asist-resumen-label">Días asistidos</div></div>
            <div class="asist-resumen-item"><div class="asist-resumen-value">${pct}%</div><div class="asist-resumen-label">Asistencia</div></div>
            <div class="asist-resumen-item"><div class="asist-resumen-value">${racha}</div><div class="asist-resumen-label">Racha actual</div></div>
          </div>
        </div>
        <div class="asist-mes-nav mt-8">
          <button class="icon-btn" id="btnAsistMesPrev" aria-label="Mes anterior">‹</button>
          <strong>${mesLabel()}</strong>
          <button class="icon-btn" id="btnAsistMesNext" aria-label="Mes siguiente">›</button>
        </div>
        <div class="asist-heatmap">
          <div class="asist-heatmap-dow">${ASIST_DIAS_CORTO.map((d) => `<span>${d}</span>`).join('')}</div>
          <div class="asist-heatmap-grid">
            ${celdas.map((c) => {
              if (!c) return '<span class="asist-heat-cell vacio-slot"></span>';
              const cls = c.estado ? ASIST_META[c.estado].cls : 'vacio';
              return `<span class="asist-heat-cell ${cls}" data-fecha="${c.fecha}" title="${c.fecha}${c.estado ? ': ' + ASIST_META[c.estado].label : ''}">${c.d}</span>`;
            }).join('')}
          </div>
        </div>
        ${asistLeyendaHtml()}
      `;
      $('#btnAsistVolver').addEventListener('click', () => { asist.trabajadorId = null; renderPanel(); });
      $('#btnAsistMesPrev').addEventListener('click', () => cambiarMes(-1));
      $('#btnAsistMesNext').addEventListener('click', () => cambiarMes(1));
      if (canEdit) {
        $$('.asist-heat-cell:not(.vacio-slot)', panel).forEach((cell) => {
          cell.addEventListener('click', () => toggleCelda(cell, t.id, cell.dataset.fecha, () => renderDetalle(panel)));
        });
      }
    }

    view.innerHTML = `
      <h2 class="section-title">Personal</h2>
      ${renderSubNav()}
      <div id="asistenciaPanel" class="mt-12"></div>
    `;
    bindSubNav();
    await refrescar();
  }

  async function showNominas() {
    subView = 'nominas';
    view.innerHTML = `
      <h2 class="section-title">Personal ${renderHelpBtn('nominaCaptura')}</h2>
      ${renderSubNav()}
      <div class="section-actions mt-12">
        ${puedeCapturarAsistencia() ? `<button class="btn btn-primary" id="btnNuevaNomina">+ Nueva nómina</button>` : ''}
      </div>
      <div id="nominasList"><div class="empty-state">Cargando…</div></div>
    `;
    bindSubNav();
    $('#btnNuevaNomina')?.addEventListener('click', () => openNominaModal(null, showNominas));
    await loadNominas();
  }

  async function loadNominas() {
    const el = $('#nominasList');
    if (!el) return;
    try {
      const nominas = await api(`/projects/${state.projectId}/nominas`);
      if (!nominas.length) { el.innerHTML = '<div class="empty-state">No hay nóminas registradas.</div>'; return; }
      el.innerHTML = nominas.map((n) => `
        <div class="card">
          <div class="row between nomina-row-6">
            <div>
              <strong>${esc(n.fecha_inicio)} al ${esc(n.fecha_fin)}</strong>
              <div class="muted fs-08">${n.num_trabajadores} trabajadores · $${Number(n.total_nomina || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 })}</div>
            </div>
            <div class="row nomina-row-6-center">
              <span class="badge ${NOMINA_ESTADO_BADGE[n.estado] || 'muted'}">${esc(NOMINA_ESTADO_LABELS[n.estado] || n.estado)}</span>
            </div>
          </div>
          ${n.nota_rechazo ? `<div class="muted fs-08 nomina-nota">Nota: ${esc(n.nota_rechazo)}</div>` : ''}
          <div class="row end nomina-actions-row">
            <button class="btn small" data-ver-nomina="${n.id}">Ver detalle</button>
            ${n.estado === 'borrador' && puedeCapturarAsistencia() ? `<button class="btn small btn-primary" data-calcular-nomina="${n.id}">Calcular</button>` : ''}
            ${n.estado === 'borrador' && puedeCapturarAsistencia() ? `<button class="btn small" data-enviar-nomina="${n.id}">Enviar a revisión</button>` : ''}
            ${n.estado === 'revision' && puedeAprobarNomina() ? `
              <button class="btn small btn-primary" data-aprobar-nomina="${n.id}">Aprobar</button>
              <button class="btn small btn-danger" data-rechazar-nomina="${n.id}">Rechazar</button>` : ''}
            ${n.estado === 'aprobada' && puedeAprobarNomina() ? `<button class="btn small" data-reabrir-nomina="${n.id}">Reabrir</button>` : ''}
            ${n.estado === 'aprobada' ? `<button class="btn small btn-primary" data-exportar-nomina="${n.id}" data-exportar-nombre="Nomina_${n.id}">Exportar Excel</button>` : ''}
          </div>
        </div>
      `).join('');

      $$('[data-ver-nomina]', el).forEach((btn) => {
        btn.addEventListener('click', () => openVerNominaModal(Number(btn.dataset.verNomina)));
      });
      $$('[data-calcular-nomina]', el).forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            const result = await api(`/projects/${state.projectId}/nominas/${btn.dataset.calcularNomina}/calcular`, { method: 'POST' });
            const items = result?.items || [];
            const sinAsistencia = items.every((i) => (i.dias_trabajados || 0) === 0);
            const sinTarifa = items.some((i) => (i.dias_trabajados || 0) > 0 && (i.monto_jornal || 0) === 0 && (i.monto_destajo || 0) === 0);
            if (sinAsistencia && items.length > 0) {
              toast('Nómina calculada — sin registros de asistencia en el periodo. Guarda asistencia antes de calcular.', 'warning');
            } else if (sinTarifa) {
              toast('Nómina calculada — algunos trabajadores tienen tarifa $0/día. Revisa el detalle.', 'warning');
            } else {
              toast('Nómina calculada', 'success');
            }
            await loadNominas();
          } catch (err) { toast(err.message, 'danger'); btn.disabled = false; }
        });
      });
      $$('[data-enviar-nomina]', el).forEach((btn) => {
        btn.addEventListener('click', () => openCambioEstadoModal(Number(btn.dataset.enviarNomina), 'revision', null, loadNominas));
      });
      $$('[data-aprobar-nomina]', el).forEach((btn) => {
        btn.addEventListener('click', () => openCambioEstadoModal(Number(btn.dataset.aprobarNomina), 'aprobada', null, loadNominas));
      });
      $$('[data-rechazar-nomina]', el).forEach((btn) => {
        btn.addEventListener('click', () => openCambioEstadoModal(Number(btn.dataset.rechazarNomina), 'rechazada', true, loadNominas));
      });
      $$('[data-reabrir-nomina]', el).forEach((btn) => {
        btn.addEventListener('click', () => openCambioEstadoModal(Number(btn.dataset.reabrirNomina), 'borrador', null, loadNominas));
      });
      $$('[data-exportar-nomina]', el).forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await apiDownload(`/projects/${state.projectId}/nominas/${btn.dataset.exportarNomina}/export`, `${btn.dataset.exportarNombre}.xlsx`);
          } catch (err) { toast(err.message, 'danger'); }
          btn.disabled = false;
        });
      });
    } catch (err) {
      el.innerHTML = `<div class="alert-box danger">⚠️ ${esc(err.message)}</div>`;
    }
  }

  function bindSubNav() {
    $('#btnSubAsistencia')?.addEventListener('click', showAsistencia);
    $('#btnSubNominas')?.addEventListener('click', showNominas);
  }

  await showAsistencia();
}

async function openNominaModal(nomina, onSave) {
  openModal(`
    <h3>Nueva nómina</h3>
    <div class="trab-form-grid">
      <div class="field"><label>Fecha inicio *</label><input id="nFechaInicio" type="date" /></div>
      <div class="field"><label>Fecha fin *</label><input id="nFechaFin" type="date" /></div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelNomina">Cancelar</button>
      <button class="btn btn-primary" id="btnSaveNomina">Crear nómina</button>
    </div>
  `);
  $('#btnCancelNomina').addEventListener('click', closeModal);
  $('#btnSaveNomina').addEventListener('click', async () => {
    const fecha_inicio = $('#nFechaInicio').value;
    const fecha_fin = $('#nFechaFin').value;
    if (!fecha_inicio || !fecha_fin) { toast('Las fechas de inicio y fin son obligatorias', 'danger'); return; }
    if (fecha_fin < fecha_inicio) { toast('La fecha fin debe ser igual o posterior a inicio', 'danger'); return; }
    const btn = $('#btnSaveNomina');
    btn.disabled = true;
    try {
      await api(`/projects/${state.projectId}/nominas`, {
        method: 'POST',
        body: { fecha_inicio, fecha_fin },
      });
      toast('Nómina creada', 'success');
      closeModal();
      if (onSave) await onSave();
    } catch (err) { toast(err.message, 'danger'); btn.disabled = false; }
  });
}

async function openVerNominaModal(nominaId) {
  openModal(`<h3>Detalle de nómina</h3><div id="verNominaBody"><div class="empty-state">Cargando…</div></div><div class="modal-actions"><button class="btn" id="btnCerrarVerNomina">Cerrar</button></div>`);
  $('#btnCerrarVerNomina').addEventListener('click', closeModal);
  try {
    // GET /nominas/:nomId returns { ...nom, items: [...] }
    const data = await api(`/projects/${state.projectId}/nominas/${nominaId}`);
    const items = data.items || [];
    const el = $('#verNominaBody');
    if (!el) return;
    if (!items.length) { el.innerHTML = '<div class="empty-state">Sin líneas calculadas. Usa el botón Calcular primero.</div>'; return; }
    const total = items.reduce((s, i) => s + Number(i.monto_total || 0), 0);
    const hasDest = items.some((i) => (i.monto_destajo || 0) > 0 || i.tipo_pago === 'destajo' || i.tipo_pago === 'mixto');
    const sinAsistencia = items.every((i) => (i.dias_trabajados || 0) === 0);
    const sinTarifa = items.some((i) => (i.dias_trabajados || 0) > 0 && (i.monto_jornal || 0) === 0 && (i.tipo_pago === 'jornal' || i.tipo_pago === 'mixto'));
    el.innerHTML = `
      <div class="muted nomina-detalle-fecha">${esc(data.fecha_inicio)} al ${esc(data.fecha_fin)}</div>
      ${sinAsistencia ? `<div class="alert-box nomina-detalle-alert">⚠️ Todos los trabajadores tienen 0 días — guarda la asistencia del periodo antes de calcular.</div>` : ''}
      ${sinTarifa ? `<div class="alert-box nomina-detalle-alert">⚠️ Algún trabajador tiene tarifa $0/día. Edita el trabajador y asigna una tarifa jornal.</div>` : ''}
      <div class="nomina-table-wrap">
      <table class="nomina-table">
        <thead><tr>
          <th class="nomina-th-left">Trabajador</th>
          <th class="nomina-th-right">Días</th>
          <th class="nomina-th-right">Tarifa/día</th>
          <th class="nomina-th-right">Jornal</th>
          ${hasDest ? `<th class="nomina-th-right">Destajo</th>` : ''}
          <th class="nomina-th-right">Total</th>
        </tr></thead>
        <tbody>
          ${items.map((i) => {
            const tarifaJornal = Number(i.tarifa_jornal || 0);
            const montoJornal = Number(i.monto_jornal || 0);
            const montoDest = Number(i.monto_destajo || 0);
            const montoTot = Number(i.monto_total || 0);
            const warnRow = (i.dias_trabajados || 0) > 0 && montoTot === 0;
            return `<tr class="${warnRow ? 'nomina-warn-row' : ''}">
              <td class="nomina-td">${esc(i.trabajador_nombre || i.nombre_trabajador || '—')}</td>
              <td class="nomina-td-right">${i.dias_trabajados ?? 0}</td>
              <td class="nomina-td-right">${tarifaJornal > 0 ? '$' + tarifaJornal.toLocaleString('es-MX', { minimumFractionDigits: 2 }) : '<span class="muted">—</span>'}</td>
              <td class="nomina-td-right">$${montoJornal.toLocaleString('es-MX', { minimumFractionDigits: 2 })}</td>
              ${hasDest ? `<td class="nomina-td-right">$${montoDest.toLocaleString('es-MX', { minimumFractionDigits: 2 })}</td>` : ''}
              <td class="nomina-td-total">$${montoTot.toLocaleString('es-MX', { minimumFractionDigits: 2 })}</td>
            </tr>`;
          }).join('')}
        </tbody>
        <tfoot><tr>
          <td colspan="${hasDest ? 5 : 4}" class="nomina-tfoot-label">Total nómina</td>
          <td class="nomina-tfoot-total">$${total.toLocaleString('es-MX', { minimumFractionDigits: 2 })}</td>
        </tr></tfoot>
      </table>
      </div>
    `;
  } catch (err) {
    const el = $('#verNominaBody');
    if (el) el.innerHTML = `<div class="alert-box danger">⚠️ ${esc(err.message)}</div>`;
  }
}

async function openCambioEstadoModal(nominaId, nuevoEstado, pedirNota, onDone) {
  const accionLabel = { revision: 'Enviar a revisión', aprobada: 'Aprobar nómina', rechazada: 'Rechazar nómina', borrador: 'Reabrir nómina' }[nuevoEstado];
  openModal(`
    <h3>${accionLabel}</h3>
    ${pedirNota ? `<div class="field"><label>Nota para el residente (opcional)</label><textarea id="estadoNota" rows="3"></textarea></div>` : ''}
    <p class="muted fs-088">¿Confirmas el cambio de estado?</p>
    <div class="modal-actions">
      <button class="btn" id="btnCancelEstado">Cancelar</button>
      <button class="btn btn-primary" id="btnConfirmEstado">Confirmar</button>
    </div>
  `);
  $('#btnCancelEstado').addEventListener('click', closeModal);
  $('#btnConfirmEstado').addEventListener('click', async () => {
    const btn = $('#btnConfirmEstado');
    btn.disabled = true;
    const nota = pedirNota ? ($('#estadoNota')?.value.trim() || null) : null;
    try {
      await api(`/projects/${state.projectId}/nominas/${nominaId}/estado`, {
        method: 'PUT',
        body: { estado: nuevoEstado, nota },
      });
      toast('Estado actualizado', 'success');
      closeModal();
      if (onDone) await onDone();
    } catch (err) { toast(err.message, 'danger'); btn.disabled = false; }
  });
}

// ---------------------------------------------------------------------------
// Estimaciones (corte de avance periódico → aprobación → PDF firmado)
// ---------------------------------------------------------------------------
const ESTIMACION_ESTADO_LABELS = {
  borrador: 'Borrador', enviada: 'Enviada', aprobada: 'Aprobada', rechazada: 'Rechazada',
};
const ESTIMACION_ESTADO_BADGE = {
  borrador: 'muted', enviada: 'yellow', aprobada: 'green', rechazada: 'red',
};

// Preferencia de UI (por dispositivo, no por obra): mostrar el folio "#N" en
// gris tenue junto al nombre de una estimación renombrada. Default visible
// (true) para no ocultar información de golpe a quien ya usaba el folio para
// identificar la estimación — el usuario la apaga si le estorba.
const MOSTRAR_FOLIO_ESTIMACION_KEY = 'cp_mostrar_folio_estimacion';
function getMostrarFolioEstimacion() {
  const v = localStorage.getItem(MOSTRAR_FOLIO_ESTIMACION_KEY);
  return v === null ? true : v === '1';
}
function setMostrarFolioEstimacion(v) {
  localStorage.setItem(MOSTRAR_FOLIO_ESTIMACION_KEY, v ? '1' : '0');
}

// Búsqueda/orden/filtro (Fase 2, prompt-fix-nombre-emojis-filtros-estimaciones.md)
// — 100% en frontend sobre los datos ya cargados: /estimaciones no pagina y
// el volumen por obra es bajo (folio consecutivo, decenas como mucho), así
// que no se justifica un endpoint nuevo. estimacionesRaw guarda el último
// fetch; cambiar filtro/orden solo repinta, nunca vuelve a pedir al server.
let estimacionesRaw = [];
let estimacionesFilter = { q: '', estados: new Set(), orden: 'fecha_desc' };
const ESTIMACION_ORDEN_OPCIONES = [
  { value: 'fecha_desc', label: 'Fecha de creación (más reciente primero)' },
  { value: 'fecha_asc', label: 'Fecha de creación (más antigua primero)' },
  { value: 'nombre_asc', label: 'Nombre (A-Z)' },
  { value: 'nombre_desc', label: 'Nombre (Z-A)' },
  { value: 'monto_desc', label: 'Monto (mayor a menor)' },
  { value: 'monto_asc', label: 'Monto (menor a mayor)' },
];

async function renderEstimaciones(view) {
  if (!puedeVerEstimaciones()) {
    view.innerHTML = `<div class="alert-box danger">⚠️ No tienes permiso para ver esta sección.</div>`;
    return;
  }
  estimacionesFilter = { q: '', estados: new Set(), orden: 'fecha_desc' };
  view.innerHTML = `
    <h2 class="section-title">Estimaciones</h2>
    <div class="section-actions mt-12">
      ${puedeCapturarEstimacion() ? `<button class="btn btn-primary" id="btnNuevaEstimacion">+ Nueva estimación</button>` : ''}
      <div class="row">
        <label class="perm-check">
          <input type="checkbox" id="chkMostrarFolioEstimacion" ${getMostrarFolioEstimacion() ? 'checked' : ''} />
          <span class="perm-check-track"><span class="perm-check-thumb"></span></span>
        </label>
        <span class="muted fs-08">Mostrar folio (#N) junto al nombre</span>
      </div>
    </div>
    <div class="sticky-filters">
      <div class="search-bar">
        <input type="search" id="estimacionSearch" placeholder="Buscar por nombre o folio…" />
      </div>
      <div class="chip-row" id="estimacionEstadoChips">
        ${Object.entries(ESTIMACION_ESTADO_LABELS).map(([key, label]) => `<button class="chip" data-estado-filter="${key}">${esc(label)}</button>`).join('')}
      </div>
      <div class="field mt-8">
        <label class="fs-08 muted">Ordenar por</label>
        <select id="estimacionOrden">
          ${ESTIMACION_ORDEN_OPCIONES.map((o) => `<option value="${o.value}">${esc(o.label)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div id="estimacionesList"><div class="empty-state">Cargando…</div></div>
  `;
  $('#btnNuevaEstimacion')?.addEventListener('click', () => openEstimacionModal(loadEstimaciones));
  $('#chkMostrarFolioEstimacion').addEventListener('change', (e) => {
    setMostrarFolioEstimacion(e.target.checked);
    paintEstimacionesList();
  });
  $('#estimacionSearch').addEventListener('input', debounce((e) => {
    estimacionesFilter.q = e.target.value.trim().toLowerCase();
    paintEstimacionesList();
  }, 220));
  $$('#estimacionEstadoChips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const estado = chip.dataset.estadoFilter;
      if (estimacionesFilter.estados.has(estado)) estimacionesFilter.estados.delete(estado);
      else estimacionesFilter.estados.add(estado);
      chip.classList.toggle('active');
      paintEstimacionesList();
    });
  });
  $('#estimacionOrden').addEventListener('change', (e) => {
    estimacionesFilter.orden = e.target.value;
    paintEstimacionesList();
  });
  await loadEstimaciones();
}

async function loadEstimaciones() {
  const el = $('#estimacionesList');
  if (!el) return;
  try {
    estimacionesRaw = await api(`/projects/${state.projectId}/estimaciones`);
    paintEstimacionesList();
  } catch (err) {
    el.innerHTML = `<div class="alert-box danger">⚠️ ${esc(err.message)}</div>`;
  }
}

// Nombre "efectivo" para búsqueda/orden alfabético: el real si existe, si no
// el mismo fallback que ya se muestra en la tarjeta ("Estimación #N") — así
// buscar/ordenar por nombre también encuentra/ordena las que no tienen uno.
function nombreEfectivoEstimacion(e) { return e.nombre || `Estimación #${e.folio}`; }

function paintEstimacionesList() {
  const el = $('#estimacionesList');
  if (!el) return;
  if (!estimacionesRaw.length) { el.innerHTML = '<div class="empty-state">No hay estimaciones registradas.</div>'; return; }

  let estimaciones = estimacionesRaw;
  if (estimacionesFilter.q) {
    const q = estimacionesFilter.q;
    estimaciones = estimaciones.filter((e) =>
      nombreEfectivoEstimacion(e).toLowerCase().includes(q) || String(e.folio).includes(q)
    );
  }
  if (estimacionesFilter.estados.size) {
    estimaciones = estimaciones.filter((e) => estimacionesFilter.estados.has(e.estado));
  }
  const collator = new Intl.Collator('es', { sensitivity: 'base' });
  estimaciones = estimaciones.slice().sort((a, b) => {
    switch (estimacionesFilter.orden) {
      case 'fecha_asc': return new Date(a.fecha_captura) - new Date(b.fecha_captura);
      case 'nombre_asc': return collator.compare(nombreEfectivoEstimacion(a), nombreEfectivoEstimacion(b));
      case 'nombre_desc': return collator.compare(nombreEfectivoEstimacion(b), nombreEfectivoEstimacion(a));
      case 'monto_asc': return (a.total_periodo || 0) - (b.total_periodo || 0);
      case 'monto_desc': return (b.total_periodo || 0) - (a.total_periodo || 0);
      case 'fecha_desc':
      default: return new Date(b.fecha_captura) - new Date(a.fecha_captura);
    }
  });

  if (!estimaciones.length) { el.innerHTML = '<div class="empty-state">No se encontraron estimaciones con esos filtros.</div>'; return; }

  const mostrarFolio = getMostrarFolioEstimacion();
  el.innerHTML = estimaciones.map((e) => `
      <div class="card">
        <div class="row between nomina-row-6">
          <div>
            <strong>${e.nombre ? esc(e.nombre) + (mostrarFolio ? ` <span class="estimacion-folio-tenue">#${e.folio}</span>` : '') : 'Estimación #' + e.folio}</strong>
            <button class="icon-btn-inline" data-renombrar-estimacion="${e.id}" data-nombre-actual="${esc(e.nombre || '')}" title="Renombrar" aria-label="Renombrar">✎</button>
            <div class="muted fs-08">${esc(e.periodo_inicio)} al ${esc(e.periodo_fin)} · $${Number(e.total_periodo || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 })}</div>
          </div>
          <div class="row nomina-row-6-center">
            <span class="badge ${ESTIMACION_ESTADO_BADGE[e.estado] || 'muted'}">${esc(ESTIMACION_ESTADO_LABELS[e.estado] || e.estado)}</span>
          </div>
        </div>
        ${e.comentario_rechazo ? `<div class="muted fs-08 nomina-nota">Motivo de rechazo: ${esc(e.comentario_rechazo)}</div>` : ''}
        <div class="row end nomina-actions-row">
          <button class="btn small" data-ver-estimacion="${e.id}">Ver detalle</button>
          ${(e.estado === 'borrador' || e.estado === 'rechazada') && puedeCapturarEstimacion() ? `<button class="btn small btn-primary" data-calcular-estimacion="${e.id}">Calcular</button>` : ''}
          ${(e.estado === 'borrador' || e.estado === 'rechazada') && puedeCapturarEstimacion() ? `<button class="btn small" data-enviar-estimacion="${e.id}">Enviar a aprobación</button>` : ''}
          ${e.estado === 'enviada' && puedeAprobarEstimacion() ? `
            <button class="btn small btn-primary" data-aprobar-estimacion="${e.id}">Aprobar</button>
            <button class="btn small btn-danger" data-rechazar-estimacion="${e.id}">Rechazar</button>` : ''}
          ${e.estado === 'borrador' && puedeCapturarEstimacion() ? `<button class="btn small btn-danger" data-eliminar-estimacion="${e.id}">Eliminar</button>` : ''}
          ${e.estado === 'aprobada' && e.pdf_url ? `<button class="btn small btn-primary" data-descargar-estimacion="${e.id}" data-folio="${e.folio}">Descargar PDF</button>` : ''}
        </div>
      </div>
    `).join('');

  $$('[data-ver-estimacion]', el).forEach((btn) => {
    btn.addEventListener('click', () => openVerEstimacionModal(Number(btn.dataset.verEstimacion)));
  });
  $$('[data-renombrar-estimacion]', el).forEach((btn) => {
    btn.addEventListener('click', () => openRenombrarEstimacionModal(Number(btn.dataset.renombrarEstimacion), btn.dataset.nombreActual, loadEstimaciones));
  });
  $$('[data-calcular-estimacion]', el).forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api(`/projects/${state.projectId}/estimaciones/${btn.dataset.calcularEstimacion}/calcular`, { method: 'POST' });
        toast('Estimación calculada — se jaló el avance registrado en el periodo', 'success');
        await loadEstimaciones();
      } catch (err) { toast(err.message, 'danger'); btn.disabled = false; }
    });
  });
  $$('[data-enviar-estimacion]', el).forEach((btn) => {
    btn.addEventListener('click', () => openCambioEstadoEstimacionModal(Number(btn.dataset.enviarEstimacion), 'enviada', false, loadEstimaciones));
  });
  $$('[data-aprobar-estimacion]', el).forEach((btn) => {
    btn.addEventListener('click', () => openCambioEstadoEstimacionModal(Number(btn.dataset.aprobarEstimacion), 'aprobada', false, loadEstimaciones));
  });
  $$('[data-rechazar-estimacion]', el).forEach((btn) => {
    btn.addEventListener('click', () => openCambioEstadoEstimacionModal(Number(btn.dataset.rechazarEstimacion), 'rechazada', true, loadEstimaciones));
  });
  $$('[data-eliminar-estimacion]', el).forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('¿Eliminar esta estimación en borrador?')) return;
      btn.disabled = true;
      try {
        await api(`/projects/${state.projectId}/estimaciones/${btn.dataset.eliminarEstimacion}`, { method: 'DELETE' });
        toast('Estimación eliminada', 'success');
        await loadEstimaciones();
      } catch (err) { toast(err.message, 'danger'); btn.disabled = false; }
    });
  });
  $$('[data-descargar-estimacion]', el).forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await apiDownload(`/projects/${state.projectId}/estimaciones/${btn.dataset.descargarEstimacion}/pdf`, `Estimacion_${btn.dataset.folio}.pdf`);
      } catch (err) { toast(err.message, 'danger'); }
      btn.disabled = false;
    });
  });
}

async function openEstimacionModal(onSave) {
  // Defaults sugeridos (editables): día siguiente al periodo_fin de la última
  // estimación de la obra → hoy; o, si es la primera, inicio de contrato o
  // primer avance registrado → hoy. Si el fetch falla, se abre igual con los
  // campos vacíos — no bloquea la creación.
  let defaults = {};
  try { defaults = await api(`/projects/${state.projectId}/estimaciones/defaults-periodo`); } catch { /* sin default, campos vacíos */ }

  openModal(`
    <h3>Nueva estimación</h3>
    <p class="muted fs-088">Los montos se jalan automáticamente del avance ya registrado en el periodo — no se capturan aquí. Si algo no cuadra, corrígelo en Avance y vuelve a calcular.</p>
    <div class="field"><label>Nombre (opcional)</label><input id="eNombre" placeholder="Ej. Cimentación etapa 1" maxlength="120" /></div>
    <div class="estimacion-periodo-grid">
      <div class="field"><label>Periodo inicio *</label><input id="ePeriodoInicio" type="date" value="${esc(defaults.periodo_inicio || '')}" /></div>
      <div class="field"><label>Periodo fin *</label><input id="ePeriodoFin" type="date" value="${esc(defaults.periodo_fin || '')}" /></div>
    </div>
    <p class="alert-box danger hidden-initial" id="ePeriodoError"></p>
    <div class="modal-actions">
      <button class="btn" id="btnCancelEstimacion">Cancelar</button>
      <button class="btn btn-primary" id="btnSaveEstimacion">Crear estimación</button>
    </div>
  `);
  const nombreEl = $('#eNombre');
  const inicioEl = $('#ePeriodoInicio');
  const finEl = $('#ePeriodoFin');
  const errorEl = $('#ePeriodoError');
  const saveBtn = $('#btnSaveEstimacion');
  // Valida en vivo (no solo al enviar) — el default calculado puede llegar
  // invertido en casos borde (última estimación cerrando en/después de hoy)
  // y el usuario también puede invertirlas a mano; en ambos casos se bloquea
  // el envío en vez de confiar solo en el default o en la validación del server.
  function validarPeriodo() {
    const inicio = inicioEl.value;
    const fin = finEl.value;
    const invalido = !!(inicio && fin && inicio > fin);
    errorEl.classList.toggle('hidden-initial', !invalido); // ver .hidden-initial en styles.css
    if (invalido) errorEl.textContent = 'Periodo inicio no puede ser posterior a Periodo fin.';
    saveBtn.disabled = invalido;
    return !invalido;
  }
  inicioEl.addEventListener('input', validarPeriodo);
  finEl.addEventListener('input', validarPeriodo);
  validarPeriodo();

  $('#btnCancelEstimacion').addEventListener('click', closeModal);
  $('#btnSaveEstimacion').addEventListener('click', async () => {
    const periodo_inicio = inicioEl.value;
    const periodo_fin = finEl.value;
    if (!periodo_inicio || !periodo_fin) { toast('Las fechas de inicio y fin son obligatorias', 'danger'); return; }
    if (!validarPeriodo()) return;
    const btn = $('#btnSaveEstimacion');
    btn.disabled = true;
    try {
      await api(`/projects/${state.projectId}/estimaciones`, {
        method: 'POST',
        body: { periodo_inicio, periodo_fin, nombre: nombreEl.value.trim() || null },
      });
      toast('Estimación creada', 'success');
      closeModal();
      if (onSave) await onSave();
    } catch (err) { toast(err.message, 'danger'); btn.disabled = false; }
  });
}

// Renombrar (Prompt 4, prompts-cotizador-sidebar-permisos-estimaciones.md)
// — modal chico y separado del detalle, mismo patrón que otros "renombrar"
// de la app (confirm-dialog simple, sin abrir el detalle completo).
function openRenombrarEstimacionModal(estimacionId, nombreActual, onDone) {
  openModal(`
    <h3>Renombrar estimación</h3>
    <div class="field"><label>Nombre</label><input id="renombrarEstimacionInput" value="${esc(nombreActual || '')}" placeholder="Ej. Cimentación etapa 1" maxlength="120" /></div>
    <p class="muted fs-08">Déjalo vacío para volver a mostrar solo el folio.</p>
    <div class="modal-actions">
      <button class="btn" id="btnCancelarRenombrarEstimacion">Cancelar</button>
      <button class="btn btn-primary" id="btnGuardarRenombrarEstimacion">Guardar</button>
    </div>
  `);
  $('#renombrarEstimacionInput').focus();
  $('#btnCancelarRenombrarEstimacion').addEventListener('click', closeModal);
  $('#btnGuardarRenombrarEstimacion').addEventListener('click', async () => {
    const btn = $('#btnGuardarRenombrarEstimacion');
    btn.disabled = true;
    try {
      await api(`/projects/${state.projectId}/estimaciones/${estimacionId}/nombre`, {
        method: 'PUT',
        body: { nombre: $('#renombrarEstimacionInput').value.trim() },
      });
      toast('Nombre actualizado', 'success');
      closeModal();
      if (onDone) await onDone();
    } catch (err) { toast(err.message, 'danger'); btn.disabled = false; }
  });
}

// Modal en pantalla ancha en desktop (Prompt 4) — .modal-wide se limpia en
// closeModal() para no dejarlo pegado a otros modales que reusan el mismo
// #modal compartido.
async function openVerEstimacionModal(estimacionId) {
  $('#modal').classList.add('modal-wide');
  openModal(`<h3>Detalle de estimación</h3><div id="verEstimacionBody"><div class="empty-state">Cargando…</div></div><div class="modal-actions"><button class="btn" id="btnCerrarVerEstimacion">Cerrar</button></div>`);
  $('#btnCerrarVerEstimacion').addEventListener('click', closeModal);
  await pintarVerEstimacion(estimacionId);
}

async function pintarVerEstimacion(estimacionId) {
  const money = (n) => `$${Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`;
  try {
    const data = await api(`/projects/${state.projectId}/estimaciones/${estimacionId}`);
    const items = data.items || [];
    const el = $('#verEstimacionBody');
    if (!el) return;
    if (!items.length) { el.innerHTML = '<div class="empty-state">Sin conceptos calculados. Usa el botón Calcular primero.</div>'; return; }
    // Amortización solo editable mientras el desglose de pago no está fijo
    // (mismo candado que "Calcular" en el backend — ver PUT .../amortizacion).
    const puedeEditarAmortizacion = ['borrador', 'rechazada'].includes(data.estado) && puedeCapturarEstimacion();
    el.innerHTML = `
      <div class="muted nomina-detalle-fecha">Folio #${data.folio}${data.nombre ? ' · ' + esc(data.nombre) : ''} · ${esc(data.periodo_inicio)} al ${esc(data.periodo_fin)}</div>
      <div class="nomina-table-wrap">
      <table class="nomina-table">
        <thead><tr>
          <th class="nomina-th-left">Concepto</th>
          <th class="nomina-th-right">Cant. periodo</th>
          <th class="nomina-th-right">Importe periodo</th>
          <th class="nomina-th-right">Cant. acumulada</th>
          <th class="nomina-th-right">Importe acumulado</th>
          <th class="nomina-th-right">% avance</th>
        </tr></thead>
        <tbody>
          ${items.map((i) => `
            <tr>
              <td class="nomina-td">${esc(i.codigo ? i.codigo + ' — ' : '')}${esc(i.concepto)}</td>
              <td class="nomina-td-right">${Number(i.cantidad_periodo || 0).toLocaleString('es-MX')}</td>
              <td class="nomina-td-right">${money(i.importe_periodo)}</td>
              <td class="nomina-td-right">${Number(i.cantidad_acumulada || 0).toLocaleString('es-MX')}</td>
              <td class="nomina-td-right">${money(i.importe_acumulado)}</td>
              <td class="nomina-td-right">${Number(i.porcentaje_avance || 0).toFixed(1)}%</td>
            </tr>`).join('')}
        </tbody>
        <tfoot><tr>
          <td colspan="2" class="nomina-tfoot-label">Total periodo / acumulado</td>
          <td class="nomina-tfoot-total">${money(data.total_periodo)}</td>
          <td></td>
          <td class="nomina-tfoot-total">${money(data.total_acumulado)}</td>
          <td></td>
        </tr></tfoot>
      </table>
      </div>

      <h4 class="mt-16">Desglose de pago</h4>
      <div class="table-scroll">
        <table class="nomina-table estimacion-desglose-table">
          <tbody>
            <tr>
              <td class="nomina-td">Estimación (periodo)</td>
              <td class="nomina-td-right">${money(data.total_periodo)}</td>
            </tr>
            <tr>
              <td class="nomina-td">Amortización de anticipo</td>
              <td class="nomina-td-right">
                ${puedeEditarAmortizacion
                  ? `<input type="number" min="0" step="0.01" id="estAmortizacionInput" value="${Number(data.amortizacion_anticipo || 0)}" class="estimacion-amortizacion-input" />`
                  : `-${money(data.amortizacion_anticipo)}`}
              </td>
            </tr>
            <tr>
              <td class="nomina-td">2% Fondo de garantía</td>
              <td class="nomina-td-right">-${money(data.fondo_garantia_monto)}</td>
            </tr>
            <tr>
              <td class="nomina-td">Más IVA 16%</td>
              <td class="nomina-td-right">+${money(data.iva_monto)}</td>
            </tr>
            <tr class="estimacion-total-a-pagar-row">
              <td class="nomina-td">Total a pagar</td>
              <td class="nomina-td-right">${money(data.total_a_pagar)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      ${puedeEditarAmortizacion ? `<div class="row end mt-8"><button class="btn small btn-primary" id="btnGuardarAmortizacion">Guardar amortización</button></div>` : ''}
    `;
    $('#btnGuardarAmortizacion')?.addEventListener('click', async () => {
      const btn = $('#btnGuardarAmortizacion');
      const input = $('#estAmortizacionInput');
      const monto = Number(input.value);
      if (!Number.isFinite(monto) || monto < 0) { toast('Monto de amortización inválido', 'danger'); return; }
      btn.disabled = true;
      try {
        await api(`/projects/${state.projectId}/estimaciones/${estimacionId}/amortizacion`, {
          method: 'PUT',
          body: { amortizacion_anticipo: monto },
        });
        toast('Amortización actualizada', 'success');
        await pintarVerEstimacion(estimacionId);
      } catch (err) { toast(err.message, 'danger'); btn.disabled = false; }
    });
  } catch (err) {
    const el = $('#verEstimacionBody');
    if (el) el.innerHTML = `<div class="alert-box danger">⚠️ ${esc(err.message)}</div>`;
  }
}

async function openCambioEstadoEstimacionModal(estimacionId, nuevoEstado, pedirComentario, onDone) {
  const accionLabel = { enviada: 'Enviar a aprobación', aprobada: 'Aprobar estimación', rechazada: 'Rechazar estimación' }[nuevoEstado];
  openModal(`
    <h3>${accionLabel}</h3>
    ${pedirComentario ? `<div class="field"><label>Motivo de rechazo *</label><textarea id="estimacionComentario" rows="3"></textarea></div>` : ''}
    <p class="muted fs-088">¿Confirmas el cambio de estado?</p>
    <div class="modal-actions">
      <button class="btn" id="btnCancelEstadoEstimacion">Cancelar</button>
      <button class="btn btn-primary" id="btnConfirmEstadoEstimacion">Confirmar</button>
    </div>
  `);
  $('#btnCancelEstadoEstimacion').addEventListener('click', closeModal);
  $('#btnConfirmEstadoEstimacion').addEventListener('click', async () => {
    const btn = $('#btnConfirmEstadoEstimacion');
    const comentario_rechazo = pedirComentario ? ($('#estimacionComentario')?.value.trim() || '') : null;
    if (pedirComentario && !comentario_rechazo) { toast('El motivo de rechazo es obligatorio', 'danger'); return; }
    btn.disabled = true;
    try {
      await api(`/projects/${state.projectId}/estimaciones/${estimacionId}/estado`, {
        method: 'PUT',
        body: { estado: nuevoEstado, comentario_rechazo },
      });
      toast('Estado actualizado', 'success');
      closeModal();
      if (onDone) await onDone();
    } catch (err) { toast(err.message, 'danger'); btn.disabled = false; }
  });
}

// ---------------------------------------------------------------------------
// Topbar height — CSS variable dinámica para tabs y sticky-filters
// Se mide con ResizeObserver para adaptarse a cualquier dispositivo / safe-area.
// ---------------------------------------------------------------------------
let _topbarObserver = null;
function initTopbarObserver() {
  if (_topbarObserver) return;
  const el = document.querySelector('.topbar');
  if (!el) return;
  const update = () => {
    const h = el.getBoundingClientRect().height;
    if (h > 0) document.documentElement.style.setProperty('--topbar-h', `${h}px`);
    const tabsEl = document.querySelector('#tabs');
    if (tabsEl && tabsEl.offsetParent !== null) {
      const th = tabsEl.getBoundingClientRect().height;
      if (th > 0) document.documentElement.style.setProperty('--tabs-h', `${th}px`);
    }
  };
  _topbarObserver = new ResizeObserver(update);
  _topbarObserver.observe(el);
  requestAnimationFrame(update);
}

// ---------------------------------------------------------------------------
// DEBUG — métricas técnicas (visible en Ajustes → Información técnica)
// ---------------------------------------------------------------------------
function initDebugBadge() {
  // Eliminar overlay flotante si quedó de versiones anteriores del código
  const existing = document.getElementById('__dbg');
  if (existing) existing.remove();
  if (window.__dbgInterval) { clearInterval(window.__dbgInterval); window.__dbgInterval = null; }

  // Probe permanente para medir env(safe-area-inset-bottom) en px reales.
  // Se crea una vez al iniciar la app y lo usan las métricas de Ajustes.
  if (!document.getElementById('__safeProbe')) {
    const probe = document.createElement('div');
    probe.id = '__safeProbe';
    Object.assign(probe.style, {
      position: 'fixed', bottom: '0', left: '0', width: '1px',
      height: 'env(safe-area-inset-bottom, 0px)',
      pointerEvents: 'none', visibility: 'hidden',
    });
    document.body.appendChild(probe);
  }
}

// Lee info del SW y devuelve { line, version } donde version es "ctrl-ppto-vN".
async function _dbgSwInfo() {
  if (!navigator.serviceWorker) return { line: 'SW API no disponible', version: '—' };
  const ctrl = navigator.serviceWorker.controller;
  let cacheList = '…';
  let version = '—';
  try {
    const keys = await caches.keys();
    const relevant = keys.filter((k) => k.startsWith('ctrl-ppto'));
    cacheList = relevant.length ? relevant.join(', ') : '(sin caches ctrl-ppto)';
    if (relevant.length) version = relevant[relevant.length - 1];
  } catch { cacheList = 'caches.keys() falló'; }
  return { line: (ctrl ? 'controller ok' : 'sin controller') + ' | ' + cacheList, version };
}

// Rellena targetEl con todas las métricas de debug. Sin efectos secundarios.
function _dbgRender(targetEl, label, swLine, version) {
  const cs       = getComputedStyle(document.documentElement);
  const th       = cs.getPropertyValue('--topbar-h').trim()   || '(no set)';
  const tbh      = cs.getPropertyValue('--tabs-h').trim()     || '(no set)';
  const st       = cs.getPropertyValue('--safe-top').trim()   || '(no set)';
  const sbCss    = cs.getPropertyValue('--safe-bottom').trim()|| '(no set)';
  const tbEl     = document.querySelector('.topbar');
  const tabsEl   = document.querySelector('#tabs');
  const tbR      = tbEl  ? tbEl.getBoundingClientRect()  : null;
  const tabsVis  = tabsEl && getComputedStyle(tabsEl).display !== 'none';
  const tabR     = tabsVis ? tabsEl.getBoundingClientRect() : null;
  const fmt      = (r) => r ? `top=${Math.round(r.top)} h=${Math.round(r.height)}` : 'null';

  const navEl    = document.getElementById('mobileNav');
  const navR     = navEl ? navEl.getBoundingClientRect() : null;
  const navH     = navR ? Math.round(navR.height) : '?';
  const navBot   = navR ? Math.round(navR.bottom) : '?';
  const wh       = window.innerHeight;
  const gapBelow = navR ? (wh - Math.round(navR.bottom)) : '?';

  const probe    = document.getElementById('__safeProbe');
  const sbPx     = probe ? Math.round(probe.getBoundingClientRect().height) : '?';

  const appEl    = document.getElementById('app');
  const appR     = appEl ? appEl.getBoundingClientRect() : null;
  const appH     = appR  ? Math.round(appR.height) : '?';
  const appBot   = appR  ? Math.round(appR.bottom) : '?';

  let gapElDesc = '(sin gap)';
  if (navR && gapBelow > 1) {
    const mx = Math.round(window.innerWidth / 2);
    const my = Math.round(navR.bottom + gapBelow / 2);
    const el = document.elementFromPoint(mx, my);
    if (el) {
      const bg  = getComputedStyle(el).backgroundColor;
      const tag = el.id ? `#${el.id}` : (el.className
        ? `.${String(el.className).trim().split(/\s+/)[0]}` : el.tagName);
      gapElDesc = `${tag} bg=${bg}`;
    }
  }

  targetEl.innerHTML =
    `<div class="mb-10">` +
      `<span class="dbg-label">Versión</span><br>` +
      `<span class="dbg-version">${version}</span>` +
    `</div>` +
    `<pre class="dbg-pre">` +
    `[${label}]\n` +
    `--topbar-h: ${th}\n` +
    `--tabs-h:   ${tbh}\n` +
    `--safe-top: ${st}\n` +
    `topbar BCR: ${fmt(tbR)}\n` +
    `#tabs BCR:  ${tabsVis ? fmt(tabR) : '(oculto)'}\n` +
    `── nav inferior ──\n` +
    `navH=${navH} navBot=${navBot}\n` +
    `innerH=${wh} gap↓=${gapBelow}px\n` +
    `safe-bot css=${sbCss} px=${sbPx}\n` +
    `#app h=${appH} bot=${appBot}\n` +
    `gapEl: ${gapElDesc}\n` +
    `SW: ${swLine}</pre>`;
}

// Inicia el ciclo de actualización en vivo dentro de targetEl.
// Se detiene automáticamente cuando el elemento desaparece del DOM.
async function initDebugSection(targetEl) {
  const { line, version } = await _dbgSwInfo();
  _dbgRender(targetEl, '@open', line, version);
  if (window.__dbgAjustesInterval) clearInterval(window.__dbgAjustesInterval);
  window.__dbgAjustesInterval = setInterval(async () => {
    const el = document.getElementById('__dbgInline');
    if (!el) { clearInterval(window.__dbgAjustesInterval); return; }
    const { line: l, version: v } = await _dbgSwInfo();
    _dbgRender(el, '@live', l, v);
  }, 2000);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
tryRestoreSession().finally(medirTTI);
