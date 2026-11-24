'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage, safeStorage } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const APP_NAME = 'Hearth';
let mainWindow = null;
let tray = null;
let serverProcess = null;
let serverReady = false;
let serverStarting = false;
let serverPort = 7341;
let setupToken = crypto.randomBytes(32).toString('hex');
let adminToken = '';
let restartEnabled = true;
let restartAttempts = 0;
let restartTimer = null;
let lastExit = null;
let childLogs = [];
let quitting = false;
let usingService = false;
let serviceRunning = false;
let serverStoppedByUser = false;

const isPackaged = app.isPackaged;
const serverDir = isPackaged ? path.join(process.resourcesPath, 'server') : path.join(__dirname, '..', 'server');
const desktopDir = isPackaged ? path.join(process.resourcesPath, 'desktop') : __dirname;
const ffmpegDir = isPackaged ? path.join(process.resourcesPath, 'ffmpeg') : '';
const cloudflaredPath = isPackaged ? path.join(process.resourcesPath, 'binaries', 'cloudflared.exe') : process.env.HEARTH_CLOUDFLARED || '';
const serviceWrapperPath = isPackaged ? path.join(process.resourcesPath, 'service', 'HearthService.exe') : path.join(__dirname, '..', 'resources', 'service', 'HearthService.exe');
const dataDir = path.join(app.getPath('userData'), 'ServerData');
const stateFile = path.join(app.getPath('userData'), 'desktop-state.json');

function log(level, message, details) {
  const entry = { time: new Date().toISOString(), level, message, ...(details ? { details } : {}) };
  childLogs.push(JSON.stringify(entry));
  if (childLogs.length > 800) childLogs.shift();
  console.log(JSON.stringify(entry));
}

function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (raw.adminToken && safeStorage.isEncryptionAvailable()) adminToken = safeStorage.decryptString(Buffer.from(raw.adminToken, 'base64'));
    if (raw.adminToken && !safeStorage.isEncryptionAvailable()) adminToken = raw.adminToken;
    restartEnabled = raw.restartEnabled !== false;
    return raw;
  } catch { return {}; }
}

function writeState() {
  const value = {
    restartEnabled,
    adminToken: adminToken ? (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(adminToken).toString('base64') : adminToken) : ''
  };
  try { fs.writeFileSync(stateFile, JSON.stringify(value, null, 2), { mode: 0o600 }); } catch (error) { log('warning', 'Could not persist desktop state', error.message); }
}

function serverArguments() {
  return [path.join(serverDir, 'index.js'), '--data', dataDir, '--setup-token', setupToken,
    ...(ffmpegDir ? ['--ffmpeg-dir', ffmpegDir] : []),
    ...(cloudflaredPath ? ['--cloudflared', cloudflaredPath] : [])];
}

async function startServer(clearToken = false) {
  if (serverStarting || serverProcess || usingService) return;
  serverStarting = true;
  serverReady = false;
  if (clearToken) {
    setupToken = crypto.randomBytes(32).toString('hex');
    adminToken = '';
    writeState();
  }
  log('info', 'Starting Hearth server process');
  try {
    const child = spawn(process.execPath, serverArguments(), {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1' },
      windowsHide: true
    });
    serverProcess = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => {
      const match = String(data).match(/HEARTH_READY\s+([^\s]+):(\d+)/);
      if (match) {
        serverPort = Number(match[2]);
        serverReady = true;
        restartAttempts = 0;
        serverStarting = false;
        log('info', `Hearth server listening on port ${serverPort}`);
        mainWindow?.webContents.send('hearth:server-status', serverStatus());
      }
      String(data).split('\n').filter(Boolean).slice(-40).forEach(line => childLogs.push(line.slice(0, 1000)));
      if (childLogs.length > 1000) childLogs.splice(0, childLogs.length - 1000);
    });
    child.stderr.on('data', data => {
      String(data).split('\n').filter(Boolean).forEach(line => childLogs.push(`{"level":"stderr","message":${JSON.stringify(line.slice(0, 1000))}}`));
    });
    child.once('exit', (code, signal) => {
      const wasProcess = serverProcess === child;
      serverProcess = null;
      serverReady = false;
      serverStarting = false;
      lastExit = { code, signal, at: new Date().toISOString() };
      log(wasProcess && code ? 'error' : 'info', 'Hearth server process exited', { code, signal });
      mainWindow?.webContents.send('hearth:server-status', serverStatus());
      if (!quitting && wasProcess && restartEnabled) {
        restartAttempts++;
        const delay = Math.min(30000, 1500 * Math.max(1, restartAttempts));
        clearTimeout(restartTimer);
        restartTimer = setTimeout(() => startServer(), delay);
      }
    });
    child.once('error', error => {
      log('error', 'Could not launch server process', error.message);
      serverStarting = false;
    });
    // Give slow SQLite initialization a moment to emit HEARTH_READY.
    setTimeout(() => {
      if (!serverReady) {
        serverReady = true;
        serverStarting = false;
        mainWindow?.webContents.send('hearth:server-status', serverStatus());
      }
    }, 3000);
  } catch (error) {
    serverStarting = false;
    log('error', 'Server launch failed', error.message);
    throw error;
  }
}

async function stopServer() {
  clearTimeout(restartTimer);
  restartEnabled = false;
  const child = serverProcess;
  if (!child) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, 4000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}

async function restartServer() {
  if (serviceRunning) return runElevatedServiceCommand('Restart-Service -Name HearthMediaServer');
  await stopServer();
  restartEnabled = true;
  return startServer();
}

function serverStatus() {
  return { running: Boolean(serverProcess) || usingService, serviceMode: usingService, serviceRunning,
    ready: serverReady, port: serverPort, restartEnabled,
    attempts: restartAttempts, lastExit, logs: childLogs.slice(-180) };
}

function readBootstrapPort() {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime', 'bootstrap.json'), 'utf8'));
    if (Number.isInteger(value.port) && value.port >= 1024 && value.port <= 65535) return value.port;
  } catch { /* first run has no bootstrap file yet */ }
  return 7341;
}

async function getServiceStateText() {
  if (process.platform !== 'win32') return 'unsupported';
  return new Promise(resolve => {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', `(Get-Service -Name HearthMediaServer -ErrorAction SilentlyContinue).Status`], { windowsHide: true });
    let output = '';
    child.stdout.on('data', data => output += data);
    child.once('exit', () => resolve(output.trim() || 'NotInstalled'));
  });
}

async function refreshServiceState() {
  const stateText = await getServiceStateText();
  serviceRunning = stateText === 'Running';
  if (serviceRunning) {
    usingService = true;
    serverStoppedByUser = false;
    restartEnabled = true;
    serverPort = readBootstrapPort();
    serverReady = true;
  } else {
    usingService = false;
    if (!serverProcess) serverReady = false;
  }
  return stateText;
}

async function runElevatedServiceCommand(command) {
  const result = await new Promise(resolve => {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command',
      `Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-Command','${command.replace(/'/g, "''")}'`], { windowsHide: true });
    child.once('exit', code => resolve(code));
  });
  const stateText = await refreshServiceState();
  if (result !== 0) throw new Error('The Windows service operation was cancelled or failed');
  return stateText;
}

async function apiRequest(method, requestPath, body) {
  if (!serverReady && !serverProcess && !usingService && !serverStoppedByUser) await startServer();
  if (!serverReady && (serverStarting || serverProcess)) {
    const deadline = Date.now() + 12000;
    while (!serverReady && Date.now() < deadline && (serverStarting || serverProcess)) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  const headers = { 'X-Hearth-Desktop': '1' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (requestPath.startsWith('/api/setup')) headers['X-Hearth-Setup'] = setupToken;
  if (adminToken && !requestPath.startsWith('/api/setup')) headers.Authorization = `Bearer ${adminToken}`;
  const response = await fetch(`http://127.0.0.1:${serverPort}${requestPath}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data;
  const text = await response.text();
  if (!response.ok) log('warning', 'Desktop API request failed', { method, requestPath, status: response.status });
  try { data = JSON.parse(text); } catch { data = text; }
  if (requestPath === '/api/auth/login' && response.ok && data?.token) {
    adminToken = data.token;
    writeState();
    delete data.token;
  }
  if (requestPath.startsWith('/api/setup') && response.ok && data?.token) {
    adminToken = data.token;
    writeState();
    delete data.token;
  }
  return { ok: response.ok, status: response.status, data };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 920, minWidth: 980, minHeight: 640, show: false,
    backgroundColor: '#07070c', title: 'Hearth Control Panel',
    icon: path.join(isPackaged ? process.resourcesPath : path.join(__dirname, '..'), 'build', 'icon.ico'),
    webPreferences: { preload: path.join(desktopDir, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: false },
    autoHideMenuBar: true
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(desktopDir, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', event => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

function createTray() {
  const iconPath = path.join(isPackaged ? process.resourcesPath : path.join(__dirname, '..'), 'build', 'icon.png');
  tray = new Tray(fs.existsSync(iconPath) ? iconPath : nativeImage.createEmpty());
  tray.setToolTip('Hearth Media Server');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Hearth', click: () => mainWindow?.show() },
    { label: 'Restart Server', click: () => restartServer() },
    { type: 'separator' },
    { label: 'Quit Hearth', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('click', () => mainWindow?.show());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { mainWindow?.show(); });
  app.whenReady().then(async () => {
    readState();
    try {
      const serviceState = await refreshServiceState();
      if (serviceState === 'Running') usingService = true;
    } catch { /* fall back to the desktop-managed server process */ }
    createWindow();
    createTray();
    if (!usingService) {
      try { await startServer(); } catch (error) { dialog.showErrorBox('Hearth startup error', error.message); }
    }
  });
  app.on('before-quit', async event => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    await stopServer();
    app.exit(0);
  });
  app.on('window-all-closed', () => { /* remain in tray */ });
}

ipcMain.handle('hearth:request', (event, payload) => apiRequest(payload.method, payload.path, payload.body));
ipcMain.handle('hearth:server-status', () => serverStatus());
ipcMain.handle('hearth:control', async (event, action) => {
  if (process.platform === 'win32') {
    const stateText = await refreshServiceState();
    if (stateText !== 'NotInstalled' && stateText !== 'unsupported') {
      if (action === 'start') {
        serverStoppedByUser = false;
        if (stateText !== 'Running') {
          await stopServer();
          await runElevatedServiceCommand('Start-Service -Name HearthMediaServer');
        }
        return serverStatus();
      }
      if (action === 'stop') {
        if (stateText === 'Running') await runElevatedServiceCommand('Stop-Service -Name HearthMediaServer');
        await stopServer();
        serverStoppedByUser = true;
        return serverStatus();
      }
      if (action === 'restart') {
        serverStoppedByUser = false;
        await stopServer();
        await runElevatedServiceCommand('Restart-Service -Name HearthMediaServer');
        return serverStatus();
      }
    }
  }
  if (action === 'start') { restartEnabled = true; serverStoppedByUser = false; await startServer(); return serverStatus(); }
  if (action === 'stop') { serverStoppedByUser = true; await stopServer(); return serverStatus(); }
  if (action === 'restart') { serverStoppedByUser = false; await restartServer(); return serverStatus(); }
  if (action === 'reset-setup') { serverStoppedByUser = false; await stopServer(); restartEnabled = true; await startServer(true); return serverStatus(); }
  throw new Error('Unknown action');
});
ipcMain.handle('hearth:set-restart', (event, enabled) => { restartEnabled = Boolean(enabled); writeState(); return serverStatus(); });
ipcMain.handle('hearth:set-login-item', (event, enabled) => { app.setLoginItemSettings({ openAsHidden: true, openAtLogin: Boolean(enabled) }); return app.getLoginItemSettings(); });
ipcMain.handle('hearth:get-login-item', () => app.getLoginItemSettings());
ipcMain.handle('hearth:pick-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'multiSelections'] });
  return result.canceled ? [] : result.filePaths;
});
ipcMain.handle('hearth:pick-file', async (event, filters) => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('hearth:save-file', async (event, defaultName) => {
  const result = await dialog.showSaveDialog(mainWindow, { defaultPath: defaultName });
  return result.canceled ? null : result.filePath;
});
ipcMain.handle('hearth:download', async (event, { path: downloadPath, defaultName }) => {
  const target = await dialog.showSaveDialog(mainWindow, { defaultPath: defaultName || 'hearth-backup.hearthbackup' });
  if (target.canceled) return null;
  const response = await fetch(`http://127.0.0.1:${serverPort}${downloadPath}`, { headers: { Authorization: `Bearer ${adminToken}` } });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  fs.writeFileSync(target.filePath, Buffer.from(await response.arrayBuffer()));
  return target.filePath;
});
ipcMain.handle('hearth:upload-restore', async (event, backupPath) => {
  if (!backupPath || !fs.existsSync(backupPath)) throw new Error('Backup file not found');
  if (process.platform === 'win32') {
    const stateText = await refreshServiceState();
    if (stateText === 'Running') await runElevatedServiceCommand('Stop-Service -Name HearthMediaServer');
  }
  await stopServer();
  const target = path.join(dataDir, 'library.sqlite');
  const preRestore = path.join(dataDir, `pre-restore-${Date.now()}.sqlite`);
  if (fs.existsSync(target)) fs.copyFileSync(target, preRestore);
  fs.copyFileSync(backupPath, target);
  for (const suffix of ['-wal', '-shm']) {
    try { fs.unlinkSync(target + suffix); } catch { /* no active WAL file */ }
  }
  restartEnabled = true;
  serverStoppedByUser = false;
  await startServer();
  return { restored: true, previousBackup: path.basename(preRestore) };
});
ipcMain.handle('hearth:open-external', (event, url) => shell.openExternal(url));
ipcMain.handle('hearth:show-item', (event, targetPath) => shell.showItemInFolder(targetPath));
ipcMain.handle('hearth:service-install', async () => {
  if (process.platform !== 'win32') throw new Error('Windows service management is only available on Windows');
  const script = path.join(process.resourcesPath, 'service', 'install-service.ps1');
  const wasChildRunning = Boolean(serverProcess);
  await stopServer();
  const command = `& '${script}' -DataDir '${dataDir}' -ResourcesDir '${process.resourcesPath}' -Port ${serverPort}`;
  try {
    await runElevatedServiceCommand(command);
  } catch (error) {
    if (wasChildRunning) { restartEnabled = true; await startServer(); }
    throw error;
  }
  if (!serviceRunning) throw new Error('The Windows service was installed but did not start');
  return { installed: serviceRunning, status: await getServiceStateText() };
});
ipcMain.handle('hearth:service-control', async (event, action) => {
  if (process.platform !== 'win32') throw new Error('Windows service management is only available on Windows');
  const commands = {
    start: 'Start-Service -Name HearthMediaServer',
    stop: 'Stop-Service -Name HearthMediaServer',
    uninstall: `& '${serviceWrapperPath}' uninstall; sc.exe delete HearthMediaServer`
  };
  const stateText = await runElevatedServiceCommand(commands[action]);
  if (action === 'start' && stateText !== 'Running') throw new Error('The Windows service did not start');
  if (action === 'stop' && stateText === 'Running') throw new Error('The Windows service did not stop');
      if (action === 'uninstall') {
        restartEnabled = true;
        serverStoppedByUser = false;
        await startServer();
      }
  return { status: stateText };
});
ipcMain.handle('hearth:service-status', async () => {
  if (process.platform !== 'win32') return { available: false, status: 'unsupported' };
  const status = await refreshServiceState();
  return { available: true, status, serviceMode: usingService };
});
ipcMain.handle('hearth:update-check', async (event, manifestUrl) => {
  if (!/^https:\/\//i.test(manifestUrl || '')) throw new Error('Update manifest must use HTTPS');
  const response = await fetch(manifestUrl, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Update manifest request failed (${response.status})`);
  return response.json();
});
ipcMain.handle('hearth:update-download', async (event, { url, expectedSha256 }) => {
  if (!/^https:\/\//i.test(url || '')) throw new Error('Update package must use HTTPS');
  const target = path.join(app.getPath('temp'), `Hearth-${Date.now()}.exe`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Update download failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (expectedSha256 && hash.toLowerCase() !== expectedSha256.toLowerCase()) throw new Error('Update checksum verification failed');
  fs.writeFileSync(target, bytes, { mode: 0o755 });
  return { path: target, hash, size: bytes.length };
});
ipcMain.handle('hearth:update-run', async (event, installerPath) => {
  if (process.platform === 'win32') {
    const stateText = await refreshServiceState();
    if (stateText === 'Running') await runElevatedServiceCommand('Stop-Service -Name HearthMediaServer');
  }
  await stopServer();
  const child = spawn(installerPath, ['/S', '/SUPPRESSMSGBOXES', '/NORESTART'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  setTimeout(() => {
    quitting = true;
    app.quit();
  }, 1500);
  return { launched: true, path: installerPath };
});
