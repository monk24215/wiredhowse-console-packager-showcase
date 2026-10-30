/*
 * WordPress Plugin Creator — full-page transparent loader.
 *
 * Usage:
 *   <script src="/wp-loader.js" data-src="/wp-logo.webp"></script>
 *
 *   WPLoader.show();            // show while work is running
 *   WPLoader.hide();            // hide when finished (calls nest safely)
 *   await WPLoader.track(p);    // show while promise p runs, then hide
 *
 * The overlay has no background, so the page stays visible underneath.
 * It blocks clicks while shown. Animation is turned off for users who
 * prefer reduced motion.
 */
(function () {
  "use strict";

  var script = document.currentScript;
  var logoSrc = (script && script.getAttribute("data-src")) || "/wp-logo.webp";
  var pending = 0;
  var overlay = null;

  var css =
    "#wp-loader{position:fixed;inset:0;z-index:2147483000;display:none;" +
    "align-items:center;justify-content:center;background:transparent;" +
    "pointer-events:none;}" +
    "#wp-loader.wp-loader-active{display:flex;pointer-events:auto;}" +
    "#wp-loader img{width:min(60vw,260px);height:auto;" +
    "animation:wp-loader-breathe 1.8s ease-in-out infinite;" +
    "filter:drop-shadow(0 0 12px rgba(230,60,60,.45));}" +
    "@keyframes wp-loader-breathe{" +
    "0%,100%{transform:scale(.94);filter:drop-shadow(0 0 6px rgba(230,60,60,.30));}" +
    "50%{transform:scale(1.04);filter:drop-shadow(0 0 22px rgba(230,60,60,.70));}}" +
    "@media (prefers-reduced-motion: reduce){" +
    "#wp-loader img{animation:none;}}";

  function build() {
    if (overlay) return overlay;
    var style = document.createElement("style");
    style.id = "wp-loader-style";
    style.textContent = css;
    document.head.appendChild(style);

    overlay = document.createElement("div");
    overlay.id = "wp-loader";
    overlay.setAttribute("role", "status");
    overlay.setAttribute("aria-live", "polite");
    overlay.setAttribute("aria-label", "Working");

    var img = document.createElement("img");
    img.src = logoSrc;
    img.alt = "";
    overlay.appendChild(img);

    document.body.appendChild(overlay);
    return overlay;
  }

  function ready(fn) {
    if (document.body) fn();
    else document.addEventListener("DOMContentLoaded", fn, { once: true });
  }

  function render() {
    if (!overlay) return;
    overlay.classList.toggle("wp-loader-active", pending > 0);
    if (pending > 0) {
      document.documentElement.setAttribute("aria-busy", "true");
    } else {
      document.documentElement.removeAttribute("aria-busy");
    }
  }

  var WPLoader = {
    show: function () {
      ready(function () {
        build();
        pending += 1;
        render();
      });
    },
    hide: function () {
      pending = Math.max(0, pending - 1);
      render();
    },
    track: function (promise) {
      WPLoader.show();
      return Promise.resolve(promise).finally(WPLoader.hide);
    },
    isVisible: function () {
      return pending > 0;
    },
  };

  window.WPLoader = WPLoader;
})();
