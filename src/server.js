const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('./database');
const fs = require('fs');
const path = require('path');
const { AssemblyAI } = require('assemblyai');
const multer = require('multer');

require('dotenv').config();

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;

// Initialize AssemblyAI client
const assemblyai = new AssemblyAI({
  apiKey: ASSEMBLYAI_API_KEY
});

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });

// Create Express app
const app = express();
app.use(express.json());

// Authentication middleware
function authenticate(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!AUTH_TOKEN || token === AUTH_TOKEN) {
    next();
  } else {
    res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource/mcp"`);
    res.status(401).json({ error: 'Unauthorized' });
  }
}

// MCP JSON-RPC handler
async function handleMCPRequest(request) {
  const { method, params } = request;

  if (method === 'tools/list') {
    return {
      tools: [
        {
          name: 'memo_write',
          description: 'Saves a note',
          inputSchema: {
            type: 'object',
            properties: {
              text: {
                type: 'string',
                description: 'The note text to save'
              }
            },
            required: ['text']
          }
        },
        {
          name: 'memo_search',
          description: 'Finds notes using full-text search',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query'
              }
            },
            required: ['query']
          }
        },
        {
          name: 'upload',
          description: 'Puts a file on the server and returns a public URL',
          inputSchema: {
            type: 'object',
            properties: {},
            description: 'Use HTTP POST /upload endpoint with multipart/form-data'
          }
        },
        {
          name: 'transcribe',
          description: 'Converts audio at a URL into timestamped text',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'URL of the audio file to transcribe'
              }
            },
            required: ['url']
          }
        }
      ]
    };
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params;

    if (name === 'memo_write') {
      const { text } = args;
      if (!text) {
        throw new Error('text is required');
      }

      const id = uuidv4();
      const now = Date.now();

      const stmt = db.prepare('INSERT INTO memos (id, text, created_at, updated_at) VALUES (?, ?, ?, ?)');
      stmt.run(id, text, now, now);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ id })
          }
        ]
      };
    }

    if (name === 'memo_search') {
      const { query } = args;
      if (!query) {
        throw new Error('query is required');
      }

      const stmt = db.prepare(`
        SELECT m.id, m.text, m.created_at, m.updated_at
        FROM memos_fts fts
        JOIN memos m ON m.id = fts.id
        WHERE memos_fts MATCH ?
        ORDER BY m.created_at DESC
        LIMIT 100
      `);
      const notes = stmt.all(query);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ notes })
          }
        ]
      };
    }

    if (name === 'upload') {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'Use HTTP POST /upload endpoint to upload files',
              endpoint: `${BASE_URL}/upload`
            })
          }
        ]
      };
    }

    if (name === 'transcribe') {
      const { url } = args;
      if (!url) {
        throw new Error('url is required');
      }

      try {
        const transcript = await assemblyai.transcripts.transcribe({
          audio_url: url
        });

        if (transcript.status === 'error') {
          throw new Error(transcript.error);
        }

        const segments = (transcript.words || []).map(word => ({
          start: word.start / 1000, // Convert ms to seconds
          end: word.end / 1000,
          text: word.text,
          confidence: word.confidence
        }));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ segments })
            }
          ]
        };
      } catch (error) {
        throw new Error(`Transcription failed: ${error.message}`);
      }
    }

    throw new Error(`Unknown tool: ${name}`);
  }

  if (method === 'resources/list') {
    return {
      resources: [
        {
          uri: `${BASE_URL}/docs`,
          name: 'API Documentation',
          description: 'Documentation for the MCP server tools and authentication',
          mimeType: 'text/html'
        }
      ]
    };
  }

  if (method === 'initialize') {
    return {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
        resources: {}
      },
      serverInfo: {
        name: 'mega-devs-mcp-server',
        version: '1.0.0'
      }
    };
  }

  throw new Error(`Unknown method: ${method}`);
}

// OAuth 2.0 Protected Resource Metadata (RFC 8693)
const resourceMetadata = {
  resource: `${BASE_URL}/mcp`,
  resource_documentation: `${BASE_URL}/docs`,
  authorization_servers: [`${BASE_URL}/oauth`],
  bearer_methods_supported: ['header'],
  resource_signing_alg_values_supported: []
};

// Well-known endpoints for OAuth protected resource metadata
app.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.json(resourceMetadata);
});

app.get('/.well-known/oauth-protected-resource/mcp', (req, res) => {
  res.json(resourceMetadata);
});

// MCP endpoint with OAuth metadata support
app.post('/mcp', authenticate, async (req, res) => {
  try {
    const request = req.body;
    const result = await handleMCPRequest(request);

    res.json({
      jsonrpc: '2.0',
      id: request.id,
      result
    });
  } catch (error) {
    res.json({
      jsonrpc: '2.0',
      id: req.body.id,
      error: {
        code: -32603,
        message: error.message
      }
    });
  }
});

// Add WWW-Authenticate header for unauthenticated requests
app.use('/mcp', (err, req, res, next) => {
  if (res.statusCode === 401) {
    res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource/mcp"`);
  }
  next(err);
});

// Upload endpoint
app.post('/upload', authenticate, upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const url = `${BASE_URL}/files/${req.file.filename}`;
  res.json({ url });
});

// Serve uploaded files
app.use('/files', express.static(uploadsDir));

// Documentation page
app.get('/docs', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>MCP Server Documentation</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 0 20px; }
        h1 { color: #333; }
        h2 { color: #666; margin-top: 30px; }
        code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; }
        pre { background: #f4f4f4; padding: 15px; border-radius: 5px; overflow-x: auto; }
      </style>
    </head>
    <body>
      <h1>MEGA Devs MCP Server</h1>
      <p>A Model Context Protocol server providing memo storage, file upload, and audio transcription capabilities.</p>

      <h2>Available Tools</h2>

      <h3>memo_write</h3>
      <p>Saves a note to the database.</p>
      <pre>Input: { "text": "Your note content" }
Output: { "id": "uuid" }</pre>

      <h3>memo_search</h3>
      <p>Searches notes using full-text search.</p>
      <pre>Input: { "query": "search terms" }
Output: { "notes": [{ "id": "uuid", "text": "content", "created_at": timestamp, "updated_at": timestamp }] }</pre>

      <h3>upload</h3>
      <p>Uploads a file and returns a public URL.</p>
      <pre>Method: POST /upload
Content-Type: multipart/form-data
Authorization: Bearer &lt;token&gt;

Output: { "url": "${BASE_URL}/files/..." }</pre>

      <h3>transcribe</h3>
      <p>Transcribes audio from a URL into timestamped text segments.</p>
      <pre>Input: { "url": "https://..." }
Output: { "segments": [{ "start": seconds, "end": seconds, "text": "...", "confidence": 0.0-1.0 }] }</pre>

      <h2>Authentication</h2>
      <p>All requests require Bearer token authentication via the <code>Authorization</code> header:</p>
      <pre>Authorization: Bearer ${AUTH_TOKEN ? '&lt;your-token&gt;' : 'not-configured'}</pre>

      <h2>Data Storage</h2>
      <p>Notes are stored in a local SQLite database with full-text search indexing. Uploaded files are stored on the server and served via public URLs.</p>

      <h2>MCP Endpoint</h2>
      <p>Connect to this server via: <code>${BASE_URL}/mcp</code></p>
      <p>Protocol: JSON-RPC 2.0 over HTTP POST</p>

      <h2>Example MCP Request</h2>
      <pre>{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}</pre>
    </body>
    </html>
  `);
});

// OAuth Authorization Server Metadata (RFC 8414)
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.json({
    issuer: `${BASE_URL}/oauth`,
    token_endpoint: `${BASE_URL}/oauth/token`,
    response_types_supported: ['token'],
    grant_types_supported: ['client_credentials'],
    token_endpoint_auth_methods_supported: ['none']
  });
});

// OAuth endpoints (minimal implementation)
app.get('/oauth', (req, res) => {
  res.json({
    message: 'OAuth Authorization Server',
    metadata: `${BASE_URL}/.well-known/oauth-authorization-server`
  });
});

app.post('/oauth/token', (req, res) => {
  // Minimal OAuth token endpoint for metadata purposes
  res.status(400).json({
    error: 'unsupported_grant_type',
    error_description: 'Use Bearer token authentication directly'
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// Root endpoint - redirect to docs
app.get('/', (req, res) => {
  res.redirect('/docs');
});

// Start HTTP server
app.listen(PORT, () => {
  console.log(`MCP Server running on ${BASE_URL}`);
  console.log(`Documentation: ${BASE_URL}/docs`);
  console.log(`Auth token: ${AUTH_TOKEN ? 'configured' : 'not configured'}`);
});

module.exports = app;
