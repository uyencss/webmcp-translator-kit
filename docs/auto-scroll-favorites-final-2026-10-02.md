# Kết quả sửa auto-scroll và favorites — 2026-10-02

Đã đưa bản đã nghiệm thu vào package gốc bằng fast-forward trên `main`.

- Commit: `36e5619710b0c1d106d7df6fc646670ee40d6341`.
- Tree: `5659184e70212d1c46a2def1d46aa2c7608427e6`.
- Build local: `extension/dist`, phiên bản 0.1.0.
- Manifest SHA-256: `0bd188f57961a032cc93c098a2799a6ff0ea033894ee14b1cd23971b60bd8e45`.

## Đã sửa

- Context extension cũ bị invalidated: chặn lỗi đồng bộ/callback, dừng session và interval, không lặp gửi lỗi.
- Auto-translate + scroll-follow: tự bắt đầu sau load/reload khi consent, host permission và key hợp lệ; state mới được kiểm tra authoritative và loại bỏ reply cũ.
- Thu hồi consent/quyền/key: hủy tác vụ đang chạy. Lỗi batch lifecycle hoặc nội dung giữ watcher nhưng không bị batch thành công bên cạnh gửi lại tự động.
- Footer popup: tiến độ applied/collected/failed cập nhật khi scroll, khi mở lại popup và sau hoàn thành một phần.
- Favorite model: lưu riêng theo provider Base URL, migrate settings v4→v5, không mất cấu hình khác; cập nhật desired-state được serialize với autosave; giới hạn 50 model/provider có lỗi rõ ràng.
- Đổi provider trong lúc lưu favorite không kéo scope hiển thị hoặc fallback kế thừa về provider cũ. Fallback dropdown giữ model đang chọn và cập nhật đúng favorites; autosave giữ object của hàng đang chỉnh.
- Recovery: terminal error sau retry và nhánh chia batch giữ cờ fatal, không tiếp tục gửi các nhánh không được phép retry.
- SSE progressive và JSON fallback được giữ tương thích.

## Kiểm tra và review

- Candidate và package gốc: Node tests **141/141 PASS**, `CONTRACT_OK`, `CLOSURE_OK`, build và diff check PASS.
- Chrome for Testing 150.0.7871.24: smoke v44 và smoke sau promotion đều **T1–T54 PASS**, exit 0; popup, load/navigation/reload, scroll-follow và SSE đều qua.
- Muse Contributor 1.3 qua WebMCP AI CLI → OpenCode: preaccept approve, không findings; advisory.
- Direct Claude Opus 5.5: final approve, không finding medium trở lên.
- Native Codex subagent Sol 6.1, reasoning high: final approve, không findings; xác minh độc lập commit/tree/patch và chạy 141 test.
- Hai final reviewer cùng nghiệm thu commit/tree nêu trên. Người dùng đã đổi gate Sol từ gpt-5.6-sol sang Sol 6.1 high; native subagent được dùng vì CLI account từ chối model ID Sol 6.1. Các lượt CLI hết quota/capacity không được tính là verdict.

## Giới hạn đã ghi nhận

- Node bị hoãn sau lỗi batch trong container scroll lồng nhau cần bắt đầu session mới để thử lại; window scroll giải phóng danh sách hoãn.
- Khi refresh URL của fallback, primary model có thể tạm hiện trong lựa chọn; model đã chọn và bucket lưu vẫn đúng.
- Chrome smoke dùng fixture/provider giả local; không xác nhận chất lượng dịch của provider thật hoặc trang truyện cụ thể.

## Bảo toàn dữ liệu và sử dụng

Người dùng đã cho phép reconcile/re-pin và promotion. Năm file Store đang sửa được kiểm tra SHA-256 trước/sau và giữ nguyên byte; không reset, stash hoặc ghi đè. Báo cáo này là tài liệu coordinator sau nghiệm thu, chưa commit và không thay đổi commit/tree source đã review.

Reload extension từ `extension/dist`, rồi reload trang để thay content script cũ. Favorites/settings hiện có được migrate và lưu tự động.

Chưa push, release hoặc submit Chrome Web Store.

## Hồ sơ bằng chứng

- [Acceptance record tại thời điểm đóng băng](auto-scroll-favorites-acceptance-2026-10-01.md).
- [Plan](../../../temp/translator-auto-scroll-favorites-20261001/plan.md).
- [Candidate ledger và hash từng receipt](../../../temp/translator-auto-scroll-favorites-20261001/candidate-ledger.md).
- Receipt directory: `/Users/ttcenter/Desktop/VIBE_CODE/temp/translator-auto-scroll-favorites-20261001/translator-kit/M4-acceptance/`.
- Owner smoke log SHA-256: `2295448712f09cf1acc4bf7af26db900c9915f14ab528bd9b894be9a1c7dd866`.
- Owner Node log SHA-256: `7f4abe110b5049b8960e98abc9a211dbaea583c00c3ccde6af8331ba3af1e7d5`.
