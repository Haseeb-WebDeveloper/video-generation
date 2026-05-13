// Exchange a stored refresh token for a short-lived access token.
//
// Used by publish-episode each run. The refresh token itself is created once
// by scripts/youtube-auth.mjs and stored in .env.

const TOKEN_URL = "https://oauth2.googleapis.com/token";

export async function getAccessToken({ clientId, clientSecret, refreshToken }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (parsed?.error === "invalid_grant") {
      throw new Error(
        "Token refresh failed: invalid_grant — the refresh token has expired or been revoked. " +
          "Run `npm run youtube-auth` to reauthorize and update YOUTUBE_REFRESH_TOKEN in .env.",
      );
    }
    throw new Error(`Token refresh failed: HTTP ${res.status} — ${text}`);
  }
  const json = JSON.parse(text);
  if (!json.access_token) {
    throw new Error(`Token refresh: no access_token in response: ${JSON.stringify(json)}`);
  }
  return {
    accessToken: json.access_token,
    expiresIn: json.expires_in,
    scope: json.scope,
  };
}

export async function exchangeAuthCode({
  clientId,
  clientSecret,
  code,
  redirectUri,
}) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Code exchange failed: HTTP ${res.status} — ${text}`);
  }
  const json = await res.json();
  if (!json.refresh_token) {
    throw new Error(
      "Code exchange: no refresh_token in response. Ensure the consent URL " +
        'used access_type=offline and prompt=consent, and that you approved a fresh consent screen.',
    );
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in,
    scope: json.scope,
  };
}
