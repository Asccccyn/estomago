// Independent E processes share an isolated SQLite database. Only the judge and
// the response timing are synthetic; every binding goes through the M registry.
import assert from "node:assert/strict"
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createServer } from "node:http"
import { spawn, execFileSync } from "node:child_process"
import { once } from "node:events"
import { DatabaseSync } from "node:sqlite"

const script = import.meta.dirname,
  repo = resolve(script, "../../..")
const mrepo = process.env.PROBE_M_REPO ?? resolve(repo, "../mariposa")
const python = process.env.PROBE_PYTHON ?? join(mrepo, ".venv/bin/python")
const work = mkdtempSync(join(tmpdir(), "bind-e2e-"))
const mroot = join(work, "mariposa")
mkdirSync(mroot)
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: tmpdir(),
  LANG: "en_US.UTF-8",
  PYTHONDONTWRITEBYTECODE: "1",
}
const menv = {
  ...env,
  MARIPOSA_ROOT: mroot,
  MARIPOSA_ALLOW_CREATE: "1",
  MARIPOSA_GATE_RATE_WRITE_PER_MIN: "6000",
  MARIPOSA_GATE_RATE_READ_PER_MIN: "6000",
}
const token = execFileSync(python, [join(script, "seed_m.py"), mroot, mrepo], {
  env: menv,
  encoding: "utf8",
}).trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, label, ms = 14000) {
  const deadline = Date.now() + ms
  do {
    if (await fn()) return
    await sleep(45)
  } while (Date.now() < deadline)
  throw Error("Timed out: " + label)
}
const children = new Set()
function launch(executable, args, cwd, env) {
  const child = spawn(executable, args, {
    cwd,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  })
  let errors = ""
  child.stderr.on("data", (b) => {
    errors = (errors + b).slice(-1500)
  })
  const exit = once(child, "exit")
  children.add(child)
  exit.then(() => children.delete(child))
  return { child, exit, errors: () => errors }
}
async function stop(p) {
  p.child.kill("SIGTERM")
  await until(
    () => p.child.exitCode !== null || p.child.signalCode !== null,
    "shutdown",
    17000,
  )
  assert.equal((await p.exit)[0], 0, p.errors())
}
async function port() {
  const s = createServer()
  s.listen(0, "127.0.0.1")
  await once(s, "listening")
  const result = s.address().port
  await new Promise((r) => s.close(r))
  return result
}
const mport = await port(),
  murl = "http://127.0.0.1:" + mport
let mode = "normal",
  intercept = false,
  judgeCalls = 0,
  bindCalls = 0
const proxy = createServer(async (req, res) => {
  const body = []
  for await (const c of req) body.push(c)
  const raw = Buffer.concat(body)
  const send = (n, data) => {
    res.writeHead(n, { "content-type": "application/json" })
    res.end(JSON.stringify(data))
  }
  if (req.url === "/chat/completions") {
    judgeCalls++
    if (mode === "hold_judge") {
      intercept = true
      return
    }
    if (mode === "402") {
      send(402, { error: { message: "synthetic balance" } })
      return
    }
    const mid = raw.toString().match(/probe body (probe_[a-g])/)?.[1]
    const prefix = mid === "probe_f" ? "sm_msg_" : "msg_"
    const id = (n) => prefix + mid + "_" + n
    send(200, {
      choices: [
        {
          message: {
            content: JSON.stringify({
              match: true,
              ranges: [
                { start: id(1), end: id(1) },
                { start: id(3), end: id(4) },
              ],
            }),
          },
        },
      ],
    })
    return
  }
  const bind = req.url === "/api/capability/source.binding.bind"
  if (bind) {
    bindCalls++
    if (mode === "hold_before") {
      intercept = true
      return
    }
    if (mode === "503") {
      send(503, { error: { code: "UNAVAILABLE" } })
      return
    }
  }
  try {
    const up = await fetch(murl + req.url, {
      method: "POST",
      headers: {
        authorization: req.headers.authorization,
        "content-type": "application/json",
      },
      body: raw,
    })
    const data = await up.json()
    if (bind && mode === "hold_after" && data.ok) {
      intercept = true
      return
    }
    if (bind && mode === "lost" && data.ok) { send(503, {error:{code:"UNAVAILABLE"}}); return }
    send(up.status, data)
  } catch {
    send(502, { error: { code: "PROXY_UNAVAILABLE" } })
  }
})
let origin
function inspect(root, mid) {
  const db = new DatabaseSync(join(root, "data/chat.sqlite3"), {
    readOnly: true,
  })
  try {
    return db
      .prepare("SELECT * FROM source_bind_jobs WHERE memory_id=?")
      .get(mid)
  } finally {
    db.close()
  }
}
async function mcall(cap, args) {
  const r = await fetch(murl + "/api/capability/" + cap, {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ arguments: args }),
  })
  const answer = await r.json()
  assert.ok(answer.ok, JSON.stringify(answer.error))
  return answer.data
}
async function start(root) {
  const p = await port(),
    cfg = join(root, "config/estomago.yaml")
  writeFileSync(
    cfg,
    `runtime:\n  provider: mock\nintegrations:\n  mariposa:\n    base_url: "${origin}"\n    credential_ref: PROBE_M_TOKEN\nsource_binding:\n  enabled: true\n  api_key_env: PROBE_JUDGE_KEY\n  base_url: "${origin}"\n  model: synthetic\n`,
  )
  const proc = launch(
    process.execPath,
    [
      "--import",
      join(script, "clock.mjs"),
      join(repo, "apps/host/src/main.ts"),
      "--port",
      String(p),
      "--config",
      cfg,
    ],
    repo,
    {
      ...env,
      ESTOMAGO_HOME: root,
      ESTOMAGO_TEST_MODE: "1",
      PROBE_JUDGE_KEY: "synthetic",
      PROBE_M_TOKEN: token,
    },
  )
  const url = "http://127.0.0.1:" + p
  await until(async () => {
    if (proc.child.exitCode !== null) throw Error(proc.errors())
    try {
      return (await fetch(url + "/health/live")).ok
    } catch {
      return false
    }
  }, "E live")
  const login = await fetch(url + "/api/v1/auth/login", {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({
      token: readFileSync(join(root, "config/auth.token"), "utf8").trim(),
    }),
  })
  assert.ok(login.ok)
  const cookie = login.headers.get("set-cookie").split(";")[0]
  const api = async (path, args) => {
    const response = await fetch(url + "/api/v1/calendar/" + path, {
      method: args ? "POST" : "GET",
      headers: { cookie, origin: url, "content-type": "application/json" },
      ...(args ? { body: JSON.stringify(args) } : {}),
    })
    assert.equal(response.status, 200)
    return response.json()
  }
  return { ...proc, api, url, cookie }
}
try {
  launch(
    python,
    [
      "-m",
      "uvicorn",
      "backend.mariposa.app:app",
      "--host",
      "127.0.0.1",
      "--port",
      String(mport),
      "--log-level",
      "warning",
    ],
    mrepo,
    menv,
  )
  await until(async () => {
    try {
      return (await fetch(murl + "/health")).ok
    } catch {
      return false
    }
  }, "M live")
  proxy.listen(0, "127.0.0.1")
  await once(proxy, "listening")
  origin = "http://127.0.0.1:" + proxy.address().port
  for (const [mid, initial] of [
    ["probe_a", "normal"],
    ["probe_b", "hold_before"],
    ["probe_c", "hold_after"],
    ["probe_d", "503"],
    ["probe_e", "hold_judge"],
    ["probe_f", "402"],
    ["probe_g", "lost"],
  ]) {
    const root = join(work, mid)
    mkdirSync(join(root, "config"), { recursive: true })
    if (mid !== "probe_f")
      execFileSync(process.execPath, [join(script, "seed.mjs"), root, mid], {
        env,
      })
    mode = initial
    intercept = false
    judgeCalls = 0
    bindCalls = 0
    let e = await start(root)
    const items = async () =>
      (await e.api("day/items?source=memory&date=2026-01-01")).items
    const retry = async () => {
      const row = (await items()).find((x) => x.source_ref.id === mid)
      assert.ok(row)
      return e.api("memory/recalculate", {
        memory_id: mid,
        revision: row.revision,
      })
    }
    if (initial.startsWith("hold_")) {
      await until(() => intercept, initial)
      const waiting = inspect(root, mid)
      if (initial !== "hold_judge")
        assert.equal(JSON.parse(waiting.pending_segments_json).length, 2)
      await stop(e)
      mode = "normal"
      e = await start(root)
      if (initial === "hold_judge") {
        await until(
          () => inspect(root, mid)?.status === "failed",
          "interrupted judge waits for owner",
        )
        assert.equal(judgeCalls, 1)
        await retry()
      }
    }
    if (initial === "503" || initial === "lost") {
      await until(
        () => inspect(root, mid)?.status === "failed",
        "single failure",
      )
      await sleep(1700)
      assert.equal(judgeCalls, 1)
      assert.equal(bindCalls, 1)
      assert.match(inspect(root, mid).detail, /503/)
      mode = "normal"
      await retry()
    }
    if (mid === "probe_f") {
      assert.equal((await retry()).status, "credential_blocked")
      assert.equal((await retry()).status, "credential_blocked")
      mode = "normal"
      const computed = await retry()
      assert.equal(computed.status, "bound", computed.detail)
    }
    await until(
      () => inspect(root, mid)?.status === "bound",
      "completed " + mid,
    )
    const local = inspect(root, mid),
      ids = JSON.parse(local.binding_ids_json)
    const state = await mcall("source.bindings.of_memory", {
      memory_id: mid,
      operation_id: local.operation_id,
    })
    assert.deepEqual(state.receipt.binding_ids, ids)
    assert.deepEqual(
      state.bindings.map((b) => b.binding_id).sort(),
      [...ids].sort(),
    )
    const db = new DatabaseSync(
      join(mroot, "runtime/formal/mariposa.sqlite3"),
      { readOnly: true },
    )
    try {
      assert.deepEqual(
        ids.map((id) =>
          db.prepare(
            "SELECT source_message_id FROM memory_source_binding_members WHERE binding_id=? ORDER BY ordinal",
          )
            .all(id)
            .map((r) => r.source_message_id),
        ),
        [[1], [3, 4]].map((g) => g.map((n) => "sm_msg_" + mid + "_" + n)),
      )
    } finally {
      db.close()
    }
    assert.equal(
      judgeCalls,
      mid === "probe_f" ? 3 : ["503", "hold_judge"].includes(initial) ? 2 : 1,
    )
    assert.equal(
      (await items()).find((x) => x.source_ref.id === mid).source_count,
      2,
    )
    console.log(
      "PASS",
      mid,
      initial,
      "judge",
      judgeCalls,
      "segments",
      ids.length,
    )
    await stop(e)
  }
} finally {
  const exits = [...children].map((c) => once(c, "exit"))
  for (const c of children) c.kill("SIGKILL")
  await Promise.allSettled(exits)
  proxy.closeAllConnections()
  proxy.close()
  rmSync(work, { recursive: true, force: true })
}
