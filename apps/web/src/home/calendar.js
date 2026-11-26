const element = (id) => document.getElementById(id)
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
}).format(new Date())
let date = today
let month = date.slice(0, 7)
let nextCursor = null
let dayLoad = 0
let monthLoad = 0
const working = new Set()
if (new URLSearchParams(location.search).get("season") === "summer")
  element("back").href = "/home/index.html?season=summer"

async function request(url, options) {
  const res = await fetch("/api/v1/calendar/" + url, options)
  if (res.status === 401) {
    location.assign("/login")
    throw new Error("请重新登录。")
  }
  const data = await res.json()
  if (!res.ok)
    throw new Error(
      data.error?.message ?? "日历请求失败（HTTP " + res.status + "）",
    )
  return data
}
function drawDays(days) {
  const grid = element("grid")
  grid.replaceChildren()
  for (const [i, day] of days.entries()) {
    const button = document.createElement("button")
    if (i === 0)
      button.style.gridColumnStart = String(
        ((new Date(day.date + "T12:00:00Z").getUTCDay() + 6) % 7) + 1,
      )
    button.textContent = String(Number(day.date.slice(-2)))
    button.dataset.date = day.date
    button.setAttribute("aria-pressed", String(date === day.date))
    const marker = document.createElement("small")
    if (day.unbound_memories) {
      marker.textContent = day.unbound_memories + " 缺原文"
      marker.className = "warn"
    } else if (day.counts.memory) marker.textContent = day.counts.memory + " 桶"
    button.setAttribute("aria-label", day.date + " " + marker.textContent)
    button.append(marker)
    button.onclick = () => {
      date = day.date
      drawDays(days)
      void loadDay()
    }
    grid.append(button)
  }
}
async function loadMonth() {
  const epoch = ++monthLoad
  element("month").textContent = month.replace("-", " 年 ") + " 月"
  element("month-error").textContent = ""
  try {
    const res = await request("month?" + new URLSearchParams({ month }))
    if (epoch !== monthLoad) return
    drawDays(res.days)
    if (res.source_status.memory !== "ready")
      element("month-error").textContent =
        "无法读取记忆统计：" + (res.memory_error ?? res.source_status.memory)
  } catch (err) {
    if (epoch === monthLoad) element("month-error").textContent = err.message
  }
}
function showBucket(row) {
  const article = document.createElement("article")
  article.className = "bucket"
  const copy = document.createElement("div"),
    title = document.createElement("strong"),
    details = document.createElement("p")
  const mid = row.source_ref.id
  title.textContent =
    row.title === mid ? "记忆桶 " + mid : mid + " · " + row.title
  const failed = [
    "failed",
    "source_unavailable",
    "version_conflict",
    "credential_blocked",
  ].includes(row.status)
  const missing = row.source_count === 0
  details.textContent = missing
    ? "缺少原文绑定"
    : "已绑定 " + row.source_count + " 段原文"
  if (missing || failed) details.className = "warn"
  copy.append(title, details)
  article.append(copy)
  if (missing || failed) {
    const reason = document.createElement("p")
    reason.textContent =
      row.reason && (failed || row.status === "no_match") ? row.reason : ""
    if (reason.textContent) copy.append(reason)
    const action = document.createElement("button")
    action.textContent = working.has(mid) ? "正在重算…" : "DS 重算"
    action.disabled = working.has(mid)
    action.onclick = async () => {
      if (working.has(mid)) return
      const opened = date
      working.add(mid)
      action.disabled = true
      action.textContent = "正在重算…"
      let message
      try {
        const result = await request("memory/recalculate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ memory_id: mid, revision: row.revision }),
        })
        message = mid + " · " + result.detail
      } catch (err) {
        message = mid + " · " + err.message
      } finally {
        working.delete(mid)
      }
      if (date === opened) {
        await Promise.all([loadDay(), loadMonth()])
        if (date === opened) element("feedback").textContent = message
      }
    }
    article.append(action)
  }
  element("items").append(article)
}
async function loadDay(more = false) {
  const epoch = ++dayLoad
  element("day").textContent = date + " 的记忆"
  element("feedback").textContent = "正在读取…"
  element("more").hidden = true
  if (!more) {
    element("items").replaceChildren()
    nextCursor = null
  }
  const args = new URLSearchParams({ date, source: "memory", limit: "50" })
  if (more && nextCursor) args.set("cursor", nextCursor)
  try {
    const res = await request("day/items?" + args)
    if (epoch !== dayLoad) return
    for (const row of res.items) showBucket(row)
    nextCursor = res.next_cursor
    element("more").hidden = !nextCursor
    element("feedback").textContent = element("items").children.length
      ? ""
      : "当天没有记忆桶。"
  } catch (err) {
    if (epoch === dayLoad) {
      element("feedback").textContent = err.message
      element("more").hidden = !nextCursor
    }
  }
}
function changeMonth(delta) {
  const d = new Date(month + "-01T12:00:00Z")
  d.setUTCMonth(d.getUTCMonth() + delta)
  month = d.toISOString().slice(0, 7)
  date = month === today.slice(0, 7) ? today : month + "-01"
  element("grid").replaceChildren()
  void loadMonth()
  void loadDay()
}
element("prev").onclick = () => changeMonth(-1)
element("next").onclick = () => changeMonth(1)
element("more").onclick = () => loadDay(true)
element("refresh").onclick = () => Promise.all([loadMonth(), loadDay()])
void loadMonth()
void loadDay()
