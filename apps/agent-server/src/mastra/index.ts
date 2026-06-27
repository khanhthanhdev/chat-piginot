import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { MCPClient } from "@mastra/mcp";

const mcp = new MCPClient({
  servers: {
    pascal: {
      command: "bunx",
      args: ["pascal-mcp", "--stdio"],
      env: {
        PASCAL_DATA_DIR: process.env.PASCAL_DATA_DIR ?? `${process.env.HOME}/.pascal/data`,
      },
    },
  },
});

const piginotAgent = new Agent({
  id: "piginot-agent",
  name: "PiGINOT Agent",
  instructions: `
You help users create and edit 3D room scenes, then prepare HVAC simulation requests.
Use Pascal MCP tools for scene operations.
Do not invent CFD results. If simulation data is unavailable, say what input is missing.
`,
  model: process.env.PIGINOT_AGENT_MODEL ?? "openai/gpt-4.1-mini",
  tools: await mcp.listTools(),
});

export const mastra = new Mastra({
  agents: { piginotAgent },
  mcpServers: await mcp.toMCPServerProxies(),
});
