// Service worker: intercept HTTP Basic auth and supply stored credentials.

import {
  findCredentials,
  isUnlocked,
  isBioEnabled,
  unlockWithBio,
  getEntries,
} from "./vault.js";
import { classifySuggestion, existingUsername } from "./suggest.js";
import { hostMatches, normalizeHost } from "./host.js";

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
// host -> true if we had an entry and it was rejected (so the offer is an
// update rather than a first registration).
const watching = new Map();
let suggestion = null; // the one offer awaiting an answer

const DISMISSED_KEY = "suggestDismissed";
const SUGGEST_NOTIFICATION_ID = "credential-suggestion";

// Touch ID unlock is driven from the background so it completes even if the
// popup closes when the macOS biometric prompt takes focus. The suggestion
// messages are here because the offer lives in this worker's memory; the popup
// reads it, then tells us how it was resolved.
const HANDLERS = {
  BIO_UNLOCK: () => unlockWithBio().then(() => ({ ok: true })),
  SUGGESTION_GET: () => describeSuggestion(),
  SUGGESTION_RESOLVE: (msg) => resolveSuggestion(msg.dismiss === true),
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

  let host;
  try {
    host = new URL(details.url).host;
  } catch {
    return null;
  }

  const prev = attempted.get(details.requestId) || 0;
  if (prev >= 1) {
    // We already tried our credentials once and they were rejected. Stop
    // autofilling so the user can correct them in the native dialog — and
    // remember that an entry exists, because getting in from here means the
    // stored password is stale rather than missing.
    attempted.delete(details.requestId);
    watching.set(host, true);
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
  // Nothing to supply. If the user gets in through the dialog anyway, the vault
  // is missing this host.
  else watching.set(host, false);
  return cred;
}

// --- F-10: always-fresh hosts ----------------------------------------------
//
// Reload only when the cache was actually used. Reloading every visit would
// double every page load; this way the extra load happens exactly in the case
// it is meant to fix, and the bypassing reload leaves nothing stale behind for
// the next visit.
//
// Chose this over rewriting requests with declarativeNetRequest for two
// reasons. Whether a modified Cache-Control request header defeats Chrome's
// cache lookup is unverified — but more decisively, dNR conditions cannot
// express the host rules used everywhere else here: "||example.com" also
// matches subdomains, so exact-vs-wildcard collapses, and a port like
// localhost:8765 has no representation at all. Matching stays in host.js.
const recentlyForced = new Map(); // tabId -> url

async function hardReloadHosts() {
  try {
    return (await getEntries()).filter((e) => e.hardReload === true).map((e) => e.host);
  } catch {
    return []; // locked: nothing to act on
  }
}

async function maybeForceReload(details) {
  if (details.type !== "main_frame" || details.tabId < 0) return;
  if (!details.fromCache) {
    recentlyForced.delete(details.tabId);
    return;
  }
  if (recentlyForced.get(details.tabId) === details.url) return; // already did this one

  let host;
  try {
    host = normalizeHost(new URL(details.url).host);
  } catch {
    return;
  }

  const patterns = await hardReloadHosts();
  if (!patterns.some((p) => hostMatches(normalizeHost(p), host))) return;

  recentlyForced.set(details.tabId, details.url);
  chrome.tabs.reload(details.tabId, { bypassCache: true }).catch(() => {});
}

chrome.tabs.onRemoved.addListener((tabId) => recentlyForced.delete(tabId));

// Clean up the attempt counter once a request finishes. A 2xx on a host we
// could not answer for means the user got in through the browser's dialog —
// which is the cue to offer to register it.
chrome.webRequest.onCompleted.addListener(
  (d) => {
    attempted.delete(d.requestId);
    if (d.statusCode < 200 || d.statusCode >= 300) return;
    let host;
    try {
      host = new URL(d.url).host;
    } catch {
      return;
    }
    if (watching.has(host)) considerOffer(host, watching.get(host));
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onCompleted.addListener(maybeForceReload, { urls: ["<all_urls>"] });

chrome.webRequest.onErrorOccurred.addListener((d) => attempted.delete(d.requestId), {
  urls: ["<all_urls>"],
});

// --- F-08: offering to register what the vault was missing ------------------

async function isDismissed(host) {
  const r = await chrome.storage.session.get(DISMISSED_KEY);
  return (r[DISMISSED_KEY] || []).includes(host);
}

// Getting in through the browser's own dialog means the vault could not answer
// for this host. That is the whole signal — the credential itself is not
// observable from an extension, and does not need to be.
async function considerOffer(host, supplied) {
  if (await isDismissed(host)) return;

  suggestion = { host, supplied };
  watching.delete(host);
  await refreshBadge();
  chrome.notifications.create(SUGGEST_NOTIFICATION_ID, {
    type: "basic",
    iconUrl: "/icons/icon-128.png",
    title: supplied ? "登録した資格情報が古いようです" : "このサイトを登録しますか？",
    message: `${host} — 拡張アイコンから登録できます。`,
  });
}

async function describeSuggestion() {
  if (!suggestion) return { suggestion: null };
  const entries = await getEntries(); // throws LOCKED; the popup shows the gate
  const { host, supplied } = suggestion;
  return {
    suggestion: {
      host,
      kind: classifySuggestion(entries, host, supplied),
      username: existingUsername(entries, host),
    },
  };
}

// The popup writes to the vault itself, the same way its quick-add form does;
// this only retires the offer. Dismissing also silences the host for the rest
// of the browser session.
async function resolveSuggestion(dismiss) {
  if (!suggestion) return { ok: true };
  if (dismiss) {
    const { [DISMISSED_KEY]: list = [] } = await chrome.storage.session.get(DISMISSED_KEY);
    if (!list.includes(suggestion.host)) list.push(suggestion.host);
    await chrome.storage.session.set({ [DISMISSED_KEY]: list });
  }
  await clearSuggestion();
  return { ok: true };
}

async function clearSuggestion() {
  suggestion = null;
  chrome.notifications.clear(SUGGEST_NOTIFICATION_ID);
  await refreshBadge();
}
