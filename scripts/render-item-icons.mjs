import { mkdir, writeFile } from 'node:fs/promises'
import { crc32, deflateSync } from 'node:zlib'
import { ItemIcons } from '../electron/item-icons.mjs'
import { PlannerStore } from '../electron/planner-store.mjs'

function png(icon) {
  const chunk = (type, data) => {
    const name = Buffer.from(type)
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4)
    size.writeUInt32BE(data.length)
    checksum.writeUInt32BE(crc32(Buffer.concat([name, data])))
    return Buffer.concat([size, name, data, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(icon.width); header.writeUInt32BE(icon.height, 4)
  header[8] = 8; header[9] = 6
  const stride = icon.width * 4
  const rows = Buffer.alloc((stride + 1) * icon.height)
  for (let y = 0; y < icon.height; y++) {
    Buffer.from(icon.pixels.slice(y * stride, (y + 1) * stride)).copy(rows, y * (stride + 1) + 1)
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

function presentation(icon) {
  const pixels = [...icon.pixels]
  const clamp = value => Math.max(0, Math.min(1, value))
  for (let i = 0; i < pixels.length; i += 4) {
    if (!pixels[i + 3]) continue
    const rgb = pixels.slice(i, i + 3).map(value => clamp((value / 255 - .5) * 1.28 + .5))
    const light = rgb[0] * .213 + rgb[1] * .715 + rgb[2] * .072
    for (let c = 0; c < 3; c++) pixels[i + c] =
      Math.round(clamp(clamp(light + (rgb[c] - light) * 1.24) * 1.18) * 255)
  }
  return { ...icon, pixels }
}

const store = new PlannerStore()
try {
  const catalog = store.catalog()
  const icons = new ItemIcons(catalog.items.map(item => item.id), catalog.slIds)
  const folder = new URL('../public/item-icons/', import.meta.url)
  await mkdir(folder, { recursive: true })
  for (const item of catalog.items) {
    const icon = await icons.load(item.id)
    await writeFile(new URL(`${item.id}.png`, folder), png(presentation(icon)))
    if (item.id === 5300217) {
      const size = Math.max(icon.width, icon.height)
      const pixels = new Array(size * size * 4).fill(0)
      const left = Math.floor((size - icon.width) / 2), top = Math.floor((size - icon.height) / 2)
      for (let y = 0; y < icon.height; y++) for (let x = 0; x < icon.width; x++) {
        const from = (y * icon.width + x) * 4, to = ((y + top) * size + x + left) * 4
        for (let c = 0; c < 4; c++) pixels[to + c] = icon.pixels[from + c]
      }
      await writeFile(new URL('program-obol.png', folder), png({ width: size, height: size, pixels }))
    }
  }
  console.log(`Rendered ${catalog.items.length} inventory icons and unfiltered program Obol.`)
} finally { store.close() }
