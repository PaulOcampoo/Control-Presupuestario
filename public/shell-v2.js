'use strict';

// ---------------------------------------------------------------------------
// Shell v2 (Rediseño UI v2, Fases 4 y 8) — activo por defecto con sesión iniciada; opt-out con
// localStorage.ui_v2 = '0' (ver isUiV2() en app.js). Script clásico: comparte el alcance léxico global
// con app.js (state, $, icon, tabIcon, switchToView, goToSection, etc.), por eso se carga DESPUÉS.
//
// Reglas (docs/rediseno/):
//  - Nunca codificar visibilidad por rol aquí: todo sale de seccionesVisiblesParaRol(),
//    enlacesGlobalesVisibles(), accionesRapidasParaRol() y state.allowedTabs. El backend manda.
//  - Sin estilos inline (CSP style-src 'self'): solo clases; valores dinámicos con CSSOM desde JS.
//  - Sin position: sticky nuevo; la app scrollea el documento.
// ---------------------------------------------------------------------------
(function () {
  const V2 = {};

  const esc2 = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ── Breadcrumb del topbar ────────────────────────────────────────────────
  function crumbHtml() {
    const parts = [];
    const proj = state.projectId ? (state.projects || []).find((p) => p.id === state.projectId) : null;
    const cli = proj && (state.clientes || []).find((c) => c.id === proj.cliente_id);
    parts.push({ label: 'Clientes', go: proj ? 'clientes' : null });
    if (proj) {
      if (cli) parts.push({ label: cli.nombre, go: 'cliente', id: cli.id });
      parts.push({ label: proj.nombre, go: 'resumen' });
      const sec = state.section && SECTION_DEFS[state.section];
      if (sec) parts.push({ label: sec.label, go: 'section' });
      const viewLabel = TAB_LABELS[state.view];
      if (viewLabel && viewLabel !== (sec && sec.label) && state.view !== 'resumen') parts.push({ label: viewLabel, go: null });
    }
    return parts.map((c, i) => {
      const last = i === parts.length - 1;
      return last || !c.go
        ? `<b>${esc2(c.label)}</b>`
        : `<button type="button" class="v2-crumb-link" data-v2-go="${c.go}"${c.id != null ? ` data-v2-id="${c.id}"` : ''}>${esc2(c.label)}</button>${icon('chevron-right', 13)}`;
    }).join('');
  }
  V2.renderCrumb = function () {
    const el = document.getElementById('v2Crumb');
    if (!el) return;
    el.innerHTML = crumbHtml();
  };

  // ── Centro de avisos (consolida los 4 banners; la lógica original no se toca) ──────────────────
  const AVISOS = [
    { id: 'swUpdateBanner', icon: 'refresh', crit: true, text: () => 'Hay una actualización disponible', action: 'Recargar ahora', btn: 'btnSwUpdateReload' },
    { id: 'installBanner', icon: 'download', text: () => 'Instala la app en tu dispositivo', action: 'Instalar', btn: 'btnInstallApp', close: 'btnDismissInstall' },
    { id: 'totpReminderBanner', icon: 'shield', text: () => 'Protege tu cuenta con verificación en dos pasos', action: 'Configurar', btn: 'btnTotpReminderConfigurar', close: 'btnTotpReminderClose' },
    { id: 'novedadesBanner', icon: 'gift', text: () => ((document.getElementById('novedadesBannerTexto') || {}).textContent || 'Hay novedades').trim(), action: 'Ver novedades', btn: 'btnNovedadesBannerVer', close: 'btnNovedadesBannerClose' },
  ];
  function avisoVisible(id) {
    const el = document.getElementById(id);
    return !!el && !el.classList.contains('hidden-initial') && el.style.display !== 'none';
  }
  V2.renderAvisos = function () {
    const box = document.getElementById('avisosV2');
    const wrap = document.querySelector('.notif-wrap');
    const active = AVISOS.filter((a) => avisoVisible(a.id));
    if (wrap) wrap.classList.toggle('aviso-crit', isUiV2() && active.some((a) => a.crit));
    if (!box) return;
    if (!isUiV2() || !active.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="avisos-v2-title">Avisos</div>' + active.map((a) => `
      <div class="aviso-v2 ${a.crit ? 'crit' : ''}">
        <span class="aviso-v2-ic">${icon(a.icon, 16)}</span>
        <span class="aviso-v2-txt">${esc2(a.text())}</span>
        <button type="button" class="btn small btn-primary" data-v2-aviso="${a.btn}">${esc2(a.action)}</button>
        ${a.close ? `<button type="button" class="icon-btn-inline" aria-label="Descartar" data-v2-aviso="${a.close}">${icon('x', 14)}</button>` : ''}
      </div>`).join('');
  };

  // ── Ctrl K ───────────────────────────────────────────────────────────────
  let cmdkItems = [];
  let cmdkSel = 0;

  function buildIndex() {
    const items = [];
    // Acciones (mismos predicados que el menú "+")
    accionesRapidasParaRol().forEach((a) => {
      items.push({ g: 'Acciones', label: a.label, ic: TAB_ICON_NAMES[a.icon] ? tabIcon(a.icon, 16) : icon(a.icon, 16), run: () => { if (a.fn) a.fn(); else switchToView(a.goto); } });
    });
    // Secciones
    seccionesVisiblesParaRol().forEach((sec) => {
      items.push({ g: 'Ir a', label: sec.def.label, hint: 'Sección', ic: sectionIcon(sec.id, 16), run: () => goToSection(sec.id) });
    });
    // Módulos: solo tabs que el rol tiene (state.allowedTabs). Sin obra elegida, solo los que no la requieren.
    const tabs = state.projectId ? state.allowedTabs : state.allowedTabs.filter((t) => VISTAS_SIN_PROYECTO.includes(t));
    tabs.forEach((t) => {
      if (!TAB_LABELS[t]) return;
      const secDef = SECTION_DEFS[VIEW_TO_SECTION[t]];
      items.push({ g: 'Ir a', label: TAB_LABELS[t], hint: secDef ? secDef.label : '', ic: tabIcon(t, 16), run: () => switchToView(t) });
    });
    // Accesos globales (mismo gate que el drawer de la galería)
    enlacesGlobalesVisibles().forEach(([id, visible]) => {
      const btn = document.getElementById(id);
      if (!visible || !btn) return;
      items.push({ g: 'Ir a', label: btn.textContent.trim(), hint: 'Global', ic: icon('folder', 16), run: () => btn.click() });
    });
    items.push({ g: 'Acciones', label: 'Ajustes', hint: 'Apariencia, íconos, accesibilidad', ic: icon('settings', 16), run: () => openMobileAjustes() });
    // Obras ya cargadas en memoria
    (state.projects || []).forEach((p) => {
      items.push({ g: 'Obras', label: p.nombre, ic: icon('building', 16), run: () => selectProject(p.id) });
    });
    return items;
  }

  function renderCmdk() {
    const q = normalizarTexto(document.getElementById('cmdkInput').value.trim());
    const list = document.getElementById('cmdkList');
    const found = cmdkItems.filter((it) => !q || normalizarTexto(`${it.label} ${it.hint || ''}`).includes(q)).slice(0, 40);
    cmdkSel = Math.min(cmdkSel, Math.max(found.length - 1, 0));
    cmdkFound = found;
    if (!found.length) {
      list.innerHTML = `<div class="cmdk-empty">Sin resultados para «${esc2(document.getElementById('cmdkInput').value.trim())}»</div>`;
      return;
    }
    let html = '';
    let lastG = null;
    found.forEach((it, i) => {
      if (it.g !== lastG) { html += `<div class="cmdk-group">${esc2(it.g)}</div>`; lastG = it.g; }
      html += `<button type="button" class="cmdk-item ${i === cmdkSel ? 'sel' : ''}" role="option" aria-selected="${i === cmdkSel}" data-i="${i}">
        <span class="cmdk-ic">${it.ic}</span><span class="cmdk-lbl">${esc2(it.label)}</span>${it.hint ? `<span class="cmdk-hint">${esc2(it.hint)}</span>` : ''}</button>`;
    });
    list.innerHTML = html;
    const selEl = list.querySelector('.cmdk-item.sel');
    if (selEl && selEl.scrollIntoView) selEl.scrollIntoView({ block: 'nearest' });
  }
  let cmdkFound = [];
  let cmdkTrigger = null;

  V2.openCmdk = function () {
    if (!isUiV2()) return;
    const box = document.getElementById('cmdk');
    if (!box) return;
    cmdkTrigger = document.activeElement;
    cmdkItems = buildIndex(); // se reconstruye en cada apertura (cambia con rol/simulación/obra)
    cmdkSel = 0;
    document.getElementById('cmdkInput').value = '';
    box.classList.remove('hidden-initial');
    renderCmdk();
    document.getElementById('cmdkInput').focus();
  };
  V2.closeCmdk = function () {
    const box = document.getElementById('cmdk');
    if (!box) return;
    box.classList.add('hidden-initial');
    if (cmdkTrigger && cmdkTrigger.focus) { try { cmdkTrigger.focus({ preventScroll: true }); } catch (_) { /* no crítico */ } }
  };
  function runCmdk(i) {
    const it = cmdkFound[i];
    if (!it) return;
    V2.closeCmdk();
    it.run();
  }

  // ── Hoja "Más" (celular) ─────────────────────────────────────────────────
  V2.openSheet = function () {
    const sheet = document.getElementById('sheet2');
    const grid = document.getElementById('sheet2Grid');
    if (!sheet || !grid) return;
    const cell = (key, label, ic) => `<button type="button" class="sheet2-cell" data-v2-sheet="${key}"><span class="sheet2-ic">${ic}</span><span>${esc2(label)}</span></button>`;
    grid.innerHTML = seccionesVisiblesParaRol().map((sec) => cell(`sec:${sec.id}`, sec.def.label, sectionIcon(sec.id, 26))).join('')
      + cell('view:novedades', 'Novedades', tabIcon('novedades', 26))
      + cell('view:sugerencias', 'Sugerencias', tabIcon('sugerencias', 26))
      + cell('ajustes', 'Ajustes', icon('settings', 26));
    sheet.classList.remove('hidden-initial');
  };
  V2.closeSheet = function () {
    const sheet = document.getElementById('sheet2');
    if (sheet) sheet.classList.add('hidden-initial');
  };

  // ── Ganchos desde app.js ─────────────────────────────────────────────────
  // Ajustes de marcado del marco (sidebar/topbar) para igualar el prototipo, sin tocar la lógica de v1.
  V2.decorate = function () {
    // Marca: logo en cuadro redondeado + nombre en dos líneas
    const brandName = document.querySelector('#btnSidebarBrand .sidebar-brand-name');
    if (brandName && !brandName.dataset.v2) {
      brandName.dataset.v2 = '1';
      brandName.innerHTML = '<b>Grupo Roforb</b><small>Control Presupuestal</small>';
    }
    // Tarjeta de obra: monograma del cliente + nombre + "Cliente · N obras"
    const projBtn = document.getElementById('btnSidebarProject');
    if (projBtn) {
      const proj = state.projectId ? (state.projects || []).find((p) => p.id === state.projectId) : null;
      const cli = proj && (state.clientes || []).find((c) => c.id === proj.cliente_id);
      const ic = document.getElementById('sidebarProjectIcon');
      if (ic) ic.textContent = proj ? clienteMonograma((cli && cli.nombre) || proj.nombre) : '·';
      let sub = projBtn.querySelector('.v2-proj-sub');
      if (!sub) { sub = document.createElement('small'); sub.className = 'v2-proj-sub'; const chev = document.getElementById('sidebarProjectChevron'); projBtn.insertBefore(sub, chev); }
      const n = cli ? (state.projects || []).filter((p) => p.cliente_id === cli.id).length : 0;
      sub.textContent = cli ? `${cli.nombre} · ${n} obra${n === 1 ? '' : 's'}` : '';
    }
    const nav = document.getElementById('sidebarNav');
    if (nav) {
      // Rótulo "SECCIONES" antes del primer grupo de sección
      nav.querySelectorAll('.v2-nav-lbl').forEach((e) => e.remove());
      const first = nav.querySelector('.sbar-group');
      if (first) { const l = document.createElement('div'); l.className = 'v2-nav-lbl'; l.textContent = 'Secciones'; nav.insertBefore(l, first); }
      // Contador de alertas de requisiciones en Compras (dato del resumen ya cargado)
      nav.querySelectorAll('.v2-cnt').forEach((e) => e.remove());
      const res = state.projectId && state.cache && state.cache[state.projectId] && state.cache[state.projectId].resumen;
      const n = res && res.requisiciones ? (res.requisiciones.alertas_cantidad || 0) + (res.requisiciones.alertas_precio || 0) : 0;
      const head = n > 0 && nav.querySelector('.sbar-group-header[data-sbar-group="compras"]');
      if (head) { const c = document.createElement('span'); c.className = 'v2-cnt al'; c.textContent = String(n); head.appendChild(c); }
    }
    // Botones del topbar con ícono (una sola vez)
    const setOnce = (id, html) => { const el = document.getElementById(id); if (el && !el.dataset.v2) { el.dataset.v2 = '1'; el.innerHTML = html; } };
    setOnce('btnNyraV2', icon('spark', 16) + '<span>Nyra</span>');
    setOnce('btnNuevoV2', icon('plus', 16) + '<span>Nuevo</span>' + icon('chevron-down', 14));
    setOnce('btnSync', icon('refresh', 17));
  };
  V2.onNav = function () { V2.renderCrumb(); V2.renderAvisos(); V2.decorate(); };
  V2.renderMobileNav = function () { V2.sync(); };
  // Etiqueta/ícono del ítem "Ajustes" del nav móvil: "Más" en v2, "Ajustes" en v1.
  V2.sync = function () {
    const on = isUiV2();
    const btn = document.getElementById('mobileNavAjustes');
    if (btn) {
      const lbl = btn.querySelector('span:last-child');
      if (lbl) lbl.textContent = on ? 'Más' : 'Ajustes';
      const ic = document.getElementById('mobileNavAjustesIcon');
      if (ic) ic.innerHTML = icon(on ? 'more' : 'settings', 20);
    }
    if (on) V2.onNav(); else { V2.closeSheet(); V2.closeCmdk(); V2.renderAvisos(); }
  };

  // ── Cableado (una sola vez; delegación de eventos) ───────────────────────
  function wire() {
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K') && isUiV2() && state.user) {
        e.preventDefault();
        V2.openCmdk();
        return;
      }
      const box = document.getElementById('cmdk');
      if (!box || box.classList.contains('hidden-initial')) return;
      if (e.key === 'Escape') { e.preventDefault(); V2.closeCmdk(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); cmdkSel = Math.min(cmdkSel + 1, cmdkFound.length - 1); renderCmdk(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); cmdkSel = Math.max(cmdkSel - 1, 0); renderCmdk(); }
      else if (e.key === 'Enter') { e.preventDefault(); runCmdk(cmdkSel); }
    });
    const input = document.getElementById('cmdkInput');
    if (input) input.addEventListener('input', () => { cmdkSel = 0; renderCmdk(); });
    const list = document.getElementById('cmdkList');
    if (list) list.addEventListener('click', (e) => { const b = e.target.closest('.cmdk-item'); if (b) runCmdk(Number(b.dataset.i)); });
    const bd = document.getElementById('cmdkBackdrop');
    if (bd) bd.addEventListener('click', V2.closeCmdk);

    const sIc = document.querySelector('.v2-search-ic');
    if (sIc) sIc.innerHTML = icon('search', 16);
    const bCmdk = document.getElementById('btnCmdk');
    if (bCmdk) bCmdk.addEventListener('click', V2.openCmdk);
    const bNuevo = document.getElementById('btnNuevoV2');
    if (bNuevo) bNuevo.addEventListener('click', openQuickActionMenu);
    const bNyra = document.getElementById('btnNyraV2');
    if (bNyra) bNyra.addEventListener('click', () => { const fab = document.getElementById('btnAsistenteFab'); if (fab) fab.click(); });

    const crumb = document.getElementById('v2Crumb');
    if (crumb) crumb.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v2-go]');
      if (!b) return;
      if (b.dataset.v2Go === 'section') goToSection(state.section);
      else if (b.dataset.v2Go === 'clientes') goToClientGallery();
      else if (b.dataset.v2Go === 'cliente') selectCliente(Number(b.dataset.v2Id));
      else switchToView(b.dataset.v2Go);
    });

    // Centro de avisos: la acción hace click() sobre el botón original (una sola implementación).
    const avisos = document.getElementById('avisosV2');
    if (avisos) avisos.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v2-aviso]');
      if (!b) return;
      const orig = document.getElementById(b.dataset.v2Aviso);
      if (orig) orig.click();
      setTimeout(V2.renderAvisos, 50);
    });
    const bell = document.getElementById('btnNotif');
    if (bell) bell.addEventListener('click', () => V2.renderAvisos(), true);
    const mo = new MutationObserver(() => V2.renderAvisos());
    AVISOS.forEach((a) => { const el = document.getElementById(a.id); if (el) mo.observe(el, { attributes: true, attributeFilter: ['class', 'style'] }); });

    // Hoja "Más": en v2 el ítem "Ajustes" del nav móvil abre la hoja (capture: gana al handler original).
    const mAjustes = document.getElementById('mobileNavAjustes');
    if (mAjustes) mAjustes.addEventListener('click', (e) => {
      if (!isUiV2()) return;
      e.stopImmediatePropagation();
      V2.openSheet();
    }, true);
    const sheetBd = document.getElementById('sheet2Backdrop');
    if (sheetBd) sheetBd.addEventListener('click', V2.closeSheet);
    const grid = document.getElementById('sheet2Grid');
    if (grid) grid.addEventListener('click', (e) => {
      const c = e.target.closest('[data-v2-sheet]');
      if (!c) return;
      const key = c.dataset.v2Sheet;
      V2.closeSheet();
      if (key === 'ajustes') openMobileAjustes();
      else if (key.startsWith('sec:')) goToSection(key.slice(4));
      else if (key.startsWith('view:')) switchToView(key.slice(5));
    });

    // Interruptor "Probar nueva interfaz" (perfil)
    const toggle = document.getElementById('btnUiV2Popover');
    if (toggle) toggle.addEventListener('click', () => {
      closeUserPopover();
      setUiV2(!isUiV2());
      V2.sync();
    });
  }

  window.CPShellV2 = V2;
  wire();
})();
