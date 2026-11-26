import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { listPlans, plansPath, readPlan, savePlan } from '../plans.js'

async function workspace() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-ide-plans-'))
  process.env.DSH_CODE_EDITOR_PLANS = path.join(directory, 'plans.json')
  return {
    directory,
    async cleanup() {
      delete process.env.DSH_CODE_EDITOR_PLANS
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test('a saved plan round-trips through the local file', async () => {
  const area = await workspace()
  try {
    const saved = await savePlan({
      title: 'src/app.js:1–3',
      text: 'Подготовь план\n\nsrc/app.js:1–3\n```js\nconst a = 1\n```\n',
      path: 'src/app.js',
      from: 1,
      to: 3,
    })
    assert.match(saved.id, /^[a-z0-9]+-[a-z0-9]+$/)
    assert.equal(saved.title, 'src/app.js:1–3')
    assert.equal(saved.path, 'src/app.js')
    assert.equal(saved.from, 1)
    assert.equal(saved.to, 3)

    const read = await readPlan(saved.id)
    assert.equal(read.text, 'Подготовь план\n\nsrc/app.js:1–3\n```js\nconst a = 1\n```\n')

    const listed = await listPlans()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].id, saved.id)
    assert.equal(plansPath().endsWith('plans.json'), true)
  } finally {
    await area.cleanup()
  }
})

test('the list is newest first', async () => {
  const area = await workspace()
  try {
    const first = await savePlan({ title: 'первый', text: 'один' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await savePlan({ title: 'второй', text: 'два' })
    const listed = await listPlans()
    assert.deepEqual(listed.map((plan) => plan.id), [second.id, first.id])
  } finally {
    await area.cleanup()
  }
})

test('an empty plan is refused', async () => {
  const area = await workspace()
  try {
    await assert.rejects(() => savePlan({ text: '   ' }), (error) => error.code === 'bad-request')
  } finally {
    await area.cleanup()
  }
})

test('an unknown plan id is not-found', async () => {
  const area = await workspace()
  try {
    await assert.rejects(() => readPlan('nope'), (error) => error.code === 'not-found')
    assert.deepEqual(await listPlans(), [])
  } finally {
    await area.cleanup()
  }
})
