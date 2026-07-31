/*
 * Navio chat launcher — the one-line embed for any Sportnavi website.
 *
 *   <script src="https://chat.sportnavi.de/launcher.js" async></script>
 *
 * Adds a floating launcher button; clicking it opens the Navio chat inside an
 * iframe served from THIS deployment (same origin as the launcher script), so
 * it works on ANY host technology (plain HTML, React, Vue, Angular, CMS) with
 * zero build step. Look follows docs/design/NAVIO_WIDGET_SPEC.md: ink launcher with a
 * brand-green icon + glow; a 24px-rounded floating panel on desktop that becomes
 * full-screen on phones. All security lives on the deployment side (origin
 * allowlist, rate limiting, BotID, spend cap) and in the widget page's
 * `frame-ancestors`, so this script stays tiny and dependency-free.
 */
(function () {
  "use strict";
  if (window.__navioLauncherMounted) return;
  window.__navioLauncherMounted = true;

  // Resolve this deployment's origin from the script's own URL so the same file
  // works on chat.sportnavi.de, a preview URL, or localhost without edits.
  var self = document.currentScript;
  var base;
  try {
    base = new URL((self && self.src) || window.location.href).origin;
  } catch (e) {
    base = window.location.origin;
  }
  var widgetUrl = base + "/widget";

  var GREEN = "#95c11e"; // brand-green (primary)
  var INK = "#1a1a1a"; // launcher background (signature ink + green icon look)

  // Stroke-based icons at 1.75 weight per the design guidelines (§7).
  var CHAT_ICON =
    '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.9-.9L3 21l1.9-5.6A8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z"/></svg>';
  var CLOSE_ICON =
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M18 6 6 18M6 6l12 12"/></svg>';

  var open = false;
  function isMobile() {
    // Phones (narrow OR short viewports) get a full-screen sheet.
    return window.matchMedia("(max-width: 480px), (max-height: 480px)").matches;
  }

  var button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", "Chat mit Navio öffnen");
  button.style.cssText =
    "position:fixed;bottom:24px;right:24px;width:56px;height:56px;border:0;border-radius:9999px;" +
    "background:" + INK + ";color:" + GREEN + ";cursor:pointer;z-index:2147483000;" +
    "box-shadow:0 8px 30px -6px rgba(149,193,30,.6);display:flex;align-items:center;justify-content:center;" +
    "transition:transform .15s ease;-webkit-tap-highlight-color:transparent;";
  button.innerHTML = CHAT_ICON;
  button.onmouseenter = function () { button.style.transform = "scale(1.06)"; };
  button.onmouseleave = function () { button.style.transform = "scale(1)"; };

  var frame = document.createElement("iframe");
  frame.title = "Navio Chat";
  frame.src = widgetUrl;
  frame.setAttribute("allow", "clipboard-write");
  frame.setAttribute("aria-label", "Navio Chat");
  frame.style.cssText =
    "position:fixed;border:0;z-index:2147483000;background:#fff;display:none;" +
    "box-shadow:0 24px 60px -20px rgba(26,25,23,.35);";

  // Apply size/position for the current viewport + open state.
  function layout() {
    var mobile = isMobile();
    frame.style.display = open ? "block" : "none";
    if (mobile) {
      // Full-screen sheet — no page behind to mis-tap; the widget's own ✕ closes it.
      frame.style.inset = "0";
      frame.style.width = "100%";
      frame.style.height = "100%";
      frame.style.maxWidth = "100%";
      frame.style.maxHeight = "100%";
      frame.style.borderRadius = "0";
    } else {
      frame.style.inset = "";
      frame.style.top = "";
      frame.style.left = "";
      frame.style.bottom = "92px";
      frame.style.right = "24px";
      frame.style.width = "380px";
      frame.style.height = "min(560px, 72vh)";
      frame.style.maxWidth = "calc(100vw - 3rem)";
      frame.style.maxHeight = "calc(100vh - 7rem)";
      frame.style.borderRadius = "24px";
    }
    // On mobile, hide the FAB while open (full-screen widget carries its own close).
    button.style.display = open && mobile ? "none" : "flex";
    button.innerHTML = open ? CLOSE_ICON : CHAT_ICON;
    button.setAttribute("aria-label", open ? "Chat schließen" : "Chat mit Navio öffnen");
  }

  function setOpen(next) {
    open = next;
    layout();
  }

  button.addEventListener("click", function () { setOpen(!open); });

  // The widget posts this when its in-panel ✕ is pressed.
  window.addEventListener("message", function (event) {
    if (event.origin === base && event.data === "snv-widget-close") setOpen(false);
  });

  // Re-flow on rotation / resize / mobile-desktop crossover.
  window.addEventListener("resize", function () { if (open) layout(); });

  function mount() {
    document.body.appendChild(frame);
    document.body.appendChild(button);
    layout();
  }
  if (document.body) mount();
  else window.addEventListener("DOMContentLoaded", mount);
})();
