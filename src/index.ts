import express from 'express';
import { randomBytes } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// --------------------------------------------------------------------------
// Environment
// --------------------------------------------------------------------------
const KATANA_BASE = 'https://api.katanamrp.com/v1';
const API_KEY     = process.env.KATANA_API_KEY;
const MCP_SECRET  = process.env.MCP_SECRET;

if (!API_KEY)    { console.error('ERROR: KATANA_API_KEY not set'); process.exit(1); }
if (!MCP_SECRET) { console.error('ERROR: MCP_SECRET not set');     process.exit(1); }

// --------------------------------------------------------------------------
// CORS
// --------------------------------------------------------------------------
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin',  '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
function baseUrl(req: express.Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol;
  return `${proto}://${req.headers.host}`;
}

// --------------------------------------------------------------------------
// OAuth 2.1 — minimal implementation for a private single-user server
// --------------------------------------------------------------------------
const pendingCodes = new Map<string, { redirect_uri: string; expires: number }>();

app.get('/.well-known/oauth-protected-resource', (req, res) => {
  const base = baseUrl(req);
  res.json({
    resource:              `${base}/mcp`,
    authorization_servers: [base],
  });
});

app.get('/.well-known/oauth-authorization-server', (req, res) => {
  const base = baseUrl(req);
  res.json({
    issuer:                                base,
    authorization_endpoint:               `${base}/authorize`,
    token_endpoint:                        `${base}/token`,
    registration_endpoint:                `${base}/register`,
    response_types_supported:             ['code'],
    grant_types_supported:                ['authorization_code'],
    code_challenge_methods_supported:     ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  });
});

app.get('/authorize', (req, res) => {
  const { redirect_uri, state } = req.query as Record<string, string>;
  if (!redirect_uri) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri required' });
  }
  const code = randomBytes(32).toString('hex');
  pendingCodes.set(code, { redirect_uri, expires: Date.now() + 60_000 });
  const url = new URL(redirect_uri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  res.redirect(url.toString());
});

app.post('/token', (req, res) => {
  const { grant_type, code } = req.body as Record<string, string>;
  if (grant_type !== 'authorization_code') {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }
  const pending = pendingCodes.get(code);
  if (!pending || Date.now() > pending.expires) {
    pendingCodes.delete(code);
    return res.status(400).json({ error: 'invalid_grant' });
  }
  pendingCodes.delete(code);
  res.json({ access_token: MCP_SECRET, token_type: 'bearer', expires_in: 31_536_000 });
});

app.post('/register', (req, res) => {
  // Accept any client registration and return a static client_id.
  // We don't track clients — this is a private single-user server.
  res.status(201).json({
    client_id:                'cowork-client',
    client_id_issued_at:      Math.floor(Date.now() / 1000),
    token_endpoint_auth_method: 'none',
    grant_types:              ['authorization_code'],
    response_types:           ['code'],
    redirect_uris:            req.body?.redirect_uris ?? [],
  });
});

// --------------------------------------------------------------------------
// Bearer token middleware
// --------------------------------------------------------------------------
function requireBearer(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (req.headers.authorization === `Bearer ${MCP_SECRET}`) return next();
  const base = baseUrl(req);
  res.set(
    'WWW-Authenticate',
    `Bearer realm="${base}", resource_metadata="${base}/.well-known/oauth-protected-resource"`
  );
  res.status(401).json({ error: 'unauthorized' });
}

// --------------------------------------------------------------------------
// Katana API helper
// --------------------------------------------------------------------------
async function katana(method: string, path: string, body?: object) {
  const res = await fetch(`${KATANA_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Katana ${method} ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

// --------------------------------------------------------------------------
// MCP tool definitions
// --------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'list_customers',
    description: 'List Katana customers. Pass search to filter by name or email.',
    inputSchema: {
      type: 'object',
      properties: { search: { type: 'string', description: 'Filter by name or email (case-insensitive)' } },
    },
  },
  {
    name: 'create_customer',
    description: 'Create a new customer in Katana.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name:  { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
      },
    },
  },
  {
    name: 'list_variants',
    description: 'List Katana product variants. Pass search to filter by SKU or product name.',
    inputSchema: {
      type: 'object',
      properties: { search: { type: 'string', description: 'Filter by SKU or name (case-insensitive)' } },
    },
  },
  {
    name: 'create_sales_order',
    description:
      'Create a Katana sales order with line items. ' +
      'Requires customer_id (from list_customers or create_customer) ' +
      'and variant_id for each line item (from list_variants).',
    inputSchema: {
      type: 'object',
      required: ['customer_id', 'line_items'],
      properties: {
        customer_id:   { type: 'number', description: 'Katana customer ID' },
        order_no:      { type: 'string', description: 'Optional order reference number' },
        delivery_date: { type: 'string', description: 'ISO date e.g. 2026-06-15' },
        line_items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['variant_id', 'quantity', 'unit_price'],
            properties: {
              variant_id: { type: 'number' },
              quantity:   { type: 'number' },
              unit_price: { type: 'number' },
            },
          },
        },
      },
    },
  },
];

// --------------------------------------------------------------------------
// Tool handlers
// --------------------------------------------------------------------------
async function callTool(name: string, args: Record<string, any>): Promise<string> {
  switch (name) {
    case 'list_customers': {
      const response = await katana('GET', '/customers');
      let customers = response.data ?? response;
      if (args.search) {
        const q = args.search.toLowerCase();
        customers = customers.filter(
          (c: any) => c.name?.toLowerCase().includes(q) || c.email?.toLowerCase().includes(q)
        );
      }
      return JSON.stringify(customers, null, 2);
    }
    case 'create_customer': {
      return JSON.stringify(
        await katana('POST', '/customers', {
          name:  args.name,
          ...(args.email && { email: args.email }),
          ...(args.phone && { phone: args.phone }),
        }),
        null, 2
      );
    }
    case 'list_variants': {
      const response = await katana('GET', '/variants');
      let variants = response.data ?? response;
      if (args.search) {
        const q = args.search.toLowerCase();
        variants = variants.filter(
          (v: any) => v.sku?.toLowerCase().includes(q) || v.name?.toLowerCase().includes(q)
        );
      }
      return JSON.stringify(variants, null, 2);
    }
    case 'create_sales_order': {
      const order = await katana('POST', '/sales_orders', {
        customer_id:   args.customer_id,
        ...(args.order_no      && { order_no:      args.order_no }),
        ...(args.delivery_date && { delivery_date: args.delivery_date }),
        sales_order_rows: args.line_items.map((item: any) => ({
          variant_id: item.variant_id,
          quantity:   item.quantity,
          unit_price: item.unit_price,
        })),
      });
      return JSON.stringify(order, null, 2);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// --------------------------------------------------------------------------
// MCP server factory
// --------------------------------------------------------------------------
function createServer() {
  const server = new Server(
    { name: 'katana-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      return { content: [{ type: 'text', text: await callTool(req.params.name, req.params.arguments ?? {}) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  });
  return server;
}

// --------------------------------------------------------------------------
// MCP HTTP endpoint — Streamable HTTP transport
// --------------------------------------------------------------------------
async function handleMcp(req: express.Request, res: express.Response) {
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
}

app.post('/mcp',   requireBearer, handleMcp);
app.get('/mcp',    requireBearer, handleMcp);
app.delete('/mcp', requireBearer, (_req, res) => res.status(200).end());

// --------------------------------------------------------------------------
// Health check
// --------------------------------------------------------------------------
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', service: 'katana-mcp', version: '1.0.0' })
);

// --------------------------------------------------------------------------
// Start
// --------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Katana MCP server running on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});
