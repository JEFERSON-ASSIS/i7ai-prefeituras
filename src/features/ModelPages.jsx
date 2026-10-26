import { Alert, Button, Card, Checkbox, Input, Select } from "@sgdm/design";
import { useState } from 'react';
import { KeyRound, Pencil, PlugZap, Save, Trash2 } from 'lucide-react';
import { apiRequest } from '../api/client';
import { useApi } from '../hooks/useApi';
import { usePermission } from '../api/permissions';
import { Modal, PageActions, State, Table } from '../components/Common';
const price = value => value == null ? 'Não configurado' : Number(value).toLocaleString('pt-BR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 6
});
export function ModelPage({
  token,
  notify = () => {},
  canWrite = false
}) {
  const hasModelWrite = usePermission('models', 'write'),
    canEdit = canWrite && hasModelWrite;
  const models = useApi('/models', token),
    providers = useApi('/providers', token);
  const [editor, setEditor] = useState(null);
  const availableProviders = providers.data.filter(provider => provider.capabilities?.supported);
  const refresh = () => {
    models.reload();
    providers.reload();
  };
  return <>
    {canEdit && <PageActions label="Novo modelo" onCreate={!providers.loading && !providers.error && availableProviders.length ? () => setEditor({}) : undefined} />}
    <p className="panel-note">Este catálogo é compartilhado pelas organizações da plataforma. Preços em USD por milhão de tokens; os valores cadastrados serão usados nos próximos registros de consumo.</p>
    <State loading={providers.loading} error={providers.error} retry={providers.reload}>
      <div><Card title={<>Provedores disponíveis</>} description={<>A integração com o gateway de IA é configurada no servidor.</>}>
        {providers.data.length ? <Table headers={['Provedor', 'Integração', 'Disponibilidade']} rows={providers.data.map(provider => [<b>{provider.name}</b>, provider.capabilities?.gatewayIntegration ? 'Gateway de IA' : provider.capabilities?.directIntegration ? 'Integração direta' : 'Gateway necessário', !provider.capabilities?.supported ? 'Configure um gateway para usar este provedor' : provider.capabilities?.integrationConfigured ? 'Acesso configurado no servidor' : 'Configuração de acesso pendente'])} /> : <p className="panel-note">Nenhum provedor cadastrado na plataforma.</p>}
      </Card></div>
    </State>
    {canEdit && <ProviderKeys token={token} notify={notify} onChanged={refresh} />}
    <State loading={models.loading} error={models.error} retry={models.reload} empty={!models.data.length && 'Nenhum modelo cadastrado. Configure um modelo para selecionar nos agentes.'}>
      <div><Card><Table headers={['Modelo', 'Provedor', 'Identificador', 'Entrada · USD / milhão', 'Saída · USD / milhão', 'Agentes', ...(canEdit ? ['Ações'] : [])]} rows={models.data.map(model => [<b>{model.name}</b>, model.provider?.name || '—', model.slug, price(model.inputPrice), price(model.outputPrice), model._count?.agents || 0, ...(canEdit ? [<Button type="button" disabled={providers.loading || Boolean(providers.error)} onClick={() => setEditor(model)} variant="link" icon={<Pencil size={14} />}>Configurar</Button>] : [])])} /></Card></div>
    </State>
    {canEdit && editor && <ModelEditor token={token} model={editor} providers={providers.data} onClose={() => setEditor(null)} onSaved={() => {
      setEditor(null);
      refresh();
      notify('Modelo salvo.');
    }} />} 
  </>;
}
function ModelEditor({
  token,
  model,
  providers,
  onClose,
  onSaved
}) {
  const canWrite = usePermission('models', 'write');
  const [form, setForm] = useState({
    name: model.name || '',
    slug: model.slug || '',
    providerId: model.providerId || providers.find(provider => provider.capabilities?.supported)?.id || '',
    inputPrice: model.inputPrice == null ? '' : String(model.inputPrice),
    outputPrice: model.outputPrice == null ? '' : String(model.outputPrice),
    supportsVision: model.capabilities?.supportsVision ?? false,
    supportsTools: model.capabilities?.supportsTools ?? true,
    supportsReasoning: model.capabilities?.supportsReasoning == null ? '' : String(model.capabilities.supportsReasoning),
    supportsTemperature: model.capabilities?.supportsTemperature == null ? '' : String(model.capabilities.supportsTemperature),
    contextWindow: model.capabilities?.contextWindow == null ? '' : String(model.capabilities.contextWindow),
    maxOutputTokens: model.capabilities?.maxOutputTokens == null ? '' : String(model.capabilities.maxOutputTokens)
  });
  const [saving, setSaving] = useState(false),
    [error, setError] = useState('');
  const selectedProvider = providers.find(provider => provider.id === form.providerId);
  const set = (key, value) => setForm(current => ({
    ...current,
    [key]: value
  }));
  async function save(event) {
    event.preventDefault();
    if (!canWrite) return;
    setError('');
    if (!form.name.trim() || !form.slug.trim()) {
      setError('Informe nome e identificador do modelo.');
      return;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(form.slug.trim())) {
      setError('O identificador deve usar letras, números, ponto, hífen, sublinhado, barra ou dois-pontos.');
      return;
    }
    if (!selectedProvider?.capabilities?.supported) {
      setError('Selecione um provedor com integração disponível.');
      return;
    }
    const inputPrice = form.inputPrice === '' ? null : Number(form.inputPrice),
      outputPrice = form.outputPrice === '' ? null : Number(form.outputPrice);
    if ([inputPrice, outputPrice].some(value => value !== null && (!Number.isFinite(value) || value < 0 || value > 9999.999999))) {
      setError('Informe preços válidos entre 0 e 9999.999999 USD por milhão de tokens.');
      return;
    }
    for (const field of ['contextWindow', 'maxOutputTokens']) {
      const minimum = field === 'contextWindow' ? 4096 : 1;
      const maximum = field === 'contextWindow' ? 2000000 : 200000;
      if (form[field] !== '' && (!Number.isInteger(Number(form[field])) || Number(form[field]) < minimum || Number(form[field]) > maximum)) {
        setError(field === 'contextWindow' ? 'Informe uma janela de contexto entre 4.096 e 2.000.000 tokens.' : 'Informe um limite de saída entre 1 e 200.000 tokens.');
        return;
      }
    }
    if (form.contextWindow && form.maxOutputTokens && Number(form.maxOutputTokens) > Number(form.contextWindow)) {
      setError('O limite de saída deve caber na janela de contexto do modelo.');
      return;
    }
    const capabilities = {
      supportsVision: form.supportsVision,
      supportsTools: form.supportsTools,
      ...(form.supportsReasoning !== '' ? { supportsReasoning: form.supportsReasoning === 'true' } : {}),
      ...(form.supportsTemperature !== '' ? { supportsTemperature: form.supportsTemperature === 'true' } : {}),
      ...(form.contextWindow !== '' ? { contextWindow: Number(form.contextWindow) } : {}),
      ...(form.maxOutputTokens !== '' ? { maxOutputTokens: Number(form.maxOutputTokens) } : {})
    };
    setSaving(true);
    try {
      await apiRequest('/models' + (model.id ? '/' + model.id : ''), {
        token,
        method: model.id ? 'PATCH' : 'POST',
        body: {
          name: form.name.trim(),
          slug: form.slug.trim(),
          providerId: form.providerId,
          inputPrice,
          outputPrice,
          capabilities
        }
      });
      onSaved();
    } catch (error) {
      setError(error.message);
    } finally {
      setSaving(false);
    }
  }
  return <Modal title={model.id ? 'Configurar modelo' : 'Novo modelo'} onClose={onClose}>
    <form onSubmit={save}><div className="form">
      {error && <Alert tone="danger">{error}</Alert>}
      <Input required maxLength={160} value={form.name} onChange={event => set('name', event.target.value)} label={<>Nome de exibição</>} />
      <Select required value={form.providerId} onChange={event => set('providerId', event.target.value)} label={<>Provedor</>}><option value="">Selecione um provedor</option>{providers.map(provider => <option key={provider.id} value={provider.id} disabled={!provider.capabilities?.supported}>{provider.name}{!provider.capabilities?.supported ? ' · gateway pendente' : ''}</option>)}</Select>
      <Input required maxLength={200} value={form.slug} onChange={event => set('slug', event.target.value)} placeholder="Identificador exato fornecido pelo provedor" label={<>Identificador no provedor</>} />
      <div className="form-grid"><Input type="number" min="0" max="9999.999999" step="0.000001" value={form.inputPrice} onChange={event => set('inputPrice', event.target.value)} placeholder="Não configurado" label={<>Entrada · USD por milhão</>} /><Input type="number" min="0" max="9999.999999" step="0.000001" value={form.outputPrice} onChange={event => set('outputPrice', event.target.value)} placeholder="Não configurado" label={<>Saída · USD por milhão</>} /></div>
      <p>Deixe um preço vazio para remover sua configuração. Os custos já registrados permanecem no histórico.</p>
      <Checkbox checked={form.supportsVision} onChange={event => set('supportsVision', event.target.checked)} label="Permite analisar imagens" />
      <p>Para analisar imagens, configure também a janela de contexto em tokens confirmada pelo provedor.</p>
      <Checkbox checked={form.supportsTools} onChange={event => set('supportsTools', event.target.checked)} label="Permite chamadas de ferramentas" />
      <div className="form-grid">
        <Select label="Raciocínio do modelo" value={form.supportsReasoning} onChange={event => set('supportsReasoning', event.target.value)}><option value="">Automático</option><option value="true">Suportado</option><option value="false">Não suportado</option></Select>
        <Select label="Controle de temperatura" value={form.supportsTemperature} onChange={event => set('supportsTemperature', event.target.value)}><option value="">Automático</option><option value="true">Suportado</option><option value="false">Não suportado</option></Select>
      </div>
      <div className="form-grid">
        <Input type="number" min="4096" max="2000000" step="1" value={form.contextWindow} onChange={event => set('contextWindow', event.target.value)} label="Janela de contexto (tokens)" placeholder="Padrão do servidor" />
        <Input type="number" min="1" max="200000" step="1" value={form.maxOutputTokens} onChange={event => set('maxOutputTokens', event.target.value)} label="Limite de saída do modelo (tokens)" placeholder="Padrão do servidor" />
      </div>
      <p>Configure as capacidades e os limites confirmados pelo provedor para este modelo.</p>
      {selectedProvider && <p>{selectedProvider.capabilities?.integrationConfigured ? 'O acesso a este provedor está configurado no servidor.' : 'Cadastre o modelo e solicite ao administrador a configuração de acesso antes de conversar com o agente.'}</p>}
    </div><div className="modal-actions"><Button type="button" onClick={onClose} variant="secondary">Cancelar</Button><Button disabled={!canWrite || saving || !selectedProvider?.capabilities?.supported} variant="primary" icon={<Save size={15} />} type="submit">{saving ? 'Salvando...' : 'Salvar modelo'}</Button></div></form>
  </Modal>;
}

// SUPER_ADMIN: provider API keys are sent once to the AI gateway (LiteLLM) and never shown again.
function ProviderKeys({
  token,
  notify,
  onChanged
}) {
  const keys = useApi('/ai-credentials', token);
  const [editing, setEditing] = useState(null),
    [busy, setBusy] = useState(''),
    [result, setResult] = useState(null);
  const run = async (provider, action) => {
    setBusy(provider + action);
    setResult(null);
    try {
      if (action === 'test') {
        const outcome = await apiRequest('/ai-credentials/' + provider + '/test', { token, method: 'POST' });
        setResult({ tone: outcome.ok ? 'success' : 'danger', text: (outcome.ok ? 'Teste com ' : 'Falha no teste com ') + outcome.model + ': ' + outcome.message });
      } else {
        await apiRequest('/ai-credentials/' + provider, { token, method: 'DELETE' });
        notify('Chave removida.');
        keys.reload();
        onChanged();
      }
    } catch (error) {
      setResult({ tone: 'danger', text: error.message });
    } finally {
      setBusy('');
    }
  };
  return <State loading={keys.loading} error={keys.error} retry={keys.reload}>
    <div><Card title={<>Chaves dos provedores de IA</>} description={<>Somente SUPER_ADMIN. As chaves ficam criptografadas no gateway de IA e não voltam a ser exibidas.</>}>
      {result && <Alert tone={result.tone}>{result.text}</Alert>}
      <Table headers={['Provedor', 'Chave', 'Ações']} rows={keys.data.map(item => [<b>{item.name}</b>, item.configured ? 'Configurada · ' + (item.maskedKey || '••••') : 'Não configurada', <div className="page-actions">
        <Button type="button" variant="link" icon={<KeyRound size={14} />} onClick={() => setEditing(item)}>{item.configured ? 'Trocar chave' : 'Cadastrar chave'}</Button>
        {item.configured && <Button type="button" variant="link" icon={<PlugZap size={14} />} disabled={Boolean(busy)} onClick={() => run(item.provider, 'test')}>{busy === item.provider + 'test' ? 'Testando...' : 'Testar'}</Button>}
        {item.configured && <Button type="button" variant="link" icon={<Trash2 size={14} />} disabled={Boolean(busy)} onClick={() => run(item.provider, 'remove')}>{busy === item.provider + 'remove' ? 'Removendo...' : 'Remover'}</Button>}
      </div>])} />
    </Card></div>
    {editing && <ProviderKeyEditor token={token} item={editing} onClose={() => setEditing(null)} onSaved={() => {
      setEditing(null);
      setResult(null);
      keys.reload();
      onChanged();
      notify('Chave salva. Use Testar para confirmar.');
    }} />}
  </State>;
}
function ProviderKeyEditor({
  token,
  item,
  onClose,
  onSaved
}) {
  const [apiKey, setApiKey] = useState(''),
    [saving, setSaving] = useState(false),
    [error, setError] = useState('');
  const save = async event => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await apiRequest('/ai-credentials/' + item.provider, { token, method: 'PUT', body: { apiKey } });
      setApiKey('');
      onSaved();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setSaving(false);
    }
  };
  return <Modal title={'Chave de API · ' + item.name} onClose={onClose} busy={saving}><form onSubmit={save}><div className="form">
    {error && <Alert tone="danger">{error}</Alert>}
    <Alert tone="info">A chave é enviada uma única vez ao gateway de IA. Depois, só os últimos caracteres aparecem.</Alert>
    <Input required type="password" autoComplete="off" spellCheck={false} maxLength={512} value={apiKey} onChange={event => setApiKey(event.target.value)} label={<>Nova chave de API</>} placeholder={item.provider === 'anthropic' ? 'sk-ant-...' : 'sk-...'} />
  </div><div className="modal-actions"><Button type="button" onClick={onClose} variant="secondary">Cancelar</Button><Button disabled={saving || !apiKey.trim()} variant="primary" type="submit" icon={<Save size={16} />}>{saving ? 'Salvando...' : 'Salvar chave'}</Button></div></form></Modal>;
}
