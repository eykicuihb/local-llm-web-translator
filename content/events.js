// Bootstrap event tap — runs at document_start, BEFORE any page script.
//
// Why this exists: hostile SPAs (X.com, GitHub) register capture-phase
// listeners at document/window load time and call stopImmediatePropagation()
// on mouse/pointer/click events. Any listener the content script registers
// later (even capture-phase on document) never fires, and events never reach
// element-level handlers either — which made the selection-translate trigger
// icon impossible to click on those sites.
//
// Because this file executes before every page script, its capture-phase
// listeners are guaranteed to run FIRST. We only observe (never stop
// propagation or preventDefault here), so page behavior is untouched.
// Handlers in content.js subscribe via window.__lmtOnEvent — both files run
// in the same isolated world, so the full event object is shared.
(function () {
  'use strict';
  var w = window;
  var fire = function (type, e) {
    var cb = w.__lmtOnEvent;
    if (typeof cb === 'function') {
      try { cb(type, e); } catch (err) { /* never break the host page */ }
    }
  };
  [
    'mousemove', 'pointermove',
    'mousedown', 'pointerdown',
    'mouseup', 'pointerup', 'pointercancel',
    'click',
    'contextmenu',
    'keydown', 'keyup'
  ].forEach(function (t) {
    var h = function (e) { fire(t, e); };
    document.addEventListener(t, h, true);
    window.addEventListener(t, h, true);
  });
})();
