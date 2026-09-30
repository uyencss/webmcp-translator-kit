# Translator Kit — Quality Corpus & Evaluation Harness (Zh → Vi)

## 1. Corpus Overview

Tài liệu kiểm chuẩn chất lượng dịch thuật Trung → Việt cho WebMCP Translator Kit.

- **Nguồn**: Muse (2026-09-29) biên soạn thủ công (hand-written, không dùng máy dịch, không copy web).
- **Vị trí trong repo**: `fixtures/quality/corpus.json` (`schemaVersion: 1`).
- **Tổng số mục**: **52 items** chia làm 3 nhóm:
  1. `uiStrings` (22 items): Chuỗi giao diện ngắn (nút bấm, toast, tab điều hướng, placeholder form, nhãn thông báo lỗi).
  2. `sentences` (22 items): Câu hoàn chỉnh chứa markup HTML (`<b>`, `<a href>`, `<span class>`, `<br>`), template variables (`{count}`, `{{name}}`), định dạng printf (`%s`, `%d`), token vị trí (`$1`), số liệu kỹ thuật, đơn vị tiền tệ (`¥`), dung lượng (`MB`, `GB`), và emoji (`🎉`).
  3. `tricky` (8 items): Các trường hợp thử thách ngữ nghĩa, tiếng lóng internet (`一键三连`, `真香`), câu ghép nhiều vế logic, đại từ mơ hồ (`他`), danh từ ghép không ngắt, chuyển đổi đơn vị (`亩`), văn phong quảng cáo và pháp lý.

---

## 2. Tiêu chí đánh giá chất lượng (P3' Quality Gates)

Hệ thống đánh giá chia làm **Hard Gates** (tự động chấm đạt/hỏng dứt khoát) và **Manual Scoring** (để người đánh giá ngữ nghĩa):

| Loại kiểm tra | Tiêu chí | Ngưỡng đạt | Hành động khi vi phạm |
|---|---|---|---|
| **Token Preservation** | Tất cả thẻ HTML (`<b>`, `<a>`, `<br>`), biến nội suy (`{...}`, `{{...}}`), định dạng printf (`%s`, `%d`), token `$1`, và số liệu kỹ thuật bất biến. | 0 token bị mất | **HARD FAIL** |
| **Residual CJK (Chữ Hán)** | Bản dịch tiếng Việt không được sót ký tự chữ Hán (Hanzi: `[\u4e00-\u9fff...]`). | 0 chữ Hán còn sót | **HARD FAIL** |
| **Control Characters** | Không chứa ký tự điều khiển ẩn (`[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]`). | 0 ký tự điều khiển | **HARD FAIL** |
| **Length Ratio (Tỉ lệ độ dài)** | Tỉ lệ số ký tự đích/nguồn (`target.length / zh.length`). Thông thường chuỗi tiếng Việt dài hơn tiếng Trung từ `0.4x` đến `6.5x`. | Nằm trong khoảng `[0.4, 6.5]` | **SOFT WARNING** (`WARN_RATIO`) |
| **Semantic Accuracy (Ngữ nghĩa)** | Độ tự nhiên, chính xác, đúng ngữ cảnh app/web Việt Nam. | Thang điểm 0–2 do reviewer điền | **MANUAL REVIEW** |

### Thang điểm đánh giá thủ công (Manual Score 0–2):
- **0 điểm**: Dịch sai nghĩa hoàn toàn, câu vô nghĩa, vỡ cấu trúc không sử dụng được.
- **1 điểm**: Hiểu được nội dung cơ bản nhưng câu văn gượng gạo, dùng sai thuật ngữ phổ biến của app Việt.
- **2 điểm**: Bản dịch tự nhiên, chuẩn văn phong giao diện tiếng Việt, truyền tải trọn vẹn sắc thái câu gốc.

---

## 3. Cách chạy Harness (`test/quality/run.mjs`)

Harness được viết bằng Node.js thuần (không thêm npm dependency ngoài).

### Chế độ 1: Offline Validation (Mặc định)
Kiểm tra cấu trúc và tính toàn vẹn của corpus:
- Đọc và xác thực `fixtures/quality/corpus.json` đủ 52 mục trên 3 nhóm (`schemaVersion: 1`).
- Giả lập cơ chế bọc/gỡ placeholder (round-trip masking simulation) trên từng câu nguồn `zh`.
- So khớp source ↔ target mẫu (`expectedVi`): đảm bảo bản dịch mẫu bảo toàn 100% token, không chứa chữ Hán, không chứa ký tự điều khiển, và có tỉ lệ độ dài hợp lý.

```bash
node test/quality/run.mjs
```

### Chế độ 2: Live Evaluation (Opt-in qua `--live`)
Gọi trực tiếp đến 9router (OpenAI-compatible `/chat/completions`) với model `ag/gemini-3.1-pro-low`.
- Tự động chia batch ≤ 20 items/request theo đúng contract song ánh (`id` ↔ `text`).
- Tự động chấm điểm các cổng Hard Gates (Token preservation, CJK-remaining, Control characters) và cảnh báo tỉ lệ độ dài (Length ratio).
- Xuất báo cáo chi tiết ra `test/quality/out/report-<timestamp>.json` và `test/quality/out/report-<timestamp>.md` có kèm cột `Manual Score (0–2)` để reviewer điền.

#### Khi chưa có biến môi trường (Skip sạch với exit 0):
```bash
node test/quality/run.mjs --live
```
*Kết quả:* Thông báo bỏ qua an toàn với exit code 0.

#### Khi chạy thực tế với router:
```bash
export NINE_ROUTER_BASE_URL="https://router.example.com/v1"
export NINE_ROUTER_TOKEN="your-secret-token"

node test/quality/run.mjs --live
```
*(Lưu ý: Không bao giờ commit hay in token ra console / báo cáo).*
