/**
 * TypeScript-independent wire descriptor table and canonical digest computation
 * for the `peer.*` namespace.
 *
 * `PEER_SCHEMA_DIGEST` hashes the protocol version, method names, delivery
 * modes, and full request/response/frame field descriptors (including nested
 * fields and optionality) so any wire change alters the digest.
 * `PEER_METHODS_DIGEST` retains the legacy method-name-only digest for
 * compatibility.
 *
 * @module @deepseek-ai/dsh-api-peer/wire-schema
 */

import { createHash } from 'node:crypto'
import type { PeerProtocolVersion } from './types.ts'

/** Peer protocol generation this descriptor table models. */
export const WIRE_PROTOCOL_VERSION: PeerProtocolVersion = 1

/** Wire descriptor for one request, response, or stream-frame field. */
export interface PeerWireFieldDescriptor {
  readonly name: string
  readonly type: string
  readonly optional?: boolean
  readonly fields?: readonly PeerWireFieldDescriptor[]
  readonly variants?: readonly {
    readonly tag: string
    readonly fields: readonly PeerWireFieldDescriptor[]
  }[]
}

/** Wire descriptor for one `peer.*` RPC or stream method. */
export interface PeerWireMethodDescriptor {
  readonly method: string
  readonly mode: 'unary' | 'stream'
  readonly requestOptional?: boolean
  readonly request: readonly PeerWireFieldDescriptor[]
  readonly response: readonly PeerWireFieldDescriptor[]
  readonly uplink?: readonly PeerWireFieldDescriptor[]
  readonly frames?: readonly {
    readonly type: string
    readonly fields: readonly PeerWireFieldDescriptor[]
  }[]
}

const TARGET_FIELD: PeerWireFieldDescriptor = {
  name: 'target',
  type: 'union',
  variants: [
    {
      tag: 'alias',
      fields: [
        { name: 'kind', type: '"alias"' },
        { name: 'alias', type: 'PeerAlias' },
      ],
    },
    {
      tag: 'session',
      fields: [
        { name: 'kind', type: '"session"' },
        { name: 'sessionId', type: 'SessionId' },
      ],
    },
  ],
}

const PARTICIPANT_FIELD: PeerWireFieldDescriptor = {
  name: 'participant',
  type: 'object',
  fields: [
    { name: 'kind', type: '"peer"' },
    { name: 'name', type: 'string' },
    { name: 'device', type: 'string', optional: true },
  ],
}

const RESOLVED_TARGET_FIELDS: readonly PeerWireFieldDescriptor[] = [
  { name: 'device', type: 'string' },
  { name: 'sessionId', type: 'SessionId' },
  { name: 'exposure', type: '"answer-only" | "debug"' },
  { name: 'alias', type: 'PeerAlias', optional: true },
]

const PROFILE_SUMMARY_FIELDS: readonly PeerWireFieldDescriptor[] = [
  { name: 'hash', type: 'string' },
  { name: 'presetId', type: 'string' },
]

const JOB_LIMITS_FIELDS: readonly PeerWireFieldDescriptor[] = [
  { name: 'maxSteps', type: 'number', optional: true },
  { name: 'maxToolCalls', type: 'number', optional: true },
  { name: 'maxWallMs', type: 'number', optional: true },
  { name: 'maxTotalTokens', type: 'number', optional: true },
]

const JOB_BINDING_FIELDS: readonly PeerWireFieldDescriptor[] = [
  { name: 'sessionId', type: 'SessionId' },
  { name: 'jobId', type: 'string' },
  { name: 'fence', type: 'number' },
  { name: 'expiresAt', type: 'number' },
  { name: 'capabilities', type: 'string[]' },
  { name: 'limits', type: 'object', fields: JOB_LIMITS_FIELDS },
  { name: 'mcpEndpointId', type: 'string', optional: true },
  { name: 'credentialRef', type: 'string', optional: true },
  { name: 'allowedToolNames', type: 'string[]', optional: true },
  { name: 'alias', type: 'PeerAlias' },
  { name: 'instanceId', type: 'string' },
  { name: 'createdAt', type: 'number' },
  { name: 'revoked', type: 'boolean', optional: true },
  { name: 'revokedAt', type: 'number', optional: true },
]

const MODEL_SELECTION_FIELDS: readonly PeerWireFieldDescriptor[] = [
  { name: 'provider', type: 'string' },
  { name: 'model', type: 'string' },
  { name: 'chain', type: 'string', optional: true },
  { name: 'reasoningEffort', type: 'string', optional: true },
]

const TOKEN_USAGE_FIELDS: readonly PeerWireFieldDescriptor[] = [
  { name: 'inputTokens', type: 'number' },
  { name: 'outputTokens', type: 'number' },
  { name: 'cacheReadTokens', type: 'number' },
  { name: 'cacheWriteTokens', type: 'number' },
]

const TURN_TERMINAL_FIELDS: readonly PeerWireFieldDescriptor[] = [
  { name: 'turn', type: 'number' },
  { name: 'reason', type: 'string' },
  { name: 'at', type: 'number' },
  {
    name: 'error',
    type: 'object',
    optional: true,
    fields: [
      { name: 'code', type: 'string' },
      { name: 'message', type: 'string' },
      { name: 'provider', type: 'string', optional: true },
      { name: 'model', type: 'string', optional: true },
    ],
  },
  {
    name: 'ran',
    type: 'object',
    optional: true,
    fields: [
      { name: 'provider', type: 'string' },
      { name: 'model', type: 'string' },
      { name: 'chain', type: 'string', optional: true },
      { name: 'hops', type: 'number' },
      { name: 'usage', type: 'object', optional: true, fields: TOKEN_USAGE_FIELDS },
    ],
  },
  { name: 'stop', type: '"budget"', optional: true },
]

const LATCH = 'running|waiting_approval|waiting_subagents|idle'
const PROMPT_DISPOSITION = 'queued|claimed|cancelled_before_dispatch|terminal|unknown'
const TERMINAL_OUTCOME = 'completed|aborted|failed|budget|blocked|max-tokens|interrupted'
const QUESTION_FIELDS: readonly PeerWireFieldDescriptor[] = [
  { name: 'id', type: 'string' }, { name: 'question', type: 'string' },
  { name: 'detail', type: 'string', optional: true }, { name: 'header', type: 'string', optional: true },
  { name: 'multiSelect', type: 'boolean', optional: true },
  { name: 'options', type: 'array', optional: true, fields: [
    { name: 'label', type: 'string' }, { name: 'description', type: 'string', optional: true },
  ] },
  { name: 'intent', type: 'object', optional: true, fields: [
    { name: 'kind', type: '"plan-review"' }, { name: 'approve', type: 'string' },
    { name: 'callId', type: 'string', optional: true },
  ] },
]
const ROUTE_FIELDS: readonly PeerWireFieldDescriptor[] = [
  { name: 'provider', type: 'string' }, { name: 'model', type: 'string' },
]
const ASK_VARIANTS: NonNullable<PeerWireFieldDescriptor['variants']> = [
  { tag: 'approval', fields: [
    { name: 'kind', type: '"approval"' }, { name: 'askId', type: 'PeerAskId' },
    { name: 'toolName', type: 'string' }, { name: 'callId', type: 'string', optional: true },
    { name: 'reason', type: 'string', optional: true }, { name: 'since', type: 'number' },
  ] },
  { tag: 'question', fields: [
    { name: 'kind', type: '"question"' }, { name: 'askId', type: 'PeerAskId' },
    { name: 'questions', type: 'array', fields: QUESTION_FIELDS }, { name: 'since', type: 'number' },
  ] },
]
const ASK_JOURNAL_FIELDS: readonly PeerWireFieldDescriptor[] = [
  { name: 'alias', type: 'PeerAlias' }, { name: 'sessionId', type: 'SessionId' },
  { name: 'instanceId', type: 'string' }, { name: 'createdAt', type: 'number' },
  { name: 'state', type: 'pending|answered|expired|cancelled' },
  { name: 'settledAt', type: 'number', optional: true },
  { name: 'settlementReason', type: 'host-restarted|local-answer|local-cancelled', optional: true },
  { name: 'answeredBy', type: 'object', optional: true, fields: [
    { name: 'requestId', type: 'PeerRequestId' }, { name: 'payloadHash', type: 'string' },
  ] },
]
const STOP_INTENT: PeerWireFieldDescriptor = { name: 'stopIntent', type: 'object', fields: [
  { name: 'requestedAt', type: 'number', optional: true },
  { name: 'keepInbox', type: 'true' },
  { name: 'turnState', type: `${LATCH}|unknown` },
  { name: 'activeDescendants', type: 'number' }, { name: 'descendantsExact', type: 'boolean' },
  { name: 'inFlightTools', type: 'number', optional: true },
  { name: 'quiescence', type: 'confirmed|observed|unknown' },
] }
const EXECUTION_STATE_FIELDS: readonly PeerWireFieldDescriptor[] = [
  { name: 'latch', type: LATCH },
  { name: 'since', type: 'number' },
  { name: 'source', type: '"host-latch" | "derived"' },
  { name: 'activeDescendants', type: 'number' },
  { name: 'descendantsExact', type: 'boolean' },
  { name: 'pendingAsks', type: 'array', variants: ASK_VARIANTS },
  { ...STOP_INTENT, optional: true },
  { name: 'lastTurnEnd', type: 'object', optional: true, fields: TURN_TERMINAL_FIELDS },
  { name: 'lastParticipantAction', type: 'object', optional: true, fields: [
    { name: 'action', type: 'prompt|steer|cancel|queue-edit|answer|model-change|create' },
    { name: 'actor', type: 'object', fields: [
      { name: 'kind', type: 'peer|human' }, { name: 'name', type: 'string' },
      { name: 'device', type: 'string', optional: true },
    ] },
    { name: 'at', type: 'number' }, { name: 'detail', type: 'string', optional: true },
  ] },
  { name: 'model', type: 'object', optional: true, fields: MODEL_SELECTION_FIELDS },
  { name: 'usage', type: 'object', optional: true, fields: TOKEN_USAGE_FIELDS },
  {
    name: 'budget',
    type: 'object',
    optional: true,
    fields: [
      { name: 'maxTotalTokens', type: 'number' },
      { name: 'usedTokens', type: 'number' },
      { name: 'exceeded', type: 'boolean' },
      { name: 'metered', type: 'boolean' },
    ],
  },
  { name: 'recentModelHops', type: 'array', optional: true, fields: [
    { name: 'from', type: 'object', fields: ROUTE_FIELDS },
    { name: 'to', type: 'object', optional: true, fields: ROUTE_FIELDS },
    { name: 'reason', type: 'rate-limit|error|cooldown|unavailable' },
    { name: 'chain', type: 'string', optional: true }, { name: 'at', type: 'number' },
  ] },
]

const STATE_RESPONSE: readonly PeerWireFieldDescriptor[] = [
  { name: 'target', type: 'object', fields: RESOLVED_TARGET_FIELDS },
  { name: 'state', type: 'object', fields: EXECUTION_STATE_FIELDS },
  { name: 'cursor', type: 'SessionSeq' },
]

const EVENT_RECORD_FIELDS: readonly PeerWireFieldDescriptor[] = [
  { name: 'seq', type: 'SessionSeq' },
  { name: 'time', type: 'number' },
  { name: 'type', type: 'string' },
  { name: 'data', type: 'JsonValue' },
]

/**
 * Authoritative runtime wire descriptor table for every `peer.*` method.
 * Maintained independently of TypeScript AST emission so both source and built
 * artifacts compute the identical digest.
 */
export const PEER_WIRE_DESCRIPTORS: readonly PeerWireMethodDescriptor[] = [
  {
    method: 'peer.answer',
    mode: 'unary',
    request: [
      TARGET_FIELD,
      PARTICIPANT_FIELD,
      { name: 'askId', type: 'PeerAskId' },
      { name: 'requestId', type: 'PeerRequestId' },
      {
        name: 'answer',
        type: 'union',
        variants: [
          {
            tag: 'approval',
            fields: [
              { name: 'kind', type: '"approval"' },
              { name: 'outcome', type: '"allowed-once" | "rejected"' },
            ],
          },
          {
            tag: 'question',
            fields: [
              { name: 'kind', type: '"question"' },
              { name: 'answer', type: 'object', fields: [
                { name: 'answers', type: 'array', fields: [
                  { name: 'id', type: 'string' }, { name: 'selected', type: 'string[]' },
                  { name: 'custom', type: 'string', optional: true },
                ] },
              ] },
            ],
          },
        ],
      },
    ],
    response: [
      { name: 'accepted', type: 'true' },
      { name: 'settled', type: 'true' },
      { name: 'replayed', type: 'boolean' },
      { name: 'payloadHash', type: 'string' },
      { name: 'instanceId', type: 'string' },
    ],
  },
  {
    method: 'peer.asks',
    mode: 'unary',
    request: [{ name: 'alias', type: 'PeerAlias' }, { name: 'sessionId', type: 'SessionId', optional: true }],
    response: [{ name: 'instanceId', type: 'string' }, { name: 'asks', type: 'array',
      variants: ASK_VARIANTS.map(variant => ({ ...variant, fields: [...variant.fields, ...ASK_JOURNAL_FIELDS] })) }],
  },
  {
    method: 'peer.cancel',
    mode: 'unary',
    request: [TARGET_FIELD, PARTICIPANT_FIELD, { name: 'dropQueued', type: 'boolean', optional: true }],
    response: [
      { name: 'accepted', type: 'true' },
      { name: 'cancelled', type: 'boolean' },
      STOP_INTENT,
      { name: 'droppedQueued', type: 'number' },
    ],
  },
  {
    method: 'peer.create',
    mode: 'unary',
    request: [
      { name: 'alias', type: 'PeerAlias' },
      PARTICIPANT_FIELD,
      { name: 'requestId', type: 'PeerRequestId', optional: true },
      { name: 'sessionId', type: 'SessionId', optional: true },
      { name: 'workspaceId', type: 'string', optional: true },
      { name: 'cwd', type: 'string', optional: true },
      { name: 'agentPreset', type: 'string', optional: true },
      { name: 'provider', type: 'string', optional: true },
      { name: 'model', type: 'string', optional: true },
      { name: 'chain', type: 'string', optional: true },
      { name: 'reasoningEffort', type: 'string', optional: true },
      { name: 'maxTotalTokens', type: 'number', optional: true },
      {
        name: 'job',
        type: 'object',
        optional: true,
        fields: [
          { name: 'jobId', type: 'string' },
          { name: 'fence', type: 'number' },
          { name: 'expiresAt', type: 'number' },
          { name: 'capabilities', type: 'string[]' },
          { name: 'limits', type: 'object', fields: JOB_LIMITS_FIELDS },
          { name: 'mcpEndpointId', type: 'string', optional: true },
          { name: 'credentialRef', type: 'string', optional: true },
          { name: 'allowedToolNames', type: 'string[]', optional: true },
        ],
      },
    ],
    response: [
      { name: 'target', type: 'object', fields: RESOLVED_TARGET_FIELDS },
      { name: 'created', type: 'boolean' },
      { name: 'replayed', type: 'boolean', optional: true },
      { name: 'payloadHash', type: 'string', optional: true },
      { name: 'instanceId', type: 'string', optional: true },
      { name: 'profile', type: 'object', optional: true, fields: PROFILE_SUMMARY_FIELDS },
    ],
  },
  {
    method: 'peer.exportFetch',
    mode: 'unary',
    request: [
      { name: 'alias', type: 'PeerAlias' },
      { name: 'path', type: 'string' },
      { name: 'maxBytes', type: 'number', optional: true },
    ],
    response: [
      { name: 'path', type: 'string' },
      { name: 'bytes', type: 'number' },
      { name: 'sha256', type: 'string' },
      { name: 'contentBase64', type: 'string' },
    ],
  },
  {
    method: 'peer.exportList',
    mode: 'unary',
    request: [{ name: 'alias', type: 'PeerAlias' }],
    response: [
      {
        name: 'files',
        type: 'array',
        fields: [
          { name: 'path', type: 'string' },
          { name: 'bytes', type: 'number' },
          { name: 'mtimeMs', type: 'number' },
        ],
      },
      { name: 'truncated', type: 'boolean' },
    ],
  },
  {
    method: 'peer.follow',
    mode: 'stream',
    uplink: [{ name: 'type', type: '"ack"' }, { name: 'frame', type: 'number' }],
    request: [
      TARGET_FIELD,
      { name: 'maxMessages', type: 'number', optional: true },
      { name: 'assistantStream', type: 'true', optional: true },
    ],
    response: [],
    frames: [
      {
        type: 'snapshot',
        fields: [
          { name: 'target', type: 'object', fields: RESOLVED_TARGET_FIELDS },
          {
            name: 'header',
            type: 'object',
            fields: [
              { name: 'id', type: 'SessionId' },
              { name: 'version', type: 'number' },
              { name: 'createdAt', type: 'number' },
              { name: 'cwd', type: 'string', optional: true },
              { name: 'agentPreset', type: 'string', optional: true },
            ],
          },
          { name: 'cursor', type: 'SessionSeq' },
          { name: 'state', type: 'object', fields: EXECUTION_STATE_FIELDS },
          { name: 'records', type: 'array', fields: EVENT_RECORD_FIELDS },
          { name: 'hasMore', type: 'boolean' },
        ],
      },
      {
        type: 'event',
        fields: [
          { name: 'record', type: 'object', fields: EVENT_RECORD_FIELDS },
          { name: 'cursor', type: 'SessionSeq' },
        ],
      },
      {
        type: 'state',
        fields: [
          { name: 'state', type: 'object', fields: EXECUTION_STATE_FIELDS },
          { name: 'cursor', type: 'SessionSeq' },
        ],
      },
      {
        type: 'assistant-stream',
        fields: [{ name: 'frame', type: 'JsonValue' }],
      },
      {
        type: 'gap',
        fields: [
          { name: 'fromSeq', type: 'SessionSeq | null' }, { name: 'toSeq', type: 'SessionSeq | null' },
          { name: 'reason', type: 'queue-overflow|sequence-discontinuity|upstream-closed|open-timeout|idle-timeout|lifetime-limit' },
          { name: 'resync', type: '"refollow-and-page"' },
        ],
      },
      {
        type: 'end',
        fields: [{ name: 'reason', type: '"closed" | "target-detached"' }],
      },
    ],
  },
  {
    method: 'peer.handshake',
    mode: 'unary',
    request: [
      { name: 'protocolVersion', type: 'number' },
      { name: 'harnessVersion', type: 'string' },
      { name: 'schemaDigest', type: 'string' },
      { name: 'device', type: 'string' },
    ],
    response: [
      { name: 'protocolVersion', type: '1' },
      { name: 'harnessVersion', type: 'string' },
      { name: 'schemaDigest', type: 'string' },
      { name: 'methodsDigest', type: 'string', optional: true },
      { name: 'hostDevice', type: 'string' },
      { name: 'instanceId', type: 'string' },
      { name: 'capabilities', type: 'PeerCapability[]' },
      {
        name: 'pairings',
        type: 'array',
        fields: [
          { name: 'alias', type: 'PeerAlias' },
          { name: 'peer', type: 'string' },
          { name: 'exposure', type: '"answer-only" | "debug"' },
          { name: 'tokenRequired', type: 'boolean' },
          { name: 'target', type: 'object', optional: true, fields: RESOLVED_TARGET_FIELDS },
        ],
      },
    ],
  },
  {
    method: 'peer.jobUpdate',
    mode: 'unary',
    request: [
      { name: 'alias', type: 'PeerAlias' },
      { name: 'requestId', type: 'PeerRequestId' },
      { name: 'jobId', type: 'string' },
      { name: 'fence', type: 'number', optional: true },
      { name: 'expiresAt', type: 'number', optional: true },
      { name: 'revoked', type: 'boolean', optional: true },
    ],
    response: [
      { name: 'accepted', type: 'true' },
      { name: 'binding', type: 'object', fields: JOB_BINDING_FIELDS },
      { name: 'replayed', type: 'boolean' },
      { name: 'payloadHash', type: 'string' },
      { name: 'instanceId', type: 'string' },
    ],
  },
  {
    method: 'peer.list',
    mode: 'unary',
    requestOptional: true,
    request: [{ ...TARGET_FIELD, optional: true }],
    response: [
      { name: 'hostDevice', type: 'string' },
      {
        name: 'pairings',
        type: 'array',
        fields: [
          { name: 'alias', type: 'PeerAlias' },
          { name: 'peer', type: 'string' },
          { name: 'exposure', type: '"answer-only" | "debug"' },
          { name: 'bound', type: 'boolean' },
          { name: 'sessionId', type: 'SessionId', optional: true },
          { name: 'remoteSessionId', type: 'SessionId', optional: true },
          { name: 'latch', type: LATCH, optional: true },
          { name: 'lastActivity', type: 'number', optional: true },
          { name: 'summary', type: 'string' },
        ],
      },
    ],
  },
  {
    method: 'peer.models',
    mode: 'unary',
    request: [
      { name: 'alias', type: 'PeerAlias' },
      PARTICIPANT_FIELD,
      {
        name: 'filter',
        type: 'object',
        optional: true,
        fields: [
          { name: 'zeroPrice', type: 'boolean', optional: true },
          { name: 'tools', type: 'boolean', optional: true },
          { name: 'gated', type: 'boolean', optional: true },
          { name: 'minContextWindow', type: 'number', optional: true },
        ],
      },
      { name: 'cursor', type: 'string', optional: true },
      { name: 'limit', type: 'number', optional: true },
    ],
    response: [
      { name: 'chains', type: 'array', fields: [
        { name: 'id', type: 'string' }, { name: 'label', type: 'string', optional: true }, { name: 'dynamic', type: 'boolean' },
        { name: 'members', type: 'array', fields: [
          ...ROUTE_FIELDS, { name: 'state', type: 'ready|cooldown|deprecated' },
          { name: 'cooldownUntil', type: 'number', optional: true },
        ] },
      ] },
      { name: 'models', type: 'array', fields: [
        ...ROUTE_FIELDS,
        { name: 'tools', type: 'boolean|unknown' }, { name: 'vision', type: 'boolean|unknown' },
        { name: 'contextWindow', type: 'number', optional: true },
        { name: 'zeroPrice', type: 'boolean|unknown' }, { name: 'gated', type: 'boolean|unknown' },
        { name: 'trainsOnData', type: 'yes|no|unknown' }, { name: 'reasoningEfforts', type: 'string[]' },
      ] },
      { name: 'nextCursor', type: 'string', optional: true },
      {
        name: 'selectableByThisAlias',
        type: 'object',
        fields: [
          { name: 'chains', type: 'string[]' },
          { name: 'models', type: 'string[]' },
          { name: 'reasoningEfforts', type: 'string[]', optional: true },
          { name: 'requireZeroPrice', type: 'boolean' },
          { name: 'requireNoTraining', type: 'boolean' },
          { name: 'requireTools', type: 'boolean' },
          { name: 'allowSwitch', type: '"never" | "idle-only"' },
        ],
      },
    ],
  },
  {
    method: 'peer.page',
    mode: 'unary',
    request: [
      TARGET_FIELD,
      { name: 'throughSeq', type: 'SessionSeq' },
      { name: 'beforeSeq', type: 'SessionSeq', optional: true },
      { name: 'maxMessages', type: 'number', optional: true },
    ],
    response: [
      { name: 'records', type: 'array', fields: EVENT_RECORD_FIELDS },
      { name: 'hasMore', type: 'boolean' },
    ],
  },
  {
    method: 'peer.prompt',
    mode: 'unary',
    request: [
      TARGET_FIELD,
      PARTICIPANT_FIELD,
      { name: 'requestId', type: 'PeerRequestId' },
      { name: 'content', type: 'array', fields: [{ name: 'type', type: '"text"' }, { name: 'text', type: 'string' }] },
      { name: 'hopCount', type: 'number', optional: true },
    ],
    response: [
      { name: 'accepted', type: 'true' },
      { name: 'queued', type: 'boolean' },
      { name: 'hopCount', type: 'number' },
      { name: 'replayed', type: 'boolean', optional: true },
      { name: 'payloadHash', type: 'string', optional: true },
      { name: 'instanceId', type: 'string', optional: true },
      { name: 'disposition', type: PROMPT_DISPOSITION, optional: true },
      { name: 'terminalState', type: TERMINAL_OUTCOME, optional: true },
      { name: 'terminal', type: 'object', optional: true, fields: TURN_TERMINAL_FIELDS },
    ],
  },
  {
    method: 'peer.ready',
    mode: 'unary',
    request: [{ name: 'alias', type: 'PeerAlias' }],
    response: [
      { name: 'ready', type: 'boolean' },
      { name: 'missing', type: 'string[]' },
      { name: 'capabilities', type: 'PeerCapability[]' },
      { name: 'profile', type: 'object', optional: true, fields: PROFILE_SUMMARY_FIELDS },
      { name: 'instanceId', type: 'string' },
      { name: 'version', type: 'string' },
    ],
  },
  {
    method: 'peer.receipt',
    mode: 'unary',
    request: [
      { name: 'alias', type: 'PeerAlias' },
      { name: 'requestId', type: 'PeerRequestId' },
      { name: 'kind', type: '"create" | "prompt"', optional: true },
    ],
    response: [
      { name: 'found', type: 'boolean' },
      { name: 'kind', type: '"create" | "prompt"', optional: true },
      { name: 'sessionId', type: 'SessionId', optional: true },
      { name: 'payloadHash', type: 'string', optional: true },
      { name: 'instanceId', type: 'string', optional: true },
      { name: 'phase', type: '"prepared" | "finalized"', optional: true },
      { name: 'replayedAcrossRestart', type: 'boolean' },
      { name: 'disposition', type: `${PROMPT_DISPOSITION}|created|adopted` },
      { name: 'terminalState', type: TERMINAL_OUTCOME, optional: true },
      { name: 'terminal', type: 'object', optional: true, fields: TURN_TERMINAL_FIELDS },
      { name: 'acceptedAt', type: 'number', optional: true },
      { name: 'finalizedAt', type: 'number', optional: true },
    ],
  },
  {
    method: 'peer.selectModel',
    mode: 'unary',
    request: [
      TARGET_FIELD,
      PARTICIPANT_FIELD,
      { name: 'requestId', type: 'PeerRequestId' },
      { name: 'provider', type: 'string' },
      { name: 'model', type: 'string' },
      { name: 'chain', type: 'string', optional: true },
      { name: 'reasoningEffort', type: 'string', optional: true },
    ],
    response: [
      { name: 'accepted', type: 'true' },
      { name: 'selected', type: 'object', fields: MODEL_SELECTION_FIELDS },
      { name: 'previous', type: 'object', optional: true, fields: MODEL_SELECTION_FIELDS },
      { name: 'replayed', type: 'boolean' },
      { name: 'receiptPersisted', type: 'boolean', optional: true },
    ],
  },
  {
    method: 'peer.state',
    mode: 'unary',
    request: [TARGET_FIELD],
    response: STATE_RESPONSE,
  },
  {
    method: 'peer.waitQuiescent',
    mode: 'unary',
    request: [{ name: 'alias', type: 'PeerAlias' }, { name: 'timeoutMs', type: 'number' }],
    response: [
      { name: 'observation', type: '"observed"' },
      { name: 'timedOut', type: 'boolean' },
      { name: 'last', type: 'object', optional: true, fields: STATE_RESPONSE },
    ],
  },
]

function canonicalizeField(field: PeerWireFieldDescriptor): Record<string, unknown> {
  return {
    name: field.name,
    optional: field.optional === true,
    type: field.type,
    ...(field.fields === undefined ? {} : { fields: field.fields.map(canonicalizeField) }),
    ...(field.variants === undefined
      ? {}
      : {
        variants: field.variants.map(variant => ({
          fields: variant.fields.map(canonicalizeField),
          tag: variant.tag,
        })),
      }),
  }
}

function canonicalizeMethod(descriptor: PeerWireMethodDescriptor): Record<string, unknown> {
  return {
    ...(descriptor.frames === undefined
      ? {}
      : {
        frames: descriptor.frames.map(frame => ({
          fields: frame.fields.map(canonicalizeField),
          type: frame.type,
        })),
      }),
    method: descriptor.method,
    mode: descriptor.mode,
    request: descriptor.request.map(canonicalizeField),
    requestOptional: descriptor.requestOptional === true,
    response: descriptor.response.map(canonicalizeField),
    ...(descriptor.uplink === undefined ? {} : { uplink: descriptor.uplink.map(canonicalizeField) }),
  }
}

/**
 * Compute the canonical SHA-256 digest over protocol version, method names,
 * modes, and full request/response/frame field descriptors.
 * @param descriptors - wire descriptor list for all `peer.*` methods.
 * @param protocolVersion - peer protocol version number.
 * @returns lowercase hex SHA-256 digest.
 */
export function computePeerSchemaDigest(
  descriptors: readonly PeerWireMethodDescriptor[],
  protocolVersion: number = WIRE_PROTOCOL_VERSION,
): string {
  const canonical = [...descriptors]
    .sort((left, right) => left.method < right.method ? -1 : left.method > right.method ? 1 : 0)
    .map(canonicalizeMethod)
  return createHash('sha256')
    .update(JSON.stringify({ protocolVersion, methods: canonical }))
    .digest('hex')
}

/**
 * Compute the legacy compatibility digest over protocol version and sorted
 * method names only.
 * @param descriptors - wire descriptor list for all `peer.*` methods.
 * @param protocolVersion - peer protocol version number.
 * @returns lowercase hex SHA-256 digest.
 */
export function computePeerMethodsDigest(
  descriptors: readonly PeerWireMethodDescriptor[],
  protocolVersion: number = WIRE_PROTOCOL_VERSION,
): string {
  const names = [...descriptors].map(descriptor => descriptor.method).sort()
  return createHash('sha256')
    .update(`${String(protocolVersion)}:${names.join(',')}`)
    .digest('hex')
}

/** Canonical SHA-256 over method names plus request/response field descriptors. */
export const PEER_SCHEMA_DIGEST = computePeerSchemaDigest(PEER_WIRE_DESCRIPTORS, WIRE_PROTOCOL_VERSION)

/** Legacy compatibility digest over protocol version and method names only. */
export const PEER_METHODS_DIGEST = computePeerMethodsDigest(PEER_WIRE_DESCRIPTORS, WIRE_PROTOCOL_VERSION)
