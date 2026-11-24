/**
 * A reviewable change to an open buffer.
 *
 * One proposal is one atomic result of an Edit request: a list of non
 * overlapping replacements of exact source ranges, plus the text they produce.
 * It never touches the file or the buffer by itself — the Host builds it, the
 * client shows it as a diff and applies it in a single editor transaction.
 *
 * Coordinates are UTF-16 offsets into the LF-normalized buffer the editor
 * works with (`end` is exclusive). `eol` is kept for display only: the file on
 * disk may still be CRLF, but the buffer never is.
 */

/** Where a proposal is in its review lifecycle, from creation to apply. */
export const PROPOSAL_PHASES = Object.freeze([
  'pending',
  'preview',
  'accepted',
  'dismissed',
  'stale',
  'failed',
])

/** Above this many edits one answer is a rewrite, not a review step. */
export const MAX_PROPOSAL_CHANGES = 20

/** A rejected proposal: `code` is stable, `message` is shown to the user. */
export class ProposalError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ProposalError'
    this.code = code
  }
}

function countLines(value) {
  // A trailing newline terminates the last line; it does not add an empty one.
  if (value === '') return 0
  return value.replace(/\n$/, '').split('\n').length
}

function readChange(change, text, index) {
  if (change === null || typeof change !== 'object') {
    throw new ProposalError('bad-request', `Правка ${index + 1} — не объект.`)
  }
  const start = Number(change.start)
  const end = Number(change.end)
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new ProposalError('bad-request', `У правки ${index + 1} нет целочисленных границ.`)
  }
  if (start < 0 || end < start || end > text.length) {
    throw new ProposalError('out-of-range', `Правка ${index + 1} выходит за пределы файла.`)
  }
  if (typeof change.newText !== 'string') {
    throw new ProposalError('bad-request', `У правки ${index + 1} нет нового текста.`)
  }
  // The old text is not trusted: it must be exactly what the buffer holds now,
  // otherwise the offsets belong to some other revision of the file.
  const oldText = text.slice(start, end)
  if (typeof change.oldText === 'string' && change.oldText !== oldText) {
    throw new ProposalError('mismatch', `Текст под правкой ${index + 1} не совпадает с файлом.`)
  }
  if (oldText === change.newText) {
    throw new ProposalError('no-change', 'Ответ не меняет фрагмент.')
  }
  return { start, end, oldText, newText: change.newText }
}

/**
 * Validate and materialize one proposal.
 *
 * Throws `ProposalError` for anything that would make the apply ambiguous:
 * out-of-buffer ranges, a stale `oldText`, overlapping or duplicate edits.
 */
export function createProposal(input = {}) {
  const id = typeof input.id === 'string' ? input.id : ''
  const documentId = typeof input.documentId === 'string' ? input.documentId : ''
  const text = typeof input.text === 'string' ? input.text : undefined
  const eol = input.eol === 'crlf' ? 'crlf' : '\n'
  if (id === '') throw new ProposalError('bad-request', 'У предложения нет идентификатора.')
  if (documentId === '') {
    throw new ProposalError('bad-request', 'Предложение не привязано к документу.')
  }
  const modelVersion = Number(input.modelVersion)
  if (!Number.isFinite(modelVersion)) {
    throw new ProposalError('bad-request', 'Не передана версия документа.')
  }
  if (text === undefined) throw new ProposalError('bad-request', 'Не передан текст документа.')
  if (!Array.isArray(input.changes) || input.changes.length === 0) {
    throw new ProposalError('empty-changes', 'В предложении нет правок.')
  }
  if (input.changes.length > MAX_PROPOSAL_CHANGES) {
    throw new ProposalError('too-many-changes', `Слишком много правок: ${input.changes.length}.`)
  }

  const changes = input.changes.map((change, index) => readChange(change, text, index))
  const ordered = [...changes].sort((left, right) => left.start - right.start || left.end - right.end)
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]
    const current = ordered[index]
    if (current.start === previous.start && current.end === previous.end) {
      throw new ProposalError('duplicate', 'Одна и та же правка предложена дважды.')
    }
    if (current.start < previous.end) {
      throw new ProposalError('overlap', `Правки ${index} и ${index + 1} пересекаются.`)
    }
  }

  // Apply from the end so earlier offsets stay valid.
  let result = text
  for (const change of [...changes].sort((left, right) => right.start - left.start)) {
    result = result.slice(0, change.start) + change.newText + result.slice(change.end)
  }

  const addedLines = changes.reduce((sum, change) => sum + countLines(change.newText), 0)
  const removedLines = changes.reduce((sum, change) => sum + countLines(change.oldText), 0)

  return {
    id,
    documentId,
    modelVersion,
    eol,
    changes,
    text,
    result,
    addedLines,
    removedLines,
  }
}

/**
 * Check that a proposal still belongs to the buffer it was made for.
 *
 * Applied before every apply: the version catches edits, and comparing the
 * range text catches a lost or reordered version counter.
 */
export function verifyProposal(proposal, current = {}) {
  if (proposal === null || typeof proposal !== 'object' || !Array.isArray(proposal.changes)) {
    return { ok: false, code: 'bad-proposal', message: 'Предложение не найдено.' }
  }
  const version = Number(current.modelVersion)
  if (Number.isFinite(version) && version !== Number(proposal.modelVersion)) {
    return { ok: false, code: 'stale', message: 'Файл изменился, запросите новую правку.' }
  }
  if (typeof current.text === 'string') {
    for (const change of proposal.changes) {
      if (current.text.slice(change.start, change.end) !== change.oldText) {
        return { ok: false, code: 'text-changed', message: 'Текст файла изменился, запросите новую правку.' }
      }
    }
  }
  return { ok: true }
}

/** Counts for the review bar, without the texts themselves. */
export function summarizeProposal(proposal) {
  if (proposal === null || typeof proposal !== 'object' || !Array.isArray(proposal.changes)) {
    return { changes: 0, addedLines: 0, removedLines: 0 }
  }
  return {
    changes: proposal.changes.length,
    addedLines: Number(proposal.addedLines) || 0,
    removedLines: Number(proposal.removedLines) || 0,
  }
}

/**
 * Read the one-field answer of an Edit request.
 *
 * Returns `undefined` when the answer is not a `{replacement}` object at all —
 * which includes an empty stream, prose and broken JSON. An empty string is a
 * valid replacement (it deletes the fragment), so callers must check for
 * `undefined`, never for falsiness.
 */
export function readReplacementAnswer(raw) {
  let value = String(raw ?? '').trim()
  if (value === '') return undefined
  const fenced = /^```[a-zA-Z0-9]*\s*\r?\n([\s\S]*?)\r?\n?```$/.exec(value)
  if (fenced !== null) value = fenced[1].trim()
  const read = (candidate) => {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.replacement === 'string') {
        return parsed.replacement.replace(/\r\n/g, '\n')
      }
    } catch {
      // Not JSON: the caller turns that into a visible "wrong format" error.
    }
    return undefined
  }
  const direct = read(value)
  if (direct !== undefined) return direct
  // A chatty model may wrap the object in a sentence; take the braced part.
  const first = value.indexOf('{')
  const last = value.lastIndexOf('}')
  if (first !== -1 && last > first) return read(value.slice(first, last + 1))
  return undefined
}
