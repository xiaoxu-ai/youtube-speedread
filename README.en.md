# YT SpeedRead

> Turn a YouTube video into an article you can actually read.

YT SpeedRead is a Chromium Manifest V3 extension that reads available captions from the
current YouTube video, translates non-Chinese captions into Chinese, creates an overview and
topic breakdown, and exports timestamped Markdown.

Current source version: **v3.7.2**. The project has no backend: AI requests go directly to
the OpenAI-compatible endpoint configured by the user.

## Features

- Selects a suitable caption track from a standard YouTube watch page.
- Translates non-Chinese captions paragraph by paragraph; skips redundant translation for
  Chinese-source captions.
- Produces an overview, topic breakdown, and full transcript.
- Copies or downloads Markdown.
- Saves per-chunk checkpoints and makes a best-effort same-session resume.
- Works in Chromium browsers such as Chrome, Brave, and Edge.

## Install

1. Download or clone this repository.
2. Open the extension manager in Chrome, Brave, or Edge.
3. Enable Developer mode and choose **Load unpacked**.
4. Select this repository's `extension/` directory.
5. Open the extension's Options page and configure an API Base URL, API key, and model.
   Allow the requested origin permission for that API.

Open a captioned standard YouTube watch page and choose **开始速读**. The popup can be
closed after the job starts. Full browser restart, extension reload, update, or disable does
not guarantee checkpoint recovery.

## Development

There are no runtime npm dependencies. Run the built-in Node test suite with:

```bash
npm test
```

The browser loads `extension/`. After changing `page-extractor.js`, reload the extension and
refresh the YouTube page.

## Data and limitations

- Video title, description, captions, and prompts are sent to the AI provider configured by
  the user. This project has no telemetry or project-operated server.
- API keys are stored in browser `chrome.storage.sync` and may sync with the browser account.
- Videos with no usable captions are not supported.
- Caption extraction depends on YouTube page behavior and can break when YouTube changes it.

Read [KNOWN-ISSUES.md](KNOWN-ISSUES.md) and [PRIVACY.md](PRIVACY.md) before relying on it.

## License

[MIT](LICENSE)
