// Génère de petites icônes PNG "bol Maju" (cercle coupé en 1/2-1/4-1/4)
// sans dépendance externe : encodeur PNG minimal maison (zlib du cœur de Node).
const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");

const CREAM = [251, 241, 228];
const INK = [43, 38, 33];
const SAGE = [123, 148, 87];
const TERRACOTTA = [232, 115, 74];
const SUN = [242, 183, 5];

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // no filter
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

function makeBowlIcon(size, { withWedges = true, padding = 0.5 } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const set = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
  };

  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, CREAM);

  const cx = size / 2;
  const cy = size / 2;
  const R = size * 0.36 * padding * 2;
  const ringR = R + size * 0.02;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= ringR) {
        if (dist > R) {
          set(x, y, INK);
          continue;
        }
        if (!withWedges) {
          set(x, y, TERRACOTTA);
          continue;
        }
        let angle = Math.atan2(dy, dx); // -PI..PI, 0 = right, clockwise with +y down
        angle = (angle + Math.PI * 2.5) % (Math.PI * 2); // rotate so 0 = top, going clockwise
        if (angle < Math.PI) {
          set(x, y, SAGE); // 1/2 légumes
        } else if (angle < Math.PI * 1.5) {
          set(x, y, TERRACOTTA); // 1/4 protéines
        } else {
          set(x, y, SUN); // 1/4 féculents
        }
      }
    }
  }
  return encodePNG(size, size, buf);
}

const outDir = path.join(__dirname, "..", "public", "icons");
fs.mkdirSync(outDir, { recursive: true });

fs.writeFileSync(path.join(outDir, "icon-512.png"), makeBowlIcon(512));
fs.writeFileSync(path.join(outDir, "icon-192.png"), makeBowlIcon(192));
fs.writeFileSync(path.join(outDir, "icon-maskable-512.png"), makeBowlIcon(512, { padding: 0.72 }));
fs.writeFileSync(path.join(outDir, "apple-touch-icon.png"), makeBowlIcon(180));
fs.writeFileSync(path.join(outDir, "favicon-32.png"), makeBowlIcon(32, { withWedges: false }));

console.log("Icônes générées dans public/icons/");
