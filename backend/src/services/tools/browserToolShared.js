import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

import { createToolResultHook, normalizeToolResultHooks } from "./toolResultHooks.js";

const SESSION_BY_CONVERSATION = new Map();
const DEFAULT_CONNECT_TIMEOUT_MS = 12000;
const MAX_DEVTOOLS_ENTRIES = 200;
const MAX_COMMAND_STEPS = 20;

function normalizeConversationId(executionContext = {}) {
  const conversationId = String(executionContext?.conversationId ?? "").trim();
  if (!conversationId) {
    throw new Error("conversationId is required for browser tools");
  }
  return conversationId;
}

function resolveContextWorkingDirectory(executionContext = {}) {
  const candidate =
    typeof executionContext.workingDirectory === "string"
      ? executionContext.workingDirectory.trim()
      : typeof executionContext.workplacePath === "string"
        ? executionContext.workplacePath.trim()
        : "";
  return candidate ? path.resolve(candidate) : process.cwd();
}

function sanitizeScreenshotFileName(value) {
  const normalized = String(value ?? "").trim();
  const fallback = `browser-screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
  const fileName = normalized || fallback;
  return fileName.toLowerCase().endsWith(".png") ? fileName : `${fileName}.png`;
}

async function resolveScreenshotPath(args = {}, executionContext = {}) {
  const cwd = resolveContextWorkingDirectory(executionContext);
  const outputPath = String(args.outputPath ?? args.filePath ?? "").trim();
  const fileName = sanitizeScreenshotFileName(args.fileName);
  const targetPath = outputPath
    ? path.resolve(cwd, outputPath)
    : path.resolve(cwd, fileName);
  const finalPath = targetPath.toLowerCase().endsWith(".png")
    ? targetPath
    : path.join(targetPath, fileName);
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  return finalPath;
}

function normalizeBrowserPreference(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "edge" || normalized === "chrome") {
    return normalized;
  }
  return "auto";
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveExecutable(preference = "auto") {
  const localAppData = String(process.env.LOCALAPPDATA ?? "").trim();
  const programFiles = String(process.env.ProgramFiles ?? "").trim();
  const programFilesX86 = String(process.env["ProgramFiles(x86)"] ?? "").trim();
  const candidates = {
    edge: [
      path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
      "msedge.exe"
    ],
    chrome: [
      path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      "chrome.exe"
    ]
  };

  const order =
    preference === "edge"
      ? ["edge", "chrome"]
      : preference === "chrome"
        ? ["chrome", "edge"]
        : ["edge", "chrome"];

  for (const browserKey of order) {
    for (const candidate of candidates[browserKey]) {
      if (!candidate) {
        continue;
      }
      if (candidate.endsWith(".exe")) {
        if (await pathExists(candidate)) {
          return { browserKey, executablePath: candidate };
        }
      } else {
        return { browserKey, executablePath: candidate };
      }
    }
  }

  throw new Error("Cannot find Edge or Chrome executable on this machine");
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") {
        server.close(() => reject(new Error("Failed to reserve browser debug port")));
        return;
      }
      const port = Number(address.port ?? 0);
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForCdpUrl(port, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS) {
  const start = Date.now();
  const endpoint = `http://127.0.0.1:${port}/json/version`;

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        const payload = await response.json();
        const ws = String(payload?.webSocketDebuggerUrl ?? "").trim();
        if (ws) {
          return ws;
        }
      }
    } catch {
      // ignore and retry
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error("Timed out waiting for browser CDP endpoint");
}

async function pickActivePage(context) {
  const pages = context.pages();
  if (pages.length > 0) {
    return pages[pages.length - 1];
  }
  return context.newPage();
}

function pushLimited(list, entry, maxLength = MAX_DEVTOOLS_ENTRIES) {
  if (!Array.isArray(list)) {
    return;
  }
  list.push(entry);
  if (list.length > maxLength) {
    list.splice(0, list.length - maxLength);
  }
}

function trimText(value, maxLength = 4000) {
  const text = String(value ?? "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 16))}\n...[truncated]`;
}

function escapeCssAttributeValue(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function registerPageDiagnostics(session, page) {
  if (!session || !page || page.__yyzClawDiagnosticsAttached) {
    return;
  }
  page.__yyzClawDiagnosticsAttached = true;

  page.on("console", async (message) => {
    const args = [];
    for (const arg of message.args()) {
      try {
        const jsonValue = await arg.jsonValue();
        args.push(typeof jsonValue === "string" ? jsonValue : JSON.stringify(jsonValue));
      } catch {
        args.push(String(arg));
      }
    }

    pushLimited(session.consoleEntries, {
      type: message.type(),
      text: trimText(message.text()),
      args: args.map((item) => trimText(item, 1000)),
      location: message.location(),
      url: page.url(),
      createdAt: Date.now()
    });
  });

  page.on("pageerror", (error) => {
    pushLimited(session.pageErrors, {
      message: trimText(error?.message ?? error),
      stack: trimText(error?.stack ?? ""),
      url: page.url(),
      createdAt: Date.now()
    });
  });

  page.on("requestfailed", (request) => {
    pushLimited(session.networkEntries, {
      type: "requestfailed",
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      failure: request.failure()?.errorText ?? "",
      createdAt: Date.now()
    });
  });

  page.on("response", (response) => {
    const status = response.status();
    if (status < 400) {
      return;
    }

    const request = response.request();
    pushLimited(session.networkEntries, {
      type: "http_error",
      method: request.method(),
      url: response.url(),
      resourceType: request.resourceType(),
      status,
      statusText: response.statusText(),
      createdAt: Date.now()
    });
  });
}

async function launchBrowserSession(conversationId, preference = "auto") {
  const resolved = await resolveExecutable(preference);
  const port = await reservePort();
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "yyz-claw-browser-"));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    "about:blank"
  ];
  const child = spawn(resolved.executablePath, args, {
    stdio: "ignore",
    windowsHide: false
  });
  child.unref();

  const wsEndpoint = await waitForCdpUrl(port);
  const browser = await chromium.connectOverCDP(wsEndpoint);
  const contexts = browser.contexts();
  const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
  const page = await pickActivePage(context);

  const session = {
    conversationId,
    browserPreference: preference,
    browserKey: resolved.browserKey,
    executablePath: resolved.executablePath,
    port,
    userDataDir,
    process: child,
    browser,
    context,
    page,
    wsEndpoint,
    consoleEntries: [],
    pageErrors: [],
    networkEntries: []
  };

  registerPageDiagnostics(session, page);
  context.on("page", (newPage) => {
    session.page = newPage;
    registerPageDiagnostics(session, newPage);
  });

  SESSION_BY_CONVERSATION.set(conversationId, session);
  return session;
}

async function ensureSession(executionContext = {}, options = {}) {
  const conversationId = normalizeConversationId(executionContext);
  const preferredBrowser = normalizeBrowserPreference(options.browser ?? options.preferredBrowser);
  const existing = SESSION_BY_CONVERSATION.get(conversationId);
  if (existing) {
    try {
      if (!existing.page.isClosed()) {
        return existing;
      }
    } catch {
      // continue and recreate
    }
  }
  return launchBrowserSession(conversationId, preferredBrowser);
}

async function closeSessionByConversationId(conversationId) {
  const session = SESSION_BY_CONVERSATION.get(conversationId);
  if (!session) {
    return false;
  }
  SESSION_BY_CONVERSATION.delete(conversationId);

  try {
    await session.browser?.close();
  } catch {
    // ignore
  }

  try {
    session.process?.kill();
  } catch {
    // ignore
  }

  try {
    await fs.rm(session.userDataDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  return true;
}

async function getCurrentPage(executionContext = {}, options = {}) {
  const session = await ensureSession(executionContext, options);
  const page = session.page?.isClosed?.() ? await pickActivePage(session.context) : session.page;
  session.page = page;
  registerPageDiagnostics(session, page);
  return { session, page };
}

function buildImageAttachmentFromBuffer(buffer, name = "browser_screenshot.png") {
  const mimeType = "image/png";
  return {
    id: `browser_image_${Date.now()}`,
    type: "image",
    name,
    mimeType,
    dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`,
    size: buffer.byteLength
  };
}

function createEnvelope(result, hooks = [], imageAttachments = []) {
  return {
    __toolResultEnvelope: true,
    result,
    hooks: normalizeToolResultHooks(hooks),
    imageAttachments
  };
}

async function buildPageSnapshot(page) {
  const [title, url, textContent, interactiveElements] = await Promise.all([
    page.title().catch(() => ""),
    Promise.resolve(page.url()).catch(() => ""),
    page.evaluate(() => document.body?.innerText?.slice(0, 6000) ?? "").catch(() => ""),
    page
      .evaluate(() => {
        const nodes = Array.from(
          document.querySelectorAll(
            "a,button,input,textarea,select,[role='button'],[role='link'],[tabindex]"
          )
        );
        return nodes.slice(0, 40).map((node, index) => {
          const id = node.id ? `#${node.id}` : "";
          const className =
            typeof node.className === "string" && node.className.trim()
              ? `.${node.className.trim().replace(/\s+/g, ".")}`
              : "";
          const text = (node.textContent || node.getAttribute("aria-label") || "").trim();
          return {
            index: index + 1,
            tag: String(node.tagName || "").toLowerCase(),
            selector: `${String(node.tagName || "").toLowerCase()}${id}${className}`,
            text: text.slice(0, 120)
          };
        });
      })
      .catch(() => [])
  ]);

  return {
    title: String(title ?? "").trim(),
    url: String(url ?? "").trim(),
    text: String(textContent ?? "").trim(),
    interactiveElements: Array.isArray(interactiveElements) ? interactiveElements : []
  };
}

export async function browserOpen(args = {}, executionContext = {}) {
  const requestedBrowser = normalizeBrowserPreference(args.browser);
  const conversationId = normalizeConversationId(executionContext);
  const existingSession = SESSION_BY_CONVERSATION.get(conversationId) ?? null;
  const shouldReuseExistingSession =
    existingSession &&
    requestedBrowser !== "auto" &&
    String(existingSession.browserKey ?? "").trim().toLowerCase() !== requestedBrowser;

  const { session, page } = await getCurrentPage(executionContext, {
    browser: shouldReuseExistingSession ? existingSession.browserKey : requestedBrowser
  });
  const url = String(args.url ?? "").trim();
  if (url) {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
  }
  return createEnvelope(
    {
      status: shouldReuseExistingSession ? "reused_existing_session" : "opened",
      requestedBrowser,
      activeBrowser: String(session.browserKey ?? "").trim().toLowerCase(),
      browser: session.browserKey,
      url: page.url(),
      message: shouldReuseExistingSession
        ? `当前会话已打开 ${String(session.browserKey ?? "").trim().toLowerCase()} 实例；如需切换到 ${requestedBrowser}，请先调用 browser_close 再重新 browser_open`
        : `已打开 ${String(session.browserKey ?? "").trim().toLowerCase()} 实例`,
      sessionInfo: {
        conversationId,
        executablePath: String(session.executablePath ?? "").trim(),
        debugPort: Number(session.port ?? 0)
      },
      availableBrowsers: ["edge", "chrome"]
    },
    [
      createToolResultHook({
        level: "info",
        message: `已启动可见浏览器（${session.browserKey}）`
      })
    ]
  );
}

export async function browserNavigate(args = {}, executionContext = {}) {
  const url = String(args.url ?? "").trim();
  if (!url) {
    throw new Error("url is required");
  }
  const { page } = await getCurrentPage(executionContext, {
    browser: args.browser
  });
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 45000
  });
  return createEnvelope(
    {
      url: page.url(),
      title: await page.title().catch(() => "")
    },
    [
      createToolResultHook({
        level: "info",
        message: "页面已打开"
      })
    ]
  );
}

export async function browserClick(args = {}, executionContext = {}) {
  const selector = String(args.selector ?? "").trim();
  const text = String(args.text ?? "").trim();
  const hrefContains = String(args.hrefContains ?? "").trim();
  const x = Number(args.x);
  const y = Number(args.y);
  const hasCoordinates = Number.isFinite(x) && Number.isFinite(y);
  if (!selector && !text && !hrefContains && !hasCoordinates) {
    throw new Error("selector or text or hrefContains or x/y is required");
  }

  const timeoutMs = Math.min(Math.max(Number(args.timeoutMs ?? 15000) || 15000, 1000), 45000);
  const stepTimeoutMs = Math.max(1500, Math.floor(timeoutMs / 3));
  const { page } = await getCurrentPage(executionContext);
  await page.waitForLoadState("domcontentloaded").catch(() => {});

  const attempts = [];
  const frames = [page.mainFrame(), ...page.frames().filter((frame) => frame !== page.mainFrame())];
  const escapedHrefContains = escapeCssAttributeValue(hrefContains);
  const escapedText = escapeCssAttributeValue(text);
  const quotedText = JSON.stringify(text);
  const candidates = [];

  if (text) {
    for (const frame of frames) {
      candidates.push({
        label: `role-button-name:${text} frame:${frame.url() || "main"}`,
        locator: frame.getByRole("button", { name: text }).first()
      });
      candidates.push({
        label: `role-link-name:${text} frame:${frame.url() || "main"}`,
        locator: frame.getByRole("link", { name: text }).first()
      });
      candidates.push({
        label: `role-menuitem-name:${text} frame:${frame.url() || "main"}`,
        locator: frame.getByRole("menuitem", { name: text }).first()
      });
      candidates.push({
        label: `label:${text} frame:${frame.url() || "main"}`,
        locator: frame.getByLabel(text).first()
      });
      candidates.push({
        label: `placeholder:${text} frame:${frame.url() || "main"}`,
        locator: frame.getByPlaceholder(text).first()
      });
      candidates.push({
        label: `title:${text} frame:${frame.url() || "main"}`,
        locator: frame.getByTitle(text).first()
      });
      candidates.push({
        label: `text-exact:${text} frame:${frame.url() || "main"}`,
        locator: frame.getByText(text, { exact: true }).first()
      });
      candidates.push({
        label: `aria-label:${text} frame:${frame.url() || "main"}`,
        locator: frame.locator(`[aria-label*="${escapedText}"]`).first()
      });
      candidates.push({
        label: `text-contains:${text} frame:${frame.url() || "main"}`,
        locator: frame.locator(`text=${quotedText}`).first()
      });
      candidates.push({
        label: `input-value:${text} frame:${frame.url() || "main"}`,
        locator: frame.locator(`input[value*="${escapedText}"]`).first()
      });
    }
  }

  if (selector) {
    for (const frame of frames) {
      candidates.push({
        label: `selector:${selector} frame:${frame.url() || "main"}`,
        locator: frame.locator(selector).first()
      });
    }
  }

  if (hrefContains) {
    for (const frame of frames) {
      candidates.push({
        label: `hrefContains:${hrefContains} frame:${frame.url() || "main"}`,
        locator: frame.locator(`a[href*="${escapedHrefContains}"]`).first()
      });
    }
  }

  for (const candidate of candidates) {
    try {
      await candidate.locator.waitFor({ state: "visible", timeout: stepTimeoutMs });
      await candidate.locator.scrollIntoViewIfNeeded({ timeout: Math.min(stepTimeoutMs, 5000) }).catch(() => {});
      await candidate.locator.click({ timeout: stepTimeoutMs, trial: true }).catch(() => {});
      await candidate.locator.click({ timeout: stepTimeoutMs });
      return createEnvelope({
        url: page.url(),
        matched: candidate.label,
        selector,
        text,
        hrefContains
      });
    } catch (error) {
      attempts.push(`${candidate.label} -> ${String(error?.message ?? error).split("\n")[0]}`);
    }
  }

  if (hasCoordinates) {
    try {
      await page.mouse.click(x, y, {
        timeout: stepTimeoutMs
      });
      return createEnvelope(
        {
          url: page.url(),
          matched: `coordinates:${x},${y}`,
          selector,
          text,
          hrefContains,
          x,
          y
        },
        [
          createToolResultHook({
            level: "warning",
            message: `已使用坐标兜底点击 (${x}, ${y})`
          })
        ]
      );
    } catch (error) {
      attempts.push(`coordinates:${x},${y} -> ${String(error?.message ?? error).split("\n")[0]}`);
    }
  }

  const snapshot = await buildPageSnapshot(page);
  const hintLines = (Array.isArray(snapshot?.interactiveElements) ? snapshot.interactiveElements : [])
    .slice(0, 10)
    .map((item) => `#${item.index} ${item.tag} ${item.selector} ${item.text}`.trim());

  throw new Error(
    [
      "browser_click failed after trying multiple strategies.",
      `input selector=${selector || "-"} text=${text || "-"} hrefContains=${hrefContains || "-"}`,
      attempts.length > 0 ? `attempts:\n- ${attempts.join("\n- ")}` : "",
      hintLines.length > 0 ? `interactive hints:\n- ${hintLines.join("\n- ")}` : ""
    ]
      .filter(Boolean)
      .join("\n")
  );
}

export async function browserType(args = {}, executionContext = {}) {
  const selector = String(args.selector ?? "").trim();
  const text = String(args.text ?? "");
  if (!selector) {
    throw new Error("selector is required");
  }
  const { page } = await getCurrentPage(executionContext);
  if (Boolean(args.clear ?? true)) {
    await page.fill(selector, "");
  }
  await page.fill(selector, text);
  if (Boolean(args.pressEnter ?? false)) {
    await page.keyboard.press("Enter");
  }
  return createEnvelope({ selector, typed: text.length });
}

export async function browserScroll(args = {}, executionContext = {}) {
  const x = Number(args.x ?? 0);
  const y = Number(args.y ?? 600);
  const { page } = await getCurrentPage(executionContext);
  await page.evaluate(
    ({ xValue, yValue }) => {
      window.scrollBy(xValue, yValue);
    },
    { xValue: Number.isFinite(x) ? x : 0, yValue: Number.isFinite(y) ? y : 600 }
  );
  return createEnvelope({ x, y, url: page.url() });
}

export async function browserWait(args = {}, executionContext = {}) {
  const timeoutMs = Math.min(Math.max(Number(args.timeoutMs ?? 1500) || 1500, 100), 60000);
  const selector = String(args.selector ?? "").trim();
  const { page } = await getCurrentPage(executionContext);
  if (selector) {
    await page.waitForSelector(selector, { timeout: timeoutMs });
  } else {
    await page.waitForTimeout(timeoutMs);
  }
  return createEnvelope({ waitedMs: timeoutMs, selector });
}

export async function browserSnapshot(args = {}, executionContext = {}) {
  const { page } = await getCurrentPage(executionContext);
  const snapshot = await buildPageSnapshot(page);
  return createEnvelope(snapshot, [
    createToolResultHook({
      level: "info",
      message: "已获取页面快照"
    })
  ]);
}

export async function browserScreenshot(args = {}, executionContext = {}) {
  const fullPage = Boolean(args.fullPage ?? true);
  const { page } = await getCurrentPage(executionContext);
  const filePath = await resolveScreenshotPath(args, executionContext);
  await page.screenshot({
    path: filePath,
    fullPage,
    type: "png"
  });
  const stat = await fs.stat(filePath);
  return createEnvelope(
    {
      url: page.url(),
      fullPage,
      filePath,
      bytes: Number(stat.size ?? 0)
    },
    [
      createToolResultHook({
        level: "info",
        message: `已保存页面截图：${filePath}`
      })
    ]
  );
}

export async function browserVision(args = {}, executionContext = {}) {
  const { page } = await getCurrentPage(executionContext);
  const screenshot = await page.screenshot({
    fullPage: Boolean(args.fullPage ?? true),
    type: "png"
  });
  const attachment = buildImageAttachmentFromBuffer(screenshot, "browser_vision.png");
  const snapshot = await buildPageSnapshot(page);
  return createEnvelope(
    {
      url: snapshot.url,
      title: snapshot.title,
      note: "请结合截图进行视觉判断",
      text: snapshot.text
    },
    [
      createToolResultHook({
        level: "info",
        message: "已提供视觉截图供后续判断"
      })
    ],
    [attachment]
  );
}

export async function browserClose(_args = {}, executionContext = {}) {
  const conversationId = normalizeConversationId(executionContext);
  const closed = await closeSessionByConversationId(conversationId);
  return createEnvelope(
    {
      closed
    },
    [
      createToolResultHook({
        level: "info",
        message: closed ? "浏览器会话已关闭" : "当前没有活动浏览器会话"
      })
    ]
  );
}

export async function browserConsole(args = {}, executionContext = {}) {
  const limit = Math.min(Math.max(Number(args.limit ?? 80) || 80, 1), MAX_DEVTOOLS_ENTRIES);
  const clear = Boolean(args.clear ?? false);
  const { session } = await getCurrentPage(executionContext);
  const entries = session.consoleEntries.slice(-limit);
  const pageErrors = session.pageErrors.slice(-limit);

  if (clear) {
    session.consoleEntries.length = 0;
    session.pageErrors.length = 0;
  }

  return createEnvelope({
    entries,
    pageErrors,
    count: entries.length,
    pageErrorCount: pageErrors.length,
    cleared: clear
  });
}

export async function browserNetwork(args = {}, executionContext = {}) {
  const limit = Math.min(Math.max(Number(args.limit ?? 80) || 80, 1), MAX_DEVTOOLS_ENTRIES);
  const clear = Boolean(args.clear ?? false);
  const { session } = await getCurrentPage(executionContext);
  const entries = session.networkEntries.slice(-limit);

  if (clear) {
    session.networkEntries.length = 0;
  }

  return createEnvelope({
    entries,
    count: entries.length,
    cleared: clear
  });
}

export async function browserStorage(args = {}, executionContext = {}) {
  const includeCookies = Boolean(args.cookies ?? true);
  const includeLocalStorage = Boolean(args.localStorage ?? true);
  const includeSessionStorage = Boolean(args.sessionStorage ?? true);
  const { session, page } = await getCurrentPage(executionContext);
  const [cookies, storage] = await Promise.all([
    includeCookies ? session.context.cookies().catch(() => []) : Promise.resolve([]),
    page
      .evaluate(
        ({ readLocalStorage, readSessionStorage }) => {
          function readStorage(storage) {
            const result = {};
            for (let index = 0; index < storage.length; index += 1) {
              const key = storage.key(index);
              if (key) {
                result[key] = storage.getItem(key);
              }
            }
            return result;
          }

          return {
            localStorage: readLocalStorage ? readStorage(window.localStorage) : {},
            sessionStorage: readSessionStorage ? readStorage(window.sessionStorage) : {}
          };
        },
        {
          readLocalStorage: includeLocalStorage,
          readSessionStorage: includeSessionStorage
        }
      )
      .catch((error) => ({
        localStorage: {},
        sessionStorage: {},
        error: String(error?.message ?? error)
      }))
  ]);

  return createEnvelope({
    url: page.url(),
    cookies,
    localStorage: storage.localStorage ?? {},
    sessionStorage: storage.sessionStorage ?? {},
    error: storage.error ?? ""
  });
}

export async function browserStorageClear(args = {}, executionContext = {}) {
  const clearCookies = Boolean(args.cookies ?? false);
  const clearLocalStorage = Boolean(args.localStorage ?? true);
  const clearSessionStorage = Boolean(args.sessionStorage ?? true);
  const { session, page } = await getCurrentPage(executionContext);

  if (clearCookies) {
    await session.context.clearCookies();
  }

  await page.evaluate(
    ({ shouldClearLocalStorage, shouldClearSessionStorage }) => {
      if (shouldClearLocalStorage) {
        window.localStorage.clear();
      }
      if (shouldClearSessionStorage) {
        window.sessionStorage.clear();
      }
    },
    {
      shouldClearLocalStorage: clearLocalStorage,
      shouldClearSessionStorage: clearSessionStorage
    }
  );

  return createEnvelope({
    url: page.url(),
    cleared: {
      cookies: clearCookies,
      localStorage: clearLocalStorage,
      sessionStorage: clearSessionStorage
    }
  });
}

function normalizeCommandSteps(args = {}) {
  const steps = Array.isArray(args.steps) ? args.steps : [];
  if (steps.length === 0) {
    throw new Error("steps is required");
  }
  if (steps.length > MAX_COMMAND_STEPS) {
    throw new Error(`too many steps; max ${MAX_COMMAND_STEPS}`);
  }
  return steps;
}

export async function browserCommand(args = {}, executionContext = {}) {
  const steps = normalizeCommandSteps(args);
  const results = [];

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index] ?? {};
    const action = String(step.action ?? "").trim();
    const stepArgs = step.args && typeof step.args === "object" && !Array.isArray(step.args)
      ? step.args
      : {};

    if (!action) {
      throw new Error(`step ${index + 1} action is required`);
    }

    let resultEnvelope;
    if (action === "navigate") {
      resultEnvelope = await browserNavigate(stepArgs, executionContext);
    } else if (action === "click") {
      resultEnvelope = await browserClick(stepArgs, executionContext);
    } else if (action === "type") {
      resultEnvelope = await browserType(stepArgs, executionContext);
    } else if (action === "scroll") {
      resultEnvelope = await browserScroll(stepArgs, executionContext);
    } else if (action === "wait") {
      resultEnvelope = await browserWait(stepArgs, executionContext);
    } else if (action === "console") {
      resultEnvelope = await browserConsole(stepArgs, executionContext);
    } else if (action === "network") {
      resultEnvelope = await browserNetwork(stepArgs, executionContext);
    } else if (action === "storage") {
      resultEnvelope = await browserStorage(stepArgs, executionContext);
    } else if (action === "storage_clear") {
      resultEnvelope = await browserStorageClear(stepArgs, executionContext);
    } else {
      throw new Error(`unsupported browser command action: ${action}`);
    }

    results.push({
      index: index + 1,
      action,
      result: resultEnvelope?.result ?? resultEnvelope
    });
  }

  return createEnvelope({
    steps: results,
    count: results.length
  });
}
