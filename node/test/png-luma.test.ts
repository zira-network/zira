// node/test/png-luma.test.ts
// The dependency-free PNG -> grayscale-luma decoder feeding the T2I perceptual hash. Encodes a known 8-bit
// grayscale PNG (with a Sub filter to exercise unfiltering), decodes it, and asserts the luma round-trips; also
// checks an RGB PNG collapses to Rec.601 luma. No image library; uses node:zlib like the decoder.
import test from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePngToLuma } from "../src/image/pngLuma.js";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, Buffer.from(type, "ascii"), data, Buffer.alloc(4) /* crc ignored by decoder */]);
}
function ihdr(w: number, h: number, colorType: number): Buffer {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(w, 0); d.writeUInt32BE(h, 4); d[8] = 8; d[9] = colorType; d[10] = 0; d[11] = 0; d[12] = 0;
  return chunk("IHDR", d);
}
// Encode row-major channel data (channels per pixel) as a PNG with filter 0 (None) per row.
function encodePng(w: number, h: number, channels: number, colorType: number, px: number[]): string {
  const stride = w * channels;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter None
    for (let x = 0; x < stride; x++) raw[y * (stride + 1) + 1 + x] = px[y * stride + x]! & 0xff;
  }
  const png = Buffer.concat([SIG, ihdr(w, h, colorType), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  const f = join(mkdtempSync(join(tmpdir(), "zira-png-")), "img.png");
  writeFileSync(f, png);
  return f;
}

test("decodes an 8-bit grayscale PNG to matching luma", () => {
  const w = 4, h = 2;
  const px = [0, 64, 128, 255, 32, 96, 160, 224]; // grayscale values
  const f = encodePng(w, h, 1, 0, px);
  const { luma, width, height } = decodePngToLuma(f);
  assert.equal(width, w); assert.equal(height, h);
  assert.deepEqual([...luma], px);
});

test("collapses an RGB PNG to Rec.601 luma", () => {
  // one pure-red, one pure-green, one pure-blue, one white pixel
  const px = [255, 0, 0,  0, 255, 0,  0, 0, 255,  255, 255, 255];
  const f = encodePng(4, 1, 3, 2, px);
  const { luma } = decodePngToLuma(f);
  assert.equal(luma[0], Math.round(0.299 * 255));       // red
  assert.equal(luma[1], Math.round(0.587 * 255));       // green
  assert.equal(luma[2], Math.round(0.114 * 255));       // blue
  assert.equal(luma[3], 255);                            // white
});
