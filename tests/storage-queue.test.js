const assert = require('node:assert/strict');
const test = require('node:test');

const { createStorageQueue } = require('../extension/storage-queue.js');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clone = (value) => (value == null ? value : structuredClone(value));

function memoryStorage(initial = {}) {
  const values = clone(initial);
  return {
    async get(key) {
      await delay(1);
      return { [key]: clone(values[key]) };
    },
    async set(patch) {
      await delay(1);
      Object.assign(values, clone(patch));
    },
    async remove(key) {
      await delay(1);
      delete values[key];
    },
  };
}

test('并发更新同一数组时保留两个 worker 的结果', async () => {
  const area = memoryStorage({
    jobData: { translations: [null, null] },
  });
  const store = createStorageQueue(area, 'jobData');

  await Promise.all([
    store.update(async (current) => {
      await delay(15);
      const translations = current.translations.slice();
      translations[0] = ['done0'];
      return { ...current, translations };
    }),
    store.update(async (current) => {
      const translations = current.translations.slice();
      translations[1] = ['done1'];
      return { ...current, translations };
    }),
  ]);

  assert.deepEqual((await store.get()).translations, [['done0'], ['done1']]);
});

test('失败的更新不会让后续写入永久卡死', async () => {
  const area = memoryStorage({ jobData: { outline: null } });
  const store = createStorageQueue(area, 'jobData');

  await assert.rejects(
    store.update(() => {
      throw new Error('simulated write failure');
    }),
    /simulated write failure/
  );

  await store.patch({ outline: [{ title: '恢复成功', from: 1, to: 2 }] });
  assert.equal((await store.get()).outline[0].title, '恢复成功');
});

test('remove 排在既有写入之后，不会被更早的慢写重新复活', async () => {
  const area = memoryStorage({ jobData: { overall: null } });
  const store = createStorageQueue(area, 'jobData');

  const writing = store.update(async (current) => {
    await delay(15);
    return { ...current, overall: 'done' };
  });
  const removing = store.remove();

  await Promise.all([writing, removing]);
  assert.equal(await store.get(), null);
});
