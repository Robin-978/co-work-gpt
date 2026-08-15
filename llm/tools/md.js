'use strict';
// 極小的 Markdown → HTML 轉換器，只負責 docs/*.md 實際用到的語法：
// 標題、段落、無序／有序清單、引用、水平線、表格（含 ---: 靠右）、程式碼區塊與行內程式碼、
// 粗體、連結。刻意不做巢狀清單與圖片——那些現在沒用到，真的用到了會被 assertNoMarkdown() 抓出來。
//
// 存在的理由：手冊的唯一真相是 docs/*.md，網頁裡那份要在 build 時生成，不能靠手抄。

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s) => s.replace(/[&<>"]/g, (c) => ESC[c]);

// 連結目標對照：手冊之間互相引用要變成頁內錨點，指到 repo 檔案的則降成純文字
function resolveHref(href, links) {
  if (Object.prototype.hasOwnProperty.call(links, href)) return links[href];
  if (/^https?:\/\//.test(href)) return href;
  return null;                     // null = 不做成連結，只留文字
}

function inline(text, links) {
  // 先把行內程式碼抽掉，避免裡面的 * ` [ ] 被後面的規則吃掉
  const code = [];
  const stash = (c) => {
    code.push('<code>' + esc(c) + '</code>');
    return '\u0000' + (code.length - 1) + '\u0000';
  };
  // 雙反引號要先處理：`` `x` `` 是「內容本身含有反引號」的寫法，手冊裡用它引用 `<eos>` 這種字串。
  // 跟 CommonMark 一樣，去掉緊貼分隔符的那一個空白。
  let s = text.replace(/``([\s\S]+?)``/g, (_, c) => stash(c.replace(/^ /, "").replace(/ $/, "")));
  s = s.replace(/`([^`]+)`/g, (_, c) => stash(c));
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, href) => {
    const to = resolveHref(href, links);
    return to ? '<a href="' + esc(to) + '">' + label + '</a>' : label;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => code[+i]);
}

function tableRow(line) {
  return line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
}

function render(md, opt) {
  const o = opt || {};
  const demote = o.demote || 0;            // 標題降幾級（放進頁面裡要讓開既有的 h1/h2）
  const links = o.links || {};
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;

  const flushPara = (buf) => { if (buf.length) out.push('<p>' + inline(buf.join(' '), links) + '</p>'); buf.length = 0; };
  const para = [];

  while (i < lines.length) {
    const line = lines[i];

    // 程式碼區塊
    if (/^```/.test(line)) {
      flushPara(para);
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;                                  // 吃掉結尾的 ```
      out.push('<pre><code>' + esc(body.join('\n')) + '</code></pre>');
      continue;
    }

    // 表格：連續的 | 開頭行，第二行是分隔列
    if (/^\|/.test(line) && /^\|[\s:|-]+\|$/.test(lines[i + 1] || '')) {
      flushPara(para);
      const head = tableRow(line);
      const align = tableRow(lines[i + 1]).map((c) => (/:$/.test(c) ? ' style="text-align:right"' : ''));
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(tableRow(lines[i++]));
      // 表格一律包一層可橫向捲動的容器：手冊裡的表格在手機寬度會撐爆版面
      out.push('<div class="mdTableWrap"><table><thead><tr>' +
        head.map((c, n) => '<th' + (align[n] || '') + '>' + inline(c, links) + '</th>').join('') +
        '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + r.map((c, n) => '<td' + (align[n] || '') + '>' + inline(c, links) + '</td>').join('') + '</tr>').join('') +
        '</tbody></table></div>');
      continue;
    }

    // 標題
    const h = /^(#{1,6}) (.+)$/.exec(line);
    if (h) {
      flushPara(para);
      const lv = Math.min(6, h[1].length + demote);
      out.push('<h' + lv + '>' + inline(h[2], links) + '</h' + lv + '>');
      i++;
      continue;
    }

    // 水平線
    if (/^---+$/.test(line)) { flushPara(para); out.push('<hr>'); i++; continue; }

    // 引用
    if (/^> /.test(line)) {
      flushPara(para);
      const body = [];
      while (i < lines.length && /^> /.test(lines[i])) body.push(lines[i++].slice(2));
      out.push('<blockquote>' + inline(body.join(' '), links) + '</blockquote>');
      continue;
    }

    // 清單
    const ul = /^[-*] (.+)$/.exec(line), ol = /^\d+\. (.+)$/.exec(line);
    if (ul || ol) {
      flushPara(para);
      const tag = ul ? 'ul' : 'ol';
      const re = ul ? /^[-*] (.+)$/ : /^\d+\. (.+)$/;
      const items = [];
      while (i < lines.length) {
        const m = re.exec(lines[i]);
        if (!m) break;
        items.push(m[1]);
        i++;
      }
      out.push('<' + tag + '>' + items.map((t) => '<li>' + inline(t, links) + '</li>').join('') + '</' + tag + '>');
      continue;
    }

    if (!line.trim()) { flushPara(para); i++; continue; }
    para.push(line.trim());
    i++;
  }
  flushPara(para);
  return out.join('\n');
}

// 轉完之後掃一遍：還看得到 Markdown 標記就是有語法沒被處理到，寧可 build 失敗也不要出一頁壞掉的手冊
function assertNoMarkdown(html, where) {
  // 先把已經轉成 <code>／<pre> 的部分拿掉再掃：手冊本文就在講 ** 和 [](…) 這些標記，
  // 那些是被正確轉成行內程式碼的內容，不是漏轉的語法。第一版沒排除，兩份手冊都誤判成失敗。
  const body = html
    .replace(/<pre><code>[\s\S]*?<\/code><\/pre>/g, '')
    .replace(/<code>[\s\S]*?<\/code>/g, '');
  const bad = [];
  if (/\*\*/.test(body)) bad.push('未處理的粗體 **');
  if (/^\s*\|/m.test(body)) bad.push('未處理的表格列 |');
  if (/^\s*#{1,6} /m.test(body)) bad.push('未處理的標題 #');
  if (/\]\([^)]*\)/.test(body)) bad.push('未處理的連結 [](…)');
  if (/^\s*[-*] /m.test(body)) bad.push('未處理的清單 -');
  if (bad.length) throw new Error(where + ' 的 Markdown 轉換不完整：' + bad.join('、'));
}

module.exports = { render, assertNoMarkdown, esc };

/* ==========================================================
   自我測試： node md.js --test
   ========================================================== */
if (require.main === module && process.argv.includes('--test')) {
  let pass = 0, fail = 0;
  const LINKS = { 'user-manual.md': '#doc-user', '../README.md': null };
  const t = (name, got, want) => {
    const ok = String(got) === String(want);
    ok ? pass++ : fail++;
    console.log((ok ? '  ✓ ' : '  ✗ ') + name);
    if (!ok) { console.log('      期望 ' + JSON.stringify(want)); console.log('      實際 ' + JSON.stringify(got)); }
  };
  const one = (md, opt) => render(md, Object.assign({ links: LINKS }, opt));

  t('標題可降級', one('# 標題', { demote: 2 }), '<h3>標題</h3>');
  t('標題最深到 h6', one('###### 深', { demote: 2 }), '<h6>深</h6>');
  t('段落', one('一句話'), '<p>一句話</p>');
  t('粗體', one('這是 **重點** 了'), '<p>這是 <strong>重點</strong> 了</p>');
  t('行內程式碼會跳脫', one('看 `<eos>` 這個'), '<p>看 <code>&lt;eos&gt;</code> 這個</p>');
  t('雙反引號可含反引號', one('引用 `` `x` `` 好'), '<p>引用 <code>`x`</code> 好</p>');

  // 佔位符用過「空白＋數字＋空白」，會把正文裡的數字吃掉——這一條就是那次的迴歸測試
  t('正文的數字不會被佔位符吃掉', one('有 5 個 `a` 和 7 個 `b`'),
    '<p>有 5 個 <code>a</code> 和 7 個 <code>b</code></p>');

  t('已知連結變錨點', one('看 [使用者手冊](user-manual.md)'), '<p>看 <a href="#doc-user">使用者手冊</a></p>');
  t('對應到 null 的連結降成純文字', one('看 [說明](../README.md)'), '<p>看 說明</p>');
  t('沒對應到的相對連結也降成純文字', one('看 [別的](other.md)'), '<p>看 別的</p>');
  t('外部連結保留', one('看 [站](https://example.com)'), '<p>看 <a href="https://example.com">站</a></p>');

  t('無序清單', one('- 甲\n- 乙'), '<ul><li>甲</li><li>乙</li></ul>');
  t('有序清單', one('1. 甲\n2. 乙'), '<ol><li>甲</li><li>乙</li></ol>');
  t('引用', one('> 注意'), '<blockquote>注意</blockquote>');
  t('水平線', one('---'), '<hr>');

  t('程式碼區塊會跳脫且不解讀 Markdown',
    one('```\n</script> **粗** & <\n```'),
    '<pre><code>&lt;/script&gt; **粗** &amp; &lt;</code></pre>');

  t('表格會包捲動容器並吃掉靠右對齊',
    one('| 甲 | 乙 |\n|---|---:|\n| 1 | 2 |'),
    '<div class="mdTableWrap"><table><thead><tr><th>甲</th><th style="text-align:right">乙</th></tr></thead>' +
    '<tbody><tr><td>1</td><td style="text-align:right">2</td></tr></tbody></table></div>');

  // assertNoMarkdown 該擋的與不該誤擋的
  const threw = (fn) => { try { fn(); return false; } catch (e) { return true; } };
  t('漏轉的粗體會被擋下', threw(() => assertNoMarkdown('<p>**漏了**</p>', 'x')), true);
  t('漏轉的表格列會被擋下', threw(() => assertNoMarkdown('| 甲 | 乙 |', 'x')), true);
  t('程式碼裡的 ** 不算漏轉', threw(() => assertNoMarkdown('<p><code>**</code></p>', 'x')), false);
  t('程式碼裡的 [](…) 不算漏轉', threw(() => assertNoMarkdown('<p><code>[](…)</code></p>', 'x')), false);

  console.log('\n' + pass + ' 通過 / ' + fail + ' 失敗');
  process.exit(fail ? 1 : 0);
}

