// Run with CHROME_PATH pointing to a Chromium executable. No server or profile access needed.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const temp = mkdtempSync(join(tmpdir(), 'ide-menu-'))
try {
  for (const dir of ['editor/', '']) {
    const root = new URL(`../${dir}`, import.meta.url)
    const source = readFileSync(new URL('client.js', root), 'utf8').replace(/\r\n/g, '\n')
    const loader = source.slice(source.indexOf('let monacoPromise'), source.indexOf('return monacoPromise\n    }') + 'return monacoPromise\n    }'.length)
    for (const lang of ['ru', 'en']) {
      const html = join(temp, 'case.html')
      writeFileSync(html, `<!doctype html><html lang="${lang}"><meta charset="utf-8"><div id="host" style="width:600px;height:300px"></div><output></output><script>
        const ASSET_BASE = ${JSON.stringify(new URL('vendor/vs', root).href)};
        ${loader}
        loadMonaco().then(m => {const e=m.editor.create(host,{value:'x'}); document.querySelector('output').textContent=e.getAction('editor.action.quickCommand').label}).catch(e=>document.querySelector('output').textContent=e.message);
      </script></html>`)
      const run = spawnSync(process.env.CHROME_PATH || 'chrome', ['--headless', '--disable-gpu', '--allow-file-access-from-files', `--user-data-dir=${join(temp, 'profile')}`, '--virtual-time-budget=5000', '--dump-dom', pathToFileURL(html).href], { encoding: 'utf8', maxBuffer: 5e6, timeout: 20000 })
      if (run.error) throw run.error
      const label = run.stdout.match(/<output>([^<]*)<\/output>/)?.[1]
      console.log(`${dir || 'IDE/'} ${lang}: ${label}`)
      assert.match(label ?? '', lang === 'ru' ? /палитра команд/i : /Command Palette/i)
    }
  }
} finally {
  rmSync(temp, { recursive: true, force: true, maxRetries: 5 })
}
