/* ============================================================================
   CODE CRAFT — QUIZ PLATFORM
   js/exam-engine.js

   The screen where a student takes an exam.  main.js calls renderExam() with
   ctx.params = { examId }.  The markup (timer, question card, buttons…) is already
   in index.html — this file only fills it in.

   What it does
     • one question per screen; numbering runs straight through (MCQs first, then essays,
       each group in this student's own random order)
     • the timer is calculated from the SERVER's clock, so changing the phone's clock
       doesn't help; it warns at 2 minutes and submits by itself at 0
     • every answer is saved the moment it is given — silently (no "Saved" message).
       Offline, Firestore keeps the writes on the device and sends them when the
       connection returns
     • "Submit exam" asks for confirmation and says how many questions are unanswered;
       there is no waiting period before submitting
     • closing or leaving the page submits the exam with what was saved so far
     • switching tab / app shows a warning (and is counted for the teacher)
     • while the exam is open: no right-click, no copy / cut, no pasting into an essay
       answer, no logout, and the browser's Back button is blocked
   These are deterrents, not locks — a browser cannot truly prevent screenshots.

   When it is done it opens the Result screen.
   ============================================================================ */

import {
  examService,
  attemptService,
  examPhase,
  attemptRemainingSeconds,
  DataError
} from "./data-services.js";

import {
  html, setHtml, toast, openModal, closeModal, delegate, debounce,
  formatClock, formatPoints, pad2
} from "./ui-helpers.js";

/* ============================================================================
   1. SMALL HELPERS
   ============================================================================ */

const WARNING_SECONDS = 120;       // "Only 2 minutes remaining."
const ESSAY_SAVE_DELAY_MS = 600;   // wait for a pause in typing before saving an essay

/** Fire-and-forget: saving must never block the student (offline writes queue up). */
const inBackground = (promise) => {
  Promise.resolve(promise).catch((err) => console.warn("[exam] a background save failed:", err));
};

/** The questions in THIS student's order (attempt.questionOrder), with a safe fallback. */
function orderedQuestions(exam, attempt) {
  const byId = new Map((exam.questions || []).map((q) => [q.id, q]));
  const ordered = (attempt.questionOrder || []).map((id) => byId.get(id)).filter(Boolean);
  const seen = new Set(ordered.map((q) => q.id));
  (exam.questions || []).forEach((q) => { if (!seen.has(q.id)) ordered.push(q); });
  return ordered;
}

/* ============================================================================
   2. THE SCREEN
   ============================================================================ */

export async function renderExam(container, ctx) {
  const profile = ctx.profile;
  const examId = ctx.params.examId;

  if (!examId) { ctx.navigate("home", {}, { replace: true }); return undefined; }

  /* ---- the elements that already exist in index.html ---- */
  const els = {
    title: container.querySelector("#exam-title"),
    counter: container.querySelector("#exam-counter"),
    timer: container.querySelector("#exam-timer"),
    timerText: container.querySelector("#exam-timer-text"),
    progress: container.querySelector("#exam-progress"),
    progressFill: container.querySelector("#exam-progress-fill"),
    warning: container.querySelector("#exam-time-warning"),
    navigator: container.querySelector("#exam-navigator"),
    kind: container.querySelector("#exam-kind"),
    question: container.querySelector("#exam-question"),
    answers: container.querySelector("#exam-answers"),
    mark: container.querySelector("#exam-mark"),
    markLabel: container.querySelector("#exam-mark-label"),
    back: container.querySelector("#exam-back"),
    next: container.querySelector("#exam-next"),
    submit: container.querySelector("#exam-submit")
  };

  /* ---- while loading ---- */
  els.title.textContent = "";
  els.counter.textContent = "";
  els.timerText.textContent = "--:--";
  els.kind.textContent = "";
  els.question.textContent = "Getting your exam ready…";
  els.answers.textContent = "";
  els.navigator.textContent = "";
  els.warning.hidden = true;
  els.progressFill.style.width = "0%";
  [els.mark, els.back, els.next, els.submit].forEach((b) => { b.disabled = true; });
  els.submit.hidden = true;

  /* ---- load the exam and start (or resume) this student's attempt ---- */
  let exam;
  let attempt;
  try {
    exam = await examService.get(examId);
    if (!exam || exam.status !== "published") throw new DataError("not-found");

    const existing = await attemptService.getMine(profile.uid, examId);
    if (existing) {
      if (existing.status !== "IN_PROGRESS") {
        toast("You have already handed in this exam.");
        ctx.navigate("result", { attemptId: existing.id }, { replace: true });
        return undefined;
      }
      // Resuming: the student's own timer keeps running even if the opening window has closed.
      await attemptService.syncClock(existing.id);
      attempt = existing;
    } else {
      if (examPhase(exam) !== "open") throw new DataError("exam-not-open");
      ({ attempt } = await attemptService.start(profile, exam));
    }
  } catch (err) {
    console.error("[exam] could not start:", err);
    toast(err && err.message ? err.message : "We couldn't open this exam.", { type: "error" });
    ctx.navigate("home", {}, { replace: true });
    return undefined;
  }

  const questions = orderedQuestions(exam, attempt);
  if (!questions.length) {
    toast("This exam has no questions.", { type: "error" });
    ctx.navigate("home", {}, { replace: true });
    return undefined;
  }

  attempt.mcqAnswers = attempt.mcqAnswers || {};
  attempt.essayAnswers = attempt.essayAnswers || {};
  attempt.marked = Array.isArray(attempt.marked) ? attempt.marked : [];

  /* ---- state ---- */
  let current = Math.min(Math.max(Number(attempt.currentIndex) || 0, 0), questions.length - 1);
  let submitting = false;   // a submit is running
  let done = false;         // the exam was handed in successfully
  let leftPage = false;     // the page was closed or left — already submitted in the background
  let timerId = null;
  let lastNotice = 0;

  ctx.setExamMode(true);
  ctx.setNavigationGuard(() => done);          // blocks Back / any navigation until handed in
  window.scrollTo(0, 0);

  /* ======================================================================
     Answers
     ====================================================================== */

  const isAnswered = (q) => {
    if (q.type === "mcq") return attempt.mcqAnswers[q.id] !== undefined && attempt.mcqAnswers[q.id] !== null;
    const answer = attempt.essayAnswers[q.id];
    return !!(answer && String(answer.text || "").trim());
  };

  const isMarked = (q) => attempt.marked.includes(q.id);

  function counts() {
    const answered = questions.filter(isAnswered).length;
    return {
      answered,
      unanswered: questions.length - answered,
      marked: questions.filter(isMarked).length
    };
  }

  const saveEssayLater = debounce((questionId, text) => {
    inBackground(attemptService.saveEssayAnswer(attempt.id, questionId, text));
  }, ESSAY_SAVE_DELAY_MS);

  /* ======================================================================
     Drawing
     ====================================================================== */

  els.title.textContent = exam.title;

  setHtml(els.navigator, questions.map((q, i) => html`
    <button type="button" class="q-dot" data-index="${i}" aria-label="Go to question ${i + 1}">${i + 1}</button>`));
  const dots = Array.from(els.navigator.querySelectorAll(".q-dot"));

  function updateChrome() {
    const q = questions[current];
    const { answered } = counts();

    els.counter.textContent = `Question ${pad2(current + 1)} / ${questions.length}`;

    const percent = Math.round((answered / questions.length) * 100);
    els.progressFill.style.width = `${percent}%`;
    els.progress.setAttribute("aria-valuenow", String(percent));

    dots.forEach((dot, i) => {
      const item = questions[i];
      dot.classList.toggle("is-answered", isAnswered(item));
      dot.classList.toggle("is-marked", isMarked(item));
      dot.classList.toggle("is-current", i === current);
      if (i === current) dot.setAttribute("aria-current", "step");
      else dot.removeAttribute("aria-current");
    });
    dots[current].scrollIntoView({ inline: "center", block: "nearest" });

    const marked = isMarked(q);
    els.mark.setAttribute("aria-pressed", String(marked));
    els.markLabel.textContent = marked ? "Marked for review" : "Mark for review";

    const last = current === questions.length - 1;
    els.back.disabled = current === 0;
    els.next.hidden = last;
    els.submit.hidden = !last;
    els.next.disabled = false;
    els.submit.disabled = false;
    els.mark.disabled = false;
  }

  function paintQuestion() {
    const q = questions[current];
    const points = formatPoints(q.points || 1);

    els.kind.textContent = `${q.type === "mcq" ? "Multiple choice" : "Essay"} · ${points} ${Number(q.points || 1) === 1 ? "point" : "points"}`;
    els.question.textContent = q.text;

    if (q.type === "mcq") {
      const chosen = attempt.mcqAnswers[q.id];
      els.answers.setAttribute("role", "radiogroup");
      els.answers.setAttribute("aria-label", "Answer options");
      setHtml(els.answers, q.options.map((option, i) => html`
        <button type="button" class="option ${chosen === i ? "is-selected" : ""}" role="radio"
                aria-checked="${chosen === i}" data-option="${i}">
          <span class="option-letter" aria-hidden="true">${String.fromCharCode(65 + i)}</span>
          <span class="option-text" dir="auto">${option.text}</span>
        </button>`));
    } else {
      els.answers.removeAttribute("role");
      els.answers.removeAttribute("aria-label");
      setHtml(els.answers, html`
        <textarea class="essay-input" id="essay-input" dir="auto" aria-label="Your answer"
                  placeholder="Start your answer here…" autocomplete="off" autocapitalize="sentences"></textarea>`);
      els.answers.querySelector("#essay-input").value = (attempt.essayAnswers[q.id] || {}).text || "";
    }

    updateChrome();
    ctx.announce(`Question ${current + 1} of ${questions.length}`);
  }

  function goTo(index) {
    if (index < 0 || index >= questions.length || index === current) return;
    saveEssayLater.flush();               // never lose the last words typed
    current = index;
    attempt.currentIndex = index;
    inBackground(attemptService.saveCurrentIndex(attempt.id, index));
    paintQuestion();
    window.scrollTo(0, 0);
  }

  /* ======================================================================
     Timer
     ====================================================================== */

  function tick() {
    if (done || submitting) return;
    const remaining = attemptRemainingSeconds(attempt, exam);

    els.timerText.textContent = formatClock(remaining);
    const low = remaining <= WARNING_SECONDS;
    els.timer.classList.toggle("is-low", low);

    if (low && remaining > 0) {
      const text = remaining > 60 ? "Only 2 minutes remaining." : "Less than a minute left.";
      if (els.warning.hidden || els.warning.textContent !== text) els.warning.textContent = text;
      els.warning.hidden = false;
    } else {
      els.warning.hidden = true;
    }

    if (remaining <= 0) finish("timeout");
  }

  function startTimer() {
    tick();
    timerId = setInterval(tick, 1000);
  }

  /* ======================================================================
     Handing in
     ====================================================================== */

  async function submitWithRetry(reason) {
    for (;;) {
      try {
        return await attemptService.submit(exam, attempt, { reason });
      } catch (err) {
        console.error("[exam] submit failed:", err);
        closeModal();
        const retry = openModal({
          title: "We couldn't submit your exam",
          dismissible: false,
          size: "sm",
          content: html`<p class="modal-text">${err && err.message ? err.message : "Something went wrong."} Your answers are safe. Check your connection, then try again.</p>`,
          actions: [{ label: "Try again", variant: "primary", value: true }]
        });
        await retry.result;
      }
    }
  }

  async function finish(reason) {
    if (submitting || done || leftPage) return;
    submitting = true;
    clearInterval(timerId);
    saveEssayLater.flush();
    closeModal();

    if (reason === "timeout") {
      openModal({
        title: "Time's up",
        dismissible: false,
        size: "sm",
        content: html`<p class="modal-text">Your exam is being submitted.</p>`
      });
    } else if (!navigator.onLine) {
      openModal({
        title: "You're offline",
        dismissible: false,
        size: "sm",
        content: html`<p class="modal-text">Your answers are saved on this device and will be submitted as soon as you're back online. Please keep this page open.</p>`
      });
    }

    await submitWithRetry(reason);

    done = true;
    submitting = false;
    closeModal();
    ctx.navigate("result", { attemptId: attempt.id, justSubmitted: true }, { replace: true });
  }

  async function askToSubmit() {
    if (submitting || done) return;
    saveEssayLater.flush();
    const { answered, unanswered, marked } = counts();

    const modal = openModal({
      title: "Submit exam?",
      size: "sm",
      content: html`
        <div class="stat-grid" style="grid-template-columns:repeat(3,1fr)">
          <div class="stat"><p class="stat-value">${answered}</p><p class="stat-label">Answered</p></div>
          <div class="stat"><p class="stat-value">${unanswered}</p><p class="stat-label">Unanswered</p></div>
          <div class="stat"><p class="stat-value">${marked}</p><p class="stat-label">Marked</p></div>
        </div>
        ${unanswered > 0
          ? html`<p class="banner banner-warn" style="margin-top:14px">You still have ${unanswered} unanswered ${unanswered === 1 ? "question" : "questions"}.</p>`
          : html`<p class="modal-text" style="margin-top:14px">You answered every question.</p>`}`,
      actions: [
        { label: "Cancel", variant: "secondary", value: false },
        { label: "Submit exam", variant: "primary", value: true }
      ]
    });

    if ((await modal.result) === true) await finish("manual");
  }

  /* ======================================================================
     Events
     ====================================================================== */

  const onOptionClick = (event, button) => {
    const q = questions[current];
    if (q.type !== "mcq") return;
    const index = Number(button.dataset.option);
    attempt.mcqAnswers[q.id] = index;
    inBackground(attemptService.saveMcqAnswer(attempt.id, q.id, index));

    els.answers.querySelectorAll(".option").forEach((el) => {
      const selected = Number(el.dataset.option) === index;
      el.classList.toggle("is-selected", selected);
      el.setAttribute("aria-checked", String(selected));
    });
    updateChrome();
  };
  const stopOptions = delegate(els.answers, "click", ".option", onOptionClick);

  const onEssayInput = (event) => {
    if (!event.target.matches("#essay-input")) return;
    const q = questions[current];
    const text = event.target.value;
    attempt.essayAnswers[q.id] = { ...(attempt.essayAnswers[q.id] || {}), text };
    saveEssayLater(q.id, text);
    updateChrome();
  };
  els.answers.addEventListener("input", onEssayInput);

  const stopDots = delegate(els.navigator, "click", ".q-dot", (event, dot) => goTo(Number(dot.dataset.index)));

  const onBack = () => goTo(current - 1);
  const onNext = () => goTo(current + 1);
  const onMark = () => {
    const q = questions[current];
    const at = attempt.marked.indexOf(q.id);
    if (at >= 0) attempt.marked.splice(at, 1); else attempt.marked.push(q.id);
    inBackground(attemptService.saveMarked(attempt.id, attempt.marked.slice()));
    updateChrome();
  };
  els.back.addEventListener("click", onBack);
  els.next.addEventListener("click", onNext);
  els.mark.addEventListener("click", onMark);
  els.submit.addEventListener("click", askToSubmit);

  /* ---- deterrents ---- */
  const notice = (message) => {
    const now = Date.now();
    if (now - lastNotice < 4000) return;
    lastNotice = now;
    toast(message);
  };
  const stop = (message) => (event) => { event.preventDefault(); if (message) notice(message); };

  const onContextMenu = stop();
  const onCopyCut = stop("Copying is turned off during the exam.");
  const onPaste = stop("Pasting is turned off during the exam.");
  const onDrop = stop();
  const onBeforeInput = (event) => {
    if (event.inputType === "insertFromPaste" || event.inputType === "insertFromDrop") {
      event.preventDefault();
      notice("Pasting is turned off during the exam.");
    }
  };
  const onKeydown = (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (["c", "x", "v", "p", "s", "u"].includes(event.key.toLowerCase())) event.preventDefault();
  };

  container.addEventListener("contextmenu", onContextMenu);
  container.addEventListener("copy", onCopyCut);
  container.addEventListener("cut", onCopyCut);
  container.addEventListener("paste", onPaste);
  container.addEventListener("drop", onDrop);
  container.addEventListener("dragstart", onDrop);
  container.addEventListener("beforeinput", onBeforeInput);
  document.addEventListener("keydown", onKeydown);

  /* ---- leaving the tab, or the page ---- */
  const onVisibility = () => {
    if (document.visibilityState !== "visible") return;
    tick();
    if (done || submitting || leftPage) return;

    inBackground(attemptService.recordTabSwitch(attempt.id));
    openModal({
      title: "You left the exam",
      dismissible: false,
      size: "sm",
      content: html`<p class="modal-text">Switching to another tab or app during the exam is recorded and your teacher can see it. Please stay on this page until you submit.</p>`,
      actions: [{ label: "Continue exam", variant: "primary", value: true }]
    });
  };
  document.addEventListener("visibilitychange", onVisibility);

  /* Closing the tab or browser, or reloading: submit what is saved so far.
     (The write is queued on the device at once and is sent as soon as possible.) */
  const onPageHide = () => {
    if (done || submitting || leftPage) return;
    leftPage = true;
    attemptService.submit(exam, attempt, { reason: "left-page" }).catch(() => {});
  };
  const onBeforeUnload = (event) => {
    if (done || submitting || leftPage) return;
    event.preventDefault();
    event.returnValue = "";
  };
  const onPageShow = (event) => {
    // Coming back through the browser's history after leaving: start fresh from the result.
    if (event.persisted && leftPage) window.location.reload();
  };
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("beforeunload", onBeforeUnload);
  window.addEventListener("pageshow", onPageShow);

  /* ---- go ---- */
  paintQuestion();
  startTimer();

  return function cleanup() {
    clearInterval(timerId);
    saveEssayLater.cancel();
    stopOptions();
    stopDots();
    els.answers.removeEventListener("input", onEssayInput);
    els.back.removeEventListener("click", onBack);
    els.next.removeEventListener("click", onNext);
    els.mark.removeEventListener("click", onMark);
    els.submit.removeEventListener("click", askToSubmit);
    container.removeEventListener("contextmenu", onContextMenu);
    container.removeEventListener("copy", onCopyCut);
    container.removeEventListener("cut", onCopyCut);
    container.removeEventListener("paste", onPaste);
    container.removeEventListener("drop", onDrop);
    container.removeEventListener("dragstart", onDrop);
    container.removeEventListener("beforeinput", onBeforeInput);
    document.removeEventListener("keydown", onKeydown);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("beforeunload", onBeforeUnload);
    window.removeEventListener("pageshow", onPageShow);
    ctx.setNavigationGuard(null);
    ctx.setExamMode(false);
  };
}