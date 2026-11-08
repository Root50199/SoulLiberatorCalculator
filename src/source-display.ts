import type { Catalog, Source } from './model'
import { isVerifiedConversion } from './planner.ts'

export function inventorySourceTooltip(catalog: Catalog, ids: number[]): string {
  const entries = catalog.sources.filter(source => ids.includes(source.itemId)).flatMap(source => {
    const labels = sourceLabels(source)
    if (!labels.length) return []
    const price = source.kind === 'shop' && source.price !== null
      ? ` - ${source.price.toLocaleString('en-US')} ${source.currency === 'item'
        ? catalog.items.find(item => item.id === source.currencyItemId)?.name ?? `Item ${source.currencyItemId}`
        : source.currency ?? 'unknown currency'}${source.quantity === null
          ? ' (purchase quantity unknown)' : ` for ${source.quantity.toLocaleString('en-US')}`}`
      : ''
    const details = sourceTooltip(catalog, [source])
    return [`${labels.join('\n')}${price}${details ? `\n${details}` : ''}`]
  })
  const notes = catalog.notes.filter(note => ids.includes(note.itemId))
    .map(note => `${note.title}: ${note.message}`)
  return [...new Set([...entries, ...notes])].join('\n\n') || 'No source information recorded for this item.'
}

export function craftRecipeLabel(catalog: Catalog, key: string) {
  const recipe = catalog.recipes.find(recipe => recipe.key === key)
  const recipes = catalog.recipes.filter(candidate => candidate.productId === recipe?.productId)
  return recipes.length > 1 ? `Craft recipe ${recipes.findIndex(candidate => candidate.key === key) + 1}` : 'Craft'
}

export function sourceTooltip(catalog: Catalog, sources: Source[]): string {
  const lines = sources.flatMap(source => {
    const data: unknown = JSON.parse(source.details)
    const notes = data && typeof data === 'object' && 'notes' in data && typeof data.notes === 'string'
      ? [data.notes.trim()].filter(Boolean) : []
    if (source.kind !== 'craft') return notes
    const recipes = catalog.recipes.filter(recipe => source.origin === 'auto'
      ? source.key === `craft:${recipe.key}` : recipe.productId === source.itemId)
    return [...notes, ...recipes.map(recipe => {
      const name = (id: number) => catalog.items.find(item => item.id === id)?.name ?? `Unknown item ${id}`
      return `${craftRecipeLabel(catalog, recipe.key)}\n${recipe.output} ${name(recipe.productId)}\n${recipe.ingredients.map(ingredient =>
        `${ingredient.quantity} x ${[...new Set((isVerifiedConversion(recipe) ? [64036] : ingredient.candidates).map(name))].join(' / ')}`).join('\n')}${
          isVerifiedConversion(recipe) ? '\nBatch confirmed by in-game Rank 1 screenshot; other ranks/success modifiers are not modeled.' : ''}`
    }), ...(recipes.length || source.origin === 'manual' ? [] : ['Recipe not recorded for this crafting source.'])]
  })
  return [...new Set(lines)].join('\n\n')
}

export function sourceLabels(source: Source): string[] {
  const data: unknown = JSON.parse(source.details)
  if (source.kind === 'reward' && data && typeof data === 'object' &&
    'contents' in data && Array.isArray(data.contents)) {
    return [...new Set(data.contents.flatMap((entry: unknown) => {
      if (!entry || typeof entry !== 'object' || !('localized_name' in entry) ||
        typeof entry.localized_name !== 'string' || !entry.localized_name.trim()) return []
      const difficulty = 'localized_difficulty' in entry && typeof entry.localized_difficulty === 'string'
        ? entry.localized_difficulty.trim() : ''
      return difficulty ? [`${entry.localized_name.trim()}: ${difficulty}`] : []
    }))]
  }
  const skills: Record<string, string> = {
    HeulwenEngineering: 'Hillwen Engineering', MagicCraft: 'Magic Craft',
    MetalExtraction: 'Metal Conversion', Spinning: 'Weaving', Refine: 'Refining',
  }
  return [source.kind === 'craft' ? `Craft: ${skills[source.name] ?? source.name}` :
    source.kind === 'mob_drop' ? `Mob drop: ${source.name}` : source.name]
}
