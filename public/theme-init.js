(function () {
  var p = localStorage.getItem('cp_theme') || 'light';
  if (p === 'system') p = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', p);
})();
