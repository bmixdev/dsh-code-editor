import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { chooseRules, discoverRules, MAX_RULE_BYTES, rulePrompt } from '../rules.js'

async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-ide-rules-'))
  const write = async (relative, text) => {
    const target = path.join(root, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, text)
    return target
  }
  return { root, write, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('the chain runs from the workspace root to the file folder', async () => {
  const project = await workspace()
  try {
    await project.write('AGENTS.md', 'корневые правила\n')
    await project.write('src/CLAUDE.md', 'правила src\n')
    await project.write('src/deep/.cursor/rules/style.mdc', 'стиль deep\n')
    await project.write('src/deep/app.js', 'const a = 1\n')
    await project.write('src/other/AGENTS.md', 'чужая папка\n')
    const found = await discoverRules({ root: project.root, target: path.join(project.root, 'src/deep/app.js') })
    assert.equal(found.file, 'src/deep/app.js')
    assert.deepEqual(
      found.rules.map((rule) => rule.path),
      ['AGENTS.md', 'src/CLAUDE.md', 'src/deep/.cursor/rules/style.mdc'],
    )
    assert.deepEqual(
      found.rules.map((rule) => rule.dir),
      ['.', 'src', 'src/deep/.cursor/rules'],
    )
    assert.equal(found.truncated, false)
  } finally {
    await project.cleanup()
  }
})

test('a rule outside the workspace is refused instead of read', async () => {
  const project = await workspace()
  try {
    await assert.rejects(
      discoverRules({ root: project.root, target: path.join(project.root, '..', 'outside.md') }),
      (error) => error.code === 'bad-request',
    )
  } finally {
    await project.cleanup()
  }
})

test('a binary rule is skipped, not rendered as replacement text', async () => {
  const project = await workspace()
  try {
    await project.write('AGENTS.md', Buffer.from([0x41, 0x00, 0x42]))
    await project.write('src/app.js', 'x\n')
    const found = await discoverRules({ root: project.root, target: path.join(project.root, 'src/app.js') })
    assert.deepEqual(found.rules, [])
  } finally {
    await project.cleanup()
  }
})

test('an oversized rule is listed but never applied', async () => {
  const project = await workspace()
  try {
    await project.write('AGENTS.md', 'a'.repeat(MAX_RULE_BYTES + 1))
    await project.write('src/app.js', 'x\n')
    const found = await discoverRules({ root: project.root, target: path.join(project.root, 'src/app.js') })
    assert.equal(found.rules.length, 1)
    assert.equal(found.rules[0].oversized, true)
    const chosen = chooseRules(found.rules)
    assert.equal(chosen[0].applied, false)
    assert.equal(chosen[0].reason, 'size')
    assert.equal(chosen[0].text, '')
    assert.equal(rulePrompt(chosen), '')
  } finally {
    await project.cleanup()
  }
})

test('the total budget stops later rules and keeps the prompt honest', async () => {
  const project = await workspace()
  try {
    const chunk = 'b'.repeat(30 * 1024)
    await project.write('AGENTS.md', chunk)
    await project.write('src/CLAUDE.md', chunk)
    await project.write('src/deep/.cursorrules', chunk)
    await project.write('src/deep/app.js', 'x\n')
    const found = await discoverRules({ root: project.root, target: path.join(project.root, 'src/deep/app.js') })
    const chosen = chooseRules(found.rules)
    assert.deepEqual(chosen.map((rule) => rule.applied), [true, true, false])
    assert.equal(chosen[2].reason, 'limit')
    const prompt = rulePrompt(chosen)
    assert.match(prompt, /AGENTS\.md/)
    assert.match(prompt, /src\/CLAUDE\.md/)
    assert.doesNotMatch(prompt, /src\/deep\/\.cursorrules/)
  } finally {
    await project.cleanup()
  }
})

test('the applied text reaches the prompt without the skipped one', async () => {
  const project = await workspace()
  try {
    await project.write('AGENTS.md', 'Пиши тесты.\n')
    await project.write('src/.cursorrules', 'Не трогай README.\n')
    await project.write('src/app.js', 'x\n')
    const found = await discoverRules({ root: project.root, target: path.join(project.root, 'src/app.js') })
    const prompt = rulePrompt(chooseRules(found.rules))
    assert.match(prompt, /### AGENTS\.md\nПиши тесты\./)
    assert.match(prompt, /### src\/\.cursorrules\nНе трогай README\./)
  } finally {
    await project.cleanup()
  }
})
