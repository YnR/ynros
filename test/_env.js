// Imported first by unit tests so nothing touches the real ~/.ynros-harness.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.HARNESS_DATA_DIR) {
  process.env.HARNESS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-unit-'));
  process.on('exit', () => fs.rmSync(process.env.HARNESS_DATA_DIR, { recursive: true, force: true }));
}
