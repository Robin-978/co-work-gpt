'use strict';
// 把訓練好的量化權重內嵌進 HTML 模板，產出單一檔案的網頁。
const fs = require('fs');
const path = require('path');
const { buildCorpus } = require('./corpus.js');

const here = __dirname;
const out = process.argv[2] || path.join(here, 'index.html');
const w = fs.readFileSync(path.join(here, 'weights.json'), 'utf8');
const tpl = fs.readFileSync(path.join(here, 'page.template.html'), 'utf8');
const corpusLen = buildCorpus().length;

if (w.includes('</script>')) throw new Error('weights JSON 含有 </script>，需跳脫');
const html = tpl
  .replace('__WEIGHTS__', () => w)
  .replace('__CORPUS_CHARS__', () => corpusLen.toLocaleString('en-US'));

if (html.includes('__WEIGHTS__') || html.includes('__CORPUS_CHARS__')) throw new Error('模板置換失敗');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log('wrote', out, (fs.statSync(out).size / 1024).toFixed(0) + ' KB');
