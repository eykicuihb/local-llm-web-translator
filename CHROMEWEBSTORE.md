# Chrome Web Store Listing — Local LLM Web Translator

> Last Updated: 2026-06-06

## Store Listing

**Extension Name** [REQUIRED]
Local LLM Web Translator

**Short Description** [REQUIRED]
Translate web pages in-place using your local LM Studio, Ollama, or OpenAI-compatible model.

**Detailed Description** [REQUIRED]
Local LLM Web Translator is a premium, privacy-first browser extension that translates web pages in-place, displaying dual-language content. It connects directly to your locally running LLM server (like LM Studio, Ollama, vLLM, or LocalAI) or any OpenAI-compatible API to perform fast, offline translation of text blocks.

Key Features:
- Dual-Language Display: Keeps original text on the page and appends translations below it for seamless reading.
- Privacy-First: All translations are processed 100% locally on your machine. No text is sent to third-party tracking services.
- Auto-Translate Infinite Scroll: Monitors dynamic pages (SPAs) and automatically translates new content as you scroll.
- Flexible Backend Options: Works with LM Studio, Ollama, or any custom API endpoint with optional API keys.
- Real-Time Progress: Displays live translation statistics and progress inside a sleek popup interface.

How to Use:
1. Start your local LLM server (e.g. LM Studio local server running on http://localhost:1234/v1).
2. Open the extension popup and configure the API URL and Model Name under Advanced Settings.
3. Click "Translate Page" on any web page.
4. Toggle "Show Translation" or select the display mode (Dual Language or Translation Only).

**Category** [REQUIRED]
Productivity

**Single Purpose** [REQUIRED]
Translates web pages in-place by connecting to the user's local or custom LLM server.

**Primary Language** [REQUIRED]
English

---

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | ⬜ Not created | |
| Screenshot 1 [REQUIRED] | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 2 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 3 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Not created | |
| Small Promo Tile [RECOMMENDED] | 440×280 | ⬜ Not created | |

### Screenshot Notes
- **Screenshot 1**: In-place dual-language translation active on a news site, showing original and translated text side-by-side.
- **Screenshot 2**: The extension popup panel, displaying a green connection badge, active model name, and progress bar.
- **Screenshot 3**: The Advanced Settings drawer, displaying custom API URL, model selection list, and batch/concurrency configuration.

---

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `storage` | permissions | Required to save and persist the user's translation settings (API URL, model choice, target language, display mode, concurrency, and batch sizes) across browser sessions. |
| `activeTab` | permissions | Grants temporary security clearance to inject the translation scripting actions only when the user explicitly triggers translation on the current page. |
| `scripting` | permissions | Required to programmatically execute the translation DOM content scripts and inject self-adaptive styles inside the webpage context. |
| `http://localhost/*`<br>`http://127.0.0.1/*` | host_permissions | Required to connect to and fetch translations from local LLM servers (like LM Studio or Ollama) running on the user's machine, bypassing CORS restrictions. |
| `https://*/*`<br>`http://*/*` | host_permissions | Required to translate webpages on any website the user visits, and to optionally support remote custom OpenAI-compatible cloud endpoints. |

---

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** No

All translations are sent directly from your browser to your locally configured server (e.g. `http://localhost:1234`). No data is collected, stored, or transmitted to any external tracking or advertising server.

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

---

## Privacy Policy

**Privacy Policy URL** [RECOMMENDED]
https://github.com/yourusername/local-llm-web-translator/blob/main/PRIVACY.md

---

## Distribution

**Visibility**: Public
**Regions**: All regions
**Pricing**: Free

---

## Developer Info

**Publisher Name** [REQUIRED]
Local LLM Translator Developer

**Contact Email** [REQUIRED]
developer@example.com

**Support URL / Email** [RECOMMENDED]
https://github.com/yourusername/local-llm-web-translator/issues

---

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 1.0.0 | 2026-06-06 | Initial Release with Manifest V3 support, batch translation, and LM Studio connectivity. | Draft |

---

## Review Notes

### Known Issues / Limitations
- Relies on a local API server being active. If the user's local server is offline, translation will fail with a connection error.
- Very small models (e.g., < 3B parameters) may occasionally output non-standard JSON formats. The extension implements robust multi-layered parsing regex and individual fallbacks to mitigate this.
