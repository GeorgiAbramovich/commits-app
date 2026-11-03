# Contributing

Thanks for helping. Commits is deliberately small, and that is the feature. Before you open a pull request:

- **No frameworks, bundlers or runtime dependencies.** Plain HTML, CSS and JavaScript that runs as-is.
- **No backend and no third-party requests.** The app only talks to `api.github.com` (plus avatar images).
  No analytics, fonts or CDNs.
- **Escape everything from GitHub.** Any API text that goes into `innerHTML` must go through `esc()`.
- **Reading first.** The only writes are opening and merging a pull request, always behind a tap you meant to make.
- **Keep changes focused.** One fix or feature per pull request. For anything bigger, open an issue first.

## Checking your change

```sh
python -m http.server 8080       # open http://localhost:8080
node --check app.js && node --check sw.js
```

Test on a phone-sized viewport in both light and dark mode. If you change any file the service worker caches,
bump `CACHE` in `sw.js`. If the UI changes visibly, update the images in `docs/screenshots/` (824×1830, a 412×915 viewport at 2x).

## Reporting bugs

Open an issue with your device, browser and what you expected. Never paste your token.
