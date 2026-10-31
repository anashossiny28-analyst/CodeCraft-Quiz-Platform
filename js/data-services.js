/* ============================================================================
   CODE CRAFT — QUIZ PLATFORM
   js/data-services.js

   The ONLY place (besides auth.js) that talks to Firestore.
   UI modules call these services and never import Firestore directly.

     studentService   accounts: approve / reject / edit / block / ban
     examService      exams (public part) + answer keys (separate, protected)
     attemptService   taking an exam, saving answers, submitting, grading
     homeworkService  homework definitions + Base64 image submissions
     lessonService    lessons (staff) + each student's personal notebook
     sheetService     Model Answer Sheets (staff-published, read-only for students)
     rankingService   published ranking snapshots (computed by staff, read by all)
     resultService    pure helpers: scoring, averages, attendance, statistics

   Conventions
     • Every failure is a DataError (stable `code` + English `message`).
     • Writes never await-block the exam UI: while offline Firestore queues them,
       so exam code should fire answer-saving calls without `await`
       (and add .catch(console.warn)).
     • Dates: pass JS Date / milliseconds in, get Firestore Timestamps out.
       Use toMillis() to read them.
   ============================================================================ */

import {
  collection,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  onSnapshot,
  serverTimestamp,
  Timestamp,
  writeBatch,
  runTransaction,
  increment,
  getCountFromServer
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

import { db, COLLECTIONS, ROLES, ACCOUNT_STATUS, GRADES, SUBJECTS } from "./firebase-config.js";
import { getCurrentProfile, normalizeMobile, isValidMobile, isValidEmailFormat } from "./auth.js";

/* ============================================================================
   1. ERRORS
   ============================================================================ */

const MESSAGES = {
  "not-found": "We couldn't find what you were looking for.",
  "permission-denied": "You don't have permission to do that.",
  "network": "No internet connection. Please try again.",
  "invalid-data": "Some of the information is not valid.",
  "phone-taken": "This mobile number is already registered.",
  "banned-restricted": "Only an admin can change a banned account.",
  "already-attempted": "You have already taken this exam.",
  "exam-not-open": "This exam is not open right now.",
  "exam-locked": "Students have already taken this exam, so its questions and duration can't be changed.",
  "exam-has-attempts": "This exam already has student attempts and can't be deleted.",
  "grading-claimed": "Another staff member is grading this exam right now.",
  "grading-incomplete": "Please grade every essay question first.",
  "already-submitted": "This has already been submitted.",
  "unknown": "Something went wrong. Please try again."
};

export class DataError extends Error {
  constructor(code, message, details) {
    super(message || MESSAGES[code] || MESSAGES.unknown);
    this.name = "DataError";
    this.code = code;
    this.details = details || [];
  }
}

function mapError(err) {
  if (err instanceof DataError) return err;
  switch (err && err.code) {
    case "permission-denied": return new DataError("permission-denied");
    case "unavailable": return new DataError("network");
    case "not-found": return new DataError("not-found");
    default:
      // A missing composite index shows up here, with a clickable link in the message.
      console.error("[data-services] Unexpected error:", err);
      return new DataError("unknown");
  }
}

async function run(fn) {
  try {
    return await fn();
  } catch (err) {
    throw mapError(err);
  }
}

/* ============================================================================
   2. SMALL HELPERS
   ============================================================================ */

/* Collections added after the first data-model draft live here, so
   firebase-config.js doesn't need to change. */
const C = Object.freeze({
  ...COLLECTIONS,
  EXAM_KEYS: "examKeys",
  MODEL_ANSWER_SHEETS: "modelAnswerSheets",
  RANKINGS: "rankings"
});

const colRef = (name) => collection(db, name);
const docRef = (name, id) => doc(db, name, id);

/** Firestore rejects `undefined` values — strip them. (null is fine.) */
function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

const withId = (snap) => ({ id: snap.id, ...snap.data() });
const listOf = (querySnap) => querySnap.docs.map(withId);

export function toMillis(value) {
  if (value == null) return null;
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toMillis === "function") return value.toMillis();
  return null;
}

export function toTimestamp(value) {
  const ms = toMillis(value);
  return ms == null ? null : Timestamp.fromMillis(ms);
}

/** Readable unique id without dots (dots would break Firestore field paths). */
export function newId(prefix = "id") {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function shuffle(items) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    const j = buf[0] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const round1 = (n) => Math.round(n * 10) / 10;

function actorInfo(actor) {
  const a = actor || getCurrentProfile();
  if (!a) throw new DataError("permission-denied");
  return { uid: a.uid, name: a.name };
}

/* ----------------------------------------------------------------------------
   Server clock
   An exam timer must not depend on the student's device clock. After the
   attempt is created we ask Firestore for the server time once and remember the
   difference. serverNow() = device time + that difference.
   ---------------------------------------------------------------------------- */
let serverOffsetMs = 0;

export function serverNow() {
  return Date.now() + serverOffsetMs;
}

async function syncServerClock(attemptRef) {
  const before = Date.now();
  await updateDoc(attemptRef, { lastSeenAt: serverTimestamp() });
  const snap = await getDocFromServer(attemptRef);
  const after = Date.now();
  const serverMs = toMillis(snap.data().lastSeenAt);
  if (serverMs) serverOffsetMs = serverMs - Math.round((before + after) / 2);
}

/* ============================================================================
   3. RESULT HELPERS  (pure functions — no Firestore)
   ============================================================================ */

export const GRADING_CLAIM_TTL_MS = 60 * 60 * 1000; // a claim expires after 1 hour

export const resultService = {
  /** 85.4 (one decimal). */
  percentOf(score, total) {
    return total > 0 ? round1((score / total) * 100) : 0;
  },

  messageForPercentage(pct) {
    if (pct >= 90) return "Outstanding! You crushed it! 🔥";
    if (pct >= 85) return "Great Job! Keep pushing! 💪";
    if (pct >= 50) return "Good effort! Keep learning and improving. 🚀";
    return "Don't give up. Learn from it and come back stronger! 💙";
  },

  /** MCQ score using the exam's public questions + its answer key. */
  scoreMcq(exam, key, answers = {}) {
    let score = 0, total = 0, correct = 0, wrong = 0, unanswered = 0;
    for (const q of exam.questions || []) {
      if (q.type !== "mcq") continue;
      const points = q.points || 1;
      total += points;
      const given = answers[q.id];
      if (given === undefined || given === null) { unanswered++; continue; }
      if (given === (key.answers || {})[q.id]) { correct++; score += points; } else { wrong++; }
    }
    return { score, total, correct, wrong, unanswered };
  },

  /** Is somebody actively grading this attempt right now? */
  isGradingClaimActive(attempt, nowMs = Date.now()) {
    if (!attempt.gradingBy) return false;
    const started = toMillis(attempt.gradingStartedAt);
    if (started == null) return true; // timestamp still being written
    return nowMs - started < GRADING_CLAIM_TTL_MS;
  },

  /** Progress of grading for one exam, from all of its attempts. */
  examGradingProgress(attempts) {
    const submitted = attempts.filter((a) => a.status !== "IN_PROGRESS");
    const graded = submitted.filter((a) => a.status === "COMPLETED");
    return {
      total: attempts.length,
      inProgress: attempts.length - submitted.length,
      submitted: submitted.length,
      graded: graded.length,
      pending: submitted.length - graded.length,
      allGraded: attempts.length > 0 && attempts.every((a) => a.status === "COMPLETED")
    };
  },

  /** A student's own numbers (his own flagged attempts still count for him). */
  summarizeStudent(attempts) {
    const submitted = attempts.filter((a) => a.status !== "IN_PROGRESS");
    const completed = submitted.filter((a) => a.status === "COMPLETED" && typeof a.percentage === "number");
    const average = completed.length
      ? round1(completed.reduce((sum, a) => sum + a.percentage, 0) / completed.length)
      : null;
    const newestFirst = [...submitted].sort((a, b) => (toMillis(b.submittedAt) || 0) - (toMillis(a.submittedAt) || 0));
    return {
      examsTaken: submitted.length,
      completedCount: completed.length,
      pendingCount: submitted.length - completed.length,
      average,
      lastAttempt: newestFirst[0] || null
    };
  },

  /**
   * Attendance = exams the student took ÷ exams that have already closed for
   * his grade + subject (only exams that closed after he joined).
   * A student counts as present from the moment he starts/submits — grading
   * status doesn't matter. Missing an exam permanently lowers the percentage.
   */
  computeAttendance(student, exams, attempts, nowMs = serverNow()) {
    const joined = toMillis(student.createdAt) || 0;
    const due = exams.filter((e) => {
      const end = toMillis(e.endAt);
      return e.status === "published" &&
        e.assignedGrade === student.grade &&
        e.subject === student.subject &&
        end && end < nowMs && end >= joined;
    });
    const tookIds = new Set(attempts.map((a) => a.examId));
    const missed = due.filter((e) => !tookIds.has(e.id));
    const attended = due.length - missed.length;
    return {
      attended,
      total: due.length,
      percentage: due.length ? Math.round((attended / due.length) * 100) : 100,
      missed
    };
  },

  /** Per-question statistics for a closed exam ("Question 7: 80% got it wrong"). */
  computeQuestionStats(exam, key, attempts) {
    const submitted = attempts.filter((a) => a.status !== "IN_PROGRESS");
    const n = submitted.length;

    return (exam.questions || []).map((q) => {
      if (q.type === "mcq") {
        const optionCounts = new Array(q.options.length).fill(0);
        let correct = 0, unanswered = 0;
        for (const a of submitted) {
          const given = (a.mcqAnswers || {})[q.id];
          if (given === undefined || given === null) { unanswered++; continue; }
          optionCounts[given] = (optionCounts[given] || 0) + 1;
          if (given === (key.answers || {})[q.id]) correct++;
        }
        return {
          id: q.id, type: "mcq", text: q.text, attempts: n,
          correct, incorrect: n - correct, unanswered, optionCounts,
          incorrectPercent: n ? round1(((n - correct) / n) * 100) : 0
        };
      }

      const scored = submitted
        .map((a) => (a.essayAnswers || {})[q.id])
        .filter((ans) => ans && typeof ans.pointsAwarded === "number");
      const averagePercent = scored.length
        ? round1((scored.reduce((s, ans) => s + ans.pointsAwarded / q.points, 0) / scored.length) * 100)
        : null;
      return { id: q.id, type: "essay", text: q.text, attempts: n, gradedCount: scored.length, averagePercent };
    });
  }
};

/* ============================================================================
   4. STUDENT SERVICE  (staff screens)
   ============================================================================ */

const EDITABLE_STUDENT_FIELDS = ["name", "mobile", "parentMobile", "gender", "grade", "subject", "email"];

export const studentService = {
  async get(uid) {
    return run(async () => {
      const snap = await getDoc(docRef(C.USERS, uid));
      return snap.exists() ? { uid: snap.id, ...snap.data() } : null;
    });
  },

  /** @param {{status?: string, grade?: string, subject?: string}} filters */
  async listAll(filters = {}) {
    return run(async () => {
      const constraints = [where("role", "==", ROLES.STUDENT)];
      if (filters.status) constraints.push(where("accountStatus", "==", filters.status));
      if (filters.grade) constraints.push(where("grade", "==", filters.grade));
      if (filters.subject) constraints.push(where("subject", "==", filters.subject));
      const snap = await getDocs(query(colRef(C.USERS), ...constraints));
      return snap.docs
        .map((d) => ({ uid: d.id, ...d.data() }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    });
  },

  listPending() {
    return this.listAll({ status: ACCOUNT_STATUS.PENDING });
  },

  async approve(uid, actor) {
    return run(async () => {
      const by = actorInfo(actor);
      await updateDoc(docRef(C.USERS, uid), {
        accountStatus: ACCOUNT_STATUS.ACTIVE,
        approvedBy: by,
        approvedAt: serverTimestamp()
      });
    });
  },

  /** Removes a pending request completely (profile + phone lock), so the
   *  student can register again with the same number. */
  async reject(uid) {
    return run(async () => {
      const snap = await getDoc(docRef(C.USERS, uid));
      if (!snap.exists()) throw new DataError("not-found");
      const student = snap.data();
      if (student.accountStatus !== ACCOUNT_STATUS.PENDING) {
        throw new DataError("invalid-data", "Only pending requests can be rejected.");
      }
      const batch = writeBatch(db);
      batch.delete(docRef(C.USERS, uid));
      if (student.mobile) batch.delete(docRef(C.PHONE_INDEX, student.mobile));
      await batch.commit();
    });
  },

  /** Staff edit of a student's registration data (the student can't edit his own). */
  async updateProfile(uid, changes) {
    return run(async () => {
      const snap = await getDoc(docRef(C.USERS, uid));
      if (!snap.exists()) throw new DataError("not-found");
      const current = snap.data();

      const next = {};
      for (const field of EDITABLE_STUDENT_FIELDS) {
        if (changes[field] !== undefined) next[field] = changes[field];
      }
      if (next.name !== undefined) {
        next.name = String(next.name).trim().replace(/\s+/g, " ");
        if (next.name.split(" ").length < 2) throw new DataError("invalid-data", "Please enter the full name.");
      }
      if (next.mobile !== undefined) next.mobile = normalizeMobile(next.mobile);
      if (next.parentMobile !== undefined) next.parentMobile = normalizeMobile(next.parentMobile);
      if (next.email !== undefined) {
        next.email = String(next.email).trim();
        if (next.email && !isValidEmailFormat(next.email)) throw new DataError("invalid-data", "Please enter a valid email address.");
      }
      if (next.grade !== undefined && !GRADES.includes(next.grade)) throw new DataError("invalid-data", "Invalid grade.");
      if (next.subject !== undefined && !SUBJECTS.includes(next.subject)) throw new DataError("invalid-data", "Invalid subject.");

      const finalMobile = next.mobile ?? current.mobile;
      const finalParent = next.parentMobile ?? current.parentMobile;
      if (next.mobile !== undefined && !isValidMobile(next.mobile)) throw new DataError("invalid-data", "Invalid mobile number.");
      if (next.parentMobile !== undefined && !isValidMobile(next.parentMobile)) throw new DataError("invalid-data", "Invalid parent mobile number.");
      if (finalMobile === finalParent) throw new DataError("invalid-data", "The student's number and the parent's number must be different.");

      const by = actorInfo();
      const patch = { ...next, editedBy: by, editedAt: serverTimestamp() };

      // Changing the student's own number must move the phone lock atomically.
      if (next.mobile !== undefined && next.mobile !== current.mobile) {
        const batch = writeBatch(db);
        batch.set(docRef(C.PHONE_INDEX, next.mobile), { ownerUid: uid, createdAt: serverTimestamp() });
        if (current.mobile) batch.delete(docRef(C.PHONE_INDEX, current.mobile));
        batch.update(docRef(C.USERS, uid), patch);
        try {
          await batch.commit();
        } catch (err) {
          if (err && err.code === "permission-denied") throw new DataError("phone-taken");
          throw err;
        }
      } else {
        await updateDoc(docRef(C.USERS, uid), patch);
      }
    });
  },

  /**
   * Block / unblock / ban. Banning (and un-banning) is admin-only.
   * @param {"active"|"blocked"|"banned"} status
   */
  async setStatus(uid, status, { note = "" } = {}) {
    return run(async () => {
      if (![ACCOUNT_STATUS.ACTIVE, ACCOUNT_STATUS.BLOCKED, ACCOUNT_STATUS.BANNED].includes(status)) {
        throw new DataError("invalid-data");
      }
      const me = getCurrentProfile();
      const snap = await getDoc(docRef(C.USERS, uid));
      if (!snap.exists()) throw new DataError("not-found");

      const touchesBan = status === ACCOUNT_STATUS.BANNED || snap.data().accountStatus === ACCOUNT_STATUS.BANNED;
      if (touchesBan && (!me || me.role !== ROLES.ADMIN)) throw new DataError("banned-restricted");

      await updateDoc(docRef(C.USERS, uid), {
        accountStatus: status,
        statusNote: String(note).trim(),
        statusChangedBy: actorInfo(),
        statusChangedAt: serverTimestamp()
      });
    });
  }
};

/* ============================================================================
   5. EXAM SERVICE

   An exam is stored in TWO documents so students can't read the answers
   while taking it:

     exams/{id}      public: title, times, questions WITHOUT correct answers
     examKeys/{id}   correct answers + explanations. Staff always; a student only
                     after his own attempt has been submitted (see the rules).

   The Exam Builder works with "authored" questions that hold everything:
     MCQ:   { id?, type:"mcq", text, points?, correctAnswer, options:[{text, explanation?}] }
     Essay: { id?, type:"essay", text, points }
   examService.save() splits them; examService.getForEdit() merges them back.
   `duration` is in SECONDS.
   ============================================================================ */

export function examPhase(exam, nowMs = serverNow()) {
  const start = toMillis(exam.startAt);
  const end = toMillis(exam.endAt);
  if (start && nowMs < start) return "upcoming";
  if (end && nowMs > end) return "closed";
  return "open";
}

function normalizeAuthored(q) {
  const type = q.type === "essay" ? "essay" : "mcq";
  const base = {
    id: q.id || newId("q"),
    type,
    text: String(q.text || "").trim(),
    points: Number(q.points) || 1
  };
  if (type === "essay") return base;

  const options = (q.options || []).map((o) =>
    typeof o === "string"
      ? { text: o.trim(), explanation: "" }
      : { text: String(o.text || "").trim(), explanation: String(o.explanation || "").trim() }
  );
  return {
    ...base,
    options,
    correctAnswer: Number.isInteger(q.correctAnswer) ? q.correctAnswer : -1,
    hasExplanations: options.some((o) => o.explanation)
  };
}

function splitQuestions(authored) {
  const key = { answers: {}, explanations: {} };
  const publicQuestions = authored.map((q) => {
    if (q.type === "essay") return q;
    key.answers[q.id] = q.correctAnswer;
    if (q.hasExplanations) key.explanations[q.id] = q.options.map((o) => o.explanation);
    return {
      id: q.id,
      type: "mcq",
      text: q.text,
      points: q.points,
      hasExplanations: q.hasExplanations,
      options: q.options.map((o) => ({ text: o.text }))
    };
  });
  return { publicQuestions, key };
}

function mergeKey(publicQuestions, key) {
  return publicQuestions.map((q) => {
    if (q.type === "essay") return q;
    const explanations = (key.explanations || {})[q.id] || [];
    return {
      ...q,
      correctAnswer: (key.answers || {})[q.id] ?? -1,
      options: q.options.map((o, i) => ({ text: o.text, explanation: explanations[i] || "" }))
    };
  });
}

export function computeExamTotals(authoredOrPublic) {
  let mcqCount = 0, essayCount = 0, mcqPoints = 0, essayPoints = 0;
  for (const q of authoredOrPublic) {
    const points = Number(q.points) || 1;
    if (q.type === "essay") { essayCount++; essayPoints += points; }
    else { mcqCount++; mcqPoints += points; }
  }
  return {
    questionCount: mcqCount + essayCount,
    mcqCount, essayCount, mcqPoints, essayPoints,
    totalPoints: mcqPoints + essayPoints
  };
}

/** Returns a list of human-readable problems (empty list = valid). */
export function validateExam(exam, { forPublish = false } = {}) {
  const errors = [];
  if (!String(exam.title || "").trim()) errors.push("Exam title is required.");
  if (!SUBJECTS.includes(exam.subject)) errors.push("Choose a subject.");
  if (!GRADES.includes(exam.assignedGrade)) errors.push("Choose a grade.");

  if (forPublish) {
    if (!(Number(exam.duration) > 0)) errors.push("Duration must be greater than zero.");
    const start = toMillis(exam.startAt);
    const end = toMillis(exam.endAt);
    if (!start || !end) errors.push("Set when the exam opens and when it closes.");
    else if (end <= start) errors.push("The closing time must be after the opening time.");
    if (!(exam.questions && exam.questions.length)) errors.push("Add at least one question.");
  }

  (exam.questions || []).forEach((raw, i) => {
    const q = normalizeAuthored(raw);
    const n = i + 1;
    if (!q.text) errors.push(`Question ${n}: write the question text.`);
    if (!(q.points > 0) || (q.points * 2) % 1 !== 0) errors.push(`Question ${n}: points must be a positive multiple of 0.5.`);
    if (q.type === "mcq") {
      if (q.options.length < 2 || q.options.some((o) => !o.text)) errors.push(`Question ${n}: fill in at least two options, none empty.`);
      if (q.correctAnswer < 0 || q.correctAnswer >= q.options.length) errors.push(`Question ${n}: mark the correct option.`);
    }
  });
  return errors;
}

async function countAttempts(examId) {
  const snap = await getCountFromServer(query(colRef(C.ATTEMPTS), where("examId", "==", examId)));
  return snap.data().count;
}

export const examService = {
  async get(examId) {
    return run(async () => {
      const snap = await getDoc(docRef(C.EXAMS, examId));
      return snap.exists() ? withId(snap) : null;
    });
  },

  /** Answer key + explanations. Allowed for staff, or for a student after submitting. */
  async getKey(examId) {
    return run(async () => {
      const snap = await getDoc(docRef(C.EXAM_KEYS, examId));
      return snap.exists() ? snap.data() : { answers: {}, explanations: {} };
    });
  },

  /** Full authored exam (questions with correct answers) for the Exam Builder. */
  async getForEdit(examId) {
    const [exam, key] = await Promise.all([this.get(examId), this.getKey(examId)]);
    if (!exam) throw new DataError("not-found");
    return { ...exam, questions: mergeKey(exam.questions || [], key) };
  },

  /** Published exams for this student's grade + subject, newest first. */
  async listForStudent(student) {
    return run(async () => {
      const snap = await getDocs(query(
        colRef(C.EXAMS),
        where("status", "==", "published"),
        where("assignedGrade", "==", student.grade),
        where("subject", "==", student.subject)
      ));
      return listOf(snap).sort((a, b) => (toMillis(b.startAt) || 0) - (toMillis(a.startAt) || 0));
    });
  },

  /** Staff: every exam, drafts included, newest first. */
  async listAll() {
    return run(async () => {
      const snap = await getDocs(colRef(C.EXAMS));
      return listOf(snap).sort((a, b) => (toMillis(b.createdAt) || 0) - (toMillis(a.createdAt) || 0));
    });
  },

  /**
   * Creates (no exam.id) or updates (exam.id) an exam together with its key.
   * status "draft" saves a work in progress; "published" validates everything.
   * @returns {Promise<string>} the exam id
   */
  async save(exam) {
    return run(async () => {
      const by = actorInfo();
      const wantsPublish = exam.status === "published";

      const errors = validateExam(exam, { forPublish: wantsPublish });
      if (errors.length) throw new DataError("invalid-data", errors[0], errors);

      const authored = (exam.questions || []).map(normalizeAuthored);
      const { publicQuestions, key } = splitQuestions(authored);
      const duration = Number(exam.duration) || 0;
      const examRef = exam.id ? docRef(C.EXAMS, exam.id) : doc(colRef(C.EXAMS));

      // Once students have taken it, its questions and duration are frozen.
      if (exam.id) {
        const existing = await getDoc(examRef);
        if (!existing.exists()) throw new DataError("not-found");
        const old = existing.data();
        if (old.status === "published" && (await countAttempts(exam.id)) > 0) {
          if (stable(old.questions) !== stable(publicQuestions) || old.duration !== duration) {
            throw new DataError("exam-locked");
          }
        }
      }

      const payload = clean({
        title: String(exam.title).trim(),
        subject: exam.subject,
        assignedGrade: exam.assignedGrade,
        startAt: toTimestamp(exam.startAt),
        endAt: toTimestamp(exam.endAt),
        duration,
        status: wantsPublish ? "published" : "draft",
        questions: publicQuestions,
        ...computeExamTotals(authored),
        updatedAt: serverTimestamp(),
        updatedBy: by
      });

      const batch = writeBatch(db);
      if (exam.id) {
        batch.update(examRef, payload);
      } else {
        batch.set(examRef, { ...payload, createdBy: by.uid, createdByName: by.name, createdAt: serverTimestamp() });
      }
      batch.set(docRef(C.EXAM_KEYS, examRef.id), {
        answers: key.answers,
        explanations: key.explanations,
        updatedAt: serverTimestamp()
      });
      await batch.commit();
      return examRef.id;
    });
  },

  /** Turns a saved draft into a published exam (validates first). */
  async publish(examId) {
    const exam = await this.getForEdit(examId);
    return this.save({ ...exam, status: "published" });
  },

  /** Copy of an exam as a new draft — set new open/close times, then publish. */
  async duplicate(examId) {
    const exam = await this.getForEdit(examId);
    return this.save({
      ...exam,
      id: undefined,
      title: `${exam.title} (Copy)`,
      status: "draft",
      startAt: null,
      endAt: null
    });
  },

  async remove(examId) {
    return run(async () => {
      if ((await countAttempts(examId)) > 0) throw new DataError("exam-has-attempts");
      const batch = writeBatch(db);
      batch.delete(docRef(C.EXAMS, examId));
      batch.delete(docRef(C.EXAM_KEYS, examId));
      batch.delete(docRef(C.RANKINGS, examId));
      await batch.commit();
    });
  },

  /** Staff: who took the exam and who didn't (students of its grade + subject). */
  async getAttendance(exam) {
    const [students, attempts] = await Promise.all([
      studentService.listAll({ status: ACCOUNT_STATUS.ACTIVE, grade: exam.assignedGrade, subject: exam.subject }),
      attemptService.listForExam(exam.id)
    ]);
    const byUid = new Map(attempts.map((a) => [a.studentUid, a]));
    return {
      attended: students.filter((s) => byUid.has(s.uid)).map((s) => ({ student: s, attempt: byUid.get(s.uid) })),
      absent: students.filter((s) => !byUid.has(s.uid))
    };
  }
};

/* ============================================================================
   6. ATTEMPT SERVICE

   Attempt document id:  {studentUid}_{examId}   → one attempt per student per exam.

   Status flow
     IN_PROGRESS      student is answering
     SUBMITTED        answers locked; MCQ score not computed yet (short, transitional)
     PENDING_GRADING  MCQ scored; essay answers wait for staff
     COMPLETED        everything scored (also used directly when an exam has no essays)
   ============================================================================ */

export const attemptId = (studentUid, examId) => `${studentUid}_${examId}`;

export function attemptRemainingSeconds(attempt, exam, nowMs = serverNow()) {
  const started = toMillis(attempt.startedAt);
  if (!started) return exam.duration;
  return Math.max(0, Math.ceil((started + exam.duration * 1000 - nowMs) / 1000));
}

/** Random order for this student: MCQs shuffled, then essays shuffled (MCQs always first). */
function buildQuestionOrder(questions) {
  const mcqIds = questions.filter((q) => q.type === "mcq").map((q) => q.id);
  const essayIds = questions.filter((q) => q.type === "essay").map((q) => q.id);
  return [...shuffle(mcqIds), ...shuffle(essayIds)];
}

export const attemptService = {
  /* ---------------------------- student: taking the exam ---------------------------- */

  /**
   * Starts the exam, or resumes it if an unfinished attempt exists.
   * @returns {Promise<{attempt: object, resumed: boolean}>}
   * The Security Rules also enforce: published, grade + subject match, and
   * server time inside [startAt, endAt].
   */
  async start(student, exam) {
    return run(async () => {
      if (examPhase(exam) !== "open") throw new DataError("exam-not-open");

      const aRef = docRef(C.ATTEMPTS, attemptId(student.uid, exam.id));
      const existing = await getDocFromServer(aRef);

      if (existing.exists()) {
        const attempt = withId(existing);
        if (attempt.status !== "IN_PROGRESS") throw new DataError("already-attempted");
        await syncServerClock(aRef);
        return { attempt: withId(await getDocFromServer(aRef)), resumed: true };
      }

      await setDoc(aRef, {
        studentUid: student.uid,
        studentLoginId: student.loginId,
        studentName: student.name,
        grade: student.grade,
        subject: student.subject,
        examId: exam.id,
        examTitle: exam.title,
        status: "IN_PROGRESS",
        startedAt: serverTimestamp(),
        lastSeenAt: serverTimestamp(),
        questionOrder: buildQuestionOrder(exam.questions),
        currentIndex: 0,
        mcqAnswers: {},
        essayAnswers: {},
        marked: [],
        tabSwitchCount: 0,
        excludedFromRanking: false,
        viewedByStudent: false
      });
      await syncServerClock(aRef);
      return { attempt: withId(await getDocFromServer(aRef)), resumed: false };
    });
  },

  /** Re-syncs the server clock (call after resuming an exam). */
  async syncClock(attemptIdValue) {
    return run(() => syncServerClock(docRef(C.ATTEMPTS, attemptIdValue)));
  },

  /* Saving progress. Don't `await` these in the exam UI — offline they queue. */
  saveMcqAnswer(attemptIdValue, questionId, optionIndex) {
    return updateDoc(docRef(C.ATTEMPTS, attemptIdValue), { [`mcqAnswers.${questionId}`]: optionIndex });
  },
  saveEssayAnswer(attemptIdValue, questionId, text) {
    return updateDoc(docRef(C.ATTEMPTS, attemptIdValue), { [`essayAnswers.${questionId}.text`]: text });
  },
  saveMarked(attemptIdValue, markedIds) {
    return updateDoc(docRef(C.ATTEMPTS, attemptIdValue), { marked: markedIds });
  },
  saveCurrentIndex(attemptIdValue, index) {
    return updateDoc(docRef(C.ATTEMPTS, attemptIdValue), { currentIndex: index });
  },
  recordTabSwitch(attemptIdValue) {
    return updateDoc(docRef(C.ATTEMPTS, attemptIdValue), { tabSwitchCount: increment(1) });
  },

  /**
   * Submits the exam in two steps:
   *   1. lock the answers (status SUBMITTED)         — works even right as the page closes
   *   2. read the answer key, score the MCQs         — needs a connection
   * If step 2 can't finish now, the attempt stays SUBMITTED and
   * finishScoring() completes it later (the app calls it on the next login).
   *
   * @param {object} attempt latest known state: { id, mcqAnswers, essayAnswers, marked }
   * @param {"manual"|"timeout"|"left-page"|"staff-forced"} reason
   */
  async submit(exam, attempt, { reason = "manual" } = {}) {
    return run(async () => {
      const aRef = docRef(C.ATTEMPTS, attempt.id);
      const essayQuestions = (exam.questions || []).filter((q) => q.type === "essay");
      const hasEssay = essayQuestions.length > 0;
      const finalTotal = computeExamTotals(exam.questions || []).totalPoints;

      const essayAnswers = {};
      for (const q of essayQuestions) {
        const previous = (attempt.essayAnswers || {})[q.id] || {};
        essayAnswers[q.id] = { text: previous.text || "", pointsAwarded: null, graderNote: "", gradedBy: null, gradedAt: null };
      }

      await updateDoc(aRef, {
        status: "SUBMITTED",
        mcqAnswers: attempt.mcqAnswers || {},
        essayAnswers,
        marked: attempt.marked || [],
        hasEssay,
        essayQuestionCount: essayQuestions.length,
        finalTotal,
        submitReason: reason,
        submittedAt: serverTimestamp()
      });

      const submitted = { ...attempt, status: "SUBMITTED", essayAnswers, hasEssay, essayQuestionCount: essayQuestions.length, finalTotal };
      try {
        return { scored: true, attempt: await this.finishScoring(exam, submitted) };
      } catch (err) {
        console.warn("[attempts] answers saved, scoring will finish later:", err);
        return { scored: false, attempt: submitted };
      }
    });
  },

  /** Step 2 of submitting: score the MCQs. Safe to call again (does nothing if already scored). */
  async finishScoring(exam, attempt) {
    return run(async () => {
      if (attempt.status !== "SUBMITTED") return attempt;

      const key = await examService.getKey(exam.id);
      const mcq = resultService.scoreMcq(exam, key, attempt.mcqAnswers || {});
      const hasEssay = !!attempt.hasEssay;
      const finalTotal = attempt.finalTotal ?? computeExamTotals(exam.questions || []).totalPoints;

      const patch = {
        status: hasEssay ? "PENDING_GRADING" : "COMPLETED",
        mcqScore: mcq.score,
        mcqTotal: mcq.total,
        finalScore: hasEssay ? null : mcq.score,
        percentage: hasEssay ? null : resultService.percentOf(mcq.score, finalTotal),
        viewedByStudent: !hasEssay // nothing waiting for him if there are no essays
      };
      await updateDoc(docRef(C.ATTEMPTS, attempt.id), patch);
      return { ...attempt, ...patch };
    });
  },

  /** Staff: submit an attempt the student never finished (closed the app, lost power...). */
  forceSubmit(exam, attempt) {
    return this.submit(exam, attempt, { reason: "staff-forced" });
  },

  /* ---------------------------- reading attempts ---------------------------- */

  async get(id) {
    return run(async () => {
      const snap = await getDoc(docRef(C.ATTEMPTS, id));
      return snap.exists() ? withId(snap) : null;
    });
  },

  async getMine(studentUid, examId) {
    return this.get(attemptId(studentUid, examId));
  },

  /** All attempts of one student (his own results, or staff viewing a student). */
  async listForStudent(studentUid) {
    return run(async () => {
      const snap = await getDocs(query(colRef(C.ATTEMPTS), where("studentUid", "==", studentUid)));
      return listOf(snap);
    });
  },

  /** Live updates of the student's attempts: Home, Results and the notification bell use this. */
  watchMine(studentUid, onChange, onError) {
    return onSnapshot(
      query(colRef(C.ATTEMPTS), where("studentUid", "==", studentUid)),
      (snap) => onChange(listOf(snap)),
      (err) => { if (onError) onError(mapError(err)); }
    );
  },

  /** Staff: every attempt of one exam. */
  async listForExam(examId) {
    return run(async () => {
      const snap = await getDocs(query(colRef(C.ATTEMPTS), where("examId", "==", examId)));
      return listOf(snap);
    });
  },

  /** Staff: everything waiting for essay grading. */
  async listPendingGrading() {
    return run(async () => {
      const snap = await getDocs(query(colRef(C.ATTEMPTS), where("status", "==", "PENDING_GRADING")));
      return listOf(snap);
    });
  },

  /** Staff: all finished attempts of one class (grade + subject) — used for overall ranking. */
  async listCompletedForGroup(grade, subject) {
    return run(async () => {
      const snap = await getDocs(query(
        colRef(C.ATTEMPTS),
        where("grade", "==", grade),
        where("subject", "==", subject),
        where("status", "==", "COMPLETED")
      ));
      return listOf(snap);
    });
  },

  /** Student opened the "your essay results are ready" notification. */
  async markViewed(id) {
    return run(() => updateDoc(docRef(C.ATTEMPTS, id), { viewedByStudent: true }));
  },

  /* ---------------------------- staff: grading ---------------------------- */

  /**
   * Marks the attempt as "Being graded" by this staff member, so nobody else
   * starts on it. Fails if someone else claimed it within the last hour.
   */
  async claimGrading(id, actor) {
    return run(async () => {
      const by = actorInfo(actor);
      const aRef = docRef(C.ATTEMPTS, id);
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(aRef);
        if (!snap.exists()) throw new DataError("not-found");
        const attempt = snap.data();
        if (attempt.gradingBy && attempt.gradingBy.uid !== by.uid && resultService.isGradingClaimActive(attempt)) {
          throw new DataError("grading-claimed", `${attempt.gradingBy.name} is grading this exam right now.`);
        }
        tx.update(aRef, { gradingBy: by, gradingStartedAt: serverTimestamp() });
      });
    });
  },

  async releaseGrading(id) {
    return run(() => updateDoc(docRef(C.ATTEMPTS, id), { gradingBy: null, gradingStartedAt: null }));
  },

  /** Saves the points + note for ONE essay question. maxPoints = that question's points. */
  async gradeEssay(id, questionId, { pointsAwarded, graderNote = "" }, maxPoints, actor) {
    return run(async () => {
      const by = actorInfo(actor);
      const points = Number(pointsAwarded);
      if (!Number.isFinite(points) || points < 0 || points > maxPoints || (points * 2) % 1 !== 0) {
        throw new DataError("invalid-data", `Points must be between 0 and ${maxPoints}, in steps of 0.5.`);
      }
      await updateDoc(docRef(C.ATTEMPTS, id), {
        [`essayAnswers.${questionId}.pointsAwarded`]: points,
        [`essayAnswers.${questionId}.graderNote`]: String(graderNote).trim(),
        [`essayAnswers.${questionId}.gradedBy`]: by,
        [`essayAnswers.${questionId}.gradedAt`]: serverTimestamp()
      });
    });
  },

  /**
   * Final step once every essay is graded: computes the final score (the MCQ part
   * is recomputed from the raw answers + key, so it's authoritative), marks the
   * attempt COMPLETED and triggers the student's notification.
   * Can be called again after a regrade.
   */
  async finalizeGrading(id, exam, actor) {
    return run(async () => {
      const by = actorInfo(actor);
      const aRef = docRef(C.ATTEMPTS, id);
      const kRef = docRef(C.EXAM_KEYS, exam.id);

      return runTransaction(db, async (tx) => {
        const [aSnap, kSnap] = await Promise.all([tx.get(aRef), tx.get(kRef)]);
        if (!aSnap.exists()) throw new DataError("not-found");
        const attempt = aSnap.data();
        const key = kSnap.exists() ? kSnap.data() : { answers: {} };

        const essayQuestions = (exam.questions || []).filter((q) => q.type === "essay");
        let essayScore = 0;
        for (const q of essayQuestions) {
          const answer = (attempt.essayAnswers || {})[q.id];
          if (!answer || typeof answer.pointsAwarded !== "number") throw new DataError("grading-incomplete");
          essayScore += answer.pointsAwarded;
        }

        const mcq = resultService.scoreMcq(exam, key, attempt.mcqAnswers || {});
        const finalTotal = attempt.finalTotal ?? computeExamTotals(exam.questions || []).totalPoints;
        const finalScore = mcq.score + essayScore;
        const percentage = resultService.percentOf(finalScore, finalTotal);

        tx.update(aRef, {
          status: "COMPLETED",
          mcqScore: mcq.score,
          mcqTotal: mcq.total,
          essayScore,
          finalScore,
          finalTotal,
          percentage,
          completedAt: serverTimestamp(),
          gradingFinishedBy: by,
          gradingBy: null,
          gradingStartedAt: null,
          viewedByStudent: false
        });
        return { finalScore, finalTotal, percentage, essayScore, mcqScore: mcq.score };
      });
    });
  },

  /**
   * Staff: re-derives the scores of a submitted attempt from the raw answers and
   * the answer key, and fixes the stored numbers if they differ.
   * Run this on every attempt right before publishing a ranking.
   */
  async recalculate(exam, key, attempt) {
    return run(async () => {
      if (attempt.status !== "PENDING_GRADING" && attempt.status !== "COMPLETED") return attempt;

      const mcq = resultService.scoreMcq(exam, key, attempt.mcqAnswers || {});
      const finalTotal = attempt.finalTotal ?? computeExamTotals(exam.questions || []).totalPoints;

      let finalScore = null;
      if (!attempt.hasEssay) {
        finalScore = mcq.score;
      } else if (attempt.status === "COMPLETED") {
        const essayScore = (exam.questions || [])
          .filter((q) => q.type === "essay")
          .reduce((sum, q) => sum + (((attempt.essayAnswers || {})[q.id] || {}).pointsAwarded || 0), 0);
        finalScore = mcq.score + essayScore;
      }
      const percentage = finalScore === null ? null : resultService.percentOf(finalScore, finalTotal);

      if (attempt.mcqScore === mcq.score && attempt.finalScore === finalScore && attempt.percentage === percentage) {
        return attempt;
      }
      const patch = { mcqScore: mcq.score, mcqTotal: mcq.total, finalScore, percentage, recalculatedAt: serverTimestamp() };
      await updateDoc(docRef(C.ATTEMPTS, attempt.id), patch);
      return { ...attempt, ...patch };
    });
  },

  /** Staff: remove (or restore) ONE attempt from the rankings, e.g. after catching cheating. */
  async setExcluded(id, excluded, reason = "", actor) {
    return run(async () => {
      const by = actorInfo(actor);
      await updateDoc(docRef(C.ATTEMPTS, id), {
        excludedFromRanking: !!excluded,
        excludedBy: excluded ? by : null,
        excludedAt: excluded ? serverTimestamp() : null,
        excludedReason: excluded ? String(reason).trim() : ""
      });
    });
  }
};

/* ============================================================================
   7. HOMEWORK SERVICE

   Images are stored as Base64 text inside Firestore (no paid Storage needed).
   One submission = 1 small "meta" document + 1 document per image:
       homeworkSubmissions/{uid}_{hwId}            kind: "meta"   (list screens read only these)
       homeworkSubmissions/{uid}_{hwId}_img1 ...   kind: "image"  (loaded only when viewing)
   Compress each image BEFORE calling submit() (homework.js does this).
   ============================================================================ */

export const MAX_HOMEWORK_IMAGES = 5;
export const MAX_IMAGE_BASE64_CHARS = 700000; // keeps every document safely under Firestore's 1 MiB limit

function matchesAudience(item, student) {
  if (item.assignedGrade && item.assignedGrade !== student.grade) return false;
  if (item.subject && item.subject !== student.subject) return false;
  return true;
}

export const homeworkService = {
  /** Homework visible to this student (or all homework when no student is given — staff). */
  async listDefs(student) {
    return run(async () => {
      const snap = await getDocs(colRef(C.HOMEWORK_DEFS));
      const all = listOf(snap).sort((a, b) => (toMillis(b.due) || 0) - (toMillis(a.due) || 0));
      return student ? all.filter((h) => matchesAudience(h, student)) : all;
    });
  },

  async saveDef(def) {
    return run(async () => {
      const title = String(def.title || "").trim();
      const lesson = String(def.lesson || "").trim();
      if (!title || !lesson || !toMillis(def.due)) {
        throw new DataError("invalid-data", "Title, lesson and due date are required.");
      }
      const payload = clean({
        title, lesson,
        due: toTimestamp(def.due),
        assignedGrade: def.assignedGrade || null,
        subject: def.subject || null,
        updatedAt: serverTimestamp()
      });
      if (def.id) {
        await updateDoc(docRef(C.HOMEWORK_DEFS, def.id), payload);
        return def.id;
      }
      const by = actorInfo();
      const created = await addDoc(colRef(C.HOMEWORK_DEFS), { ...payload, createdBy: by.uid, createdAt: serverTimestamp() });
      return created.id;
    });
  },

  async removeDef(homeworkId) {
    return run(() => deleteDoc(docRef(C.HOMEWORK_DEFS, homeworkId)));
  },

  /** A student's submissions (meta only — light). */
  async listMySubmissions(studentUid) {
    return run(async () => {
      const snap = await getDocs(query(
        colRef(C.HOMEWORK_SUBMISSIONS),
        where("studentUid", "==", studentUid),
        where("kind", "==", "meta")
      ));
      return listOf(snap);
    });
  },

  /** Staff: who submitted a given homework (meta only). */
  async listSubmissionsFor(homeworkId) {
    return run(async () => {
      const snap = await getDocs(query(
        colRef(C.HOMEWORK_SUBMISSIONS),
        where("homeworkId", "==", homeworkId),
        where("kind", "==", "meta")
      ));
      return listOf(snap).sort((a, b) => String(a.studentName).localeCompare(String(b.studentName)));
    });
  },

  /** The Base64 images of one submission, in the order they were added. */
  async getImages(studentUid, homeworkId) {
    return run(async () => {
      const snap = await getDocs(query(
        colRef(C.HOMEWORK_SUBMISSIONS),
        where("studentUid", "==", studentUid),
        where("homeworkId", "==", homeworkId),
        where("kind", "==", "image")
      ));
      return listOf(snap).sort((a, b) => a.index - b.index);
    });
  },

  /**
   * @param {{student: object, homework: object, images: {fileName: string, base64: string}[]}} input
   * One submission per student per homework (the rules reject a second one).
   */
  async submit({ student, homework, images }) {
    return run(async () => {
      if (!images || images.length === 0) throw new DataError("invalid-data", "Add at least one image.");
      if (images.length > MAX_HOMEWORK_IMAGES) {
        throw new DataError("invalid-data", `You can upload up to ${MAX_HOMEWORK_IMAGES} images.`);
      }
      if (images.some((img) => !img.base64 || img.base64.length > MAX_IMAGE_BASE64_CHARS)) {
        throw new DataError("invalid-data", "One of the images is too large. Please choose a smaller image.");
      }

      const baseId = `${student.uid}_${homework.id}`;
      const batch = writeBatch(db);
      batch.set(docRef(C.HOMEWORK_SUBMISSIONS, baseId), {
        kind: "meta",
        studentUid: student.uid,
        studentLoginId: student.loginId,
        studentName: student.name,
        homeworkId: homework.id,
        homeworkTitle: homework.title,
        imageCount: images.length,
        submittedAt: serverTimestamp()
      });
      images.forEach((img, i) => {
        batch.set(docRef(C.HOMEWORK_SUBMISSIONS, `${baseId}_img${i + 1}`), {
          kind: "image",
          studentUid: student.uid,
          homeworkId: homework.id,
          index: i + 1,
          fileName: String(img.fileName || `image-${i + 1}`),
          base64: img.base64,
          submittedAt: serverTimestamp()
        });
      });

      try {
        await batch.commit();
      } catch (err) {
        if (err && err.code === "permission-denied") throw new DataError("already-submitted");
        throw err;
      }
    });
  }
};

/* ============================================================================
   8. LESSON SERVICE
   Lessons are created by staff. Each student keeps his own notebook per lesson:
   a list of { question, modelAnswer } entries, auto-saved.
   ============================================================================ */

const MAX_NOTEBOOK_ENTRIES = 200;
const MAX_NOTE_LENGTH = 4000;

export const lessonService = {
  async list() {
    return run(async () => {
      const snap = await getDocs(colRef(C.LESSON_NOTES));
      return listOf(snap).sort((a, b) => (a.lessonNumber || 0) - (b.lessonNumber || 0));
    });
  },

  async save({ id, title, lessonNumber }) {
    return run(async () => {
      const cleanTitle = String(title || "").trim();
      const number = Number(lessonNumber);
      if (!cleanTitle || !Number.isInteger(number) || number < 1) {
        throw new DataError("invalid-data", "Lesson title and a lesson number are required.");
      }
      if (id) {
        await updateDoc(docRef(C.LESSON_NOTES, id), { title: cleanTitle, lessonNumber: number });
        return id;
      }
      const by = actorInfo();
      const created = await addDoc(colRef(C.LESSON_NOTES), {
        title: cleanTitle, lessonNumber: number, createdBy: by.uid, createdAt: serverTimestamp()
      });
      return created.id;
    });
  },

  async remove(lessonId) {
    return run(() => deleteDoc(docRef(C.LESSON_NOTES, lessonId)));
  },

  /** @returns {Promise<{question: string, modelAnswer: string, id: string, updatedAt: number}[]>} */
  async getMyEntries(studentUid, lessonId) {
    return run(async () => {
      const snap = await getDoc(docRef(C.STUDENT_LESSON_ANSWERS, `${studentUid}_${lessonId}`));
      return snap.exists() ? snap.data().entries || [] : [];
    });
  },

  /** Saves the whole list (call debounced while the student types). */
  async saveMyEntries(student, lessonId, entries) {
    return run(async () => {
      const cleaned = entries.slice(0, MAX_NOTEBOOK_ENTRIES).map((e) => ({
        id: e.id || newId("e"),
        question: String(e.question || "").slice(0, MAX_NOTE_LENGTH),
        modelAnswer: String(e.modelAnswer || "").slice(0, MAX_NOTE_LENGTH),
        // serverTimestamp() isn't allowed inside arrays, so entries carry a plain number
        updatedAt: Date.now()
      }));
      await setDoc(docRef(C.STUDENT_LESSON_ANSWERS, `${student.uid}_${lessonId}`), {
        studentUid: student.uid,
        lessonId,
        entries: cleaned,
        updatedAt: serverTimestamp()
      });
      return cleaned;
    });
  },

  /** { lessonId → number of entries } for the lesson cards. */
  async countMyEntries(studentUid) {
    return run(async () => {
      const snap = await getDocs(query(colRef(C.STUDENT_LESSON_ANSWERS), where("studentUid", "==", studentUid)));
      const counts = {};
      snap.docs.forEach((d) => { counts[d.data().lessonId] = (d.data().entries || []).length; });
      return counts;
    });
  }
};

/* ============================================================================
   9. MODEL ANSWER SHEETS
   Staff publish a titled list of { question, answer }. Students read them (read-only)
   in the Lessons page, separate from their own notebook.
   ============================================================================ */

export const sheetService = {
  async listForStudent(student) {
    return run(async () => {
      const snap = await getDocs(query(colRef(C.MODEL_ANSWER_SHEETS), where("status", "==", "published")));
      return listOf(snap)
        .filter((s) => matchesAudience(s, student))
        .sort((a, b) => (toMillis(b.publishedAt) || 0) - (toMillis(a.publishedAt) || 0));
    });
  },

  async listAll() {
    return run(async () => {
      const snap = await getDocs(colRef(C.MODEL_ANSWER_SHEETS));
      return listOf(snap).sort((a, b) => (toMillis(b.updatedAt) || 0) - (toMillis(a.updatedAt) || 0));
    });
  },

  async get(sheetId) {
    return run(async () => {
      const snap = await getDoc(docRef(C.MODEL_ANSWER_SHEETS, sheetId));
      return snap.exists() ? withId(snap) : null;
    });
  },

  /** Create (no id) or update. status "draft" | "published". */
  async save(sheet) {
    return run(async () => {
      const title = String(sheet.title || "").trim();
      const items = (sheet.items || [])
        .map((it) => ({
          id: it.id || newId("i"),
          question: String(it.question || "").trim(),
          answer: String(it.answer || "").trim()
        }))
        .filter((it) => it.question || it.answer);

      if (!title) throw new DataError("invalid-data", "Give the sheet a title.");
      const publishing = sheet.status === "published";
      if (publishing && items.length === 0) throw new DataError("invalid-data", "Add at least one question before publishing.");
      if (items.some((it) => !it.question || !it.answer)) {
        throw new DataError("invalid-data", "Every item needs both a question and an answer.");
      }

      const payload = clean({
        title,
        items,
        status: publishing ? "published" : "draft",
        assignedGrade: sheet.assignedGrade || null,
        subject: sheet.subject || null,
        updatedAt: serverTimestamp(),
        publishedAt: publishing ? serverTimestamp() : null
      });

      if (sheet.id) {
        await updateDoc(docRef(C.MODEL_ANSWER_SHEETS, sheet.id), payload);
        return sheet.id;
      }
      const by = actorInfo();
      const created = await addDoc(colRef(C.MODEL_ANSWER_SHEETS), {
        ...payload, createdBy: by.uid, createdByName: by.name, createdAt: serverTimestamp()
      });
      return created.id;
    });
  },

  async remove(sheetId) {
    return run(() => deleteDoc(docRef(C.MODEL_ANSWER_SHEETS, sheetId)));
  }
};

/* ============================================================================
   10. RANKING SERVICE

   Students can't read other students' attempts (privacy), so rankings are
   SNAPSHOTS: a staff member's browser computes them (ranking.js) once an exam is
   closed and fully graded, then publishes them here. Everyone can read them.

     rankings/{examId}                   ranking of one exam
     rankings/overall__{grade}__{subject}   overall ranking of one class

   entry: { uid, displayName, percentage, finalScore, finalTotal, rank, tieIndex, tieTotal }
   ============================================================================ */

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export const rankingService = {
  overallDocId(grade, subject) {
    return `overall__${slug(grade)}__${slug(subject)}`;
  },

  /** "Anas Ahmed Hossiny" → "Anas H."  (privacy-friendly name for leaderboards) */
  displayName(fullName) {
    const parts = String(fullName || "").trim().split(/\s+/);
    if (parts.length < 2) return parts[0] || "Student";
    return `${parts[0]} ${parts[1].charAt(0).toUpperCase()}.`;
  },

  async getExam(examId) {
    return run(async () => {
      const snap = await getDoc(docRef(C.RANKINGS, examId));
      return snap.exists() ? snap.data() : null; // null = not published yet
    });
  },

  async getOverall(grade, subject) {
    return run(async () => {
      const snap = await getDoc(docRef(C.RANKINGS, this.overallDocId(grade, subject)));
      return snap.exists() ? snap.data() : null;
    });
  },

  async publishExam({ examId, examTitle, grade, subject, entries }) {
    return run(async () => {
      await setDoc(docRef(C.RANKINGS, examId), {
        type: "exam", examId, examTitle, grade, subject,
        entries, totalRanked: entries.length,
        publishedAt: serverTimestamp(), publishedBy: actorInfo()
      });
    });
  },

  async publishOverall({ grade, subject, entries }) {
    return run(async () => {
      await setDoc(docRef(C.RANKINGS, this.overallDocId(grade, subject)), {
        type: "overall", grade, subject,
        entries, totalRanked: entries.length,
        publishedAt: serverTimestamp(), publishedBy: actorInfo()
      });
    });
  },

  async unpublishExam(examId) {
    return run(() => deleteDoc(docRef(C.RANKINGS, examId)));
  }
};