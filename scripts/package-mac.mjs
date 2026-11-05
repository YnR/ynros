// Packages the desktop app as dist/ynros-darwin-<arch>/ynros.app with the ynr icon.
// Run on the Mac: npm run package:mac   (add --install to copy it to /Applications)
import { packager } from '@electron/packager';
import fs from 'node:fs/promises';
import path from 'node:path';

const install = process.argv.includes('--install');
const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));

const [appPath] = await packager({
  dir: '.',
  out: 'dist',
  overwrite: true,
  name: 'ynros',
  executableName: 'ynros',
  appBundleId: 'net.ynr.ynros',
  appVersion: pkg.version,
  platform: 'darwin',
  arch: process.arch,
  icon: 'build/icon.icns',
  // Plain folders, not asar: the server spawns helper scripts by path.
  asar: false,
  prune: true,
  ignore: [/^\/dist($|\/)/, /^\/test($|\/)/, /^\/\.git($|\/)/, /^\/client($|\/)/, /^\/scripts($|\/)/, /^\/\.harness-data($|\/)/],
});
const app = path.join(appPath, 'ynros.app');
console.log(`Built ${app}`);
if (install) {
  const dest = '/Applications/ynros.app';
  await fs.rm(dest, { recursive: true, force: true });
  await fs.cp(app, dest, { recursive: true, verbatimSymlinks: true });
  console.log(`Installed ${dest}`);
}
