// Two-host acceptance for fleet-registry pairing generation: a scratch fleet
// registry is rendered into two `$DSH_HOME/pairings.yaml` documents by the real
// `profile/web/scripts/generate-pairings.mjs` (with a fake `tailscale` proving
// the live-IPv4 lookup wins over the registry fallback), and two real `dsh web`
// hosts boot with those documents through the peer overlay. `peer.handshake`,
// `peer.create`, and `peer.prompt` then run over loopback in BOTH directions,
// which only succeeds when both files carry the same alias string for the
// pairing. No model calls: prompt admission is the assertion, and teardown
// kills the turn.
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ChildProcess } from 'node:child_process'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { PeerClient } from '../src/client.ts'
import type { PeerAlias, PeerRequestId } from '../src/types.ts'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const OVERLAY = fileURLToPath(new URL('./pairings.overlay.yml', import.meta.url))
const GENERATOR = join(REPO_ROOT, 'profile/web/scripts/generate-pairings.mjs')
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

/** A fake `tailscale` answering the two probes the generator makes. */
function fakeTailscale(binDir: string): string {
  mkdirSync(binDir, { recursive: true })
  const status = JSON.stringify({
    Self: { HostName: 'e2e-hub', DNSName: 'e2e-hub.example.ts.net.', TailscaleIPs: ['127.0.0.1'] },
    Peer: {
      member: { HostName: 'e2e-member', DNSName: 'e2e-member.example.ts.net.', TailscaleIPs: ['127.0.0.1'] },
    },
  })
  const script = `#!/bin/sh
if [ "$1" = "status" ]; then
  printf '%s\\n' '${status}'
  exit 0
fi
if [ "$1" = "ip" ]; then
  printf '%s\\n' '127.0.0.1'
  exit 0
fi
exit 1
`
  const path = join(binDir, 'tailscale')
  writeFileSync(path, script)
  chmodSync(path, 0o755)
  return binDir
}

function bootHost(name: string, root: string): ChildProcess {
  const dshHome = join(root, name, '.dsh')
  mkdirSync(dshHome, { recursive: true })
  const tsxLoader = pathToFileURL(createRequire(join(REPO_ROOT, 'package.json')).resolve('tsx')).href
  const child = spawn(
    process.execPath,
    [
      '--import', tsxLoader, join(REPO_ROOT, 'apps/cli/src/bin.ts'),
      'web', '--patch', OVERLAY, '--no-open', '--port', '0',
    ],
    {
      cwd: join(root, name),
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: 'keyless-web-no-call',
        DSH_HOME: dshHome,
        DSH_AGENTS_HOME: join(root, name, '.agents'),
        DSH_PEER_TEST_PAIRINGS: join(dshHome, 'pairings.yaml'),
        DSH_PEER_TEST_BINDINGS: join(dshHome, 'peer-state.json'),
        TSX_TSCONFIG_PATH: join(REPO_ROOT, 'tsconfig.json'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  children.push(child)
  return child
}

function runGenerator(options: { device: string; dshHome: string; registryPath: string; path: string }): string {
  const result = spawnSync(process.execPath, [GENERATOR], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DSH_HOME: options.dshHome,
      DSH_HARNESS: REPO_ROOT,
      DSH_PEER_DEVICE: options.device,
      DSH_PEER_REGISTRY: options.registryPath,
      PATH: options.path,
    },
    encoding: 'utf8',
  })
  expect(result.status).toBe(0)
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

async function authenticatedClient(origin: string, launchUrl: string, device: string): Promise<{ client: PeerClient; cookie: string }> {
  const response = await fetch(launchUrl, { redirect: 'manual' })
  const setCookie = response.headers.get('set-cookie')
  if (response.status !== 303 || setCookie === null) {
    throw new Error(`dsh web authentication returned HTTP ${String(response.status)}`)
  }
  const cookie = setCookie.split(';', 1)[0]!
  return {
    cookie,
    client: new PeerClient({
      endpoint: origin,
      device,
      headers: { cookie },
      webSocket: (url: string) => new WebSocket(url, { headers: { cookie } }),
    }),
  }
}

describe('generated fleet pairings drive a two-host round trip', () => {
  it('renders both devices from one registry and serves peer calls in both directions', async () => {
    if (!existsSync(join(REPO_ROOT, 'packages/api/peer/lib/index.js'))) {
      throw new Error('pairing generation e2e requires the built peer artifact; run `pnpm --filter @deepseek-ai/dsh-api-peer build`')
    }
    const root = mkdtempSync(join(tmpdir(), 'peer-fleet-e2e-'))
    roots.push(root)
    const fakeBin = fakeTailscale(join(root, 'bin'))
    const path = `${fakeBin}:${process.env.PATH ?? ''}`

    // Boot both hosts first: their OS-assigned ports become the registry's
    // per-member ports, and the pairings documents are rendered after boot
    // (the store re-reads on the file's mtime change).
    const hubChild = bootHost('hub', root)
    const memberChild = bootHost('member', root)
    const [hubLaunch, memberLaunch] = await Promise.all([waitForReadyLine(hubChild), waitForReadyLine(memberChild)])
    const hubOrigin = new URL(hubLaunch).origin
    const memberOrigin = new URL(memberLaunch).origin
    expect(hubOrigin).not.toBe(memberOrigin)

    const registryPath = join(root, 'fleet.yaml')
    writeFileSync(registryPath, [
      'version: 1',
      'hub: e2e-hub',
      'members:',
      '  - name: e2e-hub',
      '    exposure: debug',
      '    create: orchestrator',
      '    hostnames: [e2e-hub]',
      '    ip: 10.255.255.1',
      `    port: ${new URL(hubOrigin).port}`,
      '  - name: e2e-member',
      '    exposure: debug',
      '    create: orchestrator',
      '    hostnames: [e2e-member]',
      '    ip: 10.255.255.2',
      `    port: ${new URL(memberOrigin).port}`,
      '',
    ].join('\n'))

    const hubHome = join(root, 'hub', '.dsh')
    const memberHome = join(root, 'member', '.dsh')
    expect(runGenerator({ device: 'e2e-hub', dshHome: hubHome, registryPath, path })).toContain('wrote')
    expect(runGenerator({ device: 'e2e-member', dshHome: memberHome, registryPath, path })).toContain('wrote')

    // The live tailnet IPv4 wins over the registry fallback, and the alias is
    // the member's own name on BOTH sides of the pairing.
    const hubDocument = readFileSync(join(hubHome, 'pairings.yaml'), 'utf8')
    const memberDocument = readFileSync(join(memberHome, 'pairings.yaml'), 'utf8')
    expect(hubDocument).toContain('device: e2e-hub')
    expect(hubDocument).toContain('alias: e2e-member')
    expect(hubDocument).toContain('peer: e2e-member')
    expect(hubDocument).toContain(`endpoint: http://127.0.0.1:${new URL(memberOrigin).port}`)
    expect(hubDocument).not.toContain('10.255.255')
    expect(memberDocument).toContain('device: e2e-member')
    expect(memberDocument).toContain('alias: e2e-member')
    expect(memberDocument).toContain('peer: e2e-hub')
    expect(memberDocument).toContain(`endpoint: http://127.0.0.1:${new URL(hubOrigin).port}`)

    // Direction 1: the member addresses the hub through its own alias.
    const memberSide = await authenticatedClient(hubOrigin, hubLaunch, 'e2e-member')
    const hubHandshake = await memberSide.client.handshake()
    expect(hubHandshake).toMatchObject({ hostDevice: 'e2e-hub', protocolVersion: 1 })
    expect(hubHandshake.pairings.map(pairing => pairing.alias)).toContain('e2e-member')
    const createdOnHub = await memberSide.client.create({
      alias: brandString<PeerAlias>('e2e-member'),
      participant: { kind: 'peer', name: 'e2e-member' },
    })
    expect(createdOnHub.created).toBe(true)
    expect(createdOnHub.target).toMatchObject({ device: 'e2e-member', alias: 'e2e-member', exposure: 'debug' })
    const promptOnHub = await memberSide.client.prompt({
      target: { kind: 'session', sessionId: createdOnHub.target.sessionId },
      participant: { kind: 'peer', name: 'e2e-member' },
      requestId: brandString<PeerRequestId>('fleet-e2e-member-to-hub'),
      content: [{ type: 'text', text: 'round trip member to hub' }],
      hopCount: 0,
    })
    expect(promptOnHub).toMatchObject({ accepted: true, queued: true, hopCount: 1 })

    // Direction 2: the hub addresses the member through the same alias string.
    const hubSide = await authenticatedClient(memberOrigin, memberLaunch, 'e2e-hub')
    const memberHandshake = await hubSide.client.handshake()
    expect(memberHandshake).toMatchObject({ hostDevice: 'e2e-member', protocolVersion: 1 })
    expect(memberHandshake.pairings.map(pairing => pairing.alias)).toContain('e2e-member')
    const createdOnMember = await hubSide.client.create({
      alias: brandString<PeerAlias>('e2e-member'),
      participant: { kind: 'peer', name: 'e2e-hub' },
    })
    expect(createdOnMember.created).toBe(true)
    expect(createdOnMember.target).toMatchObject({ device: 'e2e-hub', alias: 'e2e-member', exposure: 'debug' })
    const promptOnMember = await hubSide.client.prompt({
      target: { kind: 'session', sessionId: createdOnMember.target.sessionId },
      participant: { kind: 'peer', name: 'e2e-hub' },
      requestId: brandString<PeerRequestId>('fleet-e2e-hub-to-member'),
      content: [{ type: 'text', text: 'round trip hub to member' }],
      hopCount: 0,
    })
    expect(promptOnMember).toMatchObject({ accepted: true, queued: true, hopCount: 1 })

    // Stop the keyless turns before teardown.
    await hubSide.client.cancel({
      target: { kind: 'session', sessionId: createdOnMember.target.sessionId },
      participant: { kind: 'peer', name: 'e2e-hub' },
    })
    await memberSide.client.cancel({
      target: { kind: 'session', sessionId: createdOnHub.target.sessionId },
      participant: { kind: 'peer', name: 'e2e-member' },
    })
  }, 300_000)
})
