/* Main process: window, menu, lifecycle (spec 4.1). */
import { app, BrowserWindow, Menu, session, shell, type MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CHANNELS } from '../../shared/ipc';
import { bringOldSettings } from './migrate';
import { registerIpc } from './ipc';
import { PathPolicy } from './paths';
import { ExportWatcher } from './project-fs';
import { QuicksaveHistory, QuicksaveWatcher } from './quicksave';
import { RecentFolders } from './recent';
import { SettingsStore } from './settings';

// the settings of KickReasm Studio, as Mimir Studio was called, come along once (before the window opens its storage)
bringOldSettings(app.getPath('appData'), app.getPath('userData'), app.getName());

const devUrl = process.env.ELECTRON_RENDERER_URL;
const rendererFile = join(__dirname, '../renderer/index.html');
const rendererUrl = pathToFileURL(rendererFile).href;
const isTrustedUrl = (url: string) => (devUrl ? url.startsWith(devUrl) : url.split('#')[0].split('?')[0] === rendererUrl);

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1480, height: 920, minWidth: 760, minHeight: 520,
    show: false, backgroundColor: '#121218', autoHideMenuBar: true, title: 'Mimir Studio',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  // no in-app navigation and no new windows; external https links open in the browser
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//i.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!isTrustedUrl(url)) e.preventDefault(); });
  if (devUrl) {
    // during development, renderer warnings and errors also show up in the terminal
    win.webContents.on('console-message', (...args: unknown[]) => {
      const ev = args[0] as { level?: unknown; message?: string; sourceId?: string; lineNumber?: number };
      const level = ev.level ?? args[1], message = ev.message ?? args[2];
      if (level === 'warning' || level === 'error' || level === 2 || level === 3) console.log(`[renderer ${String(level)}] ${String(message)}`);
    });
    win.webContents.on('preload-error', (_e, path, error) => console.log(`[preload error] ${path}: ${error.message}`));
    win.webContents.on('did-finish-load', () => console.log('[renderer] loaded'));
  }
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(rendererFile);
  return win;
}

function buildMenu() {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  // the app's own page may write to the clipboard ("Copy file", "Copy command"); everything else
  // (camera, notifications, geolocation …) is denied
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(permission === 'clipboard-sanitized-write' && isTrustedUrl(wc.getURL())));
  const watcher = new ExportWatcher(path => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(CHANNELS.fsChanged, { path });
  });
  // a new quicksave from VICE (Alt+F11) joins the kept ones, then goes to every window, which opens it
  const history = new QuicksaveHistory(join(app.getPath('userData'), 'quicksaves'));
  const quicksave = new QuicksaveWatcher(e => {
    void history.add(e.path, e.saved).catch(() => null).then(() => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send(CHANNELS.viceQuicksaved, e);
    });
  });
  registerIpc({ policy: new PathPolicy(), settings: new SettingsStore(app.getPath('userData')), recent: new RecentFolders(app.getPath('userData')), watcher, isTrustedUrl, quicksave, history });
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  app.on('before-quit', () => { watcher.close(); quicksave.close(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
