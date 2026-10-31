/* ============================================================================
   CODE CRAFT — QUIZ PLATFORM
   js/admin.js

   Staff screens (admin, teacher and secretary all see the same ones):

     renderDashboard   what needs attention today
     renderStudents    approve new accounts, search and filter students
     renderStudent     one student: details, block / ban, exams, parent report
     renderAccounts    ADMIN ONLY — create and deactivate staff accounts

   Exams live in exams.js, grading in grading.js, homework in homework.js,
   lessons in lessons.js.
   ============================================================================ */

import {
  collection, doc, getDocs, updateDoc, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

import { db, ROLES, ACCOUNT_STATUS, GRADES, SUBJECTS } from "./firebase-config.js";
import { createStaffAccount } from "./auth.js";
import {
  studentService, examService, attemptService, examPhase, toMillis
} from "./data-services.js";
import { loadReportData, reportCardHtml } from "./student.js";

import {
  html, setHtml, icon, avatar, badge, statusBadge, emptyState, loadingRows,
  openModal, confirmDialog, toast, delegate, copyText, readForm,
  showFormError, clearFormError, setFieldError, clearFieldErrors, withBusy,
  formatDate, formatDateTime, formatPercent
} from "./ui-helpers.js";

/* ============================================================================
   1. SHARED HELPERS
   ============================================================================ */

const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "there";
const capitalize = (text) => String(text || "").charAt(0).toUpperCase() + String(text || "").slice(1);
const paramsOf = (object) => JSON.stringify(object);

function fail(err) {
  console.error("[admin]", err);
  toast(err && err.message ? err.message : "Something went wrong. Please try again.", { type: "error" });
}

function showLoadError(container, title, err) {
  console.error(`[admin] ${title}:`, err);
  setHtml(container, html`
    <div class="page-head"><h1 class="page-title">${title}</h1></div>
    ${emptyState({
      title: "We couldn't load this",
      message: err && err.message ? err.message : "Please check your connection and try again.",
      action: html`<button type="button" class="btn btn-secondary" data-retry>Try again</button>`
    })}`);
}

/**
 * A small dialog with an optional (or required) reason.
 * @returns {Promise<{note: string} | null>} null when cancelled
 */
async function askNote({ title, message, confirmLabel, danger = false, required = false }) {
  let note = "";
  const modal = openModal({
    title,
    size: "sm",
    content: html`
      <p class="modal-text">${message}</p>
      <div class="field" style="margin-top:14px">
        <label for="note-input">Reason ${required ? "" : html`<span class="label-note">(optional)</span>`}</label>
        <textarea id="note-input" rows="3" dir="auto"></textarea>
      </div>`,
    actions: [
      { label: "Cancel", variant: "secondary", value: false },
      {
        label: confirmLabel,
        variant: danger ? "danger" : "primary",
        closes: false,
        onClick: (api) => {
          const input = api.root.querySelector("#note-input");
          const value = input.value.trim();
          if (required && !value) {
            setFieldError(input, "Please write a short reason.");
            input.focus();
            return;
          }
          note = value;
          api.close(true);
        }
      }
    ]
  });
  return (await modal.result) === true ? { note } : null;
}

/** Avatar + name + ID, used in several lists. */
function identity(student) {
  return html`
    <div class="row" style="gap:12px;flex-wrap:nowrap">
      ${avatar(student.gender, { size: 40 })}
      <div style="min-width:0">
        <p class="list-item-title" dir="auto">${student.name}</p>
        <p class="list-item-sub num" dir="ltr">${student.loginId}</p>
      </div>
    </div>`;
}

/* ============================================================================
   2. DASHBOARD
   ============================================================================ */

export async function renderDashboard(container, ctx) {
  const profile = ctx.profile;
  setHtml(container, loadingRows(4));

  try {
    const [students, exams, waitingGrading] = await Promise.all([
      studentService.listAll(),
      examService.listAll(),
      attemptService.listPendingGrading()
    ]);

    const pending = students.filter((s) => s.accountStatus === ACCOUNT_STATUS.PENDING);
    const active = students.filter((s) => s.accountStatus === ACCOUNT_STATUS.ACTIVE);
    const openExams = exams.filter((e) => e.status === "published" && examPhase(e) === "open");

    // essays waiting, grouped by exam
    const gradingByExam = new Map();
    waitingGrading.forEach((a) => {
      const entry = gradingByExam.get(a.examId) || { examId: a.examId, title: a.examTitle, count: 0 };
      entry.count += 1;
      gradingByExam.set(a.examId, entry);
    });

    setHtml(container, html`
      <header class="page-head">
        <div>
          <h1 class="page-title" dir="auto">Hello, ${firstName(profile.name)}</h1>
          <p class="page-sub">Here is what needs your attention.</p>
        </div>
      </header>

      <div class="stack-lg">
        <section class="stat-grid">
          <div class="stat"><p class="stat-value">${pending.length}</p><p class="stat-label">Accounts waiting for approval</p></div>
          <div class="stat"><p class="stat-value">${active.length}</p><p class="stat-label">Active students</p></div>
          <div class="stat"><p class="stat-value">${openExams.length}</p><p class="stat-label">Exams open now</p></div>
          <div class="stat"><p class="stat-value">${waitingGrading.length}</p><p class="stat-label">Students waiting for grading</p></div>
        </section>

        <section class="row">
          <button type="button" class="btn btn-primary" data-nav="staff-exam-builder">${icon("plus", { size: 18 })} New exam</button>
          <button type="button" class="btn btn-secondary" data-nav="staff-grading">${icon("pencil", { size: 18 })} Grade essays</button>
          <button type="button" class="btn btn-secondary" data-nav="staff-students">${icon("users", { size: 18 })} Students</button>
        </section>

        <section>
          <div class="section-head">
            <h2 class="section-title">Waiting for approval</h2>
            ${pending.length > 5 ? html`<button type="button" class="link-btn" data-nav="staff-students">See all ${pending.length}</button>` : ""}
          </div>
          ${pending.length
            ? html`<div class="list">${pending.slice(0, 5).map((s) => html`
                <button type="button" class="list-item" data-nav="staff-student" data-nav-params="${paramsOf({ uid: s.uid })}">
                  <div class="list-item-main">
                    <p class="list-item-title" dir="auto">${s.name}</p>
                    <p class="list-item-sub">${s.grade} · ${s.subject} · registered ${formatDate(s.createdAt)}</p>
                  </div>
                  ${icon("chevron-right", { size: 18 })}
                </button>`)}</div>`
            : html`<p class="page-sub">No accounts are waiting.</p>`}
        </section>

        <section>
          <div class="section-head"><h2 class="section-title">Exams waiting for grading</h2></div>
          ${gradingByExam.size
            ? html`<div class="list">${[...gradingByExam.values()].map((g) => html`
                <button type="button" class="list-item" data-nav="staff-grading" data-nav-params="${paramsOf({ examId: g.examId })}">
                  <div class="list-item-main">
                    <p class="list-item-title" dir="auto">${g.title || "Exam"}</p>
                    <p class="list-item-sub">${g.count} ${g.count === 1 ? "student" : "students"} waiting</p>
                  </div>
                  ${icon("chevron-right", { size: 18 })}
                </button>`)}</div>`
            : html`<p class="page-sub">Nothing to grade right now.</p>`}
        </section>

        <section>
          <div class="section-head"><h2 class="section-title">Open exams</h2></div>
          ${openExams.length
            ? html`<div class="list">${openExams.map((e) => html`
                <button type="button" class="list-item" data-nav="staff-exam-detail" data-nav-params="${paramsOf({ examId: e.id })}">
                  <div class="list-item-main">
                    <p class="list-item-title" dir="auto">${e.subject} — ${e.title}</p>
                    <p class="list-item-sub">${e.assignedGrade} · closes ${formatDateTime(e.endAt)}</p>
                  </div>
                  ${icon("chevron-right", { size: 18 })}
                </button>`)}</div>`
            : html`<p class="page-sub">No exam is open at the moment.</p>`}
        </section>
      </div>`);
  } catch (err) {
    showLoadError(container, "Dashboard", err);
  }
  return undefined;
}

/* ============================================================================
   3. STUDENTS
   ============================================================================ */

const PAGE_SIZE = 100;

export async function renderStudents(container, ctx) {
  setHtml(container, loadingRows(5));

  let students;
  try {
    students = await studentService.listAll();
  } catch (err) {
    showLoadError(container, "Students", err);
    return undefined;
  }

  const filters = { status: "all", grade: "", subject: "", query: "", limit: PAGE_SIZE };

  const pendingList = () => students.filter((s) => s.accountStatus === ACCOUNT_STATUS.PENDING);

  const matches = (s) => {
    if (filters.status !== "all" && s.accountStatus !== filters.status) return false;
    if (filters.grade && s.grade !== filters.grade) return false;
    if (filters.subject && s.subject !== filters.subject) return false;
    const q = filters.query.trim().toLowerCase();
    if (!q) return true;
    return [s.name, s.loginId, s.mobile, s.parentMobile].some((v) => String(v || "").toLowerCase().includes(q));
  };

  const count = (status) => students.filter((s) => s.accountStatus === status).length;

  /* ---- the page shell is drawn once, so the search box keeps its focus ---- */
  setHtml(container, html`
    <header class="page-head">
      <div>
        <h1 class="page-title">Students</h1>
        <p class="page-sub" id="students-summary"></p>
      </div>
    </header>

    <div class="stack-lg">
      <section id="pending-box"></section>

      <section>
        <div class="toolbar">
          <div class="field search">
            <label class="sr-only" for="student-search">Search students</label>
            <input id="student-search" type="search" placeholder="Search by name, ID or mobile" autocomplete="off">
          </div>
          <div class="field">
            <label class="sr-only" for="filter-grade">Grade</label>
            <select id="filter-grade">
              <option value="">All grades</option>
              ${GRADES.map((g) => html`<option value="${g}">${g}</option>`)}
            </select>
          </div>
          <div class="field">
            <label class="sr-only" for="filter-subject">Subject</label>
            <select id="filter-subject">
              <option value="">All subjects</option>
              ${SUBJECTS.map((s) => html`<option value="${s}">${s}</option>`)}
            </select>
          </div>
        </div>
        <div class="row" id="status-chips" style="margin-bottom:16px"></div>
        <div id="students-table"></div>
      </section>
    </div>`);

  const summaryEl = container.querySelector("#students-summary");
  const pendingBox = container.querySelector("#pending-box");
  const chipsBox = container.querySelector("#status-chips");
  const tableBox = container.querySelector("#students-table");

  function paintPending() {
    const list = pendingList();
    if (!list.length) { setHtml(pendingBox, ""); return; }
    setHtml(pendingBox, html`
      <div class="section-head">
        <h2 class="section-title">Waiting for approval (${list.length})</h2>
      </div>
      <div class="stack">
        ${list.map((s) => html`
          <article class="card stack">
            <div>
              <p class="list-item-title" dir="auto">${s.name}</p>
              <p class="list-item-sub">${s.grade} · ${s.subject} · registered ${formatDate(s.createdAt)}</p>
              <p class="list-item-sub">Mobile <span class="num" dir="ltr">${s.mobile}</span> · Parent <span class="num" dir="ltr">${s.parentMobile}</span></p>
            </div>
            <div class="row">
              <button type="button" class="btn btn-primary btn-sm" data-action="approve" data-uid="${s.uid}">Approve</button>
              <button type="button" class="btn btn-secondary btn-sm" data-action="reject" data-uid="${s.uid}">Reject</button>
              <button type="button" class="btn btn-ghost btn-sm" data-nav="staff-student" data-nav-params="${paramsOf({ uid: s.uid })}">Details</button>
            </div>
          </article>`)}
      </div>`);
  }

  function paintChips() {
    const chips = [
      ["all", `All (${students.length})`],
      [ACCOUNT_STATUS.PENDING, `Pending (${count(ACCOUNT_STATUS.PENDING)})`],
      [ACCOUNT_STATUS.ACTIVE, `Active (${count(ACCOUNT_STATUS.ACTIVE)})`],
      [ACCOUNT_STATUS.BLOCKED, `Blocked (${count(ACCOUNT_STATUS.BLOCKED)})`],
      [ACCOUNT_STATUS.BANNED, `Banned (${count(ACCOUNT_STATUS.BANNED)})`]
    ];
    setHtml(chipsBox, chips.map(([value, label]) => html`
      <button type="button" class="chip ${filters.status === value ? "is-active" : ""}" data-action="filter" data-status="${value}">${label}</button>`));
  }

  function paintTable() {
    const all = students.filter(matches);
    const shown = all.slice(0, filters.limit);

    if (!all.length) {
      setHtml(tableBox, emptyState({
        title: students.length ? "No students found" : "No students yet",
        message: students.length ? "Try a different search or filter." : "Students will appear here after they register."
      }));
      return;
    }

    setHtml(tableBox, html`
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Student</th><th>ID</th><th>Grade</th><th>Subject</th><th>Status</th></tr></thead>
          <tbody>
            ${shown.map((s) => html`
              <tr class="is-clickable" data-nav="staff-student" data-nav-params="${paramsOf({ uid: s.uid })}">
                <td>
                  <div class="row" style="gap:10px;flex-wrap:nowrap">
                    ${avatar(s.gender, { size: 32 })}
                    <button type="button" class="link-btn" style="color:var(--text);text-decoration:none;text-align:start"
                            data-nav="staff-student" data-nav-params="${paramsOf({ uid: s.uid })}" dir="auto">${s.name}</button>
                  </div>
                </td>
                <td><span class="num" dir="ltr">${s.loginId}</span></td>
                <td>${s.grade}</td>
                <td>${s.subject}</td>
                <td>${statusBadge("account", s.accountStatus)}</td>
              </tr>`)}
          </tbody>
        </table>
      </div>
      ${all.length > shown.length
        ? html`<div class="row" style="justify-content:center;margin-top:14px">
            <button type="button" class="btn btn-secondary" data-action="more">Show more (${all.length - shown.length} left)</button>
          </div>` : ""}`);
  }

  function paintAll() {
    const waiting = count(ACCOUNT_STATUS.PENDING);
    summaryEl.textContent = `${students.length} ${students.length === 1 ? "student" : "students"}` +
      (waiting ? `, ${waiting} waiting for approval` : "");
    paintPending();
    paintChips();
    paintTable();
  }

  paintAll();

  /* ---- events ---- */
  const searchInput = container.querySelector("#student-search");
  const onSearch = () => { filters.query = searchInput.value; filters.limit = PAGE_SIZE; paintTable(); };
  const onGrade = (e) => { filters.grade = e.target.value; filters.limit = PAGE_SIZE; paintTable(); };
  const onSubject = (e) => { filters.subject = e.target.value; filters.limit = PAGE_SIZE; paintTable(); };
  searchInput.addEventListener("input", onSearch);
  container.querySelector("#filter-grade").addEventListener("change", onGrade);
  container.querySelector("#filter-subject").addEventListener("change", onSubject);

  const stopClicks = delegate(container, "click", "[data-action]", async (event, el) => {
    const action = el.dataset.action;

    if (action === "filter") { filters.status = el.dataset.status; filters.limit = PAGE_SIZE; paintChips(); paintTable(); return; }
    if (action === "more") { filters.limit += PAGE_SIZE; paintTable(); return; }

    const student = students.find((s) => s.uid === el.dataset.uid);
    if (!student) return;

    if (action === "approve") {
      await withBusy(el, async () => {
        try {
          await studentService.approve(student.uid);
          student.accountStatus = ACCOUNT_STATUS.ACTIVE;
          toast(`${student.name} can now log in.`, { type: "success" });
          paintAll();
        } catch (err) { fail(err); }
      });
    }

    if (action === "reject") {
      const ok = await confirmDialog({
        title: "Reject this request?",
        message: `${student.name}'s registration will be removed. They can register again later.`,
        confirmLabel: "Reject",
        danger: true
      });
      if (!ok) return;
      try {
        await studentService.reject(student.uid);
        students = students.filter((s) => s.uid !== student.uid);
        toast("Request rejected.");
        paintAll();
      } catch (err) { fail(err); }
    }
  });

  return () => {
    stopClicks();
    searchInput.removeEventListener("input", onSearch);
  };
}

/* ============================================================================
   4. ONE STUDENT
   ============================================================================ */

export async function renderStudent(container, ctx) {
  const uid = ctx.params.uid;
  if (!uid) { ctx.navigate("staff-students", {}, { replace: true }); return undefined; }

  const isAdmin = ctx.profile.role === ROLES.ADMIN;
  setHtml(container, loadingRows(5));

  let student = null;
  let attempts = [];
  let exams = [];
  let report = null;

  async function load() {
    student = await studentService.get(uid);
    if (!student || student.role !== ROLES.STUDENT) throw new Error("We couldn't find this student.");
    [attempts, exams, report] = await Promise.all([
      attemptService.listForStudent(uid),
      examService.listAll(),
      loadReportData(student)
    ]);
    attempts.sort((a, b) => (toMillis(b.submittedAt || b.startedAt) || 0) - (toMillis(a.submittedAt || a.startedAt) || 0));
  }

  const accountActions = () => {
    const status = student.accountStatus;
    const buttons = [];
    if (status === ACCOUNT_STATUS.PENDING) {
      buttons.push(html`<button type="button" class="btn btn-primary" data-action="approve">Approve account</button>`);
      buttons.push(html`<button type="button" class="btn btn-secondary" data-action="reject">Reject request</button>`);
    }
    if (status === ACCOUNT_STATUS.ACTIVE) {
      buttons.push(html`<button type="button" class="btn btn-secondary" data-action="block">Block temporarily</button>`);
      if (isAdmin) buttons.push(html`<button type="button" class="btn btn-secondary" data-action="ban">Ban permanently</button>`);
    }
    if (status === ACCOUNT_STATUS.BLOCKED) {
      buttons.push(html`<button type="button" class="btn btn-primary" data-action="unblock">Unblock</button>`);
      if (isAdmin) buttons.push(html`<button type="button" class="btn btn-secondary" data-action="ban">Ban permanently</button>`);
    }
    if (status === ACCOUNT_STATUS.BANNED) {
      buttons.push(isAdmin
        ? html`<button type="button" class="btn btn-primary" data-action="unban">Lift the ban</button>`
        : html`<p class="page-sub">Only an admin can change a banned account.</p>`);
    }
    return buttons;
  };

  const statusHelp = {
    [ACCOUNT_STATUS.PENDING]: "This student registered and is waiting for approval. They can't log in yet.",
    [ACCOUNT_STATUS.ACTIVE]: "This student can log in normally.",
    [ACCOUNT_STATUS.BLOCKED]: "Blocked for now. All of the student's data is kept, and unblocking brings everything back.",
    [ACCOUNT_STATUS.BANNED]: "Banned permanently. Only an admin can lift this."
  };

  function attemptRow(attempt) {
    const exam = exams.find((e) => e.id === attempt.examId);
    const closed = exam && examPhase(exam) === "closed";
    const submitted = attempt.status !== "IN_PROGRESS";

    return html`
      <div class="list-item" style="flex-wrap:wrap">
        <div class="list-item-main">
          <p class="list-item-title" dir="auto">${attempt.examTitle || "Exam"}</p>
          <p class="list-item-sub">
            ${submitted ? `Submitted ${formatDateTime(attempt.submittedAt)}` : `Started ${formatDateTime(attempt.startedAt)}`}
            ${attempt.tabSwitchCount ? ` · left the tab ${attempt.tabSwitchCount}×` : ""}
          </p>
        </div>
        <div class="list-item-end">
          ${attempt.excludedFromRanking ? badge("Out of ranking", "red") : ""}
          ${attempt.status === "COMPLETED" ? html`<span class="list-item-value">${formatPercent(attempt.percentage)}</span>` : statusBadge("attempt", attempt.status)}
        </div>
        <div class="row" style="width:100%">
          ${submitted ? html`<button type="button" class="btn btn-secondary btn-sm" data-nav="staff-grade" data-nav-params="${paramsOf({ attemptId: attempt.id })}">Open answers</button>` : ""}
          ${submitted && attempt.status === "COMPLETED" ? (attempt.excludedFromRanking
            ? html`<button type="button" class="btn btn-ghost btn-sm" data-action="restore" data-attempt-id="${attempt.id}">Put back in ranking</button>`
            : html`<button type="button" class="btn btn-ghost btn-sm" data-action="exclude" data-attempt-id="${attempt.id}">Remove from ranking</button>`) : ""}
          ${!submitted && closed ? html`<button type="button" class="btn btn-secondary btn-sm" data-action="force-submit" data-attempt-id="${attempt.id}">Submit for the student</button>` : ""}
        </div>
      </div>`;
  }

  function paint() {
    setHtml(container, html`
      <header class="page-head">
        <button type="button" class="btn btn-ghost" data-nav="staff-students">${icon("chevron-left", { size: 18 })} Students</button>
      </header>

      <div class="stack-lg">
        <section class="card">
          <div class="profile-head">
            ${avatar(student.gender, { size: 72 })}
            <div style="min-width:0">
              <h1 class="card-title" dir="auto" style="margin-bottom:4px">${student.name}</h1>
              <p class="row" style="gap:8px">
                <span class="num" dir="ltr">${student.loginId}</span>
                <button type="button" class="icon-btn" data-action="copy-id" aria-label="Copy ID" title="Copy ID">${icon("copy", { size: 18 })}</button>
                ${statusBadge("account", student.accountStatus)}
              </p>
            </div>
          </div>
          <p class="page-sub" style="margin-bottom:14px">${statusHelp[student.accountStatus] || ""}</p>
          ${student.statusNote ? html`<p class="grader-note" dir="auto" style="margin-bottom:14px">${student.statusNote}</p>` : ""}
          <div class="row">${accountActions()}</div>
        </section>

        <section class="card">
          <div class="section-head">
            <h2 class="card-title" style="margin:0">Details</h2>
            <button type="button" class="btn btn-secondary btn-sm" data-action="edit">${icon("pencil", { size: 16 })} Edit</button>
          </div>
          <div class="info-list">
            <div class="info-row"><span class="info-label">Mobile</span><span class="info-value num" dir="ltr">${student.mobile}</span></div>
            <div class="info-row"><span class="info-label">Parent mobile</span><span class="info-value num" dir="ltr">${student.parentMobile}</span></div>
            <div class="info-row"><span class="info-label">Gender</span><span class="info-value">${student.gender}</span></div>
            <div class="info-row"><span class="info-label">Grade</span><span class="info-value">${student.grade}</span></div>
            <div class="info-row"><span class="info-label">Subject</span><span class="info-value">${student.subject}</span></div>
            ${student.email ? html`<div class="info-row"><span class="info-label">Email</span><span class="info-value" dir="ltr">${student.email}</span></div>` : ""}
            <div class="info-row"><span class="info-label">Registered</span><span class="info-value">${formatDate(student.createdAt)}</span></div>
          </div>
        </section>

        <section>
          <div class="section-head"><h2 class="section-title">Exams</h2></div>
          ${attempts.length
            ? html`<div class="list">${attempts.map(attemptRow)}</div>`
            : html`<p class="page-sub">This student hasn't taken any exam yet.</p>`}
        </section>

        <section>
          <div class="section-head"><h2 class="section-title">Parent report</h2></div>
          <p class="page-sub" style="margin-bottom:12px">The green button opens WhatsApp with the parent's number and the report already written.</p>
          ${reportCardHtml(student, report, { whatsapp: true })}
        </section>
      </div>`);
  }

  /* ---- edit details (modal) ---- */
  function openEditModal() {
    const options = (values, selected) => values.map((v) => html`<option value="${v}" ${v === selected ? "selected" : ""}>${v}</option>`);

    openModal({
      title: "Edit student details",
      content: html`
        <form id="edit-student-form" class="form" novalidate>
          <div class="field"><label for="edit-name">Full name</label>
            <input id="edit-name" name="name" type="text" dir="auto" value="${student.name}" required></div>
          <div class="field"><label for="edit-mobile">Mobile number</label>
            <input id="edit-mobile" name="mobile" type="tel" inputmode="numeric" value="${student.mobile}" required></div>
          <div class="field"><label for="edit-parent">Parent mobile number</label>
            <input id="edit-parent" name="parentMobile" type="tel" inputmode="numeric" value="${student.parentMobile}" required></div>
          <div class="field"><label for="edit-email">Email <span class="label-note">(optional)</span></label>
            <input id="edit-email" name="email" type="email" value="${student.email || ""}"></div>
          <div class="field-row">
            <div class="field"><label for="edit-gender">Gender</label>
              <select id="edit-gender" name="gender">${options(["Male", "Female"], student.gender)}</select></div>
            <div class="field"><label for="edit-grade">Grade</label>
              <select id="edit-grade" name="grade">${options(GRADES, student.grade)}</select></div>
          </div>
          <div class="field"><label for="edit-subject">Subject</label>
            <select id="edit-subject" name="subject">${options(SUBJECTS, student.subject)}</select></div>
          <p class="form-error" id="edit-error" role="alert" hidden></p>
        </form>`,
      actions: [
        { label: "Cancel", variant: "secondary", value: false },
        {
          label: "Save changes",
          variant: "primary",
          closes: false,
          onClick: async (api) => {
            const form = api.root.querySelector("#edit-student-form");
            const errorBox = api.root.querySelector("#edit-error");
            clearFormError(errorBox);
            api.setBusy(true);
            try {
              await studentService.updateProfile(uid, readForm(form));
              api.close(true);
              toast("Details saved.", { type: "success" });
              await refresh();
            } catch (err) {
              showFormError(errorBox, err && err.message ? err.message : "Couldn't save. Please try again.");
              api.setBusy(false);
            }
          }
        }
      ]
    });
  }

  async function refresh() {
    try { await load(); paint(); } catch (err) { fail(err); }
  }

  /* ---- actions ---- */
  async function run(task, successMessage) {
    try {
      await task();
      if (successMessage) toast(successMessage, { type: "success" });
      await refresh();
    } catch (err) { fail(err); }
  }

  const stopClicks = delegate(container, "click", "[data-action]", async (event, el) => {
    switch (el.dataset.action) {
      case "copy-id": {
        const ok = await copyText(student.loginId);
        toast(ok ? "ID copied." : "Couldn't copy the ID.", { type: ok ? "success" : "error" });
        break;
      }
      case "edit":
        openEditModal();
        break;
      case "approve":
        await withBusy(el, () => run(() => studentService.approve(uid), "Account approved."));
        break;
      case "reject": {
        const ok = await confirmDialog({
          title: "Reject this request?",
          message: "The registration will be removed. The student can register again later.",
          confirmLabel: "Reject",
          danger: true
        });
        if (!ok) break;
        try {
          await studentService.reject(uid);
          toast("Request rejected.");
          ctx.navigate("staff-students", {}, { replace: true });
        } catch (err) { fail(err); }
        break;
      }
      case "block": {
        const answer = await askNote({
          title: "Block this student?",
          message: "They won't be able to log in until someone unblocks them. Nothing is deleted.",
          confirmLabel: "Block"
        });
        if (answer) await run(() => studentService.setStatus(uid, ACCOUNT_STATUS.BLOCKED, { note: answer.note }), "Student blocked.");
        break;
      }
      case "unblock":
        await run(() => studentService.setStatus(uid, ACCOUNT_STATUS.ACTIVE), "Student unblocked.");
        break;
      case "ban": {
        const answer = await askNote({
          title: "Ban this student permanently?",
          message: "Use this when the student has left the academy. Only an admin can lift a ban.",
          confirmLabel: "Ban",
          danger: true
        });
        if (answer) await run(() => studentService.setStatus(uid, ACCOUNT_STATUS.BANNED, { note: answer.note }), "Student banned.");
        break;
      }
      case "unban":
        await run(() => studentService.setStatus(uid, ACCOUNT_STATUS.ACTIVE), "Ban lifted.");
        break;
      case "exclude": {
        const answer = await askNote({
          title: "Remove this exam from the ranking?",
          message: "The student still sees his own score, but it won't count in any ranking. If this exam's ranking was already published, publish it again from the exam page.",
          confirmLabel: "Remove",
          danger: true,
          required: true
        });
        if (answer) await run(() => attemptService.setExcluded(el.dataset.attemptId, true, answer.note), "Removed from the ranking.");
        break;
      }
      case "restore":
        await run(() => attemptService.setExcluded(el.dataset.attemptId, false), "Put back in the ranking. Publish the ranking again from the exam page.");
        break;
      case "force-submit": {
        const attempt = attempts.find((a) => a.id === el.dataset.attemptId);
        const ok = await confirmDialog({
          title: "Submit for this student?",
          message: "The exam has closed but the student never handed it in. His saved answers will be submitted as they are.",
          confirmLabel: "Submit"
        });
        if (!ok || !attempt) break;
        await withBusy(el, () => run(async () => {
          const exam = await examService.get(attempt.examId);
          await attemptService.forceSubmit(exam, attempt);
        }, "Exam submitted."));
        break;
      }
      default:
    }
  });

  try {
    await load();
    paint();
  } catch (err) {
    showLoadError(container, "Student", err);
  }
  return stopClicks;
}

/* ============================================================================
   5. STAFF ACCOUNTS — admin only
   (Listing staff isn't part of data-services, so the one query lives here.)
   ============================================================================ */

async function listStaff() {
  const snap = await getDocs(query(
    collection(db, "users"),
    where("role", "in", [ROLES.TEACHER, ROLES.SECRETARY, ROLES.ADMIN])
  ));
  return snap.docs
    .map((d) => ({ uid: d.id, ...d.data() }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

async function setStaffStatus(uid, status, actor) {
  await updateDoc(doc(db, "users", uid), {
    accountStatus: status,
    statusChangedBy: { uid: actor.uid, name: actor.name },
    statusChangedAt: serverTimestamp()
  });
}

const ROLE_TONE = { admin: "orange", teacher: "blue", secretary: "gray" };

export async function renderAccounts(container, ctx) {
  const me = ctx.profile;
  setHtml(container, loadingRows(4));

  let staff;
  try {
    staff = await listStaff();
  } catch (err) {
    showLoadError(container, "Staff accounts", err);
    return undefined;
  }

  function paintStaff() {
    container.querySelector("#staff-count").textContent = staff.length;
    const box = container.querySelector("#staff-table");
    setHtml(box, html`
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Name</th><th>ID</th><th>Role</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${staff.map((s) => html`
              <tr>
                <td dir="auto">${s.name}</td>
                <td><span class="num" dir="ltr">${s.loginId}</span></td>
                <td>${badge(capitalize(s.role), ROLE_TONE[s.role] || "gray")}</td>
                <td>${statusBadge("account", s.accountStatus)}</td>
                <td style="text-align:right">
                  ${s.uid === me.uid
                    ? html`<span class="page-sub">You</span>`
                    : s.accountStatus === ACCOUNT_STATUS.ACTIVE
                      ? html`<button type="button" class="btn btn-secondary btn-sm" data-action="deactivate" data-uid="${s.uid}">Deactivate</button>`
                      : html`<button type="button" class="btn btn-secondary btn-sm" data-action="reactivate" data-uid="${s.uid}">Reactivate</button>`}
                </td>
              </tr>`)}
          </tbody>
        </table>
      </div>`);
  }

  setHtml(container, html`
    <header class="page-head">
      <div>
        <h1 class="page-title">Staff accounts</h1>
        <p class="page-sub">Teachers, secretaries and admins all see the same screens. Only admins can see this page.</p>
      </div>
    </header>

    <div class="stack-lg">
      <section class="card">
        <h2 class="card-title">Create an account</h2>
        <form class="form" id="staff-form" novalidate>
          <div class="field">
            <label for="staff-name">Full name</label>
            <input id="staff-name" name="name" type="text" dir="auto" autocomplete="off" required>
          </div>
          <div class="field-row">
            <div class="field">
              <label for="staff-role">Role</label>
              <select id="staff-role" name="role" required>
                <option value="${ROLES.TEACHER}">Teacher</option>
                <option value="${ROLES.SECRETARY}">Secretary</option>
                <option value="${ROLES.ADMIN}">Admin</option>
              </select>
            </div>
            <div class="field">
              <label for="staff-password">Password</label>
              <div class="input-group">
                <input id="staff-password" name="password" type="password" autocomplete="new-password" minlength="6" required>
                <button type="button" class="input-addon" data-toggle-password="staff-password" aria-label="Show password" aria-pressed="false">
                  ${icon("eye", { size: 18 })}
                </button>
              </div>
            </div>
          </div>
          <p class="field-hint">You choose the password. The ID is created for you (TC-… for teachers, SC-… for secretaries, AD-… for admins).</p>
          <p class="form-error" id="staff-error" role="alert" hidden></p>
          <div><button type="submit" class="btn btn-primary" id="staff-submit">Create account</button></div>
        </form>
      </section>

      <section>
        <div class="section-head"><h2 class="section-title">Accounts (<span id="staff-count"></span>)</h2></div>
        <div id="staff-table"></div>
      </section>
    </div>`);

  paintStaff();

  /* ---- create ---- */
  const form = container.querySelector("#staff-form");
  const errorBox = container.querySelector("#staff-error");

  const onSubmit = async (event) => {
    event.preventDefault();
    clearFormError(errorBox);
    clearFieldErrors(form);

    await withBusy(container.querySelector("#staff-submit"), async () => {
      try {
        const created = await createStaffAccount(readForm(form));
        form.reset();
        showCredentials(created);
        staff = await listStaff();
        paintStaff();
      } catch (err) {
        showFormError(errorBox, err && err.message ? err.message : "Couldn't create the account. Please try again.");
      }
    });
  };
  form.addEventListener("submit", onSubmit);

  function showCredentials({ loginId, password }) {
    const details = `Code Craft login\nID: ${loginId}\nPassword: ${password}`;
    openModal({
      title: "Account created",
      size: "sm",
      dismissible: false,
      content: html`
        <p class="modal-text">Give these details to the staff member. The password can't be shown again, so copy it now.</p>
        <div class="id-card">
          <p class="id-card-label">ID</p>
          <p class="id-card-value" dir="ltr">${loginId}</p>
          <p class="id-card-label">Password</p>
          <p class="id-card-value" dir="ltr" style="font-size:20px">${password}</p>
        </div>`,
      actions: [
        {
          label: "Copy details",
          variant: "secondary",
          closes: false,
          onClick: async () => {
            const ok = await copyText(details);
            toast(ok ? "Copied." : "Couldn't copy. Please write them down.", { type: ok ? "success" : "error" });
          }
        },
        { label: "Done", variant: "primary", value: true }
      ]
    });
  }

  /* ---- deactivate / reactivate ---- */
  const stopClicks = delegate(container, "click", "[data-action]", async (event, el) => {
    const member = staff.find((s) => s.uid === el.dataset.uid);
    if (!member) return;

    if (el.dataset.action === "deactivate") {
      const ok = await confirmDialog({
        title: `Deactivate ${member.name}?`,
        message: "They will be signed out and won't be able to log in until you reactivate the account. Nothing is deleted.",
        confirmLabel: "Deactivate",
        danger: true
      });
      if (!ok) return;
      try {
        await setStaffStatus(member.uid, ACCOUNT_STATUS.BLOCKED, me);
        member.accountStatus = ACCOUNT_STATUS.BLOCKED;
        toast("Account deactivated.");
        paintStaff();
      } catch (err) { fail(err); }
    }

    if (el.dataset.action === "reactivate") {
      try {
        await setStaffStatus(member.uid, ACCOUNT_STATUS.ACTIVE, me);
        member.accountStatus = ACCOUNT_STATUS.ACTIVE;
        toast("Account reactivated.", { type: "success" });
        paintStaff();
      } catch (err) { fail(err); }
    }
  });

  return () => {
    stopClicks();
    form.removeEventListener("submit", onSubmit);
  };
}