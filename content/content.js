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
  if (node.tagName.toUpperCase() === 'CODE' || node.closest('code')) {
    return true;
  }
  if (node.querySelector('code')) {
    return true;
  }
  const className = node.className;
  if (typeof className === 'string') {
    const classes = className.toLowerCase();
    if (
      classes.includes('code') ||
      classes.includes('syntax') ||
      classes.includes('prettyprint') ||
      classes.includes('highlight') ||
      classes.includes('prism') ||
      classes.includes('hljs')
    ) {
      return true;
    }
  }
  return false;
}

// Determine if an element is a translation candidate
function isTranslationCandidate(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;

  const tagName = node.tagName.toUpperCase();

  // Skip script, style, and interactive tags
  if ([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'CANVAS', 'SVG', 'CODE',
    'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'HEAD', 'NAV', 'FOOTER', 'NOSCRIPT'
  ].includes(tagName)) {
    return false;
  }

  // If PRE, only skip if it's a code block
  if (tagName === 'PRE' && isCodeBlock(node)) {
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

    if (tagName === 'PRE' && isCodeBlock(node)) {
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
            const translationText = translations[i] || '';

            if (translationText && translationText.trim().length > 0) {
              injectTranslation(el, translationText);
              el.setAttribute('data-lmt-translated', 'true');
            } else {
              el.removeAttribute('data-lmt-translated');
            }
          }
          resolve();
        });
      });

      translatedCount += elements.length;
      sendProgressUpdate();
    } else {
      throw new Error(response ? response.error : 'Unknown response error');
    }
  } catch (err) {
    console.error('Batch translation error:', err);
    // Reset attribute so elements can be retried
    elements.forEach(el => el.removeAttribute('data-lmt-translated'));
  }
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
    } else {
      document.body.classList.add('lmt-hide-translations');
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

  // Bind click event
  widget.addEventListener('click', async (e) => {
    // Hide widget if close button is clicked
    if (e.target.classList.contains('lmt-close-widget')) {
      e.stopPropagation();
      widget.classList.add('lmt-hidden-widget');
      
      const domain = window.location.hostname;
      const { ignoredDomains = [] } = await chrome.storage.local.get('ignoredDomains');
      if (!ignoredDomains.includes(domain)) {
        ignoredDomains.push(domain);
        await chrome.storage.local.set({ ignoredDomains });
      }
      return;
    }

    // Toggle or start translation
    if (!isTranslationActive) {
      await startTranslation();
    } else {
      const isHidden = document.body.classList.contains('lmt-hide-translations');
      if (isHidden) {
        document.body.classList.remove('lmt-hide-translations');
      } else {
        document.body.classList.add('lmt-hide-translations');
      }
      updateWidgetState();
    }
  });

  // Enable vertical dragging
  setupDrag(widget);
  
  // Initialize widget visual state
  updateWidgetState();
}

// Enable dragging on the floating widget
function setupDrag(el) {
  let isDragging = false;
  let startY = 0;
  let startTop = 0;
  let hasDragged = false;

  el.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('lmt-close-widget')) return;
    isDragging = true;
    hasDragged = false;
    startY = e.clientY;
    startTop = el.offsetTop;
    el.style.transition = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  function onMouseMove(e) {
    if (!isDragging) return;
    const deltaY = e.clientY - startY;
    if (Math.abs(deltaY) > 5) {
      hasDragged = true;
    }
    let newTop = startTop + deltaY;
    const maxTop = window.innerHeight - el.offsetHeight - 20;
    newTop = Math.max(20, Math.min(newTop, maxTop));
    el.style.top = `${newTop}px`;
    el.style.bottom = 'auto';
  }

  function onMouseUp(e) {
    isDragging = false;
    el.style.transition = 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)';
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);

    // If dragged, prevent trigger click behavior
    if (hasDragged) {
      const captureClick = (clickEvent) => {
        clickEvent.stopPropagation();
        el.removeEventListener('click', captureClick, true);
      };
      el.addEventListener('click', captureClick, true);
    }
  }

  // Mobile Touch Support
  el.addEventListener('touchstart', (e) => {
    if (e.target.classList.contains('lmt-close-widget')) return;
    isDragging = true;
    hasDragged = false;
    startY = e.touches[0].clientY;
    startTop = el.offsetTop;
    el.style.transition = 'none';
  });

  el.addEventListener('touchmove', (e) => {
    if (!isDragging) return;
    const deltaY = e.touches[0].clientY - startY;
    if (Math.abs(deltaY) > 5) {
      hasDragged = true;
    }
    let newTop = startTop + deltaY;
    const maxTop = window.innerHeight - el.offsetHeight - 20;
    newTop = Math.max(20, Math.min(newTop, maxTop));
    el.style.top = `${newTop}px`;
    el.style.bottom = 'auto';
  });

  el.addEventListener('touchend', () => {
    isDragging = false;
    el.style.transition = 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)';
  });
}

// --- Selection Translation Logic ---
let selectionTranslateEnabled = true;
let _lmtLastMouseX = 0;
let _lmtLastMouseY = 0;

async function initSelectionTranslate() {
  const settings = await chrome.storage.local.get('selectionTranslateEnabled');
  selectionTranslateEnabled = settings.selectionTranslateEnabled !== false;

  // Track mouse position at all times (capture phase to see all events)
  const trackMouse = (e) => {
    _lmtLastMouseX = e.clientX;
    _lmtLastMouseY = e.clientY;
  };
  document.addEventListener('mousemove', trackMouse, true);
  document.addEventListener('pointermove', trackMouse, true);

  // Track mouse button state for polling
  let _mouseDown = false;
  document.addEventListener('mousedown', (e) => {
    _mouseDown = true;
    _lmtHideTriggerAndBubbleIfOutside(e);
  }, true);
  document.addEventListener('pointerdown', (e) => {
    _mouseDown = true;
    _lmtHideTriggerAndBubbleIfOutside(e);
  }, true);
  document.addEventListener('mouseup', () => { _mouseDown = false; }, true);
  document.addEventListener('pointerup', () => { _mouseDown = false; }, true);
  window.addEventListener('mouseup', () => { _mouseDown = false; }, true);
  window.addEventListener('pointerup', () => { _mouseDown = false; }, true);

  // Event-based detection (works on most sites)
  let _selTimer = null;
  const onUp = (e) => {
    if (!selectionTranslateEnabled) return;
    _lmtLastMouseX = e.clientX;
    _lmtLastMouseY = e.clientY;
    _mouseDown = false;
    // Don't re-trigger selection if the user clicked on our own UI
    const t = document.getElementById('lmt-trigger');
    const b = document.getElementById('lmt-bubble');
    if ((t && t.contains(e.target)) || (b && b.contains(e.target))) return;
    clearTimeout(_selTimer);
    _selTimer = setTimeout(() => _lmtProcessSelection(), 40);
  };
  document.addEventListener('mouseup', onUp, true);
  window.addEventListener('mouseup', onUp, true);
  document.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointerup', onUp, true);

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
  // by _pollLastText below — we deliberately do NOT guard on _mouseDown, because
  // if the site blocks mouseup (but not mousedown), _mouseDown gets stuck true
  // forever and this poll would never run, re-breaking GitHub.
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

function _lmtHideTriggerAndBubbleIfOutside(e) {
  const trigger = document.getElementById('lmt-trigger');
  const bubble = document.getElementById('lmt-bubble');
  const path = e.composedPath ? e.composedPath() : [];

  const inTrigger = trigger && (path.includes(trigger) || trigger.contains(e.target));
  const inBubble = bubble && (path.includes(bubble) || bubble.contains(e.target));

  if (!inTrigger && trigger) trigger.style.display = 'none';
  if (!inBubble && bubble) bubble.style.display = 'none';
}

let _lmtLastProcessedText = '';
let _lmtLastProcessedTime = 0;

function _lmtProcessSelection() {
  try {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const text = selection.toString().trim();

    if (!text || text.length < 2 || text.length > 2000) return;
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
    // Silently ignore to prevent breaking the page
  }
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

  trigger.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); };
  trigger.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
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
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:rgba(255,255,255,0.03);border-bottom:1px solid rgba(255,255,255,0.06);">
      <div style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:#94a3b8;">
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
    <div id="lmt-bubble-footer" style="display:none;padding:6px 12px;border-top:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.02);">
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

  bubble.querySelector('#lmt-bubble-close-btn').onclick = (e) => {
    e.preventDefault(); e.stopPropagation();
    bubble.style.display = 'none';
  };

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

      if (response && response.success && response.translations && response.translations[0]) {
        const transText = response.translations[0];
        const loader = bubble.querySelector('#lmt-bubble-loader');
        const transField = bubble.querySelector('#lmt-bubble-trans');
        const footer = bubble.querySelector('#lmt-bubble-footer');

        if (loader) loader.style.display = 'none';
        if (transField) { transField.textContent = transText; transField.style.display = 'block'; }
        if (footer) footer.style.display = 'flex';

        const copyBtn = bubble.querySelector('#lmt-copy-btn');
        if (copyBtn) {
          copyBtn.onclick = async (e) => {
            e.preventDefault(); e.stopPropagation();
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
  const { ignoredDomains = [] } = await chrome.storage.local.get('ignoredDomains');
  const showWidget = !ignoredDomains.includes(domain);

  const start = () => {
    if (showWidget) createFloatingButton();
    initSelectionTranslate();
  };

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    start();
  } else {
    window.addEventListener('DOMContentLoaded', start);
  }
})();
