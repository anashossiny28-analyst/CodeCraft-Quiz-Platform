/* ============================================================================
   CODE CRAFT — QUIZ PLATFORM
   js/firebase-config.js

   The ONLY file that knows how to connect to Firebase.
   Every other module imports { auth, db, ... } from here.
   ============================================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

/* ---------------------------------------------------------------------------
   Project configuration (from Firebase Console → Project settings → Web app)
   This key is not a secret: access is protected by Firestore Security Rules.
   --------------------------------------------------------------------------- */
const firebaseConfig = {
  apiKey: "AIzaSyBnGVqKO1BJkR6iMjELDVR0HGyeDFbudIs",
  authDomain: "codecraft-quiz-platform.firebaseapp.com",
  projectId: "codecraft-quiz-platform",
  storageBucket: "codecraft-quiz-platform.firebasestorage.app",
  messagingSenderId: "871270617000",
  appId: "1:871270617000:web:a818885da561069f2b179d"
};

/* ---------------------------------------------------------------------------
   Main app instance
   --------------------------------------------------------------------------- */
const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);

/* Firestore with OFFLINE PERSISTENCE:
   answers are written to the browser's local cache immediately, even without
   internet, and Firebase syncs them automatically when the connection returns.
   persistentMultipleTabManager lets several tabs share the same cache safely. */
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager()
  })
});

/* ---------------------------------------------------------------------------
   Secondary app instance — used ONLY by the Admin's "Create Staff Account".
   Creating a user on the main `auth` would sign the admin out and sign in as
   the new account. A separate app instance keeps the admin's session intact.
   --------------------------------------------------------------------------- */
let secondaryAuth = null;

export function getSecondaryAuth() {
  if (!secondaryAuth) {
    const secondaryApp = initializeApp(firebaseConfig, "secondary");
    secondaryAuth = getAuth(secondaryApp);
  }
  return secondaryAuth;
}

/* ---------------------------------------------------------------------------
   App-wide constants
   --------------------------------------------------------------------------- */

/* Users type an ID (e.g. BR-2026-0001). Firebase Auth needs an email, so we
   silently convert: BR-2026-0001  →  br-2026-0001@codecraft-quiz.app
   Nobody ever sees or types this email. */
export const SYNTHETIC_EMAIL_DOMAIN = "codecraft-quiz.app";

export const ROLES = Object.freeze({
  STUDENT: "student",
  TEACHER: "teacher",
  SECRETARY: "secretary",
  ADMIN: "admin"
});

export const ACCOUNT_STATUS = Object.freeze({
  PENDING: "pending",
  ACTIVE: "active",
  BLOCKED: "blocked",
  BANNED: "banned"
});

/* Prefix used when generating each role's ID */
export const ID_PREFIX = Object.freeze({
  student: "BR",
  teacher: "TC",
  secretary: "SC",
  admin: "AD"
});

export const GRADES = ["1st Baccalaureate", "2nd Baccalaureate"];
export const SUBJECTS = ["Programming", "English", "Arabic"];

export const COLLECTIONS = Object.freeze({
  USERS: "users",
  PHONE_INDEX: "phoneIndex",
  EXAMS: "exams",
  ATTEMPTS: "attempts",
  HOMEWORK_DEFS: "homeworkDefs",
  HOMEWORK_SUBMISSIONS: "homeworkSubmissions",
  LESSON_NOTES: "lessonNotes",
  STUDENT_LESSON_ANSWERS: "studentLessonAnswers"
});