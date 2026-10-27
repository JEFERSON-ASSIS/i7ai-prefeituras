import { FilterBar, IconTile, WizardStepper, Alert, Button, Card, Checkbox, FormSection, IconButton, Input, SearchInput, Select, Textarea } from "@sgdm/design";
import { useEffect, useState } from 'react';
import { ArrowUpRight, Bot, Database, Pencil, Save } from 'lucide-react';
import { apiRequest } from '../api/client';
import { usePermission } from '../api/permissions';
import { useApi } from '../hooks/useApi';
import { Modal, PageActions, State, Status } from '../components/Common';
export function AgentsPage({
  token,
  notify,
  onOpen
}) {
  const canWrite = usePermission('agents', 'write');
  const resource = useApi('/agents', token);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [editor, setEditor] = useState(null);
  const items = resource.data.filter(agent => agent.name.toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR')) && (!status || agent.status === status));
  return <>
    <PageActions label="Novo agente" onCreate={canWrite ? () => setEditor({}) : null} />
    <FilterBar columns={2}><SearchInput label="Buscar agentes" aria-label="Buscar agentes" placeholder="Buscar agentes..." value={search} onChange={event => setSearch(event.target.value)} /><Select label="Status" aria-label="Filtrar por status" value={status} onChange={event => setStatus(event.target.value)}><option value="">Todos os status</option><option value="ACTIVE">Ativos</option><option value="DRAFT">Rascunhos</option><option value="ARCHIVED">Arquivados</option></Select></FilterBar>
    <State loading={resource.loading} error={resource.error} retry={resource.reload} empty={!items.length && 'Nenhum agente encontrado. Crie um agente para começar.'}>
      <div className="section-grid">{items.map((agent, index) => <div key={agent.id}><Card title={<>{agent.name}</>}>
        <div className="card-top"><IconTile icon={Bot} tone="primary" /><IconButton disabled={!canWrite} title="Editar agente" aria-label={'Editar ' + agent.name} onClick={() => setEditor(agent)} icon={<><Pencil size={16} /></>} type="button" /></div>
        <span className="muted">{agent.department?.name || 'Sem departamento'}</span><p>{agent.description}</p>
        <div className="agent-card-meta"><span className="base-count"><Database size={14} />{agent.knowledgeBases?.length || 0} bases</span><Status value={agent.status} /></div>
        <div className="agent-card-foot"><span>{agent.models?.find(item => item.isPrimary)?.model?.name || agent.models?.[0]?.model?.name || 'Selecione um modelo'}</span><Button onClick={() => onOpen(agent.id)} variant="ghost" icon={<ArrowUpRight size={14} />} type="button">Abrir agente </Button></div>
      </Card></div>)}</div>
    </State>
    {editor && <AgentEditor token={token} agent={editor} onClose={() => setEditor(null)} onSaved={() => {
      setEditor(null);
      resource.reload();
      notify('Agente salvo.');
    }} />}
  </>;
}
function AgentEditor({
  token,
  agent,
  onClose,
  onSaved
}) {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({
    name: agent.name || '',
    description: agent.description || '',
    systemPrompt: agent.systemPrompt || '',
    departmentId: agent.departmentId || '',
    modelId: agent.modelId || agent.models?.find(item => item.isPrimary)?.modelId || agent.models?.[0]?.modelId || '',
    knowledgeBaseIds: agent.knowledgeBaseIds || agent.knowledgeBases?.map(item => item.knowledgeBaseId) || [],
    toolIds: agent.toolIds || agent.tools?.filter(item => item.enabled).map(item => item.toolId) || [],
    status: agent.status || 'DRAFT',
    temperature: Number(agent.temperature ?? 0.2),
    maxTokens: agent.maxTokens || 4000,
    advancedReasoning: agent.advancedReasoning || false
  });
  const [catalog, setCatalog] = useState({
    departments: [],
    models: [],
    bases: [],
    tools: []
  });
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [saving, setSaving] = useState(false);
  const supportsAdvancedReasoningControl = catalog.models.find(model => model.id === form.modelId)?.provider?.capabilities?.supportsAdvancedReasoningControl === true;
  const set = (key, value) => setForm(current => ({
    ...current,
    [key]: value
  }));
  const toggle = (key, id) => set(key, form[key].includes(id) ? form[key].filter(value => value !== id) : [...form[key], id]);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([agent.departmentId ? '/departments?includeId=' + encodeURIComponent(agent.departmentId) : '/departments', '/models', '/knowledge-bases', '/tools'].map(path => apiRequest(path, {
      token,
      signal: controller.signal
    }))).then(([departments, models, bases, tools]) => setCatalog({
      departments,
      models,
      bases,
      tools
    })).catch(error => {
      if (error.name !== 'AbortError') setError(error.message);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [token]);
  async function submit(event) {
    event.preventDefault();
    setError('');
    if (form.advancedReasoning && !supportsAdvancedReasoningControl) {
      setError('Desative o controle de raciocínio avançado para salvar com esta integração.');
      setStep(2);
      return;
    }
    if (step < 3) {
      setStep(step + 1);
      return;
    }
    setSaving(true);
    try {
      await apiRequest('/agents' + (agent.id ? '/' + agent.id : ''), {
        token,
        method: agent.id ? 'PATCH' : 'POST',
        body: {
          ...form,
          departmentId: form.departmentId || null,
          modelId: form.modelId || null
        }
      });
      onSaved();
    } catch (error) {
      setError(error.message);
    } finally {
      setSaving(false);
    }
  }
  return <Modal title={agent.id ? 'Editar agente' : 'Novo agente'} onClose={onClose} wide>
    <div className="wizard form-stack"><WizardStepper bare current={step + 1} steps={["Identidade", "Instruções", "Modelo e limites", "Conhecimento"].map(title => ({
        title
      }))} /><Select label="Etapa do cadastro" value={String(step)} onChange={event => setStep(Number(event.target.value))}>{["Identidade", "Instruções", "Modelo e limites", "Conhecimento"].map((title, index) => <option value={index} key={title}>{title}</option>)}</Select></div>
    <form onSubmit={submit}>
      <div className="form">
        {error && <Alert tone="danger">{error}</Alert>}
        {loading && <p role="status">Carregando opções da prefeitura...</p>}
        {step === 0 && <><Input required value={form.name} maxLength={150} onChange={event => set('name', event.target.value)} label={<>Nome</>} /><Select value={form.departmentId} onChange={event => set('departmentId', event.target.value)} label={<>Departamento</>}><option value="">Sem departamento</option>{catalog.departments.map(item => <option key={item.id} value={item.id}>{item.status && item.status !== 'ACTIVE' ? item.name + ' (inativo)' : item.name}</option>)}</Select><Textarea value={form.description} onChange={event => set('description', event.target.value)} label={<>Objetivo</>} /></>}
        {step === 1 && <Textarea required value={form.systemPrompt} onChange={event => set('systemPrompt', event.target.value)} placeholder="Descreva o objetivo, as regras e como o agente deve responder." rows={8} label={<>Instruções do sistema</>} />}
        {step === 2 && <><Select required value={form.modelId} onChange={event => set('modelId', event.target.value)} label={<>Modelo principal</>}><option value="">Selecione um modelo</option>{catalog.models.map(item => <option key={item.id} value={item.id}>{item.name} · {item.provider?.name}</option>)}</Select><div className="form-grid"><Input type="number" min="0" max="2" step="0.1" value={form.temperature} onChange={event => set('temperature', Number(event.target.value))} label={<>Temperatura</>} /><Input type="number" min="1" max="128000" value={form.maxTokens} onChange={event => set('maxTokens', Number(event.target.value))} label={<>Limite de tokens de saída</>} /></div><Checkbox checked={form.advancedReasoning} disabled={loading || (!supportsAdvancedReasoningControl && !form.advancedReasoning)} onChange={event => { if (!event.target.checked || supportsAdvancedReasoningControl) set('advancedReasoning', event.target.checked); }} label={<>Raciocínio avançado em modelos compatíveis</>} />{!loading && !supportsAdvancedReasoningControl && <p>O controle de raciocínio avançado está indisponível nesta integração. O raciocínio interno depende do modelo.</p>}</>}
        {step === 3 && <><FormSection title={<>Bases de conhecimento</>}>{!catalog.bases.length && <p>Crie uma base na área de Conhecimento para conectar documentos.</p>}{catalog.bases.map(item => <Checkbox checked={form.knowledgeBaseIds.includes(item.id)} onChange={() => toggle('knowledgeBaseIds', item.id)} label={<>{item.name}</>} key={item.id} />)}</FormSection><FormSection title={<>Ferramentas autorizadas</>}>{!catalog.tools.length && <p>Nenhuma ferramenta cadastrada.</p>}{catalog.tools.map(item => <Checkbox checked={form.toolIds.includes(item.id)} onChange={() => toggle('toolIds', item.id)} label={<>{item.name} · {item.type}</>} key={item.id} />)}</FormSection><Select value={form.status} onChange={event => set('status', event.target.value)} label={<>Status</>}><option value="DRAFT">Rascunho</option><option value="ACTIVE">Ativo</option><option value="ARCHIVED">Arquivado</option></Select><Alert tone="info" icon={Bot}>As bases e ferramentas selecionadas serão salvas neste agente.</Alert></>}
      </div>
      <div className="modal-actions"><Button type="button" onClick={step ? () => setStep(step - 1) : onClose} variant="secondary">{step ? 'Voltar' : 'Cancelar'}</Button><Button disabled={loading || saving} variant="primary" type="submit">{step === 3 ? <><Save size={15} />{saving ? 'Salvando...' : 'Salvar agente'}</> : 'Próximo'}</Button></div>
    </form>
  </Modal>;
}
