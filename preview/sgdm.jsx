// Development-only host simulator. Not imported by the production entry point.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppLayout, Sidebar, Select, Alert, ToastProvider } from '@sgdm/design';
import { Shield } from 'lucide-react';
import '@sgdm/design/tokens.css';
import '@sgdm/design/print.css';
import '../src/styles.css';
import { App, moduleNavigationGroups } from '../src/app-shell';
import { API_URL } from '../src/api/client';
import { fixtures } from '../test/visual/fixtures';

document.documentElement.classList.add('sgdm-app-shell');

if (!import.meta.env.DEV) throw new Error('Prévia disponível somente no servidor de desenvolvimento.');
window.__SGDM_CONTEXT__ = { accessToken: 'preview-synthetic-session', tenantName: 'Prefeitura de Teste', modulePage: 'dashboard', navigationManagedByHost: true };
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, options = {}) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith(API_URL + '/')) return originalFetch(input, options);
  const method = options.method || (input instanceof Request ? input.method : 'GET');
  const path = new URL(url, location.href).pathname.replace(/^\/api/, '');
  const status = method === 'GET' && Object.hasOwn(fixtures, path) ? 200 : 403;
  return new Response(JSON.stringify(status === 200 ? fixtures[path] : { message: 'Esta prévia usa dados de teste. Alterações e chamadas de IA estão desabilitadas.' }), { status, headers: { 'Content-Type': 'application/json' } });
};
const sections = moduleNavigationGroups.map(([label, items]) => ({
  label,
  items: items.map(([id,label,icon]) => ({href:'#/'+id,label,icon,exact:true})),
}));
function PreviewHost() {
  const [active, setActive] = useState('dashboard');
  function navigate(page) {
    window.__SGDM_CONTEXT__.modulePage = page;
    setActive(page);
    window.dispatchEvent(new Event('sgdm:context-updated'));
  }
  function endHostSession() {
    window.__SGDM_CONTEXT__.accessToken = '';
    window.dispatchEvent(new Event('sgdm:context-updated'));
  }
  useEffect(() => {
    const sync = event => { window.__SGDM_CONTEXT__.modulePage = event.detail.page; setActive(event.detail.page); };
    window.addEventListener('i7ai:navigate', sync);
    return () => window.removeEventListener('i7ai:navigate', sync);
  }, []);
  return <ToastProvider><AppLayout sidebar={<Sidebar brand={{ name: 'SGDM', subtitle: 'Gestão Digital Municipal', icon: <Shield/> }} sections={sections} currentPath={'#/' + active} onNavigate={href => navigate(href.slice(2))} onLogout={endHostSession} label="Menu do SGDM"/>} header={null}><div className="page-content"><div className="preview-mobile-navigation"><Select label="Área da prévia" value={active} onChange={event => navigate(event.target.value)}>{moduleNavigationGroups.map(([label, items]) => <optgroup key={label} label={label}>{items.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</optgroup>)}</Select></div><Alert tone="info">Prévia local com dados fictícios. O menu simula o SGDM usando os componentes oficiais. Cadastros e chamadas de IA estão desabilitados.</Alert><App/></div></AppLayout></ToastProvider>;
}
createRoot(document.getElementById('root')).render(<PreviewHost/>);
