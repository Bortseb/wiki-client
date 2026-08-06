const CACHE = 'fedwiki-pwa-4'
const SHELL_HTML = '/__wiki_shell__'
const LARGE_CONSENT_PATH = '/__pwa_large_consent__'
let manifestData = null
let persistedStateLoaded = false
const MAX_CACHE_ASSET_BYTES_DEFAULT = 8 * 1024 * 1024
let maxCacheAssetBytes = MAX_CACHE_ASSET_BYTES_DEFAULT
/** Soft network probe when navigator.onLine is wrong (false offline / flaky). */
const NETWORK_PROBE_MS = 2500

function overLimit(n) {
  return Number.isFinite(maxCacheAssetBytes) && n > maxCacheAssetBytes
}

/** Full-bleed scale of /favicon.png when SET_MANIFEST icons are missing. */
async function rasterizeFaviconIcon(size) {
  try {
    const res = await fetch(new URL('/favicon.png', self.location.origin).href, { cache: 'no-cache' })
    if (!res.ok || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function') {
      return null
    }
    const bitmap = await createImageBitmap(await res.blob())
    const canvas = new OffscreenCanvas(size, size)
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close()
      return null
    }
    // Opaque fill — match page canvas path; wiki favicons are full-tile identity squares.
    ctx.fillStyle = '#eeeeee'
    ctx.fillRect(0, 0, size, size)
    const scale = Math.min(size / bitmap.width, size / bitmap.height)
    const w = bitmap.width * scale
    const h = bitmap.height * scale
    ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h)
    bitmap.close()
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    return blob || null
  } catch {
    return null
  }
}

async function pwaIconResponse(pathname) {
  const matchOpts = {
    ignoreSearch: true,
    ignoreMethod: true,
    ignoreVary: true,
  }
  const cache = await caches.open(CACHE)
  const hit = await matchPath(cache, pathname, matchOpts)
  if (hit) return hit
  const size = /512\.png$/.test(pathname) ? 512 : 192
  const blob = await rasterizeFaviconIcon(size)
  if (!blob) return new Response('', { status: 404 })
  const body = new Response(blob, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' },
  })
  try {
    await cache.put(pathname, body.clone())
  } catch {
    /* ignore */
  }
  return body
}

// Minimal app shell for offline reopen after install/pack.
// Do NOT include sitemap/site-index here — large farms (thousands of pages) would
// compete with stock first paint; seedOfflineBackup caches those after install.
const SHELL = [
  '/view/welcome-visitors',
  '/style/style.css',
  '/theme/style.css',
  '/style/print.css',
  '/client.js',
  '/favicon.png',
  '/welcome-visitors.json',
  '/images/noise.png',
  '/images/crosses.png',
  '/images/external-link-ltr-icon.png',
  '/security/security.js',
  '/js/jquery-4.0.0.js',
  '/js/jquery-migrate-4.0.2.js',
  '/js/jquery-ui/1.14.2/jquery-ui.min.js',
  '/js/jquery-ui/1.14.2/jquery-ui.min.css',
  '/js/jquery.ui.touch-punch.min.js',
  '/js/underscore-min.js',
]

function isWikiClientShellHtml(text) {
  return text.includes('/client.js') && /class=['"]main['"]/.test(text)
}

function isPluginPwaBridgePath(pathname) {
  return /\/plugin\/[^/]+\/pwa(?:\/|$)/i.test(pathname || '')
}

function pluginPwaCachePrefix(pluginName) {
  return `wiki-${String(pluginName || '').toLowerCase()}-pwa-cache-`
}

function pluginNameFromPluginsPath(pathname) {
  const m = String(pathname || '').match(/^\/plugins\/([^/]+)\//i)
  return m ? m[1].toLowerCase() : ''
}

async function cachePut(cache, request, response) {
  if (!response || !response.ok) return
  const reqUrl = typeof request === 'string' ? request : request.url
  try {
    if (isPluginPwaBridgePath(new URL(reqUrl, self.registration.scope).pathname)) return
  } catch {
    /* pack */
  }
  try {
    const cl = Number(response.headers.get('content-length') || 0)
    if (overLimit(cl)) return
    const buf = await response.arrayBuffer()
    if (overLimit(buf.byteLength)) return
    const toStore = new Response(buf.slice(0), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
    await cache.put(request, toStore.clone())
    const ct = toStore.headers.get('content-type') || ''
    if (ct.includes('text/html')) {
      const text = new TextDecoder().decode(buf)
      if (isWikiClientShellHtml(text)) await cache.put(SHELL_HTML, toStore.clone())
    }
  } catch (err) {
    console.warn('[PWA SW] cache.put failed', err)
  }
}

async function matchPath(cache, pathname, opts = {}) {
  const matchOpts = { ignoreSearch: true, ...opts }
  const { request, ...cacheOpts } = matchOpts
  if (request) {
    const hit = await cache.match(request, cacheOpts)
    if (hit) return hit
  }
  const abs = new URL(pathname, self.registration.scope).href
  return (await cache.match(pathname, cacheOpts)) || (await cache.match(abs, cacheOpts)) || null
}

async function persistLargeConsent(allowed, maxBytes) {
  maxCacheAssetBytes = allowed
    ? Number(maxBytes) || Number.POSITIVE_INFINITY
    : MAX_CACHE_ASSET_BYTES_DEFAULT
  const cache = await caches.open(CACHE)
  await cache.put(
    LARGE_CONSENT_PATH,
    new Response(JSON.stringify({ allowed: !!allowed, maxBytes: maxCacheAssetBytes }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
    }),
  )
}

async function restorePersistedState() {
  try {
    const cache = await caches.open(CACHE)
    const consent = await cache.match(LARGE_CONSENT_PATH)
    if (consent) {
      try {
        const data = await consent.json()
        maxCacheAssetBytes = data.allowed
          ? Number(data.maxBytes) || Number.POSITIVE_INFINITY
          : MAX_CACHE_ASSET_BYTES_DEFAULT
      } catch {
        /* keep default */
      }
    }
  } catch {
    /* keep defaults */
  } finally {
    persistedStateLoaded = true
  }
}

async function ensurePersistedState() {
  if (persistedStateLoaded) return
  await restorePersistedState()
}

async function matchShellHtml(cache) {
  const direct = await matchPath(cache, SHELL_HTML)
  if (direct) return direct
  for (const path of ['/view/welcome-visitors', '/welcome-visitors.html']) {
    const hit = await matchPath(cache, path)
    if (!hit) continue
    try {
      if (isWikiClientShellHtml(await hit.clone().text())) return hit
    } catch {
      /* keep looking */
    }
  }
  return null
}

async function hasShellBootstrap(cache) {
  if (!(await matchPath(cache, '/client.js'))) return false
  return !!(await matchShellHtml(cache))
}

/** True when shell was packed — enables offline / flaky-network fallbacks. */
async function hasPackedShell() {
  await ensurePersistedState()
  try {
    return await hasShellBootstrap(await caches.open(CACHE))
  } catch {
    return false
  }
}

async function networkWithTimeout(request, ms = NETWORK_PROBE_MS, fetchOpts = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(request, { ...fetchOpts, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** Cache first; on miss try network briefly (navigator.onLine false is only a hint). */
async function cacheFirstThenNetwork(request, { navigate = false } = {}) {
  const cache = await caches.open(CACHE)
  const hit = await matchCached(cache, request)
  if (hit) return hit
  try {
    const res = await networkWithTimeout(request)
    if (res) return res
  } catch {
    /* probe failed */
  }
  return navigate ? navigationOfflineResponse() : offlineMissResponse(request)
}

/**
 * Online navigate with packed shell: network first; cache only if fetch throws (false-online).
 *
 * Use redirect:'manual' so a 302 (e.g. / → /assets/home/index.html) is returned to the
 * browser instead of being followed inside the SW. Following redirects through respondWith
 * has hung Chrome tabs for custom home pages while incognito (no SW) worked fine.
 *
 * Soft timeout avoids a permanent hang if the network fetch never settles.
 */
async function networkFirstNavigate(request) {
  try {
    // Do not wrap navigate Requests in new Request(...) — that can throw.
    return await networkWithTimeout(request, Math.max(NETWORK_PROBE_MS * 6, 15000), {
      redirect: 'manual',
    })
  } catch {
    try {
      // Last resort: one more attempt without abort signal.
      return await fetch(request, { redirect: 'manual' })
    } catch {
      return navigationOfflineResponse()
    }
  }
}

/** Paths the wiki shell SW must not own as document navigations. */
function isPassthroughNavigate(pathname) {
  return (
    pathname.startsWith('/assets/') ||
    pathname.startsWith('/plugins/') ||
    pathname.startsWith('/plugin/')
  )
}

async function precache() {
  const cache = await caches.open(CACHE)
  await Promise.all(
    SHELL.map(async url => {
      try {
        await cachePut(cache, url, await fetch(url, { cache: 'no-cache', redirect: 'follow' }))
      } catch {
        /* optional */
      }
    }),
  )
  if (await matchPath(cache, SHELL_HTML)) return
  for (const url of ['/view/welcome-visitors', '/welcome-visitors.html', '/']) {
    try {
      const home = await fetch(url, { cache: 'no-cache', redirect: 'follow' })
      if (!home.ok) continue
      const ct = home.headers.get('content-type') || ''
      if (!ct.includes('text/html')) continue
      await cachePut(cache, url, home)
      if (await matchPath(cache, SHELL_HTML)) break
    } catch {
      /* optional */
    }
  }
}

function manifestResponse(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store' },
  })
}

function offlineHtml(reason) {
  const msg =
    reason || 'Offline — open this wiki online once so scripts and pages can cache, then reopen.'
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline</title>
<style>body{font:16px/1.4 system-ui,sans-serif;margin:2rem;color:#222;background:#fff}p{max-width:28rem}</style></head>
<body><p>${msg}</p></body></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  )
}

const PWA_ICON_PATHS = [
  '/pwa-icon-192.png',
  '/pwa-icon-512.png',
  '/pwa-icon-maskable-192.png',
  '/pwa-icon-maskable-512.png',
]

async function persistManifest(manifest, { clearIcons = false } = {}) {
  // Store page-authored manifest as-is (share_target comes from lib/pwa.js).
  // Icons are rasterized on demand in pwaIconResponse — page no longer transfers PNG buffers.
  manifestData = manifest || null
  const cache = await caches.open(CACHE)
  if (!manifestData) {
    await cache.delete('/manifest.overlay.json')
    return
  }
  await cache.put('/manifest.overlay.json', manifestResponse(manifestData))
  if (clearIcons) {
    const base = self.registration.scope.replace(/\/$/, '')
    for (const path of PWA_ICON_PATHS) {
      try {
        await cache.delete(path)
        await cache.delete(`${base}${path}`)
      } catch {
        /* ignore */
      }
    }
  }
}

async function loadPersistedManifest() {
  if (manifestData) return manifestData
  try {
    const hit = await caches.open(CACHE).then(c => c.match('/manifest.overlay.json'))
    if (!hit) return null
    manifestData = await hit.json()
    return manifestData
  } catch {
    return null
  }
}

async function navigationOfflineResponse() {
  const cache = await caches.open(CACHE)
  const hasClient = await matchPath(cache, '/client.js')
  const hasJquery = await matchPath(cache, '/js/jquery-4.0.0.js')
  const shell = await matchShellHtml(cache)
  if (shell && hasClient && hasJquery) return shell
  if (!hasClient) {
    return offlineHtml(
      'Offline — wiki scripts were not cached yet. Connect and open the site once, wait a few seconds, then try again.',
    )
  }
  return shell || offlineHtml()
}

async function matchCached(cache, request) {
  const pathname = new URL(request.url).pathname
  const hit =
    (await cache.match(request, { ignoreSearch: true })) || (await matchPath(cache, pathname)) || null
  if (hit) return hit
  const plugin = pluginNameFromPluginsPath(pathname)
  if (!plugin) return null
  const prefix = pluginPwaCachePrefix(plugin)
  try {
    for (const key of await caches.keys()) {
      if (!key.startsWith(prefix)) continue
      const pluginCache = await caches.open(key)
      const pluginHit = await matchPath(pluginCache, pathname, { request })
      if (pluginHit) return pluginHit
    }
  } catch {
    /* keep */
  }
  return null
}

function offlineMissResponse(request) {
  const pathname = new URL(request.url).pathname
  if (pathname.endsWith('.json')) {
    return new Response('Not cached offline', {
      status: 404,
      statusText: 'Not Found',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
  return new Response('', { status: 404, statusText: 'Not Found' })
}

function isShellPath(pathname) {
  return (
    SHELL.includes(pathname) ||
    pathname.startsWith('/js/') ||
    pathname.startsWith('/style/') ||
    pathname.startsWith('/theme/') ||
    pathname.startsWith('/images/') ||
    pathname.startsWith('/security/') ||
    pathname === '/favicon.png' ||
    pathname === '/client.js'
  )
}

function safeRespond(event, promise) {
  event.respondWith(
    Promise.resolve(promise).catch(err => {
      console.warn('[PWA SW] respondWith failed', err)
      return offlineHtml()
    }),
  )
}

function route(event) {
  const { request } = event
  // share_target is GET-only (see lib/pwa.js shareTarget). POST would need formData handling here.
  if (request.method !== 'GET') return false

  let url
  try {
    url = new URL(request.url)
  } catch {
    return false
  }

  const sameOrigin = url.origin === self.location.origin
  if (sameOrigin && isPluginPwaBridgePath(url.pathname)) return false

  if (sameOrigin && url.pathname === '/manifest.webmanifest') {
    safeRespond(
      event,
      (async () => {
        const overlay = await loadPersistedManifest()
        return overlay
          ? manifestResponse(overlay)
          : new Response('Not prepared', { status: 404, statusText: 'Not Found' })
      })(),
    )
    return true
  }

  if (sameOrigin && /^\/pwa-icon-(maskable-)?(192|512)\.png$/.test(url.pathname)) {
    // No client revalidate on miss — that remounted the manifest and spurred
    // origin icon probes (SW-bypass 404 noise). Favicon sync stays on visibility/online.
    safeRespond(event, pwaIconResponse(url.pathname))
    return true
  }

  const packed = () => hasPackedShell()
  const offlineAssetPath =
    sameOrigin &&
    (isShellPath(url.pathname) ||
      url.pathname.endsWith('.json') ||
      url.pathname.startsWith('/plugins/') ||
      url.pathname.startsWith('/plugin/') ||
      url.pathname.startsWith('/proxy/') ||
      url.pathname.startsWith('/assets/') ||
      url.pathname.endsWith('/favicon.png'))

  // Online + packed shell: only wiki navigations get network-first handling.
  // Custom asset pages (/assets/home, uploads, etc.) and plugin UIs must bypass
  // respondWith — owning those navigations hung browsers (worked in incognito).
  if (navigator.onLine) {
    if (sameOrigin && request.mode === 'navigate' && !isPassthroughNavigate(url.pathname)) {
      safeRespond(
        event,
        (async () => {
          try {
            const isPacked = await Promise.race([
              packed(),
              new Promise(resolve => setTimeout(() => resolve(false), 2000)),
            ])
            if (!isPacked) return fetch(request, { redirect: 'manual' })
            return networkFirstNavigate(request)
          } catch (err) {
            console.warn('[PWA SW] navigate failed; falling back to network', err)
            return fetch(request, { redirect: 'manual' })
          }
        })(),
      )
      return true
    }
    return false
  }

  // Appears offline: cache-first, then brief network probe (false-offline recovery).
  // Still never own /assets (or plugin) document navigations — let the browser try.
  if (sameOrigin && request.mode === 'navigate' && isPassthroughNavigate(url.pathname)) {
    return false
  }
  safeRespond(
    event,
    (async () => {
      if (!(await packed())) {
        try {
          return await networkWithTimeout(request)
        } catch {
          return fetch(request)
        }
      }

      if (sameOrigin && request.mode === 'navigate') {
        return cacheFirstThenNetwork(request, { navigate: true })
      }
      if (offlineAssetPath) return cacheFirstThenNetwork(request)
      if (url.hostname === 'cdn.jsdelivr.net') {
        const cache = await caches.open(CACHE)
        const cached =
          (await cache.match(request, { ignoreSearch: true })) ||
          (await cache.match(request.url, { ignoreSearch: true })) ||
          null
        if (cached) return cached
        try {
          return await networkWithTimeout(request)
        } catch {
          return new Response('', { status: 503, statusText: 'Offline' })
        }
      }
      try {
        return await networkWithTimeout(request)
      } catch {
        return fetch(request)
      }
    })(),
  )
  return true
}

self.addEventListener('message', event => {
  const data = event.data || {}
  if (data.type === 'SET_MANIFEST') {
    event.waitUntil(
      persistManifest(data.manifest, { clearIcons: !!data.clearIcons }).then(() => {
        event.ports?.[0]?.postMessage({ ok: true })
      }),
    )
  }
  if (data.type === 'CLAIM') self.clients.claim()
  if (data.type === 'SKIP_WAITING') self.skipWaiting()
  if (data.type === 'LARGE_PACK_CONSENT') {
    event.waitUntil(persistLargeConsent(!!data.allowed, data.maxBytes))
  }
  if (data.type === 'PRECACHE_SHELL') {
    event.waitUntil(
      precache().then(() => {
        event.ports?.[0]?.postMessage({ ok: true })
      }),
    )
  }
})

self.addEventListener('install', () => {
  // No skipWaiting here — page sends SKIP_WAITING (auto for browser tabs, banner for standalone).
  // No precache on install — shell pack runs via PRECACHE_SHELL after app install.
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(keys.filter(k => k.startsWith('fedwiki-pwa') && k !== CACHE).map(k => caches.delete(k))),
      )
      .then(async () => {
        // Drop legacy standalone flag key (no longer used for fetch routing).
        try {
          await (await caches.open(CACHE)).delete('/__pwa_standalone__')
        } catch {
          /* ignore */
        }
      })
      .then(() => self.clients.claim())
      .then(() => restorePersistedState()),
  )
})

self.addEventListener('fetch', event => {
  route(event)
})
