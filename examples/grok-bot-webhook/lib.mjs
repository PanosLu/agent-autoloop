// External command adapter for one official Grok Bot routine webhook.
// A 200 only means the call was accepted. The receipt is printed after the Bot submits a result for the same id.
// The webhook body is the id alone. The task is the fixed smoke record written here, never anything in the payload.
import { lookup } from "node:dns/promises";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import path from "node:path";

export const SMOKE_A = 6;
export const SMOKE_B = 7;
const ID_RE = /^[0-9a-f]{32}$/;
const RUN_RE = /^[0-9]{1,12}$/;
const MAX_JSON = 4096;
const DEFAULT_WAIT_MS = 180_000;
const MIN_WAIT_MS = 200;
const MAX_WAIT_MS = 600_000;
const POST_TIMEOUT_MS = 10_000;
const REQUEST_KEYS = ["a", "action", "b", "createdAt", "expiresAt", "id", "op", "pid", "run", "state", "v"];
const RESULT_KEYS = ["action", "id", "output", "submittedAt", "v"];
const STATES = new Set(["armed", "accepted", "aborted", "timedout", "done"]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function assertId(id) {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new Error("请求编号不合法");
  return id;
}

function assertRun(run) {
  if (typeof run !== "string" || !RUN_RE.test(run)) throw new Error("没跑成：缺少合法的轮次编号");
  return run;
}

function sameKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function inside(root, file) {
  const realRoot = realpathSync(root);
  const parent = realpathSync(path.dirname(file));
  const rel = path.relative(realRoot, parent);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("路径越界");
  return file;
}

function fileOf(home, kind, id) {
  assertId(id);
  const spool = path.join(home, "spool", kind);
  const file = path.resolve(spool, `${id}.json`);
  if (path.dirname(file) !== path.resolve(spool)) throw new Error("路径越界");
  return inside(home, file);
}

function requestFile(home, id) {
  return fileOf(home, "requests", id);
}

function resultFile(home, id) {
  return fileOf(home, "results", id);
}

function runFile(home, run) {
  assertRun(run);
  const file = path.resolve(path.join(home, "spool", "runs"), `${run}.json`);
  return inside(home, file);
}

function readCapped(file) {
  if (!existsSync(file)) return undefined;
  const st = lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error("记录不是普通文件");
  if (st.size > MAX_JSON) throw new Error("记录过大");
  return readFileSync(file, "utf8");
}

function readJson(file, keys) {
  const text = readCapped(file);
  if (text === undefined) return undefined;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("记录不是合法 JSON");
  }
  if (!sameKeys(value, keys)) throw new Error("记录字段不可信");
  return value;
}

function atomicWrite(file, value) {
  const dir = path.dirname(file);
  if (existsSync(file)) {
    const st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error("记录不是普通文件");
  }
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

function blocked(address) {
  const family = isIP(address);
  const list = new BlockList();
  if (family === 4) {
    for (const [network, bits] of [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.2.0", 24],
      ["192.168.0.0", 16],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
    ])
      list.addSubnet(network, bits);
    return list.check(address);
  }
  if (family === 6) {
    list.addAddress("::", "ipv6");
    list.addAddress("::1", "ipv6");
    list.addSubnet("fc00::", 7, "ipv6");
    list.addSubnet("fe80::", 10, "ipv6");
    list.addSubnet("2001:db8::", 32, "ipv6");
    return list.check(address, "ipv6");
  }
  return true;
}

function checkUrl(raw, loopback) {
  if (typeof raw !== "string" || raw.length < 12 || raw.length > 2048) throw new Error("webhook 地址不合法");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("webhook 地址不合法");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("webhook 地址不合法");
  if (loopback) {
    const port = Number(url.port);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("回环测试只允许 http://127.0.0.1 的具体端口");
    return url;
  }
  if (url.protocol !== "https:" || isIP(url.hostname) !== 0 || url.hostname === "localhost" || url.hostname.endsWith(".localhost"))
    throw new Error("webhook 必须是公网 https 域名");
  return url;
}

export function openHome(input) {
  if (typeof input !== "string" || !path.isAbsolute(input)) throw new Error("GROK_BOT_HOME 必须是绝对路径");
  const home = path.resolve(input);
  // /tmp/name and /home/name are still shared locations. A dedicated directory is at least one level deeper.
  if (home.split(path.sep).filter(Boolean).length < 3) throw new Error("GROK_BOT_HOME 必须是专用目录");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const root = lstatSync(home);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("GROK_BOT_HOME 必须是真实目录");
  chmodSync(home, 0o700);
  for (const rel of ["spool", "spool/requests", "spool/results", "spool/runs", "spool/locks"]) {
    const dir = path.join(home, rel);
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error("目录结构被替换");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const relPath = path.relative(realpathSync(home), realpathSync(dir));
    if (relPath.startsWith("..") || path.isAbsolute(relPath)) throw new Error("目录越界");
    chmodSync(dir, 0o700);
  }
  return home;
}

export function loadConfig(home) {
  const file = path.join(home, "webhook.json");
  let st;
  try {
    st = lstatSync(file);
  } catch {
    throw new Error("找不到 webhook 配置");
  }
  if (!st.isFile() || st.isSymbolicLink()) throw new Error("webhook 配置必须是普通文件");
  if ((st.mode & 0o077) !== 0) throw new Error("webhook 配置权限过宽，需要 0600");
  if (st.size > 8192) throw new Error("webhook 配置过大");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error("webhook 配置不是合法 JSON");
  }
  if (!sameKeys(parsed, parsed.loopback === undefined ? ["bearer", "url"] : ["bearer", "loopback", "url"]))
    throw new Error("webhook 配置有多余字段");
  if (parsed.loopback !== undefined && typeof parsed.loopback !== "boolean") throw new Error("loopback 不合法");
  const bearer = parsed.bearer;
  if (typeof bearer !== "string" || bearer.length < 8 || bearer.length > 4096 || /[\u0000-\u001f\u007f]/.test(bearer))
    throw new Error("webhook 密钥不合法");
  const url = checkUrl(parsed.url, parsed.loopback === true);
  return { url, bearer, loopback: parsed.loopback === true };
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function withLock(home, name, fn) {
  if (!/^(?:run-[0-9]{1,12}|[0-9a-f]{32})$/.test(name)) throw new Error("锁名称不合法");
  const lock = path.join(home, "spool", "locks", name);
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner = 0;
      try {
        owner = Number(readFileSync(path.join(lock, "pid"), "utf8"));
      } catch {
        owner = 0;
      }
      if (!alive(owner) && Date.now() - started > 200) rmSync(lock, { recursive: true, force: true });
      if (Date.now() - started > 5_000) throw new Error("记录锁被占用");
    }
  }
  try {
    writeFileSync(path.join(lock, "pid"), String(process.pid), { mode: 0o600 });
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function validateRequest(value, id) {
  if (
    !value ||
    value.v !== 1 ||
    value.id !== id ||
    !RUN_RE.test(value.run) ||
    value.action !== "smoke" ||
    value.a !== SMOKE_A ||
    value.b !== SMOKE_B ||
    value.op !== "add" ||
    !STATES.has(value.state) ||
    !Number.isInteger(value.pid) ||
    !Number.isSafeInteger(value.createdAt) ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= value.createdAt
  )
    throw new Error("待办记录不可信");
  return value;
}

function loadRequest(home, id) {
  assertId(id);
  const value = readJson(requestFile(home, id), REQUEST_KEYS);
  if (!value) return undefined;
  return validateRequest(value, id);
}

function loadResult(home, id) {
  const value = readJson(resultFile(home, id), RESULT_KEYS);
  if (!value) return undefined;
  if (value.v !== 1 || value.id !== id || value.action !== "smoke" || value.output !== SMOKE_A + SMOKE_B)
    throw new Error("回执记录不可信");
  if (!Number.isSafeInteger(value.submittedAt)) throw new Error("回执记录不可信");
  return value;
}

function saveRequest(home, record) {
  validateRequest(record, record.id);
  atomicWrite(requestFile(home, record.id), record);
}

function receiptOf(result) {
  if (result.output !== SMOKE_A + SMOKE_B) throw new Error("回执和可信任务不一致");
  return `smoke 完成：${SMOKE_A}+${SMOKE_B}=${result.output}`;
}

function finishedText(home, id) {
  const request = loadRequest(home, id);
  const result = loadResult(home, id);
  if (!request || request.state !== "done" || !result) return undefined;
  return receiptOf(result);
}

function plan(home, run, waitMs) {
  return withLock(home, `run-${run}`, () => {
    const pointer = readJson(runFile(home, run), ["id"]);
    const current = pointer ? loadRequest(home, assertId(pointer.id)) : undefined;
    const text = current ? finishedText(home, current.id) : undefined;
    if (text) return { kind: "done", text };
    const now = Date.now();
    if (current && (current.state === "accepted" || (current.state === "armed" && alive(current.pid))) && now < current.expiresAt)
      return { kind: current.state === "accepted" ? "wait" : "peer", id: current.id };
    const id = randomBytes(16).toString("hex");
    const record = {
      v: 1,
      id,
      run,
      action: "smoke",
      a: SMOKE_A,
      b: SMOKE_B,
      op: "add",
      state: "armed",
      pid: process.pid,
      createdAt: now,
      expiresAt: now + waitMs + 15_000,
    };
    saveRequest(home, record);
    atomicWrite(runFile(home, run), { id });
    return { kind: "post", id };
  });
}

async function resolvePublic(url) {
  const records = await lookup(url.hostname, { all: true, verbatim: true });
  if (records.length === 0 || records.some((record) => blocked(record.address))) throw new Error("webhook 地址不能指向内网");
  return records[0];
}

function postBody(target, bearer, requestId, address) {
  const body = Buffer.from(JSON.stringify({ requestId }));
  const lib = target.protocol === "https:" ? https : http;
  const options = {
    host: address?.address ?? target.hostname,
    servername: target.protocol === "https:" ? target.hostname : undefined,
    family: address?.family,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    path: target.pathname,
    method: "POST",
    headers: {
      host: target.host,
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      "content-length": body.length,
    },
    timeout: POST_TIMEOUT_MS,
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, status) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(status);
    };
    const req = lib.request(options, (res) => {
      const status = res.statusCode ?? 0;
      res.on("data", () => {});
      res.on("end", () => finish(null, status));
      res.on("error", () => finish(null, status));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (error) => finish(error));
    req.end(body);
  });
}

function mark(home, id, state) {
  return withLock(home, id, () => {
    const request = loadRequest(home, id);
    if (!request) return "missing";
    if (request.state === "done") return "done";
    const allowed =
      (state === "accepted" && request.state === "armed") ||
      ((state === "aborted" || state === "timedout") && (request.state === "armed" || request.state === "accepted"));
    if (!allowed) return request.state;
    request.state = state;
    saveRequest(home, request);
    return state;
  });
}

async function pollUntil(deadline, read) {
  while (Date.now() < deadline) {
    const found = read();
    if (found !== undefined) return found;
    await sleep(50);
  }
  return undefined;
}

function waitMsOf(raw) {
  if (raw === undefined || raw === "") return DEFAULT_WAIT_MS;
  if (!/^[0-9]+$/.test(raw)) throw new Error("没跑成：等待时限不合法");
  const value = Number(raw);
  if (value < MIN_WAIT_MS || value > MAX_WAIT_MS) throw new Error("没跑成：等待时限不合法");
  return value;
}

export async function runRound({ home: homeInput, run: runInput, waitMs: waitInput }) {
  const home = openHome(homeInput);
  const config = loadConfig(home);
  const run = assertRun(runInput);
  const waitMs = waitMsOf(waitInput);
  const decided = plan(home, run, waitMs);
  if (decided.kind === "done") return decided.text;
  const deadline = Date.now() + waitMs;
  if (decided.kind === "post") {
    let status = 0;
    try {
      const address = config.loopback ? undefined : await resolvePublic(config.url);
      status = await postBody(config.url, config.bearer, decided.id, address);
    } catch {
      mark(home, decided.id, "aborted");
      throw new Error("没跑成：webhook 没有连上，运行没有开始");
    }
    if (status >= 300 && status < 400) {
      mark(home, decided.id, "aborted");
      throw new Error("没跑成：webhook 要求跳转，已拒绝");
    }
    if (status !== 200) {
      mark(home, decided.id, "aborted");
      throw new Error(`没跑成：webhook 返回 ${status}，运行没有开始`);
    }
    const state = mark(home, decided.id, "accepted");
    if (state !== "accepted") throw new Error("没跑成：这一轮在被接受前已经结束");
  } else {
    const accepted = await pollUntil(deadline, () => {
      const request = loadRequest(home, decided.id);
      if (!request || request.state === "aborted" || request.state === "timedout") return false;
      if (request.state === "accepted" || request.state === "done") return true;
      return undefined;
    });
    if (accepted !== true) throw new Error("没跑成：上一次调用没有被接受");
  }
  const text = await pollUntil(deadline, () => finishedText(home, decided.id));
  if (text) return text;
  const state = withLock(home, decided.id, () => {
    const request = loadRequest(home, decided.id);
    if (!request) return "missing";
    if (request.state === "done") return "done";
    request.state = "timedout";
    saveRequest(home, request);
    return "timedout";
  });
  if (state === "done") {
    const late = finishedText(home, decided.id);
    if (late) return late;
  }
  throw new Error("没跑成：等到时限还没有回执，接受不等于做完");
}

export function showRequest(homeInput, id) {
  const home = openHome(homeInput);
  let request;
  try {
    request = loadRequest(home, id);
  } catch (error) {
    if (error.message === "请求编号不合法") throw error;
    throw new Error("待办记录不可信");
  }
  if (!request) throw new Error("没有这张待办");
  if (request.state !== "accepted" && request.state !== "done") throw new Error("这张待办还不能做");
  if (request.state === "accepted" && Date.now() >= request.expiresAt) throw new Error("这张待办已过期");
  return { id: request.id, action: "smoke", a: request.a, b: request.b, op: request.op, status: request.state };
}

function parseOutput(raw) {
  if (typeof raw !== "string" || !/^(0|[1-9][0-9]{0,8})$/.test(raw)) throw new Error("结果不是允许的整数");
  return Number(raw);
}

export function submitResult(homeInput, id, rawOutput) {
  const home = openHome(homeInput);
  const output = parseOutput(rawOutput);
  return withLock(home, assertId(id), () => {
    let request;
    try {
      request = loadRequest(home, id);
    } catch (error) {
      if (error.message === "请求编号不合法") throw error;
      throw new Error("待办记录不可信");
    }
    if (!request) throw new Error("没有这张待办");
    const existing = existsSync(resultFile(home, id)) ? loadResult(home, id) : undefined;
    if (request.state === "done" && existing && existing.output === output) return { ok: true, id, idempotent: true };
    if (existing && existing.output !== output) throw new Error("重复提交的结果不一致");
    if (request.state !== "accepted") throw new Error("这张待办不在可提交状态");
    if (Date.now() >= request.expiresAt) {
      request.state = "timedout";
      saveRequest(home, request);
      throw new Error("这张待办已过期");
    }
    if (output !== SMOKE_A + SMOKE_B) throw new Error("结果和可信任务不一致");
    atomicWrite(resultFile(home, id), {
      v: 1,
      id,
      action: "smoke",
      output,
      submittedAt: Date.now(),
    });
    request.state = "done";
    saveRequest(home, request);
    return { ok: true, id, idempotent: false };
  });
}
