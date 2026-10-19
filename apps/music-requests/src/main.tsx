import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, RequestMessage, RequestsRealtime, RequestTrack } from "@music-control-v2/core";
import "./styles.css";

const nameKey = "music-control.requester-name";
const time = (value: string) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));

function App() {
  const [name, setName] = useState(() => localStorage.getItem(nameKey) ?? "");
  const [draftName, setDraftName] = useState(name);
  const [messages, setMessages] = useState<RequestMessage[]>([]);
  const [tracks, setTracks] = useState<RequestTrack[]>([]);
  const [query, setQuery] = useState("");
  const [body, setBody] = useState("");
  const [selected, setSelected] = useState<RequestTrack | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [live, setLive] = useState("Connecting");
  const displayedTracks = useMemo(() => tracks.filter(track => `${track.title} ${track.artist ?? ""}`.toLowerCase().includes(query.toLowerCase())), [tracks, query]);
  const chatRef = useRef<HTMLOListElement>(null);
  const add = (message: RequestMessage) => setMessages(current => current.some(item => item.messageId === message.messageId) ? current : [...current, message]);
  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages]);
  useEffect(() => {
    void Promise.all([api.requestMessages(), api.requestTracks("")]).then(([chat, catalog]) => { setMessages(chat); setTracks(catalog); }).catch(error => setNotice(error.message));
    const realtime = new RequestsRealtime(add, state => setLive(state === "online" ? "Live" : state), () => setMessages([]));
    void realtime.start().catch(() => setLive("Offline"));
    return () => realtime.stop();
  }, []);
  const saveName = (event: FormEvent) => { event.preventDefault(); const next = draftName.trim(); if (!next) return; localStorage.setItem(nameKey, next); setName(next); };
  const send = async (event: FormEvent) => { event.preventDefault(); try { const created = await api.createRequestMessage(name, body, selected?.trackId ?? null); add(created); setBody(""); setSelected(null); } catch (error) { setNotice(error instanceof Error ? error.message : "Could not send request."); } };
  if (!name) return <main className="welcome"><section><span className="eyebrow">Music Control</span><h1>Request a song</h1><p>Send a note to the music operator or attach a track from the local library. Requests never start music automatically.</p><form onSubmit={saveName}><label>Your display name<input autoFocus maxLength={48} value={draftName} onChange={event => setDraftName(event.target.value)} /></label><button>Join requests</button></form></section></main>;
  return <main className="app"><header><div><span className="eyebrow">Music Control</span><h1>Team music requests</h1><p>Messages are shared with the music operator today.</p></div><span className="live">{live}</span></header>{notice && <div className="notice">{notice}<button onClick={() => setNotice(null)}>×</button></div>}<div className="layout"><section className="chat"><div className="chat__head"><h2>Conversation</h2><button className="name" onClick={() => setName("")}>Signed in as {name}</button></div><ol ref={chatRef}>{messages.map(message => <li className={message.senderRole} key={message.messageId}><div><strong>{message.senderName}</strong><time>{time(message.createdAt)}</time></div><p>{message.body}</p>{message.track && <span className="track">♫ {message.track.title}{message.track.artist ? ` — ${message.track.artist}` : ""}</span>}</li>)}</ol><form className="composer" onSubmit={send}>{selected && <div className="selected">Requesting: <strong>{selected.title}</strong><button type="button" onClick={() => setSelected(null)}>Remove</button></div>}<textarea required maxLength={600} placeholder="Ask for a song or message the operator…" value={body} onChange={event => setBody(event.target.value)} /><button>Send request</button></form></section><aside className="library"><h2>Available tracks</h2><input aria-label="Search tracks" placeholder="Search local music" value={query} onChange={event => setQuery(event.target.value)} /><ul>{displayedTracks.map(track => <li key={track.trackId}><div><strong>{track.title}</strong>{track.artist && <small>{track.artist}</small>}</div><button className={selected?.trackId === track.trackId ? "picked" : ""} onClick={() => setSelected(track)}>{selected?.trackId === track.trackId ? "Attached" : "Request"}</button></li>)}</ul></aside></div></main>;
}
createRoot(document.getElementById("root")!).render(<App />);
