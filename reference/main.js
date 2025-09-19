const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { exec, spawn } = require('child_process');
const windowTracker = require('./windowTracker');
const fs = require('fs');
const https = require('https');
const { pipeline } = require('stream');

const WINDOW_WIDTH = 432;
const WINDOW_HEIGHT = 648;

let mainWindow;
let settingsWindow;
let shortcutsWindow;
let currentDevice = '';
const base = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
const adb = process.platform === 'win32' ? `"${path.join(base, 'adb.exe')}"` : 'adb';
const scrcpyExecutable = process.platform === 'win32' ? path.join(base, 'scrcpy.exe') : 'scrcpy';
const aapt2 = process.platform === 'win32' ? `"${path.join(base, 'aapt2.exe')}"` : 'aapt2';
let PREF_PATH;
let appLabelCache = null;
const labelQueue = [];
const queuedLabelPackages = new Set();
let isProcessingLabels = false;
const TEMP_APK_NAME = '__tmp_app_label.apk';
const DEFAULT_GLOBAL_SETTINGS = {
  closeOnVdClose: true,
  mirrorBitRate: 10,
  appBitRate: 8,
  turnScreenOffOnApps: false,
  turnScreenOffOnMirror: false,
  preventDeviceSleep: true,
  autoStartAudio: true
};

const fsp = fs.promises;
const resourcesDir = path.join(__dirname, 'Resources');
const ICON_PATH = path.join(resourcesDir, 'icon.png');
const AAPT2_FILENAME = 'aapt2.exe';

const SCRCPY_RELEASE_API = 'https://api.github.com/repos/Genymobile/scrcpy/releases/latest';
const SCRCPY_MARKER_PREFIX = 'scrcpy-win64-v';
const SCRCPY_DOWNLOAD_IDENTIFIER = 'scrcpy-win64';
const SCRCPY_ARCHIVE_EXTENSION = '.zip';
const SCRCPY_USER_AGENT = 'SmallScrcpyLauncher/1.0';
const SCRCPY_MAX_REDIRECTS = 5;
const DOWNLOAD_CONTEXT_INITIAL = 'initial';
const DOWNLOAD_CONTEXT_UPDATE = 'update';

let latestReleaseCache = null;
let ongoingScrcpyDownload = null;
let installedScrcpyInfo = null;

let cachedGlobalSettings = null;

async function ensureResourceFile(fileName) {
  if (!fileName) return null;
  const targetPath = path.join(base, fileName);
  try {
    await fsp.access(targetPath, fs.constants.F_OK);
    return targetPath;
  } catch {
    // continue to copy
  }

  const sourcePath = path.join(resourcesDir, fileName);
  try {
    await fsp.access(sourcePath, fs.constants.F_OK);
  } catch (error) {
    console.error(`No se encontró ${fileName} en los recursos:`, error);
    return null;
  }

  try {
    await fsp.copyFile(sourcePath, targetPath);
    return targetPath;
  } catch (error) {
    console.error(`No se pudo copiar ${fileName} al directorio base:`, error);
    return null;
  }
}

async function ensureAapt2Available() {
  if (process.platform !== 'win32') return;
  try {
    await ensureResourceFile(AAPT2_FILENAME);
  } catch (error) {
    console.error('No se pudo asegurar la presencia de aapt2.exe:', error);
  }
}

function normalizeVersion(version) {
  if (version === undefined || version === null) return null;
  const value = String(version).trim();
  if (!value) return null;
  const withoutPrefix = value.replace(/^v/i, '');
  if (!withoutPrefix) return null;
  const rawParts = withoutPrefix.split('.');
  const parts = [];
  for (let i = 0; i < rawParts.length && parts.length < 3; i += 1) {
    const segment = rawParts[i];
    if (typeof segment !== 'string') {
      parts.push('0');
      continue;
    }
    const match = segment.match(/^(\d+)/);
    parts.push(match ? match[1] : '0');
  }
  while (parts.length < 3) {
    parts.push('0');
  }
  return parts.join('.');
}

function normalizeTag(version) {
  const normalized = normalizeVersion(version);
  return normalized ? `v${normalized}` : null;
}

function compareVersions(a, b) {
  const parse = (input) => {
    const normalized = normalizeVersion(input);
    if (!normalized) return [0, 0, 0];
    return normalized.split('.').map((part) => Number.parseInt(part, 10) || 0);
  };
  const left = parse(a);
  const right = parse(b);
  const maxLength = Math.max(left.length, right.length);
  for (let i = 0; i < maxLength; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff > 0) return 1;
    if (diff < 0) return -1;
  }
  return 0;
}

function extractVersionFromMarker(name) {
  if (typeof name !== 'string') return null;
  if (!name.startsWith(SCRCPY_MARKER_PREFIX)) return null;
  return normalizeVersion(name.slice(SCRCPY_MARKER_PREFIX.length));
}

function extractVersionFromAssetName(name) {
  if (typeof name !== 'string') return null;
  const markerMatch = name.match(/scrcpy-win64-v([\d.]+)/i);
  if (markerMatch && markerMatch[1]) {
    return normalizeVersion(markerMatch[1]);
  }
  const genericMatch = name.match(/v([\d.]+)/i);
  if (genericMatch && genericMatch[1]) {
    return normalizeVersion(genericMatch[1]);
  }
  return null;
}

async function listMarkerDirectories() {
  try {
    const entries = await fsp.readdir(base, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(SCRCPY_MARKER_PREFIX))
      .map((entry) => entry.name);
  } catch (error) {
    return [];
  }
}

async function getInstalledMarkerInfo(forceRefresh = false) {
  if (!forceRefresh && installedScrcpyInfo) {
    return installedScrcpyInfo;
  }
  const markers = await listMarkerDirectories();
  if (!markers.length) {
    installedScrcpyInfo = null;
    return null;
  }
  let selectedMarker = markers[0];
  let selectedVersion = extractVersionFromMarker(selectedMarker) || '0.0.0';
  for (let i = 1; i < markers.length; i += 1) {
    const marker = markers[i];
    const version = extractVersionFromMarker(marker) || '0.0.0';
    if (compareVersions(version, selectedVersion) > 0) {
      selectedMarker = marker;
      selectedVersion = version;
    }
  }
  installedScrcpyInfo = { markerName: selectedMarker, version: selectedVersion };
  return installedScrcpyInfo;
}

function emitScrcpyEvent(type, payload = {}) {
  if (!type) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('scrcpy-lifecycle-event', { type, payload });
  }
}

const SCRCPY_ERROR_MESSAGES = {
  network: 'Error de conexión a internet.',
  download: 'Error en la descarga.',
  extract: 'Error en la descompresión.',
  corrupt: 'Archivo corrupto.',
};

function getScrcpyErrorPayload(error) {
  if (!error) {
    return { code: 'unknown', message: 'Ocurrió un error inesperado.' };
  }
  const code = typeof error.code === 'string' ? error.code : (error.code ? String(error.code) : 'unknown');
  const message = typeof error.userMessage === 'string' && error.userMessage.trim()
    ? error.userMessage.trim()
    : (SCRCPY_ERROR_MESSAGES[code] || 'Ocurrió un error inesperado.');
  return { code, message };
}

function fetchJson(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (!url) {
      const error = new Error('URL inválida.');
      error.code = 'network';
      reject(error);
      return;
    }
    if (redirectCount > SCRCPY_MAX_REDIRECTS) {
      const error = new Error('Demasiadas redirecciones.');
      error.code = 'network';
      reject(error);
      return;
    }
    const request = https.get(url, {
      headers: {
        'User-Agent': SCRCPY_USER_AGENT,
        Accept: 'application/vnd.github+json',
        'Accept-Encoding': 'identity',
      },
    }, (response) => {
      const { statusCode = 0, headers = {} } = response;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        response.resume();
        const redirected = new URL(headers.location, url).toString();
        resolve(fetchJson(redirected, redirectCount + 1));
        return;
      }
      if (statusCode !== 200) {
        response.resume();
        const error = new Error(`Respuesta inesperada (${statusCode}).`);
        error.code = 'network';
        reject(error);
        return;
      }
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        raw += chunk;
      });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          resolve(parsed);
        } catch (parseError) {
          const error = parseError instanceof Error ? parseError : new Error('Respuesta inválida.');
          error.code = 'network';
          reject(error);
        }
      });
    });
    request.on('error', (error) => {
      const err = error instanceof Error ? error : new Error(String(error || 'Error de red.'));
      err.code = 'network';
      reject(err);
    });
  });
}

function extractChangelogSummary(raw) {
  if (typeof raw !== 'string') {
    return '';
  }

  const lines = raw.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.trim().toLowerCase().startsWith('**scrcpy v'));
  if (startIndex === -1) {
    return raw.trim();
  }

  const result = [];
  let encounteredList = false;

  for (let index = startIndex; index < lines.length; index += 1) {
    const originalLine = lines[index];
    const trimmed = originalLine.trim();

    if (index !== startIndex) {
      if (!trimmed && encounteredList) {
        break;
      }
      if (trimmed.startsWith('---')) {
        break;
      }
      if (trimmed.startsWith('<a ')) {
        break;
      }
      if (/^#+\s+/u.test(trimmed)) {
        break;
      }
    }

    result.push(trimmed ? originalLine.trimEnd() : '');
    if (trimmed.startsWith('- ')) {
      encounteredList = true;
    }
  }

  const summary = result.join('\n').trim();
  return summary || raw.trim();
}

async function fetchLatestRelease(force = false) {
  if (!force && latestReleaseCache) {
    return latestReleaseCache;
  }
  const data = await fetchJson(SCRCPY_RELEASE_API);
  if (!data || typeof data !== 'object') {
    const error = new Error('No se pudo obtener la información de la versión.');
    error.code = 'network';
    throw error;
  }
  const assets = Array.isArray(data.assets) ? data.assets : [];
  const asset = assets.find((item) => {
    if (!item || typeof item !== 'object') return false;
    const { name, browser_download_url: downloadUrl } = item;
    if (typeof name !== 'string' || typeof downloadUrl !== 'string') return false;
    const normalizedName = name.toLowerCase();
    return normalizedName.includes(SCRCPY_DOWNLOAD_IDENTIFIER) && normalizedName.endsWith(SCRCPY_ARCHIVE_EXTENSION);
  });
  if (!asset || typeof asset.browser_download_url !== 'string') {
    const error = new Error('No se encontró el paquete de Windows x64.');
    error.code = 'download';
    throw error;
  }

  const normalizedVersion = normalizeVersion(data.tag_name) || extractVersionFromAssetName(asset.name);
  if (!normalizedVersion) {
    const error = new Error('No se pudo determinar la versión de scrcpy.');
    error.code = 'corrupt';
    throw error;
  }

  const tagName = normalizeTag(data.tag_name) || normalizeTag(normalizedVersion) || null;
  const releaseName = typeof data.name === 'string' && data.name.trim()
    ? data.name.trim()
    : `scrcpy ${tagName || normalizeTag(normalizedVersion) || ''}`.trim();
  const rawChangelog = typeof data.body === 'string' ? data.body : '';
  const changelog = extractChangelogSummary(rawChangelog);

  latestReleaseCache = {
    raw: data,
    asset: {
      name: typeof asset.name === 'string'
        ? asset.name
        : `${SCRCPY_DOWNLOAD_IDENTIFIER}-${tagName || normalizedVersion}${SCRCPY_ARCHIVE_EXTENSION}`,
      url: asset.browser_download_url,
      size: Number(asset.size) || null,
    },
    normalizedVersion,
    tagName,
    releaseName,
    changelog,
  };
  return latestReleaseCache;
}

async function removePathIfExists(targetPath) {
  if (!targetPath) return;
  try {
    await fsp.rm(targetPath, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

async function downloadFile(url, destination, onProgress) {
  let resolved = false;
  let rejectedError = null;
  let current = 0;
  try {
    await new Promise((resolve, reject) => {
      const attempt = (nextUrl, redirectCount = 0) => {
        if (!nextUrl) {
          const error = new Error('URL inválida.');
          error.code = 'download';
          reject(error);
          return;
        }
        if (redirectCount > SCRCPY_MAX_REDIRECTS) {
          const error = new Error('Demasiadas redirecciones en la descarga.');
          error.code = 'download';
          reject(error);
          return;
        }
        const request = https.get(nextUrl, {
          headers: {
            'User-Agent': SCRCPY_USER_AGENT,
            Accept: 'application/octet-stream',
            'Accept-Encoding': 'identity',
          },
        }, (response) => {
          const { statusCode = 0, headers = {} } = response;
          if (statusCode >= 300 && statusCode < 400 && headers.location) {
            response.resume();
            const redirected = new URL(headers.location, nextUrl).toString();
            attempt(redirected, redirectCount + 1);
            return;
          }
          if (statusCode !== 200) {
            response.resume();
            const error = new Error(`Error de descarga (${statusCode}).`);
            error.code = statusCode === 404 ? 'download' : 'network';
            reject(error);
            return;
          }
          const total = Number(headers['content-length']) || 0;
          current = 0;
          const fileStream = fs.createWriteStream(destination);
          response.on('data', (chunk) => {
            current += chunk.length;
            if (typeof onProgress === 'function') {
              const percent = total > 0 ? Math.min(100, (current / total) * 100) : null;
              onProgress({ received: current, total, percent });
            }
          });
          response.on('error', (error) => {
            fileStream.destroy();
            const err = error instanceof Error ? error : new Error(String(error || 'Error en la descarga.'));
            const originalCode = error && error.code ? String(error.code) : undefined;
            if (!err.code) err.code = originalCode === 'ENOTFOUND' ? 'network' : 'download';
            reject(err);
          });
          pipeline(response, fileStream, (error) => {
            if (error) {
              const err = error instanceof Error ? error : new Error(String(error || 'Error en la descarga.'));
              const originalCode = error && error.code ? String(error.code) : undefined;
              if (!err.code) {
                err.code = originalCode === 'ENOTFOUND' ? 'network' : 'download';
              }
              reject(err);
              return;
            }
            resolve();
          });
        });
        request.on('error', (error) => {
          const err = error instanceof Error ? error : new Error(String(error || 'Error en la descarga.'));
          const originalCode = error && error.code ? String(error.code) : undefined;
          if (!err.code) err.code = originalCode === 'ENOTFOUND' ? 'network' : 'download';
          reject(err);
        });
      };
      attempt(url);
    });
    resolved = true;
  } catch (error) {
    rejectedError = error;
    throw error;
  } finally {
    if (!resolved && rejectedError) {
      await removePathIfExists(destination);
    }
  }
}

async function extractArchive(archivePath) {
  return new Promise((resolve, reject) => {
    const extraction = spawn('tar', ['-xf', archivePath], { cwd: base, windowsHide: true });
    let stderr = '';
    extraction.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    extraction.on('error', (error) => {
      const err = error instanceof Error ? error : new Error(String(error || 'Error al descomprimir.'));
      err.code = err.code || 'extract';
      reject(err);
    });
    extraction.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const error = new Error(stderr.trim() || `La descompresión finalizó con código ${code}.`);
      error.code = 'extract';
      reject(error);
    });
  });
}

async function finalizeScrcpyInstallation({ normalizedVersion, expectedMarker, existingMarkers }) {
  const existingSet = existingMarkers instanceof Set ? existingMarkers : new Set(existingMarkers || []);
  let markers = await listMarkerDirectories();
  let markerName = markers.includes(expectedMarker) ? expectedMarker : null;
  if (!markerName) {
    const newMarkers = markers.filter((marker) => !existingSet.has(marker));
    if (newMarkers.length) {
      markerName = newMarkers[0];
    } else if (markers.length) {
      markerName = markers[0];
    }
  }
  if (!markerName) {
    const error = new Error('No se encontró la carpeta extraída de scrcpy.');
    error.code = 'corrupt';
    throw error;
  }
  if (markerName !== expectedMarker) {
    await removePathIfExists(path.join(base, expectedMarker));
    await fsp.rename(path.join(base, markerName), path.join(base, expectedMarker));
    markerName = expectedMarker;
  }

  const markerPath = path.join(base, markerName);
  const contents = await fsp.readdir(markerPath);
  for (const entry of contents) {
    const source = path.join(markerPath, entry);
    const destination = path.join(base, entry);
    await removePathIfExists(destination);
    await fsp.rename(source, destination);
  }

  markers = await listMarkerDirectories();
  for (const marker of markers) {
    if (marker !== markerName) {
      await removePathIfExists(path.join(base, marker));
    }
  }

  installedScrcpyInfo = { markerName, version: normalizedVersion };
  return markerName;
}

async function downloadAndInstallScrcpy(release, context) {
  if (!release || !release.asset || !release.asset.url) {
    const error = new Error('No hay un paquete de descarga disponible.');
    error.code = 'download';
    throw error;
  }
  if (ongoingScrcpyDownload) {
    const error = new Error('Ya existe una descarga en progreso.');
    error.code = 'busy';
    throw error;
  }

  ongoingScrcpyDownload = context;
  const normalizedVersion = release.normalizedVersion;
  const expectedMarker = `${SCRCPY_MARKER_PREFIX}${normalizedVersion}`;
  const archiveName = release.asset.name && release.asset.name.endsWith(SCRCPY_ARCHIVE_EXTENSION)
    ? release.asset.name
    : `${expectedMarker}${SCRCPY_ARCHIVE_EXTENSION}`;
  const archivePath = path.join(base, archiveName);
  const startEvent = context === DOWNLOAD_CONTEXT_UPDATE ? 'update-started' : 'initial-download-started';
  emitScrcpyEvent(startEvent, {
    version: normalizedVersion,
    releaseName: release.releaseName,
    size: release.asset.size || null,
  });

  const existingMarkers = new Set(await listMarkerDirectories());
  await removePathIfExists(archivePath);
  await removePathIfExists(path.join(base, expectedMarker));

  try {
    emitScrcpyEvent('download-stage', { context, stage: 'downloading' });
    await downloadFile(release.asset.url, archivePath, (progress) => {
      emitScrcpyEvent('download-progress', { context, ...progress });
    });

    emitScrcpyEvent('download-stage', { context, stage: 'extracting' });
    await extractArchive(archivePath);

    emitScrcpyEvent('download-stage', { context, stage: 'installing' });
    await finalizeScrcpyInstallation({
      normalizedVersion,
      expectedMarker,
      existingMarkers,
    });

    const completeEvent = context === DOWNLOAD_CONTEXT_UPDATE ? 'update-complete' : 'initial-download-complete';
    emitScrcpyEvent(completeEvent, {
      version: normalizedVersion,
      releaseName: release.releaseName,
    });
  } catch (error) {
    const payload = getScrcpyErrorPayload(error);
    const event = context === DOWNLOAD_CONTEXT_UPDATE ? 'update-error' : 'initial-download-error';
    emitScrcpyEvent(event, payload);
    if (error && typeof error === 'object') {
      error.scrcpyHandled = true;
    }
    throw error;
  } finally {
    ongoingScrcpyDownload = null;
    await removePathIfExists(archivePath);
  }
}

async function initializeScrcpyLifecycle() {
  const adbPath = path.join(base, 'adb.exe');
  const hasAdb = fs.existsSync(adbPath);
  const installed = await getInstalledMarkerInfo(true);
  let release;
  try {
    release = await fetchLatestRelease();
  } catch (error) {
    if (!hasAdb || !installed) {
      const payload = getScrcpyErrorPayload(error);
      emitScrcpyEvent('initial-download-error', payload);
    } else {
      const payload = getScrcpyErrorPayload(error);
      emitScrcpyEvent('update-check-error', payload);
    }
    return;
  }

  if (!hasAdb || !installed) {
    try {
      await downloadAndInstallScrcpy(release, DOWNLOAD_CONTEXT_INITIAL);
    } catch (error) {
      console.error('Error instalando scrcpy por primera vez:', error);
    }
    return;
  }

  if (compareVersions(installed.version, release.normalizedVersion) < 0) {
    emitScrcpyEvent('update-available', {
      currentVersion: installed.version,
      version: release.normalizedVersion,
      releaseName: release.releaseName,
      tagName: release.tagName,
      changelog: release.changelog,
      size: release.asset.size || null,
    });
  }
}

function sanitizeBitRate(value) {
  if (value === undefined || value === null) return undefined;
  const normalized = typeof value === 'string' ? value.trim() : value;
  if (normalized === '') return undefined;
  const num = Number(normalized);
  if (!Number.isFinite(num)) return undefined;
  const int = Math.round(num);
  if (int < 1) return 1;
  if (int > 32) return 32;
  return int;
}

function buildWindowTitleArgs(title) {
  if (typeof title !== 'string') return [];
  const normalized = title.trim().replace(/\s+/g, ' ');
  if (!normalized) return [];
  return ['--window-title', normalized];
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    frame: false,
    resizable: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.once('ready-to-show', () => {
    const [x, y] = mainWindow.getPosition();
    mainWindow.setPosition(x - 7, y - 7);
    mainWindow.show();
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.webContents.once('did-finish-load', () => {
    initializeScrcpyLifecycle();
  });

  mainWindow.on('closed', () => {
    if (settingsWindow) {
      settingsWindow.close();
      settingsWindow = null;
    }
    if (shortcutsWindow) {
      shortcutsWindow.close();
      shortcutsWindow = null;
    }
    mainWindow = null;
  });
}

function createSettingsWindow() {
  if (settingsWindow) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.focus();
    return settingsWindow;
  }

  settingsWindow = new BrowserWindow({
    width: 556,
    height: 560,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    transparent: true,
    backgroundColor: '#00000000',
    parent: mainWindow || undefined,
    show: false,
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  settingsWindow.setMenuBarVisibility(false);

  settingsWindow.once('ready-to-show', () => {
    const [x, y] = settingsWindow.getPosition();
    settingsWindow.setPosition(x - 7, y - 7);
    settingsWindow.show();
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });

  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  return settingsWindow;
}

function createShortcutsWindow() {
  if (shortcutsWindow) {
    if (shortcutsWindow.isMinimized()) shortcutsWindow.restore();
    shortcutsWindow.focus();
    return shortcutsWindow;
  }

  shortcutsWindow = new BrowserWindow({
    width: 556,
    height: 640,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    transparent: true,
    backgroundColor: '#00000000',
    parent: mainWindow || undefined,
    show: false,
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  shortcutsWindow.setMenuBarVisibility(false);

  shortcutsWindow.once('ready-to-show', () => {
    const [x, y] = shortcutsWindow.getPosition();
    shortcutsWindow.setPosition(x - 7, y - 7);
    shortcutsWindow.show();
  });

  shortcutsWindow.on('closed', () => {
    shortcutsWindow = null;
  });

  shortcutsWindow.loadFile(path.join(__dirname, 'shortcuts.html'));
  return shortcutsWindow;
}

app.whenReady().then(async () => {
  PREF_PATH = path.join(app.getPath('userData'), 'preferences.json');
  await ensureAapt2Available();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.on('move-window', (event, deltaX, deltaY) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
  const [x, y] = win.getPosition();
  const nextX = Math.round(x + deltaX);
  const nextY = Math.round(y + deltaY);
  win.setPosition(nextX, nextY);
});

function readPrefs() {
  if (!PREF_PATH) return {};
  try {
    return JSON.parse(fs.readFileSync(PREF_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writePrefs(prefs) {
  if (!PREF_PATH) return;
  fs.writeFileSync(PREF_PATH, JSON.stringify(prefs, null, 2));
}

function getAppLabelCache() {
  if (appLabelCache) return appLabelCache;
  const prefs = readPrefs();
  appLabelCache = { ...(prefs.__appLabels || {}) };
  return appLabelCache;
}

function persistAppLabels(labels) {
  const prefs = readPrefs();
  prefs.__appLabels = labels;
  writePrefs(prefs);
  appLabelCache = labels;
}

function getCachedLabel(pkg) {
  return getAppLabelCache()[pkg];
}

function rememberAppLabel(pkg, label) {
  if (!pkg || !label) return;
  const labels = { ...getAppLabelCache() };
  if (labels[pkg] === label) return;
  labels[pkg] = label;
  persistAppLabels(labels);
}

function buildAdbCommand(args, deviceOverride) {
  const override = typeof deviceOverride === 'string' ? deviceOverride.trim() : '';
  const activeDevice = override || (typeof currentDevice === 'string' ? currentDevice.trim() : '');
  const deviceArgs = activeDevice ? ` -s ${activeDevice}` : '';
  return `${adb}${deviceArgs} ${args}`;
}

function queueAppLabels(packages = []) {
  const labels = getAppLabelCache();
  packages.forEach(pkg => {
    if (!pkg || labels[pkg] || queuedLabelPackages.has(pkg)) return;
    queuedLabelPackages.add(pkg);
    labelQueue.push(pkg);
  });
  processLabelQueue();
}

async function processLabelQueue() {
  if (isProcessingLabels) return;
  isProcessingLabels = true;
  while (labelQueue.length) {
    const pkg = labelQueue.shift();
    queuedLabelPackages.delete(pkg);
    if (!pkg || getCachedLabel(pkg)) continue;

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('package-label-started', pkg);
    }

    let label = null;
    try {
      label = await extractLabelForPackage(pkg);
      if (label) {
        rememberAppLabel(pkg, label);
      }
    } catch (error) {
      console.error(`Failed to extract label for ${pkg}:`, error);
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('package-label-updated', {
        package: pkg,
        name: label || pkg,
        success: Boolean(label)
      });
    }
  }
  isProcessingLabels = false;
}

async function extractLabelForPackage(pkg) {
  const tempApkPath = path.join(base, TEMP_APK_NAME);
  try {
    const pathOutput = await run(buildAdbCommand(`shell pm path ${pkg}`));
    const lines = pathOutput
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    if (!lines.length) return null;
    const remoteLine = lines.find(line => line.includes('base.apk')) || lines[0];
    if (!remoteLine) return null;
    const remotePath = remoteLine.startsWith('package:') ? remoteLine.slice('package:'.length).trim() : remoteLine;
    if (!remotePath) return null;

    try {
      if (fs.existsSync(tempApkPath)) fs.unlinkSync(tempApkPath);
    } catch {
      // ignore
    }

    await run(buildAdbCommand(`pull "${remotePath}" "${TEMP_APK_NAME}"`));
    if (!fs.existsSync(tempApkPath)) return null;

    const dumpOutput = await run(`${aapt2} dump badging "${TEMP_APK_NAME}"`);
    return parseLabelFromDump(dumpOutput);
  } finally {
    try {
      if (fs.existsSync(tempApkPath)) fs.unlinkSync(tempApkPath);
    } catch {
      // ignore
    }
  }
}

function parseLabelFromDump(output) {
  if (!output) return null;
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const esLine = lines.find(line => line.startsWith("application-label-es:'"));
  const genericLine = lines.find(line => line.startsWith("application-label:'"));
  const line = esLine || genericLine;
  if (!line) return null;
  const match = line.match(/:'((?:\\'|[^'])*)'/);
  if (!match) return null;
  return match[1].replace(/\\'/g, "'");
}

function sanitizeGlobalSettings(settings = {}) {
  const sanitized = {};
  if (typeof settings.closeOnVdClose === 'boolean') {
    sanitized.closeOnVdClose = settings.closeOnVdClose;
  }
  if (typeof settings.turnScreenOffOnApps === 'boolean') {
    sanitized.turnScreenOffOnApps = settings.turnScreenOffOnApps;
  }
  if (typeof settings.turnScreenOffOnMirror === 'boolean') {
    sanitized.turnScreenOffOnMirror = settings.turnScreenOffOnMirror;
  }
  if (typeof settings.preventDeviceSleep === 'boolean') {
    sanitized.preventDeviceSleep = settings.preventDeviceSleep;
  }
  if (typeof settings.autoStartAudio === 'boolean') {
    sanitized.autoStartAudio = settings.autoStartAudio;
  }
  const mirrorBitRate = sanitizeBitRate(settings.mirrorBitRate);
  if (mirrorBitRate !== undefined) {
    sanitized.mirrorBitRate = mirrorBitRate;
  }
  const appBitRate = sanitizeBitRate(settings.appBitRate);
  if (appBitRate !== undefined) {
    sanitized.appBitRate = appBitRate;
  }
  return sanitized;
}

function extractGlobalSettings(prefs) {
  return { ...DEFAULT_GLOBAL_SETTINGS, ...(prefs.__globalSettings || {}) };
}

function getGlobalSettings(forceReload = false) {
  if (!forceReload && cachedGlobalSettings) {
    return cachedGlobalSettings;
  }
  const prefs = readPrefs();
  cachedGlobalSettings = extractGlobalSettings(prefs);
  return cachedGlobalSettings;
}

function saveGlobalSettings(newSettings = {}) {
  const prefs = readPrefs();
  const merged = { ...extractGlobalSettings(prefs), ...sanitizeGlobalSettings(newSettings) };
  prefs.__globalSettings = merged;
  writePrefs(prefs);
  cachedGlobalSettings = merged;
  return merged;
}

function run(command) {
  return new Promise(resolve => {
    exec(command, { cwd: base, windowsHide: true }, (error, stdout, stderr) => {
      resolve(error ? (stderr || error.message) : stdout);
    });
  });
}

const scrcpySessions = new Map();
let nextScrcpySessionId = 1;
let activeVideoSessions = 0;

const audioState = {
  sessionId: null,
  requestedAutomatically: false,
  requestedManually: false,
  keepAliveWithoutVideo: false,
  closing: false,
  suppressedByUser: false
};

function isVideoSession(session) {
  return Boolean(session && (session.type === 'app' || session.type === 'mirror'));
}

function hasVisibleVideoSession() {
  for (const session of scrcpySessions.values()) {
    if (isVideoSession(session) && session.windowVisible) {
      return true;
    }
  }
  return false;
}

function getAudioSession() {
  if (audioState.sessionId && scrcpySessions.has(audioState.sessionId)) {
    return scrcpySessions.get(audioState.sessionId);
  }
  for (const session of scrcpySessions.values()) {
    if (session.type === 'audio') {
      audioState.sessionId = session.id;
      return session;
    }
  }
  audioState.sessionId = null;
  return null;
}

function getAudioStateForRenderer() {
  return {
    active: Boolean(getAudioSession()),
    activeVideoSessions,
    requestedAutomatically: audioState.requestedAutomatically,
    requestedManually: audioState.requestedManually,
    keepAliveWithoutVideo: audioState.keepAliveWithoutVideo,
    closing: audioState.closing,
    suppressedByUser: audioState.suppressedByUser
  };
}

function notifyAudioStateChange() {
  const state = getAudioStateForRenderer();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('audio-state-changed', state);
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('audio-state-changed', state);
  }
}

function requestAudioShutdown(session, options = {}) {
  if (!session || !session.process) return;
  if (session.closing) return;
  const suppressedByUser = Boolean(options.suppressedByUser);
  session.closing = true;
  audioState.closing = true;
  audioState.suppressedByUser = suppressedByUser;
  try {
    session.process.kill();
  } catch (error) {
    console.error('Failed to stop audio session:', error);
    audioState.closing = false;
  }
  notifyAudioStateChange();
}

function shouldMaintainAudio() {
  if (audioState.requestedManually && audioState.keepAliveWithoutVideo) {
    return true;
  }
  if (audioState.suppressedByUser && !audioState.requestedManually) {
    return false;
  }
  if (activeVideoSessions > 0 && hasVisibleVideoSession()) {
    if (audioState.requestedManually || audioState.requestedAutomatically) {
      return true;
    }
    const settings = getGlobalSettings();
    return settings.autoStartAudio !== false;
  }
  return false;
}

function maybeEnsureAudioForVideo() {
  const audioSession = getAudioSession();
  if (audioSession) {
    if (audioState.closing) {
      audioState.closing = false;
      audioSession.closing = false;
    }
    audioSession.hasLinkedVideo = true;
    audioSession.manualPersistWithoutVideo = false;
    audioState.keepAliveWithoutVideo = false;
    notifyAudioStateChange();
    return;
  }
  if (!hasVisibleVideoSession()) {
    return;
  }
  if (audioState.suppressedByUser && !audioState.requestedManually) {
    return;
  }
  if (audioState.requestedManually) {
    audioState.suppressedByUser = false;
    startAudioSession({ requestedManually: true });
    return;
  }
  const settings = getGlobalSettings();
  if (settings.autoStartAudio !== false) {
    audioState.requestedAutomatically = true;
    audioState.suppressedByUser = false;
    startAudioSession({ requestedAutomatically: true });
  } else {
    audioState.requestedAutomatically = false;
    notifyAudioStateChange();
  }
}

function handleNoVideoSessions(options = {}) {
  const force = Boolean(options.force);
  if (audioState.requestedManually && audioState.keepAliveWithoutVideo) {
    notifyAudioStateChange();
    return;
  }
  if (!force && activeVideoSessions !== 0 && hasVisibleVideoSession()) {
    return;
  }
  audioState.requestedAutomatically = false;
  audioState.requestedManually = false;
  audioState.keepAliveWithoutVideo = false;
  const audioSession = getAudioSession();
  if (audioSession) {
    requestAudioShutdown(audioSession);
  } else {
    notifyAudioStateChange();
  }
}

function onScrcpyWindowVisibilityChanged(sessionId, visible) {
  const session = scrcpySessions.get(sessionId);
  if (!session || !isVideoSession(session)) {
    return;
  }
  const wasVisible = Boolean(session.windowVisible);
  session.windowVisible = Boolean(visible);
  session.lastSeenAt = Date.now();
  if (session.windowVisible) {
    maybeEnsureAudioForVideo();
    notifyAudioStateChange();
    return;
  }
  if (wasVisible && !hasVisibleVideoSession()) {
    handleNoVideoSessions({ force: true });
  } else {
    notifyAudioStateChange();
  }
}

function onAudioSessionTerminated(session) {
  if (audioState.sessionId === session.id) {
    audioState.sessionId = null;
  }
  const wasClosing = audioState.closing || session.closing;
  session.closing = false;
  if (wasClosing) {
    audioState.closing = false;
    audioState.keepAliveWithoutVideo = audioState.requestedManually && audioState.keepAliveWithoutVideo;
    if (!audioState.keepAliveWithoutVideo) {
      audioState.requestedManually = false;
    }
    audioState.requestedAutomatically = false;
    notifyAudioStateChange();
    return;
  }
  audioState.closing = false;
  audioState.suppressedByUser = true;
  audioState.requestedAutomatically = false;
  audioState.requestedManually = false;
  audioState.keepAliveWithoutVideo = false;
  notifyAudioStateChange();
}

function onVideoSessionTerminated() {
  if (activeVideoSessions > 0) {
    activeVideoSessions -= 1;
    if (activeVideoSessions < 0) activeVideoSessions = 0;
  }
  if (activeVideoSessions === 0) {
    handleNoVideoSessions();
  } else {
    notifyAudioStateChange();
  }
}

function launchScrcpyProcess(executable, args = [], metadata = {}) {
  const finalArgs = Array.isArray(args) ? args : [];
  const spawnOptions = {
    cwd: base,
    stdio: 'ignore'
  };
  if (process.platform === 'win32' && metadata && metadata.type === 'audio') {
    spawnOptions.windowsHide = true;
  }
  let child;
  try {
    child = spawn(executable, finalArgs, spawnOptions);
  } catch (error) {
    console.error('Failed to launch scrcpy:', error);
    return null;
  }

  const id = nextScrcpySessionId++;
  const session = {
    id,
    command: [executable, ...finalArgs].join(' '),
    process: child,
    type: metadata.type || 'unknown',
    title: metadata.title || '',
    package: metadata.package,
    requestedAutomatically: Boolean(metadata.requestedAutomatically),
    requestedManually: Boolean(metadata.requestedManually),
    manualPersistWithoutVideo: Boolean(metadata.manualPersistWithoutVideo),
    closing: false,
    windowVisible: Boolean(metadata.windowVisible),
    lastSeenAt: metadata.lastSeenAt || 0
  };

  scrcpySessions.set(id, session);

  if (session.type === 'audio') {
    audioState.sessionId = id;
    audioState.closing = false;
  } else if (isVideoSession(session)) {
    activeVideoSessions += 1;
    audioState.keepAliveWithoutVideo = false;
    session.windowVisible = process.platform !== 'win32';
    session.lastSeenAt = session.windowVisible ? Date.now() : 0;
    if (process.platform === 'win32') {
      windowTracker.register(session.id, session.title, visible => {
        onScrcpyWindowVisibilityChanged(session.id, visible);
      });
    } else {
      maybeEnsureAudioForVideo();
    }
  }

  const finalize = () => {
    if (session.finalized) return;
    session.finalized = true;
    if (isVideoSession(session)) {
      windowTracker.unregister(session.id);
    }
    scrcpySessions.delete(id);
    if (session.type === 'audio') {
      onAudioSessionTerminated(session);
    } else if (isVideoSession(session)) {
      onVideoSessionTerminated();
    }
    notifyAudioStateChange();
  };

  child.on('close', finalize);
  child.on('error', error => {
    console.error(`scrcpy ${session.type || 'session'} error:`, error);
    finalize();
  });

  notifyAudioStateChange();
  return session;
}

function startAudioSession(options = {}) {
  const requestedAutomatically = Boolean(options.requestedAutomatically);
  const requestedManually = Boolean(options.requestedManually);
  const existing = getAudioSession();
  if (existing) {
    audioState.suppressedByUser = false;
    if (requestedAutomatically) {
      audioState.requestedAutomatically = true;
      existing.requestedAutomatically = true;
    }
    if (requestedManually) {
      audioState.requestedManually = true;
      existing.requestedManually = true;
      existing.manualPersistWithoutVideo = activeVideoSessions === 0;
      audioState.keepAliveWithoutVideo = existing.manualPersistWithoutVideo;
    } else if (activeVideoSessions > 0) {
      audioState.keepAliveWithoutVideo = false;
      existing.manualPersistWithoutVideo = false;
    }
    audioState.closing = false;
    existing.closing = false;
    notifyAudioStateChange();
    return existing;
  }

  audioState.suppressedByUser = false;
  if (requestedAutomatically) {
    audioState.requestedAutomatically = true;
  }
  if (requestedManually) {
    audioState.requestedManually = true;
    audioState.keepAliveWithoutVideo = activeVideoSessions === 0;
  } else if (activeVideoSessions > 0) {
    audioState.keepAliveWithoutVideo = false;
  }
  audioState.closing = false;

  const settings = getGlobalSettings();
  const bitRate = Number(settings.mirrorBitRate) || DEFAULT_GLOBAL_SETTINGS.mirrorBitRate;
  const args = ['--no-video', '--no-control'];
  if (bitRate) args.push(`--video-bit-rate=${bitRate}M`);
  if (currentDevice) args.push('-s', currentDevice);
  const windowTitleArgs = buildWindowTitleArgs('scrcpy audio');
  if (windowTitleArgs.length) {
    args.push(...windowTitleArgs);
  }

  const session = launchScrcpyProcess(scrcpyExecutable, args, {
    type: 'audio',
    title: 'scrcpy audio',
    requestedAutomatically: audioState.requestedAutomatically,
    requestedManually: audioState.requestedManually,
    manualPersistWithoutVideo: audioState.keepAliveWithoutVideo
  });

  return session;
}

function applyGlobalSettings(settings) {
  if (!settings) return;
  if (settings.autoStartAudio === false) {
    audioState.requestedAutomatically = false;
    if (!audioState.requestedManually && activeVideoSessions > 0) {
      const audioSession = getAudioSession();
      if (audioSession) {
        requestAudioShutdown(audioSession);
      }
    }
  } else if (activeVideoSessions > 0) {
    maybeEnsureAudioForVideo();
  }
  notifyAudioStateChange();
}

function parseAdbDevicesOutput(output = '') {
  const lines = output.split(/\r?\n/).slice(1).map(line => line.trim()).filter(Boolean);
  return lines
    .map(line => {
      const parts = line.split(/\s+/).filter(Boolean);
      if (!parts.length) {
        return null;
      }
      const id = parts.shift() || '';
      if (!id) {
        return null;
      }
      const state = (parts.shift() || '').toLowerCase();
      const details = parts.join(' ');
      return {
        id,
        state,
        details,
        raw: line
      };
    })
    .filter(Boolean);
}

async function fetchAdbDevices() {
  const output = await run(`${adb} devices`);
  const devices = parseAdbDevicesOutput(output);
  return { output, devices };
}

ipcMain.handle('scrcpy-start-update', async () => {
  if (ongoingScrcpyDownload) {
    return { started: false, reason: 'busy' };
  }
  try {
    const release = latestReleaseCache || await fetchLatestRelease();
    const installed = await getInstalledMarkerInfo();
    if (installed && compareVersions(installed.version, release.normalizedVersion) >= 0) {
      return { started: false, reason: 'up-to-date' };
    }
    await downloadAndInstallScrcpy(release, DOWNLOAD_CONTEXT_UPDATE);
    return { started: true };
  } catch (error) {
    if (error && error.code === 'busy') {
      return { started: false, reason: 'busy' };
    }
    const payload = getScrcpyErrorPayload(error);
    if (!error || !error.scrcpyHandled) {
      emitScrcpyEvent('update-error', payload);
    }
    return { started: false, reason: payload.code };
  }
});

ipcMain.handle('open-external', async (_event, url) => {
  if (typeof url !== 'string') return false;
  const normalized = url.trim();
  if (!normalized) return false;
  try {
    await shell.openExternal(normalized);
    return true;
  } catch (error) {
    console.error('Failed to open external link:', error);
    return false;
  }
});

ipcMain.handle('close', () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.handle('minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.handle('connect', async () => {
  const { output, devices } = await fetchAdbDevices();
  if (devices.length === 1 && devices[0].state === 'device') {
    currentDevice = devices[0].id;
  } else {
    currentDevice = '';
  }
  return { output, devices };
});

ipcMain.handle('refresh-devices', async () => {
  return fetchAdbDevices();
});

ipcMain.handle('disconnect-device', async (_event, deviceId) => {
  const target = typeof deviceId === 'string' ? deviceId.trim() : '';
  if (!target) return '';
  return run(`${adb} disconnect ${target}`);
});

ipcMain.handle('reconnect-device', async (_event, deviceId) => {
  const target = typeof deviceId === 'string' ? deviceId.trim() : '';
  if (!target) return '';
  return run(`${adb} connect ${target}`);
});

ipcMain.handle('set-current-device', async (_event, deviceId) => {
  if (typeof deviceId === 'string') {
    currentDevice = deviceId.trim();
  } else {
    currentDevice = '';
  }
  return currentDevice;
});

ipcMain.handle('connect-wifi', async (event, ip, port) => {
  return await run(`${adb} connect ${ip}:${port}`);
});

ipcMain.handle('list-packages', async (_event, deviceId) => {
  const override = typeof deviceId === 'string' ? deviceId.trim() : '';
  const adbShell = buildAdbCommand('shell "cmd package query-activities -a android.intent.action.MAIN -c android.intent.category.LAUNCHER --brief"', override);
  const cmd =
    `${adbShell} | ` +
    `powershell -noprofile -command "$input | ForEach-Object { ($_ -split '/')[0] } | Sort-Object -Unique"`;
  const out = await run(cmd);
  const packages = out
    .split('\n')
    .map(l => l.trim())
    .filter(l => /^[\w\.]+$/.test(l));
  const labels = getAppLabelCache();
  const apps = packages.map(pkg => {
    const label = labels[pkg];
    return {
      package: pkg,
      name: label || pkg,
      hasLabel: Boolean(label)
    };
  });
  const missing = packages.filter(pkg => !labels[pkg]);
  if (missing.length) {
    const pendingPackages = [...missing];
    setTimeout(() => queueAppLabels(pendingPackages), 0);
  }
  return apps;
});

ipcMain.handle('launch-app', async (event, pkg, config) => {
  config = config && typeof config === 'object' ? config : {};
  const prefs = readPrefs();
  const globalSettings = extractGlobalSettings(prefs);
  cachedGlobalSettings = globalSettings;
  if (config.saveForThis) {
    prefs[pkg] = { orientation: config.orientation, width: config.width, height: config.height, density: config.density };
    writePrefs(prefs);
  }
  if (config.saveForAll) {
    prefs['*'] = { orientation: config.orientation, width: config.width, height: config.height, density: config.density };
    writePrefs(prefs);
  }

  const pref = prefs[pkg] || prefs['*'] || {};
  const orientation = config.orientation || pref.orientation;
  let width = config.width || pref.width;
  let height = config.height || pref.height;
  let density = config.density || pref.density || 200;

  if (!width || !height) {
    if (orientation === 'horizontal') {
      const res = await run(`powershell -command "& { $r=Get-CimInstance Win32_VideoController | Select-Object -First 1 CurrentHorizontalResolution,CurrentVerticalResolution; $r.CurrentHorizontalResolution.ToString() + 'x' + $r.CurrentVerticalResolution }"`);
      const parts = res.trim().split('x');
      width = parts[0];
      height = parts[1];
    } else if (orientation === 'vertical') {
      const h = await run(`powershell -command "& { $r=Get-CimInstance Win32_VideoController | Select-Object -First 1 CurrentHorizontalResolution,CurrentVerticalResolution; $r.CurrentVerticalResolution.ToString() }"`);
      height = h.trim();
      width = Math.round(parseInt(height,10) * 9 / 16);
    }
  }

  const resolution = width && height ? `${width}x${height}` : undefined;
  const device = currentDevice;

  const args = ['--no-audio'];
  if (globalSettings.preventDeviceSleep !== false) {
    args.push('--stay-awake');
  }
  if (globalSettings.closeOnVdClose !== false) {
    args.push('--no-vd-destroy-content');
  }
  if (device) args.push('-s', device);
  const appBitRate = Number(globalSettings.appBitRate);
  if (appBitRate) args.push(`--video-bit-rate=${appBitRate}M`);
  if (resolution) args.push(`--new-display=${resolution}/${density}`);
  if (globalSettings.turnScreenOffOnApps) {
    args.push('--turn-screen-off');
  }
  args.push(`--start-app=${pkg}`);
  const rawWindowTitle =
    (typeof config.appName === 'string' && config.appName.trim()) || getCachedLabel(pkg) || pkg;
  const sanitizedTitle = rawWindowTitle ? rawWindowTitle.trim() : '';
  const baseWindowTitle = sanitizedTitle
    ? (sanitizedTitle.toLowerCase().endsWith(' scrcpy') ? sanitizedTitle : `${sanitizedTitle} scrcpy`)
    : 'scrcpy';
  const windowTitleArgs = buildWindowTitleArgs(baseWindowTitle);
  if (windowTitleArgs.length) {
    args.push(...windowTitleArgs);
  }
  const session = launchScrcpyProcess(scrcpyExecutable, args, {
    type: 'app',
    title: baseWindowTitle,
    package: pkg
  });
  return Boolean(session);
});

ipcMain.handle('get-preferences', (event, pkg) => {
  const prefs = readPrefs();
  return prefs[pkg] || null;
});

ipcMain.handle('reset-preferences', (event, pkg) => {
  const prefs = readPrefs();
  delete prefs[pkg];
  writePrefs(prefs);
  return true;
});

ipcMain.handle('mirror-screen', () => {
  const settings = getGlobalSettings();
  const bitRate = Number(settings.mirrorBitRate) || DEFAULT_GLOBAL_SETTINGS.mirrorBitRate;
  const args = ['--no-audio'];
  if (settings.preventDeviceSleep !== false) {
    args.push('--stay-awake');
  }
  if (bitRate) args.push(`--video-bit-rate=${bitRate}M`);
  if (settings.turnScreenOffOnMirror) {
    args.push('--turn-screen-off');
  }
  if (currentDevice) args.push('-s', currentDevice);
  const windowTitleArgs = buildWindowTitleArgs('scrcpy mirror');
  if (windowTitleArgs.length) {
    args.push(...windowTitleArgs);
  }
  launchScrcpyProcess(scrcpyExecutable, args, { type: 'mirror', title: 'scrcpy mirror' });
});

ipcMain.handle('activate-audio', () => {
  const audioSession = getAudioSession();
  if (audioSession) {
    audioState.requestedAutomatically = false;
    audioState.requestedManually = false;
    audioState.keepAliveWithoutVideo = false;
    audioState.suppressedByUser = true;
    const wasClosing = Boolean(audioSession.closing);
    if (!wasClosing) {
      requestAudioShutdown(audioSession, { suppressedByUser: true });
    } else {
      audioState.closing = true;
      notifyAudioStateChange();
    }
    return getAudioStateForRenderer();
  }

  audioState.requestedAutomatically = false;
  audioState.requestedManually = true;
  audioState.keepAliveWithoutVideo = activeVideoSessions === 0;
  audioState.closing = false;
  audioState.suppressedByUser = false;
  startAudioSession({ requestedManually: true });
  return getAudioStateForRenderer();
});

ipcMain.handle('open-settings', () => {
  createSettingsWindow();
  return true;
});

ipcMain.handle('open-shortcuts', () => {
  createShortcutsWindow();
  return true;
});

ipcMain.handle('close-shortcuts', () => {
  if (shortcutsWindow) {
    shortcutsWindow.close();
  }
  return true;
});

ipcMain.handle('get-global-settings', () => {
  return getGlobalSettings();
});

ipcMain.handle('update-global-settings', (event, settings) => {
  const merged = saveGlobalSettings(settings);
  applyGlobalSettings(merged);
  return merged;
});

ipcMain.handle('get-audio-state', () => {
  return getAudioStateForRenderer();
});

ipcMain.handle('reset-app-counts', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('reset-app-counts');
  }
  return true;
});
