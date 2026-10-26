// Local development host. Production uses the same shell from src/main.jsx at /i7ai/.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Alert } from '@sgdm/design';
import '@sgdm/design/tokens.css';
import '@sgdm/design/print.css';
import '../src/styles.css';
import '../src/sgdm-theme.css';
import '../src/features.css';
import { StandaloneHost, startStandaloneContext } from '../src/standalone-host';

document.documentElement.classList.add('sgdm-app-shell');

if (!import.meta.env.DEV || !['localhost', '127.0.0.1'].includes(location.hostname)) {
  throw new Error('Acesso disponível somente no ambiente local de desenvolvimento.');
}

const initialPage = startStandaloneContext();

function endSession(clear) {
  window.__SGDM_CONTEXT__.accessToken = '';
  sessionStorage.removeItem('sgdm-access-token');
  sessionStorage.removeItem('sgdm-context');
  clear();
  window.dispatchEvent(new Event('sgdm:context-updated'));
}

createRoot(document.getElementById('root')).render(<StandaloneHost initialPage={initialPage} exitLabel="Sair" onExit={endSession}
  notice={<Alert tone="info">Ambiente local de desenvolvimento. Os dados e alterações pertencem a este projeto.</Alert>} />);
