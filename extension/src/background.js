// Service worker: intercept HTTP Basic auth and supply stored credentials.

import {
  findCredentials,
  isUnlocked,
  isBioEnabled,
  unlockWithBio,
  getEntries,
  saveEntries,
} from "./vault.js";
import { parseBasicAuth, classifySuggestion } from "./suggest.js";

// How long we hold an auth request open while the Touch ID prompt is up.
//
// T-001 measured this: Chrome itself waits past 180s without giving up, and the
// MV3 service worker stays alive the whole time a blocking event is pending. So
// the ceiling is not Chrome's — it is the origin server's. nginx closes idle
// connections at 75s by default and Apache at 60s, and a request held past that
// comes back as a 5xx instead of the page. 15s sits far below any of those and
// is still generous for a fingerprint tap (1-5s in practice).
const BIO_TIMEOUT_MS = 15_000;

// Set after a failed auto-unlock so we stop re-prompting. Lives in
// storage.session, not a module variable: the MV3 service worker is torn down
// after a few idle seconds, which would silently lift the suppression and let
// the prompt come back. storage.session survives that and still dies with the
// browser, which is exactly the lifetime we want.
const SUPPRESS_KEY = "bioSuppressed";
const FAILURE_NOTIFICATION_ID = "bio-unlock-failed";

// --- F-08: remembering what the user typed into the browser's own dialog ----
//
// Everything here except the dismissal list lives in memory and dies with the
// service worker. That is the point: an observed credential must never be
// findable in extension storage (AC-08-2 / AC-08-7).
const watching = new Set(); // hosts whose 401 we could not answer
const pending = new Map(); // requestId -> { host, username, password }
let suggestion = null; // the one offer awaiting an answer

const DISMISSED_KEY = "suggestDismissed";
const SUGGEST_NOTIFICATION_ID = "credential-suggestion";

// Touch ID unlock is driven from the background so it completes even if the
// popup closes when the macOS biometric prompt takes focus. The suggestion
// messages live here for a different reason: the observed password must not
// leave this worker, so the popup asks about the offer and asks us to save it,
// but never receives the password itself.
const HANDLERS = {
  BIO_UNLOCK: () => unlockWithBio().then(() => ({ ok: true })),
  SUGGESTION_GET: () => describeSuggestion(),
  SUGGESTION_SAVE: (msg) => saveSuggestion(msg.label),
  SUGGESTION_DISMISS: () => dismissSuggestion(),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = HANDLERS[msg?.type];
  if (!handler) return;
  Promise.resolve(handler(msg))
    .then((r) => sendResponse(r ?? { ok: true }))
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true; // keep the channel open for the async response
});

// Track how many times we've supplied creds per request, to avoid an infinite
// loop when the stored password is wrong (onAuthRequired re-fires on rejection).
const attempted = new Map(); // requestId -> count

// A page with several 401 subresources fires onAuthRequired several times at
// once. Without this, every one of them would raise its own Touch ID prompt and
// the screen would fill with them. The first caller starts the unlock; the rest
// await the same promise and share the outcome.
let unlockInFlight = null; // Promise<boolean> | null

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("BIO_TIMEOUT")), ms);
    promise.then(resolve, reject);
    // Swallow here only to stop an unhandled rejection; the line above is what
    // actually settles the outer promise.
    promise.catch(() => {}).finally(() => clearTimeout(timer));
  });
}

async function isSuppressed() {
  const r = await chrome.storage.session.get(SUPPRESS_KEY);
  return !!r[SUPPRESS_KEY];
}

// The badge now carries two meanings, so it is computed in one place rather
// than poked from each site. "Needs unlocking" wins over "something to save":
// you cannot save into a locked vault, so showing the save hint first would
// send the user down a path that dead-ends.
async function refreshBadge() {
  if (await isSuppressed()) {
    await chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
    await chrome.action.setBadgeText({ text: "!" });
  } else if (suggestion) {
    await chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
    await chrome.action.setBadgeText({ text: "+" });
  } else {
    await chrome.action.setBadgeText({ text: "" });
  }
}

// The browser's own auth dialog cannot be annotated — it is browser UI, out of
// an extension's reach. So say it twice, in the two places we do own: a
// notification to catch the eye now, and a badge that stays up until the vault
// is actually unlocked.
async function announceUnlockNeeded() {
  await chrome.storage.session.set({ [SUPPRESS_KEY]: true });
  await refreshBadge();
  // A fixed id means repeated failures replace the notification instead of
  // stacking up.
  chrome.notifications.create(FAILURE_NOTIFICATION_ID, {
    type: "basic",
    iconUrl: "/icons/icon-128.png",
    title: "解錠できませんでした",
    message: "拡張アイコンから解錠したあと、ページを再読み込みしてください。",
  });
}

// Resolves true if the vault is unlocked by the time we return.
async function tryBioUnlock() {
  if (!(await isBioEnabled())) return false;
  if (await isSuppressed()) return false;
  if (!unlockInFlight) {
    unlockInFlight = withTimeout(unlockWithBio(), BIO_TIMEOUT_MS)
      .then(() => true)
      .catch(async () => {
        await announceUnlockNeeded();
        return false;
      })
      .finally(() => {
        unlockInFlight = null;
      });
  }
  return unlockInFlight;
}

// Recovery hangs off one signal: the session key appearing. Whether it was the
// popup's password field, its Touch ID button or an auto-unlock that put it
// there, the vault is open and the warning is stale. Watching the storage key
// rather than each unlock path keeps popup and background from having to agree
// on who clears what.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "session" || !changes.sessionKey?.newValue) return;
  await chrome.storage.session.remove(SUPPRESS_KEY);
  chrome.notifications.clear(FAILURE_NOTIFICATION_ID);
  // Not necessarily blank: an offer may have been waiting behind the lock.
  await refreshBadge();
});

// The badge is browser state and outlives this worker, so a "+" can survive an
// offer that did not. Recomputing at startup means a stale hint clears itself
// instead of pointing at something that is no longer there.
refreshBadge();

chrome.webRequest.onAuthRequired.addListener(
  (details, asyncCallback) => {
    handleAuth(details)
      .then((cred) => {
        if (cred) asyncCallback({ authCredentials: cred });
        else asyncCallback(); // no action -> browser shows its native dialog
      })
      .catch(() => asyncCallback());
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"]
);

async function handleAuth(details) {
  // Scope: server Basic auth only. Proxy auth is intentionally left to the browser.
  if (details.isProxy) return null;

  const prev = attempted.get(details.requestId) || 0;
  if (prev >= 1) {
    // We already tried our credentials once and they were rejected.
    // Stop autofilling so the user can correct them in the native dialog.
    attempted.delete(details.requestId);
    return null;
  }

  let host;
  try {
    host = new URL(details.url).host;
  } catch {
    return null;
  }

  // Locked but enrolled: hold this request open while Touch ID runs, then serve
  // it directly. Until v0.3.0 the unlock landed but the request that triggered
  // it did not benefit, so the user had to reload the page by hand.
  if (!(await isUnlocked()) && !(await tryBioUnlock())) return null;

  let cred = null;
  try {
    cred = await findCredentials(host); // throws "LOCKED" if vault is locked
  } catch {
    return null; // locked or undecryptable -> defer to the browser dialog
  }

  if (cred) attempted.set(details.requestId, prev + 1);
  else watching.add(host); // we left this one to the dialog — watch what gets typed
  return cred;
}

// --- F-08: observe, then offer ---------------------------------------------

// Authorization is withheld from onBeforeSendHeaders unless "extraHeaders" is
// requested — without it this listener sees every header except the one that
// matters. Observation-only listeners remain available in MV3; it is
// webRequestBlocking that was restricted.
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    let host;
    try {
      host = new URL(details.url).host;
    } catch {
      return;
    }
    if (!watching.has(host)) return; // only hosts whose 401 we could not answer

    const header = details.requestHeaders?.find((h) => h.name.toLowerCase() === "authorization");
    const cred = header && parseBasicAuth(header.value);
    if (cred) pending.set(details.requestId, { host, ...cred });
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

async function isDismissed(host) {
  const r = await chrome.storage.session.get(DISMISSED_KEY);
  return (r[DISMISSED_KEY] || []).includes(host);
}

// Only offer once the server has actually accepted the credential. A 401 here
// means the user mistyped, and mistypes are not worth remembering.
async function considerOffer(observed) {
  if (await isDismissed(observed.host)) return;
  try {
    const entries = await getEntries();
    const kind = classifySuggestion(entries, observed.host, observed.username, observed.password);
    if (kind === "same") return; // already stored exactly; stay quiet
  } catch {
    // Locked, so we cannot classify yet. Hold the offer and decide when the
    // popup asks — which cannot happen before an unlock anyway.
  }

  suggestion = observed;
  watching.delete(observed.host);
  await refreshBadge();
  chrome.notifications.create(SUGGEST_NOTIFICATION_ID, {
    type: "basic",
    iconUrl: "/icons/icon-128.png",
    title: "この資格情報を保存しますか？",
    message: `${observed.host} — 拡張アイコンから保存できます。`,
  });
}

// What the popup is allowed to know: never the password.
async function describeSuggestion() {
  if (!suggestion) return { suggestion: null };
  const entries = await getEntries(); // throws LOCKED; the popup shows the gate
  const kind = classifySuggestion(
    entries,
    suggestion.host,
    suggestion.username,
    suggestion.password
  );
  if (kind === "same") {
    await clearSuggestion();
    return { suggestion: null };
  }
  return { suggestion: { host: suggestion.host, username: suggestion.username, kind } };
}

async function saveSuggestion(label) {
  if (!suggestion) throw new Error("NO_SUGGESTION");
  const { host, username, password } = suggestion;
  const entries = await getEntries();
  const next = entries.filter((e) => e.host !== host);
  const previous = entries.find((e) => e.host === host);
  next.push({ host, username, password, label: label || "", hardReload: previous?.hardReload === true });
  await saveEntries(next);
  await clearSuggestion();
  return { ok: true };
}

async function dismissSuggestion() {
  if (!suggestion) return { ok: true };
  const { [DISMISSED_KEY]: list = [] } = await chrome.storage.session.get(DISMISSED_KEY);
  if (!list.includes(suggestion.host)) list.push(suggestion.host);
  await chrome.storage.session.set({ [DISMISSED_KEY]: list });
  await clearSuggestion();
  return { ok: true };
}

async function clearSuggestion() {
  suggestion = null;
  chrome.notifications.clear(SUGGEST_NOTIFICATION_ID);
  await refreshBadge();
}

// Clean up the attempt counter once the request finishes, and decide whether
// anything we observed on the way is worth offering.
chrome.webRequest.onCompleted.addListener(
  (d) => {
    attempted.delete(d.requestId);
    const observed = pending.get(d.requestId);
    if (!observed) return;
    pending.delete(d.requestId);
    if (d.statusCode >= 200 && d.statusCode < 300) considerOffer(observed);
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onErrorOccurred.addListener(
  (d) => {
    attempted.delete(d.requestId);
    pending.delete(d.requestId);
  },
  { urls: ["<all_urls>"] }
);
