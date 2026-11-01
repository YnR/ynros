// Bundles the Markdown editor (Toast UI + ProseMirror) for the browser.
import { build } from 'esbuild';

await build({
  entryPoints: ['client/editor-entry.js'],
  bundle: true,
  minify: true,
  format: 'iife',
  outfile: 'public/vendor/editor.js',
  loader: { '.css': 'css' },
  logLevel: 'info',
});
