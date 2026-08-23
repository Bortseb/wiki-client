// Editor provides a small textarea for editing wiki markup.
// It can split and join paragraphs markup but leaves other
// types alone assuming they will interpret multiple lines.

const plugin = require('./plugin')
const itemz = require('./itemz')
const pageHandler = require('./pageHandler')
const link = require('./link')
const random = require('./random')
const story = require('./sortable')
const pages = new Proxy(
  {},
  {
    get(_t, prop) {
      return require('./legacy')[prop]
    },
  },
)
const refresh = require('./refresh')
const active = require('./active')

const isMobileViewport = () => window.matchMedia('(max-width: 490px)').matches

let editorHistoryPushed = false
let ignoringEditorPopstate = false
let consumeEditorPopGen = 0
// First phone-back blurs the field to close the IME; textEditor saves on
// focusout, so suppress that one commit and leave the editor open.
let suppressEditorFocusout = false

const editingItemEl = () => document.querySelector('.item.textEditing, .item.imageEditing')

const focusedEditorField = () => {
  const editing = editingItemEl()
  const el = document.activeElement
  if (!editing || !el || !editing.contains(el)) return null
  if (el.matches?.('textarea, input, select') || el.isContentEditable) return el
  return null
}

// Only become a scrollport when content exceeds max-height. A short textarea
// with overflow:auto still captures the first mobile scroll gesture.
const canScrollY = el => !!el && el.scrollHeight > el.clientHeight + 1

const syncEditorScrollport = el => {
  if (!(el instanceof HTMLTextAreaElement)) return
  const overflows = canScrollY(el)
  el.style.overflowY = overflows ? 'auto' : 'hidden'
  // none: browser must not latch the first pan to a field that cannot scroll.
  el.style.touchAction = overflows ? 'pan-y' : 'none'
}

const syncOpenEditorScrollports = () => {
  document
    .querySelectorAll('.item.textEditing textarea, .item.imageEditing textarea')
    .forEach(syncEditorScrollport)
}

document.addEventListener(
  'input',
  e => {
    if (e.target?.matches?.('.item.textEditing textarea, .item.imageEditing textarea')) {
      syncEditorScrollport(e.target)
    }
  },
  true,
)

// Mobile: .page often grows with content; .main is the vertical scroller.
const verticalScroller = fromEl => {
  const page = fromEl?.closest?.('.page')
  if (canScrollY(page)) return page
  const main = document.querySelector('.main')
  if (canScrollY(main)) return main
  return page || main
}

const applyVerticalScroll = (el, dy) => {
  if (!el || !dy) return
  const before = el.scrollTop
  el.scrollTop += dy
  const leftover = dy - (el.scrollTop - before)
  if (!leftover) return
  const main = document.querySelector('.main')
  if (main && main !== el) main.scrollTop += leftover
}

// Focused editor steals the first pan. Own it (touch-action:none on the field)
// and move .page / .main on this swipe — not the next one.
let editorPagePan = null

const isEditingTextarea = el =>
  el instanceof HTMLTextAreaElement && !!el.closest?.('.item.textEditing, .item.imageEditing')

const endEditorPagePan = () => {
  editorPagePan = null
}

document.addEventListener(
  'touchstart',
  e => {
    if (!document.body.classList.contains('wiki-mobile-editing')) return
    if (e.touches.length !== 1) return
    const target = e.target
    if (!(target instanceof Element)) return
    if (target.closest('a, button, input:not(textarea)')) return

    const ta = isEditingTextarea(target) ? target : null
    if (ta && canScrollY(ta)) return

    const from = ta || target.closest('.page')
    if (!from) return
    const scroller = verticalScroller(from)
    if (!scroller) return

    const t = e.touches[0]
    editorPagePan = {
      scroller,
      y: t.clientY,
      x: t.clientX,
      armed: false,
    }
    // Already-focused field: claim the gesture so the first touchmove is
    // cancelable (Safari otherwise eats swipe 1 as IME/field chrome).
    if (ta && document.activeElement === ta && e.cancelable) e.preventDefault()
  },
  { capture: true, passive: false },
)

document.addEventListener(
  'touchmove',
  e => {
    if (!editorPagePan || e.touches.length !== 1) return
    const t = e.touches[0]
    const dy = editorPagePan.y - t.clientY
    const dx = t.clientX - editorPagePan.x
    if (!editorPagePan.armed) {
      if (Math.abs(dy) < 3 && Math.abs(dx) < 3) return
      if (Math.abs(dx) > Math.abs(dy) * 1.25) {
        endEditorPagePan()
        return
      }
      editorPagePan.armed = true
    }
    editorPagePan.y = t.clientY
    editorPagePan.x = t.clientX
    applyVerticalScroll(editorPagePan.scroller, dy)
    if (e.cancelable) e.preventDefault()
  },
  { capture: true, passive: false },
)

document.addEventListener('touchend', endEditorPagePan, true)
document.addEventListener('touchcancel', endEditorPagePan, true)

// Prefer visualViewport: Android often dismisses the IME on back without
// popstate; the next popstate should cancel, not "blur again".
const keyboardLikelyOpen = () => {
  const vv = window.visualViewport
  if (vv && typeof vv.height === 'number') {
    return window.innerHeight - vv.height > 100
  }
  return !!focusedEditorField()
}

// 100vh does not shrink with the IME. Size the field to visualViewport and
// scroll .page/.main so the whole editor sits above the keyboard. Avoid
// scrollIntoView — that blanked the lineup on mobile.
let editorViewportBound = false
let editorLayoutRaf = null

const visibleViewport = () => {
  const vv = window.visualViewport
  if (vv && typeof vv.height === 'number') {
    return { top: vv.offsetTop || 0, height: vv.height }
  }
  return { top: 0, height: window.innerHeight }
}

const layoutMobileEditor = () => {
  if (!document.body.classList.contains('wiki-mobile-editing')) return
  const field = document.querySelector(
    '.item.textEditing textarea, .item.imageEditing textarea, .item.textEditing input, .item.imageEditing input',
  )
  const { top: viewTop, height: viewH } = visibleViewport()
  const viewBottom = viewTop + viewH
  const cap = Math.max(96, Math.round(viewH - 16))
  document.documentElement.style.setProperty('--wiki-editor-max-height', `${cap}px`)
  if (!field) return
  syncEditorScrollport(field)
  const rect = field.getBoundingClientRect()
  const pad = 8
  let delta = 0
  if (rect.bottom > viewBottom - pad) delta += rect.bottom - (viewBottom - pad)
  if (rect.top - delta < viewTop + pad) delta = rect.top - (viewTop + pad)
  if (Math.abs(delta) < 1) return
  const scroller = verticalScroller(field)
  if (scroller) scroller.scrollTop += delta
}

const onEditorViewport = () => {
  if (editorLayoutRaf != null) return
  editorLayoutRaf = requestAnimationFrame(() => {
    editorLayoutRaf = null
    layoutMobileEditor()
  })
}

const bindEditorViewport = () => {
  if (editorViewportBound) return
  editorViewportBound = true
  window.visualViewport?.addEventListener('resize', onEditorViewport)
  window.addEventListener('resize', onEditorViewport)
}

const unbindEditorViewport = () => {
  if (!editorViewportBound) return
  editorViewportBound = false
  if (editorLayoutRaf != null) {
    cancelAnimationFrame(editorLayoutRaf)
    editorLayoutRaf = null
  }
  window.visualViewport?.removeEventListener('resize', onEditorViewport)
  window.removeEventListener('resize', onEditorViewport)
  document.documentElement.style.removeProperty('--wiki-editor-max-height')
}

const focusFieldNoScroll = el => {
  if (!el || typeof el.focus !== 'function') return
  try {
    el.focus({ preventScroll: true })
  } catch (_) {
    el.focus()
  }
}

let restorePageEl = null

const pinLineupPage = el => {
  if (!el?.isConnected) return
  active.set($(el), true)
  if (!isMobileViewport()) return
  const main = document.querySelector('.main')
  if (!main) return
  const nodes = [...main.querySelectorAll(':scope > .page')]
  const i = nodes.indexOf(el)
  const max = Math.max(0, main.scrollWidth - main.clientWidth)
  let left = el.offsetLeft
  if (i <= 0) left = 0
  else if (i >= nodes.length - 1) left = max
  const prevSnap = main.style.scrollSnapType
  const prevBehavior = main.style.scrollBehavior
  main.style.scrollSnapType = 'none'
  main.style.scrollBehavior = 'auto'
  main.scrollLeft = left
  main.style.scrollSnapType = prevSnap
  main.style.scrollBehavior = prevBehavior
}

const pushEditorHistory = () => {
  if (editorHistoryPushed) return
  try {
    history.pushState(Object.assign({}, history.state, { wikiMobileEditor: 1 }), '')
    editorHistoryPushed = true
  } catch (_) {
    /* private mode / missing history */
  }
}

const consumeEditorHistory = () => {
  if (!editorHistoryPushed) return
  editorHistoryPushed = false
  // Keep ignoring until the popstate arrives — 800ms was still too short on
  // some phones, so state.show() focused the last lineup page.
  const gen = ++consumeEditorPopGen
  ignoringEditorPopstate = true
  if (history.state?.wikiMobileEditor) {
    history.back()
  }
  setTimeout(() => {
    if (gen === consumeEditorPopGen) ignoringEditorPopstate = false
  }, 4000)
}

// Mobile back while editing: first press dismisses the IME (blur + re-push),
// second press cancels the open item editor. Applies to every item type.
window.addEventListener(
  'popstate',
  e => {
    if (ignoringEditorPopstate) {
      ignoringEditorPopstate = false
      consumeEditorPopGen += 1
      e.stopImmediatePropagation()
      return
    }
    if (!editorHistoryPushed) return
    e.stopImmediatePropagation()
    const field = focusedEditorField()
    if (keyboardLikelyOpen() && field) {
      suppressEditorFocusout = true
      field.blur()
      requestAnimationFrame(() => {
        suppressEditorFocusout = false
      })
      try {
        history.pushState(Object.assign({}, history.state, { wikiMobileEditor: 1 }), '')
      } catch (_) {
        /* private mode / missing history */
      }
      return
    }
    editorHistoryPushed = false
    discardOpenEditor()
  },
  true,
)

// Hide footer/neighborhood while an item editor is open on mobile — the IME
// already consumes most of the viewport. Apply before focus so the layout is
// stable when the keyboard opens (moving a focused field dismisses Android IME).
// Defer the off-path so split/join can open the next editor in the same turn
// without a one-frame footer flash.
const setMobileEditing = on => {
  if (on) {
    if (!isMobileViewport()) return
    restorePageEl = editingItemEl()?.closest('.page') || restorePageEl
    document.body.classList.add('wiki-mobile-editing')
    pushEditorHistory()
    bindEditorViewport()
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        syncOpenEditorScrollports()
        layoutMobileEditor()
      }),
    )
    return
  }
  requestAnimationFrame(() => {
    if ($('.item.textEditing, .item.imageEditing').length) return
    const el = restorePageEl
    restorePageEl = null
    const main = document.querySelector('.main')
    const prevSnap = main?.style.scrollSnapType
    const prevBehavior = main?.style.scrollBehavior
    // Footer/IME reflow + mandatory snap jumps to the last column unless snap
    // is off until we pin the page we were editing.
    if (main) {
      main.style.scrollSnapType = 'none'
      main.style.scrollBehavior = 'auto'
    }
    document.body.classList.remove('wiki-mobile-editing')
    unbindEditorViewport()
    consumeEditorHistory()
    pinLineupPage(el)
    if (main) {
      main.style.scrollSnapType = prevSnap
      main.style.scrollBehavior = prevBehavior
    }
    pinLineupPage(el)
    setTimeout(() => pinLineupPage(el), 250)
  })
}

// Editor takes a div and an item that goes in it.
// Options manage state during splits and joins.
// Options are available to plugins but rarely used.
//
//   caret: position -- sets the cursor at the point of join
//   append: true -- sets the cursor to end and scrolls there
//   after: id -- new item to be added after id
//   sufix: text -- editor opens with unsaved suffix appended
//   field: 'text' -- editor operates on this field of the item

const escape = string => string.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

var textEditor = function ($item, item, option) {
  // console.log 'textEditor', item.id, option
  let enterCount
  if (option == null) {
    option = {}
  }
  if (item.type === 'markdown') {
    enterCount = 0
  }
  // Body edit-mode (fedwiki-edit-mode) — .editEnable visibility is not enough on mobile.
  if (!story.isEditOn()) {
    return
  }

  const keydownHandler = function (e) {
    if (e.which === 27) {
      //esc for save
      e.preventDefault()
      $textarea.trigger('focusout')
      return false
    }

    if ((e.ctrlKey || e.metaKey) && e.which === 83) {
      //ctrl-s for save
      e.preventDefault()
      $textarea.trigger('focusout')
      return false
    }

    if ((e.ctrlKey || e.metaKey) && e.which === 73) {
      //ctrl-i for information
      let page
      e.preventDefault()
      if (!e.shiftKey) {
        page = $(e.target).parents('.page')
      }
      link.doInternalLink(`about ${item.type} plugin`, page)
      return false
    }

    if ((e.ctrlKey || e.metaKey) && e.which === 77) {
      //ctrl-m for menu
      e.preventDefault()
      $item.data('originalType', item.type)
      $item.removeClass(item.type).addClass((item.type = 'factory'))
      $textarea.trigger('focusout')
      return false
    }

    // provides automatic new paragraphs on enter and concatenation on backspace
    if (item.type === 'paragraph' || item.type === 'markdown') {
      let suffix
      const sel = getSelectionPos($textarea) // position of caret or selected text coords

      if (e.which === 8 && sel.start === 0 && sel.start === sel.end) {
        const $previous = $item.prev()
        const previous = itemz.getItem($previous)
        if (previous.type !== item.type) {
          return false
        }
        const caret = previous[option.field || 'text'].length
        suffix = $textarea.val()
        $textarea.val('') // Need current text area to be empty. Item then gets deleted.
        textEditor($previous, previous, { caret, suffix })
        return false
      }

      if (e.which === 13) {
        // console.log "Type: #{item.type}, enterCount: #{enterCount}"
        if (!sel) {
          return false
        }
        if (item.type === 'markdown') {
          enterCount++
        }
        // console.log "Type: #{item.type}, enterCount: #{enterCount}"
        if (item.type === 'paragraph' || (item.type === 'markdown' && enterCount === 2)) {
          const $page = $item.parents('.page')
          const text = $textarea.val()
          const prefix = text.substring(0, sel.start).trim()
          suffix = text.substring(sel.end).trim()
          if (prefix === '') {
            $textarea.val(suffix)
            $textarea.trigger('focusout')
            spawnEditor($page, $item.prev(), item.type, prefix)
          } else {
            $textarea.val(prefix)
            $textarea.trigger('focusout')
            spawnEditor($page, $item, item.type, suffix)
          }
          return false
        }
      } else {
        if (item.type === 'markdown') {
          enterCount = 0
        }
      }
    }
  }

  const focusoutHandler = function () {
    // Phone-back IME dismiss blurs without committing; leave the editor open.
    if (suppressEditorFocusout) return
    $item.removeClass('textEditing')
    restorePageEl = $item.parents('.page:first').get(0) || restorePageEl
    setMobileEditing(false)
    $textarea.off()
    const $page = $item.parents('.page:first')
    if ((item[option.field || 'text'] = $textarea.val())) {
      // Remove output and source styling as type may have changed.
      $item.removeClass('output-item')
      $item.removeClass((_index, className) => (className.match(/\S+-source/) || []).join(' '))
      plugin.do($item.empty(), item)
      story.ensure($item)
      if (option.after) {
        if (item[option.field || 'text'] === '') {
          return
        }
        pageHandler.put($page, { type: 'add', id: item.id, item, after: option.after })
      } else {
        if (
          item[option.field || 'text'] !== original ||
          (item.type != 'factory' && $item.data('originalType') && $item.data('originalType') != item.type)
        ) {
          $item.removeData('originalType')
          pageHandler.put($page, { type: 'edit', id: item.id, item })
        }
      }
    } else {
      if (!option.after) {
        pageHandler.put($page, { type: 'remove', id: item.id })
      }
      const index = $('.item').index($item)
      $item.remove()
      plugin.renderFrom(index)
    }
  }

  if ($item.hasClass('textEditing')) {
    return
  }
  try {
    hideItemChrome()
  } catch (_) {
    $('.item-action-toolbar').remove()
    $('.item.toolbar-active').removeClass('toolbar-active')
  }
  $item.addClass('textEditing')
  setMobileEditing(true)
  $item.off()
  var original = item[option.field || 'text'] || ''
  var $textarea = $(`<textarea>${escape(original)}${escape(option.suffix || '')}</textarea>`)
    .on('focusout', focusoutHandler)
    .on('keydown', keydownHandler)
  $item.html($textarea)
  // Defer focus until after mobile layout (footer hide) settles — focusing
  // during that reflow dismisses the IME on Android and can fire focusout.
  const placeCaret = () => {
    if (option.caret) {
      setCaretPosition($textarea, option.caret)
    } else if (option.append) {
      setCaretPosition($textarea, $textarea.val().length)
      $textarea.scrollTop($textarea[0].scrollHeight - $textarea.height())
    } else {
      focusFieldNoScroll($textarea[0])
    }
    layoutMobileEditor()
  }
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      placeCaret()
      syncEditorScrollport($textarea[0])
    }),
  )
}

var spawnEditor = function ($page, $before, type, text) {
  const item = {
    type,
    id: random.itemId(),
    text,
  }
  const $item = $(`<div class="item ${item.type}" data-id=${item.id}></div>`)
  $item.data('item', item).data('pageElement', $page)
  $before.after($item)
  const before = itemz.getItem($before)
  textEditor($item, item, { after: before?.id })
}

// If the selection start and selection end are both the same,
// then you have the caret position. If there is selected text,
// the browser will not tell you where the caret is, but it will
// either be at the beginning or the end of the selection
// (depending on the direction of the selection).

var getSelectionPos = function ($textarea) {
  const el = $textarea.get(0) // gets DOM Node from from jQuery wrapper
  if (document.selection) {
    // IE
    el.focus()
    const sel = document.selection.createRange()
    sel.moveStart('character', -el.value.length)
    const iePos = sel.text.length
    return { start: iePos, end: iePos }
  } else {
    return { start: el.selectionStart, end: el.selectionEnd }
  }
}

var setCaretPosition = function ($textarea, caretPos) {
  const el = $textarea.get(0)
  if (el) {
    if (el.createTextRange) {
      // IE
      const range = el.createTextRange()
      range.move('character', caretPos)
      range.select()
    } else {
      // rest of the world
      el.setSelectionRange(caretPos, caretPos)
    }
    focusFieldNoScroll(el)
  }
}

// # may want special processing on paste eventually
// textarea.bind 'paste', (e) ->
//   console.log 'textedit paste', e
//   console.log e.originalEvent.clipboardData.getData('text')

// --- item tap chrome (was itemToolbar.js) ---

// Mobile/touch item chrome while editing.
// Tap an item → drag handle + edit pencil. Drag to reorder; tap pencil to edit.
// No floating action menu (reorder is drag-only).

let lastPointerType = 'mouse'
let suppressHandleClick = false

const hideItemChrome = function (opts = {}) {
  $('.item.toolbar-active').removeClass('toolbar-active')
  $('.item-action-toolbar').remove()
  if (opts.clearSelection) {
    story.clear()
    refresh.clearJournalSelection()
  }
}

const chromeApplies = () =>
  story.isEditOn() && (story.needsDragHandle() || lastPointerType === 'touch')

const bindItemChrome = function () {
  document.addEventListener(
    'pointerdown',
    (e) => {
      lastPointerType = e.pointerType || 'mouse'
    },
    true,
  )

  $(document)
    .on('click.itemToolbar', '.page .story .item', function (e) {
      if (!chromeApplies()) return
      if (
        $(e.target).closest(
          `a, button, .${story.HANDLE_CLASS}, .${story.EDIT_CLASS}, textarea, input`,
        ).length
      ) {
        return
      }
      if (story.shouldSuppressItemClick()) return
      if (pages.shouldSuppressLineupNavItemClick()) return
      if ($(this).hasClass('textEditing') || $(this).hasClass('imageEditing')) return
      const $item = $(this)
      const id = $item.attr('data-id')
      // Second tap on the selected item deselects (hides handle + pencil).
      if (
        $item.hasClass('handle-selected') ||
        (id && String(story.getSelectedId()) === String(id))
      ) {
        hideItemChrome({ clearSelection: true })
        return
      }
      hideItemChrome()
      refresh.clearJournalSelection()
      story.select($item)
    })
    .on('click.itemToolbar', '.page .journal', function (e) {
      if (!chromeApplies()) return
      if ($(e.target).closest('.action, .control-buttons, a, button').length) return
      if (refresh.shouldSuppressJournalClick()) return
      if (pages.shouldSuppressLineupNavItemClick()) return
      const $journal = $(this)
      // Second tap deselects (no handle/pencil — journals are select + long-press only).
      if ($journal.hasClass(refresh.JOURNAL_SELECTED_CLASS)) {
        hideItemChrome({ clearSelection: true })
        return
      }
      hideItemChrome()
      story.clear()
      refresh.selectJournal($journal)
    })
    .on('click.itemToolbar', `.${story.EDIT_CLASS}`, function (e) {
      if (!chromeApplies()) return
      e.preventDefault()
      e.stopPropagation()
      const $item = $(this).closest('.item')
      const item = story.getItem($item)
      hideItemChrome()
      story.clear()
      if ($item.length && item) openItemEditor($item, item)
    })
    .on('click.itemToolbar', `.${story.HANDLE_CLASS}`, function (e) {
      // Handle is for drag only; ignore tap (Sortable owns the gesture).
      if (suppressHandleClick) {
        suppressHandleClick = false
        e.preventDefault()
        e.stopPropagation()
      }
    })
    .on('click.itemToolbar', function (e) {
      if (
        $(e.target).closest(
          `.${story.HANDLE_CLASS}, .${story.EDIT_CLASS}, .page .story .item, .page .journal`,
        ).length
      ) {
        return
      }
      hideItemChrome({ clearSelection: true })
    })
}

const noteDragStarted = function () {
  suppressHandleClick = true
  setTimeout(() => {
    suppressHandleClick = false
  }, 400)
}

const wasTouchActivation = () => lastPointerType === 'touch'

const EDITING_ITEM = '.item.textEditing, .item.imageEditing'

const isEditingEl = el =>
  !!el?.classList?.contains('textEditing') || !!el?.classList?.contains('imageEditing')

// Prefer plugin editor (code language field, image chrome, …); same UI as
// desktop dblclick. Fall back to the generic textarea if the plugin no-ops.
const openItemEditor = function ($item, item) {
  const focusField = el => {
    const field = el?.querySelector?.('textarea, input, select')
    if (!field || typeof field.focus !== 'function') return
    requestAnimationFrame(() => {
      try {
        field.focus({ preventScroll: true })
      } catch (_) {
        field.focus()
      }
      if (field instanceof HTMLTextAreaElement) syncEditorScrollport(field)
      layoutMobileEditor()
    })
  }

  const pluginEditor = window.plugins?.[item.type]?.editor
  if (typeof pluginEditor !== 'function') {
    textEditor($item, item, { append: true })
    return
  }

  const el = $item[0]
  try {
    const result =
      item.type === 'image' || pluginEditor.length <= 1
        ? pluginEditor({ $item, item })
        : pluginEditor($item, item)
    Promise.resolve(result)
      .catch(() => {})
      .then(() => {
        if (!isEditingEl(el)) {
          textEditor($item, item, { append: true })
          return
        }
        setMobileEditing(true)
        const mo =
          el && typeof MutationObserver === 'function'
            ? new MutationObserver(() => {
                if (!el.isConnected || !isEditingEl(el)) {
                  setMobileEditing(false)
                  mo.disconnect()
                }
              })
            : null
        mo?.observe(el, { attributes: true, attributeFilter: ['class'] })
        focusField(el)
      })
  } catch (_) {
    textEditor($item, item, { append: true })
  }
}

const revertEditorFields = function ($editing, item) {
  if (!item) return
  $editing.find('textarea').val(item.text || '')
  const $lang = $editing.find('#code-language')
  if ($lang.length) $lang.val(item.language || '')
}

// Code/image plugins save on document pointerdown outside $item. Fire one so
// they unbind that handler; fields must already be reverted or they will put.
const flushPluginOutsidePress = () => $(document.body).trigger('pointerdown')

const discardOpenEditor = function () {
  const $editing = $(EDITING_ITEM)
  if (!$editing.length) return false
  const $textarea = $editing.find('textarea')
  $textarea.off('focusout')
  const item = $editing.data('item')
  revertEditorFields($editing, item)
  flushPluginOutsidePress()
  $editing.removeClass('textEditing imageEditing')
  setMobileEditing(false)
  if (item) {
    const plugin = require('./plugin')
    plugin.do($editing.empty(), item)
    story.ensure($editing)
  } else {
    $editing.empty()
  }
  return true
}

const hasOpenEditor = () => $(EDITING_ITEM).length > 0

module.exports = {
  textEditor,
  setMobileEditing,
  syncEditorScrollport,
  syncOpenEditorScrollports,
  layoutMobileEditor,
  bindItemChrome,
  hide: hideItemChrome,
  noteDragStarted,
  wasTouchActivation,
  discardOpenEditor,
  hasOpenEditor,
}
