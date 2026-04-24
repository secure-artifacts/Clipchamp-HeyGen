(function () { // content.js 注入 injected.js
/*
注：内容脚本的职责：把 injected.js 注入页面（外链方式避开 CSP），监听 window.postMessage 来自 injected.js 的事件，做简单的验证，然后转发到后台 chrome.runtime.sendMessage。同时在 content 控制台打印以便调试。
这样注入的脚本是从扩展的 chrome-extension:// URL 加载的，属于“外部资源”，不会触发目标页面的 CSP inline-script 限制。 Content Security Policy
但是扩展有一个“后门”：

content script 不受页面 CSP 限制（它属于扩展环境注入的 JS，和 inline script 不一样）。

但是 content script 不能直接劫持 info，因为它跑在 隔离环境 (isolated world)。

解决办法就是：

扩展在 content script 里插入一个物理的 <script src="..."> 标签，但注意：

不能写内联代码，而是写成外部文件（src=chrome.runtime.getURL("injected.js")）。

这样不会触发 CSP，因为 CSP 允许扩展协议的脚本。

injected.js 才能跑在页面环境，劫持 info
*/
  // 和 manifest.json 的 web_accessible_resources.matches 保持一致
const allowedPatterns = [
  /^https:\/\/www.hedra\.com\//,
  /^https:\/\/app.heygen\.com\//
];

/******************** 全局 部分 ********************/  
const LOG_PREFIX = "[HeyGen助手·CS]";
const MAP_KEY = "hedra_audio_map";
const RETENTION_MS = 3 * 24 * 3600 * 1000;

  function nowTs(){ return Date.now(); }
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


// https://labs.google/fx/tools/whisk
if (/^https:\/\/labs\.google\/fx\/zh\/tools\/whisk\//.test(location.href)) {
  const script2 = document.createElement("script");
  script2.src = chrome.runtime.getURL("image_downloader.js");
  script2.onload = function(){ this.remove(); };
  (document.head || document.documentElement).appendChild(script2);
  debug("[image_downloader] 已注入 image_downloader.js");
}

/***** safe wrappers for Chrome APIs *****/
function storageAvailable() { return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local; }
function safeGet(keys, cb) {
  try { if (!storageAvailable()) { cb && cb({}); return; }
    chrome.storage.local.get(keys, (res) => cb && cb(res || {}));
  } catch { cb && cb({}); }
}
function safeSet(obj, cb) {
  try { if (!storageAvailable()) { cb && cb(); return; }
    chrome.storage.local.set(obj, cb);
  } catch { cb && cb(); }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function safeGetWithRetry(keys, cb, maxRetries = 3, delayMs = 500) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "storageGet", keys }, resolve);
      });
      cb && cb(result || {}); // 成功时回调
      return;
    } catch (e) {
      warn(`[safeGetWithRetry] 尝试 ${attempt} 失败:`, e);
      lastError = e;
      if (attempt < maxRetries) await delay(delayMs);
    }
  }
  // cb && cb({}); // 最后失败回调空对象
  error("[safeGetWithRetry] 最终失败:", lastError);
  cb && cb({ __failed: true }); // 失败时回调特殊标志
}

async function safeSetWithRetry(obj, cb, maxRetries = 3, delayMs = 500) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "storageSet", data: obj }, resolve);
      });
      if (result?.ok) break; // 成功就退出重试
    } catch (e) {
      warn(`[safeSetWithRetry] 尝试 ${attempt} 失败:`, e);
      if (attempt < maxRetries) await delay(delayMs);
    }
  }
  cb && cb();
}

/***** safe MutationObserver *****/
function safeObserve(callback) {
  const start = () => {
    try {
      const target = document.body;
      if (target instanceof Node) {
        new MutationObserver(callback).observe(target, { childList: true, subtree: true });
        callback(); // 初始执行一次
      }
    } catch (e) { warn("[safeObserve] 异常:", e); }
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else { start(); }
}

function utf8Slice(str, maxBytes) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let bytes = [];
  let total = 0;

  for (const char of str) {
    const encoded = encoder.encode(char);
    if (total + encoded.length > maxBytes) break;
    bytes.push(...encoded);
    total += encoded.length;
  }

  return decoder.decode(new Uint8Array(bytes));
}


function sanitizeForFilename(s) {
  if (!s) return "";
  return String(s).replace(/[\u0000-\u001F]/g, "")
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    // .slice(0, 180).trimEnd();
}

/***** 最近一次上传文件名 *****/
let lastAudioUploadName = "", lastImageUploadName = "";

// ==========================
// ✅ 全局变量：用于临时保存稳定性 & 速度
// ==========================
let latestStability = characterName = latestSpeed = '';

// ==========================
// ✅ 提取所有输入（语言、声音、文本、稳定性、速度）
// ==========================
function getAllInputsH() {
  try {
    // === [1] 获取语言 ===
    const langBtn = [...document.querySelectorAll('button')]
      .find(btn => btn.querySelector('svg.lucide-languages'));
    const lang = langBtn?.querySelector('span.text-zinc-400')?.textContent || '';
    // info("🌐 语言:", lang);

    // === [2] 获取声音 ===
    const voiceBtn = [...document.querySelectorAll('button')]
      .find(btn => btn.querySelector('svg.lucide-mic-vocal'));
    const voice = voiceBtn?.querySelector('span.text-zinc-400')?.textContent || '';
    // info("🎤 声音:", voice);

    // === [3] 获取文本 ===
    const textarea = document.querySelector('textarea[data-testid="script-prompt-input"]');
    const text = textarea?.value.trim() || '';
    // info("📝 文本:", text);

    // === [4] 稳定性 ===
    let stability = (latestStability ? Math.floor(parseFloat(latestStability) * 100) : 50) + '%';
    // info("🛡 最终稳定性:", stability);

    // === [5] 速度（使用全局最新值） === 
    let speed = latestSpeed || '1'; 
    // info("⏩ 最终速度:", speed);

    const inputs = [lang, voice, stability, speed, text];
    // info("✅ 所有输入值:", inputs);
    return inputs;

  } catch (err) {
    error("❌ 获取输入失败:", err);
    return [];
  }
}

// ==========================
// ==========================
// ✅ 按钮监听器（Add to video + 第3/6个按钮）
// ==========================

const buttonObserver = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    mutation.addedNodes.forEach((node) => {
      if (!(node instanceof HTMLElement)) return;

      // ========== 🎯 1. 处理 Add to video 按钮 ==========
      handleAddToVideoButton(node);

      // ========== 🎯 2. 处理第3和第6个下载按钮 ==========
      handleGridButtons(node);
      handleHstackButtons(node);// ✅ 3. hstack class 的按钮（如“分享”按钮）
    });
  });
});

buttonObserver.observe(document.body, {
  childList: true,
  subtree: true,
});

// ========== 封装函数 ==========

// 🎯 自动监听并绑定两个下载按钮
function handleGridButtons(node) {
  const grid = node.matches?.('div.grid.gap-4') ? node : node.querySelector?.('div.grid.gap-4');
  if (!grid) return;

  let targetIndexes = [2, 5]; // 第3和第6个按钮（索引从0开始）
  // const labels = ['①', '②'];
  const prefixNums = ['-1', '-2'];

  function bindButtons() {
    const buttons = grid.querySelectorAll('button');
    if (buttons.length === 6) targetIndexes = [2, 5];
    else if (buttons.length === 4 && buttons[1]?.querySelector?.('svg.w-4.h-4')) targetIndexes = [1, 3];
    else return false;

    buttons.forEach((btn, index) => {
      if (targetIndexes.includes(index) && btn.dataset._vidBound !== "1") {
        btn.dataset._vidBound = "1";

        const idx = targetIndexes.indexOf(index);
        // const label = labels[idx];
        const prefix = prefixNums[idx];

        btn.addEventListener('click', () => {
          chrome.runtime.sendMessage({ action: "ping" });

          const inputs = getAllInputsE();
          if (inputs.length) inputs.splice(inputs.length - 1, 0, prefix);

          const prev = utf8Slice(sanitizeForFilename(inputs.join(" ")), 90);
          chrome.runtime.sendMessage({ action: "prepareRename", prev: prev });
        });

        debug(`📌 第 ${index + 1} 个按钮已绑定`);
      }
    });

    return true;
  }

  // ✅ 初次尝试绑定
  if (bindButtons()) return;

  // ✅ 使用 MutationObserver 自动监听按钮变化
  const observer = new MutationObserver(() => {
    const success = bindButtons();
    if (success) {
      debug("✅ 两个按钮绑定完成，停止监听");
      observer.disconnect();
    }
  });

  // ✅ 监听 grid 下所有 DOM 子树的变化
  observer.observe(grid, {
    childList: true,
    subtree: true,
  });
}

// ✅ 🎯 处理 class 为 hstack... 的按钮（如“分享”）
function handleHstackButtons(node) {
   const download_btn = node.matches?.('div.hstack.items-center.justify-end.gap-1.md\\:gap-2.basis-1\\/4 > button') ? node : '';
  // const btn = grid.querySelector('button');
   const btn_latest = document.querySelector('svg.w-\\[18px\\].h-\\[18px\\].w-3\\.5.h-3\\.5')?.closest('button');
   const btn = download_btn || btn_latest;
  if (btn) {
    if (btn.dataset._vidBound === "1") return;
    btn.dataset._vidBound = "1";

    btn.addEventListener('click', () => {
      try {
        const inputs = getAllInputsE(); // 可根据按钮类型替换为 getAllInputsH() 等
        if (inputs.length) {
          // const extraLabel = btn.textContent.trim() || "Unnamed";
          // inputs.push(`-${extraLabel}`);
          const prev = utf8Slice(sanitizeForFilename(inputs.join(" ")), 90) + ' ';
          chrome.runtime.sendMessage({ action: "prepareRename", prev: prev }, (res) => {
            // debug("[content] prepareRename (hstack) 已发送", res?.__failed ? "(storage 获取失败)" : "");
          });
          // info("📌 [hstack] 按钮已点击绑定:", extraLabel);
        }
      } catch (err) {
        error("❌ [hstack button] 异常:", err);
      }
    });

    // info("📌 已绑定 hstack 按钮:", btn.textContent.trim());
  }
}
// info("👀 已启动 MutationObserver，自动绑定按钮点击事件...");



/******************** Clipchamp 部分 ********************/
function generateFilename(values){
  try {
    const title = document.querySelector('input[data-testid="text-input"]')?.value || "";
    let base = (title ? title + ' ' : '') + 'Clipchamp制作 ';
    if (values?.length) base += values.join(" ");
    base = base.replace(".mp4","").replace(/[<>:"/\\|?*\x00-\x1F]/g,"").replace(/\s+/g," ").trim();
    if (base.length>130) base = base.slice(0,130).trimEnd();
    const timestamp = new Date().toTimeString().slice(0,8).replace(/:/g,'');
    return `${base} ${timestamp}`;
  } catch (e){ error("[generateFilename] 异常:", e); return "Clipchamp"; }
}

function getClipchampValues(){
  try {
    return [
      document.querySelector('input[data-testid="language-dropdown"]')?.value?.charAt(0) || "",
      document.querySelector('input[data-testid="voice-dropdown"]')?.value || "",
      document.querySelector('button[data-testid="voice-emotion-dropdown"]')?.value || "",
      document.querySelector('button[data-testid="voice-pitch-dropdown"]')?.value || "",
      document.querySelector('input[data-testid="voice-pace-slider"]')?.getAttribute("aria-valuenow") || "",
      document.querySelector('span[data-lexical-text="true"]')?.innerText || document.querySelector('textarea[data-testid="voice-script-textarea"]')?.value || ""
    ];
  } catch { return []; }
}

async function fallbackRedownloadAsBlob(newName){
  try {
    const a = document.querySelector("a[download]");
    if (!a?.href?.startsWith("blob:")) return false;
    const res = await fetch(a.href); const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href=url; link.download=newName;
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    return true;
  } catch { return false; }
}

function bindClipchampDownload(){
  try {
    const container = document.querySelector('div[data-tabster=\'{"mover":{"cyclic":false,"direction":1,"memorizeCurrent":true}}\']');
    if (container) {
      const btns = container?.querySelectorAll('div[role="menuitem"]');
      btns.forEach(btn=>{
        if(btn.dataset._ccBound==="1") return; btn.dataset._ccBound="1";
        btn.addEventListener("click", async ev=>{
          chrome.runtime.sendMessage({ action: "ping" }, () => { // 只是为了唤醒 background
            debug("[Clipchamp] background 已尝试唤醒");
          });
          try {
            const values = getClipchampValues();
            const finalName = utf8Slice(generateFilename(values), 150) + '.m';
            chrome.runtime.sendMessage({ action:"prepareRename", filename:finalName });
            const a = document.querySelector("a[download]");
            if(a?.href?.startsWith("blob:")) { ev.preventDefault(); ev.stopImmediatePropagation(); await fallbackRedownloadAsBlob(finalName);}
          } catch(e){ error("[bindClipchampDownload.click] 异常:", e); }
        }, { capture:true });
      });
    }
  } catch(e){ error("[bindClipchampDownload] 异常:", e); }
}

safeObserve(bindClipchampDownload);

/******************** Vidnoz AI Voice 部分（纯原生JS版） ********************/
function getSpeechText() {
  try {
    const el = document.querySelector(".speech-textarea");
    if (!el) return "";

    // 克隆一份 DOM，移除所有 pause-button-box
    const clone = el.cloneNode(true);
    clone.querySelectorAll(".pause-button-box").forEach(span => span.remove());

    return clone.innerText.trim();
  } catch (e) {
    error("[getSpeechText] 異常:", e);
    return "";
  }
}

function getVidnozValues() {
  try {
    const rawLang = document.querySelector(".country-lang")?.innerText || "";
    const match = rawLang.match(/\(([^)]+)\)/);  
    const lang = match ? match[1] : rawLang;  // 如果有括号取括号里的，否则用原文

    const voice = document.querySelector(".lang-type")?.innerText || "";

    let speed = "", pitch = "";

    // 遍历所有 div.option 找出語速/音高
    document.querySelectorAll("div.option").forEach(opt => {
      const label = opt.querySelector("label")?.innerText;
      if (!label) return;
      if (label.includes("語速")) {
        speed = opt.querySelector(".value")?.innerText || "";
      } else if (label.includes("音高")) {
        pitch = opt.querySelector(".value")?.innerText?.slice(0, -1) || "";
      }
    });

    const textArea = getSpeechText(); // 用过滤版

    // ✅ 获取年龄选项的第一个字符（如“青年” → “青”）
    const ageText = document.querySelector(".filter-age .filter-option-text")?.innerText.trim() || "";
    const ageChar = ageText.charAt(0);

    return [(document.querySelector(".file-name-text")?.innerText?.slice(0,5).trim() || "") + " vidnoz", lang, ageChar, voice, speed, pitch, textArea];
  } catch (e) {
    error("[getVidnozValues] 異常:", e);
    return [];
  }
}

function bindVidnozDownload() {
  try {
    const btns = document.querySelectorAll("button.confirm");
    btns.forEach(btn => {
      if (btn.dataset._vidBound === "1") return;
      btn.dataset._vidBound = "1";

      btn.addEventListener("click", async ev => {
        chrome.runtime.sendMessage({ action: "ping" }, () => { // 只是为了唤醒 background
          // debug("[Vidnoz] background 已尝试唤醒");
        });
        try {
          const values = getVidnozValues();
          const finalName = utf8Slice(generateFilename(values).slice(12), 150) + '.wav';

          debug("[Vidnoz] 准备写入文件名:", finalName);
          chrome.runtime.sendMessage({ action: "prepareRename", fn: finalName });

          // 如果下载链接是 blob:，尝试兜底处理
          const a = document.querySelector("a[download]");
          if (a?.href?.startsWith("blob:")) {
            ev.preventDefault();
            ev.stopImmediatePropagation();
            if (typeof fallbackRedownloadAsBlob === "function") {
              await fallbackRedownloadAsBlob(finalName);
            }
          }
        } catch (e) {
          error("[bindVidnozDownload.click] 异常:", e);
        }
      }, { capture: true });
    });
  } catch (e) {
    error("[bindVidnozDownload] 异常:", e);
  }
}
safeObserve(bindVidnozDownload);

/******************** elevenlabs.io ********************/
function getAllInputsE() {
  try {
    const container = document.querySelector('div.stack.gap-6.pb-4');
    if (!container) {
      // info("❌ 容器未找到");
      return [];
    }

    const fontContents = [];
    const allFonts = container.querySelectorAll('font');
    allFonts.forEach(font => {
      const parent = font.parentElement;
      const grandparent = parent?.parentElement;
      if (parent?.tagName === 'FONT' && grandparent?.tagName === 'SPAN') {
        let text = font.textContent.trim();
        if (fontContents.length === 1) {
            // info(fontContents);
          text = text.replace(/\(.*?\)|（.*?）/g, '').trim();
        }
        fontContents.push(text);
      }
    });

    function hasPureText(el) {
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 0) return true;
      }
      return false;
    }

    function getTextWithBacktrace(span) {
      let current = span;
      while (current) {
        if (current.tagName?.toLowerCase() === 'span' && hasPureText(current)) {
          return current.textContent.trim();
        }
        current = current.parentElement;
        if (!current || current === container) break;
      }
      return '';
    }

    if (fontContents.length < 2) {
      const spans = [...container.querySelectorAll('span')].filter(s => !s.querySelector('span'));
      const spanTexts = spans.map(s => hasPureText(s) ? s.textContent.trim() : getTextWithBacktrace(s)).filter(t => t.length > 0);
      for (let i = fontContents.length; i < 2 && i < spanTexts.length; i++) {
        let text = spanTexts[i];
        if (fontContents.length === 1) {
            // info(fontContents);
          text = text.replace(/\(.*?\)|（.*?）/g, '').trim();
        }
        fontContents.push(text);
      }
    }

    let text = '';
    const deepDiv = document.querySelector('div[data-testid="tts-editor"] > div > div');
    if (deepDiv) text = deepDiv.textContent.trim();
    else text = document.querySelector("textarea[data-testid='tts-editor']")?.value || ''
    text = text.replace(/\[.*?\]/g, '').trim(); // 删除方括号中的内容
    text = text.replace(/…/g, ''); // 替换所有的省略号
    let specialWords = ['Maria', 'Fatima', 'Lourdes', 'Michele', 'Gesù', 'Guadalupe'];
    let foundWords = specialWords.filter(word => text.includes(word));

    // if (foundWords.length > 0) {
      // // 将找到的词放到开头，并去除重复的词
      // // text = foundWords.join(' ') + ' ' + text.replace(new RegExp(foundWords.join('|'), 'g'), '').trim();
      // text = foundWords.join(' ') + ' ' + text.trim();
    // }

    // 判断如果包含 'Maria' 以外的其他特殊词时，不把 Maria 加到前面
    if (foundWords.length > 0) {
      if (text.includes('Maria') && foundWords.length > 1) {  // 如果包含 'Maria'，则从 foundWords 中移除 'Maria'
        foundWords = foundWords.filter(word => word !== 'Maria');
      }

      // 将找到的词放到开头
      text = foundWords.join(' ') + ' ' + text.trim();
    }

    const sliders = Array.from(container.querySelectorAll('span[role="slider"][aria-valuenow]')).slice(0, 4);
    const sliderValues = sliders.map((slider, idx) => slider.getAttribute('aria-valuenow') || '');

    // info('🌐 语言:', fontContents[0] || '');
    // info('🗣️ 声音:', fontContents[1] || '');
    // info('📝 文本:', text);
    // sliderValues.forEach((val, i) => info(`🎚️ Slider ${i + 1}: ${val}`));

    const inputs = [
      fontContents[0].slice(0, 10) || '',
      fontContents[1] || '',
      sliderValues[0] || '',
      sliderValues[1] || '',
      sliderValues[2] || '',
      sliderValues[3] || '',
      text
    ];

    // info('🧩 所有输入值（完整）:', inputs);
    return inputs;

  } catch (err) {
    error("❌ 获取输入失败:", err);
    return [];
  }
}

/******************** 布局修正 部分 ********************/
function patchLayout(){
  try { // 在使用 document.querySelector() 选择带有 Tailwind CSS 特殊字符（如中括号、冒号、反斜杠等）的类名时，是需要转义的。CSS 选择器
    let container = document.querySelector('div.bg-zinc-950.border-t-2.border-zinc-900.flex-col.flex.max-w-\\[856px\\].md\\:bg-transparent.md\\:border-t-0.mx-auto.w-full');
    if(container){ // 提示词 prompt
      // container.className="bg-zinc-950.border-t-2.border-zinc-900.flex-col.flex.md\\:bg-transparent.md\\:border-t-0.mx-auto.w-full";
      container.classList.remove("max-w-[856px]");
      container.setAttribute("style","margin-right:60px");
      const innerDiv = container.querySelector("textarea");
      if(innerDiv) innerDiv.setAttribute("style","height:120px; width:100%");
    }

    container = document.querySelector('div.cursor-auto.bg-zinc-950.p-md.rounded-md.border-zinc-900.border.flex.flex-col.gap-2.transition-all.delay-0.duration-300.ease-in-out.relative.w-\\[80vh\\].h-\\[80vh\\]');
    if(container){ // 音频
      container.classList.remove("w-[80vh]", "p-md");
      container.setAttribute("style","width:98%");
      let innerDiv = container.parentElement; if(innerDiv) innerDiv.classList.remove("items-center");
      innerDiv = container.querySelector("div.w-full.h-px.my-4.mx-0.bg-zinc-900"); if(innerDiv) innerDiv.setAttribute("style","margin:0");
      innerDiv = container.querySelector("div.audio-mirt-container.w-full.z-10.mb-5"); if(innerDiv) innerDiv.classList.remove("mb-5");
      innerDiv = container.querySelector("div.text-center.text-sm.text-zinc-400.mb-4"); if(innerDiv) innerDiv.classList.remove("mb-4");
      innerDiv = container.querySelector("div.flex.flex-row.items-center.gap-3.text-zinc-100.font-medium.pb-6"); if(innerDiv) innerDiv.classList.remove("pb-6");
      // innerDiv = container.querySelector("div.flex.flex-row.items-center.gap-3.text-zinc-100.font-medium.pb-6"); if(innerDiv) innerDiv.classList.remove("pb-6");
    }

    const innerDiv = document.querySelector('textarea[data-testid="voice-script-textarea"]');//info('textarea ✅ 绑定成功:', innerDiv.getAttribute("style"));
    if(innerDiv) innerDiv.style.padding = "0 2px"; // 文本框
    const thirdParent = innerDiv?.parentElement?.parentElement?.parentElement;
    if(thirdParent) thirdParent.style.padding = "0 2px 12px";

    container = document.querySelector('li.bg-landing-grays-02.px-6.py-5.rounded-xl.max-w-sm.border-none');
    if(container) container.style.display = "none"; // 音频弹出框


  } catch(e){ error("[patchLayout] 异常:", e); }
}
safeObserve(patchLayout);


let fontSize = 16;
let label;

// 创建浮动标签
function createLabel() {
  label = document.createElement('div');
  Object.assign(label.style, {
    position: 'absolute',
    background: 'rgba(0, 0, 0, 0.7)',
    color: 'white',
    padding: '2px 6px',
    borderRadius: '4px',
    fontSize: '12px',
    zIndex: '9999',
    pointerEvents: 'none',
    display: 'none',
  });
  label.textContent = `字体大小: ${fontSize}px`;
  document.body.appendChild(label);
}

function showLabel(fontSize, x, y) {
  label.textContent = `字体大小: ${fontSize}px`;
  label.style.left = `${x + 10}px`;
  label.style.top = `${y + 10}px`;
  label.style.display = 'block';

  clearTimeout(label._hideTimer);
  label._hideTimer = setTimeout(() => {
    label.style.display = 'none';
  }, 1000);
}

// 应用于 textarea 的逻辑
function setupTextareaZoom(textarea) {
  if (textarea._zoomBound) return;
  textarea._zoomBound = true;

  fontSize = parseInt(window.getComputedStyle(textarea).fontSize) || 14;
  // info('[ZoomTextarea] ✅ 绑定成功:', textarea);

  // 全局滚轮监听
  document.addEventListener('wheel', function (e) {
    if (!e.ctrlKey) return;

    const hoveredElem = document.elementFromPoint(e.clientX, e.clientY);
    if (hoveredElem !== textarea) return;

    e.preventDefault();

    if (e.deltaY < 0) {
      fontSize = Math.min(fontSize + 1, 48);
      // info(`[ZoomTextarea] ➕ 放大到: ${fontSize}px`);
    } else {
      fontSize = Math.max(fontSize - 1, 8);
      // info(`[ZoomTextarea] ➖ 缩小到: ${fontSize}px`);
    }

    textarea.style.fontSize = `${fontSize}px`;
    showLabel(fontSize, e.pageX, e.pageY);
  }, { passive: false });// ✅ 关键：告诉浏览器我们可能会调用 preventDefault

  // Ctrl + 0 重置
  let mouseX = 0, mouseY = 0;
  document.addEventListener('mousemove', e => {
    mouseX = e.clientX;
    mouseY = e.clientY;
  });

  window.addEventListener('keydown', function(e) {
    if (e.ctrlKey && e.key === '0') {
      const hoveredElem = document.elementFromPoint(mouseX, mouseY);
      if (hoveredElem && hoveredElem.matches && hoveredElem.matches('textarea[data-testid="voice-script-textarea"]')) {
        e.preventDefault();
        // info('Ctrl+0 重置字体大小');
        hoveredElem.style.fontSize = '14px'; // 你重置大小的代码
      }
    }
  }, { passive: false });

}

/***** 启动监听：等待 textarea 出现 *****/
createLabel();

safeObserve(() => {
  const textarea = document.querySelector('textarea[data-testid="voice-script-textarea"]');
  if (textarea) setupTextareaZoom(textarea);
});

/******************** Hedra 部分 ********************/

// 🎯 处理 "Add to video" 按钮
function handleAddToVideoButton(node) {
  const addBtn = node.querySelector?.('button svg.lucide-circle-alert.mr-1\\.5')?.closest('button');

  if (addBtn && addBtn.dataset._vidBound !== "1") {
    addBtn.dataset._vidBound = "1";

    addBtn.addEventListener('click', () => {
      try {
        const inputs = getAllInputsH();
        if (inputs.length > 0 && inputs[0] && inputs[1] && inputs[2] ) {
          lastAudioUploadName = generateFilename(inputs).slice(12);
          debug("🎯 已生成 lastAudioUploadName:", lastAudioUploadName);
        }
      } catch (err) {
        error("❌ [AddToVideo] 异常:", err);
      }
    });

    // info("📌 绑定了 Add to video 按钮");
  }
}

if (allowedPatterns.some(re => re.test(location.href))) {

  function audioIdFromSrc(src){
    if (!src) return null;
    const q = src.indexOf("?");
    const path = q >= 0 ? src.slice(0, q) : src;
    try {
      const url = new URL(path, location.href);
      const parts = url.pathname.split("/").filter(Boolean);
      if (!parts.length) return null;
      return parts[parts.length - 1].split(".")[0] || null;
    } catch {
      const parts = path.split("/").filter(Boolean);
      return (parts[parts.length - 1] || "").split(".")[0] || null;
    }
  }

  // 清理旧条目
  function cleanupOldEntries() {
    safeGet([MAP_KEY], (res) => {
      const map = (res && res[MAP_KEY]) ? res[MAP_KEY] : {};
      const cutoff = nowTs() - RETENTION_MS;
      let removed = 0;
      for (const k of Object.keys(map)) {
        const e = map[k];
        if (!e || (e.ts && e.ts < cutoff)) {
          delete map[k];
          removed++;
        }
      }
      if (removed > 0) {
        safeSet({ [MAP_KEY]: map }, () => {
          info(`[cleanup] 删除 ${removed} 条超过 ${RETENTION_MS}ms 的旧条目`);
        });
      } //else {
        // debug("[cleanup] 无需清理");
      // }
    });
  }
  setTimeout(cleanupOldEntries, 2000); // 启动时清理一次

  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("injected.js");
  script.onload = function(){ this.remove(); }; // 注入后移除标签（脚本已加载并执行）
  (document.head || document.documentElement).appendChild(script);
  debug("[ConsoleHook] 已注入 injected.js 到:", location.href);

  document.addEventListener("change", (ev) => {
    try {
      const t = ev.target;
      if (t?.tagName !== "INPUT" || t.type !== "file" || t.className !== "hidden") return;
      const file = t.files?.[0]; if (!file) return;
      if (/\.(mp3|m4a|wav|aac|mp4)$/i.test(file.name)) {
        characterName = '';
        lastAudioUploadName = file.name;
        info("[upload] 捕获音频:", lastAudioUploadName);
      } else if (/\.(png|jpe?g|gif|webp)$/i.test(file.name)) {
        lastImageUploadName = file.name; //info("[upload] 捕获图片:", lastImageUploadName);
      }
    } catch (e){ error("[upload] 异常:", e); }
  }, true);

  document.addEventListener("click", (ev) => {
    try {
      let btn = ev.target.closest?.("button");
      // if (!btn?.querySelector?.("svg.lucide-download")) return;
      if (btn?.querySelector?.("svg.lucide-download")) { //return;   /***** 下载点击改名 *****/
        chrome.runtime.sendMessage({ action: "ping" }, () => { // 只是为了唤醒 background
          // debug("[Hedra] background 已尝试唤醒");
        });

        let anc = btn, foundAudio = null;
        for (let i = 0; i < 8 && anc; i++) {
          const aud = anc.querySelector?.("audio[src]");
          if (aud) { foundAudio = aud; break; }
          anc = anc.parentElement;
        }
        if (!foundAudio) return;
        
        const audioId = audioIdFromSrc(foundAudio.src);
        if (!audioId) return;

        safeGetWithRetry([MAP_KEY], (res) => {
          const map = (res && res[MAP_KEY]) ? res[MAP_KEY] : {};
          const entry = map[audioId] || {};
          let prefix = '';
        
          if (entry && typeof entry.ts === 'number') {
            const audioName = entry.aud || '';
            const imageName = entry.img || '';
            const hhmmss = new Date(entry.ts).toTimeString().slice(0, 8).replace(/:/g, '');
            prefix = utf8Slice(sanitizeForFilename(`${audioName} ${imageName}`), 199) + ' ' + hhmmss;
          } else prefix = new Date().toTimeString().slice(0,8).replace(/:/g, '');
        
          chrome.runtime.sendMessage({ action: "prepareRename", prefix:prefix }, () => { // 转发给 background（可以在后台做持久化/通知/其它逻辑）
            debug("[content] prepareRename 已发送", res.__failed ? "(storage 获取失败)" : "");
          });
        });
      }

      if (btn?.querySelector?.('svg.lucide-circle-check.w-5')) {
        const container = document.querySelector('div[data-testid="audio-clip-container"]');
        if (container) {
          const characterBtn = container.querySelector('button svg.lucide-chevrons-up-down')?.closest('button');
          const nameSpan = characterBtn?.querySelector('span.text-zinc-100');
          characterName = nameSpan?.textContent || '';
          if (characterName === 'Choose voice') characterName = '';
          else if (characterName) characterName += ' ';
          // debug("👤 角色名称:", characterName);
        }
      }

    } catch (e) { error("[download-click] 异常:", e); }
  }, { capture: true });

  /******************** 接收 injected.js 消息 ********************/
  window.addEventListener("message", (event)=>{
    try { // 因为 injected.js 是跑在网站的 JS 上下文里，它没有 chrome.* API 的权限。所以它只能通过 window.postMessage → content → background 这条链路。
      if(event.source!==window) return;
      if(!event.data||event.data.source!=="hedra-injected") return; // 只接受我们自己注入脚本发过来的消息
      if(event.data.type==="saveAudioId" && event.data.audioId){

        safeGetWithRetry([MAP_KEY], (res)=>{
          const map = res[MAP_KEY]||{};
          map[event.data.audioId]={ aud:characterName + lastAudioUploadName, img:lastImageUploadName, ts:nowTs() };
          safeSetWithRetry({ [MAP_KEY]: map }, ()=>{
            safeGetWithRetry([MAP_KEY], (after)=> info("写入后 localStorage:", after[MAP_KEY]));
            // safeGet([MAP_KEY], (after) => 
                // info("[injected消息] 写入后 localStorage:", after[MAP_KEY])
                // null
            // );
          });
        });
      }

      if (event.data.type === "heygenDownload") {
        const { url } = event.data;

        let filename = "heygen_video.mp4";

        try {
          const u = new URL(url);
          const dispo = u.searchParams.get("response-content-disposition");
          if (dispo) {
            const match = decodeURIComponent(dispo).match(/filename\*?=UTF-8''(.+)/);
            if (match) filename = match[1];
          }
        } catch {}
        // info("📈 filename:", filename);
        // info("📈 url:", url);
        chrome.runtime.sendMessage({
          action: "downloadUrl",
          url,
          filename
        });

        info("✅ [Heygen] 已拦截并重新下载");

      }
    }    catch(e){ error("[message-event] 异常:", e); }
  });
  
  // ==========================
// ✅ 弹窗监听器：提取稳定性 & 速度（aria-valuenow）
// ==========================
  const dialogObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach(node => {
        if (!(node instanceof HTMLElement)) return;

        const dialog = node.querySelector?.('div[role="dialog"]') || (node.matches?.('div[role="dialog"]') ? node : null);
        if (!dialog) return;

        // debug("✅ 弹窗已打开，开始获取 slider 值...");
  
        const speedSlider = dialog.querySelector('span[role="slider"][aria-valuemin="0.7"]');
        const stabSlider = dialog.querySelector('span[role="slider"][aria-valuemin="0"]');
  
        if (speedSlider) {
          latestSpeed = speedSlider.getAttribute('aria-valuenow') || '';
          // info("🚀 初始速度:", latestSpeed);
          new MutationObserver((muts) => {
            muts.forEach(m => {
              if (m.attributeName === 'aria-valuenow') {
                latestSpeed = m.target.getAttribute('aria-valuenow') || '';
                // info("📈 速度变化:", latestSpeed);
              }
            });
          }).observe(speedSlider, { attributes: true });
        }

        if (stabSlider) {
          latestStability = stabSlider.getAttribute('aria-valuenow') || '';
          // info("🛡 初始稳定性:", latestStability);
          new MutationObserver((muts) => {
            muts.forEach(m => {
              if (m.attributeName === 'aria-valuenow') {
                latestStability = m.target.getAttribute('aria-valuenow') || '';
                // info("📉 稳定性变化:", latestStability);
              }
            });
          }).observe(stabSlider, { attributes: true });
        }
      });
    }
  });

  dialogObserver.observe(document.body, {
    childList: true,
    subtree: true
  });

// info("🚀 Hedra content.js 已启动（安全模式）");
}


/******************** www.facebook.com unmute video ********************/
if (/^https:\/\/www\.facebook\.com\//.test(location.href)) {
  // 匹配成功，执行逻辑
let video_volume = 0;
let first = click = false;
let mute = true;
let bg_pos = "0px -205px";  // 50%
let top_bg_pos = "0px -71px";  // 50%

function forceUnmute(video) {
  if (!video) return;

    // 设置音频状态
    video.muted = mute;
    video.volume = video_volume;
    
    // 防止重新静音
    video.addEventListener("volumechange", () => {
        // info("新视频出现 ","click=",click, "video.muted=", video.muted, video.volume, video_volume, 'mute=', mute);
      if (video.muted && !click) {
        // info("----被重新静音，恢复声音");
        video.muted = mute;
        video.volume = video_volume;

      logSpeakerIcon(); // 初始打印
      }
      
      if (click) {
          click = false;          
      }
    mute = video.muted;
    });

}

function logSpeakerIcon() {
      // 同步 UI：设置音量滑块属性
  const volumeSlider = document.querySelector('div[role="slider"].x1ypdohk.xng8ra');
   // 同步 UI：设置喇叭图标样式
  const valueBtn = document.querySelectorAll('div[role="button"].x1i10hfl.x1ejq31n.x18oe1m7.x1sy0etr.xstzfhl.x972fbf.x10w94by.x1qhh985.x14e42zd.x9f619.x3ct3a4.x16tdsg8.x1hl2dhg.xggy1nq.x1fmog5m.xu25z0z.x140muxe.xo1y3bh.x1n2onr6.x87ps6o.x1lku1pv.xjbqb8w.x76ihet.xtmcdsl.x112ta8.x4gj9lk.x1ypdohk.x1rg5ohu.x1qx5ct2.x1k70j0n.xbelrpt.xzueoph.xdzw4kq.x1iy03kw.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x1o7uuvo.x1a2a7pz');
  if (valueBtn && valueBtn[1]) {
   const speakerIcon = valueBtn[1].querySelector('i[data-visualcompletion="css-img"]');
   
    if (volumeSlider) {
       // info(`🔊    喇叭图标 volumeSlider.style.height:为 ========= ${volumeSlider.style.height}`);
      volumeSlider.setAttribute("aria-valuenow", video_volume);
      // 真实地设置滑块 UI 样式
          const bar = volumeSlider.querySelector('div[style*="height"]');
          if (bar && video_volume > 0 && !mute) {
            bar.style.height = (video_volume * 100).toFixed(0) + "%";
            // info("✅ 设置滑块视觉高度为 ", bar.style.height);
          }
    }

    if (speakerIcon) {
      speakerIcon.style.backgroundPosition = bg_pos; // 非静音图标
      if (!valueBtn[1].dataset.unmuted) {valueBtn[1].dataset.unmuted = "true";
      // info("valueBtn[1] valueBtn[1]绑定 click");
          valueBtn[1].addEventListener("click", () => {
              click = true;
          // console.log(`🎚 click ===============当前音量（aria-valuenow）:  ${volumeSlider?.getAttribute("aria-valuenow")}`);
          logVolumeSlider(volumeSlider);
        });
      }
    
     //} else {
      // console.warn("⚠️ 未找到音量滑块");
    }
  }
    
  const value_btn_top = document.querySelectorAll('div[role="button"].x1i10hfl.xjbqb8w.x1ejq31n.x18oe1m7.x1sy0etr.xstzfhl.x972fbf.x10w94by.x1qhh985.x14e42zd.x9f619.x1ypdohk.xt0psk2.x3ct3a4.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x16tdsg8.x1hl2dhg.xggy1nq.x1fmog5m.xu25z0z.x140muxe.xo1y3bh.x1n2onr6.x87ps6o.x1lku1pv.x1a2a7pz');
  if (value_btn_top && value_btn_top[2] && !value_btn_top[2].dataset.unmuted) {
      value_btn_top[2].dataset.unmuted = "true";
  
      const speakerIcon2 = value_btn_top[2].querySelector('i[data-visualcompletion="css-img"]');
      if(speakerIcon2?.style) speakerIcon2.style.backgroundPosition = top_bg_pos; // 非静音图标
        // info("value_btn_top[2] value_btn_top[2] 绑定 click");
            value_btn_top[2].addEventListener("click", () => {
                click = true;
              // console.log("被点击静音 -------------------------------------------------------重新静音，恢复声音");
            const currentVideo = [...document.querySelectorAll("video")].find(video => !video.paused);
      // console.log(`🎚 click ===============当前音量（aria-valuenow）: mute=${mute},currentVideo.muted=${currentVideo.muted}, currentVideo=${currentVideo.volume}`);

      logVolumeSlider(volumeSlider);
            // }
          });
  }
}

function logVolumeSlider(slider) {
  const volume = slider?.getAttribute("aria-valuenow");
  // console.log(`🎚 当前音量（aria-valuenow）: ${volume}, ${document.querySelector("video").volume}`);
  if (volume) video_volume = volume;
  
  const currentVideo = [...document.querySelectorAll("video")].find(video => !video.paused);
  mute = currentVideo.muted;

  const valueBtn = document.querySelectorAll('div[role="button"].x1i10hfl.x1ejq31n.x18oe1m7.x1sy0etr.xstzfhl.x972fbf.x10w94by.x1qhh985.x14e42zd.x9f619.x3ct3a4.x16tdsg8.x1hl2dhg.xggy1nq.x1fmog5m.xu25z0z.x140muxe.xo1y3bh.x1n2onr6.x87ps6o.x1lku1pv.xjbqb8w.x76ihet.xtmcdsl.x112ta8.x4gj9lk.x1ypdohk.x1rg5ohu.x1qx5ct2.x1k70j0n.xbelrpt.xzueoph.xdzw4kq.x1iy03kw.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x1o7uuvo.x1a2a7pz');  
  if (valueBtn && valueBtn[1]) {
    const speakerIcon = valueBtn[1].querySelector('i[data-visualcompletion="css-img"]');
    slider.dataset.unmuted = "true";
    bg_pos = speakerIcon.style.backgroundPosition;
    // console.log(`🎚 当前音量 ${speakerIcon.style.backgroundPosition}`);
  }
  const value_btn_top = document.querySelectorAll('div[role="button"].x1i10hfl.xjbqb8w.x1ejq31n.x18oe1m7.x1sy0etr.xstzfhl.x972fbf.x10w94by.x1qhh985.x14e42zd.x9f619.x1ypdohk.xt0psk2.x3ct3a4.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x16tdsg8.x1hl2dhg.xggy1nq.x1fmog5m.xu25z0z.x140muxe.xo1y3bh.x1n2onr6.x87ps6o.x1lku1pv.x1a2a7pz');
  if (value_btn_top && value_btn_top[2]) {
    const speakerIcon2 = value_btn_top[2].querySelector('i[data-visualcompletion="css-img"]');
    top_bg_pos = speakerIcon2.style.backgroundPosition; // 非静音图标
    
    // info(`🎚 click ===============当前状态（speakerIcon2.style.backgroundPosition）:  ${speakerIcon2.style.backgroundPosition}`);
  }
}

function watchSpeakerIconAndVolume() {
  // 初始查找
  const valueBtn = document.querySelectorAll('div[role="button"].x1i10hfl.x1ejq31n.x18oe1m7.x1sy0etr.xstzfhl.x972fbf.x10w94by.x1qhh985.x14e42zd.x9f619.x3ct3a4.x16tdsg8.x1hl2dhg.xggy1nq.x1fmog5m.xu25z0z.x140muxe.xo1y3bh.x1n2onr6.x87ps6o.x1lku1pv.xjbqb8w.x76ihet.xtmcdsl.x112ta8.x4gj9lk.x1ypdohk.x1rg5ohu.x1qx5ct2.x1k70j0n.xbelrpt.xzueoph.xdzw4kq.x1iy03kw.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x1o7uuvo.x1a2a7pz');
  if (!valueBtn || !valueBtn[1]) return;

  const speakerIcon = valueBtn[1].querySelector('i[data-visualcompletion="css-img"]');

  const volumeSlider = document.querySelector('div[role="slider"].x1ypdohk.xng8ra');

  // 监听喇叭图标样式变化
  if (speakerIcon) {
  } else {
    // console.log("未找到喇叭图标 <i>");
  }

  // 监听音量滑块属性变化
  if (volumeSlider) {
      // logVolumeSlider(volumeSlider); // 初始打印
    logSpeakerIcon(); // 初始打印
    // if (volumeSlider.dataset.unmuted) warn(" volumeSlider volumeSlider 无需 绑定 click")
  if (!volumeSlider.dataset.unmuted) {volumeSlider.dataset.unmuted = "true";
  // info("volumeSlider volumeSlider绑定 click");
    volumeSlider.addEventListener("click", () => {
        click = true;
      // console.log(`🎚 click 当前音量（aria-valuenow）:  ${volumeSlider?.getAttribute("aria-valuenow")}`);
      logVolumeSlider(volumeSlider);
      // }
    });
  }
  } else {
    console.log("未找到音量滑块");
  }
}

// 立即执行
// watchSpeakerIconAndVolume();

// 监听 DOM，如果按钮是后来加载的，也能监测到
const dynamicObserver = new MutationObserver(() => {
  watchSpeakerIconAndVolume(); // 再次尝试监听
});

dynamicObserver.observe(document.body, {
  childList: true,
  subtree: true
});


// 监听 DOM 动态添加 video
const fb_observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (!(node instanceof HTMLElement)) continue;

      const videos = node.querySelectorAll("video");
      videos.forEach(forceUnmute);
    }
  }
});

fb_observer.observe(document.body, { childList: true, subtree: true });


document.addEventListener("click", () => {
  mute = false;
  video_volume = 0.25;
  // info(`🎚 ========================== unmuteAndSetVolume `);
  const videos = document.querySelectorAll("video");
  videos.forEach(forceUnmute);
  logSpeakerIcon();
}, { once: true });

}

/******************** www.facebook.com reel hidden dialog ********************/
if (/^https:\/\/www\.facebook\.com\/reel\//.test(location.href)) {

  
  const observer = new MutationObserver((mutations, obs) => {
      const dialog = document.querySelector('div[role="dialog"].x1n2onr6.x1ja2u2z.x1afcbsf.x78zum5.xdt5ytf.x1a2a7pz.x6ikm8r.x10wlt62.x71s49j.x1jx94hy.xw5cjc7.x1dmpuos.x1vsv7so.xau1kf4.x104qc98.x15o3w11.xogydr4.x1vmz7ll.x1yyrj1m.x193iq5w');  
       const target = dialog?.parentElement?.parentElement?.parentElement?.parentElement?.parentElement?.parentElement;
      if (target && !dialog.querySelector('i[data-visualcompletion="css-img"]')) {
          setTimeout(() => {
        target.style.display = 'none';
        // info('✅ 延迟出现的 DIV 已隐藏', document.querySelectorAll('div.x9f619.x1n2onr6.x1ja2u2z').length);
        obs.disconnect(); // 停止观察
          }, 30);
      }
    });

    // 开始监听整个 body
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
}

/******************** www.instagram.com hidden dialog ********************/
if (/^https:\/\/www\.instagram\.com\/reels?\/[^/?#]+/.test(location.href)) {
let video_volume = 0;
// let first = click = false;
let mute = true;

// document.querySelectorAll("video").forEach((video, idx) => {
  // console.log(`\n📹 第 ${idx + 1} 个 <video> 元素属性如下：`);
  
  // // 获取属性列表
  // for (let attr of video.attributes) {
    // console.log(`🔸 ${attr.name} = ${attr.value}`);
  // }

  // // 打印常用动态属性
  // console.log("🔹 paused:", video.paused);
  // console.log("🔹 muted:", video.muted);
  // console.log("🔹 volume:", video.volume);
  // console.log("🔹 currentTime:", video.currentTime);
  // console.log("🔹 duration:", video.duration);
  // console.log("🔹 autoplay:", video.autoplay);
  // console.log("🔹 loop:", video.loop);
  // console.log("🔹 playsInline:", video.playsInline);
  // console.log("🔹 readyState:", video.readyState);
  // console.log("🔹 playbackRate:", video.playbackRate);
  // console.log("🔹 dataset:", JSON.stringify(video.dataset, null, 2));
// });


  function forceUnmute(video) {
  if (!video) return;

    // 设置音频状态
    video.muted = mute;
    video.volume = video_volume;
    
    // 防止重新静音
    // video.addEventListener("volumechange", () => {
        // // info("新视频出现 ","click=",click, "video.muted=", video.muted, video.volume, video_volume, 'mute=', mute);
      // if (video.muted && !click) {
        // // info("----被重新静音，恢复声音");
        // video.muted = mute;
        // video.volume = video_volume;

      // logSpeakerIcon(); // 初始打印
      // }
      
      // if (click) {
          // click = false;          
      // }
    // mute = video.muted;
    // });

}


document.addEventListener("click", () => {
  mute = false;
  video_volume = 0.25;
  info(`🎚 ========================== unmuteAndSetVolume `);
  const videos = document.querySelectorAll("video");
  videos.forEach(forceUnmute);
  // forceUnmute(video);
}, { once: true });
}


// info("🚀 Hedra content.js 已启动（安全模式）");
})();
