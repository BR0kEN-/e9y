export class Cache {
  constructor(ttl, now = Date.now) {
    this.ttl = ttl
    this.now = now
    this.entries = new Map()
    this.pending = new Map()
  }

  async get(key, loader) {
    const now = this.now()
    const entry = this.entries.get(key)

    if (entry && now - entry.fetchedAt < this.ttl) {
      return { ...entry, status: 'hit' }
    }

    const pending = this.pending.get(key)

    if (pending) {
      return pending
    }

    const promise = (async () => {
      try {
        const value = await loader()
        const result = { value, fetchedAt: this.now() }
        this.entries.set(key, result)
        return { ...result, status: 'miss' }
      } catch (error) {
        if (entry) {
          return { ...entry, status: 'stale', error }
        }
        throw error
      } finally {
        this.pending.delete(key)
      }
    })()

    this.pending.set(key, promise)
    return promise
  }
}

export async function retryOnce(loader, onRetry = () => {}) {
  try {
    return await loader()
  } catch (error) {
    onRetry(error)
    return loader()
  }
}
