import React from 'react';
import { createRoot } from 'react-dom/client';
import '@sgdm/design/tokens.css';
import '@sgdm/design/print.css';
import { ToastProvider } from '@sgdm/design';
import './styles.css';
import './sgdm-theme.css';
import './features.css';
import { App } from './app-shell';
import { StandaloneHost, startStandaloneContext } from './standalone-host';

const root = createRoot(document.getElementById('root'));

if (window.__SGDM_CONTEXT__) {
  // Embedded: the host page injected the context and owns menu and session.
  root.render(<ToastProvider><App/></ToastProvider>);
} else {
  // Own page at https://<sgdm>/i7ai/: same browser session as the SGDM web app.
  document.documentElement.classList.add('sgdm-app-shell');
  const initialPage = startStandaloneContext();
  window.addEventListener('i7ai:session-required', event => {
    // "Atualizar sessão": SGDM does not renew tokens by itself, so a missing or
    // expired session needs a new SGDM login (a login in another tab is picked up automatically).
    if (event.detail?.reason === 'refresh') location.href = import.meta.env.VITE_SGDM_LOGIN_URL || '/login';
  });
  root.render(<StandaloneHost initialPage={initialPage} />);
}
