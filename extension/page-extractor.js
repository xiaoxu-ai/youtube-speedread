// page-extractor.js —— 在 YouTube 页面 MAIN world 运行
//
// 为什么不能直接用 ytInitialPlayerResponse 里的 captionTracks[].baseUrl？
// 因为 YouTube 现在给 /api/timedtext 加了 PoT（Proof-of-Origin Token）校验：
// baseUrl 里不含 pot 参数，直接请求会返回 "HTTP 200 + 空 body"，静默失败。
//
// 这里的做法是：钩住 fetch / XHR，诱导播放器自己去请求字幕
// （播放中把 CC 从关切到开），截获它那条带 pot 的 URL，再复用它拉 json3。
// 换语言轨道靠替换 URL 上的 lang / kind 参数（这两个不在 sparams 签名里，可以改）。

(() => {
  const NS = '__ytSpeedRead';
  if (window[NS] && window[NS].installed) return;
  const trackFromTimedTextUrl = globalThis.YTSRTrackUtils?.trackFromTimedTextUrl;
  const json3ToSegments = globalThis.YTSRCaptionUtils?.json3ToSegments;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const state = {
    installed: true,
    seen: [],          // 截获到的 timedtext URL
    origFetch: window.fetch,
  };

  // ---------- 1. 安装拦截钩子（越早越好，重复注入也只装一次） ----------
  function install() {
    const record = (u) => {
      try {
        const s = String(u);
        if (s.includes('/api/timedtext')) state.seen.push(s);
      } catch (e) {}
    };

    const origFetch = window.fetch;
    state.origFetch = origFetch;
    window.fetch = function (...args) {
      try {
        record(typeof args[0] === 'string' ? args[0] : args[0]?.url);
      } catch (e) {}
      return origFetch.apply(this, args);
    };

    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      try {
        record(url);
      } catch (e) {}
      return origOpen.call(this, method, url, ...rest);
    };
  }
  install();

  // ---------- 2. 工具 ----------
  // 钩子装上后一直在收集，站内跳转不会清空，所以 state.seen 里可能混着
  // 上一个视频的字幕 URL。必须按当前 videoId 过滤，否则又会串台。
  function seenForCurrent() {
    const here = urlVideoId();
    return state.seen.filter((u) => {
      if (!here) return true;
      try {
        return new URL(u, location.origin).searchParams.get('v') === here;
      } catch (e) {
        return false;
      }
    });
  }
  const potUrl = () => seenForCurrent().find((u) => u.includes('pot='));
  const anyUrl = () => seenForCurrent().pop();

  function urlVideoId() {
    try {
      return new URL(location.href).searchParams.get('v') || '';
    } catch (e) {
      return '';
    }
  }

  // ⚠️ window.ytInitialPlayerResponse 在 YouTube 站内跳转（SPA 导航）时【不会更新】，
  // 它永远停留在这个标签页最早加载的那个视频上。直接用它会拿到上一个视频的
  // 标题、频道和字幕轨道 —— 这是一个非常隐蔽的串台 bug。
  // 播放器实例上的 getPlayerResponse() / getVideoData() 才是当前视频的实时数据。
  // 返回所有「videoId 和地址栏一致」的候选数据源，按可信度排序。
  // 播放器实时数据最准，但它在页面刚加载时可能还没填好；
  // 全局变量立刻就有，但站内跳转后会过期 —— 所以两个都留着，各取所长。
  function candidateResponses() {
    const here = urlVideoId();
    const matches = (r) =>
      r?.videoDetails?.videoId && (!here || r.videoDetails.videoId === here);

    const out = [];
    try {
      const pr = document.getElementById('movie_player')?.getPlayerResponse?.();
      if (matches(pr)) out.push(pr);
    } catch (e) {}
    if (matches(window.ytInitialPlayerResponse)) out.push(window.ytInitialPlayerResponse);
    return out;
  }

  function livePlayerResponse() {
    return candidateResponses()[0] || null;
  }

  // 返回整个 playerCaptionsTracklistRenderer，而不只是 captionTracks 数组。
  // 因为「哪条是默认字幕」写在同级的 audioTracks 里，只拿数组就丢了这个信息。
  function declaredTracklist() {
    // 谁身上有字幕就用谁的：播放器可能还没加载完 captions，
    // 而此时全局变量里往往已经有了（前提是 videoId 对得上）。
    for (const r of candidateResponses()) {
      const tl = r?.captions?.playerCaptionsTracklistRenderer;
      if (Array.isArray(tl?.captionTracks) && tl.captionTracks.length) return tl;
    }
    return null;
  }

  // 页面刚打开时播放器还在初始化，字幕信息要过几秒才填进来。
  // 不等一下就直接报「没有字幕」是错的 —— 这里轮询到出现为止。
  async function waitForTracklist(maxWait = 10000) {
    const start = Date.now();
    let tl = declaredTracklist();
    while (!tl && Date.now() - start < maxWait) {
      await sleep(300);
      tl = declaredTracklist();
    }
    return tl;
  }

  function videoMeta() {
    const player = document.getElementById('movie_player');
    const here = urlVideoId();

    let vd = null;
    try {
      vd = player?.getVideoData?.();
    } catch (e) {}

    // getVideoData 也要核对，避免播放器还没切过来
    const liveOk = vd?.video_id && (!here || vd.video_id === here);
    const pr = livePlayerResponse();

    const videoId = (liveOk && vd.video_id) || pr?.videoDetails?.videoId || here || '';
    const title =
      (liveOk && vd.title) ||
      pr?.videoDetails?.title ||
      (document.title || '').replace(/\s*-\s*YouTube\s*$/, '').trim() ||
      'YouTube 视频';
    const author = (liveOk && vd.author) || pr?.videoDetails?.author || '';

    let lengthSeconds = Number(pr?.videoDetails?.lengthSeconds || 0);
    try {
      lengthSeconds = Math.round(player?.getDuration?.()) || lengthSeconds;
    } catch (e) {}

    // 视频简介：判断嘉宾身份的重要依据（很多访谈会在简介里写清楚来宾头衔）。
    // 简介可能很长且末尾全是推广链接和时间轴，只取前面一段就够了。
    let description = String(pr?.videoDetails?.shortDescription || '');
    description = description
      .split('\n')
      .filter((l) => !/^\s*\d{1,2}:\d{2}(:\d{2})?\s/.test(l))   // 去掉时间轴行
      .join('\n')
      .replace(/https?:\/\/\S+/g, '')                            // 去掉链接
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 1200);

    // 发布时间：表明这份内容的时效性。财经、科技类视频尤其重要 ——
    // 2023 年的判断和今天的判断可能完全相反。
    // microformat 和 videoDetails 在同一个 playerResponse 里，videoId 已经校验过了。
    let publishDate = '';
    for (const r of candidateResponses()) {
      const mf = r?.microformat?.playerMicroformatRenderer;
      const d = mf?.publishDate || mf?.uploadDate;
      if (d) { publishDate = String(d); break; }
    }

    return { videoId, title, author, lengthSeconds, description, publishDate, staleGuardId: here };
  }

  // ---------- 3. 诱导播放器请求字幕，拿到带 pot 的 URL ----------
  async function acquirePotUrl(onProgress) {
    if (potUrl()) return potUrl();

    const player = document.getElementById('movie_player');
    if (!player || typeof player.getPlayerState !== 'function') {
      throw new Error('找不到 YouTube 播放器，请确认这是视频播放页并等页面加载完。');
    }

    const btn = document.querySelector('.ytp-subtitles-button');
    if (!btn) {
      throw new Error('播放器上找不到字幕(CC)按钮，该视频可能没有字幕。');
    }

    // 存档：结束后原样恢复
    const saved = {
      time: player.getCurrentTime(),
      state: player.getPlayerState(),
      muted: player.isMuted(),
      volume: typeof player.getVolume === 'function' ? player.getVolume() : null,
      ccOn: btn.getAttribute('aria-pressed') === 'true',
    };
    state.saved = saved;

    // pot 只有在播放器真正跑起来之后才就绪，所以先静音播放
    try {
      player.mute();
      player.playVideo();
    } catch (e) {}

    for (let round = 0; round < 6; round++) {
      onProgress?.(`正在唤起字幕轨道…(${round + 1}/6)`);

      // 必须让 CC 经历一次「关 → 开」，播放器才会重新去请求 timedtext
      try {
        if (btn.getAttribute('aria-pressed') === 'true') {
          btn.click();
          await sleep(400);
        }
        btn.click();
      } catch (e) {}

      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        if (potUrl()) return potUrl();
        await sleep(150);
      }
    }

    return potUrl() || anyUrl() || null;
  }

  function restorePlayer() {
    const saved = state.saved;
    if (!saved) return;
    try {
      const player = document.getElementById('movie_player');
      const btn = document.querySelector('.ytp-subtitles-button');
      if (btn && (btn.getAttribute('aria-pressed') === 'true') !== saved.ccOn) {
        btn.click();
      }
      if (player) {
        if (saved.state !== 1) player.pauseVideo();
        if (!saved.muted) player.unMute();
        if (saved.volume != null && typeof player.setVolume === 'function') {
          player.setVolume(saved.volume);
        }
        player.seekTo(saved.time, true);
      }
    } catch (e) {}
    state.saved = null;
  }

  // ---------- 4. 拉字幕 ----------
  function buildUrl(capturedUrl, track, fmt) {
    const u = new URL(capturedUrl, location.origin);
    u.searchParams.set('fmt', fmt || 'json3');
    u.searchParams.delete('tlang');
    if (track) {
      u.searchParams.set('lang', track.languageCode);
      if (track.kind === 'asr') u.searchParams.set('kind', 'asr');
      else u.searchParams.delete('kind');
    }
    return u.toString();
  }

  async function fetchJson3(url) {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // 必须绑回 window，否则报 "Illegal invocation"
        const res = await state.origFetch.call(window, url, {
          credentials: 'same-origin',
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`字幕请求失败 HTTP ${res.status}`);
        if (!text || text.trim().length === 0) {
          // 这正是 PoT 缺失时的症状
          throw new Error('EMPTY_BODY');
        }
        return JSON.parse(text);
      } catch (err) {
        lastErr = err;
        if (attempt < 2) await sleep(700);
      }
    }
    throw lastErr || new Error('字幕请求失败');
  }

  // 选哪条字幕轨道 —— 这里栽过一次，教训值得写下来。
  //
  // 原来的自动逻辑只有一句「人工字幕优先于自动字幕，然后取第一条」。
  // 问题是 **YouTube 的 captionTracks 是按语言代码字母序排的，不是按重要性排的**。
  // 大多数视频只有一两条轨道，随便取都对，所以这个错一直没暴露；
  // 碰上传了十几国字幕的频道就翻车：David Pawson 那个视频排第一的是 Arabic，
  // 于是一堂全程说英文的课，被当成阿拉伯语视频翻译了整整 40 分钟。
  //
  // 「视频到底在说哪种语言」有两个可靠信号，按可靠性排：
  //   1. audioTracks[].defaultCaptionTrackIndex —— 播放器自己认定的默认轨道，
  //      也就是用户在 YouTube 上打开 CC 看到的那条。最直接。
  //   2. 自动字幕（kind === 'asr'）的语言 —— ASR 是从音轨听写出来的，
  //      它的 languageCode 必然等于原声语言。据此再回头找同语言的人工轨道
  //      （人工的有标点、更准确，优先用它）。
  function pickTrack(tracks, preferredLang, tracklist) {
    if (!tracks.length) return null;

    // 用户在设置里明确指定了语言：按语言前两位收集所有候选（en 也命中 en-GB），
    // 再打分挑最好的一条。
    //
    // 这两条规则会打架，顺序是故意的：**人工优先压过精确匹配**。
    // 比如用户选「英语 en」，视频有 en(自动) 和 en-GB(人工)：
    // en-GB 的 languageCode 不等于 en，精确匹配只能命中自动字幕 ——
    // 但自动字幕没有标点，分段质量差一截。用户要的显然是最好的那条英文字幕。
    if (preferredLang && preferredLang !== 'auto') {
      const head = preferredLang.toLowerCase().slice(0, 2);
      const matches = tracks.filter((t) =>
        (t.languageCode || '').toLowerCase().startsWith(head)
      );
      if (matches.length) {
        const rank = (t) =>
          (t.kind === 'asr' ? 2 : 0) + (t.languageCode === preferredLang ? 0 : 1);
        return matches.slice().sort((a, b) => rank(a) - rank(b))[0];
      }
      // 这个视频没有用户要的语言 —— 往下走自动逻辑，
      // 而不是硬塞一条无关的外语给他。
    }

    // 信号 1：播放器认定的默认字幕轨道。
    // 配音视频会有多条 audioTracks，用 defaultAudioTrackIndex 指出的那条。
    const at = tracklist?.audioTracks;
    if (Array.isArray(at) && at.length) {
      const ai = Number.isInteger(tracklist.defaultAudioTrackIndex)
        ? tracklist.defaultAudioTrackIndex
        : 0;
      const di = Number.isInteger(at[ai]?.defaultCaptionTrackIndex)
        ? at[ai].defaultCaptionTrackIndex
        : at.find((a) => Number.isInteger(a?.defaultCaptionTrackIndex))
            ?.defaultCaptionTrackIndex;
      if (Number.isInteger(di) && tracks[di]) return tracks[di];
    }

    // 信号 2：自动字幕的语言就是原声语言
    const asr = tracks.find((t) => t.kind === 'asr');
    if (asr) {
      const head = String(asr.languageCode || '').toLowerCase().slice(0, 2);
      const manualSame = tracks.find(
        (t) =>
          t.kind !== 'asr' &&
          String(t.languageCode || '').toLowerCase().startsWith(head)
      );
      return manualSame || asr;
    }

    // 两个信号都没有：退回老规则，人工字幕优先
    const manual = tracks.filter((t) => t.kind !== 'asr');
    return (manual.length ? manual : tracks)[0];
  }

  // ---------- 5. json3 → 段落 ----------
  // 自动字幕没有标点，靠标点断句会把整篇拼成一行。
  // 这里改成：时间间隔 + 长度 + 标点 三者共同决定分段。
  function segmentsToParagraphs(segments, maxChars = 480) {
    const paras = [];
    let buf = null;

    for (const seg of segments) {
      if (!buf) {
        buf = { start: seg.start, end: seg.end, text: seg.text };
        continue;
      }
      const gap = seg.start - buf.end;
      const len = buf.text.length;
      const endsSentence = /[.!?。！？]["')\]]?$/.test(buf.text);

      const shouldBreak =
        len >= maxChars ||
        (endsSentence && len >= 180) ||
        (gap > 1800 && len >= 120);

      if (shouldBreak) {
        paras.push(buf);
        buf = { start: seg.start, end: seg.end, text: seg.text };
      } else {
        buf.text += ' ' + seg.text;
        buf.end = seg.end;
      }
    }
    if (buf) paras.push(buf);
    return paras;
  }

  // ---------- 6. 主流程 ----------
  async function run(opts = {}) {
    const progress = [];
    const onProgress = (m) => progress.push(m);

    try {
      // 先等播放器就绪再读元数据，否则标题/频道也可能还是空的
      onProgress('正在等待播放器加载字幕信息…');
      const tracklist = await waitForTracklist();
      const tracks = tracklist?.captionTracks || [];
      const meta = videoMeta();

      if (!tracks.length) {
        throw new Error(
          '该视频没有字幕轨道（既没有上传字幕，也没有自动字幕）。换一个带 CC 的视频试试。'
        );
      }

      const captured = await acquirePotUrl(onProgress);
      if (!captured) {
        throw new Error(
          '没能截获到播放器的字幕请求。请手动点一下播放器上的 CC 按钮让字幕显示出来，然后重试。'
        );
      }

      const hasPot = captured.includes('pot=');
      const track = pickTrack(tracks, opts.preferredLang, tracklist);
      const capturedTrack = trackFromTimedTextUrl?.(captured, tracks) || null;

      let json = null;
      let usedTrack = track;
      let lastErr = null;

      // 先按选中的轨道取；失败就退回播放器原本请求的那条 URL
      for (const attempt of [
        { url: buildUrl(captured, track, 'json3'), t: track },
        { url: buildUrl(captured, null, 'json3'), t: capturedTrack },
      ]) {
        try {
          json = await fetchJson3(attempt.url);
          // fallback 成功时必须采用播放器实际请求 URL 的轨道，不能继续冒充首选轨道。
          usedTrack = attempt.t;
          break;
        } catch (e) {
          lastErr = e;
        }
      }

      if (!json) {
        if (String(lastErr?.message).includes('EMPTY_BODY')) {
          throw new Error(
            hasPot
              ? '字幕接口返回空内容（已带 pot，可能是该轨道被限制）。请在播放器上手动开启 CC 后重试。'
              : '字幕接口返回空内容：没能拿到有效的 pot 令牌。请先播放视频并手动打开 CC 字幕，然后重试。'
          );
        }
        throw lastErr || new Error('字幕拉取失败');
      }

      if (typeof json3ToSegments !== 'function') {
        throw new Error('字幕规范化模块没有加载，请重新加载扩展并刷新视频页面。');
      }
      const segments = json3ToSegments(json);
      if (!segments.length) throw new Error('字幕内容为空。');

      const paragraphs = segmentsToParagraphs(segments);
      const originalText = paragraphs.map((p) => p.text).join('\n\n');

      restorePlayer();

      return {
        ok: true,
        videoId: meta.videoId,
        title: meta.title,
        author: meta.author,
        lengthSeconds: meta.lengthSeconds,
        publishDate: meta.publishDate,
        description: meta.description,
        language: usedTrack?.languageCode || '',
        isAuto: usedTrack?.kind === 'asr',
        availableLangs: tracks.map((t) => ({
          code: t.languageCode,
          name: t.name?.simpleText || t.name?.runs?.[0]?.text || t.languageCode,
          auto: t.kind === 'asr',
        })),
        usedPot: hasPot,
        segmentCount: segments.length,
        paragraphs: paragraphs.map((p) => ({ start: p.start, text: p.text })),
        originalText,
        chars: originalText.length,
      };
    } catch (err) {
      restorePlayer();
      return { ok: false, error: err?.message || String(err), progress };
    }
  }

  window[NS] = Object.assign(state, { run, install });
})();
