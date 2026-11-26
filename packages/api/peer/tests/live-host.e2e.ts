// Live-host acceptance for the peer API: boots the real `dsh web` composition
// with the peer namespace inserted through a `--patch` overlay, authenticates
// with the loopback launch token, and drives `peer.*` over HTTP/WS. No model
// calls: create/adopt/state/follow/page/cancel and the failure vocabulary are
// model-free, while turn semantics live in the in-process host spec.
import { brandNumber, brandString } from '@deepseek-ai/dsh-brand'
import { once } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { PeerClient } from '../src/client.ts'
import type { PeerAlias, PeerFollowFrame } from '../src/types.ts'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const OVERLAY = fileURLToPath(new URL('./peer.overlay.yml', import.meta.url))
const children: ChildProcess[] = []
const roots: string[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        child.once('exit', () => { resolve() })
        setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
        }, 5_000)
      })
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function waitForReadyLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => { reject(new Error(`dsh web not ready in 120s; output:\n${out}`)) }, 120_000)
    const onData = (chunk: Buffer): void => {
      out += chunk.toString()
      const match = /dsh web: (http:\/\/[^\s]+)/u.exec(out)
      if (match?.[1] === undefined) return
      clearTimeout(timer)
      resolve(match[1])
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`dsh web exited early (code ${String(code)}); output:\n${out}`))
    })
  })
}

async function authenticatedClient(
  launchUrl: string,
  device: string,
  outboundToken?: string,
): Promise<{ client: PeerClient; cookie: string }> {
  const response = await fetch(launchUrl, { redirect: 'manual' })
  const setCookie = response.headers.get('set-cookie')
  if (response.status !== 303 || setCookie === null) {
    throw new Error(`dsh web authentication returned HTTP ${String(response.status)}`)
  }
  const cookie = setCookie.split(';', 1)[0]!
  return {
    cookie,
    client: new PeerClient({
      endpoint: new URL(launchUrl).origin,
      device,
      ...(outboundToken === undefined ? {} : { outboundToken }),
      headers: { cookie },
      webSocket: (url: string, headers?: Readonly<Record<string, string>>) =>
        new WebSocket(url, headers === undefined ? { headers: { cookie } } : { headers }),
    }),
  }
}

describe('peer API against a live dsh web host', () => {
  it('serves the narrow peer surface over the loopback launch token', async () => {
    if (!existsSync(join(REPO_ROOT, 'packages/api/peer/lib/index.js'))) {
      throw new Error('peer live-host e2e requires the built artifact; run `pnpm --filter @deepseek-ai/dsh-api-peer build`')
    }
    const root = mkdtempSync(join(tmpdir(), 'peer-e2e-'))
    roots.push(root)
    const dshHome = join(root, '.dsh')
    const work = join(root, 'work')
    const pairingsPath = join(dshHome, 'pairings.yaml')
    const bindingsPath = join(dshHome, 'peer-state.json')
    mkdirSync(dshHome, { recursive: true })
    mkdirSync(work, { recursive: true })
    const bearerToken = 'e2e-live-token'
    writeFileSync(pairingsPath, [
      'version: 1',
      'device: e2e-server',
      'pairings:',
      '  - alias: e2e',
      '    peer: laptop',
      '    exposure: debug',
      `    inboundToken: ${bearerToken}`,
      '    create:',
      `      cwd: ${work}`,
      '  - alias: legacy-unauthed',
      '    peer: pc',
      '    exposure: debug',
      '    endpoint: http://100.98.71.68:3080',
      '    create:',
      `      cwd: ${work}`,
    ].join('\n'), { mode: 0o600 })

    const tsxLoader = pathToFileURL(createRequire(join(REPO_ROOT, 'package.json')).resolve('tsx')).href
    const child = spawn(
      process.execPath,
      [
        '--import', tsxLoader, join(REPO_ROOT, 'apps/cli/src/bin.ts'),
        'web', '--patch', OVERLAY, '--no-open', '--port', '0',
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: 'keyless-web-no-call',
          DSH_HOME: dshHome,
          DSH_AGENTS_HOME: join(root, '.agents'),
          DSH_PEER_TEST_PAIRINGS: pairingsPath,
          DSH_PEER_TEST_BINDINGS: bindingsPath,
          TSX_TSCONFIG_PATH: join(REPO_ROOT, 'tsconfig.json'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    children.push(child)
    const launchUrl = await waitForReadyLine(child)
    const { client, cookie } = await authenticatedClient(launchUrl, 'laptop', bearerToken)
    const unauthedClient = new PeerClient({
      endpoint: new URL(launchUrl).origin,
      device: 'laptop',
      headers: { cookie },
      webSocket: (url: string, headers?: Readonly<Record<string, string>>) =>
        new WebSocket(url, headers === undefined ? { headers: { cookie } } : { headers }),
    })
    const wrongBearerClient = new PeerClient({
      endpoint: new URL(launchUrl).origin,
      device: 'laptop',
      outboundToken: 'wrong-bearer-token',
      headers: { cookie },
      webSocket: (url: string, headers?: Readonly<Record<string, string>>) =>
        new WebSocket(url, headers === undefined ? { headers: { cookie } } : { headers }),
    })

    // Wrong or missing bearer token fails uniformly before accessing token-protected or unauthenticated-legacy pairings.
    await expect(unauthedClient.create({
      alias: 'e2e' as never,
      participant: { kind: 'peer', name: 'laptop' },
    })).rejects.toMatchObject({ code: 'peer/forbidden', details: { reason: 'unauthorized' } })
    await expect(unauthedClient.create({
      alias: 'legacy-unauthed' as never,
      participant: { kind: 'peer', name: 'pc' },
    })).rejects.toMatchObject({ code: 'peer/forbidden', details: { reason: 'unauthorized' } })

    const handshake = await client.handshake()
    expect(handshake).toMatchObject({ hostDevice: 'e2e-server', protocolVersion: 1 })
    expect(handshake.pairings.map(pairing => pairing.alias)).toEqual(['e2e'])
    expect(handshake.pairings[0]?.tokenRequired).toBe(true)

    // Version skew crosses the real HTTP envelope as a structured peer failure.
    const skew = await fetch(`${new URL(launchUrl).origin}/api/peer/handshake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, authorization: `Bearer ${bearerToken}` },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'skew',
        method: 'peer/handshake',
        payload: { args: { request: { protocolVersion: 9, harnessVersion: 'x', schemaDigest: 'y', device: 'laptop' } } },
      }),
    })
    const skewBody = await skew.json() as { result: { ok: false; error: { code: string } } }
    expect(skewBody.result.ok).toBe(false)
    expect(skewBody.result.error.code).toBe('peer/version-skew')

    const created = await client.create({
      alias: 'e2e' as never,
      participant: { kind: 'peer', name: 'laptop' },
    })
    expect(created.created).toBe(true)
    expect(readFileSync(bindingsPath, 'utf8')).toContain(created.target.sessionId)
    const sessionTarget = { kind: 'session', sessionId: created.target.sessionId } as const

    const state = await client.state(sessionTarget)
    // A live host answers `session.executionState`, so the peer reads the host
    // latch verbatim instead of deriving it (doc 70 §10 D2).
    expect(state.state).toMatchObject({
      latch: 'idle',
      source: 'host-latch',
      activeDescendants: 0,
      descendantsExact: true,
    })
    expect(state.state.model).toBeDefined()

    // `peer.follow` over /api/remote.mux verifies the upgrade Authorization bearer token:
    // valid bearer succeeds, while missing or wrong bearer fails uniformly.
    const followTarget = { kind: 'alias', alias: brandString<PeerAlias>('e2e') } as const
    await expect((async () => {
      for await (const _frame of unauthedClient.followOnce({ target: followTarget }, new AbortController().signal)) {
        break
      }
    })()).rejects.toMatchObject({ code: 'peer/forbidden', details: { reason: 'unauthorized' } })
    await expect((async () => {
      for await (const _frame of wrongBearerClient.followOnce({ target: followTarget }, new AbortController().signal)) {
        break
      }
    })()).rejects.toMatchObject({ code: 'peer/forbidden', details: { reason: 'unauthorized' } })

    let snapshot: PeerFollowFrame | undefined
    const controller = new AbortController()
    for await (const frame of client.followOnce({ target: followTarget }, controller.signal)) {
      snapshot = frame
      break
    }
    controller.abort()
    expect(snapshot?.type).toBe('snapshot')
    const cursor = snapshot?.type === 'snapshot' ? snapshot.cursor : brandNumber<SessionSeq>(-1)
    const page = await client.page({ target: followTarget, throughSeq: cursor, maxMessages: 10 })
    expect(page.hasMore).toBe(false)

    // A raw client opens a logical stream, then stops reading and never ACKs.
    // Resume only after the host's idle deadline to inspect its terminal wire data.
    const raw = new WebSocket(`${new URL(launchUrl).origin.replace('http:', 'ws:')}/api/remote.mux`, {
      headers: { cookie, authorization: `Bearer ${bearerToken}` },
    })
    try {
      await once(raw, 'open')
      const frames: object[] = []
      const terminal = Promise.withResolvers<object>()
      raw.on('message', (data) => {
        const text = Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : Buffer.isBuffer(data)
            ? data.toString('utf8')
            : Buffer.from(data).toString('utf8')
        const frame = JSON.parse(text) as { type: string }
        frames.push(frame)
        if (frame.type === 'error' || frame.type === 'end') terminal.resolve(frame)
      })
      raw.send(JSON.stringify({ type: 'open', streamId: 'silent', endpoint: 'peer/follow', payload: { args: { request: { target: followTarget } } } }))
      raw.pause()
      await new Promise(resolve => setTimeout(resolve, 1_250))
      raw.resume()
      const timeout = AbortSignal.timeout(2_000)
      const expired = new Promise<never>((_resolve, reject) => {
        timeout.addEventListener('abort', () => { reject(new Error('idle follow did not terminate')) }, { once: true })
      })
      await expect(Promise.race([terminal.promise, expired])).resolves.toMatchObject({ type: 'error', error: { code: 'peer/gap' } })
      const gap = frames.find(frame => 'value' in frame && typeof frame.value === 'object' && frame.value !== null
        && 'type' in frame.value && frame.value.type === 'gap')
      expect(gap).toMatchObject({ type: 'item', value: { type: 'gap', reason: 'idle-timeout', resync: 'refollow-and-page' } })
    } finally {
      raw.terminate()
    }

    expect(await client.cancel({ target: followTarget, participant: { kind: 'peer', name: 'laptop' } }))
      .toMatchObject({ accepted: true, cancelled: false })

    const adopted = await client.create({
      alias: 'e2e' as never,
      participant: { kind: 'peer', name: 'laptop' },
      sessionId: created.target.sessionId,
    })
    expect(adopted.created).toBe(false)

    try {
      await client.state({ kind: 'alias', alias: 'missing' as never })
      throw new Error('expected peer/forbidden')
    } catch (error) {
      expect((error as RemoteError).code).toBe('peer/forbidden')
      expect((error as RemoteError).details).toEqual({ reason: 'unauthorized' })
    }

    // A reachable-but-wrong endpoint fails fast with the caller-side outcome.
    const dead = new PeerClient({
      endpoint: 'http://127.0.0.1:1',
      device: 'laptop',
      backoff: { initialMs: 5, maxMs: 10, factor: 2 },
      maxReconnects: 1,
    })
    try {
      await dead.state(sessionTarget)
      throw new Error('expected peer/target-unreachable')
    } catch (error) {
      expect((error as RemoteError).code).toBe('peer/target-unreachable')
    }
  })
})
