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
  // Opening a search hit calls active.set; on mobile, scrollIntoView fights the
  // soft keyboard / results overlay. Desktop still scrolls the new page into view.
  if ($('.incremental-search').length && window.matchMedia('(max-width: 490px)').matches) {
    return
  }
  const element = $page.get(0)
  element.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
}

// Set true when the user focuses a page, starts an item drag, or opens an
// editor mid-load. Initial lineup load uses this to skip forcing the last
// page active (and scrolling the lineup) after that interaction.
active.chosen = false

active.markChosen = function () {
  active.chosen = true
}

active.set = function ($page, noScroll) {
  if ($page == null) return
  $page = $($page)
  $('.active').removeClass('active')
  $page.addClass('active')
  active.markChosen()
  if (!noScroll) {
    scrollTo($page)
  }
}
