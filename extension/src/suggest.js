// Deciding whether to offer to remember a credential we observed on the wire.
//
// Pure, like crypto.js / transfer.js / host.js — no chrome.* here, so
// `node --test` exercises it directly. The decision is the part that quietly
// rots: "offer every single time" and "never offer again" are both one wrong
// comparison away, and neither is visible without a test.

import { normalizeHost } from "./host.js";

// Pull the pair out of an `Authorization` header value.
// Returns null for anything that is not Basic — Bearer tokens and friends are
// none of our business, and a malformed value must not throw into a webRequest
// listener.
export function parseBasicAuth(headerValue) {
  if (typeof headerValue !== "string") return null;
  const m = /^Basic\s+(\S+)$/i.exec(headerValue.trim());
  if (!m) return null;

  let decoded;
  try {
    decoded = atob(m[1]);
  } catch {
    return null;
  }

  // Only the first colon separates the two; a password may contain more.
  const sep = decoded.indexOf(":");
  if (sep < 0) return null;

  const username = decoded.slice(0, sep);
  const password = decoded.slice(sep + 1);
  // An empty username is what Chrome sends when its own dialog is dismissed.
  // Nothing to remember there.
  if (username === "") return null;

  return { username, password };
}

/**
 * What, if anything, to offer for a credential seen on `host`.
 *
 *   "new"    — nothing stored for this host
 *   "update" — stored, but the username or password differs (AC-08-5)
 *   "same"   — already stored exactly; stay quiet
 *
 * Hosts are compared normalised so an entry saved as a pasted URL still counts
 * as a match, the same way findCredentials treats it.
 */
export function classifySuggestion(entries, host, username, password) {
  const target = normalizeHost(host);
  const existing = (entries || []).find((e) => normalizeHost(e.host) === target);

  if (!existing) return "new";
  if (existing.username === username && existing.password === password) return "same";
  return "update";
}
