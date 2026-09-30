# Đo lường số lượng Batch khi dịch Viewport (Batch-count Measurement)

**Ngày đo:** 2026-09-30  
**Lớp kiểm thử:** P1'-C (Hardening + Lifecycle + Batch-count Gate)  
**Tác vụ:** Đo lường số lượng batch và độ trễ khi thực hiện dịch lượt đầu tiên trên viewport 20 node với limits mặc định của hợp đồng.

---

## 1. Cấu hình đo lường (Test Configuration)

- **Git Commit Hash:** `20cd4052d37df6fb5ecbc61bedd86a8127a9d68f`
- **Môi trường chạy:** macOS (Apple Silicon / arm64), Chrome for Testing headless (`--headless=new`)
- **Mô hình giả lập (Mock Provider):** `fake-9router` chạy tại `http://127.0.0.1:8089/v1`, model `ag/gemini-3.1-pro-low`
- **Fixture HTML:** `test/smoke/fixture-20nodes.html` (20 text nodes: 1 `<h1>` + 19 `<p>` chứa văn bản tiếng Trung, tổng dung lượng văn bản ~3.3 KB UTF-8)
- **Giới hạn hợp đồng mặc định (`contract/defaults.json`):**
  - **Tab rate limits:** `maxBatches: 4`, `maxSourceCodePoints: 12000` trong cửa sổ 60 giây.
  - **Site rate limits:** `maxBatches: 12`, `maxSourceCodePoints: 36000` trong cửa sổ 60 giây.
  - **Cửa sổ trượt (Sliding window):** 60 giây.
  - **Dung lượng hàng đợi tối đa (Max queue):** 10 yêu cầu.
  - **Độ tương tranh tối đa (Concurrency limit):** 2 luồng.
  - **Quy tắc phân mảnh batch (Chunking rules):** tối đa 64 items và tối đa 24 KiB UTF-8 mỗi batch (`content.js`).

---

## 2. Kết quả đo lường thực tế (Raw Metrics)

Dữ liệu được trích xuất từ lần chạy kiểm thử tự động `test/smoke/run.mjs` (step `MEASURE`):

| Chỉ số đo | Giá trị thực tế | Kỳ vọng / Ngưỡng Gate | Đánh giá |
|:---|:---:|:---:|:---:|
| **Số node DOM thu thập (`collected`)** | **20** | 20 | Khớp 100% |
| **Số node dịch & áp dụng thành công (`applied`)** | **20** | 20 | Hoàn tất |
| **Số node thất bại (`failed`)** | **0** | 0 | Không lỗi |
| **Số batch thực tế gửi đi (`batchesDispatched`)** | **1** | 1 – 2 (Gate: ≤ 4) | **ĐẠT** |
| **Số lượng item trong batch** | **20** | ≤ 64 items | Nằm gọn trong 1 batch |
| **Số lần bị `RATE_LIMITED`** | **0** | 0 | Không bị nghẽn |
| **Thời gian chờ queue (`queueWaitTimeMs`)** | **0 ms** | 0 ms | Trúng slot ngay lập tức |
| **Thời gian thực thi & patch DOM (`totalElapsedMs`)** | **6 ms** | < 1000 ms | Rất nhanh (mock provider) |

---

## 3. Kết luận Gate (Gate Evaluation)

> **Tiêu chí Gate P1'-C:** `batchesDispatched ≤ 4 batches / 60s` đối với 1 viewport 20 node trong lượt dịch đầu tiên.

- **Kết quả:** **ĐẠT (PASS)** — Hệ thống chỉ phân phát **1 batch duy nhất** chứa toàn bộ 20 phần tử văn bản của viewport.
- **Tác động hạn ngạch:**
  - Tab tiêu tốn: 1 / 4 batches (còn dư 3 batches dự phòng trong cửa sổ 60 giây).
  - Site tiêu tốn: 1 / 12 batches (còn dư 11 batches).
  - Không có hiện tượng gửi lắt nhắt từng node riêng lẻ gây cạn kiệt slot điều phối.

---

## 4. Hạn chế đo lường & Đề xuất (Limitations & Real-world Considerations)

1. **Fixture so với trang thực tế:**
   - Trong fixture, các đoạn văn là các khối văn bản độc lập nguyên vẹn (`<p>`). Trên các website tin tức hoặc tài liệu thực tế, DOM có thể chứa các thẻ định dạng inline lồng nhau (`<a>`, `<span>`, `<strong>`, `<code>`), trong đó một số thẻ (`<code>`, `<pre>`) sẽ bị bỏ qua theo danh sách skip-list.
   - Với những trang có mật độ văn bản rất dày đặc (ví dụ: > 64 node văn bản hiển thị đồng thời hoặc khối lượng UTF-8 vượt quá 24 KiB), bộ chia `chunkItems` sẽ tự động tách thành 2 hoặc 3 batch.
2. **Khuyến nghị điều chỉnh cấu hình:**
   - Không cần thay đổi giá trị mặc định của hợp đồng (`defaults.json`). Mức trần `4 batches / tab` hoàn toàn đủ sức chứa 1 đến 2 đợt dịch viewport hoàn chỉnh (mỗi đợt 1–2 batch) mà không gây ra bất kỳ lỗi `RATE_LIMITED` nào.
