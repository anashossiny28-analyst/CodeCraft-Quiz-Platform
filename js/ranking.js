/* ============================================================================
   CODE CRAFT — QUIZ PLATFORM
   js/ranking.js

   Two halves:

   STAFF SIDE (called by exams.js when "Publish ranking" is pressed)
     publishExamRanking(exam)      ranks the students of ONE exam and publishes it,
                                   then refreshes the class's overall ranking
     publishOverallRanking(g, s)   rebuilds the overall ranking of a class
     rankEntries(items)            the ranking rules (pure, easy to test)

   STUDENT SIDE
     renderRanking                 "Last exam" and "Overall" leaderboards

   Why published snapshots? A student is not allowed to read his classmates' results
   (privacy), so a staff member's browser does the maths once everything is graded
   and saves the finished leaderboard where every student can read it.

   The rules
     • only students who are fully graded and NOT removed from the ranking count
     • equal scores share the same number (#27 and #27), and the next number is #28 —
       nobody jumps ahead; no one ranks higher because he finished faster
     • the full leaderboard shows a small tie index (#27 (1), #27 (2))
     • the overall score is the average of a student's exams that have a published ranking
     • names are shown as first name + initial ("Anas H.")
   ============================================================================ */

import {
  examService, attemptService, rankingService, examPhase, toMillis, DataError
} from "./data-services.js";

import {
  html, setHtml, emptyState, loadingRows, delegate, rankLabel,
  formatDate, formatDateTime, formatPercent
} from "./ui-helpers.js";

const round1 = (n) => Math.round(n * 10) / 10;

/* ============================================================================
   1. THE RANKING RULES
   ============================================================================ */

/**
 * @param {{uid: string, name: string, score: number, finalScore?: number, finalTotal?: number, examsCount?: number}[]} items
 * @returns entries ready to publish, best first:
 *   { uid, displayName, percentage, finalScore, finalTotal, examsCount, rank, tieIndex, tieTotal }
 */
export function rankEntries(items) {
  const sorted = [...items].sort(
    (a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name))
  );

  // dense ranking: 1, 2, 2, 3 …
  let rank = 0;
  let previous = null;
  const ranked = sorted.map((item) => {
    if (previous === null || item.score !== previous) {
      rank += 1;
      previous = item.score;
    }
    return { ...item, rank };
  });

  const groupSize = new Map();
  ranked.forEach((r) => groupSize.set(r.rank, (groupSize.get(r.rank) || 0) + 1));
  const seen = new Map();

  return ranked.map((r) => {
    const tieIndex = (seen.get(r.rank) || 0) + 1;
    seen.set(r.rank, tieIndex);
    return {
      uid: r.uid,
      displayName: r.name,
      percentage: r.score,
      finalScore: r.finalScore ?? null,
      finalTotal: r.finalTotal ?? null,
      examsCount: r.examsCount ?? null,
      rank: r.rank,
      tieIndex,
      tieTotal: groupSize.get(r.rank)
    };
  });
}

/* ============================================================================
   2. STAFF: PUBLISHING
   ============================================================================ */

/**
 * Ranks one exam and publishes it. Also refreshes the overall ranking of the class.
 * @returns {Promise<{ranked: number, excluded: number, overallRanked: number}>}
 */
export async function publishExamRanking(exam) {
  if (examPhase(exam) !== "closed") {
    throw new DataError("invalid-data", "The exam must be closed before its ranking can be published.");
  }

  const attempts = await attemptService.listForExam(exam.id);
  if (!attempts.length) throw new DataError("invalid-data", "Nobody took this exam.");

  const notReady = attempts.filter((a) => a.status !== "COMPLETED");
  if (notReady.length) {
    throw new DataError(
      "invalid-data",
      `${notReady.length} ${notReady.length === 1 ? "student is" : "students are"} not fully graded yet.`
    );
  }

  // Re-derive every score from the raw answers and the answer key before ranking.
  const key = await examService.getKey(exam.id);
  const checked = await Promise.all(attempts.map((a) => attemptService.recalculate(exam, key, a)));

  const counted = checked.filter((a) => !a.excludedFromRanking && typeof a.percentage === "number");
  const entries = rankEntries(counted.map((a) => ({
    uid: a.studentUid,
    name: rankingService.displayName(a.studentName),
    score: a.percentage,
    finalScore: a.finalScore,
    finalTotal: a.finalTotal
  })));

  await rankingService.publishExam({
    examId: exam.id,
    examTitle: exam.title,
    grade: exam.assignedGrade,
    subject: exam.subject,
    entries
  });

  const overall = await publishOverallRanking(exam.assignedGrade, exam.subject, { includeExamId: exam.id });

  return { ranked: entries.length, excluded: checked.length - counted.length, overallRanked: overall.ranked };
}

/**
 * Rebuilds the overall ranking of a class (grade + subject): each student's average over
 * the exams of that class that have a published ranking.
 * @param {{includeExamId?: string}} options  an exam being published right now
 */
export async function publishOverallRanking(grade, subject, { includeExamId } = {}) {
  const [exams, attempts] = await Promise.all([
    examService.listAll(),
    attemptService.listCompletedForGroup(grade, subject)
  ]);

  const classExams = exams.filter(
    (e) => e.status === "published" && e.assignedGrade === grade && e.subject === subject
  );

  // Only exams whose ranking is out count, so nobody is judged on half-graded exams.
  const published = await Promise.all(classExams.map(async (e) => {
    if (e.id === includeExamId) return e.id;
    const snapshot = await rankingService.getExam(e.id).catch(() => null);
    return snapshot ? e.id : null;
  }));
  const counted = new Set(published.filter(Boolean));

  const perStudent = new Map();
  attempts.forEach((a) => {
    if (!counted.has(a.examId) || a.excludedFromRanking || typeof a.percentage !== "number") return;
    const entry = perStudent.get(a.studentUid) || { uid: a.studentUid, name: a.studentName, sum: 0, count: 0 };
    entry.sum += a.percentage;
    entry.count += 1;
    perStudent.set(a.studentUid, entry);
  });

  const entries = rankEntries([...perStudent.values()].map((s) => ({
    uid: s.uid,
    name: rankingService.displayName(s.name),
    score: round1(s.sum / s.count),
    examsCount: s.count
  })));

  await rankingService.publishOverall({ grade, subject, entries });
  return { ranked: entries.length };
}

/* ============================================================================
   3. STUDENT: THE RANKING SCREEN
   ============================================================================ */

const TOP = 10;

function leaderboardHtml(entries, meUid, showAll) {
  const mine = entries.find((e) => e.uid === meUid) || null;
  const top = entries.filter((e) => e.rank <= TOP);
  const visible = showAll ? entries : top;
  const mineHidden = !showAll && mine && mine.rank > TOP;

  const row = (e) => html`
    <div class="leaderboard-row ${e.rank <= TOP ? "is-top" : ""} ${e.uid === meUid ? "is-you" : ""}">
      <span class="leaderboard-rank">${rankLabel(e, { showTie: true })}</span>
      <span class="leaderboard-name" dir="auto">${e.displayName}${e.uid === meUid ? " (You)" : ""}</span>
      <span class="leaderboard-score">${formatPercent(e.percentage)}</span>
    </div>`;

  return html`
    <div class="leaderboard">
      ${visible.map(row)}
      ${mineHidden ? html`<p class="page-sub" style="text-align:center">…</p>${row(mine)}` : ""}
    </div>
    ${!showAll && entries.length > visible.length + (mineHidden ? 1 : 0)
      ? html`<div class="row" style="justify-content:center;margin-top:14px">
          <button type="button" class="btn btn-secondary" data-action="show-all">Show everyone (${entries.length})</button>
        </div>` : ""}`;
}

const rankText = (snapshot, uid) => {
  if (snapshot === undefined) return "…";
  if (snapshot === null) return "Pending";
  const entry = (snapshot.entries || []).find((e) => e.uid === uid);
  return entry ? `#${entry.rank}` : "—";
};

export async function renderRanking(container, ctx) {
  const profile = ctx.profile;
  setHtml(container, loadingRows(4));

  let closedExams;
  let overall;
  try {
    const exams = await examService.listForStudent(profile);
    closedExams = exams
      .filter((e) => examPhase(e) === "closed")
      .sort((a, b) => (toMillis(b.startAt) || 0) - (toMillis(a.startAt) || 0));
    overall = await rankingService.getOverall(profile.grade, profile.subject).catch(() => null);
  } catch (err) {
    console.error("[ranking] could not load:", err);
    setHtml(container, html`
      <div class="page-head"><h1 class="page-title">Ranking</h1></div>
      ${emptyState({
        title: "We couldn't load the ranking",
        message: err && err.message ? err.message : "Please check your connection and try again.",
        action: html`<button type="button" class="btn btn-secondary" data-retry>Try again</button>`
      })}`);
    return undefined;
  }

  const state = { tab: "exam", examId: closedExams[0] ? closedExams[0].id : null, showAll: false };
  const snapshots = new Map();   // examId → ranking snapshot, or null when not published yet

  async function snapshotFor(examId) {
    if (!snapshots.has(examId)) {
      try { snapshots.set(examId, await rankingService.getExam(examId)); }
      catch (_) { snapshots.set(examId, null); }
    }
    return snapshots.get(examId);
  }

  if (state.examId) await snapshotFor(state.examId);

  /* ---- the page: tabs and numbers are drawn once, the leaderboard changes ---- */
  const lastExam = closedExams[0] || null;
  setHtml(container, html`
    <header class="page-head">
      <div>
        <h1 class="page-title">Ranking</h1>
        <p class="page-sub">${profile.grade} · ${profile.subject}</p>
      </div>
    </header>

    <div class="stack-lg">
      <section class="stat-grid">
        <div class="stat"><p class="stat-value" id="rank-last"></p><p class="stat-label">Last exam rank</p></div>
        <div class="stat"><p class="stat-value" id="rank-overall"></p><p class="stat-label">Overall rank</p></div>
      </section>

      <section>
        <div class="tabs" role="tablist" aria-label="Ranking type" style="margin-bottom:16px">
          <button type="button" class="tab" role="tab" id="tab-exam" data-action="tab" data-tab="exam">By exam</button>
          <button type="button" class="tab" role="tab" id="tab-overall" data-action="tab" data-tab="overall">Overall</button>
        </div>

        <div class="field" id="exam-picker" style="margin-bottom:16px">
          <label for="rank-exam">Exam</label>
          <select id="rank-exam">
            ${closedExams.map((e) => html`<option value="${e.id}">${e.title} — ${formatDate(e.startAt)}</option>`)}
          </select>
        </div>

        <div id="rank-body"></div>
      </section>
    </div>`);

  container.querySelector("#rank-last").textContent = lastExam ? rankText(snapshots.get(lastExam.id), profile.uid) : "—";
  container.querySelector("#rank-overall").textContent = rankText(overall, profile.uid);

  const bodyBox = container.querySelector("#rank-body");
  const picker = container.querySelector("#exam-picker");
  const select = container.querySelector("#rank-exam");

  function note(snapshot) {
    return html`<p class="page-sub" style="margin-top:14px">${snapshot.totalRanked} ${snapshot.totalRanked === 1 ? "student" : "students"} ranked · updated ${formatDateTime(snapshot.publishedAt)}</p>`;
  }

  function paintBody() {
    // tabs
    ["exam", "overall"].forEach((name) => {
      const tab = container.querySelector(`#tab-${name}`);
      const selected = state.tab === name;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    picker.hidden = state.tab !== "exam" || !closedExams.length;

    if (state.tab === "overall") {
      if (!overall) {
        setHtml(bodyBox, emptyState({
          title: "No overall ranking yet",
          message: "It appears once the first exam of your class has been graded and its ranking published."
        }));
        return;
      }
      const mine = (overall.entries || []).some((e) => e.uid === profile.uid);
      setHtml(bodyBox, html`
        ${mine ? "" : html`<div class="banner banner-info" style="margin-bottom:14px"><span>You are not in the overall ranking yet. It needs at least one graded exam from you.</span></div>`}
        <p class="page-sub" style="margin-bottom:12px">Your average over all the exams that have a ranking.</p>
        ${leaderboardHtml(overall.entries || [], profile.uid, state.showAll)}
        ${note(overall)}`);
      return;
    }

    if (!closedExams.length) {
      setHtml(bodyBox, emptyState({
        title: "No finished exams yet",
        message: "The ranking of each exam appears here once the exam has closed and everyone is graded."
      }));
      return;
    }

    const snapshot = snapshots.get(state.examId);
    if (snapshot === undefined) { setHtml(bodyBox, loadingRows(3)); return; }

    if (snapshot === null) {
      setHtml(bodyBox, emptyState({
        title: "Ranking pending",
        message: "The ranking appears once the exam has closed and all your classmates' exams are graded."
      }));
      return;
    }

    const mine = (snapshot.entries || []).some((e) => e.uid === profile.uid);
    setHtml(bodyBox, html`
      ${mine ? "" : html`<div class="banner banner-info" style="margin-bottom:14px"><span>You are not part of this ranking.</span></div>`}
      ${leaderboardHtml(snapshot.entries || [], profile.uid, state.showAll)}
      ${note(snapshot)}`);
  }

  paintBody();

  /* ---- events ---- */
  const stopClicks = delegate(container, "click", "[data-action]", (event, el) => {
    if (el.dataset.action === "tab") {
      state.tab = el.dataset.tab;
      state.showAll = false;
      paintBody();
    }
    if (el.dataset.action === "show-all") {
      state.showAll = true;
      paintBody();
    }
  });

  const onPick = async () => {
    state.examId = select.value;
    state.showAll = false;
    if (!snapshots.has(state.examId)) { paintBody(); await snapshotFor(state.examId); }
    paintBody();
  };
  select.addEventListener("change", onPick);

  return () => {
    stopClicks();
    select.removeEventListener("change", onPick);
  };
}