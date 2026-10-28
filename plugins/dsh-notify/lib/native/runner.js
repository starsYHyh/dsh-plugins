// dsh-notify — native approval popup runner.
//
// The Host half of the plugin runs inside a plain Node subprocess (not the
// Electron main process), so a macOS native alert cannot be raised through the
// page. Instead we ship a tiny Objective-C panel (`panel.m`) next to this file,
// compile it on first use with clang + Cocoa, cache the binary under
// `${DSH_HOME || ~/.dsh}/cache/dsh-notify/`, and speak to it over argv/stdout:
//
//   spawn(panel, --title ... --body ... --timeout-ms ...)
//     stdout: one JSON line, `{"choice":"allow"}` / deny / dismiss / timeout
//
// Everything here is defensive: `prompt()` always resolves, never rejects, and
// degrades to `'unavailable'` when the platform or the toolchain cannot help.

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, mkdir, stat, chmod, rename, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'panel.m');

/** Compile flags; part of the cache key so a flag change invalidates binaries. */
const COMPILE_ARGS = ['-fobjc-arc', '-O2', '-framework', 'Cocoa'];

/** Text passed through argv is clipped to this many characters. */
const MAX_TEXT = 2000;

/** Upper bound for a single compile (clang on this machine takes < 2 s). */
const COMPILE_TIMEOUT_MS = 60_000;

/**
 * Absolute compiler path: a Finder-launched Host inherits the launchd PATH, and
 * `/usr/bin/clang` is the xcode-select shim that always exists with the CLT.
 */
const CLANG = existsSync('/usr/bin/clang') ? '/usr/bin/clang' : 'clang';

const VALID_CHOICES = new Set(['allow', 'deny', 'dismiss', 'timeout', 'unavailable']);

/** Platform support: the native panel is macOS only. */
export const PLATFORM_SUPPORTED = process.platform === 'darwin';

const memo = {
  compiling: null,
  binaryPath: null,
  binaryUsable: false,
  compiledAt: null,
  lastError: null,
};

let warnedOnce = false;

function warnOnce(message) {
  if (warnedOnce) return;
  warnedOnce = true;
  try {
    console.warn(`[dsh-notify] ${message}`);
  } catch {
    // Logging must never take the host down.
  }
}

function readableError(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function tail(text, limit = 600) {
  const value = String(text ?? '').trim();
  return value.length > limit ? `…${value.slice(value.length - limit)}` : value;
}

function dshHome() {
  const configured = process.env.DSH_HOME;
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return configured;
  }
  return path.join(os.homedir(), '.dsh');
}

function cacheDirectory() {
  return path.join(dshHome(), 'cache', 'dsh-notify');
}

function clipText(value, limit = MAX_TEXT) {
  if (typeof value !== 'string' || value.length === 0) return '';
  // Array.from splits by code point, so a truncated tail never cuts a surrogate pair.
  const characters = Array.from(value);
  if (characters.length <= limit) return value;
  return characters.slice(0, limit).join('');
}

function numeric(value, fallback) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return number;
}

async function runProcess(command, args, timeoutMs = COMPILE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let done = false;

    const finish = (callback, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      callback(value);
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      finish(reject, new Error(`${command} did not finish within ${timeoutMs} ms`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 1_000_000) stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 1_000_000) stderr += chunk;
    });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code, signal) => finish(resolve, { code, signal, stdout, stderr }));
  });
}

/**
 * Compile `panel.m` on first use and memoise the binary path for this process.
 * Resolves to the binary path, or `null` when compilation is impossible.
 */
async function ensureBinary() {
  if (!PLATFORM_SUPPORTED) return null;
  if (memo.binaryUsable && memo.binaryPath) return memo.binaryPath;
  if (memo.compiling) return memo.compiling;

  memo.compiling = (async () => {
    try {
      const source = await readFile(SOURCE_PATH, 'utf8');
      const hash = createHash('sha1')
        .update(source, 'utf8')
        .update('\0', 'utf8')
        .update(COMPILE_ARGS.join(' '), 'utf8')
        .digest('hex');

      const directory = cacheDirectory();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const binaryPath = path.join(directory, `panel-${hash}`);

      const cached = await stat(binaryPath).catch(() => null);
      if (cached && cached.isFile() && cached.size > 0) {
        memo.binaryPath = binaryPath;
        memo.binaryUsable = true;
        memo.compiledAt = cached.mtime.toISOString();
        memo.lastError = null;
        return binaryPath;
      }

      // Atomic cache write: compile to a temporary sibling, then rename.
      const temporaryPath = path.join(
        directory,
        `.panel-${hash}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
      );
      const result = await runProcess(CLANG, [...COMPILE_ARGS, '-o', temporaryPath, SOURCE_PATH]);
      if (result.code !== 0) {
        await unlink(temporaryPath).catch(() => {});
        const signal = result.signal ? ` (signal ${result.signal})` : '';
        throw new Error(
          `clang exited with code ${result.code}${signal}: ${tail(result.stderr) || 'no diagnostic output'}`,
        );
      }

      await chmod(temporaryPath, 0o755);
      await rename(temporaryPath, binaryPath);

      memo.binaryPath = binaryPath;
      memo.binaryUsable = true;
      memo.compiledAt = new Date().toISOString();
      memo.lastError = null;
      return binaryPath;
    } catch (error) {
      memo.binaryPath = null;
      memo.binaryUsable = false;
      memo.lastError = `native panel unavailable: ${readableError(error)}`;
      warnOnce(memo.lastError);
      return null;
    } finally {
      memo.compiling = null;
    }
  })();

  return memo.compiling;
}

/**
 * Native panel diagnostics.
 *
 * @returns {{ supported: boolean, binaryPath?: string, compiledAt?: string, lastError?: string }}
 */
export function state() {
  const snapshot = { supported: PLATFORM_SUPPORTED };
  if (memo.binaryPath) snapshot.binaryPath = memo.binaryPath;
  if (memo.compiledAt) snapshot.compiledAt = memo.compiledAt;
  if (memo.lastError) snapshot.lastError = memo.lastError;
  return snapshot;
}

function buildArguments(request, timeoutMs, english) {
  const args = [];
  const push = (flag, value) => {
    if (typeof value === 'string' && value.length > 0) {
      args.push(flag, value);
    }
  };

  push('--title', clipText(request.title) || (english ? 'Approval requested' : '请求审批'));
  push('--subtitle', clipText(request.subtitle));
  push('--body', clipText(request.body) || (english ? 'This action needs your confirmation.' : '此操作需要你的确认。'));
  push('--meta', clipText(request.meta) || (english ? 'DeepSeek Harness · Waiting for approval' : 'DeepSeek Harness · 等待审批'));
  push('--allow', clipText(request.allowLabel) || (english ? 'Allow once' : '允许一次'));
  push('--deny', clipText(request.denyLabel) || (english ? 'Deny' : '拒绝'));
  push('--dismiss', clipText(request.dismissLabel) || (english ? 'Close' : '关闭'));
  args.push('--timeout-ms', String(timeoutMs));
  args.push('--locale', english ? 'en' : 'zh');
  return args;
}

function isValidSignal(signal) {
  return signal !== null && typeof signal === 'object' && typeof signal.aborted === 'boolean'
    && typeof signal.addEventListener === 'function'
    && typeof signal.removeEventListener === 'function';
}

function runPanel(binaryPath, args, timeoutMs, signal) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      memo.binaryUsable = false;
      memo.lastError = `native panel failed to start: ${readableError(error)}`;
      warnOnce(memo.lastError);
      resolve('unavailable');
      return;
    }

    const debug = process.env.DSH_NOTIFY_DEBUG === '1';
    let settled = false;
    let aborted = false;
    let outerTimedOut = false;
    let choice = null;
    let stdoutBuffer = '';
    let stderrText = '';
    let abortListener = null;

    let outerTimer = null;
    let hardKillTimer = null;
    let abortFallbackTimer = null;
    let timeoutFallbackTimer = null;

    const clearTimer = (timer) => {
      if (timer !== null) clearTimeout(timer);
      return null;
    };

    const cleanup = () => {
      outerTimer = clearTimer(outerTimer);
      hardKillTimer = clearTimer(hardKillTimer);
      abortFallbackTimer = clearTimer(abortFallbackTimer);
      timeoutFallbackTimer = clearTimer(timeoutFallbackTimer);
      if (signal && abortListener) {
        try {
          signal.removeEventListener('abort', abortListener);
        } catch {
          // Ignore teardown races.
        }
      }
      abortListener = null;
    };

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };

    const ingestLine = (line) => {
      const trimmed = String(line ?? '').trim();
      if (trimmed.length === 0) return;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return; // Panel logs go to stderr; be tolerant of anything else.
      }
      if (parsed && typeof parsed === 'object' && VALID_CHOICES.has(parsed.choice)) {
        choice = parsed.choice;
      }
    };

    child.stdout?.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) ingestLine(line);
    });

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderrText = `${stderrText}${text}`.slice(-8192);
      if (debug) process.stderr.write(text);
    });

    child.on('error', (error) => {
      memo.binaryUsable = false;
      memo.lastError = `native panel failed to start: ${readableError(error)}`;
      warnOnce(memo.lastError);
      finish('unavailable');
    });

    child.on('close', (code, closeSignal) => {
      if (stdoutBuffer.length > 0) {
        ingestLine(stdoutBuffer);
        stdoutBuffer = '';
      }

      if (aborted) {
        finish('dismiss');
        return;
      }
      if (choice) {
        finish(choice);
        return;
      }
      if (outerTimedOut) {
        finish('timeout');
        return;
      }

      memo.binaryUsable = false;
      const detail = tail(stderrText) || 'no diagnostic output';
      memo.lastError = `native panel exited without a choice (code ${code}${closeSignal ? `, signal ${closeSignal}` : ''}): ${detail}`;
      warnOnce(memo.lastError);
      finish('unavailable');
    });

    const killChild = (killSignal) => {
      try {
        child.kill(killSignal);
      } catch {
        // Process already reaped.
      }
    };

    if (signal && isValidSignal(signal) && signal.aborted) {
      aborted = true;
      killChild('SIGTERM');
      abortFallbackTimer = setTimeout(() => finish('dismiss'), 2000);
      if (abortFallbackTimer.unref) abortFallbackTimer.unref();
      return;
    }

    if (signal && isValidSignal(signal)) {
      abortListener = () => {
        if (settled) return;
        aborted = true;
        killChild('SIGTERM');
        // Guarantee the child cannot outlive a stuck termination.
        hardKillTimer = setTimeout(() => killChild('SIGKILL'), 500);
        abortFallbackTimer = setTimeout(() => finish('dismiss'), 2000);
        if (abortFallbackTimer.unref) abortFallbackTimer.unref();
      };
      try {
        signal.addEventListener('abort', abortListener, { once: true });
      } catch {
        abortListener = null;
      }
    }

    // Outer safety net: the panel owns its own timeout; this only guards against
    // a hung/blocked panel process (timeoutMs + 3000 ms).
    outerTimer = setTimeout(() => {
      outerTimedOut = true;
      killChild('SIGTERM');
      hardKillTimer = setTimeout(() => killChild('SIGKILL'), 700);
      timeoutFallbackTimer = setTimeout(() => finish('timeout'), 2000);
      if (timeoutFallbackTimer.unref) timeoutFallbackTimer.unref();
    }, timeoutMs + 3000);
    if (outerTimer.unref) outerTimer.unref();
  });
}

/**
 * Show one native approval panel.
 *
 * Always resolves, never rejects.
 *
 * @param {{
 *   title: string,
 *   subtitle?: string,
 *   body: string,
 *   meta?: string,
 *   allowLabel: string,
 *   denyLabel: string,
 *   dismissLabel?: string,
 *   timeoutMs: number,
 *   locale?: 'zh' | 'en'
 * }} request
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<'allow'|'deny'|'dismiss'|'timeout'|'unavailable'>}
 */
export async function prompt(request, options) {
  const input = request && typeof request === 'object' ? request : {};
  const settings = options && typeof options === 'object' ? options : {};

  try {
    if (!PLATFORM_SUPPORTED) return 'unavailable';

    const signal = settings.signal;
    if (isValidSignal(signal) && signal.aborted) return 'dismiss';

    const timeoutMs = Math.round(
      Math.min(Math.max(numeric(input.timeoutMs, 180_000), 1000), 24 * 60 * 60 * 1000),
    );

    const binaryPath = await ensureBinary();
    if (!binaryPath) return 'unavailable';

    // A signal could arrive while clang was running.
    if (isValidSignal(signal) && signal.aborted) return 'dismiss';

    const english = input.locale === 'en';
    const args = buildArguments(input, timeoutMs, english);
    return await runPanel(binaryPath, args, timeoutMs, signal);
  } catch (error) {
    memo.lastError = `native panel failed: ${readableError(error)}`;
    warnOnce(memo.lastError);
    return 'unavailable';
  }
}
