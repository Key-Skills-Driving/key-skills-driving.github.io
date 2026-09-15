// Everything is stored on this device in IndexedDB. Nothing is uploaded anywhere
// (except the words you send to ChatGPT when you use one-tap mode).

const DB_NAME = 'lesson-notes';
const DB_VERSION = 2;

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onclose = () => { dbPromise = null; };
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
  }
  return dbPromise;
}

async function run(stores, mode, work, retry = true) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result;
      const req = work(tx);
      if (req) req.onsuccess = () => { result = req.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    });
  } catch (err) {
    // iOS can drop the connection while the app sits in the background; reopen once.
    if (retry && err?.name === 'InvalidStateError') {
      dbPromise = null;
      return run(stores, mode, work, false);
    }
    throw err;
  }
}

export const db = {
  all: (store) => run(store, 'readonly', (tx) => tx.objectStore(store).getAll()),
  put: (store, value) => run(store, 'readwrite', (tx) => { tx.objectStore(store).put(value); }),
  putMany: (store, values) => run(store, 'readwrite', (tx) => {
    const os = tx.objectStore(store);
    values.forEach((v) => os.put(v));
  }),
  del: (store, key) => run(store, 'readwrite', (tx) => { tx.objectStore(store).delete(key); }),
  getMeta: (key) => run('meta', 'readonly', (tx) => tx.objectStore('meta').get(key)),
  setMeta: (key, value) => run('meta', 'readwrite', (tx) => { tx.objectStore('meta').put(value, key); }),
};
