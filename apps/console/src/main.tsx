import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  api,
  ApiError,
  AuthState,
  BoardState,
  clock,
  desktop,
  LineupEntry,
  LocalAssignments,
  LocalCatalogTrack,
  LocalLibraryState,
  LocalMedia,
  parseClock,
  Realtime,
  RequestMessage,
  RequestsRealtime,
  SessionSnapshot,
  SituationalCue,
  Track,
} from "@music-control-v2/core";
import "./styles.css";
import "./walkup-tracks.css";

type View = "console" | "setup";
type LocalPlayback = { media: LocalMedia; startSeconds: number; label: string };
const emptyAuth: AuthState = {
  authenticated: false,
  setupRequired: false,
  consoleId: null,
  holdsOperatorLease: false,
  operator: { held: false, consoleId: null, label: null, expiresAt: null },
  leaseTimeoutSeconds: 30,
};
const isSnapshot = (
  value: Awaited<ReturnType<typeof api.activeSession>>,
): value is SessionSnapshot => "sessionId" in value;
const lineupUrl =
  import.meta.env.VITE_LINEUP_URL ?? "https://lineup.taylortoast.tech/";

function App() {
  const [view, setView] = useState<View>("console");
  const [auth, setAuth] = useState<AuthState>(emptyAuth);
  const [board, setBoard] = useState<BoardState | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [link, setLink] = useState<"online" | "reconnecting" | "offline">(
    "offline",
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [localMedia, setLocalMedia] = useState<LocalMedia[]>([]);
  const [localAssignments, setLocalAssignments] = useState<LocalAssignments>({ players: {}, situations: [] });
  const [localLibrary, setLocalLibrary] = useState<LocalLibraryState>({ tracks: [], players: [], cues: [], unmatchedLegacyAssignments: [] });
  const [localPlayback, setLocalPlayback] = useState<LocalPlayback | null>(null);
  const [gate, setGate] = useState<"none" | "login" | "setup">("none");
  const [requests, setRequests] = useState<RequestMessage[]>([]);
  const [reply, setReply] = useState("");
  const realtime = useRef<Realtime | null>(null);
  const releasedByUser = useRef(false);
  const refresh = useCallback(async () => {
    try {
      const [nextAuth, nextBoard, active] = await Promise.all([
        api.me(),
        api.board(),
        api.activeSession(),
      ]);
      setAuth(nextAuth);
      setBoard(nextBoard);
      setSnapshot(isSnapshot(active) ? active : null);
      void api.localLibrary().then(setLocalLibrary).catch(() => undefined);
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Unable to reach Music Control.",
      );
    }
  }, []);
  useEffect(() => {
    void refresh();
    const connection = new Realtime(() => void refresh(), setLink);
    realtime.current = connection;
    void connection.start().catch(() => setLink("offline"));
    return () => {
      void connection.stop();
      realtime.current = null;
    };
  }, [refresh]);
  const addRequest = useCallback((message: RequestMessage) => {
    setRequests((current) => current.some((item) => item.messageId === message.messageId) ? current : [...current, message]);
  }, []);
  useEffect(() => {
    void api.requestMessages().then(setRequests).catch(() => undefined);
    const connection = new RequestsRealtime(addRequest, () => undefined, () => setRequests([]));
    void connection.start().catch(() => undefined);
    return () => connection.stop();
  }, [addRequest]);
  const refreshLocal = useCallback(() => {
    if (!desktop.active()) return;
    void Promise.all([desktop.localMedia(), desktop.localAssignments()])
      .then(([media, assignments]) => { setLocalMedia(media); setLocalAssignments(assignments); })
      .catch((error: Error) => setNotice(error.message));
  }, []);
  useEffect(() => { refreshLocal(); }, [refreshLocal]);
  useEffect(() => {
    if (auth.authenticated && auth.holdsOperatorLease) {
      const timer = window.setInterval(
        () => {
          void api.heartbeat().catch(() => void refresh());
        },
        Math.max(5, Math.floor(auth.leaseTimeoutSeconds / 3)) * 1000,
      );
      return () => clearInterval(timer);
    }
  }, [
    auth.authenticated,
    auth.holdsOperatorLease,
    auth.leaseTimeoutSeconds,
    refresh,
  ]);
  useEffect(() => {
    if (
      !auth.authenticated ||
      auth.holdsOperatorLease ||
      auth.operator.held ||
      releasedByUser.current
    )
      return;
    void api
      .acquireLease("Music Control v2")
      .then(refresh)
      .catch(() => void refresh());
  }, [
    auth.authenticated,
    auth.holdsOperatorLease,
    auth.operator.held,
    refresh,
  ]);
  const operator = auth.authenticated && auth.holdsOperatorLease;
  const command = async (work: () => Promise<unknown>) => {
    try {
      await work();
      await refresh();
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "The command could not be completed.",
      );
    }
  };
  const startSession = () => {
    if (!board) return;
    void command(() => api.createSession(board.teamId));
  };
  const selectPlayer = (entry: LineupEntry) => {
    if (!snapshot) {
      setNotice("Start a session before selecting a player.");
      return;
    }
    const assignment = localLibrary.players.find((item) => item.playerId === entry.playerId);
    const localMediaMatch = assignment && localMedia.find((item) => item.contentKey === assignment.contentKey);
    // Assignments published by the lease holder are the only source of truth in
    // the desktop app.  The old per-computer overrides are intentionally not a
    // playback fallback: doing so would make the public assignment appear to
    // work while another operator desktop could not resolve it.
    const override = desktop.active() ? undefined : localAssignments.players[String(entry.playerId)];
    const media = localMediaMatch ?? (override && localMedia.find((item) => item.mediaId === override.mediaId));
    if (media) {
      void command(async () => {
        await api.selectPlayer(snapshot.sessionId, entry.playerId);
        setLocalPlayback({ media, startSeconds: assignment?.startSeconds ?? override?.startSeconds ?? 0, label: `${entry.displayName}'s local walk-up music` });
        setNotice(`${entry.displayName}'s local walk-up track is loaded.`);
      });
      return;
    }
    if (desktop.active()) {
      setLocalPlayback(null);
      setNotice(`${entry.displayName}'s assigned local track is not available on this operator desktop.`);
      return;
    }
    setLocalPlayback(null);
    void command(async () => {
      const updated = await api.selectPlayer(
        snapshot.sessionId,
        entry.playerId,
      );
      if (updated.queuedTrackId === null) {
        setNotice(`${entry.displayName} was selected, but has no walk-up track assigned.`);
        return;
      }
      await api.loadLive(
        snapshot.sessionId,
        updated.queuedTrackId,
        updated.queuedStartSeconds,
      );
      setNotice(`${entry.displayName}'s walk-up track is loaded and ready to play.`);
    });
  };
  const acquire = () => {
    releasedByUser.current = false;
    void command(async () => {
      await api.acquireLease("Music Control v2");
    });
  };
  const release = () => {
    releasedByUser.current = true;
    void command(api.releaseLease);
  };
  const login = async (password: string, setup: boolean) => {
    try {
      if (setup) await api.setup(password);
      await api.login(password);
      releasedByUser.current = false;
      setGate("none");
      await refresh();
      await api.acquireLease("Music Control v2");
      await refresh();
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : "Sign-in failed.");
    }
  };
  const signOut = () => {
    releasedByUser.current = true;
    void command(async () => {
      await api.logout();
      setGate("login");
    });
  };
  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand__dot" aria-hidden="true" />
          Music Control <small>v2 preview</small>
        </div>
        <nav aria-label="Views">
          <button
            className={view === "console" ? "nav active" : "nav"}
            onClick={() => setView("console")}
          >
            Console
          </button>
          <button
            className={view === "setup" ? "nav active" : "nav"}
            onClick={() => setView("setup")}
          >
            Music setup
          </button>
          <a
            className="nav"
            href="https://lineup.taylortoast.tech/"
            target="_blank"
            rel="noreferrer"
          >
            Lineup ↗
          </a>
          <a
            className="nav"
            href="https://library-upload.taylortoast.tech/"
            target="_blank"
            rel="noreferrer"
          >
            Music upload ↗
          </a>
          <a
            className="nav"
            href="https://requests.taylortoast.tech/"
            target="_blank"
            rel="noreferrer"
          >
            Team requests ↗
          </a>
          <a className="nav" href="https://music-control.taylortoast.tech/download/" target="_blank" rel="noreferrer">
            Download desktop
          </a>
          <a className="nav" href="https://www.youtube.com/" target="_blank" rel="noreferrer">YouTube ↗</a>
        </nav>
        <div className="topbar__right">
          <span className={`status status--${link}`}>
            {link === "online" ? "Live link" : link}
          </span>
          <span className={operator ? "status status--operator" : "status"}>
            {operator ? "Operator" : "View only"}
          </span>
          {auth.authenticated ? (
            <>
              <button
                className="link-button"
                onClick={operator ? release : acquire}
                disabled={!operator && auth.operator.held}
              >
                {" "}
                {operator ? "Release console" : "Take console"}{" "}
              </button>
              <button className="link-button" onClick={signOut}>
                Sign out
              </button>
            </>
          ) : (
            <button
              className="link-button"
              onClick={() => setGate(auth.setupRequired ? "setup" : "login")}
            >
              Sign in
            </button>
          )}
        </div>
      </header>
      {notice && (
        <div className="notice" role="status">
          {notice}
          <button onClick={() => setNotice(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      {view === "console" ? (
        <Console
          board={board}
          snapshot={snapshot}
          operator={operator}
          onStart={startSession}
          onSelect={selectPlayer}
          onTransport={(verb) =>
            snapshot && void command(() => api.live(snapshot.sessionId, verb))
          }
          onCue={(cue) =>
            snapshot &&
            void command(() => api.fireCue(snapshot.sessionId, cue.cueId))
          }
          localMedia={localMedia}
          localAssignments={localAssignments}
          localLibrary={localLibrary}
          localPlayback={localPlayback}
          onLocalCue={(situation) => {
            const media = localMedia.find((item) => item.mediaId === situation.mediaId);
            if (media) setLocalPlayback({ media, startSeconds: situation.startSeconds, label: situation.name });
          }}
          onLocalCatalogCue={(cue) => {
            const media = localMedia.find((item) => item.contentKey === cue.contentKey);
            if (media) setLocalPlayback({ media, startSeconds: cue.startSeconds, label: cue.name });
            else setNotice(`${cue.name}'s file is not available on this desktop.`);
          }}
          onPlayback={(report) => realtime.current?.reportPlayback(report)}
          requests={requests}
          reply={reply}
          onReplyChange={setReply}
          onReply={() => void command(async () => { const created = await api.replyToRequest(reply); addRequest(created); setReply(""); })}
          onClear={() => void command(async () => { await api.clearRequestMessages(); setRequests([]); })}
        />
      ) : (
        <Setup
          board={board}
          operator={operator}
          onRefresh={refresh}
          alert={setNotice}
          localMedia={localMedia}
          localAssignments={localAssignments}
          onLocalAssignments={async (value) => {
            const saved = await desktop.saveLocalAssignments(value);
            setLocalAssignments(saved);
          }}
          onLocalRefresh={refreshLocal}
          onLocalLibrary={setLocalLibrary}
        />
      )}
      {gate !== "none" && (
        <Gate
          setup={gate === "setup"}
          onClose={() => setGate("none")}
          onSubmit={login}
        />
      )}
    </main>
  );
}

function Console({
  board,
  snapshot,
  operator,
  onStart,
  onSelect,
  onTransport,
  onCue,
  onPlayback,
  localMedia,
  localAssignments,
  localLibrary,
  localPlayback,
  onLocalCue,
  onLocalCatalogCue,
  requests,
  reply,
  onReplyChange,
  onReply,
  onClear,
}: {
  board: BoardState | null;
  snapshot: SessionSnapshot | null;
  operator: boolean;
  onStart: () => void;
  onSelect: (entry: LineupEntry) => void;
  onTransport: (verb: "play" | "pause" | "stop") => void;
  onCue: (cue: SituationalCue) => void;
  onPlayback: (report: {
    sessionId: number;
    channel: "live";
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
  }) => void;
  localMedia: LocalMedia[];
  localAssignments: LocalAssignments;
  localLibrary: LocalLibraryState;
  localPlayback: LocalPlayback | null;
  onLocalCue: (situation: LocalAssignments["situations"][number]) => void;
  onLocalCatalogCue: (cue: LocalLibraryState["cues"][number]) => void;
  requests: RequestMessage[];
  reply: string;
  onReplyChange: (value: string) => void;
  onReply: () => void;
  onClear: () => void;
}) {
  const [requestsOpen, setRequestsOpen] = useState(false);
  const audio = useLiveAudio(snapshot, operator, onPlayback);
  const localAudio = useLocalAudio(localPlayback, operator);
  const isLocal = Boolean(localPlayback);
  const activeAudio = isLocal ? localAudio : audio;
  const current =
    snapshot?.lineup.find(
      (entry) => entry.playerId === snapshot.currentPlayerId,
    ) ?? null;
  const live = snapshot?.liveTrack ?? null;
  const lineup = board?.lineup ?? snapshot?.lineup ?? [];
  return (
    <>
    <div className="console-layout">
      <aside className="lineup">
        <div className="lineup__head">
          <div>
            <span className="eyebrow">Player lineup</span>
            <h1>{board?.teamName ?? "Lineup"}</h1>
          </div>
          <a href={lineupUrl} target="_blank" rel="noreferrer">
            Edit lineup ↗
          </a>
        </div>
        <ol className="lineup__list">
          {lineup.map((entry) => {
            const localAssignment = localLibrary.players.find((item) => item.playerId === entry.playerId);
            const localTrack = localAssignment && localLibrary.tracks.find((item) => item.contentKey === localAssignment.contentKey);
            const localOverride = localAssignments.players[String(entry.playerId)];
            const unassigned = entry.trackId === null && !localOverride && !localAssignment;
            return (
              <li key={entry.playerId}>
                <button
                  className={`player ${unassigned ? "player--unassigned" : ""} ${entry.playerId === snapshot?.currentPlayerId ? "player--current" : ""}`}
                  disabled={unassigned || !operator || !snapshot}
                  onClick={() => onSelect(entry)}
                >
                  <span className="player__slot">{entry.slot}</span>
                  <span>
                    <strong>{entry.displayName}</strong>
                    {entry.number && (
                      <small>{unassigned ? entry.number : `#${entry.number}`}</small>
                    )}
                    {!unassigned && (
                      <em>
                        {localOverride
                          ? `Local only: ${localMedia.find((item) => item.mediaId === localOverride.mediaId)?.fileName ?? "file unavailable"}`
                          : localTrack?.title ??
                          entry.trackTitle ??
                          entry.trackFileName ??
                          "Walk-up music"}
                      </em>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        {!snapshot && (
          <button
            className="session-button"
            disabled={!operator || !board}
            onClick={onStart}
          >
            Start session
          </button>
        )}
        <p className="lineup__hint">
          The lineup updates automatically as it changes.
        </p>
      </aside>
      <section className="control-area">
        <section className="now-playing" aria-labelledby="now-playing-title">
          <div className="now-playing__identity">
            <span className="eyebrow" id="now-playing-title">
              Now playing
            </span>
            <h2>{localPlayback?.media.fileName ?? live?.title ?? live?.fileName ?? "Nothing loaded"}</h2>
            <p>
              {isLocal ? `${localPlayback?.label} · local only` : live?.artist ??
                (current
                  ? `Current player: ${current.displayName}`
                  : "Start a session and select a player.")}
            </p>
            {current && (
              <dl>
                <div>
                  <dt>Current player</dt>
                  <dd>
                    {current.displayName}
                    {current.number ? ` · #${current.number}` : ""}
                  </dd>
                </div>
                <div>
                  <dt>Walk-up starts</dt>
                  <dd>{clock(current.startSeconds)}</dd>
                </div>
              </dl>
            )}
          </div>
          <div className="meter">
            <div className="meter__head">
              <span>Time</span>
              <strong>
                {clock(activeAudio.position)} <i>/</i>{" "}
                {clock(isLocal ? activeAudio.duration : live?.durationSeconds ?? activeAudio.duration)}
              </strong>
            </div>
            <div
              className="progress"
              role="progressbar"
              aria-label="Track progress"
              aria-valuemin={0}
              aria-valuemax={isLocal ? activeAudio.duration ?? 0 : live?.durationSeconds ?? 0}
              aria-valuenow={activeAudio.position}
            >
              <span style={{ width: `${activeAudio.progress}%` }} />
            </div>
          </div>
          <div className="volume">
            <label htmlFor="volume">Volume</label>
            <input
              id="volume"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={activeAudio.volume}
              onChange={(event) => activeAudio.setVolume(Number(event.target.value))}
            />
            <span>{Math.round(activeAudio.volume * 100)}%</span>
          </div>
        </section>
        <div className="transport" aria-label="Live music controls">
          <button
            className="transport__play"
            disabled={!operator || !snapshot || (!live && !isLocal)}
            onClick={() => isLocal ? void localAudio.play() : onTransport("play")}
          >
            Play
          </button>
          <button
            disabled={!operator || !snapshot || (!live && !isLocal)}
            onClick={() => isLocal ? localAudio.pause() : onTransport("pause")}
          >
            Pause
          </button>
          <button
            disabled={!operator || !snapshot || (!live && !isLocal)}
            onClick={() => isLocal ? localAudio.stop() : onTransport("stop")}
          >
            Stop
          </button>
        </div>
        <section className="moments">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Quick moments</span>
              <h2>Situation music</h2>
            </div>
            <span>{snapshot?.cues.length ?? 0} configured</span>
          </div>
          <div className="moments__grid">
            {localAssignments.situations.map((situation) => (
              <button key={`local-${situation.situationId}`} disabled={!operator || !localMedia.some((item) => item.mediaId === situation.mediaId)} onClick={() => onLocalCue(situation)}>
                <strong>{situation.name}</strong><small>Local only · {localMedia.find((item) => item.mediaId === situation.mediaId)?.fileName ?? "File missing"}</small>
              </button>
            ))}
            {snapshot?.cues.map((cue) => (
              <button
                key={cue.cueId}
                disabled={!operator || cue.trackId === null || cue.trackMissing}
                onClick={() => onCue(cue)}
              >
                <strong>{cue.name}</strong>
                <small>
                  {cue.trackMissing
                    ? "File missing"
                    : (cue.trackTitle ??
                      cue.trackFileName ??
                      "No track assigned")}
                </small>
              </button>
            ))}
            {localLibrary.cues.map((cue) => {
              const track = localLibrary.tracks.find((item) => item.contentKey === cue.contentKey);
              return <button key={`local-${cue.cueId}`} disabled={!operator || !track?.available || !localMedia.some((item) => item.contentKey === cue.contentKey)} onClick={() => onLocalCatalogCue(cue)}><strong>{cue.name}</strong><small>{track?.title ?? "Local file unavailable"}</small></button>;
            })}
          </div>
          {snapshot && snapshot.cues.length === 0 && (
            <p className="empty">Set up moment music from Music setup.</p>
          )}
        </section>
      </section>
    </div>
    <button
      className={requestsOpen ? "requests-toggle requests-toggle--hidden" : "requests-toggle"}
      onClick={() => setRequestsOpen(true)}
      aria-expanded={requestsOpen}
    >
      Team requests{requests.length ? <span className="requests-toggle__count">{requests.length}</span> : null}
    </button>
    {requestsOpen && <div className="requests-scrim" onClick={() => setRequestsOpen(false)} aria-hidden="true" />}
    <aside className={requestsOpen ? "requests-drawer requests-drawer--open" : "requests-drawer"} aria-hidden={!requestsOpen}>
      <button className="requests-drawer__close" onClick={() => setRequestsOpen(false)} aria-label="Close team requests">×</button>
      <RequestChat requests={requests} reply={reply} onReplyChange={onReplyChange} onReply={onReply} onClear={onClear} enabled={operator} />
    </aside>
    </>
  );
}

function RequestChat({ requests, reply, onReplyChange, onReply, onClear, enabled }: { requests: RequestMessage[]; reply: string; onReplyChange: (value: string) => void; onReply: () => void; onClear: () => void; enabled: boolean }) {
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const element = list.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [requests]);
  const formatTime = (value: string) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
  return <section className="request-chat" aria-labelledby="request-chat-title"><div className="section-heading"><div><span className="eyebrow">Team requests</span><h2 id="request-chat-title">Messages for the music operator</h2></div><a href="https://requests.taylortoast.tech/" target="_blank" rel="noreferrer">Open member link ↗</a></div><div className="request-chat__actions"><button className="quiet" disabled={!enabled || requests.length === 0} onClick={onClear}>Clear today</button></div><ol ref={list}>{requests.length ? requests.map((message) => <li key={message.messageId} className={message.senderRole}><div><strong>{message.senderName}</strong><time>{formatTime(message.createdAt)}</time></div><p>{message.body}</p>{message.track && <small>♫ {message.track.title}{message.track.artist ? ` — ${message.track.artist}` : ""}</small>}</li>) : <li className="empty">No requests yet today.</li>}</ol><div className="request-chat__composer"><textarea value={reply} maxLength={600} placeholder={enabled ? "Reply to the team…" : "Sign in to reply"} disabled={!enabled} onChange={(event) => onReplyChange(event.target.value)} /><button className="primary" disabled={!enabled || !reply.trim()} onClick={onReply}>Send reply</button></div></section>;
}

function useLiveAudio(
  snapshot: SessionSnapshot | null,
  enabled: boolean,
  report: (value: {
    sessionId: number;
    channel: "live";
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
  }) => void,
) {
  const element = useRef<HTMLAudioElement | null>(null);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);
  const [volume, updateVolume] = useState(() => {
    const saved = Number(localStorage.getItem("music-control-v2.live-volume"));
    return Number.isFinite(saved) ? saved : 1;
  });
  const source = snapshot?.liveTrackId;
  const start = snapshot?.liveStartSeconds ?? 0;
  useEffect(() => {
    const audio = element.current ?? new Audio();
    element.current = audio;
    audio.volume = volume;
    if (!enabled || !snapshot || source === null || source === undefined) {
      audio.pause();
      audio.removeAttribute("src");
      return;
    }
    const send = (
      event:
        | "loaded"
        | "playing"
        | "paused"
        | "ended"
        | "missing-file"
        | "playback-error",
      message?: string,
    ) =>
      report({
        sessionId: snapshot.sessionId,
        channel: "live",
        event,
        trackId: source,
        positionSeconds: audio.currentTime,
        ...(message ? { message } : {}),
      });
    const loaded = () => send("loaded");
    const playing = () => send("playing");
    const paused = () => send("paused");
    const ended = () => send("ended");
    const failed = () =>
      send(
        audio.error?.code === 4 ? "missing-file" : "playback-error",
        `media error ${audio.error?.code ?? "unknown"}`,
      );
    audio.addEventListener("loadedmetadata", loaded);
    audio.addEventListener("playing", playing);
    audio.addEventListener("pause", paused);
    audio.addEventListener("ended", ended);
    audio.addEventListener("error", failed);
    const url = `${api.audioUrl(source)}${start > 0 ? `#t=${start}` : ""}`;
    if (audio.src !== new URL(url, location.href).href) {
      audio.src = url;
      audio.currentTime = start;
    }
    if (snapshot.livePlaybackState === "playing")
      void audio
        .play()
        .catch((error: Error) => send("playback-error", error.message));
    else {
      audio.pause();
      if (snapshot.livePlaybackState === "stopped") audio.currentTime = start;
    }
    return () => {
      audio.removeEventListener("loadedmetadata", loaded);
      audio.removeEventListener("playing", playing);
      audio.removeEventListener("pause", paused);
      audio.removeEventListener("ended", ended);
      audio.removeEventListener("error", failed);
    };
  }, [enabled, snapshot, source, start, report]);
  useEffect(() => {
    const audio = element.current ?? new Audio();
    element.current = audio;
    const tick = () => {
      setPosition(Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
      setDuration(Number.isFinite(audio.duration) ? audio.duration : null);
    };
    audio.addEventListener("timeupdate", tick);
    audio.addEventListener("loadedmetadata", tick);
    return () => {
      audio.removeEventListener("timeupdate", tick);
      audio.removeEventListener("loadedmetadata", tick);
    };
  }, []);
  return {
    position,
    duration,
    progress: duration ? Math.min(100, (position / duration) * 100) : 0,
    volume,
    setVolume: (value: number) => {
      const safe = Math.max(0, Math.min(1, value));
      updateVolume(safe);
      localStorage.setItem("music-control-v2.live-volume", String(safe));
      if (element.current) element.current.volume = safe;
    },
  };
}

function useLocalAudio(playback: LocalPlayback | null, enabled: boolean) {
  const element = useRef<HTMLAudioElement | null>(null);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);
  const [volume, setVolumeState] = useState(1);
  useEffect(() => {
    const audio = element.current ?? new Audio();
    element.current = audio;
    if (!enabled || !playback) { audio.pause(); audio.removeAttribute("src"); return; }
    const target = playback.startSeconds || 0;
    audio.src = `${desktop.localMediaUrl(playback.media.mediaId)}#t=${target}`;
    audio.volume = volume;
    // currentTime can only be applied once the media is seekable; setting it right after src
    // (readyState 0) is a no-op, which made the Start-at offset start playback at 0. Seek when
    // metadata loads, and again on canplay, until the element is actually at the target.
    const seek = () => { try { if (target > 0 && Math.abs(audio.currentTime - target) > 0.25) audio.currentTime = target; } catch { /* not seekable yet */ } };
    audio.addEventListener("loadedmetadata", seek);
    audio.addEventListener("canplay", seek);
    seek();
    return () => { audio.pause(); audio.removeEventListener("loadedmetadata", seek); audio.removeEventListener("canplay", seek); };
  }, [enabled, playback]);
  useEffect(() => {
    const audio = element.current ?? new Audio(); element.current = audio;
    const tick = () => { setPosition(Number.isFinite(audio.currentTime) ? audio.currentTime : 0); setDuration(Number.isFinite(audio.duration) ? audio.duration : null); };
    audio.addEventListener("timeupdate", tick); audio.addEventListener("loadedmetadata", tick);
    return () => { audio.removeEventListener("timeupdate", tick); audio.removeEventListener("loadedmetadata", tick); };
  }, []);
  return {
    position, duration, progress: duration ? Math.min(100, (position / duration) * 100) : 0, volume,
    setVolume: (value: number) => { const safe = Math.max(0, Math.min(1, value)); setVolumeState(safe); if (element.current) element.current.volume = safe; },
    play: () => element.current?.play(), pause: () => element.current?.pause(), stop: () => { if (element.current) { element.current.pause(); element.current.currentTime = playback?.startSeconds ?? 0; } },
  };
}

function Setup({
  board,
  operator,
  onRefresh,
  alert,
  localMedia,
  localAssignments,
  onLocalAssignments,
  onLocalRefresh,
  onLocalLibrary,
}: {
  board: BoardState | null;
  operator: boolean;
  onRefresh: () => Promise<void>;
  alert: (value: string) => void;
  localMedia: LocalMedia[];
  localAssignments: LocalAssignments;
  onLocalAssignments: (value: LocalAssignments) => Promise<void>;
  onLocalRefresh: () => void;
  onLocalLibrary: (value: LocalLibraryState) => void;
}) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [query, setQuery] = useState("");
  const [playerId, setPlayerId] = useState<number | null>(null);
  const [start, setStart] = useState("0:00");
  const [cues, setCues] = useState<SituationalCue[]>([]);
  const [cueName, setCueName] = useState("");
  const [cueStart, setCueStart] = useState("0:00");
  const [setupTab, setSetupTab] = useState<"walkup" | "situations">("walkup");
  const [localTracks, setLocalTracks] = useState<Map<number, string>>(new Map());
  const [downloadingTrackId, setDownloadingTrackId] = useState<number | null>(null);
  const [selectedSituationTrack, setSelectedSituationTrack] = useState<{ kind: "vps"; trackId: number } | { kind: "local"; mediaId: string } | null>(null);
  const [situationQuery, setSituationQuery] = useState("");
  const load = useCallback(async () => {
    try {
      const [found, configured] = await Promise.all([
        api.tracks(query),
        api.cues(),
      ]);
      setTracks(found);
      setCues(configured);
    } catch (error) {
      alert(
        error instanceof Error ? error.message : "Could not load music setup.",
      );
    }
  }, [query, alert]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 150);
    return () => clearTimeout(timer);
  }, [board, load]);
  const refreshLocalInventory = useCallback(async () => {
    if (!desktop.active()) return;
    try {
      const inventory = await desktop.cacheInventory();
      setLocalTracks(new Map(inventory.map((entry) => [entry.trackId, entry.contentHash])));
    } catch (error) {
      alert(error instanceof Error ? error.message : "Could not inspect the local music cache.");
    }
  }, [alert]);
  useEffect(() => { void refreshLocalInventory(); }, [refreshLocalInventory]);
  const [libraryFolder, setLibraryFolder] = useState<string | null>(null);
  useEffect(() => {
    if (desktop.active()) void desktop.status().then((s) => setLibraryFolder(s?.libraryRoot ?? null)).catch(() => undefined);
  }, []);
  const chooseLibraryFolder = async () => {
    try {
      const chosen = await desktop.chooseFolder();
      if (!chosen) return;
      setLibraryFolder(chosen);
      await refreshLocalInventory();
      onLocalRefresh();
      alert(`Music folder set. Audio files in the "Music Control" subfolder of ${chosen} are now available.`);
    } catch (error) {
      alert(error instanceof Error ? error.message : "Could not set the music folder.");
    }
  };
  const localState = (track: Track) => {
    if (track.missing) return { label: "Server missing", className: "cache-state--server-missing", downloadable: false };
    if (!track.contentHash) return { label: "Download unavailable", className: "cache-state--missing", downloadable: false };
    const localHash = localTracks.get(track.trackId);
    if (!localHash) return { label: "Missing locally", className: "cache-state--missing", downloadable: true };
    if (localHash !== track.contentHash) return { label: "Outdated local copy", className: "cache-state--outdated", downloadable: true };
    return { label: "Local copy ready", className: "cache-state--local", downloadable: false };
  };
  const selected =
    board?.lineup.find((entry) => entry.playerId === playerId) ?? null;
  useEffect(() => {
    if (!playerId && board?.lineup[0]) setPlayerId(board.lineup[0].playerId);
  }, [board, playerId]);
  const assign = async (trackId: number | null) => {
    if (!operator || !playerId) return;
    const seconds = parseClock(start);
    if (seconds === null) return alert("Use m:ss for the walk-up start time.");
    try {
      await api.assignTrack(playerId, trackId, seconds);
      await onRefresh();
      alert(
        trackId === null ? "Walk-up music cleared." : "Walk-up music saved.",
      );
    } catch (error) {
      alert(
        error instanceof Error
          ? error.message
          : "Could not save walk-up music.",
      );
    }
  };
  const assignLocalPlayer = async (mediaId: string) => {
    if (!playerId) return;
    const seconds = parseClock(start);
    if (seconds === null) return alert("Use m:ss for the walk-up start time.");
    const players = { ...localAssignments.players };
    if (mediaId) players[String(playerId)] = { mediaId, startSeconds: seconds };
    else delete players[String(playerId)];
    try { await onLocalAssignments({ ...localAssignments, players }); alert(mediaId ? "Local-only walk-up music saved on this computer." : "Local-only walk-up override cleared."); }
    catch (error) { alert(error instanceof Error ? error.message : "Could not save local-only walk-up music."); }
  };
  const addSituation = async (event: FormEvent) => {
    event.preventDefault();
    const seconds = parseClock(cueStart);
    if (!cueName.trim() || !selectedSituationTrack || seconds === null)
      return alert("Choose a name, a track from the list, and a valid start time.");
    try {
      if (selectedSituationTrack.kind === "vps") {
        await api.createCue(cueName.trim(), selectedSituationTrack.trackId, seconds);
        setCueName(""); setSelectedSituationTrack(null);
        await load(); await onRefresh();
      } else {
        await onLocalAssignments({ ...localAssignments, situations: [...localAssignments.situations, { situationId: crypto.randomUUID(), name: cueName.trim(), mediaId: selectedSituationTrack.mediaId, startSeconds: seconds }] });
        setCueName(""); setSelectedSituationTrack(null);
      }
    } catch (error) { alert(error instanceof Error ? error.message : "Could not add situation music."); }
  };
  const removeTrack = async (track: Track) => {
    try {
      const refs = await api.trackReferences(track.trackId);
      const affected = [
        ...refs.playerNames.map((name) => `player: ${name}`),
        ...refs.situationNames.map((name) => `situation: ${name}`),
        ...(refs.queued ? ["queued next"] : []),
        ...(refs.live ? ["live playback"] : []),
        ...(refs.cue ? ["cue playback"] : []),
      ];
      const detail = affected.length
        ? `\n\nThis will clear: ${affected.join(", ")}.`
        : "";
      if (
        !confirm(
          `Delete ${track.title ?? track.fileName}? This cannot be undone.${detail}`,
        )
      )
        return;
      const result = await api.deleteTrack(track.trackId);
      await load();
      await onRefresh();
      alert(`Deleted ${result.fileName}.`);
    } catch (error) {
      alert(error instanceof Error ? error.message : "Could not delete track.");
    }
  };
  if (desktop.active()) return <LocalOnlySetup board={board} operator={operator} alert={alert} onRefresh={onRefresh} onLocalRefresh={onLocalRefresh} onLocalLibrary={onLocalLibrary} />;
  return (
    <section className="setup">
      <div className="setup-tabs" role="tablist" aria-label="Music setup">
        <button
          type="button"
          role="tab"
          aria-selected={setupTab === "walkup"}
          className={
            setupTab === "walkup" ? "setup-tab setup-tab--active" : "setup-tab"
          }
          onClick={() => setSetupTab("walkup")}
        >
          Walk-up Music
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={setupTab === "situations"}
          className={
            setupTab === "situations"
              ? "setup-tab setup-tab--active"
              : "setup-tab"
          }
          onClick={() => setSetupTab("situations")}
        >
          Situation Music
        </button>
      </div>
      <div className="setup__grid">
        {setupTab === "walkup" && (
          <section className="panel" role="tabpanel">
            <div className="panel__head">
              <h2>Walk-up music</h2>
              <span className="panel__actions">
                {desktop.active() && <button className="quiet" onClick={() => void chooseLibraryFolder()}>{libraryFolder ? "Change music folder" : "Choose music folder"}</button>}
                {desktop.active() && <button className="quiet" onClick={() => { void refreshLocalInventory(); onLocalRefresh(); }}>Refresh local files</button>}
                <button
                  disabled={!operator}
                  onClick={() =>
                    void api
                      .scan()
                      .then(() => alert("Library refresh started."))
                      .catch((e: Error) => alert(e.message))
                  }
                >
                  Refresh VPS library
                </button>
              </span>
            </div>
            {desktop.active() && (
              <p className="library-folder-note">
                {libraryFolder
                  ? <>Local music folder: <strong>{libraryFolder}</strong> — audio files in its <strong>Music Control</strong> subfolder appear in the lists below.</>
                  : <>No local music folder chosen yet. Click <strong>Choose music folder</strong> so the app can find and play your local tracks.</>}
              </p>
            )}
            <div className="walkup-editor">
              <aside className="walkup-roster">
                <span className="eyebrow">Lineup</span>
                <div>
                  {board?.lineup.map((entry) => (
                    <button
                      key={entry.playerId}
                      className={
                        entry.playerId === playerId
                          ? "walkup-player walkup-player--selected"
                          : "walkup-player"
                      }
                      onClick={() => {
                        setPlayerId(entry.playerId);
                        setStart(clock(entry.startSeconds));
                      }}
                    >
                      <span>{entry.slot}</span>
                      <strong>{entry.displayName}</strong>
                      {entry.number && <small>#{entry.number}</small>}
                      <em>
                        {entry.trackId
                          ? (entry.trackTitle ?? entry.trackFileName)
                          : "No music assigned"}
                      </em>
                    </button>
                  ))}
                </div>
              </aside>
              <div className="walkup-work">
                <h3>{selected?.displayName ?? "Select a player"}</h3>
                <label>
                  Start at
                  <input
                    value={start}
                    onChange={(e) => setStart(e.target.value)}
                    placeholder="0:00"
                  />
                </label>
                <div className="assignment">
                  {selected?.trackId ? (
                    <p>
                      Assigned:{" "}
                      <strong>
                        {selected.trackTitle ?? selected.trackFileName}
                      </strong>
                    </p>
                  ) : (
                    <p>No walk-up music assigned.</p>
                  )}
                  <button
                    className="quiet"
                    disabled={!operator || !selected?.trackId}
                    onClick={() => void assign(null)}
                  >
                    Clear assignment
                  </button>
                </div>
                {desktop.active() && selected && localAssignments.players[String(selected.playerId)] && (
                  <div className="assignment">
                    <p>Local override: <strong>{localMedia.find(m => m.mediaId === localAssignments.players[String(selected!.playerId)]?.mediaId)?.fileName.split(/[\\/]/).pop() ?? "Unknown file"}</strong></p>
                    <button className="quiet" disabled={!operator} onClick={() => void assignLocalPlayer("")}>Clear override</button>
                  </div>
                )}
                <label>
                  Find a track
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search title, artist, or file"
                  />
                </label>
                <ul className="track-list">
                  {tracks.map((track) => (
                    <li key={track.trackId}>
                      <div>
                        <strong>{track.title ?? track.fileName}</strong>
                        <span>
                          {track.artist ??
                            track.relativePath ??
                            "Unknown artist"}
                        </span>
                        {desktop.active() && (() => {
                          const state = localState(track);
                          return <small className={`cache-state ${state.className}`}>{state.label}</small>;
                        })()}
                      </div>
                      <span className="track-list__actions">
                        {desktop.active() && (
                          (() => {
                            const state = localState(track);
                            const downloading = downloadingTrackId === track.trackId;
                            return <button
                              className="quiet"
                              disabled={!state.downloadable || downloading}
                              onClick={() => {
                                setDownloadingTrackId(track.trackId);
                                void desktop.download({ trackId: track.trackId, fileName: track.fileName, contentHash: track.contentHash! })
                                  .then((entry) => {
                                    setLocalTracks((current) => new Map(current).set(entry.trackId, entry.contentHash));
                                    alert(`${track.title ?? track.fileName} downloaded for local playback.`);
                                  })
                                  .catch((e: Error) => alert(e.message))
                                  .finally(() => setDownloadingTrackId(null));
                              }}
                            >
                              {downloading ? "Downloading…" : state.label === "Outdated local copy" ? "Update download" : state.label === "Local copy ready" ? "Downloaded" : "Download"}
                            </button>;
                          })()
                        )}
                        <button
                          disabled={!operator || !selected || track.missing}
                          onClick={() => void assign(track.trackId)}
                        >
                          Assign
                        </button>
                        <button
                          className="quiet"
                          disabled={!operator}
                          onClick={() => void removeTrack(track)}
                        >
                          Delete
                        </button>
                      </span>
                    </li>
                  ))}
                  {desktop.active() && localMedia
                    .filter(media => media.fileName.toLowerCase().includes(query.toLowerCase()))
                    .map(media => {
                      const currentOverride = selected ? localAssignments.players[String(selected.playerId)] : null;
                      const isActive = currentOverride?.mediaId === media.mediaId;
                      return (
                        <li key={`local-${media.mediaId}`}>
                          <div>
                            <strong>{media.fileName.split(/[\\/]/).pop()}</strong>
                            <span>{media.fileName.includes("/") || media.fileName.includes("\\") ? media.fileName.split(/[\\/]/).slice(0, -1).join("/") : "Local Music Control folder"}</span>
                            <small className={`cache-state ${media.source === "local" ? "cache-state--server-missing" : "cache-state--local"}`}>
                              {media.source === "local" ? "Local only" : "Downloaded"}
                            </small>
                          </div>
                          <span className="track-list__actions">
                            <button
                              disabled={!operator || !selected}
                              onClick={() => void assignLocalPlayer(isActive ? "" : media.mediaId)}
                            >
                              {isActive ? "Remove override" : "Set override"}
                            </button>
                          </span>
                        </li>
                      );
                    })}
                </ul>
              </div>
            </div>
          </section>
        )}
        {setupTab === "situations" && (
          <section className="panel situations-panel" role="tabpanel">
            <h2>Situation music</h2>
            <div className="situations-layout">
              <div className="situations-sidebar">
                <span className="eyebrow">Pick a track</span>
                <input
                  type="search"
                  aria-label="Search tracks"
                  placeholder="Search tracks…"
                  value={situationQuery}
                  onChange={(e) => setSituationQuery(e.target.value)}
                />
                <ul className="situation-track-list">
                  {tracks
                    .filter(t => !t.missing && `${t.title ?? ""} ${t.fileName} ${t.artist ?? ""}`.toLowerCase().includes(situationQuery.toLowerCase()))
                    .map((track) => {
                      const isSelected = selectedSituationTrack?.kind === "vps" && selectedSituationTrack.trackId === track.trackId;
                      return (
                        <li
                          key={`vps-${track.trackId}`}
                          className={isSelected ? "selected" : ""}
                          onClick={() => setSelectedSituationTrack({ kind: "vps", trackId: track.trackId })}
                        >
                          <strong>{track.title ?? track.fileName}</strong>
                          {track.artist && <small>{track.artist}</small>}
                        </li>
                      );
                    })}
                  {desktop.active() && localMedia
                    .filter(m => m.fileName.toLowerCase().includes(situationQuery.toLowerCase()))
                    .map((media) => {
                      const isSelected = selectedSituationTrack?.kind === "local" && selectedSituationTrack.mediaId === media.mediaId;
                      return (
                        <li
                          key={`local-${media.mediaId}`}
                          className={isSelected ? "selected" : ""}
                          onClick={() => setSelectedSituationTrack({ kind: "local", mediaId: media.mediaId })}
                        >
                          <strong>{media.fileName.split(/[\\/]/).pop()}</strong>
                          <small className={media.source === "local" ? "local-badge" : "downloaded-badge"}>
                            {media.source === "local" ? "Local only" : "Downloaded"}
                          </small>
                        </li>
                      );
                    })}
                </ul>
              </div>
              <div className="situations-form-area">
                <form className="cue-form" onSubmit={addSituation}>
                  <label>
                    Name
                    <input
                      value={cueName}
                      onChange={(e) => setCueName(e.target.value)}
                      placeholder="Home run"
                    />
                  </label>
                  <div className="selected-situation-track">
                    {selectedSituationTrack ? (
                      selectedSituationTrack.kind === "vps"
                        ? <><strong>{tracks.find(t => t.trackId === selectedSituationTrack.trackId)?.title ?? tracks.find(t => t.trackId === selectedSituationTrack.trackId)?.fileName ?? "Selected track"}</strong><small>VPS library</small></>
                        : <><strong>{localMedia.find(m => m.mediaId === selectedSituationTrack.mediaId)?.fileName.split(/[\\/]/).pop() ?? "Selected file"}</strong><small>{localMedia.find(m => m.mediaId === selectedSituationTrack.mediaId)?.source === "local" ? "Local only" : "Downloaded"}</small></>
                    ) : <span className="situation-track-hint">← Click a track from the list</span>}
                  </div>
                  <label>
                    Start at
                    <input
                      value={cueStart}
                      onChange={(e) => setCueStart(e.target.value)}
                      placeholder="0:00"
                    />
                  </label>
                  <button disabled={!operator || !selectedSituationTrack}>Add situation</button>
                </form>
                <ul className="cue-list">
                  {cues.map((cue) => (
                    <li key={cue.cueId}>
                      <div>
                        <strong>{cue.name}</strong>
                        <span>
                          {cue.trackTitle ?? cue.trackFileName ?? "No track"} ·{" "}
                          {clock(cue.startSeconds)}
                        </span>
                      </div>
                      <button
                        className="quiet"
                        disabled={!operator}
                        onClick={() =>
                          void api
                            .deleteCue(cue.cueId)
                            .then(load)
                            .then(onRefresh)
                            .catch((e: Error) => alert(e.message))
                        }
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                  {desktop.active() && localAssignments.situations.map((situation) => (
                    <li key={situation.situationId}>
                      <div>
                        <strong>{situation.name}</strong>
                        <span>{localMedia.find((media) => media.mediaId === situation.mediaId)?.fileName.split(/[\\/]/).pop() ?? "File missing"} · Local only</span>
                      </div>
                      <button className="quiet" disabled={!operator} onClick={() => void onLocalAssignments({ ...localAssignments, situations: localAssignments.situations.filter((item) => item.situationId !== situation.situationId) })}>Remove</button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>
        )}
      </div>
    </section>
  );
}

function LocalOnlySetup({ board, operator, alert, onRefresh, onLocalRefresh, onLocalLibrary }: { board: BoardState | null; operator: boolean; alert: (value: string) => void; onRefresh: () => Promise<void>; onLocalRefresh: () => void; onLocalLibrary: (value: LocalLibraryState) => void }) {
  const [library, setLibrary] = useState<LocalLibraryState>({ tracks: [], players: [], cues: [], unmatchedLegacyAssignments: [] });
  const [tab, setTab] = useState<"walkup" | "situations">("walkup");
  const [playerId, setPlayerId] = useState<number | null>(null); const [selectedKey, setSelectedKey] = useState(""); const [start, setStart] = useState("0:00"); const [name, setName] = useState(""); const [query, setQuery] = useState(""); const [folder, setFolder] = useState<string | null>(null);
  const apply = (value: LocalLibraryState) => { setLibrary(value); onLocalLibrary(value); };
  const sync = useCallback(async () => {
    if (!operator) return;
    try {
      const media = await desktop.localMedia();
      const entries = media.map(item => ({ contentKey: item.contentKey, fileName: item.fileName, title: item.title ?? (item.fileName.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? item.fileName), artist: item.artist ?? null, durationSeconds: null, fileSize: item.size }));
      let updated = await api.publishLocalCatalog(entries);
      // One-time compatibility import for the previous per-computer settings.
      // Once copied to shared assignments it is cleared so it cannot become a
      // second, invisible source of truth.
      const legacy = await desktop.localAssignments();
      const unavailableLegacy: string[] = [];
      for (const [playerId, value] of Object.entries(legacy.players)) {
        const track = media.find(item => item.mediaId === value.mediaId || item.contentKey === value.mediaId);
        if (track && !updated.players.some(item => item.playerId === Number(playerId))) await api.assignLocalPlayer(Number(playerId), track.contentKey, value.startSeconds);
        else if (!track) unavailableLegacy.push(`player ${playerId}`);
      }
      for (const cue of legacy.situations) {
        const track = media.find(item => item.mediaId === cue.mediaId || item.contentKey === cue.mediaId);
        if (track && !updated.cues.some(item => item.name === cue.name)) await api.createLocalCue(cue.name, track.contentKey, cue.startSeconds);
        else if (!track) unavailableLegacy.push(`situation ${cue.name}`);
      }
      if (Object.keys(legacy.players).length || legacy.situations.length) await desktop.saveLocalAssignments({ players: {}, situations: [] });
      updated = await api.localLibrary();
      apply(updated); onLocalRefresh();
      if (updated.unmatchedLegacyAssignments.length) alert(`Legacy assignments not found locally: ${updated.unmatchedLegacyAssignments.join(", ")}`);
      if (unavailableLegacy.length) alert(`Old local assignments could not be matched and were cleared: ${unavailableLegacy.join(", ")}`);
    }
    catch (error) { alert(error instanceof Error ? error.message : "Could not publish the local music catalog."); }
  }, [operator, alert, onLocalRefresh]);
  useEffect(() => { void desktop.status().then(status => setFolder(status?.libraryRoot ?? null)); void api.localLibrary().then(apply).catch(() => undefined); }, []);
  useEffect(() => { void sync(); }, [sync]);
  useEffect(() => { if (!playerId && board?.lineup[0]) setPlayerId(board.lineup[0].playerId); }, [board, playerId]);
  const assign = async () => { const seconds=parseClock(start); if (!playerId || !selectedKey || seconds===null) return alert("Choose a player, local track, and valid start time."); try { await api.assignLocalPlayer(playerId,selectedKey,seconds); const updated=await api.localLibrary(); apply(updated); await onRefresh(); } catch(error) { alert(error instanceof Error?error.message:"Could not assign local music."); } };
  const addCue = async () => { const seconds=parseClock(start); if(!name.trim()||!selectedKey||seconds===null)return alert("Choose a name, local track, and valid start time."); try { await api.createLocalCue(name.trim(),selectedKey,seconds); apply(await api.localLibrary()); setName(""); } catch(error){alert(error instanceof Error?error.message:"Could not save situation music.");} };
  const visible = library.tracks.filter(track => track.available && `${track.title ?? ""} ${track.fileName} ${track.artist ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  const chosenPlayer = board?.lineup.find(player => player.playerId === playerId); const assignment = library.players.find(item => item.playerId === playerId); const trackName=(key:string)=>library.tracks.find(track=>track.contentKey===key)?.title ?? "Unavailable local file";
  return (
    <section className="setup local-setup">
      <div className="setup-tabs" role="tablist">
        <button className={tab === "walkup" ? "setup-tab setup-tab--active" : "setup-tab"} onClick={() => setTab("walkup")}>Walk-up Music</button>
        <button className={tab === "situations" ? "setup-tab setup-tab--active" : "setup-tab"} onClick={() => setTab("situations")}>Situation Music</button>
      </div>
      <section className="panel">
        <div className="panel__head">
          <div><h2>Local music library</h2><p className="library-folder-note">{folder ? `Scanning ${folder}` : "Choose a folder on this computer to use as the music library."}</p></div>
          <span className="panel__actions">
            <button className="quiet" onClick={() => void desktop.chooseFolder().then(next => { setFolder(next); void sync(); })}>Choose folder</button>
            <button className="quiet" disabled={!operator} onClick={() => void sync()}>Refresh local files</button>
          </span>
        </div>
        {tab === "walkup" ? (
          <div className="local-setup-grid">
            <div className="local-col">
              <span className="eyebrow">Players</span>
              <ul className="player-picker">
                {(board?.lineup ?? []).map(player => {
                  const playerAssignment = library.players.find(item => item.playerId === player.playerId);
                  return (
                    <li key={player.playerId}>
                      <button
                        className={playerId === player.playerId ? "player-picker__item player-picker__item--active" : "player-picker__item"}
                        onClick={() => setPlayerId(player.playerId)}
                      >
                        <strong>{player.displayName}{player.number ? ` #${player.number}` : ""}</strong>
                        <span>{playerAssignment ? trackName(playerAssignment.contentKey) : "No walk-up music"}</span>
                      </button>
                    </li>
                  );
                })}
                {(board?.lineup ?? []).length === 0 && <li className="empty">No players in the lineup yet.</li>}
              </ul>
            </div>
            <LocalTrackPicker tracks={visible} query={query} onQuery={setQuery} selectedKey={selectedKey} onSelect={setSelectedKey} />
            <div className="local-col local-col--assign">
              <span className="eyebrow">Assign</span>
              <p className="assignment">{chosenPlayer && assignment ? <>Assigned: <strong>{trackName(assignment.contentKey)}</strong></> : chosenPlayer ? <>No walk-up music for <strong>{chosenPlayer.displayName}</strong>.</> : "Select a player to assign walk-up music."}</p>
              <label>Start at<input value={start} onChange={event => setStart(event.target.value)} /></label>
              <button className="primary" disabled={!operator} onClick={() => void assign()}>Save walk-up music</button>
              {assignment && <button className="quiet" disabled={!operator} onClick={() => void api.clearLocalPlayer(assignment.playerId).then(api.localLibrary).then(apply)}>Clear assignment</button>}
            </div>
          </div>
        ) : (
          <div className="local-setup-grid">
            <div className="local-col">
              <span className="eyebrow">Situations</span>
              <ul className="cue-list">
                {library.cues.map(cue => (
                  <li key={cue.cueId}>
                    <div><strong>{cue.name}</strong><span>{trackName(cue.contentKey)} · {clock(cue.startSeconds)}</span></div>
                    <button className="quiet" disabled={!operator} onClick={() => void api.deleteLocalCue(cue.cueId).then(api.localLibrary).then(apply)}>Remove</button>
                  </li>
                ))}
                {library.cues.length === 0 && <li className="empty">No situations yet.</li>}
              </ul>
            </div>
            <LocalTrackPicker tracks={visible} query={query} onQuery={setQuery} selectedKey={selectedKey} onSelect={setSelectedKey} />
            <div className="local-col local-col--assign">
              <span className="eyebrow">Add situation</span>
              <label>Situation name<input value={name} onChange={event => setName(event.target.value)} /></label>
              <label>Start at<input value={start} onChange={event => setStart(event.target.value)} /></label>
              <button className="primary" disabled={!operator} onClick={() => void addCue()}>Add situation</button>
            </div>
          </div>
        )}
        <p className="library-folder-note">After verifying these assignments, <button className="quiet" disabled={!operator || library.tracks.length === 0} onClick={() => { if (confirm("Permanently remove every audio file from the VPS? Local files will be unaffected.")) void api.purgeVpsLibrary().then(result => alert(`Removed ${result.removed} VPS tracks.`)).catch(error => alert(error.message)); }}>remove VPS music</button></p>
      </section>
    </section>
  );
}

function LocalTrackPicker({ tracks, query, onQuery, selectedKey, onSelect }: { tracks: LocalCatalogTrack[]; query: string; onQuery: (value: string) => void; selectedKey: string; onSelect: (value: string) => void }) {
  return <div><label>Find a local track<input type="search" value={query} onChange={event => onQuery(event.target.value)} placeholder="Search local files" /></label><ul className="track-list">{tracks.map(track => <li key={track.contentKey}><div><strong>{track.title ?? track.fileName}</strong><span>{track.artist ?? track.fileName}</span></div><button className={selectedKey === track.contentKey ? "primary quiet" : "quiet"} onClick={() => onSelect(track.contentKey)}>{selectedKey === track.contentKey ? "Selected" : "Select"}</button></li>)}{tracks.length === 0 && <li className="empty">No local audio files found. Choose a music folder, then refresh.</li>}</ul></div>;
}

function Gate({
  setup,
  onClose,
  onSubmit,
}: {
  setup: boolean;
  onClose: () => void;
  onSubmit: (password: string, setup: boolean) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  return (
    <div
      className="gate"
      role="dialog"
      aria-modal="true"
      aria-labelledby="gate-title"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void onSubmit(password, setup);
        }}
      >
        <button
          type="button"
          className="gate__close"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
        <span className="eyebrow">Operator access</span>
        <h2 id="gate-title">
          {setup ? "Set up Music Control" : "Sign in to operate"}
        </h2>
        <p>
          {setup
            ? "Choose the administrator password for this console."
            : "Only the operator console can play audio or change music."}
        </p>
        <label>
          Password
          <input
            type="password"
            autoFocus
            minLength={10}
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <div className="gate__actions">
          <button className="primary">
            {setup ? "Set password" : "Sign in"}
          </button>
          {!setup && (
            <button type="button" className="gate__view-only" onClick={onClose}>
              View only
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
