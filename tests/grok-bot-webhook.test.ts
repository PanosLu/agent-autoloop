// Failure modes: HTTP 200 is treated as the Bot having finished; a timeout or a non-200 still prints a successful
// receipt; a second submit changes the result; an id, path, or payload can choose a task or write outside the spool;
// the Bearer or the caller's prompt is copied into argv output or the task record. The command adapter must only
// accept a receipt that the built-in parser already understands. A fixed script must not invent the sum.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import command from "../plugins/command/agent.ts";
import { readMessage, resultFrom } from "../worker/contract.ts";

const ADAPTER = join(import.meta.dirname, "..", "examples", "grok-bot-webhook");
const SECRET = "test-bearer-do-not-leak-9f3a";
const scratch = mkdtempSync(join(tmpdir(), "grok-bot-webhook-"));
const children = new Set<ReturnType<typeof spawn>>();

after(() => {
  for (const child of children) child.kill("SIGKILL");
  rmSync(scratch, { recursive: true, force: true });
});

type Seen = { authorization?: string; body: string };
type Running = {
  child: ReturnType<typeof spawn>;
  exited: Promise<number | null>;
  output: () => { out: string; err: string };
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeConfig(home: string, url: string, mode = 0o600, loopback = true) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const body = JSON.stringify(loopback ? { url, bearer: SECRET, loopback: true } : { url, bearer: SECRET });
  writeFileSync(join(home, "webhook.json"), body, { mode });
}

function mock(status: number) {
  const requests: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({ authorization: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(status);
      res.end();
    });
  });
  return new Promise<{ server: Server; requests: Seen[]; url: string }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, requests, url: `http://127.0.0.1:${port}/hook` });
    });
  });
}

function close(server: Server) {
  return new Promise((resolve) => server.close(resolve));
}

function launch(home: string, run: string, wait: string, args: string[] = []): Running {
  const child = spawn(process.execPath, [join(ADAPTER, "wait-receipt.mjs"), ...args], {
    env: {
      HOME: home,
      TMPDIR: home,
      GROK_BOT_HOME: home,
      GROK_BOT_WAIT_MS: wait,
      AGENT_AUTOLOOP_RUN: run,
    },
  });
  children.add(child);
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { child, exited, output: () => ({ out, err }) };
}

function runScript(name: string, home: string, args: string[]) {
  return spawnSync(process.execPath, [join(ADAPTER, name), ...args], {
    encoding: "utf8",
    env: { HOME: home, TMPDIR: home, GROK_BOT_HOME: home },
  });
}

function add(a: unknown, b: unknown) {
  assert.equal(typeof a, "number");
  assert.equal(typeof b, "number");
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      "const [a,b]=process.argv.slice(1).map(Number); if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)) process.exit(2); process.stdout.write(String(a+b))",
      String(a),
      String(b),
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  return child.stdout;
}

async function untilCount(requests: Seen[], count: number) {
  for (let i = 0; i < 100 && requests.length < count; i += 1) await sleep(20);
  assert.equal(requests.length >= count, true);
}

function spoolText(home: string) {
  const root = join(home, "spool");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, name.name);
      if (name.isDirectory()) walk(file);
      else if (name.isFile()) files.push(readFileSync(file, "utf8"));
    }
  };
  walk(root);
  return files.join("\n");
}

function assertHidden(text: string) {
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes("please-delete-everything"), false);
  assert.equal(text.includes("https://evil.example"), false);
}

test("a real submit completes the smoke receipt and a repeat does not call again", async () => {
  const home = join(scratch, "ok");
  const hook = await mock(200);
  writeConfig(home, hook.url);
  const running = launch(home, "41", "8000", ["please-delete-everything", "https://evil.example/hook"]);
  try {
    await untilCount(hook.requests, 1);
    await sleep(200);
    assert.equal(running.child.exitCode, null, "200 must leave the waiter running");
    const shown = runScript("show-request.mjs", home, [JSON.parse(hook.requests[0].body).requestId]);
    assert.equal(shown.status, 0, shown.stderr);
    const task = JSON.parse(shown.stdout);
    assert.deepEqual(Object.keys(task).sort(), ["a", "action", "b", "id", "op", "status"]);
    assert.equal(task.action, "smoke");
    assert.equal(task.status, "accepted");
    assert.equal(shown.stdout.includes("13"), false);
    const sum = add(task.a, task.b);
    const submitted = runScript("submit-result.mjs", home, [task.id, sum]);
    assert.equal(submitted.status, 0, submitted.stderr);
    const again = runScript("submit-result.mjs", home, [task.id, sum]);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout).idempotent, true);
    const changed = runScript("submit-result.mjs", home, [task.id, "14"]);
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /不一致/);
    const code = await running.exited;
    const { out, err } = running.output();
    assert.equal(code, 0, err);
    assert.equal(out, "smoke 完成：6+7=13\n");
    assert.equal(err, "");
    const body = JSON.parse(hook.requests[0].body);
    assert.deepEqual(Object.keys(body), ["requestId"]);
    assert.equal(hook.requests[0].authorization, `Bearer ${SECRET}`);
    assert.equal(hook.requests.length, 1);
    assertHidden(`${out}\n${err}\n${spoolText(home)}`);
    const reading = command.read(out, 0, err);
    assert.equal(reading.text, out);
    const message = readMessage(reading.text ?? "");
    assert.equal(message.outcome, "done");
    assert.equal(message.problem, undefined);
    const handed = resultFrom(message, {});
    assert.equal(handed.problem, undefined);
    assert.equal(handed.result.outcome, "done");
    assert.equal(handed.result.summary, "smoke 完成：6+7=13");
    const repeat = launch(home, "41", "8000");
    assert.equal(await repeat.exited, 0);
    assert.equal(repeat.output().out, out);
    assert.equal(hook.requests.length, 1);
  } finally {
    running.child.kill("SIGKILL");
    await close(hook.server);
  }
});

test("a non-200 does not start a successful receipt", async () => {
  const home = join(scratch, "http");
  const hook = await mock(503);
  writeConfig(home, hook.url);
  const running = launch(home, "42", "8000");
  try {
    const code = await running.exited;
    const { out, err } = running.output();
    assert.equal(code, 2);
    assert.equal(out, "");
    assert.match(err, /^没跑成：webhook 返回 503，运行没有开始\n$/);
    assert.equal(err.includes(SECRET), false);
    const reading = command.read(out, code, err);
    assert.equal(reading.text, undefined);
    assert.match(reading.error ?? "", /没跑成/);
    const id = JSON.parse(hook.requests[0].body).requestId;
    const shown = runScript("show-request.mjs", home, [id]);
    assert.notEqual(shown.status, 0);
    assert.match(shown.stderr, /还不能做/);
    assert.equal(readdirSync(join(home, "spool", "results")).length, 0);
  } finally {
    await close(hook.server);
  }
});

test("acceptance without a submit times out and a late submit is refused", async () => {
  const home = join(scratch, "timeout");
  const hook = await mock(200);
  writeConfig(home, hook.url);
  const running = launch(home, "43", "2000");
  try {
    await untilCount(hook.requests, 1);
    await sleep(200);
    assert.equal(running.child.exitCode, null);
    const code = await running.exited;
    const { out, err } = running.output();
    assert.equal(code, 2);
    assert.equal(out, "");
    assert.match(err, /没跑成：等到时限还没有回执，接受不等于做完/);
    const id = JSON.parse(hook.requests[0].body).requestId;
    const late = runScript("submit-result.mjs", home, [id, "13"]);
    assert.notEqual(late.status, 0);
    assert.match(late.stderr, /不在可提交状态/);
    assert.equal(late.stdout.includes("smoke 完成"), false);
    const retry = launch(home, "43", "8000");
    await untilCount(hook.requests, 2);
    assert.equal(hook.requests.length, 2);
    const next = JSON.parse(hook.requests[1].body).requestId;
    assert.notEqual(next, id);
    const task = JSON.parse(runScript("show-request.mjs", home, [next]).stdout);
    const submitted = runScript("submit-result.mjs", home, [next, add(task.a, task.b)]);
    assert.equal(submitted.status, 0, submitted.stderr);
    assert.equal(await retry.exited, 0);
    assert.equal(retry.output().out, "smoke 完成：6+7=13\n");
  } finally {
    running.child.kill("SIGKILL");
    await close(hook.server);
  }
});

test("malicious ids, tampered tasks, wide config, and escaped paths are refused", async () => {
  const home = join(scratch, "malicious");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const outside = join(scratch, "outside.txt");
  writeFileSync(outside, "keep");
  for (const id of ["../etc/passwd", "..", "abcd", `${"ab".repeat(16)}/../../x`, "AB".repeat(16)]) {
    const shown = runScript("show-request.mjs", home, [id]);
    const submitted = runScript("submit-result.mjs", home, [id, "13"]);
    assert.notEqual(shown.status, 0);
    assert.notEqual(submitted.status, 0);
    assert.match(shown.stderr, /不合法|用法/);
    assert.equal(shown.stdout, "");
    assert.equal(outside, join(scratch, "outside.txt"));
    assert.equal(readFileSync(outside, "utf8"), "keep");
  }
  const unknown = runScript("show-request.mjs", home, ["cd".repeat(16)]);
  assert.match(unknown.stderr, /没有这张待办/);
  const planted = "ef".repeat(16);
  const request = join(home, "spool", "requests", `${planted}.json`);
  writeFileSync(request, JSON.stringify({ id: planted, action: "delete", command: "rm -rf /", status: "accepted" }), {
    mode: 0o600,
  });
  const tampered = runScript("show-request.mjs", home, [planted]);
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /不可信/);
  assert.equal(`${tampered.stdout}${tampered.stderr}`.includes("rm -rf"), false);
  const expiredId = "11".repeat(16);
  const now = Date.now();
  writeFileSync(
    join(home, "spool", "requests", `${expiredId}.json`),
    JSON.stringify({
      v: 1,
      id: expiredId,
      run: "9",
      action: "smoke",
      a: 6,
      b: 7,
      op: "add",
      state: "accepted",
      pid: 1,
      createdAt: now - 10_000,
      expiresAt: now - 1000,
    }),
    { mode: 0o600 },
  );
  assert.match(runScript("show-request.mjs", home, [expiredId]).stderr, /已过期/);
  assert.match(runScript("submit-result.mjs", home, [expiredId, "13"]).stderr, /已过期/);
  const linked = "22".repeat(16);
  writeFileSync(
    join(home, "spool", "requests", `${linked}.json`),
    JSON.stringify({
      v: 1,
      id: linked,
      run: "10",
      action: "smoke",
      a: 6,
      b: 7,
      op: "add",
      state: "accepted",
      pid: 1,
      createdAt: now,
      expiresAt: now + 60_000,
    }),
    { mode: 0o600 },
  );
  symlinkSync(outside, join(home, "spool", "results", `${linked}.json`));
  const escaped = runScript("submit-result.mjs", home, [linked, "13"]);
  assert.notEqual(escaped.status, 0);
  assert.equal(readFileSync(outside, "utf8"), "keep");
  const wide = join(scratch, "wide");
  const hook = await mock(200);
  writeConfig(wide, hook.url, 0o644);
  const running = launch(wide, "44", "8000");
  try {
    assert.equal(await running.exited, 2);
    assert.match(running.output().err, /权限过宽/);
    assert.equal(hook.requests.length, 0);
    assert.equal(running.output().err.includes(SECRET), false);
  } finally {
    await close(hook.server);
  }
});
