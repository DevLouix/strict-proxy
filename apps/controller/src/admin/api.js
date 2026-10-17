/**
 * API client for the admin dashboard.
 *
 * Holds the access/refresh pair in sessionStorage only. On a 401 it attempts
 * exactly one refresh (no parallel stampede); if that fails the session is
 * dropped and the caller is asked to re-authenticate.
 */

const STORAGE_KEY = 'strictproxy.admin.session';

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `Request failed (${status})`);
    this.status = status;
    this.code = body?.code ?? null;
    this.body = body;
  }
}

function loadSession() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSession(session) {
  try {
    if (session) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable (private mode) — the session just won't persist */
  }
}

export function getSession() {
  return loadSession();
}

export function clearSession() {
  saveSession(null);
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

/** Performs a raw request against the API and parses the response. */
async function send(method, path, { body, token, retry = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await res.text();
  let parsed = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { error: raw };
    }
  }

  if (res.status === 401 && retry) {
    const refreshed = await tryRefresh();
    if (refreshed) return send(method, path, { body, token: refreshed, retry: false });
    clearSession();
    onUnauthorized();
  }
  if (!res.ok) throw new ApiError(res.status, parsed);
  return parsed;
}

async function tryRefresh() {
  const session = loadSession();
  if (!session?.refreshToken || !session?.deviceId) return null;
  try {
    const res = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: session.refreshToken, deviceId: session.deviceId }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const next = { accessToken: data.accessToken, refreshToken: data.refreshToken, deviceId: session.deviceId };
    saveSession(next);
    return next.accessToken;
  } catch {
    return null;
  }
}

export class ApiClient {
  async login(email, password) {
    const deviceId = getOrCreateDeviceId();
    const data = await send('POST', '/api/v1/auth/login', { body: { email, password, deviceId, deviceName: 'admin-console' } });
    saveSession({ accessToken: data.accessToken, refreshToken: data.refreshToken, deviceId, email: data.user?.email ?? email });
    return data;
  }

  async logout() {
    const session = loadSession();
    if (session?.accessToken) {
      try {
        // Send the refresh token too: revoking only the access token would
        // leave a credential that can mint a new one straight away.
        await send('POST', '/api/v1/auth/logout', {
          token: session.accessToken,
          body: { refreshToken: session.refreshToken },
          retry: false,
        });
      } catch {
        /* logging out locally is what matters */
      }
    }
    clearSession();
  }

  async me() {
    return send('GET', '/api/v1/me', { token: this.token() });
  }

  token() {
    return loadSession()?.accessToken ?? null;
  }

  get(path) {
    return send('GET', path, { token: this.token() });
  }

  post(path, body) {
    return send('POST', path, { body, token: this.token() });
  }

  patch(path, body) {
    return send('PATCH', path, { body, token: this.token() });
  }

  put(path, body) {
    return send('PUT', path, { body, token: this.token() });
  }

  del(path) {
    return send('DELETE', path, { token: this.token() });
  }
}

/**
 * Stable per-browser device id, so the admin's refresh token keeps its seat
 * across reloads instead of evicting another session.
 */
function getOrCreateDeviceId() {
  const key = 'strictproxy.admin.device';
  try {
    let id = localStorage.getItem(key);
    if (!id) {
      id = (crypto.randomUUID?.() ?? `admin-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    return `admin-${Date.now()}`;
  }
}