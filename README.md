# RosterCast Public Directory

## Description

A Node.js/Express member directory application designed for public read-only access. Visitors can browse approved member listings and an interactive map; administrators can authenticate for maintenance tasks. This public version excludes private contact details, email logs, backups, and production credentials.

Version: v2.0.0

## Usage

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the application:
   ```bash
   npm start
   ```

3. Open your browser to:
   ```
   http://localhost:3032
   ```

## Examples

Run locally with the default port:

```bash
npm install
npm start
```

Run locally with a custom port:

```bash
# Linux/macOS
PORT=8080 npm start

# PowerShell
$env:PORT=8080
npm start
```

Enable admin maintenance access via environment variable:

```bash
# Linux/macOS
ADMIN_PASSWORD="change-this-before-deploying" npm start

# PowerShell
$env:ADMIN_PASSWORD="change-this-before-deploying"
npm start
```

Generate sample member data:

```bash
npm run sample-data
```

Run with Docker Compose:

```bash
docker-compose -f docker-compose-production.yml up -d --build
```

## Public Read-Only Behavior

- Public visitors can view approved member directory entries.
- Public visitors can use the member map.
- Public visitors cannot add, edit, delete, email, back up, restore, or change settings.
- The `USER_PASSWORD` value is intentionally omitted so public read-only mode is enabled.
- The `ADMIN_PASSWORD` environment variable overrides `data/config.json` for admin maintenance access.

## Dependencies and Requirements

- Node.js 18.x or higher
- npm 9.x or higher
- Dependencies are listed in `package.json`

## Included Files

- `server.js`
- `package.json`
- `package-lock.json`
- `Dockerfile`
- `docker-compose-production.yml`
- `public/`
- `data/` (sample data only)

## Security Notes

- Do not commit `.env` files.
- Replace the placeholder admin password before deploying.
- Do not restore private backups or private email logs into this public version.
- Review the sanitized member data before publishing.

## License

This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.

Copyright (c) 2026 Jorge Pereira (35sites.com LLC)

## DISCLAIMER:  USE OF AI 

This application was developed with the help of AI and AI Coding Agents 
