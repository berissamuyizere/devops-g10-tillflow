const http = require('node:http');

function createCollector() {
  const resourceSpans = [];

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.startsWith('/v1/traces')) {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (Array.isArray(body.resourceSpans)) resourceSpans.push(...body.resourceSpans);
      } catch {
        // A malformed export must not take the collector down.
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });

  function spans() {
    const out = [];
    for (const rs of resourceSpans) {
      const attrs = {};
      for (const a of rs.resource?.attributes || []) {
        attrs[a.key] = a.value?.stringValue ?? a.value?.intValue ?? a.value?.boolValue;
      }
      for (const ss of rs.scopeSpans || []) {
        for (const span of ss.spans || []) {
          out.push({
            service: attrs['service.name'],
            name: span.name,
            traceId: span.traceId,
            spanId: span.spanId,
            parentSpanId: span.parentSpanId || null,
            kind: span.kind,
            attributes: span.attributes || [],
          });
        }
      }
    }
    return out;
  }

  return {
    server,
    spans,
    reset: () => resourceSpans.splice(0, resourceSpans.length),
    listen: () =>
      new Promise((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve(server.address().port))
      ),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { createCollector };
