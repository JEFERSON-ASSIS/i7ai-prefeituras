const configured = import.meta.env.VITE_API_URL;
// In production the module lives under its base path (/i7ai/), so its API is /i7ai/api.
export const API_URL = (configured || (import.meta.env.DEV ? 'http://localhost:3000/api' : import.meta.env.BASE_URL.replace(/\/$/, '') + '/api')).replace(/\/$/, '');
export class ApiError extends Error {
  constructor(message, status) { super(message); this.name = 'ApiError'; this.status = status; }
}
export async function apiRequest(path, { token = '', method = 'GET', body, signal, raw = false } = {}) {
  const form = body instanceof FormData;
  let response;
  try {
    response = await fetch(API_URL + path, {
      method, signal,
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(!form && body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: form ? body : JSON.stringify(body) } : {}),
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError('Não foi possível conectar à API. Verifique se o serviço está disponível.', 0);
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const detail = Array.isArray(payload.message) ? payload.message.join(' ') : payload.message;
    if (response.status === 401) window.dispatchEvent(new Event('i7ai:session-expired'));
    throw new ApiError(detail || 'Não foi possível concluir a operação.', response.status);
  }
  if (raw) return response;
  if (response.status === 204) return null;
  return response.json();
}
