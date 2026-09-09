const assert = require('node:assert/strict');
const test = require('node:test');

const { json3ToSegments } = require('../extension/caption-utils.js');

test('人工字幕事件乱序时先按开始时间恢复时间线', () => {
  const segments = json3ToSegments({
    events: [
      { tStartMs: 971600, dDurationMs: 1533, segs: [{ utf8: '16:11 的插入事件' }] },
      { tStartMs: 973166, dDurationMs: 3134, segs: [{ utf8: '16:13 的插入事件' }] },
      { tStartMs: 533, dDurationMs: 1900, segs: [{ utf8: '视频开头' }] },
      { tStartMs: 2433, dDurationMs: 1200, segs: [{ utf8: '开头续句' }] },
    ],
  });

  assert.deepEqual(
    segments.map(({ start, text }) => [start, text]),
    [
      [533, '视频开头'],
      [2433, '开头续句'],
      [971600, '16:11 的插入事件'],
      [973166, '16:13 的插入事件'],
    ]
  );
});

test('规范化数字、空白和负时长，并忽略没有正文的事件', () => {
  const segments = json3ToSegments({
    events: [
      { tStartMs: '2000', dDurationMs: '-50', segs: [{ utf8: '  第二句\n' }] },
      { tStartMs: 1000, dDurationMs: 500, segs: [{ utf8: '第一句' }] },
      { tStartMs: 3000, dDurationMs: 100, segs: [{ utf8: '   ' }] },
      { tStartMs: 4000, dDurationMs: 100 },
    ],
  });

  assert.deepEqual(segments, [
    { start: 1000, end: 1500, text: '第一句' },
    { start: 2000, end: 2000, text: '第二句' },
  ]);
});
