// Fake OpenAI-compatible 9router server for smoke testing
import http from 'node:http';
import fs from 'node:fs';

export function createFakeServer(port = 8089) {
  let mode = 'normal'; // 'normal' | 'rate_limit_429' | 'timeout'
  let requestLog = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // Admin endpoints
    if (pathname === '/__admin/set-mode' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          mode = data.mode || 'normal';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, mode }));
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
      return;
    }

    if (pathname === '/__admin/get-log') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ log: requestLog, mode }));
      return;
    }

    // Static fixture serving if requested
    if (pathname === '/fixture.html') {
      try {
        const fixturePath = new URL('./fixture.html', import.meta.url);
        const html = fs.readFileSync(fixturePath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Failed to load fixture.html: ' + err.message);
        return;
      }
    }

    // CORS headers for direct API calls
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept'
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    // Models endpoint: GET {baseURL}/models
    if (pathname.endsWith('/models') && req.method === 'GET') {
      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [
          { id: 'do/deepseek-v4.1-flash', object: 'model' },
          { id: 'ag/gemini-3.1-pro-low', object: 'model' },
          { id: 'ag/gemini-3.8-flash', object: 'model' },
          { id: 'do/glm-5.3-flash', object: 'model' },
          { id: 'gpt-4o-mini', object: 'model' },
          { id: 'claude-3-5-sonnet', object: 'model' }
        ]
      }));
      return;
    }

    // Completions endpoint: POST {baseURL}/chat/completions
    if (pathname.endsWith('/chat/completions') && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requestLog.push({ time: Date.now(), mode, length: body.length });

        if (mode === 'rate_limit_429') {
          res.writeHead(429, {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Retry-After': '1'
          });
          res.end(JSON.stringify({
            error: {
              message: 'Rate limit exceeded: too many requests per minute',
              type: 'rate_limit',
              code: 429
            }
          }));
          return;
        }

        if (mode === 'timeout_first' || mode === 'delay_first_25s') {
          mode = 'normal'; // Switch to normal mode for subsequent retries
          setTimeout(() => {
            try {
              res.writeHead(504, corsHeaders);
              res.end(JSON.stringify({ error: { message: 'Gateway timeout', code: 504 } }));
            } catch {}
          }, 25000);
          return;
        }

        if (mode === 'timeout') {
          // Keep request hanging past 25s
          setTimeout(() => {
            try {
              res.writeHead(504, corsHeaders);
              res.end(JSON.stringify({ error: { message: 'Gateway timeout' } }));
            } catch {}
          }, 25000);
          return;
        }

        function respondNormal() {
          try {
            const payload = JSON.parse(body);
            const messages = payload.messages || [];
            const userMsg = messages.find((m) => m.role === 'user');
            let items = [];
            if (userMsg && userMsg.content) {
              items = JSON.parse(userMsg.content);
            }

            const results = items.map((it) => ({
              id: it.id,
              revision: it.revision,
              text: `[vi] ${it.text}`
            }));

            const responseContent = JSON.stringify({ results });

            res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              id: 'chatcmpl-fake-' + Date.now(),
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: payload.model || 'do/deepseek-v4.1-flash',
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: responseContent
                  },
                  finish_reason: 'stop'
                }
              ]
            }));
          } catch (err) {
            res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Invalid request: ' + err.message } }));
          }
        }

        if (mode === 'hold_6s') {
          setTimeout(respondNormal, 6000);
          return;
        }

        respondNormal();
      });
      return;
    }

    res.writeHead(404, corsHeaders);
    res.end(JSON.stringify({ error: { message: 'Not found' } }));
  });

  return {
    server,
    start: () => new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address()))),
    stop: () => new Promise((resolve) => server.close(resolve)),
    setMode: (m) => { mode = m; },
    getMode: () => mode,
    clearLog: () => { requestLog = []; },
    getLogs: () => [...requestLog],
    getLog: () => [...requestLog]
  };
}

if (process.argv[1] && process.argv[1].endsWith('fake-9router.mjs')) {
  const port = parseInt(process.env.PORT || '8089', 10);
  const fake = createFakeServer(port);
  fake.start().then((addr) => {
    console.log(`Fake 9router listening on http://127.0.0.1:${addr.port}`);
  });
}
