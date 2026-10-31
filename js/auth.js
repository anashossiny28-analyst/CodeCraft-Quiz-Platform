/* ============================================================================
   CODE CRAFT — QUIZ PLATFORM
   js/auth.js

   Everything about WHO the user is:
     • registerStudent()      student self-registration (account starts "pending")
     • login()                one login for students, teachers, secretaries, admins
     • logout()
     • watchSession()         restores the session on page load / reports sign-outs
     • createStaffAccount()   admin-only: creates teacher / secretary / admin accounts

   How ID + Password works with Firebase:
     Firebase Authentication needs an email, so the ID the user types is converted
     behind the scenes:  BR-2026-0001  →  br-2026-0001@codecraft-quiz.app
     Nobody ever sees or types that email.

   This module never touches the DOM. It returns data or throws AuthError, and the
   UI layer (main.js) decides what to show.
   ============================================================================ */

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";

import {
  doc,
  getDoc,
  setDoc,
  writeBatch,
  serverTimestamp,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

import {
  auth,
  db,
  getSecondaryAuth,
  SYNTHETIC_EMAIL_DOMAIN,
  ROLES,
  ACCOUNT_STATUS,
  ID_PREFIX,
  GRADES,
  SUBJECTS,
  COLLECTIONS
} from "./firebase-config.js";

/* ============================================================================
   1. ERRORS
   Every failure is an AuthError with a stable `code` (for the UI to branch on)
   and a ready-to-display English `message`.
   ============================================================================ */

const MESSAGES = {
  "missing-fields": "Please fill in every required field.",
  "missing-credentials": "Please enter your ID and password.",
  "invalid-name": "Please enter your full name (first and last name).",
  "invalid-mobile": "Please enter a valid mobile number.",
  "invalid-parent-mobile": "Please enter a valid parent mobile number.",
  "same-numbers": "Your mobile number and your parent's mobile number must be different.",
  "invalid-email": "Please enter a valid email address.",
  "invalid-gender": "Please select your gender.",
  "invalid-grade": "Please select your grade.",
  "invalid-subject": "Please select your subject.",
  "weak-password": "Password must be at least 6 characters.",
  "phone-taken": "This mobile number is already registered. Please contact the academy.",
  "invalid-credentials": "ID or password is incorrect.",
  "account-pending": "Your account is still awaiting approval. Please contact the academy secretary.",
  "account-blocked": "Your account is temporarily suspended. Please contact the academy secretary.",
  "account-banned": "Your account has been deactivated. Please contact the academy.",
  "profile-missing": "We couldn't find your account details. Please contact the academy.",
  "too-many-requests": "Too many attempts. Please wait a few minutes and try again.",
  "network": "No internet connection. Please check your connection and try again.",
  "permission-denied": "You don't have permission to do that.",
  "not-admin": "Only an admin can create staff accounts.",
  "invalid-role": "Please choose a valid role.",
  "id-generation-failed": "Couldn't generate a unique ID. Please try again.",
  "unknown": "Something went wrong. Please try again."
};

export class AuthError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES.unknown);
    this.name = "AuthError";
    this.code = code;
  }
}

/** Converts any Firebase error into an AuthError. */
function mapFirebaseError(err) {
  if (err instanceof AuthError) return err;

  switch (err && err.code) {
    case "auth/invalid-credential":
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-email":
      return new AuthError("invalid-credentials");
    case "auth/too-many-requests":
      return new AuthError("too-many-requests");
    case "auth/network-request-failed":
    case "unavailable":
      return new AuthError("network");
    case "auth/weak-password":
      return new AuthError("weak-password");
    case "permission-denied":
      return new AuthError("permission-denied");
    default:
      console.error("[auth] Unexpected error:", err);
      return new AuthError("unknown");
  }
}

/* ============================================================================
   2. VALIDATION HELPERS (exported so the UI can reuse them)
   ============================================================================ */

/* Egyptian mobile format: 01[0,1,2,5] + 8 digits. Change this one line if the
   academy ever needs international numbers. */
const MOBILE_PATTERN = /^01[0125]\d{8}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PASSWORD_LENGTH = 6; // Firebase Authentication minimum

/** "+20 101-234-5678", "0020101...", "1012345678"  →  "01012345678" */
export function normalizeMobile(raw) {
  let digits = String(raw || "").replace(/\D/g, "");
  if (digits.startsWith("0020")) digits = "0" + digits.slice(4);
  else if (digits.startsWith("20") && digits.length === 12) digits = "0" + digits.slice(2);
  else if (digits.length === 10 && digits.startsWith("1")) digits = "0" + digits;
  return digits;
}

export function isValidMobile(normalized) {
  return MOBILE_PATTERN.test(normalized);
}

export function isValidEmailFormat(email) {
  return EMAIL_PATTERN.test(String(email || "").trim());
}

function cleanName(raw) {
  return String(raw || "").trim().replace(/\s+/g, " ");
}

function isValidFullName(name) {
  return name.length <= 60 && name.split(" ").length >= 2;
}

/** Validates + normalizes the registration form. Throws AuthError on the first problem. */
export function validateRegistration(data) {
  const name = cleanName(data.name);
  const mobile = normalizeMobile(data.mobile);
  const parentMobile = normalizeMobile(data.parentMobile);
  const email = String(data.email || "").trim();
  const { gender, grade, subject, password } = data;

  if (!name || !data.mobile || !data.parentMobile || !password) throw new AuthError("missing-fields");
  if (!isValidFullName(name)) throw new AuthError("invalid-name");
  if (!isValidMobile(mobile)) throw new AuthError("invalid-mobile");
  if (!isValidMobile(parentMobile)) throw new AuthError("invalid-parent-mobile");
  if (mobile === parentMobile) throw new AuthError("same-numbers");
  if (email && !isValidEmailFormat(email)) throw new AuthError("invalid-email");
  if (gender !== "Male" && gender !== "Female") throw new AuthError("invalid-gender");
  if (!GRADES.includes(grade)) throw new AuthError("invalid-grade");
  if (!SUBJECTS.includes(subject)) throw new AuthError("invalid-subject");
  if (String(password).length < MIN_PASSWORD_LENGTH) throw new AuthError("weak-password");

  return { name, mobile, parentMobile, email, gender, grade, subject, password };
}

/* ============================================================================
   3. LOGIN ID  <->  SYNTHETIC EMAIL
   ============================================================================ */

export function loginIdToEmail(loginId) {
  return `${String(loginId).trim().toLowerCase()}@${SYNTHETIC_EMAIL_DOMAIN}`;
}

function randomFourDigits() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String((buf[0] % 9999) + 1).padStart(4, "0");
}

/** BR-2026-0047 style. Uniqueness is guaranteed by Firebase Auth (see below). */
export function generateLoginId(role) {
  return `${ID_PREFIX[role]}-${new Date().getFullYear()}-${randomFourDigits()}`;
}

/**
 * Creates the Firebase Auth user with a freshly generated ID.
 * Students can't read other users' documents (Security Rules), so we can't count
 * existing accounts. Instead we let Firebase Auth be the judge of uniqueness:
 * if the generated ID is taken, it answers "email-already-in-use" and we simply
 * try another one.
 */
async function createAuthUserWithUniqueId(authInstance, role, password) {
  const MAX_ATTEMPTS = 25;

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const loginId = generateLoginId(role);
    const email = loginIdToEmail(loginId);
    try {
      const credential = await createUserWithEmailAndPassword(authInstance, email, password);
      return { credential, loginId, email };
    } catch (err) {
      if (err && err.code === "auth/email-already-in-use") continue; // ID taken → retry
      throw mapFirebaseError(err);
    }
  }
  throw new AuthError("id-generation-failed");
}

/* ============================================================================
   4. SESSION STATE
   ============================================================================ */

let currentProfile = null;     // the signed-in user's Firestore profile (or null)
let authBusy = false;          // true while login/register run, so watchSession stays quiet
let signOutReason = null;      // why the last forced sign-out happened (shown by the UI)
let stopAccountGuard = null;   // unsubscribe function of the live profile listener

export function getCurrentProfile() {
  return currentProfile;
}

export function isStaffRole(role) {
  return role === ROLES.TEACHER || role === ROLES.SECRETARY || role === ROLES.ADMIN;
}

function statusToErrorCode(status) {
  switch (status) {
    case ACCOUNT_STATUS.PENDING: return "account-pending";
    case ACCOUNT_STATUS.BLOCKED: return "account-blocked";
    case ACCOUNT_STATUS.BANNED: return "account-banned";
    default: return "profile-missing";
  }
}

async function fetchProfile(uid) {
  const snap = await getDoc(doc(db, COLLECTIONS.USERS, uid));
  return snap.exists() ? { uid, ...snap.data() } : null;
}

/**
 * Live guard on the signed-in user's own profile document.
 * If staff block/ban the account while the user is logged in, they are signed
 * out immediately. It also keeps `currentProfile` fresh (e.g. after a staff
 * member edits the student's data).
 */
function startAccountGuard(uid) {
  endAccountGuard();
  stopAccountGuard = onSnapshot(
    doc(db, COLLECTIONS.USERS, uid),
    (snap) => {
      if (!snap.exists()) {
        if (snap.metadata.fromCache) return; // not cached yet while offline — don't sign out
        signOutReason = "profile-missing";
        signOut(auth);
        return;
      }
      const data = snap.data();
      if (data.accountStatus !== ACCOUNT_STATUS.ACTIVE) {
        signOutReason = statusToErrorCode(data.accountStatus);
        signOut(auth);
        return;
      }
      currentProfile = { uid, ...data };
    },
    (err) => console.warn("[auth] account guard error:", err)
  );
}

function endAccountGuard() {
  if (stopAccountGuard) {
    stopAccountGuard();
    stopAccountGuard = null;
  }
}

/**
 * Call once at startup.  onChange(profile, reason) fires:
 *   • with the profile  → a valid, ACTIVE session exists (e.g. page refresh)
 *   • with (null, code) → no session. `code` explains a forced sign-out
 *                         ('account-blocked', 'account-banned', 'network', ...)
 *
 * It stays quiet while login()/registerStudent() run — those return their
 * result directly to the caller.
 */
export function watchSession(onChange) {
  return onAuthStateChanged(auth, async (user) => {
    if (authBusy) return;

    if (!user) {
      endAccountGuard();
      currentProfile = null;
      const reason = signOutReason;
      signOutReason = null;
      onChange(null, reason);
      return;
    }

    if (currentProfile && currentProfile.uid === user.uid) return; // already handled

    try {
      const profile = await fetchProfile(user.uid);

      if (!profile) {
        signOutReason = "profile-missing";
        await signOut(auth);
        return;
      }
      if (profile.accountStatus !== ACCOUNT_STATUS.ACTIVE) {
        signOutReason = statusToErrorCode(profile.accountStatus);
        await signOut(auth);
        return;
      }

      currentProfile = profile;
      startAccountGuard(profile.uid);
      onChange(profile, null);
    } catch (err) {
      // Offline at startup with no cached profile: keep the session, report why.
      console.error("[auth] could not restore session:", err);
      onChange(null, mapFirebaseError(err).code);
    }
  });
}

/* ============================================================================
   5. STUDENT REGISTRATION
   ============================================================================ */

/**
 * @param {{name, mobile, parentMobile, email?, gender, grade, subject, password}} formData
 * @returns {Promise<{loginId: string, name: string}>}
 *
 * The account is created with accountStatus "pending". The student is signed
 * out right away and can only log in after staff approve the account.
 */
export async function registerStudent(formData) {
  const data = validateRegistration(formData);

  if (!navigator.onLine) throw new AuthError("network");

  authBusy = true;
  try {
    // 1) Auth user with a unique generated ID (student is now signed in as that user)
    const { credential, loginId, email: authEmail } =
      await createAuthUserWithUniqueId(auth, ROLES.STUDENT, data.password);
    const uid = credential.user.uid;

    // 2) Profile + phone lock, written together in ONE atomic batch.
    //    phoneIndex/{mobile} can only be created once. If the number is already
    //    registered, the Security Rules reject the batch and NOTHING is saved.
    try {
      const profile = {
        loginId,
        authEmail,
        role: ROLES.STUDENT,
        name: data.name,
        accountStatus: ACCOUNT_STATUS.PENDING,
        createdAt: serverTimestamp(),
        mobile: data.mobile,
        parentMobile: data.parentMobile,
        gender: data.gender,
        grade: data.grade,
        subject: data.subject
      };
      if (data.email) profile.email = data.email; // cosmetic, optional

      const batch = writeBatch(db);
      batch.set(doc(db, COLLECTIONS.PHONE_INDEX, data.mobile), {
        ownerUid: uid,
        createdAt: serverTimestamp()
      });
      batch.set(doc(db, COLLECTIONS.USERS, uid), profile);
      await batch.commit();
    } catch (err) {
      // Roll back the Auth user so no orphan account is left behind.
      try { await credential.user.delete(); } catch (_) { /* best effort */ }

      if (err && err.code === "permission-denied") throw new AuthError("phone-taken");
      throw mapFirebaseError(err);
    }

    return { loginId, name: data.name };
  } finally {
    try { await signOut(auth); } catch (_) { /* nothing to sign out */ }
    authBusy = false;
  }
}

/* ============================================================================
   6. LOGIN / LOGOUT
   ============================================================================ */

/**
 * One login for every role.
 * @returns {Promise<object>} the user's profile ({ uid, role, name, ... })
 * @throws {AuthError} wrong credentials, pending / blocked / banned account, network...
 */
export async function login(loginId, password) {
  const id = String(loginId || "").trim();
  if (!id || !password) throw new AuthError("missing-credentials");

  authBusy = true;
  try {
    let credential;
    try {
      credential = await signInWithEmailAndPassword(auth, loginIdToEmail(id), password);
    } catch (err) {
      throw mapFirebaseError(err);
    }

    let profile;
    try {
      profile = await fetchProfile(credential.user.uid);
    } catch (err) {
      await signOut(auth);
      throw mapFirebaseError(err);
    }

    if (!profile) {
      await signOut(auth);
      throw new AuthError("profile-missing");
    }
    if (profile.accountStatus !== ACCOUNT_STATUS.ACTIVE) {
      await signOut(auth);
      throw new AuthError(statusToErrorCode(profile.accountStatus));
    }

    currentProfile = profile;
    startAccountGuard(profile.uid);
    return profile;
  } finally {
    authBusy = false;
  }
}

/** Ends the session only. No account data is ever deleted. */
export async function logout() {
  endAccountGuard();
  currentProfile = null;
  await signOut(auth);
}

/* ============================================================================
   7. STAFF ACCOUNTS  (admin only)
   ============================================================================ */

/**
 * Creates a teacher / secretary / admin account.
 * The admin chooses name, role and password; the system generates the ID
 * (TC-… / SC-… / AD-…).
 *
 * A SECOND Firebase app instance creates the Auth user, so the admin's own
 * session is not replaced by the new account.
 *
 * @returns {Promise<{loginId: string, password: string}>} hand these to the new staff member
 */
export async function createStaffAccount({ name, role, password }) {
  if (!currentProfile || currentProfile.role !== ROLES.ADMIN) throw new AuthError("not-admin");
  if (![ROLES.TEACHER, ROLES.SECRETARY, ROLES.ADMIN].includes(role)) throw new AuthError("invalid-role");

  const cleanedName = cleanName(name);
  if (!cleanedName || !password) throw new AuthError("missing-fields");
  if (!isValidFullName(cleanedName)) throw new AuthError("invalid-name");
  if (String(password).length < MIN_PASSWORD_LENGTH) throw new AuthError("weak-password");

  const secondaryAuth = getSecondaryAuth();
  const { credential, loginId, email: authEmail } =
    await createAuthUserWithUniqueId(secondaryAuth, role, password);

  try {
    // Written with the ADMIN's credentials (main `db`) — the rules allow admins to create users.
    await setDoc(doc(db, COLLECTIONS.USERS, credential.user.uid), {
      loginId,
      authEmail,
      role,
      name: cleanedName,
      accountStatus: ACCOUNT_STATUS.ACTIVE,
      createdAt: serverTimestamp(),
      createdBy: currentProfile.uid
    });
  } catch (err) {
    try { await credential.user.delete(); } catch (_) { /* best effort */ }
    throw mapFirebaseError(err);
  } finally {
    try { await signOut(secondaryAuth); } catch (_) { /* best effort */ }
  }

  return { loginId, password };
}