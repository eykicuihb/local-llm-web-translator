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
// Track current selection state for scroll repositioning
let _lmtActiveText = null;
let _lmtScrollHideTimer = null;

async function initSelectionTranslate() {
  const settings = await chrome.storage.local.get('selectionTranslateEnabled');
  selectionTranslateEnabled = settings.selectionTranslateEnabled !== false;

  // Use capture phase (3rd arg = true) so we see the event even if the page
  // calls stopPropagation (e.g. GitHub, X/Twitter)
  document.addEventListener('mouseup', handleMouseUpSelection, true);
  document.addEventListener('mousedown', handleMouseDownSelection, true);
}

function handleMouseUpSelection(e) {
  if (!selectionTranslateEnabled) return;

  // Capture event path and target synchronously before setTimeout
  const target = e.target;
  const path = e.composedPath ? e.composedPath() : [];

  // Let the selection finalize in browser layout
  setTimeout(() => {
    const selection = window.getSelection();
    if (!selection) return;
    const text = selection.toString().trim();

    if (!text || text.length < 2 || text.length > 2000) {
      return;
    }

    if (/^[\d\s\p{P}]+$/u.test(text)) {
      return;
    }

    // Check if the click target is inside our trigger/bubble to avoid re-triggering
    const trigger = document.getElementById('lmt-trigger');
    const bubble = document.getElementById('lmt-bubble');
    if (trigger && (path.includes(trigger) || trigger.contains(target))) return;
    if (bubble && (path.includes(bubble) || bubble.contains(target))) return;

    if (selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    // rect is in viewport coords; width/height === 0 means collapsed selection
    if (rect.width === 0 && rect.height === 0) return;

    showTriggerButton(text, rect);
  }, 10);
}

function handleMouseDownSelection(e) {
  const trigger = document.getElementById('lmt-trigger');
  const bubble = document.getElementById('lmt-bubble');
  const path = e.composedPath ? e.composedPath() : [];

  const clickedInsideTrigger = trigger && (path.includes(trigger) || trigger.contains(e.target));
  const clickedInsideBubble = bubble && (path.includes(bubble) || bubble.contains(e.target));

  if (!clickedInsideTrigger && trigger) {
    trigger.style.display = 'none';
  }
  if (!clickedInsideBubble && bubble) {
    bubble.style.display = 'none';
  }
  if (!clickedInsideTrigger && !clickedInsideBubble) {
    _lmtActiveText = null;
  }
}

function _ensureSelectionContainer() {
  let container = document.getElementById('lmt-selection-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'lmt-selection-container';
    // Append to <html> instead of <body> to avoid body-level CSS transforms
    // that can break fixed positioning on some sites
    (document.documentElement || document.body).appendChild(container);
  }
  return container;
}

function showTriggerButton(text, rect) {
  const container = _ensureSelectionContainer();

  let trigger = document.getElementById('lmt-trigger');
  if (!trigger) {
    trigger = document.createElement('button');
    trigger.id = 'lmt-trigger';
    trigger.className = 'lmt-trigger-btn';
    trigger.innerHTML = `<img src="${chrome.runtime.getURL('icons/icon48.png')}" alt="Translate">`;
    container.appendChild(trigger);
  }

  trigger.onmousedown = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  trigger.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    trigger.style.display = 'none';
    showBubble(text, rect);
  };

  // rect is already in viewport coords — use them directly with position:fixed
  const triggerX = Math.min(rect.right - 5, window.innerWidth - 40);
  const triggerY = Math.min(rect.bottom + 5, window.innerHeight - 40);
  trigger.style.left = `${triggerX}px`;
  trigger.style.top = `${triggerY}px`;
  trigger.style.display = 'flex';

  _lmtActiveText = text;
}

function showBubble(text, rect) {
  const container = _ensureSelectionContainer();

  let bubble = document.getElementById('lmt-bubble');
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.id = 'lmt-bubble';
    bubble.className = 'lmt-bubble-card';
    container.appendChild(bubble);
  }

  const dispText = text.length > 150 ? text.substring(0, 150) + '...' : text;

  bubble.innerHTML = `
    <div class="lmt-bubble-header">
      <div class="lmt-bubble-title">
        <img src="${chrome.runtime.getURL('icons/icon48.png')}" alt="">
        <span>翻译结果</span>
      </div>
      <button class="lmt-bubble-close">×</button>
    </div>
    <div class="lmt-bubble-body">
      <div class="lmt-source-text">${escapeHtml(dispText)}</div>
      <div class="lmt-bubble-loader">
        <div class="lmt-spinner"></div>
        <span>正在翻译中...</span>
      </div>
      <div class="lmt-translation-text" style="display:none;"></div>
    </div>
    <div class="lmt-bubble-footer" style="display:none;">
      <button class="lmt-footer-btn lmt-copy-btn">
        <svg style="width:12px;height:12px;fill:currentColor" viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
        复制
      </button>
    </div>
  `;

  bubble.querySelector('.lmt-bubble-close').onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    bubble.style.display = 'none';
    _lmtActiveText = null;
  };

  // Position the bubble in viewport coords (position:fixed)
  const bubbleWidth = 300;
  let bubbleX = rect.left + (rect.width - bubbleWidth) / 2;
  bubbleX = Math.max(10, Math.min(bubbleX, window.innerWidth - bubbleWidth - 10));

  let bubbleY = rect.bottom + 10;
  // If the bubble would overflow the bottom, show it above the selection
  if (bubbleY + 200 > window.innerHeight) {
    bubbleY = Math.max(10, rect.top - 210);
  }
  bubble.style.left = `${bubbleX}px`;
  bubble.style.top = `${bubbleY}px`;
  bubble.style.display = 'flex';

  _lmtActiveText = text;

  (async () => {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'TRANSLATE_BATCH',
        payload: { texts: [text] }
      });

      if (response && response.success && response.translations && response.translations[0]) {
        const transText = response.translations[0];
        const loader = bubble.querySelector('.lmt-bubble-loader');
        const transField = bubble.querySelector('.lmt-translation-text');
        const footer = bubble.querySelector('.lmt-bubble-footer');

        loader.style.display = 'none';
        transField.textContent = transText;
        transField.style.display = 'block';
        footer.style.display = 'flex';

        bubble.querySelector('.lmt-copy-btn').onclick = async (e) => {
          e.preventDefault();
          e.stopPropagation();
          try {
            await navigator.clipboard.writeText(transText);
            const btn = bubble.querySelector('.lmt-copy-btn');
            btn.innerHTML = `
              <svg style="width:12px;height:12px;fill:currentColor" viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
              已复制
            `;
            setTimeout(() => {
              btn.innerHTML = `
                <svg style="width:12px;height:12px;fill:currentColor" viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
                复制
              `;
            }, 2000);
          } catch (err) {
            console.error('Failed to copy text:', err);
          }
        };
      } else {
        throw new Error(response ? response.error : 'Unknown response');
      }
    } catch (err) {
      const loader = bubble.querySelector('.lmt-bubble-loader');
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

// Auto-initialize widget on load
(async () => {
  const domain = window.location.hostname;
  const { ignoredDomains = [] } = await chrome.storage.local.get('ignoredDomains');
  
  if (!ignoredDomains.includes(domain)) {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      createFloatingButton();
      initSelectionTranslate();
    } else {
      window.addEventListener('DOMContentLoaded', () => {
        createFloatingButton();
        initSelectionTranslate();
      });
    }
  }
})();
