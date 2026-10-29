import React from 'react';
import {
  AbsoluteFill,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

/* ---------- 品牌 ---------- */
const INK = '#43304f';
const MINT = '#7fb268';
const LILAC = '#b48ccd';
const ROSE = '#e08aa6';
const FONT = '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif';
const GRAD = 'linear-gradient(120deg,#b48ccd,#e08aa6 52%,#7fb268)';

const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));

/** 淡入淡出 + 轻微上移的镜头容器 */
const Scene: React.FC<{
  duration: number;
  children: React.ReactNode;
  fade?: number;
  rise?: number;
}> = ({duration, children, fade = 14, rise = 18}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(
    frame,
    [0, fade, duration - fade, duration],
    [0, 1, 1, 0],
    {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
  );
  const y = interpolate(frame, [0, fade], [rise, 0], {
    extrapolateRight: 'clamp',
    easing: (t) => 1 - Math.pow(1 - t, 3),
  });
  return (
    <AbsoluteFill style={{opacity, transform: `translateY(${y}px)`}}>
      {children}
    </AbsoluteFill>
  );
};

/** 背景：品牌柔和渐变 + 缓慢漂移的光斑 */
const BrandBg: React.FC<{dim?: boolean}> = ({dim = false}) => {
  const frame = useCurrentFrame();
  const t = frame / 30;
  return (
    <AbsoluteFill
      style={{
        background: dim
          ? 'linear-gradient(150deg,#2b2433 0%,#3a2f42 48%,#2f3b2d 100%)'
          : 'linear-gradient(150deg,#e9fbe9 0%,#f6eff8 46%,#fdeff4 100%)',
      }}
    >
      <div
        style={{
          position: 'absolute',
          width: 1100,
          height: 1100,
          left: 980 + Math.sin(t * 0.25) * 90,
          top: -380 + Math.cos(t * 0.2) * 60,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${ROSE}55, transparent 62%)`,
          filter: 'blur(40px)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 1000,
          height: 1000,
          left: -260 + Math.cos(t * 0.22) * 80,
          top: 520 + Math.sin(t * 0.18) * 50,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${LILAC}55, transparent 62%)`,
          filter: 'blur(46px)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 900,
          height: 900,
          left: 1380 + Math.sin(t * 0.16) * 70,
          top: 640 + Math.cos(t * 0.24) * 60,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${MINT}44, transparent 62%)`,
          filter: 'blur(50px)',
        }}
      />
    </AbsoluteFill>
  );
};

/** 顶部小标识 */
const Watermark: React.FC<{light?: boolean}> = ({light = false}) => (
  <div
    style={{
      position: 'absolute',
      left: 96,
      top: 64,
      fontFamily: FONT,
      fontSize: 28,
      fontWeight: 700,
      letterSpacing: 0.5,
      color: light ? 'rgba(255,255,255,.72)' : 'rgba(67,48,79,.55)',
    }}
  >
    NimuQDock-dsh
  </div>
);

const Caption: React.FC<{text: string; delay?: number}> = ({text, delay = 0}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const a = spring({frame: frame - delay, fps, config: {damping: 200}});
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 92,
        display: 'flex',
        justifyContent: 'center',
        opacity: clamp(a),
        transform: `translateY(${(1 - a) * 16}px)`,
      }}
    >
      <div
        style={{
          fontFamily: FONT,
          fontSize: 46,
          fontWeight: 700,
          letterSpacing: 1,
          color: INK,
          background: 'rgba(255,255,255,.55)',
          border: '1px solid rgba(255,255,255,.85)',
          padding: '18px 40px',
          borderRadius: 999,
          boxShadow: '0 18px 40px rgba(120,90,140,.14)',
          backdropFilter: 'blur(18px)',
        }}
      >
        {text}
      </div>
    </div>
  );
};

const Title: React.FC<{text: string; size?: number; light?: boolean}> = ({
  text,
  size = 120,
  light = false,
}) => (
  <div
    style={{
      fontFamily: FONT,
      fontSize: size,
      fontWeight: 900,
      letterSpacing: -2,
      lineHeight: 1.18,
      color: light ? '#fff' : INK,
    }}
  >
    {text}
  </div>
);

/* ---------- 镜头 ---------- */
const HookScene: React.FC<{duration: number}> = ({duration}) => (
  <Scene duration={duration}>
    <BrandBg dim />
    <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center'}}>
      <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 34}}>
        <Title text="你的群里，是不是总有一个" size={76} light />
        <div
          style={{
            fontFamily: FONT,
            fontSize: 96,
            fontWeight: 900,
            background: 'linear-gradient(120deg,#f7c7d8,#d9c2f2 60%,#c8e6bd)',
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            color: 'transparent',
            letterSpacing: -1,
          }}
        >
          只会复读的机器人？
        </div>
      </div>
    </AbsoluteFill>
    <Watermark light />
  </Scene>
);

const IntroScene: React.FC<{duration: number}> = ({duration}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const rise = spring({frame, fps, config: {damping: 200}});
  return (
    <Scene duration={duration}>
      <BrandBg />
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center'}}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 28,
            transform: `translateY(${(1 - rise) * 24}px)`,
          }}
        >
          <div
            style={{
              fontFamily: FONT,
              fontSize: 150,
              fontWeight: 900,
              letterSpacing: -3,
              background: GRAD,
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              color: 'transparent',
            }}
          >
            NimuQDock-dsh
          </div>
          <div style={{fontFamily: FONT, fontSize: 52, color: 'rgba(67,48,79,.72)', letterSpacing: 2}}>
            把 DeepSeek Harness 的 AI，停靠进 QQ
          </div>
          <div
            style={{
              marginTop: 18,
              fontFamily: FONT,
              fontSize: 40,
              fontWeight: 700,
              color: '#fff',
              background: 'linear-gradient(120deg,#b48ccd,#e08aa6 55%,#7fb268)',
              padding: '14px 36px',
              borderRadius: 999,
              boxShadow: '0 16px 36px rgba(180,140,205,.32)',
            }}
          >
            不是客服，是一个有心情、有记忆的群友
          </div>
        </div>
      </AbsoluteFill>
      <Watermark />
    </Scene>
  );
};

const ShotScene: React.FC<{
  duration: number;
  image: string;
  caption: string;
  from?: 'left' | 'right' | 'bottom';
}> = ({duration, image, caption, from = 'bottom'}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const zoom = interpolate(frame, [0, duration], [1.02, 1.09], {
    extrapolateRight: 'clamp',
  });
  const p = spring({frame, fps, config: {damping: 200}});
  const dx = from === 'left' ? (1 - p) * -60 : from === 'right' ? (1 - p) * 60 : 0;
  const dy = from === 'bottom' ? (1 - p) * 60 : 0;
  return (
    <Scene duration={duration}>
      <BrandBg />
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center'}}>
        <div
          style={{
            width: 1660,
            marginTop: -40,
            borderRadius: 28,
            overflow: 'hidden',
            border: '1px solid rgba(255,255,255,.85)',
            boxShadow: '0 40px 90px rgba(120,90,140,.22)',
            transform: `translate(${dx}px, ${dy}px) scale(${zoom})`,
          }}
        >
          <Img src={staticFile(image)} style={{width: '100%', display: 'block'}} />
        </div>
      </AbsoluteFill>
      <Caption text={caption} delay={12} />
    </Scene>
  );
};

const JudgeScene: React.FC<{duration: number}> = ({duration}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const chips = [
    {text: '被 @ / 点名 → 必回', color: ROSE},
    {text: '普通闲聊 → 看心情和精力', color: LILAC},
    {text: '接不上 → 安静潜水', color: MINT},
  ];
  return (
    <Scene duration={duration}>
      <BrandBg />
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', gap: 60}}>
        <Title text="该不该接，它自己判断" size={96} />
        <div style={{display: 'flex', flexDirection: 'column', gap: 30, marginTop: 10}}>
          {chips.map((c, i) => {
            const a = spring({frame: frame - 20 - i * 12, fps, config: {damping: 200}});
            return (
              <div
                key={c.text}
                style={{
                  fontFamily: FONT,
                  fontSize: 44,
                  fontWeight: 700,
                  color: INK,
                  background: 'rgba(255,255,255,.62)',
                  border: `2px solid ${c.color}66`,
                  borderRadius: 999,
                  padding: '20px 46px',
                  boxShadow: `0 16px 36px ${c.color}33`,
                  opacity: clamp(a),
                  transform: `translateX(${(1 - a) * -30}px)`,
                }}
              >
                {c.text}
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
      <Watermark />
    </Scene>
  );
};

const SafetyScene: React.FC<{duration: number}> = ({duration}) => {
  const items = [
    {k: '白名单', v: '只回允许的群和私聊'},
    {k: '敏感拦截', v: '密钥、手机号不外发'},
    {k: '本地部署', v: '数据不出本机'},
  ];
  return (
    <Scene duration={duration}>
      <BrandBg />
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', gap: 70}}>
        <Title text="它只说该说的话" size={92} />
        <div style={{display: 'flex', gap: 36}}>
          {items.map((it) => (
            <div
              key={it.k}
              style={{
                width: 420,
                padding: '34px 32px',
                borderRadius: 26,
                background: 'rgba(255,255,255,.6)',
                border: '1px solid rgba(255,255,255,.9)',
                boxShadow: '0 20px 50px rgba(120,90,140,.14)',
              }}
            >
              <div style={{fontFamily: FONT, fontSize: 46, fontWeight: 900, color: INK}}>{it.k}</div>
              <div style={{fontFamily: FONT, fontSize: 30, color: 'rgba(67,48,79,.66)', marginTop: 14}}>
                {it.v}
              </div>
            </div>
          ))}
        </div>
      </AbsoluteFill>
      <Watermark />
    </Scene>
  );
};

const InstallScene: React.FC<{duration: number}> = ({duration}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const a = spring({frame, fps, config: {damping: 200}});
  return (
    <Scene duration={duration}>
      <BrandBg />
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center'}}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 60,
            opacity: clamp(a),
            transform: `translateY(${(1 - a) * 30}px)`,
          }}
        >
          <div
            style={{
              fontFamily: FONT,
              fontSize: 210,
              fontWeight: 900,
              background: GRAD,
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              color: 'transparent',
            }}
          >
            25MB
          </div>
          <div style={{display: 'flex', flexDirection: 'column', gap: 18}}>
            <div style={{fontFamily: FONT, fontSize: 54, fontWeight: 800, color: INK}}>原生安装向导</div>
            <div style={{fontFamily: FONT, fontSize: 36, color: 'rgba(67,48,79,.68)'}}>
              勾选组件 → 自动下载 → 几分钟跑起来
            </div>
            <div style={{fontFamily: FONT, fontSize: 30, color: 'rgba(67,48,79,.55)'}}>
              已在线的 DSH / NapCat / 模型会自动跳过
            </div>
          </div>
        </div>
      </AbsoluteFill>
      <Watermark />
    </Scene>
  );
};

const EndScene: React.FC<{duration: number}> = ({duration}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const a = spring({frame, fps, config: {damping: 200}});
  return (
    <Scene duration={duration}>
      <BrandBg dim />
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', gap: 30}}>
        <div
          style={{
            fontFamily: FONT,
            fontSize: 140,
            fontWeight: 900,
            letterSpacing: -3,
            background: 'linear-gradient(120deg,#f7c7d8,#d9c2f2 60%,#c8e6bd)',
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            color: 'transparent',
            opacity: clamp(a),
            transform: `scale(${0.96 + a * 0.04})`,
          }}
        >
          NimuQDock-dsh
        </div>
        <div style={{fontFamily: FONT, fontSize: 46, color: 'rgba(255,255,255,.82)', opacity: clamp(a)}}>
          让 AI 真正住进群里
        </div>
        <div
          style={{
            marginTop: 24,
            fontFamily: FONT,
            fontSize: 34,
            color: 'rgba(255,255,255,.6)',
            letterSpacing: 1,
            opacity: clamp(a),
          }}
        >
          github.com/NimuStudio/NimuQDock-dsh
        </div>
      </AbsoluteFill>
      <Watermark light />
    </Scene>
  );
};

/* ---------- 时间线 ---------- */
const SEGMENTS: Array<{from: number; dur: number; render: (d: number) => React.ReactNode}> = [
  {from: 0, dur: 150, render: (d) => <HookScene duration={d} />},
  {from: 150, dur: 240, render: (d) => <IntroScene duration={d} />},
  {
    from: 390,
    dur: 390,
    render: (d) => (
      <ShotScene duration={d} image="ov-top.png" caption="群友发言，它听得见；想说时，就出现在群里" />
    ),
  },
  {
    from: 780,
    dur: 360,
    render: (d) => (
      <ShotScene
        duration={d}
        image="per-top.png"
        caption="心情 · 精力 · 记忆 —— 被怼会不高兴，聊熟了会记得你"
        from="right"
      />
    ),
  },
  {from: 1140, dur: 360, render: (d) => <JudgeScene duration={d} />},
  {from: 1500, dur: 300, render: (d) => <SafetyScene duration={d} />},
  {from: 1800, dur: 240, render: (d) => <InstallScene duration={d} />},
  {from: 2040, dur: 210, render: (d) => <EndScene duration={d} />},
];

export const Promo: React.FC = () => {
  return (
    <AbsoluteFill style={{backgroundColor: '#f4f2f6', fontFamily: FONT}}>
      {SEGMENTS.map((s) => (
        <Sequence key={s.from} from={s.from} durationInFrames={s.dur}>
          {s.render(s.dur)}
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
