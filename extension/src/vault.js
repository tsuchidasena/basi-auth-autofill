// Vault logic: init / unlock / lock / entry CRUD / credential lookup.
// Backed by chrome.storage.local (encrypted vault) + chrome.storage.session (live key).

import {
  deriveKey,
  exportKeyB64,
  importKeyB64,
  encryptJSON,
  decryptJSON,
  bufToB64,
  b64ToBuf,
} from "./crypto.js";
import { sendNative } from "./native.js";
import { hostMatches, normalizeHost } from "./host.js";

const LOCAL_VAULT = "vault"; // { salt, iv, ct } in storage.local
const LOCAL_BIOWRAP = "bioWrap"; // { iv, ct } = vault key wrapped by the Touch ID key
const SESSION_KEY = "sessionKey"; // base64 raw AES key in storage.session

async function getRaw(area, key) {
  const r = await chrome.storage[area].get(key);
  return r[key];
}

export async function isInitialized() {
  return !!(await getRaw("local", LOCAL_VAULT));
}

export async function isUnlocked() {
  return !!(await getRaw("session", SESSION_KEY));
}

// Create a brand new empty vault protected by `password`. Leaves the vault unlocked.
export async function initVault(password) {
  if (await isInitialized()) throw new Error("ALREADY_INITIALIZED");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt.buffer);
  const payload = await encryptJSON(key, { entries: [] });
  await chrome.storage.local.set({
    [LOCAL_VAULT]: { salt: bufToB64(salt), ...payload },
  });
  await chrome.storage.session.set({ [SESSION_KEY]: await exportKeyB64(key) });
}

// Verify `password` against the stored vault and, on success, hold the key in session.
export async function unlock(password) {
  const vault = await getRaw("local", LOCAL_VAULT);
  if (!vault) throw new Error("NOT_INITIALIZED");
  const salt = b64ToBuf(vault.salt);
  const key = await deriveKey(password, salt);
  try {
    await decryptJSON(key, vault); // throws (OperationError) if the password is wrong
  } catch {
    throw new Error("WRONG_PASSWORD");
  }
  await chrome.storage.session.set({ [SESSION_KEY]: await exportKeyB64(key) });
}

export async function lock() {
  await chrome.storage.session.remove(SESSION_KEY);
}

async function getKey() {
  const b64 = await getRaw("session", SESSION_KEY);
  if (!b64) throw new Error("LOCKED");
  return importKeyB64(b64);
}

export async function getEntries() {
  const key = await getKey();
  const vault = await getRaw("local", LOCAL_VAULT);
  const data = await decryptJSON(key, vault);
  return data.entries || [];
}

export async function saveEntries(entries) {
  const key = await getKey();
  const vault = await getRaw("local", LOCAL_VAULT);
  const payload = await encryptJSON(key, { entries });
  await chrome.storage.local.set({
    [LOCAL_VAULT]: { salt: vault.salt, ...payload },
  });
}

// Delete everything (used by "reset" when the master password is forgotten).
export async function resetVault() {
  await chrome.storage.local.remove([LOCAL_VAULT, LOCAL_BIOWRAP]);
  await chrome.storage.session.remove(SESSION_KEY);
  await sendNative({ cmd: "reset" }).catch(() => {});
}

// --- Touch ID (Native Messaging) biometric unlock -------------------------
// Envelope design: the vault key (master-password-derived) is wrapped by a
// 32-byte key held behind Touch ID in the native host. Master password stays
// as the independent recovery path.

export async function isBioEnabled() {
  return !!(await getRaw("local", LOCAL_BIOWRAP));
}

// Enroll Touch ID and wrap the current vault key. Requires the vault unlocked.
export async function enableBio() {
  const sessionB64 = await getRaw("session", SESSION_KEY);
  if (!sessionB64) throw new Error("LOCKED");
  const resp = await sendNative({ cmd: "enroll" });
  if (!resp || resp.ok === false) throw new Error(resp?.error || "Touch ID 登録に失敗");
  const bioKey = await importKeyB64(resp.key);
  const wrap = await encryptJSON(bioKey, { v: sessionB64 });
  await chrome.storage.local.set({ [LOCAL_BIOWRAP]: wrap });
}

export async function disableBio() {
  await sendNative({ cmd: "reset" }).catch(() => {});
  await chrome.storage.local.remove(LOCAL_BIOWRAP);
}

// Unlock via Touch ID: native returns the bio key; unwrap the vault key into session.
export async function unlockWithBio() {
  const wrap = await getRaw("local", LOCAL_BIOWRAP);
  if (!wrap) throw new Error("BIO_NOT_ENABLED");
  const resp = await sendNative({ cmd: "unlock" });
  if (!resp || resp.ok === false) throw new Error(resp?.error || "Touch ID 認証に失敗");
  const bioKey = await importKeyB64(resp.key);
  let data;
  try {
    data = await decryptJSON(bioKey, wrap);
  } catch {
    // The native key changed (re-enrolled). Re-enable with the master password.
    await chrome.storage.local.remove(LOCAL_BIOWRAP);
    throw new Error("BIO_KEY_MISMATCH");
  }
  await chrome.storage.session.set({ [SESSION_KEY]: data.v });
}

// Find credentials for `host`. Exact matches win over wildcard matches.
// Throws "LOCKED" if the vault is locked (caller decides what to do).
export async function findCredentials(host) {
  const entries = await getEntries();
  let wildcard = null;
  for (const e of entries) {
    // Normalise the stored pattern too. Entries saved before v0.3.2 can hold a
    // pasted URL ("http://example.com/") that would never match, and the user
    // has no way to tell from the list why nothing fires.
    const pattern = normalizeHost(e.host);
    if (pattern === host) return { username: e.username, password: e.password };
    if (!wildcard && hostMatches(pattern, host)) wildcard = e;
  }
  return wildcard ? { username: wildcard.username, password: wildcard.password } : null;
}
