import type { Catalog } from './model.ts'
import { calculatePlan } from './planner.ts'
import type { PlanningResult } from './planner.ts'

export function materialRequirements(result: PlanningResult | null | undefined) {
  const needed = new Map<number, number>()
  function visit(node: PlanningResult['tree']) {
    needed.set(node.itemId, (needed.get(node.itemId) ?? 0) + node.required)
    node.children.forEach(visit)
  }
  if (result) { visit(result.tree); needed.set(5300217, result.obolSpend) }
  return needed
}

export const baseItemName = (name: string) => name.replace(/\s*\(not tradable\)/gi, '')
export function materialAliases(catalog: Catalog, relevantIds: Set<number>) {
  const names = new Map(catalog.items.map(item => [item.id, baseItemName(item.name).replace(/\s*\(event\)/gi, '')]))
  const groups = new Map(catalog.items.filter(item => relevantIds.has(item.id)).map(item => [item.id, [item.id]]))
  for (const ingredient of catalog.recipes.flatMap(recipe => recipe.ingredients)) {
    for (const id of ingredient.candidates) {
      const group = groups.get(id)
      if (!group) continue
      for (const alias of ingredient.candidates) {
        const other = groups.get(alias)
        if (!other || names.get(id) !== names.get(alias) || group === other) continue
        group.push(...other)
        for (const member of other) groups.set(member, group)
      }
    }
  }
  return [...new Set(groups.values())].map(ids => {
    const items = catalog.items.filter(item => ids.includes(item.id))
      .sort((a, b) => Number(b.auctionEligible) - Number(a.auctionEligible) || a.id - b.id)
    return { item: items[0], ids: items.map(item => item.id), name: names.get(items[0].id)! }
  }).sort((a, b) => a.name.localeCompare(b.name))
}
export function sortInventoryMaterials(groups: ReturnType<typeof materialAliases>, result: PlanningResult | null | undefined) {
  const depths = new Map<number, number>()
  function visit(node: PlanningResult['tree'], depth: number) {
    for (const id of node.candidateIds) depths.set(id, Math.min(depths.get(id) ?? Infinity, depth))
    node.children.forEach(child => visit(child, depth + 1))
  }
  if (result) visit(result.tree, 0)
  const ranked = groups.map(group => ({
    group, depth: Math.min(...group.ids.map(id => depths.get(id) ?? Infinity)),
  }))
  return ranked.sort((a, b) =>
    (a.depth === b.depth ? 0 : a.depth < b.depth ? -1 : 1) ||
    (b.group.item.ahPrice ?? -1) - (a.group.item.ahPrice ?? -1) ||
    a.group.name.localeCompare(b.group.name)).map(entry => entry.group)
}
export function aliasInventory(inventory: Record<string, number>, ids: number[], quantity: number) {
  if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error('Owned quantity must be a nonnegative safe integer.')
  const next = { ...inventory }
  let delta = quantity - ids.reduce((sum, id) => sum + (next[id] ?? 0), 0)
  if (delta >= 0) next[ids[0]] = (next[ids[0]] ?? 0) + delta
  else for (const id of [...ids].reverse()) {
    const removed = Math.min(next[id] ?? 0, -delta)
    next[id] = (next[id] ?? 0) - removed
    delta += removed
  }
  return next
}
export const groupDigits = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
export function digitCaret(text: string, position: number) {
  const count = text.slice(0, position).replace(/,/g, '').length
  const grouped = groupDigits(text.replace(/,/g, ''))
  let seen = 0
  for (let i = 0; i < grouped.length; i++) {
    if (grouped[i] !== ',') seen++
    if (seen === count) return i + 1
  }
  return count ? grouped.length : 0
}

export function materialPriceComparison(catalog: Catalog, ids: number[], obolValue: number, assumeMissingPrices = false) {
  const obolOffers = catalog.sources.filter(s => ids.includes(s.itemId) && s.kind === 'shop' &&
    s.currency === 'item' && s.currencyItemId === 5300217 &&
    (s.origin === 'manual' || s.name === 'Leannan') && s.price !== null && s.quantity !== null)
  const obolCosts = obolOffers.flatMap(s => s.price === null || s.quantity === null ? [] : [s.price * obolValue / s.quantity])
  const obolUnits = obolOffers.flatMap(s => s.price === null || s.quantity === null ? [] : [s.price / s.quantity])
  if (obolCosts.some(cost => !Number.isFinite(cost) || cost > Number.MAX_SAFE_INTEGER)) {
    throw new Error('Obol equivalent exceeds the safe calculation range.')
  }
  const crafts = ids.flatMap(id => calculatePlan(catalog, {
    id: 'price-preview', itemId: id, label: 'Price preview', quantity: 1, inventory: {}, overrides: {},
  }, obolValue, false, assumeMissingPrices).tree.options.filter(o => o.key.startsWith('recipe:')))
  const priced = crafts.flatMap(o => o.equivalent === null ? [] : [o.equivalent])
  return {
    npcPrices: catalog.sources.filter(s => ids.includes(s.itemId) && s.kind === 'shop' &&
      ['gold', 'ducats'].includes(s.currency ?? '') && s.price !== null && s.quantity !== null)
      .flatMap(s => s.price === null || s.quantity === null || s.currency === null ? [] :
        [{ key: s.key, name: s.name, price: s.price / s.quantity,
          currency: s.currency, verified: s.origin === 'manual' || s.name === 'Leannan' }]),
    obolGold: obolCosts.length ? Math.min(...obolCosts) : null,
    obolsPerItem: obolUnits.length ? Math.min(...obolUnits) : null,
    craftGold: priced.length ? Math.min(...priced) : null,
    craftMissingPrices: [...new Set(crafts.filter(option => option.equivalent === (priced.length ? Math.min(...priced) : null))
      .flatMap(option => option.missingPrices))],
    craftOutputs: [...new Set(crafts.flatMap(option => {
      const recipe = catalog.recipes.find(recipe => option.key === `recipe:${recipe.key}`)
      return recipe ? [recipe.output] : []
    }))].sort((a, b) => a - b),
    hasCraft: crafts.length > 0,
  }
}
