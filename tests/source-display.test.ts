import { test } from 'node:test'
import assert from 'node:assert/strict'
import { craftRecipeLabel, sourceLabels, sourceTooltip, inventorySourceTooltip } from '../src/source-display.ts'
import type { Catalog } from '../src/model.ts'
import type { Source } from '../src/model.ts'

const source: Source = {
  key: 'reward:123', itemId: 1, kind: 'reward', name: 'Reward pool 123',
  currency: null, currencyItemId: null, price: null, quantity: 1, origin: 'auto',
  evidence: 'client_table', availability: 'drop_probability_and_live_availability_unknown',
  details: '{}',
}

test('reward labels contain only distinct named content and difficulty', () => {
  const entry = { content_id: '700001', localized_name: 'Defeat Fomor Commander I', localized_difficulty: 'Elite' }
  assert.deepEqual(sourceLabels({ ...source, details: JSON.stringify({ contents: [
    entry, entry, { content_id: '999', localized_name: null },
    { localized_name: 'Missing difficulty', localized_difficulty: null },
  ] }) }), ['Defeat Fomor Commander I: Elite'])
})

test('unresolved reward entries disappear without invented names', () => {
  assert.deepEqual(sourceLabels({ ...source, details: '{"contents":[{"content_id":"999"}]}' }), [])
})

test('inventory source info includes alias shops, recipes, named rewards and notes only for this material', () => {
  const catalog: Catalog = { items: [
    { id: 1, name: 'Output', nameStatus: 'resolved', ahPrice: null, auctionEligible: true },
    { id: 2, name: 'Alias', nameStatus: 'resolved', ahPrice: null, auctionEligible: false },
    { id: 3, name: 'Obols', nameStatus: 'resolved', ahPrice: null, auctionEligible: true },
  ], recipes: [{ key: 'test', productId: 1, section: 'MagicCraft', output: 2,
    ingredients: [{ position: 1, quantity: 5, candidates: [2], matchStatus: 'verified' }] }],
    sources: [
      { ...source, key: 'shop', itemId: 2, kind: 'shop', name: 'Leannan',
        currency: 'item', currencyItemId: 3, price: 10, quantity: 1 },
      { ...source, key: 'craft:test', kind: 'craft', name: 'MagicCraft' },
      { ...source, details: '{"contents":[{"localized_name":"Test dungeon","localized_difficulty":"Elite"}]}' },
      { ...source, itemId: 99, name: 'Unrelated', kind: 'mob_drop' },
    ], notes: [{ itemId: 2, title: 'Note', message: 'Confirmed', status: 'confirmed' }],
    slIds: [], memberships: [], devMode: false }
  const text = inventorySourceTooltip(catalog, [1, 2])
  assert.match(text, /Leannan - 10 Obols for 1/)
  assert.match(text, /Craft: Magic Craft\nCraft\n2 Output\n5 x Alias/)
  assert.match(text, /Test dungeon: Elite/)
  assert.match(text, /Note: Confirmed/)
  assert.ok(!text.includes('Unrelated'))
  assert.equal(inventorySourceTooltip(catalog, [100]), 'No source information recorded for this item.')
})

test('crafts and shops use readable labels without provenance codes', () => {
  assert.deepEqual(sourceLabels({ ...source, kind: 'craft', name: 'MagicCraft' }), ['Craft: Magic Craft'])
  assert.deepEqual(sourceLabels({ ...source, kind: 'craft', name: 'MetalExtraction' }), ['Craft: Metal Conversion'])
  assert.deepEqual(sourceLabels({ ...source, kind: 'shop', name: 'Leannan' }), ['Leannan'])
  assert.deepEqual(sourceLabels({ ...source, kind: 'mob_drop', name: 'White Kiwi' }), ['Mob drop: White Kiwi'])
})

test('source tooltips retain notes and exact recorded recipe quantities', () => {
  const catalog: Catalog = { items: [
    { id: 1, name: 'Output', nameStatus: 'resolved', ahPrice: null, auctionEligible: true },
    { id: 2, name: 'Ingredient', nameStatus: 'resolved', ahPrice: null, auctionEligible: true },
  ], recipes: [{ key: 'test', productId: 1, section: 'Craft', output: 2,
    ingredients: [{ position: 1, quantity: 5, candidates: [2], matchStatus: 'verified' }] }],
  slIds: [], sources: [], notes: [], memberships: [], devMode: false }
  assert.equal(sourceTooltip(catalog, [{ ...source, key: 'craft:test', kind: 'craft',
    details: '{"notes":"At the workshop"}' }]), 'At the workshop\n\nCraft\n2 Output\n5 x Ingredient')
  assert.equal(sourceTooltip({ ...catalog, recipes: [] }, [{ ...source, origin: 'manual',
    kind: 'craft', details: '{"notes":"Manually recorded recipe"}' }]), 'Manually recorded recipe')
  const multiple = { ...catalog, recipes: [...catalog.recipes, { ...catalog.recipes[0], key: 'second' }] }
  assert.equal(craftRecipeLabel(multiple, 'test'), 'Craft recipe 1')
  assert.equal(craftRecipeLabel(multiple, 'second'), 'Craft recipe 2')
  assert.match(sourceTooltip(multiple, [{ ...source, key: 'craft:second', kind: 'craft' }]), /^Craft recipe 2\n/)
})
