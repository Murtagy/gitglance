const TARGET_URL = "https://murtagy.github.io/gitglance/";
const GITHUB_NOTIFICATIONS_PATH = "/notifications";

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

document.addEventListener(
  "click",
  (event) => {
    const anchor = event.target instanceof Element
      ? event.target.closest("a[href]")
      : null;

    if (!anchor || !isNotificationsUrl(anchor.getAttribute("href"))) return;

    anchor.href = TARGET_URL;
    event.preventDefault();
    window.location.assign(TARGET_URL);
  },
  true
);

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
