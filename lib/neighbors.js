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
<span class="neighbor" data-site="${site}" ${site != window.location.hostname ? 'draggable="true"' : ''}>
<div class="wait">
  <img src="${wiki.site(site).flag()}" title="${site}">
</div>
</span>\
`

const inject = neighborhood => (sites = neighborhood.sites)

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
  flagEl.parentElement.removeChild(flagEl)
  delete wiki.neighborhood[site]
  $('body').trigger('new-neighbor-done', site)
}

const bind = function () {
  const hood = $('.neighborhood').get(0)
  const footer = document.querySelector('footer')

  // .footer-controls holds search/wiki. #site-owner/#security stay footer children when unstacked.
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
  const chromeRow = () => footer?.querySelector(':scope > .footer-chrome')

  const placeMenuIn = (parent, before) => {
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

  // Stacked → wrap chrome in .footer-chrome; unstacked → unwrap (keeps footer > #security).
  const syncChrome = stacked => {
    if (!footer || !hood) return
    let row = chromeRow()
    const menu = footer.querySelector('.footer-menu')
    const owner = footer.querySelector('#site-owner')
    const security = footer.querySelector('#security')

    if (stacked) {
      if (!row) {
        row = document.createElement('span')
        row.className = 'footer-chrome'
        footer.insertBefore(row, hood)
      }
      const items = isMobile() ? [menu, owner, security, controls] : [owner, security, controls]
      for (const el of items.filter(Boolean)) {
        if (el.parentElement !== row) row.appendChild(el)
      }
      if (!isMobile()) placeMenuIn(controls)
      return
    }

    if (row) {
      while (row.firstChild) footer.insertBefore(row.firstChild, row)
      row.remove()
    }
    if (isMobile()) placeMenuIn(footer, owner || controls || hood)
    else placeMenuIn(controls)
  }

  // Transform pan: DOM [newest … origin], userScroll 0 = origin flush right.
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

  const flagWidth = () => (track ? track.scrollWidth || 0 : 0)
  const maxScroll = () => {
    if (!hood || !track) return 0
    const s = getComputedStyle(hood)
    const pad = (parseFloat(s.paddingLeft) || 0) + (parseFloat(s.paddingRight) || 0)
    return Math.max(0, flagWidth() - Math.max(0, hood.clientWidth - pad))
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
    const active = !isMobile() && stacked && (maxScroll() > 1 || flagWidth() > hood.clientWidth + 1)
    hood.classList.toggle('scrollable', active)
    applyTrack()
    if (!active) {
      chevronLeft.hidden = chevronRight.hidden = true
      return
    }

    // Absolute top is relative to footer's padding edge; getBoundingClientRect is the
    // border box — subtract border so chevrons line up with the flag images.
    const fr = footer.getBoundingClientRect()
    const box = hood.getBoundingClientRect()
    const flagImg = track?.querySelector('.neighbor img')
    const flagEl = flagImg || track?.querySelector('.neighbor')
    const flagRect = flagEl?.getBoundingClientRect()
    const borderTop = parseFloat(getComputedStyle(footer).borderTopWidth) || 0
    const heightPx = Math.max(16, Math.round(flagRect?.height || 16))
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
  const renderPagesLabel = () => {
    const el = pagesEl()
    if (!el) return
    if (isMobile()) el.innerHTML = `<span>${totalPages}</span><span>pages</span>`
    else el.textContent = `${totalPages} pages`
  }

  const marginX = el => {
    if (!el) return 0
    const s = getComputedStyle(el)
    return (parseFloat(s.marginLeft) || 0) + (parseFloat(s.marginRight) || 0)
  }

  // Prefer scrollWidth so flex-shrink from the current stack state cannot change "needed".
  const iw = el => (el ? Math.max(el.scrollWidth || 0, el.offsetWidth || 0) : 0)

  // Width needed for chrome on one row with flags. Must not depend on stacked vs
  // unstacked layout — a state-dependent measurement causes stack/unstack flicker.
  const chromeWidth = (pagesW, searchW) => {
    if (!footer || !controls) return 0
    const search = controls.querySelector('input.search')
    // Always measure the logical chrome pieces (not .footer-chrome children), so
    // wrapping into a chrome row cannot shrink the "needed" width and flip the decision.
    const pieces = isMobile()
      ? [footer.querySelector('.footer-menu'), footer.querySelector('#site-owner'), footer.querySelector('#security'), controls]
      : [footer.querySelector('#site-owner'), footer.querySelector('#security'), controls]

    let total = 0
    let n = 0
    for (const child of pieces.filter(Boolean)) {
      n += 1
      if (child === controls) {
        for (const piece of controls.children) {
          if (search && piece.contains?.(search)) {
            total += searchW + pagesW + (parseFloat(getComputedStyle(piece).gap) || 6) + marginX(piece)
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

  // Tiny slack to unstack — width-only RO + layoutGuard already kill height feedback.
  // Large values keep two rows long after the window can fit one again.
  const STACK_HYSTERESIS = 8

  // Ignore ResizeObserver/MutationObserver callbacks caused by our own layout writes.
  let layoutGuard = false

  const layout = () => {
    if (!footer || !hood || !controls) return
    normalizeFlagOrder()

    const row = chromeRow()
    for (const child of [...footer.children]) {
      if (child === hood || child === controls || child === row) continue
      if (child.id === 'site-owner' || child.id === 'security') continue
      if (child.classList?.contains('footer-menu') || child.classList?.contains('footer-chrome')) continue
      if (isChevron(child)) continue
      controls.appendChild(child)
    }

    const styles = getComputedStyle(footer)
    const available =
      footer.clientWidth - ((parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0))
    const search = controls.querySelector('input.search')
    const mobile = isMobile()
    const em = parseFloat(getComputedStyle(search || footer).fontSize) || (mobile ? 16 : 13)
    renderPagesLabel()
    const pages = pagesEl()
    const pagesW = pages ? Math.max(pages.scrollWidth, ow(pages)) : 0
    // Desktop: keep search at full 10em; stack flags instead of shrinking the input.
    const needed = chromeWidth(pagesW, (mobile ? 2.25 : 10) * em) + flagWidth()
    const currentlyStacked = footer.classList.contains('neighborhood-above')
    const stacked = currentlyStacked
      ? needed > available - STACK_HYSTERESIS
      : needed > available + 0.5

    layoutGuard = true
    try {
      footer.classList.toggle('neighborhood-above', stacked)
      syncChrome(stacked)
      document.documentElement.style.setProperty('--footer-height', `${footer.offsetHeight}px`)
      syncChevrons()
    } finally {
      requestAnimationFrame(() => {
        layoutGuard = false
      })
    }
  }

  let layoutFrame = null
  const scheduleLayout = () => {
    if (layoutGuard || layoutFrame != null) return
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
      renderPagesLabel()
      scheduleLayout()
    })
    .on('mouseenter', '.neighbor', function (e) {
      const $neighbor = $(e.currentTarget)
      const { site } = $neighbor.data()
      $neighbor.find('img:first').attr('title', formatNeighborTitle(site))
    })
    .on('click', '.neighbor img', function (e) {
      if (suppressClick) return
      // add handling refreshing neighbor that has failed
      if ($(e.target).parent().hasClass('fail')) {
        $(e.target).parent().removeClass('fail').addClass('wait')
        const site = $(e.target).attr('title').split('\n')[0]
        wiki.site(site).refresh(function () {
          console.log('about to retry neighbor')
          neighborhood.retryNeighbor(site)
        })
      } else {
        link.doInternalLink('welcome-visitors', null, this.title.split('\n')[0])
      }
    })

  // Desktop: HTML5 drag. Touch: pan to scroll, or lift to remove.
  const AXIS = 8
  const LIFT = 28
  let gesture = null
  let suppressClick = false

  const clearLift = neighbor => {
    if (!neighbor) return
    neighbor.classList.remove('lifting')
    neighbor.style.transform = ''
  }

  if (hood) {
    hood.addEventListener(
      'pointerdown',
      e => {
        if (e.pointerType === 'mouse') return
        const neighbor = e.target.closest('.neighbor')
        if (!neighbor || neighbor.dataset.site === window.location.hostname) return
        gesture = { id: e.pointerId, neighbor, x0: e.clientX, y0: e.clientY, scroll0: userScroll, mode: null }
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
          gesture.mode = dy < 0 && Math.abs(dy) > Math.abs(dx) ? 'lift' : 'pan'
          if (gesture.mode === 'lift') gesture.neighbor.classList.add('lifting')
        }
        if (gesture.mode === 'pan') {
          followOrigin = false
          userScroll = gesture.scroll0 + dx
          applyTrack()
          syncChevrons()
        } else {
          gesture.neighbor.style.transform = `translateY(${Math.min(0, dy)}px)`
        }
        e.preventDefault()
      },
      { passive: false },
    )
    const endGesture = e => {
      if (!gesture || (e && e.pointerId !== gesture.id)) return
      const { neighbor, mode, y0 } = gesture
      const dy = (e?.clientY ?? gesture.y0) - y0
      clearLift(neighbor)
      if (mode) suppressClick = true
      if (mode === 'lift' && -dy >= LIFT) {
        console.log(`*** Removing ${neighbor.dataset.site} from neighborhood.`)
        evict(neighbor.dataset.site)
      }
      gesture = null
      followOrigin = originFullyVisible()
      scheduleLayout()
      setTimeout(() => {
        suppressClick = false
      }, 0)
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
    new MutationObserver(mutations => {
      if (layoutGuard) return
      if (mutations.some(m => !isChevron(m.target) && !m.target?.closest?.('.neighborhood-chevron'))) {
        scheduleLayout()
      }
    }).observe(footer, { childList: true, subtree: true })
  }
  window.addEventListener('resize', scheduleLayout)
  scheduleLayout()
}

module.exports = { inject, bind }
