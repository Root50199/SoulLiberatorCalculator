import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { crc32, inflateSync } from 'node:zlib'
import { equipmentArtSource, equipmentArtUrl } from '../src/equipment-art.ts'

test('every catalog item has a complete pre-rendered RGBA PNG with valid checksums', () => {
  const db = new DatabaseSync(new URL('../data/soul-liberator.sqlite', import.meta.url), { readOnly: true })
  try {
    const ids = db.prepare('SELECT item_id FROM items WHERE catalog_current=1').all().map(row => String(row.item_id))
    for (const name of [...ids, 'program-obol']) {
      const image = readFileSync(new URL(`../public/item-icons/${name}.png`, import.meta.url))
      assert.deepEqual(image.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      const width = image.readUInt32BE(16), height = image.readUInt32BE(20)
      assert.ok(width > 0 && height > 0, name)
      assert.equal(image[24], 8); assert.equal(image[25], 6)
      const compressed: Buffer[] = []
      let ended = false
      for (let offset = 8; offset < image.length;) {
        const length = image.readUInt32BE(offset), end = offset + 8 + length
        assert.equal(crc32(image.subarray(offset + 4, end)), image.readUInt32BE(end), name)
        const type = image.toString('ascii', offset + 4, offset + 8)
        if (type === 'IDAT') compressed.push(image.subarray(offset + 8, end))
        if (type === 'IEND') ended = true
        offset = end + 4
      }
      assert.ok(ended, name)
      const rows = inflateSync(Buffer.concat(compressed))
      assert.equal(rows.length, height * (width * 4 + 1), name)
      let visible = false
      for (let y = 0; y < height; y++) {
        const offset = y * (width * 4 + 1)
        assert.equal(rows[offset], 0)
        for (let x = 0; x < width; x++) {
          const alpha = rows[offset + 1 + x * 4 + 3]
          assert.ok(alpha === 0 || alpha === 255, name)
          if (alpha) visible = true
        }
      }
      assert.ok(visible, name)
      if (name === 'program-obol') assert.equal(width, height)
    }
    assert.equal(ids.length, 244)
    assert.ok(!ids.includes('90201'))
  } finally { db.close() }
})

test('every catalog SL ID has a local valid PNG, with a shared marionette pair', () => {
  const db = new DatabaseSync(new URL('../data/soul-liberator.sqlite', import.meta.url), { readOnly: true })
  try {
    const ids = db.prepare('SELECT item_id FROM sl_items').all().map(row => Number(row.item_id))
    assert.equal(ids.length, 29)
    for (const id of ids) {
      const url = equipmentArtUrl(id)
      assert.match(url, /^\.\/equipment-art\/sl-[a-z0-9-]+\.png$/)
      const image = readFileSync(new URL(`../public/${url.slice(2)}`, import.meta.url))
      assert.deepEqual(image.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      assert.equal(image.toString('ascii', 12, 16), 'IHDR')
      assert.ok(image.readUInt32BE(16) >= 350 && image.readUInt32BE(20) >= 500, String(id))
    }
    assert.equal(new Set(ids.map(equipmentArtUrl)).size, 28)
    assert.equal(equipmentArtUrl(1640003), equipmentArtUrl(1640004))
    assert.equal(equipmentArtUrl(1230039), './equipment-art/sl-staff.png')
    assert.equal(equipmentArtUrl(1080048), './equipment-art/sl-lyre.png')
    assert.match(equipmentArtSource, /28948\/generation-27.*#soul-liberator-weapons$/)
    assert.throws(() => equipmentArtUrl(42), /No official/)
  } finally { db.close() }
})
