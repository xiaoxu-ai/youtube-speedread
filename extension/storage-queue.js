// storage-queue.js —— 为同一个 chrome.storage key 串行化读改写。
//
// chrome.storage 没有 compare-and-swap。并发 worker 如果各自「读整个数组 → 改一个位置
// → 写整个数组」，后写入者会用旧快照覆盖先写入者。这个小工具把同一 key 的读、更新、
// 删除排进一条队列，并让 mutator 总是在队列中读取到的最新值上执行。

(function initStorageQueue(root) {
  function createStorageQueue(area, key) {
    if (!area || typeof area.get !== 'function' || typeof area.set !== 'function') {
      throw new TypeError('storage area 必须提供 get/set');
    }
    if (!key) throw new TypeError('storage key 不能为空');

    let tail = Promise.resolve();

    function enqueue(work) {
      // 前一个写入失败不能永久毒死队列；当前调用仍要把自己的错误抛给调用者。
      const run = tail.then(work, work);
      tail = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    }

    async function readCurrent() {
      const result = await area.get(key);
      return result?.[key] ?? null;
    }

    const store = {
      get() {
        return enqueue(readCurrent);
      },

      update(mutator) {
        if (typeof mutator !== 'function') throw new TypeError('mutator 必须是函数');
        return enqueue(async () => {
          const current = await readCurrent();
          const next = await mutator(current);
          if (next === undefined) {
            throw new TypeError('storage mutator 必须返回新值');
          }
          await area.set({ [key]: next });
          return next;
        });
      },

      patch(patch) {
        return store.update((current) => ({ ...(current || {}), ...patch }));
      },

      remove() {
        if (typeof area.remove !== 'function') {
          throw new TypeError('storage area 必须提供 remove');
        }
        return enqueue(async () => {
          await area.remove(key);
        });
      },
    };
    return store;
  }

  const api = { createStorageQueue };
  root.YTSRStorageQueue = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
