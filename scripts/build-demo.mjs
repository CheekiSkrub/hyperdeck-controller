// Builds the single-file browser demo (web/dist-demo/hyperdeck-demo.html).
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
execSync('npx vite build -c vite.demo.config.ts', { cwd: web, stdio: 'inherit' });
const js = fs.readFileSync(path.join(web, 'dist-demo', 'demo.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
const css = fs.readFileSync(path.join(web, 'dist-demo', 'demo.css'), 'utf8');
const html = `<title>HyperDeck Controller Demo</title>
<style>
html, body { background: #0e1013; }
${css}
</style>
<div id="root"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js"></script>
<script>
${js}
</script>
`;
fs.writeFileSync(path.join(web, 'dist-demo', 'hyperdeck-demo.html'), html);
console.log('Wrote web/dist-demo/hyperdeck-demo.html', (html.length / 1024).toFixed(0), 'KB');
