import { access, readFile, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const configUrl = new URL('../client-data.config.json', import.meta.url)

const requiredFiles = [
  'db\\Production.xml',
  'db\\itemDB_Weapon.xml',
  'local\\xml\\production.english.txt',
  'local\\xml\\itemdb_weapon.english.txt',
]

export async function inspectClientData(sourceConfigUrl = configUrl) {
  const config = JSON.parse(await readFile(sourceConfigUrl, 'utf8'))
  if (typeof config.dataRoot !== 'string' || config.dataRoot.trim() === '') {
    throw new Error('client-data.config.json must contain a non-empty dataRoot string.')
  }

  const root = path.resolve(path.dirname(fileURLToPath(sourceConfigUrl)), config.dataRoot)
  const files = await Promise.all(requiredFiles.map(async (relativePath) => {
    const absolutePath = path.join(root, relativePath)
    try {
      const details = await stat(absolutePath)
      if (!details.isFile()) {
        return { relativePath, available: false, error: 'Expected a regular file.' }
      }
      await access(absolutePath, constants.R_OK)
      return { relativePath, available: true, error: null }
    } catch (error) {
      if (error instanceof Error && 'code' in error &&
          ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(String(error.code))) {
        return { relativePath, available: false, error: error.message }
      }
      throw error
    }
  }))

  return { root, available: files.every((file) => file.available), files }
}
