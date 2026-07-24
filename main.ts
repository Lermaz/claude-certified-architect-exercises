import { multiToolAgentLoop } from "./exercises/multi-tool-agent-loop";
import { multiAgentOrchestration } from "./exercises/multi-agent-orchestration";
import { workflowEnforcementAndHandoff } from "./exercises/workflow-enforcement-and-handoff";
import { agentSdkHooks } from "./exercises/agent-sdk-hooks";
import { taskDecompositionStrategies } from "./exercises/task-decomposition-strategies";
import { sessionManagementStrategies } from "./exercises/session-management-strategies";

/**
 * App entry — uncomment one exercise runner at a time.
 *
 * | Import | Exercise |
 * | --- | --- |
 * | {@link multiToolAgentLoop} | Iterative tool-use (`calculator` + mocked search) |
 * | {@link multiAgentOrchestration} | Hub-and-spoke research coordinator |
 * | {@link workflowEnforcementAndHandoff} | Prerequisite gates + structured handoffs |
 * | {@link agentSdkHooks} | Pre/PostToolUse hooks (normalise, refund, AML) |
 * | {@link taskDecompositionStrategies} | Single-pass vs multi-pass code review |
 * | {@link sessionManagementStrategies} | resume / fork / fresh+summary (stale context) |
 */
async function main(): Promise<void> {
  // await multiToolAgentLoop();
  // await multiAgentOrchestration();
  // await workflowEnforcementAndHandoff();
  // await agentSdkHooks();
  // await taskDecompositionStrategies();
  await sessionManagementStrategies();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
