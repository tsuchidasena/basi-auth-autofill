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

const LOCAL_VAULT = "vault"; // { salt, iv, ct } in storage.local
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
  await chrome.storage.local.remove(LOCAL_VAULT);
  await chrome.storage.session.remove(SESSION_KEY);
}

// Match an entry host pattern against a request host ("host" includes port if non-default).
function hostMatches(pattern, host) {
  if (pattern === host) return true;
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2);
    // *.example.com matches a.example.com and example.com itself.
    return host === base || host.endsWith("." + base);
  }
  return false;
}

// Find credentials for `host`. Exact matches win over wildcard matches.
// Throws "LOCKED" if the vault is locked (caller decides what to do).
export async function findCredentials(host) {
  const entries = await getEntries();
  let wildcard = null;
  for (const e of entries) {
    if (e.host === host) return { username: e.username, password: e.password };
    if (!wildcard && hostMatches(e.host, host)) wildcard = e;
  }
  return wildcard ? { username: wildcard.username, password: wildcard.password } : null;
}
