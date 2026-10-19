interface Window {
  musicControl: {
    status(): Promise<{ serverUrl: string; libraryRoot?: string; approved: boolean; cache: CachedTrack[] }>;
    chooseFolder(): Promise<string | null>;
    enroll(password: string, label: string, serverUrl: string): Promise<boolean>;
    request<T>(endpoint: string, init?: RequestInit): Promise<T>;
    download(track: { trackId: number; fileName: string; contentHash: string }): Promise<{ path: string; hash: string }>;
    rescan(): Promise<CachedTrack[]>;
  };
}
type CachedTrack = { trackId: number; hash: string; fileName: string; path: string; size: number };
