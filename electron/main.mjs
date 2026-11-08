import { app, BrowserWindow, dialog, ipcMain, nativeImage, screen } from 'electron'
import { resizedBounds, resizeEdges } from './window-resize.mjs'
import { fileURLToPath } from 'node:url'
import { inspectClientData } from './client-data.mjs'
import { PlannerStore, prepareUserDatabase } from './planner-store.mjs'
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { mkdirSync } from 'node:fs'

const development = process.env.SOUL_LIBERATOR_DEV === '1'
const smokeTest = process.argv.includes('--smoke-test')
const applicationDirectory = app.isPackaged ? path.dirname(app.getPath('exe')) :
  fileURLToPath(new URL('..', import.meta.url))
const runtimeDirectory = path.join(applicationDirectory, smokeTest ? '.smoke-data' : '.app-data')
try {
  mkdirSync(runtimeDirectory, { recursive: true })
  for (const name of ['temp', 'crash-dumps', 'logs']) mkdirSync(path.join(runtimeDirectory, name), { recursive: true })
  app.setPath('userData', runtimeDirectory)
  app.setPath('sessionData', runtimeDirectory)
  app.setPath('temp', path.join(runtimeDirectory, 'temp'))
  app.setPath('crashDumps', path.join(runtimeDirectory, 'crash-dumps'))
  app.setAppLogsPath(path.join(runtimeDirectory, 'logs'))
  process.env.TEMP = app.getPath('temp')
  process.env.TMP = app.getPath('temp')
} catch (error) {
  console.error('Local app storage unavailable:', error)
  dialog.showErrorBox('Local app storage unavailable', `${String(error)}\nMove the app folder to a writable location.`)
  app.exit(1)
}
const developmentUrl = 'http://127.0.0.1:5174'
const indexUrl = new URL('../dist/index.html', import.meta.url).href
let store
let smokeFolder

function setCustomBounds(window, bounds) {
  // Restore explicit constraints after Windows locks a non-resizable window to its current size.
  window.setMinimumSize(700, 540)
  window.setMaximumSize(0, 0)
  window.setBounds(bounds)
}

async function createWindow() {
  let programIcon
  try {
    programIcon = nativeImage.createFromPath(fileURLToPath(new URL(
      `../${development ? 'public' : 'dist'}/item-icons/program-obol.png`, import.meta.url)))
    programIcon = programIcon.resize({ width: 256, height: 256, quality: 'best' })
    if (programIcon.isEmpty()) throw new Error('Obol program icon could not be decoded.')
  } catch (error) {
    if (smokeTest) throw error
    console.error('Obol program icon unavailable:', error)
    dialog.showErrorBox('Obol program icon unavailable',
      `${error instanceof Error ? error.message : String(error)}\nThe planner will open with the default desktop icon. Restore the bundled item icons.`)
  }
  const size = smokeTest ? { width: 1440, height: 940 } : store.windowSize()
  const workArea = screen.getPrimaryDisplay().workAreaSize
  const window = new BrowserWindow({
    width: Math.max(700, Math.min(size.width, workArea.width)),
    height: Math.max(540, Math.min(size.height, workArea.height)),
    minWidth: 700,
    minHeight: 540,
    backgroundColor: '#00000000',
    transparent: true,
    resizable: false,
    show: !smokeTest,
    autoHideMenuBar: true,
    frame: false,
    icon: programIcon,
    webPreferences: {
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  if (!smokeTest) window.on('close', event => {
    try {
      store.saveWindowSize(window.getBounds())
    } catch (error) {
      event.preventDefault()
      console.error('Window size save failed:', error)
      dialog.showErrorBox('Window size save failed', String(error))
    }
  })

  const blockedRequests = []
  if (smokeTest) {
    window.webContents.on('console-message', event => {
      if (event.level === 'error') console.error('Renderer smoke error:', event.message)
    })
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url)
      const external = ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) &&
        !(development && url.hostname === '127.0.0.1' && url.port === '5174')
      if (external) blockedRequests.push(details.url)
      callback({ cancel: external })
    })
  }

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== (development ? `${developmentUrl}/` : indexUrl)) {
      event.preventDefault()
    }
  })

  await window.loadURL(development ? developmentUrl : indexUrl)

  if (smokeTest) {
    window.show()
    window.focus()
    const result = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 20000;
        const timer = setInterval(() => {
          const status = document.querySelector('[data-planner-status]');
          if (status && status.dataset.plannerStatus !== 'loading') {
            clearInterval(timer);
            if (status.dataset.plannerStatus === 'ready') {
              resolve({ title: document.title, status: 'Planner ready' });
            } else {
              reject(new Error(document.body.innerText));
            }
          } else if (Date.now() > deadline) {
            clearInterval(timer);
            reject(new Error('Renderer did not finish planner loading.'));
          }
        }, 50);
      })
    `)
    result.staticIcons = await window.webContents.executeJavaScript(`
      (async () => {
        if ('itemIcon' in window.soulLiberator || 'programIcon' in window.soulLiberator) {
          throw new Error('Runtime icon decoding bridge remains.');
        }
        const loaded = await window.soulLiberator.loadPlanner();
        const start = performance.now();
        await Promise.all([...loaded.catalog.items.map(item => item.id), 'program-obol'].map(id =>
          new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => image.naturalWidth > 0 ? resolve() : reject(new Error('Empty bundled icon: ' + id));
            image.onerror = () => reject(new Error('Missing bundled icon: ' + id));
            image.src = './item-icons/' + id + '.png';
          })));
        return { count: loaded.catalog.items.length + 1, loadMilliseconds: Math.round(performance.now() - start) };
      })()
    `)
    await window.webContents.executeJavaScript(`
      (async () => {
        while (!document.querySelector('[aria-label="Obol price"]')) await new Promise(resolve => setTimeout(resolve, 30));
        const inventory = document.querySelector('.global-inventory');
        if (!inventory.open) {
          inventory.querySelector('summary').click();
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        const field = document.querySelector('[aria-label="Obol price"]');
        if (field.value !== '600,000') throw new Error('Obol price is not grouped.');
        const gear = document.querySelector('[aria-label="Settings"]');
        if (document.body.textContent.includes('Saved to SQLite')) throw new Error('Persistent save notice must remain removed.');
        const box = document.querySelector('.obol-control');
        const coin = box.querySelector('.gold-icon');
        const header = document.querySelector('.app-header');
        if (getComputedStyle(header).backgroundColor !== 'rgba(0, 0, 0, 0)' ||
          getComputedStyle(document.querySelector('main')).paddingTop !== '20px' ||
          Math.abs(document.querySelector('.window-title').getBoundingClientRect().top - innerHeight * .12 - 25) > 2 ||
          getComputedStyle(header).getPropertyValue('-webkit-app-region') !== 'drag') {
          throw new Error('Header must trim top dead space, reveal splash and retain controls/dragging.');
        }
        if (getComputedStyle(gear).borderTopWidth !== '0px' ||
          !document.querySelector('.global-inventory summary').contains(box) ||
          !box.querySelector('.obol-amount').contains(coin) ||
          getComputedStyle(document.querySelector('.obol-label')).textAlign !== 'center' ||
          getComputedStyle(field).textAlign !== 'right') {
          throw new Error('Compact corner gear/Obol price layout regressed.');
        }
        window.initialObolWidth = box.getBoundingClientRect().width;
        field.blur();
        const firstClick = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
        field.dispatchEvent(firstClick);
        if (!firstClick.defaultPrevented || document.activeElement !== field ||
          field.selectionStart !== 0 || field.selectionEnd !== field.value.length) {
          throw new Error('First click must select all grouped input text, including commas.');
        }
        field.setSelectionRange(2, 2);
        const secondClick = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
        field.dispatchEvent(secondClick);
        if (secondClick.defaultPrevented || field.selectionStart !== 2 || field.selectionEnd !== 2) {
          throw new Error('Already-focused input must retain normal caret interaction.');
        }
        field.blur(); field.focus();
        if (field.selectionStart !== 0 || field.selectionEnd !== field.value.length) {
          throw new Error('Keyboard focus must select all input text.');
        }
        window.initialOwnedObolWidth = document.querySelector('.obol-owned-chip').getBoundingClientRect().width;
      })()
    `)
    for (const keyCode of '123456789') window.webContents.sendInputEvent({ type: 'char', keyCode })
    await new Promise(resolve => setTimeout(resolve, 100))
    await window.webContents.executeJavaScript(`
      (() => {
      const field = document.querySelector('[aria-label="Obol price"]');
      if (field.value !== '123,456,789' || field.selectionStart !== 11) throw new Error('Live grouping/caret failed: ' + field.value);
      if (document.querySelector('.obol-control').getBoundingClientRect().width <= window.initialObolWidth) {
        throw new Error('Obol price box did not grow with entered value.');
      }
      field.setSelectionRange(4, 7);
      })()
    `)
    window.webContents.sendInputEvent({ type: 'char', keyCode: '9' })
    await new Promise(resolve => setTimeout(resolve, 100))
    await window.webContents.executeJavaScript(`
      (() => {
      const field = document.querySelector('[aria-label="Obol price"]');
      if (field.value !== '1,239,789') throw new Error('Highlighted digit replacement failed: ' + field.value);
      field.setSelectionRange(6, 6);
      })()
    `)
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
    await new Promise(resolve => setTimeout(resolve, 100))
    await window.webContents.executeJavaScript(`
      (() => {
      const field = document.querySelector('[aria-label="Obol price"]');
      if (field.value !== '123,789') throw new Error('Backspace got stuck at separator: ' + field.value);
      field.setSelectionRange(3, 3);
      })()
    `)
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Delete' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Delete' })
    await new Promise(resolve => setTimeout(resolve, 100))
    await window.webContents.executeJavaScript(`
      (() => {
      const field = document.querySelector('[aria-label="Obol price"]');
      if (field.value !== '12,389') throw new Error('Delete got stuck at separator: ' + field.value);
      field.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      if (field.selectionStart !== 0 || field.selectionEnd !== field.value.length) throw new Error('Comma split double-click highlighting.');
      })()
    `)
    for (const keyCode of '600000') window.webContents.sendInputEvent({ type: 'char', keyCode })
    await new Promise(resolve => setTimeout(resolve, 100))
    await window.webContents.executeJavaScript(`document.querySelector('[aria-label="Obol price"]').blur()`)
    await window.webContents.executeJavaScript(`
      (async () => {
        const waitFor = async (predicate) => {
          const deadline = Date.now() + 10000;
          while (!(await predicate())) {
            if (Date.now() > deadline) throw new Error('Planner UI smoke timed out: ' + document.body.innerText);
            await new Promise(resolve => setTimeout(resolve, 30));
          }
        };
        await waitFor(() => document.querySelector('[data-planner-ready]'));
        if (document.querySelector('.window-title')?.textContent.trim() !== 'Soul Liberator Calculator' ||
          getComputedStyle(document.querySelector('.app-header')).getPropertyValue('-webkit-app-region') !== 'drag' ||
          getComputedStyle(document.querySelector('.window-controls')).getPropertyValue('-webkit-app-region') !== 'no-drag') {
          throw new Error('Custom draggable header/window controls regressed.');
        }
        if (document.querySelector('.window-title .item-icon') || document.querySelector('.app-header .badge') ||
          Math.abs(document.querySelector('.window-title').getBoundingClientRect().left +
            document.querySelector('.window-title').getBoundingClientRect().width / 2 - innerWidth / 2) > 2) {
          throw new Error('Title must be centered without Obol or diagnostic badges.');
        }
        await waitFor(() => document.querySelector('.equipment-card'));
        if (document.querySelectorAll('.equipment-card').length !== 29) throw new Error('Missing full SL equipment list.');
        if ([...document.querySelectorAll('.equipment-card')].some(card => /#\\d+/.test(card.textContent))) {
          throw new Error('Equipment picker must not display item IDs.');
        }
        if (document.querySelectorAll('.equipment-art img').length !== 29) throw new Error('Missing official equipment renders.');
        if (![...document.querySelectorAll('.equipment-art img')].every(img =>
          img.src.startsWith(new URL('./equipment-art/', location.href).href))) {
          throw new Error('Selection must use bundled local artwork.');
        }
        document.querySelectorAll('.equipment-art img').forEach(img => img.loading = 'eager');
        await waitFor(() => [...document.querySelectorAll('.equipment-art img')].every(img => img.complete && img.naturalWidth > 0));
        document.querySelector('.equipment-art img').dispatchEvent(new Event('error'));
        await waitFor(() => document.querySelector('.equipment-art .art-error'));
        await waitFor(() => document.querySelector('.equipment-art .item-icon img')?.naturalWidth > 0);
        if (document.querySelector('.metrics') || document.querySelector('.view-tabs')) throw new Error('Empty tab displays a calculation.');
        [...document.querySelectorAll('.equipment-card')].find(b => b.textContent.includes('Soul Liberator Staff')).click();
        await waitFor(() => document.querySelector('.tree-node'));
        if (document.querySelector('.tree-node summary').textContent.includes('(Not tradable)')) {
          throw new Error('Tree display retained tradability suffix.');
        }
        if (!document.querySelector('.tree-node .selected-unit-price') ||
          ![...document.querySelectorAll('.tree-node .material-prices')].some(prices => prices.textContent.includes('per craft'))) {
          throw new Error('Missing inline AH/craft comparison.');
        }
        await waitFor(() => document.querySelector('.workspace-splash img')?.naturalWidth === 1700);
        await waitFor(() => document.querySelector('.tabs .item-icon img')?.naturalWidth > 0 &&
          document.querySelector('.plan-title .item-icon img')?.naturalWidth > 0);
        if (document.querySelector('.tabs .item-icon img').src.startsWith('https:')) throw new Error('Compact UI must retain client icons.');
        const loaded = await window.soulLiberator.loadPlanner();
        if (loaded.workspace.plans.length !== 1 || loaded.workspace.obolValue !== 600000) {
          throw new Error('Tracker/default Obol value did not persist.');
        }
        if (document.querySelectorAll('.metrics section').length !== 2 || document.querySelector('.metrics p')) {
          throw new Error('Currency/progress summaries must be combined without descriptions.');
        }
        const relevant = new Set([5300217,
          ...loaded.catalog.memberships.filter(m => m.slId === loaded.workspace.plans[0].itemId).map(m => m.itemId)]);
        relevant.delete(loaded.workspace.plans[0].itemId);
        const aliases = new Set(loaded.catalog.items.filter(item => relevant.has(item.id))
          .map(item => item.name.replace(/\\s*\\((not tradable|event)\\)/gi, '')));
        const displayedMaterials = document.querySelectorAll('.owned-material').length;
        if (displayedMaterials > aliases.size ||
          [...document.querySelectorAll('.owned-name')].some(label => label.querySelector('small') || label.textContent.includes('#')) ||
          document.querySelector('.equipment-heading p') || !document.querySelector('[aria-label="Change equipment"]')) {
          throw new Error('Owned materials/equipment header incomplete.');
        }
        if ([...document.querySelectorAll('.owned-name')].some(label => label.textContent === 'Soul Liberator Staff')) {
          throw new Error('Finished equipment must not appear in the material list.');
        }
        await waitFor(() => [...document.querySelectorAll('.owned-material .item-icon')].every(icon =>
          icon.querySelector('img')?.complete && icon.querySelector('img')?.naturalWidth > 0));
        for (const icon of document.querySelectorAll('.owned-material .item-icon img')) {
          const style = getComputedStyle(icon);
          if (style.filter !== 'none' || style.imageRendering !== 'pixelated' ||
            !icon.src.includes('/item-icons/') || !icon.src.endsWith('.png')) {
            throw new Error('Inventory icons must use pre-rendered local PNGs without double filtering.');
          }
        }
        const inventoryPanel = document.querySelector('.global-inventory');
        const inventoryAlpha = color => color.startsWith('rgba(') && Number(color.split(',').at(-1).replace(')', '')) < 1;
        if (!inventoryAlpha(getComputedStyle(inventoryPanel.querySelector('summary')).backgroundColor) ||
          !inventoryAlpha(getComputedStyle(inventoryPanel.querySelector('.inventory-resize')).backgroundColor)) {
          throw new Error('Inventory header and resize bar must be translucent, including hover states.');
        }
        const metricSections = [...document.querySelectorAll('.metrics section')];
        const obolMetric = document.querySelector('.obol-balance');
        const remainingDisplay = obolMetric.querySelector('.obol-remaining').textContent;
        if (!inventoryPanel.querySelector('.obol-owned-chip .owned-count').textContent.endsWith('/' + remainingDisplay) ||
          !document.querySelector('.gold-progress-summary progress')) {
          throw new Error('Obol displays must agree and percentage must use gold-value accounting.');
        }
        const rootTree = document.querySelector('.sl-tree-root > details');
        rootTree.querySelector('summary').click();
        if (rootTree.open || document.querySelector('.condensed-ingredients').getBoundingClientRect().height === 0 ||
          document.querySelectorAll('.condensed-ingredient').length !== 8) {
          throw new Error('Collapsed SL root must retain all direct ingredients in condensed form.');
        }
        rootTree.querySelector('summary').click();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const materialBranch = rootTree.querySelector('.node-body .tree-node');
        const branchSummary = materialBranch.querySelector('summary');
        if (!branchSummary.querySelector('.route-choices') || branchSummary.querySelector('.material-prices')) {
          throw new Error('Compact routes must stay beside names; price fields belong inside expanded content.');
        }
        if (materialBranch.open) branchSummary.click();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (!branchSummary.querySelector('.route-choices').checkVisibility() ||
          materialBranch.querySelector('.material-prices').checkVisibility()) {
          throw new Error('Collapsed branches must retain route choices but hide price fields.');
        }
        branchSummary.click();
        if (document.querySelector('.node-controls select') ||
          rootTree.querySelector(':scope > .node-body > .route-choices') ||
          rootTree.querySelector(':scope > summary > .material-prices') ||
          !document.querySelector('.route-choices input[type="radio"]') ||
          [...document.querySelectorAll('button')].some(button => button.textContent.includes('Edit obtained / AH price / sources'))) {
          throw new Error('Route choices must be compact radios without duplicate navigation buttons.');
        }
        const titleChip = document.querySelector('.plan-title').getBoundingClientRect();
        if (titleChip.height > 80 || titleChip.width > 500 ||
          !document.querySelector('.tab-delete img')) {
          throw new Error('Equipment heading must be compact and delete must preserve the supplied colored X image.');
        }
        const inventoryFilter = document.querySelector('.inventory-filter input');
        const content = document.querySelector('.tab-content');
        const tabs = document.querySelector('.tabs');
        const inventoryBody = inventoryPanel.querySelector('.inventory-body');
        const rowHeight = inventoryPanel.querySelector('.material-chip').getBoundingClientRect().height;
        const filter = inventoryPanel.querySelector('.inventory-filter');
        const filterStyle = getComputedStyle(filter);
        const gridViewport = inventoryBody.clientHeight - filter.getBoundingClientRect().height -
          parseFloat(filterStyle.marginTop) - parseFloat(filterStyle.marginBottom) - 8;
        if (Math.abs(gridViewport - (rowHeight * 2.5 + 12)) > 3 ||
          getComputedStyle(inventoryBody).overflowY !== 'auto') {
          throw new Error('Default inventory must display two and a half material rows: ' +
            gridViewport + ' expected ' + (rowHeight * 2.5 + 12));
        }
        if (!inventoryFilter.checked || inventoryPanel.getBoundingClientRect().bottom > tabs.getBoundingClientRect().top ||
          document.querySelectorAll('.needed-quantity').length !== displayedMaterials ||
          getComputedStyle(content).overflowY !== 'auto' || getComputedStyle(document.body).overflow !== 'hidden') {
          throw new Error('Global inventory/filter or fixed tabs/scroll container incomplete.');
        }
        if ([...document.querySelectorAll('.needed-quantity')].some(label => label.textContent === '/0') ||
          !document.querySelector('.global-inventory summary [aria-label="Obtained Obols"]') ||
          !document.querySelector('.obol-chips [aria-label="Obtained Obols"]')) {
          throw new Error('Selected-route filter must hide zero needs and keep Obols beside their price.');
        }
        const tabTop = tabs.getBoundingClientRect().top;
        content.scrollTop = 200;
        if (Math.abs(tabs.getBoundingClientRect().top - tabTop) > 1) throw new Error('Tabs scrolled with contents.');
        content.scrollTop = 0;
        if (document.querySelector('.toolbar') ||
          document.querySelector('.tabs > :last-child')?.getAttribute('aria-label') !== 'Add tab') {
          throw new Error('Add tab must follow trackers without a separate toolbar.');
        }
        document.querySelector('[aria-label="Settings"]').click();
        await waitFor(() => [...document.querySelectorAll('button')].some(b => b.textContent.startsWith('Undo (') && !b.disabled));
        [...document.querySelectorAll('button')].find(b => b.textContent.startsWith('Undo (')).click();
        await waitFor(() => document.querySelector('.equipment-card'));
        await waitFor(() => [...document.querySelectorAll('button')].some(b => b.textContent.startsWith('Redo (') && !b.disabled));
        [...document.querySelectorAll('button')].find(b => b.textContent.startsWith('Redo (')).click();
        await waitFor(() => document.querySelector('.tree-node'));
        await waitFor(() => [...document.querySelectorAll('button')].some(b => b.textContent.startsWith('Undo (') && !b.disabled));
        const shortcut = async (key, ctrlKey = true, altKey = false, shiftKey = false) => {
          await new Promise(resolve => setTimeout(resolve, 50));
          document.body.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey, altKey, shiftKey, bubbles: true, cancelable: true }));
        };
        const nameInput = document.querySelector('[aria-label="Obtained Obols"]');
        const textUndo = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
        nameInput.dispatchEvent(textUndo);
        if (textUndo.defaultPrevented) throw new Error('App history intercepted native text undo.');
        await shortcut('z');
        await waitFor(() => document.querySelector('.equipment-card'));
        await waitFor(() => [...document.querySelectorAll('button')].some(b => b.textContent.startsWith('Redo (') && !b.disabled));
        await shortcut('y');
        await waitFor(() => document.querySelector('.tree-node'));
        await waitFor(() => [...document.querySelectorAll('button')].some(b => b.textContent.startsWith('Undo (') && !b.disabled));
        await waitFor(() => document.querySelector('[aria-label="Undo shortcut"]'));
        const shortcutField = document.querySelector('[aria-label="Undo shortcut"]');
        shortcutField.focus();
        if (shortcutField.selectionStart !== 0 || shortcutField.selectionEnd !== shortcutField.value.length) {
          throw new Error('Plain text fields must also select their entire current value.');
        }
        shortcutField.blur();
        const setInput = (label, value) => {
          const input = document.querySelector('[aria-label="' + label + '"]');
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        };
        setInput('Undo shortcut', 'Alt+Shift+Z');
        setInput('Redo shortcut', 'Ctrl+Shift+Z');
        await new Promise(resolve => setTimeout(resolve, 50));
        [...document.querySelectorAll('button')].find(b => b.textContent === 'Save hotkeys').click();
        await waitFor(() => [...document.querySelectorAll('button')].some(b => b.textContent === 'Undo (Alt+Shift+Z)' && !b.disabled));
        await shortcut('z', false, true, true);
        await waitFor(() => document.querySelector('.equipment-card'));
        await waitFor(() => [...document.querySelectorAll('button')].some(b => b.textContent === 'Redo (Ctrl+Shift+Z)' && !b.disabled));
        await shortcut('z', true, false, true);
        await waitFor(() => document.querySelector('.tree-node'));
        await waitFor(() => !document.querySelector('[aria-label="Obtained Obols"]').disabled);
        document.querySelector('[aria-label="Close settings"]')?.click();
        [...document.querySelectorAll('button')].find(b => b.textContent === 'Close settings')?.click();
        if (document.querySelectorAll('.material-chip-fields').length !== displayedMaterials ||
          document.querySelectorAll('.chip-gold input').length !== displayedMaterials) throw new Error('Material chip fields incomplete.');
        if (document.querySelector('.inventory-heading').textContent !== 'Inventory' ||
          document.querySelector('.global-inventory p.muted')) {
          throw new Error('Inventory heading/copy must remain compact.');
        }
        for (const chip of document.querySelectorAll('.material-chip')) {
          if (chip.getBoundingClientRect().height >= 100 ||
            [...chip.querySelectorAll('input')].some(input =>
              input.getBoundingClientRect().right > chip.getBoundingClientRect().right)) {
            throw new Error('Compact material chips must fit their inputs without overflow.');
          }
        }
        setInput('Gold value Bri Leith Core', '765432');
        await new Promise(resolve => setTimeout(resolve, 50));
        document.querySelector('[aria-label="Gold value Bri Leith Core"]').focus();
        document.querySelector('[aria-label="Gold value Bri Leith Core"]').blur();
        await waitFor(async () => (await window.soulLiberator.loadPlanner()).catalog.items.find(item => item.id === 5100303).ahPrice === 765432);
        await waitFor(() => !document.querySelector('.inventory-filter input').disabled);
        if (${development}) {
          [...document.querySelectorAll('button')].find(button => button.textContent === 'Materials').click();
          await waitFor(() => document.querySelector('[aria-label="AH price Bri Leith Core"]')?.value === '765,432');
        }
        [...document.querySelectorAll('button')].find(button => button.textContent === 'Crafting tree').click();
        setInput('Obtained Obols', '1234');
        await new Promise(resolve => setTimeout(resolve, 50));
        if (document.querySelector('.obol-owned-chip').getBoundingClientRect().width <= window.initialOwnedObolWidth) {
          throw new Error('Owned Obol chip must grow to fit the grouped count.');
        }
        document.querySelector('[aria-label="Obtained Obols"]').focus();
        document.querySelector('[aria-label="Obtained Obols"]').blur();
        await waitFor(async () => (await window.soulLiberator.loadPlanner()).workspace.inventory[5300217] === 1234);
        await waitFor(() => !document.querySelector('.inventory-filter input').disabled);
        const obolNumber = name => Number(document.querySelector('.obol-' + name).textContent.replace(/,/g, ''));
        const remainingObolValue = obolNumber('total') - obolNumber('spent');
        if (obolNumber('held') !== 1234 || obolNumber('remaining') !== remainingObolValue - 1234) {
          throw new Error('Obol balance must show Total minus actual Spent minus Held equals Remaining.');
        }
        if (!document.querySelector('.obol-owned-chip').textContent.includes('Obols held') ||
          !document.querySelector('.obol-owned-chip .owned-count').textContent.endsWith('/' +
            remainingObolValue.toLocaleString('en-US'))) {
          throw new Error('Obols held denominator must credit materials, not held currency.');
        }
        const goldSummary = document.querySelector('.gold-progress-summary');
        if (goldSummary.querySelector('small').textContent !== 'GOLD REMAINING / TOTAL' ||
          !goldSummary.textContent.includes('PROGRESS') || !goldSummary.querySelector('.gold-spent') ||
          !goldSummary.querySelector('strong').textContent.includes('g / ')) {
          throw new Error('Gold summary must show remaining/total, progress and small spent value.');
        }
        document.querySelector('.inventory-filter input').click();
        await waitFor(() => !document.querySelector('.inventory-filter input').checked &&
          !document.querySelector('.inventory-filter input').disabled);
        if (document.querySelector('.needed-quantity') || document.querySelectorAll('.owned-material').length <= aliases.size) {
          throw new Error('Unfiltered global inventory must show all materials without needed suffixes.');
        }
        if ([...document.querySelectorAll('.owned-name')].some(label => label.textContent.includes('임시'))) {
          throw new Error('Unused test wool remains in global material chips.');
        }
        document.querySelector('.inventory-filter input').click();
        await waitFor(() => document.querySelector('.inventory-filter input').checked &&
          !document.querySelector('.inventory-filter input').disabled);
        const expandedHeight = inventoryPanel.getBoundingClientRect().height;
        inventoryPanel.querySelector('summary').click();
        if (inventoryPanel.open || inventoryPanel.getBoundingClientRect().height >= expandedHeight) throw new Error('Inventory collapse failed.');
        const collapsedObols = inventoryPanel.querySelector('[aria-label="Obtained Obols"]');
        if (collapsedObols.getBoundingClientRect().height === 0) throw new Error('Collapsed inventory hid Obol controls.');
        if (getComputedStyle(inventoryPanel.querySelector('.inventory-disclosure')).transform !== 'none') {
          throw new Error('Collapsed inventory must show the downward disclosure icon.');
        }
        collapsedObols.click();
        if (inventoryPanel.open) throw new Error('Editing collapsed Obols must not expand inventory.');
        inventoryPanel.querySelector('summary').click();
        if (getComputedStyle(inventoryPanel.querySelector('.inventory-disclosure')).transform === 'none') {
          throw new Error('Expanded inventory must invert the disclosure icon.');
        }
        document.querySelector('[aria-label="Add tab"]').click();
        await waitFor(() => document.querySelector('.equipment-card'));
        if (document.querySelector('.workspace-splash')) throw new Error('Blank tab retained previous splash art.');
        await waitFor(() => !document.querySelector('.equipment-card').disabled);
        [...document.querySelectorAll('.equipment-card')].find(b => b.textContent.includes('Soul Liberator Lyre')).click();
        await waitFor(() => document.querySelector('.workspace-splash img')?.naturalWidth === 700);
        if (document.querySelector('[aria-label="Obtained Obols"]').value !== '1,234') {
          throw new Error('New tracker did not retain global inventory.');
        }
        await waitFor(() => !document.querySelector('.tabs button').disabled);
        [...document.querySelectorAll('.tabs button')].find(b => b.textContent.includes('Soul Liberator Staff')).click();
        await waitFor(() => document.querySelector('.workspace-splash img')?.naturalWidth === 1700);
        document.querySelector('.workspace-splash img').dispatchEvent(new Event('error'));
        await waitFor(() => document.querySelector('main > .art-error[role="status"]'));
        if (!document.querySelector('.tree-node')) throw new Error('Artwork failure removed planner.');
        if (${development}) {
          [...document.querySelectorAll('button')].find(b => b.textContent === 'Materials').click();
          await waitFor(() => document.querySelector('table tbody tr'));
        } else if ([...document.querySelectorAll('button')].some(b => b.textContent === 'Materials') ||
          document.querySelector('.source-add')) {
          throw new Error('Production must hide the development Materials/source editor.');
        }
        const infoButton = document.querySelector('.info-bubble');
        for (let ancestor = infoButton.parentElement; ancestor; ancestor = ancestor.parentElement) {
          if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
        }
        const infoPanel = document.getElementById(infoButton.getAttribute('aria-controls'));
        const originalInfo = infoPanel.textContent;
        infoPanel.textContent = Array(150).fill(originalInfo).join('\\n');
        infoButton.click();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (!infoPanel.matches(':popover-open') || getComputedStyle(infoPanel).overflowY !== 'auto') {
          throw new Error('Information must open in a scrollable top-layer popout.');
        }
        infoPanel.scrollTop = 100;
        if (infoPanel.scrollTop === 0) throw new Error('Long information must scroll instead of being cut off.');
        infoPanel.hidePopover();
        infoPanel.textContent = originalInfo;
        if ([...document.querySelectorAll('th')].some(header => header.textContent === 'Obtained in this tab') ||
          [...document.querySelectorAll('.inline-price strong')].some(price => /\\d g/.test(price.textContent)) ||
          ![...document.querySelectorAll('.inline-price small')].some(label => /\\d+ Obols \\/ item/.test(label.textContent))) {
          throw new Error('Material table must omit duplicate obtained fields and display actual Obol units with compact gold suffix.');
        }
        if (${development} && document.querySelectorAll('table tbody tr').length < 20) throw new Error('Material list incomplete.');
        if (document.querySelector('.sl-tree-root > .tree-node > .node-body > .friendly-sources') ||
          !document.querySelector('.sl-tree-root > .tree-node > .node-body .tree-node .friendly-sources')) {
          throw new Error('Soul Liberator root must omit sources while material sources remain available.');
        }
        for (const sources of document.querySelectorAll('.friendly-sources')) {
          if (/Unresolved content|Reward pool|drop_probability_and_live_availability_unknown|client_table|Hard: Feth Fiada/.test(sources.textContent)) {
            throw new Error('User-facing sources must omit unresolved IDs and provenance codes.');
          }
        }
        if ([...document.querySelectorAll('table tbody tr td:first-child')].some(td => /\\(not tradable\\)/i.test(td.textContent))) {
          throw new Error('Material name retained tradability suffix.');
        }
        if (![...document.querySelectorAll('.material-prices')].some(p => p.textContent.includes('Obols / item'))) {
          throw new Error('Missing material Obol comparisons.');
        }
        if (${development}) {
          if ([...document.querySelectorAll('button')].some(b => b.textContent === 'Dev: item sources')) {
            throw new Error('Source editing must be integrated into materials.');
          }
          await waitFor(() => document.querySelector('.source-add:not(:disabled)'));
          document.querySelector('.source-add').click();
          await waitFor(() => document.querySelector('[aria-label="Source name"]'));
          const currencyField = document.querySelector('[aria-label="Source currency"]');
          if (![...currencyField.options].some(option => option.value === 'ducats')) {
            throw new Error('Shop currency must offer Ducats.');
          }
          if (![...document.querySelectorAll('.info-popout')].some(bubble => bubble.textContent.includes(' x '))) {
            throw new Error('Craft sources must expose recorded recipes in information tooltips.');
          }
          const input = document.querySelector('[aria-label="Source name"]');
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Desktop smoke vendor');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise(resolve => setTimeout(resolve, 50));
          [...document.querySelectorAll('button')].find(b => b.textContent === 'Save to database').click();
          await waitFor(() => !document.querySelector('.source-form'));
          const edited = await window.soulLiberator.loadPlanner();
          if (!edited.catalog.sources.some(s => s.name === 'Desktop smoke vendor' && s.origin === 'manual')) {
            throw new Error('Dev source form failed to write SQLite.');
          }
          const created = edited.catalog.sources.find(s => s.name === 'Desktop smoke vendor');
          for (const details of document.querySelectorAll('.friendly-sources')) details.open = true;
          const editButton = document.querySelector('[aria-label^="Edit Desktop smoke vendor"]');
          if (!editButton) throw new Error('New source must appear in its material row.');
          editButton.click();
          await waitFor(() => document.querySelector('dialog[open] [aria-label="Source name"]'));
          const kindField = document.querySelector('[aria-label="Source type"]');
          kindField.value = 'mob_drop';
          kindField.dispatchEvent(new Event('change', { bubbles: true }));
          await waitFor(() => !document.querySelector('[aria-label="Source purchase price"]'));
          if (!document.querySelector('[aria-label="Source name"]').parentElement.textContent.includes('Mob name')) {
            throw new Error('Mob drop form must request a mob name without purchase fields.');
          }
          if (document.querySelector('[aria-label="Source name"]').value !== 'Desktop smoke vendor') {
            throw new Error('Integrated source editing lost source fields.');
          }
          [...document.querySelectorAll('dialog button')].find(b => b.textContent === 'Save to database').click();
          await waitFor(async () => (await window.soulLiberator.loadPlanner()).catalog.sources.find(s => s.key === created.key)?.kind === 'mob_drop');
          await waitFor(() => !document.querySelector('dialog') && !document.querySelector('.source-add')?.disabled);
          for (const details of document.querySelectorAll('.friendly-sources')) details.open = true;
          if (!document.querySelector('.friendly-sources').closest('table').textContent.includes('Mob drop: Desktop smoke vendor')) {
            throw new Error('Mob drop source must retain its type in the material list.');
          }
          const removeButton = document.querySelector('[aria-label^="Remove Mob drop: Desktop smoke vendor"]');
          if (removeButton.textContent !== '-') throw new Error('Source remove control must be a minus.');
          removeButton.click();
          await waitFor(() => document.querySelector('.confirmation-popout[open]'));
          [...document.querySelectorAll('.confirmation-popout button')].find(button => button.textContent === 'Confirm').click();
          await waitFor(async () => !(await window.soulLiberator.loadPlanner()).catalog.sources.some(s => s.key === created.key));
          await waitFor(() => !document.querySelector('.source-add')?.disabled);
          if (parseFloat(getComputedStyle(document.querySelector('.tab-content')).borderTopWidth) <= 0) {
            throw new Error('Tab content must have its subtle border.');
          }
        }
        [...document.querySelectorAll('button')].find(button => button.textContent === 'Crafting tree').click();
        await waitFor(() => document.querySelector('.selected-unit-price'));
        if (document.querySelector('.diagnostics') || document.querySelector('footer')) {
          throw new Error('Source diagnostics and provenance footer must be absent.');
        }
        if (getComputedStyle(document.querySelector('.tab-content')).backgroundColor !== 'rgba(0, 0, 0, 0)') {
          throw new Error('Outer tab container must remain transparent so splash artwork is visible.');
        }
        if (getComputedStyle(document.querySelector('.crafting-tree-section')).backgroundColor !== 'rgba(19, 43, 45, 0.35)' ||
          [...document.querySelectorAll('.tree-node')].some(node =>
            getComputedStyle(node).backgroundColor !== 'rgba(0, 0, 0, 0)') ||
          getComputedStyle(document.querySelector('.tree-node > summary')).backgroundColor !== 'rgba(14, 40, 42, 0.45)') {
          throw new Error('Tree section and nested rows must not stack opaque backgrounds over splash art.');
        }
        for (const [selector, pseudo] of [['.framed-title', '::before'], ['.framed-progress', '::after']]) {
          const frame = getComputedStyle(document.querySelector(selector), pseudo);
          if (frame.borderImageSource === 'none' || frame.pointerEvents !== 'none' || frame.filter === 'none') {
            throw new Error('Supplied outer/title/gauge frames must load, recolor and remain click-through.');
          }
          const gateFrame = document.querySelector('.gate-window-frame');
          if (getComputedStyle(gateFrame).position !== 'fixed' ||
            getComputedStyle(gateFrame).pointerEvents !== 'auto' ||
            getComputedStyle(gateFrame).borderImageSlice.includes('fill') ||
            gateFrame.getAttribute('aria-hidden') !== 'true') {
            throw new Error('Gate frame must remain transparent, fixed and draggable outside the panel.');
          }
          await new Promise((resolve, reject) => {
            const style = getComputedStyle(gateFrame);
            const image = new Image();
            image.onload = () => {
              if (image.naturalWidth !== 2048 || Math.abs(parseFloat(style.backgroundSize) - innerWidth * 1.2) > 1 ||
                style.clipPath === 'none' || getComputedStyle(document.querySelector('main'), '::before').opacity !== '0.2' ||
                getComputedStyle(document.documentElement).backgroundColor !== 'rgba(0, 0, 0, 0)') {
                reject(new Error('Full gate must preserve proportions, fade inside the panel and expose transparent surroundings.'));
              } else resolve();
            };
            image.onerror = () => reject(new Error('Full gate failed to load.'));
            image.src = style.backgroundImage.slice(5, -2);
          });
        }
        const treeFrame = getComputedStyle(document.querySelector('.crafting-tree-section'));
        for (const name of document.querySelectorAll('.tree-node > summary > .tree-name')) {
          const icon = name.querySelector(':scope > .item-icon');
          const label = name.querySelector(':scope > strong');
          if (!icon || icon.nextElementSibling !== label ||
            getComputedStyle(name).display !== 'inline-grid') {
            throw new Error('Every tree item requires an icon immediately left of its name.');
          }
        }
        if (!treeFrame.borderImageSource.includes('/frame-') ||
          treeFrame.borderImageSlice.includes('fill') || treeFrame.borderImageRepeat !== 'stretch' ||
          parseFloat(treeFrame.paddingLeft) !== 22 ||
          !getComputedStyle(document.querySelector('.global-inventory')).borderImageSource.includes('/frame-') ||
          [...document.querySelectorAll('.metrics section')].some(panel =>
            !getComputedStyle(panel).borderImageSource.includes('/frame-'))) {
          throw new Error('Supplied inner frames must preserve transparent centers and normal padding.');
        }
        const outerFrame = getComputedStyle(document.querySelector('main'), '::after');
        if (!outerFrame.borderImageSource.includes('OuterFrame') || outerFrame.pointerEvents !== 'none' ||
          outerFrame.borderImageSlice.includes('fill') ||
          outerFrame.borderImageOutset !== '0' || outerFrame.borderImageSlice !== '16' ||
          outerFrame.borderImageWidth !== '20px' ||
          Number(outerFrame.zIndex) >= Number(getComputedStyle(document.querySelector('.gate-window-frame')).zIndex)) {
          throw new Error('Outer artwork must remain input-transparent and layered beneath the gate.');
        }
        const priceBranch = [...document.querySelectorAll('.sl-tree-root > details .tree-node')]
          .find(branch => branch.querySelector(':scope > summary strong').textContent === 'Bri Leith Essence');
        const unitBefore = priceBranch.querySelector('.selected-unit-price strong').textContent;
        priceBranch.querySelector(':scope > summary input[value^="ah:"]').click();
        await waitFor(() => priceBranch.querySelector('.selected-unit-price strong').textContent !== unitBefore &&
          !priceBranch.querySelector(':scope > summary input').matches(':disabled'));
        const referenceAH = [...priceBranch.querySelectorAll(':scope > .node-body > .material-prices .inline-price')]
          .find(price => price.querySelector('small')?.textContent === 'AH / item').querySelector('input').value + 'g';
        if (priceBranch.querySelector('.selected-unit-price strong').textContent !== referenceAH) {
          throw new Error('Per-item gold must follow selected AH override.');
        }
        const summaryCost = priceBranch.querySelector(':scope > summary .tree-cost');
        if (summaryCost.querySelector('.tree-unit-price').textContent !== referenceAH + ' / item' ||
          summaryCost.querySelector('.tree-total-price').textContent !== '1,800,000,000g total') {
          throw new Error('Branch summary must show selected AH per-item and total gold.');
        }
        if (priceBranch.open) priceBranch.querySelector(':scope > summary').click();
        priceBranch.querySelector(':scope > summary input[value^="source:"]').click();
        await waitFor(() => summaryCost.querySelector('.tree-total-price').textContent === '1,080,000,000g total' &&
          !priceBranch.querySelector(':scope > summary input').matches(':disabled'));
        if (summaryCost.querySelector('.tree-unit-price').textContent !== '60,000,000g / item' ||
          !summaryCost.checkVisibility() || priceBranch.open) {
          throw new Error('Collapsed branch per-item and total gold must follow Obol radio selection.');
        }
        priceBranch.querySelector(':scope > summary input').click();
        await waitFor(() => priceBranch.querySelector('.selected-unit-price strong').textContent === unitBefore &&
          !priceBranch.querySelector(':scope > summary input').matches(':disabled'));
        const treeButton = label => [...document.querySelectorAll('button')].find(button => button.textContent === label);
        const treePrefix = 'tree:' + (await window.soulLiberator.loadPlanner()).workspace.activeId + ':';
        treeButton('Collapse all').click();
        await waitFor(() => [...document.querySelectorAll('.tree-node')].every(node => !node.open));
        const savedCollapsed = JSON.parse(localStorage.getItem('disclosures'));
        if (Object.entries(savedCollapsed).filter(([key]) => key.startsWith(treePrefix)).some(([, open]) => open)) {
          throw new Error('Collapse all must persist tree states.');
        }
        if (!document.querySelector('.condensed-ingredients').checkVisibility()) {
          throw new Error('Collapse all must preserve the condensed root ingredients.');
        }
        treeButton('Expand all').click();
        await waitFor(() => [...document.querySelectorAll('.tree-node')].every(node => node.open));
        const trackersBox = document.querySelector('.tabs').getBoundingClientRect();
        const contentBox = document.querySelector('.tab-content').getBoundingClientRect();
        if (Math.abs(trackersBox.bottom - contentBox.top) > 2 ||
          getComputedStyle(document.querySelector('.tracker-tab.active')).borderBottomLeftRadius !== '0px') {
          throw new Error('Tracker tabs must join the content edge with square bottom corners.');
        }
        const ownedField = document.querySelector('[aria-label="Owned Bri Leith Essence"]');
        const originalOwned = ownedField.value.replace(/,/g, '');
        const setOwned = async quantity => {
          setInput('Owned Bri Leith Essence', quantity);
          await new Promise(resolve => setTimeout(resolve, 50));
          ownedField.focus(); ownedField.blur();
          await waitFor(() => !ownedField.disabled && ownedField.value.replace(/,/g, '') === quantity &&
            priceBranch.querySelector(':scope > summary .tree-quantity').textContent.startsWith(Number(quantity).toLocaleString('en-US') + ' /'));
        };
        await setOwned('18');
        await waitFor(() => priceBranch.classList.contains('completed'));
        if (priceBranch.querySelector(':scope > summary .tree-cost').textContent !== 'Completed') {
          throw new Error('Fully obtained branch end text must be Completed without zero-cost lines.');
        }
        const completedChip = ownedField.closest('.material-chip');
        if (!completedChip.classList.contains('completed') ||
          getComputedStyle(priceBranch.querySelector(':scope > summary')).animationName !==
            (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'none' : 'completed-shimmer')) {
          throw new Error('Fully obtained material must highlight and shimmer unless reduced motion is requested.');
        }
        const completedStyle = getComputedStyle(priceBranch);
        const shineStyle = getComputedStyle(priceBranch.querySelector(':scope > summary'));
        const sparkleStyle = getComputedStyle(priceBranch.querySelector(':scope > summary'), '::after');
        const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (completedStyle.borderTopColor !== 'rgb(212, 175, 87)' ||
          !shineStyle.backgroundImage.includes('repeating-linear-gradient') ||
          !shineStyle.backgroundImage.includes('rgb(179, 141, 65)') ||
          shineStyle.animationDuration !== (reducedMotion ? '0s' : '6s') ||
          sparkleStyle.animationName !== (reducedMotion ? 'none' : 'completed-sparkle') ||
          sparkleStyle.animationDuration !== (reducedMotion ? '0s' : '4.8s') ||
          sparkleStyle.backgroundRepeat.split(',').some(repeat => repeat.trim() !== 'no-repeat') ||
          sparkleStyle.pointerEvents !== 'none') {
          throw new Error('Completion must use metallic gold, six-second shimmer and frequent non-interactive sparkle glints.');
        }
        const sparkleFrames = [...document.styleSheets].flatMap(sheet => [...sheet.cssRules])
          .find(rule => rule instanceof CSSKeyframesRule && rule.name === 'completed-sparkle');
        if (!sparkleFrames ||
          new Set([...sparkleFrames.cssRules].map(rule => rule.style.backgroundPosition)).size < 3 ||
          [...sparkleFrames.cssRules].filter(rule => parseFloat(rule.style.opacity) > 0).length !== 3) {
          throw new Error('Sparkles must pulse three times per cycle at varied placements.');
        }
        await setOwned('17');
        await waitFor(() => !priceBranch.classList.contains('completed'));
        if (completedChip.classList.contains('completed')) throw new Error('Incomplete stock must lose completion highlight.');
        await setOwned(originalOwned);
        const previewToggle = document.querySelector('.auto-obol-toggle input');
        const savedBeforePreview = (await window.soulLiberator.loadPlanner()).workspace.inventory;
        const goldBeforePreview = document.querySelector('.gold-progress-summary strong').textContent;
        const heldCounterBeforePreview = document.querySelector('.obol-owned-chip .owned-count').textContent;
        const balanceBeforePreview = document.querySelector('.obol-balance strong').textContent;
        previewToggle.click();
        await waitFor(() => priceBranch.querySelector(':scope > summary .auto-obol-marker') &&
          !previewToggle.disabled);
        const previewMarker = priceBranch.querySelector(':scope > summary .auto-obol-marker');
        if (!priceBranch.querySelector(':scope > summary .tree-quantity').textContent.startsWith('12* / 18') ||
          !previewMarker.title.includes('12 items from 1,200 auto-applied held Obols') ||
          document.querySelector('.gold-progress-summary strong').textContent === goldBeforePreview ||
          JSON.stringify((await window.soulLiberator.loadPlanner()).workspace.inventory) !== JSON.stringify(savedBeforePreview)) {
          throw new Error('Auto-applied held Obols must annotate tree counts, update progress and preserve saved inventory.');
        }
        if (document.querySelector('.obol-owned-chip .owned-count').textContent !== heldCounterBeforePreview) {
          throw new Error('Auto-applied held Obols must not reduce the top remaining Obol counter.');
        }
        if (document.querySelector('.obol-balance strong').textContent !== balanceBeforePreview) {
          throw new Error('Auto-applied Obols must not be deducted twice from the balance equation.');
        }
        previewToggle.click();
        await waitFor(() => !priceBranch.querySelector(':scope > summary .auto-obol-marker') && !previewToggle.disabled);
        setInput('Gold value Bri Leith Core', '');
        await new Promise(resolve => setTimeout(resolve, 50));
        const blankValue = document.querySelector('[aria-label="Gold value Bri Leith Core"]');
        blankValue.focus(); blankValue.blur();
        await waitFor(async () => blankValue.value === '0' && !blankValue.disabled &&
          (await window.soulLiberator.loadPlanner()).catalog.items.find(item => item.id === 5100303).ahPrice === 0);
        if (blankValue.getAttribute('aria-invalid') !== 'false') throw new Error('Blank gold input must become valid zero.');
        if (blankValue.closest('.material-chip').classList.contains('missing-price')) {
          throw new Error('Explicit zero gold price must not highlight as missing.');
        }
        await window.soulLiberator.setPrice(5100303, null);
        [...document.querySelectorAll('button')].find(button => button.textContent === 'Reset all route overrides').click();
        await waitFor(() => document.querySelector('.sl-tree-root .missing-price-marker') && !blankValue.disabled);
        if (!blankValue.closest('.material-chip').classList.contains('missing-price') ||
          getComputedStyle(blankValue.closest('.material-chip')).borderTopColor !== 'rgb(188, 102, 102)') {
          throw new Error('Missing inventory gold price must highlight its chip red.');
        }
        const unpricedBranch = [...document.querySelectorAll('.tree-node')].find(branch =>
          branch.querySelector(':scope > summary strong')?.textContent === 'Bri Leith Core');
        if (unpricedBranch.querySelector(':scope > summary .tree-total-price').textContent !== '0g total*' ||
          !unpricedBranch.querySelector(':scope > summary .missing-price-marker').title.includes('Bri Leith Core') ||
          document.querySelector('.gold-progress-summary').textContent.includes('Needs prices')) {
          throw new Error('Unpriced AH must select zero-cost Auto with explanatory star and numeric metrics.');
        }
        const treeAH = unpricedBranch.querySelector('[aria-label="AH price Bri Leith Core"]');
        if (!treeAH || treeAH.disabled) throw new Error('Tree AH fields must remain editable in production.');
        if (!unpricedBranch.open) unpricedBranch.querySelector(':scope > summary').click();
        const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        valueSetter.call(treeAH, '765432');
        treeAH.dispatchEvent(new Event('input', { bubbles: true }));
        treeAH.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 50));
        treeAH.focus(); treeAH.blur();
        await waitFor(async () => (await window.soulLiberator.loadPlanner()).catalog.items.find(item => item.id === 5100303).ahPrice === 765432 &&
          !blankValue.disabled);
        if (blankValue.closest('.material-chip').classList.contains('missing-price')) {
          throw new Error('Entering a price must remove the red missing-price highlight.');
        }
      })()
    `)
    const inventoryResize = await window.webContents.executeJavaScript(`
      (() => {
        const panel = document.querySelector('.global-inventory');
        const box = panel.getBoundingClientRect();
        return { x: Math.round(box.left + 20), y: Math.round(box.bottom - 5), height: box.height };
      })()
    `)
    window.webContents.sendInputEvent({ type: 'mouseMove', x: inventoryResize.x, y: inventoryResize.y })
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', x: inventoryResize.x, y: inventoryResize.y, clickCount: 1 })
    window.webContents.sendInputEvent({ type: 'mouseMove', x: inventoryResize.x, y: inventoryResize.y - 60 })
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', x: inventoryResize.x, y: inventoryResize.y - 60, clickCount: 1 })
    await new Promise(resolve => setTimeout(resolve, 100))
    await window.webContents.executeJavaScript(`
      (() => {
        const panel = document.querySelector('.global-inventory');
        if (panel.getBoundingClientRect().height >= ${inventoryResize.height} - 20) {
          throw new Error('Dragging inventory resize handle did not reduce its height.');
        }
        const resizedHeight = panel.getBoundingClientRect().height;
        panel.querySelector('summary').click();
        if (panel.getBoundingClientRect().height >= resizedHeight) throw new Error('Resized inventory failed to collapse.');
        panel.querySelector('summary').click();
        if (Math.abs(panel.getBoundingClientRect().height - resizedHeight) > 1) {
          throw new Error('Reopening inventory must retain its manually resized height.');
        }
      })()
    `)
    const smallerInventory = await window.webContents.executeJavaScript(`
      (() => {
        const box = document.querySelector('.global-inventory').getBoundingClientRect();
        return { x: Math.round(box.right - 20), y: Math.round(box.bottom - 5), height: box.height };
      })()
    `)
    window.webContents.sendInputEvent({ type: 'mouseMove', x: smallerInventory.x, y: smallerInventory.y })
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', x: smallerInventory.x, y: smallerInventory.y, clickCount: 1 })
    window.webContents.sendInputEvent({ type: 'mouseMove', x: smallerInventory.x, y: smallerInventory.y + 45 })
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', x: smallerInventory.x, y: smallerInventory.y + 45, clickCount: 1 })
    await new Promise(resolve => setTimeout(resolve, 100))
    await window.webContents.executeJavaScript(`
      (() => {
        const panel = document.querySelector('.global-inventory');
        if (panel.getBoundingClientRect().height <= ${smallerInventory.height} + 20) {
          throw new Error('Dragging inventory resize handle must also increase its height.');
        }
        if (document.querySelector('.tab-content').getBoundingClientRect().height < 47) {
          throw new Error('Growing inventory must keep tab content accessible.');
        }
        panel.style.height = '';
      })()
    `)
    await window.webContents.executeJavaScript(`
      (async () => {
        if (${development}) [...document.querySelectorAll('button')].find(b => b.textContent === 'Materials').click();
        const deadline = Date.now() + 10000;
        while (!document.querySelector('${development ? 'table [aria-label^="AH price"]' : '[aria-label="Gold value Bri Leith Core"]'}:not(:disabled)')) {
          if (Date.now() > deadline) throw new Error('AH field unavailable');
          await new Promise(resolve => setTimeout(resolve, 30));
        }
        const field = document.querySelector('${development ? 'table [aria-label^="AH price"]' : '[aria-label="Gold value Bri Leith Core"]'}');
        field.focus(); field.select();
      })()
    `)
    for (const keyCode of '1234567') window.webContents.sendInputEvent({ type: 'char', keyCode })
    await new Promise(resolve => setTimeout(resolve, 100))
    await window.webContents.executeJavaScript(`
      (async () => {
        const field = document.querySelector('${development ? 'table [aria-label^="AH price"]' : '[aria-label="Gold value Bri Leith Core"]'}');
        if (field.value !== '1,234,567') throw new Error('AH formatting failed');
        field.blur();
        const deadline = Date.now() + 10000;
        while (!(await window.soulLiberator.loadPlanner()).catalog.items.some(i => i.ahPrice === 1234567)) {
          if (Date.now() > deadline) throw new Error('Grouped AH persistence failed');
          await new Promise(resolve => setTimeout(resolve, 30));
        }
        while (document.querySelector('${development ? 'table [aria-label^="AH price"]' : '[aria-label="Gold value Bri Leith Core"]'}').disabled) {
          if (Date.now() > deadline) throw new Error('AH save did not finish');
          await new Promise(resolve => setTimeout(resolve, 30));
        }
        if (document.querySelector('[aria-label="Tab name"]')) throw new Error('Separate tab name field remains.');
        document.querySelector('.tracker-tab.active .tracker-label').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 50));
        const rename = document.querySelector('[aria-label="Rename tracker"]');
        if (!rename || document.activeElement !== rename) throw new Error('Tab double-click did not focus rename.');
        rename.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 50));
        if (document.querySelector('[aria-label="Rename tracker"]')) throw new Error('Escape did not cancel rename.');
        document.querySelector('.tracker-tab.active .tab-edit').click();
        await new Promise(resolve => setTimeout(resolve, 50));
      })()
    `)
    for (const keyCode of 'Staff renamed') window.webContents.sendInputEvent({ type: 'char', keyCode })
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    await window.webContents.executeJavaScript(`
      (async () => {
        const deadline = Date.now() + 10000;
        while (!(await window.soulLiberator.loadPlanner()).workspace.plans.some(p => p.label === 'Staff renamed') ||
          document.querySelector('.tracker-select').disabled) {
          if (Date.now() > deadline) throw new Error('Inline rename did not persist');
          await new Promise(resolve => setTimeout(resolve, 30));
        }
        if (document.querySelector('[aria-label="Target quantity"]') || document.querySelector('.tracker-tab small')) {
          throw new Error('SL quantity counter remains.');
        }
        window.confirm = () => { throw new Error('Native confirmation must not be used.'); };
        const respond = async label => {
          while (!document.querySelector('.confirmation-popout[open]')) {
            if (Date.now() > deadline) throw new Error('Themed confirmation did not open.');
            await new Promise(resolve => setTimeout(resolve, 30));
          }
          const dialog = document.querySelector('.confirmation-popout');
          if (dialog.querySelector('h2').textContent !== 'Are you sure?' ||
            getComputedStyle(dialog).backgroundColor !== 'rgb(19, 43, 45)') {
            throw new Error('Confirmation must use concise text and app theme.');
          }
          [...dialog.querySelectorAll('button')].find(button => button.textContent === label).click();
          while (document.querySelector('.confirmation-popout')) {
            if (Date.now() > deadline) throw new Error('Confirmation did not close.');
            await new Promise(resolve => setTimeout(resolve, 30));
          }
        };
        document.querySelector('.tracker-tab:not(.active) .tab-delete').click();
        await respond('Cancel');
        if ((await window.soulLiberator.loadPlanner()).workspace.plans.length !== 2) {
          throw new Error('Delete cancellation failed.');
        }
        document.querySelector('[aria-label="Change equipment"]').click();
        while (!document.querySelector('.confirmation-popout[open]')) {
          if (Date.now() > deadline) throw new Error('Equipment confirmation missing.');
          await new Promise(resolve => setTimeout(resolve, 30));
        }
        document.querySelector('.confirmation-popout').dispatchEvent(new Event('cancel', { cancelable: true }));
        while (document.querySelector('.confirmation-popout')) await new Promise(resolve => setTimeout(resolve, 30));
        if (!(await window.soulLiberator.loadPlanner()).workspace.plans.some(plan => plan.label === 'Staff renamed')) {
          throw new Error('Escape cancellation changed equipment.');
        }
        document.querySelector('.tracker-tab:not(.active) .tab-delete').click();
        await respond('Confirm');
        while (document.querySelectorAll('.tracker-tab').length !== 1 || document.querySelector('.tab-delete').disabled) {
          if (Date.now() > deadline) throw new Error('Inactive tab delete failed');
          await new Promise(resolve => setTimeout(resolve, 30));
        }
        if (!document.querySelector('.tracker-tab.active').textContent.includes('Staff renamed')) throw new Error('Inactive deletion switched active tab');
        document.querySelector('.tab-delete').click();
        await respond('Confirm');
        while (!document.querySelector('.equipment-card') || document.querySelector('.tab-delete').disabled) {
          if (Date.now() > deadline) throw new Error('Last delete did not open blank tracker');
          await new Promise(resolve => setTimeout(resolve, 30));
        }
        const blank = await window.soulLiberator.loadPlanner();
        if (blank.workspace.plans.length !== 1 || blank.workspace.plans[0].itemId !== null ||
          blank.workspace.plans[0].quantity !== 1) throw new Error('Fresh single-item tracker failed');
        if (blank.workspace.inventory[5300217] !== 1234) throw new Error('Tab deletion cleared global inventory.');
      })()
    `)
    await window.webContents.executeJavaScript(`
      (async () => {
        const panel = document.querySelector('.global-inventory');
        if (panel.open) panel.querySelector('summary').click();
        const deadline = Date.now() + 5000;
        while (JSON.parse(localStorage.getItem('disclosures') ?? '{}').inventory !== false) {
          if (Date.now() > deadline) throw new Error('Inventory collapse state did not persist.');
          await new Promise(resolve => setTimeout(resolve, 30));
        }
      })()
    `)
    await new Promise(resolve => {
      window.webContents.once('did-finish-load', resolve)
      window.webContents.reload()
    })
    await window.webContents.executeJavaScript(`
      (async () => {
        const deadline = Date.now() + 10000;
        while (!document.querySelector('.global-inventory')) {
          if (Date.now() > deadline) throw new Error('Reloaded inventory missing.');
          await new Promise(resolve => setTimeout(resolve, 30));
        }
        if (document.querySelector('.global-inventory').open) throw new Error('Reload lost saved collapse state.');
      })()
    `)
    if (blockedRequests.length) throw new Error(`Unexpected external requests: ${blockedRequests.join(', ')}`)
    result.network = 'external network blocked; zero external requests'
    if (!programIcon || programIcon.getSize().width !== 256) throw new Error('Native program icon must use 256px tight artwork.')
    result.programIcon = '256px tight native Obol; centered text-only main-window title'
    await window.webContents.executeJavaScript(`document.querySelector('[aria-label="Minimize window"]').click()`)
    await new Promise(resolve => setTimeout(resolve, 100))
    if (!window.isMinimized()) throw new Error('Custom minimize button failed.')
    window.restore()
    for (const [width, height] of [[700, 540], [1440, 940]]) {
      setCustomBounds(window, { ...window.getBounds(), width, height })
      await new Promise(resolve => setTimeout(resolve, 100))
      await window.webContents.executeJavaScript(`
        (async () => {
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const frame = document.querySelector('.gate-window-frame').getBoundingClientRect();
          const panel = document.querySelector('main').getBoundingClientRect();
          if (Math.abs(panel.bottom - innerHeight) > 1) throw new Error('Panel and gate must end at the same window bottom.');
          const trim = getComputedStyle(document.querySelector('main'), '::after');
          if (trim.borderImageWidth !== '20px' || trim.borderImageOutset !== '0' ||
            Math.abs(parseFloat(trim.top) + 3.75 - panel.top) > 1 ||
            Math.abs(parseFloat(trim.left) + 2.5 - panel.left) > 1 ||
            Math.abs(innerWidth - parseFloat(trim.right) - 2.5 - panel.right) > 1 ||
            parseFloat(trim.bottom) !== 0) {
            throw new Error('Outer rails must compensate source alpha margins and meet all panel edges.');
          }
          const gateStyle = getComputedStyle(document.querySelector('.gate-window-frame'));
          if (parseFloat(getComputedStyle(document.querySelector('main')).paddingLeft) < 14 ||
            !gateStyle.clipPath.includes('polygon')) throw new Error('Jagged gate edges require clear interior padding.');
          if (document.elementFromPoint(panel.left / 2, panel.top + 20) !== document.querySelector('.gate-window-frame') ||
            document.elementFromPoint(panel.left + panel.width / 2, panel.top + 20) === document.querySelector('.gate-window-frame')) {
            throw new Error('Gate exterior must accept dragging without capturing panel content.');
          }
          if (Math.abs(innerWidth - ${width}) > 3 || Math.abs(innerHeight - ${height}) > 3 ||
            Math.abs(frame.width - innerWidth) > 1 || Math.abs(frame.height - innerHeight) > 1) {
            throw new Error('Gate frame must follow the resized viewport.');
          }
          const controls = [...document.querySelectorAll('.window-controls button, .settings-button')];
          const headerBounds = document.querySelector('.app-header').getBoundingClientRect();
          const inventoryBounds = document.querySelector('.global-inventory').getBoundingClientRect();
          if (headerBounds.height > 69 || inventoryBounds.top - headerBounds.bottom > 9) {
            throw new Error('Compact header must not retain an empty status row or oversized inventory gap.');
          }
          for (const name of document.querySelectorAll('.tree-node > summary > .tree-name')) {
            if (!name.checkVisibility()) continue;
            const icon = name.querySelector(':scope > .item-icon').getBoundingClientRect();
            const label = name.querySelector(':scope > strong').getBoundingClientRect();
            if (icon.right > label.left || icon.top >= label.bottom || label.top >= icon.bottom) {
              throw new Error('Tree icons must stay left of their names at every supported window size.');
            }
          }
          if (document.querySelectorAll('.window-resize').length !== 8) throw new Error('Eight custom resize handles required.');
          for (const control of controls) {
            const bounds = control.getBoundingClientRect();
            if (bounds.right > panel.right - 18 || bounds.top < panel.top + 12) {
              throw new Error('Corner controls must remain clear of the outer trim.');
            }
            const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
            if (hit !== control && !control.contains(hit)) throw new Error('Window control blocked by decorative frame.');
          }
        })()
      `)
    }
    const beforeResize = window.getBounds()
    await window.webContents.executeJavaScript(`window.soulLiberator.resizeWindow('step', 'e', 20)`)
    if (Math.abs(window.getBounds().width - beforeResize.width - 20) > 1) {
      throw new Error('Custom keyboard resizing failed: ' + JSON.stringify({ beforeResize, after: window.getBounds() }))
    }
    await window.webContents.executeJavaScript(`window.soulLiberator.resizeWindow('step', 'e', -20)`)
    if (Math.abs(window.getBounds().width - beforeResize.width) > 2) throw new Error('Custom keyboard shrinking failed.')
    if (JSON.stringify(store.windowSize()) !== JSON.stringify({
      width: window.getBounds().width, height: window.getBounds().height })) {
      throw new Error('Custom resizing must persist the actual native window size.')
    }
    const cursorBefore = screen.getCursorScreenPoint()
    const pointerBounds = window.getBounds()
    await window.webContents.executeJavaScript(`window.soulLiberator.resizeWindow('start', 'se').then(() =>
      window.soulLiberator.resizeWindow('update')).then(() => window.soulLiberator.resizeWindow('end'))`)
    const cursorAfter = screen.getCursorScreenPoint()
    if (cursorBefore.x === cursorAfter.x && cursorBefore.y === cursorAfter.y &&
      Math.abs(window.getBounds().width - pointerBounds.width) > 1) throw new Error('Stationary pointer resize changed window size.')
    if (window.isResizable()) throw new Error('Transparent window must use custom resizing.')
    const moveBounds = window.getBounds()
    await window.webContents.executeJavaScript(`window.soulLiberator.resizeWindow('start', 'move')`)
    let settledMoveBounds
    try {
      for (let i = 0; i < 60; i++) {
        await window.webContents.executeJavaScript(`window.soulLiberator.resizeWindow('update')`)
        if (i === 9) settledMoveBounds = window.getBounds()
      }
      const finalMoveBounds = window.getBounds()
      if (Math.abs(finalMoveBounds.width - moveBounds.width) > 2 ||
        Math.abs(finalMoveBounds.height - moveBounds.height) > 2 ||
        finalMoveBounds.width !== settledMoveBounds.width || finalMoveBounds.height !== settledMoveBounds.height) {
        throw new Error('Held gate drag must retain its original size without cumulative DPI growth.')
      }
    } finally {
      await window.webContents.executeJavaScript(`window.soulLiberator.resizeWindow('end')`)
    }
    result.windowFrame = 'transparent full gate; custom resize IPC and 700x540 /1440x940 controls'
    result.planner = 'grouped price typing/highlighting/backspace, AH persistence, material comparisons, settings hotkeys, offline art, tree/metrics/inventory'
    result.devEditor = development ? 'manual source form persisted to isolated SQLite' : 'production editing gated'
    store.close()
    store = null
    await rm(smokeFolder, { recursive: true })
    smokeFolder = null
    console.log('DESKTOP_SMOKE_OK', JSON.stringify(result))
    if (process.env.SOUL_LIBERATOR_SMOKE_REPORT) {
      await writeFile(process.env.SOUL_LIBERATOR_SMOKE_REPORT, JSON.stringify(result), 'utf8')
    }
    const closed = new Promise(resolve => window.once('closed', resolve))
    await window.webContents.executeJavaScript(`setTimeout(() => document.querySelector('[aria-label="Close window"]').click(), 50); undefined`)
    await closed
    app.quit()
  }
}

app.whenReady().then(async () => {
  if (smokeTest) {
    smokeFolder = await mkdtemp(path.join(app.getPath('temp'), 'sl-desktop-smoke-'))
    const filename = path.join(smokeFolder, 'smoke.sqlite')
    await copyFile(new URL('../data/soul-liberator.sqlite', import.meta.url), filename)
    store = new PlannerStore(filename, development)
    store.db.exec('DELETE FROM planner_workspace')
    store.db.exec('DELETE FROM planner_preferences')
  } else {
    const filename = app.isPackaged ? await prepareUserDatabase(applicationDirectory) : undefined
    store = new PlannerStore(filename, development)
  }
  function handle(channel, action) {
    ipcMain.handle(channel, (event, ...args) => {
      const expected = development ? `${developmentUrl}/` : indexUrl
      if (event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== expected) {
        throw new Error('Untrusted desktop request.')
      }
      return action(...args)
    })
  }
  handle('client-data:inspect', () => inspectClientData())
  handle('planner:load', () => ({ catalog: store.catalog(), workspace: store.readState(), exclusions: store.exclusions(), history: store.historyStatus() }))
  handle('planner:save', state => store.saveState(state))
  handle('planner:price', (id, price) => store.setPrice(id, price))
  handle('planner:source-save', (input, replaceKey) => store.saveSource(input, replaceKey))
  handle('planner:source-remove', key => store.removeSource(key))
  handle('planner:source-restore', key => store.restoreSource(key))
  handle('planner:history', direction => store.history(direction))
  handle('planner:hotkeys', (undoKey, redoKey) => store.setHotkeys(undoKey, redoKey))
  ipcMain.handle('window:control', (event, command) => {
    const expected = development ? `${developmentUrl}/` : indexUrl
    if (event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== expected) {
      throw new Error('Untrusted desktop request.')
    }
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) throw new Error('Desktop window unavailable.')
    if (command === 'minimize') window.minimize()
    else if (command === 'close') window.close()
    else throw new Error('Unknown window control.')
  })
  let resizeSession
  ipcMain.handle('window:resize', (event, command, edge, amount) => {
    const expected = development ? `${developmentUrl}/` : indexUrl
    if (event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== expected) {
      throw new Error('Untrusted desktop request.')
    }
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) throw new Error('Desktop window unavailable.')
    if (command === 'end') {
      if (resizeSession?.window === window) store.saveWindowSize(window.getBounds())
      resizeSession = undefined
    } else if (command === 'start' && (resizeEdges.includes(edge) || edge === 'move')) {
      resizeSession = { window, edge, bounds: window.getBounds(), cursor: screen.getCursorScreenPoint() }
    } else if (command === 'update' && resizeSession?.window === window) {
      const cursor = screen.getCursorScreenPoint()
      const bounds = resizedBounds(resizeSession.bounds, resizeSession.edge,
        cursor.x - resizeSession.cursor.x, cursor.y - resizeSession.cursor.y)
      // setPosition reuses rounded current dimensions and accumulates DPI growth on Windows.
      setCustomBounds(window, bounds)
    } else if (command === 'step' && resizeEdges.includes(edge) && (amount === 20 || amount === -20)) {
      setCustomBounds(window, resizedBounds(window.getBounds(), edge,
        edge.includes('e') || edge.includes('w') ? amount : 0,
        edge.includes('n') || edge.includes('s') ? amount : 0))
      store.saveWindowSize(window.getBounds())
    } else {
      throw new Error('Invalid window resize request.')
    }
  })
  await createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow().catch(failStartup)
    }
  })
}).catch(failStartup)

async function failStartup(error) {
  console.error('Desktop startup failed:', error)
  if (!smokeTest) {
    dialog.showErrorBox('Soul Liberator Calculator could not start',
      `${String(error)}\nKeep the EXE in a writable folder so the save database can be opened beside it.`)
  }
  if (smokeFolder) {
    store?.close()
    store = null
    await rm(smokeFolder, { recursive: true })
    smokeFolder = null
  }
  app.exit(1)
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('will-quit', () => store?.close())
