export function getSession() {
  try {
    const raw = localStorage.getItem('floatchat_session');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveSession(session) {
  localStorage.setItem('floatchat_session', JSON.stringify(session));
}

export function clearSession() {
  localStorage.removeItem('floatchat_session');
}

export function authHeaders(extra = {}) {
  const session = getSession();
  const headers = { ...extra };
  if (session?.token) headers.Authorization = `Bearer ${session.token}`;
  return headers;
}
