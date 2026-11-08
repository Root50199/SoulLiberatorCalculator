import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PlannerStore, prepareUserDatabase } from './planner-store.mjs'

async function fixture(t, dev = true) {
  const folder = await mkdtemp(path.join(tmpdir(), 'sl-store-'))
  const filename = path.join(folder, 'test.sqlite')
  await copyFile(new URL('../data/soul-liberator.sqlite', import.meta.url), filename)
  const store = new PlannerStore(filename, dev)
  store.db.exec('DELETE FROM planner_preferences')
  t.after(async () => { store.close(); await rm(folder, { recursive: true }) })
  return { store, filename }
}
test('packaged database seeds bundled defaults once and preserves saved edits on relaunch', async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'sl-packaged-'))
  t.after(() => rm(folder, { recursive: true }))
  const filename = await prepareUserDatabase(path.join(folder, 'user-data'))
  const store = new PlannerStore(filename)
  const initial = store.readState()
  store.saveState({ ...initial, obolValue: 123456 })
  store.close()
  assert.equal(await prepareUserDatabase(path.join(folder, 'user-data')), filename)
  const reopened = new PlannerStore(filename)
  try {
    assert.equal(reopened.readState().obolValue, 123456)
    assert.deepEqual(reopened.readState().inventory, initial.inventory)
  } finally { reopened.close() }
  await assert.rejects(() => prepareUserDatabase(filename), /EEXIST|ENOTDIR/)
})
test('window size persists across sessions without affecting undo/redo', async t => {
  const { store, filename } = await fixture(t)
  store.db.exec('DELETE FROM planner_window')
  assert.deepEqual(store.windowSize(), { width: 1440, height: 940 })
  store.setPrice(5100303, 123)
  store.history('undo')
  store.saveWindowSize({ width: 1100, height: 800 })
  assert.equal(store.historyStatus().canRedo, true)
  store.history('redo')
  assert.deepEqual(store.windowSize(), { width: 1100, height: 800 })
  const reopened = new PlannerStore(filename)
  try { assert.deepEqual(reopened.windowSize(), { width: 1100, height: 800 }) }
  finally { reopened.close() }
  assert.throws(() => store.saveWindowSize({ width: 699, height: 800 }), /Window width/)
  assert.throws(() => store.saveWindowSize({ width: 1100, height: 539 }), /Window height/)
})
test('catalog exposes confirmed unit gold/Obol offers, notes, and all SL items', async t => {
  const { store } = await fixture(t)
  const catalog = store.catalog()
  assert.equal(catalog.slIds.length, 29)
  assert.equal(catalog.sources.find(s => s.key === 'leannan:5100274').currency, 'gold')
  assert.equal(catalog.sources.find(s => s.key === 'leannan:5100334').quantity, 1)
  assert.equal(catalog.notes.find(n => n.itemId === 63385).status, 'confirmed')
  assert.ok(!catalog.items.some(item => item.id === 90201))
  assert.ok(catalog.recipes.every(recipe => recipe.ingredients.every(ingredient => !ingredient.candidates.includes(90201))))
})
test('workspace and AH prices persist with shared inventory', async t => {
  const { store, filename } = await fixture(t)
  const state = { obolValue: 600000, activeId: 'a', inventory: { 5100303: 3 }, activeMaterialsOnly: true, plans: [
    { id: 'a', itemId: 1230039, label: 'First', quantity: 1, inventory: {}, overrides: {}, autoApplyHeldObols: true },
    { id: 'b', itemId: 1080048, label: 'Second', quantity: 1, inventory: {}, overrides: {} },
  ] }
  store.saveState(state)
  store.setPrice(5100303, 250)
  const reopened = new PlannerStore(filename)
  try {
    assert.deepEqual(reopened.readState(), state)
    assert.equal(reopened.catalog().items.find(i => i.id === 5100303).ahPrice, 250)
  } finally { reopened.close() }
  assert.throws(() => store.setPrice(5100303, -1), /whole number/)
  assert.throws(() => store.saveState({ ...state, obolValue: -1 }), /whole number/)
  assert.throws(() => store.saveState({ ...state, plans: [{ ...state.plans[0], autoApplyHeldObols: 'yes' }] }), /auto-apply held Obols/)
})
test('legacy inventory migrates by per-ID maximum and global stock survives tabs/history', async t => {
  const { store } = await fixture(t)
  const legacy = { obolValue: 600000, activeId: 'a', plans: [
    { id: 'a', itemId: 1230039, label: 'A', quantity: 1, inventory: { 5100303: 3, 5300217: 10 }, overrides: {} },
    { id: 'b', itemId: 1080048, label: 'B', quantity: 1, inventory: { 5100303: 5, 5300217: 4 }, overrides: {} },
  ] }
  store.db.prepare('INSERT INTO planner_workspace VALUES(1,?) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json').run(JSON.stringify(legacy))
  const migrated = store.readState()
  assert.deepEqual(migrated.inventory, { 5100303: 5, 5300217: 10 })
  assert.equal(migrated.activeMaterialsOnly, true)
  assert.ok(migrated.plans.every(plan => Object.keys(plan.inventory).length === 0))
  assert.deepEqual(store.readState(), migrated)
  store.saveState({ ...migrated, inventory: { ...migrated.inventory, 5100303: 7 } })
  store.history('undo'); assert.equal(store.readState().inventory[5100303], 5)
  store.history('redo'); assert.equal(store.readState().inventory[5100303], 7)
  store.saveState({ ...store.readState(), plans: [], activeId: null })
  assert.equal(store.readState().inventory[5100303], 7)
  assert.equal(store.readState().plans[0].itemId, null)
  assert.throws(() => store.saveState({ ...store.readState(), inventory: { 5100303: -1 } }), /whole number/)
})
test('settings and tab selection skip history and survive data undo/redo', async t => {
  const { store } = await fixture(t)
  const initial = store.readState()
  const first = initial.plans[0]
  store.saveState({ ...initial, plans: [{ ...first, label: 'Renamed' },
    { ...first, id: 'second', label: 'Second' }] })
  const changed = store.readState()
  const settings = { ...changed, activeId: 'second', activeMaterialsOnly: !changed.activeMaterialsOnly,
    plans: changed.plans.map(plan => ({ ...plan, autoApplyHeldObols: true })) }
  store.saveState(settings)
  assert.equal(store.undoStack.length, 1)
  store.history('undo')
  assert.equal(store.readState().plans.length, initial.plans.length)
  assert.equal(store.readState().activeMaterialsOnly, settings.activeMaterialsOnly)
  assert.equal(store.readState().plans[0].autoApplyHeldObols, true)
  store.saveState({ ...store.readState(), activeMaterialsOnly: changed.activeMaterialsOnly })
  assert.equal(store.historyStatus().canRedo, true)
  store.history('redo')
  assert.equal(store.readState().plans.length, changed.plans.length)
  assert.equal(store.readState().plans[0].label, 'Renamed')
  assert.equal(store.readState().activeMaterialsOnly, changed.activeMaterialsOnly)
  store.saveState({ ...store.readState(), inventory: { ...store.readState().inventory, 5100303: 42 } })
  store.saveState({ ...store.readState(), plans: store.readState().plans.map(plan =>
    ({ ...plan, autoApplyHeldObols: false })) })
  store.history('undo')
  assert.deepEqual(store.readState().inventory, initial.inventory)
  assert.ok(store.readState().plans.every(plan => plan.autoApplyHeldObols === false))
  store.history('redo')
  assert.equal(store.readState().inventory[5100303], 42)
  assert.ok(store.readState().plans.every(plan => plan.autoApplyHeldObols === false))
})
test('dev source replacement is atomic and reversible; production writes are gated', async t => {
  const { store, filename } = await fixture(t)
  const input = { manualId: null, itemId: 5100303, kind: 'shop', name: 'My vendor',
    currency: 'gold', currencyItemId: null, price: 20, quantity: 1, notes: 'Confirmed' }
  store.saveSource(input)
  let manual = store.catalog().sources.find(s => s.name === input.name)
  assert.ok(manual)
  store.saveSource({ ...input, manualId: Number(manual.key.slice(7)), price: 25 })
  assert.equal(store.catalog().sources.find(s => s.key === manual.key).price, 25)
  store.removeSource(manual.key)
  assert.equal(store.catalog().sources.some(s => s.key === manual.key), false)
  const replacement = { ...input, itemId: 5100334, currency: 'item', currencyItemId: 5300217, price: 90 }
  store.saveSource(replacement, 'leannan:5100334')
  assert.equal(store.catalog().sources.some(s => s.key === 'leannan:5100334'), false)
  store.restoreSource('leannan:5100334')
  assert.equal(store.catalog().sources.some(s => s.key === 'leannan:5100334'), true)
  assert.throws(() => store.saveSource({ ...replacement, price: -2 }, 'leannan:5100334'), /whole number/)
  assert.ok(store.catalog().sources.some(s => s.key === 'leannan:5100334'))
  const production = new PlannerStore(filename, false)
  try { assert.throws(() => production.saveSource(input), /development mode/) }
  finally { production.close() }
})
test('mob drops persist as descriptive sources with undo/redo and no purchase values', async t => {
  const { store } = await fixture(t)
  const input = { manualId: null, itemId: 5100303, kind: 'mob_drop', name: 'Young Raccoon',
    currency: null, currencyItemId: null, price: null, quantity: null, notes: 'Wiki observation; chance unknown' }
  store.saveSource(input)
  const saved = store.catalog().sources.find(source => source.name === input.name)
  assert.equal(saved.kind, 'mob_drop')
  assert.equal(saved.quantity, null)
  store.history('undo')
  assert.equal(store.catalog().sources.some(source => source.key === saved.key), false)
  store.history('redo')
  assert.equal(store.catalog().sources.find(source => source.key === saved.key).kind, 'mob_drop')
  assert.throws(() => store.saveSource({ ...input, currency: 'gold', price: 1 }), /not purchases/)
  store.saveSource({ ...input, manualId: Number(saved.key.slice(7)), name: 'Masked Goblin' })
  assert.equal(store.catalog().sources.find(source => source.key === saved.key).name, 'Masked Goblin')
})
test('Ducat shop offers persist their currency without gold conversion', async t => {
  const { store } = await fixture(t)
  store.saveSource({ manualId: null, itemId: 5100303, kind: 'shop', name: 'Ducat vendor',
    currency: 'ducats', currencyItemId: null, price: 75, quantity: 3, notes: 'Commerce shop' })
  const saved = store.catalog().sources.find(source => source.name === 'Ducat vendor')
  assert.equal(saved.currency, 'ducats')
  assert.equal(saved.price, 75)
  assert.equal(saved.quantity, 3)
})
test('real staff graph calculates without cycling or exhausting search budget', async t => {
  const { store } = await fixture(t)
  store.db.exec('UPDATE auction_house_prices SET gold_per_unit=NULL')
  const { calculatePlan } = await import('../src/planner.ts')
  const result = calculatePlan(store.catalog(), {
    id: 'staff', itemId: 1230039, label: 'Staff', quantity: 1, inventory: {}, overrides: {},
  }, 600000)
  assert.ok(result.tree.children.length === 8)
  assert.ok(result.obolSpend > 0)
  assert.ok(result.unresolved.length > 0)
})
test('fresh workspace starts with persistent empty tab and older selected plans survive', async t => {
  const { store } = await fixture(t)
  store.db.exec('DELETE FROM planner_workspace')
  const blank = store.readState()
  assert.equal(blank.plans.length, 1)
  assert.equal(blank.plans[0].itemId, null)
  assert.equal(store.readState().plans[0].id, blank.plans[0].id)
  const selected = { ...blank, plans: [{ ...blank.plans[0], itemId: 1230039 }] }
  store.saveState(selected)
  assert.deepEqual(store.readState(), selected)
  store.history('undo')
  assert.deepEqual(store.readState(), blank)
  store.history('redo')
  assert.deepEqual(store.readState(), selected)
})
test('undo redo cover prices and source replacements and preserve external edits', async t => {
  const { store } = await fixture(t)
  const oldPrice = store.catalog().items.find(i => i.id === 5100303).ahPrice
  store.setPrice(5100303, 321)
  store.history('undo')
  assert.equal(store.catalog().items.find(i => i.id === 5100303).ahPrice, oldPrice)
  store.history('redo')
  assert.equal(store.catalog().items.find(i => i.id === 5100303).ahPrice, 321)
  store.saveSource({ manualId: null, itemId: 5100334, kind: 'shop', name: 'Correction',
    currency: 'item', currencyItemId: 5300217, price: 99, quantity: 1, notes: 'test' }, 'leannan:5100334')
  store.history('undo')
  assert.ok(store.catalog().sources.some(s => s.key === 'leannan:5100334'))
  assert.ok(!store.catalog().sources.some(s => s.name === 'Correction'))
  store.history('redo')
  assert.ok(!store.catalog().sources.some(s => s.key === 'leannan:5100334'))
  store.history('undo')
  store.setPrice(5100303, 444)
  assert.equal(store.historyStatus().canRedo, false)
  store.db.prepare('UPDATE auction_house_prices SET notes=? WHERE item_id=?').run('external', 5100303)
  assert.throws(() => store.history('undo'), /outside this session/)
  assert.equal(store.db.prepare('SELECT notes FROM auction_house_prices WHERE item_id=?').get(5100303).notes, 'external')
})
test('custom hotkeys persist and reject identical or invalid combinations', async t => {
  const { store, filename } = await fixture(t)
  assert.equal(store.historyStatus().undoKey, 'Ctrl+Z')
  assert.equal(store.historyStatus().redoKey, 'Ctrl+Y')
  store.setHotkeys('Alt+Shift+Z', 'Ctrl+Shift+Z')
  const reopened = new PlannerStore(filename)
  try { assert.equal(reopened.historyStatus().redoKey, 'Ctrl+Shift+Z') } finally { reopened.close() }
  assert.throws(() => store.setHotkeys('Z', 'Ctrl+Y'), /Ctrl\/Alt/)
  assert.throws(() => store.setHotkeys('Ctrl+Z', 'Ctrl+Z'), /must differ/)
})
test('removing the last tracker keeps a stable blank tab through undo and redo', async t => {
  const { store } = await fixture(t)
  store.db.exec('DELETE FROM planner_workspace')
  const initial = store.readState()
  const selected = { ...initial, plans: [{ ...initial.plans[0], itemId: 1230039 }] }
  store.saveState(selected)
  store.saveState({ ...selected, activeId: null, plans: [] })
  const blank = store.readState()
  assert.equal(blank.plans[0].itemId, null)
  store.history('undo')
  assert.deepEqual(store.readState(), selected)
  store.history('redo')
  assert.deepEqual(store.readState(), blank)
  store.history('undo')
  assert.deepEqual(store.readState(), selected)
})
test('catalog refresh invalidates history without overwriting refreshed evidence', async t => {
  const { store } = await fixture(t)
  store.setPrice(5100303, 321)
  store.db.prepare("UPDATE metadata SET value=? WHERE key='generated_at'").run('refreshed')
  assert.throws(() => store.history('undo'), /outside this session/)
  assert.equal(store.historyStatus().canUndo, false)
  assert.equal(store.catalog().items.find(i => i.id === 5100303).ahPrice, 321)
})
test('desktop trackers always target one SL, including previously saved quantities', async t => {
  const { store } = await fixture(t)
  const state = store.readState()
  state.plans[0].quantity = 3
  store.db.prepare('UPDATE planner_workspace SET state_json=? WHERE id=1').run(JSON.stringify(state))
  assert.equal(store.readState().plans[0].quantity, 1)
  state.plans[0].quantity = 5
  store.saveState(state)
  assert.equal(store.readState().plans[0].quantity, 1)
})
