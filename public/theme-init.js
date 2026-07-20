(function () {
  var p = localStorage.getItem('cp_theme') || 'light';
  if (p === 'system') p = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', p);
  // Paleta (prompt-selector-paleta-colores.md) — mismo mecanismo que el modo:
  // se aplica aquí también, síncrono y antes del primer paint, para no
  // heredar el flash que ya se evitaba para dark/light pero no para paleta.
  // Default 'morada' ("Tema NYRA", prompt-fix-chart-y-2-paletas-nuevas.md) —
  // solo para quien no tiene NADA guardado; una preferencia ya guardada
  // (dorada o morada) siempre gana sobre este fallback.
  var pal = localStorage.getItem('cp_palette') || 'morada';
  document.documentElement.setAttribute('data-palette', pal);
  // Igual razón que el tema: aplicarlo aquí (antes de pintar) evita un
  // parpadeo de tamaño de fuente al cargar. Alto contraste/reducir
  // movimiento son clases en <body>, que todavía no existe en este punto
  // del parseo — esos dos se aplican en app.js (applyA11ySettings()).
  var fs = localStorage.getItem('cp_a11y_font_size') || 'normal';
  document.documentElement.setAttribute('data-font-size', fs);
})();
