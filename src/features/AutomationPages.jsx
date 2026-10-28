import { Table as DataTable, Modal, statusColors } from "../components/Common";
import { StatusBadge, LoadingState, Alert, Button, IconButton, Input, SearchInput, Select, Textarea, Button as UiButton, Card as UiCard, EmptyState as UiEmptyState } from "@sgdm/design";
import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowDown, ArrowUp, CalendarClock, Clock3, Pencil, Play, Plus, RefreshCw, Trash2, Zap } from 'lucide-react';
import { apiRequest } from '../api/client';
import { usePermission } from '../api/permissions';
import { linkToolToAgent } from './agentTools';
const labels = {
  DRAFT: 'Rascunho',
  ACTIVE: 'Ativa',
  PAUSED: 'Pausada',
  PENDING: 'Na fila',
  RUNNING: 'Executando',
  SUCCESS: 'Concluída',
  FAILED: 'Falhou',
  CANCELLED: 'Cancelada',
  ARCHIVED: 'Arquivada'
};
const tone = {
  ACTIVE: 'success',
  SUCCESS: 'success',
  RUNNING: 'info',
  PENDING: 'info',
  FAILED: 'danger',
  PAUSED: 'warning'
};
const status = value => <StatusBadge status={value} labels={labels} colors={statusColors} size="sm" case="normal" />;
const date = (value, timezone = 'America/Cuiaba') => value ? new Date(value).toLocaleString('pt-BR', {
  timeZone: timezone,
  dateStyle: 'short',
  timeStyle: 'short'
}) : '—';
const duration = value => value == null ? '—' : value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`;
const newStep = () => ({
  name: 'Executar agente',
  actionType: 'AGENT',
  configuration: {
    prompt: ''
  },
  inputText: '{}'
});
const emptyAutomation = () => ({
  name: '',
  description: '',
  agentId: '',
  status: 'DRAFT',
  timeoutSeconds: 300,
  retries: 2,
  steps: [newStep()]
});
function ErrorMessage({
  error
}) {
  return error ? <Alert tone="danger">{error}</Alert> : null;
}
function JsonOutput({
  value
}) {
  return <pre className="result-code">{JSON.stringify(value ?? {}, null, 2)}</pre>;
}
export function AutomationPage({
  token,
  active = 'automations',
  notify = () => {}
}) {
  const canWrite = usePermission('automations', 'write'),
    canExecute = usePermission('automations', 'execute');
  const canScheduleWrite = usePermission('schedules', 'write'),
    canReadAgents = usePermission('agents', 'read');
  const [items, setItems] = useState([]);
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [form, setForm] = useState(null);
  const [schedule, setSchedule] = useState(null);
  const [run, setRun] = useState(null);
  const [archive, setArchive] = useState(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [authTools, setAuthTools] = useState(null);
  const authorizeOpen = async () => {
    setFormError('');
    try {
      setAuthTools(await apiRequest('/tools', { token }));
    } catch (err) {
      setFormError(err.message);
    }
  };
  const authorizeTool = async toolId => {
    const target = agents.find(agent => agent.id === form?.agentId);
    if (!target || !toolId) return;
    setBusy(true);
    setFormError('');
    try {
      await linkToolToAgent(token, target, toolId);
      const catalog = await apiRequest('/agents', { token });
      setAgents(catalog.filter(agent => agent.status !== 'ARCHIVED'));
      setAuthTools(null);
    } catch (err) {
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const load = useCallback(async signal => {
    setLoading(true);
    setError('');
    try {
      const [automations, catalog] = await Promise.all([apiRequest('/automations', {
        token,
        signal
      }), canWrite && canReadAgents ? apiRequest('/agents', {
        token,
        signal
      }) : Promise.resolve([])]);
      setItems(automations);
      setAgents(catalog.filter(agent => agent.status !== 'ARCHIVED'));
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [token, canWrite, canReadAgents]);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const close = () => {
    if (!busy) {
      setForm(null);
      setSchedule(null);
      setRun(null);
      setArchive(null);
      setFormError('');
    }
  };
  const edit = item => {
    if (!canWrite) return;
    setFormError('');
    setForm(item ? {
      ...item,
      steps: item.steps.map(step => ({
        ...step,
        configuration: {
          ...step.configuration
        },
        inputText: JSON.stringify(step.configuration.input ?? {}, null, 2)
      }))
    } : emptyAutomation());
  };
  const editSchedule = (automationId = '', item) => {
    if (!canScheduleWrite) return;
    setFormError('');
    setSchedule(item ? {
      ...item,
      automationId
    } : {
      automationId,
      name: '',
      cronExpression: '0 8 * * 1-5',
      timezone: 'America/Cuiaba',
      enabled: true
    });
  };
  const updateStep = (index, change) => setForm(current => ({
    ...current,
    steps: current.steps.map((step, i) => i === index ? {
      ...step,
      ...change
    } : step)
  }));
  const moveStep = (index, offset) => setForm(current => {
    const steps = [...current.steps];
    [steps[index], steps[index + offset]] = [steps[index + offset], steps[index]];
    return {
      ...current,
      steps
    };
  });
  const chosenAgent = agents.find(agent => agent.id === form?.agentId);
  const permittedTools = (chosenAgent?.tools ?? []).filter(binding => binding.enabled && binding.tool?.status === 'ACTIVE' && ['HTTP_REQUEST', 'WEBHOOK', 'REST_API', 'N8N'].includes(binding.tool.type)).map(binding => binding.tool);
  const filtered = items.filter(item => `${item.name} ${item.agent?.name ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const schedules = filtered.flatMap(item => item.schedules.map(entry => ({
    ...entry,
    automation: item
  })));
  const saveAutomation = async event => {
    event.preventDefault();
    if (!canWrite) return;
    setBusy(true);
    setFormError('');
    try {
      const steps = form.steps.map(step => {
        const configuration = step.actionType === 'HTTP_TOOL' ? {
          toolId: step.configuration.toolId,
          input: JSON.parse(step.inputText || '{}')
        } : {
          prompt: step.configuration.prompt
        };
        if (step.actionType === 'HTTP_TOOL' && (!configuration.input || typeof configuration.input !== 'object' || Array.isArray(configuration.input))) throw new Error('A entrada da ferramenta deve ser um objeto JSON.');
        return {
          name: step.name,
          actionType: step.actionType,
          configuration
        };
      });
      const body = {
        name: form.name,
        description: form.description || '',
        agentId: form.agentId,
        status: form.status,
        timeoutSeconds: Number(form.timeoutSeconds),
        retries: Number(form.retries),
        steps
      };
      await apiRequest(form.id ? `/automations/${form.id}` : '/automations', {
        token,
        method: form.id ? 'PATCH' : 'POST',
        body
      });
      setForm(null);
      notify('Automação salva.');
      await load();
    } catch (err) {
      setFormError(err instanceof SyntaxError ? 'A entrada da ferramenta contém JSON inválido.' : err.message);
    } finally {
      setBusy(false);
    }
  };
  const saveSchedule = async event => {
    event.preventDefault();
    if (!canScheduleWrite) return;
    setBusy(true);
    setFormError('');
    try {
      const path = `/automations/${schedule.automationId}/schedules${schedule.id ? `/${schedule.id}` : ''}`;
      await apiRequest(path, {
        token,
        method: schedule.id ? 'PATCH' : 'POST',
        body: {
          name: schedule.name,
          cronExpression: schedule.cronExpression,
          timezone: schedule.timezone,
          enabled: schedule.enabled
        }
      });
      setSchedule(null);
      notify('Agendamento salvo.');
      await load();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const runAutomation = async event => {
    event.preventDefault();
    if (!canExecute) return;
    setBusy(true);
    setFormError('');
    try {
      const input = JSON.parse(run.inputText || '{}');
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('A entrada deve ser um objeto JSON.');
      await apiRequest(`/automations/${run.item.id}/run`, {
        token,
        method: 'POST',
        body: {
          input
        }
      });
      setRun(null);
      notify('Execução adicionada à fila. Acompanhe em Execuções.');
      await load();
    } catch (err) {
      setFormError(err instanceof SyntaxError ? 'A entrada contém JSON inválido.' : err.message);
    } finally {
      setBusy(false);
    }
  };
  const archiveItem = async () => {
    if (!archive || !(archive.scheduleId ? canScheduleWrite : canWrite)) return;
    setBusy(true);
    setFormError('');
    try {
      await apiRequest(archive.scheduleId ? `/automations/${archive.id}/schedules/${archive.scheduleId}` : `/automations/${archive.id}`, {
        token,
        method: 'DELETE'
      });
      setArchive(null);
      notify(archive.scheduleId ? 'Agendamento excluído.' : 'Automação arquivada. O histórico foi preservado.');
      await load();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return <>
    <div className="toolbar"><div className="search-control"><SearchInput aria-label="Buscar automações" placeholder="Buscar automações ou agentes..." value={query} onChange={event => setQuery(event.target.value)} /></div><UiButton variant="secondary" icon={<RefreshCw size={16} />} onClick={() => load()} disabled={loading} type="button">Atualizar</UiButton>{(active === 'schedules' ? canScheduleWrite : canWrite) && <UiButton icon={<Plus size={16} />} onClick={() => active === 'schedules' ? editSchedule() : edit()} disabled={active === 'schedules' && !items.length} type="button">{active === 'schedules' ? 'Novo agendamento' : 'Nova automação'}</UiButton>}</div>
    <ErrorMessage error={error} />
    {loading ? <LoadingState /> : !items.length ? <UiEmptyState icon={Zap} title="Nenhuma automação cadastrada" description="Crie um fluxo com um agente ativo. Depois, configure as etapas e os horários de execução." action={canWrite ? <UiButton onClick={() => edit()} type="button">Criar automação</UiButton> : undefined} /> : active === 'schedules' && !schedules.length ? <UiEmptyState icon={CalendarClock} title="Nenhum agendamento encontrado" description="As execuções programadas seguem o fuso escolhido e continuam com o navegador fechado. A automação precisa estar ativa." action={canScheduleWrite ? <UiButton onClick={() => editSchedule()} type="button">Criar agendamento</UiButton> : undefined} /> : <div><UiCard title={<>{active === 'schedules' ? 'Agendamentos' : 'Automações'}</>} description={<>{active === 'schedules' ? `${schedules.length} horário(s) configurado(s)` : `${filtered.length} automação(ões) cadastrada(s)`}</>} padding="none"><div className="table-wrap"><DataTable headers={active === 'schedules' ? ['Agendamento', 'Automação', 'Frequência / fuso', 'Próxima execução', 'Status', 'Ações'] : ['Automação', 'Agente', 'Etapas', 'Status', 'Ações']} rows={active === 'schedules' ? schedules.map(entry => [<><b>{entry.name}</b></>, <>{entry.automation.name}</>, <>{entry.cronExpression}<br /><small>{entry.timezone}</small></>, <>{date(entry.nextRunAt, entry.timezone)}</>, <>{status(!entry.enabled ? 'PAUSED' : entry.automation.status === 'ACTIVE' ? 'ACTIVE' : entry.automation.status)}</>, <><div className="page-actions"><Button disabled={!canScheduleWrite} onClick={() => editSchedule(entry.automation.id, entry)} variant="link" icon={<Pencil size={14} />} type="button"> Editar</Button><Button disabled={!canScheduleWrite} onClick={() => {
                setFormError('');
                setArchive({
                  id: entry.automation.id,
                  scheduleId: entry.id,
                  name: entry.name
                });
              }} variant="link" icon={<Trash2 size={14} />} type="button"> Excluir</Button></div></>]) : filtered.map(item => [<><b>{item.name}</b>{item.description && <p>{item.description}</p>}</>, <>{item.agent?.name || '—'}</>, <>{item.steps.length}</>, <>{status(item.status)}</>, <><div className="page-actions"><Button disabled={!canWrite} onClick={() => edit(item)} variant="link" icon={<Pencil size={14} />} type="button"> Editar</Button><Button disabled={!canExecute || ['PAUSED', 'ARCHIVED'].includes(item.status) || item.agent?.status !== 'ACTIVE'} onClick={() => {
                setFormError('');
                setRun({
                  item,
                  inputText: '{}'
                });
              }} variant="link" icon={<Play size={14} />} type="button"> Executar</Button><Button disabled={!canScheduleWrite} onClick={() => editSchedule(item.id)} variant="link" icon={<CalendarClock size={14} />} type="button"> Agendar</Button><Button disabled={!canWrite} onClick={() => {
                setFormError('');
                setArchive({
                  id: item.id,
                  name: item.name
                });
              }} variant="link" icon={<Trash2 size={14} />} type="button"> Arquivar</Button></div></>])} /></div></UiCard></div>}
    {canWrite && form && <Modal title={form.id ? 'Editar automação' : 'Nova automação'} close={close} busy={busy}><form onSubmit={saveAutomation}><div className="form"><ErrorMessage error={formError} /><div className="form-grid"><Input autoFocus required maxLength={160} value={form.name} onChange={event => setForm({
              ...form,
              name: event.target.value
            })} label={<>Nome</>} /><Select required value={form.agentId} onChange={event => setForm({
              ...form,
              agentId: event.target.value
            })} label={<>Agente</>}><option value="">Selecione um agente</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name} · {labels[agent.status] || agent.status}</option>)}</Select></div><Textarea maxLength={4000} value={form.description || ''} onChange={event => setForm({
            ...form,
            description: event.target.value
          })} label={<>Descrição</>} /><div className="form-grid"><Select value={form.status} onChange={event => setForm({
              ...form,
              status: event.target.value
            })} label={<>Status</>}><option value="DRAFT">Rascunho</option><option value="ACTIVE">Ativa</option><option value="PAUSED">Pausada</option></Select><Input required type="number" min="1" max="3600" value={form.timeoutSeconds} onChange={event => setForm({
              ...form,
              timeoutSeconds: event.target.value
            })} label={<>Tempo limite (segundos)</>} /><Input required type="number" min="0" max="5" value={form.retries} onChange={event => setForm({
              ...form,
              retries: event.target.value
            })} label={<>Novas tentativas em caso de falha</>} /></div><Alert tone="info" icon={Clock3}> Etapas concluídas são preservadas nas novas tentativas. A execução manual também está disponível em rascunho, com um agente ativo.</Alert><h3>Etapas, na ordem de execução</h3>
      {form.steps.map((step, index) => <div key={index}><UiCard key={index}><div className="page-actions" style={{
                justifyContent: 'space-between',
                marginBottom: 12
              }}><b>Etapa {index + 1}</b><div className="page-actions"><IconButton type="button" aria-label={`Mover etapa ${index + 1} para cima`} disabled={index === 0} onClick={() => moveStep(index, -1)} icon={<><ArrowUp size={16} /></>} /><IconButton type="button" aria-label={`Mover etapa ${index + 1} para baixo`} disabled={index === form.steps.length - 1} onClick={() => moveStep(index, 1)} icon={<><ArrowDown size={16} /></>} /><IconButton type="button" aria-label={`Remover etapa ${index + 1}`} disabled={form.steps.length === 1} onClick={() => setForm({
                    ...form,
                    steps: form.steps.filter((_, i) => i !== index)
                  })} icon={<><Trash2 size={16} /></>} variant="danger" /></div></div><div className="form-grid"><Input required maxLength={160} value={step.name} onChange={event => updateStep(index, {
                  name: event.target.value
                })} label={<>Nome da etapa</>} /><Select value={step.actionType} onChange={event => updateStep(index, {
                  actionType: event.target.value,
                  configuration: event.target.value === 'AGENT' ? {
                    prompt: ''
                  } : {
                    toolId: ''
                  },
                  inputText: '{}'
                })} label={<>Ação</>}>{!['AGENT', 'HTTP_TOOL'].includes(step.actionType) && <option value={step.actionType}>Não suportado: {step.actionType}</option>}<option value="AGENT">Executar agente</option><option value="HTTP_TOOL">Chamar ferramenta HTTP autorizada</option></Select></div>{step.actionType === 'AGENT' ? <Textarea required maxLength={20000} value={step.configuration.prompt || ''} onChange={event => updateStep(index, {
                configuration: {
                  prompt: event.target.value
                }
              })} label={<>Instruções para o agente</>} hint={<>A entrada da automação e o resultado anterior são enviados junto com estas instruções.</>} /> : step.actionType === 'HTTP_TOOL' ? <><Select required value={step.configuration.toolId || ''} onChange={event => updateStep(index, {
                  configuration: {
                    ...step.configuration,
                    toolId: event.target.value
                  }
                })} label={<>Ferramenta</>}><option value="">Selecione uma ferramenta do agente</option>{permittedTools.map(tool => <option key={tool.id} value={tool.id}>{tool.name}</option>)}</Select>{!permittedTools.length && <><p>Este agente ainda não usa nenhuma ferramenta.</p>{authTools ? <Select value="" disabled={busy} onChange={event => authorizeTool(event.target.value)} label={<>Ferramenta a autorizar</>}><option value="">Escolha uma ferramenta ativa</option>{authTools.filter(tool => tool.status === 'ACTIVE' && ['HTTP_REQUEST', 'WEBHOOK', 'REST_API', 'N8N'].includes(tool.type)).map(tool => <option key={tool.id} value={tool.id}>{tool.name}</option>)}</Select> : <UiButton type="button" variant="secondary" disabled={busy || !form.agentId} onClick={authorizeOpen}>Autorizar ferramenta neste agente</UiButton>}</>}<Textarea value={step.inputText} onChange={event => updateStep(index, {
                  inputText: event.target.value
                })} label={<>Entrada da ferramenta (JSON)</>} hint={<>O resultado anterior e a entrada da automação também ficam disponíveis para a ferramenta.</>} /></> : <ErrorMessage error="Selecione um tipo de ação suportado para esta etapa." />}</UiCard></div>)}
      <UiButton type="button" variant="secondary" disabled={form.steps.length >= 20} icon={<Plus size={15} />} onClick={() => setForm({
            ...form,
            steps: [...form.steps, newStep()]
          })}>Adicionar etapa</UiButton></div><div className="modal-actions"><UiButton type="button" variant="secondary" disabled={busy} onClick={close}>Cancelar</UiButton><UiButton type="submit" disabled={busy || !agents.length}>{busy ? 'Salvando...' : 'Salvar automação'}</UiButton></div></form></Modal>}
    {canScheduleWrite && schedule && <Modal title={schedule.id ? 'Editar agendamento' : 'Novo agendamento'} close={close} busy={busy}><form onSubmit={saveSchedule}><div className="form"><ErrorMessage error={formError} /><Select required disabled={Boolean(schedule.id)} value={schedule.automationId} onChange={event => setSchedule({
            ...schedule,
            automationId: event.target.value
          })} label={<>Automação</>}><option value="">Selecione uma automação</option>{items.map(item => <option key={item.id} value={item.id}>{item.name} · {labels[item.status]}</option>)}</Select><Input required autoFocus maxLength={160} value={schedule.name} onChange={event => setSchedule({
            ...schedule,
            name: event.target.value
          })} label={<>Nome</>} /><Select value={['0 8 * * *', '0 8 * * 1-5', '0 * * * *', '0 8 * * 1', '0 8 1 * *'].includes(schedule.cronExpression) ? schedule.cronExpression : 'custom'} onChange={event => {
            if (event.target.value !== 'custom') setSchedule({
              ...schedule,
              cronExpression: event.target.value
            });
          }} label={<>Frequência</>}><option value="0 8 * * *">Todos os dias às 08:00</option><option value="0 8 * * 1-5">Dias úteis às 08:00</option><option value="0 * * * *">A cada hora</option><option value="0 8 * * 1">Segundas-feiras às 08:00</option><option value="0 8 1 * *">Dia 1 de cada mês às 08:00</option><option value="custom">Personalizada</option></Select><Input required maxLength={120} value={schedule.cronExpression} onChange={event => setSchedule({
            ...schedule,
            cronExpression: event.target.value
          })} label={<>Expressão cron</>} hint={<>Minuto · hora · dia do mês · mês · dia da semana. Ex.: 0 8 * * 1-5.</>} /><Select value={schedule.timezone} onChange={event => setSchedule({
            ...schedule,
            timezone: event.target.value
          })} label={<>Fuso horário</>}>{!['America/Cuiaba', 'America/Sao_Paulo', 'America/Manaus', 'America/Rio_Branco', 'UTC'].includes(schedule.timezone) && <option value={schedule.timezone}>{schedule.timezone}</option>}<option value="America/Cuiaba">Cuiabá</option><option value="America/Sao_Paulo">Brasília / São Paulo</option><option value="America/Manaus">Manaus</option><option value="America/Rio_Branco">Rio Branco</option><option value="UTC">UTC</option></Select><Select value={schedule.enabled ? 'enabled' : 'disabled'} onChange={event => setSchedule({
            ...schedule,
            enabled: event.target.value === 'enabled'
          })} label={<>Estado</>}><option value="enabled">Habilitado</option><option value="disabled">Pausado</option></Select><Alert tone="info" icon={CalendarClock}> O agendamento executa somente quando a automação e o agente estão ativos.</Alert></div><div className="modal-actions"><UiButton type="button" variant="secondary" onClick={close} disabled={busy}>Cancelar</UiButton><UiButton type="submit" disabled={busy}>{busy ? 'Salvando...' : 'Salvar agendamento'}</UiButton></div></form></Modal>}
    {canExecute && run && <Modal title={`Executar ${run.item.name}`} close={close} busy={busy}><form onSubmit={runAutomation}><div className="form"><ErrorMessage error={formError} /><Textarea autoFocus value={run.inputText} onChange={event => setRun({
            ...run,
            inputText: event.target.value
          })} label={<>Entrada da automação (JSON)</>} /><p>A execução acontece em segundo plano. Você pode acompanhar a saída e cada etapa em Execuções.</p></div><div className="modal-actions"><UiButton type="button" variant="secondary" onClick={close} disabled={busy}>Cancelar</UiButton><UiButton type="submit" icon={<Play size={15} />} disabled={busy}>{busy ? 'Enviando...' : 'Executar'}</UiButton></div></form></Modal>}
    {archive && (archive.scheduleId ? canScheduleWrite : canWrite) && <Modal title={archive.scheduleId ? 'Excluir agendamento' : 'Arquivar automação'} close={close} busy={busy}><div className="form"><ErrorMessage error={formError} /><p>{archive.scheduleId ? `Excluir o agendamento “${archive.name}”?` : `Arquivar “${archive.name}” e interromper seus próximos agendamentos? O histórico de execuções será preservado.`}</p></div><div className="modal-actions"><UiButton variant="secondary" disabled={busy} onClick={close} type="button">Cancelar</UiButton><UiButton disabled={busy} onClick={archiveItem} type="button" variant="danger">{busy ? 'Salvando...' : archive.scheduleId ? 'Excluir' : 'Arquivar'}</UiButton></div></Modal>}
  </>;
}
export function ExecutionsPage({
  token,
  notify = () => {}
}) {
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const detailGeneration = useRef(0);
  const load = useCallback(async (signal, quiet = false) => {
    if (!quiet) setLoading(true);
    setError('');
    try {
      setItems(await apiRequest(`/executions${filter ? `?status=${filter}` : ''}`, {
        token,
        signal
      }));
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message);
    } finally {
      if (!signal?.aborted && !quiet) setLoading(false);
    }
  }, [token, filter]);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);
  useEffect(() => {
    if (!items.some(item => ['PENDING', 'RUNNING'].includes(item.status)) && !['PENDING', 'RUNNING'].includes(filter)) return;
    const controller = new AbortController();
    const timer = setInterval(() => load(controller.signal, true), 5000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [items, filter, load]);
  const openDetail = async id => {
    const generation = ++detailGeneration.current;
    setDetailError('');
    setDetailLoading(true);
    setSelected({
      id
    });
    try {
      const result = await apiRequest(`/executions/${id}`, {
        token
      });
      if (generation === detailGeneration.current) setSelected(result);
    } catch (err) {
      if (generation === detailGeneration.current) setDetailError(err.message);
    } finally {
      if (generation === detailGeneration.current) setDetailLoading(false);
    }
  };
  const closeDetail = () => {
    detailGeneration.current++;
    setSelected(null);
    setDetailLoading(false);
  };
  useEffect(() => {
    if (!selected?.id || !['PENDING', 'RUNNING'].includes(selected.status)) return;
    const controller = new AbortController();
    const timer = setInterval(async () => {
      try {
        setSelected(await apiRequest(`/executions/${selected.id}`, {
          token,
          signal: controller.signal
        }));
      } catch (err) {
        if (err.name !== 'AbortError') setDetailError(err.message);
      }
    }, 3000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [selected?.id, selected?.status, token]);
  const finished = items.filter(item => ['SUCCESS', 'FAILED'].includes(item.status));
  const successful = items.filter(item => item.status === 'SUCCESS').length;
  return <><div className="toolbar"><div className="search-box"><Activity size={17} /><span>{items.length} execução(ões) na consulta · {finished.length ? Math.round(successful / finished.length * 100) : 0}% concluídas com sucesso</span></div><Select aria-label="Filtrar status de execução" value={filter} onChange={event => setFilter(event.target.value)}><option value="">Todos os status</option>{['PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'CANCELLED'].map(value => <option key={value} value={value}>{labels[value]}</option>)}</Select><UiButton variant="secondary" onClick={() => load()} disabled={loading} icon={<RefreshCw size={16} />} type="button">Atualizar</UiButton></div><ErrorMessage error={error} />{loading ? <LoadingState /> : !items.length ? <UiEmptyState icon={Activity} title="Nenhuma execução encontrada" description="Execute uma automação ou aguarde seu próximo horário programado. O histórico aparecerá aqui." /> : <div><UiCard title={<>Histórico de execuções</>} description={<>Até 100 execuções mais recentes · horários em Cuiabá</>} padding="none"><div className="table-wrap"><DataTable headers={['Automação', 'Agente', 'Status', 'Início / criação', 'Duração', 'Detalhes']} rows={items.map(item => [<><b>{item.automation?.name || '—'}</b><br /><small>{item.schedule?.name || 'Execução manual'}</small></>, <>{item.agent?.name || '—'}</>, <>{status(item.status)}</>, <>{date(item.startedAt || item.createdAt)}</>, <>{duration(item.durationMs)}</>, <><Button onClick={() => openDetail(item.id)} variant="link" type="button">Ver detalhes</Button></>])} /></div></UiCard></div>}
    {selected && <Modal title="Detalhes da execução" close={closeDetail}><div className="form"><ErrorMessage error={detailError} />{detailLoading ? <p role="status">Carregando detalhes...</p> : selected.status && <><div className="form-grid"><div><b>{selected.automation?.name}</b><p>{selected.agent?.name}</p>{status(selected.status)}</div><div><p>Início: {date(selected.startedAt)}</p><p>Fim: {date(selected.finishedAt)}</p><p>Duração: {duration(selected.durationMs)}</p></div></div>{selected.error && <ErrorMessage error={selected.error} />}{selected.dataPurgedAt ? <Alert tone="info">Os dados desta execução foram removidos pela política de retenção em {date(selected.dataPurgedAt)}. O status e os horários foram preservados.</Alert> : <><h3>Entrada</h3><JsonOutput value={selected.input} /><h3>Resultado</h3>{selected.output?.result?.answer ? <p style={{
            whiteSpace: 'pre-wrap'
          }}>{selected.output.result.answer}</p> : <JsonOutput value={selected.output?.result} />}<h3>Etapas concluídas</h3>{selected.output?.steps?.length ? selected.output.steps.map((step, index) => <div key={step.stepId || index}><UiCard key={step.stepId || index}><b>{index + 1}. {step.name}</b><p>{step.actionType === 'AGENT' ? 'Agente de IA' : 'Ferramenta HTTP'}</p>{step.output?.answer ? <p style={{
                whiteSpace: 'pre-wrap'
              }}>{step.output.answer}</p> : <JsonOutput value={step.output} />}</UiCard></div>) : <p>Nenhuma etapa concluída ainda.</p>}</>}</>}</div><div className="modal-actions"><UiButton variant="secondary" onClick={closeDetail} type="button">Fechar</UiButton><UiButton disabled={detailLoading} onClick={() => openDetail(selected.id)} icon={<RefreshCw size={15} />} type="button">Atualizar detalhes</UiButton></div></Modal>}
  </>;
}
