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
// Variant cache — fetches full catalog once, refreshes every 5 minutes
// --------------------------------------------------------------------------
let variantCache: any[] = [];
let variantCacheExpiry = 0;
const VARIANT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getAllVariants(): Promise<any[]> {
  if (Date.now() < variantCacheExpiry && variantCache.length > 0) {
    return variantCache;
  }

  const allVariants: any[] = [];
  let page = 1;

  while (true) {
    const response = await katana('GET', `/variants?page=${page}&per_page=50`);
    const batch = response.data ?? response;

    if (!Array.isArray(batch) || batch.length === 0) break;

    allVariants.push(...batch);

    if (batch.length < 50) break;

    page++;
  }

  variantCache = allVariants;
  variantCacheExpiry = Date.now() + VARIANT_CACHE_TTL_MS;

  return variantCache;
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
    name: 'list_materials',
    description:
      'List Katana materials (e.g. CONCRETE001, raw inputs used in manufacturing). ' +
      'Pass search to filter by SKU or name. Note: materials also have variant_id values ' +
      'which are needed when adding them as line items on a sales order.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Filter by SKU or name (case-insensitive)' },
      },
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
            required: ['variant_id', 'quantity', 'price_per_unit'],
            properties: {
              variant_id: { type: 'number' },
              quantity:   { type: 'number' },
              price_per_unit: { type: 'number' },
            },
          },
        },
      },
    },
  },
  {
    name: 'update_sales_order',
    description:
      'Update an existing Katana sales order. Use to set order_created_date, delivery_date, ' +
      'order_no, customer_id, status, or additional_info. Only provided fields are changed.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id:                 { type: 'number', description: 'Katana sales order ID' },
        order_created_date: { type: 'string', description: 'ISO 8601 date-time e.g. 2026-03-14T00:00:00.000Z' },
        delivery_date:      { type: 'string', description: 'ISO 8601 date-time e.g. 2026-03-14T00:00:00.000Z' },
        order_no:           { type: 'string', description: 'Order reference number' },
        customer_id:        { type: 'number', description: 'Katana customer ID' },
        status:             { type: 'string', enum: ['NOT_SHIPPED', 'PENDING', 'PACKED', 'DELIVERED'] },
        additional_info:    { type: 'string' },
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
      const allCustomers: any[] = [];
      let page = 1;

    while (true) {
      const response = await katana('GET', `/customers?page=${page}&per_page=50`);
      const batch = response.data ?? response;

      if (!Array.isArray(batch) || batch.length === 0) break;

      allCustomers.push(...batch);

      // If we got fewer than a full page, we've reached the end
      if (batch.length < 50) break;

      page++;
    }

    const customers = args.search
      ? allCustomers.filter(
          (c: any) =>
            c.name?.toLowerCase().includes(args.search.toLowerCase()) ||
            c.email?.toLowerCase().includes(args.search.toLowerCase())
        )
      : allCustomers;

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
      const allVariants = await getAllVariants();

      const variants = args.search
        ? allVariants.filter(
            (v: any) =>
              v.sku?.toLowerCase().includes(args.search.toLowerCase()) ||
              v.name?.toLowerCase().includes(args.search.toLowerCase())
          )
        : allVariants;

      return JSON.stringify(variants, null, 2);
    }
    case 'list_materials': {
      const response = await katana('GET', '/materials');
      let materials = response.data ?? response;
      if (args.search) {
        const q = args.search.toLowerCase();
        materials = materials.filter(
          (m: any) =>
            m.sku?.toLowerCase().includes(q) ||
            m.name?.toLowerCase().includes(q) ||
            m.internal_id?.toLowerCase().includes(q)
        );
       }
       return JSON.stringify(materials, null, 2);
    }
    case 'create_sales_order': {
      const order = await katana('POST', '/sales_orders', {
        customer_id:   args.customer_id,
        ...(args.order_no      && { order_no:      args.order_no }),
        ...(args.delivery_date && { delivery_date: args.delivery_date }),
        sales_order_rows: args.line_items.map((item: any) => ({
          variant_id: item.variant_id,
          quantity:   item.quantity,
          price_per_unit: item.price_per_unit,
        })),
      });
      return JSON.stringify(order, null, 2);
    }
    case 'update_sales_order': {
      const { id, ...fields } = args;
      const payload: Record<string, any> = {};
      if (fields.order_created_date !== undefined) payload.order_created_date = fields.order_created_date;
      if (fields.delivery_date      !== undefined) payload.delivery_date      = fields.delivery_date;
      if (fields.order_no           !== undefined) payload.order_no           = fields.order_no;
      if (fields.customer_id        !== undefined) payload.customer_id        = fields.customer_id;
      if (fields.status             !== undefined) payload.status             = fields.status;
      if (fields.additional_info    !== undefined) payload.additional_info    = fields.additional_info;
      return JSON.stringify(await katana('PATCH', `/sales_orders/${id}`, payload), null, 2);
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
