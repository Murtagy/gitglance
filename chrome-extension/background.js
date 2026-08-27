const TARGET_URL = "https://murtagy.github.io/gitglance/#/?show=unread&selected=";
const TARGET_PATTERN = "https://murtagy.github.io/gitglance/*";
const OPEN_MESSAGE = "open-gitglance";

let workQueue = Promise.resolve();

function enqueue(work) {
  const result = workQueue.then(work, work);
  workQueue = result.catch((error) => {
    console.error("GitGlance tab operation failed", error);
  });
  return result;
}

function isTargetUrl(value) {
  if (!value) return false;

  try {
    const url = new URL(value);
    return (
      url.origin === "https://murtagy.github.io" &&
      (url.pathname === "/gitglance" || url.pathname.startsWith("/gitglance/"))
    );
  } catch {
    return false;
  }
}

async function getTargetTabs() {
  return chrome.tabs.query({ url: TARGET_PATTERN });
}

function chooseCanonicalTab(tabs) {
  return [...tabs].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    return (left.id ?? Number.MAX_SAFE_INTEGER) - (right.id ?? Number.MAX_SAFE_INTEGER);
  })[0];
}

async function focusTab(tab) {
  if (tab.id === undefined || tab.windowId === undefined) return;
  await chrome.tabs.update(tab.id, { active: true, pinned: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

async function consolidateTargetTabs(triggeringTabId) {
  const tabs = await getTargetTabs();
  if (tabs.length === 0) return undefined;

  const canonical = chooseCanonicalTab(tabs);
  if (canonical.id === undefined) return undefined;

  if (!canonical.pinned) {
    await chrome.tabs.update(canonical.id, { pinned: true });
  }

  const duplicateIds = tabs
    .filter((tab) => tab.id !== undefined && tab.id !== canonical.id)
    .map((tab) => tab.id);

  if (duplicateIds.length > 0) {
    await chrome.tabs.remove(duplicateIds);

    if (triggeringTabId !== undefined && triggeringTabId !== canonical.id) {
      await focusTab(canonical);
    }
  }

  return canonical;
}

async function openGitGlance(sourceTab) {
  const existing = await consolidateTargetTabs();

  if (existing?.id !== undefined) {
    const update = { active: true, pinned: true };
    if (existing.url !== TARGET_URL) update.url = TARGET_URL;

    const target = await chrome.tabs.update(existing.id, update);
    await chrome.windows.update(target.windowId, { focused: true });
    return;
  }

  const createProperties = {
    url: TARGET_URL,
    active: true,
    pinned: true,
  };

  if (sourceTab?.windowId !== undefined) {
    createProperties.windowId = sourceTab.windowId;
  }

  const target = await chrome.tabs.create(createProperties);
  await chrome.windows.update(target.windowId, { focused: true });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== OPEN_MESSAGE) return false;

  enqueue(() => openGitGlance(sender.tab)).then(
    () => sendResponse({ ok: true }),
    (error) => sendResponse({ ok: false, error: String(error) })
  );

  return true;
});

chrome.tabs.onCreated.addListener((tab) => {
  const url = tab.pendingUrl || tab.url;
  if (!isTargetUrl(url)) return;
  void enqueue(() => consolidateTargetTabs(tab.id));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!isTargetUrl(changeInfo.url)) return;
  void enqueue(() => consolidateTargetTabs(tabId));
});

chrome.runtime.onInstalled.addListener(() => {
  void enqueue(() => consolidateTargetTabs());
});

chrome.runtime.onStartup.addListener(() => {
  void enqueue(() => consolidateTargetTabs());
});
