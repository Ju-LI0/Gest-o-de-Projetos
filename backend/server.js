"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { promisify } = require("node:util");

const ROOT = path.resolve(__dirname, "..");
const FRONTEND_ROOT = path.join(ROOT, "frontend");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const DATABASE_PATH = process.env.DB_PATH || path.join(DATA_DIR, "fluxo.sqlite");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const COOKIE_NAME = "fluxo_session";
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;
const scrypt = promisify(crypto.scrypt);
const authAttempts = new Map();
const publicFiles = new Map([
  ["/", ["home", "index.html"]],
  ["/home", ["home", "index.html"]],
  ["/home/", ["home", "index.html"]],
  ["/home/home.css", ["home", "home.css"]],
  ["/home/home.js", ["home", "home.js"]],
  ["/login", ["login", "index.html"]],
  ["/login/", ["login", "index.html"]],
  ["/login/login.css", ["login", "login.css"]],
  ["/login/login.js", ["login", "login.js"]],
  ["/register", ["register", "index.html"]],
  ["/register/", ["register", "index.html"]],
  ["/register/register.css", ["register", "register.css"]],
  ["/register/register.js", ["register", "register.js"]],
  ["/mapping", ["mapping", "index.html"]],
  ["/mapping/", ["mapping", "index.html"]],
  ["/mapping/mapping.css", ["mapping", "mapping.css"]],
  ["/mapping/mapping.js", ["mapping", "mapping.js"]],
  ["/workspace", ["workspace", "index.html"]],
  ["/workspace/", ["workspace", "index.html"]],
  ["/workspace/workspace.css", ["workspace", "workspace.css"]],
  ["/workspace/workspace.js", ["workspace", "workspace.js"]]
]);

fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
const database = new DatabaseSync(DATABASE_PATH);
database.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS processes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('Pendente', 'Finalizado')),
    steps_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS processes_user_updated_idx ON processes(user_id, updated_at DESC);
`);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, payload, extraHeaders = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  response.end(JSON.stringify(payload));
}

function sessionCookie(token, maxAge = SESSION_DURATION_MS / 1000) {
  const secure = process.env.COOKIE_SECURE === "true" ? "; Secure" : "";
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

function clearSessionCookie() {
  const secure = process.env.COOKIE_SECURE === "true" ? "; Secure" : "";
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`;
}

function getCookie(request, name) {
  const cookies = request.headers.cookie || "";
  const prefix = `${name}=`;
  for (const item of cookies.split(";")) {
    const cookie = item.trim();
    if (cookie.startsWith(prefix)) return cookie.slice(prefix.length);
  }
  return null;
}

function publicUser(row) {
  return { id: row.id, name: row.name, email: row.email };
}

function getSessionUser(request) {
  const token = getCookie(request, COOKIE_NAME);
  if (!token || token.length > 128) return null;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const row = database.prepare(`
    SELECT users.id, users.name, users.email, sessions.expires_at
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?
  `).get(tokenHash);
  if (!row || row.expires_at <= Date.now()) {
    if (row) database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    return null;
  }
  return publicUser(row);
}

function assertSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new HttpError(403, "Origem da solicitação inválida.");
  }
  const configuredOrigin = process.env.PUBLIC_ORIGIN;
  const expectedOrigin = configuredOrigin
    ? new URL(configuredOrigin).origin
    : `${process.env.COOKIE_SECURE === "true" || request.socket.encrypted ? "https:" : "http:"}//${request.headers.host || ""}`;
  if (originUrl.origin !== expectedOrigin) {
    throw new HttpError(403, "Origem da solicitação não permitida.");
  }
}

async function readJson(request) {
  const declaredLength = Number(request.headers["content-length"] || 0);
  if (declaredLength > MAX_BODY_BYTES) throw new HttpError(413, "A solicitação excede o tamanho permitido.");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "A solicitação excede o tamanho permitido.");
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected an object");
    return body;
  } catch {
    throw new HttpError(400, "Envie os dados em um JSON válido.");
  }
}

function authRateLimit(request) {
  const key = request.socket.remoteAddress || "unknown";
  const now = Date.now();
  const recent = (authAttempts.get(key) || []).filter((time) => now - time < 15 * 60 * 1000);
  if (recent.length >= 12) throw new HttpError(429, "Muitas tentativas. Aguarde alguns minutos e tente novamente.");
  recent.push(now);
  authAttempts.set(key, recent);
}

function makeSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const now = Date.now();
  database.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run(tokenHash, userId, now + SESSION_DURATION_MS, now);
  database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  return token;
}

async function register(request, response) {
  assertSameOrigin(request);
  authRateLimit(request);
  const body = await readJson(request);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (name.length < 2 || name.length > 80) throw new HttpError(400, "O nome deve ter entre 2 e 80 caracteres.");
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Informe um e-mail válido.");
  if (password.length < 10 || password.length > 128) throw new HttpError(400, "A senha deve ter entre 10 e 128 caracteres.");
  if (database.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) throw new HttpError(409, "Já existe uma conta com este e-mail.");
  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const user = { id: crypto.randomUUID(), name, email };
  try {
    database.prepare("INSERT INTO users (id, name, email, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(user.id, user.name, user.email, salt, passwordHash.toString("hex"), Date.now());
  } catch (error) {
    if (error.code === "ERR_SQLITE_CONSTRAINT_UNIQUE") throw new HttpError(409, "Já existe uma conta com este e-mail.");
    throw error;
  }
  const token = makeSession(user.id);
  sendJson(response, 201, { user }, { "Set-Cookie": sessionCookie(token) });
}

async function login(request, response) {
  assertSameOrigin(request);
  authRateLimit(request);
  const body = await readJson(request);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const row = database.prepare("SELECT id, name, email, password_salt, password_hash FROM users WHERE email = ?").get(email);
  if (password.length > 128) throw new HttpError(401, "E-mail ou senha incorretos.");
  const salt = row ? row.password_salt : "fluxo-login-invalid-user";
  const candidate = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const expected = Buffer.from(row ? row.password_hash : "0".repeat(128), "hex");
  if (!row || !crypto.timingSafeEqual(candidate, expected)) {
    throw new HttpError(401, "E-mail ou senha incorretos.");
  }
  const token = makeSession(row.id);
  sendJson(response, 200, { user: publicUser(row) }, { "Set-Cookie": sessionCookie(token) });
}

function normalizeProcess(body) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 1 || name.length > 70) throw new HttpError(400, "O nome do processo deve ter entre 1 e 70 caracteres.");
  if (!["Pendente", "Finalizado"].includes(body.status)) throw new HttpError(400, "Selecione um status válido.");
  if (!Array.isArray(body.steps) || body.steps.length > 100) throw new HttpError(400, "A lista de etapas é inválida.");
  const validTypes = new Set(["Atividade", "Decisão", "Automação"]);
  const steps = body.steps.map((step) => {
    if (!step || !validTypes.has(step.type) || typeof step.name !== "string" || !step.name.trim() || step.name.trim().length > 48) {
      throw new HttpError(400, "Uma das etapas contém dados inválidos.");
    }
    return { type: step.type, name: step.name.trim() };
  });
  return { name, status: body.status, steps };
}

function mapProcess(row) {
  const steps = JSON.parse(row.steps_json);
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    steps,
    description: `${steps.length} ${steps.length === 1 ? "etapa mapeada" : "etapas mapeadas"}`,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function requireUser(request) {
  const user = getSessionUser(request);
  if (!user) throw new HttpError(401, "Entre na sua conta para acessar seus processos.");
  return user;
}

async function handleApi(request, response, url) {
  const { pathname } = url;
  if (pathname === "/api/auth/register" && request.method === "POST") return register(request, response);
  if (pathname === "/api/auth/login" && request.method === "POST") return login(request, response);
  if (pathname === "/api/auth/logout" && request.method === "POST") {
    assertSameOrigin(request);
    const token = getCookie(request, COOKIE_NAME);
    if (token && token.length <= 128) {
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    }
    return sendJson(response, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
  }
  if (pathname === "/api/auth/me" && request.method === "GET") {
    const user = getSessionUser(request);
    return sendJson(response, 200, { user });
  }
  if (pathname.startsWith("/api/")) {
    const user = requireUser(request);
    if (pathname === "/api/processes" && request.method === "GET") {
      const rows = database.prepare("SELECT id, name, status, steps_json, created_at, updated_at FROM processes WHERE user_id = ? ORDER BY updated_at DESC")
        .all(user.id);
      return sendJson(response, 200, { processes: rows.map(mapProcess) });
    }
    if (pathname === "/api/processes" && request.method === "POST") {
      assertSameOrigin(request);
      const data = normalizeProcess(await readJson(request));
      const id = crypto.randomUUID();
      const now = Date.now();
      database.prepare("INSERT INTO processes (id, user_id, name, status, steps_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, user.id, data.name, data.status, JSON.stringify(data.steps), now, now);
      return sendJson(response, 201, { process: { id, ...data, description: `${data.steps.length} ${data.steps.length === 1 ? "etapa mapeada" : "etapas mapeadas"}`, createdAt: now, updatedAt: now } });
    }
    const processId = pathname.match(/^\/api\/processes\/([0-9a-f-]{36})$/i)?.[1];
    if (processId && request.method === "PUT") {
      assertSameOrigin(request);
      const data = normalizeProcess(await readJson(request));
      const now = Date.now();
      const result = database.prepare("UPDATE processes SET name = ?, status = ?, steps_json = ?, updated_at = ? WHERE id = ? AND user_id = ?")
        .run(data.name, data.status, JSON.stringify(data.steps), now, processId, user.id);
      if (result.changes === 0) throw new HttpError(404, "Processo não encontrado.");
      return sendJson(response, 200, { process: { id: processId, ...data, description: `${data.steps.length} ${data.steps.length === 1 ? "etapa mapeada" : "etapas mapeadas"}`, updatedAt: now } });
    }
    throw new HttpError(404, "Rota da API não encontrada.");
  }
  throw new HttpError(404, "Rota da API não encontrada.");
}

function applySecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  if (process.env.COOKIE_SECURE === "true") response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}

async function serveStatic(request, response, url) {
  if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "Método não permitido.");
  const asset = publicFiles.get(url.pathname);
  if (!asset) throw new HttpError(404, "Página não encontrada.");
  const [folder, filename] = asset;
  const filePath = path.join(FRONTEND_ROOT, folder, filename);
  const contentTypes = { "index.html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
  const content = await fs.promises.readFile(filePath);
  const contentType = filename === "index.html" ? contentTypes[filename] : contentTypes[path.extname(filename)];
  response.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-cache" });
  response.end(request.method === "HEAD" ? undefined : content);
}

const server = http.createServer(async (request, response) => {
  applySecurityHeaders(response);
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) await handleApi(request, response, url);
    else await serveStatic(request, response, url);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) console.error("Erro ao processar a solicitação:", error);
    if (!response.headersSent) sendJson(response, status, { error: status === 500 ? "Ocorreu um erro interno. Tente novamente." : error.message });
    else response.destroy();
  }
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  console.log(`Fluxo disponível em http://${HOST}:${address.port}`);
  console.log(`Banco de dados SQLite: ${DATABASE_PATH}`);
});

function closeServer() {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on("SIGINT", closeServer);
process.on("SIGTERM", closeServer);
