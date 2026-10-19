import * as signalR from "@microsoft/signalr";

type DesktopBridge = {
  request: (endpoint: string, init?: RequestInit) => Promise<unknown>;
  download: (track: { trackId: number; fileName: string; contentHash: string }) => Promise<LocalCacheEntry>;
  cacheInventory: () => Promise<LocalCacheEntry[]>;
  localMedia: () => Promise<LocalMedia[]>;
  localAssignments: () => Promise<LocalAssignments>;
  saveLocalAssignments: (value: LocalAssignments) => Promise<LocalAssignments>;
  status: () => Promise<DesktopStatus>;
  chooseFolder: () => Promise<string | null>;
};
export type DesktopStatus = { serverUrl: string; libraryRoot?: string; approved: boolean };
export type LocalCacheEntry = { trackId: number; contentHash: string; size: number };
export type LocalMedia = { mediaId: string; contentKey: string; fileName: string; size: number; source: "downloaded" | "local"; title: string | null; artist: string | null };
export type LocalCatalogTrack = { contentKey: string; fileName: string; title: string | null; artist: string | null; durationSeconds: number | null; fileSize: number | null; available: boolean };
export type LocalPlayerAssignment = { playerId: number; contentKey: string; startSeconds: number };
export type LocalCue = { cueId: number; name: string; contentKey: string; startSeconds: number; sortOrder: number };
export type LocalLibraryState = { tracks: LocalCatalogTrack[]; players: LocalPlayerAssignment[]; cues: LocalCue[]; unmatchedLegacyAssignments: string[] };
export type LocalAssignment = { mediaId: string; startSeconds: number };
export type LocalSituation = LocalAssignment & { situationId: string; name: string };
export type LocalAssignments = { players: Record<string, LocalAssignment>; situations: LocalSituation[] };
const desktopBridge = (): DesktopBridge | undefined =>
  typeof window === "undefined" ? undefined : (window as unknown as { musicControl?: DesktopBridge }).musicControl;
export const desktop = {
  active: () => Boolean(desktopBridge()),
  download: (track: { trackId: number; fileName: string; contentHash: string }) => desktopBridge()?.download(track) ?? Promise.reject(new Error("Desktop downloads are unavailable in this browser.")),
  cacheInventory: () => desktopBridge()?.cacheInventory() ?? Promise.resolve([]),
  localMedia: () => desktopBridge()?.localMedia() ?? Promise.resolve([]),
  localAssignments: () => desktopBridge()?.localAssignments() ?? Promise.resolve({ players: {}, situations: [] }),
  saveLocalAssignments: (value: LocalAssignments) => desktopBridge()?.saveLocalAssignments(value) ?? Promise.resolve(value),
  localMediaUrl: (mediaId: string) => `music-control-local://${mediaId}`,
  status: () => desktopBridge()?.status() ?? Promise.resolve(null),
  chooseFolder: () => desktopBridge()?.chooseFolder() ?? Promise.resolve(null),
};

export type PlaybackState = "stopped" | "playing" | "paused" | "ended";
export type Channel = "live" | "cue";

export interface TrackSummary {
  trackId: number;
  trackKey: string;
  title: string | null;
  artist: string | null;
  fileName: string;
  durationSeconds: number | null;
  missing: boolean;
}
export interface Track extends TrackSummary {
  relativePath: string | null;
  fileSize: number | null;
  lastModifiedUtc: string | null;
  album: string | null;
  missingSince: string | null;
  contentHash: string | null;
  contentRevision: string | null;
}
export interface RequestTrack {
  trackId: number;
  title: string;
  artist: string | null;
  durationSeconds: number | null;
}
export interface RequestMessage {
  messageId: number;
  senderRole: "member" | "operator";
  senderName: string;
  body: string;
  track: RequestTrack | null;
  createdAt: string;
}
export interface Player {
  playerId: number;
  teamId: number;
  displayName: string;
  number: string | null;
  isActive: boolean;
}
export interface LineupEntry {
  slot: number;
  playerId: number;
  displayName: string;
  number: string | null;
  trackId: number | null;
  trackKey: string | null;
  trackTitle: string | null;
  trackArtist: string | null;
  trackFileName: string | null;
  trackDurationSeconds: number | null;
  startSeconds: number;
  trackMissing: boolean;
}
export interface SituationalCue {
  cueId: number;
  name: string;
  trackId: number | null;
  startSeconds: number;
  sortOrder: number;
  trackTitle: string | null;
  trackFileName: string | null;
  trackMissing: boolean;
}
export interface OperatorLease {
  held: boolean;
  consoleId: string | null;
  label: string | null;
  expiresAt: string | null;
}
export interface LibraryStatus {
  folder: string;
  folderReadable: boolean;
  trackCount: number;
  missingCount: number;
  lastScanStartedAt: string | null;
  lastScanCompletedAt: string | null;
  scanStatus: string;
  scannedFiles: number;
  totalFiles: number;
  scanMessage: string | null;
}
export interface SessionSnapshot {
  sessionId: number;
  revision: number;
  teamId: number | null;
  teamName: string | null;
  status: string;
  currentPlayerId: number | null;
  currentOrderSlot: number | null;
  queuedTrackId: number | null;
  queuedStartSeconds: number;
  liveTrackId: number | null;
  livePlaybackState: PlaybackState;
  liveError: string | null;
  liveStartSeconds: number;
  cueTrackId: number | null;
  cuePlaybackState: PlaybackState;
  cueError: string | null;
  cueStartSeconds: number;
  updatedAt: string;
  queuedTrack: TrackSummary | null;
  liveTrack: TrackSummary | null;
  cueTrack: TrackSummary | null;
  lineup: LineupEntry[];
  cues: SituationalCue[];
  operator: OperatorLease;
  library: LibraryStatus;
}
export interface AuthState {
  authenticated: boolean;
  setupRequired: boolean;
  consoleId: string | null;
  holdsOperatorLease: boolean;
  operator: OperatorLease;
  leaseTimeoutSeconds: number;
}
export interface BoardState {
  teamId: number;
  teamName: string;
  players: Player[];
  lineup: LineupEntry[];
  currentPlayerId: number | null;
  revision?: number;
}
export interface TrackDeletion {
  trackId: number;
  fileName: string;
  clearedQueue: boolean;
  stoppedLive: boolean;
  stoppedCue: boolean;
}
export interface TrackReferences {
  playerNames: string[];
  situationNames: string[];
  queued: boolean;
  live: boolean;
  cue: boolean;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
export const consoleId = (() => {
  const key = "music-control-v2.console-id";
  const existing = sessionStorage.getItem(key);
  const value = existing ?? crypto.randomUUID();
  sessionStorage.setItem(key, value);
  return value;
})();
async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const bridge = desktopBridge();
  if (bridge) {
    try {
      return await bridge.request(path, {
        method,
        headers: {
          "X-Console-Id": consoleId,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }) as T;
    } catch (error) {
      throw new ApiError(0, "desktop_request", error instanceof Error ? error.message : "Unable to reach Music Control.");
    }
  }
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      "X-Console-Id": consoleId,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return undefined as T;
  const raw = await response.text();
  const payload = raw ? JSON.parse(raw) : undefined;
  if (!response.ok)
    throw new ApiError(
      response.status,
      payload?.code ?? String(response.status),
      payload?.message ?? response.statusText,
    );
  return payload as T;
}
export const api = {
  me: () => request<AuthState>("GET", "/api/auth/me"),
  setup: (password: string) => request("POST", "/api/auth/setup", { password }),
  login: (password: string) => request("POST", "/api/auth/login", { password }),
  logout: () => request("POST", "/api/auth/logout"),
  acquireLease: (label: string) =>
    request("POST", "/api/operator/acquire", { label }),
  heartbeat: () => request("POST", "/api/operator/heartbeat"),
  releaseLease: () => request("POST", "/api/operator/release"),
  activeSession: () =>
    request<SessionSnapshot | { active: false }>("GET", "/api/sessions/active"),
  createSession: (teamId: number | null) =>
    request<SessionSnapshot>("POST", "/api/sessions", { teamId }),
  selectPlayer: (id: number, playerId: number) =>
    request<SessionSnapshot>("POST", `/api/sessions/${id}/select-player`, {
      playerId,
      queueAssignedTrack: true,
    }),
  loadLive: (id: number, trackId: number, startSeconds: number) =>
    request<SessionSnapshot>("POST", `/api/sessions/${id}/live/load`, {
      trackId,
      startSeconds,
    }),
  live: (
    id: number,
    command: "play" | "pause" | "stop",
    trackId: number | null = null,
  ) =>
    request<SessionSnapshot>("POST", `/api/sessions/${id}/live/${command}`, {
      trackId,
    }),
  fireCue: (id: number, cueId: number) =>
    request<SessionSnapshot>("POST", `/api/sessions/${id}/cues/${cueId}`, {
      channel: "live",
    }),
  board: () => request<BoardState>("GET", "/api/lineup"),
  order: (playerIds: number[]) =>
    request("PUT", "/api/lineup/order", { playerIds }),
  addPlayer: (displayName: string, number: string | null) =>
    request("POST", "/api/lineup/players", { displayName, number }),
  deletePlayer: (id: number) => request("DELETE", `/api/lineup/players/${id}`),
  tracks: (query: string) =>
    request<Track[]>(
      "GET",
      `/api/library/tracks?q=${encodeURIComponent(query)}&limit=100`,
    ),
  scan: () => request<LibraryStatus>("POST", "/api/library/scan"),
  trackReferences: (id: number) =>
    request<TrackReferences>("GET", `/api/library/tracks/${id}/references`),
  deleteTrack: (id: number) =>
    request<TrackDeletion>("DELETE", `/api/library/tracks/${id}`),
  assignTrack: (
    playerId: number,
    trackId: number | null,
    startSeconds: number,
  ) =>
    request("PUT", `/api/players/${playerId}/track`, { trackId, startSeconds }),
  cues: () => request<SituationalCue[]>("GET", "/api/cues"),
  createCue: (name: string, trackId: number | null, startSeconds: number) =>
    request<SituationalCue>("POST", "/api/cues", {
      name,
      trackId,
      startSeconds,
    }),
  updateCue: (
    id: number,
    name: string,
    trackId: number | null,
    startSeconds: number,
  ) =>
    request<SituationalCue>("PUT", `/api/cues/${id}`, {
      name,
      trackId,
      startSeconds,
    }),
  deleteCue: (id: number) => request("DELETE", `/api/cues/${id}`),
  audioUrl: (id: number) => desktopBridge() ? `music-control://${id}` : `/api/library/tracks/${id}/audio`,
  requestMessages: () => request<RequestMessage[]>("GET", "/api/requests/messages"),
  requestTracks: (query: string) => request<RequestTrack[]>("GET", `/api/requests/tracks?q=${encodeURIComponent(query)}&limit=100`),
  createRequestMessage: (displayName: string, body: string, trackId: number | null) =>
    request<RequestMessage>("POST", "/api/requests/messages", { displayName, body, trackId }),
  replyToRequest: (body: string) => request<RequestMessage>("POST", "/api/requests/operator/messages", { body }),
  clearRequestMessages: () => request<{ cleared: number }>("DELETE", "/api/requests/operator/messages"),
  localLibrary: () => request<LocalLibraryState>("GET", "/api/local-library"),
  publishLocalCatalog: (entries: Array<{ contentKey: string; fileName: string; title: string | null; artist: string | null; durationSeconds: number | null; fileSize: number }>) => request<LocalLibraryState>("PUT", "/api/local-library/catalog", entries),
  assignLocalPlayer: (playerId: number, contentKey: string, startSeconds: number) => request<LocalPlayerAssignment>("PUT", `/api/local-library/players/${playerId}`, { contentKey, startSeconds }),
  clearLocalPlayer: (playerId: number) => request("DELETE", `/api/local-library/players/${playerId}`),
  createLocalCue: (name: string, contentKey: string, startSeconds: number) => request<LocalCue>("POST", "/api/local-library/cues", { name, contentKey, startSeconds }),
  deleteLocalCue: (cueId: number) => request("DELETE", `/api/local-library/cues/${cueId}`),
  purgeVpsLibrary: () => request<{ removed: number }>("POST", "/api/local-library/purge-vps"),
};
export function clock(seconds: number | null | undefined): string {
  const total = Math.max(0, Math.floor(seconds ?? 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
export function parseClock(input: string): number | null {
  const match = input.trim().match(/^(?:(\d+):)?(\d{1,2})$/);
  if (!match) return null;
  const minutes = Number(match[1] ?? 0);
  const seconds = Number(match[2]);
  return seconds < 60 ? minutes * 60 + seconds : null;
}

export class Realtime {
  private connection: signalR.HubConnection;
  private poll: number | null = null;
  constructor(
    private readonly changed: () => void,
    private readonly status: (
      value: "online" | "reconnecting" | "offline",
    ) => void,
  ) {
    this.connection = new signalR.HubConnectionBuilder()
      .withUrl(`/hubs/music-control?consoleId=${encodeURIComponent(consoleId)}`)
      .withAutomaticReconnect([0, 1000, 3000, 5000, 10000])
      .configureLogging(signalR.LogLevel.Warning)
      .build();
    for (const event of [
      "StateSnapshot",
      "StateChanged",
      "LineupChanged",
      "OperatorLeaseChanged",
      "LibraryScanStarted",
      "LibraryScanProgress",
      "LibraryScanCompleted",
    ])
      this.connection.on(event, changed);
    this.connection.onreconnecting(() => status("reconnecting"));
    this.connection.onreconnected(() => {
      status("online");
      changed();
      void this.connection.invoke("ClientReady", null);
    });
    this.connection.onclose(() => status("offline"));
  }
  async start(): Promise<void> {
    // Installed consoles keep credentials in the Electron main process. Polling the
    // authenticated desktop bridge keeps lineups current without exposing that token
    // to renderer JavaScript or a WebSocket URL.
    if (desktopBridge()) {
      this.status("online");
      this.poll = window.setInterval(this.changed, 2500);
      return;
    }
    await this.connection.start();
    this.status("online");
    await this.connection.invoke("ClientReady", null);
  }
  reportPlayback(report: {
    sessionId: number;
    channel: Channel;
    event:
      | "loaded"
      | "playing"
      | "paused"
      | "ended"
      | "missing-file"
      | "playback-error";
    trackId: number | null;
    positionSeconds?: number;
    message?: string;
  }): void {
    if (desktopBridge()) return;
    void this.connection
      .send("PlaybackObserved", report)
      .catch(() => undefined);
  }
  stop(): void {
    if (this.poll !== null) window.clearInterval(this.poll);
    this.poll = null;
    void this.connection.stop();
  }
}

export class RequestsRealtime {
  private connection: signalR.HubConnection;
  private poll: number | null = null;
  constructor(
    private readonly received: (message: RequestMessage) => void,
    private readonly status: (value: "online" | "reconnecting" | "offline") => void,
    private readonly cleared: () => void = () => undefined,
  ) {
    this.connection = new signalR.HubConnectionBuilder()
      .withUrl("/hubs/requests")
      .withAutomaticReconnect([0, 1000, 3000, 5000, 10000])
      .configureLogging(signalR.LogLevel.Warning)
      .build();
    this.connection.on("RequestMessageCreated", received);
    this.connection.on("RequestMessagesCleared", cleared);
    this.connection.onreconnecting(() => status("reconnecting"));
    this.connection.onreconnected(() => status("online"));
    this.connection.onclose(() => status("offline"));
  }
  async start(): Promise<void> {
    // The installed desktop renderer is served from file://, where a relative SignalR
    // URL cannot reach the VPS. Mirror the main Realtime class: poll the authenticated
    // bridge instead so member requests still reach the console. Dedup is the caller's
    // responsibility (it already ignores messages it has seen).
    if (desktopBridge()) {
      this.status("online");
      const tick = async () => {
        try { for (const message of await api.requestMessages()) this.received(message); }
        catch { /* keep polling; a transient failure should not drop the console offline */ }
      };
      await tick();
      this.poll = window.setInterval(() => void tick(), 2500);
      return;
    }
    await this.connection.start();
    this.status("online");
  }
  stop(): void {
    if (this.poll !== null) window.clearInterval(this.poll);
    this.poll = null;
    void this.connection.stop();
  }
}
