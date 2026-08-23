// The neighborhood provides a cache of site maps read from
// various federated wiki sites. It is careful to fetch maps
// slowly and keeps track of get requests in flight.

let neighborhood
const miniSearch = require('minisearch')

module.exports = neighborhood = {}

neighborhood.sites = {}
let nextAvailableFetch = 0
const nextFetchInterval = 500
const maxVisibleFailRetries = 3

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

const transition = (site, from, to) =>
  $(`.neighbor[data-site="${site}"]`).find('div').removeClass(from).addClass(to)

const flagStatus = (site, status) =>
  $(`.neighbor[data-site="${site}"]`).find('div').removeClass('wait fetch done fail').addClass(status)

const isLiveNeighbor = (site, neighborInfo, generation) =>
  neighborhood.sites[site] === neighborInfo && neighborInfo.fetchGeneration === generation

const boundedDelay = function (ms) {
  const minDelay = 60000 // 1 minute
  const maxDelay = 43200000 // 12 hours
  if (ms > maxDelay) return maxDelay
  if (ms < minDelay) return minDelay
  return ms
}

const refreshIndex = (site, neighborInfo) =>
  // we use `wiki.site(site).getIndex` as we want the serialized index as a string.
  wiki.site(site).getIndex('system/site-index.json', function (err, data) {
    if (neighborhood.sites[site] !== neighborInfo) return
    if (!err) {
      try {
        neighborInfo.siteIndex = miniSearch.loadJSON(data, {
          fields: ['title', 'content'],
        })
        console.log(site, 'index loaded')
      } catch {
        console.log('error loading index - not a valid index', site)
      }
    } else {
      console.log('error loading index', site, err)
    }
  })

const refreshMap = function (site, neighborInfo) {
  // Guard for wiki removed / replaced (e.g. retryNeighbor while a request was in flight).
  if (neighborhood.sites[site] !== neighborInfo) {
    console.log(site, ' has been removed - ignore refresh')
    return
  }

  neighborInfo.sitemapRequestInflight = true
  const generation = ++neighborInfo.fetchGeneration

  return wiki.site(site).get('system/sitemap.json', function (err, gotData) {
    // Stale XHR after background/resume or after retry must not tilt the flag again.
    if (!isLiveNeighbor(site, neighborInfo, generation)) return

    neighborInfo.sitemapRequestInflight = false
    if (err) {
      // Origin has no refresh(); remotes reset their prefix for the next attempt.
      const adapter = wiki.site(site)
      if (typeof adapter.refresh === 'function') {
        adapter.refresh(function () {})
      }

      neighborInfo.needsRefreshWhenVisible = true

      // Mobile browsers often abort sitemap polls while backgrounded. Keep the last
      // good sitemap and retry when the tab is visible again — don't stick tilted.
      if (document.hidden) {
        console.warn(`Sitemap fetch interrupted for ${site}; will retry when visible`)
        flagStatus(site, neighborInfo.sitemap ? 'done' : 'fail')
        return
      }

      neighborInfo.failCount = (neighborInfo.failCount || 0) + 1
      flagStatus(site, 'fail')
      console.warn(`Unable to fetch sitemap for ${site}`)

      if (neighborInfo.failCount <= maxVisibleFailRetries) {
        const backoff = Math.min(10000, 1500 * neighborInfo.failCount)
        return delay(backoff).then(function () {
          if (!isLiveNeighbor(site, neighborInfo, generation)) return
          if (document.hidden) {
            neighborInfo.needsRefreshWhenVisible = true
            return
          }
          if (neighborhood.sites[site] !== neighborInfo) return
          flagStatus(site, 'fetch')
          return refreshMap(site, neighborInfo)
        })
      }
      return
    }

    neighborInfo.failCount = 0
    neighborInfo.needsRefreshWhenVisible = false

    let { data, lastModified } = gotData

    if (isNaN(lastModified)) {
      lastModified = 0
    }

    if (lastModified > neighborInfo.lastModified) {
      neighborInfo.sitemap = data
      neighborInfo.lastModified = lastModified
      $('body').trigger('new-neighbor-done', site)
      refreshIndex(site, neighborInfo)
    }

    const updateDelay = boundedDelay(Math.floor((Date.now() - lastModified) / 4))
    neighborInfo.nextCheck = Date.now() + updateDelay
    console.log('delay for ', site, updateDelay / 60000)
    transition(site, 'fetch', 'done')

    return delay(updateDelay).then(function () {
      if (!isLiveNeighbor(site, neighborInfo, generation)) return
      transition(site, 'done', 'fetch')
      return refreshMap(site, neighborInfo)
    })
  })
}

const populateSiteInfoFor = function (site, neighborInfo) {
  if (neighborInfo.sitemapRequestInflight) {
    return
  }
  neighborInfo.sitemapRequestInflight = true
  if (neighborInfo.fetchGeneration == null) neighborInfo.fetchGeneration = 0

  const fetchMap = function () {
    if (neighborhood.sites[site] !== neighborInfo) return
    transition(site, 'wait', 'fetch')
    neighborInfo.lastModified = 0
    return refreshMap(site, neighborInfo)
  }

  const now = Date.now()
  if (now > nextAvailableFetch) {
    nextAvailableFetch = now + nextFetchInterval
    setTimeout(fetchMap, 100)
  } else {
    setTimeout(fetchMap, nextAvailableFetch - now)
    nextAvailableFetch += nextFetchInterval
  }
}

neighborhood.retryNeighbor = function (site) {
  console.log('retrying neighbor')
  const prev = neighborhood.sites[site]
  // Cancel any in-flight / delayed work still holding the previous info object.
  if (prev) prev.fetchGeneration = (prev.fetchGeneration || 0) + 1

  const neighborInfo = {
    sitemap: prev?.sitemap,
    siteIndex: prev?.siteIndex,
    fetchGeneration: prev?.fetchGeneration || 0,
  }
  neighborhood.sites[site] = neighborInfo
  populateSiteInfoFor(site, neighborInfo)
}

const resumeFailedNeighbors = function () {
  if (document.hidden) return
  for (const site of Object.keys(neighborhood.sites)) {
    const info = neighborhood.sites[site]
    if (!info || info.sitemapRequestInflight) continue
    const failed = $(`.neighbor[data-site="${site}"]`).find('div').hasClass('fail')
    if (info.needsRefreshWhenVisible || failed) {
      neighborhood.retryNeighbor(site)
    }
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', resumeFailedNeighbors)
}
if (typeof window !== 'undefined') {
  window.addEventListener('pageshow', resumeFailedNeighbors)
}

neighborhood.registerNeighbor = function (site) {
  if (site.endsWith(':')) {
    site = site.slice(0, -1)
  }
  if (neighborhood.sites[site]) {
    return
  }
  const neighborInfo = {}
  neighborhood.sites[site] = neighborInfo
  populateSiteInfoFor(site, neighborInfo)
  $('body').trigger('new-neighbor', site)
}

neighborhood.updateSitemap = function (pageObject) {
  let neighborInfo
  const site = location.host
  if (!(neighborInfo = neighborhood.sites[site])) {
    return
  }
  if (neighborInfo.sitemapRequestInflight) {
    return
  }
  const slug = pageObject.getSlug()
  const date = pageObject.getDate()
  const title = pageObject.getTitle()
  const synopsis = pageObject.getSynopsis()
  const links = pageObject.getLinks()
  const entry = { slug, date, title, synopsis, links }
  const { sitemap } = neighborInfo
  const index = sitemap.findIndex(slot => slot.slug === slug)
  if (index >= 0) {
    sitemap[index] = entry
  } else {
    sitemap.push(entry)
  }
  $('body').trigger('new-neighbor-done', site)
}

neighborhood.deleteFromSitemap = function (pageObject) {
  let neighborInfo
  const site = location.host
  if (!(neighborInfo = neighborhood.sites[site])) {
    return
  }
  if (neighborInfo.sitemapRequestInflight) {
    return
  }
  const slug = pageObject.getSlug()
  const { sitemap } = neighborInfo
  const index = sitemap.findIndex(slot => slot.slug === slug)
  if (!(index >= 0)) {
    return
  }
  sitemap.splice(index)
  $('body').trigger('delete-neighbor-done', site)
}

neighborhood.listNeighbors = () => Object.keys(neighborhood.sites)

// Page Search

const extractItemText = text =>
  text
    .replace(/\[([^\]]*?)\][[(].*?[\])]/g, ' $1 ')
    .replace(/\[{2}|\[(?:[\S]+)|\]{1,2}/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/<style.*?<\/style>/g, ' ')
    .replace(/<(?:"[^"]*"['"]*|'[^']*'['"]*|[^'">])+>/g, ' ')
    .replace(/<(?:[^>])+>/g, ' ')
    .replace(/(https?:.*?)(?=\p{White_Space}|\p{Quotation_Mark}|$)/gu, function (match) {
      const myUrl = new URL(match)
      return myUrl.hostname + myUrl.pathname
    })
    .replace(/[\p{P}\p{Emoji}\p{Symbol}}]+/gu, ' ')
    .replace(/[\p{White_Space}\n\t]+/gu, ' ')

const extractPageText = function (pageText, currentItem, currentIndex) {
  try {
    if (currentItem.text) {
      switch (currentItem.type) {
        case 'paragraph':
        case 'markdown':
        case 'html':
        case 'reference':
        case 'image':
        case 'pagefold':
        case 'math':
        case 'mathjax':
        case 'code':
          pageText += extractItemText(currentItem.text)
          break
        case 'audio':
        case 'video':
        case 'frame':
          pageText += extractItemText(
            currentItem.text
              .split(/\r\n?|\n/)
              .map(function (line) {
                const firstWord = line.split(/\p{White_Space}/u)[0]
                if (
                  firstWord.startsWith('http') ||
                  firstWord.toUpperCase() === firstWord ||
                  firstWord.startsWith('//')
                ) {
                  // line is markup
                  return ''
                } else {
                  return line
                }
              })
              .join(' '),
          )
          break
      }
    }
  } catch (err) {
    throw new Error(`Error extracting text from ${currentIndex}, ${JSON.stringify(currentItem)} ${err}, ${err.stack}`)
  }
  return pageText
}

neighborhood.updateIndex = function (pageObject) {
  let neighborInfo
  console.log(`updating ${pageObject.getSlug()} in index`)
  const site = location.host
  if (!(neighborInfo = neighborhood.sites[site])) {
    return
  }

  const slug = pageObject.getSlug()
  const title = pageObject.getTitle()
  const rawStory = pageObject.getRawPage().story
  const newText = rawStory.reduce(extractPageText, '')

  if (neighborInfo.siteIndex.has(slug)) {
    return neighborInfo.siteIndex.replace({
      id: slug,
      title: title,
      content: newText,
    })
  } else {
    return neighborInfo.siteIndex.add({
      id: slug,
      title: title,
      content: newText,
    })
  }
}

neighborhood.deleteFromIndex = function (pageObject) {
  let neighborInfo
  const site = location.host
  if (!(neighborInfo = neighborhood.sites[site])) {
    return
  }

  const slug = pageObject.getSlug()
  try {
    neighborInfo.siteIndex.discard(slug)
  } catch (err) {
    // swallow error, if the page was not in index
    if (!err.message.includes('not in the index')) {
      console.log(`removing ${slug} from index failed`, err)
    }
  }
}

neighborhood.search = function (searchQuery) {
  let neighborInfo, neighborSite
  const finds = []
  const tally = {}

  const tick = function (key) {
    if (tally[key]) {
      return tally[key]++
    } else {
      return (tally[key] = 1)
    }
  }

  const indexSite = site => {
    const timeLabel = `indexing sitemap ( ${site} )`
    console.time(timeLabel)
    console.log('indexing sitemap:', site)
    const siteIndex = new miniSearch({
      fields: ['title', 'content'],
    })
    neighborInfo.sitemap.forEach(function (page) {
      siteIndex.add({
        id: page.slug,
        title: page.title,
        content: page.synopsis,
      })
    })
    console.timeEnd(timeLabel)
    return siteIndex
  }

  const start = Date.now()
  // load, or create (from sitemap), site index
  for (neighborSite of Object.keys(neighborhood.sites)) {
    neighborInfo = neighborhood.sites[neighborSite]
    if (neighborInfo.sitemap) {
      // do we already have an index?
      if (!neighborInfo.siteIndex) {
        // create an index using sitemap
        neighborInfo.siteIndex = indexSite(neighborSite, neighborInfo)
      }
    }
  }

  const origin = location.host
  for (neighborSite of Object.keys(neighborhood.sites)) {
    neighborInfo = neighborhood.sites[neighborSite]
    if (neighborInfo.siteIndex) {
      var contentBoost, error, searchResult, titleBoost
      tick('sites')
      try {
        if (tally['pages']) {
          tally['pages'] += neighborInfo.sitemap.length
        } else {
          tally['pages'] = neighborInfo.sitemap.length
        }
      } catch (error1) {
        error = error1
        console.info('+++ sitemap not valid for ', neighborSite)
        neighborInfo.sitemap = []
      }
      if (neighborSite === origin) {
        titleBoost = 20
        contentBoost = 2
      } else {
        titleBoost = 10
        contentBoost = 1
      }
      try {
        searchResult = neighborInfo.siteIndex.search(searchQuery, {
          boost: {
            title: titleBoost,
            content: contentBoost,
          },
          prefix: true,
          combineWith: 'AND',
        })
      } catch (error2) {
        error = error2
        console.error('search index error', neighborSite, searchQuery, error)
        searchResult = []
      }
      searchResult.forEach(function (result) {
        tick('finds')
        finds.push({
          page: neighborInfo.sitemap.find(({ slug }) => slug === result.id),
          site: neighborSite,
          rank: result.score,
        })
      })
    }
  }

  // sort the finds by rank
  finds.sort((a, b) => b.rank - a.rank)

  tally['msec'] = Date.now() - start
  return { finds, tally }
}

neighborhood.backLinks = function (slug) {
  const finds = []

  for (var neighborSite of Object.keys(neighborhood.sites)) {
    var neighborInfo = neighborhood.sites[neighborSite]
    if (neighborInfo.sitemap) {
      neighborInfo.sitemap.forEach(sitemapData => {
        if (
          sitemapData.links &&
          Object.keys(sitemapData.links).length > 0 &&
          Object.keys(sitemapData.links).includes(slug)
        ) {
          finds.push({
            slug: sitemapData.slug,
            title: sitemapData.title,
            site: neighborSite,
            itemId: sitemapData.links[slug],
            date: sitemapData.date,
          })
        }
      })
    }
  }
  const results = {}

  finds.forEach(function (find) {
    slug = find['slug']

    results[slug] = results[slug] || {}
    results[slug]['title'] = find['title']
    results[slug]['sites'] = results[slug]['sites'] || []
    results[slug]['sites'].push({
      site: find['site'],
      date: find['date'],
      itemId: find['itemId'],
    })
  })
  return results
}
