import { app, BrowserWindow, dialog, ipcMain, protocol, net, shell } from "electron";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import keytar from "keytar";

// Register before app.ready so audio elements may seek and stream the local cache without
// exposing arbitrary file:// paths to the renderer.
protocol.registerSchemesAsPrivileged([
  { scheme: "music-control", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: "music-control-local", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: "music-control-stream", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

type Settings = { serverUrl: string; libraryRoot?: string };
type CachedTrack = { trackId: number; hash: string; fileName: string; path: string; size: number };
type CacheInventoryItem = { trackId: number; contentHash: string; size: number };
type LocalMedia = { mediaId: string; contentKey: string; fileName: string; size: number; source: "downloaded" | "local"; title: string | null; artist: string | null };
type LocalAssignment = { mediaId: string; startSeconds: number };
type LocalSituation = LocalAssignment & { situationId: string; name: string };
type LocalAssignments = { players: Record<string, LocalAssignment>; situations: LocalSituation[] };
const service = "Music Control";
const account = "desktop-device-token";
const settingsPath = () => path.join(app.getPath("userData"), "settings.json");
const cachePath = () => path.join(app.getPath("userData"), "library-cache.json");
const assignmentsPath = () => path.join(app.getPath("userData"), "local-assignments.json");

async function settings(): Promise<Settings> {
  try { return JSON.parse(await fs.readFile(settingsPath(), "utf8")); }
  catch { return { serverUrl: "https://music-control.taylortoast.tech" }; }
}
async function saveSettings(next: Settings) { await fs.mkdir(app.getPath("userData"), { recursive: true }); await fs.writeFile(settingsPath(), JSON.stringify(next, null, 2)); }
async function cache(): Promise<CachedTrack[]> { try { return JSON.parse(await fs.readFile(cachePath(), "utf8")); } catch { return []; } }
async function saveCache(value: CachedTrack[]) { await fs.writeFile(cachePath(), JSON.stringify(value, null, 2)); }
async function localAssignments(): Promise<LocalAssignments> { try { return JSON.parse(await fs.readFile(assignmentsPath(), "utf8")); } catch { return { players: {}, situations: [] }; } }
async function saveLocalAssignments(value: LocalAssignments) { await fs.mkdir(app.getPath("userData"), { recursive: true }); await fs.writeFile(assignmentsPath(), JSON.stringify(value, null, 2)); }
const joinUrl = (base: string, endpoint: string) => new URL(endpoint, base.replace(/\/$/, "") + "/").toString();

async function authorized(endpoint: string, init: RequestInit = {}) {
  const config = await settings(); const token = await keytar.getPassword(service, account);
  if (!token) throw new Error("This computer has not been approved yet.");
  return fetch(joinUrl(config.serverUrl, endpoint), { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
}
async function unauthenticated(endpoint: string, init: RequestInit = {}) {
  const config = await settings();
  return fetch(joinUrl(config.serverUrl, endpoint), init);
}
// The reads the server serves anonymously — the only calls a not-yet-approved desktop can
// make, and exactly what the sign-in screen needs: the setup/auth probes, the lineup board,
// the active session, and song requests. GET /api/local-library is deliberately absent: the
// server keeps it behind the operator credential, so it must travel on the token path.
function isAnonymousReadable(endpoint: string, method?: string) {
  if (endpoint === "/api/auth/setup" || endpoint === "/api/auth/me") return true;
  if ((method ?? "GET").toUpperCase() !== "GET") return false;
  return endpoint === "/api/lineup"
    || endpoint === "/api/sessions/active"
    || (endpoint.startsWith("/api/sessions/") && endpoint.endsWith("/snapshot"))
    || endpoint === "/api/requests/messages"
    || endpoint.startsWith("/api/requests/tracks");
}
function managedFolder(root: string) { return path.join(root, "Music Control"); }
function safeName(trackId: number, fileName: string) { return `${trackId}-${path.basename(fileName).replace(/[^a-zA-Z0-9._ -]/g, "_")}`; }
async function hashFile(file: string) { const data = await fs.readFile(file); return crypto.createHash("sha256").update(data).digest("hex"); }
async function verifiedCache(): Promise<CachedTrack[]> {
  const usable: CachedTrack[] = [];
  for (const item of await cache()) {
    try { if (await hashFile(item.path) === item.hash) usable.push(item); } catch { /* missing or changed outside the app */ }
  }
  await saveCache(usable);
  return usable;
}
const audioExtensions = new Set([".mp3", ".m4a", ".aac", ".wav", ".ogg", ".oga", ".opus", ".flac", ".webm"]);
// Embedded-tag reading runs in the main process (renderer has no filesystem). jsmediatags is
// pure JS and reads title/artist from mp3/m4a/flac headers. Loaded lazily so a packaging issue
// degrades to filename-only titles instead of crashing the app.
type TagResult = { tags?: { title?: string; artist?: string } };
type TagReader = { read: (path: string, callbacks: { onSuccess: (result: TagResult) => void; onError: (error: unknown) => void }) => void };
let tagReader: TagReader | undefined;
const cleanTag = (value: string | undefined): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
function readTags(file: string): Promise<{ title: string | null; artist: string | null }> {
  return new Promise(resolve => {
    try {
      tagReader ??= require("jsmediatags") as TagReader;
      tagReader.read(file, {
        onSuccess: result => resolve({ title: cleanTag(result.tags?.title), artist: cleanTag(result.tags?.artist) }),
        onError: () => resolve({ title: null, artist: null })
      });
    } catch { resolve({ title: null, artist: null }); }
  });
}
async function localMedia(): Promise<Array<LocalMedia & { path: string }>> {
  const config = await settings();
  if (!config.libraryRoot) return [];
  const folder = config.libraryRoot;
  const found: Array<LocalMedia & { path: string }> = [];
  async function visit(directory: string) {
    let entries: import("node:fs").Dirent[];
    try { entries = await fs.readdir(directory, { withFileTypes: true, encoding: "utf8" }); } catch { return; }
    for (const entry of entries) {
      const itemPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(itemPath);
      else if (entry.isFile() && audioExtensions.has(path.extname(entry.name).toLowerCase())) {
        const stat = await fs.stat(itemPath);
        const relative = path.relative(folder, itemPath).replace(/\\/g, "/");
        const contentKey = await hashFile(itemPath);
        const tags = await readTags(itemPath);
        found.push({ mediaId: contentKey, contentKey, fileName: relative, size: stat.size, source: "local", title: tags.title, artist: tags.artist, path: itemPath });
      }
    }
  }
  await visit(folder);
  return found.sort((a, b) => a.fileName.localeCompare(b.fileName));
}

function registerProtocols() { protocol.handle("music-control", async request => {
  const id = Number(new URL(request.url).hostname);
  const entry = (await cache()).find(value => value.trackId === id);
  if (!entry) return new Response("Not found", { status: 404 });
  return net.fetch(pathToFileURL(entry.path).toString());
});
protocol.handle("music-control-local", async request => {
  const mediaId = new URL(request.url).hostname;
  const entry = (await localMedia()).find(value => value.mediaId === mediaId);
  if (!entry) return new Response("Not found", { status: 404 });
  return net.fetch(pathToFileURL(entry.path).toString());
});
protocol.handle("music-control-stream", async request => {
  const id = Number(new URL(request.url).hostname);
  try {
    const response = await authorized(`/api/library/tracks/${id}/audio`);
    return new Response(response.body, { status: response.status, headers: { "Content-Type": response.headers.get("content-type") ?? "audio/mpeg" } });
  } catch { return new Response("Unavailable", { status: 503 }); }
});
}

function createWindow() {
  const win = new BrowserWindow({ width: 1280, height: 860, webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false } });
  const openInBrowser = (url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  };
  // Hosted companion tools open in the user's browser. The Electron renderer
  // remains limited to its packaged Console and authenticated VPS API bridge.
  win.webContents.setWindowOpenHandler(({ url }) => { openInBrowser(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (event, url) => {
    if (/^https?:\/\//i.test(url)) { event.preventDefault(); openInBrowser(url); }
  });
  const dev = app.isPackaged ? undefined : process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:5173";
  void win.loadURL(dev ?? pathToFileURL(path.join(__dirname, "../dist/index.html")).toString());
}
app.whenReady().then(() => { registerProtocols(); createWindow(); app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) createWindow(); }); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

ipcMain.handle("desktop:status", async () => ({ ...(await settings()), approved: Boolean(await keytar.getPassword(service, account)), cache: await cache() }));
ipcMain.handle("desktop:cache-inventory", async (): Promise<CacheInventoryItem[]> =>
  (await verifiedCache()).map(({ trackId, hash, size }) => ({ trackId, contentHash: hash, size }))
);
ipcMain.handle("desktop:local-media", async (): Promise<LocalMedia[]> => (await localMedia()).map(({ mediaId, contentKey, fileName, size, source, title, artist }) => ({ mediaId, contentKey, fileName, size, source, title, artist })));
ipcMain.handle("desktop:local-assignments", async (): Promise<LocalAssignments> => localAssignments());
ipcMain.handle("desktop:save-local-assignments", async (_event, value: LocalAssignments) => { await saveLocalAssignments(value); return value; });
ipcMain.handle("desktop:choose-folder", async () => {
  const chosen = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
  if (chosen.canceled || !chosen.filePaths[0]) return null;
  const config = await settings(); config.libraryRoot = chosen.filePaths[0]; await saveSettings(config); return config.libraryRoot;
});
ipcMain.handle("desktop:enroll", async (_event, password: string, label: string, serverUrl: string) => {
  const response = await fetch(joinUrl(serverUrl, "/api/auth/devices/enroll"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password, label }) });
  if (!response.ok) throw new Error((await response.json()).message ?? "Could not approve this computer.");
  const issued = await response.json() as { token: string }; await keytar.setPassword(service, account, issued.token);
  const config = await settings(); config.serverUrl = serverUrl; await saveSettings(config); return true;
});
ipcMain.handle("desktop:request", async (_event, endpoint: string, init?: RequestInit) => {
  // The shared Console uses the normal sign-in screen. In the desktop app, that
  // password approval mints a device credential and keeps it in Windows Credential
  // Manager instead of exposing it to the renderer.
  if (endpoint === "/api/auth/login" && init?.method === "POST") {
    const body = JSON.parse(String(init.body ?? "{}")) as { password?: string };
    const config = await settings();
    const response = await fetch(joinUrl(config.serverUrl, "/api/auth/devices/enroll"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: body.password, label: "Windows Music Control" })
    });
    const text = await response.text();
    if (!response.ok) throw new Error((text && JSON.parse(text).message) || response.statusText);
    const issued = JSON.parse(text) as { token: string };
    await keytar.setPassword(service, account, issued.token);
    return { ok: true };
  }
  if (endpoint === "/api/auth/logout" && init?.method === "POST") {
    await keytar.deletePassword(service, account);
    return { ok: true };
  }
  // Before this computer is approved there is no device token, so the public reads the
  // sign-in screen needs go out unauthenticated. GET /api/local-library and every operator
  // write stay on the token path — authorized() throws a friendly "not approved yet" message
  // when there is no credential, which the startup refresh swallows. Once a credential exists,
  // everything carries the device token, which the public endpoints simply ignore.
  const hasCredential = Boolean(await keytar.getPassword(service, account));
  const response = !hasCredential && isAnonymousReadable(endpoint, init?.method)
    ? await unauthenticated(endpoint, init)
    : await authorized(endpoint, init); const text = await response.text();
  if (!response.ok) throw new Error((text && JSON.parse(text).message) || response.statusText); return text ? JSON.parse(text) : null;
});
ipcMain.handle("desktop:download", async (_event, track: { trackId: number; fileName: string; contentHash: string }) => {
  const config = await settings(); if (!config.libraryRoot) throw new Error("Choose a music directory first.");
  const folder = managedFolder(config.libraryRoot); await fs.mkdir(folder, { recursive: true });
  const target = path.join(folder, safeName(track.trackId, track.fileName)); const temporary = `${target}.part`;
  let partialSize = 0;
  try { partialSize = (await fs.stat(temporary)).size; } catch { /* start a new transfer */ }
  const response = await authorized(`/api/library/tracks/${track.trackId}/download`, partialSize > 0 ? { headers: { Range: `bytes=${partialSize}-` } } : undefined);
  if (!response.ok || !response.body) throw new Error("Download failed.");
  // A proxy that ignores Range returns 200; replace the partial file rather than corrupting it.
  await fs.writeFile(temporary, Buffer.from(await response.arrayBuffer()), { flag: response.status === 206 && partialSize > 0 ? "a" : "w" });
  const digest = await hashFile(temporary);
  if (digest !== track.contentHash) { await fs.unlink(temporary); throw new Error("Download verification failed; no file was saved."); }
  await fs.rename(temporary, target);
  const entries = (await cache()).filter(value => value.trackId !== track.trackId);
  entries.push({ trackId: track.trackId, hash: digest, fileName: track.fileName, path: target, size: (await fs.stat(target)).size }); await saveCache(entries);
  return { trackId: track.trackId, contentHash: digest, size: (await fs.stat(target)).size };
});
ipcMain.handle("desktop:rescan", async () => {
  return (await verifiedCache()).map(({ trackId, hash, size }) => ({ trackId, contentHash: hash, size }));
});
