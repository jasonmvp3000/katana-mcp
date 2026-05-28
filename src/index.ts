import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const app = express();
app.use(express.json());

const KATANA_BASE = 'https://api.katanamrp.com/v1';
const API_KEY = process.env.KATANA_API_KEY;

if (!API_KEY) {
  console.error('ERROR: KATANA_API_KEY environment variable is not set.');
  process.exit(1);
}

// --------------------------------------------------------------------------
// Katana API helper
// --------------------------------------------------------------------------
async function katana(method: string, path: string, body?: object) {
  const res = await fetch(`${KATANA_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Katana API ${method} ${path} failed (${res.status}): ${text}`);
  }

  return res.json();
}

// --------------------------------------------------------------------------
// Tool definitions
// --------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'list_customers',
    description:
      'List customers in Katana. Pass an optional search string to filter by name or email.',
    inputSchema: {
      type: 'object',
      properties: {
        search: {
          type: 'string',
          description: 'Filter customers by name or email (case-insensitive)',
        },
      },
    },
  },
  {
    name: 'create_customer',
    description: 'Create a new customer in Katana.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Customer full name or company name' },
        email: { type: 'string', description: 'Customer email address' },
        phone: { type: 'string', description: 'Customer phone number' },
      },
    },
  },
  {
    name: 'list_variants',
    description:
      'List product variants in Katana. Pass an optional search string to filter by SKU or product name.',
    inputSchema: {
      type: 'object',
      properties: {
        search: {
          type: 'string',
          description: 'Filter variants by SKU or product name (case-insensitive)',
        },
      },
    },
  },
  {
    name: 'create_sales_order',
    description:
      'Create a new sales order in Katana with line items. ' +
      'Requires a valid customer_id (from list_customers or create_customer) ' +
      'and variant_id values (from list_variants) for each line item.',
    inputSchema: {
      type: 'object',
      required: ['customer_id', 'line_items'],
      properties: {
        customer_id: {
          type: 'number',
          description: 'Katana customer ID',
        },
        order_no: {
          type: 'string',
          description: 'Optional order reference number (e.g. matching JobNimbus invoice number)',
        },
        delivery_date: {
          type: 'string',
          description: 'Optional delivery date in ISO format (e.g. 2026-06-15)',
        },
        line_items: {
          type: 'array',
          description: 'One entry per product line item',
          items: {
            type: 'object',
            required: ['variant_id', 'quantity', 'unit_price'],
            properties: {
              variant_id: { type: 'number', description: 'Katana product variant ID' },
              quantity: { type: 'number', description: 'Quantity ordered' },
              unit_price: { type: 'number', description: 'Unit price in dollars' },
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
          (c: any) =>
            c.name?.toLowerCase().includes(q) ||
            c.email?.toLowerCase().includes(q)
        );
      }

      return JSON.stringify(customers, null, 2);
    }

    case 'create_customer': {
      const customer = await katana('POST', '/customers', {
        name: args.name,
        ...(args.email && { email: args.email }),
        ...(args.phone && { phone: args.phone }),
      });
      return JSON.stringify(customer, null, 2);
    }

    case 'list_variants': {
      const response = await katana('GET', '/variants');
      let variants = response.data ?? response;

      if (args.search) {
        const q = args.search.toLowerCase();
        variants = variants.filter(
          (v: any) =>
            v.sku?.toLowerCase().includes(q) ||
            v.name?.toLowerCase().includes(q)
        );
      }

      return JSON.stringify(variants, null, 2);
    }

    case 'create_sales_order': {
      // Step 1 — Create the order header
      const order = await katana('POST', '/sales_orders', {
        customer_id: args.customer_id,
        ...(args.order_no && { order_no: args.order_no }),
        ...(args.delivery_date && { delivery_date: args.delivery_date }),
      });

      // Step 2 — Add line items sequentially
      const rows: object[] = [];
      for (const item of args.line_items as Array<{
        variant_id: number;
        quantity: number;
        unit_price: number;
      }>) {
        const row = await katana('POST', '/sales_order_rows', {
          sales_order_id: order.id,
          variant_id: item.variant_id,
          quantity: item.quantity,
          unit_price: item.unit_price,
        });
        rows.push(row);
      }

      return JSON.stringify({ order, rows }, null, 2);
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
      const result = await callTool(req.params.name, req.params.arguments ?? {});
      return { content: [{ type: 'text', text: result }] };
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// --------------------------------------------------------------------------
// HTTP / SSE transport
// --------------------------------------------------------------------------
const transports: Record<string, SSEServerTransport> = {};

// Client connects here — opens the SSE stream
app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  transports[transport.sessionId] = transport;

  res.on('close', () => {
    delete transports[transport.sessionId];
  });

  const server = createServer();
  await server.connect(transport);
});

// Client sends MCP messages here
app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports[sessionId];

  if (!transport) {
    return res.status(404).json({ error: 'Session not found. Connect to /sse first.' });
  }

  await transport.handlePostMessage(req, res);
});

// Health check — Render uses this to verify the service is up
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'katana-mcp', version: '1.0.0' });
});

// --------------------------------------------------------------------------
// Start
// --------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Katana MCP server running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`SSE:    http://localhost:${PORT}/sse`);
});
