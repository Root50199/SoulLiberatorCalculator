import test from 'node:test'
import assert from 'node:assert/strict'
import type { Catalog, TrackingPlan } from '../src/model.ts'
import { calculatePlan } from '../src/planner.ts'
import { applyHeldObols } from '../src/held-obols.ts'
import { goldProgress, obolProgress } from '../src/obol-progress.ts'

const ids = [5100303, 5100304]
const catalog: Catalog = {
  devMode: false, slIds: [1], memberships: [], notes: [],
  items: [1, ...ids].map(id => ({ id, name: String(id), nameStatus: 'resolved',
    auctionEligible: true, ahPrice: id === ids[0] ? 1000 : 2000 })),
  recipes: [{ key: 'root', productId: 1, section: 'MagicCraft', output: 1,
    ingredients: ids.map((id, index) => ({ position: index + 1, quantity: 2,
      candidates: [id], matchStatus: 'wildcard_category_candidate' })) }],
  sources: [
    { key: 'craft:root', itemId: 1, kind: 'craft', name: 'MagicCraft', currency: null,
      currencyItemId: null, price: null, quantity: 1, origin: 'auto', evidence: '', availability: '', details: '{}' },
    ...ids.map(id => ({ key: `shop:${id}`, itemId: id, kind: 'shop', name: 'Leannan',
      currency: 'item', currencyItemId: 5300217, price: 100, quantity: 1,
      origin: 'auto', evidence: '', availability: '', details: '{}' })),
  ],
}
const plan: TrackingPlan = { id: 'test', itemId: 1, quantity: 1, label: 'Test',
  autoApplyHeldObols: true, inventory: { 5300217: 350 }, overrides: {
    'root/root:1': `ah:${ids[0]}`, 'root/root:2': `ah:${ids[1]}`,
  } }
const apply = (input = plan, data = catalog) =>
  applyHeldObols(data, input, calculatePlan(data, input, 10, true))

test('held Obols prioritize higher AH value, cap demand, respect whole purchases and do not mutate saved stock', () => {
  const applied = apply()
  assert.equal(applied.spent, 300)
  assert.equal(applied.plan.inventory[ids[1]], 2)
  assert.equal(applied.plan.inventory[ids[0]], 1)
  assert.equal(applied.plan.inventory[5300217], 50)
  assert.deepEqual(plan.inventory, { 5300217: 350 })
  assert.deepEqual(applied.allocations.get('root/root:2'), { quantity: 2, obols: 200 })
  const result = calculatePlan(catalog, applied.plan, 10, true)
  assert.equal(result.tree.children[1].obtained, 2)
  assert.equal(result.tree.children[1].remaining, 0)
  assert.equal(goldProgress(catalog, applied.plan, 10)?.obtained, 5000)
  assert.deepEqual(obolProgress(catalog, applied.plan), { spent: 300, remaining: 100, total: 400 })
})

test('disabled preview, depleted held balance and fully owned materials receive no allocations', () => {
  assert.equal(apply({ ...plan, autoApplyHeldObols: false }).spent, 0)
  assert.equal(apply({ ...plan, inventory: { 5300217: 99 } }).spent, 0)
  const applied = apply({ ...plan, inventory: { 5300217: 1000, [ids[0]]: 9, [ids[1]]: 9 } })
  assert.equal(applied.spent, 0)
  assert.equal(applied.plan.inventory[5300217], 1000)
})

test('confirmed non-tradable aliases receive leftover Obols and allocations move when actual stock completes a branch', () => {
  const aliases = [5100334, 5100335]
  const data: Catalog = { ...catalog,
    items: [...catalog.items, ...aliases.map(id => ({ id, name: String(id), nameStatus: 'resolved',
      auctionEligible: false, ahPrice: null }))],
    recipes: catalog.recipes.map(recipe => ({ ...recipe, ingredients: recipe.ingredients.map((ingredient, index) =>
      ({ ...ingredient, candidates: [...ingredient.candidates, aliases[index]] })) })),
    sources: catalog.sources.map(source => source.kind === 'shop'
      ? { ...source, itemId: aliases[ids.indexOf(source.itemId)] } : source),
  }
  const abundant = apply({ ...plan, inventory: { 5300217: 9999 } }, data)
  assert.equal(abundant.plan.inventory[5100335], 2)
  assert.equal(abundant.plan.inventory[5100334], 2)
  assert.equal(abundant.spent, 400)
  const initial = apply({ ...plan, inventory: { 5300217: 200 } }, data)
  assert.equal(initial.plan.inventory[5100335], 2)
  assert.equal(initial.allocations.has('root/root:1'), false)
  const completedEssence = { ...plan, inventory: { 5300217: 200, 5100304: 2 } }
  const moved = apply(completedEssence, data)
  assert.equal(moved.plan.inventory[5100334], 2)
  assert.deepEqual(moved.allocations.get('root/root:1'), { quantity: 2, obols: 200 })
  assert.equal(moved.allocations.has('root/root:2'), false)
  assert.deepEqual(completedEssence.inventory, { 5300217: 200, 5100304: 2 })
})

test('unknown AH values follow known values; unverified shops and oversized bundles are not assumed usable', () => {
  const unknown = { ...catalog, items: catalog.items.map(item => ({ ...item,
    ahPrice: item.id === ids[1] ? null : item.ahPrice })) }
  assert.equal(apply({ ...plan, inventory: { 5300217: 100 } }, unknown).plan.inventory[ids[0]], 1)
  const inaccessible = { ...catalog, sources: catalog.sources.map(source =>
    source.kind === 'shop' ? { ...source, name: 'Unverified shop' } : source) }
  assert.equal(apply(plan, inaccessible).spent, 0)
  const bundles = { ...catalog, sources: catalog.sources.map(source =>
    source.kind === 'shop' ? { ...source, quantity: 3 } : source) }
  assert.equal(apply(plan, bundles).spent, 0)
})
