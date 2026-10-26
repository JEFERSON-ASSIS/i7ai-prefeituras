// Local stand-in for the production routing (Traefik): SGDM and i7Ai on one origin,
// so the i7Ai page at /i7ai/ shares the SGDM browser session (localStorage 'sgdm-auth').
//   http://localhost:3000/            -> SGDM web (Next.js dev, port 3002)
//   http://localhost:3000/i7ai/api/*  -> i7Ai API (port 3010, prefix stripped)
//   http://localhost:3000/i7ai/*      -> i7Ai frontend (Vite with base /i7ai/, port 5173)
// Port 3000 is kept because the SGDM API only accepts CORS from http://localhost:3000.
// Development only: binds to 127.0.0.1 and adds no authentication of its own.
const http = require('node:http');
const net = require('node:net');

const PORT = Number(process.env.PROXY_PORT || 3000);
const SGDM_WEB = Number(process.env.SGDM_WEB_PORT || 3002);
const I7AI_API = Number(process.env.I7AI_API_PORT || 3010);
const I7AI_WEB = Number(process.env.I7AI_WEB_PORT || 5173);

function target(url) {
  if (url.startsWith('/i7ai/api/') || url === '/i7ai/api') return { port: I7AI_API, path: url.slice('/i7ai'.length) };
  if (url.startsWith('/i7ai')) return { port: I7AI_WEB, path: url };
  return { port: SGDM_WEB, path: url };
}

const server = http.createServer((request, response) => {
  const { port, path } = target(request.url || '/');
  const upstream = http.request({ host: '127.0.0.1', port, path, method: request.method, headers: { ...request.headers, 'x-forwarded-for': request.socket.remoteAddress, 'x-forwarded-proto': 'http' } }, reply => {
    response.writeHead(reply.statusCode || 502, reply.headers);
    reply.pipe(response);
  });
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Serviço local indisponível na porta ' + port + '.');
  });
  request.pipe(upstream);
});

// Hot reload of Vite and Next.js uses WebSockets.
server.on('upgrade', (request, socket, head) => {
  const { port, path } = target(request.url || '/');
  const upstream = net.connect(port, '127.0.0.1', () => {
    const headers = Object.entries(request.headers).map(([key, value]) => key + ': ' + value).join('\r\n');
    upstream.write(request.method + ' ' + path + ' HTTP/1.1\r\n' + headers + '\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Proxy local: http://localhost:${PORT}/ (SGDM) e http://localhost:${PORT}/i7ai/ (i7Ai)`);
});
