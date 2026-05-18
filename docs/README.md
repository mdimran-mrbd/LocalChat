# LocalChat product website

This folder contains the static product website for **LocalChat**.

It is a single-page site built with plain HTML, CSS, and a small amount of
vanilla JavaScript — no build step, no frameworks, no tracking.

## Local preview

```bash
cd docs
python3 -m http.server 8080
# then open http://localhost:8080
```

## Publishing on GitHub Pages

In the repository **Settings → Pages**, set:

- **Source:** *Deploy from a branch*
- **Branch:** `main` (or your default branch) / **folder:** `/docs`

GitHub will serve the site at `https://<owner>.github.io/<repo>/`.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page markup and content |
| `styles.css` | All styling, light/dark themes, responsive layout |
| `script.js`  | Theme toggle, mobile nav, scroll reveal |
| `assets/`    | Screenshots and favicon |
