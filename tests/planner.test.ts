import test from 'node:test'
import assert from 'node:assert/strict'
import { calculatePlan } from '../src/planner.ts'
import type { Catalog, TrackingPlan } from '../src/model.ts'
import { aliasInventory, materialAliases, materialRequirements, sortInventoryMaterials, baseItemName, digitCaret, groupDigits, materialPriceComparison } from '../src/price-display.ts'

const catalog: Catalog = {
  devMode: true, notes: [], memberships: [], slIds: [1],
  items: [
    { id: 1, name: 'SL test', nameStatus: 'resolved', ahPrice: 1000, auctionEligible: true },
    { id: 2, name: 'Intermediate', nameStatus: 'resolved', ahPrice: 100, auctionEligible: true },
    { id: 3, name: 'Material', nameStatus: 'resolved', ahPrice: 10, auctionEligible: true },
    { id: 4, name: 'Material (Not tradable)', nameStatus: 'resolved', ahPrice: null, auctionEligible: false },
  ],
  recipes: [
    { key: 'root', productId: 1, section: 'MagicCraft', output: 1, ingredients: [
      { position: 1, quantity: 2, matchStatus: 'wildcard_category_candidate', candidates: [2] },
    ] },
    { key: 'child', productId: 2, section: 'MagicCraft', output: 1, ingredients: [
      { position: 1, quantity: 3, matchStatus: 'wildcard_category_candidate', candidates: [3, 4] },
    ] },
  ],
  sources: [
    { key: 'craft:root', itemId: 1, kind: 'craft', name: 'Craft', currency: null, currencyItemId: null,
      price: null, quantity: 1, origin: 'auto', evidence: 'client', availability: '', details: '{}' },
    { key: 'craft:child', itemId: 2, kind: 'craft', name: 'Craft', currency: null, currencyItemId: null,
      price: null, quantity: 1, origin: 'auto', evidence: 'client', availability: '', details: '{}' },
    { key: 'shop', itemId: 4, kind: 'shop', name: 'Leannan', currency: 'item', currencyItemId: 5300217,
      price: 1, quantity: 1, origin: 'auto', evidence: 'user', availability: '', details: '{}' },
  ],
}

test('NPC comparison retains gold and ducat prices per unit without converting ducats', () => {
  const offers = ['gold', 'ducats'].map(currency => ({ ...catalog.sources[2],
    key: currency, itemId: 3, currency, currencyItemId: null, price: 100, quantity: 5, origin: 'manual' }))
  const comparison = materialPriceComparison({ ...catalog, sources: offers }, [3], 600000)
  assert.deepEqual(comparison.npcPrices.map(offer => [offer.currency, offer.price]), [['gold', 20], ['ducats', 20]])
  assert.equal(comparison.obolGold, null)
})
test('tracked SL crafting root ignores root purchases, owned SL and stale root overrides', () => {
  const result = calculatePlan(catalog, { id: 'root-test', itemId: 1, label: 'Test', quantity: 1,
    inventory: { 1: 1 }, overrides: { root: 'ah:1' } }, 600000, true)
  assert.equal(result.tree.routeKey, 'recipe:root')
  assert.equal(result.tree.obtained, 0)
  assert.equal(result.tree.children.length, 1)
  assert.ok(result.tree.options.every(option => option.key.startsWith('recipe:')))
  assert.equal(result.tree.route, 'Craft: Magic Craft')
})
const plan: TrackingPlan = { id: 'a', itemId: 1, label: 'Test', quantity: 1, inventory: {}, overrides: {} }
test('inventory sorts by minimum tree depth, descending unit gold, then name with unknown prices last', () => {
  const items = [
    { ...catalog.items[1], id: 10, name: 'Zulu', ahPrice: 5 },
    { ...catalog.items[1], id: 11, name: 'Alpha', ahPrice: 5 },
    { ...catalog.items[1], id: 12, name: 'Expensive', ahPrice: 100 },
    { ...catalog.items[1], id: 13, name: 'Deep', ahPrice: 1000 },
    { ...catalog.items[1], id: 14, name: 'Absent', ahPrice: 10000 },
    { ...catalog.items[1], id: 15, name: 'Unknown', ahPrice: null },
    { ...catalog.items[1], id: 16, name: 'Zero', ahPrice: 0 },
  ]
  const groups = materialAliases({ ...catalog, items }, new Set(items.map(item => item.id)))
  const result = calculatePlan(catalog, { ...plan, overrides: { root: 'recipe:root' } }, 100)
  const leaf = { ...result.tree.children[0], children: [] }
  const tree = { ...result.tree, children: [10, 11, 12, 15, 16].map(id => ({
    ...leaf, itemId: id, candidateIds: [id],
    children: id === 10 ? [{ ...leaf, itemId: 13, candidateIds: [13, 12] }] : [],
  })) }
  assert.deepEqual(sortInventoryMaterials(groups, { ...result, tree }).map(group => group.item.id),
    [12, 11, 10, 16, 15, 13, 14])
  assert.deepEqual(sortInventoryMaterials(groups, null).map(group => group.item.id),
    [14, 13, 12, 11, 10, 16, 15])
  assert.deepEqual(groups.map(group => group.item.id), [14, 11, 13, 12, 15, 16, 10])
})
test('opt-in missing prices select zero-cost Auto routes and propagate price annotations without hiding unverified mechanics', () => {
  const unpriced = { ...catalog, items: catalog.items.map(item => ({ ...item,
    ahPrice: item.id === 3 ? null : item.ahPrice })) }
  const forced = { ...plan, overrides: { 'root/root:1': 'recipe:child' } }
  const result = calculatePlan(unpriced, forced, 600000, true, true)
  assert.equal(result.gold, 0)
  assert.deepEqual(result.unresolved, [])
  assert.deepEqual(result.tree.missingPrices, ['Enter AH gold price for Material.'])
  assert.equal(result.tree.children[0].children[0].routeKey, 'ah:3')
  const excluded = { ...unpriced, recipes: unpriced.recipes.map(recipe =>
    recipe.key === 'child' ? { ...recipe, section: 'MetalExtraction' } : recipe) }
  assert.ok(calculatePlan(excluded, forced, 600000, true, true).unresolved.length > 0)
  assert.equal(unpriced.items.find(item => item.id === 3)?.ahPrice, null)
})
test('needed counts use full selected quantities and suppress descendants of owned parents', () => {
  const forced = { ...plan, overrides: { root: 'recipe:root', 'root/root:1': 'recipe:child' } }
  const result = calculatePlan(catalog, forced, 100)
  const needed = materialRequirements(result)
  assert.equal(needed.get(2), 2)
  assert.equal(needed.get(3), 6)
  assert.equal(needed.get(5300217), result.obolSpend)
  const owned = calculatePlan(catalog, { ...forced, inventory: { 2: 2 } }, 100)
  assert.equal(materialRequirements(owned).get(3) ?? 0, 0)
})
test('material aliases collapse only explicit same-name candidates and preserve variant inventory', () => {
  const groups = materialAliases(catalog, new Set([1, 2, 3, 4]))
  assert.equal(groups.length, 3)
  assert.deepEqual(groups.find(group => group.name === 'Material')?.ids, [3, 4])
  assert.deepEqual(aliasInventory({ 3: 2, 4: 5, 99: 7 }, [3, 4], 9), { 3: 4, 4: 5, 99: 7 })
  assert.deepEqual(aliasInventory({ 3: 2, 4: 5, 99: 7 }, [3, 4], 3), { 3: 2, 4: 1, 99: 7 })
  assert.throws(() => aliasInventory({}, [3, 4], -1), /safe integer/)
  const unrelated = { ...catalog, recipes: [] }
  assert.equal(materialAliases(unrelated, new Set([3, 4])).length, 2)
})
test('grouped price editing retains digit positions and removes only the display tradability suffix', () => {
  assert.equal(groupDigits('123456789'), '123,456,789')
  assert.equal(groupDigits(''), '')
  assert.equal(digitCaret('1234', 4), 5)
  assert.equal(digitCaret('123,456', 0), 0)
  assert.equal(digitCaret('123,456', 5), 5)
  assert.equal(baseItemName('Material (Not tradable)'), 'Material')
  assert.equal(baseItemName('Material (Event)'), 'Material (Event)')
})
test('per-unit price previews include candidate Obols and crafting without owned inventory', () => {
  assert.deepEqual(materialPriceComparison(catalog, [3, 4], 5), { npcPrices: [], obolsPerItem: 1, obolGold: 5, craftGold: null, craftMissingPrices: [], craftOutputs: [], hasCraft: false })
  assert.deepEqual(materialPriceComparison(catalog, [2], 5), { npcPrices: [], obolsPerItem: null, obolGold: null, craftGold: 15, craftMissingPrices: [], craftOutputs: [1], hasCraft: true })
  const unknown = structuredClone(catalog)
  unknown.items[2].ahPrice = null
  unknown.sources = unknown.sources.filter(s => s.key !== 'shop')
  assert.equal(materialPriceComparison(unknown, [2], 5).craftGold, null)
  assert.equal(materialPriceComparison(unknown, [2], 5).hasCraft, true)
  assert.equal(catalog.items[3].name, 'Material (Not tradable)')
})
test('empty tracker requires in-tab equipment selection', () => {
  assert.throws(() => calculatePlan(catalog, { ...plan, itemId: null }, 600000), /Select equipment/)
})

test('compares AH and crafting at every tree level', () => {
  assert.equal(calculatePlan(catalog, plan, 600000).remainingGold, 60)
  const cheaperIntermediate = structuredClone(catalog)
  cheaperIntermediate.items[1].ahPrice = 20
  const result = calculatePlan(cheaperIntermediate, plan, 600000)
  assert.equal(result.remainingGold, 40)
  assert.equal(result.tree.children[0].routeKey, 'ah:2')
  cheaperIntermediate.items[0].ahPrice = 15
  assert.equal(calculatePlan(cheaperIntermediate, plan, 600000).tree.routeKey, 'ah:1')
})
test('Obols are alternative spending valued in gold; obtained Obols reduce remaining', () => {
  const result = calculatePlan(catalog, { ...plan, inventory: { 5300217: 2 } }, 5)
  assert.equal(result.obolSpend, 6)
  assert.equal(result.remainingObols, 4)
  assert.equal(result.remainingGold, 20)
  assert.equal(result.gold, 0)
})
test('forced AH and Obol overrides supersede automatic cost', () => {
  assert.equal(calculatePlan(catalog, { ...plan, overrides: { root: 'ah:1' } }, 5).gold, 1000)
  const override = { 'root/root:1/child:1': 'source:shop' }
  assert.equal(calculatePlan(catalog, { ...plan, overrides: override }, 600000).remainingGold, 3600000)
  const expensive = structuredClone(catalog)
  expensive.items[0].auctionEligible = false
  expensive.items[1].auctionEligible = false
  assert.equal(calculatePlan(expensive, { ...plan, overrides: override }, 600000).remainingGold, 3600000)
})
test('owned intermediates suppress descendants and leaf inventory is not double counted', () => {
  assert.equal(calculatePlan(catalog, { ...plan, inventory: { 2: 1 } }, 600000).remainingGold, 30)
  assert.equal(calculatePlan(catalog, { ...plan, inventory: { 3: 2, 4: 1 } }, 600000).remainingGold, 30)
  const repeated = structuredClone(catalog)
  repeated.recipes[0].ingredients.push({ position: 2, quantity: 1, matchStatus: 'wildcard_category_candidate', candidates: [2] })
  assert.equal(calculatePlan(repeated, { ...plan, inventory: { 3: 3 } }, 600000).gold, 60)
})
test('unknown prices and bundles stay unresolved, recycling never loops', () => {
  const unknown = structuredClone(catalog)
  unknown.items.forEach(i => { i.ahPrice = null })
  unknown.sources[2].quantity = null
  const result = calculatePlan(unknown, plan, 600000)
  assert.ok(result.unresolved.length > 0)
  assert.ok(result.tree.options.some(o => o.equivalent === null))
  unknown.recipes[1].ingredients[0].candidates = [1]
  assert.ok(calculatePlan(unknown, plan, 600000).unresolved.length > 0)
})
test('excluded crafting sources and stale overrides remain explicit', () => {
  const excluded = structuredClone(catalog)
  excluded.sources = excluded.sources.filter(s => s.key !== 'craft:child')
  assert.equal(calculatePlan(excluded, plan, 600000).gold, 200)
  assert.match(calculatePlan(catalog, { ...plan, overrides: { root: 'missing' } }, 600000).unresolved[0], /no longer available/)
})
test('batch excess is reused across siblings but not counted as obtained inventory', () => {
  const batched = structuredClone(catalog)
  batched.recipes[0].ingredients = [
    { position: 1, quantity: 1, matchStatus: 'wildcard_category_candidate', candidates: [2] },
    { position: 2, quantity: 1, matchStatus: 'wildcard_category_candidate', candidates: [2] },
  ]
  batched.recipes[1].output = 2
  const result = calculatePlan(batched, plan, 600000)
  assert.equal(result.gold, 30)
  assert.equal(result.obtainedUnits, 0)
  assert.equal(result.tree.children[1].allocated, 1)
})
