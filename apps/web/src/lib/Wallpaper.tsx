import type { CSSProperties } from 'react';

const wallStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: `
    radial-gradient(1100px 760px at 16% 4%, #b79cff, transparent 60%),
    radial-gradient(1000px 720px at 88% 96%, #7fb0ff, transparent 58%),
    radial-gradient(800px 600px at 70% 20%, #f0a6d8, transparent 55%),
    linear-gradient(150deg, #6d5bd6 0%, #5b6fd6 50%, #4f86c6 100%)
  `,
};

export const Wallpaper = () => <div style={wallStyle} />;
