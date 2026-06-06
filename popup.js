// Local LLM Web Translator - Popup Interactivity

document.addEventListener('DOMContentLoaded', async () => {
  // UI Elements - Main Control
  const translatePageBtn = document.getElementById('translate-page-btn');
  const showTranslationToggle = document.getElementById('translation-active-toggle');
  const targetLangSelect = document.getElementById('target-lang');
  const displayModeSelect = document.getElementById('display-mode');

  // UI Elements - Status Panel
  const connectionIndicator = document.getElementById('connection-indicator');
  const connectionText = document.getElementById('connection-text');
  const modelRow = document.getElementById('model-row');
  const modelNameDisplay = document.getElementById('model-name-display');

  // UI Elements - Drawer
  const settingsToggle = document.getElementById('settings-toggle');
  const settingsDrawer = document.getElementById('settings-drawer');
  const saveSettingsBtn = document.getElementById('save-settings-btn');

  // UI Elements - Settings Form
  const providerSelect = document.getElementById('provider-select');
  const apiUrlInput = document.getElementById('api-url');
  const apiKeyInput = document.getElementById('api-key');
  const modelSelect = document.getElementById('model-select');
  const batchSizeInput = document.getElementById('batch-size');
  const concurrencyInput = document.getElementById('concurrency');

  // UI Elements - Progress Tracking
  const progressCard = document.getElementById('progress-card');
  const progressStatusText = document.getElementById('progress-status-text');
  const progressCount = document.getElementById('progress-count');
  const progressBar = document.getElementById('progress-bar');

  // Current tab state
  let activeTab = null;

  // Initialize: Load Settings & Set Active Tab
  await initPopup();

  async function initPopup() {
    // 1. Get active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tab;

    // Check if the page is a system page or Chrome Web Store, which are blocked by Chrome security
    if (!activeTab || !activeTab.url || 
        activeTab.url.startsWith('chrome://') || 
        activeTab.url.startsWith('edge://') || 
        activeTab.url.startsWith('about:') ||
        activeTab.url.includes('chromewebstore.google.com') ||
        activeTab.url.includes('chrome.google.com/webstore')) {
      disableTranslationControls('This page cannot be translated');
      return;
    }

    // Reset controls to default enabled state
    translatePageBtn.disabled = false;
    translatePageBtn.textContent = 'Translate Page';
    translatePageBtn.classList.remove('secondary-color');
    showTranslationToggle.disabled = true;

    // 2. Load stored settings from storage
    const settings = await chrome.storage.local.get([
      'provider', 'apiUrl', 'modelName', 'apiKey', 'targetLang', 'translationMode', 'concurrency', 'batchSize'
    ]);

    // Apply values to UI
    providerSelect.value = settings.provider || 'lmstudio';
    apiUrlInput.value = settings.apiUrl || 'http://localhost:1234/v1';
    apiKeyInput.value = settings.apiKey || '';
    targetLangSelect.value = settings.targetLang || 'zh';
    displayModeSelect.value = settings.translationMode || 'dual';
    batchSizeInput.value = settings.batchSize || 10;
    concurrencyInput.value = settings.concurrency || 3;

    // 3. Check Connection & load models
    await checkLlmConnection(apiUrlInput.value, apiKeyInput.value, settings.modelName || 'current');

    // 4. Query current tab status
    await checkTabStatus();
  }

  // Disable translation controls for unsupported pages
  function disableTranslationControls(reason) {
    translatePageBtn.disabled = true;
    translatePageBtn.textContent = 'Translation Unavailable';
    translatePageBtn.classList.add('secondary-color');
    showTranslationToggle.disabled = true;
    connectionText.textContent = reason;
    connectionIndicator.className = 'dot disconnected';
  }

  // Check tab translation state and updates UI
  async function checkTabStatus() {
    if (!activeTab) return;
    try {
      const response = await chrome.tabs.sendMessage(activeTab.id, { type: 'GET_PAGE_STATUS' });
      if (response) {
        showTranslationToggle.disabled = false;
        showTranslationToggle.checked = true; // Visibility is on by default once translated

        if (response.active) {
          // If translation has already run
          translatePageBtn.disabled = true;
          translatePageBtn.textContent = 'Page Translated';
          progressCard.classList.remove('hidden');
          updateProgressUI(response.translated, response.total);
        }
      }
    } catch (err) {
      // Content script is not listening yet or injection failed (normal before translating)
      showTranslationToggle.disabled = true;
      showTranslationToggle.checked = false;
    }
  }

  // Test connection to the LLM server
  async function checkLlmConnection(apiUrl, apiKey, currentModel) {
    connectionText.textContent = 'Connecting...';
    connectionIndicator.className = 'dot';
    modelRow.classList.add('hidden');

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'CHECK_CONNECTION',
        payload: { apiUrl, apiKey }
      });

      if (response && response.connected) {
        connectionIndicator.className = 'dot connected';
        connectionText.textContent = 'Connected';

        // Populate model dropdown selector
        modelSelect.innerHTML = '<option value="current">Current Loaded Model</option>';
        if (response.models && response.models.length > 0) {
          response.models.forEach(model => {
            const modelId = typeof model === 'string' ? model : (model.id || model.name || '');
            if (modelId) {
              const opt = document.createElement('option');
              opt.value = modelId;
              opt.textContent = modelId;
              modelSelect.appendChild(opt);
            }
          });
        }
        
        // Select active model - if set to 'current' and we have models, auto-select the first model name
        let activeModel = currentModel || 'current';
        if (activeModel === 'current' && response.models && response.models.length > 0) {
          const firstModel = typeof response.models[0] === 'string' ? response.models[0] : (response.models[0].id || response.models[0].name);
          if (firstModel) {
            activeModel = firstModel;
            // Persist the auto-selected model
            await chrome.storage.local.set({ modelName: activeModel });
          }
        }
        modelSelect.value = activeModel;

        // Display current model badge in status
        modelRow.classList.remove('hidden');
        const activeModelName = modelSelect.value === 'current' 
          ? (response.models.length > 0 ? (typeof response.models[0] === 'string' ? response.models[0] : (response.models[0].id || response.models[0].name || 'current')) : 'current')
          : modelSelect.value;
        modelNameDisplay.textContent = activeModelName;
        
        // Save model list and connection success
        await chrome.storage.local.set({ loadedModels: response.models });
      } else {
        throw new Error(response ? response.error : 'Connection failed');
      }
    } catch (err) {
      connectionIndicator.className = 'dot disconnected';
      connectionText.textContent = 'Connection failed';
      console.error('Connection error:', err);
    }
  }

  // Update Progress Tracker UI
  function updateProgressUI(translated, total) {
    progressCount.textContent = `${translated}/${total}`;
    const percent = total > 0 ? Math.min(100, Math.round((translated / total) * 100)) : 0;
    progressBar.style.width = `${percent}%`;

    if (translated >= total && total > 0) {
      progressStatusText.textContent = 'Translation Complete';
      translatePageBtn.textContent = 'Page Translated';
      translatePageBtn.disabled = true;
    } else {
      progressStatusText.textContent = 'Translating page content...';
    }
  }

  // --- Event Bindings ---

  // Settings drawer toggle
  settingsToggle.addEventListener('click', () => {
    settingsDrawer.classList.toggle('hidden');
  });

  // Settings Save & Connect click
  saveSettingsBtn.addEventListener('click', async () => {
    const settings = {
      provider: providerSelect.value,
      apiUrl: apiUrlInput.value.trim(),
      apiKey: apiKeyInput.value.trim(),
      batchSize: parseInt(batchSizeInput.value, 10) || 10,
      concurrency: parseInt(concurrencyInput.value, 10) || 3
    };

    await chrome.storage.local.set(settings);
    settingsDrawer.classList.add('hidden');
    
    // Retrieve currently selected model from the main dropdown
    const storedModel = modelSelect.value;
    await checkLlmConnection(settings.apiUrl, settings.apiKey, storedModel);
  });

  // Provider selection change: automatically update API URL, save settings, and test connection to load models
  providerSelect.addEventListener('change', async () => {
    const val = providerSelect.value;
    if (val === 'lmstudio') {
      apiUrlInput.value = 'http://localhost:1234/v1';
    } else if (val === 'ollama') {
      apiUrlInput.value = 'http://localhost:11434/v1';
    }

    // Auto-save the provider and URL immediately to keep it in sync
    await chrome.storage.local.set({
      provider: val,
      apiUrl: apiUrlInput.value.trim()
    });

    // Auto-fetch models and check connectivity for the new provider
    await checkLlmConnection(apiUrlInput.value, apiKeyInput.value, 'current');
  });

  // Model selection change
  modelSelect.addEventListener('change', async () => {
    const val = modelSelect.value;
    await chrome.storage.local.set({ modelName: val });

    // Update model badge display
    if (val === 'current') {
      const response = await chrome.storage.local.get('loadedModels');
      const loadedModels = response.loadedModels || [];
      modelNameDisplay.textContent = loadedModels.length > 0 ? loadedModels[0].id : 'current';
    } else {
      modelNameDisplay.textContent = val;
    }
  });

  // Target Language dropdown change
  targetLangSelect.addEventListener('change', async () => {
    const val = targetLangSelect.value;
    await chrome.storage.local.set({ targetLang: val });
  });

  // Display Mode dropdown change
  displayModeSelect.addEventListener('change', async () => {
    const val = displayModeSelect.value;
    await chrome.storage.local.set({ translationMode: val });

    if (activeTab) {
      try {
        await chrome.tabs.sendMessage(activeTab.id, {
          type: 'SET_MODE',
          payload: { mode: val }
        });
      } catch (err) {
        // Content script might not be loaded yet
      }
    }
  });

  // Manual Trigger "Translate Page" Click
  translatePageBtn.addEventListener('click', async () => {
    if (!activeTab) return;

    translatePageBtn.disabled = true;
    translatePageBtn.textContent = 'Translating...';
    progressCard.classList.remove('hidden');
    updateProgressUI(0, 0);

    try {
      // Try to send translation start command
      await chrome.tabs.sendMessage(activeTab.id, { type: 'START_TRANSLATION' });
      showTranslationToggle.disabled = false;
      showTranslationToggle.checked = true;
    } catch (err) {
      console.warn('Content script not active, attempting programmatic injection:', err);
      try {
        // Inject content.css first
        await chrome.scripting.insertCSS({
          target: { tabId: activeTab.id },
          files: ['content/content.css']
        });
        // Inject content.js next
        await chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          files: ['content/content.js']
        });

        // Small delay to let content script initialize listeners
        await new Promise(resolve => setTimeout(resolve, 120));

        // Retry sending the message
        await chrome.tabs.sendMessage(activeTab.id, { type: 'START_TRANSLATION' });
        showTranslationToggle.disabled = false;
        showTranslationToggle.checked = true;
      } catch (injectErr) {
        console.error('Programmatic injection failed:', injectErr);
        disableTranslationControls('Injected script failed to load');
      }
    }
  });

  // Visibility toggle click
  showTranslationToggle.addEventListener('change', async () => {
    if (!activeTab) return;
    const isChecked = showTranslationToggle.checked;
    try {
      await chrome.tabs.sendMessage(activeTab.id, {
        type: 'TOGGLE_VISIBILITY',
        payload: { visible: isChecked }
      });
    } catch (err) {
      console.error('Failed to toggle translation visibility:', err);
    }
  });

  // Listen for translation progress updates from the content script
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message.type === 'TRANSLATION_PROGRESS' && activeTab && sender.tab && sender.tab.id === activeTab.id) {
      progressCard.classList.remove('hidden');
      updateProgressUI(message.payload.translated, message.payload.total);
    }
  });
});
