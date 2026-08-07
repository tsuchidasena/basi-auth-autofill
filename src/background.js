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

// Track how many times we've supplied creds per request, to avoid an infinite
// loop when the stored password is wrong (onAuthRequired re-fires on rejection).
const attempted = new Map(); // requestId -> count

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
