'use strict';
// 把訓練好的量化權重與兩份手冊內嵌進 HTML 模板，產出單一檔案的網頁。
const fs = require('fs');
const path = require('path');
const { buildCorpus } = require('./corpus.js');
const { render, assertNoMarkdown } = require('./md.js');

const here = __dirname;
const out = process.argv[2] || path.join(here, 'index.html');
const w = fs.readFileSync(path.join(here, 'weights.json'), 'utf8');
const tpl = fs.readFileSync(path.join(here, 'page.template.html'), 'utf8');
const corpusLen = buildCorpus().length;

// 手冊的唯一真相是 docs/*.md；頁內那份在這裡生成，不手抄
const LINKS = {
  'user-manual.md': '#doc-user',
  'technical-manual.md': '#doc-tech',
  '../README.md': null,            // repo 裡的檔案，單檔網頁連不到，降成純文字
};
function doc(name) {
  const md = fs.readFileSync(path.join(here, '..', 'docs', name), 'utf8');
  // 手冊的 # 是文件標題，頁面上這一段掛在 h2 底下，所以整體降兩級
  const html = render(md, { demote: 2, links: LINKS });
  assertNoMarkdown(html, name);
  return html;
}
const docUser = doc('user-manual.md');
const docTech = doc('technical-manual.md');

if (w.includes('</script>')) throw new Error('weights JSON 含有 </script>，需跳脫');
for (const [name, html] of [['user-manual', docUser], ['technical-manual', docTech]]) {
  if (html.includes('</script>')) throw new Error(name + ' 轉出來的 HTML 含有 </script>，會提早關掉標籤');
}

// 先在「模板」上確認每個佔位符剛好出現一次，再置換。
// 不能改成置換後檢查殘留——技術手冊本文就在講 __WEIGHTS__ 這些佔位符，那些字串會合法地留在產出裡。
const FILL = [
  ['__WEIGHTS__', w],
  ['__CORPUS_CHARS__', corpusLen.toLocaleString('en-US')],
  ['__DOC_USER__', docUser],
  ['__DOC_TECH__', docTech],
];
for (const [ph] of FILL) {
  const n = tpl.split(ph).length - 1;
  if (n !== 1) throw new Error('模板裡的 ' + ph + ' 應該剛好一個，實際 ' + n + ' 個');
}
const html = FILL.reduce((acc, [ph, val]) => acc.replace(ph, () => val), tpl);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log('wrote', out, (fs.statSync(out).size / 1024).toFixed(0) + ' KB',
  '（手冊 ' + ((docUser.length + docTech.length) / 1024).toFixed(0) + ' KB）');
