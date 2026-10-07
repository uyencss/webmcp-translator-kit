import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('[sync-all] Synchronizing all modular components...');
execFileSync(process.execPath, [path.join(rootDir, 'scripts', 'sync-i18n.mjs')], { stdio: 'inherit' });
execFileSync(process.execPath, [path.join(rootDir, 'scripts', 'sync-styles.mjs')], { stdio: 'inherit' });
execFileSync(process.execPath, [path.join(rootDir, 'scripts', 'sync-content.mjs')], { stdio: 'inherit' });
console.log('[sync-all] All modular components synchronized successfully.');
