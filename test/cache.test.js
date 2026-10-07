import assert from 'node:assert/strict'
import test from 'node:test'

import { Cache, retryOnce } from '../src/cache.js'

test('Cache reuses fresh values and coalesces concurrent misses', async () => {
  let now = 1_000
  let loads = 0
  let release
  const cache = new Cache(100, () => now)
  const loader = async () => {
    loads += 1
    await new Promise((resolve) => {
      release = resolve
    })
    return { value: 42 }
  }

  const first = cache.get('key', loader)
  const second = cache.get('key', loader)

  assert.equal(loads, 1)
  release()

  assert.equal((await first).status, 'miss')
  assert.equal((await second).status, 'miss')
  assert.equal(loads, 1)

  now += 50
  assert.equal((await cache.get('key', loader)).status, 'hit')
  assert.equal(loads, 1)
})

test('Cache serves the previous value when refresh fails', async () => {
  let now = 0
  const cache = new Cache(10, () => now)
  const first = await cache.get('key', async () => 'last-good')

  assert.equal(first.status, 'miss')
  now = 11

  const stale = await cache.get('key', async () => { throw new Error('upstream down') })

  assert.equal(stale.status, 'stale')
  assert.equal(stale.value, 'last-good')
  assert.match(stale.error.message, /upstream down/)
})

test('one NERC cache key serves lookups for different commissioning dates', async () => {
  let loads = 0
  const cache = new Cache(100)
  const loader = async () => {
    loads += 1
    return [{ startDate: '2025-01-01' }, { startDate: '2026-01-01' }]
  }

  const first = await cache.get('current-decree', loader)
  const second = await cache.get('current-decree', loader)

  assert.equal(first.status, 'miss')
  assert.equal(second.status, 'hit')
  assert.deepEqual(first.value, second.value)
  assert.equal(loads, 1)
})

test('retryOnce retries one failure and returns the second result', async () => {
  let attempts = 0
  let retriedError

  const result = await retryOnce(
    async () => {
      attempts += 1

      if (attempts === 1) {
        throw new Error('temporary failure')
      }

      return 'ok'
    },
    (error) => {
      retriedError = error
    },
  )

  assert.equal(result, 'ok')
  assert.equal(attempts, 2)
  assert.match(retriedError.message, /temporary failure/)
})
