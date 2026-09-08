import assert from 'node:assert/strict';

/** Bind one parent report to its task result, and share its in-flight outcome. */
export function createRoleCompletion(task, complete) {
  let pending;
  return {
    observe(messages) {
      const calls = messages.flatMap(message => message.tool_calls ?? []).filter(call => {
        if (call.function?.name !== 'task') return false;
        try {
          const args = JSON.parse(call.function.arguments);
          return args.prompt === task.prompt && args.subagent_type === task.subagent_type;
        } catch { return false; }
      });
      const completed = messages.some(message => message.role === 'tool'
        && calls.some(call => call.id === message.tool_call_id));
      if (!pending && completed) pending = Promise.resolve().then(complete);
      return pending;
    },
    result() {
      assert.ok(pending, 'The selected Goki task result must trigger its parent work report');
      return pending;
    },
  };
}
