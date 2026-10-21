import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
export default defineConfig({plugins:[react(),tailwindcss(),{
  name:'version-chat-assets',
  writeBundle(options){
    const dir=resolve(options.dir??'../dist')
    const html=resolve(dir,'index.html')
    let source=readFileSync(html,'utf8')
    for(const name of ['chat-app.js','chat-app.css']){
      const bytes=readFileSync(resolve(dir,name))
      const version=createHash('sha256').update(bytes).digest('hex').slice(0,12)
      source=source.replaceAll(`/${name}`,`/${name}?v=${version}`)
    }
    writeFileSync(html,source)
  },
}],publicDir:false,build:{outDir:'../dist',emptyOutDir:true,rollupOptions:{output:{entryFileNames:'chat-app.js',chunkFileNames:'chat-[name].js',assetFileNames:'chat-app.[ext]',inlineDynamicImports:true}}}})
