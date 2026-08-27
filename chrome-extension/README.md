# GitHub Notifications Redirect Chrome extension

Opens GitHub notifications links in one global, pinned GitGlance tab.

## Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `chrome-extension/`

## Behavior

- Rewrites GitHub links pointing at `/notifications`
- Intercepts regular, keyboard, modifier, and middle-click activation
- Creates and pins one GitGlance tab, then focuses and reuses it globally
- Keeps the originating GitHub tab open
- Closes duplicate GitGlance tabs created through native **Open link in new tab**
- Handles dynamically rendered GitHub UI via `MutationObserver`

After updating the unpacked extension, click **Reload** on `chrome://extensions` and refresh existing GitHub tabs.
