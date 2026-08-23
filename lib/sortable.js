// SortableJS stand-in for former jQuery UI page/story/journal drag (legacy + refresh).
// Exports: initPageSortable, initDragging, initMerging.

const Sortable = require('sortablejs')
const lineup = require('./lineup')
const state = require('./state')
const plugin = require('./plugin')
const active = require('./active')
const pageHandler = require('./pageHandler')
const random = require('./random')
const { pageEmitter } = require('./page')

const getItem = function ($item) {
  if ($($item).length > 0) {
    return $($item).data('item') || $($item).data('staticItem')
  }
}

const aliasItem = function ($page, $item, oldItem) {
  const item = $.extend({}, oldItem)
  $item.data('item', item)
  const pageObject = lineup.atKey($page.data('key'))
  if (pageObject.getItem(item.id) != null) {
    if (!item.alias) {
      item.alias = item.id
    }
    item.id = random.itemId()
    $item.attr('data-id', item.id)
    $item.data('id', item.id)
    $item.data('item').id = item.id
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

const getStoryItemOrder = $story =>
  $story
    .children()
    .not('.shadow-copy')
    .map((_, value) => $(value).attr('data-id'))
    .get()

// handleDrop(evt, ui, …) matches the old refresh signature; ui.cancel ≈ sortable('cancel').
const handleDrop = function (evt, ui, originalIndex, originalOrder) {
  let dragAttribution, index
  const $item = ui.item

  let item = getItem($item)
  const $sourcePage = $item.data('pageElement')
  const sourceIsReadOnly = $sourcePage.hasClass('ghost') || $sourcePage.hasClass('remote')

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
    !moveWithinPage && !evt.shiftKey && $sourcePage.attr('id') === $destinationPage.attr('id')

  const removedTo = {
    page: $destinationPage.data().data['title'],
  }

  if (destinationIsGhost || moveBetweenDuplicatePages) {
    if (typeof ui.cancel === 'function') ui.cancel()
    return
  }

  if (moveWithinPage) {
    const order = getStoryItemOrder($item.parents('.story:first'))
    if (JSON.stringify(order) !== JSON.stringify(originalOrder)) {
      $('.shadow-copy').remove()
      $item.empty()
      index = $('.item').index($item)
      if (originalIndex < index) {
        index = originalIndex
      }
      plugin.renderFrom(index)
      pageHandler.put($destinationPage, { id: item.id, type: 'move', order })
    }
    return
  }
  const copying = sourceIsReadOnly || evt.shiftKey
  if (copying) {
    // If making a copy, update the temp clone so it becomes a true copy.
    $('.shadow-copy')
      .removeClass('shadow-copy')
      .data($item.data())
      .attr({ 'data-id': $item.attr('data-id') })
  } else {
    pageHandler.put($sourcePage, { id: item.id, type: 'remove', removedTo })
  }
  // Either way, record the add to the new page
  $item.data('pageElement', $destinationPage)
  const $before = $item.prev('.item')
  const before = getItem($before)
  item = aliasItem($destinationPage, $item, item)
  pageHandler.put($destinationPage, { id: item.id, type: 'add', item, after: before?.id, attribution: dragAttribution })
  $('.shadow-copy').remove()
  $item.empty()
  $before.after($item)
  index = $('.item').index($item)
  if (originalIndex < index) {
    index = originalIndex
  }
  plugin.renderFrom(index)
}

// Cursor + shadow-copy while dragging (same role as old refresh helper).
const changeMouseCursor = function (e, ui) {
  const $sourcePage = ui.item.data('pageElement')
  if (!$sourcePage?.length) return
  const sourceIsReadOnly = $sourcePage.hasClass('ghost') || $sourcePage.hasClass('remote')
  const $destinationPage = ui.placeholder.parents('.page:first')
  const destinationIsGhost = $destinationPage.hasClass('ghost')
  const moveWithinPage = equals($sourcePage, $destinationPage)
  const moveBetweenDuplicatePages = !moveWithinPage && $sourcePage.attr('id') === $destinationPage.attr('id')
  const copying = sourceIsReadOnly || (e.shiftKey && !moveWithinPage)
  if (destinationIsGhost || (moveBetweenDuplicatePages && !e.shiftKey)) {
    $('body').css('cursor', 'no-drop')
    return $('.shadow-copy').hide()
  } else if (copying) {
    $('body').css('cursor', 'copy')
    return $('.shadow-copy').show()
  } else {
    $('body').css('cursor', 'move')
    return $('.shadow-copy').hide()
  }
}

// Page vs story Sortable instances fight over the pointer; disable the other while one runs.
const setStorySortableDisabled = function (disabled) {
  $('.page .story').each(function () {
    if (this._wikiSortable) this._wikiSortable.option('disabled', disabled)
  })
}

const setPageSortableDisabled = function (disabled) {
  document.querySelectorAll('.main').forEach(mainEl => {
    if (mainEl._wikiPageSortable) mainEl._wikiPageSortable.option('disabled', disabled)
  })
}

// Page panels (legacy.js → initPageSortable).
const initPageSortable = function (mainEl) {
  if (!mainEl) return null
  if (mainEl._wikiPageSortable) {
    mainEl._wikiPageSortable.destroy()
    mainEl._wikiPageSortable = null
  }

  const origCursor = $('body').css('cursor')
  let originalPageIndex = null
  let $dragging = null

  // Keep jquery-ui helper class names for existing CSS.
  const helperEl = () => document.querySelector('.ui-sortable-helper.page')

  const prepareHelper = function () {
    const el = helperEl()
    if (!el?.classList?.contains('page')) return
    el.style.overflow = 'visible'
    el.style.visibility = 'visible'
    el.style.setProperty('opacity', '1', 'important')
  }

  // Drag above the window → pending-remove (stock lineup dismiss).
  function onSort(e) {
    if (!$dragging?.length || !$dragging.hasClass('page')) return
    const pageY = typeof e?.pageY === 'number' ? e.pageY : e?.touches?.[0]?.pageY
    const clientY = typeof e?.clientY === 'number' ? e.clientY : e?.touches?.[0]?.clientY
    const above =
      (typeof pageY === 'number' && pageY < 0) || (typeof clientY === 'number' && clientY <= 0)
    // Only mark for removal if there's more than one page left
    const removing = above && $('.page').length > 1
    $dragging.toggleClass('pending-remove', removing)
    const fallback = helperEl()
    if (fallback) {
      fallback.classList.toggle('pending-remove', removing)
      fallback.style.transition = 'opacity 300ms'
      fallback.style.setProperty('opacity', removing ? '0.2' : '1', 'important')
    }
  }

  const sortable = Sortable.create(mainEl, {
    animation: 0,
    handle: '.page-handle',
    draggable: '.page',
    ghostClass: 'ui-sortable-placeholder',
    fallbackClass: 'ui-sortable-helper',
    dragClass: 'ui-sortable-helper',
    direction: 'horizontal',
    forceFallback: true,
    fallbackOnBody: true,
    fallbackTolerance: 5,
    group: { name: 'wiki-pages', pull: false, put: false },
    scroll: mainEl,
    bubbleScroll: true,
    forceAutoScrollFallback: true,
    onMove(evt) {
      if (!evt?.dragged?.classList?.contains('page')) return false
      if (evt.to && !evt.to.classList?.contains('main') && evt.to !== mainEl) return false
      return true
    },
    onStart(evt) {
      // sortstart
      if (!$(evt.item).hasClass('page')) return
      const noScroll = true
      active.set($(evt.item), noScroll)
      originalPageIndex = $('.page').index(evt.item)
      $dragging = $(evt.item)
      $('body').css('cursor', 'grabbing')
      setStorySortableDisabled(true)
      prepareHelper()
      requestAnimationFrame(prepareHelper)
      document.addEventListener('pointermove', onSort, true)
      document.addEventListener('touchmove', onSort, { passive: true })
    },
    onEnd(evt) {
      // sortstop
      const $page = $(evt.item)
      document.removeEventListener('pointermove', onSort, true)
      document.removeEventListener('touchmove', onSort)
      $('body').css('cursor', origCursor)
      setStorySortableDisabled(false)
      if ($page.parent().hasClass('story') || !$page.parent().hasClass('main')) {
        const kids = [...mainEl.querySelectorAll(':scope > .page')]
        const ref = kids[Math.min(originalPageIndex ?? kids.length, kids.length)]
        if (ref) mainEl.insertBefore($page[0], ref)
        else mainEl.appendChild($page[0])
      }
      $dragging = null
      if (!$page.hasClass('page')) return
      const $pages = $('.page')
      let index = $pages.index($('.active'))
      let firstItemIndex = $('.item').index($page.find('.item')[0])
      if ($page.hasClass('pending-remove')) {
        if ($pages.length === 1) return
        lineup.removeKey($page.data('key'))
        $page.remove()
        active.set($('.page')[index])
      } else {
        $page.removeClass('pending-remove')
        const newIndex = [...mainEl.querySelectorAll(':scope > .page')].indexOf($page[0])
        lineup.changePageIndex($page.data('key'), newIndex >= 0 ? newIndex : index)
        active.set($('.active'))
        if (originalPageIndex != null && originalPageIndex < (newIndex >= 0 ? newIndex : index)) {
          index = originalPageIndex
          firstItemIndex = $('.item').index($($('.page')[index]).find('.item')[0])
        }
      }
      plugin.renderFrom(firstItemIndex)
      state.setUrl()
      if (window.debug) {
        state.debugStates()
      }
    },
  })

  mainEl._wikiPageSortable = sortable
  return sortable
}

// Story items (refresh.js → initDragging).
const initDragging = function ($page) {
  const $story = $page.find('.story')
  const storyEl = $story[0]
  if (!storyEl) return null
  if (storyEl._wikiSortable) {
    storyEl._wikiSortable.destroy()
    storyEl._wikiSortable = null
  }

  const origCursor = $('body').css('cursor')
  let originalOrder = null
  let originalIndex = null
  let dragCancelled = null
  let shiftHeld = false
  let lastToStory = null
  let dragPageElement = null
  let dragItemSnapshot = null
  let itemSize = null

  const cancelDrag = function (e) {
    if (e.which === 27 && storyEl._wikiSortable) {
      dragCancelled = true
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    }
  }

  // SortableJS can drop jQuery .data() on the dragged node; keep copies for handleDrop.
  const keepItemData = function ($item) {
    if (!$item.data('pageElement') && dragPageElement) $item.data('pageElement', dragPageElement)
    if (!$item.data('item') && dragItemSnapshot) $item.data('item', $.extend({}, dragItemSnapshot))
  }

  const onShiftKey = function (e) {
    if (e.key !== 'Shift') return
    shiftHeld = e.type === 'keydown'
    const $item = $(Sortable.ghost || document.querySelector('body > .ui-sortable-helper.item'))
    if (!$item.length) return
    keepItemData($item)
    const toStory = lastToStory || (dragPageElement && dragPageElement.find('.story')[0])
    if (!toStory) return
    changeMouseCursor({ shiftKey: shiftHeld }, { item: $item, placeholder: $(toStory) })
  }

  const sizePlaceholder = function (el) {
    if (!el || !itemSize) return
    el.style.boxSizing = 'border-box'
    el.style.height = `${itemSize.h}px`
    el.style.width = `${itemSize.w}px`
  }

  // Sortable (+ placeholder lock clone) set an explicit height; that makes
  // .image img { height:100% } fill the box so captions vanish (and clips
  // code/pre padding). Unlock like stock jQuery UI's free-sized helper.
  const prepareHelper = function () {
    const helper = Sortable.ghost || document.querySelector('body > .ui-sortable-helper.item')
    if (!helper?.classList?.contains('item')) return
    if (itemSize) {
      helper.style.setProperty('width', `${itemSize.w}px`, 'important')
    }
    helper.style.height = 'auto'
    helper.style.maxHeight = 'none'
    helper.style.overflow = 'visible'
    helper.style.setProperty('opacity', '1', 'important')
  }

  const sortable = Sortable.create(storyEl, {
    animation: 0,
    delay: 150,
    delayOnTouchOnly: true,
    forceFallback: true,
    fallbackOnBody: true,
    fallbackTolerance: 3,
    scroll: true,
    bubbleScroll: true,
    forceAutoScrollFallback: true,
    draggable: '.item:not(.shadow-copy)',
    filter: 'input, textarea, button, select, option',
    preventOnFilter: false,
    ghostClass: 'item-placeholder',
    fallbackClass: 'ui-sortable-helper',
    dragClass: 'ui-sortable-helper',
    group: {
      name: 'wiki-story',
      pull: true,
      put(to, from, dragEl) {
        return !!(dragEl && dragEl.classList?.contains('item') && !dragEl.classList.contains('shadow-copy'))
      },
    },
    onChoose(evt) {
      if (evt.item) itemSize = { h: evt.item.offsetHeight, w: evt.item.offsetWidth }
    },
    onStart(evt) {
      // sortstart
      setPageSortableDisabled(true)
      const $item = $(evt.item)
      originalOrder = getStoryItemOrder($story)
      originalIndex = $('.item').index($item)
      dragCancelled = false
      shiftHeld = !!evt.originalEvent?.shiftKey
      dragItemSnapshot = $.extend({}, getItem($item))
      dragPageElement = $item.data('pageElement')
      lastToStory = null
      if (!itemSize) itemSize = { h: evt.item.offsetHeight, w: evt.item.offsetWidth }
      $('body').on('keydown', cancelDrag)
      document.addEventListener('keydown', onShiftKey)
      document.addEventListener('keyup', onShiftKey)
      // Create a copy that we control since sortable removes theirs too early.
      // Insert after the placeholder to prevent adding history when item not moved.
      // Clear out the styling they add. Updates to jquery ui can affect this.
      $item
        .clone()
        .insertAfter(evt.item)
        .hide()
        .addClass('shadow-copy')
        .removeClass('item-placeholder ui-sortable-helper')
        .css({
          width: '',
          height: '',
          position: '',
          zIndex: '',
        })
        .removeAttr('data-id')
      sizePlaceholder(evt.item)
      prepareHelper()
      requestAnimationFrame(() => {
        sizePlaceholder(evt.item)
        prepareHelper()
      })
      $('body').css('cursor', 'move')
      if (shiftHeld) onShiftKey({ key: 'Shift', type: 'keydown' })
    },
    onMove(evt, originalEvent) {
      // sort → changeMouseCursor
      if (evt.dragged?.classList?.contains('page')) return false
      if (evt.to?.classList?.contains('main')) return false
      if (originalEvent && typeof originalEvent.shiftKey === 'boolean') {
        shiftHeld = originalEvent.shiftKey
      }
      const $item = $(evt.dragged)
      keepItemData($item)
      sizePlaceholder(evt.dragged)
      prepareHelper()
      lastToStory = evt.to
      changeMouseCursor({ shiftKey: shiftHeld }, { item: $item, placeholder: $(evt.to) })
      return true
    },
    onEnd(evt) {
      // sortstop → handleDrop (unless Esc cancelDrag)
      $('body').css('cursor', origCursor).off('keydown', cancelDrag)
      document.removeEventListener('keydown', onShiftKey)
      document.removeEventListener('keyup', onShiftKey)
      if (evt.item) {
        evt.item.style.height = evt.item.style.width = evt.item.style.boxSizing = ''
      }
      itemSize = null
      const $item = $(evt.item)
      keepItemData($item)
      const cancel = () => {
        if (evt.from && evt.oldIndex != null) {
          const ref = evt.from.children[evt.oldIndex]
          if (ref) evt.from.insertBefore(evt.item, ref)
          else evt.from.appendChild(evt.item)
        }
      }
      if ($item.parent().hasClass('main')) cancel()
      if (dragCancelled) {
        cancel()
      } else if (evt.from !== evt.to || evt.oldIndex !== evt.newIndex) {
        handleDrop({ shiftKey: shiftHeld }, { item: $item, cancel }, originalIndex, originalOrder)
      }
      $('.shadow-copy').remove()
      dragItemSnapshot = null
      dragPageElement = null
      shiftHeld = false
      lastToStory = null
      setPageSortableDisabled(false)
    },
  })

  storyEl._wikiSortable = sortable
  return sortable
}

// Journal merge (refresh.js → initMerging).
const getPageObject = function ($journal) {
  const $page = $($journal).parents('.page:first')
  return lineup.atKey($page.data('key'))
}

const handleMerging = function (event, ui) {
  const drag = getPageObject(ui.draggable)
  const drop = getPageObject(event.target)
  if (!drag || !drop || drag === drop) return
  const merged = drop.merge(drag)
  if (!merged) return
  pageEmitter.dispatchEvent(new CustomEvent('show', { detail: merged }))
}

const journalUnderPoint = function (x, y, sourceEl) {
  const helpers = document.querySelectorAll('.main > .journal.ui-draggable-dragging')
  const prev = []
  helpers.forEach(el => {
    prev.push(el.style.visibility)
    el.style.visibility = 'hidden'
  })
  try {
    const stack =
      typeof document.elementsFromPoint === 'function'
        ? document.elementsFromPoint(x, y)
        : [document.elementFromPoint(x, y)].filter(Boolean)
    for (const el of stack) {
      const journal = el?.closest?.('.journal')
      if (!journal || journal === sourceEl) continue
      if (!journal.closest('.page')) continue
      return journal
    }
    for (const journal of document.querySelectorAll('.page .journal')) {
      if (journal === sourceEl) continue
      const r = journal.getBoundingClientRect()
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return journal
    }
    return null
  } finally {
    helpers.forEach((el, i) => {
      el.style.visibility = prev[i] || ''
    })
  }
}

const initMerging = function ($page) {
  const journalEl = $page.find('.journal')[0]
  if (!journalEl || journalEl._wikiMergeBound) return
  journalEl._wikiMergeBound = true
  // Keep ui-draggable / ui-draggable-dragging class names for existing CSS.
  journalEl.classList.add('ui-draggable')
  journalEl.setAttribute('draggable', 'false')

  let drag = null
  const preventSelect = e => e.preventDefault()
  const clearHover = () =>
    document.querySelectorAll('.journal.ui-state-hover').forEach(el => el.classList.remove('ui-state-hover'))

  const cleanup = function () {
    if (!drag) return
    drag.clone?.remove()
    journalEl.classList.remove('ui-draggable-dragging')
    clearHover()
    document.removeEventListener('pointermove', onDrag, true)
    document.removeEventListener('pointerup', onStop, true)
    document.removeEventListener('pointercancel', onCancel, true)
    document.removeEventListener('selectstart', preventSelect, true)
    try {
      journalEl.releasePointerCapture?.(drag.pointerId)
    } catch (_) {
      /* already released */
    }
    drag = null
  }

  const onDrag = function (e) {
    if (!drag || e.pointerId !== drag.pointerId) return
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    if (!drag.active) {
      if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return
      drag.active = true
      journalEl.classList.add('ui-draggable-dragging')
      try {
        window.getSelection?.()?.removeAllRanges?.()
      } catch (_) {
        /* ignore */
      }
      try {
        journalEl.setPointerCapture?.(drag.pointerId)
      } catch (_) {
        /* ignore */
      }
      const rect = journalEl.getBoundingClientRect()
      const clone = journalEl.cloneNode(true)
      clone.classList.add('ui-draggable-dragging')
      clone.setAttribute('draggable', 'false')
      Object.assign(clone.style, {
        position: 'fixed',
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        pointerEvents: 'none',
        zIndex: '1000',
        opacity: '0.85',
      })
      clone.querySelectorAll('*').forEach(node => {
        node.style.pointerEvents = 'none'
        node.setAttribute?.('draggable', 'false')
      })
      document.querySelector('.main')?.appendChild(clone)
      drag.clone = clone
      drag.offsetX = e.clientX - rect.left
      drag.offsetY = e.clientY - rect.top
    }
    if (!drag.clone) return
    drag.clone.style.left = `${e.clientX - drag.offsetX}px`
    drag.clone.style.top = `${e.clientY - drag.offsetY}px`
    clearHover()
    const over = journalUnderPoint(e.clientX, e.clientY, journalEl)
    if (over) {
      over.classList.add('ui-state-hover')
      drag.over = over
    } else {
      drag.over = null
    }
    e.preventDefault()
  }

  const onStop = function (e) {
    if (!drag || (e && e.pointerId !== drag.pointerId)) return
    const wasActive = drag.active
    const over =
      (typeof e.clientX === 'number' && journalUnderPoint(e.clientX, e.clientY, journalEl)) ||
      drag.over ||
      null
    if (wasActive && over) handleMerging({ target: over }, { draggable: journalEl })
    cleanup()
  }

  const onCancel = function (e) {
    if (!drag || (e && e.pointerId !== drag.pointerId)) return
    if (drag.active) onStop(e)
    else cleanup()
  }

  journalEl.addEventListener('pointerdown', function (e) {
    if (e.button != null && e.button !== 0) return
    e.preventDefault()
    try {
      window.getSelection?.()?.removeAllRanges?.()
    } catch (_) {
      /* ignore */
    }
    document.addEventListener('selectstart', preventSelect, true)
    drag = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      clone: null,
      over: null,
    }
    document.addEventListener('pointermove', onDrag, true)
    document.addEventListener('pointerup', onStop, true)
    document.addEventListener('pointercancel', onCancel, true)
  })
}

module.exports = {
  initPageSortable,
  initDragging,
  initMerging,
}
