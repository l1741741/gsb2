// IndexedDB 成功结果缓存：键为 pageKey + 配置签名。
// 重新选择同一批文件、且四角/比例/区域未变时，可直接采用上次成功导出的 PNG 与信息。
// 环境不支持 IndexedDB 时静默降级为内存缓存，不影响使用。

const DB_NAME = 'page-corrector';
const DB_VERSION = 1;
const STORE = 'results';

function openDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'cacheKey' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class IdbResultCache {
  constructor() {
    this.fallback = new Map();
    this.dbPromise = null;
  }

  async #db() {
    if (!this.dbPromise) this.dbPromise = openDB();
    return this.dbPromise;
  }

  async get(cacheKey) {
    try {
      const db = await this.#db();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(cacheKey);
        req.onsuccess = () => resolve(req.result?.value ?? null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return this.fallback.has(cacheKey) ? this.fallback.get(cacheKey) : null;
    }
  }

  async set(cacheKey, value) {
    const record = { cacheKey, value, savedAt: new Date().toISOString() };
    try {
      const db = await this.#db();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      this.fallback.set(cacheKey, value);
    }
  }

  async delete(cacheKey) {
    try {
      const db = await this.#db();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(cacheKey);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      this.fallback.delete(cacheKey);
    }
  }
}
