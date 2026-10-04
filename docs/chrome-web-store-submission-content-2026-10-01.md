# Nội dung chuẩn bị cho Chrome Web Store — WebMCP Translator

Ngày kiểm tra Dashboard: 2026-10-01. Tab được người dùng cung cấp thuộc item **WebMCP Tools Provider** đã Published (ID `lbodkmkjbcemodklopcfdmpjomdoapae`) trong publisher `hieu2906090`, **không phải** WebMCP Translator. Chỉ dùng form này làm tham chiếu, không sửa item đó. Các trường thực tế của item Translator cần kiểm lại sau khi upload đúng ZIP.

## 1. Trường Dashboard đã xác nhận trực tiếp

| Store listing | Tình trạng trên form đang mở | Chuẩn bị cho Translator |
| --- | --- | --- |
| Title, Summary | Đọc từ manifest của package | Sửa manifest cho người dùng cuối trước build; không thể sửa hai trường này trong listing. |
| Description | Bắt buộc, tối đa 16.000 ký tự | Bản nháp ở mục 2. |
| Category, Language | Chọn trong form | Đề xuất `Tools`, `Vietnamese` vì popup hiện bằng tiếng Việt; xác nhận khi tạo item. |
| Store icon | Bắt buộc, 128×128 | Dùng `extension/src/icons/icon128.png` sau khi kiểm tra thiết kế/quyền sử dụng. |
| Screenshots | **Bắt buộc ít nhất 1**, tối đa 5; 1280×800 hoặc 640×400; JPEG hoặc PNG 24-bit **không alpha** | Mục 4 chỉ dẫn chụp từ bản extension chạy thật. Chưa có screenshot Store hợp lệ trong package. |
| Global promo video | Ô URL YouTube, không đánh dấu bắt buộc | Để trống cho bản nộp tối giản. |
| Small promo tile | 440×280, không đánh dấu bắt buộc | Để trống cho bản nộp tối giản. |
| Marquee promo tile | 1400×560, không đánh dấu bắt buộc | Để trống. |
| Official URL, Homepage URL, Support URL | Không đánh dấu bắt buộc | Cung cấp URL công khai nếu có; Privacy policy URL ở tab Privacy là trường bắt buộc khi xử lý user data. |

Tab **Privacy** có: Single purpose description (1.000 ký tự), giải trình từng quyền (mỗi ô 1.000 ký tự), khai remote code, data usage categories, ba chứng nhận Limited Use, Privacy policy URL. Tab **Test instructions** có Username và Password (mỗi ô 100 ký tự), Additional instructions (500 ký tự). Có thể dùng Username làm Base URL và Password làm API key **chỉ khi** đã cấp riêng một endpoint/key thử ổn định cho reviewer; không đưa key thật vào tài liệu này.

**Cập nhật 2026-10-04:** privacy policy cho item Translator đã được publish tại [https://uyencss.github.io/webmcp-translator-kit/](https://uyencss.github.io/webmcp-translator-kit/) bằng GitHub Pages; commit `2b438f9` bổ sung cam kết Limited Use công khai. URL đã được lưu trong Privacy tab của draft. Đây là trang tĩnh riêng, không yêu cầu website sản phẩm đầy đủ.

## 2. Bản nháp nội dung Store listing

**Đề xuất manifest name:** `WebMCP Translator` — thay cho `WebMCP Translator Kit` khi sẵn sàng release. **Đề xuất manifest description (dưới 132 ký tự):**

> Dịch trang web bằng endpoint AI tương thích OpenAI do bạn cấu hình; có chế độ thủ công, tự động và khôi phục.

Đây là đề xuất sửa manifest, **chưa phải giá trị đã có trong ZIP**. Trước khi thay, kiểm tra tên/ID đã được tích hợp khác dùng và version release.

**English description for the current English (United States) listing:**

> Translate eligible text on web pages you choose into a selected language with an OpenAI-compatible endpoint you configure. Restore the original page text, translate as you scroll, or enable automatic translation for selected sites.
>
> Configure a Base URL, API key, and model in Settings. Then open a page and choose **Translate page**, or enable auto-translation for that site. Use **Restore** to return the original page text. When your endpoint supports Server-Sent Events (SSE), completed passages can appear progressively; standard JSON responses are also supported.
>
> **Data and permissions:** The packaged content script is injected on HTTP and HTTPS pages so the extension can support translation on websites you choose. It reads eligible text only when you start translation or have enabled auto-translation for that site. It skips form controls, password fields, editable content, hidden elements, and its own widget. Page text may still contain personal or sensitive information.
>
> Eligible page text and language/model instructions are sent to the Base URL you configure. A configured fallback may receive text when it is used. Endpoint operators may pass requests to upstream AI providers under their own terms. Your API keys and settings are stored in Chrome extension storage on your device; the active key is sent in an Authorization header to the configured endpoint for model discovery and translation. The extension publisher does not receive page text or API keys through an extension-owned server.
>
> Remote endpoints must use HTTPS. HTTP is allowed only for loopback services on your device and is not protected by TLS. If enabled, the local cache can retain source and translated text for up to 7 days, capped at 2.5 MiB. You can disable caching in Config. You need Chrome and your own compatible endpoint and API key; the extension does not provide an AI service or credentials.

**Kiểm tra trước submit:** description này mô tả quyền host rộng và static injection đúng theo manifest; đối chiếu lại với ZIP upload. Chỉ dùng câu về SSE khi endpoint reviewer có thể thử hoặc test instructions giải thích rõ điều kiện hỗ trợ.

## 3. Nội dung chuẩn bị cho Privacy và Test instructions

**Single purpose description (đề xuất, dưới 1.000 ký tự):**

> Dịch văn bản của trang web mà người dùng chủ động chọn hoặc đã bật tự dịch cho site đó, bằng endpoint AI do người dùng cấu hình; cho phép khôi phục văn bản gốc.

**Permission justifications (đề xuất, điều chỉnh theo manifest cuối):**

- `activeTab`: Cho phép popup xác định tab hiện tại cho thao tác dịch/khôi phục do người dùng khởi chạy.
- `scripting`: Cho phép service worker đăng ký/hủy các content script hỗ trợ dịch trang và tự dịch.
- `storage`: Lưu Base URL, model, site được bật, API key ở `storage.local`; giữ trạng thái tab và giới hạn yêu cầu tạm thời trong `storage.session`.
- Host permissions `http://*/*` và `https://*/*`: Đây là quyền bắt buộc hiện có để dịch các website người dùng chọn; manifest cũng khai báo content script tĩnh trên các trang HTTP(S). Script không gửi văn bản chỉ vì được inject; đọc/xử lý text chỉ sau khi người dùng bắt đầu dịch hoặc đã bật auto-translate cho site. Đây là quyền rộng, cần giải trình rõ trên Dashboard. `chrome.permissions.request` còn được dùng cho luồng cấp quyền theo site/endpoint trong UI, nhưng không biến các host permissions trong manifest thành optional.
- Kết nối endpoint: Extension gọi Base URL và các fallback do người dùng cấu hình; remote HTTP bị chặn, HTTPS được phép, HTTP loopback trên thiết bị được phép nhưng không có TLS.

**Quy định HTTPS và Bảo vệ Endpoint (WI-51):**
- Toàn bộ kết nối gửi văn bản trang và API key tới AI provider bắt buộc phải sử dụng giao thức bảo mật `https://`.
- Cho phép ngoại lệ `http://` duy nhất đối với loopback cục bộ (`localhost`, `127.0.0.1`, `[::1]`, `127.0.0.0/8`) nhằm phục vụ mô hình 9router/AI local do người dùng tự chạy trên cùng thiết bị.
- Mọi endpoint HTTP từ xa (non-loopback) đều bị chặn ở tầng validation cài đặt, UI cảnh báo và adapter network (`INSECURE_ENDPOINT_BLOCKED`), ngăn chặn rò rỉ văn bản trang và API key qua kênh truyền không mã hóa.
- Tooltip và chỉ báo bảo mật tại giao diện popup hiển thị động: thông báo bảo mật với HTTPS/loopback và cảnh báo rõ ràng khi endpoint không an toàn.

**Cơ chế Minh bạch và Đồng thuận Dữ liệu — Data Consent v2 (WI-51):**
- Cấu trúc đồng thuận: `settings.dataConsent = { version: 2, acceptedAt: ISO_TIMESTAMP }`. Bumping version làm người dùng cũ xác nhận lại sau khi disclosure được cập nhật.
- Onboarding modal tự động xuất hiện ngay lần đầu mở extension nếu người dùng chưa xác nhận:
  1. *Nội dung được xử lý và bên nhận*: Khi dịch, text đủ điều kiện cùng ngôn ngữ/model được gửi tới Base URL đã cấu hình; nhà vận hành endpoint có thể chuyển tiếp đến AI provider. Không gửi input/password/contenteditable theo luồng trích xuất đã xác định trong mã.
  2. *Mục đích duy nhất*: Dữ liệu gửi đi chỉ nhằm mục đích duy nhất là tạo bản dịch sang ngôn ngữ đích đã chọn.
  3. *Lưu trữ và truyền API key*: API key và thiết lập lưu trong `chrome.storage.local` của profile Chrome; key đang dùng được truyền qua header `Authorization` đến endpoint tương ứng khi list model/dịch. Cache cục bộ có thể giữ text nguồn và bản dịch tối đa 7 ngày, giới hạn 2.5 MiB.
  4. *Tự động và Endpoint dự phòng*: Tính năng tự dịch theo trang và các fallback providers (nếu có cấu hình) cũng sẽ gửi văn bản tới đúng các endpoint tương ứng.
  5. *Phạm vi content script*: Manifest inject script đã đóng gói trên trang HTTP(S); script chỉ đọc văn bản đủ điều kiện khi người dùng bắt đầu dịch hoặc bật auto-translate cho site. Host permissions hiện khai báo rộng trong manifest và phải được giải trình trung thực.
- Chính sách **Fail-closed**: Nếu người dùng chưa bấm "Đồng ý" (hoặc bấm "Từ chối"), mọi luồng dịch (Dịch thủ công từ popup, Tự động dịch khi mở trang, Widget nổi, Content script) đều bị chặn hoàn toàn với mã lỗi `DATA_CONSENT_REQUIRED`, bảo đảm không có bất kỳ byte dữ liệu nào được gửi qua mạng.
- Khi người dùng từ chối, trạng thái revoked được bật đồng bộ trước cleanup bất đồng bộ; các request mới bị chặn, request đang chạy bị hủy và cache được xóa best-effort. Consent mới chỉ được ghi nhận khi thao tác lưu trả thành công rõ ràng.

**Remote code:** đề xuất chọn `No` sau khi kiểm tra ZIP cuối không tải hoặc chạy JS/Wasm từ mạng. SSE/JSON trả về **văn bản dịch**, không phải mã được `eval`. Kết nối từ xa để dịch dữ liệu cần khai trong phần data usage và policy, nhưng không tự động là remote hosted code.

**Data usage:** chắc chắn cần đánh giá `Website content`; API key người dùng nhập cần đánh giá `Authentication information`, kể cả khi chỉ lưu cục bộ. Vì extension có thể đọc văn bản trang bất kỳ được cấp quyền, trang đó có thể chứa PII, liên lạc cá nhân, sức khỏe hoặc tài chính. Chốt chính xác checkbox với phạm vi tính năng/data map và hướng dẫn của Dashboard; **không** tích mặc định “không thu thập dữ liệu”. Chỉ chứng nhận ba mục Limited Use khi hành vi, policy và bên nhận đã được xác minh. Privacy policy URL công khai là gate bắt buộc.

**Test instructions đã lưu trong Dashboard (477/500 ký tự):** Username và Password để trống vì chưa provision test endpoint/key công khai. Additional instructions: “Accept the first-run data-use notice. Configure an OpenAI-compatible endpoint, model, and API key in Settings > Connection; no credentials ship with the extension. To test, use a test HTTPS endpoint/key, open a non-sensitive page, choose Translate page, then Restore. The floating widget supports Follow scroll and Translate entire page; Auto enables per-site translation. SSE endpoints show completed passages progressively; JSON also works. HTTP is allowed only for loopback.”

## 4. Store assets đang sử dụng

**Bộ v7 — English UI, Chinese → English, package v0.1.1:** bốn mockup 1280×800 JPEG RGB đã tải lên item và hiển thị trong listing Pending Review. Dashboard hiện có bốn ảnh, dưới giới hạn năm ảnh.

1. [Translate popup](./store-assets/translator-store-v7-en-zh-01-translate-1280x800.jpg)
2. [Auto-translate site](./store-assets/translator-store-v7-en-zh-02-auto-site-1280x800.jpg)
3. [Settings → Appearance](./store-assets/translator-store-v7-en-zh-03-appearance-1280x800.jpg)
4. [Floating widget](./store-assets/translator-store-v7-en-zh-04-floating-widget-1280x800.jpg)

Đây là mockup tạo bằng ImageGen, không phải capture. Các label và controls được đối chiếu với source v0.1.1; không có API key hoặc lỗi giả. [Prompt set và ghi chú](./store-assets/translator-store-v7-en-zh-prompts.md). Các phiên bản ảnh v1–v6 đã bị loại bỏ để tránh nhầm với bản nộp.

**Fixture kiểm thử SSE cục bộ:** source đã chuyển ra khỏi thư mục media thành [`demo-page.html`](./fixtures/translator-store-demo/demo-page.html) và [`demo-server.mjs`](./fixtures/translator-store-demo/demo-server.mjs). Chạy `node docs/fixtures/translator-store-demo/demo-server.mjs`, mở `http://127.0.0.1:8097/`, rồi cấu hình Base URL `http://127.0.0.1:8097/v1` với key giả `demo-only`. Fixture chỉ kiểm tra UI/progressive flow, không phải reviewer endpoint và không được đưa vào extension ZIP.

Screenshot reference cũ đã loại khỏi package; hành vi SSE được kiểm tra bằng test suite và source contract thay vì giữ ảnh có nội dung trang bên thứ ba.

## 5. Nguồn

- Trường và giới hạn lấy từ Dashboard đang mở của item WebMCP Tools Provider ngày 2026-10-01, chỉ dùng làm mẫu form.
- [Chrome Web Store Listing Requirements](https://developer.chrome.com/docs/webstore/program-policies/listing-requirements), [Listing images](https://developer.chrome.com/docs/webstore/best-listing), [Privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy), [MV3 remote code](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements).
- Đánh giá và các chốt chặn trước nộp: [chrome-web-store-readiness-2026-10-01.md](./chrome-web-store-readiness-2026-10-01.md).
