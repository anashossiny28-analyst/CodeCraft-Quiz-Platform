/* ============================================================================
   CODE CRAFT — QUIZ PLATFORM
   js/grading.js

   Grading the essay questions (admin, teacher and secretary all can):

     renderGrading   which exams / students are waiting.  Every student shows one of
                       Waiting · Being graded by <name> · ✔ Graded
                     so two people never grade the same student by accident.
     renderGrade     grade ONE student: read each answer, choose the points,
                     optionally write a note, then "Finish grading".

   How it works
     • Opening a student marks him "Being graded by you" (a claim that expires after an
       hour, so a forgotten tab never blocks him). Leaving without finishing releases it.
     • Points are saved the moment you choose them. Notes are saved while you type.
     • "Finish grading" adds everything up (the multiple-choice part is re-checked against
       the answer key), marks the student ✔, and tells him his result is ready.
     • You can always come back and change points, then press "Update final score".
   ============================================================================ */

import {
  examService, attemptService, rankingService, resultService, toMillis, DataError
} from "./data-services.js";

import {
  html, setHtml, icon, badge, emptyState, loadingRows, toast, delegate, debounce, withBusy,
  formatDateTime, formatPercent, formatPoints, ASSETS
} from "./ui-helpers.js";

/* ============================================================================
   1. PURE HELPERS
   ============================================================================ */

const paramsOf = (object) => JSON.stringify(object);

/** The point choices shown as buttons: 0, 0.5, 1 … up to the question's points. */
function pointSteps(max) {
  let step = max <= 5 ? 0.5 : 1;
  while (max / step > 24) step += 1;               // keep the row short for big questions
  const steps = [];
  for (let p = 0; p <= max + 1e-9; p += step) steps.push(Math.round(p * 2) / 2);
  if (steps[steps.length - 1] < max) steps.push(max);
  return steps;
}

/** Correct / Half / Incorrect shortcuts, always a multiple of 0.5. */
function quickPoints(max) {
  return { correct: max, half: Math.round(max) / 2, incorrect: 0 };
}

/** done | mine | busy | todo — what the list shows next to a student. */
function gradingState(attempt, myUid) {
  if (attempt.status === "COMPLETED") return { kind: "done" };
  if (attempt.gradingBy && resultService.isGradingClaimActive(attempt)) {
    return attempt.gradingBy.uid === myUid
      ? { kind: "mine" }
      : { kind: "busy", by: attempt.gradingBy.name };
  }
  return { kind: "todo" };
}

const ORDER = { todo: 0, mine: 1, busy: 1, done: 2 };

/** Waiting first (oldest hand-in first), then in progress, then done. */
function sortForGrading(attempts, myUid) {
  return [...attempts].sort((a, b) => {
    const byState = ORDER[gradingState(a, myUid).kind] - ORDER[gradingState(b, myUid).kind];
    if (byState) return byState;
    return (toMillis(a.submittedAt) || 0) - (toMillis(b.submittedAt) || 0);
  });
}

/** The next student nobody is grading, to continue straight away. */
function nextToGrade(attempts, currentId, myUid) {
  return sortForGrading(attempts, myUid).find(
    (a) => a.id !== currentId && a.status !== "IN_PROGRESS" && gradingState(a, myUid).kind === "todo"
  ) || null;
}

function stateBadge(attempt, myUid) {
  const state = gradingState(attempt, myUid);
  if (state.kind === "done") return badge("✔ Graded", "green");
  if (state.kind === "mine") return badge("Being graded by you", "orange");
  if (state.kind === "busy") return badge(`Being graded by ${state.by}`, "orange");
  return badge("Waiting", "gray");
}

const pointsTone = (points, max) => (points >= max ? "green" : points > 0 ? "orange" : "red");

function fail(err) {
  console.error("[grading]", err);
  toast(err && err.message ? err.message : "Something went wrong. Please try again.", { type: "error" });
}

function showLoadError(container, title, err) {
  console.error(`[grading] ${title}:`, err);
  setHtml(container, html`
    <div class="page-head"><h1 class="page-title">${title}</h1></div>
    ${emptyState({
      title: "We couldn't load this",
      message: err && err.message ? err.message : "Please check your connection and try again.",
      action: html`<button type="button" class="btn btn-secondary" data-retry>Try again</button>`
    })}`);
}

/* ============================================================================
   2. THE LIST
   ============================================================================ */

export async function renderGrading(container, ctx) {
  const me = ctx.profile;
  const examId = ctx.params.examId;
  return examId ? renderExamList(container, ctx, examId, me) : renderWaiting(container, ctx);
}

/* ---- all exams that have someone waiting ---- */
async function renderWaiting(container, ctx) {
  setHtml(container, loadingRows(3));

  let waiting;
  try {
    waiting = await attemptService.listPendingGrading();
  } catch (err) {
    showLoadError(container, "Grading", err);
    return undefined;
  }

  const groups = new Map();
  waiting.forEach((a) => {
    const group = groups.get(a.examId) || { examId: a.examId, title: a.examTitle, count: 0 };
    group.count += 1;
    groups.set(a.examId, group);
  });

  setHtml(container, html`
    <header class="page-head">
      <div>
        <h1 class="page-title">Grading</h1>
        <p class="page-sub">Essay answers that are waiting for a grade.</p>
      </div>
    </header>

    ${groups.size
      ? html`<div class="list">${[...groups.values()].map((g) => html`
          <button type="button" class="list-item" data-nav="staff-grading" data-nav-params="${paramsOf({ examId: g.examId })}">
            <div class="list-item-main">
              <p class="list-item-title" dir="auto">${g.title || "Exam"}</p>
              <p class="list-item-sub">${g.count} ${g.count === 1 ? "student" : "students"} waiting</p>
            </div>
            ${icon("chevron-right", { size: 18 })}
          </button>`)}</div>`
      : emptyState({
          title: "Nothing to grade right now",
          message: "When students hand in exams with essay questions, they will appear here.",
          image: ASSETS.beshoyRobot,
          action: html`<button type="button" class="btn btn-secondary" data-nav="staff-exams">Open exams</button>`
        })}`);
  return undefined;
}

/* ---- the students of one exam ---- */
async function renderExamList(container, ctx, examId, me) {
  setHtml(container, loadingRows(4));

  let exam;
  let attempts;
  try {
    exam = await examService.get(examId);
    if (!exam) throw new DataError("not-found");
    attempts = await attemptService.listForExam(examId);
  } catch (err) {
    showLoadError(container, "Grading", err);
    return undefined;
  }

  const filters = { kind: "all" };

  setHtml(container, html`
    <header class="page-head">
      <div>
        <button type="button" class="btn btn-ghost" data-nav="staff-grading">${icon("chevron-left", { size: 18 })} Grading</button>
        <h1 class="page-title" dir="auto" style="margin-top:8px">${exam.title}</h1>
        <p class="page-sub">${exam.subject} · ${exam.assignedGrade}</p>
      </div>
      <button type="button" class="btn btn-secondary btn-sm" data-action="refresh">Refresh</button>
    </header>
    <div class="stack-lg">
      <section class="card stack" id="grading-summary"></section>
      <section>
        <div class="row" id="grading-chips" style="margin-bottom:16px"></div>
        <div id="grading-list"></div>
      </section>
    </div>`);

  const summaryBox = container.querySelector("#grading-summary");
  const chipsBox = container.querySelector("#grading-chips");
  const listBox = container.querySelector("#grading-list");

  function paint() {
    const submitted = attempts.filter((a) => a.status !== "IN_PROGRESS");
    const progress = resultService.examGradingProgress(attempts);
    const kinds = submitted.map((a) => gradingState(a, me.uid).kind);
    const countKind = (list) => kinds.filter((k) => list.includes(k)).length;

    setHtml(summaryBox, html`
      <div class="meter" aria-hidden="true"><span style="width:${submitted.length ? (progress.graded / submitted.length) * 100 : 0}%"></span></div>
      <p>${progress.graded} of ${submitted.length} students graded</p>
      ${progress.inProgress ? html`<p class="page-sub">${progress.inProgress} ${progress.inProgress === 1 ? "student is" : "students are"} still taking the exam.</p>` : ""}
      ${submitted.length && progress.graded === submitted.length && !progress.inProgress ? html`
        <div class="banner banner-info">
          ${icon("check-circle", { size: 20 })}
          <span style="flex:1">Everyone is graded. You can publish the ranking now.</span>
          <button type="button" class="btn btn-secondary btn-sm" data-nav="staff-exam-detail" data-nav-params="${paramsOf({ examId })}">Open exam</button>
        </div>` : ""}`);

    const chips = [
      ["all", `All (${submitted.length})`],
      ["todo", `To grade (${countKind(["todo", "mine", "busy"])})`],
      ["done", `Graded (${countKind(["done"])})`]
    ];
    setHtml(chipsBox, chips.map(([value, label]) => html`
      <button type="button" class="chip ${filters.kind === value ? "is-active" : ""}" data-action="filter" data-kind="${value}">${label}</button>`));

    const shown = sortForGrading(submitted, me.uid).filter((a) => {
      const kind = gradingState(a, me.uid).kind;
      if (filters.kind === "todo") return kind !== "done";
      if (filters.kind === "done") return kind === "done";
      return true;
    });

    if (!shown.length) {
      setHtml(listBox, emptyState({
        title: submitted.length ? "Nothing here" : "No one has handed in yet",
        message: submitted.length ? "Try a different filter." : "Students appear here as soon as they submit."
      }));
      return;
    }

    setHtml(listBox, html`<div class="list">${shown.map((a) => html`
      <button type="button" class="list-item" data-nav="staff-grade" data-nav-params="${paramsOf({ attemptId: a.id })}">
        <div class="list-item-main">
          <p class="list-item-title" dir="auto">${a.studentName || a.studentLoginId}</p>
          <p class="list-item-sub">Handed in ${formatDateTime(a.submittedAt)}${a.tabSwitchCount ? ` · left the tab ${a.tabSwitchCount}×` : ""}</p>
        </div>
        <div class="list-item-end">
          ${a.status === "COMPLETED" ? html`<span class="list-item-value">${formatPercent(a.percentage)}</span>` : ""}
          ${stateBadge(a, me.uid)}
        </div>
      </button>`)}</div>`);
  }

  async function refresh(quiet = true) {
    try {
      attempts = await attemptService.listForExam(examId);
      paint();
      if (!quiet) toast("Updated.");
    } catch (err) { if (!quiet) fail(err); }
  }

  paint();

  // Other staff are grading at the same time: keep the ✔ marks fresh.
  const timer = setInterval(refresh, 30000);
  const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
  document.addEventListener("visibilitychange", onVisible);

  const stop = delegate(container, "click", "[data-action]", (event, el) => {
    if (el.dataset.action === "filter") { filters.kind = el.dataset.kind; paint(); }
    if (el.dataset.action === "refresh") refresh(false);
  });

  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
    stop();
  };
}

/* ============================================================================
   3. GRADING ONE STUDENT
   ============================================================================ */

export async function renderGrade(container, ctx) {
  const me = ctx.profile;
  const attemptId = ctx.params.attemptId;
  if (!attemptId) { ctx.navigate("staff-grading", {}, { replace: true }); return undefined; }

  setHtml(container, loadingRows(4));

  let attempt;
  let exam;
  try {
    attempt = await attemptService.get(attemptId);
    if (!attempt) throw new DataError("not-found");
    exam = await examService.get(attempt.examId);
    if (!exam) throw new DataError("not-found");
    // Closed the app right after handing in? Finish adding up the multiple-choice part first.
    if (attempt.status === "SUBMITTED") attempt = await attemptService.finishScoring(exam, attempt);
  } catch (err) {
    showLoadError(container, "Grade answers", err);
    return undefined;
  }

  const backParams = paramsOf({ examId: exam.id });
  const backButton = html`<button type="button" class="btn btn-ghost" data-nav="staff-grading" data-nav-params="${backParams}">${icon("chevron-left", { size: 18 })} ${exam.title}</button>`;

  /* ---- nothing to grade ---- */
  if (attempt.status === "IN_PROGRESS") {
    setHtml(container, html`
      <header class="page-head">${backButton}</header>
      ${emptyState({ title: "Not handed in yet", message: `${attempt.studentName || "This student"} is still taking the exam.` })}`);
    return undefined;
  }

  const essayQuestions = (exam.questions || []).filter((q) => q.type === "essay");
  if (!essayQuestions.length) {
    setHtml(container, html`
      <header class="page-head">${backButton}</header>
      ${emptyState({ title: "No essay questions", message: "This exam is graded automatically." })}`);
    return undefined;
  }

  attempt.essayAnswers = attempt.essayAnswers || {};
  let claimed = false;
  let finished = false;
  const noteSavers = new Map();

  const answerOf = (q) => attempt.essayAnswers[q.id] || {};
  const isGraded = (q) => typeof answerOf(q).pointsAwarded === "number";
  const gradedCount = () => essayQuestions.filter(isGraded).length;

  /* ---------- drawing ---------- */

  function statusFor(q) {
    const points = answerOf(q).pointsAwarded;
    return isGraded(q)
      ? badge(`${formatPoints(points)} / ${formatPoints(q.points)} points`, pointsTone(points, q.points))
      : badge("Not graded", "gray");
  }

  function questionCard(q, index) {
    const answer = answerOf(q);
    const text = String(answer.text || "").trim();
    const quick = quickPoints(q.points);

    return html`
      <article class="review-q stack" data-qid="${q.id}">
        <div class="row row-between">
          <p class="page-sub">Question ${index + 1} · up to ${formatPoints(q.points)} ${q.points === 1 ? "point" : "points"}</p>
          <span data-status>${statusFor(q)}</span>
        </div>
        <h2 class="card-title" dir="auto" style="white-space:pre-wrap">${q.text}</h2>

        <div>
          <p class="note-entry-label">Student's answer</p>
          <div class="answer-box" dir="auto">${text ? answer.text : html`<span class="page-sub">No answer was written.</span>`}</div>
        </div>

        <div>
          <p class="note-entry-label">Quick grade</p>
          <div class="quick-grade">
            <button type="button" class="btn btn-secondary btn-sm" data-action="points" data-points="${quick.correct}">Correct</button>
            <button type="button" class="btn btn-secondary btn-sm" data-action="points" data-points="${quick.half}">Half</button>
            <button type="button" class="btn btn-secondary btn-sm" data-action="points" data-points="${quick.incorrect}">Incorrect</button>
          </div>
        </div>

        <div>
          <p class="note-entry-label">Or choose the points</p>
          <div class="points-buttons" role="group" aria-label="Points for question ${index + 1}">
            ${pointSteps(q.points).map((p) => html`
              <button type="button" class="points-btn ${answer.pointsAwarded === p ? "is-selected" : ""}"
                      data-action="points" data-points="${p}" aria-pressed="${answer.pointsAwarded === p}">${formatPoints(p)}</button>`)}
          </div>
        </div>

        <div class="field">
          <label for="note-${q.id}">Note for the student <span class="label-note">(optional — saved together with the points)</span></label>
          <textarea id="note-${q.id}" rows="2" dir="auto" data-note="${q.id}">${answer.graderNote || ""}</textarea>
        </div>
      </article>`;
  }

  function refreshCard(q) {
    const card = container.querySelector(`[data-qid="${q.id}"]`);
    if (!card) return;
    const points = answerOf(q).pointsAwarded;
    card.querySelectorAll(".points-btn").forEach((button) => {
      const selected = Number(button.dataset.points) === points;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    setHtml(card.querySelector("[data-status]"), statusFor(q));
  }

  function refreshFooter() {
    const graded = gradedCount();
    const all = graded === essayQuestions.length;
    container.querySelector("#grade-progress").textContent = `${graded} of ${essayQuestions.length} essay answers graded`;
    container.querySelector("#grade-meter").style.width = `${(graded / essayQuestions.length) * 100}%`;
    container.querySelector("#grade-finish").disabled = !all;
    container.querySelector("#grade-hint").hidden = all;
  }

  function paintGrade() {
    const wasDone = attempt.status === "COMPLETED";
    const tabs = attempt.tabSwitchCount || 0;

    setHtml(container, html`
      <header class="page-head">
        <div>
          ${backButton}
          <h1 class="page-title" dir="auto" style="margin-top:8px">${attempt.studentName || attempt.studentLoginId}</h1>
          <p class="page-sub">${exam.title} · handed in ${formatDateTime(attempt.submittedAt)}</p>
        </div>
        <button type="button" class="btn btn-secondary btn-sm" data-nav="staff-student" data-nav-params="${paramsOf({ uid: attempt.studentUid })}">Student page</button>
      </header>

      <div class="stack-lg">
        <section class="card">
          <div class="info-list">
            <div class="info-row"><span class="info-label">Multiple-choice part</span><span class="info-value num">${formatPoints(attempt.mcqScore ?? 0)} / ${formatPoints(attempt.mcqTotal ?? 0)}</span></div>
            <div class="info-row"><span class="info-label">Total points of the exam</span><span class="info-value num">${formatPoints(attempt.finalTotal ?? exam.totalPoints ?? 0)}</span></div>
            ${wasDone ? html`<div class="info-row"><span class="info-label">Current final score</span><span class="info-value num">${formatPercent(attempt.percentage)}</span></div>` : ""}
            ${tabs ? html`<div class="info-row"><span class="info-label">Left the exam tab</span><span class="info-value">${badge(`${tabs} ${tabs === 1 ? "time" : "times"}`, "orange")}</span></div>` : ""}
            ${attempt.submitReason && attempt.submitReason !== "manual" ? html`<div class="info-row"><span class="info-label">Handed in</span><span class="info-value">${attempt.submitReason === "timeout" ? "Automatically, time ran out" : attempt.submitReason === "left-page" ? "Automatically, the page was closed" : "By the academy"}</span></div>` : ""}
          </div>
        </section>

        ${wasDone ? html`
          <div class="banner banner-info" role="status">
            ${icon("check-circle", { size: 20 })}
            <span>This student is already graded. If you change any points, press "Update final score" at the end.</span>
          </div>` : ""}

        <div class="stack-lg">${essayQuestions.map(questionCard)}</div>

        <section class="card stack">
          <div class="meter" aria-hidden="true"><span id="grade-meter" style="width:0%"></span></div>
          <p id="grade-progress"></p>
          <p class="page-sub" id="grade-hint">Choose points for every essay answer to finish.</p>
          <div class="row">
            <button type="button" class="btn btn-primary" id="grade-finish" data-action="finish">${wasDone ? "Update final score" : "Finish grading"}</button>
            <button type="button" class="btn btn-ghost" data-nav="staff-grading" data-nav-params="${backParams}">Back to the list</button>
          </div>
        </section>
      </div>`);
    refreshFooter();
  }

  /* ---------- claiming ---------- */

  function paintTakeover(message) {
    setHtml(container, html`
      <header class="page-head">${backButton}</header>
      ${emptyState({
        title: "Someone is already grading this student",
        message,
        action: html`
          <div class="row" style="justify-content:center">
            <button type="button" class="btn btn-secondary" data-nav="staff-grading" data-nav-params="${backParams}">Back to the list</button>
            <button type="button" class="btn btn-primary" data-action="takeover">Grade anyway</button>
          </div>`
      })}`);
  }

  async function enter() {
    if (attempt.status === "PENDING_GRADING") {
      try {
        await attemptService.claimGrading(attemptId);
        claimed = true;
      } catch (err) {
        if (err instanceof DataError && err.code === "grading-claimed") { paintTakeover(err.message); return; }
        throw err;
      }
    }
    paintGrade();
  }

  /* ---------- saving ---------- */

  function noteOf(q) {
    const field = container.querySelector(`[data-note="${q.id}"]`);
    return field ? field.value.trim() : "";
  }

  async function savePoints(q, points) {
    try {
      const graderNote = noteOf(q);
      await attemptService.gradeEssay(attemptId, q.id, { pointsAwarded: points, graderNote }, q.points);
      attempt.essayAnswers[q.id] = { ...answerOf(q), pointsAwarded: points, graderNote };
      refreshCard(q);
      refreshFooter();
    } catch (err) { fail(err); }
  }

  function saverFor(q) {
    if (!noteSavers.has(q.id)) {
      noteSavers.set(q.id, debounce(async () => {
        if (!isGraded(q)) return;                 // saved together with the points later
        try {
          const graderNote = noteOf(q);
          await attemptService.gradeEssay(attemptId, q.id, { pointsAwarded: answerOf(q).pointsAwarded, graderNote }, q.points);
          attempt.essayAnswers[q.id] = { ...answerOf(q), graderNote };
        } catch (err) { fail(err); }
      }, 800));
    }
    return noteSavers.get(q.id);
  }

  const onNoteInput = (event) => {
    const field = event.target;
    if (!field.matches || !field.matches("[data-note]")) return;
    const q = essayQuestions.find((item) => item.id === field.dataset.note);
    if (q) saverFor(q)();
  };
  container.addEventListener("input", onNoteInput);

  async function finishGrading(button) {
    await withBusy(button, async () => {
      try {
        noteSavers.forEach((saver) => saver.flush());
        const result = await attemptService.finalizeGrading(attemptId, exam);
        finished = true;
        toast(`Graded: ${formatPercent(result.percentage)}`, { type: "success" });

        const ranking = await rankingService.getExam(exam.id).catch(() => null);
        if (ranking) {
          toast("This exam's ranking was already published. Update it from the exam page.", { duration: 7000 });
        }

        const list = await attemptService.listForExam(exam.id).catch(() => []);
        const next = nextToGrade(list, attemptId, me.uid);
        if (next) ctx.navigate("staff-grade", { attemptId: next.id }, { replace: true });
        else ctx.navigate("staff-grading", { examId: exam.id }, { replace: true });
      } catch (err) { fail(err); }
    });
  }

  const stop = delegate(container, "click", "[data-action]", async (event, el) => {
    const action = el.dataset.action;

    if (action === "points") {
      const card = el.closest("[data-qid]");
      const q = card && essayQuestions.find((item) => item.id === card.dataset.qid);
      if (q) await savePoints(q, Number(el.dataset.points));
    }
    if (action === "finish") await finishGrading(el);
    if (action === "takeover") {
      try {
        await attemptService.releaseGrading(attemptId);
        await enter();
      } catch (err) { fail(err); }
    }
  });

  try {
    await enter();
  } catch (err) {
    showLoadError(container, "Grade answers", err);
  }

  return function cleanup() {
    container.removeEventListener("input", onNoteInput);
    stop();
    noteSavers.forEach((saver) => saver.flush());
    // Leaving without finishing: let the next person take this student.
    if (claimed && !finished) attemptService.releaseGrading(attemptId).catch(() => {});
  };
}