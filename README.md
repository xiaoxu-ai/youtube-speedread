# YT SpeedRead｜油管速读

> 不用看完，读完就够了。

YT SpeedRead 是一个 Chromium Manifest V3 扩展：读取当前 YouTube 视频的可用字幕，
将非中文内容翻译为中文，生成视频简介与主题拆解，并导出可回看时间戳的 Markdown。

当前源码版本：**v3.7.2**。项目没有自建后端；AI 请求直接发送给用户在设置页配置的
OpenAI 兼容 API。

## 功能

- 读取标准 YouTube `/watch` 页的字幕轨道，并优先选择合适的原声/人工字幕；
- 非中文字幕按段落翻译为中文，中文源字幕跳过重复翻译；
- 生成“视频简介 → 主题拆解 → 全文”的阅读稿；
- 复制或下载 Markdown；
- 分块检查点与同会话内的尽力恢复；
- 支持 Chrome、Brave、Edge 等 Chromium 浏览器。

## 安装

1. 下载或克隆本仓库。
2. 打开 `chrome://extensions/`、`brave://extensions/` 或 Edge 的扩展管理页。
3. 开启“开发者模式”，选择“加载已解压的扩展程序”。
4. 选择仓库中的 `extension/` 文件夹。
5. 右键扩展图标打开“选项”，填写 API Base URL、API Key 和模型，保存后允许对应 API 域名权限。

然后打开带字幕的 YouTube 标准视频页，点击“开始速读”。字幕提取结束后可关闭 popup；
完整退出浏览器、扩展重载或更新后不保证可从检查点恢复。

## 开发与测试

项目没有运行时 npm 依赖。使用 Node 的内置测试运行器：

```bash
npm test
```

浏览器加载的是 `extension/`。修改 `page-extractor.js` 后，请重新加载扩展并刷新 YouTube 页面。

## 数据与限制

- 视频标题、描述、字幕和提示会发送给你配置的 AI 服务商；本项目没有遥测或自建服务器。
- API Key 存于浏览器的 `chrome.storage.sync`，可能随浏览器账户同步。
- 没有可用字幕的视频目前无法处理。
- 字幕提取依赖 YouTube 页面行为，可能随页面更新失效；使用前请阅读[已知限制](KNOWN-ISSUES.md)。

更完整的数据流和存储说明见 [隐私说明](PRIVACY.md)。

## 许可证

[MIT](LICENSE)
