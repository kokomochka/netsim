import * as esbuild from 'esbuild';
import fs from 'node:fs';
// Self-contained build: Pixi is inlined (no CDN), so the page works offline and from file://.
const r = await esbuild.build({ entryPoints: ['src/main.ts'], bundle: true, format: 'esm', minify: true, write: false, target: 'es2022',
  alias: { 'pixi.js': './src/pixi-global.ts' }, legalComments: 'none' });
const esc = (s) => s.replace(/<\/script/gi, '<\\/script');
const js = esc(r.outputFiles[0].text);
const pixi = esc(fs.readFileSync('node_modules/pixi.js/dist/pixi.min.js', 'utf8'));
const tpl = fs.readFileSync('template-head-body.txt', 'utf8');
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${tpl}
<script>
${pixi}
</script>
<script type="module">
${js}
</script>
</html>
`;
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/netsim.html', html);
fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync('docs/index.html', html);
console.log('built', (html.length / 1024).toFixed(1), 'KB -> dist/netsim.html, docs/index.html');
