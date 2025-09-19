const { exec } = require('child_process');

const POLL_INTERVAL_MS = 500;
const ABSENCE_TOLERANCE_MS = 10_000;
const WINDOWS_PLATFORM = 'win32';

const listeners = new Map();
let pollTimer = null;
let polling = false;

function normalizeTitle(title) {
  if (typeof title !== 'string') return '';
  return title.trim().replace(/\s+/g, ' ');
}

function parseWindowList(raw) {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map(t => (typeof t === 'string' ? t.trim() : '')).filter(Boolean);
    }
    if (typeof parsed === 'string') {
      const normalized = parsed.trim();
      return normalized ? [normalized] : [];
    }
  } catch (error) {
    // ignore parse failures
  }
  return [];
}

function pollWindows() {
  if (process.platform !== WINDOWS_PLATFORM) return;
  if (!listeners.size) return;
  if (polling) return;
  polling = true;

  const command =
    'powershell -NoProfile -Command "Get-Process scrcpy | Where-Object { $_.MainWindowTitle } | ' +
    'ForEach-Object { $_.MainWindowTitle } | ConvertTo-Json -Compress"';

  exec(command, { windowsHide: true }, (error, stdout) => {
    polling = false;
    const titles = error ? [] : parseWindowList(stdout);
    const visibleTitles = new Set(titles.map(normalizeTitle));
    const now = Date.now();

    for (const [id, entry] of listeners.entries()) {
      if (!entry) continue;
      const expectedTitle = entry.title;
      if (!expectedTitle) {
        if (!entry.visible) {
          entry.visible = true;
          entry.lastSeenAt = now;
          entry.callback(true);
        }
        continue;
      }
      if (visibleTitles.has(expectedTitle)) {
        entry.lastSeenAt = now;
        if (!entry.visible) {
          entry.visible = true;
          entry.callback(true);
        }
        continue;
      }

      if (!entry.lastSeenAt) {
        // Never seen yet; keep waiting.
        continue;
      }

      if (entry.visible && now - entry.lastSeenAt >= ABSENCE_TOLERANCE_MS) {
        entry.visible = false;
        entry.callback(false);
      }
    }
  });
}

function ensurePolling() {
  if (process.platform !== WINDOWS_PLATFORM) return;
  if (pollTimer || !listeners.size) return;
  pollTimer = setInterval(pollWindows, POLL_INTERVAL_MS);
  if (typeof pollTimer.unref === 'function') {
    pollTimer.unref();
  }
}

function maybeStopPolling() {
  if (!pollTimer || listeners.size) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function register(id, title, callback) {
  if (!id || typeof callback !== 'function') return;
  const normalizedTitle = normalizeTitle(title);
  const entry = {
    title: normalizedTitle,
    callback,
    visible: false,
    lastSeenAt: 0
  };
  listeners.set(id, entry);

  if (process.platform !== WINDOWS_PLATFORM) {
    entry.visible = true;
    entry.lastSeenAt = Date.now();
    callback(true);
    return;
  }

  ensurePolling();
  pollWindows();
}

function unregister(id) {
  listeners.delete(id);
  if (process.platform !== WINDOWS_PLATFORM) return;
  maybeStopPolling();
}

module.exports = {
  register,
  unregister
};
