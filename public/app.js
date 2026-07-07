'use strict';

/* =========================================================================
 * Control Presupuestal de Obra — SPA (vanilla JS, mobile-first PWA)
 * ========================================================================= */

const TOKEN_KEY = 'cp_token';
const PUESTO_LABELS = {
  admin: 'Administrador', residente: 'Residente', cabo: 'Cabo',
  compras: 'Compras', tesoreria: 'Tesorería', administracion: 'Administración', logistica: 'Logística',
};

const state = {
  projects: [],
  projectId: null,
  clientes: [],
  clienteId: null,
  pendingUploadClienteId: null,
  pendingContrato: null,
  view: 'inicio',
  section: null,     // sección activa (obra/compras/administracion/tesoreria/maquinaria) o null
  cache: {},     // per-project cached API responses
  charts: {},    // active Chart.js instances (destroyed on re-render)
  token: null,
  user: null,        // { id, nombre, usuario, puesto }
  allowedTabs: [],
  notificaciones: [],
  notifNoLeidas: 0,
  notifTimer: null,
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
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:inline-block;vertical-align:middle;flex-shrink:0">${inner}</svg>`;
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

function chartColors() {
  const light = getEffectiveTheme() === 'light';
  return {
    text: light ? '#334155' : '#e2e8f0',
    grid: light ? '#e2e8f0' : '#334155',
    tick: light ? '#475569' : '#94a3b8',
  };
}

function applyTheme(pref) {
  const effective = pref === 'system' ? (_mqDark.matches ? 'dark' : 'light') : pref;
  document.documentElement.setAttribute('data-theme', effective);
  const btn = $('#btnThemeToggle');
  if (btn) btn.innerHTML = effective === 'light' ? icon('moon', 16) : icon('sun', 16);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', effective === 'light' ? '#EAEEF5' : '#0B1220');
  // Actualizar botones activos en el popover
  $$('.theme-opt').forEach((el) => el.classList.toggle('active', el.dataset.themeSet === pref));
  // Actualizar íconos en el popover
  const li = $('#themeIconLight'); if (li) li.innerHTML = icon('sun', 14);
  const di = $('#themeIconDark');  if (di) di.innerHTML = icon('moon', 14);
  const si = $('#themeIconSystem');if (si) si.innerHTML = icon('monitor', 14);
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

// Actualizar en vivo cuando el SO cambia y el usuario eligió 'system'
_mqDark.addEventListener('change', () => { if (getTheme() === 'system') applyTheme('system'); });

applyTheme(getTheme());
$('#btnThemeToggle').addEventListener('click', toggleTheme);
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

function showInstallBanner(mode) {
  if (isStandalone() || localStorage.getItem(INSTALL_DISMISSED_KEY)) return;
  const banner = $('#installBanner');
  if (!banner) return;
  $('#installBannerText').textContent = mode === 'ios'
    ? 'Instala esta app: toca Compartir ⬆️ en Safari y elige "Agregar a pantalla de inicio".'
    : 'Instala Control Presupuestal en tu dispositivo para acceso rápido, sin navegador.';
  $('#btnInstallApp').style.display = mode === 'ios' ? 'none' : '';
  banner.style.display = 'flex';
}

window.addEventListener('beforeinstallprompt', (ev) => {
  ev.preventDefault();
  deferredInstallPrompt = ev;
  showInstallBanner('android');
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  $('#installBanner').style.display = 'none';
});

$('#btnInstallApp').addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  $('#installBanner').style.display = 'none';
});

$('#btnDismissInstall').addEventListener('click', () => {
  localStorage.setItem(INSTALL_DISMISSED_KEY, '1');
  $('#installBanner').style.display = 'none';
});

if (isIOS() && !isStandalone()) showInstallBanner('ios');

const fmtMoney = (n) => (n == null ? '—' : Number(n).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 }));
const fmtNum = (n, d = 2) => (n == null ? '—' : Number(n).toLocaleString('es-MX', { maximumFractionDigits: d }));
const fmtPct = (n) => (n == null ? '—' : `${Number(n).toLocaleString('es-MX', { maximumFractionDigits: 1 })}%`);
const fmtDate = (s) => {
  if (!s) return '—';
  const d = new Date(`${s}T00:00:00`);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------
async function api(path, opts = {}) {
  const headers = opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers,
    body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (res.status === 401 && path !== '/auth/login') {
    handleSessionExpired();
    throw new Error((data && data.error) || 'Sesión expirada');
  }
  if (!res.ok) throw new Error((data && data.error) || `Error ${res.status}`);
  return data;
}

// Descarga un .xlsx generado por el servidor (reusado por todos los botones
// "Exportar a Excel" — el archivo y su nombre los arma el backend, aquí solo
// se dispara la descarga con el token de sesión en el header).
async function downloadExport(path) {
  const headers = {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(`/api${path}`, { headers });
  if (res.status === 401) {
    handleSessionExpired();
    throw new Error('Sesión expirada');
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
function showLoginScreen() {
  $('#app').style.display = 'none';
  $('#clientGalleryScreen').style.display = 'none';
  $('#welcomeScreen').style.display = 'none';
  $('#loginScreen').style.display = 'flex';
  $('#loginUsuario').focus();
}
function showApp() {
  $('#loginScreen').style.display = 'none';
  $('#clientGalleryScreen').style.display = 'none';
  $('#welcomeScreen').style.display = 'none';
  $('#app').style.display = '';
}
function showClientGallery() {
  $('#loginScreen').style.display = 'none';
  $('#app').style.display = 'none';
  $('#welcomeScreen').style.display = 'none';
  $('#clientGalleryScreen').style.display = 'flex';
}
function showWelcomeScreen() {
  $('#loginScreen').style.display = 'none';
  $('#clientGalleryScreen').style.display = 'none';
  $('#app').style.display = 'none';
  $('#welcomeScreen').style.display = 'flex';
}

function isAdmin() { return !!state.user && state.user.puesto === 'admin'; }
function canManageDestajo() { return !!state.user && ['admin', 'residente'].includes(state.user.puesto); }
function puedeGenerarOC() { return !!state.user && ['admin', 'compras'].includes(state.user.puesto); }
function puedeAutorizarRequisicion() { return !!state.user && ['admin', 'logistica'].includes(state.user.puesto); }
function puedeVerPrecios() { return !!state.user && state.user.puesto !== 'cabo'; }
function puedeCrearRequisicion() { return !!state.user && ['admin', 'residente', 'cabo', 'compras'].includes(state.user.puesto); }
function puedeVerImportesRequisicion() { return !!state.user && !['residente', 'cabo'].includes(state.user.puesto); }
function puedeRegistrarPago() { return !!state.user && ['admin', 'tesoreria'].includes(state.user.puesto); }
function puedeVerImportesAvance() { return !!state.user && state.user.puesto !== 'cabo'; }
function puedeEditarAvance() { return !!state.user && ['admin', 'residente', 'cabo'].includes(state.user.puesto); }
function puedeGestionarUsuarios() { return !!state.user && ['admin', 'administracion'].includes(state.user.puesto); }
function puedeGestionarTrabajadores() { return !!state.user && state.user.puesto === 'admin'; }
function puedeVerNominas() { return !!state.user && ['admin', 'residente'].includes(state.user.puesto); }
function puedeCapturarAsistencia() { return !!state.user && ['admin', 'residente'].includes(state.user.puesto); }
function puedeAprobarNomina() { return !!state.user && state.user.puesto === 'admin'; }

function applySession(user, tabs) {
  state.user = user;
  state.allowedTabs = tabs;
  const isAdmin = user.puesto === 'admin';
  $('#btnUpload').style.display = isAdmin ? '' : 'none';
  $('#btnUploadDrawer').style.display = isAdmin ? '' : 'none';
  renderDrawerAccount();
  state.view = tabs.length <= 1 ? (tabs[0] || 'inicio') : 'inicio';
  state.section = VIEW_TO_SECTION[state.view] || null;
  startNotifPolling();
  renderSidebar();
  renderMobileNav();
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
  obra:          { label: 'Obra',           icon: 'obra',           emoji: '🏗️',  tabs: ['programa', 'avance', 'destajo'],                     proximamente: ['Estimaciones'] },
  compras:       { label: 'Compras',        icon: 'compras',        emoji: '🛒',   tabs: ['requisiciones', 'insumos', 'proveedores', 'ordenes'], proximamente: ['Subcontratos'] },
  tesoreria:     { label: 'Tesorería',      icon: 'tesoreria',      emoji: '💰',   tabs: ['finanzas', 'impuestos'],                             proximamente: [] },
  administracion:{ label: 'Administración', icon: 'administracion', emoji: '⚙️',  tabs: ['usuarios', 'mapeo', 'contrato'],                    proximamente: ['Almacenes'] },
  personal:      { label: 'Personal',       icon: 'usuarios',       emoji: '👷',   tabs: ['trabajadores', 'nominas'],                           proximamente: [] },
  maquinaria:    { label: 'Maquinaria',     icon: 'maquinaria',     emoji: '🚜',   tabs: [],                                                    proximamente: ['Maquinaria'] },
};

const TAB_ICONS = {
  resumen: '📊', contrato: '📄', impuestos: '🧾', insumos: '📦', requisiciones: '🧾',
  proveedores: '🏭', ordenes: '🛒', programa: '🗓️', avance: '📈', destajo: '👷',
  finanzas: '💰', mapeo: '🔗', usuarios: '👤', trabajadores: '👷', nominas: '💵',
};
const TAB_LABELS = {
  resumen: 'Resumen', contrato: 'Contrato', impuestos: 'Impuestos', insumos: 'Insumos', requisiciones: 'Requisiciones',
  proveedores: 'Proveedores', ordenes: 'Órdenes de Compra', programa: 'Programa', avance: 'Avance', destajo: 'Destajo',
  finanzas: 'Finanzas', mapeo: 'Mapeo', usuarios: 'Usuarios', trabajadores: 'Trabajadores', nominas: 'Nóminas',
};

const VIEW_TO_SECTION = {};
Object.entries(SECTION_DEFS).forEach(([sectionId, def]) => {
  def.tabs.forEach((t) => { VIEW_TO_SECTION[t] = sectionId; });
});

// Historial de navegación (botón atrás del navegador / gesto equivalente en
// móvil) — registra cada cambio de pestaña dentro del presupuesto abierto
// para que "atrás" regrese a la pestaña anterior en vez de salir de la app
// o recargar sin estado. Nunca se toca la URL (siempre location.href): solo
// viaja el estado de history, así no hay riesgo de romper enlaces/bookmarks.
// Alcance a propósito: solo pestañas dentro del MISMO presupuesto — cambiar
// de presupuesto reinicia el historial (selectProject usa replaceState),
// y el estado de modales/formularios a medio llenar se descarta al volver.
function pushTabHistory() {
  history.pushState({ cpNav: true, projectId: state.projectId, view: state.view, section: state.section }, '', location.href);
}

function replaceTabHistory() {
  history.replaceState({ cpNav: true, projectId: state.projectId, view: state.view, section: state.section }, '', location.href);
}

window.addEventListener('popstate', (ev) => {
  const s = ev.state;
  // Entrada ajena a nuestro historial de pestañas (ya sea de otro presupuesto
  // o de antes de que existiera este mecanismo): se corrige en vez de
  // dejarla "viva" — así el botón atrás nunca queda atorado en un estado
  // que ya no corresponde a lo que se ve en pantalla.
  if (!s || !s.cpNav || s.projectId !== state.projectId) { replaceTabHistory(); return; }
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
  const ma = document.querySelector('.main-area');
  if (ma) ma.scrollTop = 0;
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
  const firstTab = def.tabs.find((t) => state.allowedTabs.includes(t));
  if (!firstTab) { toast('No tienes módulos disponibles en esta sección', ''); return; }
  switchToView(firstTab);
}

// Reconstruye la barra bajo el topbar: oculta en 'inicio' (la navegación ahí
// es por las tarjetas de sección dentro de la vista), botón "← Secciones"
// + tabs reales de la sección cuando hay una activa, o solo "← Inicio"
// para los accesos rápidos sin sección (Contrato/Impuestos).
function renderTabsBar() {
  const nav = $('#tabs');
  if (!nav) return;
  if (!state.projectId || state.view === 'inicio') { nav.innerHTML = ''; nav.style.display = 'none'; return; }
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
  const btn = $('#btnSidebarCollapse');
  if (btn) btn.innerHTML = icon(collapsed ? 'chevron-right' : 'chevron-left', 16);
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

function renderSidebar() {
  const nav = $('#sidebarNav');
  if (!nav) return;

  // Actualizar info de perfil (siempre, incluso si aún no hay proyecto)
  if (state.user) {
    const initials = state.user.nombre.split(' ').map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
    const av = $('#sidebarAvatar');      if (av) av.textContent = initials;
    const nm = $('#sidebarProfileName'); if (nm) nm.textContent = state.user.nombre;
    const rl = $('#sidebarProfileRole'); if (rl) rl.textContent = PUESTO_LABELS[state.user.puesto] || state.user.puesto;
    const pn = $('#popoverName');        if (pn) pn.textContent = state.user.nombre;
    const pr = $('#popoverRole');        if (pr) pr.textContent = PUESTO_LABELS[state.user.puesto] || state.user.puesto;
  }
  // Ícono del proyecto en sidebar
  const pi = $('#sidebarProjectIcon'); if (pi) pi.textContent = '🏗️';
  const pc = $('#sidebarProjectChevron'); if (pc) pc.innerHTML = icon('chevron-down', 13);
  const pch = $('#sidebarProfileChevron'); if (pch) pch.innerHTML = icon('chevron-down', 13);

  if (!state.user) { nav.innerHTML = ''; return; }

  let html = '';

  // Resumen — ítem suelto
  if (state.allowedTabs.includes('resumen')) {
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
    const visibleTabs = def.tabs.filter((t) => state.allowedTabs.includes(t));
    if (!visibleTabs.length) return; // sin acceso a ningún tab del grupo

    const isActive = state.section === sectionId;
    html += `<div class="sbar-group ${isActive ? 'open' : ''}">
      <button class="sbar-group-header ${isActive ? 'active' : ''}" data-sbar-group="${sectionId}" title="${esc(def.label)}">
        <span class="sbar-icon">${def.emoji}</span>
        <span class="sbar-label">${esc(def.label)}</span>
        <span class="sbar-chevron">${icon('chevron-down', 13)}</span>
      </button>
      <div class="sbar-group-body"><div>`;
    visibleTabs.forEach((t) => {
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

  nav.innerHTML = html;

  // Toggle de grupo
  $$('.sbar-group-header', nav).forEach((btn) => {
    btn.addEventListener('click', () => {
      const group = btn.closest('.sbar-group');
      const sectionId = btn.dataset.sbarGroup;
      const isCollapsed = $('#sidebar').classList.contains('collapsed');

      // En sidebar colapsada: navegar directamente sin expandir
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
        // Navegar al primer tab si el usuario no está ya en este grupo
        if (state.section !== sectionId) {
          const def = SECTION_DEFS[sectionId];
          const firstTab = def.tabs.find((t) => state.allowedTabs.includes(t));
          if (firstTab) switchToView(firstTab);
        }
      }
      // Si estaba abierto y se cerró: no navegar, solo colapsar visualmente
    });
  });

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
  // Marcar tema activo
  applyTheme(getTheme());
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
  if (!state.projectId) { toast('Selecciona un presupuesto primero', ''); return; }
  const menu = $('#quickActionMenu'); if (!menu) return;
  const list = $('#quickActionList'); if (!list) return;

  const actions = [];
  if (puedeCrearRequisicion() && state.allowedTabs.includes('requisiciones'))
    actions.push({ label: 'Nueva Requisición',    icon: 'requisiciones', goto: 'requisiciones' });
  if (puedeEditarAvance() && state.allowedTabs.includes('avance'))
    actions.push({ label: 'Registrar Avance',     icon: 'avance',        goto: 'avance' });
  if (puedeGenerarOC() && state.allowedTabs.includes('ordenes'))
    actions.push({ label: 'Nueva Orden de Compra', icon: 'ordenes',      goto: 'ordenes' });

  list.innerHTML = actions.length
    ? actions.map((a) => `
      <button class="quick-action-item" data-goto="${a.goto}">
        <span style="font-size:1.2em">${TAB_ICONS[a.icon] || ''}</span><span>${esc(a.label)}</span>
      </button>`).join('')
    : '<p class="muted" style="padding:8px 0">No hay acciones disponibles para tu rol.</p>';

  $$('.quick-action-item', list).forEach((btn) => {
    btn.addEventListener('click', () => { closeQuickActionMenu(); switchToView(btn.dataset.goto); });
  });

  menu.style.display = '';
  requestAnimationFrame(() => menu.classList.add('show'));
}

function closeQuickActionMenu() {
  const menu = $('#quickActionMenu'); if (!menu) return;
  menu.classList.remove('show');
  setTimeout(() => { if (!menu.classList.contains('show')) menu.style.display = 'none'; }, 220);
}

// ---------------------------------------------------------------------------
// Ajustes móvil (perfil, tema, mi cuenta, cerrar sesión)
// ---------------------------------------------------------------------------
function openMobileAjustes() {
  const pref = getTheme();
  openModal(`
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <h3 style="margin:0">Ajustes</h3>
      <button class="icon-btn" id="btnCloseProfile" aria-label="Cerrar" style="width:32px;height:32px;font-size:1rem">✕</button>
    </div>
    <div style="margin-bottom:14px;line-height:1.4">
      <strong>${esc(state.user?.nombre || '')}</strong>
      <div class="muted">${esc(PUESTO_LABELS[state.user?.puesto] || '')}</div>
    </div>
    <label style="margin-bottom:6px;display:block">Tema</label>
    <div class="theme-selector" style="margin-bottom:16px">
      <button class="theme-opt ${pref==='light'?'active':''}" data-theme-set="light">${icon('sun',14)} Claro</button>
      <button class="theme-opt ${pref==='dark'?'active':''}" data-theme-set="dark">${icon('moon',14)} Oscuro</button>
      <button class="theme-opt ${pref==='system'?'active':''}" data-theme-set="system">${icon('monitor',14)} Sistema</button>
    </div>
    <button class="btn full" id="btnMiCuentaModal" style="margin-bottom:6px">Mi cuenta</button>
    <button class="btn btn-danger full" id="btnLogoutModal">Cerrar sesión</button>
  `);
  $$('.theme-opt', $('#modal')).forEach((btn) => {
    btn.addEventListener('click', () => {
      setTheme(btn.dataset.themeSet);
      $$('.theme-opt', $('#modal')).forEach((b) => b.classList.toggle('active', b.dataset.themeSet === btn.dataset.themeSet));
    });
  });
  $('#btnMiCuentaModal').addEventListener('click', () => { closeModal(); openMiCuentaModal(false); });
  $('#btnLogoutModal').addEventListener('click', () => { closeModal(); logout(); });
  $('#btnCloseProfile').addEventListener('click', closeModal);
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

function renderNotifList(targetEl) {
  const list = targetEl || $('#notifList');
  if (!state.notificaciones.length) {
    list.innerHTML = '<div class="empty-state" style="padding:24px 12px">Sin notificaciones.</div>';
    return;
  }
  list.innerHTML = state.notificaciones.map((n) => `
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

function renderDrawerAccount() {
  const box = $('#drawerAccount');
  if (!state.user) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <div class="who">
      <strong>${esc(state.user.nombre)}</strong>
      <span>${esc(PUESTO_LABELS[state.user.puesto] || state.user.puesto)}</span>
    </div>
    <button class="btn small" id="btnLogoutDrawer">Salir</button>
  `;
  $('#btnLogoutDrawer').addEventListener('click', logout);
}

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

async function bootApp() {
  destroyCharts();
  async function attempt() {
    const [, , bienvenida] = await Promise.all([
      refreshClientList(),
      refreshProjectList(),
      api('/bienvenida').catch(() => []),
    ]);
    showClientGallery();
    renderGalleryGreeting();
    renderClientGallery();
    renderBienvenidaSummary(bienvenida);
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
    applySession(data.user, data.tabs);
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
  showLoginScreen();
}

$('#btnLogout').addEventListener('click', logout);

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
    state.token = data.token;
    localStorage.setItem(TOKEN_KEY, data.token);
    applySession(data.user, data.tabs);
    $('#loginPassword').value = '';
    await bootApp();
    if (data.must_change_password) {
      setTimeout(() => openMiCuentaModal(true), 400);
    }
  } catch (err) {
    errBox.textContent = err.message;
    errBox.style.display = '';
  } finally {
    btn.disabled = false; btn.textContent = 'Entrar';
  }
});

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
  $('#modalOverlay').classList.remove('show');
  $('#modal').innerHTML = '';
  document.body.classList.remove('modal-open');
}
$('#modalOverlay').addEventListener('click', closeModal);

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
$('#btnVolverClientes').addEventListener('click', async () => {
  closeDrawer();
  state.clienteId = null;
  state.projectId = null;
  try {
    const [, bienvenida] = await Promise.all([
      refreshClientList(),
      api('/bienvenida').catch(() => []),
    ]);
    showClientGallery();
    renderGalleryGreeting();
    renderClientGallery();
    renderBienvenidaSummary(bienvenida);
  } catch (err) {
    toast(err.message, 'danger');
    showClientGallery();
    renderGalleryGreeting();
    renderClientGallery();
  }
});

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
  list.innerHTML = projects.map((p) => `
    <div class="project-item ${p.id === state.projectId ? 'active' : ''}" data-id="${p.id}">
      <span class="pname">${esc(p.nombre)}</span>
      <span class="pmeta">${esc(p.lugar || '')}${p.lugar ? ' · ' : ''}${fmtMoney(p.total_sin_iva)}</span>
      <span class="pmeta">${fmtDate(p.inicio_obra)} → ${fmtDate(p.fin_obra)}</span>
      ${isAdmin() ? `<div class="pactions"><button class="btn small" data-cambiar-cliente="${p.id}">Cambiar cliente</button><button class="btn small btn-danger" data-del="${p.id}">Eliminar</button></div>` : ''}
    </div>
  `).join('');

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
      const proj = state.projects.find((p) => p.id === id);
      if (!confirm(`¿Eliminar el presupuesto "${proj.nombre}" y su base de datos? Esta acción no se puede deshacer.`)) return;
      await api(`/projects/${id}`, { method: 'DELETE' });
      delete state.cache[id];
      if (state.projectId === id) state.projectId = null;
      await refreshProjectList();
      const remaining = visibleProjects();
      if (!state.projectId && remaining[0]) selectProject(remaining[0].id);
      else if (!remaining.length) renderView();
      toast('Presupuesto eliminado', 'success');
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
  state.projectId = id;
  state.cache[id] = state.cache[id] || {};
  const p = state.projects.find((x) => x.id === id);
  $('#projectName').textContent = p ? p.nombre : '';
  const sn = $('#sidebarProjectName'); if (sn) sn.textContent = p ? p.nombre : 'Sin presupuesto';
  state.view = targetView || (state.allowedTabs.length <= 1 ? (state.allowedTabs[0] || 'inicio') : 'inicio');
  state.section = VIEW_TO_SECTION[state.view] || null;
  renderProjectList();
  renderTabsBar();
  renderSidebar();
  renderMobileNav();
  replaceTabHistory();
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

function renderClientGallery() {
  const grid = $('#clienteGrid');
  // Proyectos sin cliente_id: solo pueden existir de cargas hechas antes de que
  // cliente_id fuera obligatorio (ver PUT /projects/:id/cliente). Solo admin
  // los ve, como una tarjeta especial, para poder reasignarlos.
  const huerfanos = state.projects.filter((p) => p.cliente_id == null);
  let html = state.clientes.map((c) => `
    <div class="cliente-card" data-cliente="${c.id}">
      <span class="cliente-icon">🏢</span>
      <span class="cliente-nombre">${esc(c.nombre)}</span>
      <span class="cliente-count">${c.num_proyectos} presupuesto${c.num_proyectos !== 1 ? 's' : ''}</span>
    </div>
  `).join('');
  if (isAdmin() && huerfanos.length) {
    html += `
      <div class="cliente-card cliente-card-orphan" data-cliente="sin-cliente">
        <span class="cliente-icon">⚠️</span>
        <span class="cliente-nombre">Sin cliente asignado</span>
        <span class="cliente-count">${huerfanos.length} presupuesto${huerfanos.length !== 1 ? 's' : ''}</span>
      </div>`;
  }
  grid.innerHTML = html || `<div class="empty-state"><div class="big">🏢</div>Aún no hay clientes registrados.</div>`;
  $$('.cliente-card', grid).forEach((el) => {
    el.addEventListener('click', () => selectCliente(el.dataset.cliente === 'sin-cliente' ? 'sin-cliente' : Number(el.dataset.cliente)));
  });
  $('#btnNuevoClienteGallery').style.display = isAdmin() ? '' : 'none';
  $('#btnCargarContratoGallery').style.display = isAdmin() ? '' : 'none';
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
    const totalFmt = p.presupuesto_total ? fmtMoney(p.presupuesto_total) : '—';
    return `
      <div class="welcome-project-card bienvenida-proj-card" data-pid="${p.id}" data-cid="${p.cliente_id != null ? p.cliente_id : ''}">
        ${p.cliente_nombre ? `<div class="wpc-client">${esc(p.cliente_nombre)}</div>` : ''}
        <div class="wpc-nombre">${esc(p.nombre)}</div>
        <div class="wpc-progress-bar"><div class="wpc-progress-fill" style="width:${pct}%"></div></div>
        <div class="wpc-stats">
          <span class="wpc-pct">${pct.toFixed(1)}% ejecutado</span>
          <span class="wpc-total">${totalFmt}</span>
        </div>
      </div>`;
  }).join('');

  el.innerHTML = `<div class="bienvenida-summary">
    <div class="bienvenida-summary-title">Mayor avance</div>
    <div class="bienvenida-client-grid">${cardsHtml}</div>
  </div>`;

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

async function selectCliente(id) {
  state.clienteId = id;
  state.projectId = null;
  showApp();
  if (id === 'sin-cliente') {
    $('#projectName').textContent = 'Sin cliente asignado — elige un presupuesto';
  } else {
    const cliente = state.clientes.find((c) => c.id === id);
    $('#projectName').textContent = cliente ? `${cliente.nombre} — elige un presupuesto` : '';
  }
  renderView();
  renderProjectList();
  // Navegar al último proyecto visitado si existe
  if (typeof id === 'number') {
    try {
      const data = await api(`/ultima-visita/${id}`);
      if (data && data.proyecto_id) {
        const exists = state.projects.find((p) => p.id === data.proyecto_id && p.cliente_id === id);
        if (exists) { selectProject(data.proyecto_id); return; }
      }
    } catch (_) { /* no bloquea la navegación */ }
  }
  // Sin historial: el usuario ve el estado vacío y puede abrir el drawer manualmente
}

$('#btnGalleryLogout').addEventListener('click', logout);
$('#btnNuevoClienteGallery').addEventListener('click', openNuevoClienteModal);

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
          <div class="wpc-progress-bar"><div class="wpc-progress-fill" style="width:${pct}%"></div></div>
          <div class="wpc-stats">
            <span class="wpc-pct">${pct.toFixed(1)}% ejecutado</span>
            <span class="wpc-total">${totalFmt}</span>
          </div>
        </div>`;
    }).join('');

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
    <div class="field" id="uploadNuevoClienteField" style="display:none">
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
    const nowShowing = field.style.display === 'none';
    field.style.display = nowShowing ? '' : 'none';
    $('#uploadClienteSelect').disabled = nowShowing;
    $('#btnToggleNuevoCliente').textContent = nowShowing ? 'Usar cliente existente' : '+ Crear cliente nuevo';
  });
  $('#btnContinuarUpload').addEventListener('click', async () => {
    const btn = $('#btnContinuarUpload');
    const creatingNew = $('#uploadNuevoClienteField').style.display !== 'none';
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

$('#fileInput').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  if (!/\.xlsx$/i.test(file.name)) { toast('Solo se admiten archivos .xlsx', 'danger'); return; }
  const clienteId = state.pendingUploadClienteId;
  state.pendingUploadClienteId = null;
  if (!clienteId) { toast('Selecciona un cliente antes de subir el archivo', 'danger'); return; }

  openModal(`
    <h3>Cargando presupuesto…</h3>
    <p class="muted">Analizando "${esc(file.name)}" y generando una base de datos independiente para este presupuesto.</p>
    <div class="spinner"></div>
  `);
  try {
    // Sube directo a Vercel Blob desde el navegador (bypassa el límite de
    // tamaño de body de la función serverless — ver Prompts_mod1.md Tarea 1).
    const blob = await VercelBlobClient.upload(file.name, file, {
      access: 'private',
      handleUploadUrl: '/api/projects/upload-token',
      headers: state.token ? { Authorization: `Bearer ${state.token}` } : {},
    });
    const result = await api('/projects', {
      method: 'POST',
      body: { cliente_id: clienteId, archivo_url: blob.url, archivo_nombre: file.name },
    });
    state.clienteId = clienteId;
    await Promise.all([refreshClientList(), refreshProjectList()]);
    showApp();
    selectProject(result.id);
    closeDrawer();
    openPostUploadModal(result);
  } catch (err) {
    closeModal();
    toast(err.message, 'danger');
  }
});

function destroyCharts() {
  Object.values(state.charts).forEach((c) => c && c.destroy());
  state.charts = {};
}

async function renderView() {
  destroyCharts();
  const view = $('#view');
  if (state.view === 'usuarios' || state.view === 'proveedores') {
    try {
      if (state.view === 'usuarios') await renderUsuarios(view);
      else await renderProveedores(view);
    } catch (err) { view.innerHTML = `<div class="alert-box danger">⚠️ ${esc(err.message)}</div>`; }
    syncFab();
    return;
  }
  if (!state.projectId) {
    view.innerHTML = `
      <div class="empty-state">
        <div class="big">🏗️</div>
        <p>No hay un presupuesto seleccionado.</p>
        <p>Carga un archivo Excel de presupuesto (.xlsx) y la app generará automáticamente su catálogo de insumos, alertas de requisición, avances y programa de ejecución — con su propia base de datos independiente.</p>
        ${state.user && state.user.puesto === 'admin' ? '<button class="btn btn-primary" id="emptyUploadBtn">+ Cargar presupuesto</button>' : ''}
      </div>`;
    $('#emptyUploadBtn')?.addEventListener('click', promptUpload);
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
      case 'mapeo': await renderMapeo(view); break;
      case 'trabajadores': await renderTrabajadores(view); break;
      case 'nominas': await renderNominas(view); break;
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
          <span class="section-icon" style="font-size:1.6em">${def.emoji}</span>
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
      <div class="card">
        <div class="card-row"><span class="k">Obra</span><span class="v">${esc(m.obra || '—')}</span></div>
        <div class="card-row"><span class="k">Lugar</span><span class="v">${esc(m.lugar || '—')}</span></div>
        <div class="card-row"><span class="k">Inicio de obra</span><span class="v">${fmtDate(m.inicio_obra)}</span></div>
        <div class="card-row"><span class="k">Fin de obra</span><span class="v">${fmtDate(m.fin_obra)}</span></div>
        <div class="card-row"><span class="k">Total sin IVA</span><span class="v">${fmtMoney(resumen.presupuesto_total)}</span></div>
        ${m.total_con_iva ? `<div class="card-row"><span class="k">Total con IVA</span><span class="v">${fmtMoney(m.total_con_iva)}</span></div>` : ''}
        <div class="row end" style="margin-top:10px"><button class="btn small" id="btnEditFechasObra">Corregir inicio/fin de obra</button></div>
        <p class="muted" style="font-size:0.74rem;margin-top:6px">Úsalo si el archivo traía esas fechas vacías o incorrectas — al guardar se regenera todo el Programa y la curva de Avance con las fechas correctas.</p>
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
          backgroundColor: ['#22c55e', '#eab308', '#334155'],
          borderColor: '#1e293b',
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { color: cc.text, boxWidth: 14, font: { size: 11 } } },
          tooltip: { callbacks: { label: (c) => `${c.label}: ${fmtMoney(c.raw)}` } },
        },
      },
    });
    $('#btnEditFechasObra').addEventListener('click', () => openEditFechasObraModal(m));
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
$('#btnCargarContratoGallery').addEventListener('click', promptUploadContrato);

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

  const clienteHtml = ctx.mode === 'create'
    ? `<div class="field"><label>Cliente</label>
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
    } else {
      body.project_id = ctx.projectId;
    }
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
    <div class="card">
      ${CONTRATO_FIELDS.map((f) => {
        const badge = f.key === 'fecha_termino' ? vencimientoBadgeHtml(campos.fecha_termino) : '';
        return `<div class="card-row"><span class="k">${esc(f.label)}</span><span class="v">${formatContratoValor(f, campos[f.key])}${badge}</span></div>`;
      }).join('')}
    </div>
    ${isAdmin() ? '<div class="row end" style="margin-top:10px"><button class="btn" id="btnEditarContrato">Editar</button></div>' : ''}
  `;
  $('#btnEditarContrato')?.addEventListener('click', () => {
    openContratoFormModal({ escaneado: false, campos }, { mode: 'attach', projectId: state.projectId });
  });
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
      <div class="progress-bar ${over ? 'over' : ''}"><span style="width:${Math.min(100, pct)}%"></span></div>
      ${isAdmin() ? `
      <div class="row between" style="margin-top:6px">
        <span class="muted" style="font-size:0.78rem">IVA aplicable</span>
        <span style="display:flex;align-items:center;gap:4px">
          <input type="number" min="0" max="100" step="0.01" value="${i.iva_tasa}" data-iva-input="${i.id}" style="width:64px;text-align:right" />
          <span class="muted" style="font-size:0.78rem">%</span>
        </span>
      </div>` : ''}
      ${puedeCrearRequisicion() ? `<div class="row end"><button class="btn small btn-primary" data-add="${i.id}">+ Agregar a requisición</button></div>` : ''}
    </div>`;
  }).join('');

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
        <strong>Progreso de mapeo</strong>
        <span class="badge ${resumen.conceptos_mapeados === resumen.total_conceptos ? 'green' : 'yellow'}">${resumen.conceptos_mapeados}/${resumen.total_conceptos} conceptos mapeados</span>
      </div>
      <div class="progress-bar"><span style="width:${Math.min(100, pct)}%"></span></div>
    </div>
    <div class="card">
      <label>Concepto</label>
      <select id="mapeoConceptoSelect">
        ${conceptosReales.map((c) => `<option value="${c.id}" ${c.id === mapeoSelectedConceptoId ? 'selected' : ''}>${mapeadosSet.has(c.id) ? '✅' : '⬜'} ${esc(c.codigo || '')} — ${esc(c.concepto)}</option>`).join('')}
      </select>
    </div>
    <div class="card">
      <strong>Insumos vinculados</strong>
      <div id="mapeoLinkedList" style="margin-top:8px">
        <div class="spinner"></div>
      </div>
    </div>
    <div class="card">
      <strong>Vincular un insumo</strong>
      <div class="search-bar" style="margin-top:8px">
        <input type="search" id="mapeoInsumoSearch" placeholder="Buscar insumo por código o nombre…" />
      </div>
      <div id="mapeoSearchResults"></div>
    </div>
  `;

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
      <div class="row between" style="padding:6px 0;border-bottom:1px solid var(--border)">
        <div>
          <div>${esc(i.concepto)}</div>
          <div class="muted" style="font-size:0.78rem">${esc(i.codigo)} · ${esc(i.unidad || '')}</div>
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
    <h2 class="section-title">Requisiciones de compra</h2>
    ${draft.length ? `
      <div class="card">
        <div class="row between"><strong>Borrador en curso</strong><span class="badge muted">${draft.length} insumo${draft.length === 1 ? '' : 's'}</span></div>
        <p class="muted">Insumos agregados desde el catálogo, listos para convertirse en una requisición.</p>
        <div class="row end"><button class="btn btn-primary" id="btnOpenDraft">Revisar y crear requisición</button></div>
      </div>` : ''}
    <div class="section-actions">
      <button class="btn" id="btnGoCatalogo">+ Agregar insumos desde el catálogo</button>
      <button class="btn" id="btnExportRequisiciones">⭳ Exportar a Excel</button>
    </div>
    <div id="reqList"></div>
  `;
  $('#btnGoCatalogo').addEventListener('click', () => switchToView('insumos'));
  wireExportButton('#btnExportRequisiciones', `/projects/${state.projectId}/requisiciones/export`);
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
            <div style="font-weight:600;font-size:0.88rem">${esc(i.concepto)}</div>
            <div class="code muted">${esc(i.codigo)} · presup: ${fmtNum(i.cantidad_presupuesto, 3)} ${esc(i.unidad || '')} a ${fmtMoney(i.precio_presupuesto)}</div>
          </div>
          <button class="btn small btn-ghost" data-remove="${idx}">✕</button>
        </div>
        <div class="qty-row">
          <div><label>Cantidad</label><input type="number" min="0" step="any" data-field="cantidad_solicitada" data-idx="${idx}" value="${d.cantidad_solicitada}" /></div>
          <div><label>Precio unitario</label><input type="number" min="0" step="any" data-field="precio_solicitado" data-idx="${idx}" value="${d.precio_solicitado}" /></div>
          <div class="muted" style="font-size:0.78rem;text-align:right">= ${fmtMoney(d.cantidad_solicitada * d.precio_solicitado)}</div>
        </div>
      </div>`;
    }).join('');

    $$('[data-field]', $('#draftItems')).forEach((inp) => {
      inp.addEventListener('input', () => {
        const idx = Number(inp.dataset.idx);
        draft[idx][inp.dataset.field] = Number(inp.value) || 0;
        schedulePreview();
        // live total update without full repaint
        const totalEl = inp.closest('.req-item-row').querySelector('.qty-row .muted');
        totalEl.textContent = `= ${fmtMoney(draft[idx].cantidad_solicitada * draft[idx].precio_solicitado)}`;
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
      <div class="card" style="margin-top:14px">
        <h4 style="margin:0 0 4px;font-size:0.9rem">Estado de la requisición</h4>
        <p class="muted" style="font-size:0.78rem;margin:0 0 10px">${puedeAutorizarRequisicion() ? 'Cambia el estado para avanzar el flujo de compra: envíala, autorízala (necesario para generar una Orden de Compra) o cancélala.' : 'Envía la requisición para que sea autorizada. Solo Logística o el Administrador pueden autorizar.'}</p>
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
          <div style="font-weight:600;font-size:0.88rem">${esc(it.insumo_concepto)}</div>
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
    if (r.estado === 'borrador') {
      $('#btnEditReq').addEventListener('click', () => openEditRequisicionModal(r));
    }
    if (r.estado === 'autorizada') {
      $('#btnGenerarOC').addEventListener('click', () => openGenerarOrdenModal(r));
    }
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
    $('#btnDeleteReq').addEventListener('click', async () => {
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
      <div id="addInsumoResults" class="project-list" style="gap:6px"></div>
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
            <div style="font-weight:600;font-size:0.88rem">${esc(i.concepto)}</div>
            <div class="code muted">${esc(i.codigo)} · presup: ${fmtNum(i.cantidad_presupuesto, 3)} ${esc(i.unidad || '')} a ${fmtMoney(i.precio_presupuesto)}</div>
          </div>
          <button class="btn small btn-ghost" data-remove="${idx}">✕</button>
        </div>
        <div class="qty-row">
          <div><label>Cantidad</label><input type="number" min="0" step="any" data-field="cantidad_solicitada" data-idx="${idx}" value="${d.cantidad_solicitada}" /></div>
          <div><label>Precio unitario</label><input type="number" min="0" step="any" data-field="precio_solicitado" data-idx="${idx}" value="${d.precio_solicitado}" /></div>
          <div class="muted" style="font-size:0.78rem;text-align:right">= ${fmtMoney(d.cantidad_solicitada * d.precio_solicitado)}</div>
        </div>
      </div>`;
    }).join('');

    $$('[data-field]', box).forEach((inp) => {
      inp.addEventListener('input', () => {
        const idx = Number(inp.dataset.idx);
        items[idx][inp.dataset.field] = Number(inp.value) || 0;
        schedulePreview();
        const totalEl = inp.closest('.req-item-row').querySelector('.qty-row .muted');
        totalEl.textContent = `= ${fmtMoney(items[idx].cantidad_solicitada * items[idx].precio_solicitado)}`;
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
      <label class="muted" style="font-size:0.78rem;margin-bottom:4px;display:block">¿Los precios que capturaste arriba incluyen IVA?</label>
      <div style="display:flex;flex-direction:column;gap:6px">
        <label style="font-weight:400"><input type="radio" name="ocIvaModo" id="ocSinIva" checked style="width:auto;margin-right:6px" /> Los precios que capturé son <strong>SIN IVA</strong> (se sumará el 16% al total)</label>
        <label style="font-weight:400"><input type="radio" name="ocIvaModo" id="ocIncluyeIva" style="width:auto;margin-right:6px" /> Los precios que capturé <strong>YA INCLUYEN IVA</strong> (se desglosará del total)</label>
      </div>
    </div>
    <div class="card" id="ocIvaResumen" style="background:var(--panel-2)">
      <div class="card-row"><span class="k">Subtotal</span><span class="v" id="ocSubtotalOut">—</span></div>
      <div class="card-row"><span class="k">IVA</span><span class="v" id="ocIvaOut">—</span></div>
      <div class="card-row"><span class="k">Total</span><span class="v" id="ocTotalOut" style="font-weight:700">—</span></div>
    </div>
    <div class="field"><label>Observaciones</label><textarea id="ocObs" rows="2" placeholder="Notas para esta orden…"></textarea></div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelOC">Cerrar</button>
      <button class="btn btn-primary" id="btnSaveOC">Crear orden de compra</button>
    </div>
  `);

  $('#ocItems').innerHTML = requisicion.items.map((it) => `
    <div class="req-item-row" data-req-item="${it.id}" data-iva-tasa="${ivaTasaMap.get(it.insumo_id) ?? 16}">
      <div style="font-weight:600;font-size:0.88rem">${esc(it.insumo_concepto)}</div>
      <div class="code muted">${esc(it.insumo_codigo)} · solicitado: ${fmtNum(it.cantidad_solicitada, 3)} ${esc(it.unidad || '')} a ${fmtMoney(it.precio_solicitado)}</div>
      <div class="qty-row">
        <div><label>Cantidad a ordenar</label><input type="number" min="0" step="any" data-oc-cantidad value="${it.cantidad_solicitada}" /></div>
        <div><label>Precio unitario</label><input type="number" min="0" step="any" data-oc-precio value="${it.precio_solicitado}" /></div>
        <div class="muted" data-oc-importe style="font-size:0.78rem;text-align:right">= ${fmtMoney(it.cantidad_solicitada * it.precio_solicitado)}</div>
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
    <h2 class="section-title">Órdenes de Compra</h2>
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
      <div class="row between" style="margin-top:6px;font-size:0.84rem">
        <span class="muted">Pagado: ${fmtMoney(o.total_pagado)}</span>
        <span style="color:${o.saldo_pendiente > 0 ? 'var(--red)' : 'var(--green)'};font-weight:600">Saldo: ${fmtMoney(o.saldo_pendiente)}</span>
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
             ${!puedeConfirmarOC ? '<p class="muted" style="font-size:0.78rem">Solo un Administrador o Tesorería puede confirmar o rechazar la orden.</p>' : ''}
             <select id="ocEstadoSelect">${estados.map((e) => `<option value="${e}" ${e === o.estado ? 'selected' : ''}>${e}</option>`).join('')}</select>`}
      </div>
      <div id="ocItemsDetail"></div>
      <div class="card" style="background:var(--panel-2)">
        <div class="card-row"><span class="k">Los montos capturados</span><span class="v">${o.incluye_iva ? 'incluyen IVA' : 'no incluyen IVA (son sin IVA)'}</span></div>
        <div class="card-row"><span class="k">Subtotal</span><span class="v">${fmtMoney(o.desglose_iva.subtotal)}</span></div>
        <div class="card-row"><span class="k">IVA</span><span class="v">${fmtMoney(o.desglose_iva.iva)}</span></div>
        <div class="card-row"><span class="k">Total</span><span class="v" style="font-weight:700">${fmtMoney(o.desglose_iva.total)}</span></div>
      </div>

      <h3 class="section-title">Recepciones</h3>
      <div id="ocRecepcionesList"><div class="spinner"></div></div>
      ${puedeRecibir ? '<div class="row end" style="margin-top:8px"><button class="btn small btn-primary" id="btnRegistrarRecepcion">Registrar recepción</button></div>' : ''}

      <h3 class="section-title">Pagos</h3>
      <div id="ocPagosList"><div class="spinner"></div></div>
      ${puedeRegistrarPago() && ['enviada', 'confirmada', 'recibida_parcial', 'recibida_completa'].includes(o.estado) ? '<div class="row end" style="margin-top:8px"><button class="btn small btn-primary" id="btnRegistrarPago">Registrar pago</button></div>' : ''}

      <div class="modal-actions">
        ${o.estado === 'borrador' ? '<button class="btn btn-danger" id="btnDeleteOC">Eliminar</button>' : ''}
        <button class="btn" id="btnCloseOC">Cerrar</button>
      </div>
    `);
    $('#ocItemsDetail').innerHTML = o.items.map((it) => `
      <div class="req-item-row">
        <div class="row between">
          <div style="font-weight:600;font-size:0.88rem">${esc(it.insumo_concepto)}</div>
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
      box.innerHTML = '<p class="muted" style="font-size:0.84rem">Aún no se ha recibido material de esta orden.</p>';
      return;
    }
    box.innerHTML = recepciones.map((r) => `
      <div class="req-item-row">
        <div class="row between">
          <strong style="font-size:0.86rem">${fmtDate(r.fecha)}</strong>
          ${r.recibido_por ? `<span class="muted">${esc(r.recibido_por)}</span>` : ''}
        </div>
        ${r.items.map((it) => `
          <div class="row between" style="font-size:0.82rem">
            <span>${esc(it.insumo_concepto)}</span>
            <span>${fmtNum(it.cantidad_recibida, 3)} ${esc(it.unidad || '')}</span>
          </div>`).join('')}
        ${r.observaciones ? `<div class="muted" style="font-size:0.78rem">${esc(r.observaciones)}</div>` : ''}
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
      <div class="row between" style="font-size:0.84rem">
        <span>${fmtDate(p.fecha)} ${p.metodo ? `· ${esc(p.metodo)}` : ''} ${p.referencia ? `· ${esc(p.referencia)}` : ''}
          <span class="muted" style="font-size:0.74rem"> · ${p.incluye_iva ? 'con IVA' : 'sin IVA'}</span></span>
        <span>${fmtMoney(p.monto)}</span>
      </div>`).join('') : '<p class="muted" style="font-size:0.84rem">Sin pagos registrados.</p>';
    box.innerHTML = `
      ${pagosHtml}
      <div class="card-row"><span class="k">Total pagado</span><span class="v">${fmtMoney(data.total_pagado)}</span></div>
      <div class="card-row"><span class="k">Saldo pendiente</span><span class="v" style="color:${data.saldo_pendiente > 0 ? 'var(--red)' : 'var(--green)'}">${fmtMoney(data.saldo_pendiente)}</span></div>
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
      <div style="font-weight:600;font-size:0.88rem">${esc(it.insumo_concepto)}</div>
      <div class="code muted">${esc(it.insumo_codigo)} · ordenado: ${fmtNum(it.cantidad_ordenada, 3)} ${esc(it.unidad || '')} · recibido a la fecha: ${fmtNum(acumulado, 3)} ${esc(it.unidad || '')}</div>
      <div class="qty-row">
        <div><label>Cantidad recibida ahora</label><input type="number" min="0" step="any" data-rec-cantidad data-pendiente="${pendiente}" data-ordenado="${it.cantidad_ordenada}" data-acumulado="${acumulado}" value="0" /></div>
        <div class="muted" data-rec-faltante style="font-size:0.76rem;align-self:end">faltarían: ${fmtNum(pendiente, 3)} ${esc(it.unidad || '')}</div>
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
      <label><input type="checkbox" id="pagoIncluyeIva" checked style="width:auto;margin-right:6px" /> Este monto incluye IVA</label>
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
  const [avances, resumen] = await Promise.all([
    api(`/projects/${state.projectId}/avances`),
    cached('resumen', () => api(`/projects/${state.projectId}/resumen`)),
  ]);
  if (!avances.length) {
    view.innerHTML = `<div class="empty-state"><div class="big">📅</div>No fue posible generar la curva de avance: el presupuesto no contiene fechas de inicio y fin de obra.</div>`;
    return;
  }
  const presupuestoTotal = resumen.presupuesto_total || 0;
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
  paintAvanceTable(avances, presupuestoTotal);
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
      scales: {
        x: { stacked: false, ticks: { color: cc.tick, maxRotation: 0, autoSkip: true, font: { size: 10 } }, grid: { display: false } },
        y: { min: 0, max: 100, ticks: { color: cc.tick, callback: (v) => `${v}%` }, grid: { color: cc.grid } },
      },
      plugins: { legend: { position: 'bottom', labels: { color: cc.text, boxWidth: 14, font: { size: 11 } } } },
    },
  });
}

function paintAvanceTable(avances, presupuestoTotal) {
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
      ${puedeVerImportesAvance() ? `<td class="num">${fmtMoney(importePeriodo)}<br><span class="muted" style="font-size:0.7rem">(${fmtPct(pctPeriodo)} del total)</span></td>` : '<td class="num">—</td>'}
      <td class="num">${fmtPct(a.avance_financiero_programado)}</td>
      <td class="num"><input type="number" min="0" max="100" step="0.1" data-field="avance_fisico_real" value="${a.avance_fisico_real ?? ''}" style="width:84px;text-align:right" ${!puedeEditarAvance() ? 'disabled' : ''} /></td>
      <td class="num">${puedeVerImportesAvance() ? `<input type="number" min="0" max="100" step="0.1" data-field="avance_financiero_real" value="${a.avance_financiero_real ?? ''}" style="width:84px;text-align:right" ${!puedeEditarAvance() ? 'disabled' : ''} />` : '—'}</td>
      <td>
        <span class="badge ${autBadge}">${autLabel}</span>
        ${isAdmin() && estadoAut === 'pendiente_autorizacion' ? `
        <div class="row" style="flex-wrap:nowrap;gap:4px;margin-top:4px">
          <button class="btn small btn-auth" data-autorizar="${a.semana}" data-accion="autorizado">Autorizar</button>
          <button class="btn small btn-danger btn-auth" data-autorizar="${a.semana}" data-accion="rechazado">Rechazar</button>
        </div>` : ''}
      </td>
      <td>
        ${puedeEditarAvance() ? `<div class="row" style="flex-wrap:nowrap;gap:6px">
          <button class="btn small" data-detalle="${a.semana}" title="Capturar avance por concepto">Por concepto</button>
          <button class="btn small btn-primary" data-save="${a.semana}">Guardar</button>
        </div>` : ''}
      </td>
    </tr>
  `;
  }).join('');

  $$('[data-detalle]', tbody).forEach((btn) => {
    btn.addEventListener('click', () => {
      const semana = Number(btn.dataset.detalle);
      const avance = avances.find((a) => a.semana === semana);
      if (avance) openAvanceConceptosModal(avance, presupuestoTotal);
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
async function openAvanceConceptosModal(avance, presupuestoTotal) {
  const semana = avance.semana;
  openModal(`
    <h3>Avance físico por concepto — Semana ${semana}</h3>
    <p class="muted">${fmtDate(avance.fecha_inicio)} – ${fmtDate(avance.fecha_fin)}<br>
      Anota la cantidad realmente ejecutada de cada concepto del catálogo durante este periodo
      (no acumulada — solo lo avanzado en esta semana). El % de avance real se calculará
      automáticamente a partir de estas cantidades y se guardará en la tabla semanal.</p>
    <div id="avcList"><div class="spinner"></div></div>
    <div class="card" id="avcSummary" style="display:none">
      <div class="card-row"><span class="k">Importe ejecutado acumulado a la fecha</span><span class="v" id="avcImporte">—</span></div>
      <div class="card-row"><span class="k">% de avance real (se guardará así)</span><span class="v" id="avcPct">—</span></div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelAvc">Cerrar</button>
      <button class="btn btn-primary" id="btnSaveAvc">Guardar avance</button>
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
    <h3 class="section-title" style="margin:14px 0 8px">${esc(grupo)}</h3>
    ${groupItems.map((c) => `
    <div class="req-item-row">
      <div style="font-weight:600;font-size:0.86rem">${esc(c.concepto)}</div>
      <div class="code muted">${esc(c.codigo)} · presup: ${fmtNum(c.cantidad_presupuesto, 3)} ${esc(c.unidad || '')} a ${fmtMoney(c.precio_unitario)}/u</div>
      <div class="qty-row" style="margin-top:6px">
        <div>
          <label>Acumulado previo</label>
          <div class="muted" style="font-size:0.84rem;padding:10px 0">${fmtNum(c.cantidad_acumulada_previa, 3)} ${esc(c.unidad || '')}</div>
        </div>
        <div>
          <label>Ejecutado este periodo</label>
          <input type="number" min="0" step="0.01" data-cantidad="${c.concepto_id}"
                 data-precio="${c.precio_unitario}" data-presup="${c.cantidad_presupuesto}" data-prev="${c.cantidad_acumulada_previa}"
                 value="${c.cantidad_ejecutada_periodo ?? ''}" />
        </div>
        <div class="muted" data-acum-out style="font-size:0.74rem;text-align:right;align-self:end;line-height:1.3"></div>
      </div>
    </div>
    `).join('')}
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

  $('#avcSummary').style.display = '';
  recalc();
  $$('[data-cantidad]').forEach((inp) => inp.addEventListener('input', recalc));

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
      toast(pct != null ? `Avance de la semana ${semana} guardado: ${fmtPct(pct)} calculado` : `Avance por concepto de la semana ${semana} guardado`, 'success');
      renderView();
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false; btn.textContent = 'Guardar avance';
    }
  });
}

// =========================================================================
// VISTA: Programa de ejecución (Gantt simple)
// =========================================================================
async function renderPrograma(view) {
  const [programa, resumen] = await Promise.all([
    api(`/projects/${state.projectId}/programa`),
    cached('resumen', () => api(`/projects/${state.projectId}/resumen`)),
  ]);
  if (!programa.length) {
    view.innerHTML = `<div class="empty-state"><div class="big">🗓️</div>No fue posible generar el programa de ejecución: el presupuesto no contiene fechas de inicio y fin de obra, o no tiene conceptos con cantidades.</div>`;
    return;
  }
  const obraInicio = resumen.meta?.inicio_obra || null;
  const obraFin = resumen.meta?.fin_obra || null;
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
              <div class="gantt-bar" style="left:${left}%;width:${width}%">
                ${pct > 0 ? `<div class="gantt-bar-inner" style="width:${Math.min(100, pct)}%"></div>` : ''}
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
    ${obraInicio && obraFin ? `<p class="muted" style="font-size:0.76rem">El periodo de obra cargado del presupuesto va del ${fmtDate(obraInicio)} al ${fmtDate(obraFin)} — las fechas de la actividad deben quedar dentro de ese rango.</p>` : ''}
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

  view.innerHTML = `
    <h2 class="section-title">Control de Destajo</h2>
    <p class="muted">El avance de cada destajista se captura por semana, usando los mismos periodos del programa de obra — igual que en la pestaña Avance.</p>
    ${destajistas.length ? `
    <div class="kpi-grid" style="margin-bottom:4px">
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
    ` : destajistas.map((d) => renderDestajistaCard(d)).join('')}
  `;

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
    btn.addEventListener('click', () => openAgregarItemModal(Number(btn.dataset.addItem), destajistas));
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

function renderDestajistaCard(d) {
  const pct = Math.round(d.pct_avance || 0);
  return `
  <div class="card" style="margin-bottom:12px" data-dest-card="${d.id}">
    <div class="row between">
      <div>
        <strong style="font-size:1rem">${esc(d.nombre)}</strong>
        ${d.telefono ? `<div class="muted" style="font-size:0.8rem">📞 ${esc(d.telefono)}</div>` : ''}
      </div>
      ${canManageDestajo() ? `
      <div class="row" style="gap:6px;flex-wrap:nowrap">
        <button class="btn small" data-edit-dest="${d.id}" title="Editar destajista">✏️ Editar</button>
        <button class="btn small btn-danger" data-del-dest="${d.id}">Eliminar</button>
      </div>` : ''}
    </div>
    <div class="row" style="gap:14px;margin:6px 0;flex-wrap:wrap;font-size:0.84rem">
      <span class="muted">${d.items.length} actividad${d.items.length !== 1 ? 'es' : ''}</span>
      <span>Asig: ${fmtMoney(d.total_asignado)}</span>
      <span style="color:var(--green)">Ganado: ${fmtMoney(d.total_ganado)}</span>
      <span class="badge ${pct >= 100 ? 'green' : 'yellow'}">${pct}%</span>
    </div>
    <div class="progress-bar" style="margin-bottom:8px"><span style="width:${Math.min(100, pct)}%"></span></div>
    ${renderDestajistaItems(d)}
    ${canManageDestajo() ? `
    <div class="row" style="margin-top:8px">
      <button class="btn small" data-add-item="${d.id}">+ Agregar actividad</button>
    </div>` : ''}
    <button class="collapse-toggle" style="margin-top:12px" data-toggle-semanal="${d.id}">
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
      body.innerHTML = `
        <div style="padding:10px 4px">
          <p class="muted" style="margin:0 0 8px">El proyecto no tiene periodos de programa de obra generados (faltan las fechas de inicio/fin de obra).</p>
          <button class="btn small btn-primary" id="btnFixFechasObra${destId}">Corregir inicio/fin de obra</button>
        </div>`;
      $(`#btnFixFechasObra${destId}`, body).addEventListener('click', async () => {
        const resumen = await cached('resumen', () => api(`/projects/${state.projectId}/resumen`));
        openEditFechasObraModal(resumen.meta);
      });
      return;
    }
    const dest = destajistas.find((d) => d.id === destId);
    body.innerHTML = `
      <div class="card" style="margin:10px 0 0;background:var(--panel-2)">
        <div class="chart-wrap" style="height:220px"><canvas id="chartDestajo${destId}"></canvas></div>
      </div>
      <div class="table-scroll" style="margin-top:8px">
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
      scales: {
        x: { ticks: { color: '#94a3b8', maxRotation: 0, autoSkip: true, font: { size: 10 } }, grid: { color: '#334155' } },
        y: { min: 0, max: 100, ticks: { color: '#94a3b8', callback: (v) => `${v}%` }, grid: { color: '#334155' } },
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
        <div class="row" style="flex-wrap:nowrap;gap:4px;margin-top:4px">
          <button class="btn small btn-auth" data-autorizar-dest="${s.semana}" data-dest-id="${destId}" data-accion="autorizado">Autorizar</button>
          <button class="btn small btn-danger btn-auth" data-autorizar-dest="${s.semana}" data-dest-id="${destId}" data-accion="rechazado">Rechazar</button>
        </div>` : ''}
        <div style="margin-top:4px"><button class="btn small btn-primary" data-capturar-semana="${s.semana}" data-dest-id="${destId}">Capturar</button></div>
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
    <div class="card" id="destAvcSummary" style="display:none">
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
  const soloLecturaParaMi = (it) => ['cabo', 'administracion'].includes(state.user.puesto) && yaCapturado(it);

  $('#destAvcList').innerHTML = items.map((it) => `
    <div class="req-item-row">
      <div style="font-weight:600;font-size:0.86rem">${esc(it.concepto)}</div>
      <div class="code muted">${esc(it.codigo || '')} · asig: ${fmtNum(it.cantidad_asignada, 3)} ${esc(it.unidad || '')} a ${fmtMoney(it.precio_destajo)}/u</div>
      <div class="qty-row" style="margin-top:6px">
        <div>
          <label>Acumulado previo</label>
          <div class="muted" style="font-size:0.84rem;padding:10px 0">${fmtNum(it.cantidad_acumulada_previa, 3)} ${esc(it.unidad || '')}</div>
        </div>
        <div>
          <label>Ejecutado este periodo</label>
          <input type="number" min="0" step="0.01" data-destajo-cantidad="${it.destajo_item_id}"
                 data-precio="${it.precio_destajo}" data-prev="${it.cantidad_acumulada_previa}"
                 value="${it.cantidad_ejecutada_periodo ?? ''}" ${soloLecturaParaMi(it) ? 'disabled title="Solo un residente o administrador puede editar un avance ya capturado"' : ''} />
        </div>
        <div class="muted" data-acum-out style="font-size:0.74rem;text-align:right;align-self:end;line-height:1.3"></div>
      </div>
      ${soloLecturaParaMi(it) ? `<div class="muted" style="font-size:0.72rem;color:var(--yellow);margin-top:2px">🔒 Ya capturado — solo residente/admin puede editarlo</div>` : ''}
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

function renderDestajistaItems(d) {
  if (!d.items.length) {
    return `<p class="muted" style="font-size:0.82rem;margin:4px 0 0">Sin actividades asignadas aún.</p>`;
  }
  const canManage = canManageDestajo();
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
              <div style="font-size:0.84rem;font-weight:600">${esc(it.concepto)}</div>
              ${it.codigo ? `<div class="code muted">${esc(it.codigo)}</div>` : ''}
              ${it.unidad ? `<div class="muted" style="font-size:0.72rem">${esc(it.unidad)}</div>` : ''}
              ${it.concepto_id ? `
                <div class="badge muted" style="margin-top:4px;font-size:0.68rem">📋 Partida: ${esc(it.partida_grupo || 'Sin grupo')}</div>
              ` : `
                <div class="muted" style="margin-top:4px;font-size:0.68rem;font-style:italic">Actividad manual — sin partida del presupuesto</div>
              `}
            </td>
            <td class="num">
              ${canManage ? `
              <input type="number" min="0" step="0.01" style="width:72px;text-align:right"
                value="${it.cantidad_asignada}"
                data-save-item data-item-id="${it.id}" data-dest-id="${d.id}" data-field="cantidad_asignada" />
              ` : fmtNum(it.cantidad_asignada, 2)}
            </td>
            <td class="num">
              ${canManage ? `
              <input type="number" min="0" step="0.01" style="width:80px;text-align:right"
                value="${it.precio_destajo}"
                data-save-item data-item-id="${it.id}" data-dest-id="${d.id}" data-field="precio_destajo" />
              ` : fmtMoney(it.precio_destajo)}
            </td>
            <td class="num">${fmtNum(it.cantidad_ejecutada, 2)} ${esc(it.unidad || '')}</td>
            <td class="num" style="color:var(--green)">${fmtMoney(it.cantidad_ejecutada * it.precio_destajo)}</td>
            ${canManage ? `
            <td>
              <button class="btn small btn-ghost" data-del-item data-item-id="${it.id}" data-dest-id="${d.id}" title="Eliminar">✕</button>
            </td>` : ''}
          </tr>`).join('')}
          <tr style="font-weight:600;border-top:1px solid var(--border)">
            <td colspan="4" style="text-align:right;color:var(--muted);padding-right:8px">Total ganado:</td>
            <td class="num" style="color:var(--green)">${fmtMoney(d.total_ganado)}</td>
            ${canManage ? '<td></td>' : ''}
          </tr>
        </tbody>
      </table>
    </div>
    <p class="muted" style="font-size:0.72rem;margin:6px 0 0">El acumulado ejecutado se registra con "Capturar" en el avance semanal de abajo — igual que en la pestaña Avance.</p>`;
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

async function openAgregarItemModal(destId, destajistas) {
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
      <div id="resultadosConcepto" class="project-list search-results-fancy" style="max-height:160px;overflow-y:auto;gap:4px;margin-top:6px"></div>
    </div>
    <div class="field"><label>Concepto *</label><input id="itemConcepto" placeholder="Ej. Excavación en tierra" /></div>
    <div class="row" style="gap:8px">
      <div class="field" style="flex:1"><label>Código</label><input id="itemCodigo" /></div>
      <div class="field" style="flex:1"><label>Unidad</label><input id="itemUnidad" placeholder="M2, ML…" /></div>
    </div>
    <div class="row" style="gap:8px">
      <div class="field" style="flex:1"><label>Cantidad asignada</label><input id="itemCant" type="number" min="0" step="any" /></div>
      <div class="field" style="flex:1"><label>P.U. destajo ($)</label><input id="itemPU" type="number" min="0" step="any" /></div>
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
      <div class="project-item search-result-item" data-pick="${c.id}" style="cursor:pointer">
        <span class="pname">${esc(c.concepto)}</span>
        <span class="pmeta">${esc(c.codigo || '')} · ${esc(c.unidad || '')} · ${fmtNum(c.cantidad, 2)} · ${fmtMoney(c.precio_unitario)}/u</span>
        <span class="pmeta">📋 Partida: ${esc(c.grupo || 'Sin grupo')}</span>
      </div>`).join('') || `<p class="muted" style="padding:6px">Sin resultados para "${esc(q)}"</p>`;

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
          precio_destajo: Number($('#itemPU').value) || 0,
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
    <p class="muted"><strong>${esc(result.nombre)}</strong> — ${result.conceptos} conceptos, ${result.insumos} insumos${destMsg}</p>
    <div style="border-top:1px solid var(--border);margin:14px 0;padding-top:14px">
      <h4 style="margin:0 0 6px">Fechas de obra detectadas</h4>
      <p class="muted" style="font-size:0.78rem;margin-bottom:10px">Verifica las fechas del archivo. Si no aparecen o son incorrectas, corrígelas aquí — el Programa de ejecución se regenerará automáticamente.</p>
      <div class="field"><label>Inicio de obra</label><input id="postUploadInicio" type="date" value="${esc(inicio)}" /></div>
      <div class="field"><label>Fin de obra</label><input id="postUploadFin" type="date" value="${esc(fin)}" /></div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="btnSkipFechasPost">Omitir</button>
      <button class="btn btn-primary" id="btnGuardarFechasPost">Guardar fechas</button>
    </div>
  `);

  $('#btnSkipFechasPost').addEventListener('click', () => {
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
      await api(`/projects/${result.id}/fechas-obra`, { method: 'PUT', body: { inicio_obra, fin_obra } });
      closeModal();
      invalidate('resumen');
      toast(`"${result.nombre}" cargado con fechas configuradas`, 'success');
      renderView();
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false; btn.textContent = 'Guardar fechas';
    }
  });
}

// =========================================================================
// MI CUENTA — autogestión: cambio de nombre, usuario y contraseña
// =========================================================================
async function openMiCuentaModal(mustChange) {
  openModal(`
    <h3>Mi cuenta</h3>
    ${mustChange ? `<div class="alert-box warning" style="margin-bottom:12px">⚠️ Debes cambiar tu contraseña antes de continuar.</div>` : ''}
    <div class="field"><label>Nombre completo</label><input id="mcNombre" value="${esc(state.user?.nombre || '')}" /></div>
    <div class="field"><label>Usuario (login)</label><input id="mcUsuario" value="${esc(state.user?.usuario || '')}" autocomplete="username" /></div>
    <hr style="margin:14px 0;opacity:.2">
    <p class="muted" style="font-size:0.8rem;margin:0 0 10px">Deja los campos de contraseña vacíos si no quieres cambiarla.</p>
    <div class="field"><label>Contraseña actual</label><input id="mcPwActual" type="password" autocomplete="current-password" /></div>
    <div class="field"><label>Contraseña nueva</label><input id="mcPwNueva" type="password" autocomplete="new-password" placeholder="Mínimo 6 caracteres" /></div>
    <div class="field"><label>Confirmar contraseña nueva</label><input id="mcPwConfirm" type="password" autocomplete="new-password" /></div>
    <div class="modal-actions" style="flex-direction:column;gap:8px">
      <div style="display:flex;gap:8px;justify-content:flex-end">
        ${mustChange ? '' : '<button class="btn" id="btnCerrarTodasSesiones" style="margin-right:auto;color:var(--text-muted);font-size:0.8rem">Cerrar sesión en todos los dispositivos</button>'}
        <button class="btn" id="btnCancelMiCuenta">Cancelar</button>
        <button class="btn btn-primary" id="btnSaveMiCuenta">Guardar</button>
      </div>
    </div>
  `);

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

function updateProfileUI() {
  if (!state.user) return;
  const initials = state.user.nombre.split(' ').map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
  const av = $('#sidebarAvatar'); if (av) av.textContent = initials;
  const nm = $('#sidebarProfileName'); if (nm) nm.textContent = state.user.nombre;
  const pn = $('#popoverName'); if (pn) pn.textContent = state.user.nombre;
}

// =========================================================================
// VISTA: Usuarios (solo Administrador) — alta, edición y baja de cuentas
// =========================================================================
async function renderUsuarios(view) {
  if (!puedeGestionarUsuarios()) {
    view.innerHTML = `<div class="alert-box danger">⚠️ No tienes permiso para ver esta sección.</div>`;
    return;
  }
  const usuarios = await api('/usuarios');

  view.innerHTML = `
    <h2 class="section-title">Usuarios</h2>
    <p class="muted">Cuentas del equipo y su puesto. El puesto determina qué pestañas y acciones puede usar cada quien.</p>
    <div class="section-actions">
      <button class="btn btn-primary" id="btnNuevoUsuario">+ Nuevo usuario</button>
    </div>
    <div id="usuariosList"></div>
  `;
  $('#btnNuevoUsuario').addEventListener('click', () => openUsuarioModal(null));
  paintUsuariosList(usuarios);
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
          <div class="muted" style="font-size:0.8rem">@${esc(u.usuario)}</div>
        </div>
        <div class="row" style="gap:6px;flex-wrap:nowrap">
          <span class="badge ${u.puesto === 'admin' ? 'green' : u.puesto === 'logistica' ? 'yellow' : 'muted'}">${esc(PUESTO_LABELS[u.puesto] || u.puesto)}</span>
          ${!u.activo ? '<span class="badge red">Inactivo</span>' : ''}
          ${u.must_change_password ? '<span class="badge yellow" title="Debe cambiar contraseña en el próximo login">🔑 Cambio pendiente</span>' : ''}
        </div>
      </div>
      <div class="row end" style="margin-top:8px;gap:8px">
        <button class="btn small" data-edit-user="${u.id}">Editar</button>
        <button class="btn small" data-reset-user="${u.id}" title="Generar nueva contraseña temporal">Restablecer contraseña</button>
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
  $$('[data-del-user]', list).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const u = usuarios.find((x) => x.id === Number(btn.dataset.delUser));
      if (!u) return;
      if (!confirm(`¿Eliminar la cuenta de "${u.nombre}"? Esta acción no se puede deshacer.`)) return;
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
  const [allProjects, assigned] = await Promise.all([
    api('/projects'),
    isEdit ? api(`/usuarios/${usuario.id}/proyectos`) : Promise.resolve([]),
  ]);
  const assignedIds = new Set(assigned.map((p) => p.id));

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
    </div>
    ${isEdit ? `
    <div class="field">
      <label style="display:flex;align-items:center;gap:8px;margin-top:14px">
        <input id="uActivo" type="checkbox" style="width:auto" ${usuario.activo ? 'checked' : ''} /> Cuenta activa
      </label>
    </div>` : ''}
    <div class="field" id="uProyectosField" style="${puestoInicial === 'admin' ? 'display:none' : ''}" data-admin-hide="true">
      <label>Obras asignadas</label>
      <p class="muted" style="font-size:0.76rem;margin:0 0 6px">Solo verá y podrá operar en las obras marcadas aquí.</p>
      ${allProjects.length ? `
      <div id="uProyectosList" style="display:flex;flex-direction:column;gap:8px;max-height:180px;overflow-y:auto">
        ${allProjects.map((p) => `
          <label style="display:flex;align-items:center;gap:8px;font-weight:400;font-size:0.88rem">
            <input type="checkbox" value="${p.id}" style="width:auto" ${assignedIds.has(p.id) ? 'checked' : ''} /> ${esc(p.nombre)}
          </label>`).join('')}
      </div>` : '<p class="muted">No hay obras cargadas todavía.</p>'}
    </div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelUsuario">Cerrar</button>
      <button class="btn btn-primary" id="btnSaveUsuario">${isEdit ? 'Guardar cambios' : 'Crear usuario'}</button>
    </div>
  `);
  $('#uPuesto').addEventListener('change', (e) => {
    $('#uProyectosField').style.display = e.target.value === 'admin' ? 'none' : '';
  });
  $('#btnCancelUsuario').addEventListener('click', closeModal);
  $('#btnSaveUsuario').addEventListener('click', async () => {
    const nombre = $('#uNombre').value.trim();
    const puesto = $('#uPuesto').value;
    const password = $('#uPassword').value;
    if (!nombre) { toast('Escribe el nombre completo', 'danger'); return; }
    if (!isEdit && !$('#uUsuario').value.trim()) { toast('Escribe el usuario de acceso', 'danger'); return; }
    if (!isEdit && !password) { toast('Escribe una contraseña', 'danger'); return; }
    if (password && password.length < 6) { toast('La contraseña debe tener al menos 6 caracteres', 'danger'); return; }
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
        const projectIds = $$('#uProyectosList input[type="checkbox"]:checked').map((cb) => Number(cb.value));
        await api(`/usuarios/${targetId}/proyectos`, { method: 'PUT', body: { project_ids: projectIds } });
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
    <div class="alert-box warning" style="margin:10px 0 14px">El admin nunca puede ver la contraseña actual del usuario — solo generar una nueva.</div>
    <div class="field">
      <label>Nueva contraseña temporal *</label>
      <input id="rpPassword" type="password" autocomplete="new-password" placeholder="Mínimo 6 caracteres" />
    </div>
    <div class="field">
      <label>Confirmar contraseña *</label>
      <input id="rpConfirm" type="password" autocomplete="new-password" />
    </div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelReset">Cancelar</button>
      <button class="btn btn-primary" id="btnConfirmReset">Restablecer</button>
    </div>
  `);
  $('#btnCancelReset').addEventListener('click', closeModal);
  $('#btnConfirmReset').addEventListener('click', async () => {
    const password = $('#rpPassword').value;
    const confirm = $('#rpConfirm').value;
    if (!password) { toast('Escribe una contraseña', 'danger'); return; }
    if (password.length < 6) { toast('Mínimo 6 caracteres', 'danger'); return; }
    if (password !== confirm) { toast('Las contraseñas no coinciden', 'danger'); return; }
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
          ${p.contacto ? `<div class="muted" style="font-size:0.8rem">${esc(p.contacto)}</div>` : ''}
          ${p.telefono ? `<div class="muted" style="font-size:0.8rem">📞 ${esc(p.telefono)}</div>` : ''}
          ${p.rfc ? `<div class="muted code" style="font-size:0.74rem">${esc(p.rfc)}</div>` : ''}
        </div>
        ${!p.activo ? '<span class="badge red">Inactivo</span>' : ''}
      </div>
      ${isAdmin() ? `
      <div class="row end" style="margin-top:8px;gap:8px">
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

    <div class="kpi-grid" style="margin-bottom:10px">
      <div class="kpi accent" style="grid-column:1/-1">
        <div class="label">Avance Valorizado</div>
        <div class="value">${fmtPct(av.pct)}</div>
        <div class="muted" style="margin-top:2px">${fmtMoney(av.monto)}</div>
      </div>
    </div>

    <div class="card" style="border-color:var(--green)">
      <h3 class="section-title" style="margin-top:0">Erogado Real</h3>
      <p class="muted" style="font-size:0.78rem;margin:-4px 0 10px">Los montos de Compras se muestran ajustados a base sin IVA (÷${(1 + er.iva_ajuste_pct / 100).toFixed(2)}) para que sean comparables contra Avance Valorizado, que también es sin IVA. Esto no cambia lo realmente pagado al proveedor — solo la base usada aquí para comparar.</p>
      <div class="card-row"><span class="k">Total pagado</span><span class="v" style="color:var(--green)">${fmtMoney(er.total_pagado)}</span></div>
      <div class="card-row"><span class="k">Total comprometido (no pagado)</span><span class="v" style="color:var(--yellow)">${fmtMoney(er.total_comprometido_no_pagado)}</span></div>
      <h4 style="margin:12px 0 4px;font-size:0.82rem;color:var(--muted);text-transform:uppercase">Desglose</h4>
      <div class="card-row"><span class="k">Compras — pagado (sin IVA, ajustado)</span><span class="v">${fmtMoney(er.compras_pagado)}</span></div>
      <div class="card-row"><span class="k">Compras — pagado (con IVA, real)</span><span class="v muted">${fmtMoney(er.compras_pagado_con_iva)}</span></div>
      <div class="card-row"><span class="k">Compras — comprometido (sin IVA, ajustado)</span><span class="v">${fmtMoney(er.compras_comprometido)}</span></div>
      <div class="card-row"><span class="k">Compras — comprometido (con IVA, real)</span><span class="v muted">${fmtMoney(er.compras_comprometido_con_iva)}</span></div>
      <div class="card-row"><span class="k">Gastos generales — pagado</span><span class="v">${fmtMoney(er.gastos_generales_pagado)}</span></div>
      <div class="card-row"><span class="k">Gastos generales — pendiente</span><span class="v">${fmtMoney(er.gastos_generales_pendiente)}</span></div>
      <div class="card-row"><span class="k">Destajo — ejecutado (mano de obra)</span><span class="v">${fmtMoney(er.destajo_ejecutado)}</span></div>
    </div>

    <div class="card" style="border-color:${brechaPositiva ? 'var(--green)' : 'var(--red)'}">
      <h3 class="section-title" style="margin-top:0">Brecha</h3>
      <div class="value" style="font-size:1.4rem;font-weight:700;color:${brechaPositiva ? 'var(--green)' : 'var(--red)'}">${fmtMoney(brecha.monto)}</div>
      <p class="muted" style="margin-top:8px">${esc(brecha.descripcion)}</p>
    </div>

    <h3 class="section-title">Gastos Generales</h3>
    <div class="row" style="gap:8px;margin-bottom:10px">
      <select id="gastoFiltroCategoria" style="flex:1">
        <option value="">Todas las categorías</option>
        ${Object.entries(GASTO_CATEGORIA_LABELS).map(([k, l]) => `<option value="${k}" ${gastosFilter.categoria === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}
      </select>
      <select id="gastoFiltroEstado" style="flex:1">
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
          <div class="muted" style="font-size:0.8rem">${esc(GASTO_CATEGORIA_LABELS[g.categoria] || g.categoria)} · ${fmtDate(g.fecha)}</div>
          ${g.observaciones ? `<div class="muted" style="font-size:0.78rem">${esc(g.observaciones)}</div>` : ''}
        </div>
        <div style="text-align:right">
          <div style="font-weight:700">${fmtMoney(g.monto)}</div>
          <span class="badge ${g.estado === 'pagado' ? 'green' : 'yellow'}">${esc(g.estado)}</span>
        </div>
      </div>
      ${isAdmin() ? `
      <div class="row end" style="margin-top:8px;gap:8px">
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

// ---------------------------------------------------------------------------
// FAB: contextual quick-action depending on the active view
// ---------------------------------------------------------------------------
const fab = document.createElement('button');
fab.className = 'fab';
fab.textContent = '+';
fab.style.display = 'none';
document.body.appendChild(fab);
fab.addEventListener('click', () => {
  const isAdmin = state.user && state.user.puesto === 'admin';
  if (state.view === 'requisiciones') {
    if (getDraft().length) openDraftModal();
    else { switchToView('insumos'); toast('Agrega insumos desde el catálogo primero', ''); }
  } else if (state.view === 'insumos') {
    if (getDraft().length) { switchToView('requisiciones'); }
  } else if (state.view === 'destajo') {
    if (isAdmin || (state.user && state.user.puesto === 'residente')) openNuevoDestajistaModal();
  } else if (isAdmin) {
    promptUpload();
  }
});
function syncFab() {
  const noFabViews = ['usuarios', 'proveedores', 'ordenes', 'finanzas', 'mapeo'];
  const hasAction = ['requisiciones', 'insumos', 'destajo'].includes(state.view);
  fab.style.display = !noFabViews.includes(state.view) && state.projectId && (hasAction || isAdmin()) ? 'flex' : 'none';
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
}

// ---------------------------------------------------------------------------
// Sidebar — inicialización y event listeners
// ---------------------------------------------------------------------------
applySidebarCollapse();

$('#btnSidebarCollapse').addEventListener('click', toggleSidebarCollapse);
$('#btnSidebarProject').addEventListener('click', openDrawer);
$('#sidebarOverlay').addEventListener('click', closeSidebar);

// Popover de perfil (desktop)
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
$('#btnLogoutPopover').addEventListener('click', () => { closeUserPopover(); logout(); });
$('#btnMiCuentaPopover').addEventListener('click', () => { closeUserPopover(); openMiCuentaModal(false); });

// Barra inferior móvil
(function () {
  const ii = $('#mobileNavInicioIcon');   if (ii) ii.innerHTML = icon('home', 20);
  const ri = $('#mobileNavResumenIcon');  if (ri) ri.innerHTML = icon('resumen', 20);
  const ni = $('#mobileNavNotifIcon');    if (ni) ni.innerHTML = icon('bell', 20);
  const ai = $('#mobileNavAjustesIcon');  if (ai) ai.innerHTML = icon('settings', 20);
})();

$('#mobileNavInicio').addEventListener('click', async () => {
  try {
    const [, bienvenida] = await Promise.all([
      refreshClientList(),
      api('/bienvenida').catch(() => []),
    ]);
    showClientGallery();
    renderGalleryGreeting();
    renderClientGallery();
    renderBienvenidaSummary(bienvenida);
  } catch (_) {
    showClientGallery();
    renderGalleryGreeting();
    renderClientGallery();
  }
});
$('#mobileNavResumen').addEventListener('click', () => {
  if (!state.projectId) { toast('Selecciona un presupuesto primero', ''); return; }
  switchToView(state.allowedTabs.includes('resumen') ? 'resumen' : 'inicio');
});
$('#btnMobileQuick').addEventListener('click', openQuickActionMenu);
$('#btnMobileNotif').addEventListener('click', async () => {
  await refreshNotificaciones().catch(() => {});
  openModal(`
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <h3 style="margin:0">Notificaciones</h3>
      <button class="btn small" id="btnMarcarMobileLeidas">Todas leídas</button>
    </div>
    <div id="mobileNotifListEl" class="notif-list" style="max-height:55vh;overflow-y:auto"></div>
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

async function renderTrabajadores(view) {
  if (!isAdmin()) {
    view.innerHTML = `<div class="alert-box danger">⚠️ No tienes permiso para ver esta sección.</div>`;
    return;
  }
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
    <div class="section-actions" style="flex-wrap:wrap;gap:8px">
      ${puedeGestionarTrabajadores() ? `<button class="btn btn-primary" id="btnNuevoTrabajador">+ Nuevo trabajador</button>` : ''}
      <label style="display:flex;align-items:center;gap:6px;font-size:0.88rem;cursor:pointer">
        <input type="checkbox" id="chkVerInactivos" style="width:auto"> Ver inactivos
      </label>
    </div>
    <div id="trabajadoresList"><div class="empty-state">Cargando…</div></div>
  `;

  $('#btnNuevoTrabajador')?.addEventListener('click', () => openTrabajadorModal(null, repaint));
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
      <div class="row between" style="align-items:flex-start">
        <div>
          <strong>${esc(t.nombre)}</strong>
          ${t.puesto ? `<div class="muted" style="font-size:0.8rem">${esc(t.puesto)}</div>` : ''}
          <div style="margin-top:4px;font-size:0.8rem">
            <span class="badge muted">${esc(TIPO_PAGO_LABELS[t.tipo_pago] || t.tipo_pago)}</span>
            <span class="badge muted">${esc(PERIODICIDAD_LABELS[t.periodicidad] || t.periodicidad)}</span>
            ${!t.activo ? `<span class="badge red">Inactivo</span>` : ''}
          </div>
        </div>
        <div class="row" style="gap:6px;flex-wrap:nowrap;align-items:flex-start">
          ${puedeGestionarTrabajadores() ? `
            <button class="btn small" data-edit-trab="${t.id}">Editar</button>
            <button class="btn small" data-docs-trab="${t.id}" data-docs-nombre="${esc(t.nombre)}">Docs</button>
            ${t.activo
              ? `<button class="btn small btn-danger" data-baja-trab="${t.id}" data-baja-nombre="${esc(t.nombre)}">Dar baja</button>`
              : `<button class="btn small" data-reactiva-trab="${t.id}">Reactivar</button>
                 <button class="btn small btn-danger" data-del-trab="${t.id}" data-del-nombre="${esc(t.nombre)}">Eliminar</button>`
            }` : ''}
        </div>
      </div>
      ${t.tipo_pago !== 'destajo' ? `
        <div class="muted" style="font-size:0.78rem;margin-top:4px">
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
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div class="field" style="grid-column:1/-1"><label>Nombre completo *</label><input id="tNombre" value="${esc(trab?.nombre || '')}" /></div>
      <div class="field"><label>Puesto</label><input id="tPuesto" value="${esc(trab?.puesto || '')}" /></div>
      <div class="field"><label>Fecha de ingreso</label><input id="tFechaIngreso" type="date" value="${trab?.fecha_ingreso ? trab.fecha_ingreso.slice(0,10) : ''}" /></div>
      <div class="field"><label>Tipo de pago *</label><select id="tTipoPago">${tipoPagoOpts}</select></div>
      <div class="field"><label>Periodicidad *</label><select id="tPeriodicidad">${periodicidadOpts}</select></div>
      <div class="field" id="tTarifaField" style="grid-column:1/-1"><label>Tarifa jornal ($/día)</label><input id="tTarifa" type="number" min="0" step="0.01" value="${trab?.tarifa_jornal ?? ''}" /></div>
      <div class="field" style="grid-column:1/-1">
        <label>Vínculo con destajista (opcional)</label>
        <select id="tDestajista">${destajistaOpts}</select>
        <p class="muted" style="font-size:0.76rem;margin:2px 0 0">Permite importar producción de destajo al calcular nómina.</p>
      </div>
      <div class="field"><label>CURP</label><input id="tCurp" value="${esc(trab?.curp || '')}" /></div>
      <div class="field"><label>RFC</label><input id="tRfc" value="${esc(trab?.rfc || '')}" /></div>
      <div class="field"><label>NSS</label><input id="tNss" value="${esc(trab?.nss || '')}" /></div>
      <div class="field"><label>Teléfono</label><input id="tTelefono" value="${esc(trab?.telefono || '')}" /></div>
      <div class="field" style="grid-column:1/-1"><label>Dirección</label><input id="tDireccion" value="${esc(trab?.direccion || '')}" /></div>
      <div class="field" style="grid-column:1/-1"><label>Contacto de emergencia</label><input id="tContacto" value="${esc(trab?.contacto_emergencia || '')}" /></div>
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
      tarifa_jornal: parseFloat($('#tTarifa').value) || 0,
      destajista_id: Number($('#tDestajista').value) || null,
      curp: $('#tCurp').value.trim() || null,
      rfc: $('#tRfc').value.trim() || null,
      nss: $('#tNss').value.trim() || null,
      telefono: $('#tTelefono').value.trim() || null,
      direccion: $('#tDireccion').value.trim() || null,
      contacto_emergencia: $('#tContacto').value.trim() || null,
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

async function openBajaModal(id, nombre, repaint) {
  openModal(`
    <h3>Dar de baja a ${esc(nombre)}</h3>
    <p class="muted">El trabajador quedará inactivo. Su expediente e historial se conservan. Puedes reactivarlo en cualquier momento.</p>
    <div class="field"><label>Motivo de baja</label><textarea id="tMotivoBaja" rows="3" placeholder="Opcional — terminación de contrato, renuncia, etc."></textarea></div>
    <div class="modal-actions">
      <button class="btn" id="btnCancelBaja">Cancelar</button>
      <button class="btn btn-danger" id="btnConfirmBaja">Dar de baja</button>
    </div>
  `);
  $('#btnCancelBaja').addEventListener('click', closeModal);
  $('#btnConfirmBaja').addEventListener('click', async () => {
    const btn = $('#btnConfirmBaja');
    btn.disabled = true;
    try {
      await api(`/projects/${state.projectId}/trabajadores/${id}/baja`, {
        method: 'POST',
        body: { motivo: $('#tMotivoBaja').value.trim() || null },
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
    <div style="margin-top:12px;border-top:1px solid var(--border-color);padding-top:12px">
      <p class="muted" style="font-size:0.85rem;margin:0 0 8px">Subir nuevo documento (INE, CURP, comprobante de domicilio)</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
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
      <div class="row between" style="padding:6px 0;border-bottom:1px solid var(--border-color)">
        <span style="font-size:0.85rem">${esc(TIPO_DOC_LABELS[d.tipo_doc] || d.tipo_doc)} — ${esc(d.nombre_original)}</span>
        <div class="row" style="gap:6px">
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

  async function showAsistencia() {
    subView = 'asistencia';
    const today = new Date().toISOString().slice(0, 10);
    view.innerHTML = `
      <h2 class="section-title">Personal</h2>
      ${renderSubNav()}
      <div class="card" style="margin-top:12px">
        <div class="row between" style="flex-wrap:wrap;gap:8px;align-items:flex-end">
          <div class="field" style="margin:0">
            <label>Fecha</label>
            <input type="date" id="asistenciaFecha" value="${today}" style="width:auto" />
          </div>
          <button class="btn btn-primary" id="btnCargarAsistencia">Cargar</button>
        </div>
      </div>
      <div id="asistenciaPanel"></div>
    `;
    bindSubNav();
    $('#btnCargarAsistencia').addEventListener('click', () => loadAsistencia($('#asistenciaFecha').value));
    await loadAsistencia(today);
  }

  async function loadAsistencia(fecha) {
    const panel = $('#asistenciaPanel');
    if (!panel) return;
    panel.innerHTML = '<div class="empty-state">Cargando…</div>';
    try {
      const data = await api(`/projects/${state.projectId}/asistencia?fecha=${fecha}`);
      if (!data.trabajadores?.length) {
        panel.innerHTML = '<div class="empty-state">No hay trabajadores activos en esta obra.</div>';
        return;
      }
      panel.innerHTML = `
        <div class="card" style="margin-top:8px">
          <table class="asistencia-table">
            <thead><tr><th>Trabajador</th><th>Puesto</th><th style="text-align:center">Asistió</th></tr></thead>
            <tbody>
              ${data.trabajadores.map((t) => `
                <tr>
                  <td>${esc(t.nombre)}</td>
                  <td class="muted" style="font-size:0.8rem">${esc(t.puesto || '—')}</td>
                  <td style="text-align:center">
                    <input type="checkbox" class="asistencia-check" data-tid="${t.id}"
                      ${t.presente ? 'checked' : ''} ${!puedeCapturarAsistencia() ? 'disabled' : ''} />
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          ${puedeCapturarAsistencia() ? `
            <div class="row end" style="margin-top:12px">
              <button class="btn btn-primary" id="btnGuardarAsistencia">Guardar asistencia</button>
            </div>` : ''}
        </div>
      `;
      $('#btnGuardarAsistencia')?.addEventListener('click', async () => {
        const asistencia = $$('.asistencia-check', panel).map((chk) => ({
          trabajador_id: Number(chk.dataset.tid),
          presente: chk.checked,
        }));
        const btn = $('#btnGuardarAsistencia');
        btn.disabled = true;
        try {
          await api(`/projects/${state.projectId}/asistencia`, {
            method: 'PUT',
            body: { fecha, asistencia },
          });
          toast('Asistencia guardada', 'success');
        } catch (err) { toast(err.message, 'danger'); }
        btn.disabled = false;
      });
    } catch (err) {
      panel.innerHTML = `<div class="alert-box danger">⚠️ ${esc(err.message)}</div>`;
    }
  }

  async function showNominas() {
    subView = 'nominas';
    view.innerHTML = `
      <h2 class="section-title">Personal</h2>
      ${renderSubNav()}
      <div class="section-actions" style="margin-top:12px">
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
          <div class="row between" style="flex-wrap:wrap;gap:6px">
            <div>
              <strong>${esc(n.fecha_inicio)} al ${esc(n.fecha_fin)}</strong>
              <div class="muted" style="font-size:0.8rem">${n.num_trabajadores} trabajadores · $${Number(n.total_nomina || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 })}</div>
            </div>
            <div class="row" style="gap:6px;align-items:center">
              <span class="badge ${NOMINA_ESTADO_BADGE[n.estado] || 'muted'}">${esc(NOMINA_ESTADO_LABELS[n.estado] || n.estado)}</span>
            </div>
          </div>
          ${n.nota_rechazo ? `<div class="muted" style="font-size:0.8rem;margin-top:4px">Nota: ${esc(n.nota_rechazo)}</div>` : ''}
          <div class="row end" style="margin-top:8px;gap:6px;flex-wrap:wrap">
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
            await api(`/projects/${state.projectId}/nominas/${btn.dataset.calcularNomina}/calcular`, { method: 'POST' });
            toast('Nómina calculada', 'success');
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
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
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
    el.innerHTML = `
      <div class="muted" style="font-size:0.82rem;margin-bottom:8px">${esc(data.fecha_inicio)} al ${esc(data.fecha_fin)}</div>
      <table style="width:100%;font-size:0.85rem;border-collapse:collapse">
        <thead><tr>
          <th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--border-color)">Trabajador</th>
          <th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border-color)">Días</th>
          <th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border-color)">Monto</th>
        </tr></thead>
        <tbody>
          ${items.map((i) => `
            <tr>
              <td style="padding:4px 8px">${esc(i.trabajador_nombre || i.nombre_trabajador || '—')}</td>
              <td style="padding:4px 8px;text-align:right">${i.dias_trabajados ?? '—'}</td>
              <td style="padding:4px 8px;text-align:right">$${Number(i.monto_total || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 })}</td>
            </tr>
          `).join('')}
        </tbody>
        <tfoot><tr>
          <td colspan="2" style="padding:6px 8px;font-weight:600;border-top:2px solid var(--border-color)">Total</td>
          <td style="padding:6px 8px;font-weight:600;text-align:right;border-top:2px solid var(--border-color)">$${total.toLocaleString('es-MX', { minimumFractionDigits: 2 })}</td>
        </tr></tfoot>
      </table>
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
    <p class="muted" style="font-size:0.88rem">¿Confirmas el cambio de estado?</p>
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
// Boot
// ---------------------------------------------------------------------------
tryRestoreSession();
