// OAuth 2.1 authorization server for this MCP server.
// Dynamic client registration, authorization code + PKCE (validated by the SDK),
// refresh tokens and revocation. The owner approves each client on a consent page
// by entering OWNER_PASSWORD (falls back to AUTH_TOKEN).
const crypto = require('crypto');
const express = require('express');
const db = require('./database');
const { InvalidGrantError, InvalidTokenError } = require('@modelcontextprotocol/sdk/server/auth/errors.js');

const ACCESS_TTL = 60 * 60; // 1 hour
const REFRESH_TTL = 30 * 24 * 60 * 60; // 30 days
const CODE_TTL = 10 * 60; // 10 minutes
const PENDING_TTL = 15 * 60; // consent page validity

const now = () => Math.floor(Date.now() / 1000);
const randomToken = () => crypto.randomBytes(32).toString('base64url');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

function purgeExpired() {
  const t = now();
  db.prepare('DELETE FROM oauth_pending WHERE expires_at < ?').run(t);
  db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').run(t);
  db.prepare('DELETE FROM oauth_tokens WHERE expires_at < ?').run(t);
}

const clientsStore = {
  getClient(clientId) {
    const row = db.prepare('SELECT info FROM oauth_clients WHERE client_id = ?').get(clientId);
    return row ? JSON.parse(row.info) : undefined;
  },
  registerClient(client) {
    // The SDK register handler has already generated client_id / client_id_issued_at.
    db.prepare('INSERT INTO oauth_clients (client_id, info, created_at) VALUES (?, ?, ?)')
      .run(client.client_id, JSON.stringify(client), now());
    return client;
  }
};

function issueTokens(clientId, scopes, resource) {
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const insert = db.prepare(
    'INSERT INTO oauth_tokens (token_hash, kind, client_id, scopes, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const scopeStr = scopes.join(' ');
  db.transaction(() => {
    insert.run(sha256(accessToken), 'access', clientId, scopeStr, resource || null, now() + ACCESS_TTL);
    insert.run(sha256(refreshToken), 'refresh', clientId, scopeStr, resource || null, now() + REFRESH_TTL);
  })();
  return {
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: ACCESS_TTL,
    refresh_token: refreshToken,
    ...(scopeStr ? { scope: scopeStr } : {})
  };
}

function consentPage({ pendingId, client, params, error }) {
  const name = client.client_name || client.client_id;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize access</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 480px; margin: 60px auto; padding: 0 16px; color: #222; }
  .card { border: 1px solid #ddd; border-radius: 8px; padding: 24px; }
  code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; word-break: break-all; }
  input[type=password] { width: 100%; padding: 8px; margin: 8px 0 16px; box-sizing: border-box; }
  button { padding: 8px 16px; margin-right: 8px; cursor: pointer; }
  .error { color: #b00020; }
</style></head>
<body><div class="card">
  <h1>Authorize access</h1>
  <p><strong>${escapeHtml(name)}</strong> wants to use the tools of this MCP server
     (memo_write, memo_search, upload, transcribe) on your behalf.</p>
  <p>It will be redirected to <code>${escapeHtml(params.redirectUri)}</code>.</p>
  ${params.scopes && params.scopes.length ? `<p>Scopes: <code>${escapeHtml(params.scopes.join(' '))}</code></p>` : ''}
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
  <form method="post" action="/consent">
    <input type="hidden" name="pending_id" value="${escapeHtml(pendingId)}">
    <label for="password">Owner password</label>
    <input type="password" id="password" name="password" autocomplete="current-password" autofocus>
    <button type="submit" name="action" value="approve">Approve</button>
    <button type="submit" name="action" value="deny">Deny</button>
  </form>
</div></body></html>`;
}

function redirectWith(redirectUri, query) {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  return url.href;
}

function createOAuthProvider({ ownerPassword, staticToken }) {
  return {
    clientsStore,

    async authorize(client, params, res) {
      purgeExpired();
      const pendingId = randomToken();
      db.prepare('INSERT INTO oauth_pending (id, client_id, params, expires_at) VALUES (?, ?, ?, ?)').run(
        pendingId,
        client.client_id,
        JSON.stringify({ ...params, resource: params.resource ? params.resource.href : undefined }),
        now() + PENDING_TTL
      );
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
      res.setHeader('X-Frame-Options', 'DENY');
      res.status(200).type('html').send(consentPage({ pendingId, client, params }));
    },

    async challengeForAuthorizationCode(client, authorizationCode) {
      const row = db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(sha256(authorizationCode));
      if (!row || row.client_id !== client.client_id || row.expires_at < now()) {
        throw new InvalidGrantError('Invalid or expired authorization code');
      }
      return row.code_challenge;
    },

    async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri) {
      const hash = sha256(authorizationCode);
      const row = db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(hash);
      // Single use: delete before validating so a replay never succeeds.
      db.prepare('DELETE FROM oauth_codes WHERE code_hash = ?').run(hash);
      if (!row || row.client_id !== client.client_id || row.expires_at < now()) {
        throw new InvalidGrantError('Invalid or expired authorization code');
      }
      if (redirectUri && redirectUri !== row.redirect_uri) {
        throw new InvalidGrantError('redirect_uri does not match the authorization request');
      }
      const scopes = row.scopes ? row.scopes.split(' ') : [];
      return issueTokens(client.client_id, scopes, row.resource);
    },

    async exchangeRefreshToken(client, refreshToken, scopes) {
      const hash = sha256(refreshToken);
      const row = db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'").get(hash);
      if (!row || row.client_id !== client.client_id || row.expires_at < now()) {
        throw new InvalidGrantError('Invalid or expired refresh token');
      }
      const granted = row.scopes ? row.scopes.split(' ') : [];
      const requested = scopes && scopes.length ? scopes : granted;
      if (requested.some((s) => !granted.includes(s))) {
        throw new InvalidGrantError('Requested scope exceeds the original grant');
      }
      // Rotate refresh tokens (OAuth 2.1 recommendation for public clients).
      db.prepare('DELETE FROM oauth_tokens WHERE token_hash = ?').run(hash);
      return issueTokens(client.client_id, requested, row.resource);
    },

    async verifyAccessToken(token) {
      if (staticToken && safeEqual(token, staticToken)) {
        // Owner's static token, for the owner's own harness.
        return { token, clientId: 'owner', scopes: ['mcp'], expiresAt: now() + ACCESS_TTL };
      }
      const row = db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'").get(sha256(token));
      if (!row || row.expires_at < now()) {
        throw new InvalidTokenError('Invalid or expired access token');
      }
      return {
        token,
        clientId: row.client_id,
        scopes: row.scopes ? row.scopes.split(' ') : [],
        expiresAt: row.expires_at,
        ...(row.resource ? { resource: new URL(row.resource) } : {})
      };
    },

    async revokeToken(client, { token }) {
      db.prepare('DELETE FROM oauth_tokens WHERE token_hash = ? AND client_id = ?').run(sha256(token), client.client_id);
    },

    // Express router for the consent form submission.
    consentRouter() {
      const router = express.Router();
      router.post('/consent', express.urlencoded({ extended: false }), (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        const { pending_id: pendingId, password, action } = req.body || {};
        const pending = pendingId
          ? db.prepare('SELECT * FROM oauth_pending WHERE id = ?').get(pendingId)
          : undefined;
        if (!pending || pending.expires_at < now()) {
          return res.status(400).type('text').send('This authorization request expired. Start the connection again.');
        }
        const params = JSON.parse(pending.params);
        const client = clientsStore.getClient(pending.client_id);
        if (!client) {
          return res.status(400).type('text').send('Unknown client.');
        }

        if (action === 'deny') {
          db.prepare('DELETE FROM oauth_pending WHERE id = ?').run(pendingId);
          return res.redirect(302, redirectWith(params.redirectUri, {
            error: 'access_denied', error_description: 'The owner denied access', state: params.state
          }));
        }

        if (!ownerPassword || !password || !safeEqual(password, ownerPassword)) {
          res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
          return res.status(401).type('html').send(consentPage({ pendingId, client, params, error: 'Wrong password.' }));
        }

        db.prepare('DELETE FROM oauth_pending WHERE id = ?').run(pendingId);
        const code = randomToken();
        db.prepare(
          'INSERT INTO oauth_codes (code_hash, client_id, code_challenge, redirect_uri, scopes, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(
          sha256(code), client.client_id, params.codeChallenge, params.redirectUri,
          (params.scopes || []).join(' '), params.resource || null, now() + CODE_TTL
        );
        return res.redirect(302, redirectWith(params.redirectUri, { code, state: params.state }));
      });
      return router;
    }
  };
}

module.exports = { createOAuthProvider };
