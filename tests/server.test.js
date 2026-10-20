"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const test = require("node:test");

test("autenticação, histórico privado e persistência de processos", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fluxo-test-"));
  const child = spawn(process.execPath, [path.join(__dirname, "..", "backend", "server.js")], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: "0", DB_PATH: path.join(tempDir, "test.sqlite") },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  let baseUrl;
  for (let attempt = 0; attempt < 80 && !baseUrl; attempt += 1) {
    const address = output.match(/disponível em (http:\/\/127\.0\.0\.1:\d+)/);
    if (address) {
      baseUrl = address[1];
      break;
    }
    if (child.exitCode !== null) throw new Error(`Servidor encerrou inesperadamente:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(baseUrl, `O servidor não iniciou a tempo:\n${output}`);

  const request = (route, options = {}) => fetch(`${baseUrl}${route}`, options);
  const json = (method, payload, cookie, origin = baseUrl) => ({
    method,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      Origin: origin
    },
    body: JSON.stringify(payload)
  });
  const cookieFrom = (response) => response.headers.get("set-cookie").split(";")[0];
  const assertStatus = async (response, status) => {
    assert.equal(response.status, status, await response.clone().text());
  };
  const register = async (name, email) => {
    const response = await request("/api/auth/register", json("POST", { name, email, password: "senha-segura-123" }));
    await assertStatus(response, 201);
    return cookieFrom(response);
  };

  const homepage = await request("/");
  assert.equal(homepage.status, 200);
  assert.match(await homepage.text(), /Fluxo/);
  assert.equal((await request("/login/")).status, 200);
  assert.equal((await request("/register/")).status, 200);
  assert.equal((await request("/mapping/")).status, 200);
  assert.equal((await request("/workspace/")).status, 200);
  for (const asset of [
    "/home/home.css", "/home/home.js", "/login/login.css", "/login/login.js",
    "/register/register.css", "/register/register.js", "/mapping/mapping.css", "/mapping/mapping.js",
    "/workspace/workspace.css", "/workspace/workspace.js"
  ]) assert.equal((await request(asset)).status, 200, `${asset} deve ser servido`);
  assert.equal((await request("/backend/server.js")).status, 404);
  assert.equal((await request("/home/../backend/server.js")).status, 404);
  assert.equal((await request("/api/processes")).status, 401);
  assert.deepEqual(await (await request("/api/auth/me")).json(), { user: null });
  assert.equal((await request("/api/auth/register", json("POST", { name: "A", email: "invalido", password: "curta" }))).status, 400);
  assert.equal((await request("/api/auth/register", json("POST", { name: "Teste", email: "x@y.com", password: "senha-segura-123" }, null, "http://site-malicioso.test"))).status, 403);

  const userACookie = await register("Pessoa A", "pessoa.a@example.com");
  assert.equal((await request("/api/auth/register", json("POST", { name: "Outro nome", email: "pessoa.a@example.com", password: "senha-segura-123" }))).status, 409);
  const create = await request("/api/processes", json("POST", {
    name: "Aprovação de compra",
    status: "Pendente",
    steps: [{ type: "Atividade", name: "Revisar pedido" }, { type: "Decisão", name: "Aprovar?" }]
  }, userACookie));
  await assertStatus(create, 201);
  const savedProcess = (await create.json()).process;
  assert.equal(savedProcess.steps.length, 2);

  const userBCookie = await register("Pessoa B", "pessoa.b@example.com");
  const userBProcesses = await request("/api/processes", { headers: { Cookie: userBCookie } });
  assert.deepEqual((await userBProcesses.json()).processes, []);
  const crossAccountUpdate = await request(`/api/processes/${savedProcess.id}`, json("PUT", {
    name: "Alteração indevida",
    status: "Finalizado",
    steps: []
  }, userBCookie));
  assert.equal(crossAccountUpdate.status, 404);

  const ownProcesses = await request("/api/processes", { headers: { Cookie: userACookie } });
  assert.equal((await ownProcesses.json()).processes[0].id, savedProcess.id);
  await request("/api/auth/logout", json("POST", {}, userACookie));
  assert.deepEqual(await (await request("/api/auth/me", { headers: { Cookie: userACookie } })).json(), { user: null });

  const login = await request("/api/auth/login", json("POST", { email: "pessoa.a@example.com", password: "senha-segura-123" }));
  assert.equal(login.status, 200);
  const loginCookie = cookieFrom(login);
  const restoredProcesses = await request("/api/processes", { headers: { Cookie: loginCookie } });
  assert.equal((await restoredProcesses.json()).processes.length, 1);
  assert.equal((await request("/api/auth/login", json("POST", { email: "pessoa.a@example.com", password: "incorreta-123" }))).status, 401);
});
