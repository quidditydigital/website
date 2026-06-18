/* ================================================================
   QUIDDITY DIGITAL — script.js  v9

   WHAT CHANGED vs v8:
   ─────────────────────────────────────────────────────────────
   FORM SECURITY:
   - Honeypot field support (__hp) — bots fill it, humans don't
   - Duplicate submission guard: button disabled on first click,
     re-enabled only on network error. Prevents double bookings.
   - Submission lock: second submit() call within 30s is ignored

   FORM UX:
   - GAS submissions remain mode:"no-cors" (GAS CORS limitation)
     but now distinguish network errors from opaque success responses
   - submitBtn shows loading state during fetch
   - Success state is shown after a short timeout if no network error

   CONFIG:
   - GAS_URL now reads from CONFIG.GAS_URL (config.js must load first)
   ================================================================ */

/* ── 1. NAVBAR ──────────────────────────────────────────────────── */
const navbar    = document.getElementById('navbar');
const hamburger = document.getElementById('hamburger');
const navLinks  = document.getElementById('navLinks');

navbar.classList.add('solid');

hamburger.addEventListener('click', () => {
  const isOpen = hamburger.classList.toggle('open');
  navLinks.classList.toggle('open', isOpen);
  hamburger.setAttribute('aria-expanded', String(isOpen));
  document.body.classList.toggle('nav-open', isOpen);
});

function closeNav() {
  hamburger.classList.remove('open');
  navLinks.classList.remove('open');
  hamburger.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('nav-open');
}

navLinks.querySelectorAll('a').forEach(a => a.addEventListener('click', closeNav));
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && hamburger.classList.contains('open')) closeNav();
});


/* ── 2. SMOOTH SCROLL ───────────────────────────────────────────── */
document.querySelectorAll('a[href^="#"]').forEach(link => {
  link.addEventListener('click', function (e) {
    const target = document.querySelector(this.getAttribute('href'));
    if (!target) return;
    e.preventDefault();
    window.scrollTo({
      top: target.getBoundingClientRect().top + window.scrollY - 76,
      behavior: 'smooth'
    });
  });
});


/* ── 3. SCROLL REVEAL ───────────────────────────────────────────── */
const ro = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('in');
      ro.unobserve(entry.target);
    }
  });
}, { threshold: 0.1 });
document.querySelectorAll('.reveal').forEach(el => ro.observe(el));



/* ── BOOKING ── Booking calendar, steps, form, and submit
   handled by booking-v2.js (loaded separately). ─────── */

/* ── 15. HOMEPAGE BLOG LOADER ───────────────────────────────────── */
async function loadHomeBlogs() {
  const grid = document.getElementById('homeBlogGrid');
  if (!grid) return;
  try {
    const blogs  = await fetchPublishedBlogs();
    const latest = blogs.slice(0, 3);
    if (!latest.length) {
      grid.innerHTML = `
        <div style="grid-column:1/-1;text-align:center;padding:60px 20px;color:var(--tx-sub)">
          <span style="font-size:2rem;display:block;margin-bottom:12px">📭</span>
          No posts yet. Check back soon!
        </div>`;
      return;
    }
    grid.innerHTML = latest.map((b, i) => buildBlogCard(b, i)).join('');
    grid.querySelectorAll('.reveal').forEach(el => ro.observe(el));
  } catch (err) {
    console.error('[Quiddity] Blog load error:', err);
    grid.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:60px 20px;color:var(--tx-sub)">
        <span style="font-size:2rem;display:block;margin-bottom:12px">📡</span>
        Could not load posts right now. Please refresh.
      </div>`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('homeBlogGrid')) loadHomeBlogs();
});
