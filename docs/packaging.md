# Hướng Dẫn Đóng Gói và Triển Khai (Packaging & Deployment)

Tài liệu này mô tả chi tiết quy trình đóng gói, bảo mật khóa ký số (dev signing key), hướng dẫn cài đặt dev trên các môi trường Chrome, và quy trình rollback của **WebMCP Translator Kit**.

---

## 1. Tổng Quan Artifacts Đóng Gói

Quá trình đóng gói sinh ra 2 định dạng tại thư mục `dist-artifacts/`:
1. **CRX3 signed container** (`webmcp-translator-kit-<version>.crx`):
   - Chuẩn Chromium CRX version 3 (magic `Cr24`, container version 3).
   - Ký số RSA-SHA256 với dev private key bên ngoài repo.
   - Chứa header protobuf mã hóa tối thiểu (`CrxFileHeader`, `AsymmetricKeyProof`, `SignedData`).
   - Cố định Extension ID: `feicbphhimmhddfdlahlfmhkhodkdffl` (trùng khớp với trường `key` trong `manifest.json`).
2. **ZIP archive** (`webmcp-translator-kit-<version>.zip`):
   - Nén toàn bộ nội dung từ `extension/dist/`.
   - `manifest.json` nằm trực tiếp tại **root** của file zip, sẵn sàng giải nén để dùng tính năng **Load unpacked**.

Thư mục `dist-artifacts/` đã được cấu hình trong `.gitignore` để tránh đưa artifacts nhị phân vào Git history.

---

## 2. Quy Trình Build và Đóng Gói

### Bước 1: Build extension từ mã nguồn
```bash
npm run build
```
- Biên dịch mã nguồn từ `extension/src/` sang `extension/dist/`.
- Đồng bộ trường `version` trong `manifest.json` khớp với `package.json`.
- Kiểm tra tính hợp lệ của manifest (`manifest_version: 3`, permissions `activeTab`, `scripting`, `storage`, background module, cố định public `key`).

### Bước 2: Đóng gói artifacts với Dev Signing Key
Script đóng gói yêu cầu cung cấp đường dẫn tới private key RSA (định dạng PEM) thông qua biến môi trường `TRANSLATOR_SIGNING_KEY` hoặc cờ CLI `--key`:

```bash
# Cách 1: Sử dụng biến môi trường (khuyến nghị cho CI/CD hoặc shell session)
TRANSLATOR_SIGNING_KEY=/path/to/temp/translator-dev-keys/translator-dev-key.pem npm run pack:ext

# Cách 2: Sử dụng cờ --key qua npm run
npm run pack:ext -- --key /path/to/temp/translator-dev-keys/translator-dev-key.pem

# Cách 3: Chạy trực tiếp qua node
node scripts/pack-ext.mjs --key /path/to/temp/translator-dev-keys/translator-dev-key.pem
```

#### Quy trình tự xác thực (Self-verify) tự động:
Khi chạy `pack:ext`, script sẽ tự động thực hiện chuỗi kiểm tra bắt buộc (nếu bất kỳ bước nào lỗi, script sẽ thoát với exit code `1`):
1. Tự động gọi `scripts/build.mjs` để làm mới `extension/dist/`.
2. Tạo file ZIP và kiểm tra bằng `/usr/bin/unzip -l` để đảm bảo `manifest.json` nằm ở root level.
3. Trích xuất public key DER từ file PEM bằng `openssl pkey -pubout -outform DER`.
4. Tính toán Extension ID và so khớp với ID dev cố định `feicbphhimmhddfdlahlfmhkhodkdffl` và trường `key` trong `manifest.json`.
5. Tạo CRX3 header protobuf và ký RSA-SHA256 bằng `openssl dgst -sha256 -sign`.
6. Parse ngược file CRX3 vừa ghi, trích xuất archive zip và so sánh byte-for-byte với file ZIP gốc.
7. Dùng `openssl dgst -sha256 -keyform DER -verify` kiểm tra chữ ký trên envelope dữ liệu (`CRX3 SignedData\0` + length + signed_header_data + zip payload).
8. In mã băm SHA256, kích thước file và marker `PACK_OK`.

---

## 3. Quản Lý Khóa Ký Phát Triển (Dev Signing Key)

Khóa riêng phát triển (`translator-dev-key.pem`) là thành phần bảo mật cốt lõi để cố định Extension ID:

- **Vị trí**: Luôn lưu trữ ở **bên ngoài repo** (ví dụ: `temp/translator-dev-keys/translator-dev-key.pem`).
- **Phân quyền tập tin**: Phải đặt quyền nghiêm ngặt `0600`:
  ```bash
  chmod 600 /path/to/temp/translator-dev-keys/translator-dev-key.pem
  ```
- **Quy tắc bất di bất dịch**:
  - Tuyệt đối **KHÔNG** copy file key vào trong thư mục repo hay thư mục build.
  - Tuyệt đối **KHÔNG** commit file key vào Git.
  - Tuyệt đối **KHÔNG** đóng gói file key vào file ZIP hay file CRX.
  - Script đóng gói `scripts/pack-ext.mjs` chỉ đọc key tại runtime qua đường dẫn được truyền vào và **không tự ý tạo key mới**.

> [!WARNING] Cảnh báo quan trọng về Extension ID
> Extension ID `feicbphhimmhddfdlahlfmhkhodkdffl` được suy ra trực tiếp từ khóa công khai của private key này.
> Nếu làm mất khóa hoặc sinh lại khóa mới:
> 1. Extension ID sẽ thay đổi hoàn toàn.
> 2. Toàn bộ cấu hình lưu trữ cục bộ (`chrome.storage.local`) sẽ bị cô lập/mất liên kết.
> 3. Quyền giao tiếp chéo giữa các extension (`externally_connectable` từ phía `webmcp-automation-kit`) sẽ bị từ chối do ID không còn khớp.

---

## 4. Hướng Dẫn Cài Đặt Trong Môi Trường Dev (Dev Install)

Tùy vào môi trường thử nghiệm và phiên bản Chrome, áp dụng phương thức phù hợp:

### A. Chrome for Testing (Khuyến nghị cho Automation/E2E)
Chrome for Testing hỗ trợ nạp trực tiếp các extension chưa đóng gói thông qua cờ dòng lệnh `--load-extension`.

Khi chạy đồng thời cả **WebMCP Automation Kit** và **WebMCP Translator Kit**, cần khai báo **duy nhất một cờ** `--load-extension` với các đường dẫn phân cách bằng dấu phẩy:

```bash
chrome \
  --load-extension="/path/to/webmcp-automation-runner/dist,/path/to/webmcp-translator-kit/extension/dist" \
  --user-data-dir="/tmp/chrome-test-profile"
```

*Lưu ý: Không khai báo nhiều cờ `--load-extension` riêng rẽ vì cờ sau sẽ ghi đè cờ trước trong Chrome.*

### B. Chrome Stable (Phiên bản ≥ M137)
Từ phiên bản Chrome hiện đại (M137+), Chrome siết chặt chính sách bảo mật:
- **Load unpacked (Khuyến nghị)**:
  1. Mở trình duyệt và truy cập `chrome://extensions/`.
  2. Bật công tắc **Developer mode** ở góc trên bên phải.
  3. Bấm **Load unpacked** (Tải tiện ích đã giải nén).
  4. Trỏ vào thư mục `packages/webmcp-translator-kit/extension/dist` (hoặc thư mục giải nén từ file `dist-artifacts/webmcp-translator-kit-<version>.zip`).
  5. Xác nhận extension hiển thị với ID chính xác: `feicbphhimmhddfdlahlfmhkhodkdffl`.
- **Cài đặt file CRX**:
  - Trên Chrome Stable, thao tác kéo-thả file `.crx` trực tiếp từ bên ngoài vào cửa sổ trình duyệt bị chặn theo mặc định để ngăn mã độc.
  - File CRX3 phục vụ cài đặt qua chính sách doanh nghiệp (Enterprise Policy như `ExtensionInstallForcelist` / `ExtensionInstallSources`) hoặc triển khai qua máy chủ phân phối nội bộ được ủy quyền.

---

## 5. Quy Trình Rollback & Gỡ Bỏ (Uninstall / Rollback)

Khi cần hoàn nguyên hoặc gỡ bỏ extension trong quá trình kiểm thử hoặc phát triển:

### 1. Gỡ bỏ thủ công trên Chrome UI
1. Mở `chrome://extensions/`.
2. Tìm thẻ **WebMCP Translator Kit** (ID: `feicbphhimmhddfdlahlfmhkhodkdffl`).
3. Gạt tắt toggle để vô hiệu hóa tạm thời, hoặc nhấn nút **Remove** (Xóa) để gỡ hoàn toàn.
4. Xác nhận gỡ bỏ trên modal xác nhận của trình duyệt. Toàn bộ dữ liệu `chrome.storage.local` liên kết với extension sẽ được dọn dẹp.

### 2. Dọn dẹp môi trường tự động (Chrome for Testing / Puppeteer / Playwright)
- Loại bỏ đường dẫn của extension khỏi đối số `--load-extension` khi khởi động trình duyệt.
- Xóa thư mục profile tạm thời (`--user-data-dir`) nếu muốn khởi tạo lại môi trường thử nghiệm hoàn toàn trắng:
  ```bash
  rm -rf /tmp/chrome-test-profile
  ```

### 3. Dọn dẹp artifacts đóng gói
Để làm sạch các artifacts đã tạo:
```bash
rm -rf dist-artifacts/
```
Thư mục `dist-artifacts/` có thể được tái tạo lại bất kỳ lúc nào bằng lệnh `npm run pack:ext`.
