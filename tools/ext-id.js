// Print the extension ID that Chrome derives from manifest.json's "key".
//
// Chrome's rule: SHA-256 the DER public key, take the first 16 bytes, and map
// each nibble 0-f onto a-p. Knowing the ID before loading the extension lets us
// fix `native/install.sh <ID>` and the README up front.
//
// Usage: node tools/ext-id.js [path/to/manifest.json]

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const manifestPath =
  process.argv[2] ??
  join(dirname(fileURLToPath(import.meta.url)), "..", "manifest.json");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (!manifest.key) {
  console.error(`no "key" field in ${manifestPath} — the ID is still path-derived.`);
  process.exit(1);
}

const der = Buffer.from(manifest.key, "base64");
const digest = createHash("sha256").update(der).digest();
const id = [...digest.subarray(0, 16)]
  .flatMap((b) => [b >> 4, b & 0x0f])
  .map((nibble) => String.fromCharCode(97 + nibble))
  .join("");

console.log(id);
