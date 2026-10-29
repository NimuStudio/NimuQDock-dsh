import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
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
  const out = interpolate(frame, [duration - 12, duration], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const scale = 1.045 - inP * 0.045;
  return (
    <AbsoluteFill style={{opacity: Math.min(clamp(inP + 0.1), out), transform: `scale(${scale})`}}>
      <Backdrop tone={tone} />
      <Particles />
      <AbsoluteFill>{children}</AbsoluteFill>
    </AbsoluteFill>
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
              transform: `translateY(${(1 - p) * 26}px) rotate(${(1 - p) * (i % 2 ? 4 : -4)}deg)`,
              background: sweep,
              WebkitBackgroundClip: sweep ? 'text' : undefined,
              backgroundClip: sweep ? 'text' : undefined,
              color: sweep ? 'transparent' : light ? INK : '#241b33',
              whiteSpace: 'pre',
            }}
          >
            {c}
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

const Shot: React.FC<{image: string; duration: number; side?: 1 | -1}> = ({
  image,
  duration,
  side = 1,
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
          width: 1560,
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

/* ---------- 镜头 ---------- */
const HookScene: React.FC<{duration: number}> = ({duration}) => {
  const frame = useCurrentFrame();
  const shake = Math.sin(frame / 1.8) * (frame < 55 ? 2.5 : 1);
  return (
    <Scene duration={duration} tone="deep">
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', gap: 26}}>
        <div style={{transform: `translateX(${shake}px)`}}>
          <Words text="你的群里" size={70} delay={0} />
        </div>
        <div style={{transform: `translateX(${-shake}px)`}}>
          <Words text="是不是也有一个" size={92} delay={16} gradient />
        </div>
        <Words text="只会复读的机器人？" size={104} delay={40} gradient />
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
          <Words text="NimuQDock-dsh" size={150} gradient />
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
    <Shot image="ov-top.png" duration={duration} side={1} />
    <FloatTag text="群消息" x={8} y={20} delay={14} color={ROSE} />
    <FloatTag text="人格状态" x={80} y={26} delay={22} color={LILAC} />
    <FloatTag text="工具调用" x={12} y={68} delay={30} color={MINT} />
    <AbsoluteFill style={{alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 70}}>
      <Words text={text} size={40} />
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
        <Words text="该不该接" size={104} gradient />
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
        <Words text="它只说该说的话" size={88} gradient />
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
          <Words text="NimuQDock-dsh" size={140} gradient />
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

/* ---------- 时间线 ---------- */
const VISUALS: Array<(d: number, text: string) => React.ReactNode> = [
  (d) => <HookScene duration={d} />,
  (d) => <BrandScene duration={d} />,
  (d, t) => <ConsoleScene duration={d} text={t} />,
  (d, t) => <PersonaScene duration={d} text={t} />,
  (d, t) => <RuleScene duration={d} text={t} />,
  (d, t) => <SafeScene duration={d} text={t} />,
  (d, t) => <InstallScene duration={d} text={t} />,
  (d, t) => <EndScene duration={d} text={t} />,
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
      <Audio src={staticFile('bgm.wav')} volume={0.22} />
      {SEGMENTS.map((s) => (
        <Sequence key={s.from} from={s.from} durationInFrames={s.dur}>
          {VISUALS[s.i](s.dur, s.text)}
          <Audio src={staticFile(`vo/n-${s.i}.mp3`)} volume={1} />
        </Sequence>
      ))}
      <AbsoluteFill
        style={{
          pointerEvents: 'none',
          background: 'radial-gradient(120% 90% at 50% 45%, transparent 55%, rgba(0,0,0,.55) 100%)',
        }}
      />
    </AbsoluteFill>
  );
};
