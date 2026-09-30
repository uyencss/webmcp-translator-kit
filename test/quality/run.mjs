#!/usr/bin/env node
// WebMCP Translator Kit — Quality Corpus Harness (Chinese -> Vietnamese)
// Supports two modes:
//   1. offline (default): Validates corpus structure, token masking round-trip,
//      token preservation in sample translations, residual CJK heuristics,
//      length ratios, and control characters. Exits 1 on failure.
//   2. live (--live): Opt-in via environment variables NINE_ROUTER_BASE_URL
//      and NINE_ROUTER_TOKEN. Batches items (<= 20/req) to model ag/gemini-3.1-pro-low,
//      scores auto-checks (token & CJK hard fails, ratio soft check), and generates
//      structured report JSON and Markdown in test/quality/out/. Skips cleanly (exit 0)
//      if environment variables are missing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const CORPUS_PATH = path.join(ROOT_DIR, 'fixtures/quality/corpus.json');
const OUT_DIR = path.join(__dirname, 'out');

const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;
const CONTROL_CHAR_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
const TARGET_MODEL = 'ag/gemini-3.1-pro-low';
const BATCH_SIZE = 20;

/**
 * Extracts structural placeholders / tokens that must be preserved.
 * Includes HTML tags, template variables {var} / {{var}}, printf specifiers (%s, %d),
 * positional tokens ($1), and HTML entities (&nbsp;).
 */
export function extractPlaceholders(text) {
  if (!text || typeof text !== 'string') return [];
  const patterns = [
    /<\/?[a-zA-Z][^>]*>/g,
    /\{\{?[a-zA-Z0-9_]+\}\}?/g,
    /%(?:\d+\$)?[a-zA-Z]/g,
    /\$[0-9]+/g,
    /&[a-zA-Z0-9#]+;/g
  ];
  const tokens = [];
  for (const p of patterns) {
    const matches = text.match(p);
    if (matches) tokens.push(...matches);
  }
  return [...new Set(tokens)];
}

/**
 * Simulates placeholder masking round-trip.
 * Replaces tokens with indexed sentinels, then restores them.
 * Asserts unmasked output strictly equals the original text.
 */
export function simulateMaskRoundTrip(text) {
  const tokens = extractPlaceholders(text);
  if (tokens.length === 0) return { ok: true, tokens };
  let masked = text;
  tokens.forEach((tok, idx) => {
    masked = masked.replaceAll(tok, `⟦TK_${idx}⟧`);
  });
  let unmasked = masked;
  tokens.forEach((tok, idx) => {
    unmasked = unmasked.replaceAll(`⟦TK_${idx}⟧`, tok);
  });
  return { ok: unmasked === text, tokens };
}

/**
 * Checks for residual CJK characters.
 */
export function findResidualCjk(text) {
  if (!text || typeof text !== 'string') return [];
  const matches = text.match(new RegExp(CJK_REGEX.source, 'g'));
  return matches ? [...new Set(matches)] : [];
}

/**
 * Checks for forbidden control characters.
 */
export function findControlChars(text) {
  if (!text || typeof text !== 'string') return [];
  const matches = text.match(new RegExp(CONTROL_CHAR_REGEX.source, 'g'));
  return matches ? [...new Set(matches)] : [];
}

/**
 * Loads and validates the quality corpus.
 */
export function loadCorpus(filePath = CORPUS_PATH) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Corpus file not found at: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(content);

  if (data.schemaVersion !== 1) {
    throw new Error(`Invalid schemaVersion: expected 1, got ${data.schemaVersion}`);
  }

  const sections = ['uiStrings', 'sentences', 'tricky'];
  for (const sec of sections) {
    if (!Array.isArray(data[sec])) {
      throw new Error(`Corpus missing array section: ${sec}`);
    }
  }

  const uiCount = data.uiStrings.length;
  const sentenceCount = data.sentences.length;
  const trickyCount = data.tricky.length;
  const total = uiCount + sentenceCount + trickyCount;

  if (total !== 52) {
    throw new Error(`Corpus count mismatch: expected 52 items, found ${total} (${uiCount}+${sentenceCount}+${trickyCount})`);
  }

  const allItems = [
    ...data.uiStrings.map((it) => ({ ...it, section: 'uiStrings', category: it.category || 'ui' })),
    ...data.sentences.map((it) => ({ ...it, section: 'sentences', category: it.category || 'sentence' })),
    ...data.tricky.map((it) => ({ ...it, section: 'tricky', category: it.category || 'tricky' }))
  ];

  return {
    raw: data,
    meta: data.meta,
    sections: {
      uiStrings: data.uiStrings,
      sentences: data.sentences,
      tricky: data.tricky
    },
    counts: { uiStrings: uiCount, sentences: sentenceCount, tricky: trickyCount, total },
    items: allItems
  };
}

/**
 * Runs offline structural validation on all items in the quality corpus.
 */
export function runOfflineValidation(corpus) {
  const errors = [];
  const warnings = [];
  let roundTripPassCount = 0;
  let sampleTokensPassCount = 0;
  let cjkCleanCount = 0;
  let ratioPassCount = 0;
  let ctrlCleanCount = 0;

  for (const item of corpus.items) {
    // 1. Placeholder masking round-trip simulation on source
    const rt = simulateMaskRoundTrip(item.zh);
    if (!rt.ok) {
      errors.push(`[${item.id}] Placeholder masking round-trip failed on source: "${item.zh}"`);
    } else {
      roundTripPassCount++;
    }

    // 2. Control chars in source
    const srcCtrl = findControlChars(item.zh);
    if (srcCtrl.length > 0) {
      errors.push(`[${item.id}] Source contains control characters: ${JSON.stringify(srcCtrl)}`);
    }

    // 3. Expected sample translations check
    if (Array.isArray(item.expectedVi) && item.expectedVi.length > 0) {
      const srcTokens = extractPlaceholders(item.zh);
      let itemTokensOk = true;

      for (const exp of item.expectedVi) {
        // (a) Token preservation
        for (const tok of srcTokens) {
          if (!exp.includes(tok)) {
            errors.push(`[${item.id}] Sample translation "${exp}" missing placeholder "${tok}"`);
            itemTokensOk = false;
          }
        }

        // (b) Heuristic residual CJK
        const cjkInExp = findResidualCjk(exp);
        if (cjkInExp.length > 0) {
          const warnMsg = `[${item.id}] Sample translation contains CJK characters: ${cjkInExp.join(', ')}`;
          warnings.push(warnMsg);
        }

        // (c) Length ratio
        const ratio = exp.length / item.zh.length;
        if (ratio < 0.3 || ratio > 8.0) {
          warnings.push(`[${item.id}] Sample translation ratio out of usual range (${ratio.toFixed(2)}x): "${item.zh}" -> "${exp}"`);
        }

        // (d) Control characters in target
        const expCtrl = findControlChars(exp);
        if (expCtrl.length > 0) {
          errors.push(`[${item.id}] Sample translation contains control characters: ${JSON.stringify(expCtrl)}`);
        }
      }

      if (itemTokensOk) sampleTokensPassCount++;
      const allCjkClean = item.expectedVi.every((exp) => findResidualCjk(exp).length === 0);
      if (allCjkClean) cjkCleanCount++;
      const allRatioOk = item.expectedVi.every((exp) => {
        const r = exp.length / item.zh.length;
        return r >= 0.3 && r <= 8.0;
      });
      if (allRatioOk) ratioPassCount++;
      const allCtrlClean = item.expectedVi.every((exp) => findControlChars(exp).length === 0);
      if (allCtrlClean) ctrlCleanCount++;
    }
  }

  const passed = errors.length === 0;
  return {
    passed,
    totalItems: corpus.counts.total,
    counts: corpus.counts,
    stats: {
      roundTripPassCount,
      sampleTokensPassCount,
      cjkCleanCount,
      ratioPassCount,
      ctrlCleanCount
    },
    errors,
    warnings
  };
}

/**
 * Executes live translation batch via 9router OpenAI-compatible chat completions API.
 */
async function callRouterBatch(baseURL, token, batchItems) {
  const url = `${baseURL.replace(/\/+$/, '')}/chat/completions`;
  const systemPrompt = [
    'You are a professional web page text translator.',
    'Translate each given item from zh to vi.',
    'Preserve technical codes, punctuation, and formatting.',
    'Output MUST be valid strictly formatted JSON with the exact structure:',
    '{"results": [{"id": "...", "revision": 0, "text": "..."}]}',
    'Each result item MUST have matching "id" and "revision" identical to the input item.',
    'Do not include explanations, notes, or markdown formatting.'
  ].join(' ');

  const requestItems = batchItems.map((it) => ({
    id: it.id,
    revision: 0,
    text: it.zh
  }));

  const payload = {
    model: TARGET_MODEL,
    stream: false,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(requestItems) }
    ],
    temperature: 0.1
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      Accept: 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`9router request failed with HTTP ${response.status} (${response.statusText})`);
  }

  const data = await response.json();
  const rawContent = data.choices?.[0]?.message?.content;
  if (!rawContent || typeof rawContent !== 'string') {
    throw new Error('Missing or invalid choices[0].message.content in provider response');
  }

  let cleaned = rawContent.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Failed to parse LLM response JSON: ${err.message}`);
  }

  if (!parsed || !Array.isArray(parsed.results)) {
    throw new Error('LLM response missing "results" array');
  }

  // Bijective verification
  const resultMap = new Map();
  for (const r of parsed.results) {
    if (!r || typeof r.id !== 'string' || typeof r.text !== 'string') {
      throw new Error(`Malformed result item: ${JSON.stringify(r)}`);
    }
    resultMap.set(r.id, r.text);
  }

  const results = [];
  for (const req of requestItems) {
    if (!resultMap.has(req.id)) {
      throw new Error(`Bijective failure: Missing result for id "${req.id}"`);
    }
    results.push({
      id: req.id,
      text: resultMap.get(req.id)
    });
  }

  return results;
}

/**
 * Evaluates live translation output against automated quality checks.
 */
export function scoreLiveItem(item, translatedText) {
  // 1. Placeholder & mustKeep token preservation (HARD GATE)
  const structuralPlaceholders = extractPlaceholders(item.zh);
  // If mustKeep exists, include items that aren't CJK characters (which are expected to be translated)
  const additionalMustKeep = (item.mustKeep || []).filter((tok) => !CJK_REGEX.test(tok));
  const expectedTokens = [...new Set([...structuralPlaceholders, ...additionalMustKeep])];

  const missingTokens = expectedTokens.filter((tok) => !translatedText.includes(tok));
  const tokenPass = missingTokens.length === 0;

  // 2. Residual CJK check (HARD GATE)
  const residualCjk = findResidualCjk(translatedText);
  const cjkPass = residualCjk.length === 0;

  // 3. Control character check (HARD GATE)
  const controlChars = findControlChars(translatedText);
  const ctrlPass = controlChars.length === 0;

  // 4. Length ratio check (SOFT FLAG)
  const ratio = item.zh.length > 0 ? translatedText.length / item.zh.length : 1;
  const ratioPass = ratio >= 0.4 && ratio <= 6.5;

  const hardPass = tokenPass && cjkPass && ctrlPass;
  const autoStatus = !hardPass ? 'FAIL' : (ratioPass ? 'PASS' : 'WARN_RATIO');

  return {
    id: item.id,
    section: item.section,
    category: item.category,
    source: item.zh,
    target: translatedText,
    expectedVi: item.expectedVi || [],
    notes: item.notes || item.why || '',
    checks: {
      tokens: { pass: tokenPass, expected: expectedTokens, missing: missingTokens },
      cjk: { pass: cjkPass, remaining: residualCjk },
      controlChars: { pass: ctrlPass, found: controlChars },
      lengthRatio: { pass: ratioPass, ratio: Number(ratio.toFixed(2)) }
    },
    hardPass,
    autoStatus,
    manualScore: null,
    manualNotes: ''
  };
}

/**
 * Runs live evaluation on quality corpus using 9router.
 */
export async function runLiveEvaluation(corpus, baseURL, token) {
  console.log(`[quality-harness] Starting live evaluation of ${corpus.items.length} items...`);
  console.log(`[quality-harness] Target model: ${TARGET_MODEL}`);
  console.log(`[quality-harness] Batch size: <= ${BATCH_SIZE} items/request`);

  const scoredItems = [];
  const chunks = [];
  for (let i = 0; i < corpus.items.length; i += BATCH_SIZE) {
    chunks.push(corpus.items.slice(i, i + BATCH_SIZE));
  }

  for (let idx = 0; idx < chunks.length; idx++) {
    const chunk = chunks[idx];
    console.log(`[quality-harness] Translating batch ${idx + 1}/${chunks.length} (${chunk.length} items)...`);
    const translatedBatch = await callRouterBatch(baseURL, token, chunk);
    const transMap = new Map(translatedBatch.map((t) => [t.id, t.text]));

    for (const item of chunk) {
      const translatedText = transMap.get(item.id) || '';
      const scored = scoreLiveItem(item, translatedText);
      scoredItems.push(scored);
    }
  }

  const total = scoredItems.length;
  const hardPassedCount = scoredItems.filter((it) => it.hardPass).length;
  const cleanPassCount = scoredItems.filter((it) => it.autoStatus === 'PASS').length;
  const warnRatioCount = scoredItems.filter((it) => it.autoStatus === 'WARN_RATIO').length;
  const failCount = scoredItems.filter((it) => it.autoStatus === 'FAIL').length;

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  const jsonReportPath = path.join(OUT_DIR, `report-${ts}.json`);
  const mdReportPath = path.join(OUT_DIR, `report-${ts}.md`);

  const reportData = {
    meta: {
      timestamp: now.toISOString(),
      model: TARGET_MODEL,
      totalItems: total,
      cleanPass: cleanPassCount,
      warnRatio: warnRatioCount,
      hardPass: hardPassedCount,
      hardFail: failCount
    },
    items: scoredItems
  };

  fs.writeFileSync(jsonReportPath, JSON.stringify(reportData, null, 2) + '\n', 'utf8');

  // Build Markdown table
  const mdLines = [
    `# Translation Quality Evaluation Report (Zh -> Vi)`,
    ``,
    `- **Date**: ${now.toISOString()}`,
    `- **Model**: \`${TARGET_MODEL}\``,
    `- **Total Items**: ${total}`,
    `- **Auto Checks Passed**: ${cleanPassCount}/${total}`,
    `- **Ratio Warnings**: ${warnRatioCount}`,
    `- **Hard Fails (Tokens / CJK / Ctrl)**: ${failCount}`,
    ``,
    `## Auto-Scoring Gates`,
    `- **Tokens**: Hard gate (all structural placeholders and specified non-CJK entities preserved).`,
    `- **CJK**: Hard gate (zero residual Hanzi in target).`,
    `- **Control Chars**: Hard gate (zero unescaped control codes).`,
    `- **Ratio**: Soft check (target/source length ratio in [0.4x - 6.5x]).`,
    `- **Manual Score (0–2)**: Reserved for human reviewer (0 = wrong/broken, 1 = acceptable with flaws, 2 = natural and accurate).`,
    ``,
    `## Results Table`,
    ``,
    `| ID | Cat | Source (zh) | Translated (vi) | Tokens | No CJK | Ratio | Status | Manual Score (0–2) | Reviewer Notes |`,
    `|:---|:---|:---|:---|:---:|:---:|:---:|:---:|:---:|:---|`
  ];

  for (const it of scoredItems) {
    const esc = (s) => (s || '').replaceAll('|', '\\|').replaceAll('\n', '<br>');
    const tokIcon = it.checks.tokens.pass ? '✔' : `❌ (${it.checks.tokens.missing.join(', ')})`;
    const cjkIcon = it.checks.cjk.pass ? '✔' : `❌ (${it.checks.cjk.remaining.join('')})`;
    const ratioStr = `${it.checks.lengthRatio.ratio}x ${it.checks.lengthRatio.pass ? '' : '⚠️'}`.trim();
    mdLines.push(
      `| ${it.id} | ${esc(it.category)} | ${esc(it.source)} | ${esc(it.target)} | ${tokIcon} | ${cjkIcon} | ${ratioStr} | **${it.autoStatus}** | | ${esc(it.notes)} |`
    );
  }

  mdLines.push('');
  fs.writeFileSync(mdReportPath, mdLines.join('\n'), 'utf8');

  console.log(`[quality-harness] Live report generated:`);
  console.log(`  JSON: ${jsonReportPath}`);
  console.log(`  Markdown: ${mdReportPath}`);

  return {
    reportData,
    jsonReportPath,
    mdReportPath,
    stats: reportData.meta
  };
}

/**
 * Main harness entrypoint.
 */
async function main() {
  const isLive = process.argv.includes('--live');

  // Load and validate corpus
  let corpus;
  try {
    corpus = loadCorpus();
  } catch (err) {
    console.error(`[quality-harness] FATAL: Failed to load corpus: ${err.message}`);
    process.exit(1);
  }

  // Handle live mode opt-in
  if (isLive) {
    const baseURL = process.env.NINE_ROUTER_BASE_URL;
    const token = process.env.NINE_ROUTER_TOKEN;

    if (!baseURL || !token) {
      console.log('========================================================================');
      console.log('WebMCP Translator Kit — Quality Harness (Live Mode)');
      console.log('========================================================================');
      console.log('[quality-harness] --live specified, but NINE_ROUTER_BASE_URL or NINE_ROUTER_TOKEN is not set.');
      console.log('[quality-harness] Skipping live evaluation cleanly (exit 0).');
      console.log('========================================================================');
      process.exit(0);
    }

    try {
      const liveRes = await runLiveEvaluation(corpus, baseURL, token);
      console.log('========================================================================');
      console.log('Live Evaluation Summary:');
      console.log(`  Total Items : ${liveRes.stats.totalItems}`);
      console.log(`  Hard Passed : ${liveRes.stats.hardPass}/${liveRes.stats.totalItems}`);
      console.log(`  Clean Pass  : ${liveRes.stats.cleanPass}`);
      console.log(`  Warnings    : ${liveRes.stats.warnRatio}`);
      console.log(`  Hard Fails  : ${liveRes.stats.hardFail}`);
      console.log('========================================================================');
      if (liveRes.stats.hardFail > 0) {
        process.exit(1);
      }
      process.exit(0);
    } catch (err) {
      console.error(`[quality-harness] Live evaluation failed: ${err.message}`);
      process.exit(1);
    }
  }

  // Offline mode (default)
  console.log('========================================================================');
  console.log('WebMCP Translator Kit — Quality Corpus Offline Structural Verification');
  console.log('========================================================================');
  console.log(`Corpus: fixtures/quality/corpus.json (schemaVersion: ${corpus.raw.schemaVersion})`);
  console.log(`Counts by section:`);
  console.log(`  - uiStrings : ${corpus.counts.uiStrings} items`);
  console.log(`  - sentences : ${corpus.counts.sentences} items`);
  console.log(`  - tricky    : ${corpus.counts.tricky} items`);
  console.log(`Total items   : ${corpus.counts.total} items\n`);

  const result = runOfflineValidation(corpus);

  console.log('Offline Verification Checks:');
  console.log(`  ✔ Token masking round-trip simulation : ${result.stats.roundTripPassCount}/${result.totalItems} PASS`);
  console.log(`  ✔ Sample expectedVi token preservation: ${result.stats.sampleTokensPassCount}/${result.totalItems} PASS`);
  console.log(`  ✔ Residual CJK heuristic in target    : ${result.stats.cjkCleanCount}/${result.totalItems} clean`);
  console.log(`  ✔ Length ratio in range [0.3x - 8.0x] : ${result.stats.ratioPassCount}/${result.totalItems} in range`);
  console.log(`  ✔ Control characters check            : ${result.stats.ctrlCleanCount}/${result.totalItems} clean`);
  console.log('------------------------------------------------------------------------');

  if (result.warnings.length > 0) {
    console.log(`Warnings (${result.warnings.length}):`);
    for (const w of result.warnings) {
      console.log(`  ⚠️  ${w}`);
    }
    console.log('------------------------------------------------------------------------');
  }

  if (!result.passed) {
    console.error(`Structural Verification FAILED with ${result.errors.length} errors:`);
    for (const err of result.errors) {
      console.error(`  ❌ ${err}`);
    }
    console.log('========================================================================');
    process.exit(1);
  }

  console.log('Verdict: ALL 52 ITEMS PASSED OFFLINE STRUCTURAL CHECKS');
  console.log('========================================================================');
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
