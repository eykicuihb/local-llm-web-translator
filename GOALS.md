# Goals — Review Remediation Checklist

Source: functional-completeness review + Standards/Spec two-axis review (2026-08).
Legend: [ ] todo · [x] done · [~] deferred with rationale

## A. Event architecture (hostile SPA correctness)
- [x] A1. document_start event tap (`content/events.js`) feeds all pointer handling (716af2c)
- [x] A2. Trigger/bubble buttons activate via `_lmtActivate` routed through the tap (716af2c)
- [x] A3. Fallback programmatic injection includes events.js (2bce59b)
- [x] A4. Floating widget click + drag routed through the tap (drag registry + `_lmtSuppressClick`)
- [x] A5. Bubble-header drag routed through the tap (same failure mode)
- [x] A6. contextmenu hide-trigger routed through the tap; drop direct listener

## B. Background service worker
- [x] B1. Extract duplicated model-resolution block into one helper (translateBatch / translateIndividually) (29ac82b)
- [x] B2. Memoize `'current'` model resolution (~60s) — currently one extra /models HTTP call per batch (29ac82b)
- [x] B3. Stop injecting `[Translation Error: …]` placeholder strings into the page DOM (29ac82b; empty-result bubble message finished in commit 3)

## C. Popup
- [x] C1. `loadedModels[0].id` breaks on string-typed model lists (badge shows "undefined") (c51594e)
- [x] C2. Stop auto-persisting resolved model name — it clobbers the `'current'` sentinel semantics (c51594e)
- [x] C3. Progress interleaving across frames (all_frames): aggregate per-frame totals instead of last-write-wins (c51594e)
- [x] C4. GET_PAGE_STATUS multi-frame race: scope status query to main frame (c51594e)
- [x] C5. Ignored-domains manager UI in settings drawer (close-× is currently irreversible)

## D. Content script hygiene
- [x] D1. Remove dead `_mouseDown` state (write-only since poll-guard removal)
- [x] D2. `_lmtProcessSelection` empty catch → `console.debug` (silent failures cost the whole debug saga)
- [x] D3. Share the path/contains hit-test between `hitOurUI` and `_lmtHideTriggerAndBubbleIfOutside`
- [x] D4. Oversize selection (>2000 chars) currently silent — show an explanatory hint bubble

## E. Docs
- [x] E1. README: file structure += events.js; document 划词翻译 + ignored-domains + how to re-enable a domain
- [x] E2. CHROMEWEBSTORE.md: permissions table += tabs / declarativeNetRequest; storage keys += ignoredDomains / loadedModels

## F. UX enhancements (immersive-translate parity, 2026-08-22)
Source: feature research against Immersive Translate; filtered for fit with local-LLM scope.
- [x] F1. Hover translate: press Ctrl while hovering a paragraph → translate just it (Ctrl+C/A untouched via alone-key detection; IME-safe)
- [x] F2. Selection bubble speak button — browser TTS reads the original selection, click again to stop
- [x] F3. Custom translation instructions (popup drawer) appended to both batch & individual LLM system prompts
- [x] F4. Input-box translate: three-space gesture swaps typed text for its translation (keydown-timing aware, snapshot-guarded)
- [x] F5. Global shortcut Alt+A toggles page translation (manifest commands + injection fallback in SW)
- [x] F6. Translation Style dropdown: solid border (default) / dashed underline / blur original (live-applied via storage.onChanged)
- [x] F7. Failed paragraphs surface as a ↻ badge on the widget; click retries them against current settings

## Deferred (documented, not fixed now)
- [~] N1. all_frames translates ad/tracking iframes too — needed for Claude.ai-artifact-style frames; filtering heuristics are fragile. Documented as limitation.
- [~] N2. Keyboard-only selections position the trigger at stale mouse coords. Minor UX.
- [~] N3. No _locales i18n; UI strings are hardcoded zh/en mix.
