import type {
  AssistantMessageNode, ConversationLocation, ConversationNode, ConversationPromptSnapshot,
  ConversationViewNode, MessageImagesOwnerProps, PartialAssistant, RequestPromptChange,
  RequestView, RunningToolCall, SystemPromptNode, ToolCallBlock,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  RevertFileConflict, RevertFileOutcome, SessionRevertShadowRange,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'

/** Request-header facts retained by the Trajectory target. */
export interface TrajectoryRequestHeaderState {
  readonly seq: number
  readonly time: number
  readonly prompt: ConversationPromptSnapshot
  readonly change?: RequestPromptChange
  readonly location: ConversationLocation
}

/** One durable revert boundary projected from a `revert/state` log event. */
export interface TrajectoryRevertBoundary {
  readonly seq: number
  readonly time: number
  /** User-message seq the boundary reverts from; null for restore-all and revert-commit. */
  readonly fromSeq: number | null
  /** Recorded trigger; logs written before the field existed are derived from `fromSeq`. */
  readonly cause: 'revert' | 'restore' | 'commit'
}

/**
 * Revert state the Trajectory ledger shares with the Session fold (the same
 * truth the revert tray reads): the active boundary, committed shadow ranges,
 * and per-file outcomes/conflicts.
 */
export interface TrajectoryRevertView {
  readonly fromSeq: number | null
  readonly shadowRanges: readonly SessionRevertShadowRange[]
  readonly outcomes: Readonly<Record<string, RevertFileOutcome>>
  readonly conflicts: readonly RevertFileConflict[]
}

/** One durable `revert/file-result` batch projected for the ledger. */
export interface TrajectoryRevertFileResult {
  readonly seq: number
  /** Boundary anchor recorded by the file-revert plugin (`-1` for a restore-all batch). */
  readonly revertSeq: number
  readonly outcomes: Readonly<Record<string, RevertFileOutcome>>
}

/** One durable `revert/file-conflict` record projected for the ledger. */
export interface TrajectoryRevertConflict {
  readonly seq: number
  readonly conflictId: string
  readonly targetKey: string
  readonly displayPath: string
  readonly state: 'conflict' | 'missing' | 'unavailable'
  /** Revert boundary the conflict batch belongs to, when the event recorded one. */
  readonly boundarySeq?: number | null
}

/** One independently assembled contribution to the legacy Trajectory ledger. */
export type TrajectoryContribution =
  | { readonly kind: 'system-prompt'; readonly prompt: SystemPromptNode }
  | {
    readonly kind: 'node'
    readonly node: ConversationNode
  }
  | {
    readonly kind: 'assistant'
    readonly node?: AssistantMessageNode
    readonly partial: PartialAssistant | null
    readonly request?: Extract<RequestView, { purpose: 'assistant' }>
  }
  | {
    readonly kind: 'tool'
    readonly root: ToolCallBlock
  }
  | {
    readonly kind: 'request-header'
    readonly header: TrajectoryRequestHeaderState
  }
  | {
    readonly kind: 'compaction'
    readonly request: Extract<RequestView, { purpose: 'compaction' }>
  }
  | {
    readonly kind: 'session-end'
    readonly seq: number
    readonly time: number
  }
  | {
    readonly kind: 'revert'
    readonly revert: TrajectoryRevertBoundary
  }
  | {
    readonly kind: 'revert-files'
    readonly files: TrajectoryRevertFileResult
  }
  | {
    readonly kind: 'revert-conflict'
    readonly conflict: TrajectoryRevertConflict
  }
  | {
    readonly kind: 'turn-end'
    readonly turn: number
    readonly time: number
    readonly error?: string
    readonly errorCode?: string
  }

/** Target envelope consumed by the Trajectory snapshot builder. */
export interface TrajectoryConversationViewNode extends ConversationViewNode {
  readonly target: 'trajectory'
  readonly anchorSeq: number
  readonly location: ConversationLocation
  readonly data: TrajectoryContribution
}

/** Stage-oriented Trajectory data assembled from registered business Contexts. */
export interface TrajectorySnapshot {
  /** Complete loaded prompt text whose request header is outside the window. */
  readonly systemPrompts?: readonly SystemPromptNode[]
  readonly eventNodes: readonly ConversationNode[]
  readonly eventLocations: ReadonlyMap<number, ConversationLocation>
  readonly requests: readonly RequestView[]
  readonly callSchemas: ReadonlyMap<string, ConversationPromptSnapshot['tools'][number]>
  readonly partial: PartialAssistant | null
  readonly runningCalls: readonly RunningToolCall[]
  /** Durable revert boundaries in window order, oldest first. */
  readonly reverts?: readonly TrajectoryRevertBoundary[]
  /** Durable `revert/file-result` batches in window order, oldest first. */
  readonly revertFiles?: readonly TrajectoryRevertFileResult[]
  /** Durable `revert/file-conflict` records in window order, oldest first. */
  readonly revertConflicts?: readonly TrajectoryRevertConflict[]
}

/** Selector hook over the current Conversation binding's Trajectory target. */
export type UseTrajectory = SnapshotSelectorHook<TrajectorySnapshot>

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationViewSnapshotMap {
    /** Independently assembled data consumed by the Trajectory view. */
    trajectory: TrajectorySnapshot
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SessionStandardProps {
    /** Selector hook over the current Conversation binding's Trajectory target. */
    useTrajectory: UseTrajectory
  }

  interface SlotMap {
    /**
     * Renderer for one group of durable record images in the Trajectory
     * ledger. The owner supplies image references, an authorized loader, and
     * alignment. A registration replaces the shipped gallery; without one,
     * images are omitted.
     */
    'conversation.trajectory.images': { kind: 'single'; scope: 'session'; owner: MessageImagesOwnerProps }
  }
}
