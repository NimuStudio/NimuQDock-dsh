import {Composition} from 'remotion';
import {Promo} from './Promo';

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Main"
      component={Promo}
      durationInFrames={2250}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};
