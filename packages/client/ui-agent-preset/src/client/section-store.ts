/** Preset roster, the new-task default and the read-only composition viewer for the settings section. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AgentPresetRow } from '@deepseek-ai/dsh-agent-preset-registry/types'
import { writeDefaultPreset } from './settings-store.ts'
import {
  createAuthoringPreset,
  deleteAuthoringPreset,
  getAuthoringPreset,
  listAuthoringPresets,
  updateAuthoringPreset,
  type AuthoringCreateInput,
  type AuthoringPresetDetail,
  type AuthoringPresetRow,
  type AuthoringUpdateInput,
} from './manual-authoring.ts'

/** The read-only composition viewer over one preset. */
export interface PresetView {
  /** The preset being read. */
  id: string
  /** Display name the preset published, or its id. */
  title: string
  /** The declared child plugin list as YAML. */
  content: string
}
/** Manual authoring metadata read from the profile's preset-authoring routes. */
export interface AgentPresetAuthoringState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  rows: readonly AuthoringPresetRow[]
}
/** Settings page state. */
export interface AgentPresetSectionState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  saving: boolean
  rows: readonly AgentPresetRow[]
  /** Manual authoring availability and per-preset metadata. */
  authoring: AgentPresetAuthoringState
  /** The open viewer, or null. */
  view: PresetView | null
}
const INITIAL: AgentPresetSectionState = { status: 'idle', error: null, saving: false, rows: [], authoring: { status: 'idle', error: null, rows: [] }, view: null }
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** Loads the roster, writes the default, and reads one composition at a time. */
export class AgentPresetSectionController {
  /** Observable roster, selection and viewer state. */
  readonly store: SnapshotStore<AgentPresetSectionState> = createSnapshotStore(INITIAL)
  private loading: Promise<void> | undefined
  private viewRequest = 0
  constructor(private readonly ctx: Context) {}

  private set(patch: Partial<AgentPresetSectionState>): void { this.store.set({ ...this.store.getSnapshot(), ...patch }) }

  /** Refresh the roster; concurrent calls share one read.
   * @returns Once the roster read settles.
   */
  load(): Promise<void> {
    return this.loading ??= this.readRoster().finally(() => { this.loading = undefined })
  }
  private async readRoster(): Promise<void> {
    try {
      const [result, authoring] = await Promise.all([
        this.ctx.remote.agentPresets.list(),
        listAuthoringPresets().then(
          rows => ({ ok: true as const, rows }),
          (error: unknown) => ({ ok: false as const, error: message(error) }),
        ),
      ])
      if (!result.ok) throw new Error(result.error.message)
      this.set({
        status: 'ready', error: null, rows: result.value.presets,
        authoring: authoring.ok
          ? { status: 'ready', error: null, rows: authoring.rows }
          : { status: 'error', error: authoring.error, rows: [] },
      })
    } catch (error) { this.set({ status: 'error', error: message(error) }) }
  }

  /** Read one preset's editable fields for the edit dialog.
   * @param id Preset identity.
   * @returns The detail, or the failure message.
   */
  async presetDetail(id: string): Promise<{ detail?: AuthoringPresetDetail; error?: string }> {
    try { return { detail: await getAuthoringPreset(id) } } catch (error) { return { error: message(error) } }
  }

  /** Clone a base preset into a new user preset.
   * @param input Create request.
   * @returns The failure message, or undefined once the row landed and the roster refreshed.
   */
  async createPreset(input: AuthoringCreateInput): Promise<string | undefined> {
    return this.saveAuthoring(() => createAuthoringPreset(input))
  }

  /** Edit a user preset's name, description, and persona suffix.
   * @param input Update request.
   * @returns The failure message, or undefined once saved and refreshed.
   */
  async updatePreset(input: AuthoringUpdateInput): Promise<string | undefined> {
    return this.saveAuthoring(() => updateAuthoringPreset(input))
  }

  /** Delete a user preset row.
   * @param id Preset identity.
   * @returns The failure message, or undefined once removed and refreshed.
   */
  async deletePreset(id: string): Promise<string | undefined> {
    return this.saveAuthoring(() => deleteAuthoringPreset(id))
  }

  private async saveAuthoring(write: () => Promise<void>): Promise<string | undefined> {
    if (this.store.getSnapshot().saving) return 'another preset write is in flight'
    this.set({ saving: true, error: null })
    try {
      await write()
      await this.load()
      return undefined
    } catch (error) {
      this.set({ error: message(error) })
      return message(error)
    } finally { this.set({ saving: false }) }
  }

  /** Open one preset's declared composition in the viewer.
   * @param id Preset to read.
   * @returns Once the read settles; a current failure lands in `error`, while a read superseded by close or another read is ignored.
   */
  async view(id: string): Promise<void> {
    const request = ++this.viewRequest
    this.set({ error: null, view: null })
    try {
      const result = await this.ctx.remote.agentPresets.read(id)
      if (request !== this.viewRequest) return
      if (!result.ok) throw new Error(result.error.message)
      const { name, content } = result.value
      this.set({ view: { id, title: name ?? id, content } })
    } catch (error) { if (request === this.viewRequest) this.set({ error: message(error) }) }
  }
  /** Close the viewer. */
  closeView(): void { this.viewRequest++; this.set({ view: null }) }

  /** Set the default and synchronize the current blank task when supplied.
   * @param id Selected default.
   * @param sync Blank-session synchronization callback.
   * @returns Once saved and refreshed.
   */
  async makeDefault(id: string, sync?: (id: string) => Promise<string | undefined>): Promise<void> {
    await this.save(() => writeDefaultPreset(this.ctx, id), sync)
  }
  private async save(write: () => Promise<string | undefined>, sync?: (id: string) => Promise<string | undefined>): Promise<void> {
    if (this.store.getSnapshot().saving) return
    this.set({ saving: true, error: null })
    try {
      const error = await write()
      await this.load()
      if (error !== undefined) throw new Error(error)
      const selected = this.store.getSnapshot().rows.find(row => row.isDefault)
      if (selected !== undefined) {
        const error = await sync?.(selected.id)
        if (error !== undefined) throw new Error(error)
      }
    } catch (error) { this.set({ error: message(error) }) }
    finally { this.set({ saving: false }) }
  }
}
