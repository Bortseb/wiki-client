const CACHE = 'fedwiki-pwa-1'
const SHELL_HTML = '/__wiki_shell__'
let manifestData = null
let standaloneActive = false
const MAX_CACHE_ASSET_BYTES_DEFAULT = 8 * 1024 * 1024
let maxCacheAssetBytes = MAX_CACHE_ASSET_BYTES_DEFAULT

function overLimit(n) {
  return Number.isFinite(maxCacheAssetBytes) && n > maxCacheAssetBytes
}


const SHELL = [
  '/view/welcome-visitors',
  '/style/style.css',
  '/theme/style.css',
  '/style/print.css',
  '/client.js',
  '/favicon.png',
  '/system/sitemap.json',
  '/system/site-index.json',
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

const ICON_REV_PATH = '/pwa-icon.rev'

function revFromHeaders(res) {
  const etag = res.headers.get('etag')
  if (etag) return etag.replace(/^W\//i, '').replace(/"/g, '')
  const lm = res.headers.get('last-modified')
  if (lm) return String(Date.parse(lm) || lm)
  return ''
}

function revFromBuffer(buf) {
  const u8 = new Uint8Array(buf)
  let h = u8.length
  const step = Math.max(1, Math.floor(u8.length / 64))
  for (let i = 0; i < u8.length; i += step) h = (Math.imul(31, h) + u8[i]) | 0
  return `b${u8.length.toString(36)}_${(h >>> 0).toString(36)}`
}

function revFromManifestIcons(manifest) {
  const src = manifest?.icons?.find(i => /pwa-icon-/i.test(i?.src || ''))?.src || manifest?.icons?.[0]?.src || ''
  try {
    return new URL(src, self.registration.scope).searchParams.get('v') || ''
  } catch {
    return ''
  }
}

async function readStoredIconRev(cache) {
  try {
    const hit = await cache.match(ICON_REV_PATH)
    return hit ? String(await hit.text() || '').trim() : ''
  } catch {
    return ''
  }
}

async function writeStoredIconRev(cache, rev) {
  if (!rev) return
  await cache.put(
    ICON_REV_PATH,
    new Response(String(rev), {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' },
    }),
  )
}

async function hasBuiltPwaIcons(cache) {
  return !!(await matchPath(cache, '/pwa-icon-192.png')) && !!(await matchPath(cache, '/pwa-icon-512.png'))
}

async function persistManifest(manifest, icons) {
  manifestData = manifest || null
  const cache = await caches.open(CACHE)
  if (!manifestData) {
    await cache.delete('/manifest.overlay.json')
    await cache.delete(ICON_REV_PATH)
    return
  }
  await cache.put('/manifest.overlay.json', manifestResponse(manifestData))
  const base = self.registration.scope.replace(/\/$/, '')
  for (const size of [192, 512]) {
    if (!icons?.[size]) continue
    const body = new Response(icons[size], {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' },
    })
    await cache.put(`/pwa-icon-${size}.png`, body.clone())
    await cache.put(`${base}/pwa-icon-${size}.png`, body.clone())
  }
  const rev = revFromManifestIcons(manifestData)
  if (rev) await writeStoredIconRev(cache, rev)
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

let iconRefreshPromise = null
let lastCheckedIconRev = ''

async function askClientsToRevalidateFavicon() {
  try {
    const clients = await self.clients.matchAll({ type: 'window' })
    for (const client of clients) client.postMessage({ type: 'REVALIDATE_FAVICON' })
  } catch {
    /* ignore */
  }
}

/** Cheap live favicon identity (etag / last-modified / body sample) — same scheme as pwa.js. */
async function liveFaviconIdentity() {
  const url = new URL('/favicon.png', self.registration.scope).href
  try {
    const head = await fetch(url, { method: 'HEAD', cache: 'no-cache', redirect: 'follow' })
    if (head.ok) {
      const rev = revFromHeaders(head)
      if (rev) return { rev, buf: null }
    }
  } catch {
    /* fall through to GET */
  }
  const res = await fetch(url, { cache: 'no-cache', redirect: 'follow' })
  if (!res.ok) return null
  const buf = await res.arrayBuffer()
  return { rev: revFromHeaders(res) || revFromBuffer(buf), buf }
}

/** Rebuild /pwa-icon-*.png from live /favicon.png only when the favicon rev changed. */
async function refreshPwaIconsFromFavicon() {
  if (iconRefreshPromise) return iconRefreshPromise
  iconRefreshPromise = (async () => {
    const cache = await caches.open(CACHE)
    const stored = lastCheckedIconRev || (await readStoredIconRev(cache)) || revFromManifestIcons(await loadPersistedManifest())
    const live = await liveFaviconIdentity()
    if (!live?.rev) return
    lastCheckedIconRev = live.rev
    if (live.rev === stored && (await hasBuiltPwaIcons(cache))) {
      if (live.rev !== (await readStoredIconRev(cache))) await writeStoredIconRev(cache, live.rev)
      return
    }

    if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
      await askClientsToRevalidateFavicon()
      return
    }

    let buf = live.buf
    if (!buf) {
      const res = await fetch(new URL('/favicon.png', self.registration.scope).href, {
        cache: 'no-cache',
        redirect: 'follow',
      })
      if (!res.ok) return
      buf = await res.arrayBuffer()
    }
    const bitmap = await createImageBitmap(new Blob([buf], { type: 'image/png' }))
    try {
      const base = self.registration.scope.replace(/\/$/, '')
      for (const size of [192, 512]) {
        const canvas = new OffscreenCanvas(size, size)
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = '#eeeeee'
        ctx.fillRect(0, 0, size, size)
        const scale = Math.min(size / bitmap.width, size / bitmap.height)
        const w = bitmap.width * scale
        const h = bitmap.height * scale
        ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h)
        const blob = await canvas.convertToBlob({ type: 'image/png' })
        const body = new Response(blob, {
          headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' },
        })
        await cache.put(`/pwa-icon-${size}.png`, body.clone())
        await cache.put(`${base}/pwa-icon-${size}.png`, body.clone())
      }
      await writeStoredIconRev(cache, live.rev)
    } finally {
      bitmap.close()
    }
  })()
    .catch(err => console.warn('[PWA SW] icon refresh failed', err))
    .finally(() => {
      iconRefreshPromise = null
    })
  return iconRefreshPromise
}

async function navigationOfflineResponse() {
  const cache = await caches.open(CACHE)
  const hasClient = await matchPath(cache, '/client.js')
  const hasJquery = await matchPath(cache, '/js/jquery-4.0.0.js')
  let shell = await matchPath(cache, SHELL_HTML)
  if (!shell) {
    for (const path of ['/view/welcome-visitors', '/welcome-visitors.html']) {
      const hit = await matchPath(cache, path)
      if (!hit) continue
      try {
        if (isWikiClientShellHtml(await hit.clone().text())) {
          shell = hit
          break
        }
      } catch {
        /* keep looking */
      }
    }
  }
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

async function networkFirst(request, { navigate = false } = {}) {
  const cache = await caches.open(CACHE)
  const pathname = new URL(request.url).pathname
  const pluginPath = pathname.startsWith('/plugins/')
  const pluginAssetPath = !!pluginNameFromPluginsPath(pathname)
  const miss = () =>
    navigate && !pluginPath ? navigationOfflineResponse() : offlineMissResponse(request)

  if (!navigator.onLine) return (await matchCached(cache, request)) || miss()

  if (pluginAssetPath) {
    const warm = await matchCached(cache, request)
    if (warm) {
      fetch(request)
        .then(res => {
          if (res?.ok) cachePut(cache, request, res.clone())
        })
        .catch(() => {})
      return warm
    }
  }
  try {
    const isHeavyAsset = pathname.startsWith('/assets/') || /^\/proxy\/[^/]+\/assets\//i.test(pathname)
    const signal =
      !isHeavyAsset && typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? AbortSignal.timeout(10000)
        : undefined
    const res = await fetch(request, signal ? { signal } : undefined)
    if (res.ok) {
      cachePut(cache, request, res.clone()).catch(() => {})
      return res
    }
    return (await matchCached(cache, request)) || res
  } catch {
    return (await matchCached(cache, request)) || miss()
  }
}

async function cdnCacheFirst(request) {
  const cache = await caches.open(CACHE)
  const cached =
    (await cache.match(request, { ignoreSearch: true })) ||
    (await cache.match(request.url, { ignoreSearch: true })) ||
    null
  if (!navigator.onLine) return cached || new Response('', { status: 503, statusText: 'Offline' })
  try {
    const res = await fetch(request)
    if (res.ok) {
      try {
        await cache.put(request, res.clone())
      } catch {
        /* opaque / quota */
      }
      return res
    }
    return cached || res
  } catch {
    return cached || new Response('', { status: 503, statusText: 'Offline' })
  }
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

self.addEventListener('message', event => {
  const data = event.data || {}
  if (data.type === 'SET_MANIFEST') {
    event.waitUntil(
      persistManifest(data.manifest, data.icons).then(() => {
        event.ports?.[0]?.postMessage({ ok: true })
      }),
    )
  }
  if (data.type === 'CLAIM') self.clients.claim()
  if (data.type === 'STANDALONE_ACTIVE') standaloneActive = !!data.active
  if (data.type === 'LARGE_PACK_CONSENT') {
    maxCacheAssetBytes = data.allowed
      ? Number(data.maxBytes) || Number.POSITIVE_INFINITY
      : MAX_CACHE_ASSET_BYTES_DEFAULT
  }
  if (data.type === 'PRECACHE_SHELL') {
    event.waitUntil(
      precache().then(() => {
        event.ports?.[0]?.postMessage({ ok: true })
      }),
    )
  }
})

self.addEventListener('install', event => {
  event.waitUntil(precache().then(() => self.skipWaiting()))
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(keys.filter(k => k.startsWith('fedwiki-pwa') && k !== CACHE).map(k => caches.delete(k))),
      )
      .then(() => self.clients.claim())
      .then(() => precache()),
  )
})

self.addEventListener('fetch', event => {
  const { request } = event
  if (request.method !== 'GET') return

  let url
  try {
    url = new URL(request.url)
  } catch {
    return
  }

  const sameOrigin = url.origin === self.location.origin
  if (sameOrigin && isPluginPwaBridgePath(url.pathname)) return

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
    return
  }

  if (sameOrigin && (url.pathname === '/pwa-icon-192.png' || url.pathname === '/pwa-icon-512.png')) {
    safeRespond(
      event,
      (async () => {
        const matchOpts = {
          request,
          ignoreSearch: true,
          ignoreMethod: true,
          ignoreVary: true,
        }
        const hit = await matchPath(await caches.open(CACHE), url.pathname, matchOpts)
        if (!navigator.onLine) return hit || new Response('', { status: 404 })

        const refresh = refreshPwaIconsFromFavicon()
        event.waitUntil(refresh)
        if (hit) return hit
        await refresh
        return (
          (await matchPath(await caches.open(CACHE), url.pathname, matchOpts)) ||
          new Response('', { status: 404 })
        )
      })(),
    )
    return
  }

  if (!standaloneActive) return

  if (sameOrigin && request.mode === 'navigate') {
    safeRespond(event, networkFirst(request, { navigate: !url.pathname.startsWith('/plugins/') }))
    return
  }

  if (sameOrigin && isShellPath(url.pathname)) {
    safeRespond(event, networkFirst(request))
    return
  }

  if (
    sameOrigin &&
    (url.pathname.endsWith('.json') ||
      url.pathname.startsWith('/plugins/') ||
      url.pathname.startsWith('/plugin/') ||
      url.pathname.startsWith('/proxy/') ||
      url.pathname.startsWith('/assets/') ||
      url.pathname.endsWith('/favicon.png'))
  ) {
    safeRespond(event, networkFirst(request))
    return
  }

  if (url.hostname === 'cdn.jsdelivr.net') safeRespond(event, cdnCacheFirst(request))
})
