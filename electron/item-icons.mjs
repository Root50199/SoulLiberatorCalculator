import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { inspectClientData } from './client-data.mjs'

// Approximate official-render accents, not live player dyes or verified client color-slot semantics.
export const renderDyes = [
  [232, 226, 210], [183, 124, 88], [39, 125, 101], [241, 237, 223],
  [66, 154, 120], [169, 112, 79], [222, 216, 200],
]

export function dyePixel(rgb, dye) {
  const clamp = value => Math.min(1, Math.max(0, value))
  const luminance = channels => channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722
  const source = rgb.map(value => value / 255), tint = dye.map(value => value / 255)
  const chroma = Math.max(...source) - Math.min(...source)
  const tintLight = luminance(tint)
  const strength = Math.min(.96, Math.max(.78, .9 * (1 - .18 * chroma) *
    (tintLight < .3 ? 1.06 : tintLight < .45 ? 1.02 : 1)))
  let colors = source.map((value, channel) => clamp(value + (tint[channel] - .5) * strength))
  if (tintLight < .35) {
    const recovery = Math.min(.18, Math.max(0, luminance(colors) - luminance(source)) * .55)
    colors = colors.map(value => clamp(value - recovery))
  }
  const gamma = tintLight < .3 ? 1.14 : tintLight < .45 ? 1.1 : tintLight < .65 ? 1.06 : 1.03
  const protection = luminance(source) > .8 ? .45 : luminance(source) > .65 ? .7 : 1
  colors = colors.map(value => value ** (1 + (gamma - 1) * protection))
  const light = luminance(colors)
  const saturation = 1 + (tintLight < .3 ? .16 : tintLight < .45 ? .12 : tintLight < .65 ? .08 : .05) *
    (1 - .3 * Math.min(1, chroma / .45))
  return colors.map((value, channel) => {
    const saturated = clamp(light + (value - light) * saturation)
    return Math.round((luminance(source) >= .82 ? Math.min(saturated, tint[channel]) : saturated) * 255)
  })
}

export function enhanceBakedMaterial(icon) {
  const pixels = [...icon.pixels]
  for (let i = 0; i < pixels.length; i += 4) {
    if (!pixels[i + 3]) continue
    const rgb = pixels.slice(i, i + 3).map(value => value / 255)
    const light = rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722
    const lifted = Math.max(light, Math.min(1, Math.max(0, .2 + (light - .2) * 1.12)))
    for (let c = 0; c < 3; c++) pixels[i + c] =
      Math.round(Math.min(1, Math.max(0, lifted + (rgb[c] - light) * 1.4)) * 255)
  }
  return { ...icon, pixels }
}

export function decodeInventoryDds(buffer, cellWidth, cellHeight, pageCount, dyes = null, pageIndices = [], preserveBaked = false) {
  if (![cellWidth, cellHeight, pageCount].every(n => Number.isSafeInteger(n) && n > 0)) {
    throw new Error('Invalid inventory cell dimensions/page count.')
  }
  if (buffer.length < 128 || buffer.toString('ascii', 0, 4) !== 'DDS ' ||
      buffer.readUInt32LE(84) !== 0 || buffer.readUInt32LE(88) !== 16 ||
      buffer.readUInt32LE(92) !== 31744 || buffer.readUInt32LE(96) !== 992 ||
      buffer.readUInt32LE(100) !== 31 || buffer.readUInt32LE(104) !== 32768) {
    throw new Error('Unsupported inventory DDS format; expected uncompressed A1R5G5B5.')
  }
  const height = buffer.readUInt32LE(12), width = buffer.readUInt32LE(16)
  if (!width || !height || buffer.length < 128 + width * height * 2 || width * height > 2000000) {
    throw new Error('Invalid DDS dimensions/data.')
  }
  const paged = pageCount > 1 && width >= cellWidth * 2 && height >= cellHeight
  const outputWidth = paged ? cellWidth : width
  const outputHeight = paged ? cellHeight : height
  const pixels = new Uint8Array(outputWidth * outputHeight * 4)
  let dyeCursor = 0
  for (let page = 0; page < (paged ? pageCount : 1); page++) {
    const pageWidth = Math.min(outputWidth, width - page * outputWidth)
    if (pageWidth <= 0) break
    if (paged && pageIndices.length && !pageIndices.includes(page + 1)) continue
    let visible = false
    for (let y = 0; y < outputHeight && !visible; y++) for (let x = 0; x < pageWidth && !visible; x++) {
      visible = Boolean(buffer.readUInt16LE(128 + (y * width + x + page * outputWidth) * 2) & 32768)
    }
    if (!visible) continue
    let colored = 0, covered = 0
    if (preserveBaked) for (let y = 0; y < outputHeight; y++) for (let x = 0; x < pageWidth; x++) {
      const value = buffer.readUInt16LE(128 + (y * width + x + page * outputWidth) * 2)
      if (!(value & 32768)) continue
      const rgb = [(value >> 10) & 31, (value >> 5) & 31, value & 31]
      covered++
      if (Math.max(...rgb) - Math.min(...rgb) > 2) colored++
    }
    const baked = preserveBaked && colored / covered > .1
    const pageDye = dyes?.[dyeCursor++ % dyes.length]
    for (let y = 0; y < outputHeight; y++) {
      for (let x = 0; x < pageWidth; x++) {
        const value = buffer.readUInt16LE(128 + (y * width + x + page * outputWidth) * 2)
        if (!(value & 32768)) continue
        const offset = (y * outputWidth + x) * 4
        const rgb = [Math.round(((value >> 10) & 31) * 255 / 31),
          Math.round(((value >> 5) & 31) * 255 / 31), Math.round((value & 31) * 255 / 31)]
        const gray = rgb[0] * .299 + rgb[1] * .587 + rgb[2] * .114
        const dye = dyes && !baked ? paged ? pageDye :
          dyes[Math.min(dyes.length - 1, Math.floor(gray / 255 * dyes.length))] : null
        const color = dye ? dyePixel(rgb, dye) : rgb
        // A1R5G5B5 layers have binary coverage; union alpha and average opaque overlaps.
        pixels.set(pixels[offset + 3] ? color.map((value, channel) =>
          Math.round((value + pixels[offset + channel]) / 2)) : color, offset)
        pixels[offset + 3] = 255
      }
    }
  }
  let left = outputWidth, right = -1, top = outputHeight, bottom = -1
  for (let y = 0; y < outputHeight; y++) for (let x = 0; x < outputWidth; x++) {
    if (!pixels[(y * outputWidth + x) * 4 + 3]) continue
    left = Math.min(left, x); right = Math.max(right, x)
    top = Math.min(top, y); bottom = Math.max(bottom, y)
  }
  if (right < left) throw new Error('Inventory icon is fully transparent.')
  const cropWidth = right - left + 1, cropHeight = bottom - top + 1
  const crop = new Uint8Array(cropWidth * cropHeight * 4)
  for (let y = 0; y < cropHeight; y++) {
    crop.set(pixels.subarray(((y + top) * outputWidth + left) * 4,
      ((y + top) * outputWidth + left + cropWidth) * 4), y * cropWidth * 4)
  }
  return { width: cropWidth, height: cropHeight, pixels: Array.from(crop) }
}

export class ItemIcons {
  constructor(allowedIds, dyedIds = allowedIds) {
    this.allowed = new Set(allowedIds)
    this.dyed = new Set(dyedIds)
    this.cache = new Map()
    this.metadata = null
    this.colorMaps = null
    this.colors = new Map()
  }
  async readColorMaps(root) {
    const buffer = await readFile(path.join(root, 'db', 'ColorTable.xml'))
    if (buffer[0] !== 255 || buffer[1] !== 254) throw new Error('Unsupported ColorTable encoding; expected UTF-16LE.')
    return new Map([...buffer.toString('utf16le').matchAll(/<ColorTable\s[^>]*>/g)].map(match => {
      const attributes = Object.fromEntries([...match[0].matchAll(/(\w+)="([^"]*)"/g)].map(m => [m[1], m[2]]))
      return [attributes.ColorMapID, attributes]
    }))
  }
  async materialColors(root, attributes) {
    this.colorMaps ??= this.readColorMaps(root)
    const maps = await this.colorMaps
    const colors = []
    for (const key of Object.keys(attributes).filter(key => /^App_Color[1-9]$/.test(key)).sort()) {
      const id = attributes[key]
      // These material rows use 255 for unassigned slots; no ColorTable entry exists.
      if (id === '255') { colors.push(null); continue }
      if (!this.colors.has(id)) {
        const map = maps.get(id)
        if (!map || !/^data\/color\/[A-Za-z0-9_.-]+\.raw$/i.test(map.Bitmap)) {
          throw new Error(`Unsupported material color map: ${id}.`)
        }
        const raw = await readFile(path.join(root, ...map.Bitmap.split('/').slice(1)))
        if (!raw.length || raw.length % 4) throw new Error(`Invalid material color bitmap: ${id}.`)
        // Client RAW swatches store RGB plus a fourth non-color byte. Average the palette, not a live random dye.
        const color = [0, 0, 0]
        for (let i = 0; i < raw.length; i += 4) for (let c = 0; c < 3; c++) color[c] += raw[i + c]
        this.colors.set(id, color.map(value => Math.round(value / (raw.length / 4))))
      }
      colors.push(this.colors.get(id))
    }
    return colors
  }
  async readMetadata(root) {
    const records = new Map()
    const files = (await readdir(path.join(root, 'db'))).filter(name => /^itemDB.*\.xml$/i.test(name))
    for (const filename of files) {
      const buffer = await readFile(path.join(root, 'db', filename))
      const encoding = buffer[0] === 255 && buffer[1] === 254 ? 'utf16le' :
        buffer[0] === 239 && buffer[1] === 187 && buffer[2] === 191 ? 'utf8' : null
      if (!encoding) throw new Error(`Unsupported inventory metadata encoding: ${filename}`)
      const xml = buffer.toString(encoding).replace(/^\uFEFF/, '')
      for (const match of xml.matchAll(/<Mabi_Item\s[^>]*>/g)) {
        const attributes = Object.fromEntries([...match[0].matchAll(/(\w+)="([^"]*)"/g)].map(m => [m[1], m[2]]))
        const id = Number(attributes.ID)
        if (this.allowed.has(id) && attributes.File_InvImage && !records.has(id)) records.set(id, attributes)
      }
    }
    return records
  }
  async load(id) {
    if (!Number.isSafeInteger(id) || !this.allowed.has(id)) throw new Error('Icon item must be an allowed catalog item.')
    if (this.cache.has(id)) return this.cache.get(id)
    const { root } = await inspectClientData()
    this.metadata ??= this.readMetadata(root)
    const attributes = (await this.metadata).get(id)
    if (!attributes) throw new Error(`Missing icon metadata for ${id}.`)
    const token = attributes.File_InvImage
    if (typeof token !== 'string' || !/^[A-Za-z0-9_]+$/.test(token)) {
      throw new Error(`Unsupported inventory texture token: ${token}`)
    }
    const files = []
    async function walk(folder) {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const full = path.join(folder, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (entry.name.toLowerCase() === `${token}.dds`.toLowerCase()) files.push(full)
      }
    }
    for (const folder of [path.join('image2', 'inven'), path.join('image', 'inven'), 'image2', 'image']) {
      const base = path.join(root, 'gfx', folder)
      try { await walk(base) }
      catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      if (files.length) break
    }
    if (files.length !== 1) throw new Error(`Expected one inventory DDS for ${id}, found ${files.length}.`)
    const buffer = await readFile(files[0])
    const original = decodeInventoryDds(buffer, Number(attributes.Inv_XSize) * 24,
      Number(attributes.Inv_YSize) * 24, 1)
    let visible = 0, gray = 0
    for (let i = 0; i < original.pixels.length; i += 4) {
      if (!original.pixels[i + 3]) continue
      visible++
      const rgb = original.pixels.slice(i, i + 3)
      if (Math.max(...rgb) - Math.min(...rgb) <= 12) gray++
    }
    const material = id !== 5300217 && !this.dyed.has(id)
    // Confirmed Shyllien Crystal screenshot: this tinted source still needs its ColorMap 30.
    const mappedCrystal = token.toLowerCase() === 'item_fragment_of_sulien'
    const materialMask = material && (mappedCrystal || gray / visible >= .9 ||
      buffer.readUInt32LE(16) >= Number(attributes.Inv_XSize) * 48)
    const pages = attributes.App_UseC4Layer === 'true' || materialMask ?
      Math.max(1, ...Object.keys(attributes).filter(key => /^App_Color[1-9]$/.test(key)).map(key => Number(key.slice(-1)))) : 1
    const dyes = id === 5300217 ? null : this.dyed.has(id) ? renderDyes :
      materialMask ? await this.materialColors(root, attributes) : null
    let result = decodeInventoryDds(buffer,
      Number(attributes.Inv_XSize) * 24, Number(attributes.Inv_YSize) * 24, pages,
      dyes,
      Object.keys(attributes).filter(key => /^App_Color[1-9]$/.test(key)).map(key => Number(key.slice(-1))), material && !mappedCrystal)
    const herb = attributes.Category?.includes('/herb/')
    const gemstonePowder = token.toLowerCase() === 'item_gemstone_powder' || id === 5100273
    if (material && !materialMask && !herb && !gemstonePowder) result = enhanceBakedMaterial(result)
    this.cache.set(id, result)
    return result
  }
}
