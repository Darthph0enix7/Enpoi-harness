#!/usr/bin/env node
/**
 * High-performance, resumable, parallel chunk downloader for DSH releases.
 * Zero external dependencies — runs on Node.js >= 22 built-ins.
 *
 * Exit codes:
 *   0: success (downloaded and verified)
 *   1: general failure (network errors after retries)
 *   2: server does not support byte ranges (signal to fall back to single-stream curl)
 *   3: checksum verification mismatch
 * 130: interrupted (SIGINT/SIGTERM, partial chunks preserved for resume)
 */

import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const url = process.argv[2]
const outputFile = process.argv[3]
const rawConcurrency = process.argv[4] ? parseInt(process.argv[4], 10) : parseInt(process.env.DSH_DOWNLOAD_CONCURRENCY || '6', 10)
const expectedSha256 = (process.argv[5] || process.env.DSH_DOWNLOAD_EXPECTED_SHA256 || '').trim()

if (!url || !outputFile) {
  console.error('usage: download-fast.mjs <url> <output-file> [concurrency] [expected-sha256]')
  process.exit(1)
}

const concurrency = Math.max(1, Math.min(16, isNaN(rawConcurrency) ? 6 : rawConcurrency))
const stallTimeoutMs = parseInt(process.env.DSH_DOWNLOAD_STALL_MS || '30000', 10)
const maxRetries = 5

let isAborting = false
const activeControllers = new Set()

function handleAbort(sig) {
  if (isAborting) return
  isAborting = true
  process.stderr.write(`\n[download] ${sig} received; pausing transfer and preserving completed chunks...\n`)
  for (const ac of activeControllers) {
    try { ac.abort() } catch {}
  }
  setTimeout(() => process.exit(130), 100).unref()
}

process.on('SIGINT', () => handleAbort('SIGINT'))
process.on('SIGTERM', () => handleAbort('SIGTERM'))

async function fetchHead(targetUrl) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 20000)
  try {
    const resp = await fetch(targetUrl, {
      method: 'HEAD',
      redirect: 'follow',
      signal: ac.signal,
    })
    clearTimeout(timer)
    if (!resp.ok && resp.status !== 206) return null
    const lenHeader = resp.headers.get('content-length')
    const rangeHeader = resp.headers.get('accept-ranges')
    const totalBytes = lenHeader ? parseInt(lenHeader, 10) : NaN
    const finalUrl = resp.url || targetUrl
    return {
      status: resp.status,
      totalBytes: isNaN(totalBytes) || totalBytes <= 0 ? null : totalBytes,
      supportsRanges: rangeHeader === 'bytes' || Boolean(resp.headers.get('content-range')),
      finalUrl,
    }
  } catch {
    clearTimeout(timer)
    return null
  }
}

async function verifyExistingTarget(targetPath, expectedHash) {
  if (!existsSync(targetPath)) return false
  if (!expectedHash) return statSync(targetPath).size > 0
  try {
    const hash = createHash('sha256')
    const stream = createReadStream(targetPath)
    await pipeline(stream, hash)
    return hash.digest('hex').toLowerCase() === expectedHash.toLowerCase()
  } catch {
    return false
  }
}

async function main() {
  if (expectedSha256 && await verifyExistingTarget(outputFile, expectedSha256)) {
    console.log(`[download] cached file verified matching sha256: ${outputFile}`)
    process.exit(0)
  }

  const head = await fetchHead(url)
  if (!head || !head.totalBytes) {
    console.warn('[download] server did not return content length; falling back to single-stream')
    process.exit(2)
  }

  if (!head.supportsRanges && concurrency > 1) {
    console.warn('[download] server does not advertise accept-ranges: bytes; falling back to single-stream')
    process.exit(2)
  }

  const totalBytes = head.totalBytes
  const totalMB = (totalBytes / (1024 * 1024)).toFixed(1)
  const chunkDir = `${outputFile}.chunks`
  const manifestPath = `${chunkDir}/manifest.json`

  mkdirSync(chunkDir, { recursive: true })

  let validManifest = false
  if (existsSync(manifestPath)) {
    try {
      const saved = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (saved.url === url && saved.totalBytes === totalBytes && saved.concurrency === concurrency) {
        validManifest = true
      }
    } catch {}
  }

  if (!validManifest) {
    rmSync(chunkDir, { recursive: true, force: true })
    mkdirSync(chunkDir, { recursive: true })
    const manifestData = { url, totalBytes, concurrency, createdAt: Date.now() }
    writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2))
  }

  const chunkSize = Math.ceil(totalBytes / concurrency)
  const chunks = []
  for (let i = 0; i < concurrency; i++) {
    const start = i * chunkSize
    const end = (i === concurrency - 1) ? (totalBytes - 1) : Math.min(start + chunkSize - 1, totalBytes - 1)
    chunks.push({
      index: i,
      start,
      end,
      expectedSize: (end - start + 1),
      partPath: `${chunkDir}/part-${i}`,
    })
  }

  let totalDownloadedBytes = 0
  for (const c of chunks) {
    if (existsSync(c.partPath)) {
      const sz = statSync(c.partPath).size
      if (sz === c.expectedSize) {
        totalDownloadedBytes += sz
      } else if (sz < c.expectedSize) {
        totalDownloadedBytes += sz
      } else {
        // Corrupt/oversized chunk -> truncate
        rmSync(c.partPath, { force: true })
      }
    }
  }

  const startTime = Date.now()
  let lastLogTime = 0
  const isTTY = Boolean(process.stdout.isTTY)

  const progressFile = `${chunkDir}/.progress`
  const topProgressFile = `${outputFile}.progress`

  function formatProgressBar(pct, currentMB, totalMB, speedMBs) {
    const width = 12
    const filled = Math.min(width, Math.max(0, Math.round((pct / 100) * width)))
    const empty = width - filled
    const bar = '█'.repeat(filled) + '░'.repeat(empty)
    return `[${bar}] ${pct}% · ${currentMB}/${totalMB} MB · ${speedMBs.toFixed(1)} MB/s`
  }

  function writeProgress(text) {
    try {
      writeFileSync(progressFile, text)
      writeFileSync(topProgressFile, text)
    } catch {}
  }

  function reportProgress(force = false) {
    const now = Date.now()
    if (!force && now - lastLogTime < (isTTY ? 200 : 4000)) return
    lastLogTime = now
    const elapsedSec = Math.max(0.1, (now - startTime) / 1000)
    const currentMB = (totalDownloadedBytes / (1024 * 1024)).toFixed(1)
    const pct = Math.min(100, Math.floor((totalDownloadedBytes / totalBytes) * 100))
    const speedMBs = (totalDownloadedBytes / (1024 * 1024)) / elapsedSec
    const remainingBytes = Math.max(0, totalBytes - totalDownloadedBytes)
    const remainingSec = speedMBs > 0 ? Math.ceil((remainingBytes / (1024 * 1024)) / speedMBs) : 0

    writeProgress(formatProgressBar(pct, currentMB, totalMB, speedMBs))

    const msg = `[download] ${pct}% (${currentMB}/${totalMB} MB, ${speedMBs.toFixed(1)} MB/s, ~${remainingSec}s remaining)`
    if (isTTY) {
      process.stdout.write(`\r${msg}   `)
    } else {
      console.log(msg)
    }
  }

  reportProgress(true)

  async function downloadChunk(chunk) {
    let partSize = existsSync(chunk.partPath) ? statSync(chunk.partPath).size : 0
    if (partSize >= chunk.expectedSize) {
      return
    }

    let attempt = 0
    while (attempt < maxRetries && !isAborting) {
      attempt++
      partSize = existsSync(chunk.partPath) ? statSync(chunk.partPath).size : 0
      if (partSize >= chunk.expectedSize) return

      const rangeStart = chunk.start + partSize
      const rangeEnd = chunk.end

      const controller = new AbortController()
      activeControllers.add(controller)

      let stallTimer = null
      const resetStallTimer = () => {
        if (stallTimer) clearTimeout(stallTimer)
        stallTimer = setTimeout(() => {
          controller.abort(new Error('chunk transfer stalled'))
        }, stallTimeoutMs)
      }

      try {
        resetStallTimer()
        const resp = await fetch(url, {
          headers: { Range: `bytes=${rangeStart}-${rangeEnd}` },
          redirect: 'follow',
          signal: controller.signal,
        })

        if (!resp.ok && resp.status !== 206) {
          throw new Error(`HTTP ${resp.status} on chunk ${chunk.index}`)
        }

        const outStream = createWriteStream(chunk.partPath, { flags: 'a' })
        const nodeStream = Readable.fromWeb(resp.body)

        nodeStream.on('data', (buf) => {
          resetStallTimer()
          totalDownloadedBytes += buf.length
          reportProgress()
        })

        await pipeline(nodeStream, outStream)
        clearTimeout(stallTimer)
        activeControllers.delete(controller)
        return
      } catch (err) {
        clearTimeout(stallTimer)
        activeControllers.delete(controller)
        if (isAborting) return

        if (attempt >= maxRetries) {
          throw new Error(`chunk ${chunk.index} failed after ${maxRetries} attempts: ${err.message}`)
        }
        await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, attempt - 1), 10000)))
      }
    }
  }

  // Execute chunks with concurrency
  const queue = [...chunks]
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0 && !isAborting) {
      const c = queue.shift()
      if (c) await downloadChunk(c)
    }
  })

  await Promise.all(workers)

  if (isAborting) {
    process.exit(130)
  }

  reportProgress(true)
  if (isTTY) process.stdout.write('\n')

  // Verify all parts exist with exact sizes
  for (const c of chunks) {
    if (!existsSync(c.partPath)) throw new Error(`missing chunk ${c.index}`)
    const sz = statSync(c.partPath).size
    if (sz !== c.expectedSize) throw new Error(`incomplete chunk ${c.index} (got ${sz}, expected ${c.expectedSize})`)
  }

  console.log(`[download] assembling ${concurrency} parts into ${outputFile}...`)
  writeProgress('[assembling] verifying SHA-256...')
  const downloadFile = `${outputFile}.download`
  const outStream = createWriteStream(downloadFile)
  const hash = createHash('sha256')

  for (const c of chunks) {
    const partStream = createReadStream(c.partPath)
    await new Promise((resolve, reject) => {
      partStream.on('data', (buf) => {
        hash.update(buf)
        outStream.write(buf)
      })
      partStream.on('end', resolve)
      partStream.on('error', reject)
    })
  }

  await new Promise((resolve, reject) => {
    outStream.end(() => resolve())
    outStream.on('error', reject)
  })

  const actualSha256 = hash.digest('hex').toLowerCase()
  if (expectedSha256) {
    if (actualSha256 !== expectedSha256.toLowerCase()) {
      rmSync(downloadFile, { force: true })
      rmSync(chunkDir, { recursive: true, force: true })
      try { rmSync(topProgressFile, { force: true }) } catch {}
      console.error(`[download] SHA-256 verification failed! Expected: ${expectedSha256}, actual: ${actualSha256}`)
      process.exit(3)
    }
    console.log(`[download] SHA-256 verified (${actualSha256.slice(0, 16)}...)`)
  }

  renameSync(downloadFile, outputFile)
  rmSync(chunkDir, { recursive: true, force: true })
  try { rmSync(topProgressFile, { force: true }) } catch {}
  console.log(`[download] successfully finished: ${outputFile} (${totalMB} MB)`)
  process.exit(0)
}

main().catch((err) => {
  if (!isAborting) {
    console.error(`[download] error: ${err.message}`)
    process.exit(1)
  }
})
