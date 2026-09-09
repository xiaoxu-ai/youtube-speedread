// caption-utils.js —— YouTube json3 字幕事件的纯函数规范化。

(function initCaptionUtils(root) {
  function json3ToSegments(json) {
    const out = [];
    for (const ev of json?.events || []) {
      if (!ev?.segs) continue;
      const text = ev.segs
        .map((s) => s?.utf8 || '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text) continue;

      const start = Number(ev.tStartMs) || 0;
      const duration = Math.max(0, Number(ev.dDurationMs) || 0);
      out.push({ start, end: start + duration, text });
    }

    // YouTube 的人工字幕 json3 不保证 events 按时间排列。
    // 已见真实响应先给出 16:11 的两条事件，再回到 00:00；若直接拼段，
    // 会生成 16:11 → 01:01 的倒序全文和反向主题时间范围。
    return out.sort((a, b) => a.start - b.start || a.end - b.end);
  }

  const api = { json3ToSegments };
  root.YTSRCaptionUtils = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
