#!/usr/bin/env node
/**
 * Pre-release manifest check.
 *
 * DSH reads `~/.dsh/profiles/<profile>/package.json` with `JSON.parse` straight
 * out of `readFileSync(path, 'utf8')`, and JavaScript's `JSON.parse` rejects a
 * leading BOM. A single `Set-Content -Encoding utf8` on Windows is enough to
 * brick the next start with `DesktopHostFatalError: Unexpected token '﻿'`, so
 * this script refuses to ship a repository or profile that carries one.
 *
 * Usage:
 *   node scripts/check-manifests.mjs            # repository + local DSH profile
 *   node scripts/check-manifests.mjs . <dir>    # only the given paths
 *   node scripts/check-manifests.mjs --no-dsh   # repository only
 *
 * Exit code 1 means at least one file has a BOM or invalid JSON.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const BOM = [0xef, 0xbb, 0xbf]
const TEXT_EXTENSIONS = new Set(['.json', '.yml', '.yaml', '.js', '.mjs', '.cjs', '.md', '.css', '.html', '.svg'])
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', 'vendor', 'coverage', '.tmp'])

const problems = []
let checked = 0

function report(file, message) {
  problems.push({ file, message })
}

function hasBom(buffer) {
  return buffer.length >= 3 && buffer[0] === BOM[0] && buffer[1] === BOM[1] && buffer[2] === BOM[2]
}

async function checkFile(file) {
  let buffer
  try {
    buffer = await readFile(file)
  } catch (error) {
    report(file, `не читается: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  checked += 1
  if (hasBom(buffer)) {
    report(file, 'UTF-8 BOM в начале файла: DSH читает манифест через JSON.parse и падает на нём')
  }
  if (path.extname(file) === '.json') {
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '')
    try {
      JSON.parse(text)
    } catch (error) {
      report(file, `невалидный JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

async function walk(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.tmp')) continue
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue
      await walk(absolute)
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      await checkFile(absolute)
    }
  }
}

/** Manifest files DSH itself parses at startup. */
async function checkDshHome() {
  const home = path.join(os.homedir(), '.dsh')
  for (const name of ['cordis.patch.yml']) {
    const file = path.join(home, name)
    try {
      await stat(file)
      await checkFile(file)
    } catch {
      // Optional file.
    }
  }
  const profiles = path.join(home, 'profiles')
  let entries
  try {
    entries = await readdir(profiles, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const manifest = path.join(profiles, entry.name, 'package.json')
    try {
      await stat(manifest)
      await checkFile(manifest)
    } catch {
      // A profile without a manifest is created on first run.
    }
  }
  const prefs = path.join(home, 'code-editor.json')
  try {
    await stat(prefs)
    await checkFile(prefs)
  } catch {
    // Written on the first saved setting.
  }
}

const args = process.argv.slice(2)
const flagNoDsh = args.includes('--no-dsh')
const targets = args.filter(argument => !argument.startsWith('--'))

for (const target of targets.length > 0 ? targets : ['.']) {
  const absolute = path.resolve(target)
  let info
  try {
    info = await stat(absolute)
  } catch {
    report(absolute, 'путь не найден')
    continue
  }
  if (info.isDirectory()) await walk(absolute)
  else await checkFile(absolute)
}

if (!flagNoDsh && targets.length === 0) await checkDshHome()

if (problems.length === 0) {
  console.log(`Манифесты в порядке: проверено файлов — ${checked}.`)
  process.exit(0)
}

for (const problem of problems) console.error(`${problem.file}: ${problem.message}`)
console.error(`\nПроблем: ${problems.length} (проверено файлов — ${checked}).`)
process.exit(1)
