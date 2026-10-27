// Plain-text helpers for the Central de IA views (no HTML is ever built from these strings).
export const formatDate = value => {
  const parsed = new Date(value);
  return value == null || Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString('pt-BR');
};

/** Extra detail of an audit row: for a platform view of a conversation, the stated reason and the conversation id. */
export const auditDetail = item => {
  if (item?.event !== 'conversation.viewed_by_platform') return '';
  const motivo = typeof item.metadata?.motivo === 'string' ? item.metadata.motivo : '';
  return [motivo && 'Motivo: ' + motivo, item.resourceId && 'Conversa: ' + item.resourceId].filter(Boolean).join(' · ');
};

const AUDIT_EVENTS = {
  'agent.created': 'Agente criado',
  'agent.updated': 'Agente alterado',
  'agent.chat_completed': 'Conversa respondida',
  'agent.tool_executed': 'Ferramenta usada pelo agente',
  'agent.automation_executed': 'Automação executada pelo agente',
  'agent.model_changed_by_platform': 'Modelo do agente trocado pela Central de IA',
  'automation.created': 'Automação criada',
  'automation.updated': 'Automação alterada',
  'automation.archived': 'Automação arquivada',
  'automation.enqueued': 'Automação na fila',
  'automation.execute': 'Automação iniciada',
  'automation.succeeded': 'Automação concluída',
  'automation.failed': 'Automação com erro',
  'automation.retrying': 'Automação sendo repetida',
  'chat_attachment.uploaded': 'Arquivo anexado no chat',
  'chat_attachment.deleted': 'Anexo do chat removido',
  'conversation.summary_created': 'Resumo da conversa criado',
  'conversation.summary_rejected': 'Resumo da conversa recusado',
  'conversation.summary_skipped': 'Resumo da conversa adiado',
  'conversation.summary_enabled': 'Resumo da conversa ligado',
  'conversation.summary_disabled': 'Resumo da conversa desligado',
  'conversation.viewed_by_platform': 'Conversa aberta pela Central de IA',
  'document.uploaded': 'Documento enviado',
  'document.updated': 'Documento alterado',
  'document.deleted': 'Documento removido',
  'document.process': 'Documento processado',
  'document.reprocessed': 'Documento reprocessado',
  'knowledge_base.created': 'Base de conhecimento criada',
  'knowledge_base.updated': 'Base de conhecimento alterada',
  'tool.created': 'Ferramenta criada',
  'tool.updated': 'Ferramenta alterada',
  'tools.execute': 'Ferramenta executada',
  'mcp.call': 'Chamada a serviço externo (MCP)',
  'retention.applied': 'Limpeza de dados antigos',
  'tenant.provisioned': 'Prefeitura ativada na IA do SGDM',
};

const AUDIT_RESOURCES = {
  agent: 'Agente', agents: 'Agente', automation: 'Automação', automations: 'Automação',
  conversation: 'Conversa', conversations: 'Conversa', document: 'Documento', documents: 'Documento',
  knowledge_base: 'Base de conhecimento', knowledge_bases: 'Base de conhecimento',
  tool: 'Ferramenta', tools: 'Ferramenta', settings: 'Configurações', tenant: 'Prefeitura', tenants: 'Prefeitura',
  user: 'Usuário', users: 'Usuário',
};

/** Audit event in plain Portuguese; unknown events keep their technical name. */
export const auditEventLabel = event => AUDIT_EVENTS[event] || event || '—';

/** Audit resource in plain Portuguese; unknown resources keep their technical name. */
export const auditResourceLabel = resource => AUDIT_RESOURCES[resource] || resource || '—';
