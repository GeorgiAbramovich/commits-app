# Commits

A small, read-only GitHub commit browser for your phone. Pick an org, pick a repo, and see what landed today.
No backend, no build step, no tracking: just static files that talk to `api.github.com` with your token.

<p>
  <img src="docs/screenshots/home-light.png" width="240" alt="Repositories in an organization, sorted by latest push, with two pinned at the top">
  <img src="docs/screenshots/repo-light.png" width="240" alt="Commits on the main branch, grouped by day">
  <img src="docs/screenshots/commit-dark.png" width="240" alt="A commit's message, author and colored diff, in the dark theme">
</p>

## What it does

- Switch between your organizations and your own account
- Repositories sorted by most recent push, with search and pinning
- Commits grouped by day, with a branch picker and "load older"
- Commit details with expandable, colored diffs
- Installable on Android: pull to refresh, system back gesture, light and dark theme, opens offline

## Install on Android

1. Open the app's URL in Chrome (for example `https://<you>.github.io/<repo>/`).
2. Tap **Install** in the top bar, or use Chrome's menu and choose **Add to home screen**, then **Install**.
3. Open **Commits** from your home screen and paste a token (see [Token](#token)).

On iPhone, open the URL in Safari, tap **Share**, then **Add to Home Screen**.

## Token

Commits needs a GitHub personal access token (classic) with these scopes:

| Scope      | Why                                          |
| ---------- | -------------------------------------------- |
| `repo`     | Read private repositories and their commits  |
| `read:org` | List the organizations you belong to         |

[Create a token with these scopes](https://github.com/settings/tokens/new?scopes=repo,read:org&description=Commits%20app).

If an organization uses SAML single sign-on, its repos won't appear until you authorize the token:
on the [tokens page](https://github.com/settings/tokens), choose **Configure SSO** next to the token, then **Authorize** for that org.

## Privacy

- Your token is stored in your browser's `localStorage` on your device. It is never sent anywhere except `api.github.com`.
- The app makes no other requests besides loading avatar images from `avatars.githubusercontent.com`.
- No analytics, no cookies, no server. The service worker caches only the app's own files, never API responses.
- **Settings → Sign out** deletes the token from the device. You can also revoke it on GitHub at any time.

## Self-host or fork

The app is plain static files, so any static host works. With GitHub Pages:

1. Fork this repo (or push a copy to your account).
2. In your repo, open **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Push to `main`. The workflow in [`.github/workflows/pages.yml`](.github/workflows/pages.yml) publishes the repo root.
4. Your app is at `https://<you>.github.io/<repo>/`.

Pages on a private repo needs a paid GitHub plan. The repo only contains app code, never your token.

## Local development

There is nothing to install. Serve the folder and open it:

```sh
python -m http.server 8080
# then open http://localhost:8080
```

The service worker only registers over HTTPS, so local changes show up on reload without cache surprises.
When you change any cached file for a release, bump `CACHE` in [`sw.js`](sw.js) so installed apps pick it up.

| File                   | What it is                                           |
| ---------------------- | ---------------------------------------------------- |
| `index.html`           | App shell and top bar                                |
| `app.js`               | Routing, GitHub API calls and all views              |
| `style.css`            | Theme tokens (light and dark) and components         |
| `sw.js`                | Offline cache for the app shell                      |
| `manifest.webmanifest` | Install metadata: icons, screenshots, colors         |

## Contributing

Bug reports and small, focused pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first;
the short version is: keep it simple, keep it dependency-free.

## License

[MIT](LICENSE)
