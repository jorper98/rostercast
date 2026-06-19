# RosterCast Public Deployment Docs

## Overview

This is a sanitized Node.js/Express application configured for public read-only member viewing.

## Local Run

```bash
npm install
npm start
```

If you need Sampple Data ise: 
npm run sample-data

Open `http://localhost:3032`.

## Public Configuration

`data/config.json` contains public-safe settings. Email is disabled and `userPassword` is omitted so public read-only mode is enabled.

For admin maintenance access, set:

```bash
# Linux/macOS
ADMIN_PASSWORD="change-this-before-deploying" npm start

# PowerShell
$env:ADMIN_PASSWORD="change-this-before-deploying"
npm start
```

`ADMIN_PASSWORD` overrides `data/config.json`.

## Do Not Publish

Do not copy these private items into the public folder:

- `.env`
- `.env.production`
- `node_modules/`
- `data/backups/`
- `data/uploads/`
- `data/jobs/`
- `data/email-logs.json`
- Private member email or phone fields

## Docker

```bash
docker-compose -f docker-compose-production.yml up -d --build
```

## License

This program is licensed under the GNU Affero General Public License v3 (AGPL v3). See the project LICENSE file or <https://www.gnu.org/licenses/> for details.

Copyright (c) 2026 Jorge Pereira (35sites.com LLC)

## Version

v2.0.0
