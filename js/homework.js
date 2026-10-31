/* ============================================================================
   CODE CRAFT — QUIZ PLATFORM
   js/homework.js

   STUDENT   renderHomework        the homework list; hand in photos of the pages
   STAFF     renderStaffHomework   create homework, see who handed in, view the photos

   Photos and storage
     Firebase Storage is a paid feature, so each photo is shrunk in the browser and saved
     as text (Base64) inside Firestore. A phone photo is several megabytes; this turns it
     into roughly 200–400 KB while keeping handwriting readable. Up to 5 photos per
     homework, and a student can hand in only once.
   ============================================================================ */

import { GRADES, SUBJECTS, ACCOUNT_STATUS } from "./firebase-config.js";
import {
  homeworkService, studentService, toMillis, MAX_HOMEWORK_IMAGES
} from "./data-services.js";

import {
  html, setHtml, icon, badge, emptyState, loadingRows, openModal, confirmDialog, toast,
  delegate, withBusy, readForm, showFormError, clearFormError,
  formatDateTime, toDateTimeLocalValue, fromDateTimeLocalValue, ASSETS
} from "./ui-helpers.js";

/* ============================================================================
   1. PHOTO PREPARATION
   ============================================================================ */

const LONG_EDGE_PX = 1600;           // big enough to read handwriting
const TARGET_CHARS = 450000;         // well under the 700,000-character limit of one document
const START_QUALITY = 0.8;

/**
 * Keeps trying smaller versions until the result fits.
 * @param {(scale: number, quality: number) => string|Promise<string>} encode  makes a data URL
 * Quality goes down to 0.5 first (it hardly shows), then the picture itself gets smaller.
 */
export async function shrinkUntilFits(encode, maxChars = TARGET_CHARS) {
  let scale = 1;
  let quality = START_QUALITY;
  for (let attempt = 0; attempt < 14; attempt++) {
    const dataUrl = await encode(scale, quality);
    if (dataUrl.length <= maxChars) return dataUrl;
    if (quality > 0.5) quality = Math.max(0.5, Math.round((quality - 0.1) * 10) / 10);
    else scale *= 0.8;
  }
  throw new Error("The image is too large.");
}

async function loadBitmap(file) {
  if ("createImageBitmap" in window) {
    try { return await createImageBitmap(file, { imageOrientation: "from-image" }); }
    catch (_) { /* fall back below */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** photo file → small JPEG data URL */
export async function fileToDataUrl(file) {
  const bitmap = await loadBitmap(file);
  const width = bitmap.width || bitmap.naturalWidth;
  const height = bitmap.height || bitmap.naturalHeight;
  const base = Math.min(1, LONG_EDGE_PX / Math.max(width, height));

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");

  const dataUrl = await shrinkUntilFits((scale, quality) => {
    canvas.width = Math.max(1, Math.round(width * base * scale));
    canvas.height = Math.max(1, Math.round(height * base * scale));
    context.fillStyle = "#ffffff";                 // JPEG has no transparency
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", quality);
  });

  if (bitmap.close) bitmap.close();
  if (!dataUrl.startsWith("data:image/jpeg")) throw new Error("Could not read the image.");
  return dataUrl;
}

/**
 * The photos a student has picked so far.
 * @param {{max: number, prepare: (file: File) => Promise<string>}} options
 */
export function createBasket({ max, prepare }) {
  const items = [];
  let counter = 0;

  return {
    items,
    get full() { return items.length >= max; },

    /** @returns {{added: number, notImages: number, overLimit: number, failed: string[]}} */
    async add(files) {
      const result = { added: 0, notImages: 0, overLimit: 0, failed: [] };
      for (const file of files) {
        if (!String(file.type).startsWith("image/")) { result.notImages += 1; continue; }
        if (items.length >= max) { result.overLimit += 1; continue; }
        try {
          const dataUrl = await prepare(file);
          counter += 1;
          items.push({ id: `img${counter}`, fileName: file.name, dataUrl });
          result.added += 1;
        } catch (_) {
          result.failed.push(file.name);
        }
      }
      return result;
    },

    remove(id) {
      const at = items.findIndex((item) => item.id === id);
      if (at >= 0) items.splice(at, 1);
    }
  };
}

/* ============================================================================
   2. SHARED PIECES
   ============================================================================ */

const paramsOf = (object) => JSON.stringify(object);

function fail(err) {
  console.error("[homework]", err);
  toast(err && err.message ? err.message : "Something went wrong. Please try again.", { type: "error" });
}

function showLoadError(container, title, err) {
  console.error(`[homework] ${title}:`, err);
  setHtml(container, html`
    <div class="page-head"><h1 class="page-title">${title}</h1></div>
    ${emptyState({
      title: "We couldn't load this",
      message: err && err.message ? err.message : "Please check your connection and try again.",
      action: html`<button type="button" class="btn btn-secondary" data-retry>Try again</button>`
    })}`);
}

const isLate = (submission, homework) => {
  const due = toMillis(homework.due);
  const at = toMillis(submission.submittedAt);
  return !!(due && at && at > due);
};

/** Big picture + small pictures. images: [{ base64 }] (data URLs) */
function showImages(title, images) {
  const modal = openModal({
    title,
    size: "lg",
    content: html`
      <div class="stack">
        <img id="hw-view" alt="" style="width:100%;border-radius:12px;background:var(--navy-850)">
        ${images.length > 1 ? html`
          <div class="thumb-grid">
            ${images.map((img, i) => html`
              <button type="button" class="thumb" data-view-index="${i}" aria-label="Show page ${i + 1}">
                <img src="${img.base64}" alt="">
              </button>`)}
          </div>` : ""}
      </div>`,
    actions: [{ label: "Close", variant: "secondary" }]
  });

  const main = modal.body.querySelector("#hw-view");
  const show = (i) => { main.src = images[i].base64; main.alt = `Page ${i + 1} of ${images.length}`; };
  delegate(modal.body, "click", "[data-view-index]", (event, el) => show(Number(el.dataset.viewIndex)));
  show(0);
}

/* ============================================================================
   3. STUDENT
   ============================================================================ */

export async function renderHomework(container, ctx) {
  const profile = ctx.profile;
  setHtml(container, loadingRows(3));

  let defs = [];
  let submissions = [];

  async function load() {
    [defs, submissions] = await Promise.all([
      homeworkService.listDefs(profile),
      homeworkService.listMySubmissions(profile.uid)
    ]);
  }

  const submissionFor = (homework) => submissions.find((s) => s.homeworkId === homework.id) || null;

  function paint() {
    // not handed in first (soonest deadline first), then the ones already done
    const todo = defs.filter((h) => !submissionFor(h)).sort((a, b) => (toMillis(a.due) || 0) - (toMillis(b.due) || 0));
    const done = defs.filter((h) => submissionFor(h)).sort((a, b) => (toMillis(b.due) || 0) - (toMillis(a.due) || 0));

    const card = (hw) => {
      const sub = submissionFor(hw);
      const overdue = !sub && (toMillis(hw.due) || Infinity) < Date.now();
      return html`
        <article class="card hw-card">
          <div class="row row-between" style="align-items:flex-start">
            <div style="min-width:0">
              <h2 class="card-title" dir="auto" style="margin-bottom:4px">${hw.title}</h2>
              <p class="list-item-sub" dir="auto">Lesson: ${hw.lesson}</p>
              <p class="list-item-sub">Due: ${formatDateTime(hw.due)}</p>
            </div>
            <div class="row" style="gap:6px;justify-content:flex-end">
              ${sub ? badge("Submitted", "green") : badge("Not submitted", overdue ? "red" : "orange")}
              ${sub && isLate(sub, hw) ? badge("Late", "orange") : ""}
              ${overdue ? badge("Overdue", "red") : ""}
            </div>
          </div>
          ${sub ? html`<p class="list-item-sub">Handed in ${formatDateTime(sub.submittedAt)} · ${sub.imageCount} ${sub.imageCount === 1 ? "photo" : "photos"}</p>` : ""}
          <div class="row">
            ${sub
              ? html`<button type="button" class="btn btn-secondary" data-action="view" data-id="${hw.id}">View my submission</button>`
              : html`<button type="button" class="btn btn-primary" data-action="submit" data-id="${hw.id}">${icon("image", { size: 18 })} Submit homework</button>`}
          </div>
        </article>`;
    };

    setHtml(container, html`
      <header class="page-head">
        <div>
          <h1 class="page-title">Homework</h1>
          <p class="page-sub">Take a photo of your pages and hand them in.</p>
        </div>
      </header>

      ${defs.length
        ? html`<div class="stack-lg">${[...todo, ...done].map(card)}</div>`
        : emptyState({
            title: "No homework right now",
            message: "When your teacher adds homework, you will find it here.",
            image: ASSETS.beshoyRobot
          })}`);
  }

  try {
    await load();
    paint();
  } catch (err) {
    showLoadError(container, "Homework", err);
    return undefined;
  }

  /* ---- handing in ---- */
  function openSubmitModal(homework) {
    const basket = createBasket({ max: MAX_HOMEWORK_IMAGES, prepare: fileToDataUrl });
    let preparing = false;

    const modal = openModal({
      title: `Submit ${homework.title}`,
      size: "lg",
      dismissible: false,
      content: html`
        <p class="modal-text">Take a clear photo of each page, or choose pictures from your phone. You can add up to ${MAX_HOMEWORK_IMAGES} photos. You can hand in only once, so check them first.</p>

        <label class="upload-drop" style="margin-top:14px">
          <input type="file" id="hw-files" accept="image/*" multiple hidden>
          ${icon("image", { size: 28 })}
          <strong>Choose photos</strong>
          <span class="page-sub" id="hw-count"></span>
        </label>

        <div class="thumb-grid" id="hw-thumbs" style="margin-top:14px"></div>
        <p class="form-error" id="hw-error" role="alert" hidden style="margin-top:14px"></p>

        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
          <button type="button" class="btn btn-primary" id="hw-submit" data-act="submit" disabled>Submit homework</button>
        </div>`
    });

    const root = modal.body;
    const fileInput = root.querySelector("#hw-files");
    const thumbs = root.querySelector("#hw-thumbs");
    const countEl = root.querySelector("#hw-count");
    const errorEl = root.querySelector("#hw-error");
    const submitBtn = root.querySelector("#hw-submit");

    function refresh() {
      setHtml(thumbs, basket.items.map((item, i) => html`
        <div class="thumb">
          <img src="${item.dataUrl}" alt="Page ${i + 1}">
          <button type="button" class="thumb-remove" data-act="remove" data-id="${item.id}" aria-label="Remove page ${i + 1}">${icon("x", { size: 16 })}</button>
        </div>`));
      countEl.textContent = preparing
        ? "Preparing your photos…"
        : `${basket.items.length} of ${MAX_HOMEWORK_IMAGES} added`;
      fileInput.disabled = basket.full || preparing;
      submitBtn.disabled = !basket.items.length || preparing;
    }
    refresh();

    fileInput.addEventListener("change", async () => {
      const files = Array.from(fileInput.files || []);
      fileInput.value = "";                         // lets the same photo be picked again
      if (!files.length) return;

      clearFormError(errorEl);
      preparing = true;
      refresh();
      const result = await basket.add(files);
      preparing = false;
      refresh();

      const problems = [];
      if (result.notImages) problems.push("Only pictures can be added.");
      if (result.overLimit) problems.push(`You can add up to ${MAX_HOMEWORK_IMAGES} photos.`);
      if (result.failed.length) problems.push(`We couldn't use: ${result.failed.join(", ")}. Please choose a normal photo (JPG or PNG).`);
      if (problems.length) showFormError(errorEl, problems.join(" "));
    });

    delegate(root, "click", "[data-act]", async (event, el) => {
      if (el.dataset.act === "remove") { basket.remove(el.dataset.id); clearFormError(errorEl); refresh(); }
      if (el.dataset.act === "cancel") modal.close(false);

      if (el.dataset.act === "submit") {
        await withBusy(el, async () => {
          try {
            await homeworkService.submit({
              student: profile,
              homework,
              images: basket.items.map((item) => ({ fileName: item.fileName, base64: item.dataUrl }))
            });
            modal.close(true);
            toast("Homework submitted.", { type: "success" });
            await load();
            paint();
          } catch (err) {
            showFormError(errorEl, err && err.message ? err.message : "We couldn't submit your homework. Please try again.");
          }
        });
      }
    });
  }

  const stop = delegate(container, "click", "[data-action]", async (event, el) => {
    const homework = defs.find((h) => h.id === el.dataset.id);
    if (!homework) return;

    if (el.dataset.action === "submit") openSubmitModal(homework);

    if (el.dataset.action === "view") {
      await withBusy(el, async () => {
        try {
          const images = await homeworkService.getImages(profile.uid, homework.id);
          if (!images.length) { toast("No photos were found.", { type: "error" }); return; }
          showImages(homework.title, images);
        } catch (err) { fail(err); }
      });
    }
  });

  return stop;
}

/* ============================================================================
   4. STAFF
   ============================================================================ */

function defaultDue() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(23, 59, 0, 0);
  return d.getTime();
}

const classLabel = (hw) => `${hw.assignedGrade || "All grades"} · ${hw.subject || "All subjects"}`;

export async function renderStaffHomework(container, ctx) {
  const ui = { view: "list", id: null, showMissing: false };
  let defs = [];
  let detail = null;   // { submissions, students } of the homework being looked at

  async function loadDefs() { defs = await homeworkService.listDefs(); }

  async function loadDetail(hw) {
    const filters = { status: ACCOUNT_STATUS.ACTIVE };
    if (hw.assignedGrade) filters.grade = hw.assignedGrade;
    if (hw.subject) filters.subject = hw.subject;
    const [submissions, students] = await Promise.all([
      homeworkService.listSubmissionsFor(hw.id),
      studentService.listAll(filters)
    ]);
    detail = { submissions, students };
  }

  /* ---------- the list ---------- */
  function paintList() {
    setHtml(container, html`
      <header class="page-head">
        <div>
          <h1 class="page-title">Homework</h1>
          <p class="page-sub">${defs.length} ${defs.length === 1 ? "homework" : "homework items"}</p>
        </div>
        <button type="button" class="btn btn-primary" data-action="new">${icon("plus", { size: 18 })} New homework</button>
      </header>

      ${defs.length
        ? html`<div class="list">${defs.map((hw) => html`
            <button type="button" class="list-item" data-action="open" data-id="${hw.id}">
              <div class="list-item-main">
                <p class="list-item-title" dir="auto">${hw.title}</p>
                <p class="list-item-sub" dir="auto">Lesson: ${hw.lesson} · ${classLabel(hw)}</p>
                <p class="list-item-sub">Due ${formatDateTime(hw.due)}</p>
              </div>
              ${icon("chevron-right", { size: 18 })}
            </button>`)}</div>`
        : emptyState({
            title: "No homework yet",
            message: "Create the first one with the New homework button.",
            image: ASSETS.beshoyRobot
          })}`);
  }

  /* ---------- one homework ---------- */
  function paintDetail() {
    const hw = defs.find((h) => h.id === ui.id);
    if (!hw || !detail) { ui.view = "list"; paintList(); return; }

    const handedIn = new Set(detail.submissions.map((s) => s.studentUid));
    const missing = detail.students.filter((s) => !handedIn.has(s.uid));
    const late = detail.submissions.filter((s) => isLate(s, hw)).length;

    setHtml(container, html`
      <header class="page-head">
        <div>
          <button type="button" class="btn btn-ghost" data-action="back">${icon("chevron-left", { size: 18 })} Homework</button>
          <h1 class="page-title" dir="auto" style="margin-top:8px">${hw.title}</h1>
          <p class="page-sub" dir="auto">Lesson: ${hw.lesson} · ${classLabel(hw)}</p>
          <p class="page-sub">Due ${formatDateTime(hw.due)}</p>
        </div>
        <div class="row">
          <button type="button" class="btn btn-secondary btn-sm" data-action="edit" data-id="${hw.id}">${icon("pencil", { size: 16 })} Edit</button>
          <button type="button" class="btn btn-ghost btn-sm" data-action="delete" data-id="${hw.id}">${icon("trash", { size: 16 })} Delete</button>
        </div>
      </header>

      <div class="stack-lg">
        <section class="stat-grid">
          <div class="stat"><p class="stat-value">${detail.submissions.length}</p><p class="stat-label">Handed in</p></div>
          <div class="stat"><p class="stat-value">${missing.length}</p><p class="stat-label">Not yet</p></div>
          <div class="stat"><p class="stat-value">${late}</p><p class="stat-label">Handed in late</p></div>
        </section>

        <section>
          <div class="section-head"><h2 class="section-title">Handed in</h2></div>
          ${detail.submissions.length
            ? html`<div class="list">${detail.submissions.map((s) => html`
                <div class="list-item" style="flex-wrap:wrap">
                  <div class="list-item-main">
                    <p class="list-item-title" dir="auto">${s.studentName || s.studentLoginId}</p>
                    <p class="list-item-sub">${formatDateTime(s.submittedAt)} · ${s.imageCount} ${s.imageCount === 1 ? "photo" : "photos"}</p>
                  </div>
                  <div class="list-item-end">
                    ${isLate(s, hw) ? badge("Late", "orange") : ""}
                    <button type="button" class="btn btn-secondary btn-sm" data-action="view" data-uid="${s.studentUid}" data-name="${s.studentName || ""}">View photos</button>
                  </div>
                </div>`)}</div>`
            : html`<p class="page-sub">Nobody has handed in yet.</p>`}
        </section>

        <section>
          ${missing.length ? html`
            <button type="button" class="link-btn" data-action="toggle-missing">${ui.showMissing ? "Hide" : "Show"} students who haven't handed in (${missing.length})</button>
            ${ui.showMissing ? html`
              <div class="list" style="margin-top:12px">${missing.map((s) => html`
                <button type="button" class="list-item" data-nav="staff-student" data-nav-params="${paramsOf({ uid: s.uid })}">
                  <div class="list-item-main">
                    <p class="list-item-title" dir="auto">${s.name}</p>
                    <p class="list-item-sub">Mobile <span class="num" dir="ltr">${s.mobile}</span> · Parent <span class="num" dir="ltr">${s.parentMobile}</span></p>
                  </div>
                  ${icon("chevron-right", { size: 18 })}
                </button>`)}</div>` : ""}`
          : html`<p class="page-sub">Every student in this class has handed in.</p>`}
        </section>
      </div>`);
  }

  function paint() {
    if (ui.view === "detail") paintDetail(); else paintList();
  }

  /* ---------- create / edit ---------- */
  function openFormModal(existing) {
    const hw = existing || { title: "", lesson: "", due: defaultDue(), assignedGrade: "", subject: "" };
    const option = (value, label, selected) => html`<option value="${value}" ${selected ? "selected" : ""}>${label}</option>`;

    openModal({
      title: existing ? "Edit homework" : "New homework",
      content: html`
        <form id="hw-form" class="form" novalidate>
          <div class="field"><label for="hw-title">Title</label>
            <input id="hw-title" name="title" type="text" dir="auto" value="${hw.title}" required></div>
          <div class="field"><label for="hw-lesson">Lesson</label>
            <input id="hw-lesson" name="lesson" type="text" dir="auto" value="${hw.lesson}" required></div>
          <div class="field"><label for="hw-due">Due</label>
            <input id="hw-due" name="due" type="datetime-local" value="${toDateTimeLocalValue(hw.due)}" required></div>
          <div class="field-row">
            <div class="field"><label for="hw-grade">Grade</label>
              <select id="hw-grade" name="assignedGrade">
                ${option("", "All grades", !hw.assignedGrade)}
                ${GRADES.map((g) => option(g, g, g === hw.assignedGrade))}
              </select></div>
            <div class="field"><label for="hw-subject">Subject</label>
              <select id="hw-subject" name="subject">
                ${option("", "All subjects", !hw.subject)}
                ${SUBJECTS.map((s) => option(s, s, s === hw.subject))}
              </select></div>
          </div>
          <p class="form-error" id="hw-form-error" role="alert" hidden></p>
        </form>`,
      actions: [
        { label: "Cancel", variant: "secondary", value: false },
        {
          label: existing ? "Save changes" : "Create homework",
          variant: "primary",
          closes: false,
          onClick: async (api) => {
            const form = api.root.querySelector("#hw-form");
            const errorBox = api.root.querySelector("#hw-form-error");
            clearFormError(errorBox);
            const values = readForm(form);
            api.setBusy(true);
            try {
              await homeworkService.saveDef({
                id: existing ? existing.id : undefined,
                title: values.title,
                lesson: values.lesson,
                due: fromDateTimeLocalValue(values.due),
                assignedGrade: values.assignedGrade || null,
                subject: values.subject || null
              });
              api.close(true);
              toast(existing ? "Homework updated." : "Homework created.", { type: "success" });
              await loadDefs();
              if (ui.view === "detail") await loadDetail(defs.find((h) => h.id === ui.id) || hw);
              paint();
            } catch (err) {
              showFormError(errorBox, err && err.message ? err.message : "Couldn't save. Please try again.");
              api.setBusy(false);
            }
          }
        }
      ]
    });
  }

  /* ---------- go ---------- */
  setHtml(container, loadingRows(3));
  try {
    await loadDefs();
    paintList();
  } catch (err) {
    showLoadError(container, "Homework", err);
    return undefined;
  }

  const stop = delegate(container, "click", "[data-action]", async (event, el) => {
    const action = el.dataset.action;
    const hw = defs.find((h) => h.id === el.dataset.id);

    if (action === "new") openFormModal(null);

    if (action === "open" && hw) {
      await withBusy(el, async () => {
        try {
          await loadDetail(hw);
          ui.view = "detail"; ui.id = hw.id; ui.showMissing = false;
          paint();
        } catch (err) { fail(err); }
      });
    }

    if (action === "back") { ui.view = "list"; ui.id = null; detail = null; paint(); }
    if (action === "toggle-missing") { ui.showMissing = !ui.showMissing; paint(); }
    if (action === "edit" && hw) openFormModal(hw);

    if (action === "delete" && hw) {
      const ok = await confirmDialog({
        title: `Delete ${hw.title}?`,
        message: "The homework disappears from your students' lists. Photos they already handed in stay saved.",
        confirmLabel: "Delete",
        danger: true
      });
      if (!ok) return;
      try {
        await homeworkService.removeDef(hw.id);
        toast("Homework deleted.");
        ui.view = "list"; ui.id = null; detail = null;
        await loadDefs();
        paint();
      } catch (err) { fail(err); }
    }

    if (action === "view") {
      await withBusy(el, async () => {
        try {
          const current = defs.find((h) => h.id === ui.id);
          const images = await homeworkService.getImages(el.dataset.uid, ui.id);
          if (!images.length) { toast("No photos were found.", { type: "error" }); return; }
          showImages(`${el.dataset.name || "Student"} · ${current ? current.title : "Homework"}`, images);
        } catch (err) { fail(err); }
      });
    }
  });

  return stop;
}