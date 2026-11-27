// 逐页批处理：顺序执行（控制大图内存）、可取消后续页、保留已成功页结果。
// 不依赖 DOM；processPage / cache 均可注入，方便 Node 测试。

export class BatchCancelled extends Error {
  constructor(message = '已取消后续页') {
    super(message);
    this.name = 'BatchCancelled';
    this.code = 'CANCELLED';
  }
}

/** 显式取消信号（比 AbortController 更易在纯逻辑里构造）。 */
export class CancelToken {
  constructor() {
    this.cancelled = false;
    this.reason = null;
  }

  cancel(reason = 'user') {
    if (this.cancelled) return;
    this.cancelled = true;
    this.reason = reason;
  }

  throwIfCancelled() {
    if (this.cancelled) throw new BatchCancelled();
  }
}

/**
 * 内存结果缓存。浏览器侧另有 IndexedDB 实现，但批处理只依赖这个最小接口：
 *   cacheKey(page, signature) -> string
 *   cache.get(key) -> Promise<result|null>
 *   cache.set(key, result) -> Promise<void>
 */
export class MemoryResultCache {
  constructor() {
    this.store = new Map();
  }

  async get(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  async set(key, value) {
    this.store.set(key, value);
  }

  clear() {
    this.store.clear();
  }
}

/**
 * 顺序跑一批页。
 *
 * @param pages 页面对象数组，至少含 id
 * @param deps
 *   - processPage(page, token): 真正处理一页，返回 result（可抛 BatchCancelled）
 *   - getCached(page): 可选，返回 {cacheKey, result} 或 null；命中则直接采用
 *   - onUpdate(record): 每次某页状态变化时回调
 * @param token CancelToken
 * @returns 与 pages 同序的记录数组：
 *   { pageId, status: 'cached'|'success'|'error'|'cancelled', result?, error? }
 *
 * 语义：
 * - 取消后，当前页若响应 token 则标 cancelled，尚未开始的页全部标 cancelled；
 * - 已经 success/cached 的记录原样保留，可直接采用；
 * - 单页普通错误被记录为 error，默认继续后续页（取消是唯一的批量中止手段）。
 */
export async function runBatch(pages, deps = {}, token = new CancelToken()) {
  const records = [];
  const emit = (record) => {
    deps.onUpdate?.(record);
  };

  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];

    if (token.cancelled) {
      const record = { pageId: page.id, index, status: 'cancelled', result: null };
      records.push(record);
      emit(record);
      continue;
    }

    try {
      const cached = deps.getCached ? await deps.getCached(page) : null;
      if (cached?.result) {
        const record = {
          pageId: page.id,
          index,
          status: 'cached',
          result: cached.result,
          cacheKey: cached.cacheKey,
        };
        records.push(record);
        emit(record);
        continue;
      }

      const result = await deps.processPage(page, token);
      const record = { pageId: page.id, index, status: 'success', result };
      records.push(record);
      emit(record);
    } catch (error) {
      if (error?.code === 'CANCELLED' || error instanceof BatchCancelled) {
        const current = { pageId: page.id, index, status: 'cancelled', result: null };
        records.push(current);
        emit(current);
        token.cancel('processing');
        // 其余页在下一轮循环顶部统一标 cancelled
        continue;
      }
      const record = {
        pageId: page.id,
        index,
        status: 'error',
        error: error?.message ? String(error.message) : String(error),
      };
      records.push(record);
      emit(record);
    }
  }

  return records;
}

/** 汇总批量结果，供 UI/导出使用。 */
export function summarizeRecords(records) {
  const summary = { success: 0, cached: 0, error: 0, cancelled: 0 };
  for (const r of records) {
    if (r.status === 'success') summary.success += 1;
    else if (r.status === 'cached') summary.cached += 1;
    else if (r.status === 'error') summary.error += 1;
    else if (r.status === 'cancelled') summary.cancelled += 1;
  }
  summary.adoptable = summary.success + summary.cached;
  return summary;
}
