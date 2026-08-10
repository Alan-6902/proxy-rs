"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const electron = require("electron");
const path = require("path");
const crypto = require("crypto");
const utils = require("@electron-toolkit/utils");
const fs$1 = require("fs/promises");
const cborX = require("cbor-x");
const undici = require("undici");
const uuid = require("uuid");
const fs = require("fs");
const tls = require("tls");
const jsTiktoken = require("js-tiktoken");
const tlsclientwrapper = require("tlsclientwrapper");
const net = require("net");
const socks = require("socks");
const nodemailer = require("nodemailer");
const node_crypto = require("node:crypto");
const node_fs = require("node:fs");
const node_path = require("node:path");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const path__namespace = /* @__PURE__ */ _interopNamespaceDefault(path);
const fs__namespace = /* @__PURE__ */ _interopNamespaceDefault(fs);
const tls__namespace = /* @__PURE__ */ _interopNamespaceDefault(tls);
function mergeRotatedKiroCredentials(accountData, accountId, expectedRefreshToken, expectedCredentialRevision, update) {
  if (!accountData || typeof accountData !== "object" || Array.isArray(accountData)) return null;
  const current = accountData;
  const account = current.accounts?.[accountId];
  if (!account) return null;
  const credentials = account.credentials ?? {};
  if (credentials.refreshToken !== expectedRefreshToken || credentials.credentialRevision !== expectedCredentialRevision) {
    return null;
  }
  const nextCredentials = {
    ...credentials,
    accessToken: update.accessToken
  };
  if (update.refreshToken !== void 0) nextCredentials.refreshToken = update.refreshToken;
  if (update.expiresAt !== void 0) nextCredentials.expiresAt = update.expiresAt;
  nextCredentials.credentialRevision = update.credentialRevision;
  return {
    ...current,
    accounts: {
      ...current.accounts,
      [accountId]: {
        ...account,
        credentials: nextCredentials
      }
    }
  };
}
const ROTATED_KIRO_CREDENTIAL_FIELDS = ["accessToken", "refreshToken", "expiresAt"];
function isRecord$2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasOwn(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key);
}
function mergeAccountDataPreservingRotatedKiroCredentials(currentAccountData, incomingAccountData) {
  if (!isRecord$2(currentAccountData) || !isRecord$2(incomingAccountData)) return incomingAccountData;
  const currentAccounts = currentAccountData.accounts;
  const incomingAccounts = incomingAccountData.accounts;
  if (!isRecord$2(currentAccounts) || !isRecord$2(incomingAccounts)) return incomingAccountData;
  let changed = false;
  const mergedAccounts = { ...incomingAccounts };
  for (const [accountId, incomingAccountValue] of Object.entries(incomingAccounts)) {
    const currentAccountValue = currentAccounts[accountId];
    if (!isRecord$2(currentAccountValue) || !isRecord$2(incomingAccountValue)) continue;
    const currentCredentials = currentAccountValue.credentials;
    const incomingCredentials = incomingAccountValue.credentials;
    if (!isRecord$2(currentCredentials)) continue;
    const currentRevision = currentCredentials.credentialRevision;
    if (typeof currentRevision !== "string" || currentRevision.length === 0) continue;
    if (isRecord$2(incomingCredentials) && incomingCredentials.credentialRevision === currentRevision) {
      continue;
    }
    const mergedCredentials = isRecord$2(incomingCredentials) ? { ...incomingCredentials } : {};
    for (const field of ROTATED_KIRO_CREDENTIAL_FIELDS) {
      if (hasOwn(currentCredentials, field)) mergedCredentials[field] = currentCredentials[field];
      else delete mergedCredentials[field];
    }
    mergedCredentials.credentialRevision = currentRevision;
    mergedAccounts[accountId] = {
      ...incomingAccountValue,
      credentials: mergedCredentials
    };
    changed = true;
  }
  if (!changed) return incomingAccountData;
  return {
    ...incomingAccountData,
    accounts: mergedAccounts
  };
}
class KiroCredentialRefreshSingleflight {
  operations = /* @__PURE__ */ new Map();
  run(key, operation) {
    const existing = this.operations.get(key);
    if (existing) return existing;
    const pending = Promise.resolve().then(operation);
    this.operations.set(key, pending);
    const cleanup = () => {
      if (this.operations.get(key) === pending) this.operations.delete(key);
    };
    void pending.then(cleanup, cleanup);
    return pending;
  }
  activeCount() {
    return this.operations.size;
  }
}
function shouldReuseCanonicalKiroCredentials(canonical, expectedRefreshToken, expectedCredentialRevision) {
  return canonical.refreshToken !== expectedRefreshToken || canonical.credentialRevision !== expectedCredentialRevision;
}
function buildKiroCredentialRefreshSingleflightKey(params) {
  return params.refreshToken;
}
const APP_NAME = "Proxy RS";
const APP_ID = "com.proxy.rs";
const APP_PACKAGE_NAME = "proxy-rs";
const APP_DATA_DIRECTORY_NAME = APP_NAME;
const APP_PROTOCOL_SCHEME = APP_PACKAGE_NAME;
const APP_SOCIAL_AUTH_REDIRECT_URI = `${APP_PROTOCOL_SCHEME}://kiro.kiroAgent/authenticate-success`;
const APP_ACCOUNT_STORE_NAME = `${APP_PACKAGE_NAME}-accounts`;
const APP_ACCOUNT_STORE_ENCRYPTION_KEY = `${APP_PACKAGE_NAME}-account-store-v1`;
class AccountStoreCoordinator {
  tail = Promise.resolve();
  async runExclusive(operation) {
    const previous = this.tail;
    let release;
    this.tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
const icon = path.join(__dirname, "../../resources/icon.png");
function resolveBackgroundRefreshPlan(credentials, needsTokenRefresh) {
  const kiroApiKey = credentials.kiroApiKey?.trim();
  const credentialKind = credentials.credentialKind ?? (kiroApiKey ? "kiro_api_key" : "oauth");
  if (credentialKind === "kiro_api_key") {
    return {
      credentialKind,
      kiroApiKey,
      shouldRefreshToken: false,
      shouldFetchUserInfo: false
    };
  }
  return {
    credentialKind: "oauth",
    accessToken: credentials.accessToken?.trim(),
    shouldRefreshToken: needsTokenRefresh,
    shouldFetchUserInfo: true
  };
}
function buildBackgroundRefreshPlan(credentials, needsTokenRefresh) {
  return resolveBackgroundRefreshPlan(credentials, needsTokenRefresh);
}
const SENSITIVE_KEYS = [
  "password",
  "passwd",
  "pwd",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "idtoken",
  "id_token",
  "bearertoken",
  "bearer",
  "authorization",
  "auth",
  "apikey",
  "api_key",
  "x-api-key",
  "clientsecret",
  "client_secret",
  "secret",
  "epin",
  "cookie",
  "set-cookie",
  "proxyauthorization",
  "proxy-authorization"
];
const SAFE_KEYS = /* @__PURE__ */ new Set([
  "inputtokens",
  "outputtokens",
  "cachetokens",
  "cachereadtokens",
  "cachewritetokens",
  "reasoningtokens",
  "totaltokens",
  "maxtokens",
  "tokensused",
  "tokencount"
]);
function maskMiddle(value, head = 3, tail = 2) {
  if (!value) return value;
  if (value.length <= head + tail + 2) return "***";
  return `${value.slice(0, head)}***${value.slice(-tail)}`;
}
function redactString(input) {
  if (!input) return input;
  let out = input;
  out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, (_m, scheme, user) => {
    return `${scheme}${user}:***@`;
  });
  out = out.replace(
    /(authorization\s*[:=]\s*)(bearer|basic)\s+([A-Za-z0-9._\-+/=]+)/gi,
    (_m, p, scheme) => {
      return `${p}${scheme} ***`;
    }
  );
  out = out.replace(
    /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
    (m) => maskMiddle(m, 6, 4)
  );
  out = out.replace(
    /("?(?:access_?token|refresh_?token|id_?token|password|api_?key|client_?secret|secret|epin)"?\s*[:=]\s*"?)([^",}\s]+)("?)/gi,
    (_m, prefix, val, suffix) => `${prefix}${maskMiddle(String(val))}${suffix}`
  );
  return out;
}
function isSensitiveKey(key) {
  const k = key.toLowerCase().replace(/[_-]/g, "");
  if (SAFE_KEYS.has(k)) return false;
  return SENSITIVE_KEYS.some(
    (s) => k === s.replace(/[_-]/g, "") || k.includes(s.replace(/[_-]/g, ""))
  );
}
function redactValue(value, maxDepth = 6, seen = /* @__PURE__ */ new WeakSet()) {
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (maxDepth <= 0) return "[depth-limit]";
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, maxDepth - 1, seen));
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveKey(k)) {
        out[k] = typeof v === "string" ? maskMiddle(v) : "***";
      } else {
        out[k] = redactValue(v, maxDepth - 1, seen);
      }
    }
    return out;
  }
  return value;
}
const DEFAULT_CONFIG = {
  enabled: false,
  maxFileSize: 10 * 1024 * 1024,
  // 10MB
  maxFiles: 5,
  logToConsole: true
};
class ProxyLogger {
  config;
  logStream = null;
  currentLogFile = "";
  currentFileSize = 0;
  constructor() {
    this.config = { ...DEFAULT_CONFIG };
  }
  configure(config) {
    this.config = { ...this.config, ...config };
    if (this.config.enabled && !this.config.logDir) {
      this.config.logDir = path__namespace.join(electron.app.getPath("userData"), "logs", "proxy");
    }
    if (this.config.enabled) {
      this.initLogFile();
    } else {
      this.close();
    }
  }
  initLogFile() {
    if (!this.config.logDir) return;
    try {
      fs__namespace.mkdirSync(this.config.logDir, { recursive: true });
      const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
      this.currentLogFile = path__namespace.join(this.config.logDir, `proxy-${timestamp}.log`);
      this.logStream = fs__namespace.createWriteStream(this.currentLogFile, { flags: "a" });
      this.currentFileSize = 0;
      this.info("Logger", "Log file initialized", { file: this.currentLogFile });
    } catch (error) {
      console.error("[ProxyLogger] Failed to init log file:", error);
    }
  }
  rotateIfNeeded() {
    if (!this.config.maxFileSize || this.currentFileSize < this.config.maxFileSize) {
      return;
    }
    this.close();
    this.cleanOldLogs();
    this.initLogFile();
  }
  cleanOldLogs() {
    if (!this.config.logDir || !this.config.maxFiles) return;
    try {
      const files = fs__namespace.readdirSync(this.config.logDir).filter((f) => f.startsWith("proxy-") && f.endsWith(".log")).map((f) => ({
        name: f,
        path: path__namespace.join(this.config.logDir, f),
        time: fs__namespace.statSync(path__namespace.join(this.config.logDir, f)).mtime.getTime()
      })).sort((a, b) => b.time - a.time);
      while (files.length >= this.config.maxFiles) {
        const oldest = files.pop();
        if (oldest) {
          fs__namespace.unlinkSync(oldest.path);
        }
      }
    } catch (error) {
      console.error("[ProxyLogger] Failed to clean old logs:", error);
    }
  }
  isWriting = false;
  write(rawEntry) {
    const entry = {
      ...rawEntry,
      message: redactString(rawEntry.message),
      data: rawEntry.data === void 0 ? void 0 : redactValue(rawEntry.data)
    };
    const line = JSON.stringify(entry) + "\n";
    if (this.config.logToConsole) {
      const prefix = `[${entry.level}][${entry.category}]`;
      this.isWriting = true;
      if (entry.level === "ERROR") {
        console.error(prefix, entry.message, entry.data || "");
      } else if (entry.level === "WARN") {
        console.warn(prefix, entry.message, entry.data || "");
      } else {
        console.log(prefix, entry.message, entry.data || "");
      }
      this.isWriting = false;
    }
    if (this.config.enabled && this.logStream) {
      this.logStream.write(line);
      this.currentFileSize += Buffer.byteLength(line);
      this.rotateIfNeeded();
    }
    proxyLogStore.add(entry);
  }
  get _isWriting() {
    return this.isWriting;
  }
  debug(category, message, data) {
    this.write({
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      level: "DEBUG",
      category,
      message,
      data
    });
  }
  info(category, message, data) {
    this.write({
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      level: "INFO",
      category,
      message,
      data
    });
  }
  warn(category, message, data) {
    this.write({
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      level: "WARN",
      category,
      message,
      data
    });
  }
  error(category, message, data) {
    this.write({
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      level: "ERROR",
      category,
      message,
      data
    });
  }
  // 记录请求
  request(info) {
    this.info("Request", `${info.method} ${info.path}`, info);
  }
  // 记录响应
  response(info) {
    if (info.error) {
      this.error("Response", `${info.path} -> ${info.status}`, info);
    } else {
      this.info("Response", `${info.path} -> ${info.status}`, info);
    }
  }
  // 记录 Token 刷新
  tokenRefresh(accountId, success, error) {
    if (success) {
      this.info("TokenRefresh", `Account ${accountId} refreshed successfully`);
    } else {
      this.error("TokenRefresh", `Account ${accountId} refresh failed`, { error });
    }
  }
  close() {
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }
  }
  getLogDir() {
    return this.config.logDir;
  }
}
class ProxyLogStore {
  logs = [];
  // 5 万条 × 平均 200 字节 ≈ 10 MB；既能覆盖常规调试需求，又把单次写盘成本控制在可接受范围内
  maxLogs = 5e4;
  listeners = [];
  storePath = "";
  initialized = false;
  initialize(userDataPath) {
    if (this.initialized) return;
    this.initialized = true;
    this.storePath = path__namespace.join(userDataPath, "proxy-logs.json");
    this.load();
  }
  load() {
    try {
      if (fs__namespace.existsSync(this.storePath)) {
        const data = fs__namespace.readFileSync(this.storePath, "utf-8");
        const parsed = JSON.parse(data);
        const filtered = Array.isArray(parsed) ? parsed.filter((log) => {
          if (!log.timestamp || isNaN(new Date(log.timestamp).getTime())) return false;
          if (!log.level || !log.category) return false;
          return true;
        }) : [];
        this.logs = filtered.length > this.maxLogs ? filtered.slice(-this.maxLogs) : filtered;
        console.log(`[ProxyLogStore] Loaded ${this.logs.length} valid logs`);
      }
    } catch (error) {
      console.error("[ProxyLogStore] Failed to load logs:", error);
      this.logs = [];
    }
  }
  /** 异步保存日志（不阻塞主进程事件循环）。并发调用通过 in-flight 标志合并。 */
  writeInFlight = false;
  writePending = false;
  async save() {
    if (this.writeInFlight) {
      this.writePending = true;
      return;
    }
    this.writeInFlight = true;
    try {
      const snapshot = this.logs;
      await fs__namespace.promises.writeFile(this.storePath, JSON.stringify(snapshot), "utf-8");
    } catch (error) {
      console.error("[ProxyLogStore] Failed to save logs:", error);
    } finally {
      this.writeInFlight = false;
      if (this.writePending) {
        this.writePending = false;
        queueMicrotask(() => {
          void this.save();
        });
      }
    }
  }
  saveTimer = null;
  add(entry) {
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
      }
    }
    this.scheduleSave();
  }
  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, 3e4);
  }
  /** 强制立即写盘（用于退出场景），保证最新数据落盘 */
  async flushSaveNow() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.save();
  }
  getAll() {
    return [...this.logs];
  }
  getLast(count) {
    return this.logs.slice(-count);
  }
  clear() {
    this.logs = [];
    void this.save();
  }
  count() {
    return this.logs.length;
  }
  onLog(listener) {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) {
        this.listeners.splice(index, 1);
      }
    };
  }
}
const proxyLogStore = new ProxyLogStore();
const proxyLogger = new ProxyLogger();
let consoleIntercepted = false;
function interceptConsole() {
  if (consoleIntercepted) return;
  consoleIntercepted = true;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const parseConsoleCategory = (args) => {
    const first = String(args[0] || "");
    const bracketMatch = first.match(/^\[(?:DEBUG|INFO|WARN|ERROR)\]?\[?([^\]]*)\]?\s*(.*)/);
    if (bracketMatch) {
      return { category: bracketMatch[1] || "App", message: bracketMatch[2] || "" };
    }
    const simpleMatch = first.match(/^\[([^\]]+)\]\s*(.*)/);
    if (simpleMatch) {
      return { category: simpleMatch[1], message: simpleMatch[2] || "" };
    }
    return { category: "App", message: first };
  };
  const buildEntry = (args, level) => {
    const { category, message } = parseConsoleCategory(args);
    const rest = args.slice(1);
    let data = void 0;
    if (rest.length === 1) {
      data = rest[0];
    } else if (rest.length > 1) {
      const allStrings = rest.every((r) => typeof r === "string");
      data = allStrings ? rest.join(" ") : rest;
    }
    return { timestamp: (/* @__PURE__ */ new Date()).toISOString(), level, category, message, data };
  };
  console.log = (...args) => {
    originalLog.apply(console, args);
    if (proxyLogger._isWriting) return;
    proxyLogStore.add(buildEntry(args, "INFO"));
  };
  console.warn = (...args) => {
    originalWarn.apply(console, args);
    if (proxyLogger._isWriting) return;
    proxyLogStore.add(buildEntry(args, "WARN"));
  };
  console.error = (...args) => {
    originalError.apply(console, args);
    if (proxyLogger._isWriting) return;
    proxyLogStore.add(buildEntry(args, "ERROR"));
  };
}
const logger = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  interceptConsole,
  proxyLogStore,
  proxyLogger
}, Symbol.toStringTag, { value: "Module" }));
let _cachedSystemProxy = null;
let _systemProxyCacheTime = 0;
const SYSTEM_PROXY_CACHE_TTL = 3e4;
const DEFAULT_PROXY_PORT = {
  "http:": 80,
  "https:": 443,
  "socks4:": 1080,
  "socks4a:": 1080,
  "socks5:": 1080,
  "socks5h:": 1080
};
function decodeProxyCredential(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
function redactProxyUrl(proxyUrl) {
  try {
    const parsed = new URL(proxyUrl);
    if (!parsed.username && !parsed.password) return proxyUrl;
    if (parsed.username) parsed.username = decodeProxyCredential(parsed.username);
    parsed.password = parsed.password ? "***" : "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "[invalid proxy URL]";
  }
}
function getElectronProxySettings(proxyUrl) {
  if (!proxyUrl) return void 0;
  try {
    const parsed = new URL(proxyUrl);
    const defaultPort = DEFAULT_PROXY_PORT[parsed.protocol];
    if (!defaultPort) return void 0;
    const port = Number(parsed.port) || defaultPort;
    const proxyRules = `${parsed.protocol}//${parsed.host}`;
    const username = decodeProxyCredential(parsed.username);
    const password = decodeProxyCredential(parsed.password);
    return {
      proxyRules,
      credentials: username ? {
        host: parsed.hostname,
        port,
        username,
        password
      } : void 0
    };
  } catch {
    return void 0;
  }
}
function isHttpLikeProxyUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
function parseWindowsProxyServer(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.includes("=")) {
    const map = /* @__PURE__ */ new Map();
    for (const seg of trimmed.split(";")) {
      const eq = seg.indexOf("=");
      if (eq > 0) {
        const k = seg.slice(0, eq).trim().toLowerCase();
        const v = seg.slice(eq + 1).trim();
        if (k && v) map.set(k, v);
      }
    }
    const https = map.get("https");
    if (https) return `http://${https}`;
    const http = map.get("http");
    if (http) return `http://${http}`;
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return isHttpLikeProxyUrl(trimmed) ? trimmed : null;
  }
  return `http://${trimmed}`;
}
function getSystemProxy() {
  const now = Date.now();
  if (_systemProxyCacheTime > 0 && now - _systemProxyCacheTime < SYSTEM_PROXY_CACHE_TTL) {
    return _cachedSystemProxy;
  }
  try {
    if (process.platform === "win32") {
      const { execSync } = require("child_process");
      const result = execSync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable',
        { encoding: "utf8", timeout: 3e3, windowsHide: true }
      );
      if (result.includes("0x1")) {
        const serverResult = execSync(
          'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
          { encoding: "utf8", timeout: 3e3, windowsHide: true }
        );
        const match = serverResult.match(/ProxyServer\s+REG_SZ\s+(.+)/);
        if (match) {
          const parsed = parseWindowsProxyServer(match[1]);
          _cachedSystemProxy = parsed;
          _systemProxyCacheTime = now;
          return _cachedSystemProxy;
        }
      }
    } else if (process.platform === "darwin") {
      const { execSync } = require("child_process");
      const result = execSync("scutil --proxy", { encoding: "utf8", timeout: 3e3 });
      const httpsEnabled = /HTTPSEnable\s*:\s*1/.test(result);
      if (httpsEnabled) {
        const hostMatch = result.match(/HTTPSProxy\s*:\s*(\S+)/);
        const portMatch = result.match(/HTTPSPort\s*:\s*(\d+)/);
        if (hostMatch) {
          const proxy = `http://${hostMatch[1]}${portMatch ? ":" + portMatch[1] : ""}`;
          _cachedSystemProxy = proxy;
          _systemProxyCacheTime = now;
          return _cachedSystemProxy;
        }
      }
      const httpEnabled = /HTTPEnable\s*:\s*1/.test(result);
      if (httpEnabled) {
        const hostMatch = result.match(/HTTPProxy\s*:\s*(\S+)/);
        const portMatch = result.match(/HTTPPort\s*:\s*(\d+)/);
        if (hostMatch) {
          const proxy = `http://${hostMatch[1]}${portMatch ? ":" + portMatch[1] : ""}`;
          _cachedSystemProxy = proxy;
          _systemProxyCacheTime = now;
          return _cachedSystemProxy;
        }
      }
    }
  } catch {
  }
  _cachedSystemProxy = null;
  _systemProxyCacheTime = now;
  return null;
}
function safeCreateProxyAgent(proxyUrl) {
  if (!proxyUrl) return void 0;
  let u;
  try {
    u = new URL(proxyUrl);
  } catch {
    console.warn(`[Proxy] 代理 URL 无效: ${redactProxyUrl(proxyUrl)}`);
    return void 0;
  }
  const protocol = u.protocol;
  if (protocol === "http:" || protocol === "https:") {
    try {
      return new undici.ProxyAgent({ uri: proxyUrl, requestTls: { rejectUnauthorized: false } });
    } catch (err) {
      console.warn(`[Proxy] 创建 HTTP ProxyAgent 失败，回退直连: ${redactProxyUrl(proxyUrl)}`, err);
      return void 0;
    }
  }
  if (protocol === "socks5:" || protocol === "socks5h:" || protocol === "socks4:" || protocol === "socks4a:") {
    try {
      return createSocksDispatcher(u);
    } catch (err) {
      console.warn(`[Proxy] 创建 SOCKS Agent 失败，回退直连: ${redactProxyUrl(proxyUrl)}`, err);
      return void 0;
    }
  }
  console.warn(
    `[Proxy] 忽略不支持的代理协议 (仅支持 http/https/socks5/socks4): ${redactProxyUrl(proxyUrl)}`
  );
  return void 0;
}
function createSocksDispatcher(u) {
  const isSocks5 = u.protocol === "socks5:" || u.protocol === "socks5h:";
  const type = isSocks5 ? 5 : 4;
  const proxyHost = u.hostname;
  const proxyPort = Number(u.port) || 1080;
  const userId = u.username ? decodeURIComponent(u.username) : void 0;
  const password = u.password ? decodeURIComponent(u.password) : void 0;
  return new undici.Agent({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    connect: ((options, callback) => {
      const targetHost = options.hostname || options.host || "";
      const targetPort = Number(options.port) || (options.protocol === "https:" ? 443 : 80);
      let SocksClient;
      try {
        SocksClient = require("socks").SocksClient;
      } catch (err) {
        callback(err, null);
        return;
      }
      void SocksClient.createConnection({
        proxy: { host: proxyHost, port: proxyPort, type, userId, password },
        command: "connect",
        destination: { host: targetHost, port: targetPort }
      }).then(({ socket }) => {
        if (options.protocol === "https:") {
          const tlsSocket = tls__namespace.connect({
            socket,
            servername: options.servername || targetHost,
            rejectUnauthorized: options.rejectUnauthorized ?? false
          });
          tlsSocket.once("secureConnect", () => callback(null, tlsSocket));
          tlsSocket.once("error", (err) => callback(err, null));
        } else {
          callback(null, socket);
        }
      }).catch((err) => callback(err, null));
    })
  });
}
let encoder = null;
let encoderInitFailed = false;
function getEncoder() {
  if (encoder) return encoder;
  if (encoderInitFailed) return null;
  try {
    encoder = jsTiktoken.getEncoding("cl100k_base");
    return encoder;
  } catch (err) {
    console.warn("[TokenCounter] Failed to load cl100k_base encoder:", err);
    encoderInitFailed = true;
    return null;
  }
}
function countTokens(text) {
  if (!text) return 0;
  const enc = getEncoder();
  if (enc) {
    try {
      return enc.encode(text).length;
    } catch (err) {
      console.warn("[TokenCounter] encode failed, using fallback:", err);
    }
  }
  return Math.ceil(Buffer.byteLength(text, "utf-8") / 3);
}
const modelContextWindowCache = /* @__PURE__ */ new Map();
function normalizeModelId(id) {
  return id.toLowerCase().replace(/[-._]/g, "").replace(/\d{8}/g, "").replace(/v\d+$/g, "").replace(/v\d+_\d+$/g, "");
}
function guessContextFromCache(modelId) {
  if (modelContextWindowCache.size === 0) return void 0;
  const queryNorm = normalizeModelId(modelId);
  if (!queryNorm) return void 0;
  for (const [id, ctx] of modelContextWindowCache) {
    if (normalizeModelId(id) === queryNorm) return ctx;
  }
  for (const [id, ctx] of modelContextWindowCache) {
    const idNorm = normalizeModelId(id);
    if (idNorm.includes(queryNorm) || queryNorm.includes(idNorm)) return ctx;
  }
  return void 0;
}
function getModelContextLength(modelId) {
  if (!modelId) return 2e5;
  const cached = modelContextWindowCache.get(modelId);
  if (cached && cached > 0) return cached;
  const guessed = guessContextFromCache(modelId);
  if (guessed && guessed > 0) return guessed;
  const id = modelId.toLowerCase();
  if (/^gpt-5[.-]6(?:[.-](?:sol|terra|luna))?$/.test(id)) return 272e3;
  if (/^claude-(?:sonnet|opus)-(?:4[.-](?:[6-9]|[1-9][0-9]+)|[5-9][0-9]*)(?:$|[.-])/.test(id))
    return 1e6;
  if (id.includes("claude-opus-4") || id.includes("claude-sonnet-4") || id.includes("claude-haiku-4"))
    return 2e5;
  if (id.includes("claude-3-7") || id.includes("claude-3.7")) return 2e5;
  if (id.includes("claude-3-5") || id.includes("claude-3.5")) return 2e5;
  if (id.includes("claude-3")) return 2e5;
  if (id.includes("claude-2.1")) return 2e5;
  if (id.includes("claude-2")) return 1e5;
  if (id.includes("claude-instant")) return 1e5;
  if (id.includes("gpt-4o") || id.includes("gpt-4-turbo")) return 128e3;
  if (id.includes("gpt-4.1")) return 1e6;
  if (id.includes("gpt-4-32k")) return 32768;
  if (id.includes("gpt-4")) return 8192;
  if (id.includes("gpt-3.5-turbo-16k")) return 16384;
  if (id.includes("gpt-3.5")) return 4096;
  if (id.includes("o1") || id.includes("o3")) return 128e3;
  if (id.includes("gemini-2.5") || id.includes("gemini-2.0") || id.includes("gemini-1.5"))
    return 1e6;
  if (id.includes("gemini")) return 32768;
  if (id.includes("nova-pro") || id.includes("nova-lite")) return 3e5;
  if (id.includes("nova-micro")) return 128e3;
  if (id.includes("titan")) return 8e3;
  return 2e5;
}
let logStreamEvents = false;
let payloadSizeLimitKB = 153600;
function getNetworkAgent$1(account) {
  if (account?.bypassAppProxy) {
    return void 0;
  }
  if (account?.proxyUrl) {
    const agent = safeCreateProxyAgent(account.proxyUrl);
    if (agent) {
      proxyLogger.debug("KiroAPI", `Using account-bound proxy for ${account.email || account.id}`);
      return agent;
    }
  }
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  const envAgent = safeCreateProxyAgent(envProxy);
  if (envAgent) return envAgent;
  return safeCreateProxyAgent(getSystemProxy());
}
async function fetchWithProxy(url, options, account) {
  const agent = getNetworkAgent$1(account);
  if (agent) {
    proxyLogger.debug("KiroAPI", `Using proxy agent: ${agent.constructor.name}`);
    return await undici.fetch(url, {
      ...options,
      dispatcher: agent
    });
  }
  return await fetch(url, options);
}
const KIRO_ENDPOINTS = [
  {
    url: "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse",
    origin: "AI_EDITOR",
    amzTarget: "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
    name: "CodeWhisperer",
    protocol: "generateAssistantResponse"
  },
  {
    url: "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
    origin: "AI_EDITOR",
    amzTarget: "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
    name: "AmazonQ",
    protocol: "generateAssistantResponse"
  },
  {
    url: "https://q.us-east-1.amazonaws.com/SendMessageStreaming",
    origin: "CLI",
    amzTarget: "AmazonQDeveloperStreamingService.SendMessage",
    name: "AmazonQCLI"
  }
];
const KIRO_ENDPOINT_NAME_BY_PREFERENCE = {
  codewhisperer: "CodeWhisperer",
  amazonq: "AmazonQ",
  "amazonq-cli": "AmazonQCLI"
};
const DEFAULT_ENDPOINT_FALLBACK_AFTER_FAILURES = 2;
const MIN_ENDPOINT_FALLBACK_AFTER_FAILURES = 1;
const MAX_ENDPOINT_FALLBACK_AFTER_FAILURES = 10;
const ENDPOINT_CIRCUIT_COOLDOWN_MS = 6e4;
const endpointCircuitStates = /* @__PURE__ */ new Map();
function endpointCircuitKey(account, endpoint) {
  return `${account.id || "anonymous"}:${endpoint.name}`;
}
function endpointFailureThreshold(account) {
  const configured = account.endpointFallbackAfterFailures ?? DEFAULT_ENDPOINT_FALLBACK_AFTER_FAILURES;
  return Math.min(
    MAX_ENDPOINT_FALLBACK_AFTER_FAILURES,
    Math.max(MIN_ENDPOINT_FALLBACK_AFTER_FAILURES, Math.floor(configured))
  );
}
function getCircuitEligibleEndpoints(account, endpoints) {
  const now = Date.now();
  const available = endpoints.filter((endpoint) => {
    const state = endpointCircuitStates.get(endpointCircuitKey(account, endpoint));
    return !state || state.openUntil <= now;
  });
  if (available.length > 0) return available;
  return endpoints.slice().sort((left, right) => {
    const leftUntil = endpointCircuitStates.get(endpointCircuitKey(account, left))?.openUntil ?? 0;
    const rightUntil = endpointCircuitStates.get(endpointCircuitKey(account, right))?.openUntil ?? 0;
    return leftUntil - rightUntil;
  }).slice(0, 1);
}
function recordEndpointSuccess(account, endpoint) {
  endpointCircuitStates.delete(endpointCircuitKey(account, endpoint));
}
function recordEndpointFailure(account, endpoint) {
  const key = endpointCircuitKey(account, endpoint);
  const previous = endpointCircuitStates.get(key);
  const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
  const threshold = endpointFailureThreshold(account);
  const openUntil = consecutiveFailures >= threshold ? Date.now() + ENDPOINT_CIRCUIT_COOLDOWN_MS : 0;
  endpointCircuitStates.set(key, { consecutiveFailures, openUntil });
  if (openUntil > 0) {
    proxyLogger.warn(
      "KiroAPI",
      `Endpoint circuit opened for ${account.email || account.id}: ${endpoint.name} (${consecutiveFailures} failures)`
    );
  }
}
const KIRO_VERSION$1 = "0.12.155";
const AWS_SDK_VERSION = "1.0.34";
const AWS_STREAMING_API_VERSION = "1.0.34";
const OS_PLATFORM = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "macos" : "linux";
const OS_RELEASE = (() => {
  try {
    return require("os").release();
  } catch {
    return "10.0.0";
  }
})();
const NODE_VERSION = process.versions.node || "22.22.0";
function getKiroUserAgent$1() {
  return `aws-sdk-js/${AWS_SDK_VERSION} ua/2.1 os/${OS_PLATFORM}#${OS_RELEASE} lang/js md/nodejs#${NODE_VERSION} api/codewhispererstreaming#${AWS_STREAMING_API_VERSION} m/E KiroIDE-${KIRO_VERSION$1}`;
}
function getKiroAmzUserAgent$1() {
  return `aws-sdk-js/${AWS_SDK_VERSION} KiroIDE-${KIRO_VERSION$1}`;
}
const KIRO_BUILDER_ID_PLACEHOLDER_ARN = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";
const KIRO_SOCIAL_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK";
const ENTERPRISE_FALLBACK_PROFILE_ID = "VNECVYCYYAWN";
const ENTERPRISE_FALLBACK_ACCOUNT_ID = "610548660232";
const PLACEHOLDER_PROFILE_ARNS = /* @__PURE__ */ new Set([KIRO_BUILDER_ID_PLACEHOLDER_ARN]);
function isPlaceholderProfileArn(arn) {
  return !!arn && PLACEHOLDER_PROFILE_ARNS.has(arn);
}
function getEnterpriseFallbackArn(region) {
  const selectedRegion = region?.startsWith("eu-") ? "eu-central-1" : "us-east-1";
  return `arn:aws:codewhisperer:${selectedRegion}:${ENTERPRISE_FALLBACK_ACCOUNT_ID}:profile/${ENTERPRISE_FALLBACK_PROFILE_ID}`;
}
function resolveProfileArn(account) {
  if (isKiroApiKeyAccount(account)) {
    const profileArn = account.profileArn?.trim();
    return profileArn && !isPlaceholderProfileArn(profileArn) ? profileArn : void 0;
  }
  if (account.profileArn && !isPlaceholderProfileArn(account.profileArn)) {
    return account.profileArn;
  }
  if (account.provider === "Enterprise" || account.authMethod === "external_idp") {
    return getEnterpriseFallbackArn(account.region);
  }
  if (account.authMethod === "social" || account.provider === "Github" || account.provider === "Google") {
    return KIRO_SOCIAL_PROFILE_ARN;
  }
  return KIRO_BUILDER_ID_PLACEHOLDER_ARN;
}
const CODEWHISPERER_DEFAULT_MODEL_ID = "CLAUDE_SONNET_4_20250514_V1_0";
const CODEWHISPERER_MODEL_CACHE_TTL = 5 * 60 * 1e3;
const codeWhispererModelCache = /* @__PURE__ */ new Map();
const MODEL_ID_MAP = {
  // Claude 4.5 系列
  "claude-sonnet-4-5": "claude-sonnet-4.5",
  "claude-sonnet-4.5": "claude-sonnet-4.5",
  "claude-haiku-4-5": "claude-haiku-4.5",
  "claude-haiku-4.5": "claude-haiku-4.5",
  "claude-opus-4-5": "claude-opus-4.5",
  "claude-opus-4.5": "claude-opus-4.5",
  // Claude 4 系列
  "claude-sonnet-4": "claude-sonnet-4",
  "claude-sonnet-4-20250514": "claude-sonnet-4",
  // Claude 3.5 系列 (映射到 Sonnet 4.5)
  "claude-3-5-sonnet": "claude-sonnet-4.5",
  "claude-3-opus": "claude-sonnet-4.5",
  "claude-3-sonnet": "claude-sonnet-4",
  "claude-3-haiku": "claude-haiku-4.5",
  // Kiro 已验证的 GPT-5.6 系列必须原样路由，不能静默降级到 Sonnet。
  "gpt-5.6": "gpt-5.6-sol",
  "gpt-5-6": "gpt-5.6-sol",
  "gpt-5.6-sol": "gpt-5.6-sol",
  "gpt-5-6-sol": "gpt-5.6-sol",
  "gpt-5.6-terra": "gpt-5.6-terra",
  "gpt-5-6-terra": "gpt-5.6-terra",
  "gpt-5.6-luna": "gpt-5.6-luna",
  "gpt-5-6-luna": "gpt-5.6-luna",
  // GPT 兼容映射 (映射到 Sonnet 4.5)
  "gpt-4": "claude-sonnet-4.5",
  "gpt-4o": "claude-sonnet-4.5",
  "gpt-4-turbo": "claude-sonnet-4.5",
  "gpt-3.5-turbo": "claude-sonnet-4.5",
  default: "claude-sonnet-4.5"
};
function normalizeClaudeVersion(modelId) {
  return modelId.replace(/^(claude-(?:sonnet|haiku|opus))-(\d+)-(\d{1,2})(?=$|[^\d])/i, "$1-$2.$3");
}
function mapModelId(model) {
  let modelId = model.trim();
  if (!modelId) return MODEL_ID_MAP.default;
  if (isCodeWhispererModelId(modelId)) return modelId;
  modelId = normalizeClaudeVersion(modelId);
  const lower = modelId.toLowerCase();
  if (MODEL_ID_MAP[lower]) return MODEL_ID_MAP[lower];
  if (/^claude-(sonnet|haiku|opus)-/.test(lower)) return modelId;
  if (lower.startsWith("gpt-")) return modelId;
  console.warn(`[Kiro API] Unknown model "${modelId}" → fallback to "${MODEL_ID_MAP.default}"`);
  return MODEL_ID_MAP.default;
}
function clonePayload(payload) {
  return JSON.parse(JSON.stringify(payload));
}
function normalizeModelKey(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
function modelTokens(value) {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
function matchesRequestedModel(model, requestedModelId) {
  const requestedKey = normalizeModelKey(requestedModelId);
  const modelIdKey = normalizeModelKey(model.modelId);
  if (modelIdKey === requestedKey || modelIdKey.includes(requestedKey)) return true;
  if (model.modelName && normalizeModelKey(model.modelName).includes(requestedKey)) return true;
  const tokens = modelTokens(requestedModelId).filter(
    (token) => token !== "latest" && token !== "model"
  );
  if (tokens.length === 0) return false;
  const candidateTokens = new Set(modelTokens(`${model.modelId} ${model.modelName || ""}`));
  if (!tokens.every((token) => candidateTokens.has(token))) return false;
  const families = ["opus", "sonnet", "haiku"];
  for (const family of families) {
    if (tokens.includes(family) && !candidateTokens.has(family)) return false;
    if (!tokens.includes(family) && candidateTokens.has(family)) return false;
  }
  return true;
}
function isCodeWhispererModelId(modelId) {
  return /^[A-Z0-9_]+$/.test(modelId) && modelId.includes("_");
}
function getModelCacheKey(account) {
  return `${account.id}:${account.region || "us-east-1"}:${resolveProfileArn(account) ?? "no-arn"}`;
}
async function getCachedCodeWhispererModels(account, signal) {
  const key = getModelCacheKey(account);
  const cached = codeWhispererModelCache.get(key);
  if (cached && Date.now() - cached.timestamp < CODEWHISPERER_MODEL_CACHE_TTL) return cached.models;
  const models = await fetchKiroModels(account, signal);
  codeWhispererModelCache.set(key, { models, timestamp: Date.now() });
  return models;
}
async function resolveCodeWhispererModelId(account, requestedModelId, signal) {
  const modelId = requestedModelId?.trim();
  if (!modelId) return CODEWHISPERER_DEFAULT_MODEL_ID;
  if (isCodeWhispererModelId(modelId)) return modelId;
  const models = await getCachedCodeWhispererModels(account, signal);
  const matched = models.find((model) => matchesRequestedModel(model, modelId));
  if (matched) return matched.modelId;
  if (modelId.toLowerCase().startsWith("gpt-")) {
    throw new Error(`Requested GPT model is not supported by CodeWhisperer: ${modelId}`);
  }
  return CODEWHISPERER_DEFAULT_MODEL_ID;
}
function getPayloadModelId(payload) {
  const currentModelId = payload.conversationState.currentMessage.userInputMessage.modelId;
  if (currentModelId) return currentModelId;
  return payload.conversationState.history?.find((message) => message.userInputMessage?.modelId)?.userInputMessage?.modelId;
}
function applyPayloadModelId(payload, modelId) {
  payload.conversationState.currentMessage.userInputMessage.modelId = modelId;
  for (const message of payload.conversationState.history ?? []) {
    if (message.userInputMessage) message.userInputMessage.modelId = modelId;
  }
}
function applyPayloadOrigin(payload, origin) {
  payload.conversationState.currentMessage.userInputMessage.origin = origin;
  for (const message of payload.conversationState.history ?? []) {
    if (message.userInputMessage) message.userInputMessage.origin = origin;
  }
}
const HELLO_MESSAGE = {
  userInputMessage: { content: "Hello", origin: "AI_EDITOR" }
};
const CONTINUE_MESSAGE = {
  userInputMessage: { content: "Continue", origin: "AI_EDITOR" }
};
const UNDERSTOOD_MESSAGE = {
  assistantResponseMessage: { content: "understood" }
};
function createFailedToolUseMessage(toolUseIds) {
  return {
    userInputMessage: {
      content: "",
      origin: "AI_EDITOR",
      userInputMessageContext: {
        toolResults: toolUseIds.map(createFailedToolResult)
      }
    }
  };
}
function isUserInputMessage(message) {
  return message != null && "userInputMessage" in message && message.userInputMessage != null;
}
function isAssistantResponseMessage(message) {
  return message != null && "assistantResponseMessage" in message && message.assistantResponseMessage != null;
}
function hasToolResults(message) {
  return !!message.userInputMessage?.userInputMessageContext?.toolResults?.length;
}
function hasToolUses(message) {
  return !!message.assistantResponseMessage?.toolUses?.length;
}
function hasMatchingToolResults(toolUses, toolResults) {
  if (!toolUses || !toolUses.length) return true;
  if (!toolResults || !toolResults.length) return false;
  const allToolUsesHaveResults = toolUses.every(
    (toolUse) => toolResults.some((result) => result.toolUseId === toolUse.toolUseId)
  );
  const allToolResultsHaveUses = toolResults.every(
    (result) => toolUses.some((toolUse) => result.toolUseId === toolUse.toolUseId)
  );
  return allToolUsesHaveResults && allToolResultsHaveUses;
}
function createFailedToolResult(toolUseId) {
  return {
    toolUseId,
    content: [{ text: "Tool execution failed" }],
    status: "error"
  };
}
function stripInvalidToolResults(message) {
  if (message.userInputMessage?.content?.trim()) {
    return {
      userInputMessage: {
        ...message.userInputMessage,
        userInputMessageContext: void 0
      }
    };
  }
  return null;
}
function ensureStartsWithUserMessage(messages) {
  if (messages.length === 0 || isUserInputMessage(messages[0])) {
    return messages;
  }
  return [HELLO_MESSAGE, ...messages];
}
function ensureEndsWithUserMessage(messages) {
  if (messages.length === 0) return [HELLO_MESSAGE];
  if (isUserInputMessage(messages[messages.length - 1])) return messages;
  return [...messages, CONTINUE_MESSAGE];
}
function ensureAlternatingMessages(messages) {
  if (messages.length <= 1) return messages;
  const result = [messages[0]];
  for (let i = 1; i < messages.length; i++) {
    const prevMessage = result[result.length - 1];
    const currentMessage = messages[i];
    if (isUserInputMessage(prevMessage) && isUserInputMessage(currentMessage)) {
      result.push(UNDERSTOOD_MESSAGE);
    } else if (isAssistantResponseMessage(prevMessage) && isAssistantResponseMessage(currentMessage)) {
      result.push(CONTINUE_MESSAGE);
    }
    result.push(currentMessage);
  }
  return result;
}
function relocateToolResultMessages(messages) {
  const assistantToolUseIndexes = [];
  const toolResultIndexById = /* @__PURE__ */ new Map();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (isAssistantResponseMessage(message) && hasToolUses(message)) {
      assistantToolUseIndexes.push(i);
    } else if (isUserInputMessage(message) && hasToolResults(message)) {
      for (const toolResult of message.userInputMessage?.userInputMessageContext?.toolResults ?? []) {
        if (toolResult.toolUseId && !toolResultIndexById.has(toolResult.toolUseId)) {
          toolResultIndexById.set(toolResult.toolUseId, i);
        }
      }
    }
  }
  if (assistantToolUseIndexes.length === 0) return messages;
  const result = [];
  const usedIndexes = /* @__PURE__ */ new Set();
  for (let i = 0; i < messages.length; i++) {
    if (usedIndexes.has(i)) continue;
    const message = messages[i];
    result.push(message);
    usedIndexes.add(i);
    if (isAssistantResponseMessage(message) && hasToolUses(message)) {
      for (const toolUse of message.assistantResponseMessage?.toolUses ?? []) {
        const toolResultIndex = toolResultIndexById.get(toolUse.toolUseId);
        if (toolResultIndex !== void 0 && toolResultIndex !== i + 1 && !usedIndexes.has(toolResultIndex)) {
          const toolResultMessage = messages[toolResultIndex];
          if (toolResultMessage) {
            result.push(toolResultMessage);
            usedIndexes.add(toolResultIndex);
          }
        }
      }
    }
  }
  return result;
}
function removeInvalidToolResultMessages(messages) {
  const result = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const previousMessage = i > 0 ? messages[i - 1] : null;
    if (!isUserInputMessage(message) || !hasToolResults(message)) {
      result.push(message);
      continue;
    }
    if (!previousMessage || !isAssistantResponseMessage(previousMessage) || !hasToolUses(previousMessage)) {
      const stripped = stripInvalidToolResults(message);
      if (stripped) result.push(stripped);
      continue;
    }
    const validToolUseIds = new Set(
      (previousMessage.assistantResponseMessage?.toolUses ?? []).map((toolUse) => toolUse.toolUseId).filter(Boolean)
    );
    const seenToolUseIds = /* @__PURE__ */ new Set();
    const toolResults = message.userInputMessage?.userInputMessageContext?.toolResults ?? [];
    const filteredToolResults = toolResults.filter((toolResult) => {
      if (!toolResult.toolUseId || !validToolUseIds.has(toolResult.toolUseId) || seenToolUseIds.has(toolResult.toolUseId))
        return false;
      seenToolUseIds.add(toolResult.toolUseId);
      return true;
    });
    if (filteredToolResults.length === toolResults.length) {
      result.push(message);
    } else if (filteredToolResults.length > 0) {
      result.push({
        userInputMessage: {
          ...message.userInputMessage,
          userInputMessageContext: {
            ...message.userInputMessage.userInputMessageContext,
            toolResults: filteredToolResults
          }
        }
      });
    } else {
      const stripped = stripInvalidToolResults(message);
      if (stripped) result.push(stripped);
    }
  }
  return result;
}
function ensureValidToolUsesAndResults(messages) {
  const result = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    result.push(message);
    if (isAssistantResponseMessage(message) && hasToolUses(message)) {
      const nextMessage = i + 1 < messages.length ? messages[i + 1] : null;
      const toolUses = message.assistantResponseMessage?.toolUses ?? [];
      const toolUseIds = toolUses.map((tu, idx) => tu.toolUseId ?? `toolUse_${idx + 1}`);
      if (!nextMessage || !isUserInputMessage(nextMessage) || !hasToolResults(nextMessage)) {
        result.push(createFailedToolUseMessage(toolUseIds));
      } else if (!hasMatchingToolResults(
        message.assistantResponseMessage?.toolUses,
        nextMessage.userInputMessage?.userInputMessageContext?.toolResults
      ) && !messages.some(
        (candidate, index) => index !== i && isAssistantResponseMessage(candidate) && hasToolUses(candidate) && hasMatchingToolResults(
          candidate.assistantResponseMessage?.toolUses,
          nextMessage.userInputMessage?.userInputMessageContext?.toolResults
        )
      )) {
        const existingToolResults = nextMessage.userInputMessage?.userInputMessageContext?.toolResults ?? [];
        const validToolUseIds = new Set(toolUseIds);
        const usedToolUseIds = /* @__PURE__ */ new Set();
        const completedToolResults = existingToolResults.filter((toolResult) => {
          if (!toolResult.toolUseId || !validToolUseIds.has(toolResult.toolUseId) || usedToolUseIds.has(toolResult.toolUseId))
            return false;
          usedToolUseIds.add(toolResult.toolUseId);
          return true;
        });
        for (const toolUseId of toolUseIds) {
          if (!usedToolUseIds.has(toolUseId))
            completedToolResults.push(createFailedToolResult(toolUseId));
        }
        result.push({
          userInputMessage: {
            ...nextMessage.userInputMessage,
            userInputMessageContext: {
              ...nextMessage.userInputMessage.userInputMessageContext,
              toolResults: completedToolResults
            }
          }
        });
        i++;
      }
    }
  }
  return result;
}
function removeEmptyUserMessages(messages) {
  if (messages.length <= 1) return messages;
  const firstUserMessageIndex = messages.findIndex(isUserInputMessage);
  return messages.filter((message, index) => {
    if (isAssistantResponseMessage(message)) return true;
    if (isUserInputMessage(message) && index === firstUserMessageIndex) return true;
    if (isUserInputMessage(message)) {
      const hasContent = message.userInputMessage?.content?.trim() !== "";
      return hasContent || hasToolResults(message);
    }
    return true;
  });
}
function validateConversation(messages) {
  const errors = [];
  if (messages.length === 0 || !isUserInputMessage(messages[0])) {
    errors.push("STARTS_WITH_USER_MESSAGE:index=0");
  }
  if (messages.length === 0 || !isUserInputMessage(messages[messages.length - 1])) {
    errors.push(`ENDS_WITH_USER_MESSAGE:index=${Math.max(messages.length - 1, 0)}`);
  }
  for (let i = 1; i < messages.length; i++) {
    const previousMessage = messages[i - 1];
    const currentMessage = messages[i];
    if (isUserInputMessage(previousMessage) && isUserInputMessage(currentMessage)) {
      errors.push(`ALTERNATING_MESSAGES:index=${i}`);
      break;
    }
    if (isAssistantResponseMessage(previousMessage) && isAssistantResponseMessage(currentMessage)) {
      errors.push(`ALTERNATING_MESSAGES:index=${i}`);
      break;
    }
  }
  for (let i = 0; i < messages.length - 1; i++) {
    const message = messages[i];
    const nextMessage = messages[i + 1];
    if (isAssistantResponseMessage(message) && hasToolUses(message) && (!isUserInputMessage(nextMessage) || !hasMatchingToolResults(
      message.assistantResponseMessage?.toolUses,
      nextMessage?.userInputMessage?.userInputMessageContext?.toolResults
    ))) {
      errors.push(`TOOL_USES_AND_RESULTS:index=${i + 1}`);
      break;
    }
    if (isAssistantResponseMessage(message) && !hasToolUses(message) && isUserInputMessage(nextMessage) && hasToolResults(nextMessage)) {
      errors.push(`TOOL_RESULTS_AND_NO_USES:index=${i}`);
      break;
    }
  }
  for (let i = 1; i < messages.length; i++) {
    const previousMessage = messages[i - 1];
    const currentMessage = messages[i];
    if (!isAssistantResponseMessage(previousMessage) || !hasToolUses(previousMessage) || !isUserInputMessage(currentMessage) || !hasToolResults(currentMessage))
      continue;
    const toolUseIds = new Set(
      (previousMessage.assistantResponseMessage?.toolUses ?? []).map((toolUse) => toolUse.toolUseId).filter(Boolean)
    );
    const seenToolUseIds = /* @__PURE__ */ new Set();
    const hasInvalidToolResult = (currentMessage.userInputMessage?.userInputMessageContext?.toolResults ?? []).some((toolResult) => {
      if (!toolResult.toolUseId || !toolUseIds.has(toolResult.toolUseId) || seenToolUseIds.has(toolResult.toolUseId))
        return true;
      seenToolUseIds.add(toolResult.toolUseId);
      return false;
    });
    if (hasInvalidToolResult) {
      errors.push(`TOOL_RESULTS_ORPHAN_IDS:index=${i}`);
      break;
    }
  }
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (isUserInputMessage(message) && !message.userInputMessage?.content?.trim() && !hasToolResults(message)) {
      errors.push(`NON_EMPTY_USER_MESSAGE:index=${i}`);
      break;
    }
  }
  return errors;
}
function getToolNames(tools) {
  return new Set(
    tools.flatMap((tool) => "toolSpecification" in tool ? [tool.toolSpecification.name] : [])
  );
}
function stringifyToolInput(input) {
  if (input === void 0) return "";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}
function flattenContent(content, extra) {
  const trimmedContent = content.trim();
  if (!trimmedContent) return extra;
  if (!extra) return trimmedContent;
  return `${trimmedContent}

${extra}`;
}
function formatToolUses(toolUses) {
  return toolUses.map(
    (toolUse) => [
      `<tool_use id="${toolUse.toolUseId}" name="${toolUse.name}">`,
      stringifyToolInput(toolUse.input),
      "</tool_use>"
    ].filter(Boolean).join("\n")
  ).join("\n\n");
}
function formatToolResults(toolResults) {
  return toolResults.map(
    (toolResult) => [
      `<tool_result id="${toolResult.toolUseId}" status="${toolResult.status}">`,
      toolResult.content.map((content) => content.text).join("\n"),
      "</tool_result>"
    ].filter(Boolean).join("\n")
  ).join("\n\n");
}
function normalizeToolHistory(messages, tools) {
  const toolNames = getToolNames(tools);
  const hasUnknownToolUse = messages.some(
    (message) => message.assistantResponseMessage?.toolUses?.some((toolUse) => !toolNames.has(toolUse.name)) ?? false
  );
  if (!hasUnknownToolUse) return messages;
  return messages.map((message) => {
    if (message.assistantResponseMessage?.toolUses?.length) {
      return {
        assistantResponseMessage: {
          ...message.assistantResponseMessage,
          content: flattenContent(
            message.assistantResponseMessage.content,
            formatToolUses(message.assistantResponseMessage.toolUses)
          ),
          toolUses: void 0
        }
      };
    }
    if (message.userInputMessage?.userInputMessageContext?.toolResults?.length) {
      return {
        userInputMessage: {
          ...message.userInputMessage,
          content: flattenContent(
            message.userInputMessage.content,
            formatToolResults(message.userInputMessage.userInputMessageContext.toolResults)
          ),
          userInputMessageContext: {
            ...message.userInputMessage.userInputMessageContext,
            toolResults: void 0
          }
        }
      };
    }
    return message;
  });
}
function sanitizeConversation(messages) {
  let sanitized = [...messages];
  sanitized = ensureStartsWithUserMessage(sanitized);
  sanitized = removeEmptyUserMessages(sanitized);
  sanitized = relocateToolResultMessages(sanitized);
  sanitized = removeInvalidToolResultMessages(sanitized);
  sanitized = ensureValidToolUsesAndResults(sanitized);
  sanitized = ensureAlternatingMessages(sanitized);
  sanitized = ensureEndsWithUserMessage(sanitized);
  const validationErrors = validateConversation(sanitized);
  if (validationErrors.length > 0) {
    throw new Error(`Invalid Kiro conversation after sanitization: ${validationErrors.join(", ")}`);
  }
  return sanitized;
}
function buildKiroPayload(content, modelId, origin, history = [], tools = [], toolResults = [], images = [], profileArn, inferenceConfig, messageOptions, additionalModelRequestFields) {
  const finalContent = content.trim() || (toolResults.length > 0 ? "" : "Continue");
  const currentUserInputMessage = {
    content: finalContent,
    modelId,
    origin
  };
  if (images.length > 0) {
    currentUserInputMessage.images = images;
  }
  if (messageOptions?.documents?.length) {
    currentUserInputMessage.documents = messageOptions.documents;
  }
  if (messageOptions?.cachePoint) {
    currentUserInputMessage.cachePoint = messageOptions.cachePoint;
  }
  if (messageOptions?.clientCacheConfig !== void 0) {
    currentUserInputMessage.clientCacheConfig = messageOptions.clientCacheConfig;
  }
  if (tools.length > 0 || toolResults.length > 0) {
    currentUserInputMessage.userInputMessageContext = {};
    if (tools.length > 0) {
      currentUserInputMessage.userInputMessageContext.tools = tools;
    }
    if (toolResults.length > 0) {
      currentUserInputMessage.userInputMessageContext.toolResults = toolResults;
    }
  }
  if (messageOptions?.context) {
    currentUserInputMessage.userInputMessageContext = {
      ...currentUserInputMessage.userInputMessageContext,
      ...messageOptions.context.editorState !== void 0 ? { editorState: messageOptions.context.editorState } : {},
      ...messageOptions.context.shellState !== void 0 ? { shellState: messageOptions.context.shellState } : {},
      ...messageOptions.context.gitState !== void 0 ? { gitState: messageOptions.context.gitState } : {},
      ...messageOptions.context.envState !== void 0 ? { envState: messageOptions.context.envState } : {},
      ...messageOptions.context.additionalContext !== void 0 ? { additionalContext: messageOptions.context.additionalContext } : {}
    };
  }
  const currentMessage = {
    userInputMessage: currentUserInputMessage
  };
  const allMessages = [...history, currentMessage];
  const sanitizedMessages = sanitizeConversation(normalizeToolHistory(allMessages, tools));
  const sanitizedHistory = sanitizedMessages.slice(0, -1);
  let finalCurrentMessage = sanitizedMessages.at(-1);
  if (!finalCurrentMessage.userInputMessage) {
    finalCurrentMessage = {
      userInputMessage: {
        content: finalContent || "Continue",
        modelId,
        origin
      }
    };
  }
  finalCurrentMessage.userInputMessage.userInputMessageContext = {
    ...finalCurrentMessage.userInputMessage.userInputMessageContext,
    ...tools.length > 0 ? { tools } : {}
  };
  const conversationId = resolveConversationId(history, messageOptions?.conversationId);
  const payload = {
    conversationState: {
      agentContinuationId: uuid.v4(),
      agentTaskType: "vibe",
      chatTriggerType: "MANUAL",
      conversationId,
      currentMessage: {
        userInputMessage: finalCurrentMessage.userInputMessage
      },
      history: sanitizedHistory.length > 0 ? sanitizedHistory : void 0
    }
  };
  if (profileArn !== void 0) {
    payload.profileArn = profileArn;
  }
  if (inferenceConfig && (inferenceConfig.maxTokens || inferenceConfig.temperature !== void 0 || inferenceConfig.topP !== void 0)) {
    payload.inferenceConfig = {};
    if (inferenceConfig.maxTokens) {
      payload.inferenceConfig.maxTokens = inferenceConfig.maxTokens;
    }
    if (inferenceConfig.temperature !== void 0) {
      payload.inferenceConfig.temperature = inferenceConfig.temperature;
    }
    if (inferenceConfig.topP !== void 0) {
      payload.inferenceConfig.topP = inferenceConfig.topP;
    }
  }
  if (additionalModelRequestFields && Object.keys(additionalModelRequestFields).length > 0) {
    payload.additionalModelRequestFields = additionalModelRequestFields;
  }
  const PAYLOAD_SIZE_LIMIT = payloadSizeLimitKB * 1024;
  const TOOL_RESULT_TRUNCATE_LENGTH = 4e3;
  let initialPayloadSize = JSON.stringify(payload).length;
  if (initialPayloadSize > PAYLOAD_SIZE_LIMIT && payload.conversationState.history) {
    const historyMessages = payload.conversationState.history;
    let truncatedCount = 0;
    for (const message of historyMessages) {
      if (initialPayloadSize <= PAYLOAD_SIZE_LIMIT) break;
      const userToolResults = message.userInputMessage?.userInputMessageContext?.toolResults;
      if (!userToolResults) continue;
      for (const toolResult of userToolResults) {
        if (initialPayloadSize <= PAYLOAD_SIZE_LIMIT) break;
        if (!toolResult.content) continue;
        for (const contentItem of toolResult.content) {
          if (initialPayloadSize <= PAYLOAD_SIZE_LIMIT) break;
          if (contentItem.text && contentItem.text.length > TOOL_RESULT_TRUNCATE_LENGTH) {
            const originalLen = contentItem.text.length;
            contentItem.text = `${contentItem.text.slice(0, TOOL_RESULT_TRUNCATE_LENGTH)}

[Truncated by proxy: original ${originalLen} chars]`;
            truncatedCount++;
            initialPayloadSize = JSON.stringify(payload).length;
          }
        }
      }
    }
    if (truncatedCount > 0) {
      console.log(
        `[KiroPayload] Truncated ${truncatedCount} large tool results to fit payload size limit (final size: ${initialPayloadSize} bytes)`
      );
    }
  }
  console.log(`[KiroPayload] Built payload (native history mode):`, {
    contentLength: finalContent.length,
    originalHistoryLength: history.length,
    sanitizedHistoryLength: sanitizedHistory.length,
    toolsCount: tools.length,
    toolResultsCount: toolResults.length,
    hasProfileArn: payload.profileArn !== void 0,
    hasThinking: !!additionalModelRequestFields?.thinking,
    payloadSize: initialPayloadSize
  });
  return payload;
}
const conversationCache = /* @__PURE__ */ new Map();
const CONVERSATION_CACHE_TTL = 2 * 60 * 60 * 1e3;
const CONVERSATION_CACHE_MAX = 1e3;
function resolveConversationId(history, sessionHint) {
  const key = sessionHint || fingerprintFromHistory(history);
  if (!key) return uuid.v4();
  const now = Date.now();
  const cached = conversationCache.get(key);
  if (cached) {
    cached.timestamp = now;
    return cached.id;
  }
  if (conversationCache.size > CONVERSATION_CACHE_MAX) {
    const cutoff = now - CONVERSATION_CACHE_TTL;
    for (const [k, v] of conversationCache) {
      if (v.timestamp < cutoff) conversationCache.delete(k);
    }
  }
  const id = uuid.v4();
  conversationCache.set(key, { id, timestamp: now });
  return id;
}
function fingerprintFromHistory(history) {
  if (history.length === 0) return void 0;
  const fp = history.slice(0, 2).map(
    (msg) => `${msg.userInputMessage?.content || ""}|${msg.assistantResponseMessage?.content || ""}`
  ).join("::");
  const crypto2 = require("crypto");
  return crypto2.createHash("sha256").update(fp).digest("hex").slice(0, 32);
}
const KIRO_API_KEY_TOKEN_TYPE = "API_KEY";
function isKiroApiKeyAccount(account) {
  return account.credentialKind === "kiro_api_key";
}
function getKiroAuthenticationHeaders(account) {
  const credential = isKiroApiKeyAccount(account) ? account.kiroApiKey : account.accessToken;
  if (!credential) {
    throw new Error("Missing upstream Kiro credentials");
  }
  const headers = {
    Authorization: `Bearer ${credential}`
  };
  if (isKiroApiKeyAccount(account)) {
    headers.tokentype = KIRO_API_KEY_TOKEN_TYPE;
  } else if (account.authMethod === "external_idp" || account.provider === "ExternalIdp") {
    headers.TokenType = "EXTERNAL_IDP";
  }
  return headers;
}
function getAuthHeaders(account, _endpoint) {
  return {
    "content-type": "application/json",
    "x-amzn-kiro-agent-mode": "vibe",
    "x-amz-user-agent": getKiroAmzUserAgent$1(),
    "user-agent": getKiroUserAgent$1(),
    "amz-sdk-invocation-id": uuid.v4(),
    "amz-sdk-request": "attempt=1; max=3",
    ...getKiroAuthenticationHeaders(account)
  };
}
function getSortedEndpoints(preferredEndpoint, fallbackOrder) {
  if (!preferredEndpoint && !fallbackOrder?.length)
    return KIRO_ENDPOINTS.filter((ep) => ep.name !== "AmazonQCLI");
  if (preferredEndpoint === "amazonq-cli" && !fallbackOrder?.length) {
    return KIRO_ENDPOINTS.filter((ep) => ep.name === "AmazonQCLI");
  }
  const configuredOrder = [preferredEndpoint, ...fallbackOrder ?? []].filter(
    (value) => Boolean(value)
  );
  const orderedNames = Array.from(
    new Set(configuredOrder.map((value) => KIRO_ENDPOINT_NAME_BY_PREFERENCE[value]))
  );
  const explicitlyIncludesCli = orderedNames.includes("AmazonQCLI");
  const ordered = orderedNames.map((name) => KIRO_ENDPOINTS.find((endpoint) => endpoint.name === name)).filter((endpoint) => Boolean(endpoint));
  const remaining = KIRO_ENDPOINTS.filter(
    (endpoint) => !orderedNames.includes(endpoint.name) && (endpoint.name !== "AmazonQCLI" || explicitlyIncludesCli)
  );
  return [...ordered, ...remaining];
}
function getRegionalEndpointUrl(endpoint, region) {
  const baseUrl = endpoint.name === "CodeWhisperer" ? getCodeWhispererEndpoint(region) : getQServiceEndpoint(region);
  return `${baseUrl}${new URL(endpoint.url).pathname}`;
}
function getAbortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  if (signal?.reason) return new Error(String(signal.reason));
  return new Error("Request aborted");
}
function throwIfAborted(signal) {
  if (signal?.aborted) throw getAbortError(signal);
}
const UPSTREAM_ERROR_REASON = {
  MONTHLY_REQUEST_COUNT: "MONTHLY_REQUEST_COUNT"
};
var UpstreamRetryCategory = /* @__PURE__ */ ((UpstreamRetryCategory2) => {
  UpstreamRetryCategory2["AUTHENTICATION"] = "authentication";
  UpstreamRetryCategory2["MONTHLY_QUOTA"] = "monthly_quota";
  UpstreamRetryCategory2["RATE_LIMIT"] = "rate_limit";
  UpstreamRetryCategory2["TRANSIENT"] = "transient";
  UpstreamRetryCategory2["NONE"] = "none";
  return UpstreamRetryCategory2;
})(UpstreamRetryCategory || {});
function getRetryCategory({
  statusCode,
  reason,
  code
}) {
  if (statusCode === 401 || statusCode === 403) return "authentication";
  if (statusCode === 402 && (reason === UPSTREAM_ERROR_REASON.MONTHLY_REQUEST_COUNT || code === UPSTREAM_ERROR_REASON.MONTHLY_REQUEST_COUNT)) {
    return "monthly_quota";
  }
  if (statusCode === 429) return "rate_limit";
  if (statusCode === 408 || statusCode !== void 0 && statusCode >= 500)
    return "transient";
  return "none";
}
class KiroUpstreamError extends Error {
  statusCode;
  reason;
  code;
  retryAfterMs;
  retryCategory;
  constructor(details = {}) {
    const baseMessage = details.statusCode === 401 || details.statusCode === 403 ? `Auth error ${details.statusCode}` : details.statusCode ? `Upstream Kiro API request failed (HTTP ${details.statusCode})` : "Upstream Kiro API request failed";
    const detailParts = [details.code, details.reason].filter(
      (value, index, values) => Boolean(value) && values.indexOf(value) === index
    );
    super(detailParts.length > 0 ? `${baseMessage}: ${detailParts.join(" · ")}` : baseMessage);
    this.name = "KiroUpstreamError";
    this.statusCode = details.statusCode;
    this.reason = details.reason;
    this.code = details.code;
    this.retryAfterMs = details.retryAfterMs;
    this.retryCategory = getRetryCategory(details);
  }
}
function extractUpstreamErrorDetails(statusCode, body, retryAfterMs) {
  let reason;
  let code;
  try {
    const payload = JSON.parse(body);
    const source = typeof payload.error === "object" && payload.error !== null ? payload.error : payload;
    reason = typeof source.reason === "string" ? source.reason : void 0;
    code = typeof source.code === "string" ? source.code : void 0;
  } catch {
  }
  return { statusCode, reason, code, retryAfterMs };
}
function getRetryAfterMs(value) {
  if (!value) return void 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1e3);
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : void 0;
}
const STREAM_RATE_LIMIT_RETRY_BASE_MS = 200;
const STREAM_RATE_LIMIT_RETRY_MAX_MS = 2e3;
const STREAM_RATE_LIMIT_MAX_RETRIES = 2;
async function waitForStreamRateLimitRetry(ms, signal) {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timeout);
      reject(getAbortError(signal));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
function normalizeKiroUpstreamError(error) {
  if (error instanceof KiroUpstreamError) return error;
  const message = error instanceof Error ? error.message : "";
  const statusCode = /\b([1-5]\d{2})\b/.exec(message)?.[1];
  const reason = message.includes(UPSTREAM_ERROR_REASON.MONTHLY_REQUEST_COUNT) ? UPSTREAM_ERROR_REASON.MONTHLY_REQUEST_COUNT : void 0;
  return new KiroUpstreamError({
    statusCode: statusCode ? Number(statusCode) : void 0,
    reason,
    code: reason
  });
}
async function callKiroApiStream(account, payload, onChunk, onComplete, onError, signal, preferredEndpoint, onContextUsage, rateLimitAttempt = 0) {
  const isEnterprise = account.provider === "Enterprise" || account.authMethod === "external_idp";
  const effectivePreferredEndpoint = account.preferredEndpoint ?? preferredEndpoint;
  const endpoints = getCircuitEligibleEndpoints(
    account,
    getSortedEndpoints(effectivePreferredEndpoint, account.endpointFallbackOrder)
  );
  if (!isKiroApiKeyAccount(account) && !account.profileArn && isEnterprise) {
    const fetchedArn = await fetchEnterpriseProfileArn(account);
    if (fetchedArn) {
      account.profileArn = fetchedArn;
      if (account.id) ;
    }
  }
  let lastError = null;
  let errorDelivered = false;
  const reportError = async (error) => {
    if (errorDelivered) return;
    errorDelivered = true;
    try {
      await onError(error);
    } catch (callbackError) {
      proxyLogger.warn("KiroAPI", "Stream error callback failed", callbackError);
    }
  };
  for (const endpoint of endpoints) {
    try {
      throwIfAborted(signal);
      const requestPayload = clonePayload(payload);
      const resolvedArn = resolveProfileArn(account);
      if (resolvedArn && !isPlaceholderProfileArn(resolvedArn)) {
        requestPayload.profileArn = resolvedArn;
      } else {
        delete requestPayload.profileArn;
      }
      const requestedModelId = getPayloadModelId(requestPayload);
      if (endpoint.name === "CodeWhisperer") {
        applyPayloadModelId(
          requestPayload,
          await resolveCodeWhispererModelId(account, requestedModelId, signal)
        );
      }
      applyPayloadOrigin(requestPayload, endpoint.origin);
      if (endpoint.name === "AmazonQCLI") {
        delete requestPayload.conversationState.agentContinuationId;
        delete requestPayload.conversationState.agentTaskType;
      }
      const payloadStr = JSON.stringify(requestPayload);
      const headers = getAuthHeaders(account, endpoint);
      const endpointUrl = getRegionalEndpointUrl(endpoint, account.region);
      const currentUserInput = requestPayload.conversationState.currentMessage.userInputMessage;
      const historyMessages = requestPayload.conversationState.history ?? [];
      const historyToolUseCount = historyMessages.reduce(
        (count, message) => count + (message.assistantResponseMessage?.toolUses?.length ?? 0),
        0
      );
      const historyToolResultCount = historyMessages.reduce(
        (count, message) => count + (message.userInputMessage?.userInputMessageContext?.toolResults?.length ?? 0),
        0
      );
      console.log(`[KiroAPI] Request to ${endpoint.name}:`);
      console.log(`[KiroAPI]   - Content length: ${currentUserInput?.content?.length || 0}`);
      console.log(
        `[KiroAPI]   - Tools count: ${currentUserInput?.userInputMessageContext?.tools?.length || 0}`
      );
      console.log(
        `[KiroAPI]   - Current tool results: ${currentUserInput?.userInputMessageContext?.toolResults?.length || 0}`
      );
      console.log(`[KiroAPI]   - History messages: ${historyMessages.length}`);
      console.log(
        `[KiroAPI]   - History tool uses/results: ${historyToolUseCount}/${historyToolResultCount}`
      );
      console.log(`[KiroAPI]   - Model ID: ${currentUserInput?.modelId || "default"}`);
      console.log(`[KiroAPI]   - Has profileArn: ${requestPayload.profileArn !== void 0}`);
      console.log(`[KiroAPI]   - Agent mode: ${headers["x-amzn-kiro-agent-mode"]}`);
      console.log(`[KiroAPI]   - Payload size: ${payloadStr.length} bytes`);
      const agent = getNetworkAgent$1(account);
      if (agent) proxyLogger.debug("KiroAPI", `Stream request via proxy to ${endpoint.name}`);
      const response = agent ? await undici.fetch(endpointUrl, {
        method: "POST",
        headers,
        body: payloadStr,
        signal,
        dispatcher: agent
      }) : await fetch(endpointUrl, { method: "POST", headers, body: payloadStr, signal });
      if (response.status === 429) {
        const retryAfterMs = getRetryAfterMs(response.headers.get("retry-after"));
        const error = new KiroUpstreamError({ statusCode: 429, retryAfterMs });
        if (rateLimitAttempt < STREAM_RATE_LIMIT_MAX_RETRIES) {
          const backoff = Math.min(
            STREAM_RATE_LIMIT_RETRY_BASE_MS * 2 ** rateLimitAttempt,
            STREAM_RATE_LIMIT_RETRY_MAX_MS
          );
          await waitForStreamRateLimitRetry(
            Math.min(retryAfterMs ?? backoff, STREAM_RATE_LIMIT_RETRY_MAX_MS),
            signal
          );
          return callKiroApiStream(
            account,
            payload,
            onChunk,
            onComplete,
            onError,
            signal,
            preferredEndpoint,
            onContextUsage,
            rateLimitAttempt + 1
          );
        }
        throw error;
      }
      if (response.status === 401 || response.status === 403 || !response.ok) {
        throwIfAborted(signal);
        const body = await response.text();
        throwIfAborted(signal);
        throw new KiroUpstreamError(
          extractUpstreamErrorDetails(
            response.status,
            body,
            getRetryAfterMs(response.headers.get("retry-after"))
          )
        );
      }
      const inputChars = payloadStr.length;
      await parseEventStream(
        response.body,
        onChunk,
        onComplete,
        onError,
        onContextUsage,
        inputChars,
        signal,
        requestedModelId,
        payloadStr
      );
      recordEndpointSuccess(account, endpoint);
      return;
    } catch (error) {
      if (signal?.aborted) {
        await reportError(getAbortError(signal));
        return;
      }
      lastError = error;
      console.error(`[KiroAPI] Endpoint ${endpoint.name} failed:`, error);
      const upstreamError = normalizeKiroUpstreamError(error);
      const endpointScopedFailure = upstreamError.retryCategory === "transient" || upstreamError.retryCategory === "rate_limit";
      if (endpointScopedFailure && (error instanceof KiroUpstreamError || error instanceof TypeError)) {
        recordEndpointFailure(account, endpoint);
      }
      if (upstreamError.retryCategory === "authentication" || error instanceof KiroUpstreamError && (upstreamError.statusCode === 402 || upstreamError.retryCategory === "none")) {
        await reportError(upstreamError);
        return;
      }
      const errMsg = error.message || "";
      if (errMsg.includes("THINKING_SIGNATURE_INVALID")) {
        console.log(
          `[KiroAPI] THINKING_SIGNATURE_INVALID on ${endpoint.name}, retrying with reasoningContent stripped`
        );
        try {
          throwIfAborted(signal);
          const retryPayload = clonePayload(payload);
          if (retryPayload.conversationState.history) {
            for (const msg of retryPayload.conversationState.history) {
              if (msg.assistantResponseMessage?.reasoningContent !== void 0) {
                delete msg.assistantResponseMessage.reasoningContent;
              }
            }
          }
          const resolvedArn2 = resolveProfileArn(account);
          if (resolvedArn2 && !isPlaceholderProfileArn(resolvedArn2)) {
            retryPayload.profileArn = resolvedArn2;
          } else {
            delete retryPayload.profileArn;
          }
          if (endpoint.name === "CodeWhisperer") {
            applyPayloadModelId(
              retryPayload,
              await resolveCodeWhispererModelId(account, getPayloadModelId(retryPayload), signal)
            );
          }
          applyPayloadOrigin(retryPayload, endpoint.origin);
          const retryStr = JSON.stringify(retryPayload);
          const retryHeaders = getAuthHeaders(account, endpoint);
          const retryEndpointUrl = getRegionalEndpointUrl(endpoint, account.region);
          const retryAgent = getNetworkAgent$1(account);
          const retryResponse = retryAgent ? await undici.fetch(retryEndpointUrl, {
            method: "POST",
            headers: retryHeaders,
            body: retryStr,
            signal,
            dispatcher: retryAgent
          }) : await fetch(retryEndpointUrl, {
            method: "POST",
            headers: retryHeaders,
            body: retryStr,
            signal
          });
          if (retryResponse.ok) {
            await parseEventStream(
              retryResponse.body,
              onChunk,
              onComplete,
              onError,
              onContextUsage,
              retryStr.length,
              signal,
              getPayloadModelId(retryPayload),
              retryStr
            );
            recordEndpointSuccess(account, endpoint);
            return;
          }
          await retryResponse.text();
          console.error(
            `[KiroAPI] THINKING_SIGNATURE_INVALID retry also failed: HTTP ${retryResponse.status}`
          );
        } catch (retryErr) {
          if (signal?.aborted) {
            await reportError(getAbortError(signal));
            return;
          }
          console.error(`[KiroAPI] THINKING_SIGNATURE_INVALID retry error:`, retryErr);
        }
      }
    }
  }
  if (lastError) {
    await reportError(lastError);
  }
}
function extractEventType(headers) {
  let offset = 0;
  while (offset < headers.length) {
    if (offset >= headers.length) break;
    const nameLen = headers[offset];
    offset++;
    if (offset + nameLen > headers.length) break;
    const name = new TextDecoder().decode(headers.slice(offset, offset + nameLen));
    offset += nameLen;
    if (offset >= headers.length) break;
    const valueType = headers[offset];
    offset++;
    if (valueType === 7) {
      if (offset + 2 > headers.length) break;
      const valueLen = headers[offset] << 8 | headers[offset + 1];
      offset += 2;
      if (offset + valueLen > headers.length) break;
      const value = new TextDecoder().decode(headers.slice(offset, offset + valueLen));
      offset += valueLen;
      if (name === ":event-type") {
        return value;
      }
      continue;
    }
    const skipSizes = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 };
    if (valueType === 6) {
      if (offset + 2 > headers.length) break;
      const len = headers[offset] << 8 | headers[offset + 1];
      offset += 2 + len;
    } else if (skipSizes[valueType] !== void 0) {
      offset += skipSizes[valueType];
    } else {
      break;
    }
  }
  return "";
}
async function parseEventStream(body, onChunk, onComplete, onError, onContextUsage, inputChars = 0, signal, modelId, payloadStr) {
  const reader = body.getReader();
  const abort = () => {
    reader.cancel(getAbortError(signal)).catch(() => void 0);
  };
  let buffer = new Uint8Array(0);
  let usage = {
    inputTokens: 0,
    outputTokens: 0,
    credits: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0
  };
  let terminalNotified = false;
  const notifyComplete = async () => {
    if (terminalNotified) return;
    terminalNotified = true;
    try {
      await onComplete(usage);
    } catch (error) {
      proxyLogger.warn("Kiro", "Stream completion callback failed", error);
    }
  };
  const notifyError = async (error) => {
    if (terminalNotified) return;
    terminalNotified = true;
    try {
      await onError(error);
    } catch (callbackError) {
      proxyLogger.warn("Kiro", "Stream error callback failed", callbackError);
    }
  };
  let totalOutputChars = 0;
  let collectedOutputText = "";
  let hasRealTokenUsage = false;
  const streamEventCounts = {};
  if (payloadStr) {
    usage.inputTokens = countTokens(payloadStr);
  } else if (inputChars > 0) {
    usage.inputTokens = Math.max(1, Math.round(inputChars * 0.42));
  }
  let currentToolUse = null;
  const processedIds = /* @__PURE__ */ new Set();
  const toolLeakFixEnabled = (process.env.KIRO_TOOL_LEAK_FIX || "on").toLowerCase().trim() !== "off";
  const toolLeakDebug = process.env.KIRO_TOOL_LEAK_DEBUG === "1";
  let leakCarry = "";
  const leakedTools = [];
  const seenToolSigs = /* @__PURE__ */ new Set();
  let leakIdCounter = 0;
  const toolSig = (name, input) => {
    const sortedKeys = Object.keys(input).sort();
    const norm = {};
    for (const k of sortedKeys) norm[k] = input[k];
    return name + "|" + JSON.stringify(norm);
  };
  const parseInvokeBody = (name, body2) => {
    const input = {};
    const re = /<parameter name="([^"]+)">([\s\S]*?)<\/parameter>/g;
    let m;
    while ((m = re.exec(body2)) !== null) {
      const key = m[1];
      const raw = m[2];
      const t = raw.trim();
      if (t === "true") input[key] = true;
      else if (t === "false") input[key] = false;
      else if (t === "null") input[key] = null;
      else if (/^-?\d+$/.test(t)) input[key] = parseInt(t, 10);
      else if (/^-?\d*\.\d+$/.test(t)) input[key] = parseFloat(t);
      else input[key] = raw;
    }
    return { name, input };
  };
  const stripToolPrefix = (pre) => {
    const fc = pre.match(/<function_calls>\s*$/);
    if (fc) return pre.slice(0, pre.length - fc[0].length);
    const ct = pre.match(/count\s*$/);
    if (ct) return pre.slice(0, pre.length - ct[0].length);
    return pre;
  };
  const hasOpenInvoke = (s) => {
    const i = s.lastIndexOf("<invoke name=");
    if (i === -1) return false;
    return !s.slice(i).includes("</invoke>");
  };
  const pendingToolTail = (s) => {
    const markers = [
      "<function_calls>",
      "<invoke name=",
      "</invoke>",
      "</function_calls>",
      "<parameter name=",
      "</parameter>",
      "count"
    ];
    let hold = 0;
    for (const tag of markers) {
      for (let k = Math.min(s.length, tag.length - 1); k >= 1; k--) {
        if (s.slice(s.length - k) === tag.slice(0, k)) {
          if (k > hold) hold = k;
          break;
        }
      }
    }
    const cm = s.match(/count\s*$/);
    if (cm && cm[0].length > hold) hold = cm[0].length;
    const cm2 = s.match(/count\s*<[\s\S]*$/);
    if (cm2 && cm2[0].length > hold) hold = cm2[0].length;
    return hold;
  };
  const filterToolLeak = async (isFlush) => {
    const emit = async (s) => {
      if (!s) return;
      await onChunk(s);
      totalOutputChars += s.length;
      collectedOutputText += s;
    };
    for (; ; ) {
      const fi = leakCarry.indexOf("<invoke name=");
      if (fi === -1) break;
      const ci = leakCarry.indexOf("</invoke>", fi);
      if (ci === -1) break;
      await emit(stripToolPrefix(leakCarry.slice(0, fi)));
      const localRe = /<invoke name="([^"]+)">([\s\S]*?)<\/invoke>/g;
      localRe.lastIndex = fi;
      let m;
      let consumedEnd = ci + "</invoke>".length;
      while ((m = localRe.exec(leakCarry)) !== null) {
        if (m.index > consumedEnd + 30) break;
        const tool = parseInvokeBody(m[1], m[2]);
        leakedTools.push(tool);
        if (toolLeakDebug) {
          try {
            console.log(
              "[tool-leak-fix] parsed leaked tool:",
              tool.name,
              JSON.stringify(tool.input).slice(0, 120)
            );
          } catch {
          }
        }
        consumedEnd = m.index + m[0].length;
      }
      const fcClose = leakCarry.slice(consumedEnd).match(/^\s*<\/function_calls>/);
      if (fcClose) consumedEnd += fcClose[0].length;
      leakCarry = leakCarry.slice(consumedEnd);
    }
    if (hasOpenInvoke(leakCarry)) {
      if (isFlush) {
        await emit(leakCarry);
        leakCarry = "";
        return;
      }
      const oi = leakCarry.indexOf("<invoke name=");
      const safe = stripToolPrefix(leakCarry.slice(0, oi));
      await emit(safe);
      leakCarry = leakCarry.slice(safe.length);
      return;
    }
    if (isFlush) {
      await emit(leakCarry);
      leakCarry = "";
      return;
    }
    const hold = pendingToolTail(leakCarry);
    await emit(leakCarry.slice(0, leakCarry.length - hold));
    leakCarry = leakCarry.slice(leakCarry.length - hold);
  };
  try {
    throwIfAborted(signal);
    signal?.addEventListener("abort", abort, { once: true });
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) {
        break;
      }
      const newBuffer = new Uint8Array(buffer.length + value.length);
      newBuffer.set(buffer);
      newBuffer.set(value, buffer.length);
      buffer = newBuffer;
      while (buffer.length >= 16) {
        const totalLength = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0, false);
        if (buffer.length < totalLength) {
          break;
        }
        const headersLength = new DataView(buffer.buffer, buffer.byteOffset).getUint32(4, false);
        const headersStart = 12;
        const headersEnd = 12 + headersLength;
        const eventType = extractEventType(buffer.slice(headersStart, headersEnd));
        const payloadStart = 12 + headersLength;
        const payloadEnd = totalLength - 4;
        if (payloadStart < payloadEnd) {
          const payloadBytes = buffer.slice(payloadStart, payloadEnd);
          try {
            const payloadText = new TextDecoder().decode(payloadBytes);
            const event = JSON.parse(payloadText);
            if (eventType === "assistantResponseEvent" || event.assistantResponseEvent) {
              const assistantResp = event.assistantResponseEvent || event;
              const content = assistantResp.content;
              if (content) {
                if (toolLeakFixEnabled) {
                  leakCarry += content;
                  await filterToolLeak(false);
                } else {
                  const stripped = content.replace(/<tool_use\b[^>]*>[\s\S]*?<\/tool_use>/g, "").trim();
                  if (stripped) {
                    await onChunk(stripped);
                    totalOutputChars += stripped.length;
                    collectedOutputText += stripped;
                  }
                }
              }
            }
            if (eventType === "codeEvent" || event.codeEvent) {
              const codeResp = event.codeEvent || event;
              const content = codeResp.content;
              if (content) {
                if (toolLeakFixEnabled) {
                  leakCarry += content;
                  await filterToolLeak(false);
                } else {
                  const stripped = content.replace(/<tool_use\b[^>]*>[\s\S]*?<\/tool_use>/g, "").trim();
                  if (stripped) {
                    await onChunk(stripped);
                    totalOutputChars += stripped.length;
                    collectedOutputText += stripped;
                  }
                }
              }
            }
            if (eventType === "toolUseEvent" || event.toolUseEvent) {
              const toolUseData = event.toolUseEvent || event;
              const toolUseId = toolUseData.toolUseId;
              const toolName = toolUseData.name;
              const isStop = toolUseData.stop === true;
              let inputFragment = "";
              let inputObj = null;
              if (typeof toolUseData.input === "string") {
                inputFragment = toolUseData.input;
              } else if (typeof toolUseData.input === "object" && toolUseData.input !== null) {
                inputObj = toolUseData.input;
              }
              if (toolUseId && toolName) {
                if (currentToolUse && currentToolUse.toolUseId !== toolUseId) {
                  if (!processedIds.has(currentToolUse.toolUseId)) {
                    let finalInput = {};
                    try {
                      if (currentToolUse.inputBuffer) {
                        finalInput = JSON.parse(currentToolUse.inputBuffer);
                      }
                    } catch {
                    }
                    await onChunk("", {
                      toolUseId: currentToolUse.toolUseId,
                      name: currentToolUse.name,
                      input: finalInput
                    });
                    if (toolLeakFixEnabled) {
                      try {
                        seenToolSigs.add(toolSig(currentToolUse.name, finalInput));
                      } catch {
                      }
                    }
                    totalOutputChars += currentToolUse.name.length + currentToolUse.inputBuffer.length;
                    processedIds.add(currentToolUse.toolUseId);
                  }
                  currentToolUse = null;
                }
                if (!currentToolUse) {
                  if (processedIds.has(toolUseId)) {
                  } else {
                    currentToolUse = {
                      toolUseId,
                      name: toolName,
                      inputBuffer: ""
                    };
                  }
                }
              }
              if (currentToolUse && inputFragment) {
                currentToolUse.inputBuffer += inputFragment;
              }
              if (currentToolUse && inputObj) {
                currentToolUse.inputBuffer = JSON.stringify(inputObj);
              }
              if (isStop && currentToolUse) {
                let finalInput = {};
                let parseError = false;
                try {
                  if (currentToolUse.inputBuffer) {
                    if (logStreamEvents)
                      ;
                    finalInput = JSON.parse(currentToolUse.inputBuffer);
                    if (logStreamEvents)
                      ;
                  }
                } catch (e) {
                  parseError = true;
                  console.error(
                    "[Kiro] Failed to parse tool input:",
                    e,
                    "Buffer:",
                    currentToolUse.inputBuffer?.substring(0, 100)
                  );
                  finalInput = {
                    _error: "Tool input truncated by Kiro API (output token limit exceeded)",
                    _partialInput: currentToolUse.inputBuffer?.substring(0, 500) || ""
                  };
                }
                await onChunk("", {
                  toolUseId: currentToolUse.toolUseId,
                  name: currentToolUse.name,
                  input: finalInput
                });
                if (toolLeakFixEnabled && !parseError) {
                  try {
                    seenToolSigs.add(toolSig(currentToolUse.name, finalInput));
                  } catch {
                  }
                }
                totalOutputChars += currentToolUse.name.length + currentToolUse.inputBuffer.length;
                if (parseError) {
                  await onChunk(
                    `

⚠️ Tool "${currentToolUse.name}" input was truncated by Kiro API. The output may be incomplete due to token limits.`
                  );
                }
                processedIds.add(currentToolUse.toolUseId);
                currentToolUse = null;
              }
            }
            if (eventType === "messageMetadataEvent" || eventType === "metadataEvent" || event.messageMetadataEvent || event.metadataEvent) {
              const metadata = event.messageMetadataEvent || event.metadataEvent || event;
              proxyLogger.info("Kiro", "messageMetadataEvent", metadata);
              if (metadata.tokenUsage) {
                const tokenUsage = metadata.tokenUsage;
                proxyLogger.info("Kiro", "tokenUsage", tokenUsage);
                const uncached = tokenUsage.uncachedInputTokens || 0;
                const cacheRead = tokenUsage.cacheReadInputTokens || 0;
                const cacheWrite = tokenUsage.cacheWriteInputTokens || 0;
                const calculatedInput = uncached + cacheRead + cacheWrite;
                if (calculatedInput > 0) {
                  usage.inputTokens = calculatedInput;
                  hasRealTokenUsage = true;
                }
                if (tokenUsage.outputTokens) usage.outputTokens = tokenUsage.outputTokens;
                if (tokenUsage.totalTokens) {
                  if (usage.inputTokens === 0 && usage.outputTokens > 0) {
                    usage.inputTokens = tokenUsage.totalTokens - usage.outputTokens;
                    hasRealTokenUsage = true;
                  }
                }
                usage.cacheReadTokens = cacheRead;
                usage.cacheWriteTokens = cacheWrite;
                if (tokenUsage.contextUsagePercentage !== void 0) {
                  proxyLogger.info(
                    "Kiro",
                    "Context usage: " + tokenUsage.contextUsagePercentage.toFixed(2) + "%"
                  );
                }
                proxyLogger.info("Kiro", "Token breakdown", {
                  uncached,
                  cacheRead,
                  cacheWrite,
                  inputTotal: calculatedInput,
                  output: tokenUsage.outputTokens || 0,
                  total: tokenUsage.totalTokens || 0,
                  contextUsage: tokenUsage.contextUsagePercentage ? `${tokenUsage.contextUsagePercentage.toFixed(2)}%` : "N/A"
                });
              }
              if (metadata.inputTokens) {
                usage.inputTokens = metadata.inputTokens;
                hasRealTokenUsage = true;
              }
              if (metadata.outputTokens) usage.outputTokens = metadata.outputTokens;
            }
            if (logStreamEvents) ;
            if (eventType === "usageEvent" || eventType === "usage" || event.usageEvent || event.usage) {
              const usageData = event.usageEvent || event.usage || event;
              if (usageData.inputTokens) {
                usage.inputTokens = usageData.inputTokens;
                hasRealTokenUsage = true;
              }
              if (usageData.outputTokens) usage.outputTokens = usageData.outputTokens;
            }
            if (eventType === "meteringEvent" || event.meteringEvent) {
              const metering = event.meteringEvent || event;
              if (metering.usage && typeof metering.usage === "number") {
                usage.credits += metering.usage;
                proxyLogger.info(
                  "Kiro",
                  `meteringEvent - credit: ${metering.usage}, total: ${usage.credits}`
                );
              }
            }
            if (eventType === "supplementaryWebLinksEvent" || event.supplementaryWebLinksEvent) {
              const webLinksEvent = event.supplementaryWebLinksEvent || event;
              if (webLinksEvent.supplementaryWebLinks && Array.isArray(webLinksEvent.supplementaryWebLinks)) {
                const links = webLinksEvent.supplementaryWebLinks.filter((link) => link.url).map((link) => {
                  const title = link.title || link.url;
                  return `- [${title}](${link.url})`;
                });
                if (links.length > 0) {
                  await onChunk(`

🔗 **Web References:**
${links.join("\n")}`);
                }
              }
              proxyLogger.debug(
                "Kiro",
                "supplementaryWebLinksEvent",
                JSON.stringify(webLinksEvent).slice(0, 300)
              );
            }
            if (eventType === "contextUsageEvent" || event.contextUsageEvent) {
              const contextEvent = event.contextUsageEvent || event;
              if (contextEvent.contextUsagePercentage !== void 0) {
                const percentage = contextEvent.contextUsagePercentage;
                usage.contextUsage = {
                  percentage,
                  breakdown: contextEvent.breakdown ? {
                    conversation: contextEvent.breakdown.conversation,
                    mcpTools: contextEvent.breakdown.mcpTools,
                    steeringFiles: contextEvent.breakdown.steeringFiles
                  } : void 0
                };
                if (hasRealTokenUsage) {
                  proxyLogger.info(
                    "Kiro",
                    `contextUsageEvent - Context usage: ${percentage.toFixed(2)}% (real tokenUsage already received)`
                  );
                } else {
                  const contextLen = getModelContextLength(modelId);
                  const reverseInput = Math.round(contextLen * percentage / 100);
                  if (reverseInput > 0) {
                    usage.inputTokens = reverseInput;
                    proxyLogger.info(
                      "Kiro",
                      `contextUsageEvent ${percentage.toFixed(2)}% → inputTokens=${reverseInput} (modelContext=${contextLen}, model=${modelId || "unknown"})`
                    );
                  } else {
                    proxyLogger.info(
                      "Kiro",
                      `contextUsageEvent - Context usage: ${percentage.toFixed(2)}%`
                    );
                  }
                }
                await onContextUsage?.(usage);
                if (usage.contextUsage.breakdown) {
                  proxyLogger.info(
                    "Kiro",
                    `contextUsage breakdown: conversation=${usage.contextUsage.breakdown.conversation || 0}% mcpTools=${usage.contextUsage.breakdown.mcpTools || 0}% steering=${usage.contextUsage.breakdown.steeringFiles || 0}%`
                  );
                }
                if (percentage > 80) {
                  console.warn(
                    "[Kiro] Warning: Context usage is high:",
                    percentage.toFixed(2) + "%"
                  );
                }
              }
            }
            if (eventType === "reasoningContentEvent" || event.reasoningContentEvent) {
              const reasoning = event.reasoningContentEvent || event;
              if (reasoning.text) {
                proxyLogger.info(
                  "Kiro",
                  `Received reasoning content (isThinking=true): ${reasoning.text.slice(0, 50)}...`
                );
                await onChunk(reasoning.text, void 0, true, reasoning.signature, void 0);
                totalOutputChars += reasoning.text.length;
                usage.reasoningTokens = (usage.reasoningTokens || 0) + Math.max(1, Math.round(reasoning.text.length * 0.4));
              } else if (reasoning.signature && !reasoning.redactedContent) {
                await onChunk("", void 0, true, reasoning.signature, void 0);
              }
              if (reasoning.redactedContent) {
                proxyLogger.info(
                  "Kiro",
                  `Received redacted thinking content (len=${reasoning.redactedContent.length})`
                );
                await onChunk("", void 0, true, void 0, reasoning.redactedContent);
              }
              proxyLogger.debug(
                "Kiro",
                "reasoningContentEvent",
                JSON.stringify(reasoning).slice(0, 200)
              );
            }
            if (eventType === "codeReferenceEvent" || event.codeReferenceEvent) {
              const codeRef = event.codeReferenceEvent || event;
              if (codeRef.references && Array.isArray(codeRef.references)) {
                const refTexts = codeRef.references.filter(
                  (ref) => ref.licenseName || ref.repository
                ).map((ref) => {
                  const parts = [];
                  if (ref.licenseName) parts.push(`License: ${ref.licenseName}`);
                  if (ref.repository) parts.push(`Repo: ${ref.repository}`);
                  if (ref.url) parts.push(`URL: ${ref.url}`);
                  return parts.join(", ");
                });
                if (refTexts.length > 0) {
                  await onChunk(`

📚 **Code References:**
${refTexts.join("\n")}`);
                }
              }
              proxyLogger.debug("Kiro", "codeReferenceEvent", JSON.stringify(codeRef).slice(0, 300));
            }
            if (eventType === "followupPromptEvent" || event.followupPromptEvent) {
              const followup = event.followupPromptEvent || event;
              if (followup.followupPrompt) {
                const prompt = followup.followupPrompt;
                if (prompt.content || prompt.userIntent) {
                  const suggestion = prompt.content || prompt.userIntent;
                  await onChunk(`

💡 **Suggested follow-up:** ${suggestion}`);
                }
              }
              proxyLogger.debug(
                "Kiro",
                "followupPromptEvent",
                JSON.stringify(followup).slice(0, 200)
              );
            }
            if (eventType === "intentsEvent" || event.intentsEvent) {
              const intents = event.intentsEvent || event;
              proxyLogger.debug("Kiro", "intentsEvent", JSON.stringify(intents).slice(0, 300));
            }
            if (eventType === "interactionComponentsEvent" || event.interactionComponentsEvent) {
              const components = event.interactionComponentsEvent || event;
              proxyLogger.debug(
                "Kiro",
                "interactionComponentsEvent",
                JSON.stringify(components).slice(0, 300)
              );
            }
            if (eventType === "invalidStateEvent" || event.invalidStateEvent) {
              const invalid = event.invalidStateEvent || event;
              const reason = invalid.reason || "UNKNOWN";
              const message = invalid.message || "Invalid state detected";
              console.error("[Kiro] invalidStateEvent:", reason, message);
              await onChunk(`

⚠️ **Warning:** ${message} (reason: ${reason})`);
            }
            if (eventType === "citationEvent" || event.citationEvent) {
              const citation = event.citationEvent || event;
              if (citation.citations && Array.isArray(citation.citations)) {
                const citationTexts = citation.citations.filter(
                  (c) => c.title || c.url
                ).map((c, i) => {
                  const parts = [`[${i + 1}]`];
                  if (c.title) parts.push(c.title);
                  if (c.url) parts.push(`(${c.url})`);
                  return parts.join(" ");
                });
                if (citationTexts.length > 0) {
                  await onChunk(`

📖 **Citations:**
${citationTexts.join("\n")}`);
                }
              }
              proxyLogger.debug("Kiro", "citationEvent", JSON.stringify(citation).slice(0, 300));
            }
            if (event._type || event.error) {
              const errMsg = event.message || event.error?.message || "Unknown stream error";
              throw new Error(errMsg);
            }
          } catch (parseError) {
            if (parseError instanceof SyntaxError) {
              console.debug("[EventStream] JSON parse error:", parseError);
            } else {
              throw parseError;
            }
          }
        }
        buffer = buffer.slice(totalLength);
      }
    }
    if (toolLeakFixEnabled) {
      try {
        await filterToolLeak(true);
      } catch {
      }
    }
    if (currentToolUse && !processedIds.has(currentToolUse.toolUseId)) {
      let finalInput = {};
      try {
        if (currentToolUse.inputBuffer) {
          finalInput = JSON.parse(currentToolUse.inputBuffer);
        }
      } catch {
      }
      await onChunk("", {
        toolUseId: currentToolUse.toolUseId,
        name: currentToolUse.name,
        input: finalInput
      });
      if (toolLeakFixEnabled) {
        try {
          seenToolSigs.add(toolSig(currentToolUse.name, finalInput));
        } catch {
        }
      }
      totalOutputChars += currentToolUse.name.length + currentToolUse.inputBuffer.length;
    }
    if (toolLeakFixEnabled && leakedTools.length > 0) {
      let rescued = 0;
      let deduped = 0;
      for (const lt of leakedTools) {
        let sig;
        try {
          sig = toolSig(lt.name, lt.input);
        } catch {
          sig = lt.name + "|?";
        }
        if (seenToolSigs.has(sig)) {
          deduped++;
          continue;
        }
        seenToolSigs.add(sig);
        leakIdCounter++;
        const rescuedId = `toolleakfix_${Date.now().toString(36)}_${leakIdCounter.toString(36)}`;
        await onChunk("", { toolUseId: rescuedId, name: lt.name, input: lt.input });
        rescued++;
      }
      if (rescued > 0 || toolLeakDebug) {
        proxyLogger.info(
          "Kiro",
          `Tool-leak-fix: leaked=${leakedTools.length} rescued=${rescued} deduped=${deduped}`
        );
      }
    }
    if (usage.outputTokens === 0 && totalOutputChars > 0) {
      if (collectedOutputText) {
        usage.outputTokens = Math.max(1, countTokens(collectedOutputText));
        proxyLogger.info(
          "Kiro",
          `Estimated output tokens (tiktoken): ${totalOutputChars} chars -> ${usage.outputTokens} tokens`
        );
      } else {
        usage.outputTokens = Math.max(1, Math.round(totalOutputChars * 0.4));
        proxyLogger.info(
          "Kiro",
          `Estimated output tokens (fallback): ${totalOutputChars} chars -> ${usage.outputTokens} tokens`
        );
      }
    }
    if (logStreamEvents && Object.keys(streamEventCounts).length > 0) ;
    throwIfAborted(signal);
    proxyLogger.info("Kiro", "Stream complete, final usage", usage);
    await notifyComplete();
  } catch (error) {
    await notifyError(signal?.aborted ? getAbortError(signal) : error);
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
async function callKiroApi(account, payload, signal) {
  return new Promise((resolve, reject) => {
    let content = "";
    let reasoningText = "";
    let reasoningSignature;
    let redactedContent = "";
    const toolUses = [];
    let usage = { inputTokens: 0, outputTokens: 0, credits: 0 };
    callKiroApiStream(
      account,
      payload,
      (text, toolUse, isThinking, signature, redacted) => {
        if (isThinking) {
          if (text) reasoningText += text;
          if (signature) reasoningSignature = signature;
          if (redacted) redactedContent += redacted;
        } else {
          content += text;
        }
        if (toolUse) {
          toolUses.push(toolUse);
        }
      },
      (u) => {
        usage = u;
        if (reasoningText || redactedContent) {
          const rc = {};
          if (reasoningText) rc.text = reasoningText;
          if (reasoningSignature) rc.signature = reasoningSignature;
          if (redactedContent) rc.redactedContent = redactedContent;
          resolve({ content, toolUses, usage, reasoningContent: rc });
          return;
        }
        resolve({ content, toolUses, usage });
      },
      reject,
      signal
    ).catch(reject);
  });
}
function getQServiceEndpoint(region) {
  if (region?.startsWith("eu-")) return "https://q.eu-central-1.amazonaws.com";
  return "https://q.us-east-1.amazonaws.com";
}
function getCodeWhispererEndpoint(region) {
  if (region?.startsWith("eu-")) return "https://codewhisperer.eu-central-1.amazonaws.com";
  return "https://codewhisperer.us-east-1.amazonaws.com";
}
async function fetchEnterpriseProfileArn(account) {
  if (isKiroApiKeyAccount(account)) return void 0;
  const baseUrl = getCodeWhispererEndpoint(account.region);
  const url = `${baseUrl}/ListAvailableProfiles`;
  const headers = {
    "Content-Type": "application/json",
    ...getKiroAuthenticationHeaders(account),
    "x-amz-user-agent": getKiroAmzUserAgent$1(),
    "user-agent": getKiroUserAgent$1(),
    "amz-sdk-invocation-id": uuid.v4(),
    "amz-sdk-request": "attempt=1; max=1"
  };
  const fallbackArn = resolveProfileArn(account);
  try {
    const response = await fetchWithProxy(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify({})
      },
      account
    );
    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      console.error(
        `[KiroAPI] ListAvailableProfiles failed: ${response.status}`,
        errBody.slice(0, 200)
      );
      if (response.status === 403 && fallbackArn) {
        console.log(
          `[KiroAPI] Using fallback profileArn for ${account.provider || "unknown"}: ${fallbackArn}`
        );
        return fallbackArn;
      }
      return void 0;
    }
    const data = await response.json();
    const profiles = data.profiles || [];
    if (profiles.length === 0) {
      console.warn("[KiroAPI] ListAvailableProfiles: no profiles returned");
      return void 0;
    }
    const arn = profiles[0].arn;
    if (arn) {
      console.log(`[KiroAPI] Enterprise profileArn resolved: ${arn}`);
    }
    return arn || void 0;
  } catch (error) {
    console.error("[KiroAPI] fetchEnterpriseProfileArn error:", error);
    return void 0;
  }
}
async function fetchKiroModels(account, signal) {
  const baseUrl = getQServiceEndpoint(account.region);
  const headers = {
    ...getKiroAuthenticationHeaders(account),
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": getKiroUserAgent$1(),
    "x-amz-user-agent": getKiroAmzUserAgent$1(),
    "x-amzn-codewhisperer-optout": "true"
  };
  const allModels = [];
  let nextToken;
  const isEnterprise = account.provider === "Enterprise" || account.authMethod === "external_idp";
  if (!isKiroApiKeyAccount(account) && !account.profileArn && isEnterprise) {
    const fetchedArn = await fetchEnterpriseProfileArn(account);
    if (fetchedArn) {
      account.profileArn = fetchedArn;
      if (account.id) ;
    }
  }
  try {
    do {
      const params = new URLSearchParams({ origin: "AI_EDITOR", maxResults: "50" });
      const arnForModels = resolveProfileArn(account);
      if (arnForModels) params.set("profileArn", arnForModels);
      if (nextToken) params.set("nextToken", nextToken);
      const url = `${baseUrl}/ListAvailableModels?${params.toString()}`;
      throwIfAborted(signal);
      const response = await fetchWithProxy(url, { method: "GET", headers, signal }, account);
      throwIfAborted(signal);
      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        console.error(
          `[KiroAPI] ListAvailableModels failed: ${response.status}`,
          errBody.slice(0, 300)
        );
        break;
      }
      const data = await response.json();
      allModels.push(...data.models || []);
      nextToken = data.nextToken;
    } while (nextToken);
    return allModels;
  } catch (error) {
    if (signal?.aborted) throw getAbortError(signal);
    console.error("[KiroAPI] ListAvailableModels error:", error);
    return allModels.length > 0 ? allModels : [];
  }
}
const KIRO_SUBSCRIPTION_VERSION = "0.12.155";
function getSubscriptionUserAgent() {
  return `aws-sdk-js/1.0.0 ua/2.1 os/win32#10.0.19043 lang/js md/nodejs#22.22.0 api/codewhispererruntime#1.0.0 m/N,E KiroIDE-${KIRO_SUBSCRIPTION_VERSION}`;
}
function getSubscriptionAmzUserAgent() {
  return `aws-sdk-js/1.0.0 KiroIDE-${KIRO_SUBSCRIPTION_VERSION}`;
}
async function fetchAvailableSubscriptions(account) {
  const baseUrl = getQServiceEndpoint(account.region);
  const url = `${baseUrl}/listAvailableSubscriptions`;
  const headers = {
    ...getKiroAuthenticationHeaders(account),
    "content-type": "application/json",
    "user-agent": getSubscriptionUserAgent(),
    "x-amz-user-agent": getSubscriptionAmzUserAgent(),
    "amz-sdk-invocation-id": uuid.v4(),
    "amz-sdk-request": "attempt=1; max=1"
  };
  const profileArn = resolveProfileArn(account);
  const body = JSON.stringify(profileArn ? { profileArn } : {});
  console.log(`[KiroAPI] ListAvailableSubscriptions [${account.email || account.id.slice(0, 8)}]`, {
    url,
    hasProfileArn: profileArn !== void 0
  });
  try {
    const response = await fetchWithProxy(url, { method: "POST", headers, body }, account);
    const responseText = await response.text();
    console.log(
      `[KiroAPI] ListAvailableSubscriptions → ${response.status}`,
      JSON.parse(responseText)
    );
    if (!response.ok) {
      return {};
    }
    return JSON.parse(responseText);
  } catch (error) {
    console.error("[KiroAPI] ListAvailableSubscriptions error:", error);
    return {};
  }
}
async function fetchSubscriptionToken(account, subscriptionType) {
  const baseUrl = getQServiceEndpoint(account.region);
  const url = `${baseUrl}/CreateSubscriptionToken`;
  const headers = {
    ...getKiroAuthenticationHeaders(account),
    "content-type": "application/json",
    "user-agent": getSubscriptionUserAgent(),
    "x-amz-user-agent": getSubscriptionAmzUserAgent(),
    "amz-sdk-invocation-id": uuid.v4(),
    "amz-sdk-request": "attempt=1; max=1"
  };
  const profileArn = resolveProfileArn(account);
  const payload = {
    clientToken: uuid.v4(),
    provider: "STRIPE"
  };
  if (profileArn) {
    payload.profileArn = profileArn;
  }
  if (subscriptionType) {
    payload.subscriptionType = subscriptionType;
  }
  try {
    const response = await fetchWithProxy(
      url,
      { method: "POST", headers, body: JSON.stringify(payload) },
      account
    );
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error("[KiroAPI] CreateSubscriptionToken failed:", response.status, errorData);
      return { message: errorData.message || `Request failed with status ${response.status}` };
    }
    const data = await response.json();
    return data;
  } catch (error) {
    console.error("[KiroAPI] CreateSubscriptionToken error:", error);
    return { message: error instanceof Error ? error.message : "Unknown error" };
  }
}
class ToolNameRegistry {
  originalToKiro = /* @__PURE__ */ new Map();
  kiroToOriginal = /* @__PURE__ */ new Map();
  toKiroName(name) {
    const existing = this.originalToKiro.get(name);
    if (existing) return existing;
    const baseName = name.length <= 64 ? name : this.shorten(name);
    const kiroName = this.ensureUnique(baseName, name);
    this.originalToKiro.set(name, kiroName);
    this.kiroToOriginal.set(kiroName, name);
    return kiroName;
  }
  toClientName(name) {
    return this.kiroToOriginal.get(name) || name;
  }
  restoreToolUse(toolUse) {
    return {
      ...toolUse,
      name: this.toClientName(toolUse.name)
    };
  }
  restoreToolUses(toolUses) {
    return toolUses.map((toolUse) => this.restoreToolUse(toolUse));
  }
  ensureUnique(baseName, originalName) {
    const existing = this.kiroToOriginal.get(baseName);
    if (!existing || existing === originalName) return baseName;
    const hash = this.hash(originalName);
    const suffix = `_${hash}`;
    const candidate = baseName.substring(0, Math.max(1, 64 - suffix.length)) + suffix;
    const candidateExisting = this.kiroToOriginal.get(candidate);
    if (!candidateExisting || candidateExisting === originalName) return candidate;
    throw new Error(`Tool name collision after shortening: ${originalName}`);
  }
  shorten(name) {
    const hash = this.hash(name);
    const suffix = `_${hash}`;
    const readable = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const maxPrefixLength = 64 - suffix.length;
    return readable.substring(0, maxPrefixLength) + suffix;
  }
  hash(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }
}
const KIRO_CACHE_POINT = { type: "default" };
function buildThinkingFields(thinkingConfig, clientThinking, clientReasoningEffort) {
  if (clientThinking?.type === "disabled") return void 0;
  {
    if (clientThinking && clientThinking.type !== "disabled") {
      return { thinking: { type: "adaptive" } };
    }
    if (clientReasoningEffort) {
      return { thinking: { type: "adaptive" } };
    }
    return void 0;
  }
}
function toKiroCachePoint(cacheControl) {
  if (!cacheControl) return void 0;
  if (cacheControl.type !== "ephemeral") {
    throw new Error(`Unsupported cache_control type: ${cacheControl.type}`);
  }
  return KIRO_CACHE_POINT;
}
function mergeCachePoint(first, second) {
  return first || second;
}
function openaiToKiro(request, profileArn, toolNameRegistry = new ToolNameRegistry(), thinkingConfig) {
  const modelId = mapModelId(request.model);
  const origin = "AI_EDITOR";
  let systemPrompt = "";
  let systemCachePoint;
  const nonSystemMessages = [];
  for (const msg of request.messages) {
    if (msg.role === "system") {
      systemCachePoint = mergeCachePoint(systemCachePoint, toKiroCachePoint(msg.cache_control));
      if (typeof msg.content === "string") {
        systemPrompt += (systemPrompt ? "\n" : "") + msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          systemCachePoint = mergeCachePoint(systemCachePoint, toKiroCachePoint(part.cache_control));
          if (part.type === "text" && part.text) {
            systemPrompt += (systemPrompt ? "\n" : "") + part.text;
          }
        }
      }
    } else {
      nonSystemMessages.push(msg);
    }
  }
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  systemPrompt = `[Context: Current time is ${timestamp}]

${systemPrompt}`;
  const executionDirective = `
<execution_discipline>
当用户要求执行特定任务时，你必须遵循以下纪律：
1. **目标锁定**：在整个会话中始终牢记用户的原始目标，不要在代码探索过程中迷失方向
2. **行动优先**：优先执行任务而非仅分析或总结，除非用户明确只要求分析
3. **计划执行**：为任务创建明确的步骤计划，逐步执行并标记完成状态
4. **禁止确认性收尾**：在任务未完成前，禁止输出"需要我继续吗？"、"需要深入分析吗？"等确认性问题
5. **持续推进**：如果发现部分任务已完成，立即继续执行剩余未完成的任务
6. **完整交付**：直到所有任务步骤都执行完毕才算完成
</execution_discipline>
`;
  systemPrompt = systemPrompt + "\n\n" + executionDirective;
  const history = [];
  const toolResults = [];
  let currentContent = "";
  let currentCachePoint;
  const images = [];
  const documents = [];
  for (let i = 0; i < nonSystemMessages.length; i++) {
    const msg = nonSystemMessages[i];
    const isLast = i === nonSystemMessages.length - 1;
    if (msg.role === "user") {
      const {
        content: userContent,
        images: userImages,
        documents: userDocuments,
        cachePoint
      } = extractOpenAIContent(msg);
      const mergedContent = userContent || "Continue";
      const messageCachePoint = cachePoint;
      if (isLast) {
        currentContent = mergedContent;
        currentCachePoint = messageCachePoint;
        images.push(...userImages);
        documents.push(...userDocuments);
      } else {
        history.push({
          userInputMessage: {
            content: mergedContent,
            modelId,
            origin,
            images: userImages.length > 0 ? userImages : void 0,
            documents: userDocuments.length > 0 ? userDocuments : void 0,
            ...messageCachePoint ? { cachePoint: messageCachePoint } : {}
          }
        });
      }
    } else if (msg.role === "assistant") {
      let assistantContent = typeof msg.content === "string" ? msg.content : "";
      if (!assistantContent.trim() && msg.tool_calls && msg.tool_calls.length > 0) {
        assistantContent = " ";
      } else if (!assistantContent.trim()) {
        assistantContent = "I understand.";
      }
      const toolUses = [];
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.type === "function") {
            let input = {};
            try {
              input = JSON.parse(tc.function.arguments);
            } catch {
            }
            toolUses.push({
              toolUseId: tc.id,
              name: toolNameRegistry.toKiroName(tc.function.name),
              input
            });
          }
        }
      }
      history.push({
        assistantResponseMessage: {
          content: assistantContent,
          toolUses: toolUses.length > 0 ? toolUses : void 0
        }
      });
    } else if (msg.role === "tool") {
      if (msg.tool_call_id) {
        let rawText = "";
        let extractedImageCount = 0;
        if (Array.isArray(msg.content)) {
          const textParts = [];
          for (const part of msg.content) {
            if (part.type === "text" && typeof part.text === "string") {
              textParts.push(part.text);
            } else if (part.type === "image_url" && part.image_url?.url) {
              const img = parseImageUrl(part.image_url.url);
              if (img) {
                images.push(img);
                extractedImageCount++;
              }
            }
          }
          rawText = textParts.join("");
          if (!rawText && extractedImageCount === 0) {
            rawText = JSON.stringify(msg.content);
          }
          if (extractedImageCount > 0) {
            rawText = (rawText ? rawText + "\n\n" : "") + `[Tool returned ${extractedImageCount} image${extractedImageCount > 1 ? "s" : ""}, attached to this message]`;
          }
        } else {
          rawText = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        }
        toolResults.push({
          toolUseId: msg.tool_call_id,
          content: [{ text: rawText || "(no output)" }],
          status: "success"
        });
      }
      const nextMsg = nonSystemMessages[i + 1];
      const shouldFlush = !nextMsg || nextMsg.role !== "tool";
      if (shouldFlush && toolResults.length > 0 && !isLast) {
        history.push({
          userInputMessage: {
            content: "Tool results provided.",
            modelId,
            origin,
            userInputMessageContext: {
              toolResults: [...toolResults]
            }
          }
        });
        toolResults.length = 0;
      }
    }
  }
  if (history.length > 0 && history[history.length - 1].assistantResponseMessage && !currentContent) {
    currentContent = "Continue.";
  }
  if (!currentContent && toolResults.length > 0) {
    currentContent = "Tool results provided.";
  }
  if (systemPrompt) {
    const systemMessages = [
      {
        userInputMessage: {
          content: systemPrompt,
          userInputMessageContext: {},
          origin,
          ...systemCachePoint ? { cachePoint: systemCachePoint } : {}
        }
      },
      {
        assistantResponseMessage: {
          content: "I will follow these instructions."
        }
      }
    ];
    history.unshift(...systemMessages);
  }
  const finalContent = currentContent || "Continue.";
  const kiroTools = convertOpenAITools(request.tools, toolNameRegistry);
  const additionalModelRequestFields = buildThinkingFields(
    thinkingConfig,
    request.thinking,
    request.reasoning_effort
  );
  return buildKiroPayload(
    finalContent,
    modelId,
    origin,
    history,
    kiroTools,
    toolResults,
    images,
    profileArn,
    {
      maxTokens: request.max_tokens,
      temperature: request.temperature,
      topP: request.top_p
    },
    {
      cachePoint: currentCachePoint,
      documents,
      conversationId: request.conversation_id,
      context: request.kiro_context
    },
    additionalModelRequestFields
  );
}
function extractOpenAIContent(msg) {
  const images = [];
  const documents = [];
  let content = "";
  let cachePoint = toKiroCachePoint(msg.cache_control);
  if (typeof msg.content === "string") {
    content = msg.content;
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      cachePoint = mergeCachePoint(cachePoint, toKiroCachePoint(part.cache_control));
      if (part.type === "text" && part.text) {
        content += part.text;
      } else if (part.type === "image_url" && part.image_url?.url) {
        const image = parseImageUrl(part.image_url.url);
        if (image) {
          images.push(image);
        }
      } else if (part.type === "file" || part.type === "document") {
        if (part.file?.file_data) {
          const name = part.file.filename || part.name;
          if (!name) {
            throw new Error(`${part.type} requires filename or name`);
          }
          documents.push(parseOpenAIFileData(part.file.file_data, name));
        } else if (part.source) {
          if (!part.name) {
            throw new Error(`${part.type} requires name`);
          }
          documents.push(parseClaudeDocumentSource(part.source, part.name));
        } else {
          throw new Error(`${part.type} requires file_data or source`);
        }
      }
    }
  }
  return { content, images, documents, cachePoint };
}
function parseImageUrl(url) {
  if (url.startsWith("data:")) {
    const match = url.match(/^data:image\/(\w+);base64,(.+)$/);
    if (match) {
      return {
        format: normalizeImageFormat(match[1]),
        source: { bytes: match[2] }
      };
    }
  }
  return null;
}
function parseOpenAIFileData(fileData, name) {
  const dataUrlMatch = fileData.match(/^data:([^;]+);base64,(.+)$/);
  if (dataUrlMatch) {
    return {
      format: normalizeDocumentFormat(dataUrlMatch[1], name),
      name,
      source: { bytes: dataUrlMatch[2] }
    };
  }
  return {
    format: normalizeDocumentFormat(void 0, name),
    name,
    source: { bytes: fileData }
  };
}
function parseClaudeDocumentSource(source, name) {
  if (source.type === "base64") {
    return {
      format: normalizeDocumentFormat(source.media_type, name),
      name,
      source: { bytes: source.data }
    };
  }
  if (source.type === "text") {
    return {
      format: normalizeDocumentFormat(source.media_type, name),
      name,
      source: { bytes: Buffer.from(source.data, "utf8").toString("base64") }
    };
  }
  throw new Error(`Unsupported document source type: ${source.type}`);
}
function normalizeImageFormat(format) {
  const lower = format.toLowerCase();
  const formatMap = {
    jpg: "jpeg",
    jpeg: "jpeg",
    png: "png",
    gif: "gif",
    webp: "webp"
  };
  const normalized = formatMap[lower];
  if (!normalized) {
    throw new Error(`Unsupported image format: ${format}`);
  }
  return normalized;
}
function normalizeDocumentFormat(mediaType, name) {
  const lowerMediaType = mediaType?.toLowerCase();
  if (lowerMediaType === "application/pdf") return "pdf";
  if (lowerMediaType === "text/markdown") return "md";
  if (lowerMediaType === "text/csv") return "csv";
  if (lowerMediaType === "text/html") return "html";
  if (lowerMediaType?.startsWith("text/")) return "txt";
  const extension = name.split(".").pop()?.toLowerCase();
  if (extension === "pdf") return "pdf";
  if (extension === "md" || extension === "markdown") return "md";
  if (extension === "csv") return "csv";
  if (extension === "html" || extension === "htm") return "html";
  return "txt";
}
const KIRO_MAX_TOOL_DESC_LEN = 10237;
function convertOpenAITools(tools, toolNameRegistry) {
  if (!tools) return [];
  return tools.flatMap((tool) => {
    let description = tool.function.description || `Tool: ${tool.function.name}`;
    if (description.length > KIRO_MAX_TOOL_DESC_LEN) {
      description = description.substring(0, KIRO_MAX_TOOL_DESC_LEN) + "...";
    }
    const kiroTool = {
      toolSpecification: {
        name: shortenToolName(tool.function.name, toolNameRegistry),
        description,
        inputSchema: { json: tool.function.parameters }
      }
    };
    const cachePoint = toKiroCachePoint(tool.cache_control);
    return cachePoint ? [kiroTool, { cachePoint }] : [kiroTool];
  });
}
function shortenToolName(name, toolNameRegistry) {
  return toolNameRegistry.toKiroName(name);
}
let shared = null;
let openPromise = null;
async function acquireModuleClient(opts) {
  if (shared) return shared;
  if (openPromise) return openPromise;
  openPromise = (async () => {
    const mc = new tlsclientwrapper.ModuleClient(opts);
    await mc.open();
    shared = mc;
    openPromise = null;
    return mc;
  })();
  try {
    return await openPromise;
  } catch (err) {
    openPromise = null;
    throw err;
  }
}
async function shutdownTlsClientPool() {
  const mc = shared;
  shared = null;
  openPromise = null;
  if (!mc) return;
  try {
    await Promise.race([
      mc.terminate(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("terminate timeout")), 5e3))
    ]);
  } catch {
  }
}
const tlsClientPool = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  acquireModuleClient,
  shutdownTlsClientPool
}, Symbol.toStringTag, { value: "Module" }));
const FIRST_NAMES = [
  // 男性常见名
  "James",
  "Robert",
  "John",
  "Michael",
  "David",
  "William",
  "Richard",
  "Joseph",
  "Thomas",
  "Charles",
  "Christopher",
  "Daniel",
  "Matthew",
  "Anthony",
  "Mark",
  "Donald",
  "Steven",
  "Paul",
  "Andrew",
  "Joshua",
  "Kenneth",
  "Kevin",
  "Brian",
  "George",
  "Timothy",
  "Ronald",
  "Edward",
  "Jason",
  "Jeffrey",
  "Ryan",
  "Jacob",
  "Gary",
  "Nicholas",
  "Eric",
  "Jonathan",
  "Stephen",
  "Larry",
  "Justin",
  "Scott",
  "Brandon",
  "Benjamin",
  "Samuel",
  "Raymond",
  "Gregory",
  "Frank",
  "Alexander",
  "Patrick",
  "Jack",
  "Dennis",
  "Jerry",
  "Tyler",
  "Aaron",
  "Jose",
  "Adam",
  "Nathan",
  "Henry",
  "Zachary",
  "Douglas",
  "Peter",
  "Kyle",
  "Noah",
  "Ethan",
  "Jeremy",
  "Walter",
  "Christian",
  "Keith",
  "Roger",
  "Terry",
  "Austin",
  "Sean",
  "Gerald",
  "Carl",
  "Harold",
  "Dylan",
  "Arthur",
  "Lawrence",
  "Jordan",
  "Jesse",
  "Bryan",
  "Billy",
  "Bruce",
  "Gabriel",
  "Joe",
  "Logan",
  "Alan",
  "Juan",
  "Albert",
  "Elijah",
  "Wayne",
  "Randy",
  "Vincent",
  "Mason",
  "Roy",
  "Ralph",
  "Russell",
  "Bradley",
  "Philip",
  "Eugene",
  "Louis",
  "Caleb",
  "Hunter",
  "Connor",
  "Aidan",
  "Ian",
  "Cameron",
  "Owen",
  "Luke",
  "Isaac",
  "Wesley",
  "Carlos",
  "Miguel",
  "Antonio",
  "Victor",
  "Marcus",
  "Travis",
  "Cole",
  "Blake",
  "Shawn",
  "Trevor",
  "Spencer",
  "Devin",
  "Colin",
  "Drew",
  "Grant",
  "Theodore",
  "Oliver",
  "Liam",
  "Lucas",
  "Nathaniel",
  "Adrian",
  "Dean",
  "Derek",
  "Evan",
  "Fred",
  "Harry",
  "Hayden",
  "Leo",
  "Brad",
  // 女性常见名
  "Mary",
  "Patricia",
  "Jennifer",
  "Linda",
  "Barbara",
  "Elizabeth",
  "Susan",
  "Jessica",
  "Sarah",
  "Karen",
  "Lisa",
  "Nancy",
  "Betty",
  "Margaret",
  "Sandra",
  "Ashley",
  "Dorothy",
  "Kimberly",
  "Emily",
  "Donna",
  "Michelle",
  "Carol",
  "Amanda",
  "Melissa",
  "Deborah",
  "Stephanie",
  "Rebecca",
  "Sharon",
  "Laura",
  "Cynthia",
  "Kathleen",
  "Amy",
  "Angela",
  "Shirley",
  "Anna",
  "Brenda",
  "Pamela",
  "Emma",
  "Nicole",
  "Helen",
  "Samantha",
  "Katherine",
  "Christine",
  "Debra",
  "Rachel",
  "Carolyn",
  "Janet",
  "Catherine",
  "Maria",
  "Heather",
  "Diane",
  "Olivia",
  "Julie",
  "Joyce",
  "Victoria",
  "Kelly",
  "Christina",
  "Joan",
  "Evelyn",
  "Lauren",
  "Judith",
  "Megan",
  "Cheryl",
  "Andrea",
  "Hannah",
  "Martha",
  "Jacqueline",
  "Frances",
  "Gloria",
  "Ann",
  "Teresa",
  "Kathryn",
  "Sophia",
  "Madison",
  "Abigail",
  "Grace",
  "Natalie",
  "Brittany",
  "Danielle",
  "Sara",
  "Alexis",
  "Isabella",
  "Mia",
  "Charlotte",
  "Amelia",
  "Ava",
  "Chloe",
  "Ella",
  "Avery",
  "Sofia",
  "Aria",
  "Scarlett",
  "Allison",
  "Audrey",
  "Brooke",
  "Claire",
  "Lily",
  "Zoe",
  "Leah",
  "Hailey",
  "Paige",
  "Vanessa",
  "Alice",
  "Amber",
  "Aubrey",
  "Beverly",
  "Dawn",
  "Diana",
  "Holly",
  "Julia",
  "Kayla",
  "Lucy",
  "Lydia",
  "Molly",
  "Nora",
  "Riley",
  "Tammy",
  "Tina",
  "Valerie",
  "Wendy"
];
const LAST_NAMES = [
  "Smith",
  "Johnson",
  "Williams",
  "Brown",
  "Jones",
  "Garcia",
  "Miller",
  "Davis",
  "Rodriguez",
  "Martinez",
  "Hernandez",
  "Lopez",
  "Gonzalez",
  "Wilson",
  "Anderson",
  "Thomas",
  "Taylor",
  "Moore",
  "Jackson",
  "Martin",
  "Lee",
  "Perez",
  "Thompson",
  "White",
  "Harris",
  "Sanchez",
  "Clark",
  "Ramirez",
  "Lewis",
  "Robinson",
  "Walker",
  "Young",
  "Allen",
  "King",
  "Wright",
  "Scott",
  "Torres",
  "Nguyen",
  "Hill",
  "Flores",
  "Green",
  "Adams",
  "Nelson",
  "Baker",
  "Hall",
  "Rivera",
  "Campbell",
  "Mitchell",
  "Carter",
  "Roberts",
  "Gomez",
  "Phillips",
  "Evans",
  "Turner",
  "Diaz",
  "Parker",
  "Cruz",
  "Edwards",
  "Collins",
  "Reyes",
  "Stewart",
  "Morris",
  "Morales",
  "Murphy",
  "Cook",
  "Rogers",
  "Gutierrez",
  "Ortiz",
  "Morgan",
  "Cooper",
  "Peterson",
  "Bailey",
  "Reed",
  "Kelly",
  "Howard",
  "Ramos",
  "Kim",
  "Cox",
  "Ward",
  "Richardson",
  "Watson",
  "Brooks",
  "Chavez",
  "Wood",
  "James",
  "Bennett",
  "Gray",
  "Mendoza",
  "Ruiz",
  "Hughes",
  "Price",
  "Alvarez",
  "Castillo",
  "Sanders",
  "Patel",
  "Myers",
  "Long",
  "Ross",
  "Foster",
  "Jimenez",
  "Powell",
  "Jenkins",
  "Perry",
  "Russell",
  "Sullivan",
  "Bell",
  "Coleman",
  "Butler",
  "Henderson",
  "Barnes",
  "Gonzales",
  "Fisher",
  "Vasquez",
  "Simmons",
  "Romero",
  "Jordan",
  "Patterson",
  "Alexander",
  "Hamilton",
  "Graham",
  "Reynolds",
  "Griffin",
  "Wallace",
  "Moreno",
  "West",
  "Cole",
  "Hayes",
  "Bryant",
  "Herrera",
  "Gibson",
  "Ellis",
  "Tran",
  "Medina",
  "Aguilar",
  "Stevens",
  "Murray",
  "Ford",
  "Castro",
  "Marshall",
  "Owens",
  "Harrison",
  "Fernandez",
  "Mcdonald",
  "Woods",
  "Washington",
  "Kennedy",
  "Wells",
  "Vargas",
  "Henry",
  "Chen",
  "Freeman",
  "Webb",
  "Tucker",
  "Guzman",
  "Burns",
  "Crawford",
  "Olson",
  "Simpson",
  "Porter",
  "Hunter",
  "Gordon",
  "Mendez",
  "Silva",
  "Shaw",
  "Snyder",
  "Mason",
  "Dixon",
  "Munoz",
  "Hunt",
  "Hicks",
  "Holmes",
  "Palmer",
  "Wagner",
  "Black",
  "Robertson",
  "Boyd",
  "Rose",
  "Stone",
  "Salazar",
  "Fox",
  "Warren",
  "Mills",
  "Meyer",
  "Rice",
  "Schmidt",
  "Garza",
  "Daniels",
  "Ferguson",
  "Nichols",
  "Stephens",
  "Soto",
  "Weaver",
  "Ryan",
  "Gardner",
  "Payne",
  "Grant",
  "Dunn",
  "Kelley",
  "Spencer",
  "Hawkins",
  "Arnold",
  "Pierce",
  "Vazquez",
  "Hansen",
  "Peters",
  "Santos",
  "Hart"
];
const NICKNAMES = [
  "mike",
  "dave",
  "chris",
  "alex",
  "sam",
  "jess",
  "kate",
  "tom",
  "nick",
  "joe",
  "dan",
  "matt",
  "rob",
  "will",
  "ben",
  "jen",
  "liz",
  "beth",
  "andy",
  "tony",
  "jim",
  "bob",
  "rick",
  "steve",
  "greg",
  "ken",
  "charlie",
  "jack",
  "jake",
  "max",
  "gabe",
  "nate",
  "zach",
  "josh",
  "tim",
  "pat",
  "vince",
  "leo",
  "ray",
  "gene",
  "marty",
  "phil",
  "pete",
  "randy",
  "russ",
  "abby",
  "allie",
  "becky",
  "bella",
  "cassie",
  "cathy",
  "debbie",
  "ellie",
  "gabby",
  "gracie",
  "izzy",
  "josie",
  "katie",
  "lucy",
  "maggie",
  "mandy",
  "meg",
  "mel",
  "millie",
  "nina",
  "patty",
  "penny",
  "rosie",
  "sadie",
  "sally",
  "sandy",
  "sue",
  "tess",
  "val",
  "vicky",
  "wendy"
];
function randInt$2(max) {
  return Math.floor(Math.random() * max);
}
function pick$1(arr) {
  return arr[randInt$2(arr.length)];
}
function randomLetters() {
  const n = 1 + randInt$2(2);
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(97 + randInt$2(26));
  return s;
}
function randomFullName() {
  const first = pick$1(FIRST_NAMES);
  const last = pick$1(LAST_NAMES);
  if (Math.random() < 0.18) {
    const mid = String.fromCharCode(65 + randInt$2(26));
    return `${first} ${mid}. ${last}`;
  }
  return `${first} ${last}`;
}
function randomEmailPrefix() {
  const first = pick$1(FIRST_NAMES).toLowerCase();
  const last = pick$1(LAST_NAMES).toLowerCase();
  const middle = pick$1(FIRST_NAMES).toLowerCase();
  const last2 = pick$1(LAST_NAMES).toLowerCase();
  const nick = pick$1(NICKNAMES);
  const fi = first.charAt(0);
  const mi = middle.charAt(0);
  const li = last.charAt(0);
  const r = Math.random();
  if (r < 0.72) {
    const s = pick$1([".", ".", ".", "_"]);
    return pick$1([
      `${first}${s}${middle}${s}${last}`,
      // john.michael.smith
      `${first}${s}${mi}${s}${last}`,
      // john.m.smith
      `${first}${mi}${s}${last}`,
      // johnm.smith
      `${first}${s}${last}${s}${last2}`,
      // john.smith.brown（双姓）
      `${fi}${s}${middle}${s}${last}`,
      // j.michael.smith
      `${first}${s}${middle}`,
      // john.michael
      `${middle}${s}${last}`,
      // michael.smith
      `${nick}${s}${middle}${s}${last}`
      // mike.john.smith
    ]);
  }
  if (r < 0.9) {
    const base = pick$1([
      `${first}${last}`,
      `${first}.${last}`,
      `${fi}${last}`,
      `${first}${li}`,
      `${nick}${last}`,
      `${last}${fi}`
    ]);
    return `${base}${randomLetters()}`;
  }
  return pick$1([
    `${first}.${last}`,
    `${first}${last}`,
    `${nick}.${last}`,
    `${first}.${middle}.${last}`
  ]);
}
const LSUBID_PREFIXES = ["X10", "X19", "X42", "X55", "X73", "X81", "X96"];
const GPU_CONFIGS = [
  {
    vendor: "Google Inc. (Intel)",
    model: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x000046A6) Direct3D11 vs_5_0 ps_5_0, D3D11)"
  },
  {
    vendor: "Google Inc. (Intel)",
    model: "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)"
  },
  {
    vendor: "Google Inc. (Intel)",
    model: "ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)"
  },
  {
    vendor: "Google Inc. (Intel)",
    model: "ANGLE (Intel, Intel(R) UHD Graphics 730 Direct3D11 vs_5_0 ps_5_0, D3D11)"
  },
  {
    vendor: "Google Inc. (Intel)",
    model: "ANGLE (Intel, Intel(R) HD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)"
  },
  {
    vendor: "Google Inc. (Intel)",
    model: "ANGLE (Intel, Intel(R) HD Graphics 530 Direct3D11 vs_5_0 ps_5_0, D3D11)"
  },
  {
    vendor: "Google Inc. (Intel)",
    model: "ANGLE (Intel, Intel(R) Iris(R) Plus Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)"
  },
  {
    vendor: "Google Inc. (NVIDIA)",
    model: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB Direct3D11 vs_5_0 ps_5_0, D3D11)"
  },
  {
    vendor: "Google Inc. (NVIDIA)",
    model: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)"
  },
  {
    vendor: "Google Inc. (NVIDIA)",
    model: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)"
  },
  {
    vendor: "Google Inc. (NVIDIA)",
    model: "ANGLE (NVIDIA, NVIDIA GeForce RTX 2060 Direct3D11 vs_5_0 ps_5_0, D3D11)"
  },
  {
    vendor: "Google Inc. (NVIDIA)",
    model: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)"
  },
  {
    vendor: "Google Inc. (NVIDIA)",
    model: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)"
  },
  {
    vendor: "Google Inc. (NVIDIA)",
    model: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)"
  },
  {
    vendor: "Google Inc. (NVIDIA)",
    model: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)"
  },
  {
    vendor: "Google Inc. (NVIDIA)",
    model: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0, D3D11)"
  },
  {
    vendor: "Google Inc. (NVIDIA)",
    model: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)"
  },
  {
    vendor: "Google Inc. (AMD)",
    model: "ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)"
  },
  {
    vendor: "Google Inc. (AMD)",
    model: "ANGLE (AMD, AMD Radeon RX 6600 XT Direct3D11 vs_5_0 ps_5_0, D3D11)"
  },
  {
    vendor: "Google Inc. (AMD)",
    model: "ANGLE (AMD, AMD Radeon RX 5700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)"
  },
  {
    vendor: "Google Inc. (AMD)",
    model: "ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)"
  },
  {
    vendor: "Google Inc. (AMD)",
    model: "ANGLE (AMD, AMD Radeon RX 570 Direct3D11 vs_5_0 ps_5_0, D3D11)"
  }
];
const SCREEN_CONFIGS = [
  [1920, 1080, 1920, 1040, 24],
  [2560, 1440, 2560, 1400, 24],
  [1920, 1200, 1920, 1160, 24],
  [1366, 768, 1366, 728, 24],
  [1536, 864, 1536, 824, 24],
  [1680, 1050, 1680, 1010, 24],
  [1440, 900, 1440, 860, 24],
  [1600, 900, 1600, 860, 24],
  [2560, 1080, 2560, 1040, 24],
  [3440, 1440, 3440, 1400, 24],
  [3840, 2160, 3840, 2120, 24],
  [1280, 1024, 1280, 984, 24]
];
const MATH_POOL = [
  { tan: "-1.4214488238747245", sin: "0.8178819121159085", cos: "-0.5753861119575491" },
  { tan: "-1.4214488238747245", sin: "0.8178819121159085", cos: "-0.5765775004286854" },
  { tan: "-1.4214488238747243", sin: "0.8178819121159083", cos: "-0.5753861119575489" },
  { tan: "-1.4214488238747247", sin: "0.8178819121159087", cos: "-0.5753861119575493" },
  { tan: "-1.4214488238747244", sin: "0.8178819121159084", cos: "-0.5765775004286855" },
  { tan: "-1.4214488238747246", sin: "0.8178819121159086", cos: "-0.5753861119575490" },
  { tan: "-1.4214488238747242", sin: "0.8178819121159082", cos: "-0.5765775004286853" },
  { tan: "-1.4214488238747248", sin: "0.8178819121159088", cos: "-0.5753861119575492" },
  { tan: "-1.4214488238747241", sin: "0.8178819121159081", cos: "-0.5765775004286852" },
  { tan: "-1.4214488238747249", sin: "0.8178819121159089", cos: "-0.5753861119575494" }
];
const WEBGL_EXT_CORE = [
  "ANGLE_instanced_arrays",
  "EXT_blend_minmax",
  "EXT_color_buffer_half_float",
  "EXT_float_blend",
  "EXT_frag_depth",
  "EXT_shader_texture_lod",
  "EXT_texture_filter_anisotropic",
  "EXT_sRGB",
  "KHR_parallel_shader_compile",
  "OES_element_index_uint",
  "OES_fbo_render_mipmap",
  "OES_standard_derivatives",
  "OES_texture_float",
  "OES_texture_float_linear",
  "OES_texture_half_float",
  "OES_texture_half_float_linear",
  "OES_vertex_array_object",
  "WEBGL_color_buffer_float",
  "WEBGL_compressed_texture_s3tc",
  "WEBGL_compressed_texture_s3tc_srgb",
  "WEBGL_debug_renderer_info",
  "WEBGL_debug_shaders",
  "WEBGL_depth_texture",
  "WEBGL_draw_buffers",
  "WEBGL_lose_context",
  "WEBGL_multi_draw"
];
const WEBGL_EXT_OPTIONAL = [
  "EXT_disjoint_timer_query",
  "EXT_texture_compression_bptc",
  "EXT_texture_compression_rgtc",
  "WEBGL_compressed_texture_astc",
  "WEBGL_compressed_texture_etc",
  "OES_draw_buffers_indexed",
  "EXT_color_buffer_float"
];
const PLUGINS_POOL = [
  { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
  {
    name: "Chrome PDF Viewer",
    filename: "internal-pdf-viewer",
    description: "Portable Document Format"
  },
  {
    name: "Chromium PDF Viewer",
    filename: "internal-pdf-viewer",
    description: "Portable Document Format"
  },
  {
    name: "Microsoft Edge PDF Viewer",
    filename: "internal-pdf-viewer",
    description: "Portable Document Format"
  },
  {
    name: "WebKit built-in PDF",
    filename: "internal-pdf-viewer",
    description: "Portable Document Format"
  }
];
function randInt$1(max) {
  return Math.floor(Math.random() * max);
}
function pick(arr) {
  return arr[randInt$1(arr.length)];
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt$1(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function generateCanvasData() {
  const bins = new Array(256).fill(0);
  const totalSamples = 36e3;
  bins[0] = 1e4 + randInt$1(5001);
  bins[255] = 12e3 + randInt$1(4001);
  const colorPeaks = [
    [255, 400 + randInt$1(301)],
    [165, 200 + randInt$1(201)],
    [0, 300 + randInt$1(301)],
    [128, 100 + randInt$1(201)],
    [64, 50 + randInt$1(101)],
    [192, 80 + randInt$1(121)],
    [32, 30 + randInt$1(71)],
    [224, 60 + randInt$1(121)]
  ];
  for (const [idx, val] of colorPeaks) bins[idx] = val;
  let remaining = totalSamples - bins.reduce((a, b) => a + b, 0);
  for (let i = 1; i < 255; i++) {
    if (bins[i] === 0 && remaining > 0) {
      const v = Math.min(4 + randInt$1(97), remaining);
      bins[i] = v;
      remaining -= v;
    }
  }
  bins[0] += remaining;
  const raw = Buffer.alloc(256 * 4);
  for (let i = 0; i < 256; i++) raw.writeUInt32LE(bins[i], i * 4);
  const digest = crypto.createHash("sha256").update(raw).digest();
  const hash = digest.readInt32LE(0);
  return { hash, histogram: bins };
}
function randomChromeVersion() {
  const versions = [
    { major: 137, buildMin: 7151, buildMax: 7160 },
    { major: 138, buildMin: 7204, buildMax: 7213 },
    { major: 139, buildMin: 7259, buildMax: 7268 },
    { major: 140, buildMin: 7316, buildMax: 7325 },
    { major: 141, buildMin: 7371, buildMax: 7380 },
    { major: 142, buildMin: 7430, buildMax: 7439 },
    { major: 143, buildMin: 7485, buildMax: 7494 },
    { major: 144, buildMin: 7544, buildMax: 7553 },
    { major: 145, buildMin: 7601, buildMax: 7610 },
    { major: 146, buildMin: 7660, buildMax: 7669 }
  ];
  const v = versions[Math.floor(Math.random() * versions.length)];
  const build = v.buildMin + Math.floor(Math.random() * (v.buildMax - v.buildMin + 1));
  const patch = Math.floor(Math.random() * 150);
  return `${v.major}.0.${build}.${patch}`;
}
function randomIdentity() {
  const chromeVer = randomChromeVersion();
  const gpu = pick(GPU_CONFIGS);
  const scr = pick(SCREEN_CONFIGS);
  const math = pick(MATH_POOL);
  const { hash: canvasHash, histogram } = generateCanvasData();
  const exts = [...WEBGL_EXT_CORE];
  const nOpt = randInt$1(5);
  if (nOpt > 0) {
    const perm = shuffle([...Array(WEBGL_EXT_OPTIONAL.length).keys()]);
    for (let i = 0; i < Math.min(nOpt, WEBGL_EXT_OPTIONAL.length); i++) {
      exts.push(WEBGL_EXT_OPTIONAL[perm[i]]);
    }
  }
  exts.sort();
  const plugins = shuffle([...PLUGINS_POOL]);
  return {
    chromeVer,
    ua: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`,
    gpuVendor: gpu.vendor,
    gpuModel: gpu.model,
    webGLExts: exts,
    canvasHash,
    histogramBase: histogram,
    mathTan: math.tan,
    mathSin: math.sin,
    mathCos: math.cos,
    plugins,
    screen: {
      width: scr[0],
      height: scr[1],
      availWidth: scr[2],
      availHeight: scr[3],
      colorDepth: scr[4]
    },
    lsubidPrefixSignin: pick(LSUBID_PREFIXES),
    lsubidPrefixProfile: pick(LSUBID_PREFIXES),
    webpackHash: randInt$1(2147483647).toString(16).padStart(10, "0").slice(0, 10)
  };
}
function parseChainProxy(url) {
  try {
    const u = new URL(url);
    const proto = u.protocol.replace(":", "").toLowerCase();
    let protocol;
    if (proto === "http") protocol = "http";
    else if (proto === "https") protocol = "https";
    else if (proto === "socks5" || proto === "socks5h" || proto === "socks") protocol = "socks5";
    else if (proto === "socks4" || proto === "socks4a") protocol = "socks4";
    else return null;
    const port = Number(u.port) || (protocol.startsWith("socks") ? 1080 : 8080);
    if (!u.hostname) return null;
    return {
      protocol,
      host: u.hostname,
      port,
      username: u.username ? decodeURIComponent(u.username) : void 0,
      password: u.password ? decodeURIComponent(u.password) : void 0
    };
  } catch {
    return null;
  }
}
class ChainProxyRelay {
  server = null;
  /** 跟踪所有活跃的入站连接，stop() 时强制销毁，避免 server.close() 等 Keep-Alive 超时（~60s）*/
  sockets = /* @__PURE__ */ new Set();
  upstream;
  target;
  log;
  port = 0;
  constructor(upstreamUrl, targetUrl, log) {
    const up = parseChainProxy(upstreamUrl);
    const tg = parseChainProxy(targetUrl);
    if (!up) throw new Error(`上游中转代理无效: ${upstreamUrl}`);
    if (!tg) throw new Error(`目标代理无效: ${targetUrl}`);
    this.upstream = up;
    this.target = tg;
    this.log = log || (() => {
    });
  }
  /** 启动本地中继，返回可直接作为代理使用的 http://127.0.0.1:port */
  start() {
    return new Promise((resolve, reject) => {
      const server = net.createServer((client) => this.handleClient(client));
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
          this.server = server;
          server.removeListener("error", reject);
          resolve(`http://127.0.0.1:${this.port}`);
        } else {
          reject(new Error("本地中继启动失败：无法获取端口"));
        }
      });
    });
  }
  stop() {
    return new Promise((resolve) => {
      const srv = this.server;
      this.server = null;
      for (const sock of this.sockets) {
        try {
          sock.destroy();
        } catch {
        }
      }
      this.sockets.clear();
      if (!srv) {
        resolve();
        return;
      }
      srv.close(() => resolve());
      setTimeout(resolve, 500);
    });
  }
  handleClient(client) {
    this.sockets.add(client);
    client.on("close", () => this.sockets.delete(client));
    client.on("error", () => client.destroy());
    client.once("data", (chunk) => {
      const head = chunk.toString("latin1");
      const m = head.match(/^CONNECT\s+([^\s:]+):(\d+)\s+HTTP\/1\.[01]/i);
      if (!m) {
        client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
        return;
      }
      const host = m[1];
      const port = Number(m[2]);
      this.dialChain(host, port).then((tunnel) => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        client.pipe(tunnel);
        tunnel.pipe(client);
        client.on("close", () => tunnel.destroy());
        tunnel.on("close", () => client.destroy());
        tunnel.on("error", () => {
          client.destroy();
          tunnel.destroy();
        });
      }).catch((err) => {
        this.log(`[ProxyChain] 隧道建立失败: ${err instanceof Error ? err.message : String(err)}`);
        if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      });
    });
  }
  /** 经上游中转连到目标代理入口，再在该连接上对目标代理做 CONNECT 抵达最终目标 */
  async dialChain(host, port) {
    const sock = await this.connectViaUpstream(this.target.host, this.target.port);
    try {
      const resp = await this.sendConnectRequest(sock, host, port, this.target);
      if (resp.status !== 200) {
        throw new Error(this.formatConnectError("目标代理", resp));
      }
    } catch (err) {
      sock.destroy();
      throw err;
    }
    return sock;
  }
  connectViaUpstream(host, port) {
    if (this.upstream.protocol === "socks5" || this.upstream.protocol === "socks4") {
      return this.connectViaSocks(host, port);
    }
    return this.connectViaHttpUpstream(host, port);
  }
  connectViaHttpUpstream(host, port) {
    return new Promise((resolve, reject) => {
      const sock = net.connect(this.upstream.port, this.upstream.host);
      sock.setTimeout(2e4);
      sock.once("timeout", () => {
        sock.destroy();
        reject(new Error("上游中转连接超时"));
      });
      sock.once("error", reject);
      sock.once("connect", () => {
        sock.setNoDelay(true);
        this.sendConnectRequest(sock, host, port, this.upstream).then((resp) => {
          sock.setTimeout(0);
          if (resp.status === 200) resolve(sock);
          else {
            sock.destroy();
            reject(new Error(this.formatConnectError("上游中转", resp)));
          }
        }).catch((err) => {
          sock.destroy();
          reject(err);
        });
      });
    });
  }
  connectViaSocks(host, port) {
    return new Promise((resolve, reject) => {
      void socks.SocksClient.createConnection({
        proxy: {
          host: this.upstream.host,
          port: this.upstream.port,
          type: this.upstream.protocol === "socks4" ? 4 : 5,
          userId: this.upstream.username,
          password: this.upstream.password
        },
        command: "connect",
        destination: { host, port },
        timeout: 2e4
      }).then(({ socket }) => {
        socket.setTimeout(0);
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 3e4);
        resolve(socket);
      }).catch((err) => reject(err));
    });
  }
  /**
   * 通用 CONNECT：发送请求 + 解析响应。
   *
   * 关键容错：
   *   - 部分代理返回错误时只发状态行就 close，**不补 \r\n\r\n**（如 bestproxy 的 610），
   *     旧实现会等空行等到 FIN 触发 'end' 然后误报「代理连接被对端关闭」，错误状态码被丢。
   *     新实现：'end' 事件触发时若 buf 已含状态行，尽力解析；只有空 buf 才报「关闭」。
   *   - 附带常见兼容头（Proxy-Connection / User-Agent），减少代理服务端的策略性拒绝。
   */
  sendConnectRequest(sock, host, port, auth) {
    return new Promise((resolve, reject) => {
      const lines = [
        `CONNECT ${host}:${port} HTTP/1.1`,
        `Host: ${host}:${port}`,
        "Proxy-Connection: keep-alive",
        "User-Agent: Mozilla/5.0"
      ];
      if (auth.username) {
        const b64 = Buffer.from(`${auth.username}:${auth.password || ""}`).toString("base64");
        lines.push(`Proxy-Authorization: Basic ${b64}`);
      }
      const req = lines.join("\r\n") + "\r\n\r\n";
      this.readHttpResponse(sock).then(resolve, reject);
      sock.write(req);
    });
  }
  /** 读取 HTTP 响应：直到 \r\n\r\n 完整、或对端关闭/出错时尽力解析。返回结构化结果。 */
  readHttpResponse(sock) {
    return new Promise((resolve, reject) => {
      let buf = "";
      const cleanup = () => {
        sock.removeListener("data", onData);
        sock.removeListener("error", onErr);
        sock.removeListener("end", onEnd);
        sock.removeListener("close", onEnd);
      };
      const parse = (raw) => {
        const nlIdx = raw.indexOf("\r\n");
        if (nlIdx < 0) return null;
        const statusLine = raw.slice(0, nlIdx);
        const m = statusLine.match(/^HTTP\/1\.[01]\s+(\d{3})\s*(.*)$/);
        if (!m) return null;
        const status = Number(m[1]);
        const statusText = m[2] || "";
        const sep = raw.indexOf("\r\n\r\n");
        const headersEnd = sep >= 0 ? sep : raw.length;
        const headersRaw = raw.slice(nlIdx + 2, headersEnd);
        const bodySnippet = sep >= 0 ? raw.slice(sep + 4, sep + 4 + 200) : "";
        return { status, statusText, headersRaw, bodySnippet };
      };
      const finish = (raw, viaClose) => {
        cleanup();
        const parsed = parse(raw);
        if (parsed) {
          if (parsed.status === 200 && raw.indexOf("\r\n\r\n") >= 0) {
            const sep = raw.indexOf("\r\n\r\n");
            const rest = raw.slice(sep + 4);
            if (rest.length > 0) sock.unshift(Buffer.from(rest, "latin1"));
          }
          resolve(parsed);
        } else if (viaClose) {
          reject(
            new Error(
              raw ? `代理返回不可解析: ${raw.slice(0, 120)}` : "代理连接被对端关闭（无任何响应）"
            )
          );
        }
      };
      const onData = (d) => {
        buf += d.toString("latin1");
        const sep = buf.indexOf("\r\n\r\n");
        if (sep >= 0) finish(buf, false);
      };
      const onErr = (err) => {
        cleanup();
        reject(err);
      };
      const onEnd = () => finish(buf, true);
      sock.on("data", onData);
      sock.once("error", onErr);
      sock.once("end", onEnd);
      sock.once("close", onEnd);
    });
  }
  formatConnectError(stage, resp) {
    const suffix = resp.bodySnippet ? ` body=${resp.bodySnippet.replace(/[\r\n]/g, " ").slice(0, 120)}` : "";
    return `${stage} CONNECT 失败: HTTP ${resp.status} ${resp.statusText}${suffix}`;
  }
  /**
   * 分阶段诊断：
   *   A) 上游中转 TCP 连通
   *   B) 经上游 CONNECT 到目标代理入口
   *   C) 经完整链路 CONNECT 到 testHost:testPort
   * 不依赖本地 server，独立可用；定位问题精确到哪一层。
   */
  async diagnose(testHost = "www.gstatic.com", testPort = 443) {
    const result = { upstreamReachable: false, targetReachable: false };
    const t0 = Date.now();
    try {
      await this.tcpProbe(this.upstream.host, this.upstream.port, 8e3);
      result.upstreamReachable = true;
      result.upstreamRtMs = Date.now() - t0;
    } catch (err) {
      result.upstreamError = err instanceof Error ? err.message : String(err);
      return result;
    }
    const t1 = Date.now();
    let chainSock = null;
    try {
      chainSock = await this.connectViaUpstream(this.target.host, this.target.port);
      result.targetReachable = true;
      result.targetRtMs = Date.now() - t1;
    } catch (err) {
      result.targetError = err instanceof Error ? err.message : String(err);
      return result;
    }
    const t2 = Date.now();
    try {
      const resp = await this.sendConnectRequest(chainSock, testHost, testPort, this.target);
      result.targetStatus = resp.status;
      result.targetStatusText = resp.statusText;
      result.targetBodySnippet = resp.bodySnippet;
      result.endToEndOk = resp.status === 200;
      result.endToEndRtMs = Date.now() - t2;
      if (resp.status !== 200) {
        result.endToEndError = `目标代理拒绝: HTTP ${resp.status} ${resp.statusText}`;
      }
    } catch (err) {
      result.endToEndOk = false;
      result.endToEndError = err instanceof Error ? err.message : String(err);
    } finally {
      chainSock.destroy();
    }
    return result;
  }
  tcpProbe(host, port, timeoutMs) {
    return new Promise((resolve, reject) => {
      const sock = net.connect(port, host);
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`TCP 连接超时 ${host}:${port}`));
      }, timeoutMs);
      sock.once("connect", () => {
        clearTimeout(timer);
        sock.destroy();
        resolve();
      });
      sock.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}
const DELTA = 2654435769 >>> 0;
const FALLBACK_KEY = [
  1888420705,
  2576816180,
  2347232058,
  874813317
];
const FALLBACK_VER = "4.0.0";
const FALLBACK_IDENTIFIER = "ECdITeCs";
let cachedKey = null;
let cachedVersion = "";
let cachedIdentifier = "";
let refreshPromise = null;
function extractFromAppJS(js) {
  let key = null;
  let identifier = "";
  let version = "";
  const keyMatch = js.match(
    /var\s+\w+\s*=\s*\[(\d+),\s*"([A-Za-z0-9]+)",\s*(\d+),\s*(\d+),\s*(\d+)\]/
  );
  if (keyMatch) {
    const nums = [keyMatch[1], keyMatch[3], keyMatch[4], keyMatch[5]].map(Number);
    key = [nums[2], nums[0], nums[3], nums[1]];
    identifier = keyMatch[2];
  }
  const verMatch = js.match(/FWCIM_VERSION\s*=\s*"(\d+\.\d+\.\d+)"/);
  if (verMatch) {
    version = verMatch[1];
  }
  return { key, identifier, version };
}
async function refreshAppJSConfig(fetchFn) {
  if (cachedKey) return;
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    if (cachedKey) return;
    try {
      const resp = await fetchFn("https://us-east-1.signin.aws/assets/js/app.js", {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
          Accept: "*/*",
          Referer: "https://us-east-1.signin.aws/"
        }
      });
      const js = await resp.text();
      if (js) {
        const result = extractFromAppJS(js);
        if (result.key) cachedKey = result.key;
        if (result.identifier) cachedIdentifier = result.identifier;
        if (result.version) cachedVersion = result.version;
      }
    } catch (err) {
      console.log("[xxtea] 下载 app.js 失败:", err);
    }
    if (!cachedKey) {
      console.log("[xxtea] 使用 fallback 密钥");
      cachedKey = [...FALLBACK_KEY];
    }
    if (!cachedVersion) cachedVersion = FALLBACK_VER;
    if (!cachedIdentifier) cachedIdentifier = FALLBACK_IDENTIFIER;
  })();
  return refreshPromise;
}
function getTESVersion() {
  return cachedVersion || FALLBACK_VER;
}
function getIdentifier() {
  return cachedIdentifier || FALLBACK_IDENTIFIER;
}
function getActiveKey() {
  return cachedKey ? [...cachedKey] : [...FALLBACK_KEY];
}
function xxteaEncryptCore(plaintext, key) {
  if (!plaintext.length) return Buffer.alloc(0);
  const n = Math.ceil(plaintext.length / 4);
  const v = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0;
    if (4 * i < plaintext.length) b0 = plaintext.charCodeAt(4 * i);
    if (4 * i + 1 < plaintext.length) b1 = plaintext.charCodeAt(4 * i + 1);
    if (4 * i + 2 < plaintext.length) b2 = plaintext.charCodeAt(4 * i + 2);
    if (4 * i + 3 < plaintext.length) b3 = plaintext.charCodeAt(4 * i + 3);
    v[i] = (b0 | b1 << 8 | b2 << 16 | b3 << 24) >>> 0;
  }
  const rounds = 6 + Math.floor(52 / n);
  let z = v[n - 1];
  let total = 0;
  for (let r = 0; r < rounds; r++) {
    total = total + DELTA >>> 0;
    const e = total >>> 2 & 3;
    for (let p = 0; p < n; p++) {
      const y = v[(p + 1) % n];
      const part1 = (z >>> 5 ^ y << 2) >>> 0;
      const part2 = (y >>> 3 ^ z << 4) >>> 0;
      const group1 = part1 + part2 >>> 0;
      const part3 = (total ^ y) >>> 0;
      const part4 = (key[p & 3 ^ e] ^ z) >>> 0;
      const group2 = part3 + part4 >>> 0;
      const mx = (group1 ^ group2) >>> 0;
      v[p] = v[p] + mx >>> 0;
      z = v[p];
    }
  }
  const result = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    result[4 * i] = v[i] & 255;
    result[4 * i + 1] = v[i] >>> 8 & 255;
    result[4 * i + 2] = v[i] >>> 16 & 255;
    result[4 * i + 3] = v[i] >>> 24 & 255;
  }
  return result;
}
function encryptFingerprint(jsonStr) {
  const crc = crc32(jsonStr);
  const crcHex = crc.toString(16).toUpperCase().padStart(8, "0");
  const plaintext = crcHex + "#" + jsonStr;
  const key = getActiveKey();
  const encrypted = xxteaEncryptCore(plaintext, key);
  const encoded = encrypted.toString("base64");
  return getIdentifier() + ":" + encoded;
}
function crc32(str) {
  const table = crc32Table();
  let crc = 4294967295 >>> 0;
  for (let i = 0; i < str.length; i++) {
    crc = (crc >>> 8 ^ table[(crc ^ str.charCodeAt(i)) & 255]) >>> 0;
  }
  return (crc ^ 4294967295) >>> 0;
}
let _crc32Table = null;
function crc32Table() {
  if (_crc32Table) return _crc32Table;
  _crc32Table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i >>> 0;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? (3988292384 ^ c >>> 1) >>> 0 : c >>> 1;
    }
    _crc32Table[i] = c;
  }
  return _crc32Table;
}
function randInt(max) {
  return Math.floor(Math.random() * max);
}
function crc32Str(str) {
  let crc = 4294967295 >>> 0;
  const table = getCrc32Table();
  for (let i = 0; i < str.length; i++) {
    crc = (crc >>> 8 ^ table[(crc ^ str.charCodeAt(i)) & 255]) >>> 0;
  }
  return (crc ^ 4294967295) >>> 0;
}
let _t = null;
function getCrc32Table() {
  if (_t) return _t;
  _t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i >>> 0;
    for (let j = 0; j < 8; j++) c = c & 1 ? (3988292384 ^ c >>> 1) >>> 0 : c >>> 1;
    _t[i] = c;
  }
  return _t;
}
class OrderedMap {
  keys = [];
  values = /* @__PURE__ */ new Map();
  set(key, value) {
    if (!this.values.has(key)) this.keys.push(key);
    this.values.set(key, value);
  }
  toJSON() {
    const parts = [];
    for (const k of this.keys) {
      parts.push(`${JSON.stringify(k)}:${JSON.stringify(this.values.get(k))}`);
    }
    return `{${parts.join(",")}}`;
  }
}
function newFPContext(identity) {
  const ts = Math.floor(Date.now() / 1e3);
  return {
    identity,
    canvasHash: identity.canvasHash,
    histogramBins: [...identity.histogramBase],
    lsUbidSignin: `${identity.lsubidPrefixSignin}-${String(randInt(1e7)).padStart(7, "0")}-${String(randInt(1e7)).padStart(7, "0")}:${ts}`,
    lsUbidProfile: "",
    perfTiming: null,
    startTime: null
  };
}
function resetPerfTiming(ctx) {
  ctx.perfTiming = null;
}
function genPerfTiming(nowMs) {
  const loadEventEnd = nowMs - (500 + randInt(1001));
  const loadDuration = 2e3 + randInt(2001);
  const base = loadEventEnd - loadDuration;
  const dnsOffset = 2 + randInt(8);
  const connectEndOffset = 300 + randInt(300);
  const responseOffset = connectEndOffset + 200 + randInt(400);
  const domInteractiveOffset = loadDuration - (5 + randInt(11));
  const domContentLoadedStart = domInteractiveOffset + randInt(3);
  return {
    connectStart: base + dnsOffset + 1 + randInt(3),
    secureConnectionStart: base + dnsOffset + 3 + randInt(5),
    unloadEventEnd: 0,
    domainLookupStart: base + dnsOffset,
    domainLookupEnd: base + dnsOffset + randInt(2),
    responseStart: base + responseOffset,
    connectEnd: base + connectEndOffset,
    responseEnd: base + responseOffset + randInt(5),
    requestStart: base + connectEndOffset,
    domLoading: base + responseOffset + 2 + randInt(5),
    redirectStart: 0,
    loadEventEnd,
    domComplete: loadEventEnd,
    navigationStart: base,
    loadEventStart: loadEventEnd,
    domContentLoadedEventEnd: loadEventEnd,
    unloadEventStart: 0,
    redirectEnd: 0,
    domInteractive: base + domInteractiveOffset,
    fetchStart: base + dnsOffset,
    domContentLoadedEventStart: base + domContentLoadedStart
  };
}
function getPerfTiming(ctx, nowMs) {
  if (!ctx.perfTiming) ctx.perfTiming = genPerfTiming(nowMs);
  return ctx.perfTiming;
}
function getLsUbid(ctx, pageType) {
  if (pageType === "profile") {
    if (!ctx.lsUbidProfile) {
      const ts = ctx.perfTiming ? Math.floor(ctx.perfTiming.loadEventEnd / 1e3) : Math.floor(Date.now() / 1e3);
      ctx.lsUbidProfile = `${ctx.identity.lsubidPrefixProfile}-${String(randInt(1e7)).padStart(7, "0")}-${String(randInt(1e7)).padStart(7, "0")}:${ts}`;
    }
    return ctx.lsUbidProfile;
  }
  return ctx.lsUbidSignin;
}
function getStartTime(ctx, nowMs) {
  if (ctx.startTime === null) ctx.startTime = nowMs;
  return ctx.startTime;
}
function genMetricsFirstLoad(pageType) {
  const m = {
    el: 0,
    script: 0,
    h: 0,
    batt: 0,
    perf: 0,
    auto: 0,
    tz: 0,
    fp2: 0,
    lsubid: 0,
    browser: 0,
    capabilities: 0,
    gpu: 0,
    dnt: 0,
    math: 0,
    tts: 0,
    input: 0,
    canvas: 0,
    captchainput: 0,
    pow: 0
  };
  switch (pageType) {
    case "profile":
      m.batt = 5 + randInt(21);
      m.fp2 = 1 + randInt(8);
      m.browser = randInt(4);
      m.capabilities = 1 + randInt(8);
      m.dnt = randInt(4);
      m.input = 8 + randInt(23);
      m.canvas = 5 + randInt(16);
      break;
    case "signup":
      m.script = randInt(3);
      m.batt = randInt(6);
      m.fp2 = randInt(4);
      m.gpu = 3 + randInt(6);
      break;
    default:
      m.script = randInt(3);
      m.auto = randInt(3);
      m.browser = randInt(3);
      m.gpu = 3 + randInt(6);
  }
  return m;
}
function genMetricsPageSubmit() {
  return {
    el: 0,
    script: 0,
    h: 0,
    batt: 0,
    perf: randInt(3),
    auto: 0,
    tz: 0,
    fp2: 0,
    lsubid: 0,
    browser: 0,
    capabilities: 0,
    gpu: 0,
    dnt: 0,
    math: 0,
    tts: 0,
    input: 0,
    canvas: 0,
    captchainput: 0,
    pow: 0
  };
}
function genInteraction(eventType) {
  if (eventType === "PageLoad" || eventType === "first_load") {
    return {
      clicks: 0,
      touches: 0,
      keyPresses: 0,
      cuts: 0,
      copies: 0,
      pastes: 0,
      keyPressTimeIntervals: [],
      mouseClickPositions: [],
      keyCycles: [],
      mouseCycles: [],
      touchCycles: []
    };
  }
  const nClicks = 1 + randInt(3);
  const nKeys = 3 + randInt(8);
  const nIntervals = Math.max(1, Math.floor(nKeys / 3)) + randInt(Math.max(1, Math.floor(nKeys / 2) - Math.floor(nKeys / 3) + 1));
  const nCycles = Math.max(2, Math.floor(nKeys / 2)) + randInt(Math.max(1, Math.floor(nKeys * 2 / 3) - Math.floor(nKeys / 2) + 1));
  return {
    clicks: nClicks,
    touches: 0,
    keyPresses: nKeys,
    cuts: 0,
    copies: 0,
    pastes: 0,
    keyPressTimeIntervals: Array.from({ length: nIntervals }, () => 80 + randInt(621)),
    mouseClickPositions: Array.from(
      { length: nClicks },
      () => `${400 + randInt(401)},${300 + randInt(201)}`
    ),
    keyCycles: Array.from({ length: nCycles }, () => 20 + randInt(281)),
    mouseCycles: Array.from({ length: nClicks }, () => 50 + randInt(101)),
    touchCycles: []
  };
}
function genFormField(startMs, emailLen, email, interaction) {
  const fieldTs = startMs - (10 + randInt(41));
  const fieldRand = 1e3 + randInt(9e3);
  const fieldName = `formField29-${fieldTs}-${fieldRand}`;
  let nKeys = Math.max(3, Math.floor(emailLen / 3) + randInt(5) - 2);
  const intervals = Array.from({ length: Math.min(nKeys - 1, 5) }, () => 80 + randInt(621));
  const keyCycles = Array.from({ length: Math.min(nKeys, 6) }, () => 20 + randInt(231));
  if (typeof interaction.keyPresses === "number" && interaction.keyPresses > 0) {
    nKeys = interaction.keyPresses;
  }
  const checksumStr = email || `user${1e3 + randInt(9e3)}@example.com`;
  const cksum = crc32Str(checksumStr).toString(16).toUpperCase().padStart(8, "0");
  return {
    [fieldName]: {
      clicks: 1,
      touches: 0,
      keyPresses: nKeys,
      cuts: 0,
      copies: 0,
      pastes: 0,
      keyPressTimeIntervals: intervals,
      mouseClickPositions: [`${100 + randInt(151)}.5,${10 + randInt(11)}.5`],
      keyCycles,
      mouseCycles: [80 + randInt(71)],
      touchCycles: [],
      width: 180,
      height: 32,
      totalFocusTime: 0,
      checksum: cksum,
      autocomplete: false,
      prefilled: false
    }
  };
}
function formatScreen(s) {
  return `${s.width}-${s.height}-${s.availHeight}-${s.colorDepth}-*-*-*`;
}
function formatPlugins(plugins) {
  return plugins.map((p) => p.name).join(" ");
}
function buildFingerprintData(identity, locationURL, referrer, nowMs, ctx, pageType, eventType, timeOnPage, emailLen, email) {
  const canvasHash = ctx ? ctx.canvasHash : identity.canvasHash;
  const histogram = ctx ? ctx.histogramBins : identity.histogramBase;
  const perfTiming = ctx ? getPerfTiming(ctx, nowMs) : genPerfTiming(nowMs);
  let lsUbid;
  if (ctx) {
    lsUbid = getLsUbid(ctx, pageType);
  } else {
    lsUbid = `${identity.lsubidPrefixSignin}-${String(randInt(1e7)).padStart(7, "0")}-${String(randInt(1e7)).padStart(7, "0")}:${Math.floor(perfTiming.loadEventEnd / 1e3)}`;
  }
  let dynamicURLs;
  let scriptsElapsed;
  let historyLength;
  let isCompatible;
  switch (pageType) {
    case "profile":
      dynamicURLs = [`/dist/main/app_${identity.webpackHash}.min.js`];
      scriptsElapsed = 0;
      historyLength = eventType === "PageLoad" || eventType === "first_load" ? 2 : 3;
      isCompatible = true;
      break;
    case "signup":
      dynamicURLs = ["/assets/js/app.js"];
      scriptsElapsed = 1;
      historyLength = 5;
      isCompatible = true;
      break;
    default:
      dynamicURLs = ["/assets/js/app.js"];
      scriptsElapsed = 1;
      historyLength = 1;
      isCompatible = false;
  }
  let metrics;
  if (eventType === "first_load" || eventType === "PageLoad" && pageType === "profile") {
    metrics = genMetricsFirstLoad(pageType);
  } else {
    metrics = genMetricsPageSubmit();
  }
  const interaction = genInteraction(eventType);
  const endMs = nowMs + randInt(51);
  let startTime;
  if (eventType !== "PageLoad" && eventType !== "first_load" && timeOnPage > 0) {
    startTime = endMs - timeOnPage;
  } else if (ctx) {
    if (eventType === "first_load") {
      startTime = getStartTime(ctx, nowMs - (500 + randInt(501)));
    } else if (eventType === "PageLoad" && pageType === "profile") {
      startTime = getStartTime(ctx, nowMs - (30 + randInt(51)));
    } else {
      startTime = getStartTime(ctx, nowMs);
    }
  } else {
    startTime = nowMs;
  }
  const pluginsStr = formatPlugins(identity.plugins);
  const screenStr = formatScreen(identity.screen);
  const result = new OrderedMap();
  result.set("metrics", metrics);
  result.set("start", startTime);
  result.set("interaction", interaction);
  result.set("scripts", {
    dynamicUrls: dynamicURLs,
    inlineHashes: [],
    elapsed: scriptsElapsed,
    dynamicUrlCount: dynamicURLs.length,
    inlineHashesCount: 0
  });
  result.set("history", { length: historyLength });
  result.set("battery", {});
  result.set("performance", { timing: perfTiming });
  result.set("automation", {
    wd: { properties: { document: [], window: [], navigator: [] } },
    phantom: { properties: { window: [] } }
  });
  result.set("end", endMs);
  result.set("timeZone", 8);
  result.set("flashVersion", null);
  result.set("plugins", pluginsStr + " ||" + screenStr);
  result.set("dupedPlugins", pluginsStr + " ||" + screenStr);
  result.set("screenInfo", screenStr);
  result.set("lsUbid", lsUbid);
  result.set("referrer", referrer);
  result.set("userAgent", identity.ua);
  result.set("location", locationURL);
  result.set("webDriver", false);
  result.set("capabilities", {
    css: {
      textShadow: 1,
      WebkitTextStroke: 1,
      boxShadow: 1,
      borderRadius: 1,
      borderImage: 1,
      opacity: 1,
      transform: 1,
      transition: 1
    },
    js: {
      audio: true,
      geolocation: true,
      localStorage: "supported",
      touch: false,
      video: true,
      webWorker: true
    },
    elapsed: 0
  });
  result.set("gpu", {
    vendor: identity.gpuVendor,
    model: identity.gpuModel,
    extensions: identity.webGLExts
  });
  result.set("dnt", null);
  result.set("math", { tan: identity.mathTan, sin: identity.mathSin, cos: identity.mathCos });
  if (pageType === "profile") {
    if (eventType === "PageLoad" || eventType === "first_load") {
      result.set("timeToSubmit", 1 + randInt(5));
    } else if (timeOnPage > 0) {
      result.set("timeToSubmit", timeOnPage);
    } else {
      result.set("timeToSubmit", 2e3 + randInt(4001));
    }
  }
  if (pageType === "profile" && eventType !== "PageLoad" && eventType !== "first_load" && emailLen > 0) {
    result.set("form", genFormField(nowMs, emailLen, email, interaction));
  } else {
    result.set("form", {});
  }
  result.set("canvas", { hash: canvasHash, emailHash: null, histogramBins: [...histogram] });
  result.set("token", { isCompatible, pageHasCaptcha: 0 });
  result.set("auth", { form: { method: "get" } });
  result.set("errors", []);
  result.set("version", getTESVersion());
  return result;
}
function generateFingerprint(identity, locationURL, referrer, ctx, pageType, eventType, timeOnPage, emailLen, email) {
  const nowMs = Date.now();
  const fpData = buildFingerprintData(
    identity,
    locationURL,
    referrer,
    nowMs,
    ctx,
    pageType,
    eventType,
    timeOnPage,
    emailLen,
    email
  );
  const jsonStr = fpData.toJSON();
  return encryptFingerprint(jsonStr);
}
function b64url(data) {
  return data.toString("base64url");
}
function jwkToPublicKey(jwk) {
  const n = Buffer.from(jwk.n, "base64url");
  const e = Buffer.from(jwk.e, "base64url");
  return crypto.createPublicKey({
    key: {
      kty: "RSA",
      n: n.toString("base64url"),
      e: e.toString("base64url")
    },
    format: "jwk"
  });
}
function genUUID() {
  const b = crypto.randomBytes(16);
  return [
    b.subarray(0, 4).toString("hex"),
    b.subarray(4, 6).toString("hex"),
    b.subarray(6, 8).toString("hex"),
    b.subarray(8, 10).toString("hex"),
    b.subarray(10, 16).toString("hex")
  ].join("-");
}
function encryptPassword(password, publicKey, issuer, audience, region) {
  const header = {
    alg: "RSA-OAEP-256",
    kid: publicKey.kid,
    enc: "A256GCM",
    cty: "enc",
    typ: "application/aws+signin+jwe"
  };
  const headerJSON = Buffer.from(JSON.stringify(header));
  const headerB64 = b64url(headerJSON);
  const cek = crypto.randomBytes(32);
  const pubKey = jwkToPublicKey(publicKey);
  const encryptedCEK = crypto.publicEncrypt(
    {
      key: pubKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256"
    },
    cek
  );
  const now = Math.floor(Date.now() / 1e3);
  const claims = {
    iss: `${region}.${issuer}`,
    iat: now,
    nbf: now,
    jti: genUUID(),
    exp: now + 300,
    aud: `${region}.${audience}`,
    password
  };
  const plaintext = Buffer.from(JSON.stringify(claims));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", cek, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(headerB64, "ascii"));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${headerB64}.${b64url(encryptedCEK)}.${b64url(iv)}.${b64url(ct)}.${b64url(tag)}`;
}
function hex4() {
  const chars = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * 16)];
  return s;
}
function visitorId() {
  return `${hex4()}${hex4()}-${hex4()}-7${hex4().slice(1)}-${hex4()}-${hex4()}${hex4()}${hex4()}`;
}
function awsccc() {
  const d = {
    e: 1,
    p: 1,
    f: 1,
    a: 1,
    i: `${hex4()}${hex4()}-${hex4()}-4${hex4().slice(1)}-${hex4()}-${hex4()}${hex4()}${hex4()}`,
    v: "1"
  };
  return Buffer.from(JSON.stringify(d)).toString("base64");
}
function ubidGen() {
  const d7 = Array.from({ length: 7 }, () => Math.floor(Math.random() * 10)).join("");
  const d6 = Array.from({ length: 6 }, () => Math.floor(Math.random() * 10)).join("");
  return `186-${d7}-${d6}`;
}
function newUUID() {
  const b = crypto.randomBytes(16);
  return [
    b.subarray(0, 4).toString("hex"),
    b.subarray(4, 6).toString("hex"),
    b.subarray(6, 8).toString("hex"),
    b.subarray(8, 10).toString("hex"),
    b.subarray(10, 16).toString("hex")
  ].join("-");
}
function gmtDate() {
  return (/* @__PURE__ */ new Date()).toUTCString();
}
function extractParam(rawURL, key) {
  try {
    const u = new URL(rawURL);
    return u.searchParams.get(key) || "";
  } catch {
    return "";
  }
}
function splitAfter(s, sep) {
  const idx = s.indexOf(sep);
  if (idx < 0) return "";
  const rest = s.slice(idx + sep.length);
  const ampIdx = rest.indexOf("&");
  return ampIdx >= 0 ? rest.slice(0, ampIdx) : rest;
}
function getNestedMap(data, ...keys) {
  let current = data;
  for (const k of keys) {
    if (typeof current !== "object" || current === null) return null;
    current = current[k];
  }
  return typeof current === "object" && current !== null ? current : null;
}
function getNestedStringMap(data, key) {
  if (!data) return null;
  const nested = data[key];
  if (typeof nested !== "object" || nested === null) return null;
  const result = {};
  for (const [k, v] of Object.entries(nested)) {
    if (typeof v === "string") result[k] = v;
  }
  return Object.keys(result).length > 0 ? result : null;
}
function saveCookies(cookies, headers) {
  const skip = /* @__PURE__ */ new Set(["path", "domain", "expires", "max-age", "secure", "httponly", "samesite"]);
  const setCookieHeader = headers["set-cookie"];
  if (!setCookieHeader) return;
  const values = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const raw of values) {
    if (!raw.includes("=")) continue;
    const mainPart = raw.split(";")[0];
    const eqIdx = mainPart.indexOf("=");
    if (eqIdx < 0) continue;
    const k = mainPart.slice(0, eqIdx).trim();
    const v = mainPart.slice(eqIdx + 1).trim();
    if (!skip.has(k.toLowerCase()) && k) {
      cookies.set(k, v);
    }
  }
}
const PARTITION = "persist:proton";
const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
const PROTON_INBOX_URL = "https://mail.proton.me/u/0/inbox";
let win = null;
function resolveSettingsProxy(explicit) {
  const e = (explicit || "").trim();
  if (e) return e;
  return (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "").trim();
}
function applyProxy(sess, proxy) {
  const resolved = resolveSettingsProxy(proxy);
  if (resolved) {
    console.log(`[Proton] 走设置代理: ${resolved.replace(/:[^:@/]+@/, ":***@")}`);
    return sess.setProxy({ proxyRules: resolved });
  }
  console.log("[Proton] 设置未配代理，跟随系统代理");
  return sess.setProxy({ mode: "system" });
}
async function ensureWindow(show, proxy) {
  const sess = electron.session.fromPartition(PARTITION);
  await applyProxy(sess, proxy);
  if (win && !win.isDestroyed()) {
    if (show) {
      win.show();
      win.focus();
    }
    return win;
  }
  win = new electron.BrowserWindow({
    width: 1024,
    height: 800,
    show,
    title: "Proton Mail",
    autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      // 后台隐藏时不节流定时器/网络，保证 Proton 仍能实时收新邮件
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.webContents.setUserAgent(CHROME_UA);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/proton\.me/i.test(url)) return { action: "allow" };
    return { action: "deny" };
  });
  const closed = () => {
    win = null;
  };
  win.on("closed", closed);
  await loadAndWait(win, PROTON_INBOX_URL);
  return win;
}
function loadAndWait(w, url, timeoutMs = 3e4) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      w.webContents.removeListener("dom-ready", finish);
      resolve();
    };
    w.webContents.once("dom-ready", finish);
    w.loadURL(url).catch(() => finish());
    setTimeout(finish, timeoutMs);
  });
}
function sleep$1(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function checkLoggedIn(w) {
  const url = w.webContents.getURL();
  if (/account\.proton\.me/i.test(url) || /\/(login|authorize|switch)/i.test(url)) return false;
  if (!/mail\.proton\.me\/u\//i.test(url)) return false;
  try {
    const ok = await w.webContents.executeJavaScript(
      `(() => {
        if (document.querySelector('input[type="password"], #password')) return false
        const sels = ['[data-testid="message-list"]','.items-column-list','[data-shortcut-target="item-container"]','main [role="main"]']
        return sels.some(s => document.querySelector(s)) || /\\/u\\//.test(location.pathname)
      })()`,
      false
    );
    return Boolean(ok);
  } catch {
    return /mail\.proton\.me\/u\//i.test(url);
  }
}
async function openProtonLogin(proxy) {
  try {
    const w = await ensureWindow(true, proxy);
    await sleep$1(1200);
    const loggedIn = await checkLoggedIn(w);
    return { success: true, loggedIn };
  } catch (err) {
    return {
      success: false,
      loggedIn: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
async function getProtonLoginStatus(proxy) {
  try {
    const w = await ensureWindow(false, proxy);
    await sleep$1(600);
    return { loggedIn: await checkLoggedIn(w) };
  } catch {
    return { loggedIn: false };
  }
}
function closeProtonWindow() {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}
function buildScanScript(address) {
  const addrFull = JSON.stringify(address.trim().toLowerCase());
  return `(async () => {
    const addrFull = ${addrFull};
    const extractCode = (t) => { const m = (t||'').match(/\\b\\d{6}\\b/g); return m ? m[m.length-1] : ''; };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const fire = (el, type) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    // 读取当前打开邮件的收件人地址集合（Proton DOM 依赖点：mailto / recipient-label / recipients:item-）
    const readRecipients = () => {
      const set = new Set();
      document.querySelectorAll('a[href^="mailto:"]').forEach((a) => {
        const m = (a.getAttribute('href') || '').replace(/^mailto:/i, '').trim().toLowerCase();
        if (m.indexOf('@') > 0) set.add(m);
      });
      document.querySelectorAll('[data-testid="recipient-label"], bdi.message-recipient-item-label').forEach((el) => {
        const t = (el.innerText || '').trim().toLowerCase();
        if (t.indexOf('@') > 0) set.add(t);
      });
      document.querySelectorAll('[data-testid^="recipients:item-"]').forEach((el) => {
        const t = (el.getAttribute('data-testid') || '').replace('recipients:item-', '').trim().toLowerCase();
        if (t.indexOf('@') > 0) set.add(t);
      });
      return set;
    };
    // 列表项发件人地址（Proton DOM 依赖点）：AWS 验证码邮件发件人固定为 no-reply@signin.aws，
    // 用它精确筛掉同为 AWS 的非验证码邮件（如「Response Required: Your Kiro Account」，
    // 那封收件人也是当前地址，仅靠收件人校验会误判「匹配但无码」而卡住）。
    const SENDER = 'no-reply@signin.aws';
    const senderOf = (it) => {
      const el = it.querySelector('[data-testid="message-column:sender-address"]');
      return el ? (el.getAttribute('title') || el.innerText || '').trim().toLowerCase() : '';
    };
    // 打开某封邮件：避开行内星标 button / 复选框 input，否则只会切换星标而打不开邮件
    const openItem = (it) => {
      let target = it.querySelector('[data-testid="message-column:subject"]')
        || it.querySelector('[data-testid^="message-row"]')
        || it.querySelector('.item-subject-wrapper, .subject, span[role="heading"]');
      if (!target) {
        const cand = Array.from(it.querySelectorAll('span, div'))
          .filter((el) => !el.closest('button') && !el.querySelector('button, input') && (el.innerText || '').trim().length > 8);
        target = cand[0] || it;
      }
      fire(target, 'mousedown'); fire(target, 'mouseup'); fire(target, 'click');
    };
    // 读正文（Proton 正文渲染在 iframe 内，优先读 iframe）
    const readBody = () => {
      let body = '';
      const ifr = document.querySelector('iframe[data-testid="content-iframe"], iframe[title], iframe');
      if (ifr) { try { body = (ifr.contentDocument && ifr.contentDocument.body) ? (ifr.contentDocument.body.innerText || '') : ''; } catch (e) {} }
      if (!body) {
        const readSels = ['[data-testid="message-content"]','.message-content','[data-testid="message-view"]','main [role="article"]','main'];
        for (const rs of readSels) { const el = document.querySelector(rs); if (el && el.innerText) { body = el.innerText; break; } }
      }
      if (!body) body = document.body.innerText || '';
      return body;
    };
    // Proton DOM 依赖点：邮件列表项候选选择器（多重兜底）
    const listSels = ['[data-testid="message-item"]','[data-shortcut-target="item-container"]','.items-column-list [role="row"]','.item-container-wrapper','.item-container'];
    let items = [];
    for (const s of listSels) { const e = [...document.querySelectorAll(s)]; if (e.length) { items = e; break; } }
    if (!items[0]) return { code: '', from: 'none', matched: false };
    // 优先只看发件人为 AWS 验证码地址的邮件；筛不到时回退看前两封（兜底，防发件人 DOM 改版）
    const awsItems = items.filter((it) => senderOf(it) === SENDER);
    const candidates = (awsItems.length ? awsItems : items).slice(0, 2);
    const results = [];
    for (let i = 0; i < candidates.length; i++) {
      try {
        openItem(candidates[i]);
        // 轮询等渲染就绪（出现 6 位码 / 收件人+正文齐备）即提前继续，省去固定死等 2.2s。
        // 首次稍等 iframe 切到新邮件，之后细粒度轮询；上限 ~2s 与原死等相当但通常 0.5s 内命中。
        let body = '';
        let recipients = new Set();
        for (let t = 0; t < 11; t++) {
          await sleep(t === 0 ? 350 : 170);
          body = readBody();
          recipients = readRecipients();
          if (extractCode(body) || (recipients.size > 0 && body.length > 30)) break;
        }
        const r = {
          i,
          hasRecip: recipients.size > 0,
          match: recipients.has(addrFull),
          code: extractCode(body),
          recipText: Array.from(recipients).join(',').slice(0, 100),
          bodySnip: body.slice(0, 100)
        };
        results.push(r);
        // 早停：收件人精确匹配 + 有码 → 当前注册地址那封的验证码（最高置信）
        if (r.match && r.code) return { code: r.code, from: 'body', matched: true, snippet: 'aws#' + i + ' ' + r.bodySnip };
      } catch (e) {
        results.push({ i, hasRecip: false, match: false, code: '', recipText: '', bodySnip: 'err=' + String(e) });
      }
    }
    // 收件人读不到但有码（发件人已确认是 AWS 验证码邮件，可信）→ 退化采用
    const noRecipCode = results.find((r) => !r.hasRecip && r.code);
    if (noRecipCode) return { code: noRecipCode.code, from: 'body', matched: false, snippet: 'aws#' + noRecipCode.i + ' no-recipients; ' + noRecipCode.bodySnip };
    // 收件人精确匹配但还没读到码（邮件刚到正在渲染）
    const matchNoCode = results.find((r) => r.match && !r.code);
    if (matchNoCode) return { code: '', from: 'body-nocode', matched: true, snippet: 'aws#' + matchNoCode.i + ' ' + matchNoCode.bodySnip };
    // 有码但收件人是别的变体 → 不是当前的，继续等
    const wrongRecip = results.find((r) => r.code && r.hasRecip && !r.match);
    if (wrongRecip) return { code: '', from: 'wrong-recipient', matched: false, snippet: 'aws#' + wrongRecip.i + ' recipients=' + wrongRecip.recipText };
    return { code: '', from: 'body-nocode', matched: false, snippet: 'awsItems=' + awsItems.length + '; ' + results.map((r) => '#' + r.i + (r.code ? '+code' : '-nocode') + ' r=' + (r.recipText || 'none')).join(' | ').slice(0, 170) };
  })()`;
}
let otpQueue = Promise.resolve();
function waitProtonOtp(address, opts) {
  const run = otpQueue.then(
    () => runWaitProtonOtp(address, opts),
    () => runWaitProtonOtp(address, opts)
  );
  otpQueue = run.catch(() => void 0);
  return run;
}
async function runWaitProtonOtp(address, opts) {
  const log = opts.log ?? (() => {
  });
  const w = await ensureWindow(false, opts.proxy);
  if (!await checkLoggedIn(w)) {
    throw new Error("Proton 未登录，请先在「登录 Proton」窗口完成登录");
  }
  await loadAndWait(w, PROTON_INBOX_URL);
  await sleep$1(1500);
  const pollMs = Math.min(Math.max(opts.intervalSec * 1e3, 250), 1e3);
  const maxRetries = Math.max(1, Math.floor(opts.timeoutSec * 1e3 / pollMs));
  const script = buildScanScript(address);
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (opts.signal?.aborted) throw new Error("注册已取消");
    if (attempt > 1 && attempt % 20 === 0) {
      await loadAndWait(w, PROTON_INBOX_URL);
      await sleep$1(1200);
    }
    try {
      const res = await w.webContents.executeJavaScript(script, true);
      if (res && res.code && res.from === "body") {
        log(`[Proton] 验证码: ${res.code} (${res.matched ? "收件人精确匹配" : "正文去点兜底匹配"})`);
        return res.code;
      } else if (res && res.from === "wrong-recipient") {
        if (attempt % 8 === 0)
          log(`[Proton] 最新邮件收件人非当前地址，等待当前验证码... ${res.snippet || ""}`);
      } else if (res && res.from === "body-nocode") {
        if (attempt % 8 === 0)
          log(
            `[Proton] ${res.matched ? "已打开当前邮件但未提取到码" : "暂无匹配邮件"}: ${res.snippet || ""}`
          );
      } else if (res && res.from === "error") {
        if (attempt % 10 === 0) log(`[Proton] 取码脚本异常: ${res.err}`);
      }
    } catch (err) {
      if (attempt % 10 === 0) log(`[Proton] [${attempt}/${maxRetries}] 读取失败: ${err}`);
    }
    if (attempt % 10 === 0) log(`[Proton] [${attempt}/${maxRetries}] 暂无验证码...`);
    await sleep$1(pollMs);
  }
  throw new Error(`等待验证码超时 (${opts.timeoutSec}s)`);
}
function getRegistrationProxyUrl() {
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || getSystemProxy() || void 0;
}
async function proxyFetch(url, options) {
  const agent = safeCreateProxyAgent(getRegistrationProxyUrl());
  if (agent) {
    return await undici.fetch(url, {
      ...options,
      dispatcher: agent
    });
  }
  return await fetch(url, options);
}
const OTP_PATTERN = /\b(\d{6})\b/g;
function extractCode(body) {
  const matches = body.match(OTP_PATTERN);
  if (!matches || matches.length === 0) return "";
  return matches[matches.length - 1];
}
function abortableSleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(new Error("注册已取消"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("注册已取消"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
class MoEmailService {
  baseURL;
  apiKey;
  address = "";
  constructor(baseURL, apiKey) {
    this.baseURL = MoEmailService.normalizeBaseURL(baseURL);
    this.apiKey = apiKey;
  }
  /**
   * 归一化用户输入的 baseURL：
   *   - 去除首尾空白与末尾斜杠
   *   - 缺少 protocol 时补 `https://`
   *   - 校验协议仅允许 http / https，否则抛清晰错误
   * 用于规避 fetch 因协议不合法抛出
   * "Invalid URL protocol: the URL must start with `http:` or `https:`."
   */
  static normalizeBaseURL(raw) {
    const trimmed = (raw || "").trim().replace(/\/+$/, "");
    if (!trimmed) throw new Error("MoEmail BaseURL 未配置");
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    let u;
    try {
      u = new URL(withScheme);
    } catch {
      throw new Error(`MoEmail BaseURL 格式无效: ${raw}`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error(`MoEmail BaseURL 协议不支持 (仅支持 http/https): ${u.protocol}`);
    }
    return withScheme;
  }
  async create() {
    const url = `${this.baseURL}/api/mail/create`;
    const headers = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    const resp = await proxyFetch(url, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(3e4)
    });
    const data = await resp.json();
    const addr = data.address || data.email || data.data?.address || data.data?.email || "";
    if (!addr) {
      console.log("[MoEmail] 创建邮箱失败:", JSON.stringify(data));
      return "";
    }
    this.address = addr;
    return addr;
  }
  async waitForCode(timeoutSec, intervalSec, signal) {
    if (!this.address) throw new Error("邮箱地址为空");
    const maxRetries = Math.floor(timeoutSec / intervalSec);
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) throw new Error("注册已取消");
      await abortableSleep(intervalSec * 1e3, signal);
      try {
        const code = await this.fetchCode();
        if (code) return code;
      } catch (err) {
        if (attempt % 5 === 0) console.log(`[MoEmail] [${attempt}/${maxRetries}] 查询失败:`, err);
      }
      if (attempt % 5 === 0) console.log(`[MoEmail] [${attempt}/${maxRetries}] 暂无验证码...`);
    }
    throw new Error(`等待验证码超时 (${timeoutSec}s)`);
  }
  getAddress() {
    return this.address;
  }
  async fetchCode() {
    const url = `${this.baseURL}/api/mail/messages?address=${this.address}`;
    const headers = {};
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    const resp = await proxyFetch(url, { headers, signal: AbortSignal.timeout(15e3) });
    const raw = await resp.json();
    let messages = [];
    if (Array.isArray(raw)) {
      messages = raw;
    } else if (typeof raw === "object" && raw !== null) {
      const wrapper = raw;
      if (Array.isArray(wrapper.data)) {
        messages = wrapper.data;
      }
    }
    for (const msg of messages) {
      const text = msg.text || msg.body || msg.html || "";
      if (text) {
        const code = extractCode(text);
        if (code) return code;
      }
    }
    return "";
  }
}
class TempMailPlusService {
  static BASE_URL = "https://tempmail.plus/api";
  tmEmail;
  // tempmail.plus 用户名（不含 @mailto.plus）
  epin;
  /** 支持多域名（用户填多行/逗号/空格分隔），每次 create 随机挑一个，降低单域名被风控关联 */
  domains;
  domain = "";
  address = "";
  constructor(tmEmail, epin, domain) {
    this.tmEmail = tmEmail;
    this.epin = epin;
    this.domains = domain.split(/[\s,;]+/).map((d) => d.trim().replace(/^@/, "")).filter(Boolean);
    if (this.domains.length === 0) {
      throw new Error("TempMail.Plus 自建域名为空");
    }
  }
  get headers() {
    return {
      accept: "application/json, text/javascript, */*; q=0.01",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
      "x-requested-with": "XMLHttpRequest",
      Referer: "https://tempmail.plus/zh/",
      cookie: `email=${encodeURIComponent(this.fullEmail)}`
    };
  }
  async create() {
    const prefix = randomEmailPrefix();
    this.domain = this.domains[Math.floor(Math.random() * this.domains.length)];
    this.address = `${prefix}@${this.domain}`;
    if (this.domains.length > 1) {
      console.log(`[TempMailPlus] 生成邮箱: ${this.address}  (域名池 ${this.domains.length} 个)`);
    } else {
      console.log(`[TempMailPlus] 生成邮箱: ${this.address}`);
    }
    return this.address;
  }
  getAddress() {
    return this.address;
  }
  async waitForCode(timeoutSec, intervalSec, signal) {
    if (!this.address) throw new Error("邮箱地址为空");
    const maxRetries = Math.floor(timeoutSec / intervalSec);
    const checkedIds = /* @__PURE__ */ new Set();
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) throw new Error("注册已取消");
      await abortableSleep(intervalSec * 1e3, signal);
      try {
        const mails = await this.fetchMailList();
        if (attempt === 1 || attempt % 5 === 0) {
          console.log(`[TempMailPlus] [${attempt}/${maxRetries}] 邮件数: ${mails.length}`);
        }
        for (const mail of mails) {
          const mailId = mail.mail_id;
          if (checkedIds.has(mailId)) continue;
          checkedIds.add(mailId);
          const detail = await this.fetchMailDetail(mailId);
          if (!detail) continue;
          const toField = String(detail.to || "").toLowerCase();
          if (!toField.includes(this.address.toLowerCase())) {
            console.log(`[TempMailPlus] 收件人不匹配: ${toField} (期望包含: ${this.address})`);
            continue;
          }
          const code = this.extractOTP(detail);
          if (code) {
            console.log(`[TempMailPlus] 验证码: ${code}`);
            await this.deleteMail(mailId);
            return code;
          } else {
            console.log(`[TempMailPlus] 邮件 ${mailId} 未提取到验证码`);
          }
        }
      } catch (err) {
        console.log(`[TempMailPlus] [${attempt}/${maxRetries}] 查询失败:`, err);
      }
      if (attempt % 5 === 0) console.log(`[TempMailPlus] [${attempt}/${maxRetries}] 暂无验证码...`);
    }
    throw new Error(`等待验证码超时 (${timeoutSec}s)`);
  }
  get fullEmail() {
    return `${this.tmEmail}@mailto.plus`;
  }
  async fetchMailList() {
    const url = `${TempMailPlusService.BASE_URL}/mails?email=${encodeURIComponent(this.fullEmail)}&first_id=0&epin=${encodeURIComponent(this.epin)}`;
    const resp = await proxyFetch(url, {
      headers: this.headers,
      signal: AbortSignal.timeout(15e3)
    });
    const data = await resp.json();
    if (!data.result) return [];
    return data.mail_list || [];
  }
  async fetchMailDetail(mailId) {
    const url = `${TempMailPlusService.BASE_URL}/mails/${mailId}?email=${encodeURIComponent(this.fullEmail)}&epin=${encodeURIComponent(this.epin)}`;
    const resp = await proxyFetch(url, {
      headers: this.headers,
      signal: AbortSignal.timeout(15e3)
    });
    const data = await resp.json();
    return data.result ? data : null;
  }
  async deleteMail(mailId) {
    const url = `${TempMailPlusService.BASE_URL}/mails/${mailId}`;
    const headers = {
      ...this.headers,
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8"
    };
    const body = `email=${encodeURIComponent(this.fullEmail)}&epin=${encodeURIComponent(this.epin)}`;
    try {
      await proxyFetch(url, { method: "DELETE", headers, body, signal: AbortSignal.timeout(1e4) });
      console.log(`[TempMailPlus] 已删除邮件: ${mailId}`);
    } catch (err) {
      console.log(`[TempMailPlus] 删除邮件失败:`, err);
    }
  }
  extractOTP(detail) {
    const subject = String(detail.subject || "");
    const subjectMatch = subject.match(/(\d{6})/);
    if (subjectMatch) return subjectMatch[1];
    const text = String(detail.text || "");
    const code = extractCode(text);
    if (code) return code;
    const html = String(detail.html || "");
    return extractCode(html);
  }
}
class GptMailService {
  static DEFAULT_BASE_URL = "https://mail.chatgpt.org.uk";
  // 与 sessionOpts 的 tlsClientIdentifier='chrome_146' 及 SessionClient 默认 UA 保持一致，
  // 否则 sec-ch-ua / UA / JA3 三者版本对不上，容易被 Cloudflare 风控识破。
  static CHROME_MAJOR = 146;
  static UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${GptMailService.CHROME_MAJOR}.0.0.0 Safari/537.36`;
  static SEC_CH_UA = `"Google Chrome";v="${GptMailService.CHROME_MAJOR}", "Chromium";v="${GptMailService.CHROME_MAJOR}", "Not)A;Brand";v="24"`;
  baseURL;
  /**
   * 固定接收邮箱（CF 转发目标）。
   * - 玩法 A（私有域名直收）：留空 —— 本次注册地址本身就是 inbox
   * - 玩法 B（CF 转发）：填了，所有 prefix@domain 都转发到这个邮箱
   */
  fixedInboxEmail;
  /** 用户自己的域名池（玩法 A：MX 已解析到 GPTmail；玩法 B：CF 配了 catch-all）*/
  domains;
  /** 可选的固定前缀；留空则用 randomEmailPrefix() 生成 */
  fixedPrefix;
  /**
   * 可选：私有域名密码。
   * 在 GPTmail 站点添加「私有域名」时会设一个密码，所有该域名下的 inbox 查看邮件前必须 unlock。
   * 留空 = 公共域名或公开域名（不需密码）。
   */
  privatePassword;
  /**
   * 取当前 TLS SessionClient 的 getter（伪装 Chrome JA3 指纹）。
   * GPTmail 后端通过 TLS 握手指纹校验"是否真实浏览器"，
   * Node 默认 TLS / undici 会被识破返回 401 "Browser session required"，
   * 所以必须用 Registrar 已经初始化好的 SessionClient 发请求。
   *
   * 关键：这里**不能缓存 SessionClient 实例**。Registrar 在注册过程中（Portal/WorkflowInit
   * 重试、网络抖动、可恢复 TLS 错误）会 rebuildTlsClient() —— 销毁旧 session 再建新的。
   * 若缓存旧引用，邮箱创建后到取码之间一旦发生 rebuild，旧 session 已 destroyed，
   * 后续每次轮询都会抛 "SessionClient has been destroyed" 直到超时。
   * 因此每次请求都通过 getter 读取 Registrar 的**最新** session。
   */
  getSession;
  /** 本次注册使用的"用户侧"邮箱地址（prefix@用户域名）—— 注册站点看到的就是它 */
  address = "";
  /** 实际查询邮件用的 GPTmail inbox 地址（玩法 A = address；玩法 B = fixedInboxEmail）*/
  inboxEmail = "";
  /** 当前滚动 token：每次响应若带回 auth.token 则替换 */
  token = "";
  /**
   * create() 时已存在于 inbox 的邮件 ID 基线。
   * CF 转发模式下多个并发注册共享同一 inbox，绝不能用全量 clear（会删掉别的任务待取的验证码）；
   * 改为记录基线 ID，轮询时跳过这些旧邮件，做到无副作用、并发安全。
   */
  baselineIds = /* @__PURE__ */ new Set();
  constructor(opts) {
    if (typeof opts.getSession !== "function") {
      throw new Error(
        "GPTmail 必须传入 getSession（用于每次取最新 TLS SessionClient 绕过 401 校验）"
      );
    }
    this.getSession = opts.getSession;
    this.baseURL = GptMailService.normalizeBaseURL(opts.baseURL || GptMailService.DEFAULT_BASE_URL);
    this.fixedInboxEmail = (opts.inboxEmail || "").trim();
    if (this.fixedInboxEmail && !this.fixedInboxEmail.includes("@")) {
      throw new Error("GPTmail 接收邮箱格式无效（应为 xxx@yyy.zzz，或留空走私有域名直收）");
    }
    this.domains = (opts.domain || "").split(/[\s,;]+/).map((d) => d.trim().replace(/^@/, "")).filter(Boolean);
    if (this.domains.length === 0) {
      throw new Error(
        "GPTmail 自建域名池为空（私有模式: MX 已解析到 GPTmail 的域名；CF 模式: CF 配了 catch-all 的域名）"
      );
    }
    this.fixedPrefix = (opts.prefix || "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
    this.privatePassword = (opts.privatePassword || "").trim();
  }
  static normalizeBaseURL(raw) {
    const trimmed = (raw || "").trim().replace(/\/+$/, "");
    if (!trimmed) return "https://mail.chatgpt.org.uk";
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    let u;
    try {
      u = new URL(withScheme);
    } catch {
      throw new Error(`GPTmail BaseURL 格式无效: ${raw}`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error(`GPTmail BaseURL 协议不支持 (仅支持 http/https): ${u.protocol}`);
    }
    return withScheme;
  }
  /**
   * 从页面 HTML 中提取 `window.__BROWSER_AUTH = {...}` 的 JSON 文本。
   * 用括号配平扫描（识别字符串与转义），从第一个 `{` 开始找到与之匹配的 `}`，
   * 支持对象内含嵌套 {} —— 比非贪婪正则健壮。
   */
  static extractBrowserAuthJson(html) {
    const anchor = html.indexOf("__BROWSER_AUTH");
    if (anchor < 0) return null;
    const start = html.indexOf("{", anchor);
    if (start < 0) return null;
    let depth = 0;
    let inStr = false;
    let quote = "";
    let escaped = false;
    for (let i = start; i < html.length; i++) {
      const ch = html[i];
      if (inStr) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === quote) inStr = false;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inStr = true;
        quote = ch;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) return html.slice(start, i + 1);
      }
    }
    return null;
  }
  /**
   * 通用请求：经过 tlsclientwrapper（伪装 Chrome JA3 指纹）调用 GPTmail API。
   *
   * 关键：GPTmail 通过 TLS 指纹 + Referer/Origin/sec-ch-* 校验"是否真实 Chrome"，
   * 用 Node 默认 TLS / undici 会被识破返回 401 {"error":"Browser session required"}。
   * 此方法走 Registrar 的 SessionClient（伪装 chrome_146 JA3）并补全浏览器 headers，
   * 才能通过 Cloudflare 反爬。
   *
   * 自动注入 x-inbox-token，并从响应里滚动更新 token。
   */
  async request(path2, init = {}) {
    const url = `${this.baseURL}${path2}`;
    const origin = new URL(this.baseURL).origin;
    const referer = `${origin}/${this.inboxEmail || ""}`;
    const method = init.method ?? "GET";
    const headers = {
      accept: "application/json, text/plain, */*",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      "user-agent": GptMailService.UA,
      origin,
      referer,
      "sec-ch-ua": GptMailService.SEC_CH_UA,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      ...init.headers || {}
    };
    if (init.body && !headers["content-type"] && !headers["Content-Type"]) {
      headers["content-type"] = "application/json";
    }
    if ((init.withToken ?? true) && this.token) {
      headers["x-inbox-token"] = this.token;
    }
    const session = this.getSession();
    if (!session) throw new Error("GPTmail TLS SessionClient 不可用（可能正在重建，稍后重试）");
    let raw;
    if (method === "POST") {
      raw = await session.post(url, init.body ?? "", { headers });
    } else if (method === "DELETE") {
      raw = await session.delete(url, { headers });
    } else {
      raw = await session.get(url, { headers });
    }
    let data;
    try {
      data = JSON.parse(raw.body);
    } catch {
      data = raw.body;
    }
    if ((raw.status === 401 || raw.status === 403) && !init._retried && (init.withToken ?? true) && path2 !== "") {
      try {
        await this.fetchInitialTokenFromPage();
        return await this.request(path2, { ...init, _retried: true });
      } catch {
      }
    }
    if (raw.status < 200 || raw.status >= 300) {
      const snippet = typeof data === "string" ? data.slice(0, 200) : JSON.stringify(data).slice(0, 200);
      throw new Error(`GPTmail ${path2} HTTP ${raw.status}: ${snippet}`);
    }
    if (data && typeof data === "object") {
      const obj = data;
      const auth = obj.auth;
      const newToken = auth?.token;
      if (typeof newToken === "string" && newToken) {
        this.token = newToken;
      }
    }
    return data;
  }
  async create() {
    const domain = this.domains[Math.floor(Math.random() * this.domains.length)];
    const prefix = this.fixedPrefix || randomEmailPrefix();
    this.address = `${prefix}@${domain}`;
    this.inboxEmail = this.fixedInboxEmail || this.address;
    await this.fetchInitialTokenFromPage();
    if (!this.token) {
      throw new Error("GPTmail 从页面 HTML 解析 __BROWSER_AUTH.token 失败");
    }
    if (this.privatePassword) {
      await this.unlockPrivateInbox();
    }
    try {
      const existing = await this.fetchMails();
      for (const mail of existing) {
        const id = String(mail.id ?? "");
        if (id) this.baselineIds.add(id);
      }
      if (this.baselineIds.size > 0) {
        console.log(`[GPTmail] inbox 基线邮件数: ${this.baselineIds.size}（轮询时将跳过）`);
      }
    } catch {
    }
    const mode = this.fixedInboxEmail ? `CF 转发 → ${this.inboxEmail}` : this.privatePassword ? "私有域名直收（已解锁）" : "私有域名直收（MX→GPTmail）";
    if (this.domains.length > 1) {
      console.log(
        `[GPTmail] 注册邮箱: ${this.address}  (域名池 ${this.domains.length} 个，模式: ${mode})`
      );
    } else {
      console.log(`[GPTmail] 注册邮箱: ${this.address}  (模式: ${mode})`);
    }
    return this.address;
  }
  /**
   * 通过 GET 页面 HTML 解析 window.__BROWSER_AUTH 初始 token。
   * GPTmail 服务端会在 SSR 时把 `{token,email,expires_at}` 渲染到 HTML 的内联 script 里，
   * 这是浏览器拿到 token 的"零成本"路径，不会触发 /api/inbox-token 的反爬保护。
   */
  async fetchInitialTokenFromPage() {
    const origin = new URL(this.baseURL).origin;
    const pageUrl = `${origin}/${this.inboxEmail}`;
    const pageHeaders = {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      "user-agent": GptMailService.UA,
      "sec-ch-ua": GptMailService.SEC_CH_UA,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
      "sec-fetch-user": "?1",
      "upgrade-insecure-requests": "1"
    };
    const session = this.getSession();
    if (!session) throw new Error("GPTmail TLS SessionClient 不可用（可能正在重建，稍后重试）");
    const raw = await session.get(pageUrl, { headers: pageHeaders });
    if (raw.status < 200 || raw.status >= 300) {
      throw new Error(`GPTmail GET ${pageUrl} HTTP ${raw.status}: ${raw.body.slice(0, 200)}`);
    }
    const jsonText = GptMailService.extractBrowserAuthJson(raw.body);
    if (!jsonText) {
      throw new Error("GPTmail 页面里未找到 window.__BROWSER_AUTH（服务器结构可能已变）");
    }
    let auth;
    try {
      auth = JSON.parse(jsonText);
    } catch (err) {
      throw new Error(
        `GPTmail __BROWSER_AUTH JSON 解析失败: ${err instanceof Error ? err.message : err}`
      );
    }
    const token = typeof auth.token === "string" ? auth.token : "";
    if (!token) {
      throw new Error(`GPTmail __BROWSER_AUTH 缺 token 字段: ${JSON.stringify(auth).slice(0, 200)}`);
    }
    this.token = token;
    console.log(`[GPTmail] 已从页面拿到初始 token（email=${auth.email}, exp=${auth.expires_at}）`);
  }
  /**
   * 私有域名密码解锁。
   * GPTmail 私有域名 inbox 在未 unlock 前调用 /api/emails 会返回 403 "private domain password required"。
   * 必须先 POST /api/private-domains/unlock {email, password} 拿到 unlock 后的 token，再轮询邮件。
   */
  async unlockPrivateInbox() {
    const lang = "zh-CN";
    const resp = await this.request(
      `/api/private-domains/unlock?lang=${encodeURIComponent(lang)}`,
      {
        method: "POST",
        body: JSON.stringify({ email: this.inboxEmail, password: this.privatePassword })
      }
    );
    if (!resp.success) {
      const err = resp.error || JSON.stringify(resp).slice(0, 200);
      throw new Error(`GPTmail 私有域名解锁失败: ${err}（密码错误？域名未设为私有？）`);
    }
    console.log(`[GPTmail] 私有域名 inbox 解锁成功: ${this.inboxEmail}`);
  }
  getAddress() {
    return this.address;
  }
  async waitForCode(timeoutSec, intervalSec, signal) {
    if (!this.address) throw new Error("GPTmail 注册邮箱为空，需先调用 create()");
    if (!this.inboxEmail) throw new Error("GPTmail inbox 邮箱为空，需先调用 create()");
    if (!this.token) throw new Error("GPTmail token 为空，需先调用 create()");
    const maxRetries = Math.max(1, Math.floor(timeoutSec / intervalSec));
    const checkedIds = new Set(this.baselineIds);
    const userLocal = this.address.toLowerCase().split("@")[0];
    const isPrivateDirect = !this.fixedInboxEmail;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) throw new Error("注册已取消");
      await abortableSleep(intervalSec * 1e3, signal);
      try {
        const mails = await this.fetchMails();
        if (attempt === 1 || attempt % 5 === 0) {
          console.log(
            `[GPTmail] [${attempt}/${maxRetries}] 收件箱(${this.inboxEmail}) 邮件数: ${mails.length}`
          );
        }
        for (const mail of mails) {
          const id = String(mail.id ?? "");
          if (!id || checkedIds.has(id)) continue;
          checkedIds.add(id);
          const subject = String(mail.subject ?? "");
          const content = String(mail.content ?? "");
          const html = String(mail.html_content ?? mail.html ?? "");
          if (isPrivateDirect) {
            const to = String(mail.email_address ?? "").toLowerCase();
            if (to && to !== this.address.toLowerCase()) {
              continue;
            }
          } else {
            const blob = `${subject}
${content}
${html}`.toLowerCase();
            const matches = blob.includes(this.address.toLowerCase()) || blob.includes(userLocal);
            if (!matches) {
              continue;
            }
          }
          const code = this.extractOTP(mail);
          if (code) {
            console.log(
              `[GPTmail] 提取到验证码: ${code} (from=${mail.from_address ?? ""}, subject=${subject.slice(0, 60)})`
            );
            return code;
          }
        }
      } catch (err) {
        if (attempt % 5 === 0) {
          console.log(
            `[GPTmail] [${attempt}/${maxRetries}] 查询失败:`,
            err instanceof Error ? err.message : err
          );
        }
      }
      if (attempt % 5 === 0) console.log(`[GPTmail] [${attempt}/${maxRetries}] 暂无验证码...`);
    }
    throw new Error(`GPTmail 等待验证码超时 (${timeoutSec}s)`);
  }
  async fetchMails() {
    const url = `/api/emails?email=${encodeURIComponent(this.inboxEmail)}`;
    const resp = await this.request(url);
    if (!resp.success) return [];
    const data = resp.data;
    const arr = data?.emails;
    return Array.isArray(arr) ? arr : [];
  }
  extractOTP(mail) {
    const subject = String(mail.subject ?? "");
    const subjMatch = subject.match(/(\d{6})/);
    if (subjMatch) return subjMatch[1];
    const content = String(mail.content ?? "");
    const c1 = extractCode(content);
    if (c1) return c1;
    const html = String(mail.html_content ?? mail.html ?? "");
    return extractCode(html);
  }
}
function splitByDashes(line) {
  const parts = [];
  const re = /-{4,}/g;
  let last = 0;
  let m;
  while ((m = re.exec(line)) !== null) {
    parts.push(line.slice(last, m.index) + "-".repeat(m[0].length - 4));
    last = m.index + m[0].length;
  }
  parts.push(line.slice(last));
  return parts;
}
function parseOutlookLines(data) {
  const accounts = [];
  data = data.trim();
  if (!data) return accounts;
  const lines = data.split("\n");
  const parseEntry = (entry) => {
    entry = entry.trim();
    if (!entry) return;
    const parts = splitByDashes(entry);
    if (parts.length === 4) {
      accounts.push({
        email: parts[0].trim(),
        password: parts[1].trim(),
        clientId: parts[2].trim(),
        refreshToken: parts[3].trim()
      });
    }
  };
  if (lines.length === 1) {
    for (const part of data.split(/\s+/)) parseEntry(part);
  } else {
    for (const line of lines) parseEntry(line);
  }
  return accounts;
}
async function refreshOutlookToken(acc) {
  const form = new URLSearchParams({
    client_id: acc.clientId,
    refresh_token: acc.refreshToken,
    grant_type: "refresh_token",
    scope: "https://outlook.office.com/IMAP.AccessAsUser.All offline_access"
  });
  const resp = await proxyFetch("https://login.microsoftonline.com/consumers/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString()
  });
  const data = await resp.json();
  if (resp.status !== 200)
    throw new Error(`刷新失败 ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`);
  const token = data.access_token;
  if (!token) throw new Error("响应中无 access_token");
  return token;
}
function buildXOAuth2(email, accessToken) {
  const auth = `user=${email}auth=Bearer ${accessToken}`;
  return Buffer.from(auth).toString("base64");
}
class IMAPClient {
  socket = null;
  buffer = "";
  tag = 0;
  async connect() {
    return new Promise((resolve, reject) => {
      const socket = tls__namespace.connect(993, "outlook.office365.com", {
        servername: "outlook.office365.com"
      });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("连接超时"));
      }, 15e3);
      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.once("secureConnect", () => {
        clearTimeout(timer);
        this.socket = socket;
        this.readLine().then(() => resolve()).catch(reject);
      });
    });
  }
  readLine(timeoutMs = 3e4) {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error("未连接"));
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.socket?.removeListener("data", onData);
        this.socket?.removeListener("error", onError);
        reject(new Error("IMAP readLine 超时"));
      }, timeoutMs);
      const done = (line) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.socket?.removeListener("data", onData);
        this.socket?.removeListener("error", onError);
        resolve(line);
      };
      const onError = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.socket?.removeListener("data", onData);
        reject(err);
      };
      const check = () => {
        const idx = this.buffer.indexOf("\r\n");
        if (idx >= 0) {
          const line = this.buffer.slice(0, idx);
          this.buffer = this.buffer.slice(idx + 2);
          done(line);
          return true;
        }
        return false;
      };
      if (check()) return;
      const onData = (chunk) => {
        this.buffer += chunk.toString();
        check();
      };
      this.socket.on("data", onData);
      this.socket.once("error", onError);
    });
  }
  async sendCommand(cmd) {
    if (!this.socket) throw new Error("未连接");
    this.tag++;
    const tagStr = `A${String(this.tag).padStart(3, "0")}`;
    this.socket.write(`${tagStr} ${cmd}\r
`);
    return tagStr;
  }
  async readUntilTag(tag) {
    const lines = [];
    while (true) {
      const line = await this.readLine();
      if (line.startsWith(`${tag} `)) return { lines, result: line };
      lines.push(line);
    }
  }
  async authenticate(email, accessToken) {
    const xoauth2 = buildXOAuth2(email, accessToken);
    const tag = await this.sendCommand(`AUTHENTICATE XOAUTH2 ${xoauth2}`);
    const { result } = await this.readUntilTag(tag);
    if (!result.includes("OK")) throw new Error(`认证失败: ${result}`);
    console.log("[IMAP] 认证成功");
    await sleep(800);
  }
  async selectInbox() {
    for (let retry = 0; retry < 3; retry++) {
      const tag = await this.sendCommand("SELECT INBOX");
      const { lines, result } = await this.readUntilTag(tag);
      if (result.includes("OK")) {
        for (const line of lines) {
          const m = line.match(/\*\s+(\d+)\s+EXISTS/);
          if (m) return parseInt(m[1], 10);
        }
        return 0;
      }
      if (retry < 2) {
        console.log(`[IMAP] SELECT INBOX 失败 (${result}), 重试 ${retry + 1}/3...`);
        await sleep((1 + retry) * 1e3);
      }
    }
    throw new Error("SELECT INBOX 重试耗尽");
  }
  async fetchLatestBody(seq) {
    if (seq <= 0) throw new Error("无效的邮件序号");
    const tag = await this.sendCommand(`FETCH ${seq} (BODY.PEEK[TEXT])`);
    const { lines, result } = await this.readUntilTag(tag);
    if (!result.includes("OK")) throw new Error(`FETCH TEXT 失败: ${result}`);
    const rawLines = [];
    let inBody = false;
    for (const line of lines) {
      if (line.includes("FETCH")) {
        inBody = true;
        continue;
      }
      if (line === ")") continue;
      if (inBody) rawLines.push(line);
    }
    const raw = rawLines.join("\n");
    const parts = raw.split("------=_Part_");
    let decoded = "";
    for (const part of parts) {
      if (part.includes("base64")) {
        const idx = part.indexOf("base64");
        const content = part.slice(idx + 6);
        const b64 = content.replace(/[\s]/g, "");
        try {
          decoded += Buffer.from(b64, "base64").toString() + " ";
        } catch {
        }
      }
    }
    if (decoded) return decoded;
    const cleaned = raw.replace(/[\s]/g, "");
    try {
      return Buffer.from(cleaned, "base64").toString();
    } catch {
      return raw;
    }
  }
  close() {
    if (this.socket) {
      try {
        this.socket.write("A999 LOGOUT\r\n");
      } catch {
      }
      this.socket.destroy();
      this.socket = null;
    }
  }
}
async function getInboxCount(acc) {
  const accessToken = await refreshOutlookToken(acc);
  const client = new IMAPClient();
  try {
    await client.connect();
    await client.authenticate(acc.email, accessToken);
    return await client.selectInbox();
  } finally {
    client.close();
  }
}
async function waitForOTP(acc, beforeCount, timeout, interval, signal) {
  console.log(`[Outlook IMAP] 等待验证码, 邮箱=${acc.email}, 发送前邮件数=${beforeCount}`);
  let accessToken = await refreshOutlookToken(acc);
  const maxRetries = Math.floor(timeout / interval);
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) throw new Error("注册已取消");
    let client = null;
    try {
      client = new IMAPClient();
      await client.connect();
      await client.authenticate(acc.email, accessToken);
      const total = await client.selectInbox();
      if (total <= beforeCount) {
        if (attempt % 5 === 0)
          console.log(`[Outlook IMAP] [${attempt}/${maxRetries}] 暂无新邮件 (当前${total}封)...`);
        await abortableSleep(interval * 1e3, signal);
        continue;
      }
      for (let i = total; i > beforeCount; i--) {
        try {
          const body = await client.fetchLatestBody(i);
          const code = extractCode(body);
          if (code) {
            console.log(`[Outlook IMAP] 获取到验证码: ${code}`);
            return code;
          }
        } catch {
        }
      }
      if (attempt % 5 === 0)
        console.log(`[Outlook IMAP] [${attempt}/${maxRetries}] 新邮件中未找到验证码...`);
    } catch (err) {
      if (attempt % 5 === 0) console.log(`[Outlook IMAP] 连接失败:`, err);
      try {
        accessToken = await refreshOutlookToken(acc);
      } catch {
      }
    } finally {
      client?.close();
    }
    await abortableSleep(interval * 1e3, signal);
  }
  throw new Error(`等待验证码超时 (${timeout}s)`);
}
class ProtonWebviewService {
  /** 本次注册使用的具体邮箱地址（母邮箱或其点号变体，由前端生成传入） */
  address;
  /** 日志回调：传入 registrar.this.log 时，取码日志会推送到注册页面日志面板；缺省回退 console */
  log;
  constructor(presetAddress, log) {
    this.address = (presetAddress || "").trim();
    if (!this.address) {
      throw new Error("Proton 邮箱地址为空");
    }
    this.log = log || ((m) => console.log(m));
  }
  async create() {
    this.log(`[Proton] 使用邮箱: ${this.address}`);
    return this.address;
  }
  getAddress() {
    return this.address;
  }
  async waitForCode(timeoutSec, intervalSec, signal) {
    return waitProtonOtp(this.address, {
      timeoutSec,
      intervalSec,
      signal,
      log: this.log
    });
  }
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
class Registrar {
  cfg;
  session = null;
  /** 共享的 ModuleClient（来自 tlsClientPool）；不在 cleanup 中 terminate，由进程退出时统一释放 */
  moduleClient = null;
  cookies = /* @__PURE__ */ new Map();
  identity;
  fpCtx;
  vid;
  email = "";
  emailSvc = null;
  clientId = "";
  clientSecret = "";
  deviceCode = "";
  userCode = "";
  workflowHandle = "";
  workflowId = "";
  workflowState = "";
  ubid = "";
  regCode = "";
  signState = "";
  authCode = "";
  ssoState = "";
  wdcCSRFToken = "";
  ssoToken = "";
  outlookMailCount = 0;
  log;
  onStep;
  abortController = new AbortController();
  chainRelay = null;
  chainTargetProxy = "";
  exitIP = "";
  tlsSessionId = newUUID();
  // 固定：整个 Registrar 生命周期内 DLL 中只注册一个 session
  constructor(cfg, log, onStep) {
    this.cfg = cfg;
    this.identity = randomIdentity();
    this.fpCtx = newFPContext(this.identity);
    this.vid = visitorId();
    const rawLog = log || ((msg) => console.log(msg));
    this.log = (msg) => rawLog(redactString(msg));
    this.onStep = onStep || (() => {
    });
  }
  /** 触发 step 事件：上层（前端 UI）可据此实时展示注册到了哪一步。失败时静默以不影响主流程。 */
  emitStep(name, info) {
    try {
      this.onStep({
        name,
        ts: Date.now(),
        email: this.email || void 0,
        exitIp: this.exitIP || void 0,
        ...info
      });
    } catch {
    }
  }
  /** 基于当前 identity 的 sec-ch-ua 头（动态生成，跟 chromeVer 对齐） */
  get secUA() {
    const major = this.identity.chromeVer.split(".")[0];
    return `"Chromium";v="${major}", "Not/A)Brand";v="24", "Google Chrome";v="${major}"`;
  }
  /** 中止当前注册流程 */
  abort() {
    this.abortController.abort();
  }
  /**
   * 启用代理链：若同时配置了 upstreamProxy(上游中转) 与 proxy(目标代理)，
   * 在本机起一个中继把链路串成「本机 → 中继 → 上游中转(非大陆) → 目标代理 → 目标站点」，
   * 并把 cfg.proxy 指向本地中继，使后续所有请求自动走链路。
   */
  async setupProxyChain() {
    const target = (this.cfg.proxy || "").trim();
    const upstream = (this.cfg.upstreamProxy || "").trim();
    if (!target || !upstream) return;
    try {
      this.chainRelay = new ChainProxyRelay(upstream, target, (m) => this.log(m));
      const relayUrl = await this.chainRelay.start();
      this.chainTargetProxy = target;
      this.cfg.proxy = relayUrl;
      this.log("[ProxyChain] 已启用代理链：本机 → 上游中转 → 目标代理 → 目标站点");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.chainRelay = null;
      if (this.cfg.strictProxy) {
        throw new Error(`[ProxyChain] 启用失败，严格代理模式已中止: ${msg}`);
      }
      this.log(`[ProxyChain] 启用失败，回退为直接使用目标代理: ${msg}`);
    }
  }
  checkAborted() {
    if (this.abortController.signal.aborted) throw new Error("注册已取消");
  }
  /**
   * 探测当前代理的出口 IP 并写入日志。
   * 如果探测失败且代理 URL 是参数化格式（bestproxy 等），自动换 session 重建代理链重试。
   * 最多重试 maxRetries 次（默认 2），保证拿到可用出口再继续注册。
   */
  async detectExitIP(maxRetries = 2) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const proxyUrl = this.sessionOpts.proxyUrl;
      try {
        const agent = safeCreateProxyAgent(proxyUrl);
        const resp = await undici.fetch("https://api.ipify.org?format=json", {
          method: "GET",
          dispatcher: agent || void 0,
          signal: AbortSignal.timeout(1e4),
          headers: { "User-Agent": this.identity.ua }
        });
        if (resp.ok) {
          const body = await resp.json();
          const ip = String(body.ip || body.query || body.origin || "").trim();
          if (ip) {
            this.exitIP = ip;
            this.emitStep("exit-ip", { exitIp: ip });
          }
          const via = proxyUrl ? proxyUrl.replace(/:([^:@/]+)@/, ":***@") : void 0;
          this.log(`[✓ IP] 出口 IP: ${ip || "未知"}${via ? ` (via ${via})` : " (直连)"}`);
          return;
        }
        this.log(`[IP] 出口 IP 检测失败: HTTP ${resp.status}`);
      } catch (err) {
        this.log(`[IP] 出口 IP 检测失败: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (attempt < maxRetries && this.canRefreshProxySession()) {
        this.log(`[IP] 换 session 重试 (${attempt + 1}/${maxRetries})...`);
        await this.refreshProxySession();
      }
    }
    this.log("[IP] 出口 IP 检测全部失败，继续注册流程");
  }
  /** 判断当前代理是否支持 session 轮换（参数化格式 + 含 _session- 或含 _area-/_life- 等） */
  canRefreshProxySession() {
    const target = this.chainTargetProxy || this.cfg.proxy || "";
    return /_(area|life|city|state|region|country)-/i.test(target);
  }
  /** 重新随机 session 并重建代理链 */
  async refreshProxySession() {
    const original = this.chainTargetProxy || this.cfg.proxy || "";
    if (!original) return;
    const session = Array.from(
      { length: 8 },
      () => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 62)]
    ).join("");
    let newTarget;
    if (/_session-[^_:@/]*/i.test(original)) {
      newTarget = original.replace(/(_session-)[^_:@/]*/i, `$1${session}`);
    } else {
      const atIdx = original.indexOf("@");
      const colonIdx = original.indexOf(":", original.indexOf("://") + 3);
      const insertPos = colonIdx > 0 && colonIdx < atIdx ? colonIdx : atIdx;
      newTarget = original.slice(0, insertPos) + `_session-${session}` + original.slice(insertPos);
    }
    this.log(`[IP] 新 session: ${newTarget.replace(/:([^:@/]+)@/, ":***@")}`);
    if (this.chainRelay) {
      await this.chainRelay.stop();
      this.chainRelay = null;
    }
    this.cfg.proxy = newTarget;
    this.chainTargetProxy = "";
    await this.setupProxyChain();
  }
  /** TLS SessionClient 选项 */
  get sessionOpts() {
    const explicit = this.cfg.proxy && this.cfg.proxy.trim() || void 0;
    if (this.cfg.strictProxy) {
      if (!explicit) {
        throw new Error("严格代理模式：cfg.proxy 为空，已中止以防止裸奔直连");
      }
    }
    const proxyUrl = this.cfg.strictProxy ? explicit : explicit || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || getSystemProxy() || void 0;
    return {
      tlsClientIdentifier: "chrome_146",
      // 25s：AWS 注册 API 正常响应 1-5s，慢住宅代理 10-15s；超过基本是挂起。
      // 配合 sendRequest 的 3 次重试，单步最坏 ~75s（旧值 60s 会到 ~180s，是批量卡 1-5 分钟主因）
      timeoutSeconds: 25,
      followRedirects: true,
      insecureSkipVerify: true,
      // 多线程隔离：固定 sessionId 隔离 DLL 层面共享的 TLS session cache
      // 整个 Registrar 生命周期内用同一个 ID，避免 rebuildTlsClient 产生僵尸 session
      sessionId: this.tlsSessionId,
      proxyUrl
    };
  }
  /**
   * 初始化 TLS 客户端
   *
   * DLL 存储策略（按优先级，从高到低）：
   *   1. userData/tls-client/ — 应用用户数据目录（系统不会清理，**永久复用**）
   *   2. resources/ — 应用安装目录（打包资源，开发版可能不存在）
   *   3. tmpdir → 自动迁移到 userData（老版本兼容）
   *   4. GitHub 下载到 userData（最后兜底，仅首次）
   */
  async initTlsClient() {
    const { existingPath, downloadDir } = this.ensureTlsLib();
    const opts = existingPath ? { customLibraryPath: existingPath } : { customLibraryDownloadPath: downloadDir };
    this.moduleClient = await acquireModuleClient(opts);
    this.log(
      "[TLS] using shared ModuleClient, pool stats: " + JSON.stringify(this.moduleClient.getPoolStats())
    );
    this.session = new tlsclientwrapper.SessionClient(this.moduleClient, this.sessionOpts);
  }
  /**
   * 确保 tls-client 共享库可用
   * @returns existingPath 已经存在的完整 DLL 文件路径（如有，传 customLibraryPath）
   *          downloadDir  需要下载到的目录（如未找到，传 customLibraryDownloadPath 让 tlsclientwrapper 自动下载）
   *
   * 优先放到 userData，避免被系统临时目录清理工具误删（之前用 tmpdir 会被清理）
   */
  ensureTlsLib() {
    const os = require("os");
    const path2 = require("path");
    const fs2 = require("fs");
    const { app } = require("electron");
    const platform = os.platform();
    const arch = os.arch();
    let filename = "tls-client-xgo-1.14.0-";
    if (platform === "win32") {
      filename += (arch.includes("64") ? "windows-amd64" : "windows-386") + ".dll";
    } else if (platform === "darwin") {
      filename += (arch === "arm64" ? "darwin-arm64" : "darwin-amd64") + ".dylib";
    } else {
      filename += (arch === "arm64" ? "linux-arm64" : "linux-amd64") + ".so";
    }
    const userDataDir = app.getPath("userData");
    const tlsClientDir = path2.join(userDataDir, "tls-client");
    const finalPath = path2.join(tlsClientDir, filename);
    try {
      fs2.mkdirSync(tlsClientDir, { recursive: true });
    } catch {
    }
    if (fs2.existsSync(finalPath)) {
      this.log("[TLS] Library reused from userData (persistent): " + finalPath);
      return { existingPath: finalPath, downloadDir: tlsClientDir };
    }
    const resourcePath = path2.join(process.resourcesPath || "", filename);
    if (fs2.existsSync(resourcePath)) {
      this.log(
        "[TLS] Copying library from resources to userData (one-time): " + resourcePath + " -> " + finalPath
      );
      try {
        fs2.copyFileSync(resourcePath, finalPath);
        return { existingPath: finalPath, downloadDir: tlsClientDir };
      } catch (err) {
        this.log("[TLS] Failed to copy from resources: " + err.message);
      }
    }
    const tmpPath = path2.join(os.tmpdir(), filename);
    if (fs2.existsSync(tmpPath)) {
      this.log("[TLS] Migrating library from tmpdir to userData: " + tmpPath + " -> " + finalPath);
      try {
        fs2.copyFileSync(tmpPath, finalPath);
        return { existingPath: finalPath, downloadDir: tlsClientDir };
      } catch (err) {
        this.log("[TLS] Migration failed, will use tmpdir as fallback: " + err.message);
        return { existingPath: tmpPath, downloadDir: tlsClientDir };
      }
    }
    this.log(
      "[TLS] Library not found, will download from GitHub to userData (one-time): " + tlsClientDir
    );
    return { downloadDir: tlsClientDir };
  }
  async rebuildTlsClient() {
    try {
      await this.session?.destroySession();
    } catch {
    }
    if (!this.moduleClient) {
      await this.initTlsClient();
      return;
    }
    this.session = new tlsclientwrapper.SessionClient(this.moduleClient, this.sessionOpts);
  }
  /**
   * 用 undici 直接 fetch 静态资源（如 AWS signin app.js），绕过 tls-client。
   * 原因：tls-client 的 dll 是进程级单例，失败请求会污染其全局状态，
   * 导致后续重建 SessionClient 后仍报 "no tls client for modification check"。
   * 静态资源不需要 TLS 指纹伪装，直接用 Node/undici fetch 即可。
   */
  async fetchAppJS(url, init) {
    const proxyUrl = this.cfg.proxy && this.cfg.proxy.trim() || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || getSystemProxy() || void 0;
    const agent = safeCreateProxyAgent(proxyUrl);
    if (agent) {
      const resp = await undici.fetch(url, { ...init, dispatcher: agent });
      return resp;
    }
    return await fetch(url, init);
  }
  isRecoverableTlsClientError(err) {
    if (!(err instanceof Error)) return false;
    return err.message.includes("EOF") || err.message.includes("no tls client for modification check") || err.message.includes("failed to modify existing client");
  }
  /** 清理 TLS 客户端资源：仅销毁 SessionClient；ModuleClient 是进程级共享池，不再每次 terminate */
  async cleanup() {
    if (this.chainRelay) {
      try {
        await this.chainRelay.stop();
      } catch {
      }
      this.chainRelay = null;
    }
    if (this.session) {
      const s = this.session;
      this.session = null;
      try {
        await Promise.race([
          s.destroySession(),
          new Promise((resolve) => setTimeout(resolve, 3e3))
        ]);
      } catch {
      }
    }
    this.moduleClient = null;
  }
  /** 公共销毁方法，供外部调用释放资源。同时 abort 所有进行中的异步操作。 */
  async destroy() {
    this.abortController.abort();
    await this.cleanup();
  }
  // ============ HTTP 工具方法 ============
  cookieString() {
    return Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
  }
  buildHeaders(referer, origin) {
    const h = {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      "Content-Type": "application/json",
      "User-Agent": this.identity.ua,
      "sec-ch-ua": this.secUA,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin"
    };
    if (referer) h["Referer"] = referer;
    if (origin) h["Origin"] = origin;
    if (this.cookies.size > 0) h["Cookie"] = this.cookieString();
    return h;
  }
  buildProfileHeaders(referer) {
    const h = {
      Accept: "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Content-Type": "application/json;charset=UTF-8",
      "User-Agent": this.identity.ua,
      Origin: this.cfg.profileBase,
      Referer: referer,
      "sec-ch-ua": this.secUA,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      priority: "u=1, i"
    };
    const keys = ["awsccc", "aws-user-profile-ubid", "i18next"];
    if (this.cookies.has("awsd2c-token")) keys.push("awsd2c-token", "awsd2c-token-c");
    const parts = keys.filter((k) => this.cookies.has(k)).map((k) => `${k}=${this.cookies.get(k)}`);
    if (parts.length) h["Cookie"] = parts.join("; ");
    return h;
  }
  async doGet(url, headers) {
    return this.sendRequest("GET", url, headers);
  }
  async doPost(url, payload, headers) {
    return this.sendRequest("POST", url, headers, JSON.stringify(payload));
  }
  /** 网络层退避时长：指数 + 抖动（约 0.8s / 1.6s / 3.2s，封顶 8s） */
  netBackoffMs(attempt) {
    const base = Math.min(800 * Math.pow(2, attempt - 1), 8e3);
    return base + Math.floor(Math.random() * 400);
  }
  /**
   * 判断响应是否为「瞬时失败」需要重试。
   * 关键：tlsclientwrapper 会把连接层失败（EOF / 重置 / 超时）包装成 status=0 + body 错误描述，
   * 并不抛异常；若不在响应层识别，会被上层当成业务失败直接判死号（如 #9 的「未获取到加密公钥」）。
   */
  isTransientResponse(status, body) {
    if (status === 0 || status === 429 || status === 502 || status === 503 || status === 504)
      return true;
    const lower = body.toLowerCase();
    return lower.includes("failed to do request") || lower.includes("eof") || lower.includes("connection reset") || lower.includes("timeout");
  }
  /**
   * 判断是否为「超时类」失败（出口 IP 慢 / 被限流 / 隧道挂起）。
   * 这类失败重建 TLS（同 IP 重连）无用，应换 proxy session 切换出口 IP。
   */
  isTimeoutResponse(status, body) {
    if (status === 504) return true;
    if (status !== 0) return false;
    const lower = body.toLowerCase();
    return lower.includes("timeout") || lower.includes("deadline") || lower.includes("client.timeout") || lower.includes("failed to do request");
  }
  /**
   * 统一的 TLS 请求发送：对瞬时网络失败（status=0 / EOF / 5xx / 429）自动「重建 TLS + 指数退避」重试。
   * 连接类失败才重建客户端，限流类仅退避；cookies 存于 this.cookies，不随重建丢失。
   */
  async sendRequest(method, url, headers, body) {
    if (!this.session) throw new Error("TLS 客户端未初始化");
    const maxAttempts = 3;
    let lastErr = null;
    let sessionRefreshed = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const resp = method === "GET" ? await this.session.get(url, { headers }) : await this.session.post(url, body ?? "", { headers });
        const decoded = this.decodeBody(resp.body);
        const status = resp.status;
        if (attempt < maxAttempts && this.isTransientResponse(status, decoded)) {
          const broken = status === 0 || /eof|reset|failed to do request/i.test(decoded);
          if (this.isTimeoutResponse(status, decoded) && !sessionRefreshed && this.canRefreshProxySession()) {
            this.log(
              `[Net] ${method} 超时(status=${status})，换 proxy session 切换出口 IP 重试 ${attempt}/${maxAttempts - 1}`
            );
            try {
              await this.refreshProxySession();
              await this.rebuildTlsClient();
              sessionRefreshed = true;
            } catch (e) {
              this.log(
                `[Net] 换 session 失败，回退普通重建: ${e instanceof Error ? e.message : String(e)}`
              );
              await this.rebuildTlsClient();
            }
          } else {
            this.log(
              `[Net] ${method} 瞬时失败 status=${status}，${broken ? "重建 TLS + " : ""}退避重试 ${attempt}/${maxAttempts - 1}`
            );
            if (broken) await this.rebuildTlsClient();
          }
          await this.abortableSleep(this.netBackoffMs(attempt));
          continue;
        }
        return {
          body: decoded,
          status,
          headers: resp.headers || {}
        };
      } catch (err) {
        lastErr = err;
        if (attempt < maxAttempts && this.isRecoverableTlsClientError(err)) {
          this.log(
            `[TLS] ${method} 可恢复错误：${err instanceof Error ? err.message : String(err)}，重建 TLS 退避重试 ${attempt}/${maxAttempts - 1}`
          );
          await this.rebuildTlsClient();
          await this.abortableSleep(this.netBackoffMs(attempt));
          continue;
        }
        throw err;
      }
    }
    if (lastErr) throw lastErr;
    throw new Error(`${method} ${url} 重试 ${maxAttempts} 次仍失败`);
  }
  /** 可被中止打断的 sleep：停止注册时立即结束等待，让 abort 即时生效 */
  abortableSleep(ms) {
    const signal = this.abortController.signal;
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("注册已取消"));
        return;
      }
      let timer;
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("注册已取消"));
      };
      timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  /** 拟人随机延迟：步骤之间停顿，降低机械化节奏特征 */
  async humanDelay(min = 280, max = 1200) {
    await this.abortableSleep(min + Math.floor(Math.random() * Math.max(1, max - min)));
  }
  /**
   * 整体超时看门狗：给任意步骤 Promise 加上限，超时后 reject（原 Promise 在后台自生自灭）。
   * 用于批量场景快速释放卡住的线程，避免单个账号占用并发槽 1-5 分钟。支持 abort 即时中断。
   */
  withTimeout(p, ms, label) {
    const signal = this.abortController.signal;
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("注册已取消"));
        return;
      }
      let done = false;
      const settle = (fn) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        fn();
      };
      const timer = setTimeout(
        () => settle(() => reject(new Error(`${label} 整体超时 ${Math.round(ms / 1e3)}s`))),
        ms
      );
      const onAbort = () => settle(() => reject(new Error("注册已取消")));
      signal.addEventListener("abort", onAbort, { once: true });
      p.then(
        (v) => settle(() => resolve(v)),
        (e) => settle(() => reject(e))
      );
    });
  }
  /**
   * 幂等步骤重试：失败后退避重试（仅用于无副作用的前置步骤，如 OIDC / Device / Portal / WorkflowInit）。
   * - timeoutMs：每次尝试加整体超时看门狗，超时即判失败进入下一次（防止单次卡满 3×25s）
   * - refreshSession：失败后若代理支持，换 proxy session 切换出口 IP 再退避（避开慢/被限的 IP）
   */
  async retryStep(name, fn, attempts, opts) {
    let lastErr = null;
    for (let i = 1; i <= attempts; i++) {
      try {
        if (opts?.timeoutMs) await this.withTimeout(fn(), opts.timeoutMs, name);
        else await fn();
        return;
      } catch (err) {
        lastErr = err;
        if (i < attempts) {
          if (opts?.refreshSession && this.canRefreshProxySession()) {
            try {
              await this.refreshProxySession();
              await this.rebuildTlsClient();
              this.log(`[${name}] 已换 proxy session 切换出口 IP`);
            } catch {
            }
          }
          const wait = 1500 * i + Math.floor(Math.random() * 800);
          this.log(
            `[${name}] 第 ${i}/${attempts} 次失败：${err.message}，${wait}ms 后重试`
          );
          await this.abortableSleep(wait);
        }
      }
    }
    throw lastErr;
  }
  /**
   * tls-client 返回的 body 是字节透传字符串（latin1）；
   * 如果响应实际是 UTF-8 编码（含中文等多字节），需要二次解码。
   * 实现：把 string 当作 latin1 字节读回，再用 UTF-8 解码；
   * 若解码后含 U+FFFD 替换字符比原文多很多，则回退原值（说明原本就是 latin1 / ASCII）。
   */
  decodeBody(body) {
    if (!body) return "";
    try {
      if (/^[\x00-\x7F]*$/.test(body)) return body;
      const buf = Buffer.from(body, "latin1");
      const utf8 = buf.toString("utf-8");
      const replaceInOriginal = (body.match(/\uFFFD/g) || []).length;
      const replaceInUtf8 = (utf8.match(/\uFFFD/g) || []).length;
      if (replaceInUtf8 > replaceInOriginal + 2) return body;
      return utf8;
    } catch {
      return body;
    }
  }
  parseBody(body) {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  /**
   * 识别 AWS 风控触发的错误响应，返回人类可读的标签
   * @returns 风控类型标签（如 'AWS-RISK-CONTROL'），不是风控返回 null
   */
  detectRiskControl(body, status) {
    if (status !== 400) return null;
    const lower = body.toLowerCase();
    if (body.includes("请稍后再试") && body.includes("管理员")) return "AWS-RISK-CONTROL";
    if (body.includes("发生意外错误")) return "AWS-RISK-CONTROL";
    if (lower.includes("try again later") && lower.includes("administrator"))
      return "AWS-RISK-CONTROL";
    if (lower.includes("unexpected error") && lower.includes("contact")) return "AWS-RISK-CONTROL";
    return null;
  }
  /** 把响应错误格式化为更友好的消息（含风控识别） */
  formatErrorBody(body, status) {
    const risk = this.detectRiskControl(body, status);
    if (risk) {
      return `${risk}（AWS 风控，建议：1) 启用代理池 N:1 分桶；2) 启用限速 + 风控自动暂停；3) 避免同邮箱域名大量注册）`;
    }
    return `status=${status} body=${body.substring(0, 200)}`;
  }
  async fetchD2CToken(origin, referer) {
    const headers = {
      Accept: "*/*",
      "Content-Type": "application/json",
      "User-Agent": this.identity.ua,
      Origin: origin,
      Referer: referer,
      "sec-ch-ua": this.secUA,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "cross-site",
      priority: "u=1, i"
    };
    const parts = [];
    if (this.cookies.has("awsccc")) parts.push("awsccc=" + this.cookies.get("awsccc"));
    if (this.cookies.has("awsd2c-token")) {
      const old = this.cookies.get("awsd2c-token");
      parts.push("awsd2c-token=" + old, "awsd2c-token-c=" + old);
    }
    if (parts.length) headers["Cookie"] = parts.join("; ");
    const payload = {};
    if (this.cookies.has("awsd2c-token")) payload.token = this.cookies.get("awsd2c-token");
    const resp = await this.doPost("https://vs.aws.amazon.com/token", payload, headers);
    saveCookies(this.cookies, resp.headers);
    const data = this.parseBody(resp.body);
    const tok = data.token;
    if (tok) {
      this.cookies.set("awsd2c-token", tok);
      this.cookies.set("awsd2c-token-c", tok);
      const jwtParts = tok.split(".");
      if (jwtParts.length >= 2) {
        try {
          const decoded = JSON.parse(Buffer.from(jwtParts[1], "base64url").toString());
          if (decoded.vid) this.vid = decoded.vid;
        } catch {
        }
      }
    }
  }
  // ============ 指纹生成 ============
  genFP(pageType, eventType, emailLen, emailAddr) {
    return this.genFPWithTime(pageType, eventType, 0, emailLen, emailAddr);
  }
  genFPWithTime(pageType, eventType, timeOnPage, emailLen, emailAddr) {
    const did = this.cfg.directoryId;
    let loc = "", ref = "";
    switch (pageType) {
      case "signin":
        loc = `${this.cfg.signinBase}/platform/${did}/login?workflowStateHandle=${this.workflowHandle}`;
        break;
      case "signup":
        loc = `${this.cfg.signinBase}/platform/${did}/signup?workflowStateHandle=${this.workflowHandle}`;
        break;
      default:
        if (eventType === "PageSubmit") {
          loc = `${this.cfg.profileBase}/?workflowID=${this.workflowId}#/signup/enter-email`;
        } else {
          loc = `${this.cfg.profileBase}/?workflowID=${this.workflowId}#/signup/start`;
        }
        if (!this.workflowId) loc = this.cfg.profileBase + "/";
    }
    if (pageType === "profile") {
      ref = `${this.cfg.signinBase}/platform/${did}/signup?workflowStateHandle=${this.workflowHandle}`;
    } else {
      ref = this.cfg.viewBase + "/";
    }
    return generateFingerprint(
      this.identity,
      loc,
      ref,
      this.fpCtx,
      pageType,
      eventType,
      timeOnPage,
      emailLen,
      emailAddr
    );
  }
  // ============ 注册步骤 ============
  async step1OIDC() {
    this.emitStep("oidc");
    this.log("[1] OIDC 注册");
    const payload = {
      clientName: "Amazon Q Developer for command line",
      clientType: "public",
      scopes: [
        "codewhisperer:completions",
        "codewhisperer:analysis",
        "codewhisperer:conversations",
        "codewhisperer:transformations",
        "codewhisperer:taskassist"
      ]
    };
    const headers = { "Content-Type": "application/json" };
    let resp = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        resp = await this.doPost(this.cfg.oidcBase + "/client/register", payload, headers);
        if (resp.status === 200) break;
      } catch (err) {
        if (attempt < 2) {
          this.log(`[1] OIDC 重试 (${attempt + 1}/3)...`);
          await this.abortableSleep(2e3 * (attempt + 1));
          await this.rebuildTlsClient();
          continue;
        }
        throw err;
      }
    }
    if (!resp) throw new Error("OIDC 注册失败: 所有重试均失败");
    const data = this.parseBody(resp.body);
    this.clientId = data.clientId || "";
    this.clientSecret = data.clientSecret || "";
    if (!this.clientId) throw new Error(`OIDC 注册失败: ${resp.body.slice(0, 200)}`);
  }
  async step2Device() {
    this.emitStep("device");
    this.log("[2] 设备授权");
    const resp = await this.doPost(
      this.cfg.oidcBase + "/device_authorization",
      {
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        startUrl: this.cfg.startURL
      },
      { "Content-Type": "application/json" }
    );
    const data = this.parseBody(resp.body);
    this.deviceCode = data.deviceCode || "";
    this.userCode = data.userCode || "";
    this.log(`user_code=${this.userCode}`);
  }
  async step3Email() {
    if (this.cfg.manualMode) return;
    if (this.cfg.useOutlook && this.cfg.outlookData) {
      this.log("[3] 使用 Outlook 邮箱");
      const accounts = parseOutlookLines(this.cfg.outlookData);
      if (accounts.length === 0) throw new Error("无可用的 Outlook 账号");
      const acc = accounts.length === 1 ? accounts[0] : accounts[Math.floor(Math.random() * accounts.length)];
      this.email = acc.email;
      this.emitStep("email-created");
      this.log(`email=${this.email}`);
      return;
    }
    if (this.cfg.useTempMailPlus) {
      this.log("[3] 使用自建域名邮箱 (TempMail.Plus)");
      if (!this.cfg.tempMailPlusEmail || !this.cfg.tempMailPlusEpin || !this.cfg.tempMailPlusDomain) {
        throw new Error("TempMail.Plus 配置不完整");
      }
      this.emailSvc = new TempMailPlusService(
        this.cfg.tempMailPlusEmail,
        this.cfg.tempMailPlusEpin,
        this.cfg.tempMailPlusDomain
      );
      this.email = await this.emailSvc.create();
      if (!this.email) throw new Error("生成邮箱地址失败");
      this.emitStep("email-created");
      this.log(`email=${this.email}`);
      return;
    }
    if (this.cfg.useProton) {
      this.log("[3] 使用 Proton 邮箱 (点号别名)");
      if (!this.cfg.protonEmail) {
        throw new Error("Proton 邮箱地址未配置");
      }
      this.emailSvc = new ProtonWebviewService(this.cfg.protonEmail, (m) => this.log(m));
      this.email = await this.emailSvc.create();
      if (!this.email) throw new Error("Proton 邮箱地址为空");
      this.emitStep("email-created");
      this.log(`email=${this.email}`);
      return;
    }
    if (this.cfg.useGptMail) {
      const mode = this.cfg.gptMailInboxEmail ? `CF 转发 → ${this.cfg.gptMailInboxEmail}` : this.cfg.gptMailPrivatePassword ? "私有域名直收（带密码）" : "私有域名直收";
      this.log(`[3] 使用 GPTmail (${mode}) → mail.chatgpt.org.uk`);
      if (!this.cfg.gptMailDomain) {
        throw new Error("GPTmail 域名未配置");
      }
      if (!this.session)
        throw new Error("TLS SessionClient 未初始化，无法启动 GPTmail（请检查代理）");
      this.emailSvc = new GptMailService({
        baseURL: this.cfg.gptMailBaseURL,
        inboxEmail: this.cfg.gptMailInboxEmail,
        domain: this.cfg.gptMailDomain,
        prefix: this.cfg.gptMailPrefix,
        privatePassword: this.cfg.gptMailPrivatePassword,
        // 传 getter 而非快照：Registrar 后续 rebuildTlsClient() 会换 session 实例，
        // GptMailService 每次请求都读这里的最新引用，避免用到已 destroyed 的旧 session
        getSession: () => this.session
      });
      this.email = await this.emailSvc.create();
      if (!this.email) throw new Error("生成 GPTmail 注册邮箱失败");
      this.emitStep("email-created");
      this.log(`email=${this.email}`);
      return;
    }
    this.log("[3] 创建临时邮箱");
    if (!this.cfg.moEmailBaseURL) throw new Error("MoEmail 未配置");
    this.emailSvc = new MoEmailService(this.cfg.moEmailBaseURL, this.cfg.moEmailAPIKey);
    this.email = await this.emailSvc.create();
    if (!this.email) throw new Error("创建临时邮箱失败");
    this.emitStep("email-created");
    this.log(`email=${this.email}`);
  }
  async step4Portal() {
    this.emitStep("portal");
    this.log("[4] Portal 初始化");
    this.cookies.set("awsccc", awsccc());
    const redirect = `${this.cfg.viewBase}/start/#/device?user_code=${this.userCode}`;
    const url = `${this.cfg.portalBase}/login?directory_id=view&redirect_url=${redirect}`;
    const h = {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      Origin: this.cfg.viewBase,
      Referer: this.cfg.viewBase + "/",
      "User-Agent": this.identity.ua
    };
    const resp = await this.doGet(url, h);
    saveCookies(this.cookies, resp.headers);
    const data = this.parseBody(resp.body);
    const rurl = data.redirectUrl || "";
    if (rurl.includes("workflowStateHandle=")) {
      this.workflowHandle = splitAfter(rurl, "workflowStateHandle=");
    }
    if (data.csrfToken) this.cookies.set("loginCsrfToken", data.csrfToken);
    if (!this.workflowHandle) throw new Error("Portal 未返回 workflow handle");
    const loginURL = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/login?workflowStateHandle=${this.workflowHandle}`;
    await this.fetchD2CToken(this.cfg.signinBase, loginURL);
  }
  async step5WorkflowInit() {
    this.emitStep("workflow-init");
    this.log("[5] 工作流初始化");
    const api = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/api/execute`;
    const ref = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/login?workflowStateHandle=${this.workflowHandle}`;
    let fp = this.genFP("signin", "first_load", 0, "");
    let rid = newUUID();
    let h = this.buildHeaders(ref, this.cfg.signinBase);
    h["x-amzn-requestid"] = rid;
    h["x-amz-date"] = gmtDate();
    h["priority"] = "u=1, i";
    let resp = await this.doPost(
      api,
      {
        stepId: "",
        workflowStateHandle: this.workflowHandle,
        inputs: [{ input_type: "FingerPrintRequestInput", fingerPrint: fp }],
        requestId: rid
      },
      h
    );
    saveCookies(this.cookies, resp.headers);
    let data = this.parseBody(resp.body);
    if (data.workflowStateHandle) this.workflowHandle = data.workflowStateHandle;
    if (data.stepId === "start") {
      fp = this.genFP("signin", "PageLoad", 0, "");
      rid = newUUID();
      h = this.buildHeaders(ref, this.cfg.signinBase);
      h["x-amzn-requestid"] = rid;
      h["x-amz-date"] = gmtDate();
      h["priority"] = "u=1, i";
      resp = await this.doPost(
        api,
        {
          stepId: "start",
          workflowStateHandle: this.workflowHandle,
          inputs: [{ input_type: "FingerPrintRequestInput", fingerPrint: fp }],
          requestId: rid
        },
        h
      );
      saveCookies(this.cookies, resp.headers);
      data = this.parseBody(resp.body);
      if (data.workflowStateHandle) this.workflowHandle = data.workflowStateHandle;
    }
  }
  async step6SubmitEmail() {
    this.emitStep("submit-email");
    this.log(`[6] 提交邮箱 ${this.email}`);
    const api = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/api/execute`;
    const ref = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/login?workflowStateHandle=${this.workflowHandle}`;
    const fp = this.genFP("signin", "PageSubmit", this.email.length, this.email);
    const rid = newUUID();
    const h = this.buildHeaders(ref, this.cfg.signinBase);
    h["x-amzn-requestid"] = rid;
    h["x-amz-date"] = gmtDate();
    h["priority"] = "u=1, i";
    const resp = await this.doPost(
      api,
      {
        stepId: "get-identity-user",
        workflowStateHandle: this.workflowHandle,
        actionId: "SUBMIT",
        inputs: [
          { input_type: "UserRequestInput", username: this.email },
          { input_type: "ApplicationTypeRequestInput", applicationType: "SSO_INDIVIDUAL_ID" },
          {
            input_type: "UserEventRequestInput",
            directoryId: this.cfg.directoryId,
            userName: this.email,
            userEvents: [
              {
                input_type: "UserEvent",
                eventType: "PAGE_SUBMIT",
                pageName: "IDENTIFICATION",
                timeSpentOnPage: 5e3
              }
            ]
          },
          { input_type: "FingerPrintRequestInput", fingerPrint: fp }
        ],
        visitorId: this.vid,
        requestId: rid
      },
      h
    );
    saveCookies(this.cookies, resp.headers);
    const data = this.parseBody(resp.body);
    if (data.workflowStateHandle) this.workflowHandle = data.workflowStateHandle;
    if (resp.status === 400) return "signup";
    if (resp.status === 200) return "login";
    throw new Error(`提交邮箱失败: ${resp.status} - ${resp.body.slice(0, 200)}`);
  }
  async step7Signup() {
    this.emitStep("signup");
    this.log("[7] 注册 (SIGNUP)");
    const api = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/api/execute`;
    const ref = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/login?workflowStateHandle=${this.workflowHandle}`;
    const fp = this.genFP("signup", "PageSubmit", 0, "");
    const rid = newUUID();
    const h = this.buildHeaders(ref, this.cfg.signinBase);
    h["x-amzn-requestid"] = rid;
    h["x-amz-date"] = gmtDate();
    h["priority"] = "u=1, i";
    const resp = await this.doPost(
      api,
      {
        stepId: "get-identity-user",
        workflowStateHandle: this.workflowHandle,
        actionId: "SIGNUP",
        inputs: [
          { input_type: "UserRequestInput", username: this.email },
          { input_type: "FingerPrintRequestInput", fingerPrint: fp }
        ],
        visitorId: this.vid,
        requestId: rid
      },
      h
    );
    saveCookies(this.cookies, resp.headers);
    const data = this.parseBody(resp.body);
    const redir = data.redirect;
    const rurl = redir?.url;
    if (rurl?.includes("workflowStateHandle=")) {
      this.workflowHandle = splitAfter(rurl, "workflowStateHandle=");
    }
  }
  async step7_5SignupInit() {
    this.log("[7.5] Signup API 初始化");
    const api = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/signup/api/execute`;
    const ref = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/signup?workflowStateHandle=${this.workflowHandle}`;
    let fp = this.genFP("signup", "first_load", 0, "");
    let rid = newUUID();
    let h = this.buildHeaders(ref, this.cfg.signinBase);
    h["x-amzn-requestid"] = rid;
    h["x-amz-date"] = gmtDate();
    h["priority"] = "u=1, i";
    let resp = await this.doPost(
      api,
      {
        stepId: "",
        workflowStateHandle: this.workflowHandle,
        inputs: [
          { input_type: "UserRequestInput", username: this.email },
          { input_type: "FingerPrintRequestInput", fingerPrint: fp }
        ],
        visitorId: this.vid,
        requestId: rid
      },
      h
    );
    saveCookies(this.cookies, resp.headers);
    let data = this.parseBody(resp.body);
    if (data.workflowStateHandle) this.workflowHandle = data.workflowStateHandle;
    if (data.stepId !== "start")
      throw new Error(`Signup init 失败: ${this.formatErrorBody(resp.body, resp.status)}`);
    fp = this.genFP("signup", "PageLoad", 0, "");
    rid = newUUID();
    h = this.buildHeaders(ref, this.cfg.signinBase);
    h["x-amzn-requestid"] = rid;
    h["x-amz-date"] = gmtDate();
    h["priority"] = "u=1, i";
    resp = await this.doPost(
      api,
      {
        stepId: "start",
        workflowStateHandle: this.workflowHandle,
        inputs: [
          { input_type: "UserRequestInput", username: this.email },
          { input_type: "FingerPrintRequestInput", fingerPrint: fp }
        ],
        visitorId: this.vid,
        requestId: rid
      },
      h
    );
    saveCookies(this.cookies, resp.headers);
    data = this.parseBody(resp.body);
    if (data.workflowStateHandle) this.workflowHandle = data.workflowStateHandle;
    const redir = data.redirect;
    const rurl = redir?.url;
    if (rurl?.includes("workflowID=")) {
      let wid = splitAfter(rurl, "workflowID=");
      const hashIdx = wid.indexOf("#");
      if (hashIdx >= 0) wid = wid.slice(0, hashIdx);
      this.workflowId = wid;
    }
    if (!this.workflowId) throw new Error("Signup init 未返回 workflowID");
  }
  async step7_8ProfileInit() {
    this.log("[7.8] Profile 页面初始化");
    this.ubid = ubidGen();
    this.cookies.set("aws-user-profile-ubid", this.ubid);
    this.cookies.set("i18next", "zh-CN");
    if (!this.cookies.has("awsccc")) this.cookies.set("awsccc", awsccc());
    const url = `${this.cfg.profileBase}/?workflowID=${this.workflowId}`;
    const resp = await this.doGet(url, {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "User-Agent": this.identity.ua,
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate"
    });
    saveCookies(this.cookies, resp.headers);
    resetPerfTiming(this.fpCtx);
    await this.fetchD2CToken(this.cfg.profileBase, url);
  }
  async step8ProfileStart() {
    this.log("[8] Profile 启动");
    const ref = `${this.cfg.profileBase}/?workflowID=${this.workflowId}`;
    const fp = this.genFP("profile", "PageLoad", 0, "");
    const resp = await this.doPost(
      this.cfg.profileBase + "/api/start",
      {
        workflowID: this.workflowId,
        browserData: {
          attributes: {
            fingerprint: fp,
            eventTimestamp: (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, ".000Z"),
            timeSpentOnPage: "38",
            eventType: "PageLoad",
            ubid: this.ubid,
            visitorId: this.vid
          },
          cookies: {}
        }
      },
      this.buildProfileHeaders(ref)
    );
    const data = this.parseBody(resp.body);
    this.workflowState = data.workflowState || "";
    if (!this.workflowState)
      throw new Error(`Profile start 未返回 workflowState: ${resp.body.slice(0, 200)}`);
  }
  async step9SendOTP() {
    this.emitStep("send-otp");
    this.log("[9] 发送验证码");
    if (this.cfg.useOutlook && this.cfg.outlookData) {
      const accounts = parseOutlookLines(this.cfg.outlookData);
      const acc = accounts.find((a) => a.email === this.email);
      if (acc) {
        try {
          this.outlookMailCount = await getInboxCount(acc);
          this.log(`发送前邮件数: ${this.outlookMailCount}`);
        } catch (err) {
          this.log(`获取邮件数量失败: ${err}, 默认为0`);
        }
      }
    }
    const ref = `${this.cfg.profileBase}/?workflowID=${this.workflowId}`;
    const timeOnPage = 5e3 + Math.floor(Math.random() * 3001);
    const fp = this.genFPWithTime(
      "profile",
      "PageSubmit",
      timeOnPage,
      this.email.length,
      this.email
    );
    const tsp = String(timeOnPage);
    const payload = {
      workflowState: this.workflowState,
      email: this.email,
      browserData: {
        attributes: {
          fingerprint: fp,
          eventTimestamp: (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, ".000Z"),
          timeSpentOnPage: tsp,
          pageName: "EMAIL_COLLECTION",
          eventType: "PageSubmit",
          ubid: this.ubid,
          visitorId: this.vid
        },
        cookies: {}
      }
    };
    const resp = await this.doPost(
      this.cfg.profileBase + "/api/send-otp",
      payload,
      this.buildProfileHeaders(ref)
    );
    if (resp.status !== 200)
      throw new Error(`send-otp 失败 (${resp.status}), body: ${resp.body.substring(0, 300)}`);
    this.log("验证码已发送");
  }
  async step10GetOTP() {
    if (this.cfg.manualMode) throw new Error("手动模式需外部提供验证码");
    this.emitStep("waiting-otp");
    this.log("[10] 等待验证码");
    const signal = this.abortController.signal;
    if (this.cfg.useOutlook && this.cfg.outlookData) {
      const accounts = parseOutlookLines(this.cfg.outlookData);
      const acc = accounts.find((a) => a.email === this.email);
      if (!acc) throw new Error("未找到对应 Outlook 账号");
      return await waitForOTP(acc, this.outlookMailCount, 120, 5, signal);
    }
    if (!this.emailSvc) throw new Error("邮箱服务未初始化");
    return await this.emailSvc.waitForCode(120, 3, signal);
  }
  async step11CreateIdentity(otp) {
    this.emitStep("otp-received");
    this.emitStep("create-identity");
    this.log("[11] 创建身份");
    const ref = `${this.cfg.profileBase}/?workflowID=${this.workflowId}`;
    const fp = this.genFP("profile", "EmailVerification", 0, "");
    const resp = await this.doPost(
      this.cfg.profileBase + "/api/create-identity",
      {
        workflowState: this.workflowState,
        userData: { email: this.email, fullName: this.cfg.fullName },
        otpCode: otp,
        browserData: {
          attributes: {
            fingerprint: fp,
            eventTimestamp: (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, ".000Z"),
            timeSpentOnPage: "45000",
            pageName: "EMAIL_VERIFICATION",
            eventType: "EmailVerification",
            ubid: this.ubid,
            visitorId: this.vid
          },
          cookies: {}
        }
      },
      this.buildProfileHeaders(ref)
    );
    const data = this.parseBody(resp.body);
    this.regCode = data.registrationCode || "";
    this.signState = data.signInState || "";
    if (!this.regCode)
      throw new Error(`create-identity 未返回 registrationCode: ${resp.body.slice(0, 200)}`);
  }
  async step12SetPassword() {
    this.emitStep("set-password");
    this.log("[12] 设置密码");
    const api = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/signup/api/execute`;
    const ref = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/signup?registrationCode=${this.regCode}&state=${this.signState}`;
    let fp = this.genFP("signup", "PageSubmit", 0, "");
    let rid = newUUID();
    let h = this.buildHeaders(ref, this.cfg.signinBase);
    h["x-amzn-requestid"] = rid;
    h["x-amz-date"] = gmtDate();
    h["priority"] = "u=1, i";
    let resp = await this.doPost(
      api,
      {
        stepId: "",
        state: this.signState,
        inputs: [
          {
            input_type: "UserRegistrationRequestInput",
            registrationCode: this.regCode,
            state: this.signState
          },
          { input_type: "FingerPrintRequestInput", fingerPrint: fp }
        ],
        requestId: rid
      },
      h
    );
    saveCookies(this.cookies, resp.headers);
    let data = this.parseBody(resp.body);
    this.workflowHandle = data.workflowStateHandle || "";
    const encCtx = getNestedMap(
      data,
      "workflowResponseData",
      "encryptionContextResponse"
    );
    const pubKeyMap = encCtx ? getNestedStringMap(encCtx, "publicKey") : null;
    if (!pubKeyMap?.n)
      throw new Error(`未获取到加密公钥: ${this.formatErrorBody(resp.body, resp.status)}`);
    const issuer = encCtx?.issuer || "signin";
    const audience = encCtx?.audience || "AWSPasswordService";
    const region = encCtx?.region || "us-east-1";
    const encrypted = encryptPassword(this.cfg.password, pubKeyMap, issuer, audience, region);
    fp = this.genFP("signup", "PageSubmit", 0, "");
    rid = newUUID();
    h = this.buildHeaders(ref, this.cfg.signinBase);
    h["x-amzn-requestid"] = rid;
    h["x-amz-date"] = gmtDate();
    h["priority"] = "u=1, i";
    resp = await this.doPost(
      api,
      {
        stepId: "get-new-password-for-password-creation",
        workflowStateHandle: this.workflowHandle,
        actionId: "SUBMIT",
        inputs: [
          {
            input_type: "PasswordRequestInput",
            password: encrypted,
            successfullyEncrypted: "SUCCESSFUL"
          },
          { input_type: "UserRequestInput", username: this.email },
          { input_type: "FingerPrintRequestInput", fingerPrint: fp }
        ],
        visitorId: this.vid,
        requestId: rid
      },
      h
    );
    saveCookies(this.cookies, resp.headers);
    data = this.parseBody(resp.body);
    const redir = data.redirect;
    const rurl = redir?.url;
    if (!rurl) throw new Error(`密码设置未返回 redirect: ${resp.body.slice(0, 200)}`);
    const wh = extractParam(rurl, "workflowStateHandle");
    const st = extractParam(rurl, "state");
    const rh = extractParam(rurl, "workflowResultHandle");
    await this.completeSignup(wh, st, rh);
  }
  async completeSignup(wh, state, rh) {
    this.log("[12.5] 完成注册工作流");
    const api = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/api/execute`;
    const ref = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/login?workflowStateHandle=${wh}&state=${state}&workflowResultHandle=${rh}`;
    const fp = this.genFP("signin", "PageLoad", 0, "");
    const rid = newUUID();
    const h = this.buildHeaders(ref, this.cfg.signinBase);
    h["x-amzn-requestid"] = rid;
    h["x-amz-date"] = gmtDate();
    h["priority"] = "u=1, i";
    const resp = await this.doPost(
      api,
      {
        stepId: "",
        workflowStateHandle: wh,
        workflowResultHandle: rh,
        state,
        inputs: [
          { input_type: "UserRequestInput", username: this.email },
          { input_type: "FingerPrintRequestInput", fingerPrint: fp }
        ],
        visitorId: this.vid,
        requestId: rid
      },
      h
    );
    saveCookies(this.cookies, resp.headers);
    const data = this.parseBody(resp.body);
    if (data.stepId !== "end-of-workflow-success")
      throw new Error(
        `完成工作流失败: ${data.stepId || "undefined"} ${this.formatErrorBody(resp.body, resp.status)}`
      );
    const redir = data.redirect;
    const rurl = redir?.url;
    if (rurl) {
      this.authCode = extractParam(rurl, "workflowResultHandle");
      this.ssoState = extractParam(rurl, "state");
      this.wdcCSRFToken = extractParam(rurl, "wdc_csrf_token");
    }
  }
  // ============ SSO 授权 (Step12.8-13) ============
  async step12_8SSOWorkflow() {
    this.emitStep("sso-workflow");
    this.log("[12.8] SSO 工作流");
    const redirectURL = encodeURIComponent(this.cfg.viewBase + "/start/#/");
    const loginURL = `${this.cfg.portalBase}/login?directory_id=view&redirect_url=${redirectURL}`;
    const h = {
      Accept: "*/*",
      "User-Agent": this.identity.ua,
      Origin: this.cfg.viewBase,
      Referer: this.cfg.viewBase + "/",
      "sec-ch-ua": this.secUA,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "cross-site",
      priority: "u=1, i"
    };
    if (this.cookies.has("awsccc")) h["Cookie"] = "awsccc=" + this.cookies.get("awsccc");
    const resp = await this.doGet(loginURL, h);
    saveCookies(this.cookies, resp.headers);
    const data = this.parseBody(resp.body);
    if (data.csrfToken) this.cookies.set("loginCsrfToken", data.csrfToken);
    const rurl = data.redirectUrl || "";
    let wh = "";
    if (rurl.includes("workflowStateHandle=")) {
      wh = splitAfter(rurl, "workflowStateHandle=");
    }
    if (!wh) throw new Error("SSO 无法获取 workflowStateHandle");
    await this.completeSSOWorkflow(wh);
  }
  async completeSSOWorkflow(wh) {
    const api = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/api/execute`;
    const ref = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/login?workflowStateHandle=${wh}`;
    let fp = this.genFP("signin", "PageLoad", 0, "");
    let rid = newUUID();
    let h = this.buildHeaders(ref, this.cfg.signinBase);
    h["x-amzn-requestid"] = rid;
    h["x-amz-date"] = gmtDate();
    h["priority"] = "u=1, i";
    let resp = await this.doPost(
      api,
      {
        stepId: "",
        workflowStateHandle: wh,
        inputs: [{ input_type: "FingerPrintRequestInput", fingerPrint: fp }],
        requestId: rid
      },
      h
    );
    saveCookies(this.cookies, resp.headers);
    let data = this.parseBody(resp.body);
    let newWH = data.workflowStateHandle || wh;
    if (data.stepId === "start") {
      fp = this.genFP("signin", "PageLoad", 0, "");
      rid = newUUID();
      h = this.buildHeaders(ref, this.cfg.signinBase);
      h["x-amzn-requestid"] = rid;
      h["x-amz-date"] = gmtDate();
      h["priority"] = "u=1, i";
      resp = await this.doPost(
        api,
        {
          stepId: "start",
          workflowStateHandle: newWH,
          inputs: [{ input_type: "FingerPrintRequestInput", fingerPrint: fp }],
          requestId: rid
        },
        h
      );
      saveCookies(this.cookies, resp.headers);
      data = this.parseBody(resp.body);
    }
    if (data.stepId === "end-of-workflow-success") {
      const redir = data.redirect;
      const rurl = redir?.url;
      if (rurl) {
        this.authCode = extractParam(rurl, "workflowResultHandle");
        this.ssoState = extractParam(rurl, "state");
        this.wdcCSRFToken = extractParam(rurl, "wdc_csrf_token");
      }
    }
    const params = new URLSearchParams();
    if (this.ssoState) params.set("state", this.ssoState);
    params.set("workflowResultHandle", this.authCode);
    if (this.wdcCSRFToken) params.set("wdc_csrf_token", this.wdcCSRFToken);
    const startURL = this.cfg.viewBase + "/start/?" + params.toString();
    const cookieParts = [];
    if (this.cookies.has("loginCsrfToken"))
      cookieParts.push("loginCsrfToken=" + this.cookies.get("loginCsrfToken"));
    if (this.cookies.has("awsccc")) cookieParts.push("awsccc=" + this.cookies.get("awsccc"));
    await this.doGet(startURL, {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "User-Agent": this.identity.ua,
      Referer: this.cfg.signinBase + "/",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      ...cookieParts.length ? { Cookie: cookieParts.join("; ") } : {}
    });
  }
  async step13SSOToken() {
    this.emitStep("sso-token");
    this.log("[13] 获取 SSO Token");
    const csrf = this.cookies.get("loginCsrfToken");
    if (!csrf) throw new Error("缺少 loginCsrfToken");
    const h = {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": this.identity.ua,
      Origin: this.cfg.viewBase,
      Referer: this.cfg.viewBase + "/",
      "x-amz-sso-csrf-token": csrf,
      "sec-ch-ua": this.secUA,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "cross-site",
      priority: "u=1, i"
    };
    const formData = `authCode=${encodeURIComponent(this.authCode)}&state=${encodeURIComponent(this.ssoState)}&orgId=view`;
    const ssoSession = new tlsclientwrapper.SessionClient(this.moduleClient, this.sessionOpts);
    try {
      for (let retry = 0; retry < 5; retry++) {
        const resp2 = await ssoSession.post(this.cfg.portalBase + "/auth/sso-token", formData, {
          headers: h
        });
        const data = JSON.parse(resp2.body || "{}");
        if (data.token) {
          this.ssoToken = data.token;
          break;
        }
        const errMsg = data.errorMessage || "";
        if (errMsg.toLowerCase().includes("not authorized")) {
          await this.abortableSleep(3e3);
          continue;
        }
        throw new Error(`SSO Token 失败: ${resp2.body?.slice(0, 200)}`);
      }
    } finally {
      try {
        await ssoSession.destroySession();
      } catch {
      }
    }
    if (!this.ssoToken) throw new Error("SSO Token 重试 5 次仍失败");
    let resp = await this.doPost(
      this.cfg.oidcBase + "/device_authorization/accept_user_code",
      {
        userCode: this.userCode,
        userSessionId: this.ssoToken
      },
      { "Content-Type": "application/json" }
    );
    const dcData = this.parseBody(resp.body);
    const dc = dcData.deviceContext;
    await this.doPost(
      this.cfg.oidcBase + "/device_authorization/associate_token",
      {
        deviceContext: dc,
        userSessionId: this.ssoToken
      },
      { "Content-Type": "application/json" }
    );
    for (let i = 0; i < 30; i++) {
      resp = await this.doPost(
        this.cfg.oidcBase + "/token",
        {
          clientId: this.clientId,
          clientSecret: this.clientSecret,
          deviceCode: this.deviceCode,
          grantType: "urn:ietf:params:oauth:grant-type:device_code"
        },
        { "Content-Type": "application/json" }
      );
      if (resp.status === 200) return this.parseBody(resp.body);
      await this.abortableSleep(2e3);
    }
    throw new Error("Token 轮询超时");
  }
  // ============ 验活 ============
  async verifyAlive(awsToken) {
    this.log("[验活] 刷新 Token + 查用量");
    const refreshToken = awsToken.refreshToken || "";
    const resp = await this.doPost(
      "https://oidc.us-east-1.amazonaws.com/token",
      {
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        refreshToken,
        grantType: "refresh_token"
      },
      { "Content-Type": "application/json" }
    );
    if (resp.status !== 200) {
      this.log(`Token 刷新失败: ${resp.status}`);
      return { alive: false, error: `refresh failed: ${resp.status}` };
    }
    const tok = this.parseBody(resp.body);
    const access = tok.accessToken || "";
    const usageUA = "aws-sdk-js/1.0.18 ua/2.1 os/windows lang/js md/nodejs#20.16.0 api/codewhispererstreaming#1.0.18 m/E KiroIDE-0.6.18";
    for (const baseURL of [
      "https://q.us-east-1.amazonaws.com/getUsageLimits",
      "https://q.eu-central-1.amazonaws.com/getUsageLimits"
    ]) {
      const usageURL = baseURL + "?origin=AI_EDITOR&resourceType=AGENTIC_REQUEST&isEmailRequired=true";
      const usageResp = await this.doGet(usageURL, {
        Accept: "application/json",
        Authorization: "Bearer " + access,
        "User-Agent": usageUA
      });
      if (usageResp.status === 403 && usageResp.body.toLowerCase().includes("suspended")) {
        return { alive: false, suspended: true, error: "suspended" };
      }
      if (usageResp.status === 200) {
        return this.parseUsage(usageResp.body);
      }
    }
    return { alive: false, error: "usage query failed" };
  }
  parseUsage(body) {
    const usage = this.parseBody(body);
    const userInfo = usage.userInfo || {};
    const emailAddr = userInfo.email || "";
    const subInfo = usage.subscriptionInfo || {};
    let sub = subInfo.subscriptionTitle || "Free";
    let totalLimit = 0, totalUsed = 0;
    const breakdown = usage.usageBreakdownList;
    if (breakdown) {
      for (const item of breakdown) {
        const rt = item.resourceType;
        const dn = item.displayName;
        if (rt === "CREDIT" || dn === "Credits") {
          totalLimit = item.usageLimitWithPrecision || item.usageLimit || 0;
          totalUsed = item.currentUsageWithPrecision || item.currentUsage || 0;
          const ft = item.freeTrialInfo;
          if (ft?.freeTrialStatus === "ACTIVE") {
            totalLimit += ft.usageLimitWithPrecision || 0;
            totalUsed += ft.currentUsageWithPrecision || 0;
          }
          break;
        }
      }
    }
    this.log(`验活成功! 邮箱=${emailAddr} 订阅=${sub} Credit=${totalUsed}/${totalLimit}`);
    return {
      alive: true,
      email: emailAddr,
      subscription: sub,
      credit_used: totalUsed,
      credit_limit: totalLimit
    };
  }
  // ============ 主流程 ============
  /** 执行完整注册流程（自动模式） */
  async run() {
    this.emitStep("init");
    try {
      await this.setupProxyChain();
      if (this.chainRelay) this.emitStep("proxy-chain-ready");
      await this.initTlsClient();
      this.emitStep("tls-ready");
      await this.detectExitIP();
      await refreshAppJSConfig((url, init) => this.fetchAppJS(url, init));
      await this.rebuildTlsClient();
      const initSteps = [
        { name: "OIDC", fn: () => this.step1OIDC() },
        {
          name: "Device",
          fn: () => this.step2Device(),
          retry: 2,
          timeoutMs: 3e4,
          refreshSession: true
        },
        { name: "Email", fn: () => this.step3Email() },
        {
          name: "Portal",
          fn: () => this.step4Portal(),
          retry: 3,
          timeoutMs: 35e3,
          refreshSession: true
        },
        {
          name: "WorkflowInit",
          fn: () => this.step5WorkflowInit(),
          retry: 2,
          timeoutMs: 35e3,
          refreshSession: true
        }
      ];
      for (const s of initSteps) {
        this.checkAborted();
        try {
          if (s.retry)
            await this.retryStep(s.name, s.fn, s.retry, {
              timeoutMs: s.timeoutMs,
              refreshSession: s.refreshSession
            });
          else await s.fn();
        } catch (err) {
          return {
            status: "failed",
            email: this.email,
            error: `[${s.name}] ${err.message}`
          };
        }
        await this.humanDelay();
      }
      this.checkAborted();
      const STEP_TIMEOUT = 55e3;
      const emailStatus = await this.withTimeout(
        this.step6SubmitEmail(),
        STEP_TIMEOUT,
        "SubmitEmail"
      );
      if (emailStatus === "signup") {
        const signupSteps = [
          { name: "Signup", fn: () => this.step7Signup() },
          { name: "SignupInit", fn: () => this.step7_5SignupInit() },
          { name: "ProfileInit", fn: () => this.step7_8ProfileInit() },
          { name: "ProfileStart", fn: () => this.step8ProfileStart() },
          { name: "SendOTP", fn: () => this.step9SendOTP() }
        ];
        for (const s of signupSteps) {
          this.checkAborted();
          try {
            await this.withTimeout(s.fn(), STEP_TIMEOUT, s.name);
          } catch (err) {
            return {
              status: "failed",
              email: this.email,
              error: `[${s.name}] ${err.message}`
            };
          }
          await this.humanDelay();
        }
        this.checkAborted();
        let otp;
        try {
          otp = await this.step10GetOTP();
        } catch (err) {
          return {
            status: "failed",
            email: this.email,
            error: `[GetOTP] ${err.message}`
          };
        }
        for (const s of [
          { name: "CreateIdentity", fn: () => this.step11CreateIdentity(otp) },
          { name: "SetPassword", fn: () => this.step12SetPassword() }
        ]) {
          this.checkAborted();
          try {
            await this.withTimeout(s.fn(), STEP_TIMEOUT, s.name);
          } catch (err) {
            return {
              status: "failed",
              email: this.email,
              error: `[${s.name}] ${err.message}`
            };
          }
          await this.humanDelay();
        }
      } else {
        return { status: "failed", email: this.email, error: "该邮箱已注册过" };
      }
      this.checkAborted();
      let awsToken = null;
      const SSO_MAX_RETRIES = 2;
      for (let ssoAttempt = 0; ssoAttempt <= SSO_MAX_RETRIES; ssoAttempt++) {
        try {
          await this.withTimeout(this.step12_8SSOWorkflow(), 6e4, "SSOWorkflow");
          await this.abortableSleep(2e3);
          this.checkAborted();
          awsToken = await this.withTimeout(this.step13SSOToken(), 9e4, "SSOToken");
          break;
        } catch (err) {
          const errMsg = err.message;
          if (ssoAttempt < SSO_MAX_RETRIES) {
            this.log(
              `[SSO] 后期步骤失败，内部重试 (${ssoAttempt + 1}/${SSO_MAX_RETRIES}): ${errMsg}`
            );
            await this.abortableSleep(3e3 + Math.floor(Math.random() * 2e3));
          } else {
            return {
              status: "failed",
              email: this.email,
              error: `[SSOToken] ${errMsg} (账号已创建，可手动导入刷新)`
            };
          }
        }
      }
      const token = awsToken;
      this.emitStep("verify-alive");
      const verify = await this.withTimeout(this.verifyAlive(token), 6e4, "VerifyAlive");
      if (verify.suspended) {
        return { status: "failed", email: this.email, error: "suspended" };
      }
      this.emitStep("done");
      return {
        status: "success",
        email: this.email,
        password: this.cfg.password,
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        refreshToken: token.refreshToken || "",
        accessToken: token.accessToken || "",
        region: "us-east-1",
        provider: "BuilderId",
        verify,
        fingerprint: this.fingerprintSnapshot()
      };
    } finally {
      await this.cleanup();
    }
  }
  /**
   * 返回本次注册实际生效的代理 URL（按 sessionOpts 同样的优先级解析），
   * 用于在指纹摘要里准确显示是直连还是走代理。
   */
  resolvedProxyUrl() {
    return this.chainTargetProxy && this.chainTargetProxy.trim() || this.cfg.proxy && this.cfg.proxy.trim() || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || getSystemProxy() || void 0;
  }
  /** 输出本次注册使用的指纹摘要（用于审计与后续复用） */
  fingerprintSnapshot() {
    const resolved = this.resolvedProxyUrl();
    return {
      chromeVer: this.identity.chromeVer,
      ua: this.identity.ua,
      gpuVendor: this.identity.gpuVendor,
      gpuModel: this.identity.gpuModel,
      canvasHash: this.identity.canvasHash,
      screen: { width: this.identity.screen.width, height: this.identity.screen.height },
      // 脱敏后保存（隐藏密码部分），同时确保系统/环境变量代理也被捕获
      proxyUrl: resolved ? resolved.replace(/:([^:@/]+)@/, ":***@") : void 0,
      exitIP: this.exitIP || void 0
    };
  }
  /** 手动模式注册 - Step1-2 自动，Step3 等待外部设置邮箱，Step4-9 自动，Step10 等待外部 OTP */
  async runManualPhase1() {
    try {
      await this.setupProxyChain();
      await this.initTlsClient();
      await this.detectExitIP();
      await refreshAppJSConfig((url, init) => this.fetchAppJS(url, init));
      await this.rebuildTlsClient();
      await this.step1OIDC();
      await this.withTimeout(this.step2Device(), 3e4, "Device");
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
  /** 手动模式 - 设置邮箱后继续注册流程到发送 OTP */
  async runManualPhase2(email, fullName) {
    this.email = email;
    if (fullName) this.cfg.fullName = fullName;
    try {
      const STEP_TIMEOUT = 55e3;
      await this.retryStep("Portal", () => this.step4Portal(), 3, {
        timeoutMs: 35e3,
        refreshSession: true
      });
      await this.retryStep("WorkflowInit", () => this.step5WorkflowInit(), 2, {
        timeoutMs: 35e3,
        refreshSession: true
      });
      const status = await this.withTimeout(this.step6SubmitEmail(), STEP_TIMEOUT, "SubmitEmail");
      if (status !== "signup") return { success: false, error: "该邮箱已注册过" };
      await this.withTimeout(this.step7Signup(), STEP_TIMEOUT, "Signup");
      await this.withTimeout(this.step7_5SignupInit(), STEP_TIMEOUT, "SignupInit");
      await this.withTimeout(this.step7_8ProfileInit(), STEP_TIMEOUT, "ProfileInit");
      await this.withTimeout(this.step8ProfileStart(), STEP_TIMEOUT, "ProfileStart");
      await this.withTimeout(this.step9SendOTP(), STEP_TIMEOUT, "SendOTP");
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
  /** 手动模式 - 输入 OTP 后完成注册 */
  async runManualPhase3(otp) {
    try {
      await this.withTimeout(this.step11CreateIdentity(otp), 55e3, "CreateIdentity");
      await this.withTimeout(this.step12SetPassword(), 55e3, "SetPassword");
      let awsToken = null;
      const SSO_MAX_RETRIES = 2;
      for (let ssoAttempt = 0; ssoAttempt <= SSO_MAX_RETRIES; ssoAttempt++) {
        try {
          await this.withTimeout(this.step12_8SSOWorkflow(), 6e4, "SSOWorkflow");
          await this.abortableSleep(2e3);
          this.checkAborted();
          awsToken = await this.withTimeout(this.step13SSOToken(), 9e4, "SSOToken");
          break;
        } catch (err) {
          const errMsg = err.message;
          if (ssoAttempt < SSO_MAX_RETRIES) {
            this.log(
              `[SSO] 后期步骤失败，内部重试 (${ssoAttempt + 1}/${SSO_MAX_RETRIES}): ${errMsg}`
            );
            await this.abortableSleep(3e3 + Math.floor(Math.random() * 2e3));
          } else {
            return {
              status: "failed",
              email: this.email,
              error: `[SSOToken] ${errMsg} (账号已创建，可手动导入刷新)`
            };
          }
        }
      }
      const token = awsToken;
      const verify = await this.withTimeout(this.verifyAlive(token), 6e4, "VerifyAlive");
      if (verify.suspended) {
        return { status: "failed", email: this.email, error: "suspended" };
      }
      return {
        status: "success",
        email: this.email,
        password: this.cfg.password,
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        refreshToken: token.refreshToken || "",
        accessToken: token.accessToken || "",
        region: "us-east-1",
        provider: "BuilderId",
        verify,
        fingerprint: this.fingerprintSnapshot()
      };
    } catch (err) {
      return { status: "failed", email: this.email, error: err.message };
    } finally {
      await this.cleanup();
    }
  }
}
function genPassword() {
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lower = "abcdefghijklmnopqrstuvwxyz";
  const digits = "0123456789";
  const special = "!@#$%^&*";
  let pw = "";
  for (let i = 0; i < 3; i++) pw += upper[Math.floor(Math.random() * upper.length)];
  for (let i = 0; i < 6; i++) pw += lower[Math.floor(Math.random() * lower.length)];
  for (let i = 0; i < 3; i++) pw += digits[Math.floor(Math.random() * digits.length)];
  for (let i = 0; i < 2; i++) pw += special[Math.floor(Math.random() * special.length)];
  const arr = pw.split("");
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join("");
}
function newConfig(overrides) {
  return {
    oidcBase: "https://oidc.us-east-1.amazonaws.com",
    signinBase: "https://us-east-1.signin.aws",
    profileBase: "https://profile.aws.amazon.com",
    viewBase: "https://view.awsapps.com",
    portalBase: "https://portal.sso.us-east-1.amazonaws.com",
    directoryId: "d-9067642ac7",
    startURL: "https://view.awsapps.com/start",
    password: genPassword(),
    fullName: randomFullName(),
    proxy: "",
    upstreamProxy: "",
    strictProxy: false,
    moEmailBaseURL: "",
    moEmailAPIKey: "",
    useOutlook: false,
    outlookData: "",
    useTempMailPlus: false,
    tempMailPlusEmail: "",
    tempMailPlusEpin: "",
    tempMailPlusDomain: "",
    useProton: false,
    protonEmail: "",
    useGptMail: false,
    gptMailBaseURL: "",
    gptMailInboxEmail: "",
    gptMailDomain: "",
    gptMailPrefix: "",
    gptMailPrivatePassword: "",
    manualMode: false,
    ...overrides
  };
}
const registrarPool = /* @__PURE__ */ new Map();
const MANUAL_KEY = "__manual__";
function registerIPCHandlers(getMainWindow) {
  const sendLog = (msg, taskId) => {
    const win2 = getMainWindow();
    if (win2 && !win2.isDestroyed()) {
      win2.webContents.send("registration-log", { message: msg, taskId });
    }
  };
  const sendStep = (event, taskId) => {
    const win2 = getMainWindow();
    if (win2 && !win2.isDestroyed()) {
      win2.webContents.send("registration-step", { taskId, event });
    }
  };
  electron.ipcMain.handle(
    "registration-start-auto",
    async (_event, config) => {
      const taskId = config.taskId || `auto-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const logPrefix = config.taskId ? `[#${config.taskId.slice(0, 12)}] ` : "";
      const cfg = newConfig(config);
      cfg.manualMode = false;
      const registrar = new Registrar(
        cfg,
        (msg) => sendLog(`${logPrefix}${msg}`, config.taskId),
        (event) => sendStep(event, config.taskId)
      );
      registrarPool.set(taskId, registrar);
      try {
        const result = await registrar.run();
        registrarPool.delete(taskId);
        if (!config.taskId) {
          const win2 = getMainWindow();
          if (win2 && !win2.isDestroyed()) {
            win2.webContents.send("registration-complete", result);
          }
        }
        return { success: true, result };
      } catch (err) {
        registrarPool.delete(taskId);
        const errMsg = err instanceof Error ? err.message : String(err);
        return { success: false, error: errMsg };
      }
    }
  );
  electron.ipcMain.handle(
    "registration-manual-phase1",
    async (_event, config) => {
      if (registrarPool.has(MANUAL_KEY)) {
        return { success: false, error: "已有手动注册流程正在进行" };
      }
      const cfg = newConfig(config);
      cfg.manualMode = true;
      const registrar = new Registrar(cfg, sendLog, (event) => sendStep(event));
      registrarPool.set(MANUAL_KEY, registrar);
      const result = await registrar.runManualPhase1();
      if (!result.success) {
        await registrar.destroy();
        registrarPool.delete(MANUAL_KEY);
      }
      return result;
    }
  );
  electron.ipcMain.handle("registration-manual-phase2", async (_event, email, fullName) => {
    const registrar = registrarPool.get(MANUAL_KEY);
    if (!registrar) {
      return { success: false, error: "无进行中的注册流程" };
    }
    const result = await registrar.runManualPhase2(email, fullName);
    if (!result.success) {
      await registrar.destroy();
      registrarPool.delete(MANUAL_KEY);
    }
    return result;
  });
  electron.ipcMain.handle("registration-manual-phase3", async (_event, otp) => {
    const registrar = registrarPool.get(MANUAL_KEY);
    if (!registrar) {
      return { success: false, error: "无进行中的注册流程" };
    }
    const result = await registrar.runManualPhase3(otp);
    await registrar.destroy();
    registrarPool.delete(MANUAL_KEY);
    return { success: true, result };
  });
  electron.ipcMain.handle("registration-cancel", async (_event, taskId) => {
    if (taskId) {
      const registrar = registrarPool.get(taskId);
      if (registrar) {
        registrar.abort();
        await registrar.destroy();
        registrarPool.delete(taskId);
      }
    } else {
      const tasks = Array.from(registrarPool.entries());
      for (const [id, registrar] of tasks) {
        registrar.abort();
        await registrar.destroy();
        registrarPool.delete(id);
      }
    }
    return { success: true };
  });
  electron.ipcMain.handle("registration-status", async () => {
    return { inProgress: registrarPool.size > 0, count: registrarPool.size };
  });
  electron.ipcMain.handle("proton-open-login", async (_event, proxy) => {
    return openProtonLogin(proxy);
  });
  electron.ipcMain.handle("proton-login-status", async (_event, proxy) => {
    return getProtonLoginStatus(proxy);
  });
  electron.ipcMain.handle("proton-close", async () => {
    closeProtonWindow();
    return { success: true };
  });
}
const DEFAULT_PROXY_POOL_CONFIG = {
  enabled: false,
  strategy: "round_robin",
  validateOnStartup: false,
  autoDisableDead: true,
  failureThreshold: 3,
  testUrl: "https://api.ipify.org?format=json",
  testTimeoutMs: 8e3,
  autoValidateIntervalMin: 0,
  autoValidateConcurrency: 5,
  upstreamProxy: ""
};
const SLOW_LATENCY_THRESHOLD_MS = 3e3;
function applyValidationResult(entry, result, config, pool) {
  const latencyMs = result.latencyMs;
  const status = result.success ? latencyMs !== void 0 && latencyMs > SLOW_LATENCY_THRESHOLD_MS ? "slow" : "alive" : "dead";
  const failCount = result.success ? entry.failCount : entry.failCount + 1;
  const aliveCount = pool.filter((p) => p.enabled && p.status !== "dead").length;
  const enabled = result.success ? entry.enabled : config.autoDisableDead && failCount >= config.failureThreshold && aliveCount > 1 ? false : entry.enabled;
  return {
    ...entry,
    status,
    latencyMs: result.latencyMs,
    lastTestedAt: Date.now(),
    lastError: result.success ? void 0 : result.error,
    failCount,
    enabled
  };
}
async function validateProxyEntry(params) {
  const {
    url,
    testUrl = DEFAULT_PROXY_POOL_CONFIG.testUrl,
    timeoutMs = DEFAULT_PROXY_POOL_CONFIG.testTimeoutMs,
    upstreamProxy
  } = params || {};
  if (!url) return { success: false, error: "Missing proxy URL" };
  let chainRelay = null;
  let proxyForAgent = url;
  if (upstreamProxy && upstreamProxy.trim()) {
    try {
      chainRelay = new ChainProxyRelay(upstreamProxy.trim(), url);
      proxyForAgent = await chainRelay.start();
    } catch (err) {
      return {
        success: false,
        error: `代理链启动失败: ${err instanceof Error ? err.message : String(err)}`
      };
    }
  }
  const agent = safeCreateProxyAgent(proxyForAgent);
  if (!agent) {
    if (chainRelay) await chainRelay.stop();
    return { success: false, error: "代理协议不支持（仅支持 http/https/socks4/socks5）或 URL 无效" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const resp = await undici.fetch(testUrl, {
      method: "GET",
      dispatcher: agent,
      signal: controller.signal,
      headers: { "User-Agent": "ProxyRS-ProxyValidator/1.0" }
    });
    const latencyMs = Date.now() - start;
    if (resp.status >= 200 && resp.status < 400) {
      let externalIp;
      try {
        const ct = resp.headers.get("content-type") || "";
        const text = await resp.text();
        if (ct.includes("json") || text.trimStart().startsWith("{")) {
          try {
            const body = JSON.parse(text);
            const raw = body.ip ?? body.query ?? body.origin ?? body.ipAddress ?? "";
            const ipStr = String(raw).trim();
            const m = ipStr.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
            if (m) externalIp = m[0];
          } catch {
          }
        }
        if (!externalIp) {
          const m = text.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
          if (m) externalIp = m[0];
        }
      } catch {
      }
      return { success: true, latencyMs, externalIp };
    }
    return { success: false, latencyMs, error: `HTTP ${resp.status}` };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const isAbort = controller.signal.aborted;
    return {
      success: false,
      latencyMs: Date.now() - start,
      error: isAbort ? `请求超时 (${timeoutMs}ms)` : errMsg
    };
  } finally {
    clearTimeout(timer);
    try {
      await agent.close();
    } catch {
    }
    if (chainRelay) await chainRelay.stop();
  }
}
function registerValidateHandler() {
  electron.ipcMain.handle(
    "proxy-pool:validate",
    async (_event, params) => validateProxyEntry(params || { url: "" })
  );
}
function registerDiagnoseChainHandler() {
  electron.ipcMain.handle(
    "proxy-pool:diagnose-chain",
    async (_event, params) => {
      const { targetUrl, upstreamProxy, testHost, testPort } = params || {};
      if (!targetUrl) return { success: false, error: "Missing target proxy URL" };
      if (!upstreamProxy) return { success: false, error: "Missing upstream proxy URL" };
      try {
        const relay = new ChainProxyRelay(upstreamProxy, targetUrl);
        const diag = await relay.diagnose(testHost, testPort);
        return { success: true, diagnose: diag };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );
}
function registerProxyPoolIpcHandlers() {
  registerValidateHandler();
  registerDiagnoseChainHandler();
}
const KIRO_API_KEY_PATTERN = /^ksk_[A-Za-z0-9]+$/;
const AWS_REGION_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)+$/;
function isValidKiroApiKey(value) {
  return KIRO_API_KEY_PATTERN.test(value);
}
function isValidKiroRegion(value) {
  return AWS_REGION_PATTERN.test(value);
}
function maskKiroApiKey(key) {
  return key.length > 12 ? `${key.slice(0, 4)}...${key.slice(-4)}` : `${key.slice(0, 4)}...`;
}
const KSK_PROVIDER_POLL_INTERVAL_SECONDS = 30;
const KSK_AUTOMATION_REQUEST_TIMEOUT_SECONDS = 15;
const DEFAULT_LOCAL_ADMIN_URL = "http://127.0.0.1:12888/admin";
const KSK_AUTOMATION_STORE_VERSION = 2;
const KSK_AUTOMATION_TASK_TYPE = "ksk_pull";
const KSK_CLEANUP_INTERVAL_MINUTES = 30;
const KSK_CLEANUP_INTERVAL_MIN_MINUTES = 5;
const KSK_CLEANUP_INTERVAL_MAX_MINUTES = 1440;
const KSK_LIVENESS_PROBE_MESSAGE = 'Hi, reply with "pong" only.';
const KSK_AUTOMATION_STATE = {
  IDLE: "idle",
  RUNNING: "running",
  HEALTHY: "healthy",
  DEGRADED: "degraded",
  BLOCKED: "blocked"
};
const KSK_AUTOMATION_LOG_LEVEL = {
  INFO: "info",
  WARN: "warn",
  ERROR: "error"
};
const KSK_AUTOMATION_LOG_LIMIT = 100;
const DEFAULT_KSK_AUTOMATION_CONFIG = {
  smtpPort: 465,
  localAdminBaseUrl: DEFAULT_LOCAL_ADMIN_URL
};
function isRecord$1(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readString$3(value) {
  return typeof value === "string" ? value.trim() : "";
}
function resolveProviderRegion(account) {
  const awsRegion = readString$3(account.aws_region);
  if (isValidKiroRegion(awsRegion)) return awsRegion;
  const zone = readString$3(account.zone).toLowerCase();
  const zoneRegion = zone === "us" ? "us-east-1" : zone === "eu" ? "eu-central-1" : zone === "ap" ? "ap-southeast-1" : "";
  return isValidKiroRegion(zoneRegion) ? zoneRegion : "";
}
function parseKskProviderResponse(payload) {
  if (!isRecord$1(payload)) throw new Error("KSK 提供接口返回的不是 JSON 对象");
  if (payload.code !== 0) {
    throw new Error(readString$3(payload.msg) || `KSK 提供接口返回 code=${String(payload.code)}`);
  }
  if (!Array.isArray(payload.data)) throw new Error("KSK 提供接口 data 不是数组");
  const credentials = [];
  const seen = /* @__PURE__ */ new Set();
  let rejectedCount = 0;
  for (const item of payload.data) {
    if (!isRecord$1(item) || !isRecord$1(item.account)) {
      rejectedCount++;
      continue;
    }
    const key = readString$3(item.account.key);
    const status = readString$3(item.account.status).toLowerCase();
    const region = resolveProviderRegion(item.account);
    if (!isValidKiroApiKey(key) || status !== "active" || !region || seen.has(key)) {
      rejectedCount++;
      continue;
    }
    seen.add(key);
    const rawClaimId = item.claimId;
    credentials.push({
      key,
      region,
      claimId: typeof rawClaimId === "string" || typeof rawClaimId === "number" ? String(rawClaimId) : void 0
    });
  }
  return {
    message: readString$3(payload.msg) || void 0,
    credentials,
    rejectedCount
  };
}
function maskSecretTail(value, visible = 4) {
  const trimmed = value.trim();
  if (!trimmed) return void 0;
  return `••••${trimmed.slice(-visible)}`;
}
function providerUrlHint(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname} · token ${maskSecretTail(parsed.searchParams.get("token") || "") ?? "已配置"}`;
  } catch {
    return value.trim() ? "已配置（地址格式待校验）" : void 0;
  }
}
function extractAddress(value) {
  const match = /<([^>]+)>/.exec(value);
  return (match ? match[1] : value).trim().toLowerCase();
}
function parseKskEmailRecipients(value) {
  const seen = /* @__PURE__ */ new Set();
  const recipients = [];
  for (const entry of value.split(",")) {
    const recipient = entry.trim();
    if (!recipient) continue;
    const address = extractAddress(recipient);
    if (seen.has(address)) continue;
    seen.add(address);
    recipients.push(recipient);
  }
  return recipients;
}
async function sendKskAddedEmail(config, credentials) {
  if (credentials.length === 0) return 0;
  const recipients = parseKskEmailRecipients(config.to);
  if (!config.host.trim() || !config.from.trim() || recipients.length === 0) {
    throw new Error("邮件通知缺少 SMTP Host、发件人或收件人");
  }
  if (config.username.trim() && !config.password) throw new Error("SMTP 用户名已配置但密码为空");
  const transporter = nodemailer.createTransport({
    host: config.host.trim(),
    port: config.port,
    secure: config.secure,
    // 非隐式 TLS 端口必须升级到 STARTTLS，否则拒绝发送完整 KSK 与 SMTP 凭据。
    requireTLS: !config.secure,
    auth: config.username.trim() ? { user: config.username.trim(), pass: config.password } : void 0,
    connectionTimeout: 15e3,
    greetingTimeout: 15e3,
    socketTimeout: 3e4
  });
  try {
    const text = credentials.map((credential) => `${credential.key} (${credential.region})`).join("\n");
    for (const recipient of recipients) {
      await transporter.sendMail({
        from: config.from.trim(),
        to: recipient,
        subject: "Proxy RS 新增 KSK",
        text
      });
    }
    return credentials.length;
  } finally {
    transporter.close();
  }
}
const LOCAL_ADMIN_AUTH_METHOD = {
  API_KEY: "api_key",
  IDC: "idc",
  SOCIAL: "social"
};
const LOCAL_ADMIN_DEFAULT_PRIORITY = 0;
function normalizeLocalAdminEmail(value) {
  const trimmed = value?.trim();
  if (!trimmed) return void 0;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : void 0;
}
function resolveLocalAdminCredentialPayload(candidate) {
  const kiroApiKey = candidate.kiroApiKey?.trim() ?? "";
  const region = candidate.region?.trim() ?? "";
  const email = normalizeLocalAdminEmail(candidate.email);
  if (candidate.credentialKind === "kiro_api_key" || kiroApiKey) {
    if (!isValidKiroApiKey(kiroApiKey)) return { ok: false, reason: "账号的 Kiro API Key 无效" };
    if (!isValidKiroRegion(region)) return { ok: false, reason: "账号缺少合法的 AWS 区域" };
    return {
      ok: true,
      payload: {
        authMethod: LOCAL_ADMIN_AUTH_METHOD.API_KEY,
        priority: LOCAL_ADMIN_DEFAULT_PRIORITY,
        kiroApiKey,
        authRegion: region,
        apiRegion: region,
        email
      }
    };
  }
  const refreshToken = candidate.refreshToken?.trim() ?? "";
  if (!refreshToken) return { ok: false, reason: "账号缺少 Refresh Token" };
  const clientId = candidate.clientId?.trim() ?? "";
  const clientSecret = candidate.clientSecret?.trim() ?? "";
  const credentialRegion = isValidKiroRegion(region) ? region : void 0;
  if (candidate.authMethod === "social") {
    return {
      ok: true,
      payload: {
        authMethod: LOCAL_ADMIN_AUTH_METHOD.SOCIAL,
        priority: LOCAL_ADMIN_DEFAULT_PRIORITY,
        refreshToken,
        authRegion: credentialRegion,
        apiRegion: credentialRegion,
        email
      }
    };
  }
  const isIdc = candidate.authMethod === "IdC" || Boolean(clientId) || Boolean(clientSecret);
  if (isIdc && !(clientId && clientSecret)) {
    return { ok: false, reason: "IdC 账号需要同时提供 Client ID 和 Client Secret" };
  }
  return {
    ok: true,
    payload: {
      authMethod: isIdc ? LOCAL_ADMIN_AUTH_METHOD.IDC : LOCAL_ADMIN_AUTH_METHOD.SOCIAL,
      priority: LOCAL_ADMIN_DEFAULT_PRIORITY,
      refreshToken,
      clientId: isIdc ? clientId : void 0,
      clientSecret: isIdc ? clientSecret : void 0,
      authRegion: credentialRegion,
      apiRegion: credentialRegion,
      email
    }
  };
}
const LOCAL_ADMIN_PROBE_VERDICT = {
  ALIVE: "alive",
  PERMANENTLY_INVALID: "permanently_invalid",
  TRANSIENT: "transient",
  /** 没跑验活：Admin 已有同一凭据，或调用方没提供验活能力。 */
  SKIPPED: "skipped"
};
function redactAdminErrorDetail(value) {
  return value.replace(/ksk_[A-Za-z0-9_-]+/g, "ksk_••••").replace(/("?(?:token|apiKey|kiroApiKey)"?\s*[:=]\s*")([^"]+)(")/gi, "$1••••$3").replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "••••@••••");
}
function isLoopback$1(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}
function resolveLocalAdminApiBase(value) {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback$1(parsed.hostname))) {
    throw new Error("本机 Admin 仅允许 loopback HTTP；远程地址必须使用 HTTPS");
  }
  parsed.search = "";
  parsed.hash = "";
  const path2 = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = path2.endsWith("/api/admin") ? path2 : "/api/admin";
  return parsed.toString().replace(/\/$/, "");
}
function sha256Hex(value) {
  return node_crypto.createHash("sha256").update(value).digest("hex");
}
function readRemoteCredentials(payload) {
  if (typeof payload !== "object" || payload === null) return [];
  const credentials = payload.credentials;
  if (!Array.isArray(credentials)) return [];
  return credentials.filter(
    (item) => typeof item === "object" && item !== null
  );
}
async function requestJson(fetchImpl, url, apiKey, timeoutMs, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: init.method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-api-key": apiKey
      },
      body: init.body === void 0 ? void 0 : JSON.stringify(init.body),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      const detail = redactAdminErrorDetail(text.replace(/\s+/g, " ").trim()).slice(0, 300);
      throw new Error(`本机 Admin 请求失败: HTTP ${response.status}${detail ? ` · ${detail}` : ""}`);
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}
function remoteCredentialId(credential) {
  const value = credential.id;
  return typeof value === "string" || typeof value === "number" ? String(value) : void 0;
}
async function deleteRemoteCredential(input) {
  const target = `${input.baseUrl}/credentials/${encodeURIComponent(input.credentialId)}`;
  if (!input.disabled) {
    await requestJson(input.fetchImpl, `${target}/disabled`, input.adminApiKey, input.timeoutMs, {
      method: "POST",
      body: { disabled: true }
    });
  }
  await requestJson(input.fetchImpl, target, input.adminApiKey, input.timeoutMs, {
    method: "DELETE"
  });
}
async function deleteLocalAdminCredentialsByKey(input) {
  const result = {
    checked: 0,
    removed: 0,
    retainedTransient: 0,
    errors: []
  };
  const targetHashes = new Map(input.keys.map((key) => [sha256Hex(key), key]));
  if (targetHashes.size === 0) return result;
  const baseUrl = resolveLocalAdminApiBase(input.baseUrl);
  const adminApiKey = input.adminApiKey.trim();
  if (!adminApiKey) throw new Error("未配置本机 Admin API Key");
  const timeoutMs = Math.max(3, input.timeoutSeconds) * 1e3;
  const payload = await requestJson(
    input.fetchImpl,
    `${baseUrl}/credentials`,
    adminApiKey,
    timeoutMs,
    { method: "GET" }
  );
  const doomed = readRemoteCredentials(payload).filter(
    (credential) => credential.authMethod === "api_key" && credential.apiKeyHash && targetHashes.has(credential.apiKeyHash) && remoteCredentialId(credential)
  );
  result.checked = doomed.length;
  for (const credential of doomed) {
    const credentialId = remoteCredentialId(credential);
    if (!credentialId) continue;
    try {
      await deleteRemoteCredential({
        baseUrl,
        adminApiKey,
        timeoutMs,
        credentialId,
        disabled: credential.disabled === true,
        fetchImpl: input.fetchImpl
      });
      result.removed++;
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return result;
}
async function deleteLocalAdminCredentialsById(input) {
  const result = { deleted: [], errors: [] };
  if (input.credentials.length === 0) return result;
  const baseUrl = resolveLocalAdminApiBase(input.baseUrl);
  const adminApiKey = input.adminApiKey.trim();
  if (!adminApiKey) throw new Error("未配置本机 Admin API Key");
  const timeoutMs = Math.max(3, input.timeoutSeconds) * 1e3;
  const remoteById = /* @__PURE__ */ new Map();
  try {
    const payload = await requestJson(
      input.fetchImpl,
      `${baseUrl}/credentials`,
      adminApiKey,
      timeoutMs,
      { method: "GET" }
    );
    for (const credential of readRemoteCredentials(payload)) {
      const id = remoteCredentialId(credential);
      if (id) remoteById.set(id, credential);
    }
  } catch (error) {
    throw new Error(
      `读取本机 Admin 凭据列表失败：${error instanceof Error ? error.message : String(error)}`
    );
  }
  for (const target of input.credentials) {
    const remote = remoteById.get(target.credentialId);
    if (!remote) continue;
    try {
      await deleteRemoteCredential({
        baseUrl,
        adminApiKey,
        timeoutMs,
        credentialId: target.credentialId,
        disabled: remote.disabled === true,
        fetchImpl: input.fetchImpl
      });
      result.deleted.push({
        credentialId: target.credentialId,
        apiKeyHash: remote.apiKeyHash ?? void 0,
        maskedApiKey: remote.maskedApiKey
      });
    } catch (error) {
      result.errors.push(
        `删除凭据 ${remote.maskedApiKey || `#${target.credentialId}`} 失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return result;
}
function readCredentialId(payload) {
  if (typeof payload !== "object" || payload === null) return void 0;
  const record = payload;
  const direct = record.credentialId ?? record.id;
  if (typeof direct === "string" || typeof direct === "number") return String(direct);
  const nested = record.credential;
  if (typeof nested !== "object" || nested === null) return void 0;
  const nestedId = nested.id;
  return typeof nestedId === "string" || typeof nestedId === "number" ? String(nestedId) : void 0;
}
async function syncKskAccountsToLocalAdmin(input) {
  const baseUrl = resolveLocalAdminApiBase(input.baseUrl);
  const adminApiKey = input.adminApiKey.trim();
  if (!adminApiKey) throw new Error("未配置本机 Admin API Key");
  const timeoutMs = Math.max(3, input.timeoutSeconds) * 1e3;
  const uniqueAccounts = /* @__PURE__ */ new Map();
  for (const account of input.accounts) {
    if (!isValidKiroApiKey(account.kiroApiKey) || !isValidKiroRegion(account.region)) continue;
    uniqueAccounts.set(account.kiroApiKey, account);
  }
  const existingPayload = await requestJson(
    input.fetchImpl,
    `${baseUrl}/credentials`,
    adminApiKey,
    timeoutMs,
    { method: "GET" }
  );
  const existingCredentials = readRemoteCredentials(existingPayload);
  const existingHashes = new Set(
    existingCredentials.map((credential) => credential.apiKeyHash).filter((value) => typeof value === "string" && value.length > 0)
  );
  const result = {
    discovered: uniqueAccounts.size,
    skippedExisting: 0,
    synced: 0,
    verified: 0,
    pruned: 0,
    prunedMaskedKeys: [],
    errors: []
  };
  const localHashes = new Set([...uniqueAccounts.keys()].map((kiroApiKey) => sha256Hex(kiroApiKey)));
  for (const credential of existingCredentials) {
    if (credential.authMethod !== "api_key") continue;
    const hash = credential.apiKeyHash;
    if (!hash || localHashes.has(hash)) continue;
    const credentialId = remoteCredentialId(credential);
    if (!credentialId) continue;
    try {
      await deleteRemoteCredential({
        baseUrl,
        adminApiKey,
        timeoutMs,
        credentialId,
        disabled: credential.disabled === true,
        fetchImpl: input.fetchImpl
      });
      result.pruned++;
      result.prunedMaskedKeys.push(credential.maskedApiKey || `#${credentialId}`);
      existingHashes.delete(hash);
    } catch (error) {
      result.errors.push(
        `删除残留凭据 ${credential.maskedApiKey || `#${credentialId}`} 失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  for (const account of uniqueAccounts.values()) {
    const hash = sha256Hex(account.kiroApiKey);
    if (existingHashes.has(hash)) {
      result.skippedExisting++;
      continue;
    }
    try {
      const created = await requestJson(
        input.fetchImpl,
        `${baseUrl}/credentials`,
        adminApiKey,
        timeoutMs,
        {
          method: "POST",
          body: {
            authMethod: "api_key",
            kiroApiKey: account.kiroApiKey,
            authRegion: account.region,
            apiRegion: account.region,
            priority: 0,
            // 没有它 Admin 卡片只显示「凭据 #id」，跟本地账号对不上
            email: normalizeLocalAdminEmail(account.email)
          }
        }
      );
      const credentialId = readCredentialId(created);
      if (!credentialId) throw new Error("本机 Admin 未返回 credentialId");
      result.synced++;
      await requestJson(
        input.fetchImpl,
        `${baseUrl}/credentials/${encodeURIComponent(credentialId)}/balance`,
        adminApiKey,
        timeoutMs,
        { method: "GET" }
      );
      result.verified++;
      existingHashes.add(hash);
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return result;
}
function describeProbeVerdict(verdict) {
  if (verdict === LOCAL_ADMIN_PROBE_VERDICT.PERMANENTLY_INVALID) {
    return "账号已失效（认证失败 / 封禁 / 配额耗尽）";
  }
  if (verdict === LOCAL_ADMIN_PROBE_VERDICT.TRANSIENT) {
    return "暂时无法确认（超时 / 限流 / 上游 5xx），请稍后重推";
  }
  return "未验证";
}
async function verifyOrRollback(context, verify, describe, tolerate) {
  try {
    await verify();
    return;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (tolerate?.(detail)) return;
    let removed = false;
    try {
      await deleteRemoteCredential({
        baseUrl: context.baseUrl,
        adminApiKey: context.adminApiKey,
        timeoutMs: context.timeoutMs,
        credentialId: context.credentialId,
        disabled: false,
        fetchImpl: context.fetchImpl
      });
      removed = true;
    } catch {
      removed = false;
    }
    throw new Error(
      removed ? `${describe(detail)}；已从 Admin 删除该凭据` : `${describe(detail)}；且删除凭据 #${context.credentialId} 失败，需要手动清理`
    );
  }
}
function isBalanceQueryUnauthorized(detail) {
  return detail.includes("权限不足") || detail.includes("User is not authorized to make this call");
}
const TRANSIENT_BALANCE_FAILURE_PATTERN = /\bHTTP (?:408|425|429|5\d{2})\b|fetch failed|error sending request|network|timed?\s*out|timeout|aborted|aborterror|econnreset|econnrefused|eai_again|enotfound|超时|网络|连接失败/i;
function isTransientBalanceQueryFailure(detail) {
  return TRANSIENT_BALANCE_FAILURE_PATTERN.test(detail);
}
async function pushAccountToLocalAdmin(input) {
  const resolved = resolveLocalAdminCredentialPayload(input.candidate);
  if (!resolved.ok) throw new Error(resolved.reason);
  const baseUrl = resolveLocalAdminApiBase(input.baseUrl);
  const adminApiKey = input.adminApiKey.trim();
  if (!adminApiKey) throw new Error("未配置本机 Admin API Key");
  const timeoutMs = Math.max(3, input.timeoutSeconds) * 1e3;
  const payload = resolved.payload;
  const isApiKey = payload.authMethod === LOCAL_ADMIN_AUTH_METHOD.API_KEY;
  const hash = sha256Hex(isApiKey ? payload.kiroApiKey : payload.refreshToken);
  const existing = readRemoteCredentials(
    await requestJson(input.fetchImpl, `${baseUrl}/credentials`, adminApiKey, timeoutMs, {
      method: "GET"
    })
  ).find((credential) => (isApiKey ? credential.apiKeyHash : credential.refreshTokenHash) === hash);
  if (existing) {
    return {
      status: "existing",
      credentialId: remoteCredentialId(existing),
      verified: false,
      authMethod: payload.authMethod,
      probeVerdict: LOCAL_ADMIN_PROBE_VERDICT.SKIPPED
    };
  }
  const created = await requestJson(
    input.fetchImpl,
    `${baseUrl}/credentials`,
    adminApiKey,
    timeoutMs,
    { method: "POST", body: payload }
  );
  const credentialId = readCredentialId(created);
  if (!credentialId) throw new Error("本机 Admin 未返回 credentialId");
  let balanceVerified = true;
  await verifyOrRollback(
    { baseUrl, adminApiKey, timeoutMs, credentialId, fetchImpl: input.fetchImpl },
    async () => {
      await requestJson(
        input.fetchImpl,
        `${baseUrl}/credentials/${encodeURIComponent(credentialId)}/balance`,
        adminApiKey,
        timeoutMs,
        { method: "GET" }
      );
    },
    (detail) => `本机 Admin 无法使用该凭据（余额接口失败）：${detail}`,
    (detail) => {
      if (!input.probeLiveness) return false;
      if (!isBalanceQueryUnauthorized(detail) && !isTransientBalanceQueryFailure(detail)) {
        return false;
      }
      balanceVerified = false;
      return true;
    }
  );
  let probeVerdict = LOCAL_ADMIN_PROBE_VERDICT.SKIPPED;
  if (input.probeLiveness) {
    await verifyOrRollback(
      { baseUrl, adminApiKey, timeoutMs, credentialId, fetchImpl: input.fetchImpl },
      async () => {
        const outcome = await input.probeLiveness(input.candidate);
        probeVerdict = outcome.verdict;
        if (outcome.verdict === LOCAL_ADMIN_PROBE_VERDICT.ALIVE || outcome.verdict === LOCAL_ADMIN_PROBE_VERDICT.TRANSIENT) {
          return;
        }
        throw new Error(outcome.error || describeProbeVerdict(outcome.verdict));
      },
      (detail) => `发消息验活未通过：${detail}`
    );
  }
  return {
    status: "created",
    credentialId,
    /*
     * verified 说的是「余额接口调通了」。余额失败被发消息验活兜底时如实报 false；
     * probeVerdict 则独立说明真实发消息是 alive、transient 还是未执行。
     */
    verified: balanceVerified,
    authMethod: payload.authMethod,
    probeVerdict
  };
}
const KSK_CREDENTIAL_VALIDATION_CONCURRENCY = 4;
const KSK_CLEANUP_FALLBACK_MODEL = "claude-haiku-4.5";
const KSK_CLEANUP_MAX_OUTPUT_TOKENS = 8;
const KSK_CLEANUP_PROBE_TIMEOUT_MS = 45e3;
function resolveKskLivenessMessage(configured) {
  return configured?.trim() || KSK_LIVENESS_PROBE_MESSAGE;
}
function pickCheapestModelId(models) {
  const usable = models.filter((model) => model.modelId && model.status !== "DEPRECATED");
  if (usable.length === 0) return void 0;
  const cheapest = usable.reduce((best, candidate) => {
    const bestRate = best.rateMultiplier ?? Number.POSITIVE_INFINITY;
    const candidateRate = candidate.rateMultiplier ?? Number.POSITIVE_INFINITY;
    if (candidateRate !== bestRate) return candidateRate < bestRate ? candidate : best;
    return candidate.modelId < best.modelId ? candidate : best;
  });
  return cheapest.modelId;
}
async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await worker(items[index], index);
      }
    })
  );
  return results;
}
function removeMatchingInvalidKskAccounts(current, invalidAccounts) {
  const accounts = { ...current.accounts ?? {} };
  const bindings = { ...current.accountProxyBindings ?? {} };
  const removedIds = [];
  for (const [accountId, expected] of invalidAccounts) {
    const account = accounts[accountId];
    if (!account || account.groupId !== expected.groupId || account.credentials?.credentialKind !== "kiro_api_key" || account.credentials.kiroApiKey !== expected.key) {
      continue;
    }
    delete accounts[accountId];
    delete bindings[accountId];
    removedIds.push(accountId);
  }
  if (removedIds.length === 0) return { data: current, removedIds };
  return {
    data: {
      ...current,
      accounts,
      accountProxyBindings: bindings,
      activeAccountId: removedIds.includes(current.activeAccountId ?? "") ? null : current.activeAccountId
    },
    removedIds
  };
}
const KSK_PROBE_VERDICT = {
  ALIVE: "alive",
  PERMANENTLY_INVALID: "permanently_invalid",
  TRANSIENT: "transient"
};
function classifyKskProbeError(error) {
  const upstream = normalizeKiroUpstreamError(error);
  if (upstream.retryCategory === UpstreamRetryCategory.AUTHENTICATION || upstream.retryCategory === UpstreamRetryCategory.MONTHLY_QUOTA) {
    return KSK_PROBE_VERDICT.PERMANENTLY_INVALID;
  }
  if (upstream.retryCategory === UpstreamRetryCategory.NONE && upstream.statusCode !== void 0 && upstream.statusCode >= 400 && upstream.statusCode < 500 && !isRequestSideRejection(upstream.statusCode)) {
    return KSK_PROBE_VERDICT.PERMANENTLY_INVALID;
  }
  return KSK_PROBE_VERDICT.TRANSIENT;
}
function isRequestSideRejection(statusCode) {
  return statusCode === 400;
}
const EMPTY_STATUS$2 = {
  state: KSK_AUTOMATION_STATE.IDLE,
  running: false,
  consecutiveFailures: 0,
  lastFetchedCount: 0,
  lastAddedCount: 0,
  totalAddedCount: 0,
  lastRejectedCount: 0,
  lastEmailedCount: 0,
  lastLocalAdminSyncedCount: 0,
  lastLocalAdminVerifiedCount: 0,
  lastLocalAdminPrunedCount: 0,
  lastCleanupCheckedCount: 0,
  lastCleanupRemovedCount: 0,
  lastCleanupRetainedCount: 0,
  logs: []
};
class KskAutomationRunner {
  constructor(deps, initialStatus = EMPTY_STATUS$2) {
    this.deps = deps;
    this.status = { ...initialStatus, running: false, nextRunAt: void 0 };
    this.logs.push(...initialStatus.logs ?? []);
  }
  timer = null;
  stopped = true;
  roundPromise = null;
  /** 周期性全量验活的定时器，与 Provider 轮询各自独立。 */
  cleanupTimer = null;
  cleanupRoundPromise = null;
  /**
   * 正在进行的全量验活。
   *
   * Provider 新增触发的清理与周期性清理会撞在一起，两个同时跑就是把每个号的
   * 验活 credits 花两遍。并发调用一律汇聚到同一次执行上。
   */
  cleanupPassPromise = null;
  localAdminRunning = false;
  localAdminQueued = false;
  localAdminPromise = null;
  lastLocalAdminIssues = [];
  pendingEmail = /* @__PURE__ */ new Map();
  /**
   * 已经发过邮件的 key。
   *
   * 光靠 importCredential 的 added 标志不够：验活误删刚入库的号后，
   * 下一轮同一个 key 会重新入库并再次算作「新增」，导致重复发信。
   * 这里按 key 记账，同一个 key 只通知一次。
   */
  emailedKeys = /* @__PURE__ */ new Set();
  /**
   * 发消息验活判为永久失效的 KSK 明文黑名单。
   *
   * 入库验活与全量清理现在同一口径（都发消息），但 Provider 会反复返回同一批号，
   * 每轮都重新验一遍就是白烧 credits。记住判死的号，下一轮直接跳过。
   *
   * 只存在内存里：重启后账号库里本就没有这些号，重新试一次的代价可接受，
   * 也避免把用户后来手动续费修好的号永久拒之门外。
   */
  invalidKeys = /* @__PURE__ */ new Set();
  /**
   * 运行日志环形缓冲。
   *
   * 不放在 status 里逐次 spread：status 到处被 `{ ...this.status, ... }` 覆写，
   * 日志混在里面很容易被某个分支的旧快照回滚掉。快照时再拼进去。
   */
  logs = [];
  status;
  snapshot() {
    return { ...this.status, logs: [...this.logs] };
  }
  async start() {
    this.stop();
    const task = await this.deps.readTask();
    if (!task || !task.enabled) {
      this.status = { ...this.status, state: KSK_AUTOMATION_STATE.IDLE, running: false };
      this.pushStatus();
      return;
    }
    this.stopped = false;
    if (task.config.providerEnabled && task.secrets.providerUrl) this.scheduleNext(0);
    else this.pushStatus();
    if (task.config.localAdminEnabled) this.queueLocalAdminSync();
    if (task.config.cleanupPeriodicEnabled && this.deps.cleanupProxyAccounts) {
      this.scheduleCleanup(0);
    }
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
    this.cleanupTimer = null;
    this.localAdminQueued = false;
    this.status = { ...this.status, running: false, nextRunAt: void 0, nextCleanupAt: void 0 };
  }
  /** 手动触发一次全量验活，不等周期到点。 */
  async cleanupNow() {
    const task = await this.deps.readTask();
    if (!task?.enabled) throw new Error("任务已暂停，请先恢复任务");
    if (!this.deps.cleanupProxyAccounts) throw new Error("当前构建未接入账号清理能力");
    this.stopped = false;
    this.log("手动触发全量验活");
    await this.runCleanupRound();
    return this.snapshot();
  }
  /** 外部（额度耗尽清理）判死的 key：拉黑，避免下一轮 Provider 又把它拉回来。 */
  blacklistKeys(keys) {
    for (const key of keys) {
      this.invalidKeys.add(key);
      this.pendingEmail.delete(key);
    }
  }
  async runNow() {
    const task = await this.deps.readTask();
    if (!task?.enabled) throw new Error("任务已暂停，请先恢复任务");
    if (!task.config.providerEnabled || !task.secrets.providerUrl) {
      throw new Error("任务未开启 KSK Provider 拉取或未配置 URL");
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stopped = false;
    this.log("手动触发立即执行");
    await this.runRound();
    return this.snapshot();
  }
  queueLocalAdminSync() {
    if (this.stopped) return;
    this.localAdminQueued = true;
    if (this.localAdminPromise) return;
    this.localAdminPromise = this.drainLocalAdminQueue().finally(() => {
      this.localAdminPromise = null;
      if (this.localAdminQueued) this.queueLocalAdminSync();
    });
  }
  async syncLocalAdminNow() {
    const task = await this.deps.readTask();
    if (!task?.enabled) throw new Error("任务已暂停，请先恢复任务");
    if (!task.config.localAdminEnabled) throw new Error("任务未开启本机 Admin 同步");
    this.stopped = false;
    this.log("手动触发本机 Admin 同步");
    this.queueLocalAdminSync();
    while (this.localAdminPromise) await this.localAdminPromise;
    return this.snapshot();
  }
  scheduleNext(delayMs) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.status = { ...this.status, nextRunAt: Date.now() + delayMs };
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runRound();
    }, delayMs);
    this.pushStatus();
  }
  runRound() {
    if (this.roundPromise) return this.roundPromise;
    this.roundPromise = this.executeRound().finally(() => {
      this.roundPromise = null;
    });
    return this.roundPromise;
  }
  scheduleCleanup(delayMs) {
    if (this.stopped) return;
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
    this.status = { ...this.status, nextCleanupAt: Date.now() + delayMs };
    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = null;
      void this.runCleanupRound();
    }, delayMs);
    this.pushStatus();
  }
  runCleanupRound() {
    if (this.cleanupRoundPromise) return this.cleanupRoundPromise;
    this.cleanupRoundPromise = this.executeCleanupRound().finally(() => {
      this.cleanupRoundPromise = null;
    });
    return this.cleanupRoundPromise;
  }
  /**
   * 独立周期的全量验活。
   *
   * 与 Provider 轮询分开跑：轮询只在有新号时才顺手清理，号池干涸时一次都不跑，
   * 已入库的号后来挂掉（订阅到期、被封）就一直赖在反代池子里。
   *
   * 判死的号除了从本地账号库删掉，还要同步从本机 Admin 摘掉，否则反代会继续拿它打上游。
   */
  async executeCleanupRound() {
    try {
      const task = await this.deps.readTask();
      if (!task?.enabled || !task.config.cleanupPeriodicEnabled || !this.deps.cleanupProxyAccounts) {
        this.status = { ...this.status, nextCleanupAt: void 0 };
        this.pushStatus();
        return;
      }
      const { doomedKeys, issues } = await this.runCleanupPass(task);
      if (doomedKeys.length > 0 && task.config.localAdminEnabled) {
        issues.push(...await this.deleteFromLocalAdmin(task, doomedKeys));
      }
      if (doomedKeys.length > 0) this.deps.notifyAccountsChanged();
      if (issues.length > 0) {
        this.status = {
          ...this.status,
          state: KSK_AUTOMATION_STATE.DEGRADED,
          lastError: issues.join("；")
        };
      }
    } catch (error) {
      const message = `周期性全量验活失败：${error instanceof Error ? error.message : String(error)}`;
      this.status = { ...this.status, state: KSK_AUTOMATION_STATE.DEGRADED, lastError: message };
      this.log(message, KSK_AUTOMATION_LOG_LEVEL.ERROR);
    } finally {
      this.pushStatus();
      const task = await this.deps.readTask().catch(() => void 0);
      if (!this.stopped && task?.enabled && task.config.cleanupPeriodicEnabled) {
        this.scheduleCleanup(task.config.cleanupIntervalMinutes * 6e4);
      }
    }
  }
  /**
   * 跑一次全量验活，返回判死的 key 与问题描述。
   *
   * 并发调用汇聚到同一次执行：新增触发与周期触发撞在一起时，重复验活等于把每个号的
   * credits 花两遍，而两者要的结果完全一样。
   */
  runCleanupPass(task) {
    if (this.cleanupPassPromise) return this.cleanupPassPromise;
    this.cleanupPassPromise = this.executeCleanupPass(task).finally(() => {
      this.cleanupPassPromise = null;
    });
    return this.cleanupPassPromise;
  }
  async executeCleanupPass(task) {
    const outcome = { doomedKeys: [], issues: [] };
    if (!this.deps.cleanupProxyAccounts) return outcome;
    const liveness = {
      model: task.config.livenessModel,
      message: task.config.livenessMessage
    };
    try {
      const cleanup = await this.deps.cleanupProxyAccounts(task.config.providerGroupId, liveness);
      for (const key of cleanup.removedKeys ?? []) {
        this.invalidKeys.add(key);
        this.pendingEmail.delete(key);
        outcome.doomedKeys.push(key);
      }
      this.status = {
        ...this.status,
        lastCleanupCheckedCount: cleanup.checked,
        lastCleanupRemovedCount: cleanup.removed,
        lastCleanupRetainedCount: cleanup.retainedTransient,
        lastCleanupAt: Date.now()
      };
      this.log(`全量验活检查 ${cleanup.checked} 个账号，删除 ${cleanup.removed} 个失效号`);
      outcome.issues.push(...cleanup.errors);
      for (const issue of cleanup.errors) {
        this.log(`全量验活：${issue}`, KSK_AUTOMATION_LOG_LEVEL.WARN);
      }
      if (cleanup.retainedTransient > 0) {
        outcome.issues.push(`保留 ${cleanup.retainedTransient} 个暂时无法确认的账号`);
        this.log(
          `保留 ${cleanup.retainedTransient} 个暂时无法确认的账号，待下轮复核`,
          KSK_AUTOMATION_LOG_LEVEL.WARN
        );
      }
    } catch (error) {
      const message = `Proxy RS 清理失败：${error instanceof Error ? error.message : String(error)}`;
      outcome.issues.push(message);
      this.log(message, KSK_AUTOMATION_LOG_LEVEL.ERROR);
    }
    return outcome;
  }
  async executeRound() {
    this.status = {
      ...this.status,
      state: KSK_AUTOMATION_STATE.RUNNING,
      running: true,
      lastAttemptAt: Date.now(),
      nextRunAt: void 0,
      lastAddedCount: 0,
      lastRejectedCount: 0,
      lastEmailedCount: 0
      /*
       * 清理计数不在这里归零：全量验活现在有独立周期，Provider 轮询把它清零会让
       * 界面上刚跑完的周期清理结果被下一次拉取擦成 0。计数由 executeCleanupPass 自己覆写。
       */
    };
    this.pushStatus();
    try {
      const task = await this.deps.readTask();
      if (!task?.enabled || !task.config.providerEnabled || !task.secrets.providerUrl) {
        this.stopped = true;
        this.status = { ...this.status, state: KSK_AUTOMATION_STATE.IDLE, running: false };
        return;
      }
      const providerUrl = new URL(task.secrets.providerUrl);
      if (providerUrl.protocol !== "https:") throw new Error("KSK 提供接口必须使用 HTTPS");
      const payload = await this.fetchProvider(
        providerUrl.toString(),
        task.config.requestTimeoutSeconds
      );
      const parsed = parseKskProviderResponse(payload);
      const liveness = {
        model: task.config.livenessModel,
        message: task.config.livenessMessage
      };
      let importFailureCount = 0;
      const importable = parsed.credentials.filter(
        (credential) => !this.invalidKeys.has(credential.key)
      );
      const importResults = await mapWithConcurrency(
        importable,
        KSK_CREDENTIAL_VALIDATION_CONCURRENCY,
        async (credential, index) => {
          try {
            return await this.deps.importCredential({
              ...credential,
              groupId: task.config.providerGroupId,
              liveness
            });
          } catch {
            importFailureCount++;
            this.log(
              `第 ${index + 1} 条 Provider KSK 验活或入库失败`,
              KSK_AUTOMATION_LOG_LEVEL.WARN
            );
            return null;
          }
        }
      );
      const added = importResults.filter(
        (credential) => Boolean(credential?.added)
      );
      const rejectedKeys = importResults.filter((credential) => credential?.rejected).map((credential) => credential.key);
      for (const key of rejectedKeys) this.invalidKeys.add(key);
      const roundIssues = [];
      const doomedKeys = new Set(rejectedKeys);
      if (added.length > 0) {
        if (task.config.cleanupInvalidOnAdd && this.deps.cleanupProxyAccounts) {
          const cleanup = await this.runCleanupPass(task);
          for (const key of cleanup.doomedKeys) doomedKeys.add(key);
          roundIssues.push(...cleanup.issues);
        }
        if (task.config.localAdminEnabled) {
          roundIssues.push(...await this.deleteFromLocalAdmin(task, [...doomedKeys]));
          this.queueLocalAdminSync();
          while (this.localAdminPromise) await this.localAdminPromise;
          roundIssues.push(...this.lastLocalAdminIssues);
        }
        this.deps.notifyAccountsChanged();
      } else if (doomedKeys.size > 0 && task.config.localAdminEnabled) {
        roundIssues.push(...await this.deleteFromLocalAdmin(task, [...doomedKeys]));
      }
      this.status = {
        ...this.status,
        lastFetchedCount: parsed.credentials.length,
        lastAddedCount: added.length,
        totalAddedCount: this.status.totalAddedCount + added.length,
        lastRejectedCount: rejectedKeys.length
      };
      const skippedCount = parsed.credentials.length - importable.length;
      this.log(
        `本轮拉到 ${parsed.credentials.length} 条，新增 ${added.length} 个` + (rejectedKeys.length > 0 ? `，验活未通过 ${rejectedKeys.length} 个` : "") + (skippedCount > 0 ? `，跳过已知失效 ${skippedCount} 个` : "")
      );
      if (parsed.rejectedCount > 0) {
        this.log(`忽略 ${parsed.rejectedCount} 条无效或重复记录`, KSK_AUTOMATION_LOG_LEVEL.WARN);
      }
      let emailedCount = 0;
      if (task.config.emailEnabled) {
        for (const credential of added) {
          if (this.emailedKeys.has(credential.key)) continue;
          if (this.invalidKeys.has(credential.key)) continue;
          this.pendingEmail.set(credential.key, {
            key: credential.key,
            region: credential.region
          });
        }
        const pending = [...this.pendingEmail.values()];
        if (pending.length > 0) {
          emailedCount = await (this.deps.sendAddedEmail ?? sendKskAddedEmail)(
            {
              host: task.config.smtpHost,
              port: task.config.smtpPort,
              secure: task.config.smtpSecure,
              username: task.config.smtpUsername,
              password: task.secrets.smtpPassword,
              from: task.config.smtpFrom,
              to: task.config.smtpTo
            },
            pending
          );
          for (const credential of pending) this.emailedKeys.add(credential.key);
          this.pendingEmail.clear();
          this.log(`已发送新增通知邮件，包含 ${emailedCount} 个 KSK`);
        }
      } else {
        this.pendingEmail.clear();
      }
      roundIssues.push(
        parsed.rejectedCount > 0 ? `忽略 ${parsed.rejectedCount} 条无效或重复记录` : "",
        rejectedKeys.length > 0 ? `${rejectedKeys.length} 条 KSK 验活未通过，未入库` : "",
        importFailureCount > 0 ? `${importFailureCount} 条 KSK 验活或入库失败` : ""
      );
      const effectiveRoundIssues = roundIssues.filter(Boolean);
      this.status = {
        ...this.status,
        state: effectiveRoundIssues.length > 0 ? KSK_AUTOMATION_STATE.DEGRADED : KSK_AUTOMATION_STATE.HEALTHY,
        running: false,
        lastSuccessAt: Date.now(),
        lastError: effectiveRoundIssues.length > 0 ? effectiveRoundIssues.join("；") : void 0,
        consecutiveFailures: 0,
        lastEmailedCount: emailedCount
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.status = {
        ...this.status,
        state: KSK_AUTOMATION_STATE.DEGRADED,
        running: false,
        lastError: message,
        consecutiveFailures: this.status.consecutiveFailures + 1
      };
      this.log(`轮询失败：${message}`, KSK_AUTOMATION_LOG_LEVEL.ERROR);
    } finally {
      this.pushStatus();
      if (!this.stopped) this.scheduleNext(KSK_PROVIDER_POLL_INTERVAL_SECONDS * 1e3);
    }
  }
  async fetchProvider(url, timeoutSeconds) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(3, timeoutSeconds) * 1e3);
    try {
      const response = await this.deps.fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`KSK 提供接口请求失败: HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }
  /** 把本地判死的 key 从本机 Admin 上删掉；返回本次遇到的问题描述。 */
  async deleteFromLocalAdmin(task, keys) {
    if (keys.length === 0) return [];
    try {
      const removal = await deleteLocalAdminCredentialsByKey({
        keys,
        baseUrl: task.config.localAdminBaseUrl,
        adminApiKey: task.secrets.localAdminApiKey,
        timeoutSeconds: task.config.requestTimeoutSeconds,
        fetchImpl: this.deps.localAdminFetchImpl ?? this.deps.fetchImpl
      });
      if (removal.removed > 0) this.log(`已从本机 Admin 删除 ${removal.removed} 个失效凭据`);
      for (const issue of removal.errors) {
        this.log(`本机 Admin 删除失效凭据：${issue}`, KSK_AUTOMATION_LOG_LEVEL.WARN);
      }
      return removal.errors;
    } catch (error) {
      const message = `本机 Admin 清理失败：${error instanceof Error ? error.message : String(error)}`;
      this.log(message, KSK_AUTOMATION_LOG_LEVEL.ERROR);
      return [message];
    }
  }
  async drainLocalAdminQueue() {
    if (this.localAdminRunning) return;
    this.localAdminRunning = true;
    try {
      while (this.localAdminQueued) {
        this.localAdminQueued = false;
        await this.syncLocalAdmin();
      }
    } finally {
      this.localAdminRunning = false;
    }
  }
  async syncLocalAdmin() {
    try {
      const task = await this.deps.readTask();
      const groupId = task?.config.localAdminGroupId;
      if (!task?.enabled || !task.config.localAdminEnabled || !groupId) {
        this.lastLocalAdminIssues = [];
        if (task?.enabled && task.config.localAdminEnabled && !groupId) {
          this.log("未选择同步分组，跳过本机 Admin 同步", KSK_AUTOMATION_LOG_LEVEL.WARN);
          this.pushStatus();
        }
        return;
      }
      const accounts = await this.deps.readLocalAdminAccounts(groupId);
      if (accounts.length === 0) {
        this.lastLocalAdminIssues = [];
        this.log(
          "同步分组内没有可用的 Kiro API Key 账号，跳过本轮同步（不清理反代凭据）",
          KSK_AUTOMATION_LOG_LEVEL.WARN
        );
        this.pushStatus();
        return;
      }
      const result = await syncKskAccountsToLocalAdmin({
        accounts,
        baseUrl: task.config.localAdminBaseUrl,
        adminApiKey: task.secrets.localAdminApiKey,
        timeoutSeconds: task.config.requestTimeoutSeconds,
        fetchImpl: this.deps.localAdminFetchImpl ?? this.deps.fetchImpl
      });
      this.status = {
        ...this.status,
        lastLocalAdminSyncedCount: result.synced,
        lastLocalAdminVerifiedCount: result.verified,
        lastLocalAdminPrunedCount: result.pruned,
        lastError: result.errors.length > 0 ? result.errors.join("；") : this.status.lastError,
        state: result.errors.length > 0 ? KSK_AUTOMATION_STATE.DEGRADED : this.status.state
      };
      this.lastLocalAdminIssues = result.errors;
      for (const issue of result.errors) {
        this.log(`本机 Admin 同步：${issue}`, KSK_AUTOMATION_LOG_LEVEL.WARN);
      }
      if (result.pruned > 0) {
        this.log(
          `已从本机 Admin 清理 ${result.pruned} 个本地已不存在的凭据：` + result.prunedMaskedKeys.join("、")
        );
      }
      if (result.synced > 0 || result.verified > 0) {
        this.log(`已同步 ${result.synced} 个凭据到本机 Admin，其中 ${result.verified} 个验活通过`);
      }
      if (result.synced === 0 && result.pruned === 0 && result.errors.length === 0) {
        this.log(`本机 Admin 已与本地一致，${result.skippedExisting} 个凭据无需变更`);
      }
      this.pushStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.status = {
        ...this.status,
        state: KSK_AUTOMATION_STATE.DEGRADED,
        lastError: message
      };
      this.lastLocalAdminIssues = [message];
      this.log(`本机 Admin 同步失败：${message}`, KSK_AUTOMATION_LOG_LEVEL.ERROR);
      this.pushStatus();
    }
  }
  pushStatus() {
    this.deps.notifyStatus(this.snapshot());
  }
  log(message, level = KSK_AUTOMATION_LOG_LEVEL.INFO) {
    this.logs.push({ at: Date.now(), level, message });
    if (this.logs.length > KSK_AUTOMATION_LOG_LIMIT) {
      this.logs.splice(0, this.logs.length - KSK_AUTOMATION_LOG_LIMIT);
    }
    (this.deps.log ?? ((text) => console.log(text)))(
      `[KskAutomation:${this.deps.taskId}] ${message}`
    );
  }
}
class KskAutomationManager {
  constructor(deps) {
    this.deps = deps;
  }
  runners = /* @__PURE__ */ new Map();
  async start() {
    const store2 = await this.deps.readStore();
    for (const task of store2.tasks) await this.reloadTask(task.id);
  }
  stop() {
    for (const runner of this.runners.values()) runner.stop();
    this.runners.clear();
  }
  snapshot(taskId) {
    return this.runners.get(taskId)?.snapshot() ?? { ...EMPTY_STATUS$2, logs: [] };
  }
  async reloadTask(taskId) {
    const previous = this.runners.get(taskId);
    const previousStatus = previous?.snapshot();
    previous?.stop();
    this.runners.delete(taskId);
    const task = await this.deps.readTask(taskId);
    if (!task) return;
    const runner = new KskAutomationRunner(
      {
        taskId,
        readTask: () => this.deps.readTask(taskId),
        fetchImpl: this.deps.fetchImpl,
        localAdminFetchImpl: this.deps.localAdminFetchImpl,
        importCredential: this.deps.importCredential,
        readLocalAdminAccounts: this.deps.readLocalAdminAccounts,
        cleanupProxyAccounts: this.deps.cleanupProxyAccounts,
        notifyAccountsChanged: this.deps.notifyAccountsChanged,
        notifyStatus: (status) => this.deps.notifyStatus({ taskId, status }),
        sendAddedEmail: this.deps.sendAddedEmail,
        log: this.deps.log
      },
      previousStatus
    );
    this.runners.set(taskId, runner);
    await runner.start();
  }
  removeTask(taskId) {
    this.runners.get(taskId)?.stop();
    this.runners.delete(taskId);
  }
  async runNow(taskId) {
    if (!this.runners.has(taskId)) await this.reloadTask(taskId);
    const runner = this.runners.get(taskId);
    if (!runner) throw new Error("任务不存在或已删除");
    return runner.runNow();
  }
  async syncLocalAdminNow(taskId) {
    if (!this.runners.has(taskId)) await this.reloadTask(taskId);
    const runner = this.runners.get(taskId);
    if (!runner) throw new Error("任务不存在或已删除");
    return runner.syncLocalAdminNow();
  }
  async cleanupNow(taskId) {
    if (!this.runners.has(taskId)) await this.reloadTask(taskId);
    const runner = this.runners.get(taskId);
    if (!runner) throw new Error("任务不存在或已删除");
    return runner.cleanupNow();
  }
  queueLocalAdminSync() {
    for (const runner of this.runners.values()) runner.queueLocalAdminSync();
  }
  /**
   * 把外部判死的 key 拉黑到所有 runner。
   *
   * 额度耗尽清理走的是反代统计那条链路，它不知道这些号属于哪个任务；而只要有任何一个
   * 任务的 Provider 还会返回它，下一轮就会被重新拉回来。所以一律全量拉黑。
   */
  blacklistKeys(keys) {
    if (keys.length === 0) return;
    for (const runner of this.runners.values()) runner.blacklistKeys(keys);
  }
}
const STORE_FILE$5 = "ksk-automation.enc";
const LEGACY_TASK_ID = "legacy-ksk-automation";
const LEGACY_TASK_NAME = "自动拉取 KSK";
const EMPTY_STATUS$1 = {
  state: KSK_AUTOMATION_STATE.IDLE,
  running: false,
  consecutiveFailures: 0,
  lastFetchedCount: 0,
  lastAddedCount: 0,
  totalAddedCount: 0,
  lastRejectedCount: 0,
  lastEmailedCount: 0,
  lastLocalAdminSyncedCount: 0,
  lastLocalAdminVerifiedCount: 0,
  lastLocalAdminPrunedCount: 0,
  lastCleanupCheckedCount: 0,
  lastCleanupRemovedCount: 0,
  lastCleanupRetainedCount: 0,
  logs: []
};
let mutationQueue$5 = Promise.resolve();
function storePath$2() {
  return node_path.join(electron.app.getPath("userData"), STORE_FILE$5);
}
function positiveInt$1(value, fallback, min, max) {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numberValue)));
}
function normalizeOptionalId(value) {
  if (typeof value !== "string") return void 0;
  return value.trim() || void 0;
}
function normalizeString$1(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}
function normalizeSecrets(input) {
  return {
    providerUrl: normalizeString$1(input?.providerUrl),
    smtpPassword: normalizeString$1(input?.smtpPassword),
    localAdminApiKey: normalizeString$1(input?.localAdminApiKey)
  };
}
function normalizeKskAutomationConfig(input) {
  const source = input ?? {};
  return {
    providerEnabled: source.providerEnabled === true,
    providerGroupId: normalizeOptionalId(source.providerGroupId),
    requestTimeoutSeconds: positiveInt$1(
      source.requestTimeoutSeconds,
      KSK_AUTOMATION_REQUEST_TIMEOUT_SECONDS,
      3,
      120
    ),
    cleanupInvalidOnAdd: source.cleanupInvalidOnAdd !== false,
    cleanupPeriodicEnabled: source.cleanupPeriodicEnabled !== false,
    cleanupIntervalMinutes: positiveInt$1(
      source.cleanupIntervalMinutes,
      KSK_CLEANUP_INTERVAL_MINUTES,
      KSK_CLEANUP_INTERVAL_MIN_MINUTES,
      KSK_CLEANUP_INTERVAL_MAX_MINUTES
    ),
    autoDeleteExhausted: source.autoDeleteExhausted !== false,
    livenessModel: normalizeString$1(source.livenessModel),
    livenessMessage: normalizeString$1(source.livenessMessage),
    emailEnabled: source.emailEnabled === true,
    smtpHost: normalizeString$1(source.smtpHost),
    smtpPort: positiveInt$1(source.smtpPort, DEFAULT_KSK_AUTOMATION_CONFIG.smtpPort, 1, 65535),
    smtpSecure: source.smtpSecure !== false,
    smtpUsername: normalizeString$1(source.smtpUsername),
    smtpFrom: normalizeString$1(source.smtpFrom),
    smtpTo: normalizeString$1(source.smtpTo),
    localAdminEnabled: source.localAdminEnabled === true,
    localAdminGroupId: normalizeOptionalId(source.localAdminGroupId),
    localAdminBaseUrl: normalizeString$1(source.localAdminBaseUrl) || DEFAULT_KSK_AUTOMATION_CONFIG.localAdminBaseUrl
  };
}
function emptyStore$1() {
  return { version: KSK_AUTOMATION_STORE_VERSION, tasks: [] };
}
function normalizeTask(value, now) {
  if (!value || typeof value !== "object") return null;
  const source = value;
  const id = normalizeString$1(source.id);
  if (!id) return null;
  const createdAt = positiveInt$1(source.createdAt, now, 0, Number.MAX_SAFE_INTEGER);
  return {
    id,
    name: normalizeString$1(source.name) || LEGACY_TASK_NAME,
    type: KSK_AUTOMATION_TASK_TYPE,
    enabled: source.enabled !== false,
    createdAt,
    updatedAt: positiveInt$1(source.updatedAt, createdAt, 0, Number.MAX_SAFE_INTEGER),
    config: normalizeKskAutomationConfig(source.config),
    secrets: normalizeSecrets(source.secrets)
  };
}
function normalizeKskAutomationStorePayload(payload, now = Date.now()) {
  if (!payload || typeof payload !== "object") return emptyStore$1();
  const source = payload;
  if (source.version === KSK_AUTOMATION_STORE_VERSION && Array.isArray(source.tasks)) {
    const ids = /* @__PURE__ */ new Set();
    const tasks = source.tasks.map((task) => normalizeTask(task, now)).filter((task) => Boolean(task)).filter((task) => {
      if (ids.has(task.id)) return false;
      ids.add(task.id);
      return true;
    });
    return { version: KSK_AUTOMATION_STORE_VERSION, tasks };
  }
  const config = normalizeKskAutomationConfig(source.config);
  const secrets = normalizeSecrets(source.secrets);
  const hasLegacyTask = config.providerEnabled || config.localAdminEnabled || Boolean(secrets.providerUrl || secrets.smtpPassword || secrets.localAdminApiKey);
  if (!hasLegacyTask) return emptyStore$1();
  return {
    version: KSK_AUTOMATION_STORE_VERSION,
    tasks: [
      {
        id: LEGACY_TASK_ID,
        name: LEGACY_TASK_NAME,
        type: KSK_AUTOMATION_TASK_TYPE,
        enabled: config.providerEnabled || config.localAdminEnabled,
        createdAt: now,
        updatedAt: now,
        config,
        secrets
      }
    ]
  };
}
function isKskAutomationStoreAvailable() {
  try {
    return electron.safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}
async function loadKskAutomationStore() {
  if (!isKskAutomationStoreAvailable()) return emptyStore$1();
  try {
    const encrypted = await node_fs.promises.readFile(storePath$2());
    return normalizeKskAutomationStorePayload(JSON.parse(electron.safeStorage.decryptString(encrypted)));
  } catch (error) {
    if (error.code === "ENOENT") return emptyStore$1();
    throw new Error("自动任务配置无法解密或已损坏，已拒绝用空配置覆盖原文件");
  }
}
async function loadKskAutomationTask(taskId) {
  return (await loadKskAutomationStore()).tasks.find((task) => task.id === taskId);
}
async function saveStore$1(store2) {
  if (!isKskAutomationStoreAvailable()) {
    throw new Error("系统加密存储不可用，拒绝明文保存 Provider URL、SMTP 密码或 Admin API Key");
  }
  const encrypted = electron.safeStorage.encryptString(JSON.stringify(store2));
  await node_fs.promises.writeFile(storePath$2(), encrypted, { mode: 384 });
}
async function mutateStore(mutate) {
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  mutationQueue$5 = mutationQueue$5.then(async () => {
    const store2 = await loadKskAutomationStore();
    const value = await mutate(store2);
    await saveStore$1(store2);
    resolveResult(value);
  }).catch((error) => {
    rejectResult(error);
  });
  return result;
}
function mergeSecrets(current, input) {
  return {
    providerUrl: input?.providerUrl === void 0 ? current.providerUrl : normalizeString$1(input.providerUrl),
    smtpPassword: input?.smtpPassword === void 0 ? current.smtpPassword : normalizeString$1(input.smtpPassword),
    localAdminApiKey: input?.localAdminApiKey === void 0 ? current.localAdminApiKey : normalizeString$1(input.localAdminApiKey)
  };
}
async function createKskAutomationTask(id, input) {
  return mutateStore((store2) => {
    const now = Date.now();
    const task = {
      id,
      name: normalizeString$1(input.name) || LEGACY_TASK_NAME,
      type: KSK_AUTOMATION_TASK_TYPE,
      enabled: input.enabled !== false,
      createdAt: now,
      updatedAt: now,
      config: normalizeKskAutomationConfig(input.config),
      secrets: mergeSecrets(normalizeSecrets(void 0), input.secrets)
    };
    store2.tasks.push(task);
    return task;
  });
}
async function updateKskAutomationTask(taskId, input) {
  return mutateStore((store2) => {
    const task = store2.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error("任务不存在或已删除");
    task.name = normalizeString$1(input.name) || task.name;
    task.enabled = input.enabled ?? task.enabled;
    task.config = normalizeKskAutomationConfig({ ...task.config, ...input.config });
    task.secrets = mergeSecrets(task.secrets, input.secrets);
    task.updatedAt = Date.now();
    return task;
  });
}
async function setKskAutomationTaskEnabled(taskId, enabled) {
  return mutateStore((store2) => {
    const task = store2.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error("任务不存在或已删除");
    task.enabled = enabled;
    task.updatedAt = Date.now();
    return task;
  });
}
async function deleteKskAutomationTask(taskId) {
  return mutateStore((store2) => {
    const index = store2.tasks.findIndex((item) => item.id === taskId);
    if (index < 0) throw new Error("任务不存在或已删除");
    store2.tasks.splice(index, 1);
  });
}
function toKskAutomationConfigView(task) {
  return {
    ...task.config,
    pollIntervalSeconds: KSK_PROVIDER_POLL_INTERVAL_SECONDS,
    encryptionAvailable: isKskAutomationStoreAvailable(),
    hasProviderUrl: Boolean(task.secrets.providerUrl),
    providerUrlHint: providerUrlHint(task.secrets.providerUrl),
    hasSmtpPassword: Boolean(task.secrets.smtpPassword),
    hasLocalAdminApiKey: Boolean(task.secrets.localAdminApiKey),
    localAdminApiKeyTail: maskSecretTail(task.secrets.localAdminApiKey)
  };
}
function toKskAutomationTaskView(task, status = EMPTY_STATUS$1) {
  return {
    id: task.id,
    name: task.name,
    type: task.type,
    enabled: task.enabled,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    config: toKskAutomationConfigView(task),
    status: { ...status, logs: [...status.logs ?? []] }
  };
}
const KSK_AUTOMATION_CHANNEL = {
  list: "ksk-automation-list",
  create: "ksk-automation-create",
  update: "ksk-automation-update",
  setEnabled: "ksk-automation-set-enabled",
  delete: "ksk-automation-delete",
  syncNow: "ksk-automation-sync-now",
  syncLocalAdminNow: "ksk-automation-sync-local-admin-now",
  cleanupNow: "ksk-automation-cleanup-now",
  pushAccountToLocalAdmin: "ksk-automation-push-account-to-local-admin",
  statusEvent: "ksk-automation-status-changed",
  accountsChangedEvent: "ksk-automation-accounts-changed"
};
function sendEvent(getMainWindow, channel, payload) {
  const win2 = getMainWindow();
  if (win2 && !win2.isDestroyed()) win2.webContents.send(channel, payload);
}
function sendKskAutomationStatus(getMainWindow, event) {
  sendEvent(getMainWindow, KSK_AUTOMATION_CHANNEL.statusEvent, event);
}
function sendKskAutomationAccountsChanged(getMainWindow) {
  sendEvent(getMainWindow, KSK_AUTOMATION_CHANNEL.accountsChangedEvent);
}
function mergedSecrets(current, input) {
  return {
    providerUrl: input?.providerUrl === void 0 ? current.providerUrl : input.providerUrl.trim(),
    smtpPassword: input?.smtpPassword === void 0 ? current.smtpPassword : input.smtpPassword.trim(),
    localAdminApiKey: input?.localAdminApiKey === void 0 ? current.localAdminApiKey : input.localAdminApiKey.trim()
  };
}
async function validateEnabledTask(task) {
  if (!task.name.trim()) throw new Error("请输入任务名称");
  if (!task.enabled) return;
  if (task.config.providerEnabled) {
    if (!task.secrets.providerUrl) throw new Error("开启任务前请配置 KSK Provider URL");
    const providerUrl = new URL(task.secrets.providerUrl);
    if (providerUrl.protocol !== "https:") throw new Error("KSK Provider URL 必须使用 HTTPS");
  }
  if (task.config.emailEnabled) {
    const hasRecipient = parseKskEmailRecipients(task.config.smtpTo).length > 0;
    if (!task.config.smtpHost || !task.config.smtpFrom || !hasRecipient) {
      throw new Error("开启邮件通知前请填写 SMTP Host、发件人和收件人");
    }
    if (task.config.smtpUsername && !task.secrets.smtpPassword) {
      throw new Error("SMTP 用户名已配置，请填写 SMTP 密码");
    }
  }
  if (task.config.localAdminEnabled) {
    if (!task.config.localAdminGroupId) throw new Error("请选择要同步到本机 Admin 的分组");
    if (!task.secrets.localAdminApiKey) throw new Error("开启本机同步前请填写 Admin API Key");
    resolveLocalAdminApiBase(task.config.localAdminBaseUrl);
  }
}
async function listTaskViews(manager) {
  const store2 = await loadKskAutomationStore();
  return store2.tasks.map((task) => toKskAutomationTaskView(task, manager.snapshot(task.id)));
}
function toError$3(error) {
  return { success: false, error: error instanceof Error ? error.message : String(error) };
}
const LOCAL_ADMIN_PUSH_LOG_CATEGORY = "LocalAdminPush";
function logLocalAdminPush(message) {
  console.log(`[${LOCAL_ADMIN_PUSH_LOG_CATEGORY}] ${message}`);
}
function logLocalAdminPushError(message) {
  console.error(`[${LOCAL_ADMIN_PUSH_LOG_CATEGORY}] ${message}`);
}
function describePushCandidate(candidate) {
  const kind = candidate.credentialKind === "kiro_api_key" || candidate.kiroApiKey ? "api_key" : "oauth";
  const authMethod = candidate.authMethod ?? "未声明";
  return `${kind} / authMethod=${authMethod} / region=${candidate.region?.trim() || "未填"}`;
}
async function resolveLocalAdminTarget() {
  const store2 = await loadKskAutomationStore();
  const candidates = store2.tasks.filter(
    (task2) => task2.config.localAdminEnabled && task2.secrets.localAdminApiKey
  );
  const task = candidates.find((item) => item.enabled) ?? candidates[0];
  if (!task) {
    throw new Error(
      "未找到可用的本机 Admin 配置，请先在任务管理里开启「同步到本机 Admin」并填写 Admin API Key"
    );
  }
  return {
    baseUrl: task.config.localAdminBaseUrl,
    adminApiKey: task.secrets.localAdminApiKey,
    timeoutSeconds: task.config.requestTimeoutSeconds,
    autoDeleteExhausted: task.config.autoDeleteExhausted
  };
}
function registerKskAutomationIpcHandlers(deps) {
  electron.ipcMain.handle(
    KSK_AUTOMATION_CHANNEL.list,
    async () => {
      try {
        return { success: true, data: await listTaskViews(deps.getManager()) };
      } catch (error) {
        return toError$3(error);
      }
    }
  );
  electron.ipcMain.handle(
    KSK_AUTOMATION_CHANNEL.create,
    async (_event, input) => {
      try {
        if (!isKskAutomationStoreAvailable()) throw new Error("系统加密存储不可用");
        const task = {
          id: node_crypto.randomUUID(),
          name: input.name.trim(),
          type: "ksk_pull",
          enabled: input.enabled !== false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          config: normalizeKskAutomationConfig(input.config),
          secrets: mergedSecrets(
            { providerUrl: "", smtpPassword: "", localAdminApiKey: "" },
            input.secrets
          )
        };
        await validateEnabledTask(task);
        await createKskAutomationTask(task.id, input);
        await deps.getManager().reloadTask(task.id);
        return { success: true, data: await listTaskViews(deps.getManager()) };
      } catch (error) {
        return toError$3(error);
      }
    }
  );
  electron.ipcMain.handle(
    KSK_AUTOMATION_CHANNEL.update,
    async (_event, taskId, input) => {
      try {
        const current = await loadKskAutomationTask(taskId);
        if (!current) throw new Error("任务不存在或已删除");
        const candidate = {
          ...current,
          name: input.name.trim(),
          enabled: input.enabled ?? current.enabled,
          config: normalizeKskAutomationConfig({ ...current.config, ...input.config }),
          secrets: mergedSecrets(current.secrets, input.secrets),
          updatedAt: Date.now()
        };
        await validateEnabledTask(candidate);
        await updateKskAutomationTask(taskId, input);
        await deps.getManager().reloadTask(taskId);
        return { success: true, data: await listTaskViews(deps.getManager()) };
      } catch (error) {
        return toError$3(error);
      }
    }
  );
  electron.ipcMain.handle(
    KSK_AUTOMATION_CHANNEL.setEnabled,
    async (_event, taskId, enabled) => {
      try {
        const current = await loadKskAutomationTask(taskId);
        if (!current) throw new Error("任务不存在或已删除");
        await validateEnabledTask({ ...current, enabled });
        await setKskAutomationTaskEnabled(taskId, enabled);
        await deps.getManager().reloadTask(taskId);
        return { success: true, data: await listTaskViews(deps.getManager()) };
      } catch (error) {
        return toError$3(error);
      }
    }
  );
  electron.ipcMain.handle(
    KSK_AUTOMATION_CHANNEL.delete,
    async (_event, taskId) => {
      try {
        await deleteKskAutomationTask(taskId);
        deps.getManager().removeTask(taskId);
        return { success: true, data: await listTaskViews(deps.getManager()) };
      } catch (error) {
        return toError$3(error);
      }
    }
  );
  electron.ipcMain.handle(
    KSK_AUTOMATION_CHANNEL.syncNow,
    async (_event, taskId) => {
      try {
        return {
          success: true,
          data: { taskId, status: await deps.getManager().runNow(taskId) }
        };
      } catch (error) {
        return toError$3(error);
      }
    }
  );
  electron.ipcMain.handle(
    KSK_AUTOMATION_CHANNEL.syncLocalAdminNow,
    async (_event, taskId) => {
      try {
        return {
          success: true,
          data: { taskId, status: await deps.getManager().syncLocalAdminNow(taskId) }
        };
      } catch (error) {
        return toError$3(error);
      }
    }
  );
  electron.ipcMain.handle(
    KSK_AUTOMATION_CHANNEL.cleanupNow,
    async (_event, taskId) => {
      try {
        return {
          success: true,
          data: { taskId, status: await deps.getManager().cleanupNow(taskId) }
        };
      } catch (error) {
        return toError$3(error);
      }
    }
  );
  electron.ipcMain.handle(
    KSK_AUTOMATION_CHANNEL.pushAccountToLocalAdmin,
    async (_event, candidate) => {
      const who = describePushCandidate(candidate);
      logLocalAdminPush(`开始推送账号到本机 Admin：${who}`);
      try {
        const target = await resolveLocalAdminTarget();
        const result = await pushAccountToLocalAdmin({
          candidate,
          baseUrl: target.baseUrl,
          adminApiKey: target.adminApiKey,
          timeoutSeconds: target.timeoutSeconds,
          fetchImpl: deps.localAdminFetchImpl,
          probeLiveness: deps.probeLocalAdminPushLiveness
        });
        logLocalAdminPush(
          result.status === "existing" ? `Admin 已有同一凭据，未新建（#${result.credentialId ?? "未知"}）：${who}` : `推送完成并保留凭据（#${result.credentialId ?? "未知"}，验活=${result.probeVerdict}）：${who}`
        );
        return { success: true, data: result };
      } catch (error) {
        const failure = toError$3(error);
        logLocalAdminPushError(`推送失败：${failure.error}（${who}）`);
        return failure;
      }
    }
  );
}
const LOCAL_ADMIN_STATS_POLL_INTERVAL_SECONDS = 60;
const LOCAL_ADMIN_USAGE_WARN_RATIO = 0.9;
const LOCAL_ADMIN_ALERT = {
  /** 凭据被 Admin 禁用 */
  DISABLED: "disabled",
  /** 调用失败计数大于 0 */
  FAILING: "failing",
  /** Token 刷新失败计数大于 0 */
  REFRESH_FAILING: "refresh_failing",
  /** 额度用量超过告警阈值 */
  QUOTA_HIGH: "quota_high",
  /** 额度已耗尽 */
  QUOTA_EXHAUSTED: "quota_exhausted"
};
const LOCAL_ADMIN_STATS_STATE = {
  /** 未配置本机 Admin，或配置不完整 */
  UNCONFIGURED: "unconfigured",
  /** 已配置但还没抓到过数据 */
  IDLE: "idle",
  /** 抓取中 */
  RUNNING: "running",
  /** 最近一次抓取成功 */
  HEALTHY: "healthy",
  /** 最近一次抓取失败 */
  FAILED: "failed"
};
const EMPTY_LOCAL_ADMIN_EXHAUSTED_CLEANUP = {
  checked: 0,
  exhausted: 0,
  removed: 0,
  removedLocalAccounts: 0,
  removedMaskedKeys: [],
  errors: []
};
function selectExhaustedLocalAdminCredentials(credentials) {
  return credentials.filter(
    (credential) => credential.alerts.includes(LOCAL_ADMIN_ALERT.QUOTA_EXHAUSTED)
  );
}
const EMPTY_LOCAL_ADMIN_STATS_TOTALS = {
  credentials: 0,
  available: 0,
  disabled: 0,
  successCount: 0,
  failureCount: 0,
  refreshFailureCount: 0,
  successRate: void 0,
  usageSampleCount: 0,
  usageCurrent: 0,
  usageLimit: 0,
  usageRemaining: 0,
  usagePercentUsed: void 0,
  inputTokens: 0,
  outputTokens: 0,
  usedCredits: 0,
  alertCount: 0
};
function aggregateLocalAdminStats(credentials) {
  const totals = { ...EMPTY_LOCAL_ADMIN_STATS_TOTALS };
  for (const credential of credentials) {
    totals.credentials++;
    if (credential.disabled) totals.disabled++;
    else totals.available++;
    totals.successCount += credential.successCount;
    totals.failureCount += credential.failureCount;
    totals.refreshFailureCount += credential.refreshFailureCount;
    totals.inputTokens += credential.inputTokens ?? 0;
    totals.outputTokens += credential.outputTokens ?? 0;
    totals.usedCredits += credential.usedCredits ?? 0;
    if (credential.alerts.length > 0) totals.alertCount++;
    if (credential.usage) {
      totals.usageSampleCount++;
      totals.usageCurrent += credential.usage.current;
      totals.usageLimit += credential.usage.limit;
      totals.usageRemaining += credential.usage.remaining;
    }
  }
  const attempts = totals.successCount + totals.failureCount;
  totals.successRate = attempts > 0 ? totals.successCount / attempts : void 0;
  totals.usagePercentUsed = totals.usageLimit > 0 ? totals.usageCurrent / totals.usageLimit : void 0;
  return totals;
}
function resolveLocalAdminAlerts(input) {
  const alerts = [];
  if (input.disabled) alerts.push(LOCAL_ADMIN_ALERT.DISABLED);
  if (input.failureCount > 0) alerts.push(LOCAL_ADMIN_ALERT.FAILING);
  if (input.refreshFailureCount > 0) alerts.push(LOCAL_ADMIN_ALERT.REFRESH_FAILING);
  if (input.usage && input.usage.limit > 0) {
    if (input.usage.remaining <= 0) alerts.push(LOCAL_ADMIN_ALERT.QUOTA_EXHAUSTED);
    else if (input.usage.percentUsed >= LOCAL_ADMIN_USAGE_WARN_RATIO) {
      alerts.push(LOCAL_ADMIN_ALERT.QUOTA_HIGH);
    }
  }
  return alerts;
}
const LOCAL_ADMIN_USAGE_BUCKET_RETENTION_HOURS = 168;
function diffLocalAdminCounter(previous, next) {
  if (previous === void 0 || !Number.isFinite(previous)) return 0;
  if (!Number.isFinite(next)) return 0;
  return next > previous ? next - previous : 0;
}
function toHourStart(at) {
  const date = new Date(at);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}
function accumulateHourlyUsage(input) {
  const hour = toHourStart(input.at);
  const cursorById = new Map(input.cursors.map((cursor) => [cursor.id, cursor]));
  const bucketByHour = new Map(input.buckets.map((bucket) => [bucket.hour, bucket]));
  const current = bucketByHour.get(hour) ?? { credentials: [] };
  const deltaById = new Map(current.credentials.map((item) => [item.id, { ...item }]));
  for (const credential of input.credentials) {
    const previousCursor = cursorById.get(credential.id);
    const rotated = previousCursor?.maskedKey !== void 0 && credential.maskedKey !== void 0 && previousCursor.maskedKey !== credential.maskedKey;
    const cursor = rotated ? void 0 : previousCursor;
    const usageCurrent = credential.usage?.current;
    const entry = deltaById.get(credential.id) ?? {
      id: credential.id,
      maskedKey: credential.maskedKey,
      email: credential.email,
      usageDelta: 0,
      inputTokenDelta: 0,
      outputTokenDelta: 0,
      creditDelta: 0,
      successDelta: 0,
      failureDelta: 0,
      refreshFailureDelta: 0,
      lastSeenAt: input.at
    };
    entry.maskedKey = credential.maskedKey ?? entry.maskedKey;
    entry.email = credential.email ?? entry.email;
    entry.successDelta += diffLocalAdminCounter(cursor?.successCount, credential.successCount);
    entry.failureDelta += diffLocalAdminCounter(cursor?.failureCount, credential.failureCount);
    entry.refreshFailureDelta += diffLocalAdminCounter(
      cursor?.refreshFailureCount,
      credential.refreshFailureCount
    );
    if (credential.inputTokens !== void 0) {
      entry.inputTokenDelta += diffLocalAdminCounter(cursor?.inputTokens, credential.inputTokens);
    }
    if (credential.outputTokens !== void 0) {
      entry.outputTokenDelta += diffLocalAdminCounter(cursor?.outputTokens, credential.outputTokens);
    }
    if (credential.usedCredits !== void 0) {
      entry.creditDelta += diffLocalAdminCounter(cursor?.usedCredits, credential.usedCredits);
    }
    if (usageCurrent !== void 0) {
      entry.usageDelta += diffLocalAdminCounter(cursor?.usageCurrent, usageCurrent);
      entry.usageCurrent = usageCurrent;
      entry.usageLimit = credential.usage?.limit;
    }
    entry.lastSeenAt = input.at;
    deltaById.set(credential.id, entry);
    cursorById.set(credential.id, {
      id: credential.id,
      successCount: credential.successCount,
      failureCount: credential.failureCount,
      refreshFailureCount: credential.refreshFailureCount,
      // 这一轮没查到用量时保留旧基线，否则下一轮会把整段累计当成新增消耗
      usageCurrent: usageCurrent ?? cursor?.usageCurrent,
      // token 同理：kiro-rs 重启后计数从 0 起，靠 diff 的回落保护记 0
      inputTokens: credential.inputTokens ?? cursor?.inputTokens,
      outputTokens: credential.outputTokens ?? cursor?.outputTokens,
      usedCredits: credential.usedCredits ?? cursor?.usedCredits,
      at: input.at,
      // 换号后基线要跟着换到新号，否则下一轮又会拿旧 key 判定一次复用
      maskedKey: credential.maskedKey ?? cursor?.maskedKey
    });
  }
  bucketByHour.set(hour, { hour, credentials: [...deltaById.values()] });
  const retentionHours = input.retentionHours ?? LOCAL_ADMIN_USAGE_BUCKET_RETENTION_HOURS;
  const earliest = hour - (retentionHours - 1) * 36e5;
  const buckets = [...bucketByHour.values()].filter((bucket) => bucket.hour >= earliest).sort((a, b) => a.hour - b.hour);
  const aliveIds = new Set(buckets.flatMap((bucket) => bucket.credentials.map((item) => item.id)));
  const cursors = [...cursorById.values()].filter(
    (cursor) => aliveIds.has(cursor.id) || cursor.at >= earliest
  );
  return { buckets, cursors };
}
const STORE_FILE$4 = "local-admin-stats-samples.json";
let mutationQueue$4 = Promise.resolve();
function storePath$1() {
  return node_path.join(electron.app.getPath("userData"), STORE_FILE$4);
}
async function writeState(state) {
  const path2 = storePath$1();
  await node_fs.promises.mkdir(node_path.dirname(path2), { recursive: true });
  const payload = {
    version: 2,
    samples: state.samples,
    buckets: state.buckets,
    cursors: state.cursors
  };
  await node_fs.promises.writeFile(path2, JSON.stringify(payload), { mode: 384 });
}
function readCount$3(value) {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? Math.floor(numberValue) : 0;
}
function readOptionalNumber$2(value) {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : void 0;
}
function normalizeSample(value) {
  if (!value || typeof value !== "object") return null;
  const source = value;
  const at = readOptionalNumber$2(source.at);
  if (at === void 0 || at <= 0) return null;
  return {
    at: Math.floor(at),
    successCount: readCount$3(source.successCount),
    failureCount: readCount$3(source.failureCount),
    refreshFailureCount: readCount$3(source.refreshFailureCount),
    credentials: readCount$3(source.credentials),
    available: readCount$3(source.available),
    usageCurrent: readOptionalNumber$2(source.usageCurrent),
    usageLimit: readOptionalNumber$2(source.usageLimit),
    inputTokens: readOptionalNumber$2(source.inputTokens),
    outputTokens: readOptionalNumber$2(source.outputTokens)
  };
}
function readOptionalString$3(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function readRawArray(payload, key) {
  if (!payload || typeof payload !== "object") return [];
  const value = payload[key];
  return Array.isArray(value) ? value : [];
}
function readDelta(value) {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : 0;
}
function normalizeDelta(value) {
  if (!value || typeof value !== "object") return null;
  const source = value;
  const id = readOptionalString$3(source.id);
  if (!id) return null;
  return {
    id,
    maskedKey: readOptionalString$3(source.maskedKey),
    // 升级前落的桶没有 email，读出来是 undefined，报表回落到显示 #id
    email: readOptionalString$3(source.email),
    usageDelta: readDelta(source.usageDelta),
    // 升级前落的桶没有这几个键，按 0 读入
    inputTokenDelta: readDelta(source.inputTokenDelta),
    outputTokenDelta: readDelta(source.outputTokenDelta),
    creditDelta: readDelta(source.creditDelta),
    successDelta: readDelta(source.successDelta),
    failureDelta: readDelta(source.failureDelta),
    refreshFailureDelta: readDelta(source.refreshFailureDelta),
    usageCurrent: readOptionalNumber$2(source.usageCurrent),
    usageLimit: readOptionalNumber$2(source.usageLimit),
    lastSeenAt: readCount$3(source.lastSeenAt)
  };
}
function normalizeBucketsPayload(payload, now = Date.now()) {
  const source = readRawArray(payload, "buckets");
  const earliest = new Date(now).setMinutes(0, 0, 0) - (LOCAL_ADMIN_USAGE_BUCKET_RETENTION_HOURS - 1) * 36e5;
  return source.map((item) => {
    if (!item || typeof item !== "object") return null;
    const record = item;
    const hour = readOptionalNumber$2(record.hour);
    if (hour === void 0 || hour <= 0) return null;
    const credentials = Array.isArray(record.credentials) ? record.credentials.map(normalizeDelta).filter((entry) => entry !== null) : [];
    return { hour: Math.floor(hour), credentials };
  }).filter((item) => item !== null && item.hour >= earliest).sort((a, b) => a.hour - b.hour);
}
function normalizeCursorsPayload(payload) {
  return readRawArray(payload, "cursors").map((item) => {
    if (!item || typeof item !== "object") return null;
    const record = item;
    const id = readOptionalString$3(record.id);
    if (!id) return null;
    return {
      id,
      successCount: readCount$3(record.successCount),
      failureCount: readCount$3(record.failureCount),
      refreshFailureCount: readCount$3(record.refreshFailureCount),
      usageCurrent: readOptionalNumber$2(record.usageCurrent),
      inputTokens: readOptionalNumber$2(record.inputTokens),
      outputTokens: readOptionalNumber$2(record.outputTokens),
      usedCredits: readOptionalNumber$2(record.usedCredits),
      at: readCount$3(record.at)
    };
  }).filter((item) => item !== null);
}
function normalizeSamplesPayload(payload) {
  const source = payload && typeof payload === "object" ? payload.samples : void 0;
  if (!Array.isArray(source)) return [];
  return source.map(normalizeSample).filter((item) => item !== null).sort((a, b) => a.at - b.at).slice(-1440);
}
async function loadLocalAdminStatsState() {
  try {
    const raw = await node_fs.promises.readFile(storePath$1(), "utf-8");
    const parsed = JSON.parse(raw);
    return {
      samples: normalizeSamplesPayload(parsed),
      buckets: normalizeBucketsPayload(parsed),
      cursors: normalizeCursorsPayload(parsed)
    };
  } catch {
    return { samples: [], buckets: [], cursors: [] };
  }
}
function enqueue$2(task) {
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  mutationQueue$4 = mutationQueue$4.then(async () => {
    resolveResult(await task());
  }).catch((error) => {
    rejectResult(error);
  });
  return result;
}
async function appendLocalAdminStatsSample(input) {
  return enqueue$2(async () => {
    const state = await loadLocalAdminStatsState();
    const samples = [...state.samples, input.sample].slice(-1440);
    const next = {
      samples,
      buckets: input.buckets,
      cursors: input.cursors
    };
    await writeState(next);
    return next;
  });
}
async function clearLocalAdminStatsSamples() {
  return enqueue$2(async () => {
    const state = await loadLocalAdminStatsState();
    await writeState({ samples: [], buckets: state.buckets, cursors: state.cursors });
  });
}
async function clearLocalAdminUsageBuckets() {
  return enqueue$2(async () => {
    const state = await loadLocalAdminStatsState();
    await writeState({ samples: state.samples, buckets: [], cursors: [] });
  });
}
const USAGE_REQUEST_GAP_MS = 120;
function readCount$2(value) {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? Math.floor(numberValue) : 0;
}
function readOptionalString$2(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function readOptionalCount(value) {
  if (value === void 0 || value === null) return void 0;
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) return void 0;
  return Math.floor(numberValue);
}
function readOptionalDecimal(value) {
  if (value === void 0 || value === null) return void 0;
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) return void 0;
  return numberValue;
}
function readTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1e3) : Math.round(value);
  }
  if (typeof value !== "string" || !value.trim()) return void 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : void 0;
}
function readNumber$2(value) {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : void 0;
}
function toCredentialStats(credential, usage) {
  const id = remoteCredentialId(credential);
  if (!id) return null;
  const disabled = credential.disabled === true;
  const failureCount = readCount$2(credential.failureCount);
  const refreshFailureCount = readCount$2(credential.refreshFailureCount);
  return {
    id,
    maskedKey: readOptionalString$2(credential.maskedApiKey),
    authMethod: readOptionalString$2(credential.authMethod),
    endpoint: readOptionalString$2(credential.endpoint),
    email: readOptionalString$2(credential.email),
    subscriptionTitle: readOptionalString$2(credential.subscriptionTitle) ?? usage?.subscriptionTitle,
    priority: readCount$2(credential.priority),
    disabled,
    isCurrent: credential.isCurrent === true,
    successCount: readCount$2(credential.successCount),
    failureCount,
    refreshFailureCount,
    // 旧版 kiro-rs 不返回这两个字段，保持 undefined 以区分「不支持」与「真的是 0」
    inputTokens: readOptionalCount(credential.inputTokens),
    outputTokens: readOptionalCount(credential.outputTokens),
    // 积分是小数，不能走取整那条
    usedCredits: readOptionalDecimal(credential.usedCredits),
    lastUsedAt: readTimestamp(credential.lastUsedAt),
    usage,
    alerts: resolveLocalAdminAlerts({ disabled, failureCount, refreshFailureCount, usage })
  };
}
function toCredentialUsage(payload, fetchedAt) {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload;
  const limit = readNumber$2(record.usageLimit);
  const current = readNumber$2(record.currentUsage);
  if (limit === void 0 || current === void 0) return null;
  const remaining = readNumber$2(record.remaining) ?? Math.max(0, limit - current);
  return {
    current,
    limit,
    remaining,
    percentUsed: limit > 0 ? current / limit : 0,
    subscriptionTitle: readOptionalString$2(record.subscriptionTitle),
    nextResetAt: readTimestamp(record.nextResetAt),
    fetchedAt
  };
}
async function fetchLocalAdminCredentialStats(target, previousUsage) {
  const baseUrl = resolveLocalAdminApiBase(target.baseUrl);
  const adminApiKey = target.adminApiKey.trim();
  if (!adminApiKey) throw new Error("未配置本机 Admin API Key");
  const payload = await requestJson(
    target.fetchImpl,
    `${baseUrl}/credentials`,
    adminApiKey,
    Math.max(3, target.timeoutSeconds) * 1e3,
    { method: "GET" }
  );
  return readRemoteCredentials(payload).map((credential) => {
    const id = remoteCredentialId(credential);
    return toCredentialStats(credential, id ? previousUsage?.get(id) : void 0);
  }).filter((item) => item !== null);
}
async function fetchLocalAdminUsage(target, credentialIds, onProgress) {
  const baseUrl = resolveLocalAdminApiBase(target.baseUrl);
  const adminApiKey = target.adminApiKey.trim();
  if (!adminApiKey) throw new Error("未配置本机 Admin API Key");
  const timeoutMs = Math.max(3, target.timeoutSeconds) * 1e3;
  const usage = /* @__PURE__ */ new Map();
  const errors = [];
  for (let index = 0; index < credentialIds.length; index++) {
    const credentialId = credentialIds[index];
    try {
      const payload = await requestJson(
        target.fetchImpl,
        `${baseUrl}/credentials/${encodeURIComponent(credentialId)}/balance`,
        adminApiKey,
        timeoutMs,
        { method: "GET" }
      );
      const parsed = toCredentialUsage(payload, Date.now());
      if (parsed) usage.set(credentialId, parsed);
      else errors.push(`#${credentialId}: 余额响应缺少用量字段`);
    } catch (error) {
      errors.push(`#${credentialId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (index < credentialIds.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, USAGE_REQUEST_GAP_MS));
    }
  }
  return { usage, errors };
}
const UNCONFIGURED_RECHECK_INTERVAL_MS = 6e4;
class LocalAdminStatsManager {
  constructor(deps) {
    this.deps = deps;
  }
  timer = null;
  stopped = true;
  roundPromise = null;
  usagePromise = null;
  cleanupPromise = null;
  lastCleanup = EMPTY_LOCAL_ADMIN_EXHAUSTED_CLEANUP;
  credentials = [];
  samples = [];
  buckets = [];
  cursors = [];
  usageCache = /* @__PURE__ */ new Map();
  status = {
    state: LOCAL_ADMIN_STATS_STATE.UNCONFIGURED,
    lastUsageErrorCount: 0
  };
  snapshot() {
    return {
      status: { ...this.status },
      totals: aggregateLocalAdminStats(this.credentials),
      credentials: this.credentials.map((item) => ({ ...item, alerts: [...item.alerts] })),
      samples: [...this.samples],
      buckets: this.buckets.map((bucket) => ({
        hour: bucket.hour,
        credentials: bucket.credentials.map((item) => ({ ...item }))
      }))
    };
  }
  async start() {
    this.stop();
    this.stopped = false;
    const state = await loadLocalAdminStatsState();
    this.samples = state.samples;
    this.buckets = state.buckets;
    this.cursors = state.cursors;
    this.scheduleNext(0);
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  /** 立刻抓一轮计数类统计，供页面下拉刷新与打开页面时调用。 */
  async refreshNow() {
    this.stopped = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.runRound();
    return this.snapshot();
  }
  /**
   * 手动刷新用量：逐条查余额。并发调用合并到同一次执行，
   * 避免用户连点两下按钮就把上游请求数翻倍。
   */
  async refreshUsageNow() {
    if (this.usagePromise) return this.usagePromise;
    this.usagePromise = this.executeUsageRefresh().finally(() => {
      this.usagePromise = null;
    });
    return this.usagePromise;
  }
  /**
   * 手动清理额度耗尽的凭据。
   *
   * 先拉一轮用量再判：页面上的用量可能是几分钟前采的，那之后可能已经重置了。
   * balance 有约 300 秒本地缓存，多这一次请求基本不打上游。
   */
  async cleanupExhaustedNow() {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = this.executeManualCleanup().finally(() => {
      this.cleanupPromise = null;
    });
    return this.cleanupPromise;
  }
  async executeManualCleanup() {
    if (!this.deps.cleanupExhausted) throw new Error("当前构建未接入凭据清理能力");
    await this.refreshUsageNow();
    const summary = await this.runExhaustedCleanup(this.credentials);
    return summary ? this.lastCleanup : EMPTY_LOCAL_ADMIN_EXHAUSTED_CLEANUP;
  }
  /**
   * 跑一次额度耗尽清理，返回删除后重新抓到的凭据列表（没删任何东西时返回 undefined）。
   *
   * 清理失败不能把整轮采集判成失败：统计本身已经拿到了，标个 lastError 让用户看见即可。
   */
  async runExhaustedCleanup(credentials) {
    if (!this.deps.cleanupExhausted) return void 0;
    if (selectExhaustedLocalAdminCredentials(credentials).length === 0) return void 0;
    try {
      const summary = await this.deps.cleanupExhausted(credentials);
      this.lastCleanup = summary;
      this.status = {
        ...this.status,
        lastCleanupAt: Date.now(),
        lastCleanupRemovedCount: summary.removed
      };
      if (summary.removed > 0) {
        this.log(
          `已清理 ${summary.removed} 个额度耗尽的凭据（本地账号 ${summary.removedLocalAccounts} 个）：` + summary.removedMaskedKeys.join("、")
        );
      }
      for (const issue of summary.errors) this.log(`清理额度耗尽凭据：${issue}`);
      if (summary.errors.length > 0) {
        this.status = { ...this.status, lastError: summary.errors.join("；") };
      }
      if (summary.removed === 0) return void 0;
      const target = await this.resolveTarget();
      if (!target) return void 0;
      return await fetchLocalAdminCredentialStats(target, this.usageCache);
    } catch (error) {
      this.status = { ...this.status, lastError: this.message(error) };
      this.log(`清理额度耗尽凭据失败: ${this.message(error)}`);
      return void 0;
    }
  }
  /** 清空本地趋势快照。上游没有历史，清掉就真没了，由调用方做二次确认。 */
  async clearSamples() {
    await clearLocalAdminStatsSamples();
    this.samples = [];
    this.pushSnapshot();
    return this.snapshot();
  }
  async resolveTarget() {
    const config = await this.deps.readTarget();
    if (!config?.adminApiKey.trim() || !config.baseUrl.trim()) return void 0;
    return { ...config, fetchImpl: this.deps.fetchImpl };
  }
  scheduleNext(delayMs) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runRound();
    }, delayMs);
  }
  runRound() {
    if (this.roundPromise) return this.roundPromise;
    this.roundPromise = this.executeRound().finally(() => {
      this.roundPromise = null;
    });
    return this.roundPromise;
  }
  async executeRound() {
    let target;
    try {
      target = await this.resolveTarget();
    } catch (error) {
      this.log(`读取本机 Admin 配置失败: ${this.message(error)}`);
    }
    if (!target) {
      this.credentials = [];
      this.status = {
        ...this.status,
        state: LOCAL_ADMIN_STATS_STATE.UNCONFIGURED,
        baseUrl: void 0,
        lastError: void 0
      };
      this.pushSnapshot();
      this.scheduleNext(UNCONFIGURED_RECHECK_INTERVAL_MS);
      return;
    }
    let displayBaseUrl;
    try {
      displayBaseUrl = resolveLocalAdminApiBase(target.baseUrl);
    } catch (error) {
      this.status = {
        ...this.status,
        state: LOCAL_ADMIN_STATS_STATE.UNCONFIGURED,
        baseUrl: void 0,
        lastError: this.message(error)
      };
      this.pushSnapshot();
      this.scheduleNext(UNCONFIGURED_RECHECK_INTERVAL_MS);
      return;
    }
    this.status = {
      ...this.status,
      state: LOCAL_ADMIN_STATS_STATE.RUNNING,
      baseUrl: displayBaseUrl,
      lastAttemptAt: Date.now()
    };
    this.pushSnapshot();
    try {
      let credentials = await fetchLocalAdminCredentialStats(target, this.usageCache);
      this.pruneUsageCache(credentials);
      try {
        const { usage, errors } = await fetchLocalAdminUsage(
          target,
          credentials.map((item) => item.id)
        );
        for (const [id, value] of usage) this.usageCache.set(id, value);
        if (usage.size > 0) {
          credentials = await fetchLocalAdminCredentialStats(target, this.usageCache);
        }
        if (errors.length > 0) {
          this.status = { ...this.status, lastUsageErrorCount: errors.length };
          this.log(`本轮有 ${errors.length} 条用量拉取失败: ${errors[0]}`);
        } else if (usage.size > 0) {
          this.status = { ...this.status, lastUsageRefreshAt: Date.now(), lastUsageErrorCount: 0 };
        }
      } catch (error) {
        this.log(`本轮用量采集失败（计数已正常入库）: ${this.message(error)}`);
      }
      this.credentials = credentials;
      await this.recordSample(credentials);
      this.status = {
        ...this.status,
        state: LOCAL_ADMIN_STATS_STATE.HEALTHY,
        lastSuccessAt: Date.now(),
        lastError: void 0
      };
      if (target.autoDeleteExhausted && this.deps.cleanupExhausted) {
        const remaining = await this.runExhaustedCleanup(credentials);
        if (remaining) {
          this.credentials = remaining;
          this.pruneUsageCache(remaining);
        }
      }
    } catch (error) {
      this.status = {
        ...this.status,
        state: LOCAL_ADMIN_STATS_STATE.FAILED,
        lastError: this.message(error)
      };
      this.log(`拉取反代统计失败: ${this.message(error)}`);
    }
    this.pushSnapshot();
    this.scheduleNext(LOCAL_ADMIN_STATS_POLL_INTERVAL_SECONDS * 1e3);
  }
  async executeUsageRefresh() {
    const target = await this.resolveTarget();
    if (!target) {
      throw new Error(
        "未找到可用的本机 Admin 配置，请先在任务管理里开启「同步到本机 Admin」并填写 Admin API Key"
      );
    }
    const credentials = await fetchLocalAdminCredentialStats(target, this.usageCache);
    this.credentials = credentials;
    this.pruneUsageCache(credentials);
    const { usage, errors } = await fetchLocalAdminUsage(
      target,
      credentials.map((item) => item.id)
    );
    for (const [id, value] of usage) this.usageCache.set(id, value);
    this.credentials = await fetchLocalAdminCredentialStats(target, this.usageCache);
    await this.recordSample(this.credentials);
    this.status = {
      ...this.status,
      state: LOCAL_ADMIN_STATS_STATE.HEALTHY,
      lastSuccessAt: Date.now(),
      lastError: void 0,
      lastUsageRefreshAt: Date.now(),
      lastUsageErrorCount: errors.length
    };
    this.pushSnapshot();
    return { refreshed: usage.size, failed: errors.length, errors };
  }
  /**
   * 追加一个趋势采样点。
   *
   * 落盘失败只记日志：趋势是可再生的观测数据，不该让它把已经抓到的
   * KPI 与凭据明细一起判成采集失败。内存里的 samples 仍然更新，
   * 这样即使磁盘不可写，本次会话的曲线照样能看。
   */
  async recordSample(credentials) {
    const at = Date.now();
    const sample = this.buildSample(credentials, at);
    const accumulated = accumulateHourlyUsage({
      buckets: this.buckets,
      cursors: this.cursors,
      credentials,
      at
    });
    this.buckets = accumulated.buckets;
    this.cursors = accumulated.cursors;
    try {
      const state = await appendLocalAdminStatsSample({
        sample,
        buckets: accumulated.buckets,
        cursors: accumulated.cursors
      });
      this.samples = state.samples;
      this.buckets = state.buckets;
      this.cursors = state.cursors;
    } catch (error) {
      this.samples = [...this.samples, sample].slice(-1440);
      this.log(`趋势采样落盘失败（已保留内存中的曲线）: ${this.message(error)}`);
    }
  }
  /** 清空消耗报表。与清趋势分开：两者粒度不同，用户可能只想清一个。 */
  async clearUsageBuckets() {
    await clearLocalAdminUsageBuckets();
    this.buckets = [];
    this.cursors = [];
    this.pushSnapshot();
    return this.snapshot();
  }
  /** Admin 里已删除的凭据，其用量缓存要一起丢，否则 id 复用时会串数据。 */
  pruneUsageCache(credentials) {
    const alive = new Set(credentials.map((item) => item.id));
    for (const id of [...this.usageCache.keys()]) {
      if (!alive.has(id)) this.usageCache.delete(id);
    }
  }
  buildSample(credentials, at) {
    const totals = aggregateLocalAdminStats(credentials);
    return {
      at,
      successCount: totals.successCount,
      failureCount: totals.failureCount,
      refreshFailureCount: totals.refreshFailureCount,
      credentials: totals.credentials,
      available: totals.available,
      // 没查过用量时不写 0，否则趋势图会出现一段假的「用量归零」
      usageCurrent: totals.usageSampleCount > 0 ? totals.usageCurrent : void 0,
      usageLimit: totals.usageSampleCount > 0 ? totals.usageLimit : void 0,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens
    };
  }
  pushSnapshot() {
    this.deps.notifySnapshot(this.snapshot());
  }
  message(error) {
    return error instanceof Error ? error.message : String(error);
  }
  log(message) {
    this.deps.log?.(`[LocalAdminStats] ${message}`);
  }
}
const LOCAL_ADMIN_STATS_CHANNEL = {
  snapshot: "local-admin-stats-snapshot",
  refreshNow: "local-admin-stats-refresh-now",
  refreshUsage: "local-admin-stats-refresh-usage",
  cleanupExhausted: "local-admin-stats-cleanup-exhausted",
  clearSamples: "local-admin-stats-clear-samples",
  clearBuckets: "local-admin-stats-clear-buckets",
  snapshotEvent: "local-admin-stats-changed"
};
function toError$2(error) {
  return { success: false, error: error instanceof Error ? error.message : String(error) };
}
function sendLocalAdminStatsSnapshot(getMainWindow, snapshot) {
  const win2 = getMainWindow();
  if (win2 && !win2.isDestroyed()) {
    win2.webContents.send(LOCAL_ADMIN_STATS_CHANNEL.snapshotEvent, snapshot);
  }
}
function registerLocalAdminStatsIpcHandlers(deps) {
  electron.ipcMain.handle(LOCAL_ADMIN_STATS_CHANNEL.snapshot, () => {
    try {
      return { success: true, data: deps.getManager().snapshot() };
    } catch (error) {
      return toError$2(error);
    }
  });
  electron.ipcMain.handle(
    LOCAL_ADMIN_STATS_CHANNEL.refreshNow,
    async () => {
      try {
        return { success: true, data: await deps.getManager().refreshNow() };
      } catch (error) {
        return toError$2(error);
      }
    }
  );
  electron.ipcMain.handle(
    LOCAL_ADMIN_STATS_CHANNEL.refreshUsage,
    async () => {
      try {
        return { success: true, data: await deps.getManager().refreshUsageNow() };
      } catch (error) {
        return toError$2(error);
      }
    }
  );
  electron.ipcMain.handle(
    LOCAL_ADMIN_STATS_CHANNEL.cleanupExhausted,
    async () => {
      try {
        return { success: true, data: await deps.getManager().cleanupExhaustedNow() };
      } catch (error) {
        return toError$2(error);
      }
    }
  );
  electron.ipcMain.handle(
    LOCAL_ADMIN_STATS_CHANNEL.clearSamples,
    async () => {
      try {
        return { success: true, data: await deps.getManager().clearSamples() };
      } catch (error) {
        return toError$2(error);
      }
    }
  );
  electron.ipcMain.handle(
    LOCAL_ADMIN_STATS_CHANNEL.clearBuckets,
    async () => {
      try {
        return { success: true, data: await deps.getManager().clearUsageBuckets() };
      } catch (error) {
        return toError$2(error);
      }
    }
  );
}
const KSK_HUNTER_POLL_INTERVAL_SECONDS = 3;
const KSK_HUNTER_REQUEST_TIMEOUT_SECONDS = 10;
const KSK_HUNTER_STORE_VERSION = 2;
const DEFAULT_KSK_HUNTER_DOWNSTREAM_URL = "http://127.0.0.1:12889";
const KSK_HUNTER_DOWNSTREAM_PATH = {
  /** GET → { need: boolean } */
  needAccount: "/need-account",
  /** POST { key, region } → { ok: boolean } */
  pushKsk: "/ksk"
};
const KSK_HUNTER_DOWNSTREAM_AUTH_HEADER = "x-api-key";
const KSK_HUNTER_DELIVERY_MAX_ATTEMPTS = 6;
const KSK_HUNTER_DELIVERY_BASE_DELAY_MS = 5e3;
const KSK_HUNTER_MODE = {
  /** 只弹系统通知提醒人工购买。 */
  NOTIFY: "notify",
  /** 问下游要不要号 → 下单 → 验活 → 推送下游。 */
  AUTO_ORDER: "auto_order"
};
const KSK_HUNTER_CHANNEL = {
  KIRO_MARKET: "kiro_market",
  KIRO_CEO: "kiro_ceo",
  KIRO_DROP: "kiro_drop",
  KIRO_APP: "kiro_app"
};
const KSK_HUNTER_CHANNEL_LABEL = {
  [KSK_HUNTER_CHANNEL.KIRO_MARKET]: "Kiro Market",
  [KSK_HUNTER_CHANNEL.KIRO_CEO]: "Kiro CEO",
  [KSK_HUNTER_CHANNEL.KIRO_DROP]: "Kiro Drop",
  [KSK_HUNTER_CHANNEL.KIRO_APP]: "KiroApp"
};
const KSK_HUNTER_CHANNEL_MIN_INTERVAL_SECONDS = {
  [KSK_HUNTER_CHANNEL.KIRO_MARKET]: KSK_HUNTER_POLL_INTERVAL_SECONDS,
  [KSK_HUNTER_CHANNEL.KIRO_CEO]: 30,
  [KSK_HUNTER_CHANNEL.KIRO_DROP]: KSK_HUNTER_POLL_INTERVAL_SECONDS,
  [KSK_HUNTER_CHANNEL.KIRO_APP]: KSK_HUNTER_POLL_INTERVAL_SECONDS
};
const KSK_HUNTER_CHANNEL_REQUIRES_API_KEY = {
  [KSK_HUNTER_CHANNEL.KIRO_MARKET]: false,
  [KSK_HUNTER_CHANNEL.KIRO_CEO]: true,
  [KSK_HUNTER_CHANNEL.KIRO_DROP]: false,
  [KSK_HUNTER_CHANNEL.KIRO_APP]: false
};
const KSK_HUNTER_CHANNEL_AUTH_HEADER = "X-API-Key";
const KSK_HUNTER_MAX_CNY_PER_UNIT = 1e4;
const DEFAULT_KSK_HUNTER_CHANNEL_BILLING = {
  unitLabel: "CNY",
  cnyPerUnit: 1,
  dailyLimitUnit: 0,
  lowBalanceThresholdUnit: 0
};
const DEFAULT_KSK_HUNTER_BILLING = {
  [KSK_HUNTER_CHANNEL.KIRO_MARKET]: {
    unitLabel: "CNY",
    cnyPerUnit: 1,
    dailyLimitUnit: 0,
    lowBalanceThresholdUnit: 0
  },
  // Kiro CEO 按积分计价，实测 /api/public/config：美区 50、欧区 35 积分/个
  [KSK_HUNTER_CHANNEL.KIRO_CEO]: {
    unitLabel: "积分",
    cnyPerUnit: 1,
    dailyLimitUnit: 0,
    lowBalanceThresholdUnit: 0
  },
  [KSK_HUNTER_CHANNEL.KIRO_DROP]: {
    unitLabel: "CNY",
    cnyPerUnit: 1,
    dailyLimitUnit: 0,
    lowBalanceThresholdUnit: 0
  },
  // KiroApp 的 /api/status 直接给 price/price_eu/price_us，实测是人民币整数（30 / 50）
  [KSK_HUNTER_CHANNEL.KIRO_APP]: {
    unitLabel: "CNY",
    cnyPerUnit: 1,
    dailyLimitUnit: 0,
    lowBalanceThresholdUnit: 0
  }
};
const KSK_HUNTER_BUDGET_BLOCK = {
  NONE: "none",
  /** 全局每日上限已用尽。 */
  GLOBAL: "global",
  /** 该渠道每日上限已用尽。 */
  CHANNEL: "channel",
  /** 余额不足以支付这一单。 */
  BALANCE: "balance",
  /** 商品没有价格，且用户要求未知价格不下单。 */
  UNKNOWN_PRICE: "unknown_price"
};
const KSK_HUNTER_STATE = {
  IDLE: "idle",
  RUNNING: "running",
  HEALTHY: "healthy",
  DEGRADED: "degraded"
};
const KSK_HUNTER_DELIVERY_STATE = {
  /** 等待推送或等待下一次重试。 */
  PENDING: "pending",
  /** 下游已确认接收。 */
  DELIVERED: "delivered",
  /** 重试次数耗尽，需要人工处理。 */
  FAILED: "failed",
  /** 号已买到但验活不通过，不推给下游。 */
  DEAD_KEY: "dead_key"
};
const DEFAULT_KSK_HUNTER_CONFIG = {
  downstreamBaseUrl: DEFAULT_KSK_HUNTER_DOWNSTREAM_URL,
  billing: DEFAULT_KSK_HUNTER_BILLING
};
function matchesHunterRegions(regions, region) {
  if (regions.length === 0) return true;
  return regions.includes(region);
}
function isUsableHunterCredential(credential) {
  return isValidKiroApiKey(credential.key) && isValidKiroRegion(credential.region);
}
function hunterRetryDelayMs(attempt) {
  const exponent = Math.max(0, attempt - 1);
  return KSK_HUNTER_DELIVERY_BASE_DELAY_MS * 2 ** exponent;
}
function hunterUrlHint(value) {
  const trimmed = value.trim();
  if (!trimmed) return void 0;
  try {
    const parsed = new URL(trimmed);
    const token = parsed.searchParams.get("token") || parsed.searchParams.get("key") || "";
    const tokenHint = token ? ` · token ••••${token.slice(-4)}` : "";
    return `${parsed.origin}${parsed.pathname}${tokenHint}`;
  } catch {
    return "已配置（地址格式待校验）";
  }
}
function maskHunterSecretTail(value, visible = 4) {
  const trimmed = value.trim();
  if (!trimmed) return void 0;
  return `••••${trimmed.slice(-visible)}`;
}
function hunterLocalDateKey(at = Date.now()) {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}
function roundCny(value) {
  return Math.round(value * 100) / 100;
}
function hunterUnitToCny(amountUnit, cnyPerUnit) {
  if (!Number.isFinite(amountUnit) || amountUnit < 0) return 0;
  if (!Number.isFinite(cnyPerUnit) || cnyPerUnit <= 0) return 0;
  return roundCny(amountUnit * cnyPerUnit);
}
function summarizeHunterSpend(entries, config, date = hunterLocalDateKey()) {
  const today = entries.filter((entry) => hunterLocalDateKey(entry.at) === date);
  const byChannel = Object.values(KSK_HUNTER_CHANNEL).map((channel) => {
    const billing = config.billing[channel] ?? DEFAULT_KSK_HUNTER_CHANNEL_BILLING;
    const channelEntries = today.filter((entry) => entry.channel === channel);
    const amountUnit = roundCny(channelEntries.reduce((sum, entry) => sum + entry.amountUnit, 0));
    return {
      channel,
      amountUnit,
      unitLabel: billing.unitLabel,
      amountCny: roundCny(channelEntries.reduce((sum, entry) => sum + entry.amountCny, 0)),
      orderCount: channelEntries.length,
      dailyLimitUnit: billing.dailyLimitUnit,
      remainingUnit: billing.dailyLimitUnit > 0 ? roundCny(Math.max(0, billing.dailyLimitUnit - amountUnit)) : void 0
    };
  });
  const totalCny = roundCny(today.reduce((sum, entry) => sum + entry.amountCny, 0));
  return {
    date,
    totalCny,
    orderCount: today.length,
    dailyLimitCny: config.dailyLimitCny,
    remainingCny: config.dailyLimitCny > 0 ? roundCny(Math.max(0, config.dailyLimitCny - totalCny)) : void 0,
    byChannel
  };
}
function evaluateHunterBudget(input) {
  const billing = input.config.billing[input.channel] ?? DEFAULT_KSK_HUNTER_CHANNEL_BILLING;
  if (input.priceUnit === void 0 || !Number.isFinite(input.priceUnit)) {
    return input.config.allowUnknownPriceOrder ? { allowed: true, reason: KSK_HUNTER_BUDGET_BLOCK.NONE, costCny: 0, costUnit: void 0 } : {
      allowed: false,
      reason: KSK_HUNTER_BUDGET_BLOCK.UNKNOWN_PRICE,
      costCny: 0,
      costUnit: void 0
    };
  }
  const costUnit = input.priceUnit;
  const costCny = hunterUnitToCny(costUnit, billing.cnyPerUnit);
  const blocked = (reason) => ({
    allowed: false,
    reason,
    costCny,
    costUnit
  });
  const globalLimit = input.config.dailyLimitCny;
  if (globalLimit > 0 && roundCny(input.spend.totalCny + costCny) > globalLimit) {
    return blocked(KSK_HUNTER_BUDGET_BLOCK.GLOBAL);
  }
  const channelLimit = billing.dailyLimitUnit;
  if (channelLimit > 0) {
    const channelSpentUnit = input.spend.byChannel.find((item) => item.channel === input.channel)?.amountUnit ?? 0;
    if (roundCny(channelSpentUnit + costUnit) > channelLimit) {
      return blocked(KSK_HUNTER_BUDGET_BLOCK.CHANNEL);
    }
  }
  if (input.balanceUnit !== void 0 && input.balanceUnit < costUnit) {
    return blocked(KSK_HUNTER_BUDGET_BLOCK.BALANCE);
  }
  return { allowed: true, reason: KSK_HUNTER_BUDGET_BLOCK.NONE, costCny, costUnit };
}
function exhaustedHunterChannels(spend) {
  return spend.byChannel.filter((item) => item.dailyLimitUnit > 0 && item.amountUnit >= item.dailyLimitUnit).map((item) => item.channel);
}
const BALANCE_FIELD_NAMES = [
  "balance",
  "points",
  "point",
  "credit",
  "credits",
  "remain",
  "remaining",
  "amount",
  "available"
];
function parseHunterBalance(payload, depth = 0) {
  if (depth > 6) return void 0;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = parseHunterBalance(item, depth + 1);
      if (found !== void 0) return found;
    }
    return void 0;
  }
  if (typeof payload !== "object" || payload === null) return void 0;
  const record = payload;
  for (const field of BALANCE_FIELD_NAMES) {
    const value = record[field];
    const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
    if (Number.isFinite(numberValue)) return numberValue;
  }
  for (const value of Object.values(record)) {
    if (typeof value !== "object" || value === null) continue;
    const found = parseHunterBalance(value, depth + 1);
    if (found !== void 0) return found;
  }
  return void 0;
}
const HUNTER_REPORT_WINDOW_DAYS = 30;
const HUNTER_REPORT_EVENT = {
  /** 链接由无货变有货的那一刻（放货时刻），不是每轮有货都记。 */
  RESTOCK: "restock",
  /** 下单成功，钱已花出去。 */
  ORDERED: "ordered",
  /** 已购但验活不通过，钱花了号不能用。 */
  DEAD_KEY: "dead_key",
  /** 推送下游成功。 */
  DELIVERED: "delivered",
  /** 推送重试耗尽，需人工处理。 */
  DELIVERY_FAILED: "delivery_failed",
  /** 预算或余额拦下了一次自动下单。按「日期 + 渠道 + 原因」去重后才记。 */
  BLOCKED: "blocked"
};
function emptyCounts() {
  return { restocks: 0, orders: 0, delivered: 0, deliveryFailed: 0, deadKeys: 0, blocks: 0 };
}
function countEvent(counts, type) {
  switch (type) {
    case HUNTER_REPORT_EVENT.RESTOCK:
      counts.restocks++;
      break;
    case HUNTER_REPORT_EVENT.ORDERED:
      counts.orders++;
      break;
    case HUNTER_REPORT_EVENT.DELIVERED:
      counts.delivered++;
      break;
    case HUNTER_REPORT_EVENT.DELIVERY_FAILED:
      counts.deliveryFailed++;
      break;
    case HUNTER_REPORT_EVENT.DEAD_KEY:
      counts.deadKeys++;
      break;
    case HUNTER_REPORT_EVENT.BLOCKED:
      counts.blocks++;
      break;
  }
}
function hunterReportDayStart(at) {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}
function hunterReportDateRange(days, now) {
  const span = Math.max(1, Math.floor(days));
  const todayStart = hunterReportDayStart(now);
  const result = [];
  for (let offset = span - 1; offset >= 0; offset--) {
    const date = new Date(todayStart);
    date.setDate(date.getDate() - offset);
    const at = date.getTime();
    result.push({ date: hunterLocalDateKey(at), at });
  }
  return result;
}
function summarizeHunterReport(input) {
  const now = input.now ?? Date.now();
  const days = Math.max(1, Math.floor(input.days ?? HUNTER_REPORT_WINDOW_DAYS));
  const dateRange = hunterReportDateRange(days, now);
  const fromAt = dateRange[0].at;
  const windowed = input.events.filter((event) => event.at >= fromAt);
  const dayByDate = /* @__PURE__ */ new Map();
  for (const entry of dateRange) {
    dayByDate.set(entry.date, { ...emptyCounts(), date: entry.date, at: entry.at, spendCny: 0 });
  }
  const totals = { ...emptyCounts(), spendCny: 0, activeDays: 0 };
  const restockByHour = Array.from({ length: 24 }, () => 0);
  const channelRows = /* @__PURE__ */ new Map();
  const linkRows = /* @__PURE__ */ new Map();
  let pricedOrders = 0;
  let pricedCostCny = 0;
  const pricedByChannel = /* @__PURE__ */ new Map();
  const channelRow = (event) => {
    let row = channelRows.get(event.channel);
    if (!row) {
      row = {
        ...emptyCounts(),
        channel: event.channel,
        unitLabel: input.billing?.[event.channel]?.unitLabel ?? DEFAULT_KSK_HUNTER_CHANNEL_BILLING.unitLabel,
        spendUnit: 0,
        spendCny: 0
      };
      channelRows.set(event.channel, row);
    }
    return row;
  };
  const linkRow = (event) => {
    let row = linkRows.get(event.linkId);
    if (!row) {
      row = {
        ...emptyCounts(),
        linkId: event.linkId,
        linkName: event.linkName,
        channel: event.channel,
        unitLabel: channelRow(event).unitLabel,
        spendUnit: 0,
        spendCny: 0
      };
      linkRows.set(event.linkId, row);
    }
    row.linkName = event.linkName;
    return row;
  };
  for (const event of windowed) {
    const day = dayByDate.get(hunterLocalDateKey(event.at));
    const channel = channelRow(event);
    const link = linkRow(event);
    countEvent(totals, event.type);
    countEvent(channel, event.type);
    countEvent(link, event.type);
    if (day) countEvent(day, event.type);
    if (event.unitLabel) {
      channel.unitLabel = event.unitLabel;
      link.unitLabel = event.unitLabel;
    }
    if (event.type === HUNTER_REPORT_EVENT.RESTOCK) {
      restockByHour[new Date(event.at).getHours()]++;
    }
    if (event.type !== HUNTER_REPORT_EVENT.ORDERED) continue;
    const costCny = event.costCny ?? 0;
    totals.spendCny = roundCny(totals.spendCny + costCny);
    channel.spendCny = roundCny(channel.spendCny + costCny);
    channel.spendUnit = roundCny(channel.spendUnit + (event.costUnit ?? 0));
    link.spendCny = roundCny(link.spendCny + costCny);
    link.spendUnit = roundCny(link.spendUnit + (event.costUnit ?? 0));
    if (day) day.spendCny = roundCny(day.spendCny + costCny);
    channel.lastOrderedAt = Math.max(channel.lastOrderedAt ?? 0, event.at);
    link.lastOrderedAt = Math.max(link.lastOrderedAt ?? 0, event.at);
    if (event.costUnit !== void 0) {
      pricedOrders++;
      pricedCostCny = roundCny(pricedCostCny + costCny);
      const priced = pricedByChannel.get(event.channel) ?? { count: 0, unit: 0, cny: 0 };
      priced.count++;
      priced.unit = roundCny(priced.unit + event.costUnit);
      priced.cny = roundCny(priced.cny + costCny);
      pricedByChannel.set(event.channel, priced);
    }
  }
  const daily = dateRange.map((entry) => dayByDate.get(entry.date));
  totals.activeDays = daily.filter((day) => day.orders > 0).length;
  totals.avgCostCny = pricedOrders > 0 ? roundCny(pricedCostCny / pricedOrders) : void 0;
  totals.orderRate = totals.restocks > 0 ? totals.orders / totals.restocks : void 0;
  totals.deliverRate = totals.orders > 0 ? totals.delivered / totals.orders : void 0;
  totals.deadKeyRate = totals.orders > 0 ? totals.deadKeys / totals.orders : void 0;
  for (const [channel, priced] of pricedByChannel) {
    const row = channelRows.get(channel);
    if (!row || priced.count === 0) continue;
    row.avgCostUnit = roundCny(priced.unit / priced.count);
    row.avgCostCny = roundCny(priced.cny / priced.count);
  }
  const byChannel = Object.values(KSK_HUNTER_CHANNEL).map((channel) => channelRows.get(channel)).filter((row) => row !== void 0);
  const byLink = [...linkRows.values()].sort(
    (a, b) => b.orders - a.orders || b.restocks - a.restocks || a.linkName.localeCompare(b.linkName)
  );
  return {
    generatedAt: now,
    days,
    fromDate: dateRange[0].date,
    toDate: dateRange[dateRange.length - 1].date,
    totals,
    daily,
    byChannel,
    byLink,
    restockByHour,
    earliestEventAt: input.events.length > 0 ? Math.min(...input.events.map((event) => event.at)) : void 0,
    totalEventCount: input.events.length
  };
}
const STORE_FILE$3 = "ksk-hunter-report.jsonl";
let mutationQueue$3 = Promise.resolve();
function hunterReportStorePath() {
  return node_path.join(electron.app.getPath("userData"), STORE_FILE$3);
}
function readNumber$1(value) {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : void 0;
}
function readType(value) {
  const types = Object.values(HUNTER_REPORT_EVENT);
  return typeof value === "string" && types.includes(value) ? value : null;
}
function readChannel$2(value) {
  const channels = Object.values(KSK_HUNTER_CHANNEL);
  return typeof value === "string" && channels.includes(value) ? value : null;
}
function readReason(value) {
  const reasons = Object.values(KSK_HUNTER_BUDGET_BLOCK);
  return typeof value === "string" && reasons.includes(value) ? value : void 0;
}
function normalizeHunterReportEvent(value) {
  if (!value || typeof value !== "object") return null;
  const source = value;
  const at = readNumber$1(source.at);
  const type = readType(source.type);
  const channel = readChannel$2(source.channel);
  if (at === void 0 || at <= 0 || !type || !channel) return null;
  return {
    at: Math.floor(at),
    type,
    channel,
    linkId: typeof source.linkId === "string" ? source.linkId : "",
    linkName: typeof source.linkName === "string" ? source.linkName : "未命名链接",
    region: typeof source.region === "string" && source.region ? source.region : void 0,
    offerCount: readNumber$1(source.offerCount),
    costUnit: readNumber$1(source.costUnit),
    costCny: readNumber$1(source.costCny),
    unitLabel: typeof source.unitLabel === "string" && source.unitLabel ? source.unitLabel : void 0,
    reason: readReason(source.reason)
  };
}
function parseHunterReportEvents(raw) {
  const events = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = normalizeHunterReportEvent(JSON.parse(trimmed));
      if (event) events.push(event);
    } catch {
      continue;
    }
  }
  return events.sort((a, b) => a.at - b.at);
}
async function loadHunterReportEvents() {
  try {
    return parseHunterReportEvents(await node_fs.promises.readFile(hunterReportStorePath(), "utf-8"));
  } catch {
    return [];
  }
}
async function appendHunterReportEvent(event) {
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  mutationQueue$3 = mutationQueue$3.then(async () => {
    const path2 = hunterReportStorePath();
    await node_fs.promises.mkdir(node_path.dirname(path2), { recursive: true });
    await node_fs.promises.appendFile(path2, `${JSON.stringify(event)}
`, { mode: 384 });
    resolveResult();
  }).catch((error) => {
    rejectResult(error);
  });
  return result;
}
const DOWNSTREAM_CSV_DIR_NAME = "downstream-csv";
const DOWNSTREAM_CSV_FILE_PREFIX = "downstream-";
const DOWNSTREAM_SETTLEMENT_RETENTION_DAYS = 90;
const DOWNSTREAM_SETTLEMENT_TICK_MINUTES = 30;
const DOWNSTREAM_REPORT_WINDOW_DAYS = 30;
function downstreamDayStart(at) {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}
function downstreamDateKeyToStart(date) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!matched) return void 0;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const parsed = new Date(year, month - 1, day);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) {
    return void 0;
  }
  return parsed.getTime();
}
function downstreamDateRange(days, now) {
  const span = Math.max(1, Math.floor(days));
  const todayStart = downstreamDayStart(now);
  const result = [];
  for (let offset = span - 1; offset >= 0; offset--) {
    const date = new Date(todayStart);
    date.setDate(date.getDate() - offset);
    const at = date.getTime();
    result.push({ date: hunterLocalDateKey(at), at });
  }
  return result;
}
function downstreamPendingCredits(delivery, usage) {
  if (!usage) return void 0;
  const anchor = delivery.settledCredits ?? 0;
  return Math.max(0, usage.usedCredits - anchor);
}
function summarizeDownstreamDay(input) {
  const now = input.now ?? Date.now();
  const date = input.date ?? hunterLocalDateKey(now);
  const dayStart = downstreamDateKeyToStart(date) ?? downstreamDayStart(now);
  const nextDayStart = new Date(dayStart);
  nextDayStart.setDate(nextDayStart.getDate() + 1);
  const dayEnd = nextDayStart.getTime();
  const usage = input.usage ?? {};
  const groupNames = input.groupNames ?? {};
  const settlement = input.settlements.find((item) => item.date === date);
  const deliveryById = new Map(input.deliveries.map((item) => [item.id, item]));
  const isToday = date === hunterLocalDateKey(now);
  const creditsByAccount = /* @__PURE__ */ new Map();
  if (settlement) {
    for (const entry of settlement.perAccount) creditsByAccount.set(entry.accountId, entry);
  } else if (isToday) {
    for (const delivery of input.deliveries) {
      if (!delivery.accountId) continue;
      const pending = downstreamPendingCredits(delivery, usage[delivery.accountId]);
      if (pending === void 0 || pending <= 0) continue;
      creditsByAccount.set(delivery.accountId, {
        accountId: delivery.accountId,
        creditsDelta: pending,
        fromAt: delivery.settledAt ?? delivery.purchasedAt,
        toAt: now
      });
    }
  }
  const toRow = (delivery, deliveredToday) => {
    const accountUsage = delivery.accountId ? usage[delivery.accountId] : void 0;
    const delta = delivery.accountId ? creditsByAccount.get(delivery.accountId) : void 0;
    return {
      id: delivery.id,
      accountId: delivery.accountId,
      maskedKey: delivery.maskedKey,
      region: delivery.region,
      channel: delivery.channel,
      linkName: delivery.linkName,
      groupName: delivery.groupId ? groupNames[delivery.groupId] : void 0,
      deliveredAt: delivery.deliveredAt,
      hour: new Date(delivery.deliveredAt).getHours(),
      attempts: delivery.attempts,
      costUnit: delivery.costUnit,
      costCny: delivery.costCny,
      unitLabel: delivery.unitLabel,
      deliveredToday,
      creditsDelta: delta?.creditsDelta,
      creditsFromAt: delta?.fromAt,
      creditsToAt: delta?.toAt,
      totalCredits: accountUsage?.usedCredits,
      state: accountUsage?.state
    };
  };
  const rows = [];
  const deliveriesByHour = Array.from({ length: 24 }, () => 0);
  let deliveries = 0;
  let spendCny = 0;
  const includedIds = /* @__PURE__ */ new Set();
  for (const delivery of input.deliveries) {
    if (delivery.deliveredAt < dayStart || delivery.deliveredAt >= dayEnd) continue;
    deliveries++;
    spendCny = roundCny(spendCny + (delivery.costCny ?? 0));
    deliveriesByHour[new Date(delivery.deliveredAt).getHours()]++;
    rows.push(toRow(delivery, true));
    includedIds.add(delivery.id);
  }
  for (const [accountId, delta] of creditsByAccount) {
    if (delta.creditsDelta <= 0) continue;
    let candidate;
    for (const delivery of deliveryById.values()) {
      if (delivery.accountId !== accountId) continue;
      if (!candidate || delivery.deliveredAt > candidate.deliveredAt) candidate = delivery;
    }
    if (!candidate || includedIds.has(candidate.id)) continue;
    rows.push(toRow(candidate, false));
    includedIds.add(candidate.id);
  }
  const credits = settlement ? settlement.credits : [...creditsByAccount.values()].reduce((sum, item) => sum + item.creditsDelta, 0);
  rows.sort((a, b) => b.deliveredAt - a.deliveredAt || a.maskedKey.localeCompare(b.maskedKey));
  return {
    generatedAt: now,
    date,
    settled: settlement !== void 0,
    settledAt: settlement?.settledAt,
    deliveries,
    spendCny,
    credits,
    rows,
    deliveriesByHour,
    totalDeliveryCount: input.deliveries.length,
    earliestDeliveredAt: input.deliveries.length > 0 ? Math.min(...input.deliveries.map((item) => item.deliveredAt)) : void 0,
    totalSpendCny: roundCny(input.deliveries.reduce((sum, item) => sum + (item.costCny ?? 0), 0))
  };
}
function summarizeDownstreamDaily(input) {
  const now = input.now ?? Date.now();
  const days = Math.max(1, Math.floor(input.days ?? DOWNSTREAM_REPORT_WINDOW_DAYS));
  const range = downstreamDateRange(days, now);
  const settlementByDate = new Map(input.settlements.map((item) => [item.date, item]));
  const usage = input.usage ?? {};
  const rowByDate = /* @__PURE__ */ new Map();
  for (const entry of range) {
    const settlement = settlementByDate.get(entry.date);
    rowByDate.set(entry.date, {
      date: entry.date,
      at: entry.at,
      deliveries: 0,
      spendCny: 0,
      credits: settlement?.credits ?? 0,
      settled: settlement !== void 0
    });
  }
  for (const delivery of input.deliveries) {
    const row = rowByDate.get(hunterLocalDateKey(delivery.deliveredAt));
    if (!row) continue;
    row.deliveries++;
    row.spendCny = roundCny(row.spendCny + (delivery.costCny ?? 0));
  }
  const today = hunterLocalDateKey(now);
  const todayRow = rowByDate.get(today);
  if (todayRow && !todayRow.settled) {
    let credits = 0;
    for (const delivery of input.deliveries) {
      if (!delivery.accountId) continue;
      const pending = downstreamPendingCredits(delivery, usage[delivery.accountId]);
      if (pending !== void 0) credits += pending;
    }
    todayRow.credits = credits;
  }
  return range.map((entry) => rowByDate.get(entry.date));
}
function computeDownstreamSettlement(input) {
  const dayStart = downstreamDateKeyToStart(input.date);
  const perAccount = [];
  let credits = 0;
  let deliveries = 0;
  let spendCny = 0;
  const next = input.deliveries.map((delivery) => {
    if (dayStart !== void 0 && hunterLocalDateKey(delivery.deliveredAt) === input.date) {
      deliveries++;
      spendCny = roundCny(spendCny + (delivery.costCny ?? 0));
    }
    if (!delivery.accountId) return delivery;
    const accountUsage = input.usage[delivery.accountId];
    const pending = downstreamPendingCredits(delivery, accountUsage);
    if (pending === void 0 || accountUsage === void 0) return delivery;
    if (pending > 0) {
      perAccount.push({
        accountId: delivery.accountId,
        creditsDelta: pending,
        fromAt: delivery.settledAt ?? delivery.purchasedAt,
        toAt: input.at
      });
      credits += pending;
    }
    return { ...delivery, settledCredits: accountUsage.usedCredits, settledAt: input.at };
  });
  return {
    settlement: {
      date: input.date,
      settledAt: input.at,
      deliveries,
      spendCny,
      credits,
      perAccount
    },
    deliveries: next
  };
}
function pruneDownstreamSettlements(settlements, now, retentionDays = DOWNSTREAM_SETTLEMENT_RETENTION_DAYS) {
  const cutoff = new Date(downstreamDayStart(now));
  cutoff.setDate(cutoff.getDate() - Math.max(1, retentionDays));
  const cutoffAt = cutoff.getTime();
  return settlements.filter((item) => (downstreamDateKeyToStart(item.date) ?? 0) >= cutoffAt).sort((a, b) => a.date.localeCompare(b.date));
}
const CSV_BOM = "\uFEFF";
const DOWNSTREAM_CSV_HEADERS = [
  "日期",
  "交付时刻",
  "交付小时",
  "完整Key",
  "脱敏Key",
  "Region",
  "渠道",
  "链接",
  "分组",
  "买入价",
  "计价单位",
  "买入价CNY",
  "是否当日交付",
  "当日新增积分",
  "积分区间起",
  "积分区间止",
  "累计消耗积分",
  "号状态"
];
function escapeCsvField(value) {
  return /[",\n\r]/.test(value) || value !== value.trim() ? `"${value.replace(/"/g, '""')}"` : value;
}
function formatCsvTimestamp(at) {
  if (at === void 0) return "";
  const date = new Date(at);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function formatCsvNumber(value) {
  return value === void 0 ? "" : String(value);
}
function toDownstreamCsvFields(row, date) {
  return [
    date,
    formatCsvTimestamp(row.deliveredAt),
    String(row.hour).padStart(2, "0"),
    row.key,
    row.maskedKey,
    row.region,
    row.channel,
    row.linkName,
    row.groupName ?? "",
    formatCsvNumber(row.costUnit),
    row.unitLabel ?? "",
    formatCsvNumber(row.costCny),
    row.deliveredToday ? "是" : "否",
    formatCsvNumber(row.creditsDelta),
    formatCsvTimestamp(row.creditsFromAt),
    formatCsvTimestamp(row.creditsToAt),
    formatCsvNumber(row.totalCredits),
    row.state ?? ""
  ];
}
function buildDownstreamCsv(rows, date) {
  const lines = [DOWNSTREAM_CSV_HEADERS.map(escapeCsvField).join(",")];
  for (const row of rows) {
    lines.push(toDownstreamCsvFields(row, date).map(escapeCsvField).join(","));
  }
  return `${CSV_BOM}${lines.join("\n")}
`;
}
function downstreamCsvFileName(date) {
  return `${DOWNSTREAM_CSV_FILE_PREFIX}${date}.csv`;
}
const STORE_FILE$2 = "ksk-delivery-ledger.enc";
let mutationQueue$2 = Promise.resolve();
function deliveryLedgerStorePath() {
  return node_path.join(electron.app.getPath("userData"), STORE_FILE$2);
}
function isDeliveryLedgerAvailable() {
  try {
    return electron.safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}
function readString$2(value) {
  return typeof value === "string" ? value.trim() : "";
}
function readOptionalString$1(value) {
  return readString$2(value) || void 0;
}
function readOptionalNumber$1(value) {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : void 0;
}
function readCount$1(value) {
  const numberValue = readOptionalNumber$1(value);
  return numberValue !== void 0 && numberValue > 0 ? numberValue : 0;
}
function readChannel$1(value) {
  const channels = Object.values(KSK_HUNTER_CHANNEL);
  const text = readString$2(value);
  return channels.includes(text) ? text : KSK_HUNTER_CHANNEL.KIRO_MARKET;
}
function normalizeDownstreamDelivery(value) {
  if (!value || typeof value !== "object") return null;
  const source = value;
  const id = readString$2(source.id);
  const key = readString$2(source.key);
  const deliveredAt = readOptionalNumber$1(source.deliveredAt);
  if (!id || !isValidKiroApiKey(key) || deliveredAt === void 0 || deliveredAt <= 0) return null;
  const purchasedAt = readOptionalNumber$1(source.purchasedAt);
  return {
    id,
    accountId: readOptionalString$1(source.accountId),
    key,
    // 脱敏值可以从明文重算，不信文件里存的那份（可能被外部改坏）
    maskedKey: maskKiroApiKey(key),
    region: readString$2(source.region),
    channel: readChannel$1(source.channel),
    linkId: readString$2(source.linkId),
    linkName: readString$2(source.linkName) || "未命名链接",
    groupId: readOptionalString$1(source.groupId),
    purchasedAt: purchasedAt !== void 0 && purchasedAt > 0 ? purchasedAt : deliveredAt,
    deliveredAt: Math.floor(deliveredAt),
    attempts: readCount$1(source.attempts) || 1,
    costUnit: readOptionalNumber$1(source.costUnit),
    costCny: readOptionalNumber$1(source.costCny),
    unitLabel: readOptionalString$1(source.unitLabel),
    settledCredits: readOptionalNumber$1(source.settledCredits),
    settledAt: readOptionalNumber$1(source.settledAt)
  };
}
function normalizeCreditDelta(value) {
  if (!value || typeof value !== "object") return null;
  const source = value;
  const accountId = readString$2(source.accountId);
  if (!accountId) return null;
  return {
    accountId,
    creditsDelta: readCount$1(source.creditsDelta),
    fromAt: readCount$1(source.fromAt),
    toAt: readCount$1(source.toAt)
  };
}
function normalizeDownstreamSettlement(value) {
  if (!value || typeof value !== "object") return null;
  const source = value;
  const date = readString$2(source.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const perAccount = Array.isArray(source.perAccount) ? source.perAccount.map(normalizeCreditDelta).filter((item) => item !== null) : [];
  return {
    date,
    settledAt: readCount$1(source.settledAt),
    deliveries: readCount$1(source.deliveries),
    spendCny: readCount$1(source.spendCny),
    credits: readCount$1(source.credits),
    perAccount
  };
}
function normalizeDeliveryLedgerPayload(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const rawDeliveries = Array.isArray(source.deliveries) ? source.deliveries : [];
  const byId = /* @__PURE__ */ new Map();
  for (const item of rawDeliveries) {
    const delivery = normalizeDownstreamDelivery(item);
    if (!delivery) continue;
    const existing = byId.get(delivery.id);
    if (existing && existing.deliveredAt >= delivery.deliveredAt) continue;
    byId.set(delivery.id, delivery);
  }
  const rawSettlements = Array.isArray(source.settlements) ? source.settlements : [];
  const settlementByDate = /* @__PURE__ */ new Map();
  for (const item of rawSettlements) {
    const settlement = normalizeDownstreamSettlement(item);
    if (settlement) settlementByDate.set(settlement.date, settlement);
  }
  return {
    deliveries: [...byId.values()].sort((a, b) => a.deliveredAt - b.deliveredAt),
    settlements: [...settlementByDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    lastSettledDate: readOptionalString$1(source.lastSettledDate)
  };
}
function emptyState() {
  return { deliveries: [], settlements: [] };
}
async function loadDeliveryLedger() {
  if (!isDeliveryLedgerAvailable()) return emptyState();
  try {
    const encrypted = await node_fs.promises.readFile(deliveryLedgerStorePath());
    return normalizeDeliveryLedgerPayload(JSON.parse(electron.safeStorage.decryptString(encrypted)));
  } catch (error) {
    if (error.code === "ENOENT") return emptyState();
    throw new Error("交付账本无法解密或已损坏，已拒绝用空账本覆盖原文件");
  }
}
async function writeLedger$1(state) {
  if (!isDeliveryLedgerAvailable()) {
    throw new Error("系统加密存储不可用，拒绝明文保存已交付的 KSK");
  }
  const path2 = deliveryLedgerStorePath();
  await node_fs.promises.mkdir(node_path.dirname(path2), { recursive: true });
  const payload = {
    version: 1,
    deliveries: state.deliveries,
    settlements: state.settlements,
    lastSettledDate: state.lastSettledDate
  };
  await node_fs.promises.writeFile(path2, electron.safeStorage.encryptString(JSON.stringify(payload)), { mode: 384 });
}
function enqueue$1(task) {
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  mutationQueue$2 = mutationQueue$2.then(async () => {
    resolveResult(await task());
  }).catch((error) => {
    rejectResult(error);
  });
  return result;
}
async function mutateDeliveryLedger(mutate) {
  return enqueue$1(async () => {
    const current = await loadDeliveryLedger();
    const { state, result, dirty } = mutate(current);
    if (dirty !== false) await writeLedger$1(state);
    return result;
  });
}
async function recordDownstreamDelivery(delivery) {
  return mutateDeliveryLedger((state) => {
    if (state.deliveries.some((item) => item.id === delivery.id)) {
      return { state, result: void 0, dirty: false };
    }
    return {
      state: { ...state, deliveries: [...state.deliveries, delivery] },
      result: void 0
    };
  });
}
async function commitDownstreamSettlement(input) {
  return mutateDeliveryLedger((state) => {
    const settlements = pruneDownstreamSettlements(
      [...state.settlements.filter((item) => item.date !== input.date), input.settlement],
      input.now
    );
    return {
      state: {
        deliveries: [...input.deliveries],
        settlements,
        // 取较大值：补齐历史缺口时会逐日结算，不能被中间某天覆盖成更早的日期
        lastSettledDate: state.lastSettledDate && state.lastSettledDate > input.date ? state.lastSettledDate : input.date
      },
      result: void 0
    };
  });
}
const KSK_LEDGER_HOUR_MS = 36e5;
const KSK_LEDGER_STATE = {
  /** 还在账号库里服役。 */
  ALIVE: "alive",
  /** 已经从账号库消失（被清理、被删）。 */
  RETIRED: "retired",
  /** 买到但发消息验活没过：钱花了，号从没用上。 */
  DEAD_ON_ARRIVAL: "dead_on_arrival"
};
const KSK_LEDGER_RETIRE_REASON = {
  /** 额度耗尽被自动/手动清理。这是号的正常寿终。 */
  EXHAUSTED: "exhausted",
  /** 发消息验活判永久失效（封号、认证失败）。 */
  INVALID: "invalid",
  /**
   * 从账号库消失了但没人报告过原因。
   *
   * 用户手动删了账号、或换了一份账号库都会走到这里。
   */
  VANISHED: "vanished"
};
const KSK_LEDGER_DEFAULT_WINDOW_DAYS = 30;
const EMPTY_KSK_LEDGER_TOTALS = {
  entries: 0,
  alive: 0,
  retired: 0,
  wasted: 0,
  spendCny: 0,
  pricedOrders: 0,
  usedCredits: 0
};
const KSK_LEDGER_SORT = {
  PURCHASED: "purchased",
  COST: "cost",
  CREDITS: "credits",
  ALIVE: "alive",
  EFFICIENCY: "efficiency"
};
function resolveLedgerState(entry) {
  if (entry.retiredAt === void 0) return KSK_LEDGER_STATE.ALIVE;
  return entry.retireReason === KSK_LEDGER_RETIRE_REASON.INVALID ? KSK_LEDGER_STATE.DEAD_ON_ARRIVAL : KSK_LEDGER_STATE.RETIRED;
}
function resolveLedgerAliveMs(entry, now) {
  const end = entry.retiredAt ?? now;
  return Math.max(0, end - entry.purchasedAt);
}
function toKskLedgerRow(entry, now) {
  const aliveMs = resolveLedgerAliveMs(entry, now);
  const aliveHours = aliveMs / KSK_LEDGER_HOUR_MS;
  return {
    ...entry,
    state: resolveLedgerState(entry),
    aliveMs,
    // 分母是产出，产出为 0 时「每积分成本」是无穷大，报 undefined 让 UI 显示「—」
    cnyPerCredit: entry.costCny !== void 0 && entry.costCny > 0 && entry.usedCredits > 0 ? entry.costCny / entry.usedCredits : void 0,
    // 存活不足一分钟时样本太少，算出来的时均没有意义
    creditsPerHour: aliveMs >= 6e4 && entry.usedCredits > 0 ? entry.usedCredits / aliveHours : void 0,
    usagePercent: entry.usageLimit !== void 0 && entry.usageLimit > 0 && entry.currentUsage !== void 0 ? entry.currentUsage / entry.usageLimit : void 0
  };
}
function compareKskLedgerRows(a, b, sort) {
  switch (sort) {
    case KSK_LEDGER_SORT.COST:
      return (b.costCny ?? -1) - (a.costCny ?? -1) || b.purchasedAt - a.purchasedAt;
    case KSK_LEDGER_SORT.CREDITS:
      return b.usedCredits - a.usedCredits || b.purchasedAt - a.purchasedAt;
    case KSK_LEDGER_SORT.ALIVE:
      return b.aliveMs - a.aliveMs || b.purchasedAt - a.purchasedAt;
    case KSK_LEDGER_SORT.EFFICIENCY:
      return (a.cnyPerCredit ?? Number.POSITIVE_INFINITY) - (b.cnyPerCredit ?? Number.POSITIVE_INFINITY) || b.purchasedAt - a.purchasedAt;
    default:
      return b.purchasedAt - a.purchasedAt;
  }
}
function aggregateKskLedger(rows) {
  const totals = { ...EMPTY_KSK_LEDGER_TOTALS };
  let aliveMsSum = 0;
  for (const row of rows) {
    totals.entries++;
    if (row.state === KSK_LEDGER_STATE.ALIVE) totals.alive++;
    if (row.state === KSK_LEDGER_STATE.RETIRED) totals.retired++;
    if (row.state === KSK_LEDGER_STATE.DEAD_ON_ARRIVAL) totals.wasted++;
    aliveMsSum += row.aliveMs;
    totals.spendCny += row.costCny ?? 0;
    if (row.costUnit !== void 0) totals.pricedOrders++;
    totals.usedCredits += row.usedCredits;
  }
  totals.spendCny = Math.round(totals.spendCny * 100) / 100;
  totals.avgAliveMs = totals.entries > 0 ? aliveMsSum / totals.entries : void 0;
  totals.cnyPerCredit = totals.usedCredits > 0 && totals.spendCny > 0 ? totals.spendCny / totals.usedCredits : void 0;
  totals.avgCostCny = totals.pricedOrders > 0 ? Math.round(totals.spendCny / totals.pricedOrders * 100) / 100 : void 0;
  return totals;
}
function aggregateKskLedgerByGroup(rows, groupNames = {}) {
  const byGroup = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const key = row.groupId ?? "";
    let bucket = byGroup.get(key);
    if (!bucket) {
      bucket = {
        row: {
          groupId: row.groupId,
          groupName: row.groupId ? groupNames[row.groupId] ?? `已删除的分组（${row.groupId.slice(0, 8)}）` : "未分组",
          entries: 0,
          alive: 0,
          spendCny: 0,
          usedCredits: 0
        },
        aliveMsSum: 0
      };
      byGroup.set(key, bucket);
    }
    bucket.row.entries++;
    if (row.state === KSK_LEDGER_STATE.ALIVE) bucket.row.alive++;
    bucket.row.spendCny += row.costCny ?? 0;
    bucket.row.usedCredits += row.usedCredits;
    bucket.aliveMsSum += row.aliveMs;
  }
  return [...byGroup.values()].map(({ row, aliveMsSum }) => ({
    ...row,
    spendCny: Math.round(row.spendCny * 100) / 100,
    cnyPerCredit: row.usedCredits > 0 && row.spendCny > 0 ? row.spendCny / row.usedCredits : void 0,
    avgAliveMs: row.entries > 0 ? aliveMsSum / row.entries : void 0
  })).sort((a, b) => b.spendCny - a.spendCny || b.entries - a.entries);
}
function summarizeKskLedger(input) {
  const now = input.now ?? Date.now();
  const days = Math.max(1, Math.floor(input.days ?? KSK_LEDGER_DEFAULT_WINDOW_DAYS));
  const fromDate = new Date(now);
  fromDate.setHours(0, 0, 0, 0);
  fromDate.setDate(fromDate.getDate() - (days - 1));
  const from = fromDate.getTime();
  const groupNames = input.groupNames ?? {};
  const rows = input.entries.filter((entry) => entry.purchasedAt >= from).map((entry) => ({
    ...toKskLedgerRow(entry, now),
    groupName: entry.groupId ? groupNames[entry.groupId] : void 0
  })).sort((a, b) => compareKskLedgerRows(a, b, input.sort ?? KSK_LEDGER_SORT.PURCHASED));
  return {
    generatedAt: now,
    days,
    from,
    rows,
    totals: aggregateKskLedger(rows),
    byGroup: aggregateKskLedgerByGroup(rows, groupNames),
    totalEntryCount: input.entries.length,
    earliestPurchasedAt: input.entries.length > 0 ? Math.min(...input.entries.map((entry) => entry.purchasedAt)) : void 0
  };
}
function applyLedgerObservation(input) {
  const seen = new Map(input.observations.map((item) => [item.accountId, item]));
  let changed = false;
  const entries = input.entries.map((entry) => {
    const observation = seen.get(entry.accountId);
    if (!observation) {
      if (entry.retiredAt !== void 0) return entry;
      changed = true;
      return {
        ...entry,
        retiredAt: input.at,
        retireReason: entry.retireReason ?? KSK_LEDGER_RETIRE_REASON.VANISHED
      };
    }
    const current = observation.currentUsage;
    let baseline = entry.baselineUsage ?? current;
    let carried = entry.carriedCredits ?? 0;
    const previous = entry.currentUsage;
    if (current !== void 0 && previous !== void 0 && current < previous) {
      carried += Math.max(0, previous - (baseline ?? previous));
      baseline = current;
    }
    const inPeriod = current !== void 0 && baseline !== void 0 ? Math.max(0, current - baseline) : 0;
    const next = {
      ...entry,
      lastSeenAt: input.at,
      // 号回到账号库（重新导入同一个号）就清掉下线标记
      retiredAt: void 0,
      retireReason: void 0,
      baselineUsage: baseline,
      currentUsage: current ?? entry.currentUsage,
      usageLimit: observation.usageLimit ?? entry.usageLimit,
      carriedCredits: carried,
      usedCredits: carried + inPeriod
    };
    changed = true;
    return next;
  });
  return { entries, changed };
}
const STORE_FILE$1 = "ksk-hunter-ledger.json";
let mutationQueue$1 = Promise.resolve();
function kskLedgerStorePath() {
  return node_path.join(electron.app.getPath("userData"), STORE_FILE$1);
}
function readOptionalNumber(value) {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : void 0;
}
function readCount(value) {
  const numberValue = readOptionalNumber(value);
  return numberValue !== void 0 && numberValue > 0 ? numberValue : 0;
}
function readString$1(value) {
  return typeof value === "string" ? value.trim() : "";
}
function readOptionalString(value) {
  return readString$1(value) || void 0;
}
function readChannel(value) {
  const channels = Object.values(KSK_HUNTER_CHANNEL);
  const text = readString$1(value);
  return channels.includes(text) ? text : KSK_HUNTER_CHANNEL.KIRO_MARKET;
}
function readRetireReason(value) {
  const reasons = Object.values(KSK_LEDGER_RETIRE_REASON);
  const text = readString$1(value);
  return reasons.includes(text) ? text : void 0;
}
function normalizeKskLedgerEntry(value) {
  if (!value || typeof value !== "object") return null;
  const source = value;
  const accountId = readString$1(source.accountId);
  const purchasedAt = readOptionalNumber(source.purchasedAt);
  if (!accountId || purchasedAt === void 0 || purchasedAt <= 0) return null;
  return {
    accountId,
    maskedKey: readString$1(source.maskedKey) || "ksk_...",
    region: readString$1(source.region),
    channel: readChannel(source.channel),
    linkId: readString$1(source.linkId),
    linkName: readString$1(source.linkName) || "未命名链接",
    groupId: readOptionalString(source.groupId),
    purchasedAt: Math.floor(purchasedAt),
    costUnit: readOptionalNumber(source.costUnit),
    costCny: readOptionalNumber(source.costCny),
    unitLabel: readOptionalString(source.unitLabel),
    lastSeenAt: readOptionalNumber(source.lastSeenAt),
    retiredAt: readOptionalNumber(source.retiredAt),
    retireReason: readRetireReason(source.retireReason),
    baselineUsage: readOptionalNumber(source.baselineUsage),
    currentUsage: readOptionalNumber(source.currentUsage),
    usageLimit: readOptionalNumber(source.usageLimit),
    carriedCredits: readCount(source.carriedCredits),
    usedCredits: readCount(source.usedCredits)
  };
}
function normalizeKskLedgerPayload(payload) {
  const source = payload && typeof payload === "object" ? payload.entries : void 0;
  if (!Array.isArray(source)) return [];
  const byId = /* @__PURE__ */ new Map();
  for (const item of source) {
    const entry = normalizeKskLedgerEntry(item);
    if (!entry) continue;
    const existing = byId.get(entry.accountId);
    if (existing && existing.purchasedAt >= entry.purchasedAt) continue;
    byId.set(entry.accountId, entry);
  }
  return [...byId.values()].sort((a, b) => a.purchasedAt - b.purchasedAt).slice(-5e3);
}
async function loadKskLedger() {
  try {
    return normalizeKskLedgerPayload(JSON.parse(await node_fs.promises.readFile(kskLedgerStorePath(), "utf-8")));
  } catch {
    return [];
  }
}
async function writeLedger(entries) {
  const path2 = kskLedgerStorePath();
  await node_fs.promises.mkdir(node_path.dirname(path2), { recursive: true });
  const payload = { version: 1, entries };
  await node_fs.promises.writeFile(path2, JSON.stringify(payload), { mode: 384 });
}
function enqueue(task) {
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  mutationQueue$1 = mutationQueue$1.then(async () => {
    resolveResult(await task());
  }).catch((error) => {
    rejectResult(error);
  });
  return result;
}
async function mutateKskLedger(mutate) {
  return enqueue(async () => {
    const current = await loadKskLedger();
    const { entries, result, dirty } = mutate(current);
    if (dirty !== false) await writeLedger(entries.slice(-5e3));
    return result;
  });
}
async function recordKskLedgerPurchase(entry) {
  return mutateKskLedger((entries) => {
    const index = entries.findIndex((item) => item.accountId === entry.accountId);
    if (index < 0) return { entries: [...entries, entry], result: void 0 };
    const previous = entries[index];
    const next = [...entries];
    next[index] = {
      ...entry,
      baselineUsage: previous.baselineUsage ?? entry.baselineUsage,
      currentUsage: previous.currentUsage,
      usageLimit: previous.usageLimit ?? entry.usageLimit,
      carriedCredits: previous.carriedCredits,
      usedCredits: previous.usedCredits,
      lastSeenAt: previous.lastSeenAt
    };
    return { entries: next, result: void 0 };
  });
}
async function markKskLedgerRetired(input) {
  return mutateKskLedger((entries) => {
    const index = entries.findIndex((item) => item.accountId === input.accountId);
    if (index < 0) return { entries, result: void 0, dirty: false };
    const next = [...entries];
    next[index] = { ...next[index], retiredAt: input.at, retireReason: input.reason };
    return { entries: next, result: void 0 };
  });
}
async function updateKskLedgerFromAccounts(input) {
  return mutateKskLedger((entries) => {
    if (entries.length === 0) return { entries, result: void 0, dirty: false };
    const applied = applyLedgerObservation({
      entries,
      observations: input.observations,
      at: input.at
    });
    return { entries: applied.entries, result: void 0, dirty: applied.changed };
  });
}
async function clearKskLedger() {
  return enqueue(() => writeLedger([]));
}
const STORE_FILE = "ksk-hunter.enc";
const MAX_DELIVERY_RECORDS = 200;
const SPEND_RETENTION_DAYS = 14;
let mutationQueue = Promise.resolve();
function storePath() {
  return node_path.join(electron.app.getPath("userData"), STORE_FILE);
}
function normalizeString(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}
function positiveInt(value, fallback, min, max) {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numberValue)));
}
function normalizeChannel(value) {
  return normalizeChannelValue(value) ?? KSK_HUNTER_CHANNEL.KIRO_MARKET;
}
function normalizeMode(value) {
  return normalizeString(value) === KSK_HUNTER_MODE.AUTO_ORDER ? KSK_HUNTER_MODE.AUTO_ORDER : KSK_HUNTER_MODE.NOTIFY;
}
function normalizeRegions(value) {
  if (!Array.isArray(value)) return [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of value) {
    const region = normalizeString(item).toLowerCase();
    if (isValidKiroRegion(region)) seen.add(region);
  }
  return [...seen];
}
function normalizeDeliveryState(value) {
  const states = Object.values(KSK_HUNTER_DELIVERY_STATE);
  const text = normalizeString(value);
  return states.includes(text) ? text : KSK_HUNTER_DELIVERY_STATE.PENDING;
}
function normalizeAmount(value, fallback, max) {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) return fallback;
  return roundCny(Math.min(max, numberValue));
}
function normalizeChannelBilling(value) {
  const source = value ?? {};
  const rawPerUnit = typeof source.cnyPerUnit === "number" ? source.cnyPerUnit : Number(source.cnyPerUnit);
  const cnyPerUnit = Number.isFinite(rawPerUnit) && rawPerUnit > 0 ? Math.min(KSK_HUNTER_MAX_CNY_PER_UNIT, rawPerUnit) : DEFAULT_KSK_HUNTER_CHANNEL_BILLING.cnyPerUnit;
  return {
    unitLabel: normalizeString(source.unitLabel).slice(0, 8) || DEFAULT_KSK_HUNTER_CHANNEL_BILLING.unitLabel,
    cnyPerUnit,
    dailyLimitUnit: normalizeAmount(source.dailyLimitUnit, 0, Number.MAX_SAFE_INTEGER),
    lowBalanceThresholdUnit: normalizeAmount(
      source.lowBalanceThresholdUnit,
      0,
      Number.MAX_SAFE_INTEGER
    )
  };
}
function normalizeBilling(value) {
  const source = value ?? {};
  const result = {};
  for (const channel of Object.values(KSK_HUNTER_CHANNEL)) {
    result[channel] = normalizeChannelBilling(
      source[channel] ?? DEFAULT_KSK_HUNTER_CONFIG.billing[channel]
    );
  }
  return result;
}
function normalizeChannelSecrets(value) {
  const source = value ?? {};
  const result = {};
  for (const channel of Object.values(KSK_HUNTER_CHANNEL)) {
    const text = normalizeString(source[channel]);
    if (text) result[channel] = text;
  }
  return result;
}
function mergeChannelSecrets(current, patch) {
  const merged = { ...current ?? {} };
  for (const [channel, value] of Object.entries(patch)) {
    if (value === void 0) continue;
    const trimmed = normalizeString(value);
    if (trimmed) merged[channel] = trimmed;
    else delete merged[channel];
  }
  return merged;
}
function normalizeKskHunterConfig(input) {
  const source = input ?? {};
  return {
    targetGroupId: normalizeString(source.targetGroupId) || void 0,
    requestTimeoutSeconds: positiveInt(
      source.requestTimeoutSeconds,
      KSK_HUNTER_REQUEST_TIMEOUT_SECONDS,
      3,
      120
    ),
    notifyOnAutoOrder: source.notifyOnAutoOrder !== false,
    downstreamEnabled: source.downstreamEnabled === true,
    downstreamBaseUrl: normalizeString(source.downstreamBaseUrl) || DEFAULT_KSK_HUNTER_CONFIG.downstreamBaseUrl,
    dailyLimitCny: normalizeAmount(source.dailyLimitCny, 0, Number.MAX_SAFE_INTEGER),
    billing: normalizeBilling(source.billing),
    allowUnknownPriceOrder: source.allowUnknownPriceOrder === true,
    balanceCheckEnabled: source.balanceCheckEnabled === true,
    csvExportDir: normalizeString(source.csvExportDir) || void 0
  };
}
function normalizeLink(value, now) {
  if (!value || typeof value !== "object") return null;
  const source = value;
  const id = normalizeString(source.id);
  if (!id) return null;
  const createdAt = positiveInt(source.createdAt, now, 0, Number.MAX_SAFE_INTEGER);
  return {
    id,
    name: normalizeString(source.name) || "未命名链接",
    channel: normalizeChannel(source.channel),
    enabled: source.enabled !== false,
    mode: normalizeMode(source.mode),
    regions: normalizeRegions(source.regions),
    createdAt,
    updatedAt: positiveInt(source.updatedAt, createdAt, 0, Number.MAX_SAFE_INTEGER),
    secrets: {
      listUrl: normalizeString(source.secrets?.listUrl),
      orderUrl: normalizeString(source.secrets?.orderUrl)
    }
  };
}
function normalizeDelivery(value, now) {
  if (!value || typeof value !== "object") return null;
  const source = value;
  const id = normalizeString(source.id);
  const key = normalizeString(source.key);
  if (!id || !key) return null;
  const createdAt = positiveInt(source.createdAt, now, 0, Number.MAX_SAFE_INTEGER);
  return {
    id,
    linkId: normalizeString(source.linkId),
    linkName: normalizeString(source.linkName) || "未命名链接",
    channel: normalizeChannelValue(source.channel) ?? void 0,
    key,
    region: normalizeString(source.region),
    accountId: normalizeString(source.accountId) || void 0,
    groupId: normalizeString(source.groupId) || void 0,
    state: normalizeDeliveryState(source.state),
    attempts: positiveInt(source.attempts, 0, 0, 1e3),
    createdAt,
    updatedAt: positiveInt(source.updatedAt, createdAt, 0, Number.MAX_SAFE_INTEGER),
    nextAttemptAt: source.nextAttemptAt === void 0 ? void 0 : positiveInt(source.nextAttemptAt, now, 0, Number.MAX_SAFE_INTEGER),
    lastError: normalizeString(source.lastError) || void 0,
    costUnit: typeof source.costUnit === "number" && Number.isFinite(source.costUnit) ? source.costUnit : void 0,
    costCny: typeof source.costCny === "number" && Number.isFinite(source.costCny) ? roundCny(source.costCny) : void 0,
    unitLabel: normalizeString(source.unitLabel) || void 0
  };
}
function normalizeChannelValue(value) {
  const channels = Object.values(KSK_HUNTER_CHANNEL);
  const text = normalizeString(value);
  return channels.includes(text) ? text : null;
}
function normalizeSpend(value, now) {
  if (!value || typeof value !== "object") return null;
  const source = value;
  const id = normalizeString(source.id);
  const channel = normalizeChannelValue(source.channel);
  if (!id || !channel) return null;
  const amountUnit = typeof source.amountUnit === "number" ? source.amountUnit : Number.NaN;
  const amountCny = typeof source.amountCny === "number" ? source.amountCny : Number.NaN;
  if (!Number.isFinite(amountUnit) || !Number.isFinite(amountCny)) return null;
  if (amountUnit < 0 || amountCny < 0) return null;
  return {
    id,
    channel,
    amountUnit,
    amountCny: roundCny(amountCny),
    at: positiveInt(source.at, now, 0, Number.MAX_SAFE_INTEGER)
  };
}
function emptyStore() {
  return {
    version: KSK_HUNTER_STORE_VERSION,
    config: normalizeKskHunterConfig(void 0),
    secrets: { downstreamApiKey: "", balanceUrls: {}, apiKeys: {} },
    links: [],
    deliveries: [],
    spend: []
  };
}
function normalizeKskHunterStorePayload(payload, now = Date.now()) {
  if (!payload || typeof payload !== "object") return emptyStore();
  const source = payload;
  const ids = /* @__PURE__ */ new Set();
  const links = (Array.isArray(source.links) ? source.links : []).map((link) => normalizeLink(link, now)).filter((link) => Boolean(link)).filter((link) => {
    if (ids.has(link.id)) return false;
    ids.add(link.id);
    return true;
  });
  const deliveries = (Array.isArray(source.deliveries) ? source.deliveries : []).map((delivery) => normalizeDelivery(delivery, now)).filter((delivery) => Boolean(delivery)).slice(-MAX_DELIVERY_RECORDS);
  const spendCutoff = now - SPEND_RETENTION_DAYS * 24 * 60 * 6e4;
  const spend = (Array.isArray(source.spend) ? source.spend : []).map((entry) => normalizeSpend(entry, now)).filter((entry) => Boolean(entry)).filter((entry) => entry.at >= spendCutoff);
  return {
    version: KSK_HUNTER_STORE_VERSION,
    config: normalizeKskHunterConfig(source.config),
    secrets: {
      downstreamApiKey: normalizeString(source.secrets?.downstreamApiKey),
      balanceUrls: normalizeChannelSecrets(source.secrets?.balanceUrls),
      apiKeys: normalizeChannelSecrets(source.secrets?.apiKeys)
    },
    links,
    deliveries,
    spend
  };
}
function isKskHunterStoreAvailable() {
  try {
    return electron.safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}
async function loadKskHunterStore() {
  if (!isKskHunterStoreAvailable()) return emptyStore();
  try {
    const encrypted = await node_fs.promises.readFile(storePath());
    return normalizeKskHunterStorePayload(JSON.parse(electron.safeStorage.decryptString(encrypted)));
  } catch (error) {
    if (error.code === "ENOENT") return emptyStore();
    throw new Error("抢号配置无法解密或已损坏，已拒绝用空配置覆盖原文件");
  }
}
async function saveStore(store2) {
  if (!isKskHunterStoreAvailable()) {
    throw new Error("系统加密存储不可用，拒绝明文保存商品链接 token、下游 API Key 或已购 KSK");
  }
  const encrypted = electron.safeStorage.encryptString(JSON.stringify(store2));
  await node_fs.promises.writeFile(storePath(), encrypted, { mode: 384 });
}
async function mutateKskHunterStore(mutate) {
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  mutationQueue = mutationQueue.then(async () => {
    const store2 = await loadKskHunterStore();
    const value = await mutate(store2);
    await saveStore(store2);
    resolveResult(value);
  }).catch((error) => {
    rejectResult(error);
  });
  return result;
}
async function updateKskHunterConfig(config, secrets) {
  return mutateKskHunterStore((store2) => {
    store2.config = normalizeKskHunterConfig({ ...store2.config, ...config });
    if (secrets?.downstreamApiKey !== void 0) {
      store2.secrets.downstreamApiKey = normalizeString(secrets.downstreamApiKey);
    }
    if (secrets?.balanceUrls) {
      store2.secrets.balanceUrls = mergeChannelSecrets(
        store2.secrets.balanceUrls,
        secrets.balanceUrls
      );
    }
    if (secrets?.apiKeys) {
      store2.secrets.apiKeys = mergeChannelSecrets(store2.secrets.apiKeys, secrets.apiKeys);
    }
    return store2;
  });
}
function applyLinkInput(link, input) {
  link.name = normalizeString(input.name) || link.name;
  link.channel = normalizeChannel(input.channel);
  link.enabled = input.enabled ?? link.enabled;
  link.mode = normalizeMode(input.mode);
  link.regions = input.regions === void 0 ? link.regions : normalizeRegions(input.regions);
  if (input.listUrl !== void 0) link.secrets.listUrl = normalizeString(input.listUrl);
  if (input.orderUrl !== void 0) link.secrets.orderUrl = normalizeString(input.orderUrl);
  link.updatedAt = Date.now();
  return link;
}
async function createKskHunterLink(id, input) {
  return mutateKskHunterStore((store2) => {
    const now = Date.now();
    const link = {
      id,
      name: normalizeString(input.name) || "未命名链接",
      channel: normalizeChannel(input.channel),
      enabled: input.enabled !== false,
      mode: normalizeMode(input.mode),
      regions: normalizeRegions(input.regions),
      createdAt: now,
      updatedAt: now,
      secrets: { listUrl: "", orderUrl: "" }
    };
    store2.links.push(applyLinkInput(link, input));
    return link;
  });
}
async function updateKskHunterLink(linkId, input) {
  return mutateKskHunterStore((store2) => {
    const link = store2.links.find((item) => item.id === linkId);
    if (!link) throw new Error("链接不存在或已删除");
    return applyLinkInput(link, input);
  });
}
async function setKskHunterLinkEnabled(linkId, enabled) {
  return mutateKskHunterStore((store2) => {
    const link = store2.links.find((item) => item.id === linkId);
    if (!link) throw new Error("链接不存在或已删除");
    link.enabled = enabled;
    link.updatedAt = Date.now();
    return link;
  });
}
async function deleteKskHunterLink(linkId) {
  return mutateKskHunterStore((store2) => {
    const index = store2.links.findIndex((item) => item.id === linkId);
    if (index < 0) throw new Error("链接不存在或已删除");
    store2.links.splice(index, 1);
  });
}
async function appendKskHunterDelivery(delivery) {
  return mutateKskHunterStore((store2) => {
    store2.deliveries.push(delivery);
    if (store2.deliveries.length > MAX_DELIVERY_RECORDS) {
      store2.deliveries.splice(0, store2.deliveries.length - MAX_DELIVERY_RECORDS);
    }
  });
}
async function appendKskHunterSpend(entry) {
  return mutateKskHunterStore((store2) => {
    store2.spend.push(entry);
    const cutoff = Date.now() - SPEND_RETENTION_DAYS * 24 * 60 * 6e4;
    store2.spend = store2.spend.filter((item) => item.at >= cutoff);
  });
}
async function patchKskHunterDelivery(deliveryId, patch) {
  return mutateKskHunterStore((store2) => {
    const delivery = store2.deliveries.find((item) => item.id === deliveryId);
    if (!delivery) return;
    Object.assign(delivery, patch, { updatedAt: Date.now() });
  });
}
async function deleteKskHunterDelivery(deliveryId) {
  return mutateKskHunterStore((store2) => {
    const index = store2.deliveries.findIndex((item) => item.id === deliveryId);
    if (index < 0) throw new Error("记录不存在或已删除");
    store2.deliveries.splice(index, 1);
  });
}
function toKskHunterConfigView(store2) {
  return {
    ...store2.config,
    pollIntervalSeconds: KSK_HUNTER_POLL_INTERVAL_SECONDS,
    encryptionAvailable: isKskHunterStoreAvailable(),
    hasDownstreamApiKey: Boolean(store2.secrets.downstreamApiKey),
    downstreamApiKeyTail: maskHunterSecretTail(store2.secrets.downstreamApiKey),
    balanceUrlHints: Object.fromEntries(
      Object.values(KSK_HUNTER_CHANNEL).map((channel) => [
        channel,
        hunterUrlHint(store2.secrets.balanceUrls?.[channel] ?? "")
      ])
    ),
    apiKeyHints: Object.fromEntries(
      Object.values(KSK_HUNTER_CHANNEL).map((channel) => [
        channel,
        maskHunterSecretTail(store2.secrets.apiKeys?.[channel] ?? "")
      ])
    )
  };
}
function toKskHunterLinkView(link, runtime = { lastInStock: false }) {
  return {
    id: link.id,
    name: link.name,
    channel: link.channel,
    enabled: link.enabled,
    mode: link.mode,
    regions: [...link.regions],
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
    hasListUrl: Boolean(link.secrets.listUrl),
    listUrlHint: hunterUrlHint(link.secrets.listUrl),
    hasOrderUrl: Boolean(link.secrets.orderUrl),
    orderUrlHint: hunterUrlHint(link.secrets.orderUrl),
    lastInStock: runtime.lastInStock,
    lastCheckedAt: runtime.lastCheckedAt,
    lastError: runtime.lastError
  };
}
function toKskHunterDeliveryView(delivery) {
  return {
    id: delivery.id,
    linkId: delivery.linkId,
    linkName: delivery.linkName,
    maskedKey: maskKiroApiKey(delivery.key),
    region: delivery.region,
    state: delivery.state,
    attempts: delivery.attempts,
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
    nextAttemptAt: delivery.nextAttemptAt,
    lastError: delivery.lastError,
    costUnit: delivery.costUnit,
    costCny: delivery.costCny,
    unitLabel: delivery.unitLabel
  };
}
function toKskHunterSpendEntries(store2) {
  return (store2.spend ?? []).map((entry) => ({
    channel: entry.channel,
    amountUnit: entry.amountUnit,
    amountCny: entry.amountCny,
    at: entry.at
  }));
}
const ZONE_TO_REGION = {
  us: "us-east-1",
  eu: "eu-central-1",
  ap: "ap-southeast-1"
};
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readString(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}
function readNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : void 0;
  const text = readString(value);
  if (!text) return void 0;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : void 0;
}
function resolveOfferRegion(...candidates) {
  for (const candidate of candidates) {
    const text = readString(candidate).toLowerCase();
    if (!text) continue;
    const fullRegion = text.match(/[a-z]{2}-[a-z]+-\d/)?.[0];
    if (fullRegion && isValidKiroRegion(fullRegion)) return fullRegion;
  }
  for (const candidate of candidates) {
    const text = readString(candidate).toLowerCase();
    if (!text) continue;
    const zone = text.match(/\b(us|eu|ap)\b/)?.[1] ?? text.match(/key-(us|eu|ap)/)?.[1];
    const mapped = zone ? ZONE_TO_REGION[zone] : void 0;
    if (mapped) return mapped;
  }
  return "";
}
function resolveStock(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === "boolean") return candidate ? 1 : 0;
    const numeric = typeof candidate === "number" ? candidate : void 0;
    if (numeric !== void 0 && Number.isFinite(numeric)) return Math.max(0, Math.floor(numeric));
    const text = readString(candidate);
    if (!text) continue;
    if (/售罄|缺货|sold[\s_-]?out|out[\s_-]?of[\s_-]?stock/i.test(text)) return 0;
    if (/有货|in[\s_-]?stock|available/i.test(text)) return 1;
    const parsed = Number(text);
    if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
  }
  return 0;
}
function readOfferArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) throw new Error("商品列表接口返回的不是 JSON 对象");
  for (const key of ["data", "list", "items", "goods", "products", "result"]) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
    if (isRecord(value)) {
      for (const innerKey of ["list", "items", "goods", "products", "records"]) {
        const inner = value[innerKey];
        if (Array.isArray(inner)) return inner;
      }
    }
  }
  throw new Error("商品列表接口未返回可识别的商品数组");
}
function assertBusinessOk(payload) {
  if (!isRecord(payload)) return;
  const code = payload.code ?? payload.status;
  if (code === void 0 || code === null) return;
  const numericCode = readNumber(code);
  const isOk = numericCode === 0 || numericCode === 200 || code === "ok" || code === "success" || payload.success === true;
  if (!isOk) {
    throw new Error(
      readString(payload.msg || payload.message) || `接口返回 code=${readString(code)}`
    );
  }
}
function parseKiroMarketOffers(payload) {
  return readOfferArray(payload).flatMap((item) => {
    if (!isRecord(item)) return [];
    const goodsId = readString(item.id ?? item.goodsId ?? item.sku);
    if (!goodsId) return [];
    return [
      {
        goodsId,
        title: readString(item.title ?? item.name),
        region: resolveOfferRegion(item.tag, item.title, item.name, item.slug),
        stock: resolveStock(item.stock, item.inventory, item.stockText),
        price: readNumber(item.price)
      }
    ];
  });
}
function parseKiroCeoOffers(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.zones)) {
    throw new Error("Kiro CEO 库存接口未返回 zones 数组");
  }
  return payload.zones.flatMap((item) => {
    if (!isRecord(item)) return [];
    const goodsId = readString(item.zone);
    if (!goodsId) return [];
    return [
      {
        goodsId,
        title: readString(item.label) || `Kiro Key · ${goodsId}`,
        region: resolveOfferRegion(item.zone, item.label),
        // 下架的区域按无货处理：站点还会返回 stock，但下单必然失败
        stock: item.enabled === false ? 0 : resolveStock(item.stock, item.available),
        price: readNumber(item.unit_price)
      }
    ];
  });
}
function parseKiroDropOffers(payload) {
  return readOfferArray(payload).flatMap((item) => {
    if (!isRecord(item)) return [];
    const goodsId = readString(item.id ?? item.item_id ?? item.sku);
    if (!goodsId) return [];
    return [
      {
        goodsId,
        title: readString(item.title ?? item.name),
        region: resolveOfferRegion(item.tag, item.region, item.title, item.name),
        stock: resolveStock(item.stock_count, item.stock, item.available),
        price: readNumber(item.price)
      }
    ];
  });
}
const KIRO_APP_ZONES = [
  { zone: "eu", region: "eu-central-1", stockField: "stock_eu", priceField: "price_eu" },
  { zone: "us", region: "us-east-1", stockField: "stock_us", priceField: "price_us" }
];
function parseKiroAppOffers(payload) {
  if (!isRecord(payload)) throw new Error("KiroApp 状态接口返回的不是 JSON 对象");
  const hasAnyZoneField = KIRO_APP_ZONES.some((entry) => entry.stockField in payload);
  if (!hasAnyZoneField && !("stock" in payload)) {
    throw new Error("KiroApp 状态接口未返回 stock_eu / stock_us 字段");
  }
  return KIRO_APP_ZONES.map((entry) => ({
    goodsId: entry.zone,
    title: `Kiro Key · ${entry.region}`,
    region: entry.region,
    stock: resolveStock(
      payload[entry.stockField],
      entry.stockField in payload ? void 0 : payload.stock
    ),
    price: readNumber(payload[entry.priceField] ?? payload.price)
  }));
}
function parseChannelOffers(channel, payload) {
  assertBusinessOk(payload);
  switch (channel) {
    case KSK_HUNTER_CHANNEL.KIRO_MARKET:
      return parseKiroMarketOffers(payload);
    case KSK_HUNTER_CHANNEL.KIRO_CEO:
      return parseKiroCeoOffers(payload);
    case KSK_HUNTER_CHANNEL.KIRO_DROP:
      return parseKiroDropOffers(payload);
    case KSK_HUNTER_CHANNEL.KIRO_APP:
      return parseKiroAppOffers(payload);
  }
}
function buildOrderRequestBody(channel, offer, options = {}) {
  switch (channel) {
    case KSK_HUNTER_CHANNEL.KIRO_MARKET:
      return { id: offer.goodsId, num: 1 };
    /*
     * Kiro CEO：goodsId 是区域短码（us / eu），不是商品 id。
     * client_order_id 是站点必填项（32 位十六进制），漏传会 400，
     * 所以这里宁可抛错也不发一个注定失败的请求。
     */
    case KSK_HUNTER_CHANNEL.KIRO_CEO:
      if (!options.idempotencyKey) throw new Error("Kiro CEO 下单缺少幂等键");
      return { count: 1, zone: offer.goodsId, client_order_id: options.idempotencyKey };
    case KSK_HUNTER_CHANNEL.KIRO_DROP:
      return { item_id: offer.goodsId, quantity: 1 };
    /*
     * KiroApp 的下单请求体是**按假设写的，待核对**。
     *
     * /api/status 是实测的（未登录可 GET），但下单接口挖不到：站点的 /api-docs 需要登录
     * 才渲染，JS chunk 里只有它自己前端用的 cookie + CSRF 接口（/api/auth/*、/api/status），
     * 没有第三方下单路径。
     *
     * 这里按该站点已暴露的字段命名习惯（zone / region 后缀那套）取名。拿到文档后
     * 大概率只需要改这两个键名；若它要求鉴权走请求头而不是 URL query，
     * 还得改 hunterRunner 的 fetchJson —— 那超出渠道适配范围，需要另行处理。
     */
    case KSK_HUNTER_CHANNEL.KIRO_APP:
      return { zone: offer.goodsId, count: 1 };
  }
}
function findCredentialInPayload(payload, depth = 0) {
  if (depth > 6) return void 0;
  if (typeof payload === "string") {
    const key = payload.trim().split("----")[0].trim();
    if (!isValidKiroApiKey(key)) return void 0;
    return { key, region: resolveOfferRegion(payload) };
  }
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findCredentialInPayload(item, depth + 1);
      if (found) return found;
    }
    return void 0;
  }
  if (!isRecord(payload)) return void 0;
  for (const keyField of ["key", "ksk", "apiKey", "api_key", "kiroApiKey", "card", "secret"]) {
    const candidate = readString(payload[keyField]).split("----")[0].trim();
    if (!isValidKiroApiKey(candidate)) continue;
    const region = resolveOfferRegion(
      payload.region,
      payload.aws_region,
      payload.zone,
      payload.tag,
      payload.title,
      payload[keyField]
    );
    return { key: candidate, region };
  }
  for (const value of Object.values(payload)) {
    const found = findCredentialInPayload(value, depth + 1);
    if (!found) continue;
    if (found.region) return found;
    return {
      key: found.key,
      region: resolveOfferRegion(payload.region, payload.aws_region, payload.zone, payload.tag)
    };
  }
  return void 0;
}
function parseOrderedCredential(payload, fallbackRegion) {
  assertBusinessOk(payload);
  const found = findCredentialInPayload(payload);
  if (!found) throw new Error("下单响应里没有找到 ksk_ 开头的密钥");
  const region = found.region || fallbackRegion;
  if (!isValidKiroRegion(region)) {
    throw new Error(`下单成功但无法确定区域（key ••••${found.key.slice(-4)}）`);
  }
  return { key: found.key, region };
}
function redactDownstreamDetail(value) {
  return value.replace(/ksk_[A-Za-z0-9_-]+/g, "ksk_••••").replace(/("?(?:key|apiKey|api_key|token)"?\s*[:=]\s*")([^"]+)(")/gi, "$1••••$3");
}
function isLoopback(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}
function resolveDownstreamBase(value) {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed.hostname))) {
    throw new Error("下游接口仅允许 loopback HTTP；远程地址必须使用 HTTPS");
  }
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}
async function requestDownstream(options, path2, init) {
  const base = resolveDownstreamBase(options.baseUrl);
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("未配置下游 API Key");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(3, options.timeoutSeconds) * 1e3);
  try {
    const response = await options.fetchImpl(`${base}${path2}`, {
      method: init.method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        [KSK_HUNTER_DOWNSTREAM_AUTH_HEADER]: apiKey
      },
      body: init.body === void 0 ? void 0 : JSON.stringify(init.body),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      const detail = redactDownstreamDetail(text.replace(/\s+/g, " ").trim()).slice(0, 300);
      throw new Error(`下游请求失败: HTTP ${response.status}${detail ? ` · ${detail}` : ""}`);
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}
function readBooleanField(payload, field) {
  if (typeof payload !== "object" || payload === null) return false;
  const value = payload[field];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  if (typeof value === "number") return value === 1;
  return false;
}
async function askDownstreamNeedsAccount(options) {
  const payload = await requestDownstream(options, KSK_HUNTER_DOWNSTREAM_PATH.needAccount, {
    method: "GET"
  });
  return readBooleanField(payload, "need");
}
async function pushKskToDownstream(options, credential) {
  const payload = await requestDownstream(options, KSK_HUNTER_DOWNSTREAM_PATH.pushKsk, {
    method: "POST",
    body: { key: credential.key, region: credential.region }
  });
  if (!readBooleanField(payload, "ok")) {
    throw new Error("下游未确认接收（响应中 ok 不为 true）");
  }
}
const KSK_HUNTER_BALANCE_TTL_MS = 6e4;
function redactBalanceError(value) {
  return value.replace(/([?&](?:token|key|apikey)=)[^&\s]+/gi, "$1••••").replace(/ksk_[A-Za-z0-9_-]+/g, "ksk_••••");
}
async function fetchChannelBalance(input) {
  const parsed = new URL(input.url);
  if (parsed.protocol !== "https:") throw new Error("余额查询地址必须使用 HTTPS");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(3, input.timeoutSeconds) * 1e3);
  try {
    const response = await input.fetchImpl(parsed.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...input.apiKey ? { [KSK_HUNTER_CHANNEL_AUTH_HEADER]: input.apiKey } : {}
      },
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`余额查询失败: HTTP ${response.status}`);
    const balance = parseHunterBalance(text ? JSON.parse(text) : {});
    if (balance === void 0) throw new Error("余额响应里没找到可识别的余额字段");
    if (balance < 0) throw new Error(`余额响应异常（${balance}）`);
    return balance;
  } catch (error) {
    throw new Error(redactBalanceError(error instanceof Error ? error.message : String(error)));
  } finally {
    clearTimeout(timer);
  }
}
class HunterBalanceCache {
  cache = /* @__PURE__ */ new Map();
  /** 读缓存，不发请求。 */
  peek(channel) {
    return this.cache.get(channel);
  }
  /** 全部缓存快照，供 UI 展示。 */
  entries() {
    return [...this.cache.entries()];
  }
  /** 下单后余额已变，主动失效，下次判断会重新查。 */
  invalidate(channel) {
    this.cache.delete(channel);
  }
  /**
   * 取余额，缓存未过期就用缓存。
   *
   * 查询失败时把错误记进缓存并返回 undefined——调用方据此决定「查不到余额就不拦」，
   * 因为拦了会让站点抖动直接停掉抢号，代价比偶尔白跑一次下单大。
   */
  async resolve(input) {
    const now = input.now ?? Date.now();
    const cached = this.cache.get(input.channel);
    if (cached && now - cached.checkedAt < KSK_HUNTER_BALANCE_TTL_MS) return cached;
    try {
      const amountUnit = await fetchChannelBalance({
        url: input.url,
        timeoutSeconds: input.timeoutSeconds,
        fetchImpl: input.fetchImpl,
        apiKey: input.apiKey
      });
      const snapshot = { amountUnit, checkedAt: now };
      this.cache.set(input.channel, snapshot);
      return snapshot;
    } catch (error) {
      const snapshot = {
        amountUnit: void 0,
        checkedAt: now,
        error: error instanceof Error ? error.message : String(error)
      };
      this.cache.set(input.channel, snapshot);
      return snapshot;
    }
  }
}
function deliveryReportLink(delivery, store2) {
  const link = store2.links.find((item) => item.id === delivery.linkId);
  return {
    id: delivery.linkId,
    name: link?.name ?? delivery.linkName,
    channel: link?.channel ?? delivery.channel ?? KSK_HUNTER_CHANNEL.KIRO_MARKET
  };
}
const EMPTY_STATUS = {
  state: KSK_HUNTER_STATE.IDLE,
  running: false,
  consecutiveFailures: 0,
  totalInStockHits: 0,
  totalOrdered: 0,
  totalDelivered: 0,
  pendingDeliveries: 0,
  failedDeliveries: 0,
  budgetBlock: KSK_HUNTER_BUDGET_BLOCK.NONE,
  budgetBlockedChannels: []
};
class KskHunterManager {
  constructor(deps) {
    this.deps = deps;
  }
  timer = null;
  deliveryTimer = null;
  stopped = true;
  roundPromise = null;
  /** 正在请求中的链接 id，用于单链接防重入。 */
  inFlightLinks = /* @__PURE__ */ new Set();
  /** 正在推送中的记录 id，防止定时器与手动重试重复推。 */
  inFlightDeliveries = /* @__PURE__ */ new Set();
  linkRuntime = /* @__PURE__ */ new Map();
  /** 熔断发生在哪一天（本地日期键）。跨天后据此解除熔断，不需要额外定时器。 */
  budgetBlockDate = null;
  balanceCache = new HunterBalanceCache();
  /**
   * 已记过 blocked 事件的「日期|链接|原因」。
   *
   * 预算拦单会在每一轮（3 秒）重复触发，逐次记会把事件流刷爆且报表失真——
   * 用户想知道的是「今天这个渠道被拦过」，不是「被拦了 28800 次」。
   */
  loggedBlocks = /* @__PURE__ */ new Set();
  status = { ...EMPTY_STATUS };
  /**
   * 记一条报表事件。
   *
   * 刻意吞掉写盘错误：报表是观测数据，磁盘满了也不该让抢号主流程失败。
   */
  recordReportEvent(type, link, extra = {}) {
    const append = this.deps.appendReportEvent ?? appendHunterReportEvent;
    void append({
      at: Date.now(),
      type,
      channel: link.channel,
      linkId: link.id,
      linkName: link.name,
      ...extra
    }).catch((error) => {
      this.log(`报表事件写入失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }
  /** 当前报表。days 省略时用共享层的默认窗口。 */
  async report(days, store2) {
    const source = store2 ?? await this.deps.readStore();
    const read = this.deps.readReportEvents ?? loadHunterReportEvents;
    return summarizeHunterReport({
      events: await read(),
      billing: source.config.billing,
      days
    });
  }
  /** 单号台账报表：成本、存活时长、下游消耗。 */
  async ledgerReport(days, sort) {
    const read = this.deps.readLedger ?? loadKskLedger;
    const groupNames = await this.deps.readGroupNames?.();
    return summarizeKskLedger({ entries: await read(), days, sort, groupNames });
  }
  /**
   * 记一笔采购到台账。
   *
   * 吞掉写盘错误的理由同 recordReportEvent：台账是观测数据，磁盘满了也不该
   * 让「号已经买到了」这条主流程失败。
   */
  recordLedgerPurchase(entry) {
    const record = this.deps.recordLedgerPurchase ?? recordKskLedgerPurchase;
    void record(entry).catch((error) => {
      this.log(`台账写入失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }
  /**
   * 记一条交付到对账账本。
   *
   * 只在推送下游**成功**后调：这份账本的语义就是「交给下游的号」，是收款依据。
   * 验活判死与推送失败已由报表与台账覆盖，混进来会让对账多收钱。
   *
   * 吞掉写盘错误的理由同上：号已经交出去了，磁盘满了也不该让这条主流程失败。
   * 但这里的失败比另外两处严重（丢的是收款依据），所以日志写明要人工核对。
   */
  recordDownstreamDelivery(delivery, store2, attempts) {
    const record = this.deps.recordDownstreamDelivery ?? recordDownstreamDelivery;
    const link = deliveryReportLink(delivery, store2);
    void record({
      id: delivery.id,
      accountId: delivery.accountId,
      key: delivery.key,
      maskedKey: maskKiroApiKey(delivery.key),
      region: delivery.region,
      channel: link.channel,
      linkId: delivery.linkId,
      linkName: link.name,
      groupId: delivery.groupId,
      purchasedAt: delivery.createdAt,
      deliveredAt: Date.now(),
      attempts,
      costUnit: delivery.costUnit,
      costCny: delivery.costCny,
      unitLabel: delivery.unitLabel
    }).catch((error) => {
      this.log(
        `交付账本写入失败（${maskKiroApiKey(delivery.key)} 已交付但未记账，需人工核对）：${error instanceof Error ? error.message : String(error)}`
      );
    });
  }
  snapshotStatus() {
    return { ...this.status };
  }
  linkRuntimeOf(linkId) {
    return this.linkRuntime.get(linkId) ?? { lastInStock: false };
  }
  async start() {
    this.stopped = false;
    const store2 = await this.deps.readStore();
    await this.refreshDeliveryCounters(store2);
    if (store2.links.some((link) => link.enabled)) this.scheduleNext(0);
    else this.status = { ...this.status, state: KSK_HUNTER_STATE.IDLE, running: false };
    this.scheduleDeliveryDrain(0);
    this.deps.notifySnapshot();
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.deliveryTimer) clearTimeout(this.deliveryTimer);
    this.deliveryTimer = null;
    this.status = { ...this.status, running: false, nextRunAt: void 0 };
  }
  /** 配置或链接变更后重建调度。 */
  async reload() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const store2 = await this.deps.readStore();
    const liveIds = new Set(store2.links.map((link) => link.id));
    for (const linkId of [...this.linkRuntime.keys()]) {
      if (!liveIds.has(linkId)) this.linkRuntime.delete(linkId);
    }
    await this.start();
  }
  /** 立即跑一轮，忽略定时器节奏。 */
  async runNow() {
    this.stopped = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.runRound();
    return this.snapshotStatus();
  }
  /** 手动重试一条推送记录。 */
  async retryDelivery(deliveryId) {
    const store2 = await this.deps.readStore();
    const delivery = store2.deliveries.find((item) => item.id === deliveryId);
    if (!delivery) throw new Error("记录不存在或已删除");
    if (delivery.state === KSK_HUNTER_DELIVERY_STATE.DELIVERED) {
      throw new Error("该记录已交付，无需重试");
    }
    await patchKskHunterDelivery(deliveryId, {
      state: KSK_HUNTER_DELIVERY_STATE.PENDING,
      attempts: 0,
      nextAttemptAt: void 0,
      lastError: void 0
    });
    this.scheduleDeliveryDrain(0);
  }
  scheduleNext(delayMs) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.status = { ...this.status, nextRunAt: Date.now() + delayMs };
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runRound();
    }, delayMs);
  }
  runRound() {
    if (this.roundPromise) return this.roundPromise;
    this.roundPromise = this.executeRound().finally(() => {
      this.roundPromise = null;
    });
    return this.roundPromise;
  }
  async executeRound() {
    this.status = {
      ...this.status,
      state: KSK_HUNTER_STATE.RUNNING,
      running: true,
      lastRoundAt: Date.now(),
      nextRunAt: void 0,
      // 余额不足是每轮重新判定的（充值后应立刻恢复），所以每轮先清掉；
      // 预算类熔断按天锁定，由 refreshDeliveryCounters 保留。
      budgetBlock: this.status.budgetBlock === KSK_HUNTER_BUDGET_BLOCK.BALANCE ? KSK_HUNTER_BUDGET_BLOCK.NONE : this.status.budgetBlock
    };
    try {
      const store2 = await this.deps.readStore();
      const activeLinks = store2.links.filter((link) => link.enabled && link.secrets.listUrl);
      if (activeLinks.length === 0) {
        this.status = { ...this.status, state: KSK_HUNTER_STATE.IDLE, running: false };
        return;
      }
      const results = await Promise.all(activeLinks.map((link) => this.checkLink(link, store2)));
      const failedCount = results.filter((ok) => !ok).length;
      this.status = {
        ...this.status,
        state: failedCount > 0 ? KSK_HUNTER_STATE.DEGRADED : KSK_HUNTER_STATE.HEALTHY,
        running: false,
        consecutiveFailures: failedCount === activeLinks.length ? this.status.consecutiveFailures + 1 : 0,
        lastError: failedCount > 0 ? `${failedCount} 个链接本轮查询失败` : void 0
      };
      await this.refreshDeliveryCounters();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.status = {
        ...this.status,
        state: KSK_HUNTER_STATE.DEGRADED,
        running: false,
        lastError: message,
        consecutiveFailures: this.status.consecutiveFailures + 1
      };
      this.log(`轮询失败：${message}`);
    } finally {
      this.deps.notifySnapshot();
      if (!this.stopped) this.scheduleNext(KSK_HUNTER_POLL_INTERVAL_SECONDS * 1e3);
    }
  }
  /** 查一条链接。返回 false 表示本轮该链接失败。 */
  async checkLink(link, store2) {
    if (this.inFlightLinks.has(link.id)) return true;
    const minIntervalMs = KSK_HUNTER_CHANNEL_MIN_INTERVAL_SECONDS[link.channel] * 1e3;
    if (minIntervalMs > KSK_HUNTER_POLL_INTERVAL_SECONDS * 1e3) {
      const lastCheckedAt = this.linkRuntimeOf(link.id).lastCheckedAt;
      if (lastCheckedAt !== void 0 && Date.now() - lastCheckedAt < minIntervalMs) return true;
    }
    const apiKey = this.channelApiKey(link.channel, store2);
    if (KSK_HUNTER_CHANNEL_REQUIRES_API_KEY[link.channel] && !apiKey) {
      this.linkRuntime.set(link.id, {
        ...this.linkRuntimeOf(link.id),
        lastInStock: false,
        lastError: `${KSK_HUNTER_CHANNEL_LABEL[link.channel]} 渠道需要在设置里填写 API Key`
      });
      return false;
    }
    this.inFlightLinks.add(link.id);
    try {
      const payload = await this.fetchJson(
        link.secrets.listUrl,
        store2.config.requestTimeoutSeconds,
        { method: "GET", apiKey }
      );
      const offers = parseChannelOffers(link.channel, payload).filter(
        (offer) => offer.stock > 0 && matchesHunterRegions(link.regions, offer.region)
      );
      const wasInStock = this.linkRuntimeOf(link.id).lastInStock;
      this.linkRuntime.set(link.id, {
        ...this.linkRuntimeOf(link.id),
        lastInStock: offers.length > 0,
        lastCheckedAt: Date.now(),
        lastError: void 0
      });
      if (offers.length > 0 && !wasInStock) {
        this.recordReportEvent(HUNTER_REPORT_EVENT.RESTOCK, link, {
          offerCount: offers.length,
          region: offers[0].region || void 0
        });
      }
      if (offers.length === 0) return true;
      this.status = {
        ...this.status,
        totalInStockHits: this.status.totalInStockHits + offers.length
      };
      await this.handleInStock(link, offers, store2);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.linkRuntime.set(link.id, {
        ...this.linkRuntimeOf(link.id),
        lastInStock: false,
        lastCheckedAt: Date.now(),
        lastError: message
      });
      this.log(`链接“${link.name}”查询失败：${message}`);
      return false;
    } finally {
      this.inFlightLinks.delete(link.id);
    }
  }
  async handleInStock(link, offers, store2) {
    const shouldNotify = link.mode === KSK_HUNTER_MODE.NOTIFY || store2.config.notifyOnAutoOrder;
    if (shouldNotify) {
      for (const offer of offers) {
        this.deps.notifyInStock({
          linkName: link.name,
          title: offer.title || link.name,
          region: offer.region
        });
      }
    }
    if (link.mode !== KSK_HUNTER_MODE.AUTO_ORDER) return;
    if (!link.secrets.orderUrl) {
      this.linkRuntime.set(link.id, {
        ...this.linkRuntimeOf(link.id),
        lastError: "该链接为自动下单模式但未配置下单地址"
      });
      return;
    }
    const spend = summarizeHunterSpend(toKskHunterSpendEntries(store2), store2.config);
    const balanceUnit = await this.resolveBalanceUnit(link.channel, store2);
    const budget = evaluateHunterBudget({
      channel: link.channel,
      priceUnit: offers[0].price,
      config: store2.config,
      spend,
      balanceUnit
    });
    if (!budget.allowed) {
      this.applyBudgetBlock(link, budget.reason, spend, store2, balanceUnit);
      return;
    }
    if (store2.config.downstreamEnabled) {
      const needs = await askDownstreamNeedsAccount({
        baseUrl: store2.config.downstreamBaseUrl,
        apiKey: store2.secrets.downstreamApiKey,
        timeoutSeconds: store2.config.requestTimeoutSeconds,
        fetchImpl: this.deps.downstreamFetchImpl ?? this.deps.fetchImpl
      });
      if (!needs) return;
    }
    await this.orderOne(link, offers[0], store2, budget);
  }
  /**
   * 取该渠道余额；未启用检查、未配地址或查询失败时返回 undefined。
   *
   * 查不到就返回 undefined（等于「不按余额拦」）：站点余额接口抖一下就把抢号
   * 整个停掉，代价比偶尔白跑一次下单请求大得多。
   */
  async resolveBalanceUnit(channel, store2) {
    if (!store2.config.balanceCheckEnabled) return void 0;
    const url = store2.secrets.balanceUrls?.[channel];
    if (!url) return void 0;
    const snapshot = await this.balanceCache.resolve({
      channel,
      url,
      timeoutSeconds: store2.config.requestTimeoutSeconds,
      fetchImpl: this.deps.fetchImpl,
      apiKey: this.channelApiKey(channel, store2)
    });
    if (snapshot.error) {
      this.log(`渠道 ${channel} 余额查询失败：${snapshot.error}`);
      return void 0;
    }
    const billing = store2.config.billing[channel];
    const threshold = billing?.lowBalanceThresholdUnit ?? 0;
    if (snapshot.amountUnit !== void 0 && threshold > 0 && snapshot.amountUnit < threshold) {
      this.deps.notifyLowBalance?.({
        channel,
        balanceUnit: snapshot.amountUnit,
        thresholdUnit: threshold,
        unitLabel: billing?.unitLabel ?? ""
      });
    }
    return snapshot.amountUnit;
  }
  /** 各渠道余额快照，供 IPC 组装 UI 展示。 */
  channelBalances(store2) {
    return Object.values(KSK_HUNTER_CHANNEL).map((channel) => {
      const billing = store2.config.billing[channel] ?? DEFAULT_KSK_HUNTER_CHANNEL_BILLING;
      const cached = this.balanceCache.peek(channel);
      const threshold = billing.lowBalanceThresholdUnit;
      return {
        channel,
        amountUnit: cached?.amountUnit,
        unitLabel: billing.unitLabel,
        amountCny: cached?.amountUnit === void 0 ? void 0 : hunterUnitToCny(cached.amountUnit, billing.cnyPerUnit),
        lowThresholdUnit: threshold,
        isLow: cached?.amountUnit !== void 0 && threshold > 0 && cached.amountUnit < threshold,
        checkedAt: cached?.checkedAt,
        error: cached?.error
      };
    });
  }
  /**
   * 同一天、同一链接、同一原因的拦单只记一条报表事件。
   *
   * 去重键带日期，所以跨天会自然重新记一次，不需要在跨天时清理这个集合。
   */
  recordBlockOnce(link, reason, date) {
    const dedupeKey = `${date}|${link.id}|${reason}`;
    if (this.loggedBlocks.has(dedupeKey)) return;
    this.loggedBlocks.add(dedupeKey);
    this.recordReportEvent(HUNTER_REPORT_EVENT.BLOCKED, link, { reason });
  }
  /** 记录熔断状态并提醒一次；通知去重由 LocalNotificationService 负责。 */
  applyBudgetBlock(link, reason, spend, store2, balanceUnit) {
    const billing = store2.config.billing[link.channel] ?? DEFAULT_KSK_HUNTER_CHANNEL_BILLING;
    this.recordBlockOnce(link, reason, spend.date);
    if (reason === KSK_HUNTER_BUDGET_BLOCK.UNKNOWN_PRICE) {
      this.linkRuntime.set(link.id, {
        ...this.linkRuntimeOf(link.id),
        lastError: "商品未提供价格，已按设置跳过自动下单（可在配置里允许未知价格下单）"
      });
      return;
    }
    if (reason === KSK_HUNTER_BUDGET_BLOCK.BALANCE) {
      this.linkRuntime.set(link.id, {
        ...this.linkRuntimeOf(link.id),
        lastError: `余额不足（剩 ${balanceUnit ?? 0} ${billing.unitLabel}），已跳过自动下单；充值后自动恢复`
      });
      this.status = { ...this.status, budgetBlock: KSK_HUNTER_BUDGET_BLOCK.BALANCE };
      this.log(
        `渠道 ${link.channel} 余额不足（${balanceUnit ?? 0} ${billing.unitLabel}），跳过下单`
      );
      return;
    }
    this.status = {
      ...this.status,
      budgetBlock: reason,
      budgetBlockedChannels: exhaustedHunterChannels(spend)
    };
    this.budgetBlockDate = spend.date;
    const isGlobal = reason === KSK_HUNTER_BUDGET_BLOCK.GLOBAL;
    const channelSpend = spend.byChannel.find((item) => item.channel === link.channel);
    const spentCny = isGlobal ? spend.totalCny : channelSpend?.amountUnit ?? 0;
    const limitCny = isGlobal ? spend.dailyLimitCny : billing.dailyLimitUnit;
    const unit = isGlobal ? "¥" : "";
    const suffix = isGlobal ? "" : ` ${billing.unitLabel}`;
    this.linkRuntime.set(link.id, {
      ...this.linkRuntimeOf(link.id),
      lastError: `${isGlobal ? "全局" : "该渠道"}当日预算已用尽（${unit}${spentCny}${suffix} / ${unit}${limitCny}${suffix}），已暂停自动下单，仍会提醒`
    });
    this.log(
      `${isGlobal ? "全局" : link.channel} 当日预算用尽（${spentCny}/${limitCny}），暂停自动下单`
    );
    this.deps.notifyBudgetExhausted?.({
      scope: isGlobal ? "global" : "channel",
      channelLabel: isGlobal ? void 0 : link.name,
      spentCny,
      limitCny
    });
  }
  async orderOne(link, offer, store2, budget) {
    const idempotencyKey = this.resolveIdempotencyKey(link.id, offer.goodsId);
    const orderPayload = await this.fetchJson(
      link.secrets.orderUrl,
      store2.config.requestTimeoutSeconds,
      {
        method: "POST",
        body: buildOrderRequestBody(link.channel, offer, { idempotencyKey }),
        apiKey: this.channelApiKey(link.channel, store2)
      }
    );
    this.clearIdempotencyKey(link.id);
    const credential = parseOrderedCredential(orderPayload, offer.region);
    if (!isUsableHunterCredential(credential)) {
      throw new Error("下单返回的 KSK 或区域不合法");
    }
    this.status = { ...this.status, totalOrdered: this.status.totalOrdered + 1 };
    this.balanceCache.invalidate(link.channel);
    const maskedKey = maskKiroApiKey(credential.key);
    const unitLabel = store2.config.billing[link.channel]?.unitLabel;
    const now = Date.now();
    const delivery = {
      id: node_crypto.randomUUID(),
      linkId: link.id,
      linkName: link.name,
      channel: link.channel,
      key: credential.key,
      region: credential.region,
      // 对账要按分组汇总，而配置里的 targetGroupId 随时会改，推送时回读可能已经不是这个
      groupId: store2.config.targetGroupId,
      state: KSK_HUNTER_DELIVERY_STATE.PENDING,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      costUnit: budget.costUnit,
      costCny: budget.costCny,
      unitLabel
    };
    await appendKskHunterDelivery(delivery);
    await appendKskHunterSpend({
      id: node_crypto.randomUUID(),
      channel: link.channel,
      amountUnit: budget.costUnit ?? 0,
      amountCny: budget.costCny,
      at: now
    });
    this.recordReportEvent(HUNTER_REPORT_EVENT.ORDERED, link, {
      region: credential.region,
      costUnit: budget.costUnit,
      costCny: budget.costCny,
      unitLabel
    });
    if (store2.config.notifyOnAutoOrder) {
      this.deps.notifyOrdered({ linkName: link.name, maskedKey, region: credential.region });
    }
    const purchase = {
      maskedKey,
      region: credential.region,
      channel: link.channel,
      linkId: link.id,
      linkName: link.name,
      // 抢到的号会落进这个分组；不同分组通常对应不同下游，报表按它汇总
      groupId: store2.config.targetGroupId,
      purchasedAt: now,
      costUnit: budget.costUnit,
      costCny: budget.costCny,
      unitLabel
    };
    try {
      const result = await this.deps.importCredential({
        ...credential,
        groupId: store2.config.targetGroupId
      });
      if (result.added) this.deps.notifyAccountsChanged();
      if (result.accountId) {
        await patchKskHunterDelivery(delivery.id, { accountId: result.accountId });
      }
      if (result.accountId) {
        this.recordLedgerPurchase({
          ...purchase,
          accountId: result.accountId,
          baselineUsage: result.usageCurrent,
          currentUsage: result.usageCurrent,
          usageLimit: result.usageLimit,
          carriedCredits: 0,
          usedCredits: 0
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await patchKskHunterDelivery(delivery.id, {
        state: KSK_HUNTER_DELIVERY_STATE.DEAD_KEY,
        lastError: `验活失败：${message}`
      });
      this.recordReportEvent(HUNTER_REPORT_EVENT.DEAD_KEY, link, { region: credential.region });
      this.recordLedgerPurchase({
        ...purchase,
        accountId: `dead:${delivery.id}`,
        retiredAt: Date.now(),
        retireReason: KSK_LEDGER_RETIRE_REASON.INVALID,
        carriedCredits: 0,
        usedCredits: 0
      });
      this.log(`已购 ${maskedKey} 验活失败，不推送下游：${message}`);
      await this.refreshDeliveryCounters();
      return;
    }
    this.scheduleDeliveryDrain(0);
  }
  /**
   * 取（或生成）这条链接当前的下单幂等键。
   *
   * 32 位十六进制：Kiro CEO 要求这个格式，randomUUID() 带横线共 36 位，过不了它的校验。
   *
   * 键在**下单请求成功之前**一直保留，超时或 5xx 重试时复用同一个——服务端会把它识别成
   * 同一笔订单原样返回，不会重复扣费、重复发货。换 zone 则必须换键：同一个键配不同的
   * zone 会被服务端当成另一笔订单的重放，拿回来的号区域可能不是你要的。
   *
   * **只存在内存里**：进程重启后重试会变成第二笔订单（一次约 50 积分）。要修得在每次
   * 下单尝试前写盘，代价与这个风险不成比例——重启恰好卡在下单请求中间才会碰上。
   */
  resolveIdempotencyKey(linkId, goodsId) {
    const pending = this.linkRuntimeOf(linkId).pendingOrder;
    if (pending && pending.goodsId === goodsId) return pending.key;
    const key = node_crypto.randomBytes(16).toString("hex");
    this.linkRuntime.set(linkId, {
      ...this.linkRuntimeOf(linkId),
      pendingOrder: { goodsId, key }
    });
    return key;
  }
  clearIdempotencyKey(linkId) {
    const runtime = this.linkRuntimeOf(linkId);
    if (!runtime.pendingOrder) return;
    this.linkRuntime.set(linkId, { ...runtime, pendingOrder: void 0 });
  }
  /** 该渠道的请求头密钥；未配置或不需要时为 undefined。 */
  channelApiKey(channel, store2) {
    if (!KSK_HUNTER_CHANNEL_REQUIRES_API_KEY[channel]) return void 0;
    return store2.secrets.apiKeys?.[channel] || void 0;
  }
  async fetchJson(url, timeoutSeconds, init = { method: "GET" }) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error("商品站点接口必须使用 HTTPS");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(3, timeoutSeconds) * 1e3);
    try {
      const response = await this.deps.fetchImpl(parsed.toString(), {
        method: init.method,
        headers: {
          Accept: "application/json",
          ...init.body === void 0 ? {} : { "Content-Type": "application/json" },
          ...init.apiKey ? { [KSK_HUNTER_CHANNEL_AUTH_HEADER]: init.apiKey } : {}
        },
        body: init.body === void 0 ? void 0 : JSON.stringify(init.body),
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`请求失败: HTTP ${response.status}`);
      return text ? JSON.parse(text) : {};
    } finally {
      clearTimeout(timer);
    }
  }
  scheduleDeliveryDrain(delayMs) {
    if (this.stopped) return;
    if (this.deliveryTimer) clearTimeout(this.deliveryTimer);
    this.deliveryTimer = setTimeout(() => {
      this.deliveryTimer = null;
      void this.drainDeliveries();
    }, delayMs);
  }
  /** 推送所有到期的待交付记录，然后按最近的下次重试时间重新排班。 */
  async drainDeliveries() {
    try {
      const store2 = await this.deps.readStore();
      if (!store2.config.downstreamEnabled) {
        await this.refreshDeliveryCounters(store2);
        return;
      }
      const now = Date.now();
      const due = store2.deliveries.filter(
        (delivery) => delivery.state === KSK_HUNTER_DELIVERY_STATE.PENDING && (delivery.nextAttemptAt ?? 0) <= now && !this.inFlightDeliveries.has(delivery.id)
      );
      for (const delivery of due) await this.deliverOne(delivery, store2);
      await this.refreshDeliveryCounters();
    } catch (error) {
      this.log(`推送队列处理失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.deps.notifySnapshot();
      await this.rescheduleDeliveryDrain();
    }
  }
  async deliverOne(delivery, store2) {
    this.inFlightDeliveries.add(delivery.id);
    const attempts = delivery.attempts + 1;
    try {
      await pushKskToDownstream(
        {
          baseUrl: store2.config.downstreamBaseUrl,
          apiKey: store2.secrets.downstreamApiKey,
          timeoutSeconds: store2.config.requestTimeoutSeconds,
          fetchImpl: this.deps.downstreamFetchImpl ?? this.deps.fetchImpl
        },
        { key: delivery.key, region: delivery.region }
      );
      await patchKskHunterDelivery(delivery.id, {
        state: KSK_HUNTER_DELIVERY_STATE.DELIVERED,
        attempts,
        nextAttemptAt: void 0,
        lastError: void 0
      });
      this.recordReportEvent(HUNTER_REPORT_EVENT.DELIVERED, deliveryReportLink(delivery, store2), {
        region: delivery.region || void 0
      });
      this.recordDownstreamDelivery(delivery, store2, attempts);
      this.status = { ...this.status, totalDelivered: this.status.totalDelivered + 1 };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const exhausted = attempts >= KSK_HUNTER_DELIVERY_MAX_ATTEMPTS;
      await patchKskHunterDelivery(delivery.id, {
        state: exhausted ? KSK_HUNTER_DELIVERY_STATE.FAILED : KSK_HUNTER_DELIVERY_STATE.PENDING,
        attempts,
        nextAttemptAt: exhausted ? void 0 : Date.now() + hunterRetryDelayMs(attempts),
        lastError: message
      });
      if (exhausted) {
        this.recordReportEvent(
          HUNTER_REPORT_EVENT.DELIVERY_FAILED,
          deliveryReportLink(delivery, store2),
          { region: delivery.region || void 0 }
        );
      }
      this.log(
        `推送 ${maskKiroApiKey(delivery.key)} 失败（第 ${attempts} 次）：${message}` + (exhausted ? " · 重试已耗尽，需人工处理" : "")
      );
    } finally {
      this.inFlightDeliveries.delete(delivery.id);
    }
  }
  /** 按队列里最近的一个 nextAttemptAt 排下一次 drain。 */
  async rescheduleDeliveryDrain() {
    if (this.stopped) return;
    const store2 = await this.deps.readStore();
    const pendingTimes = store2.deliveries.filter((delivery) => delivery.state === KSK_HUNTER_DELIVERY_STATE.PENDING).map((delivery) => delivery.nextAttemptAt ?? Date.now());
    if (pendingTimes.length === 0) return;
    const nextAt = Math.min(...pendingTimes);
    this.scheduleDeliveryDrain(Math.max(0, nextAt - Date.now()));
  }
  async refreshDeliveryCounters(store2) {
    const source = store2 ?? await this.deps.readStore();
    const spend = summarizeHunterSpend(toKskHunterSpendEntries(source), source.config);
    const globalExhausted = spend.dailyLimitCny > 0 && spend.totalCny >= spend.dailyLimitCny;
    const exhaustedChannels = exhaustedHunterChannels(spend);
    const dateChanged = this.budgetBlockDate !== null && this.budgetBlockDate !== spend.date;
    const isBalanceBlock = this.status.budgetBlock === KSK_HUNTER_BUDGET_BLOCK.BALANCE;
    const keepBlock = !dateChanged && this.status.budgetBlock !== KSK_HUNTER_BUDGET_BLOCK.NONE && (isBalanceBlock || this.budgetBlockDate !== null);
    const blockedChannels = keepBlock ? [.../* @__PURE__ */ new Set([...this.status.budgetBlockedChannels, ...exhaustedChannels])] : exhaustedChannels;
    const budgetBlock = globalExhausted ? KSK_HUNTER_BUDGET_BLOCK.GLOBAL : keepBlock ? this.status.budgetBlock : blockedChannels.length > 0 ? KSK_HUNTER_BUDGET_BLOCK.CHANNEL : KSK_HUNTER_BUDGET_BLOCK.NONE;
    if (budgetBlock === KSK_HUNTER_BUDGET_BLOCK.NONE) this.budgetBlockDate = null;
    this.status = {
      ...this.status,
      pendingDeliveries: source.deliveries.filter(
        (delivery) => delivery.state === KSK_HUNTER_DELIVERY_STATE.PENDING
      ).length,
      failedDeliveries: source.deliveries.filter(
        (delivery) => delivery.state === KSK_HUNTER_DELIVERY_STATE.FAILED || delivery.state === KSK_HUNTER_DELIVERY_STATE.DEAD_KEY
      ).length,
      budgetBlock,
      budgetBlockedChannels: blockedChannels
    };
  }
  /** 当前账本的当日统计，供 IPC 组装快照。 */
  async spendSummary(store2) {
    const source = store2 ?? await this.deps.readStore();
    return summarizeHunterSpend(toKskHunterSpendEntries(source), source.config);
  }
  log(message) {
    (this.deps.log ?? ((text) => console.log(text)))(`[KskHunter] ${message}`);
  }
}
function buildKskHunterSnapshotParts(store2, manager) {
  return {
    links: store2.links.map((link) => toKskHunterLinkView(link, manager.linkRuntimeOf(link.id))),
    deliveries: [...store2.deliveries].sort((a, b) => b.createdAt - a.createdAt).map(toKskHunterDeliveryView)
  };
}
const KSK_HUNTER_CHANNEL_NAME = {
  snapshot: "ksk-hunter-snapshot",
  updateConfig: "ksk-hunter-update-config",
  createLink: "ksk-hunter-create-link",
  updateLink: "ksk-hunter-update-link",
  setLinkEnabled: "ksk-hunter-set-link-enabled",
  deleteLink: "ksk-hunter-delete-link",
  runNow: "ksk-hunter-run-now",
  retryDelivery: "ksk-hunter-retry-delivery",
  deleteDelivery: "ksk-hunter-delete-delivery",
  report: "ksk-hunter-report",
  revealReportFile: "ksk-hunter-reveal-report-file",
  ledgerReport: "ksk-hunter-ledger-report",
  clearLedger: "ksk-hunter-clear-ledger",
  revealLedgerFile: "ksk-hunter-reveal-ledger-file",
  statusEvent: "ksk-hunter-status-changed"
};
function toError$1(error) {
  return { success: false, error: error instanceof Error ? error.message : String(error) };
}
async function buildSnapshot(manager) {
  const store2 = await loadKskHunterStore();
  const { links, deliveries } = buildKskHunterSnapshotParts(store2, manager);
  return {
    config: toKskHunterConfigView(store2),
    links,
    status: manager.snapshotStatus(),
    deliveries,
    spend: await manager.spendSummary(store2),
    balances: manager.channelBalances(store2)
  };
}
async function sendKskHunterStatus(getMainWindow, manager) {
  const win2 = getMainWindow();
  if (!win2 || win2.isDestroyed()) return;
  const store2 = await loadKskHunterStore();
  const { links, deliveries } = buildKskHunterSnapshotParts(store2, manager);
  const event = {
    status: manager.snapshotStatus(),
    links,
    deliveries,
    spend: await manager.spendSummary(store2),
    balances: manager.channelBalances(store2)
  };
  win2.webContents.send(KSK_HUNTER_CHANNEL_NAME.statusEvent, event);
}
function validateLinkInput(input, hasExistingOrderUrl) {
  if (!input.name.trim()) throw new Error("请输入链接名称");
  const listUrl = input.listUrl?.trim();
  if (listUrl) {
    const parsed = new URL(listUrl);
    if (parsed.protocol !== "https:") throw new Error("商品列表地址必须使用 HTTPS");
  }
  const orderUrl = input.orderUrl?.trim();
  if (orderUrl) {
    const parsed = new URL(orderUrl);
    if (parsed.protocol !== "https:") throw new Error("下单地址必须使用 HTTPS");
  }
  if (input.mode === KSK_HUNTER_MODE.AUTO_ORDER && !orderUrl && !hasExistingOrderUrl) {
    throw new Error("自动下单模式必须配置下单地址");
  }
}
function validateConfig(config, secrets, hasExistingApiKey) {
  for (const url of Object.values(secrets?.balanceUrls ?? {})) {
    const trimmed = url?.trim();
    if (!trimmed) continue;
    if (new URL(trimmed).protocol !== "https:") {
      throw new Error("余额查询地址必须使用 HTTPS");
    }
  }
  if (!config.downstreamEnabled) return;
  const baseUrl = config.downstreamBaseUrl?.trim();
  if (!baseUrl) throw new Error("开启下游推送前请填写下游地址");
  resolveDownstreamBase(baseUrl);
  const apiKey = secrets?.downstreamApiKey;
  const willHaveKey = apiKey === void 0 ? hasExistingApiKey : Boolean(apiKey.trim());
  if (!willHaveKey) throw new Error("开启下游推送前请填写下游 API Key");
}
function registerKskHunterIpcHandlers(deps) {
  const respondSnapshot = async () => ({
    success: true,
    data: await buildSnapshot(deps.getManager())
  });
  electron.ipcMain.handle(KSK_HUNTER_CHANNEL_NAME.snapshot, async () => {
    try {
      return await respondSnapshot();
    } catch (error) {
      return toError$1(error);
    }
  });
  electron.ipcMain.handle(
    KSK_HUNTER_CHANNEL_NAME.updateConfig,
    async (_event, config, secrets) => {
      try {
        if (!isKskHunterStoreAvailable()) throw new Error("系统加密存储不可用");
        const current = await loadKskHunterStore();
        validateConfig(
          { ...current.config, ...config },
          secrets,
          Boolean(current.secrets.downstreamApiKey)
        );
        await updateKskHunterConfig(config, secrets);
        await deps.getManager().reload();
        return await respondSnapshot();
      } catch (error) {
        return toError$1(error);
      }
    }
  );
  electron.ipcMain.handle(KSK_HUNTER_CHANNEL_NAME.createLink, async (_event, input) => {
    try {
      if (!isKskHunterStoreAvailable()) throw new Error("系统加密存储不可用");
      if (!input.listUrl?.trim()) throw new Error("请填写商品列表地址");
      validateLinkInput(input, false);
      await createKskHunterLink(node_crypto.randomUUID(), input);
      await deps.getManager().reload();
      return await respondSnapshot();
    } catch (error) {
      return toError$1(error);
    }
  });
  electron.ipcMain.handle(
    KSK_HUNTER_CHANNEL_NAME.updateLink,
    async (_event, linkId, input) => {
      try {
        const current = await loadKskHunterStore();
        const link = current.links.find((item) => item.id === linkId);
        if (!link) throw new Error("链接不存在或已删除");
        if (input.listUrl !== void 0 && !input.listUrl.trim() && !link.secrets.listUrl) {
          throw new Error("请填写商品列表地址");
        }
        validateLinkInput(input, Boolean(link.secrets.orderUrl));
        await updateKskHunterLink(linkId, input);
        await deps.getManager().reload();
        return await respondSnapshot();
      } catch (error) {
        return toError$1(error);
      }
    }
  );
  electron.ipcMain.handle(
    KSK_HUNTER_CHANNEL_NAME.setLinkEnabled,
    async (_event, linkId, enabled) => {
      try {
        await setKskHunterLinkEnabled(linkId, enabled);
        await deps.getManager().reload();
        return await respondSnapshot();
      } catch (error) {
        return toError$1(error);
      }
    }
  );
  electron.ipcMain.handle(KSK_HUNTER_CHANNEL_NAME.deleteLink, async (_event, linkId) => {
    try {
      await deleteKskHunterLink(linkId);
      await deps.getManager().reload();
      return await respondSnapshot();
    } catch (error) {
      return toError$1(error);
    }
  });
  electron.ipcMain.handle(KSK_HUNTER_CHANNEL_NAME.runNow, async () => {
    try {
      await deps.getManager().runNow();
      return await respondSnapshot();
    } catch (error) {
      return toError$1(error);
    }
  });
  electron.ipcMain.handle(KSK_HUNTER_CHANNEL_NAME.retryDelivery, async (_event, deliveryId) => {
    try {
      await deps.getManager().retryDelivery(deliveryId);
      return await respondSnapshot();
    } catch (error) {
      return toError$1(error);
    }
  });
  electron.ipcMain.handle(KSK_HUNTER_CHANNEL_NAME.deleteDelivery, async (_event, deliveryId) => {
    try {
      await deleteKskHunterDelivery(deliveryId);
      return await respondSnapshot();
    } catch (error) {
      return toError$1(error);
    }
  });
  electron.ipcMain.handle(
    KSK_HUNTER_CHANNEL_NAME.report,
    async (_event, days) => {
      try {
        return { success: true, data: await deps.getManager().report(days) };
      } catch (error) {
        return toError$1(error);
      }
    }
  );
  electron.ipcMain.handle(KSK_HUNTER_CHANNEL_NAME.revealReportFile, async () => {
    try {
      const path2 = hunterReportStorePath();
      await node_fs.promises.access(path2);
      electron.shell.showItemInFolder(path2);
      return { success: true, data: path2 };
    } catch {
      return { success: false, error: "报表历史文件还不存在，抢号产生第一条记录后才会生成" };
    }
  });
  electron.ipcMain.handle(
    KSK_HUNTER_CHANNEL_NAME.ledgerReport,
    async (_event, days, sort) => {
      try {
        return { success: true, data: await deps.getManager().ledgerReport(days, sort) };
      } catch (error) {
        return toError$1(error);
      }
    }
  );
  electron.ipcMain.handle(
    KSK_HUNTER_CHANNEL_NAME.clearLedger,
    async () => {
      try {
        await clearKskLedger();
        return { success: true, data: await deps.getManager().ledgerReport() };
      } catch (error) {
        return toError$1(error);
      }
    }
  );
  electron.ipcMain.handle(KSK_HUNTER_CHANNEL_NAME.revealLedgerFile, async () => {
    try {
      const path2 = kskLedgerStorePath();
      await node_fs.promises.access(path2);
      electron.shell.showItemInFolder(path2);
      return { success: true, data: path2 };
    } catch {
      return { success: false, error: "台账文件还不存在，抢到第一个号后才会生成" };
    }
  });
}
class DownstreamSettlementManager {
  constructor(deps) {
    this.deps = deps;
  }
  timer = null;
  stopped = true;
  tickPromise = null;
  async start() {
    this.stopped = false;
    this.scheduleNext(2e4);
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  scheduleNext(delayMs) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runTick();
    }, delayMs);
  }
  /** 并发调用合并到同一次执行，避免手动触发撞上定时 tick 重复结算。 */
  runTick() {
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = this.executeTick().finally(() => {
      this.tickPromise = null;
    });
    return this.tickPromise;
  }
  /** 立刻跑一轮结算补齐，供页面手动触发。 */
  async settleNow() {
    await this.runTick();
  }
  async executeTick() {
    try {
      const state = await loadDeliveryLedger();
      const pending = this.pendingDates(state);
      for (const date of pending) await this.settleDay(date);
      if (pending.length > 0) {
        this.log(`已结算 ${pending.length} 天：${pending.join("、")}`);
      }
    } catch (error) {
      this.log(`结算失败：${this.message(error)}`);
    } finally {
      this.scheduleNext(DOWNSTREAM_SETTLEMENT_TICK_MINUTES * 6e4);
    }
  }
  /**
   * 待结算的日期列表，从早到晚。
   *
   * 只结算**已经过去**的自然日：当天还在产生交付与消耗，定稿了数字就不再变，
   * 会漏掉当天剩下的部分。
   *
   * 起点取「最后一次结算的次日」与「最早一条交付」的较晚者。没有交付记录时
   * 返回空——没号可对账，不必凭空生成一堆空 CSV。
   */
  pendingDates(state) {
    if (state.deliveries.length === 0) return [];
    const todayStart = downstreamDayStart(Date.now());
    const earliest = Math.min(...state.deliveries.map((item) => item.deliveredAt));
    let cursor = downstreamDayStart(earliest);
    if (state.lastSettledDate) {
      const lastStart = downstreamDateKeyToStart(state.lastSettledDate);
      if (lastStart !== void 0) {
        const next = new Date(lastStart);
        next.setDate(next.getDate() + 1);
        cursor = Math.max(cursor, next.getTime());
      }
    }
    const dates = [];
    const maxDays = 400;
    while (cursor < todayStart && dates.length < maxDays) {
      dates.push(hunterLocalDateKey(cursor));
      const next = new Date(cursor);
      next.setDate(next.getDate() + 1);
      cursor = next.getTime();
    }
    if (dates.length >= maxDays) {
      this.log(`未结算的历史超过 ${maxDays} 天，只补最近 ${maxDays} 天`);
    }
    return dates;
  }
  /** CSV 导出目录。用户配了就用配的（必须是绝对路径），否则落 userData 下的子目录。 */
  async resolveCsvDir() {
    const configured = (await this.deps.readCsvDir())?.trim();
    if (configured && node_path.isAbsolute(configured)) return configured;
    return node_path.join(this.deps.userDataDir(), DOWNSTREAM_CSV_DIR_NAME);
  }
  /**
   * 导出某一天的 CSV，返回文件路径。
   *
   * 纯读，不动锚点。覆盖同名文件：同一天可能先手动导一次、午夜再自动结算一次，
   * 覆盖比生成两份带后缀的文件好——对账时不用猜哪份是准的。
   */
  async exportDay(date) {
    const state = await loadDeliveryLedger();
    const usage = await this.readUsageSafely();
    const groupNames = await this.readGroupNamesSafely();
    const report = summarizeDownstreamDay({
      deliveries: state.deliveries,
      settlements: state.settlements,
      usage,
      groupNames,
      date
    });
    const keyById = new Map(state.deliveries.map((item) => [item.id, item.key]));
    const rows = report.rows.map((row) => ({
      ...row,
      key: keyById.get(row.id) ?? ""
    }));
    const dir = await this.resolveCsvDir();
    await node_fs.promises.mkdir(dir, { recursive: true });
    const path2 = node_path.join(dir, downstreamCsvFileName(date));
    await node_fs.promises.writeFile(path2, buildDownstreamCsv(rows, date), { encoding: "utf-8", mode: 384 });
    return path2;
  }
  /**
   * 结算某一天：先导出 CSV，再落定稿并推进锚点。
   *
   * 顺序不能反。CSV 是长期存档，落定稿之前先把它写成功——反过来的话导出失败
   * 就再也导不出这一天了（锚点已推进，积分增量算不回来）。
   */
  async settleDay(date) {
    await this.exportDay(date);
    const state = await loadDeliveryLedger();
    const usage = await this.readUsageSafely();
    const now = Date.now();
    const computed = computeDownstreamSettlement({
      deliveries: state.deliveries,
      usage,
      date,
      at: now
    });
    await commitDownstreamSettlement({
      date,
      settlement: computed.settlement,
      deliveries: computed.deliveries,
      now
    });
  }
  /** 某一天的完整报表：日明细 + 按天汇总 + 导出目录。 */
  async report(input) {
    const state = await loadDeliveryLedger();
    const usage = await this.readUsageSafely();
    const groupNames = await this.readGroupNamesSafely();
    const now = Date.now();
    const days = input?.days ?? DOWNSTREAM_REPORT_WINDOW_DAYS;
    const day = summarizeDownstreamDay({
      deliveries: state.deliveries,
      settlements: state.settlements,
      usage,
      groupNames,
      date: input?.date,
      now
    });
    return {
      ...day,
      days,
      daily: summarizeDownstreamDaily({
        deliveries: state.deliveries,
        settlements: state.settlements,
        usage,
        days,
        now
      }),
      csvDir: await this.resolveCsvDir()
    };
  }
  /**
   * 台账读失败时按空处理。
   *
   * 空 usage 会让所有积分列显示「未知」而不是 0，且 `computeDownstreamSettlement`
   * 不会推进查不到的号的锚点——下一轮台账恢复后能补上，不会永久丢账。
   */
  async readUsageSafely() {
    try {
      return await this.deps.readLedgerUsage();
    } catch (error) {
      this.log(`读取台账消耗失败，本轮积分按未知处理：${this.message(error)}`);
      return {};
    }
  }
  async readGroupNamesSafely() {
    try {
      return await this.deps.readGroupNames?.() ?? {};
    } catch {
      return {};
    }
  }
  message(error) {
    return error instanceof Error ? error.message : String(error);
  }
  log(message) {
    this.deps.log?.(`[DownstreamSettlement] ${message}`);
  }
}
const DOWNSTREAM_SETTLEMENT_CHANNEL = {
  report: "downstream-settlement-report",
  exportDay: "downstream-settlement-export-day",
  settleNow: "downstream-settlement-settle-now",
  pickCsvDir: "downstream-settlement-pick-csv-dir",
  openCsvDir: "downstream-settlement-open-csv-dir"
};
function toError(error) {
  return { success: false, error: error instanceof Error ? error.message : String(error) };
}
function registerDownstreamSettlementIpcHandlers(deps) {
  electron.ipcMain.handle(
    DOWNSTREAM_SETTLEMENT_CHANNEL.report,
    async (_event, date, days) => {
      try {
        return { success: true, data: await deps.getManager().report({ date, days }) };
      } catch (error) {
        return toError(error);
      }
    }
  );
  electron.ipcMain.handle(
    DOWNSTREAM_SETTLEMENT_CHANNEL.exportDay,
    async (_event, date) => {
      try {
        return { success: true, data: await deps.getManager().exportDay(date) };
      } catch (error) {
        return toError(error);
      }
    }
  );
  electron.ipcMain.handle(
    DOWNSTREAM_SETTLEMENT_CHANNEL.settleNow,
    async () => {
      try {
        const manager = deps.getManager();
        await manager.settleNow();
        return { success: true, data: await manager.report() };
      } catch (error) {
        return toError(error);
      }
    }
  );
  electron.ipcMain.handle(
    DOWNSTREAM_SETTLEMENT_CHANNEL.pickCsvDir,
    async () => {
      try {
        const win2 = deps.getMainWindow();
        if (!win2 || win2.isDestroyed()) throw new Error("窗口不可用");
        const result = await electron.dialog.showOpenDialog(win2, {
          title: "选择对账 CSV 的存放目录",
          message: "CSV 里含完整 KSK 明文；选择云同步目录会把它们上传到云端",
          properties: ["openDirectory", "createDirectory"]
        });
        if (result.canceled || result.filePaths.length === 0) return { success: true, data: null };
        const dir = result.filePaths[0];
        await node_fs.promises.access(dir);
        if (!node_path.isAbsolute(dir)) throw new Error("请选择一个绝对路径目录");
        await deps.saveCsvDir(dir);
        return { success: true, data: dir };
      } catch (error) {
        return toError(error);
      }
    }
  );
  electron.ipcMain.handle(DOWNSTREAM_SETTLEMENT_CHANNEL.openCsvDir, async () => {
    try {
      const dir = await deps.getManager().resolveCsvDir();
      await node_fs.promises.mkdir(dir, { recursive: true });
      const failure = await electron.shell.openPath(dir);
      if (failure) throw new Error(failure);
      return { success: true, data: dir };
    } catch (error) {
      return toError(error);
    }
  });
}
const TICK_INTERVAL_MS = 6e4;
const DEFAULT_TIMEOUT_MS = 8e3;
const DEFAULT_CONCURRENCY = 5;
class ProxyPoolScheduler {
  constructor(deps) {
    this.deps = deps;
  }
  timer = null;
  lastRunAt = 0;
  /** 防重入：一轮验活未跑完时下一次 tick 直接跳过 */
  running = false;
  /**
   * 从 store 读取配置并按需启动。autoValidateIntervalMin <= 0 时保持停止状态。
   * 幂等：重复调用先停旧的再按新配置起。
   */
  async start() {
    this.stop();
    const data = await this.deps.readStore();
    const config = { ...DEFAULT_PROXY_POOL_CONFIG, ...data?.proxyPoolConfig || {} };
    if (!config.autoValidateIntervalMin || config.autoValidateIntervalMin <= 0) {
      this.log("Auto-validate disabled");
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_INTERVAL_MS);
    this.timer.unref?.();
    this.log(`Auto-validate scheduled every ${config.autoValidateIntervalMin} min`);
  }
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
  /** 配置变更后重启调度（渲染进程改了 autoValidateIntervalMin 时调用） */
  async restart() {
    await this.start();
  }
  get isRunning() {
    return this.timer !== null;
  }
  /**
   * 到点则跑一轮验活。间隔判定放在 tick 里而不是靠 setInterval 的周期，
   * 这样改配置不必重算下次触发时间，且不会因为进程睡眠错过整个周期。
   *
   * 公开以便测试直接驱动一次心跳，无需等真实的 60s。
   */
  async tick() {
    if (this.running) return;
    const data = await this.deps.readStore();
    const config = { ...DEFAULT_PROXY_POOL_CONFIG, ...data?.proxyPoolConfig || {} };
    const intervalMin = config.autoValidateIntervalMin;
    if (!intervalMin || intervalMin <= 0) {
      this.stop();
      return;
    }
    if (Date.now() - this.lastRunAt < intervalMin * 6e4) return;
    this.lastRunAt = Date.now();
    await this.runOnce(config, data);
  }
  /** 立即跑一轮验活（供 tick 与手动触发共用） */
  async runOnce(configOverride, dataOverride) {
    if (this.running) return 0;
    this.running = true;
    try {
      const data = dataOverride !== void 0 ? dataOverride : await this.deps.readStore();
      const config = configOverride || {
        ...DEFAULT_PROXY_POOL_CONFIG,
        ...data?.proxyPoolConfig || {}
      };
      const pool = data?.proxyPool || {};
      const targets = Object.values(pool).filter((p) => p && p.enabled);
      if (targets.length === 0) return 0;
      this.log(`Auto-validate ${targets.length} proxies`);
      const concurrency = Math.max(
        1,
        Math.min(config.autoValidateConcurrency || DEFAULT_CONCURRENCY, targets.length)
      );
      const results = /* @__PURE__ */ new Map();
      let cursor = 0;
      const worker = async () => {
        while (cursor < targets.length) {
          const entry = targets[cursor++];
          try {
            const result = await this.deps.validate({
              url: entry.url,
              testUrl: config.testUrl || DEFAULT_PROXY_POOL_CONFIG.testUrl,
              timeoutMs: config.testTimeoutMs || DEFAULT_TIMEOUT_MS,
              upstreamProxy: config.upstreamProxy
            });
            results.set(entry.id, result);
          } catch (err) {
            results.set(entry.id, {
              success: false,
              error: err instanceof Error ? err.message : String(err)
            });
          }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      if (results.size === 0) return 0;
      const updated = [];
      await this.deps.mutateStore((current) => {
        const currentPool = current.proxyPool || {};
        const currentConfig = { ...DEFAULT_PROXY_POOL_CONFIG, ...current.proxyPoolConfig || {} };
        const nextPool = { ...currentPool };
        let changed = false;
        for (const [id, result] of results) {
          const existing = nextPool[id];
          if (!existing) continue;
          const next = applyValidationResult(
            existing,
            result,
            currentConfig,
            Object.values(currentPool)
          );
          nextPool[id] = next;
          updated.push(next);
          changed = true;
        }
        if (!changed) return null;
        return { ...current, proxyPool: nextPool };
      });
      if (updated.length > 0) {
        this.deps.notifyRenderer({ entries: updated });
      }
      return updated.length;
    } finally {
      this.running = false;
    }
  }
  log(message) {
    this.deps.log?.(`[ProxyPoolScheduler] ${message}`);
  }
}
var LocalNoticeKind = /* @__PURE__ */ ((LocalNoticeKind2) => {
  LocalNoticeKind2["AccountSuspended"] = "account-suspended";
  LocalNoticeKind2["TokenRefreshFailed"] = "token-refresh-failed";
  LocalNoticeKind2["RegistrationRiskPaused"] = "registration-risk-paused";
  LocalNoticeKind2["RegistrationBatchCompleted"] = "registration-batch-completed";
  LocalNoticeKind2["KskHunterInStock"] = "ksk-hunter-in-stock";
  LocalNoticeKind2["KskHunterOrdered"] = "ksk-hunter-ordered";
  LocalNoticeKind2["KskHunterBudgetExhausted"] = "ksk-hunter-budget-exhausted";
  LocalNoticeKind2["KskHunterLowBalance"] = "ksk-hunter-low-balance";
  return LocalNoticeKind2;
})(LocalNoticeKind || {});
const NOTICE_TEMPLATES = {
  zh: {
    [
      "account-suspended"
      /* AccountSuspended */
    ]: {
      title: "账号需要处理",
      body: "检测到一个账号已被暂停，请在账号管理中查看。",
      target: "accounts"
    },
    [
      "token-refresh-failed"
      /* TokenRefreshFailed */
    ]: {
      title: "账号刷新失败",
      body: "一个账号的后台凭据刷新失败，请在账号管理中查看。",
      target: "accounts"
    },
    [
      "registration-risk-paused"
      /* RegistrationRiskPaused */
    ]: {
      title: "注册任务已暂停",
      body: "检测到严重风控信号，批量注册已自动暂停。",
      target: "register"
    },
    [
      "registration-batch-completed"
      /* RegistrationBatchCompleted */
    ]: {
      title: "批量注册已完成",
      body: "一批注册任务已结束，请在注册页面查看结果。",
      target: "register"
    },
    [
      "ksk-hunter-in-stock"
      /* KskHunterInStock */
    ]: {
      title: "KSK 开货了",
      body: "监控的链接检测到有货，请尽快下单。",
      target: "hunter"
    },
    [
      "ksk-hunter-ordered"
      /* KskHunterOrdered */
    ]: {
      title: "KSK 已自动下单",
      body: "已抢到一个 KSK，正在验活并推送下游。",
      target: "hunter"
    },
    [
      "ksk-hunter-budget-exhausted"
      /* KskHunterBudgetExhausted */
    ]: {
      title: "抢号预算已用尽",
      body: "当日花费已达上限，已暂停自动下单；开货仍会提醒。",
      target: "hunter"
    },
    [
      "ksk-hunter-low-balance"
      /* KskHunterLowBalance */
    ]: {
      title: "抢号余额不足",
      body: "渠道余额已低于设定阈值，请及时充值。",
      target: "hunter"
    }
  },
  en: {
    [
      "account-suspended"
      /* AccountSuspended */
    ]: {
      title: "Account needs attention",
      body: "An account was suspended. Review it in Account Manager.",
      target: "accounts"
    },
    [
      "token-refresh-failed"
      /* TokenRefreshFailed */
    ]: {
      title: "Account refresh failed",
      body: "A background credential refresh failed. Review it in Account Manager.",
      target: "accounts"
    },
    [
      "registration-risk-paused"
      /* RegistrationRiskPaused */
    ]: {
      title: "Registration paused",
      body: "A serious risk signal paused the registration batch.",
      target: "register"
    },
    [
      "registration-batch-completed"
      /* RegistrationBatchCompleted */
    ]: {
      title: "Registration batch completed",
      body: "A registration batch finished. Review the results on the registration page.",
      target: "register"
    },
    [
      "ksk-hunter-in-stock"
      /* KskHunterInStock */
    ]: {
      title: "KSK back in stock",
      body: "A monitored link is in stock. Order it now.",
      target: "hunter"
    },
    [
      "ksk-hunter-ordered"
      /* KskHunterOrdered */
    ]: {
      title: "KSK ordered automatically",
      body: "A KSK was purchased and is being verified before delivery.",
      target: "hunter"
    },
    [
      "ksk-hunter-budget-exhausted"
      /* KskHunterBudgetExhausted */
    ]: {
      title: "Hunter budget exhausted",
      body: "Daily spend limit reached. Auto-ordering paused; alerts continue.",
      target: "hunter"
    },
    [
      "ksk-hunter-low-balance"
      /* KskHunterLowBalance */
    ]: {
      title: "Hunter balance low",
      body: "A channel balance fell below the configured threshold. Top up soon.",
      target: "hunter"
    }
  }
};
const ACCOUNT_SUSPENDED_DEDUP_MS = 30 * 6e4;
const TOKEN_REFRESH_FAILED_DEDUP_MS = 15 * 6e4;
const REGISTRATION_RISK_PAUSED_DEDUP_MS = 10 * 6e4;
const REGISTRATION_BATCH_COMPLETED_DEDUP_MS = 24 * 60 * 6e4;
const KSK_HUNTER_IN_STOCK_DEDUP_MS = 5 * 6e4;
const KSK_HUNTER_ORDERED_DEDUP_MS = 3e4;
const KSK_HUNTER_BUDGET_DEDUP_MS = 6 * 60 * 6e4;
const KSK_HUNTER_LOW_BALANCE_DEDUP_MS = 60 * 6e4;
const LAST_SENT_RETENTION_MS = REGISTRATION_BATCH_COMPLETED_DEDUP_MS;
const MAX_NOTICES_PER_MINUTE = 5;
const NOTICE_RATE_WINDOW_MS = 6e4;
class LocalNotificationService {
  constructor(getTraySettings, getLanguage, onClick) {
    this.getTraySettings = getTraySettings;
    this.getLanguage = getLanguage;
    this.onClick = onClick;
  }
  lastSentAt = /* @__PURE__ */ new Map();
  recentNoticeTimes = [];
  notify(kind, input = {}) {
    if (!this.getTraySettings().showNotifications || !electron.Notification.isSupported()) return;
    const now = Date.now();
    this.pruneRateWindow(now);
    this.pruneLastSentAt(now);
    if (this.recentNoticeTimes.length >= MAX_NOTICES_PER_MINUTE) return;
    const dedupKey = this.getDedupKey(kind, input);
    const dedupMs = this.getDedupInterval(kind);
    const lastSent = this.lastSentAt.get(dedupKey);
    if (lastSent && now - lastSent < dedupMs) return;
    try {
      const template = NOTICE_TEMPLATES[this.getLanguage()][kind];
      const notification = new electron.Notification({
        title: template.title,
        body: input.bodyOverride || template.body
      });
      notification.on("click", () => {
        try {
          this.onClick(template.target);
        } catch {
        }
      });
      notification.show();
      this.lastSentAt.set(dedupKey, now);
      this.recentNoticeTimes.push(now);
    } catch {
    }
  }
  getDedupKey(kind, input) {
    if (kind === "registration-batch-completed") {
      return `${kind}:${input.batchId || "unknown"}`;
    }
    if (kind === "account-suspended" || kind === "token-refresh-failed") {
      return `${kind}:${input.accountId || "unknown"}`;
    }
    if (kind === "ksk-hunter-in-stock" || kind === "ksk-hunter-ordered" || kind === "ksk-hunter-budget-exhausted" || kind === "ksk-hunter-low-balance") {
      return `${kind}:${input.hunterKey || "unknown"}`;
    }
    return kind;
  }
  getDedupInterval(kind) {
    switch (kind) {
      case "account-suspended":
        return ACCOUNT_SUSPENDED_DEDUP_MS;
      case "token-refresh-failed":
        return TOKEN_REFRESH_FAILED_DEDUP_MS;
      case "registration-risk-paused":
        return REGISTRATION_RISK_PAUSED_DEDUP_MS;
      case "registration-batch-completed":
        return REGISTRATION_BATCH_COMPLETED_DEDUP_MS;
      case "ksk-hunter-in-stock":
        return KSK_HUNTER_IN_STOCK_DEDUP_MS;
      case "ksk-hunter-ordered":
        return KSK_HUNTER_ORDERED_DEDUP_MS;
      case "ksk-hunter-budget-exhausted":
        return KSK_HUNTER_BUDGET_DEDUP_MS;
      case "ksk-hunter-low-balance":
        return KSK_HUNTER_LOW_BALANCE_DEDUP_MS;
    }
  }
  pruneRateWindow(now) {
    while (this.recentNoticeTimes[0] && now - this.recentNoticeTimes[0] >= NOTICE_RATE_WINDOW_MS) {
      this.recentNoticeTimes.shift();
    }
  }
  pruneLastSentAt(now) {
    for (const [key, sentAt] of this.lastSentAt) {
      if (now - sentAt >= LAST_SENT_RETENTION_MS) this.lastSentAt.delete(key);
    }
  }
}
let tray = null;
const menuIcons = /* @__PURE__ */ new Map();
function getTrayIconDir() {
  if (electron.app.isPackaged) {
    return path.join(process.resourcesPath, "app.asar.unpacked", "resources", "托盘图标");
  }
  return path.join(__dirname, "../../resources/托盘图标");
}
const ICON_FILE_MAP = {
  // 应用图标
  app: "icon.png",
  // 状态图标
  "status-running": "运行状态.png",
  "status-stopped": "停止状态.png",
  // 菜单图标
  mail: "当前账户.png",
  refresh: "刷新.png",
  switchAccount: "切换.png",
  copy: "复制.png",
  window: "弹出窗口.png",
  logout: "退出.png",
  play: "播放.png",
  stop: "停止状态.png",
  check: "已勾选.png",
  warning: "警告.png",
  usage: "用量.png",
  requests: "请求.png"
};
function loadIconFromFile(iconKey) {
  const cached = menuIcons.get(iconKey);
  if (cached) return cached;
  const fileName = ICON_FILE_MAP[iconKey];
  if (!fileName) {
    console.warn(`[Tray] Unknown icon key: ${iconKey}`);
    return electron.nativeImage.createEmpty();
  }
  const iconPath = path.join(getTrayIconDir(), fileName);
  try {
    const icon2 = electron.nativeImage.createFromPath(iconPath);
    const resized = icon2.resize({ width: 16, height: 16 });
    menuIcons.set(iconKey, resized);
    return resized;
  } catch (error) {
    console.error(`[Tray] Failed to load icon: ${iconPath}`, error);
    return electron.nativeImage.createEmpty();
  }
}
function getMenuIcon(name) {
  return loadIconFromFile(name);
}
let currentAccount = null;
let accountList = [];
let currentLanguage = "zh";
let callbacks = null;
function getTrayIconPath() {
  if (process.platform === "win32") {
    if (electron.app.isPackaged) {
      return path.join(process.resourcesPath, "app.asar.unpacked", "resources", "icon.ico");
    }
    return path.join(__dirname, "../../resources/icon.ico");
  } else if (process.platform === "darwin") {
    if (electron.app.isPackaged) {
      return path.join(process.resourcesPath, "app.asar.unpacked", "resources", "icon.png");
    }
    return path.join(__dirname, "../../resources/icon.png");
  } else {
    if (electron.app.isPackaged) {
      return path.join(process.resourcesPath, "app.asar.unpacked", "resources", "icon.png");
    }
    return path.join(__dirname, "../../resources/icon.png");
  }
}
function buildTrayMenu() {
  const menuTemplate = [];
  const isEn = currentLanguage === "en";
  menuTemplate.push({
    label: `Kiro ${isEn ? "Account Manager" : "账号管理器"} v${electron.app.getVersion()}`,
    icon: getMenuIcon("app"),
    enabled: false
  });
  menuTemplate.push({ type: "separator" });
  const account = callbacks?.getCurrentAccount() || currentAccount;
  if (account) {
    menuTemplate.push({
      label: isEn ? "Current Account" : "当前账户",
      icon: getMenuIcon("mail"),
      enabled: false
    });
    menuTemplate.push({
      label: `   ${account.email}`,
      enabled: false
    });
    menuTemplate.push({
      label: isEn ? `   Identity: ${account.idp} | ${account.subscription || "Unknown"} | ${account.status === "active" ? "Active" : account.status}` : `   身份: ${account.idp} | ${account.subscription || "未知"} | ${account.status === "active" ? "活跃" : account.status}`,
      icon: getMenuIcon(account.status === "active" ? "check" : "warning"),
      enabled: false
    });
    if (account.usage) {
      menuTemplate.push({
        label: isEn ? `   Usage: ${account.usage.usedCredits} / ${account.usage.totalCredits} Credits` : `   用量: ${account.usage.usedCredits} / ${account.usage.totalCredits} Credits`,
        icon: getMenuIcon("usage"),
        enabled: false
      });
    }
    menuTemplate.push({ type: "separator" });
  } else {
    menuTemplate.push({
      label: isEn ? "No Active Account" : "暂无活跃账户",
      icon: getMenuIcon("mail"),
      enabled: false
    });
    menuTemplate.push({ type: "separator" });
  }
  menuTemplate.push({
    label: isEn ? "Refresh Account Info" : "刷新账户信息",
    icon: getMenuIcon("refresh"),
    click: async () => {
      await callbacks?.onRefreshAccount();
      updateTrayMenu();
    }
  });
  const accounts = callbacks?.getAccountList() || accountList;
  const activeAccounts = accounts.filter((a) => a.status === "active");
  menuTemplate.push({
    label: isEn ? `Switch to Next Account (${activeAccounts.length} available)` : `切换到下一个账户 (${activeAccounts.length} 个可用)`,
    icon: getMenuIcon("switchAccount"),
    enabled: activeAccounts.length > 1,
    click: async () => {
      await callbacks?.onSwitchAccount();
      updateTrayMenu();
    }
  });
  menuTemplate.push({ type: "separator" });
  menuTemplate.push({
    label: isEn ? "Show Main Window" : "显示主窗口",
    icon: getMenuIcon("window"),
    click: () => {
      callbacks?.onShowWindow();
    }
  });
  menuTemplate.push({
    label: isEn ? "Exit" : "退出程序",
    icon: getMenuIcon("logout"),
    click: () => {
      callbacks?.onQuit();
    }
  });
  return electron.Menu.buildFromTemplate(menuTemplate);
}
function updateTrayMenu() {
  if (tray) {
    tray.setContextMenu(buildTrayMenu());
  }
}
function updateCurrentAccount(account) {
  currentAccount = account;
  updateTrayMenu();
}
function updateAccountList(accounts) {
  accountList = accounts;
  updateTrayMenu();
}
function updateTrayLanguage(language) {
  currentLanguage = language;
  updateTrayMenu();
}
function setTrayTooltip(tooltip) {
  if (tray) {
    tray.setToolTip(tooltip);
  }
}
function createTray(cbs) {
  if (tray) {
    return tray;
  }
  callbacks = cbs;
  try {
    const iconPath = getTrayIconPath();
    let icon2 = electron.nativeImage.createFromPath(iconPath);
    if (process.platform === "darwin") {
      icon2 = icon2.resize({ width: 16, height: 16 });
      icon2.setTemplateImage(true);
    } else if (process.platform === "win32") {
      icon2 = icon2.resize({ width: 16, height: 16 });
    }
    tray = new electron.Tray(icon2);
    tray.setToolTip(APP_NAME);
    tray.setContextMenu(buildTrayMenu());
    tray.on("double-click", () => {
      callbacks?.onShowWindow();
    });
    if (process.platform !== "darwin") {
      tray.on("click", () => {
        callbacks?.onShowWindow();
      });
    }
    console.log("[Tray] System tray created successfully");
    return tray;
  } catch (error) {
    console.error("[Tray] Failed to create system tray:", error);
    return null;
  }
}
function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
    callbacks = null;
    console.log("[Tray] System tray destroyed");
  }
}
const defaultTraySettings = {
  enabled: true,
  closeAction: "ask",
  showNotifications: true,
  minimizeOnStart: false
};
const MIN_ZOOM_LEVEL = -3;
const MAX_ZOOM_LEVEL = 5;
function resolveWindowZoomAction(input) {
  if (input.type !== "keyDown" || !input.meta && !input.control || input.alt) return null;
  if (input.code === "Minus" || input.key === "-" || input.key === "_") return "out";
  if (input.code === "Equal" || input.key === "=" || input.key === "+") return "in";
  if (input.code === "Digit0" || input.key === "0") return "reset";
  return null;
}
function getNextWindowZoomLevel(currentLevel, action) {
  if (action === "reset") return 0;
  const nextLevel = currentLevel + (action === "in" ? 1 : -1);
  return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, nextLevel));
}
electron.app.setName(APP_NAME);
electron.app.setPath("userData", path.join(electron.app.getPath("appData"), APP_DATA_DIRECTORY_NAME));
const KIRO_API_BASE = "https://app.kiro.dev/service/KiroWebPortalService/operation";
const KIRO_REST_API_ENDPOINTS = {
  "us-east-1": "https://q.us-east-1.amazonaws.com",
  "eu-central-1": "https://q.eu-central-1.amazonaws.com"
};
function getRestApiBase(ssoRegion) {
  if (!ssoRegion) return KIRO_REST_API_ENDPOINTS["us-east-1"];
  if (KIRO_REST_API_ENDPOINTS[ssoRegion]) return KIRO_REST_API_ENDPOINTS[ssoRegion];
  if (ssoRegion.startsWith("eu-")) return KIRO_REST_API_ENDPOINTS["eu-central-1"];
  return KIRO_REST_API_ENDPOINTS["us-east-1"];
}
function getFallbackRestApiBase(ssoRegion) {
  const primary = getRestApiBase(ssoRegion);
  return primary === KIRO_REST_API_ENDPOINTS["eu-central-1"] ? KIRO_REST_API_ENDPOINTS["us-east-1"] : KIRO_REST_API_ENDPOINTS["eu-central-1"];
}
let currentUsageApiType = "rest";
function setUsageApiType(type) {
  currentUsageApiType = type;
  console.log(`[API] Usage API type set to: ${type}`);
}
function getUsageApiType() {
  return currentUsageApiType;
}
function getNetworkAgent() {
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  const envAgent = safeCreateProxyAgent(envProxy);
  if (envAgent) return envAgent;
  return safeCreateProxyAgent(getSystemProxy());
}
const localAdminDirectAgent = new undici.Agent();
async function fetchWithAppProxy(url, options, overrideProxyUrl) {
  if (overrideProxyUrl) {
    const accountAgent = safeCreateProxyAgent(overrideProxyUrl);
    if (accountAgent) {
      return await undici.fetch(url, {
        ...options,
        dispatcher: accountAgent
      });
    }
  }
  const agent = getNetworkAgent();
  if (agent) {
    return await undici.fetch(url, {
      ...options,
      dispatcher: agent
    });
  }
  return await fetch(url, options);
}
const KIRO_AUTH_ENDPOINT = "https://prod.us-east-1.auth.desktop.kiro.dev";
let activeElectronProxyCredentials;
electron.app.on("login", (event, _webContents, _details, authInfo, callback) => {
  const credentials = activeElectronProxyCredentials;
  if (!credentials || !authInfo.isProxy || authInfo.host !== credentials.host || authInfo.port !== credentials.port) {
    return;
  }
  event.preventDefault();
  callback(credentials.username, credentials.password);
});
function normalizeProxyUrl(url) {
  const trimmed = (url || "").trim();
  if (!trimmed) return "";
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(trimmed)) return trimmed;
  const m = trimmed.match(/^([a-z][a-z0-9+\-.]*):(\/*)(.+)$/i);
  if (m) return `${m[1]}://${m[3]}`;
  return `http://${trimmed}`;
}
function applyProxySettings(enabled, url) {
  if (enabled && url) {
    const normalized = normalizeProxyUrl(url);
    const electronProxy = getElectronProxySettings(normalized);
    activeElectronProxyCredentials = electronProxy?.credentials;
    process.env.HTTP_PROXY = normalized;
    process.env.HTTPS_PROXY = normalized;
    process.env.http_proxy = normalized;
    process.env.https_proxy = normalized;
    const redactedNormalized = redactProxyUrl(normalized);
    if (normalized !== url) {
      console.log(`[Proxy] Enabled: ${redactedNormalized} (代理地址已规范化)`);
    } else {
      console.log(`[Proxy] Enabled: ${redactedNormalized}`);
    }
  } else {
    activeElectronProxyCredentials = void 0;
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    console.log("[Proxy] Disabled");
  }
}
let privateBrowserWindow = null;
let privateBrowserSessionSequence = 0;
function closePrivateBrowserWindow() {
  if (privateBrowserWindow && !privateBrowserWindow.isDestroyed()) {
    privateBrowserWindow.close();
  }
}
function openBrowserInPrivateMode(url) {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    console.error("[Browser] Refused to open non-HTTP URL in the built-in browser");
    return;
  }
  closePrivateBrowserWindow();
  const partition = `incognito-browser-${process.pid}-${privateBrowserSessionSequence++}`;
  const browserWindow = new electron.BrowserWindow({
    title: `${APP_NAME} 无痕浏览器`,
    width: 1100,
    height: 800,
    minWidth: 720,
    minHeight: 560,
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  });
  privateBrowserWindow = browserWindow;
  const chromeUserAgent = browserWindow.webContents.session.getUserAgent().replace(/\sElectron\/[^\s]+/g, "");
  browserWindow.webContents.setUserAgent(chromeUserAgent);
  const appProxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  const electronProxy = getElectronProxySettings(appProxyUrl);
  browserWindow.on("closed", () => {
    if (privateBrowserWindow === browserWindow) {
      privateBrowserWindow = null;
    }
  });
  const handleProtocolNavigation = (event, navigationUrl) => {
    if (!navigationUrl.startsWith(`${PROTOCOL_PREFIX}://`)) return;
    event.preventDefault();
    handleProtocolUrl(navigationUrl);
  };
  browserWindow.webContents.on("will-navigate", handleProtocolNavigation);
  browserWindow.webContents.on("will-redirect", handleProtocolNavigation);
  browserWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    console.error(
      `[Browser] Built-in incognito browser failed to load (${errorCode}): ${errorDescription}`
    );
  });
  void (async () => {
    if (electronProxy) {
      await browserWindow.webContents.session.setProxy({ proxyRules: electronProxy.proxyRules });
      console.log(
        `[Browser] Built-in incognito browser using proxy: ${redactProxyUrl(appProxyUrl)}`
      );
    }
    await browserWindow.loadURL(url);
  })().catch((error) => {
    console.error("[Browser] Failed to open URL in built-in incognito browser:", error);
  });
}
async function refreshOidcToken(refreshToken, clientId, clientSecret, region = "us-east-1", proxyUrl) {
  console.log(
    `[OIDC] Refreshing token with clientId: ${clientId.substring(0, 20)}...${proxyUrl ? " [via bound proxy]" : ""}`
  );
  const url = `https://oidc.${region}.amazonaws.com/token`;
  const payload = {
    clientId,
    clientSecret,
    refreshToken,
    grantType: "refresh_token"
  };
  try {
    const response = await fetchWithAppProxy(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      },
      proxyUrl
    );
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[OIDC] Refresh failed: ${response.status} - ${errorText}`);
      return { success: false, error: `HTTP ${response.status}: ${errorText}` };
    }
    const data = await response.json();
    console.log(`[OIDC] Token refreshed successfully, expires in ${data.expiresIn}s`);
    return {
      success: true,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || refreshToken,
      // 可能不返回新的 refreshToken
      expiresIn: data.expiresIn
    };
  } catch (error) {
    console.error(`[OIDC] Refresh error:`, error);
    return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
}
async function refreshSocialToken(refreshToken, proxyUrl) {
  console.log(`[Social] Refreshing token...${proxyUrl ? " [via bound proxy]" : ""}`);
  const url = `${KIRO_AUTH_ENDPOINT}/refreshToken`;
  try {
    const response = await fetchWithAppProxy(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": getKiroUserAgent()
        },
        body: JSON.stringify({ refreshToken })
      },
      proxyUrl
    );
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Social] Refresh failed: ${response.status} - ${errorText}`);
      return { success: false, error: `HTTP ${response.status}: ${errorText}` };
    }
    const data = await response.json();
    console.log(`[Social] Token refreshed successfully, expires in ${data.expiresIn}s`);
    return {
      success: true,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || refreshToken,
      expiresIn: data.expiresIn
    };
  } catch (error) {
    console.error(`[Social] Refresh error:`, error);
    return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
}
async function refreshTokenByMethod(token, clientId, clientSecret, region = "us-east-1", authMethod, proxyUrl) {
  if (authMethod === "social") {
    return refreshSocialToken(token, proxyUrl);
  }
  return refreshOidcToken(token, clientId, clientSecret, region, proxyUrl);
}
function generateInvocationId() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : r & 3 | 8;
    return v.toString(16);
  });
}
const KIRO_VERSION = "0.6.18";
function getKiroUserAgent() {
  return `aws-sdk-js/1.0.18 ua/2.1 os/windows lang/js md/nodejs#20.16.0 api/codewhispererstreaming#1.0.18 m/E KiroIDE-${KIRO_VERSION}`;
}
function getKiroAmzUserAgent() {
  return `aws-sdk-js/1.0.18 KiroIDE-${KIRO_VERSION}`;
}
async function ssoDeviceAuth(bearerToken, region = "us-east-1") {
  const oidcBase = `https://oidc.${region}.amazonaws.com`;
  const portalBase = "https://portal.sso.us-east-1.amazonaws.com";
  const startUrl = "https://view.awsapps.com/start";
  const scopes = [
    "codewhisperer:analysis",
    "codewhisperer:completions",
    "codewhisperer:conversations",
    "codewhisperer:taskassist",
    "codewhisperer:transformations"
  ];
  let clientId, clientSecret;
  let deviceCode, userCode;
  let deviceSessionToken;
  let interval = 1;
  console.log("[SSO] Step 1: Registering OIDC client...");
  try {
    const regRes = await fetchWithAppProxy(`${oidcBase}/client/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientName: APP_NAME,
        clientType: "public",
        scopes,
        grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
        issuerUrl: startUrl
      })
    });
    if (!regRes.ok) throw new Error(`Register failed: ${regRes.status}`);
    const regData = await regRes.json();
    clientId = regData.clientId;
    clientSecret = regData.clientSecret;
    console.log(`[SSO] Client registered: ${clientId.substring(0, 30)}...`);
  } catch (e) {
    return { success: false, error: `注册客户端失败: ${e}` };
  }
  console.log("[SSO] Step 2: Starting device authorization...");
  try {
    const devRes = await fetchWithAppProxy(`${oidcBase}/device_authorization`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, clientSecret, startUrl })
    });
    if (!devRes.ok) throw new Error(`Device auth failed: ${devRes.status}`);
    const devData = await devRes.json();
    deviceCode = devData.deviceCode;
    userCode = devData.userCode;
    interval = devData.interval || 1;
    console.log(`[SSO] Device code obtained, user_code: ${userCode}`);
  } catch (e) {
    return { success: false, error: `设备授权失败: ${e}` };
  }
  console.log("[SSO] Step 3: Verifying bearer token...");
  try {
    const whoRes = await fetchWithAppProxy(`${portalBase}/token/whoAmI`, {
      method: "GET",
      headers: { Authorization: `Bearer ${bearerToken}`, Accept: "application/json" }
    });
    if (!whoRes.ok) throw new Error(`whoAmI failed: ${whoRes.status}`);
    console.log("[SSO] Bearer token verified");
  } catch (e) {
    return { success: false, error: `Token 验证失败: ${e}` };
  }
  console.log("[SSO] Step 4: Getting device session token...");
  try {
    const sessRes = await fetchWithAppProxy(`${portalBase}/session/device`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    if (!sessRes.ok) throw new Error(`Device session failed: ${sessRes.status}`);
    const sessData = await sessRes.json();
    deviceSessionToken = sessData.token;
    console.log("[SSO] Device session token obtained");
  } catch (e) {
    return { success: false, error: `获取设备会话失败: ${e}` };
  }
  console.log("[SSO] Step 5: Accepting user code...");
  let deviceContext = null;
  try {
    const acceptRes = await fetchWithAppProxy(`${oidcBase}/device_authorization/accept_user_code`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Referer: "https://view.awsapps.com/" },
      body: JSON.stringify({ userCode, userSessionId: deviceSessionToken })
    });
    if (!acceptRes.ok) throw new Error(`Accept user code failed: ${acceptRes.status}`);
    const acceptData = await acceptRes.json();
    deviceContext = acceptData.deviceContext || null;
    console.log("[SSO] User code accepted");
  } catch (e) {
    return { success: false, error: `接受用户代码失败: ${e}` };
  }
  if (deviceContext?.deviceContextId) {
    console.log("[SSO] Step 6: Approving authorization...");
    try {
      const approveRes = await fetchWithAppProxy(
        `${oidcBase}/device_authorization/associate_token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Referer: "https://view.awsapps.com/" },
          body: JSON.stringify({
            deviceContext: {
              deviceContextId: deviceContext.deviceContextId,
              clientId: deviceContext.clientId || clientId,
              clientType: deviceContext.clientType || "public"
            },
            userSessionId: deviceSessionToken
          })
        }
      );
      if (!approveRes.ok) throw new Error(`Approve failed: ${approveRes.status}`);
      console.log("[SSO] Authorization approved");
    } catch (e) {
      return { success: false, error: `批准授权失败: ${e}` };
    }
  }
  console.log("[SSO] Step 7: Polling for token...");
  const startTime = Date.now();
  const timeout = 12e4;
  while (Date.now() - startTime < timeout) {
    await new Promise((r) => setTimeout(r, interval * 1e3));
    try {
      const tokenRes = await fetchWithAppProxy(`${oidcBase}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId,
          clientSecret,
          grantType: "urn:ietf:params:oauth:grant-type:device_code",
          deviceCode
        })
      });
      if (tokenRes.ok) {
        const tokenData = await tokenRes.json();
        console.log("[SSO] Token obtained successfully!");
        return {
          success: true,
          accessToken: tokenData.accessToken,
          refreshToken: tokenData.refreshToken,
          clientId,
          clientSecret,
          region,
          expiresIn: tokenData.expiresIn
        };
      }
      if (tokenRes.status === 400) {
        const errData = await tokenRes.json();
        if (errData.error === "authorization_pending") {
          continue;
        } else if (errData.error === "slow_down") {
          interval += 5;
        } else {
          return { success: false, error: `Token 获取失败: ${errData.error}` };
        }
      }
    } catch (e) {
      console.error("[SSO] Token poll error:", e);
    }
  }
  return { success: false, error: "授权超时，请重试" };
}
function resolveUpstreamKiroCredential(input) {
  const kiroApiKey = input.kiroApiKey?.trim();
  const credentialKind = input.credentialKind ?? (kiroApiKey ? "kiro_api_key" : "oauth");
  if (credentialKind === "kiro_api_key") {
    if (!kiroApiKey) throw new Error("Missing Kiro API key");
    return { credentialKind, kiroApiKey, idp: input.idp };
  }
  const accessToken = input.accessToken?.trim();
  if (!accessToken) throw new Error("Missing OAuth access token");
  return { credentialKind: "oauth", accessToken, idp: input.idp };
}
function getUpstreamKiroAuth(credential, fallbackIdp = "BuilderId") {
  const source = typeof credential === "string" ? resolveUpstreamKiroCredential({ accessToken: credential }) : resolveUpstreamKiroCredential(credential);
  const isApiKey = source.credentialKind === "kiro_api_key";
  const accessToken = isApiKey ? source.kiroApiKey : source.accessToken;
  const headers = { authorization: `Bearer ${accessToken}` };
  if (isApiKey) headers.tokentype = "API_KEY";
  return { accessToken, isApiKey, idp: source.idp || fallbackIdp, headers };
}
async function kiroApiRequest(operation, body, credential, idp = "BuilderId", email, proxyUrl) {
  const auth = getUpstreamKiroAuth(credential, idp);
  const logTag = email || "upstream-account";
  console.log(`[Kiro API] ${operation} [${logTag}] ${auth.idp}`);
  const headers = {
    accept: "application/cbor",
    "content-type": "application/cbor",
    "smithy-protocol": "rpc-v2-cbor",
    "amz-sdk-invocation-id": generateInvocationId(),
    "amz-sdk-request": "attempt=1; max=1",
    "x-amz-user-agent": getKiroAmzUserAgent(),
    ...auth.headers
  };
  if (!auth.isApiKey) headers.cookie = `Idp=${auth.idp}; AccessToken=${auth.accessToken}`;
  const response = await fetchWithAppProxy(
    `${KIRO_API_BASE}/${operation}`,
    { method: "POST", headers, body: Buffer.from(cborX.encode(body)) },
    proxyUrl
  );
  if (!response.ok) {
    let errorMessage = `HTTP ${response.status}`;
    const errorBuffer = await response.arrayBuffer();
    try {
      const errorData = cborX.decode(Buffer.from(errorBuffer));
      const errorType = errorData.__type?.split("#").pop();
      const reason = errorData.reason || errorData.code;
      errorMessage = [`HTTP ${response.status}`, errorType, reason, errorData.message].filter(Boolean).join(": ");
      console.error("[Kiro API] Error:", { status: response.status, errorType, reason });
    } catch {
      console.error("[Kiro API] Error response was not CBOR:", response.status);
    }
    throw new Error(errorMessage);
  }
  const result = cborX.decode(Buffer.from(await response.arrayBuffer()));
  console.log(`[Kiro API] ${operation} [${logTag}] → ${response.status}`);
  return result;
}
function normalizeResetDate(value) {
  if (value === void 0 || value === null) return void 0;
  if (typeof value === "number") {
    return new Date(value * 1e3).toISOString();
  }
  return value;
}
async function fetchRestApi(baseUrl, path2, credential, proxyUrl) {
  const auth = getUpstreamKiroAuth(credential);
  const headers = {
    Accept: "application/json",
    ...auth.headers,
    "User-Agent": getKiroUserAgent(),
    "x-amz-user-agent": getKiroAmzUserAgent()
  };
  const url = `${baseUrl}${path2}`;
  return await fetchWithAppProxy(url, { method: "GET", headers }, proxyUrl);
}
async function getUsageLimitsRest(credential, profileArn, ssoRegion, email, proxyUrl) {
  const logTag = email || "upstream-account";
  console.log(`[Kiro REST API] GetUsageLimits [${logTag}] region=${ssoRegion || "default"}`);
  const params = new URLSearchParams({
    origin: "AI_EDITOR",
    resourceType: "AGENTIC_REQUEST",
    isEmailRequired: "true"
  });
  if (profileArn) params.set("profileArn", profileArn);
  const path2 = `/getUsageLimits?${params.toString()}`;
  const primaryBase = getRestApiBase(ssoRegion);
  const fallbackBase = getFallbackRestApiBase(ssoRegion);
  let response = await fetchRestApi(primaryBase, path2, credential, proxyUrl);
  if (response.status === 403) {
    console.log(`[Kiro REST API] Primary 403, fallback → ${fallbackBase}`);
    response = await fetchRestApi(fallbackBase, path2, credential, proxyUrl);
  }
  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[Kiro REST API] GetUsageLimits failed: ${response.status}`);
    throw new Error(`HTTP ${response.status}: ${errorText}`);
  }
  const result = await response.json();
  console.log(`[Kiro REST API] GetUsageLimits [${logTag}] → ${response.status}`);
  return result;
}
async function getUsageAndLimits(accessToken, idp = "BuilderId", profileArn, ssoRegion, email, proxyUrl) {
  if (currentUsageApiType === "rest" || typeof accessToken !== "string" && accessToken.credentialKind === "kiro_api_key") {
    const result = await getUsageLimitsRest(accessToken, profileArn, ssoRegion, email, proxyUrl);
    return {
      usageBreakdownList: result.usageBreakdownList?.map((b) => ({
        resourceType: b.resourceType || b.type,
        displayName: b.displayName,
        displayNamePlural: b.displayNamePlural,
        currentUsage: b.currentUsage,
        currentUsageWithPrecision: b.currentUsageWithPrecision,
        usageLimit: b.usageLimit,
        usageLimitWithPrecision: b.usageLimitWithPrecision,
        currency: b.currency,
        unit: b.unit,
        overageRate: b.overageRate,
        overageCap: b.overageCap,
        type: b.type,
        // REST API 直接返回 freeTrialInfo，CBOR API 返回 freeTrialUsage
        freeTrialInfo: b.freeTrialInfo ? {
          freeTrialStatus: b.freeTrialInfo.freeTrialStatus,
          usageLimit: b.freeTrialInfo.usageLimit,
          usageLimitWithPrecision: b.freeTrialInfo.usageLimitWithPrecision,
          currentUsage: b.freeTrialInfo.currentUsage,
          currentUsageWithPrecision: b.freeTrialInfo.currentUsageWithPrecision,
          // REST API 返回数字时间戳，需要转换为 ISO 字符串
          freeTrialExpiry: typeof b.freeTrialInfo.freeTrialExpiry === "number" ? new Date(b.freeTrialInfo.freeTrialExpiry * 1e3).toISOString() : b.freeTrialInfo.freeTrialExpiry
        } : b.freeTrialUsage ? {
          freeTrialStatus: b.freeTrialUsage.freeTrialStatus,
          usageLimit: b.freeTrialUsage.usageLimit,
          usageLimitWithPrecision: b.freeTrialUsage.usageLimitWithPrecision,
          currentUsage: b.freeTrialUsage.currentUsage,
          currentUsageWithPrecision: b.freeTrialUsage.currentUsageWithPrecision,
          freeTrialExpiry: b.freeTrialUsage.freeTrialExpiry
        } : void 0,
        // 转换 bonuses 中的时间戳为 ISO 字符串
        bonuses: b.bonuses?.map((bonus) => ({
          ...bonus,
          expiresAt: typeof bonus.expiresAt === "number" ? new Date(bonus.expiresAt * 1e3).toISOString() : bonus.expiresAt
        }))
      })),
      // REST API 返回的 nextDateReset 是 Unix 时间戳（秒），需要转换为 ISO 字符串
      nextDateReset: normalizeResetDate(result.nextDateReset),
      subscriptionInfo: result.subscriptionInfo,
      overageConfiguration: result.overageConfiguration,
      userInfo: result.userInfo
    };
  } else {
    try {
      return await kiroApiRequest(
        "GetUserUsageAndLimits",
        { isEmailRequired: true, origin: "KIRO_IDE" },
        accessToken,
        idp,
        email,
        proxyUrl
      );
    } catch (cborError) {
      const errorMsg = cborError instanceof Error ? cborError.message : "";
      if (errorMsg.includes("401") || errorMsg.includes("403")) {
        console.log(`[API] CBOR API failed (${errorMsg}), falling back to REST API...`);
        const result = await getUsageLimitsRest(accessToken, profileArn, ssoRegion, email, proxyUrl);
        return {
          usageBreakdownList: result.usageBreakdownList?.map((b) => ({
            resourceType: b.resourceType || b.type,
            displayName: b.displayName,
            displayNamePlural: b.displayNamePlural,
            currentUsage: b.currentUsage,
            currentUsageWithPrecision: b.currentUsageWithPrecision,
            usageLimit: b.usageLimit,
            usageLimitWithPrecision: b.usageLimitWithPrecision,
            currency: b.currency,
            unit: b.unit,
            overageRate: b.overageRate,
            overageCap: b.overageCap,
            type: b.type,
            freeTrialInfo: b.freeTrialInfo ? {
              freeTrialStatus: b.freeTrialInfo.freeTrialStatus,
              usageLimit: b.freeTrialInfo.usageLimit,
              usageLimitWithPrecision: b.freeTrialInfo.usageLimitWithPrecision,
              currentUsage: b.freeTrialInfo.currentUsage,
              currentUsageWithPrecision: b.freeTrialInfo.currentUsageWithPrecision,
              freeTrialExpiry: typeof b.freeTrialInfo.freeTrialExpiry === "number" ? new Date(b.freeTrialInfo.freeTrialExpiry * 1e3).toISOString() : b.freeTrialInfo.freeTrialExpiry
            } : b.freeTrialUsage ? {
              freeTrialStatus: b.freeTrialUsage.freeTrialStatus,
              usageLimit: b.freeTrialUsage.usageLimit,
              usageLimitWithPrecision: b.freeTrialUsage.usageLimitWithPrecision,
              currentUsage: b.freeTrialUsage.currentUsage,
              currentUsageWithPrecision: b.freeTrialUsage.currentUsageWithPrecision,
              freeTrialExpiry: b.freeTrialUsage.freeTrialExpiry
            } : void 0,
            bonuses: b.bonuses?.map((bonus) => ({
              ...bonus,
              expiresAt: typeof bonus.expiresAt === "number" ? new Date(bonus.expiresAt * 1e3).toISOString() : bonus.expiresAt
            }))
          })),
          nextDateReset: normalizeResetDate(result.nextDateReset),
          subscriptionInfo: result.subscriptionInfo,
          overageConfiguration: result.overageConfiguration,
          userInfo: result.userInfo
        };
      }
      throw cborError;
    }
  }
}
async function getUserInfo(accessToken, idp = "BuilderId", email, proxyUrl) {
  return kiroApiRequest(
    "GetUserInfo",
    { origin: "KIRO_IDE" },
    accessToken,
    idp,
    email,
    proxyUrl
  );
}
const PROTOCOL_PREFIX = APP_PROTOCOL_SCHEME;
let store = null;
let lastSavedData = null;
const accountStoreCoordinator = new AccountStoreCoordinator();
const kiroCredentialRefreshSingleflight = new KiroCredentialRefreshSingleflight();
const CREDENTIAL_REFRESH_UNAVAILABLE = "CREDENTIAL_REFRESH_UNAVAILABLE";
const DIAGNOSE_USER_AGENT = "ProxyRS-Diagnose/1.0";
const EMPTY_ACCOUNT_DATA = {
  accounts: {},
  groups: {},
  tags: {},
  activeAccountId: null
};
async function runCredentialRefreshOperation(_blockedResult, operation) {
  return operation();
}
async function persistRotatedKiroCredentials(accountId, expectedRefreshToken, expectedCredentialRevision, update) {
  return accountStoreCoordinator.runExclusive(async () => {
    await initStore();
    if (!store) return null;
    const current = store.get("accountData", null);
    const credentialRevision = crypto.randomUUID();
    const next = mergeRotatedKiroCredentials(
      current,
      accountId,
      expectedRefreshToken,
      expectedCredentialRevision,
      { ...update, credentialRevision }
    );
    if (!next) return null;
    store.set("accountData", next);
    lastSavedData = next;
    await createBackup(next);
    return credentialRevision;
  });
}
async function readCanonicalKiroCredentials(accountId) {
  return accountStoreCoordinator.runExclusive(async () => {
    await initStore();
    if (!store) return null;
    const accountData = store.get("accountData", null);
    return accountData?.accounts?.[accountId]?.credentials ?? null;
  });
}
async function readCanonicalKiroRefreshTransportCandidates(refreshToken) {
  return accountStoreCoordinator.runExclusive(async () => {
    await initStore();
    if (!store) return [];
    const accountData = store.get("accountData", EMPTY_ACCOUNT_DATA);
    const bindings = accountData.accountProxyBindings ?? {};
    const proxyPool = accountData.proxyPool ?? {};
    return Object.entries(accountData.accounts ?? {}).flatMap(([accountId, account]) => {
      const credentials = account.credentials;
      if (credentials?.refreshToken !== refreshToken) return [];
      const proxyId = bindings[accountId];
      const proxy = proxyId ? proxyPool[proxyId] : void 0;
      return [
        {
          accountId,
          clientId: credentials.clientId || "",
          clientSecret: credentials.clientSecret || "",
          region: credentials.region || "us-east-1",
          authMethod: credentials.authMethod,
          proxyUrl: proxy?.enabled && proxy.status !== "dead" ? proxy.url : void 0
        }
      ];
    }).sort(
      (left, right) => left.accountId < right.accountId ? -1 : left.accountId > right.accountId ? 1 : 0
    );
  });
}
function readAccountBoundProxyUrl(accountId) {
  if (!accountId || !store) return void 0;
  try {
    const accountData = store.get("accountData", EMPTY_ACCOUNT_DATA);
    const proxyId = accountData.accountProxyBindings?.[accountId];
    if (!proxyId) return void 0;
    const proxy = accountData.proxyPool?.[proxyId];
    if (!proxy?.enabled || proxy.status === "dead") return void 0;
    return proxy.url;
  } catch (err) {
    console.warn("[Store] Failed to read account bound proxy:", err);
    return void 0;
  }
}
function canonicalCredentialResult(credentials) {
  if (!credentials.accessToken || !credentials.refreshToken) {
    return { success: false, error: "Canonical credential is incomplete" };
  }
  return {
    success: true,
    accessToken: credentials.accessToken,
    refreshToken: credentials.refreshToken,
    expiresAt: credentials.expiresAt,
    expiresIn: credentials.expiresAt ? Math.max(0, Math.ceil((credentials.expiresAt - Date.now()) / 1e3)) : void 0,
    credentialRevision: credentials.credentialRevision,
    reusedCanonical: true
  };
}
function refreshKiroCredentialsSingleflight(params) {
  const key = buildKiroCredentialRefreshSingleflightKey(params);
  return kiroCredentialRefreshSingleflight.run(key, async () => {
    const storedCandidates = await readCanonicalKiroRefreshTransportCandidates(params.refreshToken);
    const candidates = storedCandidates.length > 0 ? storedCandidates : [
      {
        accountId: "unmanaged",
        clientId: params.clientId,
        clientSecret: params.clientSecret,
        region: params.region,
        authMethod: params.authMethod,
        proxyUrl: params.proxyUrl
      }
    ];
    let lastResult = {
      success: false,
      error: "No credential refresh transport available"
    };
    for (const candidate of candidates) {
      lastResult = await refreshTokenByMethod(
        params.refreshToken,
        candidate.clientId,
        candidate.clientSecret,
        candidate.region,
        candidate.authMethod,
        candidate.proxyUrl
      );
      if (lastResult.success) return lastResult;
    }
    return lastResult;
  });
}
async function refreshStoredKiroCredentials(params) {
  const canonical = await readCanonicalKiroCredentials(params.accountId);
  if (!canonical?.refreshToken) {
    return { success: false, error: "Canonical credential not found" };
  }
  if (shouldReuseCanonicalKiroCredentials(
    canonical,
    params.expectedRefreshToken,
    params.expectedCredentialRevision
  )) {
    return canonicalCredentialResult(canonical);
  }
  const refreshResult = await refreshKiroCredentialsSingleflight({
    refreshToken: canonical.refreshToken,
    clientId: canonical.clientId || params.clientId || "",
    clientSecret: canonical.clientSecret || params.clientSecret || "",
    region: canonical.region || params.region || "us-east-1",
    authMethod: canonical.authMethod || params.authMethod,
    proxyUrl: params.proxyUrl
  });
  if (!refreshResult.success || !refreshResult.accessToken) return refreshResult;
  const expiresAt = Date.now() + (refreshResult.expiresIn ?? 3600) * 1e3;
  const credentialRevision = await persistRotatedKiroCredentials(
    params.accountId,
    canonical.refreshToken,
    canonical.credentialRevision,
    {
      accessToken: refreshResult.accessToken,
      refreshToken: refreshResult.refreshToken || canonical.refreshToken,
      expiresAt
    }
  );
  if (!credentialRevision) {
    const latest = await readCanonicalKiroCredentials(params.accountId);
    return latest ? canonicalCredentialResult(latest) : { success: false, error: "Credential changed during refresh" };
  }
  return {
    ...refreshResult,
    refreshToken: refreshResult.refreshToken || canonical.refreshToken,
    expiresAt,
    credentialRevision
  };
}
function refreshUnmanagedKiroCredentials(refreshToken, clientId, clientSecret, region, authMethod, proxyUrl) {
  return refreshKiroCredentialsSingleflight({
    refreshToken,
    clientId,
    clientSecret,
    region,
    authMethod,
    proxyUrl
  });
}
function sendRendererEvent(channel, value) {
  mainWindow?.webContents.send(channel, value);
}
const LEGACY_ACCOUNT_DATA_KEYS = ["switchTarget"];
const LEGACY_PROACTIVE_RENEWAL_KEY = "proactiveRenewalEnabled";
function removeLegacyStorageKeys(value, keys) {
  const cleaned = { ...value };
  const record = cleaned;
  let changed = false;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      delete record[key];
      changed = true;
    }
  }
  return { value: cleaned, changed };
}
let initStorePromise = null;
async function initStore() {
  if (store) return;
  if (!initStorePromise) {
    initStorePromise = initStoreInternal().catch((error) => {
      store = null;
      initStorePromise = null;
      throw error;
    });
  }
  return initStorePromise;
}
const proxyPoolScheduler = new ProxyPoolScheduler({
  readStore: async () => {
    await initStore();
    return store.get("accountData", EMPTY_ACCOUNT_DATA) ?? null;
  },
  mutateStore: async (mutator) => accountStoreCoordinator.runExclusive(async () => {
    await initStore();
    const current = store.get("accountData", EMPTY_ACCOUNT_DATA);
    const next = mutator(current);
    if (!next) return;
    store.set("accountData", next);
    lastSavedData = next;
  }),
  validate: (params) => validateProxyEntry(params),
  notifyRenderer: (payload) => {
    mainWindow?.webContents.send("proxy-pool-validated", payload);
  },
  log: (message) => console.log(message)
});
function resolveKskSubscriptionType(title) {
  const normalized = title.toUpperCase();
  if (normalized.includes("PRO+") || normalized.includes("PRO_PLUS")) return "Pro_Plus";
  if (normalized.includes("PRO")) return "Pro";
  if (normalized.includes("POWER") || normalized.includes("ENTERPRISE")) return "Enterprise";
  if (normalized.includes("TEAMS")) return "Teams";
  return "Free";
}
function hasStoredKskAccount(data, key) {
  return Object.values(data.accounts ?? {}).some(
    (account) => account.credentials?.credentialKind === "kiro_api_key" && account.credentials.kiroApiKey === key
  );
}
async function importProviderKskCredential(input) {
  const duplicate = await accountStoreCoordinator.runExclusive(async () => {
    await initStore();
    const data = store.get("accountData", EMPTY_ACCOUNT_DATA);
    return hasStoredKskAccount(data, input.key);
  });
  if (duplicate) return { ...input, added: false };
  const probeAccount = toKskProbeAccount(input);
  const verdict = await probeKskAccountLiveness(
    probeAccount,
    await resolveKskLivenessModelId(probeAccount, input.liveness?.model),
    resolveKskLivenessMessage(input.liveness?.message)
  );
  if (verdict === KSK_PROBE_VERDICT.PERMANENTLY_INVALID) {
    return { ...input, added: false, rejected: true };
  }
  if (verdict !== KSK_PROBE_VERDICT.ALIVE) throw new Error("KSK 验活未能确认，稍后重试");
  const usage = await getUsageAndLimits(
    { credentialKind: "kiro_api_key", kiroApiKey: input.key, idp: "BuilderId" },
    "BuilderId",
    void 0,
    input.region
  );
  const creditUsage = usage.usageBreakdownList?.find(
    (item) => item.resourceType === "CREDIT" || item.displayName === "Credits"
  );
  const baseLimit = creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0;
  const baseCurrent = creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0;
  const freeTrialActive = creditUsage?.freeTrialInfo?.freeTrialStatus === "ACTIVE";
  const freeTrialLimit = freeTrialActive ? creditUsage?.freeTrialInfo?.usageLimitWithPrecision ?? creditUsage?.freeTrialInfo?.usageLimit ?? 0 : 0;
  const freeTrialCurrent = freeTrialActive ? creditUsage?.freeTrialInfo?.currentUsageWithPrecision ?? creditUsage?.freeTrialInfo?.currentUsage ?? 0 : 0;
  const bonuses = (creditUsage?.bonuses ?? []).filter((bonus) => bonus.status === "ACTIVE").map((bonus) => ({
    code: bonus.bonusCode || "",
    name: bonus.displayName || "",
    current: bonus.currentUsageWithPrecision ?? bonus.currentUsage ?? 0,
    limit: bonus.usageLimitWithPrecision ?? bonus.usageLimit ?? 0,
    expiresAt: bonus.expiresAt
  }));
  const totalLimit = baseLimit + freeTrialLimit + bonuses.reduce((sum, bonus) => sum + bonus.limit, 0);
  const totalCurrent = baseCurrent + freeTrialCurrent + bonuses.reduce((sum, bonus) => sum + bonus.current, 0);
  const subscriptionTitle = usage.subscriptionInfo?.subscriptionTitle || "Free";
  const expiresAt = usage.nextDateReset ? new Date(usage.nextDateReset).getTime() : void 0;
  const now = Date.now();
  const displayName = usage.userInfo?.email || `Kiro API Key ••••${input.key.slice(-4)}`;
  return await accountStoreCoordinator.runExclusive(async () => {
    await initStore();
    const current = store.get("accountData", EMPTY_ACCOUNT_DATA);
    if (hasStoredKskAccount(current, input.key)) return { ...input, added: false };
    if (input.groupId && !current.groups?.[input.groupId]) {
      throw new Error("自动拉取目标分组已不存在，请重新选择分组");
    }
    const account = {
      id: crypto.randomUUID(),
      email: displayName,
      userId: usage.userInfo?.userId || void 0,
      nickname: displayName,
      idp: "BuilderId",
      groupId: input.groupId,
      tags: [],
      credentials: {
        credentialKind: "kiro_api_key",
        kiroApiKey: input.key,
        region: input.region,
        provider: "BuilderId"
      },
      subscription: {
        type: resolveKskSubscriptionType(subscriptionTitle),
        title: subscriptionTitle,
        rawType: usage.subscriptionInfo?.type,
        expiresAt,
        daysRemaining: expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / (1e3 * 60 * 60 * 24))) : void 0,
        managementTarget: usage.subscriptionInfo?.subscriptionManagementTarget,
        upgradeCapability: usage.subscriptionInfo?.upgradeCapability,
        overageCapability: usage.subscriptionInfo?.overageCapability
      },
      usage: {
        current: totalCurrent,
        limit: totalLimit,
        percentUsed: totalLimit > 0 ? totalCurrent / totalLimit * 100 : 0,
        lastUpdated: now,
        baseLimit,
        baseCurrent,
        freeTrialLimit,
        freeTrialCurrent,
        freeTrialExpiry: creditUsage?.freeTrialInfo?.freeTrialExpiry,
        bonuses,
        nextResetDate: usage.nextDateReset
      },
      status: "active",
      isActive: false,
      createdAt: now,
      lastUsedAt: now,
      lastCheckedAt: now
    };
    const next = {
      ...current,
      accounts: { ...current.accounts ?? {}, [account.id]: account }
    };
    store.set("accountData", next);
    lastSavedData = next;
    await createBackup(next);
    return {
      ...input,
      added: true,
      accountId: account.id,
      usageCurrent: totalCurrent,
      usageLimit: totalLimit
    };
  });
}
async function resolveKskLivenessModelId(probeAccount, configured) {
  const explicit = configured?.trim();
  if (explicit) return explicit;
  try {
    const models = await fetchKiroModels(probeAccount);
    return pickCheapestModelId(models) ?? KSK_CLEANUP_FALLBACK_MODEL;
  } catch (error) {
    console.warn(
      "[KSK] Failed to list models for liveness probe, falling back to",
      KSK_CLEANUP_FALLBACK_MODEL,
      error
    );
    return KSK_CLEANUP_FALLBACK_MODEL;
  }
}
function toKskProbeAccount(input) {
  return {
    id: "ksk-liveness-probe",
    credentialKind: "kiro_api_key",
    kiroApiKey: input.key,
    region: input.region,
    provider: "BuilderId"
  };
}
async function probeKskAccountLiveness(account, model, message) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KSK_CLEANUP_PROBE_TIMEOUT_MS);
  try {
    const payload = openaiToKiro({
      model,
      messages: [{ role: "user", content: message }],
      stream: false,
      max_tokens: KSK_CLEANUP_MAX_OUTPUT_TOKENS
    });
    await callKiroApi(account, payload, controller.signal);
    return KSK_PROBE_VERDICT.ALIVE;
  } catch (error) {
    if (controller.signal.aborted) return KSK_PROBE_VERDICT.TRANSIENT;
    return classifyKskProbeError(error);
  } finally {
    clearTimeout(timer);
  }
}
async function probeLocalAdminPushCandidateLiveness(candidate) {
  const isApiKey = candidate.credentialKind === "kiro_api_key" || Boolean(candidate.kiroApiKey);
  const region = candidate.region?.trim() || "us-east-1";
  let probeAccount;
  if (isApiKey) {
    const key = candidate.kiroApiKey?.trim();
    if (!key) {
      return { verdict: LOCAL_ADMIN_PROBE_VERDICT.TRANSIENT, error: "账号缺少 Kiro API Key" };
    }
    probeAccount = {
      id: "local-admin-push-probe",
      credentialKind: "kiro_api_key",
      kiroApiKey: key,
      region,
      provider: "BuilderId"
    };
  } else {
    const refreshToken = candidate.refreshToken?.trim();
    if (!refreshToken) {
      return { verdict: LOCAL_ADMIN_PROBE_VERDICT.TRANSIENT, error: "账号缺少 Refresh Token" };
    }
    const refreshed = await refreshUnmanagedKiroCredentials(
      refreshToken,
      candidate.clientId?.trim() || "",
      candidate.clientSecret?.trim() || "",
      region,
      candidate.authMethod === "social" ? "social" : void 0
    );
    if (!refreshed.success || !refreshed.accessToken) {
      return {
        verdict: LOCAL_ADMIN_PROBE_VERDICT.PERMANENTLY_INVALID,
        error: refreshed.error || "刷新 Access Token 失败"
      };
    }
    probeAccount = {
      id: "local-admin-push-probe",
      accessToken: refreshed.accessToken,
      refreshToken,
      clientId: candidate.clientId,
      clientSecret: candidate.clientSecret,
      region,
      authMethod: candidate.authMethod,
      provider: "BuilderId"
    };
  }
  const model = await resolveKskLivenessModelId(probeAccount);
  const message = resolveKskLivenessMessage();
  try {
    const verdict = await probeKskAccountLiveness(probeAccount, model, message);
    if (verdict === KSK_PROBE_VERDICT.ALIVE) {
      return { verdict: LOCAL_ADMIN_PROBE_VERDICT.ALIVE };
    }
    return {
      verdict: verdict === KSK_PROBE_VERDICT.PERMANENTLY_INVALID ? LOCAL_ADMIN_PROBE_VERDICT.PERMANENTLY_INVALID : LOCAL_ADMIN_PROBE_VERDICT.TRANSIENT,
      error: verdict === KSK_PROBE_VERDICT.PERMANENTLY_INVALID ? "发消息验活失败：账号已失效（认证失败 / 封禁 / 配额耗尽）" : "发消息验活暂时无法确认（超时 / 限流 / 上游 5xx）"
    };
  } catch (error) {
    return {
      verdict: LOCAL_ADMIN_PROBE_VERDICT.TRANSIENT,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
async function cleanupInvalidStoredKskAccounts(groupId, liveness = {}) {
  const candidates = await accountStoreCoordinator.runExclusive(async () => {
    await initStore();
    const data = store.get("accountData", EMPTY_ACCOUNT_DATA);
    return Object.values(data.accounts ?? {}).filter(
      (account) => account.groupId === groupId && account.credentials?.credentialKind === "kiro_api_key" && Boolean(account.credentials.kiroApiKey && account.credentials.region)
    );
  });
  const result = {
    checked: candidates.length,
    removed: 0,
    retainedTransient: 0,
    errors: []
  };
  if (candidates.length === 0) return result;
  const toProxyAccount = (account) => ({
    id: account.id,
    email: account.email,
    credentialKind: "kiro_api_key",
    kiroApiKey: account.credentials.kiroApiKey,
    region: account.credentials.region,
    provider: "BuilderId",
    proxyUrl: readAccountBoundProxyUrl(account.id)
  });
  const model = await resolveKskLivenessModelId(toProxyAccount(candidates[0]), liveness.model);
  const message = resolveKskLivenessMessage(liveness.message);
  const permanentlyInvalid = /* @__PURE__ */ new Map();
  await mapWithConcurrency(candidates, KSK_CREDENTIAL_VALIDATION_CONCURRENCY, async (account) => {
    const verdict = await probeKskAccountLiveness(toProxyAccount(account), model, message);
    if (verdict === KSK_PROBE_VERDICT.PERMANENTLY_INVALID) {
      permanentlyInvalid.set(account.id, {
        key: account.credentials.kiroApiKey,
        groupId: account.groupId
      });
    } else if (verdict === KSK_PROBE_VERDICT.TRANSIENT) {
      result.retainedTransient++;
    }
    return void 0;
  });
  if (permanentlyInvalid.size === 0) return result;
  const removedIds = await accountStoreCoordinator.runExclusive(async () => {
    await initStore();
    const current = store.get("accountData", EMPTY_ACCOUNT_DATA);
    const { data: next, removedIds: removedIds2 } = removeMatchingInvalidKskAccounts(current, permanentlyInvalid);
    if (removedIds2.length === 0) return removedIds2;
    store.set("accountData", next);
    lastSavedData = next;
    await createBackup(next);
    return removedIds2;
  });
  const retiredAt = Date.now();
  await Promise.all(
    removedIds.map(
      (accountId) => markKskLedgerRetired({
        accountId,
        at: retiredAt,
        reason: KSK_LEDGER_RETIRE_REASON.INVALID
      }).catch((error) => {
        console.warn("[KskLedger] Failed to mark retired:", error);
      })
    )
  );
  result.removed = removedIds.length;
  result.removedKeys = removedIds.map((accountId) => permanentlyInvalid.get(accountId)?.key).filter((key) => Boolean(key));
  return result;
}
async function removeStoredKskAccountsByHash(hashes) {
  if (hashes.size === 0) return { removedIds: [], removedKeys: [] };
  return await accountStoreCoordinator.runExclusive(async () => {
    await initStore();
    const current = store.get("accountData", EMPTY_ACCOUNT_DATA);
    const doomed = /* @__PURE__ */ new Map();
    for (const account of Object.values(current.accounts ?? {})) {
      const key = account.credentials?.kiroApiKey;
      if (account.credentials?.credentialKind !== "kiro_api_key" || !key) continue;
      if (!hashes.has(sha256Hex(key))) continue;
      doomed.set(account.id, { key, groupId: account.groupId });
    }
    if (doomed.size === 0) return { removedIds: [], removedKeys: [] };
    const { data: next, removedIds } = removeMatchingInvalidKskAccounts(current, doomed);
    if (removedIds.length === 0) return { removedIds: [], removedKeys: [] };
    store.set("accountData", next);
    lastSavedData = next;
    await createBackup(next);
    return {
      removedIds,
      removedKeys: removedIds.map((accountId) => doomed.get(accountId)?.key).filter((key) => Boolean(key))
    };
  });
}
async function cleanupExhaustedLocalAdminCredentials(credentials) {
  const exhausted = selectExhaustedLocalAdminCredentials(credentials);
  const summary = {
    ...EMPTY_LOCAL_ADMIN_EXHAUSTED_CLEANUP,
    checked: credentials.filter((credential) => credential.usage).length,
    exhausted: exhausted.length,
    removedMaskedKeys: [],
    errors: []
  };
  if (exhausted.length === 0) return summary;
  const target = await resolveLocalAdminTarget();
  const removal = await deleteLocalAdminCredentialsById({
    credentials: exhausted.map((credential) => ({
      credentialId: credential.id,
      disabled: credential.disabled
    })),
    baseUrl: target.baseUrl,
    adminApiKey: target.adminApiKey,
    timeoutSeconds: target.timeoutSeconds,
    fetchImpl: localAdminFetchImpl
  });
  summary.removed = removal.deleted.length;
  summary.errors.push(...removal.errors);
  summary.removedMaskedKeys = removal.deleted.map(
    (item) => item.maskedApiKey || `#${item.credentialId}`
  );
  const hashes = new Set(
    removal.deleted.map((item) => item.apiKeyHash).filter((hash) => Boolean(hash))
  );
  try {
    const local = await removeStoredKskAccountsByHash(hashes);
    summary.removedLocalAccounts = local.removedIds.length;
    const retiredAt = Date.now();
    await Promise.all(
      local.removedIds.map(
        (accountId) => markKskLedgerRetired({
          accountId,
          at: retiredAt,
          reason: KSK_LEDGER_RETIRE_REASON.EXHAUSTED
        }).catch((error) => {
          console.warn("[KskLedger] Failed to mark retired:", error);
        })
      )
    );
    kskAutomationManager.blacklistKeys(local.removedKeys);
    if (local.removedIds.length > 0) sendKskAutomationAccountsChanged(() => mainWindow);
  } catch (error) {
    summary.errors.push(
      `已从 Admin 删除，但清理本地账号失败：${error instanceof Error ? error.message : String(error)}`
    );
  }
  return summary;
}
async function syncKskLedgerFromAccounts() {
  try {
    const observations = await accountStoreCoordinator.runExclusive(async () => {
      await initStore();
      const data = store.get("accountData", EMPTY_ACCOUNT_DATA);
      return Object.entries(data.accounts ?? {}).map(([accountId, account]) => ({
        accountId,
        currentUsage: account.usage?.current,
        usageLimit: account.usage?.limit
      }));
    });
    await updateKskLedgerFromAccounts({ observations, at: Date.now() });
  } catch (error) {
    console.warn("[KskLedger] Failed to sync from accounts:", error);
  }
}
async function readKskAccountsForLocalAdmin(groupId) {
  return await accountStoreCoordinator.runExclusive(async () => {
    await initStore();
    const data = store.get("accountData", EMPTY_ACCOUNT_DATA);
    return Object.values(data.accounts ?? {}).flatMap((account) => {
      const key = account.credentials?.kiroApiKey?.trim();
      const region = account.credentials?.region?.trim();
      if (account.groupId !== groupId || account.credentials?.credentialKind !== "kiro_api_key" || !key || !region) {
        return [];
      }
      return [{ kiroApiKey: key, region, email: account.email }];
    });
  });
}
const localAdminFetchImpl = async (url, init) => await undici.fetch(url, {
  method: init.method,
  headers: init.headers,
  body: init.body,
  signal: init.signal,
  dispatcher: localAdminDirectAgent
});
const kskAutomationManager = new KskAutomationManager({
  readStore: loadKskAutomationStore,
  readTask: loadKskAutomationTask,
  fetchImpl: (url, init) => fetchWithAppProxy(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal
  }),
  localAdminFetchImpl,
  importCredential: importProviderKskCredential,
  readLocalAdminAccounts: readKskAccountsForLocalAdmin,
  cleanupProxyAccounts: cleanupInvalidStoredKskAccounts,
  notifyStatus: (status) => sendKskAutomationStatus(() => mainWindow, status),
  notifyAccountsChanged: () => sendKskAutomationAccountsChanged(() => mainWindow),
  log: (message) => console.log(message)
});
const localAdminStatsManager = new LocalAdminStatsManager({
  readTarget: async () => {
    try {
      return await resolveLocalAdminTarget();
    } catch {
      return void 0;
    }
  },
  fetchImpl: localAdminFetchImpl,
  cleanupExhausted: cleanupExhaustedLocalAdminCredentials,
  notifySnapshot: (snapshot) => sendLocalAdminStatsSnapshot(() => mainWindow, snapshot),
  log: (message) => console.log(message)
});
const kskHunterManager = new KskHunterManager({
  readStore: loadKskHunterStore,
  fetchImpl: (url, init) => fetchWithAppProxy(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal
  }),
  // 下游是 loopback，必须绕开系统代理；与本机 Admin 复用同一个直连 agent
  downstreamFetchImpl: localAdminFetchImpl,
  importCredential: async (input) => {
    const result = await importProviderKskCredential(input);
    if (result.rejected) throw new Error("发消息验活未通过，该号已不可用");
    return {
      added: result.added,
      accountId: result.accountId,
      usageCurrent: result.usageCurrent,
      usageLimit: result.usageLimit
    };
  },
  notifyInStock: ({ linkName, title, region }) => {
    localNotifications.notify(LocalNoticeKind.KskHunterInStock, {
      hunterKey: `${linkName}:${title}:${region}`,
      bodyOverride: `${linkName} · ${title}${region ? `（${region}）` : ""} 已开货，尽快下单。`
    });
  },
  notifyOrdered: ({ linkName, maskedKey, region }) => {
    localNotifications.notify(LocalNoticeKind.KskHunterOrdered, {
      hunterKey: `${linkName}:${maskedKey}`,
      bodyOverride: `${linkName} 已抢到 ${maskedKey}（${region}），正在验活并推送下游。`
    });
  },
  // 台账报表要显示分组名；台账只存 id，分组可改名，所以每次现查
  readGroupNames: async () => accountStoreCoordinator.runExclusive(async () => {
    await initStore();
    const data = store.get("accountData", EMPTY_ACCOUNT_DATA);
    return Object.fromEntries(
      Object.entries(data.groups ?? {}).map(([id, group]) => [id, group.name || id])
    );
  }),
  notifyAccountsChanged: () => sendKskAutomationAccountsChanged(() => mainWindow),
  notifyBudgetExhausted: ({ scope, channelLabel, spentCny, limitCny }) => {
    const unit = scope === "global" ? "¥" : "";
    localNotifications.notify(LocalNoticeKind.KskHunterBudgetExhausted, {
      hunterKey: `${hunterLocalDateKey()}:${scope}:${channelLabel ?? "all"}`,
      bodyOverride: `${scope === "global" ? "全局" : channelLabel} 当日花费 ${unit}${spentCny} 已达上限 ${unit}${limitCny}，已暂停自动下单；开货仍会提醒。`
    });
  },
  notifyLowBalance: ({ channel, balanceUnit, thresholdUnit, unitLabel }) => {
    localNotifications.notify(LocalNoticeKind.KskHunterLowBalance, {
      hunterKey: `${hunterLocalDateKey()}:${channel}`,
      bodyOverride: `${KSK_HUNTER_CHANNEL_LABEL[channel]} 余额仅剩 ${balanceUnit} ${unitLabel}（阈值 ${thresholdUnit}），请及时充值。`
    });
  },
  notifySnapshot: () => {
    void sendKskHunterStatus(() => mainWindow, kskHunterManager).catch(() => {
    });
  },
  log: (message) => console.log(message)
});
const downstreamSettlementManager = new DownstreamSettlementManager({
  readCsvDir: async () => (await loadKskHunterStore()).config.csvExportDir,
  userDataDir: () => electron.app.getPath("userData"),
  readLedgerUsage: async () => {
    const entries = await loadKskLedger();
    return Object.fromEntries(
      entries.map((entry) => [
        entry.accountId,
        {
          accountId: entry.accountId,
          usedCredits: entry.usedCredits,
          usageLimit: entry.usageLimit,
          state: resolveLedgerState(entry)
        }
      ])
    );
  },
  // 分组名要现查：交付账本只存 id，分组随时可能改名或被删
  readGroupNames: async () => accountStoreCoordinator.runExclusive(async () => {
    await initStore();
    const data = store.get("accountData", EMPTY_ACCOUNT_DATA);
    return Object.fromEntries(
      Object.entries(data.groups ?? {}).map(([id, group]) => [id, group.name || id])
    );
  }),
  log: (message) => console.log(message)
});
async function initStoreInternal() {
  const Store = (await import("electron-store")).default;
  const path2 = await import("path");
  const storeInstance = new Store({
    name: APP_ACCOUNT_STORE_NAME,
    encryptionKey: APP_ACCOUNT_STORE_ENCRYPTION_KEY
  });
  store = storeInstance;
  try {
    const mainData = storeInstance.get("accountData");
    if (!mainData) {
      try {
        const { readSecureBackup } = await Promise.resolve().then(() => require("./secureBackup-SaFkzl4k.js"));
        const backupData = await readSecureBackup(path2.dirname(storeInstance.path));
        if (backupData?.accounts) {
          console.log("[Store] Restoring data from backup...");
          storeInstance.set("accountData", backupData);
          console.log("[Store] Data restored from backup successfully");
        }
      } catch {
      }
    }
  } catch (error) {
    console.error("[Store] Error checking backup:", error);
  }
  try {
    if (storeInstance.has(LEGACY_PROACTIVE_RENEWAL_KEY)) {
      storeInstance.delete(LEGACY_PROACTIVE_RENEWAL_KEY);
    }
    const accountData = storeInstance.get("accountData");
    if (accountData && typeof accountData === "object" && !Array.isArray(accountData)) {
      const cleaned = removeLegacyStorageKeys(accountData, LEGACY_ACCOUNT_DATA_KEYS);
      if (cleaned.changed) storeInstance.set("accountData", cleaned.value);
    }
  } catch (error) {
    console.error("[Store] Legacy settings cleanup failed:", error);
  }
  try {
    migrateAccountDataIfNeeded();
  } catch (error) {
    console.error("[Store] Account data migration failed:", error);
  }
  const savedUsageApiType = storeInstance.get("usageApiType");
  if (savedUsageApiType) {
    setUsageApiType(savedUsageApiType);
  }
}
function migrateAccountDataIfNeeded() {
  if (!store) return;
  const MIGRATION_KEY = "accountDataMigration";
  const FLAG = "builderIdArn";
  const migrationState = store.get(MIGRATION_KEY, {}) || {};
  const accountData = store.get("accountData");
  if (!accountData?.accounts) {
    if (!migrationState[FLAG]) {
      store.set(MIGRATION_KEY, { ...migrationState, [FLAG]: 1 });
    }
    return;
  }
  if (!migrationState[FLAG]) {
    store.set(MIGRATION_KEY, { ...migrationState, [FLAG]: 1 });
  }
}
const BACKUP_THROTTLE_MS = 5 * 60 * 1e3;
let lastBackupTime = 0;
let pendingBackupData = null;
let pendingBackupTimer = null;
async function createBackup(data) {
  pendingBackupData = data;
  const now = Date.now();
  const elapsed = now - lastBackupTime;
  if (elapsed >= BACKUP_THROTTLE_MS) {
    await writeBackupNow();
    return;
  }
  if (!pendingBackupTimer) {
    const delay = BACKUP_THROTTLE_MS - elapsed;
    pendingBackupTimer = setTimeout(() => {
      pendingBackupTimer = null;
      void writeBackupNow();
    }, delay);
  }
}
async function writeBackupNow() {
  if (!store || pendingBackupData == null) return;
  const data = pendingBackupData;
  pendingBackupData = null;
  lastBackupTime = Date.now();
  try {
    const path2 = await import("path");
    const { writeSecureBackup, isSecureBackupAvailable } = await Promise.resolve().then(() => require("./secureBackup-SaFkzl4k.js"));
    await writeSecureBackup(path2.dirname(store.path), data);
    console.log(
      `[Backup] Data backup created (${isSecureBackupAvailable() ? "encrypted" : "plaintext-fallback"})`
    );
  } catch (error) {
    console.error("[Backup] Failed to create backup:", error);
  }
}
async function flushBackupNow() {
  if (pendingBackupTimer) {
    clearTimeout(pendingBackupTimer);
    pendingBackupTimer = null;
  }
  if (pendingBackupData != null) {
    await writeBackupNow();
  }
}
let mainWindow = null;
let backgroundBatchRefreshImpl = null;
const poolRefreshInFlightIds = /* @__PURE__ */ new Set();
let mainPoolRefreshTimer = null;
function isBannedAccountErrorMain(error) {
  if (!error) return false;
  const e = error.toLowerCase();
  return e.includes("accountsuspendedexception") || e.includes("account suspended") || e.includes("temporarily_suspended") || e.includes("temporarily suspended") || e.includes("已封禁") || /\b423\b/.test(e);
}
function mainTokenRefreshLeadMs(intervalMin) {
  return Math.max(intervalMin * 2 * 60 * 1e3, 10 * 60 * 1e3);
}
async function runMainPoolTokenRefreshTick() {
  if (!backgroundBatchRefreshImpl) return;
  try {
    if (!store) {
      await initStore();
    }
    if (!store) return;
    const data = store.get("accountData");
    if (!data?.accounts) return;
    if (data.autoRefreshEnabled === false) return;
    const intervalMin = Math.max(1, data.autoRefreshInterval ?? 5);
    const leadMs = mainTokenRefreshLeadMs(intervalMin);
    const concurrency = Math.max(1, Math.min(500, data.autoRefreshConcurrency ?? 100));
    const now = Date.now();
    const toRefresh = [];
    for (const [id, acc] of Object.entries(data.accounts)) {
      const creds = acc?.credentials;
      const refreshPlan = buildBackgroundRefreshPlan(creds || {}, true);
      if (!refreshPlan.shouldRefreshToken || !creds?.refreshToken) continue;
      if (isBannedAccountErrorMain(acc.lastError)) continue;
      const expiresAt = creds.expiresAt;
      if (!expiresAt || expiresAt - now > leadMs) continue;
      toRefresh.push({
        id,
        idp: acc.idp,
        profileArn: acc.profileArn,
        needsTokenRefresh: true,
        credentials: {
          credentialKind: refreshPlan.credentialKind,
          kiroApiKey: refreshPlan.kiroApiKey,
          refreshToken: creds.refreshToken,
          credentialRevision: creds.credentialRevision,
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
          region: creds.region,
          authMethod: creds.authMethod,
          accessToken: refreshPlan.accessToken,
          provider: creds.provider,
          profileArn: creds.profileArn
        }
      });
    }
    if (toRefresh.length === 0) return;
    console.log(
      `[MainPoolRefresh] ${toRefresh.length} token(s) expiring within ${Math.round(leadMs / 6e4)}min, refreshing...`
    );
    await backgroundBatchRefreshImpl(toRefresh, concurrency, false);
  } catch (err) {
    console.warn("[MainPoolRefresh] tick failed:", err instanceof Error ? err.message : err);
  }
}
function startMainPoolTokenRefresh() {
  stopMainPoolTokenRefresh();
  setTimeout(() => {
    void runMainPoolTokenRefreshTick();
  }, 15e3);
  mainPoolRefreshTimer = setInterval(() => {
    void runMainPoolTokenRefreshTick();
  }, 6e4);
  console.log("[MainPoolRefresh] Scheduler started (main process, checks every 60s)");
}
function stopMainPoolTokenRefresh() {
  if (mainPoolRefreshTimer) {
    clearInterval(mainPoolRefreshTimer);
    mainPoolRefreshTimer = null;
  }
}
let traySettings = { ...defaultTraySettings };
let isQuitting = false;
let resolvedNotificationLanguage = "zh";
const RENDERER_NOTICE_KINDS = /* @__PURE__ */ new Set([
  LocalNoticeKind.RegistrationRiskPaused,
  LocalNoticeKind.RegistrationBatchCompleted
]);
const localNotifications = new LocalNotificationService(
  () => traySettings,
  () => resolvedNotificationLanguage,
  (page) => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send("local-notification-navigate", page);
  }
);
let showWindowShortcut = process.platform === "darwin" ? "Command+Shift+K" : "Ctrl+Shift+K";
async function loadShortcutSettings() {
  try {
    await initStore();
    const saved = store?.get("showWindowShortcut");
    if (saved) {
      showWindowShortcut = saved;
    }
  } catch (error) {
    console.error("[Shortcut] Failed to load shortcut settings:", error);
  }
}
async function saveShortcutSettings() {
  try {
    await initStore();
    store?.set("showWindowShortcut", showWindowShortcut);
  } catch (error) {
    console.error("[Shortcut] Failed to save shortcut settings:", error);
  }
}
function registerShowWindowShortcut() {
  electron.globalShortcut.unregisterAll();
  if (!showWindowShortcut) return;
  try {
    const success = electron.globalShortcut.register(showWindowShortcut, () => {
      if (mainWindow) {
        if (process.platform === "darwin" && electron.app.dock) {
          electron.app.dock.show();
        }
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });
    if (success) {
      console.log(`[Shortcut] Registered: ${showWindowShortcut}`);
    } else {
      console.warn(`[Shortcut] Failed to register: ${showWindowShortcut}`);
    }
  } catch (error) {
    console.error("[Shortcut] Error registering shortcut:", error);
  }
}
let currentProxyAccount = null;
let allAccounts = [];
async function loadTraySettings() {
  try {
    await initStore();
    const saved = store?.get("traySettings");
    if (saved) {
      traySettings = { ...defaultTraySettings, ...saved };
    }
  } catch (error) {
    console.error("[Tray] Failed to load tray settings:", error);
  }
}
async function saveTraySettings() {
  try {
    await initStore();
    store?.set("traySettings", traySettings);
  } catch (error) {
    console.error("[Tray] Failed to save tray settings:", error);
  }
}
function initTray() {
  if (!traySettings.enabled) return;
  createTray({
    onShowWindow: () => {
      if (mainWindow) {
        if (process.platform === "darwin" && electron.app.dock) electron.app.dock.show();
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    },
    onQuit: () => {
      isQuitting = true;
      electron.app.quit();
    },
    onRefreshAccount: async () => {
      mainWindow?.webContents.send("tray-refresh-account");
    },
    onSwitchAccount: async () => {
      mainWindow?.webContents.send("tray-switch-account");
    },
    getCurrentAccount: () => currentProxyAccount,
    getAccountList: () => allAccounts
  });
  setTrayTooltip(`${APP_NAME} v${electron.app.getVersion()}`);
}
function createWindow() {
  const isMac = process.platform === "darwin";
  mainWindow = new electron.BrowserWindow({
    title: `${APP_NAME} v${electron.app.getVersion()}`,
    width: 1200,
    // 刚好容纳 3 列卡片 (340*3 + 16*2 + 边距)
    height: 1200,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    icon,
    // 自定义 titlebar：mac 保留红绿黄灯 + 隐藏标题栏；win/linux 完全无 frame
    frame: isMac,
    titleBarStyle: isMac ? "hiddenInset" : "default",
    trafficLightPosition: isMac ? { x: 14, y: 12 } : void 0,
    // 不透明窗口（关闭透明 + Mica/Vibrancy 避免桌面元素干扰）
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // 关闭后台节流：最小化到托盘后窗口被隐藏，Chromium 默认会把渲染进程里的
      // setInterval（含 token 自动刷新定时器）重度降频（对齐到约每分钟甚至更慢），
      // 导致挂托盘时 token 过期好几分钟才刷新。关掉它保证定时器照常运行。
      backgroundThrottling: false
    }
  });
  mainWindow.webContents.on("before-input-event", (event, input) => {
    const action = resolveWindowZoomAction(input);
    if (!action || !mainWindow) return;
    event.preventDefault();
    const currentLevel = mainWindow.webContents.getZoomLevel();
    mainWindow.webContents.setZoomLevel(getNextWindowZoomLevel(currentLevel, action));
  });
  mainWindow.on("maximize", () => mainWindow?.webContents.send("window-maximize-changed", true));
  mainWindow.on("unmaximize", () => mainWindow?.webContents.send("window-maximize-changed", false));
  mainWindow.on("ready-to-show", () => {
    mainWindow?.setTitle(`${APP_NAME} v${electron.app.getVersion()}`);
    mainWindow?.show();
  });
  mainWindow.on("close", (event) => {
    if (traySettings.enabled && !isQuitting) {
      if (traySettings.closeAction === "minimize") {
        event.preventDefault();
        mainWindow?.hide();
        if (process.platform === "darwin" && electron.app.dock) {
          electron.app.dock.hide();
        }
        return;
      } else if (traySettings.closeAction === "ask" && mainWindow) {
        event.preventDefault();
        mainWindow.webContents.send("show-close-confirm-dialog");
        return;
      }
    }
    if (lastSavedData && store) {
      void accountStoreCoordinator.runExclusive(async () => {
        try {
          console.log("[Window] Saving data before close...");
          store.set("accountData", lastSavedData);
          await createBackup(lastSavedData);
          console.log("[Window] Data saved successfully");
        } catch (error) {
          console.error("[Window] Failed to save data:", error);
        }
      });
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler((details) => {
    electron.shell.openExternal(details.url);
    return { action: "deny" };
  });
  if (utils.is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}
function registerProtocol() {
  unregisterProtocol();
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      electron.app.setAsDefaultProtocolClient(PROTOCOL_PREFIX, process.execPath, [path.join(process.argv[1])]);
    }
  } else {
    electron.app.setAsDefaultProtocolClient(PROTOCOL_PREFIX);
  }
  console.log(`[Protocol] Registered ${PROTOCOL_PREFIX}:// protocol`);
}
function unregisterProtocol() {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      electron.app.removeAsDefaultProtocolClient(PROTOCOL_PREFIX, process.execPath, [path.join(process.argv[1])]);
    }
  } else {
    electron.app.removeAsDefaultProtocolClient(PROTOCOL_PREFIX);
  }
  console.log(`[Protocol] Unregistered ${PROTOCOL_PREFIX}:// protocol`);
}
function handleProtocolUrl(url) {
  if (!url.startsWith(`${PROTOCOL_PREFIX}://`)) return;
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname.replace(/^\/+/, "");
    if (pathname === "auth/callback" || urlObj.host === "auth") {
      const code = urlObj.searchParams.get("code");
      const state = urlObj.searchParams.get("state");
      if (code && state && mainWindow) {
        mainWindow.webContents.send("auth-callback", { code, state });
        mainWindow.focus();
      }
    }
  } catch (error) {
    console.error("Failed to parse protocol URL:", error);
  }
}
electron.app.whenReady().then(async () => {
  proxyLogStore.initialize(electron.app.getPath("userData"));
  interceptConsole();
  await initStore();
  registerProtocol();
  await loadTraySettings();
  initTray();
  utils.electronApp.setAppUserModelId(APP_ID);
  electron.app.on("browser-window-created", (_, window) => {
    utils.optimizer.watchWindowShortcuts(window);
  });
  electron.ipcMain.on("open-external", (_event, url) => {
    if (typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"))) {
      electron.shell.openExternal(url);
    }
  });
  electron.ipcMain.on("open-incognito-browser", (_event, url) => {
    if (typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"))) {
      openBrowserInPrivateMode(url);
    }
  });
  electron.ipcMain.on("close-incognito-browser", () => {
    closePrivateBrowserWindow();
  });
  registerIPCHandlers(() => mainWindow);
  void proxyPoolScheduler.start().catch((err) => {
    console.warn("[ProxyPoolScheduler] Failed to start:", err);
  });
  registerKskAutomationIpcHandlers({
    getManager: () => kskAutomationManager,
    getMainWindow: () => mainWindow,
    localAdminFetchImpl,
    probeLocalAdminPushLiveness: probeLocalAdminPushCandidateLiveness
  });
  void kskAutomationManager.start().catch((err) => {
    console.warn("[KskAutomation] Failed to start:", err);
  });
  registerLocalAdminStatsIpcHandlers({
    getManager: () => localAdminStatsManager,
    getMainWindow: () => mainWindow
  });
  void localAdminStatsManager.start().catch((err) => {
    console.warn("[LocalAdminStats] Failed to start:", err);
  });
  registerKskHunterIpcHandlers({
    getManager: () => kskHunterManager,
    getMainWindow: () => mainWindow
  });
  void kskHunterManager.start().catch((err) => {
    console.warn("[KskHunter] Failed to start:", err);
  });
  registerDownstreamSettlementIpcHandlers({
    getManager: () => downstreamSettlementManager,
    getMainWindow: () => mainWindow,
    saveCsvDir: async (dir) => {
      await updateKskHunterConfig({ csvExportDir: dir }, void 0);
    }
  });
  void downstreamSettlementManager.start().catch((err) => {
    console.warn("[DownstreamSettlement] Failed to start:", err);
  });
  electron.ipcMain.handle("get-tray-settings", () => {
    return traySettings;
  });
  electron.ipcMain.handle(
    "local-notification",
    (_event, kind, input) => {
      if (!RENDERER_NOTICE_KINDS.has(kind)) return;
      localNotifications.notify(kind, {
        batchId: typeof input?.batchId === "string" ? input.batchId : void 0
      });
    }
  );
  electron.ipcMain.on("window-minimize", () => mainWindow?.minimize());
  electron.ipcMain.on("window-maximize-toggle", () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  electron.ipcMain.on("window-close", () => mainWindow?.close());
  electron.ipcMain.handle("window-is-maximized", () => !!mainWindow?.isMaximized());
  electron.ipcMain.handle("window-get-platform", () => process.platform);
  electron.ipcMain.handle("get-show-window-shortcut", () => {
    return showWindowShortcut;
  });
  electron.ipcMain.handle("set-show-window-shortcut", async (_event, shortcut) => {
    try {
      showWindowShortcut = shortcut;
      await saveShortcutSettings();
      registerShowWindowShortcut();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
  electron.ipcMain.handle("save-tray-settings", async (_event, settings) => {
    try {
      traySettings = { ...traySettings, ...settings };
      await saveTraySettings();
      if (settings.enabled !== void 0) {
        if (settings.enabled) {
          initTray();
        } else {
          destroyTray();
        }
      }
      return { success: true };
    } catch (error) {
      console.error("[Tray] Failed to save settings:", error);
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  });
  electron.ipcMain.on("update-tray-account", (_event, account) => {
    currentProxyAccount = account;
    updateCurrentAccount(account);
    if (account) {
      setTrayTooltip(`${APP_NAME}
当前账户: ${account.email}`);
    } else {
      setTrayTooltip(`${APP_NAME} v${electron.app.getVersion()}`);
    }
  });
  electron.ipcMain.on("update-tray-account-list", (_event, accounts) => {
    allAccounts = accounts;
    updateAccountList(accounts);
  });
  electron.ipcMain.on("refresh-tray-menu", () => {
    updateTrayMenu();
  });
  electron.ipcMain.on("update-tray-language", (_event, language) => {
    resolvedNotificationLanguage = language;
    updateTrayLanguage(language);
  });
  electron.ipcMain.on(
    "close-confirm-response",
    (_event, action, rememberChoice) => {
      if (action === "minimize") {
        mainWindow?.hide();
        if (process.platform === "darwin" && electron.app.dock) {
          electron.app.dock.hide();
        }
      } else if (action === "quit") {
        if (rememberChoice) {
          traySettings.closeAction = "quit";
          saveTraySettings();
        }
        isQuitting = true;
        electron.app.quit();
      }
      if (action === "minimize" && rememberChoice) {
        traySettings.closeAction = "minimize";
        saveTraySettings();
      }
    }
  );
  electron.ipcMain.handle("get-app-version", () => {
    return electron.app.getVersion();
  });
  electron.ipcMain.handle(
    "diagnose:run",
    async (_event, params) => {
      const { proxyUrl, targets } = params || {};
      const agent = proxyUrl ? safeCreateProxyAgent(proxyUrl) : void 0;
      const results = await Promise.all(
        (targets || []).map(async (t) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), t.timeoutMs ?? 8e3);
          const start = Date.now();
          try {
            const init = {
              method: "GET",
              signal: controller.signal,
              headers: { "User-Agent": DIAGNOSE_USER_AGENT }
            };
            if (agent) init.dispatcher = agent;
            const resp = await undici.fetch(t.url, init);
            const latencyMs = Date.now() - start;
            const expected = t.expectStatus;
            const ok = expected ? expected.includes(resp.status) : resp.status >= 200 && resp.status < 400;
            return {
              id: t.id,
              label: t.label,
              url: t.url,
              success: ok,
              httpStatus: resp.status,
              latencyMs,
              error: ok ? void 0 : `HTTP ${resp.status}`
            };
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            return {
              id: t.id,
              label: t.label,
              url: t.url,
              success: false,
              latencyMs: Date.now() - start,
              error: controller.signal.aborted ? "超时" : errMsg
            };
          } finally {
            clearTimeout(timer);
          }
        })
      );
      return { results };
    }
  );
  registerProxyPoolIpcHandlers();
  electron.ipcMain.handle("proxy-pool:restart-scheduler", async () => {
    try {
      await proxyPoolScheduler.start();
      return { success: true, running: proxyPoolScheduler.isRunning };
    } catch (err) {
      console.error("[proxy-pool:restart-scheduler] error:", err);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  electron.ipcMain.handle(
    "diagnose:http-probe",
    async (_event, params) => {
      const { url, method = "GET", timeoutMs = 5e3 } = params || {};
      if (!url) return { success: false, error: "Missing url" };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const start = Date.now();
      try {
        const resp = await fetchWithAppProxy(url, {
          method,
          signal: controller.signal,
          headers: { "User-Agent": DIAGNOSE_USER_AGENT }
        });
        const latencyMs = Date.now() - start;
        return { success: resp.ok, latencyMs, status: resp.status };
      } catch (err) {
        const isAbort = controller.signal.aborted;
        return {
          success: false,
          latencyMs: Date.now() - start,
          error: isAbort ? `Timeout (${timeoutMs}ms)` : err instanceof Error ? err.message : String(err)
        };
      } finally {
        clearTimeout(timer);
      }
    }
  );
  electron.ipcMain.handle(
    "diagnose:account-liveness",
    async (_event, params) => runCredentialRefreshOperation(
      {},
      async () => {
        const acc = params?.account;
        const model = (params?.model || "claude-sonnet-4.5").trim();
        const message = (params?.message || 'Hi, reply with "pong" only.').trim();
        const timeoutMs = params?.timeoutMs ?? 45e3;
        const start = Date.now();
        const isApiKeyAccount = acc?.credentialKind === "kiro_api_key";
        if (!acc || (isApiKeyAccount ? !acc.kiroApiKey : !acc.accessToken)) {
          return { success: false, error: "账号缺少上游凭据", latencyMs: 0 };
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          let accessToken = acc.accessToken;
          let refreshedCredentials;
          const needsRefresh = acc.expiresAt ? acc.expiresAt - Date.now() < 6e4 : false;
          if (!isApiKeyAccount && needsRefresh && acc.refreshToken) {
            try {
              const r = acc.id ? await refreshStoredKiroCredentials({
                accountId: acc.id,
                expectedRefreshToken: acc.refreshToken,
                expectedCredentialRevision: acc.credentialRevision,
                clientId: acc.clientId,
                clientSecret: acc.clientSecret,
                region: acc.region,
                authMethod: acc.authMethod,
                proxyUrl: acc.proxyUrl
              }) : await refreshUnmanagedKiroCredentials(
                acc.refreshToken,
                acc.clientId || "",
                acc.clientSecret || "",
                acc.region || "us-east-1",
                acc.authMethod,
                acc.proxyUrl
              );
              if (r.success && r.accessToken) {
                accessToken = r.accessToken;
                refreshedCredentials = {
                  accessToken: r.accessToken,
                  refreshToken: r.refreshToken || acc.refreshToken,
                  expiresAt: r.expiresAt ?? Date.now() + (r.expiresIn ?? 3600) * 1e3,
                  credentialRevision: r.credentialRevision
                };
              }
            } catch {
            }
          }
          const proxyAccount = {
            id: acc.id || "diagnose",
            email: acc.email,
            accessToken,
            refreshToken: acc.refreshToken,
            clientId: acc.clientId,
            clientSecret: acc.clientSecret,
            region: acc.region || "us-east-1",
            authMethod: acc.authMethod,
            provider: acc.provider,
            profileArn: acc.profileArn,
            proxyUrl: acc.proxyUrl,
            expiresAt: acc.expiresAt,
            credentialKind: acc.credentialKind,
            kiroApiKey: acc.kiroApiKey,
            preferredEndpoint: acc.preferredEndpoint,
            endpointFallbackOrder: acc.endpointFallbackOrder,
            endpointFallbackAfterFailures: acc.endpointFallbackAfterFailures
          };
          const payload = openaiToKiro(
            {
              model,
              messages: [{ role: "user", content: message }],
              stream: false,
              max_tokens: 64
            },
            proxyAccount.profileArn
          );
          const result = await callKiroApi(proxyAccount, payload, controller.signal);
          const latencyMs = Date.now() - start;
          const content = (result.content || "").trim();
          return {
            success: true,
            latencyMs,
            model,
            content: content.slice(0, 500),
            usage: {
              inputTokens: result.usage?.inputTokens || 0,
              outputTokens: result.usage?.outputTokens || 0,
              credits: result.usage?.credits || 0
            },
            credentials: refreshedCredentials
          };
        } catch (err) {
          const isAbort = controller.signal.aborted;
          const rawMsg = err instanceof Error ? err.message : String(err);
          return {
            success: false,
            latencyMs: Date.now() - start,
            model,
            error: isAbort ? `超时 (${timeoutMs}ms)` : rawMsg
          };
        } finally {
          clearTimeout(timer);
        }
      }
    )
  );
  electron.ipcMain.handle("load-accounts", async () => {
    try {
      await initStore();
      return store.get("accountData", EMPTY_ACCOUNT_DATA);
    } catch (error) {
      console.error("Failed to load accounts:", error);
      return null;
    }
  });
  electron.ipcMain.handle("save-accounts", async (_event, data) => {
    await accountStoreCoordinator.runExclusive(async () => {
      try {
        await initStore();
        const current = store.get("accountData", EMPTY_ACCOUNT_DATA);
        const merged = mergeAccountDataPreservingRotatedKiroCredentials(current, data);
        store.set("accountData", merged);
        lastSavedData = merged;
        await createBackup(merged);
      } catch (error) {
        console.error("Failed to save accounts:", error);
        throw error;
      }
    });
    kskAutomationManager.queueLocalAdminSync();
    void syncKskLedgerFromAccounts();
  });
  electron.ipcMain.handle(
    "refresh-account-token",
    async (_event, account) => runCredentialRefreshOperation(
      {},
      async () => {
        try {
          const {
            credentialKind,
            kiroApiKey,
            refreshToken,
            credentialRevision,
            clientId,
            clientSecret,
            region,
            authMethod,
            provider
          } = account.credentials || {};
          if (credentialKind === "kiro_api_key" || kiroApiKey) {
            return { success: false, error: { message: "Kiro API key accounts cannot refresh" } };
          }
          if (!refreshToken) {
            return { success: false, error: { message: "缺少 Refresh Token" } };
          }
          if (authMethod !== "social" && (!clientId || !clientSecret)) {
            return {
              success: false,
              error: { message: "缺少 OIDC 刷新凭证 (clientId/clientSecret)" }
            };
          }
          const boundProxyUrl = readAccountBoundProxyUrl(account.id || "");
          console.log(
            `[IPC] Refreshing token (authMethod: ${authMethod || "IdC"})...${boundProxyUrl ? " [via bound proxy]" : ""}`
          );
          const refreshResult = await refreshStoredKiroCredentials({
            accountId: account.id || "",
            expectedRefreshToken: refreshToken,
            expectedCredentialRevision: credentialRevision,
            clientId,
            clientSecret,
            region,
            authMethod,
            proxyUrl: boundProxyUrl
          });
          if (!refreshResult.success || !refreshResult.accessToken) {
            return { success: false, error: { message: refreshResult.error || "Token 刷新失败" } };
          }
          const newAccess = refreshResult.accessToken;
          const newRefresh = refreshResult.refreshToken || refreshToken;
          const expiresIn = refreshResult.expiresIn ?? 3600;
          let resolvedEnterpriseArn;
          const existingProfileArn = account.profileArn || account.credentials?.profileArn;
          if (!existingProfileArn) {
            const isEnt = provider === "Enterprise" || authMethod === "external_idp";
            if (isEnt) {
              try {
                resolvedEnterpriseArn = await fetchEnterpriseProfileArn({
                  id: account.id || "",
                  accessToken: newAccess,
                  region: region || "us-east-1",
                  provider,
                  authMethod
                });
                if (resolvedEnterpriseArn) {
                  console.log(
                    `[Refresh] Enterprise profileArn auto-resolved: ${resolvedEnterpriseArn}`
                  );
                }
              } catch (e) {
                console.warn("[Refresh] Failed to fetch Enterprise profileArn:", e);
              }
            }
          }
          return {
            success: true,
            data: {
              accessToken: newAccess,
              refreshToken: newRefresh,
              expiresIn,
              expiresAt: refreshResult.expiresAt,
              credentialRevision: refreshResult.credentialRevision,
              // Enterprise 自动获取的 profileArn（renderer 需要存储到账号数据）
              profileArn: resolvedEnterpriseArn || void 0
            }
          };
        } catch (error) {
          return {
            success: false,
            error: { message: error instanceof Error ? error.message : "Unknown error" }
          };
        }
      }
    )
  );
  electron.ipcMain.handle(
    "import-from-sso-token",
    async (_event, bearerToken, region = "us-east-1") => {
      console.log("[IPC] import-from-sso-token called");
      try {
        const ssoResult = await ssoDeviceAuth(bearerToken, region);
        if (!ssoResult.success || !ssoResult.accessToken) {
          return { success: false, error: { message: ssoResult.error || "SSO 授权失败" } };
        }
        let userInfo;
        let usageData;
        try {
          console.log("[SSO] Fetching user info and usage data...");
          const [userInfoResult, usageResult] = await Promise.all([
            getUserInfo(ssoResult.accessToken).catch((e) => {
              console.error("[SSO] getUserInfo failed:", e);
              return void 0;
            }),
            getUsageAndLimits(ssoResult.accessToken, "BuilderId", void 0, region).catch((e) => {
              console.error("[SSO] getUsageAndLimits failed:", e);
              return void 0;
            })
          ]);
          userInfo = userInfoResult;
          usageData = usageResult;
          console.log("[SSO] userInfo:", userInfo?.email);
          console.log("[SSO] usageData:", usageData?.subscriptionInfo?.subscriptionTitle);
        } catch (e) {
          console.error("[IPC] API calls failed:", e);
        }
        const creditUsage = usageData?.usageBreakdownList?.find((b) => b.resourceType === "CREDIT");
        const subscriptionTitle = usageData?.subscriptionInfo?.subscriptionTitle || "KIRO";
        let subscriptionType = "Free";
        const titleUpper = subscriptionTitle.toUpperCase();
        if (titleUpper.includes("PRO+") || titleUpper.includes("PRO_PLUS") || titleUpper.includes("PROPLUS")) {
          subscriptionType = "Pro_Plus";
        } else if (titleUpper.includes("POWER")) {
          subscriptionType = "Enterprise";
        } else if (titleUpper.includes("PRO")) {
          subscriptionType = "Pro";
        } else if (titleUpper.includes("ENTERPRISE")) {
          subscriptionType = "Enterprise";
        } else if (titleUpper.includes("TEAMS")) {
          subscriptionType = "Teams";
        }
        const baseLimit = creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0;
        const baseCurrent = creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0;
        let freeTrialLimit = 0, freeTrialCurrent = 0, freeTrialExpiry;
        if (creditUsage?.freeTrialInfo?.freeTrialStatus === "ACTIVE") {
          freeTrialLimit = creditUsage.freeTrialInfo.usageLimitWithPrecision ?? creditUsage.freeTrialInfo.usageLimit ?? 0;
          freeTrialCurrent = creditUsage.freeTrialInfo.currentUsageWithPrecision ?? creditUsage.freeTrialInfo.currentUsage ?? 0;
          freeTrialExpiry = creditUsage.freeTrialInfo.freeTrialExpiry;
        }
        const bonuses = (creditUsage?.bonuses || []).map((b) => ({
          code: b.bonusCode || "",
          name: b.displayName || "",
          current: b.currentUsageWithPrecision ?? b.currentUsage ?? 0,
          limit: b.usageLimitWithPrecision ?? b.usageLimit ?? 0,
          expiresAt: b.expiresAt
        }));
        const totalLimit = baseLimit + freeTrialLimit + bonuses.reduce((s, b) => s + b.limit, 0);
        const totalCurrent = baseCurrent + freeTrialCurrent + bonuses.reduce((s, b) => s + b.current, 0);
        return {
          success: true,
          data: {
            accessToken: ssoResult.accessToken,
            refreshToken: ssoResult.refreshToken,
            clientId: ssoResult.clientId,
            clientSecret: ssoResult.clientSecret,
            region: ssoResult.region,
            expiresIn: ssoResult.expiresIn,
            email: usageData?.userInfo?.email || userInfo?.email,
            userId: usageData?.userInfo?.userId || userInfo?.userId,
            idp: userInfo?.idp || "BuilderId",
            status: userInfo?.status,
            subscriptionType,
            subscriptionTitle,
            subscription: {
              managementTarget: usageData?.subscriptionInfo?.subscriptionManagementTarget,
              upgradeCapability: usageData?.subscriptionInfo?.upgradeCapability,
              overageCapability: usageData?.subscriptionInfo?.overageCapability
            },
            usage: {
              current: totalCurrent,
              limit: totalLimit,
              baseLimit,
              baseCurrent,
              freeTrialLimit,
              freeTrialCurrent,
              freeTrialExpiry,
              bonuses,
              nextResetDate: usageData?.nextDateReset,
              resourceDetail: creditUsage ? {
                displayName: creditUsage.displayName,
                displayNamePlural: creditUsage.displayNamePlural,
                resourceType: creditUsage.resourceType,
                currency: creditUsage.currency,
                unit: creditUsage.unit,
                overageRate: creditUsage.overageRate,
                overageCap: creditUsage.overageCap,
                overageEnabled: usageData?.overageConfiguration?.overageStatus === "ENABLED" || usageData?.overageConfiguration?.overageEnabled === true
              } : void 0
            },
            daysRemaining: usageData?.nextDateReset ? Math.max(
              0,
              Math.ceil((new Date(usageData.nextDateReset).getTime() - Date.now()) / 864e5)
            ) : void 0
          }
        };
      } catch (error) {
        console.error("[IPC] import-from-sso-token error:", error);
        return {
          success: false,
          error: { message: error instanceof Error ? error.message : "Unknown error" }
        };
      }
    }
  );
  electron.ipcMain.handle("check-account-status", async (_event, account) => {
    console.log(`[IPC] check-account-status [${account?.email || "unknown"}]`);
    const parseUsageResponse = (result, newCredentials, userInfo) => {
      console.log(`[Kiro API] Usage [${account?.email || userInfo?.email || "unknown"}]`, result);
      const creditUsage = result.usageBreakdownList?.find(
        (b) => b.resourceType === "CREDIT" || b.displayName === "Credits"
      );
      const baseLimit = creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0;
      const baseCurrent = creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0;
      let freeTrialLimit = 0;
      let freeTrialCurrent = 0;
      let freeTrialExpiry;
      if (creditUsage?.freeTrialInfo?.freeTrialStatus === "ACTIVE") {
        freeTrialLimit = creditUsage.freeTrialInfo.usageLimitWithPrecision ?? creditUsage.freeTrialInfo.usageLimit ?? 0;
        freeTrialCurrent = creditUsage.freeTrialInfo.currentUsageWithPrecision ?? creditUsage.freeTrialInfo.currentUsage ?? 0;
        freeTrialExpiry = creditUsage.freeTrialInfo.freeTrialExpiry;
      }
      const bonusesData = [];
      if (creditUsage?.bonuses) {
        for (const bonus of creditUsage.bonuses) {
          if (bonus.status === "ACTIVE") {
            bonusesData.push({
              code: bonus.bonusCode || "",
              name: bonus.displayName || "",
              current: bonus.currentUsageWithPrecision ?? bonus.currentUsage ?? 0,
              limit: bonus.usageLimitWithPrecision ?? bonus.usageLimit ?? 0,
              expiresAt: bonus.expiresAt
            });
          }
        }
      }
      const totalLimit = baseLimit + freeTrialLimit + bonusesData.reduce((sum, b) => sum + b.limit, 0);
      const totalUsed = baseCurrent + freeTrialCurrent + bonusesData.reduce((sum, b) => sum + b.current, 0);
      const nextResetDate = result.nextDateReset;
      const subscriptionTitle = result.subscriptionInfo?.subscriptionTitle ?? "Free";
      let subscriptionType = account.subscription?.type ?? "Free";
      if (subscriptionTitle.toUpperCase().includes("PRO")) {
        subscriptionType = "Pro";
      } else if (subscriptionTitle.toUpperCase().includes("ENTERPRISE")) {
        subscriptionType = "Enterprise";
      } else if (subscriptionTitle.toUpperCase().includes("TEAMS")) {
        subscriptionType = "Teams";
      }
      let expiresAt;
      let daysRemaining;
      if (result.nextDateReset) {
        expiresAt = new Date(result.nextDateReset).getTime();
        const now = Date.now();
        daysRemaining = Math.max(0, Math.ceil((expiresAt - now) / (1e3 * 60 * 60 * 24)));
      }
      const resourceDetail = creditUsage ? {
        resourceType: creditUsage.resourceType,
        displayName: creditUsage.displayName,
        displayNamePlural: creditUsage.displayNamePlural,
        currency: creditUsage.currency,
        unit: creditUsage.unit,
        overageRate: creditUsage.overageRate,
        overageCap: creditUsage.overageCap,
        overageEnabled: result.overageConfiguration?.overageStatus === "ENABLED" || result.overageConfiguration?.overageEnabled === true
      } : void 0;
      return {
        success: true,
        data: {
          status: !userInfo?.status || userInfo.status === "Active" || userInfo.status === "Stale" ? "active" : "error",
          email: result.userInfo?.email,
          userId: result.userInfo?.userId,
          idp: userInfo?.idp,
          userStatus: userInfo?.status,
          featureFlags: userInfo?.featureFlags,
          subscriptionTitle,
          usage: {
            current: totalUsed,
            limit: totalLimit,
            percentUsed: totalLimit > 0 ? totalUsed / totalLimit : 0,
            lastUpdated: Date.now(),
            baseLimit,
            baseCurrent,
            freeTrialLimit,
            freeTrialCurrent,
            freeTrialExpiry,
            bonuses: bonusesData,
            nextResetDate,
            resourceDetail
          },
          subscription: {
            type: subscriptionType,
            title: subscriptionTitle,
            rawType: result.subscriptionInfo?.type,
            expiresAt,
            daysRemaining,
            upgradeCapability: result.subscriptionInfo?.upgradeCapability,
            overageCapability: result.subscriptionInfo?.overageCapability,
            managementTarget: result.subscriptionInfo?.subscriptionManagementTarget
          },
          // 如果刷新了 token，返回新的凭证
          newCredentials: newCredentials ? {
            accessToken: newCredentials.accessToken,
            refreshToken: newCredentials.refreshToken,
            expiresAt: newCredentials.expiresAt ?? (newCredentials.expiresIn ? Date.now() + newCredentials.expiresIn * 1e3 : void 0),
            credentialRevision: newCredentials.credentialRevision
          } : void 0
        }
      };
    };
    try {
      const {
        accessToken,
        refreshToken,
        credentialRevision,
        clientId,
        clientSecret,
        region,
        authMethod,
        provider,
        profileArn,
        kiroApiKey,
        credentialKind
      } = account.credentials || {};
      const upstreamCredential = resolveUpstreamKiroCredential({
        credentialKind,
        accessToken,
        kiroApiKey,
        idp: provider || account.idp
      });
      const upstreamAuth = getUpstreamKiroAuth(upstreamCredential);
      const boundProxyUrl = readAccountBoundProxyUrl(account.id || "");
      let idp = "BuilderId";
      if (authMethod === "social") {
        idp = provider || account.idp || "BuilderId";
      } else if (provider) {
        idp = provider;
      }
      if (!upstreamAuth.accessToken) {
        return { success: false, error: { message: "缺少上游 Kiro 凭据" } };
      }
      try {
        const [userInfoResult, usageResult] = await Promise.all([
          upstreamAuth.isApiKey ? Promise.resolve(void 0) : getUserInfo(upstreamAuth.accessToken, idp, account?.email, boundProxyUrl).catch(
            (err) => {
              if (err.message.includes("423") || err.message.includes("AccountSuspended"))
                throw err;
              return void 0;
            }
          ),
          getUsageAndLimits(
            upstreamCredential,
            idp,
            account.profileArn || profileArn,
            region,
            account?.email,
            boundProxyUrl
          )
        ]);
        return parseUsageResponse(usageResult, void 0, userInfoResult);
      } catch (apiError) {
        const errorMsg = apiError instanceof Error ? apiError.message : "";
        if (errorMsg.includes("AccountSuspendedException") || errorMsg.includes("423")) {
          console.log("[IPC] Account suspended/banned");
          return {
            success: false,
            error: { message: errorMsg, isBanned: true }
          };
        }
        const canRefresh = refreshToken && (authMethod === "social" || clientId && clientSecret);
        if (errorMsg.includes("401") && canRefresh) {
          return runCredentialRefreshOperation(
            { success: false, error: { message: CREDENTIAL_REFRESH_UNAVAILABLE } },
            async () => {
              console.log(
                `[IPC] Token expired, attempting to refresh (authMethod: ${authMethod || "IdC"})...${boundProxyUrl ? " [via bound proxy]" : ""}`
              );
              const refreshResult = await refreshStoredKiroCredentials({
                accountId: account.id || "",
                expectedRefreshToken: refreshToken,
                expectedCredentialRevision: credentialRevision,
                clientId,
                clientSecret,
                region,
                authMethod,
                proxyUrl: boundProxyUrl
              });
              if (refreshResult.success && refreshResult.accessToken) {
                console.log("[IPC] Token refreshed, retrying API call...");
                const [userInfoResult, usageResult] = await Promise.all([
                  getUserInfo(refreshResult.accessToken, idp, account?.email, boundProxyUrl).catch(
                    (err) => {
                      if (err.message.includes("423") || err.message.includes("AccountSuspended")) {
                        throw err;
                      }
                      return void 0;
                    }
                  ),
                  getUsageAndLimits(
                    refreshResult.accessToken,
                    idp,
                    void 0,
                    region,
                    account?.email,
                    boundProxyUrl
                  )
                ]);
                return parseUsageResponse(
                  usageResult,
                  {
                    accessToken: refreshResult.accessToken,
                    refreshToken: refreshResult.refreshToken,
                    expiresIn: refreshResult.expiresIn,
                    expiresAt: refreshResult.expiresAt,
                    credentialRevision: refreshResult.credentialRevision
                  },
                  userInfoResult
                );
              } else {
                console.error("[IPC] Token refresh failed:", refreshResult.error);
                return {
                  success: false,
                  error: { message: `Token 过期且刷新失败: ${refreshResult.error}` }
                };
              }
            }
          );
        }
        throw apiError;
      }
    } catch (error) {
      console.error("check-account-status error:", error);
      return {
        success: false,
        error: { message: error instanceof Error ? error.message : "Unknown error" }
      };
    }
  });
  const backgroundBatchRefresh = async (accounts, concurrency = 10, syncInfo = true) => {
    console.log(
      `[BackgroundRefresh] Starting batch refresh for ${accounts.length} accounts, concurrency: ${concurrency}, syncInfo: ${syncInfo}`
    );
    let completed = 0;
    let success = 0;
    let failed = 0;
    for (let i = 0; i < accounts.length; i += concurrency) {
      const batch = accounts.slice(i, i + concurrency);
      await Promise.allSettled(
        batch.map(async (account) => {
          if (account.id && poolRefreshInFlightIds.has(account.id)) {
            return;
          }
          const needsTokenRefresh = account.needsTokenRefresh !== false;
          const refreshPlan = buildBackgroundRefreshPlan(account.credentials, needsTokenRefresh);
          if (account.id) poolRefreshInFlightIds.add(account.id);
          const isApiKey = buildBackgroundRefreshPlan(account.credentials, false).credentialKind === "kiro_api_key";
          try {
            const {
              refreshToken,
              credentialRevision,
              clientId,
              clientSecret,
              region,
              authMethod,
              provider
            } = account.credentials;
            const boundProxyUrl = readAccountBoundProxyUrl(account.id);
            let idp = "BuilderId";
            if (authMethod === "social") {
              idp = provider || account.idp || "BuilderId";
            } else if (provider) {
              idp = provider;
            }
            let newAccessToken = refreshPlan.accessToken;
            let newRefreshToken = refreshToken;
            let newExpiresIn;
            let newExpiresAt;
            let newCredentialRevision = credentialRevision;
            if (refreshPlan.shouldRefreshToken) {
              if (!refreshToken) {
                failed++;
                completed++;
                if (account.id) {
                  localNotifications.notify(LocalNoticeKind.TokenRefreshFailed, {
                    accountId: account.id
                  });
                }
                return;
              }
              const refreshResult = await refreshStoredKiroCredentials({
                accountId: account.id,
                expectedRefreshToken: refreshToken,
                expectedCredentialRevision: credentialRevision,
                clientId,
                clientSecret,
                region,
                authMethod,
                proxyUrl: boundProxyUrl
              });
              if (!refreshResult.success) {
                failed++;
                completed++;
                if (account.id) {
                  localNotifications.notify(LocalNoticeKind.TokenRefreshFailed, {
                    accountId: account.id
                  });
                }
                sendRendererEvent("background-refresh-result", {
                  id: account.id,
                  success: false,
                  error: refreshResult.error
                });
                return;
              }
              newAccessToken = refreshResult.accessToken || refreshPlan.accessToken;
              newRefreshToken = refreshResult.refreshToken || refreshToken;
              newExpiresIn = refreshResult.expiresIn ?? 3600;
              newExpiresAt = refreshResult.expiresAt;
              newCredentialRevision = refreshResult.credentialRevision;
              if (!newAccessToken) {
                failed++;
                completed++;
                return;
              }
            }
            const existingProfileArn = account.profileArn || account.credentials?.profileArn;
            let resolvedBgProfileArn;
            const isEnt = (provider || account.idp) === "Enterprise" || authMethod === "external_idp";
            if (!isApiKey && !existingProfileArn && newAccessToken && isEnt) {
              try {
                resolvedBgProfileArn = await fetchEnterpriseProfileArn({
                  id: account.id || "",
                  accessToken: newAccessToken,
                  region: region || "us-east-1",
                  provider: provider || account.idp,
                  authMethod
                });
                if (resolvedBgProfileArn) {
                  console.log(
                    `[BackgroundRefresh] Enterprise profileArn auto-resolved: ${resolvedBgProfileArn} (${account.id})`
                  );
                }
              } catch (e) {
                console.warn(
                  `[BackgroundRefresh] Failed to fetch Enterprise profileArn for ${account.id}:`,
                  e
                );
              }
            }
            if (!newAccessToken && !isApiKey) {
              failed++;
              completed++;
              return;
            }
            let parsedUsage;
            let userInfoData;
            let subscriptionData;
            let status = "active";
            let errorMessage;
            if (syncInfo) {
              try {
                const upstreamCredential = isApiKey ? { credentialKind: "kiro_api_key", kiroApiKey: refreshPlan.kiroApiKey || "" } : newAccessToken;
                const rawUsage = await getUsageAndLimits(
                  upstreamCredential,
                  idp,
                  account.profileArn,
                  region
                );
                const creditUsage = rawUsage.usageBreakdownList?.find(
                  (b) => b.resourceType === "CREDIT"
                );
                const baseCurrent = creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0;
                const baseLimit = creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0;
                let freeTrialCurrent = 0;
                let freeTrialLimit = 0;
                let freeTrialExpiry;
                if (creditUsage?.freeTrialInfo?.freeTrialStatus === "ACTIVE") {
                  freeTrialCurrent = creditUsage.freeTrialInfo.currentUsageWithPrecision ?? creditUsage.freeTrialInfo.currentUsage ?? 0;
                  freeTrialLimit = creditUsage.freeTrialInfo.usageLimitWithPrecision ?? creditUsage.freeTrialInfo.usageLimit ?? 0;
                  freeTrialExpiry = creditUsage.freeTrialInfo.freeTrialExpiry;
                }
                const bonuses = [];
                if (creditUsage?.bonuses) {
                  for (const bonus of creditUsage.bonuses) {
                    if (bonus.status === "ACTIVE") {
                      bonuses.push({
                        code: bonus.bonusCode || "",
                        name: bonus.displayName || "",
                        current: bonus.currentUsageWithPrecision ?? bonus.currentUsage ?? 0,
                        limit: bonus.usageLimitWithPrecision ?? bonus.usageLimit ?? 0,
                        expiresAt: bonus.expiresAt
                      });
                    }
                  }
                }
                const totalLimit = baseLimit + freeTrialLimit + bonuses.reduce((sum, b) => sum + b.limit, 0);
                const totalCurrent = baseCurrent + freeTrialCurrent + bonuses.reduce((sum, b) => sum + b.current, 0);
                parsedUsage = {
                  current: totalCurrent,
                  limit: totalLimit,
                  baseCurrent,
                  baseLimit,
                  freeTrialCurrent,
                  freeTrialLimit,
                  freeTrialExpiry,
                  bonuses,
                  nextResetDate: rawUsage.nextDateReset,
                  resourceDetail: creditUsage ? {
                    displayName: creditUsage.displayName,
                    displayNamePlural: creditUsage.displayNamePlural,
                    resourceType: creditUsage.resourceType,
                    currency: creditUsage.currency,
                    unit: creditUsage.unit,
                    overageRate: creditUsage.overageRate,
                    overageCap: creditUsage.overageCap,
                    overageEnabled: rawUsage.overageConfiguration?.overageStatus === "ENABLED" || rawUsage.overageConfiguration?.overageEnabled === true
                  } : void 0
                };
                const subscriptionTitle = rawUsage.subscriptionInfo?.subscriptionTitle || "Free";
                let subscriptionType = "Free";
                const titleUpper = subscriptionTitle.toUpperCase();
                if (titleUpper.includes("PRO+") || titleUpper.includes("PRO_PLUS") || titleUpper.includes("PROPLUS")) {
                  subscriptionType = "Pro_Plus";
                } else if (titleUpper.includes("POWER")) {
                  subscriptionType = "Enterprise";
                } else if (titleUpper.includes("PRO")) {
                  subscriptionType = "Pro";
                } else if (titleUpper.includes("ENTERPRISE")) {
                  subscriptionType = "Enterprise";
                } else if (titleUpper.includes("TEAMS")) {
                  subscriptionType = "Teams";
                }
                let daysRemaining;
                let expiresAt;
                if (rawUsage.nextDateReset) {
                  expiresAt = new Date(rawUsage.nextDateReset).getTime();
                  daysRemaining = Math.max(
                    0,
                    Math.ceil((expiresAt - Date.now()) / (1e3 * 60 * 60 * 24))
                  );
                }
                subscriptionData = {
                  type: subscriptionType,
                  title: subscriptionTitle,
                  daysRemaining,
                  expiresAt,
                  overageCapability: rawUsage.subscriptionInfo?.overageCapability,
                  upgradeCapability: rawUsage.subscriptionInfo?.upgradeCapability,
                  subscriptionManagementTarget: rawUsage.subscriptionInfo?.subscriptionManagementTarget
                };
              } catch (apiError) {
                const errMsg = apiError instanceof Error ? apiError.message : String(apiError);
                const safeErrorMessage = isApiKey ? "API key usage sync failed" : errMsg;
                console.log(
                  `[BackgroundRefresh] Usage API error for ${account.id}:`,
                  safeErrorMessage
                );
                if (errMsg.includes("AccountSuspendedException") || errMsg.includes("423")) {
                  status = "error";
                  errorMessage = isApiKey ? "API key account suspended" : errMsg;
                }
              }
              if (refreshPlan.shouldFetchUserInfo)
                try {
                  userInfoData = await getUserInfo(newAccessToken, idp);
                } catch (apiError) {
                  const errMsg = apiError instanceof Error ? apiError.message : String(apiError);
                  if (errMsg.includes("AccountSuspendedException") || errMsg.includes("423")) {
                    status = "error";
                    errorMessage = errMsg;
                  }
                }
            }
            success++;
            completed++;
            sendRendererEvent("background-refresh-result", {
              id: account.id,
              success: true,
              data: {
                ...isApiKey ? {} : {
                  accessToken: newAccessToken,
                  refreshToken: newRefreshToken,
                  expiresIn: newExpiresIn,
                  credentialRevision: newCredentialRevision,
                  expiresAt: newExpiresAt
                },
                profileArn: resolvedBgProfileArn || void 0,
                usage: parsedUsage,
                subscription: subscriptionData,
                userInfo: syncInfo ? userInfoData : void 0,
                status,
                errorMessage
              }
            });
          } catch (e) {
            failed++;
            completed++;
            if (account.id) {
              localNotifications.notify(LocalNoticeKind.TokenRefreshFailed, {
                accountId: account.id
              });
            }
            sendRendererEvent("background-refresh-result", {
              id: account.id,
              success: false,
              error: isApiKey ? "API key background sync failed" : e instanceof Error ? e.message : "Unknown error"
            });
          } finally {
            if (account.id) poolRefreshInFlightIds.delete(account.id);
          }
        })
      );
      mainWindow?.webContents.send("background-refresh-progress", {
        completed,
        total: accounts.length,
        success,
        failed
      });
      if (i + concurrency < accounts.length) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    console.log(`[BackgroundRefresh] Completed: ${success} success, ${failed} failed`);
    return { success: true, completed, successCount: success, failedCount: failed };
  };
  backgroundBatchRefreshImpl = backgroundBatchRefresh;
  electron.ipcMain.handle(
    "background-batch-refresh",
    (_event, accounts, concurrency = 10, syncInfo = true) => backgroundBatchRefresh(accounts, concurrency, syncInfo)
  );
  startMainPoolTokenRefresh();
  electron.ipcMain.handle(
    "background-batch-check",
    async (_event, accounts, concurrency = 10) => {
      console.log(
        `[BackgroundCheck] Starting batch check for ${accounts.length} accounts, concurrency: ${concurrency}`
      );
      let completed = 0;
      let success = 0;
      let failed = 0;
      for (let i = 0; i < accounts.length; i += concurrency) {
        const batch = accounts.slice(i, i + concurrency);
        await Promise.allSettled(
          batch.map(async (account) => {
            try {
              const { accessToken, kiroApiKey, credentialKind, authMethod, provider } = account.credentials;
              const upstreamCredential = resolveUpstreamKiroCredential({
                credentialKind,
                accessToken,
                kiroApiKey,
                idp: provider || account.idp
              });
              const upstreamAuth = getUpstreamKiroAuth(upstreamCredential);
              let idp = account.idp || "BuilderId";
              if (authMethod === "social" && provider) {
                idp = provider;
              }
              const [usageRes, userInfoRes] = await Promise.allSettled([
                getUsageAndLimits(
                  upstreamCredential,
                  idp,
                  account.credentials.profileArn,
                  account.credentials?.region,
                  account.email
                ),
                upstreamAuth.isApiKey ? Promise.resolve(null) : kiroApiRequest(
                  "GetUserInfo",
                  { origin: "KIRO_IDE" },
                  upstreamAuth.accessToken,
                  idp,
                  account.email
                ).catch((err) => {
                  if (err.message.includes("423") || err.message.includes("AccountSuspended")) {
                    throw err;
                  }
                  return null;
                })
              ]);
              let usageData = null;
              let subscriptionData = null;
              let resourceDetail;
              let userInfoData = null;
              let status = "active";
              let errorMessage;
              if (usageRes.status === "fulfilled") {
                const rawUsage = usageRes.value;
                const creditUsage = rawUsage.usageBreakdownList?.find(
                  (b) => b.resourceType === "CREDIT" || b.displayName === "Credits"
                );
                const baseCurrent = creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0;
                const baseLimit = creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0;
                let freeTrialCurrent = 0;
                let freeTrialLimit = 0;
                let freeTrialExpiry;
                if (creditUsage?.freeTrialInfo?.freeTrialStatus === "ACTIVE") {
                  freeTrialLimit = creditUsage.freeTrialInfo.usageLimitWithPrecision ?? creditUsage.freeTrialInfo.usageLimit ?? 0;
                  freeTrialCurrent = creditUsage.freeTrialInfo.currentUsageWithPrecision ?? creditUsage.freeTrialInfo.currentUsage ?? 0;
                  freeTrialExpiry = creditUsage.freeTrialInfo.freeTrialExpiry;
                }
                const bonuses = [];
                if (creditUsage?.bonuses) {
                  for (const bonus of creditUsage.bonuses) {
                    if (bonus.status === "ACTIVE") {
                      bonuses.push({
                        code: bonus.bonusCode || "",
                        name: bonus.displayName || "",
                        current: bonus.currentUsageWithPrecision ?? bonus.currentUsage ?? 0,
                        limit: bonus.usageLimitWithPrecision ?? bonus.usageLimit ?? 0,
                        expiresAt: bonus.expiresAt
                      });
                    }
                  }
                }
                const totalLimit = baseLimit + freeTrialLimit + bonuses.reduce((sum, b) => sum + b.limit, 0);
                const totalCurrent = baseCurrent + freeTrialCurrent + bonuses.reduce((sum, b) => sum + b.current, 0);
                usageData = {
                  current: totalCurrent,
                  limit: totalLimit,
                  baseCurrent,
                  baseLimit,
                  freeTrialCurrent,
                  freeTrialLimit,
                  freeTrialExpiry,
                  bonuses,
                  nextResetDate: rawUsage.nextDateReset
                };
                if (creditUsage) {
                  resourceDetail = {
                    displayName: creditUsage.displayName,
                    displayNamePlural: creditUsage.displayNamePlural,
                    resourceType: creditUsage.resourceType,
                    currency: creditUsage.currency,
                    unit: creditUsage.unit,
                    overageRate: creditUsage.overageRate,
                    overageCap: creditUsage.overageCap,
                    overageEnabled: rawUsage.overageConfiguration?.overageStatus === "ENABLED" || rawUsage.overageConfiguration?.overageEnabled === true
                  };
                }
                const subscriptionTitle = rawUsage.subscriptionInfo?.subscriptionTitle ?? "Free";
                let subscriptionType = "Free";
                const titleUpper = subscriptionTitle.toUpperCase();
                if (titleUpper.includes("PRO+") || titleUpper.includes("PRO_PLUS") || titleUpper.includes("PROPLUS")) {
                  subscriptionType = "Pro_Plus";
                } else if (titleUpper.includes("POWER")) {
                  subscriptionType = "Enterprise";
                } else if (titleUpper.includes("PRO")) {
                  subscriptionType = "Pro";
                } else if (titleUpper.includes("ENTERPRISE")) {
                  subscriptionType = "Enterprise";
                } else if (titleUpper.includes("TEAMS")) {
                  subscriptionType = "Teams";
                }
                let daysRemaining;
                let expiresAt;
                if (rawUsage.nextDateReset) {
                  expiresAt = new Date(rawUsage.nextDateReset).getTime();
                  daysRemaining = Math.max(
                    0,
                    Math.ceil((expiresAt - Date.now()) / (1e3 * 60 * 60 * 24))
                  );
                }
                subscriptionData = {
                  type: subscriptionType,
                  title: subscriptionTitle,
                  daysRemaining,
                  expiresAt,
                  overageCapability: rawUsage.subscriptionInfo?.overageCapability,
                  upgradeCapability: rawUsage.subscriptionInfo?.upgradeCapability,
                  subscriptionManagementTarget: rawUsage.subscriptionInfo?.subscriptionManagementTarget
                };
              } else if (usageRes.status === "rejected") {
                const errorMsg = usageRes.reason?.message || String(usageRes.reason);
                console.log(`[BackgroundCheck] Usage API failed for ${account.email}:`, errorMsg);
                if (errorMsg.includes("AccountSuspendedException") || errorMsg.includes("423")) {
                  status = "error";
                  errorMessage = errorMsg;
                } else if (errorMsg.includes("401")) {
                  status = "expired";
                  errorMessage = "Token 已过期，请刷新";
                } else {
                  status = "error";
                  errorMessage = errorMsg;
                }
              }
              if (userInfoRes.status === "fulfilled" && userInfoRes.value) {
                const rawUserInfo = userInfoRes.value;
                userInfoData = {
                  email: rawUserInfo.email,
                  userId: rawUserInfo.userId,
                  status: rawUserInfo.status
                };
                if (rawUserInfo.status && rawUserInfo.status !== "Active" && rawUserInfo.status !== "Stale" && status !== "error") {
                  status = "error";
                  errorMessage = `用户状态异常: ${rawUserInfo.status}`;
                }
              } else if (userInfoRes.status === "rejected") {
                const errMsg = userInfoRes.reason?.message || String(userInfoRes.reason);
                if (errMsg.includes("423") || errMsg.includes("AccountSuspended")) {
                  status = "error";
                  errorMessage = errMsg;
                }
              }
              success++;
              completed++;
              sendRendererEvent("background-check-result", {
                id: account.id,
                success: true,
                data: {
                  usage: usageData ? { ...usageData, resourceDetail } : null,
                  subscription: subscriptionData,
                  userInfo: userInfoData,
                  status,
                  errorMessage
                }
              });
            } catch (e) {
              failed++;
              completed++;
              sendRendererEvent("background-check-result", {
                id: account.id,
                success: false,
                error: e instanceof Error ? e.message : "Unknown error"
              });
            }
          })
        );
        mainWindow?.webContents.send("background-check-progress", {
          completed,
          total: accounts.length,
          success,
          failed
        });
        if (i + concurrency < accounts.length) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      console.log(`[BackgroundCheck] Completed: ${success} success, ${failed} failed`);
      return { success: true, completed, successCount: success, failedCount: failed };
    }
  );
  electron.ipcMain.handle("export-to-file", async (_event, data, filename) => {
    try {
      const result = await electron.dialog.showSaveDialog(mainWindow, {
        title: "导出账号数据",
        defaultPath: filename,
        filters: [{ name: "JSON Files", extensions: ["json"] }]
      });
      if (!result.canceled && result.filePath) {
        await fs$1.writeFile(result.filePath, data, "utf-8");
        return true;
      }
      return false;
    } catch (error) {
      console.error("Failed to export:", error);
      return false;
    }
  });
  electron.ipcMain.handle("import-from-file", async () => {
    try {
      const result = await electron.dialog.showOpenDialog(mainWindow, {
        title: "导入账号数据",
        filters: [
          { name: "所有支持的格式", extensions: ["json", "csv", "txt"] },
          { name: "JSON Files", extensions: ["json"] },
          { name: "CSV Files", extensions: ["csv"] },
          { name: "TXT Files", extensions: ["txt"] }
        ],
        properties: ["openFile"]
      });
      if (!result.canceled && result.filePaths.length > 0) {
        const filePath = result.filePaths[0];
        const content = await fs$1.readFile(filePath, "utf-8");
        const ext = filePath.split(".").pop()?.toLowerCase() || "json";
        return { content, format: ext };
      }
      return null;
    } catch (error) {
      console.error("Failed to import:", error);
      return null;
    }
  });
  electron.ipcMain.handle(
    "verify-account-credentials",
    async (_event, credentials) => runCredentialRefreshOperation(
      {},
      async () => {
        console.log("[IPC] verify-account-credentials called");
        try {
          const {
            refreshToken,
            clientId,
            clientSecret,
            credentialKind,
            kiroApiKey,
            region = "us-east-1",
            authMethod,
            provider
          } = credentials;
          if (credentialKind === "kiro_api_key" || kiroApiKey) {
            const normalizedKey = kiroApiKey?.trim();
            if (!normalizedKey) return { success: false, error: "请填写 Kiro API Key" };
            const usageResult2 = await getUsageAndLimits(
              {
                credentialKind: "kiro_api_key",
                kiroApiKey: normalizedKey,
                idp: provider || "BuilderId"
              },
              provider || "BuilderId",
              void 0,
              region
            );
            const creditUsage2 = usageResult2.usageBreakdownList?.find(
              (item) => item.resourceType === "CREDIT" || item.displayName === "Credits"
            );
            const baseLimit2 = creditUsage2?.usageLimitWithPrecision ?? creditUsage2?.usageLimit ?? 0;
            const baseCurrent2 = creditUsage2?.currentUsageWithPrecision ?? creditUsage2?.currentUsage ?? 0;
            const freeTrialActive = creditUsage2?.freeTrialInfo?.freeTrialStatus === "ACTIVE";
            const freeTrialLimit2 = freeTrialActive ? creditUsage2?.freeTrialInfo?.usageLimitWithPrecision ?? creditUsage2?.freeTrialInfo?.usageLimit ?? 0 : 0;
            const freeTrialCurrent2 = freeTrialActive ? creditUsage2?.freeTrialInfo?.currentUsageWithPrecision ?? creditUsage2?.freeTrialInfo?.currentUsage ?? 0 : 0;
            const bonuses2 = (creditUsage2?.bonuses ?? []).filter((bonus) => bonus.status === "ACTIVE").map((bonus) => ({
              code: bonus.bonusCode || "",
              name: bonus.displayName || "",
              current: bonus.currentUsageWithPrecision ?? bonus.currentUsage ?? 0,
              limit: bonus.usageLimitWithPrecision ?? bonus.usageLimit ?? 0,
              expiresAt: bonus.expiresAt
            }));
            const totalLimit2 = baseLimit2 + freeTrialLimit2 + bonuses2.reduce((sum, bonus) => sum + bonus.limit, 0);
            const totalUsed2 = baseCurrent2 + freeTrialCurrent2 + bonuses2.reduce((sum, bonus) => sum + bonus.current, 0);
            const subscriptionTitle2 = usageResult2.subscriptionInfo?.subscriptionTitle || "Free";
            const upperTitle = subscriptionTitle2.toUpperCase();
            const subscriptionType2 = upperTitle.includes("PRO+") || upperTitle.includes("PRO_PLUS") ? "Pro_Plus" : upperTitle.includes("PRO") ? "Pro" : upperTitle.includes("ENTERPRISE") || upperTitle.includes("POWER") ? "Enterprise" : upperTitle.includes("TEAMS") ? "Teams" : "Free";
            const expiresAt2 = usageResult2.nextDateReset ? new Date(usageResult2.nextDateReset).getTime() : void 0;
            return {
              success: true,
              data: {
                email: usageResult2.userInfo?.email || "",
                userId: usageResult2.userInfo?.userId || "",
                accessToken: "",
                refreshToken: "",
                subscriptionType: subscriptionType2,
                subscriptionTitle: subscriptionTitle2,
                subscription: {
                  rawType: usageResult2.subscriptionInfo?.type,
                  managementTarget: usageResult2.subscriptionInfo?.subscriptionManagementTarget,
                  upgradeCapability: usageResult2.subscriptionInfo?.upgradeCapability,
                  overageCapability: usageResult2.subscriptionInfo?.overageCapability
                },
                usage: {
                  current: totalUsed2,
                  limit: totalLimit2,
                  baseLimit: baseLimit2,
                  baseCurrent: baseCurrent2,
                  freeTrialLimit: freeTrialLimit2,
                  freeTrialCurrent: freeTrialCurrent2,
                  freeTrialExpiry: creditUsage2?.freeTrialInfo?.freeTrialExpiry,
                  bonuses: bonuses2,
                  nextResetDate: usageResult2.nextDateReset,
                  resourceDetail: creditUsage2 ? {
                    displayName: creditUsage2.displayName,
                    displayNamePlural: creditUsage2.displayNamePlural,
                    resourceType: creditUsage2.resourceType,
                    currency: creditUsage2.currency,
                    unit: creditUsage2.unit,
                    overageRate: creditUsage2.overageRate,
                    overageCap: creditUsage2.overageCap,
                    overageEnabled: usageResult2.overageConfiguration?.overageStatus === "ENABLED" || usageResult2.overageConfiguration?.overageEnabled === true
                  } : void 0
                },
                daysRemaining: expiresAt2 ? Math.max(0, Math.ceil((expiresAt2 - Date.now()) / (1e3 * 60 * 60 * 24))) : void 0,
                expiresAt: expiresAt2
              }
            };
          }
          const idp = provider && (provider === "Enterprise" || provider === "Github" || provider === "Google") ? provider : "BuilderId";
          if (!refreshToken) {
            return { success: false, error: "请填写 Refresh Token" };
          }
          if (authMethod !== "social" && (!clientId || !clientSecret)) {
            return { success: false, error: "请填写 Client ID 和 Client Secret" };
          }
          console.log(`[Verify] Step 1: Refreshing token (authMethod: ${authMethod || "IdC"})...`);
          const refreshResult = await refreshUnmanagedKiroCredentials(
            refreshToken,
            clientId || "",
            clientSecret || "",
            region,
            authMethod
          );
          if (!refreshResult.success || !refreshResult.accessToken) {
            return { success: false, error: `Token 刷新失败: ${refreshResult.error}` };
          }
          console.log("[Verify] Step 2: Getting user info...");
          const usageResult = await getUsageAndLimits(
            refreshResult.accessToken,
            idp,
            void 0,
            region
          );
          const email = usageResult.userInfo?.email || "";
          const userId = usageResult.userInfo?.userId || "";
          const subscriptionTitle = usageResult.subscriptionInfo?.subscriptionTitle || "Free";
          let subscriptionType = "Free";
          const titleUpper = subscriptionTitle.toUpperCase();
          if (titleUpper.includes("PRO+") || titleUpper.includes("PRO_PLUS") || titleUpper.includes("PROPLUS")) {
            subscriptionType = "Pro_Plus";
          } else if (titleUpper.includes("POWER")) {
            subscriptionType = "Enterprise";
          } else if (titleUpper.includes("PRO")) {
            subscriptionType = "Pro";
          } else if (titleUpper.includes("ENTERPRISE")) {
            subscriptionType = "Enterprise";
          } else if (titleUpper.includes("TEAMS")) {
            subscriptionType = "Teams";
          }
          const creditUsage = usageResult.usageBreakdownList?.find(
            (b) => b.resourceType === "CREDIT"
          );
          const baseLimit = creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0;
          const baseCurrent = creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0;
          let freeTrialLimit = 0;
          let freeTrialCurrent = 0;
          let freeTrialExpiry;
          if (creditUsage?.freeTrialInfo?.freeTrialStatus === "ACTIVE") {
            freeTrialLimit = creditUsage.freeTrialInfo.usageLimitWithPrecision ?? creditUsage.freeTrialInfo.usageLimit ?? 0;
            freeTrialCurrent = creditUsage.freeTrialInfo.currentUsageWithPrecision ?? creditUsage.freeTrialInfo.currentUsage ?? 0;
            freeTrialExpiry = creditUsage.freeTrialInfo.freeTrialExpiry;
          }
          const bonuses = [];
          if (creditUsage?.bonuses) {
            for (const bonus of creditUsage.bonuses) {
              if (bonus.status === "ACTIVE") {
                bonuses.push({
                  code: bonus.bonusCode || "",
                  name: bonus.displayName || "",
                  current: bonus.currentUsageWithPrecision ?? bonus.currentUsage ?? 0,
                  limit: bonus.usageLimitWithPrecision ?? bonus.usageLimit ?? 0,
                  expiresAt: bonus.expiresAt
                });
              }
            }
          }
          const totalLimit = baseLimit + freeTrialLimit + bonuses.reduce((sum, b) => sum + b.limit, 0);
          const totalUsed = baseCurrent + freeTrialCurrent + bonuses.reduce((sum, b) => sum + b.current, 0);
          let daysRemaining;
          let expiresAt;
          const nextResetDate = usageResult.nextDateReset;
          if (nextResetDate) {
            expiresAt = new Date(nextResetDate).getTime();
            daysRemaining = Math.max(
              0,
              Math.ceil((expiresAt - Date.now()) / (1e3 * 60 * 60 * 24))
            );
          }
          console.log("[Verify] Success! Email:", email);
          let enterpriseProfileArn;
          const isEnt = provider === "Enterprise" || authMethod === "external_idp";
          if (isEnt) {
            try {
              enterpriseProfileArn = await fetchEnterpriseProfileArn({
                id: "",
                accessToken: refreshResult.accessToken,
                region: region || "us-east-1",
                provider,
                authMethod
              });
              if (enterpriseProfileArn) {
                console.log(
                  `[Verify] Enterprise profileArn auto-resolved: ${enterpriseProfileArn}`
                );
              }
            } catch (e) {
              console.warn("[Verify] Failed to fetch Enterprise profileArn:", e);
            }
          }
          return {
            success: true,
            data: {
              email,
              userId,
              accessToken: refreshResult.accessToken,
              refreshToken: refreshResult.refreshToken || refreshToken,
              expiresIn: refreshResult.expiresIn,
              profileArn: enterpriseProfileArn || void 0,
              subscriptionType,
              subscriptionTitle,
              subscription: {
                rawType: usageResult.subscriptionInfo?.type,
                managementTarget: usageResult.subscriptionInfo?.subscriptionManagementTarget,
                upgradeCapability: usageResult.subscriptionInfo?.upgradeCapability,
                overageCapability: usageResult.subscriptionInfo?.overageCapability
              },
              usage: {
                current: totalUsed,
                limit: totalLimit,
                baseLimit,
                baseCurrent,
                freeTrialLimit,
                freeTrialCurrent,
                freeTrialExpiry,
                bonuses,
                nextResetDate,
                resourceDetail: creditUsage ? {
                  displayName: creditUsage.displayName,
                  displayNamePlural: creditUsage.displayNamePlural,
                  resourceType: creditUsage.resourceType,
                  currency: creditUsage.currency,
                  unit: creditUsage.unit,
                  overageRate: creditUsage.overageRate,
                  overageCap: creditUsage.overageCap,
                  overageEnabled: usageResult.overageConfiguration?.overageStatus === "ENABLED" || usageResult.overageConfiguration?.overageEnabled === true
                } : void 0
              },
              daysRemaining,
              expiresAt
            }
          };
        } catch (error) {
          console.error("[Verify] Error:", error);
          return { success: false, error: error instanceof Error ? error.message : "验证失败" };
        }
      }
    )
  );
  let currentLoginState = null;
  electron.ipcMain.handle("start-builder-id-login", async (_event, region = "us-east-1") => {
    console.log("[Login] Starting Builder ID login...");
    const oidcBase = `https://oidc.${region}.amazonaws.com`;
    const startUrl = "https://view.awsapps.com/start";
    const scopes = [
      "codewhisperer:completions",
      "codewhisperer:analysis",
      "codewhisperer:conversations",
      "codewhisperer:transformations",
      "codewhisperer:taskassist"
    ];
    try {
      console.log("[Login] Step 1: Registering OIDC client...");
      const regRes = await fetchWithAppProxy(`${oidcBase}/client/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName: APP_NAME,
          clientType: "public",
          scopes,
          grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
          issuerUrl: startUrl
        })
      });
      if (!regRes.ok) {
        const errText = await regRes.text();
        return { success: false, error: `注册客户端失败: ${errText}` };
      }
      const regData = await regRes.json();
      const clientId = regData.clientId;
      const clientSecret = regData.clientSecret;
      console.log("[Login] Client registered:", clientId.substring(0, 30) + "...");
      console.log("[Login] Step 2: Starting device authorization...");
      const authRes = await fetchWithAppProxy(`${oidcBase}/device_authorization`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, clientSecret, startUrl })
      });
      if (!authRes.ok) {
        const errText = await authRes.text();
        return { success: false, error: `设备授权失败: ${errText}` };
      }
      const authData = await authRes.json();
      const {
        deviceCode,
        userCode,
        verificationUri,
        verificationUriComplete,
        interval = 5,
        expiresIn = 600
      } = authData;
      console.log("[Login] Device code obtained, user_code:", userCode);
      currentLoginState = {
        type: "builderid",
        clientId,
        clientSecret,
        deviceCode,
        userCode,
        verificationUri,
        interval,
        expiresAt: Date.now() + expiresIn * 1e3
      };
      return {
        success: true,
        userCode,
        verificationUri: verificationUriComplete || verificationUri,
        expiresIn,
        interval
      };
    } catch (error) {
      console.error("[Login] Error:", error);
      return { success: false, error: error instanceof Error ? error.message : "登录失败" };
    }
  });
  electron.ipcMain.handle("poll-builder-id-auth", async (_event, region = "us-east-1") => {
    console.log("[Login] Polling for authorization...");
    if (!currentLoginState || currentLoginState.type !== "builderid") {
      return { success: false, error: "没有进行中的登录" };
    }
    if (Date.now() > (currentLoginState.expiresAt || 0)) {
      currentLoginState = null;
      return { success: false, error: "授权已过期，请重新开始" };
    }
    const oidcBase = `https://oidc.${region}.amazonaws.com`;
    const { clientId, clientSecret, deviceCode } = currentLoginState;
    try {
      const tokenRes = await fetchWithAppProxy(`${oidcBase}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId,
          clientSecret,
          grantType: "urn:ietf:params:oauth:grant-type:device_code",
          deviceCode
        })
      });
      if (tokenRes.status === 200) {
        const tokenData = await tokenRes.json();
        console.log("[Login] Authorization successful!");
        const result = {
          success: true,
          completed: true,
          accessToken: tokenData.accessToken,
          refreshToken: tokenData.refreshToken,
          clientId,
          clientSecret,
          region,
          expiresIn: tokenData.expiresIn
        };
        currentLoginState = null;
        return result;
      } else if (tokenRes.status === 400) {
        const errData = await tokenRes.json();
        const error = errData.error;
        if (error === "authorization_pending") {
          return { success: true, completed: false, status: "pending" };
        } else if (error === "slow_down") {
          if (currentLoginState) {
            currentLoginState.interval = (currentLoginState.interval || 5) + 5;
          }
          return { success: true, completed: false, status: "slow_down" };
        } else if (error === "expired_token") {
          currentLoginState = null;
          return { success: false, error: "设备码已过期" };
        } else if (error === "access_denied") {
          currentLoginState = null;
          return { success: false, error: "用户拒绝授权" };
        } else {
          currentLoginState = null;
          return { success: false, error: `授权错误: ${error}` };
        }
      } else {
        return { success: false, error: `未知响应: ${tokenRes.status}` };
      }
    } catch (error) {
      console.error("[Login] Poll error:", error);
      return { success: false, error: error instanceof Error ? error.message : "轮询失败" };
    }
  });
  electron.ipcMain.handle("cancel-builder-id-login", async () => {
    console.log("[Login] Cancelling Builder ID login...");
    currentLoginState = null;
    return { success: true };
  });
  let iamSsoServer = null;
  let iamSsoResult = null;
  electron.ipcMain.handle(
    "start-iam-sso-login",
    async (_event, startUrl, region = "us-east-1") => {
      console.log("[Login] Starting IAM Identity Center SSO login (Authorization Code flow)...");
      console.log("[Login] Start URL:", startUrl);
      if (!startUrl || !startUrl.startsWith("https://")) {
        return { success: false, error: "SSO Start URL 必须以 https:// 开头" };
      }
      const crypto2 = await import("crypto");
      const http = await import("http");
      const oidcBase = `https://oidc.${region}.amazonaws.com`;
      const scopes = [
        "codewhisperer:completions",
        "codewhisperer:analysis",
        "codewhisperer:conversations",
        "codewhisperer:transformations",
        "codewhisperer:taskassist"
      ];
      try {
        console.log("[Login] Step 1: Registering OIDC client...");
        const regRes = await fetchWithAppProxy(`${oidcBase}/client/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clientName: APP_NAME,
            clientType: "public",
            scopes,
            grantTypes: ["authorization_code", "refresh_token"],
            redirectUris: ["http://127.0.0.1/oauth/callback"],
            issuerUrl: startUrl
          })
        });
        if (!regRes.ok) {
          const errText = await regRes.text();
          console.error("[Login] IAM SSO client registration failed:", regRes.status, errText);
          if (errText.includes("UnauthorizedException") || errText.includes("access denied")) {
            return {
              success: false,
              error: "授权失败：您的组织可能未配置 Amazon Q Developer 访问权限。请联系组织管理员在 IAM Identity Center 中启用相关权限。"
            };
          }
          return { success: false, error: `注册客户端失败: ${errText}` };
        }
        const regData = await regRes.json();
        const clientId = regData.clientId;
        const clientSecret = regData.clientSecret;
        console.log("[Login] Client registered:", clientId.substring(0, 30) + "...");
        const codeVerifier = crypto2.randomBytes(32).toString("base64url");
        const codeChallenge = crypto2.createHash("sha256").update(codeVerifier).digest("base64url");
        const state = crypto2.randomUUID();
        console.log("[Login] Step 2: Starting local OAuth callback server...");
        if (iamSsoServer) {
          iamSsoServer.close();
          iamSsoServer = null;
        }
        const port = await new Promise((resolve, reject) => {
          const server = http.createServer();
          server.listen(0, "127.0.0.1", () => {
            const addr = server.address();
            if (addr && typeof addr === "object") {
              const p = addr.port;
              server.close(() => resolve(p));
            } else {
              reject(new Error("无法获取端口"));
            }
          });
        });
        const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
        console.log("[Login] Redirect URI:", redirectUri);
        iamSsoResult = null;
        iamSsoServer = http.createServer(async (req, res) => {
          const url = new URL(req.url || "", `http://127.0.0.1:${port}`);
          if (url.pathname === "/oauth/callback") {
            const code = url.searchParams.get("code");
            const returnedState = url.searchParams.get("state");
            const error = url.searchParams.get("error");
            if (error) {
              res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
              res.end("<html><body><h1>授权失败</h1><p>您可以关闭此窗口。</p></body></html>");
              iamSsoResult = { completed: true, success: false, error: `授权失败: ${error}` };
              return;
            }
            if (returnedState !== state) {
              res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
              res.end("<html><body><h1>授权失败</h1><p>状态不匹配，请重试。</p></body></html>");
              iamSsoResult = { completed: true, success: false, error: "状态不匹配" };
              return;
            }
            if (code) {
              res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
              res.end("<html><body><h1>授权成功！</h1><p>正在获取令牌，请稍候...</p></body></html>");
              try {
                const tokenRes = await fetchWithAppProxy(`${oidcBase}/token`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    clientId,
                    clientSecret,
                    grantType: "authorization_code",
                    redirectUri,
                    code,
                    codeVerifier
                  })
                });
                if (!tokenRes.ok) {
                  const errText = await tokenRes.text();
                  console.error("[Login] Token exchange failed:", tokenRes.status, errText);
                  iamSsoResult = {
                    completed: true,
                    success: false,
                    error: `获取 Token 失败: ${errText}`
                  };
                } else {
                  const tokenData = await tokenRes.json();
                  console.log("[Login] IAM SSO Authorization successful!");
                  iamSsoResult = {
                    completed: true,
                    success: true,
                    accessToken: tokenData.accessToken,
                    refreshToken: tokenData.refreshToken,
                    clientId,
                    clientSecret,
                    region,
                    expiresIn: tokenData.expiresIn
                  };
                }
              } catch (tokenError) {
                console.error("[Login] Token exchange error:", tokenError);
                iamSsoResult = {
                  completed: true,
                  success: false,
                  error: tokenError instanceof Error ? tokenError.message : "获取 Token 失败"
                };
              }
            } else {
              res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
              res.end("<html><body><h1>授权失败</h1><p>未收到授权码。</p></body></html>");
              iamSsoResult = { completed: true, success: false, error: "未收到授权码" };
            }
          } else {
            res.writeHead(404);
            res.end("Not Found");
          }
        });
        iamSsoServer.listen(port, "127.0.0.1", () => {
          console.log("[Login] OAuth callback server listening on port", port);
        });
        const authorizeParams = new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: redirectUri,
          scopes: scopes.join(","),
          state,
          code_challenge: codeChallenge,
          code_challenge_method: "S256"
        });
        const authorizeUrl = `${oidcBase}/authorize?${authorizeParams.toString()}`;
        console.log("[Login] Opening browser for authorization...");
        currentLoginState = {
          type: "iamsso",
          clientId,
          clientSecret,
          codeVerifier,
          redirectUri,
          region,
          startUrl,
          expiresAt: Date.now() + 6e5
        };
        return {
          success: true,
          authorizeUrl,
          expiresIn: 600
        };
      } catch (error) {
        console.error("[Login] Error:", error);
        return { success: false, error: error instanceof Error ? error.message : "登录失败" };
      }
    }
  );
  electron.ipcMain.handle("poll-iam-sso-auth", async () => {
    if (!currentLoginState || currentLoginState.type !== "iamsso") {
      return { success: false, error: "没有进行中的 IAM SSO 登录" };
    }
    if (Date.now() > (currentLoginState.expiresAt || 0)) {
      if (iamSsoServer) {
        iamSsoServer.close();
        iamSsoServer = null;
      }
      iamSsoResult = null;
      currentLoginState = null;
      return { success: false, error: "授权已过期，请重新开始" };
    }
    if (iamSsoResult) {
      const result = { ...iamSsoResult };
      if (result.completed) {
        if (iamSsoServer) {
          iamSsoServer.close();
          iamSsoServer = null;
        }
        iamSsoResult = null;
        currentLoginState = null;
      }
      return result;
    }
    return { success: true, completed: false, status: "pending" };
  });
  electron.ipcMain.handle("cancel-iam-sso-login", async () => {
    console.log("[Login] Cancelling IAM SSO login...");
    if (iamSsoServer) {
      iamSsoServer.close();
      iamSsoServer = null;
    }
    iamSsoResult = null;
    currentLoginState = null;
    return { success: true };
  });
  electron.ipcMain.handle("start-social-login", async (_event, provider) => {
    console.log(`[Login] Starting ${provider} Social Auth login in built-in incognito browser...`);
    const crypto2 = await import("crypto");
    const codeVerifier = crypto2.randomBytes(64).toString("base64url").substring(0, 128);
    const codeChallenge = crypto2.createHash("sha256").update(codeVerifier).digest("base64url");
    const oauthState = crypto2.randomBytes(32).toString("base64url");
    const redirectUri = APP_SOCIAL_AUTH_REDIRECT_URI;
    const loginUrl = new URL(`${KIRO_AUTH_ENDPOINT}/login`);
    loginUrl.searchParams.set("idp", provider);
    loginUrl.searchParams.set("redirect_uri", redirectUri);
    loginUrl.searchParams.set("code_challenge", codeChallenge);
    loginUrl.searchParams.set("code_challenge_method", "S256");
    loginUrl.searchParams.set("state", oauthState);
    currentLoginState = {
      type: "social",
      codeVerifier,
      codeChallenge,
      oauthState,
      provider
    };
    const urlStr = loginUrl.toString();
    console.log(`[Login] Opening browser for ${provider} login...`);
    openBrowserInPrivateMode(urlStr);
    return {
      success: true,
      loginUrl: urlStr,
      state: oauthState
    };
  });
  electron.ipcMain.handle("exchange-social-token", async (_event, code, state) => {
    console.log("[Login] Exchanging Social Auth token...");
    if (!currentLoginState || currentLoginState.type !== "social") {
      return { success: false, error: "没有进行中的社交登录" };
    }
    if (state !== currentLoginState.oauthState) {
      currentLoginState = null;
      return { success: false, error: "状态参数不匹配，可能存在安全风险" };
    }
    const { codeVerifier, provider } = currentLoginState;
    const redirectUri = APP_SOCIAL_AUTH_REDIRECT_URI;
    try {
      const tokenRes = await fetchWithAppProxy(`${KIRO_AUTH_ENDPOINT}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri
        })
      });
      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        currentLoginState = null;
        return { success: false, error: `Token 交换失败: ${errText}` };
      }
      const tokenData = await tokenRes.json();
      console.log("[Login] Token exchange successful!");
      const result = {
        success: true,
        accessToken: tokenData.accessToken,
        refreshToken: tokenData.refreshToken,
        profileArn: tokenData.profileArn,
        expiresIn: tokenData.expiresIn,
        authMethod: "social",
        provider
      };
      currentLoginState = null;
      return result;
    } catch (error) {
      console.error("[Login] Token exchange error:", error);
      currentLoginState = null;
      return { success: false, error: error instanceof Error ? error.message : "Token 交换失败" };
    }
  });
  electron.ipcMain.handle("cancel-social-login", async () => {
    console.log("[Login] Cancelling Social Auth login...");
    currentLoginState = null;
    return { success: true };
  });
  electron.ipcMain.handle("set-proxy", async (_event, enabled, url) => {
    const normalizedUrl = enabled && url ? normalizeProxyUrl(url) : url;
    const electronProxy = getElectronProxySettings(normalizedUrl);
    console.log(
      `[IPC] set-proxy called: enabled=${enabled}, url=${normalizedUrl ? redactProxyUrl(normalizedUrl) : ""}${normalizedUrl !== url ? " (代理地址已规范化)" : ""}`
    );
    try {
      applyProxySettings(enabled, url);
      if (mainWindow) {
        const session = mainWindow.webContents.session;
        if (enabled && electronProxy) {
          await session.setProxy({ proxyRules: electronProxy.proxyRules });
        } else {
          await session.setProxy({ proxyRules: "" });
        }
      }
      return { success: true, normalizedUrl };
    } catch (error) {
      console.error("[Proxy] Failed to set proxy:", error);
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  });
  electron.ipcMain.handle("get-kiro-available-models", async () => {
    try {
      if (!store) return { models: [] };
      const accountData = store.get("accountData");
      if (!accountData?.accounts) return { models: [] };
      const allAccounts2 = Object.values(accountData.accounts);
      const account = allAccounts2.find(
        (acc) => acc.isActive && (acc.credentials?.accessToken || acc.credentials?.kiroApiKey)
      ) || allAccounts2.find(
        (acc) => acc.status === "active" && (acc.credentials?.accessToken || acc.credentials?.kiroApiKey)
      );
      if (!account) return { models: [] };
      const credential = resolveUpstreamKiroCredential({
        credentialKind: account.credentials?.credentialKind,
        accessToken: account.credentials?.accessToken,
        kiroApiKey: account.credentials?.kiroApiKey,
        idp: account.credentials?.provider || account.idp
      });
      const models = await fetchKiroModels({
        id: account.id,
        email: account.email,
        ...credential,
        refreshToken: account.credentials?.refreshToken,
        profileArn: account.profileArn || account.credentials?.profileArn,
        expiresAt: account.credentials?.expiresAt,
        clientId: account.credentials?.clientId,
        clientSecret: account.credentials?.clientSecret,
        region: account.credentials?.region || "us-east-1",
        authMethod: account.credentials?.authMethod
      });
      return {
        models: models.map((m) => ({
          id: m.modelId,
          name: m.modelName,
          description: m.description
        }))
      };
    } catch (error) {
      console.error("[Diagnose] Failed to fetch available models:", error);
      return {
        models: [],
        error: error instanceof Error ? error.message : "Failed to fetch models"
      };
    }
  });
  electron.ipcMain.handle(
    "account-get-models",
    async (_event, credentialInput, region, profileArn, provider, authMethod, accountId) => {
      try {
        const credential = typeof credentialInput === "string" ? resolveUpstreamKiroCredential({ accessToken: credentialInput }) : resolveUpstreamKiroCredential(credentialInput);
        const boundProxyUrl = accountId ? readAccountBoundProxyUrl(accountId) : void 0;
        const models = await fetchKiroModels({
          id: accountId || "model-list-request",
          ...credential,
          region: region || "us-east-1",
          profileArn,
          provider,
          authMethod,
          proxyUrl: boundProxyUrl
        });
        return {
          success: true,
          models: models.map((m) => ({
            id: m.modelId,
            name: m.modelName,
            description: m.description,
            inputTypes: m.supportedInputTypes,
            maxInputTokens: m.tokenLimits?.maxInputTokens,
            maxOutputTokens: m.tokenLimits?.maxOutputTokens,
            rateMultiplier: m.rateMultiplier,
            rateUnit: m.rateUnit
          }))
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to get models",
          models: []
        };
      }
    }
  );
  electron.ipcMain.handle(
    "account-get-subscriptions",
    async (_event, credentialInput, region, profileArn, provider, authMethod, accountId) => {
      try {
        const credential = typeof credentialInput === "string" ? resolveUpstreamKiroCredential({ accessToken: credentialInput }) : resolveUpstreamKiroCredential(credentialInput);
        const result = await fetchAvailableSubscriptions({
          id: accountId || "subscription-request",
          ...credential,
          region: region || "us-east-1",
          profileArn,
          provider,
          authMethod
        });
        if (result.subscriptionPlans) {
          return { success: true, plans: result.subscriptionPlans, disclaimer: result.disclaimer };
        }
        return { success: false, error: "No subscription plans returned", plans: [] };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to get subscriptions",
          plans: []
        };
      }
    }
  );
  electron.ipcMain.handle(
    "account-get-subscription-url",
    async (_event, credentialInput, subscriptionType, region, profileArn, provider, authMethod, accountId) => {
      try {
        const credential = typeof credentialInput === "string" ? resolveUpstreamKiroCredential({ accessToken: credentialInput }) : resolveUpstreamKiroCredential(credentialInput);
        const result = await fetchSubscriptionToken(
          {
            id: accountId || "subscription-request",
            ...credential,
            region: region || "us-east-1",
            profileArn,
            provider,
            authMethod
          },
          subscriptionType
        );
        if (result.encodedVerificationUrl)
          return { success: true, url: result.encodedVerificationUrl, status: result.status };
        return { success: false, error: result.message || "No subscription URL returned" };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to get subscription URL"
        };
      }
    }
  );
  electron.ipcMain.handle("open-subscription-window", async (_event, url) => {
    try {
      openBrowserInPrivateMode(url);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to open URL"
      };
    }
  });
  const originalHandleProtocolUrl = handleProtocolUrl;
  handleProtocolUrl = (url) => {
    if (!url.startsWith(`${PROTOCOL_PREFIX}://`)) return;
    try {
      const urlObj = new URL(url);
      if (url.includes("authenticate-success") || url.includes("auth")) {
        const code = urlObj.searchParams.get("code");
        const state = urlObj.searchParams.get("state");
        const error = urlObj.searchParams.get("error");
        if (error) {
          console.log("[Login] Auth callback error:", error);
          if (mainWindow) {
            mainWindow.webContents.send("social-auth-callback", { error });
            mainWindow.focus();
          }
          return;
        }
        if (code && state && mainWindow) {
          console.log("[Login] Auth callback received, code:", code.substring(0, 20) + "...");
          mainWindow.webContents.send("social-auth-callback", { code, state });
          mainWindow.focus();
        }
        return;
      }
      originalHandleProtocolUrl(url);
    } catch (error) {
      console.error("Failed to parse protocol URL:", error);
    }
  };
  createWindow();
  electron.app.on("activate", function() {
    if (electron.BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow) {
      if (process.platform === "darwin" && electron.app.dock) {
        electron.app.dock.show();
      }
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  await loadShortcutSettings();
  registerShowWindowShortcut();
});
const gotTheLock = electron.app.requestSingleInstanceLock();
if (!gotTheLock) {
  electron.app.quit();
} else {
  electron.app.on("second-instance", (_event, commandLine) => {
    const url = commandLine.find((arg) => arg.startsWith(`${PROTOCOL_PREFIX}://`));
    if (url) {
      handleProtocolUrl(url);
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
electron.app.on("open-url", (_event, url) => {
  handleProtocolUrl(url);
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    electron.app.quit();
  }
});
electron.app.on("will-quit", async (event) => {
  if (isQuitting) return;
  stopMainPoolTokenRefresh();
  proxyPoolScheduler.stop();
  kskAutomationManager.stop();
  kskHunterManager.stop();
  localAdminStatsManager.stop();
  void localAdminDirectAgent.close();
  if (lastSavedData && store) {
    event.preventDefault();
    isQuitting = true;
    const forceQuitTimer = setTimeout(() => {
      console.log("[Exit] Force quit due to timeout");
      unregisterProtocol();
      electron.app.exit(0);
    }, 3e3);
    try {
      await accountStoreCoordinator.runExclusive(async () => {
        console.log("[Exit] Saving data before quit...");
        store.set("accountData", lastSavedData);
        await createBackup(lastSavedData);
        await flushBackupNow();
        try {
          const { proxyLogStore: proxyLogStore2 } = await Promise.resolve().then(() => logger);
          await proxyLogStore2.flushSaveNow();
        } catch (err) {
          console.error("[Exit] Failed to flush proxy logs:", err);
        }
        try {
          const { shutdownTlsClientPool: shutdownTlsClientPool2 } = await Promise.resolve().then(() => tlsClientPool);
          await shutdownTlsClientPool2();
        } catch (err) {
          console.error("[Exit] Failed to shutdown TLS client pool:", err);
        }
      });
      console.log("[Exit] Data saved successfully");
    } catch (error) {
      console.error("[Exit] Failed to save data:", error);
    }
    clearTimeout(forceQuitTimer);
    unregisterProtocol();
    electron.app.exit(0);
  } else {
    unregisterProtocol();
  }
});
exports.getUsageApiType = getUsageApiType;
exports.normalizeProxyUrl = normalizeProxyUrl;
exports.setUsageApiType = setUsageApiType;
