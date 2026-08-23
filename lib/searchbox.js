// Handle input events from the search box. There is machinery
// here that supports incremental search.
// We use dependency injection to break dependency loops.

const createSearch = require('./search')

let search = null

const inject = neighborhood => (search = createSearch({ neighborhood }))

const CLEAR_HTML =
  '<button type="button" class="search-clear" aria-label="Clear search" title="Clear search" hidden>' +
  '<span class="search-clear-glyph" aria-hidden="true"></span></button>'

const bind = function () {
  const $search = $('input.search')
  const $searchbox = $search.closest('.searchbox')
  // Ensure clear control exists even if an older static shell is cached.
  let $clear = $searchbox.find('.search-clear')
  if (!$clear.length) {
    if (!$search.parent().hasClass('search-field')) {
      $search.wrap('<span class="search-field"></span>')
    }
    $clear = $(CLEAR_HTML)
    $search.after($clear)
  } else if (!$clear.find('.search-clear-glyph').length) {
    // Upgrade older empty/SVG clear buttons to the span-glyph version.
    $clear.empty().append('<span class="search-clear-glyph" aria-hidden="true"></span>')
  }

  // Best-effort: discourage browser password/payment accessory chrome on focus.
  // Avoid inputmode=search / role=searchbox on mobile — on Samsung Chrome + S-Pen
  // those can hand the gesture to the browser omnibox instead of this field.
  const syncSearchAttrs = () => {
    const mobile = window.matchMedia('(max-width: 490px)').matches
    $search.attr({
      autocomplete: 'off',
      autocorrect: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      enterkeyhint: 'search',
      name: 'wiki-site-search',
      inputmode: mobile ? 'text' : 'search',
    })
    if (mobile) $search.removeAttr('role')
    else $search.attr('role', 'searchbox')
  }
  syncSearchAttrs()
  window.matchMedia('(max-width: 490px)').addEventListener('change', syncSearchAttrs)

  const syncPlaceholder = () => {
    // Default full placeholder; neighbors.syncFooterSearchWidth may shorten to 🔍
    // when the field is too narrow (icon floor). Keep this in sync on viewport flips.
    $search.attr('placeholder', '🔍 Search')
  }
  syncPlaceholder()
  window.matchMedia('(max-width: 490px)').addEventListener('change', syncPlaceholder)

  // Gesture-scoped dismiss suppress — cleared on pointerup, not a wall-clock grace.
  let searchGestureActive = false
  let mobileChromePending = false

  const syncClearButton = () => {
    const hasText = !!String($search.val() || '')
    // Desktop and mobile: only with text. Showing clear on empty mobile focus
    // ate the whole icon-floor field (36px pad in a ~44px box) and Android
    // dropped/mangled the first keystrokes.
    if (hasText) $clear.removeAttr('hidden')
    else $clear.attr('hidden', 'hidden')
    $searchbox.toggleClass('has-search-clear', hasText)
  }

  const applyMobileSearchChrome = () => {
    // Turn on body.wiki-mobile-searching + results overlay once focus is stable.
    // Deferred from pointerdown so layout during the opening gesture doesn't
    // flicker the field or hand the tap to the browser omnibox.
    mobileChromePending = false
    if (document.activeElement !== $search[0]) return
    if (!window.matchMedia('(max-width: 490px)').matches) return
    search?.setMobileSearching?.(true)
    search.incrementalSearch(String($search.val() || ''))
    syncClearButton()
  }

  const closeSearchUi = () => {
    mobileChromePending = false
    searchGestureActive = false
    $('.incremental-search').remove()
    search?.endMobileSearchUi?.()
    syncClearButton()
  }

  const clearAndCloseSearch = () => {
    $search.val('')
    closeSearchUi()
    $search.blur()
    syncClearButton()
  }

  const endSearchGesture = () => {
    if (!searchGestureActive) return
    searchGestureActive = false
    // Apply deferred mobile chrome after the opening pointer is done — layout
    // during pointerdown/focus flickers the field and can hand off to the omnibox.
    if (mobileChromePending) applyMobileSearchChrome()
    else syncClearButton()
  }

  const onGesturePointerUp = e => {
    if (!searchGestureActive) return
    endSearchGesture()
  }

  // Capture on the field so padding taps still focus, and stop the event from
  // bubbling into page/lineup handlers that can steal pen gestures.
  $searchbox.find('.search-field').on('pointerdown', function (e) {
    if ($(e.target).closest('.search-clear').length) return
    searchGestureActive = true
    e.stopPropagation()
    if (e.target !== $search[0]) {
      // Padding / glyph area — focus the input in the same user gesture.
      e.preventDefault()
      $search[0].focus()
    }
  })
  $search.on('touchstart', function (e) {
    searchGestureActive = true
    e.stopPropagation()
  })
  document.addEventListener('pointerup', onGesturePointerUp, true)
  document.addEventListener('pointercancel', onGesturePointerUp, true)
  document.addEventListener('touchend', onGesturePointerUp, true)
  document.addEventListener('touchcancel', onGesturePointerUp, true)

  $clear.on('pointerdown', function (e) {
    // Close before blur/focus races restore the mobile search chrome.
    e.preventDefault()
    e.stopPropagation()
    clearAndCloseSearch()
  })
  $clear.on('click', function (e) {
    e.preventDefault()
    e.stopPropagation()
  })

  $search.on('keydown', function (e) {
    if (e.keyCode === 27) {
      closeSearchUi()
      $(this).blur()
      syncClearButton()
    }
  })
  $search.on('keypress', function (e) {
    if (e.keyCode !== 13) {
      return
    } // 13 == return
    const searchQuery = $(this).val()
    search.performSearch(searchQuery)
    $(this).val('')
    syncClearButton()
  })

  $search.on('focus', function () {
    search?.clearRestoringSearchFocus?.()
    const mobile = window.matchMedia('(max-width: 490px)').matches
    if (mobile) {
      // Wait for the opening pointer to finish before footer layout, when we have
      // one; keyboard/tab focus applies chrome on the next frame instead.
      if (searchGestureActive) {
        mobileChromePending = true
      } else {
        mobileChromePending = true
        requestAnimationFrame(() => {
          if (mobileChromePending) applyMobileSearchChrome()
        })
      }
      return
    }
    const searchQuery = $(this).val()
    search.incrementalSearch(searchQuery)
    syncClearButton()
  })

  $search.on('focusout', function (e) {
    // Prefer relatedTarget over a blur timeout — if focus moved into results /
    // the field, stay open. Mobile leaves chrome up until an explicit dismiss.
    const next = e.relatedTarget
    if (next && $(next).closest('.incremental-search, .searchbox').length) return
    if (searchGestureActive) return
    if (search?.isRestoringSearchFocus?.()) return

    const mobile = window.matchMedia('(max-width: 490px)').matches
    if (mobile && document.body.classList.contains('wiki-mobile-searching')) {
      // Only these footer controls count as "done searching" — tap elsewhere on
      // the page / lineup keeps chrome up so the IME isn't dismissed by accident.
      const intentionalLeave =
        next && $(next).closest('.wiki-edit-toggle, #security, .footer-menu').length
      if (intentionalLeave) {
        closeSearchUi()
        syncClearButton()
      }
      return
    }

    // Desktop: relatedTarget null is common when focus drops to body — click-away
    // / escape handle dismiss. Only close here when we know focus went elsewhere.
    if (next) {
      closeSearchUi()
      syncClearButton()
    }
  })

  // Tab cycles result links, but won't tab outside the search box or results overlay while its open
  $(document).on('keydown', function (e) {
    if (!$('.incremental-search').length && !document.body.classList.contains('wiki-mobile-searching')) return
    if (e.keyCode === 27) {
      closeSearchUi()
      $search.blur()
      syncClearButton()
      return
    } // 27 == escape
    if (e.keyCode !== 9) return // 9 == tab
    if (!$('.incremental-search').length) return
    const resultLinks = [$('input.search')[0], ...$('.incremental-search a[href]').get()]
    const i = resultLinks.indexOf(document.activeElement)
    if (i < 0) return
    e.preventDefault()
    resultLinks[(i + (e.shiftKey ? -1 : 1) + resultLinks.length) % resultLinks.length].focus()
  })

  // Click-away closes results. Use click (not mousedown) so we don't race the
  // focus gesture that opens the mobile keyboard.
  $(document).on('click', function (e) {
    if (searchGestureActive) return
    if (search?.isRestoringSearchFocus?.()) return
    if ($(e.target).closest('.searchbox, .incremental-search, footer').length) return
    if ($search.is(':focus')) return
    if (
      window.matchMedia('(max-width: 490px)').matches &&
      document.body.classList.contains('wiki-mobile-searching') &&
      document.activeElement === $search[0]
    ) {
      // Keep results while the field still has focus (IME open / typing). Dismiss
      // via clear, escape, or intentional footer leave — not a tap on the page.
      return
    }
    closeSearchUi()
  })

  syncClearButton()

  return $search.on('input', function () {
    const searchQuery = $(this).val()
    search.incrementalSearch(searchQuery)
    syncClearButton()
  })
}

module.exports = { inject, bind }
