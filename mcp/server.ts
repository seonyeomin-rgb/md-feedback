import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerTools } from './tools.js'

const server = new McpServer({
  name: 'md-feedback',
  version: '0.5.1',
})

registerTools(server)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error('md-feedback MCP server error:', err)
  process.exit(1)
})
