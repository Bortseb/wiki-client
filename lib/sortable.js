// SortableJS stand-in for lineup drag that used to live in legacy.js / refresh.js.
//
// Map (call sites keep these export names):
//   initPageSortable — legacy: page-panel reorder in .main
//   initDragging     — refresh: story item reorder / cross-page move-copy (same name)
//   initMerging      — refresh: journal drag-merge (same name)
//
// Mobile feature parity (handles, flick-dismiss, lineup item-drag, journal long-press)
// lives here so Replace stays a thin jQuery UI → SortableJS swap.

const Sortable = require('sortablejs')
const lineup = require('./lineup')
const state = require('./state')
const plugin = require('./plugin')
const active = require('./active')
const pageHandler = require('./pageHandler')
const random = require('./random')
const { pageEmitter } = require('./page')

// ---------------------------------------------------------------------------
// Page panels
// ---------------------------------------------------------------------------
// Page column reorder via SortableJS (replaces jQuery UI Sortable on .main).
// Desktop: classic FedWiki page drag (full pages; remove only when dragged above the window).
// Mobile: half-size lineup, mini title chip, short full-width top dismiss strip,
//         continuous edge-proximity pan, dotted insert slots only.


const DRAG_CLASS = 'wiki-page-drag'
const TARGETS_ID = 'wiki-page-drag-targets'
const CHIP_ID = 'wiki-page-drag-chip'
const LINEUP_SHRUNK = 'wiki-page-lineup-shrunk'

// Edge pan: start scrolling early; speed ramps toward the hard edge.
const EDGE_ZONE_PX = 150
const MAX_SCROLL_PX_PER_SEC = 1500

const isMobile = () => window.matchMedia('(max-width: 490px)').matches

const lineupMain = () => document.querySelector('.main')

const pageNodesIn = main => (main ? [...main.querySelectorAll(':scope > .page')] : [])

const centerInMain = (el, main) => {
  if (!main || !el) return
  const mainRect = main.getBoundingClientRect()
  const elRect = el.getBoundingClientRect()
  const delta = elRect.left + elRect.width / 2 - (mainRect.left + mainRect.width / 2)
  if (Math.abs(delta) > 1) main.scrollLeft += delta
}

const nearestPageIndexIn = main => {
  const nodes = pageNodesIn(main)
  if (!nodes.length || !main) return -1
  const mainRect = main.getBoundingClientRect()
  const mid = mainRect.left + mainRect.width / 2
  let best = 0
  let bestDist = Infinity
  nodes.forEach((n, i) => {
    const r = n.getBoundingClientRect()
    const d = Math.abs(r.left + r.width / 2 - mid)
    if (d < bestDist) {
      bestDist = d
      best = i
    }
  })
  return best
}

const ensureLineupSpacers = (holder, main) => {
  if (!main || !holder) return
  const pad = Math.max(140, Math.round(main.clientWidth * 0.58))
  if (!holder.leftSpacer) {
    holder.leftSpacer = document.createElement('div')
    holder.leftSpacer.className = 'wiki-page-drag-spacer wiki-page-drag-spacer-left'
    holder.leftSpacer.setAttribute('aria-hidden', 'true')
    main.insertBefore(holder.leftSpacer, main.firstChild)
  }
  if (!holder.rightSpacer) {
    holder.rightSpacer = document.createElement('div')
    holder.rightSpacer.className = 'wiki-page-drag-spacer wiki-page-drag-spacer-right'
    holder.rightSpacer.setAttribute('aria-hidden', 'true')
    main.appendChild(holder.rightSpacer)
  }
  for (const sp of [holder.leftSpacer, holder.rightSpacer]) {
    sp.style.flex = `0 0 ${pad}px`
    sp.style.width = `${pad}px`
    sp.style.minWidth = `${pad}px`
  }
}

const removeLineupSpacers = holder => {
  holder?.leftSpacer?.remove()
  holder?.rightSpacer?.remove()
  if (holder) {
    holder.leftSpacer = null
    holder.rightSpacer = null
  }
}

const edgeScrollForX = (clientX, main) => {
  if (!main || typeof clientX !== 'number') return { dir: 0, speed: 0 }
  const mainRect = main.getBoundingClientRect()
  const distLeft = clientX - mainRect.left
  const distRight = mainRect.right - clientX
  let dir = 0
  let near = Infinity
  if (distLeft <= EDGE_ZONE_PX && distLeft <= distRight) {
    dir = -1
    near = Math.max(0, distLeft)
  } else if (distRight <= EDGE_ZONE_PX) {
    dir = 1
    near = Math.max(0, distRight)
  }
  if (!dir) return { dir: 0, speed: 0 }
  const t = 1 - near / EDGE_ZONE_PX
  return { dir, speed: MAX_SCROLL_PX_PER_SEC * t * t }
}

const applyVertEdgeScroll = (els, pointerY, dt, zonePx, maxPxPerSec) => {
  if (typeof pointerY !== 'number') return
  for (const el of els) {
    if (!el || el.scrollHeight <= el.clientHeight + 2) continue
    const r = el.getBoundingClientRect()
    let dir = 0
    let near = Infinity
    if (pointerY < r.top + zonePx) {
      dir = -1
      near = Math.max(0, pointerY - r.top)
    } else if (pointerY > r.bottom - zonePx) {
      dir = 1
      near = Math.max(0, r.bottom - pointerY)
    }
    if (!dir) continue
    const t = 1 - near / zonePx
    const speed = maxPxPerSec * t * t
    if (speed > 0) el.scrollTop += dir * speed * dt
  }
}

// Dismiss / remove-from-lineup (not delete): circle with X.
const REMOVE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">' +
  '<path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm3.5 13.1-1.4 1.4L12 13.4l-2.1 2.1-1.4-1.4L10.6 12 8.5 9.9l1.4-1.4L12 10.6l2.1-2.1 1.4 1.4L13.4 12l2.1 2.1z"/>' +
  '</svg>'

const ensureTargets = function () {
  let el = document.getElementById(TARGETS_ID)
  if (el) return el
  el = document.createElement('div')
  el.id = TARGETS_ID
  el.className = 'page-drag-targets page-drag-targets-trash-only'
  el.setAttribute('aria-hidden', 'true')
  el.innerHTML =
    '<div class="page-drag-target page-drag-target-trash" data-action="trash" aria-label="Remove page from lineup">' +
    `<span class="page-drag-target-icon">${REMOVE_SVG}</span></div>`
  document.body.appendChild(el)
  return el
}

const ensureChip = function () {
  let el = document.getElementById(CHIP_ID)
  if (el) return el
  el = document.createElement('div')
  el.id = CHIP_ID
  el.className = 'wiki-page-drag-chip'
  el.setAttribute('aria-hidden', 'true')
  el.innerHTML =
    '<div class="wiki-page-drag-chip-page">' +
    '<div class="wiki-page-drag-chip-title"></div>' +
    '</div>'
  document.body.appendChild(el)
  return el
}

const pageTitle = pageEl => {
  const text = pageEl?.querySelector?.('h1')?.textContent || ''
  return text.replace(/\s+/g, ' ').trim() || 'Page'
}

const initPageSortable = function (mainEl) {
  if (!mainEl) return null
  if (mainEl._wikiPageSortable) {
    mainEl._wikiPageSortable.destroy()
    mainEl._wikiPageSortable = null
  }

  let originalPageIndex = null
  let $dragging = null
  let dragOriginY = null
  let dragOriginTop = null
  let activeTarget = null
  let lastPointerX = null
  let lastPointerY = null
  let edgeScrollRaf = null
  let lastScrollTs = 0
  let mobileDrag = false
  let exitedOffTop = false
  const spacers = {}
  let capturedEl = null
  let capturedPointerId = null

  // SortableJS fallback clone (the page under the cursor). Prefer this over
  // .wiki-page-drag, which can also match leftover nodes.
  const helperEl = () => {
    const fallback = document.querySelector('.sortable-fallback.page')
    if (fallback) return fallback
    if (Sortable.ghost?.classList?.contains('page')) return Sortable.ghost
    return document.querySelector(`.${DRAG_CLASS}`)
  }

  // Keep the moving page looking like a real page. Ghost styles hide lineup-slot
  // children; those must never leak onto the fallback clone.
  const prepareDesktopHelper = function (el) {
    if (!el?.classList?.contains('page')) return
    el.classList.remove('wiki-page-ghost')
    el.style.overflow = 'visible'
    el.style.visibility = 'visible'
    el.style.background = '#fff'
    // SortableJS hardcodes inline opacity 0.8 on the clone.
    el.style.setProperty('opacity', '1', 'important')
    for (const child of el.children) {
      child.style.visibility = 'visible'
      child.style.opacity = ''
    }
  }

  const pageNodes = () => pageNodesIn(mainEl)

  const stopEdgeScroll = function () {
    if (edgeScrollRaf != null) {
      cancelAnimationFrame(edgeScrollRaf)
      edgeScrollRaf = null
    }
    lastScrollTs = 0
  }

  const edgeScrollTick = function (ts) {
    edgeScrollRaf = null
    if (!mobileDrag) return
    if (!lastScrollTs) lastScrollTs = ts
    const dt = Math.min(0.05, (ts - lastScrollTs) / 1000)
    lastScrollTs = ts

    const { dir, speed } = edgeScrollForX(lastPointerX, mainEl)
    if (dir && speed > 0) {
      mainEl.scrollLeft += dir * speed * dt
    }

    edgeScrollRaf = requestAnimationFrame(edgeScrollTick)
  }

  const startEdgeScroll = function () {
    if (edgeScrollRaf != null) return
    lastScrollTs = 0
    edgeScrollRaf = requestAnimationFrame(edgeScrollTick)
  }

  const eventY = e => {
    if (e == null) return null
    // Prefer touch points: some browsers expose a stale event.clientY of 0.
    const t = e.changedTouches?.[0] || e.touches?.[0]
    if (t && typeof t.clientY === 'number') return t.clientY
    if (typeof e.clientY === 'number') return e.clientY
    return null
  }

  const eventX = e => {
    if (e == null) return null
    const t = e.changedTouches?.[0] || e.touches?.[0]
    if (t && typeof t.clientX === 'number') return t.clientX
    if (typeof e.clientX === 'number') return e.clientX
    return null
  }

  const capturePointer = function (oe) {
    if (!oe || typeof oe.pointerId !== 'number') return
    // Capture on body, not the handle: mobile ghosts display:none the handle
    // and that drops capture (same bug desktop avoided with opacity:0).
    const el = document.body
    try {
      el.setPointerCapture(oe.pointerId)
      capturedEl = el
      capturedPointerId = oe.pointerId
    } catch (_) {
      try {
        oe.target?.setPointerCapture(oe.pointerId)
        capturedEl = oe.target
        capturedPointerId = oe.pointerId
      } catch (_) {
        /* not a pointer event */
      }
    }
  }

  const trashStripBottom = function () {
    const node = document.getElementById(TARGETS_ID)?.querySelector('.page-drag-target-trash')
    return node ? node.getBoundingClientRect().bottom : 20
  }

  const showTrash = function () {
    const targets = ensureTargets()
    const canRemove = pageNodes().length > 1
    targets.querySelector('[data-action="trash"]')?.classList.toggle('is-unavailable', !canRemove)
    targets.classList.add('is-active')
    targets.setAttribute('aria-hidden', 'false')
  }

  const hideTrash = function () {
    const targets = document.getElementById(TARGETS_ID)
    if (!targets) return
    targets.classList.remove('is-active')
    targets.setAttribute('aria-hidden', 'true')
    targets.querySelectorAll('.page-drag-target').forEach(t => t.classList.remove('is-hot'))
  }

  const moveChip = function (clientX, clientY) {
    if (!mobileDrag) return
    const chip = document.getElementById(CHIP_ID)
    if (!chip?.classList.contains('is-active')) return
    if (typeof clientX !== 'number' || typeof clientY !== 'number') return
    chip.style.transform = `translate(${clientX - 42}px, ${clientY - 140}px)`
  }

  const showChip = function (title, clientX, clientY) {
    const chip = ensureChip()
    const titleEl = chip.querySelector('.wiki-page-drag-chip-title')
    if (titleEl) titleEl.textContent = title
    chip.classList.add('is-active')
    chip.classList.remove('is-pending-remove')
    chip.setAttribute('aria-hidden', 'false')
    moveChip(clientX, clientY)
  }

  const hideChip = function () {
    const chip = document.getElementById(CHIP_ID)
    if (!chip) return
    chip.classList.remove('is-active', 'is-pending-remove')
    chip.setAttribute('aria-hidden', 'true')
    chip.style.transform = ''
  }

  const setLineupShrunk = function (on) {
    document.body.classList.toggle(LINEUP_SHRUNK, !!on)
  }

  const setPendingRemove = function (on) {
    if (!$dragging?.length) return
    const fallback = helperEl()
    const chip = document.getElementById(CHIP_ID)
    $dragging.toggleClass('pending-remove', !!on)
    chip?.classList.toggle('is-pending-remove', !!on)
    if (!fallback) return
    fallback.classList.toggle('pending-remove', !!on)
    fallback.classList.remove('wiki-page-ghost')
    // SortableJS sets inline opacity: 0.8 on the clone; beat that for the
    // classic 20% fade when the page will be removed.
    fallback.style.transition = 'opacity 300ms'
    fallback.style.setProperty('opacity', on ? '0.2' : '1', 'important')
  }

  const hitTrash = function (clientX, clientY) {
    if (typeof clientY !== 'number') return false
    const targets = document.getElementById(TARGETS_ID)
    if (!targets?.classList.contains('is-active')) return false
    const node = targets.querySelector('.page-drag-target-trash:not(.is-unavailable)')
    if (!node) return false
    // Desktop parity: pointer above the window always dismisses.
    if (clientY <= 0) return true
    // Grab may start in the 40px handle. Dismiss only after moving up into
    // the 20px strip — or off the top.
    if (typeof dragOriginY === 'number' && clientY >= dragOriginY) return false
    return clientY <= node.getBoundingClientRect().bottom
  }

  const updateTrashHover = function (clientX, clientY) {
    if (typeof clientY === 'number') {
      if (clientY <= 0) exitedOffTop = true
      else if (clientY > trashStripBottom()) exitedOffTop = false
    }
    const over = exitedOffTop || hitTrash(clientX, clientY)
    activeTarget = over ? 'trash' : null
    document
      .getElementById(TARGETS_ID)
      ?.querySelector('.page-drag-target-trash')
      ?.classList.toggle('is-hot', over)
    setPendingRemove(over)
  }

  const updatePendingRemove = function (e) {
    // Desktop only — classic FedWiki: pending-remove when dragged above the window.
    if (mobileDrag) return
    if (!$dragging?.length || !$dragging.hasClass('page')) return
    const canRemove = pageNodes().length > 1
    const clientY = eventY(e)
    const pageY = typeof e?.pageY === 'number' ? e.pageY : e?.touches?.[0]?.pageY ?? e?.changedTouches?.[0]?.pageY
    // Stock FedWiki: dim only when the pointer leaves the top of the window.
    // clientY <= 0 covers browsers that clamp coordinates at the edge.
    const aboveWindow =
      (typeof clientY === 'number' && clientY <= 0) || (typeof pageY === 'number' && pageY < 0)
    setPendingRemove(canRemove && aboveWindow)
  }

  const onPointerMove = function (e) {
    const y = eventY(e)
    const x = eventX(e)
    if (typeof x === 'number') lastPointerX = x
    if (typeof y === 'number') lastPointerY = y
    if (dragOriginY == null && typeof y === 'number') {
      dragOriginY = y
      const fallback = helperEl()
      if (fallback) dragOriginTop = fallback.getBoundingClientRect().top
    }
    if (mobileDrag) {
      moveChip(x, y)
      updateTrashHover(x, y)
      return
    }
    updatePendingRemove(e)
  }

  const onPointerLost = function (e) {
    if (!mobileDrag) return
    const y = eventY(e)
    const x = eventX(e)
    if (typeof x === 'number') lastPointerX = x
    if (typeof y === 'number') lastPointerY = y
    // Off-screen release / iOS cancel: no coords, or Y clamped at the top edge.
    // Sticky-dismiss if we were already in/above the strip or the last Y is at
    // the window top (desktop: drop above the window).
    const yNow = typeof y === 'number' ? y : lastPointerY
    if (typeof yNow !== 'number') {
      if (exitedOffTop) updateTrashHover(lastPointerX, 0)
      return
    }
    if (yNow <= 0 || yNow <= trashStripBottom()) {
      if (typeof dragOriginY !== 'number' || yNow < dragOriginY || yNow <= 0) {
        exitedOffTop = true
      }
    }
    updateTrashHover(typeof x === 'number' ? x : lastPointerX, yNow <= 0 ? 0 : yNow)
  }

  const stopTracking = function () {
    document.removeEventListener('pointermove', onPointerMove, true)
    window.removeEventListener('pointermove', onPointerMove, true)
    document.removeEventListener('touchmove', onPointerMove)
    document.removeEventListener('pointerup', onPointerLost, true)
    window.removeEventListener('pointerup', onPointerLost, true)
    document.removeEventListener('pointercancel', onPointerLost, true)
    window.removeEventListener('pointercancel', onPointerLost, true)
    document.removeEventListener('lostpointercapture', onPointerLost, true)
    stopEdgeScroll()
    hideTrash()
    hideChip()
    removeLineupSpacers(spacers)
    setLineupShrunk(false)
    activeTarget = null
    exitedOffTop = false
    mobileDrag = false
    $dragging = null
    dragOriginY = null
    dragOriginTop = null
    if (capturedEl && capturedPointerId != null) {
      try {
        capturedEl.releasePointerCapture(capturedPointerId)
      } catch (_) {
        /* already released */
      }
    }
    capturedEl = null
    capturedPointerId = null
  }

  const finishDrag = function ($page, removing, opts = {}) {
    if (!$page.hasClass('page')) return
    const $pages = $('.page')
    let index = $pages.index($('.active'))
    let firstItemIndex = $('.item').index($page.find('.item')[0])
    if (removing) {
      if ($pages.length === 1) return
      lineup.removeKey($page.data('key'))
      $page.remove()
      active.set($('.page')[index], true)
    } else {
      $page.removeClass('pending-remove')
      const newIndex = pageNodes().indexOf($page[0])
      lineup.changePageIndex($page.data('key'), newIndex >= 0 ? newIndex : index)
      // Mobile: no smooth scrollIntoView — snap instantly after unshrink.
      active.set($page, !!opts.noScroll)
      if (originalPageIndex != null && originalPageIndex < (newIndex >= 0 ? newIndex : index)) {
        index = originalPageIndex
        firstItemIndex = $('.item').index($($('.page')[index]).find('.item')[0])
      }
      if (opts.instantCenter) {
        requestAnimationFrame(() => {
          centerInMain($page[0], mainEl)
          requestAnimationFrame(() => centerInMain($page[0], mainEl))
        })
      }
    }
    plugin.renderFrom(firstItemIndex)
    state.setUrl()
    if (window.debug) state.debugStates()
  }

  const sortable = Sortable.create(mainEl, {
    animation: 150,
    handle: '.page-handle',
    draggable: '.page',
    ghostClass: 'wiki-page-ghost',
    dragClass: DRAG_CLASS,
    direction: 'horizontal',
    forceFallback: true,
    fallbackOnBody: true,
    fallbackTolerance: 5,
    sort: true,
    // Isolated group. Important: SortableJS `put: true` means "accept from ANY
    // group", which lets story .item nodes insert into .main as fake pages.
    // Pages only reorder within .main — never cross-list.
    group: {
      name: 'wiki-pages',
      pull: false,
      put: false,
    },
    // Desktop uses Sortable scroll; mobile drives edge-proximity scroller itself.
    scroll: mainEl,
    bubbleScroll: true,
    forceAutoScrollFallback: true,
    scrollSensitivity: 80,
    scrollSpeed: 18,
    onMove(evt) {
      // Never allow a page to be treated as a story item drop.
      if (!evt?.dragged?.classList?.contains('page')) return false
      if (evt.to && !evt.to.classList?.contains('main') && evt.to !== mainEl) return false
      return true
    },
    onStart(evt) {
      if (!$(evt.item).hasClass('page')) return
      active.set($(evt.item), true)
      originalPageIndex = pageNodes().indexOf(evt.item)
      $dragging = $(evt.item)
      activeTarget = null
      exitedOffTop = false
      mobileDrag = isMobile()
      const oe = evt.originalEvent
      const x = eventX(oe)
      const y = eventY(oe)
      dragOriginY = y
      dragOriginTop = evt.item.getBoundingClientRect().top
      if (typeof x === 'number') lastPointerX = x
      if (typeof y === 'number') lastPointerY = y

      // While a page is dragging, disable story sortables so the page can't
      // be swallowed as an item (SortableJS cross-list put).
      try {
        setStorySortableEnabled(false)
      } catch (_) {
        /* optional */
      }

      if (mobileDrag) {
        // Mobile page-drag mode: shrink, chip, trash, continuous edge pan.
        if (sortable.option) {
          sortable.option('scroll', false)
          sortable.option('animation', 0)
          // Higher threshold = fewer mid-pan insert flips while scrolling.
          sortable.option('swapThreshold', 0.85)
        }
        setLineupShrunk(true)
        ensureLineupSpacers(spacers, mainEl)
        requestAnimationFrame(() => {
          const ghost = mainEl.querySelector('.wiki-page-ghost')
          if (ghost) centerInMain(ghost, mainEl)
          requestAnimationFrame(() => {
            const ghost2 = mainEl.querySelector('.wiki-page-ghost')
            if (ghost2) centerInMain(ghost2, mainEl)
          })
        })
        showTrash()
        showChip(pageTitle(evt.item), x, y)
        startEdgeScroll()
        capturePointer(oe)
      } else if (sortable.option) {
        sortable.option('scroll', mainEl)
        sortable.option('animation', 150)
        sortable.option('swapThreshold', 1)
        prepareDesktopHelper(helperEl())
        requestAnimationFrame(() => prepareDesktopHelper(helperEl()))
        // Keep pointer events when the cursor leaves the window (needed for
        // pending-remove). visibility:hidden on the handle would drop capture.
        capturePointer(oe)
      }

      document.addEventListener('pointermove', onPointerMove, true)
      window.addEventListener('pointermove', onPointerMove, true)
      document.addEventListener('touchmove', onPointerMove, { passive: true })
      document.addEventListener('pointerup', onPointerLost, true)
      window.addEventListener('pointerup', onPointerLost, true)
      document.addEventListener('pointercancel', onPointerLost, true)
      window.addEventListener('pointercancel', onPointerLost, true)
      document.addEventListener('lostpointercapture', onPointerLost, true)
    },
    onEnd(evt) {
      const $page = $(evt.item)
      const wasMobile = mobileDrag
      if (wasMobile) {
        const oe = evt.originalEvent
        const y = eventY(oe) ?? lastPointerY
        const x = eventX(oe) ?? lastPointerX
        if (typeof y === 'number' && y <= 0) exitedOffTop = true
        updateTrashHover(x, y)
      }
      const removing = wasMobile
        ? activeTarget === 'trash' || exitedOffTop
        : $page.hasClass('pending-remove')
      stopTracking()
      // Restore story dragging according to edit mode.
      try {
        const story = require('./refresh')
        story.setStorySortableEnabled(story.isEditOn())
      } catch (_) {
        /* optional */
      }
      // If a page somehow landed inside a story, put it back under .main.
      if ($page.parent().hasClass('story') || !$page.parent().hasClass('main')) {
        const kids = pageNodes()
        const ref = kids[Math.min(originalPageIndex ?? kids.length, kids.length)]
        if (ref) mainEl.insertBefore($page[0], ref)
        else mainEl.appendChild($page[0])
      }
      if (wasMobile && !removing) {
        finishDrag($page, false, { noScroll: true, instantCenter: true })
      } else {
        finishDrag($page, removing)
      }
    },
  })

  mainEl._wikiPageSortable = sortable
  return sortable
}

const setPageSortableEnabled = function (enabled) {
  document.querySelectorAll('.main').forEach(mainEl => {
    if (mainEl._wikiPageSortable) {
      mainEl._wikiPageSortable.option('disabled', !enabled)
    }
  })
}

const shouldSuppressLineupNavItemClick = () => false

// Bridge so story/journal code can call pages.* (formerly legacy exports).
const pages = {
  initPageSortable,
  setPageSortableEnabled,
  shouldSuppressLineupNavItemClick,
  lineupMain,
  pageNodesIn,
  centerInMain,
  nearestPageIndexIn,
  ensureLineupSpacers,
  removeLineupSpacers,
  edgeScrollForX,
  applyVertEdgeScroll,
  LINEUP_SHRUNK,
}

// ---------------------------------------------------------------------------
// Story items + handle chrome + mobile lineup item-drag
// ---------------------------------------------------------------------------


const DROP_CHOOSER_ID = 'wiki-item-drop-chooser'
// Compact insert bar for touch handle-drag and mobile lineup (not item-sized).
const PLACEHOLDER_SLOT_PX = 28

const getItem = function ($item) {
  if ($($item).length > 0) {
    return $($item).data('item') || $($item).data('staticItem')
  }
}

const assignNewItemId = function ($item, item) {
  if (!item.alias) item.alias = item.id
  item.id = random.itemId()
  $item.attr('data-id', item.id)
  $item.data('id', item.id)
  $item.data('item').id = item.id
}

const aliasItem = function ($page, $item, oldItem, opts = {}) {
  const item = $.extend({}, oldItem)
  $item.data('item', item)
  const pageObject = lineup.atKey($page.data('key'))
  const destHasId = pageObject.getItem(item.id) != null
  // Copies always mint a unique wiki id (random.itemId); keep alias to origin.
  if (destHasId || opts.asCopy) {
    assignNewItemId($item, item)
  } else if (item.alias != null) {
    if (pageObject.getItem(item.alias) == null) {
      item.id = item.alias
      delete item.alias
      $item.attr('data-id', item.id)
    }
  }
  return item
}

const equals = (a, b) => a && b && a.get(0) === b.get(0)

const getStoryItemOrder = ($story) =>
  $($story)
    .children('.item:not(.shadow-copy)')
    .map((_, value) => $(value).attr('data-id'))
    .get()

const putMove = function ($page, $story, itemId) {
  const order = getStoryItemOrder($story)
  pageHandler.put($page, { id: itemId, type: 'move', order })
}


const handleDrop = function (evt, $item, originalIndex, originalOrder, opts = {}) {
  let dragAttribution, index
  let item = getItem($item)
  const $sourcePage = $item.data('pageElement')
  const sourceIsReadOnly = $sourcePage.hasClass('ghost') || $sourcePage.hasClass('remote')
  const shiftKey = !!opts.shiftKey

  if (!$sourcePage.hasClass('ghost')) {
    dragAttribution = {
      page: $sourcePage.data().data['title'],
    }
    if ($sourcePage.data().site != null) {
      dragAttribution['site'] = $sourcePage.data().site
    }
  }

  const $destinationPage = $item.parents('.page:first')
  const destinationIsGhost = $destinationPage.hasClass('ghost')

  const moveWithinPage = equals($sourcePage, $destinationPage)
  const moveBetweenDuplicatePages =
    !moveWithinPage && !shiftKey && $sourcePage.attr('id') === $destinationPage.attr('id')

  const removedTo = {
    page: $destinationPage.data().data['title'],
  }

  // Ghost dest is no-drop across pages; same-page handle reorder is allowed.
  if ((destinationIsGhost && !moveWithinPage) || moveBetweenDuplicatePages) {
    if (typeof opts.revert === 'function') opts.revert()
    return
  }

  if (moveWithinPage) {
    const order = getStoryItemOrder($item.parents('.story:first'))
    if (JSON.stringify(order) !== JSON.stringify(originalOrder)) {
      $('.shadow-copy').remove()
      clearContent($item)
      index = $('.item').index($item)
      if (originalIndex < index) {
        index = originalIndex
      }
      plugin.renderFrom(index)
      pageHandler.put($destinationPage, { id: item.id, type: 'move', order })
    }
    return
  }

  const copying = sourceIsReadOnly || shiftKey || opts.pullMode === 'clone'
  if (copying) {
    if (opts.pullMode === 'clone') {
      // Original remained in the source list; drop the temporary shadow only.
      $('.shadow-copy').remove()
    } else {
      // Item left the source; promote the shadow copy into a lasting original.
      // (Classic jQuery UI path — desktop always uses this.)
      $('.shadow-copy')
        .removeClass('shadow-copy is-copy-preview')
        .addClass('item')
        .data('pageElement', $sourcePage)
        .data('item', $.extend({}, item))
        .data('id', item.id)
        .attr({ 'data-id': item.id })
        .css('display', '')
        .show()
    }
  } else {
    pageHandler.put($sourcePage, { id: item.id, type: 'remove', removedTo })
  }

  $item.data('pageElement', $destinationPage)
  const $before = $item.prev('.item')
  const before = getItem($before)
  item = aliasItem($destinationPage, $item, item, { asCopy: copying })
  pageHandler.put($destinationPage, {
    id: item.id,
    type: 'add',
    item,
    after: before?.id,
    attribution: dragAttribution,
  })
  $('.shadow-copy').remove()
  clearContent($item)
  $before.after($item)
  index = $('.item').index($item)
  if (originalIndex < index) {
    index = originalIndex
  }
  plugin.renderFrom(index)
}

// Programmatic place used by mobile lineup item-drag (move/copy onto a page).
const placeItemOnPage = function ($item, $destPage, opts = {}) {
  if (!$item?.length || !$destPage?.length) return
  const wantCopy = !!opts.copy
  let item = getItem($item)
  if (!item) return

  const $sourcePage = $item.data('pageElement') || $item.parents('.page:first')
  if (!$sourcePage?.length) return

  const sourceIsReadOnly = $sourcePage.hasClass('ghost') || $sourcePage.hasClass('remote')
  const copying = wantCopy || sourceIsReadOnly
  const samePage = equals($sourcePage, $destPage)
  const duplicatePage = !samePage && $sourcePage.attr('id') === $destPage.attr('id')
  if (duplicatePage && !copying) return

  const $story = $destPage.find('.story').first()
  if (!$story.length) return

  let dragAttribution = null
  if (!$sourcePage.hasClass('ghost')) {
    dragAttribution = { page: $sourcePage.data().data['title'] }
    if ($sourcePage.data().site != null) dragAttribution.site = $sourcePage.data().site
  }

  const removedTo = { page: $destPage.data().data['title'] }
  const $before = opts.$before?.length ? opts.$before : $()
  const originalIndex = $('.item').index($item)

  const insertNode = $node => {
    if ($before.length) $before.after($node)
    else $story.prepend($node)
  }

  // Same-page move = reorder only (no alias / add).
  if (samePage && !copying) {
    insertNode($item)
    const order = getStoryItemOrder($story)
    clearContent($item)
    let index = $('.item').index($item)
    if (originalIndex >= 0 && originalIndex < index) index = originalIndex
    plugin.renderFrom(index)
    pageHandler.put($destPage, { id: item.id, type: 'move', order })
    return
  }

  let $placed = $item
  if (copying) {
    $placed = $item
      .clone(false)
      .removeClass(
        'item-placeholder wiki-item-chosen wiki-item-drag handle-selected toolbar-active is-copy-preview shadow-copy wiki-item-lineup-origin',
      )
      .css({ width: '', height: '', position: '', zIndex: '', display: '', opacity: '' })
    $placed.data('item', $.extend({}, item))
  } else {
    pageHandler.put($sourcePage, { id: item.id, type: 'remove', removedTo })
  }

  insertNode($placed)
  $placed.data('pageElement', $destPage)
  const before = getItem($before)
  item = aliasItem($destPage, $placed, getItem($placed) || item, { asCopy: copying })
  pageHandler.put($destPage, {
    id: item.id,
    type: 'add',
    item,
    after: before?.id,
    attribution: dragAttribution,
  })
  clearContent($placed)
  let index = $('.item').index($placed)
  if (originalIndex >= 0 && originalIndex < index) index = originalIndex
  plugin.renderFrom(index)
}

const updateCursor = function (evt, $item, $toStory) {
  const $sourcePage = $item.data('pageElement')
  if (!$sourcePage?.length) return
  const sourceIsReadOnly = $sourcePage.hasClass('ghost') || $sourcePage.hasClass('remote')
  const $destinationPage = $($toStory).closest('.page')
  const destinationIsGhost = $destinationPage.hasClass('ghost')
  const moveWithinPage = equals($sourcePage, $destinationPage)
  const moveBetweenDuplicatePages = !moveWithinPage && $sourcePage.attr('id') === $destinationPage.attr('id')
  // Copy preview only for Shift (or read-only source) when leaving the page — classic FedWiki.
  const copying = sourceIsReadOnly || (!!evt.shiftKey && !moveWithinPage)
  // Classic FedWiki: body cursor is move / copy / no-drop (not grab/grabbing).
  // Keep shadow visibility via jQuery hide/show (inline), same as jQuery UI path.
  let cursor = 'move'
  if ((!moveWithinPage && destinationIsGhost) || (moveBetweenDuplicatePages && !evt.shiftKey)) {
    cursor = 'no-drop'
    $('.shadow-copy').hide().removeClass('is-copy-preview')
  } else if (copying) {
    cursor = 'copy'
    $('.shadow-copy').show().addClass('is-copy-preview')
  } else {
    cursor = 'move'
    $('.shadow-copy').hide().removeClass('is-copy-preview')
  }
  $('body').css('cursor', cursor)
  // Fallback helper sits under the pointer; keep it in sync with body.
  $('.wiki-item-drag, .sortable-fallback.item').css('cursor', cursor)
}

const MOVE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">' +
  '<path fill="currentColor" d="M4 11h9.2l-2.6-2.6L12 7l5 5-5 5-1.4-1.4L13.2 13H4v-2zm16 8h-2V5h2v14z"/>' +
  '</svg>'

const COPY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">' +
  '<path fill="currentColor" d="M8 7h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zm-3 3H4V4h12v1H5v5z"/>' +
  '</svg>'

const ensureDropChooser = function () {
  let el = document.getElementById(DROP_CHOOSER_ID)
  if (el) return el
  el = document.createElement('div')
  el.id = DROP_CHOOSER_ID
  el.className = 'wiki-item-drop-chooser'
  el.setAttribute('aria-hidden', 'true')
  el.innerHTML =
    `<div class="wiki-item-drop-choice wiki-item-drop-choice-move" data-action="move" aria-label="Move">` +
    `<span class="wiki-item-drop-choice-icon">${MOVE_SVG}</span>` +
    `<span class="wiki-item-drop-choice-label">Move</span></div>` +
    `<div class="wiki-item-drop-choice wiki-item-drop-choice-copy" data-action="copy" aria-label="Copy">` +
    `<span class="wiki-item-drop-choice-icon">${COPY_SVG}</span>` +
    `<span class="wiki-item-drop-choice-label">Copy</span></div>`
  document.body.appendChild(el)
  return el
}

const initStorySortable = function ($page) {
  const storyEl = $page.find('.story')[0]
  if (!storyEl) return null
  if (storyEl._wikiSortable) {
    storyEl._wikiSortable.destroy()
    storyEl._wikiSortable = null
  }
  document.body.classList.remove('wiki-item-handle-drag')
  if (storyEl._wikiPlaceholderLock) {
    storyEl.removeEventListener('pointerdown', storyEl._wikiPlaceholderLock, true)
    storyEl._wikiPlaceholderLock = null
  }
  if (storyEl._wikiPlaceholderUnlock) {
    storyEl.removeEventListener('pointerup', storyEl._wikiPlaceholderUnlock, true)
    storyEl.removeEventListener('pointercancel', storyEl._wikiPlaceholderUnlock, true)
    storyEl._wikiPlaceholderUnlock = null
  }

  const origCursor = $('body').css('cursor')
  const touchUi = needsDragHandle()
  let originalOrder = null
  let originalIndex = null
  let dragCancelled = false
  let lastEvent = null
  let dragItemSnapshot = null
  let dragPageElement = null
  let shiftHeld = false
  let dropAction = null // mobile: 'move' | 'copy'
  let touchUiDrag = false
  let lastToStory = null
  let edgeScrollRaf = null
  let lastPointerY = null
  let lastEdgeScrollTs = 0
  let placeholderBox = null

  const clearPlaceholderBox = function (el) {
    placeholderBox = null
    if (!el) return
    el.classList.remove('wiki-item-drag-sizing')
    el.style.height = ''
    el.style.minHeight = ''
    el.style.maxHeight = ''
    el.style.overflow = ''
    el.style.boxSizing = ''
    el.style.willChange = ''
  }

  const visiblePageHeightPx = function (el) {
    const page = el?.closest?.('.page')
    const viewport = window.innerHeight || 0
    if (!page) return viewport
    const r = page.getBoundingClientRect()
    const top = Math.max(r.top, 0)
    const bottom = Math.min(r.bottom, viewport)
    return Math.max(0, bottom - top)
  }

  const placeholderHeightPx = function (el) {
    const itemH = placeholderBox?.h || el?.offsetHeight || PLACEHOLDER_SLOT_PX
    if (touchUi) return Math.min(itemH, PLACEHOLDER_SLOT_PX)
    const visible = visiblePageHeightPx(el)
    const cap = Math.max(PLACEHOLDER_SLOT_PX, Math.floor(visible / 2) || PLACEHOLDER_SLOT_PX)
    return Math.min(itemH, cap)
  }

  const lockPlaceholderBox = function (el) {
    if (!el || !placeholderBox) return
    // Desktop: slot matches the item, capped at half the visible page so a
    // tall code/image block doesn't eat the column. Touch stays a compact bar.
    const h = placeholderHeightPx(el)
    el.classList.add('wiki-item-drag-sizing')
    el.style.boxSizing = 'border-box'
    el.style.height = `${h}px`
    el.style.minHeight = `${h}px`
    el.style.maxHeight = `${h}px`
    el.style.overflow = 'hidden'
  }

  // Keep the slot from collapsing when Sortable hides children, without
  // clipping the still-visible item (no overflow/max-height/explicit height).
  const reserveSlotMinHeight = function (el) {
    if (!el || !placeholderBox) return
    if (touchUi) return
    el.style.boxSizing = 'border-box'
    el.style.minHeight = `${placeholderBox.h}px`
  }

  const cancelDrag = function (e) {
    if (e.which === 27 && storyEl._wikiSortable) {
      dragCancelled = true
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    }
  }

  const refreshDesktopCopyPreview = function () {
    if (touchUiDrag) return
    const $drag = $(document.querySelector('.wiki-item-drag, .sortable-fallback.item'))
    if (!$drag.length) return
    if (!$drag.data('pageElement') && dragPageElement) $drag.data('pageElement', dragPageElement)
    if (!$drag.data('item') && dragItemSnapshot) $drag.data('item', $.extend({}, dragItemSnapshot))
    // Prefer current hover target; fall back to source story so Shift works before first onMove.
    const toStory = lastToStory || (dragPageElement && dragPageElement.find('.story')[0])
    if (!toStory) return
    updateCursor({ shiftKey: shiftHeld }, $drag, toStory)
  }

  const onShiftKey = function (e) {
    if (e.key !== 'Shift') return
    shiftHeld = e.type === 'keydown'
    if (lastEvent && typeof lastEvent === 'object') {
      try {
        lastEvent = { ...lastEvent, shiftKey: shiftHeld }
      } catch (_) {
        /* ignore */
      }
    }
    refreshDesktopCopyPreview()
  }

  const hideDropChooser = function () {
    const el = document.getElementById(DROP_CHOOSER_ID)
    if (!el) return
    el.classList.remove('is-active')
    el.setAttribute('aria-hidden', 'true')
    el.querySelectorAll('.wiki-item-drop-choice').forEach(n => n.classList.remove('is-hot', 'is-unavailable'))
  }

  const updateDropChooser = function (clientX, clientY, $item, $toStory) {
    if (!touchUiDrag) {
      hideDropChooser()
      return
    }
    const $sourcePage = $item.data('pageElement')
    const $destinationPage = $($toStory).closest('.page')
    if (!$sourcePage?.length || !$destinationPage?.length) {
      hideDropChooser()
      return
    }
    const moveWithinPage = equals($sourcePage, $destinationPage)
    const destinationIsGhost = $destinationPage.hasClass('ghost')
    const sourceIsReadOnly = $sourcePage.hasClass('ghost') || $sourcePage.hasClass('remote')
    const isDuplicatePage =
      !moveWithinPage && $sourcePage.attr('id') === $destinationPage.attr('id') && !sourceIsReadOnly

    // Same-page reorder: no choice. Ghost destinations: invalid.
    if (moveWithinPage || destinationIsGhost) {
      hideDropChooser()
      return
    }

    const pageEl = $destinationPage[0]
    const pageRect = pageEl.getBoundingClientRect()
    const ghost = pageEl.querySelector('.item-placeholder')
    const ghostRect = ghost?.getBoundingClientRect()
    const el = ensureDropChooser()
    el.classList.add('is-active')
    el.setAttribute('aria-hidden', 'false')

    // Park a Move | Copy strip on the destination page near the insert slot
    // so left vs right of the drop target picks the action.
    const width = Math.max(120, pageRect.width - 16)
    const left = pageRect.left + (pageRect.width - width) / 2
    let top
    if (ghostRect) {
      top = Math.max(8, ghostRect.top - 58)
    } else if (typeof clientY === 'number') {
      top = Math.min(Math.max(pageRect.top + 8, clientY - 72), pageRect.bottom - 64)
    } else {
      top = pageRect.top + 8
    }
    el.style.width = `${width}px`
    el.style.transform = `translate(${left}px, ${top}px)`

    const moveBtn = el.querySelector('[data-action="move"]')
    const copyBtn = el.querySelector('[data-action="copy"]')
    // Duplicate lineup pages can only copy (same as Shift on desktop).
    const moveUnavailable = sourceIsReadOnly || isDuplicatePage
    moveBtn?.classList.toggle('is-unavailable', moveUnavailable)

    let action = null
    if (typeof clientX === 'number') {
      // Prefer explicit chip hit; otherwise split the destination page left/right.
      for (const node of el.querySelectorAll('.wiki-item-drop-choice:not(.is-unavailable)')) {
        const r = node.getBoundingClientRect()
        if (clientX >= r.left && clientX <= r.right && typeof clientY === 'number' && clientY >= r.top - 12 && clientY <= r.bottom + 40) {
          action = node.getAttribute('data-action')
          break
        }
      }
      if (!action && clientX >= pageRect.left && clientX <= pageRect.right) {
        const mid = pageRect.left + pageRect.width / 2
        action = clientX < mid ? 'move' : 'copy'
      }
    }
    if (action === 'move' && moveUnavailable) action = 'copy'
    if (!action) action = moveUnavailable ? 'copy' : 'move'
    dropAction = action
    moveBtn?.classList.toggle('is-hot', action === 'move')
    copyBtn?.classList.toggle('is-hot', action === 'copy')
  }

  const eventXY = e => {
    if (!e) return { x: null, y: null }
    if (typeof e.clientX === 'number') return { x: e.clientX, y: e.clientY }
    const t = e.touches?.[0] || e.changedTouches?.[0]
    return { x: t?.clientX ?? null, y: t?.clientY ?? null }
  }

  // Mobile pages often scroll via .main (page itself may not be the scroller).
  // Keep scrolling while the finger rests in the edge zone (not only on move events).
  // Ramp: slow in the zone, then faster toward the actual top/bottom extent.
  const VERT_EDGE_PX = 96
  const VERT_SCROLL_PX_PER_SEC = 900

  const stopEdgeScroll = function () {
    if (edgeScrollRaf != null) {
      cancelAnimationFrame(edgeScrollRaf)
      edgeScrollRaf = null
    }
    lastEdgeScrollTs = 0
  }

  const edgeScrollTick = function (ts) {
    edgeScrollRaf = null
    if (!touchUiDrag || typeof lastPointerY !== 'number') return
    if (!lastEdgeScrollTs) lastEdgeScrollTs = ts
    const dt = Math.min(0.05, (ts - lastEdgeScrollTs) / 1000)
    lastEdgeScrollTs = ts

    const candidates = []
    const page = dragPageElement?.[0]
    if (page) candidates.push(page)
    const main = document.querySelector('.main')
    if (main) candidates.push(main)
    pages.applyVertEdgeScroll(candidates, lastPointerY, dt, VERT_EDGE_PX, VERT_SCROLL_PX_PER_SEC)
    pullPlaceholderToStartIfAbove(lastPointerY)

    if (touchUiDrag) edgeScrollRaf = requestAnimationFrame(edgeScrollTick)
  }

  const ensureEdgeScroll = function () {
    if (!touchUiDrag) return
    if (edgeScrollRaf != null) return
    lastEdgeScrollTs = 0
    edgeScrollRaf = requestAnimationFrame(edgeScrollTick)
  }

  const onDragPointerMove = function (e) {
    if (!touchUiDrag) return
    const { y } = eventXY(e)
    if (typeof y === 'number') {
      lastPointerY = y
      ensureEdgeScroll()
      pullPlaceholderToStartIfAbove(y)
    }
  }

  // Finger above the first item (page header, story padding) must still land
  // first — Sortable only hit-tests inside the list, so that zone was tiny.
  const pullPlaceholderToStartIfAbove = function (y) {
    const story = dragPageElement?.[0]?.querySelector?.('.story')
    if (!story || typeof y !== 'number') return false
    const placeholder = [...story.children].find(el => el.classList.contains('item-placeholder'))
    if (!placeholder) return false
    const first = [...story.children].find(
      el =>
        el.classList.contains('item') &&
        !el.classList.contains('item-placeholder') &&
        !el.classList.contains('shadow-copy'),
    )
    if (!first) return false
    if (y >= first.getBoundingClientRect().top + 48) return false
    if (placeholder.nextElementSibling !== first) story.insertBefore(placeholder, first)
    return true
  }

  // Snapshot layout size on press, before Sortable sets will-change
  // (that plus the overflowing edit pencil inflates the gray drop slot).
  const onHandlePointerDown = function (e) {
    const item = e.target?.closest?.('.item')
    if (!item || !storyEl.contains(item) || item.classList.contains('shadow-copy')) return
    if (touchUi) {
      const handle = e.target?.closest?.(`.${HANDLE_CLASS}`)
      if (!handle || !item.contains(handle)) return
      item.classList.add('wiki-item-drag-sizing')
    }
    placeholderBox = { h: item.offsetHeight, w: item.offsetWidth }
  }
  const onHandlePointerUp = function (e) {
    if (Sortable.active || touchUiDrag) return
    storyEl.querySelectorAll('.wiki-item-drag-sizing').forEach(el => clearPlaceholderBox(el))
    const item = e.target?.closest?.('.item')
    if (item && storyEl.contains(item) && !item.classList.contains('item-placeholder')) {
      clearPlaceholderBox(item)
    } else {
      placeholderBox = null
    }
  }
  storyEl._wikiPlaceholderLock = onHandlePointerDown
  storyEl._wikiPlaceholderUnlock = onHandlePointerUp
  storyEl.addEventListener('pointerdown', onHandlePointerDown, true)
  storyEl.addEventListener('pointerup', onHandlePointerUp, true)
  storyEl.addEventListener('pointercancel', onHandlePointerUp, true)

  const sortable = Sortable.create(storyEl, {
    // Desktop: classic move/shadow-copy + edit-gated. Avoid Sortable delay —
    // delay + fallbackTolerance cancels any real mouse drag before it starts.
    // Mobile: handle + Move/Copy chooser (unchanged).
    animation: 0,
    handle: touchUi ? `.${HANDLE_CLASS}` : undefined,
    delay: 0,
    distance: touchUi ? 0 : 5,
    forceFallback: true,
    fallbackOnBody: true,
    fallbackTolerance: touchUi ? 5 : 3,
    // Desktop: Sortable AutoScroll. Touch handle-drag uses our edge scroller
    // only — stacking both is why tall-item reorder felt like a slot machine.
    scroll: touchUi ? false : true,
    bubbleScroll: !touchUi,
    forceAutoScrollFallback: !touchUi,
    scrollSensitivity: 100,
    scrollSpeed: 25,
    // .shadow-copy keeps .item for looks but must not be sortable.
    draggable: '.item:not(.shadow-copy)',
    filter: 'a, button, input, textarea, .item-action-toolbar, .item-edit-button',
    preventOnFilter: false,
    // Tall items (code, images): swap on the edges so you drop *between* them,
    // not after crossing their midline. Sortable default invertSwap is false.
    invertSwap: true,
    // Full swap zone. Touch used 0.2 to stop autoscroll flip-flop; Sortable
    // scroll is off on touch now, and a tiny seam made the grey slot lag the finger.
    invertedSwapThreshold: 1,
    // Empty .story is often ~0px tall; default 5px makes cross-page drops miss.
    emptyInsertThreshold: 48,
    // Desktop: full item follows the cursor (transparent helper). Touch: ⋮⋮
    // handle, same-page only; helper is a faded full-size clone over the slot.
    ghostClass: 'item-placeholder',
    chosenClass: 'wiki-item-chosen',
    dragClass: 'wiki-item-drag',
    group: {
      name: 'wiki-story',
      pull(to, from, dragEl, evt) {
        // Desktop: always move in the DOM; Shift-copy restores via .shadow-copy
        // (classic jQuery UI semantics). Mobile handle-drag is same-page only.
        if (!touchUi) return true
        if (to !== from) return false
        return true
      },
      // Never accept a dragged .page (or anything that isn't a story item).
      // Touch: handle reorders within this story only — cross-page is long-press.
      put(to, from, dragEl) {
        if (!(dragEl && dragEl.classList && dragEl.classList.contains('item') && !dragEl.classList.contains('shadow-copy'))) {
          return false
        }
        if (touchUi && to !== from) return false
        return true
      },
    },
    // wiki ✔︎ / edit toggle gates dragging. Touch uses the ⋮⋮ handle for same-page
    // reorder; long-press on a selected item owns cross-page move/copy.
    disabled: !isEditOn(),
    onChoose(evt) {
      const el = evt.item
      if (!el) return
      // Do not lock overflow/height here: desktop has a 5px distance threshold,
      // so the item stays visible under the cursor and would look cropped.
      if (!placeholderBox) {
        placeholderBox = { h: el.offsetHeight, w: el.offsetWidth }
      }
      // Sortable sets will-change:all on pointerdown; that shifts layout.
      // The fallback clone does not need it on the still-visible origin item.
      el.style.willChange = 'auto'
      reserveSlotMinHeight(el)
    },
    onUnchoose(evt) {
      clearPlaceholderBox(evt.item)
    },
    onStart(evt) {
      // Sortable clones after the slot is height-locked; undo that on the helper
      // so captions / extra plugin chrome aren't clipped while dragging.
      // Desktop and touch: full-size clone, transparent background. Touch used
      // to empty the helper (chess/activity layout cost); keep it see-through
      // instead so the grey insert slot stays visible underneath.
      const unlockHelper = () => {
        const helper = document.querySelector('.sortable-fallback.item, .wiki-item-drag')
        if (!helper) return
        helper.style.height = 'auto'
        helper.style.maxHeight = 'none'
        helper.style.overflow = 'visible'
      }
      unlockHelper()
      requestAnimationFrame(unlockHelper)
      try {
        require('./editor').noteDragStarted()
      } catch (_) {
        /* optional */
      }
      // While an item is dragging, disable page lineup so items can't insert as pages.
      try {
        pages.setPageSortableEnabled(false)
      } catch (_) {
        /* optional */
      }
      const $item = $(evt.item)
      originalOrder = getStoryItemOrder(evt.from)
      originalIndex = $('.item').index($item)
      dragCancelled = false
      lastEvent = evt.originalEvent
      shiftHeld = !!evt.originalEvent?.shiftKey
      dropAction = null
      touchUiDrag = touchUi
      if (touchUi) document.body.classList.add('wiki-item-handle-drag')
      dragItemSnapshot = $.extend({}, getItem($item))
      dragPageElement = $item.data('pageElement')
      $('body').on('keydown', cancelDrag)
      document.addEventListener('keydown', onShiftKey)
      document.addEventListener('keyup', onShiftKey)
      if (touchUi) {
        document.addEventListener('pointermove', onDragPointerMove)
        document.addEventListener('touchmove', onDragPointerMove, { passive: true })
        const { y } = eventXY(evt.originalEvent)
        if (typeof y === 'number') lastPointerY = y
        ensureEdgeScroll()
      }
      lastToStory = null
      // Desktop: park a shadow-copy at the origin index. Hidden for moves so the
      // item actually leaves; shown for Shift-copy. Clone before locking slot
      // height so the parked copy isn't sized as the grey insert slot.
      if (!touchUi) {
        const from = evt.from
        const originIndex = evt.oldIndex
        const itemEl = evt.item
        const $shadow = $item
          .clone()
          .removeClass(
            'item-placeholder wiki-item-chosen wiki-item-drag wiki-item-drag-sizing handle-selected toolbar-active is-copy-preview',
          )
          .addClass('shadow-copy')
          .removeAttr('data-id')
          .css({ width: '', height: '', minHeight: '', maxHeight: '', overflow: '', position: '', zIndex: '', display: 'none' })
        const shadowEl = $shadow[0]
        if (from && itemEl.parentNode === from) {
          // Park after the ghost; when it leaves, the copy stays at origin.
          from.insertBefore(shadowEl, itemEl.nextSibling)
        } else if (from && typeof originIndex === 'number') {
          const ref = from.children[originIndex]
          if (ref) from.insertBefore(shadowEl, ref)
          else from.appendChild(shadowEl)
        } else {
          $shadow.insertAfter($item)
        }
        $('body').css('cursor', 'move')
        $('.shadow-copy').hide().removeClass('is-copy-preview')
        // If Shift was already down at drag start and we leave the page, preview copy.
        if (shiftHeld) refreshDesktopCopyPreview()
      }
      lockPlaceholderBox(evt.item)
    },
    onMove(evt, originalEvent) {
      // Extra guard: pages must never nest into a story list; items never into .main.
      if (evt.dragged?.classList?.contains('page')) return false
      if (evt.to?.classList?.contains('main')) return false
      lastEvent = originalEvent
      if (originalEvent && typeof originalEvent.shiftKey === 'boolean') {
        shiftHeld = originalEvent.shiftKey
      }
      const $item = $(evt.dragged)
      if (!$item.data('pageElement') && dragPageElement) {
        $item.data('pageElement', dragPageElement)
      }
      if (!$item.data('item') && dragItemSnapshot) {
        $item.data('item', $.extend({}, dragItemSnapshot))
      }
      const $destPage = $(evt.to).closest('.page')
      // Same-page handle reorder on a ghost is allowed; cross-page stays no-drop.
      if ($destPage.hasClass('ghost') && evt.from !== evt.to) return false
      // Mobile handle: same story only (cross-page is long-press lineup drag).
      if (touchUiDrag && evt.from && evt.to && evt.from !== evt.to) {
        hideDropChooser()
        return false
      }
      if (touchUiDrag) {
        const y =
          typeof originalEvent?.clientY === 'number'
            ? originalEvent.clientY
            : originalEvent?.touches?.[0]?.clientY
        if (typeof y === 'number' && pullPlaceholderToStartIfAbove(y)) return false
      }
      const $sourcePage = $item.data('pageElement')
      const shifting = !!(originalEvent?.shiftKey || shiftHeld)
      // Desktop: block drop onto a duplicate of the same page unless Shift (copy).
      if (
        $sourcePage &&
        !$sourcePage.is($destPage) &&
        $sourcePage.attr('id') === $destPage.attr('id') &&
        !shifting &&
        !touchUiDrag
      ) {
        return false
      }
      lastToStory = evt.to
      if (!touchUiDrag) {
        updateCursor({ shiftKey: shifting }, $item, evt.to)
        const ghost =
          (evt.dragged?.classList?.contains('item-placeholder') && evt.dragged) ||
          evt.to?.querySelector?.('.item-placeholder') ||
          evt.from?.querySelector?.('.item-placeholder')
        if (ghost) lockPlaceholderBox(ghost)
      }
      return true
    },
    onEnd(evt) {
      document.body.classList.remove('wiki-item-handle-drag')
      $('body').css('cursor', origCursor).off('keydown', cancelDrag)
      $('.wiki-item-drag, .sortable-fallback.item').css('cursor', '')
      document.removeEventListener('keydown', onShiftKey)
      document.removeEventListener('keyup', onShiftKey)
      document.removeEventListener('pointermove', onDragPointerMove)
      document.removeEventListener('touchmove', onDragPointerMove)
      stopEdgeScroll()
      lastPointerY = null
      const $item = $(evt.item)
      if (!$item.data('pageElement') && dragPageElement) {
        $item.data('pageElement', dragPageElement)
      }
      if (!$item.data('item') && dragItemSnapshot) {
        $item.data('item', $.extend({}, dragItemSnapshot))
      }
      const oe = lastEvent || {}
      // Desktop: trust live Shift tracking (keydown/keyup + onMove). Avoid stale
      // event objects that can keep shiftKey stuck true after a prior copy drag.
      let shiftKey = touchUiDrag ? !!(oe.shiftKey || shiftHeld) : !!shiftHeld
      let pullMode = evt.pullMode
      // Desktop never uses Sortable clone-pull; keep classic shadow-copy semantics.
      if (!touchUiDrag) {
        pullMode = undefined
        // Final mouseup may still include shiftKey even if our tracker missed it.
        if (evt.originalEvent && typeof evt.originalEvent.shiftKey === 'boolean') {
          shiftKey = evt.originalEvent.shiftKey || shiftHeld
        }
      }
      // Mobile cross-page: Move/Copy chooser overrides shift semantics.
      if (touchUiDrag && dropAction && evt.from !== evt.to) {
        shiftKey = dropAction === 'copy'
        // If Sortable already moved (not cloned) but user wants copy, handleDrop's
        // non-clone copy path promotes .shadow-copy back into the source.
        if (dropAction === 'copy' && pullMode !== 'clone') {
          pullMode = undefined
          shiftKey = true
        }
        if (dropAction === 'move') {
          shiftKey = false
        }
      }
      hideDropChooser()
      const revert = () => {
        if (evt.from && evt.oldIndex != null) {
          const ref = evt.from.children[evt.oldIndex]
          if (ref) evt.from.insertBefore(evt.item, ref)
          else evt.from.appendChild(evt.item)
        }
      }
      // If an item somehow landed under .main (page lineup), put it back in its story.
      if ($item.parent().hasClass('main')) {
        revert()
      }
      const crossed = evt.from !== evt.to
      const reordered = evt.oldIndex !== evt.newIndex
      if (dragCancelled) {
        revert()
      } else if (crossed || reordered) {
        handleDrop(oe, $item, originalIndex, originalOrder, {
          shiftKey,
          revert,
          pullMode,
        })
      }
      $('.shadow-copy').remove()
      clearPlaceholderBox(evt.item)
      dragItemSnapshot = null
      dragPageElement = null
      shiftHeld = false
      dropAction = null
      touchUiDrag = false
      lastToStory = null
      try {
        pages.setPageSortableEnabled(true)
      } catch (_) {
        /* optional */
      }
    },
  })

  storyEl._wikiSortable = sortable
  return sortable
}

const setStorySortableEnabled = function (enabled) {
  // Touch: ⋮⋮ handle uses Sortable for same-page reorder; long-press disables this
  // while the lineup cross-page gesture runs.
  const on = !!enabled && isEditOn()
  $('.page .story').each(function () {
    if (this._wikiSortable) {
      this._wikiSortable.option('disabled', !on)
    }
  })
}

// --- item chrome (was itemHandle.js) ---

// Drag handles + edit pencil for story items — touch/coarse edit mode only.
// Desktop keeps whole-item drag (stock UX). On touch: tap an item to show a
// drag handle and edit pencil; handle reorders on-page, long-press moves/copies.

const HANDLE_CLASS = 'item-drag-handle'
const EDIT_CLASS = 'item-edit-button'
const CHROME_CLASS = 'item-chrome'

const HANDLE_HTML = `<div class="${HANDLE_CLASS}" title="Drag to reorder" aria-label="Drag to reorder">⋮⋮</div>`
const EDIT_HTML = `<button type="button" class="${EDIT_CLASS}" title="Edit" aria-label="Edit">✎</button>`
const CHROME_HTML = `<div class="${CHROME_CLASS}">${HANDLE_HTML}${EDIT_HTML}</div>`

// ⋮⋮ + pencil stack. Used when placing the grab handle in a short visible slice.
const HANDLE_HEIGHT_PX = 44

const overflowClips = v =>
  v === 'auto' || v === 'scroll' || v === 'hidden' || v === 'clip' || v === 'overlay'

// Visible window for the chrome: visual viewport ∩ every overflow ancestor
// (.page, .main, …). .page often grows with content while .main actually scrolls.
const visibleClipFor = item => {
  const vv = window.visualViewport
  const clip = {
    top: vv ? vv.offsetTop : 0,
    bottom: vv ? vv.offsetTop + vv.height : window.innerHeight,
  }
  let el = item.parentElement
  while (el && el !== document.documentElement) {
    const st = getComputedStyle(el)
    if (overflowClips(st.overflowY) || overflowClips(st.overflowX)) {
      const r = el.getBoundingClientRect()
      clip.top = Math.max(clip.top, r.top)
      clip.bottom = Math.min(clip.bottom, r.bottom)
    }
    el = el.parentElement
  }
  return clip
}

// Prefer body class: .editEnable is clipped/hidden on mobile even when editing is on.
const isEditOn = () =>
  document.body.classList.contains('fedwiki-edit-mode') || $('.editEnable').is(':visible')

// Prefer pointer capability over viewport width (matches mobile refactor rules).
const needsDragHandle = () => window.matchMedia('(hover: none), (pointer: coarse)').matches

let selectedId = null
let pinBound = false
let pinRaf = null
let pinObserver = null
let pinItem = null

const itemId = ($item) => $item?.attr?.('data-id') || $item?.data?.('id') || null

const chromeSelector = `.${CHROME_CLASS}, .${HANDLE_CLASS}, .${EDIT_CLASS}`

const setLocalTop = (el, viewportY, fallbackParent) => {
  const parent = el.offsetParent || fallbackParent
  const pr = parent.getBoundingClientRect()
  const scaleY = pr.height ? parent.offsetHeight / pr.height : 1
  el.style.top = `${(viewportY - pr.top) * scaleY + (parent.scrollTop || 0)}px`
}

const pinSelectedChrome = function () {
  const item = document.querySelector('.item.handle-selected')
  const chrome = item?.querySelector(`.${CHROME_CLASS}`)
  const handle = item?.querySelector(`.${HANDLE_CLASS}`)
  const edit = item?.querySelector(`.${EDIT_CLASS}`)
  if (!item || !chrome || !handle) return

  const itemRect = item.getBoundingClientRect()
  const clip = visibleClipFor(item)
  const visibleBottom = Math.min(clip.bottom, itemRect.bottom)
  // Sit at the visible top of the item — not the item's own top (may be off-screen).
  // Keep the grab handle inside the visible slice even when that slice is shorter
  // than the pencil stack (old maxInset left the buttons above the viewport).
  let y = Math.max(clip.top, itemRect.top)
  if (y + HANDLE_HEIGHT_PX > visibleBottom) {
    y = Math.max(itemRect.top, visibleBottom - HANDLE_HEIGHT_PX)
  }

  // Pin the wrapper; if handles are positioned against the item instead of the
  // wrapper (static chrome), pin those too so they cannot stay at the item top.
  setLocalTop(chrome, y, item)
  if (handle.offsetParent !== chrome) {
    setLocalTop(handle, y, item)
    if (edit) setLocalTop(edit, y + 48, item)
  }
}

const schedulePin = function () {
  if (pinRaf != null) return
  if (
    document.body.classList.contains('wiki-item-handle-drag') ||
    document.body.classList.contains('wiki-item-lineup-dragging')
  ) {
    return
  }
  pinRaf = requestAnimationFrame(() => {
    pinRaf = null
    pinSelectedChrome()
  })
}

const bindPin = function () {
  if (pinBound) return
  pinBound = true
  document.addEventListener('scroll', schedulePin, true)
  window.addEventListener('scroll', schedulePin)
  window.addEventListener('resize', schedulePin)
  window.visualViewport?.addEventListener('resize', schedulePin)
  window.visualViewport?.addEventListener('scroll', schedulePin)
  if (typeof ResizeObserver === 'function') {
    pinObserver = new ResizeObserver(schedulePin)
    pinObserver.observe(document.documentElement)
  }
}

const clearChrome = ($item) => {
  if (pinObserver && pinItem && (!$item?.length || $item[0] === pinItem)) {
    pinObserver.unobserve(pinItem)
    pinItem = null
  }
  if ($item?.length) {
    $item.children(chromeSelector).remove()
    $item.removeClass('handle-selected')
  } else {
    $(chromeSelector).remove()
    $('.item.handle-selected').removeClass('handle-selected')
  }
}

const clear = function () {
  selectedId = null
  clearChrome()
}

const mountChrome = function ($item) {
  clearChrome($item)
  $item.addClass('handle-selected')
  // Overlay wrapper — absolute inside the item, JS-pinned to the visible top so
  // tall items (chess, activity) still show handle + pencil when you tap the bottom.
  $item.prepend(CHROME_HTML)
  bindPin()
  const item = $item[0]
  if (pinObserver && item) {
    if (pinItem && pinItem !== item) pinObserver.unobserve(pinItem)
    pinItem = item
    pinObserver.observe(item)
  }
  pinSelectedChrome()
  requestAnimationFrame(pinSelectedChrome)
  requestAnimationFrame(() => requestAnimationFrame(pinSelectedChrome))
}

const select = function ($item) {
  if (!$item?.length) return null
  if (!isEditOn() || !needsDragHandle() || $item.hasClass('textEditing')) {
    clear()
    return null
  }
  const id = itemId($item)
  if (!id) return null
  selectedId = id
  $(chromeSelector).remove()
  $('.item.handle-selected').removeClass('handle-selected')
  mountChrome($item)
  return $item
}

const ensure = function ($item) {
  if (!$item || !$item.length) return $item
  clearChrome($item)
  const id = itemId($item)
  const isSelected = selectedId && id && String(selectedId) === String(id)
  if (isSelected && isEditOn() && needsDragHandle() && !$item.hasClass('textEditing')) {
    mountChrome($item)
  }
  return $item
}

const clearContent = function ($item) {
  $item.children().not(chromeSelector).remove()
  return $item
}

const getSelectedId = () => selectedId

// --- cross-page item drag (was itemLineupDrag.js) ---

// - drag the ⋮⋮ handle → same-page reorder (SortableJS owns that)
// - long-press the selected item → shrink lineup and move/copy across pages


const DRAGGING = 'wiki-item-lineup-dragging'
const HELPER_ID = 'wiki-item-lineup-helper'
const OVERLAY_ID = 'wiki-item-lineup-overlay'
const PLACEHOLDER_CLASS = 'wiki-item-lineup-placeholder'
const ORIGIN_CLASS = 'wiki-item-lineup-origin'
const ORIGIN_HIDDEN = 'wiki-item-lineup-origin-hidden'
const ORIGIN_COPY = 'wiki-item-lineup-origin-copy'

// Long-press on the selected item body (not the handle).
const LONG_PRESS_MS = 380
// Finger jitter during a hold — cancel long-press once the user clearly pans.
// Keep this small: during native scroll, pointermove often stops delivering, so
// we also cancel on scroll/touchmove below.
const BODY_SLOP_PX = 36
const VERT_EDGE_PX = 96
const VERT_SCROLL_PX_PER_SEC = 720
// Compact insert bar (not the dragged item's height). Helper is a 20% ghost.
const DRAG_PREVIEW_SCALE = 0.2

const ensureHelper = function () {
  let el = document.getElementById(HELPER_ID)
  if (el) return el
  el = document.createElement('div')
  el.id = HELPER_ID
  el.className = 'wiki-item-lineup-helper wiki-item-drag item'
  el.setAttribute('aria-hidden', 'true')
  document.body.appendChild(el)
  return el
}

const ensureOverlay = function () {
  let el = document.getElementById(OVERLAY_ID)
  if (el) return el
  el = document.createElement('div')
  el.id = OVERLAY_ID
  el.className = 'wiki-item-lineup-overlay'
  el.setAttribute('aria-hidden', 'true')
  el.innerHTML =
    `<div class="wiki-item-lineup-half wiki-item-lineup-half-move" data-action="move">` +
    `<span class="wiki-item-lineup-half-icon">${MOVE_SVG}</span>` +
    `<span class="wiki-item-lineup-half-label">Move</span></div>` +
    `<div class="wiki-item-lineup-half wiki-item-lineup-half-copy" data-action="copy">` +
    `<span class="wiki-item-lineup-half-icon">${COPY_SVG}</span>` +
    `<span class="wiki-item-lineup-half-label">Copy</span></div>`
  document.body.appendChild(el)
  return el
}

const ensurePlaceholder = function () {
  let el = document.querySelector(`.${PLACEHOLDER_CLASS}`)
  if (el) return el
  el = document.createElement('div')
  el.className = `${PLACEHOLDER_CLASS} item-placeholder`
  el.setAttribute('aria-hidden', 'true')
  return el
}

let suppressItemClickUntil = 0

const shouldSuppressItemClick = () => performance.now() < suppressItemClickUntil

const bindLineupItemDrag = function () {
  let pending = null
  let session = null

  const mainEl = () => pages.lineupMain()

  const cancelPending = function () {
    if (!pending) return
    if (pending.raf != null) cancelAnimationFrame(pending.raf)
    pending.$item?.[0]?.classList?.remove('wiki-longpress-pending')
    pending = null
  }

  const pageNodes = () => pages.pageNodesIn(mainEl())
  const instantCenterEl = el => pages.centerInMain(el, mainEl())
  const nearestPageIndex = () => pages.nearestPageIndexIn(mainEl())
  const ensureSpacers = () => pages.ensureLineupSpacers(session, mainEl())
  const removeSpacers = () => pages.removeLineupSpacers(session)
  const edgeScrollSpeed = clientX => pages.edgeScrollForX(clientX, mainEl())

  const stopEdgeScroll = function () {
    if (session?.edgeRaf != null) {
      cancelAnimationFrame(session.edgeRaf)
      session.edgeRaf = null
    }
  }

  const edgeTick = function (ts) {
    if (!session) return
    session.edgeRaf = null
    if (!session.lastScrollTs) session.lastScrollTs = ts
    const dt = Math.min(0.05, (ts - session.lastScrollTs) / 1000)
    session.lastScrollTs = ts

    const { dir, speed } = edgeScrollSpeed(session.pointerX)
    const main = mainEl()
    if (main && dir && speed > 0) {
      main.scrollLeft += dir * speed * dt
    }

    const candidates = []
    const dest = session.$destPage?.[0]
    if (dest) candidates.push(dest)
    if (main) candidates.push(main)
    pages.applyVertEdgeScroll(candidates, session.pointerY, dt, VERT_EDGE_PX, VERT_SCROLL_PX_PER_SEC)

    updateHoverUi()
    session.edgeRaf = requestAnimationFrame(edgeTick)
  }

  const moveHelper = function (x, y) {
    const helper = document.getElementById(HELPER_ID)
    if (!helper?.classList.contains('is-active') || !session) return
    if (typeof x !== 'number' || typeof y !== 'number') return
    const ox = session.grabOffsetX ?? 24
    const oy = session.grabOffsetY ?? 16
    const scale = DRAG_PREVIEW_SCALE
    helper.style.transform = `translate(${x - ox * scale}px, ${y - oy * scale}px) scale(${scale})`
  }

  const syncOriginVisibility = function (copying) {
    if (!session?.$item?.length) return
    session.$item.toggleClass(ORIGIN_HIDDEN, !copying)
    session.$item.toggleClass(ORIGIN_COPY, !!copying)
  }

  const dropClipBottom = function () {
    const footer = document.querySelector('footer')
    const footerTop = footer ? footer.getBoundingClientRect().top : window.innerHeight
    return Math.max(0, footerTop - 6)
  }

  const findInsertBefore = function (pageEl, clientY) {
    const story = pageEl.querySelector('.story')
    if (!story) return { $before: $(), markerParent: null, markerRef: null }
    const items = [
      ...story.querySelectorAll(`:scope > .item:not(.${ORIGIN_CLASS}):not(.${PLACEHOLDER_CLASS})`),
    ]
    if (!items.length) return { $before: $(), markerParent: story, markerRef: story.firstChild }

    const clipBottom = dropClipBottom()
    const storyRect = story.getBoundingClientRect()
    // Do not clamp Y upward — that forced "below first item" when the first
    // item's midpoint sat above the finger / visible band.
    let y = typeof clientY === 'number' ? clientY : storyRect.top
    y = Math.min(y, Math.min(storyRect.bottom - 2, clipBottom))

    const first = items[0]
    const firstRect = first.getBoundingClientRect()
    // Generous top hit target so "drop at start of page" is reachable.
    const topZone = firstRect.top + Math.max(28, Math.min(48, firstRect.height * 0.4))
    if (y < topZone) {
      return { $before: $(), markerParent: story, markerRef: first }
    }

    let $before = $()
    let markerRef = first
    for (const el of items) {
      const r = el.getBoundingClientRect()
      const mid = r.top + r.height / 2
      if (y >= mid) {
        $before = $(el)
        markerRef = el.nextSibling
      } else {
        markerRef = el
        break
      }
    }
    return { $before, markerParent: story, markerRef }
  }

  const updateHoverUi = function () {
    if (!session) return
    const nodes = pageNodes()
    const i = nearestPageIndex()
    const pageEl = i >= 0 ? nodes[i] : null
    session.$destPage = pageEl ? $(pageEl) : $()
    session.action = 'move'
    session.$before = $()

    const overlay = document.getElementById(OVERLAY_ID)
    const placeholder = ensurePlaceholder()
    if (!pageEl || pageEl.classList.contains('ghost')) {
      overlay?.classList.remove('is-active', 'labels-above', 'labels-below', 'move-only')
      placeholder.remove()
      syncOriginVisibility(false)
      return
    }

    const story = pageEl.querySelector('.story')
    const pr = (story || pageEl).getBoundingClientRect()
    const clipBottom = dropClipBottom()
    const top = Math.max(0, Math.round(pr.top))
    const bottom = Math.min(Math.round(pr.bottom), clipBottom)
    const height = Math.max(0, bottom - top)
    if (height < 24) {
      overlay?.classList.remove('is-active', 'move-only')
      placeholder.remove()
      return
    }

    // Same page the drag started from: move only (desktop parity — no same-page copy).
    const sourceEl = session.$item?.closest?.('.page')?.[0]
    const sameSourcePage = !!(sourceEl && pageEl === sourceEl)
    const midX = pr.left + pr.width / 2
    const wantCopy =
      !sameSourcePage && typeof session.pointerX === 'number' && session.pointerX >= midX
    session.action = wantCopy ? 'copy' : 'move'
    syncOriginVisibility(wantCopy)

    // Keep Move/Copy badges off the finger so the insert slot under it stays usable.
    const fingerY = typeof session.pointerY === 'number' ? session.pointerY : top + height / 2
    const labelsBelow = fingerY < top + height * 0.45

    if (overlay) {
      // Cover the story column exactly; fill/frame is drawn inside each half.
      overlay.style.top = `${top}px`
      overlay.style.left = `${Math.round(pr.left)}px`
      overlay.style.width = `${Math.round(pr.width)}px`
      overlay.style.height = `${height}px`
      overlay.classList.add('is-active')
      overlay.classList.toggle('move-only', sameSourcePage)
      overlay.classList.toggle('labels-below', labelsBelow)
      overlay.classList.toggle('labels-above', !labelsBelow)
      overlay.setAttribute('aria-hidden', 'false')
      overlay.querySelector('.wiki-item-lineup-half-move')?.classList.toggle('is-hot', !wantCopy)
      overlay.querySelector('.wiki-item-lineup-half-copy')?.classList.toggle('is-hot', wantCopy)
    }

    const { $before, markerParent, markerRef } = findInsertBefore(pageEl, session.pointerY)
    session.$before = $before
    const phHeight = PLACEHOLDER_SLOT_PX
    placeholder.style.height = `${phHeight}px`
    placeholder.style.minHeight = `${phHeight}px`
    placeholder.style.maxHeight = `${phHeight}px`
    if (markerParent) {
      if (markerRef) markerParent.insertBefore(placeholder, markerRef)
      else markerParent.appendChild(placeholder)
    }
  }

  const teardown = function () {
    stopEdgeScroll()
    document.removeEventListener('pointermove', onDragMove)
    document.removeEventListener('touchmove', onDragMove)
    document.removeEventListener('pointerup', onDragCommit)
    document.removeEventListener('pointercancel', onDragAbort)
    document.removeEventListener('touchend', onDragCommit)
    document.removeEventListener('mouseup', onDragCommit)
    document.removeEventListener('lostpointercapture', onDragAbort)
    window.removeEventListener('pagehide', onDragAbort)
    if (session?.captureEl && session.pointerId != null) {
      try {
        session.captureEl.releasePointerCapture?.(session.pointerId)
      } catch (_) {
        /* already released */
      }
    }
    document.getElementById(HELPER_ID)?.classList.remove('is-active')
    const helper = document.getElementById(HELPER_ID)
    if (helper) {
      helper.innerHTML = ''
      helper.removeAttribute('style')
      helper.className = 'wiki-item-lineup-helper wiki-item-drag item'
    }
    const overlay = document.getElementById(OVERLAY_ID)
    if (overlay) {
      overlay.classList.remove('is-active', 'labels-above', 'labels-below', 'move-only')
      overlay.setAttribute('aria-hidden', 'true')
    }
    document.querySelector(`.${PLACEHOLDER_CLASS}`)?.remove()
    removeSpacers()
    document.body.classList.remove(LINEUP_SHRUNK, DRAGGING)
    session?.$item?.removeClass(`${ORIGIN_CLASS} ${ORIGIN_HIDDEN} ${ORIGIN_COPY}`)
    try {
      pages.setPageSortableEnabled(true)
    } catch (_) {
      /* optional */
    }
    setStorySortableEnabled(isEditOn())
    suppressItemClickUntil = performance.now() + 450
    session = null
  }

  // After unshrink, wait two frames so layout settles, then snap the page into view.
  const landOnPage = function ($page) {
    if (!$page?.length) return
    const active = require('./active')
    active.set($page, true)
    requestAnimationFrame(() => {
      instantCenterEl($page[0])
      requestAnimationFrame(() => instantCenterEl($page[0]))
    })
  }

  const onDragMove = function (e) {
    if (!session) return
    if (session.pointerId != null && e.pointerId != null && e.pointerId !== session.pointerId) return
    let x = e.clientX
    let y = e.clientY
    if (typeof x !== 'number' && e.touches?.[0]) {
      x = e.touches[0].clientX
      y = e.touches[0].clientY
    }
    if (typeof x !== 'number') return
    session.pointerX = x
    session.pointerY = y
    session.moved = true
    moveHelper(x, y)
    updateHoverUi()
    e.preventDefault?.()
  }

  // Successful drop — only on real pointerup / touchend, never on pointercancel.
  const onDragCommit = function (e) {
    if (!session) return
    if (
      session.pointerId != null &&
      e &&
      typeof e.pointerId === 'number' &&
      e.pointerId !== session.pointerId
    ) {
      return
    }
    // Android often pairs pointercancel with a spurious touchend. Ignore that
    // so the lineup-shrink UX can stay up; a later real lift still commits.
    if (session.suppressCommitUntil && performance.now() < session.suppressCommitUntil) {
      return
    }
    const $item = session.$item
    const $source = session.$sourcePage
    const $dest = session.$destPage
    const copy = session.action === 'copy'
    const $before = session.$before
    const didMove = !!session.moved
    teardown()
    if (!didMove || !$item?.length || !$dest?.length || $dest.hasClass('ghost')) {
      select($item)
      // Ghost / invalid drop: snap back to the page the drag started on.
      landOnPage($source)
      return
    }
    placeItemOnPage($item, $dest, { copy, $before })
    try {
      require('./editor').hide({ clearSelection: true })
    } catch (_) {
      clear()
    }
    landOnPage($dest)
  }

  // Android often fires pointercancel when lineup zoom / display:none changes
  // under the finger. Keep the session; suppress the paired spurious touchend;
  // continue via touchmove/touchend. pagehide still aborts; later pointerdown
  // also unsticks.
  const onDragAbort = function (e) {
    if (!session) return
    if (session.pointerId != null && e && e.pointerId !== session.pointerId) return
    if (
      session.ignorePointerCancel &&
      e &&
      (e.type === 'pointercancel' || e.type === 'lostpointercapture')
    ) {
      session.suppressCommitUntil = performance.now() + 400
      return
    }
    const $item = session.$item
    const $source = session.$sourcePage
    teardown()
    select($item)
    landOnPage($source)
  }

  const beginDrag = function ($item, clientX, clientY, pointerId) {
    cancelPending()
    try {
      require('./editor').noteDragStarted()
    } catch (_) {
      /* optional */
    }

    const itemEl = $item[0]
    const rect = itemEl.getBoundingClientRect()
    // Capture on body — capturing on the item loses the gesture when zoom/opacity changes.
    const captureEl = document.body
    session = {
      $item,
      $sourcePage: $item.closest('.page'),
      pointerX: clientX,
      pointerY: clientY,
      pointerId,
      action: 'move',
      $destPage: $(),
      $before: $(),
      leftSpacer: null,
      rightSpacer: null,
      edgeRaf: null,
      lastScrollTs: 0,
      // Only mark moved after the finger actually travels (see onDragMove).
      moved: false,
      ignorePointerCancel: true,
      // Cover the deferred shrink window so a cancel+touchend pair cannot
      // tear down before the lineup UX appears.
      suppressCommitUntil: performance.now() + 500,
      captureEl,
      itemHeight: itemEl.offsetHeight || Math.round(rect.height),
      itemWidth: itemEl.offsetWidth || Math.round(rect.width),
      grabOffsetX: clientX - rect.left,
      grabOffsetY: clientY - rect.top,
    }

    try {
      window.getSelection()?.removeAllRanges?.()
    } catch (_) {
      /* optional */
    }
    if (typeof pointerId === 'number') {
      try {
        captureEl.setPointerCapture?.(pointerId)
      } catch (_) {
        /* optional */
      }
    }

    // Keep the origin visible until shrink + helper are up — hiding it first
    // (display:none) is what made long-press look like "the item vanished".
    $item.addClass(ORIGIN_CLASS)
    setStorySortableEnabled(false)
    try {
      pages.setPageSortableEnabled(false)
    } catch (_) {
      /* optional */
    }

    // Floating mini helper (20% scale, faded) so tall items stay easy to place.
    const helper = ensureHelper()
    helper.innerHTML = ''
    const clone = itemEl.cloneNode(true)
    clone.classList.remove(
      ORIGIN_CLASS,
      ORIGIN_HIDDEN,
      ORIGIN_COPY,
      'handle-selected',
      'toolbar-active',
      'wiki-block-chosen',
      'wiki-item-chosen',
    )
    clone
      .querySelectorAll(
        `.${CHROME_CLASS}, .${HANDLE_CLASS}, .${EDIT_CLASS}`,
      )
      .forEach(n => n.remove())
    while (clone.firstChild) helper.appendChild(clone.firstChild)
    helper.style.width = `${session.itemWidth}px`
    helper.style.minHeight = `${session.itemHeight}px`
    helper.classList.add('is-active')
    helper.setAttribute('aria-hidden', 'false')
    moveHelper(clientX, clientY)
    ensureOverlay()

    document.addEventListener('pointermove', onDragMove, { passive: false })
    document.addEventListener('touchmove', onDragMove, { passive: false })
    document.addEventListener('pointerup', onDragCommit)
    document.addEventListener('pointercancel', onDragAbort)
    document.addEventListener('touchend', onDragCommit)
    document.addEventListener('mouseup', onDragCommit)
    document.addEventListener('lostpointercapture', onDragAbort)
    window.addEventListener('pagehide', onDragAbort)

    // Defer lineup shrink so Android does not cancel the active pointer when
    // zoom/overflow would otherwise change under the finger.
    requestAnimationFrame(() => {
      if (!session) return
      document.body.classList.add(DRAGGING)
      requestAnimationFrame(() => {
        if (!session) return
        document.body.classList.add(LINEUP_SHRUNK)
        ensureSpacers()
        const srcPage = $item.closest('.page')[0]
        if (srcPage) instantCenterEl(srcPage)
        moveHelper(session.pointerX, session.pointerY)
        // Hide origin only after the shrink UX is on screen.
        syncOriginVisibility(false)
        session.edgeRaf = requestAnimationFrame(edgeTick)
        updateHoverUi()
        // Allow a real finger-up shortly after shrink settles.
        session.suppressCommitUntil = performance.now() + 200
      })
    })
  }

  const pendingTick = function () {
    if (!pending) return
    pending.raf = null
    if (performance.now() - pending.t0 >= LONG_PRESS_MS) {
      const dx = pending.x - pending.startX
      const dy = pending.y - pending.startY
      // Native scroll often stops pointermove; refuse to start a drag if the
      // finger drifted at all before the hold matured.
      if (dx * dx + dy * dy > BODY_SLOP_PX * BODY_SLOP_PX) {
        cancelPending()
        return
      }
      const { $item, x, y, pointerId } = pending
      cancelPending()
      beginDrag($item, x, y, pointerId)
      return
    }
    pending.raf = requestAnimationFrame(pendingTick)
  }

  const armPending = function ($item, e) {
    cancelPending()
    const main = mainEl()
    pending = {
      $item,
      x: e.clientX,
      y: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
      t0: performance.now(),
      raf: null,
      // Snapshot scroll so tiny rubber-band / overflow noise does not cancel the hold.
      scrollLeft: main?.scrollLeft ?? 0,
      scrollTop: main?.scrollTop ?? 0,
      pageScrollTop: $item.closest('.page')?.[0]?.scrollTop ?? 0,
    }
    // Defeat .handle-selected { touch-action: pan-y } for the hold window.
    $item[0]?.classList?.add('wiki-longpress-pending')
    try {
      e.preventDefault()
    } catch (_) {
      /* optional */
    }
    pending.raf = requestAnimationFrame(pendingTick)
  }

  // Cancel only on real scroll (past slop). Micro-jitter while holding must not
  // kill the long-press — that was why the gesture never reached beginDrag.
  document.addEventListener(
    'scroll',
    e => {
      if (!pending) return
      const main = mainEl()
      const pageEl = pending.$item?.closest?.('.page')?.[0]
      const target = e.target
      let dx = 0
      let dy = 0
      if (main && (target === main || main.contains?.(target))) {
        dx = Math.abs((main.scrollLeft ?? 0) - (pending.scrollLeft ?? 0))
        dy = Math.abs((main.scrollTop ?? 0) - (pending.scrollTop ?? 0))
      }
      if (pageEl && (target === pageEl || pageEl.contains?.(target))) {
        dy = Math.max(dy, Math.abs((pageEl.scrollTop ?? 0) - (pending.pageScrollTop ?? 0)))
      }
      if (dx < 8 && dy < 8) return
      cancelPending()
      suppressItemClickUntil = performance.now() + 350
    },
    true,
  )
  document.addEventListener(
    'touchmove',
    e => {
      if (!pending || !e.touches?.[0]) return
      const t = e.touches[0]
      const dx = t.clientX - pending.startX
      const dy = t.clientY - pending.startY
      if (dx * dx + dy * dy > BODY_SLOP_PX * BODY_SLOP_PX) {
        cancelPending()
        suppressItemClickUntil = performance.now() + 350
        return
      }
      // Within slop: block native scroll so the hold can mature into lineup drag.
      e.preventDefault()
    },
    { capture: true, passive: false },
  )

  document.addEventListener(
    'pointerdown',
    function (e) {
      // Stale pending (e.g. cancel without pointerup) must not block new holds.
      if (pending && performance.now() - pending.t0 > 900) cancelPending()
      if (pending) return
      if (session) {
        // Prior gesture lost its pointer without touchend — clear stuck state.
        const stuckItem = session.$item
        const stuckSource = session.$sourcePage
        teardown()
        select(stuckItem)
        landOnPage(stuckSource)
        return
      }
      if (!isEditOn()) return
      // Match editor chromeApplies: coarse pointer OR this event is touch.
      const touchLike =
        needsDragHandle() || e.pointerType === 'touch' || e.pointerType === 'pen'
      if (!touchLike) return
      if (e.pointerType && e.pointerType !== 'touch' && e.pointerType !== 'pen') return
      if (e.button != null && e.button !== 0) return
      const target = e.target
      if (!(target instanceof Element)) return
      // Handle is Sortable same-page reorder — do not start lineup drag from it.
      if (target.closest(`.${HANDLE_CLASS}`)) return
      if (target.closest(`.${EDIT_CLASS}, a, button, textarea, input`)) return

      const itemEl = target.closest('.page .story .item.handle-selected')
      if (!itemEl) return
      armPending($(itemEl), e)
    },
    true,
  )

  document.addEventListener(
    'pointermove',
    function (e) {
      if (!pending || e.pointerId !== pending.pointerId) return
      const dx = e.clientX - pending.startX
      const dy = e.clientY - pending.startY
      const dist2 = dx * dx + dy * dy
      pending.x = e.clientX
      pending.y = e.clientY
      if (dist2 > BODY_SLOP_PX * BODY_SLOP_PX) {
        cancelPending()
        suppressItemClickUntil = performance.now() + 350
        return
      }
      e.preventDefault?.()
    },
    { capture: true, passive: false },
  )

  const onPendingEnd = function (e) {
    if (pending && (!e || e.pointerId === pending.pointerId)) cancelPending()
  }
  // Only pointerup/touchend ends a pending hold. Android pointercancel during a
  // still finger is common when the browser thinks we might scroll.
  document.addEventListener('pointerup', onPendingEnd, true)
  document.addEventListener('touchend', onPendingEnd, true)

  document.addEventListener(
    'contextmenu',
    function (e) {
      if (!needsDragHandle()) return
      if (e.target?.closest?.('.page .story .item.handle-selected, .item-drag-handle')) {
        e.preventDefault()
      }
    },
    true,
  )
}

// ---------------------------------------------------------------------------
// Journal merge
// ---------------------------------------------------------------------------
// --- journal merge (was journalMerge.js) ---

// Journal merge via Pointer Events (replaces jQuery UI draggable/droppable).
// Desktop: drag one page's .journal onto another's → merge + fork, show ghost.
// Mobile/coarse: tap to select (outline only), long-press → shrink lineup and
// drop only onto another .journal (same merge semantics as desktop).


const SELECTED_CLASS = 'journal-selected'
const JOURNAL_SELECTED_CLASS = SELECTED_CLASS
const JOURNAL_BODY_SLOP_PX = 28
const MERGING = 'wiki-journal-merging'

const getPageObject = function (journalEl) {
  const $page = $(journalEl).parents('.page:first')
  return lineup.atKey($page.data('key'))
}

const clearJournalSelection = function () {
  document.querySelectorAll(`.journal.${SELECTED_CLASS}`).forEach((el) => {
    el.classList.remove(SELECTED_CLASS)
  })
}

const selectJournal = function ($journal) {
  if (!$journal?.length) return null
  if (!isEditOn() || !needsDragHandle()) {
    clearJournalSelection()
    return null
  }
  clear()
  clearJournalSelection()
  $journal.addClass(SELECTED_CLASS)
  return $journal
}

const isJournalSelected = (el) => !!(el && el.classList && el.classList.contains(SELECTED_CLASS))

let suppressClickUntil = 0
const shouldSuppressJournalClick = () => performance.now() < suppressClickUntil

const clearTextSelection = function () {
  try {
    window.getSelection?.()?.removeAllRanges?.()
  } catch (_) {
    /* ignore */
  }
}

const journalUnderPoint = function (x, y, selfEl) {
  const el = document.elementFromPoint(x, y)
  if (!el) return null
  const target = el.closest('.journal')
  if (!target || target === selfEl) return null
  return target
}

const clearMergeHover = function () {
  document.querySelectorAll('.journal.wiki-merge-hover').forEach((el) => {
    el.classList.remove('wiki-merge-hover')
  })
}

const commitMerge = function (sourceEl, destEl) {
  if (!sourceEl || !destEl || sourceEl === destEl) return false
  const source = getPageObject(sourceEl)
  const dest = getPageObject(destEl)
  if (!source || !dest || source === dest) return false
  pageEmitter.dispatchEvent(new CustomEvent('show', { detail: dest.merge(source) }))
  return true
}

// --- Desktop: immediate drag after 12px move (stock UX) ---

const initJournalMerge = function ($page) {
  const journalEl = $page.find('.journal')[0]
  if (!journalEl) return

  if (journalEl._wikiMergeBound) return
  journalEl._wikiMergeBound = true
  journalEl.classList.add('journal-merge-source')

  let drag = null

  const preventSelect = function (e) {
    e.preventDefault()
  }

  const cleanup = function () {
    if (!drag) return
    drag.clone?.remove()
    journalEl.classList.remove('is-dragging')
    document.body.classList.remove(MERGING)
    clearMergeHover()
    document.removeEventListener('pointermove', onMove)
    document.removeEventListener('pointerup', onUp)
    document.removeEventListener('pointercancel', onCancel)
    document.removeEventListener('selectstart', preventSelect, true)
    if (drag.pointerId != null) {
      try {
        journalEl.releasePointerCapture?.(drag.pointerId)
      } catch (_) {
        /* already released */
      }
    }
    drag = null
  }

  const onMove = function (e) {
    if (!drag || e.pointerId !== drag.pointerId) return
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    if (!drag.active) {
      if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return
      drag.active = true
      journalEl.classList.add('is-dragging')
      document.body.classList.add(MERGING)
      clearTextSelection()
      try {
        journalEl.setPointerCapture?.(drag.pointerId)
      } catch (_) {
        /* ignore */
      }
      const rect = journalEl.getBoundingClientRect()
      const clone = journalEl.cloneNode(true)
      clone.classList.add('journal-merge-clone')
      clone.classList.remove(SELECTED_CLASS)
      clone.style.position = 'fixed'
      clone.style.left = `${rect.left}px`
      clone.style.top = `${rect.top}px`
      clone.style.width = `${rect.width}px`
      clone.style.pointerEvents = 'none'
      clone.style.zIndex = '1000'
      clone.style.opacity = '0.85'
      document.querySelector('.main')?.appendChild(clone)
      drag.clone = clone
      drag.offsetX = e.clientX - rect.left
      drag.offsetY = e.clientY - rect.top
    }
    drag.clone.style.left = `${e.clientX - drag.offsetX}px`
    drag.clone.style.top = `${e.clientY - drag.offsetY}px`

    clearMergeHover()
    const over = journalUnderPoint(e.clientX, e.clientY, journalEl)
    if (over) over.classList.add('wiki-merge-hover')
    e.preventDefault()
  }

  const onUp = function (e) {
    if (!drag || (e && e.pointerId !== drag.pointerId)) return
    const wasActive = drag.active
    if (wasActive) {
      const over = journalUnderPoint(e.clientX, e.clientY, journalEl)
      if (over) commitMerge(journalEl, over)
      const suppressClick = function (ev) {
        ev.preventDefault()
        ev.stopPropagation()
        journalEl.removeEventListener('click', suppressClick, true)
      }
      journalEl.addEventListener('click', suppressClick, true)
      setTimeout(() => journalEl.removeEventListener('click', suppressClick, true), 0)
    }
    cleanup()
  }

  const onCancel = function () {
    cleanup()
  }

  journalEl.addEventListener('pointerdown', function (e) {
    if (!isEditOn()) return
    // Mobile uses select + long-press (bind below); keep desktop immediate drag.
    if (needsDragHandle()) return
    if (e.button != null && e.button !== 0) return
    clearTextSelection()
    document.addEventListener('selectstart', preventSelect, true)
    drag = {
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      clone: null,
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onCancel)
  })
}

// --- Mobile: long-press selected journal → lineup shrink → journal-only drop ---

const bindJournalMerge = function () {
  let pending = null
  let session = null

  const mainEl = () => pages.lineupMain()

  const cancelPending = function () {
    if (!pending) return
    if (pending.raf != null) cancelAnimationFrame(pending.raf)
    if (pending.pointerId != null) {
      try {
        pending.captureEl?.releasePointerCapture?.(pending.pointerId)
      } catch (_) {
        /* optional */
      }
    }
    pending = null
  }

  const instantCenterEl = el => pages.centerInMain(el, mainEl())
  const ensureSpacers = () => pages.ensureLineupSpacers(session, mainEl())
  const removeSpacers = () => pages.removeLineupSpacers(session)
  const edgeScrollSpeed = clientX => pages.edgeScrollForX(clientX, mainEl())

  const stopEdgeScroll = function () {
    if (session?.edgeRaf != null) {
      cancelAnimationFrame(session.edgeRaf)
      session.edgeRaf = null
    }
  }

  const updateHover = function () {
    if (!session) return
    clearMergeHover()
    const over = journalUnderPoint(session.pointerX, session.pointerY, session.journalEl)
    if (over) {
      over.classList.add('wiki-merge-hover')
      session.destEl = over
    } else {
      session.destEl = null
    }
  }

  const moveClone = function (x, y) {
    if (!session?.clone) return
    const scale = document.body.classList.contains(LINEUP_SHRUNK) ? 0.5 : 1
    const ox = session.offsetX ?? 24
    const oy = session.offsetY ?? 16
    session.clone.style.transform = `translate(${x - ox * scale}px, ${y - oy * scale}px) scale(${scale})`
  }

  const edgeTick = function (ts) {
    if (!session) return
    session.edgeRaf = null
    if (!session.lastScrollTs) session.lastScrollTs = ts
    const dt = Math.min(0.05, (ts - session.lastScrollTs) / 1000)
    session.lastScrollTs = ts

    const { dir, speed } = edgeScrollSpeed(session.pointerX)
    const main = mainEl()
    if (main && dir && speed > 0) {
      main.scrollLeft += dir * speed * dt
    }

    const candidates = []
    const destPage = session.destEl?.closest?.('.page')
    if (destPage) candidates.push(destPage)
    if (main) candidates.push(main)
    pages.applyVertEdgeScroll(candidates, session.pointerY, dt, VERT_EDGE_PX, VERT_SCROLL_PX_PER_SEC)

    updateHover()
    moveClone(session.pointerX, session.pointerY)
    session.edgeRaf = requestAnimationFrame(edgeTick)
  }

  const teardown = function () {
    if (!session) return
    stopEdgeScroll()
    session.clone?.remove()
    session.journalEl?.classList.remove('is-dragging')
    document.body.classList.remove(MERGING, LINEUP_SHRUNK)
    clearMergeHover()
    removeSpacers()
    document.removeEventListener('pointermove', onDragMove, { passive: false })
    document.removeEventListener('touchmove', onDragMove, { passive: false })
    document.removeEventListener('pointerup', onDragCommit)
    document.removeEventListener('pointercancel', onDragAbort)
    document.removeEventListener('touchend', onDragCommit)
    document.removeEventListener('mouseup', onDragCommit)
    document.removeEventListener('lostpointercapture', onDragAbort)
    window.removeEventListener('pagehide', onDragAbort)
    if (session.pointerId != null) {
      try {
        session.captureEl?.releasePointerCapture?.(session.pointerId)
      } catch (_) {
        /* optional */
      }
    }
    try {
    setStorySortableEnabled(isEditOn())
    } catch (_) {
      /* optional */
    }
    try {
      pages.setPageSortableEnabled(true)
    } catch (_) {
      /* optional */
    }
    session = null
  }

  const onDragMove = function (e) {
    if (!session) return
    if (session.pointerId != null && e.pointerId != null && e.pointerId !== session.pointerId) return
    const x = e.clientX ?? e.touches?.[0]?.clientX
    const y = e.clientY ?? e.touches?.[0]?.clientY
    if (typeof x !== 'number' || typeof y !== 'number') return
    session.pointerX = x
    session.pointerY = y
    moveClone(x, y)
    updateHover()
    e.preventDefault()
  }

  const onDragCommit = function (e) {
    if (!session) return
    if (session.pointerId != null && e && e.pointerId != null && e.pointerId !== session.pointerId) {
      return
    }
    if (session.suppressCommitUntil && performance.now() < session.suppressCommitUntil) {
      return
    }
    const sourceEl = session.journalEl
    const destEl = session.destEl || journalUnderPoint(session.pointerX, session.pointerY, sourceEl)
    teardown()
    suppressClickUntil = performance.now() + 400
    if (destEl) commitMerge(sourceEl, destEl)
    clearJournalSelection()
  }

  const onDragAbort = function (e) {
    if (!session) return
    if (session.pointerId != null && e && e.pointerId !== session.pointerId) return
    if (
      session.ignorePointerCancel &&
      e &&
      (e.type === 'pointercancel' || e.type === 'lostpointercapture')
    ) {
      session.suppressCommitUntil = performance.now() + 400
      return
    }
    const journalEl = session.journalEl
    teardown()
    if (journalEl) selectJournal($(journalEl))
  }

  const beginDrag = function (journalEl, clientX, clientY, pointerId) {
    cancelPending()
    const rect = journalEl.getBoundingClientRect()
    const captureEl = document.body
    const clone = journalEl.cloneNode(true)
    clone.classList.add('journal-merge-clone')
    clone.classList.remove(SELECTED_CLASS, 'is-dragging')
    clone.style.position = 'fixed'
    clone.style.left = '0'
    clone.style.top = '0'
    clone.style.width = `${rect.width}px`
    clone.style.pointerEvents = 'none'
    clone.style.zIndex = '100050'
    clone.style.opacity = '0.9'
    clone.style.transformOrigin = 'top left'
    document.body.appendChild(clone)

    session = {
      journalEl,
      clone,
      pointerX: clientX,
      pointerY: clientY,
      pointerId,
      offsetX: clientX - rect.left,
      offsetY: clientY - rect.top,
      destEl: null,
      leftSpacer: null,
      rightSpacer: null,
      edgeRaf: null,
      lastScrollTs: 0,
      ignorePointerCancel: true,
      suppressCommitUntil: performance.now() + 500,
      captureEl,
    }

    clearTextSelection()
    if (typeof pointerId === 'number') {
      try {
        captureEl.setPointerCapture?.(pointerId)
      } catch (_) {
        /* optional */
      }
    }

    journalEl.classList.add('is-dragging')
    try {
      setStorySortableEnabled(false)
    } catch (_) {
      /* optional */
    }
    try {
      pages.setPageSortableEnabled(false)
    } catch (_) {
      /* optional */
    }

    document.addEventListener('pointermove', onDragMove, { passive: false })
    document.addEventListener('touchmove', onDragMove, { passive: false })
    document.addEventListener('pointerup', onDragCommit)
    document.addEventListener('pointercancel', onDragAbort)
    document.addEventListener('touchend', onDragCommit)
    document.addEventListener('mouseup', onDragCommit)
    document.addEventListener('lostpointercapture', onDragAbort)
    window.addEventListener('pagehide', onDragAbort)

    moveClone(clientX, clientY)

    requestAnimationFrame(() => {
      if (!session) return
      document.body.classList.add(MERGING)
      requestAnimationFrame(() => {
        if (!session) return
        document.body.classList.add(LINEUP_SHRUNK)
        ensureSpacers()
        const srcPage = journalEl.closest('.page')
        if (srcPage) instantCenterEl(srcPage)
        moveClone(session.pointerX, session.pointerY)
        updateHover()
        session.edgeRaf = requestAnimationFrame(edgeTick)
        session.suppressCommitUntil = performance.now() + 200
      })
    })
  }

  const pendingTick = function () {
    if (!pending) return
    pending.raf = null
    if (performance.now() - pending.t0 >= LONG_PRESS_MS) {
      const { journalEl, x, y, pointerId } = pending
      cancelPending()
      beginDrag(journalEl, x, y, pointerId)
      return
    }
    pending.raf = requestAnimationFrame(pendingTick)
  }

  const armPending = function (journalEl, e) {
    cancelPending()
    pending = {
      journalEl,
      x: e.clientX,
      y: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
      t0: performance.now(),
      raf: null,
      captureEl: document.body,
    }
    if (typeof e.pointerId === 'number') {
      try {
        document.body.setPointerCapture?.(e.pointerId)
      } catch (_) {
        /* optional */
      }
    }
    pending.raf = requestAnimationFrame(pendingTick)
  }

  document.addEventListener(
    'pointerdown',
    function (e) {
      if (pending) return
      if (session) {
        const stuckJournal = session.journalEl
        teardown()
        if (stuckJournal) selectJournal($(stuckJournal))
        return
      }
      if (!isEditOn() || !needsDragHandle()) return
      if (e.pointerType && e.pointerType !== 'touch' && e.pointerType !== 'pen') return
      if (e.button != null && e.button !== 0) return
      const target = e.target
      if (!(target instanceof Element)) return
      if (target.closest('.action, .control-buttons, a, button')) return
      const journalEl = target.closest(`.page .journal.${SELECTED_CLASS}`)
      if (!journalEl) return
      e.preventDefault()
      e.stopPropagation()
      armPending(journalEl, e)
    },
    true,
  )

  document.addEventListener(
    'pointermove',
    function (e) {
      if (!pending || e.pointerId !== pending.pointerId) return
      const dx = e.clientX - pending.startX
      const dy = e.clientY - pending.startY
      pending.x = e.clientX
      pending.y = e.clientY
      e.preventDefault()
      if (dx * dx + dy * dy > JOURNAL_BODY_SLOP_PX * JOURNAL_BODY_SLOP_PX) {
        cancelPending()
        suppressClickUntil = performance.now() + 350
      }
    },
    { capture: true, passive: false },
  )

  document.addEventListener(
    'pointerup',
    function (e) {
      if (pending && (!e || e.pointerId === pending.pointerId)) cancelPending()
    },
    true,
  )
  // Intentionally no pointercancel → cancelPending (see item long-press).

  document.addEventListener(
    'contextmenu',
    function (e) {
      if (!needsDragHandle()) return
      if (e.target?.closest?.(`.page .journal.${SELECTED_CLASS}`)) e.preventDefault()
    },
    true,
  )
}


const initDragging = ($page) => initStorySortable($page)
const initMerging = ($page) => initJournalMerge($page)

module.exports = {
  initPageSortable,
  initDragging,
  initMerging,
  setPageSortableEnabled,
  shouldSuppressLineupNavItemClick,
  lineupMain,
  pageNodesIn,
  centerInMain,
  nearestPageIndexIn,
  ensureLineupSpacers,
  removeLineupSpacers,
  edgeScrollForX,
  applyVertEdgeScroll,
  LINEUP_SHRUNK,
  setStorySortableEnabled,
  getItem,
  HANDLE_CLASS,
  EDIT_CLASS,
  ensure,
  clear,
  select,
  isEditOn,
  needsDragHandle,
  getSelectedId,
  bindLineupItemDrag,
  shouldSuppressItemClick,
  bindJournalMerge,
  selectJournal,
  clearJournalSelection,
  isJournalSelected,
  JOURNAL_SELECTED_CLASS,
  shouldSuppressJournalClick,
}
