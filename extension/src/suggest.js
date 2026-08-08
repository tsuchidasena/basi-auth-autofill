// Deciding whether an authenticated host is worth offering to register.
//
// Pure, like crypto.js / transfer.js / host.js — no chrome.* here, so
// `node --test` exercises it directly.
//
// This module used to also parse Authorization headers. That approach was
// dropped: Chrome adds the credential the user types into its own auth dialog
// downstream of every webRequest observation point, so an extension cannot see
// it. What remains observable is "a request to this host succeeded", which is
// enough to notice that something is missing from the vault.

import { normalizeHost } from "./host.js";

/**
 * Whether the vault already holds an entry for `host`.
 *
 * Hosts are compared normalised so an entry saved as a pasted URL still counts
 * as a match, the same way findCredentials treats it — otherwise a legacy entry
 * would be offered as "new" on every visit.
 */
export function hasEntryFor(entries, host) {
  const target = normalizeHost(host);
  return (entries || []).some((e) => normalizeHost(e.host) === target);
}

/**
 * What the offer should say.
 *
 *   "update" — we had an entry and supplied it, and it was rejected, so the
 *              stored password is stale
 *   "new"    — nothing stored for this host
 *
 * `supplied` is what the background knows and the vault cannot tell us: a host
 * can have an entry and still land here if that entry was wrong.
 */
export function classifySuggestion(entries, host, supplied) {
  return supplied || hasEntryFor(entries, host) ? "update" : "new";
}

/** The username already on file, so an update offer can pre-fill it. */
export function existingUsername(entries, host) {
  const target = normalizeHost(host);
  return (entries || []).find((e) => normalizeHost(e.host) === target)?.username ?? "";
}
