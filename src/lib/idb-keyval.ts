// Tiny inline replacement for idb-keyval (eliminates npm dependency).
// API-compatible subset: get<T>(key) and set(key, value).

const DB_NAME = 'keyval-store';
const STORE_NAME = 'keyval';

function getDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return getDB().then((db) => db.transaction(STORE_NAME, mode).objectStore(STORE_NAME));
}

export function get<T = unknown>(key: IDBValidKey): Promise<T | undefined> {
  return tx('readonly').then(
    (store) =>
      new Promise<T | undefined>((resolve, reject) => {
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result as T | undefined);
        req.onerror = () => reject(req.error);
      }),
  );
}

export function set(key: IDBValidKey, value: unknown): Promise<void> {
  return tx('readwrite').then(
    (store) =>
      new Promise<void>((resolve, reject) => {
        const req = store.put(value, key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      }),
  );
}
