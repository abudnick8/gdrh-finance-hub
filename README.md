# GDRH Finance Inbox Hub

A standalone finance dashboard for Glendale-River Hills School District.

## Features

- **Inbox Overview** — daily email digest, email triage with priority labels
- **Tasks** — task queue with status tracking (To Do / In Progress / Done)
- **WUFAR Codes** — automatic WUFAR object & function code recommendations for purchase requisitions
- **Job Schedule** — recurring job pattern tracker

## Deployment

This is a static single-file app (`index.html`). It runs on [Railway](https://railway.app) using the `serve` package.

### Local development

```bash
npm install
npm start
```

Then open [http://localhost:3000](http://localhost:3000)

### Deploy to Railway

1. Connect this GitHub repo in [Railway](https://railway.app/new)
2. Railway auto-detects `package.json` and runs `npm start`
3. Set a custom domain in Railway's settings if desired

## Tech

- Pure HTML/CSS/JS — no framework, no build step
- WUFAR codes sourced from [Wisconsin DPI WUFAR Manual 2025-26](https://dpi.wi.gov/sites/default/files/imce/sfs/pdf/WUFAR_Manual_Revision_25-26.pdf)
