import type { Catalog, HistoryStatus, ManualSourceInput, WorkspaceState } from './model'

declare global {
const __APP_VERSION__: string

interface ClientDataStatus {
  root: string
  available: boolean
  files: {
    relativePath: string
    available: boolean
    error: string | null
  }[]
}

interface Window {
  soulLiberator?: {
    inspectClientData(): Promise<ClientDataStatus>
    loadPlanner(): Promise<{
      catalog: Catalog
      workspace: WorkspaceState
      exclusions: { key: string; reason: string; status: string }[]
      history: HistoryStatus
    }>
    saveWorkspace(state: WorkspaceState): Promise<void>
    setPrice(id: number, price: number | null): Promise<void>
    saveSource(input: ManualSourceInput, replaceKey?: string | null): Promise<void>
    removeSource(key: string): Promise<void>
    restoreSource(key: string): Promise<void>
    history(direction: 'undo' | 'redo'): Promise<void>
    setHotkeys(undoKey: string, redoKey: string): Promise<void>
    windowControl(command: 'minimize' | 'close'): Promise<void>
    resizeWindow(command: 'start' | 'update' | 'end' | 'step', edge?: string, amount?: number): Promise<void>
  }
}
}
