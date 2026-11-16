/**
 * The org installer's recovery file: the one place the bootstrap secrets it generates live.
 *
 * One JSON file per control-plane hostname under the yaran config root (`~/.yaran/` on
 * macOS, `$XDG_CONFIG_HOME/yaran/` or `~/.config/yaran/` on Linux), in a `cloud-setup`
 * directory created at 0700 with the file at 0600. Writes go to a fresh owner-only temp
 * file in that same directory, are fsynced and renamed over the old one, and the directory
 * is fsynced, so a crash never leaves a half-written or lost key. Neither the file nor its
 * directory may be a symlink or another user's. A `--state-file` directory the user already
 * had keeps its mode. `dataKey` is null when the Worker already had a DATA_KEY this file
 * never saw: that key is kept, never replaced.
 *
 * <module-headers:begin>
 * Uses: none
 * External: node:crypto, node:fs, node:os, node:path
 *
 * Used by:
 * scripts/org-setup/state.ts
 * ├── scripts/org-setup/run.ts
 * ├── test/node/org-setup-safety.test.ts
 * └── test/node/org-setup.test.ts
 * <module-headers:end>
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface OrgState {
  version: 1;
  accountId: string;
  workerName: string;
  hostname: string;
  workerUrl: string | null;
  adminEmail: string;
  setupCode: string | null;
  dataKey: string | null;
  createdAt: string;
}

/** `~/.yaran/cloud-setup/<hostname>.json` (macOS) or the XDG equivalent (Linux). */
export function defaultStatePath(hostname: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const root = platform === "darwin" ? join(homedir(), ".yaran") : join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "yaran");
  return join(root, "cloud-setup", `${hostname}.json`);
}

const code = (e: unknown) => (e as NodeJS.ErrnoException).code;
const NOFOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW;

/**
 * Opens the state file's directory without following a symlink and refuses one another
 * user owns. A missing directory is created at 0700; an existing one is tightened only when
 * it is the installer's own default directory (`own`), never a directory the user named.
 */
function openDir(dir: string, own: boolean): number {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(dir, NOFOLLOW | constants.O_DIRECTORY);
  } catch (e) {
    if (code(e) === "ELOOP" || code(e) === "ENOTDIR") throw new Error(`${dir} is a symbolic link or not a directory; keep the recovery file in a real directory you own.`, { cause: e });
    throw e;
  }
  const st = fstatSync(fd);
  if (st.uid !== process.getuid!()) {
    closeSync(fd);
    throw new Error(`${dir} belongs to another user; keep the recovery file in a directory you own.`);
  }
  if (own && st.mode & 0o077) fchmodSync(fd, 0o700);
  return fd;
}

/** The saved state, or null when there is none. Never echoes the file's bytes: it holds keys. */
export function readState(path: string): OrgState | null {
  let fd: number;
  try {
    fd = openSync(path, NOFOLLOW);
  } catch (e) {
    if (code(e) === "ENOENT") return null;
    if (code(e) === "ELOOP") throw new Error(`${path} is a symbolic link; the recovery file must be a regular file you own.`, { cause: e });
    throw e;
  }
  let raw: Partial<OrgState> | null;
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid!()) throw new Error(`${path} is not a regular file you own.`);
    try {
      raw = JSON.parse(readFileSync(fd, "utf8")) as Partial<OrgState> | null;
    } catch {
      // No cause on purpose: the parser's message quotes the file's bytes, which hold keys.
      throw new Error(`${path} is not valid JSON.`);
    }
  } finally {
    closeSync(fd);
  }
  if (raw?.version !== 1 || typeof raw.accountId !== "string" || typeof raw.hostname !== "string") throw new Error(`${path} is not a yaran org setup file (version 1)`);
  return { workerUrl: null, setupCode: null, dataKey: null, workerName: "", adminEmail: "", createdAt: "", ...raw } as OrgState;
}

/** Writes through an owner-only temp file, fsynced, renamed over the old one, then fsyncs the directory. */
export function writeState(path: string, state: OrgState, own: boolean): void {
  const dir = dirname(path);
  const dfd = openDir(dir, own);
  const tmp = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    readState(path); // refuses a symlinked or foreign file before anything replaces it
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(state, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    fsyncSync(dfd);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  } finally {
    closeSync(dfd);
  }
}

const held = new Set<string>();
let hooked = false;

/**
 * Takes `<path>.lock` exclusively for one run, so two runs can never each generate and
 * upload a key; null when another run holds it. The release also runs on process exit.
 */
export function lockState(path: string, own: boolean): (() => void) | null {
  closeSync(openDir(dirname(path), own));
  const lock = `${path}.lock`;
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch (e) {
    if (code(e) === "EEXIST") return null;
    throw e;
  }
  try {
    writeSync(fd, `pid ${process.pid} since ${new Date().toISOString()}\n`);
  } finally {
    closeSync(fd);
  }
  held.add(lock);
  if (!hooked) {
    hooked = true;
    process.once("exit", () => held.forEach((l) => rmSync(l, { force: true })));
  }
  return () => {
    held.delete(lock);
    rmSync(lock, { force: true });
  };
}

/** At least 24 characters (32 here), what the setup gate demands. */
export const newSetupCode = (): string => randomBytes(24).toString("base64url");
/** Standard base64 of 32 random bytes, what `decodeDataKey` accepts. */
export const newDataKey = (): string => randomBytes(32).toString("base64");
