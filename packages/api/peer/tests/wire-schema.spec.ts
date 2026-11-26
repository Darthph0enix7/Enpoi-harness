import { describe, expect, it } from 'vitest'
import {
  PEER_METHODS_DIGEST,
  PEER_SCHEMA_DIGEST,
  PEER_WIRE_DESCRIPTORS,
  computePeerMethodsDigest,
  computePeerSchemaDigest,
  type PeerWireFieldDescriptor,
  type PeerWireMethodDescriptor,
} from '../src/wire-schema.ts'

function cloneDescriptors(): PeerWireMethodDescriptor[] {
  return JSON.parse(JSON.stringify(PEER_WIRE_DESCRIPTORS)) as PeerWireMethodDescriptor[]
}

/** Mutable view of one cloned descriptor field, so tests can edit the clone. */
interface MutableField {
  name: string
  type: string
  optional?: boolean
  fields?: MutableField[]
}

function mutableField(fields: readonly PeerWireFieldDescriptor[] | undefined, name: string): MutableField {
  const found = fields?.find(field => field.name === name)
  if (found === undefined) throw new Error(`descriptor field "${name}" is missing`)
  return found as MutableField
}

describe('peer wire schema digest', () => {
  it('derives distinct schema and methods digests from a TS-independent descriptor table', () => {
    expect(PEER_SCHEMA_DIGEST).toMatch(/^[0-9a-f]{64}$/u)
    expect(PEER_METHODS_DIGEST).toMatch(/^[0-9a-f]{64}$/u)
    expect(PEER_SCHEMA_DIGEST).not.toBe(PEER_METHODS_DIGEST)
    expect(computePeerSchemaDigest(PEER_WIRE_DESCRIPTORS, 1)).toBe(PEER_SCHEMA_DIGEST)
    expect(computePeerMethodsDigest(PEER_WIRE_DESCRIPTORS, 1)).toBe(PEER_METHODS_DIGEST)
    expect(computePeerSchemaDigest(PEER_WIRE_DESCRIPTORS, 2)).not.toBe(PEER_SCHEMA_DIGEST)
  })

  it('covers every peer wire method including new worker and export endpoints', () => {
    const methods = PEER_WIRE_DESCRIPTORS.map(descriptor => descriptor.method)
    expect(methods).toEqual(expect.arrayContaining([
      'peer.handshake',
      'peer.list',
      'peer.state',
      'peer.create',
      'peer.prompt',
      'peer.receipt',
      'peer.jobUpdate',
      'peer.ready',
      'peer.exportList',
      'peer.exportFetch',
      'peer.cancel',
      'peer.answer',
      'peer.asks',
      'peer.waitQuiescent',
      'peer.page',
      'peer.follow',
      'peer.models',
      'peer.selectModel',
    ]))
  })

  it('hashes the follow gap and answer request identity', () => {
    const descriptors = cloneDescriptors()
    const gap = descriptors.find(d => d.method === 'peer.follow')?.frames?.find(frame => frame.type === 'gap')
    expect(gap?.fields.map(field => field.name)).toEqual(['fromSeq', 'toSeq', 'reason', 'resync'])
    const answer = descriptors.find(d => d.method === 'peer.answer')
    expect(answer?.request.find(field => field.name === 'requestId')?.optional).not.toBe(true)
    expect(answer?.request.some(field => field.name === 'requestId')).toBe(true)
    const changed = descriptors.map(d => d.frames === undefined ? d : { ...d, frames: d.frames.filter(f => f.type !== 'gap') })
    expect(computePeerSchemaDigest(changed)).not.toBe(PEER_SCHEMA_DIGEST)
    expect(computePeerMethodsDigest(changed)).toBe(PEER_METHODS_DIGEST)
  })

  it('hashes the cancel request option and confirmed removal count', () => {
    const cancel = PEER_WIRE_DESCRIPTORS.find(d => d.method === 'peer.cancel')!
    expect(cancel.request).toContainEqual({ name: 'dropQueued', type: 'boolean', optional: true })
    expect(cancel.response).toContainEqual({ name: 'droppedQueued', type: 'number' })
    const changed = PEER_WIRE_DESCRIPTORS.map(d => d === cancel ? {
      ...d, request: d.request.filter(f => f.name !== 'dropQueued'),
      response: d.response.filter(f => f.name !== 'droppedQueued'),
    } : d)
    expect(computePeerSchemaDigest(changed)).not.toBe(PEER_SCHEMA_DIGEST)
    expect(computePeerMethodsDigest(changed)).toBe(PEER_METHODS_DIGEST)
  })

  it('changes schemaDigest whenever any request or response field name or optionality changes', () => {
    const baseline = PEER_SCHEMA_DIGEST

    // Mutate a top-level request field name.
    const renamedReq = cloneDescriptors()
    const createDesc = renamedReq.find(d => d.method === 'peer.create')!
    const mutableReqField = createDesc.request[0] as { name: string }
    mutableReqField.name = 'aliasRenamed'
    expect(computePeerSchemaDigest(renamedReq, 1)).not.toBe(baseline)

    // Mutate a top-level response field optionality.
    const optionalResp = cloneDescriptors()
    const readyDesc = optionalResp.find(d => d.method === 'peer.ready')!
    const mutableRespField = readyDesc.response.find(f => f.name === 'ready') as { optional?: boolean }
    mutableRespField.optional = !(mutableRespField.optional === true)
    expect(computePeerSchemaDigest(optionalResp, 1)).not.toBe(baseline)

    // Mutate a nested field name inside peer.create.job.
    const nestedReq = cloneDescriptors()
    const nestedCreate = nestedReq.find(d => d.method === 'peer.create')!
    const nestedLimits = mutableField(mutableField(nestedCreate.request, 'job').fields, 'limits')
    nestedLimits.fields![0]!.name = 'maxStepsChanged'
    expect(computePeerSchemaDigest(nestedReq, 1)).not.toBe(baseline)

    // Mutate nested optionality inside peer.create.job.limits.
    const nestedOpt = cloneDescriptors()
    const nestedOptCreate = nestedOpt.find(d => d.method === 'peer.create')!
    const nestedOptLimits = mutableField(mutableField(nestedOptCreate.request, 'job').fields, 'limits')
    nestedOptLimits.fields![0]!.optional = !(nestedOptLimits.fields![0]!.optional === true)
    expect(computePeerSchemaDigest(nestedOpt, 1)).not.toBe(baseline)

    // Mutate a stream frame field in peer.follow.
    const streamMut = cloneDescriptors()
    const followDesc = streamMut.find(d => d.method === 'peer.follow')!
    const snapshotFrame = followDesc.frames!.find(f => f.type === 'snapshot')!
    const frameField = snapshotFrame.fields[0] as { name: string }
    frameField.name = 'targetRenamed'
    expect(computePeerSchemaDigest(streamMut, 1)).not.toBe(baseline)
  })
})
