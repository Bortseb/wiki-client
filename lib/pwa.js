// Opt-in PWA: non-PWA wiki in the browser stays native (no online SW intercept, idle lite install prep).
// App icons are SW-generated (/pwa-icon-*); standalone adds apple-touch 180 + offline pack.

const { newPage } = require('./page')
const { itemId } = require('./random')

const CACHE = 'fedwiki-pwa-4'
/**
 * Web Share Target (GET). Appears in the OS share sheet only where the installer
 * registers it: Edge on Windows, Chrome/Edge/Samsung on Android, Chrome OS.
 * Chrome/Chromium on Windows desktop does not register share targets (no AppX
 * identity) — install from Edge for Windows Share. Safari never receives.
 */
const SHARE_TARGET_PATH = '/view/welcome-visitors'
function shareTarget(origin) {
  return {
    // Absolute action: more reliable on Android Chrome than a relative path.
    action: `${origin}${SHARE_TARGET_PATH}`,
    method: 'GET',
    enctype: 'application/x-www-form-urlencoded',
    params: { title: 'title', text: 'text', url: 'url' },
  }
}
const OFFLINE_PACK_FLAG = `fedwiki-pwa-offline-ready:${CACHE}`
const PACK_PENDING_FLAG = `fedwiki-pwa-pack-pending:${CACHE}`
const FAVICON_REV_FLAG = `fedwiki-pwa-favicon-rev:${CACHE}`
const FAVICON_DISMISSED_REV_FLAG = `fedwiki-pwa-favicon-dismissed:${CACHE}`
/** Bump when SW favicon→icon draw changes so cached /pwa-icon-* rebuild without a favicon rev change. */
const ICON_LAYOUT = '3'
const ICON_LAYOUT_FLAG = `fedwiki-pwa-icon-layout:${CACHE}`
const UPGRADE_BANNER_ID = 'wiki-pwa-upgrade-banner'
const SW_UPDATE_BANNER_ID = 'wiki-pwa-sw-update-banner'

const LARGE_ASSET_CONSENT_FLAG = `fedwiki-pwa-large-consent:${CACHE}`
const PWA_CACHE_LINK_CLASS = 'wiki-pwa-cache-link'
const PWA_CACHE_PANEL_CLASS = 'wiki-pwa-cache-panel'
const PWA_CACHE_TITLE = 'PWA Cache'
const PWA_CACHE_SLUG = 'pwa-cache'
/** @deprecated old local-changes panel class; still stripped on sync */
const LOCAL_CHANGES_PANEL_CLASS = 'wiki-pwa-offline-backup'

let prepared = false
/** True after standalone polish (apple-touch 180 + applied favicon rev) — lite prep alone is not enough. */
let preparedFull = false
/** True after this page load has pointed <link rel=manifest> at a working overlay (omnibox re-check). */
let manifestDomAnnounced = false
let prepareGeneration = 0
let idleInstallScheduled = false
let faviconCheckPromise = null
let faviconUpgradePendingRev = null
let touchIconObjectUrl = null
let offlineCachePromise = null
let pluginWarmPromise = null
let warmedPlugins = new Set()
let localChangesObserver = null
let lastPostedLargeConsent = null

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
    packPendingLargeAssets().catch(err => console.warn('[PWA] large pack', err))
    scheduleNeighborhoodBackgroundPacks(true)
  } else if (mode === 'deny') {
    pendingLargeAssets.clear()
  } else {
    scheduleNeighborhoodBackgroundPacks()
  }
  if (refresh) refresh()
  else if (mode !== 'ask') syncPwaCacheUi()
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

function showChoiceBanner({ id, message, actions }) {
  if (typeof document === 'undefined') return null
  const el = ensureBanner(id, node => {
    const msg = document.createElement('span')
    msg.dataset.role = 'msg'
    node.append(msg)
    for (const action of actions || []) {
      node.append(bannerBtn(action.label, action.primary ? BTN_PRIMARY : BTN_GHOST, action.onClick))
    }
  })
  const msg = el.querySelector('[data-role="msg"]')
  if (msg) msg.textContent = message
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
  showChoiceBanner({
    id: UPGRADE_BANNER_ID,
    message: 'Site icon changed. Update this app\u2019s saved icon?',
    actions: [
      {
        label: 'Update icon',
        primary: true,
        onClick: () => applyManualAppUpgrade().catch(err => console.warn('[PWA] icon upgrade failed', err)),
      },
      { label: 'Not now', onClick: () => dismissManualAppUpgrade() },
    ],
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

function postToSw(type, payload = {}) {
  try {
    const msg = { type, ...payload }
    const sw = navigator.serviceWorker?.controller
    if (sw) {
      sw.postMessage(msg)
      return
    }
    navigator.serviceWorker?.ready?.then(reg => {
      if (reg.active) reg.active.postMessage(msg)
    })
  } catch {
    /* ignore */
  }
}

/** After SKIP_WAITING, reload once so the new worker controls this client. */
let reloadOnControllerChange = false
let swUpdateWatchWired = false

function requestSkipWaiting(worker) {
  try {
    if (worker) worker.postMessage({ type: 'SKIP_WAITING' })
    else postToSw('SKIP_WAITING')
  } catch {
    /* ignore */
  }
}

function hideSwUpdateBanner() {
  hideBanner(SW_UPDATE_BANNER_ID)
}

function applyWaitingServiceWorker(worker) {
  reloadOnControllerChange = true
  hideSwUpdateBanner()
  requestSkipWaiting(worker)
}

function showSwUpdateBanner(worker) {
  if (typeof document === 'undefined' || !isStandalone()) return
  showChoiceBanner({
    id: SW_UPDATE_BANNER_ID,
    message: 'App update ready. Reload to use it?',
    actions: [
      {
        label: 'Reload',
        primary: true,
        onClick: () => applyWaitingServiceWorker(worker),
      },
      { label: 'Not now', onClick: () => hideSwUpdateBanner() },
    ],
  })
}

/** Browser tabs: activate immediately. Standalone: ask before swapping mid-session. */
function offerOrActivateWaitingWorker(worker) {
  if (!worker) return
  if (!navigator.serviceWorker.controller) {
    // First install — no prior controller; activate without prompting.
    requestSkipWaiting(worker)
    return
  }
  if (isStandalone()) showSwUpdateBanner(worker)
  else requestSkipWaiting(worker)
}

function watchServiceWorkerUpdates(reg) {
  if (!reg || swUpdateWatchWired) return
  swUpdateWatchWired = true

  const trackInstalling = worker => {
    if (!worker) return
    if (worker.state === 'installed') {
      offerOrActivateWaitingWorker(worker)
      return
    }
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') offerOrActivateWaitingWorker(worker)
    })
  }

  // Cover workers already mid-install when we wire (updatefound may have fired).
  trackInstalling(reg.installing)
  if (reg.waiting) offerOrActivateWaitingWorker(reg.waiting)

  reg.addEventListener('updatefound', () => trackInstalling(reg.installing))

  // Pick up a published worker while the installed app is foregrounded again.
  const check = () => {
    if (!isSecureInstallContext()) return
    reg.update().catch(() => {})
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check()
  })
  window.addEventListener('online', check)
}

if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloadOnControllerChange) return
    reloadOnControllerChange = false
    location.reload()
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

async function faviconIdentity() {
  try {
    const res = await fetch(`${location.origin}/favicon.png`, { cache: 'no-cache' })
    if (!res.ok) return { rev: '', buf: null }
    const etag = res.headers.get('etag')
    const lm = res.headers.get('last-modified')
    if (etag) {
      try {
        await res.body?.cancel?.()
      } catch {
        /* ignore */
      }
      return { rev: etag.replace(/^W\//i, '').replace(/"/g, ''), buf: null }
    }
    if (lm) {
      try {
        await res.body?.cancel?.()
      } catch {
        /* ignore */
      }
      return { rev: String(Date.parse(lm) || lm), buf: null }
    }
    const buf = await res.arrayBuffer()
    const u8 = new Uint8Array(buf)
    let h = u8.length
    const step = Math.max(1, Math.floor(u8.length / 64))
    for (let i = 0; i < u8.length; i += step) h = (Math.imul(31, h) + u8[i]) | 0
    return { rev: `b${u8.length.toString(36)}_${(h >>> 0).toString(36)}`, buf }
  } catch {
    return { rev: '', buf: null }
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
  await injectManifest({ force: true, quality: 'full' })
  faviconUpgradePendingRev = null
  hideUpgradeBanner()
}

function syncFaviconIntoManifest() {
  // Stock browser tabs: never poll/rebuild icons — install prep is idle/lite only.
  if (!isStandalone()) return Promise.resolve()
  if (!isSecureInstallContext() || !navigator.onLine) return Promise.resolve()
  if (faviconCheckPromise) return faviconCheckPromise
  faviconCheckPromise = (async () => {
    const live = (await faviconIdentity()).rev
    if (!live) return
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

    await injectManifest({ force: true, quality: 'full' })
  })()
    .catch(err => console.warn('[PWA] favicon sync failed', err))
    .finally(() => {
      faviconCheckPromise = null
    })
  return faviconCheckPromise
}

/** Page-only: apple-touch-icon 180×180. Manifest 192/512 icons are rasterized in the SW. */
async function rasterizeFavicon(size, { rev, buf } = {}) {
  let identity = rev != null ? { rev, buf: buf || null } : null
  if (!identity?.rev) identity = await faviconIdentity()
  if (!identity.rev) throw new Error('favicon unavailable')
  let blobSource = identity.buf
  if (!blobSource) {
    const res = await fetch(`${location.origin}/favicon.png?v=${encodeURIComponent(identity.rev)}`, {
      cache: 'no-cache',
    })
    if (!res.ok) throw new Error(`favicon ${res.status}`)
    blobSource = await res.arrayBuffer()
  }
  const bitmap = await createImageBitmap(new Blob([blobSource], { type: 'image/png' }))
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  // Opaque fill — iOS composites white under transparency; match SW #eeeeee full-bleed draw.
  ctx.fillStyle = '#eeeeee'
  ctx.fillRect(0, 0, size, size)
  const scale = Math.min(size / bitmap.width, size / bitmap.height)
  const w = bitmap.width * scale
  const h = bitmap.height * scale
  ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h)
  bitmap.close()
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('toBlob failed')
  return { blob, rev: identity.rev }
}

function ensureMeta(name, content) {
  let meta = document.head.querySelector(`meta[name="${name}"]`)
  if (!meta) {
    meta = document.createElement('meta')
    meta.name = name
    document.head.appendChild(meta)
  }
  meta.content = content
  return meta
}

// Title-bar / browser chrome: light default, dark when OS prefers dark.
// Meta tags override manifest theme_color; media queries track prefers-color-scheme.
const THEME_COLOR_LIGHT = '#ffffff'
const THEME_COLOR_DARK = '#0f172a'

function ensureThemeColorMeta(content, media) {
  const sel = media
    ? `meta[name="theme-color"][media="${media}"]`
    : 'meta[name="theme-color"]:not([media])'
  let meta = document.head.querySelector(sel)
  if (!meta) {
    meta = document.createElement('meta')
    meta.name = 'theme-color'
    if (media) meta.media = media
    document.head.appendChild(meta)
  }
  meta.content = content
  return meta
}

function ensureThemeColorMetas() {
  ensureThemeColorMeta(THEME_COLOR_LIGHT)
  ensureThemeColorMeta(THEME_COLOR_LIGHT, '(prefers-color-scheme: light)')
  ensureThemeColorMeta(THEME_COLOR_DARK, '(prefers-color-scheme: dark)')
}

function applyInstallMetasLite() {
  const href = `${location.origin}/favicon.png`
  const title = domainIdentity().name
  let touch = document.head.querySelector('link[rel="apple-touch-icon"]')
  if (!touch) {
    touch = document.createElement('link')
    touch.rel = 'apple-touch-icon'
    document.head.appendChild(touch)
  }
  // No canvas — point at the live favicon so non-PWA browser tabs stay cheap.
  touch.href = href
  touch.removeAttribute('sizes')

  let icon = document.head.querySelector('link[rel="icon"][data-wiki-pwa="1"]')
  if (!icon) {
    icon = document.createElement('link')
    icon.rel = 'icon'
    icon.setAttribute('data-wiki-pwa', '1')
    document.head.appendChild(icon)
  }
  icon.type = 'image/png'
  icon.href = href

  ensureMeta('apple-mobile-web-app-capable', 'yes')
  ensureMeta('mobile-web-app-capable', 'yes')
  ensureMeta('apple-mobile-web-app-title', title)
  ensureThemeColorMetas()
  setApplicationName(title)
}

async function applyFaviconLinks() {
  applyInstallMetasLite()
  const touch = document.head.querySelector('link[rel="apple-touch-icon"]')
  if (!touch) return
  try {
    // Apple’s conventional home-screen size is 180×180 (standalone / full prepare only).
    const { blob } = await rasterizeFavicon(180)
    if (touchIconObjectUrl) URL.revokeObjectURL(touchIconObjectUrl)
    touchIconObjectUrl = URL.createObjectURL(blob)
    touch.href = touchIconObjectUrl
    touch.setAttribute('sizes', '180x180')
  } catch {
    /* lite href already set */
  }
}

async function ensureServiceWorker() {
  const reg = await navigator.serviceWorker.register('/service-worker.js', {
    scope: '/',
    updateViaCache: 'none',
  })
  watchServiceWorkerUpdates(reg)
  await navigator.serviceWorker.ready
  if (reg.active) reg.active.postMessage({ type: 'CLAIM' })
  // First control: activate waiting worker if registration has no controller yet.
  if (!navigator.serviceWorker.controller && reg.waiting) requestSkipWaiting(reg.waiting)
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

function postManifestOnce(reg, manifest, { clearIcons = false } = {}) {
  const target = reg.active || navigator.serviceWorker.controller
  if (!target) return Promise.reject(new Error('No active service worker'))
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => reject(new Error('SET_MANIFEST timeout')), 3000)
    channel.port1.onmessage = () => {
      clearTimeout(timer)
      resolve()
    }
    try {
      target.postMessage({ type: 'SET_MANIFEST', manifest, clearIcons: !!clearIcons }, [channel.port2])
    } catch (err) {
      clearTimeout(timer)
      reject(err)
    }
  })
}

async function postManifest(reg, manifest, opts) {
  try {
    await postManifestOnce(reg, manifest, opts)
  } catch {
    await postManifestOnce(reg, manifest, opts)
  }
}

/**
 * @param {{ force?: boolean, quality?: 'lite'|'full' }} [opts]
 * lite — installability (SW + manifest; icons on demand in SW).
 * full — standalone polish (warm SW icons + apple-touch 180). Manifest icons always SW-generated.
 */
async function injectManifest({ force = false, quality } = {}) {
  const gen = ++prepareGeneration
  const full = quality === 'full' || (quality !== 'lite' && isStandalone())
  const reg = await ensureServiceWorker()
  if (gen !== prepareGeneration) return null

  const origin = location.origin
  const { name: title, id: appId, startUrl, scope } = domainIdentity()

  // Session early-exit. Lite must not block a later full prepare in the same session.
  if (!force && prepared && (!full || preparedFull)) {
    if (full) syncFaviconIntoManifest().catch(() => {})
    return { name: title }
  }

  const identity = await faviconIdentity()
  if (gen !== prepareGeneration) return null
  const abs = path => `${origin}${path}`
  const icon192 = { url: abs('/pwa-icon-192.png'), rev: identity.rev }
  const icon512 = { url: abs('/pwa-icon-512.png'), rev: identity.rev }
  const mask192 = { url: abs('/pwa-icon-maskable-192.png'), rev: identity.rev }
  const mask512 = { url: abs('/pwa-icon-maskable-512.png'), rev: identity.rev }

  const layoutStale = lsGet(ICON_LAYOUT_FLAG) !== ICON_LAYOUT
  const revStale = !!(identity.rev && identity.rev !== readAppliedFaviconRev())
  // SW matches /pwa-icon-* with ignoreSearch — only wipe when draw inputs change.
  // Do not clear on every session prepare/force: that remounts the manifest and
  // triggers browser origin probes for SW-only /pwa-icon-* (log 404 noise).
  const clearIcons = layoutStale || (full && revStale)

  const revQ = encodeURIComponent(icon192.rev || Date.now())
  const manifest = {
    id: appId,
    name: title,
    short_name: title,
    description: 'Federated Wiki as a PWA',
    start_url: startUrl,
    scope,
    display: 'standalone',
    background_color: '#eeeeee',
    theme_color: THEME_COLOR_LIGHT,
    share_target: shareTarget(origin),
    // Maskable first: Android install UI plates `any` icons on white when maskable
    // fails to load. Do not list /favicon.png as `any` — it is network-reachable and
    // becomes the plated fallback when SW-only /pwa-icon-* URLs 404.
    icons: [
      {
        src: `${mask192.url}?v=${revQ}`,
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: `${mask512.url}?v=${revQ}`,
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
      // Network-reachable maskable fallback (install fetch may bypass SW cache).
      {
        src: `${origin}/favicon.png?v=${revQ}`,
        sizes: '32x32',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: `${icon192.url}?v=${revQ}`,
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: `${icon512.url}?v=${revQ}`,
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
    ],
  }

  await postManifest(reg, manifest, { clearIcons })
  if (gen !== prepareGeneration) return null

  if (full) await applyFaviconLinks()
  else applyInstallMetasLite()

  // Warm SW icon cache before announcing the manifest so the omnibox install
  // check (often right after <link rel=manifest>) does not race an empty cache.
  // Page fetches go through the SW; origin bypass probes may still 404.
  const i192 = await fetch(icon192.url, { cache: 'no-store' })
  if (!i192.ok) throw new Error(`icon192 ${i192.status}`)
  const i512 = await fetch(icon512.url, { cache: 'no-store' })
  if (!i512.ok) throw new Error(`icon512 ${i512.status}`)
  const iMask = await fetch(mask512.url, { cache: 'no-store' })
  if (!iMask.ok) throw new Error(`mask512 ${iMask.status}`)
  if (gen !== prepareGeneration) return null

  let link = document.head.querySelector('link[rel="manifest"]')
  if (!link) {
    link = document.createElement('link')
    link.rel = 'manifest'
    document.head.appendChild(link)
  }
  // Stable rev+layout query for retries in-session. Bust once per page load (and
  // when icons change) so Chrome re-runs installability after icons are warm —
  // without Date.now() on every prepare (log noise from SW-bypass icon probes).
  const manifestBase = `${origin}/manifest.webmanifest?v=${revQ}&l=${encodeURIComponent(ICON_LAYOUT)}`
  const bustDom = !manifestDomAnnounced || clearIcons || force
  const manifestHref = bustDom ? `${manifestBase}&t=${Date.now()}` : manifestBase
  if (link.getAttribute('href') !== manifestHref) link.setAttribute('href', manifestHref)

  const check = await fetch(manifestBase, { cache: 'no-store' })
  if (!check.ok) throw new Error(`manifest ${check.status}`)
  const served = await check.json()
  if (!served?.share_target?.action) throw new Error('manifest missing share_target')

  if (gen !== prepareGeneration) return null
  // Only after link + overlay verify — avoids early-exit skipping a failed prepare.
  prepared = true
  manifestDomAnnounced = true
  lsSet(ICON_LAYOUT_FLAG, ICON_LAYOUT)
  if (full) {
    preparedFull = true
    if (icon192.rev) {
      writeAppliedFaviconRev(icon192.rev)
      writeDismissedFaviconRev('')
      faviconUpgradePendingRev = null
      hideUpgradeBanner()
    }
  }
  // Already-installed apps may need reinstall for the OS to list Share Target.
  console.info('[PWA] manifest ready', {
    name: manifest.name,
    quality: full ? 'full' : 'lite',
    share_target: served.share_target.action,
  })
  return manifest
}

/**
 * Absolute single-page URL for Web Share (tab or installed PWA).
 * Do not use siteLineup() — that prepends welcome-visitors and opens a two-page lineup.
 * `/view/{slug}` still opens in the wiki/PWA and is a normal https link for chat apps.
 */
function absolutePageShareUrl(pageObject) {
  const slug = pageObject?.getSlug?.()
  if (!slug) return location.href

  let path
  if (pageObject.isRemote?.()) {
    const site = pageObject.getRemoteSite?.(location.host)
    path = (typeof wiki !== 'undefined' && wiki.site?.(site)?.getDirectURL?.(`view/${slug}`)) || `//${site}/view/${slug}`
  } else {
    path = `/view/${slug}`
  }
  if (!path) return location.href
  if (/^https?:\/\//i.test(path)) return path
  if (path.startsWith('//')) return `${location.protocol}${path}`
  if (!path.startsWith('/')) path = `/${path}`
  return `${location.origin}${path}`
}

function firstHttpUrlIn(...parts) {
  for (const part of parts) {
    const m = String(part || '').match(/https?:\/\/[^\s<>"']+/i)
    if (m) return m[0].replace(/[),.;]+$/, '')
  }
  return ''
}

/** Federated Wiki page URL → { site, slug }. Strips query/hash (share-sheet trackers). */
function parseSharedWikiPageUrl(href) {
  let cleaned = String(href || '')
  try {
    const u = new URL(cleaned)
    cleaned = `${u.origin}${u.pathname.replace(/\/+$/, '') || '/'}`
  } catch {
    cleaned = cleaned.split(/[?#]/)[0]
  }
  const found = cleaned.match(
    /^https?:\/\/([a-zA-Z0-9:.-]+)(\/([a-zA-Z0-9:.-]+)\/([a-z0-9-]+(_rev\d+)?))+$/,
  )
  if (!found) return null
  let site = found[3]
  const slug = found[4]
  if (['view', 'local', 'origin'].includes(site)) site = found[1]
  return { site, slug }
}

async function copyShareUrl(url) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url)
      return true
    }
  } catch {
    /* fall through */
  }
  try {
    window.prompt('Copy page link:', url)
    return true
  } catch {
    return false
  }
}

function sharePayloadForOs(url) {
  // Android (esp. Telegram) concatenates title/text/url → "Title\nurl url".
  // Windows Share only offers "Copy link" when the payload has a `url` field.
  if (/Android/i.test(navigator.userAgent || '')) return { text: url }
  return { url }
}

async function sharePageOut($page) {
  const pageObject = wiki.lineup?.atKey?.($page.data('key'))
  if (!pageObject) return
  const url = absolutePageShareUrl(pageObject)
  if (typeof navigator.share === 'function') {
    try {
      const data = sharePayloadForOs(url)
      if (navigator.canShare && !navigator.canShare(data)) {
        await navigator.share({ text: url })
        return
      }
      await navigator.share(data)
      return
    } catch (err) {
      if (err?.name === 'AbortError') return
      console.warn('[PWA] share failed', err)
    }
  }
  await copyShareUrl(url)
}

/**
 * Handle GET share_target landing (?title&text&url).
 * Chromium/Edge installed PWAs only — Safari has no receive path.
 * Opens the page in the lineup for manual fork/use — does not auto-fork.
 */
function handleIncomingShareTarget() {
  const params = new URLSearchParams(location.search || '')
  const title = params.get('title') || ''
  const text = params.get('text') || ''
  const urlParam = params.get('url') || ''
  if (!title && !text && !urlParam) return

  const sharedUrl = urlParam || firstHttpUrlIn(text, title)
  if (!sharedUrl) {
    console.warn('[PWA] share receive: no URL in share payload')
    return
  }

  const parsed = parseSharedWikiPageUrl(sharedUrl)
  if (!parsed?.slug) {
    console.warn('[PWA] share receive: not a Federated Wiki page URL', sharedUrl)
    return
  }

  if (typeof wiki?.doInternalLink !== 'function') {
    // Leave query params so pageshow / later boot can retry.
    console.warn('[PWA] share receive: wiki.doInternalLink missing')
    return
  }

  const here = (location.host || '').toLowerCase()
  const site = (parsed.site || '').toLowerCase()
  const remoteSite = site && site !== here ? parsed.site : null
  wiki.doInternalLink(parsed.slug, null, remoteSite)
  history.replaceState(null, '', `${location.pathname}${location.hash || ''}`)
}

function wireShareControls() {
  if (typeof $ === 'undefined') return
  $('body').on('click', '.footer a.share', function (e) {
    e.preventDefault()
    const $page = $(e.target).closest('.page')
    if (!$page.length) return
    sharePageOut($page).catch(err => console.warn('[PWA] share', err))
  })
  try {
    handleIncomingShareTarget()
  } catch (err) {
    console.warn('[PWA] share receive', err)
  }
  // Windows may deliver share navigations after the first paint / bfcache restore.
  window.addEventListener('pageshow', () => {
    try {
      handleIncomingShareTarget()
    } catch (err) {
      console.warn('[PWA] share receive', err)
    }
  })
}

function scheduleIdleInstallPrep() {
  if (idleInstallScheduled) return
  idleInstallScheduled = true
  const run = () => {
    injectManifest({ quality: 'lite' }).catch(err => console.warn('[PWA] prepare failed', err))
  }
  const afterLoad = () => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => run(), { timeout: 10000 })
    } else {
      setTimeout(run, 4000)
    }
  }
  if (document.readyState === 'complete') afterLoad()
  else window.addEventListener('load', afterLoad, { once: true })
}

function prepareInstallSurface() {
  if (!isSecureInstallContext()) return
  // Installed PWA: full icons + favicon sync. Non-PWA browser: defer lite installability until idle.
  if (isStandalone()) {
    injectManifest({ quality: 'full', force: !preparedFull })
      .then(() => syncFaviconIntoManifest())
      .catch(err => console.warn('[PWA] prepare failed', err))
    return
  }
  scheduleIdleInstallPrep()
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

function listPendingLargeAssets() {
  return [...pendingLargeAssets.values()]
    .map(e => ({
      site: e.site || '',
      rel: e.rel || '',
      size: e.size || 0,
      kind: e.kind || '',
    }))
    .sort((a, b) => b.size - a.size || String(a.rel).localeCompare(String(b.rel)))
}

function largeAssetKindLabel(kind) {
  if (kind === 'commons') return 'commons image'
  if (kind === 'neighbor') return 'neighbor asset'
  if (kind === 'origin') return 'site asset'
  return kind || 'asset'
}

function tellServiceWorkerLargeConsent(allowed) {
  const on = !!allowed
  if (lastPostedLargeConsent === on) return
  lastPostedLargeConsent = on
  postToSw('LARGE_PACK_CONSENT', {
    allowed: on,
    maxBytes: on ? Number.POSITIVE_INFINITY : MAX_PACK_ASSET_BYTES,
  })
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

function startOfflineCache() {
  if (!isStandalone()) return Promise.resolve(null)
  if (offlineCachePromise) return offlineCachePromise
  console.info('[PWA] offline seed starting')
  writeOfflinePackFlag(false)
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
    await cacheOpenLineupPages(cache)
  })

  console.info('[PWA] offline seed ready (shell/lineup) — scheduling neighborhood packs')
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
  if (pending.count) syncPwaCacheUi()
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
  syncPwaCacheUi()
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
  if (!bgPackStatus.size && !pendingLargeAssets.size && !bgPackInflight.size) return ''
  const parts = []
  let active = 0
  for (const [site, st] of bgPackStatus) {
    if (!st || st.phase === 'done') continue
    active += 1
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
  if (!parts.length && bgPackInflight.size) return 'Neighborhood pack finishing…'
  if (!parts.length && !active) return ''
  return parts.length ? `Neighborhood packing: ${parts.join(' · ')}` : ''
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

function maybeStartStandalonePack() {
  if (!isSecureInstallContext() || !navigator.onLine) return
  if (!isStandalone()) return
  ensurePersistentStorage().catch(() => {})
  if (!needsOfflinePack()) return
  startOfflineCache().catch(() => {})
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

function watchDisplayModeForPackUi() {
  if (!window.matchMedia) return
  const modes = ['standalone', 'minimal-ui', 'window-controls-overlay']
  for (const mode of modes) {
    try {
      const mq = window.matchMedia(`(display-mode: ${mode})`)
      const onChange = () => {
        syncPwaCacheUi()
        if (mq.matches && needsOfflinePack()) maybeStartStandalonePack()
        else if (!isStandalone()) {
          hideUpgradeBanner()
          hideSwUpdateBanner()
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

/** Largest first; stable tie-break on optional string key. */
function byBytesDesc(a, b, nameKey) {
  const d = (b.bytes || b.size || 0) - (a.bytes || a.size || 0)
  if (d) return d
  if (!nameKey) return 0
  const an = String(a[nameKey] || '')
  const bn = String(b[nameKey] || '')
  return an < bn ? -1 : an > bn ? 1 : 0
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
    path === '/__pwa_standalone__' ||
    path === '/__pwa_large_consent__' ||
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

async function responseByteLength(res) {
  if (!res) return 0
  const cl = res.headers.get('content-length')
  if (cl && Number(cl) > 0) return Number(cl)
  try {
    return (await res.clone().arrayBuffer()).byteLength
  } catch {
    return 0
  }
}

function cacheKeyAliases(urlString) {
  const keys = new Set()
  try {
    const u = new URL(urlString, location.origin)
    keys.add(u.href)
    keys.add(u.pathname + u.search)
    if (u.origin === location.origin) keys.add(u.pathname)
  } catch {
    if (urlString) keys.add(urlString)
  }
  return [...keys]
}

async function estimatePluginCacheBytes() {
  const pluginCaches = []
  if (!('caches' in window)) return pluginCaches
  const keys = await caches.keys()
  for (const name of keys) {
    if (name.startsWith('fedwiki-pwa')) continue
    if (!/^wiki-.+-pwa-cache-/i.test(name)) continue
    let bytes = 0
    try {
      const cache = await caches.open(name)
      for (const req of await cache.keys()) {
        try {
          bytes += await responseByteLength(await cache.match(req))
        } catch {
          /* skip */
        }
      }
    } catch {
      continue
    }
    pluginCaches.push({ name, bytes })
  }
  pluginCaches.sort((a, b) => byBytesDesc(a, b, 'name'))
  return pluginCaches
}

function parseExportRel(rel) {
  const parts = String(rel || '')
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
  if (parts.length < 2) return null
  const site = parts[0].toLowerCase()
  const kind = parts[1]
  if (site === 'commons') {
    return { site: 'commons', kind: 'assets', path: rel, slug: parts.slice(1).join('/') }
  }
  if (kind === 'pages' && parts[2]) {
    return { site, kind: 'pages', path: rel, slug: parts[2] }
  }
  if (kind === 'assets') {
    return { site, kind: 'assets', path: rel, slug: parts.slice(2).join('/') }
  }
  if (kind === 'status') {
    return { site, kind: 'status', path: rel, slug: parts.slice(2).join('/') }
  }
  return { site, kind: 'other', path: rel, slug: parts.slice(1).join('/') }
}

function ensureInventorySite(map, site) {
  const key = String(site || '').toLowerCase()
  let row = map.get(key)
  if (!row) {
    row = { site: key, totalBytes: 0, pages: new Map(), assets: new Map(), status: new Map() }
    map.set(key, row)
  }
  return row
}

function addInventoryEntry(bucketMap, key, bytes, req) {
  let entry = bucketMap.get(key)
  if (!entry) {
    entry = { key, bytes: 0, requests: [] }
    bucketMap.set(key, entry)
  }
  entry.bytes += bytes
  entry.requests.push(req)
}

async function inventoryOfflineBackup() {
  const siteMap = new Map()
  let totalBytes = 0
  let shellBytes = 0
  const shellRequests = []
  if (!('caches' in window)) {
    return { totalBytes, shellBytes, shellRequests, pluginCaches: [], sites: [] }
  }

  const seenAliases = new Set()
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
      const aliases = cacheKeyAliases(req.url)
      if (aliases.some(a => seenAliases.has(a))) continue
      for (const a of aliases) seenAliases.add(a)

      let bytes = 0
      try {
        bytes = await responseByteLength(await cache.match(req))
      } catch {
        bytes = 0
      }
      totalBytes += bytes

      const rels = wikiExportPathsFromCacheUrl(req.url)
      if (!rels.length) {
        shellBytes += bytes
        shellRequests.push(req)
        continue
      }

      const primary = rels.find(r => !String(r).startsWith('commons/')) || rels[0]
      const parsed = parseExportRel(primary)
      if (!parsed) {
        shellBytes += bytes
        shellRequests.push(req)
        continue
      }

      const siteRow = ensureInventorySite(siteMap, parsed.site)
      siteRow.totalBytes += bytes
      if (parsed.kind === 'pages') addInventoryEntry(siteRow.pages, parsed.slug, bytes, req)
      else if (parsed.kind === 'assets') addInventoryEntry(siteRow.assets, parsed.path, bytes, req)
      else if (parsed.kind === 'status') addInventoryEntry(siteRow.status, parsed.path, bytes, req)
      else addInventoryEntry(siteRow.assets, parsed.path, bytes, req)
    }
  }

  const pluginCaches = await estimatePluginCacheBytes()
  const sites = [...siteMap.values()]
    .map(s => ({
      site: s.site,
      totalBytes: s.totalBytes,
      pages: [...s.pages.values()]
        .map(p => ({ slug: p.key, bytes: p.bytes, requests: p.requests }))
        .sort((a, b) => byBytesDesc(a, b, 'slug')),
      assets: [...s.assets.values()]
        .map(a => ({ path: a.key, bytes: a.bytes, requests: a.requests }))
        .sort((a, b) => byBytesDesc(a, b, 'path')),
      status: [...s.status.values()]
        .map(st => ({ path: st.key, bytes: st.bytes, requests: st.requests }))
        .sort((a, b) => byBytesDesc(a, b, 'path')),
    }))
    .sort((a, b) => b.totalBytes - a.totalBytes || (a.site < b.site ? -1 : a.site > b.site ? 1 : 0))

  return { totalBytes, shellBytes, shellRequests, pluginCaches, sites }
}

async function deleteOfflineBackupRequests(requests) {
  if (!('caches' in window) || !requests?.length) return 0
  const aliasSet = new Set()
  for (const req of requests) {
    for (const a of cacheKeyAliases(req.url || req)) aliasSet.add(a)
  }
  const aliases = [...aliasSet]
  let deleted = 0
  const keys = await caches.keys()
  for (const name of keys.filter(k => k.startsWith('fedwiki-pwa'))) {
    let cache
    try {
      cache = await caches.open(name)
    } catch {
      continue
    }
    for (const alias of aliases) {
      try {
        if (await cache.delete(alias)) deleted += 1
      } catch {
        /* skip */
      }
    }
  }
  return deleted
}

function clearSitePackState(site) {
  const key = String(site || '').toLowerCase()
  if (!key) return
  bgPackStatus.delete(key)
  bgPackInflight.delete(key)
  for (const [k, entry] of [...pendingLargeAssets.entries()]) {
    if (String(entry?.site || '').toLowerCase() === key) pendingLargeAssets.delete(k)
  }
}

async function flushOfflineBackupSite(site) {
  return flushOfflineBackupSites([site])
}

async function flushOfflineBackupSites(sites) {
  const want = new Set((sites || []).map(s => String(s || '').toLowerCase()).filter(Boolean))
  if (!want.size) return 0
  const inv = await inventoryOfflineBackup()
  const reqs = []
  for (const row of inv.sites) {
    if (!want.has(row.site)) continue
    for (const p of row.pages) reqs.push(...p.requests)
    for (const a of row.assets) reqs.push(...a.requests)
    for (const st of row.status) reqs.push(...st.requests)
    clearSitePackState(row.site)
  }
  return deleteOfflineBackupRequests(reqs)
}

async function flushOfflineBackupPages(site, slugs) {
  const want = new Set((slugs || []).map(s => String(s || '').toLowerCase()).filter(Boolean))
  if (!want.size) return 0
  const inv = await inventoryOfflineBackup()
  const row = inv.sites.find(s => s.site === String(site || '').toLowerCase())
  if (!row) return 0
  const reqs = []
  for (const p of row.pages) {
    if (want.has(String(p.slug || '').toLowerCase())) reqs.push(...p.requests)
  }
  return deleteOfflineBackupRequests(reqs)
}

async function flushOfflineBackup() {
  if (!('caches' in window)) return
  const keys = await caches.keys()
  await Promise.all(keys.filter(k => k.startsWith('fedwiki-pwa')).map(k => caches.delete(k)))
  writeOfflinePackFlag(false)
  writePackPending(false)
  warmedPlugins = new Set()
  pendingLargeAssets.clear()
  bgPackStatus.clear()
  bgPackInflight.clear()
  prepared = false
  prepareGeneration += 1
  lastPostedLargeConsent = null
}

function h(tag, css, text) {
  const el = document.createElement(tag)
  if (css) el.style.cssText = css
  if (text != null) el.textContent = text
  return el
}

function removePwaCacheUi() {
  document.querySelectorAll('.' + LOCAL_CHANGES_PANEL_CLASS).forEach(el => el.remove())
  document.querySelectorAll('.' + PWA_CACHE_LINK_CLASS).forEach(el => el.remove())
  document.querySelectorAll('.' + PWA_CACHE_PANEL_CLASS).forEach(el => el.remove())
}

function findPagesBySlug(slug) {
  if (typeof $ === 'undefined') return $()
  return $('.page').filter(function () {
    return pageSlugFromEl($(this)) === slug
  })
}

function appendBeforeFooter($page, el) {
  const $footer = $page.find('.footer').first()
  if ($footer.length) $footer.before(el)
  else $page.find('.paper').append(el)
}

function renderLocalChangesPwaLink($page) {
  if (!isStandalone() || !$page?.length) return
  $page.find('.' + LOCAL_CHANGES_PANEL_CLASS).remove()
  $page.find('.' + PWA_CACHE_LINK_CLASS).remove()

  // Match other story paragraphs (e.g. Recent Changes): native [[internal]] look, not a form button.
  const item = document.createElement('div')
  item.className = `item paragraph ${PWA_CACHE_LINK_CLASS}`
  item.setAttribute('data-wiki-pwa', '1')
  const p = document.createElement('p')
  const link = document.createElement('a')
  link.className = 'internal'
  link.href = `/${PWA_CACHE_SLUG}.html`
  link.dataset.pageName = PWA_CACHE_SLUG
  link.textContent = PWA_CACHE_TITLE
  link.addEventListener('click', e => {
    e.preventDefault()
    e.stopPropagation()
    openPwaCachePage()
  })
  p.appendChild(link)
  item.appendChild(p)

  const $story = $page.find('.story').first()
  if ($story.length) $story.append(item)
  else appendBeforeFooter($page, item)
}

function openPwaCachePage() {
  if (!isStandalone()) return
  const pageObject = newPage({
    title: PWA_CACHE_TITLE,
    story: [
      {
        type: 'paragraph',
        id: itemId(),
        text:
          'Offline backup for this installed app: site pages and assets cached for offline use. This is a client-only ghost page — it is not stored on the farm.',
      },
    ],
    journal: [],
  })
  const show = typeof wiki !== 'undefined' && wiki.showResult ? wiki.showResult : null
  if (!show) {
    console.warn('[PWA] wiki.showResult unavailable')
    return
  }
  // Always append a fresh ghost at lineup end (do not focus/reuse an existing PWA Cache page,
  // and do not pass $page — that would chop pages to the right of the click origin).
  show(pageObject, {})
  const $page = findPagesBySlug(PWA_CACHE_SLUG).last()
  if ($page.length) {
    renderPwaCachePanel($page).catch(err => console.warn('[PWA] cache panel', err))
  }
}

async function renderPwaCachePanel($page) {
  if (!isStandalone() || !$page?.length) return
  $page.find('.' + PWA_CACHE_PANEL_CLASS).remove()

  const panel = h('div', 'margin:0.5em 0.8em 1em;padding:0.75em 1em;border-top:1px solid #ccc;font:13px/1.4 system-ui,sans-serif;color:#333')
  panel.className = PWA_CACHE_PANEL_CLASS
  panel.setAttribute('data-wiki-pwa', '1')
  const panelStyle = document.createElement('style')
  panelStyle.textContent =
    `.${PWA_CACHE_PANEL_CLASS} details[data-site] > summary{list-style:none}` +
    `.${PWA_CACHE_PANEL_CLASS} details[data-site] > summary::-webkit-details-marker{display:none}`
  panel.appendChild(panelStyle)

  const status = h('p', 'margin:0.25em 0 0.5em', 'Measuring storage…')
  const btnRow = h('div', 'display:flex;flex-wrap:wrap;gap:0.5em;margin-top:0.25em')
  const note = h(
    'p',
    'margin:0.5em 0 0;color:#666;font-size:12px',
    'Seed = shell + open lineup (needed to reopen offline). Neighborhood pack continues in the background. Under 8\u202fMiB packs automatically; larger files ask first. Refresh remeasures caches. Export = farm-shaped zip. App shell keys are only cleared by Flush all.',
  )
  const largeRow = h('div', 'margin-top:0.6em;padding-top:0.5em;border-top:1px dashed #ddd')
  const inventoryRow = h('div', 'margin-top:0.75em;padding-top:0.5em;border-top:1px solid #ddd')
  panel.append(status, btnRow, note, largeRow, inventoryRow)
  appendBeforeFooter($page, panel)

  let busy = false
  const softRefresh = () => refresh().catch(() => {})

  const setBusy = on => {
    busy = !!on
    panel.querySelectorAll('button, input[type=checkbox]').forEach(el => {
      if (el.dataset.keepEnabled === '1') return
      el.disabled = busy
    })
  }

  const renderLargeConsent = () => {
    const largeDetailsOpen = !!largeRow.querySelector('details[data-large-pending][open]')
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
        panelBtn('Never', () => setLargeAssetConsent('deny', { refresh: softRefresh })),
      )
      largeRow.appendChild(row)

      const entries = listPendingLargeAssets()
      const details = document.createElement('details')
      details.dataset.largePending = '1'
      if (largeDetailsOpen) details.open = true
      details.style.cssText = 'margin:0.5em 0 0'
      const summary = document.createElement('summary')
      summary.style.cssText = 'cursor:pointer;font-size:12px;color:#333;user-select:none'
      summary.textContent = 'Inspect waiting files (largest first)'
      details.appendChild(summary)
      const list = h('div', 'margin:0.35em 0 0;font-size:12px;color:#444')
      for (const e of entries) {
        const rowEl = h('div', 'margin:0.2em 0;padding:0.25em 0;border-bottom:1px solid #eee')
        rowEl.append(
          h(
            'div',
            'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all',
            `assets/${e.rel}`,
          ),
          h(
            'div',
            'margin-top:0.15em;color:#666',
            `${formatBytes(e.size)} · from ${e.site || 'unknown'} · ${largeAssetKindLabel(e.kind)}`,
          ),
        )
        list.appendChild(rowEl)
      }
      details.appendChild(list)
      largeRow.appendChild(details)
    } else if (consent !== 'ask') {
      largeRow.appendChild(
        panelBtn('Ask again about large assets', () => setLargeAssetConsent('ask', { refresh: softRefresh })),
      )
    }
  }

  const renderInventory = inv => {
    // Poll/refresh rebuilds this DOM; keep open <details> and checks across rebuilds.
    const openSites = new Set(
      [...inventoryRow.querySelectorAll('details[data-site][open]')].map(el => el.dataset.site),
    )
    const prevSelectedSites = new Set(
      [...inventoryRow.querySelectorAll('input[data-site-select]:checked')].map(cb => cb.dataset.siteSelect).filter(Boolean),
    )
    const selectedBySite = new Map()
    inventoryRow.querySelectorAll('details[data-site]').forEach(el => {
      const checked = [...el.querySelectorAll('input[data-slug]:checked')].map(cb => cb.dataset.slug).filter(Boolean)
      if (checked.length) selectedBySite.set(el.dataset.site, new Set(checked))
    })

    inventoryRow.replaceChildren()
    const headingRow = h('div', 'display:flex;flex-wrap:wrap;align-items:center;gap:0.5em;margin-bottom:0.4em')
    headingRow.appendChild(h('div', 'font-weight:600', 'Cached sites'))
    inventoryRow.appendChild(headingRow)

    if (inv.shellBytes > 0) {
      inventoryRow.appendChild(
        h(
          'p',
          'margin:0 0 0.4em;font-size:12px;color:#555',
          `App shell & other: ${formatBytes(inv.shellBytes)} (flush-all only).`,
        ),
      )
    }
    if (inv.pluginCaches?.length) {
      const pluginBytes = inv.pluginCaches.reduce((n, p) => n + (p.bytes || 0), 0)
      inventoryRow.appendChild(
        h(
          'p',
          'margin:0 0 0.5em;font-size:12px;color:#555',
          `Plugin caches (read-only): ${plural(inv.pluginCaches.length, 'cache')} · ${formatBytes(pluginBytes)}.`,
        ),
      )
    }
    if (!inv.sites.length) {
      inventoryRow.appendChild(h('p', 'margin:0;color:#666;font-size:12px', 'No site pages/assets cached yet.'))
      return
    }

    const selectedSites = new Set([...prevSelectedSites].filter(s => inv.sites.some(row => row.site === s)))
    const flushSelectedSitesBtn = panelBtn('Flush selected sites…', async () => {
      if (!selectedSites.size) return
      const names = [...selectedSites].sort().join(', ')
      if (
        !window.confirm(
          `Flush cached data for ${plural(selectedSites.size, 'selected site')} (${names})? This removes pages and assets for those sites from this app’s offline backup.`,
        )
      ) {
        return
      }
      setBusy(true)
      status.textContent = `Flushing ${plural(selectedSites.size, 'site')}…`
      try {
        await flushOfflineBackupSites([...selectedSites])
        await refresh()
        syncPwaCacheUi()
      } catch (err) {
        status.textContent = `Flush failed: ${err?.message || err}`
      } finally {
        setBusy(false)
      }
    })
    const updateFlushSelectedSites = () => {
      flushSelectedSitesBtn.disabled = busy || selectedSites.size === 0
    }
    updateFlushSelectedSites()
    headingRow.appendChild(flushSelectedSitesBtn)

    for (const site of inv.sites) {
      const details = document.createElement('details')
      details.dataset.site = site.site
      if (openSites.has(site.site)) details.open = true
      details.style.cssText = 'margin:0.35em 0;border:1px solid #e0e0e0;padding:0.35em 0.5em'
      const summary = document.createElement('summary')
      summary.style.cssText =
        'cursor:pointer;font-weight:600;display:flex;align-items:center;gap:0.45em;user-select:none'
      const chevron = h(
        'span',
        'display:inline-block;width:0.9em;flex:0 0 auto;color:#555;font-size:12px;line-height:1',
        details.open ? '\u25BE' : '\u25B8',
      )
      chevron.setAttribute('aria-hidden', 'true')
      details.addEventListener('toggle', () => {
        chevron.textContent = details.open ? '\u25BE' : '\u25B8'
      })
      const siteCb = document.createElement('input')
      siteCb.type = 'checkbox'
      siteCb.dataset.siteSelect = site.site
      siteCb.title = `Select ${site.site}`
      siteCb.style.cssText = 'flex:0 0 auto;margin:0'
      if (selectedSites.has(site.site)) siteCb.checked = true
      // Keep checkbox clicks from toggling <details>; rest of the summary row still expands/collapses.
      const stopToggle = e => e.stopPropagation()
      siteCb.addEventListener('click', stopToggle)
      siteCb.addEventListener('mousedown', stopToggle)
      siteCb.addEventListener('mouseup', stopToggle)
      siteCb.addEventListener('change', () => {
        if (siteCb.checked) selectedSites.add(site.site)
        else selectedSites.delete(site.site)
        updateFlushSelectedSites()
      })
      const label = h(
        'span',
        'flex:1 1 auto;min-width:0',
        `${site.site} · ${formatBytes(site.totalBytes)} · ${plural(site.pages.length, 'page')} · ${plural(
          site.assets.length,
          'asset',
        )}`,
      )
      summary.append(chevron, siteCb, label)
      details.appendChild(summary)

      const siteActions = h('div', 'display:flex;flex-wrap:wrap;gap:0.5em;margin:0.4em 0')
      const flushSiteBtn = panelBtn('Flush site…', async () => {
        if (
          !window.confirm(
            `Flush all cached data for ${site.site}? This removes pages and assets for that site from this app’s offline backup.`,
          )
        ) {
          return
        }
        setBusy(true)
        status.textContent = `Flushing ${site.site}…`
        try {
          await flushOfflineBackupSite(site.site)
          await refresh()
          syncPwaCacheUi()
        } catch (err) {
          status.textContent = `Flush failed: ${err?.message || err}`
        } finally {
          setBusy(false)
        }
      })
      siteActions.appendChild(flushSiteBtn)
      details.appendChild(siteActions)

      if (site.pages.length) {
        const list = h('div', 'margin:0.25em 0 0.5em')
        list.appendChild(
          h('p', 'margin:0 0 0.25em;font-size:12px;color:#555', 'Pages (largest first):'),
        )
        const prevSelected = selectedBySite.get(site.site)
        const selected = new Set(
          (prevSelected ? [...prevSelected] : []).filter(slug => site.pages.some(p => p.slug === slug)),
        )
        const flushSelectedBtn = panelBtn('Flush selected pages…', async () => {
          if (!selected.size) return
          if (!window.confirm(`Flush ${plural(selected.size, 'selected page')} for ${site.site}?`)) return
          setBusy(true)
          status.textContent = 'Flushing selected pages…'
          try {
            await flushOfflineBackupPages(site.site, [...selected])
            await refresh()
            syncPwaCacheUi()
          } catch (err) {
            status.textContent = `Flush failed: ${err?.message || err}`
          } finally {
            setBusy(false)
          }
        })
        const updateFlushSelected = () => {
          flushSelectedBtn.disabled = busy || selected.size === 0
        }

        for (const page of site.pages) {
          const row = h('label', 'display:flex;align-items:center;gap:0.4em;margin:0.15em 0;font-size:12px')
          const cb = document.createElement('input')
          cb.type = 'checkbox'
          cb.dataset.slug = page.slug
          if (selected.has(page.slug)) cb.checked = true
          cb.addEventListener('change', () => {
            if (cb.checked) selected.add(page.slug)
            else selected.delete(page.slug)
            updateFlushSelected()
          })
          row.append(cb, document.createTextNode(`${page.slug} · ${formatBytes(page.bytes)}`))
          list.appendChild(row)
        }
        updateFlushSelected()
        list.appendChild(flushSelectedBtn)
        details.appendChild(list)
      }

      if (site.assets.length) {
        const assetBytes = site.assets.reduce((n, a) => n + (a.bytes || 0), 0)
        const assetBlock = h('div', 'margin:0.25em 0 0.5em')
        assetBlock.appendChild(
          h(
            'p',
            'margin:0 0 0.25em;font-size:12px;color:#555',
            `Assets: ${plural(site.assets.length, 'file')} · ${formatBytes(assetBytes)} (largest first; cleared with Flush site).`,
          ),
        )
        for (const asset of site.assets) {
          assetBlock.appendChild(
            h(
              'div',
              'margin:0.15em 0;font-size:12px;word-break:break-all',
              `${asset.path} · ${formatBytes(asset.bytes)}`,
            ),
          )
        }
        details.appendChild(assetBlock)
      }
      if (site.status.length) {
        const statusBytes = site.status.reduce((n, a) => n + (a.bytes || 0), 0)
        const statusBlock = h('div', 'margin:0.25em 0 0.5em')
        statusBlock.appendChild(
          h(
            'p',
            'margin:0 0 0.25em;font-size:12px;color:#555',
            `Status: ${plural(site.status.length, 'file')} · ${formatBytes(statusBytes)} (largest first; cleared with Flush site).`,
          ),
        )
        for (const st of site.status) {
          statusBlock.appendChild(
            h(
              'div',
              'margin:0.15em 0;font-size:12px;word-break:break-all',
              `${st.path} · ${formatBytes(st.bytes)}`,
            ),
          )
        }
        details.appendChild(statusBlock)
      }

      inventoryRow.appendChild(details)
    }
  }

  const refresh = async () => {
    if (!panel.isConnected) return
    try {
      const persist = await storagePersistStatus()
      const persistNote = !persist.supported
        ? ''
        : persist.persisted
          ? ' Persistent storage on.'
          : ' Persistent storage off (may evict under pressure).'
      const seedReady = readOfflinePackFlag()
      const bgLine = formatBgPackProgressLine()
      const neighborhoodIdle =
        !bgPackInflight.size &&
        ![...bgPackStatus.values()].some(st => st && st.phase !== 'done' && st.phase !== 'error')
      const seedLine = seedReady
        ? 'Shell/lineup seed ready.'
        : readPackPending()
          ? 'Seeding shell/lineup…'
          : 'Shell/lineup not seeded yet.'
      const inv = await inventoryOfflineBackup()
      const packLine = inv.totalBytes > 0 ? ` Cache ~${formatBytes(inv.totalBytes)}.` : ''
      const hoodLine = bgLine
        ? ` ${bgLine}`
        : neighborhoodIdle
          ? ' Neighborhood pack idle/done.'
          : ' Neighborhood packing…'
      status.textContent = `${seedLine}${packLine}${persistNote}${hoodLine}`
      renderLargeConsent()
      renderInventory(inv)
    } catch {
      status.textContent = 'Could not measure offline storage.'
    }
  }

  const exportBtn = panelBtn('Export offline backup (.zip)', async () => {
    setBusy(true)
    const prev = status.textContent
    status.textContent = 'Building .wiki-shaped zip…'
    try {
      const { files, sites } = await exportOfflineBackupZip()
      status.textContent = `Exported ${plural(files, 'file')} from ${plural(sites, 'site')}. ${prev || ''}`
    } catch (err) {
      status.textContent = `Export failed: ${err?.message || err}`
    } finally {
      setBusy(false)
    }
  })
  const refreshBtn = panelBtn('Refresh', async () => {
    setBusy(true)
    status.textContent = 'Measuring storage…'
    try {
      await refresh()
    } finally {
      setBusy(false)
    }
  })
  const flushBtn = panelBtn('Flush offline backup', async () => {
    if (!window.confirm('Flush the offline backup cache for this app?')) return
    setBusy(true)
    status.textContent = 'Flushing…'
    try {
      await flushOfflineBackup()
      await injectManifest({ force: true, quality: 'full' }).catch(() => {})
      await refresh()
      writePackPending(true)
      maybeStartStandalonePack()
      syncPwaCacheUi()
    } catch (err) {
      status.textContent = `Flush failed: ${err?.message || err}`
    } finally {
      setBusy(false)
    }
  })
  btnRow.append(refreshBtn, exportBtn, flushBtn)

  await refresh()
}

function syncPwaCacheUi() {
  if (typeof $ === 'undefined') return
  if (!isStandalone()) {
    removePwaCacheUi()
    return
  }

  document.querySelectorAll('.' + LOCAL_CHANGES_PANEL_CLASS).forEach(el => el.remove())

  const $local = findPagesBySlug('local-changes')
  document.querySelectorAll('.' + PWA_CACHE_LINK_CLASS).forEach(el => {
    if (!$local.toArray().some(p => p.contains(el))) el.remove()
  })
  $local.each(function () {
    if (this.querySelector('.' + PWA_CACHE_LINK_CLASS)) return
    renderLocalChangesPwaLink($(this))
  })

  const $cache = findPagesBySlug(PWA_CACHE_SLUG)
  document.querySelectorAll('.' + PWA_CACHE_PANEL_CLASS).forEach(el => {
    if (!$cache.toArray().some(p => p.contains(el))) el.remove()
  })
  $cache.each(function () {
    if (this.querySelector('.' + PWA_CACHE_PANEL_CLASS)) return
    renderPwaCachePanel($(this)).catch(err => console.warn('[PWA] cache panel', err))
  })
}

function watchLineupUi() {
  if (localChangesObserver || typeof MutationObserver === 'undefined') {
    syncPwaCacheUi()
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
      syncPwaCacheUi()
      if (isStandalone()) ensurePluginsFromOpenPages().catch(() => {})
    })
  })
  localChangesObserver.observe(root, { childList: true, subtree: true })
  syncPwaCacheUi()
}

window.addEventListener('appinstalled', () => {
  writePackPending(true)
  writeOfflinePackFlag(false)
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

if (isStandalone()) tellServiceWorkerLargeConsent(readLargeAssetConsent() === 'allow')
watchDisplayModeForPackUi()
maybeStartStandalonePack()

$(() => {
  if (isStandalone()) tellServiceWorkerLargeConsent(readLargeAssetConsent() === 'allow')
  if (isStandalone()) ensurePersistentStorage().catch(() => {})
  maybeStartStandalonePack()
  prepareInstallSurface()
  watchLineupUi()
  wireShareControls()
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
      syncFaviconIntoManifest().catch(() => {})
    }
  })

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (!isSecureInstallContext() || !navigator.onLine) return
    if (isStandalone()) syncFaviconIntoManifest().catch(() => {})
  })
})
