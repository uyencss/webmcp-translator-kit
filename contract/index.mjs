import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const contractDir = path.dirname(fileURLToPath(import.meta.url));
export const schemaDir = path.join(contractDir, 'schemas');
export const defaults = JSON.parse(
  fs.readFileSync(path.join(contractDir, 'defaults.json'), 'utf8')
);
export const CONTRACT_VERSION = defaults.version;
