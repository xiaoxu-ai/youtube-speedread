// popup.js —— 只做两件事：发起任务、显示进度。
// 任务本身跑在 background，所以这个窗口随时可以关，不影响进行中的翻译。

const $ = (id) => document.getElementById(id);
const RUNNING = ['extracting', 'translating', 'analyzing', 'summarizing'];
let lastState = { resumable: false, stale: false };

function setStatus(text, type = '') {
  const el = $('status');
  el.textContent = text;
  el.className = 'status ' + type;
}

function setBar(state, current, total) {
  const bar = $('bar');
  const fill = $('barFill');
  if (!state) {
    bar.className = 'bar';
    return;
  }
  if (total > 0) {
    bar.className = 'bar on';
    fill.style.width = Math.round((current / total) * 100) + '%';
  } else {
    bar.className = 'bar on indet';
    fill.style.width = '35%';
  }
}

function setMeta(job) {
  const el = $('meta');
  if (!job?.title) {
    el.className = 'meta';
    return;
  }
  const bits = [`<b>${escapeHtml(job.title)}</b>`];
  const sub = [];
  if (job.author) sub.push(escapeHtml(job.author));
  if (job.language) sub.push(escapeHtml(job.language) + (job.isAuto ? '（自动字幕）' : '（人工字幕）'));
  if (job.chars) sub.push(job.chars + ' 字符');
  if (sub.length) bits.push(sub.join(' · '));
  el.innerHTML = bits.join('<br>');
  el.className = 'meta on';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function render(job) {
  const btn = $('btnProcess');
  const open = $('btnOpen');

  btn.dataset.mode = 'start';
  if (!job) {
    setStatus('在 YouTube 视频页点下面的按钮，字幕会被提取、翻译成中文并提炼要点。');
    setBar(false);
    setMeta(null);
    btn.disabled = false;
    btn.textContent = '开始速读';
    open.style.display = 'none';
    return;
  }

  setMeta(job);

  if (RUNNING.includes(job.status)) {
    // 很久没更新 = Service Worker 被浏览器回收了，给用户一个「继续」按钮。
    // （后台的闹钟通常会自己续上，这个按钮是让人不用干等的手动通道）
    if (lastState.stale && lastState.resumable) {
      setStatus('任务被浏览器中断了，进度已保存。点下面的按钮从断点继续。', 'error');
      setBar(true, job.current || 0, job.total || 0);
      btn.disabled = false;
      btn.textContent = '从断点继续';
      btn.dataset.mode = 'resume';
      open.style.display = 'none';
      return;
    }
    setStatus(job.message || '处理中…');
    setBar(true, job.current || 0, job.total || 0);
    btn.disabled = true;
    btn.textContent = '处理中…（可以关掉这个窗口）';
    btn.dataset.mode = 'start';
    open.style.display = 'none';
    return;
  }

  if (job.status === 'done') {
    setStatus(
      job.failedTopics
        ? `已完成，但有 ${job.failedTopics} 个主题分析失败（正文不受影响）。`
        : '已完成，结果已在新标签页打开。',
      job.failedTopics ? 'error' : 'success'
    );
    setBar(false);
    btn.disabled = false;
    btn.textContent = '再来一个';
    open.style.display = 'block';
    return;
  }

  if (job.status === 'error') {
    setStatus(job.error || '处理失败', 'error');
    setBar(false);
    btn.disabled = false;
    btn.textContent = '重试';
    open.style.display = 'none';
  }
}

async function refresh() {
  const res = await chrome.runtime.sendMessage({ action: 'getJob' }).catch(() => null);
  lastState = { resumable: !!res?.resumable, stale: !!res?.stale };
  render(res?.job || null);
}

// 处理中时定时刷新，好让「被中断」的状态能及时暴露出来
setInterval(() => {
  if (document.visibilityState === 'visible') refresh();
}, 5000);

// background 写 storage 时自动刷新，不用轮询
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.job) render(changes.job.newValue || null);
});

$('btnProcess').addEventListener('click', async () => {
  if ($('btnProcess').dataset.mode === 'resume') {
    setStatus('正在从断点继续…');
    $('btnProcess').disabled = true;
    const r = await chrome.runtime.sendMessage({ action: 'resumeJob' });
    if (!r?.ok) {
      setStatus(r?.error || '续跑失败', 'error');
      $('btnProcess').disabled = false;
    }
    return;
  }

  const cfg = await chrome.storage.sync.get(['apiBaseUrl', 'apiKey']);
  if (!cfg.apiBaseUrl || !cfg.apiKey) {
    setStatus('还没配置 AI 接口。点下面的「⚙ 设置」填好 Base URL 和 API Key。', 'error');
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  if (!/youtube\.com\/watch/.test(url)) {
    setStatus('请先打开一个 YouTube 视频播放页（网址里带 /watch 的那种），再点这里。', 'error');
    return;
  }

  $('btnProcess').disabled = true;
  setStatus('启动中…');
  setBar(true, 0, 0);

  const res = await chrome.runtime.sendMessage({ action: 'startJob', tabId: tab.id });
  if (!res?.ok) {
    setStatus(res?.error || '启动失败', 'error');
    $('btnProcess').disabled = false;
    setBar(false);
  }
});

$('btnOpen').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('result.html'), active: true });
  window.close();
});

$('linkOptions').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

$('linkReset').addEventListener('click', async (e) => {
  e.preventDefault();
  await chrome.runtime.sendMessage({ action: 'clearJob' });
  refresh();
});

refresh();
