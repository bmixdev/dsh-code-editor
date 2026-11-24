/**
 * Bounded index of the `workspace/changes` turns announced by live Sessions.
 *
 * The file snapshots live in the Host's `workspaceChanges` recorder; this module
 * only remembers WHICH turns exist, so the changes panel can list and open them
 * without keeping a second copy of anybody's file contents in process memory.
 * A disposed Session or an older Host drops out on its own: the recorder then
 * answers `undefined` for that turn and the index forgets it.
 */

/** How many turns of one Session stay reachable from the panel. */
export const MAX_TURNS_PER_SESSION = 20

const failure = (code, message) => Object.assign(new Error(message), { code })

const isRecord = (value) => value !== null && typeof value === 'object'

const count = (value, fallback) => (Number.isSafeInteger(value) && value >= 0 ? value : fallback)

/**
 * @param {object} options
 * @param {object} [options.recorder] the Host `workspaceChanges` service.
 * @param {number} [options.limit] turns kept per Session.
 */
export function createChangeTracker({ recorder, limit = MAX_TURNS_PER_SESSION } = {}) {
  const max = Number.isSafeInteger(limit) && limit > 0 ? limit : MAX_TURNS_PER_SESSION
  const available = isRecord(recorder) && typeof recorder.summary === 'function'
  /** sessionId → announced seq numbers, oldest first. */
  const turns = new Map()
  /** sessionId → announced seq numbers that the panel should be able to name. */

  const idOf = (sessionId) => (typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined)

  /** Remember one announced turn. Returns whether anything new was indexed. */
  function note(sessionId, seq) {
    const id = idOf(sessionId)
    if (id === undefined || !Number.isSafeInteger(seq) || seq < 0) return false
    const known = turns.get(id)
    if (known === undefined) {
      turns.set(id, [seq])
      return true
    }
    if (known.includes(seq)) return false
    known.push(seq)
    while (known.length > max) known.shift()
    return true
  }

  /** A Session left the Host: its snapshots are gone with it. */
  function forget(sessionId) {
    const id = idOf(sessionId)
    if (id !== undefined) turns.delete(id)
  }

  /**
   * The recorder answers `undefined` for a turn it no longer keeps (a disposed
   * Session, a Host that restarted between the announcement and the read). Such
   * a turn is dropped from the index instead of showing a dead row forever.
   */
  function readSummary(service, sessionId, seq) {
    if (!isRecord(service) || typeof service.summary !== 'function') return undefined
    try {
      const summary = service.summary(sessionId, seq)
      return isRecord(summary) ? summary : undefined
    } catch {
      // A broken recorder must not take the whole panel down with it.
      return undefined
    }
  }

  function project(seq, summary) {
    const files = Array.isArray(summary.files) ? summary.files : []
    return {
      seq,
      turn: count(summary.turn, 0),
      cwd: typeof summary.cwd === 'string' ? summary.cwd : '',
      total: count(summary.total, files.length),
      added: count(summary.added, 0),
      deleted: count(summary.deleted, 0),
      hasSnapshot: isRecord(summary.snapshot),
      files: files.map((file, index) => {
        const entry = isRecord(file) ? file : {}
        const path = typeof entry.path === 'string' ? entry.path : ''
        return {
          index,
          path,
          display: typeof entry.display === 'string' && entry.display !== '' ? entry.display : path,
          added: count(entry.added, 0),
          deleted: count(entry.deleted, 0),
          binary: entry.binary === true,
          oversized: entry.oversized === true,
        }
      }),
    }
  }

  /**
   * A turn whose summary the recorder no longer keeps. It stays in the list so
   * the panel can show it greyed out instead of silently dropping history the
   * user still remembers seeing.
   */
  function staleProject(seq) {
    return {
      seq,
      turn: 0,
      cwd: '',
      total: 0,
      added: 0,
      deleted: 0,
      hasSnapshot: false,
      stale: true,
      files: [],
    }
  }

  /** Newest turn first; the panel reads it top-down. */
  function list(sessionId) {
    const id = idOf(sessionId)
    if (id === undefined || !available) return []
    const known = turns.get(id)
    if (known === undefined) return []
    const listed = []
    for (let index = known.length - 1; index >= 0; index -= 1) {
      const seq = known[index]
      const summary = readSummary(recorder, id, seq)
      // Dropping the sequence from the index would erase it on the next read,
      // so a stale turn is kept and marked instead.
      listed.push(summary === undefined ? staleProject(seq) : project(seq, summary))
    }
    return listed
  }

  /**
   * One file of one turn: turn start versus turn end, never the current disk.
   * `index` is the file's position in the summary, which is why `list` keeps it.
   */
  async function diff(sessionId, seq, index, signal) {
    const id = idOf(sessionId)
    if (id === undefined) throw failure('bad-request', 'Не указана сессия.')
    if (!Number.isSafeInteger(seq) || seq < 0) throw failure('bad-request', 'Не указан ход изменений.')
    if (!Number.isSafeInteger(index) || index < 0) throw failure('bad-request', 'Не указан файл.')
    if (!available || typeof recorder.diff !== 'function') return undefined
    const summary = readSummary(recorder, id, seq)
    if (summary === undefined) return undefined
    const files = Array.isArray(summary.files) ? summary.files : []
    if (index >= files.length) throw failure('bad-request', 'В этом ходе нет такого файла.')
    return await recorder.diff(id, seq, index, signal)
  }

  return { available, note, forget, list, diff }
}

/**
 * The two sides of one hunk: context lines belong to both.
 *
 * A hunk addresses lines with 1-based numbers, and its `lines` keep the diff
 * marker, so this is the only place that knows how a snapshot line is encoded.
 */
function hunkSides(hunk) {
  const oldLines = []
  const newLines = []
  const lines = Array.isArray(hunk?.lines) ? hunk.lines : []
  for (const raw of lines) {
    if (typeof raw !== 'string') return undefined
    const marker = raw[0]
    const text = raw.slice(1)
    if (marker === '-') oldLines.push(text)
    else if (marker === '+') newLines.push(text)
    else {
      oldLines.push(text)
      newLines.push(text)
    }
  }
  return { oldLines, newLines }
}

function replaceBlock(lines, at, expected, replacement) {
  if (at + expected.length > lines.length) return false
  for (let index = 0; index < expected.length; index += 1) {
    if (lines[at + index] !== expected[index]) return false
  }
  lines.splice(at, expected.length, ...replacement)
  return true
}

/**
 * Rebuilds the text a turn started from, by applying its hunks backwards.
 *
 * Returns `undefined` rather than a partial result when any hunk no longer
 * matches: a file the user edited after the turn must not be rewritten from a
 * half-applied patch. Callers treat that as a conflict, not as "no changes".
 */
export function revertHunks(text, hunks) {
  const lines = String(text).split('\n')
  const ordered = [...(Array.isArray(hunks) ? hunks : [])].sort((left, right) => right.newStart - left.newStart)
  for (const hunk of ordered) {
    const sides = hunkSides(hunk)
    if (sides === undefined) return undefined
    const at = Number(hunk.newStart) - 1
    if (!Number.isSafeInteger(at) || at < 0) return undefined
    if (!replaceBlock(lines, at, sides.newLines, sides.oldLines)) return undefined
  }
  return lines.join('\n')
}

/** Applies the same hunks forwards; used to prove a revert is reversible. */
export function applyHunks(text, hunks) {
  const lines = String(text).split('\n')
  const ordered = [...(Array.isArray(hunks) ? hunks : [])].sort((left, right) => left.oldStart - right.oldStart)
  // Hunks address the file they were computed against, so every earlier hunk
  // shifts the offsets of the later ones.
  let shift = 0
  for (const hunk of ordered) {
    const sides = hunkSides(hunk)
    if (sides === undefined) return undefined
    const at = Number(hunk.oldStart) - 1 + shift
    if (!Number.isSafeInteger(at) || at < 0) return undefined
    if (!replaceBlock(lines, at, sides.oldLines, sides.newLines)) return undefined
    shift += sides.newLines.length - sides.oldLines.length
  }
  return lines.join('\n')
}
