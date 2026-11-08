import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { statSync } from 'node:fs'
import { constants } from 'node:fs'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const databasePath = fileURLToPath(new URL('../data/soul-liberator.sqlite', import.meta.url))
const initialState = { obolValue: 600000, activeId: null, plans: [] }

export async function prepareUserDatabase(directory) {
  await mkdir(directory, { recursive: true })
  const filename = path.join(directory, 'soul-liberator.sqlite')
  try {
    const existing = await stat(filename)
    if (!existing.isFile()) throw new Error('Save database must be a regular file.')
    return filename
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  try {
    await copyFile(databasePath, filename, constants.COPYFILE_EXCL)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
  }
  return filename
}

function withDefaultTab(state) {
  if (state.inventory === undefined) {
    const inventory = {}
    for (const plan of state.plans) for (const [id, quantity] of Object.entries(plan.inventory)) {
      inventory[id] = Math.max(inventory[id] ?? 0, quantity)
    }
    state = { ...state, inventory, activeMaterialsOnly: true,
      plans: state.plans.map(plan => ({ ...plan, inventory: {} })) }
  }
  if (state.plans.length) return state.plans.every(plan => plan.quantity === 1) ? state :
    { ...state, plans: state.plans.map(plan => ({ ...plan, quantity: 1 })) }
  const id = randomUUID()
  return { ...state, activeId: id, plans: [
    { id, itemId: null, label: 'New tracker', quantity: 1, inventory: {}, overrides: {} },
  ] }
}

function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be a whole number >= ${minimum}.`)
  return value
}
function text(value, name, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(`${name} must be text${allowEmpty ? '' : ' and cannot be empty'}.`)
  return value
}
function nullableInteger(value, name, minimum = 0) {
  return value === null ? null : integer(value, name, minimum)
}
function historyData(snapshot) {
  return { ...snapshot, workspace: snapshot.workspace.map(row => {
    const state = JSON.parse(row.state_json)
    delete state.activeId
    delete state.activeMaterialsOnly
    state.plans = state.plans.map(plan => {
      const data = { ...plan }
      delete data.autoApplyHeldObols
      return data
    })
    return { ...row, state_json: JSON.stringify(state) }
  }) }
}
export class PlannerStore {
  constructor(filename = databasePath, devMode = false) {
    this.devMode = devMode
    if (!statSync(filename).isFile()) throw new Error('Expected an existing material database file.')
    this.db = new DatabaseSync(filename, { open: true })
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
      if (Number(this.db.prepare('PRAGMA user_version').get().user_version) !== 4) {
        throw new Error('Material database schema must be v4. Run npm run data:build first.')
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS planner_workspace (
        id INTEGER PRIMARY KEY CHECK(id=1), state_json TEXT NOT NULL CHECK(json_valid(state_json))
      )`)
      this.db.exec(`CREATE TABLE IF NOT EXISTS planner_preferences (
        id INTEGER PRIMARY KEY CHECK(id=1), undo_key TEXT NOT NULL, redo_key TEXT NOT NULL
      )`)
      this.db.exec(`CREATE TABLE IF NOT EXISTS planner_window (
        id INTEGER PRIMARY KEY CHECK(id=1), width INTEGER NOT NULL CHECK(width>=700),
        height INTEGER NOT NULL CHECK(height>=540)
      )`)
      this.undoStack = []
      this.redoStack = []
      for (const method of ['saveState', 'setPrice', 'saveSource', 'removeSource', 'restoreSource']) {
        const original = this[method].bind(this)
        this[method] = (...args) => {
          this.readState()
          const before = this.snapshot()
          original(...args)
          const after = this.snapshot()
          if (JSON.stringify(historyData(before)) !== JSON.stringify(historyData(after))) {
            this.undoStack.push({ before, after })
            this.redoStack = []
          }
        }
      }
    } catch (error) {
      this.db.close()
      throw error
    }
  }
  close() { this.db.close() }
  windowSize() {
    const size = this.db.prepare('SELECT width,height FROM planner_window WHERE id=1').get()
    if (!size) return { width: 1440, height: 940 }
    integer(size.width, 'Window width', 700)
    integer(size.height, 'Window height', 540)
    return { width: size.width, height: size.height }
  }
  saveWindowSize({ width, height }) {
    integer(width, 'Window width', 700)
    integer(height, 'Window height', 540)
    this.db.prepare(`INSERT INTO planner_window VALUES(1,?,?)
      ON CONFLICT(id) DO UPDATE SET width=excluded.width,height=excluded.height`).run(width, height)
  }
  item(id) {
    integer(id, 'Item ID', 1)
    const row = this.db.prepare('SELECT name FROM items WHERE item_id=?').get(id)
    if (!row) throw new Error(`Unknown item ID ${id}.`)
    return row
  }
  requireDev() {
    if (!this.devMode) throw new Error('Source and note editing is available only in desktop development mode.')
  }
  catalog() {
    const definitions = this.db.prepare('SELECT item_id,auction_search_locales FROM item_definitions').all()
    const items = this.db.prepare(`SELECT i.item_id AS id,i.name,i.name_status AS nameStatus,
      p.gold_per_unit AS ahPrice FROM items i JOIN auction_house_prices p USING(item_id)
      WHERE catalog_current=1`).all().map(item => ({
      ...item,
      auctionEligible: !/\(Not tradable\)|\(Event\)/i.test(item.name) &&
        definitions.some(d => d.item_id === item.id && (d.auction_search_locales ?? '').split(';').includes('usa')),
    }))
    const ingredients = this.db.prepare(`SELECT recipe_key,position,quantity,match_status AS matchStatus
      FROM recipe_ingredients ORDER BY position`).all()
    const candidates = this.db.prepare('SELECT recipe_key,position,item_id FROM ingredient_candidates ORDER BY item_id').all()
    const recipes = this.db.prepare(`SELECT recipe_key AS key,product_item_id AS productId,
      section,output_quantity AS output FROM recipes`).all().map(r => ({
      ...r, ingredients: ingredients.filter(i => i.recipe_key === r.key).map(i => ({
        position: i.position, quantity: i.quantity, matchStatus: i.matchStatus,
        candidates: candidates.filter(c => c.recipe_key === r.key && c.position === i.position).map(c => c.item_id),
      })),
    }))
    const sources = this.db.prepare(`SELECT source_key AS key,item_id AS itemId,kind,source_name AS name,
      currency,currency_item_id AS currencyItemId,price,purchase_quantity AS quantity,origin,evidence,
      availability,details_json AS details FROM effective_sources`).all()
    for (const source of sources) JSON.parse(source.details)
    return {
      items, recipes, devMode: this.devMode,
      slIds: this.db.prepare('SELECT item_id FROM sl_items').all().map(r => r.item_id),
      memberships: this.db.prepare('SELECT sl_item_id AS slId,material_item_id AS itemId FROM sl_materials').all(),
      sources,
      notes: this.db.prepare('SELECT item_id AS itemId,title,message,status FROM item_notes WHERE enabled=1').all(),
    }
  }
  readState() {
    const row = this.db.prepare('SELECT state_json FROM planner_workspace WHERE id=1').get()
    const state = row ? JSON.parse(row.state_json) : structuredClone(initialState)
    this.validateState(state)
    const normalized = withDefaultTab(state)
    if (normalized !== state) {
      this.db.prepare('INSERT INTO planner_workspace VALUES(1,?) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json')
        .run(JSON.stringify(normalized))
    }
    return normalized
  }
  validateState(state) {
    if (!state || typeof state !== 'object') throw new Error('Invalid planner workspace.')
    integer(state.obolValue, 'Gold per Obol')
    if (state.inventory !== undefined) {
      if (!state.inventory || typeof state.inventory !== 'object' || Array.isArray(state.inventory)) throw new Error('Invalid global inventory.')
      if (typeof state.activeMaterialsOnly !== 'boolean') throw new Error('Invalid material filter.')
      for (const [id, quantity] of Object.entries(state.inventory)) {
        if (!/^\d+$/.test(id)) throw new Error('Invalid inventory item ID.')
        this.item(Number(id)); integer(quantity, 'Obtained quantity')
      }
      if (state.plans?.some(plan => Object.keys(plan.inventory ?? {}).length)) throw new Error('Use global inventory, not tab inventory.')
    }
    if (!Array.isArray(state.plans)) throw new Error('Plans must be a list.')
    const ids = new Set()
    for (const plan of state.plans) {
      text(plan.id, 'Plan ID')
      if (ids.has(plan.id)) throw new Error('Duplicate plan ID.')
      ids.add(plan.id)
      if (plan.itemId !== null && !this.db.prepare('SELECT 1 FROM sl_items WHERE item_id=?').get(integer(plan.itemId, 'SL item ID', 1))) {
        throw new Error('Plan item must be a Soul Liberator item.')
      }
      text(plan.label, 'Tab name')
      if (plan.autoApplyHeldObols !== undefined && typeof plan.autoApplyHeldObols !== 'boolean') {
        throw new Error('Invalid auto-apply held Obols toggle.')
      }
      integer(plan.quantity, 'Target quantity', 1)
      for (const field of ['inventory', 'overrides']) {
        if (!plan[field] || typeof plan[field] !== 'object' || Array.isArray(plan[field])) throw new Error(`Invalid ${field}.`)
      }
      for (const [id, quantity] of Object.entries(plan.inventory)) {
        if (!/^\d+$/.test(id)) throw new Error('Invalid inventory item ID.')
        this.item(Number(id))
        integer(quantity, 'Obtained quantity')
      }
      for (const [path, choice] of Object.entries(plan.overrides)) {
        text(path, 'Override path')
        text(choice, 'Override route')
      }
    }
    if (state.activeId !== null && !ids.has(state.activeId)) throw new Error('Active tab does not exist.')
  }
  saveState(state) {
    this.validateState(state)
    this.db.prepare('INSERT INTO planner_workspace VALUES(1,?) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json')
      .run(JSON.stringify(withDefaultTab(state)))
  }
  setPrice(id, price) {
    this.item(id)
    nullableInteger(price, 'AH gold price')
    this.db.prepare(`UPDATE auction_house_prices SET gold_per_unit=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE item_id=?`).run(price, id)
  }
  saveSource(input, replaceKey = null) {
    this.requireDev()
    if (!input || typeof input !== 'object') throw new Error('Invalid source.')
    this.item(input.itemId)
    if (!['shop', 'reward', 'craft', 'mob_drop', 'other'].includes(input.kind)) throw new Error('Invalid source kind.')
    if (input.kind === 'mob_drop' &&
      (input.currency !== null || input.currencyItemId !== null || input.price !== null)) {
      throw new Error('Mob drops are descriptive sources, not purchases.')
    }
    text(input.name, 'Source name')
    text(input.notes, 'Source notes', true)
    nullableInteger(input.price, 'Source price')
    nullableInteger(input.quantity, 'Purchase quantity', 1)
    if (input.currency !== null) text(input.currency, 'Currency')
    if (input.currencyItemId !== null) this.item(input.currencyItemId)
    if (replaceKey !== null) {
      text(replaceKey, 'Replacement source')
      const original = this.db.prepare('SELECT item_id FROM effective_sources WHERE source_key=? AND origin=?').get(replaceKey, 'auto')
      if (!original || original.item_id !== input.itemId || input.manualId !== null) {
        throw new Error('Replacement must target an existing auto source for the same item.')
      }
    }
    const values = [input.itemId, input.kind, input.name, input.currency, input.currencyItemId,
      input.price, input.quantity, input.notes]
    this.db.exec('BEGIN IMMEDIATE')
    try {
    if (input.manualId === null) {
      this.db.prepare(`INSERT INTO manual_sources(item_id,kind,source_name,currency,currency_item_id,
        price,purchase_quantity,notes) VALUES(?,?,?,?,?,?,?,?)`).run(...values)
    } else {
      integer(input.manualId, 'Manual source ID', 1)
      const result = this.db.prepare(`UPDATE manual_sources SET item_id=?,kind=?,source_name=?,currency=?,
        currency_item_id=?,price=?,purchase_quantity=?,notes=? WHERE manual_id=?`).run(...values, input.manualId)
      if (!result.changes) throw new Error('Manual source no longer exists.')
    }
      if (replaceKey !== null) this.db.prepare('DELETE FROM effective_sources WHERE source_key=?').run(replaceKey)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  removeSource(key) {
    this.requireDev()
    text(key, 'Source key')
    if (!this.db.prepare('SELECT 1 FROM effective_sources WHERE source_key=?').get(key)) throw new Error('Source no longer exists.')
    this.db.prepare('DELETE FROM effective_sources WHERE source_key=?').run(key)
  }
  exclusions() {
    return this.db.prepare('SELECT source_key AS key,reason,status FROM exclusion_status').all()
  }
  restoreSource(key) {
    this.requireDev()
    text(key, 'Source key')
    if (!this.db.prepare('DELETE FROM source_exclusions WHERE source_key=?').run(key).changes) throw new Error('Exclusion no longer exists.')
  }
  snapshot() {
    return {
      catalogGeneration: this.db.prepare("SELECT value FROM metadata WHERE key='generated_at'").get()?.value ?? '',
      workspace: this.db.prepare('SELECT * FROM planner_workspace ORDER BY id').all(),
      prices: this.db.prepare('SELECT * FROM auction_house_prices ORDER BY item_id').all(),
      manual: this.db.prepare('SELECT * FROM manual_sources ORDER BY manual_id').all(),
      exclusions: this.db.prepare('SELECT * FROM source_exclusions ORDER BY source_key').all(),
    }
  }
  applySnapshot(snapshot, expected) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (JSON.stringify(historyData(this.snapshot())) !== JSON.stringify(historyData(expected))) {
        this.undoStack = []; this.redoStack = []
        throw new Error('Database changed outside this session. Undo/redo cleared to preserve external edits.')
      }
      const current = this.readState()
      for (const [field, table] of [['workspace', 'planner_workspace'], ['prices', 'auction_house_prices'],
        ['manual', 'manual_sources'], ['exclusions', 'source_exclusions']]) {
        this.db.exec(`DELETE FROM ${table}`)
        for (const savedRow of snapshot[field]) {
          let row = savedRow
          if (field === 'workspace') {
            const state = JSON.parse(savedRow.state_json)
            state.activeMaterialsOnly = current.activeMaterialsOnly
            state.plans = state.plans.map(plan => {
              const existing = current.plans.find(tab => tab.id === plan.id)
              if (!existing) return plan
              const restored = { ...plan }
              if (existing.autoApplyHeldObols === undefined) delete restored.autoApplyHeldObols
              else restored.autoApplyHeldObols = existing.autoApplyHeldObols
              return restored
            })
            if (state.plans.some(plan => plan.id === current.activeId)) state.activeId = current.activeId
            row = { ...savedRow, state_json: JSON.stringify(state) }
          }
          const keys = Object.keys(row)
          this.db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`)
            .run(...Object.values(row))
        }
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  historyStatus() {
    const prefs = this.db.prepare('SELECT undo_key,redo_key FROM planner_preferences WHERE id=1').get()
    return { canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0,
      undoKey: prefs?.undo_key ?? 'Ctrl+Z', redoKey: prefs?.redo_key ?? 'Ctrl+Y' }
  }
  history(direction) {
    if (!['undo', 'redo'].includes(direction)) throw new Error('Unknown history direction.')
    const from = direction === 'undo' ? this.undoStack : this.redoStack
    const to = direction === 'undo' ? this.redoStack : this.undoStack
    const entry = from.at(-1)
    if (!entry) throw new Error(`Nothing to ${direction}.`)
    const expected = direction === 'undo' ? entry.after : entry.before
    this.applySnapshot(direction === 'undo' ? entry.before : entry.after, expected)
    from.pop(); to.push(entry)
  }
  setHotkeys(undoKey, redoKey) {
    const normalize = key => {
      text(key, 'Hotkey')
      if (!/^(Ctrl|Alt)(\+(Ctrl|Alt|Shift))*\+[A-Z0-9]$/.test(key)) {
        throw new Error('Use Ctrl/Alt with optional Shift and a letter/digit, for example Ctrl+Z.')
      }
      const parts = key.split('+')
      const modifiers = parts.slice(0, -1)
      if (new Set(modifiers).size !== modifiers.length) throw new Error('Duplicate hotkey modifier.')
      return ['Ctrl', 'Alt', 'Shift'].filter(m => modifiers.includes(m)).concat(parts.at(-1)).join('+')
    }
    undoKey = normalize(undoKey); redoKey = normalize(redoKey)
    if (undoKey === redoKey) throw new Error('Undo and redo hotkeys must differ.')
    this.db.prepare('INSERT INTO planner_preferences VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET undo_key=excluded.undo_key,redo_key=excluded.redo_key')
      .run(undoKey, redoKey)
  }
}
