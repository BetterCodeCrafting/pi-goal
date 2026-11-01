const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(__filename);
const piGoal = jiti("../.pi/extensions/pi-goal/index.ts").default;

// Minimal ExtensionAPI/ExtensionContext mocks driving the real extension code.
function createHarness() {
	const handlers = {};
	const sent = [];
	const entries = [];
	const tools = {};
	const commands = {};
	const notifications = [];
	const state = { idle: true, pending: false };

	const pi = {
		on: (event, fn) => {
			handlers[event] = fn;
		},
		registerMessageRenderer: () => {},
		registerTool: (tool) => {
			tools[tool.name] = tool;
		},
		registerCommand: (name, definition) => {
			commands[name] = definition;
		},
		sendMessage: (message, options) => {
			sent.push({ kind: message.details?.kind, options, content: message.content });
		},
		appendEntry: (type, data) => {
			entries.push({ type, data });
		},
		getActiveTools: () => [],
		setActiveTools: () => {},
	};
	const ctx = {
		isIdle: () => state.idle,
		hasPendingMessages: () => state.pending,
		ui: {
			setStatus: () => {},
			notify: (message, level) => notifications.push({ message, level }),
			confirm: async () => true,
		},
		sessionManager: { getBranch: () => entries, getEntries: () => entries },
	};
	const currentGoal = () => entries.at(-1).data.goal;
	const continuations = () => sent.filter((item) => item.kind === "continuation").length;
	const flush = () => new Promise((resolve) => setImmediate(resolve));

	return { pi, ctx, handlers, sent, tools, commands, notifications, state, currentGoal, continuations, flush };
}

// One full agent loop in real runtime event order: agent_start and agent_end
// fire exactly once per loop, turn_start/turn_end once per round. pi
// re-emits turn_start for every tool-result round inside a single loop
// (agent-loop.js runLoop), so per-loop bookkeeping must not key off
// turn_start. Tests fire events exactly like the runtime does.
const runLoop = async (h) => {
	h.state.pending = false;
	await h.handlers.agent_start(undefined, h.ctx);
	await h.handlers.turn_start(undefined, h.ctx);
	await h.handlers.turn_end({ message: {} }, h.ctx);
	await h.handlers.agent_end(undefined, h.ctx);
	await h.flush();
};

test("waiting goal suppresses continuation spam and auto-resumes on the next externally triggered loop", async () => {
	const h = createHarness();
	piGoal(h.pi);
	await h.handlers.session_start({ reason: "startup" }, h.ctx);

	const created = await h.tools.create_goal.execute("1", { objective: "test objective" }, undefined, undefined, h.ctx);
	assert.equal(created.isError, undefined);
	assert.equal(h.sent.at(-1).kind, "active");

	// Baseline: an agent_end with an active goal queues exactly one continuation.
	await runLoop(h);
	assert.equal(h.continuations(), 1);

	// The agent marks the goal waiting before ending its turn (e.g. a background
	// task notification will wake the session; polling would burn API calls).
	const waited = await h.tools.update_goal.execute("2", { status: "waiting" }, undefined, undefined, h.ctx);
	assert.equal(waited.isError, undefined);
	assert.equal(h.currentGoal().status, "waiting");
	// The waiting event must never wake the agent: a steer/followUp delivery
	// would start a turn, auto-resume the goal, and re-arm the loop.
	assert.equal(h.sent.at(-1).options?.deliverAs, "nextTurn");
	assert.equal(h.sent.at(-1).options?.triggerTurn, undefined);

	// Same-loop agent_end must not queue a continuation while waiting.
	await h.handlers.agent_end(undefined, h.ctx);
	await h.flush();
	assert.equal(h.continuations(), 1);

	// An externally triggered loop (user message / event notification) auto-resumes.
	await h.handlers.agent_start(undefined, h.ctx);
	assert.equal(h.currentGoal().status, "active");

	// Normal continuation resumes after the wake.
	await h.handlers.agent_end(undefined, h.ctx);
	await h.flush();
	assert.equal(h.continuations(), 2);
});

test("a tool-result round inside the same loop does not wake a waiting goal", async () => {
	const h = createHarness();
	piGoal(h.pi);
	await h.handlers.session_start({ reason: "startup" }, h.ctx);
	await h.tools.create_goal.execute("1", { objective: "test objective" }, undefined, undefined, h.ctx);

	// Real runtime ordering: agent_start once per loop, then turn_start per round.
	await h.handlers.agent_start(undefined, h.ctx);
	await h.handlers.turn_start(undefined, h.ctx);
	// The model marks the goal waiting mid-turn (tool call round 1).
	await h.tools.update_goal.execute("2", { status: "waiting" }, undefined, undefined, h.ctx);
	// The tool result triggers another round in the SAME loop: turn_start fires
	// again before agent_end. That intra-loop turn_start must not flip the
	// waiting goal back to active, or the loop would never actually stop.
	await h.handlers.turn_start(undefined, h.ctx);
	await h.handlers.agent_end(undefined, h.ctx);
	await h.flush();
	assert.equal(h.continuations(), 0);
	assert.equal(h.currentGoal().status, "waiting");

	// An external trigger starts a new loop and wakes the goal.
	await h.handlers.agent_start(undefined, h.ctx);
	assert.equal(h.currentGoal().status, "active");
});

test("update_goal rejects unknown statuses and waiting from non-active goals", async () => {
	const h = createHarness();
	piGoal(h.pi);
	await h.handlers.session_start({ reason: "startup" }, h.ctx);

	const noGoal = await h.tools.update_goal.execute("1", { status: "waiting" }, undefined, undefined, h.ctx);
	assert.equal(noGoal.isError, true);

	await h.tools.create_goal.execute("2", { objective: "test objective" }, undefined, undefined, h.ctx);
	// Pause through the real /goal command so the non-active guard is exercised.
	await h.commands.goal.handler("pause", h.ctx);
	assert.equal(h.currentGoal().status, "paused");
	const paused = await h.tools.update_goal.execute("3", { status: "waiting" }, undefined, undefined, h.ctx);
	assert.equal(paused.isError, true);
	assert.match(paused.content[0].text, /only an active goal can be marked waiting/);

	// Waiting on an active goal works and is idempotent.
	await h.commands.goal.handler("resume", h.ctx);
	const waited = await h.tools.update_goal.execute("4", { status: "waiting" }, undefined, undefined, h.ctx);
	assert.equal(waited.isError, undefined);
	const again = await h.tools.update_goal.execute("5", { status: "waiting" }, undefined, undefined, h.ctx);
	assert.equal(again.isError, undefined);

	const invalid = await h.tools.update_goal.execute("6", { status: "paused" }, undefined, undefined, h.ctx);
	assert.equal(invalid.isError, true);
	assert.match(invalid.content[0].text, /only accepts status=complete or status=waiting/);
});

test("five consecutive automatic continuations pause the goal instead of looping forever", async () => {
	const h = createHarness();
	piGoal(h.pi);
	await h.handlers.session_start({ reason: "startup" }, h.ctx);
	await h.tools.create_goal.execute("1", { objective: "test objective" }, undefined, undefined, h.ctx);

	// Seven automatic loops in a row: the cap must stop the cycle at five
	// continuations, auto-pause the goal, and notify the human -- no 6th.
	for (let i = 0; i < 7; i++) await runLoop(h);

	assert.equal(h.continuations(), 5);
	assert.equal(h.currentGoal().status, "paused");
	assert.ok(h.notifications.some((n) => /auto-paused after 5 consecutive automatic continuations/.test(n.message)));
});

test("a user-driven loop resets the automatic-continuation streak", async () => {
	const h = createHarness();
	piGoal(h.pi);
	await h.handlers.session_start({ reason: "startup" }, h.ctx);
	await h.tools.create_goal.execute("1", { objective: "test objective" }, undefined, undefined, h.ctx);

	// Two automatic continuations build a streak.
	await runLoop(h);
	await runLoop(h);
	assert.equal(h.continuations(), 2);

	// The user submits a message during the next turn: agent_end sees pending
	// messages and queues no continuation, so the following loop is started by
	// the user message, not by our own queued continuation.
	await h.handlers.agent_start(undefined, h.ctx);
	await h.handlers.turn_start(undefined, h.ctx);
	await h.handlers.turn_end({ message: {} }, h.ctx);
	h.state.pending = true;
	await h.handlers.agent_end(undefined, h.ctx);
	await h.flush();
	assert.equal(h.continuations(), 2);

	// The user-driven loop resets the streak, then four more automatic loops
	// stay below the cap instead of pausing the goal.
	await runLoop(h);
	for (let i = 0; i < 4; i++) await runLoop(h);
	assert.equal(h.continuations(), 2 + 1 + 4);
	assert.equal(h.currentGoal().status, "active");
	assert.ok(!h.notifications.some((n) => /auto-paused/.test(n.message)));
});

test("replacing the goal mid-turn does not inherit the automatic-continuation streak", async () => {
	const h = createHarness();
	piGoal(h.pi);
	await h.handlers.session_start({ reason: "startup" }, h.ctx);
	await h.tools.create_goal.execute("1", { objective: "first objective" }, undefined, undefined, h.ctx);

	// Build a streak, then replace the goal in the middle of a loop (the
	// create_goal upsert path); the replacement must start from a clean streak.
	for (let i = 0; i < 4; i++) await runLoop(h);
	assert.equal(h.continuations(), 4);
	await h.handlers.agent_start(undefined, h.ctx);
	await h.handlers.turn_start(undefined, h.ctx);
	const replaced = await h.tools.create_goal.execute("2", { objective: "second objective" }, undefined, undefined, h.ctx);
	assert.equal(replaced.isError, undefined);
	await h.handlers.turn_end({ message: {} }, h.ctx);
	await h.handlers.agent_end(undefined, h.ctx);
	await h.flush();

	// Four more automatic loops on the replaced goal stay below the cap.
	for (let i = 0; i < 4; i++) await runLoop(h);
	assert.equal(h.continuations(), 9);
	assert.equal(h.currentGoal().status, "active");
	assert.equal(h.currentGoal().objective, "second objective");
});

test("usage is still accounted while a goal waits", async () => {
	const h = createHarness();
	piGoal(h.pi);
	await h.handlers.session_start({ reason: "startup" }, h.ctx);
	await h.tools.create_goal.execute("1", { objective: "test objective" }, undefined, undefined, h.ctx);
	// Real flow: the turn started while the goal was active, then the agent
	// marked it waiting mid-turn before ending the turn.
	await h.handlers.turn_start(undefined, h.ctx);
	await h.tools.update_goal.execute("2", { status: "waiting" }, undefined, undefined, h.ctx);
	const before = h.currentGoal().tokensUsed;
	await h.handlers.turn_end({ message: { usage: { input: 100, output: 50 } } }, h.ctx);
	assert.ok(h.currentGoal().tokensUsed >= before + 150);
	assert.equal(h.currentGoal().status, "waiting");
});
