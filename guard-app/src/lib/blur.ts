import * as ImageManipulator from 'expo-image-manipulator';

// The decoder alone: the package index also loads the encoder, which is not needed here.
// `lib/decoder` exports the function itself (`module.exports = decode`), not `{ decode }` —
// destructuring it gave `undefined`, and every check silently came back "unchecked".
// eslint-disable-next-line @typescript-eslint/no-require-imports
const decode = require('jpeg-js/lib/decoder') as (
  data: Uint8Array,
  opts: { useTArray: true; formatAsRGBA?: boolean }
) => { width: number; height: number; data: Uint8Array };

/**
 * On-device blur check for document scans (PRD 18.11 / SUR-GAP-004: "blur rejection").
 *
 * The variance of the Laplacian of a small greyscale copy: sharp text has strong edges and a high
 * variance; a shaken or out-of-focus shot does not. It runs on a 320 px copy so it stays fast in
 * JavaScript. The threshold is conservative — a borderline photo is let through and the reviewer
 * still sees it — because rejecting a readable card is worse than accepting a soft one.
 */

const WIDTH = 320;
export const BLUR_THRESHOLD = Number(process.env.EXPO_PUBLIC_BLUR_THRESHOLD ?? 60);

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Uint8Array(256);
for (let i = 0; i < B64.length; i++) LOOKUP[B64.charCodeAt(i)] = i;

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i + 1 < clean.length; i += 4) {
    const a = LOOKUP[clean.charCodeAt(i)];
    const b = LOOKUP[clean.charCodeAt(i + 1)];
    const c = i + 2 < clean.length ? LOOKUP[clean.charCodeAt(i + 2)] : 0;
    const d = i + 3 < clean.length ? LOOKUP[clean.charCodeAt(i + 3)] : 0;
    out[o++] = (a << 2) | (b >> 4);
    if (i + 2 < clean.length) out[o++] = ((b & 15) << 4) | (c >> 2);
    if (i + 3 < clean.length) out[o++] = ((c & 3) << 6) | d;
  }
  return out.subarray(0, o);
}

/** Variance of the 4-neighbour Laplacian over an RGBA buffer. Exported for tests. */
export function laplacianVariance(rgba: Uint8Array, width: number, height: number): number {
  const grey = new Float32Array(width * height);
  for (let p = 0, i = 0; p < grey.length; p++, i += 4) {
    grey[p] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  }
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      const lap = grey[p - 1] + grey[p + 1] + grey[p - width] + grey[p + width] - 4 * grey[p];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** Mean luminance (0–255). Exported for tests. */
export function meanLuma(rgba: Uint8Array): number {
  let sum = 0;
  const n = rgba.length / 4;
  for (let i = 0; i < rgba.length; i += 4) sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  return n ? sum / n : 0;
}

/**
 * A photo that is almost black cannot be judged by sharpness at all: sensor noise in the dark
 * looks like edges and scores high. So darkness is its own verdict, checked first.
 */
export const DARK_THRESHOLD = 35;

export type PhotoQuality = { verdict: 'ok' | 'blurry' | 'dark' | 'unchecked'; score: number | null; brightness: number | null };

/** Never throws; `unchecked` when the check could not run, and callers then accept the photo. */
export async function photoQuality(uri: string): Promise<PhotoQuality> {
  try {
    const small = await ImageManipulator.manipulateAsync(uri, [{ resize: { width: WIDTH } }], {
      compress: 0.9,
      format: ImageManipulator.SaveFormat.JPEG,
      base64: true,
    });
    if (!small.base64) return { verdict: 'unchecked', score: null, brightness: null };
    const img = decode(base64ToBytes(small.base64), { useTArray: true, formatAsRGBA: true });
    const brightness = meanLuma(img.data);
    const score = laplacianVariance(img.data, img.width, img.height);
    const verdict = brightness < DARK_THRESHOLD ? 'dark' : score < BLUR_THRESHOLD ? 'blurry' : 'ok';
    return { verdict, score: Math.round(score), brightness: Math.round(brightness) };
  } catch {
    return { verdict: 'unchecked', score: null, brightness: null };
  }
}
