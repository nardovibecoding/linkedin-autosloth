# Contributing

Thanks for your interest in contributing!

## Getting Started

1. Fork the repo
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/LinkedinAutoSloth.git`
3. Load the extension in Chrome (`chrome://extensions/` → Developer Mode → Load unpacked)
4. Make your changes and test on LinkedIn

## Guidelines

- Keep PRs focused — one feature or fix per PR
- Test on LinkedIn before submitting (DOM selectors break frequently)
- Run the DOM Health Check to verify your changes don't break existing selectors
- No external dependencies — this is vanilla JS only

## Reporting Issues

When LinkedIn updates their frontend, selectors break. If you notice the extension stopped working:

1. Run the DOM Health Check (click refresh in popup)
2. Open DevTools on LinkedIn and inspect the broken element
3. File an issue with the old and new selector

## Code Style

- Vanilla JS, no frameworks
- Chrome Manifest V3
- Use `chrome.storage` for state, not localStorage
