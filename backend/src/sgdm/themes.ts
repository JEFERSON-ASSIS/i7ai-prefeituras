/**
 * Fixed list of conversation themes (Central de IA, Entrega 6). Pure and deterministic:
 * no model is called, so no conversation data leaves i7Ai just to be classified.
 * Bump THEME_VERSION whenever the table or the matching rules change; the backfill
 * recalculates every conversation whose themeVersion is lower.
 */
export const THEME_VERSION = 2;

export type ThemeId = 'licitacoes' | 'juridico' | 'documentos' | 'pessoal' | 'tributos' | 'financas' | 'saude' | 'educacao' | 'assistencia' | 'obras' | 'meio-ambiente' | 'atendimento' | 'tecnologia' | 'texto' | 'outros';

export const THEMES: readonly { id: ThemeId; label: string; keywords: readonly string[] }[] = [
  { id: 'licitacoes', label: 'Licitações e contratos', keywords: ['licita', 'pregao', 'edital', 'contrat', 'aditivo', 'dispensa', 'inexigib', 'termo de referencia', 'ata de registro', '14.133', 'fornecedor', 'leilao', 'pesquisa de precos', 'cotacao', 'credenciamento', 'chamamento', 'fiscal de contrato'] },
  { id: 'juridico', label: 'Pareceres e questões jurídicas', keywords: ['parecer', 'juridic', 'lei', 'decreto', 'procuradori', 'recurso', 'mandado', 'acao judicial', 'constituc', 'sentenca', 'projeto de lei', 'lgpd', 'legislac', 'normativ', 'regulament', 'tcu'] },
  { id: 'documentos', label: 'Ofícios e documentos oficiais', keywords: ['oficio', 'memorando', 'portaria', 'despacho', 'circular', 'requerimento', 'notificac', 'comunicado', 'minuta', 'carta', 'ata', 'convite', 'convocac', 'relatorio', 'declaracao', 'certidao', 'discurso'] },
  { id: 'pessoal', label: 'Pessoal e RH', keywords: ['servidor', 'ferias', 'licenca', 'folha', 'concurso', 'nomeac', 'exonera', 'aposentad', 'estagi', 'ponto', 'rh', 'gratifica', 'progressao', 'recursos humanos', 'cargo', 'salario', 'remuneracao', 'adicional', 'escala'] },
  { id: 'tributos', label: 'Tributos e arrecadação', keywords: ['iptu', 'iss', 'itbi', 'tribut', 'imposto', 'taxa', 'divida ativa', 'alvara', 'arrecada', 'nota fiscal', 'fiscaliza', 'contribuinte', 'cobranca'] },
  { id: 'financas', label: 'Orçamento e finanças', keywords: ['orcament', 'loa', 'ldo', 'ppa', 'empenho', 'liquidac', 'pagamento', 'receita', 'despesa', 'prestacao de contas', 'tce', 'convenio'] },
  { id: 'saude', label: 'Saúde', keywords: ['saude', 'ubs', 'sus', 'hospital', 'vacina', 'medicament', 'atencao basica', 'vigilancia sanitaria', 'paciente', 'medico', 'enfermagem', 'consulta', 'exame', 'farmacia', 'samu'] },
  { id: 'educacao', label: 'Educação', keywords: ['escola', 'educac', 'aluno', 'professor', 'merenda', 'transporte escolar', 'creche', 'matricula', 'fundeb', 'ensino', 'pedagog', 'biblioteca'] },
  { id: 'assistencia', label: 'Assistência social', keywords: ['cras', 'creas', 'bolsa familia', 'cadunico', 'assistencia social', 'vulnerab', 'beneficio eventual', 'idoso', 'crianca', 'adolescente', 'conselho tutelar', 'deficien'] },
  { id: 'obras', label: 'Obras e urbanismo', keywords: ['obra', 'pavimenta', 'engenhari', 'projeto basico', 'medicao', 'urbanis', 'loteamento', 'iluminacao', 'drenagem', 'reforma', 'praca', 'asfalto', 'buraco', 'calcada', 'ponte', 'transito', 'zeladoria'] },
  { id: 'meio-ambiente', label: 'Meio ambiente', keywords: ['ambiental', 'meio ambiente', 'residuo', 'lixo', 'saneamento', 'arboriza', 'desmatamento'] },
  { id: 'atendimento', label: 'Atendimento ao cidadão', keywords: ['ouvidoria', 'cidadao', 'reclamac', 'protocolo', 'atendimento', 'e-sic', 'acesso a informacao', 'denuncia', 'solicitac', 'carta de servicos'] },
  { id: 'tecnologia', label: 'Tecnologia e sistemas', keywords: ['sistema', 'planilha', 'excel', 'software', 'computador', 'internet', 'site', 'senha', 'inteligencia artificial', 'chatgpt', 'aplicativo'] },
  { id: 'texto', label: 'Revisão e resumo de textos', keywords: ['resum', 'revis', 'corrig', 'reescrev', 'traduz', 'ortografia', 'redacao', 'redigir', 'elabor', 'explicar'] },
  { id: 'outros', label: 'Outros', keywords: [] },
];

/** NFD without diacritics (combining marks), lower case, whitespace collapsed. */
export function normalizeText(s: string): string {
  return (s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Up to 4 characters: whole word with an optional final "s" ("lei" matches "leis", never "leitura").
// Longer: start of a word ("contrat" matches "contratacao"). Compiled once, without the g flag.
const pattern = (keyword: string) => keyword.length <= 4 ? new RegExp('\\b' + escape(keyword) + 's?\\b') : new RegExp('\\b' + escape(keyword));

// Multi-word keywords are matched first and consume their words, so "recursos humanos" counts
// for pessoal and not also as "recurso" (juridico); "carta de servicos" is not also a "carta".
const PHRASES = THEMES.flatMap((theme, index) => theme.keywords.filter(keyword => keyword.includes(' ')).map(keyword => ({ index, keyword })))
  .sort((a, b) => b.keyword.length - a.keyword.length)
  .map(({ index, keyword }) => ({ index, regex: new RegExp('\\b' + escape(keyword), 'g') }));
const WORDS = THEMES.map(theme => theme.keywords.filter(keyword => !keyword.includes(' ')).map(pattern));

/** Hits per theme (each keyword counts once) in one normalized text. */
function hits(text: string): number[] {
  const counts = THEMES.map(() => 0);
  if (!text) return counts;
  let rest = text;
  for (const phrase of PHRASES) {
    phrase.regex.lastIndex = 0;
    if (!phrase.regex.test(rest)) continue;
    counts[phrase.index]++;
    phrase.regex.lastIndex = 0;
    rest = rest.replace(phrase.regex, match => ' '.repeat(match.length));
  }
  WORDS.forEach((patterns, index) => { for (const word of patterns) if (word.test(rest)) counts[index]++; });
  return counts;
}

/**
 * Each keyword hit in the title is worth 2, in the agent name 1. Highest score wins; on a tie, more
 * hits win; still tied, table order. No hit → outros. A null title leaves only the agent name.
 */
export function classifyTheme(title: string | null, agentName: string): ThemeId {
  const titleHits = hits(title == null ? '' : normalizeText(title));
  const agentHits = hits(normalizeText(agentName ?? ''));
  let best: ThemeId = 'outros';
  let bestScore = 0; let bestHits = 0;
  THEMES.forEach((theme, index) => {
    const score = titleHits[index] * 2 + agentHits[index];
    const count = titleHits[index] + agentHits[index];
    if (score > bestScore || (score > 0 && score === bestScore && count > bestHits)) { best = theme.id; bestScore = score; bestHits = count; }
  });
  return best;
}

const LABELS = new Map<string, string>(THEMES.map(theme => [theme.id, theme.label]));

/** Label of a theme id; unknown ids read as "Outros". */
export function themeLabel(id: string): string {
  return LABELS.get(id) ?? 'Outros';
}
