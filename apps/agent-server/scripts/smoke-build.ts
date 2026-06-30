import { rm } from 'node:fs/promises'
import path from 'node:path'

const port = 42_000 + Math.floor(Math.random() * 1000)
const dataDir = path.join('/tmp', `pascal-agent-smoke-${process.pid}`)
const server = Bun.spawn(['node', '.mastra/output/index.mjs'], {
  env: { ...process.env, PORT: String(port), PASCAL_DATA_DIR: dataDir },
  stdout: 'pipe',
  stderr: 'pipe',
})
const output = Promise.all([new Response(server.stdout).text(), new Response(server.stderr).text()])
let started = false

try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`)
      console.log('[smoke] packaged server loaded Pascal get_scene: OK')
      started = true
      break
    } catch {
      await Bun.sleep(100)
    }
  }
  if (!started) {
    server.kill()
    await server.exited
    const [stdout, stderr] = await output
    throw new Error(`Packaged server did not start\n${stdout}\n${stderr}`)
  }
} finally {
  server.kill()
  await server.exited
  await rm(dataDir, { recursive: true, force: true })
}
