/** @type {import('tailwindcss').Config} */
/* Design token Moca Hub - identici a quelli dell'Hub per coerenza visiva. */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        'moca-red': '#E52217',
        'moca-red-light': '#FFE7E6',
        'moca-black': '#191919',
        'moca-gray': '#8A8A8A',
        'moca-bg': '#F3F4F6',
        success: '#22c55e',
        warning: '#f59e0b',
        danger: '#ef4444',
        /* Palette grafici Moca - validata per daltonismo nell'ordine
           serie-1..serie-5 su superficie bianca. Vedi src/lib/chart-palette.ts */
        'chart-1': '#E52217',
        'chart-2': '#5781FF',
        'chart-3': '#118541',
        'chart-4': '#551FC4',
        'chart-5': '#DB5E29',
        'chart-other': '#484848',
      },
      fontFamily: {
        figtree: ['Figtree', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
