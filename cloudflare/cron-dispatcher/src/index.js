// Fires GH workflow_dispatch on schedule. Does no analysis itself - GH
// Actions' own `schedule:` cron is the documented unreliable part (drifted
// 3-4h late, skipped entirely some days on the free tier), while
// workflow_dispatch is an instant API call with no queue delay. Cloudflare
// Cron Triggers fire at the exact scheduled second, so this Worker exists
// purely to be a clock that reliably makes that API call on time.
const CRON_TO_WORKFLOW = {
  "50 2 * * 1-5": "daily_analysis.yml",
  "30 11 * * 1-5": "daily_grader.yml",
  "35 14 * * 1-5": "sensei_eod.yml",
};

async function dispatch(env, workflowFile) {
  const url = `https://api.github.com/repos/${env.GH_REPO}/actions/workflows/${workflowFile}/dispatches`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.GH_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "arcemx-cron-dispatcher",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: "master" }),
  });
  if (resp.status !== 204) {
    const text = await resp.text();
    throw new Error(`dispatch ${workflowFile} failed: HTTP ${resp.status} ${text.slice(0, 300)}`);
  }
  return `dispatched ${workflowFile}`;
}

export default {
  async scheduled(controller, env, ctx) {
    const workflowFile = CRON_TO_WORKFLOW[controller.cron];
    if (!workflowFile) {
      console.error(`unrecognized cron pattern: ${controller.cron}`);
      return;
    }
    ctx.waitUntil(
      dispatch(env, workflowFile)
        .then((msg) => console.log(msg))
        .catch((err) => console.error(err.message))
    );
  },

  // Manual test hook: GET /dispatch/<workflow-filename> to fire a specific
  // workflow on demand without waiting for the next cron tick. Same auth
  // (GH_TOKEN) protects it since it's not otherwise gated - anyone with the
  // Worker URL could otherwise burn a free-tier LLM run.
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/dispatch\/([\w.-]+\.yml)$/);
    if (!match) {
      return new Response("arcemx-cron-dispatcher: ok\n", { status: 200 });
    }
    try {
      const msg = await dispatch(env, match[1]);
      return new Response(msg + "\n", { status: 200 });
    } catch (err) {
      return new Response(err.message + "\n", { status: 500 });
    }
  },
};
