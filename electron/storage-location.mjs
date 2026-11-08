import { existsSync } from 'node:fs'
import path from 'node:path'

export const productName = 'Soul Liberator Calculator'
export const uninstallerName = `Uninstall ${productName}.exe`

// The NSIS installer places its uninstaller beside the EXE; the portable ZIP never contains one.
export function isInstalledBuild(executableDirectory, exists = existsSync) {
  return exists(path.join(executableDirectory, uninstallerName))
}

export function storageLocation({ packaged, executableDirectory, sourceDirectory, appDataDirectory, smokeTest,
  exists = existsSync }) {
  const runtimeName = smokeTest ? '.smoke-data' : '.app-data'
  if (!packaged) return { mode: 'source', saveDirectory: null, runtimeDirectory: path.join(sourceDirectory, runtimeName) }
  if (isInstalledBuild(executableDirectory, exists)) {
    const saveDirectory = path.join(appDataDirectory, productName)
    return { mode: 'installed', saveDirectory, runtimeDirectory: path.join(saveDirectory, runtimeName) }
  }
  return { mode: 'portable', saveDirectory: executableDirectory,
    runtimeDirectory: path.join(executableDirectory, runtimeName) }
}
