/**
 * dsh-plugin-netease-lyrics — Host half.
 *
 * Owns:
 *  - one supervised SMTC worker process (powershell -File smtc-worker.ps1)
 *    that reports the desktop Netease Cloud Music playback state every second;
 *  - one same-origin web route /plugin/netease-lyrics/* that serves
 *      GET  state     -> last SMTC snapshot + host-side stopwatch position
 *      GET  lyrics    -> LRC + translation for title/artist (cached per song)
 *
 * The browser half polls `state` (1s) and fetches `lyrics` only when the song
 * changes. Progress is a host-side stopwatch because the Netease PC client
 * does not expose its playback position through SMTC.
 *
 * CRITICAL ACTIVATION CONTRACT (regression 1.0.0-1.0.2): the host context is
 * a proxy whose property access can THROW during early web boot. Any bare
 * `ctx.get(...)`, `ctx.logger...` or `ctx.effect(...)` outside a try block
 * fails this plugin's fiber, and the host then refuses to boot the whole web
 * app ("web boot: 1 entry did not activate"). Every ctx touch below goes
 * through the guarded helpers and the whole apply body is wrapped: the worst
 * case is a silent plugin, never a dead host.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const inject = ["webServer"];

const ROUTE_PREFIX = "/plugin/netease-lyrics";
const LYRIC_CACHE_MAX = 30;
const LYRIC_TTL_OK = 1000 * 60 * 60 * 24 * 7; // success: one week
const LYRIC_TTL_FAIL = 1000 * 60; // failure: one minute, then retry
// Set by searchSong when music.163.com rate-limits us (code 405); the active
// apply() instance reads it to choose the global backoff duration.
let lastSearchBlocked = false;

function log(...parts) {
  try {
    console.warn("[netease-lyrics]", ...parts);
  } catch {
    /* logging must never throw */
  }
}

/**
 * Read one property off the host context without ever throwing. Returns
 * fallback when the context is poisoned (early boot proxy) or the service
 * is absent.
 */
function safeGet(ctx, key, fallback) {
  try {
    const value = ctx.get(key);
    return value === undefined || value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

/** Register one effect; returns a disposer or null. Never throws. */
function safeEffect(ctx, register, label) {
  try {
    if (typeof ctx.effect === "function") {
      ctx.effect(register, label);
      return true;
    }
  } catch (error) {
    log(`effect registration failed (${label}), degrading to direct call:`, error?.message ?? error);
  }
  return null;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function hostAllowed(req) {
  const host = String(req.headers.host ?? "").toLowerCase();
  const bare = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(bare);
}

function originAllowed(req) {
  const origin = String(req.headers.origin ?? "");
  if (origin === "") return true;
  try {
    return new URL(origin).host.toLowerCase() === String(req.headers.host ?? "").toLowerCase();
  } catch {
    return false;
  }
}

/** Parse one LRC line into { time, text }; returns null for meta lines. */
function parseLrcLine(line) {
  const match = /^\[(\d{1,3}):(\d{1,2})(?:\.(\d{1,3}))?\](.*)$/.exec(line);
  if (!match) return null;
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  const fraction = match[3] ? Number(`0.${match[3]}`) : 0;
  return { time: minutes * 60 + seconds + fraction, text: match[4].trim() };
}

/** Merge raw lrc/tlyric text into [{ time, text, trans }] sorted by time. */
export function mergeLyrics(lrcText, transText) {
  const transMap = new Map();
  if (transText) {
    for (const line of transText.split(/\r?\n/)) {
      const parsed = parseLrcLine(line);
      if (parsed && parsed.text) transMap.set(parsed.time.toFixed(3), parsed.text);
    }
  }
  const rows = [];
  if (lrcText) {
    for (const line of lrcText.split(/\r?\n/)) {
      const parsed = parseLrcLine(line);
      if (!parsed || !parsed.text) continue;
      // Drop credit/metadata headers: a label before a colon at the very
      // start of the line (作词 : X / OP : Y / 乐器演奏 : Z) or common
      // English credit keys. Real lyric lines almost never start this way.
      if (/^(作词|作曲|编曲|制作人|和声|混音|母带|录音|监制|企划|出品|发行|乐器|演奏|吉他|键盘|贝斯|鼓|弦乐|管乐|配唱|统筹|文案|摄影|设计|插画|MV|导演|编舞|舞蹈|推广|宣传|宣发|鸣谢|感谢|特别|支持|赞助|封面|排版|字幕|歌词|翻译|校对|OP|SP|ISRC|UPC|Label|Lyrics|Music|Words|Composer|Arranger|Producer|Written|Mixed|Mastered|Recorded|Arranged|Mixed|Directed|Edited|Designed|Performed|Vocals|Instrumental|Guitar|Piano|Bass|Drums|Keyboard|Strings|Copyright|Publishing|Presented|Executive)\s*[:：]/i.test(parsed.text)) continue;
      const trans = transMap.get(parsed.time.toFixed(3)) ?? "";
      rows.push({ time: parsed.time, text: parsed.text, trans });
    }
  }
  rows.sort((a, b) => a.time - b.time);
  return rows;
}

async function fetchLyrics(songId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(`https://music.163.com/api/song/lyric?id=${encodeURIComponent(songId)}&lv=1&tv=-1&kv=-1`, {
      signal: controller.signal,
    });
    const body = await res.json();
    return { lrc: body?.lrc?.lyric ?? "", trans: body?.tlyric?.lyric ?? "" };
  } finally {
    clearTimeout(timer);
  }
}

async function searchSong(title, artist) {
  const keywords = `${title} ${artist}`.trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(
      `https://music.163.com/api/search/get/web?s=${encodeURIComponent(keywords)}&type=1&limit=3`,
      { signal: controller.signal, method: "POST" },
    );
    let body;
    try {
      body = await res.json();
    } catch {
      lastSearchBlocked = true;
      return null;
    }
    // 163.com answers 405 with "操作频繁" when rate-limited; the caller backs
    // off globally instead of retrying per poll.
    if (body?.code === 405 || (typeof body?.msg === "string" && body.msg.includes("频繁"))) {
      lastSearchBlocked = true;
      return null;
    }
    lastSearchBlocked = false;
    const songs = body?.result?.songs;
    if (!Array.isArray(songs) || songs.length === 0) return null;
    // Prefer a song whose name matches the reported title exactly.
    const wanted = title.toLowerCase();
    const hit = songs.find((s) => String(s.name).toLowerCase() === wanted) ?? songs[0];
    return String(hit.id);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function apply(ctx, config = {}) {
  try {
    applyInner(ctx, config);
  } catch (error) {
    // The absolute last resort: activation must never throw, or the host
    // refuses to boot the web app entirely (regression 1.0.0-1.0.2).
    log("activation degraded to idle after unexpected error:", error?.message ?? error);
  }
}

function applyInner(ctx, config = {}) {
  // SMTC is a Windows-only API. On other platforms keep the web routes alive
  // but report supported:false so the browser half stays silent instead of
  // crash-looping a nonexistent powershell.exe.
  const supported = process.platform === "win32";

  const state = {
    disposed: false,
    supported,
    worker: null,
    workerOut: "",
    workerErr: "",
    workerStartedAt: 0,
    workerRestarts: 0,
    smtc: { playing: false, title: "", artist: "", album: "", app: "" },
    // stopwatch: absolute host timestamps
    songKey: "",
    playingSince: 0, // host clock when playback of this position started
    positionBase: 0, // seconds counted before playingSince
    lastReportAt: 0,
    lyrics: new Map(), // songKey -> { rows, fetchedAt, songId }
    lyricsInflight: new Map(),
    lyricsBlockedUntil: 0, // global backoff while the search API rate-limits
    lastSearchBlocked: false,
  };

  const songKeyOf = (s) => `${s.title}|${s.artist}`;
  const hasSong = () => state.smtc.title.trim() !== "";

  function positionSeconds() {
    if (!state.playingSince) return state.positionBase;
    return state.positionBase + (Date.now() - state.playingSince) / 1000;
  }

  function resetStopwatch(title, artist, playing) {
    const key = songKeyOf({ title, artist });
    if (key !== state.songKey) {
      state.songKey = key;
      state.positionBase = 0;
      state.playingSince = playing ? Date.now() : 0;
    } else {
      // Same song: freeze / resume the stopwatch on pause-play transitions.
      const current = positionSeconds();
      state.positionBase = current;
      state.playingSince = playing ? Date.now() : 0;
    }
  }

  function ensureWorker() {
    if (state.disposed || state.worker !== null || !state.supported) return;
    const script = join(dirname(fileURLToPath(import.meta.url)), "smtc-worker.ps1");
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    state.workerStartedAt = Date.now();
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          const snapshot = JSON.parse(line);
          const playingChanged = snapshot.playing !== state.smtc.playing;
          const songChanged = songKeyOf(snapshot) !== state.songKey;
          state.smtc = snapshot;
          if (snapshot.title.trim() !== "" && (playingChanged || songChanged)) {
            resetStopwatch(snapshot.title, snapshot.artist, snapshot.playing === true);
          }
        } catch {
          /* malformed line: ignore */
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      state.workerErr = (state.workerErr + chunk).slice(-4000);
    });
    child.on("exit", () => {
      state.worker = null;
      // A worker that dies within its first minute is a real failure (script
      // unreadable, PS policy, missing SMTC); restart with backoff and log it.
      const quickDeath = Date.now() - state.workerStartedAt < 60000;
      state.workerRestarts += 1;
      if (!state.disposed) {
        log(
          `SMTC worker exited (restart #${state.workerRestarts}${quickDeath ? ", quick death" : ""}); ` +
          (state.workerErr ? `last stderr: ${state.workerErr.slice(-300)}` : "no stderr captured"),
        );
        setTimeout(ensureWorker, quickDeath ? 15000 : 3000);
      }
    });
    child.on("error", () => {
      state.worker = null;
      if (!state.disposed) setTimeout(ensureWorker, 15000);
    });
    state.worker = child;
  }

  if (state.supported) {
    ensureWorker();
  } else {
    log("SMTC is Windows-only; plugin stays idle on this platform");
  }

  async function ensureLyrics(title, artist) {
    const key = songKeyOf({ title, artist });
    const cached = state.lyrics.get(key);
    if (cached) {
      // Success entries live 7 days. Failures (rate limit, no match) are only
      // negative-cached briefly so a later poll retries instead of pinning an
      // empty result for a week (regression: 163.com 405 "操作频繁" rate limit).
      const ttl = cached.rows.length > 0 ? LYRIC_TTL_OK : LYRIC_TTL_FAIL;
      if (Date.now() - cached.fetchedAt < ttl) return cached;
    }
    const inflight = state.lyricsInflight.get(key);
    if (inflight) return inflight;
    // Circuit breaker: when the search API rate-limits us, back off globally
    // instead of hammering it once per client poll.
    if (state.lyricsBlockedUntil && Date.now() < state.lyricsBlockedUntil) {
      return cached ?? { rows: [], fetchedAt: 0, songId: null };
    }
    const task = (async () => {
      try {
        const songId = await searchSong(title, artist);
        if (!songId) {
          // Distinguish rate-limit from "no match": searchSong reports it via
          // the module-level lastSearchBlocked. Back off 60s on rate limit,
          // 10s otherwise.
          const backoff = lastSearchBlocked ? 60000 : 10000;
          state.lyricsBlockedUntil = Date.now() + backoff;
          return cached ?? { rows: [], fetchedAt: Date.now(), songId: null };
        }
        const raw = await fetchLyrics(songId);
        const entry = { rows: mergeLyrics(raw.lrc, raw.trans), fetchedAt: Date.now(), songId };
        state.lyrics.set(key, entry);
        if (state.lyrics.size > LYRIC_CACHE_MAX) {
          const oldest = [...state.lyrics.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)[0];
          if (oldest) state.lyrics.delete(oldest[0]);
        }
        return entry;
      } finally {
        state.lyricsInflight.delete(key);
      }
    })();
    state.lyricsInflight.set(key, task);
    return task;
  }

  const webServer = safeGet(ctx, "webServer", null);
  if (!webServer || typeof webServer.register !== "function") {
    log("webServer unavailable, browser half disabled");
    return;
  }

  function routeFactory() {
    return webServer.register({
        kind: "prefix",
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          try {
            if (!hostAllowed(req) || !originAllowed(req)) {
              return sendJson(res, 403, { ok: false, message: "forbidden" });
            }
            const url = new URL(req.url ?? "/", "http://x");
            const sub = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, "");

            if (sub === "state" && req.method === "GET") {
              const snap = state.smtc;
              return sendJson(res, 200, {
                ok: true,
                supported: state.supported,
                workerAlive: state.worker !== null,
                workerRestarts: state.workerRestarts,
                workerError: state.workerErr.slice(-300) || null,
                playing: snap.playing === true,
                title: snap.title,
                artist: snap.artist,
                album: snap.album,
                hasSong: hasSong(),
                position: positionSeconds(),
                durationHint: null,
              });
            }

            if (sub === "lyrics" && req.method === "GET") {
              const title = url.searchParams.get("title") ?? "";
              const artist = url.searchParams.get("artist") ?? "";
              if (!title.trim()) return sendJson(res, 200, { ok: true, rows: [] });
              const entry = await ensureLyrics(title, artist);
              return sendJson(res, 200, { ok: true, rows: entry.rows });
            }

            if (sub === "resync" && req.method === "POST") {
              // Invisible re-alignment gesture: client reports the seconds the
              // listener knows the track is at (e.g. after a manual seek).
              let body = {};
              try {
                const chunks = [];
                let size = 0;
                for await (const chunk of req) {
                  size += chunk.length;
                  if (size > 4096) break;
                  chunks.push(chunk);
                }
                body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
              } catch {
                body = {};
              }
              const seconds = Number(body.position);
              if (Number.isFinite(seconds) && seconds >= 0) {
                state.positionBase = seconds;
                state.playingSince = state.smtc.playing ? Date.now() : 0;
              }
              return sendJson(res, 200, { ok: true });
            }

            return sendJson(res, 404, { ok: false, message: "not found" });
          } catch (error) {
            return sendJson(res, 500, { ok: false, message: String(error?.message ?? error) });
          }
        },
      });
  }

  let routeRegistered = null;
  try {
    routeRegistered = safeEffect(ctx, routeFactory, "netease-lyrics: web routes");
  } catch (error) {
    log("effect route registration threw:", error?.message ?? error);
  }
  if (routeRegistered === null) {
    // No effect system available: register directly so the routes still work.
    try {
      routeFactory();
    } catch (error) {
      log("direct route registration failed:", error?.message ?? error);
    }
  }

  safeEffect(
    ctx,
    () => () => {
      state.disposed = true;
      if (state.worker !== null) {
        try {
          state.worker.kill();
        } catch {
          /* already gone */
        }
        state.worker = null;
      }
    },
    "netease-lyrics: dispose",
  );
}
