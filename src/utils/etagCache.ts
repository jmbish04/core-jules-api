/**
 * @file src/utils/etagCache.ts
 * @description This file contains utilities for ETag-based caching using a KV namespace.
 * @owner AI-Builder
 */

import { MiddlewareHandler } from 'hono'
import { Bindings } from './hono'

/**
 * Creates a cache key from a request URL.
 * @param {string} url - The request URL.
 * @returns {string} The cache key.
 */
const getCacheKey = (url: string): string => `etag:${url}`

/**
 * A Hono middleware for ETag-based caching.
 *
 * This middleware performs two functions:
 * 1. **Checks for 304 Not Modified**: It compares the request's 'if-none-match' header
 *    against a cached ETag in the ETAG_KV. If they match, it returns a 304.
 * 2. **Caches new ETags**: After the request is handled, it checks the response.
 *    If a new 'etag' header is present, it's stored in the KV store with an optional TTL.
 *    If no 'etag' is present, any stale ETag in the KV store is deleted.
 *
 * @param {object} [options] - Caching options.
 * @param {number} [options.ttl] - The time-to-live (in seconds) for the cached ETag.
 *   If not provided, the ETag will be stored indefinitely.
 * @returns {MiddlewareHandler} The Hono middleware.
 */
export const etagCache = (options?: {
  ttl?: number
}): MiddlewareHandler<{ Bindings: Bindings }> => {
  return async (c, next) => {
    const cacheKey = getCacheKey(c.req.url)
    const ifNoneMatch = c.req.header('if-none-match')

    // 1. Check if the ETag is in the cache
    if (ifNoneMatch) {
      const cachedEtag = await c.env.ETAG_KV.get(cacheKey)
      if (cachedEtag === ifNoneMatch) {
        // Client has the latest version, return 304 Not Modified
        return c.newResponse(null, 304)
      }
    }

    await next()

    // 2. If the response has an ETag, store it in the cache
    const etag = c.res.headers.get('etag')
    if (etag) {
      // Store the new ETag. If a TTL is provided, use it.
      const kvOptions = options?.ttl && options.ttl > 0
        ? { expirationTtl: options.ttl }
        : {}
      await c.env.ETAG_KV.put(cacheKey, etag, kvOptions)
    } else {
      // If the response doesn't have an ETag (e.g., resource not cacheable),
      // delete any stale cached entry to prevent incorrect 304s.
      await c.env.ETAG_KV.delete(cacheKey)
    }
  }
}

/**
 * @extension_point
 * This is a good place to add other advanced caching strategies.
 * For example, you could add a middleware that uses the standard Cache API
 * (`caches.default`) to store and serve entire Response objects,
 * using 'cache-control' headers for TTL.
 */
