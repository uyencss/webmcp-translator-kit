# Chrome Web Store readiness — audit và kế hoạch sửa

Ngày đối chiếu: 2026-10-01. Audit ban đầu tại HEAD `f98c61bedcbf3d165178764f02b092d7dae089ac` cộng thay đổi SSE chưa commit. Bản cập nhật này kiểm lại tại HEAD `6ad53c0076d82858bdfe969c2b43b0f91a9860a3` (SSE đã được commit). Đây là đánh giá mã nguồn và tài liệu, chưa phải chấp thuận của Google. Không dùng bản ZIP cũ để nộp.

**Bổ sung sau khi xem Dashboard trực tiếp:** tab được cung cấp thuộc item WebMCP Tools Provider đã Published, không phải Translator. Form Store Listing đánh dấu **Store icon 128×128 và ít nhất một screenshot** là bắt buộc; screenshot nhận 1280×800 hoặc 640×400 JPEG/PNG 24-bit không alpha, tối đa 5 ảnh. Global promo video, small promo tile và marquee promo tile trên form đó không có dấu bắt buộc. Privacy policy URL là trường bắt buộc cho extension xử lý user data; Additional instructions của reviewer giới hạn 500 ký tự. Nội dung dán form và kịch bản ảnh ở [chrome-web-store-submission-content-2026-10-01.md](./chrome-web-store-submission-content-2026-10-01.md). Phải kiểm lại form của item Translator khi tạo item riêng.

## Kết luận nhanh

**Tiến độ Store Readiness (cập nhật 2026-10-05):** Bản v0.1.1 đã gửi vào review; Chrome cảnh báo quyền host rộng có thể khiến review sâu hơn và lâu hơn:
1. **F01 (Data Consent v2)**: Onboarding nêu rõ dữ liệu trang, endpoint/upstream, API key trong header `Authorization`, content script được inject trên HTTP(S), cache cục bộ và HTTP loopback không có TLS. Lưu `settings.dataConsent = { version: 2, acceptedAt }`; mọi luồng dịch bị chặn nếu chưa đồng ý hoặc đang thu hồi consent.
2. **F04 (HTTPS Enforcement)**: Đã khóa cứng yêu cầu HTTPS cho mọi endpoint AI từ xa, chặn đứng nguy cơ rò rỉ văn bản trang và API key qua HTTP không mã hóa; chỉ cho phép ngoại lệ HTTP đối với loopback cục bộ (`localhost`, `127.0.0.1`, `[::1]`) phục vụ 9router/AI local; tooltip/chỉ báo bảo mật tại popup cập nhật động.
3. **F05 (Test Instructions)**: Dashboard hiện có Additional instructions về setup endpoint/key thử, dịch/khôi phục, Auto/widget và SSE. Username/Password để trống vì chưa có endpoint/key reviewer công khai.
4. **F06 (Host Permissions)**: Manifest hiện yêu cầu `http://*/*` và `https://*/*` và khai báo content script tĩnh trên toàn bộ hai scheme. Chỉ xử lý văn bản khi người dùng yêu cầu dịch hoặc bật auto-translate cho site. Quyền này cần giải trình trung thực trên Dashboard; nếu reviewer yêu cầu giảm quyền, chuyển sang optional host permissions là việc riêng cần thiết kế/test.
5. **Bộ test**: Source release v0.1.1 đạt **385/385 tests**, contract/closure pass và layout 38/38.

## Bằng chứng tại checkout

| ID | Mức | Quan sát | Tác động / việc cần xác nhận |
| --- | --- | --- | --- |
| F01 | **ĐÃ KHAI BÁO; ĐÃ GỬI REVIEW** | Consent v2 hiển thị dữ liệu/bên nhận, truyền API key, cache, static script scope và loopback HTTP không TLS. Từ chối consent bật fail-closed trước cleanup bất đồng bộ. Dashboard hiện có các disclosure và 3 chứng nhận Limited Use được chọn. | Theo dõi yêu cầu của reviewer; publisher chịu trách nhiệm cho các chứng nhận đã nộp [S3, S4, S5]. |
| F02 | **POLICY VÀ ẢNH ĐÃ ĐỒNG BỘ** | Privacy Policy v0.1.1 và gallery v7 đang live từ `gh-pages` commit `c325af0`; nêu Authorization, script scope, consent, cache, HTTPS/loopback và Limited Use. Bốn ảnh v7 tiếng Anh 1280×800 đã được tải lên Store listing. | Dashboard preview đã có bốn ảnh. Sửa tiếp nếu reviewer yêu cầu hoặc phát hiện sai lệch [S6, S7, S8]. |
| F03 | **ĐÃ UPLOAD VÀ GỬI REVIEW** | Store ZIP `dist-artifacts/webmcp-translator-kit-0.1.1-store.zip`, SHA-256 `28b56d055680732f451952e78b8be90fce738311aa6a7b52381364bb2b41aec6`, có manifest ở root và 24 file; `manifest.key` đã bỏ. CWS Package page hiển thị v0.1.1. | Dashboard trạng thái Pending Review; chưa có quyết định phê duyệt [S1]. |
| F04 | **ĐÃ GIẢI QUYẾT (WI-51)** | Trước đây chấp nhận mọi `http://` từ xa. Nay đã chặn đứng HTTP từ xa ở validation, UI và adapter (`INSECURE_ENDPOINT_BLOCKED`). Chỉ cho phép HTTPS hoặc loopback HTTP (`localhost`, `127.0.0.1`, `[::1]`). Tooltip bảo mật cập nhật động. | Thỏa mãn yêu cầu mã hóa truyền tải dữ liệu người dùng (Secure Transport) và tuân thủ ngoại lệ Native Local Exception [S5, S9]. |
| F05 | **ĐÃ LƯU; KHÔNG CÓ TEST CREDENTIAL** | Additional instructions mô tả first-run disclosure, setup OpenAI-compatible endpoint/key, Translate/Restore, widget và Auto. Credential fields để trống; reviewer cần endpoint/key thử riêng để kiểm tra dịch trực tiếp. | Có thể kéo dài review hoặc reviewer yêu cầu endpoint thử; không đưa key thương mại cá nhân vào Dashboard [S2]. |
| F06 | **CẦN GIẢI TRÌNH TRÊN DASHBOARD** | Manifest dùng `activeTab`, `scripting`, `storage`, host permissions `http://*/*` và `https://*/*`; content script tĩnh được inject trên các trang HTTP(S). Nội dung chỉ được xử lý khi người dùng yêu cầu dịch hoặc bật auto-translate cho site. Các lời giải trình cũ về `optional_host_permissions`/inject động là sai và đã bị loại khỏi bản nháp bên dưới. | Nêu đúng phạm vi và lý do dịch trên website do người dùng chọn. Broad host access có thể kéo dài review hoặc cần chuyển kiến trúc sang optional host permissions [S8, S10]. |
| F07 | **Rủi ro trải nghiệm / bất ngờ** | `popup.js` phân biệt rõ giữa dịch một lần trên tab và bật tự động cho site. WI-50 bổ sung warning banner khi site có trong auto-list nhưng đang tắt để người dùng nhận biết ngay lập tức. | Giúp trải nghiệm minh bạch, tránh gây hiểu lầm cho người dùng [S3, S11]. |
| F08 | **Rủi ro dữ liệu** | `sw.js` lưu API key trong `chrome.storage.local` với hạn chế truy cập `TRUSTED_CONTEXTS`. Content script không thể đọc key. Khi list model/dịch, key đang dùng được gửi trong header `Authorization` tới endpoint tương ứng. Export có checkbox; mặc định hiện tại là bao gồm key nếu người dùng chưa lưu lựa chọn khác. | Policy phải nêu truyền key tới endpoint; giữ checkbox export rõ ràng và kiểm tra file export trước khi chia sẻ [S5, S9, S12]. |
| F09 | **Rủi ro identity/release** | `manifest.json` source/build giữ `key` công khai cố định để giữ extension ID; `scripts/build.mjs` xác nhận key này phải tồn tại và khớp. Private signing key nằm ngoài package. | Không dùng `extension/dist` hoặc CRX dev làm Store ZIP nếu luồng Dashboard của item yêu cầu bỏ trường `key`; giữ nguyên Item ID đã tạo [S13]. |
| F10 | **Đã cải thiện** | Đã hỗ trợ đa ngôn ngữ 7 locale (vi, en, ja, ko, zh, es, ru) cho toàn bộ popup, modal, warning banner và consent modal. | Bảo đảm khả năng tiếp cận và tính nhất quán [S7, S11]. |
| F11 | **ĐÃ CHẠY LẠI 2026-10-04** | Từ source commit `d1008df`: `npm test` 385/385; contract/closure pass; layout 38/38. CRX SHA-256 `ff2ae4a95cca4ada1156d42ccf2c7cdee0d9f83c5a8bf833c86059a4c12c816b`; Store ZIP SHA-256 `28b56d055680732f451952e78b8be90fce738311aa6a7b52381364bb2b41aec6`. | Source checks pass; Chrome compliance review is pending. |
| F12 | **PENDING REVIEW** | Item Translator (`noenbckieeejinchkbjoholopjfhmiga`) đã submit for review; dashboard cảnh báo broad host permissions có thể cần in-depth review. | Chờ CWS decision; xử lý yêu cầu policy/permission nếu reviewer gửi [S2, S8, S14]. |
| F13 | **Tính năng hiện có** | Hỗ trợ hiển thị dần qua SSE hoặc hoàn tất qua JSON thông thường. | Listing mô tả chính xác năng lực thực tế [S7]. |

### Điểm đã phù hợp một phần

- Manifest V3, background service worker module, code JS đi kèm extension; chưa thấy cơ chế tải và thực thi mã từ xa. Gọi model để xử lý dữ liệu không tự nó là remote hosted code; kiểm tra lại ZIP cuối cùng theo [S15].
- Manifest khai content script tĩnh trên mọi trang HTTP(S), ngoài các luồng register/unregister động trong service worker. Consent mặc định OFF cho auto-translation (`consent.mjs`); text chỉ được đọc khi người dùng yêu cầu dịch hoặc đã bật tự dịch. Broad host permissions vẫn cần được giải trình; consent không thay thế chốt quyền.
- Có icon 16/32/48/128 trong **source**; bản ZIP cũ không chứa chúng. Icon 512 source là tùy chọn, không phải bằng chứng asset Store đã hoàn thiện.

## Kế hoạch thực hiện theo thứ tự ngắn nhất tới bản nộp

**Quy tắc thực thi:** đây là plan, chưa phải sửa runtime hoặc phát hành. SSE đã được owner commit; trước khi sửa tiếp cần pin lại HEAD, `git status --short` và danh sách file được phép sửa. Không reset/stash/clean hoặc build vào `extension/dist` nếu có công việc khác đang dùng. Reviewer kiểm tra chính xác cùng tree/ZIP mà writer tạo.

### P0 — Chốt contract dữ liệu và consent (writer: extension; reviewer: privacy/security)

- [ ] Ghi data map 1 trang: văn bản DOM được chọn, origin site, model/endpoint, API key, cache, local storage, error/log; ai nhận dữ liệu (9router và các provider downstream), khi nào gửi, bao lâu giữ, cách xóa. Phân biệt dữ liệu tại máy người dùng, tại 9router và tại provider; xác minh các cam kết retention trước khi viết policy.
- [ ] Chọn một mục đích duy nhất: “dịch nội dung văn bản của trang web mà người dùng chọn sang ngôn ngữ đích”. Bỏ marketing về khả năng ngoài mục đích này. Không dùng extension để né safety guardrails hay giới hạn của dịch vụ AI [S3].
- [x] Thêm disclosure dễ thấy **trước lần dịch đầu**: loại dữ liệu trang được gửi, endpoint/upstream, truyền API key qua `Authorization`, auto mode, phạm vi static injection, cache, transport và liên kết privacy policy. Người dùng chủ động chấp nhận; lưu version/timestamp (`settings.dataConsent = { version: 2, acceptedAt }`) [S3, S4].
- [ ] Tách hành động “Dịch trang này” khỏi “Bật dịch tự động cho site”; chỉ auto-start sau lựa chọn riêng có mô tả rõ. Thao tác OFF và revoke permission phải dừng request đang chạy; xác nhận bằng test âm tính.
- [ ] Loại bỏ việc chọn ngầm tab HTTP khác; nếu tab hiện tại không hỗ trợ thì chỉ báo trạng thái. Thử khi popup mở từ `chrome://extensions`, New Tab và cửa sổ nhiều tab.
- [x] Validate endpoint tại một điểm chung trước `models` và `chat/completions`: HTTPS cho remote; HTTP chỉ dành cho loopback thật sự (`localhost`, `127.0.0.1`, `[::1]`) nếu sản phẩm giữ tích hợp native local 9router. Chặn HTTP từ xa với mã `INSECURE_ENDPOINT_BLOCKED`. Sửa tooltip “gửi an toàn” thành hiển thị động theo scheme (WI-51).
- [ ] Chốt cách lưu API key: giữ `storage.local` với mô tả rủi ro chính xác hoặc chuyển sang session-only nếu không thể chứng minh xử lý at rest phù hợp. Test key không thể đọc từ content script và bị xóa khi người dùng chọn Xóa key/gỡ extension; không thêm lớp mã hóa bằng khóa hardcode trong extension.
- [ ] Thử bằng fixture chứa tên/email và trang có form/`contenteditable`: chỉ text node cần dịch được gửi sau consent; không gửi input/password/form fields; OFF/deny/revoke làm 0 network requests. Test cả fallback khác origin để tránh chuyển dữ liệu/key bất ngờ.

### P1 — Hồ sơ Store và hỗ trợ reviewer (writer: product/publisher; reviewer: policy)

- [x] Đăng privacy policy tại URL HTTPS công khai do publisher kiểm soát (`https://uyencss.github.io/webmcp-translator-kit/`); ghi dữ liệu thu thập, mục đích, bên nhận theo loại endpoint, storage, retention, xóa, bảo mật, liên hệ, Limited Use statement. Link cùng URL trong UI và Privacy tab. Tránh tuyên bố “không thu thập dữ liệu” vì extension đọc/gửi nội dung trang [S5, S6].
- [ ] Dùng bản nháp trong `docs/chrome-web-store-submission-content-2026-10-01.md` để chốt Store listing bằng ngôn ngữ phù hợp: tên, mô tả ngắn đúng manifest (tối đa 132 ký tự), mô tả dài một mục đích, điều kiện cần 9router/API key, quyền từng site và endpoint, auto mode, hỗ trợ, và hiển thị dần khi SSE được xác minh. Không dùng từ khóa spam hoặc claim bảo mật/riêng tư vượt bằng chứng [S7, S11].
- [x] Đã tạo **hai mockup ảnh tạm**, phiên bản mới chia bên trái thành hai section cao bằng nhau để so sánh Trung–Việt, dùng placeholder nhỏ và nổi UI: `translator-store-popup-v4-comparison-1280x800.jpg` và `translator-store-floating-v4-comparison-1280x800.jpg` trong `docs/store-assets/`; JPEG 1280×800 RGB không alpha. Bản v1/v2 được giữ làm tham khảo.
- [ ] Trước khi đưa ảnh dựng vào Store, so popup/widget, câu chữ và tiến trình hiển thị với build/ZIP cuối; sửa hoặc thay nếu khác đáng kể. Xác nhận icon 128×128 và không lộ key. Small promo tile 440×280, marquee và video hiện **không bắt buộc** trên form đã xem; chỉ làm nếu Dashboard của item Translator yêu cầu hoặc có lợi ích rõ [S7, S16].
- [ ] Điền Privacy practices: single purpose; justification cho `activeTab` / `scripting` / `storage` và host permissions rộng `http://*/*`, `https://*/*`; loại dữ liệu theo data map; third-party transfer; Limited Use certification; remote code = No **chỉ sau** khi kiểm tra ZIP không có remote execution. Bảng khai phải khớp code và policy [S8, S15].
- [x] Chuẩn bị Test instructions cho reviewer: hỗ trợ local loopback fixture / 9router (`http://127.0.0.1:8080/v1`) và test key (`test-key`), không yêu cầu key thương mại thật; đường dẫn thao tác, model, expected translation, cách test bật/tắt auto/restore, xử lý khi dịch vụ gián đoạn (WI-51) [S2].
- [ ] Kiểm tra publisher account dự kiến, email xác minh, 2-Step Verification, phí đăng ký/trạng thái account nếu chưa xong; quyết định Public/Unlisted/Private và khu vực. Cả ba visibility đều phải qua cùng chính sách/review [S14, S17]. Git remote của workspace vẫn tuân chuẩn tài khoản `uyencss`.

### P2 — Artifact và acceptance (writer: release; reviewer độc lập: cùng ZIP)

- [ ] Trên release candidate cuối, pin commit/tree, trạng thái dirty và write-set; chạy lại `npm test`, `npm run check:contract`, `npm run check:closure`. Bản SSE hiện tại ở `6ad53c0` đã đạt 100/100 test, nhưng phải kiểm lại sau mọi sửa đổi. Nếu có CLI quota-heavy/batch writer, kiểm tra quota theo workspace rule trước khi chạy.
- [ ] Chạy `npm run build` **sau khi** chốt source candidate; tạo ZIP **mới** từ nội dung `extension/dist` với `manifest.json` ở root. `npm run pack:ext` hiện yêu cầu dev signing key và tạo thêm CRX; đường Store có thể dùng ZIP-only packaging đơn giản hơn, nhưng không làm mất dev ID mà tích hợp khác đang dựa vào. Cập nhật `docs/packaging.md` để phân biệt Store ZIP và CRX dev.
- [ ] Kiểm tra ZIP: đủ mọi file manifest tham chiếu và mọi import từ `sw.js`/`popup.js`; không `.pem`, `.key`, `.env`, log, fixture, test, source map chứa secret; `unzip -t` pass; so hash với artifact load thử. Chặn upload nếu ZIP thiếu icon hoặc module.
- [ ] Load **ZIP vừa tạo sau khi giải nén** vào Chrome profile sạch; xem `chrome://extensions` không lỗi; chạy manual smoke: setup endpoint/key, consent, dịch, restore, auto-site, revoke, fallback, browser restart, tab đổi site, trang unsupported. Kiểm tra mạng chứng minh chỉ gửi tới endpoint được chọn và không có remote JS/WASM/eval. Dùng Chrome Stable hiện hành và một profile sạch.
- [ ] Reviewer độc lập đọc listing + privacy + data map + manifest + ZIP từ cùng hash; so từng claim với hành vi. Sau đó chủ tài khoản mới upload ZIP vào Dashboard, xác nhận Item ID/public key, điền form, lưu draft, preview, rồi Submit for Review khi mọi gate xanh. Có thể chọn deferred publishing để tự quyết định lúc công khai [S2, S13].

### Lệnh/kiểm tra cuối (chạy trên candidate đã chốt)

```bash
git status --short --branch
npm test
npm run check:contract
npm run check:closure
npm run build
# ZIP Store: nén nội dung extension/dist, không nén thư mục dist làm cấp cha.
rm -f dist-artifacts/webmcp-translator-kit-STORE.zip
cd extension/dist && zip -qr ../../dist-artifacts/webmcp-translator-kit-STORE.zip .
cd ../.. && unzip -t dist-artifacts/webmcp-translator-kit-STORE.zip
unzip -Z1 dist-artifacts/webmcp-translator-kit-STORE.zip
shasum -a 256 dist-artifacts/webmcp-translator-kit-STORE.zip
```

`npm run test:smoke` gọi build và có thể ghi đè `extension/dist`; chỉ chạy sau bước pin/chốt owner. Test thực với provider cần xác định chi phí/quota và dữ liệu thử. Lưu test receipt gồm commit/tree, ZIP SHA-256, Chrome version, kết quả âm/dương và reviewer.

## Stop rules, rollback và Definition of Done

**Dừng nộp** nếu một trong các điều kiện sau còn đúng: chưa có consent/disclosure trước network; HTTP remote nhận text/key; policy URL không công khai hoặc mâu thuẫn với hành vi; ZIP không load được/thiếu file; reviewer không thử được tính năng chính; test release đỏ; Item ID chưa thống nhất với tích hợp; Privacy fields chưa điền chính xác. Bản Private/Unlisted không miễn các chặn này [S17].

**Rollback trước submit:** không đụng source dirty của owner; bỏ ZIP candidate lỗi và tạo ZIP mới từ đúng commit. **Sau submit nhưng trước duyệt:** dùng Cancel review, tăng version khi upload package sửa. **Sau publish:** release bản sửa có version cao hơn; nếu có sự cố dữ liệu, dừng luồng có lỗi và theo quy trình Store, không lặng lẽ đổi endpoint/policy [S2].

**Done cho bản nộp:** mọi P0/P1/P2 checkbox hoàn thành; evidence cùng hash; privacy/listing/UI/dashboard nhất quán; Google Dashboard chấp nhận ZIP và không báo lỗi trước Submit for Review. **Done cho phát hành:** Google review approved và publisher chọn publish. Không đánh đồng “đã upload” với “đã duyệt”.

## Trạng thái Dashboard — 2026-10-03

- Đã tạo item **WebMCP Translator Kit** ở publisher `hieu2906090`, ID `noenbckieeejinchkbjoholopjfhmiga`; trạng thái **Draft**.
- Đã build từ commit `f777b01b5f26b2d96a00fe521d045bdfd5c8e8fe`, version `0.1.0`. Dashboard từ chối gói đầu do `manifest.key`; Store ZIP sau đó bỏ riêng trường này và được chấp nhận. Artifact cũ: `dist-artifacts/webmcp-translator-kit-0.1.0-store-f777b01.zip`, SHA-256 `ae36889ce6c31ab55f99cb3ad146170f61be446e36f5bad11865ecb475690c57`. Build thường hiện tại vẫn giữ `manifest.key`; kiểm tra riêng Store ZIP trước upload.
- Đã lưu category `Tools`, language `English (United States)`, mô tả listing, icon 128×128, và bốn ảnh English (screenshot thứ tư tải ở 640×400 sau khi bản 1280×800 bị Dashboard báo sai kích thước).
- Single purpose, permission justifications, remote code = No, data categories và privacy URL đã được lưu trước đó. Lần kiểm tra UI hiện tại cho thấy ba Limited Use checkbox đang chọn; lần submit trước chưa thực hiện.
- Chưa bấm **Submit for Review**. Ngoài hai chốt Dashboard, bản commit upload vẫn thiếu disclosure/affirmative consent rõ trong UI trước lần gửi page text, khai báo manifest còn yêu cầu host permission/content script trên mọi HTTP(S), và cho phép endpoint HTTP từ xa. Sửa/đối chiếu các điểm này và đưa privacy policy lên URL công khai trước khi chứng nhận và submit.

## Cập nhật privacy policy và Dashboard — 2026-10-04

- `wrangler`/Cloudflare CLI không có trong PATH. Repo công khai `uyencss/webmcp-translator-kit` đã có GitHub Pages; trang policy hiện được phục vụ tại [https://uyencss.github.io/webmcp-translator-kit/](https://uyencss.github.io/webmcp-translator-kit/), từ nhánh `gh-pages` (commit `e4fa12e`). Nhánh chỉ chứa website policy và tài sản của website, không chứa thay đổi local trên `main`.
- Trang policy v0.1.1 được Pages build từ commit `c325af0bdb3878344ce82be110b6dbed2a685d57`; commit `2b438f924c0a2e6e1b1589845918999e48ca3e9b` bổ sung câu Limited Use bắt buộc và `c325af0` cập nhật gallery bằng ảnh v7.
- Đã lưu URL vào Privacy tab của draft `noenbckieeejinchkbjoholopjfhmiga`. Lần kiểm tra UI hiện tại cho thấy đủ ba Limited Use checkbox được chọn. Item vẫn Draft; package mới chưa upload.
- Bộ ảnh v7 tiếng Anh (4 × 1280×800 JPEG) được tạo cho UI v0.1.1, lưu ở `docs/store-assets/` cùng prompt set và đã kiểm tra định dạng/kích thước. Dashboard nhận tối đa năm ảnh; bản nộp dùng bốn ảnh v7, giữ v5/v6/v4 trong package làm lịch sử.

## Cập nhật thực thi Store compliance (WI-50 & WI-51) — 2026-10-04

Đã hoàn thành đợt cập nhật tuân thủ chính sách Chrome Web Store (WI-50 & WI-51):
1. **Data Consent v2**: Triển khai `settings.dataConsent = { version: 2, acceptedAt }` kèm migration. Popup hiển thị onboarding trước network và mô tả endpoint/upstream, Authorization key, cache, static injection, loopback HTTP. Khi owner từ chối, cổng fail-closed được bật đồng bộ trước mọi thao tác cleanup; requests mới nhận `DATA_CONSENT_REQUIRED`.
2. **HTTPS Enforcement**: Khóa cứng bảo vệ kênh truyền. Validation settings, adapter `direct9router.mjs`, và SW chặn mọi endpoint HTTP từ xa với mã `INSECURE_ENDPOINT_BLOCKED`. Cho phép loopback HTTP (`localhost`, `127.0.0.1`, `[::1]`) phục vụ 9router nội bộ theo quy định ngoại lệ native local của Google. Tooltip bảo mật tại popup cập nhật động theo scheme.
3. **Cảnh báo lệch trạng thái Auto (WI-50)**: Bổ sung warning banner trên Tab Dịch khi site có cấu hình tự dịch (`autoStart !== false`) nhưng đang ở trạng thái TẮT (`site_off` hoặc `tabOverride: off`). Manifest vẫn khai báo host permissions rộng; đừng mô tả đây là xin quyền optional theo từng origin.
4. **Hỗ trợ Đa ngôn ngữ**: Toàn bộ chuỗi UI của WI-50 và WI-51 được bản địa hóa đầy đủ qua 7 ngôn ngữ (vi, en, ja, ko, zh, es, ru), không có văn bản hardcoded.
5. **Test Instructions Reviewer**: Hỗ trợ reviewer kiểm thử trực tiếp qua local loopback fixture / 9router và khóa `test-key`, không yêu cầu cung cấp khóa thương mại thật.

## Nguồn chính thức (đọc ngày 2026-10-01)

- [S1] [Prepare your extension](https://developer.chrome.com/docs/webstore/prepare) — ZIP/root manifest, test và metadata.
- [S2] [Publish in the Chrome Web Store](https://developer.chrome.com/docs/webstore/publish) — upload, tabs, Test instructions, review/deferred publish.
- [S3] [Chrome Web Store policy updates, July 2026](https://developer.chrome.com/blog/cws-policy-updates-2026) — dữ liệu cần thiết cho single purpose, disclosure mọi collection, hiệu lực 2026-08-01, AI safety.
- [S4] [Disclosure Requirements](https://developer.chrome.com/docs/webstore/program-policies/disclosure-requirements) — công bố và đồng ý.
- [S5] [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq) — nội dung website là user data, xử lý local, secure transport, native local exception.
- [S6] [Privacy Policies](https://developer.chrome.com/docs/webstore/program-policies/privacy) — chính sách công khai và URL trong Dashboard.
- [S7] [Listing Requirements](https://developer.chrome.com/docs/webstore/program-policies/listing-requirements) — mô tả, icon, screenshot, metadata chính xác.
- [S8] [Fill out the privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy) — single purpose, permission, remote code, data categories.
- [S9] [Handling Requirements](https://developer.chrome.com/docs/webstore/program-policies/data-handling) — cryptography và authentication data.
- [S10] [Use of Permissions](https://developer.chrome.com/docs/webstore/program-policies/permissions) — quyền hẹp nhất.
- [S11] [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use) — dùng dữ liệu chỉ cho mục đích đã công bố.
- [S12] [chrome.storage API](https://developer.chrome.com/docs/extensions/reference/api/storage) — `storage.local` và `setAccessLevel`.
- [S13] [Manifest key](https://developer.chrome.com/docs/extensions/reference/manifest/key) — public key và so Item ID.
- [S14] [Set up your developer account](https://developer.chrome.com/docs/webstore/set-up-account) và [2-Step Verification](https://developer.chrome.com/docs/webstore/program-policies/two-step-verification).
- [S15] [MV3 remote code requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements) và [Code Readability](https://developer.chrome.com/docs/webstore/program-policies/code-readability).
- [S16] [Creating a great listing page](https://developer.chrome.com/docs/webstore/best-listing) và [Complete your listing information](https://developer.chrome.com/docs/webstore/cws-dashboard-listing/). Các trang hướng dẫn listing cũ có thể khác Dashboard thực tế về asset tùy chọn; Dashboard hiện tại là gate cuối.
- [S17] [Distribution settings](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution) — visibility và review giống nhau.

## Trạng thái gửi Chrome Web Store — 2026-10-05

- Item `noenbckieeejinchkbjoholopjfhmiga` ở publisher `hieu2906090` đã nhận package v0.1.1; Package page xác nhận version `0.1.1`.
- Store listing đã lưu mô tả cập nhật và bốn ảnh v7 (English UI, Chinese → English; JPEG RGB 1280×800). Test instructions đã lưu; Username/Password để trống.
- Privacy policy URL trỏ tới policy v0.1.1 có Limited Use statement. Các 3 Limited Use disclosures đang được chọn trong form Privacy; Remote code = No. Distribution visibility là Public, All regions.
- **Pending Review:** Submit for Review đã được gửi. CWS cảnh báo Broad Host Permissions có thể yêu cầu in-depth review và làm chậm xuất bản. Modal xác nhận cho biết item sẽ tự publish sau khi vượt qua review; Dashboard ghi review có thể mất vài ngày làm việc. Chờ kết quả reviewer; không thay đổi package trong lúc review nếu chưa có yêu cầu.
