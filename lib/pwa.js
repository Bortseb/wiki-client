// Opt-in PWA: install surface + offline pack/export (standalone PWA only; wiki outside of PWA stays stock).

const CACHE = 'fedwiki-pwa-2'
const OFFLINE_PACK_FLAG = `fedwiki-pwa-offline-ready:${CACHE}`
const PACK_PENDING_FLAG = `fedwiki-pwa-pack-pending:${CACHE}`
const FAVICON_REV_FLAG = `fedwiki-pwa-favicon-rev:${CACHE}`
const FAVICON_DISMISSED_REV_FLAG = `fedwiki-pwa-favicon-dismissed:${CACHE}`
const UPGRADE_BANNER_ID = 'wiki-pwa-upgrade-banner'

const LARGE_ASSET_CONSENT_FLAG = `fedwiki-pwa-large-consent:${CACHE}`
const LOCAL_CHANGES_PANEL_CLASS = 'wiki-pwa-offline-backup'
const LARGE_CONSENT_BANNER_ID = 'wiki-pwa-large-consent-banner'

let prepared = false
let prepareGeneration = 0
let faviconCheckPromise = null
let faviconUpgradePendingRev = null
let touchIconObjectUrl = null
let packChannel = null
let offlineCachePromise = null
let pluginWarmPromise = null
let warmedPlugins = new Set()
let localChangesObserver = null

function mountOnDocumentElement(el) {
  const mount = () => {
    if (el.parentNode !== document.documentElement) document.documentElement.appendChild(el)
  }
  if (document.documentElement) mount()
  else document.addEventListener('DOMContentLoaded', mount, { once: true })
}

const UPGRADE_BANNER_CSS =
  'position:fixed;left:0;right:0;bottom:0;z-index:2147483646;padding:10px 14px;background:#1a4a6e;color:#fff;box-shadow:0 -2px 8px rgba(0,0,0,.35);font:14px/1.4 system-ui,sans-serif;display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:center'

const BTN_PRIMARY =
  'padding:0.35em 0.85em;cursor:pointer;border:0;border-radius:3px;background:#fff;color:#1a4a6e;font:inherit;font-weight:600'
const BTN_GHOST =
  'padding:0.35em 0.75em;cursor:pointer;border:1px solid rgba(255,255,255,.5);border-radius:3px;background:transparent;color:#fff;font:inherit'

function bannerBtn(label, style, onClick) {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = label
  b.style.cssText = style
  b.addEventListener('click', onClick)
  return b
}

function panelBtn(label, onClick) {
  return bannerBtn(label, 'padding:0.35em 0.75em;cursor:pointer', onClick)
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function setLargeAssetConsent(mode, { refresh } = {}) {
  writeLargeAssetConsent(mode)
  if (mode === 'allow') {
    hideLargeConsentBanner()
    packPendingLargeAssets().catch(err => console.warn('[PWA] large pack', err))
    scheduleNeighborhoodBackgroundPacks(true)
  } else if (mode === 'deny') {
    pendingLargeAssets.clear()
    hideLargeConsentBanner()
  } else {
    scheduleNeighborhoodBackgroundPacks()
  }
  if (refresh) refresh()
  else if (mode !== 'ask') syncLocalChangesPanel()
}

function ensureBanner(id, fill) {
  let el = document.getElementById(id)
  if (!el) {
    el = document.createElement('div')
    el.id = id
    el.setAttribute('role', 'status')
    el.style.cssText = UPGRADE_BANNER_CSS
    fill(el)
  }
  mountOnDocumentElement(el)
  el.hidden = false
  return el
}

function bumpPackDone(site, status, field) {
  status[field] = (status[field] || 0) + 1
  bgPackStatus.set(site, { ...status })
}

function needsManualAppUpgradeUi() {
  const ua = navigator.userAgent || ''
  if (/iPhone|iPad|iPod/i.test(ua)) return true
  if (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1) return true
  return false
}

function hideBanner(id) {
  document.getElementById(id)?.remove()
}
function hideUpgradeBanner() {
  hideBanner(UPGRADE_BANNER_ID)
}

function showUpgradeBanner() {
  if (typeof document === 'undefined' || !isStandalone()) return
  if (!needsManualAppUpgradeUi() || !faviconUpgradePendingRev) {
    hideUpgradeBanner()
    return
  }
  ensureBanner(UPGRADE_BANNER_ID, el => {
    const msg = document.createElement('span')
    msg.textContent = 'Site icon changed. Update this app\u2019s saved icon?'
    el.append(
      msg,
      bannerBtn('Update icon', BTN_PRIMARY, () => {
        applyManualAppUpgrade().catch(err => console.warn('[PWA] icon upgrade failed', err))
      }),
      bannerBtn('Not now', BTN_GHOST, () => dismissManualAppUpgrade()),
    )
  })
}

function lsGet(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function lsFlag(key) {
  return lsGet(key) === '1'
}

function lsSetFlag(key, on) {
  try {
    if (on) localStorage.setItem(key, '1')
    else localStorage.removeItem(key)
  } catch {
    /* private mode / quota */
  }
}

const writeOfflinePackFlag = ok => lsSetFlag(OFFLINE_PACK_FLAG, !!ok)
const writePackPending = on => lsSetFlag(PACK_PENDING_FLAG, on)
const readOfflinePackFlag = () => lsFlag(OFFLINE_PACK_FLAG)
const readPackPending = () => lsFlag(PACK_PENDING_FLAG)

function needsOfflinePack() {
  return readPackPending() || !readOfflinePackFlag()
}

function isStandalone() {
  if (navigator.standalone === true) return true
  if (!window.matchMedia) return false
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: minimal-ui)').matches ||
    window.matchMedia('(display-mode: window-controls-overlay)').matches
  )
}

function tellServiceWorkerStandalone(active) {
  try {
    const sw = navigator.serviceWorker?.controller
    if (sw) sw.postMessage({ type: 'STANDALONE_ACTIVE', active: !!active })
    navigator.serviceWorker?.ready?.then(reg => {
      if (reg.active) reg.active.postMessage({ type: 'STANDALONE_ACTIVE', active: !!active })
    })
  } catch {
    /* ignore */
  }
}

if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    tellServiceWorkerStandalone(isStandalone())
  })
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data?.type !== 'REVALIDATE_FAVICON') return
    syncFaviconIntoManifest().catch(() => {})
  })
}

function isSecureInstallContext() {
  const host = location.hostname
  return location.protocol === 'https:' || host === 'localhost' || host === '127.0.0.1' || /\.localhost$/i.test(host)
}

function domainIdentity() {
  const host = location.hostname || 'fedwiki'
  const origin = location.origin
  return {
    name: host,
    id: `${origin}/`,
    startUrl: `${origin}/`,
    scope: `${origin}/`,
  }
}

function setApplicationName(title) {
  let meta = document.head.querySelector('meta[name="application-name"]')
  if (!meta) {
    meta = document.createElement('meta')
    meta.name = 'application-name'
    document.head.appendChild(meta)
  }
  meta.content = title
}

async function faviconRev() {
  try {
    const res = await fetch(`${location.origin}/favicon.png`, { cache: 'no-cache' })
    if (!res.ok) return String(Date.now())
    const etag = res.headers.get('etag')
    const lm = res.headers.get('last-modified')
    if (etag) return etag.replace(/^W\//i, '').replace(/"/g, '')
    if (lm) return String(Date.parse(lm) || lm)
    const buf = await res.arrayBuffer()
    const u8 = new Uint8Array(buf)
    let h = u8.length
    const step = Math.max(1, Math.floor(u8.length / 64))
    for (let i = 0; i < u8.length; i += step) h = (Math.imul(31, h) + u8[i]) | 0
    return `b${u8.length.toString(36)}_${(h >>> 0).toString(36)}`
  } catch {
    return String(Date.now())
  }
}

function lsSet(key, value) {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}
const readAppliedFaviconRev = () => lsGet(FAVICON_REV_FLAG) || ''
const writeAppliedFaviconRev = rev => lsSet(FAVICON_REV_FLAG, rev)
const readDismissedFaviconRev = () => lsGet(FAVICON_DISMISSED_REV_FLAG) || ''
const writeDismissedFaviconRev = rev => lsSet(FAVICON_DISMISSED_REV_FLAG, rev)

function dismissManualAppUpgrade() {
  if (faviconUpgradePendingRev) writeDismissedFaviconRev(faviconUpgradePendingRev)
  faviconUpgradePendingRev = null
  hideUpgradeBanner()
}

async function applyManualAppUpgrade() {
  await injectManifest({ force: true })
  faviconUpgradePendingRev = null
  hideUpgradeBanner()
}

function syncFaviconIntoManifest() {
  if (!isSecureInstallContext() || !navigator.onLine) return Promise.resolve()
  if (faviconCheckPromise) return faviconCheckPromise
  faviconCheckPromise = (async () => {
    const live = await faviconRev()
    const applied = readAppliedFaviconRev()
    if (!applied) return
    if (live === applied) {
      faviconUpgradePendingRev = null
      hideUpgradeBanner()
      return
    }
    if (live === readDismissedFaviconRev()) {
      faviconUpgradePendingRev = null
      hideUpgradeBanner()
      return
    }

    if (needsManualAppUpgradeUi()) {
      faviconUpgradePendingRev = live
      if (isStandalone()) showUpgradeBanner()
      return
    }

    await injectManifest({ force: true })
  })()
    .catch(err => console.warn('[PWA] favicon sync failed', err))
    .finally(() => {
      faviconCheckPromise = null
    })
  return faviconCheckPromise
}

async function scaleFaviconBlob(size) {
  const rev = await faviconRev()
  const res = await fetch(`${location.origin}/favicon.png?v=${encodeURIComponent(rev)}`, {
    cache: 'no-cache',
  })
  if (!res.ok) throw new Error(`favicon ${res.status}`)
  const bitmap = await createImageBitmap(await res.blob())
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#eeeeee'
  ctx.fillRect(0, 0, size, size)
  const scale = Math.min(size / bitmap.width, size / bitmap.height)
  const w = bitmap.width * scale
  const h = bitmap.height * scale
  ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h)
  bitmap.close()
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('toBlob failed')
  return { blob, rev }
}

async function cacheScaledFavicon(size, path) {
  const rev = await faviconRev()
  const url = `${location.origin}${path}`
  const cache = await caches.open(CACHE)
  if (rev && rev === readAppliedFaviconRev()) {
    const hit =
      (await cache.match(path, { ignoreSearch: true })) || (await cache.match(url, { ignoreSearch: true }))
    if (hit?.ok) return { url, buffer: await hit.clone().arrayBuffer(), rev }
  }
  const res = await fetch(`${location.origin}/favicon.png?v=${encodeURIComponent(rev)}`, {
    cache: 'no-cache',
  })
  if (!res.ok) throw new Error(`favicon ${res.status}`)
  const bitmap = await createImageBitmap(await res.blob())
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#eeeeee'
  ctx.fillRect(0, 0, size, size)
  const scale = Math.min(size / bitmap.width, size / bitmap.height)
  const w = bitmap.width * scale
  const h = bitmap.height * scale
  ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h)
  bitmap.close()
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('toBlob failed')
  const response = new Response(blob, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' },
  })
  await cache.put(path, response.clone())
  await cache.put(url, response.clone())
  return { url, buffer: await blob.arrayBuffer(), rev }
}

async function applyFaviconLinks() {
  const href = `${location.origin}/favicon.png`
  let touch = document.head.querySelector('link[rel="apple-touch-icon"]')
  if (!touch) {
    touch = document.createElement('link')
    touch.rel = 'apple-touch-icon'
    document.head.appendChild(touch)
  }
  try {
    const { blob } = await scaleFaviconBlob(192)
    if (touchIconObjectUrl) URL.revokeObjectURL(touchIconObjectUrl)
    touchIconObjectUrl = URL.createObjectURL(blob)
    touch.href = touchIconObjectUrl
    touch.setAttribute('sizes', '192x192')
  } catch {
    touch.href = href
    touch.removeAttribute('sizes')
  }

  let icon = document.head.querySelector('link[rel="icon"][data-wiki-pwa="1"]')
  if (!icon) {
    icon = document.createElement('link')
    icon.rel = 'icon'
    icon.setAttribute('data-wiki-pwa', '1')
    document.head.appendChild(icon)
  }
  icon.type = 'image/png'
  icon.href = href

  if (!document.head.querySelector('meta[name="apple-mobile-web-app-capable"]')) {
    const meta = document.createElement('meta')
    meta.name = 'apple-mobile-web-app-capable'
    meta.content = 'yes'
    document.head.appendChild(meta)
  }
}

async function ensureServiceWorker() {
  const reg = await navigator.serviceWorker.register('/service-worker.js', {
    scope: '/',
    updateViaCache: 'none',
  })
  await navigator.serviceWorker.ready
  if (reg.active) reg.active.postMessage({ type: 'CLAIM' })
  if (!navigator.serviceWorker.controller) {
    await new Promise(resolve => {
      const t = setTimeout(resolve, 1500)
      navigator.serviceWorker.addEventListener(
        'controllerchange',
        () => {
          clearTimeout(t)
          resolve()
        },
        { once: true },
      )
    })
  }
  return reg
}

function postManifest(reg, manifest, icons) {
  const target = reg.active || navigator.serviceWorker.controller
  if (!target) return Promise.reject(new Error('No active service worker'))
  return new Promise(resolve => {
    const channel = new MessageChannel()
    const timer = setTimeout(resolve, 800)
    channel.port1.onmessage = () => {
      clearTimeout(timer)
      resolve()
    }
    const transfer = [channel.port2]
    if (icons && icons[192]) transfer.push(icons[192])
    if (icons && icons[512]) transfer.push(icons[512])
    target.postMessage({ type: 'SET_MANIFEST', manifest, icons }, transfer)
  })
}

async function injectManifest({ force = false } = {}) {
  const gen = ++prepareGeneration
  const reg = await ensureServiceWorker()
  if (gen !== prepareGeneration) return null

  tellServiceWorkerStandalone(isStandalone())

  const origin = location.origin
  const { name: title, id: appId, startUrl, scope } = domainIdentity()

  if (!force && prepared) {
    syncFaviconIntoManifest().catch(() => {})
    return { name: title }
  }

  const icon192 = await cacheScaledFavicon(192, '/pwa-icon-192.png')
  if (gen !== prepareGeneration) return null
  const icon512 = await cacheScaledFavicon(512, '/pwa-icon-512.png')
  if (gen !== prepareGeneration) return null

  const manifest = {
    id: appId,
    name: title,
    short_name: title,
    start_url: startUrl,
    scope,
    display: 'standalone',
    background_color: '#eeeeee',
    theme_color: '#333333',
    icons: [
      {
        src: `${icon192.url}?v=${encodeURIComponent(icon192.rev || Date.now())}`,
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: `${icon512.url}?v=${encodeURIComponent(icon512.rev || Date.now())}`,
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      { src: `${origin}/favicon.png`, sizes: '64x64', type: 'image/png', purpose: 'any' },
    ],
  }

  await postManifest(reg, manifest, { 192: icon192.buffer, 512: icon512.buffer })
  if (gen !== prepareGeneration) return null

  await applyFaviconLinks()
  setApplicationName(title)

  let link = document.head.querySelector('link[rel="manifest"]')
  if (!link) {
    link = document.createElement('link')
    link.rel = 'manifest'
    document.head.appendChild(link)
  }
  link.href = `${origin}/manifest.webmanifest?t=${Date.now()}`

  const check = await fetch(`${origin}/manifest.webmanifest?t=${Date.now()}`, { cache: 'no-store' })
  if (!check.ok) throw new Error(`manifest ${check.status}`)
  const i192 = await fetch(icon192.url, { cache: 'no-store' })
  if (!i192.ok) throw new Error(`icon192 ${i192.status}`)

  if (gen !== prepareGeneration) return null
  prepared = true
  if (icon192.rev) {
    writeAppliedFaviconRev(icon192.rev)
    writeDismissedFaviconRev('')
    faviconUpgradePendingRev = null
    hideUpgradeBanner()
  }
  return manifest
}

function prepareInstallSurface() {
  if (!isSecureInstallContext()) return
  injectManifest()
    .then(() => syncFaviconIntoManifest())
    .catch(err => console.warn('[PWA] prepare failed', err))
}

function hideLargeConsentBanner() {
  hideBanner(LARGE_CONSENT_BANNER_ID)
}

function showLargeConsentBanner() {
  if (typeof document === 'undefined' || !isStandalone()) return
  if (readLargeAssetConsent() !== 'ask') {
    hideLargeConsentBanner()
    return
  }
  const summary = summarizePendingLargeAssets()
  if (!summary.count) {
    hideLargeConsentBanner()
    return
  }
  const el = ensureBanner(LARGE_CONSENT_BANNER_ID, node => {
    const msg = document.createElement('span')
    msg.dataset.role = 'msg'
    node.append(
      msg,
      bannerBtn('Pack large files', BTN_PRIMARY, () => setLargeAssetConsent('allow')),
      bannerBtn('Not now', BTN_GHOST, () => hideLargeConsentBanner()),
      bannerBtn('Never', BTN_GHOST, () => setLargeAssetConsent('deny')),
    )
  })
  const msg = el.querySelector('[data-role="msg"]')
  if (msg) {
    const siteNote = summary.sites.length ? ` (${summary.sites.join(', ')})` : ''
    msg.textContent = `${plural(summary.count, 'large asset')} (${formatBytes(summary.bytes)}) not packed yet${siteNote}. Pack them into the offline backup?`
  }
}

function readLargeAssetConsent() {
  const v = lsGet(LARGE_ASSET_CONSENT_FLAG)
  if (v === 'allow' || v === 'deny') return v
  return 'ask'
}

function writeLargeAssetConsent(value) {
  lsSet(LARGE_ASSET_CONSENT_FLAG, value === 'allow' || value === 'deny' ? value : '')
  tellServiceWorkerLargeConsent(value === 'allow')
}

function pendingLargeKey(site, rel) {
  return `${site}:${rel}`
}

function queuePendingLargeAsset(entry) {
  const key = pendingLargeKey(entry.site, entry.rel)
  pendingLargeAssets.set(key, entry)
}

function summarizePendingLargeAssets() {
  let bytes = 0
  const sites = new Set()
  for (const e of pendingLargeAssets.values()) {
    bytes += e.size || 0
    if (e.site) sites.add(e.site)
  }
  return { count: pendingLargeAssets.size, bytes, sites: [...sites].sort() }
}

function tellServiceWorkerLargeConsent(allowed) {
  const sw = navigator.serviceWorker?.controller
  if (!sw) return
  try {
    sw.postMessage({
      type: 'LARGE_PACK_CONSENT',
      allowed: !!allowed,
      maxBytes: allowed ? Number.POSITIVE_INFINITY : MAX_PACK_ASSET_BYTES,
    })
  } catch {
    /* ignore */
  }
}

const LOCAL_SITE_KEYS = new Set(['origin', 'view', 'local', 'recycler'])

function isHere(site) {
  const s = String(site || '').toLowerCase()
  if (!s || LOCAL_SITE_KEYS.has(s)) return true
  const host = (location.host || '').toLowerCase()
  const hostname = (location.hostname || '').toLowerCase()
  return s === host || s === hostname
}

function normalizeRemoteHost(site) {
  let s = String(site || '')
    .toLowerCase()
    .trim()
  if (!s || isHere(s)) return ''
  if (s.endsWith(':')) s = s.slice(0, -1)
  if (s === 'localhost' || s.startsWith('localhost:') || s.includes('.localhost')) return ''
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(s)) return ''
  return s
}

const BUILTIN_TYPES = new Set(['paragraph', 'reference', 'factory', 'future', 'importer'])
const FETCH_CONCURRENCY = 8
const MAX_PLUGIN_ASSETS = 500

const BG_PAGE_CONCURRENCY = 2
const BG_ASSET_CONCURRENCY = 1
const IMAGE_ASSET_RE = /\.(png|jpe?g|gif|webp|svg|ico|avif)(\?|$)/i

const MAX_PACK_ASSET_BYTES = 8 * 1024 * 1024

const bgPackStatus = new Map()
const bgPackInflight = new Set()

let uiPriorityDepth = 0
const bgWaiters = []

const pendingLargeAssets = new Map()

function wakeBgWaiters() {
  if (!bgWaiters.length) return
  const waiters = bgWaiters.splice(0, bgWaiters.length)
  for (const wake of waiters) wake()
}

function beginUiPriority() {
  uiPriorityDepth += 1
}

function endUiPriority() {
  uiPriorityDepth = Math.max(0, uiPriorityDepth - 1)
  if (uiPriorityDepth === 0) wakeBgWaiters()
}

async function withUiPriority(fn) {
  beginUiPriority()
  try {
    return await fn()
  } finally {
    endUiPriority()
  }
}

async function awaitBgTurn() {
  while (uiPriorityDepth > 0) {
    await new Promise(resolve => bgWaiters.push(resolve))
  }
}

function patchPageLoadPriority() {
  let refresh
  try {
    refresh = require('./refresh')
  } catch {
    return
  }
  if (refresh.__pwaUiPriority) return
  refresh.__pwaUiPriority = true

  const wrap = orig =>
    function pwaPriorityWrap(...args) {
      // cycle → buildPage: stay under the outer cycle priority only.
      if (uiPriorityDepth > 0) return orig.apply(this, args)
      beginUiPriority()
      try {
        return Promise.resolve(orig.apply(this, args)).finally(endUiPriority)
      } catch (err) {
        endUiPriority()
        throw err
      }
    }

  if (typeof refresh.cycle === 'function') refresh.cycle = wrap(refresh.cycle)
  if (typeof refresh.buildPage === 'function') refresh.buildPage = wrap(refresh.buildPage)
}

patchPageLoadPriority()

function startOfflineCache(force = false) {
  if (!isStandalone()) {
    return Promise.resolve(null)
  }
  if (force && !offlineCachePromise) {
    writeOfflinePackFlag(false)
    writePackPending(true)
  }
  if (!offlineCachePromise) {
    console.info('[PWA] offline seed starting')
    writePackPending(true)
    offlineCachePromise = seedOfflineBackup()
      .then(() => {
        writeOfflinePackFlag(true)
        writePackPending(false)
        console.info('[PWA] offline seed ready')
        return ensurePluginsFromOpenPages()
      })
      .catch(err => {
        console.warn('[PWA] offline seed failed', err)
        writeOfflinePackFlag(false)
        throw err
      })
      .finally(() => {
        offlineCachePromise = null
      })
  }
  return offlineCachePromise
}

async function putInCaches(cache, abs, toStore, extraCaches = []) {
  const keys = new Set([abs])
  try {
    const u = new URL(abs)
    keys.add(u.pathname + u.search)
    if (u.origin === location.origin) keys.add(u.pathname)
  } catch {
    /* keep */
  }
  for (const target of [cache, ...extraCaches]) {
    for (const key of keys) {
      try {
        await target.put(key, toStore.clone())
      } catch {
        /* keep */
      }
    }
  }
}

async function responseForCache(res, abs, { cross = false } = {}) {
  if (!res.redirected && !cross) return res
  const buf = await res.arrayBuffer()
  const headers = new Headers(res.headers)
  if (cross && !headers.get('Content-Type')) {
    if (/\.css(\?|$)/i.test(abs)) headers.set('Content-Type', 'text/css')
    else if (/\.js(\?|$)/i.test(abs)) headers.set('Content-Type', 'application/javascript')
  }
  return new Response(buf, { status: res.status, statusText: res.statusText, headers })
}

function isWikiSiteAssetUrl(url) {
  try {
    const u = new URL(url, location.origin)
    const path = u.pathname || ''
    if (path === '/assets' || path.startsWith('/assets/')) return true
    if (/^\/proxy\/[^/]+\/assets(\/|$)/i.test(path)) return true
    return false
  } catch {
    return false
  }
}

function isCommonsImageAssetUrl(url) {
  try {
    const path = new URL(url, location.origin).pathname || ''
    if (!IMAGE_ASSET_RE.test(path)) return false
    return /^\/proxy\/[^/]+\/assets(\/|$)/i.test(path)
  } catch {
    return false
  }
}

async function cacheUrl(cache, url, extraCaches = [], { allowWikiAssets = false, tries = 1 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const abs = new URL(url, location.origin).href
      if (isWikiSiteAssetUrl(abs) && !allowWikiAssets && !isCommonsImageAssetUrl(abs)) return null
      const cross = new URL(abs).origin !== location.origin
      const res = await fetch(abs, {
        redirect: 'follow',
        credentials: cross ? 'omit' : 'same-origin',
        mode: 'cors',
      })
      if (!res.ok) {
        if (tries > 1 && res.status >= 400 && res.status < 500) return null
      } else {
        const toStore = await responseForCache(res, abs, { cross })
        await putInCaches(cache, abs, toStore, extraCaches)
        return toStore
      }
    } catch {
      if (tries <= 1) return null
    }
    if (i + 1 < tries) await new Promise(r => setTimeout(r, 250 * (i + 1)))
  }
  return null
}

function requestPrecacheShell() {
  const sw = navigator.serviceWorker?.controller
  if (!sw) return Promise.resolve()
  return new Promise(resolve => {
    const channel = new MessageChannel()
    const timer = setTimeout(resolve, 8000)
    channel.port1.onmessage = () => {
      clearTimeout(timer)
      resolve()
    }
    try {
      sw.postMessage({ type: 'PRECACHE_SHELL' }, [channel.port2])
    } catch {
      clearTimeout(timer)
      resolve()
    }
  })
}

async function mapPool(items, limit, fn, { background = false } = {}) {
  const queue = [...items]
  const n = Math.max(1, Math.min(limit, queue.length || 1))
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (queue.length) {
        if (background) await awaitBgTurn()
        const item = queue.shift()
        if (item === undefined) break
        await fn(item)
      }
    }),
  )
}

function collectTypesFromPage(page, plugins) {
  for (const item of page?.story || []) {
    if (item?.type) plugins.add(String(item.type))
  }
}

const DEFAULT_LOCAL_SLUGS = [
  'welcome-visitors',
  'recent-changes',
  'how-to-wiki',
  'about-federated-wiki',
  'federated-wiki',
  'local-changes',
  'admin',
]

function proxyRouteUrl(site, route) {
  const clean = String(route || '').replace(/^\//, '')
  return `${location.origin}/proxy/${site}/${clean}`
}

async function cacheSiteRoute(cache, site, route, { allowWikiAssets = false } = {}) {
  const clean = String(route || '').replace(/^\//, '')
  const isAsset = clean === 'assets' || clean.startsWith('assets/')
  if (isAsset && !allowWikiAssets) {
    if (!isHere(site) || !IMAGE_ASSET_RE.test(clean)) return null
  }
  if (isHere(site)) {
    return cacheUrl(cache, `${location.origin}/${clean}`, [], { allowWikiAssets: allowWikiAssets || isAsset })
  }

  const proxyUrl = proxyRouteUrl(site, clean)
  const directHttps = `https://${site}/${clean}`

  let body = null
  let contentType = 'application/octet-stream'
  let lastModified = null
  try {
    const net = await fetch(directHttps, { redirect: 'follow', credentials: 'omit', mode: 'cors' })
    if (net.ok) {
      body = await net.arrayBuffer()
      contentType = net.headers.get('Content-Type') || contentType
      lastModified = net.headers.get('Last-Modified')
    }
  } catch {
    /* CORS / network — try proxy next */
  }

  if (!body) {
    const res = await cacheUrl(cache, proxyUrl, [], {
      allowWikiAssets: allowWikiAssets || (isAsset && IMAGE_ASSET_RE.test(clean)),
    })
    if (res) return res
    return null
  }

  const headers = { 'Content-Type': contentType }
  headers['Last-Modified'] = lastModified || new Date().toUTCString()
  const mirrored = new Response(body.slice(0), {
    status: 200,
    statusText: 'OK',
    headers,
  })
  await putInCaches(cache, proxyUrl, mirrored, [])
  return mirrored
}

function pageSlugFromEl($page) {
  return String($page.attr('id') || '')
    .split('_rev')[0]
    .trim()
}

function collectTypesFromOpenPages(plugins) {
  if (typeof $ === 'undefined') return
  $('.page').each(function () {
    const page = $(this).data('data')
    if (page) collectTypesFromPage(page, plugins)
  })
}

async function cacheOpenLineupPages(cache) {
  if (typeof $ === 'undefined') return
  const localSite = (location.host || 'origin').toLowerCase()
  const jobs = []
  $('.page').each(function () {
    const $p = $(this)
    const slug = pageSlugFromEl($p)
    if (!slug) return
    const site = normalizeRemoteHost($p.data('site')) || localSite
    jobs.push(cacheSiteRoute(cache, site, `${slug}.json`))
  })
  await Promise.all(jobs)
}

async function warmPluginNames(pluginNames) {
  if (!pluginNames.length || !('caches' in window)) return
  const cache = await caches.open(CACHE)
  const results = []
  for (let i = 0; i < pluginNames.length; i += 2) {
    const slice = pluginNames.slice(i, i + 2)
    const part = await Promise.all(slice.map(name => cachePluginClientTree(cache, name)))
    results.push(...part)
    for (const name of slice) warmedPlugins.add(name)
  }
  const missing = results.filter(r => r && r.ok === false)
  if (missing.length) {
    console.warn(
      '[PWA] offline plugin gaps',
      missing.map(m => `${m.name}:${(m.failedSeeds || []).length}`),
    )
  }
}

function ensurePluginsFromOpenPages() {
  if (!isStandalone() || !navigator.onLine) return Promise.resolve()
  if (pluginWarmPromise) return pluginWarmPromise
  const plugins = new Set()
  collectTypesFromOpenPages(plugins)
  const fresh = [...plugins].filter(name => name && !BUILTIN_TYPES.has(name) && !warmedPlugins.has(name))
  if (!fresh.length) return Promise.resolve()
  pluginWarmPromise = withUiPriority(() => warmPluginNames(fresh)).finally(() => {
    pluginWarmPromise = null
  })
  return pluginWarmPromise
}

async function seedOfflineBackup() {
  if (!('caches' in window)) throw new Error('Cache Storage unavailable')
  if (!navigator.onLine) throw new Error('offline seed skipped (offline)')
  await ensurePersistentStorage()
  const cache = await caches.open(CACHE)
  const localSite = (location.host || 'origin').toLowerCase()

  await withUiPriority(async () => {
    await requestPrecacheShell()
    const shellUrls = [
      `${location.origin}/welcome-visitors.json`,
      `${location.origin}/system/sitemap.json`,
      `${location.origin}/system/site-index.json`,
      `${location.origin}/system/factories.json`,
      `${location.origin}/plugin/plugmatic/plugins`,
    ]
    await mapPool(shellUrls, FETCH_CONCURRENCY, url => cacheUrl(cache, url))
    await cacheSiteRoute(cache, localSite, 'favicon.png')
    await cacheSiteRoute(cache, localSite, 'system/sitemap.json')
    await cacheSiteRoute(cache, localSite, 'system/site-index.json')
    await cacheOpenLineupPages(cache)
  })

  console.info('[PWA] offline seed ready — scheduling background site packs')
  scheduleNeighborhoodBackgroundPacks()

  mapPool(DEFAULT_LOCAL_SLUGS, BG_PAGE_CONCURRENCY, slug => cacheSiteRoute(cache, localSite, `${slug}.json`), {
    background: true,
  }).catch(err => console.warn('[PWA] default slug pack', err))
}

function normalizeAssetRelPath(filePath) {
  return String(filePath || '')
    .replace(/\\/g, '/')
    .replace(/^\//, '')
    .replace(/^assets\//i, '')
}

async function fetchAssetIndex(site) {
  const urls = isHere(site)
    ? [`${location.origin}/plugin/assets/index`]
    : [`https://${site}/plugin/assets/index`, proxyRouteUrl(site, 'plugin/assets/index')]
  for (const url of urls) {
    try {
      const cross = new URL(url, location.origin).origin !== location.origin
      const res = await fetch(url, {
        redirect: 'follow',
        credentials: cross ? 'omit' : 'same-origin',
        mode: 'cors',
      })
      if (!res.ok) continue
      const data = await res.json()
      if (Array.isArray(data)) return data
    } catch {
      /* try next */
    }
  }
  return []
}

async function cacheHas(cache, url) {
  try {
    const abs = new URL(url, location.origin).href
    return !!(await cache.match(abs, { ignoreSearch: true }))
  } catch {
    return false
  }
}

async function mappedAssetEntries(site, predicate) {
  return (await fetchAssetIndex(site))
    .map(e => ({ rel: normalizeAssetRelPath(e?.file), size: Number(e?.size) || 0 }))
    .filter(e => e.rel && (!predicate || predicate(e)))
}

async function commonsImageAlreadyPacked(cache, fileName) {
  if (!fileName) return false
  if (await cacheHas(cache, `${location.origin}/assets/plugins/image/${fileName}`)) return true
  for (const site of Object.keys(wiki.neighborhood || {})) {
    const remote = normalizeRemoteHost(site)
    if (!remote) continue
    if (await cacheHas(cache, proxyRouteUrl(remote, `assets/plugins/image/${fileName}`))) return true
  }
  return false
}

function partitionAssetsForPack(mapped, site, kind) {
  const consent = readLargeAssetConsent()
  const auto = []
  for (const e of mapped) {
    if (e.size <= MAX_PACK_ASSET_BYTES) {
      auto.push(e)
      continue
    }
    if (consent === 'allow') auto.push(e)
    else if (consent === 'ask') queuePendingLargeAsset({ site, rel: e.rel, size: e.size, kind })
  }
  const pending = summarizePendingLargeAssets()
  if (pending.count) showLargeConsentBanner()
  return { auto, pending }
}

function setPackPhase(site, phase, totals) {
  const status = Object.assign(bgPackStatus.get(site) || {}, { phase, ...totals })
  bgPackStatus.set(site, status)
  return status
}

async function packOriginAssets(cache, site) {
  const mapped = await mappedAssetEntries(site)
  const { auto, pending } = partitionAssetsForPack(mapped, site, 'origin')
  if (pending.count) console.info('[PWA] origin assets: awaiting consent for', pending.count, 'large file(s)')
  const status = setPackPhase(site, 'assets', {
    assetTotal: auto.length, assetDone: 0, largePending: pending.count,
  })
  await mapPool(
    auto,
    BG_ASSET_CONCURRENCY,
    async ({ rel }) => {
      const url = `${location.origin}/assets/${rel}`
      if (!(await cacheHas(cache, url))) await cacheUrl(cache, url, [], { allowWikiAssets: true })
      await bumpPackDone(site, status, 'assetDone')
    },
    { background: true },
  )
}

async function packCommonsImages(cache, site) {
  if (isHere(site)) return
  const mapped = await mappedAssetEntries(site, e => imagePluginAssetFileName(`assets/${e.rel}`))
  const { auto, pending } = partitionAssetsForPack(mapped, site, 'commons')
  const status = setPackPhase(site, 'images', {
    imageTotal: auto.length, imageDone: 0, largePending: pending.count,
  })
  await mapPool(
    auto,
    BG_ASSET_CONCURRENCY,
    async ({ rel }) => {
      const fileName = imagePluginAssetFileName(`assets/${rel}`)
      if (fileName && (await commonsImageAlreadyPacked(cache, fileName))) {
        await bumpPackDone(site, status, 'imageDone')
        return
      }
      const proxyUrl = proxyRouteUrl(site, `assets/${rel}`)
      if (!(await cacheHas(cache, proxyUrl))) {
        await cacheSiteRoute(cache, site, `assets/${rel}`, { allowWikiAssets: true })
      }
      await bumpPackDone(site, status, 'imageDone')
    },
    { background: true },
  )
}

async function offerLargeNeighborAssets(site) {
  if (isHere(site)) return
  if (readLargeAssetConsent() === 'deny') return
  const mapped = await mappedAssetEntries(site, e => !imagePluginAssetFileName(`assets/${e.rel}`))
  partitionAssetsForPack(mapped, site, 'neighbor')
  if (readLargeAssetConsent() === 'allow' && pendingLargeAssets.size) await packPendingLargeAssets()
}

async function packPendingLargeAssets() {
  if (!isStandalone() || !navigator.onLine || !('caches' in window)) return
  if (readLargeAssetConsent() !== 'allow') return
  const batch = [...pendingLargeAssets.values()]
  if (!batch.length) return
  const cache = await caches.open(CACHE)
  for (const entry of batch) {
    await awaitBgTurn()
    const key = pendingLargeKey(entry.site, entry.rel)
    try {
      if (entry.kind === 'commons' || !isHere(entry.site)) {
        await cacheSiteRoute(cache, entry.site, `assets/${entry.rel}`, { allowWikiAssets: true })
      } else {
        await cacheUrl(cache, `${location.origin}/assets/${entry.rel}`, [], { allowWikiAssets: true })
      }
    } catch (err) {
      console.warn('[PWA] large asset pack failed', entry.rel, err)
    }
    pendingLargeAssets.delete(key)
  }
  hideLargeConsentBanner()
  syncLocalChangesPanel()
}

async function packSitePages(cache, site) {
  // Sitemap + MiniSearch index for offline footer search (index is optional on some farms).
  const sitemapRes = await cacheSiteRoute(cache, site, 'system/sitemap.json')
  await cacheSiteRoute(cache, site, 'system/site-index.json')

  let slugs = []
  try {
    const info = wiki.neighborhood?.[site]
    if (Array.isArray(info?.sitemap)) {
      slugs = info.sitemap.map(e => e?.slug).filter(Boolean)
    }
  } catch {
    /* ignore */
  }
  if (!slugs.length && sitemapRes) {
    try {
      const data = await sitemapRes.clone().json()
      if (Array.isArray(data)) slugs = data.map(e => e?.slug).filter(Boolean)
    } catch {
      /* ignore */
    }
  }

  const status = bgPackStatus.get(site) || {}
  status.phase = 'pages'
  status.pageTotal = slugs.length
  status.pageDone = 0
  bgPackStatus.set(site, status)

  await mapPool(
    slugs,
    BG_PAGE_CONCURRENCY,
    async slug => {
      const route = `${slug}.json`
      const url = isHere(site) ? `${location.origin}/${route}` : proxyRouteUrl(site, route)
      if (!(await cacheHas(cache, url))) await cacheSiteRoute(cache, site, route)
      await bumpPackDone(site, status, 'pageDone')
    },
    { background: true },
  )
}

function scheduleSiteBackgroundPack(site) {
  if (!isStandalone() || !navigator.onLine || !('caches' in window)) return
  const key = isHere(site) ? (location.host || 'origin').toLowerCase() : normalizeRemoteHost(site)
  if (!key || bgPackInflight.has(key)) return

  const prev = bgPackStatus.get(key)
  let sitemapLen = 0
  try {
    sitemapLen = wiki.neighborhood?.[key]?.sitemap?.length || 0
  } catch {
    sitemapLen = 0
  }
  if (prev?.phase === 'done' && !isHere(key) && sitemapLen > 0 && sitemapLen <= (prev.pageTotal || 0)) {
    return
  }

  bgPackInflight.add(key)
  bgPackStatus.set(key, {
    phase: 'start',
    pageDone: 0,
    pageTotal: 0,
    assetDone: 0,
    assetTotal: 0,
    imageDone: 0,
    imageTotal: 0,
  })
  ;(async () => {
    try {
      if (
        prev?.phase === 'done' &&
        isHere(key) &&
        sitemapLen > 0 &&
        sitemapLen <= (prev.pageTotal || 0) &&
        (prev.assetTotal || 0) > 0
      ) {
        await awaitBgTurn()
        const entries = await fetchAssetIndex(key)
        if (entries.length <= (prev.assetTotal || 0)) {
          bgPackStatus.set(key, prev)
          return
        }
      }
      const cache = await caches.open(CACHE)
      await packSitePages(cache, key)
      if (isHere(key)) await packOriginAssets(cache, key)
      else {
        await packCommonsImages(cache, key)
        await offerLargeNeighborAssets(key)
      }
      const cur = bgPackStatus.get(key) || {}
      bgPackStatus.set(key, { ...cur, phase: 'done' })
      console.info('[PWA] background pack done', key, bgPackStatus.get(key))
    } catch (err) {
      const cur = bgPackStatus.get(key) || {}
      bgPackStatus.set(key, { ...cur, phase: 'error', error: String(err?.message || err) })
      console.warn('[PWA] background pack failed', key, err)
    } finally {
      bgPackInflight.delete(key)
    }
  })()
}
function scheduleNeighborhoodBackgroundPacks(onlyMissing = false) {
  if (!isStandalone()) return
  const localSite = (location.host || 'origin').toLowerCase()
  if (!onlyMissing || bgPackStatus.get(localSite)?.phase !== 'done') {
    scheduleSiteBackgroundPack(localSite)
  }
  for (const site of Object.keys(wiki.neighborhood || {})) {
    const remote = normalizeRemoteHost(site)
    if (!remote) continue
    if (onlyMissing && bgPackStatus.get(remote)?.phase === 'done') continue
    scheduleSiteBackgroundPack(remote)
  }
}

function formatBgPackProgressLine() {
  if (!bgPackStatus.size && !pendingLargeAssets.size) return ''
  const parts = []
  for (const [site, st] of bgPackStatus) {
    if (!st || st.phase === 'done') continue
    if (st.phase === 'error') {
      parts.push(`${site}: error`)
      continue
    }
    if (st.phase === 'pages' || (st.pageTotal && st.pageDone < st.pageTotal)) {
      parts.push(`${site} pages ${st.pageDone || 0}/${st.pageTotal || '?'}`)
    } else if (st.phase === 'assets') {
      parts.push(`${site} assets ${st.assetDone || 0}/${st.assetTotal || '?'}`)
    } else if (st.phase === 'images') {
      parts.push(`${site} images ${st.imageDone || 0}/${st.imageTotal || '?'}`)
    } else {
      parts.push(`${site}: ${st.phase || '…'}`)
    }
  }
  const pending = summarizePendingLargeAssets()
  if (pending.count && readLargeAssetConsent() === 'ask') {
    parts.push(`${pending.count} large awaiting consent`)
  }
  if (!parts.length && bgPackInflight.size) return 'Background pack finishing…'
  return parts.length ? `Background: ${parts.join(' · ')}` : ''
}

function isPlausiblePluginAssetPath(path, pluginName) {
  if (!path || path.includes('..')) return false
  if (/[`${}(),\s]|^\.\.\./.test(path)) return false
  if (path.includes('%7B') || path.includes('%7D') || path.includes('%60')) return false
  const prefix = `/plugins/${pluginName}/`
  const flat = `/plugins/${pluginName}.js`
  if (path !== flat && !path.startsWith(prefix)) return false
  if (/\.(map)$/i.test(path)) return false
  return /\.(js|css|wasm|svg|png|jpg|jpeg|gif|webp|woff2?|ttf|eot|bin|json|html)$/i.test(path) || path.endsWith('/')
}

function extractPluginRefs(text, baseHref, pluginName, { loose = false } = {}) {
  const found = new Set()
  const base = baseHref || `${location.origin}/plugins/${pluginName}/`
  const consider = raw => {
    if (!raw || raw.startsWith('data:') || raw.startsWith('blob:') || raw.startsWith('mailto:')) return
    // Template literals / expressions — never treat as URLs.
    if (/[`${}]/.test(raw) || raw.includes('${')) return
    let href
    try {
      href = new URL(raw, base).href
    } catch {
      return
    }
    let path
    try {
      const u = new URL(href)
      if (u.origin !== location.origin) return
      path = u.pathname
    } catch {
      return
    }
    if (!isPlausiblePluginAssetPath(path, pluginName)) return
    found.add(href.split('#')[0])
  }

  const patterns = [
    /(?:src|href|data-main|data-url)\s*=\s*["']([^"']+)["']/gi,
    /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi,
    /(?:import|from)\s*\(\s*['"]([^'"]+)['"]\s*\)/gi,
    /(?:import|from)\s+['"]([^'"]+)['"]/gi,
    /["'](\/?plugins\/[a-z0-9_-]+\/[a-z0-9_./@+-]+\.[a-z0-9]+)["']/gi,
  ]
  if (loose) {
    patterns.push(
      /["'](\.?\.?\/(?:assets|client)\/[a-z0-9_./+-]+\.[a-z0-9]+)["']/gi,
      /["']((?:assets|client)\/[a-z0-9_./+-]+\.[a-z0-9]+)["']/gi,
    )
  }
  for (const re of patterns) {
    let m
    while ((m = re.exec(text))) consider(m[1])
  }
  return found
}

function extractCdnUrls(text, baseHref) {
  const found = new Set()
  let expanded = String(text || '')
  const ver = expanded.match(/katexVersion\s*=\s*['"]([^'"]+)['"]/)
  if (ver) expanded = expanded.replace(/\$\{katexVersion\}/g, ver[1])
  const absRe = /https:\/\/cdn\.jsdelivr\.net\/npm\/[A-Za-z0-9@._\-/]+/g
  let m
  while ((m = absRe.exec(expanded))) {
    found.add(m[0].replace(/[`'";)\]]+$/, ''))
  }
  if (baseHref && /\.css(\?|$)/i.test(baseHref)) {
    const urlRe = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi
    while ((m = urlRe.exec(expanded))) {
      const raw = m[1]
      if (!raw || raw.startsWith('data:')) continue
      try {
        found.add(new URL(raw, baseHref).href.split('#')[0])
      } catch {
        /* keep */
      }
    }
  }
  return found
}

function parsePluginServiceWorker(text, pluginName) {
  const cacheMatch = text.match(/CACHE_NAME\s*=\s*['"]([^'"]+)['"]/)
  const rawName = cacheMatch ? cacheMatch[1] : null
  const prefix = `wiki-${String(pluginName || '').toLowerCase()}-pwa-cache-`
  const cacheName = rawName && rawName.startsWith(prefix) ? rawName : null
  const assets = new Set()
  const listMatch = text.match(/assetsToCache\s*=\s*\[([\s\S]*?)\]/)
  if (listMatch) {
    const re = /['"]([^'"]+)['"]/g
    let m
    while ((m = re.exec(listMatch[1]))) {
      const rel = m[1]
      try {
        assets.add(new URL(rel, `${location.origin}/plugins/${pluginName}/`).href.split('#')[0])
      } catch {
        /* keep */
      }
    }
  }
  return { cacheName, assets }
}

async function cachePluginClientTree(cache, pluginName) {
  if (BUILTIN_TYPES.has(pluginName)) return { name: pluginName, ok: true, stored: 0 }
  const pluginCaches = []
  const pending = []
  const seen = new Set()
  const failedSeeds = []

  const swUrl = `${location.origin}/plugins/${pluginName}/service-worker.js`
  const swRes = await cacheUrl(cache, swUrl, [], { tries: 1 })
  seen.add(swUrl)
  if (swRes) {
    try {
      const text = await swRes.clone().text()
      const { cacheName, assets } = parsePluginServiceWorker(text, pluginName)
      if (cacheName && 'caches' in window) {
        try {
          const pc = await caches.open(cacheName)
          pluginCaches.push(pc)
          await pc.put(swUrl, swRes.clone())
        } catch {
          /* keep */
        }
      }
      for (const asset of assets) pending.push(asset)
    } catch {
      /* keep */
    }
  }

  const entryJs = `${location.origin}/plugins/${pluginName}/${pluginName}.js`
  const indexHtml = `${location.origin}/plugins/${pluginName}/index.html`
  pending.push(entryJs, indexHtml, `${location.origin}/plugins/${pluginName}/${pluginName}.css`)

  // Pull index.html early so stamped ?v= modulepreload URLs enter the queue first.
  if (!seen.has(indexHtml)) {
    seen.add(indexHtml)
    const indexRes = await cacheUrl(cache, indexHtml, pluginCaches, { tries: 1 })
    if (indexRes) {
      try {
        for (const ref of extractPluginRefs(await indexRes.clone().text(), indexHtml, pluginName, { loose: true })) {
          pending.unshift(ref)
        }
      } catch {
        /* keep */
      }
    }
  }

  let stored = swRes ? 1 : 0

  while (pending.length && stored < MAX_PLUGIN_ASSETS) {
    const batch = []
    while (pending.length && batch.length < FETCH_CONCURRENCY && stored + batch.length < MAX_PLUGIN_ASSETS) {
      const url = pending.shift()
      if (!url || seen.has(url)) continue
      seen.add(url)
      batch.push(url)
    }
    if (!batch.length) break

    await Promise.all(
      batch.map(async url => {
        const res = await cacheUrl(cache, url, pluginCaches, { tries: 2 })
        if (!res) {
          // Track missing entry/index paths (not every optional discovery miss).
          const path = new URL(url, location.origin).pathname
          if (
            path === `/plugins/${pluginName}/${pluginName}.js` ||
            path === `/plugins/${pluginName}/index.html` ||
            path === `/plugins/${pluginName}/${pluginName}.css`
          ) {
            failedSeeds.push(path)
          }
          return
        }
        stored += 1
        const ctype = (res.headers.get('content-type') || '').toLowerCase()
        const path = new URL(url).pathname
        const isHtml = ctype.includes('html') || /\.html$/i.test(path)
        const isCss = ctype.includes('css') || /\.css$/i.test(path)
        const isJs = ctype.includes('javascript') || ctype.includes('ecmascript') || /\.js$/i.test(path)
        // HTML/CSS: allow relative asset discovery. Minified JS: imports only (no loose scrape).
        if (!isHtml && !isCss && !isJs) return
        let text
        try {
          text = await res.clone().text()
        } catch {
          return
        }

        for (const ref of extractPluginRefs(text, url, pluginName, { loose: isHtml || isCss })) {
          if (!seen.has(ref)) pending.push(ref)
        }
        for (const cdn of extractCdnUrls(text, url)) {
          if (!seen.has(cdn)) pending.push(cdn)
        }
      }),
    )
  }

  const entryOk =
    (await caches.match(entryJs, { ignoreSearch: true })) ||
    (await cacheUrl(cache, entryJs, pluginCaches, { tries: 2 }))
  if (!entryOk) {
    console.warn('[PWA] plugin entry missing after warm', pluginName)
    return { name: pluginName, ok: false, stored, failedSeeds }
  }
  if (failedSeeds.length) {
    console.warn('[PWA] plugin seed gaps', pluginName, failedSeeds.slice(0, 12))
  }
  return { name: pluginName, ok: failedSeeds.length === 0, stored, failedSeeds }
}

function scheduleOfflinePack(force = false, { urgent = false } = {}) {
  const run = () => {
    startOfflineCache(force).catch(() => {})
  }
  // Install / first online standalone: start now. Idle deferral is only for soft retries.
  if (urgent || typeof requestIdleCallback !== 'function') {
    if (urgent) run()
    else setTimeout(run, 1500)
    return
  }
  requestIdleCallback(() => run(), { timeout: 8000 })
}

function maybeStartStandalonePack() {
  if (!isSecureInstallContext() || !navigator.onLine) return
  if (!isStandalone()) return
  ensurePersistentStorage().catch(() => {})
  if (!needsOfflinePack()) return
  scheduleOfflinePack(true, { urgent: true })
}

async function ensurePersistentStorage() {
  if (!navigator.storage?.persist) return { persisted: false, supported: false }
  try {
    if (await navigator.storage.persisted()) return { persisted: true, supported: true }
    const ok = await navigator.storage.persist()
    console.info('[PWA] persistent storage', ok ? 'granted' : 'denied')
    return { persisted: !!ok, supported: true }
  } catch (err) {
    console.warn('[PWA] persistent storage request failed', err)
    return { persisted: false, supported: true }
  }
}

async function storagePersistStatus() {
  if (!navigator.storage?.persisted) return { persisted: false, supported: false }
  try {
    return { persisted: !!(await navigator.storage.persisted()), supported: true }
  } catch {
    return { persisted: false, supported: true }
  }
}

function signalPackPendingToOtherWindows() {
  try {
    if (!packChannel) packChannel = new BroadcastChannel('fedwiki-pwa')
    packChannel.postMessage({ type: 'pack-pending' })
  } catch (_) {
    /* BroadcastChannel unsupported */
  }
}

function watchDisplayModeForPackUi() {
  if (!window.matchMedia) return
  const modes = ['standalone', 'minimal-ui', 'window-controls-overlay']
  for (const mode of modes) {
    try {
      const mq = window.matchMedia(`(display-mode: ${mode})`)
      const onChange = () => {
        tellServiceWorkerStandalone(isStandalone())
        syncLocalChangesPanel()
        if (mq.matches && needsOfflinePack()) maybeStartStandalonePack()
        else if (!isStandalone()) {
          hideUpgradeBanner()
        }
        if (mq.matches) {
          ensurePluginsFromOpenPages().catch(() => {})
          syncFaviconIntoManifest().catch(() => {})
        }
      }
      if (mq.addEventListener) mq.addEventListener('change', onChange)
      else if (mq.addListener) mq.addListener(onChange)
    } catch (_) {
      /* ignore */
    }
  }
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function crc32(buf) {
  let c = ~0
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  for (let i = 0; i < u8.length; i++) {
    c ^= u8[i]
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return ~c >>> 0
}

function u16(n) {
  const b = new Uint8Array(2)
  new DataView(b.buffer).setUint16(0, n, true)
  return b
}

function u32(n) {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, true)
  return b
}

function concatBytes(parts) {
  let len = 0
  for (const p of parts) len += p.length
  const out = new Uint8Array(len)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

async function deflateRaw(u8) {
  if (typeof CompressionStream === 'undefined') return null
  try {
    const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate-raw'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    return null
  }
}

async function zipPayload(body) {
  const compressed = await deflateRaw(body)
  if (compressed && compressed.length < body.length) return { method: 8, payload: compressed }
  return { method: 0, payload: body }
}

function zipHeaders(method, crc, payloadLen, bodyLen, nameLen, offset) {
  const sizes = [u32(crc), u32(payloadLen), u32(bodyLen), u16(nameLen), u16(0)]
  return {
    local: concatBytes([u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0), ...sizes]),
    central: concatBytes([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(method), u16(0), u16(0),
      ...sizes, u16(0), u16(0), u16(0), u32(0), u32(offset),
    ]),
  }
}


async function buildZip(entries) {
  const encoder = new TextEncoder()
  const localParts = []
  const centralParts = []
  let offset = 0
  let count = 0

  for (const { path, data } of entries) {
    if (!path || !data) continue
    const name = encoder.encode(String(path).replace(/^\/+/, ''))
    const body = data instanceof Uint8Array ? data : new Uint8Array(data)
    const crc = crc32(body)
    const { method, payload } = await zipPayload(body)
    const hdr = zipHeaders(method, crc, payload.length, body.length, name.length, offset)
    const local = concatBytes([hdr.local, name, payload])
    localParts.push(local)
    centralParts.push(concatBytes([hdr.central, name]))
    offset += local.length
    count += 1
  }

  const centralBlob = concatBytes(centralParts)
  return concatBytes([
    ...localParts,
    centralBlob,
    concatBytes([
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(count),
      u16(count),
      u32(centralBlob.length),
      u32(offset),
      u16(0),
    ]),
  ])
}

function imagePluginAssetFileName(routeOrPath) {
  const r = String(routeOrPath || '')
    .replace(/\\/g, '/')
    .replace(/^\//, '')
  const m = r.match(/^(?:assets\/)?plugins\/image\/([^/]+)$/i)
  if (!m) return null
  const name = m[1]
  if (!name || name === '.' || name === '..' || name.includes('\\')) return null
  return /^[A-Za-z0-9._-]+$/.test(name) ? name : null
}

function isSkippedExportPath(path) {
  return (
    path === '/manifest.webmanifest' ||
    path === '/manifest.overlay.json' ||
    path === '/pwa-icon.rev' ||
    path === '/__wiki_shell__' ||
    path === '/client.js' ||
    path === '/service-worker.js' ||
    path.startsWith('/pwa-icon-') ||
    path.startsWith('/plugins/') ||
    path.startsWith('/plugin/') ||
    path.startsWith('/js/') ||
    path.startsWith('/style/') ||
    path.startsWith('/theme/') ||
    path.startsWith('/images/') ||
    path.startsWith('/security/') ||
    path.startsWith('/view/')
  )
}

function wikiExportPathsFromCacheUrl(urlString) {
  let u
  try {
    u = new URL(urlString, location.origin)
  } catch {
    return []
  }
  if (u.origin !== location.origin) return []

  const path = u.pathname || ''
  if (isSkippedExportPath(path)) return []

  const originHost = (location.host || location.hostname || 'origin').toLowerCase()
  const out = []

  if (path.startsWith('/proxy/')) {
    const rest = path.slice('/proxy/'.length)
    const slash = rest.indexOf('/')
    if (slash < 1) return []
    const site = rest.slice(0, slash).toLowerCase()
    const route = rest.slice(slash + 1)
    if (route === 'assets' || route.startsWith('assets/')) {
      // Image-plugin commons: dual farm paths. Ordinary assets (e.g. assets/pwa-demo/*.png
      // fetched via /proxy during a visit): keep the neighbor site path as stored on disk.
      const fileName = imagePluginAssetFileName(route)
      if (fileName) {
        out.push(`commons/${fileName}`)
        out.push(`${site}/assets/plugins/image/${fileName}`)
        return out
      }
    }
    const one = mapSiteDiskPath(site, route)
    if (one) out.push(one)
    return out
  }

  const route = path.replace(/^\//, '')
  const fileName = imagePluginAssetFileName(route)
  const sitePath = mapSiteDiskPath(originHost, route)
  if (sitePath) out.push(sitePath)
  if (fileName) out.push(`commons/${fileName}`)
  return out
}

function mapSiteDiskPath(site, route) {
  const s = String(site || '')
    .toLowerCase()
    .trim()
  let r = String(route || '').replace(/^\//, '')
  if (!s || !r) return null
  if (r === 'favicon.png' || r === 'favicon.ico') return `${s}/status/favicon.png`
  if (r.startsWith('system/')) return `${s}/status/${r.slice('system/'.length)}`
  if (r.startsWith('status/')) return `${s}/${r}`
  if (r.startsWith('assets/')) return `${s}/${r}`
  if (r.startsWith('pages/')) return `${s}/${r}`
  if (r.endsWith('.json') && !r.includes('/')) return `${s}/pages/${r.slice(0, -'.json'.length)}`
  return null
}

async function collectWikiBackupEntries() {
  const byPath = new Map()
  if (!('caches' in window)) return []
  const keys = await caches.keys()
  const names = keys.filter(k => k.startsWith('fedwiki-pwa'))
  for (const name of names) {
    let cache
    try {
      cache = await caches.open(name)
    } catch {
      continue
    }
    let reqs
    try {
      reqs = await cache.keys()
    } catch {
      continue
    }
    for (const req of reqs) {
      const rels = wikiExportPathsFromCacheUrl(req.url)
      if (!rels.length) continue
      try {
        const res = await cache.match(req)
        if (!res || !res.ok) continue
        const buf = new Uint8Array(await res.clone().arrayBuffer())
        for (const rel of rels) {
          if (byPath.has(rel) && rel.startsWith('commons/')) continue
          byPath.set(rel, buf)
        }
      } catch {
        /* skip */
      }
    }
  }
  return [...byPath.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([path, data]) => ({ path, data }))
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

async function exportOfflineBackupZip() {
  const entries = await collectWikiBackupEntries()
  if (!entries.length) throw new Error('No site pages/assets in the offline backup yet')
  const zipBytes = await buildZip(entries)
  const host = (location.hostname || 'fedwiki').replace(/[^\w.-]+/g, '_')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const sites = new Set(entries.map(e => e.path.split('/')[0]).filter(Boolean))
  downloadBlob(new Blob([zipBytes], { type: 'application/zip' }), `fedwiki-backup-${host}-${stamp}.zip`)
  return { files: entries.length, sites: sites.size }
}

async function estimateOfflineBackupBytes() {
  let total = 0
  let cachesFound = 0
  if (!('caches' in window)) return { total, cachesFound, names: [] }
  const keys = await caches.keys()
  const names = keys.filter(k => k.startsWith('fedwiki-pwa'))
  for (const name of names) {
    cachesFound += 1
    try {
      const cache = await caches.open(name)
      const reqs = await cache.keys()
      for (const req of reqs) {
        try {
          const res = await cache.match(req)
          if (!res) continue
          const cl = res.headers.get('content-length')
          if (cl && Number(cl) > 0) {
            total += Number(cl)
            continue
          }
          const buf = await res.clone().arrayBuffer()
          total += buf.byteLength
        } catch {
          /* skip entry */
        }
      }
    } catch {
      /* skip cache */
    }
  }
  return { total, cachesFound, names }
}

async function estimateSitePackStats() {
  const entries = await collectWikiBackupEntries()
  let bytes = 0
  const sites = new Set()
  let assetFiles = 0
  let commonsFiles = 0
  for (const e of entries) {
    bytes += e.data?.byteLength || 0
    const top = e.path.split('/')[0]
    if (top === 'commons') {
      commonsFiles += 1
    } else if (top) {
      sites.add(top)
      if (e.path.includes('/assets/')) assetFiles += 1
    }
  }
  return {
    bytes,
    files: entries.length,
    sites: sites.size,
    assetFiles,
    commonsFiles,
    siteNames: [...sites].sort(),
  }
}

async function flushOfflineBackup() {
  if (!('caches' in window)) return
  const keys = await caches.keys()
  await Promise.all(keys.filter(k => k.startsWith('fedwiki-pwa')).map(k => caches.delete(k)))
  writeOfflinePackFlag(false)
  writePackPending(false)
  warmedPlugins = new Set()
  pendingLargeAssets.clear()
  hideLargeConsentBanner()
  }

function h(tag, css, text) {
  const el = document.createElement(tag)
  if (css) el.style.cssText = css
  if (text != null) el.textContent = text
  return el
}

function removeAllLocalChangesPanels() {
  document.querySelectorAll('.' + LOCAL_CHANGES_PANEL_CLASS).forEach(el => el.remove())
}

async function renderLocalChangesPanel($page) {
  if (!isStandalone() || !$page?.length) return
  $page.find('.' + LOCAL_CHANGES_PANEL_CLASS).remove()

  const panel = h('div', 'margin:1em 0.8em;padding:0.75em 1em;border-top:1px solid #ccc;font:13px/1.4 system-ui,sans-serif;color:#333')
  panel.className = LOCAL_CHANGES_PANEL_CLASS
  panel.setAttribute('data-wiki-pwa', '1')
  const title = h('div', 'font-weight:600', 'Offline backup (this installed app)')
  const status = h('p', 'margin:0.5em 0', 'Measuring storage…')
  const btnRow = h('div', 'display:flex;flex-wrap:wrap;gap:0.5em;margin-top:0.25em')
  const note = h(
    'p',
    'margin:0.5em 0 0;color:#666;font-size:12px',
    'Offline pack for this app. Under 8\u202fMiB packs automatically; larger files ask first (no size cap after you allow). Export = farm-shaped zip.',
  )
  const largeRow = h('div', 'margin-top:0.6em;padding-top:0.5em;border-top:1px dashed #ddd')
  panel.append(title, status, btnRow, note, largeRow)
  const $footer = $page.find('.footer').first()
  if ($footer.length) $footer.before(panel)
  else $page.find('.paper').append(panel)

  const softRefresh = () => refresh().catch(() => {})
  const refresh = async () => {
    if (!panel.isConnected) return
    try {
      const [{ total, cachesFound }, pack, persist] = await Promise.all([
        estimateOfflineBackupBytes(),
        estimateSitePackStats(),
        storagePersistStatus(),
      ])
      const persistNote = !persist.supported
        ? ''
        : persist.persisted
          ? ' Persistent storage on.'
          : ' Persistent storage off (may evict under pressure).'
      const siteList = pack.siteNames?.length ? ` [${pack.siteNames.join(', ')}]` : ''
      const assetNote = pack.assetFiles ? ` · ${plural(pack.assetFiles, 'origin asset')}` : ''
      const commonsNote = pack.commonsFiles ? ` · ${plural(pack.commonsFiles, 'commons image')}` : ''
      const bgLine = formatBgPackProgressLine()
      status.textContent = `Site pack ${formatBytes(pack.bytes)} · ${plural(pack.files, 'file')} · ${plural(
        pack.sites,
        'site',
      )}${assetNote}${commonsNote}${siteList}. Total cache ${formatBytes(total)} in ${plural(
        cachesFound,
        'cache',
      )}.${persistNote}${bgLine ? ` ${bgLine}` : ''}`
      renderLargeConsent()
      if (readLargeAssetConsent() === 'ask' && pendingLargeAssets.size) showLargeConsentBanner()
    } catch {
      status.textContent = 'Could not measure offline storage.'
    }
  }

  const renderLargeConsent = () => {
    largeRow.replaceChildren()
    const consent = readLargeAssetConsent()
    const pending = summarizePendingLargeAssets()
    const line = h('p', 'margin:0 0 0.4em;font-size:12px;color:#444')
    if (consent === 'allow') {
      line.textContent = 'Large assets: allowed (no per-file size cap).'
    } else if (consent === 'deny') {
      line.textContent = 'Large assets: skipped (you chose Never).'
    } else if (pending.count) {
      line.textContent = `Large assets waiting: ${plural(pending.count, 'file')} · ${formatBytes(pending.bytes)}${
        pending.sites.length ? ` · ${pending.sites.join(', ')}` : ''
      }. Not packed until you approve.`
    } else {
      line.textContent = `Large assets: none waiting (auto-pack under ${formatBytes(MAX_PACK_ASSET_BYTES)}).`
    }
    largeRow.appendChild(line)
    if (consent === 'ask' && pending.count) {
      const row = h('div', 'display:flex;flex-wrap:wrap;gap:0.5em')
      row.append(
        panelBtn('Pack large files', () => setLargeAssetConsent('allow', { refresh: softRefresh })),
        panelBtn('Not now', () => hideLargeConsentBanner()),
        panelBtn('Never', () => setLargeAssetConsent('deny', { refresh: softRefresh })),
      )
      largeRow.appendChild(row)
    } else if (consent !== 'ask') {
      largeRow.appendChild(
        panelBtn('Ask again about large assets', () => setLargeAssetConsent('ask', { refresh: softRefresh })),
      )
    }
  }

  const exportBtn = panelBtn('Export offline backup (.zip)', async () => {
    exportBtn.disabled = true
    flushBtn.disabled = true
    const prev = status.textContent
    status.textContent = 'Building .wiki-shaped zip…'
    try {
      const { files, sites } = await exportOfflineBackupZip()
      status.textContent = `Exported ${plural(files, 'file')} from ${plural(sites, 'site')}. ${prev || ''}`
    } catch (err) {
      status.textContent = `Export failed: ${err?.message || err}`
    } finally {
      exportBtn.disabled = false
      flushBtn.disabled = false
    }
  })
  const flushBtn = panelBtn('Flush offline backup', async () => {
    if (!window.confirm('Flush the offline backup cache for this app?')) return
    flushBtn.disabled = true
    exportBtn.disabled = true
    status.textContent = 'Flushing…'
    try {
      await flushOfflineBackup()
      await injectManifest({ force: true }).catch(() => {})
      await refresh()
      writePackPending(true)
      maybeStartStandalonePack()
    } catch (err) {
      status.textContent = `Flush failed: ${err?.message || err}`
    } finally {
      flushBtn.disabled = false
      exportBtn.disabled = false
    }
  })
  btnRow.append(exportBtn, flushBtn)

  const poll = window.setInterval(() => {
    if (!panel.isConnected) {
      clearInterval(poll)
      return
    }
    refresh().catch(() => {})
  }, 4000)

  await refresh()
}

function syncLocalChangesPanel() {
  if (typeof $ === 'undefined') return
  const $pages = $('.page').filter(function () {
    return pageSlugFromEl($(this)) === 'local-changes'
  })
  if (!isStandalone() || !$pages.length) {
    removeAllLocalChangesPanels()
    return
  }
  document.querySelectorAll('.' + LOCAL_CHANGES_PANEL_CLASS).forEach(el => {
    if (!$pages.toArray().some(p => p.contains(el))) el.remove()
  })
  $pages.each(function () {
    if (this.querySelector('.' + LOCAL_CHANGES_PANEL_CLASS)) return
    renderLocalChangesPanel($(this)).catch(err => console.warn('[PWA] local-changes panel', err))
  })
}

function watchLocalChangesPage() {
  if (localChangesObserver || typeof MutationObserver === 'undefined') {
    syncLocalChangesPanel()
    return
  }
  const root = document.querySelector('.main') || document.body
  if (!root) return
  let scheduled = false
  localChangesObserver = new MutationObserver(() => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      syncLocalChangesPanel()
      if (isStandalone()) ensurePluginsFromOpenPages().catch(() => {})
    })
  })
  localChangesObserver.observe(root, { childList: true, subtree: true })
  syncLocalChangesPanel()
}

window.addEventListener('appinstalled', () => {
  writePackPending(true)
  writeOfflinePackFlag(false)
  signalPackPendingToOtherWindows()
  ensurePersistentStorage().catch(() => {})
  maybeStartStandalonePack()
})

window.addEventListener('storage', event => {
  if (!event) return
  if (event.key === PACK_PENDING_FLAG && event.newValue === '1') maybeStartStandalonePack()
  if (event.key === OFFLINE_PACK_FLAG && event.newValue === null && readPackPending()) {
    maybeStartStandalonePack()
  }
})

try {
  packChannel = new BroadcastChannel('fedwiki-pwa')
  packChannel.addEventListener('message', event => {
    if (event?.data?.type === 'pack-pending') maybeStartStandalonePack()
  })
} catch (_) {
  packChannel = null
}

tellServiceWorkerStandalone(isStandalone())
tellServiceWorkerLargeConsent(readLargeAssetConsent() === 'allow')
watchDisplayModeForPackUi()
maybeStartStandalonePack()

$(() => {
  tellServiceWorkerStandalone(isStandalone())
  tellServiceWorkerLargeConsent(readLargeAssetConsent() === 'allow')
  if (isStandalone()) ensurePersistentStorage().catch(() => {})
  maybeStartStandalonePack()
  prepareInstallSurface()
  watchLocalChangesPage()
  if (isStandalone() && readLargeAssetConsent() === 'ask' && pendingLargeAssets.size) {
    showLargeConsentBanner()
  }
  const onNeighbor = (_e, site) => {
    if (!isStandalone()) return
    ensurePluginsFromOpenPages().catch(() => {})
    if (site) scheduleSiteBackgroundPack(site)
  }
  $('body').on('new-neighbor', onNeighbor)
  $('body').on('new-neighbor-done', onNeighbor)

  window.addEventListener('online', () => {
    if (!isSecureInstallContext()) return
    maybeStartStandalonePack()
    if (isStandalone()) {
      ensurePluginsFromOpenPages().catch(() => {})
      scheduleNeighborhoodBackgroundPacks(true)
    }
    syncFaviconIntoManifest().catch(() => {})
  })

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (!isSecureInstallContext() || !navigator.onLine) return
    syncFaviconIntoManifest().catch(() => {})
  })
})
