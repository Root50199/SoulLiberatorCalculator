import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { storageLocation, uninstallerName } from './storage-location.mjs'

const base = {
  executableDirectory: path.join('C:', 'Apps', 'SL'),
  sourceDirectory: path.join('E:', 'repo'),
  appDataDirectory: path.join('C:', 'Users', 'me', 'AppData', 'Roaming'),
  smokeTest: false,
}

test('portable builds keep saves and runtime data beside the EXE', () => {
  const location = storageLocation({ ...base, packaged: true, exists: () => false })
  assert.deepEqual(location, { mode: 'portable', saveDirectory: base.executableDirectory,
    runtimeDirectory: path.join(base.executableDirectory, '.app-data') })
})

test('installed builds save to roaming AppData', () => {
  const location = storageLocation({ ...base, packaged: true,
    exists: file => file === path.join(base.executableDirectory, uninstallerName) })
  const saves = path.join(base.appDataDirectory, 'Soul Liberator Calculator')
  assert.deepEqual(location, { mode: 'installed', saveDirectory: saves, runtimeDirectory: path.join(saves, '.app-data') })
})

test('source runs keep the repository database and smoke runtime folder', () => {
  const location = storageLocation({ ...base, packaged: false, smokeTest: true, exists: () => true })
  assert.deepEqual(location, { mode: 'source', saveDirectory: null,
    runtimeDirectory: path.join(base.sourceDirectory, '.smoke-data') })
})
