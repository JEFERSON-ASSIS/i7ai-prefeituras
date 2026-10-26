import { StatCard, MiniStat, Button, Card } from "@sgdm/design";
import { Bot, Sparkles, Zap, Gauge, Download, FileText } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { State, Table, dateTime } from '../components/Common';
function csvDownload(name, headers, rows) {
  const quote = value => {
    const text = String(value ?? '');
    return '"' + (/^[\s]*[=+@-]/.test(text) ? "'" : '') + text.replaceAll('"', '""') + '"';
  };
  const blob = new Blob(['\uFEFF' + [headers, ...rows].map(row => row.map(quote).join(';')).join('\r\n')], {
    type: 'text/csv;charset=utf-8'
  });
  const url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Stat({
  icon,
  label,
  value,
  color
}) {
  return <StatCard icon={icon} title={label} value={value} tone={{
    purple: 'primary',
    blue: 'info',
    orange: 'warning',
    green: 'success'
  }[color]} />;
}
const number = value => Number(value || 0).toLocaleString('pt-BR');
export function Dashboard({
  token,
  navigate
}) {
  const resource = useApi('/dashboard', token, null),
    data = resource.data;
  return <State loading={resource.loading} error={resource.error} retry={resource.reload}>{data && <>
    <section className="stats-grid"><Stat icon={Bot} label="Agentes ativos" value={number(data.agents)} color="purple" /><Stat icon={Sparkles} label="Conversas salvas" value={number(data.conversations)} color="blue" /><Stat icon={Zap} label="Automações ativas" value={number(data.automations)} color="orange" /><Stat icon={Gauge} label="Tokens · últimos 30 dias" value={number(data.inputTokens + data.outputTokens)} color="green" /></section>
    <section className="dashboard-grid"><div className="dashboard-panel"><Card title={<>Uso de tokens</>} description={<>Últimos 30 dias · {data.timezone}</>}><UsageChart days={data.daily} /></Card></div><div className="dashboard-panel"><Card title={<>Operação da plataforma</>} description={<>Dados registrados no banco</>}><div className="operation-counts"><MiniStat label="Documentos processados" value={number(data.documents)} /><MiniStat label="Chamadas de IA nos últimos 30 dias" value={number(data.requests)} />{data.executions.map(item => <MiniStat key={item.status} label={"Execuções · " + item.status} value={item.count} />)}</div></Card></div></section>
    <div><Card title={<>Atividade recente</>} description={<>Ações registradas pela plataforma</>} action={<><Button onClick={() => navigate('reports')} variant="link" type="button">Ver relatórios</Button></>}>{data.recent.length ? <Table headers={['Evento', 'Recurso', 'Data']} rows={data.recent.map(item => [item.event, item.resource || '—', dateTime(item.createdAt)])} /> : <p className="panel-note">Nenhuma atividade registrada ainda.</p>}</Card></div>
    <div className="quick-start"><Card title={<>Construa seu próximo agente</>} description={<>Defina as instruções, conecte documentos e teste a resposta.</>}><div className="quick-steps"><Button onClick={() => navigate('agents')} variant="ghost" icon={<Bot size={18} />} type="button">Configurar agente</Button><Button onClick={() => navigate('documents')} variant="ghost" icon={<FileText size={18} />} type="button">Enviar documentos</Button><Button onClick={() => navigate('automations')} variant="ghost" icon={<Zap size={18} />} type="button">Criar automação</Button></div></Card></div>
  </>}</State>;
}
function UsageChart({
  days
}) {
  if (!days.length) return <div className="state-panel">As chamadas de IA aparecerão neste gráfico.</div>;
  const max = Math.max(1, ...days.map(day => day.inputTokens + day.outputTokens));
  return <div className="usage-bars">{days.map(day => <div key={day.date} className="usage-bar" title={day.date + ': ' + number(day.inputTokens + day.outputTokens) + ' tokens'}><div style={{
        height: Math.max(2, (day.inputTokens + day.outputTokens) / max * 140)
      }} className="usage-bar-fill" /><small>{day.date.slice(8) + '/' + day.date.slice(5, 7)}</small></div>)}</div>;
}
export function ReportsPage({
  token
}) {
  const resource = useApi('/reports', token, null),
    audit = useApi('/audit', token);
  const data = resource.data;
  return <State loading={resource.loading} error={resource.error} retry={resource.reload}>{data && <>
    <div className="page-actions"><Button onClick={() => csvDownload('i7ai-consumo.csv', ['Modelo', 'Provedor', 'Tokens de entrada', 'Tokens de saída', 'Custo registrado', 'Preço configurado'], data.models.map(item => [item.name, item.provider, item.inputTokens, item.outputTokens, item.cost, item.costConfigured ? 'Sim' : 'Não']))} variant="secondary" icon={<Download size={16} />} type="button">Exportar consumo</Button></div>
    <div className="stats-grid"><Stat icon={Gauge} label="Tokens de entrada" value={number(data.inputTokens)} color="purple" /><Stat icon={Gauge} label="Tokens de saída" value={number(data.outputTokens)} color="blue" /><Stat icon={Sparkles} label="Chamadas de IA" value={number(data.requests)} color="green" /><Stat icon={FileText} label="Custo registrado · USD" value={Number(data.cost).toFixed(6)} color="orange" /></div>
    <div><Card title={<>Consumo por modelo</>} description={<>Últimos 30 dias. Custos dependem dos preços configurados no catálogo.</>}>{data.models.length ? <Table headers={['Modelo', 'Provedor', 'Entrada', 'Saída', 'Custo registrado · USD']} rows={data.models.map(item => [<b>{item.name}</b>, item.provider, number(item.inputTokens), number(item.outputTokens), item.costConfigured ? item.cost.toFixed(6) : 'Preço não configurado'])} /> : <p className="panel-note">Nenhuma chamada registrada.</p>}</Card></div>
    <div className="audit-panel"><Card title={<>Auditoria</>} description={<>Últimos 100 eventos da prefeitura</>} action={<><Button disabled={!audit.data.length} onClick={() => csvDownload('i7ai-auditoria.csv', ['Evento', 'Recurso', 'Usuário', 'Data'], audit.data.map(item => [item.event, item.resource, item.user?.name, dateTime(item.createdAt)]))} variant="link" type="button">Exportar auditoria</Button></>}><State loading={audit.loading} error={audit.error} retry={audit.reload} empty={!audit.data.length && 'Nenhum evento registrado.'}><Table headers={['Evento', 'Recurso', 'Usuário', 'Data']} rows={audit.data.map(item => [item.event, item.resource || '—', item.user?.name || 'Sistema', dateTime(item.createdAt)])} /></State></Card></div>
  </>}</State>;
}
