// Scriptable Fake OpenAI-compatible HTTP Provider for Unit Tests
import http from 'node:http';

export function createFakeProvider(port = 0) {
  let mode = 'normal';
  let modeOptions = {};
  let requestLog = [];
  let rateLimitSeen = 0;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept'
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });

    req.on('end', async () => {
      requestLog.push({
        method: req.method,
        url: req.url,
        pathname,
        headers: req.headers,
        body,
        timestamp: Date.now()
      });

      // Handle hang mode
      if (mode === 'hang') {
        // Do not respond; keep socket open
        return;
      }

      // Handle delay mode
      if (mode === 'delay') {
        const delayMs = modeOptions.delayMs || 300;
        await new Promise((r) => setTimeout(r, delayMs));
      }

      // Handle /v1/models endpoint
      if (pathname.endsWith('/models') && req.method === 'GET') {
        if (mode === 'http_error') {
          const status = modeOptions.statusCode || 500;
          res.writeHead(status, { ...corsHeaders, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Injected HTTP ${status}` } }));
          return;
        }

        if (mode === 'rate_limit') {
          res.writeHead(429, {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Retry-After': String(modeOptions.retryAfter || '1')
          });
          res.end(JSON.stringify({ error: { message: 'Rate limited', code: 429 } }));
          return;
        }

        if (mode === 'models_empty') {
          res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ object: 'list', data: [] }));
          return;
        }

        if (mode === 'models_bad_schema') {
          res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ somethingElse: 123 }));
          return;
        }

        if (mode === 'bad_json') {
          res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
          res.end('NOT_A_VALID_JSON');
          return;
        }

        // Normal models response
        res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          object: 'list',
          data: [
            { id: 'ag/gemini-3.1-pro-low', object: 'model' },
            { id: 'do/deepseek-v4.1-flash', object: 'model' }
          ]
        }));
        return;
      }

      // Handle /v1/chat/completions endpoint
      if (pathname.endsWith('/chat/completions') && req.method === 'POST') {
        if (mode === 'http_error') {
          const status = modeOptions.statusCode || 500;
          res.writeHead(status, { ...corsHeaders, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Injected HTTP ${status}` } }));
          return;
        }

        if (mode === 'rate_limit') {
          rateLimitSeen++;
          const maxRateLimits = modeOptions.rateLimitCount ?? Infinity;
          if (rateLimitSeen <= maxRateLimits) {
            res.writeHead(429, {
              ...corsHeaders,
              'Content-Type': 'application/json',
              'Retry-After': String(modeOptions.retryAfter || '1')
            });
            res.end(JSON.stringify({ error: { message: 'Rate limit exceeded', code: 429 } }));
            return;
          }
          // After maxRateLimits, fallback to normal
        }

        if (mode === 'http_500_twice') {
          if (!modeOptions.count) modeOptions.count = 0;
          modeOptions.count++;
          if (modeOptions.count <= 2) {
            res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Internal Server Error' } }));
            return;
          }
          // On 3rd call, fall through to normal
        }

        if (mode === 'timeout_once') {
          if (!modeOptions.count) modeOptions.count = 0;
          modeOptions.count++;
          if (modeOptions.count === 1) {
            // Delay past typical test timeout
            await new Promise((r) => setTimeout(r, modeOptions.delayMs || 300));
            res.writeHead(504, corsHeaders);
            res.end(JSON.stringify({ error: { message: 'Gateway Timeout' } }));
            return;
          }
          // On 2nd call, fall through to normal
        }

        if (mode === 'bad_json') {
          res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
          res.end('NOT_VALID_OUTER_JSON');
          return;
        }

        if (mode === 'oversized') {
          const hugePadding = 'A'.repeat(70000);
          res.writeHead(200, {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Content-Length': String(hugePadding.length)
          });
          res.end(hugePadding);
          return;
        }

        // Parse items from user message
        let payload = {};
        let items = [];
        try {
          payload = JSON.parse(body);
          const userMsg = (payload.messages || []).find((m) => m.role === 'user');
          if (userMsg && userMsg.content) {
            items = JSON.parse(userMsg.content);
          }
        } catch {}

        if (mode === 'missing_results_field') {
          res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chatcmpl-test',
            model: payload.model,
            choices: [{ message: { role: 'assistant', content: JSON.stringify({ notResults: [] }) } }]
          }));
          return;
        }

        if (mode === 'bad_inner_json') {
          res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chatcmpl-test',
            model: payload.model,
            choices: [{ message: { role: 'assistant', content: 'BAD_INNER_JSON' } }]
          }));
          return;
        }

        let results = items.map((it) => ({
          id: it.id,
          revision: it.revision,
          text: `[translated] ${it.text}`
        }));

        if (mode === 'wrong_length') {
          results = results.slice(0, Math.max(0, results.length - 1));
        } else if (mode === 'missing_id') {
          if (results.length > 0) {
            results[0].id = 'wrong-nonexistent-id';
          }
        } else if (mode === 'extra_id') {
          results.push({ id: 'unexpected-extra-id', revision: 0, text: 'extra' });
        } else if (mode === 'duplicate_id') {
          if (results.length >= 2) {
            results[1].id = results[0].id;
          }
        } else if (mode === 'revision_mismatch') {
          if (results.length > 0) {
            results[0].revision = (results[0].revision || 0) + 1;
          }
        }

        let contentStr = JSON.stringify({ results });
        if (mode === 'fenced_json') {
          contentStr = `\`\`\`json\n${contentStr}\n\`\`\``;
        }

        res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-test-' + Date.now(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: payload.model || 'ag/gemini-3.1-pro-low',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: contentStr
              },
              finish_reason: 'stop'
            }
          ]
        }));
        return;
      }

      res.writeHead(404, corsHeaders);
      res.end(JSON.stringify({ error: { message: 'Not found' } }));
    });
  });

  return {
    server,
    start: () =>
      new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => {
          const addr = server.address();
          resolve({
            port: addr.port,
            baseURL: `http://127.0.0.1:${addr.port}/v1`
          });
        });
      }),
    stop: () =>
      new Promise((resolve) => {
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
        server.close(resolve);
      }),
    setMode: (m, opts = {}) => {
      mode = m;
      modeOptions = opts;
      rateLimitSeen = 0;
    },
    getMode: () => mode,
    clearLog: () => {
      requestLog = [];
    },
    getLog: () => [...requestLog]
  };
}
