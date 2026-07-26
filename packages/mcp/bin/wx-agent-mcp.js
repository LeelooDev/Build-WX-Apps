#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from '../src/server.js'

/**
 * stdio 传输：stdout 完全属于 MCP 协议，任何输出都必须走 stderr。
 */
const server = createServer()
const transport = new StdioServerTransport()

await server.connect(transport)
console.error('[wx-agent-mcp] ready')

const bye = async () => {
  try {
    await server.close()
  } finally {
    process.exit(0)
  }
}
process.on('SIGINT', bye)
process.on('SIGTERM', bye)
