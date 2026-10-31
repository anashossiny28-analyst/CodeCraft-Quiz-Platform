/* ============================================================================
   CODE CRAFT — QUIZ PLATFORM
   js/main.js

   The conductor. It does not contain screens — it:
     1. boots the app and asks Firebase "is someone signed in?"
     2. runs the splash lamp, the log-in / register forms
     3. switches between the four views (splash, auth, student, staff)
     4. routes between screens and loads each screen's module only when needed

   ----------------------------------------------------------------------------
   HOW A SCREEN MODULE PLUGS IN  (every other file follows this contract)
   ----------------------------------------------------------------------------
   Each screen has an empty <section id="screen-NAME"> in index.html and an entry
   in SCREENS below that names a module file and an exported function.

       // student.js
       export async function renderHome(container, ctx) {
         setHtml(container, html`<h1 class="page-title">…</h1>`);
         const stop = someService.watch(...);
         return () => stop();          // OPTIONAL cleanup, called when the user leaves
       }

   `ctx` (the second argument):
       ctx.profile                 the signed-in user (always up to date)
       ctx.params                  data passed with navigate(), e.g. { attemptId }
       ctx.navigate(name, params)  open another screen
       ctx.back()                  previous screen
       ctx.reload()                render this screen again
       ctx.logout()                asks for confirmation, then signs out
       ctx.setExamMode(true|false) hides navigation / header / footer for the exam
       ctx.setNavigationGuard(fn)  fn(targetScreen) → false blocks leaving (also
                                   blocks the browser Back button); null removes it
       ctx.announce(text)          screen-reader announcement

   Buttons inside any screen can navigate without JavaScript:
       <button data-nav="review" data-nav-params='{"attemptId":"abc"}'>
       <button data-nav-back>
       <button data-retry>   (re-renders the current screen)

   Optional notifications module (./notifications.js):
       export function startNotifications(ctx)  → returns a stop() function
       export function openNotifications(ctx)
   ============================================================================ */

import { GRADES, SUBJECTS, ROLES } from "./firebase-config.js";
import {
  AuthError,
  login,
  logout,
  registerStudent,
  watchSession,
  getCurrentProfile,
  isStaffRole
} from "./auth.js";
import {
  $, $$, delegate, html, setHtml, icon, avatar, toast, openModal, closeModal, confirmDialog,
  readForm, showFormError, clearFormError, setFieldError, clearFieldErrors,
  setupPasswordToggles, withBusy, setupConnectionAwareness, renderFooter,
  emptyState, loadingRows, ASSETS, copyText, scrollToTop, clamp
} from "./ui-helpers.js";

/* ============================================================================
   1. SCREEN REGISTRY
   view:   which app the screen belongs to        nav:    which menu item stays highlighted
   static: markup already in index.html (don't wipe it)    admin: admin only
   ============================================================================ */

const SCREENS = {
  /* student */
  home:     { view: "student", module: "./student.js",     render: "renderHome",     title: "Home" },
  exam:     { view: "student", module: "./exam-engine.js", render: "renderExam",     title: "Exam", nav: "home", static: true },
  result:   { view: "student", module: "./student.js",     render: "renderResult",   title: "Result", nav: "results" },
  results:  { view: "student", module: "./student.js",     render: "renderResults",  title: "Results" },
  review:   { view: "student", module: "./student.js",     render: "renderReview",   title: "Exam review", nav: "results" },
  ranking:  { view: "student", module: "./ranking.js",     render: "renderRanking",  title: "Ranking" },
  report:   { view: "student", module: "./student.js",     render: "renderReport",   title: "Report" },
  profile:  { view: "student", module: "./student.js",     render: "renderProfile",  title: "Profile" },
  homework: { view: "student", module: "./homework.js",    render: "renderHomework", title: "Homework" },
  lessons:  { view: "student", module: "./lessons.js",     render: "renderLessons",  title: "Lessons" },
  lesson:   { view: "student", module: "./lessons.js",     render: "renderLesson",   title: "Lesson notebook", nav: "lessons" },

  /* staff (admin, teacher, secretary) */
  "staff-dashboard":    { view: "staff", module: "./admin.js",    render: "renderDashboard",   title: "Dashboard" },
  "staff-students":     { view: "staff", module: "./admin.js",    render: "renderStudents",    title: "Students" },
  "staff-student":      { view: "staff", module: "./admin.js",    render: "renderStudent",     title: "Student", nav: "staff-students" },
  "staff-exams":        { view: "staff", module: "./exams.js",    render: "renderExams",       title: "Exams" },
  "staff-exam-builder": { view: "staff", module: "./exams.js",    render: "renderExamBuilder", title: "Exam builder", nav: "staff-exams" },
  "staff-exam-detail":  { view: "staff", module: "./exams.js",    render: "renderExamDetail",  title: "Exam details", nav: "staff-exams" },
  "staff-grading":      { view: "staff", module: "./grading.js",  render: "renderGrading",     title: "Grading" },
  "staff-grade":        { view: "staff", module: "./grading.js",  render: "renderGrade",       title: "Grade answers", nav: "staff-grading" },
  "staff-homework":     { view: "staff", module: "./homework.js", render: "renderStaffHomework", title: "Homework" },
  "staff-lessons":      { view: "staff", module: "./lessons.js",  render: "renderStaffLessons", title: "Lessons" },
  "staff-accounts":     { view: "staff", module: "./admin.js",    render: "renderAccounts",    title: "Staff accounts", admin: true }
};

const VIEWS = {
  splash: "#view-splash",
  auth: "#view-auth",
  student: "#view-student",
  staff: "#view-staff"
};

/* ============================================================================
   2. STATE
   ============================================================================ */

const state = {
  booted: false,
  sessionActive: false,
  view: null,
  screen: null,
  params: {},
  token: 0,              // increments on every navigation, so late results are ignored
  cleanup: null,         // cleanup function returned by the current screen
  guard: null,           // navigation guard (set by the exam)
  stopNotifications: null
};

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const hasFinePointer = () => window.matchMedia("(pointer: fine)").matches;

function announce(text) {
  const region = $("#sr-announcer");
  if (!region) return;
  region.textContent = "";
  // a short delay makes screen readers announce repeated identical messages
  setTimeout(() => { region.textContent = text; }, 50);
}

/* ============================================================================
   3. STATIC MARKUP HELPERS
   ============================================================================ */

/** <span data-icon="bell" data-size="22"> → inline SVG */
function hydrateIcons(root = document) {
  $$("[data-icon]", root).forEach((slot) => {
    if (slot.firstChild) return;
    slot.innerHTML = String(icon(slot.dataset.icon, { size: Number(slot.dataset.size) || 20 }));
  });
}

/** Fills <select data-options="grades|subjects"> from firebase-config.js */
function fillSelects() {
  const sources = { grades: GRADES, subjects: SUBJECTS };
  $$("select[data-options]").forEach((select) => {
    const values = sources[select.dataset.options] || [];
    values.forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    });
  });
}

/** Loads a screen module on demand. Resolves to null if the file isn't there yet. */
async function loadModule(path) {
  try {
    return await import(path);
  } catch (err) {
    console.info(`[main] ${path} could not be loaded:`, err && err.message);
    return null;
  }
}

/* ============================================================================
   4. VIEWS & SIGN-IN PANELS
   ============================================================================ */

function showView(name) {
  Object.entries(VIEWS).forEach(([key, selector]) => {
    $(selector).hidden = key !== name;
  });
  state.view = name;
  if (name === "splash" || name === "auth") document.title = "Code Craft — Quiz Platform";
  scrollToTop();
}

function showPanel(name) {
  $$("[data-panel]").forEach((panel) => { panel.hidden = panel.dataset.panel !== name; });
  clearFormError($("#login-error"));
  clearFormError($("#register-error"));
  $$("form").forEach(clearFieldErrors);
  scrollToTop();

  // Focus the first field — but not on phones, where it would pop the keyboard open.
  if (hasFinePointer()) {
    const first = $(`[data-panel="${name}"] input:not([type="hidden"]), [data-panel="${name}"] select`);
    if (first) first.focus({ preventScroll: true });
  }
}

function showLoginNotice(message) {
  const el = $("#login-notice");
  el.textContent = message || "";
  el.hidden = !message;
}

/* ============================================================================
   5. ROUTER
   ============================================================================ */

function defaultScreen(profile = getCurrentProfile()) {
  return profile && isStaffRole(profile.role) ? "staff-dashboard" : "home";
}

function canOpen(name, profile = getCurrentProfile()) {
  const def = SCREENS[name];
  if (!def || !profile) return false;
  if (def.view === "staff") {
    if (!isStaffRole(profile.role)) return false;
    return !def.admin || profile.role === ROLES.ADMIN;
  }
  return profile.role === ROLES.STUDENT;
}

function runCleanup() {
  if (typeof state.cleanup === "function") {
    try { state.cleanup(); } catch (err) { console.warn("[main] screen cleanup failed:", err); }
  }
  state.cleanup = null;
}

function showSection(section) {
  Array.from(section.parentElement.children).forEach((el) => {
    if (el.classList.contains("screen")) el.hidden = el !== section;
  });
}

function setActiveNav(name) {
  const activeView = $(VIEWS[state.view]);
  if (!activeView) return;
  $$("[data-nav]", activeView).forEach((item) => {
    if (!item.classList.contains("nav-item")) return;
    if (item.dataset.nav === name) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
}

function makeContext(params = {}) {
  return {
    get profile() { return getCurrentProfile(); },
    params,
    navigate,
    back: goBack,
    reload: () => navigate(state.screen, state.params, { replace: true }),
    logout: requestLogout,
    setExamMode(on) { document.body.classList.toggle("exam-mode", !!on); },
    setNavigationGuard(fn) { state.guard = typeof fn === "function" ? fn : null; },
    announce,
    hydrateIcons
  };
}

/**
 * Opens a screen.
 * @returns {Promise<boolean>} false if it was blocked (no access, or a guard said no)
 */
async function navigate(name, params = {}, { replace = false, fromPopstate = false } = {}) {
  if (!canOpen(name)) {
    toast("You don't have access to that page.", { type: "error" });
    return false;
  }

  if (state.guard && !state.guard(name, params)) {
    // The browser Back button already moved the history: put the user back where they were.
    if (fromPopstate && state.screen) {
      history.pushState({ screen: state.screen, params: state.params, idx: (history.state && history.state.idx) || 0 }, "", `#${state.screen}`);
    }
    return false;
  }

  const def = SCREENS[name];
  const section = document.getElementById(`screen-${name}`);
  if (!section) return false;

  const token = ++state.token;
  runCleanup();

  state.screen = name;
  state.params = params;

  if (!fromPopstate) {
    const currentIdx = (history.state && history.state.idx) || 0;
    const entry = { screen: name, params, idx: replace ? currentIdx : currentIdx + 1 };
    if (replace) history.replaceState(entry, "", `#${name}`);
    else history.pushState(entry, "", `#${name}`);
  }

  showSection(section);
  setActiveNav(def.nav || name);
  setStaffMenu(false);
  document.title = `${def.title} — Code Craft`;
  if (!def.static) setHtml(section, loadingRows(3));

  const mod = await loadModule(def.module);
  if (token !== state.token) return true; // the user already went somewhere else

  const renderFn = mod && mod[def.render];
  if (typeof renderFn !== "function") {
    showUnavailable(section, def);
    finishNavigation(section, def);
    return true;
  }

  try {
    const cleanup = await renderFn(section, makeContext(params));
    if (token !== state.token) {
      if (typeof cleanup === "function") cleanup();
      return true;
    }
    state.cleanup = typeof cleanup === "function" ? cleanup : null;
  } catch (err) {
    console.error(`[main] screen "${name}" failed to render:`, err);
    if (token === state.token) showScreenError(section, def);
  }

  if (token === state.token) finishNavigation(section, def);
  return true;
}

function finishNavigation(section, def) {
  hydrateIcons(section);
  section.focus({ preventScroll: true });
  scrollToTop();
  announce(def.title);
}

function showUnavailable(section, def) {
  setHtml(section, html`
    <div class="page-head"><h1 class="page-title">${def.title}</h1></div>
    ${emptyState({
      title: "This section is on its way",
      message: "It will be available very soon.",
      image: ASSETS.beshoyRobot
    })}`);
}

function showScreenError(section, def) {
  setHtml(section, html`
    <div class="page-head"><h1 class="page-title">${def.title}</h1></div>
    ${emptyState({
      title: "Something went wrong",
      message: "We couldn't load this screen. Please check your connection and try again.",
      action: html`<button type="button" class="btn btn-secondary" data-retry>Try again</button>`
    })}`);
}

function goBack() {
  if (((history.state && history.state.idx) || 0) > 0) history.back();
  else navigate(defaultScreen(), {}, { replace: true });
}

function setupRouterEvents() {
  history.scrollRestoration = "manual";

  window.addEventListener("popstate", (event) => {
    if (!state.sessionActive) return;
    const entry = event.state && SCREENS[event.state.screen] ? event.state : null;
    navigate(entry ? entry.screen : defaultScreen(), entry ? entry.params : {}, { fromPopstate: true });
  });

  delegate(document, "click", "[data-nav]", (event, el) => {
    let params = {};
    if (el.dataset.navParams) {
      try { params = JSON.parse(el.dataset.navParams); } catch (_) { params = {}; }
    }
    navigate(el.dataset.nav, params);
  });
  delegate(document, "click", "[data-nav-back]", () => goBack());
  delegate(document, "click", "[data-retry]", () => navigate(state.screen, state.params, { replace: true }));
}

/* ============================================================================
   6. SESSION
   ============================================================================ */

async function startSession(profile) {
  state.sessionActive = true;
  showLoginNotice("");
  $("#login-form").reset();

  if (isStaffRole(profile.role)) setupStaffShell(profile);
  else setupStudentShell(profile);
  showView(isStaffRole(profile.role) ? "staff" : "student");

  // After a refresh, return to the screen the user was on.
  const saved = history.state && history.state.screen;
  const target = saved && canOpen(saved, profile) ? saved : defaultScreen(profile);
  const params = saved && target === saved ? history.state.params || {} : {};
  await navigate(target, params, { replace: true });
}

function endSession(reason) {
  const wasActive = state.sessionActive;
  state.sessionActive = false;

  runCleanup();
  stopNotifications();
  state.guard = null;
  state.token++;
  document.body.classList.remove("exam-mode");
  closeModal();

  // Never leave one person's data in the page for the next person on a shared device.
  $$(".screen").forEach((section) => {
    section.hidden = true;
    if (!section.matches("[data-screen='exam']")) section.innerHTML = "";
  });
  history.replaceState(null, "", location.pathname);

  showLoginNotice(reason ? new AuthError(reason).message : "");

  if (wasActive || reason) {
    showView("auth");
    showPanel("login");
  } else if (!state.booted) {
    resetSplash();
    showView("splash");
  }
}

async function requestLogout() {
  if (document.body.classList.contains("exam-mode")) {
    toast("Please finish or submit your exam first.", { type: "error" });
    return;
  }
  const confirmed = await confirmDialog({
    title: "Log out?",
    message: "You will need your ID and password to log in again.",
    confirmLabel: "Log out"
  });
  if (!confirmed) return;
  try {
    await logout(); // watchSession then calls endSession()
  } catch (err) {
    console.error("[main] logout failed:", err);
    toast("Couldn't log out. Please try again.", { type: "error" });
  }
}

/* ---- notifications (optional module) ---- */

async function startNotifications() {
  stopNotifications();
  const mod = await loadModule("./notifications.js");
  if (mod && typeof mod.startNotifications === "function" && state.sessionActive) {
    state.stopNotifications = mod.startNotifications(makeContext());
  }
}

function stopNotifications() {
  if (typeof state.stopNotifications === "function") {
    try { state.stopNotifications(); } catch (_) { /* ignore */ }
  }
  state.stopNotifications = null;
  const badge = $("#notif-badge");
  if (badge) badge.hidden = true;
}

async function openNotifications() {
  const mod = await loadModule("./notifications.js");
  if (mod && typeof mod.openNotifications === "function") mod.openNotifications(makeContext());
  else toast("You're all caught up.");
}

/* ============================================================================
   7. STUDENT & STAFF SHELLS
   ============================================================================ */

function setupStudentShell(profile) {
  setHtml($("#profile-btn"), avatar(profile.gender, { size: 36 }));
  $("#profile-btn").setAttribute("aria-label", `Open profile for ${profile.name}`);
  startNotifications();
}

function setupStaffShell(profile) {
  $("#staff-user-name").textContent = profile.name;
  $("#staff-user-role").textContent = profile.role;
  $$("[data-admin-only]").forEach((item) => { item.hidden = profile.role !== ROLES.ADMIN; });
  setStaffMenu(false);
}

function setStaffMenu(open) {
  const sidebar = $("#staff-sidebar");
  const button = $("#staff-menu-btn");
  if (!sidebar || !button) return;
  sidebar.classList.toggle("is-open", open);
  button.setAttribute("aria-expanded", String(open));
  button.setAttribute("aria-label", open ? "Close menu" : "Open menu");
}

function setupShellUi() {
  $("#staff-menu-btn").addEventListener("click", () => {
    setStaffMenu(!$("#staff-sidebar").classList.contains("is-open"));
  });
  $("#staff-logout-btn").addEventListener("click", requestLogout);
  $("#notif-btn").addEventListener("click", openNotifications);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setStaffMenu(false);
  });
}

/* ============================================================================
   8. SPLASH — pull the cord, the lamp lights, the log-in opens
   Works with a drag, a tap, or the keyboard (Enter / Space on the cord).
   ============================================================================ */

const CORD_MAX_PULL = 90;     // px the cord can stretch
const CORD_TRIGGER = 42;      // px of pull that counts as "pulled"

function resetSplash() {
  const view = $("#view-splash");
  view.classList.remove("is-lit");
  $("#lamp-cord").style.setProperty("--pull", "0px");
  state.splashDone = false;
}

function setupSplash() {
  const view = $("#view-splash");
  const cord = $("#lamp-cord");
  const handle = $("#lamp-cord-handle");
  const setPull = (px) => cord.style.setProperty("--pull", `${px}px`);

  let startY = 0;
  let moved = 0;
  let dragging = false;
  state.splashDone = false;

  function pullAndEnter() {
    if (state.splashDone) return;
    state.splashDone = true;

    cord.classList.remove("is-dragging");
    setPull(56);
    setTimeout(() => setPull(0), 180);
    view.classList.add("is-lit");
    announce("The lamp is on. Opening log in.");

    setTimeout(() => {
      showView("auth");
      showPanel("login");
    }, prefersReducedMotion() ? 120 : 900);
  }

  handle.addEventListener("pointerdown", (event) => {
    if (state.splashDone) return;
    dragging = true;
    moved = 0;
    startY = event.clientY;
    handle.setPointerCapture(event.pointerId);
    cord.classList.add("is-dragging");
  });

  handle.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const pull = clamp(event.clientY - startY, 0, CORD_MAX_PULL);
    moved = Math.max(moved, pull);
    setPull(pull);
  });

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    cord.classList.remove("is-dragging");
    if (moved >= CORD_TRIGGER) pullAndEnter();
    else setPull(0);
  };
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);

  // A tap or the keyboard fires "click". A drag also ends with a click — ignore that one.
  handle.addEventListener("click", () => {
    if (moved >= 6) { moved = 0; return; }
    pullAndEnter();
  });
}

/* ============================================================================
   9. LOG-IN & REGISTER FORMS
   ============================================================================ */

const REGISTER_FIELD_BY_ERROR = {
  "invalid-name": "reg-name",
  "invalid-mobile": "reg-mobile",
  "phone-taken": "reg-mobile",
  "invalid-parent-mobile": "reg-parent-mobile",
  "same-numbers": "reg-parent-mobile",
  "invalid-email": "reg-email",
  "invalid-gender": "reg-gender",
  "invalid-grade": "reg-grade",
  "invalid-subject": "reg-subject",
  "weak-password": "reg-password"
};

function setupAuthUi() {
  delegate(document, "click", "[data-show-panel]", (event, el) => {
    showLoginNotice("");
    showPanel(el.dataset.showPanel);
  });

  $("#forgot-password-btn").addEventListener("click", () => {
    openModal({
      title: "Forgot your password?",
      content: html`<p class="modal-text">Please contact the academy secretary. After checking who you are, they will help you get back into your account.</p>`,
      size: "sm",
      actions: [{ label: "OK", variant: "primary" }]
    });
  });

  $("#login-form").addEventListener("submit", handleLogin);
  $("#register-form").addEventListener("submit", handleRegister);

  $("#copy-login-id-btn").addEventListener("click", async () => {
    const copied = await copyText($("#pending-login-id").textContent);
    toast(copied ? "ID copied." : "Couldn't copy. Please write it down.", { type: copied ? "success" : "error" });
  });
}

async function handleLogin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = $("#login-error");
  clearFormError(errorBox);
  showLoginNotice("");

  const { loginId, password } = readForm(form);

  await withBusy($("#login-submit"), async () => {
    try {
      const profile = await login(loginId, password);
      await startSession(profile);
    } catch (err) {
      showFormError(errorBox, err instanceof AuthError ? err.message : "Something went wrong. Please try again.");
    }
  });
}

async function handleRegister(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = $("#register-error");
  clearFormError(errorBox);
  clearFieldErrors(form);

  const data = readForm(form);

  if (data.password && data.password !== data.passwordConfirm) {
    const confirmInput = $("#reg-password-confirm");
    setFieldError(confirmInput, "Passwords do not match.");
    confirmInput.focus();
    return;
  }

  await withBusy($("#register-submit"), async () => {
    try {
      const { loginId } = await registerStudent(data);
      form.reset();
      $("#pending-login-id").textContent = loginId;
      showPanel("pending");
    } catch (err) {
      if (!(err instanceof AuthError)) {
        showFormError(errorBox, "Something went wrong. Please try again.");
        return;
      }
      const fieldId = REGISTER_FIELD_BY_ERROR[err.code];
      const input = fieldId && document.getElementById(fieldId);
      if (input) {
        setFieldError(input, err.message);
        input.focus();
      } else {
        showFormError(errorBox, err.message);
      }
    }
  });
}

/* ============================================================================
   10. BOOT
   ============================================================================ */

function finishBoot() {
  if (state.booted) return;
  state.booted = true;
  document.body.classList.remove("is-loading");
}

function boot() {
  hydrateIcons();
  fillSelects();
  setHtml($("#site-footer"), renderFooter());
  setupPasswordToggles();
  setupConnectionAwareness();
  setupRouterEvents();
  setupSplash();
  setupAuthUi();
  setupShellUi();

  // If Firebase never answers (offline with nothing cached), don't leave the loader up forever.
  const safety = setTimeout(() => {
    if (state.booted) return;
    showView("splash");
    finishBoot();
  }, 10000);

  // Firebase tells us once at startup — and again whenever the session ends.
  watchSession(async (profile, reason) => {
    if (profile) {
      await startSession(profile);
    } else {
      endSession(reason);
    }
    clearTimeout(safety);
    finishBoot();
  });
}

boot();