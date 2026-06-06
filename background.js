// Local LLM Web Translator - Service Worker

const DEFAULT_SETTINGS = {
  provider: 'lmstudio',
  apiUrl: 'http://localhost:1234/v1',
  modelName: 'current',
  apiKey: '',
  targetLang: 'zh',
  translationMode: 'dual',
  concurrency: 3,
  batchSize: 10
};

const LANGUAGE_MAP = {
  'zh': 'Chinese (Simplified)',
  'zh-tw': 'Chinese (Traditional)',
  'en': 'English',
  'ja': 'Japanese',
  'ko': 'Korean',
  'fr': 'French',
  'de': 'German',
  'es': 'Spanish',
  'ru': 'Russian',
  'it': 'Italian',
  'pt': 'Portuguese'
};

// Set default settings on install
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const toSet = {};
  for (const key in DEFAULT_SETTINGS) {
    if (existing[key] === undefined) {
      toSet[key] = DEFAULT_SETTINGS[key];
    }
  }
  if (Object.keys(toSet).length > 0) {
    await chrome.storage.local.set(toSet);
  }
  
  await setupDeclarativeRules();
});

// Set up rules on browser startup
chrome.runtime.onStartup.addListener(async () => {
  await setupDeclarativeRules();
});

// Message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CHECK_CONNECTION') {
    (async () => {
      try {
        const { apiUrl, apiKey } = message.payload;
        const res = await checkApiConnection(apiUrl, apiKey);
        sendResponse(res);
      } catch (err) {
        sendResponse({ connected: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.type === 'TRANSLATE_BATCH') {
    (async () => {
      try {
        const { texts } = message.payload;
        const settings = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
        const translations = await translateBatch(texts, settings);
        sendResponse({ success: true, translations });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
});

// Helper: check API connection and return models list
async function checkApiConnection(apiUrl, apiKey) {
  const cleanUrl = apiUrl.replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${cleanUrl}/models`, {
    method: 'GET',
    headers
  });

  if (!response.ok) {
    throw new Error(`Server returned status ${response.status}`);
  }

  const data = await response.json();
  const models = data.data || [];
  return { connected: true, models };
}

// Helper: translate a batch of texts using settings
async function translateBatch(texts, settings) {
  const { apiUrl, modelName, apiKey, targetLang } = settings;
  const targetLangFull = LANGUAGE_MAP[targetLang] || targetLang;

  const cleanUrl = apiUrl.replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  // Set the model ID correctly (omit model for LM Studio current loaded, or try to supply it if specified)
  let selectedModel = modelName;
  if (modelName === 'current') {
    // Attempt to query models list to find the first loaded model name,
    // which helps backends that require the model field to be non-empty (like Ollama or OpenAI)
    try {
      const conn = await checkApiConnection(apiUrl, apiKey);
      if (conn.models && conn.models.length > 0) {
        selectedModel = conn.models[0].id;
      } else {
        selectedModel = 'default';
      }
    } catch (e) {
      selectedModel = 'default';
    }
  }

  const systemPrompt = `You are a professional, accurate translation assistant. Translate the user's input JSON array of strings into ${targetLangFull}.
Return ONLY a valid JSON array of strings of exactly the same length and order, containing the translations.
For example, if input is ["Hello", "World"], return ["你好", "世界"].
Strict constraints:
- Return ONLY the JSON array.
- Do NOT wrap it in markdown block like \`\`\`json ... \`\`\`.
- Do NOT output any preamble, commentary, explanations, or numbering.
- Keep the original meaning and formatting (like punctuation or HTML tags inside texts) intact.`;

  const response = await fetch(`${cleanUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: selectedModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(texts) }
      ],
      temperature: 0.1
    })
  });

  if (!response.ok) {
    throw new Error(`LLM API returned status ${response.status}`);
  }

  const result = await response.json();
  if (!result.choices || result.choices.length === 0) {
    throw new Error('LLM API returned an empty choices list');
  }

  const responseText = result.choices[0].message.content;
  return parseLLMResponse(responseText, texts.length, texts, settings);
}

// Parse LLM response with multiple fallbacks
async function parseLLMResponse(rawText, expectedLength, originalTexts, settings) {
  let text = rawText.trim();

  // 1. Clean markdown code blocks if the model wrapped it
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  }

  // 2. Try direct JSON parsing
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.length === expectedLength) {
      return parsed;
    }
  } catch (e) {}

  // 3. Try to extract JSON array using RegExp
  try {
    const arrayMatch = text.match(/\[\s*([\s\S]*?)\s*\]/);
    if (arrayMatch) {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed) && parsed.length === expectedLength) {
        return parsed;
      }
    }
  } catch (e) {}

  // 4. Try parsing as a line-by-line list if LLM outputted bullet points or newlines
  const lines = text.split('\n')
    .map(line => {
      // Remove common list prefixes: "1. ", "- ", "* "
      return line.replace(/^(\d+\.\s*|[-*]\s*)/, '').trim().replace(/^"|"$/g, '');
    })
    .filter(line => line.length > 0);

  if (lines.length === expectedLength) {
    return lines;
  }

  // 5. Fallback: Translate individually (serial or parallel based on settings)
  console.warn(`Translation batch failed parsing matching length. Falling back to individual translation. Expected: ${expectedLength}, parsed lines: ${lines.length}`);
  return await translateIndividually(originalTexts, settings);
}

// Fallback method: translate each sentence one by one
async function translateIndividually(texts, settings) {
  const { apiUrl, modelName, apiKey, targetLang, concurrency = 3 } = settings;
  const targetLangFull = LANGUAGE_MAP[targetLang] || targetLang;
  const cleanUrl = apiUrl.replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  let selectedModel = modelName;
  if (modelName === 'current') {
    try {
      const conn = await checkApiConnection(apiUrl, apiKey);
      if (conn.models && conn.models.length > 0) {
        selectedModel = conn.models[0].id;
      } else {
        selectedModel = 'default';
      }
    } catch (e) {
      selectedModel = 'default';
    }
  }

  const results = new Array(texts.length);

  // Translate a single item
  const translateSingle = async (text, index) => {
    try {
      const response = await fetch(`${cleanUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: selectedModel,
          messages: [
            {
              role: 'system',
              content: `You are a professional, accurate translation assistant. Translate the user's text into ${targetLangFull}.
Return ONLY the direct translation. Do NOT add any preamble, explanations, numbering, or wrapping quotes.`
            },
            { role: 'user', content: text }
          ],
          temperature: 0.1
        })
      });

      if (!response.ok) throw new Error(`Status ${response.status}`);
      const result = await response.json();
      results[index] = result.choices[0].message.content.trim().replace(/^"|"$/g, '');
    } catch (err) {
      console.error(`Failed to translate item ${index}:`, err);
      results[index] = `[Translation Error: ${err.message}]`; // Fallback placeholder
    }
  };

  // Run translations with a concurrency limit
  const queue = [...texts.map((text, i) => ({ text, i }))];
  const workers = [];

  const runWorker = async () => {
    while (queue.length > 0) {
      const task = queue.shift();
      if (!task) break;
      await translateSingle(task.text, task.i);
    }
  };

  for (let i = 0; i < Math.min(concurrency, texts.length); i++) {
    workers.push(runWorker());
  }

  await Promise.all(workers);
  return results;
}

// Set up declarativeNetRequest rules to remove the Origin header for localhost/127.0.0.1 requests (bypasses Ollama/LM Studio CORS checks)
async function setupDeclarativeRules() {
  try {
    const rules = [
      {
        id: 1,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Origin', operation: 'remove' }
          ]
        },
        condition: {
          regexFilter: '^https?://(localhost|127\\.0\\.0\\.1)(:\\d+)?/',
          resourceTypes: ['xmlhttprequest']
        }
      }
    ];

    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const existingIds = existingRules.map(r => r.id);

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existingIds,
      addRules: rules
    });
    console.log('CORS bypass rules for local LLM set up successfully');
  } catch (err) {
    console.error('Failed to setup local CORS bypass rules:', err);
  }
}
