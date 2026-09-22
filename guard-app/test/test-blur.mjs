/**
 * Sanity check for the document blur threshold: a sharp synthetic "text" image must score above
 * it, and the same image blurred must score below. Uses the same Laplacian as src/lib/blur.ts
 * (re-implemented here because that file imports Expo modules).
 *
 *   node test/test-blur.mjs
 */
import jpeg from 'jpeg-js';

const THRESHOLD = 60;
const W = 320;
const H = 200;

function laplacianVariance(rgba, width, height) {
  const grey = new Float32Array(width * height);
  for (let p = 0, i = 0; p < grey.length; p++, i += 4) grey[p] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      const lap = grey[p - 1] + grey[p + 1] + grey[p - width] + grey[p + width] - 4 * grey[p];
      sum += lap; sumSq += lap * lap; n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

// A card: light background, rows of dark "glyph" strokes, like printed text.
function card() {
  const g = new Uint8Array(W * H).fill(225);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let row = 20; row < H - 20; row += 22) {
    for (let x = 16; x < W - 16; x += 7) {
      if (rnd() < 0.2) continue;
      const h = 8 + Math.floor(rnd() * 5);
      for (let y = row; y < row + h; y++) for (let dx = 0; dx < 2; dx++) g[y * W + x + dx] = 40;
      for (let dx = 0; dx < 5; dx++) g[(row + Math.floor(rnd() * h)) * W + x + dx] = 40;
    }
  }
  return g;
}

function boxBlur(g, radius) {
  const out = new Uint8Array(g.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0, n = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy >= 0 && yy < H && xx >= 0 && xx < W) { s += g[yy * W + xx]; n++; }
        }
      }
      out[y * W + x] = s / n;
    }
  }
  return out;
}

// Round-trip through JPEG at the app's quality, as the phone would.
function viaJpeg(g) {
  const rgba = Buffer.alloc(W * H * 4);
  for (let p = 0; p < g.length; p++) { rgba[p * 4] = rgba[p * 4 + 1] = rgba[p * 4 + 2] = g[p]; rgba[p * 4 + 3] = 255; }
  const enc = jpeg.encode({ data: rgba, width: W, height: H }, 90);
  const dec = jpeg.decode(new Uint8Array(enc.data), { useTArray: true, formatAsRGBA: true });
  return laplacianVariance(dec.data, dec.width, dec.height);
}

const sharp = card();
const scores = {
  sharp: viaJpeg(sharp),
  slightBlur: viaJpeg(boxBlur(sharp, 1)),
  blurred: viaJpeg(boxBlur(sharp, 3)),
  veryBlurred: viaJpeg(boxBlur(sharp, 5)),
};
console.log(Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, Math.round(v)])));

let fail = 0;
const check = (name, ok) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) fail++; };
check('sharp card passes', scores.sharp >= THRESHOLD);
check('slightly soft card still passes (never reject a readable card)', scores.slightBlur >= THRESHOLD);
check('blurred card is caught', scores.blurred < THRESHOLD);
check('very blurred card is caught', scores.veryBlurred < THRESHOLD);
// A covered lens: nearly black with sensor noise. Sharpness alone scores the noise as detail,
// which is why the app checks brightness first (DARK_THRESHOLD in src/lib/blur.ts).
const DARK_THRESHOLD = 35;
let seed2 = 11;
const noise = () => ((seed2 = (seed2 * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const dark = new Uint8Array(W * H).map(() => Math.round(6 + (noise() - 0.5) * 12));
const rgbaDark = Buffer.alloc(W * H * 4);
for (let p = 0; p < dark.length; p++) { rgbaDark[p * 4] = rgbaDark[p * 4 + 1] = rgbaDark[p * 4 + 2] = dark[p]; rgbaDark[p * 4 + 3] = 255; }
const decDark = jpeg.decode(new Uint8Array(jpeg.encode({ data: rgbaDark, width: W, height: H }, 90).data), { useTArray: true, formatAsRGBA: true });
let sum = 0;
for (let i = 0; i < decDark.data.length; i += 4) sum += decDark.data[i];
const darkMean = sum / (W * H);
console.log({ darkSharpness: Math.round(laplacianVariance(decDark.data, W, H)), darkMean: Math.round(darkMean) });
check('dark noisy photo is caught by brightness', darkMean < DARK_THRESHOLD);
check('a normal card is not "dark"', (() => { let s = 0; for (const v of sharp) s += v; return s / sharp.length >= DARK_THRESHOLD; })());

// The app loads the decoder as `require('jpeg-js/lib/decoder')` and calls the result directly.
// This once was destructured as `{ decode }`, which is undefined — guard the shape here.
{
  const { createRequire } = await import('module');
  const req = createRequire(import.meta.url);
  const direct = req('jpeg-js/lib/decoder');
  check('jpeg-js/lib/decoder exports the decode function itself', typeof direct === 'function');
  const img = direct(new Uint8Array(jpeg.encode({ data: rgbaDark, width: W, height: H }, 90).data), { useTArray: true, formatAsRGBA: true });
  check('direct decoder decodes', img.width === W && img.data.length === W * H * 4);
}

process.exit(fail ? 1 : 0);
