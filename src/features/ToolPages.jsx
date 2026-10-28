import { IconTile, Alert, Button, Card, Checkbox, FormSection, IconButton, Input, Select, Textarea } from "@sgdm/design";
import { useState } from 'react';
import { Pencil, Plug, Play, Plus, Trash2 } from 'lucide-react';
import { apiRequest } from '../api/client';
import { usePermission } from '../api/permissions';
import { useApi } from '../hooks/useApi';
import { Modal, PageActions, State, Status } from '../components/Common';
import { linkToolToAgent } from './agentTools';
import { ADVANCED_METHODS, BASIC_METHODS, HTTP_TYPES, TIMEOUTS, TYPE_LABELS, TYPE_ORDER, configToForm, defaultConfig, defaultHttpForm, formToConfig, parseDomains, suggestDomains } from './toolConfig';
export function ToolsPage({
  token,
  notify
}) {
  const tools = useApi('/tools', token),
    agents = useApi('/agents', token);
  const canWrite = usePermission('tools', 'write'),
    canExecute = usePermission('tools', 'execute');
  const [editor, setEditor] = useState(null),
    [testing, setTesting] = useState(null);
  return <>
    <PageActions label="Nova ferramenta" onCreate={canWrite ? () => setEditor({}) : null} />
    <State loading={tools.loading} error={tools.error} retry={tools.reload} empty={!tools.data.length && 'Cadastre uma ferramenta e autorize seu uso na configuração do agente.'}>
      <div className="section-grid tools-grid">{tools.data.map(tool => <div key={tool.id}><Card title={<>{tool.name}</>}>
        <div className="card-top"><IconTile icon={Plug} tone="primary" /><Status value={tool.status} /></div>
        <span className="muted">{TYPE_LABELS[tool.type] || tool.type}</span><p>{tool.description}</p>
        <div className="tool-detail">{canWrite && <Button onClick={() => setEditor(tool)} variant="link" icon={<Pencil size={14} />} type="button">Configurar</Button>}{canExecute && <Button onClick={() => setTesting(tool)} variant="link" icon={<Play size={14} />} type="button">Testar</Button>}</div>
      </Card></div>)}</div>
    </State>
    {editor && <ToolEditor token={token} tool={editor} onClose={() => setEditor(null)} onSaved={() => {
      setEditor(null);
      tools.reload();
      notify('Ferramenta salva.');
    }} />}
    {testing && <ToolTest token={token} tool={testing} agents={agents.data} reloadAgents={agents.reload} onClose={() => setTesting(null)} />}
  </>;
}
function ToolEditor({
  token,
  tool,
  onClose,
  onSaved
}) {
  const initialType = tool.type || 'HTTP_REQUEST';
  const initialForm = HTTP_TYPES.includes(initialType) ? tool.id ? configToForm(tool.config) : defaultHttpForm() : null;
  const [name, setName] = useState(tool.name || ''),
    [type, setType] = useState(initialType),
    [description, setDescription] = useState(tool.description || ''),
    [status, setStatus] = useState(tool.status || 'ACTIVE'),
    [domains, setDomains] = useState((tool.allowedDomains || []).join(', ')),
    [domainsEdited, setDomainsEdited] = useState(Boolean(tool.id));
  const [form, setForm] = useState(initialForm || defaultHttpForm()),
    [jsonMode, setJsonMode] = useState(HTTP_TYPES.includes(initialType) && !initialForm),
    [advanced, setAdvanced] = useState(false);
  const [config, setConfig] = useState(JSON.stringify(tool.config || defaultConfig(initialType), null, 2));
  const [replaceCredentials, setReplaceCredentials] = useState(!tool.id),
    [credentials, setCredentials] = useState([]);
  const [error, setError] = useState(''),
    [saving, setSaving] = useState(false);
  const isHttp = HTTP_TYPES.includes(type),
    formMode = isHttp && !jsonMode;
  const patchForm = patch => setForm(current => ({ ...current, ...patch }));
  function changeUrl(url) {
    patchForm({ url });
    if (!domainsEdited) setDomains(suggestDomains(url).join(', '));
  }
  function changeType(next) {
    setType(next);
    setError('');
    if (HTTP_TYPES.includes(next) && HTTP_TYPES.includes(type)) return;
    setForm(defaultHttpForm());
    setJsonMode(false);
    setAdvanced(false);
    setConfig(JSON.stringify(defaultConfig(next), null, 2));
    if (!domainsEdited) setDomains('');
  }
  function toggleJson(on) {
    setError('');
    if (on) {
      let built;
      try {
        built = formToConfig(form);
      } catch {
        built = formToConfig(form, true);
      }
      setConfig(JSON.stringify(built, null, 2));
      setJsonMode(true);
      return;
    }
    let parsed = null;
    try {
      parsed = configToForm(JSON.parse(config));
    } catch {
      parsed = null;
    }
    if (!parsed) {
      setError('Não foi possível voltar ao formulário: corrija o JSON ou remova campos que o formulário não conhece.');
      return;
    }
    setForm(parsed);
    setJsonMode(false);
  }
  function changeJson(text) {
    setConfig(text);
    try {
      const parsed = configToForm(JSON.parse(text));
      if (parsed) {
        setForm(parsed);
        if (!domainsEdited) setDomains(suggestDomains(parsed.url).join(', '));
      }
    } catch {
      /* JSON ainda incompleto */
    }
  }
  let preview = '';
  if (formMode) {
    try {
      preview = JSON.stringify(formToConfig(form), null, 2);
    } catch {
      preview = JSON.stringify(formToConfig(form, true), null, 2);
    }
  }
  const showAdvancedMethods = advanced || ADVANCED_METHODS.some(([value]) => value === form.method);
  async function save(event) {
    event.preventDefault();
    setError('');
    setSaving(true);
    try {
      const parsed = formMode ? formToConfig(form) : JSON.parse(config);
      await apiRequest('/tools' + (tool.id ? '/' + tool.id : ''), {
        token,
        method: tool.id ? 'PATCH' : 'POST',
        body: {
          name,
          type,
          description,
          status,
          allowedDomains: type === 'INTERNAL_DATABASE' ? [] : parseDomains(domains),
          config: parsed,
          ...(type === 'INTERNAL_DATABASE' ? { credentials: [] } : replaceCredentials ? {
            credentials
          } : {})
        }
      });
      onSaved();
    } catch (error) {
      setError(error instanceof SyntaxError ? 'A configuração precisa ser um JSON válido.' : error.message);
    } finally {
      setSaving(false);
    }
  }
  return <Modal title={tool.id ? 'Configurar ferramenta' : 'Nova ferramenta'} onClose={onClose} wide><form onSubmit={save}><div className="form">
    {error && <Alert tone="danger">{error}</Alert>}
    <div className="form-grid"><Input required value={name} onChange={event => setName(event.target.value)} label={<>Nome</>} /><Select value={type} onChange={event => changeType(event.target.value)} label={<>Tipo</>}>{TYPE_ORDER.map(value => <option key={value} value={value}>{TYPE_LABELS[value]}</option>)}</Select></div>
    <Input value={description} onChange={event => setDescription(event.target.value)} label={<>Descrição</>} />
    {formMode && <>
      <Input required type="url" inputMode="url" value={form.url} onChange={event => changeUrl(event.target.value)} placeholder="https://www.exemplo.gov.br/noticias" label={<>Endereço da página ou serviço</>} />
      <div className="form-grid">
        <Select value={form.method} onChange={event => patchForm({ method: event.target.value })} label={<>Tipo de acesso</>}>{BASIC_METHODS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}{showAdvancedMethods && ADVANCED_METHODS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select>
        <Select value={String(form.timeoutMs)} onChange={event => patchForm({ timeoutMs: Number(event.target.value) })} label={<>Tempo máximo de espera</>}>{TIMEOUTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}{!TIMEOUTS.some(([value]) => value === form.timeoutMs) && <option value={form.timeoutMs}>{form.timeoutMs} ms</option>}</Select>
      </div>
    </>}
    {type !== 'INTERNAL_DATABASE' && <Input required value={domains} onChange={event => {
      setDomains(event.target.value);
      setDomainsEdited(true);
    }} placeholder="api.prefeitura.gov.br, servico.exemplo.com" label={<>Domínios permitidos</>} />}
    {type !== 'INTERNAL_DATABASE' && isHttp && <p className="muted">{domainsEdited ? 'Lista editada por você.' : 'Preenchido automaticamente a partir do endereço. Você pode alterar.'}</p>}
    {isHttp && <Button type="button" variant="link" aria-expanded={advanced} onClick={() => setAdvanced(value => !value)}>{advanced ? 'Ocultar opções avançadas' : 'Avançado'}</Button>}
    {isHttp && advanced && <FormSection title={<>Avançado</>}>
      {formMode && <>
        <p className="muted">Cabeçalhos extras enviados junto com o pedido. Senhas e chaves não vão aqui: use as credenciais cadastradas no servidor, mais abaixo.</p>
        {form.headers.map((header, index) => <div className="credential-row" key={index}><Input value={header.key} onChange={event => patchForm({ headers: form.headers.map((item, i) => i === index ? { ...item, key: event.target.value } : item) })} placeholder="Accept" label={<>Nome do cabeçalho</>} /><Input value={header.value} onChange={event => patchForm({ headers: form.headers.map((item, i) => i === index ? { ...item, value: event.target.value } : item) })} placeholder="application/json" label={<>Valor</>} /><IconButton type="button" aria-label="Remover cabeçalho" onClick={() => patchForm({ headers: form.headers.filter((_, i) => i !== index) })} icon={<><Trash2 size={15} /></>} variant="danger" /></div>)}
        <Button type="button" onClick={() => patchForm({ headers: [...form.headers, { key: '', value: '' }] })} variant="secondary" icon={<Plus size={15} />}>Adicionar cabeçalho</Button>
        {form.method !== 'GET' && <Textarea value={form.body} onChange={event => patchForm({ body: event.target.value })} rows={5} placeholder='{"campo": "valor"}' label={<>Conteúdo a enviar (JSON)</>} />}
        <Textarea readOnly value={preview} rows={8} label={<>Configuração gerada (somente leitura)</>} />
      </>}
      <Checkbox checked={jsonMode} onChange={event => toggleJson(event.target.checked)} label={<>Editar configuração em JSON</>} />
      {jsonMode && <Textarea required value={config} onChange={event => changeJson(event.target.value)} rows={8} label={<>Configuração (JSON)</>} />}
    </FormSection>}
    {!isHttp && <Textarea required value={config} onChange={event => setConfig(event.target.value)} rows={8} label={<>Configuração</>} />}
    <Alert tone="info">{type === 'INTERNAL_DATABASE' ? 'Consulte documentos, bases vinculadas ao agente, departamentos ou agentes da prefeitura. Não são permitidas consultas SQL ou acesso a credenciais.' : type === 'EXTERNAL_SEARCH' ? 'Informe o endereço da API de pesquisa, o parâmetro de consulta e os domínios permitidos. Credenciais são cadastradas no servidor.' : type === 'MCP_SERVER' ? 'Informe endpoint, método e parâmetros. MCP utiliza o transporte streamable-http.' : 'Informe o endereço do site ou serviço. Os domínios permitidos são preenchidos sozinhos e a IA só acessa o que estiver nessa lista.'}</Alert>
    {type !== 'INTERNAL_DATABASE' && <FormSection title={<>Credenciais cadastradas no servidor</>}>
      {tool.id && <Checkbox checked={replaceCredentials} onChange={event => setReplaceCredentials(event.target.checked)} label={<>Substituir as referências atuais</>} />}
      {tool.id && !replaceCredentials && <p>{tool.credentials?.length ? tool.credentials.map(item => item.label).join(', ') : 'Sem credenciais vinculadas.'}</p>}
      {replaceCredentials && <>{credentials.map((credential, index) => <div className="credential-row" key={index}><Input required value={credential.label} onChange={event => setCredentials(current => current.map((item, i) => i === index ? {
                ...item,
                label: event.target.value
              } : item))} placeholder="Authorization" label={<>Cabeçalho</>} /><Input required value={credential.secretRef} onChange={event => setCredentials(current => current.map((item, i) => i === index ? {
                ...item,
                secretRef: event.target.value
              } : item))} placeholder="env:TOOL_SECRET_PORTAL" label={<>Referência</>} /><IconButton type="button" aria-label="Remover referência" onClick={() => setCredentials(current => current.filter((_, i) => i !== index))} icon={<><Trash2 size={15} /></>} variant="danger" /></div>)}<Button type="button" onClick={() => setCredentials(current => [...current, {
              label: 'Authorization',
              secretRef: ''
            }])} variant="secondary" icon={<Plus size={15} />}>Adicionar referência</Button></>}
      <p>O administrador deve cadastrar o valor da credencial no servidor. Informe aqui somente a referência TOOL_SECRET_ correspondente.</p>
    </FormSection>}
    <Select value={status} onChange={event => setStatus(event.target.value)} label={<>Status</>}><option value="ACTIVE">Ativa</option><option value="INACTIVE">Inativa</option></Select>
  </div><div className="modal-actions"><Button type="button" onClick={onClose} variant="secondary">Cancelar</Button><Button disabled={saving} variant="primary" type="submit">{saving ? 'Salvando...' : 'Salvar ferramenta'}</Button></div></form></Modal>;
}
function ToolTest({
  token,
  tool,
  agents,
  reloadAgents,
  onClose
}) {
  const allowed = agents.filter(agent => agent.tools?.some(link => link.toolId === tool.id && link.enabled) && agent.status === 'ACTIVE');
  const [agentId, setAgentId] = useState(allowed[0]?.id || ''),
    [input, setInput] = useState(['INTERNAL_DATABASE', 'EXTERNAL_SEARCH'].includes(tool.type) ? '{"query":"","limit":5}' : '{}'),
    [result, setResult] = useState(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false);
  const [linking, setLinking] = useState(false);
  const [mcpTools, setMcpTools] = useState([]),
    [toolName, setToolName] = useState('');
  const isMcp = tool.type === 'MCP_SERVER',
    hasBody = ['INTERNAL_DATABASE', 'EXTERNAL_SEARCH'].includes(tool.type) || !['GET', 'HEAD'].includes(tool.config?.method || (tool.type === 'REST_API' ? 'GET' : 'POST'));
  async function test(event) {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const response = isMcp ? await apiRequest('/agents/' + agentId + '/mcp/' + tool.id + '/tools', {
        token
      }) : await apiRequest('/tools/' + tool.id + '/test', {
        token,
        method: 'POST',
        body: {
          agentId,
          input: hasBody ? JSON.parse(input) : {}
        }
      });
      setResult(response);
      if (isMcp) {
        const list = Array.isArray(response) ? response : response.tools || [];
        setMcpTools(list);
        setToolName(list[0]?.name || '');
      }
    } catch (error) {
      setError(error.message);
    } finally {
      setLoading(false);
    }
  }
  async function authorize(id) {
    const target = agents.find(agent => agent.id === id);
    if (!target) return;
    setLinking(true);
    setError('');
    try {
      await linkToolToAgent(token, target, tool.id);
      await reloadAgents?.();
      setAgentId(id);
    } catch (error) {
      setError(error.message);
    } finally {
      setLinking(false);
    }
  }
  async function call() {
    setLoading(true);
    setError('');
    try {
      setResult(await apiRequest('/agents/' + agentId + '/mcp/' + tool.id + '/call', {
        token,
        method: 'POST',
        body: {
          name: toolName,
          arguments: JSON.parse(input)
        }
      }));
    } catch (error) {
      setError(error.message);
    } finally {
      setLoading(false);
    }
  }
  return <Modal title={'Testar ' + tool.name} onClose={onClose} wide><form onSubmit={test}><div className="form">
    {error && <Alert tone="danger">{error}</Alert>}
    <Select required value={agentId} onChange={event => {
          setAgentId(event.target.value);
          setMcpTools([]);
          setResult(null);
        }} label={<>Agente autorizado</>}><option value="">Selecione um agente</option>{allowed.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</Select>
    {!allowed.length && <><p>Nenhum agente usa esta ferramenta ainda.</p><Select disabled={linking} value="" onChange={event => authorize(event.target.value)} label={<>Autorizar no agente…</>}><option value="">Escolha um agente ativo</option>{agents.filter(agent => agent.status === 'ACTIVE').map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</Select></>}
    {isMcp || hasBody ? <Textarea value={input} onChange={event => setInput(event.target.value)} label={<>{isMcp ? 'Argumentos da ferramenta (JSON)' : 'Corpo da requisição (JSON)'}</>} /> : <p>Para GET/HEAD, os parâmetros devem estar na URL configurada da ferramenta.</p>}
    {isMcp && mcpTools.length > 0 && <><Select value={toolName} onChange={event => setToolName(event.target.value)} label={<>Ferramenta descoberta</>}>{mcpTools.map(item => <option value={item.name} key={item.name}>{item.name}</option>)}</Select><Button type="button" disabled={loading || !toolName} onClick={call} variant="secondary">Executar ferramenta MCP</Button></>}
    {result && <pre className="result-code">{JSON.stringify(result, null, 2)}</pre>}
  </div><div className="modal-actions"><Button type="button" onClick={onClose} variant="secondary">Fechar</Button><Button disabled={!agentId || loading} variant="primary" type="submit">{loading ? 'Executando...' : isMcp ? 'Descobrir ferramentas' : 'Executar teste'}</Button></div></form></Modal>;
}
