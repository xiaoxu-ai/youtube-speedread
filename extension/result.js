// result.js —— 结果页
//
// 渲染一律走 DOM API（createElement + textContent），不用 innerHTML。
// 正文来自大模型、素材来自视频字幕，都算不可信内容，拼 HTML 容易被塞进 <img onerror>。

const $ = (id) => document.getElementById(id);

let md = '';
let title = 'youtube';
let videoId = '';

// ---------- 行内：**粗体** 和 [文字](链接) ----------
function inline(target, text) {
  const re = /(\*\*(.+?)\*\*)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) target.appendChild(document.createTextNode(text.slice(last, m.index)));
    if (m[2] !== undefined) {
      const b = document.createElement('strong');
      b.textContent = m[2];
      target.appendChild(b);
    } else {
      const a = document.createElement('a');
      a.href = m[5];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = m[4];
      target.appendChild(a);
    }
    last = re.lastIndex;
  }
  if (last < text.length) target.appendChild(document.createTextNode(text.slice(last)));
}

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function render(markdown) {
  const root = el('div');
  const lines = markdown.split('\n');
  let list = null;
  let pendingLabel = null; // "原文：" / "中文："
  let inFacts = true;

  const closeList = () => {
    if (list) {
      root.appendChild(list);
      list = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (line === '') {
      closeList();
      continue;
    }
    if (/^-{3,}$/.test(line.trim())) {
      closeList();
      root.appendChild(el('hr'));
      inFacts = false;
      continue;
    }
    if (line.startsWith('#### ')) {
      closeList();
      const h = el('h4');
      inline(h, line.slice(5));
      root.appendChild(h);
      continue;
    }
    if (line.startsWith('### ')) {
      closeList();
      const h = el('h3');
      inline(h, line.slice(4));
      root.appendChild(h);
      continue;
    }
    if (line.startsWith('## ')) {
      closeList();
      const h = el('h2');
      inline(h, line.slice(3));
      root.appendChild(h);
      continue;
    }
    if (line.startsWith('# ')) {
      closeList();
      const h = el('h1');
      inline(h, line.slice(2));
      root.appendChild(h);
      continue;
    }
    if (line.startsWith('- ')) {
      if (!list) list = el('ul');
      const li = el('li');
      inline(li, line.slice(2));
      list.appendChild(li);
      continue;
    }

    closeList();

    // 独占一行的加粗文字当作「标签」处理。
    // 注意 `**频道：** xxx` 这种后面还有内容的不会命中，正好。
    const lab = line.match(/^\*\*(.+?)\*\*$/);
    if (lab) {
      const name = lab[1].replace(/[:：]\s*$/, '');
      if (name === '原文') {
        pendingLabel = 'orig';
        const l = el('div', 'lbl');
        l.textContent = 'Original';
        root.appendChild(l);
      } else if (name === '中文') {
        pendingLabel = 'zh';
        const l = el('div', 'lbl');
        l.textContent = '中文';
        root.appendChild(l);
      } else {
        // 讲了什么 / 要点
        pendingLabel = null;
        const l = el('div', 'lbl field');
        l.textContent = name;
        root.appendChild(l);
      }
      continue;
    }

    const p = el('p', pendingLabel ? 'seg ' + pendingLabel : inFacts ? 'facts' : '');
    // 头部信息块里的 "  \n" 软换行
    inline(p, line.replace(/\s{2,}$/, ''));
    root.appendChild(p);
    if (pendingLabel) pendingLabel = null;
  }
  closeList();
  return root;
}

async function load() {
  try {
    const { job } = await chrome.storage.session.get('job');
    if (!job || !job.markdown) {
      const d = el('div', 'empty');
      d.textContent = '没有可显示的结果。回到 YouTube 视频页，点插件图标重新提取。';
      $('content').replaceChildren(d);
      return;
    }

    md = job.markdown;
    title = job.title || 'youtube';
    videoId = job.videoId || '';
    document.title = title + ' — 油管速读';
    $('pageTitle').textContent = title;
    $('content').replaceChildren(render(md));
  } catch (err) {
    const d = el('div', 'error');
    d.textContent = '加载失败：' + (err.message || String(err));
    $('content').replaceChildren(d);
  }
}

$('btnCopy').addEventListener('click', async () => {
  const btn = $('btnCopy');
  try {
    await navigator.clipboard.writeText(md);
    const old = btn.textContent;
    btn.textContent = '已复制 ✓';
    setTimeout(() => (btn.textContent = old), 1500);
  } catch (err) {
    btn.textContent = '复制失败';
    setTimeout(() => (btn.textContent = '复制 Markdown'), 1500);
  }
});

function safeFileName(name) {
  return String(name)
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'youtube';
}

// 文件名前缀，方便在下载文件夹里一眼认出、也方便排序和批量筛选。
// 想换成别的（比如 'yt_speedreading_'）改这一行就行。
const FILE_PREFIX = 'YTSR_';

$('btnDownload').addEventListener('click', () => {
  const filename = `${FILE_PREFIX}${safeFileName(title)}${videoId ? '-' + videoId : ''}.md`;
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

load();
