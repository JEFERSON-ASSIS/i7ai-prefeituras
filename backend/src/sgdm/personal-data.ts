/**
 * Masks personal data in a conversation title before it leaves i7Ai (Central de IA, LGPD).
 * Order matters: e-mail, CNPJ, CPF, phone, then any remaining run of 6+ digits.
 * CPF and CNPJ must not touch other digits, so a 12–16 digit run becomes [número].
 * A phone needs an area code (with or without parentheses, optional +55) followed by
 * separated groups, or a hyphenated local number, so a process number is not taken for a phone.
 * Names of people cannot be detected reliably and are not masked.
 */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const CNPJ = /(?<!\d)\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}(?!\d)/g;
const CPF = /(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/g;
const PHONE = /(?:\+\s?55[\s-]?)?(?<![\d+])(?:\(\d{2}\)\s?9?\d{4}[\s-]?\d{4}|\d{2}[\s-]9?\d{4}[\s-]\d{4}|9?\d{4}-\d{4})(?!\d)/g;
const DIGITS = /\d{6,}/g;

export function maskPersonalData(text: string): string {
  return (text || '')
    .replace(EMAIL, '[e-mail]')
    .replace(CNPJ, '[CNPJ]')
    .replace(CPF, '[CPF]')
    .replace(PHONE, '[telefone]')
    .replace(DIGITS, '[número]');
}
