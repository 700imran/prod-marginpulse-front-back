# MarginPulse Pro — Frontend

React SPA. Deploys as a static build — no server, no container, no
Dockerfile needed at all.

## Local development

```bash
npm install
cp .env.example .env.local
npm start
```

## Important: read this before you worry about `npm audit`

Running `npm audit` on this repo shows ~42 vulnerabilities, mostly
"high" severity. This is the well-known, longstanding state of
`react-scripts` (Create React App has been in reduced maintenance for
years) — every flagged package (`workbox-build`, `svgo`,
`rollup-plugin-terser`, `jsonpath`, `bfj`, etc.) is a **build-tool-only**
dependency that runs locally during `npm run build` and never ships in
the actual deployed bundle. Verified directly: none of these packages'
code appears anywhere in `build/static/js/*.js` after a real build.
This isn't unique to this app — it's the current state of the entire
CRA ecosystem. If this concerns you long-term, migrating to Vite is the
commonly recommended path off CRA, but that's a larger, separate change
outside the scope of this deployment package.

## Deploying to Cloudflare Pages (recommended — genuinely free forever)

1. Push this repo to its own GitHub repository.
2. In Cloudflare dashboard: **Workers & Pages → Create → Pages → Connect
   to Git** → select this repo.
3. Build settings:
   - Framework preset: **Create React App**
   - Build command: `npm run build`
   - Build output directory: `build`
4. Under **Settings → Environment Variables**, add:
   ```
   REACT_APP_API_URL = https://your-backend-api.onrender.com
   ```
   This MUST be set before the build runs — Create React App bakes it
   into the JS bundle at build time. Changing it later requires
   triggering a new build, not just a redeploy.
5. Deploy. You get a `*.pages.dev` URL immediately; add a custom domain
   later if you want one (also free).

## Important: update your backend's CORS settings

Once deployed, copy your `*.pages.dev` URL and set it as `ALLOWED_ORIGINS`
on the backend-api repo's environment variables, or every API call from
this frontend will be blocked by CORS.
