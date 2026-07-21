// node/src/image/pngLuma.ts
// Minimal, dependency-free PNG -> grayscale-luma decoder for the text-to-image engine (2.9.0 Track A). The SD
// subprocess writes a PNG; the provider needs its pixels as grayscale luma to compute the protocol perceptual
// hash (dHash). Uses Node's built-in zlib (no image library, so it bundles trivially). Supports the 8-bit
// PNGs stable-diffusion.cpp emits: grayscale / grayscale+alpha / RGB / RGBA, non-interlaced. CRCs are not
// verified (we only need the pixels; the file came from our own subprocess).
import { inflateSync } from "node:zlib";
import { readFileSync } from "node:fs";

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decode a non-interlaced 8-bit PNG file to row-major grayscale luma (Rec.601). Throws on unsupported forms. */
export function decodePngToLuma(file: string): { luma: Uint8Array; width: number; height: number } {
  const buf = readFileSync(file);
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) throw new Error("not a PNG");
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat: Buffer[] = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0; colorType = data[9] ?? 0; interlace = data[12] ?? 0;
    } else if (type === "IDAT") idat.push(Buffer.from(data));
    else if (type === "IEND") break;
    pos += 12 + len; // 4 len + 4 type + len data + 4 crc (crc skipped)
  }
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error("interlaced PNG not supported");
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (!channels || !width || !height) throw new Error(`unsupported PNG color type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = channels, stride = width * bpp;
  const out = new Uint8Array(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++] ?? 0;
    for (let x = 0; x < stride; x++) {
      const cur = raw[rp++] ?? 0;
      const a = x >= bpp ? out[y * stride + x - bpp]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp]! : 0;
      let val: number;
      switch (filter) {
        case 0: val = cur; break;
        case 1: val = cur + a; break;
        case 2: val = cur + b; break;
        case 3: val = cur + ((a + b) >> 1); break;
        case 4: val = cur + paeth(a, b, c); break;
        default: throw new Error(`bad PNG filter ${filter}`);
      }
      out[y * stride + x] = val & 0xff;
    }
  }

  const luma = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const o = y * stride + x * bpp;
    luma[y * width + x] = (channels <= 2)
      ? (out[o] ?? 0)
      : Math.round(0.299 * (out[o] ?? 0) + 0.587 * (out[o + 1] ?? 0) + 0.114 * (out[o + 2] ?? 0)) & 0xff;
  }
  return { luma, width, height };
}
