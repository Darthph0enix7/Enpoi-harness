/** Harmless fixture checks. This process runs inside the transient unit. */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'

function attempt(action) {
  try {
    action()
    return 'permitted'
  } catch (error) {
    return String(error.code ?? 'error')
  }
}

function tcp(host, port) {
  return new Promise(resolve => {
    const socket = connect({ host, port, family: 4 })
    const done = result => { socket.destroy(); resolve(result) }
    socket.setTimeout(900, () => done('timeout'))
    socket.once('connect', () => done('connected'))
    socket.once('error', error => done(error.code ?? 'error'))
  })
}

const [hidden, readonly, allowed, denied, local] = process.argv.slice(2)
const bash = spawnSync('/usr/bin/bash', ['--noprofile', '--norc', '-c', ':'], { timeout: 1000, env: {} })
const [loopbackAllowed, egressDenied, localServiceDenied] = await Promise.all([
  tcp('127.0.0.1', Number(allowed)), tcp('127.0.0.2', Number(denied)), tcp('127.0.0.3', Number(local)),
])
process.stdout.write(`${JSON.stringify({
  outsideRead: attempt(() => readFileSync(hidden)),
  outsideWrite: attempt(() => writeFileSync(join(readonly, 'probe'), '', { flag: 'wx' })),
  stateWrite: attempt(() => writeFileSync(join(process.env.DSH_HOME, 'probe'), '', { flag: 'wx' })),
  bash: bash.error?.code ?? (bash.status === 0 ? 'executed' : 'error'),
  loopbackAllowed,
  egressDenied,
  localServiceDenied,
})}\n`)
