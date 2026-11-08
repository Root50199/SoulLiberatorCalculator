import test from 'node:test'
import assert from 'node:assert/strict'
import { goldProgress, obolProgress } from '../src/obol-progress.ts'
import { calculatePlan } from '../src/planner.ts'
import type { Catalog, TrackingPlan } from '../src/model.ts'

const catalog: Catalog = {
  devMode: false, slIds: [1], memberships: [], notes: [],
  items: [1, 2, 3].map(id => ({ id, name: `Item ${id}`, auctionEligible: true, ahPrice: 1, nameStatus: 'resolved' })),
  recipes: [
    { key: 'root', productId: 1, section: 'MagicCraft', output: 1,
      ingredients: [{ position: 1, quantity: 2, candidates: [2], matchStatus: 'wildcard_category_candidate' }] },
    { key: 'child', productId: 2, section: 'MagicCraft', output: 1,
      ingredients: [{ position: 1, quantity: 3, candidates: [3], matchStatus: 'wildcard_category_candidate' }] },
  ],
  sources: [
    ...['root', 'child'].map((key, index) => ({ key: `craft:${key}`, itemId: index + 1,
      kind: 'craft', name: 'Magic Craft', price: null, quantity: 1, currency: null, currencyItemId: null,
      origin: 'auto', evidence: '', availability: '', details: '{}' })),
    { key: 'shop', itemId: 3, kind: 'shop', name: 'Leannan', price: 10, quantity: 1,
      currency: 'item', currencyItemId: 5300217, origin: 'auto', evidence: '', availability: '', details: '{}' },
  ],
}
const plan: TrackingPlan = { id: 'test', label: 'Test', itemId: 1, quantity: 1, inventory: {}, overrides: {} }

test('empty materials give zero credit; currency ownership is not material progress', () => {
  assert.deepEqual(obolProgress(catalog, { ...plan, inventory: { 5300217: 999 } }), { spent: 0, remaining: 60, total: 60 })
})
test('all-Obol material baseline differs from cheapest-route currency spending', () => {
  const priced = { ...catalog, items: catalog.items.map(item =>
    ({ ...item, ahPrice: item.id === 2 ? 100 : 1 })) }
  const selected = calculatePlan(priced, plan, 100, true)
  assert.equal(selected.obolSpend, 0)
  assert.equal(selected.tree.gold, 6)
  assert.equal(obolProgress(priced, plan).remaining, 60)
})
test('owned crafted items credit their required ingredient Obol value', () => {
  assert.deepEqual(obolProgress(catalog, { ...plan, inventory: { 2: 1 } }), { spent: 30, remaining: 30, total: 60 })
})
test('owned leaves credit only needed quantities and ignore selected AH overrides', () => {
  assert.deepEqual(obolProgress(catalog, { ...plan, inventory: { 3: 100 }, overrides: { root: 'ah:1' } }),
    { spent: 60, remaining: 0, total: 60 })
})
test('excess parents and descendants cannot double count or exceed total progress', () => {
  assert.deepEqual(obolProgress(catalog, { ...plan, inventory: { 2: 100, 3: 100 } }),
    { spent: 60, remaining: 0, total: 60 })
  const result = calculatePlan(catalog, { ...plan, inventory: { 2: 100, 3: 100 } }, 600000, true)
  assert.equal(result.obtainedUnits, 2)
  assert.equal(result.requiredUnits, 2)
})

test('gold progress weighs material value, excludes currency balance and caps excess stock', () => {
  const priced = { ...catalog, items: catalog.items.map(item => ({ ...item, ahPrice: item.id === 2 ? 30 : 10 })) }
  assert.deepEqual(goldProgress(priced, { ...plan, inventory: { 5300217: 100 } }, 100),
    { total: 60, obtained: 0, remaining: 60, percent: 0, missingPrices: [] })
  assert.deepEqual(goldProgress(priced, { ...plan, inventory: { 2: 1 } }, 100),
    { total: 60, obtained: 30, remaining: 30, percent: 50, missingPrices: [] })
  assert.deepEqual(goldProgress(priced, { ...plan, inventory: { 2: 100, 3: 100 } }, 100),
    { total: 60, obtained: 60, remaining: 0, percent: 100, missingPrices: [] })
})

test('gold progress stays unresolved when material prices are missing', () => {
  assert.equal(goldProgress({ ...catalog, sources: catalog.sources.filter(source => source.kind !== 'shop'),
    items: catalog.items.map(item => ({ ...item, ahPrice: null })) }, plan, 100), null)
})
test('opt-in unpriced progress reports numeric estimates and lists missing prices without saving zero', () => {
  const unknown = { ...catalog, sources: catalog.sources.filter(source => source.kind !== 'shop'),
    items: catalog.items.map(item => ({ ...item, ahPrice: null })) }
  const progress = goldProgress(unknown, plan, 100, true)
  assert.equal(progress?.remaining, 0)
  assert.equal(progress?.total, 0)
  assert.equal(progress?.percent, 0)
  assert.ok(progress?.missingPrices.includes('Enter AH gold price for Item 2.'))
  assert.equal(unknown.items[1].ahPrice, null)
})

test('one expensive material outweighs nine inexpensive units', () => {
  const weighted: Catalog = { ...catalog,
    items: catalog.items.map(item => ({ ...item, ahPrice: item.id === 2 ? 100 : 1 })),
    recipes: [{ ...catalog.recipes[0], ingredients: [
      { position: 1, quantity: 1, candidates: [2], matchStatus: 'wildcard_category_candidate' },
      { position: 2, quantity: 9, candidates: [3], matchStatus: 'wildcard_category_candidate' },
    ] }],
  }
  assert.deepEqual(goldProgress(weighted, { ...plan, inventory: { 2: 1 } }, 100),
    { total: 109, obtained: 100, remaining: 9, percent: 92, missingPrices: [] })
})
