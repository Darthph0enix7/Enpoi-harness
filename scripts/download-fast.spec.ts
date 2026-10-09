import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const scriptPath = join(__dirname, 'download-fast.mjs')

describe('scripts/download-fast.mjs', () => {
  let server: ReturnType<typeof createServer>
  let serverPort: number
  let testData: Buffer
  let testSha256: string
  const scratchDir = join(tmpdir(), `dsh-dl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)

  beforeAll(async () => {
    mkdirSync(scratchDir, { recursive: true })

    // Generate 1 MB of predictable test data
    testData = Buffer.alloc(1024 * 1024)
    for (let i = 0; i < testData.length; i++) {
      testData[i] = i % 256
    }
    testSha256 = createHash('sha256').update(testData).digest('hex')

    server = createServer((req, res) => {
      const url = req.url || '/'

      if (url === '/no-ranges') {
        if (req.method === 'HEAD') {
          res.writeHead(200, {
            'Content-Length': String(testData.length),
          })
          res.end()
          return
        }
        res.writeHead(200, { 'Content-Length': String(testData.length) })
        res.end(testData)
        return
      }

      if (url === '/no-length') {
        res.writeHead(200, { 'Accept-Ranges': 'bytes' })
        res.end()
        return
      }

      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Length': String(testData.length),
          'Accept-Ranges': 'bytes',
        })
        res.end()
        return
      }

      const range = req.headers.range
      if (range && range.startsWith('bytes=')) {
        const parts = range.slice(6).split('-')
        const start = parseInt(parts[0]!, 10)
        const end = parts[1] ? parseInt(parts[1], 10) : testData.length - 1
        const slice = testData.subarray(start, end + 1)

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${testData.length}`,
          'Content-Length': String(slice.length),
          'Accept-Ranges': 'bytes',
        })
        res.end(slice)
        return
      }

      res.writeHead(200, {
        'Content-Length': String(testData.length),
        'Accept-Ranges': 'bytes',
      })
      res.end(testData)
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (typeof addr === 'object' && addr) {
          serverPort = addr.port
        }
        resolve()
      })
    })
  })

  afterAll(() => {
    server?.close()
    rmSync(scratchDir, { recursive: true, force: true })
  })

  function runDownloader(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [scriptPath, ...args], {
        env: { ...process.env, DSH_DOWNLOAD_STALL_MS: '5000' },
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => { stdout += d.toString() })
      child.stderr.on('data', (d) => { stderr += d.toString() })
      child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }))
    })
  }

  it('downloads and verifies a file across multiple concurrent chunks', async () => {
    const targetFile = join(scratchDir, 'assembled-file.bin')
    const url = `http://127.0.0.1:${serverPort}/test-asset`

    const res = await runDownloader([url, targetFile, '4', testSha256])
    expect(res.code).toBe(0)
    expect(existsSync(targetFile)).toBe(true)

    const downloaded = readFileSync(targetFile)
    expect(downloaded.length).toBe(testData.length)
    expect(downloaded.equals(testData)).toBe(true)

    // Chunks folder should be cleaned up on success
    expect(existsSync(`${targetFile}.chunks`)).toBe(false)
  })

  it('exits with code 0 immediately if cached target matches sha256', async () => {
    const targetFile = join(scratchDir, 'already-cached.bin')
    writeFileSync(targetFile, testData)

    const res = await runDownloader(['http://127.0.0.1:1/unreachable', targetFile, '4', testSha256])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('cached file verified matching sha256')
  })

  it('resumes a partial download where some chunks already exist', async () => {
    const targetFile = join(scratchDir, 'resumed-file.bin')
    const chunkDir = `${targetFile}.chunks`
    mkdirSync(chunkDir, { recursive: true })

    const totalBytes = testData.length
    const concurrency = 4
    const chunkSize = Math.ceil(totalBytes / concurrency)

    // Pre-populate part-0 completely
    const part0Data = testData.subarray(0, chunkSize)
    writeFileSync(join(chunkDir, 'part-0'), part0Data)

    // Pre-populate manifest
    const manifest = {
      url: `http://127.0.0.1:${serverPort}/test-asset`,
      totalBytes,
      concurrency,
      createdAt: Date.now(),
    }
    writeFileSync(join(chunkDir, 'manifest.json'), JSON.stringify(manifest))

    const res = await runDownloader([manifest.url, targetFile, '4', testSha256])
    expect(res.code).toBe(0)
    expect(existsSync(targetFile)).toBe(true)

    const downloaded = readFileSync(targetFile)
    expect(downloaded.equals(testData)).toBe(true)
    expect(existsSync(chunkDir)).toBe(false)
  })

  it('exits with code 2 (curl fallback) when server does not support ranges', async () => {
    const targetFile = join(scratchDir, 'no-ranges-target.bin')
    const url = `http://127.0.0.1:${serverPort}/no-ranges`

    const res = await runDownloader([url, targetFile, '4', testSha256])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('accept-ranges: bytes')
  })

  it('exits with code 2 (curl fallback) when server omits content-length', async () => {
    const targetFile = join(scratchDir, 'no-len-target.bin')
    const url = `http://127.0.0.1:${serverPort}/no-length`

    const res = await runDownloader([url, targetFile, '4', testSha256])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('content length')
  })

  it('exits with code 3 and cleans up if sha256 checksum mismatches', async () => {
    const targetFile = join(scratchDir, 'corrupt-file.bin')
    const url = `http://127.0.0.1:${serverPort}/test-asset`
    const bogusSha256 = '0000000000000000000000000000000000000000000000000000000000000000'

    const res = await runDownloader([url, targetFile, '4', bogusSha256])
    expect(res.code).toBe(3)
    expect(res.stderr).toContain('SHA-256 verification failed')

    // Corrupted file and chunk dir must be purged
    expect(existsSync(targetFile)).toBe(false)
    expect(existsSync(`${targetFile}.download`)).toBe(false)
    expect(existsSync(`${targetFile}.chunks`)).toBe(false)
  })
})
