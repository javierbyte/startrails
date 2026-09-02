// Getting a folder of frames into the page. Chromium can hand over a real
// directory handle, which is re-openable on a later visit and can be re-read to
// pick up frames shot since. This is the usable half of "sync a folder from the OS".
// Everywhere else falls back to a plain folder upload, which reads the same
// files but cannot be refreshed.
//
// Live watching is not an option yet: the FileSystemObserver origin trial ended
// at Chrome 134 and it now sits behind about:flags. Hence the Rescan button.
//
// A single video can be dropped too. It is recognised here but decoded in
// video.js, which turns it into the same array of frames a folder yields.

import { isVideo } from './video.js';

const IMAGE_NAME = /\.(jpe?g|png)$/i;

const DB_NAME = 'startrails';
const STORE = 'handles';
const HANDLE_KEY = 'lastFolder';

export function supportsDirectoryPicker() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

// Frames are ordered by filename, the way the folder reads in Finder: digit runs
// compare as numbers, so shot2 lands before shot10 rather than after shot12. A
// plain lexicographic sort gets zero-padded camera files (DSCF1888, IMG_0123)
// right by luck and unpadded ones wrong, and the order is not cosmetic here --
// the opacity ramp is applied by position, so a scrambled sequence produces a
// scrambled stack.
//
// The locale is pinned so the order cannot shift with the viewer's own.
const collator = new Intl.Collator('en', { numeric: true, caseFirst: 'upper' });

function byName(a, b) {
  const order = collator.compare(a.name, b.name);
  // Collation can call two distinct names equal; fall back to a raw comparison
  // so the sort stays deterministic.
  if (order !== 0) return order;
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

function isFrame(name) {
  // Skip macOS resource forks, which otherwise sort to the front and become
  // "the first frame" that the EXIF gets copied from.
  return IMAGE_NAME.test(name) && !name.startsWith('._');
}

/** Reads the frames sitting directly in a directory handle, in CLI order. */
export async function readHandleFrames(handle) {
  const frames = [];
  for await (const entry of handle.values()) {
    if (entry.kind !== 'file' || !isFrame(entry.name)) continue;
    frames.push(await entry.getFile());
  }
  return frames.sort(byName);
}

/**
 * Frames out of an <input webkitdirectory> or a dropped folder. The CLI does not
 * recurse, so neither do we: only files sitting directly in the chosen folder.
 */
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

// --- persistence ---------------------------------------------------------
//
// Directory handles are structured-cloneable, so IndexedDB can hold one between
// visits. The grant does not survive, which is why reopening asks again.

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
    // A private window with storage disabled is not a reason to fail the open.
  }
}

export async function recallHandle() {
  try {
    const handle = await withStore('readonly', (store) => store.get(HANDLE_KEY));
    if (!handle) return null;
    const permission = await handle.queryPermission({ mode: 'read' });
    // 'prompt' still counts: the folder is offered, and picking it asks.
    return permission === 'denied' ? null : handle;
  } catch (err) {
    return null;
  }
}

export async function forgetHandle() {
  try {
    await withStore('readwrite', (store) => store.delete(HANDLE_KEY));
  } catch (err) {
    // Nothing to do.
  }
}

export async function ensureReadPermission(handle) {
  if ((await handle.queryPermission({ mode: 'read' })) === 'granted') return true;
  return (await handle.requestPermission({ mode: 'read' })) === 'granted';
}

// --- entry points --------------------------------------------------------

/** The Chromium path: a handle we can re-read later. */
export async function pickDirectory() {
  const handle = await window.showDirectoryPicker({ id: 'startrails', mode: 'read' });
  await rememberHandle(handle);
  return { handle, name: handle.name, frames: await readHandleFrames(handle) };
}

/**
 * A dropped folder. Chromium hands over a real handle here too, which keeps
 * Rescan working for drag-and-drop; elsewhere we walk the directory entry.
 *
 * A dropped video comes back as `video` with no frames, for the caller to
 * extract. Every path returns the same shape so callers can just look at it.
 */
export async function framesFromDataTransfer(dataTransfer) {
  const item = Array.from(dataTransfer.items).find((entry) => entry.kind === 'file');
  if (!item) return null;

  // Checked before the directory paths: a video is a single file, so neither of
  // them would recognise it.
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

    // readEntries returns a batch at a time and signals the end with an empty
    // one, so it has to be called until it comes back empty.
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
