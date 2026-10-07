// WebMCP Translator Kit — Content Script Module Bundler
// Contract:
// Chrome MV3 content scripts execute in an isolated world and do not support
// native ES modules (type: "module") in declarative manifest injections.
// The modules under extension/src/content/modules/ represent cleanly partitioned
// functional components sharing file-level scope when concatenated into extension/src/content.js.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const modulesDir = path.join(rootDir, 'extension', 'src', 'content', 'modules');
const targetFile = path.join(rootDir, 'extension', 'src', 'content.js');

const contentModules = [
  'constants.js',
  'walker.js',
  'chunker.js',
  'engine.js',
  'scroll-observer.js',
  'widget-dom.js',
  'messages.js',
];

const contents = [];

for (const mod of contentModules) {
  const modPath = path.join(modulesDir, mod);
  if (!fs.existsSync(modPath)) {
    throw new Error(`Content module missing: ${modPath}`);
  }
  const code = fs.readFileSync(modPath, 'utf8');
  contents.push(code);
}

const bundled = contents.join('\n');
fs.writeFileSync(targetFile, bundled, 'utf8');

// Perform AST syntax verification on the generated content script
execFileSync(process.execPath, ['--check', targetFile], { stdio: 'inherit' });

console.log(`[sync-content] Compiled ${contentModules.length} modules to extension/src/content.js (${bundled.split('\n').length} lines, syntax verified)`);

