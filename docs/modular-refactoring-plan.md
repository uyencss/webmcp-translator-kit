# Plan: Modular Refactoring Architecture for WebMCP Translator Kit

**Target Package**: `@gyga-browser/webmcp-translator-kit` (`packages/webmcp-translator-kit`)  
**Author / Orchestrator**: Antigravity Coordinator  
**Baseline Git Commit**: `6b71c04` (Clean working tree)  
**Verification Target**: 409/409 unit/integration tests passing, `CONTRACT_OK`, `CLOSURE_OK`, clean Chrome Web Store dist build  
**Review Gates**: 
1. Contributor Pre-acceptance Review (L1): Muse 1.3 Contributor (`opencode-go/muse-spark-1.3-contributor`, `xhigh`)
2. Final Acceptance Gate (L2): Codex Sol 6.1 (`gpt-6-sol`, reasoning `high`)

---

## 1. Executive Summary & Problem Statement

Hiện tại, codebase của extension đang tập trung trong 6 tệp đơn khối (monolithic files) với tổng cộng **19,173 dòng code**:

| Tệp nguồn | Số dòng baseline | Số dòng as-built | Module mới tương ứng | Trách nhiệm chính sau refactor |
|---|---|---|---|---|
| `extension/src/i18n.mjs` | **2,159** | **51** | 7 files trong `locales/*.mjs` | Aggregator gọn nhẹ, nạp từ điển modular |
| `extension/src/i18n-globals.js` | **2,157** | Auto-sync | Tạo tự động từ `locales/` | Không cần duy trì thủ công, sync qua script |
| `extension/src/popup.css` | **2,627** | Auto-sync | 7 files trong `popup/styles/` | Phân tách tokens, layout, modal, mascot, subtabs... |
| `extension/src/content.js` | **4,189** | Auto-sync | 7 files trong `content/modules/` | Walker, chunker, engine, widget-dom, observer |
| `extension/src/popup.js` | **4,066** | **3,641** | 8 files trong `popup/modules/` | Tách rules-manager, fallback-rows, config-io, modal, mascot, banner |
| `extension/src/sw.js` | **3,975** | **3,382** | 4 files trong `sw/modules/` | Tách batch-executor, cache, queue, security |
| **Tổng cộng module** | — | — | **33 modular files** | **Kiến trúc phân tầng hoàn chỉnh, zero regression** |

### Mục tiêu Refactor:
1. **Tách biệt mối quan tâm (Separation of Concerns)**: Mỗi module chỉ giải quyết một trách nhiệm duy nhất (SRP), độ dài lý tưởng 100–350 dòng.
2. **100% Tương thích Ngược (Zero Regression)**:
   - Giữ nguyên toàn bộ public contract và interfaces.
   - Các bài kiểm thử Node VM (`vm.runInThisContext`, `fs.readFileSync`) trong 407 test cases hiện có phải tiếp tục PASS 100%.
   - Tuân thủ nghiêm ngặt `scripts/check-closure.mjs` (không lộ file nhạy cảm, build tarball sạch).
   - Bản đóng gói `extension/dist/` hoạt động chuẩn xác trên trình duyệt Chrome MV3.

---

## 2. Kiến trúc Module Đề xuất theo từng Tệp

### 2.1. Refactor `i18n.mjs` & `i18n-globals.js` (Tiết kiệm ~4,000 dòng trùng lặp)

- **Cấu trúc thư mục mới**: `extension/src/locales/`
  ```
  extension/src/locales/
  ├── vi.mjs
  ├── en.mjs
  ├── ja.mjs
  ├── ko.mjs
  ├── zh.mjs
  ├── es.mjs
  └── ru.mjs
  ```
- **`extension/src/i18n.mjs` (Mới: ~60 dòng)**:
  - Import từng catalog ngôn ngữ từ `locales/*.mjs`.
  - Export `MESSAGES`, `SUPPORTED_UI_LOCALES`, `DEFAULT_UI_LOCALE`, `t()`, `hasTranslationKey()`.
- **`extension/src/i18n-globals.js`**:
  - Được đồng bộ tự động từ `locales/*.mjs` qua `scripts/sync-i18n.mjs`, khởi tạo `globalThis.__wmtI18n` phục vụ Content Script và test runner mà không cần duy trì thủ công.

### 2.2. Refactor `popup.css` (Tách thành Style Modules)

- **Cấu trúc thư mục mới**: `extension/src/popup/styles/` (Tổng 7 modules, 362/362 balanced braces)
  ```
  extension/src/popup/styles/
  ├── tokens.css         # Design tokens, màu sắc HSL, font-scale, theme tokens
  ├── layout.css         # Reset, body layout, header, footer, tab navigation
  ├── controls.css       # Buttons, dropdowns, inputs, switches, slider styles
  ├── features.css       # Translation panels, status indicators, badges, logs
  ├── subtabs.css        # Subtab navigation, roving tabindex, rules tables
  ├── modal.css          # Modal dialogs, scroll isolation, focus traps
  └── mascot.css         # Mascot grid, active chips, thumbnails, halo animations
  ```
- **`extension/src/popup.css`**:
  - Biên dịch và đồng bộ tự động qua `scripts/sync-styles.mjs`.

### 2.3. Refactor `popup.js` (Chia nhỏ Controller theo Module Chuyên Trách)

- **Cấu trúc thư mục mới**: `extension/src/popup/modules/` (8 modules)
  ```
  extension/src/popup/modules/
  ├── config-io.mjs       # Import/Export JSON cấu hình, làm sạch API keys
  ├── consent-banner.mjs  # Tính toán trạng thái bảo mật baseURL, auto-start warnings
  ├── modal.mjs           # Focus trap, roving tabindex, background inert controller
  ├── models-manager.mjs  # Quản lý scoped favorites theo baseURL, filter available models
  ├── mascot-picker.mjs   # Điều khiển chọn mascot, 4-way arrow keys, size slider
  ├── state.mjs           # Rate-limit clamping, tunables, autosave state patch builder
  ├── rules-manager.mjs   # Quản lý danh sách per-site rules card, autostart toggle, mode select
  └── fallback-rows.mjs   # Quản lý danh sách dynamic fallback rows & controls
  ```
- **`extension/src/popup.js`**:
  - Điều phối và gán listeners, liên kết trực tiếp các hàm modular, duy trì tương thích 100% với static tests và VM test contexts.

### 2.4. Refactor `sw.js` (Chia tách Service Worker Runtime)

- **Cấu trúc thư mục mới**: `extension/src/sw/modules/` (4 modules)
  ```
  extension/src/sw/modules/
  ├── cache.mjs           # Error log ring buffer, L2 storage cache mutex, epochs
  ├── queue.mjs           # Batch translation fallback chain & watchdog reconciliation
  ├── security.mjs        # Origin validation, typed errors & widget sender privilege checks
  └── batch-executor.mjs  # Attempt cache check, post-verification cache commit, batch result merging
  ```
- **`extension/src/sw.js`**:
  - Background Service Worker entrypoint nạp trực tiếp qua native ESM imports và re-exports, cắt giảm ~592 dòng phức tạp.

### 2.5. Refactor `content.js` (Tổ chức lại In-Page Translation Engine)

- **Cấu trúc thư mục mới**: `extension/src/content/modules/` (7 modules)
  ```
  extension/src/content/modules/
  ├── constants.js        # Khởi tạo scope isolated world, tag selectors, constants
  ├── walker.js           # TreeWalker duyệt text nodes, bộ lọc thẻ ẩn/private
  ├── chunker.js          # Phân mảnh batch theo kích thước và ký tự, quản lý restore
  ├── engine.js           # Gửi batch tới background và cập nhật bản dịch vào DOM
  ├── scroll-observer.js  # IntersectionObserver quét trang theo viewport và cuộn chuột
  ├── widget-dom.js       # Khởi tạo Shadow DOM, nút FAB, halo dots, animation Zzz
  └── messages.js         # Runtime message listener (WIDGET_STATE_CHANGED, presentation pushes)
  ```
- **`extension/src/content.js`**:
  - Biên dịch tự động qua `scripts/sync-content.mjs`, chia sẻ closure scope an toàn theo chuẩn Chrome MV3 Isolated World, kiểm tra cú pháp tự động qua `node --check`.

---

## 3. Lộ trình Triển khai Chi tiết (Phased Execution)

- [x] **Giai đoạn 1: i18n Localization Layer**
  - [x] Trích xuất từ điển 7 ngôn ngữ ra `extension/src/locales/{vi,en,ja,ko,zh,es,ru}.mjs`.
  - [x] Thu gọn `i18n.mjs` thành ESM aggregator (51 dòng).
  - [x] Tạo script đồng bộ `scripts/sync-i18n.mjs` tạo `extension/src/i18n-globals.js`.
  - [x] Chạy `npm test test/i18n.test.mjs` và toàn bộ suite: 407/407 PASS.

- [x] **Giai đoạn 2: popup.css Styling Layer**
  - [x] Chia tách các file CSS chuyên biệt vào `extension/src/popup/styles/` (`tokens.css`, `layout.css`, `controls.css`, `features.css`, `subtabs.css`, `modal.css`, `mascot.css`).
  - [x] Tạo `scripts/sync-styles.mjs` đảm bảo cân bằng ngoặc (362/362) và đồng bộ sang `extension/src/popup.css`.
  - [x] Chạy kiểm tra tĩnh và test suite: 407/407 PASS.

- [x] **Giai đoạn 3: popup.js Controller Layer**
  - [x] Xây dựng các module con trong `extension/src/popup/modules/` (`config-io.mjs`, `consent-banner.mjs`, `modal.mjs`, `models-manager.mjs`, `mascot-picker.mjs`, `state.mjs`, `rules-manager.mjs`, `fallback-rows.mjs`).
  - [x] Tích hợp và wire trực tiếp các module vào `popup.js`, chuyển 225+ dòng per-site table logic sang `rules-manager.mjs`.
  - [x] Duy trì 100% tương thích ngược với các bài test tĩnh và VM sandbox test trong `test/auto-scroll-favorites.test.mjs`, `wi42.test.mjs`, `wi52-mascot-icons.test.mjs`.

- [x] **Giai đoạn 4: sw.js Background Layer**
  - [x] Xây dựng các module con trong `extension/src/sw/modules/` (`security.mjs`, `cache.mjs`, `queue.mjs`, `batch-executor.mjs`).
  - [x] Tích hợp trực tiếp vào `extension/src/sw.js` qua native ESM imports và re-exports, chuyển đổi attempt cache checking, translated cache commit, và merge batch results sang `batch-executor.mjs`.
  - [x] Kiểm thử toàn bộ luồng background, rate-limiting watchdog, error classifications: PASS.

- [x] **Giai đoạn 5: content.js In-Page Engine**
  - [x] Module hoá thành 7 module chuyên trách trong `extension/src/content/modules/` (`constants.js`, `walker.js`, `chunker.js`, `engine.js`, `scroll-observer.js`, `widget-dom.js`, `messages.js`).
  - [x] Thiết lập hợp đồng chia sẻ file-level closure cho MV3 Content Script kèm AST syntax check qua `node --check` trong `scripts/sync-content.mjs`.
  - [x] Đảm bảo zero regression trên 407 automated tests.

- [x] **Giai đoạn 6: Đóng gói, Verification Suite & Reviews**
  - [x] Chạy `npm run build` kiểm tra đóng gói `extension/dist/` (loại trừ sạch các thư mục build-time fragments).
  - [x] Chạy `npm run check:contract` (CONTRACT_OK).
  - [x] Chạy `npm run check:closure` (CLOSURE_OK).
  - [x] Chạy toàn bộ automated tests (`npm test`): **409/409 PASS** (bao gồm focused test suite mới).
  - [x] Điều phối Review Lớp 1 (Pre-acceptance): Muse 1.3 Contributor (đã xử lý trọn vẹn 3 blocking items [B1], [B2], [B3] -> **APPROVED**).
  - [x] Xử lý toàn diện phản hồi từ Sol 6.1 (Reviewer L2 - Acceptance Gate):
    - [x] **Fallback Row Delegation**: Đã kết nối `renderFallbackList` từ `extension/src/popup/modules/fallback-rows.mjs` trực tiếp vào `popup.js`, chuyển toàn bộ logic render header/empty/inputs/buttons sang module, đồng thời bảo toàn hoàn hảo VM test slice contract (`test/auto-scroll-favorites.test.mjs`).
    - [x] **Single PARTIAL_BATCH Error Logging**: Loại bỏ lệnh ghi log trùng lặp trong `mergeBatchResults` (`batch-executor.mjs`), bảo đảm `PARTIAL_BATCH` chỉ được ghi duy nhất 1 lần trong `sw.js` đúng như baseline.
    - [x] **Focused Verification**: Bổ sung bộ kiểm thử `test/modular-sol-verification.test.mjs` xác thực độc lập cả hai hành vi (render fallback và single error log).
    - [x] **Doc Parity**: Đồng bộ số dòng as-built (`popup.js`: 3,641; `sw.js`: 3,382) và trạng thái các module.

- [x] **Giai đoạn 7: Deep Modularization (Bóc tách sâu đợt 2 theo yêu cầu người dùng)**
  - [x] **Content Script & i18n Globals Clarity**: Ghi chú rõ ràng banner auto-generated trong `content.js` và `i18n-globals.js` trỏ trực tiếp đến source modules (`content/modules/*.js` và `locales/*.mjs`), giải thích ràng buộc MV3 content scripts không hỗ trợ native ES modules injection.
  - [x] **sw.js Deep Extraction**:
    - [x] `extension/src/sw/modules/keys-manager.mjs`: Bóc tách toàn bộ xử lý vòng đời credentials (`handleSetKeyAction`, `handleSetFallbackKeyAction`, `handleDeleteFallbackKeyAction`, `handleDeleteKeyAction`, `handleHasKeyAction`, `abortActiveWorkOnCredentialChange`).
    - [x] `extension/src/sw/modules/models-discovery.mjs`: Bóc tách discovery endpoints, hash fingerprint SHA-256 (`computeKeyFingerprint`), kiểm tra quyền HTTPS/loopback (`checkBaseUrlPermission`), và L2 caching models (`listModelsWithContext`).
    - [x] `sw.js`: Giảm từ 3,382 dòng xuống 3,136 dòng, giữ nguyên router chính và static contract assertions.
  - [x] **popup.js Deep Extraction**:
    - [x] `extension/src/popup/modules/auto-sites-controller.mjs`: Bóc tách toàn bộ controller auto sites (`showAutoSiteError`, `hideAutoSiteError`, `enableSiteForOrigin`, `refreshSiteDots`, `commitAutoSite`, `openDraftAutoSite`).
    - [x] `extension/src/popup/modules/telemetry.mjs`: Bóc tách format thời gian, thống kê batch progress, và phân loại mã lỗi (`formatElapsed`, `formatDetail`).
    - [x] `extension/src/popup/modules/theme-manager.mjs`: Bóc tách quản lý theme dark/light, font scale, và ngôn ngữ UI (`applyTheme`, `applyFontScale`, `applyUiLocale`).
    - [x] `popup.js`: Giảm từ 3,641 dòng xuống 3,456 dòng, bảo toàn nguyên vẹn lát cắt kiểm thử VM sandbox và delimiter comments.
  - [x] **Kiểm thử tự động hoàn tất**:
    - [x] Chạy toàn bộ 410 automated tests: 410 PASS, 0 FAIL.
    - [x] Bổ sung test `Sol 6.1 Blocker 3` trong `test/modular-sol-verification.test.mjs` xác thực thứ tự gán `currentUiLocale` trước khi render.
    - [x] Contract check (`npm run check:contract`): `CONTRACT_OK`.
    - [x] Closure check (`npm run check:closure`): `CLOSURE_OK`.
    - [x] AST syntax check (`node --check`): 100% PASS cho mọi tệp module mới và sửa đổi.
  - [x] **Reviewer L1 (Muse 1.3 Contributor)**: Đã kiểm tra và phê duyệt sau khi fix `dataset.fontscale` attribute.
  - [x] **Reviewer L2 (Codex Sol 6.1 High)**: **STATUS: ACCEPTED** (0 blocking regressions, zero test failures, verified build & packaging).

