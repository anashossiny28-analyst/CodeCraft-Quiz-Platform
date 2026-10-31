/* ============================================================================
   CODE CRAFT — QUIZ PLATFORM
   js/ui-helpers.js

   Small, reusable UI building blocks. No Firebase here — every other module can
   import from this file.

     1. Safe HTML           html`...` escapes every value automatically
     2. DOM helpers         $, $$, delegate, debounce
     3. Formatting          dates, times, durations, percentages
     4. Icons               inline SVG, one function: icon("bell")
     5. Toast               toast("Saved", { type: "success" })
     6. Modals              openModal(), confirmDialog(), alertDialog()
     7. Forms & buttons     readForm, field errors, password toggle, withBusy
     8. Badges, avatars, ranks, empty states, loading placeholders
     9. Donut charts        pure SVG, no library
    10. Footer             renderFooter()
    11. Connection         offline banner / "Connection restored"
    12. Misc               WhatsApp link, clipboard, asset paths

   Styling lives in style.css. Elements created here use these class names:
     toast, toast-{info|success|error}, is-visible
     modal-overlay, modal, modal-{sm|md|lg}, modal-header, modal-title, modal-close,
       modal-body, modal-actions, modal-open (on <body>)
     btn, btn-{primary|secondary|danger|ghost}, is-busy
     badge, badge-{green|red|orange|blue|gray|accent}
     avatar, avatar-{male|female|neutral}
     donut, donut-ring, donut-track, donut-arc, tone-{green|red|orange|accent|blue},
       donut-center, donut-label     (donut-arc reads CSS variables --dash and --circ)
     empty-state, skeleton, skeleton-row
     site-footer, footer-*  ,  offline-banner, field-error, form-error
   ============================================================================ */

/* ============================================================================
   1. SAFE HTML
   Student-written text (names, essay answers, notes) is shown on staff screens.
   If it were inserted as raw HTML, a malicious student could run code in a
   teacher's browser. So never concatenate user text into innerHTML — use html``:

       setHtml(box, html`<p>${student.name}</p>`);     // name is escaped
   ============================================================================ */

class SafeHtml {
  constructor(value) { this.value = String(value); }
  toString() { return this.value; }
}

/** Marks a string as already-safe markup (only for strings YOU wrote, e.g. an SVG). */
export const raw = (value) => new SafeHtml(value);

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderValue(value) {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(renderValue).join("");
  return escapeHtml(value);
}

/** Tagged template: values are escaped unless they are SafeHtml (from html``, icon(), raw()). */
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((value, i) => { out += renderValue(value) + strings[i + 1]; });
  return new SafeHtml(out);
}

/** Puts content into an element. Plain strings are shown as TEXT, never as markup. */
export function setHtml(element, content) {
  element.innerHTML = renderValue(content);
}

/* ============================================================================
   2. DOM HELPERS
   ============================================================================ */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/**
 * One listener on a parent instead of one per child — works for elements added later.
 *   delegate(list, "click", "[data-action='delete']", (event, button) => ...)
 * @returns {Function} call it to remove the listener
 */
export function delegate(root, eventName, selector, handler) {
  const listener = (event) => {
    const target = event.target.closest(selector);
    if (target && root.contains(target)) handler(event, target);
  };
  root.addEventListener(eventName, listener);
  return () => root.removeEventListener(eventName, listener);
}

/** Delays `fn` until `wait` ms after the last call. The result has .flush() and .cancel(). */
export function debounce(fn, wait = 500) {
  let timer = null;
  let lastArgs = null;

  const debounced = (...args) => {
    lastArgs = args;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const a = lastArgs; lastArgs = null;
      fn(...a);
    }, wait);
  };
  debounced.flush = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    const a = lastArgs; lastArgs = null;
    fn(...a);
  };
  debounced.cancel = () => { clearTimeout(timer); timer = null; lastArgs = null; };
  return debounced;
}

export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
export const pad2 = (n) => String(n).padStart(2, "0");

export function scrollToTop() {
  window.scrollTo({ top: 0, behavior: "auto" });
}

/* ============================================================================
   3. FORMATTING
   Accepts a Date, milliseconds, or a Firestore Timestamp.
   ============================================================================ */

export function toDate(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  if (typeof value.toDate === "function") return value.toDate();
  if (typeof value.toMillis === "function") return new Date(value.toMillis());
  return null;
}

/** "Sep 08, 2026" */
export function formatDate(value) {
  const d = toDate(value);
  if (!d) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });
}

/** "3:05 PM" */
export function formatTime(value) {
  const d = toDate(value);
  if (!d) return "—";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** "Sep 08, 2026 · 3:05 PM" */
export function formatDateTime(value) {
  const d = toDate(value);
  if (!d) return "—";
  return `${formatDate(d)} · ${formatTime(d)}`;
}

/** For <input type="datetime-local"> — local time as "YYYY-MM-DDTHH:mm". */
export function toDateTimeLocalValue(value) {
  const d = toDate(value);
  if (!d) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Reads a datetime-local input value back into milliseconds (or null). */
export function fromDateTimeLocalValue(text) {
  if (!text) return null;
  const ms = new Date(text).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** Countdown clock: 1520 → "25:20",  5400 → "1:30:00" */
export function formatClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(sec)}` : `${pad2(m)}:${pad2(sec)}`;
}

/** Exam length: 1800 → "30 min",  5400 → "1 h 30 min" */
export function formatDuration(totalSeconds) {
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Time left until a deadline: milliseconds → "1d 4h", "2h 10m", "35m", "less than a minute" */
export function formatCountdown(ms) {
  if (ms <= 0) return "0m";
  const minutes = Math.floor(ms / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins ? `${hours}h ${mins}m` : `${hours}h`;
  if (mins > 0) return `${mins}m`;
  return "less than a minute";
}

/** 85 → "85%", 85.5 → "85.5%", null → "—" */
export function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${Number.isInteger(value) ? value : Number(value).toFixed(1)}%`;
}

/** 2 → "2", 2.5 → "2.5" */
export function formatPoints(value) {
  if (value === null || value === undefined) return "—";
  return Number.isInteger(value) ? String(value) : Number(value).toFixed(1);
}

/** "01012345678" stays; "+20 101 234 5678" → "01012345678" (display only). */
export function formatQuestionNumber(n) {
  return pad2(n);
}

/* ============================================================================
   4. ICONS
   icon("bell")  /  icon("bell", { size: 20 })  →  SafeHtml
   Stroke icons use currentColor, so CSS `color` controls them.
   ============================================================================ */

const STROKE = (inner) => ({ fill: false, inner });
const FILL = (inner) => ({ fill: true, inner });

const ICONS = {
  home: STROKE('<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>'),
  results: STROKE('<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>'),
  ranking: STROKE('<circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/>'),
  report: STROKE('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>'),
  homework: STROKE('<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>'),
  lessons: STROKE('<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>'),
  bell: STROKE('<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>'),
  user: STROKE('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  users: STROKE('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  dashboard: STROKE('<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>'),
  logout: STROKE('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>'),
  eye: STROKE('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
  "eye-off": STROKE('<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'),
  check: STROKE('<polyline points="20 6 9 17 4 12"/>'),
  "check-circle": STROKE('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>'),
  x: STROKE('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  clock: STROKE('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
  alert: STROKE('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
  trash: STROKE('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>'),
  pencil: STROKE('<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>'),
  plus: STROKE('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  copy: STROKE('<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  image: STROKE('<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>'),
  bookmark: STROKE('<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>'),
  lock: STROKE('<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
  shield: STROKE('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
  menu: STROKE('<line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>'),
  "chevron-right": STROKE('<polyline points="9 18 15 12 9 6"/>'),
  "chevron-left": STROKE('<polyline points="15 18 9 12 15 6"/>'),
  "chevron-down": STROKE('<polyline points="6 9 12 15 18 9"/>'),

  /* brand icons (footer / report) */
  facebook: STROKE('<path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/>'),
  instagram: STROKE('<rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/>'),
  linkedin: STROKE('<path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z"/><rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/>'),
  youtube: STROKE('<path d="M22.54 6.42a2.78 2.78 0 0 0-1.94-2C18.88 4 12 4 12 4s-6.88 0-8.6.46a2.78 2.78 0 0 0-1.94 2A29 29 0 0 0 1 11.75a29 29 0 0 0 .46 5.33A2.78 2.78 0 0 0 3.4 19c1.72.46 8.6.46 8.6.46s6.88 0 8.6-.46a2.78 2.78 0 0 0 1.94-2 29 29 0 0 0 .46-5.25 29 29 0 0 0-.46-5.33z"/><polygon points="9.75 15.02 15.5 11.75 9.75 8.48 9.75 15.02"/>'),
  tiktok: STROKE('<path d="M9 12a4 4 0 1 0 4 4V4a5 5 0 0 0 5 5"/>'),
  whatsapp: FILL('<path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.71.44 3.37 1.29 4.84L2 22l5.4-1.42a9.9 9.9 0 0 0 4.64 1.18h.01c5.46 0 9.9-4.45 9.9-9.91C21.96 6.45 17.5 2 12.04 2Zm0 18.06h-.01a8.2 8.2 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.17 8.17 0 0 1-1.26-4.38c0-4.53 3.69-8.22 8.24-8.22 2.2 0 4.27.86 5.82 2.42a8.17 8.17 0 0 1 2.41 5.81c0 4.53-3.69 8.23-8.22 8.23Zm4.51-6.16c-.25-.12-1.47-.72-1.7-.81-.23-.08-.39-.12-.56.13-.17.25-.64.81-.78.97-.14.17-.29.19-.53.06-.25-.12-1.05-.39-2-1.23-.74-.66-1.24-1.48-1.39-1.72-.14-.25-.02-.38.11-.51.11-.11.25-.29.37-.43.12-.15.16-.25.25-.42.08-.17.04-.31-.02-.43-.06-.12-.56-1.36-.77-1.86-.2-.48-.41-.42-.56-.43h-.48c-.17 0-.44.06-.67.31-.23.25-.87.85-.87 2.08 0 1.23.89 2.41 1.02 2.58.12.17 1.75 2.67 4.24 3.74.59.26 1.06.41 1.42.52.6.19 1.14.16 1.57.1.48-.07 1.47-.6 1.68-1.18.21-.58.21-1.07.15-1.18-.06-.1-.23-.17-.48-.29Z"/>'),

  /* faceless person for avatars (filled) */
  person: FILL('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7z"/>')
};

/** @param {string} name  @param {{size?: number, className?: string}} options */
export function icon(name, { size = 20, className = "" } = {}) {
  const def = ICONS[name];
  if (!def) return raw("");
  const paint = def.fill
    ? 'fill="currentColor" stroke="none"'
    : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  return raw(
    `<svg class="icon ${escapeHtml(className)}" width="${size}" height="${size}" viewBox="0 0 24 24" ${paint} aria-hidden="true" focusable="false">${def.inner}</svg>`
  );
}

/* ============================================================================
   5. TOAST
   One message at a time. role="status" lets screen readers announce it.
   ============================================================================ */

let toastTimer = null;

/** @param {{type?: "info"|"success"|"error", duration?: number}} options */
export function toast(message, { type = "info", duration = 3500 } = {}) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  el.className = `toast toast-${type}`;
  el.textContent = message;
  // restart the CSS transition if a toast is already showing
  void el.offsetWidth;
  el.classList.add("is-visible");

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("is-visible"), duration);
}

/* ============================================================================
   6. MODALS
   ============================================================================ */

let activeModal = null;

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * @param {object}   options
 * @param {string}   options.title
 * @param {SafeHtml|string|Node} options.content   body (strings are shown as text)
 * @param {{label: string, variant?: "primary"|"secondary"|"danger"|"ghost", value?: any,
 *          closes?: boolean, onClick?: Function}[]} options.actions
 * @param {boolean}  options.dismissible  Esc / outside click / ✕ close it (default true)
 * @param {"sm"|"md"|"lg"} options.size
 * @returns {{root: HTMLElement, body: HTMLElement, close: Function, setBusy: Function, result: Promise<any>}}
 *   `result` resolves with the clicked action's `value` (or undefined if dismissed).
 */
export function openModal({ title, content, actions = [], dismissible = true, size = "md", className = "" }) {
  if (activeModal) activeModal.close(undefined);

  const previousFocus = document.activeElement;
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";

  const dialog = document.createElement("div");
  dialog.className = `modal modal-${size} ${className}`.trim();
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "modal-title");
  dialog.tabIndex = -1;

  const header = document.createElement("div");
  header.className = "modal-header";
  const titleEl = document.createElement("h2");
  titleEl.id = "modal-title";
  titleEl.className = "modal-title";
  titleEl.textContent = title || "";
  header.appendChild(titleEl);

  if (dismissible) {
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "modal-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML = icon("x", { size: 18 }).value;
    closeBtn.addEventListener("click", () => api.close(undefined));
    header.appendChild(closeBtn);
  }

  const body = document.createElement("div");
  body.className = "modal-body";
  if (content instanceof Node) body.appendChild(content);
  else setHtml(body, content ?? "");

  dialog.append(header, body);

  const actionButtons = [];
  if (actions.length) {
    const bar = document.createElement("div");
    bar.className = "modal-actions";
    actions.forEach((action) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `btn btn-${action.variant || "secondary"}`;
      btn.textContent = action.label;
      btn.addEventListener("click", async () => {
        if (action.onClick) await action.onClick(api);
        if (action.closes !== false) api.close(action.value);
      });
      actionButtons.push(btn);
      bar.appendChild(btn);
    });
    dialog.appendChild(bar);
  }

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  document.body.classList.add("modal-open");

  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });
  let closed = false;

  const onKeydown = (event) => {
    if (event.key === "Escape" && dismissible) {
      event.stopPropagation();
      api.close(undefined);
      return;
    }
    if (event.key === "Tab") {
      const items = $$(FOCUSABLE, dialog);
      if (!items.length) { event.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener("keydown", onKeydown, true);

  if (dismissible) {
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) api.close(undefined);
    });
  }

  const api = {
    root: dialog,
    body,
    result,
    /** Disables all action buttons while an async action runs. */
    setBusy(isBusy) {
      actionButtons.forEach((b) => { b.disabled = isBusy; });
    },
    close(value) {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKeydown, true);
      overlay.remove();
      document.body.classList.remove("modal-open");
      if (activeModal === api) activeModal = null;
      if (previousFocus && typeof previousFocus.focus === "function") previousFocus.focus();
      resolveResult(value);
    }
  };

  activeModal = api;
  (actionButtons[actionButtons.length - 1] || $(FOCUSABLE, dialog) || dialog).focus();
  return api;
}

export function closeModal(value) {
  if (activeModal) activeModal.close(value);
}

export function isModalOpen() {
  return activeModal !== null;
}

/** @returns {Promise<boolean>} true when confirmed */
export async function confirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  dismissible = true
}) {
  const modal = openModal({
    title,
    content: html`<p class="modal-text">${message}</p>`,
    dismissible,
    size: "sm",
    actions: [
      { label: cancelLabel, variant: "secondary", value: false },
      { label: confirmLabel, variant: danger ? "danger" : "primary", value: true }
    ]
  });
  return (await modal.result) === true;
}

export async function alertDialog({ title, message, buttonLabel = "OK", dismissible = true }) {
  const modal = openModal({
    title,
    content: html`<p class="modal-text">${message}</p>`,
    dismissible,
    size: "sm",
    actions: [{ label: buttonLabel, variant: "primary", value: true }]
  });
  await modal.result;
}

/* ============================================================================
   7. FORMS & BUTTONS
   ============================================================================ */

/** Reads a <form> into an object using each field's `name`. Text values are trimmed. */
export function readForm(form) {
  const data = {};
  new FormData(form).forEach((value, key) => {
    data[key] = typeof value === "string" ? value.trim() : value;
  });
  return data;
}

/** Shows a message in a `.form-error` element (hides it when message is empty). */
export function showFormError(element, message) {
  if (!element) return;
  element.textContent = message || "";
  element.hidden = !message;
}

export function clearFormError(element) {
  showFormError(element, "");
}

/** Marks one input invalid and shows the message right under it. */
export function setFieldError(input, message) {
  clearFieldError(input);
  input.setAttribute("aria-invalid", "true");
  const note = document.createElement("p");
  note.className = "field-error";
  note.id = `${input.id || input.name}-error`;
  note.textContent = message;
  input.setAttribute("aria-describedby", note.id);
  (input.closest(".field") || input.parentElement).appendChild(note);
}

export function clearFieldError(input) {
  input.removeAttribute("aria-invalid");
  input.removeAttribute("aria-describedby");
  const field = input.closest(".field") || input.parentElement;
  const old = field && field.querySelector(".field-error");
  if (old) old.remove();
}

export function clearFieldErrors(form) {
  $$("[aria-invalid]", form).forEach(clearFieldError);
  $$(".field-error", form).forEach((el) => el.remove());
}

/**
 * Show / hide password buttons:
 *   <button type="button" data-toggle-password="login-password">…</button>
 * Call once; works for buttons added later too.
 */
export function setupPasswordToggles(root = document) {
  delegate(root, "click", "[data-toggle-password]", (event, button) => {
    const input = document.getElementById(button.dataset.togglePassword);
    if (!input) return;
    const reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    button.setAttribute("aria-pressed", String(reveal));
    button.setAttribute("aria-label", reveal ? "Hide password" : "Show password");
    button.innerHTML = icon(reveal ? "eye-off" : "eye", { size: 18 }).value;
  });
}

/**
 * Disables a button and shows its busy state while `task` runs, so a double tap
 * can't submit twice.   await withBusy(button, () => doSomething());
 */
export async function withBusy(button, task) {
  if (!button || button.disabled) return undefined;
  button.disabled = true;
  button.classList.add("is-busy");
  button.setAttribute("aria-busy", "true");
  try {
    return await task();
  } finally {
    button.disabled = false;
    button.classList.remove("is-busy");
    button.removeAttribute("aria-busy");
  }
}

/* ============================================================================
   8. BADGES, AVATARS, RANKS, EMPTY STATES, LOADING
   ============================================================================ */

export const ASSETS = Object.freeze({
  beshoyProfile: "assets/img/beshoy-profile.jpg", // dark portrait — footer
  beshoySuit: "assets/img/beshoy-suit.jpg",       // navy suit — splash screen
  beshoyRobot: "assets/img/beshoy-robot.jpg"      // with the robot — empty states / small badges
});

export function badge(text, tone = "gray") {
  return html`<span class="badge badge-${tone}">${text}</span>`;
}

const STATUS_BADGES = {
  attempt: {
    IN_PROGRESS: ["In progress", "blue"],
    SUBMITTED: ["Submitted", "blue"],
    PENDING_GRADING: ["Pending", "orange"],
    COMPLETED: ["Completed", "green"]
  },
  account: {
    pending: ["Pending approval", "orange"],
    active: ["Active", "green"],
    blocked: ["Blocked", "red"],
    banned: ["Banned", "red"]
  },
  exam: {
    draft: ["Draft", "gray"],
    published: ["Published", "green"]
  },
  phase: {
    upcoming: ["Upcoming", "blue"],
    open: ["Open", "green"],
    closed: ["Closed", "gray"]
  }
};

/** statusBadge("attempt", "PENDING_GRADING") → orange "Pending" badge */
export function statusBadge(kind, value) {
  const entry = (STATUS_BADGES[kind] || {})[value];
  return entry ? badge(entry[0], entry[1]) : badge(String(value ?? "—"), "gray");
}

/** Faceless person icon: blue for male, pink for female. */
export function avatar(gender, { size = 36 } = {}) {
  const tone = gender === "Male" ? "male" : gender === "Female" ? "female" : "neutral";
  return html`<span class="avatar avatar-${tone}" style="--avatar-size:${size}px">${icon("person", { size: Math.round(size * 0.62) })}</span>`;
}

/**
 * Rank as text: "#27", and for ties in the full leaderboard "#27 (2)".
 * @param {{rank: number, tieIndex?: number, tieTotal?: number}} entry
 */
export function rankLabel(entry, { showTie = false } = {}) {
  if (!entry || entry.rank === undefined || entry.rank === null) return html`#—`;
  const tie = showTie && entry.tieTotal > 1 ? html`<sub class="rank-tie">(${entry.tieIndex})</sub>` : "";
  return html`#${entry.rank}${tie}`;
}

/** Friendly message with an optional small round picture. */
export function emptyState({ title, message = "", image = null, action = null }) {
  return html`
    <div class="empty-state">
      ${image ? html`<img class="empty-state-image" src="${image}" alt="" width="72" height="72" loading="lazy">` : ""}
      <p class="empty-state-title">${title}</p>
      ${message ? html`<p class="empty-state-text">${message}</p>` : ""}
      ${action || ""}
    </div>`;
}

/** Grey placeholder rows shown while data loads. */
export function loadingRows(count = 3) {
  return html`<div class="skeleton-list" aria-busy="true" aria-label="Loading">${Array.from({ length: count }, () => html`<div class="skeleton skeleton-row"></div>`)}</div>`;
}

/* ============================================================================
   9. DONUT CHARTS  (SVG — no library)
   The ring is drawn by CSS: it reads --dash and --circ from the style attribute
   and animates from empty to full.
   ============================================================================ */

const DONUT_RADIUS = 38;
const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS;

/**
 * @param {object} o
 * @param {number} o.percent      0–100 (how much of the ring is filled)
 * @param {string} o.centerText   big text inside, e.g. "85%" or "17"
 * @param {string} [o.subText]    small text inside, e.g. "17 / 20"
 * @param {string} o.label        caption under the ring, e.g. "Correct"
 * @param {"green"|"red"|"orange"|"accent"|"blue"} [o.tone]
 */
export function donutChart({ percent, centerText, subText = "", label, tone = "accent", size = 96 }) {
  const safePercent = clamp(Number(percent) || 0, 0, 100);
  const dash = ((safePercent / 100) * DONUT_CIRCUMFERENCE).toFixed(2);
  const circ = DONUT_CIRCUMFERENCE.toFixed(2);

  return html`
    <figure class="donut" style="--donut-size:${size}px">
      <div class="donut-ring">
        <svg viewBox="0 0 100 100" role="img" aria-label="${label}: ${centerText}">
          <circle class="donut-track" cx="50" cy="50" r="${DONUT_RADIUS}"></circle>
          <circle class="donut-arc tone-${tone}" cx="50" cy="50" r="${DONUT_RADIUS}"
                  transform="rotate(-90 50 50)" style="--dash:${dash};--circ:${circ}"></circle>
        </svg>
        <div class="donut-center">
          <strong>${centerText}</strong>
          ${subText ? html`<span>${subText}</span>` : ""}
        </div>
      </div>
      <figcaption class="donut-label">${label}</figcaption>
    </figure>`;
}

/** A row of donuts: donutRow([{ percent, centerText, label, tone }, ...]) */
export function donutRow(items) {
  return html`<div class="donut-row">${items.map((item) => donutChart(item))}</div>`;
}

/* ============================================================================
   10. FOOTER
   Put the result in <footer id="site-footer"></footer>:
       setHtml($("#site-footer"), renderFooter());
   ============================================================================ */

export const SOCIAL_LINKS = Object.freeze([
  { icon: "facebook",  label: "Facebook — Eng. Beshoy Ramy (lessons & news)", url: "https://www.facebook.com/share/1M9EX8AnbS/" },
  { icon: "facebook",  label: "Facebook — Students community",               url: "https://www.facebook.com/share/g/1F7jvm8R9L/" },
  { icon: "instagram", label: "Instagram — Eng. Beshoy Ramy",                url: "https://www.instagram.com/eng.beshoyramy" },
  { icon: "instagram", label: "Instagram — Code Craft",                      url: "https://www.instagram.com/codecrafftt" },
  { icon: "tiktok",    label: "TikTok — Eng. Beshoy Ramy",                   url: "https://www.tiktok.com/@beshoramy.com" },
  { icon: "whatsapp",  label: "WhatsApp channel",                            url: "https://whatsapp.com/channel/0029Vb8NShEKAwEv9A4Byq1G" },
  { icon: "linkedin",  label: "LinkedIn — Eng. Beshoy Ramy",                 url: "https://www.linkedin.com/in/beshoy-ramy-" }
  // YouTube: add { icon: "youtube", label: "YouTube channel", url: "..." } once the channel exists.
]);

export const DEVELOPER = Object.freeze({
  name: "Anas Hossiny",
  url: "https://www.linkedin.com/in/anas-hossiny-4628823b4"
});

export function renderFooter() {
  return html`
    <div class="footer-inner">
      <div class="footer-brand">
        <img class="footer-avatar" src="${ASSETS.beshoyProfile}" alt="Eng. Beshoy Ramy" width="44" height="44" loading="lazy">
        <div>
          <p class="footer-title">Follow Code Craft</p>
          <p class="footer-sub">Beshoy Ramy Academy</p>
        </div>
      </div>

      <nav class="footer-social" aria-label="Social links">
        ${SOCIAL_LINKS.map((link) => html`
          <a class="footer-link" href="${link.url}" target="_blank" rel="noopener noreferrer"
             title="${link.label}" aria-label="${link.label}">${icon(link.icon, { size: 20 })}</a>`)}
      </nav>

      <div class="footer-divider"></div>

      <p class="footer-credit">
        Code Craft — Quiz Platform · Developed by
        <a href="${DEVELOPER.url}" target="_blank" rel="noopener noreferrer">${DEVELOPER.name}</a>
      </p>
    </div>`;
}

/* ============================================================================
   11. CONNECTION AWARENESS
   Offline: a calm banner (the exam keeps working; answers are saved on the device).
   Back online: "Connection restored."
   ============================================================================ */

export function isOnline() {
  return navigator.onLine;
}

export function setupConnectionAwareness({ onOffline, onOnline } = {}) {
  let banner = document.getElementById("offline-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "offline-banner";
    banner.className = "offline-banner";
    banner.setAttribute("role", "status");
    banner.setAttribute("aria-live", "polite");
    banner.textContent = "You're offline. Your current progress is saved on this device.";
    document.body.appendChild(banner);
  }

  const show = () => banner.classList.add("is-visible");
  const hide = () => banner.classList.remove("is-visible");

  window.addEventListener("offline", () => { show(); if (onOffline) onOffline(); });
  window.addEventListener("online", () => {
    hide();
    toast("Connection restored.", { type: "success" });
    if (onOnline) onOnline();
  });

  if (!navigator.onLine) show();
}

/* ============================================================================
   12. MISC
   ============================================================================ */

/**
 * WhatsApp "Click to Chat" link (free, no API). Opens a chat with `mobile` in the
 * WhatsApp of whoever clicks it, with `message` ready to send.
 * Egyptian local numbers (01xxxxxxxxx) are converted to international (20 1xxxxxxxxx).
 */
export function whatsappUrl(mobile, message = "") {
  let digits = String(mobile || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  else if (digits.startsWith("0")) digits = `20${digits.slice(1)}`;
  const text = message ? `?text=${encodeURIComponent(message)}` : "";
  return `https://wa.me/${digits}${text}`;
}

/** Copies text to the clipboard. Returns true on success. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    // Fallback for browsers/contexts without the Clipboard API
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
    area.remove();
    return ok;
  }
}