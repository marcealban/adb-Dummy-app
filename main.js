const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const { pathToFileURL } = require('url');
let sharp = null;
try {
  // sharp is optional during development but required for adaptive icon composition
  // eslint-disable-next-line global-require, import/no-extraneous-dependencies
  sharp = require('sharp');
} catch (error) {
  console.warn('La librería sharp no está disponible:', error.message);
}

const WINDOW_WIDTH = 416;
const WINDOW_HEIGHT = 600;
const TEMP_APK_NAME = '__tmp_app_label.apk';
const LABEL_CACHE_KEY = '__appLabels';

const labelQueue = [];
const queuedLabelPackages = new Set();
let isProcessingLabelQueue = false;

const iconQueue = [];
const queuedIconPackages = new Set();
let isProcessingIconQueue = false;

const base = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
const ICON_CACHE_DIR = path.join(base, 'adb-Dummy-app_cache_iconos');
const TEMP_ICON_PREFIX = 'icono_';
const LOG_FILE_PATH = path.join(base, 'command.log');
const adb = process.platform === 'win32' ? `"${path.join(base, 'adb.exe')}"` : 'adb';
let cachedAapt2Command = null;
let cachedTarCommand = null;

const ANDROID_COLOR_MAP = {
  transparent: '#00000000',
  black: '#ff000000',
  white: '#ffffffff'
};

let mainWindow = null;
let currentDevice = '';
let PREF_PATH = null;
let appLabelCache = null;
const packageApkPathCache = new Map();
const apkEntriesCache = new Map();
const resourceTableCache = new Map();
const packageIconCache = new Map();

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

function ensureDirectory(targetPath) {
  if (!targetPath) return;
  try {
    fs.mkdirSync(targetPath, { recursive: true });
  } catch (error) {
    console.warn(`No se pudo crear el directorio ${targetPath}:`, error.message);
  }
}

function appendToLog(content) {
  if (!LOG_FILE_PATH) return;
  try {
    ensureDirectory(path.dirname(LOG_FILE_PATH));
    fs.appendFileSync(LOG_FILE_PATH, content, { encoding: 'utf8' });
  } catch (error) {
    console.warn('No se pudo escribir en el archivo de log:', error.message);
  }
}

function logCommand(command, stdout, stderr) {
  if (command) {
    appendToLog(command.endsWith('\n') ? command : `${command}\n`);
  }
  if (stdout) {
    const output = typeof stdout === 'string' ? stdout : stdout.toString('utf8');
    if (output) {
      appendToLog(output.endsWith('\n') ? output : `${output}\n`);
    }
  }
  if (stderr) {
    const errorOutput = typeof stderr === 'string' ? stderr : stderr.toString('utf8');
    if (errorOutput) {
      appendToLog(errorOutput.endsWith('\n') ? errorOutput : `${errorOutput}\n`);
    }
  }
}

function run(command, options = {}) {
  return new Promise((resolve, reject) => {
    const execOptions = { cwd: base, windowsHide: true, maxBuffer: 1024 * 1024, ...options };
    exec(command, execOptions, (error, stdout, stderr) => {
      try {
        logCommand(command, stdout, stderr);
      } catch {
        // ignore logging errors
      }
      if (error) {
        const message = stderr && stderr.trim() ? stderr.trim() : error.message;
        reject(new Error(message));
        return;
      }
      resolve(stdout);
    });
  });
}

function runBuffered(command, options = {}) {
  return new Promise((resolve, reject) => {
    const spawnOptions = { cwd: base, windowsHide: true, shell: true, ...options };
    const child = spawn(command, [], spawnOptions);
    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout?.on('data', chunk => {
      stdoutChunks.push(Buffer.from(chunk));
    });

    child.stderr?.on('data', chunk => {
      stderrChunks.push(Buffer.from(chunk));
    });

    child.on('error', error => {
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      try {
        logCommand(command, stdout, stderr);
      } catch {
        // ignore logging errors
      }
      reject(error);
    });

    child.on('close', code => {
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      try {
        logCommand(command, stdout, stderr);
      } catch {
        // ignore logging errors
      }
      if (code !== 0) {
        const errorMessage = stderr.length
          ? stderr.toString('utf8').trim() || `Proceso terminado con código ${code}`
          : `Proceso terminado con código ${code}`;
        reject(new Error(errorMessage));
        return;
      }
      resolve({ stdout, stderr });
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

function normalizeRemotePath(rawPath) {
  if (!rawPath) return '';
  const trimmed = rawPath.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('package:') ? trimmed.slice('package:'.length).trim() : trimmed;
}

function parseResourceValue(rawValue) {
  if (!rawValue) return null;
  const value = rawValue.trim();
  if (!value) return null;

  if (value.startsWith('@')) {
    const withoutAt = value.slice(1);
    if (/^0x[0-9a-f]+$/i.test(withoutAt)) {
      return { raw: value, resourceId: withoutAt.toLowerCase() };
    }
    const androidPrefixMatch = withoutAt.match(/^android:([\w\.]+)/i);
    if (androidPrefixMatch) {
      const remainder = withoutAt.replace(/^android:/i, '');
      const segments = remainder.split('/');
      if (segments.length === 2) {
        return { raw: value, type: segments[0], name: segments[1], android: true };
      }
    }
    const segments = withoutAt.split('/');
    if (segments.length === 2) {
      return { raw: value, type: segments[0], name: segments[1] };
    }
    return { raw: value };
  }

  if (isColorValue(value)) {
    return { raw: value, color: normalizeHexColor(value) };
  }

  return { raw: value, path: value };
}

async function fetchPackageApkPaths(pkg) {
  const sanitized = typeof pkg === 'string' ? pkg.trim() : '';
  if (!sanitized) return [];

  if (packageApkPathCache.has(sanitized)) {
    return packageApkPathCache.get(sanitized);
  }

  const command = buildAdbCommand(`shell pm path ${sanitized}`);
  let output = '';
  try {
    output = await run(command);
  } catch (error) {
    console.warn(`No se pudieron obtener los APK de ${sanitized}:`, error.message);
    packageApkPathCache.set(sanitized, []);
    return [];
  }

  const paths = output
    .split(/\r?\n/)
    .map(line => normalizeRemotePath(line))
    .filter(Boolean);

  const unique = Array.from(new Set(paths));
  packageApkPathCache.set(sanitized, unique);
  return unique;
}

async function downloadRemoteApks(targetPaths, tempDir, existingEntries = []) {
  const entries = Array.isArray(existingEntries) ? [...existingEntries] : [];
  const seenRemotes = new Set(entries.map(entry => normalizeRemotePath(entry.remotePath)));
  const usedNames = new Set(entries.map(entry => entry.fileName));
  let fallbackIndex = entries.length;

  for (let index = 0; index < targetPaths.length; index += 1) {
    const normalizedRemote = normalizeRemotePath(targetPaths[index]);
    if (!normalizedRemote || seenRemotes.has(normalizedRemote)) {
      continue;
    }

    const remoteBase = path.basename(normalizedRemote) || `split_${index}.apk`;
    const preferredName = /base\.apk$/i.test(remoteBase) ? 'base.apk' : remoteBase;
    let fileName = preferredName;
    while (usedNames.has(fileName)) {
      fallbackIndex += 1;
      fileName = `${fallbackIndex}_${preferredName}`;
    }

    const localPath = path.join(tempDir, fileName);
    await run(buildAdbCommand(`pull "${normalizedRemote}" "${localPath}"`), { cwd: tempDir });
    entries.push({ remotePath: normalizedRemote, localPath, fileName });
    seenRemotes.add(normalizedRemote);
    usedNames.add(fileName);
  }

  return entries;
}

async function pullPackageApks(pkg, remotePaths, options = {}) {
  const sanitized = typeof pkg === 'string' ? pkg.trim() : '';
  if (!sanitized) return null;

  const providedPaths = Array.isArray(remotePaths) ? remotePaths : null;
  const paths = providedPaths && providedPaths.length
    ? providedPaths.map(entry => normalizeRemotePath(entry)).filter(Boolean)
    : await fetchPackageApkPaths(sanitized);

  if (!paths.length) {
    return null;
  }

  const safeName = sanitized.replace(/[^\w\.\-]+/g, '_');
  const reuseTempDir = Boolean(options.reuseTempDir);
  const tempDirName = `${TEMP_ICON_PREFIX}${safeName}`;
  const tempDir = options.tempDir || path.join(base, tempDirName);

  if (!reuseTempDir) {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }

  ensureDirectory(tempDir);

  const existingEntries = Array.isArray(options.existingEntries)
    ? options.existingEntries.slice()
    : [];

  try {
    const pulled = await downloadRemoteApks(paths, tempDir, existingEntries);

    if (!pulled.length) {
      return { tempDir, apks: pulled, baseApk: null };
    }

    pulled.sort((a, b) => {
      const aBase = a.fileName === 'base.apk' || /base\.apk$/i.test(a.remotePath) ? 0 : 1;
      const bBase = b.fileName === 'base.apk' || /base\.apk$/i.test(b.remotePath) ? 0 : 1;
      if (aBase !== bBase) {
        return aBase - bBase;
      }
      return a.fileName.localeCompare(b.fileName);
    });

    const baseApkEntry = pulled.find(item => item.fileName === 'base.apk')
      || pulled.find(item => /base\.apk$/i.test(item.remotePath))
      || pulled[0];

    return {
      tempDir,
      apks: pulled,
      baseApk: baseApkEntry ? baseApkEntry.localPath : null
    };
  } catch (error) {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
    throw error;
  }
}

async function resolveIconFromApks(pkg, apks, baseApk, tempDir, options = {}) {
  const sanitized = typeof pkg === 'string' ? pkg.trim() : '';
  if (!sanitized || !Array.isArray(apks) || !apks.length || !baseApk || !tempDir) {
    return null;
  }

  const aapt2 = getAapt2Command();
  if (!aapt2) {
    return null;
  }

  const rasterOnly = Boolean(options.rasterOnly);
  let badgingOutput = '';
  try {
    badgingOutput = await run(`${aapt2} dump badging "${baseApk}"`, { cwd: tempDir });
  } catch (error) {
    if (rasterOnly) {
      return null;
    }
    throw error;
  }

  const iconEntries = parseApplicationIconLines(badgingOutput);
  const bestIcon = selectBestApplicationIcon(iconEntries, { preferRaster: rasterOnly });
  if (!bestIcon) {
    if (rasterOnly) {
      return null;
    }
    throw new Error('No se encontró referencia al icono en el APK');
  }

  const iconResource = parseResourceValue(bestIcon.value);
  if (!iconResource) {
    if (rasterOnly) {
      return null;
    }
    throw new Error('No se pudo interpretar la referencia al icono');
  }

  const rasterExtensions = ['png', 'webp', 'jpg', 'jpeg'];
  const rasterPreferred = ['.png', '.webp', '.jpg', '.jpeg'];
  const defaultPreferred = iconResource.path && iconResource.path.toLowerCase().endsWith('.png')
    ? ['.png']
    : ['.png', '.webp', '.xml', '.xml.flat'];

  const preferredExtensions = rasterOnly ? rasterPreferred : defaultPreferred;

  let resolvedIcon = await resolveResourceReference(iconResource, apks, preferredExtensions);
  if (!resolvedIcon && iconResource.path && !rasterOnly) {
    resolvedIcon = await resolveResourceReference(iconResource, apks, ['.xml', '.xml.flat', '.png', '.webp']);
  }

  if (!resolvedIcon) {
    if (rasterOnly) {
      return null;
    }
    throw new Error('No se pudo localizar el recurso físico del icono');
  }

  if (rasterOnly && !rasterExtensions.includes(resolvedIcon.format)) {
    return null;
  }

  const finalBaseName = `${sanitized}`;

  if (rasterExtensions.includes(resolvedIcon.format)) {
    const extension = resolvedIcon.format;
    const destination = path.join(ICON_CACHE_DIR, `${finalBaseName}.${extension}`);
    const extracted = await extractEntryToTemp(resolvedIcon.apkPath, resolvedIcon.entryPath, tempDir);
    await clearCachedIconFiles(sanitized, destination);
    await copyFileSafe(extracted, destination);
    packageIconCache.set(sanitized, destination);
    return destination;
  }

  if (rasterOnly) {
    return null;
  }

  const adaptiveExtracted = await extractEntryToTemp(resolvedIcon.apkPath, resolvedIcon.entryPath, tempDir);
  let adaptiveXmlPath = adaptiveExtracted;
  if (resolvedIcon.format === 'xml.flat') {
    adaptiveXmlPath = path.join(tempDir, 'adaptive_icon.xml');
    await run(`${aapt2} convert --output-format xml --output "${adaptiveXmlPath}" "${adaptiveExtracted}"`, { cwd: tempDir });
  }

  let adaptiveContent = '';
  try {
    adaptiveContent = await fs.promises.readFile(adaptiveXmlPath, 'utf8');
  } catch (error) {
    throw new Error('No se pudo leer el XML del icono adaptativo');
  }

  if (adaptiveContent.includes('<vector')) {
    const svgDestination = path.join(ICON_CACHE_DIR, `${finalBaseName}.svg`);
    await clearCachedIconFiles(sanitized, svgDestination);
    await convertVectorDrawableToSvg(adaptiveXmlPath, svgDestination, { cwd: tempDir });
    packageIconCache.set(sanitized, svgDestination);
    return svgDestination;
  }

  const backgroundLayer = await resolveAdaptiveLayerResource(adaptiveContent, 'background', apks, tempDir, finalBaseName);
  const foregroundLayer = await resolveAdaptiveLayerResource(adaptiveContent, 'foreground', apks, tempDir, finalBaseName);

  if (!foregroundLayer) {
    throw new Error('No se encontró el foreground del icono adaptativo');
  }

  if (sharp && (backgroundLayer || foregroundLayer)) {
    const composedDestination = path.join(ICON_CACHE_DIR, `${finalBaseName}.png`);
    try {
      await clearCachedIconFiles(sanitized, composedDestination);
      await composeAdaptiveIcon(composedDestination, backgroundLayer, foregroundLayer);
      packageIconCache.set(sanitized, composedDestination);
      return composedDestination;
    } catch (error) {
      console.warn(`No se pudo componer el icono adaptativo para ${sanitized}:`, error.message);
    }
  }

  if (foregroundLayer.type === 'raster' && foregroundLayer.path && foregroundLayer.format) {
    const destination = path.join(ICON_CACHE_DIR, `${finalBaseName}.${foregroundLayer.format}`);
    await clearCachedIconFiles(sanitized, destination);
    await copyFileSafe(foregroundLayer.path, destination);
    packageIconCache.set(sanitized, destination);
    return destination;
  }

  if (foregroundLayer.type === 'vector' && foregroundLayer.path) {
    const svgDestination = path.join(ICON_CACHE_DIR, `${finalBaseName}.svg`);
    await clearCachedIconFiles(sanitized, svgDestination);
    await copyFileSafe(foregroundLayer.path, svgDestination);
    packageIconCache.set(sanitized, svgDestination);
    return svgDestination;
  }

  if (foregroundLayer.type === 'color' && foregroundLayer.color && sharp) {
    const colorDestination = path.join(ICON_CACHE_DIR, `${finalBaseName}.png`);
    const rgba = colorStringToRgba(foregroundLayer.color);
    if (rgba) {
      await clearCachedIconFiles(sanitized, colorDestination);
      await sharp({
        create: {
          width: 512,
          height: 512,
          channels: 4,
          background: { r: rgba.r, g: rgba.g, b: rgba.b, alpha: rgba.a / 255 }
        }
      }).png().toFile(colorDestination);
      packageIconCache.set(sanitized, colorDestination);
      return colorDestination;
    }
  }

  throw new Error('No se pudo materializar el foreground del icono adaptativo');
}

async function getApkEntries(apkPath) {
  if (!apkPath) return [];

  if (apkEntriesCache.has(apkPath)) {
    return apkEntriesCache.get(apkPath);
  }

  const tar = getTarCommand();
  if (!tar) {
    apkEntriesCache.set(apkPath, []);
    return [];
  }

  try {
    const { stdout } = await runBuffered(`${tar} -tf "${apkPath}"`);
    const content = stdout.toString('utf8');
    const entries = content
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    apkEntriesCache.set(apkPath, entries);
    return entries;
  } catch (error) {
    console.warn(`No se pudo listar el contenido de ${apkPath}:`, error.message);
    apkEntriesCache.set(apkPath, []);
    return [];
  }
}

function getFormatFromEntry(entryPath) {
  if (!entryPath) return '';
  const lower = entryPath.toLowerCase();
  if (lower.endsWith('.png')) return 'png';
  if (lower.endsWith('.webp')) return 'webp';
  if (lower.endsWith('.jpg')) return 'jpg';
  if (lower.endsWith('.jpeg')) return 'jpeg';
  if (lower.endsWith('.xml.flat')) return 'xml.flat';
  if (lower.endsWith('.xml')) return 'xml';
  if (lower.endsWith('.svg')) return 'svg';
  return '';
}

const DENSITY_QUALIFIER_SCORES = {
  xxxhdpi: 800,
  xxhdpi: 700,
  xhdpi: 600,
  tvdpi: 550,
  hdpi: 500,
  nodpi: 480,
  anydpi: 300,
  mdpi: 250,
  ldpi: 200,
  sdpi: 180
};

function normalizePreferredExtensions(preferredExtensions) {
  const defaults = ['.png', '.webp', '.xml', '.xml.flat', '.jpg', '.jpeg'];
  const provided = Array.isArray(preferredExtensions) && preferredExtensions.length
    ? preferredExtensions
    : defaults;
  return provided
    .map(ext => {
      if (!ext) return '';
      let normalized = ext.toLowerCase();
      if (!normalized.startsWith('.')) {
        normalized = `.${normalized}`;
      }
      if (normalized === '.xmlflat') {
        return '.xml.flat';
      }
      return normalized;
    })
    .filter(Boolean);
}

function getDensityScore(entryPath) {
  if (!entryPath) return 0;
  const match = entryPath.match(/^res\/[^/]+-([^/]+)\//i);
  if (!match) {
    return 0;
  }
  const qualifiers = match[1].split('-');
  let best = 0;
  qualifiers.forEach(rawQualifier => {
    const qualifier = rawQualifier.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(DENSITY_QUALIFIER_SCORES, qualifier)) {
      best = Math.max(best, DENSITY_QUALIFIER_SCORES[qualifier]);
      return;
    }
    const dpiMatch = qualifier.match(/^(\d+)dpi$/);
    if (dpiMatch) {
      const numeric = Number.parseInt(dpiMatch[1], 10);
      if (!Number.isNaN(numeric)) {
        best = Math.max(best, numeric);
      }
    }
  });
  return best;
}

function formatToExtension(format) {
  if (!format) return '';
  if (format === 'xml.flat') {
    return '.xml.flat';
  }
  return `.${format.toLowerCase()}`;
}

function findResourceEntry(entries, resource, preferredExtensions) {
  if (!Array.isArray(entries) || !entries.length || !resource) return null;

  const extensions = normalizePreferredExtensions(preferredExtensions);
  const extensionPriority = new Map();
  extensions.forEach((ext, index) => {
    extensionPriority.set(ext, extensions.length - index);
  });

  if (resource.path) {
    const normalized = resource.path.replace(/^\/+/, '');
    if (entries.includes(normalized)) {
      return normalized;
    }
    const baseName = path.basename(normalized);
    const match = entries.find(entry => entry.endsWith(`/${baseName}`));
    if (match) {
      return match;
    }
  }

  const type = resource.type;
  const name = resource.name;
  if (!type || !name) {
    return null;
  }

  const baseName = name.replace(/^@/, '');
  const matches = [];

  for (const entry of entries) {
    if (!entry.startsWith(`res/${type}-`) && !entry.startsWith(`res/${type}/`)) {
      continue;
    }
    const format = getFormatFromEntry(entry);
    const extension = formatToExtension(format);
    if (!extensionPriority.has(extension)) {
      continue;
    }
    const fileName = path.basename(entry);
    const expected = extension === '.xml.flat' ? `${baseName}.xml.flat` : `${baseName}${extension}`;
    if (fileName !== expected) {
      continue;
    }
    const densityScore = getDensityScore(entry);
    matches.push({
      entry,
      extension,
      densityScore,
      priority: extensionPriority.get(extension)
    });
  }

  if (!matches.length) {
    return null;
  }

  matches.sort((a, b) => {
    if (a.priority !== b.priority) {
      return b.priority - a.priority;
    }
    if (a.densityScore !== b.densityScore) {
      return b.densityScore - a.densityScore;
    }
    return a.entry.localeCompare(b.entry);
  });

  return matches[0].entry;
}

async function resolveResourceReference(resource, apks, preferredExtensions) {
  if (!resource) return null;

  let working = { ...resource };
  if (working.resourceId && !working.type && !working.name) {
    const resolved = await resolveResourceId(working.resourceId, apks);
    if (resolved) {
      working = { ...working, ...resolved };
    }
  }

  if (working.android) {
    return null;
  }

  for (const apk of apks) {
    const entries = await getApkEntries(apk.localPath);
    const match = findResourceEntry(entries, working, preferredExtensions);
    if (match) {
      return {
        apkPath: apk.localPath,
        entryPath: match,
        format: getFormatFromEntry(match)
      };
    }
  }

  return null;
}

async function extractEntryToTemp(apkPath, entryPath, tempDir) {
  const tar = getTarCommand();
  if (!tar) {
    throw new Error('Herramienta tar no disponible');
  }

  const extractionRoot = path.join(tempDir, '__extract');
  ensureDirectory(extractionRoot);
  await run(`${tar} -xf "${apkPath}" -C "${extractionRoot}" "${entryPath}"`, { cwd: tempDir });
  return path.join(extractionRoot, entryPath);
}

async function copyFileSafe(source, destination) {
  ensureDirectory(path.dirname(destination));
  await fs.promises.copyFile(source, destination);
  return destination;
}

function extractDrawableFromXml(xmlContent, tagName) {
  if (!xmlContent || !tagName) return null;
  const selfClosingPattern = new RegExp(`<${tagName}[^>]*?>`, 'i');
  const blockPattern = new RegExp(`<${tagName}[^>]*?>[\s\S]*?<\/${tagName}>`, 'i');
  const combined = xmlContent.match(selfClosingPattern) || xmlContent.match(blockPattern);
  if (!combined) return null;
  const segment = combined[0];
  const attrMatch = segment.match(/android:(?:drawable|src|color)="([^"]+)"/i)
    || segment.match(/android:(?:drawable|src|color)='([^']+)'/i);
  if (attrMatch) {
    return attrMatch[1];
  }
  return null;
}

function isColorValue(value) {
  if (!value) return false;
  const trimmed = value.trim();
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(trimmed);
}

function normalizeHexColor(value) {
  if (!isColorValue(value)) return null;
  const trimmed = value.trim().slice(1).toLowerCase();
  if (trimmed.length === 3) {
    return `#${trimmed.split('').map(ch => `${ch}${ch}`).join('')}`;
  }
  if (trimmed.length === 4) {
    const expanded = trimmed.split('').map(ch => `${ch}${ch}`).join('');
    return `#${expanded}`;
  }
  return `#${trimmed}`;
}

function colorStringToRgba(color) {
  if (!color) return null;
  const normalized = normalizeHexColor(color);
  if (!normalized) return null;
  const hex = normalized.slice(1);
  let alpha = 255;
  let offset = 0;
  if (hex.length === 8) {
    alpha = Number.parseInt(hex.slice(0, 2), 16);
    offset = 2;
  } else if (hex.length !== 6) {
    return null;
  }
  const r = Number.parseInt(hex.slice(offset, offset + 2), 16);
  const g = Number.parseInt(hex.slice(offset + 2, offset + 4), 16);
  const b = Number.parseInt(hex.slice(offset + 4, offset + 6), 16);
  return { r, g, b, a: alpha };
}

async function materializeResolvedResource(resolved, apks, tempDir, options = {}) {
  if (!resolved) return null;
  const { apkPath, entryPath, format } = resolved;
  if (!apkPath || !entryPath || !format) {
    return null;
  }

  const suffix = options.suffix || 'layer';

  if (['png', 'webp', 'jpg', 'jpeg'].includes(format)) {
    const extracted = await extractEntryToTemp(apkPath, entryPath, tempDir);
    return { type: 'raster', path: extracted, format };
  }

  let xmlPath = await extractEntryToTemp(apkPath, entryPath, tempDir);
  if (format === 'xml.flat') {
    const aapt2 = getAapt2Command();
    if (!aapt2) {
      return null;
    }
    const convertedPath = path.join(tempDir, `${suffix}.xml`);
    await run(`${aapt2} convert --output-format xml --output "${convertedPath}" "${xmlPath}"`, { cwd: tempDir });
    xmlPath = convertedPath;
  }

  let xmlContent = '';
  try {
    xmlContent = await fs.promises.readFile(xmlPath, 'utf8');
  } catch {
    return null;
  }

  if (/<vector[\s>]/i.test(xmlContent)) {
    const svgPath = path.join(tempDir, `${suffix}.svg`);
    await convertVectorDrawableToSvg(xmlPath, svgPath, { cwd: tempDir });
    return { type: 'vector', path: svgPath, format: 'svg' };
  }

  const nestedTags = ['bitmap', 'item', 'inset'];
  for (const tag of nestedTags) {
    const nestedRef = extractDrawableFromXml(xmlContent, tag);
    if (nestedRef) {
      const nestedResource = parseResourceValue(nestedRef);
      if (nestedResource) {
        const nested = await resolveResourceReference(nestedResource, apks, ['.png', '.webp', '.jpg', '.jpeg', '.xml', '.xml.flat']);
        if (nested) {
          return materializeResolvedResource(nested, apks, tempDir, { suffix: `${suffix}_${tag}` });
        }
      }
    }
  }

  const colorAttrMatch = xmlContent.match(/android:(?:color|value)="([^"]+)"/i)
    || xmlContent.match(/android:(?:color|value)='([^']+)'/i);
  if (colorAttrMatch && isColorValue(colorAttrMatch[1])) {
    return { type: 'color', color: normalizeHexColor(colorAttrMatch[1]), format: 'color' };
  }

  const colorNodeMatch = xmlContent.match(/<color[^>]*>([^<]+)<\/color>/i);
  if (colorNodeMatch && isColorValue(colorNodeMatch[1])) {
    return { type: 'color', color: normalizeHexColor(colorNodeMatch[1]), format: 'color' };
  }

  return null;
}

async function resolveAdaptiveLayerResource(adaptiveContent, layerTag, apks, tempDir, baseName) {
  if (!adaptiveContent || !layerTag) return null;
  const drawableRef = extractDrawableFromXml(adaptiveContent, layerTag);
  if (!drawableRef) {
    return null;
  }
  const resource = parseResourceValue(drawableRef);
  if (!resource) {
    return null;
  }
  if (resource.color) {
    return { type: 'color', color: resource.color, format: 'color' };
  }
  if (resource.android && resource.type === 'color' && resource.name) {
    const mappedColor = ANDROID_COLOR_MAP[resource.name.toLowerCase()];
    if (mappedColor) {
      return { type: 'color', color: normalizeHexColor(mappedColor), format: 'color' };
    }
  }
  const resolved = await resolveResourceReference(resource, apks, ['.png', '.webp', '.jpg', '.jpeg', '.xml', '.xml.flat']);
  if (!resolved) {
    return null;
  }
  const suffix = `${baseName}_${layerTag}`;
  const materialized = await materializeResolvedResource(resolved, apks, tempDir, { suffix });
  if (!materialized) {
    return null;
  }
  return { ...materialized, resource, resolved };
}

async function composeAdaptiveIcon(destination, backgroundLayer, foregroundLayer) {
  if (!sharp) {
    throw new Error('sharp no está disponible');
  }

  const size = 512;
  let base = null;

  if (backgroundLayer) {
    if (backgroundLayer.type === 'color') {
      const rgba = colorStringToRgba(backgroundLayer.color);
      const background = rgba
        ? { r: rgba.r, g: rgba.g, b: rgba.b, alpha: rgba.a / 255 }
        : { r: 0, g: 0, b: 0, alpha: 0 };
      base = sharp({
        create: {
          width: size,
          height: size,
          channels: 4,
          background
        }
      });
    } else if (backgroundLayer.path) {
      base = sharp(backgroundLayer.path);
    }
  }

  if (!base) {
    base = sharp({
      create: {
        width: size,
        height: size,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    });
  }

  const composites = [];
  if (foregroundLayer) {
    if (foregroundLayer.type === 'color') {
      const rgba = colorStringToRgba(foregroundLayer.color);
      if (rgba) {
        const buffer = await sharp({
          create: {
            width: size,
            height: size,
            channels: 4,
            background: { r: rgba.r, g: rgba.g, b: rgba.b, alpha: rgba.a / 255 }
          }
        }).png().toBuffer();
        composites.push({ input: buffer, gravity: 'center' });
      }
    } else if (foregroundLayer.path) {
      composites.push({ input: foregroundLayer.path, gravity: 'center' });
    }
  }

  ensureDirectory(path.dirname(destination));
  await base
    .resize(size, size, { fit: 'cover' })
    .ensureAlpha()
    .composite(composites)
    .png()
    .toFile(destination);

  return destination;
}

async function convertVectorDrawableToSvg(vectorXmlPath, destinationPath, options = {}) {
  ensureDirectory(path.dirname(destinationPath));
  const cwd = options.cwd || path.dirname(vectorXmlPath);
  await run(`npx --yes vector-drawable-svg "${vectorXmlPath}" "${destinationPath}"`, { cwd });
  await fs.promises.access(destinationPath, fs.constants.F_OK);
  const stats = await fs.promises.stat(destinationPath);
  if (!stats || !stats.size) {
    throw new Error('El SVG generado está vacío');
  }
  return destinationPath;
}

async function getResourceTable(apkPath) {
  if (!apkPath) return new Map();

  if (resourceTableCache.has(apkPath)) {
    return resourceTableCache.get(apkPath);
  }

  const aapt2 = getAapt2Command();
  if (!aapt2) {
    resourceTableCache.set(apkPath, new Map());
    return resourceTableCache.get(apkPath);
  }

  try {
    const output = await run(`${aapt2} dump resources "${apkPath}"`);
    const table = new Map();
    output.split(/\r?\n/).forEach(line => {
      const match = line.match(/resource\s+0x([0-9a-f]+)\s+([^\s:]+)\s*:/i);
      if (!match) return;
      const id = match[1].toLowerCase();
      const typeAndName = match[2];
      const segments = typeAndName.split('/');
      if (segments.length !== 2) return;
      const [type, name] = segments;
      if (!type || !name) return;
      table.set(id, { type, name });
    });
    resourceTableCache.set(apkPath, table);
    return table;
  } catch (error) {
    console.warn(`No se pudo obtener la tabla de recursos de ${apkPath}:`, error.message);
    const empty = new Map();
    resourceTableCache.set(apkPath, empty);
    return empty;
  }
}

async function resolveResourceId(resourceId, apks) {
  if (!resourceId) return null;
  const normalized = resourceId.replace(/^@/, '').toLowerCase();
  if (!normalized) return null;

  for (const apk of apks) {
    const table = await getResourceTable(apk.localPath);
    if (table.has(normalized)) {
      return table.get(normalized);
    }
  }

  return null;
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
    ensureDirectory(path.dirname(PREF_PATH));
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
  if (!getCachedIconPath(pkg)) {
    queueAppIcons([pkg]);
  }
}

function getCachedIconPath(pkg) {
  if (!pkg) return null;
  if (packageIconCache.has(pkg)) {
    return packageIconCache.get(pkg);
  }
  const candidates = ['.svg', '.png', '.webp', '.jpg', '.jpeg']
    .map(ext => path.join(ICON_CACHE_DIR, `${pkg}${ext}`));
  const existing = candidates.find(candidate => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
  if (existing) {
    packageIconCache.set(pkg, existing);
    return existing;
  }
  return null;
}

function iconPathToUrl(iconPath) {
  if (!iconPath) return '';
  try {
    return pathToFileURL(iconPath).href;
  } catch {
    return '';
  }
}

async function clearCachedIconFiles(pkg, keepPath) {
  const sanitized = typeof pkg === 'string' ? pkg.trim() : '';
  if (!sanitized) return;
  const keepNormalized = keepPath ? path.normalize(keepPath) : null;
  const candidates = ['.svg', '.png', '.webp', '.jpg', '.jpeg']
    .map(ext => path.join(ICON_CACHE_DIR, `${sanitized}${ext}`));
  for (const candidate of candidates) {
    const normalizedCandidate = path.normalize(candidate);
    if (keepNormalized && normalizedCandidate === keepNormalized) {
      continue;
    }
    try {
      await fs.promises.rm(candidate, { force: true });
    } catch {
      // ignore deletion errors
    }
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
  const labelCache = getAppLabelCache();
  packages.forEach(pkg => {
    const normalized = typeof pkg === 'string' ? pkg.trim() : '';
    if (!normalized) return;
    if (!labelCache[normalized]) return;
    if (getCachedIconPath(normalized)) return;
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
      if (pkg) {
        queuedIconPackages.delete(pkg);
      }
      if (!pkg) continue;

      const labelCache = getAppLabelCache();
      if (!labelCache[pkg]) {
        continue;
      }

      const cached = getCachedIconPath(pkg);
      if (cached) {
        emitToRenderer('package-icon-updated', {
          package: pkg,
          iconPath: iconPathToUrl(cached),
          success: true
        });
        continue;
      }

      emitToRenderer('package-icon-started', pkg);

      let iconPath = null;
      try {
        iconPath = await extractIconForPackage(pkg);
      } catch (error) {
        console.warn(`No se pudo extraer el icono para ${pkg}:`, error.message);
      }

      if (iconPath) {
        const finalPath = getCachedIconPath(pkg) || iconPath;
        emitToRenderer('package-icon-updated', {
          package: pkg,
          iconPath: iconPathToUrl(finalPath),
          success: true
        });
      } else {
        emitToRenderer('package-icon-updated', {
          package: pkg,
          iconPath: '',
          success: false
        });
      }
    }
  } finally {
    isProcessingIconQueue = false;
  }
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

function parseApplicationIconLines(output) {
  if (!output) return [];
  const lines = output.split(/\r?\n/);
  const icons = [];
  lines.forEach(line => {
    const match = line.match(/^application-icon-(\d+):'(.*)'$/);
    if (!match) return;
    const density = Number.parseInt(match[1], 10);
    const value = match[2];
    if (!Number.isNaN(density) && value) {
      icons.push({ density, value });
    }
  });
  return icons;
}

function selectBestApplicationIcon(icons, options = {}) {
  if (!Array.isArray(icons) || !icons.length) return null;

  const { preferRaster = false } = options;
  const scoreForIcon = icon => (icon.density === 65535 ? Number.MAX_SAFE_INTEGER : icon.density);

  if (preferRaster) {
    const rasterIcons = icons.filter(icon => {
      if (!icon || !icon.value) return false;
      const lower = icon.value.toLowerCase();
      return lower.endsWith('.png') || lower.endsWith('.webp') || lower.endsWith('.jpg') || lower.endsWith('.jpeg');
    });

    if (rasterIcons.length) {
      let bestRaster = rasterIcons[0];
      let bestRasterScore = scoreForIcon(bestRaster);
      for (let index = 1; index < rasterIcons.length; index += 1) {
        const icon = rasterIcons[index];
        const score = scoreForIcon(icon);
        if (score > bestRasterScore) {
          bestRaster = icon;
          bestRasterScore = score;
        }
      }
      return bestRaster;
    }
  }

  let best = icons[0];
  let bestScore = scoreForIcon(best);
  for (let index = 1; index < icons.length; index += 1) {
    const icon = icons[index];
    const score = scoreForIcon(icon);
    if (score > bestScore) {
      best = icon;
      bestScore = score;
    }
  }
  return best;
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

function getTarCommand() {
  if (cachedTarCommand !== null) {
    return cachedTarCommand;
  }

  if (process.platform === 'win32') {
    const systemTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(systemTar)) {
      cachedTarCommand = `"${systemTar}"`;
      return cachedTarCommand;
    }
  }

  cachedTarCommand = 'tar';
  return cachedTarCommand;
}

async function extractLabelForPackage(pkg) {
  const sanitized = typeof pkg === 'string' ? pkg.trim() : '';
  if (!sanitized) return null;

  const tempApkPath = path.join(base, TEMP_APK_NAME);
  try {
    const remotePaths = await fetchPackageApkPaths(sanitized);
    const remotePath = remotePaths.find(entry => /base\.apk$/i.test(entry)) || remotePaths[0];
    if (!remotePath) return null;

    try {
      await fs.promises.rm(tempApkPath, { force: true });
    } catch {
      // ignore cleanup errors
    }

    await run(buildAdbCommand(`pull "${remotePath}" "${TEMP_APK_NAME}"`));

    try {
      await fs.promises.access(tempApkPath, fs.constants.F_OK);
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
      await fs.promises.rm(tempApkPath, { force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

async function extractIconForPackage(pkg) {
  const sanitized = typeof pkg === 'string' ? pkg.trim() : '';
  if (!sanitized) return null;

  const aapt2 = getAapt2Command();
  const tar = getTarCommand();
  if (!aapt2) {
    throw new Error('aapt2 no está disponible');
  }
  if (!tar) {
    throw new Error('tar no está disponible');
  }

  const remotePaths = await fetchPackageApkPaths(sanitized);
  if (!remotePaths.length) {
    throw new Error('No se pudieron obtener los APK de la aplicación');
  }

  const baseRemotePath = remotePaths.find(entry => /base\.apk$/i.test(entry)) || remotePaths[0];
  if (!baseRemotePath) {
    throw new Error('No se encontró el APK base');
  }

  ensureDirectory(ICON_CACHE_DIR);

  const basePulled = await pullPackageApks(sanitized, [baseRemotePath]);
  if (!basePulled || !basePulled.apks || !basePulled.apks.length || !basePulled.baseApk) {
    if (basePulled && basePulled.tempDir) {
      try {
        await fs.promises.rm(basePulled.tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    throw new Error('No se pudo descargar el APK base');
  }

  let { tempDir } = basePulled;
  let apks = basePulled.apks;
  let baseApk = basePulled.baseApk;

  const cleanup = async () => {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  };

  try {
    const rasterResult = await resolveIconFromApks(sanitized, apks, baseApk, tempDir, { rasterOnly: true });
    if (rasterResult) {
      return rasterResult;
    }

    const remainingPaths = remotePaths.filter(path => path !== baseRemotePath);
    if (remainingPaths.length) {
      const fullPulled = await pullPackageApks(sanitized, remainingPaths, {
        reuseTempDir: true,
        existingEntries: apks,
        tempDir
      });
      apks = fullPulled.apks;
      baseApk = fullPulled.baseApk || baseApk;
    }

    const finalResult = await resolveIconFromApks(sanitized, apks, baseApk, tempDir);
    if (!finalResult) {
      throw new Error('No se pudo extraer el icono de la aplicación');
    }
    return finalResult;
  } finally {
    await cleanup();
  }
}

async function listUserPackages() {
  if (!currentDevice) {
    throw new Error('No hay un dispositivo conectado.');
  }

  const query = 'shell "pm list packages --user 0 -3"';
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

  const cache = getAppLabelCache();
  const missing = [];
  const missingIcons = [];
  const result = packages.map(pkg => {
    const cachedLabel = cache[pkg];
    const iconPath = getCachedIconPath(pkg);
    const iconResolved = Boolean(iconPath);
    if (!iconResolved) {
      missingIcons.push(pkg);
    }
    if (!cachedLabel) {
      missing.push(pkg);
    }
    return {
      package: pkg,
      name: cachedLabel || pkg,
      hasLabel: Boolean(cachedLabel),
      labelResolved: Boolean(cachedLabel),
      iconResolved,
      iconPath: iconResolved ? iconPathToUrl(iconPath) : ''
    };
  });

  if (missing.length) {
    queueAppLabels(missing);
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
  return listUserPackages();
});

ipcMain.handle('launch-app', async (_event, pkg) => {
  await launchApplication(pkg);
  return true;
});

app.whenReady().then(() => {
  PREF_PATH = path.join(app.getPath('userData'), 'preferences.json');
  ensureDirectory(ICON_CACHE_DIR);
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
