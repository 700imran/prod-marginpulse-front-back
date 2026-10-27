// Copies Tesseract's worker, WASM core and English language data into
// public/tesseract/ so OCR is served from our own origin. Without this,
// tesseract.js downloads executable code (worker + WASM) from a third-party
// CDN at runtime — a supply-chain risk, and it would force a weak CSP.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'public', 'tesseract');
fs.mkdirSync(path.join(out, 'core'), { recursive: true });
fs.mkdirSync(path.join(out, 'lang'), { recursive: true });

const copy = (from, to) => fs.copyFileSync(from, to);
copy(path.join(root, 'node_modules/tesseract.js/dist/worker.min.js'), path.join(out, 'worker.min.js'));

const coreDir = path.join(root, 'node_modules/tesseract.js-core');
for (const f of fs.readdirSync(coreDir)) {
  if (/lstm/.test(f) && /\.(js|wasm)$/.test(f)) copy(path.join(coreDir, f), path.join(out, 'core', f));
}

const langRoot = path.join(root, 'node_modules/@tesseract.js-data/eng');
const candidates = [path.join(langRoot, '4.0.0_best_int', 'eng.traineddata.gz'), path.join(langRoot, 'eng.traineddata.gz')];
const lang = candidates.find((p) => fs.existsSync(p));
if (!lang) throw new Error('eng.traineddata.gz not found — run npm install');
copy(lang, path.join(out, 'lang', 'eng.traineddata.gz'));
console.log('OCR assets copied to public/tesseract');
