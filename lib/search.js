// The search module invokes neighborhood's query function,
// formats the results as story items, and then opens a
// page to present them.

const pageHandler = require('./pageHandler')
const random = require('./random')
const link = require('./link')
// const active = require('./active')
const { newPage } = require('./page')
const resolve = require('./resolve')
let page = require('./page')

// from: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions
//const escapeRegExp = string => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const deepCopy = object => JSON.parse(JSON.stringify(object))

const isMobileViewport = () => window.matchMedia('(max-width: 490px)').matches

// Mobile back while searching: first press dismisses the IME (Android often
// does that without popstate); the next popstate hides the results overlay
// and leaves the query in the field so a later tap can reopen it.
let searchHistoryPushed = false
let ignoringSearchPopstate = false
let hideSearchOverlayKeepQuery = () => {
  document.querySelector('.incremental-search')?.remove()
}

const searchImeOpen = () => {
  const vv = window.visualViewport
  if (!vv || typeof vv.height !== 'number') return false
  // Do not use search's keyboardLatched here — after a native IME dismiss
  // (no popstate) latch can stay true and would steal the second back.
  return window.innerHeight - (vv.height + (vv.offsetTop || 0)) > 80
}

const pushSearchHistory = () => {
  if (searchHistoryPushed || !isMobileViewport()) return
  try {
    history.pushState(Object.assign({}, history.state, { wikiMobileSearch: 1 }), '')
    searchHistoryPushed = true
  } catch (_) {
    /* private mode / missing history */
  }
}

const consumeSearchHistory = () => {
  if (!searchHistoryPushed) return
  searchHistoryPushed = false
  if (!history.state?.wikiMobileSearch) return
  ignoringSearchPopstate = true
  history.back()
  requestAnimationFrame(() => {
    ignoringSearchPopstate = false
  })
}

window.addEventListener(
  'popstate',
  e => {
    if (ignoringSearchPopstate) {
      e.stopImmediatePropagation()
      return
    }
    if (!searchHistoryPushed) return
    const chromeUp =
      document.body.classList.contains('wiki-mobile-searching') ||
      !!document.querySelector('.incremental-search')
    if (!chromeUp) {
      // Overlay already gone (clear / result); don't steal lineup navigation.
      searchHistoryPushed = false
      return
    }
    e.stopImmediatePropagation()
    const input = document.querySelector('input.search')
    if (searchImeOpen() && input && document.activeElement === input) {
      input.blur()
      try {
        history.pushState(Object.assign({}, history.state, { wikiMobileSearch: 1 }), '')
      } catch (_) {
        /* private mode / missing history */
      }
      return
    }
    searchHistoryPushed = false
    hideSearchOverlayKeepQuery()
  },
  true,
)

// From reference.coffee
const emit = function ($item, item) {
  let slug = item.slug
  if (item.title) {
    slug ||= page.asSlug(item.title)
  }
  slug ||= 'welcome-visitors'
  const site = item.site
  resolve.resolveFrom(site, () =>
    $item.append(`\
<p>
<img class='remote'
  src='${wiki.site(site).flag()}'
  title='${site}'
  data-site="${site}"
  data-slug="${slug}"
>
${resolve.resolveLinks(`[[${item.title || slug}]]`)}
—
${resolve.resolveLinks(item.text)}
</p>\
`),
  )
}
const finishClick = function (e, name) {
  e.preventDefault()
  if (!e.shiftKey) {
    page = $(e.target).parents('.page')
  }
  link.doInternalLink(name, page, $(e.target).data('site'))
  return false
}

const createSearch = function ({ neighborhood }) {
  let viewportBound = false
  let bgScrollBlocked = false
  let restoringSearchFocus = false
  // Snapshot layout height when search starts so we can detect IME with
  // interactive-widget=resizes-content (inset becomes ~0 after layout shrinks).
  let layoutHeightAtSearchStart = 0
  // Once the IME is detected, keep keyboard chrome on until search ends —
  // lineup load / footer reflows used to flip this and violently flicker.
  let keyboardLatched = false
  let layoutRaf = null
  let restoreRaf = null

  const keyboardBottomInset = () => {
    const vv = window.visualViewport
    if (!vv) return 0
    return Math.max(0, window.innerHeight - (vv.height + vv.offsetTop))
  }

  // Android cancels the IME if the focused input moves. Pin/hide-hood only after
  // a real keyboard inset, then immediately restore focus with preventScroll.
  const KEYBOARD_INSET_PX = 80

  const searchInput = () => document.querySelector('input.search')

  const keyboardLikelyOpen = () => {
    if (keyboardLatched) return true
    if (keyboardBottomInset() >= KEYBOARD_INSET_PX) return true
    if (
      layoutHeightAtSearchStart > 0 &&
      window.innerHeight < layoutHeightAtSearchStart - KEYBOARD_INSET_PX
    ) {
      return true
    }
    return false
  }

  const clearRestoringSearchFocus = () => {
    restoringSearchFocus = false
  }

  const restoreSearchFocus = () => {
    if (!isMobileViewport()) return
    if (!document.body.classList.contains('wiki-mobile-searching')) return
    const input = searchInput()
    if (!input) return
    if (document.activeElement === input) return
    // Coalesce to one attempt per frame — lineup load can blur many times.
    if (restoreRaf != null) return
    restoringSearchFocus = true
    restoreRaf = requestAnimationFrame(() => {
      restoreRaf = null
      if (!document.body.classList.contains('wiki-mobile-searching')) {
        restoringSearchFocus = false
        return
      }
      if (document.activeElement === input) {
        restoringSearchFocus = false
        return
      }
      const onFocus = () => {
        input.removeEventListener('focus', onFocus)
        restoringSearchFocus = false
      }
      input.addEventListener('focus', onFocus)
      try {
        input.focus({ preventScroll: true })
      } catch (_) {
        input.focus()
      }
      // If focus was refused, clear the guard on the next microtask.
      queueMicrotask(() => {
        if (document.activeElement === input) restoringSearchFocus = false
        else {
          input.removeEventListener('focus', onFocus)
          restoringSearchFocus = false
        }
      })
    })
  }

  const KEYBOARD_GAP_ID = 'wiki-mobile-keyboard-gap'

  // Pin/gap helpers remain for older experiments; layoutMobileSearchChrome must
  // not enable them under resizes-content (see comment there) or the IME dies.
  const clearFooterPin = () => {
    const footer = document.querySelector('footer')
    if (!footer) return
    footer.style.bottom = ''
    footer.style.top = ''
    footer.style.position = ''
    footer.style.left = ''
    footer.style.right = ''
    footer.style.zIndex = ''
    footer.style.height = ''
    footer.style.minHeight = ''
    footer.style.paddingBottom = ''
    footer.style.boxSizing = ''
    footer.style.alignItems = ''
  }

  const clearOverlayPin = overlay => {
    if (!overlay) return
    overlay.style.position = ''
    overlay.style.left = ''
    overlay.style.right = ''
    overlay.style.width = ''
    overlay.style.maxWidth = ''
    overlay.style.bottom = ''
    overlay.style.top = ''
    overlay.style.height = ''
    overlay.style.maxHeight = ''
    overlay.style.zIndex = ''
    overlay.style.boxSizing = ''
  }

  const clearKeyboardGap = () => {
    const gap = document.getElementById(KEYBOARD_GAP_ID)
    if (gap) gap.remove()
  }

  const setKeyboardChrome = on => {
    document.body.classList.toggle('wiki-mobile-search-keyboard', !!on)
    if (!on) clearKeyboardGap()
  }

  const blockBackgroundScroll = e => {
    // Stop lineup under the results from scrolling without overflow:hidden on
    // body/main (that dismisses the IME when applied on focus).
    if (!document.body.classList.contains('wiki-mobile-searching')) return
    if (e.target.closest?.('.incremental-search, footer, input.search')) return
    e.preventDefault()
  }

  const setBackgroundScrollBlocked = on => {
    if (on && !bgScrollBlocked) {
      document.addEventListener('touchmove', blockBackgroundScroll, { passive: false })
      bgScrollBlocked = true
    } else if (!on && bgScrollBlocked) {
      document.removeEventListener('touchmove', blockBackgroundScroll)
      bgScrollBlocked = false
    }
  }

  const pinOverlayAboveFooter = (overlay, footer) => {
    if (!overlay || !footer) return
    const fr = footer.getBoundingClientRect()
    const vv = window.visualViewport
    // Fill the visible area above the search/footer so results grow upward
    // from the search bar (stock FedWiki), never downward under the keyboard.
    // Stacked mobile: extend the overlay over the flag band (do not hide the
    // hood — empty focus should still show neighbors; only results cover them).
    let coverBottom = fr.top
    if (footer.classList.contains('neighborhood-above')) {
      const hood = footer.querySelector('.neighborhood')
      if (hood) {
        const hr = hood.getBoundingClientRect()
        if (hr.height > 0) coverBottom = Math.max(coverBottom, hr.bottom)
      }
      const chrome = [
        footer.querySelector('.footer-controls'),
        footer.querySelector(':scope > #site-owner'),
        footer.querySelector(':scope > #security'),
        footer.querySelector(':scope > .footer-menu'),
      ].filter(Boolean)
      const tops = chrome.map(el => el.getBoundingClientRect().top)
      if (tops.length) coverBottom = Math.max(coverBottom, Math.min(...tops))
    }
    const top = Math.max(0, vv ? Math.round(vv.offsetTop) : 0)
    const bottom = Math.max(0, Math.round(window.innerHeight - coverBottom))
    overlay.style.position = 'fixed'
    overlay.style.left = '0'
    overlay.style.right = '0'
    overlay.style.width = '100%'
    overlay.style.maxWidth = 'none'
    overlay.style.top = `${top}px`
    overlay.style.bottom = `${bottom}px`
    overlay.style.height = 'auto'
    overlay.style.maxHeight = 'none'
    overlay.style.zIndex = '1100'
    overlay.style.boxSizing = 'border-box'
    overlay.style.overflowY = 'auto'
  }

  const layoutMobileSearchChrome = () => {
    if (!isMobileViewport() || !document.body.classList.contains('wiki-mobile-searching')) {
      setKeyboardChrome(false)
      clearFooterPin()
      clearOverlayPin(document.querySelector('.incremental-search'))
      clearKeyboardGap()
      return
    }
    const footer = document.querySelector('footer')
    const overlay = document.querySelector('.incremental-search')
    if (!footer) return

    const keyboardOpen = keyboardLikelyOpen()
    if (keyboardOpen) keyboardLatched = true

    // static.html uses interactive-widget=resizes-content: the layout viewport
    // already shrinks above the IME, so a normal position:fixed;bottom:0 footer
    // stays put. Re-pinning the footer, toggling overflow:hidden, or hiding the
    // neighborhood moves the focused input and instantly dismisses the keyboard
    // (flash open → close). Only position the results overlay.
    setKeyboardChrome(false)
    clearFooterPin()
    clearKeyboardGap()
    if (overlay) pinOverlayAboveFooter(overlay, footer)
  }

  const onViewportChange = () => {
    if (layoutRaf != null) return
    layoutRaf = requestAnimationFrame(() => {
      layoutRaf = null
      layoutMobileSearchChrome()
    })
  }

  const bindViewport = () => {
    if (viewportBound) return
    viewportBound = true
    window.visualViewport?.addEventListener('resize', onViewportChange)
    window.visualViewport?.addEventListener('scroll', onViewportChange)
    window.addEventListener('resize', onViewportChange)
  }

  const unbindViewport = () => {
    if (!viewportBound) return
    viewportBound = false
    if (layoutRaf != null) {
      cancelAnimationFrame(layoutRaf)
      layoutRaf = null
    }
    window.visualViewport?.removeEventListener('resize', onViewportChange)
    window.visualViewport?.removeEventListener('scroll', onViewportChange)
    window.removeEventListener('resize', onViewportChange)
  }

  const setMobileSearching = on => {
    const want = !!(on && isMobileViewport())
    const isOn = document.body.classList.contains('wiki-mobile-searching')
    // Desktop placeIncrementalSearch calls setMobileSearching(false) every keystroke —
    // no-op when already off so we don't tear down overlay pins / schedule footer work.
    if (want === isOn) {
      if (want) {
        bindViewport()
        layoutMobileSearchChrome()
      }
      return
    }
    if (want) {
      layoutHeightAtSearchStart = Math.max(
        window.innerHeight,
        window.visualViewport?.height || 0,
      )
      keyboardLatched = false
      if (restoreRaf != null) {
        cancelAnimationFrame(restoreRaf)
        restoreRaf = null
      }
      restoringSearchFocus = false
    } else {
      layoutHeightAtSearchStart = 0
      keyboardLatched = false
      if (restoreRaf != null) {
        cancelAnimationFrame(restoreRaf)
        restoreRaf = null
      }
      restoringSearchFocus = false
    }
    document.body.classList.toggle('wiki-mobile-searching', want)
    setBackgroundScrollBlocked(want)
    if (want) {
      pushSearchHistory()
      try {
        require('./neighbors').freezeFooterStack()
        require('./neighbors').requestLayout()
      } catch (_) {
        /* optional during early boot */
      }
      bindViewport()
      layoutMobileSearchChrome()
    } else {
      consumeSearchHistory()
      unbindViewport()
      setKeyboardChrome(false)
      clearFooterPin()
      clearOverlayPin(document.querySelector('.incremental-search'))
      clearKeyboardGap()
      // Restore pre-search one-row vs stacked after keyboard chrome shows flags again.
      requestAnimationFrame(() => {
        try {
          require('./neighbors').unfreezeFooterStack()
        } catch (_) {
          /* optional during early boot */
        }
      })
    }
  }

  // Desktop: re-pin when the search field moves (window resize or footer
  // stack/unstack). Overlay lives on document.body so it cannot affect footer flex.
  let desktopOverlayResizeBound = false
  let lastDesktopOverlayPin = null
  const unbindDesktopOverlayResize = () => {
    if (!desktopOverlayResizeBound) return
    desktopOverlayResizeBound = false
    lastDesktopOverlayPin = null
    window.removeEventListener('resize', onDesktopOverlayResize)
    document.removeEventListener('wiki:footer-layout', onDesktopOverlayResize)
  }
  const onDesktopOverlayResize = () => {
    if (isMobileViewport()) {
      unbindDesktopOverlayResize()
      return
    }
    const el = document.querySelector('.incremental-search')
    if (!el) {
      unbindDesktopOverlayResize()
      return
    }
    placeIncrementalSearch($(el))
  }
  const bindDesktopOverlayResize = () => {
    if (desktopOverlayResizeBound) return
    desktopOverlayResizeBound = true
    window.addEventListener('resize', onDesktopOverlayResize)
    document.addEventListener('wiki:footer-layout', onDesktopOverlayResize)
  }

  const placeIncrementalSearch = $el => {
    const $searchbox = $('.searchbox')
    if (!$searchbox.length) return
    // Always on <body> — never a footer descendant (that polluted flex math).
    if (!$el.parent().is('body')) $el.appendTo(document.body)
    const mobile = isMobileViewport()

    if (mobile) {
      setMobileSearching(true)
      unbindDesktopOverlayResize()
      layoutMobileSearchChrome()
      return
    }

    // Desktop: fixed to the viewport, anchored above the search field.
    setMobileSearching(false)
    bindDesktopOverlayResize()
    const fieldEl = $searchbox.find('.search-field')[0] || $searchbox[0]
    const PREFERRED_W = 450
    const MARGIN = 12
    const vw = window.innerWidth || document.documentElement.clientWidth || PREFERRED_W
    const vh = window.innerHeight || document.documentElement.clientHeight || 0
    const fieldRect = fieldEl.getBoundingClientRect()
    let viewportLeft = fieldRect.left
    if (viewportLeft + PREFERRED_W > vw - MARGIN) {
      viewportLeft = vw - MARGIN - PREFERRED_W
    }
    if (viewportLeft < MARGIN) {
      // Prefer hanging off the right over shrinking the panel.
      viewportLeft = MARGIN
    }
    const left = Math.round(viewportLeft)
    // Fixed: distance from viewport bottom to just above the field.
    const bottom = Math.round(vh - fieldRect.top + 4)
    const pin = { left, bottom, width: PREFERRED_W }
    // DevTools inspect / focus chrome can fire resize without the field moving —
    // skip style writes so the panel doesn't jump under the picker.
    // Important: do not clearOverlayPin before this check — wiping then returning
    // leaves CSS position:absolute at the body's static position (bottom-left).
    if (
      lastDesktopOverlayPin &&
      lastDesktopOverlayPin.left === pin.left &&
      lastDesktopOverlayPin.bottom === pin.bottom &&
      lastDesktopOverlayPin.width === pin.width
    ) {
      return
    }
    lastDesktopOverlayPin = pin
    // Overwrite any mobile full-bleed pin (top/left/right/width) in one write.
    $el.css({
      position: 'fixed',
      left: `${left}px`,
      right: 'auto',
      top: 'auto',
      width: `${PREFERRED_W}px`,
      height: 'auto',
      maxWidth: `${PREFERRED_W}px`,
      maxHeight: '300px',
      bottom: `${bottom}px`,
      marginBottom: '0',
      // Above footer (z-index 1000) so the panel isn't covered by flags.
      zIndex: 1001,
      boxSizing: 'border-box',
    })
  }

  const endMobileSearchUi = () => {
    setMobileSearching(false)
    unbindDesktopOverlayResize()
    try {
      require('./neighbors').unfreezeFooterStack()
    } catch (_) {
      /* optional during early boot */
    }
  }

  // Popstate second-back: drop overlay + chrome, keep input.value.
  hideSearchOverlayKeepQuery = () => {
    $('.incremental-search').remove()
    endMobileSearchUi()
    const input = searchInput()
    if (input && document.activeElement === input) input.blur()
  }

  const isRestoringSearchFocus = () => restoringSearchFocus

  const incrementalSearch = function (searchQuery) {
    if (searchQuery.length < 2) {
      $('.incremental-search').remove()
      // Opening mobile search freezes/relayouts the footer and can blur the input
      // before this runs (same focus turn). Don't tear down just because :focus
      // already flipped — body.wiki-mobile-searching means we still want the chrome.
      if (
        isMobileViewport() &&
        ($('input.search').is(':focus') ||
          document.body.classList.contains('wiki-mobile-searching'))
      ) {
        setMobileSearching(true)
      } else {
        endMobileSearchUi()
      }
      return
    }
    if ($('.incremental-search').length === 0) {
      const $overlay = $('<div/>')
        .addClass('incremental-search')
        .attr('tabindex', '-1')
        .on('click', '.internal', function (e) {
          if (e.target.nodeName === 'SPAN') {
            e.target = $(e.target).parent()[0]
          }
          let name = $(e.target).data('pageName')
          // ensure that name is a string (using string interpolation)
          name = `${name}`
          pageHandler.context = $(e.target).attr('title').split(' => ')
          finishClick(e, name)
          // keep focus on clicked result so more results can be opened
          e.target.focus()
          return false
        })
        .on('click', 'img.remote', function (e) {
          // expand to handle click on temporary flag
          if ($(e.target).attr('src').startsWith('data:image/png')) {
            e.preventDefault()
            const site = $(e.target).data('site')
            wiki.site(site).refresh(function () {})
          } else {
            const name = $(e.target).data('slug')
            pageHandler.context = [$(e.target).data('site')]
            return finishClick(e, name)
          }
          return false
        })
        // Keep scroll gestures inside the results panel.
        .on('wheel touchmove', function (e) {
          e.stopPropagation()
        })
      placeIncrementalSearch($overlay)
    } else {
      placeIncrementalSearch($('.incremental-search'))
    }

    const searchResults = neighborhood.search(searchQuery)
    const searchTerms = searchQuery
      .split(' ')
      .map(t => t.toLowerCase())
      .filter(String)
    const searchHighlightRegExp = new RegExp(
      '\\b(' +
        searchQuery
          .split(' ')
          .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .filter(String)
          .join('|') +
        ')',
      'i',
    )
    const highlightText = text =>
      text
        .split(searchHighlightRegExp)
        .map(function (p) {
          if (searchTerms.includes(p.toLowerCase())) {
            return `{{${p}}}`
          } else {
            return p
          }
        })
        .join('')
    const $search = $('.incremental-search').empty()
    if (!searchResults.finds || searchResults.finds.length === 0) {
      $('<div/>').text('No results found').addClass('no-results').appendTo($search)
    }
    let count = 0
    const max_results = 100
    for (const result of searchResults.finds) {
      count++
      if (count === max_results + 1) {
        $('<div/>')
          .text(`${searchResults.finds.length - max_results} results omitted`)
          .addClass('omitted-results')
          .appendTo($search)
      }
      if (count > max_results) {
        continue
      }
      const $item = $('<div/>').appendTo($search)
      const item = {
        id: random.itemId(),
        type: 'reference',
        site: result.site,
        slug: result.page.slug,
        title: highlightText(result.page.title),
        text: highlightText(result.page.synopsis),
      }
      emit($item, item)
      $item.html(
        $item
          .html()
          .split(new RegExp('({{.*?}})', 'i'))
          .map(p => {
            if (p.indexOf('{{') === 0) {
              return `<span class='search-term'>${p.substring(2, p.length - 2)}</span>`
            } else {
              return p
            }
          })
          .join(''),
      )
    }
    if (isMobileViewport()) layoutMobileSearchChrome()
  }

  const performSearch = function (searchQuery) {
    const searchResults = neighborhood.search(searchQuery)
    if (searchResults.finds && searchResults.finds.length === 1) {
      $('.incremental-search').find('.internal').trigger('click')
      $('.incremental-search').remove()
      endMobileSearchUi()
      return
    }
    $('.incremental-search').remove()
    endMobileSearchUi()
    const { tally } = searchResults
    const resultPage = {}
    resultPage.title = `Search for '${searchQuery}'`
    resultPage.story = []
    resultPage.story.push({
      type: 'paragraph',
      id: random.itemId(),
      text: `\
String '${searchQuery}' found on ${tally.finds || 'none'} of ${tally.pages || 'no'} pages from ${tally.sites || 'no'} sites.
Text matched on ${tally.title || 'no'} titles, ${tally.text || 'no'} paragraphs, and ${tally.slug || 'no'} slugs.
Elapsed time ${tally.msec} milliseconds.\
`,
    })
    for (var result of searchResults.finds) {
      resultPage.story.push({
        id: random.itemId(),
        type: 'reference',
        site: result.site,
        slug: result.page.slug,
        title: result.page.title,
        text: result.page.synopsis || '',
      })
    }

    resultPage.journal = [
      {
        type: 'create',
        item: {
          title: resultPage.title,
          story: deepCopy(resultPage.story),
        },
        date: Date.now(),
      },
    ]
    const pageObject = newPage(resultPage)
    link.showResult(pageObject)
  }

  return {
    incrementalSearch,
    performSearch,
    endMobileSearchUi,
    setMobileSearching,
    layoutMobileSearchChrome,
    restoreSearchFocus,
    isRestoringSearchFocus,
    clearRestoringSearchFocus,
    keyboardBottomInset,
  }
}
module.exports = createSearch
