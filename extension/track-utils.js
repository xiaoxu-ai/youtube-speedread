// track-utils.js —— timedtext URL 与字幕轨道元数据之间的纯函数。

(function initTrackUtils(root) {
  function trackFromTimedTextUrl(url, tracks = []) {
    let parsed;
    try {
      parsed = new URL(String(url || ''), 'https://www.youtube.com');
    } catch (e) {
      return null;
    }

    const languageCode = parsed.searchParams.get('lang') || '';
    const kind = parsed.searchParams.get('kind') || '';
    if (!languageCode) return null;

    const list = Array.isArray(tracks) ? tracks : [];
    const sameLanguage = list.filter(
      (track) => String(track?.languageCode || '').toLowerCase() === languageCode.toLowerCase()
    );
    const exact = sameLanguage.find((track) => String(track?.kind || '') === kind);
    if (exact) return exact;

    // URL 已经是实际成功取回正文的来源。即使页面轨道表里找不到完全匹配项，
    // 也应使用 URL 自己的 lang/kind，而不是继续冒充最初请求的另一条轨道。
    return {
      languageCode,
      ...(kind ? { kind } : {}),
    };
  }

  const api = { trackFromTimedTextUrl };
  root.YTSRTrackUtils = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
