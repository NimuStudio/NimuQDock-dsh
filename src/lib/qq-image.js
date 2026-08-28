// 图片字节解析（chat 直通与 agent 工具共用）：
// 从 NapCat get_image 的结果 {file, url} 解析出图片字节。
//
// NapCat 的 get_image 返回：
//   file: 本地缓存绝对路径（如 C:\Users\...\nt_data\Pic\...\xxx.jpg）——首选直接读文件
//   url:  腾讯图床公网地址（https://multimedia.nt.qq.com.cn/download?...）——白名单域名内兜底下载
// 两者都失败时再尝试 base64:// 前缀 / 纯 base64 文本。
//
// 安全边界：
// - 本地路径只接受 get_image 返回的 file（NapCat 解析结果），读后必须过图片魔数嗅探，
//   且大小受 maxBytes 限制——即使路径被操纵，非图片内容也进不了模型上下文。
// - URL 下载仅允许回环/私有地址（NapCat 本地服务）与 QQ 图片 CDN 域名，杜绝任意出站请求。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const QQ_IMG_CDN_RE = /(^|\.)(qpic\.cn|nt\.qq\.com\.cn)$/;

/** 是否放行该主机（回环/私有 + QQ 图片 CDN）。 */
function safeImageHost(host) {
  const h = String(host ?? '').toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  if (/^192\.168\./.test(h) || /^10\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return QQ_IMG_CDN_RE.test(h);
}

/**
 * 从 get_image 结果解析图片字节；失败/超限/非图片返回 null。
 * @param {object|null} res get_image 返回（{file?, url?}）
 * @param {{maxBytes?: number}} opts
 * @returns {Promise<Buffer|null>}
 */
export async function imageBufferFromGetImage(res, { maxBytes = 8 * 1024 * 1024 } = {}) {
  if (!res) return null;
  const limit = Number(maxBytes) || 8 * 1024 * 1024;

  // 1) 优先：本地缓存文件（get_image 返回 NapCat 解析后的绝对路径）
  const resFile = String(res.file ?? '');
  if (resFile) {
    let localPath = null;
    if (resFile.startsWith('file://')) {
      try { localPath = fileURLToPath(resFile); } catch {}
    } else if (/^[A-Za-z]:[\\/]/.test(resFile) || resFile.startsWith('/')) {
      localPath = resFile;
    }
    if (localPath) {
      try {
        const st = fs.statSync(localPath);
        if (st.isFile() && st.size > 0 && st.size <= limit) {
          return fs.readFileSync(localPath);
        }
      } catch {}
    }
  }

  // 2) URL 下载：仅放行本地/私有地址与 QQ 图片 CDN；重定向逐跳重新校验（防 redirect 绕过白名单）
  if (res.url && /^https?:\/\//.test(String(res.url))) {
    try {
      let current = String(res.url);
      for (let hop = 0; hop < 5; hop++) {
        const u = new URL(current);
        if (!safeImageHost(u.hostname)) break; // 当前跳目标不在白名单 → 拒绝
        const r = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
        if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
          current = new URL(r.headers.get('location'), current).href; // 下一跳重新校验
          continue;
        }
        if (r.ok) {
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length > 0 && buf.length <= limit) return buf;
        }
        break;
      }
    } catch {}
  }

  // 3) base64:// 前缀
  if (resFile.startsWith('base64://')) {
    try {
      const buf = Buffer.from(resFile.slice(9), 'base64');
      if (buf.length > 0 && buf.length <= limit) return buf;
    } catch {}
  }

  // 4) 纯 base64 文本（无路径特征：只有字母数字+/=，且足够长）
  if (resFile.length > 200 && /^[A-Za-z0-9+/]+=*$/.test(resFile) && !resFile.includes('.')) {
    try {
      const buf = Buffer.from(resFile, 'base64');
      if (buf.length > 0 && buf.length <= limit) return buf;
    } catch {}
  }
  return null;
}
