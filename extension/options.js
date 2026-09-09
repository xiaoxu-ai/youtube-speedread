// options.js —— 设置页

const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  apiBaseUrl: '',
  apiKey: '',
  model: 'deepseek-v4-flash',
  temperature: 0.3,
  maxTokens: 8192,
  chunkChars: 2400,
  concurrency: 3,
  preferredLang: 'auto',
  disableThinking: true,
};

function setStatus(text, type = 'info') {
  const el = $('status');
  el.textContent = text;
  el.className = type;
}

async function load() {
  const cfg = await chrome.storage.sync.get(DEFAULTS);
  for (const k of Object.keys(DEFAULTS)) {
    const el = $(k);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!cfg[k];
    else el.value = cfg[k];
  }
}

// 数字输入：只有真的填了合法值才覆盖默认值。
// 注意不能用 `parseFloat(v) || d`，那样用户填 0 会被吃掉。
function num(id, def, { min, max } = {}) {
  const raw = $(id).value.trim();
  if (raw === '') return def;
  const v = Number(raw);
  if (!Number.isFinite(v)) return def;
  if (min != null && v < min) return min;
  if (max != null && v > max) return max;
  return v;
}

function collect() {
  return {
    apiBaseUrl: $('apiBaseUrl').value.trim(),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim() || DEFAULTS.model,
    temperature: num('temperature', DEFAULTS.temperature, { min: 0, max: 2 }),
    maxTokens: num('maxTokens', DEFAULTS.maxTokens, { min: 512, max: 32000 }),
    chunkChars: num('chunkChars', DEFAULTS.chunkChars, { min: 800, max: 8000 }),
    concurrency: num('concurrency', DEFAULTS.concurrency, { min: 1, max: 8 }),
    preferredLang: $('preferredLang').value,
    disableThinking: $('disableThinking').checked,
  };
}

function originOf(baseUrl) {
  try {
    return new URL(baseUrl).origin + '/*';
  } catch (e) {
    return null;
  }
}

$('btnSave').addEventListener('click', async () => {
  const cfg = collect();

  if (!cfg.apiBaseUrl || !cfg.apiKey) {
    setStatus('Base URL 和 API Key 都要填。', 'error');
    return;
  }
  const origin = originOf(cfg.apiBaseUrl);
  if (!origin) {
    setStatus('Base URL 格式不对，要带上 https:// 开头。', 'error');
    return;
  }

  // 先请求跨域权限，再保存。
  // 顺序很重要：chrome.permissions.request 必须在用户手势里同步发起，
  // 如果先 await storage.set，手势可能已经过期，弹窗就出不来了。
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [origin] });
  } catch (e) {
    setStatus('请求接口访问权限时出错：' + e.message, 'error');
  }

  await chrome.storage.sync.set(cfg);

  if (granted) {
    setStatus(`已保存，并已获得访问 ${origin} 的权限。可以去 YouTube 试了。`, 'success');
  } else {
    setStatus(
      `设置已保存，但没拿到访问 ${origin} 的权限 —— 这种情况下调用 AI 接口会被浏览器以跨域为由拦掉。请再点一次「保存设置」，并在弹窗里选「允许」。`,
      'error'
    );
  }
});

// 同一个厂商往往有好几条路径，用户很难猜对（z.ai 就有 /api/paas/v4 和已失效的
// /api/openai/v1 两条）。测试失败时自动把同域名下的常见路径都探一遍，
// 直接告诉用户哪条是对的。只探同一个 origin，Key 不会发给别的厂商。
const PATH_CANDIDATES = [
  '/api/paas/v4',
  '/v1',
  '/api/v1',
  '/api/coding/paas/v4',
  '/api/paas/v3',
  '/openai/v1',
  '/api/openai/v1',
];

function chatEndpoint(base) {
  const b = String(base).trim().replace(/\/+$/, '');
  return /\/chat\/completions$/.test(b) ? b : b + '/chat/completions';
}

function candidateBases(entered) {
  const list = [entered.replace(/\/+$/, '')];
  try {
    const o = new URL(entered).origin;
    for (const p of PATH_CANDIDATES) {
      const c = o + p;
      if (!list.includes(c)) list.push(c);
    }
  } catch (e) {}
  return list;
}

async function probe(base, cfg, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(chatEndpoint(base), {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        // 思考模式下模型会先烧 token 推理，额度给小了会返回空，测试就会误报
        max_tokens: 512,
        temperature: 0,
        messages: [{ role: 'user', content: '只回复两个字：正常' }],
        ...(cfg.disableThinking && /glm|qwen|zhipu|deepseek|kimi-?k|doubao|hunyuan/i.test(cfg.model)
          ? { thinking: { type: 'disabled' } }
          : {}),
      }),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) {}

    const notFound =
      res.status === 404 ||
      /404|not[_ ]?found/i.test(String(data?.msg || data?.message || '')) ||
      /404 Not Found/i.test(text.slice(0, 200));

    if (notFound) return { base, kind: 'badpath', detail: '路径不存在' };
    if (res.status === 401 || res.status === 403) {
      return { base, kind: 'auth', detail: `路径正确，但 Key 被拒（${res.status}）` };
    }
    if (!res.ok) return { base, kind: 'error', detail: `HTTP ${res.status}：${text.slice(0, 160)}` };

    const reply = data?.choices?.[0]?.message?.content;
    if (typeof reply === 'string') {
      return { base, kind: 'ok', detail: reply.trim().slice(0, 60) || '(空回复)' };
    }
    return { base, kind: 'error', detail: `没有 choices：${text.slice(0, 160)}` };
  } catch (e) {
    return {
      base,
      kind: 'error',
      detail: e.name === 'AbortError' ? '超时' : e.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

$('btnTest').addEventListener('click', async () => {
  const cfg = collect();
  if (!cfg.apiBaseUrl || !cfg.apiKey) {
    setStatus('先把 Base URL 和 API Key 填上再测。', 'error');
    return;
  }
  const origin = originOf(cfg.apiBaseUrl);
  if (!origin) {
    setStatus('Base URL 格式不对，要带 https:// 开头。', 'error');
    return;
  }

  // 权限必须在用户手势里同步申请，不能 await 别的异步操作之后再要
  let allowed = false;
  try {
    allowed = await chrome.permissions.contains({ origins: [origin] });
    if (!allowed) allowed = await chrome.permissions.request({ origins: [origin] });
  } catch (e) {}
  if (!allowed) {
    setStatus('没有访问该接口的权限。点「保存设置」并在弹窗里选「允许」。', 'error');
    return;
  }

  $('btnTest').disabled = true;
  setStatus('正在测试…', 'info');

  const entered = cfg.apiBaseUrl.replace(/\/+$/, '');
  const first = await probe(entered, cfg);

  if (first.kind === 'ok') {
    setStatus(`连接正常。模型 ${cfg.model} 回复：${first.detail}`, 'success');
    $('btnTest').disabled = false;
    return;
  }
  if (first.kind === 'auth') {
    setStatus(`${first.detail}。地址是对的，检查 API Key 是否填错或已过期。`, 'error');
    $('btnTest').disabled = false;
    return;
  }

  // 走到这里说明地址多半不对，把同域名下的其它常见路径挨个试
  setStatus(`${entered} 不通（${first.detail}），正在自动尝试同域名下的其它路径…`, 'info');

  const others = candidateBases(entered).filter((b) => b !== entered);
  const tried = [`${entered} → ${first.detail}`];
  let winner = null;

  for (const b of others) {
    const r = await probe(b, cfg, 15000);
    tried.push(`${b} → ${r.detail}`);
    if (r.kind === 'ok' || r.kind === 'auth') {
      winner = r;
      break;
    }
  }

  if (winner) {
    $('apiBaseUrl').value = winner.base;
    if (winner.kind === 'ok') {
      setStatus(
        `找到了！正确地址是 ${winner.base}\n已经帮你填进上面的输入框，记得点「保存设置」。\n模型回复：${winner.detail}`,
        'success'
      );
    } else {
      setStatus(
        `地址应该是 ${winner.base}（已帮你填好），但 ${winner.detail}。请检查 API Key。`,
        'error'
      );
    }
  } else {
    setStatus(`几条常见路径都不通：\n${tried.join('\n')}\n请对照你的服务商文档确认 Base URL。`, 'error');
  }

  $('btnTest').disabled = false;
});

load();
