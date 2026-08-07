// Generate the extension icons (16 / 48 / 128 px PNG) into icons/.
//
// Written by hand rather than pulled from a design tool so the repo stays
// dependency-free: Node's zlib is the only thing needed to emit a PNG.
// Re-run with `node tools/gen-icons.js` after changing PALETTE or the shape.
//
// Shape: rounded square in the brand blue, a white padlock centred on it.

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");
const SIZES = [16, 48, 128];

const PALETTE = {
  bg: [37, 99, 235, 255], // blue-600
  fg: [255, 255, 255, 255],
};

// --- PNG encoding ---------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// rgba: Uint8Array of size*size*4
function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 = compression / filter / interlace, all 0

  // Each scanline is prefixed with filter type 0 (None).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const off = y * (size * 4 + 1);
    raw[off] = 0;
    rgba.copy ? rgba.copy(raw, off + 1, y * size * 4, (y + 1) * size * 4)
      : Buffer.from(rgba.subarray(y * size * 4, (y + 1) * size * 4)).copy(raw, off + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- Drawing --------------------------------------------------------------

// Supersample 4x so the curves do not alias into mush at 16px.
const SS = 4;

function draw(size) {
  const n = size * SS;
  const acc = new Float32Array(size * size * 4);

  const cx = n / 2;
  const radius = n * 0.22; // corner radius of the background square

  // Padlock geometry, all relative to the icon box.
  const bodyW = n * 0.46;
  const bodyH = n * 0.34;
  const bodyX = cx - bodyW / 2;
  const bodyY = n * 0.50;
  const bodyR = n * 0.06;

  const shackleCy = bodyY;
  const shackleOuter = n * 0.19;
  const shackleInner = n * 0.11;

  const keyholeCy = bodyY + bodyH * 0.36;
  const keyholeR = n * 0.05;

  const inRoundRect = (x, y, rx, ry, rw, rh, r) => {
    if (x < rx || y < ry || x > rx + rw || y > ry + rh) return false;
    const dx = Math.min(Math.max(x, rx + r), rx + rw - r);
    const dy = Math.min(Math.max(y, ry + r), ry + rh - r);
    return (x - dx) ** 2 + (y - dy) ** 2 <= r * r || (x >= rx + r && x <= rx + rw - r) || (y >= ry + r && y <= ry + rh - r);
  };

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const px = x + 0.5;
      const py = y + 0.5;

      let colour = null;

      if (inRoundRect(px, py, 0, 0, n, n, radius)) colour = PALETTE.bg;

      // Shackle: upper half of an annulus, plus the two straight legs down to the body.
      const d = Math.hypot(px - cx, py - shackleCy);
      const inAnnulus = d <= shackleOuter && d >= shackleInner;
      const inArc = inAnnulus && py <= shackleCy;
      const inLeg =
        py > shackleCy &&
        py <= bodyY &&
        ((px >= cx - shackleOuter && px <= cx - shackleInner) ||
          (px >= cx + shackleInner && px <= cx + shackleOuter));
      if (inArc || inLeg) colour = PALETTE.fg;

      if (inRoundRect(px, py, bodyX, bodyY, bodyW, bodyH, bodyR)) colour = PALETTE.fg;

      // Keyhole punched back out of the body.
      if (Math.hypot(px - cx, py - keyholeCy) <= keyholeR) colour = PALETTE.bg;

      if (!colour) continue;
      const si = ((y / SS) | 0) * size + ((x / SS) | 0);
      acc[si * 4] += colour[0];
      acc[si * 4 + 1] += colour[1];
      acc[si * 4 + 2] += colour[2];
      acc[si * 4 + 3] += colour[3];
    }
  }

  const out = Buffer.alloc(size * size * 4);
  const per = SS * SS;
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = Math.round(acc[i * 4] / per);
    out[i * 4 + 1] = Math.round(acc[i * 4 + 1] / per);
    out[i * 4 + 2] = Math.round(acc[i * 4 + 2] / per);
    out[i * 4 + 3] = Math.round(acc[i * 4 + 3] / per);
  }
  // Un-premultiply: the accumulator averaged colour against transparent pixels,
  // which darkens the edge. Rescale RGB by coverage so edges stay the right hue.
  for (let i = 0; i < size * size; i++) {
    const a = out[i * 4 + 3];
    if (a === 0 || a === 255) continue;
    const k = 255 / a;
    out[i * 4] = Math.min(255, Math.round(out[i * 4] * k));
    out[i * 4 + 1] = Math.min(255, Math.round(out[i * 4 + 1] * k));
    out[i * 4 + 2] = Math.min(255, Math.round(out[i * 4 + 2] * k));
  }
  return out;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, encodePNG(size, draw(size)));
  console.log(`wrote ${file}`);
}
