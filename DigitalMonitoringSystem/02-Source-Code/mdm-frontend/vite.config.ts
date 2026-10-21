import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
//
// The dashboard talks to the API on its own origin, which is exactly how the ready-to-run
// build works: one server, one port, serving both the dashboard and the API. In that setup
// the built dashboard needs no configuration at all and reaches whichever computer served
// the page.
//
// `npm run dev` is the one exception, because Vite serves on a different port than the API.
// The proxy below keeps requests same-origin in development too, so no `.env` file is
// required to get started.
const API_TARGET = process.env.VITE_DEV_API_TARGET ?? 'http://localhost:5103'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/hub': { target: API_TARGET, changeOrigin: true },
      '/health': { target: API_TARGET, changeOrigin: true },
    },
  },
})
