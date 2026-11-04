import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const configFile = join(projectRoot, 'vite.config.ts')
const clientDir = join(projectRoot, 'dist', 'client')

test('the built spectator page loads only its own bundle', async () => {
  await build({ root: projectRoot, configFile, logLevel: 'error' })

  const html = await readFile(join(clientDir, 'spectator.html'), 'utf8')
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/gi)].map(
    match => match[1],
  )

  assert.doesNotMatch(html, /canvasengine/i)
  assert.doesNotMatch(html, /\/assets\/client-[^/"']+\.js/i)
  assert.ok(scripts.length > 0, 'spectator.html has no module script')
  assert.deepEqual(
    scripts.filter(src => /(?:canvasengine|\/client-)/i.test(src)),
    [],
    `spectator.html loads game scripts: ${scripts.join(', ')}`,
  )

  const spectatorScript = scripts.find(src => /\/assets\/spectator-[^/]+\.js$/i.test(src))
  assert.ok(
    spectatorScript,
    `spectator.html has no spectator bundle (scripts: ${scripts.join(', ') || 'none'})`,
  )
  await access(join(clientDir, spectatorScript.replace(/^\//, '')))

  assert.match(
    html,
    /<link\b[^>]*\brel="stylesheet"[^>]*\bhref="[^"]*\/assets\/spectator-[^/]+\.css"/i,
    'spectator.html has no spectator stylesheet',
  )
  assert.match(
    html,
    /<a\b[^>]*\bhref="\.\/index\.html"[^>]*\bid="open-game-link"/i,
    'spectator.html lost its game link',
  )
})
