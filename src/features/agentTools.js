import { apiRequest } from '../api/client';

/** Acrescenta uma ferramenta aos vínculos do agente, sem remover os existentes. */
export async function linkToolToAgent(token, agent, toolId) {
  const current = (agent.tools ?? []).map(binding => binding.toolId);
  if (current.includes(toolId)) return;
  await apiRequest('/agents/' + agent.id, { token, method: 'PATCH', body: { toolIds: [...current, toolId] } });
}
