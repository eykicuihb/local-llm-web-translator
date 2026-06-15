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
      const container = document.getElementById('lmt-selection-container');
      if (container) {
        const trigger = container.shadowRoot.getElementById('lmt-trigger');
        if (trigger) trigger.style.display = 'none';
        const bubble = container.shadowRoot.getElementById('lmt-bubble');
        if (bubble) bubble.style.display = 'none';
      }
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

async function initSelectionTranslate() {
  const settings = await chrome.storage.local.get('selectionTranslateEnabled');
  selectionTranslateEnabled = settings.selectionTranslateEnabled !== false;

  document.addEventListener('mouseup', handleMouseUpSelection);
  document.addEventListener('mousedown', handleMouseDownSelection);
}

function handleMouseUpSelection(e) {
  if (!selectionTranslateEnabled) return;

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

    // Check if the click target is inside our selection container to avoid loop-closing the menu
    const container = document.getElementById('lmt-selection-container');
    if (container && e.composedPath().includes(container)) {
      return;
    }

    if (selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    if (rect.width === 0 || rect.height === 0) return;

    showTriggerButton(text, rect);
  }, 10);
}

function handleMouseDownSelection(e) {
  const container = document.getElementById('lmt-selection-container');
  if (container) {
    if (!e.composedPath().includes(container)) {
      const trigger = container.shadowRoot.getElementById('lmt-trigger');
      if (trigger) trigger.style.display = 'none';
      const bubble = container.shadowRoot.getElementById('lmt-bubble');
      if (bubble) bubble.style.display = 'none';
    }
  }
}

function showTriggerButton(text, rect) {
  let container = document.getElementById('lmt-selection-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'lmt-selection-container';
    container.style.position = 'absolute';
    container.style.zIndex = '2147483647';
    container.style.left = '0';
    container.style.top = '0';
    container.style.width = '0';
    container.style.height = '0';
    document.body.appendChild(container);

    const shadow = container.attachShadow({ mode: 'open' });
    
    const style = document.createElement('style');
    style.textContent = `
      :host {
        position: absolute;
        z-index: 2147483647;
        pointer-events: none;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .lmt-trigger-btn {
        pointer-events: auto;
        position: absolute;
        width: 28px;
        height: 28px;
        background: rgba(30, 30, 45, 0.9);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 50%;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), background-color 0.2s;
        padding: 0;
        margin: 0;
      }
      .lmt-trigger-btn:hover {
        transform: scale(1.1);
        background: #6366f1;
        border-color: rgba(255, 255, 255, 0.3);
      }
      .lmt-trigger-btn img {
        width: 16px;
        height: 16px;
        pointer-events: none;
      }
      .lmt-bubble-card {
        pointer-events: auto;
        position: absolute;
        width: 300px;
        background: rgba(15, 23, 42, 0.95);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 12px;
        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.4), 0 8px 10px -6px rgba(0, 0, 0, 0.4);
        color: #f8fafc;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        animation: lmt-bubble-in 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      }
      @keyframes lmt-bubble-in {
        from {
          opacity: 0;
          transform: translateY(8px) scale(0.95);
        }
        to {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }
      .lmt-bubble-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        background: rgba(255, 255, 255, 0.03);
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      }
      .lmt-bubble-title {
        font-size: 12px;
        font-weight: 600;
        color: #94a3b8;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .lmt-bubble-title img {
        width: 12px;
        height: 12px;
      }
      .lmt-bubble-close {
        background: none;
        border: none;
        color: #64748b;
        cursor: pointer;
        font-size: 16px;
        line-height: 1;
        padding: 2px 6px;
        border-radius: 4px;
        transition: color 0.2s, background-color 0.2s;
      }
      .lmt-bubble-close:hover {
        color: #f8fafc;
        background: rgba(255, 255, 255, 0.08);
      }
      .lmt-bubble-body {
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        max-height: 240px;
        overflow-y: auto;
      }
      .lmt-bubble-body::-webkit-scrollbar {
        width: 6px;
      }
      .lmt-bubble-body::-webkit-scrollbar-track {
        background: transparent;
      }
      .lmt-bubble-body::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.15);
        border-radius: 3px;
      }
      .lmt-source-text {
        font-size: 12px;
        color: #94a3b8;
        line-height: 1.4;
        border-left: 2px solid rgba(255, 255, 255, 0.1);
        padding-left: 6px;
        font-style: italic;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .lmt-translation-text {
        font-size: 13.5px;
        line-height: 1.5;
        color: #f1f5f9;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .lmt-bubble-loader {
        display: flex;
        align-items: center;
        gap: 8px;
        color: #6366f1;
        font-size: 12.5px;
        padding: 4px 0;
      }
      .lmt-spinner {
        width: 14px;
        height: 14px;
        border: 2px solid rgba(99, 102, 241, 0.2);
        border-top-color: #6366f1;
        border-radius: 50%;
        animation: lmt-spin-loader 0.8s linear infinite;
      }
      @keyframes lmt-spin-loader {
        to { transform: rotate(360deg); }
      }
      .lmt-bubble-footer {
        padding: 6px 12px;
        background: rgba(0, 0, 0, 0.15);
        border-top: 1px solid rgba(255, 255, 255, 0.04);
        display: flex;
        justify-content: flex-end;
      }
      .lmt-footer-btn {
        background: none;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 4px;
        color: #94a3b8;
        cursor: pointer;
        font-size: 11px;
        padding: 4px 8px;
        transition: all 0.2s;
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .lmt-footer-btn:hover {
        color: #f8fafc;
        border-color: rgba(255, 255, 255, 0.25);
        background: rgba(255, 255, 255, 0.05);
      }
      .lmt-footer-btn:active {
        transform: scale(0.97);
      }
    `;
    shadow.appendChild(style);
  }

  let trigger = container.shadowRoot.getElementById('lmt-trigger');
  if (!trigger) {
    trigger = document.createElement('button');
    trigger.id = 'lmt-trigger';
    trigger.className = 'lmt-trigger-btn';
    trigger.innerHTML = `<img src="${chrome.runtime.getURL('icons/icon48.png')}" alt="Translate">`;
    container.shadowRoot.appendChild(trigger);
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

  const triggerX = rect.right + window.scrollX - 5;
  const triggerY = rect.bottom + window.scrollY + 5;
  trigger.style.left = `${triggerX}px`;
  trigger.style.top = `${triggerY}px`;
  trigger.style.display = 'flex';
}

function showBubble(text, rect) {
  const container = document.getElementById('lmt-selection-container');
  if (!container) return;

  let bubble = container.shadowRoot.getElementById('lmt-bubble');
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.id = 'lmt-bubble';
    bubble.className = 'lmt-bubble-card';
    container.shadowRoot.appendChild(bubble);
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
  };

  const bubbleWidth = 300;
  let bubbleX = rect.left + window.scrollX + (rect.width - bubbleWidth) / 2;
  bubbleX = Math.max(10, Math.min(bubbleX, window.innerWidth - bubbleWidth - 20));

  let bubbleY = rect.bottom + window.scrollY + 10;
  bubble.style.left = `${bubbleX}px`;
  bubble.style.top = `${bubbleY}px`;
  bubble.style.display = 'flex';

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
