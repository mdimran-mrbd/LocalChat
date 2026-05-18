/* LocalChat product website — interactions */
(function () {
  'use strict';

  const root = document.documentElement;
  const STORAGE_KEY = 'localchat-theme';

  // --- Theme: respect saved preference, then system, default dark ---
  function applyTheme(theme) {
    root.setAttribute('data-theme', theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0a0c12' : '#ffffff');
  }

  let saved = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch (e) { /* ignore */ }
  if (saved === 'light' || saved === 'dark') {
    applyTheme(saved);
  } else {
    const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    applyTheme(prefersLight ? 'light' : 'dark');
  }

  const toggle = document.getElementById('themeToggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try { localStorage.setItem(STORAGE_KEY, next); } catch (e) { /* ignore */ }
    });
  }

  // --- Mobile menu ---
  const menuBtn = document.getElementById('menuToggle');
  const menu = document.getElementById('mobileMenu');
  if (menuBtn && menu) {
    const setOpen = (open) => {
      menu.hidden = !open;
      menuBtn.setAttribute('aria-expanded', String(open));
    };
    menuBtn.addEventListener('click', () => setOpen(menu.hidden));
    menu.querySelectorAll('a').forEach(a => a.addEventListener('click', () => setOpen(false)));
  }

  // --- Nav shadow on scroll ---
  const nav = document.getElementById('nav');
  if (nav) {
    const onScroll = () => {
      if (window.scrollY > 8) nav.classList.add('scrolled');
      else nav.classList.remove('scrolled');
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  // --- Reveal on scroll ---
  const revealSelectors = [
    '.section-head', '.why-card', '.feature', '.shot', '.steps li',
    '.callout', '.code-card', '.faq-list details', '.cta-card', '.hero-copy', '.hero-art'
  ];
  const targets = document.querySelectorAll(revealSelectors.join(','));
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.1 });
    targets.forEach((el, i) => {
      el.classList.add('reveal');
      el.style.transitionDelay = Math.min(i * 30, 240) + 'ms';
      io.observe(el);
    });
  } else {
    targets.forEach(el => el.classList.add('in'));
  }

  // --- Year (optional, not used in markup currently) ---
})();
