import { PageHeader, Button, Select, Card, EmptyState, useToast } from '@sgdm/design';
import { useEffect, useState } from 'react';
import { Activity, Bot, BrainCircuit, CalendarClock, FileText, ChartNoAxesColumnIncreasing, LayoutDashboard, LibraryBig, Link2, Plug, ShieldCheck, Sparkles, Zap } from 'lucide-react';
import { PermissionProvider, hasPermission } from './api/permissions';
import { ModelPage } from './features/ModelPages';
import { useApi } from './hooks/useApi';
import { getSgdmContext, getSgdmToken } from './integration/sgdmBridge';
import { State } from './components/Common';
import { AgentsPage } from './features/AgentPages';
import { ChatPage } from './features/ChatPage';
import { KnowledgePage } from './features/KnowledgePage';
import { ToolsPage } from './features/ToolPages';
import { Dashboard, ReportsPage } from './features/OverviewPages';
import { AutomationPage, ExecutionsPage } from './features/AutomationPages';
export const moduleNavigationGroups = [
  ['Principal', [['dashboard', 'Dashboard', LayoutDashboard], ['reports', 'Relatórios', ChartNoAxesColumnIncreasing]]],
  ['Inteligência', [['chat', 'Novo chat', Sparkles], ['agents', 'Agentes de IA', Bot], ['models', 'Modelos', BrainCircuit], ['executions', 'Execuções', Activity]]],
  ['Conhecimento', [['knowledge', 'Bases de conhecimento', LibraryBig], ['documents', 'Documentos', FileText]]],
  ['Automação', [['automations', 'Automações', Zap], ['schedules', 'Agendamentos', CalendarClock]]],
  ['Ferramentas', [['tools', 'Ferramentas & MCP', Plug], ['integrations', 'Integrações', Link2]]],
];
const titles = {
  dashboard: ['Dashboard', 'Acompanhe os dados reais da sua operação.'],
  chat: ['Novo chat', 'Converse com um agente usando suas bases e instruções.'],
  agents: ['Agentes de IA', 'Crie, configure e acompanhe seus agentes.'],
  models: ['Modelos de IA', 'Modelos disponíveis para sua organização.'],
  executions: ['Execuções', 'Resultados e histórico das automações.'],
  knowledge: ['Bases de conhecimento', 'Organize o conhecimento dos seus agentes.'],
  documents: ['Documentos', 'Envie arquivos e acompanhe o processamento.'],
  automations: ['Automações', 'Configure tarefas executadas em segundo plano.'],
  schedules: ['Agendamentos', 'Programe as automações da prefeitura.'],
  tools: ['Ferramentas & MCP', 'Configure ferramentas autorizadas para seus agentes.'],
  integrations: ['Integrações', 'Conecte APIs, webhooks, n8n e servidores MCP.'],
  reports: ['Relatórios e consumo', 'Tokens, custos registrados e auditoria.']
};
export function App() {
  const [active, setActive] = useState(() => titles[getSgdmContext().modulePage] ? getSgdmContext().modulePage : 'dashboard'),
    [selectedAgentId, setSelectedAgentId] = useState('');
  const [hostContext, setHostContext] = useState(getSgdmContext);
  const [token, setToken] = useState(getSgdmToken),
    [expired, setExpired] = useState(false);
  const session = useApi(token && !expired ? '/auth/me' : null, token, null);
  function navigate(page) {
    setActive(page);
    window.dispatchEvent(new CustomEvent('i7ai:navigate', { detail: { page } }));
  }
  const toastApi = useToast();
  function notify(message) {
    toastApi.success(message);
  }
  useEffect(() => {
    const context = () => {
      const next = getSgdmContext();
      setHostContext(next);
      if (next.modulePage && titles[next.modulePage]) setActive(next.modulePage);
      setToken(getSgdmToken());
      setExpired(false);
      session.setData(null);
      session.reload();
    };
    const expire = () => { setExpired(true); session.setData(null); };
    window.addEventListener('storage', context);
    window.addEventListener('sgdm:context-updated', context);
    window.addEventListener('i7ai:session-expired', expire);
    return () => {
      window.removeEventListener('storage', context);
      window.removeEventListener('sgdm:context-updated', context);
      window.removeEventListener('i7ai:session-expired', expire);
    };
  }, [session.reload]);
  useEffect(() => {
    if (!token || expired) window.dispatchEvent(new CustomEvent('i7ai:session-required', { detail: { reason: expired ? 'expired' : 'missing' } }));
  }, [token, expired]);
  if (!token || expired) return <section aria-label="i7Ai" className="module-layout"><Card><EmptyState icon={ShieldCheck} title={expired ? 'Sessão do SGDM expirada' : 'Sessão do SGDM indisponível'} description="A sessão e o acesso ao i7Ai são fornecidos pelo SGDM." action={<Button onClick={() => {
          setHostContext(getSgdmContext());
          setToken(getSgdmToken());
          setExpired(false);
          session.reload();
          window.dispatchEvent(new CustomEvent('i7ai:session-required', { detail: { reason: 'refresh' } }));
        }}>Atualizar sessão</Button>} /></Card></section>;
  if (session.loading || session.error || !session.data) return <section aria-label="i7Ai" className="module-layout"><State loading={session.loading} error={session.error} retry={session.reload} empty={!session.data && !session.loading && !session.error && 'Verificando sessão...'} /></section>;
  const user = session.data,
    [title, description] = titles[active] || titles.dashboard;
  let content;
  if (active === 'dashboard') content = <Dashboard token={token} navigate={navigate} />;else if (active === 'agents') content = <AgentsPage token={token} notify={notify} onOpen={id => {
    setSelectedAgentId(id);
    navigate('chat');
  }} />;else if (active === 'chat') content = <ChatPage token={token} selectedAgentId={selectedAgentId} onSelectAgent={setSelectedAgentId} />;else if (['knowledge', 'documents'].includes(active)) content = <KnowledgePage token={token} active={active} notify={notify} />;else if (['tools', 'integrations'].includes(active)) content = <ToolsPage token={token} notify={notify} />;else if (['automations', 'schedules'].includes(active)) content = <AutomationPage token={token} active={active} notify={notify} />;else if (active === 'executions') content = <ExecutionsPage token={token} notify={notify} />;else if (active === 'models') content = <ModelPage token={token} notify={notify} />;else if (active === 'reports') content = <ReportsPage token={token} />;else content = <Dashboard token={token} navigate={navigate} />;
  const sections = moduleNavigationGroups.map(([label, items]) => ({
    label,
    items: items.filter(([id]) => hasPermission(user.permissions, {
      knowledge: 'knowledge-bases',
      chat: 'agents',
      integrations: 'tools',
      reports: 'reports'
    }[id] || id, 'read')).map(([id, label, icon]) => ({
      value: id,
      label,
      icon,
      exact: true
    }))
  })).filter(section => section.items.length);
  return <PermissionProvider permissions={user.permissions}><section aria-label="i7Ai" className="module-layout"><PageHeader title={title} description={description} action={hostContext.navigationManagedByHost !== false ? undefined : <Select label="Área do i7Ai" value={active} onChange={event => navigate(event.target.value)}>{sections.map(section => <optgroup key={section.label} label={section.label}>{section.items.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</optgroup>)}</Select>} /><div className="page-content">{content}</div></section></PermissionProvider>;
}
