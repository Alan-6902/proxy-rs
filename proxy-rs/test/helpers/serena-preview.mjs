// Renderer-only preview. No Electron main process, account database or real Serena API.
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../..', import.meta.url))
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': join(root, 'src/renderer/src'), '@renderer': join(root, 'src/renderer/src') }
  },
  server: { host: '127.0.0.1', port: 5189, strictPort: true }
})
await server.listen()
console.log('Isolated Serena renderer: http://127.0.0.1:5189/test/fixtures/serena-preview.html')
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    await server.close()
    process.exit(0)
  })
