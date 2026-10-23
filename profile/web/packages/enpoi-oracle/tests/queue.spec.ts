import { describe, expect, it } from 'vitest'
import { ParentFifoQueue } from '../src/queue.ts'

describe('ParentFifoQueue', () => {
  it('runs tasks on one lane in enqueue order', async () => {
    const queue = new ParentFifoQueue()
    const order: string[] = []
    const first = queue.run('parent', async () => {
      await new Promise(resolve => setTimeout(resolve, 30))
      order.push('first')
      return 1
    })
    const second = queue.run('parent', async () => {
      order.push('second')
      return 2
    })
    await expect(first).resolves.toBe(1)
    await expect(second).resolves.toBe(2)
    expect(order).toEqual(['first', 'second'])
  })

  it('lets distinct lanes run in parallel', async () => {
    const queue = new ParentFifoQueue()
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const blocked = queue.run('a', async () => { await gate; return 'a' })
    const other = await queue.run('b', async () => 'b')
    expect(other).toBe('b')
    release?.()
    await expect(blocked).resolves.toBe('a')
  })

  it('releases the lane after a rejection', async () => {
    const queue = new ParentFifoQueue()
    await expect(queue.run('parent', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(queue.run('parent', async () => 'after')).resolves.toBe('after')
  })

  it('reports whether a lane is busy', async () => {
    const queue = new ParentFifoQueue()
    const running = queue.run('parent', async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    expect(queue.isBusy('parent')).toBe(true)
    await running
    expect(queue.isBusy('parent')).toBe(false)
  })
})
