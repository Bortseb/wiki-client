// Handle input events from the search box. There is machinery
// here that supports incremental search.
// We use dependency injection to break dependency loops.

const createSearch = require('./search')

let search = null

const inject = neighborhood => (search = createSearch({ neighborhood }))

const bind = function () {
  $('input.search').attr('autocomplete', 'off')
  $('input.search').on('keydown', function (e) {
    if (e.keyCode === 27) {
      $('.incremental-search').remove()
    }
  })
  $('input.search').on('keypress', function (e) {
    if (e.keyCode !== 13) {
      return
    } // 13 == return
    const searchQuery = $(this).val()
    search.performSearch(searchQuery)
    $(this).val('')
  })

  $('input.search').on('focus click', function () {
    const searchQuery = $(this).val()
    search.incrementalSearch(searchQuery)
  })

  // Tab cycles result links, but won't tab outside the search box or results overlay while its open
  $(document).on('keydown', function (e) {
    if (!$('.incremental-search').length) return
    if (e.keyCode === 27) {
      return $('.incremental-search').remove()
    } // 27 == escape
    if (e.keyCode !== 9) return // 9 == tab
    const resultLinks = [$('input.search')[0], ...$('.incremental-search a[href]').get()]
    const i = resultLinks.indexOf(document.activeElement)
    if (i < 0) return
    e.preventDefault()
    resultLinks[(i + (e.shiftKey ? -1 : 1) + resultLinks.length) % resultLinks.length].focus()
  })

  // click-away closes results overlay
  $(document).on('mousedown', function (e) {
    if (!$(e.target).closest('.searchbox').length) $('.incremental-search').remove()
  })

  return $('input.search').on('input', function () {
    const searchQuery = $(this).val()
    search.incrementalSearch(searchQuery)
  })
}

module.exports = { inject, bind }
