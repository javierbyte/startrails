// Import folders, photos, or a single video. Directory handles support reopening
// and manual rescanning; file inputs do not. Video decoding is in video.js.

import { isVideo } from './video.js';

const IMAGE_NAME = /\.(jpe?g|png)$/i;

const DB_NAME = 'startrails';
const STORE = 'handles';
const HANDLE_KEY = 'lastFolder';

export function supportsDirectoryPicker() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

// Sort numeric filename parts numerically: shot2 precedes shot10.
// Pin the locale for consistent frame order.
const collator = new Intl.Collator('en', { numeric: true, caseFirst: 'upper' });

function byName(a, b) {
  const order = collator.compare(a.name, b.name);
  // Break collation ties with a raw filename comparison.
  if (order !== 0) return order;
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

function isFrame(name) {
  // Exclude macOS resource forks from image and metadata processing.
  return IMAGE_NAME.test(name) && !name.startsWith('._');
}

/** Read top-level images from a directory handle in numeric filename order. */
export async function readHandleFrames(handle) {
  const frames = [];
  for await (const entry of handle.values()) {
    if (entry.kind !== 'file' || !isFrame(entry.name)) continue;
    frames.push(await entry.getFile());
  }
  return frames.sort(byName);
}

/** Read top-level images from a folder input or drop; exclude subfolders. */
export function framesFromFileList(fileList) {
  return Array.from(fileList)
    .filter((file) => {
      if (!isFrame(file.name)) return false;
      const path = file.webkitRelativePath;
      // "<folder>/<name>" is top level; anything deeper is a subfolder.
      return !path || path.split('/').length <= 2;
    })
    .sort(byName);
}

export function folderNameFromFileList(fileList) {
  const first = Array.from(fileList)[0];
  const path = first && first.webkitRelativePath;
  return path ? path.split('/')[0] : 'Selected folder';
}

// Store directory handles in IndexedDB. Recheck permission when reopening.

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function withStore(mode, run) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = run(tx.objectStore(STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(request && request.result);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      })
  );
}

export async function rememberHandle(handle) {
  try {
    await withStore('readwrite', (store) => store.put(handle, HANDLE_KEY));
  } catch (err) {
    // Allow opening files when persistent storage is unavailable.
  }
}

export async function recallHandle() {
  try {
    const handle = await withStore('readonly', (store) => store.get(HANDLE_KEY));
    if (!handle) return null;
    const permission = await handle.queryPermission({ mode: 'read' });
    // Offer handles with prompt permission; request access when selected.
    return permission === 'denied' ? null : handle;
  } catch (err) {
    return null;
  }
}

export async function forgetHandle() {
  try {
    await withStore('readwrite', (store) => store.delete(HANDLE_KEY));
  } catch (err) {
    // Ignore storage errors.
  }
}

export async function ensureReadPermission(handle) {
  if ((await handle.queryPermission({ mode: 'read' })) === 'granted') return true;
  return (await handle.requestPermission({ mode: 'read' })) === 'granted';
}

// Input handlers.

/** Pick and remember a directory handle. */
export async function pickDirectory() {
  const handle = await window.showDirectoryPicker({ id: 'startrails', mode: 'read' });
  await rememberHandle(handle);
  return { handle, name: handle.name, frames: await readHandleFrames(handle) };
}

/** Read a dropped folder, retaining its directory handle when supported.
 * Return videos separately for the caller to decode. */
export async function framesFromDataTransfer(dataTransfer) {
  const item = Array.from(dataTransfer.items).find((entry) => entry.kind === 'file');
  if (!item) return null;

  // Detect a single video before checking for a directory.
  const dropped = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
  if (dropped && isVideo(dropped)) {
    return { handle: null, name: dropped.name, frames: [], video: dropped };
  }

  if (typeof item.getAsFileSystemHandle === 'function') {
    const handle = await item.getAsFileSystemHandle();
    if (handle && handle.kind === 'directory') {
      await rememberHandle(handle);
      return {
        handle,
        name: handle.name,
        frames: await readHandleFrames(handle),
        video: null,
      };
    }
  }

  const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
  if (entry && entry.isDirectory) {
    const frames = await readDirectoryEntry(entry);
    return { handle: null, name: entry.name, frames: frames.sort(byName), video: null };
  }

  // Loose files rather than a folder.
  const files = framesFromFileList(dataTransfer.files);
  return files.length
    ? { handle: null, name: 'Dropped files', frames: files, video: null }
    : null;
}

function readDirectoryEntry(directoryEntry) {
  return new Promise((resolve, reject) => {
    const reader = directoryEntry.createReader();
    const frames = [];

    // Read batches until readEntries returns an empty array.
    const readBatch = () => {
      reader.readEntries((entries) => {
        if (!entries.length) {
          Promise.all(
            frames.map(
              (entry) => new Promise((ok, fail) => entry.file(ok, fail))
            )
          ).then(resolve, reject);
          return;
        }
        for (const entry of entries) {
          if (entry.isFile && isFrame(entry.name)) frames.push(entry);
        }
        readBatch();
      }, reject);
    };

    readBatch();
  });
}
