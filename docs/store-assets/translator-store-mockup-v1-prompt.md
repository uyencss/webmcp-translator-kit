# Translator Store mockup v1

- Mode: built-in ImageGen, one generated raster image with the user-provided SSE screenshot as **visual reference**, not an exact edit.
- Reference: `sse-progress-reference-2026-10-01.png`.
- Source output: `translator-store-mockup-v1-source.png` (1586×992, RGB).
- Store-size draft: `translator-store-mockup-v1-1280x800.jpg` (1280×800, RGB, no alpha); only resized and JPEG-encoded from the source output.
- Status: temporary generated mockup; verify against the final extension UI and Chrome Web Store listing policy before upload.

## Exact generation prompt

```text
Use case: ui-mockup. Create ONE horizontal 16:10 Chrome Web Store screenshot-style TEMPORARY MOCKUP for the WebMCP Translator extension. The supplied image is a VISUAL REFERENCE for composition and the actual extension UI only; do not reproduce the novel page, its wording, website branding, or exact pixels. Make a clean, credible, flat browser-extension product visual (not a 3D device mockup). Left ~70%: an original synthetic article on a warm ivory reading page about a small community garden, with the first three short paragraphs already translated into Vietnamese and a few lower paragraphs still in Chinese to communicate translation arriving progressively. Article headline exactly: 'Những khu vườn nhỏ trong thành phố'. Use only short original sample sentences. Right top: match the reference extension's black/navy popup shape and blue accents, with crisp large legible UI text exactly 'WebMCP Translator', tabs 'Dịch', 'Tự động', 'Kết nối', selectors 'Tự động (auto)' and 'Tiếng Việt (vi)', blue button 'Dịch trang', status 'Đang theo scroll'. Right bottom: match the dark floating widget from the reference, with title 'WebMCP Translator', green state 'Đang bật', blue progress 'Đang dịch 16/110 nodes...', and controls 'Dịch ngay' and 'Khôi phục'. Keep popup and widget distinct and fully visible, no overlap with article headline. Show honest incremental state and no secrets. Overall quiet editorial spacing, warm off-white reading area, deep navy extension controls, electric blue actions. Canvas intended for a 1280x800 Chrome Web Store asset, no alpha/transparent background, no logos or real third-party site content beyond WebMCP Translator, no watermarks, no fake browser address bar, no extra explanatory captions. Accurate Vietnamese diacritics and readable typography are critical.
```
