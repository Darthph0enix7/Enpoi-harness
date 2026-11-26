/** Record configured systemd properties separately from observed fixture behavior. */
import { spawn } from 'node:child_process'
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { randomUUID, createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { workerBundleDirectory, workerManifest } from './worker-profile.mjs'

const release = fileURLToPath(new URL('..', import.meta.url))
const unit = fileURLToPath(new URL('../profile/web/systemd/dsh-worker@.service', import.meta.url))
const propertyNames = [
  'StateDirectory', 'StateDirectoryMode', 'UMask', 'NoNewPrivileges', 'PrivateUsers', 'ProtectHome', 'BindPaths',
  'BindReadOnlyPaths', 'ProtectSystem', 'PrivateTmp', 'PrivateDevices', 'ProtectKernelTunables', 'ProtectKernelModules',
  'ProtectKernelLogs', 'ProtectControlGroups', 'InaccessiblePaths', 'RestrictAddressFamilies', 'CapabilityBoundingSet',
  'MemoryMax', 'CPUQuota', 'TasksMax', 'RuntimeMaxSec', 'TimeoutStopSec', 'KillMode', 'Restart', 'IPAddressDeny',
]
const reportNames = [...propertyNames, 'MainPID', 'ActiveState', 'SubState', 'Result', 'ExecMainCode', 'ExecMainStatus',
  'IPAddressAllow', 'CPUQuotaPerSecUSec', 'RuntimeMaxUSec', 'TimeoutStopUSec', 'ControlGroup']
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'PATH'].includes(name)))
env.LANG = 'C'

function command(bin, args) {
  return new Promise(resolve => {
    const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let errorCode
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000)
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout = (stdout + chunk).slice(-65536) })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-65536) })
    child.on('error', error => { errorCode = error.code })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr, errorCode })
    })
  })
}

async function observe(name) {
  const result = await command('systemctl', ['--user', 'show', name, ...reportNames.map(key => `--property=${key}`)])
  return {
    exitCode: result.code,
    properties: Object.fromEntries(result.stdout.trim().split('\n').flatMap(line => {
      const split = line.indexOf('=')
      return split < 0 ? [] : [[line.slice(0, split), line.slice(split + 1)]]
    })),
    ...(result.code === 0 ? {} : { error: result.errorCode ?? result.stderr.trim() }),
  }
}

async function peerReady() {
  const { WORKER_EVIDENCE_READY_ORIGIN: raw, WORKER_EVIDENCE_AUTH_FILE: file, WORKER_EVIDENCE_ALIAS: alias } = process.env
  if (raw === undefined || file === undefined || alias === undefined) return { reason: 'no authenticated peer.ready endpoint requested' }
  try {
    const origin = new URL(raw)
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.origin !== raw) return { reason: 'peer.ready must use an exact loopback HTTP origin' }
    const token = readFileSync(file, 'utf8').trim()
    const res = await fetch(new URL('/api/peer/ready', origin), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(1500),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'evidence', method: 'peer/ready', payload: { args: { request: { alias } } } }),
    })
    const result = (await res.json()).result
    const hash = result?.value?.profile?.hash
    return result?.ok === true && typeof hash === 'string' && /^[0-9a-f]{64}$/u.test(hash)
      ? { hash, source: 'peer.ready', version: typeof result.value.version === 'string' ? result.value.version : undefined }
      : { reason: 'peer.ready did not return a bound profile hash' }
  } catch {
    return { reason: 'peer.ready transport or authentication unavailable' }
  }
}

function observedWorkerArgv(observation) {
  const pid = Number(observation?.properties.MainPID)
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
    if (args.at(-1) === '') args.pop()
    return args.length === 4 && basename(args[0]) === 'node' && args[1].endsWith('/apps/cli/lib/bin.js')
      && args[2] === '--profile' && args[3] === 'jarvis-worker'
  } catch {
    // A unit may stop between the manager sample and the procfs lookup.
    return false
  }
}

const running = process.argv[2]
if (process.argv.length > 3 || (running !== undefined && !/^dsh-worker@[A-Za-z0-9_.-]+\.service$/u.test(running))) {
  throw new Error('usage: node scripts/worker-evidence.mjs [dsh-worker@ATTEMPT.service]')
}
const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'dsh-worker-evidence-'))
const scratch = `dsh-worker-evidence-${randomUUID()}`
const transient = `${scratch}.service`
const fixtures = []
const evidence = {
  observedAt: new Date().toISOString(),
  argv: running === undefined ? ['node', 'scripts/worker-evidence-probe.mjs', '<owned-fixtures>'] : ['node', 'apps/cli/lib/bin.js', '--profile', 'jarvis-worker'],
  argvSource: 'declared secret-free template, not process argv',
  harnessVersion: JSON.parse(readFileSync(join(release, 'apps/cli/package.json'), 'utf8')).version,
  manifestHash: workerManifest(release).hash,
  profile: await peerReady(),
  running: running === undefined ? null : await observe(running),
  transient,
}
if (observedWorkerArgv(evidence.running)) evidence.argvSource = 'verified procfs argv shape; executable paths omitted'
let interrupted = false
function interrupt() {
  interrupted = true
  void command('systemctl', ['--user', 'stop', transient])
}
process.on('SIGINT', interrupt)
process.on('SIGTERM', interrupt)
try {
  if ('version' in evidence.profile && evidence.profile.version !== undefined) evidence.harnessVersion = evidence.profile.version
  if (!('hash' in evidence.profile)) evidence.profile.releasePatchHash = createHash('sha256').update(readFileSync(join(workerBundleDirectory(release), 'cordis.patch.yml'))).digest('hex')
  const helper = join(root, 'worker-evidence-probe.mjs')
  const readonly = join(root, 'read-only')
  const hidden = join(root, 'outside.txt')
  const stateDir = join(root, 'state')
  copyFileSync(fileURLToPath(new URL('./worker-evidence-probe.mjs', import.meta.url)), helper)
  mkdirSync(readonly)
  mkdirSync(stateDir, { mode: 0o700 })
  writeFileSync(hidden, 'fabricated fixture\n', { mode: 0o600, flag: 'wx' })
  const ports = []
  for (const host of ['127.0.0.1', '127.0.0.2', '127.0.0.3']) {
    const server = createServer(socket => socket.end())
    fixtures.push(server)
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve) })
    ports.push(String(server.address().port))
  }
  const runtimeNode = realpathSync(process.execPath)
  const conf = readFileSync(unit, 'utf8').split('\n').filter(row => propertyNames.includes(row.split('=')[0]))
    .map(row => row.startsWith('StateDirectory=') ? `StateDirectory=${scratch}`
      : row.startsWith('BindPaths=') ? `BindPaths=${stateDir}`
        : row.startsWith('BindReadOnlyPaths=') ? `BindReadOnlyPaths=${runtimeNode} ${helper} ${readonly}` : row)
  conf.push('IPAddressAllow=127.0.0.1/32', 'WorkingDirectory=/')
  // v255 has no --pty=no. --pipe explicitly connects pipes without allocating a PTY.
  // The disposable write fixture is explicitly bound inside the scratch root.
  const program = ['/usr/bin/env', '-i', `DSH_HOME=${stateDir}`, runtimeNode, helper, hidden, readonly, ...ports]
  if (interrupted) throw new Error('worker evidence interrupted before launch')
  const runPromise = command('systemd-run', ['--user', '--pipe', '--quiet', '--expand-environment=no', `--unit=${transient}`,
    ...conf.flatMap(value => ['-p', value]), ...program])
  for (let i = 0; i < 10; i++) {
    evidence.observed = await observe(transient)
    if (evidence.observed.properties.StateDirectory === scratch) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const run = await runPromise
  evidence.probeExit = { code: run.code, signal: run.signal }
  try {
    evidence.probes = JSON.parse(run.stdout)
  } catch {
    evidence.probes = { skipped: 'helper did not return probe results', startup: run.errorCode ?? run.stderr.trim() }
  }
} finally {
  await command('systemctl', ['--user', 'stop', transient])
  await command('systemctl', ['--user', 'clean', '--what=state', transient])
  await command('systemctl', ['--user', 'reset-failed', transient])
  const userState = await command('systemd-path', ['user-state-private'])
  if (userState.code === 0 && userState.stdout.startsWith('/')) {
    // systemd may collect a successful transient before `clean` can reach it.
    rmSync(join(userState.stdout.trim(), scratch), { recursive: true, force: true })
  }
  await Promise.all(fixtures.map(server => new Promise(resolve => { server.close(resolve) })))
  rmSync(root, { recursive: true, force: true })
  process.off('SIGINT', interrupt)
  process.off('SIGTERM', interrupt)
}
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
const probes = evidence.probes
const fsDenied = ['EACCES', 'EPERM', 'ENOENT']
const netDenied = ['EACCES', 'EPERM', 'ETIMEDOUT', 'timeout']
if (interrupted || evidence.probeExit?.code !== 0 || probes?.stateWrite !== 'permitted' || probes?.loopbackAllowed !== 'connected'
  || !fsDenied.includes(probes?.outsideRead) || ![...fsDenied, 'EROFS'].includes(probes?.outsideWrite) || !fsDenied.includes(probes?.bash)
  || !netDenied.includes(probes?.egressDenied) || !netDenied.includes(probes?.localServiceDenied)) process.exitCode = 1
