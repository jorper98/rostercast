# RosterCast 

## Version: v2.0.2


## Description

# RosterCast


RosterCast is a lightweight people roster and communication platform—not a CRM—built for organizations that need to organize contacts and send targeted communications without unnecessary complexity.

RosterCast is an open-source contact and communication manager designed for coordinators, community leaders, nonprofits, clubs, and organizations that need a simple way to organize people and stay connected.


With RosterCast, you can:

- Manage a searchable people roster
- Organize contacts with custom tags and interests
- Create targeted email broadcasts and newsletters
- Group people by interests, roles, or activities
- Import and export contact information
- Visualize communities with interactive maps
- Keep communications and contact management in one place

RosterCast focuses on simplicity: organize people, reach the right audience, and communicate without the complexity of a traditional CRM.


## Application  Website
to Review Applicaiton Information go to  
https://35sites.com/rostercast 

## Usage Local Dev 

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

## Public  Behavior (Read-Only)

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

- Keep in mind End User Privacy.  Use the USER_PASSWORD to Enable basic site protection
- Replace the placeholder admin password before deploying.
- The `ADMIN_PASSWORD` environment variable overrides `data/config.json` for admin maintenance access.   
- The `USER_PASSWORD` environment variable overrides `data/config.json` for basic site protection.



## License

This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.

Copyright (c) 2026 Jorge Pereira (35sites.com LLC)

## DISCLAIMER:  USE OF AI 

This application was developed with the help of AI and AI Coding Agents 
