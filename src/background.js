// Service worker: intercept HTTP Basic auth and supply stored credentials.

import { findCredentials, unlockWithBio } from "./vault.js";

// Touch ID unlock is driven from the background so it completes even if the
// popup closes when the macOS biometric prompt takes focus.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "BIO_UNLOCK") {
    unlockWithBio()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // keep the channel open for the async response
  }
});

// ===== TEMPORARY: T-001 spike — remove before implementing F-04 ============
// Measures how long Chrome will wait for an asyncBlocking onAuthRequired
// callback before giving up and showing its own dialog. That ceiling sets
// BIO_TIMEOUT_MS in docs/DESIGN.md; if it is very short, the hold-the-request
// design for F-04 does not work at all and has to go back to the spec.
//
// Also watches for the MV3 service worker being torn down mid-hold, which
// would cap the wait regardless of what webRequest itself allows.
// Round 2: hold against the local server (tools/spike-401-server.js) at the
// value we intend to ship, to prove credentials really do flow after a hold.
// Round 1 against httpbin.org proved Chrome waits >180s and the SW survives,
// but the origin returned 503 — it gave up first — so the 200 path is unproven.
const SPIKE_HOST = "localhost:8765";
const SPIKE_MATCH = "*://localhost/*"; // match patterns cannot carry a port
const SPIKE_HOLD_MS = 15_000;
const SPIKE_BOOT = Date.now();
console.log(`[T-001] service worker started @ ${new Date(SPIKE_BOOT).toISOString()}`);

function runSpike(details, asyncCallback) {
  const t0 = Date.now();
  const at = () => `${Date.now() - t0}ms`;
  console.log(`[T-001] onAuthRequired req=${details.requestId} url=${details.url}`);
  console.log(`[T-001] holding the callback for up to ${SPIKE_HOLD_MS}ms — watch for the dialog`);

  const tick = setInterval(() => console.log(`[T-001] still holding: ${at()}`), 5000);

  setTimeout(() => {
    clearInterval(tick);
    console.log(`[T-001] releasing callback at ${at()}`);
    try {
      asyncCallback({ authCredentials: { username: "user", password: "passwd" } });
      console.log(`[T-001] asyncCallback returned without throwing at ${at()}`);
    } catch (e) {
      console.log(`[T-001] asyncCallback THREW at ${at()}: ${e.message}`);
    }
  }, SPIKE_HOLD_MS);
}
// ===== end T-001 spike =====================================================

// Track how many times we've supplied creds per request, to avoid an infinite
// loop when the stored password is wrong (onAuthRequired re-fires on rejection).
const attempted = new Map(); // requestId -> count

chrome.webRequest.onAuthRequired.addListener(
  (details, asyncCallback) => {
    if (!details.isProxy && details.url.includes(SPIKE_HOST)) {
      runSpike(details, asyncCallback);
      return;
    }
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

  let cred = null;
  try {
    cred = await findCredentials(host); // throws "LOCKED" if vault is locked
  } catch {
    return null; // locked or undecryptable -> defer to the browser dialog
  }

  if (cred) attempted.set(details.requestId, prev + 1);
  return cred;
}

// Clean up the attempt counter once the request finishes.
const cleanup = (d) => attempted.delete(d.requestId);
chrome.webRequest.onCompleted.addListener(cleanup, { urls: ["<all_urls>"] });
chrome.webRequest.onErrorOccurred.addListener(cleanup, { urls: ["<all_urls>"] });

// ===== TEMPORARY: T-001 spike — remove with the block above ================
chrome.webRequest.onCompleted.addListener(
  (d) => console.log(`[T-001] onCompleted req=${d.requestId} status=${d.statusCode} @ ${Date.now() - SPIKE_BOOT}ms since boot`),
  { urls: [SPIKE_MATCH] }
);
chrome.webRequest.onErrorOccurred.addListener(
  (d) => console.log(`[T-001] onErrorOccurred req=${d.requestId} error=${d.error} @ ${Date.now() - SPIKE_BOOT}ms since boot`),
  { urls: [SPIKE_MATCH] }
);
// ===== end T-001 spike =====================================================
