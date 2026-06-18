/* ================================================================
   QUIDDITY DIGITAL — booking-v2.js
   4-Step Booking System v2

   ARCHITECTURE:
   - Fetches live availability from Google Apps Script
   - 4 steps: Date → Time → Details → Review & Submit
   - Dive Brief live-summary panel
   - Lead scoring (hidden, sent to GAS)
   - Optimistic UI + final server-side availability re-check
   - Race-condition prevention before sheet write
   ================================================================ */

(function () {
  'use strict';

  /* ──────────────────────────────────────────────────────────────
     CONFIG — reads from config.js
  ────────────────────────────────────────────────────────────── */
  const GAS_URL = (typeof CONFIG !== 'undefined' && CONFIG.GAS_URL)
    ? CONFIG.GAS_URL
    : 'https://script.google.com/macros/s/AKfycbyoBdF2gBH6VWGSNxNwb-gbe_xJZw4F9kqjgC-v7vtOPEPN5Qzw7Zsj9-mXYL0m-f7t/exec';

  const MAX_BOOKINGS_PER_DAY = 1; // configurable
  const SLOT_TIMES = ['11:00 AM', '2:00 PM', '5:00 PM'];
  const BLOCK_DAYS = 7; // days from today that are blocked

  /* ──────────────────────────────────────────────────────────────
     STATE
  ────────────────────────────────────────────────────────────── */
  let state = {
    step: 1,
    pickedDate: null,      // Date object
    pickedTime: null,      // string e.g. "2:00 PM"
    customTime: null,      // string if suggest-time used
    bookedDates: [],       // ISO date strings from GAS e.g. "2026-06-25"
    availabilityLoaded: false,
    submitting: false,
    lastSubmitMs: 0,
    bookingId: null,       // generated on success

    // Form values (mirrored for Dive Brief + Review)
    name: '',
    email: '',
    phone: '',
    bizType: '',
    website: '',
    primaryGoal: '',
    challenge: '',
    services: [],          // outcome-framed
    budget: '',
    bizStage: '',
    teamSize: '',
    referral: '',
  };

  /* ──────────────────────────────────────────────────────────────
     DATE HELPERS
  ────────────────────────────────────────────────────────────── */
  const MONTH_NAMES = [
    'January','February','March','April','May','June',
    'July','August','September','October','November','December'
  ];

  function localMidnight(d) {
    const c = new Date(d);
    c.setHours(0,0,0,0);
    return c;
  }
  function addDays(d, n) {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
  }
  function sameDay(a, b) {
    return a.getFullYear()===b.getFullYear() &&
           a.getMonth()===b.getMonth() &&
           a.getDate()===b.getDate();
  }
  function toISO(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  function formatDateLong(d) {
    return d.toLocaleDateString('en-IN', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  }
  function formatDateShort(d) {
    return d.toLocaleDateString('en-IN', { day:'numeric', month:'long', year:'numeric' });
  }

  const TODAY       = localMidnight(new Date());
  const BLOCK_UNTIL = addDays(TODAY, BLOCK_DAYS);
  const FIRST_AVAIL = addDays(TODAY, BLOCK_DAYS + 1);

  let calViewYear  = TODAY.getFullYear();
  let calViewMonth = TODAY.getMonth();

  /* ──────────────────────────────────────────────────────────────
     DOM HELPERS
  ────────────────────────────────────────────────────────────── */
  const _el  = id => document.getElementById(id);
  const _qs  = (sel, ctx) => (ctx||document).querySelector(sel);
  const _qsa = (sel, ctx) => (ctx||document).querySelectorAll(sel);

  /* ──────────────────────────────────────────────────────────────
     STEP NAVIGATION
  ────────────────────────────────────────────────────────────── */
  window.goToStep = function goToStep(n) {
    state.step = n;

    // Update steps bar
    const stepsBar = _el('stepsBar');
    if (stepsBar) stepsBar.setAttribute('data-step', n);

    [1,2,3,4].forEach(i => {
      const tab   = _el('tab' + i);
      const panel = _el('step' + i);
      if (tab) {
        tab.classList.remove('active','done');
        if (i === n) tab.classList.add('active');
        if (i < n)  tab.classList.add('done');
      }
      if (panel) panel.classList.toggle('active', i === n);
    });

    // Scroll into view
    const shell = _el('bookingShell');
    if (shell) shell.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // Refresh step content
    if (n === 2) renderTimeStep();
    if (n === 3) renderDetailsStep();
    if (n === 4) renderReviewStep();

    updateDiveBrief();
  }

  /* ──────────────────────────────────────────────────────────────
     AVAILABILITY FETCH FROM GAS
  ────────────────────────────────────────────────────────────── */
  async function fetchAvailability() {
    const overlay = _el('calLoadingOverlay');
    if (overlay) overlay.classList.add('show');

    try {
      // GAS endpoint: GET ?action=getBookedDates
      // Returns: { bookedDates: ["2026-06-25", "2026-06-28"] }
      const url = GAS_URL + '?action=getBookedDates';
      const res = await fetch(url, { method: 'GET', cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.bookedDates)) {
          state.bookedDates = data.bookedDates;
        }
      }
    } catch (_) {
      // Network error — show calendar with no external bookings
      // (conservative: don't block all dates if fetch fails)
    }

    state.availabilityLoaded = true;
    if (overlay) overlay.classList.remove('show');
    renderCalendar();
  }

  /* ──────────────────────────────────────────────────────────────
     CALENDAR RENDER
  ────────────────────────────────────────────────────────────── */
  function renderCalendar() {
    const grid    = _el('calDays');
    const title   = _el('calTitle');
    const prevBtn = _el('calPrev');
    if (!grid) return;

    title.textContent = `${MONTH_NAMES[calViewMonth]} ${calViewYear}`;

    const viewStart  = new Date(calViewYear, calViewMonth, 1);
    const todayStart = new Date(TODAY.getFullYear(), TODAY.getMonth(), 1);
    if (prevBtn) prevBtn.disabled = viewStart <= todayStart;

    const frag          = document.createDocumentFragment();
    const firstDay      = new Date(calViewYear, calViewMonth, 1).getDay();
    const daysInMonth   = new Date(calViewYear, calViewMonth + 1, 0).getDate();
    const daysInPrevMon = new Date(calViewYear, calViewMonth, 0).getDate();

    // Trailing prev-month cells
    for (let i = 0; i < firstDay; i++) {
      const d = document.createElement('div');
      d.className = 'cal-day other-month';
      d.textContent = daysInPrevMon - firstDay + 1 + i;
      frag.appendChild(d);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const date = localMidnight(new Date(calViewYear, calViewMonth, day));
      const iso  = toISO(date);
      const cell = document.createElement('div');
      cell.textContent = day;

      const isPast           = date < TODAY;
      const isBlocked        = date >= TODAY && date <= BLOCK_UNTIL;
      const isBookedExternal = state.bookedDates.includes(iso);
      const isFirstAvail     = sameDay(date, FIRST_AVAIL);
      const isAvailable      = date > BLOCK_UNTIL && !isBookedExternal;
      const isSelected       = state.pickedDate && sameDay(date, state.pickedDate);

      let cls = 'cal-day';
      if      (isSelected)        cls += ' selected';
      else if (isPast)            cls += ' past';
      else if (isBlocked)         cls += ' blocked';
      else if (isBookedExternal)  cls += ' booked-external';
      else if (isFirstAvail)      cls += ' first-available available';
      else if (isAvailable)       cls += ' available';
      else                        cls += ' blocked';

      cell.className = cls;

      if (isAvailable || isFirstAvail) {
        cell.addEventListener('click', () => selectDate(date, cell));
      }

      frag.appendChild(cell);
    }

    // Trailing next-month cells
    const totalCells = firstDay + daysInMonth;
    const trailing   = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
    for (let i = 1; i <= trailing; i++) {
      const d = document.createElement('div');
      d.className = 'cal-day other-month';
      d.textContent = i;
      frag.appendChild(d);
    }

    grid.innerHTML = '';
    grid.appendChild(frag);
  }

  function selectDate(date, cell) {
    // Ripple effect
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    const size = cell.offsetWidth;
    ripple.style.cssText = `width:${size}px;height:${size}px;left:0;top:0;margin-left:0;margin-top:0`;
    cell.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);

    // Deselect previous
    _qsa('.cal-day.selected').forEach(el => el.classList.remove('selected'));
    cell.classList.add('selected');

    state.pickedDate = date;
    state.pickedTime = null; // reset time when date changes

    updateDiveBrief();
    hideConflictMsg();
  }

  _el('calPrev')?.addEventListener('click', () => {
    calViewMonth--;
    if (calViewMonth < 0) { calViewMonth = 11; calViewYear--; }
    renderCalendar();
  });
  _el('calNext')?.addEventListener('click', () => {
    calViewMonth++;
    if (calViewMonth > 11) { calViewMonth = 0; calViewYear++; }
    renderCalendar();
  });

  /* ──────────────────────────────────────────────────────────────
     STEP 1 → 2 PROCEED
  ────────────────────────────────────────────────────────────── */
  window.proceedStep1 = function () {
    if (!state.pickedDate) {
      showToast('Please select an available date.', 'error');
      return;
    }
    goToStep(2);
  };

  /* ──────────────────────────────────────────────────────────────
     STEP 2 — TIME SELECTION
  ────────────────────────────────────────────────────────────── */
  function renderTimeStep() {
    const container = _el('timeGridV2');
    if (!container) return;
    container.innerHTML = '';

    const frag = document.createDocumentFragment();

    SLOT_TIMES.forEach(slot => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 't-btn-v2' + (state.pickedTime === slot ? ' t-sel' : '');
      btn.textContent = slot;
      btn.addEventListener('click', () => {
        _qsa('.t-btn-v2').forEach(b => b.classList.remove('t-sel'));
        btn.classList.add('t-sel');
        state.pickedTime = slot;
        state.customTime = null;
        const reveal = _el('customTimeReveal');
        if (reveal) reveal.classList.remove('show');
        updateDiveBrief();
      });
      frag.appendChild(btn);
    });

    // Suggest Another Time
    const suggest = document.createElement('button');
    suggest.type = 'button';
    suggest.className = 't-btn-v2 t-suggest' + (!state.pickedTime && state.customTime ? ' t-sel' : '');
    suggest.textContent = '+ Suggest Another Time';
    suggest.addEventListener('click', () => {
      _qsa('.t-btn-v2').forEach(b => b.classList.remove('t-sel'));
      suggest.classList.add('t-sel');
      state.pickedTime = null;
      const reveal = _el('customTimeReveal');
      if (reveal) {
        reveal.classList.add('show');
        reveal.querySelector('input')?.focus();
      }
      updateDiveBrief();
    });
    frag.appendChild(suggest);

    container.appendChild(frag);

    // Custom time field handler
    const customField = _el('customTimeFieldV2');
    if (customField) {
      customField.addEventListener('change', function () {
        if (!this.value) return;
        const [h, m] = this.value.split(':').map(Number);
        const ampm = h >= 12 ? 'PM' : 'AM';
        const h12  = h % 12 || 12;
        state.customTime = `${h12}:${String(m).padStart(2,'0')} ${ampm}`;
        state.pickedTime = null;
        updateDiveBrief();
      });
    }
  }

  window.proceedStep2 = function () {
    const effectiveTime = state.pickedTime || state.customTime;
    if (!effectiveTime) {
      showToast('Please select a time slot or suggest one.', 'error');
      return;
    }
    if (!state.pickedTime && state.customTime) {
      state.pickedTime = state.customTime;
    }
    goToStep(3);
  };

  /* ──────────────────────────────────────────────────────────────
     STEP 3 — DETAILS (radio group live-binding)
  ────────────────────────────────────────────────────────────── */
  function renderDetailsStep() {
    // Session banner at top of step 3
    const banner = _el('sessionBanner3');
    if (banner && state.pickedDate && state.pickedTime) {
      const dateTxt = formatDateShort(state.pickedDate);
      banner.innerHTML = `
        <span class="sb-icon">📍</span>
        <span class="sb-text">${dateTxt} · ${state.pickedTime}</span>
        <span class="sb-chip">Awaiting Review</span>
      `;
    }
  }

  // Radio options auto-style when selected
  function initRadioGroups() {
    _qsa('.radio-opt').forEach(label => {
      const input = label.querySelector('input[type="radio"]');
      if (!input) return;
      input.addEventListener('change', () => {
        const groupName = input.name;
        _qsa(`input[name="${groupName}"]`).forEach(r => {
          r.closest('.radio-opt')?.classList.remove('ro-selected');
        });
        label.classList.add('ro-selected');

        // Mirror state
        if (groupName === 'primaryGoal') state.primaryGoal = input.value;
        if (groupName === 'budget')      state.budget = input.value;
        if (groupName === 'bizStage')    state.bizStage = input.value;
        if (groupName === 'teamSize')    state.teamSize = input.value;
        if (groupName === 'referral')    state.referral = input.value;

        updateDiveBrief();
      });
    });

    // Outcome checkboxes
    _qsa('.outcome-chk').forEach(label => {
      const input = label.querySelector('input[type="checkbox"]');
      if (!input) return;
      input.addEventListener('change', () => {
        label.classList.toggle('oc-checked', input.checked);
        state.services = Array.from(_qsa('.outcome-chk input:checked'))
          .map(cb => cb.value);
        updateDiveBrief();
      });
    });

    // Live-mirror text fields into state
    const fieldMap = {
      fName: 'name', fEmail: 'email', fPhone: 'phone',
      fBiz: 'bizType', fWebsite: 'website', fChallenge: 'challenge'
    };
    Object.entries(fieldMap).forEach(([id, key]) => {
      _el(id)?.addEventListener('input', function () {
        state[key] = this.value.trim();
        updateDiveBrief();
      });
    });

    // Optional section toggle
    _qsa('.opt-section-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.classList.toggle('open');
        const body = btn.nextElementSibling;
        if (body) body.classList.toggle('open');
      });
    });
  }

  window.proceedStep3 = function () {
    const name    = _el('fName')?.value.trim();
    const email   = _el('fEmail')?.value.trim();
    const biz     = _el('fBiz')?.value.trim();
    const goalEl  = _qs('input[name="primaryGoal"]:checked');

    // Clear previous errors
    _qsa('.field-err').forEach(el => el.remove());
    _qsa('.fg input.invalid, .fg textarea.invalid').forEach(el => el.classList.remove('invalid'));

    if (!name)              { fieldErr('fName',  'Your name is required.'); return; }
    if (!email || !validEmail(email)) { fieldErr('fEmail', 'Enter a valid email address.'); return; }
    if (!biz)               { fieldErr('fBiz',   'Business type is required.'); return; }
    if (!goalEl)            { showToast('Please select your primary goal.', 'error'); return; }

    state.name       = name;
    state.email      = email;
    state.phone      = _el('fPhone')?.value.trim() || '';
    state.bizType    = biz;
    state.website    = _el('fWebsite')?.value.trim() || '';
    state.primaryGoal = goalEl.value;
    state.challenge  = _el('fChallenge')?.value.trim() || '';

    goToStep(4);
  };

  /* ──────────────────────────────────────────────────────────────
     STEP 4 — REVIEW
  ────────────────────────────────────────────────────────────── */
  function renderReviewStep() {
    const container = _el('reviewCards');
    if (!container) return;

    const effectiveTime = state.pickedTime || state.customTime || '—';
    const svcDisplay    = state.services.length ? state.services.join(', ') : '—';

    container.innerHTML = `
      <div class="review-card">
        <span class="rc-label">Session Date</span>
        <span class="rc-value rvc-gold">${state.pickedDate ? formatDateShort(state.pickedDate) : '—'}</span>
        <button class="rc-edit" onclick="goToStep(1)">Edit</button>
      </div>
      <div class="review-card">
        <span class="rc-label">Session Time</span>
        <span class="rc-value rvc-gold">${effectiveTime}</span>
        <button class="rc-edit" onclick="goToStep(2)">Edit</button>
      </div>
      <div class="review-card">
        <span class="rc-label">Name</span>
        <span class="rc-value">${state.name || '—'}</span>
        <button class="rc-edit" onclick="goToStep(3)">Edit</button>
      </div>
      <div class="review-card">
        <span class="rc-label">Email</span>
        <span class="rc-value">${state.email || '—'}</span>
        <button class="rc-edit" onclick="goToStep(3)">Edit</button>
      </div>
      <div class="review-card">
        <span class="rc-label">Business Type</span>
        <span class="rc-value">${state.bizType || '—'}</span>
        <button class="rc-edit" onclick="goToStep(3)">Edit</button>
      </div>
      <div class="review-card">
        <span class="rc-label">Primary Goal</span>
        <span class="rc-value">${state.primaryGoal || '—'}</span>
        <button class="rc-edit" onclick="goToStep(3)">Edit</button>
      </div>
      ${state.website ? `<div class="review-card"><span class="rc-label">Website</span><span class="rc-value">${state.website}</span><button class="rc-edit" onclick="goToStep(3)">Edit</button></div>` : ''}
      ${svcDisplay !== '—' ? `<div class="review-card" style="grid-column:span 2"><span class="rc-label">Looking For Help With</span><span class="rc-value">${svcDisplay}</span><button class="rc-edit" onclick="goToStep(3)">Edit</button></div>` : ''}
    `;
  }

  /* ──────────────────────────────────────────────────────────────
     LEAD SCORING (hidden)
  ────────────────────────────────────────────────────────────── */
  function computeLeadScore() {
    let score = 0;
    if (state.website)                                      score += 10;
    if (['₹50k-1L','₹1L-5L','₹5L+'].includes(state.budget)) score += 20;
    if (state.bizStage === 'Scaling Aggressively')           score += 20;
    if (['6-20','20+'].includes(state.teamSize))             score += 10;
    if (state.services.includes('Build A Marketing Strategy')) score += 10;
    return score;
  }

  /* ──────────────────────────────────────────────────────────────
     BOOKING ID GENERATOR
  ────────────────────────────────────────────────────────────── */
  function generateBookingId() {
    const year = new Date().getFullYear();
    const rand = String(Math.floor(Math.random() * 9000) + 1000);
    return `QD-${year}-${rand}`;
  }

  /* ──────────────────────────────────────────────────────────────
     FINAL SUBMIT — with server-side availability re-check
  ────────────────────────────────────────────────────────────── */
  window.submitBooking = async function () {
    if (state.submitting) return;
    const now = Date.now();
    if (now - state.lastSubmitMs < 30000) {
      showToast('Your request is being processed. Please wait.', 'info');
      return;
    }

    const submitBtn = _el('submitBookingBtn');
    if (submitBtn) {
      submitBtn.disabled    = true;
      submitBtn.textContent = 'Verifying availability…';
    }
    state.submitting = true;

    /* ── 1. Final server-side availability re-check ── */
    const dateISO = state.pickedDate ? toISO(state.pickedDate) : null;
    if (!dateISO) {
      showToast('No date selected. Please start over.', 'error');
      resetSubmitBtn(submitBtn);
      return;
    }

    try {
      const checkUrl = GAS_URL + `?action=checkDate&date=${dateISO}&maxPerDay=${MAX_BOOKINGS_PER_DAY}`;
      const checkRes = await fetch(checkUrl, { method: 'GET', cache: 'no-store' });
      if (checkRes.ok) {
        const checkData = await checkRes.json();
        if (checkData.isBooked) {
          // Race condition — someone else booked while user filled form
          showConflictMsg();
          // Re-fetch availability to update calendar
          state.availabilityLoaded = false;
          fetchAvailability();
          resetSubmitBtn(submitBtn, 'Request My Session →');
          // Go back to step 1 without losing form data
          goToStep(1);
          return;
        }
      }
    } catch (_) {
      // If check fails, proceed optimistically (GAS handles final write-lock)
    }

    /* ── 2. Build payload ── */
    state.lastSubmitMs = now;
    if (submitBtn) submitBtn.textContent = 'Submitting…';

    const bookingId = generateBookingId();
    state.bookingId = bookingId;

    const effectiveTime = state.pickedTime || state.customTime || '';
    const dateStr       = formatDateLong(state.pickedDate);
    const honeypot      = _el('__hp')?.value || '';

    const payload = {
      action: 'createBooking',
      bookingId,
      name:         state.name,
      email:        state.email,
      phone:        state.phone,
      businessType: state.bizType,
      website:      state.website,
      primaryGoal:  state.primaryGoal,
      challenge:    state.challenge,
      services:     state.services.join(', '),
      budget:       state.budget,
      bizStage:     state.bizStage,
      teamSize:     state.teamSize,
      referral:     state.referral,
      date:         dateStr,
      dateISO,
      time:         effectiveTime,
      status:       'Pending Review',
      leadScore:    computeLeadScore(),
      __hp:         honeypot,
    };

    /* ── 3. Fire to GAS (no-cors — opaque response) ── */
    try {
      fetch(GAS_URL, {
        method:    'POST',
        mode:      'no-cors',
        keepalive: true,
        headers:   { 'Content-Type': 'text/plain' },
        body:      JSON.stringify(payload),
      });
    } catch (_) {
      // Swallow — GAS processes regardless
    }

    // Small delay then show success
    setTimeout(() => showSuccess(bookingId), 450);
  };

  function resetSubmitBtn(btn, label) {
    if (!btn) return;
    btn.disabled    = false;
    btn.textContent = label || 'Request My Session →';
    state.submitting = false;
  }

  /* ──────────────────────────────────────────────────────────────
     SUCCESS STATE
  ────────────────────────────────────────────────────────────── */
  function showSuccess(bookingId) {
    const shell   = _el('bookingShell');
    const success = _el('bookingSuccess');
    if (shell)   shell.style.display = 'none';
    if (success) {
      // Inject booking ID
      const idEl = success.querySelector('.success-id span');
      if (idEl) idEl.textContent = bookingId;
      success.classList.add('show');
      success.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  /* ──────────────────────────────────────────────────────────────
     CONFLICT MESSAGE (race condition)
  ────────────────────────────────────────────────────────────── */
  function showConflictMsg() {
    const el = _el('dateConflictMsg');
    if (el) el.classList.add('show');
  }
  function hideConflictMsg() {
    const el = _el('dateConflictMsg');
    if (el) el.classList.remove('show');
  }

  /* ──────────────────────────────────────────────────────────────
     DIVE BRIEF — live sidebar update
  ────────────────────────────────────────────────────────────── */
  function updateDiveBrief() {
    const brief = _el('diveBrief');
    if (!brief) return;

    const effectiveTime = state.pickedTime || state.customTime;
    const svcDisplay    = state.services.length ? state.services.slice(0,2).join(', ') + (state.services.length > 2 ? ' +more' : '') : null;

    // Compute readiness percentage
    let filled = 0;
    const checks = [
      state.pickedDate,
      effectiveTime,
      state.bizType,
      state.primaryGoal,
      state.name,
      state.email,
    ];
    checks.forEach(v => { if (v) filled++ });
    const pct = Math.round((filled / checks.length) * 100);

    // Update rows
    function setRow(id, value, dimIfEmpty) {
      const row = _el(id);
      if (!row) return;
      const val = row.querySelector('.db-value');
      if (!val) return;
      if (value) {
        val.textContent = value;
        row.classList.remove('db-dim');
      } else {
        val.textContent = '—';
        if (dimIfEmpty) row.classList.add('db-dim');
      }
    }

    setRow('db-date',    state.pickedDate ? formatDateShort(state.pickedDate) : null, true);
    setRow('db-time',    effectiveTime, true);
    setRow('db-biz',     state.bizType || null, true);
    setRow('db-goal',    state.primaryGoal || null, true);
    setRow('db-svc',     svcDisplay, true);

    // Bar
    const bar = brief.querySelector('.db-bar-fill');
    if (bar) bar.style.width = pct + '%';
    const pctEl = brief.querySelector('.db-pct');
    if (pctEl) pctEl.textContent = pct + '%';

    // Mobile: show/hide the panel
    if (pct > 0) brief.classList.remove('db-empty');
  }

  /* ──────────────────────────────────────────────────────────────
     EMAIL & FIELD VALIDATION
  ────────────────────────────────────────────────────────────── */
  function validEmail(e) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
  }

  function setupEmailValidation() {
    const emailInput = _el('fEmail');
    const hint       = _el('fEmailHint');
    if (!emailInput || !hint) return;
    let timer;
    emailInput.addEventListener('input', () => {
      clearTimeout(timer);
      const val = emailInput.value.trim();
      if (!val) {
        emailInput.classList.remove('invalid');
        emailInput.style.borderColor = '';
        hint.classList.remove('show');
        return;
      }
      timer = setTimeout(() => {
        if (validEmail(val)) {
          emailInput.classList.remove('invalid');
          emailInput.style.borderColor = 'var(--green)';
          emailInput.style.boxShadow   = '0 0 0 3px rgba(52,216,168,.1)';
          hint.textContent = 'Looks good';
          hint.classList.add('show');
        } else {
          emailInput.classList.add('invalid');
          emailInput.style.borderColor = '';
          hint.classList.remove('show');
        }
      }, 350);
    });
  }

  function fieldErr(id, msg) {
    const el = _el(id);
    if (!el) return;
    el.classList.add('invalid');
    el.focus();
    el.parentElement.querySelector('.field-err')?.remove();
    const err = document.createElement('span');
    err.className   = 'field-err';
    err.textContent = msg;
    el.parentElement.appendChild(err);
    el.addEventListener('input', () => {
      el.classList.remove('invalid');
      el.parentElement.querySelector('.field-err')?.remove();
    }, { once: true });
  }

  /* ──────────────────────────────────────────────────────────────
     TOAST
  ────────────────────────────────────────────────────────────── */
  function showToast(msg, type) {
    const colors = {
      error: { bg: 'rgba(255,107,107,.12)', color: '#FF9090', border: 'rgba(255,107,107,.3)' },
      info:  { bg: 'rgba(34,217,232,.08)',  color: 'var(--current-soft)', border: 'var(--edge-strong)' },
    };
    const c = colors[type] || colors.info;
    const t = document.createElement('div');
    t.setAttribute('role', 'alert');
    t.textContent = msg;
    Object.assign(t.style, {
      position: 'fixed', bottom: '24px', right: '24px',
      background: c.bg, color: c.color, border: `1px solid ${c.border}`,
      padding: '12px 20px', borderRadius: '6px',
      fontFamily: '"Space Mono", monospace', fontSize: '.78rem',
      zIndex: '9999', boxShadow: '0 8px 32px rgba(0,0,0,.3)',
      opacity: '0', transition: 'opacity .2s ease', maxWidth: '300px',
      letterSpacing: '.04em',
    });
    document.body.appendChild(t);
    requestAnimationFrame(() => t.style.opacity = '1');
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 220); }, 3500);
  }

  /* ──────────────────────────────────────────────────────────────
     TIMEZONE
  ────────────────────────────────────────────────────────────── */
  function showTimezone() {
    const pill = _el('tzPill');
    if (!pill) return;
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      pill.textContent = `🌐 Times shown in ${tz}`;
    } catch (_) {
      pill.textContent = '🌐 All times shown in your local timezone';
    }
  }

  /* ──────────────────────────────────────────────────────────────
     INIT
  ────────────────────────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', () => {
    showTimezone();
    initRadioGroups();
    setupEmailValidation();

    // Initial calendar render (no availability yet)
    renderCalendar();

    // Fetch availability from Google Sheets
    fetchAvailability();

    // Start at step 1
    goToStep(1);

    // Init dive brief
    updateDiveBrief();
  });

})();
