// Local LLM Web Translator - Content Script

const BLOCK_TAGS = new Set([
  'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE',
  'TD', 'TH', 'DIV', 'SECTION', 'ARTICLE'
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

// Determine if an element is a translation candidate
function isTranslationCandidate(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;

  const tagName = node.tagName.toUpperCase();

  // Skip script, style, and interactive tags
  if ([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'CANVAS', 'SVG', 'PRE', 'CODE',
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
      'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'CANVAS', 'SVG', 'PRE', 'CODE',
      'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'HEAD'
    ].includes(tagName)) {
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

// Auto-initialize widget on load
(async () => {
  const domain = window.location.hostname;
  const { ignoredDomains = [] } = await chrome.storage.local.get('ignoredDomains');
  
  if (!ignoredDomains.includes(domain)) {
    // Wait for DOM to load fully before creating button
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      createFloatingButton();
    } else {
      window.addEventListener('DOMContentLoaded', createFloatingButton);
    }
  }
})();
