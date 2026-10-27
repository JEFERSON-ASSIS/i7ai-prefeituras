import { Card } from "@sgdm/design";
import { useApi } from '../hooks/useApi';
import { State, Table } from '../components/Common';
const price = value => value == null ? '—' : Number(value).toLocaleString('pt-BR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 6
});
const tokens = value => value == null ? '—' : Number(value).toLocaleString('pt-BR');
function abilities(capabilities = {}) {
  const list = [];
  if (capabilities.supportsVision) list.push('Imagens');
  if (capabilities.supportsTools) list.push('Ferramentas');
  if (capabilities.supportsReasoning) list.push('Raciocínio');
  return list.join(', ') || '—';
}

// Read-only view: models are activated and released by the platform owner in SGDM.
export function ModelPage({ token }) {
  const models = useApi('/models', token);
  return <>
    <p className="panel-note">Os modelos são ativados e liberados pelo dono da plataforma na Central de IA do SGDM. Os preços vêm do LiteLLM.</p>
    <State loading={models.loading} error={models.error} retry={models.reload} empty={!models.data.length && 'Nenhum modelo disponível no momento.'}>
      <div><Card><Table headers={['Modelo', 'Identificador', 'Provedor', 'Entrada · US$ / milhão', 'Saída · US$ / milhão', 'Cache · US$ / milhão', 'Contexto', 'Capacidades']} rows={models.data.map(model => [<b>{model.name}</b>, model.slug, model.provider?.name || '—', price(model.inputPrice), price(model.outputPrice), price(model.cachedInputPrice), tokens(model.capabilities?.contextWindow), abilities(model.capabilities)])} /></Card></div>
    </State>
  </>;
}
