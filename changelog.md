# Changelog

## v2.0.2
- Added `scripts/package-for-deploy.ps1` for orchestrating releases via git tags.
- Added GitHub Actions workflow (`.github/workflows/docker-publish.yml`) to build and publish Docker image to GHCR on `v*` tag push.
- Bumped version to v2.0.2 across `package.json`, `README.md`, `docs.md`, and `public/About.md`.

## v2.0.1
- Improved welcome email template with professional HTML design (gradient header, CTA button, responsive layout).
- Added "Group Updates and News" email template with categorized news cards layout.
- Added "Event Announcement" email template with date/time/location info blocks and RSVP button.
- Updated `sendEmail()` to properly handle HTML template bodies without corrupting inline styles.
- All new templates are responsive, email-client compatible, and include the standard footer.
- Added "Email History" button to member detail view to see all emails sent to a member.
- Added server endpoint `/api/email-logs/member/:memberId` for per-member email history.
- Replaced plain text tags input with autocomplete (search/choose existing tags or create new ones).
- Removed Full/Part Time and TWG Subgroups fields from member form, table, settings, and config migration.
- Reorganized Settings page into tabs: General, Authentication, Email Configuration, Error Log, Landing Page.
- Fixed modal close (×) button positioning to top-right corner across all modals.
- Made modal buttons smaller and modals wider for better layout.
- Fixed white-on-white button text in email templates (Get Started, RSVP Now buttons now black).
- Fixed email history search bar misalignment (search icon and dropdown now properly aligned).
- Updated email template signature to "Your Friendly Group Leader" with generic website link.
- Updated email templates with richer sample content (5 news items, event agenda, cost/dress code fields).

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
