// Measures the existing literal search against a one-shot in-memory line
// index. This is the comparison required before deciding whether the editor
// should keep a search index: run `node bench/search-compare.mjs`.
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { searchText } from '../search.js'

const FILES = Number(process.argv[2] ?? 1000)
const LINES = Number(process.argv[3] ?? 70)
const REPEATS = 3
const QUERIES = ['needle', 'value_17', 'ordinary line 42']

const ctx = {
  fs: {
    resolve: async (target) => path.resolve(String(target)),
    processPath: (target) => String(target),
    contains: (root, target) => {
      const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`
      return target === root || target.startsWith(prefix)
    },
  },
}

const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-search-bench-'))

function source(index) {
  const rows = []
  for (let line = 0; line < LINES; line += 1) {
    rows.push(
      line % 9 === 0
        ? `export const value_${index}_${line} = compute(${line}, "needle") // branch ${line}`
        : `  return table[${line}] + offset_${line} * ${index} // ordinary line ${line}`,
    )
  }
  return `${rows.join('\n')}\n`
}

for (let index = 0; index < FILES; index += 1) {
  const directory = path.join(root, `pkg${index % 20}`, `mod${index % 7}`)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, `file${index}.ts`), source(index))
}

const SKIP = new Set(['node_modules', '.git', '.hg', '.svn', '.cache'])

async function buildIndex(directory, out) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) await buildIndex(target, out)
    else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push({
        path: path.relative(root, target).split(path.sep).join('/'),
        lines: (await readFile(target, 'utf8')).split('\n'),
      })
    }
  }
  return out
}

function queryIndex(index, needle) {
  let hits = 0
  for (const file of index) {
    for (const line of file.lines) if (line.toLowerCase().includes(needle)) hits += 1
  }
  return hits
}

async function timed(fn) {
  const started = process.hrtime.bigint()
  const value = await fn()
  return { ms: Number(process.hrtime.bigint() - started) / 1e6, value }
}

const report = { files: FILES, lines: FILES * LINES, bytes: 0, indexBuildMs: 0, plain: [], indexed: [] }

try {
  const total = await timed(async () => {
    let bytes = 0
    const walk = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue
        const target = path.join(directory, entry.name)
        if (entry.isDirectory()) await walk(target)
        else if (entry.isFile() && entry.name.endsWith('.ts')) bytes += (await readFile(target)).byteLength
      }
    }
    await walk(root)
    return bytes
  })
  report.bytes = total.value

  await searchText(ctx, { cwd: root, query: 'warmup' })
  for (const query of QUERIES) {
    for (let repeat = 0; repeat < REPEATS; repeat += 1) {
      const result = await timed(() => searchText(ctx, { cwd: root, query }))
      report.plain.push({
        query,
        repeat,
        ms: Number(result.ms.toFixed(1)),
        matches: result.value.matches.length,
        scannedBytes: result.value.bytes,
      })
    }
  }

  const built = await timed(() => buildIndex(root, []))
  report.indexBuildMs = Number(built.ms.toFixed(1))
  for (const query of QUERIES) {
    for (let repeat = 0; repeat < REPEATS; repeat += 1) {
      const result = await timed(() => queryIndex(built.value, query.toLowerCase()))
      report.indexed.push({ query, repeat, ms: Number(result.ms.toFixed(1)), matches: result.value })
    }
  }

  console.log(JSON.stringify(report, null, 2))
} finally {
  await rm(root, { recursive: true, force: true })
}
