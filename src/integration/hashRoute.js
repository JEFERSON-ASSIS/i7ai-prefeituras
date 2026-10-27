// Hash routes look like "#/chat" or "#/chat?c=<conversation uuid>" (deep link from the SGDM assistant).
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseHashRoute(hash = '') {
  const rest = String(hash).replace(/^#\/?/, '');
  const cut = rest.search(/[?/]/);
  const page = cut === -1 ? rest : rest.slice(0, cut);
  const query = cut !== -1 && rest[cut] === '?' ? rest.slice(cut + 1) : '';
  const id = new URLSearchParams(query).get('c');
  return { page, conversationId: page === 'chat' && id && uuidPattern.test(id) ? id : '' };
}
