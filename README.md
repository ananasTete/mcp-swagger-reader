Configuration for Swagger MCP Server

```json
{
  "mcpServers": {
    "swagger": {
      "command": "npx",
      "args": ["-y", "mcp-swagger-reader"]
    }
  }
}
```

---

Declare the Swagger URL in files such as AGENTS.md, CLAUDE.md, and .cursor/rules as shown below:

```markdown
swagger URL：`http://10.0.1.31:8669/v3/api-docs` for swagger mcp
```
