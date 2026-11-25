/**
 * Генерирует PNG-иконки расширения без внешних зависимостей.
 * Запуск: npm run icons
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'icons');
const SIZES = [16, 32, 48, 128];
const SS = 4; // суперсэмплинг 4×4

/* ---------- PNG ---------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- Геометрия ---------- */

const BOLT = [
  [0.6, 0.12],
  [0.3, 0.56],
  [0.47, 0.56],
  [0.4, 0.88],
  [0.73, 0.42],
  [0.55, 0.42],
];

function insideRoundedRect(x, y, size, radius) {
  const min = 0;
  const max = size;
  if (x < min || y < min || x > max || y > max) return false;
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function insidePolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function hex(value) {
  return [parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5, 7), 16)];
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = size * 0.255;
  const bolt = BOLT.map(([x, y]) => [x * size, y * size]);
  const from = hex('#86a0ff');
  const to = hex('#3a4de0');
  const samples = SS * SS;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let bgCoverage = 0;
      let boltCoverage = 0;

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = px + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;
          if (insideRoundedRect(x, y, size, radius)) {
            bgCoverage += 1;
            const jitter = ((x * 7 + y * 13) % 5) / 5; // мягкое зерно против бандинга
            if (insidePolygon(x + jitter * 0.05, y, bolt)) boltCoverage += 1;
          }
        }
      }

      const index = (py * size + px) * 4;
      if (bgCoverage === 0) {
        rgba[index + 3] = 0;
        continue;
      }

      const t = (px + py) / (2 * size);
      let r = mix(from[0], to[0], t);
      let g = mix(from[1], to[1], t);
      let b = mix(from[2], to[2], t);

      // Верхний блик.
      const glow = Math.max(0, 1 - py / (size * 0.55)) * 0.16;
      r = mix(r, 255, glow);
      g = mix(g, 255, glow);
      b = mix(b, 255, glow);

      const white = boltCoverage / samples;
      if (white > 0) {
        r = mix(r, 255, white);
        g = mix(g, 255, white);
        b = mix(b, 255, white);
      }

      rgba[index] = Math.round(r);
      rgba[index + 1] = Math.round(g);
      rgba[index + 2] = Math.round(b);
      rgba[index + 3] = Math.round((bgCoverage / samples) * 255);
    }
  }

  return encodePng(size, size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, renderIcon(size));
  console.log(`✓ ${file}`);
}
