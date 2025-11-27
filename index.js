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
// Initialize the data store
const store = new Store({ name: 'clipboard-history' });
console.log('Store initialized successfully');

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
  store.set('eulaAcceptedDate', null);
  store.set('eulaVersion', '1.0');
}

// Configuration constants
const MAX_HISTORY_ITEMS = Infinity;  // Unlimited history items
const MAX_PINNED_ITEMS = Infinity;   // Unlimited pinned items
const MAX_SCREENER_ITEMS = Infinity; // Unlimited screener items

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
if (autoUpdater) {
  autoUpdater.checkForUpdatesAndNotify();
  autoUpdater.autoDownload = false; // Let user choose when to download
  autoUpdater.autoInstallOnAppQuit = true; // Install on app quit
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
let isScreenshotMode = false;
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
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-minimized');
    }
  });
  
  mainWindow.on('restore', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
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
          
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('clipboard-data', {
              history: history,
              pinned: store.get('pinnedItems') || [],
              screener: store.get('screenerItems') || []
            });
          }
        }
      }
    } catch (error) {
      console.error('Error monitoring clipboard:', error);
    }
  }, 100);
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

// Register global shortcut
app.whenReady().then(() => {
  console.log('App ready, initializing...');
  
  // Note: Removed permission handler to avoid IPC error 263
  // Media permissions will be handled by default Electron behavior
  
  if (!store.has('clipboardHistory')) {
    store.set('clipboardHistory', []);
  }
  
  if (!store.has('pinnedItems')) {
    store.set('pinnedItems', []);
  }
  
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

// Handle IPC events from renderer
ipcMain.on('copy-to-clipboard', (event, text) => {
  try {
    clipboard.writeText(text);
    lastClipboardContent = text;
    console.log('Text copied to clipboard');
    // Immediately add to history and refresh UI (no polling delay)
    try {
      let history = store.get('clipboardHistory') || [];
      if (!history.includes(text)) {
        history.unshift(text);
        if (history.length > MAX_HISTORY_ITEMS) {
          history = history.slice(0, MAX_HISTORY_ITEMS);
        }
        store.set('clipboardHistory', history);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('clipboard-data', {
            history: history,
            pinned: store.get('pinnedItems') || [],
            screener: store.get('screenerItems') || []
          });
        }
      }
    } catch (_) {}
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

// Screenshot functionality
ipcMain.on('take-screenshot', async (event) => {
  console.log('IPC: take-screenshot received');
  try {
    // Hide main window immediately
    if (mainWindow && !mainWindow.isDestroyed()) {
      console.log('Hiding main window for screenshot');
      mainWindow.hide();
      console.log('Main window hidden successfully');
    }
    
    // Set screenshot mode flag
    isScreenshotMode = true;
    console.log('Screenshot mode enabled');
    
    // Get all displays
    const displays = screen.getAllDisplays();
    const primaryDisplay = screen.getPrimaryDisplay();

    // Create a transparent window that covers all screens
    console.log('Creating selection window...');
    selectionWindow = new BrowserWindow({
      x: 0,
      y: 0,
      width: displays.reduce((total, display) => Math.max(total, display.bounds.x + display.bounds.width), 0),
      height: displays.reduce((total, display) => Math.max(total, display.bounds.y + display.bounds.height), 0),
      transparent: true,
      frame: false,
      fullscreen: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });
    console.log('Selection window created successfully');

    // Main window should already be hidden
    // Just ensure it stays hidden
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      console.log('Ensuring main window is hidden for screenshot');
      mainWindow.hide();
    }

    // Load the selection overlay
    console.log('Loading selection overlay...');
    selectionWindow.loadFile(path.join(__dirname, 'selection-overlay.html'));
    console.log('Selection overlay loaded');

    // Show the window after a short delay to ensure it's ready
    setTimeout(() => {
      console.log('Showing selection window');
      if (selectionWindow && !selectionWindow.isDestroyed()) {
        selectionWindow.show();
        selectionWindow.focus();
      } else {
        console.error('Selection window was destroyed before showing');
        // Reset screenshot mode flag
        isScreenshotMode = false;
        // Restore main window
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.setAlwaysOnTop(true);
          mainWindow.show();
          mainWindow.focus();
        }
      }
    }, 100);
  } catch (error) {
    console.error('Error starting area selection:', error);
    // Reset screenshot mode flag
    isScreenshotMode = false;
    // Restore main window on error
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(true);
      mainWindow.show();
      mainWindow.focus();
    }
  }
});

// Handle the selected area capture
ipcMain.on('capture-selected-area', async (event, bounds) => {
  try {
    if (selectionWindow) {
      selectionWindow.hide();
    }

    await new Promise(resolve => setTimeout(resolve, 100));

    const primaryDisplay = screen.getPrimaryDisplay();
    const source = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: primaryDisplay.bounds.width,
        height: primaryDisplay.bounds.height
      }
    }).then(sources => sources[0]);

    if (source) {
      const screenshot = source.thumbnail;
      const cropRect = {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height
      };
      let croppedImage = screenshot.crop(cropRect);

      // If a circular selection was requested, apply a circle mask
      if (bounds && bounds.shape === 'circle' && bounds.circle && typeof bounds.circle.r === 'number') {
        console.log('Applying circle mask:', bounds.circle);
        try {
          const localCenterX = Math.round(bounds.circle.cx - cropRect.x);
          const localCenterY = Math.round(bounds.circle.cy - cropRect.y);
          const radius = Math.max(1, Math.round(bounds.circle.r));

          console.log(`Circle params: center(${localCenterX}, ${localCenterY}), radius=${radius}, crop=${cropRect.width}x${cropRect.height}`);

          // Get bitmap data correctly
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
          dataUrl: croppedImage.toDataURL(),
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
        
        store.set('screenerItems', screenerItems);
        
        // Copy to clipboard
        clipboard.writeImage(croppedImage);
        
        if (selectionWindow) {
          selectionWindow.close();
          selectionWindow = null;
        }
        
        // Reset screenshot mode flag
        isScreenshotMode = false;
        
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
        }
      } catch (error) {
        console.error('Error saving or processing screenshot:', error);
        // Reset screenshot mode flag
        isScreenshotMode = false;
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
    }
  } catch (error) {
    console.error('Error capturing selected area:', error);
    // Reset screenshot mode flag
    isScreenshotMode = false;
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

// Handle selection cancellation
ipcMain.on('cancel-selection', () => {
  // Reset screenshot mode flag
  isScreenshotMode = false;
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

// Handle full webpage capture
ipcMain.on('capture-full-webpage', async (event, urlInput) => {
  let webpageWindow = null;
  try {
    console.log('Starting full webpage capture for:', urlInput);
    
    // Close selection window IMMEDIATELY
    if (selectionWindow) {
      selectionWindow.close();
      selectionWindow = null;
    }
    
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

    // Add a loading placeholder to Screener to avoid confusion during long captures
    const placeholderId = `loading-${Date.now()}`;
    try {
      let screenerItems = store.get('screenerItems') || [];
      const loadingEntry = {
        id: placeholderId,
        type: 'loading',
        timestamp: Date.now(),
        url: url,
        message: 'Capturing webpage...'
      };
      screenerItems.unshift(loadingEntry);
      store.set('screenerItems', screenerItems);
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
      }
    } catch (_) {}

    // Helper that performs the actual full-page capture for a given window
    const performFullPageCapture = async (targetWindow, targetUrl) => {
      // Wait for page to fully load
      console.log('Waiting for page load...');
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Scroll through the page to trigger lazy-loaded content
      console.log('Scrolling to load content...');
      await targetWindow.webContents.executeJavaScript(`
      (async () => {
        // Force all images to load
        const images = document.querySelectorAll('img[loading="lazy"]');
        images.forEach(img => img.loading = 'eager');
        
        const scrollHeight = Math.max(
          document.documentElement.scrollHeight,
          document.body.scrollHeight
        );
        const viewportHeight = window.innerHeight;
        const scrollSteps = Math.ceil(scrollHeight / viewportHeight);
        
        // Scroll down in steps
        for (let i = 0; i <= scrollSteps; i++) {
          window.scrollTo(0, i * viewportHeight);
          await new Promise(r => setTimeout(r, 400));
        }
        
        // Scroll to bottom
        window.scrollTo(0, document.body.scrollHeight);
        await new Promise(r => setTimeout(r, 1000));
        
        // Back to top
        window.scrollTo(0, 0);
        await new Promise(r => setTimeout(r, 500));
        
        return true;
      })()
    `);
      
      console.log('Measuring page dimensions...');
      
      // Get the full page dimensions after scrolling
      const pageSize = await targetWindow.webContents.executeJavaScript(`
      ({
        width: Math.max(
          document.documentElement.scrollWidth,
          document.documentElement.offsetWidth,
          document.documentElement.clientWidth,
          document.body.scrollWidth,
          document.body.offsetWidth,
          document.body.clientWidth
        ),
        height: Math.max(
          document.documentElement.scrollHeight,
          document.documentElement.offsetHeight,
          document.documentElement.clientHeight,
          document.body.scrollHeight,
          document.body.offsetHeight,
          document.body.clientHeight
        )
      })
    `);
      
      console.log('Full page size:', pageSize);
      
      // Resize window to full page size (with sane caps)
      const widthCap = hiRes ? 8000 : 4000;
      const heightCap = hiRes ? 60000 : 30000;
      const targetWidth = Math.min(Math.max(pageSize.width, 800), widthCap);
      const targetHeight = Math.min(Math.max(pageSize.height, 600), heightCap);
      targetWindow.setContentSize(targetWidth, targetHeight);
      
      // Wait for resize and all content to render
      console.log('Waiting for final render...');
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Retry logic for capture to avoid empty images on some sites
      let image = null;
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`Capturing page (attempt ${attempt}/${maxAttempts})...`);
        image = await targetWindow.webContents.capturePage();
        const size = image.getSize ? image.getSize() : { width: 0, height: 0 };
        const valid = image && !image.isEmpty() && size.width >= 10 && size.height >= 10;
        if (valid) break;
        console.warn('Capture was empty or too small, waiting and retrying...');
        await new Promise(resolve => setTimeout(resolve, 1200));
      }

      if (!image || image.isEmpty()) {
        // As a last resort, try capturing just the visible viewport
        console.warn('Falling back to viewport capture');
        image = await targetWindow.webContents.capturePage({ x: 0, y: 0, width: Math.min(targetWidth, 4000), height: Math.min(targetHeight, 30000) });
      }

      if (!image || image.isEmpty()) {
        throw new Error('Captured image is empty after retries');
      }
      
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
        dataUrl: image.toDataURL(),
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
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.executeJavaScript(`
              alert('Failed to capture webpage: ${err.message.replace(/'/g, "\\'")}');
            `);
          }
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
        cleanupInteractive();
        if (webpageWindow && !webpageWindow.isDestroyed()) {
          webpageWindow.close();
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.setAlwaysOnTop(true);
          mainWindow.show();
          mainWindow.focus();
        }
      };
      ipcMain.once('close-interactive-capture', closeHandler);

      // Clean up when window closes (handled in cleanupInteractive too)
      webpageWindow.on('closed', () => {
        try { globalShortcut.unregister('CommandOrControl+Shift+S'); } catch(_) {}
        try { ipcMain.removeListener('capture-from-webpage', captureHandler); } catch(_) {}
        console.log('Webpage window closed, cleaned up');
      });

      // Load the page and inject capture button
      console.log('Loading URL (interactive)...');
      await webpageWindow.loadURL(url, { timeout: 30000 });

      // Function to inject capture button (will be called after page loads)
      const injectCaptureButton = async () => {
        try {
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
        // Ensure main window returns
        if (mainWindow && !mainWindow.isDestroyed()) {
          try {
            mainWindow.setAlwaysOnTop(true);
            mainWindow.show();
            mainWindow.focus();
          } catch (_) {}
        }
      };

      webpageWindow.on('closed', cleanupInteractive);
      webpageWindow.on('close', cleanupInteractive);

      // ESC to cancel interactive capture cleanly
      webpageWindow.webContents.on('before-input-event', (event, input) => {
        try {
          if (input.key === 'Escape') {
            event.preventDefault();
            cleanupInteractive();
            if (webpageWindow && !webpageWindow.isDestroyed()) {
              webpageWindow.close();
            }
          }
        } catch (_) {}
      });

      // Do not auto-capture; wait for user action
      return;
    }

    // Non-interactive: hidden offscreen window
    webpageWindow = new BrowserWindow({
      width: 1920,
      height: 1080,
      show: false,
      icon: path.join(__dirname, 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        offscreen: true
      }
    });

    // Load the webpage
    console.log('Loading URL...');
    await webpageWindow.loadURL(url, { timeout: 30000 });

    await performFullPageCapture(webpageWindow, url);
    
    // Close webpage window and restore main window
    if (webpageWindow) {
      webpageWindow.close();
      webpageWindow = null;
    }
    // UI restore handled in performFullPageCapture
    
  } catch (error) {
    console.error('Error capturing full webpage:', error);
    
    // Show error to user
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.executeJavaScript(`
        alert('Failed to capture webpage: ${error.message.replace(/'/g, "\\'")}');
      `);
    }
    
    // Remove loading placeholder on error
    try {
      let screenerItems = store.get('screenerItems') || [];
      const filtered = screenerItems.filter(it => !(typeof it === 'object' && it && it.id === placeholderId));
      if (filtered.length !== screenerItems.length) {
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

    // Clean up
    if (webpageWindow && !webpageWindow.isDestroyed()) {
      webpageWindow.close();
    }
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(true);
      mainWindow.show();
      mainWindow.focus();
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

    // Get all displays
    const displays = screen.getAllDisplays();
    const primaryDisplay = screen.getPrimaryDisplay();

    // Create a transparent window that covers all screens for area selection
    selectionWindow = new BrowserWindow({
      x: 0,
      y: 0,
      width: displays.reduce((total, display) => Math.max(total, display.bounds.x + display.bounds.width), 0),
      height: displays.reduce((total, display) => Math.max(total, display.bounds.y + display.bounds.height), 0),
      transparent: true,
      frame: false,
      fullscreen: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });

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
ipcMain.handle('subscription-create', async (event, { planType }) => {
  return await subscription.createSubscription(planType);
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
    const { execSync } = require('child_process');
    
    // Clear clipboard first
    try { clipboard.clear(); } catch (_) {}
    
    // Use PowerShell to write file to clipboard - this ALWAYS works in Windows
    const filePath = filePaths[0].replace(/'/g, "''"); // Escape single quotes
    const psScript = `Set-Clipboard -LiteralPath '${filePath}'`;
    
    try {
      execSync(`powershell.exe -NoProfile -Command "${psScript}"`, {
        timeout: 2000,
        windowsHide: true
      });
      console.log('✅ PowerShell clipboard write successful');
      return true;
    } catch (psError) {
      console.warn('⚠️ PowerShell method failed, trying manual CF_HDROP:', psError.message);
      
      // Fallback to manual CF_HDROP
      // Build DROPFILES struct (20 bytes) + UTF-16LE file list + double null
      const headerSize = 20;
      const filesUtf16 = filePaths.map(p => Buffer.from(p + '\u0000', 'utf16le'));
      const filesLen = filesUtf16.reduce((t, b) => t + b.length, 0);
      const doubleNull = Buffer.from('\u0000\u0000', 'utf16le');
      const totalSize = headerSize + filesLen + doubleNull.length;
      const buf = Buffer.alloc(totalSize);
      
      buf.writeUInt32LE(headerSize, 0);
      buf.writeUInt32LE(0, 12);
      buf.writeUInt32LE(1, 16); // fWide = 1 for Unicode
      
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

      try {
        const first = filePaths[0];
        const uriList = Buffer.from(filePaths.map(p => 'file:///' + p.replace(/\\/g, '/')).join('\r\n') + '\r\n', 'utf8');
        clipboard.writeBuffer('text/uri-list', uriList);
        clipboard.writeText(first);
        const fnameW = Buffer.from(first + '\u0000', 'utf16le');
        clipboard.writeBuffer('FileNameW', fnameW);
      } catch (e) { console.warn('Extra formats failed:', e); }
      
      return true;
    }
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

// Handle second instance
app.on('second-instance', () => {
  console.log('Second instance detected, focusing the main window');
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

  try {
    const dataUrl = image.toDataURL();
    if (dataUrl) {
      clipboard.writeHTML(`<img src="${dataUrl}">`);
    }
  } catch (e) { console.warn('writeHTML img failed:', e?.message || e); }
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
    
    console.log('Image created. FilePath:', filePath || 'NONE');
    
    // Clear clipboard first
    try { clipboard.clear(); } catch (_) {}
    
    // If we have a file path, write it to clipboard as file
    if (filePath) {
      console.log('📂 Attempting to write file to clipboard:', filePath);
      const success = writeFilesToClipboardWindows([filePath]);
      if (success) {
        console.log('✅ SUCCESS: File written to clipboard for Desktop paste');
        console.log('========================================\n');
        return { success: true };
      } else {
        console.log('❌ File write FAILED, falling back to image');
      }
    } else {
      console.log('⚠️ No file path available, writing as image bitmap only');
    }
    
    // Fallback or primary: write as image bitmap
    clipboard.writeImage(image);
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
  shell.openPath(filepath);
  
  // Prevent main window from minimizing when opening screenshot
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

let editorWindow = null;

// Add handler for opening image editor
ipcMain.on('open-image-editor', (event, screenshotContent) => {
  try {
    console.log('Received open-image-editor request with:', screenshotContent);
    const imagePath = screenshotContent.path || screenshotContent;
    
    if (!imagePath) {
      console.error('No image path provided:', screenshotContent);
      return;
    }
    
    console.log('Opening image editor with path:', imagePath);
    
    // Hide main window when opening editor
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
    }
    
    if (!editorWindow || editorWindow.isDestroyed()) {
      editorWindow = new BrowserWindow({
        width: 960, // 20% smaller than 1200
        height: 640, // 20% smaller than 800
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
      
      editorWindow.webContents.once('did-finish-load', () => {
        try {
          const ext = (path.extname(imagePath || '').toLowerCase() || '').replace('.', '');
          const type = (screenshotContent && screenshotContent.type) || (ext === 'mp4' || ext === 'mov' || ext === 'mkv' || ext === 'webm' ? 'video' : 'image');
          console.log('Editor window loaded, detected type:', type, 'path:', imagePath);
          if (type === 'video') {
            editorWindow.webContents.send('load-video', imagePath);
          } else {
            editorWindow.webContents.send('load-image', imagePath);
          }
        } catch (e) {
          console.error('Error sending media to editor:', e);
          editorWindow.webContents.send('load-image', imagePath);
        }
        editorWindow.show();
        editorWindow.focus();
      });

      editorWindow.on('closed', () => {
        editorWindow = null;
        // Show main window when editor closes
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
        }
      });
    } else {
      editorWindow.webContents.send('load-image', imagePath);
      editorWindow.focus();
    }
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
      dataUrl: imageData,
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

// Auto-updater event handlers
if (autoUpdater) {
  autoUpdater.on('checking-for-update', () => {
    console.log('Checking for update...');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', 'Checking for updates...');
    }
  });

  autoUpdater.on('update-available', (info) => {
    console.log('Update available:', info);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-available', info);
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    console.log('Update not available:', info);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-not-available', info);
    }
  });

  autoUpdater.on('error', (err) => {
    console.log('Error in auto-updater:', err);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-error', err.message);
    }
  });

  autoUpdater.on('download-progress', (progressObj) => {
    console.log('Download progress:', progressObj);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-progress', progressObj);
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('Update downloaded:', info);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-downloaded', info);
    }
  });
}

// IPC handlers for update controls
ipcMain.on('check-for-updates', () => {
  if (autoUpdater) {
    autoUpdater.checkForUpdates();
  }
});

ipcMain.on('download-update', () => {
  if (autoUpdater) {
    autoUpdater.downloadUpdate();
  }
});

ipcMain.on('quit-and-install', () => {
  if (autoUpdater) {
    autoUpdater.quitAndInstall();
  }
});

ipcMain.on('set-update-settings', (event, settings) => {
  store.set('autoUpdateEnabled', settings.enabled);
  store.set('updateFrequency', settings.frequency);
});

ipcMain.on('update-last-check', () => {
  store.set('lastUpdateCheck', new Date().toISOString());
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

