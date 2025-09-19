const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

const WINDOW_WIDTH = 416;
const WINDOW_HEIGHT = 600;
const TEMP_APK_NAME = '__tmp_app_label.apk';
const LABEL_CACHE_KEY = '__appLabels';

const base = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
const adb = process.platform === 'win32' ? `"${path.join(base, 'adb.exe')}"` : 'adb';
let cachedAapt2Command = null;

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
    const pathOutput = await run(buildAdbCommand(`shell pm path ${sanitized}`));
    const remoteLine = pathOutput
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .find(line => line.includes('base.apk')) ||
      pathOutput.split(/\r?\n/).map(line => line.trim()).filter(Boolean)[0];

    if (!remoteLine) return null;

    const remotePath = remoteLine.startsWith('package:')
      ? remoteLine.slice('package:'.length).trim()
      : remoteLine;
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

async function resolveLabel(pkg) {
  const cache = getAppLabelCache();
  if (cache[pkg]) return cache[pkg];
  const label = await extractLabelForPackage(pkg);
  if (label) {
    rememberAppLabel(pkg, label);
  }
  return label || null;
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

  const result = [];
  for (const pkg of packages) {
    const label = await resolveLabel(pkg);
    result.push({
      package: pkg,
      name: label || pkg,
      hasLabel: Boolean(label)
    });
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
  PREF_PATH = path.join(app.getPath('userData'), 'preferences.json');
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
