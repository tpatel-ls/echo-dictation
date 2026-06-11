/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/**/*.{html,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#f6f7f9',
        surface: '#ffffff',
        surface2: '#eef0f3',
        border: '#e7e9ee',
        muted: '#717784',
        text: '#1a1d24',
        accent: '#4f46e5',
        accent2: '#6366f1',
        good: '#16a34a',
        bad: '#dc2626',
        warn: '#d97706'
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Cascadia Code', 'Consolas', 'monospace']
      },
      boxShadow: {
        pill: '0 12px 34px -10px rgba(26,29,46,0.22), 0 3px 10px -3px rgba(26,29,46,0.12)',
        panel: '0 10px 40px rgba(20,22,40,0.16)',
        card: '0 1px 2px rgba(20,22,40,0.05)'
      },
      keyframes: {
        fadeup: {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' }
        }
      },
      animation: {
        fadeup: 'fadeup 160ms ease-out'
      }
    }
  },
  plugins: []
}
