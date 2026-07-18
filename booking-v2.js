/* ================================================================
   QUIDDITY DIGITAL — booking-v2.js  v3
   4-Step Booking System

   SLOT LOGIC:
   - Available days: Mon–Sat only (Sun always blocked)
   - Slots: 11:00 AM, 1:00 PM, 3:00 PM, 5:00 PM
   - 7-day lead time block (earliest = today + 8)
   - Per-slot availability: if slot is booked, that slot is greyed
   - Date fully greyed only when ALL slots booked OR Sunday OR holiday
   - Tooltip on blocked dates: reason shown on hover/tap
   - GAS returns { bookedSlots: { "2026-06-25": ["11:00 AM","3:00 PM"] } }
   - Race-condition guard: re-check specific slot before submit
   ================================================================ */

(function () {
  'use strict';

  /* ─────────────────────────────────────────────────────────────
     CONFIG
  ───────────────────────────────────────────────────────────── */
  const GAS_URL = (typeof CONFIG !== 'undefined' && CONFIG.GAS_URL)
    ? CONFIG.GAS_URL
    : '';

  const BLOCK_DAYS = 7;

  const ALL_SLOTS = ['11:00 AM', '1:00 PM', '3:00 PM', '5:00 PM'];

  /* Indian public holidays — hardcoded (YYYY-MM-DD) */
  const PUBLIC_HOLIDAYS = {
    '2026-01-01': 'New Year\'s Day',
    '2026-01-26': 'Republic Day',
    '2026-03-20': 'Holi',
    '2026-04-03': 'Good Friday',
    '2026-04-14': 'Ambedkar Jayanti',
    '2026-04-30': 'Eid ul-Fitr',
    '2026-05-01': 'Maharashtra Day',
    '2026-06-07': 'Eid ul-Adha',
    '2026-08-15': 'Independence Day',
    '2026-08-28': 'Janmashtami',
    '2026-10-02': 'Gandhi Jayanti',
    '2026-10-21': 'Dussehra',
    '2026-11-08': 'Diwali',
    '2026-11-09': 'Diwali (Lakshmi Puja)',
    '2026-11-11': 'Bhai Dooj',
    '2026-12-25': 'Christmas',
    '2027-01-01': 'New Year\'s Day',
    '2027-01-26': 'Republic Day',
    '2027-03-10': 'Holi',
    '2027-08-15': 'Independence Day',
    '2027-10-02': 'Gandhi Jayanti',
    '2027-12-25': 'Christmas',
  };

  /* ─────────────────────────────────────────────────────────────
     STATE
  ───────────────────────────────────────────────────────────── */
  let state = {
    step: 1,
    pickedDate: null,
    pickedTime: null,
    customTime: null,
    /* bookedSlots: { "2026-06-25": ["11:00 AM"] } */
    bookedSlots: {},
    availabilityLoaded: false,
    submitting: false,
    lastSubmitMs: 0,
    bookingId: null,
    name: '', email: '', phone: '',
    bizType: '', website: '',
    primaryGoal: '', challenge: '',
    services: [],
    budget: '', bizStage: '', teamSize: '', referral: '',
  };

  /* ─────────────────────────────────────────────────────────────
     DATE HELPERS
  ───────────────────────────────────────────────────────────── */
  const MONTH_NAMES = [
    'January','February','March','April','May','June',
    'July','August','September','October','November','December'
  ];

  function localMidnight(d) {
    const c = new Date(d); c.setHours(0,0,0,0); return c;
  }
  function addDays(d, n) {
    const r = new Date(d); r.setDate(r.getDate() + n); return r;
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

  /* Find first available day (skip Sundays, holidays) */
  function findFirstAvail() {
    let d = addDays(BLOCK_UNTIL, 1);
    while (true) {
      if (d.getDay() !== 0 && !PUBLIC_HOLIDAYS[toISO(d)]) return d;
      d = addDays(d, 1);
    }
  }
  const FIRST_AVAIL = findFirstAvail();

  let calViewYear  = TODAY.getFullYear();
  let calViewMonth = TODAY.getMonth();

  /* ─────────────────────────────────────────────────────────────
     DATE STATUS HELPERS
  ───────────────────────────────────────────────────────────── */
  function isSunday(d)    { return d.getDay() === 0; }
  function isHoliday(d)   { return !!PUBLIC_HOLIDAYS[toISO(d)]; }
  function isPast(d)      { return d < TODAY; }
  function isBlocked(d)   { return d >= TODAY && d <= BLOCK_UNTIL; }

  function bookedSlotsForDate(d) {
    return state.bookedSlots[toISO(d)] || [];
  }
  function availableSlotsForDate(d) {
    /* Also filter slots that are in the past if date is today */
    const booked = bookedSlotsForDate(d);
    return ALL_SLOTS.filter(s => !booked.includes(s));
  }
  function isFullyBooked(d) {
    return availableSlotsForDate(d).length === 0;
  }

  /* Returns { type, reason } where type = 'available'|'blocked'|'unavailable' */
  function dateStatus(date) {
    if (isPast(date))    return { type: 'past',      reason: null };
    if (isSunday(date))  return { type: 'unavailable', reason: 'Closed on Sundays' };
    if (isHoliday(date)) return { type: 'unavailable', reason: PUBLIC_HOLIDAYS[toISO(date)] + ' — Holiday' };
    if (isBlocked(date)) return { type: 'blocked',   reason: 'Minimum 7-day lead time required' };
    if (isFullyBooked(date)) return { type: 'unavailable', reason: 'All slots booked' };
    return { type: 'available', reason: null };
  }

  /* ─────────────────────────────────────────────────────────────
     DOM HELPERS
  ───────────────────────────────────────────────────────────── */
  const _el  = id => document.getElementById(id);
  const _qs  = (sel, ctx) => (ctx||document).querySelector(sel);
  const _qsa = (sel, ctx) => (ctx||document).querySelectorAll(sel);

  /* ─────────────────────────────────────────────────────────────
     TOOLTIP
  ───────────────────────────────────────────────────────────── */
  let activeTooltip = null;

  function showTooltip(cell, text) {
    removeTooltip();
    const tip = document.createElement('div');
    tip.className = 'cal-tooltip';
    tip.textContent = text;
    cell.appendChild(tip);
    activeTooltip = tip;
    /* auto-dismiss on mobile after 2.5s */
    setTimeout(removeTooltip, 2500);
  }

  function removeTooltip() {
    if (activeTooltip) { activeTooltip.remove(); activeTooltip = null; }
  }

  document.addEventListener('click', (e) => {
    if (activeTooltip && !activeTooltip.closest('.cal-day')) removeTooltip();
  });

  /* ─────────────────────────────────────────────────────────────
     STEP NAVIGATION
  ───────────────────────────────────────────────────────────── */
  window.goToStep = function goToStep(n, scroll = true) {
    state.step = n;
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
    const shell = _el('bookingShell');
    if (shell && scroll) shell.scrollIntoView({ behavior:'smooth', block:'start' });
    if (n === 2) renderTimeStep();
    if (n === 3) renderDetailsStep();
    if (n === 4) renderReviewStep();
    updateDiveBrief();
  };

  /* ─────────────────────────────────────────────────────────────
     AVAILABILITY FETCH
     GAS returns: { bookedSlots: { "2026-06-25": ["11:00 AM"] } }
  ───────────────────────────────────────────────────────────── */
  async function fetchAvailability() {
    const overlay = _el('calLoadingOverlay');
    if (overlay) overlay.classList.add('show');
    try {
      const res  = await fetch(GAS_URL + '?action=getBookedSlots', {
        method: 'GET', cache: 'no-store'
      });
      if (res.ok) {
        const data = await res.json();
        if (data.bookedSlots && typeof data.bookedSlots === 'object') {
          state.bookedSlots = data.bookedSlots;
        }
      }
    } catch (_) { /* fail open — calendar still renders */ }
    state.availabilityLoaded = true;
    if (overlay) overlay.classList.remove('show');
    renderCalendar();
  }

  /* ─────────────────────────────────────────────────────────────
     CALENDAR RENDER
  ───────────────────────────────────────────────────────────── */
  function renderCalendar() {
    const grid  = _el('calDays');
    const title = _el('calTitle');
    const prev  = _el('calPrev');
    if (!grid) return;

    title.textContent = `${MONTH_NAMES[calViewMonth]} ${calViewYear}`;

    const viewStart  = new Date(calViewYear, calViewMonth, 1);
    const todayStart = new Date(TODAY.getFullYear(), TODAY.getMonth(), 1);
    if (prev) prev.disabled = viewStart <= todayStart;

    const frag        = document.createDocumentFragment();
    const firstDay    = new Date(calViewYear, calViewMonth, 1).getDay();
    const daysInMonth = new Date(calViewYear, calViewMonth + 1, 0).getDate();
    const prevMonDays = new Date(calViewYear, calViewMonth, 0).getDate();

    /* trailing prev-month ghost cells */
    for (let i = 0; i < firstDay; i++) {
      const d = document.createElement('div');
      d.className = 'cal-day other-month';
      d.textContent = prevMonDays - firstDay + 1 + i;
      frag.appendChild(d);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const date   = localMidnight(new Date(calViewYear, calViewMonth, day));
      const status = dateStatus(date);
      const cell   = document.createElement('div');
      cell.textContent = day;

      const isSelected    = state.pickedDate && sameDay(date, state.pickedDate);
      const isFirstAvail  = sameDay(date, FIRST_AVAIL);

      if (isSelected) {
        cell.className = 'cal-day selected';
      } else if (status.type === 'past') {
        cell.className = 'cal-day past';
      } else if (status.type === 'unavailable') {
        cell.className = 'cal-day blocked unavailable';
        attachBlockedBehaviour(cell, status.reason);
      } else if (status.type === 'blocked') {
        cell.className = 'cal-day blocked lead-time';
        attachBlockedBehaviour(cell, status.reason);
      } else {
        /* available */
        cell.className = 'cal-day available' + (isFirstAvail ? ' first-available' : '');
        cell.addEventListener('click', () => selectDate(date, cell));
      }

      frag.appendChild(cell);
    }

    /* trailing next-month ghost cells */
    const total    = firstDay + daysInMonth;
    const trailing = total % 7 === 0 ? 0 : 7 - (total % 7);
    for (let i = 1; i <= trailing; i++) {
      const d = document.createElement('div');
      d.className = 'cal-day other-month';
      d.textContent = i;
      frag.appendChild(d);
    }

    grid.innerHTML = '';
    grid.appendChild(frag);
  }

  function attachBlockedBehaviour(cell, reason) {
    if (!reason) return;
    /* desktop: hover */
    cell.addEventListener('mouseenter', () => showTooltip(cell, reason));
    cell.addEventListener('mouseleave', removeTooltip);
    /* mobile: tap */
    cell.addEventListener('click', (e) => {
      e.stopPropagation();
      showTooltip(cell, reason);
    });
  }

  function selectDate(date, cell) {
    /* ripple */
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    const sz = cell.offsetWidth;
    ripple.style.cssText = `width:${sz}px;height:${sz}px;left:0;top:0`;
    cell.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);

    _qsa('.cal-day.selected').forEach(el => el.classList.remove('selected'));
    cell.classList.add('selected');

    state.pickedDate = date;
    state.pickedTime = null;
    state.customTime = null;
    hideConflictMsg();
    updateDiveBrief();
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

  /* ─────────────────────────────────────────────────────────────
     STEP 1 → 2
  ───────────────────────────────────────────────────────────── */
  window.proceedStep1 = function () {
    if (!state.pickedDate) {
      showToast('Please select an available date.', 'error'); return;
    }
    goToStep(2);
  };

  /* ─────────────────────────────────────────────────────────────
     STEP 2 — TIME SLOTS
     Slots in the past (if today) are disabled.
     Booked slots are disabled.
     Suggest Another Time remains.
  ───────────────────────────────────────────────────────────── */
  function renderTimeStep() {
    const container = _el('timeGridV2');
    if (!container) return;
    container.innerHTML = '';

    /* Session banner */
    const banner = _el('sessionBanner2');
    if (banner && state.pickedDate) {
      banner.innerHTML = `
        <span class="sb-icon">📅</span>
        <span class="sb-text">${formatDateShort(state.pickedDate)}</span>
        <span class="sb-chip">Select a slot</span>`;
    }

    const frag   = document.createDocumentFragment();
    const booked = bookedSlotsForDate(state.pickedDate);
    const now    = new Date();
    const isToday = state.pickedDate && sameDay(state.pickedDate, TODAY);

    ALL_SLOTS.forEach(slot => {
      const btn = document.createElement('button');
      btn.type = 'button';

      /* Check if slot is past (only relevant if pickedDate is today) */
      let isPastSlot = false;
      if (isToday) {
        const [timePart, meridiem] = slot.split(' ');
        let [h, m] = timePart.split(':').map(Number);
        if (meridiem === 'PM' && h !== 12) h += 12;
        if (meridiem === 'AM' && h === 12) h = 0;
        const slotDate = new Date(state.pickedDate);
        slotDate.setHours(h, m, 0, 0);
        isPastSlot = slotDate <= now;
      }

      const isBooked    = booked.includes(slot);
      const isDisabled  = isBooked || isPastSlot;
      const isSelected  = state.pickedTime === slot;

      btn.className = 't-btn-v2'
        + (isSelected  ? ' t-sel'      : '')
        + (isDisabled  ? ' t-disabled' : '');

      btn.textContent = slot;
      if (isDisabled) {
        btn.disabled = true;
        btn.title    = isBooked ? 'This slot is already booked' : 'This slot has passed';
      } else {
        btn.addEventListener('click', () => {
          _qsa('.t-btn-v2').forEach(b => b.classList.remove('t-sel'));
          btn.classList.add('t-sel');
          state.pickedTime = slot;
          state.customTime = null;
          const reveal = _el('customTimeReveal');
          if (reveal) reveal.classList.remove('show');
          updateDiveBrief();
        });
      }
      frag.appendChild(btn);
    });

    /* Suggest another time */
    const suggest = document.createElement('button');
    suggest.type      = 'button';
    suggest.className = 't-btn-v2 t-suggest';
    suggest.textContent = '+ Suggest Another Time';
    suggest.addEventListener('click', () => {
      _qsa('.t-btn-v2').forEach(b => b.classList.remove('t-sel'));
      suggest.classList.add('t-sel');
      state.pickedTime = null;
      const reveal = _el('customTimeReveal');
      if (reveal) { reveal.classList.add('show'); reveal.querySelector('input')?.focus(); }
      updateDiveBrief();
    });
    frag.appendChild(suggest);

    container.appendChild(frag);

    /* Custom time input */
    const customField = _el('customTimeFieldV2');
    if (customField) {
      customField.addEventListener('change', function () {
        if (!this.value) return;
        const [h, m] = this.value.split(':').map(Number);
        const ampm   = h >= 12 ? 'PM' : 'AM';
        const h12    = h % 12 || 12;
        state.customTime = `${h12}:${String(m).padStart(2,'0')} ${ampm}`;
        state.pickedTime = null;
        updateDiveBrief();
      });
    }
  }

  window.proceedStep2 = function () {
    const effective = state.pickedTime || state.customTime;
    if (!effective) {
      showToast('Please select a time slot or suggest one.', 'error'); return;
    }
    if (!state.pickedTime && state.customTime) state.pickedTime = state.customTime;
    goToStep(3);
  };

  /* ─────────────────────────────────────────────────────────────
     STEP 3 — DETAILS
  ───────────────────────────────────────────────────────────── */
  function renderDetailsStep() {
    const banner = _el('sessionBanner3');
    if (banner && state.pickedDate && state.pickedTime) {
      banner.innerHTML = `
        <span class="sb-icon">📍</span>
        <span class="sb-text">${formatDateShort(state.pickedDate)} · ${state.pickedTime}</span>
        <span class="sb-chip">Awaiting Review</span>`;
    }
  }

  function initRadioGroups() {
    _qsa('.radio-opt').forEach(label => {
      const input = label.querySelector('input[type="radio"]');
      if (!input) return;
      input.addEventListener('change', () => {
        _qsa(`input[name="${input.name}"]`).forEach(r =>
          r.closest('.radio-opt')?.classList.remove('ro-selected'));
        label.classList.add('ro-selected');
        if (input.name === 'primaryGoal') state.primaryGoal = input.value;
        if (input.name === 'budget')      state.budget      = input.value;
        if (input.name === 'bizStage')    state.bizStage    = input.value;
        if (input.name === 'teamSize')    state.teamSize    = input.value;
        if (input.name === 'referral')    state.referral    = input.value;
        updateDiveBrief();
      });
    });

    _qsa('.outcome-chk').forEach(label => {
      const input = label.querySelector('input[type="checkbox"]');
      if (!input) return;
      input.addEventListener('change', () => {
        label.classList.toggle('oc-checked', input.checked);
        state.services = Array.from(_qsa('.outcome-chk input:checked')).map(cb => cb.value);
        updateDiveBrief();
      });
    });

    const fieldMap = {
      fName:'name', fEmail:'email', fPhone:'phone',
      fBiz:'bizType', fWebsite:'website', fChallenge:'challenge'
    };
    Object.entries(fieldMap).forEach(([id, key]) => {
      _el(id)?.addEventListener('input', function () {
        state[key] = this.value.trim(); updateDiveBrief();
      });
    });

    _qsa('.opt-section-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.classList.toggle('open');
        btn.nextElementSibling?.classList.toggle('open');
      });
    });
  }

  window.proceedStep3 = function () {
    const name   = _el('fName')?.value.trim();
    const email  = _el('fEmail')?.value.trim();
    const biz    = _el('fBiz')?.value.trim();
    const goalEl = document.querySelector('input[name="primaryGoal"]:checked');

    _qsa('.field-err').forEach(el => el.remove());

    if (!name)                        { fieldErr('fName',  'Your name is required.'); return; }
    if (!email || !validEmail(email)) { fieldErr('fEmail', 'Enter a valid email address.'); return; }
    if (!biz)                         { fieldErr('fBiz',   'Business type is required.'); return; }
    if (!goalEl)                      { showToast('Please select your primary goal.', 'error'); return; }

    state.name        = name;
    state.email       = email;
    state.phone       = _el('fPhone')?.value.trim()   || '';
    state.bizType     = biz;
    state.website     = _el('fWebsite')?.value.trim() || '';
    state.primaryGoal = goalEl.value;
    state.challenge   = _el('fChallenge')?.value.trim() || '';
    goToStep(4);
  };

  /* ─────────────────────────────────────────────────────────────
     STEP 4 — REVIEW
  ───────────────────────────────────────────────────────────── */
  function renderReviewStep() {
    const c = _el('reviewCards');
    if (!c) return;
    const svcDisplay = state.services.length
      ? state.services.join(', ') : '—';

    c.innerHTML = `
      <div class="review-card">
        <span class="rc-label">Session Date</span>
        <span class="rc-value rvc-gold">${state.pickedDate ? formatDateShort(state.pickedDate) : '—'}</span>
        <button class="rc-edit" onclick="goToStep(1)">Edit</button>
      </div>
      <div class="review-card">
        <span class="rc-label">Session Time</span>
        <span class="rc-value rvc-gold">${state.pickedTime || '—'}</span>
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

  /* ─────────────────────────────────────────────────────────────
     LEAD SCORING
  ───────────────────────────────────────────────────────────── */
  function computeLeadScore() {
    let s = 0;
    if (state.website) s += 10;
    if (['₹50k-1L','₹1L-5L','₹5L+'].includes(state.budget)) s += 20;
    if (state.bizStage === 'Scaling Aggressively') s += 20;
    if (['6-20','20+'].includes(state.teamSize)) s += 10;
    if (state.services.includes('Build A Marketing Strategy')) s += 10;
    return s;
  }

  function generateBookingId() {
    return `QD-${new Date().getFullYear()}-${String(Math.floor(Math.random()*9000)+1000)}`;
  }

  /* ─────────────────────────────────────────────────────────────
     FINAL SUBMIT — slot-level race-condition check
  ───────────────────────────────────────────────────────────── */
  window.submitBooking = async function () {
    if (state.submitting) return;
    const now = Date.now();
    if (now - state.lastSubmitMs < 30000) {
      showToast('Your request is being processed. Please wait.', 'info'); return;
    }

    const submitBtn = _el('submitBookingBtn');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Verifying availability…'; }
    state.submitting = true;

    const dateISO = state.pickedDate ? toISO(state.pickedDate) : null;
    if (!dateISO) {
      showToast('No date selected.', 'error');
      resetSubmitBtn(submitBtn); return;
    }

    /* ── Slot-level re-check ── */
    try {
      const checkUrl = `${GAS_URL}?action=checkSlot&date=${dateISO}&time=${encodeURIComponent(state.pickedTime)}`;
      const res      = await fetch(checkUrl, { method:'GET', cache:'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (data.isBooked) {
          showConflictMsg(`The ${state.pickedTime} slot on ${formatDateShort(state.pickedDate)} was just booked by someone else. Please select another time.`);
          /* refresh availability */
          state.availabilityLoaded = false;
          await fetchAvailability();
          resetSubmitBtn(submitBtn, 'Request My Session →');
          goToStep(2);
          return;
        }
      }
    } catch (_) { /* proceed optimistically */ }

    /* ── Build payload ── */
    state.lastSubmitMs = now;
    if (submitBtn) submitBtn.textContent = 'Submitting…';

    const bookingId = generateBookingId();
    state.bookingId = bookingId;

    const payload = {
      action:       'createBooking',
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
      date:         formatDateLong(state.pickedDate),
      dateISO,
      time:         state.pickedTime,
      status:       'Pending Review',
      leadScore:    computeLeadScore(),
      __hp:         _el('__hp')?.value || '',
    };

    try {
      fetch(GAS_URL, {
        method: 'POST', mode: 'no-cors', keepalive: true,
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(payload),
      });
    } catch (_) {}

    setTimeout(() => showSuccess(bookingId), 450);
  };

  function resetSubmitBtn(btn, label) {
    if (!btn) return;
    btn.disabled = false;
    btn.textContent = label || 'Request My Session →';
    state.submitting = false;
  }

  /* ─────────────────────────────────────────────────────────────
     SUCCESS
  ───────────────────────────────────────────────────────────── */
  function showSuccess(bookingId) {
    const shell   = _el('bookingShell');
    const success = _el('bookingSuccess');
    if (shell)   shell.style.display = 'none';
    if (success) {
      const idEl = success.querySelector('.success-id span');
      if (idEl) idEl.textContent = bookingId;
      success.classList.add('show');
      success.scrollIntoView({ behavior:'smooth', block:'center' });
    }
  }

  /* ─────────────────────────────────────────────────────────────
     CONFLICT MESSAGE
  ───────────────────────────────────────────────────────────── */
  function showConflictMsg(msg) {
    const el = _el('dateConflictMsg');
    if (!el) return;
    el.textContent = msg || 'This slot was just booked. Please select another time.';
    el.classList.add('show');
    el.style.display = 'flex';
  }
  function hideConflictMsg() {
    const el = _el('dateConflictMsg');
    if (el) { el.classList.remove('show'); el.style.display = 'none'; }
  }

  /* ─────────────────────────────────────────────────────────────
     DIVE BRIEF
  ───────────────────────────────────────────────────────────── */
  function updateDiveBrief() {
    const brief = _el('diveBrief');
    if (!brief) return;

    const effective  = state.pickedTime || state.customTime;
    const svcDisplay = state.services.length
      ? state.services.slice(0,2).join(', ') + (state.services.length > 2 ? ' +more' : '')
      : null;

    const checks = [state.pickedDate, effective, state.bizType, state.primaryGoal, state.name, state.email];
    const filled = checks.filter(Boolean).length;
    const pct    = Math.round((filled / checks.length) * 100);

    function setRow(id, value) {
      const row = _el(id); if (!row) return;
      const val = row.querySelector('.db-value');
      if (!val) return;
      if (value) { val.textContent = value; row.classList.remove('db-dim'); }
      else       { val.textContent = '—';   row.classList.add('db-dim'); }
    }

    setRow('db-date', state.pickedDate ? formatDateShort(state.pickedDate) : null);
    setRow('db-time', effective);
    setRow('db-biz',  state.bizType  || null);
    setRow('db-goal', state.primaryGoal || null);
    setRow('db-svc',  svcDisplay);

    const bar   = brief.querySelector('.db-bar-fill');
    const pctEl = brief.querySelector('.db-pct');
    if (bar)   bar.style.width  = pct + '%';
    if (pctEl) pctEl.textContent = pct + '%';

    if (pct > 0) brief.classList.remove('db-empty');
  }

  /* ─────────────────────────────────────────────────────────────
     VALIDATION / TOAST / FIELD ERR
  ───────────────────────────────────────────────────────────── */
  function validEmail(e) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
  }

  function setupEmailValidation() {
    const input = _el('fEmail');
    const hint  = _el('fEmailHint');
    if (!input || !hint) return;
    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const v = input.value.trim();
      if (!v) { input.classList.remove('invalid'); input.style.borderColor=''; hint.classList.remove('show'); return; }
      timer = setTimeout(() => {
        if (validEmail(v)) {
          input.classList.remove('invalid');
          input.style.borderColor = 'var(--green)';
          input.style.boxShadow   = '0 0 0 3px rgba(52,216,168,.1)';
          hint.textContent = 'Looks good';
          hint.classList.add('show');
        } else {
          input.classList.add('invalid');
          input.style.borderColor = '';
          hint.classList.remove('show');
        }
      }, 350);
    });
  }

  function fieldErr(id, msg) {
    const el = _el(id); if (!el) return;
    el.classList.add('invalid'); el.focus();
    el.parentElement.querySelector('.field-err')?.remove();
    const err = document.createElement('span');
    err.className = 'field-err'; err.textContent = msg;
    el.parentElement.appendChild(err);
    el.addEventListener('input', () => {
      el.classList.remove('invalid');
      el.parentElement.querySelector('.field-err')?.remove();
    }, { once: true });
  }

  function showToast(msg, type) {
    const c = type === 'error'
      ? { bg:'rgba(255,107,107,.12)', color:'#FF9090', border:'rgba(255,107,107,.3)' }
      : { bg:'rgba(34,217,232,.08)',  color:'var(--current-soft)', border:'var(--edge-strong)' };
    const t = document.createElement('div');
    t.setAttribute('role','alert');
    t.textContent = msg;
    Object.assign(t.style, {
      position:'fixed', bottom:'24px', right:'24px',
      background:c.bg, color:c.color, border:`1px solid ${c.border}`,
      padding:'12px 20px', borderRadius:'6px',
      fontFamily:'"Space Mono",monospace', fontSize:'.78rem',
      zIndex:'9999', boxShadow:'0 8px 32px rgba(0,0,0,.3)',
      opacity:'0', transition:'opacity .2s ease', maxWidth:'300px',
      letterSpacing:'.04em',
    });
    document.body.appendChild(t);
    requestAnimationFrame(() => t.style.opacity = '1');
    setTimeout(() => { t.style.opacity='0'; setTimeout(()=>t.remove(),220); }, 3500);
  }

  /* ─────────────────────────────────────────────────────────────
     TIMEZONE
  ───────────────────────────────────────────────────────────── */
  function showTimezone() {
    const pill = _el('tzPill');
    if (!pill) return;
    try {
      pill.textContent = `🌐 Times shown in ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
    } catch (_) {
      pill.textContent = '🌐 All times shown in your local timezone';
    }
  }

  /* ─────────────────────────────────────────────────────────────
     INIT
  ───────────────────────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', () => {
    showTimezone();
    initRadioGroups();
    setupEmailValidation();
    renderCalendar();
    fetchAvailability();
    goToStep(1, false);
    updateDiveBrief();
  });

})();
