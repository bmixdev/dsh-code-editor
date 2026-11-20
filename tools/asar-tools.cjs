// ASAR-aware inspection helper. Run with ELECTRON_RUN_AS_NODE=1 and the DSH Electron executable.
// usage: asar-tools.cjs list <dir> [limit]
//        asar-tools.cjs read <file> [maxBytes]
//        asar-tools.cjs grep <dir> <literalOrRegex> [maxFiles] [maxHits] [ext]
const fs = require('node:fs');
const path = require('node:path');

const [cmd, target, ...rest] = process.argv.slice(2);

function list(dir, limit) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries.slice(0, limit)) {
    const full = path.join(dir, entry.name);
    let size = '';
    if (entry.isFile()) {
      try { size = ` (${fs.statSync(full).size})`; } catch {}
    }
    console.log(`${entry.isDirectory() ? 'd' : '-'} ${entry.name}${size}`);
  }
  if (entries.length > limit) console.log(`... ${entries.length - limit} more`);
}

function read(file, maxBytes) {
  const buf = fs.readFileSync(file);
  const slice = buf.subarray(0, maxBytes);
  process.stdout.write(slice.toString('utf8'));
  if (buf.length > maxBytes) process.stderr.write(`\n[truncated at ${maxBytes} of ${buf.length} bytes]\n`);
}

function walk(dir, out, depth) {
  if (depth < 0 || out.length > 4000) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out, depth - 1);
    else out.push(full);
  }
  return out;
}

function grep(dir, pattern, maxFiles, maxHits, ext) {
  const needle = new RegExp(pattern, 'i');
  const files = walk(dir, [], 12);
  let scanned = 0;
  let hits = 0;
  for (const file of files) {
    if (ext && !file.endsWith(ext)) continue;
    let size;
    try { size = fs.statSync(file).size; } catch { continue; }
    if (size > 2 * 1024 * 1024) continue;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    scanned += 1;
    if (scanned > maxFiles) { console.log(`[stopped after ${maxFiles} files]`); return; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (!needle.test(lines[i])) continue;
      console.log(`${path.relative(dir, file)}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
      hits += 1;
      if (hits >= maxHits) { console.log(`[stopped after ${maxHits} hits]`); return; }
    }
  }
  console.log(`[scanned ${scanned} files, ${hits} hits]`);
}

switch (cmd) {
  case 'list': list(target, Number(rest[0] ?? 200)); break;
  case 'read': read(target, Number(rest[0] ?? 200000)); break;
  case 'grep': grep(target, rest[0], Number(rest[1] ?? 400), Number(rest[2] ?? 60), rest[3] ?? ''); break;
  default: console.error('unknown command'); process.exit(2);
}
