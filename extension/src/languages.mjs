// WebMCP Translator Kit — Languages Catalog
// Supported source and target languages with flags and display names

export const LANGS = Object.freeze([
  Object.freeze({ code: 'auto', flag: '🌐', name: 'Tự động', nameEn: 'Auto' }),
  Object.freeze({ code: 'vi', flag: '🇻🇳', name: 'Tiếng Việt', nameEn: 'Vietnamese' }),
  Object.freeze({ code: 'en', flag: '🇬🇧', name: 'Tiếng Anh', nameEn: 'English' }),
  Object.freeze({ code: 'zh', flag: '🇨🇳', name: 'Tiếng Trung', nameEn: 'Chinese' }),
  Object.freeze({ code: 'ja', flag: '🇯🇵', name: 'Tiếng Nhật', nameEn: 'Japanese' }),
  Object.freeze({ code: 'ko', flag: '🇰🇷', name: 'Tiếng Hàn', nameEn: 'Korean' }),
  Object.freeze({ code: 'th', flag: '🇹🇭', name: 'Tiếng Thái', nameEn: 'Thai' }),
  Object.freeze({ code: 'lo', flag: '🇱🇦', name: 'Tiếng Lào', nameEn: 'Lao' }),
  Object.freeze({ code: 'km', flag: '🇰🇭', name: 'Tiếng Khmer', nameEn: 'Khmer' }),
  Object.freeze({ code: 'fr', flag: '🇫🇷', name: 'Tiếng Pháp', nameEn: 'French' }),
  Object.freeze({ code: 'de', flag: '🇩🇪', name: 'Tiếng Đức', nameEn: 'German' }),
  Object.freeze({ code: 'es', flag: '🇪🇸', name: 'Tiếng Tây Ban Nha', nameEn: 'Spanish' }),
  Object.freeze({ code: 'ru', flag: '🇷🇺', name: 'Tiếng Nga', nameEn: 'Russian' }),
  Object.freeze({ code: 'ar', flag: '🇸🇦', name: 'Tiếng Ả Rập', nameEn: 'Arabic' }),
  Object.freeze({ code: 'hi', flag: '🇮🇳', name: 'Tiếng Hindi', nameEn: 'Hindi' }),
  Object.freeze({ code: 'id', flag: '🇮🇩', name: 'Tiếng Indonesia', nameEn: 'Indonesian' }),
  Object.freeze({ code: 'ms', flag: '🇲🇾', name: 'Tiếng Mã Lai', nameEn: 'Malay' }),
  Object.freeze({ code: 'tl', flag: '🇵🇭', name: 'Tiếng Tagalog', nameEn: 'Tagalog' }),
  Object.freeze({ code: 'pt', flag: '🇵🇹', name: 'Tiếng Bồ Đào Nha', nameEn: 'Portuguese' }),
  Object.freeze({ code: 'it', flag: '🇮🇹', name: 'Tiếng Ý', nameEn: 'Italian' })
]);

// Source languages: includes 'auto'
export const SOURCE_LANGS = LANGS;

// Target languages: 'auto' is source-only
export const TARGET_LANGS = Object.freeze(LANGS.filter(l => l.code !== 'auto'));

/**
 * Returns formatted label: "{flag} {name} ({code})"
 * Windows doesn't render all country flag emojis natively, so keeping ({code})
 * guarantees clear identification on every platform.
 *
 * @param {{ code: string, flag: string, name: string, nameEn?: string }} lang
 * @param {string} [locale='vi']
 * @returns {string}
 */
export function getLanguageLabel(lang, locale = 'vi') {
  if (!lang) return '';
  const displayName = (locale === 'en' && lang.nameEn) ? lang.nameEn : lang.name;
  return `${lang.flag} ${displayName} (${lang.code})`;
}

/**
 * Finds language descriptor by code.
 *
 * @param {string} code
 * @returns {{ code: string, flag: string, name: string, nameEn?: string } | undefined}
 */
export function findLanguage(code) {
  return LANGS.find(l => l.code === code);
}
