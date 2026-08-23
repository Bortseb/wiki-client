// This module manages the display of site flags representing
// fetched sitemaps stored in the neighborhood. It progresses
// through a series of states which, when attached to the flags,
// cause them to animate as an indication of work in progress.

const link = require('./link')
const wiki = require('./wiki')
const neighborhood = require('./neighborhood')
const util = require('./util')

let sites = null
let totalPages = 0

const hasLinks = element => Object.hasOwn(element, 'links')
const isMobile = () => window.matchMedia('(max-width: 490px)').matches
const ow = el => (el ? el.offsetWidth || 0 : 0)

// status class progression: .wait, .fetch, .fail or .done

const flag = site =>
  `\
<span class="neighbor" data-site="${site}" title="${site}" ${site != window.location.hostname ? 'draggable="true"' : ''}>
<div class="wait">
  <img src="${wiki.site(site).flag()}" title="${site}">
</div>
</span>\
`

const inject = neighborhood => (sites = neighborhood.sites)

// Assigned in bind(); search UI freezes one-row vs stacked while searching.
let requestLayout = () => {}
let freezeFooterStack = () => {}
let unfreezeFooterStack = () => {}

const formatNeighborTitle = function (site) {
  let pageCount
  let title = ''
  title += `${site}\n`
  try {
    pageCount = sites[site].sitemap.length
  } catch {
    pageCount = 0
  }
  try {
    if (sites[site].sitemap.some(hasLinks)) {
      title += `${pageCount} pages with 2-way links\n`
    } else {
      title += `${pageCount} pages\n`
    }
  } catch {
    console.info('+++ sitemap not valid for ', site)
  }
  if (sites[site].lastModified !== 0) {
    title += `Updated ${util.formatElapsedTime(sites[site].lastModified)}`
    if (sites[site].nextCheck - Date.now() > 0) {
      title += `, next refresh ${util.formatDelay(sites[site].nextCheck)}`
    }
  }
  return title
}

// evict a wiki from the neighborhood, from Eric Dobbs (via matrix)
const evict = site => {
  const flagEl = Array.from($('.neighbor')).find(n => n.dataset.site == site)
  if (!flagEl?.parentElement) {
    delete wiki.neighborhood[site]
    $('body').trigger('new-neighbor-done', site)
    return
  }
  flagEl.classList.remove('lifting', 'neighbor-slot-release')
  flagEl.style.transform = ''
  flagEl.parentElement.removeChild(flagEl)
  delete wiki.neighborhood[site]
  $('body').trigger('new-neighbor-done', site)
}

const bind = function () {
  setNeighborTitleFn(formatNeighborTitle)
  bindFlagTips()
  const hood = $('.neighborhood').get(0)
  const footer = document.querySelector('footer')

  // .footer-controls holds search/wiki. #site-owner/#security stay direct footer children
  // (stacked or not) so security plugins can use footer > #security.
  if (footer && hood && !footer.querySelector('.footer-controls')) {
    const box = document.createElement('span')
    box.className = 'footer-controls'
    for (const child of [...footer.children]) {
      if (child === hood) continue
      if (child.id === 'site-owner' || child.id === 'security') continue
      if (child.classList?.contains('footer-menu')) continue
      box.appendChild(child)
    }
    footer.insertBefore(box, hood)
  }
  const controls = footer?.querySelector('.footer-controls')
  const isChevron = el => el?.classList?.contains('neighborhood-chevron')
  const contentRow = () => footer?.querySelector(':scope > .footer-content-row')

  const placeMenuIn = (parent, before) => {
    // Mobile: ☰ is a direct footer child (grid col 1). Desktop: inside .footer-controls
    // ahead of the edit toggle so it stays with search/wiki chrome.
    const menu = footer?.querySelector('.footer-menu')
    if (!menu || !parent) return
    const wikiToggle = footer.querySelector('.wiki-edit-toggle')
    if (parent === controls && wikiToggle) {
      if (!controls.contains(wikiToggle)) controls.appendChild(wikiToggle)
      controls.insertBefore(menu, wikiToggle)
    } else if (before) {
      parent.insertBefore(menu, before)
    } else {
      parent.appendChild(menu)
    }
  }

  // Stacked layout uses footer flex-wrap + neighborhood at 100% width.
  // Keep #site-owner / #security as direct footer children so security plugins
  // (friends/social/passport) can use $('footer > #security') when repainting the padlock.
  const syncOwnerTitle = () => {
    // Full name on hover when stacked layout ellipsizes a long display name.
    const owner = footer?.querySelector(':scope > #site-owner')
    if (!owner) return
    const text = (owner.textContent || '').replace(/\s+/g, ' ').trim()
    if (text) owner.setAttribute('title', text)
    else owner.removeAttribute('title')
  }

  const syncContentRow = () => {
    if (!footer || !hood) return
    const row = contentRow()
    const owner = footer.querySelector('#site-owner')
    const security = footer.querySelector('#security')
    // insertBefore on the search field's ancestors blurs a focused input — remember
    // and restore so desktop incremental search doesn't die after the first hit.
    const keepSearch =
      document.activeElement?.matches?.('input.search') && footer.contains(document.activeElement)
        ? document.activeElement
        : null

    // Unwrap any legacy .footer-content-row from older clients / prior layouts.
    if (row) {
      while (row.firstChild) footer.insertBefore(row.firstChild, row)
      row.remove()
    }

    // Stable order before the neighborhood: owner → security → controls.
    const anchor = hood
    if (controls && controls.parentElement === footer) footer.insertBefore(controls, anchor)
    if (security) footer.insertBefore(security, controls || anchor)
    if (owner) footer.insertBefore(owner, security || controls || anchor)

    if (isMobile()) placeMenuIn(footer, owner || controls || hood)
    else placeMenuIn(controls)

    syncOwnerTitle()

    if (keepSearch && document.activeElement !== keepSearch) {
      try {
        keepSearch.focus({ preventScroll: true })
      } catch (_) {
        keepSearch.focus()
      }
    }
  }

  // Transform pan: DOM [newest … origin], userScroll 0 = origin flush right.
  // followOrigin snaps back when the origin is fully visible so new neighbors
  // still appear at the right edge without fighting a manual pan.
  let chevronLeft = footer?.querySelector('.neighborhood-chevron-left')
  let chevronRight = footer?.querySelector('.neighborhood-chevron-right')
  let track = hood?.querySelector(':scope > .neighborhood-track')
  if (hood && !track) {
    track = document.createElement('span')
    track.className = 'neighborhood-track'
    while (hood.firstChild) track.appendChild(hood.firstChild)
    hood.appendChild(track)
  }

  let followOrigin = true
  let userScroll = 0

  // Intrinsic width of flag slots only — never use track.scrollWidth.
  // When the neighborhood is stacked it is 100% wide; scrollWidth can inflate to the
  // full row and permanently trap the footer in two-row mode. Abspos ::after hit
  // targets can also inflate scrollWidth.
  const flagWidth = () => {
    if (!track) return 0
    let sum = 0
    for (const n of track.querySelectorAll(':scope > .neighbor')) {
      if (n.classList.contains('neighbor-slot-release')) continue
      sum += n.offsetWidth || 0
    }
    return sum
  }
  const neighborhoodChrome = () => {
    if (!hood) return 0
    const s = getComputedStyle(hood)
    return (parseFloat(s.paddingLeft) || 0) + (parseFloat(s.paddingRight) || 0)
  }
  const maxScroll = () => {
    if (!hood || !track) return 0
    return Math.max(0, flagWidth() - Math.max(0, hood.clientWidth - neighborhoodChrome()))
  }

  const applyTrack = () => {
    if (!hood || !track) return
    const max = maxScroll()
    const overflow = max > 1
    hood.classList.toggle('overflowing', overflow)
    if (followOrigin) userScroll = 0
    userScroll = Math.max(0, Math.min(max, userScroll))
    track.style.transform = overflow ? `translateX(${userScroll - max}px)` : ''
  }

  const originFullyVisible = () => maxScroll() <= 1 || userScroll <= 1

  const scrollNeighborhood = towardLeft => {
    const max = maxScroll()
    if (max <= 1) return
    const step = Math.max(64, Math.floor(hood.clientWidth * 0.7))
    let next = userScroll + (towardLeft ? step : -step)
    if (next <= step * 0.5) next = 0
    else if (next >= max - step * 0.5) next = max
    userScroll = Math.max(0, Math.min(max, next))
    applyTrack()
  }

  if (footer && hood && (!chevronLeft || !chevronRight)) {
    const makeChevron = (side, label, glyph) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = `neighborhood-chevron neighborhood-chevron-${side}`
      btn.setAttribute('aria-label', label)
      btn.textContent = glyph
      btn.hidden = true
      btn.addEventListener('click', e => {
        e.preventDefault()
        e.stopPropagation()
        if (side === 'left') followOrigin = false
        scrollNeighborhood(side === 'left')
        followOrigin = originFullyVisible()
        syncChevrons()
      })
      footer.appendChild(btn)
      return btn
    }
    chevronLeft = makeChevron('left', 'Scroll neighborhood left', '‹')
    chevronRight = makeChevron('right', 'Scroll neighborhood right', '›')
  }

  const syncChevrons = () => {
    if (!footer || !hood || !chevronLeft || !chevronRight) return
    const stacked = footer.classList.contains('neighborhood-above')
    // Desktop stacked only — mobile uses finger pan on the track (no chevron chrome).
    const active = !isMobile() && stacked && (maxScroll() > 1 || flagWidth() > hood.clientWidth + 1)
    hood.classList.toggle('scrollable', active)
    applyTrack()
    if (!active) {
      chevronLeft.hidden = chevronRight.hidden = true
      return
    }

    // Absolute top is relative to footer's padding edge; getBoundingClientRect is the
    // border box — subtract border so chevrons line up with the flag images.
    // Prefer the origin flag's layout box (not a rotating .wait/.fetch transform AABB).
    // Use the .neighbor span with a fixed 16px height — measuring img under rotate jitters,
    // and a taller line-box on .neighbor sat the chevron too high.
    const fr = footer.getBoundingClientRect()
    const box = hood.getBoundingClientRect()
    const originHost = window.location.hostname
    const originNeighbor =
      track?.querySelector(`.neighbor[data-site="${originHost}"]`) || track?.querySelector('.neighbor')
    const flagRect = originNeighbor?.getBoundingClientRect()
    const borderTop = parseFloat(getComputedStyle(footer).borderTopWidth) || 0
    const heightPx = 16 // matches .neighbor img / CSS height
    const topPx = flagRect
      ? Math.round(flagRect.top - fr.top - borderTop)
      : Math.round(box.top - fr.top - borderTop + (box.height - heightPx) / 2)
    const top = `${topPx}px`
    const height = `${heightPx}px`
    Object.assign(chevronLeft.style, { top, height, left: `${Math.round(box.left - fr.left)}px` })
    Object.assign(chevronRight.style, { top, height, right: `${Math.round(fr.right - box.right)}px` })

    const max = maxScroll()
    const moreLeft = userScroll < max - 2
    const moreRight = userScroll > 2
    chevronLeft.hidden = !moreLeft
    chevronRight.hidden = !moreRight
    chevronLeft.tabIndex = moreLeft ? 0 : -1
    chevronRight.tabIndex = moreRight ? 0 : -1
  }

  const normalizeFlagOrder = () => {
    // Origin must be last in the track so translateX packing keeps it flush-right
    // when followOrigin is on (newest flags grow leftward).
    if (!track) return
    const originHost = window.location.hostname
    const origin = track.querySelector(`.neighbor[data-site="${originHost}"]`)
    const flags = [...track.querySelectorAll('.neighbor')]
    if (!origin || flags.length < 2 || track.lastElementChild === origin) return
    if (flags[0] === origin) {
      for (const n of flags.slice(1).reverse()) track.appendChild(n)
    }
    track.appendChild(origin)
  }

  const pagesEl = () => controls?.querySelector('.pages')
  // Page count: prefer "pages"; "pgs" is mobile-only when that keeps one row.
  // Desktop always stays "N pages". When stacked, always show full "pages".
  const renderPagesLabel = (short = false) => {
    const el = pagesEl()
    if (!el) return
    if (isMobile()) {
      el.innerHTML = `<span>${totalPages}</span><span>${short ? 'pgs' : 'pages'}</span>`
    } else {
      el.textContent = `${totalPages} ${short ? 'pgs' : 'pages'}`
    }
    footer?.classList.toggle('footer-pages-abbrev', !!short)
  }

  // Returns { width, numberW, unitW }. On mobile, width is max(number, unit).
  const measurePagesMetrics = short => {
    const el = pagesEl()
    if (!el) return { width: 0, numberW: 0, unitW: 0 }
    renderPagesLabel(short)
    if (isMobile()) {
      const lines = el.querySelectorAll(':scope > span')
      if (lines.length >= 2) {
        const numberW = lines[0].offsetWidth || 0
        const unitW = lines[1].offsetWidth || 0
        return { width: Math.max(numberW, unitW), numberW, unitW }
      }
    }
    const width = Math.max(el.scrollWidth || 0, ow(el))
    return { width, numberW: 0, unitW: 0 }
  }

  const marginX = el => {
    if (!el) return 0
    const s = getComputedStyle(el)
    return (parseFloat(s.marginLeft) || 0) + (parseFloat(s.marginRight) || 0)
  }

  // Prefer scrollWidth so flex-shrink from the current stack state cannot change "needed".
  const iw = el => (el ? Math.max(el.scrollWidth || 0, el.offsetWidth || 0) : 0)

  // Controls chrome width excluding the search field (pages, edit, gaps, …).
  const controlsExSearchWidth = () => {
    if (!controls) return 0
    const search = controls.querySelector('input.search')
    const kids = [...controls.children]
    let total = 0
    let n = 0
    for (const piece of kids) {
      n += 1
      if (search && piece.contains?.(search)) {
        const gap = parseFloat(getComputedStyle(piece).gap) || 4
        let inner = 0
        let parts = 0
        for (const child of piece.children) {
          // Results overlay lives in .searchbox for a11y/hit-testing on some
          // paths — never count it in chrome width or search will collapse.
          if (
            child.classList?.contains('search-field') ||
            child.classList?.contains('incremental-search') ||
            child === search
          ) {
            continue
          }
          inner += iw(child) + marginX(child)
          parts += 1
        }
        total += inner + gap * Math.max(0, parts) + marginX(piece)
      } else {
        total += iw(piece) + marginX(piece)
      }
    }
    const cg = parseFloat(getComputedStyle(controls).gap) || 0
    total += cg * Math.max(0, n - 1)
    return total
  }

  // Full display-name width via canvas — overflow:hidden/ellipsis makes scrollWidth
  // unreliable and was letting search steal space from the name.
  const measureOwnerWidth = ownerEl => {
    if (!ownerEl) return 0
    const nameEl = ownerEl.querySelector(':scope > #site-owner, :scope > span')
    const canvas = measureOwnerWidth._canvas || (measureOwnerWidth._canvas = document.createElement('canvas'))
    const ctx = canvas.getContext('2d')
    if (!ctx) return (nameEl?.scrollWidth || ownerEl.scrollWidth || 0) + marginX(ownerEl)

    const measure = (text, el) => {
      const t = `${text || ''}`.replace(/\s+/g, ' ').trim()
      if (!t) return 0
      const cs = getComputedStyle(el || ownerEl)
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`.trim()
      return ctx.measureText(t).width
    }

    // Mobile stacks "Wiki by:" above the name — width is the wider line.
    // Desktop is one line: must measure the full "Wiki by: …" string.
    const stackedLabel = getComputedStyle(ownerEl).flexDirection === 'column'
    let textW
    if (stackedLabel && nameEl) {
      textW = Math.max(measure('Wiki by:', ownerEl), measure(nameEl.textContent, nameEl))
    } else {
      textW = measure(ownerEl.textContent, nameEl || ownerEl)
    }
    return textW + marginX(ownerEl)
  }

  // Desktop stacked / mobile: reserve full name first, then shrink search to the
  // icon floor, then allow the owner column to ellipsis.
  const syncFooterSearchWidth = (stacked, mobile, available, em, flagsW) => {
    if (!footer) return
    if (!mobile && !stacked) {
      footer.style.removeProperty('--footer-search-width')
      footer.classList.remove('footer-search-shrunk', 'footer-chrome-tight')
      return
    }
    const floor = 2.75 * em
    // Mobile stays at the icon floor while typing (text scrolls in the field).
    // Desktop prefers 10em and shrinks toward the floor before owner ellipsis.
    const preferred = mobile ? Number.POSITIVE_INFINITY : 10 * em
    const typingMin = floor
    const chromeAvail = stacked ? available : Math.max(0, available - (flagsW || 0))
    const menuEl = mobile ? footer.querySelector('.footer-menu') : null
    const ownerEl = footer.querySelector(':scope > #site-owner')
    const securityEl = footer.querySelector(':scope > #security')
    const rowItems = [menuEl, ownerEl, securityEl, controls].filter(Boolean)
    const gap = (mobile ? 2 : 0) * Math.max(0, rowItems.length - 1)
    const ownerW = measureOwnerWidth(ownerEl)
    const reservedOwner = ownerW
    let usedExOwner = gap + controlsExSearchWidth()
    for (const el of rowItems) {
      if (el === controls || el === ownerEl) continue
      usedExOwner += iw(el) + marginX(el)
    }
    const roomForPair = chromeAvail - usedExOwner - 4
    const width = Math.max(typingMin, Math.min(preferred, roomForPair - reservedOwner))
    const rounded = Math.round(width * 100) / 100
    const prev = parseFloat(footer.style.getPropertyValue('--footer-search-width'))
    if (!(prev >= 0) || Math.abs(prev - rounded) >= 0.5) {
      footer.style.setProperty('--footer-search-width', `${rounded}px`)
    }
    footer.classList.add('footer-search-shrunk')
    // Owner may ellipsis after search hits the idle icon floor.
    footer.classList.toggle('footer-chrome-tight', rounded <= floor + 0.5)

    const input = controls?.querySelector('input.search')
    if (input) {
      const fullPh = '🔍 Search'
      const iconPh = '🔍'
      const cs = getComputedStyle(input)
      const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
      const canvas = syncFooterSearchWidth._canvas || (syncFooterSearchWidth._canvas = document.createElement('canvas'))
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`.trim()
        const ph = ctx.measureText(fullPh).width + pad + 2 <= rounded ? fullPh : iconPh
        if (input.getAttribute('placeholder') !== ph) input.setAttribute('placeholder', ph)
      }
    }
  }

  // Width needed for site controls on one row with flags. Must not depend on stacked vs
  // unstacked layout — a state-dependent measurement causes stack/unstack flicker.
  const footerContentWidth = (pagesW, searchW) => {
    if (!footer || !controls) return 0
    const search = controls.querySelector('input.search')
    // Always measure the logical control pieces (not .footer-content-row children), so
    // wrapping into a content row cannot shrink the "needed" width and flip the decision.
    const pieces = isMobile()
      ? [footer.querySelector('.footer-menu'), footer.querySelector('#site-owner'), footer.querySelector('#security'), controls]
      : [footer.querySelector('#site-owner'), footer.querySelector('#security'), controls]

    let total = 0
    let n = 0
    for (const child of pieces.filter(Boolean)) {
      n += 1
      if (child === controls) {
        for (const piece of controls.children) {
          if (piece.classList?.contains('incremental-search')) continue
          if (search && piece.contains?.(search)) {
            total += searchW + pagesW + (parseFloat(getComputedStyle(piece).gap) || 4) + marginX(piece)
          } else {
            total += iw(piece) + marginX(piece)
          }
        }
      } else {
        total += iw(child) + marginX(child)
      }
    }
    // Use a fixed gap assumption (not live columnGap) so stacking CSS cannot change needed.
    const gap = isMobile() ? 2 : 0
    return total + gap * Math.max(0, n - 1)
  }

  // Same stack/unstack threshold both ways — asymmetric hysteresis made the
  // neighborhood stay two-row until the window was wider than when it stacked.
  const STACK_SLACK = 0.5

  // Ignore ResizeObserver/MutationObserver callbacks caused by our own layout writes.
  let layoutGuard = false
  let layoutFrame = null
  let layoutNeedsRetry = false
  // While mobile search is open, keep pre-search stack mode and search width.
  // Desktop overlay mounts on <body> and must not freeze stack/unstack.
  let searchStackFreeze = null

  const layout = () => {
    if (!footer || !hood || !controls) return
    normalizeFlagOrder()

    const row = contentRow()
    for (const child of [...footer.children]) {
      if (child === hood || child === controls || child === row) continue
      if (child.id === 'site-owner' || child.id === 'security') continue
      if (child.classList?.contains('footer-menu') || child.classList?.contains('footer-content-row')) continue
      // Results belong on <body>; never sweep a stray overlay into .footer-controls
      // (that would inflate "needed" width and trap stacked mode).
      if (child.classList?.contains('incremental-search')) continue
      if (isChevron(child)) continue
      controls.appendChild(child)
    }
    // Legacy: older builds parked the overlay under .footer-controls — lift to body.
    const trappedOverlay = controls.querySelector('.incremental-search')
    if (trappedOverlay) document.body.appendChild(trappedOverlay)

    if (searchStackFreeze != null) {
      layoutGuard = true
      try {
        footer.classList.toggle('neighborhood-above', searchStackFreeze.stacked)
        // Restore snapshotted width — do not recompute (that shrinks mid-search).
        if (searchStackFreeze.widthCss) {
          footer.style.setProperty('--footer-search-width', searchStackFreeze.widthCss)
        } else {
          footer.style.removeProperty('--footer-search-width')
        }
        footer.classList.toggle('footer-search-shrunk', searchStackFreeze.shrunk)
        footer.classList.toggle('footer-chrome-tight', searchStackFreeze.tight)
        document.documentElement.style.setProperty('--footer-height', `${footer.offsetHeight}px`)
        syncChevrons()
      } finally {
        requestAnimationFrame(() => {
          layoutGuard = false
          if (layoutNeedsRetry) {
            layoutNeedsRetry = false
            scheduleLayout()
          }
        })
      }
      return
    }

    const styles = getComputedStyle(footer)
    const available =
      footer.clientWidth - ((parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0))
    const search = controls.querySelector('input.search')
    const mobile = isMobile()
    const em = parseFloat(getComputedStyle(search || footer).fontSize) || (mobile ? 16 : 14)
    // Fit math uses preferred 10em so we stack flags instead of crushing
    // search to the icon floor on one row. Search may shrink only after stack
    // (syncFooterSearchWidth) to keep owner + wiki ✔︎ visible.
    const searchW = 10 * em
    const flagsW = flagWidth() + neighborhoodChrome()

    // Prefer full "pages". On mobile only, abbreviate to "pgs" if that keeps one row;
    // otherwise stack and keep "pages". Desktop never uses "pgs".
    const fullMetrics = measurePagesMetrics(false)
    const shortMetrics = mobile ? measurePagesMetrics(true) : fullMetrics
    const pagesW = fullMetrics.width
    const pgsW = shortMetrics.width
    const neededFull = footerContentWidth(pagesW, searchW) + flagsW
    const neededShort = footerContentWidth(pgsW, searchW) + flagsW
    const savings = pagesW - pgsW
    // If the digit run is already as wide as "pages", "pgs" cannot free enough
    // space to keep one row — skip the abbreviate path and stack instead.
    const digitsDominate =
      mobile && fullMetrics.numberW > 0 && fullMetrics.numberW + 0.5 >= fullMetrics.unitW
    // Mobile-only escape hatch — never abbreviate on desktop. Require ≥6px saved
    // so tiny wins don't flicker pages↔pgs at the one-row boundary.
    const shortHelps = mobile && !digitsDominate && savings >= 6
    // Identical threshold for stack and unstack (no directional hysteresis).
    const room = available + STACK_SLACK

    let stacked = false
    let useShortPages = false
    if (neededFull <= room) {
      stacked = false
      useShortPages = false
    } else if (shortHelps && neededShort <= room) {
      stacked = false
      useShortPages = true
    } else {
      stacked = true
      useShortPages = false
    }

    layoutGuard = true
    try {
      renderPagesLabel(useShortPages)
      footer.classList.toggle('neighborhood-above', stacked)
      syncContentRow()
      syncFooterSearchWidth(stacked, mobile, available, em, flagsW)
      // Safety: if flex still crushed the search field, force a stacked footer.
      if (mobile && !stacked && search && search.getBoundingClientRect().width < 24) {
        stacked = true
        useShortPages = false
        renderPagesLabel(false)
        footer.classList.add('neighborhood-above')
        syncContentRow()
        syncFooterSearchWidth(stacked, mobile, available, em, flagsW)
      }
      document.documentElement.style.setProperty('--footer-height', `${footer.offsetHeight}px`)
      // Drives .main { height: calc(100svh - var(--footer-height)) } so stacked
      // flag rows don't cover the bottom of the page lineup.
      syncChevrons()
      syncOwnerTitle()
      // Let floating search UI re-pin after stack/unstack without living in the footer DOM.
      document.dispatchEvent(new CustomEvent('wiki:footer-layout'))
    } finally {
      requestAnimationFrame(() => {
        layoutGuard = false
        if (layoutNeedsRetry) {
          layoutNeedsRetry = false
          scheduleLayout()
        }
      })
    }
  }

  const scheduleLayout = () => {
    if (layoutGuard) {
      // Evict/lift while a layout is committing — run again after the guard lifts.
      layoutNeedsRetry = true
      return
    }
    if (layoutFrame != null) return
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = null
      layout()
    })
  }

  $('body')
    .on('new-neighbor', (e, site) => {
      if (!track) return
      const node = $(flag(site)).get(0)
      const originHost = window.location.hostname
      if (site === originHost || !track.querySelector(`.neighbor[data-site="${originHost}"]`)) {
        track.appendChild(node)
      } else {
        track.insertBefore(node, track.firstChild)
      }
      if (originHost != site) {
        node.addEventListener('dragstart', neighbor_dragstart)
        node.addEventListener('dragend', neighbor_dragend)
      }
      scheduleLayout()
    })
    .on('new-neighbor-done', () => {
      totalPages = Object.values(neighborhood.sites).reduce(function (sum, site) {
        try {
          return site.sitemapRequestInflight ? sum : sum + site.sitemap.length
        } catch {
          return sum
        }
      }, 0)
      // Flag set / page totals changed — re-check pages vs pgs and one-row fit.
      scheduleLayout()
    })
    // pointerenter: enrich title for stylus hover (flagTip) as well as mouse.
    .on('mouseenter pointerenter', '.neighbor', function (e) {
      const $neighbor = $(e.currentTarget)
      const { site } = $neighbor.data()
      const title = formatNeighborTitle(site)
      $neighbor.attr('title', title)
      $neighbor.find('img:first').attr('title', title)
    })
    .on('click', '.neighbor', function (e) {
      if (suppressClick) return
      // Prefer data-site: title is only enriched on mouseenter (unreliable on touch),
      // and may be a multi-line tooltip after hover.
      const $neighbor = $(e.currentTarget)
      const $status = $neighbor.children('div').first()
      const site = $neighbor.data('site') || (`${$neighbor.find('img').attr('title') || ''}`).split('\n')[0]
      if (!site) return
      // Whole flag hit-area is tappable (img has pointer-events:none on mobile).
      if ($status.hasClass('fail')) {
        e.preventDefault()
        e.stopPropagation()
        $status.removeClass('fail done fetch').addClass('wait')
        const retry = () => {
          console.log('about to retry neighbor', site)
          neighborhood.retryNeighbor(site)
        }
        // Origin adapter has no refresh(); remote adapters use it to reset sitePrefix.
        const adapter = wiki.site(site)
        if (typeof adapter.refresh === 'function') {
          adapter.refresh(retry)
        } else {
          retry()
        }
      } else {
        link.doInternalLink('welcome-visitors', null, site)
      }
    })

  // Desktop: HTML5 drag. Touch: hold for tip, pan to scroll, or lift to remove.
  // AXIS = deadzone before a move counts as pan (vs tap). LIFT = px up to start
  // remove. HOLD_MS = long-press for the flag tip. suppressClick blocks the
  // synthetic click that would open welcome-visitors right after a tip/lift.
  const AXIS = 8
  const LIFT = 28
  const HOLD_MS = 480
  let gesture = null
  let suppressClick = false

  const clearLift = neighbor => {
    if (!neighbor) return
    neighbor.classList.remove('lifting', 'neighbor-slot-release')
    neighbor.style.transform = ''
  }

  const setLiftSlotCollapsed = (neighbor, collapsed) => {
    if (!neighbor) return
    const on = !!collapsed
    if (neighbor.classList.contains('neighbor-slot-release') === on) return
    neighbor.classList.toggle('neighbor-slot-release', on)
    // Re-fit footer (pages↔pgs / one-row) as the neighborhood slot frees up mid-gesture.
    scheduleLayout()
  }

  const clearHold = g => {
    if (g?.holdTimer) {
      clearTimeout(g.holdTimer)
      g.holdTimer = null
    }
  }

  const showNeighborTip = neighbor => {
    const site = neighbor?.dataset?.site
    if (!site) return
    const title = formatNeighborTitle(site)
    neighbor.querySelector('img')?.setAttribute('title', title)
    showFlagTip(neighbor, title)
    suppressClick = true
  }

  if (hood) {
    hood.addEventListener(
      'pointerdown',
      e => {
        if (e.pointerType === 'mouse') return
        const neighbor = e.target.closest('.neighbor')
        if (!neighbor) return
        const isOrigin = neighbor.dataset.site === window.location.hostname
        gesture = {
          id: e.pointerId,
          neighbor,
          x0: e.clientX,
          y0: e.clientY,
          scroll0: userScroll,
          mode: null,
          isOrigin,
          tipShown: false,
          holdTimer: setTimeout(() => {
            if (!gesture || gesture.id !== e.pointerId || gesture.mode) return
            gesture.tipShown = true
            showNeighborTip(neighbor)
          }, HOLD_MS),
        }
        // Capture so hold/move/end stay reliable even if the finger drifts.
        neighbor.setPointerCapture?.(e.pointerId)
      },
      { passive: true },
    )
    hood.addEventListener(
      'pointermove',
      e => {
        if (!gesture || e.pointerId !== gesture.id) return
        const dx = e.clientX - gesture.x0
        const dy = e.clientY - gesture.y0
        if (!gesture.mode) {
          if (Math.abs(dx) < AXIS && Math.abs(dy) < AXIS) return
          clearHold(gesture)
          // Origin: movement cancels tip hold; no pan/lift from origin flag.
          if (gesture.isOrigin) {
            gesture = null
            return
          }
          gesture.mode = dy < 0 && Math.abs(dy) > Math.abs(dx) ? 'lift' : 'pan'
          if (gesture.mode === 'lift') gesture.neighbor.classList.add('lifting')
        }
        if (gesture.mode === 'pan') {
          followOrigin = false
          userScroll = gesture.scroll0 + dx
          applyTrack()
          syncChevrons()
          setLiftSlotCollapsed(gesture.neighbor, false)
        } else {
          gesture.neighbor.style.transform = `translateY(${Math.min(0, dy)}px)`
          // Once past the remove threshold, free the slot so the footer can re-fit live.
          setLiftSlotCollapsed(gesture.neighbor, -dy >= LIFT)
        }
        e.preventDefault()
      },
      { passive: false },
    )
    const endGesture = e => {
      if (!gesture || (e && e.pointerId !== gesture.id)) return
      const { neighbor, mode, y0, tipShown, isOrigin } = gesture
      clearHold(gesture)
      const dy = (e?.clientY ?? gesture.y0) - y0
      const shouldEvict = !isOrigin && mode === 'lift' && -dy >= LIFT
      if (mode || tipShown) suppressClick = true
      if (shouldEvict) {
        hideFlagTip()
        console.log(`*** Removing ${neighbor.dataset.site} from neighborhood.`)
        evict(neighbor.dataset.site)
      } else {
        clearLift(neighbor)
      }
      gesture = null
      followOrigin = originFullyVisible()
      scheduleLayout()
      // Mobile click can arrive well after pointerup; keep suppress briefly.
      setTimeout(() => {
        suppressClick = false
      }, mode || tipShown ? 400 : 0)
    }
    hood.addEventListener('pointerup', endGesture)
    hood.addEventListener('pointercancel', endGesture)
    hood.addEventListener(
      'wheel',
      e => {
        if ((Math.abs(e.deltaX) <= Math.abs(e.deltaY) && !e.shiftKey) || maxScroll() <= 1) return
        e.preventDefault()
        followOrigin = false
        userScroll += e.shiftKey && Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX
        applyTrack()
        followOrigin = originFullyVisible()
        syncChevrons()
      },
      { passive: false },
    )
  }

  const neighbor_dragstart = event => {
    document.querySelector('.main').addEventListener('drop', neighbor_drop)
    event.dataTransfer.setData('text/plain', event.target.closest('span').dataset.site)
  }
  const neighbor_dragend = () => {
    document.querySelector('.main').removeEventListener('drop', neighbor_drop)
    scheduleLayout()
  }
  const neighbor_drop = event => {
    event.stopPropagation()
    event.preventDefault()
    const toRemove = event.dataTransfer.getData('text/plain')
    if (window.location.hostname != toRemove) {
      console.log(`*** Removing ${toRemove} from neighborhood.`)
      evict(toRemove)
    } else {
      console.log("*** Origin wiki can't be removed.")
    }
    return false
  }

  // Width-only: stacking changes footer height (and --footer-height); re-layout on
  // that feedback is what flips one-row ↔ stacked at the boundary.
  let lastFooterWidth = footer ? Math.round(footer.getBoundingClientRect().width) : -1
  if (footer && typeof ResizeObserver === 'function') {
    new ResizeObserver(entries => {
      if (layoutGuard) return
      const w = Math.round(entries[0].contentRect.width)
      if (w === lastFooterWidth) return
      lastFooterWidth = w
      scheduleLayout()
    }).observe(footer)
  }
  if (footer && typeof MutationObserver === 'function') {
    const isSearchUiNoise = node => {
      const el = node?.nodeType === 1 ? node : node?.parentElement
      if (!el?.closest) return false
      return !!(
        el.closest('.incremental-search') ||
        el.closest('.search-clear') ||
        el.classList?.contains('incremental-search')
      )
    }
    new MutationObserver(mutations => {
      if (layoutGuard) return
      // Relayout while typing blurs input.search (insertBefore on footer controls).
      if (document.activeElement?.matches?.('input.search')) return
      const needsLayout = mutations.some(m => {
        if (isChevron(m.target) || m.target?.closest?.('.neighborhood-chevron')) return false
        if (isSearchUiNoise(m.target)) return false
        if (m.type === 'childList') {
          const nodes = [...m.addedNodes, ...m.removedNodes].filter(n => n.nodeType === 1)
          if (
            nodes.length &&
            nodes.every(
              n => n.classList?.contains('incremental-search') || isSearchUiNoise(n),
            )
          ) {
            return false
          }
        }
        return true
      })
      if (needsLayout) scheduleLayout()
    }).observe(footer, { childList: true, subtree: true })
  }
  window.addEventListener('resize', scheduleLayout)
  requestLayout = scheduleLayout
  freezeFooterStack = () => {
    if (searchStackFreeze != null) return
    // Snapshot stack + search width so resize mid-search cannot shrink the field.
    searchStackFreeze = {
      stacked: !!(footer && footer.classList.contains('neighborhood-above')),
      widthCss: footer?.style.getPropertyValue('--footer-search-width') || '',
      shrunk: !!(footer && footer.classList.contains('footer-search-shrunk')),
      tight: !!(footer && footer.classList.contains('footer-chrome-tight')),
    }
  }
  unfreezeFooterStack = () => {
    if (searchStackFreeze == null) return
    const snap = searchStackFreeze
    searchStackFreeze = null
    if (footer) {
      footer.classList.toggle('neighborhood-above', snap.stacked)
      if (snap.widthCss) footer.style.setProperty('--footer-search-width', snap.widthCss)
      else footer.style.removeProperty('--footer-search-width')
      footer.classList.toggle('footer-search-shrunk', snap.shrunk)
      footer.classList.toggle('footer-chrome-tight', snap.tight)
      syncContentRow()
    }
    scheduleLayout()
  }
  scheduleLayout()
}


// --- flag tips (was flagTip.js) ---

// Title tips for stylus hover and touch long-press.
//
// The S Pen "blue squiggle" is Chrome's text cursor on hover — we cannot read
// the icon, but it means hover hit-testing is live. Those events are often
// pointerType "mouse", not "pen". Custom .wiki-flag-tip is used when native
// title= is unreliable: any pointerType "pen" (all stylus platforms), and on
// phones/tablets any hovering pointer (S Pen-as-mouse). Desktop mouse keeps
// native title=. Do not poll CSS :hover (sticky after tap/drag). Long-press
// tips must not be dismissed by finger-down pointermove.

const FLAG_TIP_HOLD_MS = 480
const FLAG_TIP_MOVE_PX = 8

let tipEl = null
let hideTimer = null
let press = null
let hoverAnchor = null
let neighborTitleFn = null
let suppressHoverUntil = 0
let titleStash = []

const setNeighborTitleFn = fn => {
  neighborTitleFn = typeof fn === 'function' ? fn : null
}

const isTouchPointer = e => e.pointerType === 'touch' || e.pointerType === 'pen'

const isPhoneOrTablet = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '')

const uiBusy = () =>
  document.body.classList.contains('wiki-page-lineup-shrunk') ||
  document.body.classList.contains('wiki-journal-merging') ||
  !!document.querySelector('.wiki-item-drag, .sortable-fallback')

const restoreNativeTitles = () => {
  for (const { el, title } of titleStash) {
    if (el) el.setAttribute('title', title)
  }
  titleStash = []
}

const suppressNativeTitle = anchor => {
  restoreNativeTitles()
  const stash = el => {
    if (!el?.hasAttribute?.('title')) return
    titleStash.push({ el, title: el.getAttribute('title') })
    el.removeAttribute('title')
  }
  if (!anchor) return
  stash(anchor)
  if (anchor.classList?.contains('favicon')) stash(anchor.closest('h1'))
  if (anchor.classList?.contains('neighbor')) stash(anchor.querySelector('img'))
  if (anchor.tagName === 'IMG') stash(anchor.closest('h1'))
}

const hideFlagTip = () => {
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
  if (tipEl) {
    tipEl.remove()
    tipEl = null
  }
  restoreNativeTitles()
  hoverAnchor = null
}

const position = (tip, anchor) => {
  const r = anchor.getBoundingClientRect()
  const tw = tip.offsetWidth
  const th = tip.offsetHeight
  let left = r.left + r.width / 2 - tw / 2
  let top = r.top - th - 8
  if (top < 8) top = r.bottom + 8
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8))
  tip.style.left = `${Math.round(left)}px`
  tip.style.top = `${Math.round(top)}px`
}

const showFlagTip = (anchor, text, opts = {}) => {
  hideFlagTip()
  const body = `${text || ''}`.trim()
  if (!anchor || !body) return
  tipEl = document.createElement('div')
  tipEl.className = 'wiki-flag-tip'
  tipEl.setAttribute('role', 'tooltip')
  tipEl.textContent = body
  document.body.appendChild(tipEl)
  position(tipEl, anchor)
  if (opts.suppressNativeTitle) suppressNativeTitle(anchor)
  if (opts.sticky) {
    hoverAnchor = anchor
  } else {
    hideTimer = setTimeout(hideFlagTip, 4000)
  }
}

const titleFor = el => {
  if (!el) return ''
  const neighbor = el.classList?.contains('neighbor') ? el : el.closest?.('.neighbor')
  if (neighbor?.dataset?.site) {
    if (neighborTitleFn) return neighborTitleFn(neighbor.dataset.site)
    return neighbor.dataset.site
  }
  if (el.classList?.contains('favicon')) {
    return el.closest('h1')?.getAttribute('title') || el.getAttribute('title') || ''
  }
  return el.getAttribute('title') || el.dataset?.site || ''
}

const tippableFrom = node => {
  let el = node?.nodeType === 1 ? node : node?.parentElement
  while (el && el !== document.body && el !== document.documentElement) {
    if (el.classList?.contains('wiki-flag-tip')) {
      el = el.parentElement
      continue
    }
    if (el.matches?.('input, textarea, [contenteditable], [contenteditable="true"]')) {
      return null
    }
    if (el.matches?.('img.remote, img.favicon, .neighbor, .action')) return el
    const t = el.getAttribute?.('title')
    if (t != null && `${t}`.trim()) return el
    el = el.parentElement
  }
  return null
}

const endPenHover = () => {
  // Only dismiss stylus-hover tips. Long-press tips (no hoverAnchor) must
  // survive finger-down pointermove — non-origin flags jitter after the hold.
  if (!hoverAnchor) return
  hideFlagTip()
}

// Custom tip: every stylus (pointerType pen), and phone/tablet hover that
// Chrome labels as mouse (Samsung S Pen). Desktop mouse → native title=.
const wantsCustomHover = e => {
  if (e.pointerType === 'pen') return true
  if (isPhoneOrTablet() && e.pointerType !== 'touch') return true
  return false
}

const updatePenHover = e => {
  if (uiBusy() || (e.buttons || 0) !== 0 || Date.now() < suppressHoverUntil) {
    endPenHover()
    return
  }
  if (!wantsCustomHover(e)) return
  const under = document.elementFromPoint(e.clientX, e.clientY) || e.target
  if (hoverAnchor && tipEl && (hoverAnchor === under || hoverAnchor.contains?.(under))) {
    position(tipEl, hoverAnchor)
    return
  }
  const anchor = tippableFrom(under)
  if (!anchor) {
    endPenHover()
    return
  }
  if (anchor === hoverAnchor && tipEl) {
    position(tipEl, anchor)
    return
  }
  const text = titleFor(anchor)
  if (!`${text || ''}`.trim()) {
    endPenHover()
    return
  }
  showFlagTip(anchor, text, { sticky: true, suppressNativeTitle: true })
}

const clearPress = () => {
  if (!press) return
  if (press.timer) clearTimeout(press.timer)
  if (press.onContextMenu) {
    press.el.removeEventListener('contextmenu', press.onContextMenu)
  }
  press = null
}

const bindFlagTips = () => {
  document.addEventListener(
    'pointerdown',
    e => {
      hideFlagTip()
      if (e.pointerType === 'touch') suppressHoverUntil = Date.now() + 800
      if (!isTouchPointer(e)) return
      if (e.target.closest?.('.neighbor')) return
      const flag = e.target.closest?.('img.remote, img.favicon')
      if (!flag) return

      const onContextMenu = ev => ev.preventDefault()
      flag.addEventListener('contextmenu', onContextMenu)

      press = {
        id: e.pointerId,
        el: flag,
        x0: e.clientX,
        y0: e.clientY,
        shown: false,
        onContextMenu,
        timer: setTimeout(() => {
          if (!press || press.id !== e.pointerId) return
          press.shown = true
          showFlagTip(flag, titleFor(flag))
        }, FLAG_TIP_HOLD_MS),
      }
    },
    true,
  )

  const onMove = e => {
    if (press && e.pointerId === press.id) {
      if (Math.abs(e.clientX - press.x0) > FLAG_TIP_MOVE_PX || Math.abs(e.clientY - press.y0) > FLAG_TIP_MOVE_PX) {
        clearPress()
      }
    }
    if (uiBusy()) {
      endPenHover()
      return
    }
    if ((e.buttons || 0) !== 0) return
    updatePenHover(e)
  }

  const onEnd = e => {
    if (!press || (e && e.pointerId !== press.id)) return
    const shown = press.shown
    const el = press.el
    clearPress()
    if (!shown) return
    const block = ev => {
      if (ev.target === el || el.contains?.(ev.target)) {
        ev.preventDefault()
        ev.stopPropagation()
      }
      document.removeEventListener('click', block, true)
    }
    document.addEventListener('click', block, true)
    setTimeout(() => document.removeEventListener('click', block, true), 400)
  }

  document.addEventListener('pointermove', onMove, true)
  document.addEventListener('pointerover', updatePenHover, true)
  document.addEventListener('pointerup', onEnd, true)
  document.addEventListener(
    'pointercancel',
    e => {
      onEnd(e)
      endPenHover()
    },
    true,
  )
  document.addEventListener(
    'pointerout',
    e => {
      if (!hoverAnchor) return
      if (!e.relatedTarget) endPenHover()
    },
    true,
  )
  document.addEventListener('mouseover', updatePenHover, true)
  document.addEventListener('mousemove', updatePenHover, true)
  window.addEventListener('scroll', hideFlagTip, true)
}

module.exports = {
  inject,
  bind,
  requestLayout: () => requestLayout(),
  freezeFooterStack: () => freezeFooterStack(),
  unfreezeFooterStack: () => unfreezeFooterStack(),
}
