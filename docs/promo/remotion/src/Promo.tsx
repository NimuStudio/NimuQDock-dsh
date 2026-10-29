import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import timing from './timing.json';

/* ---------- 设计 token ---------- */
const INK = '#f6f2fa';
const MINT = '#8fe08a';
const LILAC = '#b48ccd';
const ROSE = '#f07ba6';
const FONT = '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif';
const GRAD = 'linear-gradient(110deg,#c9a7ef,#f07ba6 48%,#8fe08a)';

const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));

/* ---------- 背景 ---------- */
const Backdrop: React.FC<{tone?: 'dark' | 'deep'}> = ({tone = 'dark'}) => {
  const frame = useCurrentFrame();
  const t = frame / 30;
  return (
    <AbsoluteFill
      style={{
        background:
          tone === 'deep'
            ? 'radial-gradient(1200px 900px at 50% 30%, #241b33 0%, #0b0a10 62%, #060509 100%)'
            : 'radial-gradient(1300px 1000px at 50% 26%, #1d1730 0%, #0c0a13 62%, #060509 100%)',
      }}
    >
      <div
        style={{
          position: 'absolute',
          width: 1200,
          height: 1200,
          left: -180 + Math.sin(t * 0.35) * 120,
          top: -420 + Math.cos(t * 0.3) * 80,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${LILAC}66, transparent 60%)`,
          filter: 'blur(70px)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 1100,
          height: 1100,
          right: -260 + Math.cos(t * 0.28) * 110,
          bottom: -380 + Math.sin(t * 0.24) * 90,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${ROSE}55, transparent 60%)`,
          filter: 'blur(80px)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 900,
          height: 900,
          left: 900 + Math.sin(t * 0.2) * 80,
          bottom: -300 + Math.cos(t * 0.26) * 70,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${MINT}44, transparent 62%)`,
          filter: 'blur(90px)',
        }}
      />
      <AbsoluteFill
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,.045) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.045) 1px, transparent 1px)',
          backgroundSize: '120px 120px',
          maskImage: 'radial-gradient(circle at 50% 45%, rgba(0,0,0,.9), transparent 78%)',
          WebkitMaskImage: 'radial-gradient(circle at 50% 45%, rgba(0,0,0,.9), transparent 78%)',
        }}
      />
      <AbsoluteFill
        style={{
          opacity: 0.07,
          mixBlendMode: 'overlay',
          backgroundImage:
            "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")",
        }}
      />
    </AbsoluteFill>
  );
};

const Particles: React.FC<{count?: number}> = ({count = 26}) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill>
      {new Array(count).fill(0).map((_, i) => {
        const seed = i * 7919;
        const x = (seed % 100) / 100;
        const base = ((seed >> 3) % 100) / 100;
        const r = 1.4 + ((seed >> 5) % 24) / 10;
        const y = (base + frame * 0.0009 + i * 0.031) % 1;
        const alpha = 0.16 + 0.22 * Math.abs(Math.sin(frame / 40 + i));
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: `${x * 100}%`,
              top: `${(1 - y) * 100}%`,
              width: r * 2,
              height: r * 2,
              borderRadius: '50%',
              background: i % 3 === 0 ? ROSE : i % 3 === 1 ? LILAC : MINT,
              opacity: alpha,
              filter: 'blur(1px)',
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};

const Scene: React.FC<{duration: number; children: React.ReactNode; tone?: 'dark' | 'deep'}> = ({
  duration,
  children,
  tone = 'dark',
}) => {
  const frame = useCurrentFrame();
  const inP = spring({frame, fps: 30, config: {damping: 200}});
  // 出场：最后 7 帧快速放大+淡出，形成"冲击切"
  const out = interpolate(frame, [duration - 7, duration], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const exitZoom = interpolate(frame, [duration - 7, duration], [1, 1.07], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const scale = (1.045 - inP * 0.045) * exitZoom;
  return (
    <AbsoluteFill style={{opacity: Math.min(clamp(inP + 0.1), out), transform: `scale(${scale})`}}>
      <Backdrop tone={tone} />
      <Particles />
      <AbsoluteFill>{children}</AbsoluteFill>
      <Wipe />
    </AbsoluteFill>
  );
};


/** SVG 渐变文字：不依赖 background-clip，渲染/视频完全一致 */
const GradText: React.FC<{
  text: string;
  size?: number;
  weight?: number;
  letterSpacing?: number;
  width?: number;
}> = ({text, size = 120, weight = 900, letterSpacing = -2, width = 1800}) => {
  const id = React.useId().replace(/:/g, '');
  const height = Math.round(size * 1.5);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{display: 'block', overflow: 'visible'}}
    >
      <defs>
        <linearGradient id={`g-${id}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#c9a7ef" />
          <stop offset="48%" stopColor="#f07ba6" />
          <stop offset="100%" stopColor="#8fe08a" />
        </linearGradient>
      </defs>
      <text
        x={width / 2}
        y={size}
        textAnchor="middle"
        fontFamily={FONT}
        fontSize={size}
        fontWeight={weight}
        letterSpacing={letterSpacing}
        fill={`url(#g-${id})`}
      >
        {text}
      </text>
    </svg>
  );
};

const Words: React.FC<{
  text: string;
  size?: number;
  gradient?: boolean;
  delay?: number;
  light?: boolean;
}> = ({text, size = 110, gradient = false, delay = 0, light = true}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const chars = Array.from(text);
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        fontFamily: FONT,
        fontSize: size,
        fontWeight: 900,
        letterSpacing: -2,
        lineHeight: 1.16,
      }}
    >
      {chars.map((c, i) => {
        const p = spring({frame: frame - delay - i * 1.1, fps, config: {damping: 200}});
        const sweep =
          gradient && c !== ' '
            ? `linear-gradient(110deg,#c9a7ef 0%,#f07ba6 ${40 + ((frame * 2 + i * 14) % 60)}%,#8fe08a 100%)`
            : undefined;
        return (
          <span
            key={i}
            style={{
              opacity: clamp(p),
              transform: `translateY(${(1 - p) * 22}px)`,
              display: 'inline-block',
              whiteSpace: 'pre',
            }}
          >
            <span
              style={{
                background: sweep,
                WebkitBackgroundClip: sweep ? 'text' : undefined,
                backgroundClip: sweep ? 'text' : undefined,
                WebkitTextFillColor: sweep ? 'transparent' : undefined,
                color: sweep ? 'transparent' : light ? INK : '#241b33',
              }}
            >
              {c}
            </span>
          </span>
        );
      })}
    </div>
  );
};

const LightSweep: React.FC<{delay?: number}> = ({delay = 0}) => {
  const frame = useCurrentFrame();
  const t = (frame - delay) / 46;
  if (t < 0 || t > 1.4) return null;
  return (
    <div
      style={{
        position: 'absolute',
        top: '-20%',
        bottom: '-20%',
        width: 260,
        left: `${t * 120 - 30}%`,
        background: 'linear-gradient(90deg, transparent, rgba(255,255,255,.22), transparent)',
        transform: 'rotate(16deg)',
        filter: 'blur(6px)',
      }}
    />
  );
};

const Shot: React.FC<{image: string; duration: number; side?: 1 | -1; width?: number}> = ({
  image,
  duration,
  side = 1,
  width = 1560,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const p = spring({frame, fps, config: {damping: 200}});
  const rotateY = side * (8 - p * 8) + Math.sin(frame / 60) * 4;
  const rotateX = 6 - p * 6 + Math.cos(frame / 70) * 2;
  const scale = 0.9 + p * 0.1 + Math.min(frame, duration) * 0.00035;
  return (
    <div
      style={{
        perspective: 1600,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        height: '100%',
      }}
    >
      <div
        style={{
          width,
          transform: `rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale(${scale})`,
          borderRadius: 26,
          overflow: 'hidden',
          border: '1px solid rgba(255,255,255,.16)',
          boxShadow:
            '0 60px 120px rgba(0,0,0,.6), 0 0 80px rgba(180,140,205,.22), inset 0 1px 0 rgba(255,255,255,.2)',
        }}
      >
        <Img src={staticFile(image)} style={{width: '100%', display: 'block'}} />
      </div>
    </div>
  );
};

const FloatTag: React.FC<{text: string; x: number; y: number; delay: number; color: string}> = ({
  text,
  x,
  y,
  delay,
  color,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const p = spring({frame: frame - delay, fps, config: {damping: 200}});
  return (
    <div
      style={{
        position: 'absolute',
        left: `${x}%`,
        top: `${y}%`,
        padding: '14px 26px',
        borderRadius: 999,
        fontFamily: FONT,
        fontSize: 30,
        fontWeight: 700,
        color: '#fff',
        background: `linear-gradient(120deg,${color}44, ${color}22)`,
        border: `1px solid ${color}88`,
        boxShadow: `0 14px 30px ${color}33`,
        backdropFilter: 'blur(10px)',
        opacity: clamp(p),
        transform: `translateY(${(1 - p) * 18}px)`,
      }}
    >
      {text}
    </div>
  );
};


/** 仿 QQ 群聊窗口：用来演示"发消息 → 机器人回复" */
const ChatMock: React.FC<{delay?: number}> = ({delay = 0}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const bubble = (at: number, side: 'left' | 'right', text: string, color: string) => {
    const p = spring({frame: frame - at - delay, fps, config: {damping: 200}});
    if (p <= 0.001) return null;
    return (
      <div
        style={{
          display: 'flex',
          justifyContent: side === 'right' ? 'flex-end' : 'flex-start',
          opacity: clamp(p),
          transform: `translateY(${(1 - p) * 14}px)`,
        }}
      >
        <div
          style={{
            maxWidth: 380,
            padding: '12px 18px',
            borderRadius: 16,
            fontFamily: FONT,
            fontSize: 24,
            lineHeight: 1.5,
            color: '#2a2233',
            background: side === 'right' ? `linear-gradient(120deg,${color},#ffffff)` : '#ffffff',
            boxShadow: '0 10px 24px rgba(0,0,0,.25)',
          }}
        >
          {text}
        </div>
      </div>
    );
  };
  const typing = spring({frame: frame - 42 - delay, fps, config: {damping: 200}});
  return (
    <div
      style={{
        width: 560,
        borderRadius: 24,
        background: 'rgba(24,20,32,.72)',
        border: '1px solid rgba(255,255,255,.14)',
        boxShadow: '0 40px 90px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.12)',
        padding: 22,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      <div style={{display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 10, borderBottom: '1px solid rgba(255,255,255,.08)'}}>
        <div style={{width: 10, height: 10, borderRadius: 99, background: MINT, boxShadow: `0 0 12px ${MINT}`}} />
        <div style={{fontFamily: FONT, fontSize: 22, color: 'rgba(246,242,250,.8)'}}>QQ 群 · 测试群</div>
      </div>
      <div style={{display: 'flex', alignItems: 'center', gap: 8, color: 'rgba(246,242,250,.45)', fontFamily: FONT, fontSize: 18}}>
        <div style={{width: 26, height: 26, borderRadius: 99, background: 'linear-gradient(130deg,#f07ba6,#b48ccd)'}} />
        群友 · 小北
      </div>
      {bubble(14, 'left', 'dsh 在吗，帮我看看这个报错', ROSE)}
      {bubble(30, 'left', '顺便问下今晚谁有空', ROSE)}
      {typing > 0.2 && frame - 42 - delay < 18 ? (
        <div style={{display: 'flex', justifyContent: 'flex-end', gap: 6, opacity: clamp(typing)}}>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{
                width: 10,
                height: 10,
                borderRadius: 99,
                background: 'rgba(255,255,255,.6)',
                opacity: 0.35 + 0.55 * Math.abs(Math.sin((frame + i * 4) / 6)),
              }}
            />
          ))}
        </div>
      ) : null}
      {bubble(62, 'right', '在的，报错贴一下，我看看。', MINT)}
      {bubble(78, 'right', '今晚我潜水，你们定～', MINT)}
    </div>
  );
};

const RealChat: React.FC<{delay?: number}> = ({delay = 0}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const p = spring({frame: frame - delay, fps, config: {damping: 200}});
  return (
    <div
      style={{
        width: 560,
        borderRadius: 24,
        background: 'rgba(24,20,32,.72)',
        border: '1px solid rgba(255,255,255,.14)',
        boxShadow: '0 40px 90px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.12)',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        opacity: clamp(p),
        transform: `translateY(${(1 - p) * 20}px)`,
      }}
    >
      <div style={{display: 'flex', alignItems: 'center', gap: 10, color: 'rgba(246,242,250,.8)', fontFamily: FONT, fontSize: 22}}>
        <div style={{width: 10, height: 10, borderRadius: 99, background: MINT, boxShadow: `0 0 12px ${MINT}`}} />
        实机演示 · QQ 群
      </div>
      <div style={{width: '100%', height: 315, borderRadius: 14, overflow: 'hidden', background: '#000'}}>
        <OffthreadVideo
          src={staticFile('kaichang.mp4')}
          muted
          style={{width: '100%', height: '100%', objectFit: 'contain'}}
        />
      </div>
      <div style={{fontFamily: FONT, fontSize: 18, color: 'rgba(246,242,250,.5)'}}>群友发问 → 它接话</div>
    </div>
  );
};

/* ---------- 镜头 ---------- */
const HookScene: React.FC<{duration: number}> = ({duration}) => {
  return (
    <Scene duration={duration} tone="deep">
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', gap: 26}}>
        <Words text="你的群里" size={70} delay={0} />
        <GradText text="是不是也有一个" size={92} />
        <GradText text="只会复读的机器人？" size={104} />
      </AbsoluteFill>
      <LightSweep delay={12} />
    </Scene>
  );
};

const BrandScene: React.FC<{duration: number}> = ({duration}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const p = spring({frame, fps, config: {damping: 200}});
  return (
    <Scene duration={duration}>
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', gap: 30}}>
        <div style={{transform: `scale(${0.92 + p * 0.08})`}}>
          <GradText text="NimuQDock-dsh" size={150} />
        </div>
        <div style={{opacity: clamp(p), transform: `translateY(${(1 - p) * 20}px)`}}>
          <Words text="把 DeepSeek Harness 接进 QQ" size={52} light />
        </div>
        <div
          style={{
            marginTop: 10,
            fontFamily: FONT,
            fontSize: 30,
            color: 'rgba(246,242,250,.55)',
            letterSpacing: 6,
            opacity: clamp(p),
          }}
        >
          PERSONA · MEMORY · SAFE
        </div>
      </AbsoluteFill>
      <LightSweep delay={8} />
    </Scene>
  );
};

const ConsoleScene: React.FC<{duration: number; text: string}> = ({duration, text}) => (
  <Scene duration={duration}>
    <AbsoluteFill style={{display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 30, padding: '0 50px'}}>
      <div style={{width: 1060}}>
        <Shot image="ov-top.png" duration={duration} side={1} width={1060} />
      </div>
      <RealChat delay={10} />
    </AbsoluteFill>
    <AbsoluteFill style={{alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 40}}>
      <Words text={text} size={34} />
    </AbsoluteFill>
  </Scene>
);

const PersonaScene: React.FC<{duration: number; text: string}> = ({duration, text}) => (
  <Scene duration={duration}>
    <Shot image="per-top.png" duration={duration} side={-1} />
    <FloatTag text="被怼会不爽" x={10} y={24} delay={16} color={ROSE} />
    <FloatTag text="聊熟了会记得你" x={68} y={30} delay={24} color={MINT} />
    <FloatTag text="精力低会潜水" x={14} y={70} delay={32} color={LILAC} />
    <AbsoluteFill style={{alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 70}}>
      <Words text={text} size={40} />
    </AbsoluteFill>
  </Scene>
);

const RuleScene: React.FC<{duration: number; text: string}> = ({duration, text}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const rules = [
    {t: '被 @ / 点名', c: ROSE},
    {t: '普通闲聊 → 看心情', c: LILAC},
    {t: '接不上 → 潜水', c: MINT},
  ];
  return (
    <Scene duration={duration}>
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', gap: 54}}>
        <GradText text="该不该接" size={104} />
        <div style={{display: 'flex', gap: 34}}>
          {rules.map((r, i) => {
            const p = spring({frame: frame - 22 - i * 10, fps, config: {damping: 200}});
            return (
              <div
                key={r.t}
                style={{
                  padding: '26px 40px',
                  borderRadius: 22,
                  fontFamily: FONT,
                  fontSize: 38,
                  fontWeight: 800,
                  color: INK,
                  background: `linear-gradient(140deg, ${r.c}33, rgba(255,255,255,.04))`,
                  border: `1px solid ${r.c}77`,
                  boxShadow: `0 20px 50px ${r.c}22`,
                  opacity: clamp(p),
                  transform: `translateY(${(1 - p) * 40}px) scale(${0.94 + p * 0.06})`,
                }}
              >
                {r.t}
              </div>
            );
          })}
        </div>
        <div
          style={{
            fontFamily: FONT,
            fontSize: 42,
            fontWeight: 700,
            color: 'rgba(246,242,250,.72)',
            marginTop: 6,
          }}
        >
          {text}
        </div>
        <MiniShot image="cfg-white.png" label="白名单 · 配置" x={3} y={8} w={360} delay={26} />
      </AbsoluteFill>
    </Scene>
  );
};

const SafeScene: React.FC<{duration: number; text: string}> = ({duration, text}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const items = [
    {k: '白名单', v: '只回允许的会话', c: MINT},
    {k: '敏感拦截', v: '密钥手机号不外发', c: ROSE},
    {k: '本地部署', v: '数据不出本机', c: LILAC},
  ];
  return (
    <Scene duration={duration}>
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', gap: 50}}>
        <GradText text="它只说该说的话" size={88} />
        <div style={{display: 'flex', gap: 30}}>
          {items.map((it, i) => {
            const p = spring({frame: frame - 20 - i * 10, fps, config: {damping: 200}});
            return (
              <div
                key={it.k}
                style={{
                  width: 400,
                  padding: '34px 30px',
                  borderRadius: 24,
                  background: 'rgba(255,255,255,.04)',
                  border: `1px solid ${it.c}55`,
                  boxShadow: `0 24px 60px ${it.c}1f`,
                  opacity: clamp(p),
                  transform: `rotateY(${(1 - p) * -30}deg)`,
                }}
              >
                <div style={{fontFamily: FONT, fontSize: 44, fontWeight: 900, color: it.c}}>{it.k}</div>
                <div style={{fontFamily: FONT, fontSize: 28, color: 'rgba(246,242,250,.7)', marginTop: 12}}>
                  {it.v}
                </div>
              </div>
            );
          })}
        </div>
        <div style={{fontFamily: FONT, fontSize: 34, color: 'rgba(246,242,250,.5)'}}>{text}</div>
        <MiniShot image="cfg-top.png" label="配置 · 运行时生效" x={64} y={6} w={560} delay={26} />
      </AbsoluteFill>
    </Scene>
  );
};

const InstallScene: React.FC<{duration: number; text: string}> = ({duration, text}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const p = spring({frame, fps, config: {damping: 200}});
  const count = Math.round(interpolate(frame, [0, 40], [0, 25], {extrapolateRight: 'clamp'}));
  const bar = interpolate(frame, [10, 80], [0, 1], {extrapolateRight: 'clamp'});
  return (
    <Scene duration={duration}>
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', gap: 36}}>
        <div style={{display: 'flex', alignItems: 'baseline', gap: 18, transform: `scale(${0.92 + p * 0.08})`}}>
          <div
            style={{
              fontFamily: FONT,
              fontSize: 230,
              fontWeight: 900,
              background: GRAD,
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              color: 'transparent',
            }}
          >
            {count}
          </div>
          <div style={{fontFamily: FONT, fontSize: 90, fontWeight: 900, color: INK}}>MB</div>
        </div>
        <div
          style={{
            width: 900,
            height: 14,
            borderRadius: 999,
            background: 'rgba(255,255,255,.1)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${bar * 100}%`,
              height: '100%',
              borderRadius: 999,
              background: GRAD,
              boxShadow: '0 0 24px rgba(240,123,166,.6)',
            }}
          />
        </div>
        <div style={{fontFamily: FONT, fontSize: 40, color: 'rgba(246,242,250,.75)'}}>{text}</div>
      </AbsoluteFill>
    </Scene>
  );
};

const EndScene: React.FC<{duration: number; text: string}> = ({duration, text}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const p = spring({frame, fps, config: {damping: 200}});
  const ring = interpolate(frame, [0, 60], [0, 1], {extrapolateRight: 'clamp'});
  return (
    <Scene duration={duration} tone="deep">
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', gap: 26}}>
        <div
          style={{
            position: 'absolute',
            width: 900,
            height: 900,
            borderRadius: '50%',
            border: '1px solid rgba(180,140,205,.25)',
            transform: `scale(${0.5 + ring * 1.1})`,
            opacity: 0.6 - ring * 0.4,
          }}
        />
        <div style={{transform: `scale(${0.94 + p * 0.06})`}}>
          <GradText text="NimuQDock-dsh" size={140} />
        </div>
        <div style={{opacity: clamp(p)}}>
          <Words text={text} size={44} />
        </div>
        <div
          style={{
            marginTop: 16,
            fontFamily: FONT,
            fontSize: 30,
            color: 'rgba(246,242,250,.55)',
            letterSpacing: 2,
            opacity: clamp(p),
          }}
        >
          github.com/NimuStudio/NimuQDock-dsh
        </div>
      </AbsoluteFill>
    </Scene>
  );
};


const ArchScene: React.FC<{duration: number; text: string}> = ({duration}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const nodes = [
    {t: 'QQ 群 / 私聊', c: ROSE},
    {t: 'NapCat', c: LILAC},
    {t: '桥接', c: MINT},
    {t: 'DeepSeek Harness', c: LILAC},
  ];
  return (
    <Scene duration={duration}>
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', gap: 40}}>
        <GradText text="它是怎么跑起来的" size={84} />
        <div style={{display: 'flex', alignItems: 'center', gap: 18}}>
          {nodes.map((n, i) => {
            const p = spring({frame: frame - 16 - i * 12, fps, config: {damping: 200}});
            return (
              <React.Fragment key={n.t}>
                {i > 0 ? (
                  <div
                    style={{
                      width: 70,
                      height: 2,
                      background: `linear-gradient(90deg, transparent, ${n.c})`,
                      opacity: clamp(p),
                    }}
                  />
                ) : null}
                <div
                  style={{
                    padding: '22px 30px',
                    borderRadius: 18,
                    fontFamily: FONT,
                    fontSize: 30,
                    fontWeight: 800,
                    color: INK,
                    background: `linear-gradient(140deg,${n.c}33, rgba(255,255,255,.03))`,
                    border: `1px solid ${n.c}77`,
                    boxShadow: `0 18px 40px ${n.c}22`,
                    opacity: clamp(p),
                    transform: `translateY(${(1 - p) * 26}px)`,
                  }}
                >
                  {n.t}
                </div>
              </React.Fragment>
            );
          })}
        </div>
        <div style={{fontFamily: FONT, fontSize: 32, color: 'rgba(246,242,250,.55)'}}>
          OneBot v11 · 本地部署 · 一条消息的完整旅程
        </div>
        <MiniShot image="ov-top.png" label="运行状态 · 控制台" x={70} y={8} w={420} delay={20} />
      </AbsoluteFill>
    </Scene>
  );
};

const BehaviorScene: React.FC<{duration: number}> = ({duration}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const items = [
    {t: '被怼会不高兴', c: ROSE},
    {t: '聊熟了会记得你', c: MINT},
    {t: '没话说就潜水', c: LILAC},
  ];
  return (
    <Scene duration={duration}>
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', gap: 46}}>
        <GradText text="它不是每次都要说话" size={86} />
        <div style={{display: 'flex', gap: 30}}>
          {items.map((it, i) => {
            const p = spring({frame: frame - 18 - i * 10, fps, config: {damping: 200}});
            return (
              <div
                key={it.t}
                style={{
                  padding: '30px 40px',
                  borderRadius: 24,
                  fontFamily: FONT,
                  fontSize: 36,
                  fontWeight: 800,
                  color: INK,
                  background: `linear-gradient(140deg,${it.c}33, rgba(255,255,255,.03))`,
                  border: `1px solid ${it.c}77`,
                  boxShadow: `0 22px 50px ${it.c}22`,
                  opacity: clamp(p),
                  transform: `scale(${0.92 + p * 0.08})`,
                }}
              >
                {it.t}
              </div>
            );
          })}
        </div>
        <div style={{fontFamily: FONT, fontSize: 32, color: 'rgba(246,242,250,.55)'}}>
          人格状态会持久化，按聊天慢慢变化
        </div>
        <MiniShot image="ses-top.png" label="会话与记忆 · 控制台" x={3} y={8} w={400} delay={24} />
      </AbsoluteFill>
    </Scene>
  );
};

const CompareScene: React.FC<{duration: number; text: string}> = ({duration, text}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const rows = [
    {name: 'Qwen3-0.6B', score: '15 / 20', ratio: 0.75, c: LILAC},
    {name: 'Qwen3-1.7B', score: '20 / 20', ratio: 1.0, c: MINT},
  ];
  return (
    <Scene duration={duration}>
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', gap: 44, width: '100%'}}>
        <GradText text="小模型，也能判断对" size={84} />
        <div style={{display: 'flex', flexDirection: 'column', gap: 26, width: 1100}}>
          {rows.map((r, i) => {
            const p = spring({frame: frame - 20 - i * 14, fps, config: {damping: 200}});
            return (
              <div key={r.name} style={{opacity: clamp(p)}}>
                <div style={{display: 'flex', justifyContent: 'space-between', fontFamily: FONT, fontSize: 30, color: INK}}>
                  <span>{r.name}</span>
                  <span style={{color: r.c, fontWeight: 800}}>{r.score}</span>
                </div>
                <div style={{height: 16, borderRadius: 99, background: 'rgba(255,255,255,.08)', marginTop: 10}}>
                  <div
                    style={{
                      width: `${r.ratio * 100 * clamp(p)}%`,
                      height: '100%',
                      borderRadius: 99,
                      background: `linear-gradient(90deg,${r.c}88,${r.c})`,
                      boxShadow: `0 0 22px ${r.c}66`,
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
        <div style={{fontFamily: FONT, fontSize: 32, color: 'rgba(246,242,250,.55)'}}>{text}</div>
        <MiniShot image="cfg-model.png" label="判断模型 · 配置" x={72} y={8} w={360} delay={28} />
      </AbsoluteFill>
    </Scene>
  );
};


/** 擦除转场：每场开头一条渐变光带扫过 */
const Wipe: React.FC = () => {
  const frame = useCurrentFrame();
  const d = Math.floor(frame / 22) % 2 === 0 ? 1 : -1;
  const t = interpolate(frame, [0, 9], [0, 1], {extrapolateRight: 'clamp'});
  if (t >= 1) return null;
  return (
    <AbsoluteFill style={{pointerEvents: 'none', overflow: 'hidden'}}>
      <div
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          width: '160%',
          left: d > 0 ? `${-120 + t * 140}%` : `${-40 - t * 140}%`,
          background:
            'linear-gradient(90deg, transparent 0%, rgba(201,167,239,.22) 38%, rgba(240,123,166,.28) 55%, rgba(143,224,138,.18) 70%, transparent 100%)',
          filter: 'blur(18px)',
        }}
      />
    </AbsoluteFill>
  );
};


/** 真实安装向导录屏（逐帧图片） */
const InstallReal: React.FC<{duration: number; text: string}> = ({duration, text}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const total = 146;
  const idx = Math.min(total, Math.floor((frame / Math.max(1, duration)) * total));
  const p = spring({frame, fps, config: {damping: 200}});
  const file = `install/frame-${String(idx).padStart(4, '0')}.png`;
  return (
    <Scene duration={duration}>
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', gap: 26}}>
        <div style={{fontFamily: FONT, fontSize: 46, fontWeight: 900, color: INK, opacity: clamp(p)}}>
          下载 → 安装 → 启动
        </div>
        <div
          style={{
            width: 1180,
            borderRadius: 18,
            overflow: 'hidden',
            border: '1px solid rgba(255,255,255,.18)',
            boxShadow: '0 50px 120px rgba(0,0,0,.6), 0 0 70px rgba(180,140,205,.18)',
            background: '#0d0b12',
          }}
        >
          <Img src={staticFile(file)} style={{width: '100%', display: 'block'}} />
        </div>
        <div style={{fontFamily: FONT, fontSize: 34, color: 'rgba(246,242,250,.65)'}}>{text}</div>
      </AbsoluteFill>
    </Scene>
  );
};


/** 角落小截图：给文字镜头加"真实控制台"佐证 */
const MiniShot: React.FC<{
  image: string;
  label: string;
  x: number;
  y: number;
  w?: number;
  delay?: number;
}> = ({image, label, x, y, w = 400, delay = 0}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const p = spring({frame: frame - delay, fps, config: {damping: 200, mass: 0.7}});
  const float = Math.sin(frame / 45) * 4;
  return (
    <div
      style={{
        position: 'absolute',
        left: `${x}%`,
        top: `${y}%`,
        width: w,
        opacity: clamp(p),
        transform: `translateY(${(1 - p) * 40 + float}px) scale(${0.96 + p * 0.04})`,
      }}
    >
      {/* 光晕 */}
      <div
        style={{
          position: 'absolute',
          inset: -28,
          borderRadius: 30,
          background: 'radial-gradient(closest-side, rgba(180,140,205,.22), transparent 72%)',
          filter: 'blur(18px)',
        }}
      />
      <div
        style={{
          position: 'relative',
          borderRadius: 16,
          overflow: 'hidden',
          border: '1px solid rgba(255,255,255,.22)',
          boxShadow: '0 30px 80px rgba(0,0,0,.58), inset 0 1px 0 rgba(255,255,255,.25)',
          background: '#0e0b14',
        }}
      >
        {/* 窗口标题栏 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '9px 12px',
            background: 'linear-gradient(180deg, rgba(255,255,255,.10), rgba(255,255,255,.02))',
            borderBottom: '1px solid rgba(255,255,255,.08)',
          }}
        >
          <div style={{width: 8, height: 8, borderRadius: 99, background: '#f07ba6'}} />
          <div style={{width: 8, height: 8, borderRadius: 99, background: '#f0c97b'}} />
          <div style={{width: 8, height: 8, borderRadius: 99, background: '#8fe08a'}} />
          <div style={{marginLeft: 8, fontFamily: FONT, fontSize: 12, color: 'rgba(246,242,250,.55)'}}>
            控制台 · NimuQDock-dsh
          </div>
        </div>
        <Img src={staticFile(image)} style={{width: '100%', display: 'block'}} />
        {/* 边缘渐隐，融入背景 */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            background:
              'linear-gradient(180deg, rgba(14,11,20,.55) 0%, transparent 12%, transparent 88%, rgba(14,11,20,.55) 100%)',
          }}
        />
      </div>
      <div
        style={{
          marginTop: 10,
          display: 'inline-block',
          padding: '6px 14px',
          borderRadius: 999,
          fontFamily: FONT,
          fontSize: 18,
          fontWeight: 700,
          color: 'rgba(246,242,250,.88)',
          background: 'rgba(255,255,255,.08)',
          border: '1px solid rgba(255,255,255,.16)',
        }}
      >
        {label}
      </div>
    </div>
  );
};


const OUTRO_FRAMES = 90;

const OutroScene: React.FC<{duration: number}> = ({duration}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const inP = spring({frame, fps, config: {damping: 200}});
  const out = interpolate(frame, [duration - 26, duration], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill style={{opacity: out}}>
      <Backdrop tone="deep" />
      <Particles />
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', gap: 20}}>
        <div style={{opacity: clamp(inP), transform: `translateY(${(1 - inP) * 16}px)`}}>
          <GradText text="NimuQDock-dsh" size={132} />
        </div>
        <div style={{fontFamily: FONT, fontSize: 34, color: 'rgba(246,242,250,.62)', opacity: clamp(inP)}}>
          把 DeepSeek Harness 停靠进 QQ
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/* ---------- 时间线 ---------- */
const VISUALS: Array<(d: number, text: string) => React.ReactNode> = [
  (d) => <BrandScene duration={d} />,
  (d, t) => <ArchScene duration={d} text={t} />,
  (d, t) => <ConsoleScene duration={d} text={t} />,
  (d, t) => <PersonaScene duration={d} text={t} />,
  (d) => <BehaviorScene duration={d} />,
  (d, t) => <RuleScene duration={d} text={t} />,
  (d, t) => <CompareScene duration={d} text={t} />,
  (d, t) => <SafeScene duration={d} text={t} />,
  (d, t) => <InstallReal duration={d} text={t} />,
];

let acc = 0;
const SEGMENTS = timing.map((t) => {
  const seg = {from: acc, dur: t.dur, i: t.i, text: t.text};
  acc += t.dur;
  return seg;
});

export const Promo: React.FC = () => {
  return (
    <AbsoluteFill style={{backgroundColor: '#060509', fontFamily: FONT}}>
      <Audio
        src={staticFile('bgm.wav')}
        loop
        volume={(f) => {
          const total = timing.reduce((a, x) => a + x.dur, 0) + OUTRO_FRAMES;
          const left = total - f;
          return left < 70 ? Math.max(0, left / 70) * 0.22 : 0.22;
        }}
      />
      {SEGMENTS.map((s) => (
        <Sequence key={s.from} from={s.from} durationInFrames={s.dur}>
          {VISUALS[s.i](s.dur, s.text)}
          <Audio src={staticFile(`vo/n-${s.i}.mp3`)} volume={1} />
        </Sequence>
      ))}
      <Sequence from={timing.reduce((a, x) => a + x.dur, 0)} durationInFrames={OUTRO_FRAMES}>
        <OutroScene duration={OUTRO_FRAMES} />
      </Sequence>
      <AbsoluteFill
        style={{
          pointerEvents: 'none',
          background: 'radial-gradient(120% 90% at 50% 45%, transparent 55%, rgba(0,0,0,.55) 100%)',
        }}
      />
    </AbsoluteFill>
  );
};
