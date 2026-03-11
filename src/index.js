/**
 * Basecamp Bridge MCP Server — Cloudflare Worker
 *
 * Endpoints:
 *   GET  /health  — health check
 *   POST /mcp     — MCP JSON-RPC (Claude tool calls)
 *
 * 6 Basecamp tools: projects, todolists, todos, messages
 * Token: fetched at runtime from Supabase api_credential table
 * Version: 1.0.0 | Created: 2026-03-11
 */

const BC_ACCOUNT_ID = '6162345';
const BC_BASE = `https://3.basecampapi.com/${BC_ACCOUNT_ID}`;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

// ── TOOL DEFINITIONS ─────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'bc_get_projects',
    description: 'List all Basecamp projects',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'bc_get_todolists',
    description: 'Get all to-do lists in a Basecamp project',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        todosetId: { type: 'string' }
      },
      required: ['projectId']
    }
  },
  {
    name: 'bc_get_todos',
    description: 'Get to-dos in a Basecamp to-do list',
    inputSchema: {
      type: 'object',
      properties: {
        projectId:  { type: 'string' },
        todolistId: { type: 'string' }
      },
      required: ['projectId', 'todolistId']
    }
  },
  {
    name: 'bc_create_todo',
    description: 'Create a to-do in Basecamp',
    inputSchema: {
      type: 'object',
      properties: {
        projectId:   { type: 'string' },
        todolistId:  { type: 'string' },
        content:     { type: 'string' },
        description: { type: 'string' },
        assigneeIds: { type: 'array', items: { type: 'number' } },
        dueOn:       { type: 'string', description: 'YYYY-MM-DD' }
      },
      required: ['projectId', 'todolistId', 'content']
    }
  },
  {
    name: 'bc_update_todo',
    description: 'Update a Basecamp to-do',
    inputSchema: {
      type: 'object',
      properties: {
        projectId:   { type: 'string' },
        todoId:      { type: 'string' },
        content:     { type: 'string' },
        description: { type: 'string' },
        assigneeIds: { type: 'array', items: { type: 'number' } },
        dueOn:       { type: 'string' },
        completed:   { type: 'boolean' }
      },
      required: ['projectId', 'todoId']
    }
  },
  {
    name: 'bc_create_message',
    description: 'Post a message to a Basecamp project message board',
    inputSchema: {
      type: 'object',
      properties: {
        projectId:      { type: 'string' },
        messageBoardId: { type: 'string' },
        subject:        { type: 'string' },
        content:        { type: 'string' },
        status:         { type: 'string', enum: ['active', 'draft'] }
      },
      required: ['projectId', 'subject', 'content']
    }
  }
];

// ── HELPERS ───────────────────────────────────────────────────────────────────
async function getBasecampToken(env) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/api_credential?credential_key=eq.access_token&service=eq.basecamp&select=credential_value`,
    { headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` } }
  );
  const [cred] = await res.json();
  if (!cred) throw new Error('Basecamp token not found in api_credential');
  return typeof cred.credential_value === 'string'
    ? cred.credential_value
    : cred.credential_value?.access_token || cred.credential_value?.token;
}

async function bcRequest(env, method, path, body) {
  const token = await getBasecampToken(env);
  const res = await fetch(`${BC_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'User-Agent':    'CreativePartnerOS (chad@creativepartnersolutions.com)'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Basecamp ${method} ${path} → ${res.status}: ${err}`);
  }
  return method === 'DELETE' ? { ok: true } : res.json();
}

// ── TOOL EXECUTOR ─────────────────────────────────────────────────────────────
async function executeTool(name, args, env) {
  switch (name) {
    case 'bc_get_projects':
      return bcRequest(env, 'GET', '/projects.json');
    case 'bc_get_todolists': {
      if (!args.todosetId) {
        const project = await bcRequest(env, 'GET', `/projects/${args.projectId}.json`);
        const todoset = project.dock?.find(d => d.name === 'todoset');
        if (!todoset) throw new Error('No todoset found in project');
        const ts = await bcRequest(env, 'GET', `/buckets/${args.projectId}/todosets/${todoset.id}.json`);
        return bcRequest(env, 'GET', `/buckets/${args.projectId}/todosets/${ts.id}/todolists.json`);
      }
      return bcRequest(env, 'GET', `/buckets/${args.projectId}/todosets/${args.todosetId}/todolists.json`);
    }
    case 'bc_get_todos':
      return bcRequest(env, 'GET', `/buckets/${args.projectId}/todolists/${args.todolistId}/todos.json`);
    case 'bc_create_todo':
      return bcRequest(env, 'POST', `/buckets/${args.projectId}/todolists/${args.todolistId}/todos.json`, {
        content: args.content, description: args.description,
        assignee_ids: args.assigneeIds, due_on: args.dueOn
      });
    case 'bc_update_todo':
      return bcRequest(env, 'PUT', `/buckets/${args.projectId}/todos/${args.todoId}.json`, {
        content: args.content, description: args.description,
        assignee_ids: args.assigneeIds, due_on: args.dueOn, completed: args.completed
      });
    case 'bc_create_message': {
      if (!args.messageBoardId) {
        const project = await bcRequest(env, 'GET', `/projects/${args.projectId}.json`);
        const mb = project.dock?.find(d => d.name === 'message_board');
        if (!mb) throw new Error('No message board found');
        args.messageBoardId = mb.id;
      }
      return bcRequest(env, 'POST', `/buckets/${args.projectId}/message_boards/${args.messageBoardId}/messages.json`, {
        subject: args.subject, content: args.content, status: args.status || 'active'
      });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP JSON-RPC HANDLER ──────────────────────────────────────────────────────
async function handleMCP(req, env) {
  const body = await req.json();
  const { id, method, params } = body;

  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'basecamp-bridge', version: '1.0.0' }
    }};
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    try {
      const result = await executeTool(name, args || {}, env);
      return {
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      };
    } catch (err) {
      return {
        jsonrpc: '2.0', id,
        error: { code: -32603, message: err.message }
      };
    }
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

// ── MAIN FETCH HANDLER ────────────────────────────────────────────────────────
export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        service: 'basecamp-bridge',
        version: '1.0.0',
        tools: TOOLS.length,
        timestamp: new Date().toISOString()
      }), { headers: CORS });
    }

    if (url.pathname === '/mcp' && req.method === 'POST') {
      const result = await handleMCP(req, env);
      return new Response(JSON.stringify(result), { headers: CORS });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: CORS });
  }
};
