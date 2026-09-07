(function () {
  "use strict";
  function initTabs(root) {
    const tabs = Array.prototype.slice.call(root.querySelectorAll('[role="tab"]'));
    if (!tabs.length) return;
    function select(tab, focus) {
      tabs.forEach(function (t) {
        const selected = t === tab;
        t.setAttribute("aria-selected", selected ? "true" : "false");
        t.tabIndex = selected ? 0 : -1;
        const panel = document.getElementById(t.getAttribute("aria-controls"));
        if (panel) {
          if (selected) {
            panel.removeAttribute("hidden");
          } else {
            panel.setAttribute("hidden", "");
          }
        }
      });
      if (focus) tab.focus();
    }
    tabs.forEach(function (tab, i) {
      tab.addEventListener("click", function () { select(tab, false); });
      tab.addEventListener("keydown", function (ev) {
        let next = null;
        if (ev.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
        if (ev.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
        if (ev.key === "Home") next = tabs[0];
        if (ev.key === "End") next = tabs[tabs.length - 1];
        if (next) {
          ev.preventDefault();
          select(next, true);
        }
      });
    });
  }
  function init() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-tabs]"), initTabs);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
