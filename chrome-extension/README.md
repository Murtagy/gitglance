# GitHub Notifications Redirect Chrome extension

Redirects GitHub notifications links from `https://github.com/notifications` to `https://murtagy.github.io/gitglance/`.

## Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `chrome-extension/`

## Behavior

- Rewrites GitHub links pointing at `/notifications`
- Intercepts clicks before GitHub handles them
- Handles dynamically rendered GitHub UI via `MutationObserver`
