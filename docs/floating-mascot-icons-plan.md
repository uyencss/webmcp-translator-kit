# WebMCP Translator Kit — Floating Mascot Icons & Appearance Customization Plan (WI-52)

> **Document Version**: 1.0.0  
> **Status**: IN_PROGRESS  
> **Target Package**: `packages/webmcp-translator-kit`  
> **Orchestrator**: Antigravity Coordinator (AGY IDE)  
> **Primary Writer**: AGY Gemini Flash 3.8 (`gemini-3.8-flash-high`)  
> **Reviewer L1 (Contributor Pre-accept)**: OpenCode Muse Spark 1.3 Contributor (`opencode-go/muse-spark-1.3-contributor`)  
> **Reviewer L2 (Final Acceptance Gate)**: Native Codex Sol High (`gpt-6-sol`, reasoning `high`)  

---

## 1. Overview & Mục tiêu

Hiện tại, nút icon nổi (`#wmt-fab`) của WebMCP Translator trên trang web chỉ hiển thị một icon SVG mặc định (biểu tượng dịch thuật hai ngôn ngữ A/文) và thanh trượt kích thước `fabSize` (0.75x – 1.50x).

Theo cảm hứng từ `packages/webmcp-floating-bot` (với các mascot bot phong phú như `astro-fox`, `cyber-cat`, `mech-owl`, `robot-chibi`, `spark-orb`), tính năng này mang lại sự sinh động, thân thiện và cá nhân hóa cho người dùng khi duyệt web và đọc truyện/tài liệu:
1. **Bộ sưu tập 5 Mascot đa ngôn ngữ** mang tinh thần học tập & dịch thuật (Duolingo-inspired, polyglot companions):
   - `default`: Biểu tượng dịch thuật chuẩn (Classic Vector SVG).
   - `polyglot-owl`: Chú cú xanh thông thái, đeo tai nghe mini hoặc mũ cử nhân (vibe Duolingo / tri thức ngôn ngữ).
   - `babel-cat`: Chú mèo công nghệ đáng yêu với biểu tượng bong bóng thoại đa ngữ.
   - `globe-fox`: Chú cáo lông cam/vàng ôm quả địa cầu thu nhỏ, biểu tượng khám phá thế giới.
   - `lingo-parrot`: Chú vẹt nhiệt đới đeo kính thông thái, chuyên gia lặp lại và chuyển ngữ tức thì.
   - `robo-babel`: Chú robot chibi đáng yêu với màn hình led hiển thị cảm xúc và tần số sóng âm dịch thuật.
2. **Giao diện cấu hình Mascot & Kích thước mặc định** trong tab **Giao diện (Appearance)** của extension popup:
   - Bộ chọn Mascot trực quan với hình đại diện thumbnail preview.
   - Thanh trượt kích thước icon nổi (`input-fab-size`) kèm nút **"Đặt lại mặc định"** (`Reset to Default 1.00x`).
3. **Hiển thị trực tiếp trên Content Script Shadow DOM**:
   - `#wmt-fab` render hình ảnh mascot đã chọn (hoặc SVG chuẩn khi chọn `default`).
   - Tự động fallback về SVG chuẩn nếu file ảnh gặp lỗi tải.
   - Hiệu ứng animation nhịp nhàng khi dịch (pulse / busy indicator).
   - Đăng ký `web_accessible_resources` trong `manifest.json` để trang web có thể nạp tài nguyên an toàn.

---

## 2. Danh mục Mascot & Thông số kỹ thuật

| Mascot ID | Tên hiển thị (VI) | Tên hiển thị (EN) | File Asset | Mô tả phong cách |
| :--- | :--- | :--- | :--- | :--- |
| `default` | Biểu tượng chuẩn | Classic Icon | *Inline SVG* | Biểu tượng dịch thuật chuẩn mực, tối giản |
| `polyglot-owl` | Cú đa ngữ | Polyglot Owl | `icons/mascots/polyglot-owl.png` | Cú xanh ngọc học giả, tai nghe phiên dịch, mắt sáng tinh anh |
| `babel-cat` | Mèo dịch thuật | Babel Cat | `icons/mascots/babel-cat.png` | Mèo công nghệ trắng/tím, tai nghe neon, aura bong bóng ngôn ngữ |
| `globe-fox` | Cáo thám hiểm | Globe Fox | `icons/mascots/globe-fox.png` | Cáo cam ấm áp ôm địa cầu mini, biểu tượng du hành quốc tế |
| `lingo-parrot` | Vẹt thông thái | Lingo Parrot | `icons/mascots/lingo-parrot.png` | Vẹt sắc màu đeo kính công nghệ, chuyển ngữ nhanh nhẹn |
| `robo-babel` | Robot Chibi | Robo Babel | `icons/mascots/robo-babel.png` | Robot chibi tròn trịa, màn hình LED cảm xúc, anten dịch sóng |

- **Định dạng file**: PNG 32-bit trong suốt hoặc nền bo tròn tinh tế (512x512 master, scale mượt về 28x28 – 44x44).
- **Thư mục lưu trữ**:
  - Mã nguồn: `extension/src/icons/mascots/`
  - Bản đóng gói phân phối: `extension/dist/icons/mascots/` (do `scripts/build.mjs` sao chép tự động).

---

## 3. Kiến trúc Thay đổi & Write-Set

### 3.1. Schema & Cấu hình (`extension/src/settings.mjs`)
- Định nghĩa enum `VALID_FAB_MASCOTS = Object.freeze(['default', 'polyglot-owl', 'babel-cat', 'globe-fox', 'lingo-parrot', 'robo-babel'])`.
- Bổ sung `DEFAULT_FAB_MASCOT = 'default'`.
- Hàm `normalizeFabMascot(val)` chuẩn hóa giá trị hợp lệ.
- Bổ sung trường `fabMascot` vào `DEFAULT_SETTINGS`.
- Bổ sung logic `migrateSettings(raw)` và `validateSettings(settings)` bảo đảm tính tương thích ngược tuyệt đối.
- Cập nhật hàm xuất/nhập cấu hình (`sanitizeSettingsForExport`, `ALLOWED_KEYS`).

### 3.2. Cấu hình Extension Manifest (`extension/src/manifest.json`)
- Thêm trường `web_accessible_resources`:
  ```json
  "web_accessible_resources": [
    {
      "resources": ["icons/mascots/*"],
      "matches": ["http://*/*", "https://*/*"]
    }
  ]
  ```

### 3.3. Giao diện Cấu hình Popup (`popup.html`, `popup.css`, `popup.js`)
- **`popup.html`**:
  - Thêm cụm điều khiển Mascot trong subpanel Giao diện (`#config-section-appearance`).
  - Lưới visual chips / selector chọn mascot (`#select-fab-mascot` hoặc grid card mascot).
  - Thêm nút reset kích thước mặc định `#btn-reset-fab-size` ngay cạnh badge kích thước.
- **`popup.css`**:
  - Phong cách hiện đại (Dark/Light mode hài hòa), bo góc, border highlight khi mascot được chọn, hover micro-interactions.
- **`popup.js`**:
  - Đọc và lưu `fabMascot` trong `collectSettingsPatch` và hydration.
  - Bắt sự kiện click mascot chip / select change.
  - Bắt sự kiện `#btn-reset-fab-size` để gán lại `fabSize = 1.0` mượt mà.

### 3.4. Đa ngôn ngữ (`i18n.mjs` & `i18n-globals.js`)
- Bổ sung đầy đủ 7 ngôn ngữ (`vi`, `en`, `ja`, `ko`, `zh`, `es`, `ru`):
  - `config_fab_mascot_label`: Nhãn nhóm chọn mascot.
  - `config_fab_size_reset_btn`: Nút reset kích thước về mặc định (1.00x).
  - Tên hiển thị của từng mascot (`mascot_default`, `mascot_polyglot_owl`, `mascot_babel_cat`, `mascot_globe_fox`, `mascot_lingo_parrot`, `mascot_robo_babel`).

### 3.5. Hiển thị Content Script Shadow DOM (`content.js`)
- Đọc `widgetState.fabMascot` từ settings / message.
- Cập nhật `#wmt-fab`:
  - Nếu `default`: dùng inline SVG như hiện tại.
  - Nếu mascot khác: chèn thẻ `<img class="wmt-fab-mascot-img" alt="..." src="..."/>` với đường dẫn lấy từ `chrome.runtime.getURL('icons/mascots/' + mascot + '.png')`.
  - Có error handler `onerror`: tự động ẩn `<img>` và hiển thị lại SVG dự phòng nếu xảy ra sự cố nạp ảnh.
  - Hỗ trợ hoạt họa loading/busy: xoay nhẹ hoặc nhịp đập pulse mượt mà khi `isTranslating` hoặc `scrollSession.inFlight > 0`.

---

## 4. Kế hoạch Triển khai & Checkbox Checklist

### Giai đoạn 1: Lập kế hoạch & Tài liệu kiến trúc
- [x] Lập tài liệu kế hoạch chi tiết `docs/floating-mascot-icons-plan.md` với đầy đủ tiêu chí DoD.
- [x] Rà soát quy tắc điều phối model (`ai-role-dispatch`): Orchestrator (Antigravity), Writer (AGY Flash 3.8), Reviewer L1 (Muse 1.3 Contributor), Reviewer L2 (Sol 6.1 High).

### Giai đoạn 2: Tạo bộ ảnh Mascot (5 Icons)
- [x] Sinh ảnh `polyglot-owl` (Cú xanh đa ngữ Duolingo vibe).
- [x] Sinh ảnh `babel-cat` (Mèo công nghệ phiên dịch).
- [x] Sinh ảnh `globe-fox` (Cáo thám hiểm địa cầu).
- [x] Sinh ảnh `lingo-parrot` (Vẹt thông thái chuyển ngữ).
- [x] Sinh ảnh `robo-babel` (Robot chibi phiên dịch mini).
- [x] Đặt các file vào `extension/src/icons/mascots/` và kiểm tra độ phân giải / trong suốt.

### Giai đoạn 3: Cập nhật Schema Cài đặt & Manifest
- [x] Cập nhật `extension/src/settings.mjs`: `VALID_FAB_MASCOTS`, `normalizeFabMascot`, `DEFAULT_SETTINGS`, `migrateSettings`, `validateSettings`, export keys.
- [x] Cập nhật `extension/src/manifest.json`: thêm `web_accessible_resources` cho `icons/mascots/*`.
- [x] Cập nhật `scripts/build.mjs` bảo đảm sao chép thư mục mascot sang `dist/`.

### Giai đoạn 4: Cập nhật Từ điển Ngôn ngữ (i18n)
- [x] Thêm các khóa bản địa hóa cho 7 ngôn ngữ vào `extension/src/i18n.mjs`.
- [x] Đồng bộ toàn bộ các khóa đó vào `extension/src/i18n-globals.js`.
- [x] Bổ sung `config_fab_size_reset_title` cho tooltip nút reset trên cả 7 ngôn ngữ theo review Sol.

### Giai đoạn 5: Cập nhật Giao diện Cấu hình Popup
- [x] Cập nhật `extension/src/popup.html`: thêm bộ chọn Mascot trực quan (`#mascot-selector-grid`) và nút reset kích thước (`#btn-reset-fab-size`).
- [x] Cập nhật `extension/src/popup.css`: thêm CSS cho mascot picker chips, avatar preview, nút reset size, hỗ trợ Dark/Light theme.
- [x] Cập nhật `extension/src/popup.js`: binding sự kiện chọn mascot, hỗ trợ WAI-ARIA Arrow key navigation, cập nhật settings, lưu trữ, và nút reset size.

### Giai đoạn 6: Cập nhật Content Script Widget
- [x] Cập nhật `extension/src/content.js`: hiển thị ảnh mascot trong `#wmt-fab`, quản lý fallback SVG an toàn và hoạt họa busy state `wmtMascotPulse`.

### Giai đoạn 7: Kiểm thử & Nghiệm thu
- [x] Viết bộ test chuyên biệt `test/wi52-mascot-icons.test.mjs` (13/13 tests pass).
- [x] Chạy `npm test` bảo đảm 100% tests pass (403/403 tests pass, 0 fail).
- [x] Chạy `npm run check:contract` bảo đảm hợp đồng không bị vi phạm (`CONTRACT_OK`).
- [x] Chạy `npm run check:closure` đạt `CLOSURE_OK`.
- [x] Chạy `npm run build` xác nhận đóng gói `dist/` hoàn chỉnh.

### Giai đoạn 8: Đánh giá Đa AI (Multi-Agent Verification)
- [x] **Reviewer L1 (Muse 1.3 Contributor)**: Thẩm tra pre-accept độc lập → `PRE-ACCEPTANCE: PASS`.
- [x] **Reviewer L2 (Codex Sol 6.1 High / gpt-6-sol)**: Thẩm định milestone & phản biện nghiệp vụ (chỉ ra Arrow key navigation, schema version clarity, reset tooltip).
- [x] **Orchestrator Fix Loop**: Đã khắc phục triệt để 3 điểm phản biện của Sol 6.1 High.

---

## 5. Tiêu chuẩn Hoàn thành (Definition of Done - DoD)

1. **Đầy đủ 5 Mascot Images**: Tồn tại 5 tệp ảnh định dạng hợp lệ trong `extension/src/icons/mascots/` và được đóng gói sang `extension/dist/icons/mascots/`.
2. **Schema & Migration Hoàn hảo**:
   - `DEFAULT_SETTINGS` có `fabMascot = 'default'`.
   - Settings cũ không có `fabMascot` được migrate tự động về `'default'`.
   - Cài đặt có giá trị lạ/không hợp lệ bị normalize an toàn về `'default'` mà không gây crash.
3. **UI Cấu hình Trực quan**:
   - Tab "Giao diện" trong popup hiển thị bộ chọn Mascot trực quan với hình ảnh / icon đại diện.
   - Khi click chọn mascot, trạng thái active cập nhật ngay và được lưu vào Chrome Storage.
   - Hỗ trợ đầy đủ phím mũi tên (ArrowLeft, ArrowRight, ArrowUp, ArrowDown) cho người dùng bàn phím.
   - Nút "Đặt lại mặc định" (1.00x) hoạt động trơn tru, đồng bộ badge hiển thị và slider.
4. **Trải nghiệm Trên Trang Web (Content Script)**:
   - Icon nổi hiển thị đúng mascot người dùng đã chọn.
   - Nút icon co giãn mượt mà theo `fabSize`.
   - Khi dịch, mascot vẫn thể hiện trạng thái hoạt động (pulse/busy indicator).
   - Nếu nạp ảnh lỗi, tự động fallback về icon SVG mặc định.
5. **Đa ngôn ngữ & Chất lượng Mã nguồn**:
   - Toàn bộ 9 nhãn mới có bản dịch trong 7 ngôn ngữ (`vi`, `en`, `ja`, `ko`, `zh`, `es`, `ru`).
   - Tất cả 403 unit tests đều `PASS`.
   - Lệnh `npm run check:contract` đạt `CONTRACT_OK`.
6. **Biên nhận Phê duyệt (Receipts)**:
   - Đầy đủ biên nhận từ Reviewer L1 (`opencode/muse-spark-1.3-contributor-free`) và Reviewer L2 (`gpt-6-sol`).
