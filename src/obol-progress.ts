import type { Catalog, TrackingPlan } from './model.ts'
import { calculatePlan } from './planner.ts'

export function obolProgress(catalog: Catalog, plan: TrackingPlan) {
  const obolItems = new Set(catalog.sources.filter(source => source.kind === 'shop' &&
    source.currency === 'item' && source.currencyItemId === 5300217 &&
    source.price !== null && source.quantity !== null &&
    (source.origin === 'manual' || source.name === 'Leannan')).map(source => source.itemId))
  const craftItems = new Set(catalog.recipes.map(recipe => recipe.productId))
  const accounting: Catalog = {
    ...catalog,
    items: catalog.items.map(item => ({ ...item, auctionEligible: false })),
    recipes: catalog.recipes.filter(recipe => recipe.productId === plan.itemId || !obolItems.has(recipe.productId)),
    sources: catalog.sources.filter(source => source.kind !== 'shop' ||
      (source.itemId !== plan.itemId && (obolItems.has(source.itemId)
        ? source.currency === 'item' && source.currencyItemId === 5300217
        : !craftItems.has(source.itemId)))),
  }

  const inventory = { ...plan.inventory }
  delete inventory[5300217]
  const total = calculatePlan(accounting, { ...plan, inventory: {}, overrides: {} }, 1, true).obolSpend
  const remaining = Math.min(total, calculatePlan(accounting, { ...plan, inventory, overrides: {} }, 1, true).obolSpend)
  return { spent: Math.max(0, total - remaining), remaining, total }
}

export function goldProgress(catalog: Catalog, plan: TrackingPlan, obolValue: number, assumeMissingPrices = false) {
  const inventory = { ...plan.inventory }
  delete inventory[5300217]
  const baseline = calculatePlan(catalog, { ...plan, inventory: {} }, obolValue, true, assumeMissingPrices)
  const current = calculatePlan(catalog, { ...plan, inventory }, obolValue, true, assumeMissingPrices)
  if (baseline.unresolved.length || current.unresolved.length) return null
  const total = baseline.remainingGold
  const remaining = Math.min(total, current.remainingGold)
  const obtained = total - remaining
  return { total, obtained, remaining, percent: total ? Math.round(100 * obtained / total) : assumeMissingPrices ? 0 : null,
    missingPrices: [...new Set([...baseline.tree.missingPrices, ...current.tree.missingPrices])] }
}
