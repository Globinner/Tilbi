/**
 * Tilbi - Minimal, Reliable Clipboard Manager
 */
const { app, BrowserWindow, Tray, Menu, clipboard, nativeImage, globalShortcut, ipcMain, screen, desktopCapturer, shell } = require('electron');
const { spawn } = require('child_process');
let autoUpdater;
try {
  autoUpdater = require('electron-updater').autoUpdater;
} catch (e) {
  console.warn('electron-updater not available:', e.message);
  autoUpdater = null;
}
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const Store = require('electron-store');
const os = require('os');
const { google } = require('googleapis');
const subscription = require('./subscription');

// Get user's Screenshots directory or create one
const userScreenshotsPath = path.join(os.homedir(), 'Pictures', 'Screenshots');
if (!fs.existsSync(userScreenshotsPath)) {
    fs.mkdirSync(userScreenshotsPath, { recursive: true });
}

// Function to generate unique filename
function generateScreenshotFilename() {
    const date = new Date();
    const timestamp = date.toISOString().replace(/[:.]/g, '-').replace('T', '_').split('.')[0];
    return `Screenshot_${timestamp}.png`;
}

console.log('Initializing electron-store...');
const rawStore = new Store({ name: 'clipboard-history' });
const storePath = rawStore.path;
let memoryStore = rawStore.store || {};
let persistTimer = null;
let persistQueued = false;
let persistInFlight = false;

function isHugeClipboardText(value) {
  return typeof value === 'string' && (value.startsWith('data:image/') || value.length > 50000);
}

function stripInlineMediaFromScreenerItem(item) {
  if (!item || typeof item !== 'object') return item;
  if (!item.dataUrl && !item.thumbnailDataUrl) return item;
  const next = { ...item };
  delete next.dataUrl;
  delete next.thumbnailDataUrl;
  return next;
}

function sanitizeMemoryStore() {
  let changed = false;
  if (Array.isArray(memoryStore.screenerItems)) {
    const compacted = memoryStore.screenerItems.map((item) => {
      if (item && typeof item === 'object' && (item.dataUrl || item.thumbnailDataUrl)) {
        changed = true;
        return stripInlineMediaFromScreenerItem(item);
      }
      return item;
    });
    memoryStore.screenerItems = compacted;
  }
  if (Array.isArray(memoryStore.clipboardHistory)) {
    const filtered = memoryStore.clipboardHistory.filter((item) => !isHugeClipboardText(item));
    if (filtered.length !== memoryStore.clipboardHistory.length) {
      changed = true;
      memoryStore.clipboardHistory = filtered;
    }
  }
  return changed;
}

function persistMemoryStore() {
  persistTimer = null;
  if (persistInFlight) {
    persistQueued = true;
    return;
  }
  persistInFlight = true;
  const tmp = storePath + '.tmp';
  let json;
  try {
    json = JSON.stringify(memoryStore);
  } catch (err) {
    persistInFlight = false;
    logMain('Failed to serialize store', err);
    return;
  }
  fs.writeFile(tmp, json, (writeErr) => {
    if (writeErr) {
      persistInFlight = false;
      logMain('Failed to write store', writeErr);
      return;
    }
    fs.rename(tmp, storePath, (renameErr) => {
      persistInFlight = false;
      if (renameErr) {
        fs.copyFile(tmp, storePath, () => {});
      }
      if (persistQueued) {
        persistQueued = false;
        schedulePersist();
      }
    });
  });
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(persistMemoryStore, 400);
}

const store = {
  get(key, defaultValue) {
    if (Object.prototype.hasOwnProperty.call(memoryStore, key) && memoryStore[key] !== undefined) {
      return memoryStore[key];
    }
    return defaultValue;
  },
  has(key) {
    return Object.prototype.hasOwnProperty.call(memoryStore, key);
  },
  delete(key) {
    if (Object.prototype.hasOwnProperty.call(memoryStore, key)) {
      delete memoryStore[key];
      schedulePersist();
    }
  },
  get path() { return storePath; },
  set(key, value) {
    if (value === undefined || value === null) {
      if (Object.prototype.hasOwnProperty.call(memoryStore, key)) {
        delete memoryStore[key];
        schedulePersist();
      }
      return;
    }
    memoryStore[key] = value;
    schedulePersist();
  }
};
console.log('Store initialized successfully');

function getMainLogPath() {
  try {
    return path.join(app.getPath('userData'), 'tilbi-main.log');
  } catch (_) {
    return path.join(process.env.APPDATA || os.homedir(), 'tilbi', 'tilbi-main.log');
  }
}

function logMain(...args) {
  const line = args.map((arg) => {
    if (arg instanceof Error) return arg.stack || arg.message;
    if (typeof arg === 'string') return arg;
    try { return JSON.stringify(arg); } catch (_) { return String(arg); }
  }).join(' ');
  const stamped = `[${new Date().toISOString()}] ${line}`;
  try {
    fs.appendFileSync(getMainLogPath(), stamped + '\n');
  } catch (_) {}
  console.log(...args);
}

process.on('uncaughtException', (err) => {
  logMain('uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
  logMain('unhandledRejection', reason instanceof Error ? reason : String(reason));
});

function pathToFileUrl(filePath) {
  if (!filePath) return '';
  const normalized = path.resolve(String(filePath)).replace(/\\/g, '/');
  return encodeURI('file:///' + normalized.replace(/^\/+/, ''));
}

if (sanitizeMemoryStore()) {
  schedulePersist();
}

// Initialize screener store if it doesn't exist
if (!store.has('screenerItems')) {
  store.set('screenerItems', []);
}

// Initialize delete confirmation preference
if (!store.has('skipDeleteConfirmation')) {
  store.set('skipDeleteConfirmation', false);
}

// Initialize EULA acceptance status
if (!store.has('eulaAccepted')) {
  store.set('eulaAccepted', false);
  store.set('eulaVersion', '1.0');
}

// Configuration constants
const MAX_HISTORY_ITEMS = Infinity;  // Unlimited history items
const MAX_PINNED_ITEMS = Infinity;   // Unlimited pinned items
const MAX_SCREENER_ITEMS = Infinity; // Unlimited screener items
const SCREENER_LOADING_STALE_MS = 90000;
const WEBPAGE_CAPTURE_TIMEOUT_MS = 90000;
const WEBPAGE_CAPTURE_SORRY_MSG =
  "Sorry — we couldn't capture this full page. Some sites use videos, login walls, or heavy scripts that block capture. Try Interactive mode, or use Rect / Full Screen instead.";

const PREPARE_PAGE_FOR_CAPTURE_JS = `
(function() {
  try {
    const style = document.createElement('style');
    style.id = 'tilbi-capture-prep';
    style.textContent = 'video, audio, iframe[src*="youtube"], iframe[src*="vimeo"], iframe[src*="video"] { visibility: hidden !important; pointer-events: none !important; max-height: 1px !important; overflow: hidden !important; }';
    (document.head || document.documentElement).appendChild(style);
    document.querySelectorAll('video').forEach(function(v) {
      try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {}
    });
    document.querySelectorAll('audio').forEach(function(a) {
      try { a.pause(); a.removeAttribute('src'); } catch (e) {}
    });
    document.querySelectorAll('iframe').forEach(function(f) {
      var s = (f.src || '').toLowerCase();
      if (s.indexOf('youtube') >= 0 || s.indexOf('vimeo') >= 0 || s.indexOf('video') >= 0 || s.indexOf('player') >= 0) {
        f.style.display = 'none';
      }
    });
    document.querySelectorAll('img[loading="lazy"]').forEach(function(img) { img.loading = 'eager'; });
  } catch (e) {}
  return true;
})();
`;

function isValidCaptureImage(image) {
  if (!image || typeof image.isEmpty !== 'function' || image.isEmpty()) return false;
  const size = image.getSize ? image.getSize() : { width: 0, height: 0 };
  return size.width >= 10 && size.height >= 10;
}

async function waitForPageReady(webContents) {
  try {
    await Promise.race([
      webContents.executeJavaScript(`(async () => {
        try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) {}
        const imgs = Array.from(document.images || []).slice(0, 60);
        await Promise.all(imgs.map((img) => {
          if (!img || img.complete) return null;
          return new Promise((resolve) => {
            img.onload = resolve;
            img.onerror = resolve;
            setTimeout(resolve, 1800);
          });
        }));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return true;
      })()`),
      new Promise((resolve) => setTimeout(resolve, 3500))
    ]);
  } catch (_) {}
}

async function captureWebpageViaCdp(targetWindow, hiRes) {
  const wc = targetWindow.webContents;
  const wasAttached = wc.debugger.isAttached();
  if (!wasAttached) {
    try {
      wc.debugger.attach('1.3');
    } catch (_) {
      wc.debugger.attach();
    }
  }
  try {
    const metrics = await wc.debugger.sendCommand('Page.getLayoutMetrics');
    const content = metrics.cssContentSize || metrics.contentSize || {};
    const width = Math.min(Math.max(Math.ceil(content.width || 1280), 800), hiRes ? 1920 : 1440);
    const height = Math.min(Math.max(Math.ceil(content.height || 800), 600), hiRes ? 14000 : 10000);
    await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      mobile: false,
      width,
      height,
      deviceScaleFactor: 1,
      screenWidth: width,
      screenHeight: height
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const shot = await wc.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true
    });
    try { await wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride'); } catch (_) {}
    if (!shot || !shot.data) return null;
    return nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'));
  } finally {
    if (!wasAttached) {
      try { if (wc.debugger.isAttached()) wc.debugger.detach(); } catch (_) {}
    }
  }
}

async function captureWebpageImage(targetWindow, hiRes) {
  const wc = targetWindow.webContents;
  await waitForPageReady(wc);
  try {
    await Promise.race([
      wc.executeJavaScript(PREPARE_PAGE_FOR_CAPTURE_JS),
      new Promise((resolve) => setTimeout(resolve, 1200))
    ]);
  } catch (_) {}

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const image = await captureWebpageViaCdp(targetWindow, hiRes);
      if (isValidCaptureImage(image)) return image;
    } catch (err) {
      console.warn('CDP webpage capture attempt failed:', err && err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
  }

  try {
    const pageSize = await wc.executeJavaScript(`({
      width: Math.max(document.documentElement.scrollWidth || 0, document.body.scrollWidth || 0, 800),
      height: Math.max(document.documentElement.scrollHeight || 0, document.body.scrollHeight || 0, 600)
    })`);
    const widthCap = hiRes ? 1920 : 1440;
    const heightCap = hiRes ? 14000 : 8000;
    targetWindow.setContentSize(
      Math.min(Math.max(pageSize.width, 800), widthCap),
      Math.min(Math.max(pageSize.height, 600), heightCap)
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    const image = await wc.capturePage();
    if (isValidCaptureImage(image)) return image;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const retry = await wc.capturePage();
    if (isValidCaptureImage(retry)) return retry;
  } catch (err) {
    console.warn('Viewport webpage capture failed:', err && err.message);
  }

  throw new Error(WEBPAGE_CAPTURE_SORRY_MSG);
}

function makeDragIcon(filePath) {
  let icon = filePath ? nativeImage.createFromPath(filePath) : nativeImage.createEmpty();
  if (!icon.isEmpty()) {
    const size = icon.getSize();
    if (size.width > 128 || size.height > 128) {
      icon = icon.resize({ width: 96, height: 96, quality: 'good' });
    }
    return icon;
  }
  const fallback = findIconFile();
  if (fallback) {
    icon = nativeImage.createFromPath(fallback);
    if (!icon.isEmpty()) return icon.resize({ width: 48, height: 48, quality: 'good' });
  }
  return nativeImage.createFromBuffer(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAQAAAAAZ31ahAAAAdklEQVR4nO3UMQ0AIAwEwQ1q+JcJGkjgJdnMzN39AQAAAAAAAAAAAAD4M3P3iLi7uZ+Z+0fE3c/9PAAAAAAAAAAA8B8AAAAAAAAAAMBfADwAqo8BuW95iVsAAAAASUVORK5CYII=',
    'base64'
  ));
}

function broadcastClipboardData() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const screener = (store.get('screenerItems') || []).map(stripInlineMediaFromScreenerItem);
    mainWindow.webContents.send('clipboard-data', {
      history: store.get('clipboardHistory') || [],
      pinned: store.get('pinnedItems') || [],
      screener
    });
  }
}

function purgeStaleScreenerLoadingItems(maxAgeMs = SCREENER_LOADING_STALE_MS) {
  let screenerItems = store.get('screenerItems') || [];
  const now = Date.now();
  const filtered = screenerItems.filter((it) => {
    if (!it || typeof it !== 'object' || it.type !== 'loading') return true;
    if (maxAgeMs <= 0) return false;
    return it.timestamp && (now - it.timestamp) < maxAgeMs;
  });
  if (filtered.length !== screenerItems.length) {
    store.set('screenerItems', filtered);
    broadcastClipboardData();
  }
  return filtered;
}

function removeScreenerLoadingById(placeholderId) {
  let screenerItems = store.get('screenerItems') || [];
  const filtered = screenerItems.filter((it) => {
    if (!it || typeof it !== 'object' || it.type !== 'loading') return true;
    if (!placeholderId) return false;
    return it.id !== placeholderId;
  });
  if (filtered.length !== screenerItems.length) {
    store.set('screenerItems', filtered);
    broadcastClipboardData();
  }
}

function replaceScreenerLoadingWithError(placeholderId, message) {
  const friendly = message || WEBPAGE_CAPTURE_SORRY_MSG;
  let screenerItems = store.get('screenerItems') || [];
  const entry = {
    id: placeholderId || `error-${Date.now()}`,
    type: 'capture-error',
    timestamp: Date.now(),
    message: friendly
  };
  if (placeholderId) {
    const idx = screenerItems.findIndex((it) => it && it.id === placeholderId);
    if (idx >= 0) {
      screenerItems[idx] = entry;
    } else {
      screenerItems.unshift(entry);
    }
  } else {
    screenerItems = screenerItems.filter((it) => !(it && it.type === 'loading'));
    screenerItems.unshift(entry);
  }
  store.set('screenerItems', screenerItems);
  broadcastClipboardData();
}

function addScreenerLoadingPlaceholder(url, message) {
  const placeholderId = `loading-${Date.now()}`;
  let screenerItems = store.get('screenerItems') || [];
  screenerItems.unshift({
    id: placeholderId,
    type: 'loading',
    timestamp: Date.now(),
    url,
    message: message || 'Capturing webpage...'
  });
  store.set('screenerItems', screenerItems);
  return placeholderId;
}

// Exact pixel height of the header-only mode (matches renderer header)
const HEADER_ONLY_HEIGHT = 46;

// App size configurations
const APP_SIZES = {
  normal: { width: 400, height: 500 },
  // 'large' becomes a compact header-only mode (same width, header-only height)
  large: { width: 400, height: HEADER_ONLY_HEIGHT }
};

// Track current size in memory
let currentAppSize = store.get('appSize') || 'normal';
let isToggling = false; // Prevent double-clicks

console.log('📐 APP_SIZES configured:', APP_SIZES);
console.log('💾 Store path:', store.path);
console.log('📐 Initial app size:', currentAppSize);

// Auto-updater configuration
const UPDATE_UP_TO_DATE_MSG = 'Your app is up to date.';
const TILBI_UPDATES_BASE = 'https://github.com/Globinner/Tilbi/releases/latest/download';

function resolveUpdateCheckFailure(err) {
  const raw = (err && err.message) ? err.message : 'Could not check for updates.';
  if (/404|Not Found|no published versions|latest release|releases\/tag/i.test(raw)) {
    return { status: 'not-available', message: UPDATE_UP_TO_DATE_MSG };
  }
  if (/app-update\.yml/i.test(raw) || /ENOENT/i.test(raw)) {
    return { status: 'error', message: 'One-time fix needed: click Download Update below, then Restart & Install.' };
  }
  if (/net::|network|ENOTFOUND|ETIMEDOUT|ECONNREFUSED/i.test(raw)) {
    return { status: 'error', message: 'Could not reach the update server. Check your internet connection.' };
  }
  return { status: 'error', message: raw };
}

function requestWithRedirects(url, maxRedirects = 8) {
  return new Promise((resolve, reject) => {
    const follow = (targetUrl, left) => {
      const lib = targetUrl.startsWith('https:') ? https : http;
      lib.get(targetUrl, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && left > 0) {
          const next = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, targetUrl).href;
          res.resume();
          follow(next, left - 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Download failed (${res.statusCode})`));
          return;
        }
        resolve(res);
      }).on('error', reject);
    };
    follow(url, maxRedirects);
  });
}

function downloadLatestInstaller(onProgress) {
  const cacheDir = path.join(app.getPath('temp'), 'tilbi-updater');
  fs.mkdirSync(cacheDir, { recursive: true });
  const dest = path.join(cacheDir, 'Tilbi-Setup.exe');

  return requestWithRedirects(`${TILBI_UPDATES_BASE}/Tilbi-Setup.exe`).then((res) => {
    return new Promise((resolve, reject) => {
      const total = parseInt(res.headers['content-length'], 10) || 0;
      let transferred = 0;
      const file = fs.createWriteStream(dest);

      const report = () => {
        if (typeof onProgress === 'function') {
          onProgress({
            percent: total ? (transferred / total) * 100 : 50,
            transferred,
            total: total || transferred
          });
        }
      };

      res.on('data', (chunk) => {
        transferred += chunk.length;
        report();
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
      file.on('error', reject);
      res.on('error', reject);
    });
  });
}

function configureAutoUpdater() {
  if (!autoUpdater) return;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  if (app.isPackaged) {
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: TILBI_UPDATES_BASE
    });
  }
}

let downloadedUpdateFile = null;

function runDownloadedInstallerAndQuit() {
  const candidates = [
    downloadedUpdateFile,
    autoUpdater && autoUpdater.downloadedUpdateHelper
      ? path.join(autoUpdater.downloadedUpdateHelper.cacheDir, 'Tilbi-Setup.exe')
      : null
  ].filter(Boolean);

  for (const installerPath of candidates) {
    if (!fs.existsSync(installerPath)) continue;
    spawn(installerPath, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/CLOSEAPPLICATIONS'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }).unref();
    setTimeout(() => app.quit(), 500);
    return true;
  }
  return false;
}

// Prevent multiple instances of the app
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log('Another instance is already running. Exiting.');
  app.quit();
  return;
}

// Global references to prevent garbage collection
let mainWindow = null;
let clipboardWindow = null;
let selectionWindow = null;
let editorWindow = null;
let isScreenshotMode = false;
let wasMinimizedForTaskbarCamera = false; // kept only to ignore stale restore-capture behavior

function getCaptureWindowBounds() {
  const displays = screen.getAllDisplays();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const display of displays) {
    const { x, y, width, height } = display.bounds;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
  }
  if (!isFinite(minX) || !isFinite(minY)) {
    const primary = screen.getPrimaryDisplay().bounds;
    return { x: primary.x, y: primary.y, width: primary.width, height: primary.height };
  }
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY)
  };
}

function getDisplayForCaptureBounds(bounds) {
  const centerX = bounds.x + (bounds.width / 2);
  const centerY = bounds.y + (bounds.height / 2);
  for (const display of screen.getAllDisplays()) {
    const db = display.bounds;
    if (centerX >= db.x && centerX < (db.x + db.width) &&
        centerY >= db.y && centerY < (db.y + db.height)) {
      return display;
    }
  }
  return screen.getPrimaryDisplay();
}

async function captureScreenThumbnailForBounds(bounds) {
  const targetDisplay = getDisplayForCaptureBounds(bounds);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: targetDisplay.size.width,
      height: targetDisplay.size.height
    }
  });
  const source = sources.find((item) => String(item.display_id) === String(targetDisplay.id)) || sources[0];
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error('Could not capture screen thumbnail');
  }
  const screenshot = source.thumbnail;
  const thumbSize = screenshot.getSize();
  const scaleX = thumbSize.width / targetDisplay.bounds.width;
  const scaleY = thumbSize.height / targetDisplay.bounds.height;
  const relX = bounds.x - targetDisplay.bounds.x;
  const relY = bounds.y - targetDisplay.bounds.y;
  let cropX = Math.max(0, Math.round(relX * scaleX));
  let cropY = Math.max(0, Math.round(relY * scaleY));
  let cropW = Math.max(1, Math.round(bounds.width * scaleX));
  let cropH = Math.max(1, Math.round(bounds.height * scaleY));
  cropW = Math.min(cropW, thumbSize.width - cropX);
  cropH = Math.min(cropH, thumbSize.height - cropY);
  return {
    screenshot,
    cropRect: { x: cropX, y: cropY, width: cropW, height: cropH }
  };
}

function scaleCaptureForReadableSave(image, minHeight = 480) {
  const size = image.getSize();
  if (!size.width || !size.height || size.height >= minHeight) {
    return image;
  }
  const scale = minHeight / size.height;
  return image.resize({
    width: Math.max(1, Math.round(size.width * scale)),
    height: minHeight,
    quality: 'best'
  });
}

function openScreenshotInEditor(screenshotContent) {
  const payload = typeof screenshotContent === 'string'
    ? { path: screenshotContent }
    : (screenshotContent || {});
  const imagePath = payload.path || (typeof screenshotContent === 'string' ? screenshotContent : null);
  if (!imagePath) {
    console.error('No image path provided:', screenshotContent);
    return;
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }

  const sendMediaToEditor = () => {
    try {
      const ext = (path.extname(imagePath || '').toLowerCase() || '').replace('.', '');
      const type = payload.type || (ext === 'mp4' || ext === 'mov' || ext === 'mkv' || ext === 'webm' ? 'video' : 'image');
      if (type === 'video') {
        editorWindow.webContents.send('load-video', imagePath);
      } else {
        editorWindow.webContents.send('load-image', imagePath);
      }
    } catch (e) {
      editorWindow.webContents.send('load-image', imagePath);
    }
    editorWindow.show();
    editorWindow.focus();
  };

  if (!editorWindow || editorWindow.isDestroyed()) {
    editorWindow = new BrowserWindow({
      width: 960,
      height: 640,
      backgroundColor: '#1f2937',
      frame: false,
      transparent: false,
      show: false,
      resizable: true,
      icon: path.join(__dirname, 'icons', 'icon.ico'),
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        enableRemoteModule: false
      }
    });

    editorWindow.loadFile('image-editor.html');
    editorWindow.webContents.once('did-finish-load', sendMediaToEditor);
    editorWindow.on('closed', () => {
      editorWindow = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } else {
    sendMediaToEditor();
  }
}

function hideMainForCapture() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) {
    mainWindow.hide();
  } else if (mainWindow.isVisible()) {
    mainWindow.hide();
  }
}

function restoreMainAfterCapture() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setAlwaysOnTop(true);
  mainWindow.show();
  mainWindow.focus();
}

function createCaptureBrowserWindow(extraOptions = {}) {
  const bounds = getCaptureWindowBounds();
  const iconPath = findIconFile();
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    transparent: true,
    frame: false,
    fullscreen: false,
    simpleFullscreen: false,
    skipTaskbar: true,
    show: false,
    title: 'Tilbi Capture',
    icon: iconPath || path.join(__dirname, 'icons', '128x128.png'),
    alwaysOnTop: true,
    hasShadow: false,
    thickFrame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    enableLargerThanScreen: true,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    },
    ...extraOptions
  });
  try { win.setFullScreen(false); } catch (_) {}
  try { win.setBounds(bounds); } catch (_) {}
  try { win.setAlwaysOnTop(true, 'screen-saver'); } catch (_) {}
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) {}
  return win;
}
let clipboardMonitorInterval = null;
let lastClipboardContent = '';
let isMonitoringActive = false;
let monitoringLogCount = 0;

// Helper function to safely show main window
function safeShowMainWindow() {
  if (!isScreenshotMode && mainWindow && !mainWindow.isDestroyed()) {
    console.log('Safely showing main window');
    mainWindow.show();
    mainWindow.focus();
    return true;
  } else if (isScreenshotMode) {
    console.log('Prevented main window from showing - in screenshot mode');
  }
  return false;
}

// Google Drive sync variables
let gdriveOAuth2Client = null;
let gdriveSyncInterval = null;
let gdriveConnected = false;

// Create the main window
function createMainWindow(options = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  // Get screen dimensions
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  
  // Find the icon to use consistently for both window and tray
  const iconPath = findIconFile();
  
  // Get current app size preference
  const currentSize = store.get('appSize') || 'normal';
  const size = APP_SIZES[currentSize];
  
  console.log(`📐 Creating window with size: ${currentSize} (${size.width}x${size.height})`);
  
  mainWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: size.width,
    // allow shrinking exactly to header-only height
    minHeight: HEADER_ONLY_HEIGHT,
    maxWidth: size.width,
    show: options.show !== undefined ? options.show : true,
    frame: false,
    autoHideMenuBar: true,
    skipTaskbar: false,
    alwaysOnTop: true,
    resizable: true, // allow vertical resizing; width fixed via min/max
    maximizable: false,
    minimizable: true,
    closable: true,
    icon: path.join(__dirname, 'icons', '128x128.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
      webSecurity: false,
      allowRunningInsecureContent: true,
      experimentalFeatures: true
    }
  });

  try { mainWindow.setTitle('Tilbi'); } catch (_) {}

  // Explicitly set the size after creation to ensure it's applied
  mainWindow.setSize(size.width, size.height, false);
  mainWindow.setMinimumSize(size.width, HEADER_ONLY_HEIGHT);
  try { mainWindow.setMaximumSize(size.width, 10000); } catch (_) {}
  console.log(`📐 Set window size to: ${size.width}x${size.height}`);
  
  // Position in center of screen
  const tilbiX = Math.floor((width - size.width) / 2);
  const tilbiY = Math.floor((height - size.height) / 2);
  mainWindow.setPosition(tilbiX, tilbiY);
  
  // Verify the actual size
  const actualSize = mainWindow.getSize();
  console.log(`📐 Actual window size: ${actualSize[0]}x${actualSize[1]}`);

  // Listen for window minimize/restore events
  mainWindow.on('minimize', () => {
    wasMinimizedForTaskbarCamera = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-minimized');
    }
  });
  
  mainWindow.on('restore', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (isScreenshotMode) {
        hideMainForCapture();
        if (selectionWindow && !selectionWindow.isDestroyed()) {
          selectionWindow.focus();
        }
        return;
      }
      wasMinimizedForTaskbarCamera = false;
      mainWindow.webContents.send('window-restored');
    }
  });
  
  mainWindow.on('show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-restored');
    }
  });
  
  // Add synchronized movement with Flower Desktop
  mainWindow.on('move', () => {
    try {
      const [x, y] = mainWindow.getPosition();
      // Try to find and move Flower Desktop window
      const { BrowserWindow } = require('electron');
      const allWindows = BrowserWindow.getAllWindows();
      
      // Look for Loginner Studio window (it will have a different title/properties)
      const flowerWindow = allWindows.find(win => {
        try {
          return win !== mainWindow && 
                 (win.getTitle().includes('Loginner') || 
                  win.getTitle().includes('Studio') ||
                  win.webContents.getURL().includes('localhost:5174') ||
                  win.webContents.getURL().includes('dist/index.html'));
        } catch (e) {
          return false;
        }
      });
      
      if (flowerWindow && !flowerWindow.isDestroyed()) {
         // Move Loginner Studio to maintain offset to the right (stitched together)
         flowerWindow.setPosition(x + size.width, y);
      }
    } catch (error) {
      // Silently ignore errors - Flower Desktop might not be running
    }
  });

  // Handle window visibility changes - sync with Flower Desktop
  mainWindow.on('show', () => {
    try {
      const { BrowserWindow } = require('electron');
      const allWindows = BrowserWindow.getAllWindows();
      
      const flowerWindow = allWindows.find(win => {
        try {
          return win !== mainWindow && 
                 (win.getTitle().includes('Loginner') || 
                  win.getTitle().includes('Studio') ||
                  win.webContents.getURL().includes('localhost:5174') ||
                  win.webContents.getURL().includes('dist/index.html'));
        } catch (e) {
          return false;
        }
      });
      
      if (flowerWindow && !flowerWindow.isDestroyed()) {
        flowerWindow.show();
      }
    } catch (error) {
      // Silently ignore errors
    }
  });

  mainWindow.on('hide', () => {
    try {
      const { BrowserWindow } = require('electron');
      const allWindows = BrowserWindow.getAllWindows();
      
      const flowerWindow = allWindows.find(win => {
        try {
          return win !== mainWindow && 
                 (win.getTitle().includes('Loginner') || 
                  win.getTitle().includes('Studio') ||
                  win.webContents.getURL().includes('localhost:5174') ||
                  win.webContents.getURL().includes('dist/index.html'));
        } catch (e) {
          return false;
        }
      });
      
      if (flowerWindow && !flowerWindow.isDestroyed()) {
        flowerWindow.hide();
      }
    } catch (error) {
      // Silently ignore errors
    }
  });

  // Load the popup UI
  mainWindow.loadFile(path.join(__dirname, 'popup.html'));

  // Make sure window is shown and focused
  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Quit the app when window is closed
  mainWindow.on('close', (event) => {
    app.isQuitting = true;
    app.quit();
  });

  // Send data to the window on load
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('Main window loaded, sending initial clipboard data');
    
    // Add delay to ensure renderer is fully ready
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        try {
    const history = store.get('clipboardHistory') || [];
    const pinnedItems = store.get('pinnedItems') || [];
    const screenerItems = store.get('screenerItems') || [];
    
    // Log the data we're sending to verify
    console.log(`Sending ${history.length} history items and ${pinnedItems.length} pinned items to UI`);
    
    mainWindow.webContents.send('clipboard-data', {
      history: history,
      pinned: pinnedItems,
      screener: screenerItems
    });
        } catch (error) {
          console.warn('Failed to send clipboard data to renderer:', error);
        }
      }
    }, 100); // Small delay to ensure renderer is ready
  });

  console.log('Main window created');
}

// Wipe all persisted user data (store + Chromium storage)
async function factoryResetAllData() {
  try {
    console.log('FACTORY RESET: Clearing electron-store');
    try { store.clear(); } catch (e) { console.warn('Store clear failed:', e); }

    console.log('FACTORY RESET: Clearing Chromium storage');
    const { session } = require('electron');
    const defaultSession = session.defaultSession;
    if (defaultSession && typeof defaultSession.clearStorageData === 'function') {
      await defaultSession.clearStorageData({
        storages: ['appcache','cookies','filesystem','indexdb','localstorage','shadercache','websql','serviceworkers','cachestorage']
      });
    }
    console.log('FACTORY RESET: Completed');
  } catch (err) {
    console.error('FACTORY RESET error:', err);
  }
}

// Automated self-test runner (headless)
async function runSelfTest() {
  try {
    // Ensure EULA does not block tests
    try { store.set('eulaAccepted', true); } catch (_) {}

    // Create hidden window
    createMainWindow({ show: false });

    await new Promise(resolve => {
      if (!mainWindow || mainWindow.isDestroyed()) return resolve();
      mainWindow.webContents.once('did-finish-load', () => resolve());
    });

    // Give renderer a moment to attach handlers
    await new Promise(r => setTimeout(r, 150));

    // Execute checks inside the renderer
    const results = await mainWindow.webContents.executeJavaScript(`(async () => {
      const r = { domReady: false, reportModalVisible: false, reportDialogCentered: false, reportHasTotals: false, csvTriggered: false, screenerNavOk: false, sessionsSeeded: false, totalsPositive: false, monthNavWorks: false };
      try {
        r.domReady = !!document.body && !!document.querySelector('.header');
        // Seed a session for the current month so reports have content
        try {
          const now = new Date();
          const start = new Date(now.getTime() - 5 * 60 * 1000);
          const yyyy = String(now.getFullYear());
          const mm = String(now.getMonth() + 1).padStart(2, '0');
          const dd = String(now.getDate()).padStart(2, '0');
          const session = {
            id: 'selftest-' + now.getTime(),
            date: yyyy + '-' + mm + '-' + dd,
            startTime: start.toISOString(),
            endTime: now.toISOString(),
            duration: 300,
            category: 'Development',
            workLog: 'Self-test session'
          };
          const existing = JSON.parse(localStorage.getItem('loginner-sessions') || '[]');
          existing.unshift(session);
          localStorage.setItem('loginner-sessions', JSON.stringify(existing));
          r.sessionsSeeded = true;
        } catch {}
        if (typeof showReportsModal === 'function') {
          showReportsModal();
          await new Promise(res => setTimeout(res, 150));
          const overlay = document.getElementById('loginner-reports-modal');
          const dialog = overlay ? overlay.querySelector(':scope > div') : null;
          const visible = overlay && getComputedStyle(overlay).display !== 'none';
          r.reportModalVisible = !!visible;
          if (dialog) {
            const rect = dialog.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const tol = 6; // px tolerance
            r.reportDialogCentered = Math.abs(cx - window.innerWidth / 2) <= tol && Math.abs(cy - window.innerHeight / 2) <= tol;
            // Verify totals appear in report content
            r.reportHasTotals = /TOTAL\s+SESSIONS|TOTAL\s+TIME/i.test(dialog.textContent || '');
          }
          // Confirm totals numbers > 0
          try {
            const content = document.getElementById('loginner-report-content');
            const text = (content && content.textContent) || '';
            r.totalsPositive = /(TOTAL\s+SESSIONS\s*\D*([1-9]\d*)|TOTAL\s+TIME\s*\D*([1-9]\d*h|[1-9]\d*m|[1-9]\d*s))/i.test(text);
          } catch {}
          // Intercept anchor creation to detect CSV trigger
          (function() {
            const origAppend = document.body.appendChild.bind(document.body);
            let triggered = false;
            document.body.appendChild = (node) => { try { if (node && node.tagName === 'A') { triggered = true; } } catch {} return origAppend(node); };
            try { if (typeof downloadCsvReport === 'function') downloadCsvReport(); } catch {}
            r.csvTriggered = triggered;
          })();
          // Test month navigation buttons
          try {
            const label = document.getElementById('current-month-display');
            const before = label ? label.textContent : '';
            const next = document.getElementById('next-month-btn');
            if (next) { next.click(); await new Promise(res => setTimeout(res, 50)); }
            const after = label ? label.textContent : '';
            r.monthNavWorks = before !== after && !!after;
          } catch {}
        }
        // Test screener navigation
        try { if (typeof goToScreener === 'function') { goToScreener(); r.screenerNavOk = true; } } catch { r.screenerNavOk = false; }
      } catch (e) {
        r.error = String(e && e.message ? e.message : e);
      }
      return r;
    })();`);

    console.log('SELFTEST RESULTS:', JSON.stringify(results));

    // Exit after reporting
    setTimeout(() => { try { app.quit(); } catch (_) { process.exit(0); } }, 50);
  } catch (err) {
    console.error('SELFTEST FAILED:', err);
    setTimeout(() => { try { app.quit(); } catch (_) { process.exit(1); } }, 50);
  }
}

// Find a valid icon file from various possible locations
function findIconFile() {
  const possibleIconPaths = [
    path.join(__dirname, 'icons', 'Square310x310Logo.png'),
    path.join(__dirname, 'icons', 'Square284x284Logo.png'),
    path.join(__dirname, 'icons', 'Square150x150Logo.png'),
    path.join(__dirname, 'icons', '128x128@2x.png'),
    path.join(__dirname, 'icons', '128x128.png'),
    path.join(__dirname, 'icons', 'Square142x142Logo.png'),
    path.join(__dirname, 'icons', 'Square107x107Logo.png'),
    path.join(__dirname, 'icons', 'Square89x89Logo.png'),
    path.join(__dirname, 'icons', 'Square71x71Logo.png'),
    path.join(__dirname, 'icons', 'Square44x44Logo.png'),
    path.join(__dirname, 'icons', '32x32.png'),
    path.join(__dirname, 'icons', 'Square30x30Logo.png'),
    path.join(__dirname, 'icons', 'icon.png')
  ];
  
  console.log('Trying icon paths:', possibleIconPaths);
  
  for (const iconPath of possibleIconPaths) {
    if (fs.existsSync(iconPath)) {
      console.log('Found icon file at:', iconPath);
      return iconPath;
    }
  }
  
  return null;
}

// Modify clipboard monitoring to EXCLUDE adding images to history
function startClipboardMonitoring() {
  console.log('[Fixed] Starting clipboard monitoring...');
  
  if (isMonitoringActive) {
    monitoringLogCount++;
    if (monitoringLogCount % 50 === 0) {
      console.log(`[Fixed] Monitoring already active (suppressed ${monitoringLogCount} messages)`);
    }
    return;
  }

  isMonitoringActive = true;
  monitoringLogCount = 0;
  
  // Get initial clipboard content - TEXT ONLY
  try {
    lastClipboardContent = clipboard.readText() || '';
    if (lastClipboardContent.trim() !== '') {
      let history = store.get('clipboardHistory') || [];
      if (!history.includes(lastClipboardContent)) {
        history.unshift(lastClipboardContent);
        if (history.length > MAX_HISTORY_ITEMS) {
          history = history.slice(0, MAX_HISTORY_ITEMS);
        }
        store.set('clipboardHistory', history);
      }
    }
  } catch (error) {
    console.error('Error reading clipboard:', error);
    lastClipboardContent = '';
  }

  // Check clipboard every 150ms - TEXT ONLY (snappier updates)
  clipboardMonitorInterval = setInterval(() => {
    try {
      // Only monitor text content, ignore images
      const currentContent = clipboard.readText();
      if (isHugeClipboardText(currentContent)) {
        return;
      }
      
      if (currentContent && 
          currentContent !== lastClipboardContent && 
          currentContent.trim() !== '') {
        console.log('New clipboard text content detected');
        lastClipboardContent = currentContent;
        
        let history = store.get('clipboardHistory') || [];
        
        if (!history.includes(currentContent)) {
          history.unshift(currentContent);
          
          if (history.length > MAX_HISTORY_ITEMS) {
            history = history.slice(0, MAX_HISTORY_ITEMS);
          }
          
          store.set('clipboardHistory', history);
          console.log('Added to clipboard history');
          broadcastClipboardData();
        }
      }
    } catch (error) {
      console.error('Error monitoring clipboard:', error);
    }
  }, 300);
}

// Stop monitoring the clipboard
function stopClipboardMonitoring() {
  console.log('[Fixed] Stopping clipboard monitoring');
  
  if (clipboardMonitorInterval) {
    clearInterval(clipboardMonitorInterval);
    clipboardMonitorInterval = null;
  }
  
  isMonitoringActive = false;
}

function ensureProperDesktopShortcut() {
  if (process.platform !== 'win32' || !app.isPackaged) {
    return;
  }

  try {
    const desktopDir = path.join(os.homedir(), 'Desktop');
    if (!fs.existsSync(desktopDir)) {
      return;
    }

    const badNames = [
      'Tilbi.exe - Shortcut.lnk',
      'Tilbi.exe.lnk',
      'Loginner.lnk',
      'Loginner.exe - Shortcut.lnk'
    ];
    let removedBadShortcut = false;

    for (const name of badNames) {
      const badPath = path.join(desktopDir, name);
      if (fs.existsSync(badPath)) {
        fs.unlinkSync(badPath);
        removedBadShortcut = true;
      }
    }

    const goodShortcut = path.join(desktopDir, 'Tilbi.lnk');
    if (!removedBadShortcut && fs.existsSync(goodShortcut)) {
      return;
    }

    const appDir = path.dirname(process.execPath);
    const iconPath = path.join(appDir, 'icons', 'icon.ico');
    const iconArg = fs.existsSync(iconPath) ? `${iconPath},0` : `${process.execPath},0`;
    const { execFileSync } = require('child_process');
    const script = [
      '$shell = New-Object -ComObject WScript.Shell',
      `$shortcut = $shell.CreateShortcut(${JSON.stringify(goodShortcut)})`,
      `$shortcut.TargetPath = ${JSON.stringify(process.execPath)}`,
      `$shortcut.WorkingDirectory = ${JSON.stringify(appDir)}`,
      `$shortcut.IconLocation = ${JSON.stringify(iconArg)}`,
      "$shortcut.Description = 'Tilbi'",
      '$shortcut.Save()'
    ].join('; ');

    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 10000, windowsHide: true }
    );
  } catch (error) {
    console.warn('Could not normalize desktop shortcut:', error.message);
  }
}

// Register global shortcut
app.whenReady().then(() => {
  console.log('App ready, initializing...');
  logMain('App ready', { version: app.getVersion(), pid: process.pid });
  app.on('render-process-gone', (_event, webContents, details) => {
    logMain('render-process-gone', { url: webContents && webContents.getURL ? webContents.getURL() : '', details });
  });
  app.on('child-process-gone', (_event, details) => {
    logMain('child-process-gone', details);
  });
  configureAutoUpdater();
  ensureProperDesktopShortcut();
  
  // Note: Removed permission handler to avoid IPC error 263
  // Media permissions will be handled by default Electron behavior
  
  if (!store.has('clipboardHistory')) {
    store.set('clipboardHistory', []);
  }
  
  if (!store.has('pinnedItems')) {
    store.set('pinnedItems', []);
  }

  purgeStaleScreenerLoadingItems(0);

  // Keep existing history as-is (including images)
  
  // Factory reset mode: clear all persisted content then quit
  if (process.env.CM_FACTORY_RESET === '1') {
    factoryResetAllData().then(() => {
      console.log('FACTORY RESET done. Exiting.');
      setTimeout(() => { try { app.quit(); } catch (_) { process.exit(0); } }, 50);
    });
    return;
  }

  // Self-test mode: run automated checks and quit
  if (process.env.CM_SELFTEST === '1') {
    runSelfTest();
    return; // Skip normal startup
  }

  // EULA is accepted during installation – ensure flag is set once
  if (!store.get('eulaAccepted')) {
    store.set('eulaAccepted', true);
    store.set('eulaAcceptedDate', new Date().toISOString());
    store.set('eulaVersion', '1.0');
  }

  // Validate license before starting
  validateLicenseOnStartup().then(() => {
    createMainWindow();
    startClipboardMonitoring();
  }).catch(() => {
    // Still create window even if validation fails (will show subscription UI)
    createMainWindow();
    startClipboardMonitoring();
  });
  
  // Register global shortcut (Ctrl+Shift+V)
  globalShortcut.register('CommandOrControl+Shift+V', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    } else {
      createMainWindow();
    }
  });
  console.log('Global shortcut registered: Ctrl+Shift+V');
});

function deferClipboardHistoryUpdate(text) {
  setImmediate(() => {
    try {
      const history = store.get('clipboardHistory') || [];
      if (history.includes(text)) {
        return;
      }
      history.unshift(text);
      if (history.length > MAX_HISTORY_ITEMS) {
        history.splice(MAX_HISTORY_ITEMS);
      }
      store.set('clipboardHistory', history);
      broadcastClipboardData();
    } catch (_) {}
  });
}

// Handle IPC events from renderer
ipcMain.on('copy-to-clipboard', (event, text) => {
  try {
    clipboard.writeText(text);
    lastClipboardContent = text;
    console.log('Text copied to clipboard');
    deferClipboardHistoryUpdate(text);
  } catch (error) {
    console.error('Error copying text to clipboard:', error);
  }
});

// Handle clipboard item updates
ipcMain.on('update-clipboard-item', (event, { oldContent, newContent }) => {
  try {
    // Update history
    let history = store.get('clipboardHistory') || [];
    const historyIndex = history.indexOf(oldContent);
    if (historyIndex !== -1) {
      history[historyIndex] = newContent;
      store.set('clipboardHistory', history);
    }

    // Update pinned items
    let pinnedItems = store.get('pinnedItems') || [];
    const pinnedIndex = pinnedItems.indexOf(oldContent);
    if (pinnedIndex !== -1) {
      pinnedItems[pinnedIndex] = newContent;
      store.set('pinnedItems', pinnedItems);
    }

    // Update UI
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('clipboard-data', {
        history: history,
        pinned: pinnedItems,
        screener: store.get('screenerItems') || []
      });
    }

    console.log('Clipboard item updated successfully');
  } catch (error) {
    console.error('Error updating clipboard item:', error);
  }
});

// Handle pasting text content
ipcMain.on('paste-content', (event, text) => {
  try {
    console.log('Attempting to paste text');
    clipboard.writeText(text);
    lastClipboardContent = text;
    
    // Hide our window completely first
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(false);
      mainWindow.hide();
    }
    
    // Wait for window to hide
    setTimeout(() => {
      // Use multiple paste methods for better compatibility
      const { execSync } = require('child_process');
      if (process.platform === 'win32') {
        try {
          // Method 1: Focus previous window and paste
          execSync(`
            powershell -command "
              Add-Type -AssemblyName System.Windows.Forms
              # Focus the previous window
              [System.Windows.Forms.SendKeys]::SendWait('%{TAB}')
              Start-Sleep -Milliseconds 150
              # Send paste command
              [System.Windows.Forms.SendKeys]::SendWait('^v')
            "
          `.trim(), { timeout: 3000 });
          
          console.log('Enhanced paste method 1 completed');
        } catch (error) {
          console.error('Method 1 failed, trying method 2:', error);
          
          // Method 2: Alternative paste approach
          try {
            execSync(`
              powershell -command "
                $wshell = New-Object -ComObject wscript.shell
                $wshell.SendKeys('%{TAB}')
                Start-Sleep -Milliseconds 100
                $wshell.SendKeys('^v')
              "
            `.trim(), { timeout: 3000 });
            
            console.log('Enhanced paste method 2 completed');
          } catch (error2) {
            console.error('Method 2 failed, trying method 3:', error2);
            
            // Method 3: Direct SendKeys
            try {
              execSync('powershell -command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(\'^v\')"', { timeout: 3000 });
              console.log('Enhanced paste method 3 completed');
            } catch (error3) {
              console.error('All paste methods failed:', error3);
            }
          }
        }
      }
      
      // Restore window after paste
      setTimeout(() => {
        if (!isScreenshotMode && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.setAlwaysOnTop(true);
        }
      }, 200);
    }, 100);
    
  } catch (error) {
    console.error('Error in paste-content:', error);
    // Restore window state on error
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.setAlwaysOnTop(true);
    }
  }
});

// Handle pasting images
ipcMain.on('paste-image', async (event, imageData) => {
  try {
    console.log('Starting image paste process');
    
    // Clear clipboard first
    clipboard.clear();
    
    // Create native image directly from the data URL
    const image = nativeImage.createFromDataURL(imageData);
    
    if (image.isEmpty()) {
      throw new Error('Created image is empty');
    }
    
    // Write to clipboard and verify
    clipboard.writeImage(image);
    const clipboardImage = clipboard.readImage();
    if (clipboardImage.isEmpty()) {
      throw new Error('Failed to write image to clipboard');
    }
    
    // Double-check clipboard format
    const formats = clipboard.availableFormats();
    console.log('Available clipboard formats:', formats);
    if (!formats.some(format => format.startsWith('image/'))) {
      throw new Error('Image format not found in clipboard');
    }
    
    console.log('Image successfully written to clipboard, preparing to paste');
    
    // Hide our window
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(false);
      mainWindow.hide();
    }
    
    // Wait for window to hide
    await new Promise(resolve => setTimeout(resolve, 100));
    
    try {
      // Use Windows-specific method for pasting
      const { execSync } = require('child_process');
      if (process.platform === 'win32') {
        // First activate target window
        execSync(`
          powershell -command "
            Add-Type -AssemblyName System.Windows.Forms
            [System.Windows.Forms.SendKeys]::SendWait('%{TAB}')
            Start-Sleep -Milliseconds 100
          "
        `.trim());
        
        // Wait for window activation
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Send paste command using a different method
        execSync(`
          powershell -command "
            $wshell = New-Object -ComObject wscript.shell
            $wshell.SendKeys('^v')
          "
        `.trim());
        
        console.log('Paste command sent successfully');
      }
    } catch (error) {
      console.error('Error during paste operation:', error);
      // Try alternative paste method
      try {
        execSync(`
          powershell -command "
            Add-Type -AssemblyName System.Windows.Forms
            [System.Windows.Forms.SendKeys]::SendWait('^v')
          "
        `.trim());
      } catch (altError) {
        console.error('Alternative paste method also failed:', altError);
      }
    }
    
    // Wait for paste to complete
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Restore our window
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.setAlwaysOnTop(true);
    }
    
    console.log('Image paste sequence completed');
  } catch (error) {
    console.error('Error in paste-image:', error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.setAlwaysOnTop(true);
    }
  }
});

ipcMain.on('pin-item', (event, text) => {
  const pinnedItems = store.get('pinnedItems') || [];
  if (!pinnedItems.includes(text)) {
    pinnedItems.unshift(text);
    
    // Apply pinned items limit
    if (pinnedItems.length > MAX_PINNED_ITEMS) {
      pinnedItems.pop(); // Remove the oldest item
    }
    
    store.set('pinnedItems', pinnedItems);
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('clipboard-data', {
        history: store.get('clipboardHistory') || [],
        pinned: pinnedItems,
        screener: store.get('screenerItems') || []
      });
    }
  }
});

ipcMain.on('unpin-item', (event, text) => {
  let pinnedItems = store.get('pinnedItems') || [];
  pinnedItems = pinnedItems.filter(item => item !== text);
  store.set('pinnedItems', pinnedItems);
  
  // Update UI with the new pinned items list
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('clipboard-data', {
      history: store.get('clipboardHistory') || [],
      pinned: pinnedItems,
      screener: store.get('screenerItems') || []
    });
  }
});

ipcMain.on('delete-item', (event, text) => {
  // Remove from history
  let history = store.get('clipboardHistory') || [];
  history = history.filter(item => item !== text);
  store.set('clipboardHistory', history);
  
  // If pinned, make sure it's removed from there too
  let pinnedItems = store.get('pinnedItems') || [];
  if (pinnedItems.includes(text)) {
    pinnedItems = pinnedItems.filter(item => item !== text);
    store.set('pinnedItems', pinnedItems);
  }
  
  // Update UI
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('clipboard-data', {
      history: history,
      pinned: pinnedItems,
      screener: store.get('screenerItems') || []
    });
  }
});

ipcMain.on('clear-all-history', (event) => {
  store.set('clipboardHistory', []);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('clipboard-data', {
      history: [],
      pinned: store.get('pinnedItems') || [],
      screener: store.get('screenerItems') || []
    });
  }
});

ipcMain.on('clear-all-pinned', (event) => {
  store.set('pinnedItems', []);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('clipboard-data', {
      history: store.get('clipboardHistory') || [],
      pinned: [],
      screener: store.get('screenerItems') || []
    });
  }
});

ipcMain.on('move-to-screener', (event, text) => {
  let screenerItems = store.get('screenerItems') || [];
  if (!screenerItems.includes(text)) {
    screenerItems.unshift(text);
    store.set('screenerItems', screenerItems);
    
    // Update UI with the new screener items list
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('clipboard-data', {
        history: store.get('clipboardHistory') || [],
        pinned: store.get('pinnedItems') || [],
        screener: screenerItems
      });
    }
  }
});

ipcMain.on('clear-all-screener', (event) => {
  store.set('screenerItems', []);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('clipboard-data', {
      history: store.get('clipboardHistory') || [],
      pinned: store.get('pinnedItems') || [],
      screener: []
    });
  }
});

function destroySelectionWindow() {
  if (selectionWindow && !selectionWindow.isDestroyed()) {
    try { selectionWindow.removeAllListeners('closed'); } catch (_) {}
    try { selectionWindow.close(); } catch (_) {}
  }
  selectionWindow = null;
}

function cancelCaptureMode() {
  isScreenshotMode = false;
  try { globalShortcut.unregister('Escape'); } catch (_) {}
  destroySelectionWindow();
  restoreMainAfterCapture();
}

function bindSelectionWindowLifecycle(win) {
  if (!win || win.isDestroyed()) return;
  win.on('closed', () => {
    selectionWindow = null;
    isScreenshotMode = false;
    restoreMainAfterCapture();
  });
}

// Screenshot functionality (camera icon + taskbar restore quick action)
function openSelectionOverlay() {
  if (selectionWindow && !selectionWindow.isDestroyed()) {
    destroySelectionWindow();
  }
  try {
    logMain('Opening capture overlay', getCaptureWindowBounds());
    selectionWindow = createCaptureBrowserWindow();
    bindSelectionWindowLifecycle(selectionWindow);
    selectionWindow.loadFile(path.join(__dirname, 'selection-overlay.html'));
    selectionWindow.once('ready-to-show', () => {
      if (selectionWindow && !selectionWindow.isDestroyed()) {
        selectionWindow.show();
        selectionWindow.focus();
      }
    });
    selectionWindow.webContents.on('render-process-gone', (_event, details) => {
      logMain('Capture overlay renderer gone', details);
      cancelCaptureMode();
    });
  } catch (error) {
    logMain('Error opening selection overlay', error);
    cancelCaptureMode();
  }
}

async function startScreenshotCapture() {
  if (isScreenshotMode) {
    console.log('Screenshot capture already active - refocusing overlay');
    openSelectionOverlay();
    return;
  }
  console.log('Starting screenshot capture');
  try {
    hideMainForCapture();
    isScreenshotMode = true;
    openSelectionOverlay();
    try {
      globalShortcut.unregister('Escape');
      globalShortcut.register('Escape', () => {
        if (isScreenshotMode) cancelCaptureMode();
      });
    } catch (err) {
      console.warn('Could not register Escape shortcut for capture cancel:', err);
    }
  } catch (error) {
    console.error('Error starting area selection:', error);
    isScreenshotMode = false;
    restoreMainAfterCapture();
  }
}

ipcMain.on('take-screenshot', () => {
  console.log('IPC: take-screenshot received');
  startScreenshotCapture();
});

// Handle the selected area capture
ipcMain.on('capture-selected-area', async (event, bounds) => {
  try {
    if (selectionWindow) {
      selectionWindow.hide();
    }

    await new Promise(resolve => setTimeout(resolve, 100));

    const { screenshot, cropRect } = await captureScreenThumbnailForBounds(bounds);
    let croppedImage = screenshot.crop(cropRect);

    if (croppedImage && !croppedImage.isEmpty()) {
      // If a circular selection was requested, apply a circle mask
      if (bounds && bounds.shape === 'circle' && bounds.circle && typeof bounds.circle.r === 'number') {
        console.log('Applying circle mask:', bounds.circle);
        try {
          const targetDisplay = getDisplayForCaptureBounds(bounds);
          const scaleX = targetDisplay.size.width / targetDisplay.bounds.width;
          const scaleY = targetDisplay.size.height / targetDisplay.bounds.height;
          const localCenterX = Math.round((bounds.circle.cx - bounds.x) * scaleX);
          const localCenterY = Math.round((bounds.circle.cy - bounds.y) * scaleY);
          const radius = Math.max(1, Math.round(bounds.circle.r * Math.min(scaleX, scaleY)));

          console.log(`Circle params: center(${localCenterX}, ${localCenterY}), radius=${radius}, crop=${cropRect.width}x${cropRect.height}`);

          const w = cropRect.width;
          const h = cropRect.height;
          const bmp = Buffer.from(croppedImage.toBitmap()); // This returns BGRA
          const r2 = radius * radius;
          
          let pixelsChanged = 0;
          for (let y = 0; y < h; y++) {
            const dy = y - localCenterY;
            for (let x = 0; x < w; x++) {
              const dx = x - localCenterX;
              const distanceSquared = dx * dx + dy * dy;
              const idx = (y * w + x) * 4;
              
              if (distanceSquared > r2) {
                // Outside circle -> make transparent (BGRA format)
                bmp[idx + 0] = 0; // B
                bmp[idx + 1] = 0; // G  
                bmp[idx + 2] = 0; // R
                bmp[idx + 3] = 0; // A (transparent)
                pixelsChanged++;
              }
            }
          }
          
          console.log(`Circle mask applied: ${pixelsChanged} pixels made transparent`);
          croppedImage = nativeImage.createFromBitmap(bmp, { width: w, height: h });
        } catch (maskErr) {
          console.error('Circle masking failed:', maskErr);
        }
      } else {
        console.log('No circle mask requested, bounds:', bounds);
      }

      croppedImage = scaleCaptureForReadableSave(croppedImage);

      // Generate filename and full path
      const filename = generateScreenshotFilename();
      const filepath = path.join(userScreenshotsPath, filename);
      
      try {
        // Save the image to disk - force PNG with alpha channel
        const pngBuffer = croppedImage.toPNG();
        fs.writeFileSync(filepath, pngBuffer);
        console.log('Screenshot saved to:', filepath);
        
        // Debug: Check if PNG has transparency
        const hasAlpha = pngBuffer.length > 0 && pngBuffer[25] === 6; // PNG color type 6 = RGBA
        console.log('PNG has alpha channel:', hasAlpha);
        
        // Create screenshot entry with file info
        const screenshotEntry = {
          path: filepath,
          timestamp: Date.now(),
          shape: bounds && bounds.shape ? bounds.shape : 'rect',
          circle: bounds && bounds.circle ? bounds.circle : undefined
        };
        
        // Update screener items
        let screenerItems = store.get('screenerItems') || [];
        screenerItems.unshift(screenshotEntry);
        
        // Apply screener items limit
        if (screenerItems.length > MAX_SCREENER_ITEMS) {
          screenerItems = screenerItems.slice(0, MAX_SCREENER_ITEMS);
        }
        
        store.set('screenerItems', screenerItems.map(stripInlineMediaFromScreenerItem));
        
        // Copy to clipboard
        clipboard.writeImage(croppedImage);
        
        if (selectionWindow) {
          selectionWindow.close();
          selectionWindow = null;
        }
        isScreenshotMode = false;
        restoreMainAfterCapture();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('clipboard-data', {
            history: store.get('clipboardHistory') || [],
            pinned: store.get('pinnedItems') || [],
            screener: screenerItems.map(stripInlineMediaFromScreenerItem)
          });
          mainWindow.webContents.send('switch-to-screener');
        }
      } catch (error) {
        console.error('Error saving or processing screenshot:', error);
        isScreenshotMode = false;
        if (selectionWindow) {
          selectionWindow.close();
          selectionWindow = null;
        }
        restoreMainAfterCapture();
      }
    } else {
      throw new Error('Captured image was empty');
    }
  } catch (error) {
    console.error('Error capturing selected area:', error);
    isScreenshotMode = false;
    if (selectionWindow) {
      selectionWindow.close();
      selectionWindow = null;
    }
    restoreMainAfterCapture();
  }
});

// Handle selection cancellation
ipcMain.on('cancel-selection', () => {
  cancelCaptureMode();
});

ipcMain.on('dismiss-screener-loading', (event, payload) => {
  const id = payload && payload.id ? payload.id : null;
  removeScreenerLoadingById(id);
});

// Handle full webpage capture
ipcMain.on('capture-full-webpage', async (event, urlInput) => {
  let webpageWindow = null;
  let placeholderId = null;
  let captureWatchdog = null;
  const clearCaptureWatchdog = () => {
    if (captureWatchdog) {
      clearTimeout(captureWatchdog);
      captureWatchdog = null;
    }
  };
  const failCapture = (message) => {
    clearCaptureWatchdog();
    const friendly = message || WEBPAGE_CAPTURE_SORRY_MSG;
    replaceScreenerLoadingWithError(placeholderId, friendly);
    isScreenshotMode = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('webpage-capture-failed', { message: friendly });
      mainWindow.webContents.send('switch-to-screener');
      restoreMainAfterCapture();
    }
  };
  try {
    console.log('Starting full webpage capture for:', urlInput);
    
    // Normalize payload (supports string or { url, interactive })
    let interactive = false;
    let hiRes = false;
    let url = null;
    
    // Extract URL and interactive flag from input
    if (urlInput && typeof urlInput === 'object' && !Array.isArray(urlInput) && urlInput !== null) {
      // Input is an object with { url, interactive }
      interactive = !!urlInput.interactive;
      hiRes = !!urlInput.hiRes;
      url = urlInput.url;
    } else if (typeof urlInput === 'string') {
      // Input is a string
      url = urlInput;
    } else {
      // Invalid input type, will try clipboard
      url = null;
    }
    
    // Convert to string if not already, and handle empty/undefined
    if (url != null && typeof url !== 'string') {
      url = String(url);
    }
    if (url != null && typeof url === 'string') {
      url = url.trim();
    }
    
    // Get URL from clipboard if needed
    if (!url || url === '' || url === 'clipboard') {
      url = clipboard.readText();
      if (url && typeof url === 'string') {
        url = url.trim();
        console.log('Got URL from clipboard:', url);
      } else {
        url = '';
      }
    }
    
    // Final validation
    if (!url || url === '') {
      throw new Error('No URL provided. Please copy a URL to your clipboard or enter one in the dialog.');
    }
    
    // Add https:// if no protocol specified
    if (!url.match(/^https?:\/\//i)) {
      url = 'https://' + url;
    }
    
    console.log('Loading webpage:', url);

    isScreenshotMode = true;
    if (selectionWindow) {
      selectionWindow.close();
      selectionWindow = null;
    }
    hideMainForCapture();

    placeholderId = addScreenerLoadingPlaceholder(
      url,
      interactive ? 'Log in, then capture the page' : 'Capturing webpage...'
    );
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(true);
      mainWindow.show();
      mainWindow.focus();
      broadcastClipboardData();
      mainWindow.webContents.send('switch-to-screener');
    }

    // Helper that performs the actual full-page capture for a given window
    const performFullPageCapture = async (targetWindow, targetUrl) => {
      console.log('Capturing full webpage...');
      let image = await captureWebpageImage(targetWindow, hiRes);
      if (!isValidCaptureImage(image)) {
        throw new Error(WEBPAGE_CAPTURE_SORRY_MSG);
      }

      image = scaleCaptureForReadableSave(image);
      
      console.log('✓ Webpage captured successfully');
      
      // Generate filename and save
      const filename = generateScreenshotFilename().replace('Screenshot', 'Webpage');
      const filepath = path.join(userScreenshotsPath, filename);
      const pngBuffer = image.toPNG();
      await fs.promises.writeFile(filepath, pngBuffer);
      
      console.log('✓ Saved to:', filepath);
      
      // Create screenshot entry
      const screenshotEntry = {
        path: filepath,
        timestamp: Date.now(),
        shape: 'webpage',
        url: targetUrl
      };
      
      // Do not push large image data URLs into text history to keep app responsive
      
      // Update screener items (replace placeholder if present)
      let screenerItems = store.get('screenerItems') || [];
      const idx = screenerItems.findIndex(it => typeof it === 'object' && it && it.id === placeholderId);
      if (idx >= 0) {
        screenerItems[idx] = screenshotEntry;
      } else {
        screenerItems.unshift(screenshotEntry);
      }
      
      if (screenerItems.length > MAX_SCREENER_ITEMS) {
        screenerItems = screenerItems.slice(0, MAX_SCREENER_ITEMS);
      }
      
      store.set('screenerItems', screenerItems);

      // Ensure History does not contain image data URLs (keep images only in Screener)
      try {
        let historyClean = store.get('clipboardHistory') || [];
        if (Array.isArray(historyClean)) {
          const beforeLen = historyClean.length;
          historyClean = historyClean.filter(item => typeof item === 'string' && !item.startsWith('data:image/'));
          if (historyClean.length !== beforeLen) {
            store.set('clipboardHistory', historyClean);
          }
        }
      } catch (_) {}
      console.log('✓ Added to screener. Total items:', screenerItems.length);
      
      // Copy to clipboard
      clipboard.writeImage(image);
      console.log('✓ Copied to clipboard');
      
      // Restore main window UI
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setAlwaysOnTop(true);
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send('clipboard-data', {
          history: store.get('clipboardHistory') || [],
          pinned: store.get('pinnedItems') || [],
          screener: screenerItems
        });
        mainWindow.webContents.send('switch-to-screener');
        console.log('✓ UI updated and switched to screener tab');
      }
      clearCaptureWatchdog();
      isScreenshotMode = false;
    };

    if (interactive) {
      // Visible window so the user can log in
      // Enable nodeIntegration for this window to allow button communication
      webpageWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        show: true,
        icon: path.join(__dirname, 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
        frame: false,
        titleBarStyle: 'hidden',
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false,
          webSecurity: true,
          offscreen: false
        }
      });

      // Branding
      try { app.setAppUserModelId('com.tilbi.app'); } catch (_) {}
      webpageWindow.setTitle('Tilbi Capture');

      // Helper to safely bring back main window
      const showMainWindow = () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          try {
            mainWindow.setAlwaysOnTop(true);
            mainWindow.show();
            mainWindow.focus();
          } catch (_) {}
        }
      };

      // Helper function to trigger capture
      const triggerCapture = async () => {
        try {
          console.log('Capture triggered');
          // Unregister the shortcut to prevent multiple captures
          globalShortcut.unregister('CommandOrControl+Shift+S');
          await performFullPageCapture(webpageWindow, url);
          // Close the webpage window after successful capture
          if (webpageWindow && !webpageWindow.isDestroyed()) {
            webpageWindow.close();
          }
        } catch (err) {
          console.error('Interactive capture failed:', err);
          globalShortcut.unregister('CommandOrControl+Shift+S');
          failCapture(WEBPAGE_CAPTURE_SORRY_MSG);
          if (webpageWindow && !webpageWindow.isDestroyed()) {
            webpageWindow.close();
          }
        } finally {
          showMainWindow();
        }
      };

      // Register global shortcut for capture (Ctrl+Shift+S)
      try {
        globalShortcut.unregister('CommandOrControl+Shift+S');
      } catch (_) {}
      const shortcutRegistered = globalShortcut.register('CommandOrControl+Shift+S', triggerCapture);

      if (!shortcutRegistered) {
        console.warn('Failed to register Ctrl+Shift+S shortcut, it may already be in use');
      }

      // Register IPC handler for capture button click
      const captureHandler = async () => {
        triggerCapture();
      };
      ipcMain.once('capture-from-webpage', captureHandler);

      // Register IPC handler for close button
      const closeHandler = async () => {
        clearCaptureWatchdog();
        removeScreenerLoadingById(placeholderId);
        isScreenshotMode = false;
        cleanupInteractive();
        if (webpageWindow && !webpageWindow.isDestroyed()) {
          webpageWindow.close();
        }
        restoreMainAfterCapture();
      };
      ipcMain.once('close-interactive-capture', closeHandler);

      // Clean up when window closes (handled in cleanupInteractive too)
      captureWatchdog = setTimeout(() => {
        failCapture(WEBPAGE_CAPTURE_SORRY_MSG);
        if (webpageWindow && !webpageWindow.isDestroyed()) {
          try { webpageWindow.close(); } catch (_) {}
        }
      }, 600000);

      webpageWindow.on('closed', () => {
        clearCaptureWatchdog();
        removeScreenerLoadingById(placeholderId);
        isScreenshotMode = false;
        cleanupInteractive();
        restoreMainAfterCapture();
        console.log('Webpage window closed, cleaned up');
      });

      // Load the page and inject capture button
      console.log('Loading URL (interactive)...');
      await webpageWindow.loadURL(url, { timeout: 30000 });

      // Function to inject capture button (will be called after page loads)
      const injectCaptureButton = async () => {
        try {
          try {
            await webpageWindow.webContents.executeJavaScript(PREPARE_PAGE_FOR_CAPTURE_JS);
          } catch (_) {}
          await webpageWindow.webContents.executeJavaScript(`
            (function() {
              // Remove existing button if present
              const existing = document.getElementById('tilbi-capture-btn');
              if (existing) existing.remove();
              
              const btn = document.createElement('div');
              btn.id = 'tilbi-capture-btn';
              btn.innerHTML = '📷 Capture Page';
              btn.style.cssText = \`
                position: fixed;
                top: 20px;
                right: 20px;
                background: #4a86e8;
                color: white;
                padding: 12px 20px;
                border-radius: 8px;
                cursor: pointer;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                font-size: 14px;
                font-weight: 600;
                box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                z-index: 999999;
                user-select: none;
                transition: background 0.2s;
                pointer-events: auto;
              \`;
              
              btn.addEventListener('mouseenter', () => {
                btn.style.background = '#3a76d8';
              });
              
              btn.addEventListener('mouseleave', () => {
                btn.style.background = '#4a86e8';
              });
              
              btn.addEventListener('click', () => {
                btn.innerHTML = '⏳ Capturing...';
                btn.style.background = '#888';
                btn.style.cursor = 'wait';
                btn.style.pointerEvents = 'none';
                // Use IPC to trigger capture
                const { ipcRenderer } = require('electron');
                ipcRenderer.send('capture-from-webpage');
              });
              
              document.body.appendChild(btn);
              console.log('Tilbi capture button injected');
            })();
          `);
        } catch (err) {
          console.error('Failed to inject capture button:', err);
        }
      };

      // Inject button after page loads
      webpageWindow.webContents.on('did-finish-load', async () => {
        // Wait a bit for page to fully render
        setTimeout(() => {
          injectCaptureButton();
        }, 1000);
      });

      // Also inject on navigation
      webpageWindow.webContents.on('did-navigate', () => {
        setTimeout(() => {
          injectCaptureButton();
        }, 1000);
      });

      // Native overlay button (always-on-top) in case DOM injection is blocked
      let overlayWindow = null;
      const overlaySize = { width: 260, height: 52 };
      const positionOverlay = () => {
        if (!webpageWindow || webpageWindow.isDestroyed() || !overlayWindow || overlayWindow.isDestroyed()) return;
        const parentBounds = webpageWindow.getBounds();
        const x = Math.max(parentBounds.x + parentBounds.width - overlaySize.width - 20, parentBounds.x);
        const y = Math.max(parentBounds.y + 20, parentBounds.y);
        overlayWindow.setBounds({ x, y, width: overlaySize.width, height: overlaySize.height });
      };

      const ensureOverlay = () => {
        if (overlayWindow && !overlayWindow.isDestroyed()) return;
        // Create as independent always-on-top window (not a child) so it can't be hidden by site or parent Z-order
        overlayWindow = new BrowserWindow({
          width: overlaySize.width,
          height: overlaySize.height,
          frame: false,
          transparent: true,
          resizable: false,
          movable: false,
          skipTaskbar: true,
          alwaysOnTop: true,
          focusable: true,
          show: false,
          hasShadow: false,
          icon: path.join(__dirname, 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
          webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: false
          }
        });
        const html = `<!doctype html><html><head><meta charset=\"utf-8\"><style>
          body{ margin:0; }
          #bar{ position:fixed; inset:0; display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 8px; pointer-events:none; }
          .left{ display:flex; align-items:center; gap:8px; color:#fff; background:#222a; padding:6px 10px; border-radius:10px; font:600 13px -apple-system,Segoe UI,Roboto,sans-serif; }
          .logo{ width:16px; height:16px; border-radius:4px; background:#4a86e8; display:inline-block }
          .title{ white-space:nowrap }
          .right{ display:flex; align-items:center; gap:6px }
          button{ pointer-events:auto; background:#4a86e8; color:#fff; border:none; border-radius:10px; padding:8px 12px; font:600 13px -apple-system,Segoe UI,Roboto,sans-serif; box-shadow:0 4px 12px rgba(0,0,0,.25); cursor:pointer }
          button:hover{ background:#3a76d8 }
          .close{ background:#e85b4a }
          .close:hover{ background:#d84b3a }
        </style></head><body>
          <div id=\"bar\">
            <div class=\"left\"><span class=\"logo\"></span><span class=\"title\">Tilbi Capture</span></div>
            <div class=\"right\">
              <button id=\"cap\">📷 Capture Page</button>
              <button id=\"close\" class=\"close\">✕</button>
            </div>
          </div>
          <script>const {ipcRenderer}=require('electron');
          document.getElementById('cap').addEventListener('click',()=>{ ipcRenderer.send('capture-from-webpage'); });
          document.getElementById('close').addEventListener('click',()=>{ ipcRenderer.send('close-interactive-capture'); });
          </script>
        </body></html>`;
        overlayWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
        overlayWindow.setAlwaysOnTop(true, 'screen-saver');
        overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        try { overlayWindow.setIgnoreMouseEvents(false); } catch(_) {}
        overlayWindow.once('ready-to-show', () => {
          positionOverlay();
          overlayWindow.showInactive();
        });
      };

      ensureOverlay();
      webpageWindow.on('move', () => { try { positionOverlay(); } catch(_) {} });
      webpageWindow.on('resize', () => { try { positionOverlay(); } catch(_) {} });
      webpageWindow.on('focus', () => { try { positionOverlay(); } catch(_) {} });
      const cleanupInteractive = () => {
        try { globalShortcut.unregister('CommandOrControl+Shift+S'); } catch (_) {}
        try { ipcMain.removeListener('capture-from-webpage', captureHandler); } catch (_) {}
        try { ipcMain.removeListener('close-interactive-capture', closeHandler); } catch (_) {}
        try { if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close(); } catch (_) {}
        overlayWindow = null;
      };

      // ESC to cancel interactive capture cleanly
      webpageWindow.webContents.on('before-input-event', (event, input) => {
        try {
          if (input.key === 'Escape') {
            event.preventDefault();
            clearCaptureWatchdog();
            removeScreenerLoadingById(placeholderId);
            isScreenshotMode = false;
            cleanupInteractive();
            if (webpageWindow && !webpageWindow.isDestroyed()) {
              webpageWindow.close();
            }
            restoreMainAfterCapture();
          }
        } catch (_) {}
      });

      // Do not auto-capture; wait for user action
      return;
    }

    captureWatchdog = setTimeout(() => {
      console.warn('Webpage capture timed out');
      failCapture(WEBPAGE_CAPTURE_SORRY_MSG);
      if (webpageWindow && !webpageWindow.isDestroyed()) {
        try { webpageWindow.close(); } catch (_) {}
      }
    }, WEBPAGE_CAPTURE_TIMEOUT_MS);

    // Non-interactive: hidden offscreen window
    webpageWindow = new BrowserWindow({
      width: 1440,
      height: 900,
      show: false,
      paintWhenInitiallyHidden: true,
      skipTaskbar: true,
      icon: path.join(__dirname, 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        backgroundThrottling: false,
        offscreen: false
      }
    });

    // Load the webpage
    console.log('Loading URL...');
    await webpageWindow.loadURL(url, { timeout: 30000 });
    await new Promise((resolve) => {
      const wc = webpageWindow.webContents;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const onStop = () => setTimeout(finish, 500);
      wc.once('did-stop-loading', onStop);
      setTimeout(finish, 4000);
    });

    await Promise.race([
      performFullPageCapture(webpageWindow, url),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(WEBPAGE_CAPTURE_SORRY_MSG)), WEBPAGE_CAPTURE_TIMEOUT_MS);
      })
    ]);

    if (webpageWindow && !webpageWindow.isDestroyed()) {
      webpageWindow.close();
      webpageWindow = null;
    }
    
  } catch (error) {
    console.error('Error capturing full webpage:', error);
    const msg = (error && error.message && error.message.includes('Sorry'))
      ? error.message
      : WEBPAGE_CAPTURE_SORRY_MSG;
    failCapture(msg);
    if (webpageWindow && !webpageWindow.isDestroyed()) {
      webpageWindow.close();
    }
  }
});

ipcMain.on('start-video-recording', async (event) => {
  console.log('IPC: start-video-recording received');
  try {
    // Hide main window immediately for video recording
    if (mainWindow && !mainWindow.isDestroyed()) {
      console.log('Hiding main window for video recording');
      mainWindow.hide();
      console.log('Main window hidden successfully');
    }
    
    // Set video recording mode flag
    isScreenshotMode = true; // Reuse the same flag for video recording
    console.log('Video recording mode enabled');
    
    // Create (or reuse) the small controls window immediately so it is visible during selection
    try {
      if (global.videoWindow && !global.videoWindow.isDestroyed()) {
        // Reuse existing
        global.videoWindow.show();
        global.videoWindow.focus();
      } else {
        const primaryDisplay = screen.getPrimaryDisplay();
        const startX = Math.max(10, primaryDisplay.bounds.x + 20);
        const startY = Math.max(10, primaryDisplay.bounds.y + 20);
        const vw = new BrowserWindow({
          x: startX,
          y: startY,
          width: 1,
          height: 1,
          useContentSize: true,
          resizable: false,
          frame: false,
          skipTaskbar: true,
          alwaysOnTop: true,
          transparent: true,
          hasShadow: true,
          backgroundColor: '#00000000',
          show: true,
          webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webSecurity: false,
            allowRunningInsecureContent: true,
            experimentalFeatures: true
          }
        });
        global.videoWindow = vw;
        vw.loadFile(path.join(__dirname, 'video-overlay.html'));
        vw.show();
        vw.focus();
      }
      // Let overlay size itself
      mainWindow.webContents.send('switch-to-screener');
    } catch (_) {}

    if (selectionWindow && !selectionWindow.isDestroyed()) {
      try { selectionWindow.close(); } catch (_) {}
      selectionWindow = null;
    }

    selectionWindow = createCaptureBrowserWindow();
    bindSelectionWindowLifecycle(selectionWindow);

    // Main window should already be hidden
    // Just ensure it stays hidden
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      console.log('Ensuring main window is hidden for video recording');
      mainWindow.hide();
    }

    // Load the selection overlay for video recording
    selectionWindow.loadFile(path.join(__dirname, 'video-selection-overlay.html'));

    // Show the window after a short delay to ensure it's ready
    setTimeout(() => {
      selectionWindow.show();
      selectionWindow.focus();
    }, 50);
  } catch (error) {
    console.error('Error starting video recording:', error);
    // Reset video recording mode flag
    isScreenshotMode = false;
    // Restore main window on error
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(true);
      mainWindow.show();
      mainWindow.focus();
    }
  }
});

// Handle video recording save
ipcMain.on('save-video-recording', async (event, { videoData, videoSegments, duration, thumbnailPng }) => {
  try {
    // Insert loading placeholder in Screener while processing video
    const videoPlaceholderId = `video-loading-${Date.now()}`;
    try {
      let sItems = store.get('screenerItems') || [];
      sItems.unshift({ id: videoPlaceholderId, type: 'loading', timestamp: Date.now(), message: 'Processing video...' });
      store.set('screenerItems', sItems);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('clipboard-data', {
          history: store.get('clipboardHistory') || [],
          pinned: store.get('pinnedItems') || [],
          screener: sItems
        });
        mainWindow.webContents.send('switch-to-screener');
      }
    } catch (_) {}

    // Generate filename for video
    const date = new Date();
    const timestamp = date.toISOString().replace(/[:.]/g, '-').replace('T', '_').split('.')[0];
    const filename = `ScreenRecording_${timestamp}.webm`;
    const filepath = path.join(userScreenshotsPath, filename);
    
    // Handle multiple segments or single video
    if (videoSegments && Array.isArray(videoSegments) && videoSegments.length > 1) {
      // Multiple segments - need to concatenate with FFmpeg
      const { exec } = require('child_process');
      const segmentFiles = [];
      
      // Save each segment temporarily
      for (let i = 0; i < videoSegments.length; i++) {
        const segmentBase64 = videoSegments[i].replace(/^data:video\/webm;base64,/, '');
        const segmentBuffer = Buffer.from(segmentBase64, 'base64');
        const segmentPath = path.join(userScreenshotsPath, `temp_segment_${i}_${timestamp}.webm`);
        fs.writeFileSync(segmentPath, segmentBuffer);
        segmentFiles.push(segmentPath);
      }
      
      // Create concat file list
      const concatListPath = path.join(userScreenshotsPath, `concat_${timestamp}.txt`);
      const concatList = segmentFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n');
      fs.writeFileSync(concatListPath, concatList);
      
      // Concatenate with FFmpeg
      await new Promise((resolve, reject) => {
        exec(`ffmpeg -f concat -safe 0 -i "${concatListPath}" -c copy "${filepath}"`, (error, stdout, stderr) => {
          // Clean up temp files
          segmentFiles.forEach(f => {
            try { fs.unlinkSync(f); } catch (_) {}
          });
          try { fs.unlinkSync(concatListPath); } catch (_) {}
          
          if (error) {
            console.error('FFmpeg concatenation failed:', error);
            // Fallback: use first segment
            const firstSegmentBase64 = videoSegments[0].replace(/^data:video\/webm;base64,/, '');
            const firstBuffer = Buffer.from(firstSegmentBase64, 'base64');
            fs.writeFileSync(filepath, firstBuffer);
          }
          resolve();
        });
      });
    } else {
      // Single segment or old format
      const base64Data = (videoSegments && videoSegments.length === 1) 
        ? videoSegments[0].replace(/^data:video\/webm;base64,/, '')
        : (videoData || '').replace(/^data:video\/webm;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      fs.writeFileSync(filepath, buffer);
    }
    
    console.log('Video recording saved to:', filepath);
    
    // Create video entry for screener
    const videoEntry = {
      path: filepath,
      type: 'video',
      duration: duration,
      timestamp: Date.now(),
      thumbnail: null // Will be generated if ffmpeg is available
    };
    
    // Save real PNG thumbnail if provided
    try {
      if (thumbnailPng && thumbnailPng.startsWith('data:image/png;base64,')) {
        const thumbnailPath = path.join(userScreenshotsPath, `thumb_${timestamp}.png`);
        const pngBase64 = thumbnailPng.replace(/^data:image\/png;base64,/, '');
        fs.writeFileSync(thumbnailPath, Buffer.from(pngBase64, 'base64'));
        // Store both raw path and normalized file URL
        videoEntry.thumbnail = thumbnailPath;
        videoEntry.thumbnailFileUrl = `file:///${thumbnailPath.replace(/\\/g, '/')}`;
        videoEntry.thumbnailDataUrl = thumbnailPng; // fallback
        console.log('PNG thumbnail saved:', thumbnailPath);
      }
    } catch (error) {
      console.log('PNG thumbnail save failed:', error);
    }
    
    // Update screener items (replace loading placeholder if present)
    let screenerItems = store.get('screenerItems') || [];
    const pIdx = screenerItems.findIndex(it => typeof it === 'object' && it && it.id === videoPlaceholderId);
    if (pIdx >= 0) screenerItems[pIdx] = videoEntry; else screenerItems.unshift(videoEntry);
    
    // Apply screener items limit
    if (screenerItems.length > MAX_SCREENER_ITEMS) {
      screenerItems = screenerItems.slice(0, MAX_SCREENER_ITEMS);
    }
    
    store.set('screenerItems', screenerItems);
    
    // Close video window
    if (global.videoWindow) {
      global.videoWindow.close();
      global.videoWindow = null;
    }
    
    // Close selection window when recording is saved
    if (selectionWindow) {
      selectionWindow.close();
      selectionWindow = null;
    }
    
    // Reset video recording mode flag
    isScreenshotMode = false;
    
    // Restore main window
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(true);
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('clipboard-data', {
        history: store.get('clipboardHistory') || [],
        pinned: store.get('pinnedItems') || [],
        screener: screenerItems,
        navigateTo: 'screener'
      });
      setTimeout(() => {
        try { mainWindow.webContents.send('switch-to-screener'); } catch (_) {}
      }, 50);
    }
    
  } catch (error) {
    console.error('Error saving video recording:', error);
    // Remove loading placeholder if still present
    try {
      let sItems = store.get('screenerItems') || [];
      const filtered = sItems.filter(it => !(typeof it === 'object' && it && it.type === 'loading'));
      if (filtered.length !== sItems.length) {
        store.set('screenerItems', filtered);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('clipboard-data', {
            history: store.get('clipboardHistory') || [],
            pinned: store.get('pinnedItems') || [],
            screener: filtered
          });
        }
      }
    } catch (_) {}
    // Reset video recording mode flag
    isScreenshotMode = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(true);
      mainWindow.show();
      mainWindow.focus();
    }
    if (global.videoWindow) {
      global.videoWindow.close();
      global.videoWindow = null;
    }
    // Close selection window when recording is saved
    if (selectionWindow) {
      selectionWindow.close();
      selectionWindow = null;
    }
  }
});

// Handle video recording cancellation
ipcMain.on('cancel-video-recording', () => {
  // Reset video recording mode flag
  isScreenshotMode = false;
  
  if (global.videoWindow) {
    global.videoWindow.close();
    global.videoWindow = null;
  }
  
  // Close selection window when recording is cancelled
  if (selectionWindow) {
    selectionWindow.close();
    selectionWindow = null;
  }
  
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(true);
    mainWindow.show();
    mainWindow.focus();
  }
});

// Handle video area selection
ipcMain.on('start-video-recording-area', async (event, bounds) => {
  try {
    // Keep selection window visible but disable interaction
    if (selectionWindow) {
      selectionWindow.webContents.send('lock-selection', bounds);
      selectionWindow.setIgnoreMouseEvents(true);
    }

    await new Promise(resolve => setTimeout(resolve, 50));

    // Create video recording window positioned outside the selected area
    // Position controls above or below the selection area
    let controlX, controlY;
    if (bounds.y > 100) {
      // Position above the selection
      controlX = bounds.x;
      controlY = bounds.y - 80;
    } else {
      // Position below the selection
      controlX = bounds.x;
      controlY = bounds.y + bounds.height + 10;
    }

    if (global.videoWindow && !global.videoWindow.isDestroyed()) {
      try { global.videoWindow.close(); } catch (_) {}
      global.videoWindow = null;
    }

    const videoWindow = new BrowserWindow({
      x: controlX,
      y: controlY,
      width: 1,
      height: 1,
      useContentSize: true,
      resizable: false,
      frame: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      transparent: true,
      hasShadow: true,
      backgroundColor: '#00000000',
      show: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        webSecurity: false,
        allowRunningInsecureContent: true,
        experimentalFeatures: true
      }
    });

    // Ensure the controls window sits above the selection overlay
    try {
      if (selectionWindow && !selectionWindow.isDestroyed()) {
        // Keep the selection frame visible for the entire recording
        selectionWindow.setAlwaysOnTop(true, 'screen-saver');
        selectionWindow.show();
      }
      // Ensure the controls window is also on a top level
      videoWindow.setAlwaysOnTop(true, 'screen-saver');
      // Re-raise the selection overlay (it's click-through) so the outline stays visible
      if (selectionWindow && !selectionWindow.isDestroyed()) {
        selectionWindow.setAlwaysOnTop(true, 'screen-saver');
      }
    } catch (_) {}

    // Persist and restore position
    try {
      const savedPos = store.get('videoWindowPosition');
      if (savedPos && typeof savedPos.x === 'number' && typeof savedPos.y === 'number') {
        videoWindow.setPosition(Math.floor(savedPos.x), Math.floor(savedPos.y));
      }
    } catch (_) {}

    videoWindow.on('move', () => {
      try {
        const [winX, winY] = videoWindow.getPosition();
        store.set('videoWindowPosition', { x: winX, y: winY });
      } catch (_) {}
    });

    // Store reference to video window
    global.videoWindow = videoWindow;

    // Load the video recording interface
    videoWindow.loadFile(path.join(__dirname, 'video-overlay.html'));

    // Show the window
    videoWindow.show();
    videoWindow.focus();

    // Store the bounds for the recording
    global.videoBounds = bounds;

  } catch (error) {
    console.error('Error starting video recording for area:', error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(true);
      mainWindow.show();
      mainWindow.focus();
    }
    if (selectionWindow) {
      selectionWindow.close();
      selectionWindow = null;
    }
  }
});

// Handle video selection cancellation
ipcMain.on('cancel-video-selection', () => {
  if (selectionWindow) {
    selectionWindow.close();
    selectionWindow = null;
  }
  
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(true);
    mainWindow.show();
    mainWindow.focus();
  }
});


// Force close selection window
ipcMain.on('force-close-selection-window', () => {
  if (selectionWindow) {
    selectionWindow.close();
    selectionWindow = null;
  }
});

// Hide the video overlay and show main window while saving completes
ipcMain.on('hide-video-window', () => {
  try {
    if (global.videoWindow && !global.videoWindow.isDestroyed()) {
      global.videoWindow.hide();
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  } catch (_) {}
});

// Handle stop recording from selection window
ipcMain.on('stop-video-from-selection', () => {
  if (global.videoWindow && !global.videoWindow.isDestroyed()) {
    global.videoWindow.webContents.send('stop-recording-command');
  }
});

// Handle getting video bounds
// Open Studio Desktop app directly (prevent multiple instances)
let studioDesktopRunning = false;
ipcMain.handle('open-loginner-window', () => {
  if (studioDesktopRunning) {
    console.log('⚠️ Studio Desktop already running, skipping launch');
    return { success: true, message: 'Studio Desktop already running' };
  }

  const { spawn } = require('child_process');
  const studioExePath = path.join(__dirname, 'flower-desktop-standalone', 'Flower Desktop.exe');
  
  console.log('🚀 Starting Studio Desktop app:', studioExePath);
  
  try {
    const studioProcess = spawn(studioExePath, [], {
      detached: true,
      stdio: 'ignore'
    });
    
    studioDesktopRunning = true;
    
    // Reset flag when process exits
    studioProcess.on('exit', () => {
      studioDesktopRunning = false;
      console.log('📱 Studio Desktop process ended');
    });
    
    studioProcess.on('error', () => {
      studioDesktopRunning = false;
    });
    
    studioProcess.unref(); // Allow Tilbi to continue independently
    console.log('✅ Studio Desktop launched successfully');
    
    return { success: true, message: 'Studio Desktop launched' };
  } catch (error) {
    studioDesktopRunning = false;
    console.error('❌ Failed to launch Studio Desktop:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-video-bounds', () => {
  return global.videoBounds || { x: 0, y: 0, width: 1920, height: 1080 };
});

// ============================================================================
// SUBSCRIPTION & LICENSE MANAGEMENT IPC HANDLERS
// ============================================================================

// License validation on startup
async function validateLicenseOnStartup() {
  if (!subscription.isAuthenticated()) {
    console.log('⚠️ User not authenticated, skipping license validation');
    return { valid: false, reason: 'Not authenticated' };
  }

  try {
    const result = await subscription.validateLicense();
    console.log('📝 License validation result:', result.valid ? '✅ Valid' : '❌ Invalid');
    
    // Schedule periodic validation (every 24 hours)
    if (result.valid) {
      schedulePeriodicValidation();
    }
    
    return result;
  } catch (error) {
    console.error('❌ License validation error:', error);
    return { valid: false, reason: error.message };
  }
}

// Schedule periodic license validation (prevents long-term offline use)
let validationInterval = null;
function schedulePeriodicValidation() {
  // Clear existing interval
  if (validationInterval) {
    clearInterval(validationInterval);
  }
  
  // Validate every 24 hours
  validationInterval = setInterval(async () => {
    if (subscription.isAuthenticated()) {
      console.log('🔄 Periodic license validation...');
      try {
        const result = await subscription.validateLicense();
        if (!result.valid && result.requiresOnline) {
          console.warn('⚠️ Subscription requires online validation');
          // Notify renderer process to show subscription UI
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('subscription-requires-validation', result);
          }
        }
      } catch (error) {
        console.error('❌ Periodic validation error:', error);
      }
    }
  }, 24 * 60 * 60 * 1000); // 24 hours
}

// Authentication handlers
ipcMain.handle('subscription-login', async (event, { email, password }) => {
  return await subscription.login(email, password);
});

ipcMain.handle('subscription-register', async (event, { email, password }) => {
  return await subscription.register(email, password);
});

ipcMain.handle('subscription-logout', () => {
  subscription.logout();
  return { success: true };
});

ipcMain.handle('subscription-is-authenticated', () => {
  return subscription.isAuthenticated();
});

// License validation
ipcMain.handle('subscription-validate-license', async () => {
  return await subscription.validateLicense();
});

// Subscription status
ipcMain.handle('subscription-get-status', async () => {
  return await subscription.getSubscriptionStatus();
});

// Create subscription
ipcMain.handle('subscription-create', async (event, { planType, provider = 'stripe' }) => {
  return await subscription.createSubscription(planType, provider);
});

ipcMain.handle('subscription-confirm-paypal', async (event, { subscriptionId }) => {
  return await subscription.confirmPayPalSubscription(subscriptionId);
});

// Cancel subscription
ipcMain.handle('subscription-cancel', async (event, { cancelImmediately }) => {
  return await subscription.cancelSubscription(cancelImmediately);
});

// Resume subscription
ipcMain.handle('subscription-resume', async () => {
  return await subscription.resumeSubscription();
});

// Billing portal
ipcMain.handle('subscription-billing-portal', async () => {
  return await subscription.getBillingPortalUrl();
});

// Allow renderer to request moving the floating video window
ipcMain.on('move-video-window', (event, position) => {
  try {
    if (global.videoWindow && !global.videoWindow.isDestroyed()) {
      const { x, y } = position || {};
      if (typeof x === 'number' && typeof y === 'number') {
        const primary = screen.getPrimaryDisplay();
        const clampedX = Math.max(0, Math.min(x, primary.bounds.width - 50));
        const clampedY = Math.max(0, Math.min(y, primary.bounds.height - 50));
        global.videoWindow.setPosition(Math.floor(clampedX), Math.floor(clampedY));
        store.set('videoWindowPosition', { x: clampedX, y: clampedY });
      }
    }
  } catch (error) {
    console.error('move-video-window failed:', error);
  }
});

// Write Windows CF_HDROP to clipboard so right-click paste works in Explorer and many apps
function writeFilesToClipboardWindows(filePaths) {
  if (process.platform !== 'win32') return false;
  try {
    if (!filePaths || !filePaths.length) return false;

    const headerSize = 20;
    const filesUtf16 = filePaths.map(p => Buffer.from(p + '\u0000', 'utf16le'));
    const filesLen = filesUtf16.reduce((t, b) => t + b.length, 0);
    const doubleNull = Buffer.from('\u0000\u0000', 'utf16le');
    const totalSize = headerSize + filesLen + doubleNull.length;
    const buf = Buffer.alloc(totalSize);

    buf.writeUInt32LE(headerSize, 0);
    buf.writeUInt32LE(0, 12);
    buf.writeUInt32LE(1, 16);

    let offset = headerSize;
    for (const b of filesUtf16) {
      b.copy(buf, offset);
      offset += b.length;
    }
    doubleNull.copy(buf, offset);

    clipboard.writeBuffer('CF_HDROP', buf);
    const dropEffect = Buffer.alloc(4);
    dropEffect.writeUInt32LE(1, 0);
    clipboard.writeBuffer('Preferred DropEffect', dropEffect);
    return true;
  } catch (e) {
    console.warn('writeFilesToClipboardWindows failed:', e);
    return false;
  }
}

ipcMain.handle('copy-as-file', async (event, payload) => {
  try {
    let filePath = null;
    if (typeof payload === 'string') {
      if (/^data:image\//i.test(payload)) {
        // data URL -> write temp file
        const base64Data = payload.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        const tempName = generateScreenshotFilename().replace('Screenshot_', 'Clipboard_');
        filePath = path.join(userScreenshotsPath, tempName);
        fs.writeFileSync(filePath, buffer);
      } else {
        filePath = payload;
      }
    } else if (payload && typeof payload === 'object') {
      if (payload.path && fs.existsSync(payload.path)) {
        filePath = payload.path;
      } else if (payload.dataUrl && typeof payload.dataUrl === 'string') {
        const base64Data = payload.dataUrl.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        const tempName = generateScreenshotFilename().replace('Screenshot_', 'Clipboard_');
        filePath = path.join(userScreenshotsPath, tempName);
        fs.writeFileSync(filePath, buffer);
      }
    }

    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error('No file available to copy');
    }
    const ok = writeFilesToClipboardWindows([filePath]);
    return { success: ok, path: filePath };
  } catch (e) {
    console.error('copy-as-file failed:', e);
    return { success: false, error: e.message };
  }
});

// Allow renderer to resize the floating video window to fit contents
ipcMain.on('resize-video-window', (event, size) => {
  try {
    if (global.videoWindow && !global.videoWindow.isDestroyed()) {
      const { width, height } = size || {};
      if (typeof width === 'number' && typeof height === 'number') {
        const contentW = Math.max(120, Math.floor(width));
        const contentH = Math.max(48, Math.floor(height));
        // Use content size to avoid extra chrome space that causes black padding
        global.videoWindow.setContentSize(contentW, contentH);
      }
    }
  } catch (error) {
    console.error('resize-video-window failed:', error);
  }
});

// Handle getting screen stream for video recording
ipcMain.handle('get-screen-stream', async (event, bounds) => {
  try {
    const displays = screen.getAllDisplays();
    // Default to primary display
    let targetDisplay = screen.getPrimaryDisplay();

    // If bounds provided, choose the display that contains the selection center
    if (bounds && typeof bounds.x === 'number' && typeof bounds.y === 'number' && typeof bounds.width === 'number' && typeof bounds.height === 'number') {
      const centerX = bounds.x + bounds.width / 2;
      const centerY = bounds.y + bounds.height / 2;
      for (const d of displays) {
        const b = d.bounds;
        if (centerX >= b.x && centerX < b.x + b.width && centerY >= b.y && centerY < b.y + b.height) {
          targetDisplay = d;
          break;
        }
      }
    }

    // Fetch all screen sources
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: targetDisplay.bounds.width,
        height: targetDisplay.bounds.height
      }
    });

    // Try to match the Electron display to the capturer source via display_id
    let source = sources.find(s => s.display_id === String(targetDisplay.id));
    if (!source) {
      // Fallback: pick first available
      source = sources[0];
    }

    if (source) {
      return {
        id: source.id,
        name: source.name,
        displayId: source.display_id || null,
        displayBounds: targetDisplay.bounds,
        displayScaleFactor: targetDisplay.scaleFactor,
        thumbnail: source.thumbnail ? source.thumbnail.toDataURL() : null
      };
    } else {
      throw new Error('No screen source found');
    }
  } catch (error) {
    console.error('Error getting screen stream:', error);
    throw error;
  }
});

// Note: Removed get-system-audio-source handler to avoid IPC issues
// System audio now uses the same source as the video stream

// Ensure window visibility
ipcMain.on('ensure-window-visible', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    // Short delay to ensure window comes back after system operations
    setTimeout(() => {
      if (!isScreenshotMode && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setAlwaysOnTop(true);
        mainWindow.show();
        mainWindow.focus();
      }
    }, 100);
  }
});

ipcMain.on('start-native-drag', (event, payload) => {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.setAlwaysOnTop(false); } catch (_) {}
    }
    if (!payload) {
      event.returnValue = false;
      return;
    }
    let filePath = payload.path;

    if (!filePath && payload.dataUrl) {
      const img = nativeImage.createFromDataURL(payload.dataUrl);
      if (!img.isEmpty()) {
        filePath = path.join(app.getPath('temp'), `tilbi-drag-${Date.now()}.png`);
        fs.writeFileSync(filePath, img.toPNG());
      }
    }

    if (!filePath || !fs.existsSync(filePath)) {
      event.returnValue = false;
      return;
    }

    event.sender.startDrag({
      file: filePath,
      icon: makeDragIcon(filePath)
    });
    event.returnValue = true;
  } catch (err) {
    console.error('start-native-drag failed:', err);
    event.returnValue = false;
  }
});

ipcMain.on('drag-ended', () => {
  if (!isScreenshotMode && mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.setAlwaysOnTop(true); } catch (_) {}
  }
});

// Handle second instance
app.on('second-instance', () => {
  console.log('Second instance detected, focusing the main window');
  if (isScreenshotMode) {
    try { cancelCaptureMode(); } catch (_) {}
  }
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createMainWindow();
  }
});

// Handle app quit
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopClipboardMonitoring();
  console.log('App quit requested, setting force kill timeout');
});

// This handles the emergency force-quit
app.on('before-quit', () => {
  app.isQuitting = true;
  console.log('EMERGENCY: Force cleaning all windows');
  
  // Clean up everything
  if (clipboardMonitorInterval) {
    clearInterval(clipboardMonitorInterval);
    clipboardMonitorInterval = null;
  }
  
  // Tray heartbeat monitor removed
  
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy();
  }
  
  if (clipboardWindow && !clipboardWindow.isDestroyed()) {
    clipboardWindow.destroy();
  }
  
  // Tray removed - app now runs in taskbar
  
  console.log('All windows closed, but app continues running in the background');
});

// Quit app when all windows are closed
app.on('window-all-closed', () => {
  app.quit();
});

// Handle reordering of history items
ipcMain.on('reorder-history', (event, { fromIndex, toIndex }) => {
  let history = store.get('clipboardHistory') || [];
  const [movedItem] = history.splice(fromIndex, 1);
  history.splice(toIndex, 0, movedItem);
  store.set('clipboardHistory', history);
  
  // Update UI
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('clipboard-data', {
      history: history,
      pinned: store.get('pinnedItems') || [],
      screener: store.get('screenerItems') || []
    });
  }
});

// Handle reordering of pinned items
ipcMain.on('reorder-pinned', (event, { fromIndex, toIndex }) => {
  let pinnedItems = store.get('pinnedItems') || [];
  const [movedItem] = pinnedItems.splice(fromIndex, 1);
  pinnedItems.splice(toIndex, 0, movedItem);
  store.set('pinnedItems', pinnedItems);
  
  // Update UI
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('clipboard-data', {
      history: store.get('clipboardHistory') || [],
      pinned: pinnedItems,
      screener: store.get('screenerItems') || []
    });
  }
});

// Handle deleting screener items - DEBUG VERSION
ipcMain.on('delete-screener-item', (event, content) => {
  console.log('=== DELETE SCREENER ITEM CALLED ===');
  console.log('Content to delete:', content);
  console.log('Content type:', typeof content);
  
  let screenerItems = store.get('screenerItems') || [];
  console.log('Current screener items count:', screenerItems.length);
  console.log('All screener items:', screenerItems);
  
  // Find the specific item to delete
  let itemIndex = -1;
  let itemToDelete = null;
  
  // Try multiple matching strategies
  if (typeof content === 'string') {
    console.log('Looking for string content:', content);
    itemIndex = screenerItems.findIndex(item => {
      console.log('Checking item:', item, 'type:', typeof item);
      if (typeof item === 'string') {
        const match = item === content;
        console.log('String comparison:', item, '===', content, '=', match);
        return match;
      } else if (item && item.content) {
        const match = item.content === content;
        console.log('Object content comparison:', item.content, '===', content, '=', match);
        return match;
      } else if (item && item.dataUrl) {
        const match = item.dataUrl === content;
        console.log('DataUrl comparison:', item.dataUrl, '===', content, '=', match);
        return match;
      }
      return false;
    });
  } else if (content && typeof content === 'object') {
    console.log('Looking for object content:', content);
    itemIndex = screenerItems.findIndex(item => {
      console.log('Checking object item:', item);
      if (typeof item === 'object') {
        // Try multiple object matching strategies
        if (content.content && item.content === content.content) {
          console.log('Matched by content property');
          return true;
        }
        if (content.dataUrl && item.dataUrl === content.dataUrl) {
          console.log('Matched by dataUrl property');
          return true;
        }
        if (content.path && item.path === content.path) {
          console.log('Matched by path property');
          return true;
        }
        // Deep comparison for objects
        const contentStr = JSON.stringify(content);
        const itemStr = JSON.stringify(item);
        const match = contentStr === itemStr;
        console.log('Deep comparison:', contentStr, '===', itemStr, '=', match);
        return match;
      }
      return false;
    });
  }
  
  console.log('Found item at index:', itemIndex);
  
  if (itemIndex !== -1) {
    itemToDelete = screenerItems[itemIndex];
    console.log('Item to delete:', itemToDelete);
    
    // Remove from array
    screenerItems.splice(itemIndex, 1);
    
    // Delete file if it's a screenshot
    if (itemToDelete && itemToDelete.path) {
      try {
        if (fs.existsSync(itemToDelete.path)) {
          fs.unlinkSync(itemToDelete.path);
          console.log('Screenshot file deleted:', itemToDelete.path);
        }
      } catch (error) {
        console.error('Error deleting file:', error);
      }
    }
    
    // Save updated screener items
    store.set('screenerItems', screenerItems);
    console.log('Screener items saved, new count:', screenerItems.length);
  
    // Update UI
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('clipboard-data', {
        history: store.get('clipboardHistory') || [],
        pinned: store.get('pinnedItems') || [],
        screener: screenerItems
      });
      console.log('UI updated');
    }
    
    console.log('=== DELETE COMPLETED ===');
  } else {
    console.log('Item not found in screener items');
    console.log('Available items for comparison:');
    screenerItems.forEach((item, index) => {
      console.log(`Item ${index}:`, item);
    });
  }
});

// Handle showing EULA from menu
ipcMain.on('show-eula', () => {
  const { dialog } = require('electron');
  const fs = require('fs');
  const path = require('path');
  
  try {
    const eulaPath = path.join(__dirname, 'legal', 'EULA.txt');
    const eulaContent = fs.existsSync(eulaPath) ? fs.readFileSync(eulaPath, 'utf8') : 
      'EULA file not found.';
    
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Tilbi - End User License Agreement',
      message: 'End User License Agreement',
      detail: eulaContent,
      buttons: ['OK']
    });
  } catch (error) {
    console.error('Error showing EULA:', error);
  }
});

// Handle showing privacy policy
ipcMain.on('show-privacy', () => {
  const { dialog } = require('electron');
  const fs = require('fs');
  const path = require('path');
  
  try {
    const privacyPath = path.join(__dirname, 'legal', 'privacy-policy.txt');
    const privacyContent = fs.existsSync(privacyPath) ? fs.readFileSync(privacyPath, 'utf8') : 
      'Privacy policy file not found.';
    
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Tilbi - Privacy Policy',
      message: 'Privacy Policy',
      detail: privacyContent,
      buttons: ['OK']
    });
  } catch (error) {
    console.error('Error showing privacy policy:', error);
  }
});

// Handle showing terms of service
ipcMain.on('show-terms', () => {
  const { dialog } = require('electron');
  const fs = require('fs');
  const path = require('path');
  
  try {
    const termsPath = path.join(__dirname, 'legal', 'terms-of-service.txt');
    const termsContent = fs.existsSync(termsPath) ? fs.readFileSync(termsPath, 'utf8') : 
      'Terms of service file not found.';
    
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Tilbi - Terms of Service',
      message: 'Terms of Service',
      detail: termsContent,
      buttons: ['OK']
    });
  } catch (error) {
    console.error('Error showing terms of service:', error);
  }
});

// Handle copying images
function copyImageFromPayload(payload) {
  console.log('Starting image copy process');
  clipboard.clear();

  let dataUrl = null;
  let filePath = null;

  if (typeof payload === 'string') {
    if (/^data:image\//i.test(payload)) dataUrl = payload;
    else filePath = payload;
  } else if (payload && typeof payload === 'object') {
    if (payload.dataUrl && typeof payload.dataUrl === 'string') dataUrl = payload.dataUrl;
    if (!dataUrl && payload.path && typeof payload.path === 'string') filePath = payload.path;
  }

  let image = null;
  if (dataUrl) {
    image = nativeImage.createFromDataURL(dataUrl);
  } else if (filePath) {
    try {
      const buf = fs.readFileSync(filePath);
      image = nativeImage.createFromBuffer(buf);
    } catch (e) {
      console.error('Failed reading file for copy-image:', e);
    }
  }

  if (!image || image.isEmpty()) {
    throw new Error('No valid image data to copy');
  }

  image = scaleCaptureForReadableSave(image);

  // Clear first to avoid conflicting formats
  try { clipboard.clear(); } catch (_) {}

  // Primary: native image
  clipboard.writeImage(image);

  // Extra formats to improve paste compatibility
  try {
    const png = image.toPNG();
    if (png && png.length) {
      clipboard.writeBuffer('image/png', png);
    }
  } catch (e) { console.warn('writeBuffer image/png failed:', e?.message || e); }

  // Do not write base64 HTML copies — that freezes the UI on large screenshots.
  const ok = clipboard.availableFormats().some(f => f.startsWith('image/')) || !clipboard.readImage().isEmpty();
  console.log(ok ? 'Image successfully copied to clipboard' : 'Clipboard write returned empty');
  if (!ok) throw new Error('Clipboard write failed');
  return true;
}

ipcMain.on('copy-image', (event, payload) => {
  try {
    copyImageFromPayload(payload);
  } catch (error) {
    console.error('Error copying image:', error);
  }
});

ipcMain.handle('copy-image', async (event, payload) => {
  try {
    console.log('\n========== COPY-IMAGE DEBUG ==========');
    console.log('Type:', typeof payload);
    console.log('Has .path?:', !!payload?.path);
    console.log('Has .content?:', !!payload?.content);
    console.log('Has .dataUrl?:', !!payload?.dataUrl);
    
    let filePath = null;
    let image = null;
    
    // Strategy 1: payload.path (Screener items)
    if (payload?.path) {
      console.log('Checking payload.path:', payload.path);
      if (fs.existsSync(payload.path)) {
        filePath = payload.path;
        image = nativeImage.createFromPath(filePath);
        console.log('✅ Found file at payload.path');
      } else {
        console.log('❌ File does not exist at payload.path');
      }
    }
    
    // Strategy 2: payload.content (legacy or other sources)
    if (!filePath && payload?.content) {
      console.log('Checking payload.content type:', typeof payload.content);
      if (typeof payload.content === 'string' && payload.content.startsWith('data:image')) {
        image = nativeImage.createFromDataURL(payload.content);
        console.log('✅ Created from payload.content data URL');
      } else if (typeof payload.content === 'string' && fs.existsSync(payload.content)) {
        filePath = payload.content;
        image = nativeImage.createFromPath(filePath);
        console.log('✅ Found file at payload.content');
      }
    }
    
    // Strategy 3: payload.dataUrl (Screener items)
    if (!image && payload?.dataUrl) {
      console.log('Using payload.dataUrl');
      image = nativeImage.createFromDataURL(payload.dataUrl);
      console.log('✅ Created from payload.dataUrl');
    }
    
    // Strategy 4: Direct string payload
    if (!image && typeof payload === 'string') {
      if (payload.startsWith('data:image')) {
        image = nativeImage.createFromDataURL(payload);
        console.log('✅ Created from direct data URL');
      } else if (fs.existsSync(payload)) {
        filePath = payload;
        image = nativeImage.createFromPath(filePath);
        console.log('✅ Found direct file path');
      }
    }
    
    if (!image || image.isEmpty()) {
      console.log('❌ FAILED: No valid image created');
      throw new Error('Invalid image data - could not create nativeImage');
    }

    image = scaleCaptureForReadableSave(image);
    
    console.log('Image created. FilePath:', filePath || 'NONE');
    
    // Clear clipboard first
    try { clipboard.clear(); } catch (_) {}
    clipboard.writeImage(image);
    if (filePath) {
      try { writeFilesToClipboardWindows([filePath]); } catch (_) {}
    }
    const formats = clipboard.availableFormats();
    console.log('Clipboard formats after writeImage:', formats);
    const ok = formats.some(f => f.startsWith('image/')) || !clipboard.readImage().isEmpty();
    console.log(ok ? '✅ Image bitmap written to clipboard' : '❌ Clipboard write failed');
    console.log('========================================\n');
    
    if (!ok) throw new Error('Clipboard write failed');
    return { success: true };
  } catch (error) {
    console.error('❌ COPY-IMAGE EXCEPTION:', error);
    console.log('========================================\n');
    return { success: false, error: error.message };
  }
});

// Handle adding items to history
ipcMain.on('add-to-history', (event, content) => {
  let history = store.get('clipboardHistory') || [];
  
  // Don't add if already exists
  if (!history.includes(content)) {
    history.unshift(content);
    
    // Apply history limit
    if (history.length > MAX_HISTORY_ITEMS) {
      history = history.slice(0, MAX_HISTORY_ITEMS);
    }
    
    store.set('clipboardHistory', history);
    
    // Update UI
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('clipboard-data', {
        history: history,
        pinned: store.get('pinnedItems') || [],
        screener: store.get('screenerItems') || []
      });
    }
  }
});

// Add handler for opening screenshots
ipcMain.on('open-screenshot', (event, filepath) => {
  try {
    openScreenshotInEditor(typeof filepath === 'string' ? { path: filepath } : filepath);
  } catch (error) {
    console.error('Error opening screenshot:', error);
  }
});

// Add handler for opening videos
ipcMain.on('open-video', (event, filepath) => {
  shell.openPath(filepath);
  
  // Prevent main window from minimizing when opening video
  setTimeout(() => {
    if (!isScreenshotMode && mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  }, 50);
});

// Open With... handler (Windows OpenAs dialog or fallbacks)
ipcMain.on('open-with', (event, filepath) => {
  try {
    if (process.platform === 'win32') {
      const child = spawn('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', filepath], { detached: true, stdio: 'ignore' });
      child.unref();
    } else if (process.platform === 'darwin') {
      // macOS: show in Finder (user can choose app)
      shell.showItemInFolder(filepath);
    } else {
      // Linux: fallback to default opener
      shell.openPath(filepath);
    }
  } catch (e) {
    console.warn('open-with failed:', e);
    try { shell.openPath(filepath); } catch (_) {}
  }
});

// Add handler for opening image editor
ipcMain.on('open-image-editor', (event, screenshotContent) => {
  try {
    console.log('Received open-image-editor request with:', screenshotContent);
    openScreenshotInEditor(screenshotContent);
  } catch (error) {
    console.error('Error opening image editor:', error);
  }
});

// Handle close editor and show main window request (from Cancel button)
ipcMain.on('close-editor-and-show-main', () => {
  if (editorWindow && !editorWindow.isDestroyed()) {
    editorWindow.close();
  }
});

ipcMain.handle('share-editor-image', async (event, { mode, imageData, sourcePath }) => {
  try {
    if (!imageData || typeof imageData !== 'string') {
      throw new Error('No image data to share');
    }

    let image = nativeImage.createFromDataURL(imageData);
    if (!image || image.isEmpty()) {
      throw new Error('Invalid image data');
    }
    image = scaleCaptureForReadableSave(image);

    const filename = generateScreenshotFilename().replace('Screenshot_', 'Share_');
    const filepath = path.join(userScreenshotsPath, filename);
    fs.writeFileSync(filepath, image.toPNG());

    const copyShareImageToClipboard = () => {
      try { clipboard.clear(); } catch (_) {}
      clipboard.writeImage(image);
      try {
        const png = image.toPNG();
        if (png && png.length) clipboard.writeBuffer('image/png', png);
      } catch (_) {}
      writeFilesToClipboardWindows([filepath]);
    };

    const launchWhatsApp = async () => {
      const localApp = path.join(process.env.LOCALAPPDATA || '', 'WhatsApp', 'WhatsApp.exe');
      if (fs.existsSync(localApp)) {
        spawn(localApp, [], { detached: true, stdio: 'ignore' }).unref();
        return;
      }
      try {
        await shell.openExternal('whatsapp://send');
        return;
      } catch (_) {}
      await shell.openExternal('https://web.whatsapp.com/');
    };

    if (mode === 'whatsapp') {
      copyShareImageToClipboard();
      await launchWhatsApp();
      return { success: true, path: filepath };
    }

    if (mode === 'email') {
      copyShareImageToClipboard();
      const subject = encodeURIComponent('Image from Tilbi');
      const body = encodeURIComponent('The image is on your clipboard. Paste it into the email with Ctrl+V.');
      await shell.openExternal(`mailto:?subject=${subject}&body=${body}`);
      return { success: true, path: filepath };
    }

    if (mode === 'copy') {
      copyShareImageToClipboard();
      return { success: true, path: filepath };
    }

    if (mode === 'reveal') {
      shell.showItemInFolder(filepath);
      return { success: true, path: filepath };
    }

    if (mode === 'open-with') {
      if (process.platform === 'win32') {
        const child = spawn('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', filepath], { detached: true, stdio: 'ignore' });
        child.unref();
      } else {
        shell.openPath(filepath);
      }
      return { success: true, path: filepath };
    }

    shell.openPath(filepath);
    return { success: true, path: filepath };
  } catch (error) {
    console.error('share-editor-image failed:', error);
    return { success: false, error: error.message };
  }
});

// Add handler for saving edited image
ipcMain.on('save-edited-image', (event, imageData) => {
  try {
    // Convert base64 image to buffer
    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(base64Data, 'base64');
    
    // Generate new filename
    const filename = generateScreenshotFilename();
    const filepath = path.join(userScreenshotsPath, filename);
    
    // Save to disk
    fs.writeFileSync(filepath, imageBuffer);
    
    // Create screenshot entry
    const screenshotEntry = {
      path: filepath,
      timestamp: Date.now()
    };
    
    // Update screener items
    let screenerItems = store.get('screenerItems') || [];
    screenerItems.unshift(screenshotEntry);
    
    // Apply screener items limit
    const MAX_SCREENER_ITEMS = 100;
    if (screenerItems.length > MAX_SCREENER_ITEMS) {
      screenerItems = screenerItems.slice(0, MAX_SCREENER_ITEMS);
    }
    
    store.set('screenerItems', screenerItems);
    
    // Update main window
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('clipboard-data', {
        history: store.get('clipboardHistory') || [],
        pinned: store.get('pinnedItems') || [],
        screener: screenerItems
      });
    }
    
    // Notify editor window
    if (editorWindow && !editorWindow.isDestroyed()) {
      editorWindow.webContents.send('image-saved', filepath);
    }
    
    console.log('Edited image saved successfully:', filepath);
  } catch (error) {
    console.error('Error saving edited image:', error);
  }
});

// Save edited video from editor (base64)
ipcMain.on('save-edited-video', (event, payload) => {
  try {
    const { base64, ext } = payload || {};
    if (!base64) return;
    const buffer = Buffer.from(base64, 'base64');
    const filename = `edited_${Date.now()}.${ext || 'mp4'}`;
    const filepath = path.join(userScreenshotsPath, filename);
    fs.writeFileSync(filepath, buffer);
    // Optionally notify or open folder
    shell.showItemInFolder(filepath);
    // Close editor (main window will be shown via closed event)
    if (editorWindow && !editorWindow.isDestroyed()) {
      editorWindow.close();
    }
  } catch (e) {
    console.error('Error saving edited video:', e);
  }
});

// Open an external application/folder when asked from renderer
ipcMain.on('open-external-app', (event, targetPath) => {
  try {
    if (typeof targetPath !== 'string' || targetPath.trim() === '') return;
    // If a folder is provided, open it; if an exe, run it
    if (fs.existsSync(targetPath)) {
      const stat = fs.statSync(targetPath);
      if (stat.isDirectory()) {
        shell.openPath(targetPath);
      } else {
        const { execFile } = require('child_process');
        execFile(targetPath, [], { windowsHide: true }, (err) => {
          if (err) console.error('Failed to launch external app:', err);
        });
      }
    } else {
      // Fallback: try opening via shell
      shell.openPath(targetPath);
    }
  } catch (e) {
    console.error('open-external-app error:', e);
  }
});

ipcMain.on('open-external-link', async (event, url) => {
  try {
    if (typeof url !== 'string' || url.trim() === '') return;
    await shell.openExternal(url.trim());
  } catch (error) {
    console.error('open-external-link error:', error);
  }
});

ipcMain.on('open-external-link-sequence', async (event, payload) => {
  if (!payload || typeof payload !== 'object') return;
  const { primary, fallback } = payload;
  if (typeof primary === 'string' && primary.trim()) {
    try {
      await shell.openExternal(primary.trim());
      return;
    } catch (error) {
      console.warn('Primary external link failed:', error);
    }
  }
  if (typeof fallback === 'string' && fallback.trim()) {
    try {
      await shell.openExternal(fallback.trim());
    } catch (fallbackError) {
      console.error('Fallback external link failed:', fallbackError);
    }
  }
});
// Window control handlers
ipcMain.on('minimize-window', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.minimize();
    // The 'minimize' event will trigger the icon change
  }
});


// Language change handler
ipcMain.on('language-changed', (event, language) => {
  console.log('Language changed to:', language);
  // Store language preference
  store.set('language', language);
  
  // Hebrew language support
  if (language === 'he') {
    console.log('Hebrew language selected - RTL mode enabled');
  }
  
  // You could implement additional language-specific functionality here
  // such as updating system tray menu language, etc.
});

function sendUpdateStatus(status, message, targetWebContents) {
  const payload = { status, message };
  const contents = targetWebContents
    || (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null);
  if (contents && !contents.isDestroyed()) {
    contents.send('update-status', payload);
  }
}

// Auto-updater event handlers
let updateStatusTarget = null;

if (autoUpdater) {
  autoUpdater.on('checking-for-update', () => {
    console.log('Checking for update...');
    sendUpdateStatus('checking', 'Checking for updates...', updateStatusTarget);
  });

  autoUpdater.on('update-available', (info) => {
    console.log('Update available:', info);
    const version = info && info.version ? ` v${info.version}` : '';
    sendUpdateStatus('available', `Update available${version}. Click "Update Now" to download.`, updateStatusTarget);
  });

  autoUpdater.on('update-not-available', (info) => {
    console.log('Update not available:', info);
    sendUpdateStatus('not-available', UPDATE_UP_TO_DATE_MSG, updateStatusTarget);
  });

  autoUpdater.on('error', (err) => {
    console.log('Error in auto-updater:', err);
    const result = resolveUpdateCheckFailure(err);
    sendUpdateStatus(result.status, result.message, updateStatusTarget);
    updateStatusTarget = null;
  });

  autoUpdater.on('download-progress', (progressObj) => {
    console.log('Download progress:', progressObj);
    const contents = updateStatusTarget
      || (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null);
    if (contents && !contents.isDestroyed()) {
      contents.send('update-progress', progressObj);
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('Update downloaded:', info);
    downloadedUpdateFile = (info && (info.downloadedFile || info.path)) || downloadedUpdateFile;
    const version = info && info.version ? ` v${info.version}` : '';
    sendUpdateStatus('downloaded', `Update${version} downloaded. Click Restart & Install.`, updateStatusTarget);
  });
}

// IPC handlers for update controls
ipcMain.on('check-for-updates', (event) => {
  updateStatusTarget = event.sender;
  if (autoUpdater) {
    sendUpdateStatus('checking', 'Checking for updates...', event.sender);
    autoUpdater.checkForUpdates().catch((err) => {
      console.log('checkForUpdates failed:', err);
      const result = resolveUpdateCheckFailure(err);
      sendUpdateStatus(result.status, result.message, event.sender);
      updateStatusTarget = null;
    });
  } else {
    sendUpdateStatus('error', 'Automatic updates are not configured for this install.', event.sender);
    updateStatusTarget = null;
  }
});

ipcMain.on('download-update', () => {
  if (autoUpdater) {
    autoUpdater.downloadUpdate();
  }
});

ipcMain.on('quit-and-install', () => {
  if (!runDownloadedInstallerAndQuit() && autoUpdater) {
    autoUpdater.quitAndInstall(false, true);
  }
});

ipcMain.on('set-update-settings', (event, settings) => {
  if (!settings || typeof settings !== 'object') return;
  if (typeof settings.enabled === 'boolean') {
    store.set('autoUpdateEnabled', settings.enabled);
  }
  if (typeof settings.frequency === 'string' && settings.frequency) {
    store.set('updateFrequency', settings.frequency);
  }
});

ipcMain.on('get-update-settings', (event) => {
  const lastCheckRaw = store.get('lastUpdateCheck');
  event.reply('update-settings', {
    enabled: store.get('autoUpdateEnabled') !== false,
    frequency: store.get('updateFrequency') || 'weekly',
    lastCheck: lastCheckRaw ? new Date(lastCheckRaw).getTime() : 0
  });
});

ipcMain.on('get-app-version', (event) => {
  try {
    event.reply('app-version', app.getVersion());
  } catch (_) {
    event.reply('app-version', 'unknown');
  }
});

ipcMain.on('update-last-check', () => {
  store.set('lastUpdateCheck', new Date().toISOString());
});

ipcMain.on('install-update', () => {
  if (!runDownloadedInstallerAndQuit() && autoUpdater) {
    autoUpdater.quitAndInstall(false, true);
  }
});

ipcMain.on('download-installer', (event) => {
  updateStatusTarget = event.sender;
  sendUpdateStatus('checking', 'Downloading latest Tilbi...', event.sender);

  downloadLatestInstaller((progressObj) => {
    const contents = updateStatusTarget
      || (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null);
    if (contents && !contents.isDestroyed()) {
      contents.send('update-progress', progressObj);
    }
  })
    .then((installerPath) => {
      downloadedUpdateFile = installerPath;
      sendUpdateStatus('downloaded', 'Update ready. Click Restart & Install.', updateStatusTarget);
    })
    .catch((err) => {
      console.error('download-installer failed:', err);
      sendUpdateStatus('error', 'Download failed. Check your internet and try again.', updateStatusTarget);
      updateStatusTarget = null;
    });
});

// App size handlers
ipcMain.on('set-app-size', (event, size) => {
  if (APP_SIZES[size]) {
    store.set('appSize', size);
    
    // Also store in localStorage for immediate UI updates
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.executeJavaScript(`localStorage.setItem('tilbi-size', '${size}');`);
    }
    
    // Restart the app to apply new size
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 100);
  }
});

ipcMain.on('get-app-size', (event) => {
  const currentSize = store.get('appSize') || 'normal';
  event.reply('app-size-changed', currentSize);
});

ipcMain.on('toggle-app-size', () => {
  // Prevent double-clicks
  if (isToggling) {
    console.log('⚠️ Already toggling, ignoring click');
    return;
  }
  
  isToggling = true;
  
  if (!mainWindow || mainWindow.isDestroyed()) {
    console.log('❌ Main window not available');
    isToggling = false;
    return;
  }
  
  console.log(`🔄 Before toggle: currentAppSize = '${currentAppSize}'`);
  
  // Toggle size - simple and direct
  const newSize = currentAppSize === 'normal' ? 'large' : 'normal';
  currentAppSize = newSize; // Update IMMEDIATELY
  
  console.log(`🔄 After toggle: currentAppSize = '${currentAppSize}'`);
  
  // Also save to store for persistence
  store.set('appSize', newSize);
  
  // Get new size configuration
  const size = APP_SIZES[newSize];
  
  // Get screen dimensions for centering
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  
  // Resize the window immediately (no restart needed)
  console.log(`🔄 Resizing window to ${size.width}x${size.height}...`);
  
  // First, enable resizing temporarily
  mainWindow.setResizable(true);
  
  // Set the new size (keep width fixed, allow vertical resize)
  mainWindow.setSize(size.width, size.height, true);
  mainWindow.setMinimumSize(size.width, HEADER_ONLY_HEIGHT);
  try { mainWindow.setMaximumSize(size.width, 10000); } catch (_) {}
  // Keep resizable true so user can resize from bottom
  mainWindow.setResizable(true);
  
  // Re-center the window
  const tilbiX = Math.floor((width - size.width) / 2);
  const tilbiY = Math.floor((height - size.height) / 2);
  mainWindow.setPosition(tilbiX, tilbiY);
  
  // Verify the size
  const actualSize = mainWindow.getSize();
  console.log(`✅ Window resized to: ${actualSize[0]}x${actualSize[1]}`);
  
  // Update localStorage
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.executeJavaScript(`localStorage.setItem('tilbi-size', '${newSize}');`);
  }
  
  // Update the icon in the UI
  mainWindow.webContents.send('app-size-changed', newSize);
  
  // Reset toggle lock after a delay
  setTimeout(() => {
    isToggling = false;
    console.log('✅ Toggle lock released');
  }, 500);
});

// ============================================================================
// GOOGLE DRIVE SYNC FUNCTIONALITY
// ============================================================================

// Google Drive OAuth2 Authentication
async function authenticateGoogleDrive(clientId, clientSecret) {
  try {
    console.log('🔐 Starting Google Drive authentication...');
    
    const REDIRECT_URI = 'http://localhost:3000/oauth2callback';
    
    const oauth2Client = new google.auth.OAuth2(
      clientId,
      clientSecret,
      REDIRECT_URI
    );
    
    // Generate auth URL
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/drive.file'],
      prompt: 'consent'
    });
    
    // Open auth URL in browser
    shell.openExternal(authUrl);
    
    // Create local server to receive OAuth callback
    const http = require('http');
    
    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        try {
          const url = new URL(req.url, `http://localhost:3000`);
          
          if (url.pathname === '/oauth2callback') {
            const code = url.searchParams.get('code');
            
            if (code) {
              // Send success response to browser
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end(`
                <!DOCTYPE html>
                <html>
                <head>
                  <style>
                    body {
                      font-family: Arial, sans-serif;
                      display: flex;
                      justify-content: center;
                      align-items: center;
                      height: 100vh;
                      margin: 0;
                      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    }
                    .container {
                      background: white;
                      padding: 40px;
                      border-radius: 12px;
                      text-align: center;
                      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
                    }
                    h1 { color: #28a745; margin: 0 0 20px 0; }
                    p { color: #666; margin: 0; }
                  </style>
                </head>
                <body>
                  <div class="container">
                    <h1>✓ Authentication Successful!</h1>
                    <p>You can close this window and return to Tilbi.</p>
                  </div>
                </body>
                </html>
              `);
              
              // Close server
              server.close();
              
              // Exchange code for tokens
              try {
                const { tokens } = await oauth2Client.getToken(code);
                oauth2Client.setCredentials(tokens);
                
                // Store tokens securely
                store.set('gdrive-tokens', tokens);
                store.set('gdrive-client-id', clientId);
                store.set('gdrive-client-secret', clientSecret);
                
                gdriveOAuth2Client = oauth2Client;
                gdriveConnected = true;
                
                console.log('✅ Google Drive authentication successful');
                resolve({ success: true, oauth2Client });
              } catch (error) {
                console.error('❌ Failed to get tokens:', error);
                reject(error);
              }
            } else {
              const error = url.searchParams.get('error');
              res.writeHead(400, { 'Content-Type': 'text/html' });
              res.end(`
                <!DOCTYPE html>
                <html>
                <body style="font-family: Arial; padding: 40px; text-align: center;">
                  <h1 style="color: #dc3545;">Authentication Failed</h1>
                  <p>Error: ${error || 'No authorization code received'}</p>
                </body>
                </html>
              `);
              server.close();
              reject(new Error(error || 'No authorization code received'));
            }
          }
        } catch (error) {
          console.error('Server error:', error);
          server.close();
          reject(error);
        }
      });
      
      server.listen(3000, () => {
        console.log('🔓 OAuth server listening on http://localhost:3000');
      });
      
      // Timeout after 5 minutes
      setTimeout(() => {
        server.close();
        reject(new Error('Authentication timeout'));
      }, 300000);
    });
  } catch (error) {
    console.error('❌ Google Drive authentication error:', error);
    throw error;
  }
}

// Initialize Google Drive client from stored tokens
async function initGoogleDriveFromStorage() {
  try {
    const tokens = store.get('gdrive-tokens');
    const clientId = store.get('gdrive-client-id');
    const clientSecret = store.get('gdrive-client-secret');
    
    if (!tokens || !clientId || !clientSecret) {
      return false;
    }
    
    const oauth2Client = new google.auth.OAuth2(
      clientId,
      clientSecret,
      'http://localhost:3000/oauth2callback'
    );
    
    oauth2Client.setCredentials(tokens);
    
    // Refresh token if needed
    oauth2Client.on('tokens', (newTokens) => {
      if (newTokens.refresh_token) {
        store.set('gdrive-tokens', newTokens);
      }
    });
    
    gdriveOAuth2Client = oauth2Client;
    gdriveConnected = true;
    
    console.log('✅ Google Drive client initialized from storage');
    return true;
  } catch (error) {
    console.error('❌ Failed to initialize Google Drive from storage:', error);
    return false;
  }
}

// Sync data to Google Drive
async function syncToGoogleDrive() {
  try {
    if (!gdriveOAuth2Client) {
      throw new Error('Not authenticated with Google Drive');
    }
    
    console.log('🔄 Starting Google Drive sync...');
    
    const drive = google.drive({ version: 'v3', auth: gdriveOAuth2Client });
    
    // Get Loginner data from renderer process
    let loginnerData = {};
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        loginnerData = await mainWindow.webContents.executeJavaScript(`
          ({
            sessions: localStorage.getItem('loginner-sessions') || '[]',
            projects: localStorage.getItem('loginner-projects') || '[]',
            projectDetails: localStorage.getItem('loginner-project-details') || '{}'
          })
        `);
      } catch (error) {
        console.warn('Could not fetch Loginner data:', error);
      }
    }
    
    // Collect all data to backup
    const backupData = {
      timestamp: new Date().toISOString(),
      clipboardHistory: store.get('clipboardHistory') || [],
      pinnedItems: store.get('pinnedItems') || [],
      screenerItems: store.get('screenerItems') || [],
      loginnerSessions: JSON.parse(loginnerData.sessions || '[]'),
      loginnerProjects: JSON.parse(loginnerData.projects || '[]'),
      loginnerProjectDetails: JSON.parse(loginnerData.projectDetails || '{}'),
      version: '1.0'
    };
    
    const fileMetadata = {
      name: 'tilbi-backup.json',
      mimeType: 'application/json'
    };
    
    const media = {
      mimeType: 'application/json',
      body: JSON.stringify(backupData, null, 2)
    };
    
    // Check if backup file already exists
    const response = await drive.files.list({
      q: "name='tilbi-backup.json' and trashed=false",
      fields: 'files(id, name)',
      spaces: 'drive'
    });
    
    let result;
    if (response.data.files && response.data.files.length > 0) {
      // Update existing file
      const fileId = response.data.files[0].id;
      result = await drive.files.update({
        fileId: fileId,
        media: media,
        fields: 'id, name, modifiedTime'
      });
      console.log('✅ Updated existing backup file');
    } else {
      // Create new file
      result = await drive.files.create({
        resource: fileMetadata,
        media: media,
        fields: 'id, name, modifiedTime'
      });
      console.log('✅ Created new backup file');
    }
    
    console.log('✅ Google Drive sync completed successfully');
    return { success: true, fileId: result.data.id };
  } catch (error) {
    console.error('❌ Google Drive sync error:', error);
    throw error;
  }
}

// Start automatic sync
function startGoogleDriveAutoSync(intervalMinutes = 30) {
  stopGoogleDriveAutoSync(); // Clear any existing interval
  
  console.log(`⏰ Starting automatic Google Drive sync every ${intervalMinutes} minutes`);
  
  gdriveSyncInterval = setInterval(async () => {
    try {
      await syncToGoogleDrive();
      console.log('✅ Automatic sync completed');
    } catch (error) {
      console.error('❌ Automatic sync failed:', error);
    }
  }, intervalMinutes * 60 * 1000);
}

// Stop automatic sync
function stopGoogleDriveAutoSync() {
  if (gdriveSyncInterval) {
    clearInterval(gdriveSyncInterval);
    gdriveSyncInterval = null;
    console.log('⏹️ Stopped automatic Google Drive sync');
  }
}

// IPC Handlers for Google Drive
ipcMain.handle('gdrive-connect', async (event, { clientId, clientSecret }) => {
  try {
    await authenticateGoogleDrive(clientId, clientSecret);
    return { success: true };
  } catch (error) {
    console.error('Google Drive connection error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('gdrive-sync', async () => {
  try {
    const result = await syncToGoogleDrive();
    return { success: true, ...result };
  } catch (error) {
    console.error('Google Drive sync error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.on('gdrive-start-sync', (event) => {
  const intervalMinutes = store.get('gdrive-sync-interval') || 30;
  startGoogleDriveAutoSync(parseInt(intervalMinutes));
});

ipcMain.on('gdrive-stop-sync', () => {
  stopGoogleDriveAutoSync();
});

ipcMain.on('gdrive-update-sync-interval', (event, intervalMinutes) => {
  store.set('gdrive-sync-interval', intervalMinutes);
  if (gdriveConnected && gdriveSyncInterval) {
    startGoogleDriveAutoSync(intervalMinutes);
  }
});

ipcMain.on('gdrive-disconnect', () => {
  stopGoogleDriveAutoSync();
  gdriveOAuth2Client = null;
  gdriveConnected = false;
  store.delete('gdrive-tokens');
  console.log('🔌 Disconnected from Google Drive');
});

// IPC Handlers for Google Calendar (uses same OAuth as Google Drive)
ipcMain.handle('gcal-connect', async (event, { clientId, clientSecret }) => {
  try {
    // Google Calendar uses the same OAuth flow as Google Drive
    // Just need to add calendar scope
    await authenticateGoogleDrive(clientId, clientSecret);
    return { success: true };
  } catch (error) {
    console.error('Google Calendar connection error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('gcal-sync', async () => {
  try {
    // For now, just return success - calendar sync would require additional implementation
    console.log('📅 Google Calendar sync requested');
    return { success: true, message: 'Calendar sync placeholder' };
  } catch (error) {
    console.error('Google Calendar sync error:', error);
    return { success: false, error: error.message };
  }
});

// Initialize Google Drive on app start if previously connected
app.on('ready', () => {
  try { app.setAppUserModelId('com.tilbi.app'); } catch (_) {}
  setTimeout(async () => {
    const initialized = await initGoogleDriveFromStorage();
    if (initialized) {
      const intervalMinutes = store.get('gdrive-sync-interval') || 30;
      startGoogleDriveAutoSync(parseInt(intervalMinutes));
    }
  }, 2000); // Delay to ensure app is fully loaded
});

