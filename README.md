# Music Control v2

React/TypeScript successor clients for the existing Music Control server. This project does not
alter the server, database, or the current production clients.

## Development

```bash
npm install
npm run dev:console
npm run dev:lineup
npm run build
```

The apps use absolute `/api` and `/hubs` paths. For authenticated integration testing, serve the
builds under `/v2/` on the existing music-control and lineup hosts using `ops/nginx-v2-preview.conf`.

Build outputs are `apps/console/dist` and `apps/lineup-board/dist`. Copy each output to the matching
directory below `/var/www/music-control-v2/`; this is intentionally separate from the current app.

## Team requests

`apps/music-requests` is the public, live request chat. Build it with `npm run build --workspace=@music-control-v2/music-requests`, deploy its `dist/` output to `/var/www/music-control-v2/music-requests`, and install `../music-control/src/ops/nginx/requests.taylortoast.tech.conf`. The hostname proxies only `/api/requests/` and `/hubs/requests`; create its DNS record and TLS certificate before enabling the configuration.

## Public uploader

`apps/library-upload` builds the public `library-upload` site. It sends only `POST /api/library/uploads`,
never lists or plays the library. Deploy its `dist/` output to `/var/www/library-upload` and install the
matching server configuration in `../music-control/src/ops/nginx/library-upload.taylortoast.tech.conf`.

## Windows desktop console

`apps/desktop` is the local-first Electron console. It plays verified downloads from the
selected folder's `Music Control` subfolder and uses the VPS only for live state, deliberate
downloads, and an explicit streaming fallback. Build the installer with:

```bash
npm install
npm run package:win --workspace=apps/desktop
```

Deploy the matching Music Control server migration before enrolling a desktop. The first
launch asks for the VPS address and administrator password once, then stores its revocable
device credential in Windows Credential Manager.
