const assert = require('node:assert/strict');
const test = require('node:test');

const { trackFromTimedTextUrl } = require('../extension/track-utils.js');

test('fallback URL 指向自动英文字幕时返回真实英文 ASR 轨道', () => {
  const tracks = [
    { languageCode: 'ar', name: { simpleText: 'Arabic' } },
    { languageCode: 'en', kind: 'asr', name: { simpleText: 'English (auto)' } },
  ];

  const actual = trackFromTimedTextUrl(
    'https://www.youtube.com/api/timedtext?v=abc&lang=en&kind=asr&pot=token',
    tracks
  );

  assert.equal(actual, tracks[1]);
  assert.equal(actual.languageCode, 'en');
  assert.equal(actual.kind, 'asr');
});

test('人工字幕 URL 没有 kind 时匹配人工轨道', () => {
  const tracks = [
    { languageCode: 'en-GB', name: { simpleText: 'English (UK)' } },
    { languageCode: 'en-GB', kind: 'asr', name: { simpleText: 'English (auto)' } },
  ];

  const actual = trackFromTimedTextUrl(
    'https://www.youtube.com/api/timedtext?v=abc&lang=en-GB&pot=token',
    tracks
  );

  assert.equal(actual, tracks[0]);
});

test('轨道表没有匹配项时仍以成功 URL 的 lang/kind 生成真实元数据', () => {
  const actual = trackFromTimedTextUrl(
    'https://www.youtube.com/api/timedtext?v=abc&lang=zh-Hant&kind=asr&pot=token',
    []
  );

  assert.deepEqual(actual, { languageCode: 'zh-Hant', kind: 'asr' });
});

test('URL 没有 lang 或无法解析时返回 null', () => {
  assert.equal(trackFromTimedTextUrl('https://www.youtube.com/api/timedtext?v=abc', []), null);
  assert.equal(trackFromTimedTextUrl('http://%', []), null);
});
