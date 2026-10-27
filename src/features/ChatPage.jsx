import { SelectableList, EmptyState, Chip, Alert, IconButton, Select, Textarea, FileButton, Button, Spinner } from '@sgdm/design';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { Plus, Send, Bot, Square, X, Download, Cpu, Paperclip, FileText, FileSpreadsheet, Image, AlertCircle, FileDown, Clock } from 'lucide-react';
import { apiRequest } from '../api/client';
import { consumeChatEvents } from '../api/event-stream.mjs';
import { usePermission } from '../api/permissions';
import { useApi } from '../hooks/useApi';
import { State } from '../components/Common';

const imageExtensions = ['png', 'jpg', 'jpeg', 'webp'];
const statusLabels = { UPLOADING: 'Enviando', PROCESSING: 'Processando', READY: 'Pronto', FAILED: 'Falhou' };
const fileSize = size => Number(size) >= 1024 * 1024 ? (Number(size) / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' MB' : Math.ceil(Number(size) / 1024) + ' KB';
const shortDate = value => value ? new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Cuiaba', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
// Live stage of the answer (SSE `progress`); only the stage arrives, never the search terms.
const stageLabels = {
  pesquisa_internet: 'Pesquisando na internet…',
  pesquisa_compras: 'Pesquisando em compras públicas (PNCP)…',
  ferramenta: 'Usando uma ferramenta do agente…',
  documentos: 'Lendo os documentos anexados…',
};
const pastedExtension = type => ({ 'image/jpeg': 'jpg', 'image/webp': 'webp' })[type] || 'png';
const preview = text => text.length > 60 ? text.slice(0, 57) + '...' : text;
const suggestions = [
  'Resuma o edital anexado: objeto, valor estimado, prazos e exigências de habilitação.',
  'Confira a planilha anexada e aponte contratos com vigência terminando nos próximos 90 dias.',
  'Redija um ofício à Secretaria de Educação solicitando o relatório de frequência escolar.'
];
function fileIcon(file) {
  const name = file.name?.toLowerCase() || '';
  if (file.mimeType?.startsWith('image/')) return Image;
  if (/\.(xlsx|xls|csv)$/.test(name)) return FileSpreadsheet;
  return FileText;
}
// Model output is untrusted: no raw HTML (react-markdown default) and no remote images.
function AnswerText({ children }) {
  return <div className="message-markdown"><Markdown remarkPlugins={[remarkGfm, remarkBreaks]} disallowedElements={['img']} unwrapDisallowed components={{ a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" /> }}>{children}</Markdown></div>;
}
const exportFormats = [['pdf', 'PDF'], ['docx', 'Word'], ['xlsx', 'Excel']];
const hasMarkdownTable = text => /^\s*\|?.+\|.+\n\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/m.test(text || '');
function messageAttachments(message) {
  const relations = message.attachments?.map(item => item.document || item) || [];
  const files = relations.length ? relations : message.metadata?.attachments || [];
  return files.filter(file => file?.id);
}
function contextAttachments(current, messages) {
  const seen = new Set();
  const candidates = [...current, ...messages.slice(-40).reverse().flatMap(messageAttachments)];
  return candidates.filter(file => {
    if (!file?.id || seen.has(file.id)) return false;
    seen.add(file.id);
    return true;
  }).slice(0, 5);
}

export function ChatPage({ token, selectedAgentId, onSelectAgent }) {
  const canSend = usePermission('agents', 'execute');
  const canReadHistory = usePermission('conversations', 'read');
  const catalog = useApi(canSend ? '/chat/catalog' : '/agents', token, { agents: [], models: [] });
  const uploadCapabilities = useApi(canSend ? '/chat/attachments/capabilities' : null, token, { extensions: [], maxFiles: 5, maxBytes: 20 * 1024 * 1024, imageMaxBytes: 10 * 1024 * 1024 });
  const documentExtensions = (uploadCapabilities.data.extensions || []).filter(extension => !imageExtensions.includes(extension));
  const supportedImages = (uploadCapabilities.data.extensions || []).filter(extension => imageExtensions.includes(extension));
  const maxFiles = uploadCapabilities.data.maxFiles;
  const maxBytes = uploadCapabilities.data.maxBytes;
  const imageMaxBytes = uploadCapabilities.data.imageMaxBytes;
  const agents = Array.isArray(catalog.data) ? catalog.data : catalog.data.agents || [];
  const models = Array.isArray(catalog.data) ? [] : catalog.data.models || [];
  const conversations = useApi(canReadHistory ? '/conversations' : null, token);
  const [conversationId, setConversationId] = useState('');
  const [conversation, setConversation] = useState(null);
  const [modelId, setModelId] = useState('');
  const [messages, setMessages] = useState([]);
  const [query, setQuery] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [pending, setPending] = useState(null);
  const [sending, setSending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [exporting, setExporting] = useState('');
  const [error, setError] = useState('');
  const [showSummary, setShowSummary] = useState(false);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [queue, setQueue] = useState([]);
  const [stage, setStage] = useState('');
  const [dragging, setDragging] = useState(false);
  const queueState = useRef([]);
  const queryRef = useRef('');
  const textarea = useRef(null);
  const dragDepth = useRef(0);
  const pastedCount = useRef(0);
  const localIds = useRef(0);
  const conversationIdRef = useRef('');
  const end = useRef(null);
  const request = useRef(null);
  const uploadRequests = useRef(new Map());
  const attachmentState = useRef([]);
  const scope = useRef(0);
  const currentAgentId = useRef(selectedAgentId);
  const agent = agents.find(item => item.id === selectedAgentId);
  // Agent's own model if still released; otherwise the user's default; otherwise the first released one.
  const initialModelId = target => {
    const own = target?.modelId || target?.models?.find(item => item.isPrimary)?.modelId;
    if (own && models.some(item => item.id === own)) return own;
    if (catalog.data.defaultModelId && models.some(item => item.id === catalog.data.defaultModelId)) return catalog.data.defaultModelId;
    return models[0]?.id || '';
  };
  const noModels = canSend && !catalog.loading && !catalog.error && models.length === 0;
  const model = models.find(item => item.id === modelId) || (conversation?.modelId === modelId ? conversation.model : null);
  const supportsImages = model?.capabilities?.supportsVision && Number(model?.capabilities?.contextWindow) >= 4096;
  const canUseAgent = canSend && agent?.status === 'ACTIVE';
  const attachmentsBusy = attachments.some(file => file.status !== 'READY');
  const contextualAttachments = contextAttachments(attachments, messages);
  const historicalImages = contextualAttachments.some(file => file.mimeType?.startsWith('image/') && !attachments.some(current => current.id === file.id));
  const incompatibleImage = contextualAttachments.some(file => file.mimeType?.startsWith('image/')) && !supportsImages;
  // The composer stays editable while an answer streams: Enter then queues the message.
  const composerLocked = loadingHistory || !canUseAgent;
  const modelReady = models.some(item => item.id === modelId);
  const draftReady = !composerLocked && !!query.trim() && modelReady && !attachmentsBusy && !incompatibleImage;
  // After an error or Parar the queue waits; Enviar with an empty composer sends its first item.
  const queueResumable = !sending && !composerLocked && modelReady && !query.trim() && !attachments.length && queue.length > 0 && !incompatibleImage;
  const sendDisabled = !(draftReady || queueResumable);
  const attachAllowed = !composerLocked && !!modelId && !uploadCapabilities.loading && !uploadCapabilities.error;
  queryRef.current = query;

  function updateAttachments(update) {
    const next = typeof update === 'function' ? update(attachmentState.current) : update;
    attachmentState.current = next;
    setAttachments(next);
  }
  function updateQueue(update) {
    const next = typeof update === 'function' ? update(queueState.current) : update;
    queueState.current = next;
    setQueue(next);
  }
  function deleteFiles(files) {
    for (const file of files) if (file.id) apiRequest('/chat/attachments/' + file.id, { token, method: 'DELETE' }).catch(() => {});
  }
  function removeQueued(item) {
    deleteFiles(item.files);
    updateQueue(current => current.filter(entry => entry.id !== item.id));
  }
  function discardAttachments() {
    deleteFiles(queueState.current.flatMap(item => item.files));
    updateQueue([]);
    scope.current++;
    for (const controller of uploadRequests.current.values()) controller.abort();
    uploadRequests.current.clear();
    for (const file of attachmentState.current) {
      if (file.id) apiRequest('/chat/attachments/' + file.id, { token, method: 'DELETE' }).catch(() => {});
    }
    updateAttachments([]);
  }
  function resetChat(nextAgentId = selectedAgentId) {
    request.current?.abort();
    request.current = null;
    discardAttachments();
    setConversationId('');
    setConversation(null);
    setShowSummary(false);
    setMessages([]);
    setPending(null);
    setQuery('');
    setError('');
    setSending(false);
    setStage('');
    setLoadingHistory(false);
    const next = agents.find(item => item.id === nextAgentId);
    setModelId(initialModelId(next));
  }
  function selectAgent(id) {
    currentAgentId.current = id;
    resetChat(id);
    onSelectAgent(id);
  }
  useEffect(() => {
    if (currentAgentId.current !== selectedAgentId) {
      currentAgentId.current = selectedAgentId;
      resetChat(selectedAgentId);
    }
  }, [selectedAgentId]);
  useEffect(() => {
    if (!modelId && !conversationId && agent) setModelId(initialModelId(agent));
  }, [agent]);
  useEffect(() => () => {
    scope.current++;
    request.current?.abort();
    for (const controller of uploadRequests.current.values()) controller.abort();
  }, [token]);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages, pending, sending]);
  useEffect(() => {
    const processing = attachments.filter(file => file.id && file.status === 'PROCESSING');
    if (!processing.length) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const results = await Promise.allSettled(processing.map(file => apiRequest('/chat/attachments/' + file.id, { token, signal: controller.signal })));
      if (controller.signal.aborted) return;
      results.forEach((result, index) => {
        const file = processing[index];
        updateAttachments(current => current.map(item => item.id !== file.id ? item : result.status === 'fulfilled' ? { ...item, ...result.value } : result.reason.status === 404 ? { ...item, status: 'FAILED', errorMessage: 'O anexo não está mais disponível. Remova-o e envie novamente.' } : { ...item, errorMessage: 'Não foi possível consultar o processamento. Tentando novamente...' }));
      });
    }, 1500);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [attachments, token]);

  async function openConversation(id) {
    if (sending) return;
    discardAttachments();
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setLoadingHistory(true);
    setShowSummary(false);
    setPending(null);
    setQuery('');
    setError('');
    try {
      const history = await apiRequest('/conversations/' + id, { token, signal: controller.signal });
      if (controller.signal.aborted || request.current !== controller) return;
      currentAgentId.current = history.agentId;
      onSelectAgent(history.agentId);
      setConversation(history);
      setConversationId(id);
      setMessages(history.messages || []);
      const latest = [...(history.messages || [])].reverse().find(message => message.metadata?.modelId);
      const defaultAgent = agents.find(item => item.id === history.agentId);
      setModelId(history.modelId || latest?.metadata.modelId || initialModelId(defaultAgent));
    } catch (caught) {
      if (caught.name !== 'AbortError' && request.current === controller) setError(caught.message);
    } finally {
      if (request.current === controller && !controller.signal.aborted) setLoadingHistory(false);
    }
  }
  // The summary is only a cost optimization: messages stay on screen; this toggles it per conversation.
  async function changeSummary(action) {
    if (!conversationId || summaryBusy) return;
    const id = conversationId;
    setSummaryBusy(true);
    setShowSummary(false);
    setError('');
    try {
      const result = await apiRequest('/conversations/' + id + '/summary/' + action, { token, method: 'POST' });
      if (id !== conversationIdRef.current) return;
      // The POST alone settles the notice (turning it off discards the summary), so a failed reload leaves no stale text.
      const disabled = typeof result?.summaryDisabled === 'boolean' ? result.summaryDisabled : action === 'disable';
      setConversation(current => current ? { ...current, summaryDisabled: disabled, ...(disabled ? { summary: null, summaryActive: false } : {}) } : current);
      const fresh = await apiRequest('/conversations/' + id, { token }).catch(() => null);
      if (!fresh || id !== conversationIdRef.current) return;
      setConversation(current => current ? { ...current, summary: fresh.summary ?? null, summaryDisabled: fresh.summaryDisabled === true, summaryActive: fresh.summaryActive === true } : current);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setSummaryBusy(false);
    }
  }
  async function upload(files) {
    if (composerLocked || uploadCapabilities.loading || uploadCapabilities.error) return;
    setError('');
    const uploadScope = scope.current;
    const accepted = [];
    const errors = [];
    for (const file of files) {
      const extension = file.name.split('.').pop().toLowerCase();
      const image = imageExtensions.includes(extension);
      if (!documentExtensions.includes(extension) && !supportedImages.includes(extension)) { errors.push(file.name + ': formato não suportado. ZIP não é lido no chat; use PDF, Word, Excel, CSV ou texto.'); continue; }
      if (image && !supportsImages) { errors.push(file.name + ': selecione um modelo que permita analisar imagens e tenha a janela de contexto configurada.'); continue; }
      if (!file.size) { errors.push(file.name + ': o arquivo está vazio.'); continue; }
      const limit = image ? Math.min(imageMaxBytes, maxBytes) : maxBytes;
      if (file.size > limit) { errors.push(file.name + ': excede o limite de ' + fileSize(limit) + '.'); continue; }
      if (attachmentState.current.length + accepted.length >= maxFiles) { errors.push('Anexe até ' + maxFiles + ' arquivos por mensagem.'); break; }
      accepted.push({ file, clientId: crypto.randomUUID() });
    }
    if (errors.length) setError(errors.join(' '));
    updateAttachments(current => [...current, ...accepted.map(({ file, clientId }) => ({ clientId, name: file.name, sizeBytes: file.size, mimeType: file.type, status: 'UPLOADING' }))]);
    await Promise.all(accepted.map(async ({ file, clientId }) => {
      const controller = new AbortController();
      uploadRequests.current.set(clientId, controller);
      try {
        const body = new FormData();
        body.append('file', file);
        const document = await apiRequest('/chat/attachments', { token, method: 'POST', body, signal: controller.signal });
        if (scope.current !== uploadScope || controller.signal.aborted) {
          if (document.id) await apiRequest('/chat/attachments/' + document.id, { token, method: 'DELETE' }).catch(() => {});
          return;
        }
        updateAttachments(current => current.map(item => item.clientId === clientId ? { ...item, ...document } : item));
      } catch (caught) {
        if (caught.name !== 'AbortError' && scope.current === uploadScope) updateAttachments(current => current.map(item => item.clientId === clientId ? { ...item, status: 'FAILED', errorMessage: caught.message } : item));
      } finally {
        uploadRequests.current.delete(clientId);
      }
    }));
  }
  async function removeAttachment(file) {
    const removalScope = scope.current;
    uploadRequests.current.get(file.clientId)?.abort();
    uploadRequests.current.delete(file.clientId);
    if (file.id) {
      try { await apiRequest('/chat/attachments/' + file.id, { token, method: 'DELETE' }); }
      catch (caught) { if (caught.status !== 404) { if (scope.current === removalScope) setError(caught.message); return; } }
    }
    if (scope.current !== removalScope) return;
    updateAttachments(current => current.filter(item => item.clientId !== file.clientId));
  }
  async function saveResponse(response, fallbackName) {
    const disposition = response.headers.get('Content-Disposition') || '';
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = encoded ? decodeURIComponent(encoded) : fallbackName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function download(file) {
    try { await saveResponse(await apiRequest('/chat/attachments/' + file.id + '/download', { token, raw: true }), file.name); }
    catch (caught) { setError(caught.message); }
  }
  async function exportAnswer(message, format) {
    setExporting(message.id + format);
    setError('');
    try { await saveResponse(await apiRequest('/conversations/' + conversationId + '/messages/' + message.id + '/export?format=' + format, { token, raw: true }), 'documento.' + format); }
    catch (caught) { setError(caught.message); }
    finally { setExporting(''); }
  }
  // A message that got no answer goes back to the composer when it is empty, otherwise to the head of the queue.
  function restore(item) {
    if (!queryRef.current.trim() && !attachmentState.current.length) {
      setQuery(item.text);
      updateAttachments(item.files);
    } else updateQueue(current => [item, ...current]);
  }
  function takeDraft() {
    const item = { id: crypto.randomUUID(), text: query.trim(), files: [...attachmentState.current] };
    setQuery('');
    updateAttachments([]);
    return item;
  }
  function submit(event) {
    event?.preventDefault();
    if (sending) {
      if (draftReady) updateQueue(current => [...current, takeDraft()]);
      return;
    }
    if (draftReady) { dispatch(takeDraft(), conversationId); return; }
    if (queueResumable) {
      const [next, ...rest] = queueState.current;
      updateQueue(rest);
      dispatch(next, conversationId);
    }
  }
  function sendQueuedNow(item) {
    if (sending || composerLocked || !modelReady) return;
    updateQueue(current => current.filter(entry => entry.id !== item.id));
    dispatch(item, conversationId);
  }
  async function dispatch(item, targetConversationId) {
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    const active = () => !controller.signal.aborted && request.current === controller;
    setSending(true);
    setStage('');
    setError('');
    setPending({ question: item.text, answer: '', attachments: item.files });
    try {
      const response = await apiRequest('/agents/' + agent.id + '/chat/stream', {
        token, method: 'POST', body: { message: item.text, modelId, ...(targetConversationId ? { conversationId: targetConversationId } : {}), ...(item.files.length ? { attachmentIds: item.files.map(file => file.id) } : {}) }, signal: controller.signal, raw: true
      });
      const result = await consumeChatEvents(response.body, text => {
        if (!active()) return;
        setStage('');
        setPending(current => current ? { ...current, answer: current.answer + text } : null);
      }, etapa => { if (active() && stageLabels[etapa]) setStage(etapa); });
      if (!active()) return;
      setConversationId(result.conversationId);
      setConversation(current => ({ ...current, agentId: agent.id, agent: { id: agent.id, name: agent.name }, modelId, model }));
      setMessages(current => [...current, ...result.messages]);
      conversations.reload();
      // Only a confirmed answer releases the next queued message; errors and Parar leave the queue waiting.
      const [next, ...rest] = queueState.current;
      if (next) {
        updateQueue(rest);
        request.current = null; // this answer is done; the next one must not abort it
        dispatch(next, result.conversationId);
      }
    } catch (caught) {
      if (caught.name !== 'AbortError' && request.current === controller) {
        setError(caught.message);
        restore(item);
      }
    } finally {
      if (request.current === controller) { request.current = null; setSending(false); setPending(null); setStage(''); }
    }
  }
  function stop(event) {
    // The composer replaces this button with submit; suppress click activation first.
    event?.preventDefault();
    if (!sending) return;
    const current = pending;
    request.current?.abort();
    request.current = null;
    setSending(false);
    setPending(null);
    setStage('');
    if (!current) return;
    // The server saves nothing for a cancelled answer: this exchange exists only on this screen.
    const id = ++localIds.current;
    const createdAt = new Date().toISOString();
    setMessages(list => [...list,
      { id: 'local-question-' + id, role: 'user', content: current.question, localFiles: current.attachments, interrupted: true, createdAt },
      { id: 'local-answer-' + id, role: 'assistant', content: current.answer, interrupted: true, createdAt }]);
    restore({ id: crypto.randomUUID(), text: current.question, files: current.attachments });
  }
  function onPaste(event) {
    const data = event.clipboardData;
    const files = [...(data?.files || [])];
    // Text (even text copied along with a picture of it, as Office does) pastes as text.
    if (!files.length || data.getData('text/plain')) return;
    event.preventDefault();
    if (!attachAllowed) return;
    upload(files.map(file => file.type.startsWith('image/') ? new File([file], 'imagem-colada-' + (++pastedCount.current) + '.' + pastedExtension(file.type), { type: file.type }) : file));
  }
  const draggingFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
  function onDragEnter(event) {
    if (!draggingFiles(event) || !attachAllowed) return;
    event.preventDefault();
    dragDepth.current++;
    setDragging(true);
  }
  function onDragOver(event) {
    if (!draggingFiles(event) || !attachAllowed) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }
  function onDragLeave(event) {
    if (!draggingFiles(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDragging(false);
  }
  function onDrop(event) {
    if (!draggingFiles(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (attachAllowed && event.dataTransfer.files.length) upload([...event.dataTransfer.files]);
  }
  useLayoutEffect(() => {
    // Grows with the text up to about ten lines, then scrolls.
    const element = textarea.current;
    if (!element) return;
    const style = getComputedStyle(element);
    const borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    const max = (parseFloat(style.lineHeight) || 20) * 10 + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + borders;
    element.style.height = 'auto';
    const wanted = element.scrollHeight + borders;
    element.style.height = Math.min(wanted, max) + 'px';
    element.style.overflowY = wanted > max ? 'auto' : 'hidden';
  }, [query]);
  conversationIdRef.current = conversationId;
  const activeAgentName = agent?.name || conversation?.agent?.name;
  const visibleAgents = agents.filter(item => item.status !== 'ARCHIVED');
  const title = conversation?.title || (messages.length ? 'Conversa' : 'Nova conversa');
  const empty = !loadingHistory && !messages.length && !pending;
  return <State loading={catalog.loading} error={catalog.error} retry={catalog.reload}>
    <div className="chat-layout">
      <aside className="chat-panel chat-list" aria-label="Histórico de conversas">
        <div className="chat-list-head"><h2>Conversas</h2><IconButton aria-label="Nova conversa" variant="secondary" disabled={sending} onClick={() => resetChat()} icon={<Plus size={18} />} type="button" /></div>
        <div className="chat-list-body">
          {canReadHistory ? <State loading={conversations.loading} error={conversations.error} retry={conversations.reload} empty={!conversations.data.length && 'Suas conversas aparecerão aqui.'}>
            <SelectableList bare label="Suas conversas" items={conversations.data.map(item => ({ id: item.id, title: item.title || 'Nova conversa', description: [item.agent?.name, shortDate(item.updatedAt)].filter(Boolean).join(', '), disabled: sending }))} value={conversationId} onChange={openConversation} />
          </State> : <p className="muted">Seu perfil não permite consultar o histórico de conversas.</p>}
        </div>
      </aside>

      <section className={'chat-panel chat-window' + (dragging ? ' is-dragging' : '')} aria-label="Conversa" onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} onKeyDown={event => { if (event.key === 'Escape' && sending) stop(event); }}>
        {dragging && <div className="chat-drop-overlay" aria-hidden="true"><Paperclip size={22} aria-hidden="true" /> Solte para anexar</div>}
        <header className="chat-window-head">
          <h2 title={title}>{title}</h2>
          <div className="chat-selectors">
            <Select aria-label="Agente da conversa" size="compact" icon={<Bot size={14} />} value={selectedAgentId || ''} onChange={event => selectAgent(event.target.value)} disabled={sending}>
              <option value="">Selecione um agente</option>
              {visibleAgents.map(item => <option key={item.id} value={item.id}>{item.name}{item.status === 'DRAFT' ? ' (rascunho)' : ''}</option>)}
              {(!agent || agent.status === 'ARCHIVED') && conversation?.agent && <option value={conversation.agentId}>{conversation.agent.name}</option>}
            </Select>
            <Select aria-label="Modelo da conversa" size="compact" icon={<Cpu size={14} />} value={modelId} onChange={event => setModelId(event.target.value)} disabled={sending || loadingHistory || !canSend || noModels}>
              <option value="">Selecione um modelo</option>
              {models.map(item => <option key={item.id} value={item.id}>{item.name} · {item.provider?.name}</option>)}
              {modelId && !models.some(item => item.id === modelId) && <option value={modelId}>{model?.name || 'Modelo usado nesta conversa'}</option>}
            </Select>
          </div>
        </header>

        <div className="messages" aria-live="polite">
          {loadingHistory && <p className="chat-status" role="status"><Spinner size="sm" tone="muted" /> Carregando conversa...</p>}
          {empty && <div className="chat-empty">
            <EmptyState icon={Bot} title={activeAgentName ? 'Pergunte ao ' + activeAgentName : 'Escolha um agente para começar'} description={activeAgentName ? 'Anexe editais, planilhas ou documentos e pergunte em linguagem simples. As respostas seguem as instruções e as bases deste agente.' : 'Use o seletor acima. Cada agente tem instruções e bases de conhecimento próprias.'} />
            {canUseAgent && <div className="chat-suggestions">{suggestions.map(text => <Button key={text} type="button" variant="secondary" size="sm" onClick={() => setQuery(text)}>{text}</Button>)}</div>}
          </div>}
          {!loadingHistory && conversationId && conversation?.summaryActive === true && conversation.summary?.content && !conversation.summaryDisabled && <div className="chat-summary-notice" role="note">
            <p>As mensagens anteriores a {shortDate(conversation.summary.updatedAt)} foram resumidas para reduzir o custo. As mensagens continuam salvas.</p>
            <div className="chat-summary-actions">
              <Button type="button" variant="secondary" size="sm" onClick={() => setShowSummary(value => !value)} aria-expanded={showSummary}>{showSummary ? 'Ocultar resumo' : 'Ver resumo'}</Button>
              <Button type="button" variant="secondary" size="sm" disabled={summaryBusy} onClick={() => changeSummary('disable')}>Usar mensagens completas</Button>
            </div>
            {showSummary && <pre className="chat-summary-text">{conversation.summary.content}</pre>}
          </div>}
          {!loadingHistory && conversationId && conversation?.summaryDisabled && <div className="chat-summary-notice" role="note">
            <p>Esta conversa usa as mensagens completas.</p>
            <div className="chat-summary-actions"><Button type="button" variant="secondary" size="sm" disabled={summaryBusy} onClick={() => changeSummary('enable')}>Permitir resumo</Button></div>
          </div>}
          {!loadingHistory && messages.map(message => <article key={message.id} className={'message ' + (message.role === 'user' ? 'user' : 'agent')}>
            {message.role === 'user' ? <span className="message-text">{message.content}</span> : message.content && <AnswerText>{message.content}</AnswerText>}
            {!!message.localFiles?.length && <div className="source-chips">{message.localFiles.map(file => <Chip key={file.id || file.clientId} variant="outline">{file.name}</Chip>)}</div>}
            {!!messageAttachments(message).length && <div className="chat-message-files">{messageAttachments(message).map(file => { const Icon = fileIcon(file); return <div className="chat-file" key={file.id}><Icon size={15} aria-hidden="true" /><span>{file.name}</span><IconButton type="button" size="xs" aria-label={'Baixar ' + file.name} disabled={!canSend} icon={<Download size={14} />} onClick={() => download(file)} /></div>; })}</div>}
            {message.metadata?.sources?.length > 0 && <div className="source-chips">{message.metadata.sources.map((source, index) => <Chip key={source.id || index} variant="outline">Fonte: {source.documentName}</Chip>)}</div>}
            <div className="message-meta">
              {message.role === 'assistant' && message.metadata?.model && <small>{message.metadata.modelName || message.metadata.model}{message.metadata.providerName ? ' · ' + message.metadata.providerName : ''}</small>}
              {message.interrupted && message.role === 'assistant' ? <small className="message-interrupted">Resposta interrompida.</small> : <small>{shortDate(message.createdAt)}</small>}
            </div>
            {message.role === 'assistant' && !message.interrupted && canReadHistory && conversationId && message.content?.trim() && <div className="message-actions" role="group" aria-label="Baixar esta resposta">
              {exportFormats.filter(([format]) => format !== 'xlsx' || hasMarkdownTable(message.content)).map(([format, label]) => <Button key={format} type="button" variant="secondary" size="sm" aria-label={'Baixar resposta em ' + label} disabled={!!exporting} onClick={() => exportAnswer(message, format)}>{exporting === message.id + format ? <Spinner size="xs" tone="current" /> : <FileDown size={14} aria-hidden="true" />} {label}</Button>)}
            </div>}
          </article>)}
          {pending && <>
            <article className="message user"><span className="message-text">{pending.question}</span>{!!pending.attachments.length && <div className="source-chips">{pending.attachments.map(file => <Chip key={file.id} variant="outline">{file.name}</Chip>)}</div>}</article>
            {pending.answer && <article className="message agent"><AnswerText>{pending.answer}</AnswerText><div className="message-meta"><small>Respondendo...</small></div></article>}
          </>}
          {sending && (stage || !pending?.answer) && <p className="chat-status" role="status"><Spinner size="sm" tone="accent" /> {stageLabels[stage] || 'O agente está preparando a resposta...'}</p>}
          <div ref={end} />
        </div>

        <div className="chat-footer">
          {error && <Alert tone="danger">{error}</Alert>}
          {noModels && <Alert tone="info">Nenhum modelo de IA foi liberado para você. Fale com o administrador da plataforma.</Alert>}
          {!canSend && <p className="panel-note">Seu perfil permite consultar as conversas.</p>}
          {agent && agent.status !== 'ACTIVE' && <p className="panel-note">Ative o agente nas configurações para conversar.</p>}
          {canUseAgent && incompatibleImage && <Alert tone="danger">{historicalImages ? 'Esta conversa contém imagens. Selecione um modelo com análise de imagens e janela de contexto configuradas ou inicie uma nova conversa.' : 'Os anexos incluem imagens. Selecione um modelo com análise de imagens e janela de contexto configuradas ou remova esses arquivos.'}</Alert>}
          {canUseAgent && uploadCapabilities.error && <Alert tone="danger" actions={<Button type="button" variant="secondary" onClick={uploadCapabilities.reload}>Tentar carregar opções de anexo</Button>}>{uploadCapabilities.error}</Alert>}
          <form className="chat-composer" onSubmit={submit}>
            {!!queue.length && <ul className="chat-queue" aria-label="Mensagens na fila">{queue.map(item => <li key={item.id} className="chat-queue-item">
              <span className="chat-queue-tag"><Clock size={12} aria-hidden="true" /> Na fila</span>
              <span className="chat-queue-text" title={item.text}>{item.text}</span>
              {!!item.files.length && <small>{item.files.length === 1 ? '1 anexo' : item.files.length + ' anexos'}</small>}
              {!sending && <IconButton type="button" size="xs" variant="ghost" aria-label={'Enviar agora: ' + preview(item.text)} disabled={composerLocked || !modelReady} onClick={() => sendQueuedNow(item)} icon={<Send size={13} />} />}
              <IconButton type="button" size="xs" variant="ghost" aria-label={'Remover da fila: ' + preview(item.text)} onClick={() => removeQueued(item)} icon={<X size={14} />} />
            </li>)}</ul>}
            {!!attachments.length && <div className="chat-draft-files" aria-label="Anexos da mensagem">{attachments.map(file => { const Icon = file.status === 'FAILED' ? AlertCircle : fileIcon(file); return <div key={file.clientId} className={'chat-draft-file' + (file.status === 'FAILED' ? ' is-failed' : '')}>
              {['UPLOADING', 'PROCESSING'].includes(file.status) ? <Spinner size="xs" tone="muted" /> : <Icon size={16} aria-hidden="true" />}
              <div><b>{file.name}</b><small>{fileSize(file.sizeBytes)} · {statusLabels[file.status] || file.status}</small>{file.errorMessage && <span className="document-error">{file.errorMessage}</span>}</div>
              <IconButton type="button" size="xs" variant="danger" aria-label={'Remover ' + file.name} onClick={() => removeAttachment(file)} icon={<X size={14} />} />
            </div>; })}</div>}
            <Textarea ref={textarea} aria-label="Mensagem" value={query} onChange={event => setQuery(event.target.value)} onPaste={onPaste} onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
            }} placeholder={!canUseAgent ? 'Escolha um agente ativo para escrever.' : sending ? 'Escreva a próxima mensagem; ela entra na fila...' : 'Escreva sua pergunta ou peça um rascunho...'} disabled={composerLocked} maxLength={16000} rows={2} />
            <div className="chat-composer-actions">
              <FileButton onFiles={upload} accept={[...documentExtensions, ...(supportsImages ? supportedImages : [])].map(extension => '.' + extension).join(',')} multiple disabled={!attachAllowed || attachments.length >= maxFiles} icon={<Paperclip size={16} />} variant="ghost" size="sm">Anexar arquivos</FileButton>
              {canUseAgent && <p className="chat-hint"><span className="chat-hint-long">Shift+Enter quebra a linha. Cole ou arraste arquivos. Até {maxFiles} arquivos de {fileSize(maxBytes)}{supportsImages ? ', imagens até ' + fileSize(Math.min(imageMaxBytes, maxBytes)) : ''}.</span><span className="chat-hint-short">Shift+Enter quebra a linha.</span></p>}
              {sending ? <Button key="stop" type="button" variant="secondary" size="sm" aria-label="Interromper resposta (Esc)" onClick={stop}><Square size={13} aria-hidden="true" /> Parar</Button> : <Button key="send" type="submit" size="sm" aria-label="Enviar mensagem" disabled={sendDisabled}>Enviar <Send size={14} aria-hidden="true" /></Button>}
            </div>
          </form>
        </div>
      </section>
    </div>
  </State>;
}
