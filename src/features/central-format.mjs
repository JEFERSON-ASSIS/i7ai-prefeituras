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
