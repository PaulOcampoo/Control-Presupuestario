'use strict';

/* =========================================================================
 * Control Presupuestal de Obra — SPA (vanilla JS, mobile-first PWA)
 * ========================================================================= */

const TOKEN_KEY = 'cp_token';
const PUESTO_LABELS = { admin: 'Administrador', residente: 'Residente', cabo: 'Cabo' };

const state = {
  projects: [],
  projectId: null,
  view: 'resumen',
  cache: {},     // per-project cached API responses
  charts: {},    // active Chart.js instances (destroyed on re-render)
  token: null,
  user: null,        // { id, nombre, usuario, puesto }
  allowedTabs: [],
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

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

function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast'; }, 3600);
}

// ---------------------------------------------------------------------------
// Autenticación: pantalla de login que filtra el acceso por puesto. El token
// se guarda en localStorage; cada puesto ve solo sus pestañas permitidas.
// ---------------------------------------------------------------------------
function showLoginScreen() {
  $('#app').style.display = 'none';
  $('#loginScreen').style.display = 'flex';
  $('#loginUsuario').focus();
}
function showApp() {
  $('#loginScreen').style.display = 'none';
  $('#app').style.display = '';
}

function isAdmin() { return !!state.user && state.user.puesto === 'admin'; }
function canManageDestajo() { return !!state.user && (state.user.puesto === 'admin' || state.user.puesto === 'residente'); }

function applySession(user, tabs) {
  state.user = user;
  state.allowedTabs = tabs;
  $$('.tab').forEach((tab) => {
    tab.style.display = tabs.includes(tab.dataset.view) ? '' : 'none';
  });
  const isAdmin = user.puesto === 'admin';
  $('#btnUpload').style.display = isAdmin ? '' : 'none';
  $('#btnUploadDrawer').style.display = isAdmin ? '' : 'none';
  renderDrawerAccount();
  state.view = tabs[0] || 'resumen';
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === state.view));
}

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
  state.cache = {};
  closeDrawer();
  closeModal();
  showLoginScreen();
  toast('Tu sesión expiró, inicia sesión de nuevo', 'danger');
}

async function bootApp() {
  showApp();
  destroyCharts();
  try {
    await refreshProjectList();
    if (state.projects.length) selectProject(state.projects[0].id);
    else renderView();
  } catch (err) {
    $('#view').innerHTML = `<div class="alert-box danger">⚠️ No se pudo conectar con el servidor: ${esc(err.message)}</div>`;
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
  state.cache = {};
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
$('#btnMenu').addEventListener('click', openDrawer);
$('#btnCloseDrawer').addEventListener('click', closeDrawer);
$('#drawerOverlay').addEventListener('click', closeDrawer);

async function refreshProjectList() {
  state.projects = await api('/projects');
  renderProjectList();
}

function renderProjectList() {
  const list = $('#projectList');
  if (!state.projects.length) {
    list.innerHTML = '<div class="empty-state"><div class="big">📂</div>Aún no hay presupuestos cargados.<br>Toca el botón de abajo para subir tu primer archivo Excel.</div>';
    return;
  }
  list.innerHTML = state.projects.map((p) => `
    <div class="project-item ${p.id === state.projectId ? 'active' : ''}" data-id="${p.id}">
      <span class="pname">${esc(p.nombre)}</span>
      <span class="pmeta">${esc(p.lugar || '')}${p.lugar ? ' · ' : ''}${fmtMoney(p.total_sin_iva)}</span>
      <span class="pmeta">${fmtDate(p.inicio_obra)} → ${fmtDate(p.fin_obra)}</span>
      ${isAdmin() ? `<div class="pactions"><button class="btn small btn-danger" data-del="${p.id}">Eliminar</button></div>` : ''}
    </div>
  `).join('');

  $$('.project-item', list).forEach((el) => {
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-del]')) return;
      selectProject(Number(el.dataset.id));
      closeDrawer();
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
      if (!state.projectId && state.projects[0]) selectProject(state.projects[0].id);
      else if (!state.projects.length) renderView();
      toast('Presupuesto eliminado', 'success');
    });
  });
}

function selectProject(id) {
  state.projectId = id;
  state.cache[id] = state.cache[id] || {};
  const p = state.projects.find((x) => x.id === id);
  $('#projectName').textContent = p ? p.nombre : '';
  renderProjectList();
  renderView();
}

// ---------------------------------------------------------------------------
// Upload flow
// ---------------------------------------------------------------------------
function promptUpload() { $('#fileInput').click(); }
$('#btnUpload').addEventListener('click', promptUpload);
$('#btnUploadDrawer').addEventListener('click', promptUpload);

$('#fileInput').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  if (!/\.xlsx$/i.test(file.name)) { toast('Solo se admiten archivos .xlsx', 'danger'); return; }

  openModal(`
    <h3>Cargando presupuesto…</h3>
    <p class="muted">Analizando "${esc(file.name)}" y generando una base de datos independiente para este presupuesto.</p>
    <div class="spinner"></div>
  `);
  try {
    const fd = new FormData();
    fd.append('archivo', file);
    const result = await api('/projects', { method: 'POST', body: fd });
    await refreshProjectList();
    selectProject(result.id);
    closeDrawer();
    openPostUploadModal(result);
  } catch (err) {
    closeModal();
    toast(err.message, 'danger');
  }
});

// ---------------------------------------------------------------------------
// Tabs / routing
// ---------------------------------------------------------------------------
$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    state.view = tab.dataset.view;
    renderView();
  });
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
      case 'resumen': await renderResumen(view); break;
      case 'insumos': await renderInsumos(view); break;
      case 'requisiciones': await renderRequisiciones(view); break;
      case 'ordenes': await renderOrdenes(view); break;
      case 'avance': await renderAvance(view); break;
      case 'programa': await renderPrograma(view); break;
      case 'destajo': await renderDestajo(view); break;
      case 'finanzas': await renderFinanzas(view); break;
      case 'mapeo': await renderMapeo(view); break;
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
async function renderResumen(view) {
  const resumen = await cached('resumen', () => api(`/projects/${state.projectId}/resumen`));
  const m = resumen.meta || {};
  const ejec = resumen.avance_financiero_ejecutado_actual || 0;
  const prog = resumen.avance_financiero_programado_actual || 0;
  const desviacion = ejec - prog;
  const desvKind = desviacion >= 0 ? 'green' : (desviacion < -10 ? 'red' : 'yellow');

  view.innerHTML = `
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

  const ctx = $('#chartResumenDona').getContext('2d');
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
        legend: { position: 'bottom', labels: { color: '#e2e8f0', boxWidth: 14, font: { size: 11 } } },
        tooltip: { callbacks: { label: (c) => `${c.label}: ${fmtMoney(c.raw)}` } },
      },
    },
  });

  $('#btnEditFechasObra').addEventListener('click', () => openEditFechasObraModal(m));
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
        ${over ? '<span class="badge red">⚠ excede</span>' : ''}
      </div>
      <div class="row between">
        <span class="muted">Presupuestado</span>
        <span>${fmtNum(i.cantidad_presupuesto, 3)} ${esc(i.unidad || '')} &nbsp;·&nbsp; ${fmtMoney(i.precio_presupuesto)}/u</span>
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
      <div class="row end">
        <button class="btn small btn-primary" data-add="${i.id}">+ Agregar a requisición</button>
      </div>
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
  if (!isAdmin()) {
    view.innerHTML = '<div class="alert-box danger">⚠️ No tienes permiso para ver esta sección.</div>';
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
    </div>
    <div id="reqList"></div>
  `;
  $('#btnGoCatalogo').addEventListener('click', () => { $('.tab[data-view="insumos"]').click(); });
  if (draft.length) $('#btnOpenDraft').addEventListener('click', openDraftModal);

  const list = $('#reqList');
  if (!reqs.length) {
    list.innerHTML = '<div class="empty-state"><div class="big">🧾</div>Aún no hay requisiciones.<br>Agrega insumos desde el catálogo y crea tu primera requisición.</div>';
    return;
  }
  list.innerHTML = reqs.map((r) => {
    const alertCount = r.alertas_cantidad + r.alertas_precio;
    const estadoBadge = { borrador: 'muted', enviada: 'yellow', autorizada: 'green', cancelada: 'red' }[r.estado] || 'muted';
    return `
    <div class="card" data-req="${r.id}">
      <div class="row between">
        <div>
          <strong>${esc(r.folio || `Requisición #${r.id}`)}</strong>
          <div class="muted">${fmtDate(r.fecha)} · ${r.num_items} insumo${r.num_items === 1 ? '' : 's'} · ${fmtMoney(r.importe_total)}</div>
        </div>
        <span class="badge ${estadoBadge}">${esc(r.estado)}</span>
      </div>
      ${alertCount ? `<div class="alert-box warn">⚠ ${alertCount} alerta${alertCount === 1 ? '' : 's'}: ${r.alertas_cantidad ? `${r.alertas_cantidad} de cantidad ` : ''}${r.alertas_precio ? `${r.alertas_precio} de precio` : ''}</div>` : ''}
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
          alerts.push(`<div class="alert-box danger">⚠ <strong>${esc(it.insumo.codigo)}</strong>: la cantidad acumulada (${fmtNum(it.cantidad_acumulada_previa + it.cantidad_solicitada, 3)} ${esc(it.insumo.unidad || '')}) sobrepasa la cantidad presupuestada (${fmtNum(it.insumo.cantidad_presupuesto, 3)} ${esc(it.insumo.unidad || '')}).</div>`);
        }
        if (it.alerta_precio) {
          alerts.push(`<div class="alert-box warn">⚠ <strong>${esc(it.insumo.codigo)}</strong>: el precio solicitado (${fmtMoney(it.precio_solicitado)}) sobrepasa el precio presupuestado (${fmtMoney(it.insumo.precio_presupuesto)}).</div>`);
        }
      });
      box.innerHTML = alerts.join('') || '<div class="alert-box info">✓ Sin alertas: las cantidades y precios están dentro del presupuesto.</div>';
    } catch (err) { /* silent preview errors */ }
  }

  paintItems();
  runPreview();
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
    const estados = ['borrador', 'enviada', 'autorizada', 'cancelada'];
    openModal(`
      <h3>${esc(r.folio || `Requisición #${r.id}`)}</h3>
      <div class="row between">
        <span class="muted">${fmtDate(r.fecha)}</span>
        <select id="estadoSelect">${estados.map((e) => `<option value="${e}" ${e === r.estado ? 'selected' : ''}>${e}</option>`).join('')}</select>
      </div>
      ${r.observaciones ? `<p class="muted">${esc(r.observaciones)}</p>` : ''}
      <div id="reqItemsDetail"></div>
      <div class="modal-actions">
        <button class="btn btn-danger" id="btnDeleteReq">Eliminar</button>
        ${r.estado === 'borrador' ? '<button class="btn" id="btnEditReq">Editar</button>' : ''}
        ${r.estado === 'autorizada' ? '<button class="btn btn-primary" id="btnGenerarOC">Generar Orden de Compra</button>' : ''}
        <button class="btn" id="btnCloseDetail">Cerrar</button>
      </div>
    `);
    $('#reqItemsDetail').innerHTML = r.items.map((it) => `
      <div class="req-item-row">
        <div class="row between">
          <div style="font-weight:600;font-size:0.88rem">${esc(it.insumo_concepto)}</div>
          <span>${fmtMoney(it.importe)}</span>
        </div>
        <div class="muted code">${esc(it.insumo_codigo)} · ${esc(it.unidad || '')}</div>
        <div class="row between"><span class="muted">Solicitado</span><span>${fmtNum(it.cantidad_solicitada, 3)} ${esc(it.unidad || '')} a ${fmtMoney(it.precio_solicitado)}</span></div>
        <div class="row between"><span class="muted">Presupuestado</span><span>${fmtNum(it.cantidad_presupuesto, 3)} ${esc(it.unidad || '')} a ${fmtMoney(it.precio_presupuesto)}</span></div>
        ${it.alerta_cantidad ? '<div class="alert-box danger">⚠ Cantidad acumulada sobrepasa lo presupuestado</div>' : ''}
        ${it.alerta_precio ? '<div class="alert-box warn">⚠ Precio solicitado sobrepasa el precio presupuestado</div>' : ''}
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
          alerts.push(`<div class="alert-box danger">⚠ <strong>${esc(it.insumo.codigo)}</strong>: la cantidad acumulada (${fmtNum(it.cantidad_acumulada_previa + it.cantidad_solicitada, 3)} ${esc(it.insumo.unidad || '')}) sobrepasa la cantidad presupuestada (${fmtNum(it.insumo.cantidad_presupuesto, 3)} ${esc(it.insumo.unidad || '')}).</div>`);
        }
        if (it.alerta_precio) {
          alerts.push(`<div class="alert-box warn">⚠ <strong>${esc(it.insumo.codigo)}</strong>: el precio solicitado (${fmtMoney(it.precio_solicitado)}) sobrepasa el precio presupuestado (${fmtMoney(it.insumo.precio_presupuesto)}).</div>`);
        }
      });
      box.innerHTML = alerts.join('') || '<div class="alert-box info">✓ Sin alertas: las cantidades y precios están dentro del presupuesto.</div>';
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
      <label><input type="checkbox" id="ocIncluyeIva" checked style="width:auto;margin-right:6px" /> El monto por unidad que capturé arriba incluye IVA</label>
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
  $('#ocIncluyeIva').addEventListener('change', updateIvaResumen);
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
      state.view = 'ordenes';
      $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === 'ordenes'));
      renderView();
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
    <div id="ordenesList"></div>
  `;

  const list = $('#ordenesList');
  if (!ordenes.length) {
    list.innerHTML = '<div class="empty-state"><div class="big">🧾</div>Aún no hay órdenes de compra.<br>Genera una desde el detalle de una requisición autorizada.</div>';
    return;
  }
  const estadoBadge = { borrador: 'muted', enviada: 'yellow', confirmada: 'green', recibida_parcial: 'yellow', recibida_completa: 'green', cancelada: 'red' };
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
    const estados = ['borrador', 'enviada', 'confirmada', 'cancelada'];
    const esEstadoRecepcion = !estados.includes(o.estado);
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
          : `<select id="ocEstadoSelect">${estados.map((e) => `<option value="${e}" ${e === o.estado ? 'selected' : ''}>${e}</option>`).join('')}</select>`}
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
      ${isAdmin() ? '<div class="row end" style="margin-top:8px"><button class="btn small btn-primary" id="btnRegistrarPago">Registrar pago</button></div>' : ''}

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
    box.innerHTML = `<div class="alert-box danger">⚠ ${esc(err.message)}</div>`;
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
    box.innerHTML = `<div class="alert-box danger">⚠ ${esc(err.message)}</div>`;
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
    view.innerHTML = '<div class="empty-state"><div class="big">📅</div>No fue posible generar la curva de avance: el presupuesto no contiene fechas de inicio y fin de obra.</div>';
    return;
  }
  const presupuestoTotal = resumen.presupuesto_total || 0;
  view.innerHTML = `
    <h2 class="section-title">Avance semanal</h2>
    <p class="muted">Curva programada (calculada a partir del presupuesto y las fechas de obra) contra el avance real que captures cada semana.</p>
    <div class="card"><div class="chart-wrap tall"><canvas id="chartSemanal"></canvas></div></div>

    <h3 class="section-title">Captura de avance real por semana</h3>
    <p class="muted">La columna "Presupuesto del periodo" muestra la cantidad presupuestada (en pesos) para esa semana, según la curva programada — úsala como referencia para anotar tu avance real de esa misma semana. Toca <strong>"Por concepto"</strong> para anotar las cantidades realmente ejecutadas de cada concepto del catálogo (con su descripción, unidad y cantidad presupuestada) — el % de avance real se calculará automáticamente a partir de esas cantidades.</p>
    <div class="card">
      <div class="table-scroll">
        <table>
          <thead><tr><th>Semana</th><th>Periodo</th><th class="num">Presupuesto del periodo</th><th class="num">Programado acum.</th><th class="num">Físico real %</th><th class="num">Financiero real %</th><th></th></tr></thead>
          <tbody id="avanceTbody"></tbody>
        </table>
      </div>
    </div>

    <h3 class="section-title">Avance físico-financiero acumulado</h3>
    <div class="card"><div class="chart-wrap tall"><canvas id="chartFisFin"></canvas></div></div>
  `;

  paintAvanceChart(avances);
  paintFisFinChart(avances);
  paintAvanceTable(avances, presupuestoTotal);
}

function paintAvanceChart(avances) {
  const ctx = $('#chartSemanal').getContext('2d');
  const labels = avances.map((a) => `S${a.semana}`);
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
        x: { ticks: { color: '#94a3b8', maxRotation: 0, autoSkip: true, font: { size: 10 } }, grid: { color: '#334155' } },
        y: { min: 0, max: 100, ticks: { color: '#94a3b8', callback: (v) => `${v}%` }, grid: { color: '#334155' } },
      },
      plugins: { legend: { position: 'bottom', labels: { color: '#e2e8f0', boxWidth: 14, font: { size: 11 } } } },
    },
  });
}

function paintFisFinChart(avances) {
  const ctx = $('#chartFisFin').getContext('2d');
  const labels = avances.map((a) => `S${a.semana}`);
  const programado = avances.map((a) => a.avance_financiero_programado);
  const ejecutado = avances.map((a) => a.avance_financiero_real);
  const porEjecutar = avances.map((a) => (a.avance_financiero_real != null ? Math.max(0, 100 - a.avance_financiero_real) : null));
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
        x: { stacked: false, ticks: { color: '#94a3b8', maxRotation: 0, autoSkip: true, font: { size: 10 } }, grid: { display: false } },
        y: { min: 0, max: 100, ticks: { color: '#94a3b8', callback: (v) => `${v}%` }, grid: { color: '#334155' } },
      },
      plugins: { legend: { position: 'bottom', labels: { color: '#e2e8f0', boxWidth: 14, font: { size: 11 } } } },
    },
  });
}

function paintAvanceTable(avances, presupuestoTotal) {
  const tbody = $('#avanceTbody');
  tbody.innerHTML = avances.map((a, idx) => {
    const prevPct = idx > 0 ? (avances[idx - 1].avance_financiero_programado || 0) : 0;
    const pctPeriodo = Math.max(0, (a.avance_financiero_programado || 0) - prevPct);
    const importePeriodo = presupuestoTotal * (pctPeriodo / 100);
    return `
    <tr data-semana="${a.semana}">
      <td>${a.semana}</td>
      <td>${fmtDate(a.fecha_inicio)} – ${fmtDate(a.fecha_fin)}</td>
      <td class="num">${fmtMoney(importePeriodo)}<br><span class="muted" style="font-size:0.7rem">(${fmtPct(pctPeriodo)} del total)</span></td>
      <td class="num">${fmtPct(a.avance_financiero_programado)}</td>
      <td class="num"><input type="number" min="0" max="100" step="0.1" data-field="avance_fisico_real" value="${a.avance_fisico_real ?? ''}" style="width:84px;text-align:right" /></td>
      <td class="num"><input type="number" min="0" max="100" step="0.1" data-field="avance_financiero_real" value="${a.avance_financiero_real ?? ''}" style="width:84px;text-align:right" /></td>
      <td>
        <div class="row" style="flex-wrap:nowrap;gap:6px">
          <button class="btn small" data-detalle="${a.semana}" title="Capturar avance por concepto">Por concepto</button>
          <button class="btn small btn-primary" data-save="${a.semana}">Guardar</button>
        </div>
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
    $('#avcList').innerHTML = `<div class="alert-box danger">⚠ ${esc(err.message)}</div>`;
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
    view.innerHTML = '<div class="empty-state"><div class="big">🗓️</div>No fue posible generar el programa de ejecución: el presupuesto no contiene fechas de inicio y fin de obra, o no tiene conceptos con cantidades.</div>';
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
    ${canManageDestajo() ? `
    <div class="section-actions">
      <button class="btn btn-primary" id="btnNuevoDest">+ Nuevo destajista</button>
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
    body.innerHTML = `<div class="alert-box danger">⚠ ${esc(err.message)}</div>`;
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
  tbody.innerHTML = semanas.map((s) => `
    <tr>
      <td>${s.semana}</td>
      <td>${fmtDate(s.fecha_inicio)} – ${fmtDate(s.fecha_fin)}</td>
      <td class="num">${fmtMoney(s.ganado_periodo)}</td>
      <td class="num">${fmtMoney(s.ganado_acumulado)}</td>
      <td class="num">${fmtPct(s.pct_acumulado)}</td>
      <td><button class="btn small btn-primary" data-capturar-semana="${s.semana}" data-dest-id="${destId}">Capturar</button></td>
    </tr>
  `).join('');
  $$('[data-capturar-semana]', tbody).forEach((btn) => {
    btn.addEventListener('click', () => openDestajoSemanaModal(Number(btn.dataset.destId), Number(btn.dataset.capturarSemana), nombre));
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
    $('#destAvcList').innerHTML = `<div class="alert-box danger">⚠ ${esc(err.message)}</div>`;
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
  const soloLecturaParaMi = (it) => state.user.puesto === 'cabo' && yaCapturado(it);

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
      ${soloLecturaParaMi(it) ? '<div class="muted" style="font-size:0.72rem;color:var(--yellow);margin-top:2px">🔒 Ya capturado — solo residente/admin puede editarlo</div>' : ''}
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
        if (!$('#itemPU').value) $('#itemPU').value = c.precio_unitario;
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
// VISTA: Usuarios (solo Administrador) — alta, edición y baja de cuentas
// =========================================================================
async function renderUsuarios(view) {
  if (!isAdmin()) {
    view.innerHTML = '<div class="alert-box danger">⚠️ No tienes permiso para ver esta sección.</div>';
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
          <span class="badge ${u.puesto === 'admin' ? 'green' : 'muted'}">${esc(PUESTO_LABELS[u.puesto] || u.puesto)}</span>
          ${!u.activo ? '<span class="badge red">Inactivo</span>' : ''}
        </div>
      </div>
      <div class="row end" style="margin-top:8px;gap:8px">
        <button class="btn small" data-edit-user="${u.id}">Editar</button>
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
    <div class="field" id="uProyectosField" style="${puestoInicial === 'admin' ? 'display:none' : ''}">
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

// =========================================================================
// VISTA: Proveedores (catálogo global — solo Administrador gestiona)
// =========================================================================
async function renderProveedores(view) {
  const proveedores = await api('/proveedores');

  view.innerHTML = `
    <h2 class="section-title">Proveedores</h2>
    <p class="muted">Catálogo compartido entre todas las obras, usado al generar órdenes de compra.</p>
    ${isAdmin() ? `
    <div class="section-actions">
      <button class="btn btn-primary" id="btnNuevoProveedor">+ Nuevo proveedor</button>
    </div>` : ''}
    <div id="proveedoresList"></div>
  `;
  $('#btnNuevoProveedor')?.addEventListener('click', () => openProveedorModal(null));
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
    else { $('.tab[data-view="insumos"]').click(); toast('Agrega insumos desde el catálogo primero', ''); }
  } else if (state.view === 'insumos') {
    if (getDraft().length) { $('.tab[data-view="requisiciones"]').click(); }
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
// Boot
// ---------------------------------------------------------------------------
tryRestoreSession();
