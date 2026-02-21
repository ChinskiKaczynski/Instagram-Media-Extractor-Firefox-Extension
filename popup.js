document.addEventListener("DOMContentLoaded", () => {
  const extractButton = document.getElementById("extractMedia");
  if (!extractButton) {
    return;
  }

  function sendToActiveInstagramTab(action) {
    browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || typeof tab.id !== "number") {
        return;
      }
      browser.tabs.sendMessage(tab.id, { action }).catch(() => {
        // Ignore when the active tab has no matching content script.
      });
    });
  }

  sendToActiveInstagramTab("prefetchMedia");

  extractButton.addEventListener("mouseenter", () => {
    sendToActiveInstagramTab("prefetchMedia");
  });
  extractButton.addEventListener("focus", () => {
    sendToActiveInstagramTab("prefetchMedia");
  });
  extractButton.addEventListener("click", () => {
    sendToActiveInstagramTab("extractMedia");
  });
});
