<div align="center">
  <h1>🦥 LinkedIn Auto Sloth</h1>
  <p><strong>Chrome extension that automates LinkedIn connection requests and DM follow-ups.</strong></p>
  <p>Built for Web3 BD — works for any high-volume outreach workflow.</p>

  ![Chrome](https://img.shields.io/badge/Chrome-Manifest_V3-4285F4?logo=googlechrome&logoColor=white)
  ![JavaScript](https://img.shields.io/badge/Vanilla_JS-F7DF1E?logo=javascript&logoColor=black)
  ![License](https://img.shields.io/badge/license-MIT-green)
  ![Status](https://img.shields.io/badge/status-proof_of_concept-orange)
</div>

> **Disclaimer:** For educational purposes only. Automated actions on LinkedIn violate their Terms of Service. Account restrictions are a real risk. Use at your own discretion.

---

## Features

| Feature | Details |
|---------|---------|
| **Auto-Connect** | Navigate to LinkedIn people search for any keyword, auto-send connection requests with personalised notes |
| **Auto DM Reply** | Scan inbox sidebar — reply to unread messages and dormant threads (≥7 days), skip recent ones |
| **DOM Health Check** | On-load audit of LinkedIn's current DOM selectors — surfaces a health score so you know when selectors break |
| **Template Variables** | `{{firstName}}`, `{{lastName}}`, `{{company}}`, `{{title}}` — auto-populated from profile data |
| **Safety Controls** | Configurable daily send limit + randomised min/max delay between actions |

### How Auto-Connect finds the button

LinkedIn obfuscates their DOM frequently. The extension uses three fallback strategies:

1. `aria-label*="Connect"` / `aria-label*="Invite"` — most stable
2. SVG icon `connect-small` — catches redesigned buttons
3. Text content match `"Connect"` — last resort

### How Auto DM decides who to reply

| Condition | Action |
|-----------|--------|
| Blue dot (unread) present | Reply |
| No blue dot, last message ≥ 7 days | Reply |
| No blue dot, last message < 7 days | Skip |

All decisions made from the sidebar. Opens the conversation only to type and send.

---

## Getting Started

### Install

1. Clone this repo:
   ```bash
   git clone https://github.com/nardovibecoding/LinkedinAutoSloth.git
   ```
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer Mode** (top right toggle)
4. Click **Load unpacked** → select the repo folder
5. Navigate to LinkedIn — the extension icon appears in your toolbar

### Configure

Open the extension popup to set:
- **Keywords** — search terms for auto-connect (edit `popup/popup.html` for permanent buttons, or use the custom input)
- **Message templates** — personalise with `{{firstName}}`, `{{company}}`, etc.
- **Daily limit** — max connection requests per day
- **Delay range** — randomised wait between actions (min/max seconds)

---

## Project Structure

```
LinkedinAutoSloth/
├── manifest.json           # Chrome MV3 manifest — permissions, content scripts
├── background/
│   └── background.js       # Service worker — message routing, state management
├── content/
│   ├── content.js          # Core automation logic (1690 lines) — connect + DM engine
│   └── content.css         # Injected styles for status overlays
├── popup/
│   ├── popup.html          # Extension popup UI — controls, keyword buttons
│   ├── popup.js            # Popup logic — settings, health check display
│   └── popup.css           # Popup styles
└── icons/                  # Extension icons (16/48/128px)
```

---

## How It Works

```
Popup UI (popup.js)
    │
    ├── Start Connect → sends message to content script
    │                        │
    │                        ▼
    │                   content.js
    │                   ├── Navigate to LinkedIn search
    │                   ├── Find "Connect" buttons (3 fallbacks)
    │                   ├── Click → fill note with template vars
    │                   ├── Send → wait (random delay)
    │                   └── Repeat until daily limit
    │
    └── Start DM Reply → sends message to content script
                             │
                             ▼
                        content.js
                        ├── Scan inbox sidebar
                        ├── Check unread / timestamp rules
                        ├── Open qualifying convos
                        ├── Type + send reply
                        └── Move to next conversation
```

---

## Notes

- **DOM stability** — LinkedIn changes their frontend frequently. When things break, check the DOM Health score first. The `detectEnvironment()` method audits all critical selectors.
- **Scope** — This is a proof of concept, not a maintained product. Built as a vibe-coding exercise.
- **Alternative** — For more resilient automation, consider Playwright-based approaches that don't depend on content script injection.

---

## License

MIT — see [LICENSE](LICENSE)
