// Plain-Node ASAR reader (no Electron needed).
// usage: node asar-extract.cjs <archive> list <dirInArchive> [limit]
//        node asar-extract.cjs <archive> read <fileInArchive> [maxBytes]
//        node asar-extract.cjs <archive> grep <dirInArchive> <regexSource> [maxFiles] [maxHits] [extFilter]
//        node asar-extract.cjs <archive> extract <prefix> <outDir>
const fs = require('node:fs');
const path = require('node:path');

const [, , archivePath, cmd, target, ...rest] = process.argv;
if (!archivePath || !cmd) {
  console.error('usage: node asar-extract.cjs <archive> <list|read|grep|extract> ...');
  process.exit(2);
}

const fd = fs.openSync(archivePath, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerPickleSize = head.readUInt32LE(0);
if (headerPickleSize !== 4) throw new Error(`unexpected asar pickle size ${headerPickleSize}`);
const headerBlockSize = head.readUInt32LE(4);
const block = Buffer.alloc(headerBlockSize);
fs.readSync(fd, block, 0, headerBlockSize, 8);
const start = block.indexOf('{');
const end = block.lastIndexOf('}');
if (start < 0 || end <= start) throw new Error('asar header JSON not found');
const header = JSON.parse(block.subarray(start, end + 1).toString('utf8'));
const baseOffset = 8 + headerBlockSize;

function resolveEntry(archiveDir) {
  const parts = archiveDir.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.');
  let node = header;
  for (const part of parts) {
    if (!node.files || !node.files[part]) return undefined;
    node = node.files[part];
  }
  return node;
}

function listDir(dirInArchive, limit) {
  const node = dirInArchive ? resolveEntry(dirInArchive) : header;
  if (!node || !node.files) throw new Error(`not a directory: ${dirInArchive}`);
  const names = Object.keys(node.files);
  for (const name of names.slice(0, limit)) {
    const child = node.files[name];
    const tag = child.files ? 'd' : '-';
    const size = child.size === undefined ? '' : ` (${child.size})`;
    console.log(`${tag} ${name}${size}`);
  }
  if (names.length > limit) console.log(`... ${names.length - limit} more`);
}

function readFileBytes(fileInArchive) {
  const node = resolveEntry(fileInArchive);
  if (!node || node.files) throw new Error(`not a file: ${fileInArchive}`);
  if (node.unpacked) throw new Error(`unpacked file, read from app.asar.unpacked: ${fileInArchive}`);
  const buf = Buffer.alloc(node.size);
  fs.readSync(fd, buf, 0, node.size, baseOffset + Number(node.offset));
  return buf;
}

function readText(fileInArchive, maxBytes) {
  const buf = readFileBytes(fileInArchive);
  process.stdout.write(buf.subarray(0, maxBytes).toString('utf8'));
  if (buf.length > maxBytes) process.stderr.write(`\n[truncated at ${maxBytes} of ${buf.length} bytes]\n`);
}

function walkArchive(dirInArchive, prefix, out, depth) {
  if (depth < 0) return out;
  const node = dirInArchive ? resolveEntry(dirInArchive) : header;
  if (!node || !node.files) return out;
  for (const [name, child] of Object.entries(node.files)) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (child.files) walkArchive(rel, rel, out, depth - 1);
    else out.push(rel);
  }
  return out;
}

function grepArchive(dirInArchive, patternSource, maxFiles, maxHits, extFilter) {
  const needle = new RegExp(patternSource);
  const targetNode = resolveEntry(dirInArchive);
  const files = targetNode && !targetNode.files ? [dirInArchive] : walkArchive(dirInArchive, dirInArchive, [], 12);
  let scanned = 0;
  let hits = 0;
  for (const rel of files) {
    if (extFilter && !rel.endsWith(extFilter)) continue;
    const node = resolveEntry(rel);
    if (!node || node.unpacked || node.size > 2 * 1024 * 1024) continue;
    let text;
    try { text = readFileBytes(rel).toString('utf8'); } catch { continue; }
    scanned += 1;
    if (scanned > maxFiles) { console.log(`[stopped after ${maxFiles} files]`); return; }
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (!needle.test(lines[index])) continue;
      console.log(`${rel}:${index + 1}: ${lines[index].trim().slice(0, 240)}`);
      hits += 1;
      if (hits >= maxHits) { console.log(`[stopped after ${maxHits} hits]`); return; }
    }
  }
  console.log(`[scanned ${scanned} files, ${hits} hits]`);
}

function extractTree(prefix, outDir) {
  const files = walkArchive(prefix, prefix, [], 24);
  let written = 0;
  for (const rel of files) {
    const node = resolveEntry(rel);
    if (!node || node.unpacked) continue;
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, readFileBytes(rel));
    written += 1;
  }
  console.log(`extracted ${written} files into ${outDir}`);
}

try {
  switch (cmd) {
    case 'list': listDir(target ?? '', Number(rest[0] ?? 300)); break;
    case 'read': readText(target, Number(rest[0] ?? 200000)); break;
    case 'grep': grepArchive(target ?? '', rest[0] ?? '.', Number(rest[1] ?? 400), Number(rest[2] ?? 60), rest[3] ?? ''); break;
    case 'extract': extractTree(target ?? '', rest[0] ?? 'app-asar'); break;
    default: console.error('unknown command'); process.exit(2);
  }
} finally {
  fs.closeSync(fd);
}
