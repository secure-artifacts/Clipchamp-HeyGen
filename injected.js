(function () {
  const LOG_PREFIX = "[HeyGen助手·inject]";

  function getTimeStr() {
    const now = new Date();
    const pad = (n, len = 2) => n.toString().padStart(len, '0');
    const h = pad(now.getHours());
    const m = pad(now.getMinutes());
    const s = pad(now.getSeconds());
    const ms = pad(now.getMilliseconds(), 3);
    return `${h}:${m}:${s}.${ms}`;
  }

  function debug(...args) { console.debug(`${getTimeStr()}`, LOG_PREFIX, ...args); }
  function info(...args) { console.info(`${getTimeStr()}`, LOG_PREFIX, ...args); }
  function warn(...args) { console.warn(`${getTimeStr()}`, LOG_PREFIX, ...args); }
  function error(...args) { console.error(`${getTimeStr()}`, LOG_PREFIX, ...args); }
  const seenUrls = new Set(); // ✅ 用于去重

  // =========================
  // 🎯 工具：统一提取 mp4
  // =========================
  function extractHeygenUrl(text) {
    if (!text) return null;

    const match = text.match(/https:\/\/resource\d*\.heygen\.ai\/[^\s"'\\]+_nocap\.mp4[^\s"'\\]*/i);
    if (!match) return null;

    const original = match[0];
    const fixed = original.replace("_nocap.mp4", ".mp4").replace("_720p.mp4%3B", "_cap.mp4%3B");

    return { original, fixed };
  }

  function notify(url, original) {
    if (seenUrls.has(url)) return; // ✅ 如果已经处理过就跳过
    seenUrls.add(url);
    info("🎯 捕获下载:", url);

    window.postMessage({
      source: "hedra-injected",
      type: "heygenDownload",
      url,
      original
    }, "*");
  }

  const ORIGINAL_FETCH = window.fetch;  // 🔒 原始 fetch 固定引用
  let audioId = null;

  async function customFetch(...args) {
    const res = await ORIGINAL_FETCH.apply(this, args);

   // 🚀 不 await
   const clone = res.clone();

   clone.text().then(text => {
     try {
       // const result = extractHeygenUrl(text);
       // if (result) notify(result.fixed, result.original);

       const json = JSON.parse(text);
   
       if (json?.asset?.type === "uploaded_audio") {
         audioId = json.id;
       }
   
       if (["text_to_speech", "speech_to_speech"].includes(json?.type) && json.asset_id) {
         audioId = json.asset_id;
       }
   
       if (json?.asset?.type === "uploaded_image" && audioId) {
         window.postMessage({
           source: "hedra-injected",
           type: "saveAudioId",
           audioId
         }, "*");
         audioId = null;
       }
   
     } catch (e) {}
   });
   
   // ✅ 立即返回原 response（不阻塞）
    return res;
  }

  // ✅ 加标记：用于防检测
  customFetch.__hedra_hooked__ = true;

  function hookFetch() {
    window.fetch = customFetch;
    debug("✅ fetch 已挂钩");
  }

  // =========================
  // ✅ XHR Hook - HeyGen
  // =========================
  
  const origClick = HTMLAnchorElement.prototype.click;

  HTMLAnchorElement.prototype.click = function () {
    try {
      const url = this.href || "";
      let parts = url.split('/');
      // info("🎯 parts[parts.length - 2]:", parts[parts.length - 2]); // 假设 UUID 总是在倒数第二个部分

      if (
        url.includes("resource")  &&
        url.includes("heygen.ai") &&
        url.endsWith("p.mp4%3B")  &&
        !parts[parts.length - 2].includes("-")
      ) {
        const fixed = url.replace("_nocap.mp4", ".mp4").replace("_720p.mp4%3B", "_cap.mp4%3B");

        info("🎯 捕获下载:", url);

        window.postMessage({
          source: "hedra-injected",
          type: "heygenDownload",
          url: fixed
        }, "*");

        // ⛔ 阻止默认下载
        return;
      }
    } catch (e) {}

    return origClick.apply(this, arguments);
  };

  // debug("✅ XHR hooked");

  // ✅ 监控挂钩是否仍在
  (function monitorHook() {
    const check = () => {
      if (!window.fetch?.__hedra_hooked__) {
        warn("⚠️ fetch hook 被替换，尝试重新挂钩");
        hookFetch(); // 尝试重新挂钩
      }
    };
    setInterval(check, 10000); // 每 10 秒检查一次
  })();

  // 初始挂钩
  hookFetch();
})();