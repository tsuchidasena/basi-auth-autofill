// WebCrypto helpers: PBKDF2 key derivation + AES-GCM encrypt/decrypt + base64.

const PBKDF2_ITERATIONS = 250000;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// Derive an extractable AES-GCM 256-bit key from a master password + salt.
export async function deriveKey(password, saltBuf) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBuf, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    true, // extractable so we can stash the raw key in storage.session
    ["encrypt", "decrypt"]
  );
}

export async function exportKeyB64(key) {
  return bufToB64(await crypto.subtle.exportKey("raw", key));
}

export async function importKeyB64(b64) {
  return crypto.subtle.importKey(
    "raw",
    b64ToBuf(b64),
    { name: "AES-GCM" },
    true,
    ["encrypt", "decrypt"]
  );
}

// Encrypt a JSON-serializable object -> { iv, ct } (both base64).
export async function encryptJSON(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = enc.encode(JSON.stringify(obj));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  return { iv: bufToB64(iv), ct: bufToB64(ct) };
}

// Decrypt a { iv, ct } payload back into an object. Throws if the key is wrong.
export async function decryptJSON(key, payload) {
  const iv = new Uint8Array(b64ToBuf(payload.iv));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, b64ToBuf(payload.ct));
  return JSON.parse(dec.decode(pt));
}

export { PBKDF2_ITERATIONS };
