/* ============================================================================
   CODE CRAFT — QUIZ PLATFORM
   js/notifications.js

   The bell in the student's top bar. main.js calls two functions from here:

     startNotifications(ctx)   after login. Watches the student's exams and keeps the
                               red number on the bell up to date. Returns a stop() function.
     openNotifications(ctx)    when the bell is pressed: lists the notifications.

   What is a notification?
     "Your essay results for <exam> are ready" — it appears when a teacher finishes
     grading the essay answers of an exam the student took. It stays highlighted until
     the student has seen the result: either by tapping it here, or by opening that
     result anywhere in the app (the screen is watched, so nothing else needs to change).
   ============================================================================ */

import { attemptService, toMillis } from "./data-services.js";
import { html, emptyState, openModal, toast, delegate, formatDateTime, ASSETS } from "./ui-helpers.js";

const MAX_LISTED = 15;

let latest = [];   // the student's attempts, kept fresh by startNotifications()

const inBackground = (promise) => {
  Promise.resolve(promise).catch((err) => console.warn("[notifications] could not update:", err));
};

/* ============================================================================
   1. WHAT TO SHOW  (pure functions)
   ============================================================================ */

/**
 * @returns {{id: string, attemptId: string, title: string, at: any, unread: boolean}[]}
 *          newest first
 */
export function notificationsFrom(attempts) {
  return attempts
    .filter((a) => a.status === "COMPLETED" && a.hasEssay)
    .sort((a, b) => (toMillis(b.completedAt || b.submittedAt) || 0) - (toMillis(a.completedAt || a.submittedAt) || 0))
    .slice(0, MAX_LISTED)
    .map((a) => ({
      id: a.id,
      attemptId: a.id,
      title: `Your essay results for ${a.examTitle || "your exam"} are ready`,
      at: a.completedAt || a.submittedAt,
      unread: a.viewedByStudent === false
    }));
}

export const unreadCount = (list) => list.filter((n) => n.unread).length;

/* ============================================================================
   2. THE BELL
   ============================================================================ */

function updateBadge(list) {
  const count = unreadCount(list);
  const badge = document.getElementById("notif-badge");
  const button = document.getElementById("notif-btn");

  if (badge) {
    badge.textContent = count > 9 ? "9+" : String(count);
    badge.hidden = count === 0;
  }
  if (button) {
    button.setAttribute("aria-label", count ? `Notifications, ${count} unread` : "Notifications");
  }
}

/** The result screen was opened: if that exam's notification is unread, it is now read. */
function markCurrentResultViewed() {
  const params = history.state && history.state.params;
  const attemptId = params && params.attemptId;
  if (!attemptId) return;

  const attempt = latest.find((a) => a.id === attemptId);
  if (attempt && attempt.status === "COMPLETED" && attempt.hasEssay && attempt.viewedByStudent === false) {
    inBackground(attemptService.markViewed(attemptId));
  }
}

export function startNotifications(ctx) {
  const unsubscribe = attemptService.watchMine(
    ctx.profile.uid,
    (attempts) => {
      latest = attempts;
      updateBadge(notificationsFrom(attempts));
    },
    (err) => console.warn("[notifications] could not watch:", err)
  );

  // Opening a result (from the list, the bell, the home page …) marks it as read.
  const resultScreen = document.getElementById("screen-result");
  let observer = null;
  if (resultScreen && typeof MutationObserver !== "undefined") {
    observer = new MutationObserver(() => { if (!resultScreen.hidden) markCurrentResultViewed(); });
    observer.observe(resultScreen, { attributes: true, attributeFilter: ["hidden"] });
  }

  return function stop() {
    unsubscribe();
    if (observer) observer.disconnect();
    latest = [];
    updateBadge([]);
  };
}

/* ============================================================================
   3. THE LIST
   ============================================================================ */

export function openNotifications(ctx) {
  const list = notificationsFrom(latest);
  const unread = list.filter((n) => n.unread);

  const actions = [{ label: "Close", variant: "secondary" }];
  if (unread.length) {
    actions.unshift({
      label: "Mark all as read",
      variant: "secondary",
      closes: false,
      onClick: async (api) => {
        api.setBusy(true);
        try {
          await Promise.all(unread.map((n) => attemptService.markViewed(n.attemptId)));
          api.close();
        } catch (err) {
          console.warn("[notifications] mark all failed:", err);
          toast("Couldn't update. Please try again.", { type: "error" });
          api.setBusy(false);
        }
      }
    });
  }

  const modal = openModal({
    title: "Notifications",
    size: "sm",
    content: list.length
      ? html`
          <div class="notif-list">
            ${list.map((n) => html`
              <button type="button" class="notif-item ${n.unread ? "is-unread" : ""}" data-attempt="${n.attemptId}">
                <strong dir="auto">${n.title}</strong>
                <span class="page-sub" style="display:block">${formatDateTime(n.at)} · tap to see your result</span>
              </button>`)}
          </div>`
      : emptyState({
          title: "You're all caught up",
          message: "We'll tell you here as soon as your essay answers are graded.",
          image: ASSETS.beshoyRobot
        }),
    actions
  });

  delegate(modal.body, "click", "[data-attempt]", (event, el) => {
    const attemptId = el.dataset.attempt;
    const item = list.find((n) => n.attemptId === attemptId);
    if (item && item.unread) inBackground(attemptService.markViewed(attemptId));
    modal.close();
    ctx.navigate("result", { attemptId });
  });
}