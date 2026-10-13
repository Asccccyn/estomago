import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
export default defineConfig({plugins:[react(),tailwindcss()],publicDir:false,build:{outDir:'../dist',emptyOutDir:true,rollupOptions:{output:{entryFileNames:'chat-app.js',chunkFileNames:'chat-[name].js',assetFileNames:'chat-app.[ext]',inlineDynamicImports:true}}}})
