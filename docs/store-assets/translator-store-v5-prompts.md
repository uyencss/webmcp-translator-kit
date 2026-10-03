# Store images v5 — current Chrome UI, 2026-10-03

Generated with built-in ImageGen after inspecting the live extension in Chrome profile hieu (main). Four main tabs observed: Dịch, Tự động, Cấu hình, Nhật ký. Appearance settings are in Cấu hình → Giao diện. Floating widget now has a model selector and the active icon has a green dot. No settings or credentials were changed. Synthetic example.com replaces the real site in the auto-site mockup.

All four selected exports are 1280×800 RGB JPEG without alpha. The left column retains two equal-height sections, Chinese above and Vietnamese below, with small gray image placeholders. These are generated illustrations, not captures. Error/progress values reproduce the observed UI state and are not performance claims.

## 01-translate

[Image](./translator-store-v5-01-translate-1280x800.jpg)

Exact prompt:

```text
Horizontal 16:10 Chrome Web Store generated product illustration, final 1280x800. LEFT 60% width MUST be exactly TWO equal-height sections, Chinese original on top and matching Vietnamese translation below. Thin horizontal divider at mid-height. White background, clean readable moderate-sized text, generous spacing, one SMALL gray 60px image placeholder per section, NO photos. Top label 'Tiếng Trung', title '城市里的小花园', sentences '城市里的小花园让生活更加美好。' and '人们在这里种花，也分享种植的经验。'. Bottom label 'Tiếng Việt', title 'Khu vườn nhỏ trong thành phố', sentences 'Những khu vườn nhỏ trong thành phố làm cuộc sống tốt đẹp hơn.' and 'Mọi người trồng hoa ở đây và chia sẻ kinh nghiệm làm vườn.'. Do not blur text. Main subjects are translated text and extension UI. RIGHT 40% reserved for large sharp accurate UI. No real novel content, browser chrome, URL bar, personal details, secrets, watermark, marketing headlines. Match CURRENT Chrome UI just observed in the recent screenshot references: deep black/navy popup, subtle borders, blue accents, header translation glyph plus 'WebMCP Translator', shield and 'DIRECT' pill. Four navigation tabs with icons exactly 'Dịch', 'Tự động', 'Cấu hình', 'Nhật ký' (not the old three-tab UI). Footer 'WebMCP Translator · v0.1.0' and a compact progress status. Image 1: show only CURRENT Dịch tab popup at right, no floating widget/icon. Dịch selected with blue underline. One rounded main panel contains labels NGUỒN and ĐÍCH, dropdowns '🌐 Tự động (auto)' and '🇻🇳 Tiếng Việt (vi)', buttons blue 'Dịch trang' and gray 'Khôi phục'. NO floating-icon toggle in this tab: that toggle now lives in Cấu hình/Giao diện. No separate large status box; compact footer status. Faithful screenshot-style controls, not invented redesign. Use the recent actual Chrome screenshots as the UI reference, while constructing the exact simple two-section comparison left.
```

## 02-auto-site

[Image](./translator-store-v5-02-auto-site-1280x800.jpg)

Exact prompt:

```text
Horizontal 16:10 Chrome Web Store generated product illustration, final 1280x800. LEFT 60% width MUST be exactly TWO equal-height sections, Chinese original on top and matching Vietnamese translation below. Thin horizontal divider at mid-height. White background, clean readable moderate-sized text, generous spacing, one SMALL gray 60px image placeholder per section, NO photos. Top label 'Tiếng Trung', title '城市里的小花园', sentences '城市里的小花园让生活更加美好。' and '人们在这里种花，也分享种植的经验。'. Bottom label 'Tiếng Việt', title 'Khu vườn nhỏ trong thành phố', sentences 'Những khu vườn nhỏ trong thành phố làm cuộc sống tốt đẹp hơn.' and 'Mọi người trồng hoa ở đây và chia sẻ kinh nghiệm làm vườn.'. Do not blur text. Main subjects are translated text and extension UI. RIGHT 40% reserved for large sharp accurate UI. No real novel content, browser chrome, URL bar, personal details, secrets, watermark, marketing headlines. Match CURRENT Chrome UI just observed in the recent screenshot references: deep black/navy popup, subtle borders, blue accents, header translation glyph plus 'WebMCP Translator', shield and 'DIRECT' pill. Four navigation tabs with icons exactly 'Dịch', 'Tự động', 'Cấu hình', 'Nhật ký' (not the old three-tab UI). Footer 'WebMCP Translator · v0.1.0' and a compact progress status. Image 2: CURRENT Tự động tab selected. Match the actual recent Tự động screenshot: heading 'TỰ ĐỘNG DỊCH THEO SITE' and compact + add button at upper right; ONE compact site card with green dot, a synthetic site label 'https://example.com', mode dropdown 'Đuổi scroll', blue auto-start toggle, green power icon, trash icon. Below in same card, source dropdown 'Theo chung', arrow, target '🇻🇳 Tiếng Việt (vi)', and per-site model dropdown 'ag/gemini-3.8-flash'. Do not invent explanatory paragraphs or buttons. Dark popup and four tabs exactly as current screenshot. No widget/icon outside popup. Small gray placeholders on left must contain only image glyph, NO literal dimension labels. Use current screenshots, not obsolete 3-tab UI.
```

## 03-appearance

[Image](./translator-store-v5-03-appearance-1280x800.jpg)

Exact prompt:

```text
Horizontal 16:10 Chrome Web Store generated product illustration, final 1280x800. LEFT 60% width MUST be exactly TWO equal-height sections, Chinese original on top and matching Vietnamese translation below. Thin horizontal divider at mid-height. White background, clean readable moderate-sized text, generous spacing, one SMALL gray 60px image placeholder per section, NO photos. Top label 'Tiếng Trung', title '城市里的小花园', sentences '城市里的小花园让生活更加美好。' and '人们在这里种花，也分享种植的经验。'. Bottom label 'Tiếng Việt', title 'Khu vườn nhỏ trong thành phố', sentences 'Những khu vườn nhỏ trong thành phố làm cuộc sống tốt đẹp hơn.' and 'Mọi người trồng hoa ở đây và chia sẻ kinh nghiệm làm vườn.'. Do not blur text. Main subjects are translated text and extension UI. RIGHT 40% reserved for large sharp accurate UI. No real novel content, browser chrome, URL bar, personal details, secrets, watermark, marketing headlines. Match CURRENT Chrome UI just observed in the recent screenshot references: deep black/navy popup, subtle borders, blue accents, header translation glyph plus 'WebMCP Translator', shield and 'DIRECT' pill. Four navigation tabs with icons exactly 'Dịch', 'Tự động', 'Cấu hình', 'Nhật ký' (not the old three-tab UI). Footer 'WebMCP Translator · v0.1.0' and a compact progress status. Image 3: faithfully render CURRENT Cấu hình tab selected and inner subtab Giao diện selected. Use LAST screenshot as exact UI reference, not obsolete designs. Inner subtabs 'Kết nối', 'Giao diện', 'Yêu thích'. Fields stacked: label 'NGÔN NGỮ HIỂN THỊ' dropdown 'Tiếng Việt (vi)'; blue checked toggle 'Hiện icon nổi trên trang'; label 'GIAO DIỆN' dropdown 'Tối (Dark)'; label 'CỠ CHỮ' dropdown 'Nhỏ'; bottom version row 'Phiên bản' and 'v0.1.0'. Compact footer. No popup translation buttons in this view; no widget/icon outside popup. No image dimensions printed inside left placeholders. Match simple comparison layout of previous generated images.
```

## 04-floating-model

[Image](./translator-store-v5-04-floating-model-1280x800.jpg)

Exact prompt:

```text
Horizontal 16:10 Chrome Web Store generated product illustration, final 1280x800. LEFT 60% width MUST be exactly TWO equal-height sections, Chinese original on top and matching Vietnamese translation below. Thin horizontal divider at mid-height. White background, clean readable moderate-sized text, generous spacing, one SMALL gray 60px image placeholder per section, NO photos. Top label 'Tiếng Trung', title '城市里的小花园', sentences '城市里的小花园让生活更加美好。' and '人们在这里种花，也分享种植的经验。'. Bottom label 'Tiếng Việt', title 'Khu vườn nhỏ trong thành phố', sentences 'Những khu vườn nhỏ trong thành phố làm cuộc sống tốt đẹp hơn.' and 'Mọi người trồng hoa ở đây và chia sẻ kinh nghiệm làm vườn.'. Do not blur text. Main subjects are translated text and extension UI. RIGHT 40% reserved for large sharp accurate UI. No real novel content, browser chrome, URL bar, personal details, secrets, watermark, marketing headlines. Image 4: CURRENT floating widget observed in Chrome. RIGHT has ONLY widget and separate blue circular floating translation icon below at lower-right, no popup navigation tabs or language selectors. Widget dark black/navy with subtle border, header 'WebMCP Translator' and X close. Status row 'Trạng thái:' with green pill 'Đang bật'. IMPORTANT NEW ROW immediately below status: label 'Mô hình' plus wide dropdown 'ag/gemini-3.8-flash' (this model selector is essential in current UI). Red full-width 'Tắt dịch tab này'; two radio modes 'Dịch đuổi theo scroll' selected blue and 'Dịch toàn trang'; side-by-side blue 'Dịch ngay' and gray 'Khôi phục'. Blue compact progress 'Đang dịch 93/108 nodes... (32 lỗi)' exactly matching actual observed example, muted footer 'Mở popup để cấu hình key/quyền/model'. Separate circular bright-blue icon white translation glyph, tiny GREEN status dot at top-right, not orange. Match actual CURRENT widget described, using old widget reference only for general styling; add model selector and green dot to bring it current. Left comparison same as other three images; no photographs or dimensions in placeholders. Sharp readable text and UI, accurate Vietnamese, no secrets, no fabricated controls.
```


