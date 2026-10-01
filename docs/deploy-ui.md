# Deploying the UI

The UI is a static Cloudflare Pages site at `ui.agentprof.dev`. GitHub Actions
builds the pinned Perfetto checkout, checks the recorder and examples, runs the
browser smoke test, and uploads the tested `dist` directory. Manual runs of
`Deploy UI` can publish to preview or production. Once deployment is enabled,
pushes to `main` publish to production.

## One-time setup

1. In Cloudflare Pages, create a **Direct Upload** project named `agentprof-ui`
   with production branch `main`. The project will have an
   `agentprof-ui.pages.dev` hostname. Use Direct Upload because GitHub Actions
   already has the pinned build environment and tests.
2. Create an account API token with **Cloudflare Pages: Edit** permission.
   Add its value to GitHub Actions as `CLOUDFLARE_API_TOKEN`, and add the
   Cloudflare account ID as `CLOUDFLARE_ACCOUNT_ID`. Make both secrets
   available to the `preview` and `production` GitHub environments.
3. Merge the deployment workflow to `main`, then run it manually with target
   `preview`. Check `preview.agentprof-ui.pages.dev`, including the bundled Pi
   example and local file import. The production push trigger stays inactive
   until the repository variable in step 5 is set.
4. Run the workflow manually with target `production`. After it succeeds, add
   `ui.agentprof.dev` under the
   Pages project's **Custom domains**. Cloudflare will configure its DNS record
   for the zone. Check that HTTPS works before treating the URL as public.
5. Set the GitHub repository variable `CLOUDFLARE_DEPLOY_ENABLED` to `true` to
   deploy future passing `main` commits automatically.

The build sets `PERFETTO_VERSION_HEADER_OVERRIDE_SCM_REVISION` to the Agent
Profiler Git commit. This gives each release its own `/v.../` asset directory
even if the pinned Perfetto checkout is unchanged. Production deployments also
copy the previous version's runtime assets, verifying their manifest hashes,
so an existing tab can finish loading during a release. The root document and
service worker use revalidating cache headers; versioned assets are immutable.

To roll back, select the last good production deployment in Cloudflare Pages.
After rollback, reload the site and open a recording to verify it.
