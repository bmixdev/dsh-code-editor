/**
 * Saved plan drafts: the small, machine-local history behind
 * «Подготовить план…» → «Сохранить план…» → «Открыть план…».
 *
 * A plan is the text the IDE already puts into the chat composer, kept so it
 * can be reopened later or handed to another open session. The file is a
 * single JSON document next to the other DSH state; nothing here talks to a
 * model, Git, or the workspace.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Most plans kept; the oldest entries are dropped beyond it. */
export const MAX_PLANS = 50

/** Longest plan text accepted, in characters. */
export const MAX_PLAN_CHARS = 32000

/** Longest title shown in the list. */
const MAX_TITLE_CHARS = 160

/** Absolute path of the plans file, overridable for tests and portable profiles. */
export function plansPath() {
  const override = process.env.DSH_CODE_EDITOR_PLANS
  if (typeof override === 'string' && override.trim() !== '') return path.resolve(override)
  return path.join(os.homedir(), '.dsh', 'code-editor-plans.json')
}

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function clean(value, max) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  return text.length > max ? text.slice(0, max) : text
}

async function readDocument() {
  let raw
  try {
    raw = await readFile(plansPath(), 'utf8')
  } catch (cause) {
    if (cause && cause.code === 'ENOENT') return { plans: [] }
    throw fail('plans-failed', `Не удалось прочитать сохранённые планы: ${cause.message}`)
  }
  try {
    const parsed = JSON.parse(raw)
    const plans = Array.isArray(parsed?.plans) ? parsed.plans : []
    return { plans }
  } catch {
    return { plans: [] }
  }
}

async function writeDocument(document) {
  const file = plansPath()
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

function view(plan) {
  return {
    id: plan.id,
    title: plan.title,
    path: plan.path,
    from: plan.from,
    to: plan.to,
    chars: typeof plan.text === 'string' ? plan.text.length : 0,
    createdAt: plan.createdAt,
  }
}

/** List saved plans, newest first. */
export async function listPlans() {
  const document = await readDocument()
  return document.plans
    .filter((plan) => plan && typeof plan.id === 'string' && typeof plan.text === 'string')
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map(view)
}

/** Read one saved plan by id. */
export async function readPlan(id) {
  if (typeof id !== 'string' || id === '') throw fail('bad-request', 'Не указан план.')
  const document = await readDocument()
  const plan = document.plans.find((candidate) => candidate && candidate.id === id)
  if (plan === undefined || typeof plan.text !== 'string') throw fail('not-found', 'План не найден.')
  return { ...view(plan), text: plan.text }
}

/** Save one plan draft and return its stored view. */
export async function savePlan(input = {}) {
  const text = typeof input.text === 'string' ? input.text : ''
  const trimmed = text.trim()
  if (trimmed === '') throw fail('bad-request', 'План пуст.')
  if (text.length > MAX_PLAN_CHARS) throw fail('too-large', `План длиннее ${MAX_PLAN_CHARS} символов.`)
  const title = clean(input.title, MAX_TITLE_CHARS) || clean(input.path, MAX_TITLE_CHARS) || 'План'
  const plan = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    path: clean(input.path, 2048),
    from: Number.isFinite(Number(input.from)) ? Number(input.from) : 0,
    to: Number.isFinite(Number(input.to)) ? Number(input.to) : 0,
    text,
    createdAt: new Date().toISOString(),
  }
  const document = await readDocument()
  const plans = [plan, ...document.plans].slice(0, MAX_PLANS)
  await writeDocument({ version: 1, plans })
  return view(plan)
}
