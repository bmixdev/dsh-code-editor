/**
 * The editor bundle ships its own copy of the shared host modules so it can be
 * installed from anywhere. This test keeps those copies byte-identical to the
 * repository root, which stays the single source of truth.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const moduleUrl = (name) => new URL(`../${name}`, import.meta.url)
const rootUrl = (name) => new URL(`../../${name}`, import.meta.url)

for (const name of ['catalog.js', 'completion.js', 'prefs.js', 'tree.js']) {
  test(`${name} inside editor/ matches the repository root`, async () => {
    const copy = await readFile(moduleUrl(name), 'utf8')
    const original = await readFile(rootUrl(name), 'utf8')
    assert.equal(
      copy,
      original,
      `editor/${name} drifted from ${name}: copy the root file again to keep one source of truth`,
    )
    assert.ok(fileURLToPath(moduleUrl(name)).endsWith(`editor/${name}`))
  })
}
