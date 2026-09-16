/**
 * Launch a Chromium-family browser (Brave/Chrome) with remote debugging for CDP.
 * One process per account profile (isolation model for multi-account Aifrost).
 * See docs/browser-isolation.md — not the user's personal Brave; not Brave UI Containers.
 *
 * Important: Chromium allows only one process per user-data-dir. A second launch
 * with the same profile opens a blank tab in the existing process and does NOT
 * start CDP on the new port — that produces black about:blank windows and
 * "CDP not ready". We reuse an existing CDP endpoint when possible, clear stale
 * locks, and kill orphaned profile processes before a clean start.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { discoverBrowserWsUrl } from "../cdp/client.js";

export interface ChromiumProcessConfig {
  binaryPath: string;
  userDataDir: string;
  host?: string;
  port?: number;
  headless?: boolean;
  readyTimeoutMs?: number;
}

export interface ChromiumProcessHandle {
  pid: number;
  host: string;
  port: number;
  wsUrl: string;
  userDataDir: string;
  /** When true, stop() is a no-op (shared profile process). */
  shared?: boolean;
  stop(): Promise<void>;
}

export async function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("failed to allocate port"));
        return;
      }
      const port = addr.port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on("error", reject);
  });
}

/** True if CDP HTTP endpoint answers. */
export async function isCdpHttpReady(
  host: string,
  port: number,
  timeoutMs = 800,
): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { webSocketDebuggerUrl?: string };
    return Boolean(body.webSocketDebuggerUrl);
  } catch {
    return false;
  }
}

/**
 * Read DevToolsActivePort (Chromium writes "port\\nws path" or just port).
 */
export function readDevToolsActivePort(userDataDir: string): { port: number } | null {
  const path = join(userDataDir, "DevToolsActivePort");
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8").trim();
    const first = raw.split(/\r?\n/)[0]?.trim();
    const port = Number(first);
    if (!Number.isFinite(port) || port <= 0) return null;
    return { port };
  } catch {
    return null;
  }
}

/** Kill processes whose command line includes this user-data-dir (orphans). */
export async function killProcessesUsingUserDataDir(userDataDir: string): Promise<void> {
  const matchingPids = (): number[] => {
    // pgrep -f takes an ERE pattern — escape the path so it is literal.
    const needle = userDataDir.replace(/[^A-Za-z0-9_/.-]/g, "\\$&");
    const res = spawnSync("pgrep", ["-f", needle], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (res.error || res.status !== 0 || !res.stdout) return [];
    return res.stdout
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid);
  };
  try {
    const first = matchingPids();
    if (!first.length) return;
    for (const pid of first) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* ignore */
      }
    }
    // Brief wait then force
    await new Promise((r) => setTimeout(r, 400));
    for (const pid of matchingPids()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* pgrep unavailable */
  }
}

/** Remove singleton / DevTools files so a new process can own the profile. */
export function clearProfileLaunchArtifacts(userDataDir: string): void {
  for (const name of [
    "SingletonLock",
    "SingletonCookie",
    "SingletonSocket",
    "DevToolsActivePort",
  ]) {
    const p = join(userDataDir, name);
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
  // Socket paths may be directories on some systems
  try {
    const sock = join(userDataDir, "SingletonSocket");
    if (existsSync(sock)) rmSync(sock, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export async function startChromiumProcess(
  config: ChromiumProcessConfig,
): Promise<ChromiumProcessHandle> {
  const host = config.host ?? "127.0.0.1";

  // Never attach to the user's everyday Brave/Chrome profile (macOS + Linux).
  const udd = config.userDataDir;
  if (
    /BraveSoftware\/Brave-Browser(?!-)/.test(udd) ||
    /Google\/Chrome(?!-)/.test(udd) ||
    /Application Support\/Chromium(?!\/)/.test(udd) ||
    /\.config\/BraveSoftware\/Brave-Browser(?!-)/.test(udd) ||
    /\.config\/BraveSoftware(?!\/)/.test(udd) ||
    /\.config\/google-chrome(?!-)/.test(udd) ||
    /\.config\/chromium(?!\/|-)/.test(udd)
  ) {
    throw new Error(
      `Refusing to launch with personal browser profile path: ${udd}. ` +
        "Aifrost must use an isolated --user-data-dir under state/profiles/.",
    );
  }

  // Session cookies live in this profile dir — keep it owner-only.
  mkdirSync(config.userDataDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(config.userDataDir, 0o700);
  } catch {
    /* best-effort on filesystems without chmod */
  }

  // Reuse existing CDP if this profile is already running with debugging.
  const existing = readDevToolsActivePort(udd);
  if (existing) {
    const alive = await isCdpHttpReady(host, existing.port, 500);
    if (alive) {
      try {
        const wsUrl = await discoverBrowserWsUrl(host, existing.port, 3_000);
        return {
          pid: 0,
          host,
          port: existing.port,
          wsUrl,
          userDataDir: udd,
          shared: true,
          async stop() {
            /* shared profile — do not kill; backend refcount owns lifecycle */
          },
        };
      } catch {
        /* fall through to clean relaunch */
      }
    }
  }

  // Profile in use without usable CDP → black about:blank tabs. Clean house.
  await killProcessesUsingUserDataDir(udd);
  clearProfileLaunchArtifacts(udd);

  const port = config.port ?? (await allocateLoopbackPort());
  const headless = config.headless === true;
  const args = [
    `--remote-debugging-address=${host}`,
    `--remote-debugging-port=${port}`,
    // Deliberately NO --remote-allow-origins: the ws client sends no Origin
    // header, and "*" would let any web page in any browser drive this
    // logged-in profile over CDP.
    `--user-data-dir=${udd}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--no-startup-window",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-features=Translate,MediaRouter",
    ...(headless
      ? ["--headless=new", "--disable-gpu"]
      : ["--window-size=1280,900", "--window-position=60,60"]),
  ];

  const stderrChunks: string[] = [];
  const child: ChildProcess = spawn(config.binaryPath, args, {
    stdio: ["ignore", "ignore", "pipe"],
    // Minimal env: the browser needs display/session vars (headed) and DBus
    // for cookie encryption, but must not inherit AIFROST_AUTH_TOKEN and
    // other secrets (readable via /proc/<pid>/environ, crash reporters).
    env: browserChildEnv(),
  });

  child.stderr?.on("data", (buf: Buffer) => {
    const text = buf.toString("utf8");
    stderrChunks.push(text);
    if (stderrChunks.join("").length > 64_000) {
      stderrChunks.splice(0, Math.floor(stderrChunks.length / 2));
    }
  });

  let exitError: Error | null = null;
  child.on("error", (err) => {
    exitError = err;
  });
  child.on("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      exitError = new Error(
        `chromium exited code=${code} signal=${signal}: ${stderrChunks.slice(-5).join("")}`,
      );
    }
  });

  const readyTimeout = config.readyTimeoutMs ?? 20_000;
  try {
    // Race CDP discovery against early child exit so a missing/broken binary
    // fails fast instead of burning the full ready timeout.
    const wsUrl = await Promise.race([
      discoverBrowserWsUrl(host, port, readyTimeout),
      new Promise<never>((_r, reject) => {
        const onExit = (code: number | null, signal: string | null) => {
          if (code !== null && code !== 0) {
            reject(
              new Error(
                `chromium exited code=${code} signal=${signal}: ${stderrChunks.slice(-5).join("")}`,
              ),
            );
          }
        };
        const onErr = (e: Error) => reject(e);
        child.once("exit", onExit);
        child.once("error", onErr);
      }),
    ]);
    if (child.exitCode !== null || exitError) {
      throw exitError ?? new Error("chromium exited before ready");
    }
    if (child.pid == null) {
      throw new Error("chromium spawned without pid");
    }
    return {
      pid: child.pid,
      host,
      port,
      wsUrl,
      userDataDir: udd,
      shared: false,
      async stop() {
        await stopChild(child);
      },
    };
  } catch (e) {
    await stopChild(child);
    const tail = stderrChunks.slice(-15).join("");
    throw new Error(
      `Chromium failed to become ready on ${host}:${port}: ${
        e instanceof Error ? e.message : String(e)
      }. ` +
        `If you see black about:blank tabs, another Brave/Chrome instance is holding this profile ` +
        `(${udd}). Quit those windows or restart Aifrost after closing them.` +
        (tail ? `\nstderr:\n${tail}` : ""),
    );
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    try {
      child.kill("SIGTERM");
    } catch {
      resolve();
      return;
    }
    setTimeout(() => {
      try {
        if (child.exitCode === null) child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve();
    }, 3_000);
  });
}

/**
 * Minimal environment for the browser child: display/session plumbing only.
 * Deliberately excludes server secrets (AIFROST_AUTH_TOKEN, API keys, etc.).
 */
function browserChildEnv(): NodeJS.ProcessEnv {
  const ALLOW = [
    "HOME",
    "PATH",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LC_MESSAGES",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "XDG_RUNTIME_DIR",
    "XDG_SESSION_TYPE",
    "XDG_CURRENT_DESKTOP",
    "XDG_DATA_DIRS",
    "XDG_CONFIG_DIRS",
    "DBUS_SESSION_BUS_ADDRESS",
    "DBUS_SYSTEM_BUS_ADDRESS",
    "GNOME_KEYRING_CONTROL",
    "SSH_AUTH_SOCK",
    "GDK_BACKEND",
    "QT_QPA_PLATFORM",
    "FONTCONFIG_PATH",
    "__CF_USER_TEXT_ENCODING",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const k of ALLOW) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}
