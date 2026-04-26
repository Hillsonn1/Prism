// Reads build/icon.png and generates build/icon.ico + build/icon.icns.
// Applies slightly rounded corners (17% radius) with anti-aliasing before encoding.
// To update icons: replace build/icon.png with your 1024x1024 PNG and re-run.

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const BUILD_DIR = path.join(__dirname, '..', 'build');
if (!fs.existsSync(BUILD_DIR)) fs.mkdirSync(BUILD_DIR, { recursive: true });

// ── CRC32 + PNG chunk helpers ─────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crcBuf]);
}

// ── Placeholder PNG generator (only used when no icon.png exists) ─────────────

function makePlaceholderPNG(size) {
  const [r, g, b] = [59, 130, 246];
  const rowLen = 1 + size * 3;
  const raw = Buffer.alloc(rowLen * size);
  for (let y = 0; y < size; y++) {
    const base = y * rowLen;
    raw[base] = 0;
    for (let x = 0; x < size; x++) {
      raw[base + 1 + x * 3]     = r;
      raw[base + 1 + x * 3 + 1] = g;
      raw[base + 1 + x * 3 + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── PNG decoder ───────────────────────────────────────────────────────────────
// Handles color types 2 (RGB) and 6 (RGBA), 8-bit depth.
// Implements all 5 PNG filter types.

function decodePNG(buffer) {
  // Verify PNG signature
  const sig = [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a];
  for (let i = 0; i < 8; i++) {
    if (buffer[i] !== sig[i]) throw new Error('Not a valid PNG file');
  }

  let offset = 8;
  let width, height, bitDepth, colorType;
  const idatList = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type   = buffer.slice(offset + 4, offset + 8).toString('ascii');
    const data   = buffer.slice(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === 'IHDR') {
      width     = data.readUInt32BE(0);
      height    = data.readUInt32BE(4);
      bitDepth  = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idatList.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth: ${bitDepth}`);
  if (colorType !== 2 && colorType !== 6) throw new Error(`Unsupported PNG color type: ${colorType}`);

  const bpp    = colorType === 6 ? 4 : 3; // bytes per pixel in source
  const stride = 1 + width * bpp;          // filter byte + row data

  // Decompress all IDAT chunks together
  const raw = zlib.inflateSync(Buffer.concat(idatList));

  // Paeth predictor (PNG spec)
  function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  }

  // Reconstruct pixel rows by applying PNG filters
  const recon = Buffer.alloc(width * height * bpp);

  for (let y = 0; y < height; y++) {
    const filter  = raw[y * stride];
    const rowOff  = y * stride + 1;
    const dstOff  = y * width * bpp;
    const prevOff = (y - 1) * width * bpp;

    for (let i = 0; i < width * bpp; i++) {
      const x  = raw[rowOff + i];
      const a  = i >= bpp          ? recon[dstOff  + i - bpp] : 0;
      const b  = y > 0             ? recon[prevOff + i]        : 0;
      const c  = y > 0 && i >= bpp ? recon[prevOff + i - bpp]  : 0;

      let val;
      switch (filter) {
        case 0: val = x;                              break; // None
        case 1: val = x + a;                          break; // Sub
        case 2: val = x + b;                          break; // Up
        case 3: val = x + Math.floor((a + b) / 2);   break; // Average
        case 4: val = x + paeth(a, b, c);             break; // Paeth
        default: val = x;
      }
      recon[dstOff + i] = val & 0xff;
    }
  }

  return { width, height, colorType, bpp, recon };
}

// ── Apply rounded corners with anti-aliasing ──────────────────────────────────
// radiusFraction: corner radius as fraction of the shorter side (0.17 = 17%)

function applyRoundedCorners(pngBuffer, radiusFraction) {
  const { width, height, colorType, bpp, recon } = decodePNG(pngBuffer);
  const r = Math.round(Math.min(width, height) * radiusFraction);

  // Corner circle centres (one per corner)
  const corners = [
    { cx: r,         cy: r          }, // top-left
    { cx: width-1-r, cy: r          }, // top-right
    { cx: r,         cy: height-1-r }, // bottom-left
    { cx: width-1-r, cy: height-1-r }, // bottom-right
  ];

  // Anti-aliased alpha for a pixel at (x,y) given this corner's circle
  function cornerAlpha(x, y, cx, cy) {
    const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
    if (d <= r - 0.5) return 1;   // clearly inside
    if (d >= r + 0.5) return 0;   // clearly outside
    return r + 0.5 - d;           // smooth edge transition
  }

  // Build RGBA output buffer
  const rgba = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * bpp;
      const dst = (y * width + x) * 4;

      const pr = recon[src];
      const pg = recon[src + 1];
      const pb = recon[src + 2];
      const pa = bpp === 4 ? recon[src + 3] : 255;

      // Determine which corner (if any) this pixel belongs to, apply alpha
      let alpha = pa;
      if      (x <= r && y <= r)                 alpha = Math.round(pa * cornerAlpha(x, y, corners[0].cx, corners[0].cy));
      else if (x >= width-1-r && y <= r)         alpha = Math.round(pa * cornerAlpha(x, y, corners[1].cx, corners[1].cy));
      else if (x <= r && y >= height-1-r)        alpha = Math.round(pa * cornerAlpha(x, y, corners[2].cx, corners[2].cy));
      else if (x >= width-1-r && y >= height-1-r) alpha = Math.round(pa * cornerAlpha(x, y, corners[3].cx, corners[3].cy));

      rgba[dst]     = pr;
      rgba[dst + 1] = pg;
      rgba[dst + 2] = pb;
      rgba[dst + 3] = alpha;
    }
  }

  // Encode as RGBA PNG using filter 0 (None) — simple and lossless
  const rowSize = width * 4;
  const rawOut  = Buffer.alloc((1 + rowSize) * height);
  for (let y = 0; y < height; y++) {
    rawOut[y * (1 + rowSize)] = 0; // filter: None
    rgba.copy(rawOut, y * (1 + rowSize) + 1, y * rowSize, (y + 1) * rowSize);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width,  0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8]  = 8; // bit depth
  ihdr[9]  = 6; // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(rawOut)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Load or create icon.png ───────────────────────────────────────────────────

const iconPngPath = path.join(BUILD_DIR, 'icon.png');
let pngData;

if (fs.existsSync(iconPngPath)) {
  pngData = fs.readFileSync(iconPngPath);
  console.log('Using existing build/icon.png');
} else {
  pngData = makePlaceholderPNG(512);
  fs.writeFileSync(iconPngPath, pngData);
  console.log('No build/icon.png found — wrote blue placeholder.');
}

// Apply rounded corners (17% radius = pleasantly rounded, not extreme)
console.log('Applying rounded corners…');
pngData = applyRoundedCorners(pngData, 0.17);
console.log('Rounded corners applied.');

// ── icon.ico  (PNG-in-ICO, single entry marked as 256×256) ───────────────────

{
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: ICO
  header.writeUInt16LE(1, 4); // image count

  const dir = Buffer.alloc(16);
  dir[0] = 0;   // width:  0 = 256
  dir[1] = 0;   // height: 0 = 256
  dir[2] = 0;   // color count
  dir[3] = 0;   // reserved
  dir.writeUInt16LE(1,  4);             // planes
  dir.writeUInt16LE(32, 6);             // bits per pixel
  dir.writeUInt32LE(pngData.length, 8); // image data size
  dir.writeUInt32LE(22, 12);            // offset = 6 + 16

  fs.writeFileSync(path.join(BUILD_DIR, 'icon.ico'), Buffer.concat([header, dir, pngData]));
  console.log('Wrote build/icon.ico');
}

// ── icon.icns  (ic10 = 1024×1024 PNG chunk) ──────────────────────────────────

{
  const chunkType = Buffer.from('ic10');
  const chunkSize = Buffer.alloc(4);
  chunkSize.writeUInt32BE(8 + pngData.length);

  const fileSize = Buffer.alloc(4);
  fileSize.writeUInt32BE(8 + 8 + pngData.length);

  fs.writeFileSync(
    path.join(BUILD_DIR, 'icon.icns'),
    Buffer.concat([Buffer.from('icns'), fileSize, chunkType, chunkSize, pngData])
  );
  console.log('Wrote build/icon.icns');
}
