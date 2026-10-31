/* ============================================================================
   CODE CRAFT — QUIZ PLATFORM
   js/exams.js

   The staff side of exams (the student side is exam-engine.js):

     renderExams         every exam, with filters
     renderExamBuilder   create / edit an exam: multiple-choice and essay questions,
                         points, explanations, opening and closing time, draft or publish
     renderExamDetail    one exam: who took it, grading progress, question statistics,
                         publishing the ranking

   The ranking itself is calculated in ranking.js:
       export async function publishExamRanking(exam) → { ranked, excluded }
   This file loads it only when the "Publish ranking" button is pressed.
   ============================================================================ */

import { GRADES, SUBJECTS, ACCOUNT_STATUS } from "./firebase-config.js";
import {
  examService, attemptService, studentService, rankingService, resultService,
  validateExam, computeExamTotals, examPhase, toMillis, newId
} from "./data-services.js";

import {
  html, setHtml, icon, badge, statusBadge, emptyState, loadingRows,
  confirmDialog, toast, delegate, withBusy,
  formatDateTime, formatDuration, formatPercent, formatPoints,
  toDateTimeLocalValue, fromDateTimeLocalValue
} from "./ui-helpers.js";

/* ============================================================================
   1. SHARED HELPERS
   ============================================================================ */

const paramsOf = (object) => JSON.stringify(object);
const DAY_MS = 24 * 60 * 60 * 1000;

function truncate(text, max = 140) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function fail(err) {
  console.error("[exams]", err);
  toast(err && err.message ? err.message : "Something went wrong. Please try again.", { type: "error" });
}

function showLoadError(container, title, err) {
  console.error(`[exams] ${title}:`, err);
  setHtml(container, html`
    <div class="page-head"><h1 class="page-title">${title}</h1></div>
    ${emptyState({
      title: "We couldn't load this",
      message: err && err.message ? err.message : "Please check your connection and try again.",
      action: html`<button type="button" class="btn btn-secondary" data-retry>Try again</button>`
    })}`);
}

/** "draft" | "upcoming" | "open" | "closed" */
const kindOf = (exam) => (exam.status === "draft" ? "draft" : examPhase(exam));

function kindBadge(exam) {
  return exam.status === "draft" ? statusBadge("exam", "draft") : statusBadge("phase", examPhase(exam));
}

const letter = (i) => String.fromCharCode(65 + i);

/* ============================================================================
   2. EXAM LIST
   ============================================================================ */

export async function renderExams(container, ctx) {
  setHtml(container, loadingRows(4));

  let exams;
  try {
    exams = await examService.listAll();
  } catch (err) {
    showLoadError(container, "Exams", err);
    return undefined;
  }

  const filters = { kind: "all", query: "" };
  const count = (kind) => exams.filter((e) => kindOf(e) === kind).length;

  setHtml(container, html`
    <header class="page-head">
      <div>
        <h1 class="page-title">Exams</h1>
        <p class="page-sub">${exams.length} ${exams.length === 1 ? "exam" : "exams"}</p>
      </div>
      <button type="button" class="btn btn-primary" data-nav="staff-exam-builder">${icon("plus", { size: 18 })} New exam</button>
    </header>

    <div class="toolbar">
      <div class="field search">
        <label class="sr-only" for="exam-search">Search exams</label>
        <input id="exam-search" type="search" placeholder="Search by title" autocomplete="off">
      </div>
    </div>
    <div class="row" id="exam-chips" style="margin-bottom:16px"></div>
    <div id="exam-list"></div>`);

  const chipsBox = container.querySelector("#exam-chips");
  const listBox = container.querySelector("#exam-list");

  function paintChips() {
    const chips = [
      ["all", `All (${exams.length})`],
      ["open", `Open (${count("open")})`],
      ["upcoming", `Upcoming (${count("upcoming")})`],
      ["closed", `Closed (${count("closed")})`],
      ["draft", `Drafts (${count("draft")})`]
    ];
    setHtml(chipsBox, chips.map(([value, label]) => html`
      <button type="button" class="chip ${filters.kind === value ? "is-active" : ""}" data-action="filter" data-kind="${value}">${label}</button>`));
  }

  function paintList() {
    const q = filters.query.trim().toLowerCase();
    const shown = exams.filter((e) =>
      (filters.kind === "all" || kindOf(e) === filters.kind) &&
      (!q || String(e.title).toLowerCase().includes(q))
    );

    if (!shown.length) {
      setHtml(listBox, emptyState({
        title: exams.length ? "No exams found" : "No exams yet",
        message: exams.length ? "Try a different search or filter." : "Create your first exam with the New exam button."
      }));
      return;
    }

    setHtml(listBox, html`<div class="list">${shown.map((e) => html`
      <button type="button" class="list-item"
              data-nav="${e.status === "draft" ? "staff-exam-builder" : "staff-exam-detail"}"
              data-nav-params="${paramsOf({ examId: e.id })}">
        <div class="list-item-main">
          <p class="list-item-title" dir="auto">${e.title}</p>
          <p class="list-item-sub">${e.subject} · ${e.assignedGrade} · ${e.questionCount || 0} questions · ${formatPoints(e.totalPoints || 0)} points</p>
          <p class="list-item-sub">${e.startAt && e.endAt
            ? `Opens ${formatDateTime(e.startAt)} · closes ${formatDateTime(e.endAt)}`
            : "No schedule yet"}</p>
        </div>
        <div class="list-item-end">${kindBadge(e)}</div>
      </button>`)}</div>`);
  }

  paintChips();
  paintList();

  const search = container.querySelector("#exam-search");
  const onSearch = () => { filters.query = search.value; paintList(); };
  search.addEventListener("input", onSearch);

  const stop = delegate(container, "click", "[data-action='filter']", (event, el) => {
    filters.kind = el.dataset.kind;
    paintChips();
    paintList();
  });

  return () => { stop(); search.removeEventListener("input", onSearch); };
}

/* ============================================================================
   3. EXAM BUILDER
   ============================================================================ */

const OPTIONS_PER_QUESTION = 4;

const blankOptions = () => Array.from({ length: OPTIONS_PER_QUESTION }, () => ({ text: "", explanation: "" }));
const blankMcq = () => ({ key: newId("k"), type: "mcq", text: "", points: 1, correctAnswer: -1, explain: false, options: blankOptions() });
const blankEssay = () => ({ key: newId("k"), type: "essay", text: "", points: 2 });

/** authored question (from the database) → editable state */
function questionToState(q) {
  const base = { key: newId("k"), id: q.id, type: q.type, text: q.text, points: q.points };
  if (q.type === "essay") return base;

  const options = (q.options || []).map((o) => ({ text: o.text || "", explanation: o.explanation || "" }));
  while (options.length < OPTIONS_PER_QUESTION) options.push({ text: "", explanation: "" });
  return {
    ...base,
    options,
    correctAnswer: q.correctAnswer,
    explain: !!q.hasExplanations || options.some((o) => o.explanation)
  };
}

/** editable state → the shape examService.save() expects */
function questionToAuthored(q) {
  if (q.type === "essay") {
    return { id: q.id, type: "essay", text: q.text, points: Number(q.points) };
  }
  // Leave unused option boxes empty: they are dropped, and the "correct" index follows.
  const kept = [];
  let correctAnswer = -1;
  q.options.forEach((option, i) => {
    if (!option.text.trim()) return;
    if (i === q.correctAnswer) correctAnswer = kept.length;
    kept.push({ text: option.text, explanation: q.explain ? option.explanation : "" });
  });
  return { id: q.id, type: "mcq", text: q.text, points: Number(q.points), correctAnswer, options: kept };
}

function defaultSchedule() {
  const start = Math.ceil(Date.now() / 300000) * 300000; // next 5 minutes
  return { startAt: start, endAt: start + DAY_MS };
}

export async function renderExamBuilder(container, ctx) {
  const editingId = ctx.params.examId || null;
  setHtml(container, loadingRows(5));

  /* ---------- load ---------- */
  const state = {
    id: null,
    status: "draft",
    title: "",
    subject: SUBJECTS[0],
    assignedGrade: GRADES[GRADES.length - 1],
    durationMin: 30,
    ...defaultSchedule(),
    questions: []
  };
  let locked = false;   // students already took it: questions and duration are frozen
  let dirty = false;

  if (editingId) {
    try {
      const exam = await examService.getForEdit(editingId);
      const attempts = exam.status === "published" ? await attemptService.listForExam(editingId) : [];
      Object.assign(state, {
        id: exam.id,
        status: exam.status,
        title: exam.title,
        subject: exam.subject,
        assignedGrade: exam.assignedGrade,
        durationMin: Math.round((exam.duration || 0) / 60) || 30,
        startAt: toMillis(exam.startAt) || state.startAt,
        endAt: toMillis(exam.endAt) || state.endAt,
        questions: (exam.questions || []).map(questionToState)
      });
      locked = attempts.length > 0;
    } catch (err) {
      showLoadError(container, "Exam builder", err);
      return undefined;
    }
  }

  const lock = locked ? "disabled" : "";

  /* ---------- page ---------- */
  setHtml(container, html`
    <header class="page-head">
      <div>
        <button type="button" class="btn btn-ghost" data-nav="staff-exams">${icon("chevron-left", { size: 18 })} Exams</button>
        <h1 class="page-title" style="margin-top:8px">${state.id ? "Edit exam" : "New exam"}</h1>
      </div>
    </header>

    <div class="stack-lg">
      ${locked ? html`
        <div class="banner banner-info" role="status">
          ${icon("lock", { size: 20 })}
          <span>Students have already taken this exam, so its questions and duration are locked. You can still change the title, the closing time and the correct answers.</span>
        </div>` : ""}

      <div id="builder-errors" role="alert" hidden></div>

      <section class="card">
        <h2 class="card-title">Exam details</h2>
        <div class="form">
          <div class="field">
            <label for="b-title">Title</label>
            <input id="b-title" type="text" dir="auto" data-field="title" value="${state.title}">
          </div>
          <div class="field-row">
            <div class="field">
              <label for="b-subject">Subject</label>
              <select id="b-subject" data-field="subject" ${lock}>
                ${SUBJECTS.map((s) => html`<option value="${s}" ${s === state.subject ? "selected" : ""}>${s}</option>`)}
              </select>
            </div>
            <div class="field">
              <label for="b-grade">Grade</label>
              <select id="b-grade" data-field="assignedGrade" ${lock}>
                ${GRADES.map((g) => html`<option value="${g}" ${g === state.assignedGrade ? "selected" : ""}>${g}</option>`)}
              </select>
            </div>
          </div>
          <div class="field">
            <label for="b-duration">Time to finish once started (minutes)</label>
            <input id="b-duration" type="number" min="1" max="360" step="1" data-field="durationMin" value="${state.durationMin}" ${lock}>
          </div>
          <div class="field-row">
            <div class="field">
              <label for="b-start">Opens</label>
              <input id="b-start" type="datetime-local" data-field="startAt" value="${toDateTimeLocalValue(state.startAt)}" ${lock}>
            </div>
            <div class="field">
              <label for="b-end">Closes</label>
              <input id="b-end" type="datetime-local" data-field="endAt" value="${toDateTimeLocalValue(state.endAt)}">
            </div>
          </div>
          <p class="field-hint">Students can start the exam any time between these two moments. Once they start, their own timer runs for the minutes above.</p>
        </div>
      </section>

      <section>
        <div class="section-head">
          <h2 class="section-title">Questions</h2>
          <p class="page-sub num" id="questions-summary"></p>
        </div>
        <div class="stack-lg" id="questions-box"></div>
        ${locked ? "" : html`
          <div class="row" style="margin-top:16px">
            <button type="button" class="btn btn-secondary" data-action="add-mcq">${icon("plus", { size: 18 })} Multiple choice</button>
            <button type="button" class="btn btn-secondary" data-action="add-essay">${icon("plus", { size: 18 })} Essay</button>
          </div>`}
      </section>

      <div class="row">
        <button type="button" class="btn btn-secondary" id="b-save-draft" data-action="save-draft">Save draft</button>
        <button type="button" class="btn btn-primary" id="b-publish" data-action="publish">${state.status === "published" ? "Save changes" : "Publish exam"}</button>
      </div>
    </div>`);

  const questionsBox = container.querySelector("#questions-box");
  const errorsBox = container.querySelector("#builder-errors");

  /* ---------- questions ---------- */
  function updateSummary() {
    const totals = computeExamTotals(state.questions.map((q) => ({ type: q.type, points: Number(q.points) || 1 })));
    container.querySelector("#questions-summary").textContent = state.questions.length
      ? `${totals.questionCount} questions, ${formatPoints(totals.totalPoints)} points`
      : "";
  }

  function mcqCard(q, number) {
    return html`
      <div class="field">
        <label for="q-text-${q.key}">Question text</label>
        <textarea id="q-text-${q.key}" dir="auto" rows="3" data-field="text" ${lock}>${q.text}</textarea>
      </div>

      <fieldset style="border:0;padding:0;margin:0">
        <legend class="field-hint" style="margin-bottom:8px">Fill in the options and select the correct one. Leave unused boxes empty.</legend>
        <div class="stack">
          ${q.options.map((option, i) => html`
            <div class="option-row">
              <input type="radio" name="correct-${q.key}" value="${i}" data-field="correct"
                     aria-label="Option ${letter(i)} is correct" ${q.correctAnswer === i ? "checked" : ""}>
              <div class="stack" style="gap:8px">
                <input type="text" dir="auto" data-field="optionText" data-opt="${i}" value="${option.text}"
                       aria-label="Option ${letter(i)}" ${lock}>
                ${q.explain ? html`
                  <textarea rows="2" dir="auto" data-field="optionExplanation" data-opt="${i}"
                            aria-label="Why option ${letter(i)} is right or wrong" ${lock}>${option.explanation}</textarea>` : ""}
              </div>
            </div>`)}
        </div>
      </fieldset>

      <label class="row" style="gap:10px">
        <input type="checkbox" data-field="explain" ${q.explain ? "checked" : ""} ${lock}>
        <span>Explain why each option is right or wrong <span class="label-note">(optional, for harder questions)</span></span>
      </label>`;
  }

  function essayCard(q) {
    return html`
      <div class="field">
        <label for="q-text-${q.key}">Question text</label>
        <textarea id="q-text-${q.key}" dir="auto" rows="4" data-field="text" ${lock}>${q.text}</textarea>
      </div>`;
  }

  function paintQuestions() {
    if (!state.questions.length) {
      setHtml(questionsBox, emptyState({
        title: "No questions yet",
        message: "Add a multiple-choice or an essay question to begin."
      }));
      updateSummary();
      return;
    }

    setHtml(questionsBox, state.questions.map((q, index) => html`
      <article class="builder-q" data-key="${q.key}">
        <div class="builder-q-head">
          <div class="row" style="gap:10px">
            <strong>Question ${index + 1}</strong>
            ${badge(q.type === "mcq" ? "Multiple choice" : "Essay", q.type === "mcq" ? "blue" : "orange")}
          </div>
          ${locked ? "" : html`
            <div class="row" style="gap:2px">
              <button type="button" class="icon-btn" data-action="up" aria-label="Move question ${index + 1} up" ${index === 0 ? "disabled" : ""}><span style="display:inline-flex;transform:rotate(180deg)">${icon("chevron-down", { size: 18 })}</span></button>
              <button type="button" class="icon-btn" data-action="down" aria-label="Move question ${index + 1} down" ${index === state.questions.length - 1 ? "disabled" : ""}>${icon("chevron-down", { size: 18 })}</button>
              <button type="button" class="icon-btn is-danger" data-action="remove" aria-label="Delete question ${index + 1}">${icon("trash", { size: 18 })}</button>
            </div>`}
        </div>

        ${q.type === "mcq" ? mcqCard(q, index + 1) : essayCard(q)}

        <div class="field" style="max-width:180px">
          <label for="q-points-${q.key}">Points</label>
          <input id="q-points-${q.key}" type="number" min="0.5" step="0.5" data-field="points" value="${q.points}" ${lock}>
        </div>
      </article>`));

    updateSummary();
  }

  paintQuestions();

  /* ---------- editing ---------- */
  function markDirty() { dirty = true; }

  function onFieldChange(event) {
    const el = event.target;
    const field = el.dataset && el.dataset.field;
    if (!field) return;
    markDirty();

    const card = el.closest("[data-key]");
    const q = card ? state.questions.find((item) => item.key === card.dataset.key) : null;

    if (!q) {
      if (field === "title") state.title = el.value;
      else if (field === "subject") state.subject = el.value;
      else if (field === "assignedGrade") state.assignedGrade = el.value;
      else if (field === "durationMin") state.durationMin = Number(el.value);
      else if (field === "startAt") state.startAt = fromDateTimeLocalValue(el.value);
      else if (field === "endAt") state.endAt = fromDateTimeLocalValue(el.value);
      return;
    }

    const optionIndex = Number(el.dataset.opt);
    switch (field) {
      case "text": q.text = el.value; break;
      case "points": q.points = el.value; updateSummary(); break;
      case "optionText": q.options[optionIndex].text = el.value; break;
      case "optionExplanation": q.options[optionIndex].explanation = el.value; break;
      case "correct": if (el.checked) q.correctAnswer = Number(el.value); break;
      case "explain": q.explain = el.checked; paintQuestions(); break;
      default:
    }
  }
  container.addEventListener("input", onFieldChange);
  container.addEventListener("change", onFieldChange);

  /* ---------- saving ---------- */
  function showErrors(messages) {
    setHtml(errorsBox, html`
      <div class="form-error">
        <strong>Please fix the following:</strong>
        <ul style="margin:6px 0 0;padding-inline-start:20px">${messages.map((m) => html`<li>${m}</li>`)}</ul>
      </div>`);
    errorsBox.hidden = false;
    errorsBox.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function buildExam(status) {
    return {
      id: state.id || undefined,
      title: state.title,
      subject: state.subject,
      assignedGrade: state.assignedGrade,
      duration: Math.round((Number(state.durationMin) || 0) * 60),
      startAt: state.startAt,
      endAt: state.endAt,
      status,
      questions: state.questions.map(questionToAuthored)
    };
  }

  async function save(status, button) {
    errorsBox.hidden = true;
    const exam = buildExam(status);

    const errors = validateExam(exam, { forPublish: status === "published" });
    if (errors.length) { showErrors(errors); return; }

    if (status === "published" && state.status !== "published") {
      const ok = await confirmDialog({
        title: `Publish ${exam.title}?`,
        message: `${exam.assignedGrade} students of ${exam.subject} will see it from ${formatDateTime(exam.startAt)} until ${formatDateTime(exam.endAt)}. After a student starts it, its questions can't be changed.`,
        confirmLabel: "Publish"
      });
      if (!ok) return;
    }

    await withBusy(button, async () => {
      try {
        const id = await examService.save(exam);
        dirty = false;
        if (status === "published") {
          toast(state.status === "published" ? "Changes saved." : "Exam published.", { type: "success" });
          ctx.navigate("staff-exam-detail", { examId: id }, { replace: true });
        } else {
          toast("Draft saved.", { type: "success" });
          ctx.navigate("staff-exam-builder", { examId: id }, { replace: true });
        }
      } catch (err) {
        showErrors(err && err.details && err.details.length ? err.details : [err && err.message ? err.message : "Couldn't save the exam."]);
      }
    });
  }

  const stopClicks = delegate(container, "click", "[data-action]", async (event, el) => {
    const action = el.dataset.action;
    const card = el.closest("[data-key]");
    const index = card ? state.questions.findIndex((q) => q.key === card.dataset.key) : -1;

    switch (action) {
      case "add-mcq":
      case "add-essay": {
        const q = action === "add-mcq" ? blankMcq() : blankEssay();
        state.questions.push(q);
        markDirty();
        paintQuestions();
        const field = container.querySelector(`#q-text-${q.key}`);
        if (field) { field.scrollIntoView({ behavior: "smooth", block: "center" }); field.focus({ preventScroll: true }); }
        break;
      }
      case "up":
        if (index > 0) { [state.questions[index - 1], state.questions[index]] = [state.questions[index], state.questions[index - 1]]; markDirty(); paintQuestions(); }
        break;
      case "down":
        if (index >= 0 && index < state.questions.length - 1) { [state.questions[index + 1], state.questions[index]] = [state.questions[index], state.questions[index + 1]]; markDirty(); paintQuestions(); }
        break;
      case "remove": {
        const q = state.questions[index];
        if (!q) break;
        const hasContent = q.text.trim() || (q.options || []).some((o) => o.text.trim());
        const ok = !hasContent || await confirmDialog({
          title: `Delete question ${index + 1}?`,
          message: "This can't be undone.",
          confirmLabel: "Delete",
          danger: true
        });
        if (ok) { state.questions.splice(index, 1); markDirty(); paintQuestions(); }
        break;
      }
      case "save-draft": await save("draft", el); break;
      case "publish": await save("published", el); break;
      default:
    }
  });

  /* ---------- don't lose a long exam by accident ---------- */
  const onBeforeUnload = (event) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
  window.addEventListener("beforeunload", onBeforeUnload);
  ctx.setNavigationGuard(() => !dirty || window.confirm("You have unsaved changes. Leave without saving?"));

  return () => {
    stopClicks();
    container.removeEventListener("input", onFieldChange);
    container.removeEventListener("change", onFieldChange);
    window.removeEventListener("beforeunload", onBeforeUnload);
    ctx.setNavigationGuard(null);
  };
}

/* ============================================================================
   4. EXAM DETAIL
   ============================================================================ */

function rankingBlockers(exam, progress) {
  const reasons = [];
  if (examPhase(exam) !== "closed") reasons.push("The exam is still open or hasn't opened yet.");
  if (!progress.total) reasons.push("Nobody has taken this exam.");
  if (progress.inProgress) reasons.push(`${progress.inProgress} unfinished ${progress.inProgress === 1 ? "attempt needs" : "attempts need"} to be submitted.`);
  if (progress.pending) reasons.push(`${progress.pending} ${progress.pending === 1 ? "student still needs" : "students still need"} grading.`);
  return reasons;
}

export async function renderExamDetail(container, ctx) {
  const examId = ctx.params.examId;
  if (!examId) { ctx.navigate("staff-exams", {}, { replace: true }); return undefined; }

  setHtml(container, loadingRows(5));

  let data = null;
  const ui = { showAbsent: false, hardFirst: false };

  async function load() {
    const exam = await examService.get(examId);
    if (!exam) throw new Error("We couldn't find this exam.");
    const [key, attempts, students, ranking] = await Promise.all([
      examService.getKey(examId),
      attemptService.listForExam(examId),
      studentService.listAll({ status: ACCOUNT_STATUS.ACTIVE, grade: exam.assignedGrade, subject: exam.subject }),
      rankingService.getExam(examId).catch(() => null)
    ]);
    data = { exam, key, attempts, students, ranking };
  }

  function statCard(stat, number, exam, key) {
    if (stat.type === "mcq") {
      const question = (exam.questions || []).find((q) => q.id === stat.id);
      const correct = (key.answers || {})[stat.id];
      const tone = stat.incorrectPercent >= 50 ? "red" : stat.incorrectPercent >= 30 ? "orange" : "green";
      return html`
        <article class="card stack">
          <div class="row row-between">
            <p class="page-sub">Question ${number} · Multiple choice</p>
            ${badge(`${formatPercent(stat.incorrectPercent)} did not get it right`, tone)}
          </div>
          <p dir="auto">${truncate(stat.text, 180)}</p>
          <div class="meter" aria-hidden="true"><span style="width:${stat.incorrectPercent}%"></span></div>
          ${question ? html`
            <div class="stack" style="gap:6px">
              ${question.options.map((option, i) => html`
                <div class="row row-between" style="flex-wrap:nowrap">
                  <span dir="auto">${letter(i)}. ${truncate(option.text, 70)} ${i === correct ? badge("Correct", "green") : ""}</span>
                  <span class="num">${stat.optionCounts[i] || 0}</span>
                </div>`)}
              ${stat.unanswered ? html`<div class="row row-between"><span class="page-sub">Not answered</span><span class="num">${stat.unanswered}</span></div>` : ""}
            </div>` : ""}
        </article>`;
    }

    return html`
      <article class="card stack">
        <div class="row row-between">
          <p class="page-sub">Question ${number} · Essay</p>
          ${stat.averagePercent === null ? badge("Not graded yet", "gray") : badge(`${formatPercent(stat.averagePercent)} of the points on average`, stat.averagePercent < 50 ? "red" : stat.averagePercent < 70 ? "orange" : "green")}
        </div>
        <p dir="auto">${truncate(stat.text, 180)}</p>
        <div class="meter" aria-hidden="true"><span style="width:${stat.averagePercent || 0}%"></span></div>
        <p class="page-sub">${stat.gradedCount} of ${stat.attempts} answers graded</p>
      </article>`;
  }

  function paint() {
    const { exam, key, attempts, students, ranking } = data;

    if (exam.status === "draft") {
      setHtml(container, html`
        <header class="page-head"><h1 class="page-title" dir="auto">${exam.title}</h1></header>
        ${emptyState({
          title: "This exam is still a draft",
          message: "Students can't see it yet. Continue editing to publish it.",
          action: html`<button type="button" class="btn btn-primary" data-nav="staff-exam-builder" data-nav-params="${paramsOf({ examId })}">Continue editing</button>`
        })}`);
      return;
    }

    const phase = examPhase(exam);
    const progress = resultService.examGradingProgress(attempts);
    const tookUids = new Set(attempts.map((a) => a.studentUid));
    const absent = students.filter((s) => !tookUids.has(s.uid));
    const blockers = rankingBlockers(exam, progress);
    const hasEssay = (exam.essayCount || 0) > 0;
    const readyForRanking = blockers.length === 0;

    let stats = resultService.computeQuestionStats(exam, key, attempts).map((s, i) => ({ ...s, number: i + 1 }));
    if (ui.hardFirst) {
      stats = stats.sort((a, b) => (b.incorrectPercent ?? 100 - (b.averagePercent ?? 100)) - (a.incorrectPercent ?? 100 - (a.averagePercent ?? 100)));
    }

    setHtml(container, html`
      <header class="page-head">
        <div>
          <button type="button" class="btn btn-ghost" data-nav="staff-exams">${icon("chevron-left", { size: 18 })} Exams</button>
          <h1 class="page-title" dir="auto" style="margin-top:8px">${exam.title}</h1>
          <p class="page-sub">${exam.subject} · ${exam.assignedGrade}</p>
        </div>
        <div class="row">
          ${kindBadge(exam)}
          <button type="button" class="btn btn-secondary btn-sm" data-nav="staff-exam-builder" data-nav-params="${paramsOf({ examId })}">${icon("pencil", { size: 16 })} Edit</button>
          <button type="button" class="btn btn-secondary btn-sm" data-action="duplicate">${icon("copy", { size: 16 })} Duplicate</button>
          <button type="button" class="btn btn-ghost btn-sm" data-action="delete">${icon("trash", { size: 16 })} Delete</button>
        </div>
      </header>

      <div class="stack-lg">
        <section class="card">
          <div class="info-list">
            <div class="info-row"><span class="info-label">Opens</span><span class="info-value">${formatDateTime(exam.startAt)}</span></div>
            <div class="info-row"><span class="info-label">Closes</span><span class="info-value">${formatDateTime(exam.endAt)}</span></div>
            <div class="info-row"><span class="info-label">Time to finish</span><span class="info-value">${formatDuration(exam.duration)}</span></div>
            <div class="info-row"><span class="info-label">Questions</span><span class="info-value">${exam.mcqCount || 0} multiple choice, ${exam.essayCount || 0} essay</span></div>
            <div class="info-row"><span class="info-label">Total points</span><span class="info-value num">${formatPoints(exam.totalPoints || 0)}</span></div>
          </div>
        </section>

        <section>
          <div class="section-head"><h2 class="section-title">Who took it</h2></div>
          <div class="stat-grid">
            <div class="stat"><p class="stat-value">${students.length}</p><p class="stat-label">Students in this class</p></div>
            <div class="stat"><p class="stat-value">${progress.submitted}</p><p class="stat-label">Handed in</p></div>
            <div class="stat"><p class="stat-value">${progress.inProgress}</p><p class="stat-label">Still working</p></div>
            <div class="stat"><p class="stat-value">${absent.length}</p><p class="stat-label">${phase === "closed" ? "Absent" : "Haven't started yet"}</p></div>
          </div>

          ${phase === "closed" && progress.inProgress ? html`
            <div class="banner banner-warn" style="margin-top:12px">
              ${icon("alert", { size: 20 })}
              <span style="flex:1">${progress.inProgress} ${progress.inProgress === 1 ? "student never" : "students never"} handed in. Their saved answers can be submitted for them.</span>
              <button type="button" class="btn btn-secondary btn-sm" data-action="submit-unfinished">Submit them</button>
            </div>` : ""}

          ${absent.length ? html`
            <div style="margin-top:12px">
              <button type="button" class="link-btn" data-action="toggle-absent">${ui.showAbsent ? "Hide" : "Show"} ${phase === "closed" ? "absent students" : "students who haven't started"} (${absent.length})</button>
              ${ui.showAbsent ? html`
                <div class="list" style="margin-top:10px">${absent.map((s) => html`
                  <button type="button" class="list-item" data-nav="staff-student" data-nav-params="${paramsOf({ uid: s.uid })}">
                    <div class="list-item-main">
                      <p class="list-item-title" dir="auto">${s.name}</p>
                      <p class="list-item-sub">Mobile <span class="num" dir="ltr">${s.mobile}</span> · Parent <span class="num" dir="ltr">${s.parentMobile}</span></p>
                    </div>
                    ${icon("chevron-right", { size: 18 })}
                  </button>`)}</div>` : ""}
            </div>` : ""}
        </section>

        <section class="card stack">
          <h2 class="card-title" style="margin:0">Grading</h2>
          ${hasEssay ? html`
            <div class="meter" aria-hidden="true"><span style="width:${progress.submitted ? (progress.graded / progress.submitted) * 100 : 0}%"></span></div>
            <p class="page-sub">${progress.graded} of ${progress.submitted} students fully graded</p>
            <div><button type="button" class="btn btn-secondary" data-nav="staff-grading" data-nav-params="${paramsOf({ examId })}">${icon("pencil", { size: 18 })} Grade essays</button></div>`
          : html`<p class="page-sub">This exam has no essay questions, so it is graded automatically.</p>`}
        </section>

        <section class="card stack">
          <h2 class="card-title" style="margin:0">Ranking</h2>
          ${ranking ? html`
            <p>${badge("Published", "green")} <span class="page-sub">on ${formatDateTime(ranking.publishedAt)} · ${ranking.totalRanked} students ranked</span></p>` :
            html`<p>${badge("Not published", "gray")} <span class="page-sub">Students see "ranking pending" until you publish it.</span></p>`}
          ${blockers.length ? html`
            <ul class="page-sub" style="margin:0;padding-inline-start:20px">${blockers.map((b) => html`<li>${b}</li>`)}</ul>` : ""}
          <div class="row">
            <button type="button" class="btn btn-primary" data-action="publish-ranking" ${readyForRanking ? "" : "disabled"}>${ranking ? "Update ranking" : "Publish ranking"}</button>
            ${ranking ? html`<button type="button" class="btn btn-ghost" data-action="unpublish-ranking">Unpublish</button>` : ""}
          </div>
        </section>

        <section>
          <div class="section-head">
            <h2 class="section-title">Question statistics</h2>
            ${progress.submitted ? html`<button type="button" class="chip ${ui.hardFirst ? "is-active" : ""}" data-action="toggle-hard">Hardest first</button>` : ""}
          </div>
          ${progress.submitted
            ? html`
              <p class="page-sub" style="margin-bottom:12px">Based on ${progress.submitted} ${progress.submitted === 1 ? "submission" : "submissions"}. Use it to decide what to explain again in class.</p>
              <div class="stack">${stats.map((s) => statCard(s, s.number, exam, key))}</div>`
            : html`<p class="page-sub">Statistics appear once students hand in their exams.</p>`}
        </section>
      </div>`);
  }

  async function refresh() {
    try { await load(); paint(); } catch (err) { fail(err); }
  }

  const stopClicks = delegate(container, "click", "[data-action]", async (event, el) => {
    const { exam, attempts } = data || {};
    if (!exam) return;

    switch (el.dataset.action) {
      case "toggle-absent": ui.showAbsent = !ui.showAbsent; paint(); break;
      case "toggle-hard": ui.hardFirst = !ui.hardFirst; paint(); break;

      case "duplicate":
        await withBusy(el, async () => {
          try {
            const copyId = await examService.duplicate(examId);
            toast("A copy was saved as a draft. Set its opening and closing time, then publish.", { type: "success" });
            ctx.navigate("staff-exam-builder", { examId: copyId });
          } catch (err) { fail(err); }
        });
        break;

      case "delete": {
        const ok = await confirmDialog({
          title: `Delete ${exam.title}?`,
          message: "This removes the exam and its ranking. An exam that students have already taken can't be deleted.",
          confirmLabel: "Delete",
          danger: true
        });
        if (!ok) break;
        try {
          await examService.remove(examId);
          toast("Exam deleted.");
          ctx.navigate("staff-exams", {}, { replace: true });
        } catch (err) { fail(err); }
        break;
      }

      case "submit-unfinished": {
        const open = attempts.filter((a) => a.status === "IN_PROGRESS");
        const ok = await confirmDialog({
          title: `Submit ${open.length} unfinished ${open.length === 1 ? "attempt" : "attempts"}?`,
          message: "Each student's saved answers are handed in exactly as they are.",
          confirmLabel: "Submit"
        });
        if (!ok) break;
        await withBusy(el, async () => {
          let done = 0;
          for (const attempt of open) {
            try { await attemptService.forceSubmit(exam, attempt); done += 1; }
            catch (err) { console.error("[exams] force submit failed:", err); }
          }
          toast(`${done} of ${open.length} submitted.`, { type: done === open.length ? "success" : "error" });
          await refresh();
        });
        break;
      }

      case "publish-ranking":
        await withBusy(el, async () => {
          try {
            const ranking = await import("./ranking.js").catch(() => null);
            if (!ranking || typeof ranking.publishExamRanking !== "function") {
              toast("The ranking tools aren't available yet.", { type: "error" });
              return;
            }
            const result = await ranking.publishExamRanking(exam);
            toast(`Ranking published for ${result.ranked} ${result.ranked === 1 ? "student" : "students"}.`, { type: "success" });
            await refresh();
          } catch (err) { fail(err); }
        });
        break;

      case "unpublish-ranking": {
        const ok = await confirmDialog({
          title: "Unpublish the ranking?",
          message: "Students will see \"ranking pending\" again until you publish it.",
          confirmLabel: "Unpublish",
          danger: true
        });
        if (!ok) break;
        try {
          await rankingService.unpublishExam(examId);
          toast("Ranking unpublished.");
          await refresh();
        } catch (err) { fail(err); }
        break;
      }
      default:
    }
  });

  try {
    await load();
    paint();
  } catch (err) {
    showLoadError(container, "Exam", err);
  }
  return stopClicks;
}