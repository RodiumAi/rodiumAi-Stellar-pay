// StelPay docs interactions: theme toggle, mobile nav, copy buttons, tabs, search,
// active section in "On this page" and the live API status. DOM-only (no innerHTML).
(function () {
  'use strict';
  var root = document.documentElement;

  // Theme
  var themeBtn = document.querySelector('.theme');
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try {
        localStorage.setItem('stelpay-theme', next);
      } catch (e) {
        /* storage blocked */
      }
    });
  }

  // Mobile navigation
  var menu = document.querySelector('.menu');
  if (menu) {
    menu.addEventListener('click', function () {
      var open = document.body.classList.toggle('nav-open');
      menu.setAttribute('aria-expanded', String(open));
    });
  }

  // Copy buttons
  document.querySelectorAll('.code .copy').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var code = btn.closest('.code').querySelector('code');
      navigator.clipboard.writeText(code.textContent).then(function () {
        btn.textContent = 'Copied';
        btn.classList.add('done');
        setTimeout(function () {
          btn.textContent = 'Copy';
          btn.classList.remove('done');
        }, 1600);
      });
    });
  });

  // Tabs
  document.querySelectorAll('.tabs').forEach(function (tabs) {
    var buttons = tabs.querySelectorAll('[role="tab"]');
    buttons.forEach(function (b) {
      b.addEventListener('click', function () {
        buttons.forEach(function (x) {
          x.setAttribute('aria-selected', String(x === b));
        });
        tabs.querySelectorAll('[role="tabpanel"]').forEach(function (p) {
          p.hidden = p.getAttribute('data-panel') !== b.getAttribute('data-tab');
        });
      });
    });
  });

  // Live API status (same origin; CSP connect-src 'self')
  var dots = document.querySelectorAll('[data-status]');
  var labels = document.querySelectorAll('[data-status-text]');
  function setStatus(up, text) {
    dots.forEach(function (d) {
      d.classList.toggle('up', up);
      d.classList.toggle('down', !up);
    });
    labels.forEach(function (l) {
      l.textContent = text;
    });
  }
  fetch('/v1/health/ready', { cache: 'no-store' })
    .then(function (r) {
      return r.json().then(function (j) {
        if (r.ok && j.status === 'ready') setStatus(true, 'All systems operational');
        else setStatus(false, 'Degraded');
      });
    })
    .catch(function () {
      setStatus(false, 'Unavailable');
    });

  // "On this page" highlight
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll('.toc a'));
  if (tocLinks.length && 'IntersectionObserver' in window) {
    var byId = {};
    tocLinks.forEach(function (a) {
      byId[a.getAttribute('href').slice(1)] = a;
    });
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting && byId[e.target.id]) {
            tocLinks.forEach(function (a) {
              a.classList.remove('active');
            });
            byId[e.target.id].classList.add('active');
          }
        });
      },
      { rootMargin: '-70px 0px -70% 0px' },
    );
    Object.keys(byId).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) observer.observe(el);
    });
  }

  // Search ("/" or Ctrl/⌘-K to focus); the sidebar and content-top boxes share one index
  var script = document.querySelector('script[data-search]');
  var index = null;
  function load() {
    if (index || !script) return Promise.resolve(index || []);
    return fetch(script.getAttribute('data-search'))
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        index = j;
        return j;
      });
  }
  function render(box, q) {
    while (box.firstChild) box.removeChild(box.firstChild);
    var terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) {
      box.hidden = true;
      return;
    }
    var hits = (index || [])
      .map(function (e) {
        var hay = (e.t + ' ' + e.s + ' ' + e.x).toLowerCase();
        var score = 0;
        for (var i = 0; i < terms.length; i++) {
          if (hay.indexOf(terms[i]) === -1) return null;
          if (e.t.toLowerCase().indexOf(terms[i]) !== -1) score += 3;
          else score += 1;
        }
        return { e: e, score: score };
      })
      .filter(Boolean)
      .sort(function (a, b) {
        return b.score - a.score;
      })
      .slice(0, 9);
    if (!hits.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No results for “' + q + '”';
      box.appendChild(empty);
    }
    hits.forEach(function (h, i) {
      var a = document.createElement('a');
      a.href = h.e.u;
      a.setAttribute('role', 'option');
      if (i === 0) a.setAttribute('aria-selected', 'true');
      a.textContent = h.e.t;
      var s = document.createElement('span');
      s.textContent = h.e.s;
      a.appendChild(s);
      box.appendChild(a);
    });
    box.hidden = false;
  }
  var inputs = [];
  document.querySelectorAll('.search').forEach(function (wrap) {
    var input = wrap.querySelector('input');
    var box = wrap.querySelector('.results');
    if (!input || !box) return;
    inputs.push(input);
    input.addEventListener('focus', load);
    input.addEventListener('input', function () {
      load().then(function () {
        render(box, input.value);
      });
    });
    input.addEventListener('keydown', function (e) {
      var items = Array.prototype.slice.call(box.querySelectorAll('a'));
      var cur = items.findIndex(function (a) {
        return a.getAttribute('aria-selected') === 'true';
      });
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!items.length) return;
        var next = (cur + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items.forEach(function (a, i) {
          a.setAttribute('aria-selected', String(i === next));
        });
      } else if (e.key === 'Enter' && cur >= 0) {
        e.preventDefault();
        location.href = items[cur].href;
      } else if (e.key === 'Escape') {
        input.value = '';
        box.hidden = true;
        input.blur();
      }
    });
  });
  if (inputs.length) {
    document.addEventListener('keydown', function (e) {
      var typing = /input|textarea/i.test(document.activeElement.tagName);
      if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        // the first box that is visible (the sidebar one is off-screen on mobile)
        var target = inputs.filter(function (i) {
          return i.getBoundingClientRect().left >= 0 && i.offsetParent;
        })[0];
        (target || inputs[0]).focus();
      }
    });
    document.addEventListener('click', function (e) {
      document.querySelectorAll('.search .results').forEach(function (box) {
        if (!box.parentNode.contains(e.target)) box.hidden = true;
      });
    });
  }
})();
