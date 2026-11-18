// Packs the extension into dist/praxos-web-chats.zip: the file to upload to
// the Chrome Web Store, or to unzip and "Load unpacked" in chrome://extensions.
// No dependencies: a small zip writer over node:zlib.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = root;
const out = path.join(root, 'dist', 'praxos-web-chats.zip');
// What goes into the package: the extension's own files, nothing else from the repository.
const INCLUDE = ['manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.css', 'popup.js', 'lib', 'icons'];

function walk(dir, base = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((e) => {
    if (e.name.startsWith('.') || (!base && !INCLUDE.includes(e.name))) return [];
    const rel = base ? base + '/' + e.name : e.name;
    return e.isDirectory() ? walk(path.join(dir, e.name), rel) : [rel];
  });
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export function zip(files) {   // [{name, data: Buffer}] -> Buffer; a fixed date, so the same input gives the same bytes
  const DATE = ((2026 - 1980) << 9) | (1 << 5) | 1, TIME = 0;
  const locals = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const packed = zlib.deflateRawSync(f.data, { level: 9 });
    const crc = crc32(f.data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8);
    head.writeUInt16LE(TIME, 10); head.writeUInt16LE(DATE, 12); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(f.data.length, 22); head.writeUInt16LE(name.length, 26);
    locals.push(head, name, packed);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(TIME, 12); cen.writeUInt16LE(DATE, 14); cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(packed.length, 20); cen.writeUInt32LE(f.data.length, 24); cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += head.length + name.length + packed.length;
  }
  const cdir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdir, end]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const names = walk(src);
    if (!names.includes('manifest.json')) throw new Error('manifest.json is missing');
    const version = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8')).version;
    const data = zip(names.map((name) => ({ name, data: fs.readFileSync(path.join(src, name)) })));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
    fs.writeFileSync(path.join(path.dirname(out), 'version.json'), JSON.stringify({ version, files: names.length, bytes: data.length }, null, 2) + '\n');
    console.log(`extension ${version}: ${names.length} files, ${data.length} bytes -> ${path.relative(root, out)}`);
  } catch (e) {
    console.error('pack: ' + (e && e.message));
    process.exit(1);
  }
}
