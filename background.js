"use strict";

chrome.runtime.onInstalled.addListener(() => console.log("AutoGrok background v6.0 Human-Grok"));

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function findRecentDownload(sinceMs) {
  const sinceIso = new Date(Math.max(0, Number(sinceMs || 0) - 5000)).toISOString();
  const items = await chrome.downloads.search({
    startedAfter: sinceIso,
    orderBy: ["-startTime"],
    limit: 8
  });

  return (items || []).find(d => {
    if (!d) return false;
    if (d.state === "interrupted") return true;
    return d.state === "complete" || d.state === "in_progress";
  }) || null;
}

async function waitForRecentDownloadComplete(sinceMs, timeoutMs) {
  const start = Date.now();
  let seenId = null;

  while (Date.now() - start < Number(timeoutMs || 90000)) {
    const item = await findRecentDownload(sinceMs);

    if (item) {
      seenId = item.id;
      if (item.state === "complete") {
        return { ok: true, id: item.id, filename: item.filename || "" };
      }
      if (item.state === "interrupted") {
        return { ok: false, interrupted: true, id: item.id, error: item.error || "interrupted" };
      }
    }

    if (seenId != null) {
      const items = await chrome.downloads.search({ id: seenId });
      const d = items && items[0];
      if (d?.state === "complete") return { ok: true, id: d.id, filename: d.filename || "" };
      if (d?.state === "interrupted") return { ok: false, interrupted: true, id: d.id, error: d.error || "interrupted" };
    }

    await sleep(900);
  }

  return { ok: false, timeout: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (String(msg?.source || "").toLowerCase() !== "autogrok" || msg?.to !== "background") {
    return false;
  }

  if (msg.type === "downloadFile") {
    chrome.downloads.download({ url: msg.url, filename: msg.filename || "autogrok-file" })
      .then(id => sendResponse({ ok: true, id }))
      .catch(e => sendResponse({ ok: false, error: e?.message || String(e) }));
    return true;
  }

  if (msg.type === "waitForRecentDownloadComplete") {
    waitForRecentDownloadComplete(msg.since, msg.timeout)
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: e?.message || String(e) }));
    return true;
  }

  return false;
});
