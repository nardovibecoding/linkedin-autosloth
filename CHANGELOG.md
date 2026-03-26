# Changelog

## [1.1.0] - 2026-03-12

### Added
- DOM Health Check — audits LinkedIn selectors on load, surfaces health score in popup
- Auto DM Reply — scans inbox, replies to unread and dormant (7+ days) threads
- Template variables: `{{firstName}}`, `{{lastName}}`, `{{company}}`, `{{title}}`
- Safety controls: daily send limit + randomised delay between actions
- Three-tier button detection fallback (aria-label → SVG icon → text match)

### Changed
- Upgraded to Manifest V3

## [1.0.0] - 2026-03-01

### Added
- Initial release
- Auto-connect with keyword search
- Custom keyword input
- Connection request with personalised note
