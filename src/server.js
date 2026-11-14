require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { z } = require('zod');
const { AssemblyAI } = require('assemblyai');
// MCP SDK v2: implements the current revision (2026-07-28, stateless, server/discover)
// and still serves legacy initialize-based clients statelessly.
const { McpServer, createMcpHandler } = require('@modelcontextprotocol/server');
const { toNodeHandler } = require('@modelcontextprotocol/node');
const { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } = require('@modelcontextprotocol/sdk/server/auth/router.js');
const { requireBearerAuth } = require('@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js');

const db = require('./database');
const { createOAuthProvider } = require('./oauth');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const BASE_URL = (
  process.env.BASE_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`)
).replace(/\/+$/, '');
const AUTH_TOKEN = process.env.AUTH_TOKEN; // static owner token (own harness)
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || AUTH_TOKEN; // consent page password
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_MCP_BODY_BYTES = 40 * 1024 * 1024; // base64 uploads inflate ~4/3
const VERSION = '2.1.0';

const MCP_URL = new URL(`${BASE_URL}/mcp`);
const DOCS_URL = new URL(`${BASE_URL}/docs`);
const RESOURCE_METADATA_URL = getOAuthProtectedResourceMetadataUrl(MCP_URL);

const uploadsDir = path.join(db.dataDir, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const assemblyai = ASSEMBLYAI_API_KEY ? new AssemblyAI({ apiKey: ASSEMBLYAI_API_KEY }) : null;

// ---------------------------------------------------------------------------
// Domain logic
// ---------------------------------------------------------------------------
const toNote = (row) => ({
  id: row.id,
  text: row.text,
  created_at: new Date(row.created_at).toISOString(),
  updated_at: new Date(row.updated_at).toISOString()
});

function writeMemo(text) {
  const id = crypto.randomUUID();
  const ts = Date.now();
  db.prepare('INSERT INTO memos (id, text, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, text, ts, ts);
  return { id };
}

function searchMemos(query) {
  const q = (query || '').trim();
  if (!q) {
    // Empty query: newest notes first.
    return db.prepare('SELECT * FROM memos ORDER BY created_at DESC LIMIT 100').all().map(toNote);
  }
  // Quote every term so FTS5 operators/punctuation in user input ("-", ":", "*") never cause syntax errors.
  const terms = q.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"`);
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT m.* FROM memos_fts f JOIN memos m ON m.rowid = f.rowid
      WHERE memos_fts MATCH ? ORDER BY m.created_at DESC LIMIT 100
    `).all(terms.join(' '));
  } catch (_) {
    rows = [];
  }
  if (rows.length === 0) {
    // Substring fallback (FTS tokenizes on word boundaries; codes like "ab12-x" may be split).
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    rows = db.prepare("SELECT * FROM memos WHERE text LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 100").all(like);
  }
  return rows.map(toNote);
}

function safeExtension(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

function storeFile(buffer, filename) {
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error(`File too large (max ${MAX_UPLOAD_BYTES} bytes)`);
  }
  const stored = `${crypto.randomUUID()}${safeExtension(filename)}`;
  fs.writeFileSync(path.join(uploadsDir, stored), buffer);
  return { url: `${BASE_URL}/files/${stored}`, filename: stored, size: buffer.length };
}

async function fetchRemote(url) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('source_url must be http(s)');
  const res = await fetch(parsed, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Fetching source_url failed: HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > MAX_UPLOAD_BYTES) throw new Error('File too large');
  return Buffer.from(await res.arrayBuffer());
}

async function transcribe(url) {
  if (!assemblyai) throw new Error('Transcription is not configured on this server');
  const transcript = await assemblyai.transcripts.transcribe({ audio_url: url });
  if (transcript.status === 'error') throw new Error(transcript.error || 'Transcription failed');

  let segments = [];
  try {
    const { sentences } = await assemblyai.transcripts.sentences(transcript.id);
    segments = (sentences || []).map((s) => ({
      start: s.start / 1000, end: s.end / 1000, text: s.text, confidence: s.confidence
    }));
  } catch (_) {
    segments = [];
  }
  if (segments.length === 0) {
    segments = (transcript.words || []).map((w) => ({
      start: w.start / 1000, end: w.end / 1000, text: w.text, confidence: w.confidence
    }));
  }
  return {
    segments,
    text: transcript.text || '',
    ...(typeof transcript.audio_duration === 'number' ? { duration: transcript.audio_duration } : {}),
    ...(transcript.language_code ? { language: transcript.language_code } : {})
  };
}

// ---------------------------------------------------------------------------
// MCP server (tools declare input + output schemas; results are structuredContent)
// ---------------------------------------------------------------------------
const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
const fail = (err) => ({ content: [{ type: 'text', text: err.message || String(err) }], isError: true });

const noteSchema = z.object({
  id: z.string(),
  text: z.string(),
  created_at: z.string().describe('ISO 8601 timestamp'),
  updated_at: z.string().describe('ISO 8601 timestamp')
});

function buildMcpServer() {
  const server = new McpServer(
    { name: 'mega-devs-mcp-server', version: VERSION },
    { instructions: `Memo storage, file upload and audio transcription. Plan and docs: ${DOCS_URL.href}` }
  );

  server.registerTool('memo_write', {
    title: 'Write memo',
    description: 'Saves a note and returns its id.',
    inputSchema: { text: z.string().min(1).max(100000).describe('The note text to save') },
    outputSchema: { id: z.string().describe('Id of the saved note') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ text }) => {
    try { return ok(writeMemo(text)); } catch (e) { return fail(e); }
  });

  server.registerTool('memo_search', {
    title: 'Search memos',
    description: 'Finds notes by full-text search (all words must match; falls back to substring match). Newest first, max 100. An empty query returns the newest notes.',
    inputSchema: { query: z.string().max(1000).describe('Words to search for') },
    outputSchema: { notes: z.array(noteSchema) },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ query }) => {
    try { return ok({ notes: searchMemos(query) }); } catch (e) { return fail(e); }
  });

  server.registerTool('upload', {
    title: 'Upload file',
    description: 'Puts a file on this server and returns a public link anyone can open. Provide exactly one of content_base64, text or source_url.',
    inputSchema: {
      filename: z.string().max(255).optional().describe('Original file name; its extension is kept (e.g. "clip.mp3")'),
      content_base64: z.string().optional().describe('File bytes, base64-encoded'),
      text: z.string().optional().describe('Plain-text file content (alternative to content_base64)'),
      source_url: z.string().url().optional().describe('Copy the file from this http(s) URL (alternative to content_base64)')
    },
    outputSchema: {
      url: z.string().describe('Public link to the file, served by this server'),
      filename: z.string(),
      size: z.number().int().describe('Size in bytes')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async ({ filename, content_base64, text, source_url }) => {
    try {
      const given = [content_base64, text, source_url].filter((v) => v !== undefined);
      if (given.length !== 1) throw new Error('Provide exactly one of content_base64, text or source_url');
      let buffer;
      let name = filename;
      if (content_base64 !== undefined) {
        buffer = Buffer.from(content_base64, 'base64');
      } else if (text !== undefined) {
        buffer = Buffer.from(text, 'utf8');
        name = name || 'file.txt';
      } else {
        buffer = await fetchRemote(source_url);
        name = name || new URL(source_url).pathname;
      }
      return ok(storeFile(buffer, name));
    } catch (e) { return fail(e); }
  });

  server.registerTool('transcribe', {
    title: 'Transcribe audio',
    description: 'Turns audio at a public URL into timestamped text segments (sentence level, start/end in seconds).',
    inputSchema: { url: z.string().url().describe('Public URL of the audio file') },
    outputSchema: {
      segments: z.array(z.object({
        start: z.number().describe('Start time in seconds'),
        end: z.number().describe('End time in seconds'),
        text: z.string(),
        confidence: z.number().optional()
      })),
      text: z.string().describe('Full transcript'),
      duration: z.number().optional().describe('Audio duration in seconds'),
      language: z.string().optional()
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, async ({ url }) => {
    try { return ok(await transcribe(url)); } catch (e) { return fail(new Error(`Transcription failed: ${e.message}`)); }
  });

  return server;
}

// ---------------------------------------------------------------------------
// HTTP app
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1); // behind Railway / Cloudflare proxy
app.disable('x-powered-by');

const oauthProvider = createOAuthProvider({ ownerPassword: OWNER_PASSWORD, staticToken: AUTH_TOKEN });

// OAuth 2.1 authorization server: /.well-known/oauth-authorization-server, /authorize, /token, /register, /revoke
// and protected resource metadata at /.well-known/oauth-protected-resource/mcp
app.use(mcpAuthRouter({
  provider: oauthProvider,
  issuerUrl: new URL(BASE_URL),
  resourceServerUrl: MCP_URL,
  serviceDocumentationUrl: DOCS_URL,
  resourceName: 'MEGA Devs MCP Server',
  scopesSupported: ['mcp']
}));
app.use(oauthProvider.consentRouter());

// Root-level protected resource metadata as well (some clients probe it first).
app.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.json({
    resource: MCP_URL.href,
    authorization_servers: [new URL(BASE_URL).href],
    scopes_supported: ['mcp'],
    bearer_methods_supported: ['header'],
    resource_name: 'MEGA Devs MCP Server',
    resource_documentation: DOCS_URL.href
  });
});

const bearerAuth = requireBearerAuth({ verifier: oauthProvider, resourceMetadataUrl: RESOURCE_METADATA_URL });

// MCP endpoint. Modern (2026-07-28) requests are served statelessly per request,
// including server/discover; legacy initialize-based requests fall back to the
// SDK's stateless legacy serving (GET/DELETE answer 405).
const mcpHandler = createMcpHandler(() => buildMcpServer(), {
  legacy: 'stateless',
  maxRequestBodySize: MAX_MCP_BODY_BYTES,
  onerror: (err) => console.error('MCP:', err.message)
});
const mcpNodeHandler = toNodeHandler(mcpHandler, {
  maxRequestBodySize: MAX_MCP_BODY_BYTES,
  onerror: (err) => console.error('MCP adapter:', err)
});
app.all('/mcp', bearerAuth, express.json({ limit: MAX_MCP_BODY_BYTES }), (req, res) => mcpNodeHandler(req, res, req.body));

// Plain HTTP upload (multipart), same auth as /mcp.
const multipartUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });
app.post('/upload', bearerAuth, multipartUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: file)' });
  try {
    res.json(storeFile(req.file.buffer, req.file.originalname));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Uploaded files are public by design.
app.use('/files', express.static(uploadsDir, { index: false, dotfiles: 'deny', maxAge: '1h' }));

app.get('/docs', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>MCP Server Plan</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 820px; margin: 40px auto; padding: 0 16px; line-height: 1.5; color: #222; }
  code, pre { background: #f4f4f4; border-radius: 4px; }
  code { padding: 1px 5px; } pre { padding: 12px; overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; } td, th { border: 1px solid #ddd; padding: 6px 8px; text-align: left; vertical-align: top; }
</style></head><body>
<h1>MEGA Devs MCP Server: plan</h1>
<p>A remote MCP server with four tools: memos, file upload and audio transcription.
MCP endpoint: <code>${MCP_URL.href}</code> (Streamable HTTP, JSON-RPC 2.0, current MCP revision 2026-07-28: stateless, <code>server/discover</code>, per-request <code>_meta</code>; legacy clients using the <code>initialize</code> handshake (2025-11-25 and earlier) are still served).</p>

<h2>What the tools do</h2>
<table>
<tr><th>Tool</th><th>Input</th><th>Result (structuredContent)</th></tr>
<tr><td><code>memo_write</code></td><td><code>{ text }</code></td><td><code>{ id }</code>: saves a note.</td></tr>
<tr><td><code>memo_search</code></td><td><code>{ query }</code></td><td><code>{ notes: [{ id, text, created_at, updated_at }] }</code>: full-text search, all words must match, newest first, max 100. Empty query returns the newest notes.</td></tr>
<tr><td><code>upload</code></td><td><code>{ filename?, content_base64 | text | source_url }</code></td><td><code>{ url, filename, size }</code>: stores the file; <code>url</code> is a public link served by this server under <code>/files/</code>.</td></tr>
<tr><td><code>transcribe</code></td><td><code>{ url }</code></td><td><code>{ segments: [{ start, end, text, confidence }], text, duration?, language? }</code>: sentence-level segments, times in seconds (AssemblyAI).</td></tr>
</table>
<p>Every tool declares an <code>outputSchema</code>; results come back as <code>structuredContent</code> matching it, plus the same JSON as text content. Errors come back as <code>isError: true</code>.</p>

<h2>How sign-in works</h2>
<ul>
<li>Every request to <code>/mcp</code> and <code>/upload</code> needs <code>Authorization: Bearer &lt;token&gt;</code>. Without it the server answers 401 with
<code>WWW-Authenticate: Bearer resource_metadata="${RESOURCE_METADATA_URL}"</code>.</li>
<li>Protected resource metadata (RFC 9728): <code>${RESOURCE_METADATA_URL}</code>. It names this server as the authorization server and this page as <code>resource_documentation</code>.</li>
<li>Authorization server metadata (RFC 8414): <code>${BASE_URL}/.well-known/oauth-authorization-server</code>.</li>
<li>OAuth 2.1: clients register with dynamic client registration (<code>/register</code>), then use the authorization code flow with PKCE S256 (<code>/authorize</code>, <code>/token</code>). Refresh tokens rotate; tokens can be revoked at <code>/revoke</code>.</li>
<li>Only people the owner lets in can use it: <code>/authorize</code> shows a consent page, and access is granted only after the owner enters the owner password and approves.</li>
<li>Access tokens last 1 hour, refresh tokens 30 days. The owner can also use a static owner token from their own harness.</li>
</ul>

<h2>What data it keeps</h2>
<ul>
<li><strong>Notes</strong>: text and created/updated timestamps, in SQLite with a full-text index. Kept until deleted by the owner.</li>
<li><strong>Uploaded files</strong>: stored on the server disk under a random name; anyone with the link can open them.</li>
<li><strong>OAuth data</strong>: registered client metadata (name, redirect URIs), and SHA-256 hashes of authorization codes and tokens with their expiry. Expired entries are purged.</li>
<li><strong>Transcription</strong>: the audio URL is sent to AssemblyAI for processing; the transcript is returned and not stored here.</li>
<li>No analytics, no cookies, no request bodies in logs.</li>
</ul>

<h2>Health</h2>
<p><code>GET ${BASE_URL}/health</code></p>
</body></html>`);
});

app.get('/health', (req, res) => res.json({ status: 'ok', version: VERSION }));
app.get('/', (req, res) => res.redirect('/docs'));

app.listen(PORT, () => {
  console.log(`MCP Server v${VERSION} on ${BASE_URL} (port ${PORT})`);
  console.log(`MCP endpoint: ${MCP_URL.href}`);
  console.log(`Data dir: ${db.dataDir}`);
  console.log(`Owner token: ${AUTH_TOKEN ? 'configured' : 'NOT configured'}; transcription: ${assemblyai ? 'configured' : 'NOT configured'}`);
});

module.exports = app;
