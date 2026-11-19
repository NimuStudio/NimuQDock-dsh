#!/usr/bin/env node
// start.mjs 启动链路的离线测试：不联网、不启动任何服务/进程。
// 关键判定全部走注入的假实现（假探针 / 假时钟 / 假 runner），因此可以在 CI 里裸跑。
import {
  planDsh, dshLaunchVerdict, waitForPortReady, summarizeFailures,
  planSteps, runSteps, isDirectRun, startLogFileName, findLocalDsh,
} from '../start.mjs';

const BS = String.fromCharCode(92);
const norm = (p) => p.split(BS).join('/');

let failed = 0;
const check = (name, cond, extra) => {
  console.log((cond ? '✅ ' : '❌ ') + name);
  if (extra !== undefined) console.log('   实际：' + JSON.stringify(extra));
  if (!cond) failed += 1;
};
const LOCAL = { kind: 'node', bin: 'C:/npm/node_modules/@deepseek-ai/dsh/lib/bin.js', source: 'PATH dsh.cmd' };

console.log('── ① 本机有 dsh、端口没开 → 用本机 dsh 启动（不装机）');
const plan1 = planDsh({ probePort: false, usable: false, hasLocalCli: LOCAL, savedBaseUrl: 'http://127.0.0.1:3080' });
check('① action = launch-local-cli', plan1.action === 'launch-local-cli', plan1.action);
check('① needsInstall = false（绝不下载便携版）', plan1.needsInstall === false, plan1.needsInstall);
check('① 沿用 config 里的端口 3080', plan1.port === 3080, plan1.port);
check('① 带上本机 dsh 的路径给启动器', plan1.localCli && plan1.localCli.bin === LOCAL.bin, plan1.localCli);

console.log('── ② 本机没有 dsh、端口没开 → 才退回便携安装');
const plan2 = planDsh({ probePort: false, usable: false, hasLocalCli: null, savedBaseUrl: 'http://127.0.0.1:3090' });
check('② action = install-portable', plan2.action === 'install-portable', plan2.action);
check('② needsInstall = true', plan2.needsInstall === true, plan2.needsInstall);
check('② 沿用 config 里的端口 3090', plan2.port === 3090, plan2.port);

console.log('── 补充：复用 / 端口被占让位');
const plan3 = planDsh({ probePort: true, usable: true, hasLocalCli: LOCAL, savedBaseUrl: 'http://127.0.0.1:3080/' });
check('端口在跑且 API 可用 → reuse-running（什么都不启动）', plan3.action === 'reuse-running' && plan3.needsInstall === false, plan3.action);
check('baseUrl 尾部斜杠被归一化', plan3.baseUrl === 'http://127.0.0.1:3080', plan3.baseUrl);
const plan4 = planDsh({ probePort: true, usable: false, hasLocalCli: LOCAL, savedBaseUrl: 'http://127.0.0.1:3080' });
check('端口被占但不可复用 → 让到 3081，仍用本机 dsh', plan4.action === 'launch-local-cli' && plan4.port === 3081, plan4.port);

console.log('── ③ 便携启动超时 → fatal（原实现此处静默当成功）');
let clock = 0;
const neverUp = await waitForPortReady({ probe: () => false, waitSeconds: 10, intervalMs: 1000, now: () => clock, wait: async (ms) => { clock += ms; } });
check('③ 假探针永不就绪 → waitForPortReady 返回 false', neverUp === false, neverUp);
const v1 = dshLaunchVerdict({ ready: neverUp, port: 3081, mode: 'portable', waitSeconds: 300 });
check('③ 超时 → fatal = true', v1.fatal === true, v1.fatal);
check('③ 给出原因 + 手动命令', Boolean(v1.reason) && Boolean(v1.manual), { reason: v1.reason, manual: v1.manual });
const v2 = dshLaunchVerdict({ ready: true, launchError: 'spawn powershell ENOENT', port: 3081 });
check('③ spawn 报错（原实现被异步回调吞掉）→ fatal = true', v2.fatal === true, v2.reason);
const v3 = dshLaunchVerdict({ ready: true, port: 3081 });
check('③ 端口就绪 → fatal = false', v3.fatal === false, v3.fatal);
let probes = 0;
clock = 0;
const upLater = await waitForPortReady({ probe: () => (probes += 1) >= 3, waitSeconds: 10, intervalMs: 1000, now: () => clock, wait: async (ms) => { clock += ms; } });
check('③ 迟到就绪仍判成功（第 3 次探到）', upLater === true && probes === 3, { upLater, probes });

console.log('── ④ 阶段隔离：判断模型失败，NapCat / 桥接照常执行');
const ran = [];
const steps = planSteps();
check('④ 计划含 napcat 与 bridge', steps.map((s) => s.id).includes('napcat') && steps.map((s) => s.id).includes('bridge'), steps.map((s) => s.id));
const result = await runSteps({
  steps,
  log: () => {},
  run: async (step) => {
    ran.push(step.id);
    if (step.id === 'judge') throw new Error('llama-server 未安装');
    if (step.id === 'napcat') return { ok: false, detail: '未检测到 QQ' };
    return { ok: true };
  },
});
check('④ judge 抛错后 napcat / bridge 仍被执行', ran.includes('napcat') && ran.includes('bridge'), ran);
check('④ 失败被记录：judge、napcat', result.failures.map((f) => f.id).join(',') === 'judge,napcat', result.failures.map((f) => f.id));
check('④ 没有整体中止', result.aborted === null, result.aborted);
const lines = summarizeFailures(result.failures);
check('④ 汇总含手动命令（NapCat 启动脚本 / npm start）', lines.some((l) => l.indexOf('手动命令') >= 0) && lines.some((l) => l.indexOf('napcat-launch.bat') >= 0 || l.indexOf('npm start') >= 0), lines);
const term = await runSteps({ steps, log: () => {}, run: async (step) => (step.id === 'dsh' ? { ok: false, detail: 'DSH 起不来' } : { ok: true }) });
check('关键步骤 DSH 失败 → 中止，跳过后续步骤', term.aborted === 'dsh' && term.ran.indexOf('napcat') < 0, term.ran);
check('全部成功时汇总无失败项', summarizeFailures([]).join('').indexOf('未成功') < 0, summarizeFailures([]));

console.log('── 入口判断 / 日志命名 / 本机 dsh 探测');
check('被 import（路径不同）时 isDirectRun = false', isDirectRun('/tmp/other.mjs', '/tmp/start.mjs', 'linux') === false);
check('作为入口直接运行时 isDirectRun = true', isDirectRun('/a/start.mjs', '/a/start.mjs', 'linux') === true);
check('Windows 盘符大小写不敏感', isDirectRun('C:/X/start.mjs', 'c:/x/start.mjs', 'win32') === true);
const name = startLogFileName(new Date(2024, 0, 2, 3, 4, 5));
check('日志文件名 start-YYYYMMDD-HHmmss.log', /^start-\d{8}-\d{6}\.log$/.test(name) && name === 'start-20240102-030405.log', name);
const viaEnv = findLocalDsh({ env: { DSH_BIN: 'C:/x/dsh/lib/bin.js' }, platform: 'win32', exists: (p) => norm(p) === 'C:/x/dsh/lib/bin.js', spawnSyncFn: () => ({ status: 1, stdout: '' }) });
check('DSH_BIN 命中 → 认作本机 dsh', Boolean(viaEnv) && viaEnv.kind === 'node' && viaEnv.source === 'DSH_BIN', viaEnv);
const viaPath = findLocalDsh({
  env: {}, platform: 'win32', homedir: 'C:/Users/u',
  exists: (p) => ['C:/Users/u/AppData/Roaming/npm/dsh.cmd', 'C:/Users/u/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js'].indexOf(norm(p)) >= 0,
  spawnSyncFn: () => ({ status: 0, stdout: 'C:/Users/u/AppData/Roaming/npm/dsh.cmd' }),
});
check('where dsh 命中 .cmd → 解析到 node 入口 bin.js', Boolean(viaPath) && viaPath.kind === 'node' && /bin\.js$/.test(viaPath.bin), viaPath);
const none = findLocalDsh({ env: {}, platform: 'win32', homedir: 'C:/Users/u', exists: () => false, spawnSyncFn: () => ({ status: 1, stdout: '' }) });
check('全都没有 → null（只有这时才允许便携安装）', none === null, none);

console.log(failed === 0 ? '✅ start 启动链路测试全部通过' : '❌ ' + failed + ' 项失败');
process.exit(failed === 0 ? 0 : 1);
