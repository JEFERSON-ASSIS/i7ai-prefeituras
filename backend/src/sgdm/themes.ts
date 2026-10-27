/**
 * Fixed list of conversation themes (Central de IA, Entrega 6). Pure and deterministic:
 * no model is called, so no conversation data leaves i7Ai just to be classified.
 * Bump THEME_VERSION whenever the table or the matching rules change; the backfill
 * recalculates every conversation whose themeVersion is lower.
 */
export const THEME_VERSION = 1;

export type ThemeId = 'licitacoes' | 'juridico' | 'documentos' | 'pessoal' | 'tributos' | 'financas' | 'saude' | 'educacao' | 'assistencia' | 'obras' | 'meio-ambiente' | 'atendimento' | 'tecnologia' | 'texto' | 'outros';

export const THEMES: readonly { id: ThemeId; label: string; keywords: readonly string[] }[] = [
  { id: 'licitacoes', label: 'Licitações e contratos', keywords: ['licita', 'pregao', 'edital', 'contrat', 'aditivo', 'dispensa', 'inexigib', 'termo de referencia', 'ata de registro', '14.133', 'fornecedor', 'leilao'] },
  { id: 'juridico', label: 'Pareceres e questões jurídicas', keywords: ['parecer', 'juridic', 'lei', 'decreto', 'procuradori', 'recurso', 'mandado', 'acao judicial', 'constituc', 'sentenca'] },
  { id: 'documentos', label: 'Ofícios e documentos oficiais', keywords: ['oficio', 'memorando', 'portaria', 'despacho', 'circular', 'requerimento', 'notificac', 'comunicado', 'minuta', 'carta'] },
  { id: 'pessoal', label: 'Pessoal e RH', keywords: ['servidor', 'ferias', 'licenca', 'folha', 'concurso', 'nomeac', 'exonera', 'aposentad', 'estagi', 'ponto', 'rh', 'gratifica', 'progressao'] },
  { id: 'tributos', label: 'Tributos e arrecadação', keywords: ['iptu', 'iss', 'itbi', 'tribut', 'imposto', 'taxa', 'divida ativa', 'alvara', 'arrecada', 'nota fiscal'] },
  { id: 'financas', label: 'Orçamento e finanças', keywords: ['orcament', 'loa', 'ldo', 'ppa', 'empenho', 'liquidac', 'pagamento', 'receita', 'despesa', 'prestacao de contas', 'tce', 'convenio'] },
  { id: 'saude', label: 'Saúde', keywords: ['saude', 'ubs', 'sus', 'hospital', 'vacina', 'medicament', 'atencao basica', 'vigilancia sanitaria', 'paciente'] },
  { id: 'educacao', label: 'Educação', keywords: ['escola', 'educac', 'aluno', 'professor', 'merenda', 'transporte escolar', 'creche', 'matricula', 'fundeb'] },
  { id: 'assistencia', label: 'Assistência social', keywords: ['cras', 'creas', 'bolsa familia', 'cadunico', 'assistencia social', 'vulnerab', 'beneficio eventual', 'idoso'] },
  { id: 'obras', label: 'Obras e urbanismo', keywords: ['obra', 'pavimenta', 'engenhari', 'projeto basico', 'medicao', 'urbanis', 'loteamento', 'iluminacao', 'drenagem', 'reforma'] },
  { id: 'meio-ambiente', label: 'Meio ambiente', keywords: ['ambiental', 'meio ambiente', 'residuo', 'lixo', 'saneamento', 'arboriza', 'desmatamento'] },
  { id: 'atendimento', label: 'Atendimento ao cidadão', keywords: ['ouvidoria', 'cidadao', 'reclamac', 'protocolo', 'atendimento', 'e-sic', 'acesso a informacao', 'denuncia'] },
  { id: 'tecnologia', label: 'Tecnologia e sistemas', keywords: ['sistema', 'planilha', 'excel', 'software', 'computador', 'internet', 'site', 'senha'] },
  { id: 'texto', label: 'Revisão e resumo de textos', keywords: ['resum', 'revis', 'corrig', 'reescrev', 'traduz', 'ortografia', 'redacao'] },
  { id: 'outros', label: 'Outros', keywords: [] },
];

/** NFD without diacritics, lower case, whitespace collapsed. */
export function normalizeText(s: string): string {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Up to 4 characters: whole word with an optional final "s" ("lei" matches "leis", never "leitura").
// Longer: start of a word ("contrat" matches "contratacao"). Compiled once, without the g flag.
const MATCHERS = THEMES.map(theme => ({
  id: theme.id,
  patterns: theme.keywords.map(keyword => keyword.length <= 4 ? new RegExp('\\b' + escape(keyword) + 's?\\b') : new RegExp('\\b' + escape(keyword))),
}));

/** Each keyword hit in the title is worth 2, in the agent name 1; ties go to table order; no hit → outros. */
export function classifyTheme(title: string | null, agentName: string): ThemeId {
  const normalizedTitle = title == null ? '' : normalizeText(title);
  const normalizedAgent = normalizeText(agentName ?? '');
  let best: ThemeId = 'outros';
  let bestScore = 0;
  for (const matcher of MATCHERS) {
    let score = 0;
    for (const pattern of matcher.patterns) {
      if (normalizedTitle && pattern.test(normalizedTitle)) score += 2;
      if (normalizedAgent && pattern.test(normalizedAgent)) score += 1;
    }
    if (score > bestScore) { best = matcher.id; bestScore = score; }
  }
  return best;
}

const LABELS = new Map<string, string>(THEMES.map(theme => [theme.id, theme.label]));

/** Label of a theme id; unknown ids read as "Outros". */
export function themeLabel(id: string): string {
  return LABELS.get(id) ?? 'Outros';
}
