// Shell used when the module runs on its own page (https://<sgdm>/i7ai/ or local
// development): it supplies the SGDM-style menu that a host would otherwise provide.
import React, { useEffect, useState } from 'react';
import { AppLayout, Button, Select, Sidebar, ToastProvider } from '@sgdm/design';
import { Shield } from 'lucide-react';
import { App, moduleNavigationGroups } from './app-shell';
import { getSgdmContext, getSgdmToken } from './integration/sgdmBridge';
import { hasPermission } from './api/permissions';
import { useApi } from './hooks/useApi';

const pages = new Set(moduleNavigationGroups.flatMap(([, items]) => items.map(([id]) => id)));
const route = () => {
  const page = location.hash.replace(/^#\//, '');
  return pages.has(page) ? page : 'dashboard';
};

export function startStandaloneContext() {
  const initialPage = route();
  window.__SGDM_CONTEXT__ = { ...getSgdmContext(), modulePage: initialPage, navigationManagedByHost: true };
  return initialPage;
}

export function StandaloneHost({ initialPage, notice = null, exitLabel = 'Voltar ao SGDM', onExit }) {
  const [active, setActive] = useState(initialPage);
  const [token, setToken] = useState(getSgdmToken());
  const session = useApi(token ? '/auth/me' : null, token, null);
  const availableGroups = moduleNavigationGroups.map(([label, items]) => [label,
    items.filter(([id]) => token && hasPermission(session.data?.permissions || [], {
      knowledge: 'knowledge-bases', chat: 'agents', integrations: 'tools', reports: 'reports',
    }[id] || id, 'read')),
  ]).filter(([, items]) => items.length);
  const sections = availableGroups.map(([label, items]) => ({ label,
    items: items.map(([id, title, icon]) => ({ href: '#/' + id, label: title, icon, exact: true })),
  }));
  function update(page, notifyModule, pushHistory = true) {
    if (!pages.has(page)) return;
    window.__SGDM_CONTEXT__.modulePage = page;
    setActive(page);
    if (pushHistory && location.hash !== '#/' + page) history.pushState(null, '', '#/' + page);
    if (notifyModule) window.dispatchEvent(new Event('sgdm:context-updated'));
  }
  function exit() {
    if (onExit) onExit(() => setToken(''));
    else location.href = '/';
  }
  useEffect(() => {
    if (!location.hash) history.replaceState(null, '', '#/' + initialPage);
    const sync = event => update(event.detail?.page, false);
    const restore = () => update(route(), true, false);
    // SGDM login, logout or token change in another tab updates the menu too.
    const storage = () => setToken(getSgdmToken());
    window.addEventListener('i7ai:navigate', sync);
    window.addEventListener('popstate', restore);
    window.addEventListener('hashchange', restore);
    window.addEventListener('storage', storage);
    window.addEventListener('sgdm:context-updated', storage);
    return () => {
      window.removeEventListener('i7ai:navigate', sync);
      window.removeEventListener('popstate', restore);
      window.removeEventListener('hashchange', restore);
      window.removeEventListener('storage', storage);
      window.removeEventListener('sgdm:context-updated', storage);
    };
  }, []);
  return <ToastProvider><AppLayout
    sidebar={<Sidebar brand={{ name: 'SGDM', subtitle: 'Gestão Digital Municipal', icon: <Shield /> }}
      sections={sections} currentPath={'#/' + active} onNavigate={href => update(href.slice(2), true)}
      onLogout={exit} label="Menu do SGDM" />}
    header={null}>
    <div className="page-content">
      <div className="preview-mobile-navigation"><div className="form-stack"><Select label="Área do i7Ai" value={active}
        onChange={event => update(event.target.value, true)}>{availableGroups.map(([label, items]) =>
          <optgroup key={label} label={label}>{items.map(([id, title]) =>
            <option key={id} value={id}>{title}</option>)}</optgroup>)}</Select>
        <Button variant="secondary" onClick={exit}>{exitLabel}</Button></div></div>
      {notice}
      <App />
    </div>
  </AppLayout></ToastProvider>;
}
