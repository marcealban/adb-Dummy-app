const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const AdmZip = require('adm-zip');
const sharp = require('sharp');
const { pathToFileURL } = require('url');

const WINDOW_WIDTH = 416;
const WINDOW_HEIGHT = 600;
const TEMP_APK_NAME = '__tmp_app_label.apk';
const LABEL_CACHE_KEY = '__appLabels';
const ICON_CACHE_DIR_NAME = 'icons';
const ICON_TEMP_DIR = '__tmp_icons';
const ICON_FILE_EXTENSION = '.png';
const ICON_SIZE = 256;
const ICON_DENSITY_ORDER = ['xxxhdpi', 'xxhdpi', 'xhdpi', 'hdpi', 'mdpi', 'ldpi'];
const ANDROID_COLOR_MAP = {
  transparent: '#00000000',
  black: '#FF000000',
  white: '#FFFFFFFF'
};

const labelQueue = [];
const queuedLabelPackages = new Set();
let isProcessingLabelQueue = false;
const iconQueue = [];
const queuedIconPackages = new Set();
let isProcessingIconQueue = false;

const base = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
const adb = process.platform === 'win32' ? `"${path.join(base, 'adb.exe')}"` : 'adb';
let cachedAapt2Command = null;
let ICON_CACHE_DIR = null;

const fsp = fs.promises;

let mainWindow = null;
let currentDevice = '';
let PREF_PATH = null;
let appLabelCache = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    resizable: false,
    fullscreenable: false,
    maximizable: false,
    backgroundColor: '#00000000',
    frame: false,
    show: false,
    transparent: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

function run(command) {
  return new Promise((resolve, reject) => {
    exec(command, { cwd: base, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const message = stderr && stderr.trim() ? stderr.trim() : error.message;
        reject(new Error(message));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseAdbDevicesOutput(output = '') {
  const lines = output.split(/\r?\n/).slice(1);
  return lines
    .map(line => line.trim())
    .filter(Boolean)
    .map(rawLine => {
      const parts = rawLine.split(/\s+/).filter(Boolean);
      if (!parts.length) return null;
      const id = parts.shift();
      const state = (parts.shift() || '').toLowerCase();
      const details = parts.join(' ');
      return { id, state, details, raw: rawLine };
    })
    .filter(Boolean);
}

async function fetchAdbDevices() {
  const output = await run(`${adb} devices`);
  const devices = parseAdbDevicesOutput(output);
  return { output, devices };
}

function buildAdbCommand(args, deviceOverride) {
  const override = typeof deviceOverride === 'string' ? deviceOverride.trim() : '';
  const deviceId = override || (typeof currentDevice === 'string' ? currentDevice.trim() : '');
  const deviceSegment = deviceId ? ` -s ${deviceId}` : '';
  return `${adb}${deviceSegment} ${args}`;
}

function readPrefs() {
  if (!PREF_PATH) return {};
  try {
    const raw = fs.readFileSync(PREF_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writePrefs(prefs) {
  if (!PREF_PATH) return;
  try {
    fs.mkdirSync(path.dirname(PREF_PATH), { recursive: true });
    fs.writeFileSync(PREF_PATH, JSON.stringify(prefs, null, 2), 'utf8');
  } catch (error) {
    console.error('No se pudieron guardar las preferencias:', error);
  }
}

function getAppLabelCache() {
  if (appLabelCache) {
    return appLabelCache;
  }
  const prefs = readPrefs();
  const stored = prefs && typeof prefs === 'object' ? prefs[LABEL_CACHE_KEY] : null;
  appLabelCache = stored && typeof stored === 'object' ? { ...stored } : {};
  return appLabelCache;
}

function rememberAppLabel(pkg, label) {
  if (!pkg || !label) return;
  const cache = { ...getAppLabelCache(), [pkg]: label };
  appLabelCache = cache;
  const prefs = readPrefs();
  prefs[LABEL_CACHE_KEY] = cache;
  writePrefs(prefs);
}

function sanitizePackageNameForFile(pkg) {
  return typeof pkg === 'string' ? pkg.replace(/[^a-zA-Z0-9_.-]/g, '_') : '';
}

function getIconCacheDir() {
  return ICON_CACHE_DIR;
}

async function ensureIconCacheDir() {
  if (!ICON_CACHE_DIR) return null;
  try {
    await fsp.mkdir(ICON_CACHE_DIR, { recursive: true });
    return ICON_CACHE_DIR;
  } catch (error) {
    console.warn('No se pudo preparar la carpeta de iconos:', error.message);
    return null;
  }
}

function getCachedIconFilePath(pkg) {
  if (!ICON_CACHE_DIR) return null;
  const sanitized = sanitizePackageNameForFile(pkg);
  if (!sanitized) return null;
  return path.join(ICON_CACHE_DIR, `${sanitized}${ICON_FILE_EXTENSION}`);
}

function iconExists(pkg) {
  const filePath = getCachedIconFilePath(pkg);
  if (!filePath) return false;
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function getCachedIconFileUrl(pkg) {
  const filePath = getCachedIconFilePath(pkg);
  if (!filePath) return null;
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return pathToFileURL(filePath).toString();
  } catch {
    return null;
  }
}

function emitToRenderer(channel, payload) {
  if (!channel) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function queueAppLabels(packages = []) {
  const cache = getAppLabelCache();
  packages.forEach(pkg => {
    const normalized = typeof pkg === 'string' ? pkg.trim() : '';
    if (!normalized) return;
    if (cache[normalized]) return;
    if (queuedLabelPackages.has(normalized)) return;
    queuedLabelPackages.add(normalized);
    labelQueue.push(normalized);
  });
  void processLabelQueue();
}

async function processLabelQueue() {
  if (isProcessingLabelQueue) return;
  isProcessingLabelQueue = true;
  try {
    while (labelQueue.length) {
      const pkg = labelQueue.shift();
      queuedLabelPackages.delete(pkg);
      if (!pkg) continue;
      if (getAppLabelCache()[pkg]) {
        emitToRenderer('package-label-updated', {
          package: pkg,
          name: getAppLabelCache()[pkg],
          success: true
        });
        continue;
      }

      emitToRenderer('package-label-started', pkg);

      let label = null;
      try {
        label = await extractLabelForPackage(pkg);
        if (label) {
          rememberAppLabel(pkg, label);
        }
      } catch (error) {
        console.warn(`No se pudo extraer la etiqueta para ${pkg}:`, error.message);
      }

      const cache = getAppLabelCache();
      const finalLabel = label || cache[pkg] || pkg;
      emitToRenderer('package-label-updated', {
        package: pkg,
        name: finalLabel,
        success: Boolean(label || cache[pkg])
      });
    }
  } finally {
    isProcessingLabelQueue = false;
  }
}

function queueAppIcons(packages = []) {
  if (!ICON_CACHE_DIR) return;
  void ensureIconCacheDir();
  packages.forEach(pkg => {
    const normalized = typeof pkg === 'string' ? pkg.trim() : '';
    if (!normalized) return;
    if (iconExists(normalized)) return;
    if (queuedIconPackages.has(normalized)) return;
    queuedIconPackages.add(normalized);
    iconQueue.push(normalized);
  });
  void processIconQueue();
}

async function processIconQueue() {
  if (isProcessingIconQueue) return;
  isProcessingIconQueue = true;
  try {
    while (iconQueue.length) {
      const pkg = iconQueue.shift();
      queuedIconPackages.delete(pkg);
      if (!pkg) continue;

      const cachedUrl = getCachedIconFileUrl(pkg);
      if (cachedUrl) {
        emitToRenderer('package-icon-updated', {
          package: pkg,
          iconPath: cachedUrl,
          success: true
        });
        continue;
      }

      emitToRenderer('package-icon-started', pkg);

      let iconFilePath = null;
      try {
        iconFilePath = await extractIconForPackage(pkg);
      } catch (error) {
        console.warn(`No se pudo extraer el icono para ${pkg}:`, error.message);
      }

      const finalUrl = iconFilePath ? getCachedIconFileUrl(pkg) : null;
      emitToRenderer('package-icon-updated', {
        package: pkg,
        iconPath: finalUrl,
        success: Boolean(finalUrl)
      });
    }
  } finally {
    isProcessingIconQueue = false;
  }
}

async function resolveBaseApkPath(pkg) {
  const sanitized = typeof pkg === 'string' ? pkg.trim() : '';
  if (!sanitized) return null;
  const pathOutput = await run(buildAdbCommand(`shell pm path ${sanitized}`));
  const lines = pathOutput
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const remoteLine = lines.find(line => line.includes('base.apk')) || lines[0];
  if (!remoteLine) return null;
  const remotePath = remoteLine.startsWith('package:')
    ? remoteLine.slice('package:'.length).trim()
    : remoteLine;
  return remotePath || null;
}

function parseLabelFromDump(output) {
  if (!output) return null;
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const preferred = lines.find(line => line.startsWith("application-label-es:'"));
  const fallback = lines.find(line => line.startsWith("application-label:'"));
  const target = preferred || fallback;
  if (!target) return null;
  const match = target.match(/:'((?:\\'|[^'])*)'/);
  if (!match) return null;
  return match[1].replace(/\\'/g, "'");
}

function getAapt2Command() {
  if (cachedAapt2Command !== null) {
    return cachedAapt2Command;
  }

  if (process.platform === 'win32') {
    const candidate = path.join(base, 'aapt2.exe');
    if (fs.existsSync(candidate)) {
      cachedAapt2Command = `"${candidate}"`;
      return cachedAapt2Command;
    }
    cachedAapt2Command = null;
    return cachedAapt2Command;
  }

  cachedAapt2Command = 'aapt2';
  return cachedAapt2Command;
}

async function extractLabelForPackage(pkg) {
  const sanitized = typeof pkg === 'string' ? pkg.trim() : '';
  if (!sanitized) return null;

  const tempApkPath = path.join(base, TEMP_APK_NAME);
  try {
    const remotePath = await resolveBaseApkPath(sanitized);
    if (!remotePath) return null;

    try {
      await fsp.rm(tempApkPath, { force: true });
    } catch {
      // ignore cleanup errors
    }

    await run(buildAdbCommand(`pull "${remotePath}" "${TEMP_APK_NAME}"`));

    try {
      await fsp.access(tempApkPath, fs.constants.F_OK);
    } catch {
      return null;
    }

    const aapt2 = getAapt2Command();
    if (!aapt2) return null;
    try {
      const dumpOutput = await run(`${aapt2} dump badging "${TEMP_APK_NAME}"`);
      return parseLabelFromDump(dumpOutput);
    } catch (error) {
      console.warn(`No se pudo extraer la etiqueta para ${sanitized}:`, error.message);
      return null;
    }
  } catch (error) {
    console.warn(`No se pudo preparar el APK para ${sanitized}:`, error.message);
    return null;
  } finally {
    try {
      await fsp.rm(tempApkPath, { force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

function normalizeResourcePath(resourcePath) {
  if (typeof resourcePath !== 'string') return null;
  const trimmed = resourcePath.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\\/g, '/').replace(/^\.\//, '');
}

function parseIconCandidatesFromDump(output = '') {
  const lines = output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const candidates = [];
  let fallback = null;
  lines.forEach(line => {
    const iconMatch = line.match(/^application-icon-([0-9]+):'(.*?)'$/);
    if (iconMatch) {
      candidates.push({
        density: Number.parseInt(iconMatch[1], 10) || 0,
        path: normalizeResourcePath(iconMatch[2])
      });
      return;
    }
    if (!fallback && line.startsWith('application:')) {
      const fallbackMatch = line.match(/icon='([^']+)'/);
      if (fallbackMatch) {
        fallback = normalizeResourcePath(fallbackMatch[1]);
      }
    }
  });
  return { candidates, fallback };
}

function deriveAlternateResourcePaths(resourcePath) {
  const normalized = normalizeResourcePath(resourcePath);
  if (!normalized) return [];
  if (!normalized.startsWith('res/')) return [];
  const parts = normalized.split('/');
  if (parts.length < 3) return [];
  const folder = parts[1];
  const filePath = parts.slice(2).join('/');
  const typeMatch = folder.match(/^([a-zA-Z0-9_]+)/);
  if (!typeMatch) return [];
  const type = typeMatch[1];
  const parsed = path.posix.parse(filePath);
  const baseName = parsed.name;
  const ext = parsed.ext.toLowerCase();
  const results = [];
  const addForDensities = (extension) => {
    ICON_DENSITY_ORDER.forEach(density => {
      results.push(`res/${type}-${density}/${baseName}${extension}`);
    });
    results.push(`res/${type}/${baseName}${extension}`);
  };
  if (ext === '.xml') {
    addForDensities('.png');
    addForDensities('.webp');
    addForDensities('.jpg');
    addForDensities('.jpeg');
  } else if (['.png', '.webp', '.jpg', '.jpeg'].includes(ext)) {
    addForDensities(ext);
  }
  return results;
}

function buildCandidateResourcePaths(info) {
  const ordered = info.candidates
    .slice()
    .sort((a, b) => (b.density || 0) - (a.density || 0))
    .map(candidate => candidate.path)
    .filter(Boolean);
  const seen = new Set();
  const result = [];
  ordered.forEach(pathValue => {
    const normalized = normalizeResourcePath(pathValue);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    result.push(normalized);
  });
  const fallback = normalizeResourcePath(info.fallback);
  if (fallback && !seen.has(fallback)) {
    seen.add(fallback);
    result.push(fallback);
  }
  const derived = [];
  result.forEach(pathValue => {
    deriveAlternateResourcePaths(pathValue).forEach(alt => {
      const normalized = normalizeResourcePath(alt);
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        derived.push(normalized);
      }
    });
  });
  return result.concat(derived);
}

function readZipEntry(zip, entryName) {
  if (!zip || !entryName) return null;
  const normalized = normalizeResourcePath(entryName);
  if (!normalized) return null;
  const entry = zip.getEntry(normalized);
  if (!entry) return null;
  try {
    return entry.getData();
  } catch {
    return null;
  }
}

function buildResourceEntryInfo(entryName) {
  const normalized = normalizeResourcePath(entryName);
  if (!normalized || !normalized.startsWith('res/')) return null;
  const parts = normalized.split('/');
  if (parts.length < 3) return null;
  const folder = parts[1];
  const filePath = parts.slice(2).join('/');
  const parsed = path.posix.parse(filePath);
  const densityMatch = folder.match(/-(ldpi|mdpi|hdpi|xhdpi|xxhdpi|xxxhdpi)/i);
  let density = null;
  if (densityMatch) {
    density = densityMatch[1].toLowerCase();
  } else if (folder.toLowerCase().includes('anydpi')) {
    density = 'anydpi';
  }
  return {
    entryName: normalized,
    ext: parsed.ext.toLowerCase(),
    density,
    folder
  };
}

function buildResourceIndex(zip) {
  const entriesByKey = new Map();
  const colorMap = new Map();
  const entries = zip.getEntries();
  entries.forEach(entry => {
    if (!entry) return;
    const isDir = typeof entry.isDirectory === 'function' ? entry.isDirectory() : entry.isDirectory;
    if (isDir) return;
    const entryName = normalizeResourcePath(entry.entryName);
    if (!entryName || entryName.endsWith('/')) return;
    if (!entryName.startsWith('res/')) return;
    const parts = entryName.split('/');
    if (parts.length < 3) return;
    const folder = parts[1];
    const filePath = parts.slice(2).join('/');
    if (folder.startsWith('values')) {
      const buffer = readZipEntry(zip, entryName);
      if (!buffer) return;
      const text = buffer.toString('utf8');
      const regex = /<color\s+name="([^"']+)"[^>]*>(#[0-9a-fA-F]{6,8})<\/color>/g;
      let match;
      while ((match = regex.exec(text)) !== null) {
        const name = match[1];
        const value = match[2].toUpperCase();
        if (!colorMap.has(name)) {
          colorMap.set(name, value);
        }
      }
      return;
    }
    const typeMatch = folder.match(/^([a-zA-Z0-9_]+)/);
    if (!typeMatch) return;
    const type = typeMatch[1];
    const parsed = path.posix.parse(filePath);
    const name = parsed.name;
    const ext = parsed.ext.toLowerCase();
    const densityMatch = folder.match(/-(ldpi|mdpi|hdpi|xhdpi|xxhdpi|xxxhdpi)/i);
    let density = null;
    if (densityMatch) {
      density = densityMatch[1].toLowerCase();
    } else if (folder.toLowerCase().includes('anydpi')) {
      density = 'anydpi';
    }
    const key = `${type}/${name}`;
    const info = { entryName, ext, density, folder };
    if (!entriesByKey.has(key)) {
      entriesByKey.set(key, []);
    }
    entriesByKey.get(key).push(info);
  });
  return { entriesByKey, colorMap };
}

function findResourceEntry(resourceIndex, resourcePath) {
  const normalized = normalizeResourcePath(resourcePath);
  if (!normalized || !normalized.startsWith('res/')) return null;
  const parts = normalized.split('/');
  if (parts.length < 3) return null;
  const folder = parts[1];
  const filePath = parts.slice(2).join('/');
  const typeMatch = folder.match(/^([a-zA-Z0-9_]+)/);
  if (!typeMatch) return null;
  const type = typeMatch[1];
  const parsed = path.posix.parse(filePath);
  const name = parsed.name;
  const ext = parsed.ext.toLowerCase();
  const key = `${type}/${name}`;
  const entries = resourceIndex.entriesByKey.get(key);
  if (!entries || !entries.length) return null;
  if (ext) {
    const sameExt = entries.find(entry => entry.ext === ext);
    if (sameExt) {
      return sameExt;
    }
  }
  const sorted = [...entries].sort(compareResourceEntries);
  return sorted[0] || null;
}

function selectResourceEntry(zip, resourceIndex, resourcePath) {
  const normalized = normalizeResourcePath(resourcePath);
  if (!normalized) return null;
  const directEntry = zip.getEntry(normalized);
  if (directEntry) {
    return buildResourceEntryInfo(normalized);
  }
  return findResourceEntry(resourceIndex, normalized);
}

function getDensityRank(entry) {
  if (!entry) return -1;
  if (entry.density === 'anydpi') {
    return ICON_DENSITY_ORDER.length + 1;
  }
  const index = ICON_DENSITY_ORDER.indexOf(entry.density);
  if (index === -1) return -1;
  return ICON_DENSITY_ORDER.length - index;
}

function compareResourceEntries(a, b) {
  return getDensityRank(b) - getDensityRank(a);
}

function parseResourceReference(ref) {
  if (typeof ref !== 'string') return null;
  const trimmed = ref.trim();
  if (!trimmed.startsWith('@')) return null;
  if (trimmed.startsWith('@android:')) {
    const withoutNamespace = trimmed.slice('@android:'.length);
    const segments = withoutNamespace.split('/');
    if (segments.length !== 2) return null;
    return { namespace: 'android', type: segments[0], name: segments[1] };
  }
  const body = trimmed.slice(1);
  const parts = body.split('/');
  if (parts.length !== 2) return null;
  return { namespace: 'app', type: parts[0], name: parts[1] };
}

function resolveDrawableResource(zip, resourceIndex, ref) {
  const parsed = parseResourceReference(ref);
  if (!parsed) return null;
  if (parsed.namespace === 'android') {
    if (parsed.type === 'color') {
      const mapped = ANDROID_COLOR_MAP[parsed.name.toLowerCase()];
      if (mapped) {
        return { type: 'color', color: mapped };
      }
    }
    return null;
  }
  if (parsed.type === 'color') {
    const colorValue = resourceIndex.colorMap.get(parsed.name);
    if (colorValue) {
      return { type: 'color', color: colorValue };
    }
  }
  const key = `${parsed.type}/${parsed.name}`;
  const entries = resourceIndex.entriesByKey.get(key) || [];
  if (entries.length) {
    const rasterEntries = entries
      .filter(entry => ['.png', '.webp', '.jpg', '.jpeg'].includes(entry.ext))
      .sort(compareResourceEntries);
    if (rasterEntries.length) {
      const buffer = readZipEntry(zip, rasterEntries[0].entryName);
      if (buffer) {
        return { type: 'image', buffer };
      }
    }
    const xmlEntry = entries.find(entry => entry.ext === '.xml');
    if (xmlEntry) {
      const xmlBuffer = readZipEntry(zip, xmlEntry.entryName);
      if (xmlBuffer) {
        const xmlContent = xmlBuffer.toString('utf8');
        const colorMatch = xmlContent.match(/<color[^>]*>(#[0-9a-fA-F]{6,8})<\/color>/i);
        if (colorMatch) {
          return { type: 'color', color: colorMatch[1].toUpperCase() };
        }
        const drawableMatch = xmlContent.match(/android:drawable="(@[^"']+)"/i);
        if (drawableMatch) {
          return resolveDrawableResource(zip, resourceIndex, drawableMatch[1]);
        }
      }
    }
  }
  if (parsed.type === 'color') {
    const fallbackColor = resourceIndex.colorMap.get(parsed.name);
    if (fallbackColor) {
      return { type: 'color', color: fallbackColor };
    }
  }
  return null;
}

function parseColorToRgba(color) {
  if (typeof color !== 'string') {
    return { r: 0, g: 0, b: 0, alpha: 0 };
  }
  let hex = color.trim();
  if (!hex.startsWith('#')) {
    return { r: 0, g: 0, b: 0, alpha: 0 };
  }
  hex = hex.slice(1);
  if (hex.length === 3) {
    hex = hex.split('').map(ch => ch + ch).join('');
  } else if (hex.length === 4) {
    hex = hex.split('').map(ch => ch + ch).join('');
  }
  if (hex.length !== 6 && hex.length !== 8) {
    return { r: 0, g: 0, b: 0, alpha: 0 };
  }
  let alpha = 255;
  let offset = 0;
  if (hex.length === 8) {
    alpha = Number.parseInt(hex.slice(0, 2), 16);
    offset = 2;
  }
  const r = Number.parseInt(hex.slice(offset, offset + 2), 16);
  const g = Number.parseInt(hex.slice(offset + 2, offset + 4), 16);
  const b = Number.parseInt(hex.slice(offset + 4, offset + 6), 16);
  return {
    r: Number.isFinite(r) ? r : 0,
    g: Number.isFinite(g) ? g : 0,
    b: Number.isFinite(b) ? b : 0,
    alpha: Number.isFinite(alpha) ? Math.max(0, Math.min(255, alpha)) / 255 : 0
  };
}

async function saveRasterIcon(buffer, ext, targetPath) {
  if (!buffer) return false;
  const tempPath = `${targetPath}.tmp`;
  try {
    if (ext === '.png') {
      await fsp.writeFile(tempPath, buffer);
    } else {
      await sharp(buffer).png().toFile(tempPath);
    }
    await fsp.rename(tempPath, targetPath);
    return true;
  } catch (error) {
    try {
      await fsp.rm(tempPath, { force: true });
    } catch {
      // ignore cleanup errors
    }
    console.warn('No se pudo guardar el icono rasterizado:', error.message);
    return false;
  }
}

async function extractAdaptiveIconFromXml(zip, resourceIndex, entryName, targetPath) {
  const xmlBuffer = readZipEntry(zip, entryName);
  if (!xmlBuffer) return false;
  const xmlContent = xmlBuffer.toString('utf8');
  const foregroundMatch = xmlContent.match(/<foreground[^>]*android:drawable="(@[^"']+)"/i);
  const backgroundMatch = xmlContent.match(/<background[^>]*android:drawable="(@[^"']+)"/i);
  const foregroundRef = foregroundMatch ? foregroundMatch[1] : null;
  const backgroundRef = backgroundMatch ? backgroundMatch[1] : null;
  const foreground = foregroundRef ? resolveDrawableResource(zip, resourceIndex, foregroundRef) : null;
  const background = backgroundRef ? resolveDrawableResource(zip, resourceIndex, backgroundRef) : null;
  if (!foreground && !background) {
    return false;
  }

  let pipeline = null;
  if (background) {
    if (background.type === 'image') {
      pipeline = sharp(background.buffer).resize(ICON_SIZE, ICON_SIZE, {
        fit: 'cover',
        position: 'center'
      });
    } else if (background.type === 'color') {
      pipeline = sharp({
        create: {
          width: ICON_SIZE,
          height: ICON_SIZE,
          channels: 4,
          background: parseColorToRgba(background.color)
        }
      });
    }
  }

  if (!pipeline) {
    pipeline = sharp({
      create: {
        width: ICON_SIZE,
        height: ICON_SIZE,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    });
  }

  const composites = [];
  if (foreground) {
    if (foreground.type === 'image') {
      const buffer = await sharp(foreground.buffer)
        .resize(ICON_SIZE, ICON_SIZE, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .png()
        .toBuffer();
      composites.push({ input: buffer, gravity: 'center' });
    } else if (foreground.type === 'color') {
      const buffer = await sharp({
        create: {
          width: ICON_SIZE,
          height: ICON_SIZE,
          channels: 4,
          background: parseColorToRgba(foreground.color)
        }
      })
        .png()
        .toBuffer();
      composites.push({ input: buffer, gravity: 'center' });
    }
  }

  let output = pipeline;
  if (composites.length) {
    output = output.composite(composites);
  }

  const tempPath = `${targetPath}.tmp`;
  try {
    await output.png().toFile(tempPath);
    await fsp.rename(tempPath, targetPath);
    return true;
  } catch (error) {
    try {
      await fsp.rm(tempPath, { force: true });
    } catch {
      // ignore cleanup errors
    }
    console.warn('No se pudo componer el icono adaptable:', error.message);
    return false;
  }
}

async function extractIconEntry(zip, resourceIndex, entryInfo, targetPath) {
  if (!entryInfo) return false;
  const buffer = readZipEntry(zip, entryInfo.entryName);
  if (!buffer) return false;
  if (['.png', '.webp', '.jpg', '.jpeg'].includes(entryInfo.ext)) {
    return saveRasterIcon(buffer, entryInfo.ext, targetPath);
  }
  if (entryInfo.ext === '.xml') {
    return extractAdaptiveIconFromXml(zip, resourceIndex, entryInfo.entryName, targetPath);
  }
  return false;
}

async function extractIconForPackage(pkg) {
  const sanitized = typeof pkg === 'string' ? pkg.trim() : '';
  if (!sanitized) return null;
  if (!ICON_CACHE_DIR) return null;

  const cacheDir = await ensureIconCacheDir();
  if (!cacheDir) return null;
  const iconPath = getCachedIconFilePath(sanitized);
  if (!iconPath) return null;

  try {
    await fsp.access(iconPath, fs.constants.F_OK);
    return iconPath;
  } catch {
    // continue with extraction
  }

  const tempRoot = path.join(base, ICON_TEMP_DIR);
  const workDir = path.join(tempRoot, sanitizePackageNameForFile(sanitized));
  const tempApkPath = path.join(workDir, 'base.apk');

  try {
    await fsp.rm(workDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }

  await fsp.mkdir(workDir, { recursive: true });

  try {
    const remotePath = await resolveBaseApkPath(sanitized);
    if (!remotePath) return null;

    await run(buildAdbCommand(`pull "${remotePath}" "${tempApkPath}"`));

    try {
      await fsp.access(tempApkPath, fs.constants.F_OK);
    } catch {
      return null;
    }

    const aapt2 = getAapt2Command();
    if (!aapt2) return null;

    const dumpOutput = await run(`${aapt2} dump badging "${tempApkPath}"`);
    const iconInfo = parseIconCandidatesFromDump(dumpOutput);
    const candidatePaths = buildCandidateResourcePaths(iconInfo);

    if (!candidatePaths.length) {
      return null;
    }

    const zip = new AdmZip(tempApkPath);
    const resourceIndex = buildResourceIndex(zip);

    for (const candidate of candidatePaths) {
      const entryInfo = selectResourceEntry(zip, resourceIndex, candidate);
      if (!entryInfo) continue;
      const success = await extractIconEntry(zip, resourceIndex, entryInfo, iconPath);
      if (success) {
        return iconPath;
      }
    }

    return null;
  } catch (error) {
    console.warn(`No se pudo extraer el icono para ${sanitized}:`, error.message);
    return null;
  } finally {
    try {
      await fsp.rm(workDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

async function listLaunchablePackages() {
  if (!currentDevice) {
    throw new Error('No hay un dispositivo conectado.');
  }

  const query = 'shell "cmd package query-activities -a android.intent.action.MAIN -c android.intent.category.LAUNCHER --brief"';
  const output = await run(buildAdbCommand(query));
  const packages = [];
  const seen = new Set();

  output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .forEach(line => {
      const normalized = line.startsWith('package:') ? line.slice('package:'.length).trim() : line;
      const pkg = normalized.split(/[\s/]+/)[0];
      if (pkg && /^[\w\.]+$/.test(pkg) && !seen.has(pkg)) {
        seen.add(pkg);
        packages.push(pkg);
      }
    });

  await ensureIconCacheDir();

  const cache = getAppLabelCache();
  const missingLabels = [];
  const missingIcons = [];
  const result = packages.map(pkg => {
    const cachedLabel = cache[pkg];
    if (!cachedLabel) {
      missingLabels.push(pkg);
    }
    const iconUrl = getCachedIconFileUrl(pkg);
    if (!iconUrl) {
      missingIcons.push(pkg);
    }
    return {
      package: pkg,
      name: cachedLabel || pkg,
      hasLabel: Boolean(cachedLabel),
      labelResolved: Boolean(cachedLabel),
      iconPath: iconUrl || '',
      hasIcon: Boolean(iconUrl),
      iconResolved: Boolean(iconUrl)
    };
  });

  if (missingLabels.length) {
    queueAppLabels(missingLabels);
  }

  if (missingIcons.length) {
    queueAppIcons(missingIcons);
  }

  return result;
}

async function launchApplication(pkg) {
  if (!currentDevice) {
    throw new Error('No hay un dispositivo conectado.');
  }
  const packageName = typeof pkg === 'string' ? pkg.trim() : '';
  if (!packageName) {
    throw new Error('Nombre de paquete inválido.');
  }
  const command = buildAdbCommand(`shell monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`);
  await run(command);
}

ipcMain.handle('close', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
  }
});

ipcMain.handle('minimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.minimize();
  }
});

ipcMain.handle('connect', async () => {
  const { devices } = await fetchAdbDevices();

  if (devices.length === 0) {
    currentDevice = '';
    throw new Error('No se detectaron dispositivos ADB conectados.');
  }

  if (devices.length > 1) {
    currentDevice = '';
    throw new Error('Se detectaron varios dispositivos. Conecta solo uno.');
  }

  const [device] = devices;
  if (device.state !== 'device') {
    currentDevice = '';
    const message = device.state === 'unauthorized'
      ? 'Autoriza la depuración USB en el dispositivo.'
      : `El dispositivo está en estado "${device.state}".`;
    throw new Error(message);
  }

  currentDevice = device.id;
  return { success: true, device };
});

ipcMain.handle('list-packages', async () => {
  return listLaunchablePackages();
});

ipcMain.handle('launch-app', async (_event, pkg) => {
  await launchApplication(pkg);
  return true;
});

app.whenReady().then(() => {
  const userDataPath = app.getPath('userData');
  PREF_PATH = path.join(userDataPath, 'preferences.json');
  ICON_CACHE_DIR = path.join(userDataPath, ICON_CACHE_DIR_NAME);
  void ensureIconCacheDir();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
