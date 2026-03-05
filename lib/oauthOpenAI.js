const OPENAI_AUTH_ISSUER = 'https://auth.openai.com';
const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

function trimSlash(url) {
  return (url || '').replace(/\/+$/, '');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseInterval(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

async function readError(response, prefix) {
  const text = await response.text().catch(() => '');
  throw new Error(`${prefix} (${response.status}): ${text || response.statusText}`);
}

async function requestDeviceCode(options = {}) {
  const issuer = trimSlash(options.issuer || OPENAI_AUTH_ISSUER);
  const clientId = options.clientId || OPENAI_CODEX_CLIENT_ID;
  const response = await fetch(`${issuer}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId })
  });

  if (!response.ok) {
    await readError(response, 'OpenAI device code request failed');
  }

  const data = await response.json();
  return {
    issuer,
    clientId,
    verificationUrl: `${issuer}/codex/device`,
    userCode: data.user_code || data.usercode,
    deviceAuthId: data.device_auth_id,
    interval: parseInterval(data.interval)
  };
}

async function pollForDeviceAuthorization(deviceCode, options = {}) {
  const timeoutMs = options.timeoutMs || 15 * 60 * 1000;
  const started = Date.now();
  const issuer = trimSlash(deviceCode.issuer || OPENAI_AUTH_ISSUER);
  const pollUrl = `${issuer}/api/accounts/deviceauth/token`;

  while (Date.now() - started < timeoutMs) {
    const response = await fetch(pollUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_auth_id: deviceCode.deviceAuthId,
        user_code: deviceCode.userCode
      })
    });

    if (response.ok) {
      return await response.json();
    }

    if (response.status === 403 || response.status === 404) {
      await sleep((deviceCode.interval || 5) * 1000);
      continue;
    }

    await readError(response, 'OpenAI device authorization failed');
  }

  throw new Error('OpenAI device authorization timed out after 15 minutes');
}

async function exchangeAuthorizationCode(options) {
  const issuer = trimSlash(options.issuer || OPENAI_AUTH_ISSUER);
  const clientId = options.clientId || OPENAI_CODEX_CLIENT_ID;
  const redirectUri = options.redirectUri || `${issuer}/deviceauth/callback`;

  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: options.authorizationCode,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: options.codeVerifier
  });

  const response = await fetch(`${issuer}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });

  if (!response.ok) {
    await readError(response, 'OpenAI authorization-code exchange failed');
  }

  return await response.json();
}

async function refreshOpenAIToken(options) {
  const issuer = trimSlash(options.issuer || OPENAI_AUTH_ISSUER);
  const clientId = options.clientId || OPENAI_CODEX_CLIENT_ID;
  const form = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: options.refreshToken
  });
  const response = await fetch(`${issuer}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });

  if (!response.ok) {
    await readError(response, 'OpenAI token refresh failed');
  }

  return await response.json();
}

function buildTokenRecord(tokenPayload) {
  const expiresIn = Number(tokenPayload.expires_in);
  const expiresAt = Number.isFinite(expiresIn)
    ? new Date(Date.now() + (expiresIn * 1000)).toISOString()
    : null;

  return {
    accessToken: tokenPayload.access_token,
    refreshToken: tokenPayload.refresh_token,
    idToken: tokenPayload.id_token || null,
    expiresAt
  };
}

function isTokenExpired(expiresAt, skewSeconds = 60) {
  if (!expiresAt) return false;
  const expiry = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiry)) return false;
  return Date.now() >= (expiry - skewSeconds * 1000);
}

async function completeDeviceCodeLogin(deviceCode, options = {}) {
  const authorized = await pollForDeviceAuthorization(deviceCode, options);
  const tokens = await exchangeAuthorizationCode({
    issuer: deviceCode.issuer,
    clientId: deviceCode.clientId,
    authorizationCode: authorized.authorization_code,
    codeVerifier: authorized.code_verifier,
    redirectUri: `${trimSlash(deviceCode.issuer)}/deviceauth/callback`
  });
  return buildTokenRecord(tokens);
}

module.exports = {
  OPENAI_AUTH_ISSUER,
  OPENAI_CODEX_CLIENT_ID,
  requestDeviceCode,
  pollForDeviceAuthorization,
  exchangeAuthorizationCode,
  refreshOpenAIToken,
  completeDeviceCodeLogin,
  buildTokenRecord,
  isTokenExpired
};
