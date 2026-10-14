/* SIWC OSS protocol only: no browser, network, storage, native bridge or UI.
 * Official contracts checked 2026-10-09:
 * https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 * https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
 * https://developers.openai.com/siwc/website (maintained JOSE signature verification)
 * https://developers.openai.com/siwc/token-sharing-open-source/token-reference
 * https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms
 * Current OSS callback is HTTP 127.0.0.1, not a custom mobile URI. A mobile
 * loopback host still needs a separately verified native adapter. VM transfer
 * documentation is not evidence of supported phone credential transfer.
 * Run sensitive operations in a protected host, never browser storage. The
 * caller owns one refresh lock/session and atomic CAS; proposals do not write.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OpenAIAccountProtocol = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const ISSUER = 'https://auth.openai.com';
  const AUTHORIZE = ISSUER + '/api/accounts/authorize';
  const TOKEN = ISSUER + '/api/accounts/oauth/token';
  const JWKS = ISSUER + '/.well-known/jwks.json';
  const RESOURCE = 'https://api.openai.com/v1';
  const DYNAMIC = 'dynamic_agent_client';
  const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
  const FENCE = ['hostId', 'clientId', 'issuer', 'subject', 'sessionId', 'generation', 'credentialRevision'];
  const encoder = new TextEncoder();
  const identityProofs = new WeakMap();
  class ProtocolError extends Error { constructor(code) { super('OpenAI account protocol validation failed.'); this.name = 'ProtocolError'; this.code = code; } }
  function fail(code = 'INVALID_PROTOCOL') { throw new ProtocolError(code); }
  function object(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(); return value; }
  function text(value, max = 1024) { if (typeof value !== 'string' || !value || encoder.encode(value).length > max || /[\x00-\x20\x7f]/.test(value)) fail(); return value; }
  function integer(value, min = 0) { if (!Number.isSafeInteger(value) || value < min) fail(); return value; }
  function client(value) { text(value, 256); if (value === DYNAMIC) fail('INVALID_CLIENT'); return value; }
  function clone(value) { return structuredClone(value); }
  function base64url(bytes) { let s = ''; for (const byte of bytes) s += String.fromCharCode(byte); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function constantEqual(a, b) { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0; }
  function hostId(value) {
    text(value, 512);
    if (!/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
      && !/^urn:ietf:params:oauth:jwk-thumbprint:sha-256:[A-Za-z0-9_-]{43}$/.test(value)
      && !/^did:key:z[1-9A-HJ-NP-Za-km-z]{16,480}$/.test(value)) fail('INVALID_HOST');
    return value;
  }
  function loopback(value) {
    text(value, 2048);
    const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})(\/[A-Za-z0-9/_-]+)$/.exec(value);
    if (!match || Number(match[1]) > 65535 || new URL(value).href !== value) fail('INVALID_CALLBACK');
    return value;
  }
  async function pkceChallenge(verifier, cryptoProvider = globalThis.crypto) {
    if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !cryptoProvider?.subtle) fail('INVALID_PKCE');
    return base64url(new Uint8Array(await cryptoProvider.subtle.digest('SHA-256', encoder.encode(verifier))));
  }
  async function createAuthorization({ redirectUri, host: hostValue, registration = null, cryptoProvider = globalThis.crypto, now = Date.now() } = {}) {
    loopback(redirectUri); hostId(hostValue); integer(now);
    if (!cryptoProvider?.getRandomValues || !cryptoProvider?.subtle) fail('CRYPTO_UNAVAILABLE');
    let saved = null;
    if (registration !== null) {
      object(registration); client(registration.clientId); text(registration.subject);
      if (registration.issuer !== ISSUER) fail('IDENTITY_MISMATCH');
      // A retained registration fixes scheme/host/path; only its port may vary.
      loopback(registration.redirectUri);
      if (new URL(registration.redirectUri).pathname !== new URL(redirectUri).pathname) fail('INVALID_CALLBACK');
      saved = clone(registration);
    }
    const random = () => base64url(cryptoProvider.getRandomValues(new Uint8Array(32)));
    const state = random(), nonce = random(); let verifier = random(), used = false;
    const query = new URLSearchParams({ client_id: saved?.clientId || DYNAMIC, ext_agent_host_id: hostValue,
      response_type: 'code', redirect_uri: redirectUri, scope: SCOPES, resource: RESOURCE, state, nonce,
      code_challenge_method: 'S256', code_challenge: await pkceChallenge(verifier, cryptoProvider) });
    if (saved) {
      if (saved.idTokenHint) query.set('id_token_hint', text(saved.idTokenHint, 32768));
      if (saved.email) query.set('login_hint', text(saved.email, 320));
    } else query.set('agent_name_hint', 'AI Bro');
    return Object.freeze({
      // May contain id_token_hint: do not log this URL or put it in diagnostics.
      authorizationURL: AUTHORIZE + '?' + query.toString(), expiresAt: now + 600000,
      cancel() { used = true; verifier = null; },
      consumeCallback(value, receivedAt = Date.now()) {
        if (used) fail('CALLBACK_CONSUMED');
        integer(receivedAt); if (receivedAt < now || receivedAt >= now + 600000) { used = true; verifier = null; fail('CALLBACK_EXPIRED'); }
        let url; try { url = new URL(text(value, 65536)); } catch (_) { fail('INVALID_CALLBACK'); }
        if (url.origin + url.pathname !== redirectUri || url.username || url.password || url.hash) fail('INVALID_CALLBACK');
        if (url.searchParams.getAll('state').length !== 1 || !constantEqual(url.searchParams.get('state'), state)) fail('STATE_MISMATCH');
        // Wrong state cannot consume another local sign-in. Matching state,
        // including a declined/malformed reply, consumes this attempt once.
        used = true; const codeVerifier = verifier; verifier = null;
        const allowed = new Set(['state', 'code', 'client_id', 'scope', 'error', 'error_description', 'error_uri']);
        for (const name of url.searchParams.keys()) if (!allowed.has(name) || url.searchParams.getAll(name).length !== 1) fail('INVALID_CALLBACK');
        if (url.searchParams.has('error')) {
          if (url.searchParams.has('code')) fail('INVALID_CALLBACK');
          return Object.freeze({ status: 'error', code: url.searchParams.get('error') === 'access_denied' ? 'ACCESS_DENIED' : 'OAUTH_ERROR' });
        }
        const issued = url.searchParams.has('client_id') ? url.searchParams.get('client_id') : saved?.clientId;
        client(issued); if (saved && issued !== saved.clientId) fail('CLIENT_MISMATCH');
        const code = text(url.searchParams.get('code'), 16384);
        return Object.freeze({ status: 'code', clientId: issued,
          expectedIdentity: Object.freeze({ issuer: ISSUER, clientId: issued, nonce, ...(saved ? { subject: saved.subject } : {}) }),
          request: Object.freeze({ url: TOKEN, method: 'POST', contentType: 'application/x-www-form-urlencoded',
            body: new URLSearchParams({ grant_type: 'authorization_code', client_id: issued, code, code_verifier: codeVerifier, redirect_uri: redirectUri, resource: RESOURCE }).toString() }) });
      },
    });
  }
  function validateDiscovery(value) {
    object(value);
    if (value.issuer !== ISSUER || value.authorization_endpoint !== AUTHORIZE || value.token_endpoint !== TOKEN || value.jwks_uri !== JWKS) fail('INVALID_DISCOVERY');
    const algorithms = value.id_token_signing_alg_values_supported;
    if (!Array.isArray(algorithms) || !algorithms.length || algorithms.length > 16) fail('INVALID_DISCOVERY');
    const supported = [...new Set(algorithms.filter(a => ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'].includes(a)))];
    if (!supported.length) fail('INVALID_DISCOVERY');
    let revocationEndpoint = null;
    if (value.revocation_endpoint !== undefined) {
      const uri = new URL(text(value.revocation_endpoint, 2048));
      if (uri.origin !== ISSUER || uri.username || uri.password || uri.search || uri.hash) fail('INVALID_DISCOVERY');
      revocationEndpoint = uri.href;
    }
    return Object.freeze({ issuer: ISSUER, authorizationEndpoint: AUTHORIZE, tokenEndpoint: TOKEN, jwksURI: JWKS, algorithms: Object.freeze(supported), revocationEndpoint });
  }
  function validateJWKS(value) {
    object(value);
    if (!Array.isArray(value.keys) || !value.keys.length || value.keys.length > 32 || encoder.encode(JSON.stringify(value)).length > 65536) fail('INVALID_JWKS');
    const kids = new Set();
    for (const key of value.keys) {
      object(key); text(key.kid, 256);
      if (kids.has(key.kid) || !['RSA','EC','OKP'].includes(key.kty) || ['d','p','q','dp','dq','qi','oth','k'].some(name => Object.hasOwn(key, name))) fail('INVALID_JWKS');
      kids.add(key.kid);
    }
    return clone(value);
  }
  async function verifyIDToken(idToken, { expected, discovery, jwks, jwtVerify, createLocalJWKSet, nowSeconds = Math.floor(Date.now() / 1000), refresh = false } = {}) {
    // Inject a maintained JOSE implementation, configured with the pinned
    // discovery/JWKS responses. No JWT decode-only fallback or network here.
    try {
      text(idToken, 32768); object(expected); client(expected.clientId); integer(nowSeconds); if (typeof refresh !== 'boolean') fail();
      if (expected.issuer !== ISSUER || typeof jwtVerify !== 'function' || typeof createLocalJWKSet !== 'function') fail();
      const config = validateDiscovery(discovery), keys = validateJWKS(jwks);
      if (!refresh) text(expected.nonce, 256); else text(expected.subject);
      const verified = await jwtVerify(idToken, createLocalJWKSet(keys), { issuer: ISSUER, audience: expected.clientId,
        algorithms: config.algorithms, requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5, currentDate: new Date(nowSeconds * 1000) });
      const p = object(verified.payload), header = object(verified.protectedHeader);
      if (!config.algorithms.includes(header.alg) || p.iss !== ISSUER) fail();
      const audience = Array.isArray(p.aud) ? p.aud : [p.aud];
      if (!audience.length || audience.length > 8 || new Set(audience).size !== audience.length || !audience.every(a => typeof a === 'string' && a.length > 0) || !audience.includes(expected.clientId)) fail();
      if ((audience.length > 1 || p.azp !== undefined) && p.azp !== expected.clientId) fail('IDENTITY_MISMATCH');
      integer(p.exp, 1); integer(p.iat); text(p.sub);
      if (p.exp <= nowSeconds - 5 || p.iat > nowSeconds + 5 || p.exp <= p.iat || (p.nbf !== undefined && integer(p.nbf) > nowSeconds + 5)) fail();
      if (!refresh && !constantEqual(p.nonce, expected.nonce)) fail();
      if (expected.subject !== undefined && p.sub !== expected.subject) fail('IDENTITY_MISMATCH');
      const identity=Object.freeze({ issuer: ISSUER, clientId: expected.clientId, subject: p.sub, ...(typeof p.email === 'string' && p.email.length <= 320 ? { email: p.email } : {}) });
      identityProofs.set(identity,idToken);return identity;
    } catch (_) { fail('INVALID_ID_TOKEN'); }
  }
  function sessionFence(value) {
    object(value); if (Object.keys(value).length !== FENCE.length || !FENCE.every(key => Object.hasOwn(value,key))) fail('STALE_SESSION');
    hostId(value.hostId); client(value.clientId); text(value.subject); text(value.sessionId); integer(value.generation,1); integer(value.credentialRevision);
    if (value.issuer !== ISSUER) fail('STALE_SESSION'); return clone(value);
  }
  function refreshRequest({ clientId, refreshToken }) {
    client(clientId); text(refreshToken,32768);
    return Object.freeze({ url:TOKEN, method:'POST', contentType:'application/x-www-form-urlencoded',
      body:new URLSearchParams({ grant_type:'refresh_token',client_id:clientId,refresh_token:refreshToken,resource:RESOURCE }).toString() });
  }
  function tokenProposal({ response, verifiedIdentity, expectedSession, previous = null, receivedAt = Date.now() }) {
    object(response); const fence = sessionFence(expectedSession); integer(receivedAt); object(verifiedIdentity);
    if (['issuer','clientId','subject'].some(key => verifiedIdentity[key] !== fence[key])) fail('IDENTITY_MISMATCH');
    if (previous !== null) {
      object(previous); if (['issuer','clientId','subject'].some(key => previous[key] !== fence[key])) fail('IDENTITY_MISMATCH');
    }
    const accessToken=text(response.access_token,32768);
    if (typeof response.token_type !== 'string' || response.token_type.toLowerCase() !== 'bearer') fail('INVALID_TOKEN_RESPONSE');
    const expiresIn=integer(response.expires_in,1); if (expiresIn>86400) fail('INVALID_TOKEN_RESPONSE');
    // Provider contract: token-reference#token-response-and-refresh-tokens lists
    // scope in the response and requires a replacement refresh token on refresh.
    // profiles-and-sessions#refreshing-tokens omits scope only in the REQUEST.
    // Do not silently substitute an old grant or a potentially rotated token.
    if (typeof response.scope !== 'string' || response.scope.length>4096 || !/^[\x21\x23-\x5b\x5d-\x7e]+(?: [\x21\x23-\x5b\x5d-\x7e]+)*$/.test(response.scope)) fail('INVALID_SCOPES');
    const scopes=[...new Set(response.scope.split(' '))].sort();
    const refreshToken=response.refresh_token === undefined && previous === null && !scopes.includes('offline_access') ? null : text(response.refresh_token,32768);
    const idToken=response.id_token === undefined && previous !== null ? text(previous.idToken,32768) : text(response.id_token,32768);
    if (response.id_token !== undefined && identityProofs.get(verifiedIdentity) !== idToken) fail('INVALID_ID_TOKEN');
    const credentials={issuer:ISSUER,clientId:fence.clientId,subject:fence.subject,accessToken,refreshToken,idToken,tokenType:'Bearer',scopes,receivedAt,expiresAt:receivedAt+expiresIn*1000};
    // Unknown earliest_refresh_at representation is deliberately not interpreted;
    // host integration must resolve its documented type before scheduling it.
    return Object.freeze({ expectedSession:Object.freeze(fence), credentials:Object.freeze(credentials),
      planUsageEnabled:scopes.includes('chatgpt.tokens.use.direct') && scopes.includes('resource.invoke') });
  }
  function assertProposalSession(proposal, current) {
    const actual=sessionFence(current),expected=sessionFence(object(proposal).expectedSession);
    if (!FENCE.every(key => actual[key] === expected[key])) fail('STALE_SESSION');
    // This assertion is not a lock. Call it under the host's session + storage
    // transaction, then replace the whole token set with revision CAS.
    return true;
  }
  return Object.freeze({ ISSUER,AUTHORIZE,TOKEN,JWKS,RESOURCE,SCOPES,ProtocolError,pkceChallenge,createAuthorization,
    validateDiscovery,validateJWKS,verifyIDToken,refreshRequest,tokenProposal,assertProposalSession });
});
