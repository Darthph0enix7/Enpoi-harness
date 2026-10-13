/**
 * Route-surface guard: every endpoint the module header advertises must exist
 * as a decorated method. The first release of the cancel endpoint shipped the
 * controller and the client call but not the method itself — the UI got a 404
 * on every device. This spec fails loudly when the list and the class drift.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UpdateCheckService } from '../src/remote.ts'

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'remote.ts')

describe('updateCheck remote surface', () => {
  it('exposes every endpoint named in the module header', () => {
    const header = readFileSync(SOURCE, 'utf8')
    const advertised = [...header.matchAll(/`updateCheck\/([A-Za-z]+)`/g)].map(match => match[1])
    expect(advertised.length).toBeGreaterThanOrEqual(7)
    for (const method of advertised) {
      expect(typeof Reflect.get(UpdateCheckService.prototype, method), `updateCheck/${method} missing on the service class`).toBe('function')
    }
  })

  it('keeps the documented endpoint set exact', () => {
    const methods = Object.getOwnPropertyNames(UpdateCheckService.prototype).filter(name => name !== 'constructor')
    expect(methods.sort()).toEqual(['apply', 'cancel', 'checkNow', 'dismiss', 'run', 'start', 'status'])
  })
})
