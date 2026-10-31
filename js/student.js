/* ============================================================================
   CODE CRAFT — QUIZ PLATFORM
   js/student.js

   The student's everyday screens (main.js loads this file on demand):

     renderHome      greeting, the exam waiting for the student, recent exams
     renderResult    what the student sees right after submitting (and any time later)
     renderResults   overall performance: average, attendance, rank, history
     renderReview    answers, correct answers and explanations of a finished exam
     renderReport    a clean summary page (also reused by staff, with WhatsApp)
     renderProfile   registration details (read-only) and log out

   Also exported for admin.js:  loadReportData, reportCardHtml, buildReportMessage

   Every render function follows the contract described at the top of main.js:
       export async function renderX(container, ctx) { ...; return cleanup }
   ============================================================================ */

import {
  examService,
  attemptService,
  resultService,
  rankingService,
  examPhase,
  attemptRemainingSeconds,
  toMillis,
  DataError
} from "./data-services.js";

import {
  html, setHtml, icon, avatar, badge, statusBadge, donutRow, emptyState, loadingRows,
  confirmDialog, toast, delegate, copyText, whatsappUrl,
  formatDate, formatDateTime, formatDuration, formatClock, formatCountdown, formatPercent, formatPoints,
  ASSETS
} from "./ui-helpers.js";

/* ============================================================================
   1. SHARED HELPERS
   ============================================================================ */

const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "there";

const newestFirst = (a, b) => (toMillis(b.submittedAt) || 0) - (toMillis(a.submittedAt) || 0);

/** Attempts that were handed in (any grading state), newest first. */
const submittedAttempts = (attempts) => attempts.filter((a) => a.status !== "IN_PROGRESS").sort(newestFirst);

function errorMessage(err) {
  return err instanceof DataError ? err.message : "Something went wrong. Please try again.";
}

function showLoadError(container, title, err) {
  console.error(`[student] ${title}:`, err);
  setHtml(container, html`
    <div class="page-head"><h1 class="page-title">${title}</h1></div>
    ${emptyState({
      title: "We couldn't load this",
      message: errorMessage(err),
      action: html`<button type="button" class="btn btn-secondary" data-retry>Try again</button>`
    })}`);
}

/** Loads ranking snapshots (one document per exam) into a cache.  null = not published yet. */
async function loadRankSnapshots(examIds, cache = new Map()) {
  await Promise.all(
    examIds
      .filter((id) => !cache.has(id))
      .map(async (id) => {
        try { cache.set(id, await rankingService.getExam(id)); }
        catch (_) { cache.set(id, null); }
      })
  );
  return cache;
}

/**
 * What to show for the student's rank in one exam.
 * snapshot: undefined = still loading, null = not published yet, object = published
 */
function rankInfo(snapshot, uid) {
  if (snapshot === undefined) return { text: "", state: "loading" };
  if (snapshot === null) return { text: "Ranking pending", state: "pending" };
  const entry = (snapshot.entries || []).find((e) => e.uid === uid);
  return entry
    ? { text: `#${entry.rank}`, state: "ranked", entry }
    : { text: "Not ranked", state: "none" };
}

const overallEntryFor = (overall, uid) => (overall && (overall.entries || []).find((e) => e.uid === uid)) || null;

/** One row in an "exams" list. Opens the result screen. */
function attemptRow(attempt, snapshot, uid) {
  const done = attempt.status === "COMPLETED";
  const rank = done ? rankInfo(snapshot, uid) : null;
  return html`
    <button type="button" class="list-item" data-nav="result"
            data-nav-params="${JSON.stringify({ attemptId: attempt.id })}">
      <div class="list-item-main">
        <p class="list-item-title" dir="auto">${attempt.examTitle || "Exam"}</p>
        <p class="list-item-sub">${formatDate(attempt.submittedAt)}</p>
      </div>
      <div class="list-item-end">
        ${done ? html`<span class="list-item-value">${formatPercent(attempt.percentage)}</span>` : statusBadge("attempt", "PENDING_GRADING")}
        ${rank && rank.text ? html`<span class="badge badge-gray">${rank.text}</span>` : ""}
      </div>
    </button>`;
}

/** Same row, but not clickable (used inside the report). */
function plainAttemptRow(attempt, snapshot, uid) {
  const done = attempt.status === "COMPLETED";
  const rank = done ? rankInfo(snapshot, uid) : null;
  return html`
    <div class="list-item">
      <div class="list-item-main">
        <p class="list-item-title" dir="auto">${attempt.examTitle || "Exam"}</p>
        <p class="list-item-sub">${formatDate(attempt.submittedAt)}</p>
      </div>
      <div class="list-item-end">
        ${done ? html`<span class="list-item-value">${formatPercent(attempt.percentage)}</span>` : statusBadge("attempt", "PENDING_GRADING")}
        ${rank && rank.text ? html`<span class="badge badge-gray">${rank.text}</span>` : ""}
      </div>
    </div>`;
}

/** Average score, attendance and overall rank as three rings. */
function performanceDonuts(student, data) {
  const { summary, attendance, overall } = data;
  const entry = overallEntryFor(overall, student.uid);
  const total = overall ? overall.totalRanked || (overall.entries || []).length : 0;

  const rankFill = entry && total > 1 ? ((total - entry.rank) / (total - 1)) * 100 : entry ? 100 : 0;

  return donutRow([
    {
      percent: summary.average ?? 0,
      centerText: summary.average === null ? "—" : formatPercent(summary.average),
      label: "Average score",
      tone: "accent"
    },
    {
      percent: attendance.percentage,
      centerText: `${attendance.percentage}%`,
      subText: attendance.total ? `${attendance.attended}/${attendance.total}` : "no exams yet",
      label: "Attendance",
      tone: "green"
    },
    {
      percent: rankFill,
      centerText: entry ? `#${entry.rank}` : "—",
      subText: entry ? `of ${total}` : "",
      label: "Overall rank",
      tone: "blue"
    }
  ]);
}

/* ============================================================================
   2. HOME
   ============================================================================ */

export async function renderHome(container, ctx) {
  const profile = ctx.profile;
  setHtml(container, loadingRows(3));

  let exams = [];
  try {
    exams = await examService.listForStudent(profile);
  } catch (err) {
    showLoadError(container, "Home", err);
    return undefined;
  }

  let attempts = null;           // null until the first snapshot arrives
  const ranks = new Map();       // examId → ranking snapshot
  const syncedIds = new Set();   // attempts whose clock we already synced (avoids a write loop)
  let settling = false;

  /* An attempt can be left half-finished (closed app, flat battery): finish it quietly. */
  async function settle(list) {
    if (settling) return;
    settling = true;
    try {
      for (const attempt of list) {
        const exam = exams.find((e) => e.id === attempt.examId);
        if (!exam) continue;

        if (attempt.status === "SUBMITTED") {
          await attemptService.finishScoring(exam, attempt);
        } else if (attempt.status === "IN_PROGRESS" && !syncedIds.has(attempt.id)) {
          syncedIds.add(attempt.id);
          await attemptService.syncClock(attempt.id);
          if (attemptRemainingSeconds(attempt, exam) <= 0) {
            await attemptService.submit(exam, attempt, { reason: "timeout" });
          }
        }
      }
    } catch (err) {
      console.warn("[student] could not settle attempts:", err);
    } finally {
      settling = false;
    }
  }

  async function loadRecentRanks(list) {
    const ids = submittedAttempts(list).slice(0, 3).filter((a) => a.status === "COMPLETED").map((a) => a.examId);
    if (ids.some((id) => !ranks.has(id))) {
      await loadRankSnapshots(ids, ranks);
      paint();
    }
  }

  function examCards() {
    const takenIds = new Set(attempts.map((a) => a.examId));
    const cards = [];

    const inProgress = attempts.find(
      (a) => a.status === "IN_PROGRESS" && exams.some((e) => e.id === a.examId)
    );
    if (inProgress) {
      const exam = exams.find((e) => e.id === inProgress.examId);
      const left = attemptRemainingSeconds(inProgress, exam);
      if (left > 0) {
        cards.push(html`
          <section class="exam-cta">
            <div class="exam-cta-body">
              <span class="exam-cta-tag">Exam in progress</span>
              <h2 class="exam-cta-title" dir="auto">${exam.subject} — ${exam.title}</h2>
              <p class="exam-cta-meta">Time left: <span class="num">${formatClock(left)}</span></p>
              <button type="button" class="btn btn-primary" data-action="resume-exam" data-exam-id="${exam.id}">Resume exam</button>
            </div>
            <img class="exam-cta-art" src="${ASSETS.beshoyRobot}" alt="" width="68" height="68">
          </section>`);
      }
    }

    exams
      .filter((e) => examPhase(e) === "open" && !takenIds.has(e.id))
      .forEach((exam) => {
        const msLeft = (toMillis(exam.endAt) || 0) - Date.now();
        const closingSoon = msLeft > 0 && msLeft <= 2 * 60 * 60 * 1000;
        cards.push(html`
          <section class="stack">
            ${closingSoon ? html`
              <div class="banner banner-warn" role="status">
                ${icon("clock", { size: 20 })}
                <span>This exam closes in ${formatCountdown(msLeft)}. Start it before it closes.</span>
              </div>` : ""}
            <div class="exam-cta">
              <div class="exam-cta-body">
                <span class="exam-cta-tag">New exam available</span>
                <h2 class="exam-cta-title" dir="auto">${exam.subject} — ${exam.title}</h2>
                <p class="exam-cta-meta">${exam.questionCount} questions · ${formatDuration(exam.duration)}</p>
                <button type="button" class="btn btn-primary" data-action="start-exam" data-exam-id="${exam.id}">Start exam</button>
              </div>
              <img class="exam-cta-art" src="${ASSETS.beshoyRobot}" alt="" width="68" height="68">
            </div>
          </section>`);
      });

    if (cards.length) return cards;

    const next = exams
      .filter((e) => examPhase(e) === "upcoming")
      .sort((a, b) => (toMillis(a.startAt) || 0) - (toMillis(b.startAt) || 0))[0];

    return [
      emptyState({
        title: "No active exam right now.",
        message: "Take a break, keep learning, and stay ready for the next challenge.",
        image: ASSETS.beshoyRobot
      }),
      next ? html`
        <div class="card">
          <p class="card-title">Next exam</p>
          <p class="list-item-title" dir="auto">${next.subject} — ${next.title}</p>
          <p class="list-item-sub">Opens ${formatDateTime(next.startAt)}</p>
        </div>` : ""
    ];
  }

  function paint() {
    if (attempts === null) return;
    const submitted = submittedAttempts(attempts);
    const recent = submitted.slice(0, 3);
    const waiting = submitted.filter((a) => a.status !== "COMPLETED").length;
    const hasExam = exams.some((e) => examPhase(e) === "open" && !attempts.some((a) => a.examId === e.id));

    let sub = "Here is what's new for you.";
    if (hasExam) sub = "You have an exam waiting for you.";
    else if (waiting) sub = "Your essay answers are being graded.";

    setHtml(container, html`
      <header>
        <h1 class="greeting-title" dir="auto">Hi, ${firstName(profile.name)} 👋</h1>
        <p class="greeting-sub">${sub}</p>
      </header>

      <div class="stack-lg">${examCards()}</div>

      <section class="section">
        <div class="section-head">
          <h2 class="section-title">Recent exams</h2>
          ${submitted.length ? html`<button type="button" class="link-btn" data-nav="results">View all</button>` : ""}
        </div>
        ${recent.length
          ? html`<div class="list">${recent.map((a) => attemptRow(a, ranks.get(a.examId), profile.uid))}</div>`
          : html`<p class="page-sub">Your finished exams will show up here.</p>`}
      </section>`);
  }

  const stopWatching = attemptService.watchMine(
    profile.uid,
    (list) => {
      attempts = list;
      paint();
      settle(list);
      loadRecentRanks(list);
    },
    (err) => showLoadError(container, "Home", err)
  );

  const stopClicks = delegate(container, "click", "[data-action]", async (event, el) => {
    const exam = exams.find((e) => e.id === el.dataset.examId);
    if (!exam) return;

    if (el.dataset.action === "resume-exam") {
      ctx.navigate("exam", { examId: exam.id, resume: true });
      return;
    }

    if (el.dataset.action === "start-exam") {
      const ok = await confirmDialog({
        title: `Start ${exam.title}?`,
        message: `You will have ${formatDuration(exam.duration)} once you start. You can take this exam only once, the timer can't be paused, and leaving the page submits your exam.`,
        confirmLabel: "Start exam"
      });
      if (ok) ctx.navigate("exam", { examId: exam.id });
    }
  });

  return () => { stopWatching(); stopClicks(); };
}

/* ============================================================================
   3. RESULT — right after submitting, and any time later from the lists
   ============================================================================ */

const SUBMIT_NOTES = {
  timeout: "Time ran out, so your exam was submitted automatically.",
  "left-page": "Your exam was submitted because the page was closed or left.",
  "staff-forced": "Your exam was submitted by the academy."
};

export async function renderResult(container, ctx) {
  const profile = ctx.profile;
  const attemptId = ctx.params.attemptId || (ctx.params.examId ? `${profile.uid}_${ctx.params.examId}` : null);
  if (!attemptId) { ctx.navigate("home", {}, { replace: true }); return undefined; }

  setHtml(container, loadingRows(3));

  try {
    let attempt = await attemptService.get(attemptId);
    if (!attempt || attempt.status === "IN_PROGRESS") { ctx.navigate("home", {}, { replace: true }); return undefined; }

    const exam = await examService.get(attempt.examId);
    if (!exam) throw new DataError("not-found");

    // The app closed right after handing in: finish scoring now.
    if (attempt.status === "SUBMITTED") attempt = await attemptService.finishScoring(exam, attempt);

    const [key, examRank, overall] = await Promise.all([
      examService.getKey(exam.id),
      rankingService.getExam(exam.id).catch(() => null),
      rankingService.getOverall(profile.grade, profile.subject).catch(() => null)
    ]);

    const mcq = resultService.scoreMcq(exam, key, attempt.mcqAnswers || {});
    const mcqCount = mcq.correct + mcq.wrong + mcq.unanswered;
    const completed = attempt.status === "COMPLETED";
    const canReview = examPhase(exam) === "closed";

    const pct = (n) => (mcqCount ? (n / mcqCount) * 100 : 0);
    const examEntry = rankInfo(examRank, profile.uid);
    const overallEntry = overallEntryFor(overall, profile.uid);
    const rankNote = examRank === null ? "Ranking will appear once all classmates' exams are graded." : "";

    const title = attempt.submitReason === "timeout" ? `${exam.title} — time's up` : `${exam.title} completed`;

    setHtml(container, html`
      <header class="page-head">
        <div>
          <h1 class="page-title" dir="auto">${title}</h1>
          <p class="page-sub">${formatDateTime(attempt.submittedAt)}</p>
        </div>
      </header>

      <div class="stack-lg">
        ${SUBMIT_NOTES[attempt.submitReason]
          ? html`<div class="banner banner-info" role="status">${icon("alert", { size: 20 })}<span>${SUBMIT_NOTES[attempt.submitReason]}</span></div>`
          : ""}

        <section class="result-hero">
          ${completed ? html`
            <p class="result-title">Your score</p>
            <p class="result-score num">${formatPercent(attempt.percentage)}</p>
            <p class="page-sub num">${formatPoints(attempt.finalScore)} / ${formatPoints(attempt.finalTotal)} points</p>
            <p class="result-message">${resultService.messageForPercentage(attempt.percentage)}</p>
          ` : html`
            <p class="result-title">Multiple-choice score</p>
            <p class="result-score num">${formatPoints(attempt.mcqScore ?? mcq.score)} <small>/ ${formatPoints(attempt.mcqTotal ?? mcq.total)}</small></p>
            <p class="result-message">Your essay answers are being reviewed. Your final score will appear here once they are graded.</p>
          `}
        </section>

        ${mcqCount ? html`
          <section class="card">
            <h2 class="card-title">Multiple-choice answers</h2>
            ${donutRow([
              { percent: pct(mcq.correct), centerText: String(mcq.correct), subText: `of ${mcqCount}`, label: "Correct", tone: "green" },
              { percent: pct(mcq.wrong), centerText: String(mcq.wrong), subText: `of ${mcqCount}`, label: "Wrong", tone: "red" },
              { percent: pct(mcq.unanswered), centerText: String(mcq.unanswered), subText: `of ${mcqCount}`, label: "Unanswered", tone: "amber" }
            ])}
          </section>` : ""}

        <section class="stat-grid">
          <div class="stat">
            <p class="stat-value">${examEntry.state === "ranked" ? examEntry.text : "—"}</p>
            <p class="stat-label">Rank in this exam</p>
          </div>
          <div class="stat">
            <p class="stat-value">${overallEntry ? `#${overallEntry.rank}` : "—"}</p>
            <p class="stat-label">Overall rank</p>
          </div>
        </section>
        ${rankNote ? html`<p class="page-sub">${rankNote}</p>` : ""}

        <div class="stack">
          <button type="button" class="btn btn-primary btn-block" data-nav="home">Back to home</button>
          ${canReview
            ? html`<button type="button" class="btn btn-secondary btn-block" data-nav="review"
                           data-nav-params="${JSON.stringify({ attemptId: attempt.id })}">Review answers</button>`
            : html`<p class="page-sub">Your answers and explanations unlock after the exam closes on ${formatDateTime(exam.endAt)}.</p>`}
        </div>
      </div>`);
  } catch (err) {
    showLoadError(container, "Result", err);
  }
  return undefined;
}

/* ============================================================================
   4. RESULTS — overall performance
   ============================================================================ */

export async function renderResults(container, ctx) {
  const profile = ctx.profile;
  setHtml(container, loadingRows(4));

  try {
    const [exams, attempts, overall] = await Promise.all([
      examService.listForStudent(profile),
      attemptService.listForStudent(profile.uid),
      rankingService.getOverall(profile.grade, profile.subject).catch(() => null)
    ]);

    const data = {
      summary: resultService.summarizeStudent(attempts),
      attendance: resultService.computeAttendance(profile, exams, attempts),
      overall
    };
    const submitted = submittedAttempts(attempts);
    const ranks = new Map();
    let showAll = false;

    const visible = () => (showAll ? submitted : submitted.slice(0, 6));

    function paint() {
      const last = submitted[0] || null;
      const lastRank = last && last.status === "COMPLETED" ? rankInfo(ranks.get(last.examId), profile.uid) : null;

      setHtml(container, html`
        <header class="page-head">
          <div>
            <h1 class="page-title">Results</h1>
            <p class="page-sub">How you are doing across all your exams.</p>
          </div>
        </header>

        <div class="stack-lg">
          <section class="card">${performanceDonuts(profile, data)}</section>

          ${data.summary.pendingCount ? html`
            <div class="banner banner-info" role="status">
              ${icon("clock", { size: 20 })}
              <span>${data.summary.pendingCount === 1 ? "1 exam is" : `${data.summary.pendingCount} exams are`} waiting for essay grading.</span>
            </div>` : ""}

          ${last ? html`
            <section>
              <h2 class="section-title">Last exam</h2>
              <div class="list" style="margin-top:12px">
                ${attemptRow(last, ranks.get(last.examId), profile.uid)}
              </div>
              ${lastRank && lastRank.state === "pending"
                ? html`<p class="page-sub" style="margin-top:8px">Ranking will appear once all classmates' exams are graded.</p>` : ""}
            </section>` : ""}

          <section>
            <div class="section-head">
              <h2 class="section-title">Your exams</h2>
              ${submitted.length > 6 ? html`<button type="button" class="link-btn" data-action="toggle-all">${showAll ? "Show fewer" : `Show all (${submitted.length})`}</button>` : ""}
            </div>
            ${submitted.length
              ? html`<div class="list">${visible().map((a) => attemptRow(a, ranks.get(a.examId), profile.uid))}</div>`
              : emptyState({
                  title: "No exams yet",
                  message: "Once you finish an exam, your results will show up here.",
                  image: ASSETS.beshoyRobot
                })}
          </section>
        </div>`);
    }

    async function loadRanks() {
      const ids = visible().filter((a) => a.status === "COMPLETED").map((a) => a.examId);
      if (ids.some((id) => !ranks.has(id))) {
        await loadRankSnapshots(ids, ranks);
        paint();
      }
    }

    paint();
    loadRanks();

    return delegate(container, "click", "[data-action='toggle-all']", () => {
      showAll = !showAll;
      paint();
      loadRanks();
    });
  } catch (err) {
    showLoadError(container, "Results", err);
    return undefined;
  }
}

/* ============================================================================
   5. REVIEW — every answer of a finished exam
   Unlocks when the exam has CLOSED, so nobody can pass answers on to classmates
   who are still taking it.
   ============================================================================ */

export async function renderReview(container, ctx) {
  const profile = ctx.profile;
  const attemptId = ctx.params.attemptId;
  if (!attemptId) { ctx.navigate("results", {}, { replace: true }); return undefined; }

  setHtml(container, loadingRows(4));

  try {
    const attempt = await attemptService.get(attemptId);
    if (!attempt || attempt.status === "IN_PROGRESS") { ctx.navigate("results", {}, { replace: true }); return undefined; }

    const exam = await examService.get(attempt.examId);
    if (!exam) throw new DataError("not-found");

    const backButton = html`<button type="button" class="btn btn-ghost" data-nav="result"
        data-nav-params="${JSON.stringify({ attemptId })}">${icon("chevron-left", { size: 18 })} Back to result</button>`;

    if (examPhase(exam) !== "closed") {
      setHtml(container, html`
        <header class="page-head"><h1 class="page-title" dir="auto">${exam.title}</h1>${backButton}</header>
        ${emptyState({
          title: "Answers unlock after the exam closes",
          message: `You can review your answers and the explanations from ${formatDateTime(exam.endAt)}.`,
          image: ASSETS.beshoyRobot
        })}`);
      return undefined;
    }

    const key = await examService.getKey(exam.id);
    const byId = new Map((exam.questions || []).map((q) => [q.id, q]));
    const order = (attempt.questionOrder || []).filter((id) => byId.has(id));
    const ids = order.length ? order : (exam.questions || []).map((q) => q.id);
    const completed = attempt.status === "COMPLETED";

    const questionHtml = (id, index) => {
      const q = byId.get(id);
      return q.type === "mcq" ? mcqReview(q, index) : essayReview(q, index);
    };

    function mcqReview(q, index) {
      const given = (attempt.mcqAnswers || {})[q.id];
      const correct = (key.answers || {})[q.id];
      const explanations = (key.explanations || {})[q.id] || [];
      const answered = given !== undefined && given !== null;
      const right = answered && given === correct;

      return html`
        <article class="review-q stack">
          <div class="row row-between">
            <p class="page-sub">Question ${index + 1} · Multiple choice</p>
            ${!answered ? badge("Not answered", "orange") : right ? badge("Correct", "green") : badge("Wrong", "red")}
          </div>
          <h2 class="card-title" dir="auto" style="white-space:pre-wrap">${q.text}</h2>
          <div class="stack">
            ${q.options.map((option, i) => {
              const classes = ["review-option"];
              if (i === correct) classes.push("is-correct");
              else if (i === given) classes.push("is-wrong");
              if (i === given) classes.push("is-picked");
              return html`
                <div class="${classes.join(" ")}">
                  <span class="option-letter">${String.fromCharCode(65 + i)}</span>
                  <div class="list-item-main">
                    <p dir="auto">${option.text}</p>
                    <p>
                      ${i === correct ? badge("Correct answer", "green") : ""}
                      ${i === given ? badge("Your answer", i === correct ? "green" : "red") : ""}
                    </p>
                    ${explanations[i] ? html`<p class="review-option-note" dir="auto">${explanations[i]}</p>` : ""}
                  </div>
                </div>`;
            })}
          </div>
        </article>`;
    }

    function essayReview(q, index) {
      const answer = (attempt.essayAnswers || {})[q.id] || {};
      const graded = typeof answer.pointsAwarded === "number";
      return html`
        <article class="review-q stack">
          <div class="row row-between">
            <p class="page-sub">Question ${index + 1} · Essay</p>
            ${graded
              ? badge(`${formatPoints(answer.pointsAwarded)} / ${formatPoints(q.points)} points`, answer.pointsAwarded >= q.points ? "green" : answer.pointsAwarded > 0 ? "orange" : "red")
              : badge("Waiting for grading", "orange")}
          </div>
          <h2 class="card-title" dir="auto" style="white-space:pre-wrap">${q.text}</h2>
          <div>
            <p class="note-entry-label">Your answer</p>
            <div class="answer-box" dir="auto">${answer.text || "You didn't write an answer."}</div>
          </div>
          ${answer.graderNote ? html`
            <div>
              <p class="note-entry-label">Note from your teacher</p>
              <div class="grader-note" dir="auto">${answer.graderNote}</div>
            </div>` : ""}
        </article>`;
    }

    setHtml(container, html`
      <header class="page-head">
        <div>
          <h1 class="page-title" dir="auto">${exam.title}</h1>
          <p class="page-sub">
            ${completed
              ? html`Final score: <span class="num">${formatPercent(attempt.percentage)}</span> (${formatPoints(attempt.finalScore)} / ${formatPoints(attempt.finalTotal)})`
              : "Your essay answers are still being graded."}
          </p>
        </div>
        ${backButton}
      </header>
      <div class="stack-lg">${ids.map(questionHtml)}</div>`);
  } catch (err) {
    showLoadError(container, "Exam review", err);
  }
  return undefined;
}

/* ============================================================================
   6. REPORT — also used by staff (admin.js) with the WhatsApp button
   ============================================================================ */

export async function loadReportData(student) {
  const [exams, attempts, overall] = await Promise.all([
    examService.listForStudent(student),
    attemptService.listForStudent(student.uid),
    rankingService.getOverall(student.grade, student.subject).catch(() => null)
  ]);
  const submitted = submittedAttempts(attempts);
  const recent = submitted.slice(0, 5);
  const ranks = await loadRankSnapshots(recent.map((a) => a.examId));

  return {
    summary: resultService.summarizeStudent(attempts),
    attendance: resultService.computeAttendance(student, exams, attempts),
    overall,
    ranks,
    recent,
    last: submitted[0] || null
  };
}

/** The text that WhatsApp opens pre-filled for the parent. */
export function buildReportMessage(student, data) {
  const entry = overallEntryFor(data.overall, student.uid);
  const lines = [
    "Code Craft — Beshoy Ramy Academy",
    `Progress report for ${student.name} (${student.loginId})`,
    `Average score: ${data.summary.average === null ? "—" : formatPercent(data.summary.average)}`,
    `Attendance: ${data.attendance.percentage}% (${data.attendance.attended}/${data.attendance.total} exams)`,
    `Overall rank: ${entry ? `#${entry.rank}` : "—"}`
  ];
  if (data.last) {
    const lastDone = data.last.status === "COMPLETED";
    const lastRank = lastDone ? rankInfo(data.ranks.get(data.last.examId), student.uid) : null;
    lines.push(
      `Last exam: ${data.last.examTitle} — ${lastDone ? formatPercent(data.last.percentage) : "waiting for grading"}` +
      (lastRank && lastRank.state === "ranked" ? ` (rank ${lastRank.text})` : "")
    );
  }
  return lines.join("\n");
}

/**
 * The report card.  options.whatsapp = true adds the WhatsApp button (staff only):
 * it opens a chat with the parent's number saved at registration.
 */
export function reportCardHtml(student, data, { whatsapp = false } = {}) {
  const lastRank = data.last && data.last.status === "COMPLETED"
    ? rankInfo(data.ranks.get(data.last.examId), student.uid)
    : null;
  const overallEntry = overallEntryFor(data.overall, student.uid);

  return html`
    <article class="report-card" id="report-card">
      <header class="report-head">
        <div>
          <h2 class="page-title" dir="auto">${student.name}</h2>
          <p class="page-sub num">${student.loginId}</p>
          <p class="page-sub">${student.grade} · ${student.subject}</p>
        </div>
        ${whatsapp ? html`
          <a class="icon-btn is-green" target="_blank" rel="noopener noreferrer"
             href="${whatsappUrl(student.parentMobile, buildReportMessage(student, data))}"
             aria-label="Send this report to the parent on WhatsApp" title="Send on WhatsApp">
            ${icon("whatsapp", { size: 24 })}
          </a>` : ""}
      </header>

      <div class="info-list">
        <div class="info-row"><span class="info-label">Parent phone</span><span class="info-value num" dir="ltr">${student.parentMobile}</span></div>
      </div>

      <div class="divider"></div>
      <h3 class="card-title">Performance summary</h3>
      ${performanceDonuts(student, data)}

      <div class="divider"></div>
      <div class="info-list">
        <div class="info-row">
          <span class="info-label">Last exam rank</span>
          <span class="info-value">${lastRank ? (lastRank.text || "—") : "—"}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Overall rank</span>
          <span class="info-value">${overallEntry ? `#${overallEntry.rank}` : "—"}</span>
        </div>
      </div>

      <div class="divider"></div>
      <h3 class="card-title">Recent exams</h3>
      ${data.recent.length
        ? html`<div class="list">${data.recent.map((a) => plainAttemptRow(a, data.ranks.get(a.examId), student.uid))}</div>`
        : html`<p class="page-sub">No exams yet.</p>`}

      <p class="page-sub" style="margin-top:16px">Report created on ${formatDate(new Date())}</p>
    </article>`;
}

export async function renderReport(container, ctx) {
  const profile = ctx.profile;
  setHtml(container, loadingRows(4));

  try {
    const data = await loadReportData(profile);
    setHtml(container, html`
      <header class="page-head">
        <div>
          <h1 class="page-title">Report</h1>
          <p class="page-sub">A summary of your progress. You can take a screenshot to share it.</p>
        </div>
      </header>
      ${reportCardHtml(profile, data)}`);
  } catch (err) {
    showLoadError(container, "Report", err);
  }
  return undefined;
}

/* ============================================================================
   7. PROFILE — read-only
   ============================================================================ */

export async function renderProfile(container, ctx) {
  const profile = ctx.profile;

  setHtml(container, html`
    <header class="page-head"><h1 class="page-title">Profile</h1></header>

    <div class="stack-lg">
      <section class="card">
        <div class="profile-head">
          ${avatar(profile.gender, { size: 72 })}
          <div>
            <h2 class="card-title" dir="auto" style="margin-bottom:4px">${profile.name}</h2>
            <p class="row" style="gap:8px">
              <span class="num" dir="ltr">${profile.loginId}</span>
              <button type="button" class="icon-btn" data-action="copy-id" aria-label="Copy my ID" title="Copy my ID">${icon("copy", { size: 18 })}</button>
            </p>
          </div>
        </div>

        <div class="info-list">
          <div class="info-row"><span class="info-label">Mobile</span><span class="info-value num" dir="ltr">${profile.mobile}</span></div>
          <div class="info-row"><span class="info-label">Parent mobile</span><span class="info-value num" dir="ltr">${profile.parentMobile}</span></div>
          <div class="info-row"><span class="info-label">Gender</span><span class="info-value">${profile.gender}</span></div>
          <div class="info-row"><span class="info-label">Grade</span><span class="info-value">${profile.grade}</span></div>
          <div class="info-row"><span class="info-label">Subject</span><span class="info-value">${profile.subject}</span></div>
          ${profile.email ? html`<div class="info-row"><span class="info-label">Email</span><span class="info-value" dir="ltr">${profile.email}</span></div>` : ""}
          <div class="info-row"><span class="info-label">Member since</span><span class="info-value">${formatDate(profile.createdAt)}</span></div>
        </div>

        <p class="page-sub" style="margin-top:14px">To change any of these details, please contact the academy.</p>
      </section>

      <button type="button" class="btn btn-secondary btn-block" data-action="logout">
        ${icon("logout", { size: 18 })} Log out
      </button>
    </div>`);

  return delegate(container, "click", "[data-action]", async (event, el) => {
    if (el.dataset.action === "logout") ctx.logout();
    if (el.dataset.action === "copy-id") {
      const ok = await copyText(profile.loginId);
      toast(ok ? "ID copied." : "Couldn't copy. Please write it down.", { type: ok ? "success" : "error" });
    }
  });
}