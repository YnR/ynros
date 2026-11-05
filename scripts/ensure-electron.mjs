// Downloads Electron's app binary when the package install skipped it
// (for example when npm did not run dependency install scripts).
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
let dir;
try {
  dir = path.dirname(require.resolve('electron/package.json'));
} catch {
  console.error('Electron is not installed. Run `npm install` first.');
  process.exit(1);
}

const installed = () => {
  const p = path.join(dir, 'path.txt');
  return existsSync(p) && existsSync(path.join(dir, 'dist', readFileSync(p, 'utf8').trim()));
};

if (!installed()) {
  console.log('Electron binary missing, downloading it (about 100 MB)...');
  const env = { ...process.env };
  if (env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
    console.log('Ignoring ELECTRON_SKIP_BINARY_DOWNLOAD for this download.');
    delete env.ELECTRON_SKIP_BINARY_DOWNLOAD;
  }
  const r = spawnSync(process.execPath, [path.join(dir, 'install.js')], { stdio: 'inherit', env });
  if (r.status !== 0 || !installed()) {
    console.error('Could not download Electron. Use `npm start` and open http://localhost:4317 instead.');
    process.exit(1);
  }
}
