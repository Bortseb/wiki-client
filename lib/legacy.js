// The legacy module is what is left of the single javascript
// file that once was Smallest Federated Wiki. Execution still
// starts here and many event dispatchers are set up before
// the user takes control.


const sortable = require('./sortable')
const {
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
} = sortable
Object.assign(module.exports, {
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
})

const pageHandler = require('./pageHandler')
const state = require('./state')
const active = require('./active')
const refresh = require('./refresh')
const lineup = require('./lineup')
const drop = require('./drop')
const dialog = require('./dialog')
const link = require('./link')
const target = require('./target')
const license = require('./license')
const plugin = require('./plugin')
const util = require('./util')
const editor = require('./editor')

const { asSlug } = require('./page')
const { newPage } = require('./page')

const preLoadEditors = catalog =>
  catalog
    .filter(entry => entry.editor)
    .forEach(function (entry) {
      console.log(`${entry.name} Plugin declares an editor, so pre-loading the plugin`)
      wiki.getPlugin(entry.name.toLowerCase(), function (plugin) {
        if (!plugin.editor || typeof plugin.editor !== 'function') {
          console.log(`${entry.name} Plugin ERROR.
Cannot find \`editor\` function in plugin. Set \`"editor": false\` in factory.json or
Correct the plugin to include all three of \`{emit, bind, editor}\`\
`)
        }
      })
    })

wiki.origin.get('system/factories.json', function (error, data) {
  if (Array.isArray(data)) {
    window.catalog = data
    preLoadEditors(data)
  }
})

// --- Mobile lineup paging chevrons (was lib/lineupNav.js) ---
// Tap = adjacent page, instant snap. Long-press = first/last.

const HOLD_MS = 450
const MOVE_PX = 16
const NAV_MS = 500
const GUARD_MS = 500
const HOLDING = 'wiki-lineup-nav-holding'
const CLICK_THROUGH_EVENTS = ['click', 'mousedown', 'mouseup', 'auxclick']

const CHEVRON_LEFT =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="22" aria-hidden="true">' +
  '<path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" d="M14.5 5 8 12l6.5 7"/>' +
  '</svg>'
const CHEVRON_RIGHT =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="22" aria-hidden="true">' +
  '<path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" d="M9.5 5 16 12l-6.5 7"/>' +
  '</svg>'

const navMainEl = () => document.querySelector('.main')

const navPageEls = () => {
  const main = navMainEl()
  return main ? [...main.querySelectorAll(':scope > .page')] : []
}

const navUiBusy = () => {
  const body = document.body
  return (
    body.classList.contains('wiki-mobile-searching') ||
    body.classList.contains('wiki-mobile-editing') ||
    body.classList.contains('wiki-page-lineup-shrunk') ||
    body.classList.contains('wiki-item-lineup-dragging') ||
    body.classList.contains('wiki-journal-merging') ||
    !!body.querySelector('.item.textEditing, .item.imageEditing')
  )
}

const navMaxScrollLeft = main => Math.max(0, main.scrollWidth - main.clientWidth)

const navVisibleIndex = () => {
  const main = navMainEl()
  const pages = navPageEls()
  if (!main || !pages.length) return 0
  const x = main.scrollLeft
  const max = navMaxScrollLeft(main)
  // Ends: 100vw columns vs clientWidth often disagree by a pixel, so the last
  // page never quite centers. Treat flush-right as the last page.
  if (x <= 2) return 0
  if (max > 0 && x >= max - 2) return pages.length - 1
  let best = 0
  let bestDist = Infinity
  pages.forEach((page, i) => {
    const dist = Math.abs(page.offsetLeft - x)
    if (dist < bestDist) {
      bestDist = dist
      best = i
    }
  })
  return best
}

let leftBtn = null
let rightBtn = null
let navIndex = null
let navAt = 0
let heldBtn = null
let selectGuardUntil = 0
let selectGuardGen = 0
let clickShieldEl = null
let clickGuardAttached = false

const clearSelection = () => {
  const sel = window.getSelection?.()
  if (sel && sel.rangeCount) sel.removeAllRanges()
}

const dropClickShield = () => {
  clickShieldEl?.remove()
  clickShieldEl = null
}

const placeClickShield = (btn, opts = {}) => {
  dropClickShield()
  if (!btn) return
  const r = btn.getBoundingClientRect()
  const pad = 20
  const el = document.createElement('div')
  el.className = 'wiki-lineup-nav-click-shield'
  el.setAttribute('aria-hidden', 'true')
  Object.assign(el.style, {
    left: `${Math.floor(r.left - pad)}px`,
    top: `${Math.floor(r.top - pad)}px`,
    width: `${Math.ceil(r.width + pad * 2)}px`,
    height: `${Math.ceil(r.height + pad * 2)}px`,
  })
  // Jump-to-end hides the chevron immediately; sit above the page scroller
  // (and the vanished button) so the ghost click cannot retarget onto a story item.
  if (opts.above) el.style.zIndex = '1006'
  document.body.appendChild(el)
  clickShieldEl = el
}

const swallowClickThrough = e => {
  if (!heldBtn && performance.now() > selectGuardUntil) return
  e.preventDefault()
  e.stopPropagation()
  e.stopImmediatePropagation()
}

const attachClickGuard = () => {
  if (clickGuardAttached) return
  clickGuardAttached = true
  for (const type of CLICK_THROUGH_EVENTS) {
    document.addEventListener(type, swallowClickThrough, true)
  }
  document.addEventListener('selectstart', swallowClickThrough, true)
  document.addEventListener('contextmenu', swallowClickThrough, true)
}

const detachClickGuard = () => {
  if (!clickGuardAttached) return
  clickGuardAttached = false
  for (const type of CLICK_THROUGH_EVENTS) {
    document.removeEventListener(type, swallowClickThrough, true)
  }
  document.removeEventListener('selectstart', swallowClickThrough, true)
  document.removeEventListener('contextmenu', swallowClickThrough, true)
}

const armSelectGuard = () => {
  selectGuardGen += 1
  selectGuardUntil = 0
  dropClickShield()
  document.body.classList.add(HOLDING)
  clearSelection()
  attachClickGuard()
}

const disarmSelectGuard = (btn, opts = {}) => {
  const gen = selectGuardGen
  clearSelection()
  // Shield eats the ghost click. Hide the chevron immediately — keeping it
  // painted for GUARD_MS was the visible linger after a jump-to-end.
  selectGuardUntil = performance.now() + GUARD_MS
  placeClickShield(btn, { above: !!opts.jumped })
  attachClickGuard()
  if (heldBtn === btn) {
    heldBtn = null
    btn.classList.remove('is-jump-hidden', 'is-held')
    syncLineupNav()
  }
  setTimeout(() => {
    if (gen !== selectGuardGen) return
    detachClickGuard()
    dropClickShield()
    document.body.classList.remove(HOLDING)
    clearSelection()
  }, GUARD_MS)
}

const shouldSuppressItemClick = () => !!heldBtn || performance.now() < selectGuardUntil

const navBaseIndex = () => {
  if (navIndex != null && performance.now() - navAt < NAV_MS) return navIndex
  return navVisibleIndex()
}

const navTargetLeft = (main, pages, i) => {
  const max = navMaxScrollLeft(main)
  if (i <= 0) return 0
  if (i >= pages.length - 1) return max
  return Math.max(0, Math.min(max, pages[i].offsetLeft))
}

const goTo = index => {
  const pages = navPageEls()
  const main = navMainEl()
  if (!main || !pages.length) return
  const i = Math.max(0, Math.min(pages.length - 1, index))
  const page = pages[i]
  const left = navTargetLeft(main, pages, i)
  navIndex = i
  navAt = performance.now()
  active.set($(page), true)

  // Instant snap — no smooth scroll. Disable snap/behavior so the assignment
  // cannot animate or get yanked to a neighbor column.
  const prevSnap = main.style.scrollSnapType
  const prevBehavior = main.style.scrollBehavior
  main.style.scrollSnapType = 'none'
  main.style.scrollBehavior = 'auto'
  main.scrollLeft = left
  main.style.scrollSnapType = prevSnap
  main.style.scrollBehavior = prevBehavior
  syncLineupNav()
}

const step = dir => goTo(navBaseIndex() + dir)
const jump = dir => goTo(dir < 0 ? 0 : navPageEls().length - 1)

// Same 490px breakpoint as footer / sortable mobile checks (local — not shared).
const isMobile = () => window.matchMedia('(max-width: 490px)').matches

const NAV_H = 44
const NAV_GAP = 8

// Pin just above the live footer box. Using top from getBoundingClientRect
// (not bottom/--footer-height) keeps the control flush to the bar when mobile
// browser chrome makes layout-viewport bottom disagree with the fixed footer.
const pinLineupNav = () => {
  if (!leftBtn || !rightBtn) return
  const footer = document.querySelector('footer')
  if (!footer) return
  const top = Math.round(footer.getBoundingClientRect().top - NAV_GAP - NAV_H)
  leftBtn.style.top = rightBtn.style.top = top + 'px'
  leftBtn.style.bottom = rightBtn.style.bottom = 'auto'
}

const syncLineupNav = () => {
  if (!leftBtn || !rightBtn) return
  const pages = navPageEls()
  const show = isMobile() && !navUiBusy() && pages.length > 1
  // Hide from where the scroller actually is — not the intended navIndex.
  // Using navIndex hid the right chevron before the last page was on screen,
  // and a failed snap-back left it gone.
  const index = show ? navVisibleIndex() : 0
  // Keep the pressed chevron in the DOM through the hold (opacity:0 after a
  // jump) so pointer capture is not dropped onto the story. Unmount on lift.
  leftBtn.hidden = (!show || index <= 0) && heldBtn !== leftBtn
  rightBtn.hidden = (!show || index >= pages.length - 1) && heldBtn !== rightBtn
  if (show) pinLineupNav()
}

const bindPress = (btn, dir) => {
  let press = null

  const clear = (opts = {}) => {
    const releaseHold = opts.releaseHold !== false
    const jumped = !!press?.jumped
    if (press) {
      if (press.timer) clearTimeout(press.timer)
      btn.classList.remove('is-held')
      try {
        if (press.captured) btn.releasePointerCapture(press.id)
      } catch {
        /* already released */
      }
      press = null
    }
    if (releaseHold && heldBtn === btn) {
      disarmSelectGuard(btn, { jumped })
    }
  }

  btn.addEventListener('pointerdown', e => {
    if (e.button != null && e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
    clear({ releaseHold: false })
    heldBtn = btn
    armSelectGuard()
    btn.classList.remove('is-jump-hidden')
    btn.classList.add('is-held')
    press = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      jumped: false,
      captured: false,
      timer: setTimeout(() => {
        if (!press || press.id !== e.pointerId) return
        press.jumped = true
        // Vanish immediately without display:none — that drops capture onto the story.
        btn.classList.add('is-jump-hidden')
        btn.classList.remove('is-held')
        jump(dir)
        clearSelection()
      }, HOLD_MS),
    }
    try {
      btn.setPointerCapture(e.pointerId)
      press.captured = true
    } catch {
      /* capture optional */
    }
  })

  btn.addEventListener('pointermove', e => {
    if (!press || e.pointerId !== press.id) return
    if (Math.abs(e.clientX - press.x0) > MOVE_PX || Math.abs(e.clientY - press.y0) > MOVE_PX) {
      clear()
    }
  })

  const onEnd = e => {
    if (!press || (e && e.pointerId !== press.id)) return
    e.preventDefault?.()
    e.stopPropagation?.()
    e.stopImmediatePropagation?.()
    const jumped = press.jumped
    clear()
    if (!jumped) step(dir)
  }

  btn.addEventListener('pointerup', onEnd)
  btn.addEventListener('pointercancel', e => {
    e.preventDefault?.()
    e.stopPropagation?.()
    clear()
  })
  btn.addEventListener('click', e => {
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
  })
  btn.addEventListener('contextmenu', e => {
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
  })
}

const makeNavButton = (side, dir, label, svg) => {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = `wiki-lineup-nav wiki-lineup-nav-${side}`
  btn.setAttribute('aria-label', label)
  btn.hidden = true
  btn.innerHTML = svg
  bindPress(btn, dir)
  document.body.appendChild(btn)
  return btn
}

const bindLineupNav = () => {
  if (leftBtn && rightBtn) return
  leftBtn = makeNavButton('left', -1, 'Previous page. Long-press for first page.', CHEVRON_LEFT)
  rightBtn = makeNavButton('right', 1, 'Next page. Long-press for last page.', CHEVRON_RIGHT)

  const main = navMainEl()
  main?.addEventListener('scroll', syncLineupNav, { passive: true })
  window.matchMedia('(max-width: 490px)').addEventListener('change', syncLineupNav)
  window.addEventListener('resize', pinLineupNav, { passive: true })
  document.addEventListener('wiki:footer-layout', pinLineupNav)
  const vv = window.visualViewport
  if (vv) {
    vv.addEventListener('resize', pinLineupNav, { passive: true })
    vv.addEventListener('scroll', pinLineupNav, { passive: true })
  }
  if (main) {
    new MutationObserver(syncLineupNav).observe(main, { childList: true })
  }
  new MutationObserver(syncLineupNav).observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  })
  syncLineupNav()
}

$(function () {
  // FUNCTIONS used by plugins and elsewhere

  const LEFTARROW = 37
  const RIGHTARROW = 39

  $(document).on('keydown', function (event) {
    const direction = event.which == LEFTARROW ? -1 : event.which == RIGHTARROW ? 1 : null
    if (direction && !$(event.target).is(':input')) {
      const pages = $('.page')
      const newIndex = pages.index($('.active')) + direction
      if (0 <= newIndex && newIndex < pages.length) {
        active.set(pages.eq(newIndex))
      }
    }
    if ((event.ctrlKey || event.metaKey) && event.which === 83) {
      //ctrl-s for search
      event.preventDefault()
      $('input.search').trigger('focus')
    }
  })

  // HANDLERS for jQuery events

  //STATE -- reconfigure state based on url
  $(window).on('popstate', state.show)

  $(document).ajaxError(function (event, request, settings) {
    if (request.status === 0 || request.status === 404) {
      return
    }
    console.log('ajax error', event, request, settings)
  })

  const commas = number => `${number}`.replace(/(\d)(?=(\d\d\d)+(?!\d))/g, '$1,')

  const readFile = function (file) {
    if (file?.type === 'application/json') {
      const reader = new FileReader()
      reader.onload = function (e) {
        const { result } = e.target
        let pages = JSON.parse(result)
        const resultPage = newPage()
        resultPage.setTitle(`Import from ${file.name}`)
        if (pages.title && pages.story && pages.journal) {
          const slug = asSlug(pages.title)
          const page = pages
          pages = {}
          pages[slug] = page
          resultPage.addParagraph(`\
Import of one page
(${commas(file.size)} bytes)
from a page-json file dated ${file.lastModifiedDate}.\
`)
        } else {
          resultPage.addParagraph(`\
Import of ${Object.keys(pages).length} pages
(${commas(file.size)} bytes)
from an export file dated ${file.lastModifiedDate}.\
`)
        }
        resultPage.addItem({ type: 'importer', pages })
        link.showResult(resultPage)
      }
      reader.readAsText(file)
    }
  }

  const deletePage = (
    pageObject,
    $page, // console.log 'fork to delete'
  ) =>
    pageHandler.delete(pageObject, $page, function (err) {
      if (err) {
        return
      }
      // console.log 'server delete successful'
      if (pageObject.isRecycler()) {
        // make recycler page into a ghost
        $page.addClass('ghost')
      } else {
        const futurePage = refresh.newFuturePage(pageObject.getTitle(), pageObject.getCreate())
        pageObject.become(futurePage)
        $page.attr('id', futurePage.getSlug())
        refresh.rebuildPage(pageObject, $page)
        $page.addClass('ghost')
      }
    })

  const getTemplate = function (slug, done) {
    if (!slug) {
      return done(null)
    }
    console.log('getTemplate', slug)
    pageHandler.get({
      whenGotten(pageObject) {
        done(pageObject)
      },
      whenNotGotten() {
        done(null)
      },
      pageInformation: { slug },
    })
  }

  const finishClick = function (e, name) {
    let page
    e.preventDefault()
    if (!e.shiftKey) {
      page = $(e.target).parents('.page')
    }
    link.doInternalLink(name, page, $(e.target).data('site'))
    return false
  }

  initPageSortable(document.querySelector('.main'))
  $('.main')
    .on('click', '.show-page-license', function (e) {
      e.preventDefault()
      const $page = $(this).parents('.page')
      const title = $page.find('h1').text().trim()
      dialog.open(`License for ${title}`, license.info($page))
    })
    .on('click', '.show-page-source', function (e) {
      e.preventDefault()
      const $page = $(this).parents('.page')
      const page = lineup.atKey($page.data('key')).getRawPage()
      dialog.open(`JSON for ${page.title}`, $('<pre/>').text(JSON.stringify(page, null, 2)))
    })
    .on('click', '.page', function (e) {
      if (!$(e.target).is('a')) {
        // Click-away from a focused editor still has wiki-mobile-editing on
        // the body (cleared next frame). Don't scroll — that + snap jumped
        // to the last lineup page.
        const noScroll = document.body.classList.contains('wiki-mobile-editing')
        return active.set(this, noScroll)
      }
    })
    .on('click', '.internal', function (e) {
      if (editor.hasOpenEditor()) {
        e.preventDefault()
        e.stopImmediatePropagation()
        const leave = window.confirm(
          'You have unsaved edits in an open block. Discard and navigate away?',
        )
        if (!leave) return false
        editor.discardOpenEditor()
      }
      const $link = $(e.target).closest('a.internal')
      let title = $link.text() || $link.data('pageName')
      // ensure that name is a string (using string interpolation)
      title = `${title}`
      pageHandler.context = $link.attr('title') ? $link.attr('title').split(' => ') : ['view']
      return finishClick(e, title)
    })
    .on('click', 'img.remote', function (e) {
      // expand to handle click on temporary flag
      if ($(e.target).attr('src').startsWith('data:image/png')) {
        e.preventDefault()
        const site = $(e.target).data('site')
        wiki.site(site).refresh(function () {})
        // empty function...
      } else {
        const name = $(e.target).data('slug')
        pageHandler.context = [$(e.target).data('site')]
        return finishClick(e, name)
      }
    })
    .on('dblclick', '.revision', function (e) {
      e.preventDefault()
      const $page = $(this).parents('.page')
      const page = lineup.atKey($page.data('key')).getRawPage()
      const rev = page.journal.length - 1
      const action = page.journal[rev]
      const json = JSON.stringify(action, null, 2)
      dialog.open(`Revision ${rev}, ${action.type} action`, $('<pre/>').text(json))
    })
    .on('click', '.action', function (e) {
      e.preventDefault()
      const $action = $(e.target)
      let name = $action.data('slug')
      if ($action.is('.fork') && name) {
        pageHandler.context = [$action.data('site')]
        return finishClick(e, name.split('_')[0])
      } else {
        const $page = $(this).parents('.page')
        const key = $page.data('key')
        const slug = lineup.atKey(key).getSlug()
        const rev = $(this).parent().children().not('.separator').index($action)
        if (rev < 0) {
          return
        }
        if (!e.shiftKey) {
          $page.nextAll().remove()
        }
        if (!e.shiftKey) {
          lineup.removeAllAfterKey(key)
        }
        link
          .createPage(`${slug}_rev${rev}`, $page.data('site'))
          .appendTo($('.main'))
          .each((_i, e) => refresh.cycle($(e)))
        active.set($('.page').last())
      }
    })
    // pointerenter: keep journal tip text fresh for stylus hover (flagTip).
    .on('mouseenter pointerenter', '.action', function (e) {
      const $action = $(e.currentTarget)
      const { action } = $action.data()
      if (!action) return
      $action.attr('title', util.formatActionTitle(action))
    })
    .on('click', '.fork-page', function (e) {
      e.preventDefault()
      e.stopImmediatePropagation()
      const $page = $(this).closest('.page')
      if (!$page.length || $page.find('.future').length) {
        return false
      }
      const pageObject = lineup.atKey($page.data('key'))
      if (!pageObject) {
        console.error('fork-page: missing pageObject for', $page.data('key'))
        return false
      }
      if ($page.attr('id').match(/_rev0$/)) {
        deletePage(pageObject, $page)
      } else {
        const action = { type: 'fork' }
        // Local + localStorage mode: plain fork is a no-op, but revision/ghost
        // fork means "restore this prior state" and must still run (put → local).
        const isRevision =
          $page.data('rev') != null || /_rev\d+/.test($page.attr('id') || '')
        if ($page.hasClass('local')) {
          if (pageHandler.useLocalStorage() && !isRevision && !$page.hasClass('ghost')) {
            return false
          }
          $page.removeClass('local')
        } else if (pageObject.isRecycler()) {
          $page.removeClass('recycler')
        } else if (pageObject.isRemote()) {
          action.site = pageObject.getRemoteSite()
        }
        if ($page.data('rev') != null) {
          $page.find('.revision').remove()
          $page.removeData('rev')
        }
        if ($page.hasClass('ghost')) {
          const newtitle = $page.find('h1').text().trim().replaceAll(/\s+/g,' ')
          if(newtitle != pageObject.getTitle()) {
            $page.attr('id',asSlug(newtitle))
            pageObject.setCreateTitle(newtitle)
            $page.find('h1 .title').removeAttr('contenteditable')
          }
        }
        $page.removeClass('ghost')
        $page.attr('id', $page.attr('id').replace(/_rev\d+$/, ''))
        state.setUrl()
        const iterable = $('.page')
        for (let i = 0; i < iterable.length; i++) {
          var p = iterable[i]
          var needle = $(p).data('site')
          if (
            $(p).data('key') !== $page.data('key') &&
            $(p).attr('id') === $page.attr('id') &&
            [undefined, null, 'view', 'origin', 'local', 'recycler', location.host].includes(needle)
          ) {
            $(p).addClass('ghost')
          }
        }
        sortable.syncStoryOrderFromDom($page)
        pageHandler.put($page, action)
      }
      return false
    })
    .on('click', 'button.create', e =>
      getTemplate($(e.target).data('slug'), function (template) {
        const $page = $(e.target).parents('.page:first')
        $page.removeClass('ghost')
        const pageObject = lineup.atKey($page.data('key'))
        pageObject.become(template)
        const page = pageObject.getRawPage()
        refresh.rebuildPage(pageObject, $page.empty())
        pageHandler.put($page, { type: 'create', id: page.id, item: { title: page.title, story: page.story } })
      }),
    )

    .on('mouseenter mouseleave', '.score', function (e) {
      console.log('in .score...')
      $('.main').trigger('thumb', $(e.target).data('thumb'))
    })
    .on('click', 'a.search', function (e) {
      e.preventDefault()
      const $page = $(e.target).parents('.page')
      const key = $page.data('key')
      const pageObject = lineup.atKey(key)
      const resultPage = newPage()
      resultPage.setTitle(`Search from '${pageObject.getTitle()}'`)
      resultPage.addParagraph(
        `Search for pages related to '${pageObject.getTitle()}'.
Each search on this page will find pages related in a different way.
Choose the search of interest. Be patient.`,
      )
      resultPage.addParagraph('Find pages with links to this title.')
      resultPage.addItem({
        type: 'search',
        text: `SEARCH LINKS ${pageObject.getSlug()}`,
      })
      resultPage.addParagraph('Find pages with titles similar to this title.')
      resultPage.addItem({
        type: 'search',
        text: `SEARCH SLUGS ${pageObject.getSlug()}`,
      })
      resultPage.addParagraph('Find pages neighboring  this site.')
      resultPage.addItem({
        type: 'search',
        text: `SEARCH SITES ${pageObject.getRemoteSite(location.host)}`,
      })
      resultPage.addParagraph('Find pages sharing any of these items.')
      resultPage.addItem({
        type: 'search',
        text: `SEARCH ANY ITEMS ${pageObject
          .getRawPage()
          .story.map(item => item.id)
          .join(' ')}`,
      })
      if (!e.shiftKey) {
        $page.nextAll().remove()
      }
      if (!e.shiftKey) {
        lineup.removeAllAfterKey(key)
      }
      link.showResult(resultPage)
    })
    .on('dragenter', evt => evt.preventDefault())
    .on('dragover', evt => evt.preventDefault())
    .on(
      'drop',
      drop.dispatch({
        page: item => {
          link.doInternalLink(item.slug, null, item.site)
        },
        file: file => {
          readFile(file)
        },
      }),
    )

  $('.provider input').on('click', function () {
    $('footer input:first').val($(this).attr('data-provider'))
    $('footer form').submit()
  })

  $('body').on('new-neighbor-done', () => $('.page').each((index, element) => refresh.emitTwins($(element))))
  // refresh backlinks??

  const getPluginReference = title =>
    new Promise(function (resolve) {
      const slug = asSlug(title)
      wiki.origin.get(`${slug}.json`, (error, data) =>
        resolve({
          title,
          slug,
          type: 'reference',
          text: (error ? error.msg : data?.story[0].text) || '',
        }),
      )
    })

  $('<span class="footer-menu" aria-label="Menu">☰</span>')
    .css({ cursor: 'pointer' })
    .appendTo('footer')
    .on('click', function () {
      const resultPage = newPage()
      resultPage.setTitle('Selected Plugin Pages')
      resultPage.addParagraph(`\
Installed plugins offer these utility pages:\
`)
      if (!window.catalog) {
        return
      }

      const titles = []
      for (var info of window.catalog) {
        if (info.pages) {
          for (var title of info.pages) {
            titles.push(title)
          }
        }
      }

      Promise.all(titles.map(getPluginReference)).then(function (items) {
        items.forEach(item => resultPage.addItem(item))
        link.showResult(resultPage)
      })
    })

  const setEditState = function (editState) {
    $('.editEnable').toggle(!!editState)
    $('.wiki-edit-toggle').toggleClass('is-on', !!editState)
    document.body.classList.toggle('fedwiki-edit-mode', !!editState)
    editor.hide({ clearSelection: true })
    localStorage.setItem('wikiEditEnabled', !!editState)
    const main = document.querySelector('.main')
    const mainScrollLeft = main?.scrollLeft ?? 0
    // Rebuild emits the journal while story items are still empty, so the
    // page cannot keep its old scroll position. Pin to the top — not the
    // journal — after the story has rendered.
    const pinTop = (el) => {
      if (el) el.scrollTop = 0
    }
    const pinMain = () => {
      if (!main) return
      main.scrollTop = 0
      main.scrollLeft = mainScrollLeft
    }
    const restores = []
    $('.page').each(function () {
      const el = this
      const promise = refresh.rebuildPage(lineup.atKey($(el).data('key')), $(el).empty())
      pinTop(el)
      restores.push(Promise.resolve(promise).then(() => pinTop(el)))
    })
    pinMain()
    Promise.all(restores).then(pinMain)
  }
  // Desktop: "wiki ✔︎". Mobile: pill + "edit". .editEnable stays mounted for :visible checks.
  $('<span class="wiki-edit-toggle" title="Toggle editing"><span class="wiki-edit-desktop-label">&nbsp;wiki&nbsp;</span><span class="editEnableSlot"><span class="editEnable">✔︎</span></span><span class="wiki-edit-mobile"><span class="edit-toggle-track"><span class="edit-toggle-knob"></span></span><span class="edit-toggle-label">edit</span></span></span>')
    .css({ cursor: 'pointer' })
    .appendTo('footer')
    .on('click', function () {
      setEditState(!document.body.classList.contains('fedwiki-edit-mode'))
    })

  // Prefer a saved wiki ✔︎ choice; otherwise default by login and viewport.
  const isMobileViewport = matchMedia('(max-width: 490px)').matches
  const storedEditState = localStorage.getItem('wikiEditEnabled')
  const defaultEditState = isAuthenticated && !isMobileViewport
  let initialEditState = storedEditState != null ? storedEditState === 'true' : defaultEditState
  // One-shot: older auth-sync forced edit on at login and persisted it, including on mobile.
  if (localStorage.getItem('wikiEditMobileDefaultFixed') == null) {
    localStorage.setItem('wikiEditMobileDefaultFixed', '1')
    if (isMobileViewport && initialEditState) {
      initialEditState = false
      localStorage.setItem('wikiEditEnabled', 'false')
    }
  }
  $('.editEnable').toggle(initialEditState)
  $('.wiki-edit-toggle').toggleClass('is-on', initialEditState)
  document.body.classList.toggle('fedwiki-edit-mode', initialEditState)

  // Group search + wiki toggle for mobile footer flex layout.
  ;(function groupFooterControls() {
    const footer = document.querySelector('footer')
    if (!footer || footer.querySelector('.footer-controls')) return
    const hood = footer.querySelector('.neighborhood')
    const box = document.createElement('span')
    box.className = 'footer-controls'
    for (const child of [...footer.children]) {
      if (child === hood) continue
      if (child.id === 'site-owner' || child.id === 'security') continue
      if (child.classList?.contains('footer-menu')) continue
      box.appendChild(child)
    }
    if (hood) footer.insertBefore(box, hood)
    else footer.appendChild(box)
    const menu = footer.querySelector('.footer-menu')
    const wikiToggle = footer.querySelector('.wiki-edit-toggle')
    if (menu && wikiToggle && box.contains(wikiToggle)) box.insertBefore(menu, wikiToggle)
    else if (menu) box.appendChild(menu)
  })()


  // #security is rewritten on login/logout — sync wiki ✔︎ only when auth actually flips.
  // On login, keep the viewport default (mobile off, desktop on); logout always off.
  const securityEl = $('#security')[0]
  if (securityEl) {
    let lastAuthState = !!isAuthenticated
    new MutationObserver(function () {
      const authState = !!isAuthenticated
      if (authState === lastAuthState) return
      lastAuthState = authState
      // Login follows viewport default (mobile off); logout clears edit.
      setEditState(authState && !matchMedia('(max-width: 490px)').matches)
    }).observe(securityEl, { childList: true })
  }
  editor.bindItemChrome()
  refresh.bindLineupItemDrag()
  bindLineupNav()
  refresh.bindJournalMerge()

  target.bind()

  $(function () {
    state.first()
    const pages = $('.page').toArray()
    // Render pages in order
    // Emits and "bind creations" for the previous page must be complete before we start
    // rendering the next page or plugin bind ordering will not work
    var renderNextPage = function (pages) {
      if (pages.length === 0) {
        // Honor a page the user already made active while the lineup was loading.
        if (!active.chosen) {
          active.set($('.page').last())
        }
        return
      }
      const $page = $(pages.shift())
      refresh.cycle($page).then(() => renderNextPage(pages))
    }
    renderNextPage(pages)
  })
})
