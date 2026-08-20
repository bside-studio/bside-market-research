/**
 * Shared stateless auth token helper (HMAC-signed, no external dependencies).
 * Copied identically into bside-hunter, bside-universe, bside-universe-agent,
 * and bside-settings. AUTH_SECRET must be the same value in every service's .env.
 */
import crypto from "crypto";

export function signToken(payload, secret, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const payloadB64 = Buffer.from(JSON.stringify(body)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payloadB64).digest();
  return `${payloadB64}.${sig.toString("base64url")}`;
}

export function verifyToken(token, secret) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payloadB64, sigB64] = token.split(".");
  if (!payloadB64 || !sigB64) return null;
  try {
    const expected = crypto.createHmac("sha256", secret).update(payloadB64).digest();
    const given = Buffer.from(sigB64, "base64url");
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    const body = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
    if (typeof body.exp !== "number" || body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch {
    return null;
  }
}

export function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach(part => {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
