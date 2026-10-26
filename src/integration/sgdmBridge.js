/**
 * Adapter de integração com o SGDM.
 * Em produção, o sistema principal injeta o contexto do usuário antes de
 * montar o módulo. O módulo não cria sessão nem coleta credenciais próprias.
 */
export function getSgdmContext() {
  const injected = window.__SGDM_CONTEXT__ || {};
  const stored = sessionStorage.getItem('sgdm-context');
  let parsed = {};
  try { parsed = stored ? JSON.parse(stored) : {}; } catch { parsed = {}; }
  return { ...parsed, ...injected };
}

/**
 * Served at /i7ai on the SGDM domain, the module shares the browser storage of
 * the SGDM web app, which keeps its session in localStorage['sgdm-auth'].
 */
export function getSgdmStoredToken() {
  try {
    const token = JSON.parse(localStorage.getItem('sgdm-auth') || 'null')?.state?.accessToken;
    return typeof token === 'string' ? token : '';
  } catch {
    return '';
  }
}

export function getSgdmToken() {
  return getSgdmContext().accessToken || sessionStorage.getItem('sgdm-access-token') || getSgdmStoredToken();
}
