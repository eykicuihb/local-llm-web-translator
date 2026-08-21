// Local LLM Web Translator - Content Script

const BLOCK_TAGS = new Set([
  'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE',
  'TD', 'TH', 'DIV', 'SECTION', 'ARTICLE', 'PRE'
]);

let isTranslationActive = false;
let translatedCount = 0;
let totalCount = 0;
let observer = null;
let intersectionObserver = null;
let lazyTranslateQueue = [];
let lazyTranslateTimeout = null;

// Drag controllers are fed exclusively by the __lmtOnEvent tap (see
// initSelectionTranslate): element-level pointer listeners never fire on
// hostile pages whose capture-phase handlers stopImmediatePropagation().
const _lmtDragControllers = new Set();

function _lmtDispatchToDrags(type, e) {
  for (const ctrl of _lmtDragControllers) {
    try { ctrl(type, e); } catch (err) { /* never break the host page */ }
  }
}

// Elements whose batch translation failed; surfaced as a retry badge on the
// floating widget instead of disappearing silently.
const _lmtFailedElements = new Set();

// Clean text helper: removes excessive whitespaces
function getCleanText(el) {
  return el.innerText.trim().replace(/\s+/g, ' ');
}

// Check if an element has block-level children
function hasBlockChildren(element) {
  for (let i = 0; i < element.children.length; i++) {
    if (BLOCK_TAGS.has(element.children[i].tagName.toUpperCase())) {
      return true;
    }
  }
  return false;
}

// Check if a node represents or contains programming code
function isCodeBlock(node) {
  const tagName = node.tagName.toUpperCase();
  if (tagName === 'CODE' || node.closest('code')) {
    return true;
  }
  if (tagName === 'PRE' || node.closest('pre')) {
    return true;
  }
  const className = node.className;
  if (typeof className === 'string' && className.length > 0) {
    if (/\b(highlight|syntax|prettyprint|prism|hljs|code-block|codeblock|cm-editor|monaco-editor)\b/i.test(className)) {
      return true;
    }
  }
  return false;
}

// Determine if an element is a translation candidate
function isTranslationCandidate(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;

  if (isCodeBlock(node)) {
    return false;
  }

  const tagName = node.tagName.toUpperCase();

  // Skip script, style, and interactive tags
  if ([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'CANVAS', 'SVG',
    'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'HEAD', 'NAV', 'FOOTER', 'NOSCRIPT'
  ].includes(tagName)) {
    return false;
  }

  // Skip elements that are part of the translation floating widget
  if (node.closest('#lmt-floating-widget')) {
    return false;
  }

  // Skip elements that are already translations or marked
  if (node.classList.contains('lmt-translation') || node.hasAttribute('data-lmt-translated')) {
    return false;
  }

  // Check direct text content
  let hasText = false;
  let text = '';
  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes[i];
    if (child.nodeType === Node.TEXT_NODE) {
      const val = child.nodeValue.trim();
      // Only treat it as valid if it contains actual letters, not just symbols or numbers
      if (val.length > 0 && !/^[\d\s\p{P}]+$/u.test(val)) {
        hasText = true;
        text += val + ' ';
      }
    }
  }

  // Candidate if it has direct text content and no block children
  if (hasText && !hasBlockChildren(node)) {
    return true;
  }

  return false;
}

// Recursive DOM tree traversal
function walk(node, callback) {
  if (isTranslationCandidate(node)) {
    callback(node);
    return; // Stop traversing children of a translation candidate
  }

  if (node.nodeType === Node.ELEMENT_NODE) {
    const tagName = node.tagName.toUpperCase();
    if (node.id === 'lmt-floating-widget' || [
      'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'CANVAS', 'SVG', 'CODE',
      'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'HEAD'
    ].includes(tagName)) {
      return;
    }

    if (isCodeBlock(node)) {
      return;
    }

    let child = node.firstChild;
    while (child) {
      walk(child, callback);
      child = child.nextSibling;
    }
  }
}

// Start page translation
async function startTranslation() {
  if (isTranslationActive) return;
  isTranslationActive = true;

  // Set loading/translating indicator on floating widget if present
  const widget = document.getElementById('lmt-floating-widget');
  if (widget) {
    widget.classList.add('lmt-translating');
  }

  translatedCount = 0;
  totalCount = 0;

  // Retrieve settings
  const settings = await chrome.storage.local.get(['batchSize', 'concurrency', 'translationMode']);
  const translationMode = settings.translationMode || 'dual';

  setTranslationModeClass(translationMode);
  document.body.classList.remove('lmt-hide-translations');

  // Collect all candidates on page
  const candidates = [];
  walk(document.body, (el) => {
    candidates.push(el);
  });

  totalCount = candidates.length;
  sendProgressUpdate();

  if (totalCount === 0) {
    isTranslationActive = false;
    updateWidgetState();
    return;
  }

  // Setup MutationObserver for infinite scroll / dynamic content
  setupMutationObserver();

  // Initialize IntersectionObserver and observe all candidate elements for lazy translation
  initIntersectionObserver();
  candidates.forEach(el => {
    intersectionObserver.observe(el);
  });

  updateWidgetState();
}

// Process candidates queue in batches with concurrency control
async function processQueue(candidates, settings) {
  const { batchSize, concurrency } = settings;
  const batches = [];
  for (let i = 0; i < candidates.length; i += batchSize) {
    batches.push(candidates.slice(i, i + batchSize));
  }

  let batchIndex = 0;
  const runWorker = async () => {
    while (batchIndex < batches.length) {
      const currentBatch = batches[batchIndex++];
      try {
        await translateBatchElements(currentBatch);
      } catch (err) {
        console.error('Failed to translate batch:', err);
      }
    }
  };

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, batches.length); i++) {
    workers.push(runWorker());
  }

  await Promise.all(workers);
}

// Translate a single batch of elements
async function translateBatchElements(elements) {
  const texts = elements.map(el => getCleanText(el));

  // Mark as translating
  elements.forEach(el => el.setAttribute('data-lmt-translated', 'translating'));

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'TRANSLATE_BATCH',
      payload: { texts }
    });

    if (response && response.success && response.translations) {
      const translations = response.translations;
      
      // Batch UI updates using requestAnimationFrame
      await new Promise((resolve) => {
        requestAnimationFrame(() => {
          for (let i = 0; i < elements.length; i++) {
            const el = elements[i];
            const rawTranslation = translations[i];
            const translationText = rawTranslation !== undefined && rawTranslation !== null ? String(rawTranslation) : '';

            if (translationText && translationText.trim().length > 0) {
              injectTranslation(el, translationText);
              el.setAttribute('data-lmt-translated', 'true');
            } else {
              el.removeAttribute('data-lmt-translated');
              _lmtFailedElements.add(el);
            }
          }
          resolve();
        });
      });

      if (isTranslationActive) {
        translatedCount += elements.length;
        sendProgressUpdate();
      }
      updateFailedBadge();
    } else {
      throw new Error(response ? response.error : 'Unknown response error');
    }
  } catch (err) {
    console.error('Batch translation error:', err);
    // Reset attribute so elements can be retried
    elements.forEach(el => {
      el.removeAttribute('data-lmt-translated');
      _lmtFailedElements.add(el);
    });
    updateFailedBadge();
  }
}

// Shared toggle used by the floating widget, the popup visibility flow and
// the Alt+A command message.
async function togglePageTranslation() {
  if (!isTranslationActive) {
    await startTranslation();
    return;
  }
  const isHidden = document.body.classList.contains('lmt-hide-translations');
  if (isHidden) {
    document.body.classList.remove('lmt-hide-translations');
    resumeTranslation();
  } else {
    hideTranslations();
  }
  updateWidgetState();
}

function hideTranslations() {
  document.body.classList.add('lmt-hide-translations');
  lazyTranslateQueue = [];
  if (lazyTranslateTimeout) {
    clearTimeout(lazyTranslateTimeout);
    lazyTranslateTimeout = null;
  }
}

function updateFailedBadge() {
  _lmtFailedElements.forEach((el) => {
    if (!el.isConnected) _lmtFailedElements.delete(el);
  });

  const widget = document.getElementById('lmt-floating-widget');
  if (!widget) return;

  let badge = widget.querySelector('.lmt-retry-badge');
  if (_lmtFailedElements.size === 0) {
    if (badge) badge.remove();
    return;
  }

  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'lmt-retry-badge';
    badge.title = '部分段落翻译失败，点击重试';
    badge._lmtActivate = () => retryFailedElements();
    widget.appendChild(badge);
  }
  badge.style.display = 'flex';
  badge.textContent = '↻';
}

async function retryFailedElements() {
  const els = [..._lmtFailedElements].filter(el => el.isConnected && !el.getAttribute('data-lmt-translated'));
  _lmtFailedElements.clear();
  updateFailedBadge();
  if (els.length === 0) return;

  els.forEach(el => el.setAttribute('data-lmt-translated', 'translating'));
  const settings = await chrome.storage.local.get(['batchSize', 'concurrency']);
  await processQueue(els, { batchSize: settings.batchSize || 10, concurrency: settings.concurrency || 3 });
}

// Inject translation node into the DOM
function injectTranslation(originalEl, translationText) {
  const tagName = originalEl.tagName.toUpperCase();
  const isBlock = BLOCK_TAGS.has(tagName);

  originalEl.classList.add('lmt-original-translated');

  if (isBlock) {
    const transEl = document.createElement(tagName);
    transEl.className = 'lmt-translation';
    transEl.textContent = translationText;
    originalEl.insertAdjacentElement('afterend', transEl);
  } else {
    const transEl = document.createElement('span');
    transEl.className = 'lmt-translation';
    transEl.textContent = ` (${translationText}) `;
    originalEl.insertAdjacentElement('afterend', transEl);
  }
}

// Send progress update message
function sendProgressUpdate() {
  chrome.runtime.sendMessage({
    type: 'TRANSLATION_PROGRESS',
    payload: {
      translated: translatedCount,
      total: totalCount
    }
  }).catch(() => {
    // Ignore error when popup is closed
  });
}

// Resume translation by re-observing visible untranslated elements
function resumeTranslation() {
  if (!isTranslationActive) return;
  
  const candidates = [];
  walk(document.body, (el) => {
    const status = el.getAttribute('data-lmt-translated');
    if (!status || status === 'false') {
      candidates.push(el);
    }
  });

  if (candidates.length > 0) {
    initIntersectionObserver();
    candidates.forEach(el => {
      intersectionObserver.observe(el);
    });
  }
}

// Stop translation entirely, clean up the DOM, and disconnect observers
function stopTranslation() {
  isTranslationActive = false;
  
  if (observer) {
    observer.disconnect();
    observer = null;
  }

  if (intersectionObserver) {
    intersectionObserver.disconnect();
    intersectionObserver = null;
  }

  lazyTranslateQueue = [];
  if (lazyTranslateTimeout) {
    clearTimeout(lazyTranslateTimeout);
    lazyTranslateTimeout = null;
  }

  document.body.classList.remove('lmt-hide-translations');
  document.body.classList.remove('lmt-translation-only-mode');

  // Remove translation elements from DOM
  const translations = document.querySelectorAll('.lmt-translation');
  translations.forEach(el => el.remove());

  // Clean original element classes and data attributes
  const originals = document.querySelectorAll('.lmt-original-translated');
  originals.forEach(el => el.classList.remove('lmt-original-translated'));

  const translatedElements = document.querySelectorAll('[data-lmt-translated]');
  translatedElements.forEach(el => el.removeAttribute('data-lmt-translated'));

  translatedCount = 0;
  totalCount = 0;
  _lmtFailedElements.clear();
  updateFailedBadge();

  updateWidgetState();
}

// Set up MutationObserver
function setupMutationObserver() {
  if (observer) return;

  observer = new MutationObserver((mutations) => {
    const addedNodes = [];
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          addedNodes.push(node);
        }
      }
    }

    if (addedNodes.length > 0) {
      handleMutations(addedNodes);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

// Handle dynamic mutations by registering new candidates to the IntersectionObserver
function handleMutations(addedNodes) {
  if (!isTranslationActive) return;
  if (document.body.classList.contains('lmt-hide-translations')) return;

  const addedCandidates = [];
  addedNodes.forEach(node => {
    walk(node, (el) => {
      addedCandidates.push(el);
    });
  });

  if (addedCandidates.length > 0) {
    totalCount += addedCandidates.length;
    sendProgressUpdate();

    // Register new candidates for lazy viewport translation
    initIntersectionObserver();
    addedCandidates.forEach(el => {
      intersectionObserver.observe(el);
    });
  }
}

// Initialize IntersectionObserver for viewport-based lazy translation
function initIntersectionObserver() {
  if (intersectionObserver) return;

  intersectionObserver = new IntersectionObserver((entries) => {
    if (document.body.classList.contains('lmt-hide-translations')) return;
    const elementsToTranslate = [];
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const el = entry.target;
        intersectionObserver.unobserve(el); // Only translate once
        
        const status = el.getAttribute('data-lmt-translated');
        if (!status || status === 'false') {
          elementsToTranslate.push(el);
        }
      }
    }

    if (elementsToTranslate.length > 0) {
      handleLazyTranslation(elementsToTranslate);
    }
  }, {
    root: null, // Viewport
    rootMargin: '200px' // Pre-load elements 200px before they scroll into view
  });
}

// Queue and debounce lazy translation requests
function handleLazyTranslation(elements) {
  if (document.body.classList.contains('lmt-hide-translations')) return;
  elements.forEach(el => {
    if (!lazyTranslateQueue.includes(el)) {
      lazyTranslateQueue.push(el);
    }
  });

  if (lazyTranslateTimeout) clearTimeout(lazyTranslateTimeout);
  lazyTranslateTimeout = setTimeout(async () => {
    if (lazyTranslateQueue.length === 0) return;
    const elementsToProcess = [...lazyTranslateQueue];
    lazyTranslateQueue = [];

    const settings = await chrome.storage.local.get(['batchSize', 'concurrency']);
    const batchSize = settings.batchSize || 10;
    const concurrency = settings.concurrency || 3;

    await processQueue(elementsToProcess, { batchSize, concurrency });
  }, 250); // Debounce to batch elements entering viewport at the same time
}

// Toggle layout mode CSS classes
function setTranslationModeClass(mode) {
  if (mode === 'translation') {
    document.body.classList.add('lmt-translation-only-mode');
  } else {
    document.body.classList.remove('lmt-translation-only-mode');
  }
}

const _lmtStyleClasses = ['lmt-style-dashed', 'lmt-style-blur'];

function setTranslationStyleClass(style) {
  _lmtStyleClasses.forEach(c => document.body.classList.remove(c));
  if (style === 'dashed') document.body.classList.add('lmt-style-dashed');
  else if (style === 'blur') document.body.classList.add('lmt-style-blur');
}

// --- Keyboard interactions (fed by the __lmtOnEvent tap) ---

// Ctrl held ALONE (no other key during the hold) translates the paragraph
// under the cursor; this keeps Ctrl+C / Ctrl+A etc. untouched.
let _ctrlAlone = false;
let _ctrlCombo = false;

function _lmtHandleKey(type, e) {
  try {
    if (type === 'keydown') {
      if (e.key === 'Control' && !e.repeat) {
        _ctrlAlone = true;
        _ctrlCombo = false;
      } else if (_ctrlAlone && e.key !== 'Control') {
        _ctrlCombo = true;
      }
      if (e.key === ' ') _lmtMaybeInputTranslate(e);
      return;
    }

    if (e.key === 'Control' && _ctrlAlone) {
      _ctrlAlone = false;
      if (!_ctrlCombo) _lmtHoverTranslate();
    }
  } catch (err) {
    console.debug('[LMT]', err);
  }
}

function _lmtIsEditableTarget(t) {
  if (!t || !t.tagName) return false;
  const tag = t.tagName.toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const ty = (t.type || 'text').toLowerCase();
    return !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range'].includes(ty);
  }
  return t.isContentEditable === true;
}

function _lmtHoverTranslate() {
  if (_lmtIsEditableTarget(document.activeElement)) return;

  let el = document.elementFromPoint(_lmtLastMouseX, _lmtLastMouseY);
  while (el) {
    if (el.closest && el.closest('#lmt-floating-widget,#lmt-bubble,#lmt-trigger,#lmt-hint,.lmt-translation')) return;
    if (isTranslationCandidate(el)) break;
    el = el.parentElement;
  }
  if (!el || el === document.documentElement || el === document.body) return;
  if (el.hasAttribute('data-lmt-translated')) return;

  translateBatchElements([el]);
}

// Input-box translate: typing "text␣␣␣" (three trailing spaces) in an
// input/textarea swaps the content for its translation. Detection happens on
// the THIRD space's keydown, when the value holds exactly two trailing spaces
// (the third is only inserted afterwards by the default action). The
// pre-trigger value is snapshotted so keystrokes that land while the LLM
// responds are never clobbered.
function _lmtMaybeInputTranslate(e) {
  const t = e.target;
  if (!_lmtIsEditableTarget(t) || t.isContentEditable) return;

  const raw = typeof t.value === 'string' ? t.value : '';
  if (!raw.endsWith('  ')) return;
  const source = raw.slice(0, -2);
  if (!source.trim()) return;

  if (e.cancelable) e.preventDefault();
  const snapshot = raw;

  chrome.runtime.sendMessage({ type: 'TRANSLATE_BATCH', payload: { texts: [source] } })
    .then((res) => {
      if (!res || !res.success || !Array.isArray(res.translations)) return;
      const out = String(res.translations[0] ?? '').trim();
      if (!out) return;
      if (t.value !== snapshot) return;
      t.value = out;
      t.dispatchEvent(new Event('input', { bubbles: true }));
    })
    .catch(() => {});
}

// Update floating widget UI state based on active translation/visibility state
function updateWidgetState() {
  const widget = document.getElementById('lmt-floating-widget');
  if (!widget) return;

  const tooltip = widget.querySelector('.lmt-tooltip');

  if (isTranslationActive) {
    const isHidden = document.body.classList.contains('lmt-hide-translations');
    if (isHidden) {
      widget.classList.remove('lmt-active');
      widget.classList.remove('lmt-translating');
      if (tooltip) tooltip.textContent = '显示翻译';
    } else {
      widget.classList.add('lmt-active');
      widget.classList.remove('lmt-translating');
      if (tooltip) tooltip.textContent = '隐藏翻译';
    }
  } else {
    widget.classList.remove('lmt-active');
    widget.classList.remove('lmt-translating');
    if (tooltip) tooltip.textContent = '翻译网页';
  }
}

// Message listener from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_TRANSLATION') {
    startTranslation();
    sendResponse({ success: true });
  }

  if (message.type === 'TOGGLE_VISIBILITY') {
    const { visible } = message.payload;
    if (visible) {
      document.body.classList.remove('lmt-hide-translations');
      if (isTranslationActive) {
        resumeTranslation();
      }
    } else {
      document.body.classList.add('lmt-hide-translations');
      lazyTranslateQueue = [];
      if (lazyTranslateTimeout) {
        clearTimeout(lazyTranslateTimeout);
        lazyTranslateTimeout = null;
      }
    }
    updateWidgetState();
    sendResponse({ success: true });
  }

  if (message.type === 'SET_MODE') {
    const { mode } = message.payload;
    setTranslationModeClass(mode);
    sendResponse({ success: true });
  }

  if (message.type === 'GET_PAGE_STATUS') {
    sendResponse({
      active: isTranslationActive,
      translated: translatedCount,
      total: totalCount
    });
  }

  if (message.type === 'SET_SELECTION_TRANSLATE') {
    const { enabled } = message.payload;
    selectionTranslateEnabled = enabled;
    if (!selectionTranslateEnabled) {
      const trigger = document.getElementById('lmt-trigger');
      if (trigger) trigger.style.display = 'none';
      const bubble = document.getElementById('lmt-bubble');
      if (bubble) bubble.style.display = 'none';
    }
    sendResponse({ success: true });
  }

  if (message.type === 'TOGGLE_TRANSLATION') {
    togglePageTranslation();
    sendResponse({ success: true });
  }
});

// Create and inject the floating widget button
function createFloatingButton() {
  if (document.getElementById('lmt-floating-widget')) return;

  const widget = document.createElement('div');
  widget.id = 'lmt-floating-widget';
  widget.title = 'Translate Page (Local LLM)';

  widget.innerHTML = `
    <img src="${chrome.runtime.getURL('icons/icon48.png')}" class="lmt-logo-icon" alt="Logo">
    <span class="lmt-tooltip">翻译网页</span>
    <button class="lmt-close-widget" title="Hide on this site">×</button>
  `;

  document.body.appendChild(widget);

  // Activation is dispatched via the __lmtOnEvent tap (see initSelectionTranslate):
  // plain click handlers are unreachable on hostile pages that kill events in
  // the capture phase.
  widget._lmtActivate = async () => {
    if (widget._lmtSuppressClick) {
      widget._lmtSuppressClick = false;
      return;
    }

    await togglePageTranslation();
  };

  const closeBtn = widget.querySelector('.lmt-close-widget');
  closeBtn._lmtActivate = async () => {
    widget.classList.add('lmt-hidden-widget');

    stopTranslation();

    const domain = window.location.hostname;
    const { ignoredDomains = [] } = await chrome.storage.local.get('ignoredDomains');
    if (!ignoredDomains.includes(domain)) {
      ignoredDomains.push(domain);
      await chrome.storage.local.set({ ignoredDomains });
    }
  };

  // Enable vertical dragging
  setupDrag(widget);
  
  // Initialize widget visual state
  updateWidgetState();
}

// Enable vertical dragging on the floating widget.
// Registered as a drag controller driven by the __lmtOnEvent tap — direct
// element/document listeners are dead on hostile pages, and pointer events
// already cover touch (no separate touch handlers needed).
function setupDrag(el) {
  let active = false;
  let startY = 0;
  let startTop = 0;
  let hasDragged = false;

  _lmtDragControllers.add((type, e) => {
    if (type === 'down') {
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      if (!path.includes(el)) return;
      if (e.target && e.target.closest && e.target.closest('.lmt-close-widget')) return;
      active = true;
      hasDragged = false;
      el._lmtSuppressClick = false;
      startY = e.clientY;
      startTop = el.offsetTop;
      el.style.transition = 'none';
      return;
    }

    if (!active) return;

    if (type === 'move') {
      const deltaY = e.clientY - startY;
      if (Math.abs(deltaY) > 5) hasDragged = true;
      let newTop = startTop + deltaY;
      const maxTop = window.innerHeight - el.offsetHeight - 20;
      newTop = Math.max(20, Math.min(newTop, maxTop));
      el.style.top = `${newTop}px`;
      el.style.bottom = 'auto';
      return;
    }

    if (type === 'up' || type === 'cancel') {
      active = false;
      el.style.transition = 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)';
      // Swallow the click that follows a real drag so it doesn't toggle
      // translation; cleared on the next gesture's down or next activate.
      if (hasDragged) el._lmtSuppressClick = true;
    }
  });
}

// --- Selection Translation Logic ---
let selectionTranslateEnabled = true;
let _lmtLastMouseX = 0;
let _lmtLastMouseY = 0;

async function initSelectionTranslate() {
  const settings = await chrome.storage.local.get('selectionTranslateEnabled');
  selectionTranslateEnabled = settings.selectionTranslateEnabled !== false;

  let _selTimer = null;

  // All pointer handling flows through window.__lmtOnEvent, fed by
  // content/events.js (document_start capture taps). Registering ordinary
  // document/window listeners here is NOT enough: hostile SPAs (X.com,
  // GitHub) register their own capture-phase stopImmediatePropagation()
  // handlers before we load, which silences every later listener AND
  // prevents events from ever reaching element-level handlers such as
  // trigger.onclick — that made the translate icon unclickable there.
  // The document_start tap registers before any page script, so it always
  // observes raw events; in return we never block the page's own handlers.
  window.__lmtOnEvent = (type, e) => {
    try {
      if (type === 'mousemove' || type === 'pointermove') {
        if (e.buttons !== undefined && e.buttons > 1) return; // Ignore right-click drags
        _lmtLastMouseX = e.clientX;
        _lmtLastMouseY = e.clientY;
      }

      // events.js taps BOTH window and document → every event arrives twice.
      if (e.__lmtSeen) return;
      e.__lmtSeen = true;

      // Drags consume down/move/up/cancel before any feature gating.
      const dragType = type === 'pointerdown' ? 'down'
        : type === 'pointermove' ? 'move'
        : type === 'pointerup' ? 'up'
        : type === 'pointercancel' ? 'cancel'
        : null;
      if (dragType) _lmtDispatchToDrags(dragType, e);

      if (type === 'pointercancel') return;

      if (type === 'keydown' || type === 'keyup') {
        // Ignore IME composition events (keyCode 229) — critical for CJK input.
        if (!e.isComposing && e.keyCode !== 229) _lmtHandleKey(type, e);
        return;
      }

      const isDown = type === 'mousedown' || type === 'pointerdown';
      const isUp = type === 'mouseup' || type === 'pointerup';
      const isClick = type === 'click';

      if (isDown) {
        if (e.button !== undefined && e.button !== 0) return; // Ignore right/middle-click
        if (_lmtEventHitsUi(e)) {
          // Pressing our UI must not collapse the active selection or steal focus.
          if (e.cancelable) e.preventDefault();
        } else {
          _lmtHideTriggerAndBubbleIfOutside(e);
        }
        return;
      }

      if (isUp) {
        if (!selectionTranslateEnabled) return;
        if (e.button !== undefined && e.button !== 0) return; // Preserve context-menu Copy
        if (_lmtEventHitsUi(e)) return; // Clicking our own UI must not re-process the selection
        _lmtLastMouseX = e.clientX;
        _lmtLastMouseY = e.clientY;
        clearTimeout(_selTimer);
        _selTimer = setTimeout(() => _lmtProcessSelection(), 40);
        return;
      }

      if (isClick) {
        // Route activation through the tap: plain onclick handlers are
        // unreachable when pages kill propagation in the capture phase.
        // NOT gated on selectionTranslateEnabled — that flag only governs
        // selection translate (the trigger), never the floating widget.
        const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
        for (const node of path) {
          if (node && typeof node._lmtActivate === 'function') {
            if (e.cancelable) e.preventDefault();
            node._lmtActivate(e);
            break;
          }
        }
        return;
      }

      if (type === 'contextmenu') {
        // Hide the trigger so right-click "Copy" targets aren't hijacked by it.
        const trigger = document.getElementById('lmt-trigger');
        if (trigger && trigger.style.display !== 'none') {
          trigger.style.display = 'none';
        }
      }
    } catch (err) { /* Never break the host page */ }
  };

  // Keyboard selections
  document.addEventListener('keyup', (e) => {
    if (!selectionTranslateEnabled) return;
    if (e.shiftKey || e.ctrlKey || e.metaKey || e.key === 'a') {
      clearTimeout(_selTimer);
      _selTimer = setTimeout(() => _lmtProcessSelection(), 100);
    }
  }, true);

  // NUCLEAR FALLBACK: poll window.getSelection() every 300ms.
  // This catches GitHub and any site that blocks mouse/pointer events in the
  // capture phase (stopImmediatePropagation). Deduplication is handled solely
  // by _pollLastText below — do NOT gate this poll on pointer/drag state:
  // if a site swallows mouseup, such state gets stuck and the poll would
  // never run, re-breaking GitHub.
  let _pollLastText = '';
  setInterval(() => {
    if (!selectionTranslateEnabled) return;
    try {
      const sel = window.getSelection();
      if (!sel) return;
      const text = sel.toString().trim();
      if (text && text.length >= 2 && text !== _pollLastText) {
        _pollLastText = text;
        _lmtProcessSelection();
      } else if (!text || text.length < 2) {
        _pollLastText = '';
      }
    } catch (e) { /* ignore */ }
  }, 300);
}

// Shared hit-test: did this event land on any of our UI? Checks the
// composed path for _lmtActivate nodes first (works for every routed
// element), with trigger/bubble contains() as fallback when composedPath
// is unavailable.
function _lmtEventHitsUi(e) {
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  for (const node of path) {
    if (node && node._lmtActivate) return true;
  }
  const t = document.getElementById('lmt-trigger');
  if (t && (path.includes(t) || t.contains(e.target))) return true;
  const b = document.getElementById('lmt-bubble');
  if (b && (path.includes(b) || b.contains(e.target))) return true;
  return false;
}

function _lmtHideTriggerAndBubbleIfOutside(e) {
  if (_lmtEventHitsUi(e)) return;
  const trigger = document.getElementById('lmt-trigger');
  const bubble = document.getElementById('lmt-bubble');
  if (trigger) trigger.style.display = 'none';
  if (bubble) bubble.style.display = 'none';
}

let _lmtLastProcessedText = '';
let _lmtLastProcessedTime = 0;

function _lmtProcessSelection() {
  try {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const text = selection.toString().trim();

    if (!text || text.length < 2) return;
    if (text.length > 2000) {
      _lmtShowHint();
      return;
    }
    if (/^[\d\s\p{P}]+$/u.test(text)) return;

    // Dedup: don't re-trigger the same text within 500ms
    const now = Date.now();
    if (text === _lmtLastProcessedText && now - _lmtLastProcessedTime < 500) return;
    _lmtLastProcessedText = text;
    _lmtLastProcessedTime = now;

    // Don't re-trigger if the trigger is already visible for this text
    const trigger = document.getElementById('lmt-trigger');
    if (trigger && trigger.style.display === 'flex' && trigger._lmtText === text) return;

    // Don't show trigger if the translation bubble is already visible
    const bubble = document.getElementById('lmt-bubble');
    if (bubble && bubble.style.display !== 'none' && bubble.style.display !== '') return;

    // Position trigger near the mouse cursor
    const posX = Math.max(5, Math.min(_lmtLastMouseX + 10, window.innerWidth - 40));
    const posY = Math.max(5, Math.min(_lmtLastMouseY + 10, window.innerHeight - 40));

    _lmtShowTrigger(text, posX, posY);
  } catch (err) {
    // Swallowed to protect the host page, but logged — silent failures here
    // once cost an entire debugging saga.
    console.debug('[LMT]', err);
  }
}

// Small transient hint for selections we refuse to translate (oversize).
function _lmtShowHint() {
  let hint = document.getElementById('lmt-hint');
  if (!hint) {
    hint = document.createElement('div');
    hint.id = 'lmt-hint';
    document.documentElement.appendChild(hint);
    Object.assign(hint.style, {
      all: 'initial',
      position: 'fixed',
      zIndex: '2147483647',
      width: '260px',
      background: 'rgba(15, 23, 42, 0.95)',
      backdropFilter: 'blur(16px)',
      WebkitBackdropFilter: 'blur(16px)',
      border: '1px solid rgba(255, 255, 255, 0.08)',
      borderRadius: '10px',
      boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.4)',
      color: '#f8fafc',
      padding: '10px 12px',
      fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: '12px',
      lineHeight: '1.5',
      pointerEvents: 'none',
      boxSizing: 'border-box',
      display: 'none'
    });
  }

  const posX = Math.max(10, Math.min(_lmtLastMouseX + 10, window.innerWidth - 270));
  const posY = Math.max(10, Math.min(_lmtLastMouseY + 14, window.innerHeight - 60));
  hint.style.left = posX + 'px';
  hint.style.top = posY + 'px';
  hint.textContent = '选区过长（超过 2000 字符），暂不支持翻译';
  hint.style.display = 'block';

  clearTimeout(hint._lmtHideTimer);
  hint._lmtHideTimer = setTimeout(() => {
    hint.style.display = 'none';
  }, 3000);
}

function _lmtShowTrigger(text, posX, posY) {
  let trigger = document.getElementById('lmt-trigger');
  if (!trigger) {
    trigger = document.createElement('button');
    trigger.id = 'lmt-trigger';
    // Apply all critical styles inline to avoid CSS conflicts
    _lmtApplyTriggerStyles(trigger);
    document.documentElement.appendChild(trigger);

    const img = document.createElement('img');
    img.src = chrome.runtime.getURL('icons/icon48.png');
    img.alt = 'Translate';
    Object.assign(img.style, {
      width: '16px', height: '16px', pointerEvents: 'none',
      display: 'block', margin: '0', padding: '0', border: 'none'
    });
    trigger.appendChild(img);
  }

  // Store text for dedup check
  trigger._lmtText = text;

  // Activation is dispatched via the __lmtOnEvent tap (see initSelectionTranslate).
  // A plain onclick would never fire on hostile pages whose capture-phase
  // handlers stopImmediatePropagation() before the event reaches this button.
  // The mousedown preventDefault (avoid collapsing the selection when pressing
  // the icon) is likewise handled centrally in the tap.
  trigger._lmtActivate = () => {
    if (!selectionTranslateEnabled) return;
    trigger.style.display = 'none';
    _lmtShowBubble(text, posX, posY);
  };

  trigger.style.left = posX + 'px';
  trigger.style.top = posY + 'px';
  trigger.style.display = 'flex';
}

function _lmtApplyTriggerStyles(el) {
  Object.assign(el.style, {
    all: 'initial',
    position: 'fixed',
    zIndex: '2147483647',
    width: '28px',
    height: '28px',
    background: 'rgba(30, 30, 45, 0.9)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    border: '1px solid rgba(255, 255, 255, 0.15)',
    borderRadius: '50%',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.25)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0',
    margin: '0',
    pointerEvents: 'auto',
    transition: 'transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), background-color 0.2s',
    boxSizing: 'border-box'
  });

  el.addEventListener('mouseenter', () => {
    el.style.transform = 'scale(1.1)';
    el.style.background = '#6366f1';
  });
  el.addEventListener('mouseleave', () => {
    el.style.transform = 'scale(1)';
    el.style.background = 'rgba(30, 30, 45, 0.9)';
  });
}

function _lmtShowBubble(text, posX, posY) {
  let bubble = document.getElementById('lmt-bubble');
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.id = 'lmt-bubble';
    document.documentElement.appendChild(bubble);
  }

  // Apply all styles inline
  Object.assign(bubble.style, {
    all: 'initial',
    position: 'fixed',
    zIndex: '2147483647',
    width: '300px',
    background: 'rgba(15, 23, 42, 0.95)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: '12px',
    boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.4), 0 8px 10px -6px rgba(0, 0, 0, 0.4)',
    color: '#f8fafc',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    pointerEvents: 'auto',
    boxSizing: 'border-box',
    fontSize: '13px',
    lineHeight: '1.5'
  });

  const dispText = text.length > 150 ? text.substring(0, 150) + '...' : text;

  bubble.innerHTML = `
    <div id="lmt-bubble-header" style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:rgba(255,255,255,0.03);border-bottom:1px solid rgba(255,255,255,0.06);cursor:move;user-select:none;pointer-events:auto;">
      <div style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:#94a3b8;pointer-events:none;">
        <img src="${chrome.runtime.getURL('icons/icon48.png')}" style="width:12px;height:12px;display:block;" alt="">
        <span>翻译结果</span>
      </div>
      <button id="lmt-bubble-close-btn" style="all:initial;cursor:pointer;color:#64748b;font-size:18px;line-height:1;padding:2px 4px;border-radius:4px;display:flex;align-items:center;justify-content:center;pointer-events:auto;">×</button>
    </div>
    <div style="padding:10px 12px;">
      <div style="color:#94a3b8;font-size:12px;padding-bottom:8px;border-bottom:1px dashed rgba(255,255,255,0.06);margin-bottom:8px;word-break:break-word;">${escapeHtml(dispText)}</div>
      <div id="lmt-bubble-loader" style="display:flex;align-items:center;gap:8px;color:#94a3b8;font-size:12px;">
        <div style="width:14px;height:14px;border:2px solid rgba(255,255,255,0.1);border-top-color:#6366f1;border-radius:50%;animation:lmt-spin 0.8s linear infinite;flex-shrink:0;"></div>
        <span>正在翻译中...</span>
      </div>
      <div id="lmt-bubble-trans" style="display:none;color:#f1f5f9;font-size:13px;line-height:1.6;word-break:break-word;"></div>
    </div>
    <div id="lmt-bubble-footer" style="display:none;gap:8px;padding:6px 12px;border-top:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.02);">
      <button id="lmt-speak-btn" title="朗读原文" style="all:initial;cursor:pointer;display:flex;align-items:center;gap:4px;color:#94a3b8;font-size:11px;padding:4px 8px;border-radius:4px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.03);pointer-events:auto;font-family:inherit;">
        <svg style="width:12px;height:12px;fill:currentColor" viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05A4.47 4.47 0 0 0 16.5 12zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
        朗读
      </button>
      <button id="lmt-copy-btn" style="all:initial;cursor:pointer;display:flex;align-items:center;gap:4px;color:#94a3b8;font-size:11px;padding:4px 8px;border-radius:4px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.03);pointer-events:auto;font-family:inherit;">
        <svg style="width:12px;height:12px;fill:currentColor" viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
        复制
      </button>
    </div>
  `;

  // Inject spin keyframe if not present
  if (!document.getElementById('lmt-spin-style')) {
    const style = document.createElement('style');
    style.id = 'lmt-spin-style';
    style.textContent = '@keyframes lmt-spin { to { transform: rotate(360deg); } }';
    document.documentElement.appendChild(style);
  }

  // Set up close button (activation routed through the event tap — see initSelectionTranslate)
  bubble.querySelector('#lmt-bubble-close-btn')._lmtActivate = () => {
    bubble.style.display = 'none';
  };

  // Speak the original selection with the browser's built-in TTS. Clicking
  // again cancels playback.
  const SPEAK_ICON = '<svg style="width:12px;height:12px;fill:currentColor" viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05A4.47 4.47 0 0 0 16.5 12zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg> 朗读';
  const STOP_ICON = '<svg style="width:12px;height:12px;fill:currentColor" viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg> 停止';
  const speakBtn = bubble.querySelector('#lmt-speak-btn');
  if (speakBtn) {
    speakBtn._lmtActivate = () => {
      const synth = window.speechSynthesis;
      if (!synth) return;
      if (synth.speaking || synth.pending) {
        synth.cancel();
        speakBtn.innerHTML = SPEAK_ICON;
        return;
      }
      try {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.onend = () => { speakBtn.innerHTML = SPEAK_ICON; };
        utterance.onerror = () => { speakBtn.innerHTML = SPEAK_ICON; };
        synth.speak(utterance);
        speakBtn.innerHTML = STOP_ICON;
      } catch (err) {
        console.debug('[LMT] speech synthesis failed:', err);
      }
    };
  }

  // Set up dragging
  const header = bubble.querySelector('#lmt-bubble-header');
  makeElementDraggable(bubble, header);

  // Position bubble near the trigger position
  const bubbleWidth = 300;
  let bx = posX - bubbleWidth / 2;
  let by = posY + 15;
  bx = Math.max(10, Math.min(bx, window.innerWidth - bubbleWidth - 10));
  if (by + 200 > window.innerHeight) {
    by = Math.max(10, posY - 220);
  }
  bubble.style.left = bx + 'px';
  bubble.style.top = by + 'px';

  // Do translation
  (async () => {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'TRANSLATE_BATCH',
        payload: { texts: [text] }
      });

      if (response && response.success && Array.isArray(response.translations)) {
        const transText = String(response.translations[0] ?? '');
        if (!transText.trim()) {
          throw new Error('翻译结果为空，请重试');
        }
        const loader = bubble.querySelector('#lmt-bubble-loader');
        const transField = bubble.querySelector('#lmt-bubble-trans');
        const footer = bubble.querySelector('#lmt-bubble-footer');

        if (loader) loader.style.display = 'none';
        if (transField) { transField.textContent = transText; transField.style.display = 'block'; }
        if (footer) footer.style.display = 'flex';

        const copyBtn = bubble.querySelector('#lmt-copy-btn');
        if (copyBtn) {
          copyBtn._lmtActivate = async () => {
            try {
              await navigator.clipboard.writeText(transText);
              copyBtn.innerHTML = `
                <svg style="width:12px;height:12px;fill:currentColor" viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                已复制
              `;
              setTimeout(() => {
                copyBtn.innerHTML = `
                  <svg style="width:12px;height:12px;fill:currentColor" viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
                  复制
                `;
              }, 2000);
            } catch (err) {
              console.error('Failed to copy:', err);
            }
          };
        }
      } else {
        throw new Error(response ? response.error : 'Unknown response');
      }
    } catch (err) {
      const loader = bubble.querySelector('#lmt-bubble-loader');
      if (loader) {
        loader.innerHTML = `<span style="color:#ef4444">翻译失败: ${err.message}</span>`;
      }
    }
  })();
}

// Bubble-header dragging, registered as a drag controller driven by the
// __lmtOnEvent tap (direct pointer listeners are dead on hostile pages).
// No setPointerCapture: it is meaningless across isolated worlds and the
// tap already sees every raw event.
function makeElementDraggable(element, handle) {
  let active = false;
  let startX = 0;
  let startY = 0;
  let initialLeft = 0;
  let initialTop = 0;

  _lmtDragControllers.add((type, e) => {
    if (type === 'down') {
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      if (!path.includes(handle)) return;
      if (e.target && e.target.closest && e.target.closest('#lmt-bubble-close-btn')) return;
      if (e.button !== undefined && e.button !== 0) return; // Primary pointer only
      active = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = element.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      if (e.cancelable) e.preventDefault(); // Avoid text selection while dragging
      return;
    }

    if (!active) return;

    if (type === 'move') {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      let newLeft = initialLeft + dx;
      let newTop = initialTop + dy;

      const rect = element.getBoundingClientRect();
      const minX = 10;
      const maxX = window.innerWidth - rect.width - 10;
      const minY = 10;
      const maxY = window.innerHeight - rect.height - 10;

      newLeft = Math.max(minX, Math.min(newLeft, maxX));
      newTop = Math.max(minY, Math.min(newTop, maxY));

      element.style.left = newLeft + 'px';
      element.style.top = newTop + 'px';
      return;
    }

    if (type === 'up' || type === 'cancel') {
      active = false;
    }
  });
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Auto-initialize on load.
// Selection translate is ALWAYS enabled (the user didn't ask to disable it);
// only the floating widget respects the per-domain ignore list. This prevents
// the trap where clicking the widget's × (which adds the domain to
// ignoredDomains) silently also kills selection translation on that site.
(async () => {
  const domain = window.location.hostname;
  const { ignoredDomains = [], translationStyle } = await chrome.storage.local.get(['ignoredDomains', 'translationStyle']);
  const showWidget = !ignoredDomains.includes(domain);

  const start = () => {
    // Only show full-page translation widget in the top-level window
    if (showWidget && window === window.top) {
      createFloatingButton();
    }
    initSelectionTranslate();
    setTranslationStyleClass(translationStyle);
  };

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    start();
  } else {
    window.addEventListener('DOMContentLoaded', start);
  }
})();

// Live-apply style changes from the popup without a reload.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.translationStyle) {
    setTranslationStyleClass(changes.translationStyle.newValue);
  }
});
