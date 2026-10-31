/* ============================================================================
   CODE CRAFT — QUIZ PLATFORM
   js/lessons.js

   STUDENT
     renderLessons   two tabs: "My review notes" (one card per lesson) and
                     "Model answers" (sheets the academy published, read-only)
     renderLesson    the student's own notebook for ONE lesson: questions he finds hard,
                     each with its model answer. Saved automatically while he types;
                     "Finish" closes the editor so he knows it is done.

   STAFF
     renderStaffLessons   create / edit / delete lessons, and write, publish and
                          unpublish Model Answer Sheets (replaces printed handouts)

   The notebook is a free place for the student: copy and paste work normally here
   (the exam is the only screen where they are switched off).
   ============================================================================ */

import { GRADES, SUBJECTS } from "./firebase-config.js";
import { lessonService, sheetService, toMillis, newId } from "./data-services.js";

import {
  html, setHtml, icon, badge, emptyState, loadingRows, openModal, confirmDialog, toast,
  delegate, debounce, withBusy, readForm, showFormError, clearFormError,
  formatDate, ASSETS
} from "./ui-helpers.js";

/* ============================================================================
   1. HELPERS
   ============================================================================ */

const byNewestLesson = (a, b) => (b.lessonNumber || 0) - (a.lessonNumber || 0);
const lessonLabel = (lesson) => `Lesson ${lesson.lessonNumber} — ${lesson.title}`;
const blankEntry = () => ({ id: newId("e"), question: "", modelAnswer: "", updatedAt: Date.now() });
const isBlank = (entry) => !String(entry.question || "").trim() && !String(entry.modelAnswer || "").trim();
const classLabel = (item) => `${item.assignedGrade || "All grades"} · ${item.subject || "All subjects"}`;

/** Saving must never block typing (and offline it simply waits on the device). */
const inBackground = (promise) => {
  Promise.resolve(promise).catch((err) => console.warn("[lessons] a background save failed:", err));
};

function fail(err) {
  console.error("[lessons]", err);
  toast(err && err.message ? err.message : "Something went wrong. Please try again.", { type: "error" });
}

function showLoadError(container, title, err) {
  console.error(`[lessons] ${title}:`, err);
  setHtml(container, html`
    <div class="page-head"><h1 class="page-title">${title}</h1></div>
    ${emptyState({
      title: "We couldn't load this",
      message: err && err.message ? err.message : "Please check your connection and try again.",
      action: html`<button type="button" class="btn btn-secondary" data-retry>Try again</button>`
    })}`);
}

const tabButtons = (active, tabs) => html`
  <div class="tabs" role="tablist" style="margin-bottom:20px">
    ${tabs.map(([name, label]) => html`
      <button type="button" class="tab" role="tab" data-action="tab" data-tab="${name}"
              aria-selected="${active === name}">${label}</button>`)}
  </div>`;

/* ============================================================================
   2. STUDENT — THE LESSONS PAGE
   ============================================================================ */

const LATEST_LESSONS = 4;

export async function renderLessons(container, ctx) {
  const profile = ctx.profile;
  setHtml(container, loadingRows(3));

  let lessons;
  let counts;
  let sheets;
  try {
    [lessons, counts, sheets] = await Promise.all([
      lessonService.list(),
      lessonService.countMyEntries(profile.uid),
      sheetService.listForStudent(profile)
    ]);
  } catch (err) {
    showLoadError(container, "Lessons", err);
    return undefined;
  }

  lessons.sort(byNewestLesson);
  const ui = { tab: "notes", showAll: false };

  function notesTab() {
    if (!lessons.length) {
      return emptyState({
        title: "No lessons yet",
        message: "Your teacher adds a lesson here after explaining it. Then you can write down the questions you want to review.",
        image: ASSETS.beshoyRobot
      });
    }
    const shown = ui.showAll ? lessons : lessons.slice(0, LATEST_LESSONS);
    return html`
      <p class="page-sub" style="margin-bottom:14px">Write the questions you find hard, together with their model answers, so you can review them any time.</p>
      <div class="list">
        ${shown.map((lesson) => {
          const count = counts[lesson.id] || 0;
          return html`
            <button type="button" class="list-item" data-nav="lesson" data-nav-params="${JSON.stringify({ lessonId: lesson.id })}">
              <div class="list-item-main">
                <p class="list-item-title" dir="auto">${lessonLabel(lesson)}</p>
                <p class="list-item-sub">${count ? "Tap to review or add questions" : "Tap to add the questions you want to review"}</p>
              </div>
              <div class="list-item-end">
                ${count ? badge(`${count} ${count === 1 ? "question" : "questions"}`, "orange") : badge("Empty", "gray")}
                ${icon("chevron-right", { size: 18 })}
              </div>
            </button>`;
        })}
      </div>
      ${lessons.length > LATEST_LESSONS ? html`
        <div class="row" style="justify-content:center;margin-top:14px">
          <button type="button" class="btn btn-secondary" data-action="toggle-all">${ui.showAll ? "Show fewer" : `View all lessons (${lessons.length})`}</button>
        </div>` : ""}`;
  }

  function sheetsTab() {
    if (!sheets.length) {
      return emptyState({
        title: "No model answer sheets yet",
        message: "When your teacher publishes a sheet of questions with model answers, it will appear here.",
        image: ASSETS.beshoyRobot
      });
    }
    return html`
      <div class="list">
        ${sheets.map((sheet) => html`
          <button type="button" class="list-item" data-action="open-sheet" data-id="${sheet.id}">
            <div class="list-item-main">
              <p class="list-item-title" dir="auto">${sheet.title}</p>
              <p class="list-item-sub">${(sheet.items || []).length} questions · ${formatDate(sheet.publishedAt || sheet.updatedAt)}</p>
            </div>
            ${icon("chevron-right", { size: 18 })}
          </button>`)}
      </div>`;
  }

  function paint() {
    setHtml(container, html`
      <header class="page-head">
        <div>
          <h1 class="page-title">Lessons</h1>
          <p class="page-sub">Your review notes and the academy's model answers.</p>
        </div>
      </header>
      ${tabButtons(ui.tab, [["notes", "My review notes"], ["sheets", "Model answers"]])}
      ${ui.tab === "notes" ? notesTab() : sheetsTab()}`);
  }

  paint();

  return delegate(container, "click", "[data-action]", (event, el) => {
    const action = el.dataset.action;
    if (action === "tab") { ui.tab = el.dataset.tab; paint(); }
    if (action === "toggle-all") { ui.showAll = !ui.showAll; paint(); }
    if (action === "open-sheet") {
      const sheet = sheets.find((s) => s.id === el.dataset.id);
      if (!sheet) return;
      openModal({
        title: sheet.title,
        size: "lg",
        content: html`
          <div class="stack">
            ${(sheet.items || []).map((item, i) => html`
              <article class="note-entry">
                <p class="note-entry-label">Question ${i + 1}</p>
                <p class="note-entry-text" dir="auto">${item.question}</p>
                <p class="note-entry-label">Model answer</p>
                <p class="note-entry-text" dir="auto">${item.answer}</p>
              </article>`)}
          </div>`,
        actions: [{ label: "Close", variant: "secondary" }]
      });
    }
  });
}

/* ============================================================================
   3. STUDENT — ONE LESSON'S NOTEBOOK
   ============================================================================ */

export async function renderLesson(container, ctx) {
  const profile = ctx.profile;
  const lessonId = ctx.params.lessonId;
  if (!lessonId) { ctx.navigate("lessons", {}, { replace: true }); return undefined; }

  setHtml(container, loadingRows(3));

  let lesson;
  let entries;
  try {
    const lessons = await lessonService.list();
    lesson = lessons.find((l) => l.id === lessonId);
    if (!lesson) throw new Error("We couldn't find this lesson.");
    entries = (await lessonService.getMyEntries(profile.uid, lessonId)).map((e) => ({ ...e }));
  } catch (err) {
    showLoadError(container, "Lesson notebook", err);
    return undefined;
  }

  let editingId = null;

  const saveSoon = debounce(() => {
    inBackground(lessonService.saveMyEntries(profile, lessonId, entries));
  }, 700);

  function entryCard(entry, index) {
    const editing = entry.id === editingId;
    return html`
      <article class="note-entry" data-id="${entry.id}">
        <div class="row row-between">
          <strong>Question ${index + 1}</strong>
          ${editing
            ? html`<button type="button" class="btn btn-primary btn-sm" data-action="finish">Finish</button>`
            : html`<div class="note-entry-actions">
                <button type="button" class="icon-btn" data-action="edit" aria-label="Edit question ${index + 1}" title="Edit">${icon("pencil", { size: 18 })}</button>
                <button type="button" class="icon-btn is-danger" data-action="delete" aria-label="Delete question ${index + 1}" title="Delete">${icon("trash", { size: 18 })}</button>
              </div>`}
        </div>

        ${editing ? html`
          <div class="field">
            <label for="q-${entry.id}">The question</label>
            <textarea id="q-${entry.id}" rows="3" dir="auto" maxlength="4000" data-field="question"
                      placeholder="Enter your question…">${entry.question}</textarea>
          </div>
          <div class="field">
            <label for="a-${entry.id}">The model answer</label>
            <textarea id="a-${entry.id}" rows="4" dir="auto" maxlength="4000" data-field="modelAnswer"
                      placeholder="Enter the model answer…">${entry.modelAnswer}</textarea>
          </div>` : html`
          <div>
            <p class="note-entry-label">The question</p>
            <p class="note-entry-text" dir="auto">${entry.question || "—"}</p>
          </div>
          <div>
            <p class="note-entry-label">The model answer</p>
            <p class="note-entry-text" dir="auto">${entry.modelAnswer || "—"}</p>
          </div>`}
      </article>`;
  }

  function paint(focusId) {
    setHtml(container, html`
      <header class="page-head">
        <div>
          <button type="button" class="btn btn-ghost" data-nav="lessons">${icon("chevron-left", { size: 18 })} Lessons</button>
          <h1 class="page-title" dir="auto" style="margin-top:8px">${lessonLabel(lesson)}</h1>
          <p class="page-sub">The questions you want to review. Everything is saved as you type.</p>
        </div>
      </header>

      <div class="stack-lg">
        ${entries.length
          ? entries.map(entryCard)
          : emptyState({
              title: "Nothing here yet",
              message: "Add a question you find hard, with its model answer, so you can come back to it before the exam.",
              image: ASSETS.beshoyRobot
            })}
        <div>
          <button type="button" class="btn btn-secondary" data-action="add">${icon("plus", { size: 18 })} Add a question</button>
        </div>
      </div>`);

    if (focusId) {
      const field = container.querySelector(`#q-${focusId}`);
      if (field) { field.focus({ preventScroll: false }); }
    }
  }

  /** Closes the editor. An entry left completely empty is dropped. */
  function finishEditing({ announce }) {
    const entry = entries.find((e) => e.id === editingId);
    editingId = null;
    if (entry && isBlank(entry)) entries.splice(entries.indexOf(entry), 1);
    saveSoon();
    saveSoon.flush();
    if (announce) toast("Saved.", { type: "success" });
  }

  paint();

  const onInput = (event) => {
    const field = event.target;
    if (!field.dataset || !field.dataset.field) return;
    const card = field.closest("[data-id]");
    const entry = card && entries.find((e) => e.id === card.dataset.id);
    if (!entry) return;
    entry[field.dataset.field] = field.value;
    entry.updatedAt = Date.now();
    saveSoon();
  };
  container.addEventListener("input", onInput);

  const flush = () => saveSoon.flush();
  window.addEventListener("pagehide", flush);

  const stop = delegate(container, "click", "[data-action]", async (event, el) => {
    const action = el.dataset.action;
    const card = el.closest("[data-id]");
    const id = card ? card.dataset.id : null;

    if (action === "add") {
      if (editingId) finishEditing({ announce: false });
      const entry = blankEntry();
      entries.push(entry);
      editingId = entry.id;
      paint(entry.id);
    }

    if (action === "edit" && id) {
      if (editingId) finishEditing({ announce: false });
      editingId = id;
      paint(id);
    }

    if (action === "finish") {
      finishEditing({ announce: true });
      paint();
    }

    if (action === "delete" && id) {
      const ok = await confirmDialog({
        title: "Delete this question?",
        message: "It will be removed from your notebook.",
        confirmLabel: "Delete",
        danger: true
      });
      if (!ok) return;
      const at = entries.findIndex((e) => e.id === id);
      if (at >= 0) entries.splice(at, 1);
      if (editingId === id) editingId = null;
      saveSoon();
      saveSoon.flush();
      paint();
    }
  });

  return function cleanup() {
    stop();
    container.removeEventListener("input", onInput);
    window.removeEventListener("pagehide", flush);
    // leaving in the middle of a new, empty question: don't keep the empty box
    const before = entries.length;
    for (let i = entries.length - 1; i >= 0; i--) if (isBlank(entries[i])) entries.splice(i, 1);
    if (entries.length !== before) saveSoon();
    saveSoon.flush();
  };
}

/* ============================================================================
   4. STAFF — LESSONS AND MODEL ANSWER SHEETS
   ============================================================================ */

const blankItem = () => ({ id: newId("i"), question: "", answer: "" });
const blankSheet = () => ({ id: null, title: "", status: "draft", assignedGrade: "", subject: "", items: [blankItem()] });

export async function renderStaffLessons(container, ctx) {
  const ui = { tab: "lessons", view: "list" };
  let lessons = [];
  let sheets = [];
  let sheet = null;       // the sheet being edited
  let dirty = false;

  async function loadAll() {
    [lessons, sheets] = await Promise.all([lessonService.list(), sheetService.listAll()]);
    lessons.sort(byNewestLesson);
  }

  /* ---------- list view ---------- */
  function lessonsTab() {
    return html`
      <div class="row row-between" style="margin-bottom:14px">
        <p class="page-sub" style="margin:0">Students write their review notes under these lessons.</p>
        <button type="button" class="btn btn-primary" data-action="new-lesson">${icon("plus", { size: 18 })} New lesson</button>
      </div>
      ${lessons.length ? html`
        <div class="list">${lessons.map((l) => html`
          <div class="list-item">
            <div class="list-item-main">
              <p class="list-item-title" dir="auto">${lessonLabel(l)}</p>
            </div>
            <div class="list-item-end">
              <button type="button" class="icon-btn" data-action="edit-lesson" data-id="${l.id}" aria-label="Edit ${l.title}" title="Edit">${icon("pencil", { size: 18 })}</button>
              <button type="button" class="icon-btn is-danger" data-action="delete-lesson" data-id="${l.id}" aria-label="Delete ${l.title}" title="Delete">${icon("trash", { size: 18 })}</button>
            </div>
          </div>`)}</div>`
        : emptyState({ title: "No lessons yet", message: "Add a lesson after you explain it, so students can start their notebook." })}`;
  }

  function sheetsTab() {
    return html`
      <div class="row row-between" style="margin-bottom:14px">
        <p class="page-sub" style="margin:0">Ready-made questions with model answers, shown to students as read-only sheets.</p>
        <button type="button" class="btn btn-primary" data-action="new-sheet">${icon("plus", { size: 18 })} New sheet</button>
      </div>
      ${sheets.length ? html`
        <div class="list">${sheets.map((s) => html`
          <button type="button" class="list-item" data-action="edit-sheet" data-id="${s.id}">
            <div class="list-item-main">
              <p class="list-item-title" dir="auto">${s.title}</p>
              <p class="list-item-sub">${(s.items || []).length} questions · ${classLabel(s)}</p>
            </div>
            <div class="list-item-end">${s.status === "published" ? badge("Published", "green") : badge("Draft", "gray")}</div>
          </button>`)}</div>`
        : emptyState({ title: "No sheets yet", message: "Create a sheet to replace the printed model answers." })}`;
  }

  function paintList() {
    setHtml(container, html`
      <header class="page-head">
        <div>
          <h1 class="page-title">Lessons</h1>
          <p class="page-sub">Lessons for the review notebook, and model answer sheets.</p>
        </div>
      </header>
      ${tabButtons(ui.tab, [["lessons", "Lessons"], ["sheets", "Model answer sheets"]])}
      ${ui.tab === "lessons" ? lessonsTab() : sheetsTab()}`);
  }

  /* ---------- lesson form ---------- */
  function openLessonModal(existing) {
    const next = Math.max(0, ...lessons.map((l) => l.lessonNumber || 0)) + 1;
    openModal({
      title: existing ? "Edit lesson" : "New lesson",
      size: "sm",
      content: html`
        <form id="lesson-form" class="form" novalidate>
          <div class="field"><label for="lesson-number">Lesson number</label>
            <input id="lesson-number" name="lessonNumber" type="number" min="1" step="1" value="${existing ? existing.lessonNumber : next}" required></div>
          <div class="field"><label for="lesson-title">Title</label>
            <input id="lesson-title" name="title" type="text" dir="auto" value="${existing ? existing.title : ""}" required></div>
          <p class="form-error" id="lesson-error" role="alert" hidden></p>
        </form>`,
      actions: [
        { label: "Cancel", variant: "secondary", value: false },
        {
          label: existing ? "Save changes" : "Add lesson",
          variant: "primary",
          closes: false,
          onClick: async (api) => {
            const errorBox = api.root.querySelector("#lesson-error");
            clearFormError(errorBox);
            const values = readForm(api.root.querySelector("#lesson-form"));
            api.setBusy(true);
            try {
              await lessonService.save({ id: existing ? existing.id : undefined, title: values.title, lessonNumber: Number(values.lessonNumber) });
              api.close(true);
              toast(existing ? "Lesson updated." : "Lesson added.", { type: "success" });
              await loadAll();
              paintList();
            } catch (err) {
              showFormError(errorBox, err && err.message ? err.message : "Couldn't save the lesson.");
              api.setBusy(false);
            }
          }
        }
      ]
    });
  }

  /* ---------- sheet editor ---------- */
  function paintItems() {
    const box = container.querySelector("#sheet-items");
    setHtml(box, sheet.items.map((item, i) => html`
      <article class="builder-q" data-item="${item.id}">
        <div class="builder-q-head">
          <strong>Question ${i + 1}</strong>
          <button type="button" class="icon-btn is-danger" data-action="remove-item" aria-label="Delete question ${i + 1}">${icon("trash", { size: 18 })}</button>
        </div>
        <div class="field">
          <label for="si-q-${item.id}">Question</label>
          <textarea id="si-q-${item.id}" rows="3" dir="auto" data-item-field="question">${item.question}</textarea>
        </div>
        <div class="field">
          <label for="si-a-${item.id}">Model answer</label>
          <textarea id="si-a-${item.id}" rows="4" dir="auto" data-item-field="answer">${item.answer}</textarea>
        </div>
      </article>`));
  }

  function paintSheetEditor() {
    const option = (value, label, selected) => html`<option value="${value}" ${selected ? "selected" : ""}>${label}</option>`;
    setHtml(container, html`
      <header class="page-head">
        <div>
          <button type="button" class="btn btn-ghost" data-action="back-to-list">${icon("chevron-left", { size: 18 })} Model answer sheets</button>
          <h1 class="page-title" style="margin-top:8px">${sheet.id ? "Edit sheet" : "New model answer sheet"}</h1>
        </div>
      </header>

      <div class="stack-lg">
        <div id="sheet-errors" role="alert" hidden></div>

        <section class="card">
          <div class="form">
            <div class="field"><label for="sheet-title">Title</label>
              <input id="sheet-title" type="text" dir="auto" data-sheet="title" value="${sheet.title}"></div>
            <div class="field-row">
              <div class="field"><label for="sheet-grade">Grade</label>
                <select id="sheet-grade" data-sheet="assignedGrade">
                  ${option("", "All grades", !sheet.assignedGrade)}
                  ${GRADES.map((g) => option(g, g, g === sheet.assignedGrade))}
                </select></div>
              <div class="field"><label for="sheet-subject">Subject</label>
                <select id="sheet-subject" data-sheet="subject">
                  ${option("", "All subjects", !sheet.subject)}
                  ${SUBJECTS.map((s) => option(s, s, s === sheet.subject))}
                </select></div>
            </div>
          </div>
        </section>

        <section>
          <div class="section-head"><h2 class="section-title">Questions and model answers</h2></div>
          <div class="stack-lg" id="sheet-items"></div>
          <div class="row" style="margin-top:16px">
            <button type="button" class="btn btn-secondary" data-action="add-item">${icon("plus", { size: 18 })} Add a question</button>
          </div>
        </section>

        <div class="row">
          <button type="button" class="btn btn-secondary" data-action="save-draft">Save draft</button>
          <button type="button" class="btn btn-primary" data-action="publish">${sheet.status === "published" ? "Save changes" : "Publish"}</button>
          ${sheet.status === "published" ? html`<button type="button" class="btn btn-ghost" data-action="unpublish">Unpublish</button>` : ""}
          ${sheet.id ? html`<button type="button" class="btn btn-ghost" data-action="delete-sheet">${icon("trash", { size: 16 })} Delete</button>` : ""}
        </div>
      </div>`);
    paintItems();
  }

  function showSheetErrors(message) {
    const box = container.querySelector("#sheet-errors");
    setHtml(box, html`<div class="form-error">${message}</div>`);
    box.hidden = false;
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function saveSheet(status, button) {
    container.querySelector("#sheet-errors").hidden = true;

    if (status === "published" && sheet.status !== "published") {
      const ok = await confirmDialog({
        title: `Publish "${sheet.title || "this sheet"}"?`,
        message: `${classLabel(sheet)} will see it right away, as a read-only sheet.`,
        confirmLabel: "Publish"
      });
      if (!ok) return;
    }

    await withBusy(button, async () => {
      try {
        await sheetService.save({ ...sheet, status });
        dirty = false;
        toast(status === "published" ? "Sheet published." : "Draft saved.", { type: "success" });
        leaveEditor();
        await loadAll();
        paintList();
      } catch (err) {
        showSheetErrors(err && err.message ? err.message : "Couldn't save the sheet.");
      }
    });
  }

  function enterEditor(value) {
    sheet = value;
    ui.view = "edit";
    dirty = false;
    ctx.setNavigationGuard(() => !dirty || window.confirm("You have unsaved changes. Leave without saving?"));
    paintSheetEditor();
  }

  function leaveEditor() {
    ui.view = "list";
    sheet = null;
    dirty = false;
    ctx.setNavigationGuard(null);
  }

  /* ---------- go ---------- */
  setHtml(container, loadingRows(3));
  try {
    await loadAll();
    paintList();
  } catch (err) {
    showLoadError(container, "Lessons", err);
    return undefined;
  }

  const onFieldInput = (event) => {
    if (ui.view !== "edit" || !sheet) return;
    const el = event.target;
    if (el.dataset && el.dataset.sheet) {
      sheet[el.dataset.sheet] = el.value;
      dirty = true;
      return;
    }
    if (el.dataset && el.dataset.itemField) {
      const card = el.closest("[data-item]");
      const item = card && sheet.items.find((i) => i.id === card.dataset.item);
      if (item) { item[el.dataset.itemField] = el.value; dirty = true; }
    }
  };
  container.addEventListener("input", onFieldInput);
  container.addEventListener("change", onFieldInput);

  const onBeforeUnload = (event) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
  window.addEventListener("beforeunload", onBeforeUnload);

  const stop = delegate(container, "click", "[data-action]", async (event, el) => {
    const action = el.dataset.action;
    const lesson = lessons.find((l) => l.id === el.dataset.id);

    switch (action) {
      case "tab": ui.tab = el.dataset.tab; paintList(); break;

      case "new-lesson": openLessonModal(null); break;
      case "edit-lesson": if (lesson) openLessonModal(lesson); break;
      case "delete-lesson": {
        if (!lesson) break;
        const ok = await confirmDialog({
          title: `Delete ${lessonLabel(lesson)}?`,
          message: "Students will no longer see this lesson. The notes they already wrote stay saved.",
          confirmLabel: "Delete",
          danger: true
        });
        if (!ok) break;
        try {
          await lessonService.remove(lesson.id);
          toast("Lesson deleted.");
          await loadAll();
          paintList();
        } catch (err) { fail(err); }
        break;
      }

      case "new-sheet": enterEditor(blankSheet()); break;
      case "edit-sheet":
        await withBusy(el, async () => {
          try {
            const loaded = await sheetService.get(el.dataset.id);
            if (!loaded) throw new Error("We couldn't find this sheet.");
            const items = (loaded.items || []).map((i) => ({ id: i.id || newId("i"), question: i.question, answer: i.answer }));
            enterEditor({ ...loaded, assignedGrade: loaded.assignedGrade || "", subject: loaded.subject || "", items: items.length ? items : [blankItem()] });
          } catch (err) { fail(err); }
        });
        break;

      case "back-to-list": {
        if (dirty && !window.confirm("You have unsaved changes. Leave without saving?")) break;
        leaveEditor();
        paintList();
        break;
      }
      case "add-item": {
        const item = blankItem();
        sheet.items.push(item);
        dirty = true;
        paintItems();
        const field = container.querySelector(`#si-q-${item.id}`);
        if (field) { field.scrollIntoView({ behavior: "smooth", block: "center" }); field.focus({ preventScroll: true }); }
        break;
      }
      case "remove-item": {
        const card = el.closest("[data-item]");
        const at = card ? sheet.items.findIndex((i) => i.id === card.dataset.item) : -1;
        if (at >= 0) { sheet.items.splice(at, 1); dirty = true; paintItems(); }
        break;
      }
      case "save-draft": await saveSheet("draft", el); break;
      case "publish": await saveSheet("published", el); break;
      case "unpublish": await saveSheet("draft", el); break;
      case "delete-sheet": {
        const ok = await confirmDialog({
          title: "Delete this sheet?",
          message: "Students will no longer see it. This can't be undone.",
          confirmLabel: "Delete",
          danger: true
        });
        if (!ok) break;
        try {
          await sheetService.remove(sheet.id);
          toast("Sheet deleted.");
          leaveEditor();
          await loadAll();
          paintList();
        } catch (err) { fail(err); }
        break;
      }
      default:
    }
  });

  return () => {
    stop();
    container.removeEventListener("input", onFieldInput);
    container.removeEventListener("change", onFieldInput);
    window.removeEventListener("beforeunload", onBeforeUnload);
    ctx.setNavigationGuard(null);
  };
}