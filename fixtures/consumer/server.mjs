// A tiny loopback "application under test" for the self-tests. No dependencies, no network
// beyond 127.0.0.1. PORT defaults to 18080; WIDGETS=off makes /widgets answer 404 (a "base" build
// that does not have the feature yet).
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 18080);
const widgetsEnabled = process.env.WIDGETS !== 'off';

const server = createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.url === '/api/healthz') return send(200, { status: 'ok' });
  if (req.url === '/api/widgets' && widgetsEnabled) return send(200, [{ id: 1, name: 'sprocket' }]);
  return send(404, { error: 'no route' });
});

server.listen(port, '127.0.0.1', () => console.log(`fixture listening on 127.0.0.1:${port}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
