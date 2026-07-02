'use strict';

/* =========================================================================
 * Control Presupuestal de Obra — SPA (vanilla JS, mobile-first PWA)
 * ========================================================================= */

const state = {
  projects: [],
  projectId: null,
  view: 'resumen',
  cache: {},     // per-project cached API responses
  charts: {},    // active Chart.js instances (destroyed on re-render)
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
  const res = await fetch(`/api${path}`, {
    headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    ...opts,
    body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
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
// Modal helpers
// ---------------------------------------------------------------------------
function openModal(html) {
  const modal = $('#modal');
  modal.innerHTML = html;
  modal.classList.add('show');
  $('#modalOverlay').classList.add('show');
}
function closeModal() {
  $('#modal').classList.remove('show');
  $('#modalOverlay').classList.remove('show');
  $('#modal').innerHTML = '';
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
      <div class="pactions"><button class="btn small btn-danger" data-del="${p.id}">Eliminar</button></div>
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
  if (!state.projectId) {
    view.innerHTML = `
      <div class="empty-state">
        <div class="big">🏗️</div>
        <p>No hay un presupuesto seleccionado.</p>
        <p>Carga un archivo Excel de presupuesto (.xlsx) y la app generará automáticamente su catálogo de insumos, alertas de requisición, avances y programa de ejecución — con su propia base de datos independiente.</p>
        <button class="btn btn-primary" id="emptyUploadBtn">+ Cargar presupuesto</button>
      </div>`;
    $('#emptyUploadBtn').addEventListener('click', promptUpload);
    return;
  }
  view.innerHTML = '<div class="spinner"></div>';
  try {
    switch (state.view) {
      case 'resumen': await renderResumen(view); break;
      case 'insumos': await renderInsumos(view); break;
      case 'requisiciones': await renderRequisiciones(view); break;
      case 'avance': await renderAvance(view); break;
      case 'programa': await renderPrograma(view); break;
      case 'destajo': await renderDestajo(view); break;
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
    <div class="search-bar">
      <input type="search" id="insumoSearch" placeholder="Buscar por código o nombre…" value="${esc(insumosFilter.q)}" />
    </div>
    <div class="chip-row" id="catChips">
      <button class="chip ${!insumosFilter.categoria ? 'active' : ''}" data-cat="">Todos</button>
      ${categorias.map((c) => `<button class="chip ${insumosFilter.categoria === c ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
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
      <div class="row end">
        <button class="btn small btn-primary" data-add="${i.id}">+ Agregar a requisición</button>
      </div>
    </div>`;
  }).join('');

  $$('[data-add]', list).forEach((btn) => btn.addEventListener('click', () => addToDraft(Number(btn.dataset.add), insumos)));
}

function queryString(obj) {
  const parts = Object.entries(obj).filter(([, v]) => v).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
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
    $('#estadoSelect').addEventListener('change', async (e) => {
      try {
        await api(`/projects/${state.projectId}/requisiciones/${reqId}/estado`, { method: 'PUT', body: { estado: e.target.value } });
        toast('Estado actualizado', 'success');
        invalidate('resumen');
        renderView();
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
    <div class="section-actions">
      <button class="btn btn-primary" id="btnNuevoDest">+ Nuevo destajista</button>
    </div>
    ${destajistas.length === 0 ? `
      <div class="empty-state">
        <div class="big">👷</div>
        <p>No hay destajistas registrados.</p>
        <p>Agrega trabajadores y asígnales los conceptos que ejecutarán a destajo.<br>
           Si tu Excel tenía una hoja llamada "Destajo" o "Destajistas", se importó automáticamente al cargar el presupuesto.</p>
      </div>
    ` : destajistas.map((d) => renderDestajistaCard(d)).join('')}
  `;

  $('#btnNuevoDest').addEventListener('click', () => openNuevoDestajistaModal());

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
      <div class="row" style="gap:6px;flex-wrap:nowrap">
        <button class="btn small" data-edit-dest="${d.id}" title="Editar destajista">✏️ Editar</button>
        <button class="btn small btn-danger" data-del-dest="${d.id}">Eliminar</button>
      </div>
    </div>
    <div class="row" style="gap:14px;margin:6px 0;flex-wrap:wrap;font-size:0.84rem">
      <span class="muted">${d.items.length} actividad${d.items.length !== 1 ? 'es' : ''}</span>
      <span>Asig: ${fmtMoney(d.total_asignado)}</span>
      <span style="color:var(--green)">Ganado: ${fmtMoney(d.total_ganado)}</span>
      <span class="badge ${pct >= 100 ? 'green' : 'yellow'}">${pct}%</span>
    </div>
    <div class="progress-bar" style="margin-bottom:8px"><span style="width:${Math.min(100, pct)}%"></span></div>
    ${renderDestajistaItems(d)}
    <div class="row" style="margin-top:8px">
      <button class="btn small" data-add-item="${d.id}">+ Agregar actividad</button>
    </div>
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
      body.innerHTML = '<p class="muted" style="padding:10px 4px">El proyecto no tiene periodos de programa de obra generados (faltan las fechas de inicio/fin de obra).</p>';
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
                 value="${it.cantidad_ejecutada_periodo ?? ''}" />
        </div>
        <div class="muted" data-acum-out style="font-size:0.74rem;text-align:right;align-self:end;line-height:1.3"></div>
      </div>
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
      await api(`/projects/${state.projectId}/destajistas/${destId}/avance/${semana}`, { method: 'PUT', body: { items: payloadItems } });
      closeModal();
      toast(`Avance de destajo de la semana ${semana} guardado`, 'success');
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
            <th></th>
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
              <input type="number" min="0" step="0.01" style="width:72px;text-align:right"
                value="${it.cantidad_asignada}"
                data-save-item data-item-id="${it.id}" data-dest-id="${d.id}" data-field="cantidad_asignada" />
            </td>
            <td class="num">
              <input type="number" min="0" step="0.01" style="width:80px;text-align:right"
                value="${it.precio_destajo}"
                data-save-item data-item-id="${it.id}" data-dest-id="${d.id}" data-field="precio_destajo" />
            </td>
            <td class="num">${fmtNum(it.cantidad_ejecutada, 2)} ${esc(it.unidad || '')}</td>
            <td class="num" style="color:var(--green)">${fmtMoney(it.cantidad_ejecutada * it.precio_destajo)}</td>
            <td>
              <button class="btn small btn-ghost" data-del-item data-item-id="${it.id}" data-dest-id="${d.id}" title="Eliminar">✕</button>
            </td>
          </tr>`).join('')}
          <tr style="font-weight:600;border-top:1px solid var(--border)">
            <td colspan="4" style="text-align:right;color:var(--muted);padding-right:8px">Total ganado:</td>
            <td class="num" style="color:var(--green)">${fmtMoney(d.total_ganado)}</td>
            <td></td>
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
    else { $('.tab[data-view="insumos"]').click(); toast('Agrega insumos desde el catálogo primero', ''); }
  } else if (state.view === 'insumos') {
    if (getDraft().length) { $('.tab[data-view="requisiciones"]').click(); }
  } else if (state.view === 'destajo') {
    openNuevoDestajistaModal();
  } else {
    promptUpload();
  }
});
function syncFab() {
  fab.style.display = state.projectId ? 'flex' : 'none';
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
// PWA: service worker registration
// ---------------------------------------------------------------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function init() {
  try {
    await refreshProjectList();
    if (state.projects.length) selectProject(state.projects[0].id);
    else renderView();
  } catch (err) {
    $('#view').innerHTML = `<div class="alert-box danger">⚠️ No se pudo conectar con el servidor: ${esc(err.message)}</div>`;
  }
})();
