importScripts('storage-queue.js');

// background.js —— Service Worker，整个流程的编排者
//
// 关键设计：
// 1. 所有耗时工作都在这里跑，popup 只负责「发起」和「看进度」，关掉不影响任务。
// 2. 每完成一小步就落盘（chunk 级），同一浏览器会话内被中断时尝试从断点接着跑。
// 3. 输出分三部分：视频简介 / 主题拆解 / 双语全文（原声已是中文时是「全文」单栏）。

const DEFAULTS = {
  apiBaseUrl: '',
  apiKey: '',
  model: 'deepseek-v4-flash',
  temperature: 0.3,
  maxTokens: 8192,
  chunkChars: 2400,
  analysisChars: 14000,
  concurrency: 3,
  preferredLang: 'auto',
  disableThinking: true,
  requestTimeoutMs: 120000,
};

// GLM / Qwen 这类「混合推理」模型默认开着思考模式，会先烧掉一大截 token 做推理，
// max_tokens 不够时正文根本没开始写就被截断 —— 表现就是 content 为空。
// 翻译任务不需要推理，所以默认关掉；但这个字段是厂商私有的，
// 发给 OpenAI 那种严格校验的接口会直接 400，所以只对认识的模型名发。
const THINKING_MODELS = /glm|qwen|zhipu|deepseek|kimi-?k|doubao|hunyuan/i;

function thinkingParam(cfg) {
  if (!cfg.disableThinking) return null;
  if (!THINKING_MODELS.test(String(cfg.model || ''))) return null;
  return { type: 'disabled' };
}

const JOB_KEY = 'job';       // UI 状态：小，写得频繁
const DATA_KEY = 'jobData';  // 大数据：段落、译文、主题 —— 断点续传全靠它
const RESUME_ALARM = 'ytsr-resume';
const STALE_MS = 90000;      // 超过这么久没更新，判定为「被回收了」
const RUNNING = ['extracting', 'translating', 'analyzing', 'summarizing'];
const jobStore = YTSRStorageQueue.createStorageQueue(chrome.storage.session, JOB_KEY);
const dataStore = YTSRStorageQueue.createStorageQueue(chrome.storage.session, DATA_KEY);

// ---------------------------------------------------------------- 状态存取

async function setJob(patch) {
  return jobStore.update((cur) => ({ ...(cur || {}), ...patch, updatedAt: Date.now() }));
}

async function getJob() {
  return jobStore.get();
}

async function setData(patch) {
  return dataStore.patch(patch);
}

async function updateData(mutator) {
  return dataStore.update((cur) => {
    if (!cur) throw new Error('任务检查点不存在，无法更新。');
    return mutator(cur);
  });
}

async function getData() {
  return dataStore.get();
}

// MV3 的 Service Worker 会在闲置后被回收。周期性调用扩展 API 可以重置空闲计时，
// 但这里只把它当作尽力保活；真正的可靠性仍依赖可重入阶段和 session 检查点。
let keepAliveTimer = null;
function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 20000);
}
function stopKeepAlive() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

// 再挂一个闹钟：Service Worker 被回收后尝试唤醒它，发现任务卡住就从断点续跑。
function armResumeAlarm() {
  chrome.alarms.create(RESUME_ALARM, { periodInMinutes: 1 });
}
function disarmResumeAlarm() {
  chrome.alarms.clear(RESUME_ALARM).catch(() => {});
}

// ---------------------------------------------------------------- AI 客户端

async function getConfig() {
  return chrome.storage.sync.get(DEFAULTS);
}

function chatUrl(baseUrl) {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '');
  // 容忍用户把完整路径填进来
  if (/\/chat\/completions$/.test(b)) return b;
  return b + '/chat/completions';
}

async function callChat(cfg, messages, { maxTokens } = {}) {
  const url = chatUrl(cfg.apiBaseUrl);
  const think = thinkingParam(cfg);
  let budget = Number(maxTokens || cfg.maxTokens || DEFAULTS.maxTokens);
  let lastErr = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.requestTimeoutMs || 120000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model || DEFAULTS.model,
          temperature: Number(cfg.temperature),
          max_tokens: budget,
          messages,
          ...(think ? { thinking: think } : {}),
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');

        // 429 通常是限流（值得重试），但「余额不足」也常被塞进 429 里，
        // 那种重试多少次都没用，必须立刻停下来告诉用户去充值。
        if (/余额不足|欠费|资源包|insufficient[_ ]?(balance|quota|credit)|arrears|billing/i.test(body)) {
          throw new Error(
            `AI 接口余额不足，请先充值或更换 Key。\n接口原话：${body.slice(0, 200)}`
          );
        }

        const err = new Error(
          `AI 接口返回 ${res.status}${body ? '：' + body.slice(0, 300) : ''}`
        );
        // 4xx（除 429）是配置问题，重试没意义
        if (res.status !== 429 && res.status >= 400 && res.status < 500) throw err;
        lastErr = err;
      } else {
        const data = await res.json();

        // 有些网关 HTTP 200 但正文里带 error
        if (data?.error) {
          throw new Error(
            `AI 接口报错：${data.error.message || JSON.stringify(data.error).slice(0, 200)}`
          );
        }

        // 另一种信封：HTTP 200，但正文是 {code, msg, success:false}。
        // z.ai 填错路径时就长这样：{"code":500,"msg":"404 NOT_FOUND","success":false}
        if (!data?.choices && (data?.success === false || data?.msg || data?.message)) {
          const m = String(data.msg || data.message || '');
          const pathLooksWrong = /404|not[_ ]?found/i.test(m);
          throw new Error(
            `AI 接口报错：${m || JSON.stringify(data).slice(0, 200)}` +
              (pathLooksWrong
                ? '\n→ 这是「路径不存在」，说明 API Base URL 填错了。到设置页点「测试连接」，它会自动帮你找对的地址。'
                : '')
          );
        }

        const choice = data?.choices?.[0];
        const msg = choice?.message;
        const finish = choice?.finish_reason;
        let content = typeof msg?.content === 'string' ? msg.content : '';

        // ⚠️ 顺序很重要：先判断「是不是被截断了」，再考虑别的字段。
        // content 空 + finish_reason=length，说明额度全烧在推理上、正文还没开始写。
        // 这时 reasoning_content 里装的是模型的思考过程，不是译文，
        // 拿它当结果会把一堆「嗯…让我想想…」写进正文里。正确做法是加大额度重试。
        if (!content.trim() && finish === 'length' && attempt < 2) {
          budget = Math.min(budget * 3, 32000);
          lastErr = new Error(
            `模型把 max_tokens 用在推理上了，正文为空；已把额度提到 ${budget} 重试。`
          );
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }

        // 没被截断却仍然没有 content：某些推理模型确实把正文放在别的字段里
        if (!content.trim() && finish !== 'length') {
          for (const alt of [msg?.reasoning_content, msg?.reasoning, choice?.text]) {
            if (typeof alt === 'string' && alt.trim()) {
              content = alt;
              break;
            }
          }
        }

        if (!content.trim()) {
          let why;
          if (finish === 'length') {
            why =
              `模型还没开始输出正文就把 max_tokens 耗尽了（已自动加大到 ${budget} 仍不够）。` +
              'GLM / Qwen 这类模型默认开着思考模式，建议在设置里勾上「关闭思考模式」，' +
              '或者把「单次最大输出 tokens」再调大。';
          } else if (finish === 'content_filter') {
            why = '被接口的内容审核拦了。';
          } else if (!choice) {
            why = '接口没返回 choices，多半是 Base URL 或模型名不对。';
          } else {
            why = `接口返回了 choices 但 content 是空的（finish_reason=${finish ?? '未知'}）。`;
          }
          throw new Error(
            `AI 返回内容为空：${why}\n原始响应片段：${JSON.stringify(data).slice(0, 400)}`
          );
        }

        return { content, truncated: finish === 'length' };
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        lastErr = new Error('AI 接口请求超时。');
      } else {
        lastErr = e;
        if (/AI 接口返回 4/.test(e.message)) throw e;
        if (/余额不足/.test(e.message)) throw e;
      }
    } finally {
      clearTimeout(timer);
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
  }
  throw lastErr || new Error('AI 接口调用失败');
}

// ---------------------------------------------------------------- 分块

function chunkIndexes(paragraphs, chunkChars) {
  const out = [];
  let cur = [];
  let len = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    if (cur.length && len + paragraphs[i].text.length > chunkChars) {
      out.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(i);
    len += paragraphs[i].text.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

// ---------------------------------------------------------------- 翻译

// 只让模型输出译文（不回吐原文），输出量减半，被截断的概率大幅下降；
// 双语对照由本地按顺序拼装，格式完全可控。
//
// 对齐方式用「编号」而不是「分隔符」：实测 GLM 会把要求的 ===SPLIT=== 自作主张
// 简化成 ===，甚至干脆只用空行分段。编号则是自校验的 —— 每段译文自己带着
// 它属于第几段，模型少译、合并、乱序都能被发现，而且只影响出问题的那一段。
function buildTranslatePrompt(texts, strict) {
  const numbered = texts.map((t, i) => `[${i + 1}] ${t}`).join('\n\n');
  return `把下面 ${texts.length} 段视频字幕翻译成流畅、自然的简体中文。

硬性要求：
1. 必须输出 ${texts.length} 段，一段都不能少、不能合并、不能改顺序。
2. 每段译文都要以对应编号开头，格式是 [1]、[2] …… 和原文编号严格对应。
3. 编号后面直接跟译文。不要输出原文，不要加任何说明、标题或分隔线。
4. 口语里的重复和语气词可以适当省略，但意思不能丢。
${strict ? '\n⚠️ 上一次你没有按编号格式输出。这次务必让每一段都以 [数字] 开头。\n' : ''}
输出格式示例：
[1] 第一段的中文译文
[2] 第二段的中文译文

字幕原文：

${numbered}`;
}

// 返回定长数组（长度 = expected），第 i 项是第 i+1 段的译文，缺的就是空串。
function parseTranslation(raw, expected) {
  const out = new Array(expected).fill('');

  // 要求编号必须带右括号（] 】 ）），否则正文里的「2025 年」之类会被误当成编号
  const marker = /^\s*[[【(]?(\d{1,3})[\]】)]\s*/;
  const lines = String(raw).split('\n');

  let cur = 0;
  let buf = [];

  const flush = () => {
    if (cur >= 1 && cur <= expected) {
      const t = buf.join('\n').trim();
      if (t) out[cur - 1] = out[cur - 1] ? out[cur - 1] + '\n' + t : t;
    }
    buf = [];
  };

  for (const line of lines) {
    const m = line.match(marker);
    if (m) {
      flush();
      cur = Number(m[1]);
      buf.push(line.slice(m[0].length));
    } else if (cur >= 1) {
      buf.push(line);
    }
  }
  flush();

  const filled = out.filter((s) => s.trim()).length;
  if (filled > 0) return { parts: out, filled, expected, method: 'numbered' };

  // 兜底一：模型完全没给编号时，退回按分隔线切。
  // 放宽到「整行只有 = - * 或写着 SPLIT」，因为模型很爱自由发挥分隔符。
  const chunks = String(raw)
    .split(/^[ \t]*(?:={2,}\s*SPLIT\s*={2,}|[=\-*_]{3,})[ \t]*$/gm)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(marker, ''));

  if (chunks.length === expected) {
    return { parts: chunks, filled: expected, expected, method: 'separator' };
  }

  // 兜底二：模型经常干脆只用空行分段，什么分隔符都不给。
  // 空行切分本身不可靠（译文里也可能有空行），所以只在段数「恰好吻合」时才采信。
  const byBlank = String(raw)
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(marker, ''));

  if (byBlank.length === expected) {
    return { parts: byBlank, filled: expected, expected, method: 'blankline' };
  }

  // 实在对不上：整块塞进第一段，至少不丢内容
  const dump = new Array(expected).fill('');
  dump[0] = chunks.length ? chunks.join('\n\n') : String(raw).trim();
  return { parts: dump, filled: dump[0] ? 1 : 0, expected, method: 'dump' };
}

// ---------------------------------------------------------------- 主题拆解
//
// ⚠️ 这里有个教训值得写下来：**绝不能「按块各自找话题」**。
//
// 第一版把中文稿切成 14000 字的块，每块独立产出话题。后果有两个：
//   1. 横跨块边界的一个完整话题被硬劈成两半；
//   2. 模型从头到尾没见过全局，判断不出「这段其实和 20 分钟前是同一个主题」。
// 按字数切块本来只是为了绕开上下文限制，却被当成了话题边界，这是因果倒置。
//
// 现在改成两趟：
//   第一趟（划边界）：本地把全片压成「段落梗概骨架」——每段只留开头一小截，
//     整篇压到 2 万多字，**一次性**喂给模型，让它站在全局视角切分话题。
//   第二趟（写细节）：拿到边界后，用每个话题覆盖的【真实全文】分别写
//     讲了什么 / 要点。
// 边界是全局决定的，细节又是基于原文的，两头都不将就。

const MINUTES_PER_TOPIC = 15;   // 大约每 15 分钟内容一个话题
const MIN_TOPICS = 3;
const MAX_TOPICS = 10;
const OUTLINE_BUDGET = 24000;   // 骨架总字数上限，保证一次调用装得下

function targetTopicCount(lengthSeconds, totalChars) {
  // 没拿到时长就用字数估：口播大约 900-1000 字/分钟（中文稿）
  const minutes = lengthSeconds > 0 ? lengthSeconds / 60 : totalChars / 950;
  const n = Math.round(minutes / MINUTES_PER_TOPIC);
  return Math.max(MIN_TOPICS, Math.min(MAX_TOPICS, n));
}

// 本地压缩，不花钱：每段只留开头一小截。段落越多，每段留得越短，
// 保证整篇骨架不超预算 —— 再长的视频也能塞进一次调用里。
function buildSkeleton(items, budget = OUTLINE_BUDGET) {
  const per = Math.max(20, Math.floor(budget / Math.max(1, items.length)) - 10);
  return items
    .map((it) => {
      const t = it.text.replace(/\s+/g, ' ').trim();
      return `[${it.no}] ${t.length > per ? t.slice(0, per) + '…' : t}`;
    })
    .join('\n');
}

function buildOutlinePrompt(skeleton, total, want, title) {
  return `下面是视频《${title}》全片 ${total} 个段落的梗概，每行开头的 [数字] 是段落编号。
每行只是该段的开头一小截，用来让你看清全片的脉络走向。

请通读全部内容，从**全局**判断这个视频可以分成哪几个话题，并给出每个话题的段落范围。

严格按下面格式输出，每个话题一块：

=== 主题 ===
段落: 起始编号-结束编号
标题: 一句话概括这个话题（12 字以内，别用「关于」「介绍」这类废话开头）

硬性要求：
- **必须切成 ${want} 个话题**，不多不少。
- 段落范围必须**首尾相接、完整覆盖 1 到 ${total}、互不重叠**：
  第一个话题从 1 开始，最后一个话题到 ${total} 结束，
  下一个话题的起始编号 = 上一个话题的结束编号 + 1。
- 按内容的自然转折来切，不要机械地平均分。一个话题横跨几十段是完全正常的。
- 只输出上述格式，不要有开场白、总结或任何解释。

全片梗概：

${skeleton}`;
}

// 从一块文本里按「字段名: 值」抽字段，字段值可以跨多行
//
// 「概要 / 逻辑」是上一版的字段名，现在合并成了「讲了什么」（见 buildDetailPrompt）。
// 这里仍然认这两个旧名字：一是模型偶尔会凭惯性写旧标签，二是中途断掉的任务
// 续传时，前半截话题是旧格式存下来的，认不出来就等于白跑一遍。
function parseFields(block) {
  const KEY = {
    段落: 'range', 标题: 'title',
    讲了什么: 'summary', 概要: 'summary',
    要点: 'points', 观点: 'points', 主要观点: 'points',
    逻辑: 'logic', 逻辑推导: 'logic',
  };
  const f = { range: '', title: '', summary: '', points: '', logic: '' };
  let cur = null;
  for (const line of String(block).split('\n')) {
    const m = line.match(/^[ \t]*(段落|标题|讲了什么|概要|要点|主要观点|观点|逻辑推导|逻辑)\s*[:：]\s*(.*)$/);
    if (m) {
      cur = KEY[m[1]];
      f[cur] = f[cur] ? f[cur] + '\n' + m[2] : m[2];
    } else if (cur) {
      f[cur] += '\n' + line;
    }
  }
  return f;
}

function splitTopicBlocks(raw) {
  const text = String(raw);
  let blocks = text
    .split(/^[ \t]*[=\-*#]{2,}\s*主题\s*[=\-*#]{0,}[ \t]*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
  if (blocks.length <= 1) {
    const parts = text
      .split(/(?=^[ \t]*标题\s*[:：])/m)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 1) blocks = parts;
  }
  return blocks;
}

function parseOutline(raw) {
  const out = [];
  for (const block of splitTopicBlocks(raw)) {
    const f = parseFields(block);
    const title = f.title.trim().replace(/^[#*\s]+/, '').split('\n')[0].trim();
    if (!title) continue;
    const rm = f.range.match(/(\d+)\s*[-–—~～到至]\s*(\d+)/);
    out.push({
      title,
      from: rm ? Number(rm[1]) : null,
      to: rm ? Number(rm[2]) : null,
    });
  }
  return out;
}

// 模型给的范围难免有重叠、断层、越界。这里强行修成一条
// 首尾相接、完整覆盖 1..total 的序列 —— 否则时间戳会算错，段落也会漏。
function normalizeOutline(topics, total, want) {
  let list = topics
    .filter((t) => t.title)
    .map((t) => ({
      title: t.title,
      from: Number.isFinite(t.from) ? Math.max(1, Math.min(total, t.from)) : null,
      to: Number.isFinite(t.to) ? Math.max(1, Math.min(total, t.to)) : null,
    }))
    .filter((t) => t.from !== null);

  list.sort((a, b) => a.from - b.from);

  const fixed = [];
  let cursor = 1;
  for (const t of list) {
    const from = Math.max(cursor, t.from);
    if (from > total) break;
    const to = t.to !== null && t.to >= from ? Math.min(total, t.to) : from;
    fixed.push({ title: t.title, from, to });
    cursor = to + 1;
  }

  if (!fixed.length) {
    // 模型完全没给出可用边界：退回平均切分，至少结构还在
    const n = Math.max(1, want);
    const size = Math.ceil(total / n);
    for (let i = 0; i < n; i++) {
      const from = i * size + 1;
      if (from > total) break;
      fixed.push({ title: `第 ${i + 1} 部分`, from, to: Math.min(total, from + size - 1) });
    }
    return fixed;
  }

  fixed[0].from = 1;                       // 保证从头覆盖
  fixed[fixed.length - 1].to = total;      // 保证到尾覆盖
  // 补断层：把每个话题的结尾接到下一个的开头
  for (let i = 0; i < fixed.length - 1; i++) fixed[i].to = fixed[i + 1].from - 1;
  return fixed.filter((t) => t.to >= t.from);
}

// 早先这里是三段式：概要 / 观点 / 逻辑推导。问题是「概要」和「逻辑」本来就是
// 同一件事的两个粒度 —— 一个是「讲了什么」的压缩版，一个是它的展开版 ——
// 模型只能把同一件事说两遍。真正独立的只有「观点」，因为它抽的是主张而不是叙述。
//
// 而且三段式假定了视频都在论证。旧 prompt 里那句「如果这段只是叙述而非论证，
// 就说明它的叙述脉络」就是给叙事类视频打的补丁：创业故事、讲道、教程这些
// 根本没有「论证」可推，那一栏只能空转或者复述概要。
//
// 现在合成一段连贯叙述。论证型的视频它自然会带上推理链，叙事型的就是事情经过，
// 教学型的就是讲解顺序 —— 不用再靠补丁去适配。
function buildDetailPrompt(topic, bodyText, title) {
  return `下面是视频《${title}》中「${topic.title}」这个话题的完整内容（第 ${topic.from} 到 ${topic.to} 段）。

请严格按以下格式输出分析，用简体中文：

讲了什么: 用一段连贯的话说清楚这个话题的内容和脉络，4-8 句。
不要先总述再展开，直接顺着讲：从哪里说起，中间用了什么依据、例子或数据，
最后落到什么地方。是论证就把推理链写出来，是叙事就把事情经过讲清楚，
是讲解就按它的讲解顺序走。
要点:
- 这个话题里最值得记住的判断或主张（一条一句）
- 2-4 条，只写这段内容真正支撑得起的，宁少勿凑

只输出这两个字段，不要重复标题，不要加开场白。

内容：

${bodyText}`;
}

function parseDetail(raw) {
  const f = parseFields(raw);
  return {
    summary: f.summary.trim(),
    points: f.points
      .split('\n')
      .map((s) => s.replace(/^[-*•·\s]+/, '').trim())
      .filter(Boolean),
    logic: f.logic.trim(),
  };
}

// prompt 里的写作说明，模型总有一定概率原样抄进结果里 —— 光靠「不要输出」这句话
// 拦不住，所以出来之后再洗一遍。只删标记本身，标记后面跟着的正文要留下。
function stripSectionMarkers(raw) {
  return String(raw)
    // 整行只有一个标记：连行一起删
    .replace(/^[ \t]*[【\[(（]?第[一二三四五六1-6]部分[】\])）]?[ \t]*[:：]?[ \t]*$\n?/gm, '')
    // 标记后面还接着正文：只删标记，正文顶上来
    .replace(/^[ \t]*[【\[(（]?第[一二三四五六1-6]部分[】\])）]?[ \t]*[:：]?[ \t]*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 「人物」一节只对访谈 / 对谈 / 演讲类视频有意义，教程和评测就不该有。
// 让模型自己判断该不该写，但把「不许编」这条钉死 —— 人物头衔是最容易被
// 模型顺手补全的东西，而编错别人的身份是实打实的伤害。
function buildOverallPrompt(topics, meta, evidence) {
  const outline = topics
    .map((t, i) => `${i + 1}. ${t.title}\n   ${t.summary.replace(/\s+/g, ' ').slice(0, 200)}`)
    .join('\n');

  return `下面是视频《${meta.title}》（频道：${meta.author || '未知'}）按话题拆解后的提纲，
以及可供参考的原始材料。

请写「视频简介」，用简体中文，按下面说的顺序写。

**输出里只允许出现两个小标题：「**人物**」和「**全片要点**」。**
不要写「第一部分」「一、」「总述」这类分段标记或标题 —— 这几条只是给你的写作说明，
不是要你抄进结果里。

一开头，先写一段 150-250 字的总述，说清楚这个视频整体在讲什么、想让观众得到什么。
不加任何标题，直接写这段话。

接着是人物介绍 —— **只在这是访谈、对谈、演讲、播客这类有明确讲话人的视频时才写**。
如果是教程、评测、新闻播报、剪辑合集这种没有明确人物主体的，就整段跳过，
连「**人物**」这个标题都不要出现。

要写的话，格式是：
**人物**
- 姓名 —— 他是谁、什么身份、为什么值得听他讲这件事

硬性约束：
- 最多写 4 个人，只写主讲人和主要对谈者，一闪而过的名字不写。
- 每人 40-80 字，写成一句完整的话，不要罗列头衔清单。
- **只能使用下面「原始材料」里明确出现过的信息。**
- **绝对不许补充你从其它地方知道的任何内容** —— 不许添加材料里没提到的头衔、
  公司、成就、履历、年龄、国籍。
- 如果材料里查不出某人是谁，就不要写这个人；如果一个人都查不出，
  就整段跳过人物介绍。宁可不写，也不能猜。

最后是：
**全片要点**
- 用 4-7 条罗列全片最值得记住的信息，每条一行，以「- 」开头，每条一句话。

除上述内容外不要输出任何其它东西。

===== 话题提纲 =====

${outline}

===== 原始材料（判断人物身份只能依据这里） =====

${evidence || '（无）'}`;
}

// ---------------------------------------------------------------- 中文原声

// 字幕本来就是中文时，再调一遍模型「翻译成中文」是纯浪费 ——
// 一个 40 分钟的视频光这一步就是十几次调用，而产出和原文一模一样。
// 所以这种视频直接跳过翻译，第三部分从「双语全文」变成「全文」单栏。
//
// 判断优先信任 YouTube 给的 languageCode（zh / zh-Hans / zh-Hant / zh-CN / yue…），
// 它是权威的。只有在拿不到语言码时才退回看字形。
//
// ⚠️ 看字形必须把日文排除掉：日文里大量汉字，只数 CJK 统一表意文字会把
// 日语视频误判成中文，那就等于整片不翻译了。假名（ひらがな/カタカナ）
// 是日文独有的，出现就一票否决。韩文谚文同理。
function isChineseSource(meta, paragraphs) {
  const code = String(meta?.language || '').toLowerCase();
  if (code) return /^(zh|yue)\b/.test(code) || code.startsWith('zh-');

  const sample = (paragraphs || [])
    .slice(0, 40)
    .map((p) => p.text || '')
    .join('')
    .slice(0, 4000);
  if (!sample) return false;
  if (/[぀-ヿ가-힯]/.test(sample)) return false;   // 假名 / 谚文
  const han = (sample.match(/[一-鿿]/g) || []).length;
  return han / sample.length > 0.3;
}

// ---------------------------------------------------------------- Markdown

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

// 统一的日期格式：yyyy-mm-dd。
// 发布时间和提炼时间都用它，保证两行看起来是一套东西。
//
// 早先这里还会输出「（生成本文时：38 天前）」，后来去掉了 ——
// 「多久以前」是个会衰减的相对值，只在生成那一刻有意义；
// 未来重读这份文档时，真正要回答的是「这件事发生在哪个时间点」，
// 绝对日期已经答完了，相对值反而要读者先想起生成时间再心算一遍。
function fmtDate(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (!input || isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 视频时长 秒 → 2:40 / 1:23:45
function fmtDuration(sec) {
  const s = Number(sec) || 0;
  if (s <= 0) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

function buildMarkdown(meta, overall, topics, pairs, zhSource) {
  const url = meta.videoId ? `https://www.youtube.com/watch?v=${meta.videoId}` : '';
  const at = (ms) => (url ? `${url}&t=${Math.floor(ms / 1000)}s` : '');
  const L = [];

  L.push(`# ${meta.title || 'YouTube 视频'}`, '');
  const facts = [];
  if (meta.author) facts.push(`**频道：** ${meta.author}`);
  if (url) facts.push(`**链接：** ${url}`);
  const pub = fmtDate(meta.publishDate);
  if (pub) facts.push(`**发布时间：** ${pub}`);
  const dur = fmtDuration(meta.lengthSeconds);
  if (dur) facts.push(`**视频时长：** ${dur}`);
  if (meta.language) {
    // 原声即中文时说明一下没翻译，否则读者会以为「中文」那栏是漏掉了
    const why = zhSource ? '，原声即中文，未做翻译' : '';
    facts.push(
      `**字幕：** ${meta.language}${meta.isAuto ? '（自动生成' : '（人工上传'}${why}）`
    );
  }
  if (meta.chars) facts.push(`**字幕长度：** ${meta.chars} 字符 / ${pairs.length} 段`);
  facts.push(`**提炼时间：** ${fmtDate(new Date())}`);
  L.push(facts.join('  \n'), '', '---', '');

  // ── 一、视频简介 ──
  L.push('## 一、视频简介', '');
  L.push((overall || '_（生成失败）_').trim(), '', '---', '');

  // ── 二、主题拆解 ──
  L.push('## 二、主题拆解', '');
  if (!topics.length) {
    L.push('_（未能拆解出主题）_', '');
  } else {
    topics.forEach((t, i) => {
      const a = pairs[(t.from || 1) - 1];
      const b = pairs[(t.to || t.from || 1) - 1];
      let stamp = '';
      if (a) {
        const s = fmtTime(a.start);
        const e = b && b !== a ? ` – ${fmtTime(b.start)}` : '';
        stamp = at(a.start) ? ` [${s}${e}](${at(a.start)})` : ` ${s}${e}`;
      }
      L.push(`### ${i + 1}. ${t.title}${stamp}`, '');
      if (t.failed && !t.summary && !t.points.length && !t.logic) {
        const tail = zhSource ? '全文' : '双语全文';
        L.push(`_（本主题分析失败：${t.failed}。${tail}不受影响，可直接往下读。）_`, '');
      } else {
        // t.logic 只会出现在旧格式的续传数据里（现在的 prompt 不再产出它）。
        // 不单独起一块，直接接在叙述后面 —— 它本来就是同一段话的展开。
        const narrative = [t.summary, t.logic].filter(Boolean).join('\n\n');
        if (narrative) L.push('**讲了什么**', '', narrative, '');
        if (t.points.length) {
          L.push('**要点**', '');
          t.points.forEach((p) => L.push(`- ${p}`));
          L.push('');
        }
      }
    });
  }
  L.push('---', '');

  // ── 三、全文 ──
  // 原声就是中文时没有译文可对照，两栏会一模一样，所以退化成单栏。
  L.push(zhSource ? '## 三、全文' : '## 三、双语全文', '');
  for (const p of pairs) {
    const ts = fmtTime(p.start);
    L.push(at(p.start) ? `#### [${ts}](${at(p.start)})` : `#### ${ts}`, '');
    if (zhSource) {
      L.push(p.original, '');
    } else {
      L.push('**原文：**', '', p.original, '');
      L.push('**中文：**', '', p.zh || '_（本段翻译缺失）_', '');
    }
  }

  return L.join('\n');
}

// ---------------------------------------------------------------- 并发池

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------- 字幕提取

// ⚠️ 这是整个流程里【唯一】需要 YouTube 标签页存在的一步。
// 一旦字幕提取完成，后面的翻译/分析/提炼全是后台直接调 API，
// 用户把标签页关掉、甚至跳去别的视频都不影响。
async function extractSubtitles(tabId, preferredLang) {
  // 两步注入：先加载脚本定义好函数，再调用它。
  // executeScript 对 func 返回的 Promise 会可靠地等待，对 files 则不一定。
  const inject = async (opts) => {
    try {
      return await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', ...opts });
    } catch (e) {
      const m = String(e?.message || e);
      // 标签页被关掉/跳走时 Chrome 抛的是 "No tab with id"，对用户毫无意义，翻译一下
      if (/No tab with id|no tab|frame was removed|Cannot access/i.test(m)) {
        throw new Error(
          '提取字幕时 YouTube 标签页被关掉了。\n' +
            '提取字幕这一步需要页面还开着（通常只要几秒）；' +
            '等状态变成「翻译中」之后，标签页就可以随便关了。请重新打开视频再试一次。'
        );
      }
      throw e;
    }
  };

  await inject({ files: ['track-utils.js', 'caption-utils.js', 'page-extractor.js'] });

  const res = await inject({
    func: (lang) => window.__ytSpeedRead.run({ preferredLang: lang }),
    args: [preferredLang || 'auto'],
  });

  const out = res?.[0]?.result;
  if (!out) throw new Error('字幕提取脚本没有返回结果，请刷新 YouTube 页面后重试。');
  if (!out.ok) throw new Error(out.error || '字幕提取失败');
  return out;
}

// ---------------------------------------------------------------- 主流程

let inFlight = false; // 防止闹钟和用户同时触发同一个任务

async function processJob(tabId, { resume = false } = {}) {
  if (inFlight) return;
  inFlight = true;
  startKeepAlive();
  armResumeAlarm();

  try {
    const cfg = await getConfig();
    if (!cfg.apiBaseUrl || !cfg.apiKey) {
      throw new Error('还没配置 AI 接口。右键插件图标 → 选项，填好 Base URL 和 API Key。');
    }

    let data = resume ? await getData() : null;

    // ---- 1. 提取字幕（断点续传时跳过）----
    if (!data?.paragraphs?.length) {
      await setJob({ status: 'extracting', message: '正在提取字幕…', current: 0, total: 0 });
      const sub = await extractSubtitles(tabId, cfg.preferredLang);

      const chunks = chunkIndexes(sub.paragraphs, Number(cfg.chunkChars) || 2400);
      data = await setData({
        tabId,
        meta: {
          title: sub.title, author: sub.author, videoId: sub.videoId,
          language: sub.language, isAuto: sub.isAuto, chars: sub.chars,
          lengthSeconds: sub.lengthSeconds || 0,
          publishDate: sub.publishDate || '',
          description: sub.description || '',
        },
        paragraphs: sub.paragraphs,
        chunks,
        translations: new Array(chunks.length).fill(null),
        outline: null,
        topicDetails: null,
        overall: null,
      });

      await setJob({
        title: sub.title, videoId: sub.videoId, author: sub.author,
        language: sub.language, isAuto: sub.isAuto, chars: sub.chars,
      });
    }

    const { meta, paragraphs, chunks } = data;

    // 字幕本身就是中文 —— 整个翻译阶段没有意义，直接跳过。
    // 下游全都写成 `p.zh || p.original`，zh 留空会自动回落到原文，
    // 所以这里什么都不用填，主题拆解和视频简介照常工作。
    const zhSource = isChineseSource(meta, paragraphs);
    if (zhSource) {
      await setJob({ message: '字幕本身就是中文，跳过翻译…', current: 0, total: 0 });
    }

    // ---- 2. 分块翻译（每块完成即落盘）----
    const pending = zhSource
      ? []
      : chunks.map((_, i) => i).filter((i) => !Array.isArray(data.translations[i]));

    if (pending.length) {
      const doneAlready = chunks.length - pending.length;
      await setJob({
        status: 'translating',
        message: doneAlready
          ? `继续翻译…（已完成 ${doneAlready}/${chunks.length} 块）`
          : `字幕 ${meta.chars} 字符，分 ${chunks.length} 块翻译…`,
        current: doneAlready,
        total: chunks.length,
      });

      let done = doneAlready;
      const SYS = '你是资深的影视字幕译者，中文表达自然、准确，不添油加醋。';

      const askOnce = async (texts, strict) => {
        const { content } = await callChat(
          cfg,
          [
            { role: 'system', content: SYS },
            { role: 'user', content: buildTranslatePrompt(texts, strict) },
          ],
          { maxTokens: cfg.maxTokens }
        );
        return parseTranslation(content, texts.length);
      };

      await runPool(pending, Number(cfg.concurrency) || 3, async (ci) => {
        const texts = chunks[ci].map((pi) => paragraphs[pi].text);
        let r = await askOnce(texts, false);

        // 模型完全没按编号格式输出时，带着更强的提醒再要一次。
        // 只在彻底解析不出来时重试，部分成功就不浪费额度了。
        if (r.method === 'dump' && texts.length > 1) {
          try {
            const retry = await askOnce(texts, true);
            if (retry.filled > r.filled) r = retry;
          } catch (e) {
            /* 重试失败就用第一次的结果 */
          }
        }

        // 落盘必须在串行写队列里读取最新数组；在 worker 外先 get 再 set 会丢更新。
        await updateData((fresh) => {
          const translations = Array.isArray(fresh.translations)
            ? fresh.translations.slice()
            : new Array(chunks.length).fill(null);
          translations[ci] = r.parts;
          return { ...fresh, translations };
        });

        done += 1;
        await setJob({
          current: done,
          message:
            `翻译中… ${done}/${chunks.length} 块` +
            (r.filled < r.expected ? `（本块 ${r.filled}/${r.expected} 段对齐）` : ''),
        });
      });

      data = await getData();
    }

    if (!zhSource) {
      const missing = chunks
        .map((_, i) => i)
        .filter((i) => !Array.isArray(data?.translations?.[i]));
      if (missing.length) {
        throw new Error(
          `翻译检查点不完整（缺少第 ${missing.map((i) => i + 1).join('、')} 块），请重试。`
        );
      }
    }

    // 把译文摊平成「原文 / 译文」配对
    const pairs = paragraphs.map((p) => ({ start: p.start, original: p.text, zh: '' }));
    chunks.forEach((idxs, ci) => {
      const parts = data.translations[ci] || [];
      idxs.forEach((pi, k) => {
        pairs[pi].zh = parts[k] || '';
      });
    });

    // ---- 3. 主题拆解：先全局划边界，再逐个写细节 ----
    const zhItems = pairs
      .map((p, i) => ({ no: i + 1, text: p.zh || p.original }))
      .filter((it) => it.text.trim());

    const want = targetTopicCount(meta.lengthSeconds || 0, meta.chars || 0);

    // 3a. 第一趟：把全片骨架一次性给模型，让它站在全局视角划分话题
    if (!Array.isArray(data.outline)) {
      await setJob({
        status: 'analyzing',
        message: `正在通读全片、划分主题（目标 ${want} 个）…`,
        current: 0,
        total: 0,
      });

      let outline = [];
      try {
        const { content } = await callChat(
          cfg,
          [
            { role: 'system', content: '你是擅长梳理长篇内容结构的编辑，善于找出内容的自然转折点。' },
            {
              role: 'user',
              content: buildOutlinePrompt(
                buildSkeleton(zhItems),
                pairs.length,
                want,
                meta.title
              ),
            },
          ],
          { maxTokens: 3000 }
        );
        outline = parseOutline(content);
      } catch (e) {
        outline = [];
      }

      await setData({ outline: normalizeOutline(outline, pairs.length, want) });
      data = await getData();
    }

    const outline = data.outline;

    // 3b. 第二趟：每个话题拿它覆盖的真实全文，分别写讲了什么/要点（可断点续传）
    if (!Array.isArray(data.topicDetails)) {
      await setData({ topicDetails: new Array(outline.length).fill(null) });
      data = await getData();
    }

    const dPending = outline.map((_, i) => i).filter((i) => !data.topicDetails[i]);

    if (dPending.length) {
      let ddone = outline.length - dPending.length;
      await setJob({
        status: 'analyzing',
        message: `正在分析主题… ${ddone}/${outline.length}`,
        current: ddone,
        total: outline.length,
      });

      const cap = Number(cfg.analysisChars) || 14000;

      await runPool(dPending, Math.min(2, Number(cfg.concurrency) || 2), async (ti) => {
        const t = outline[ti];
        let body = pairs
          .slice(t.from - 1, t.to)
          .map((p, k) => `[${t.from + k}] ${p.zh || p.original}`)
          .join('\n\n');

        // 话题太长时掐头留尾，保住开头的铺垫和结尾的结论
        if (body.length > cap) {
          const head = Math.floor(cap * 0.6);
          body = body.slice(0, head) + '\n\n……（中间略）……\n\n' + body.slice(-(cap - head));
        }

        let detail = { summary: '', points: [], logic: '' };
        try {
          const { content } = await callChat(
            cfg,
            [
              { role: 'system', content: '你是擅长拆解论证逻辑的分析师。' },
              { role: 'user', content: buildDetailPrompt(t, body, meta.title) },
            ],
            { maxTokens: Math.max(2000, Math.min(4000, Number(cfg.maxTokens) || 4000)) }
          );
          detail = parseDetail(content);
          if (!detail.summary && !detail.points.length && !detail.logic) {
            detail.failed = '模型没有按格式返回分析内容';
          }
        } catch (e) {
          // 单个话题分析失败不该拖垮整个任务，但也绝不能悄悄留白 ——
          // 把失败原因记下来，最后在正文里明确标出来。
          detail = { summary: '', points: [], logic: '', failed: e.message || String(e) };
        }

        await updateData((fresh) => {
          const topicDetails = Array.isArray(fresh.topicDetails)
            ? fresh.topicDetails.slice()
            : new Array(outline.length).fill(null);
          topicDetails[ti] = detail;
          return { ...fresh, topicDetails };
        });

        ddone += 1;
        await setJob({ current: ddone, message: `正在分析主题… ${ddone}/${outline.length}` });
      });

      data = await getData();
    }

    const missingDetails = outline
      .map((_, i) => i)
      .filter((i) => !data?.topicDetails?.[i]);
    if (missingDetails.length) {
      throw new Error(
        `主题检查点不完整（缺少第 ${missingDetails.map((i) => i + 1).join('、')} 个主题），请重试。`
      );
    }

    const topics = outline.map((o, i) => ({
      ...o,
      ...(data.topicDetails[i] || { summary: '', points: [], logic: '' }),
    }));

    // ---- 4. 视频简介 ----
    let overall = data.overall;
    if (!overall) {
      await setJob({ status: 'summarizing', message: '正在提炼全片内容…' });
      try {
        // 人物身份的线索基本只出现在两个地方：YouTube 页面的简介栏，
        // 和开场的自我介绍/主持人引荐。所以「原始材料」就取这两块，
        // 不给模型任何别的发挥空间。
        //
        // 注意这里标签叫「YouTube 页面简介」而不是「视频简介」：后者现在是
        // 我们要模型**写出来**的那一节的名字，两个东西同名会让它分不清
        // 「是让我读这块，还是让我写这块」。
        const opening = pairs
          .slice(0, 12)
          .map((p) => p.zh || p.original)
          .join('\n')
          .slice(0, 2500);
        const evidence =
          (meta.description ? `【YouTube 页面简介】\n${meta.description}\n\n` : '') +
          `【开场内容】\n${opening}`;

        const { content } = await callChat(
          cfg,
          [
            {
              role: 'system',
              content:
                '你是擅长抓住重点的内容编辑。你有一条铁律：只根据用户给你的材料作答，' +
                '绝不补充材料之外的任何事实，尤其是人物身份。',
            },
            { role: 'user', content: buildOverallPrompt(topics, meta, evidence) },
          ],
          { maxTokens: 2500 }
        );
        overall = stripSectionMarkers(content);
      } catch (e) {
        overall = `_（提炼失败：${e.message}）_`;
      }
      await setData({ overall });
    }

    // ---- 5. 组装并开结果页 ----
    const markdown = buildMarkdown(meta, overall, topics, pairs, zhSource);

    const failedTopics = topics.filter((t) => t.failed).length;
    await setJob({
      status: 'done',
      message: failedTopics ? `完成（${failedTopics} 个主题分析失败）` : '完成',
      markdown,
      topicCount: topics.length,
      failedTopics,
      finishedAt: Date.now(),
    });

    stopKeepAlive();
    disarmResumeAlarm();
    await dataStore.remove();
    await chrome.tabs.create({ url: chrome.runtime.getURL('result.html'), active: true });
  } finally {
    inFlight = false;
  }
}

async function startOrResume(tabId, resume) {
  try {
    await processJob(tabId, { resume });
  } catch (err) {
    stopKeepAlive();
    disarmResumeAlarm();
    await setJob({ status: 'error', error: err?.message || String(err) });
  }
}

// ---------------------------------------------------------------- 断点续传

// Service Worker 被回收后，闹钟会把它叫醒。发现任务「在跑但很久没动静」，
// 就说明上一次是被中途掐死的，从断点接着跑。
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== RESUME_ALARM) return;
  if (inFlight) return;

  const job = await getJob();
  if (!job || !RUNNING.includes(job.status)) {
    disarmResumeAlarm();
    return;
  }
  if (Date.now() - (job.updatedAt || 0) < STALE_MS) return;

  const data = await getData();
  if (!data?.paragraphs?.length) {
    // 连字幕都没提取完就被打断了，没法续，只能报错让用户重来
    await setJob({ status: 'error', error: '任务被浏览器中断，且还没提取到字幕。请重试。' });
    disarmResumeAlarm();
    return;
  }

  await setJob({ message: '任务曾被中断，正在从断点继续…' });
  startOrResume(data.tabId, true);
});

// ---------------------------------------------------------------- 消息

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  (async () => {
    try {
      if (req.action === 'startJob' || req.action === 'resumeJob') {
        const running = await getJob();
        const isResume = req.action === 'resumeJob';

        if (!isResume && running && RUNNING.includes(running.status) &&
            Date.now() - (running.updatedAt || 0) < STALE_MS) {
          sendResponse({ ok: false, error: '已有任务在跑，请等它结束。' });
          return;
        }

        if (!isResume) {
          await dataStore.remove();
          await jobStore.update(() => ({
            status: 'extracting',
            message: '启动中…',
            startedAt: Date.now(),
            updatedAt: Date.now(),
          }));
        }
        sendResponse({ ok: true });

        // 不 await：popup 立刻拿到响应，任务在后台继续
        startOrResume(req.tabId, isResume);
        return;
      }

      if (req.action === 'getJob') {
        const job = await getJob();
        const data = await getData();
        sendResponse({
          ok: true,
          job,
          // 让 popup 知道「有没有可以续的进度」
          resumable: !!(data?.paragraphs?.length),
          stale: !!(job && RUNNING.includes(job.status) &&
                    Date.now() - (job.updatedAt || 0) > STALE_MS),
        });
        return;
      }

      if (req.action === 'clearJob') {
        await Promise.all([jobStore.remove(), dataStore.remove()]);
        disarmResumeAlarm();
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: '未知 action: ' + req.action });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();

  return true; // 异步响应
});
