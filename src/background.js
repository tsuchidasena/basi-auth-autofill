// Service worker: intercept HTTP Basic auth and supply stored credentials.

import { findCredentials, isUnlocked, isBioEnabled, unlockWithBio } from "./vault.js";

// How long we hold an auth request open while the Touch ID prompt is up.
//
// T-001 measured this: Chrome itself waits past 180s without giving up, and the
// MV3 service worker stays alive the whole time a blocking event is pending. So
// the ceiling is not Chrome's — it is the origin server's. nginx closes idle
// connections at 75s by default and Apache at 60s, and a request held past that
// comes back as a 5xx instead of the page. 15s sits far below any of those and
// is still generous for a fingerprint tap (1-5s in practice).
const BIO_TIMEOUT_MS = 15_000;

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

// Resolves true if the vault is unlocked by the time we return.
async function tryBioUnlock() {
  if (!(await isBioEnabled())) return false;
  if (!unlockInFlight) {
    unlockInFlight = withTimeout(unlockWithBio(), BIO_TIMEOUT_MS)
      .then(() => true)
      .catch(() => false)
      .finally(() => {
        unlockInFlight = null;
      });
  }
  return unlockInFlight;
}

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
  return cred;
}

// Clean up the attempt counter once the request finishes.
const cleanup = (d) => attempted.delete(d.requestId);
chrome.webRequest.onCompleted.addListener(cleanup, { urls: ["<all_urls>"] });
chrome.webRequest.onErrorOccurred.addListener(cleanup, { urls: ["<all_urls>"] });
