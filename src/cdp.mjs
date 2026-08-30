/**
 * A very small Chrome DevTools Protocol client, over the WebSocket Node ships
 * with. No dependencies.
 *
 * The alternative was a peer dependency on a browser automation library, which
 * would have been less code here and several hundred megabytes there. CDP is
 * JSON over a socket; the part of it this needs is Page.navigate and
 * Runtime.evaluate, and that part is small enough to own.
 *
 * This is not a browser automation library and should not grow into one. If a
 * feature here starts wanting selectors, waiting strategies or a frame tree,
 * that is the point to take the dependency instead.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Where a Chromium lives on each platform, in the order worth trying. */
const BROWSERS = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
};

export function findBrowser(configured) {
  const candidates = [configured, process.env.CHROME_PATH, ...(BROWSERS[process.platform] ?? [])];
  for (const path of candidates) {
    if (path && existsSync(path)) return path;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll the endpoint until Chrome answers, or give up with a useful message. */
async function waitForEndpoint(base, timeout) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/json/version`);
      if (res.ok) return await res.json();
    } catch (error) {
      last = error;
    }
    await sleep(100);
  }
  throw new Error(`no CDP endpoint at ${base} after ${timeout}ms${last ? `: ${last.message}` : ''}`);
}

/**
 * A page to evaluate against, plus a close() that tears down whatever this
 * function created and nothing it did not. Connecting to a browser somebody
 * else started must not kill it.
 */
export async function connect({ endpoint, browserPath, timeout = 15000 }) {
  let child = null;
  let profile = null;
  let base = endpoint;

  if (!base) {
    const binary = findBrowser(browserPath);
    if (!binary) {
      throw new Error(
        'no Chrome or Chromium found. Set runtime.browserPath, or CHROME_PATH, or ' +
          'start a browser with --remote-debugging-port and set runtime.endpoint.',
      );
    }
    // Port 0 lets the OS choose, so two runs never collide. Chrome writes the
    // port it actually took into the profile directory.
    profile = mkdtempSync(join(tmpdir(), 'taste-check-cdp-'));
    child = spawn(
      binary,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        '--hide-scrollbars',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const port = await new Promise((resolve, reject) => {
      let buffer = '';
      const onData = (chunk) => {
        buffer += chunk;
        const match = buffer.match(/ws:\/\/127\.0\.0\.1:(\d+)\//);
        if (match) settle(resolve, Number(match[1]));
      };
      const onExit = (code) => settle(reject, new Error(`the browser exited with code ${code}`));
      const timer = setTimeout(
        () => settle(reject, new Error('the browser did not report a debugging port')),
        timeout,
      );
      const settle = (fn, value) => {
        clearTimeout(timer);
        child.stderr.off('data', onData);
        child.off('exit', onExit);
        fn(value);
      };
      child.stderr.on('data', onData);
      child.on('exit', onExit);
    });
    // Nothing reads the browser's stderr after this, and a piped stream with
    // a live child on the other end holds the event loop open. Without both
    // of these the process sits idle until the browser happens to exit, which
    // reads as a mysteriously slow run rather than as a leak.
    child.stderr.destroy();
    child.unref();
    base = `http://127.0.0.1:${port}`;
  }

  await waitForEndpoint(base, timeout);
  const list = await (await fetch(`${base}/json/list`)).json();
  const target =
    list.find((t) => t.type === 'page') ??
    (await (await fetch(`${base}/json/new?about:blank`, { method: 'PUT' })).json());

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`could not open a socket to ${target.webSocketDebuggerUrl}`));
  });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  };

  // Every timer here is cleared on the happy path. An uncancelled one keeps
  // the event loop alive until it fires, which turns a fast run into a wait
  // for the full timeout and looks exactly like a slow browser.
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => {
        if (pending.delete(n)) reject(new Error(`${method} timed out after ${timeout}ms`));
      }, timeout);
      pending.set(n, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      ws.send(JSON.stringify({ id: n, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');

  return {
    send,
    /** Navigate and wait for the load event rather than for a fixed delay. */
    async goto(url) {
      let onMessage;
      let timer;
      const loaded = new Promise((resolve) => {
        onMessage = (event) => {
          if (JSON.parse(event.data).method === 'Page.loadEventFired') resolve();
        };
        ws.addEventListener('message', onMessage);
        timer = setTimeout(resolve, timeout);
      });
      try {
        await send('Page.navigate', { url });
        await loaded;
      } finally {
        ws.removeEventListener('message', onMessage);
        clearTimeout(timer);
      }
    },
    /**
     * Register a script to run on every navigation, before the page's own
     * scripts. This is where a theme goes: setting localStorage after load and
     * reloading would wipe anything the reload undoes, and setting it without
     * a reload is too late for a page that reads it on boot.
     */
    async onNewDocument(source) {
      const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', { source });
      return identifier;
    },
    /** Remove one, so a state cannot leak into the next one. */
    async removeNewDocumentScript(identifier) {
      await send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    },
    /** Evaluate in the page and return the value, awaiting a promise result. */
    async evaluate(expression) {
      const { result, exceptionDetails } = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (exceptionDetails) {
        throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      }
      return result.value;
    },
    /**
     * Best effort, and deliberately incapable of throwing. Teardown failing
     * must never take down a run whose measurements already succeeded, and a
     * temp directory the browser is still writing into is not worth a crash.
     */
    close() {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      if (!child) return;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      if (profile) {
        try {
          rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        } catch {
          /* the OS will collect it */
        }
      }
    },
  };
}
