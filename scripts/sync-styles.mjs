import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const stylesDir = path.join(rootDir, 'extension', 'src', 'popup', 'styles');
const targetFile = path.join(rootDir, 'extension', 'src', 'popup.css');

const styleModules = [
  'tokens.css',
  'layout.css',
  'controls.css',
  'features.css',
  'subtabs.css',
  'modal.css',
  'mascot.css',
];

const header = `/* ==========================================================================
   WebMCP Translator — Taste-Skill Frontend Theme (Modular Bundle)
   NOTE: This file is automatically compiled from extension/src/popup/styles/
   Edit individual style modules in extension/src/popup/styles/ for maintenance.
   ========================================================================== */

`;

const contents = [header];

for (const mod of styleModules) {
  const modPath = path.join(stylesDir, mod);
  if (!fs.existsSync(modPath)) {
    throw new Error(`Style module missing: ${modPath}`);
  }
  const css = fs.readFileSync(modPath, 'utf8').trim();
  contents.push(`/* --- Module: ${mod} --- */\n` + css + '\n\n');
}

const bundled = contents.join('\n');
fs.writeFileSync(targetFile, bundled, 'utf8');

const opens = (bundled.match(/{/g) || []).length;
const closes = (bundled.match(/}/g) || []).length;
if (opens !== closes) {
  throw new Error(`Unbalanced braces in bundled popup.css: ${opens} open vs ${closes} close`);
}

console.log(`[sync-styles] Compiled ${styleModules.length} modules to extension/src/popup.css (braces: ${opens}/${closes})`);
