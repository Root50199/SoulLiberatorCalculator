import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeInventoryDds, dyePixel, enhanceBakedMaterial, renderDyes, ItemIcons } from './item-icons.mjs'
import { PlannerStore } from './planner-store.mjs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { inspectClientData } from './client-data.mjs'

const sourceTest = (name, run) => test(name,
  { skip: process.env.SOUL_LIBERATOR_SOURCE_TESTS !== '1' && 'Optional client-dump test; set SOUL_LIBERATOR_SOURCE_TESTS=1.' }, run)

test('bundled catalog icons are valid PNGs without a client dump', async () => {
  const store = new PlannerStore()
  try {
    for (const id of [...store.catalog().items.map(item => item.id), 'program-obol']) {
      const png = await readFile(new URL(`../public/item-icons/${id}.png`, import.meta.url))
      assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
      assert.ok(png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0, String(id))
    }
  } finally { store.close() }
})

test('inventory alpha/pages composite without padding or transparent pixel overwrites', () => {
  const b = Buffer.alloc(128 + 4 * 2)
  b.write('DDS ')
  b.writeUInt32LE(1, 12); b.writeUInt32LE(4, 16)
  for (const [at, value] of [[88, 16], [92, 31744], [96, 992], [100, 31], [104, 32768]]) b.writeUInt32LE(value, at)
  b.writeUInt16LE(32768 | 31744, 128)
  b.writeUInt16LE(32768 | 31, 134)
  const icon = decodeInventoryDds(b, 2, 1, 2)
  assert.equal(icon.width, 2)
  assert.deepEqual(icon.pixels, [255, 0, 0, 255, 0, 0, 255, 255])
  const dyed = decodeInventoryDds(b, 2, 1, 2, renderDyes)
  assert.deepEqual(dyed.pixels.slice(0, 3), dyePixel([255, 0, 0], renderDyes[0]))
  assert.deepEqual(dyed.pixels.slice(4, 7), dyePixel([0, 0, 255], renderDyes[1]))
  assert.equal(dyed.pixels[3], 255)
  assert.throws(() => decodeInventoryDds(Buffer.alloc(8), 2, 1, 2), /Unsupported/)
  assert.throws(() => decodeInventoryDds(b, NaN, 1, 2), /Invalid inventory/)
  assert.throws(() => decodeInventoryDds(b.subarray(0, 130), 2, 1, 2), /Invalid DDS/)
})
test('render-inspired dyes preserve dark shading and add teal/copper chroma', () => {
  assert.ok(Math.max(...dyePixel([0, 0, 0], renderDyes[2])) < 10)
  const dark = dyePixel([60, 60, 60], renderDyes[2])
  const bright = dyePixel([200, 200, 200], renderDyes[2])
  assert.ok(bright[1] > dark[1])
  assert.ok(bright[1] > bright[0])
  assert.ok(dyePixel([180, 180, 180], renderDyes[1])[0] > dyePixel([180, 180, 180], renderDyes[1])[2])
})
test('blank/omitted pages do not consume dyes and opaque overlaps average colors', () => {
  const b = Buffer.alloc(128 + 6)
  b.write('DDS '); b.writeUInt32LE(1, 12); b.writeUInt32LE(3, 16)
  for (const [at, value] of [[88, 16], [92, 31744], [96, 992], [100, 31], [104, 32768]]) b.writeUInt32LE(value, at)
  b.writeUInt16LE(32768 | 31744, 128)
  b.writeUInt16LE(32768 | 31, 132)
  const icon = decodeInventoryDds(b, 1, 1, 3, renderDyes, [1, 3])
  const first = dyePixel([255, 0, 0], renderDyes[0])
  const second = dyePixel([0, 0, 255], renderDyes[1])
  assert.deepEqual(icon.pixels, [...first.map((v, i) => Math.round((v + second[i]) / 2)), 255])
})
sourceTest('all 29 SL icon textures resolve and render from configured dump', async () => {
  const store = new PlannerStore()
  try {
    const icons = new ItemIcons(store.catalog().slIds)
    for (const id of store.catalog().slIds) {
      const icon = await icons.load(id)
      assert.ok(icon.width > 0 && icon.height > 0, String(id))
      assert.equal(icon.pixels.length, icon.width * icon.height * 4)
      assert.ok(icon.pixels.some((n, i) => i % 4 === 3 && n > 0), String(id))
      assert.ok(icon.pixels.every((n, i) => i % 4 !== 3 || n === 0 || n === 255), String(id))
      if (id === 1230039) {
        const visibleRgb = icon.pixels.filter((value, index) => index % 4 !== 3 && icon.pixels[index - index % 4 + 3])
        assert.ok(visibleRgb.reduce((sum, value) => sum + value, 0) / visibleRgb.length > 110,
          'Staff tint must not regress to the dull multiplicative preview')
      }
    }
    await assert.rejects(() => icons.load(42), /allowed catalog/)
  } finally { store.close() }
})
sourceTest('program Obol icon resolves by currency ID without broadening renderer icon access', async () => {
  const icon = await new ItemIcons([5300217]).load(5300217)
  assert.ok(icon.width > 0 && icon.height > 0)
  assert.equal(icon.pixels.length, icon.width * icon.height * 4)
  assert.ok(icon.pixels.some((value, index) => index % 4 === 3 && value === 255))
  await assert.rejects(() => new ItemIcons([1230039]).load(5300217), /allowed catalog/)
})
sourceTest('all catalog owned-material icons resolve from catalog families and legacy texture roots', async () => {
  const store = new PlannerStore()
  try {
    const catalog = store.catalog()
    const icons = new ItemIcons(catalog.items.map(item => item.id), catalog.slIds)
    const ids = new Set(catalog.items.map(item => item.id))
    for (const id of ids) {
      const icon = await icons.load(id)
      assert.ok(icon.width > 0 && icon.height > 0, String(id))
      if ([51101, 51102, 51109].includes(id)) {
        assert.ok(icon.width <= 24 && icon.height <= 48, 'Herb pages must assemble into one inventory cell.')
        const totals = [0, 0, 0]
        for (let i = 0; i < icon.pixels.length; i += 4) {
          if (icon.pixels[i + 3]) for (let c = 0; c < 3; c++) totals[c] += icon.pixels[i + c]
        }
        if (id === 51101) assert.ok(totals[0] > totals[2] * 2, 'Bloody Herb must use the red client map.')
        if (id === 51102) assert.ok(totals[2] > totals[0] * 2, 'Mana Herb must use the blue client map.')
      }
    }
    await assert.rejects(() => icons.load(42), /allowed catalog/)
  } finally { store.close() }
})
sourceTest('baked material colors use reference contrast/chroma correction without gamma', async () => {
  const { root } = await inspectClientData()
  const buffer = await readFile(path.join(root, 'gfx', 'image2', 'inven', 'item', 'item_bri_leith_core.dds'))
  const source = decodeInventoryDds(buffer, 48, 48, 1)
  const rendered = await new ItemIcons([5100303], []).load(5100303)
  assert.deepEqual(rendered, enhanceBakedMaterial(source))
})
test('baked correction preserves dark detail and alpha while expanding color and highlights', () => {
  const source = { width: 3, height: 1, pixels: [20, 30, 60, 255, 140, 180, 240, 255, 0, 0, 0, 0] }
  const result = enhanceBakedMaterial(source)
  assert.ok(result.pixels[2] - result.pixels[0] > 40)
  assert.ok(result.pixels[6] > 240)
  assert.ok(result.pixels[0] <= 20)
  assert.equal(result.pixels[3], 255)
  assert.deepEqual(result.pixels.slice(8), source.pixels.slice(8))
})
sourceTest('Shyllien Crystal and event alias apply their magenta map despite tinted source RGB', async () => {
  const { root } = await inspectClientData()
  const buffer = await readFile(path.join(root, 'gfx', 'image2', 'inven', 'item', 'item_Fragment_of_Sulien.dds'))
  const expected = decodeInventoryDds(buffer, 24, 24, 3, [[255, 0, 255], [255, 0, 255], [255, 0, 255]], [1, 2, 3])
  const icons = new ItemIcons([67200, 67244], [])
  for (const id of [67200, 67244]) {
    const icon = await icons.load(id)
    assert.deepEqual(icon, expected)
    const totals = [0, 0, 0]
    let visible = 0
    for (let i = 0; i < icon.pixels.length; i += 4) if (icon.pixels[i + 3]) {
      visible++
      for (let c = 0; c < 3; c++) totals[c] += icon.pixels[i + c]
    }
    assert.ok(totals[0] / visible > 220 && totals[2] / visible > 220)
    assert.equal(totals[1], 0, 'Confirmed in-game crystal has zero green, not a pastel-purple wash.')
  }
})
test('dye highlights are capped to their dye RGB, matching the reference pipeline', () => {
  assert.deepEqual(dyePixel([255, 255, 255], [171, 14, 44]), [171, 14, 44])
  assert.deepEqual(dyePixel([255, 255, 255], [0, 75, 177]), [0, 75, 177])
})
test('partial final pages assemble while baked-color pages bypass mask dyes', () => {
  const b = Buffer.alloc(128 + 32 * 2)
  b.write('DDS ')
  b.writeUInt32LE(1, 12); b.writeUInt32LE(32, 16)
  for (const [at, value] of [[88, 16], [92, 31744], [96, 992], [100, 31], [104, 32768]]) b.writeUInt32LE(value, at)
  b.writeUInt16LE(32768 | 31744, 128)
  b.writeUInt16LE(32768 | (15 << 10) | (15 << 5) | 15, 128 + 13 * 2)
  b.writeUInt16LE(32768 | (15 << 10) | (15 << 5) | 15, 128 + 26 * 2)
  const dyes = [[0, 255, 0], [0, 0, 255], [255, 0, 0]]
  const icon = decodeInventoryDds(b, 12, 1, 3, dyes, [1, 2, 3], true)
  assert.equal(icon.width, 3)
  assert.deepEqual(icon.pixels.slice(0, 4), [255, 0, 0, 255])
  assert.ok(icon.pixels[6] > icon.pixels[4], 'Second grayscale page uses blue dye.')
  assert.ok(icon.pixels[8] > icon.pixels[10], 'Partial third page uses red dye.')
})
test('baked single-page equipment keeps source color instead of luminance-binned dyes', () => {
  const b = Buffer.alloc(128 + 2)
  b.write('DDS '); b.writeUInt32LE(1, 12); b.writeUInt32LE(1, 16)
  for (const [at, value] of [[88, 16], [92, 31744], [96, 992], [100, 31], [104, 32768]]) b.writeUInt32LE(value, at)
  b.writeUInt16LE(32768 | (20 << 10) | (26 << 5) | 28, 128)
  const raw = decodeInventoryDds(b, 2, 2, 1)
  assert.deepEqual(decodeInventoryDds(b, 2, 2, 1, renderDyes, [1], true).pixels, raw.pixels)
  assert.notDeepEqual(decodeInventoryDds(b, 2, 2, 1, renderDyes, [1]).pixels, raw.pixels)
})
sourceTest('Soul Liberator Orb keeps its baked glass colors', async () => {
  const store = new PlannerStore()
  try {
    const catalog = store.catalog()
    const icon = await new ItemIcons(catalog.items.map(item => item.id), catalog.slIds).load(1460003)
    const { root } = await inspectClientData()
    const raw = decodeInventoryDds(await readFile(path.join(root, 'gfx', 'image2', 'inven', 'tools',
      'UU_weapon_muri_orb.dds')), 48, 48, 1)
    assert.deepEqual(icon.pixels, raw.pixels)
  } finally { store.close() }
})
