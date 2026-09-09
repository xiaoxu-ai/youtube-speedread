# extension/ — 插件源码

浏览器里「加载已解压的扩展程序」时选**这个目录**。

完整使用说明见上一级的 `使用说明.md`；项目概览、限制和隐私说明见根目录 README、
KNOWN-ISSUES 与 PRIVACY 文档。

---

## 文件职责

| 文件 | 干什么 | 跑在哪 |
|---|---|---|
| `manifest.json` | MV3 配置、权限声明 | — |
| `storage-queue.js` | 为 `job` / `jobData` 串行执行同 key 的读改写 | Service Worker |
| `track-utils.js` | 从实际 timedtext URL 推导字幕语言与人工/自动类型 | MAIN world / Node 测试 |
| `caption-utils.js` | 清洗 json3 cue，并按开始/结束时间恢复字幕事件顺序 | MAIN world / Node 测试 |
| `page-extractor.js` | 抓字幕：钩 fetch/XHR，诱导播放器请求，截获带 pot 的 URL | YouTube 页面 **MAIN world** |
| `background.js` | 编排全流程：注入提取器 → 分块翻译 → 概要 → 拼 Markdown → 开结果页 | Service Worker |
| `popup.html/.js` | 发起任务、显示进度；兼容 Chromium/macOS 非 100% 来源缩放。**关掉不影响任务** | 弹窗 |
| `options.html/.js` | 接口配置、跨域权限申请、连接测试 | 扩展页 |
| `result.html/.js` | 结果阅读、复制、下载 | 扩展页 |
| `icons/` | 图标（三套方案 + 构建脚本） | — |

---

## 数据流

```
popup ──startJob(tabId)──▶ background
                             │
                             ├─ scripting.executeScript(files, MAIN)   注入提取器
                             ├─ scripting.executeScript(func, MAIN)    调用并等待 Promise
                             │     └─▶ page-extractor 返回 { paragraphs[], title, ... }
                             │
                             ├─ 切块 → 并发调 AI（按段落编号恢复对齐）
                             ├─ 全局划主题 → 逐主题分析 → 生成视频简介
                             ├─ 本地拼装双语 Markdown
                             │
                             ├─ storage.session.job ◀── popup 靠 onChanged 实时显示进度
                             └─ tabs.create(result.html)
```

---

## 改代码时注意

**提取器为什么要分两步注入。**
`executeScript({files})` 对返回 Promise 的脚本，等待行为不如 `{func}` 可靠。
所以第一步用 `files` 把 `window.__ytSpeedRead` 定义好，第二步用 `func` 调用它并等结果。

**钩子里保存的 `origFetch` 必须绑回 window。**
`state.origFetch(url)` 会报 `Illegal invocation`，要写 `state.origFetch.call(window, url)`。

**`chrome.permissions.request` 必须在用户手势里同步发起。**
`options.js` 里是**先申请权限、再 `storage.set`**。顺序反过来的话，`await` 可能让手势过期，
权限弹窗就出不来了 —— 这正是 v1 的一个 bug。

**结果页一律用 DOM API 渲染，不要用 `innerHTML`。**
正文来自大模型 + 视频字幕，属于不可信内容。`result.js` 的 `inline()` 用
`createTextNode` / `textContent` 构建，已通过 `<img onerror>` / `<script>` / `<iframe>` 注入测试。

**`page-extractor.js` 会短暂播放视频。**
拿 pot 必须让播放器跑起来。`acquirePotUrl()` 前会存档播放状态，`restorePlayer()` 负责恢复，
成功和失败路径都要调用它。

**先规范化 json3 事件，再合并段落。**
YouTube 的人工字幕响应不保证 `events` 已按时间排列。`caption-utils.js` 会清洗文本和数字字段，
再按开始时间、结束时间排序；不要在 `page-extractor.js` 里直接消费原始数组，否则可能出现全文时间倒退。

**AI 可以并发，检查点读改写必须排队。**
`storage-queue.js` 让同一个 key 的 mutator 总是在最新值上执行，翻译和主题 worker 只替换
自己的槽位；阶段结束还会检查整块结果是否齐全。完整退出浏览器、扩展重载或更新后，
session 检查点不保证仍存在。

**popup 正文宽度要跟随实际视口。**
Chromium 151/macOS 在扩展来源缩放不为 100% 时，可能把 popup 外框算得比固定正文更宽。
保留 `html` 的 330px 最小宽度，同时让 `body` 使用 `width: 100%`；不要改回只给 body 固定 330px，
否则 140% 下右侧空白会复现。

---

## 本地调试

```bash
# 语法检查
for f in *.js; do node --check "$f"; done

# 从项目根目录运行固定测试
(cd .. && npm test)

# 重新生成图标（需要 brew install librsvg）
(cd icons && ./build.sh)        # 或 ./build.sh B 切换方案
```

改完代码去扩展管理页点插件的**刷新**按钮。
改了 `page-extractor.js` 还要**刷新 YouTube 页面**，因为旧版本已经注入过了。
