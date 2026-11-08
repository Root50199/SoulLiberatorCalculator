import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { SyntheticEvent } from 'react'
import type { Catalog, HistoryStatus, ManualSourceInput, Source, TrackingPlan, WorkspaceState } from './model'
import { calculatePlan } from './planner'
import type { TreeNode } from './planner'
import { equipmentArtSource, equipmentArtUrl } from './equipment-art'
import { aliasInventory, materialAliases, materialRequirements, sortInventoryMaterials, baseItemName, digitCaret, groupDigits, materialPriceComparison, materialPriceLookup } from './price-display'
import goldIcon from './assets/Icon_Currency_Gold.png'
import settingsIcon from './assets/Settings.png'
import plusIcon from './assets/GreyScalePlusIcon.png'
import pencilIcon from './assets/GreyScalePencileIcon.png'
import deleteIcon from './assets/DeleteIcon.png'
import changeIcon from './assets/GreyScaleSortIcon.png'
import downIcon from './assets/DownIcon.png'
import { craftRecipeLabel, sourceLabels, sourceTooltip, inventorySourceTooltip } from './source-display'
import { goldProgress, obolProgress } from './obol-progress'
import { applyHeldObols } from './held-obols'
import { GateDrag, WindowResize } from './WindowResize'

const format = (n: number) => n.toLocaleString('en-US')
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
function isTextField(target: EventTarget): target is HTMLInputElement | HTMLTextAreaElement {
  return target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement && target.selectionStart !== null)
}
function sourceDescription(source: Source) {
  const data: unknown = JSON.parse(source.details)
  if (!data || typeof data !== 'object') return source.details
  if ('notes' in data && typeof data.notes === 'string') return data.notes
  if ('contents' in data && Array.isArray(data.contents)) {
    return sourceLabels(source).join('; ')
  }

  return ''
}

function InfoBubble({ text, label }: { text: string; label: string }) {
  const id = useId()
  const popout = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  function keepOpen() { if (timer.current) clearTimeout(timer.current) }
  function closeLater() {
    keepOpen()
    timer.current = setTimeout(() => popout.current?.hidePopover(), 200)
  }
  function show(button: HTMLButtonElement) {
    keepOpen()
    const panel = popout.current
    if (!panel) return
    const box = button.getBoundingClientRect()
    panel.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - 368))}px`
    panel.style.top = `${Math.max(8, Math.min(box.bottom + 4, window.innerHeight / 2 - 8))}px`
    panel.showPopover()
  }
  return text ? <span className="info-control" onMouseLeave={closeLater}>
    <button type="button" className="info-bubble" aria-label={label} aria-controls={id}
      onMouseEnter={event => show(event.currentTarget)} onFocus={event => show(event.currentTarget)}
      onClick={event => show(event.currentTarget)} onBlur={closeLater}>i</button>
    <div ref={popout} id={id} popover="auto" className="info-popout" tabIndex={0}
      onMouseEnter={keepOpen} onMouseLeave={closeLater} onFocus={keepOpen} onBlur={closeLater}>{text}</div>
  </span> : null
}

function NumberField({ value, onCommit, label, min = 0, nullable = false, disabled = false, grouped = false, autoSize = false }:
  { value: number | null; onCommit: (value: number | null) => void; label: string;
    min?: number; nullable?: boolean; disabled?: boolean; grouped?: boolean; autoSize?: boolean }) {
  const [draft, setDraft] = useState(value === null ? min === 0 ? '0' : '' : String(value))
  const [invalid, setInvalid] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const selection = useRef<[number, number] | null>(null)
  useLayoutEffect(() => {
    if (selection.current) {
      input.current?.setSelectionRange(...selection.current)
      selection.current = null
    }
  })
  useEffect(() => { setDraft(value === null ? min === 0 ? '0' : '' : String(value)); setInvalid(false) }, [value, min])
  function commit() {
    const n = Number(draft)
    if (!Number.isSafeInteger(n) || n < min) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    if (draft === '') setDraft('0')
    if (n !== value) onCommit(n)
  }
  return <span className={`number-field${autoSize ? ' auto-size' : ''}`}>
    {autoSize && <span className="number-measure" aria-hidden="true">{grouped ? groupDigits(draft) || '0' : draft || '0'}</span>}
    <input ref={input} aria-label={label} aria-invalid={invalid} inputMode="numeric" value={grouped ? groupDigits(draft) : draft}
      placeholder={nullable ? 'Unknown' : '0'} disabled={disabled}
      onChange={e => {
        const text = e.target.value
        if (grouped) {
          if (!/^[\d,]*$/.test(text)) { setInvalid(true); return }
          selection.current = [digitCaret(text, e.target.selectionStart ?? 0), digitCaret(text, e.target.selectionEnd ?? 0)]
          setDraft(text.replace(/,/g, ''))
        } else setDraft(text)
      }} onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (!grouped || e.ctrlKey || e.altKey || e.metaKey || !['Backspace', 'Delete'].includes(e.key)) return
        const field = e.currentTarget, start = field.selectionStart ?? 0, end = field.selectionEnd ?? 0
        if (start !== end) return
        if (e.key === 'Backspace' && field.value[start - 1] === ',') field.setSelectionRange(start - 2, end)
        if (e.key === 'Delete' && field.value[start] === ',') field.setSelectionRange(start, end + 2)
      }} onDoubleClick={e => { if (grouped) e.currentTarget.select() }} />
    {invalid && <small role="alert">Whole number {min}+ required</small>}
  </span>
}

function ItemIcon({ id, program = false }: { id: number; program?: boolean }) {
  const [error, setError] = useState('')
  const image = `./item-icons/${program ? 'program-obol' : id}.png`
  useEffect(() => { setError('') }, [image])
  return <span className={`item-icon${program ? ' program-icon' : ''}`}>{error ?
    <small className="error" title={error}>Icon unavailable</small> :
    <img src={image} alt="" onError={() => {
      const failure = `Bundled item icon missing: ${image}`
      console.error(failure); setError(failure)
    }} />}</span>
}

function TrackerTab({ plan, selected, busy, onSelect, onRename, onRemove }:
  { plan: TrackingPlan; selected: boolean; busy: boolean; onSelect: () => void;
    onRename: (label: string) => void; onRemove: () => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(plan.label)
  const input = useRef<HTMLInputElement>(null)
  const cancelled = useRef(false)
  const selectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (selectTimer.current) clearTimeout(selectTimer.current) }, [])
  useEffect(() => { if (editing) { input.current?.focus(); input.current?.select() } }, [editing])
  function edit() { cancelled.current = false; setDraft(plan.label); setEditing(true) }
  function commit() {
    setEditing(false)
    if (cancelled.current) return
    const label = draft.trim()
    if (label && label !== plan.label) onRename(label)
  }
  return <div className={`tracker-tab${selected ? ' active' : ''}`}>
    {editing ? <input ref={input} aria-label="Rename tracker" value={draft} disabled={busy}
      onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') { cancelled.current = true; setEditing(false) }
      }} /> : <button className="tracker-select" disabled={busy} onClick={onSelect}>
      {plan.itemId !== null && <ItemIcon id={plan.itemId} />}
      <span className="tracker-label" onClick={e => {
        e.stopPropagation()
        if (selectTimer.current) clearTimeout(selectTimer.current)
        selectTimer.current = setTimeout(onSelect, 300)
      }} onDoubleClick={() => {
        if (selectTimer.current) clearTimeout(selectTimer.current)
        edit()
      }}>{plan.label}</span>
    </button>}
    <button className="tab-edit" aria-label={`Rename ${plan.label}`} title="Rename tracker"
      disabled={busy || editing} onClick={edit}><span style={{ maskImage: `url("${pencilIcon}")` }} /></button>
    <button className="tab-delete" aria-label={`Delete ${plan.label}`} title="Delete tracker"
      disabled={busy || editing} onClick={() => {
        if (selectTimer.current) clearTimeout(selectTimer.current)
        onRemove()
      }}><img src={deleteIcon} alt="" /></button>
  </div>
}

function EquipmentArt({ id, splash = false }: { id: number; splash?: boolean }) {
  const [failed, setFailed] = useState(false)
  if (failed && splash) return <p className="art-error" role="status">
    Local background art unavailable. Check the app files; tracking is unaffected.
  </p>
  return <span className={splash ? 'workspace-splash' : 'equipment-art'}>
    {failed ? <span className="art-error">
      <ItemIcon id={id} />Local artwork unavailable. Check the app files.
    </span> : <img src={equipmentArtUrl(id)} alt="" referrerPolicy="no-referrer"
      loading={splash ? 'eager' : 'lazy'} draggable={false} onError={() => {
        console.error(`Official equipment art failed for item ${id}: ${equipmentArtUrl(id)}`)
        setFailed(true)
      }} />}
  </span>
}

export function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null)
  const [plannerStatus, setPlannerStatus] = useState('loading')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<HistoryStatus>({ canUndo: false, canRedo: false, undoKey: 'Ctrl+Z', redoKey: 'Ctrl+Y' })
  const [undoKey, setUndoKey] = useState('Ctrl+Z')
  const [redoKey, setRedoKey] = useState('Ctrl+Y')
  const [itemSearch, setItemSearch] = useState('')
  const [search, setSearch] = useState('')
  const [inventoryView, setInventoryView] = useState('owned')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [confirmation, setConfirmation] = useState<{ accept: () => void } | null>(null)
  const confirmationDialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (confirmation) confirmationDialog.current?.showModal()
  }, [confirmation])
  function confirmAction(accept: () => void) {
    setConfirmation({ accept })
  }
  const [sourceDraft, setSourceDraft] = useState<ManualSourceInput | null>(null)
  const sourceDialog = useRef<HTMLDialogElement>(null)
  const sourceEditing = Boolean(sourceDraft)
  useEffect(() => {
    if (sourceEditing) sourceDialog.current?.showModal()
  }, [sourceEditing])
  const [replaceKey, setReplaceKey] = useState<string | null>(null)
  const [exclusions, setExclusions] = useState<{ key: string; reason: string; status: string }[]>([])
  const [disclosures, setDisclosures] = useState<Record<string, boolean>>({})
  const disclosureStates = useRef<Record<string, boolean>>({})
  useEffect(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem('disclosures') ?? '{}')
      if (!stored || typeof stored !== 'object' || Array.isArray(stored) ||
        Object.values(stored).some(value => typeof value !== 'boolean')) throw new Error('Invalid saved collapse states.')
      disclosureStates.current = Object.fromEntries(Object.entries(stored))
      setDisclosures(disclosureStates.current)
    } catch (failure) { console.error(failure); setError(message(failure)) }
  }, [])
  function disclosure(key: string, initial = false) {
    return {
      open: disclosures[key] ?? initial,
      onToggle: (event: SyntheticEvent<HTMLDetailsElement>) => {
        const open = event.currentTarget.open
        if (open === (disclosureStates.current[key] ?? initial)) return
        const next = { ...disclosureStates.current, [key]: open }
        disclosureStates.current = next
        try { localStorage.setItem('disclosures', JSON.stringify(next)) }
        catch (failure) { console.error(failure); setError(message(failure)) }
        setDisclosures(next)
      },
    }
  }
  const inventoryPanel = useRef<HTMLDetailsElement>(null)
  const inventoryManuallySized = useRef(false)
  const inventoryDrag = useRef<{ y: number; height: number } | null>(null)
  const inventoryReady = Boolean(catalog && workspace)
  useLayoutEffect(() => {
    const panel = inventoryPanel.current
    const main = panel?.parentElement
    const tabs = main?.querySelector<HTMLElement>('.tabs')
    if (!panel || !main || !tabs) return
    function updateLimit() {
      if (!panel || !main || !tabs) return
      const mainStyle = getComputedStyle(main)
      const tabsStyle = getComputedStyle(tabs)
      const available = main.getBoundingClientRect().bottom - parseFloat(mainStyle.paddingBottom) -
        panel.getBoundingClientRect().top - tabs.getBoundingClientRect().height -
        parseFloat(tabsStyle.marginTop) - parseFloat(tabsStyle.marginBottom) - 48
      panel.style.maxHeight = `${Math.max(85, available)}px`
      const body = panel.querySelector<HTMLElement>('.inventory-body')
      const row = panel.querySelector<HTMLElement>('.material-chip')
      const grid = panel.querySelector<HTMLElement>('.owned-materials')
      if (panel.open && body && row && grid && !inventoryManuallySized.current) {
        const header = panel.querySelector('summary')!.getBoundingClientRect().height
        const filter = panel.querySelector<HTMLElement>('.inventory-filter')!
        const filterStyle = getComputedStyle(filter)
        const gap = parseFloat(getComputedStyle(grid).rowGap)
        panel.style.height = `${header + filter.getBoundingClientRect().height +
          parseFloat(filterStyle.marginTop) + parseFloat(filterStyle.marginBottom) +
          row.getBoundingClientRect().height * 2.5 + gap * 2 + 20}px`
      }
    }
    const observer = new ResizeObserver(updateLimit)
    observer.observe(main)
    observer.observe(tabs)
    const grid = panel.querySelector('.owned-materials')
    if (grid) observer.observe(grid)
    for (const sibling of main.children) {
      if (sibling !== panel && !sibling.classList.contains('tab-content')) observer.observe(sibling)
    }
    updateLimit()
    return () => observer.disconnect()
  }, [inventoryReady, error])

  async function load() {
    if (!window.soulLiberator) throw new Error('Desktop bridge unavailable. Run npm run desktop:dev.')
    const data = await window.soulLiberator.loadPlanner()
    updateCatalog(data.catalog)
    updateWorkspace(data.workspace)
    setExclusions(data.exclusions)
    setHistory(data.history)
    setUndoKey(data.history.undoKey); setRedoKey(data.history.redoKey)
  }
  function updateCatalog(next: Catalog) {
    setCatalog(previous => previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next)
  }
  function updateWorkspace(next: WorkspaceState) {
    setWorkspace(previous => previous ? {
      ...next,
      inventory: JSON.stringify(previous.inventory) === JSON.stringify(next.inventory) ? previous.inventory : next.inventory,
      plans: next.plans.map(plan => {
        const existing = previous.plans.find(candidate => candidate.id === plan.id)
        return existing && JSON.stringify(existing) === JSON.stringify(plan) ? existing : plan
      }),
    } : next)
  }
  useEffect(() => {
    let active = true
    async function start() {
      try {
        if (!window.soulLiberator) throw new Error('Desktop bridge unavailable. Run npm run desktop:dev.')
        const data = await window.soulLiberator.loadPlanner()
        if (!active) return
        updateCatalog(data.catalog); updateWorkspace(data.workspace); setExclusions(data.exclusions)
        setHistory(data.history)
        setUndoKey(data.history.undoKey); setRedoKey(data.history.redoKey)
        setPlannerStatus('ready')
      } catch (failure) {
        console.error('Planner startup failed:', failure)
        if (active) { setError(message(failure)); setPlannerStatus('error') }
      }
    }
    void start()
    return () => { active = false }
  }, [])

  async function action(task: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError('')
    try {
      await task()
      const data = await window.soulLiberator!.loadPlanner()
      updateCatalog(data.catalog); updateWorkspace(data.workspace); setExclusions(data.exclusions)
      setHistory(data.history)
    }
    catch (failure) {
      console.error('Planner update failed:', failure); setError(message(failure))
      try {
        const data = await window.soulLiberator!.loadPlanner()
        setHistory(data.history)
      } catch (reloadFailure) {
        console.error('History status reload failed:', reloadFailure)
        setError(`${message(failure)} / ${message(reloadFailure)}`)
      }
    }
    finally { setBusy(false) }
  }
  function save(next: WorkspaceState) {
    void action(async () => { await window.soulLiberator!.saveWorkspace(next) })
  }
  function saveHotkeys() {
    if (undoKey === history.undoKey && redoKey === history.redoKey) return
    void action(async () => { await window.soulLiberator!.setHotkeys(undoKey, redoKey); await load() })
  }
  function travel(direction: 'undo' | 'redo') {
    if (busy || !(direction === 'undo' ? history.canUndo : history.canRedo)) return
    void action(async () => {
      await window.soulLiberator!.history(direction)
      setSourceDraft(null); setReplaceKey(null)
      await load()
    })
  }
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat || event.isComposing) return
      // Text controls retain native text undo/redo; app history applies after the edit is committed.
      const target = event.target
      if (target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
      const key = [event.ctrlKey ? 'Ctrl' : '', event.altKey ? 'Alt' : '',
        event.shiftKey ? 'Shift' : '', event.key.toUpperCase()].filter(Boolean).join('+')
      const direction = key === history.undoKey ? 'undo' : key === history.redoKey ? 'redo' : null
      if (direction) { event.preventDefault(); travel(direction) }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [busy, history])
  const active = workspace?.plans.find(p => p.id === workspace.activeId)
  function updatePlan(next: TrackingPlan) {
    if (workspace) save({ ...workspace, plans: workspace.plans.map(p => p.id === next.id ? next : p) })
  }
  function removeTab(plan: TrackingPlan) {
    if (!workspace) return
    confirmAction(() => {
      const plans = workspace.plans.filter(p => p.id !== plan.id)
      save({ ...workspace, plans, activeId: workspace.activeId === plan.id ? plans[0]?.id ?? null : workspace.activeId })
    })
  }
  const calculation = useMemo(() => {
    if (!catalog || !workspace || !active || active.itemId === null) return null
    try {
      const plan = { ...active, inventory: workspace.inventory }
      const inventoryResult = calculatePlan(catalog, plan, workspace.obolValue, true, true)
      const applied = applyHeldObols(catalog, plan, inventoryResult)
      return { result: applied.spent ? calculatePlan(catalog, applied.plan, workspace.obolValue, true, true) : inventoryResult,
        inventoryResult, applied,
        inventoryObols: obolProgress(catalog, plan),
        obols: obolProgress(catalog, applied.plan), goldProgress: goldProgress(catalog, applied.plan, workspace.obolValue, true), error: '' }
    }
    catch (failure) { return { result: null, error: message(failure) } }
  }, [catalog, workspace?.inventory, workspace?.obolValue, active])
  const result = calculation?.result
  function setTreeExpanded(open: boolean) {
    if (!result || !active) return
    const planId = active.id
    const next = { ...disclosureStates.current }
    function visit(node: TreeNode) {
      next[`tree:${planId}:${node.path}`] = open
      node.children.forEach(visit)
    }
    visit(result.tree)
    disclosureStates.current = next
    try { localStorage.setItem('disclosures', JSON.stringify(next)) }
    catch (failure) { console.error(failure); setError(message(failure)) }
    setDisclosures(next)
  }
  const itemName = (id: number) => baseItemName(catalog?.items.find(i => i.id === id)?.name ?? `Item ${id}`)
  const relevantIds = new Set([
    ...(catalog?.memberships.filter(m => m.slId === active?.itemId).map(m => m.itemId) ?? []),
  ])
  if (active?.itemId) relevantIds.delete(active.itemId)
  const needed = materialRequirements(calculation?.inventoryResult)
  const inventoryGroups = sortInventoryMaterials((catalog ? materialAliases(catalog, workspace?.activeMaterialsOnly ? relevantIds :
    new Set(catalog.items.filter(item => !catalog.slIds.includes(item.id) && item.id !== 5300217).map(item => item.id))) : [])
    .filter(group => !workspace?.activeMaterialsOnly || group.ids.some(id => (needed.get(id) ?? 0) > 0)), result)
  const visibleItems = inventoryGroups.filter(group => group.name.toLowerCase().includes(search.toLowerCase()))
  const owned = (ids: number[]) => ids.reduce((sum, id) => sum + (workspace?.inventory[id] ?? 0), 0)
  function groupInventory(ids: number[], quantity: number) {
    if (workspace) save({ ...workspace, inventory: aliasInventory(workspace.inventory, ids, quantity) })
  }
  const lookupPrice = useMemo(() => catalog && workspace
    ? materialPriceLookup(catalog, workspace.obolValue, true) : null, [catalog, workspace?.obolValue])
  const priceComparisons = useMemo(() => {
    const prices = new Map<string, ReturnType<typeof materialPriceComparison>>()
    if (!catalog || !lookupPrice) return { prices, error: '' }
    try {
      const slIds = new Set(catalog.slIds)
      const groups = new Map<string, number[]>()
      if (catalog.devMode && inventoryView === 'materials') {
        for (const { item } of visibleItems) {
          const candidates = catalog.recipes.flatMap(recipe => recipe.ingredients)
            .filter(ingredient => ingredient.candidates.includes(item.id)).flatMap(ingredient => ingredient.candidates)
          groups.set(String(item.id), [...new Set([item.id, ...candidates])])
        }
      }
      function nodes(node: TreeNode) {
        if (!slIds.has(node.itemId)) groups.set(node.path, node.candidateIds)
        node.children.forEach(nodes)
      }
      if (result) nodes(result.tree)
      for (const [key, ids] of groups) {
        prices.set(key, lookupPrice(ids))
      }
      return { prices, error: '' }
    } catch (failure) { return { prices, error: message(failure) } }
  }, [catalog, lookupPrice, inventoryView, visibleItems, result])
  function materialSources(ids: number[], itemId: number, name: string, editable = false) {
    if (!catalog) return null
    const sources = new Map<string, Source[]>()
    for (const source of catalog.sources.filter(s => ids.includes(s.itemId))) {
      for (const label of sourceLabels(source)) {
        const display = source.kind === 'shop' && source.price !== null
          ? `${label} - ${format(source.price)} ${source.currency === 'item'
            ? itemName(source.currencyItemId ?? 0) : source.currency ?? ''}${source.quantity ? ` for ${format(source.quantity)}` : ''}`
          : label
        sources.set(display, [...(sources.get(display) ?? []), source])
      }
    }
    return <div className="material-source-controls">
      {editable && <button className="source-add" aria-label={`Add source for ${name}`} title="Add source"
        disabled={busy} onClick={() => draftSource(itemId)}>+</button>}
      {sources.size > 0 && <details className="friendly-sources" {...disclosure(`sources:${itemId}`)}>
        <summary>Sources ({sources.size})</summary>
        <ul>{[...sources].map(([label, records]) => <li key={label}><span>{label}</span>
          <InfoBubble label={`Information for ${label}`} text={sourceTooltip(catalog, records)} />
          {editable && <span className="source-actions">
            <button aria-label={`Edit ${label}`} title="Edit source" disabled={busy}
              onClick={() => draftSource(records[0].itemId, records[0])}>Edit</button>
            <button aria-label={`Remove ${label}`} title="Remove source" disabled={busy} onClick={() => {
              confirmAction(() => void action(async () => {
                for (const record of new Map(records.map(record => [record.key, record])).values()) {
                  await window.soulLiberator!.removeSource(record.key)
                }
                await load()
              }))
            }}>-</button>
          </span>}
        </li>)}</ul>
      </details>}
      {catalog.notes.filter(n => ids.includes(n.itemId)).map(n =>
        <InfoBubble key={`${n.itemId}:${n.title}`} label={n.title} text={`${n.title}: ${n.message}`} />)}
    </div>
  }
  function comparison(key: string) {
    const price = priceComparisons.prices.get(key)
    return <>
      {price?.npcPrices.map(offer => <span className="inline-price" key={offer.key}>
        <small>{offer.name} / item</small><strong>{format(offer.price)}{offer.currency === 'gold' ? 'g' : ' Ducats'}</strong>
        {!offer.verified && <InfoBubble label={`Availability for ${offer.name}`}
          text="Observed client shop price; access and purchase limits need verification." />}
      </span>)}
      {price?.obolGold !== null && price?.obolGold !== undefined &&
        <span className="inline-price"><small>{format(price.obolsPerItem ?? 0)} Obols / item</small><strong>{format(price.obolGold)}g</strong></span>}
      {price?.hasCraft && <span className="inline-price"><small>Creates {price.craftOutputs.map(format).join(' / ')} per craft</small>
        <strong>{price.craftGold === null ? 'Unverified' : `${format(price.craftGold)}g`}{missingPriceMarker(price.craftMissingPrices)}</strong></span>}
    </>
  }
  function override(path: string, key: string) {
    if (!active) return
    const overrides = { ...active.overrides }
    if (key) overrides[path] = key
    else delete overrides[path]
    updatePlan({ ...active, overrides })
  }
  function autoObolMarker(path: string) {
    const applied = calculation?.applied?.allocations.get(path)
    return applied ? <span className="auto-obol-marker"
      title={`${format(applied.quantity)} items from ${format(applied.obols)} auto-applied held Obols. Preview only; saved inventory is unchanged.`}>*</span> : null
  }
  function missingPriceMarker(prices: string[] | undefined) {
    return prices?.length ? <span className="missing-price-marker" tabIndex={0}
      title={`Assumed 0 until priced:\n${[...new Set(prices)].map(baseItemName).join('\n')}`}>*</span> : null
  }
  function tree(node: TreeNode, depth = 0) {
    const root = depth === 0 && catalog?.slIds.includes(node.itemId)
    const totalGold = node.gold + node.obols * (workspace?.obolValue ?? 0)
    const unitGold = node.unresolved.length ? 'Needs input' : node.remaining
      ? `${format(totalGold / node.remaining)}g` : 'Obtained'
    const completed = node.required > 0 && node.obtained >= node.required
    return <div key={node.path} className={root ? 'sl-tree-root' : undefined}>
      <details className={`tree-node ${node.unresolved.length ? 'incomplete' : ''}${node.required > 0 && node.obtained >= node.required ? ' completed' : ''}`}
      {...disclosure(`tree:${active?.id}:${node.path}`, depth < 2)}>
      <summary>
        <span className="tree-name"><ItemIcon id={node.itemId} />
          <strong>{itemName(node.itemId)}</strong>
        {!root && <fieldset className="route-choices" aria-label={`Route for ${itemName(node.itemId)}`}
          disabled={busy || !node.remaining} onClick={event => event.stopPropagation()}
          onKeyDown={event => event.stopPropagation()}>
          <label><input type="radio" name={`route:${active?.id}:${node.path}`}
            checked={!active?.overrides[node.path]} onChange={() => override(node.path, '')} />Auto</label>
              {node.options.map(o => <label key={o.key} title={baseItemName(o.reason ?? o.label)}>
                <input type="radio" name={`route:${active?.id}:${node.path}`}
                  value={o.key}
                  checked={active?.overrides[node.path] === o.key} onChange={() => override(node.path, o.key)} />
                {o.key.startsWith('ah:') ? 'AH' : o.key.startsWith('recipe:') && catalog ? craftRecipeLabel(catalog, o.key.slice(7)) :
                  o.label.includes('(Obols)') ? 'Obols' : o.label.includes('(ducats)') ? 'Ducats' : 'NPC'}
              </label>)}
              {active?.overrides[node.path] && !node.options.some(o => o.key === active.overrides[node.path]) &&
                <small>Unavailable override - choose Auto</small>}
        </fieldset>}</span>
        <span className="tree-quantity">{format(node.obtained)}{autoObolMarker(node.path)}
          {' / '}{format(node.required)} obtained</span>
        <span className="tree-cost">
          <span className="tree-total-price">{completed ? 'Completed' : node.unresolved.length ? 'Needs input' : `${format(totalGold)}g total`}{!completed && missingPriceMarker(node.missingPrices)}</span>
          {!root && !completed && <small className="tree-unit-price">{unitGold}{node.remaining > 0 && !node.unresolved.length ? ' / item' : ''}{missingPriceMarker(node.missingPrices)}</small>}
        </span>
      </summary>
      <div className="node-body">
        {!root && <div className="material-prices">
          <span className="inline-price selected-unit-price"><small>Selected route / item</small>
            <strong>{unitGold}{missingPriceMarker(node.missingPrices)}</strong>
          </span>
          {catalog?.items.filter(item => node.candidateIds.includes(item.id) && item.auctionEligible).slice(0, 1)
            .map(item => <label className="inline-price" key={item.id}><small>AH / item</small>
              <NumberField label={`AH price ${itemName(item.id)}`} value={item.ahPrice} grouped nullable disabled={busy}
                onCommit={value => void action(async () => { await window.soulLiberator!.setPrice(item.id, value) })} />
              {item.ahPrice === null && missingPriceMarker([`Enter AH gold price for ${item.name}.`])}</label>)}
          {comparison(node.path)}
        </div>}
        <p className="muted">{baseItemName(node.route)} {node.obols > 0 &&
          ` / ${format(node.obols)} Obols${root ? ' via selected material routes' : ''}`}
          {node.options.some(o => o.equivalent === null) && ' / Some alternatives need verification.'}</p>
        {!root && materialSources(node.candidateIds, node.itemId, itemName(node.itemId))}
        {node.unresolved.length > 0 && <p className="warning">{[...new Set(node.unresolved)].slice(0, 3).map(baseItemName).join(' ')}</p>}
        {node.children.map(child => tree(child, depth + 1))}
      </div>
    </details>
    {root && <div className="condensed-ingredients">
      {node.children.map(child => <div className={`condensed-ingredient${child.required > 0 && child.obtained >= child.required ? ' completed' : ''}`} key={child.path}>
        <ItemIcon id={child.itemId} /><span>{itemName(child.itemId)}</span>
        <strong>{format(child.obtained)}{autoObolMarker(child.path)} / {format(child.required)}</strong>
      </div>)}
    </div>}
    </div>
  }
  function draftSource(itemId: number, source?: Source) {
    setReplaceKey(source?.origin === 'auto' ? source.key : null)
    setSourceDraft({
      manualId: source?.origin === 'manual' ? Number(source.key.slice(7)) : null,
      itemId, kind: source?.kind === 'reward' ? 'reward' : source?.kind === 'craft' ? 'craft' :
        source?.kind === 'other' ? 'other' : source?.kind === 'mob_drop' ? 'mob_drop' : 'shop',
      name: source?.name ?? '', currency: source ? source.currency : 'gold',
      currencyItemId: source?.currencyItemId ?? null, price: source?.price ?? null,
      quantity: source ? source.quantity : 1, notes: source ? sourceDescription(source) : '',
    })
  }
  async function windowControl(command: 'minimize' | 'close') {
    try {
      if (!window.soulLiberator) throw new Error('Desktop bridge unavailable.')
      await window.soulLiberator.windowControl(command)
    } catch (failure) {
      console.error('Window control failed:', failure)
      setError(message(failure))
    }
  }
  return <main className={active?.itemId ? 'selected-workspace' : ''} data-planner-status={plannerStatus}
    data-planner-ready={catalog ? 'true' : undefined}
    onFocusCapture={event => { if (isTextField(event.target)) event.target.select() }}
    onMouseDownCapture={event => {
      if (event.button === 0 && isTextField(event.target) && document.activeElement !== event.target &&
        !event.target.disabled) {
        event.preventDefault()
        event.target.focus()
      }
    }}>
    {workspace?.showProtrudingGate !== false && <GateDrag onError={setError} />}
    <WindowResize onError={setError} />
    {active?.itemId && <EquipmentArt key={active.itemId} id={active.itemId} splash />}
    <header className="app-header">
      <h1 className="window-title"><span className="framed-title">Soul Liberator Calculator</span></h1>
      <div className="header-status">
        <span role="status">{busy ? 'Saving...' : ''}</span>
      </div>
      <div className="header-tools">
        <div className="window-controls">
          <button aria-label="Minimize window" title="Minimize" onClick={() => void windowControl('minimize')}>&minus;</button>
          <button className="window-close" aria-label="Close window" title="Close" disabled={busy}
            onClick={() => void windowControl('close')}>&times;</button>
        </div>
        <button className="icon-button settings-button" aria-label="Settings" title="Settings" aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen(!settingsOpen)}><img src={settingsIcon} alt="" /></button>
        {settingsOpen && <section className="settings-panel" aria-label="Settings">
          {workspace && <label className="settings-toggle"><input type="checkbox" aria-label="Show protruding gate"
            checked={workspace.showProtrudingGate !== false} disabled={busy}
            onChange={event => save({ ...workspace, showProtrudingGate: event.target.checked })} />
            Show protruding gate</label>}
          <h2>Undo/redo hotkeys</h2>
          <button disabled={busy || !history.canUndo} onClick={() => travel('undo')}>Undo ({history.undoKey})</button>
          <button disabled={busy || !history.canRedo} onClick={() => travel('redo')}>Redo ({history.redoKey})</button>
          <label>Undo shortcut<input aria-label="Undo shortcut" value={undoKey} disabled={busy}
            onChange={e => setUndoKey(e.target.value)} onBlur={saveHotkeys}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} /></label>
          <label>Redo shortcut<input aria-label="Redo shortcut" value={redoKey} disabled={busy}
            onChange={e => setRedoKey(e.target.value)} onBlur={saveHotkeys}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} /></label>
          <button onClick={() => setSettingsOpen(false)}>Close settings</button>
        </section>}
      </div>
    </header>
    {error && <div className="error-banner" role="alert">{error}<button disabled={busy} onClick={() => void action(load)}>Reload database</button></div>}
    {!catalog || !workspace ? <section><h2>Opening your material database</h2><p>Desktop access is required for SQLite editing.</p></section> : <>
      {priceComparisons.error && <p className="error-banner" role="alert">Price comparison failed: {priceComparisons.error}</p>}
      <details ref={inventoryPanel} className="global-inventory" {...disclosure('inventory', true)}>
        <summary><span className="inventory-heading">Inventory</span>
          <div className="obol-chips" onClick={event => event.preventDefault()}
            onKeyDown={event => event.stopPropagation()}>
            <div className="obol-owned-chip">
              <ItemIcon id={5300217} />
              <label>Obols held<span className="owned-count">
                <NumberField label="Obtained Obols" grouped autoSize value={workspace.inventory[5300217] ?? 0} disabled={busy}
                  onCommit={value => groupInventory([5300217], value ?? 0)} />
                {active?.itemId && <span title="All-Obol material baseline remaining after actual obtained materials, not selected-route spending. Ignores AH/route overrides and auto-applied held Obols.">
                  /{format(calculation?.inventoryObols?.remaining ?? 0)}</span>}
              </span></label>
            </div>
            <div className="obol-control">
              <label><span className="obol-label">Obol price</span><span className="obol-amount">
                <NumberField label="Obol price" grouped autoSize value={workspace.obolValue}
                  disabled={busy} onCommit={v => save({ ...workspace, obolValue: v ?? 0 })} />
                <img className="gold-icon" src={goldIcon} alt="gold" />
              </span></label>
            </div>
          </div>
          <img className="inventory-disclosure" src={downIcon} alt="" />
        </summary>
        <div className="inventory-body">
        <label className="inventory-filter"><input type="checkbox" checked={workspace.activeMaterialsOnly} disabled={busy}
          onChange={event => save({ ...workspace, activeMaterialsOnly: event.target.checked })} />
          Only display materials for the active tab</label>
        {catalog.devMode && <nav aria-label="Inventory views">
          <button className={inventoryView === 'owned' ? 'active' : ''} onClick={() => setInventoryView('owned')}>Owned materials</button>
          <button className={inventoryView === 'materials' ? 'active' : ''} onClick={() => { setInventoryView('materials'); setSearch('') }}>Materials</button>
        </nav>}
        {inventoryView === 'owned' && <div className="owned-materials">
          {inventoryGroups.map(({ item, ids, name }) => {
            const required = ids.reduce((sum, id) => sum + (needed.get(id) ?? 0), 0)
            return <article className={`owned-material material-chip${required > 0 && owned(ids) >= required ? ' completed' : ''}${item.ahPrice === null ? ' missing-price' : ''}`} key={item.id}>
            <span className="material-chip-info"><InfoBubble label={`Sources for ${name}`}
              text={inventorySourceTooltip(catalog, ids)} /></span>
            <div className="material-chip-name"><ItemIcon id={item.id} /><span className="owned-name">{name}</span></div>
            <div className="material-chip-fields">
              <label>Owned<span className="owned-count">
                <NumberField label={item.id === 5300217 ? 'Obtained Obols' : `Owned ${name}`}
                  grouped value={owned(ids)} disabled={busy} onCommit={value => groupInventory(ids, value ?? 0)} />
                {workspace.activeMaterialsOnly && <span className="needed-quantity">/{format(ids.reduce((sum, id) => sum + (needed.get(id) ?? 0), 0))}</span>}
              </span></label>
              <label>Gold value<span className="chip-gold">
                <NumberField label={`Gold value ${name}`} grouped nullable={item.id !== 5300217}
                  value={item.id === 5300217 ? workspace.obolValue : item.ahPrice} disabled={busy}
                  onCommit={value => item.id === 5300217 ?
                    save({ ...workspace, obolValue: value ?? 0 }) :
                    void action(async () => { await window.soulLiberator!.setPrice(item.id, value) })} />
                <img className="gold-icon" src={goldIcon} alt="gold" />
                {item.ahPrice === null && missingPriceMarker([`Enter AH gold price for ${name}.`])}
              </span></label>
            </div>
          </article>})}
        </div>}
        {inventoryView === 'materials' && catalog.devMode && <section className="dev-materials">
          <div className="section-heading"><h2>Materials & sources</h2>
            <input aria-label="Search materials" placeholder="Search materials" value={search} onChange={e => setSearch(e.target.value)} /></div>
          <div className="table-scroll"><table><thead><tr><th>Material</th><th>AH gold / item</th><th>NPC / Obol / craft comparison</th><th>Sources / notes</th></tr></thead><tbody>
            {visibleItems.map(({ item, ids, name }) => <tr key={item.id}><td><ItemIcon id={item.id} />
              <strong>{name}</strong>{item.nameStatus !== 'resolved' && <small>Conflicting client names</small>}</td>
              <td>{item.auctionEligible ? <NumberField label={`AH price ${itemName(item.id)}`} value={item.ahPrice} grouped nullable disabled={busy}
                onCommit={v => void action(async () => { await window.soulLiberator!.setPrice(item.id, v); await load() })} />
                : <small>Not auction-eligible in inspected definitions</small>}</td>
              <td><span className="material-prices">{comparison(String(item.id))}</span></td>
              <td>{materialSources(ids, item.id, name, true)}</td></tr>)}
          </tbody></table></div>
          <details {...disclosure('exclusions')}><summary>Excluded sources ({exclusions.length}) / undo removals</summary>
            {exclusions.map(ex => <p key={ex.key}>{ex.key} / {ex.status} {ex.reason}
              <button disabled={busy} onClick={() => void action(async () => { await window.soulLiberator!.restoreSource(ex.key); await load() })}>Restore</button></p>)}
          </details>
        </section>}
        </div>
        <div className="inventory-resize" role="separator" aria-label="Resize inventory" aria-orientation="horizontal"
          tabIndex={0} onPointerDown={event => {
            if (event.button !== 0 || !inventoryPanel.current) return
            event.preventDefault()
            inventoryManuallySized.current = true
            inventoryDrag.current = { y: event.clientY, height: inventoryPanel.current.getBoundingClientRect().height }
            event.currentTarget.setPointerCapture(event.pointerId)
          }} onPointerMove={event => {
            if (!inventoryDrag.current || !inventoryPanel.current) return
            const panel = inventoryPanel.current
            const height = inventoryDrag.current.height + event.clientY - inventoryDrag.current.y
            panel.style.height = `${Math.max(parseFloat(getComputedStyle(panel).minHeight),
              Math.min(parseFloat(panel.style.maxHeight), height))}px`
          }} onPointerUp={() => { inventoryDrag.current = null }}
          onPointerCancel={() => { inventoryDrag.current = null }}
          onLostPointerCapture={() => { inventoryDrag.current = null }}
          onKeyDown={event => {
            if (!['ArrowUp', 'ArrowDown'].includes(event.key) || !inventoryPanel.current) return
            event.preventDefault()
            inventoryManuallySized.current = true
            const panel = inventoryPanel.current
            panel.style.height = `${Math.max(parseFloat(getComputedStyle(panel).minHeight),
              Math.min(parseFloat(panel.style.maxHeight), panel.getBoundingClientRect().height +
                (event.key === 'ArrowDown' ? 20 : -20)))}px`
          }} />
      </details>
      <nav className="tabs" aria-label="Crafting trackers">
        {workspace.plans.map(p => <TrackerTab key={p.id} plan={p} selected={active?.id === p.id} busy={busy}
          onSelect={() => { if (workspace.activeId !== p.id) save({ ...workspace, activeId: p.id }) }}
          onRemove={() => removeTab(p)}
          onRename={label => save({ ...workspace, plans: workspace.plans.map(tab => tab.id === p.id ? { ...tab, label } : tab) })} />)}
        <button className="icon-button" aria-label="Add tab" title="Add tab" disabled={busy} onClick={() => {
          const id = crypto.randomUUID()
          save({ ...workspace, activeId: id, plans: [...workspace.plans, {
            id, itemId: null, label: 'New tracker', quantity: 1,
            inventory: {}, overrides: {},
          }] })
        }}><img src={plusIcon} alt="" /></button>
      </nav>
      <div className="tab-content" key={active?.id}>
      {!active ? <section className="empty"><h2>Select a tracker tab</h2><p>Create or select a tab above.</p></section> : <>
        {active.itemId === null ? <section className="equipment-picker">
          <div className="section-heading"><div><h2>Choose equipment for this tab</h2>
            <p className="muted">Official Nexon renders, included locally. No internet required.
              Marionettes share the published pair render.</p></div>
            <input aria-label="Search Soul Liberator items" placeholder="Search equipment name" value={itemSearch} onChange={e => setItemSearch(e.target.value)} /></div>
          <div className="equipment-list">{catalog.items.filter(i => catalog.slIds.includes(i.id) &&
            i.name.toLowerCase().includes(itemSearch.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name)).map(item =>
            <button className="equipment-card" key={item.id} disabled={busy} onClick={() => {
              updatePlan({ ...active, itemId: item.id, label: item.name, inventory: {}, overrides: {} })
              setItemSearch('')
            }}><EquipmentArt id={item.id} /><span><strong>{item.name}</strong></span></button>)}</div>
          <p className="muted">Artwork: Nexon / Mabinogi. Source: {equipmentArtSource}</p>
        </section> : <>
        <section className="plan-title">
          <div className="equipment-heading"><ItemIcon id={active.itemId} />
          <h2>{itemName(active.itemId)}</h2>
          <button className="change-equipment" aria-label="Change equipment" title="Change equipment" disabled={busy} onClick={() => {
            confirmAction(() => {
              updatePlan({ ...active, itemId: null, label: 'New tracker', inventory: {}, overrides: {} })
            })
          }}><span style={{ maskImage: `url("${changeIcon}")` }} /></button></div>
        </section>
        {calculation?.error && <p className="error-banner" role="alert">{calculation.error}</p>}
        {result && <>
          <div className="metrics">
            <section className="gold-progress-summary">
              <div><small>GOLD REMAINING / TOTAL</small>
                <strong>{calculation?.goldProgress
                  ? `${format(calculation.goldProgress.remaining)}g / ${format(calculation.goldProgress.total)}g`
                  : 'Needs input'}{missingPriceMarker(calculation?.goldProgress?.missingPrices)}</strong></div>
              <div><small>PROGRESS</small>
                <strong>{calculation?.goldProgress?.percent === null || !calculation?.goldProgress
                  ? 'Needs input' : `${calculation.goldProgress.percent}%`}{missingPriceMarker(calculation?.goldProgress?.missingPrices)}</strong></div>
              <div className="framed-progress"><progress aria-label="Material gold progress"
                value={calculation?.goldProgress?.obtained ?? 0} max={calculation?.goldProgress?.total || 1} /></div>
              <small className="gold-spent">Spent: {calculation?.goldProgress
                ? `${format(calculation.goldProgress.obtained)}g` : 'Needs input'}{missingPriceMarker(calculation?.goldProgress?.missingPrices)}</small>
            </section>
            <section className="obol-balance"><small>OBOLS TOTAL − SPENT − HELD = REMAINING</small>
              <strong><span className="obol-total">{format(calculation?.inventoryObols?.total ?? 0)}</span>
                {' − '}<span className="obol-spent">{format(calculation?.inventoryObols?.spent ?? 0)}</span>
                {' − '}<span className="obol-held">{format(workspace.inventory[5300217] ?? 0)}</span>
                {' = '}<span className="obol-remaining">{format((calculation?.inventoryObols?.remaining ?? 0) -
                  (workspace.inventory[5300217] ?? 0))}</span></strong></section>
          </div>
          {result.unresolved.length > 0 && <details className="warning" {...disclosure(`warning:${active.id}`, true)}><summary>{result.unresolved.length} missing inputs - remaining cost is not complete</summary>
            <ul>{result.unresolved.map(s => <li key={s}>{baseItemName(s)}</li>)}</ul></details>}
        </>}
        <nav className="view-tabs" aria-label="Planner views">
          <button className="active">Crafting tree</button>
        </nav>
        {<section className="crafting-tree-section">
          <div className="section-heading"><h2>Acquisition & crafting tree</h2>
            <div className="tree-actions">
              <label className="auto-obol-toggle"><input type="checkbox" checked={active.autoApplyHeldObols ?? false}
                disabled={busy} onChange={event => updatePlan({ ...active, autoApplyHeldObols: event.target.checked })} />
                Auto-apply held Obols to Core / Essence</label>
              <button disabled={!result} onClick={() => setTreeExpanded(false)}>Collapse all</button>
              <button disabled={!result} onClick={() => setTreeExpanded(true)}>Expand all</button>
              <button disabled={busy} onClick={() => updatePlan({ ...active, overrides: {} })}>Reset all route overrides</button>
            </div></div>
          <p className="muted">Auto compares AH at every level, gold/Obol shops, and usable crafts. Expand rows for alternatives.</p>
          {result && tree(result.tree)}
        </section>}
      </>}
      </>}
      </div>
        {catalog.devMode && <>
          {sourceDraft && <dialog ref={sourceDialog} className="source-popout" aria-label="Edit material source"
            onCancel={event => { event.preventDefault(); if (!busy) setSourceDraft(null) }}>
            <form className="source-form"
            onSubmit={e => {
            e.preventDefault()
            void action(async () => {
              await window.soulLiberator!.saveSource(sourceDraft, replaceKey)
              setSourceDraft(null); setReplaceKey(null); await load()
            })
          }}>
            <h3>{replaceKey ? 'Replace auto source' : sourceDraft.manualId ? 'Edit manual source' : 'New source'}</h3>
            <p className="wide">{itemName(sourceDraft.itemId)}</p>
            <label>{sourceDraft.kind === 'mob_drop' ? 'Mob name' : 'Source name'}<input aria-label="Source name" required value={sourceDraft.name} onChange={e => setSourceDraft({ ...sourceDraft, name: e.target.value })} /></label>
            <label>Kind<select aria-label="Source type" value={sourceDraft.kind} onChange={e => {
              const kind = e.target.value
              if (kind === 'shop' || kind === 'reward' || kind === 'craft' || kind === 'mob_drop' || kind === 'other') setSourceDraft({
                ...sourceDraft, kind, currency: kind === 'shop' ? 'gold' : null,
                currencyItemId: null, price: null,
              })
            }}><option value="shop">Shop</option><option value="reward">Dungeon / mission reward</option>
              <option value="mob_drop">Mob drop</option><option value="craft">Craft</option><option value="other">Other</option></select></label>
            {sourceDraft.kind === 'shop' && <><label>Currency<select aria-label="Source currency" value={sourceDraft.currency ?? ''} onChange={e => setSourceDraft({
              ...sourceDraft, currency: e.target.value || null, currencyItemId: e.target.value === 'item' ? 5300217 : null,
              price: e.target.value ? sourceDraft.price : null,
            })}><option value="">Unknown</option><option value="gold">Gold</option><option value="item">Bri Leith Obols</option>
              <option value="ducats">Ducats</option></select></label>
            <label>Price per purchase<NumberField label="Source purchase price" nullable value={sourceDraft.price}
              onCommit={v => setSourceDraft({ ...sourceDraft, price: v })} /></label></>}
            <label>{sourceDraft.kind === 'shop' ? 'Items per purchase' : sourceDraft.kind === 'mob_drop' ? 'Items per drop (if known)' : 'Items per reward / craft'}<NumberField label="Source purchase quantity" min={1} nullable value={sourceDraft.quantity}
              onCommit={v => setSourceDraft({ ...sourceDraft, quantity: v })} /></label>
            <label className="wide">Evidence / restrictions / notes<textarea value={sourceDraft.notes} onChange={e => setSourceDraft({ ...sourceDraft, notes: e.target.value })} /></label>
            <button className="primary" disabled={busy} type="submit">Save to database</button>
            <button type="button" disabled={busy} onClick={() => setSourceDraft(null)}>Cancel</button>
          </form></dialog>}
        </>}
    </>}
    {confirmation && <dialog ref={confirmationDialog} className="confirmation-popout"
      aria-labelledby="confirmation-title" onCancel={event => { event.preventDefault(); setConfirmation(null) }}>
      <h2 id="confirmation-title">Are you sure?</h2>
      <div className="confirmation-actions">
        <button autoFocus onClick={() => setConfirmation(null)}>Cancel</button>
        <button className="primary" onClick={() => {
          setConfirmation(null)
          confirmation.accept()
        }}>Confirm</button>
      </div>
    </dialog>}
  </main>
}
