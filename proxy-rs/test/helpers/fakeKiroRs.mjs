#!/usr/bin/env node
// 测试用假 kiro-rs：只实现 /api/admin/store/info，参数与真实 kiro-rs 子进程模式一致
import http from 'node:http'
const args = process.argv.slice(2)
const argValues = Object.fromEntries(args.map((value, index) => [value, args[index + 1]]))
const port = Number(argValues['--port'])
const host = argValues['--host']
const server = http.createServer((req, res) => {
  if (req.headers['x-api-key'] !== process.env.FAKE_ADMIN_KEY) {
    res.writeHead(401).end('{}')
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify({
      enabled: true,
      databaseId: process.env.FAKE_DB_ID,
      path: argValues['--account-db']
    })
  )
})
server.listen(port, host)
if (args.includes('--exit-on-stdin-eof')) {
  process.stdin.on('end', () => process.exit(0))
  process.stdin.resume()
}
process.on('SIGTERM', () => process.exit(0))
