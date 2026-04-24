(function () {
  const LOG_PREFIX = "[图片下载浮窗]";
  const BOX_ID = 'imgDownloadBox';
  let isInjecting = false;

  function log(...args) {
    const now = new Date().toLocaleTimeString();
    console.log(`[${now}] ${LOG_PREFIX}`, ...args);
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

  const sanitizeFilename = (str) => str.replace(/[\\/:*?"<>|]/g, '').trim();
  const padZero = (n, len = 2) => n.toString().padStart(len, '0');
  const formatDate = (date) => {
    const yy = date.getFullYear().toString().slice(2);
    const MM = padZero(date.getMonth() + 1);
    const dd = padZero(date.getDate());
    const hh = padZero(date.getHours());
    const mm = padZero(date.getMinutes());
    return `${yy}${MM}${dd}${hh}${mm}`;
  };

  async function getImageTimestamp(url) {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      const lastModified = res.headers.get('Last-Modified');
      if (lastModified) return new Date(lastModified);
    } catch {}
    return new Date();
  }

  const getBlobFromUrl = async (url) => {
    const res = await fetch(url);
    return await res.blob();
  };

  const getBlobFromBase64 = (src) => {
    const base64Data = src.split(',')[1];
    const mimeType = src.match(/data:(image\/\w+);base64/)[1];
    const byteCharacters = atob(base64Data);
    const byteArray = new Uint8Array(byteCharacters.length);
    for (let j = 0; j < byteCharacters.length; j++) {
      byteArray[j] = byteCharacters.charCodeAt(j);
    }
    return new Blob([byteArray], { type: mimeType });
  };

  async function autoScrollToLoadAllImages() {
    return new Promise((resolve) => {
      let previousHeight = 0;
      const interval = setInterval(() => {
        window.scrollBy(0, 1000);
        const currentHeight = document.body.scrollHeight;
        if (currentHeight !== previousHeight) {
          previousHeight = currentHeight;
        } else {
          clearInterval(interval);
          window.scrollTo(0, 0);
          setTimeout(resolve, 1000);
        }
      }, 500);
    });
  }

  async function injectImageDownloader() {
    if (document.getElementById(BOX_ID) || isInjecting) return;
    isInjecting = true;
    // log("注入图片下载浮窗...");

    if (!window.JSZip) {
      try {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
          script.onload = resolve;
          script.onerror = reject;
          document.head.appendChild(script);
        });
        log("✅ JSZip 已加载");
      } catch (e) {
        log("❌ JSZip 加载失败", e);
        isInjecting = false;
        return;
      }
    }

    const box = document.createElement('div');
    box.id = BOX_ID;
    box.style = `
      position: fixed;
      top: 65px;
      right: 20px;
      background: rgba(255, 255, 255, 0.85);
      padding: 5px 7px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      font-family: sans-serif;
      font-size: 14px;
      z-index: 99999;
      cursor: move;
      color: #333;
      // min-width: 240px;
    `;

    box.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; ">
        <label style="display:block; margin-bottom:6px; cursor: move;">下载图片数量：</label><button id="closeBox" title="关闭"
           style="background:none; border:none; font-size:18px; cursor:pointer; line-height:1; color: red">×</button>
       </div>
        <input type="number" title="下载前多少" id="imgCountInput" min="1" max="200" value="50"
          style="width: 55px; padding: 4px 5px; font-size: 14px; border: 1px solid #ccc; border-radius: 4px; opacity: 0.8; color: #52adde" />
        <button id="startDownload" title="打包下载"
          style="margin-left: 5px; padding: 4px 12px; font-size: 14px;
                 background-color: #ee412a; color: white; border: none;
                 border-radius: 4px; cursor: pointer; opacity: 0.8;">
          下载
        </button>
      </div>
    `;

    document.documentElement.appendChild(box);

    const startBtn = document.getElementById('startDownload');
    const closeBtn = document.getElementById('closeBox');

    // hover 效果
    startBtn.addEventListener("mouseenter", () => startBtn.style.backgroundColor = "#45a049");
    startBtn.addEventListener("mouseleave", () => startBtn.style.backgroundColor = "#ee412a");

    closeBtn.onclick = () => {
      box.remove();
      log("用户关闭浮窗");
    };

    startBtn.onclick = async () => {
      // const limit = Math.min(parseInt(document.getElementById('imgCountInput').value), 200);
      const limit = parseInt(document.getElementById('imgCountInput').value);

      await autoScrollToLoadAllImages();

      const items = Array.from(document.querySelectorAll('.sc-10090ea2-1.homJaG'));
      if (items.length === 0) {
        alert('⚠️ 页面中未找到任何图片，请先滑动页面加载图片后重试。');
        return;
      }
      
      const count = Math.min(limit, items.length);
      if (count === 0) {
        alert('⚠️ 没有可下载的图片。');
        return;
      }
      
      const zip = new JSZip();
      let added = 0;
      
      for (let i = 0; i < count; i++) {
        const item = items[i];
        const img = item.querySelector('img.sc-d84a1329-2.ksGeMn');
        if (!img || !img.src) continue;
      
        const h3 = item.querySelector('h3');
        const title = h3 ? sanitizeFilename(h3.textContent) : `image`;

        let blob, ext = 'jpg', timestamp;
        if (img.src.startsWith('data:image')) {
          blob = getBlobFromBase64(img.src);
          timestamp = new Date();
        } else {
          try {
            blob = await getBlobFromUrl(img.src);
            timestamp = await getImageTimestamp(img.src);
            const match = img.src.match(/\.(jpg|jpeg|png|webp|gif|bmp)/i);
            if (match) ext = match[1].toLowerCase();
          } catch (e) {
            console.warn(`跳过无法加载的图片: ${img.src}`);
            continue;
          }
        }
      
        const filename = `Whisk_${utf8Slice(title, 50)} ${i + 1} ${formatDate(timestamp).slice(2)}.${ext}`;
        zip.file(filename, blob);
        added++;

        await new Promise(r => setTimeout(r, 200));
      }

      if (added === 0) {
        alert('⚠️ 图片加载失败，未能打包任何图片。');
        return;
      }


      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const now = formatDate(new Date());
      const a = document.createElement('a');
      const url = URL.createObjectURL(zipBlob);
      a.href = url;
      a.download = `Whisk_images_${now}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      log(`✅ 共打包下载 ${added} 张图片`);
      // box.remove();
    };

    isInjecting = false;
    
        // 拖拽逻辑（排除输入框和按钮）
    let isDragging = false;
    let offsetX = 0, offsetY = 0;

    box.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "BUTTON") return;
      isDragging = true;
      offsetX = e.clientX - box.offsetLeft;
      offsetY = e.clientY - box.offsetTop;
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (isDragging) {
        box.style.left = (e.clientX - offsetX) + "px";
        box.style.top = (e.clientY - offsetY) + "px";
        box.style.right = "auto";
      }
    });

    document.addEventListener("mouseup", () => {
      isDragging = false;
    });

  }

  injectImageDownloader();

  const observer = new MutationObserver((mutationsList) => {
    for (const mutation of mutationsList) {
      for (const removedNode of mutation.removedNodes) {
        if (removedNode.id === BOX_ID) {
          // log("⚠️ 浮窗被移除，重新注入...");
          setTimeout(() => injectImageDownloader(), 300);
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: false });
})();
