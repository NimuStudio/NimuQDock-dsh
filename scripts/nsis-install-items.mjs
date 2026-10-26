// NSIS 安装器的安装步骤（按参数执行，输出进度行给安装向导的详情页）。
// 用法：node nsis-install-items.mjs [--dsh] [--napcat] [--model=large|small] [--llama]
import { installDshStep, installNapCatStep, installModelStep, installLlamaStep } from '../src/installer/steps.js';

const args = new Set(process.argv.slice(2));
const modelArg = [...args].find((a) => a.startsWith('--model='));
const modelKind = modelArg ? modelArg.split('=')[1] : null;

let lastPct = -1;
const progress = (label) => (pct) => {
  if (pct - lastPct >= 5 || pct === 100) {
    lastPct = pct;
    console.log(`${label} ${pct}%`);
  }
};
const log = (msg) => console.log(String(msg));
const reset = () => { lastPct = -1; };

const main = async () => {
  try {
    if (args.has('--dsh')) {
      log('【DeepSeek Harness】');
      await installDshStep(log);
    }
    if (args.has('--napcat')) {
      log('【NapCat】');
      reset();
      await installNapCatStep(log, progress('NapCat'));
    }
    if (modelKind) {
      log('【判断模型】');
      reset();
      await installModelStep(modelKind, log, progress('模型'));
    }
    if (args.has('--llama')) {
      log('【推理引擎】');
      reset();
      await installLlamaStep(log, progress('推理引擎'));
    }
    log('组件安装完成');
    process.exit(0);
  } catch (error) {
    console.error(`安装失败：${error?.message ?? error}`);
    process.exit(1);
  }
};

main();
