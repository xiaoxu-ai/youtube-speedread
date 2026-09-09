# Known issues, limitations and risks

Read this before you rely on this extension for anything that matters.

Last updated: 2026-08-31 · Manifest v3.7.2

---

## 1. The big one: this circumvents a YouTube protection mechanism

YouTube protects its caption endpoint with a **Proof-of-Origin Token (PoT)**. This
extension does not have a legitimate way to obtain that token. Instead it drives the
page's own player into requesting captions, and intercepts the request.

Two consequences you should be clear about:

**It can break at any time, permanently.**
If YouTube changes how the player requests captions — or starts binding the token to
something we can't reuse — subtitle extraction stops working. There is no fallback.
This is not a bug that can be "fixed" in advance; it needs re-engineering each time.

**It may conflict with YouTube's Terms of Service.**
Accessing content by means other than the publicly documented interface is generally
prohibited. Whether personal use is a problem in practice is not something this project
can advise on. **Redistributing this, or charging money for it, is a materially different
situation from using it yourself.** Consider that before publishing a fork or a paid
service built on it.

This project is published as a technical write-up of a problem and one working solution.
It is not a recommendation to use it in violation of anyone's terms.

## 2. Functional limitations

### Long-video topic analysis can be truncated 🔴

When a single topic covers more content than `analysisChars` (default 14,000
characters), the middle is dropped — only the beginning and the end are sent to the
model. On the measured 2h20m video this affects most topics
(136,600 chars ÷ 9 topics ≈ 15,400 chars each).

**The bilingual transcript is unaffected and always complete.** Only the per-topic
*analysis* sees a reduced view.

*Mitigation:* raise `analysisChars` in `background.js` if your model's context allows,
or split oversized topics into two calls and merge.

### Topic boundary quality degrades with length 🟡

Topic boundaries are decided from a locally compressed "skeleton" of the whole video
(each paragraph truncated to fit a 24,000-character budget). Past ~45 minutes, each
paragraph is reduced to under 30 characters, so the model has less to go on.

### Short videos are forced into 3 topics 🟡

`MIN_TOPICS` is 3. A 5-minute video about a single thing will still be split into three
topics, which can look arbitrary. Lower `MIN_TOPICS` if this bothers you.

### 20–52 minute videos always get exactly 3 topics 🟢

A rounding artifact of `round(minutes / 15)` clamped to a minimum of 3. A 45-minute
video split into 3 topics is coarse. Adjust `MINUTES_PER_TOPIC` to taste.

### One job at a time per browser 🟡

Job state lives under a single global storage key. Starting a second job in the same
browser is refused with "已有任务在跑". Two *different* browsers (e.g. Brave + Chrome)
run independently — but share your API key and quota.

### Playback is disturbed during extraction 🟢

The video is muted and played for a few seconds, and CC is toggled. Position, volume and
CC state are restored afterwards, but you will see it happen.

### The YouTube tab must stay open during extraction 🟢

Only during extraction (a few seconds). Once the progress bar starts moving, the tab can
be closed — the rest runs entirely in the background.

## 3. Reliability

### Checkpoint race is fixed and passed the current Brave regression 🟢

The audited build let concurrent translation and topic workers read the same old array
and overwrite one another. This was reproduced: two completed writes could leave only
one result.

Current source keeps AI calls concurrent but serializes read-modify-write operations for
each storage key, then verifies that every whole translation/topic checkpoint exists.
Nine automated tests pass, including forced concurrent updates and unordered caption events. After reloading
v3.7.2, real two-chunk and sixteen-chunk jobs also completed without missing translations;
the long job produced all 68 transcript sections in the downloaded Markdown. Browser
restart/sleep/Service Worker interruption cases remain separate and are still pending.

### Chromium 151/macOS can make the popup frame too wide 🟢

On Brave 1.93.136 / Chromium 151.0.7922.137, the extension origin at 140% zoom made the
browser popup frame wider than the old fixed 330px body, leaving blank space on the
right. The gap disappeared at 100%, and v3.7.1+ now lets the body follow the actual
viewport while retaining a 330px minimum. It passed again at 140%. This was cosmetic;
captions, API calls, and Markdown were not affected. Chrome and Edge cross-checks remain.

### Resume is session-scoped, not browser-restart recovery 🟠

Job checkpoints use `chrome.storage.session`. They are intended to survive Service
Worker eviction in the same browser session, but are cleared by browser restart,
extension reload/update, or disabling the extension. Extraction also cannot resume if
the YouTube tab disappears before `jobData` is first created.

| Failure | Handling |
| --- | --- |
| Model ignores the output format | Four parsing fallbacks; one retry with a stricter prompt; worst case the chunk's text is preserved but not aligned per paragraph |
| Model returns empty content (reasoning models exhausting `max_tokens`) | Detected, budget escalated ×3, retried |
| Bad topic boundaries (overlaps, gaps, out of range) | Normalized locally into a seamless, complete sequence |
| Wrong API base URL | "Test connection" probes common path variants on the same host |
| Rate limiting (429) | Backoff and retry; reduce concurrency to 1 |
| Insufficient balance | Detected and failed fast (not retried) |
| Service Worker evicted mid-run | Attempts checkpoint resume via `chrome.alarms`; serialized writes are source-tested, interruption matrix pending |
| Full browser restart / extension reload | Session checkpoint is cleared; start the job again |
| A single topic's analysis fails | Marked explicitly in the output; the rest still completes |
| YouTube SPA navigation staleness | Every data source cross-checked against the address bar's `v` parameter |

## 4. Privacy and security

- Your API key is stored in `chrome.storage.sync`, which means **it syncs to your Google
  account** if you have Chrome sync enabled. Change to `storage.local` if you don't want
  that.
- Your API key and the video transcript are sent **only** to the API endpoint you
  configure. There is no telemetry, no analytics, and no backend belonging to this project.
- The extension declares `optional_host_permissions: ["https://*/*"]` because the API
  endpoint is user-supplied and unknown in advance. Permission for a specific origin is
  requested at runtime, only when you save settings or test the connection.
- The result page is built with DOM APIs and has been tested against `<img onerror>`,
  `<script>` and `<iframe>` injection via model output. The popup uses `innerHTML` only
  for its small metadata block and escapes the title, author, and language first.

## 5. Not tested / not supported

- Firefox and Safari (Manifest V3 differences)
- YouTube Shorts, live streams, premieres, members-only and age-restricted videos
- Videos with no captions at all — reported as an error, cannot be processed
- Right-to-left target languages, and output languages other than Simplified Chinese
- Concurrent jobs in a single browser
- Very long videos beyond ~3 hours (untested; storage would allow ~13 hours)

## 6. Maintenance status

This is a personal project. It exists because I wanted to read YouTube videos instead of
watching them, and because the PoT problem turned out to be interesting.

There is no support commitment, no release schedule, and no guarantee it works tomorrow.
Issues and pull requests are welcome, but may not get a fast response.
