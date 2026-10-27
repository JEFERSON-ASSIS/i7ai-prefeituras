import { MiniStat, FileUpload, Alert, Button, Card, IconButton, Input, Select, Textarea } from "@sgdm/design";
import { useEffect, useState } from 'react';
import { Download, RefreshCw, Trash2, Pencil } from 'lucide-react';
import { apiRequest } from '../api/client';
import { usePermission } from '../api/permissions';
import { useApi } from '../hooks/useApi';
import { Modal, PageActions, State, Status, Table, dateTime } from '../components/Common';
export function KnowledgePage({
  token,
  active,
  notify
}) {
  const canBases = usePermission('knowledge-bases', 'write'),
    canDocs = usePermission('documents', 'write');
  const bases = useApi('/knowledge-bases', token),
    docs = useApi('/documents', token);
  const [editor, setEditor] = useState(null),
    [baseId, setBaseId] = useState('');
  const [uploading, setUploading] = useState(false),
    [error, setError] = useState('');
  const [deleting, setDeleting] = useState(null);
  const busy = docs.data.some(item => ['UPLOADED', 'PROCESSING'].includes(item.status));
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(docs.reload, 5000);
    return () => clearInterval(timer);
  }, [busy, docs.reload]);
  async function upload(files) {
    if (!files?.length || uploading || !canDocs) return;
    if (!baseId) {
      setError('Selecione a base de conhecimento que receberá os arquivos.');
      return;
    }
    setError('');
    setUploading(true);
    let completed = 0;
    try {
      for (const file of files) {
        if (file.size > 50 * 1024 * 1024) throw new Error(file.name + ' excede o limite de 50 MB.');
        const body = new FormData();
        body.append('file', file);
        body.append('knowledgeBaseId', baseId);
        await apiRequest('/documents/upload', {
          token,
          method: 'POST',
          body
        });
        completed++;
      }
      notify(completed + ' documento(s) enviado(s) para processamento.');
    } catch (error) {
      setError(error.message);
    } finally {
      setUploading(false);
      docs.reload();
      bases.reload();
    }
  }
  async function download(doc) {
    try {
      const response = await apiRequest('/documents/' + doc.id + '/download', {
        token,
        raw: true
      });
      const blob = await response.blob(),
        url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = doc.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setError(error.message);
    }
  }
  async function reprocess(doc) {
    try {
      await apiRequest('/documents/' + doc.id + '/reprocess', {
        token,
        method: 'POST'
      });
      docs.reload();
      notify('Documento reenviado para processamento.');
    } catch (error) {
      setError(error.message);
    }
  }
  async function remove() {
    try {
      await apiRequest('/documents/' + deleting.id, {
        token,
        method: 'DELETE'
      });
      setDeleting(null);
      docs.reload();
      bases.reload();
      notify('Documento excluído.');
    } catch (error) {
      setError(error.message);
    }
  }
  const visibleDocs = docs.data.filter(doc => !baseId || doc.knowledgeBaseId === baseId);
  return <>
    <PageActions label="Nova base" onCreate={canBases ? () => setEditor({}) : null} />
    {error && <Alert tone="danger">{error}</Alert>}
    <div className="knowledge-summary"><MiniStat label="Bases de conhecimento" value={bases.data.length} /><MiniStat label="Documentos processados" value={docs.data.filter(doc => doc.status === "READY").length} /><MiniStat label="Armazenamento utilizado" value={(docs.data.reduce((total, doc) => total + Number(doc.sizeBytes || 0), 0) / 1024 / 1024).toFixed(1) + " MB"} /></div>
    {active === 'knowledge' ? <State loading={bases.loading} error={bases.error} retry={bases.reload} empty={!bases.data.length && 'Crie uma base para organizar os documentos dos agentes.'}><div><Card padding="none"><Table headers={['Base', 'Documentos', 'Agentes', 'Status', 'Atualizada', 'Ações']} rows={bases.data.map(base => [<b>{base.name}</b>, base._count?.documents || 0, base._count?.agents || 0, <Status value={base.status} />, dateTime(base.updatedAt), <Button disabled={!canBases} onClick={() => setEditor(base)} variant="link" icon={<Pencil size={14} />} type="button">Editar</Button>])} /></Card></div></State> : <><div className="upload-panel"><Card><Select aria-label="Base para upload" value={baseId} onChange={event => setBaseId(event.target.value)} label={<>Base de conhecimento</>}><option value="">Selecione uma base</option>{bases.data.filter(base => base.status === 'ACTIVE').map(base => <option key={base.id} value={base.id}>{base.name}</option>)}</Select>
    {bases.error && <Alert tone="danger">{bases.error}</Alert>}
    <FileUpload files={[]} onChange={files => upload(files)} accept=".pdf,.doc,.docx,.xls,.xlsx,.txt,.md,.csv,.json,.xml,.html,.htm" maxFiles={100} title={uploading ? "Enviando arquivos..." : "Arraste arquivos ou selecione no computador"} hint="PDF com texto, Word (DOC/DOCX), Excel (XLS/XLSX), TXT, MD, CSV, JSON, XML e HTML · até 50 MB por arquivo" buttonLabel="Carregar documento" disabled={uploading || !baseId || !canDocs} onReject={() => setError("O formato do arquivo não é aceito.")} /></Card></div><State loading={docs.loading} error={docs.error} retry={docs.reload} empty={!visibleDocs.length && 'Nenhum documento nesta seleção.'}><div><Card padding="none"><Table headers={['Documento', 'Base', 'Status', 'Tamanho', 'Ações']} rows={visibleDocs.map(doc => [<><b>{doc.name}</b>{doc.errorMessage && <small className="document-error">{doc.errorMessage}</small>}</>, bases.data.find(base => base.id === doc.knowledgeBaseId)?.name || 'Sem base', <Status value={doc.status} />, Math.round(Number(doc.sizeBytes) / 1024) + ' KB', <div className="row-actions"><IconButton aria-label={'Baixar ' + doc.name} onClick={() => download(doc)} icon={<><Download size={16} /></>} type="button" /><IconButton aria-label={'Reprocessar ' + doc.name} disabled={!canDocs || ['UPLOADED', 'PROCESSING'].includes(doc.status)} onClick={() => reprocess(doc)} icon={<><RefreshCw size={16} /></>} type="button" /><IconButton disabled={!canDocs} aria-label={'Excluir ' + doc.name} onClick={() => setDeleting(doc)} icon={<><Trash2 size={16} /></>} variant="danger" type="button" /></div>])} /></Card></div></State></>}
    {editor && <BaseEditor token={token} base={editor} onClose={() => setEditor(null)} onSaved={() => {
      setEditor(null);
      bases.reload();
      notify('Base salva.');
    }} />}
    {deleting && <Modal title="Excluir documento" onClose={() => setDeleting(null)}><div className="form"><p>Excluir {deleting.name} e os trechos usados pelos agentes?</p></div><div className="modal-actions"><Button onClick={() => setDeleting(null)} variant="secondary" type="button">Cancelar</Button><Button onClick={remove} type="button" variant="danger">Excluir documento</Button></div></Modal>}
  </>;
}
function BaseEditor({
  token,
  base,
  onClose,
  onSaved
}) {
  const [name, setName] = useState(base.name || ''),
    [description, setDescription] = useState(base.description || ''),
    [status, setStatus] = useState(base.status || 'ACTIVE'),
    [error, setError] = useState(''),
    [saving, setSaving] = useState(false);
  async function save(event) {
    event.preventDefault();
    setSaving(true);
    try {
      await apiRequest('/knowledge-bases' + (base.id ? '/' + base.id : ''), {
        token,
        method: base.id ? 'PATCH' : 'POST',
        body: {
          name,
          description,
          ...(base.id ? {
            status
          } : {})
        }
      });
      onSaved();
    } catch (error) {
      setError(error.message);
    } finally {
      setSaving(false);
    }
  }
  return <Modal title={base.id ? 'Editar base' : 'Nova base'} onClose={onClose}><form onSubmit={save}><div className="form">{error && <Alert tone="danger">{error}</Alert>}<Input required value={name} onChange={event => setName(event.target.value)} label={<>Nome</>} /><Textarea value={description} onChange={event => setDescription(event.target.value)} label={<>Descrição</>} />{base.id && <Select value={status} onChange={event => setStatus(event.target.value)} label={<>Status</>}><option value="ACTIVE">Ativa</option><option value="INACTIVE">Inativa</option></Select>}</div><div className="modal-actions"><Button type="button" onClick={onClose} variant="secondary">Cancelar</Button><Button disabled={saving} variant="primary" type="submit">{saving ? 'Salvando...' : 'Salvar base'}</Button></div></form></Modal>;
}
