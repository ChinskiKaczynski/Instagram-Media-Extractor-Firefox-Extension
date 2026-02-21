(function() {
  "use strict";

  const API_HEADERS = {
    "x-ig-app-id": "936619743392459"
  };
  const DOM_RETRY_COUNT = 6;
  const DOM_RETRY_DELAY_MS = 500;
  const PERFORMANCE_VIDEO_MAX_AGE_STORY_MS = 15000;
  const PERFORMANCE_VIDEO_MAX_AGE_POST_MS = 8000;
  const MEDIA_PREFETCH_TTL_MS = 3500;
  const API_PREFETCH_TTL_MS = 10000;
  const FLOATING_BUTTON_ID = "ig-media-extractor-floating-button";
  const FLOATING_BUTTON_STORAGE_KEY = "ig-media-extractor-floating-button-position-v1";
  const FLOATING_BUTTON_SIZE_PX = 64;
  const FLOATING_BUTTON_MARGIN_PX = 14;
  let mediaPrefetchCache = null;
  let apiPrefetchCache = null;
  let apiPrefetchInFlight = null;
  let floatingButtonInitialized = false;

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function fetchMediaInfo(url) {
    try {
      const response = await fetch(url, {
        headers: API_HEADERS,
        credentials: "include"
      });
      const contentType = response.headers.get("content-type") || "";

      if (!response.ok || !contentType.includes("application/json")) {
        console.warn("Unexpected API response:", response.status, response.url);
        return null;
      }

      return await response.json();
    } catch (error) {
      console.error("Request failed:", error);
      return null;
    }
  }

  async function extractMedia() {
    const inStories = window.location.pathname.includes("/stories/");
    const contextKey = getCurrentMediaContextKey();
    const storyIdHint = inStories ? getStoryIdFromHref() : null;
    const canonicalPath = getCanonicalPathname();
    const canonicalLooksVideo = /\/(reel|reels|tv)\//i.test(canonicalPath);
    let mediaSource = "none";
    let mediaInfo = null;
    let domMediaQuick = normalizeMediaInfo(extractMediaViaDomOnce());
    if (domMediaQuick?.url) {
      storeMediaPrefetch(domMediaQuick, contextKey);
    } else {
      domMediaQuick = getFreshMediaPrefetch(contextKey);
    }

    const cachedApiMedia = getFreshApiPrefetch(contextKey);
    const apiPromise = cachedApiMedia ? Promise.resolve(cachedApiMedia) : prefetchApiForCurrentContext(contextKey, storyIdHint);

    const apiMedia = normalizeMediaInfo(await apiPromise);

    // For stories, API is the source of truth. DOM can contain transient video elements
    // that do not belong to the currently visible story frame.
    if (inStories) {
      if (apiMedia?.url) {
        mediaInfo = apiMedia;
        mediaSource = "api-story";
      } else if (domMediaQuick?.url) {
        mediaInfo = domMediaQuick;
        mediaSource = domMediaQuick.url.startsWith("blob:") ? "dom-fast-story-blob" : "dom-fast-story";
      } else {
        const mediaFromDom = normalizeMediaInfo(await extractMediaViaDom());
        if (mediaFromDom?.url) {
          mediaInfo = mediaFromDom;
          mediaSource = "dom-retry-story";
        }
      }

      if (!mediaInfo?.url) {
        console.log("No media found.");
        return;
      }

      console.log("Selected media:", mediaSource, mediaInfo.type, mediaInfo.url);
      await openMedia(mediaInfo);
      return;
    }

    if (apiMedia?.url) {
      mediaInfo = apiMedia;
      mediaSource = "api";

      // If API still points to a photo but the active slide is clearly a video,
      // trust the active DOM media for this click.
      if (!inStories && apiMedia.type === "photo" && domMediaQuick?.url && domMediaQuick.type === "video") {
        mediaInfo = domMediaQuick;
        mediaSource = "dom-video-over-api-photo";
      }
    } else if (domMediaQuick?.url) {
      mediaInfo = domMediaQuick;
      mediaSource = "dom";
    } else {
      const mediaFromDom = normalizeMediaInfo(await extractMediaViaDom());
      if (mediaFromDom?.url) {
        mediaInfo = mediaFromDom;
        mediaSource = "dom-retry";
      } else if (!inStories) {
        const mediaFromMeta = normalizeMediaInfo(extractMediaFromMeta());
        if (mediaFromMeta?.url) {
          mediaInfo = mediaFromMeta;
          mediaSource = "meta";
        }
      }
    }

    if (!mediaInfo?.url) {
      console.log("No media found.");
      return;
    }

    if (
      !inStories &&
      mediaInfo.type !== "video" &&
      (canonicalLooksVideo || hasStrongVideoSignal())
    ) {
      let videoFallback = normalizeMediaInfo(await extractMediaViaDom());
      if (!videoFallback?.url || videoFallback.type !== "video") {
        videoFallback = normalizeMediaInfo(await waitForVisibleVideoUrl());
      }

      if (videoFallback?.url && videoFallback.type === "video") {
        mediaInfo = videoFallback;
        mediaSource = "dom-video-canonical-fallback";
      }
    }

    console.log("Selected media:", mediaSource, mediaInfo.type, mediaInfo.url);
    await openMedia(mediaInfo);
  }

  async function extractMediaViaApi(storyIdHint = null) {
    if (window.location.pathname.includes("/stories/")) {
      return await extractStoryMediaViaApi(storyIdHint);
    }
    return await extractPostMediaViaApi();
  }

  async function extractStoryMediaViaApi(storyIdHint = null) {
    let storyId = storyIdHint;
    if (!storyId) {
      for (let attempt = 0; attempt < 3; attempt++) {
        storyId = getStoryIdFromHref();
        if (storyId) {
          break;
        }
        await delay(200);
      }
    }

    if (!storyId) {
      return null;
    }

    const storyUrl = `https://i.instagram.com/api/v1/media/${storyId}/info/`;
    const data = await fetchMediaInfo(storyUrl);
    const storyItem = data?.items?.[0];
    const mediaInfo = getMediaInfoFromApiItem(storyItem);
    if (!mediaInfo) {
      return null;
    }

    if (!mediaInfo.accountName) {
      mediaInfo.accountName = getUsernameFromPath(window.location.pathname) || null;
    }
    return mediaInfo;
  }

  function prefetchApiForCurrentContext(contextKey, storyIdHint = null) {
    if (apiPrefetchInFlight?.contextKey === contextKey) {
      return apiPrefetchInFlight.promise;
    }

    const promise = extractMediaViaApi(storyIdHint)
      .then(normalizeMediaInfo)
      .then((mediaInfo) => {
        if (mediaInfo?.url) {
          storeApiPrefetch(mediaInfo, contextKey);
        }
        return mediaInfo;
      })
      .catch((error) => {
        console.warn("API media extraction failed:", error);
        return null;
      })
      .finally(() => {
        if (apiPrefetchInFlight?.contextKey === contextKey) {
          apiPrefetchInFlight = null;
        }
      });

    apiPrefetchInFlight = { contextKey, promise };
    return promise;
  }

  function getStoryIdFromHref(href = window.location.href) {
    const source = typeof href === "string" ? href : "";
    return source.match(/\/stories\/[^\/]+\/(\d+)/)?.[1] || null;
  }

  function getCurrentMediaContextKey() {
    if (window.location.pathname.includes("/stories/")) {
      return `story:${getStoryIdFromHref() || "unknown"}`;
    }

    const postInfo = getPostInfoFromUrl();
    if (postInfo?.shortcode) {
      const carouselIndex = getCurrentCarouselIndexFromDom() || 1;
      return `post:${postInfo.shortcode}:${carouselIndex}`;
    }

    return `path:${window.location.pathname}`;
  }

  function storeMediaPrefetch(mediaInfo, contextKey) {
    if (!mediaInfo?.url) {
      return;
    }

    mediaPrefetchCache = {
      key: contextKey,
      storedAt: Date.now(),
      mediaInfo: normalizeMediaInfo(mediaInfo)
    };
  }

  function storeApiPrefetch(mediaInfo, contextKey) {
    if (!mediaInfo?.url) {
      return;
    }

    apiPrefetchCache = {
      key: contextKey,
      storedAt: Date.now(),
      mediaInfo: normalizeMediaInfo(mediaInfo)
    };
  }

  function getFreshMediaPrefetch(contextKey) {
    if (!mediaPrefetchCache || mediaPrefetchCache.key !== contextKey) {
      return null;
    }

    if (Date.now() - mediaPrefetchCache.storedAt > MEDIA_PREFETCH_TTL_MS) {
      return null;
    }

    return mediaPrefetchCache.mediaInfo;
  }

  function getFreshApiPrefetch(contextKey) {
    if (!apiPrefetchCache || apiPrefetchCache.key !== contextKey) {
      return null;
    }

    if (Date.now() - apiPrefetchCache.storedAt > API_PREFETCH_TTL_MS) {
      return null;
    }

    return apiPrefetchCache.mediaInfo;
  }

  function prefetchCurrentMedia() {
    const contextKey = getCurrentMediaContextKey();
    const storyIdHint = window.location.pathname.includes("/stories/") ? getStoryIdFromHref() : null;
    const domMedia = normalizeMediaInfo(extractMediaViaDomOnce());
    if (domMedia?.url) {
      storeMediaPrefetch(domMedia, contextKey);
    }

    void prefetchApiForCurrentContext(contextKey, storyIdHint);
  }

  function getRuntimeAssetUrl(path) {
    try {
      if (browser.runtime && typeof browser.runtime.getURL === "function") {
        return browser.runtime.getURL(path);
      }
    } catch (error) {
      // Ignored: runtime API may be unavailable in non-extension harness.
    }

    return "";
  }

  function readFloatingButtonPosition() {
    try {
      const raw = window.localStorage.getItem(FLOATING_BUTTON_STORAGE_KEY);
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw);
      if (!Number.isFinite(parsed?.x) || !Number.isFinite(parsed?.y)) {
        return null;
      }

      return { x: parsed.x, y: parsed.y };
    } catch (error) {
      return null;
    }
  }

  function saveFloatingButtonPosition(position) {
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
      return;
    }

    try {
      window.localStorage.setItem(FLOATING_BUTTON_STORAGE_KEY, JSON.stringify(position));
    } catch (error) {
      // Ignored: storage may be disabled.
    }
  }

  function clampFloatingButtonPosition(position) {
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;

    const minX = FLOATING_BUTTON_MARGIN_PX;
    const minY = FLOATING_BUTTON_MARGIN_PX;
    const maxX = Math.max(minX, viewportWidth - FLOATING_BUTTON_SIZE_PX - FLOATING_BUTTON_MARGIN_PX);
    const maxY = Math.max(minY, viewportHeight - FLOATING_BUTTON_SIZE_PX - FLOATING_BUTTON_MARGIN_PX);

    return {
      x: Math.min(maxX, Math.max(minX, Number.isFinite(position?.x) ? position.x : maxX)),
      y: Math.min(maxY, Math.max(minY, Number.isFinite(position?.y) ? position.y : maxY))
    };
  }

  function applyFloatingButtonPosition(button, position) {
    const next = clampFloatingButtonPosition(position);
    button.style.left = `${Math.round(next.x)}px`;
    button.style.top = `${Math.round(next.y)}px`;
    button.style.right = "auto";
    button.style.bottom = "auto";
    return next;
  }

  function getFloatingButtonRectPosition(button) {
    const rect = button.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  }

  function setFloatingButtonBusy(button, isBusy) {
    button.dataset.busy = isBusy ? "true" : "false";
    button.style.opacity = isBusy ? "0.75" : "1";
    button.style.cursor = isBusy ? "progress" : "grab";
  }

  function createFloatingButtonIcon(button) {
    const iconUrl = getRuntimeAssetUrl("icons/icon-48.png");
    if (!iconUrl) {
      button.textContent = "DL";
      button.style.fontSize = "13px";
      button.style.fontWeight = "700";
      button.style.color = "#fff";
      return;
    }

    const icon = document.createElement("img");
    icon.src = iconUrl;
    icon.alt = "Instagram Media Extractor";
    icon.width = 36;
    icon.height = 36;
    icon.style.display = "block";
    icon.style.pointerEvents = "none";
    icon.addEventListener("error", () => {
      icon.remove();
      button.textContent = "DL";
      button.style.fontSize = "13px";
      button.style.fontWeight = "700";
      button.style.color = "#fff";
    }, { once: true });
    button.appendChild(icon);
  }

  function ensureFloatingButton() {
    if (window.top !== window.self) {
      return null;
    }

    const existing = document.getElementById(FLOATING_BUTTON_ID);
    if (existing) {
      return existing;
    }

    const button = document.createElement("button");
    button.id = FLOATING_BUTTON_ID;
    button.type = "button";
    button.title = "Download current Instagram media";
    button.setAttribute("aria-label", "Download current Instagram media");
    button.setAttribute("draggable", "false");
    button.style.position = "fixed";
    button.style.width = `${FLOATING_BUTTON_SIZE_PX}px`;
    button.style.height = `${FLOATING_BUTTON_SIZE_PX}px`;
    button.style.borderRadius = "999px";
    button.style.border = "1px solid rgba(255,255,255,0.25)";
    button.style.background = "linear-gradient(145deg, #ff4f5e 0%, #ff8f3f 100%)";
    button.style.boxShadow = "0 12px 28px rgba(0, 0, 0, 0.32)";
    button.style.zIndex = "2147483647";
    button.style.display = "flex";
    button.style.alignItems = "center";
    button.style.justifyContent = "center";
    button.style.padding = "0";
    button.style.margin = "0";
    button.style.outline = "none";
    button.style.userSelect = "none";
    button.style.webkitUserSelect = "none";
    button.style.touchAction = "none";
    button.style.cursor = "grab";
    button.style.transition = "transform 120ms ease, opacity 120ms ease, box-shadow 120ms ease";
    button.style.color = "#fff";
    button.style.overflow = "hidden";
    button.oncontextmenu = (event) => event.preventDefault();

    createFloatingButtonIcon(button);

    const saved = readFloatingButtonPosition();
    const defaultPosition = {
      x: (window.innerWidth || 0) - FLOATING_BUTTON_SIZE_PX - 20,
      y: (window.innerHeight || 0) - FLOATING_BUTTON_SIZE_PX - 80
    };
    applyFloatingButtonPosition(button, saved || defaultPosition);

    const dragState = {
      pointerId: null,
      startPointerX: 0,
      startPointerY: 0,
      startButtonX: 0,
      startButtonY: 0,
      moved: false,
      suppressClick: false,
      busy: false
    };

    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || dragState.busy) {
        return;
      }

      dragState.pointerId = event.pointerId;
      dragState.startPointerX = event.clientX;
      dragState.startPointerY = event.clientY;
      const current = getFloatingButtonRectPosition(button);
      dragState.startButtonX = current.x;
      dragState.startButtonY = current.y;
      dragState.moved = false;
      button.style.transition = "none";
      button.style.cursor = "grabbing";

      try {
        button.setPointerCapture(event.pointerId);
      } catch (error) {
        // Ignored.
      }
    });

    button.addEventListener("pointermove", (event) => {
      if (dragState.pointerId !== event.pointerId) {
        return;
      }

      const deltaX = event.clientX - dragState.startPointerX;
      const deltaY = event.clientY - dragState.startPointerY;
      if (Math.abs(deltaX) > 4 || Math.abs(deltaY) > 4) {
        dragState.moved = true;
      }

      const next = applyFloatingButtonPosition(button, {
        x: dragState.startButtonX + deltaX,
        y: dragState.startButtonY + deltaY
      });
      if (dragState.moved) {
        saveFloatingButtonPosition(next);
      }
    });

    function finishDrag(event) {
      if (dragState.pointerId !== event.pointerId) {
        return;
      }

      if (dragState.moved) {
        dragState.suppressClick = true;
        saveFloatingButtonPosition(getFloatingButtonRectPosition(button));
      }

      dragState.pointerId = null;
      button.style.transition = "transform 120ms ease, opacity 120ms ease, box-shadow 120ms ease";
      setFloatingButtonBusy(button, dragState.busy);
    }

    button.addEventListener("pointerup", finishDrag);
    button.addEventListener("pointercancel", finishDrag);

    button.addEventListener("click", async (event) => {
      if (dragState.suppressClick) {
        dragState.suppressClick = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (dragState.busy) {
        event.preventDefault();
        return;
      }

      dragState.busy = true;
      button.style.transform = "scale(0.96)";
      setFloatingButtonBusy(button, true);
      try {
        await extractMedia();
      } finally {
        dragState.busy = false;
        setFloatingButtonBusy(button, false);
        button.style.transform = "scale(1)";
      }
    });

    button.addEventListener("pointerenter", () => {
      if (!dragState.busy) {
        button.style.boxShadow = "0 14px 34px rgba(0, 0, 0, 0.42)";
      }
      prefetchCurrentMedia();
    });

    button.addEventListener("pointerleave", () => {
      if (!dragState.busy) {
        button.style.boxShadow = "0 12px 28px rgba(0, 0, 0, 0.32)";
      }
    });

    window.addEventListener("resize", () => {
      const next = applyFloatingButtonPosition(button, getFloatingButtonRectPosition(button));
      saveFloatingButtonPosition(next);
    });

    (document.body || document.documentElement).appendChild(button);
    return button;
  }

  function initFloatingButton() {
    if (floatingButtonInitialized) {
      return;
    }
    floatingButtonInitialized = true;

    const boot = () => {
      const button = ensureFloatingButton();
      if (!button) {
        floatingButtonInitialized = false;
        return;
      }
      prefetchCurrentMedia();
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
      return;
    }
    boot();
  }

  function parsePostInfoFromPath(pathname) {
    const source = typeof pathname === "string" ? pathname : "";
    // Instagram can serve media URLs both as /p/<shortcode>/ and /<username>/p/<shortcode>/.
    const match = source.match(/^\/(?:[^\/?#]+\/)?(p|reel|reels|tv)\/([^\/?#]+)/i);
    if (!match) {
      return null;
    }

    const rawPostType = match[1].toLowerCase();
    const normalizedPostType = rawPostType === "reels" ? "reel" : rawPostType;
    return {
      postType: normalizedPostType,
      shortcode: match[2]
    };
  }

  function getPostInfoFromUrl() {
    const fromPath = parsePostInfoFromPath(window.location.pathname);
    if (fromPath) {
      return fromPath;
    }

    return parsePostInfoFromPath(getCanonicalPathname());
  }

  function getFileTokenFromUrl(url) {
    if (!url || typeof url !== "string") {
      return "";
    }

    try {
      const parsed = new URL(url, window.location.origin);
      const lastPathPart = parsed.pathname.split("/").pop() || "";
      if (!lastPathPart) {
        return "";
      }
      return lastPathPart;
    } catch (error) {
      const withoutQuery = url.split("?")[0];
      const parts = withoutQuery.split("/");
      return parts[parts.length - 1] || "";
    }
  }

  function isVideoApiItem(item) {
    if (!item) {
      return false;
    }

    if (item.is_video === true) {
      return true;
    }

    if (item.media_type === 2) {
      return true;
    }

    return Array.isArray(item.video_versions) && item.video_versions.length > 0;
  }

  function pickBestVideoVersionUrl(item) {
    const versions = Array.isArray(item?.video_versions) ? item.video_versions : [];
    if (!versions.length) {
      return null;
    }

    const ranked = versions
      .map((version) => {
        const url = version?.url || "";
        if (!url) {
          return null;
        }

        const width = Number.isFinite(version?.width) ? version.width : 0;
        const height = Number.isFinite(version?.height) ? version.height : 0;
        const qualityScore = width * height;
        const isProgressive = /xpv_progressive|mime_type=video/i.test(url);
        const isSegmented = /bytestart=|byteend=|range=/i.test(url);
        const isDashInit = /\/dashinit\.mp4/i.test(url);

        let score = qualityScore;
        if (isProgressive) {
          score += 2000000;
        }
        if (isSegmented) {
          score -= 3000000;
        }
        if (isDashInit) {
          score -= 5000000;
        }

        return {
          url,
          score
        };
      })
      .filter((value) => value !== null)
      .sort((a, b) => b.score - a.score);

    return ranked[0]?.url || null;
  }

  function pickBestImageCandidateUrl(item) {
    const candidates = Array.isArray(item?.image_versions2?.candidates) ? item.image_versions2.candidates : [];
    if (!candidates.length) {
      return null;
    }

    const ranked = candidates
      .map((candidate) => {
        const url = candidate?.url || "";
        if (!url) {
          return null;
        }

        const width = Number.isFinite(candidate?.width) ? candidate.width : 0;
        const height = Number.isFinite(candidate?.height) ? candidate.height : 0;

        return {
          url,
          score: width * height
        };
      })
      .filter((value) => value !== null)
      .sort((a, b) => b.score - a.score);

    return ranked[0]?.url || null;
  }

  function getApiItemUsername(item) {
    const username =
      item?.user?.username
      || item?.owner?.username
      || item?.caption?.user?.username
      || null;
    return typeof username === "string" && username ? username : null;
  }

  function getMediaInfoFromApiItem(item) {
    if (!item) {
      return null;
    }

    const hasVideo = isVideoApiItem(item);
    const videoUrl = pickBestVideoVersionUrl(item);
    const imageUrl = pickBestImageCandidateUrl(item);
    const accountName = getApiItemUsername(item);

    if (hasVideo && videoUrl) {
      return { url: videoUrl, type: "video", accountName };
    }

    if (imageUrl) {
      return { url: imageUrl, type: "photo", accountName };
    }

    if (videoUrl) {
      return { url: videoUrl, type: "video", accountName };
    }

    return null;
  }

  function getPostRoot() {
    return document.querySelector("article") || document.querySelector("main") || document.body;
  }

  function parseTranslateX(transformValue) {
    if (!transformValue || transformValue === "none") {
      return null;
    }

    const translateMatch = transformValue.match(/translateX\((-?\d+(?:\.\d+)?)px\)/i);
    if (translateMatch) {
      return parseFloat(translateMatch[1]);
    }

    const translate3dMatch = transformValue.match(/translate3d\((-?\d+(?:\.\d+)?)px,\s*(-?\d+(?:\.\d+)?)px,\s*(-?\d+(?:\.\d+)?)px\)/i);
    if (translate3dMatch) {
      return parseFloat(translate3dMatch[1]);
    }

    const matrixMatch = transformValue.match(/matrix\(([^)]+)\)/i);
    if (matrixMatch) {
      const values = matrixMatch[1].split(",").map((value) => parseFloat(value.trim()));
      if (values.length === 6 && Number.isFinite(values[4])) {
        return values[4];
      }
    }

    const matrix3dMatch = transformValue.match(/matrix3d\(([^)]+)\)/i);
    if (matrix3dMatch) {
      const values = matrix3dMatch[1].split(",").map((value) => parseFloat(value.trim()));
      if (values.length === 16 && Number.isFinite(values[12])) {
        return values[12];
      }
    }

    return null;
  }

  function getCarouselIndexFromTransform(itemElement) {
    if (!(itemElement instanceof HTMLElement)) {
      return null;
    }

    const itemRect = itemElement.getBoundingClientRect();
    if (!itemRect.width) {
      return null;
    }

    const inlineTranslateX = parseTranslateX(itemElement.style.transform || "");
    if (Number.isFinite(inlineTranslateX)) {
      return Math.round(Math.abs(inlineTranslateX) / itemRect.width);
    }

    const computedTranslateX = parseTranslateX(window.getComputedStyle(itemElement).transform || "");
    if (Number.isFinite(computedTranslateX)) {
      return Math.round(Math.abs(computedTranslateX) / itemRect.width);
    }

    return null;
  }

  function findActiveCarouselItem() {
    const postRoot = getPostRoot();
    const candidateLists = Array.from(postRoot.querySelectorAll("ul"));
    let bestMatch = null;

    candidateLists.forEach((list) => {
      const children = Array.from(list.children).filter((child) => child instanceof HTMLElement);
      if (children.length < 2) {
        return;
      }

      const mediaChildren = children.filter((child) => child.querySelector("video, img"));
      if (mediaChildren.length < 2) {
        return;
      }

      const referenceElement = list.parentElement?.parentElement || list.parentElement || list;
      const referenceX = referenceElement.getBoundingClientRect().x;

      mediaChildren.forEach((child) => {
        const rect = child.getBoundingClientRect();
        if (rect.width < 80 || rect.height < 80) {
          return;
        }

        const distance = Math.abs(rect.x - referenceX);
        const area = rect.width * rect.height;
        const index = getCarouselIndexFromTransform(child);

        if (
          !bestMatch ||
          distance < bestMatch.distance ||
          (distance === bestMatch.distance && area > bestMatch.area)
        ) {
          bestMatch = {
            list,
            item: child,
            index,
            distance,
            area
          };
        }
      });
    });

    return bestMatch;
  }

  function scoreActiveIndicatorElement(element) {
    if (!(element instanceof HTMLElement)) {
      return -1;
    }

    let score = 0;
    if (element.getAttribute("aria-current") === "true") {
      score += 1000;
    }
    if (element.getAttribute("aria-selected") === "true") {
      score += 500;
    }
    if (element.classList.contains("_acnf")) {
      score += 300;
    }
    score += element.className.length;
    return score;
  }

  function findIndicatorDotContainer(root) {
    const stack = [root];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!(current instanceof HTMLElement)) {
        continue;
      }

      const childCount = current.children.length;
      if (childCount >= 2 && childCount <= 20) {
        const rect = current.getBoundingClientRect();
        if (rect.width >= 80 && rect.height >= 3 && rect.height <= 20) {
          let likelyDots = true;
          for (const child of current.children) {
            if (!(child instanceof HTMLElement)) {
              likelyDots = false;
              break;
            }
            const childRect = child.getBoundingClientRect();
            if (childRect.width > 30 || childRect.height > 30) {
              likelyDots = false;
              break;
            }
          }
          if (likelyDots) {
            return current;
          }
        }
      }

      for (const child of current.children) {
        stack.push(child);
      }
    }

    return null;
  }

  function getCurrentCarouselIndexFromDom() {
    const activeCarousel = findActiveCarouselItem();
    if (activeCarousel && Number.isFinite(activeCarousel.index)) {
      return activeCarousel.index + 1;
    }

    const postRoot = getPostRoot();
    const classBasedDots = Array.from(postRoot.querySelectorAll("._acnb"));
    if (classBasedDots.length >= 2) {
      let bestIndex = 0;
      let bestScore = -1;
      classBasedDots.forEach((dot, index) => {
        const score = scoreActiveIndicatorElement(dot);
        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      });
      return bestIndex + 1;
    }

    const dotContainer = findIndicatorDotContainer(postRoot);
    if (!dotContainer) {
      return null;
    }

    const dots = Array.from(dotContainer.children);
    if (dots.length < 2) {
      return null;
    }

    let bestIndex = 0;
    let bestScore = -1;
    dots.forEach((dot, index) => {
      const score = scoreActiveIndicatorElement(dot);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    return bestIndex + 1;
  }

  async function extractPostMediaViaApi() {
    const postInfo = getPostInfoFromUrl();
    if (!postInfo) {
      return null;
    }

    const mediaId = await getMediaId(postInfo);
    if (!mediaId) {
      return null;
    }

    const imgIndexMatch = window.location.href.match(/img_index=(\d+)/);
    const domIndex = getCurrentCarouselIndexFromDom();
    const imgIndex = imgIndexMatch ? parseInt(imgIndexMatch[1], 10) : (domIndex || 1);
    return await extractCurrentMedia(mediaId, imgIndex);
  }

  async function getMediaId(postInfo) {
    const postUrl = `https://www.instagram.com/${postInfo.postType}/${postInfo.shortcode}/`;
    const apiUrl = `https://www.instagram.com/api/v1/oembed/?url=${encodeURIComponent(postUrl)}`;
    const data = await fetchMediaInfo(apiUrl);
    return data?.media_id || null;
  }

  async function extractCurrentMedia(mediaId, imgIndex) {
    const url = `https://i.instagram.com/api/v1/media/${mediaId}/info/`;
    const data = await fetchMediaInfo(url);
    const mediaItem = data?.items?.[0];
    if (!mediaItem) {
      return null;
    }

    const mediaList = Array.isArray(mediaItem.carousel_media)
      ? mediaItem.carousel_media
      : [mediaItem];
    const selectedMedia = findBestCarouselMediaByDom(mediaList)
      || mediaList[Math.max(imgIndex - 1, 0)]
      || mediaList[0];
    if (!selectedMedia) {
      return null;
    }

    const mediaInfo = getMediaInfoFromApiItem(selectedMedia);
    if (!mediaInfo) {
      return null;
    }

    if (!mediaInfo.accountName) {
      mediaInfo.accountName = getApiItemUsername(mediaItem);
    }
    return mediaInfo;
  }

  function getLargestVisibleElement(candidates) {
    const ranked = candidates
      .filter(isVisibleElement)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          element,
          area: rect.width * rect.height
        };
      })
      .sort((a, b) => b.area - a.area);

    return ranked[0]?.element || null;
  }

  function getBestMediaElementFromContainer(container) {
    if (!(container instanceof HTMLElement)) {
      return null;
    }

    const visibleVideos = Array.from(container.querySelectorAll("video"));
    const bestVisibleVideo = getLargestVisibleElement(visibleVideos);
    if (bestVisibleVideo && getVideoUrl(bestVisibleVideo)) {
      return bestVisibleVideo;
    }

    const visibleImages = Array.from(container.querySelectorAll("img"));
    const bestVisibleImage = getLargestVisibleElement(visibleImages);
    if (bestVisibleImage) {
      return bestVisibleImage;
    }

    const fallbackVideo = container.querySelector("video");
    if (fallbackVideo && getVideoUrl(fallbackVideo)) {
      return fallbackVideo;
    }

    return container.querySelector("img");
  }

  function getActivePostMediaContext() {
    const postRoot = getPostRoot();
    const activeCarousel = findActiveCarouselItem();

    if (activeCarousel?.item instanceof HTMLElement) {
      return {
        container: activeCarousel.item,
        mediaElement: getBestMediaElementFromContainer(activeCarousel.item),
        carouselIndex: Number.isFinite(activeCarousel.index) ? activeCarousel.index : null
      };
    }

    return {
      container: postRoot,
      mediaElement: getBestMediaElementFromContainer(postRoot),
      carouselIndex: null
    };
  }

  function getTokenCandidatesForMediaElement(mediaElement) {
    const tokens = [];

    if (mediaElement instanceof HTMLVideoElement) {
      const videoUrl = getVideoUrl(mediaElement);
      if (videoUrl && !videoUrl.startsWith("blob:")) {
        tokens.push(getFileTokenFromUrl(videoUrl));
      }

      if (mediaElement.poster) {
        tokens.push(getFileTokenFromUrl(mediaElement.poster));
      }

      const sourceUrls = Array.from(mediaElement.querySelectorAll("source"))
        .map((source) => source.src)
        .filter((url) => Boolean(url) && !url.startsWith("blob:"));
      sourceUrls.forEach((url) => tokens.push(getFileTokenFromUrl(url)));
    } else if (mediaElement instanceof HTMLImageElement) {
      const bestImageUrl = getBestImageUrl(mediaElement);
      if (bestImageUrl) {
        tokens.push(getFileTokenFromUrl(bestImageUrl));
      }
      if (mediaElement.currentSrc) {
        tokens.push(getFileTokenFromUrl(mediaElement.currentSrc));
      }
      if (mediaElement.src) {
        tokens.push(getFileTokenFromUrl(mediaElement.src));
      }
    }

    return Array.from(new Set(tokens.filter(Boolean)));
  }

  function doesMediaItemContainToken(item, token) {
    if (!item || !token) {
      return false;
    }

    const versionTokens = [];

    const videoVersions = Array.isArray(item.video_versions) ? item.video_versions : [];
    videoVersions.forEach((version) => {
      versionTokens.push(getFileTokenFromUrl(version?.url || ""));
    });

    const imageCandidates = Array.isArray(item.image_versions2?.candidates) ? item.image_versions2.candidates : [];
    imageCandidates.forEach((candidate) => {
      versionTokens.push(getFileTokenFromUrl(candidate?.url || ""));
    });

    return versionTokens.some((value) => value && value === token);
  }

  function getMediaInfoFromElement(mediaElement) {
    const accountName = getCurrentAccountName();

    if (mediaElement instanceof HTMLVideoElement) {
      const videoUrl = getVideoUrl(mediaElement);
      return videoUrl ? { url: videoUrl, type: "video", accountName } : null;
    }

    if (mediaElement instanceof HTMLImageElement) {
      const imageUrl = getBestImageUrl(mediaElement);
      return imageUrl ? { url: imageUrl, type: "photo", accountName } : null;
    }

    return null;
  }

  function extractActivePostMediaFromDom() {
    const context = getActivePostMediaContext();
    const mediaElement = context?.mediaElement;
    if (!mediaElement) {
      return null;
    }
    return getMediaInfoFromElement(mediaElement);
  }

  function findBestCarouselMediaByDom(mediaList) {
    if (!Array.isArray(mediaList) || mediaList.length <= 1) {
      return null;
    }

    const context = getActivePostMediaContext();
    const activeElement = context?.mediaElement;
    if (!activeElement) {
      return null;
    }

    const preferredType = activeElement instanceof HTMLVideoElement ? "video" : "photo";
    const sameTypeList = mediaList.filter((item) => (isVideoApiItem(item) ? "video" : "photo") === preferredType);
    const otherTypeList = mediaList.filter((item) => (isVideoApiItem(item) ? "video" : "photo") !== preferredType);
    const tokenCandidates = getTokenCandidatesForMediaElement(activeElement);

    for (const token of tokenCandidates) {
      for (const list of [sameTypeList, otherTypeList]) {
        const match = list.find((item) => doesMediaItemContainToken(item, token));
        if (match) {
          console.log("Carousel mapping:", "token", token, "type", preferredType);
          return match;
        }
      }
    }

    if (Number.isFinite(context.carouselIndex) && mediaList[context.carouselIndex]) {
      console.log("Carousel mapping:", "transform-index", context.carouselIndex);
      return mediaList[context.carouselIndex];
    }

    const domIndex = getCurrentCarouselIndexFromDom();
    if (domIndex && mediaList[domIndex - 1]) {
      console.log("Carousel mapping:", "dot-index", domIndex - 1);
      return mediaList[domIndex - 1];
    }

    if (preferredType === "video" && sameTypeList.length === 1) {
      console.log("Carousel mapping:", "single-video-item");
      return sameTypeList[0];
    }

    return null;
  }

  function isVisibleElement(element) {
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width <= 80 || rect.height <= 80) {
      return false;
    }

    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    if (!viewportWidth || !viewportHeight) {
      return false;
    }

    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= viewportHeight || rect.left >= viewportWidth) {
      return false;
    }

    const visibleWidth = Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0);
    const visibleHeight = Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0);

    return visibleWidth > 40 && visibleHeight > 40;
  }

  function getBestImageUrl(imageElement) {
    const srcset = imageElement.getAttribute("srcset");
    if (!srcset) {
      return imageElement.currentSrc || imageElement.src || null;
    }

    const variants = srcset
      .split(",")
      .map((entry) => entry.trim())
      .map((entry) => {
        const [url, descriptor] = entry.split(/\s+/);
        const width = parseInt((descriptor || "").replace(/\D/g, ""), 10);
        return {
          url,
          width: Number.isFinite(width) ? width : 0
        };
      })
      .filter((item) => Boolean(item.url));

    variants.sort((a, b) => b.width - a.width);
    return variants[0]?.url || imageElement.currentSrc || imageElement.src || null;
  }

  function pickLargestMedia(candidates, type) {
    const ranked = candidates
      .filter(isVisibleElement)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          element,
          area: rect.width * rect.height
        };
      })
      .sort((a, b) => b.area - a.area);

    const largest = ranked[0]?.element;
    if (!largest) {
      return null;
    }

    const mediaUrl = type === "video"
      ? (largest.currentSrc || largest.src || null)
      : getBestImageUrl(largest);

    return mediaUrl ? { url: mediaUrl, type, accountName: getCurrentAccountName() } : null;
  }

  function getVideoUrl(videoElement) {
    if (!videoElement) {
      return null;
    }

    const sourceUrl =
      videoElement.currentSrc ||
      videoElement.src ||
      videoElement.querySelector("source")?.src ||
      null;

    return sourceUrl || null;
  }

  function pickBestStoryVideo(videoElements) {
    const ranked = videoElements
      .map((video) => {
        const url = getVideoUrl(video);
        if (!url) {
          return null;
        }

        const rect = video.getBoundingClientRect();
        const isVisible = isVisibleElement(video);
        if (!isVisible) {
          return null;
        }
        const area = rect.width * rect.height;
        let score = area;

        if (isVisible) {
          score += 500000;
        }
        if (!video.paused && !video.ended) {
          score += 300000;
        }
        if (video.readyState >= 2) {
          score += 100000;
        }
        if (!video.muted) {
          score += 10000;
        }
        if (url.startsWith("blob:")) {
          score += 1000;
        }

        return { url, score };
      })
      .filter((item) => item !== null)
      .sort((a, b) => b.score - a.score);

    const best = ranked[0];
    if (!best) {
      return null;
    }
    return {
      url: best.url,
      type: "video",
      accountName: getUsernameFromPath(window.location.pathname) || getCurrentAccountName()
    };
  }

  function sanitizeSegmentedVideoUrl(url) {
    try {
      const parsed = new URL(url);
      parsed.searchParams.delete("bytestart");
      parsed.searchParams.delete("byteend");
      parsed.searchParams.delete("range");
      return parsed.toString();
    } catch (error) {
      return url;
    }
  }

  function isLikelyAudioOnlyVideoUrl(url) {
    const source = String(url || "").toLowerCase();
    if (!source) {
      return false;
    }

    return /mime_type=audio|[\/_.-]audio[\/_.-]|audio_codec|\/a1\/|\/a\/t\d\//i.test(source);
  }

  function buildPerformanceVideoCandidates(options = {}) {
    const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : PERFORMANCE_VIDEO_MAX_AGE_POST_MS;
    const now = Number.isFinite(performance.now()) ? performance.now() : 0;
    const entries = performance.getEntriesByType("resource");
    const candidates = new Map();

    entries
      .filter((entry) => entry && typeof entry.name === "string")
      .filter((entry) => /cdninstagram\.com/i.test(entry.name))
      .filter((entry) => /\.(mp4)(\?|$)/i.test(entry.name) || /mime_type=video/i.test(entry.name))
      .filter((entry) => !isLikelyAudioOnlyVideoUrl(entry.name))
      .filter((entry) => {
        if (!Number.isFinite(maxAgeMs)) {
          return true;
        }

        const responseEnd = Number.isFinite(entry.responseEnd) ? entry.responseEnd : 0;
        const startTime = Number.isFinite(entry.startTime) ? entry.startTime : 0;
        const timestamp = Math.max(responseEnd, startTime);
        return now - timestamp <= maxAgeMs;
      })
      .forEach((entry) => {
        const rawUrl = entry.name;
        const sanitizedUrl = sanitizeSegmentedVideoUrl(rawUrl);
        const isDashInit = /\/dashinit\.mp4/i.test(rawUrl);
        const isSegmented = /bytestart=|byteend=|range=/i.test(rawUrl);

        let baseScore = 0;
        if (/mime_type=video/i.test(rawUrl) || /xpv_progressive/i.test(rawUrl)) {
          baseScore += 100;
        }
        if (/\/o1\/v\/|\/v\/t\d\//i.test(rawUrl)) {
          baseScore += 25;
        }
        if (isSegmented) {
          baseScore -= 500;
        }
        if (isDashInit) {
          baseScore -= 1200;
        }

        const responseEnd = Number.isFinite(entry.responseEnd) ? entry.responseEnd : 0;

        function upsert(url, extraScore, source) {
          if (!url) {
            return;
          }

          const score = baseScore + extraScore;
          const existing = candidates.get(url);
          if (!existing || score > existing.score || (score === existing.score && responseEnd > existing.responseEnd)) {
            candidates.set(url, { url, score, responseEnd, source });
          }
        }

        upsert(rawUrl, 0, "raw");
        if (sanitizedUrl !== rawUrl && !isDashInit) {
          upsert(sanitizedUrl, 350, "sanitized");
        }
      });

    return Array.from(candidates.values()).sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return b.responseEnd - a.responseEnd;
    });
  }

  function pickVideoFromPerformanceEntries(options = {}) {
    const best = buildPerformanceVideoCandidates(options)[0];
    return best ? { url: best.url, type: "video" } : null;
  }

  function getActivePostMediaTokenSet() {
    const context = getActivePostMediaContext();
    const mediaElement = context?.mediaElement || null;
    if (!mediaElement) {
      return new Set();
    }
    return new Set(getTokenCandidatesForMediaElement(mediaElement));
  }

  function extractStoryVideoFromPerformance() {
    return pickVideoFromPerformanceEntries({ maxAgeMs: PERFORMANCE_VIDEO_MAX_AGE_STORY_MS });
  }

  function pickBestStoryImage(imageElements) {
    const ranked = imageElements
      .filter(isVisibleElement)
      .map((image) => {
        const rect = image.getBoundingClientRect();
        const area = rect.width * rect.height;
        const url = getBestImageUrl(image);
        if (!url) {
          return null;
        }

        let score = area;
        if (rect.height > rect.width) {
          score += 100000;
        }
        if (/\/t51\.2885-19\//i.test(url)) {
          score -= 1000000;
        }

        return { image, score };
      })
      .filter((item) => item !== null)
      .sort((a, b) => b.score - a.score);

    const best = ranked[0]?.image;
    if (!best) {
      return null;
    }

    const mediaUrl = getBestImageUrl(best);
    if (!mediaUrl) {
      return null;
    }
    return {
      url: mediaUrl,
      type: "photo",
      accountName: getUsernameFromPath(window.location.pathname) || getCurrentAccountName()
    };
  }

  function extractMediaViaDomOnce() {
    const inStories = window.location.pathname.includes("/stories/");

    if (inStories) {
      const videoCandidates = Array.from(document.querySelectorAll("video"));
      const bestStoryVideo = pickBestStoryVideo(videoCandidates);
      if (bestStoryVideo) {
        return bestStoryVideo;
      }

      const perfVideo = extractStoryVideoFromPerformance();
      if (perfVideo) {
        return perfVideo;
      }

      const imageCandidates = Array.from(document.querySelectorAll("img"));
      return pickBestStoryImage(imageCandidates);
    }

    const activePostMedia = extractActivePostMediaFromDom();
    if (activePostMedia?.url) {
      return activePostMedia;
    }

    const postRoot = getPostRoot();
    const videoCandidates = Array.from(postRoot.querySelectorAll("video"));
    const bestVideo = pickLargestMedia(videoCandidates, "video");
    if (bestVideo) {
      return bestVideo;
    }

    const imageCandidates = Array.from(postRoot.querySelectorAll("img"));
    return pickLargestMedia(imageCandidates, "photo");
  }

  async function extractMediaViaDom() {
    for (let attempt = 0; attempt < DOM_RETRY_COUNT; attempt++) {
      primeVisibleVideos();
      const mediaInfo = extractMediaViaDomOnce();
      if (mediaInfo?.url) {
        return normalizeMediaInfo(mediaInfo);
      }
      await delay(DOM_RETRY_DELAY_MS);
    }
    return null;
  }

  async function waitForVisibleVideoUrl(maxAttempts = 10, intervalMs = 250) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      primeVisibleVideos();
      const postRoot = getPostRoot();
      const videos = Array.from(postRoot.querySelectorAll("video"));
      const bestVideo = getLargestVisibleElement(videos);
      const videoUrl = getVideoUrl(bestVideo);
      if (videoUrl) {
        return { url: videoUrl, type: "video", accountName: getCurrentAccountName() };
      }
      await delay(intervalMs);
    }

    return null;
  }

  function primeVisibleVideos() {
    const videos = Array.from(document.querySelectorAll("video"));
    videos.forEach((video) => {
      if (!isVisibleElement(video)) {
        return;
      }

      try {
        video.muted = true;
        const playPromise = video.play();
        if (playPromise && typeof playPromise.catch === "function") {
          playPromise.catch(() => {});
        }
      } catch (error) {
        // Ignored: autoplay may be blocked by browser policy.
      }
    });
  }

  function looksLikeVideoUrl(url) {
    if (!url) {
      return false;
    }

    return /\.mp4(\?|$)/i.test(url) || /mime_type=video/i.test(url);
  }

  function normalizeMediaInfo(mediaInfo) {
    if (!mediaInfo?.url) {
      return mediaInfo;
    }

    if (mediaInfo.type !== "video" && looksLikeVideoUrl(mediaInfo.url)) {
      return { ...mediaInfo, type: "video" };
    }

    return { ...mediaInfo };
  }

  function extractVideoFromMeta() {
    const ogVideo =
      document.querySelector('meta[property="og:video"]')?.getAttribute("content") ||
      document.querySelector('meta[property="og:video:url"]')?.getAttribute("content") ||
      document.querySelector('meta[property="og:video:secure_url"]')?.getAttribute("content");

    return ogVideo ? { url: ogVideo, type: "video", accountName: getCurrentAccountName() } : null;
  }

  function extractMediaFromMeta() {
    const metaVideo = extractVideoFromMeta();
    if (metaVideo) {
      return metaVideo;
    }

    const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute("content");
    if (ogImage) {
      return { url: ogImage, type: "photo", accountName: getCurrentAccountName() };
    }

    return null;
  }

  function getCanonicalPathname() {
    const canonicalHref = document.querySelector('link[rel="canonical"]')?.getAttribute("href");
    if (!canonicalHref) {
      return "";
    }

    try {
      const url = new URL(canonicalHref, window.location.origin);
      return url.pathname || "";
    } catch (error) {
      return "";
    }
  }

  function hasStrongVideoSignal() {
    if (/\/(reel|reels|tv)\//i.test(window.location.pathname)) {
      return true;
    }

    const canonicalPath = getCanonicalPathname();
    if (/\/(reel|reels|tv)\//i.test(canonicalPath)) {
      return true;
    }

    const ogType = (document.querySelector('meta[property="og:type"]')?.getAttribute("content") || "").toLowerCase();
    if (ogType.includes("video")) {
      return true;
    }

    if (extractVideoFromMeta()?.url) {
      return true;
    }

    return false;
  }

  function extFromMimeType(mimeType) {
    if (!mimeType) {
      return null;
    }

    if (mimeType.includes("video/mp4")) {
      return "mp4";
    }
    if (mimeType.includes("video/webm")) {
      return "webm";
    }
    if (mimeType.includes("image/jpeg")) {
      return "jpg";
    }
    if (mimeType.includes("image/png")) {
      return "png";
    }
    if (mimeType.includes("image/webp")) {
      return "webp";
    }

    return null;
  }

  function normalizeFileName(baseName, extension) {
    if (!extension) {
      return baseName;
    }

    if (/\.[a-z0-9]{2,5}$/i.test(baseName)) {
      return baseName;
    }

    return `${baseName}.${extension}`;
  }

  function sanitizeFileComponent(value, fallback = "instagram") {
    const normalized = String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/^@+/, "")
      .replace(/[^a-z0-9._-]+/g, "_")
      .replace(/^[_\-.]+|[_\-.]+$/g, "")
      .slice(0, 40);

    return normalized || fallback;
  }

  function formatDownloadTimestamp(date = new Date()) {
    const pad2 = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}_${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
  }

  function getUsernameFromPath(pathname) {
    const source = typeof pathname === "string" ? pathname : "";
    const storyMatch = source.match(/^\/stories\/([^\/?#]+)/i);
    if (storyMatch?.[1]) {
      return storyMatch[1];
    }

    const prefixedPostMatch = source.match(/^\/([^\/?#]+)\/(?:p|reel|reels|tv)\//i);
    if (prefixedPostMatch?.[1]) {
      return prefixedPostMatch[1];
    }

    return null;
  }

  function parsePossibleUsernameFromUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") {
      return null;
    }

    const RESERVED = new Set([
      "p",
      "reel",
      "reels",
      "tv",
      "stories",
      "explore",
      "accounts",
      "about",
      "developer",
      "direct",
      "challenge",
      "legal",
      "privacy",
      "terms"
    ]);

    try {
      const parsed = new URL(rawUrl, window.location.origin);
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (!parts.length) {
        return null;
      }

      if (parts[0] === "stories" && parts[1]) {
        return parts[1];
      }

      const first = parts[0];
      if (first && !RESERVED.has(first.toLowerCase())) {
        return first;
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  function getUsernameFromDom() {
    const selectors = [
      "article header a[href^='/']",
      "main article header a[href^='/']",
      "main header a[href^='/']",
      "header a[href^='/']",
      "a[href^='/'][role='link']",
      "main a[href^='/']"
    ];

    for (const selector of selectors) {
      const nodes = Array.from(document.querySelectorAll(selector));
      for (let i = 0; i < nodes.length && i < 40; i++) {
        const href = nodes[i]?.getAttribute("href") || "";
        const parsed = parsePossibleUsernameFromUrl(href);
        if (parsed) {
          return parsed;
        }
      }
    }

    return null;
  }

  function getCurrentAccountName() {
    const pathUser = getUsernameFromPath(window.location.pathname);
    if (pathUser) {
      return pathUser;
    }

    const canonicalHref = document.querySelector("link[rel='canonical']")?.getAttribute("href");
    const canonicalUser = parsePossibleUsernameFromUrl(canonicalHref);
    if (canonicalUser) {
      return canonicalUser;
    }

    const ogUrl = document.querySelector("meta[property='og:url']")?.getAttribute("content");
    const ogUser = parsePossibleUsernameFromUrl(ogUrl);
    if (ogUser) {
      return ogUser;
    }

    const ogTitle = document.querySelector("meta[property='og:title']")?.getAttribute("content") || "";
    const titleSources = [ogTitle, document.title || ""];
    const titlePatterns = [
      /^([^:]+?)\s+on Instagram/i,
      /by\s+@?([a-z0-9._]+)/i,
      /@([a-z0-9._]+)/i
    ];
    for (const source of titleSources) {
      for (const pattern of titlePatterns) {
        const match = source.match(pattern);
        if (match?.[1]) {
          return match[1];
        }
      }
    }

    return getUsernameFromDom() || "instagram";
  }

  function resolveAccountNameForFile(accountNameHint) {
    const fromHint = sanitizeFileComponent(accountNameHint, "");
    if (fromHint) {
      return fromHint;
    }
    return sanitizeFileComponent(getCurrentAccountName(), "instagram");
  }

  function getFileName(mediaUrl, mimeType, mediaType, accountNameHint = "") {
    const mimeExtension = extFromMimeType(mimeType);
    const fallbackExtension = mediaType === "video" ? "mp4" : "jpg";
    const extension = mimeExtension || fallbackExtension;
    const accountName = resolveAccountNameForFile(accountNameHint);
    const timestamp = formatDownloadTimestamp();
    return normalizeFileName(`${accountName}_${timestamp}`, extension);
  }

  function triggerDownload(downloadUrl, fileName) {
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  async function isLikelyPlayableVideoBlob(blob, mediaUrl) {
    const lowerType = (blob.type || "").toLowerCase();
    const urlLooksMp4 = /\.mp4(\?|$)/i.test(mediaUrl);
    const isMp4 = lowerType.includes("video/mp4") || urlLooksMp4;

    if (blob.size < 120 * 1024) {
      return false;
    }

    if (!isMp4) {
      return true;
    }

    const sampleSize = Math.min(blob.size, 512 * 1024);
    const bytes = new Uint8Array(await blob.slice(0, sampleSize).arrayBuffer());
    const sampleText = new TextDecoder("latin1").decode(bytes);

    const hasFtyp = sampleText.includes("ftyp");
    const hasMdat = sampleText.includes("mdat");

    if (!hasFtyp) {
      return false;
    }
    if (hasMdat) {
      return true;
    }

    // Init segments are usually tiny and contain no mdat.
    return blob.size > 2 * 1024 * 1024;
  }

  async function downloadMediaUrl(mediaUrl, mediaType, options = {}) {
    const response = await fetch(mediaUrl, { credentials: "include" });
    if (!response.ok) {
      throw new Error(`Media fetch failed with status ${response.status}`);
    }

    const blob = await response.blob();
    if (options.validateVideo && mediaType === "video") {
      const likelyPlayable = await isLikelyPlayableVideoBlob(blob, mediaUrl);
      if (!likelyPlayable) {
        throw new Error("Fetched video looks like a partial/invalid segment.");
      }
    }

    const objectUrl = URL.createObjectURL(blob);
    const fileName = getFileName(mediaUrl, blob.type, mediaType, options.accountName || "");
    triggerDownload(objectUrl, fileName);
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }

  async function triggerBlobDownloadFromPageContext(blobUrl, fileName) {
    return await new Promise((resolve, reject) => {
      const requestId = `ig_blob_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const timeoutId = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(new Error("Timed out while downloading blob from page context."));
      }, 5000);

      function onMessage(event) {
        if (event.source !== window) {
          return;
        }

        const data = event.data;
        if (!data || data.source !== "ig-photo-extractor" || data.requestId !== requestId) {
          return;
        }

        clearTimeout(timeoutId);
        window.removeEventListener("message", onMessage);
        if (data.ok) {
          resolve();
        } else {
          reject(new Error(data.error || "Page context failed to download blob."));
        }
      }

      window.addEventListener("message", onMessage);

      const script = document.createElement("script");
      script.textContent = `
        (() => {
          const requestId = ${JSON.stringify(requestId)};
          try {
            const link = document.createElement("a");
            link.href = ${JSON.stringify(blobUrl)};
            link.download = ${JSON.stringify(fileName)};
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            window.postMessage({ source: "ig-photo-extractor", requestId, ok: true }, "*");
          } catch (error) {
            window.postMessage(
              {
                source: "ig-photo-extractor",
                requestId,
                ok: false,
                error: String(error && error.message ? error.message : error)
              },
              "*"
            );
          }
        })();
      `;

      (document.head || document.documentElement).appendChild(script);
      script.remove();
    });
  }

  async function openMedia(mediaInfo) {
    let { url: mediaUrl, type: mediaType, accountName: mediaAccountName } = mediaInfo;
    const inStories = window.location.pathname.includes("/stories/");
    const canonicalPath = getCanonicalPathname();
    const isReelContext = /\/(reel|reels|tv)\//i.test(window.location.pathname) || /\/(reel|reels|tv)\//i.test(canonicalPath);

    if (mediaUrl.startsWith("blob:")) {
      const preferredTokens = new Set();

      if (!inStories && mediaType === "video") {
        const apiPostVideo = normalizeMediaInfo(await extractPostMediaViaApi());
        if (apiPostVideo?.accountName) {
          mediaAccountName = apiPostVideo.accountName;
        }
        if (apiPostVideo?.url && !apiPostVideo.url.startsWith("blob:") && apiPostVideo.type === "video") {
          const apiToken = getFileTokenFromUrl(apiPostVideo.url);
          if (apiToken) {
            preferredTokens.add(apiToken);
          }
          try {
            await downloadMediaUrl(apiPostVideo.url, "video", {
              validateVideo: true,
              accountName: mediaAccountName
            });
            console.log("Resolved blob URL from post API:", apiPostVideo.url);
            return;
          } catch (error) {
            console.warn("Post API fallback failed:", apiPostVideo.url, error);
          }
        }

        const metaVideo = normalizeMediaInfo(extractVideoFromMeta());
        if (metaVideo?.url) {
          const metaToken = getFileTokenFromUrl(metaVideo.url);
          if (metaToken) {
            preferredTokens.add(metaToken);
          }
          try {
            await downloadMediaUrl(metaVideo.url, "video", {
              validateVideo: true,
              accountName: mediaAccountName
            });
            console.log("Resolved blob URL from meta:", metaVideo.url);
            return;
          } catch (error) {
            console.warn("Meta video fallback failed:", metaVideo.url, error);
          }
        }
      }

      let performanceCandidates = [];
      if (mediaType === "video") {
        performanceCandidates = buildPerformanceVideoCandidates({
          maxAgeMs: inStories ? PERFORMANCE_VIDEO_MAX_AGE_STORY_MS : PERFORMANCE_VIDEO_MAX_AGE_POST_MS
        });

        const activeTokens = !inStories ? getActivePostMediaTokenSet() : new Set();
        if (activeTokens.size > 0) {
          const activeTokenMatched = performanceCandidates.filter((candidate) => {
            const token = getFileTokenFromUrl(candidate.url);
            return token && activeTokens.has(token);
          });
          if (activeTokenMatched.length > 0) {
            performanceCandidates = activeTokenMatched;
          }
        }

        if (preferredTokens.size > 0) {
          const tokenMatched = performanceCandidates.filter((candidate) => {
            const token = getFileTokenFromUrl(candidate.url);
            return token && preferredTokens.has(token);
          });
          if (tokenMatched.length > 0) {
            performanceCandidates = tokenMatched;
          }
        }

        if (!inStories && isReelContext && preferredTokens.size === 0 && activeTokens.size === 0) {
          performanceCandidates = [];
        }
      }

      for (const candidate of performanceCandidates) {
        try {
          await downloadMediaUrl(candidate.url, "video", {
            validateVideo: true,
            accountName: mediaAccountName
          });
          console.log("Resolved blob URL from performance:", candidate.source, candidate.url);
          return;
        } catch (error) {
          console.warn("Performance candidate failed:", candidate.url, error);
        }
      }

      const blobFileName = getFileName(mediaUrl, "", mediaType, mediaAccountName || "");
      try {
        await triggerBlobDownloadFromPageContext(mediaUrl, blobFileName);
        return;
      } catch (error) {
        console.warn("Failed to download blob URL in page context.", error);
      }
    }

    try {
      await downloadMediaUrl(mediaUrl, mediaType, {
        validateVideo: mediaType === "video",
        accountName: mediaAccountName
      });
    } catch (error) {
      console.warn("Blob download failed.", error);
      const canOpenDirectly = /^https?:\/\//i.test(mediaUrl);
      if (mediaType === "video" && canOpenDirectly) {
        window.open(mediaUrl, "_blank", "noopener");
      }
    }
  }

  initFloatingButton();

  browser.runtime.onMessage.addListener((message) => {
    if (!message || typeof message.action !== "string") {
      return;
    }

    if (message.action === "extractMedia") {
      void extractMedia();
      return;
    }

    if (message.action === "prefetchMedia") {
      prefetchCurrentMedia();
    }
  });
})();
