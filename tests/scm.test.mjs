/**
 * Host-half tests for `scm.js`.
 *
 * Every test builds a disposable repository under the OS temp directory and
 * drives the same functions the Host routes call. Git itself is the reference:
 * after a write the test asks Git for a real state instead of trusting the
 * module's own snapshot.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import * as scm from '../scm.js'

function environment(directory) {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(directory, '.gitconfig-empty'),
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Тест',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Тест',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  }
}

function runGit(directory, env, args, input) {
  return execFileSync(
    'git',
    ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', 'user.name=Тест', '-c', 'user.email=test@example.com', ...args],
    { cwd: directory, env, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] },
  )
}

async function makeRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-ide-scm-'))
  const directory = path.join(root, 'repo')
  await mkdir(directory)
  const env = environment(root)
  await writeFile(path.join(root, '.gitconfig-empty'), '', 'utf8')
  runGit(directory, env, ['init', '-q'])
  runGit(directory, env, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  return { directory, root, env, git: scm.createGit(directory, { env }) }
}

/** A real worktree reader with the same contract the Host adapter provides. */
function reader(directory) {
  return async (relative) => {
    const file = path.join(directory, ...relative.split('/'))
    try {
      const info = await lstat(file)
      if (info.isSymbolicLink()) return { kind: 'symlink', target: await readlink(file) }
      if (!info.isFile()) return { kind: 'special' }
      const bytes = await readFile(file)
      return { kind: 'file', bytes, size: info.size, truncated: false }
    } catch {
      return { kind: 'missing' }
    }
  }
}

function snapshot(repo) {
  return scm.loadSnapshot(repo.git, { readWorktree: reader(repo.directory) })
}

async function commitFile(repo, name, content, message) {
  const target = path.join(repo.directory, ...name.split('/'))
  await writeFile(target, content, 'utf8')
  runGit(repo.directory, repo.env, ['add', '--', name])
  runGit(repo.directory, repo.env, ['commit', '-q', '-m', message])
}

async function putFile(repo, name, content) {
  const file = path.join(repo.directory, ...name.split('/'))
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content, 'utf8')
}

async function cleanup(directory) {
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

test('an empty repository is unborn, a commit makes it clean, detaching is not unborn', async () => {
  const repo = await makeRepo()
  try {
    let state = await snapshot(repo)
    assert.equal(state.unborn, true)
    assert.equal(state.head, '')
    assert.deepEqual(state.entries, [])

    await commitFile(repo, 'a.txt', 'A\n', 'first')
    state = await snapshot(repo)
    assert.equal(state.unborn, false)
    assert.equal(state.branch, 'main')
    assert.deepEqual(state.entries, [])
    assert.match(state.revision, /^[0-9a-f]{64}$/)

    runGit(repo.directory, repo.env, ['checkout', '-q', '--detach'])
    state = await snapshot(repo)
    assert.equal(state.detached, true)
    assert.equal(state.unborn, false)
    assert.notEqual(state.head, '')
  } finally {
    await cleanup(repo.root)
  }
})

test('status splits a staged and a further worktree edit into two rows', async () => {
  const repo = await makeRepo()
  try {
    await commitFile(repo, 'a.txt', 'A\n', 'first')
    await putFile(repo, 'a.txt', 'A staged\n')
    runGit(repo.directory, repo.env, ['add', '--', 'a.txt'])
    await putFile(repo, 'a.txt', 'A worktree\n')

    const state = await snapshot(repo)
    const entry = state.entries.find((item) => item.path === 'a.txt')
    assert.ok(entry)
    assert.equal(entry.indexStatus, 'M')
    assert.equal(entry.worktreeStatus, 'M')
    assert.equal(entry.kind, 'modified')
    assert.match(entry.token, /^f:/)

    const rows = scm.rowsOf(state.entries).filter((row) => row.path === 'a.txt')
    assert.deepEqual(
      rows.map((row) => row.group),
      ['staged', 'changes'],
    )
    assert.equal(scm.findRow(state, 'staged', 'a.txt').entry, entry)
  } finally {
    await cleanup(repo.root)
  }
})

test('renames, untracked names with spaces and Cyrillic, and ignored files parse exactly', async () => {
  const repo = await makeRepo()
  try {
    await commitFile(repo, 'old name.txt', 'old\n', 'first')
    await commitFile(repo, '.gitignore', 'ignored/\n', 'ignore')
    await putFile(repo, 'ignored/secret.txt', 'secret\n')
    runGit(repo.directory, repo.env, ['mv', 'old name.txt', 'новое имя.txt'])
    await putFile(repo, 'новый файл.txt', 'new\n')

    const state = await snapshot(repo)
    const renamed = state.entries.find((entry) => entry.path === 'новое имя.txt')
    assert.ok(renamed)
    assert.equal(renamed.oldPath, 'old name.txt')
    assert.equal(renamed.kind, 'renamed')
    assert.equal(renamed.indexStatus, 'R')

    const untracked = state.entries.find((entry) => entry.path === 'новый файл.txt')
    assert.ok(untracked)
    assert.equal(untracked.kind, 'untracked')

    const ignored = state.entries.find((entry) => entry.path === 'ignored/secret.txt')
    assert.ok(ignored)
    assert.equal(ignored.kind, 'ignored')
    assert.deepEqual(scm.groupsOf(ignored), [])
  } finally {
    await cleanup(repo.root)
  }
})

test('the revision follows file bytes, not only status letters', async () => {
  const repo = await makeRepo()
  try {
    await commitFile(repo, 'a.txt', 'A\n', 'first')
    await putFile(repo, 'a.txt', 'B\n')
    const first = await snapshot(repo)
    const second = await snapshot(repo)
    assert.equal(first.revision, second.revision)

    // Same `M` letter, different content: staging must see a new revision.
    await putFile(repo, 'a.txt', 'C\n')
    const third = await snapshot(repo)
    assert.notEqual(third.revision, first.revision)
    assert.notEqual(third.entries[0].token, first.entries[0].token)
  } finally {
    await cleanup(repo.root)
  }
})

test('a file with HEAD A, index B and disk C opens two different comparisons', async () => {
  const repo = await makeRepo()
  try {
    await commitFile(repo, 'a.txt', 'A\n', 'first')
    await putFile(repo, 'a.txt', 'B\n')
    runGit(repo.directory, repo.env, ['add', '--', 'a.txt'])
    await putFile(repo, 'a.txt', 'C\n')
    const state = await snapshot(repo)
    const worktree = reader(repo.directory)

    const staged = await scm.loadDiff(repo.git, state, {
      group: 'staged',
      path: 'a.txt',
      readWorktree: worktree,
    })
    assert.equal(staged.kind, 'text')
    assert.equal(staged.before, 'A\n')
    assert.equal(staged.after, 'B\n')
    assert.equal(staged.beforeLabel, 'HEAD')
    assert.equal(staged.afterLabel, 'Индекс')

    const changes = await scm.loadDiff(repo.git, state, {
      group: 'changes',
      path: 'a.txt',
      readWorktree: worktree,
    })
    assert.equal(changes.kind, 'text')
    assert.equal(changes.before, 'B\n')
    assert.equal(changes.after, 'C\n')
    assert.equal(changes.beforeLabel, 'Индекс')
    assert.equal(changes.afterLabel, 'На диске')
  } finally {
    await cleanup(repo.root)
  }
})

test('untracked, added, deleted and renamed rows read the right side as empty', async () => {
  const repo = await makeRepo()
  try {
    await commitFile(repo, 'keep.txt', 'keep\n', 'first')
    await putFile(repo, 'new.txt', 'new\n')
    let state = await snapshot(repo)
    let worktree = reader(repo.directory)
    let diff = await scm.loadDiff(repo.git, state, {
      group: 'changes',
      path: 'new.txt',
      readWorktree: worktree,
    })
    assert.equal(diff.before, '')
    assert.equal(diff.after, 'new\n')

    runGit(repo.directory, repo.env, ['add', '--', 'new.txt'])
    state = await snapshot(repo)
    worktree = reader(repo.directory)
    diff = await scm.loadDiff(repo.git, state, {
      group: 'staged',
      path: 'new.txt',
      readWorktree: worktree,
    })
    assert.equal(diff.before, '')
    assert.equal(diff.after, 'new\n')
    assert.equal(diff.beforeLabel, 'HEAD')

    await unlink(path.join(repo.directory, 'keep.txt'))
    runGit(repo.directory, repo.env, ['add', '-A', '--', 'keep.txt'])
    state = await snapshot(repo)
    worktree = reader(repo.directory)
    diff = await scm.loadDiff(repo.git, state, {
      group: 'staged',
      path: 'keep.txt',
      readWorktree: worktree,
    })
    assert.equal(diff.before, 'keep\n')
    assert.equal(diff.after, '')
  } finally {
    await cleanup(repo.root)
  }
})

test('a staged rename reads the old name only on the old side', async () => {
  const repo = await makeRepo()
  try {
    await commitFile(repo, 'old.txt', 'один\n', 'first')
    runGit(repo.directory, repo.env, ['mv', 'old.txt', 'new.txt'])
    const state = await snapshot(repo)
    const diff = await scm.loadDiff(repo.git, state, {
      group: 'staged',
      path: 'new.txt',
      readWorktree: reader(repo.directory),
    })
    assert.equal(diff.kind, 'text')
    assert.equal(diff.oldPath, 'old.txt')
    assert.equal(diff.before, 'один\n')
    assert.equal(diff.after, 'один\n')
  } finally {
    await cleanup(repo.root)
  }
})

test('a conflict row is a state, not a faked two-way diff', async () => {
  const repo = await makeRepo()
  try {
    await commitFile(repo, 'a.txt', 'base\n', 'base')
    runGit(repo.directory, repo.env, ['checkout', '-q', '-b', 'side'])
    await putFile(repo, 'a.txt', 'side\n')
    runGit(repo.directory, repo.env, ['commit', '-q', '-am', 'side'])
    runGit(repo.directory, repo.env, ['checkout', '-q', 'main'])
    await putFile(repo, 'a.txt', 'main\n')
    runGit(repo.directory, repo.env, ['commit', '-q', '-am', 'main'])
    try {
      runGit(repo.directory, repo.env, ['merge', 'side'])
      assert.fail('merge should conflict')
    } catch (error) {
      assert.notEqual(error.status, 0)
    }

    const state = await snapshot(repo)
    const entry = state.entries.find((item) => item.path === 'a.txt')
    assert.ok(entry)
    assert.equal(entry.kind, 'conflict')
    assert.deepEqual(scm.groupsOf(entry), ['conflicts'])

    const diff = await scm.loadDiff(repo.git, state, {
      group: 'conflicts',
      path: 'a.txt',
      readWorktree: reader(repo.directory),
    })
    assert.equal(diff.kind, 'conflict')
    assert.match(diff.message, /вне панели/)
  } finally {
    await cleanup(repo.root)
  }
})

test('stage prepares the disk bytes, unstage keeps the worktree untouched', async () => {
  const repo = await makeRepo()
  try {
    await commitFile(repo, 'a.txt', 'A\n', 'first')
    await putFile(repo, 'a.txt', 'B\n')
    let state = await snapshot(repo)
    let row = scm.findRow(state, 'changes', 'a.txt')
    assert.ok(row)
    await scm.addRow(repo.git, row.entry)

    state = await snapshot(repo)
    assert.equal(scm.findRow(state, 'staged', 'a.txt') !== undefined, true)
    assert.equal(scm.findRow(state, 'changes', 'a.txt'), undefined)
    assert.equal(runGit(repo.directory, repo.env, ['show', ':a.txt']), 'B\n')

    row = scm.findRow(state, 'staged', 'a.txt')
    await scm.unstageRow(repo.git, row.entry, { unborn: state.unborn })
    state = await snapshot(repo)
    assert.equal(scm.findRow(state, 'staged', 'a.txt'), undefined)
    assert.equal(scm.findRow(state, 'changes', 'a.txt') !== undefined, true)
    assert.equal(await readFile(path.join(repo.directory, 'a.txt'), 'utf8'), 'B\n')
  } finally {
    await cleanup(repo.root)
  }
})

test('commit takes only the index: a partially staged file keeps its worktree edit', async () => {
  const repo = await makeRepo()
  try {
    await commitFile(repo, 'a.txt', 'A\n', 'first')
    await putFile(repo, 'a.txt', 'B\n')
    runGit(repo.directory, repo.env, ['add', '--', 'a.txt'])
    await putFile(repo, 'a.txt', 'C\n')

    const before = await snapshot(repo)
    assert.equal(before.entries.find((entry) => entry.path === 'a.txt').worktreeStatus, 'M')
    const { head } = await scm.commitIndex(repo.git, 'только индекс')

    assert.equal(runGit(repo.directory, repo.env, ['show', 'HEAD:a.txt']), 'B\n')
    assert.equal(await readFile(path.join(repo.directory, 'a.txt'), 'utf8'), 'C\n')
    assert.equal(runGit(repo.directory, repo.env, ['rev-parse', 'HEAD']).trim(), head)

    const after = await snapshot(repo)
    assert.equal(after.branch, 'main')
    const entry = after.entries.find((item) => item.path === 'a.txt')
    assert.ok(entry)
    assert.equal(entry.indexStatus, '.')
    assert.equal(entry.worktreeStatus, 'M')
    assert.deepEqual(scm.groupsOf(entry), ['changes'])
  } finally {
    await cleanup(repo.root)
  }
})

test('commit reports an empty index and leaves HEAD alone', async () => {
  const repo = await makeRepo()
  try {
    await commitFile(repo, 'a.txt', 'A\n', 'first')
    const before = runGit(repo.directory, repo.env, ['rev-parse', 'HEAD']).trim()
    await assert.rejects(
      () => scm.commitIndex(repo.git, 'нечего'),
      (error) => error.code === 'nothing-staged',
    )
    assert.equal(runGit(repo.directory, repo.env, ['rev-parse', 'HEAD']).trim(), before)
  } finally {
    await cleanup(repo.root)
  }
})

test('history pages in topology order and its cursor is tied to the refs', async () => {
  const repo = await makeRepo()
  try {
    await commitFile(repo, 'a.txt', 'one\n', 'one')
    await commitFile(repo, 'a.txt', 'two\n', 'two')
    runGit(repo.directory, repo.env, ['checkout', '-q', '-b', 'side'])
    await putFile(repo, 'side.txt', 'side\n')
    runGit(repo.directory, repo.env, ['add', '--', 'side.txt'])
    runGit(repo.directory, repo.env, ['commit', '-q', '-m', 'side'])
    runGit(repo.directory, repo.env, ['checkout', '-q', 'main'])
    await putFile(repo, 'main.txt', 'main\n')
    runGit(repo.directory, repo.env, ['add', '--', 'main.txt'])
    runGit(repo.directory, repo.env, ['commit', '-q', '-m', 'main'])
    runGit(repo.directory, repo.env, ['merge', '-q', '--no-ff', '-m', 'merge', 'side'])

    const first = await scm.loadHistoryPage(repo.git, { pageSize: 2 })
    assert.equal(first.commits.length, 2)
    assert.equal(first.unborn, false)
    assert.ok(first.nextCursor)
    assert.equal(first.vertices.length >= 2, true)
    const merge = first.commits[0]
    assert.equal(merge.subject, 'merge')
    assert.equal(merge.parents.length, 2)
    assert.deepEqual(merge.parents, runGit(repo.directory, repo.env, ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ').slice(1))

    const second = await scm.loadHistoryPage(repo.git, { cursor: first.nextCursor })
    assert.ok(second.commits.length >= 1)
    const oids = [...first.commits, ...second.commits].map((commit) => commit.oid)
    assert.equal(new Set(oids).size, oids.length)

    runGit(repo.directory, repo.env, ['branch', 'third', 'HEAD~1'])
    await assert.rejects(
      () => scm.loadHistoryPage(repo.git, { cursor: first.nextCursor }),
      (error) => error.code === 'history-stale',
    )
  } finally {
    await cleanup(repo.root)
  }
})

test('an unborn repository has no history page and no vertices', async () => {
  const repo = await makeRepo()
  try {
    const page = await scm.loadHistoryPage(repo.git)
    assert.deepEqual(page, { commits: [], nextCursor: null, unborn: true, vertices: [] })
  } finally {
    await cleanup(repo.root)
  }
})

test('commit files and commit diff come from the tree, not from the current disk', async () => {
  const repo = await makeRepo()
  try {
    await commitFile(repo, 'a.txt', 'A\n', 'first')
    const head = runGit(repo.directory, repo.env, ['rev-parse', 'HEAD']).trim()

    const files = await scm.loadCommitFiles(repo.git, { oid: head })
    assert.equal(files.base, '')
    assert.deepEqual(
      files.entries.map((entry) => [entry.path, entry.status]),
      [['a.txt', 'A']],
    )

    const diff = await scm.loadCommitDiff(repo.git, { oid: head, path: 'a.txt' })
    assert.equal(diff.kind, 'text')
    assert.equal(diff.before, '')
    assert.equal(diff.after, 'A\n')

    await putFile(repo, 'a.txt', 'B\n')
    const again = await scm.loadCommitDiff(repo.git, { oid: head, path: 'a.txt' })
    assert.equal(again.after, 'A\n')
    assert.equal(again.oid, head)
  } finally {
    await cleanup(repo.root)
  }
})

test('a merge commit defaults to its first parent and accepts an explicit other parent', async () => {
  const repo = await makeRepo()
  try {
    await commitFile(repo, 'base.txt', 'base\n', 'base')
    runGit(repo.directory, repo.env, ['checkout', '-q', '-b', 'side'])
    await putFile(repo, 'side.txt', 'side\n')
    runGit(repo.directory, repo.env, ['add', '--', 'side.txt'])
    runGit(repo.directory, repo.env, ['commit', '-q', '-m', 'side'])
    runGit(repo.directory, repo.env, ['checkout', '-q', 'main'])
    await putFile(repo, 'main.txt', 'main\n')
    runGit(repo.directory, repo.env, ['add', '--', 'main.txt'])
    runGit(repo.directory, repo.env, ['commit', '-q', '-m', 'main'])
    runGit(repo.directory, repo.env, ['merge', '-q', '--no-ff', '-m', 'merge', 'side'])
    const merge = runGit(repo.directory, repo.env, ['rev-parse', 'HEAD']).trim()
    const parents = runGit(repo.directory, repo.env, ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ').slice(1)

    const first = await scm.loadCommitFiles(repo.git, { oid: merge })
    assert.equal(first.base, parents[0])
    assert.deepEqual(
      first.entries.map((entry) => entry.path),
      ['side.txt'],
    )
    const firstDiff = await scm.loadCommitDiff(repo.git, { oid: merge, path: 'side.txt' })
    assert.equal(firstDiff.before, '')
    assert.equal(firstDiff.after, 'side\n')

    const second = await scm.loadCommitFiles(repo.git, { oid: merge, base: parents[1] })
    assert.equal(second.base, parents[1])
    assert.deepEqual(
      second.entries.map((entry) => entry.path),
      ['main.txt'],
    )
    const secondDiff = await scm.loadCommitDiff(repo.git, { oid: merge, base: parents[1], path: 'main.txt' })
    assert.equal(secondDiff.before, '')
    assert.equal(secondDiff.after, 'main\n')

    await assert.rejects(
      () => scm.loadCommitFiles(repo.git, { oid: merge, base: '0'.repeat(40) }),
      (error) => error.code === 'bad-request',
    )
  } finally {
    await cleanup(repo.root)
  }
})

test('branches list, create, switch and delete while the worktree follows the branch', async () => {
  const repo = await makeRepo()
  try {
    await commitFile(repo, 'a.txt', 'A\n', 'first')

    let state = await scm.listBranches(repo.git)
    assert.equal(state.current, 'main')
    assert.equal(state.detached, false)
    assert.deepEqual(state.branches.map((branch) => [branch.name, branch.current]), [['main', true]])

    await scm.createBranch(repo.git, 'feature')
    state = await scm.listBranches(repo.git)
    assert.equal(state.current, 'feature')
    assert.deepEqual(state.branches.map((branch) => branch.name), ['feature', 'main'])

    await putFile(repo, 'a.txt', 'B\n')
    runGit(repo.directory, repo.env, ['add', '--', 'a.txt'])
    runGit(repo.directory, repo.env, ['commit', '-q', '-m', 'feature work'])

    await scm.switchBranch(repo.git, 'main')
    state = await scm.listBranches(repo.git)
    assert.equal(state.current, 'main')
    assert.equal(await readFile(path.join(repo.directory, 'a.txt'), 'utf8'), 'A\n')

    // A dirty file that differs on the target branch blocks the switch; the
    // panel reports it instead of forcing the checkout.
    await putFile(repo, 'a.txt', 'C\n')
    await assert.rejects(
      () => scm.switchBranch(repo.git, 'feature'),
      (error) => error.code === 'switch-conflict',
    )
    runGit(repo.directory, repo.env, ['checkout', '--', 'a.txt'])

    // `feature` holds a commit that main does not: a safe delete must refuse.
    await assert.rejects(
      () => scm.deleteBranch(repo.git, 'feature'),
      (error) => error.code === 'branch-unmerged',
    )

    await scm.createBranch(repo.git, 'temporary')
    await scm.switchBranch(repo.git, 'main')
    await scm.deleteBranch(repo.git, 'temporary')
    state = await scm.listBranches(repo.git)
    assert.deepEqual(state.branches.map((branch) => branch.name), ['feature', 'main'])

    await assert.rejects(
      () => scm.deleteBranch(repo.git, 'main'),
      (error) => error.code === 'branch-current',
    )
    await assert.rejects(
      () => scm.createBranch(repo.git, 'bad..name'),
      (error) => error.code === 'bad-request',
    )
    await assert.rejects(
      () => scm.switchBranch(repo.git, 'missing'),
      (error) => error.code === 'not-found',
    )
  } finally {
    await cleanup(repo.root)
  }
})

test('a missing repository is a typed refusal, not an empty list', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-ide-scm-plain-'))
  try {
    const git = scm.createGit(directory, { env: environment(directory) })
    await assert.rejects(
      () => scm.resolveRoot(git),
      (error) => error.code === 'not-repository',
    )
  } finally {
    await cleanup(directory)
  }
})

test('a symlink side is its target text and a binary side stays unreadable', async () => {
  const repo = await makeRepo()
  try {
    await commitFile(repo, 'a.txt', 'A\n', 'first')
    await putFile(repo, 'bin.dat', Buffer.from([0, 1, 2, 3]))
    const state = await snapshot(repo)
    const worktree = reader(repo.directory)
    let diff = await scm.loadDiff(repo.git, state, {
      group: 'changes',
      path: 'bin.dat',
      readWorktree: worktree,
    })
    assert.equal(diff.kind, 'binary')

    if (process.platform !== 'win32') {
      runGit(repo.directory, repo.env, ['checkout', '-q', '--', 'a.txt'])
      await unlink(path.join(repo.directory, 'a.txt'))
      await execFileSync('ln', ['-s', 'target.txt', path.join(repo.directory, 'a.txt')])
      const linked = await snapshot(repo)
      diff = await scm.loadDiff(repo.git, linked, {
        group: 'changes',
        path: 'a.txt',
        readWorktree: reader(repo.directory),
      })
      assert.equal(diff.kind, 'text')
      assert.equal(diff.after, 'target.txt')
    }
  } finally {
    await cleanup(repo.root)
  }
})

test('a file above the diff limit is a reason card with its size, not a truncated diff', async () => {
  const repo = await makeRepo()
  try {
    await commitFile(repo, 'big.txt', 'A\n', 'first')
    await putFile(repo, 'big.txt', `${'x'.repeat(200)}\n`)
    const state = await snapshot(repo)
    const diff = await scm.loadDiff(repo.git, state, {
      group: 'changes',
      path: 'big.txt',
      readWorktree: reader(repo.directory),
      maxBytes: 100,
    })
    assert.equal(diff.kind, 'too-large')
    assert.equal(typeof diff.size, 'number')
  } finally {
    await cleanup(repo.root)
  }
})

test('rename, delete and copy letters are classified for history rows', () => {
  const status = scm.parseNameStatus(
    Buffer.from('M\tsame.txt\0R100\told.txt\0new.txt\0D\tgone.txt\0A\tadded.txt\0C75\tsrc.txt\0copy.txt\0'),
  )
  assert.deepEqual(
    status.map((entry) => [entry.status, entry.path, entry.oldPath]),
    [
      ['A', 'added.txt', undefined],
      ['C', 'copy.txt', 'src.txt'],
      ['D', 'gone.txt', undefined],
      ['R', 'new.txt', 'old.txt'],
      ['M', 'same.txt', undefined],
    ],
  )
  assert.equal(status[3].kind, 'renamed')
})

test('the index patch and the worktree patch split one file exactly', async () => {
  const repo = await makeRepo()
  try {
    await commitFile(repo, 'a.txt', 'one\ntwo\nthree\n', 'first')
    await putFile(repo, 'a.txt', 'one\nSTAGED\nthree\n')
    runGit(repo.directory, repo.env, ['add', '--', 'a.txt'])
    await putFile(repo, 'a.txt', 'one\nSTAGED\nWORK\n')
    const state = await snapshot(repo)

    const staged = await scm.loadPatch(repo.git, state, { group: 'staged' })
    assert.equal(staged.files.length, 1)
    assert.equal(staged.files[0].path, 'a.txt')
    assert.ok(staged.bytes > 0)
    assert.match(staged.patch, /\+STAGED/)
    assert.doesNotMatch(staged.patch, /WORK/)

    const changes = await scm.loadPatch(repo.git, state, { group: 'changes' })
    assert.match(changes.patch, /-three/)
    assert.match(changes.patch, /\+WORK/)
    assert.doesNotMatch(changes.patch, /\+STAGED/)
  } finally {
    await cleanup(repo.root)
  }
})

test('a patch names untracked, binary, secret and oversized files instead of losing them', async () => {
  const repo = await makeRepo()
  try {
    await commitFile(repo, 'base.txt', 'base\n', 'first')
    await commitFile(repo, 'big.txt', 'small\n', 'big base')
    await commitFile(repo, 'bin.dat', 'text\n', 'binary base')
    await putFile(repo, 'new.txt', 'new\n')
    await putFile(repo, 'bin.dat', Buffer.from([0, 1, 2, 3, 0, 4]))
    await putFile(repo, 'big.txt', `${'x'.repeat(400)}\n`)
    await putFile(repo, 'secret.txt', 'token=1\n')
    runGit(repo.directory, repo.env, ['add', '--', 'secret.txt'])

    const state = await snapshot(repo)
    const changes = await scm.loadPatch(repo.git, state, { group: 'changes', maxBytes: 400 })
    const reasons = Object.fromEntries(changes.skipped.map((item) => [item.path, item.reason]))
    assert.equal(reasons['new.txt'], 'untracked')
    assert.equal(reasons['bin.dat'], 'binary')
    assert.equal(reasons['big.txt'], 'too-large')
    assert.deepEqual(changes.files, [])
    assert.equal(changes.truncated, true)

    const staged = await scm.loadPatch(repo.git, state, {
      group: 'staged',
      skip: (target) => target === 'secret.txt',
    })
    assert.deepEqual(
      staged.skipped.map((item) => [item.path, item.reason]),
      [['secret.txt', 'secret']],
    )

    const ignored = await scm.loadPatch(repo.git, state, {
      group: 'staged',
      skip: (target) => (target === 'secret.txt' ? 'ignored' : false),
    })
    assert.deepEqual(
      ignored.skipped.map((item) => [item.path, item.reason]),
      [['secret.txt', 'ignored']],
    )
  } finally {
    await cleanup(repo.root)
  }
})

test('patch line numbers follow the new side and reset per file', () => {
  const patch = [
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,2 +1,3 @@',
    ' one',
    '+two',
    ' three',
    'diff --git a/b.txt b/b.txt',
    '--- a/b.txt',
    '+++ b/b.txt',
    '@@ -5,1 +5,2 @@',
    ' five',
    '+six',
    '',
  ].join('\n')
  assert.deepEqual([...scm.patchLineNumbers(patch)].sort((left, right) => left - right), [1, 2, 3, 5, 6])
  assert.deepEqual([...scm.patchLineNumbers('')], [])
})

test('a patch request for conflicts is refused instead of drawing a two-way diff', async () => {
  const repo = await makeRepo()
  try {
    await commitFile(repo, 'a.txt', 'A\n', 'first')
    const state = await snapshot(repo)
    await assert.rejects(
      () => scm.loadPatch(repo.git, state, { group: 'conflicts' }),
      (error) => error.code === 'bad-request',
    )
  } finally {
    await cleanup(repo.root)
  }
})

test('a both-sides conflict exposes base, ours and theirs, and the chosen text clears it', async () => {
  const repo = await makeRepo()
  const file = path.join(repo.directory, 'file.txt')
  try {
    await commitFile(repo, 'file.txt', 'base\n', 'base')
    runGit(repo.directory, repo.env, ['checkout', '-q', '-b', 'feature'])
    await putFile(repo, 'file.txt', 'feature\n')
    runGit(repo.directory, repo.env, ['add', '--', 'file.txt'])
    runGit(repo.directory, repo.env, ['commit', '-q', '-m', 'feature'])
    runGit(repo.directory, repo.env, ['checkout', '-q', 'main'])
    await putFile(repo, 'file.txt', 'main\n')
    runGit(repo.directory, repo.env, ['add', '--', 'file.txt'])
    runGit(repo.directory, repo.env, ['commit', '-q', '-m', 'main'])
    assert.throws(() => runGit(repo.directory, repo.env, ['merge', 'feature']))

    const state = await snapshot(repo)
    assert.ok(state.entries.some((entry) => entry.kind === 'conflict' && entry.path === 'file.txt'))
    const conflict = await scm.loadConflict(repo.git, state, 'file.txt')
    assert.equal(conflict.base, 'base\n')
    assert.equal(conflict.ours, 'main\n')
    assert.equal(conflict.theirs, 'feature\n')
    assert.equal(conflict.hasBase, true)
    assert.equal(conflict.hasOurs, true)
    assert.equal(conflict.hasTheirs, true)

    const resolution = 'main + feature\n'
    const outcome = await scm.resolveConflict(repo.git, 'file.txt', resolution)
    assert.match(outcome.oid, /^[0-9a-f]{40,64}$/)
    assert.equal(await readFile(file, 'utf8'), resolution)
    assert.equal(runGit(repo.directory, repo.env, ['show', ':0:file.txt']), resolution)
    const after = await snapshot(repo)
    assert.equal(after.entries.some((entry) => entry.kind === 'conflict'), false)
    assert.deepEqual(
      after.entries.map((entry) => [entry.path, entry.kind]),
      [['file.txt', 'modified']],
    )
  } finally {
    await cleanup(repo.root)
  }
})

test('a modify/delete conflict reports the missing side instead of inventing it', async () => {
  const repo = await makeRepo()
  try {
    await commitFile(repo, 'gone.txt', 'base\n', 'base')
    runGit(repo.directory, repo.env, ['checkout', '-q', '-b', 'deleter'])
    runGit(repo.directory, repo.env, ['rm', '-q', '--', 'gone.txt'])
    runGit(repo.directory, repo.env, ['commit', '-q', '-m', 'delete'])
    runGit(repo.directory, repo.env, ['checkout', '-q', 'main'])
    await putFile(repo, 'gone.txt', 'changed\n')
    runGit(repo.directory, repo.env, ['add', '--', 'gone.txt'])
    runGit(repo.directory, repo.env, ['commit', '-q', '-m', 'modify'])
    assert.throws(() => runGit(repo.directory, repo.env, ['merge', 'deleter']))

    const state = await snapshot(repo)
    const conflict = await scm.loadConflict(repo.git, state, 'gone.txt')
    assert.equal(conflict.hasOurs, true)
    assert.equal(conflict.hasTheirs, false)
    assert.equal(conflict.ours, 'changed\n')
    assert.equal(conflict.theirs, '')
    await assert.rejects(
      () => scm.loadConflict(repo.git, state, 'missing.txt'),
      (error) => error.code === 'not-conflict',
    )
  } finally {
    await cleanup(repo.root)
  }
})

test('a binary conflict is refused rather than shown as text', async () => {
  const repo = await makeRepo()
  try {
    await commitFile(repo, 'marker.txt', 'base\n', 'base')
    runGit(repo.directory, repo.env, ['checkout', '-q', '-b', 'binary'])
    await writeFile(path.join(repo.directory, 'bin.dat'), Buffer.from([0, 1, 2, 3]))
    runGit(repo.directory, repo.env, ['add', '--', 'bin.dat'])
    runGit(repo.directory, repo.env, ['commit', '-q', '-m', 'binary'])
    runGit(repo.directory, repo.env, ['checkout', '-q', 'main'])
    await writeFile(path.join(repo.directory, 'bin.dat'), Buffer.from([0, 9, 8, 7]))
    runGit(repo.directory, repo.env, ['add', '--', 'bin.dat'])
    runGit(repo.directory, repo.env, ['commit', '-q', '-m', 'other binary'])
    assert.throws(() => runGit(repo.directory, repo.env, ['merge', 'binary']))

    const state = await snapshot(repo)
    await assert.rejects(
      () => scm.loadConflict(repo.git, state, 'bin.dat'),
      (error) => error.code === 'binary',
    )
  } finally {
    await cleanup(repo.root)
  }
})

test('worktrees are created, listed with their branch, and removed', async () => {
  const repo = await makeRepo()
  try {
    await commitFile(repo, 'a.txt', 'A\n', 'first')
    const target = path.join(repo.root, 'task-copy')
    const created = await scm.addWorktree(repo.git, target, 'task', { create: true })
    assert.equal(created.branch, 'task')
    assert.equal(created.path, path.resolve(target))

    let listing = await scm.listWorktrees(repo.git)
    assert.equal(listing.worktrees.length, 2)
    const main = listing.worktrees.find((item) => item.current)
    const copy = listing.worktrees.find((item) => !item.current)
    assert.equal(main.branch, 'main')
    assert.equal(copy.branch, 'task')
    assert.equal(copy.path, path.resolve(target))

    await assert.rejects(
      () => scm.addWorktree(repo.git, path.join(repo.root, 'second'), 'task'),
      (error) => error.code === 'worktree-branch',
    )

    await scm.removeWorktree(repo.git, target)
    listing = await scm.listWorktrees(repo.git)
    assert.equal(listing.worktrees.length, 1)
    assert.equal(listing.worktrees[0].current, true)
  } finally {
    await cleanup(repo.root)
  }
})

test('a dirty worktree refuses removal without force', async () => {
  const repo = await makeRepo()
  try {
    await commitFile(repo, 'a.txt', 'A\n', 'first')
    const target = path.join(repo.root, 'dirty-copy')
    await scm.addWorktree(repo.git, target, 'dirty', { create: true })
    await writeFile(path.join(target, 'a.txt'), 'changed\n', 'utf8')
    await assert.rejects(
      () => scm.removeWorktree(repo.git, target),
      (error) => error.code === 'worktree-dirty',
    )
    await scm.removeWorktree(repo.git, target, { force: true })
    const listing = await scm.listWorktrees(repo.git)
    assert.equal(listing.worktrees.length, 1)
  } finally {
    await cleanup(repo.root)
  }
})
