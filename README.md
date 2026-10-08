# WebMCP Translator Kit (`@gyga-browser/webmcp-translator-kit`)

MVP Direct-mode translator kit and browser extension (no Gateway). Provides frozen direct-mode contracts, schemas, defaults, and the unpacked Chrome extension calling OpenAI-compatible endpoints directly.

The extension requests streaming translations. When the configured endpoint returns SSE, it applies completed translated passages as they arrive; endpoints returning a regular JSON response continue to work. Streaming availability depends on the selected endpoint and model.

Chrome Web Store preparation: [readiness audit and fix plan](docs/chrome-web-store-readiness-2026-10-01.md) · [listing copy, Privacy fields, reviewer instructions, and screenshot requirements](docs/chrome-web-store-submission-content-2026-10-01.md).

## Layout

```
.
├── contract/
│   ├── defaults.json       # Frozen runtime defaults and limits
│   ├── direct-interface.md # Direct-mode protocol specification
│   ├── lifecycle.md        # State machine & lifecycle specification
│   ├── schemas/            # JSON schemas for batch translation and errors
│   ├── check.mjs           # Contract verification suite
│   └── index.mjs           # Contract package exports
├── extension/
│   ├── src/                # Chrome extension source files
│   └── dist/               # Built unpacked extension (git-ignored)
├── scripts/
│   ├── build.mjs           # Build script: copies src -> dist, syncs version
│   └── check-closure.mjs   # Packaging and tarball closure verification
├── test/
│   └── placeholder.test.mjs
└── package.json
```

## Scripts

- `npm run build`: Cleans and compiles `extension/src` into `extension/dist`, stamping the manifest version.
- `npm run check:contract`: Runs zero-dependency contract validation (prints `CONTRACT_OK`).
- `npm test`: Runs test suite (`node --test test/`).
- `npm run check:closure`: Verifies tarball packaging closure and export integrity (prints `CLOSURE_OK`).

## Dev Install

1. Build the extension:
   ```bash
   npm run build
   ```
2. Load in Chrome:
   - **Manual**: Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `extension/dist/` directory.
   - **Chrome for Testing / CLI**:
     ```bash
     google-chrome --load-extension=$(pwd)/extension/dist
     ```
