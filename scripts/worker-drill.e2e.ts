import { expect, it } from 'vitest'
import { captureWorker } from './tool-inventory/worker-capture.mts'

it('reports Jarvis acceptance failures, skips, and declared limits against the source worker composition', async () => {
  const capture = await captureWorker()
  const summary = { pass: 0, fail: 0, skipped: 0, 'declared-limit': 0 }
  for (const row of capture.rows) summary[row.status] += 1
  const table = capture.rows.map(row => `${String(row.step).padStart(2)}  ${row.status.padEnd(14)}  ${row.name}: ${row.reason}`)
  process.stderr.write(`${table.join('\n')}\n${summary.fail} fail, ${summary['declared-limit']} declared-limit, ${summary.skipped} skipped, ${summary.pass} pass\n`)
  process.stdout.write(`${JSON.stringify({ ...capture, summary })}\n`)
  expect(capture.rows.map(row => row.step)).toEqual(Array.from({ length: 15 }, (_, i) => i))
  expect(capture.rows.filter(row => row.status === 'fail')).toEqual([])
}, 30000)
