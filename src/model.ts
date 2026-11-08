export interface Item {
  id: number
  name: string
  nameStatus: string
  ahPrice: number | null
  auctionEligible: boolean
}
export interface Ingredient {
  position: number
  quantity: number
  matchStatus: string
  candidates: number[]
}
export interface Recipe {
  key: string
  productId: number
  section: string
  output: number
  ingredients: Ingredient[]
}
export interface Source {
  key: string
  itemId: number
  kind: string
  name: string
  currency: string | null
  currencyItemId: number | null
  price: number | null
  quantity: number | null
  origin: string
  evidence: string
  availability: string
  details: string
}
export interface ItemNote {
  itemId: number
  title: string
  message: string
  status: string
}
export interface Catalog {
  items: Item[]
  slIds: number[]
  recipes: Recipe[]
  sources: Source[]
  notes: ItemNote[]
  memberships: { slId: number; itemId: number }[]
  devMode: boolean
}
export interface TrackingPlan {
  autoApplyHeldObols?: boolean
  id: string
  itemId: number | null
  label: string
  quantity: number
  inventory: Record<string, number>
  overrides: Record<string, string>
}
export interface WorkspaceState {
  inventory: Record<string, number>
  activeMaterialsOnly: boolean
  obolValue: number
  activeId: string | null
  plans: TrackingPlan[]
}
export interface ManualSourceInput {
  manualId: number | null
  itemId: number
  kind: 'shop' | 'reward' | 'craft' | 'mob_drop' | 'other'
  name: string
  currency: string | null
  currencyItemId: number | null
  price: number | null
  quantity: number | null
  notes: string
}
export interface HistoryStatus {
  canUndo: boolean
  canRedo: boolean
  undoKey: string
  redoKey: string
}
