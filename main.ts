// -------------------------------------------------------------
// 1.- Agentic Architechture & Orchestration
// -------------------------------------------------------------
import { multiToolAgentLoop } from "./exercises/1.- Agentic Architechture & Orchestration/multi-tool-agent-loop";
import { multiAgentOrchestration } from "./exercises/1.- Agentic Architechture & Orchestration/multi-agent-orchestration";
import { workflowEnforcementAndHandoff } from "./exercises/1.- Agentic Architechture & Orchestration/workflow-enforcement-and-handoff";
import { agentSdkHooks } from "./exercises/1.- Agentic Architechture & Orchestration/agent-sdk-hooks";
import { taskDecompositionStrategies } from "./exercises/1.- Agentic Architechture & Orchestration/task-decomposition-strategies";
// -------------------------------------------------------------
// 2.- Tool Design & MCP Integration
// -------------------------------------------------------------
import { toolInterfaceDesign } from "./exercises/2.- Tool Design & MCP Integration/tool-interface-design";
import { structuredErrorResponses } from "./exercises/2.- Tool Design & MCP Integration/structured-error-responses";
import { toolDistributionAndToolChoice } from "./exercises/2.- Tool Design & MCP Integration/tool-distribution-and-tool-choice";
import { mcpServerIntegration } from "./exercises/2.- Tool Design & MCP Integration/mcp-server-integration";

/**
 * App entry — uncomment one exercise runner at a time.
 *
 * Exercises 1: Agentic Architecture & Orchestration
 * -------------------------------------------------
 * | Import | Exercise |
 * | --- | --- |
 * | {@link multiToolAgentLoop} | Iterative tool-use (`calculator` + mocked search) |
 * | {@link multiAgentOrchestration} | Hub-and-spoke research coordinator |
 * | {@link workflowEnforcementAndHandoff} | Prerequisite gates + structured handoffs |
 * | {@link agentSdkHooks} | Pre/PostToolUse hooks (normalise, refund, AML) |
 * | {@link taskDecompositionStrategies} | Single-pass vs multi-pass code review |
 * | `session-management-strategies.md` | resume / fork / fresh+summary (stale context) |
 *
 * Exercises 2: Tool Design & MCP Integration
 * ------------------------------------------
 * | Import | Exercise |
 * | --- | --- |
 * | {@link toolInterfaceDesign} | Precise MCP tool descriptions (routing boundaries) |
 * | {@link structuredErrorResponses} | MCP isError + errorCategory recovery loop |
 * | {@link toolDistributionAndToolChoice} | Role-scoped tools + forced tool_choice |
 * | {@link mcpServerIntegration} | `.mcp.json` + `~/.claude.json` + MCP resources |
 * | `build-in-tools.md` | Grep/Glob/Read/Edit — deprecate & refactor callers |
 */
async function main(): Promise<void> {
  await mcpServerIntegration();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
