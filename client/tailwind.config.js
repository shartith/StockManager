/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        profit: '#dc2626',
        loss: '#3b82f6',
      },
    },
  },
  plugins: [],
};
