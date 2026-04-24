// background.js (MV3 service worker)
// info("[助手·BG] background.js 已启动");

let pendingRename = null; 
// Hedra 模式：{ prefix: string, ts: number }
// Clipchamp 模式：{ filename: string, ts: number }
// vidnoz 模式：{ fn: string, ts: number }
// elevenlabs 模式：{ prev: string, ts: number }
// const MATCH_MS = 18_000; // 10秒内点击有效
const LOG_PREFIX = "[Hedra助手]";

function getTimeStr() {
  const now = new Date();
  const pad = (n, len = 2) => n.toString().padStart(len, '0');

  const h = pad(now.getHours());
  const m = pad(now.getMinutes());
  const s = pad(now.getSeconds());
  const ms = pad(now.getMilliseconds(), 3);

  return `${h}:${m}:${s}.${ms}`; // 例如：14:32:08.123
}
function debug(...args){ console.debug(`${getTimeStr()}`, LOG_PREFIX, ...args); }
function info(...args){ console.info(`${getTimeStr()}`, LOG_PREFIX, ...args); }
function warn(...args){ console.warn(`${getTimeStr()}`, LOG_PREFIX, ...args); }
function error(...args){ console.error(`${getTimeStr()}`, LOG_PREFIX, ...args); }


chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // info("[BG] 收到消息:", msg);

  if (msg?.action === "prepareRename") {
    if (typeof msg.prefix === "string") {
      pendingRename = { prefix: msg.prefix, ts: Date.now(), type: "hedra" };
      info("[BG] Hedra onMessage:", pendingRename);
      sendResponse?.({ ok: true });
      return true;
    }
    if (typeof msg.filename === "string") {
      pendingRename = { filename: msg.filename, ts: Date.now(), type: "clipchamp" };
      info("[BG] Clipchamp onMessage:", pendingRename);
      sendResponse?.({ ok: true });
      return true;
    }
    if (typeof msg.fn === "string") {
      pendingRename = { filename: msg.fn, ts: Date.now(), type: "vidnoz" };
      info("[BG] vidnoz onMessage:", pendingRename);
      sendResponse?.({ ok: true });
      return true;
    }
    if (typeof msg.prev === "string") {
      pendingRename = { prev: msg.prev, ts: Date.now(), type: "elevenlabs" };
      info("[BG] elevenlabs onMessage:", pendingRename);
      sendResponse?.({ ok: true });
      return true;
    }
  }

  if (msg?.action === "downloadUrl" && typeof msg.url === "string" && typeof msg.filename === "string") {
    info("[BG] downloadUrl onMessage:", pendingRename);
    chrome.downloads.download(
      { url: msg.url, filename: msg.filename, saveAs: false },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          warn("[BG] downloadUrl 失败：", chrome.runtime.lastError.message);
          sendResponse?.({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          info("[BG] 已启动下载：", downloadId, msg.filename);
          sendResponse?.({ ok: true, id: downloadId });
        }
      }
    );
    return true;
  }

  // 新增：Storage 转发
  if (msg?.action === "storageGet") {
    chrome.storage.local.get(msg.keys, res => {
      sendResponse(res || {});
    });
    return true; // 异步响应
  }

  if (msg?.action === "storageSet") {
    chrome.storage.local.set(msg.data, () => {
      sendResponse({ ok: !chrome.runtime.lastError });
    });
    return true;
  }

  sendResponse?.({ ok: false, error: "unknown action" });
  return false;
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  // info("[BG] 捕捉到下载:", item);
  try {
    const now = Date.now();
    // const inWindow = pendingRename && (now - pendingRename.ts) <= MATCH_MS;
    if (!pendingRename) {
      suggest();
      debug("[BG] 改名失败: pendingRename =>", pendingRename, 'now - pendingRename.ts =', now - pendingRename?.ts, now, pendingRename?.ts);
      return;
    }

    if (pendingRename.type === "hedra") {
      const isZip = (item.filename || "").toLowerCase().endsWith(".zip");
      const looksLikeHedra = /hedra_assets_|hedra-api-audio|hedra\.com/i.test(item.url || item.finalUrl || item.filename || "");
      if (!(isZip || looksLikeHedra)) { info("[BG] Hedra 下载改名失败:", item.filename, item.url, item.finalUrl);
        suggest();
        return;
      }
      const prefix = pendingRename.prefix || "";
      const newName = `${prefix} ${item.filename}`.trim();
      suggest({ filename: newName });
      info("[BG] Hedra 下载改名:", item.filename, "=>", newName);
      pendingRename = null;
      return;
    }

    if (pendingRename.type === "clipchamp") {
      const urlIsClipchamp = /:\/\/.*\.?clipchamp\.com\//i.test(item.url || "");
      const nameLooksClipchamp = /使用Clipchamp制作/.test(item.filename || "") || /使用Clipchamp制作/.test(item.finalUrl || "");
      const looksLikeTarget = urlIsClipchamp || nameLooksClipchamp;
      if (!looksLikeTarget) {
        suggest();
        return;
      }
      const newName = pendingRename.filename;
      suggest({ filename: newName });
      info("[BG] Clipchamp 下载改名:", item.filename, "=>", newName);
      pendingRename = null;
      return;
    }

    if (pendingRename.type === "vidnoz") {
      const urlIsClipchamp = /:\/\/.*\.?vidnoz\.com\//i.test(item.url || "");
      const looksLikeTarget = urlIsClipchamp;
      if (!looksLikeTarget) {
        suggest();
        return;
      }
      const newName = pendingRename.filename;
      suggest({ filename: newName });
      info("[BG] vidnoz 下载改名:", item.filename, "=>", newName);
      pendingRename = null;
      return;
    }
    
    if (pendingRename.type === "elevenlabs") {
      const urlIsClipchamp = /:\/\/.*\.?elevenlabs\.io\//i.test(item.url || "");
      const looksLikeTarget = urlIsClipchamp;
      if (!looksLikeTarget) {
        suggest();
        return;
      }
      const prev = pendingRename.prev;
      const newName = `${prev} ${item.filename.replace(/_pvc_.*(?=\.[^.]+$)/, '')}`.trim();
      suggest({ filename: newName });
      info("[BG] elevenlabs 下载改名:", item.filename, "=>", newName);
      pendingRename = null;
      return;
    }

    suggest();
  } catch (e) {
    suggest();
    error("[BG] onDeterminingFilename 异常:", e);
  }
});
