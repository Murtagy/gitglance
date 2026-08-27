const TARGET_URL = "https://murtagy.github.io/gitglance/#/?show=unread&selected=";
const GITHUB_NOTIFICATIONS_PATH = "/notifications";
const OPEN_MESSAGE = "open-gitglance";

function isNotificationsUrl(value) {
  if (!value) return false;

  try {
    const url = new URL(value, window.location.origin);
    return (
      url.origin === "https://github.com" &&
      (url.pathname === GITHUB_NOTIFICATIONS_PATH ||
        url.pathname.startsWith(`${GITHUB_NOTIFICATIONS_PATH}/`))
    );
  } catch {
    return false;
  }
}

function rewriteAnchor(anchor) {
  if (!(anchor instanceof HTMLAnchorElement)) return;
  if (!isNotificationsUrl(anchor.getAttribute("href"))) return;

  anchor.href = TARGET_URL;
  anchor.dataset.gitglanceRedirect = "true";
}

function rewriteAllAnchors(root = document) {
  const anchors = root.querySelectorAll?.('a[href]');
  if (!anchors) return;
  anchors.forEach(rewriteAnchor);
}

function isRedirectAnchor(anchor) {
  return (
    anchor instanceof HTMLAnchorElement &&
    (anchor.dataset.gitglanceRedirect === "true" ||
      isNotificationsUrl(anchor.getAttribute("href")))
  );
}

function requestGitGlanceTab() {
  try {
    chrome.runtime.sendMessage({ type: OPEN_MESSAGE }, (response) => {
      const error = chrome.runtime.lastError;
      if (error || !response?.ok) window.location.assign(TARGET_URL);
    });
  } catch {
    window.location.assign(TARGET_URL);
  }
}

function handleNotificationClick(event) {
  if (event.type === "auxclick" && event.button !== 1) return;

  const anchor = event.target instanceof Element
    ? event.target.closest("a[href]")
    : null;

  if (!isRedirectAnchor(anchor)) return;

  rewriteAnchor(anchor);
  event.preventDefault();
  event.stopImmediatePropagation();
  requestGitGlanceTab();
}

document.addEventListener("click", handleNotificationClick, true);
document.addEventListener("auxclick", handleNotificationClick, true);

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => rewriteAllAnchors());
} else {
  rewriteAllAnchors();
}

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (!(node instanceof Element)) continue;
      if (node.matches?.('a[href]')) rewriteAnchor(node);
      rewriteAllAnchors(node);
    }
  }
});

observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
});
