/**
 * Masks personal data in a conversation title before it leaves i7Ai (Central de IA, LGPD).
 * Order matters: e-mail, CNPJ, CPF, phone (only with area code in parentheses or a hyphen,
 * so a process number is not taken for a phone), then any remaining run of 6+ digits.
 * Names of people cannot be detected reliably and are not masked.
 */
export function maskPersonalData(text: string): string {
  return (text || '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[e-mail]')
    .replace(/\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/g, '[CNPJ]')
    .replace(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/g, '[CPF]')
    .replace(/\(\d{2}\)\s?9?\d{4}-?\d{4}|\b9?\d{4}-\d{4}\b/g, '[telefone]')
    .replace(/\d{6,}/g, '[número]');
}
