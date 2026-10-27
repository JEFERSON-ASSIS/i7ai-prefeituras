import { Alert, Button, Card, Textarea } from '@sgdm/design';
import { useState } from 'react';
import { Paperclip } from 'lucide-react';
import { apiRequest } from '../api/client';

const MIN = 10, MAX = 300;
const date = value => { try { return new Date(value).toLocaleString('pt-BR'); } catch { return ''; } };

// Read-only view of a conversation opened by the SGDM Central de IA. Content is plain text only.
export function CentralConversationPage({ token, conversationId, onClose }) {
  const [reason, setReason] = useState('');
  const [view, setView] = useState(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  const size = reason.trim().length;
  const valid = size >= MIN && size <= MAX;

  async function open() {
    if (!valid || busy) return;
    setBusy(true); setFailure(null);
    try {
      setView(await apiRequest('/central/conversas/' + conversationId + '/abrir', { token, method: 'POST', body: { motivo: reason.trim() } }));
    } catch (error) {
      setFailure({ status: error.status, message: error.message });
    } finally { setBusy(false); }
  }

  const closeButton = <Button variant="secondary" onClick={onClose}>Fechar</Button>;
  const failureText = failure && (failure.status === 403 ? 'Seu perfil não tem a permissão Central de IA.' : failure.status === 404 ? 'Conversa não encontrada.' : failure.message);
  const failureAlert = failure && <Alert tone="danger">{failureText}</Alert>;

  if (view) {
    return <section aria-label="Conversa aberta pela Central de IA">
      <Alert tone="info">Visualização pela Central de IA (somente leitura). Esta abertura foi registrada na auditoria da prefeitura.</Alert>
      <Card>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 24px', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{view.titulo}</h2>
            <p style={{ margin: '4px 0 0' }}>{[view.prefeitura, view.agente, view.modelo, date(view.criadaEm)].filter(Boolean).join(' · ')}</p>
          </div>
          {closeButton}
        </div>
        {view.truncada && <Alert tone="warning">Mostrando as 1.000 mensagens mais recentes.</Alert>}
        <div className="messages" style={{ overflow: 'visible' }}>
          {view.mensagens.map(message => <div key={message.id} className={'message ' + (message.role === 'user' ? 'user' : 'agent')}>
            <span className="message-text">{message.content}</span>
            <div className="message-meta"><small>{message.role === 'user' ? 'Usuário' : 'Agente'} · {date(message.createdAt)}</small>
              {(message.anexos || []).map((name, index) => <small key={index}><Paperclip size={12} aria-hidden="true" /> {name}</small>)}</div>
          </div>)}
        </div>
      </Card>
    </section>;
  }

  return <section aria-label="Abrir conversa pela Central de IA">
    <Card>
      <Alert tone="warning">Você vai abrir uma conversa de outra prefeitura. A abertura fica registrada na auditoria dela.</Alert>
      <Textarea label="Motivo da abertura" value={reason} rows={4} maxLength={MAX} onChange={event => setReason(event.target.value)} hint={size + '/' + MAX + ' caracteres (mínimo ' + MIN + ')'} />
      {failureAlert}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        <Button onClick={open} disabled={!valid || busy}>{failure && ![403, 404].includes(failure.status) ? 'Tentar novamente' : 'Abrir conversa'}</Button>
        {closeButton}
      </div>
    </Card>
  </section>;
}
