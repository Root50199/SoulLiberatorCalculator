import type { Catalog, TrackingPlan } from './model.ts'
import type { PlanningResult, TreeNode } from './planner.ts'

const OBOL_ID = 5300217
const TARGET_IDS = new Set([5100303, 5100334, 5100304, 5100335])

export function applyHeldObols(catalog: Catalog, plan: TrackingPlan, result: PlanningResult) {
  const inventory = { ...plan.inventory }
  const allocations = new Map<string, { quantity: number; obols: number }>()
  let spent = 0
  if (!plan.autoApplyHeldObols) return { plan, allocations, spent }
  const nodes: TreeNode[] = []
  function visit(node: TreeNode) {
    if (node.remaining > 0 && node.candidateIds.some(id => TARGET_IDS.has(id))) nodes.push(node)
    node.children.forEach(visit)
  }
  visit(result.tree)
  const ahValue = (node: TreeNode) => Math.max(-1, ...catalog.items
    .filter(item => node.candidateIds.includes(item.id)).map(item => item.ahPrice ?? -1))
  nodes.sort((a, b) => ahValue(b) - ahValue(a) || a.path.localeCompare(b.path))
  let held = inventory[OBOL_ID] ?? 0
  for (const node of nodes) {
    const offers = catalog.sources.filter(source => node.candidateIds.includes(source.itemId) &&
      TARGET_IDS.has(source.itemId) && source.kind === 'shop' &&
      source.currency === 'item' && source.currencyItemId === OBOL_ID &&
      (source.origin === 'manual' || source.name === 'Leannan') &&
      source.price !== null && source.price > 0 && source.quantity !== null && source.quantity > 0)
      .flatMap(source => source.price === null || source.quantity === null ? [] :
        [{ ...source, price: source.price, quantity: source.quantity }])
      .sort((a, b) => a.price / a.quantity - b.price / b.quantity || a.key.localeCompare(b.key))
    let remaining = node.remaining
    for (const offer of offers) {
      const purchases = Math.min(Math.floor(held / offer.price), Math.floor(remaining / offer.quantity))
      const quantity = purchases * offer.quantity, obols = purchases * offer.price
      if (!quantity) continue
      inventory[offer.itemId] = (inventory[offer.itemId] ?? 0) + quantity
      if (!Number.isSafeInteger(inventory[offer.itemId]) || !Number.isSafeInteger(obols)) {
        throw new Error('Auto-applied Obols exceed the safe calculation range.')
      }
      held -= obols; spent += obols; remaining -= quantity
      const previous = allocations.get(node.path)
      allocations.set(node.path, { quantity: (previous?.quantity ?? 0) + quantity,
        obols: (previous?.obols ?? 0) + obols })
    }
  }
  inventory[OBOL_ID] = held
  return { plan: { ...plan, inventory }, allocations, spent }
}
