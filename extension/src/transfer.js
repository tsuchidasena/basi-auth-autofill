// Export / import of vault entries.
//
// Deliberately free of any chrome.* reference: file pickers, downloads and the
// DOM belong to options.js, and keeping this module pure is what lets `node
// --test` exercise the merge and crypto paths directly.

import { deriveKey, encryptJSON, decryptJSON, bufToB64, b64ToBuf } from "./crypto.js";
import { normalizeHost } from "./host.js";

// Stamped into every file so a JSON that happens to be lying around cannot be
// mistaken for one of ours.
export const EXPORT_KIND = "basic-auth-autofill-export";
export const EXPORT_VERSION = 1;

// Copy across only the fields an entry is meant to carry. On the way out this
// keeps vault internals from leaking into a file we hand to someone; on the way
// in it drops anything a hand-edited file tries to smuggle in.
function pickEntry(e) {
  return {
    // Normalise on the way through: a file can carry a pasted URL as its host,
    // whether it was hand-edited or exported by a pre-0.3.2 build.
    host: normalizeHost(e.host),
    username: e.username,
    password: e.password ?? "",
    label: e.label ?? "",
  };
}

function isValidEntry(e) {
  return (
    e !== null &&
    typeof e === "object" &&
    typeof e.host === "string" &&
    e.host !== "" &&
    typeof e.username === "string"
  );
}

function readEntries(list) {
  if (!Array.isArray(list) || !list.every(isValidEntry)) throw new Error("BAD_FORMAT");
  return list.map(pickEntry);
}

// A fresh salt per export, never the vault's. The passphrase is expected to
// differ from the master password whenever the file is going to someone else,
// and reusing the vault salt would tie the two together for no benefit.
export async function buildEncryptedExport(entries, passphrase) {
  if (!passphrase) throw new Error("EMPTY_PASSPHRASE");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passphrase, salt.buffer);
  const payload = await encryptJSON(key, { entries: entries.map(pickEntry) });
  return { kind: EXPORT_KIND, v: EXPORT_VERSION, salt: bufToB64(salt), ...payload };
}

export function buildPlainExport(entries) {
  return {
    kind: EXPORT_KIND,
    v: EXPORT_VERSION,
    plaintext: true,
    entries: entries.map(pickEntry),
  };
}

// Throws BAD_FORMAT / BAD_VERSION / EMPTY_PASSPHRASE / WRONG_PASSPHRASE.
// Callers branch on Error.message, matching vault.js.
export async function parseImport(fileObj, passphrase) {
  if (fileObj === null || typeof fileObj !== "object" || fileObj.kind !== EXPORT_KIND) {
    throw new Error("BAD_FORMAT");
  }
  if (fileObj.v !== EXPORT_VERSION) throw new Error("BAD_VERSION");

  if (fileObj.plaintext) return readEntries(fileObj.entries);

  if (
    typeof fileObj.salt !== "string" ||
    typeof fileObj.iv !== "string" ||
    typeof fileObj.ct !== "string"
  ) {
    throw new Error("BAD_FORMAT");
  }
  if (!passphrase) throw new Error("EMPTY_PASSPHRASE");

  const key = await deriveKey(passphrase, b64ToBuf(fileObj.salt));
  let data;
  try {
    data = await decryptJSON(key, fileObj);
  } catch {
    // AES-GCM authentication failed. Only a wrong passphrase realistically gets
    // you here — a corrupted file would have failed the shape checks above.
    throw new Error("WRONG_PASSPHRASE");
  }
  return readEntries(data?.entries);
}

// Pure, and meant to be called twice: once with no overwrites to find out what
// collides, then again once the user has said which of those to replace.
// Returns the would-be entry list plus per-host tallies for the summary.
//
// `conflicts` lists every collision regardless of the decision, so pass one can
// drive the UI. A host appearing twice inside `incoming` collides with its own
// earlier copy, which is reported the same way — that file is malformed, and
// saying so beats silently keeping whichever came last.
export function mergeEntries(existing, incoming, overwriteHosts = new Set()) {
  const overwrite = overwriteHosts instanceof Set ? overwriteHosts : new Set(overwriteHosts);
  const next = existing.map(pickEntry);
  const indexByHost = new Map(next.map((e, i) => [e.host, i]));

  const added = [];
  const skipped = [];
  const overwritten = [];
  const conflicts = [];

  for (const raw of incoming) {
    const entry = pickEntry(raw);
    const at = indexByHost.get(entry.host);

    if (at === undefined) {
      indexByHost.set(entry.host, next.length);
      next.push(entry);
      added.push(entry.host);
      continue;
    }

    conflicts.push(entry.host);
    if (overwrite.has(entry.host)) {
      next[at] = entry;
      overwritten.push(entry.host);
    } else {
      skipped.push(entry.host);
    }
  }

  return { next, added, skipped, overwritten, conflicts };
}
