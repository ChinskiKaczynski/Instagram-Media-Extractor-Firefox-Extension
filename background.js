browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case "openPhotoInNewTab":
      browser.tabs.create({ url: message.photoUrl });
      break;
    case "openVideoInNewTab":
      browser.tabs.create({ url: message.videoUrl });
      break;
    default:
      console.error("Unknown action:", message.action);
  }
});
