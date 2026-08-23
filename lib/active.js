// Wiki considers one page to be active. Use active.set to change which
// page this is. A page need not be active to be edited.

let active
module.exports = active = {}

// active.scrollContainer = undefined;

// const findScrollContainer = function() {
//   const scrolled = $(".main").filter(function() { return $(this).scrollLeft() > 0; });
//   if (scrolled.length > 0) {
//     return scrolled;
//   } else {
//     return $(".main").scrollLeft(12).filter(function() { return $(this).scrollLeft() > 0; }).scrollTop(0);
//   }
// };

// const scrollTo = function($page) {
//   let scrollTarget;
//   if ($page.position() == null) { return; }
//   if (active.scrollContainer == null) { active.scrollContainer = findScrollContainer(); }
//   const bodyWidth = $("body").width();
//   const minX = active.scrollContainer.scrollLeft();
//   const maxX = minX + bodyWidth;
//   const target = $page.position().left;
//   const width = $page.outerWidth(true);
//   const contentWidth = $(".page").outerWidth(true) * $(".page").length;

//   // determine target position to scroll to...
//   if (target < minX) {
//     scrollTarget = target;
//   } else if ((target + width) > maxX) {
//     scrollTarget = target - (bodyWidth - width);
//   } else if (maxX > $(".pages").outerWidth()) {
//     scrollTarget = Math.min(target, contentWidth - bodyWidth);
//   }
//   // scroll to target and set focus once animation is complete
//   active.scrollContainer.animate({
//     scrollLeft: scrollTarget
//     }, function() {
//       // only set focus if focus is not already within the page to get focus
//       if (!$.contains($page[0], document.activeElement)) { $page.trigger('focus'); }
//   } );
// };

function scrollTo($page) {
  // Don't fight the mobile search IME — lineup load calls active.set while pages
  // render, and smooth scrollIntoView blurs/reopens the keyboard in a loop.
  if (document.body.classList.contains('wiki-mobile-searching')) return
  if (
    $('.incremental-search').length &&
    window.matchMedia('(max-width: 490px)').matches
  ) {
    return
  }

  const element = $page.get(0)
  if (!element) return

  const main = document.querySelector('.main')
  const isMobile = window.matchMedia('(max-width: 490px)').matches
  let prevSnap
  if (main && isMobile) {
    // scroll-snap overlay CSS fights smooth scrollIntoView; disable until scroll ends.
    prevSnap = main.style.scrollSnapType
    main.style.scrollSnapType = 'none'
  }

  element.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })

  if (main && isMobile) {
    const restore = () => {
      main.style.scrollSnapType = prevSnap
    }
    if (main.onscrollend !== undefined) {
      main.addEventListener('scrollend', restore, { once: true })
      setTimeout(restore, 600)
    } else {
      setTimeout(restore, 500)
    }
  }
}

active.set = function ($page, noScroll) {
  if ($page == null) return
  $('.incremental-search').remove()
  $page = $($page)
  $('.active').removeClass('active')
  $page.addClass('active')
  if (!noScroll) {
    scrollTo($page)
  }
}
