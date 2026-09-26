// Yahoo sends people here after they sign in and approve access (step 2 of Yahoo linking).
// Deploy with --no-verify-jwt: Yahoo's redirect carries no Supabase login. The signed `state`
// says which user started the sign-in and which app address to send them back to.
import { adminClient } from "../_shared/core.ts";
import { APP_URLS, readYahooState, yahooConnect } from "../_shared/leagues.ts";

const back = (url: string, hash: string) => new Response(null, { status: 302, headers: { Location: url.split("#")[0] + "#" + hash } });

Deno.serve(async (req) => {
  const q = new URL(req.url).searchParams;
  let returnTo = APP_URLS[0];
  try {
    const state = await readYahooState(q.get("state") ?? "");
    returnTo = state.r;
    const err = q.get("error");
    if (err) throw new Error(err === "access_denied" ? "Yahoo sign-in was cancelled." : `Yahoo said: ${q.get("error_description") || err}`);
    const code = q.get("code");
    if (!code) throw new Error("Yahoo didn't send a sign-in code. Try again.");
    await yahooConnect(adminClient(), state.u, code);
    return back(returnTo, "yahoo=ok");
  } catch (e) {
    console.error(e);
    return back(returnTo, "yahoo=err:" + encodeURIComponent((e as Error).message ?? "Yahoo sign-in failed."));
  }
});
