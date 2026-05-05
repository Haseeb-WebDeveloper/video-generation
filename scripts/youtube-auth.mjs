#!/usr/bin/env node
// One-time YouTube OAuth setup.
//
// Reads YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET from .env, runs the
// browser consent flow against a localhost callback, and writes the resulting
// refresh token back to .env as YOUTUBE_REFRESH_TOKEN.
//
// Prerequisites:
//   1. In Google Cloud Console, create a project and enable YouTube Data API v3.
//   2. OAuth consent screen → External, add yourself as a test user, add the
//      scope https://www.googleapis.com/auth/youtube.upload.
//   3. Credentials → Create OAuth client ID → Application type "Desktop app".
//   4. Copy the client ID and secret into .env:
//        YOUTUBE_CLIENT_ID=...
//        YOUTUBE_CLIENT_SECRET=...
//   5. Run: npm run youtube-auth
//
// Usage: node scripts/youtube-auth.mjs

import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import * as dotenv from "./lib/dotenv.mjs";
import { exchangeAuthCode } from "./lib/youtube-auth.mjs";

const ROOT = path.resolve(process.cwd());
const ENV_FILE = path.join(ROOT, ".env");

const env = await dotenv.load(ENV_FILE);
const clientId = env.YOUTUBE_CLIENT_ID;
const clientSecret = env.YOUTUBE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    "\nMissing YOUTUBE_CLIENT_ID and/or YOUTUBE_CLIENT_SECRET in .env.\n\n" +
      "Set up steps:\n" +
      "  1. Google Cloud Console → enable 'YouTube Data API v3'.\n" +
      "  2. OAuth consent screen → External, add yourself as a test user,\n" +
      "     add scope https://www.googleapis.com/auth/youtube.upload.\n" +
      "  3. Credentials → Create OAuth client ID → 'Desktop app'.\n" +
      "  4. Copy the client ID and secret into .env, then re-run.\n",
  );
  process.exit(1);
}

const SCOPE = "https://www.googleapis.com/auth/youtube.upload";

const server = http.createServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const port = server.address().port;
const redirectUri = `http://127.0.0.1:${port}/callback`;

const consentUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
  }).toString();

console.log("\n=== YouTube OAuth Setup ===\n");
console.log("Open this URL in the Google account that owns the channel:\n");
console.log(consentUrl);
console.log(
  "\n(Attempting to open it in your default browser. If nothing happens,\n" +
    " copy and paste the URL above.)\n",
);
tryOpenBrowser(consentUrl);

const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(
    () => reject(new Error("Timed out waiting for OAuth callback (5 minutes).")),
    5 * 60 * 1000,
  );
  server.on("request", async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname !== "/callback") {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (error) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<h1>OAuth error</h1><pre>${escapeHtml(error)}</pre>`);
      clearTimeout(timeout);
      reject(new Error(`OAuth error: ${error}`));
      return;
    }
    if (!code) {
      res.writeHead(400);
      res.end("missing ?code");
      return;
    }
    try {
      const tokens = await exchangeAuthCode({
        clientId,
        clientSecret,
        code,
        redirectUri,
      });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<h1>Auth complete</h1><p>You can close this tab and return to the terminal.</p>",
      );
      clearTimeout(timeout);
      resolve(tokens);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<h1>Token exchange failed</h1><pre>${escapeHtml(err.message)}</pre>`);
      clearTimeout(timeout);
      reject(err);
    }
  });
});

server.close();

await dotenv.upsert(ENV_FILE, "YOUTUBE_REFRESH_TOKEN", result.refreshToken);
console.log("\nRefresh token written to .env.");
console.log("Granted scope:", result.scope);
console.log("\nYou're ready: run `npm run publish-episode <slug>`.");

function tryOpenBrowser(url) {
  try {
    const isWin = process.platform === "win32";
    const isMac = process.platform === "darwin";
    if (isWin) {
      // cmd's `start` splits on unquoted `&`, which truncates an OAuth URL at
      // the first query separator. rundll32 hands the URL directly to the
      // shell's URL handler with no parsing.
      spawn(
        "rundll32",
        ["url.dll,FileProtocolHandler", url],
        { stdio: "ignore", detached: true },
      ).unref();
    } else if (isMac) {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch {
    // Browser auto-open is best-effort; URL is already printed.
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}
