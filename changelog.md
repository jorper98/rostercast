# Changelog

## v2.0.0 
- Released under the GNU Affero General Public License v3 (AGPL v3).
- Bumped application version to v2.0.0 across all project files.
- Renamed application from "Member Management" to "RosterCast".
- Changed default local port to 3032.
- Removed unused `SESSION_SECRET` environment variable and related code.
- Updated README.md, docs.md, and public/About.md with AGPL v3 license and current version.
- Cleaned README.md and docs.md to remove local development paths.
- Added required footer and version header to frontend pages.
- Added `scripts/generate-sample-data.js` for creating sample member data.
- Sanitized `data/` directory for public repository publication.
- Verified `.gitignore` covers sensitive files and runtime directories.

## v1.3.3 
- Created public read-only deployment copy in `membershipManagement\public`.
- Sanitized public member data by excluding email addresses, phone numbers, exact street addresses, email logs, backups, and private credentials.
- Enabled public read-only mode by omitting `userPassword`.
- Disabled email sending in the public configuration.
- Added environment variable support for `ADMIN_PASSWORD` and `USER_PASSWORD`.
- Added public deployment documentation, `.env.sample`, `.gitignore`, and `public/About.md`.

## v1.2.8
- Previous version
