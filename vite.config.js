import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { 
    port: 5173,
    // Allows Railway to access the dev server
    allowedHosts: ['starmart-frontend-production-cb07.up.railway.app'] 
  },
  preview: {
    port: 5173,
    // Allows Railway to access the preview server
    allowedHosts: ['starmart-frontend-production-cb07.up.railway.app']
  }
})
