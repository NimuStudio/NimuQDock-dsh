// 安装资源的版本锁定与校验和。
//
// 目的：供应链安全 / 可复现安装。
//   - 版本锁定：不用 `releases/latest`、不用魔搭 `master` 分支——避免上游更新导致行为漂移，
//     也让"校验和"有意义；
//   - 校验和：下载后校验 SHA256，镜像（gh-proxy 等第三方）篡改会在这一步被发现；
//   - 升级方式：改这里的版本号 + 哈希，然后发版。
//
// 数据来源：
//   - GitHub Releases 的 asset `digest` 字段（sha256）
//   - 魔搭 ModelScope API 的 `Sha256` + `Revision`
export const NAPCAT = {
  version: 'v4.18.41',
  url: 'https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.41/NapCat.Shell.zip',
  size: 35894640,
  sha256: '6801f93e533846cea05f4f531874a0e84371ab2331c5585b57cd7e3b869cf96b',
};

export const LLAMA = {
  build: 'b11852',
  asset: 'llama-b11852-bin-win-cpu-x64.zip',
  url: 'https://github.com/ggml-org/llama.cpp/releases/download/b11852/llama-b11852-bin-win-cpu-x64.zip',
  size: 24173328,
  sha256: '89d28c3d7d810a57524f4c9b13397b2485cbe32937fb302c09c1b04d2a6b3e06',
};

/** 判断模型：revision 固定到具体提交，URL 不用 master。 */
export const JUDGE_MODELS = {
  large: {
    repo: 'unsloth/Qwen3-1.7B-GGUF',
    file: 'Qwen3-1.7B-Q4_K_M.gguf',
    revision: '1e3f49488e445e2148d2e065ea0612c320da65c3',
    size: 1107409472,
    sha256: 'b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897',
  },
  small: {
    repo: 'unsloth/Qwen3-0.6B-GGUF',
    file: 'Qwen3-0.6B-Q4_K_M.gguf',
    revision: '6091bc857fe0dffa19c581a7ccc7def1b126ff54',
    size: 396705472,
    sha256: 'ac2d97712095a558e31573f62f466a3f9d93990898b0ec79d7c974c1780d524a',
  },
};

/** 魔搭的版本固定下载地址。 */
export function modelUrl(model) {
  return `https://www.modelscope.cn/models/${model.repo}/resolve/${model.revision}/${model.file}`;
}
