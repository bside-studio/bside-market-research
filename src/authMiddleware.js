import { verifyToken, parseCookies } from "./auth.js";
import { q } from "./db.js";

const SECRET = process.env.AUTH_SECRET;
const SETTINGS_URL = process.env.BSIDE_SETTINGS_URL || "http://localhost:3300";

function loginUrlFor(req) {
  const returnUrl = `${req.protocol}://${req.get("host")}/`;
  return `${SETTINGS_URL}/?return=${encodeURIComponent(returnUrl)}`;
}

let lastAccessAt = null;
export function getLastAccessAt() { return lastAccessAt; }

export function requireAuth(req, res, next) {
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const cookieTok = parseCookies(req.headers.cookie).bside_session;
  const user = verifyToken(bearer, SECRET) || verifyToken(cookieTok, SECRET);
  if (!user) return res.status(401).json({ ok: false, error: "auth required", loginUrl: loginUrlFor(req) });
  if (user.role !== "system") {
    lastAccessAt = new Date().toISOString();
    q.recordAccess.run(user.uid);
  }
  req.user = user;
  next();
}

// role "system" (service-to-service calls) bypasses per-role checks - authenticated by the
// same shared AUTH_SECRET as every other role.
// v1 note: this app has no "client" role scope yet - only admin/hunter may view or act on
// reports. Adding a client-facing read-only view later should follow Hunter's
// filterStateForClient pattern (src/authMiddleware.js in bside-hunter).
export function requireRole(...roles) {
  return (req, res, next) => {
    if (req.user.role === "system" || roles.includes(req.user.role)) return next();
    res.status(403).json({ ok: false, error: "forbidden" });
  };
}
