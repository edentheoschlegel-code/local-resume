/* LocalResume — theme control (light / dark / system).
 *
 * Loaded synchronously in <head> before styles paint the body so the correct
 * data-theme is on <html> from the first frame (no flash). CSP-safe: this is a
 * same-origin 'self' script, no inline code. 100% on-device; the choice lives
 * in localStorage under "localresume.theme" with values "light"|"dark"|"system"
 * (unset === follow system).
 *
 * A11y/theming only — no app state, no billing, nothing here touches money. */
"use strict";
(function () {
  var KEY = "localresume.theme";
  var root = document.documentElement;
  var mql = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function stored() {
    try {
      var v = localStorage.getItem(KEY);
      return v === "light" || v === "dark" || v === "system" ? v : null;
    } catch (e) { return null; } // private browsing / blocked storage → treat as system
  }

  // Resolve the choice to a concrete "light"|"dark" and apply it to <html>.
  // "system" (or unset) follows prefers-color-scheme live.
  function apply(choice) {
    var effective = choice === "light" || choice === "dark"
      ? choice
      : (mql && mql.matches ? "dark" : "light");
    if (effective === "dark") root.setAttribute("data-theme", "dark");
    else root.removeAttribute("data-theme"); // light === no attribute (light is the base :root palette)
  }

  // Boot: apply as early as possible to avoid a flash of the wrong theme.
  apply(stored() || "system");

  // Live-follow the OS setting whenever the choice is "system"/unset.
  if (mql) {
    var onSystemChange = function () { if (!stored() || stored() === "system") apply("system"); };
    if (mql.addEventListener) mql.addEventListener("change", onSystemChange);
    else if (mql.addListener) mql.addListener(onSystemChange); // older Safari
  }

  // Public surface for the toggle button (wired up by app.js once the DOM is ready).
  // Cycles light → dark → system → light, persists, and re-applies.
  window.LocalResumeTheme = {
    STORAGE_KEY: KEY,
    get: function () { return stored() || "system"; },
    // Returns the concrete rendered theme ("light"|"dark") after applying.
    set: function (choice) {
      try { localStorage.setItem(KEY, choice); } catch (e) { /* choice won't persist, but still applies this session */ }
      apply(choice);
      return root.getAttribute("data-theme") === "dark" ? "dark" : "light";
    },
    // Cycles the three states so every click visibly changes the rendered
    // theme: from "system" flip to the opposite of what's currently shown,
    // then dark → light → system. This keeps all three reachable while never
    // producing a no-op click (e.g. "system" on a light OS → "dark").
    cycle: function () {
      var cur = stored() || "system";
      var renderedDark = root.getAttribute("data-theme") === "dark";
      var next = cur === "system" ? (renderedDark ? "light" : "dark")
        : cur === "dark" ? "light"
        : "system";
      return this.set(next);
    },
  };
})();
