import type { Catalog, TrackingPlan } from './model.ts'

export interface RouteOption {
  missingPrices: string[]
  key: string
  label: string
  equivalent: number | null
  reason: string | null
}
export interface TreeNode {
  missingPrices: string[]
  path: string
  candidateIds: number[]
  itemId: number
  required: number
  obtained: number
  allocated: number
  remaining: number
  route: string
  routeKey: string | null
  options: RouteOption[]
  children: TreeNode[]
  gold: number
  obols: number
  unresolved: string[]
}
interface Evaluation {
  node: TreeNode
  inventory: Record<string, number>
}
export interface PlanningResult {
  tree: TreeNode
  gold: number
  obolSpend: number
  remainingObols: number
  remainingGold: number
  obtainedUnits: number
  requiredUnits: number
  unresolved: string[]
}

const OBOL_ID = 5300217

export function calculatePlan(catalog: Catalog, plan: TrackingPlan, obolValue: number, craftRoot = false, assumeMissingPrices = false): PlanningResult {
  if (plan.itemId === null) throw new Error('Select equipment in this tab before calculating.')
  if (!Number.isSafeInteger(obolValue) || obolValue < 0 ||
      !Number.isSafeInteger(plan.quantity) || plan.quantity < 1) {
    throw new Error('Target quantity and Obol value must be valid whole numbers.')
  }
  const items = new Map(catalog.items.map(item => [item.id, item]))
  const recipes = new Map<number, typeof catalog.recipes>()
  for (const recipe of catalog.recipes) {
    const group = recipes.get(recipe.productId) ?? []
    group.push(recipe)
    recipes.set(recipe.productId, group)
  }
  const name = (id: number) => items.get(id)?.name ?? `Item ${id}`
  let evaluations = 0

  function evaluate(ids: number[], quantity: number, path: string,
    available: Record<string, number>, ancestors: Set<number>): Evaluation {
    evaluations++
    if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error('Material quantity exceeds the safe calculation range.')
    if (evaluations > 50000) {
      throw new Error('Recipe graph is too complex for this plan. Force a smaller route or exclude recycling sources.')
    }
    const inventory = { ...available }
    const craftingRoot = craftRoot && path === 'root'
    if (craftingRoot) for (const id of ids) { delete inventory[id]; delete inventory[`planned:${id}`] }
    let remaining = quantity
    let obtained = 0
    let allocated = 0
    let selectedId = ids[0]
    for (const id of ids) {
      const used = Math.min(remaining, inventory[id] ?? 0)
      if (used > 0) selectedId = id
      inventory[id] = (inventory[id] ?? 0) - used
      obtained += used
      remaining -= used
    }
    for (const id of ids) {
      const key = `planned:${id}`
      const used = Math.min(remaining, inventory[key] ?? 0)
      inventory[key] = (inventory[key] ?? 0) - used
      allocated += used
      remaining -= used
      if (used > 0) selectedId = id
    }
    const base: TreeNode = {
      path, candidateIds: ids, itemId: selectedId, required: quantity, obtained, allocated, remaining,
      route: remaining ? 'Unresolved' : allocated ? 'Allocated from an earlier planned batch' : 'Obtained', routeKey: null, options: [],
      children: [], gold: 0, obols: 0, unresolved: [], missingPrices: [],
    }
    if (!remaining) return { node: base, inventory }
    const choices: { option: RouteOption; result: Evaluation }[] = []
    const childOverrides = !craftingRoot && plan.overrides[path] ? [] :
      Object.keys(plan.overrides).filter(key => key.startsWith(`${path}/`))
    function offer(key: string, label: string, id: number, gold: number, obols: number,
      children: TreeNode[], stock: Record<string, number>, unresolved: string[], missingPrices: string[] = []) {
      missingPrices = [...new Set([...missingPrices, ...children.flatMap(child => child.missingPrices)])]
      if (!Number.isSafeInteger(gold + obols * obolValue)) throw new Error('Cost exceeds the safe calculation range.')
      if (childOverrides.some(override => !children.some(c =>
        override === c.path || override.startsWith(`${c.path}/`)))) {
        unresolved = [...unresolved, 'A descendant override requires its crafting path. Reset that override to choose another route.']
      }
      const option: RouteOption = {
        key, label, equivalent: unresolved.length ? null : gold + obols * obolValue, missingPrices,
        reason: unresolved.length ? unresolved[0] : null,
      }
      choices.push({ option, result: { inventory: stock, node: {
        ...base, itemId: id, route: label, routeKey: key, gold, obols, children, unresolved, missingPrices,
      } } })
    }
    for (const id of ids) {
      const item = items.get(id)
      if (!item) throw new Error(`Missing material definition ${id}`)
      if (item.auctionEligible && !craftingRoot) {
        const reason = item.ahPrice === null ? [`Enter AH gold price for ${item.name}.`] : []
        offer(`ah:${id}`, `Auction house: ${item.name}`, id,
          (item.ahPrice ?? 0) * remaining, 0, [], { ...inventory }, assumeMissingPrices ? [] : reason,
          assumeMissingPrices ? reason : [])
      }
      for (const source of catalog.sources.filter(s => !craftingRoot && s.itemId === id && s.kind === 'shop')) {
        const reasons = []
        const missingPrice = source.price === null ? [`Enter price for ${item.name} at ${source.name}.`] : []
        if (!assumeMissingPrices) reasons.push(...missingPrice)
        if (source.quantity === null) reasons.push(`Unknown purchase quantity: ${source.name} / ${item.name}.`)
        const isObol = source.currency === 'item' && source.currencyItemId === OBOL_ID
        if (source.currency !== 'gold' && !isObol) reasons.push(`Unsupported currency: ${source.name}.`)
        if (source.origin === 'auto' && source.name !== 'Leannan') {
          reasons.push(`Shop access/limits need verification: ${source.name}. Add a confirmed manual offer.`)
        }
        const price = Math.ceil(remaining / (source.quantity ?? 1)) * (source.price ?? 0)
        const stock = { ...inventory }
        if (source.quantity !== null) {
          stock[`planned:${id}`] = (stock[`planned:${id}`] ?? 0) +
            Math.ceil(remaining / source.quantity) * source.quantity - remaining
        }
        offer(`source:${source.key}`, `${source.name}: ${item.name} (${isObol ? 'Obols' : source.currency ?? 'unknown'})`,
          id, isObol ? 0 : price, isObol ? price : 0, [], stock, reasons,
          assumeMissingPrices ? missingPrice : [])
      }
      for (const recipe of recipes.get(id) ?? []) {
        const source = catalog.sources.find(s => s.kind === 'craft' && s.itemId === id &&
          s.key === `craft:${recipe.key}`)
        if (!source) continue
        const reasons: string[] = []
        if (ancestors.has(id)) reasons.push(`Recycling cycle excluded: ${item.name}.`)
        if (recipe.section === 'MetalExtraction' ||
          recipe.ingredients.some(i => i.matchStatus !== 'wildcard_category_candidate')) {
          reasons.push(`Unverified category/recycling recipe excluded: ${recipe.section}.`)
        }
        if (recipe.ingredients.length === 0) reasons.push(`Recipe has no verified ingredients: ${item.name}.`)
        let stock = { ...inventory }
        const children: TreeNode[] = []
        if (!reasons.length) {
          const nextAncestors = new Set(ancestors).add(id)
          const batches = Math.ceil(remaining / recipe.output)
          for (const ingredient of recipe.ingredients) {
            if (!ingredient.candidates.length) throw new Error(`No candidates in ${recipe.key}`)
            const child = evaluate(ingredient.candidates, batches * ingredient.quantity,
              `${path}/${recipe.key}:${ingredient.position}`, stock, nextAncestors)
            stock = child.inventory
            children.push(child.node)
            reasons.push(...child.node.unresolved)
          }
          stock[`planned:${id}`] = (stock[`planned:${id}`] ?? 0) + batches * recipe.output - remaining
        }
        const skill = { MagicCraft: 'Magic Craft', HeulwenEngineering: 'Hillwen Engineering',
          Spinning: 'Weaving', Refine: 'Refining' }[recipe.section] ?? recipe.section
        const variants = (recipes.get(id) ?? []).filter(r => r.section === recipe.section)
        const variant = variants.length > 1 ? ` (recipe ${variants.indexOf(recipe) + 1}, creates ${recipe.output})` : ''
        offer(`recipe:${recipe.key}`, `Craft: ${skill}${variant}`,
          id, children.reduce((n, c) => n + c.gold, 0),
          children.reduce((n, c) => n + c.obols, 0), children, stock, reasons)
      }
    }
    const override = craftingRoot ? undefined : plan.overrides[path]
    let selected = override ? choices.find(c => c.option.key === override) : undefined
    if (override && !selected) {
      return { inventory, node: { ...base, unresolved: [`Override is no longer available for ${name(selectedId)}. Reset to Auto.`] } }
    }
    if (!selected) {
      selected = choices.filter(c => c.option.equivalent !== null)
        .sort((a, b) => (a.option.equivalent ?? Infinity) - (b.option.equivalent ?? Infinity))[0]
    }
    if (!selected) {
      selected = choices.filter(c => c.result.node.children.length > 0)
        .sort((a, b) => a.result.node.unresolved.length - b.result.node.unresolved.length)[0] ?? choices[0]
    }
    if (!selected) return { inventory, node: {
      ...base, unresolved: [`No priced purchase or usable craft for ${name(selectedId)}. Enter a price or source.`],
    } }
    selected.result.node.options = choices.map(c => c.option)
    return selected.result
  }

  const { node: tree } = evaluate([plan.itemId], plan.quantity, 'root', { ...plan.inventory }, new Set())
  const remainingObols = Math.max(0, tree.obols - (plan.inventory[OBOL_ID] ?? 0))
  let obtainedUnits = 0
  let requiredUnits = 0
  function count(node: TreeNode) {
    obtainedUnits += node.obtained
    requiredUnits += node.obtained + (node.children.length ? 0 : node.remaining + node.allocated)
    node.children.forEach(count)
  }
  count(tree)
  return {
    tree, gold: tree.gold, obolSpend: tree.obols, remainingObols,
    remainingGold: tree.gold + remainingObols * obolValue,
    obtainedUnits, requiredUnits, unresolved: [...new Set(tree.unresolved)],
  }
}
