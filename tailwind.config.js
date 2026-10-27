import sgdm from '@sgdm/design/tailwind-preset';

export default {
  presets: [sgdm],
  // h-screen and friends follow the real window height even with the density zoom (src/styles.css).
  theme: { extend: { height: { screen: 'var(--tela-h)' }, minHeight: { screen: 'var(--tela-h)' }, maxHeight: { screen: 'var(--tela-h)' } } },
  content: ['./index.html', './src/**/*.{js,jsx}', './node_modules/@sgdm/design/dist/**/*.{js,cjs}'],
};
