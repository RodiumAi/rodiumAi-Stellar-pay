// Runs before first paint (loaded blocking in <head>) so the page never flashes the wrong
// theme: saved choice first, otherwise the system preference.
(function () {
  var saved = null;
  try {
    saved = localStorage.getItem('stelpay-theme');
  } catch (e) {
    /* storage blocked */
  }
  // ?theme=dark|light overrides (handy for previews and sharing a themed link).
  var forced = /[?&]theme=(dark|light)/.exec(location.search);
  if (forced) saved = forced[1];
  var dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();
