import {Composition} from 'remotion';
import {Promo} from './Promo';
import timing from './timing.json';

const TOTAL_FRAMES = timing.reduce((a, x) => a + x.dur, 0);

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Main"
      component={Promo}
      durationInFrames={TOTAL_FRAMES}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};
