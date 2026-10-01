# Chrome Web Store readiness — audit và kế hoạch sửa

Ngày đối chiếu: 2026-10-01. Audit ban đầu tại HEAD `f98c61bedcbf3d165178764f02b092d7dae089ac` cộng thay đổi SSE chưa commit. Bản cập nhật này kiểm lại tại HEAD `6ad53c0076d82858bdfe969c2b43b0f91a9860a3` (SSE đã được commit). Đây là đánh giá mã nguồn và tài liệu, chưa phải chấp thuận của Google. Không dùng bản ZIP cũ để nộp.

**Bổ sung sau khi xem Dashboard trực tiếp:** tab được cung cấp thuộc item WebMCP Tools Provider đã Published, không phải Translator. Form Store Listing đánh dấu **Store icon 128×128 và ít nhất một screenshot** là bắt buộc; screenshot nhận 1280×800 hoặc 640×400 JPEG/PNG 24-bit không alpha, tối đa 5 ảnh. Global promo video, small promo tile và marquee promo tile trên form đó không có dấu bắt buộc. Privacy policy URL là trường bắt buộc cho extension xử lý user data; Additional instructions của reviewer giới hạn 500 ký tự. Nội dung dán form và kịch bản ảnh ở [chrome-web-store-submission-content-2026-10-01.md](./chrome-web-store-submission-content-2026-10-01.md). Phải kiểm lại form của item Translator khi tạo item riêng.

## Kết luận nhanh

**Chưa sẵn sàng Submit for Review.** Nền tảng MV3, chức năng dịch (gồm SSE), cơ chế cấp quyền theo site, giới hạn tốc độ và lưu khóa trong trusted contexts đã có. Đã có **hai mockup ảnh Store tạm** 1280×800 (popup riêng; floating icon/widget riêng) theo yêu cầu owner, nhưng chưa đối chiếu với release candidate. Những chặn chính là (1) minh bạch và đồng ý xử lý dữ liệu theo chính sách có hiệu lực từ 2026-08-01, (2) chưa có privacy policy công khai và reviewer endpoint/key, (3) Base URL có thể dùng HTTP ngoài máy cục bộ trong khi UI khẳng định gửi dữ liệu “an toàn”, (4) ZIP hiện có thiếu icon và khác nguồn hiện tại, (5) chưa chứng minh được đường dùng của reviewer nếu họ không có 9router/API key. **Tại HEAD mới, 100/100 test đạt**, nhưng đó chưa là acceptance Store.

Google quyết định kết quả review; các việc dưới đây giảm rủi ro từ chối, không bảo đảm được duyệt hoặc bảo đảm thời gian duyệt. **Store nhận ZIP với `manifest.json` ở root**; CRX ký bằng dev key không phải artifact cần upload [S1, S2].

## Bằng chứng tại checkout

| ID | Mức | Quan sát | Tác động / việc cần xác nhận |
| --- | --- | --- | --- |
| F01 | **Blocker chính sách** | `extension/src/content.js:150-174` thu thập text nodes toàn trang; `extension/src/adapter/direct9router.mjs:340-410` gửi chúng cùng API key tới Base URL do người dùng cấu hình. `extension/src/popup.html:22-29` chỉ có icon với tooltip “gửi an toàn”; nút Dịch tại `popup.js:1861-1935` tự bật site rồi gửi, không có bản công bố rõ dữ liệu/đích nhận và hành động đồng ý riêng. | Chính sách 2026 yêu cầu công bố nổi bật việc thu thập **mọi** dữ liệu người dùng, mục đích dùng và đồng ý trước khi xử lý; nội dung website là user data [S3, S4, S5]. Cần thiết kế onboarding/consent lưu theo phiên bản disclosure, bao gồm auto-translate và fallback provider. |
| F02 | **Blocker hồ sơ** | Đã có bản nháp Store listing/Privacy/Test instructions và hai mockup ảnh 1280×800 trong `docs/`; chưa có privacy policy URL công khai, reviewer endpoint/key hoặc bản khai thật cho item Translator trong Dashboard. Ảnh dựng chưa được kiểm tính chính xác với ZIP cuối. | Chính sách yêu cầu privacy policy chính xác và link trong Dashboard; listing thiếu mô tả/icon/screenshot hoặc ảnh gây hiểu lầm có thể bị từ chối; Privacy tab phải giải thích quyền, dữ liệu và remote code [S6, S7, S8]. Bản nháp docs chưa phải bản khai đã lưu. |
| F03 | **Blocker đóng gói** | `dist-artifacts/webmcp-translator-kit-0.1.0.zip` tạo 2026-09-30 07:37 chỉ chứa 9 entry: không có `icons/`, `settings.mjs`, `permissions.mjs`, `cache.mjs`, `rate-limits.mjs`, `semaphore.mjs`, `sse-json.mjs`. Manifest trong ZIP tham chiếu icons và SW nhập các module đó. `scripts/build.mjs:18-32` chỉ copy src sang dist; ZIP hiện có không tương ứng source hiện tại. | ZIP cũ không phải release candidate chạy được. `npm run check:closure` kiểm tra package/tarball, **không** xác nhận ZIP Store. Build + ZIP mới, so sánh danh sách file và load chính ZIP đó trong Chrome trước upload [S1]. |
| F04 | **Blocker bảo mật / minh bạch** | `extension/src/settings.mjs:59`, `popup.html:152`, `popup.js:258-270`, `consent.mjs:21-30` chấp nhận `http://` bất kỳ; adapter gửi page text và Bearer key qua URL đó. Tooltip tại `popup.html:23` vẫn nói gửi “an toàn”. | Chỉ cho phép HTTPS cho server từ xa. Nếu giữ HTTP loopback phục vụ 9router cục bộ, xác minh host thực sự là localhost/loopback và mô tả ngoại lệ đó; không gọi mọi HTTP là an toàn. Google yêu cầu truyền user data an toàn; FAQ nêu ngoại lệ trao đổi với chương trình native trên cùng máy [S5, S9]. |
| F05 | **Rủi ro review cao** | Chức năng phụ thuộc user-configured 9router Base URL, API key và model (`README.md:3`, `settings.mjs:59-60`, `popup.html:136-211`). Chưa có tài khoản/test endpoint hoặc hướng dẫn cho reviewer. | Cần một cách reviewer thử dịch an toàn và ổn định; ghi Test instructions của Dashboard, dữ liệu thử giả, quyền cần bấm và expected result. Không đưa key production vào repo/ZIP. Google có tab Test instructions khi cần [S2]. |
| F06 | **Rủi ro quyền** | Manifest `extension/src/manifest.json:6-12` dùng `activeTab`, `scripting`, `storage` và optional `http://*/*`, `https://*/*`. Code xin origin cụ thể khi người dùng bật site hoặc kết nối provider (`popup.js:617-618`, `1330-1375`, `1450-1471`). | Cấu trúc on-demand là điểm tốt, nhưng wildcard optional vẫn phải chứng minh là phạm vi hẹp nhất khả thi cho công cụ dịch site/endpoint tùy chọn. Ghi justification cho từng quyền và bằng chứng chỉ xin origin được chọn; bỏ quyền dư nếu tìm được [S8, S10]. Không mặc định wildcard là vi phạm. |
| F07 | **Rủi ro trải nghiệm / bất ngờ** | `popup.js:449-457` khi tab hiện tại không hỗ trợ sẽ tìm tab HTTP(S) khác và có thể dùng tab đó làm đích Dịch. `popup.js:1860-1904` tự bật site lâu dài khi bấm Dịch một lần. | Chỉ thao tác tab người dùng đang xem, hoặc cho chọn rõ đích. Phân biệt “dịch một lần” với “luôn cho phép trên site”; công bố auto-start và cách tắt/xóa site [S3, S11]. |
| F08 | **Rủi ro dữ liệu** | `sw.js:1939-2091` lưu API key/fallback keys trong `chrome.storage.local`; `sw.js:421-474` cố hạn chế content script bằng `TRUSTED_CONTEXTS`. `contract/lifecycle.md:108-117` mô tả fail closed. | Giữ gate hiện có, xác minh không có key trong log/error/ZIP, kiểm tra clear/uninstall, chính sách lưu trữ và rủi ro key ở Chrome profile. Privacy policy phải nói đúng phương thức lưu, thời gian và xóa; không tuyên bố mã hóa at rest nếu chưa chứng minh [S5, S9, S12]. |
| F09 | **Rủi ro identity/release** | `manifest.json:5` có public `key` dev cố định; `docs/packaging.md:10-24` và `scripts/pack-ext.mjs:209-225` giả định ID `feicbphhimmhddfdlahlfmhkhodkdffl`. | Store gán Item ID khi upload. Xác minh Item ID trong Dashboard trước khi chốt key/ID và các kết nối chéo. Tài liệu chính thức hướng dẫn lấy public key từ Dashboard rồi so ID ở `chrome://extensions` [S13]. Không hứa dev ID hiện tại chính là Store ID. |
| F10 | **Rủi ro chất lượng** | Popup dùng tiếng Việt (`popup.html:2`) nhưng manifest name/description là tiếng Anh, mô tả “Kit / Direct mode / 9router” mang tính kỹ thuật; `README.md:3` cũng chỉ hướng dev. Một số biến điều khiển consent trong `popup.js:59-63` trỏ đến ID không có trong HTML. | Chọn ngôn ngữ listing phù hợp, mô tả lợi ích/người dùng cần cung cấp endpoint, giới hạn site, dữ liệu gửi; đảm bảo UI consent nhìn thấy được. Kiểm tra toàn bộ màn hình/khả năng truy cập từ ZIP mới [S7, S11]. |
| F11 | **Đã cải thiện, vẫn cần release gate** | Audit đầu: `npm test` có test SSE mới lỗi. Sau commit `6ad53c0`: `npm test` = **100 pass, 0 fail**, `check:contract` = `CONTRACT_OK`, `check:closure` = `CLOSURE_OK`; `extension/src` và `extension/dist` trùng nhau khi kiểm tra. | Duy trì test xanh trên ZIP release candidate và chạy manual smoke/ảnh Store. `check:closure` không chứng minh ZIP Store; chưa chạy `test:smoke:real` với provider thật. |
| F12 | **Chưa xác minh ngoài repo** | Đã xem Dashboard của item **WebMCP Tools Provider** trong publisher `hieu2906090`; chưa thấy item Translator hoặc xác minh trang privacy/support công khai, policy của 9router/provider downstream, screenshot Translator và test credentials. | Chủ tài khoản phải xác nhận item Translator đúng publisher, email/2-step verification, phạm vi phân phối, điều khoản 9router/provider và dữ liệu retention của họ. Chỉ khai Privacy fields theo flow thực tế đã kiểm chứng [S2, S8, S14]. |
| F13 | **Tính năng hiện có, chờ acceptance release** | `adapter/direct9router.mjs:350-405,554-724` yêu cầu streaming và xử lý SSE nếu endpoint trả `text/event-stream`; `sw.js:1446-1460` chuyển kết quả từng item sang tab; `content.js:1823-1865` áp dụng từng đoạn. JSON thường vẫn dùng nhánh cũ. Test adapter/parser SSE và test SW progress đều đạt tại HEAD mới; local SSE fixture đã cho thấy trang được dịch trong Chrome. Ảnh người dùng cung cấp ghi `Đang dịch 16/110 nodes` với phần đầu đã dịch, phần sau còn tiếng Trung. | Listing có thể mô tả “hiển thị từng đoạn khi dịch vụ hỗ trợ stream”; ảnh tĩnh chứng minh hiển thị dần nhưng không tự chứng minh transport SSE. Không hứa stream với mọi model/provider. Ảnh Store cuối phải đúng kích thước và gắn với ZIP release candidate. |

### Điểm đã phù hợp một phần

- Manifest V3, background service worker module, code JS đi kèm extension; chưa thấy cơ chế tải và thực thi mã từ xa. Gọi model để xử lý dữ liệu không tự nó là remote hosted code; kiểm tra lại ZIP cuối cùng theo [S15].
- Không có static content scripts; đăng ký script theo origin đã cấp quyền (`sw.js:1084-1151`). Consent mặc định OFF (`consent.mjs:52-93`), có rate limits và cache ngắn hạn. Những điểm này giúp giải thích quyền và luồng dữ liệu, nhưng **không thay thế** disclosure/consent theo chính sách.
- Có icon 16/32/48/128 trong **source**; bản ZIP cũ không chứa chúng. Icon 512 source là tùy chọn, không phải bằng chứng asset Store đã hoàn thiện.

## Kế hoạch thực hiện theo thứ tự ngắn nhất tới bản nộp

**Quy tắc thực thi:** đây là plan, chưa phải sửa runtime hoặc phát hành. SSE đã được owner commit; trước khi sửa tiếp cần pin lại HEAD, `git status --short` và danh sách file được phép sửa. Không reset/stash/clean hoặc build vào `extension/dist` nếu có công việc khác đang dùng. Reviewer kiểm tra chính xác cùng tree/ZIP mà writer tạo.

### P0 — Chốt contract dữ liệu và consent (writer: extension; reviewer: privacy/security)

- [ ] Ghi data map 1 trang: văn bản DOM được chọn, origin site, model/endpoint, API key, cache, local storage, error/log; ai nhận dữ liệu (9router và các provider downstream), khi nào gửi, bao lâu giữ, cách xóa. Phân biệt dữ liệu tại máy người dùng, tại 9router và tại provider; xác minh các cam kết retention trước khi viết policy.
- [ ] Chọn một mục đích duy nhất: “dịch nội dung văn bản của trang web mà người dùng chọn sang ngôn ngữ đích”. Bỏ marketing về khả năng ngoài mục đích này. Không dùng extension để né safety guardrails hay giới hạn của dịch vụ AI [S3].
- [ ] Thêm disclosure dễ thấy **trước lần dịch đầu**: loại dữ liệu trang được gửi, đích Base URL/provider, khả năng có thông tin nhạy cảm trong trang, mô hình dùng, chế độ auto, quyền site, liên kết privacy policy. Người dùng chủ động chấp nhận; lưu version/timestamp của disclosure. Khi thay đổi cách xử lý dữ liệu, hiển thị disclosure lại [S3, S4].
- [ ] Tách hành động “Dịch trang này” khỏi “Bật dịch tự động cho site”; chỉ auto-start sau lựa chọn riêng có mô tả rõ. Thao tác OFF và revoke permission phải dừng request đang chạy; xác nhận bằng test âm tính.
- [ ] Loại bỏ việc chọn ngầm tab HTTP khác; nếu tab hiện tại không hỗ trợ thì chỉ báo trạng thái. Thử khi popup mở từ `chrome://extensions`, New Tab và cửa sổ nhiều tab.
- [ ] Validate endpoint tại một điểm chung trước `models` và `chat/completions`: HTTPS cho remote; HTTP chỉ dành cho loopback thật sự nếu sản phẩm giữ tích hợp native local. Chặn protocol lạ, userinfo, URL đáng ngờ và redirect làm đổi origin/đích nhận key; xác minh theo hành vi fetch thật. Sửa tooltip “gửi an toàn” thành mô tả đúng.
- [ ] Chốt cách lưu API key: giữ `storage.local` với mô tả rủi ro chính xác hoặc chuyển sang session-only nếu không thể chứng minh xử lý at rest phù hợp. Test key không thể đọc từ content script và bị xóa khi người dùng chọn Xóa key/gỡ extension; không thêm lớp mã hóa bằng khóa hardcode trong extension.
- [ ] Thử bằng fixture chứa tên/email và trang có form/`contenteditable`: chỉ text node cần dịch được gửi sau consent; không gửi input/password/form fields; OFF/deny/revoke làm 0 network requests. Test cả fallback khác origin để tránh chuyển dữ liệu/key bất ngờ.

### P1 — Hồ sơ Store và hỗ trợ reviewer (writer: product/publisher; reviewer: policy)

- [ ] Đăng privacy policy tại URL HTTPS công khai do publisher kiểm soát; ghi dữ liệu thu thập, mục đích, bên nhận theo loại endpoint, storage, retention, xóa, bảo mật, liên hệ, Limited Use statement. Link cùng URL trong UI và Privacy tab. Tránh tuyên bố “không thu thập dữ liệu” vì extension đọc/gửi nội dung trang [S5, S6].
- [ ] Dùng bản nháp trong `docs/chrome-web-store-submission-content-2026-10-01.md` để chốt Store listing bằng ngôn ngữ phù hợp: tên, mô tả ngắn đúng manifest (tối đa 132 ký tự), mô tả dài một mục đích, điều kiện cần 9router/API key, quyền từng site và endpoint, auto mode, hỗ trợ, và hiển thị dần khi SSE được xác minh. Không dùng từ khóa spam hoặc claim bảo mật/riêng tư vượt bằng chứng [S7, S11].
- [x] Đã tạo **hai mockup ảnh tạm**, phiên bản mới làm mờ chữ trang nền để nổi UI: `translator-store-popup-v3-blurred-1280x800.jpg` và `translator-store-floating-v3-blurred-1280x800.jpg` trong `docs/store-assets/`; JPEG 1280×800 RGB không alpha. Bản v1/v2 được giữ làm tham khảo.
- [ ] Trước khi đưa ảnh dựng vào Store, so popup/widget, câu chữ và tiến trình hiển thị với build/ZIP cuối; sửa hoặc thay nếu khác đáng kể. Xác nhận icon 128×128 và không lộ key. Small promo tile 440×280, marquee và video hiện **không bắt buộc** trên form đã xem; chỉ làm nếu Dashboard của item Translator yêu cầu hoặc có lợi ích rõ [S7, S16].
- [ ] Điền Privacy practices: single purpose, justification `activeTab` / `scripting` / `storage` / optional hosts, loại dữ liệu (website content; các loại khác theo data map), third-party transfer, Limited Use certification, remote code = No **chỉ sau** khi kiểm tra ZIP không có remote execution, URL policy. Bảng khai phải khớp code và policy [S8, S15].
- [ ] Chuẩn bị Test instructions cho reviewer: trang công khai/fixture không nhạy cảm, đường dẫn thao tác, endpoint + tài khoản hoặc key thử có hạn mức và thời hạn đủ cho review, model, expected translation, cách test bật/tắt auto/restore, xử lý khi dịch vụ gián đoạn. Form đang xem có ô Username/Password và Additional instructions tối đa 500 ký tự. Đưa secret chỉ vào kênh Dashboard thích hợp, không lưu trong Git, ảnh chụp hoặc ZIP [S2].
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
