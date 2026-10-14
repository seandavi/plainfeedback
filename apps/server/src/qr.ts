// QR codes for survey links (issue #9). Pure JS and Web-API only (no node: imports, no Buffer), so it
// runs unchanged on Workers. SVG comes from uqr; PNG is hand-encoded below with stored (uncompressed)
// deflate blocks so it needs no zlib. A 1-bit QR image is a few KB at most, so compression is moot.
import { encode, renderSVG } from "uqr";

const OPTS = { ecc: "M", border: 4 } as const; // error correction M, 4-module quiet zone (QR spec)

export const qrSvg = (text: string) => renderSVG(text, OPTS);

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (const x of b) c = (crcTable[(c ^ x) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const be32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (type: string, data: Uint8Array) => {
  const body = new Uint8Array([...new TextEncoder().encode(type), ...data]);
  return new Uint8Array([...be32(data.length), ...body, ...be32(crc32(body))]);
};

/** Black-on-white 1-bit PNG, each module an integer number of pixels, at most `size` px wide. */
export const qrPng = (text: string, size: number) => {
  const { data: m } = encode(text, OPTS); // m includes the quiet zone
  const scale = Math.max(1, Math.floor(size / m.length));
  const px = m.length * scale;
  const stride = Math.ceil(px / 8) + 1; // + filter byte
  const raw = new Uint8Array(stride * px).fill(0xff); // 1 = white; filter byte 0 = none
  for (let y = 0; y < px; y++) {
    raw[y * stride] = 0;
    const row = m[Math.floor(y / scale)] as boolean[];
    for (let x = 0; x < px; x++) {
      if (row[Math.floor(x / scale)])
        raw[y * stride + 1 + (x >> 3)] =
          (raw[y * stride + 1 + (x >> 3)] as number) & ~(0x80 >> (x & 7));
    }
  }
  // zlib wrapper: header, stored blocks of <= 65535 bytes, Adler-32.
  const z: number[] = [0x78, 0x01];
  for (let i = 0; i < raw.length || i === 0; i += 65535) {
    const part = raw.subarray(i, i + 65535);
    const last = i + 65535 >= raw.length ? 1 : 0;
    z.push(
      last,
      part.length & 255,
      part.length >> 8,
      ~part.length & 255,
      (~part.length >> 8) & 255,
    );
    for (const b of part) z.push(b);
  }
  let a = 1;
  let b = 0;
  for (const x of raw) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  z.push(...be32(((b << 16) | a) >>> 0));
  const ihdr = new Uint8Array([...be32(px), ...be32(px), 1, 0, 0, 0, 0]); // 1-bit grayscale
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(z)),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
