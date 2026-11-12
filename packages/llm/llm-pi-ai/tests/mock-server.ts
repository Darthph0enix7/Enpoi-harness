import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

export interface MockServer {
  url: string
  paths: string[]
  requests: unknown[]
  headers: IncomingMessage['headers'][]
  readonly closedResponses: number
  responseClosed: Promise<void>
}

const servers: Server[] = []

/** Close every server opened since the last call; run from each spec's afterEach. */
export async function closeMockServers(): Promise<void> {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
}

/** A minimal complete text generation in pi-ai's chat-completions shape. */
export const textEvents = [
  '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"content":"hello"},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
  '[DONE]',
]

/** Local provider stand-in: replays scripted behaviors per request. */
export async function mockServer(script: {
  status?: number
  events?: string[]
  /**
   * Raw SSE frames written verbatim (each line already carries its blank
   * line). Anthropic's parser dispatches on the `event:` field, which the
   * `events` shorthand does not emit.
   */
  rawEvents?: string[]
  body?: string
  delayMs?: number
  /** Delay before the response head; the accepted request stays silent until then. */
  headersDelayMs?: number
  /** Delay before the first SSE frame, after the response head was written. */
  firstEventDelayMs?: number
  /** Interval between SSE comment frames that carry no event data. */
  keepAliveMs?: number
  /** Comment frame written at each keepalive interval; `: keepalive` when omitted. */
  keepAlive?: string
  /**
   * Raw byte fragments written one per `delayMs` before the event script. The
   * sequence need not form a complete SSE frame: it proves liveness from
   * transport bytes the SDK cannot yet dispatch.
   */
  fragments?: string[]
  headers?: Record<string, string>
}[]): Promise<MockServer> {
  const paths: string[] = []
  const requests: unknown[] = []
  const headers: IncomingMessage['headers'][] = []
  let closedResponses = 0
  const responseClosed = Promise.withResolvers<undefined>()
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    response.on('close', () => {
      closedResponses += 1
      responseClosed.resolve(undefined)
    })
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      paths.push(request.url ?? '')
      requests.push(body.length === 0 ? undefined : JSON.parse(body))
      headers.push(request.headers)
      const behavior = script.shift() ?? { status: 500, body: 'script exhausted' }
      const start = (): void => {
        // A caller that timed out before the delayed head arrived is gone; no
        // script bytes were promised to it.
        if (response.destroyed) return
        const status = behavior.status
        if (status !== undefined && status !== 200) {
          // A delayed rejection keeps two concurrent callers in flight together.
          const reject = (): void => {
            response.writeHead(status, { 'content-type': 'application/json', ...behavior.headers })
            response.end(behavior.body ?? '{}')
          }
          if (behavior.delayMs === undefined) reject()
          else setTimeout(reject, behavior.delayMs)
          return
        }
        if (behavior.body !== undefined) {
          response.writeHead(200, { 'content-type': 'application/json', ...behavior.headers })
          response.end(behavior.body)
          return
        }
        response.writeHead(200, { 'content-type': 'text/event-stream', ...behavior.headers })
        if (behavior.rawEvents !== undefined) {
          for (const raw of behavior.rawEvents) response.write(raw)
          response.end()
          return
        }
        // A keepalive is a complete SSE comment frame: transport bytes that
        // carry no event data, matching gateways that ping an otherwise idle
        // stream.
        let keepAlive: ReturnType<typeof setInterval> | undefined
        const stopKeepAlive = (): void => {
          if (keepAlive === undefined) return
          clearInterval(keepAlive)
          keepAlive = undefined
        }
        if (behavior.keepAliveMs !== undefined) {
          keepAlive = setInterval(() => {
            if (!response.destroyed) response.write(`${behavior.keepAlive ?? ': keepalive'}\n\n`)
          }, behavior.keepAliveMs)
          response.on('close', stopKeepAlive)
        }
        const writeEvents = (): void => {
          let index = 0
          const writeNext = (): void => {
            if (response.destroyed) { stopKeepAlive(); return }
            const event = behavior.events?.[index++]
            if (event === undefined) { stopKeepAlive(); response.end(); return }
            response.write(`data: ${event}\n\n`)
            if (behavior.delayMs === undefined) writeNext()
            else setTimeout(writeNext, behavior.delayMs)
          }
          if (behavior.firstEventDelayMs === undefined) writeNext()
          else setTimeout(writeNext, behavior.firstEventDelayMs)
        }
        if (behavior.fragments !== undefined) {
          let fragmentIndex = 0
          const writeFragment = (): void => {
            if (response.destroyed) return
            const fragment = behavior.fragments?.[fragmentIndex++]
            if (fragment === undefined) { writeEvents(); return }
            response.write(fragment)
            setTimeout(writeFragment, behavior.delayMs ?? 0)
          }
          writeFragment()
          return
        }
        writeEvents()
      }
      if (behavior.headersDelayMs === undefined) start()
      else setTimeout(start, behavior.headersDelayMs)
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    paths,
    requests,
    headers,
    responseClosed: responseClosed.promise,
    get closedResponses() { return closedResponses },
  }
}
