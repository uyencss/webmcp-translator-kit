# WebMCP Translator Kit — Lifecycle Semantics & Boundaries

- **Contract Version**: `webmcp-translator-contract/1`
- **Scope**: MV3 Background Service Worker lifecycle, tab close handling, and browser close/exit semantics.
- **Normative Reference**: `contract/lifecycle.md`, `contract/direct-interface.md` (consent/tab-override policy).

---

## 1. Ba Mức Vòng Đời (Lifecycle Tiers)

WebMCP Translator Kit phân định ranh giới lưu trữ và trạng thái theo ba cấp độ vòng đời độc lập:

### (a) Service Worker Idle Restart (Browser Session Ongoing)
Theo mô hình Chrome Manifest V3, background service worker (SW) tự động bị hệ thống terminate sau khoảng 30 giây không hoạt động và được khởi tạo lại (on-demand restart) khi có sự kiện (runtime message, tab change, popup click...).

- **Trạng thái tồn tại (Survives)**:
  - `chrome.storage.session`: Toàn bộ dữ liệu session sống sót qua các lần SW restart trong cùng một phiên duyệt trình, bao gồm:
    - Tab Overrides (`tab_overrides`: explicit `"on"` | `"off"` cho từng `tabId`).
    - Sliding Window Rate Limit Counters (`rate:tab:${tabId}`, `rate:site:${origin}` trong cửa sổ 60 giây).
  - `chrome.storage.local`: Dữ liệu cấu hình lâu dài (`settings`, `api_key`, `sites`, `registrations`).
- **Trạng thái bị huỷ (Discarded Heap)**:
  - Bộ nhớ in-memory (JavaScript heap) bị giải phóng hoàn toàn: hàng đợi `tabQueues`, các timer `retryAfterMs`, in-flight HTTP sockets.
  - Bộ nhớ cache tạm: `translationCache` (TTL 10m / 500 entries / 2 MiB) và `listModels` discovery cache (TTL 5m).
- **Hành vi với request dở dang (`DROPPED_ON_RESTART`)**:
  - Trích `contract/lifecycle.md §3.2`:
    > "When a service worker starts up fresh: It does NOT restore or execute pending batches from previous worker lifecycles. Content scripts tracking pending request IDs reconcile with the new worker instance: if an in-flight request ID is unknown to the fresh worker, it is transitioned to the terminal status `DROPPED_ON_RESTART`."
  - Không tự động retry lặp vô tận; không phát sinh ghost provider calls.
- **Bảo mật khởi động (`TRUSTED_CONTEXTS`)**:
  - Trích `contract/lifecycle.md §4.1`:
    > "Every time the background service worker starts up—prior to serving any translation request, invoking `listModels()`, or accepting settings updates—it MUST execute: `await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });`"
  - Ngăn chặn triệt để content script (ISOLATED world) truy cập `chrome.storage.local`.

---

### (b) Tab Close (`chrome.tabs.onRemoved`)
Xảy ra khi người dùng đóng một thẻ tab hoặc context tab bị Chrome giải phóng.

- **Dọn dẹp phiên của tab**:
  - Xoá override của tab (`tab_overrides[tabId]`) trong `chrome.storage.session`.
  - Xoá bộ đếm hạn ngạch của tab (`rate:tab:${tabId}`) trong `chrome.storage.session`.
  - Hàng đợi chờ trong memory của tab (`tabQueues.get(tabId)`) bị huỷ sạch với typed error `ABORTED` (`reason: 'Tab was closed'`).
- **Trạng thái giữ nguyên (Preserved)**:
  - Cấu hình trang web (`sites[origin]`) trong `chrome.storage.local` được giữ nguyên vẹn. Site-scoped consent không bị ảnh hưởng khi đóng một tab đơn lẻ.
  - Các tab khác cùng origin hoặc khác origin tiếp tục hoạt động theo chính sách hiện hành.

---

### (c) Browser Close / Exit (Session Termination)
Xảy ra khi ứng dụng Chrome bị tắt hoàn toàn hoặc người dùng thoát trình duyệt (Quit Chrome).

- **Xoá sổ toàn bộ Session (`chrome.storage.session`)**:
  - Chrome tự động thu hồi và dọn sạch toàn bộ `chrome.storage.session`.
  - Tất cả các tab override trước đó đều biến mất hoàn toàn.
  - Toàn bộ sliding window rate limit counters (`rate:*`) được reset về trạng thái ban đầu.
- **Khởi động phiên mới**:
  - Phiên duyệt trình tiếp theo bắt đầu với session storage trống.
  - Chính sách hiệu lực của mọi tab mới mở tự động quay về theo Site Setting trong `chrome.storage.local` (nếu site được bật -> `SITE_ENABLED`, nếu site chưa bật -> default `OPT_IN_REQUIRED`).
  - Trích `contract/lifecycle.md §2.1`:
    > "Default policy is strictly OFF... All session storage entries are cleared when the browser application exits."
  - **Phân biệt trọng yếu**: Browser Close **KHÔNG** tương đương với SW Idle Restart. SW Restart duy trì `storage.session` để bảo vệ consent và rate limit của người dùng trong phiên, trong khi Browser Close kết thúc hoàn toàn phiên làm việc.

---

## 2. Bảng Đối Chiếu Ranh Giới (Comparison Matrix)

| Đặc tính / Vùng nhớ | (a) SW Idle Restart | (b) Tab Close (`onRemoved`) | (c) Browser Close / Exit |
|---|---|---|---|
| `chrome.storage.session` | **Giữ nguyên** (`tab_overrides`, `rate:*`) | **Xoá mục của tab đóng** | **Xoá toàn bộ (Wiped)** |
| `chrome.storage.local` (`sites`, `settings`) | **Giữ nguyên** | **Giữ nguyên** | **Giữ nguyên** |
| Memory Heap (`tabQueues`, Timers) | Bị huỷ -> `DROPPED_ON_RESTART` | Huỷ queue tab đóng (`ABORTED`) | Toàn bộ tiến trình kết thúc |
| In-memory Cache (`translationCache`) | Bị xoá (cold cache miss) | Giữ nguyên cho các tab khác | Bị xoá |
| Tab Override của tab tương ứng | **Còn hiệu lực** | **Bị xoá** | **Bị xoá toàn bộ** |
| Chính sách tab sau sự kiện | Giữ nguyên (Tab Override > Site) | Tab không còn; tab mới theo Site | Mọi tab mới theo Site / Default OFF |
| `TRUSTED_CONTEXTS` Hook | **Bắt buộc re-assert khi wake** | Không áp dụng | **Bắt buộc re-assert khi start** |
