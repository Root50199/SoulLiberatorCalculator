import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { inspectClientData } from './client-data.mjs'

const files = [
  'db\\Production.xml',
  'db\\itemDB_Weapon.xml',
  'local\\xml\\production.english.txt',
  'local\\xml\\itemdb_weapon.english.txt',
]

async function fixture(t, config = { dataRoot: 'data' }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soul-liberator-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const configPath = path.join(directory, 'client-data.config.json')
  await writeFile(configPath, JSON.stringify(config))
  return { directory, configUrl: pathToFileURL(configPath) }
}

test('resolves relative to config, reports all sources, and leaves files unchanged', async (t) => {
  const { directory, configUrl } = await fixture(t)
  for (const file of files) {
    const destination = path.join(directory, 'data', file)
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, 'read-only source fixture')
  }
  const result = await inspectClientData(configUrl)
  assert.equal(result.root, path.join(directory, 'data'))
  assert.equal(result.available, true)
  assert.deepEqual(result.files.map((file) => file.relativePath), files)
  for (const file of result.files) {
    assert.equal(file.error, null)
    assert.equal(await readFile(path.join(result.root, file.relativePath), 'utf8'), 'read-only source fixture')
  }
})

test('missing source is an explicit per-file failure, not a successful empty catalog', async (t) => {
  const { configUrl } = await fixture(t)
  const result = await inspectClientData(configUrl)
  assert.equal(result.available, false)
  assert.equal(result.files.length, 4)
  assert.ok(result.files.every((file) => !file.available && file.error.includes('ENOENT')))
})

test('directories cannot pass as client files', async (t) => {
  const { directory, configUrl } = await fixture(t)
  await mkdir(path.join(directory, 'data', files[0]), { recursive: true })
  const result = await inspectClientData(configUrl)
  assert.equal(result.available, false)
  assert.equal(result.files[0].error, 'Expected a regular file.')
})

test('invalid config is rejected visibly', async (t) => {
  for (const dataRoot of ['', ' ', null, 12]) {
    const { configUrl } = await fixture(t, { dataRoot })
    await assert.rejects(inspectClientData(configUrl), /non-empty dataRoot/)
  }
})

test('malformed or missing config is not silently replaced', async (t) => {
  const { configUrl } = await fixture(t)
  await writeFile(configUrl, '{')
  await assert.rejects(inspectClientData(configUrl), SyntaxError)
  await rm(configUrl)
  await assert.rejects(inspectClientData(configUrl), { code: 'ENOENT' })
})
